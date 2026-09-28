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
import { DomainStore } from "../core/domain.js";
import { CodexRuntime, type Runtime } from "./codex.js";
import { ExecutionState, type ExecutionIntent } from "./state.js";
import type { TaskExecutionContext } from "./state.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
} from "./workspaces.js";

const marker = "ensemble-standalone-v1\n";
const markerName = ".ensemble-standalone";
const ownerName = ".ensemble-owner.sqlite";

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
  private runtime: Runtime | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();
  private readonly callbacks = new Map<string, Set<Promise<unknown>>>();

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: () => Runtime = () => new CodexRuntime(),
    private readonly markerWriter: (path: string, flag: "wx" | "w") => void = (
      path,
      flag,
    ) => writeFileSync(path, marker, { flag, mode: 0o600 }),
  ) {}

  async start(): Promise<void> {
    if (this.db) throw new Error("Service already started");
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
      const domain = new DomainStore(db);
      domain.migrate();
      this.domainState = domain;
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
      runtime.onUnexpectedRequest((request) => {
        const active = state
          .list()
          .filter(
            (item) => item.state === "submitting" || item.state === "running",
          );
        const bound =
          request.threadId && request.turnId
            ? active.filter(
                (item) =>
                  item.threadId === request.threadId &&
                  item.turnId === request.turnId,
              )
            : [];
        if (bound.length === 0 && request.threadId && request.turnId) {
          const awaiting = active.filter(
            (item) =>
              item.state === "submitting" &&
              item.threadId === request.threadId &&
              item.turnId === null,
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
          )
            return;
        }
        const affected = bound.length === 1 ? bound : active;
        for (const item of affected)
          state.hold(
            item.id,
            `Unexpected App Server request denied: ${request.method}`,
          );
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
                  item.state === "submitting" || item.state === "running",
              );
        for (const item of matched) {
          state.holdTerminalConflict(item.id, anomaly.reason);
          for (const successor of items)
            if (
              successor.workspace === item.workspace &&
              (successor.state === "submitting" ||
                successor.state === "running")
            )
              state.hold(successor.id, anomaly.reason);
        }
      });
      await runtime.start();
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
          await this.runtime?.stop().catch(() => {});
        } finally {
          this.runtime = undefined;
          this.domainState = undefined;
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
    const runtime = this.runtime;
    this.runtime = undefined;
    let failure: unknown;
    try {
      if (runtime) await runtime.stop();
    } catch (error) {
      failure = error;
    }
    await Promise.allSettled(this.active);
    const db = this.db;
    this.db = undefined;
    this.state = undefined;
    this.domainState = undefined;
    this.workspaces = undefined;
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

  domain(): DomainStore {
    if (!this.domainState) throw new Error("Service is not started");
    return this.domainState;
  }

  /** The task command owns identity; provisioning never follows a conversation ID. */
  provisionTask(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ) {
    this.domain().task(taskId);
    return this.requireWorkspaces().provision(taskId, repositories);
  }

  taskWorkspace(taskId: string) {
    this.domain().task(taskId);
    return this.requireWorkspaces().get(taskId);
  }

  archiveTask(taskId: string, evidence: WorkspaceCleanupEvidence) {
    this.domain().task(taskId);
    const writerOwnershipResolved =
      evidence.writerOwnershipResolved &&
      !this.requireState().hasUnresolvedTask(taskId);
    return this.requireWorkspaces().archiveAndCleanup(taskId, {
      ...evidence,
      writerOwnershipResolved,
    });
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

  stopTask(taskId: string): void {
    this.domain().task(taskId);
    this.requireState().stopTask(taskId);
  }

  resumeTask(taskId: string): void {
    this.domain().task(taskId);
    this.requireState().resumeTask(taskId);
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
    state.holdTerminalConflict(intent.id, holdReason);
    for (const other of state.list())
      if (
        other.workspace === intent.workspace &&
        (other.state === "submitting" || other.state === "running")
      )
        state.hold(other.id, holdReason);
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

  submitTask(
    workId: string,
    assignmentId: string,
    prompt: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const action = this.dispatchTask(
      workId,
      assignmentId,
      prompt,
      previousWorkId,
    );
    this.active.add(action);
    void action.finally(() => this.active.delete(action)).catch(() => {});
    return action;
  }

  private async dispatchTask(
    workId: string,
    assignmentId: string,
    prompt: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const domain = this.domain();
    const assignment = domain.assignment(assignmentId);
    const admission = domain.assignmentAdmission(assignmentId);
    if (!admission.eligible)
      throw new Error(
        `Assignment is not eligible: ${admission.reasons.join(", ")}`,
      );
    const taskId = String(assignment.taskId);
    const binding = await this.requireWorkspaces().forExecution(taskId);
    if (
      Number(domain.assignment(assignmentId).version) !==
      Number(assignment.version)
    )
      throw new Error("Assignment revision changed during workspace admission");
    const context: TaskExecutionContext = {
      taskId,
      assignmentId,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    };
    return this.dispatch(workId, prompt, binding.path, previousWorkId, context);
  }

  /** One explicit dispatch; same work ID never submits twice, including after errors. */
  submit(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const action = this.dispatch(workId, prompt, workspace, previousWorkId);
    this.active.add(action);
    void action.finally(() => this.active.delete(action)).catch(() => {});
    return action;
  }

  private async dispatch(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
    context?: TaskExecutionContext,
  ): Promise<ExecutionIntent> {
    const state = this.requireState();
    const runtime = this.requireRuntime();
    let workspaceKey: string;
    try {
      workspaceKey = realpathSync(workspace);
    } catch {
      workspaceKey = resolve(workspace);
    }
    if (!context) {
      const managedRoot = join(realpathSync(this.dataDir), "workspaces");
      if (
        workspaceKey === managedRoot ||
        workspaceKey.startsWith(`${managedRoot}${sep}`)
      )
        throw new Error("Task workspaces require a durable assignment binding");
    }
    const intent = state.create(workId, prompt, workspaceKey);
    if (context) state.bindTask(workId, context);
    if (intent.state !== "ready" || intent.reason) return intent;
    let previous: ExecutionIntent | undefined;
    try {
      if (!isAbsolute(workspace) || !lstatSync(workspace).isDirectory())
        throw new Error("Workspace must be an existing real directory");
      if (previousWorkId) {
        previous = state.byWorkId(previousWorkId);
        const priorBinding = state.taskBinding(previousWorkId);
        if (
          context &&
          previous &&
          previous.state !== "completed" &&
          previous.workspace === workspaceKey &&
          priorBinding?.taskId === context.taskId &&
          priorBinding.assignmentId === context.assignmentId
        )
          return intent;
        if (
          previous?.state !== "completed" ||
          !previous.threadId ||
          previous.workspace !== workspaceKey ||
          (context &&
            (priorBinding?.taskId !== context.taskId ||
              priorBinding.assignmentId !== context.assignmentId))
        )
          throw new Error(
            "Previous work is not a completed binding in this workspace",
          );
      }
    } catch (error) {
      state.hold(intent.id, `Pre-submission refusal: ${String(error)}`);
      return state.get(intent.id);
    }
    try {
      if (!state.begin(intent.id)) {
        // A queued turn has no writer reservation. It can be retried after the
        // current writer has qualified completion or independent resolution.
        // The S02 direct-work API retains its established refusal semantics.
        if (!context && state.get(intent.id).state === "ready")
          state.hold(intent.id, "Workspace has unresolved execution");
        return state.get(intent.id);
      }
    } catch (error) {
      state.hold(
        intent.id,
        `Storage failure before submission: ${String(error)}`,
      );
      return state.get(intent.id);
    }
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
        threadId = await runtime.startThread(workspaceKey);
      }
      if (!state.bindThread(intent.id, threadId))
        throw new Error("Thread binding was held or changed");
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      const turnId = await runtime.startTurn(threadId, workspaceKey, prompt);
      if (!state.bindTurn(intent.id, turnId))
        throw new Error("Turn binding was held or changed");
      const outcome = await runtime.waitForTurn(threadId, turnId);
      if (
        outcome === "completed" &&
        (this.callbacks.get(workId)?.size ?? 0) > 0
      )
        state.hold(
          intent.id,
          "Ensemble callback is unfinished at terminal status",
        );
      else if (outcome === "completed")
        state.complete(intent.id, threadId, turnId);
      else state.hold(intent.id, "Bound turn failed or was interrupted");
    } catch (error) {
      if (state.get(intent.id).state !== "held")
        state.hold(
          intent.id,
          `Runtime submission or observation uncertain: ${String(error)}`,
        );
    }
    return state.get(intent.id);
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
