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
    const mark = join(directory, ".ensemble-standalone");
    if (!existsSync(mark))
      writeFileSync(mark, marker, { flag: "wx", mode: 0o600 });
    const database = join(realpathSync(directory), "standalone.sqlite");
    if (existsSync(database) && lstatSync(database).isSymbolicLink())
      throw new Error("Standalone database must not be a symlink");
    const db = new DatabaseSync(database);
    try {
      db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
      const state = new ExecutionState(db);
      state.holdUnfinishedOnOpen();
      this.db = db;
      this.state = state;
      const runtime = this.runtimeFactory();
      this.runtime = runtime;
      runtime.onUnexpectedRequest((method) => {
        for (const item of state.list())
          if (item.state === "submitting" || item.state === "running")
            state.hold(
              item.id,
              `Unexpected App Server request denied: ${method}`,
            );
      });
      await runtime.start();
    } catch (error) {
      if (this.state)
        for (const item of this.state.list())
          if (item.state === "ready")
            this.state.hold(
              item.id,
              "Runtime or login unavailable during startup",
            );
      await this.runtime?.stop().catch(() => {});
      this.runtime = undefined;
      this.state = undefined;
      this.db = undefined;
      db.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    try {
      if (runtime) await runtime.stop();
    } finally {
      await Promise.allSettled(this.active);
    }
    const db = this.db;
    this.db = undefined;
    this.state = undefined;
    db?.close();
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
    const intent = state.create(workId, prompt, workspace);
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
          previous.workspace !== workspace
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
      if (!state.begin(intent.id)) return state.get(intent.id);
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
        await runtime.resumeThread(previous.threadId);
        threadId = previous.threadId;
      } else threadId = await runtime.startThread(workspace);
      state.bindThread(intent.id, threadId);
      const turnId = await runtime.startTurn(threadId, workspace, prompt);
      state.bindTurn(intent.id, turnId);
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
