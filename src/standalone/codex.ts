import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RuntimeProcessIdentity,
} from "./recovery-types.js";
import { captureProcessIdentity } from "./termination.js";

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
const codexErrorInfoSchema = z.enum([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "flexUnavailable",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
const completedTurn = z.object({
  threadId: z.string().min(1),
  turn: z.object({
    id: z.string().min(1),
    status: z.string(),
    error: z
      .object({ codexErrorInfo: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

export type CodexErrorInfo = z.infer<typeof codexErrorInfoSchema>;

export interface FailureEvidence {
  threadId: string;
  turnId: string;
  status: "failed";
  classification: "transient" | "permanent" | "unknown";
  reasonCode: CodexErrorInfo | "unknown";
  source: "codexErrorInfo" | "missing";
  codexRetries: number | null;
  retryAfterMs?: number;
}

const failureEvidenceSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.literal("failed"),
    classification: z.enum(["transient", "permanent", "unknown"]),
    reasonCode: codexErrorInfoSchema.or(z.literal("unknown")),
    source: z.enum(["codexErrorInfo", "missing"]),
    codexRetries: z.number().int().nonnegative().safe().nullable(),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(86_400_000)
      .optional(),
  })
  .strict();

export function parseFailureEvidence(
  input: unknown,
): FailureEvidence | undefined {
  const parsed = failureEvidenceSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { retryAfterMs, ...evidence } = parsed.data;
  return retryAfterMs === undefined ? evidence : { ...evidence, retryAfterMs };
}

function makeFailureEvidence(
  threadId: string,
  turnId: string,
  rawCode: string | undefined,
): FailureEvidence {
  const parsed =
    rawCode === undefined ? undefined : codexErrorInfoSchema.safeParse(rawCode);
  const code = parsed?.success ? parsed.data : undefined;
  const classification =
    code === "serverOverloaded" || code === "rateLimitExceeded"
      ? "transient"
      : code === "badRequest" || code === "unauthorized"
        ? "permanent"
        : "unknown";
  return {
    threadId,
    turnId,
    status: "failed",
    classification,
    reasonCode: code ?? "unknown",
    source: code ? "codexErrorInfo" : "missing",
    // App Server's terminal TurnError exposes no per-turn retry count. Null is
    // deliberately non-retryable under the shared Ensemble/Codex budget.
    codexRetries: null,
  };
}

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

export interface UnexpectedRequest {
  method: string;
  threadId?: string;
  turnId?: string;
}

/** Modern approval params carry server-owned thread/turn IDs; legacy params do not. */
export function unexpectedRequest(
  method: string,
  params: unknown,
): UnexpectedRequest {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  ) {
    const identity = z
      .object({ threadId: z.string().min(1), turnId: z.string().min(1) })
      .safeParse(params);
    if (identity.success) return { method, ...identity.data };
  }
  return { method };
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
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed">;
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void;
  onTerminalAnomaly?(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void;
  processIdentity?():
    | RuntimeProcessIdentity
    | null
    | Promise<RuntimeProcessIdentity | null>;
  inspectExecution?(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection>;
  failureEvidence?(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined;
}

/** One private stdio App Server process. It never sends an approval grant. */
export class CodexRuntime implements Runtime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private processIdentityValue: RuntimeProcessIdentity | null = null;
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
  private readonly terminalHistory = new Map<string, "completed" | "failed">();
  private readonly failures = new Map<string, FailureEvidence>();
  private unexpected?: (request: UnexpectedRequest) => void;
  private terminalAnomaly?: (anomaly: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private failure: Error | undefined;

  constructor(private readonly executable = "codex") {}

  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void {
    this.unexpected = listener;
  }

  onTerminalAnomaly(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void {
    this.terminalAnomaly = listener;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Runtime already started");
    this.failure = undefined;
    this.failures.clear();
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
    this.processIdentityValue = null;
    child.on("error", (error) => this.failChild(child, error));
    child.on("exit", () =>
      this.failChild(child, new Error("Codex App Server exited")),
    );
    child.stdin.on("error", (error) => this.failChild(child, error));
    child.stdin.on("close", () =>
      this.failChild(child, new Error("Codex App Server stdin closed")),
    );
    // Diagnostics may contain sensitive data. Drain without retaining or logging
    // them so a full stderr pipe cannot stall JSON-RPC on stdout.
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.receive(child, line),
    );
    try {
      this.processIdentityValue = await captureProcessIdentity(child.pid);
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.request("initialize", {
        clientInfo: { name: "ensemble", version: "0.1.0" },
      });
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.send(`${JSON.stringify({ method: "initialized" })}\n`);
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.verifyLoginAndPolicy(child);
    } catch (error) {
      if (this.child === child) await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.processIdentityValue = null;
    this.fail(new Error("Runtime stopped"));
    this.terminals.clear();
    this.failures.clear();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 3000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }

  async verifyLoginAndPolicy(expectedChild = this.child): Promise<void> {
    if (!expectedChild || this.child !== expectedChild)
      throw new Error("Runtime stopped");
    account.parse(await this.request("account/read", { refreshToken: false }));
    if (this.child !== expectedChild) throw new Error("Runtime stopped");
    configuration.parse(await this.request("config/read", {}));
    if (this.child !== expectedChild) throw new Error("Runtime stopped");
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

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    z.object({})
      .strict()
      .parse(await this.request("turn/interrupt", { threadId, turnId }));
  }

  processIdentity(): RuntimeProcessIdentity | null {
    return this.processIdentityValue;
  }

  async inspectExecution(
    _identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    // thread/read and thread/resume expose history, not proof of this exact
    // process's current execution state. Do not turn either into a recovery fact.
    return {
      kind: "unknown",
      reason: "Codex App Server cannot prove exact historical execution state",
    };
  }

  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined {
    if (!threadId || !turnId) return undefined;
    const evidence = this.failures.get(`${threadId}:${turnId}`);
    return evidence ? { ...evidence } : undefined;
  }

  async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    if (this.failure) throw this.failure;
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
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      void this.send(`${JSON.stringify({ id, method, params })}\n`).catch(
        (error: Error) => this.failChild(child, error),
      );
    });
  }

  private send(line: string): Promise<void> {
    const child = this.child;
    if (!child || this.failure)
      return Promise.reject(this.failure ?? new Error("Runtime unavailable"));
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(line, (error) => {
          if (this.child !== child) {
            reject(new Error("Runtime stopped"));
            return;
          }
          if (error) {
            this.failChild(child, error);
            reject(error);
          } else resolve();
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.failChild(child, failure);
        reject(failure);
      }
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: z.infer<typeof rpc>;
    try {
      message = rpc.parse(JSON.parse(line));
    } catch {
      this.failChild(child, new Error("Malformed App Server message"));
      return;
    }
    if (message.method && message.id !== undefined) {
      const method = message.method;
      let holdFailed = false;
      try {
        this.unexpected?.(unexpectedRequest(method, message.params));
      } catch (error) {
        holdFailed = true;
        this.failChild(
          child,
          new Error(
            `Could not persist unexpected request hold: ${String(error)}`,
          ),
        );
      }
      if (this.child === child)
        void this.send(
          `${JSON.stringify(deniedServerRequest(message.id, method))}\n`,
        ).then(
          () => {
            if (holdFailed) child.kill("SIGTERM");
          },
          (error: Error) => this.failChild(child, error),
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
      const terminal = completedTurn.safeParse(message.params);
      if (!terminal.success) {
        this.terminalAnomaly?.({
          reason: "Missing terminal identity or status",
        });
      } else {
        const key = `${terminal.data.threadId}:${terminal.data.turn.id}`;
        if (terminal.data.turn.status === "failed")
          this.failures.set(
            key,
            makeFailureEvidence(
              terminal.data.threadId,
              terminal.data.turn.id,
              terminal.data.turn.error?.codexErrorInfo,
            ),
          );
        const status =
          terminal.data.turn.status === "completed" ? "completed" : "failed";
        const prior = this.terminalHistory.get(key);
        if (prior && prior !== status)
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: "Conflicting terminal status",
          });
        this.terminalHistory.set(key, status);
        this.terminals.set(key, prior && prior !== status ? "failed" : status);
      }
    }
    if (message.method) this.events.emit(message.method, message.params);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.events.emit("failure", error);
    if (this.child?.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGTERM");
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child === child) this.fail(error);
  }
}
