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
  CoordinationStore,
  type CoordinationCall,
  type CoordinationReceipt,
  type InboxDelivery,
} from "../core/coordination.js";
import {
  dispatchCoordinationTool,
  isCoordinationTool,
  coordinationTools,
} from "./coordination-tools.js";
import { CoordinationView } from "./coordination-view.js";
import {
  DomainStore,
  type CapacityConfigureCommand,
  type CapacityLimits,
} from "../core/domain.js";
import {
  CodexRuntime,
  parseFailureEvidence,
  type Runtime,
  type RuntimeToolCall,
  type RuntimeToolResult,
} from "./codex.js";
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
  RoutingAttemptStore,
  RoutingCoordinator,
  RoutingOperationStaleError,
  routingClientFromEnvironment,
  routingModel,
  type RoutingChoiceClient,
  type RoutingOutcome,
  type RoutingSnapshot,
  type RoutingStaleReason,
} from "./routing.js";
import {
  ExecutionSupervisor,
  type ExecutionSupervisorOptions,
  type StopObservation,
} from "./supervisor.js";
import { MacProcessTerminationVerifier } from "./termination.js";
import {
  ExecutionState,
  type CoordinationExecutionBinding,
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
  routingClient?: RoutingChoiceClient | null;
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
  private coordination: CoordinationStore | undefined;
  private routingAttempts: RoutingAttemptStore | undefined;
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
  private readonly routingCoordinators = new Map<string, RoutingCoordinator>();
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
      const routingAttempts = new RoutingAttemptStore(db);
      routingAttempts.migrate();
      this.routingAttempts = routingAttempts;
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
      const coordination = new CoordinationStore(db, domain);
      coordination.migrate();
      this.coordination = coordination;
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
      runtime.onToolCall?.((call) => this.handleToolCall(call));
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
          this.coordination = undefined;
          this.routingAttempts = undefined;
          this.routingCoordinators.clear();
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
    this.coordination = undefined;
    this.routingAttempts = undefined;
    this.routingCoordinators.clear();
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

  coordinationView(): CoordinationView {
    if (
      !this.coordination ||
      !this.routingAttempts ||
      !this.state ||
      !this.domainState
    )
      throw new Error("Service is not started");
    return new CoordinationView(
      this.domainState,
      this.coordination,
      this.state,
      this.routingAttempts,
      () => this.wakeScheduler(),
    );
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

  private handleToolCall(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    const coordination = this.coordination;
    const state = this.state;
    if (!coordination || !state || !isCoordinationTool(call.tool))
      return Promise.resolve({
        text: "Coordination tool is unavailable for this execution",
        success: false,
      });
    let receipt: CoordinationReceipt | undefined;
    try {
      receipt = coordination.receipt(call as CoordinationCall);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (receipt) return Promise.resolve(receipt.response);

    let binding: CoordinationExecutionBinding | undefined;
    try {
      binding = state.coordinationBinding(call.threadId, call.turnId);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (!binding)
      return Promise.resolve({
        text: "Coordination call is not bound to current task work",
        success: false,
      });

    const pending = Promise.resolve()
      .then(async () => {
        const response = dispatchCoordinationTool(
          coordination,
          call as CoordinationCall,
          () => !state.taskHold(binding.taskId),
        );
        if (response.success) await this.wakeScheduler();
        return response;
      })
      .catch((error: unknown) => ({
        text: String(error).slice(0, 1000),
        success: false,
      }));
    this.registerExecutionCallback(binding.workId, pending);
    return pending;
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

  private routingStaleReason(
    domain: DomainStore,
    state: ExecutionState,
    snapshot: RoutingSnapshot,
  ): RoutingStaleReason | undefined {
    if (state.taskHold(snapshot.taskId)) return "task-held";
    const task = domain.task(snapshot.taskId);
    if (Number(task.version) !== snapshot.taskVersion)
      return "task-revision-changed";
    const routing = domain.routing(snapshot.projectId);
    if (
      Number(routing.version) !== snapshot.guidanceRevision ||
      Number(routing.enabled) !== 1
    )
      return "routing-revision-changed";
    const candidates = domain.routingCandidates(snapshot.projectId);
    const capturedIds = snapshot.candidates
      .map((candidate) => candidate.profileId)
      .sort();
    const currentIds = candidates
      .map((candidate) => String(candidate.profileId))
      .sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(capturedIds))
      return "candidate-set-changed";
    if (
      candidates.some((candidate) => {
        const captured = snapshot.candidates.find(
          (item) => item.profileId === candidate.profileId,
        );
        return Number(candidate.profileRevision) !== captured?.profileRevision;
      })
    )
      return "candidate-profile-changed";
    if (!domain.admission(snapshot.taskId).eligible) return "admission-held";
    if (domain.assignments(snapshot.taskId).length > 0)
      return "assignment-already-exists";
    return undefined;
  }

  private async wakeScheduler(): Promise<void> {
    const scheduler = this.scheduler;
    const store = this.schedulerStore;
    const domain = this.domainState;
    const state = this.state;
    const coordination = this.coordination;
    const routingAttempts = this.routingAttempts;
    if (
      !scheduler ||
      !store ||
      !domain ||
      !state ||
      !coordination ||
      !routingAttempts
    )
      return;
    const deliveryWorkCompleted = (delivery: InboxDelivery): boolean => {
      const intent = state.byWorkId(delivery.deliveryWorkId);
      const binding = state.taskBinding(delivery.deliveryWorkId);
      return Boolean(
        intent?.state === "completed" &&
          binding?.workId === delivery.deliveryWorkId &&
          binding.taskId === delivery.taskId &&
          binding.assignmentId === delivery.recipientAssignmentId &&
          binding.assignmentVersion === delivery.assignmentVersion,
      );
    };
    for (const delivery of coordination.queuedDeliveries())
      if (deliveryWorkCompleted(delivery))
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);

    for (const completion of coordination.completionRequests()) {
      if (completion.status !== "pending") continue;
      const intent = state.byWorkId(completion.leadWorkId);
      const binding = state.taskBinding(completion.leadWorkId);
      if (
        intent?.state !== "completed" ||
        !binding ||
        binding.taskId !== completion.taskId ||
        binding.assignmentId !== completion.leadAssignmentId
      )
        continue;
      coordination.finalizeTaskCompletion({
        requestId: completion.requestId,
        workId: completion.leadWorkId,
        terminal: "completed",
      });
    }
    for (const workId of coordination.completedWorkNeedingDisposition())
      coordination.recordSuccessfulTerminal(workId);

    for (const operation of domain.routingOperations()) {
      const disposition = String(operation.disposition);
      if (!disposition.startsWith("lead-review:")) continue;
      const taskId = String(operation.taskId);
      const leadAssignment = domain.ensureLeadAssignment(taskId);
      if (!leadAssignment) continue;
      coordination.ensureRoutingFallbackEvent({
        routingOperationId: String(operation.id),
        taskId,
        recipientAssignmentId: String(leadAssignment.id),
        brief: String(operation.brief),
        reason: disposition.slice("lead-review:".length),
        evidence: String(operation.judgment ?? ""),
      });
    }

    const committedRoutingIds = new Set(
      domain.routingOperations().map((operation) => String(operation.id)),
    );
    for (const operation of routingAttempts.operations()) {
      if (
        operation.status === "stale" ||
        committedRoutingIds.has(operation.operationId)
      )
        continue;
      const staleReason = this.routingStaleReason(
        domain,
        state,
        operation.snapshot,
      );
      if (staleReason)
        routingAttempts.markStale(operation.operationId, staleReason);
    }

    for (const task of domain.readyTasksWithLead()) {
      const taskId = String(task.id);
      const taskAssignments = domain.assignments(taskId);
      if (taskAssignments.length > 0) continue;
      const route = domain.routing(String(task.projectId));
      if (Number(route.enabled) !== 1) {
        domain.ensureLeadAssignment(taskId);
        continue;
      }
      if (!domain.admission(taskId).eligible || state.taskHold(taskId))
        continue;
      const leadBinding = domain.ensureLeadBinding(taskId);
      if (!leadBinding) continue;

      const projectId = String(task.projectId);
      const currentTask = domain.task(taskId);
      const candidates = domain
        .routingCandidates(projectId)
        .map((candidate) => ({
          profileId: String(candidate.profileId),
          name: String(candidate.name),
          capabilities: String(candidate.capabilities),
          profileRevision: Number(candidate.profileRevision),
        }));
      const snapshot: RoutingSnapshot = {
        projectId,
        taskId,
        taskVersion: Number(currentTask.version),
        guidanceRevision: Number(route.version),
        brief: String(currentTask.outcome),
        findings: "",
        guidance: String(route.guidance),
        candidates,
      };
      const existingAttempt = routingAttempts.operation(
        projectId,
        taskId,
        snapshot.taskVersion,
      );
      if (existingAttempt?.status === "stale") continue;
      if (
        existingAttempt &&
        JSON.stringify(existingAttempt.snapshot) !== JSON.stringify(snapshot)
      ) {
        routingAttempts.markStale(
          existingAttempt.operationId,
          this.routingStaleReason(domain, state, existingAttempt.snapshot) ??
            "domain-disposition-rejected",
        );
        continue;
      }
      const attempt =
        existingAttempt ?? routingAttempts.ensureOperation(snapshot);
      if (attempt.status === "stale") continue;

      let outcome: RoutingOutcome;
      if (candidates.length === 0) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "no-candidates",
          requestedModel: routingModel,
        });
      } else if (!snapshot.brief.trim()) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "missing-context",
          requestedModel: routingModel,
        });
      } else {
        const credentialReference =
          domain.routingCredentialReference(projectId);
        const client =
          this.options.routingClient === undefined
            ? routingClientFromEnvironment(credentialReference)
            : (this.options.routingClient ?? undefined);
        if (!route.credentialAvailable || !client) {
          outcome = routingAttempts.completeFallback(attempt.operationId, {
            kind: "lead-review",
            reason: "missing-credentials",
            requestedModel: routingModel,
          });
        } else {
          const cacheKey =
            this.options.routingClient === undefined
              ? (credentialReference ?? "missing-credential-reference")
              : "injected-routing-client";
          let coordinator = this.routingCoordinators.get(cacheKey);
          if (!coordinator) {
            coordinator = new RoutingCoordinator(routingAttempts, client);
            this.routingCoordinators.set(cacheKey, coordinator);
          }
          try {
            outcome = await coordinator.route(snapshot);
          } catch (error) {
            if (error instanceof RoutingOperationStaleError) continue;
            throw error;
          }
        }
      }

      const staleReason = this.routingStaleReason(domain, state, snapshot);
      if (staleReason) {
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      const disposition =
        outcome.kind === "assigned"
          ? "assigned"
          : `lead-review:${outcome.reason}`;
      let recorded: ReturnType<DomainStore["recordRouting"]>;
      try {
        recorded = domain.recordRouting(
          {
            id: attempt.operationId,
            projectId,
            taskId,
            taskVersion: snapshot.taskVersion,
            assignmentId:
              outcome.kind === "assigned" ? attempt.operationId : null,
            candidateRevisions: Object.fromEntries(
              candidates.map((candidate) => [
                candidate.profileId,
                candidate.profileRevision,
              ]),
            ),
            guidanceRevision: snapshot.guidanceRevision,
            model: outcome.requestedModel,
            question:
              "Choose the best eligible initial assignee, or return for lead review.",
            judgment: JSON.stringify(outcome),
            disposition,
            resultDestination: "lead:task",
            brief: snapshot.brief,
            ...(outcome.kind === "assigned"
              ? {
                  assignment: {
                    profileId: outcome.profileId,
                    brief: snapshot.brief,
                    requesterAssignmentId: null,
                  },
                }
              : {}),
          },
          () => !state.taskHold(taskId),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const staleReason =
          this.routingStaleReason(domain, state, snapshot) ??
          (message === "External admission rejected routing disposition"
            ? "task-held"
            : /stale|held|candidate|revision|already assigned/i.test(message)
              ? "domain-disposition-rejected"
              : undefined);
        if (!staleReason) throw error;
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      if (outcome.kind === "lead-review") {
        const leadAssignment = domain.ensureLeadAssignment(taskId);
        if (!leadAssignment)
          throw new Error("Routing fallback requires a configured task lead");
        coordination.ensureRoutingFallbackEvent({
          routingOperationId: String(recorded.id),
          taskId,
          recipientAssignmentId: String(leadAssignment.id),
          brief: snapshot.brief,
          reason: outcome.reason,
          evidence: JSON.stringify(outcome),
        });
      }
    }
    for (const assignment of domain.pendingAssignments()) {
      const taskId = String(assignment.taskId);
      const task = domain.task(taskId);
      if (Number(task.ready) !== 1 || task.state !== "open") continue;
      const assignmentId = String(assignment.id);
      const initialWorkId = `assignment:${assignmentId}:initial`;
      if (store.list().some((item) => item.workId === initialWorkId)) continue;
      const queued = coordination
        .queuedDeliveries()
        .find((item) => item.recipientAssignmentId === assignmentId);
      let delivery: InboxDelivery | undefined = queued;
      if (!delivery && coordination.pendingEvents(assignmentId).length > 0)
        delivery = coordination.bindDeliveryBatch(
          assignmentId,
          initialWorkId,
          Number(assignment.version),
        );
      const requestWorkId = delivery?.deliveryWorkId ?? initialWorkId;
      try {
        store.createAssignment(
          {
            taskId,
            projectId: String(assignment.projectId),
            assignmentId,
            taskVersion: Number(task.version),
            assignmentVersion: Number(assignment.version),
            instructionsRevision: Number(assignment.instructionsRevision),
            profileRevision: Number(assignment.profileRevision),
            prompt: this.assignmentPrompt(String(assignment.brief), delivery),
            previousWorkId: delivery
              ? (state.latestCompletedAssignmentWork(assignmentId) ?? null)
              : null,
          },
          delivery
            ? { requestKey: requestWorkId, workId: requestWorkId }
            : undefined,
        );
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

    const requests = store.list();
    for (const delivery of coordination.queuedDeliveries()) {
      if (deliveryWorkCompleted(delivery)) {
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);
        continue;
      }
      if (requests.some((item) => item.workId === delivery.deliveryWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(delivery.recipientAssignmentId);
      } catch {
        continue;
      }
      const task = domain.task(delivery.taskId);
      if (
        Number(assignment.version) !== delivery.assignmentVersion ||
        (assignment.state !== "pending" && assignment.state !== "running") ||
        Number(task.ready) !== 1 ||
        task.state !== "open"
      )
        continue;
      const workId = delivery.deliveryWorkId;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: delivery.recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: delivery.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(String(assignment.brief), delivery),
          previousWorkId:
            state.latestCompletedAssignmentWork(
              delivery.recipientAssignmentId,
            ) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const recipientAssignmentId of coordination.pendingEventRecipients()) {
      if (
        coordination
          .queuedDeliveries()
          .some((item) => item.recipientAssignmentId === recipientAssignmentId)
      )
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(recipientAssignmentId);
      } catch {
        continue;
      }
      const task = domain.task(String(assignment.taskId));
      if (
        (assignment.state !== "pending" && assignment.state !== "running") ||
        Number(task.ready) !== 1 ||
        task.state !== "open" ||
        state.assignmentHasUnfinishedExecution(recipientAssignmentId) ||
        store
          .list()
          .some(
            (item) =>
              item.assignmentId === recipientAssignmentId &&
              (item.state === "queued" ||
                item.state === "active" ||
                item.state === "held"),
          )
      )
        continue;
      const pending = coordination.pendingEvents(recipientAssignmentId);
      const first = pending[0];
      if (!first) continue;
      const version = Number(assignment.version);
      const workId = `assignment:${recipientAssignmentId}:v${version}:inbox:${first.eventId}`;
      const delivery = coordination.bindDeliveryBatch(
        recipientAssignmentId,
        workId,
        version,
      );
      if (!delivery) continue;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: version,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(String(assignment.brief), delivery),
          previousWorkId:
            state.latestCompletedAssignmentWork(recipientAssignmentId) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const repair of coordination.reportingRepairs()) {
      if (repair.state !== "queued") continue;
      if (store.list().some((item) => item.workId === repair.repairWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(repair.assignmentId);
      } catch {
        continue;
      }
      const task = domain.task(repair.taskId);
      if (
        Number(assignment.version) !== repair.assignmentVersion ||
        assignment.state === "held" ||
        Number(task.ready) !== 1 ||
        task.state !== "open"
      )
        continue;
      const prompt = `${String(assignment.brief)}\n\nReporting repair: the previous successful turn ended without a saved result or durable waiting action. Continue this assignment and record a result or request a durable next action before ending.`;
      store.createAssignment(
        {
          taskId: repair.taskId,
          projectId: String(assignment.projectId),
          assignmentId: repair.assignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: repair.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt,
          previousWorkId:
            state.latestCompletedAssignmentWork(repair.assignmentId) ??
            repair.missedWorkId,
        },
        { requestKey: repair.repairWorkId, workId: repair.repairWorkId },
      );
    }
    await scheduler.wake();
  }

  private assignmentPrompt(brief: string, delivery?: InboxDelivery): string {
    if (!delivery) return brief;
    const events = delivery.events.map(
      (event) => `- ${event.eventType}: ${event.payload}`,
    );
    return `${brief}\n\nDurable assignment inbox through event ${delivery.highWaterSequence}:\n${events.join("\n")}`;
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
      const tools =
        request.kind === "assignment" && request.assignmentId
          ? coordinationTools
          : undefined;
      if (previous?.threadId) {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        await runtime.resumeThread(previous.threadId, tools);
        threadId = previous.threadId;
      } else {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        threadId = await runtime.startThread(workspace, tools);
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
        const coordination = this.coordination;
        const binding = state.taskBinding(request.workId);
        if (coordination) {
          const delivery = coordination.deliveryForWork(request.workId);
          if (delivery?.state === "queued")
            coordination.completeDeliveryBatch(request.workId);
          if (binding) {
            for (const completion of coordination.completionRequests(
              binding.taskId,
            ))
              if (
                completion.leadWorkId === request.workId &&
                completion.status === "pending"
              )
                coordination.finalizeTaskCompletion({
                  requestId: completion.requestId,
                  workId: request.workId,
                  terminal: "completed",
                });
            coordination.recordSuccessfulTerminal(request.workId);
          }
        }
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
