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
import { isAbsolute, join, resolve } from "node:path";
import { Store } from "../core/store.js";
import { CodexRuntime, type Runtime } from "./codex.js";
import { ExecutionState, type ExecutionIntent } from "./state.js";

const marker = "ensemble-standalone-v1\n";

/** Owns only standalone.sqlite in a marked data directory. No import or attach path exists. */
export class StandaloneService {
  private owner: DatabaseSync | undefined;
  private db: DatabaseSync | undefined;
  private state: ExecutionState | undefined;
  private runtime: Runtime | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: () => Runtime = () => new CodexRuntime(),
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
      const mark = join(directory, ".ensemble-standalone");
      if (!existsSync(mark) && readdirSync(directory).length !== 0)
        throw new Error("Unmarked data directory must be empty");
      if (existsSync(mark) && lstatSync(mark).isSymbolicLink())
        throw new Error("Data directory marker must not be a symlink");
      if (existsSync(mark) && readFileSync(mark, "utf8") !== marker)
        throw new Error("Data directory marker mismatch");
    } else mkdirSync(directory, { recursive: true, mode: 0o700 });
    // SQLite owns the OS file lock for this transaction. A process crash releases
    // it without consulting stale PID files or a clock.
    const canonical = realpathSync(directory);
    const mark = join(canonical, ".ensemble-standalone");
    if (!existsSync(mark))
      writeFileSync(mark, marker, { flag: "wx", mode: 0o600 });
    const ownerPath = join(canonical, ".ensemble-owner.sqlite");
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
      const database = join(canonical, "standalone.sqlite");
      if (existsSync(database) && lstatSync(database).isSymbolicLink())
        throw new Error("Standalone database must not be a symlink");
      const db = new DatabaseSync(database);
      this.db = db;
      db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
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
  ): Promise<ExecutionIntent> {
    const state = this.requireState();
    const runtime = this.requireRuntime();
    let workspaceKey: string;
    try {
      workspaceKey = realpathSync(workspace);
    } catch {
      workspaceKey = resolve(workspace);
    }
    const intent = state.create(workId, prompt, workspaceKey);
    if (intent.state !== "ready" || intent.reason) return intent;
    let previous: ExecutionIntent | undefined;
    try {
      if (!isAbsolute(workspace) || !lstatSync(workspace).isDirectory())
        throw new Error("Workspace must be an existing real directory");
      if (previousWorkId) {
        previous = state.byWorkId(previousWorkId);
        if (
          previous?.state !== "completed" ||
          !previous.threadId ||
          previous.workspace !== workspaceKey
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
        if (state.get(intent.id).state === "ready")
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
      if (outcome === "completed") state.complete(intent.id, threadId, turnId);
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
}
