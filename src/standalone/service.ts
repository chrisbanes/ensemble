import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Store } from "../core/store.js";
import {
  DomainStore,
  type CapacityConfigureCommand,
  type CapacityLimits,
} from "../core/domain.js";
import { CodexRuntime, parseFailureEvidence, type Runtime } from "./codex.js";
import type {
  RecoveryRecord,
  RecoveryReceipt,
  TerminationVerifier,
} from "./recovery-types.js";
import {
  SchedulerStore,
  TurnScheduler,
  type TurnRequest,
} from "./scheduler.js";
import {
  ExecutionSupervisor,
  type ExecutionSupervisorOptions,
  type StopObservation,
} from "./supervisor.js";
import { MacProcessTerminationVerifier } from "./termination.js";
import {
  ExecutionState,
  type ExecutionIntent,
  type TaskExecutionBinding,
  type TaskExecutionContext,
} from "./state.js";
import {
  CaffeinateAssertion,
  ExecutionPower,
  MacPowerEventSource,
  type PowerEventSource,
} from "./power.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
} from "./workspaces.js";

const marker = "ensemble-standalone-v1\n";
const markerName = ".ensemble-standalone";
const ownerName = ".ensemble-owner.sqlite";
const immutableRevisionMismatches = new Set([
  "assignment-revision-changed",
  "assignment-instructions-changed",
  "assignment-profile-changed",
  "assignment-instructions-revision-stale",
  "assignment-profile-revision-stale",
  "task-revision-changed",
]);

export interface StandaloneServiceOptions {
  supervisor?: ExecutionSupervisorOptions;
  terminationVerifier?: TerminationVerifier;
  power?: {
    enabled?: boolean;
    eventSource?: PowerEventSource;
    assertion?: CaffeinateAssertion;
    pollIntervalMs?: number;
  };
  retry?: {
    now?: () => number;
    fallbackBackoffMs?: number;
    maxFallbackBackoffMs?: number;
  };
}

/** Only the owner's empty SQLite file can identify an interrupted first start. */
function markerReady(directory: string): boolean {
  const entries = readdirSync(directory);
  const mark = join(directory, markerName);
  const hasMarker = entries.includes(markerName);
  if (hasMarker) {
    const state = lstatSync(mark);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error("Data directory marker must be a regular file");
    const contents = readFileSync(mark, "utf8");
    if (contents === marker) return true;
    if (!marker.startsWith(contents))
      throw new Error("Data directory marker mismatch");
  }
  const expected = [
    ownerName,
    `${ownerName}-journal`,
    ...(hasMarker ? [markerName] : []),
  ];
  if (entries.length === 0) return false;
  if (
    !entries.includes(ownerName) ||
    !entries.every((entry) => expected.includes(entry))
  )
    throw new Error("Unmarked data directory must be empty");
  const owner = lstatSync(join(directory, ownerName));
  if (!owner.isFile() || owner.isSymbolicLink() || owner.size !== 0)
    throw new Error("Interrupted owner file is not a fresh installation");
  if (entries.includes(`${ownerName}-journal`)) {
    const journal = lstatSync(join(directory, `${ownerName}-journal`));
    if (!journal.isFile() || journal.isSymbolicLink())
      throw new Error("Interrupted owner journal is not a regular file");
  }
  return false;
}

