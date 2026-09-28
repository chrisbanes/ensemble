import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";

const rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const account = z.object({ account: z.object({ type: z.literal("chatgpt") }) });
const configuration = z.object({
  config: z
    .object({
      approval_policy: z.literal("never"),
      sandbox_mode: z.literal("workspace-write"),
    })
    .passthrough(),
});
const thread = z.object({
  thread: z.object({ id: z.string() }),
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("workspaceWrite") }),
});
const turn = z.object({ turn: z.object({ id: z.string() }) });

export const executionPolicy = (workspace: string) => ({
  type: "workspaceWrite" as const,
  writableRoots: [workspace],
  networkAccess: false,
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
});

/** Exact installed protocol denial for known approval requests; others error. */
export function deniedServerRequest(id: string | number, method: string) {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  )
    return { id, result: { decision: "cancel" } };
  if (method === "applyPatchApproval" || method === "execCommandApproval")
    return { id, result: { decision: "abort" } };
  return {
    id,
    error: {
      code: -32601,
      message: "Ensemble denies unexpected server request",
    },
  };
}

export interface Runtime {
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(workspace: string): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
  ): Promise<string>;
  waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed">;
  onUnexpectedRequest(listener: (method: string) => void): void;
}

/** One private stdio App Server process. It never sends an approval grant. */
export class CodexRuntime implements Runtime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly events = new EventEmitter();
  private readonly terminals = new Map<string, "completed" | "failed">();
  private unexpected?: (method: string) => void;

  constructor(private readonly executable = "codex") {}

  onUnexpectedRequest(listener: (method: string) => void): void {
    this.unexpected = listener;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Runtime already started");
    const child = spawn(
      this.executable,
      [
        "app-server",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_mode=workspace-write",
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => this.fail(new Error("Codex App Server exited")));
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.receive(line),
    );
    try {
      await this.request("initialize", {
        clientInfo: { name: "ensemble", version: "0.1.0" },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      await this.verifyLoginAndPolicy();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    this.fail(new Error("Runtime stopped"));
  }

  async verifyLoginAndPolicy(): Promise<void> {
    account.parse(await this.request("account/read", { refreshToken: false }));
    configuration.parse(await this.request("config/read", {}));
  }

  async startThread(workspace: string): Promise<string> {
    const response = thread.parse(
      await this.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
      }),
    );
    return response.thread.id;
  }

  async resumeThread(threadId: string): Promise<void> {
    thread.parse(
      await this.request("thread/resume", {
        threadId,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }),
    );
  }

  async startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
  ): Promise<string> {
    const response = turn.parse(
      await this.request("turn/start", {
        threadId,
        cwd: workspace,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: executionPolicy(workspace),
      }),
    );
    return response.turn.id;
  }

  async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    const key = `${threadId}:${turnId}`;
    const observed = this.terminals.get(key);
    if (observed) {
      this.terminals.delete(key);
      return observed;
    }
    return await new Promise((resolve, reject) => {
      const onTerminal = (data: unknown) => {
        const parsed = z
          .object({
            threadId: z.string(),
            turn: z.object({ id: z.string(), status: z.string() }),
          })
          .safeParse(data);
        if (
          !parsed.success ||
          parsed.data.threadId !== threadId ||
          parsed.data.turn.id !== turnId
        )
          return;
        cleanup();
        this.terminals.delete(key);
        resolve(
          parsed.data.turn.status === "completed" ? "completed" : "failed",
        );
      };
      const onFailure = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(
        () => onFailure(new Error("Turn terminal status timed out")),
        180000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("turn/completed", onTerminal);
        this.events.off("failure", onFailure);
      };
      this.events.on("turn/completed", onTerminal);
      this.events.on("failure", onFailure);
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Runtime unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  private receive(line: string): void {
    let message: z.infer<typeof rpc>;
    try {
      message = rpc.parse(JSON.parse(line));
    } catch {
      this.fail(new Error("Malformed App Server message"));
      return;
    }
    if (message.method && message.id !== undefined) {
      const method = message.method;
      this.unexpected?.(method);
      this.child?.stdin.write(
        `${JSON.stringify(deniedServerRequest(message.id, method))}\n`,
      );
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error !== undefined)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "turn/completed") {
      const terminal = z
        .object({
          threadId: z.string(),
          turn: z.object({ id: z.string(), status: z.string() }),
        })
        .safeParse(message.params);
      if (terminal.success)
        this.terminals.set(
          `${terminal.data.threadId}:${terminal.data.turn.id}`,
          terminal.data.turn.status === "completed" ? "completed" : "failed",
        );
    }
    if (message.method) this.events.emit(message.method, message.params);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.events.emit("failure", error);
  }
}