/** Owns only standalone.sqlite in a marked data directory. No import or attach path exists. */
export class StandaloneService {
  private owner: DatabaseSync | undefined;
  private db: DatabaseSync | undefined;
  private state: ExecutionState | undefined;
  private domainState: DomainStore | undefined;
  private workspaces: WorkspaceManager | undefined;
  private schedulerStore: SchedulerStore | undefined;
  private scheduler: TurnScheduler | undefined;
  private supervisor: ExecutionSupervisor | undefined;
  private power: ExecutionPower | undefined;
  private powerPollTimer: NodeJS.Timeout | undefined;
  private runtime: Runtime | undefined;
  private lastCompletedWorkId: string | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();
  private readonly activeByWorkId = new Map<string, Promise<ExecutionIntent>>();
  private readonly callbacks = new Map<string, Set<Promise<unknown>>>();
  private readonly retryNow: () => number;
  private readonly fallbackBackoffMs: number;
  private readonly maxFallbackBackoffMs: number;

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: () => Runtime = () => new CodexRuntime(),
    private readonly markerWriter: (path: string, flag: "wx" | "w") => void = (
      path,
      flag,
    ) => writeFileSync(path, marker, { flag, mode: 0o600 }),
    private readonly options: StandaloneServiceOptions = {},
  ) {
    this.retryNow = options.retry?.now ?? Date.now;
    const fallback = options.retry?.fallbackBackoffMs ?? 1000;
    const maximum = options.retry?.maxFallbackBackoffMs ?? 30_000;
    if (
      !Number.isSafeInteger(fallback) ||
      fallback < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > 30_000
    )
      throw new Error(
        "Retry fallback backoff must be a bounded non-negative integer",
      );
    this.maxFallbackBackoffMs = maximum;
    this.fallbackBackoffMs = Math.min(fallback, maximum);
  }

  async start(): Promise<void> {
    if (this.db) throw new Error("Service already started");
    this.lastCompletedWorkId = undefined;
    if (!isAbsolute(this.dataDir))
      throw new Error("Data directory must be absolute");
    const directory = resolve(this.dataDir);
    if (existsSync(directory)) {
      if (
        lstatSync(directory).isSymbolicLink() ||
        !lstatSync(directory).isDirectory()
      )
        throw new Error("Data directory must be a real directory");
      markerReady(directory);
    } else mkdirSync(directory, { recursive: true, mode: 0o700 });
    // SQLite owns the OS file lock for this transaction. A process crash releases
    // it without consulting stale PID files or a clock.
    const canonical = realpathSync(directory);
    const ownerPath = join(canonical, ownerName);
    if (existsSync(ownerPath) && lstatSync(ownerPath).isSymbolicLink())
      throw new Error("Service ownership file must not be a symlink");
    const owner = new DatabaseSync(ownerPath, { timeout: 0 });
    try {
      try {
        owner.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw new Error("Data directory is already owned", { cause: error });
      }
      this.owner = owner;
      if (!markerReady(canonical)) {
        const mark = join(canonical, markerName);
        this.markerWriter(mark, existsSync(mark) ? "w" : "wx");
        if (!markerReady(canonical))
          throw new Error("Data directory marker write incomplete");
      }
      const database = join(canonical, "standalone.sqlite");
      if (existsSync(database) && lstatSync(database).isSymbolicLink())
        throw new Error("Standalone database must not be a symlink");
      const db = new DatabaseSync(database);
      this.db = db;
      db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
      const domain = new DomainStore(db, () => {
        void this.wakeScheduler().catch(() => {});
      });
      domain.migrate();
      this.domainState = domain;
      const schedulerStore = new SchedulerStore(db);
      this.schedulerStore = schedulerStore;
      const workspaces = new WorkspaceManager(
        new SqliteWorkspaceBindingStore(db),
        join(canonical, "workspaces"),
      );
      await workspaces.recover();
      this.workspaces = workspaces;
      const state = new ExecutionState(db);
      for (const item of state.list()) {
        let workspaceKey: string;
        try {
          workspaceKey = realpathSync(item.workspace);
        } catch {
          workspaceKey = resolve(item.workspace);
        }
        if (workspaceKey !== item.workspace)
          state.setWorkspaceKey(item.id, workspaceKey);
      }
      state.holdUnfinishedOnOpen();
      this.state = state;
      const runtime = this.runtimeFactory();
      this.runtime = runtime;
      this.supervisor = new ExecutionSupervisor(
        state,
        runtime,
        this.options.supervisor,
        this.options.terminationVerifier ?? new MacProcessTerminationVerifier(),
      );
      runtime.onUnexpectedRequest((request) => {
        const executions = state.list();
        const active = executions.filter(
          (item) => item.state === "submitting" || item.state === "running",
        );
        const attributable = executions.filter(
          (item) =>
            item.state === "completed" ||
            item.state === "held" ||
            item.state === "submitting" ||
            item.state === "running",
        );
        const bound =
          request.threadId && request.turnId
            ? attributable.filter(
                (item) =>
                  item.threadId === request.threadId &&
                  item.turnId === request.turnId,
              )
            : [];
        if (bound.length === 0 && request.threadId && request.turnId) {
          const awaiting = attributable.filter(
            (item) =>
              item.threadId === request.threadId && item.turnId === null,
          );
          const pending = awaiting.length === 1 ? awaiting[0] : undefined;
          if (
            pending &&
            state.holdPendingTurn(
              pending.id,
              request.threadId,
              request.turnId,
              `Unexpected App Server request denied: ${request.method}`,
            )
          ) {
            this.supervisor?.turnBound(
              pending.workId,
              request.threadId,
              request.turnId,
            );
            return;
          }
        }
        if (bound.length === 1 && bound[0]?.state === "completed") {
          this.retractWriterAndSuccessors(
            bound[0],
            `Unexpected App Server request denied: ${request.method}`,
          );
          return;
        }
        const affected = bound.length === 1 ? bound : active;
        for (const item of affected) {
          state.hold(
            item.id,
            `Unexpected App Server request denied: ${request.method}`,
          );
          this.supervisor?.noteAnomaly(item.workId);
        }
      });
      runtime.onTerminalAnomaly?.((anomaly) => {
        const items = state.list();
        const matched =
          anomaly.threadId && anomaly.turnId
            ? items.filter(
                (item) =>
                  item.threadId === anomaly.threadId &&
                  item.turnId === anomaly.turnId,
              )
            : items.filter(
                (item) =>
                  item.state === "submitting" ||
                  item.state === "running" ||
                  (item.state === "completed" &&
                    item.workId === this.lastCompletedWorkId),
              );
        for (const item of matched) {
          this.retractWriterAndSuccessors(item, anomaly.reason);
          this.supervisor?.noteAnomaly(item.workId);
        }
      });
      await runtime.start();
      await this.supervisor.reconcileOnStart();
      const powerOptions = this.options.power;
      const powerEnabled =
        powerOptions?.enabled ??
        (powerOptions?.eventSource !== undefined ||
          runtime instanceof CodexRuntime);
      if (powerEnabled) {
        const pollIntervalMs = powerOptions?.pollIntervalMs ?? 5000;
        if (
          !Number.isSafeInteger(pollIntervalMs) ||
          pollIntervalMs <= 0 ||
          pollIntervalMs > 60_000
        )
          throw new Error(
            "Power-event poll interval must be a positive integer no greater than 60000",
          );
        const power = new ExecutionPower(
          state,
          powerOptions?.eventSource ?? new MacPowerEventSource(),
          powerOptions?.assertion ?? new CaffeinateAssertion(),
          () => this.requireSupervisor().reconcileOnStart(),
          () => this.wakeScheduler(),
        );
        this.power = power;
        await power.start();
        await power.poll();
        this.powerPollTimer = setInterval(() => {
          void power.poll().catch(() => {});
        }, pollIntervalMs);
        this.powerPollTimer.unref();
      }
      const scheduler = new TurnScheduler(
        schedulerStore,
        (request) => this.attemptRequest(request),
        this.retryNow,
      );
      this.scheduler = scheduler;
      scheduler.start();
      await this.wakeScheduler();
    } catch (error) {
      try {
        if (this.state)
          for (const item of this.state.list())
            if (item.state === "ready")
              this.state.hold(
                item.id,
                "Runtime or login unavailable during startup",
              );
      } finally {
        try {
          if (this.powerPollTimer) clearInterval(this.powerPollTimer);
          this.powerPollTimer = undefined;
          await this.power?.stop().catch(() => {});
          this.power = undefined;
          this.supervisor?.cancelObservations();
          await this.runtime?.stop().catch(() => {});
          await this.supervisor?.settle();
        } finally {
          this.runtime = undefined;
          this.supervisor = undefined;
          this.domainState = undefined;
          this.schedulerStore = undefined;
          this.scheduler = undefined;
          this.workspaces = undefined;
          this.state = undefined;
          try {
            this.db?.close();
          } finally {
            this.db = undefined;
            owner.close();
            this.owner = undefined;
          }
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = undefined;
    if (this.powerPollTimer) clearInterval(this.powerPollTimer);
    this.powerPollTimer = undefined;
    const supervisor = this.supervisor;
    supervisor?.cancelObservations();
    const runtime = this.runtime;
    this.runtime = undefined;
    let failure: unknown;
    try {
      if (runtime) await runtime.stop();
    } catch (error) {
      failure = error;
    }
    await Promise.allSettled(this.active);
    const power = this.power;
    this.power = undefined;
    try {
      await power?.stop();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    await supervisor?.settle();
    this.supervisor = undefined;
    const db = this.db;
    this.db = undefined;
    this.state = undefined;
    this.domainState = undefined;
    this.schedulerStore = undefined;
    this.workspaces = undefined;
    this.activeByWorkId.clear();
    try {
      db?.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    try {
      this.owner?.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    } finally {
      this.owner = undefined;
    }
    if (failure !== undefined) throw failure;
  }

  list(): ExecutionIntent[] {
    return this.requireState().list();
  }

  recoveryView(): RecoveryRecord[] {
    return this.requireState().recoveryView();
  }

  powerStatus() {
    return this.power?.status() ?? null;
  }

  resolveHeldExecution(receipt: RecoveryReceipt) {
    return this.requireSupervisor().resolveHeldExecution(receipt);
  }

  turnRequests(): TurnRequest[] {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore.list();
  }

  domain(): DomainStore {
    if (!this.domainState) throw new Error("Service is not started");
    return this.domainState;
  }

  capacityLimits(projectIds: string[] = []): CapacityLimits {
    return this.domain().capacityLimits(projectIds);
  }

  async configureCapacity(
    command: Omit<CapacityConfigureCommand, "actor" | "type">,
  ): Promise<CapacityLimits> {
    const result = this.domain().execute({
      ...command,
      type: "capacity.configure",
      actor: "operator",
    });
    await this.wakeScheduler();
    return result as CapacityLimits;
  }

  /** The task command owns identity; provisioning never follows a conversation ID. */
  async provisionTask(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ) {
    this.domain().task(taskId);
    const binding = await this.requireWorkspaces().provision(
      taskId,
      repositories,
    );
    await this.wakeScheduler();
    return binding;
  }

  taskWorkspace(taskId: string) {
    this.domain().task(taskId);
    return this.requireWorkspaces().get(taskId);
  }

  async archiveTask(taskId: string, evidence: WorkspaceCleanupEvidence) {
    this.domain().task(taskId);
    const state = this.requireState();
    const acquired =
      evidence.writerOwnershipResolved && state.beginArchive(taskId);
    if (!acquired)
      return this.requireWorkspaces().archiveAndCleanup(taskId, {
        ...evidence,
        writerOwnershipResolved: false,
      });
    try {
      return await this.requireWorkspaces().archiveAndCleanup(
        taskId,
        evidence,
        () => state.confirmArchive(taskId),
      );
    } finally {
      state.endArchive(taskId);
      await this.wakeScheduler();
    }
  }

  /** A replacement keeps the durable assignment and its captured revisions. */
  replaceConversation(assignmentId: string): number {
    this.domain().assignment(assignmentId);
    return this.requireState().replaceConversation(assignmentId);
  }

  isCurrentResult(workId: string): boolean {
    return this.requireState().isCurrentResult(workId);
  }

  recordTaskResult(workId: string, payload: string): boolean {
    return this.requireState().recordResult(workId, payload);
  }

  stopTask(taskId: string): Promise<StopObservation> {
    this.domain().task(taskId);
    const state = this.requireState();
    const targets = state.stopTask(taskId);
    return this.requireSupervisor().observeStop(taskId, targets);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.domain().task(taskId);
    this.requireState().resumeTask(taskId);
    await this.wakeScheduler();
  }

  taskHold(taskId: string): string | undefined {
    return this.requireState().taskHold(taskId);
  }

  /** A known survivor or unfinished tool callback keeps ownership held. */
  holdKnownSurvivor(workId: string, reason: string): void {
    const state = this.requireState();
    const intent = state.byWorkId(workId);
    if (!intent || intent.state === "ready")
      throw new Error("No active execution to hold");
    const holdReason = `Known unfinished execution: ${reason}`;
    this.supervisor?.noteSurvivor(workId);
    this.retractWriterAndSuccessors(intent, holdReason);
  }

  private retractWriterAndSuccessors(
    writer: ExecutionIntent,
    reason: string,
  ): void {
    const state = this.requireState();
    for (const item of state.writerAndSuccessors(writer.workId))
      if (
        item.state === "completed" ||
        item.state === "submitting" ||
        item.state === "running"
      )
        state.holdTerminalConflict(item.id, reason);
  }

  registerExecutionCallback(workId: string, callback: Promise<unknown>): void {
    if (this.requireState().byWorkId(workId)?.state === "completed")
      this.holdKnownSurvivor(workId, "late Ensemble callback");
    const set = this.callbacks.get(workId) ?? new Set<Promise<unknown>>();
    set.add(callback);
    this.callbacks.set(workId, set);
    void callback
      .finally(() => {
        set.delete(callback);
        if (set.size === 0) this.callbacks.delete(workId);
      })
      .catch(() => {});
  }

  async submitTask(
    workId: string,
    assignmentId: string,
    prompt: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const domain = this.domain();
    const assignment = domain.assignment(assignmentId);
    const taskId = String(assignment.taskId);
    const task = domain.task(taskId);
    this.requireSchedulerStore().ensure({
      requestKey: `task:${workId}`,
      workId,
      kind: "assignment",
      taskId,
      projectId: String(assignment.projectId),
      assignmentId,
      taskVersion: Number(task.version),
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
      prompt,
      workspace: null,
      previousWorkId: previousWorkId ?? null,
    });
    return this.dispatchAndRead(workId);
  }

  /** One explicit dispatch; same work ID never submits twice, including after errors. */
  async submit(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const workspaceKey = this.validateDirectWorkspace(workspace);
    if (previousWorkId) {
      const previous = this.requireState().byWorkId(previousWorkId);
      if (
        previous?.state !== "completed" ||
        !previous.threadId ||
        previous.workspace !== workspaceKey
      )
        throw new Error(
          "Previous work is not a completed binding in this workspace",
        );
    }
    this.requireSchedulerStore().ensure({
      requestKey: `direct:${workId}`,
      workId,
      kind: "direct",
      taskId: null,
      projectId: null,
      assignmentId: null,
      taskVersion: null,
      assignmentVersion: null,
      instructionsRevision: null,
      profileRevision: null,
      prompt,
      workspace: workspaceKey,
      previousWorkId: previousWorkId ?? null,
    });
    this.requireState().create(workId, prompt, workspaceKey, previousWorkId);
    return this.dispatchAndRead(workId);
  }

  private async dispatchAndRead(workId: string): Promise<ExecutionIntent> {
    await this.wakeScheduler();
    const active = this.activeByWorkId.get(workId);
    if (active) return active;
    const intent = this.requireState().byWorkId(workId);
    if (intent) return intent;
    throw new Error("Turn request is queued until its task workspace is ready");
  }

  private async wakeScheduler(): Promise<void> {
    const scheduler = this.scheduler;
    const store = this.schedulerStore;
    const domain = this.domainState;
    if (!scheduler || !store || !domain) return;
    for (const task of domain.readyTasksWithLead()) {
      const taskId = String(task.id);
      domain.ensureLeadBinding(taskId);
      const taskAssignments = domain.assignments(taskId);
      const route = domain.routing(String(task.projectId));
      if (
        taskAssignments.length === 0 &&
        !(
          Number(route.enabled) === 1 && Number(route.credentialAvailable) === 1
        )
      )
        domain.ensureLeadAssignment(taskId);
    }
    for (const assignment of domain.pendingAssignments()) {
      const taskId = String(assignment.taskId);
      const task = domain.task(taskId);
      if (Number(task.ready) !== 1 || task.state !== "open") continue;
      if (store.list().some((item) => item.assignmentId === assignment.id))
        continue;
      try {
        store.createAssignment({
          taskId,
          projectId: String(assignment.projectId),
          assignmentId: String(assignment.id),
          taskVersion: Number(task.version),
          assignmentVersion: Number(assignment.version),
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: String(assignment.brief),
          previousWorkId: null,
        });
      } catch (error) {
        const existing = store
          .list()
          .find((item) => item.assignmentId === assignment.id);
        if (existing)
          store.hold(
            existing.workId,
            `Assignment request became obsolete: ${String(error)}`,
          );
      }
    }
    await scheduler.wake();
  }

  private async attemptRequest(request: TurnRequest): Promise<void> {
    const state = this.requireState();
    const store = this.requireSchedulerStore();
    let workspaceKey: string;
    let context: TaskExecutionContext | undefined;
    let validateAssignment: (() => string[]) | undefined;
    try {
      if (request.taskId && request.assignmentId && request.projectId) {
        const binding = await this.requireWorkspaces().forExecution(
          request.taskId,
        );
        workspaceKey = realpathSync(binding.path);
        if (
          request.taskVersion === null ||
          request.assignmentVersion === null ||
          request.instructionsRevision === null ||
          request.profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        context = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          assignmentVersion: request.assignmentVersion,
          instructionsRevision: request.instructionsRevision,
          profileRevision: request.profileRevision,
        };
        const {
          assignmentId,
          taskVersion,
          assignmentVersion,
          instructionsRevision,
          profileRevision,
        } = request;
        if (
          assignmentId === null ||
          taskVersion === null ||
          assignmentVersion === null ||
          instructionsRevision === null ||
          profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        validateAssignment = () =>
          this.domain().assignmentAdmission(assignmentId, {
            taskVersion,
            assignmentVersion,
            instructionsRevision,
            profileRevision,
          }).reasons;
      } else if (request.workspace) {
        workspaceKey = this.validateDirectWorkspace(request.workspace);
      } else throw new Error("Turn request has no workspace or task binding");
      if (!isAbsolute(workspaceKey) || !lstatSync(workspaceKey).isDirectory())
        throw new Error("Workspace must be an existing real directory");
      store.setWorkspace(request.workId, workspaceKey);
    } catch (error) {
      const reason = `Workspace admission waiting: ${String(error)}`;
      store.wait(request.workId, reason);
      const queuedIntent = state.byWorkId(request.workId);
      if (queuedIntent?.state === "ready") state.wait(queuedIntent.id, reason);
      return;
    }
    let previous: ExecutionIntent | undefined;
    let priorBinding: TaskExecutionBinding | undefined;
    let waitsForPredecessor = false;
    if (request.previousWorkId) {
      previous = state.byWorkId(request.previousWorkId);
      priorBinding = state.taskBinding(request.previousWorkId);
      waitsForPredecessor = Boolean(
        context &&
          previous &&
          previous.state !== "completed" &&
          previous.workspace === workspaceKey &&
          priorBinding?.taskId === context.taskId &&
          priorBinding.assignmentId === context.assignmentId,
      );
      if (
        !previous ||
        (!waitsForPredecessor &&
          (previous.state !== "completed" ||
            !previous.threadId ||
            previous.workspace !== workspaceKey ||
            (context &&
              (priorBinding?.taskId !== context.taskId ||
                priorBinding.assignmentId !== context.assignmentId))))
      ) {
        store.hold(
          request.workId,
          "Previous work is not a completed binding in this workspace",
        );
        const queuedIntent = state.byWorkId(request.workId);
        if (queuedIntent)
          state.hold(
            queuedIntent.id,
            "Previous work is not a completed binding in this workspace",
          );
        return;
      }
    }
    let intent: ExecutionIntent;
    let binding: TaskExecutionBinding | undefined;
    try {
      intent = state.create(
        request.workId,
        request.prompt,
        workspaceKey,
        request.previousWorkId ?? undefined,
      );
      binding = context ? state.bindTask(request.workId, context) : undefined;
    } catch (error) {
      store.hold(request.workId, `Request binding refused: ${String(error)}`);
      return;
    }
    if (intent.state !== "ready" && intent.state !== "capacity-waiting") return;
    if (waitsForPredecessor) {
      state.wait(intent.id, "Waiting for the prior turn to complete");
      return;
    }
    if (
      binding &&
      priorBinding?.conversationRevision !== binding.conversationRevision
    )
      previous = undefined;
    try {
      const runtime = this.requireRuntime();
      const processIdentity = await Promise.resolve(
        runtime.processIdentity?.() ?? null,
      ).catch(() => null);
      const admitted = state.begin(intent.id, {
        projectId: request.projectId,
        requestSequence: store.sequence(request.workId),
        processIdentity,
        ...(validateAssignment
          ? {
              validate: validateAssignment,
              refuse: (reasons) =>
                reasons.some((reason) =>
                  immutableRevisionMismatches.has(reason),
                ),
            }
          : {}),
      });
      if (!admitted) {
        const current = state.get(intent.id);
        if (current.state === "ready") {
          state.wait(intent.id, current.reason ?? "Waiting for admission");
          store.wait(request.workId, current.reason ?? "Waiting for admission");
        }
        return;
      }
    } catch (error) {
      state.hold(
        intent.id,
        `Storage failure before submission: ${String(error)}`,
      );
      return;
    }
    this.startExecution(request, intent, workspaceKey, previous);
  }

  private startExecution(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): void {
    const power = this.power;
    const action = (async () => {
      try {
        await power?.executionStarted(request.workId);
        return await this.executeAdmitted(request, intent, workspace, previous);
      } finally {
        await power?.executionEnded(request.workId).catch(() => {});
      }
    })();
    this.active.add(action);
    this.activeByWorkId.set(request.workId, action);
    void action
      .finally(() => {
        this.active.delete(action);
        this.activeByWorkId.delete(request.workId);
        void this.wakeScheduler().catch(() => {});
      })
      .catch(() => {});
  }

  private async executeAdmitted(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): Promise<ExecutionIntent> {
    const state = this.requireState();
    const runtime = this.requireRuntime();
    try {
      let threadId: string;
      if (previous?.threadId) {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        await runtime.resumeThread(previous.threadId);
        threadId = previous.threadId;
      } else {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        threadId = await runtime.startThread(workspace);
      }
      const threadBound = state.bindThread(intent.id, threadId);
      this.requireSupervisor().threadBound(request.workId, threadId);
      if (!threadBound) throw new Error("Thread binding was held or changed");
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      const turnId = await runtime.startTurn(
        threadId,
        workspace,
        request.prompt,
      );
      const turnBound = state.bindTurn(intent.id, turnId);
      this.requireSupervisor().turnBound(request.workId, threadId, turnId);
      if (!turnBound) throw new Error("Turn binding was held or changed");
      const outcome = await runtime.waitForTurn(threadId, turnId);
      this.requireSupervisor().terminalObserved(
        request.workId,
        threadId,
        turnId,
        outcome,
      );
      if (
        outcome === "completed" &&
        (this.callbacks.get(request.workId)?.size ?? 0) > 0
      )
        state.hold(
          intent.id,
          "Ensemble callback is unfinished at terminal status",
        );
      else if (outcome === "completed") {
        state.complete(intent.id, threadId, turnId);
        this.lastCompletedWorkId = request.workId;
      } else {
        state.hold(intent.id, "Bound turn failed or was interrupted");
        const evidence = parseFailureEvidence(
          runtime.failureEvidence?.(threadId, turnId),
        );
        const identity = state.recoveryIdentity(request.workId);
        const callbacksEnded =
          (this.callbacks.get(request.workId)?.size ?? 0) === 0;
        const backoffMs = evidence?.retryAfterMs ?? this.fallbackBackoffMs;
        const now = this.retryNow();
        const nextEligibleAt = now + backoffMs;
        if (
          evidence?.status === "failed" &&
          evidence.threadId === threadId &&
          evidence.turnId === turnId &&
          evidence.classification === "transient" &&
          (evidence.reasonCode === "serverOverloaded" ||
            evidence.reasonCode === "rateLimitExceeded") &&
          evidence.source === "codexErrorInfo" &&
          evidence.codexRetries !== null &&
          callbacksEnded &&
          !this.requireSupervisor().hasKnownRisk(request.workId) &&
          !state.stopTarget(request.workId) &&
          identity?.threadId === threadId &&
          identity.turnId === turnId &&
          Number.isSafeInteger(now) &&
          now >= 0 &&
          Number.isSafeInteger(nextEligibleAt) &&
          nextEligibleAt >= now
        ) {
          state.resolveFailedGeneration({
            workId: request.workId,
            workRevision: identity.workRevision,
            requestSequence: identity.requestSequence,
            threadId,
            turnId,
            terminalStatus: "failed",
            classification: "transient",
            reasonCode: evidence.reasonCode,
            source: "codexErrorInfo",
            codexRetries: evidence.codexRetries,
            callbacksEnded: true,
            noSurvivor: true,
            effects: "settled",
            nextEligibleAt,
          });
        }
      }
    } catch (error) {
      if (state.get(intent.id).state !== "held")
        state.hold(
          intent.id,
          `Runtime submission or observation uncertain: ${String(error)}`,
        );
    }
    return state.get(intent.id);
  }

  private validateDirectWorkspace(workspace: string): string {
    if (
      !isAbsolute(workspace) ||
      !existsSync(workspace) ||
      !lstatSync(workspace).isDirectory()
    )
      throw new Error("Workspace must be an existing real directory");
    const workspaceKey = realpathSync(workspace);
    const managedRoot = join(realpathSync(this.dataDir), "workspaces");
    if (
      workspaceKey === managedRoot ||
      workspaceKey.startsWith(`${managedRoot}${sep}`)
    )
      throw new Error("Task workspaces require a durable assignment binding");
    return workspaceKey;
  }

  private requireSchedulerStore(): SchedulerStore {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore;
  }

  private requireSupervisor(): ExecutionSupervisor {
    if (!this.supervisor) throw new Error("Service is not started");
    return this.supervisor;
  }

  private requireState(): ExecutionState {
    if (!this.state) throw new Error("Service is not started");
    return this.state;
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new Error("Runtime unavailable");
    return this.runtime;
  }

  private requireWorkspaces(): WorkspaceManager {
    if (!this.workspaces) throw new Error("Service is not started");
    return this.workspaces;
  }
}
