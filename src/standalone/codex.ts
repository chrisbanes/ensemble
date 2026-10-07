import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  boundedQuestionPayload,
  structuredAnswerDigest,
} from "../core/structured-questions.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  encodeNativeInputReply,
  nativeEndpointKey,
  parseNativeInputRequest,
  nativeInputRequestSchema,
  nativeInputEndpointIdentitySchema,
  nativeInputQualificationSchema,
  type NativeInputEndpointIdentity,
  type NativeInputReply,
  type NativeInputProtocolQualification,
  type RuntimeReplyIntent,
  type RuntimeUserInputOutcome,
  type RuntimeUserInputRequest,
} from "./native-input.js";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RuntimeProcessIdentity,
} from "./recovery-types.js";
import { captureProcessIdentity } from "./termination.js";
import {
  ArchivedResumeRejectedError,
  archivedResumeRejectionSchema,
} from "./pre-turn-recovery.js";
import type {
  RuntimeNativeEndpointHistory,
  RuntimeSafetyPort,
  RuntimeTerminalEvidence,
  RuntimeThreadQualification,
} from "./runtime-retention.js";

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
const runtimeToolDefinitionSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
const runtimeToolCallSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
});
const runtimeToolResultSchema = z
  .object({ text: z.string().max(16000), success: z.boolean() })
  .strict();

export type CodexErrorInfo = z.infer<typeof codexErrorInfoSchema>;

export interface RuntimeToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface RuntimeToolResult {
  text: string;
  success: boolean;
}

export type RuntimeConversationEvent =
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "started";
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "delta";
      bytes: number;
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "completed";
      text: string;
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "omitted";
      reason:
        | "size-limit"
        | "item-limit"
        | "active-turn-limit"
        | "turn-ended"
        | "missing-text";
    };

type PendingConversationItem =
  | { kind: "capturing"; chunks: string[]; bytes: number; fragments: number }
  | { kind: "size-limit" };

interface PendingConversationTurn {
  items: Map<string, PendingConversationItem>;
  completedItems: Set<string>;
  totalItems: number;
  truncated: boolean;
}

const maxConversationItemBytes = 64 * 1024;
const maxPendingConversationItems = 64;
const maxConversationItemsPerTurn = 256;
const maxActiveConversationTurns = 16;
const maxConversationBufferBytes = 4 * 1024 * 1024;
const maxConversationFragmentsPerItem = 4096;
const maxConversationIdentityLength = 256;

const conversationIdentity = z
  .string()
  .min(1)
  .max(maxConversationIdentityLength);

export function parseRuntimeToolCall(
  input: unknown,
): RuntimeToolCall | undefined {
  const parsed = runtimeToolCallSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function registeredTools(input: readonly RuntimeToolDefinition[] = []) {
  const parsed = z.array(runtimeToolDefinitionSchema).parse(input);
  const names = new Set<string>();
  for (const tool of parsed) {
    if (names.has(tool.name))
      throw new Error(`Duplicate dynamic tool name: ${tool.name}`);
    names.add(tool.name);
  }
  return Object.freeze(
    parsed.map((tool) =>
      Object.freeze({
        ...tool,
        inputSchema: Object.freeze({ ...tool.inputSchema }),
      }),
    ),
  );
}

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
  nativeReplay?: {
    runtimeGeneration: string;
    requestId: string | number;
    itemId: string;
    paramsDigest: string;
    originalParamsDigest: string | null;
    endpointState: string | null;
    acceptedReplays: number;
    identical: boolean;
  };
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
  if (method === "item/tool/call") {
    const identity = z
      .object({ threadId: z.string().min(1), turnId: z.string().min(1) })
      .safeParse(params);
    if (identity.success) return { method, ...identity.data };
  }
  return { method };
}

export interface Runtime {
  onUserInputRequest?(
    listener: (request: RuntimeUserInputRequest) => void,
  ): void;
  onUserInputOutcome?(
    listener: (outcome: RuntimeUserInputOutcome) => void,
  ): void;
  replyUserInput?(
    identity: NativeInputEndpointIdentity,
    reply: NativeInputReply,
    beforeWrite: () => RuntimeReplyIntent,
  ): Promise<void>;
  cancelUserInput?(identity: NativeInputEndpointIdentity, reason: string): void;
  currentUserInputGeneration?(): string | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(
    workspace: string,
    tools?: readonly RuntimeToolDefinition[],
  ): Promise<string>;
  resumeThread(
    threadId: string,
    tools?: readonly RuntimeToolDefinition[],
  ): Promise<void>;
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
  onToolCall?(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void;
  onTerminalAnomaly?(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void;
  onConversationEvent?(
    listener: (event: RuntimeConversationEvent) => void,
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

interface NativeEndpoint {
  call: RuntimeUserInputRequest;
  digest: string;
  state:
    | "pending"
    | "writing"
    | "sent-unconfirmed"
    | "confirmed"
    | "unavailable"
    | "uncertain";
  intent?: RuntimeReplyIntent;
  resolved: boolean;
  order: number;
  orderedReceipt?: RuntimeUserInputOutcome["orderedReceipt"];
  writeInFlight: boolean;
  outcomeRecorded: boolean;
  turnEnded: boolean;
}

/** One private stdio App Server process. It never sends an approval grant. */
export class CodexRuntime implements Runtime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nativeGeneration: string | undefined;
  private nativeExecutable:
    | { codexVersion: string; executableHash: string }
    | undefined;
  private readonly nativeQualifications = new Map<
    string,
    NativeInputProtocolQualification
  >();
  private readonly nativeEndpoints = new Map<string, NativeEndpoint>();
  private readonly nativeEndpointsByTurn = new Map<string, Set<string>>();
  private readonly nativeEndpointsByRpcId = new Map<string, Set<string>>();
  private readonly nativeThreadSettings = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly nativeTurns = new Map<string, string>();
  private readonly invalidNativeTurns = new Set<string>();
  private readonly nativeReadbacks = new Map<
    string,
    {
      input: unknown;
      id: string | number;
      child: ChildProcessWithoutNullStreams;
      digest: string;
      requested: boolean;
      responded: boolean;
      replays: number;
      invalid: boolean;
    }
  >();
  private nativeRequest?: (request: RuntimeUserInputRequest) => void;
  private nativeOutcome?: (outcome: RuntimeUserInputOutcome) => void;
  onUserInputRequest(
    listener: (request: RuntimeUserInputRequest) => void,
  ): void {
    this.nativeRequest = listener;
  }
  onUserInputOutcome(
    listener: (outcome: RuntimeUserInputOutcome) => void,
  ): void {
    this.nativeOutcome = listener;
  }
  currentUserInputGeneration(): string | undefined {
    return this.failure ? undefined : this.nativeGeneration;
  }
  private emitNative(
    endpoint: NativeEndpoint,
    outcome: RuntimeUserInputOutcome["outcome"],
    reason: string,
  ): void {
    if (
      endpoint.state === "confirmed" ||
      endpoint.state === "uncertain" ||
      endpoint.state === "unavailable"
    )
      return;
    endpoint.state = outcome;
    endpoint.outcomeRecorded = false;
    try {
      if (this.nativeOutcome) {
        this.nativeOutcome({
          ...endpoint.call.identity,
          ...endpoint.intent,
          outcome,
          reason,
          ...(endpoint.orderedReceipt
            ? { orderedReceipt: { ...endpoint.orderedReceipt } }
            : {}),
        });
        endpoint.outcomeRecorded = true;
      }
      if (
        outcome !== "sent-unconfirmed" &&
        endpoint.outcomeRecorded &&
        !endpoint.writeInFlight &&
        (outcome !== "confirmed" || endpoint.turnEnded)
      )
        this.retireNativeEndpoint(endpoint.call.identity);
    } catch {
      endpoint.state = "uncertain";
      this.unexpected?.({
        method: "native-outcome-could-not-be-recorded",
        threadId: endpoint.call.identity.threadId,
        turnId: endpoint.call.identity.turnId,
      });
    }
  }
  cancelUserInput(identity: NativeInputEndpointIdentity, reason: string): void {
    const endpoint = this.nativeEndpoints.get(nativeEndpointKey(identity));
    if (endpoint) {
      if (endpoint.state === "writing" && endpoint.resolved) return;
      const waiting = this.nativeReadbacks.get(identity.threadId);
      if (
        waiting &&
        waiting.child === this.child &&
        waiting.id === identity.requestId &&
        nativeInputRequestSchema.parse(waiting.input).turnId === identity.turnId
      )
        waiting.invalid = true;
      this.emitNative(
        endpoint,
        endpoint.intent ? "uncertain" : "unavailable",
        reason,
      );
    }
  }
  private cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    for (const endpoint of this.nativeEndpointsForTurn(threadId, turnId))
      this.cancelUserInput(endpoint.call.identity, reason);
  }

  private retireNativeTurn(
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    const activeTurn = this.nativeTurns.get(threadId);
    const waiting = this.nativeReadbacks.get(threadId);
    const waitingRequest = waiting
      ? nativeInputRequestSchema.safeParse(waiting.input)
      : undefined;
    const waitingTurn = waitingRequest?.success
      ? waitingRequest.data.turnId
      : undefined;
    const turnStartPending = [...this.pending.values()].some((pending) => {
      if (pending.method !== "turn/start") return false;
      const params = z
        .object({ threadId: z.string() })
        .safeParse(pending.params);
      return params.success && params.data.threadId === threadId;
    });
    const ownsThreadState =
      activeTurn === turnId ||
      (activeTurn === undefined &&
        !turnStartPending &&
        (waiting === undefined || waitingTurn === turnId));
    this.cancelNativeTurn(threadId, turnId, reason);
    for (const endpoint of this.nativeEndpointsForTurn(threadId, turnId)) {
      endpoint.turnEnded = true;
      if (endpoint.outcomeRecorded && !endpoint.writeInFlight)
        this.retireNativeEndpoint(endpoint.call.identity);
    }
    if (waiting) {
      const request = nativeInputRequestSchema.safeParse(waiting.input);
      if (request.success && request.data.turnId === turnId) {
        waiting.invalid = true;
        this.nativeReadbacks.delete(threadId);
      }
    }
    const turnKey = `${threadId}:${turnId}`;
    this.invalidNativeTurns.delete(turnKey);
    if (this.nativeTurns.get(threadId) === turnId)
      this.nativeTurns.delete(threadId);
    if (ownsThreadState) {
      this.nativeQualifications.delete(threadId);
      this.nativeThreadSettings.delete(threadId);
      this.threadTools.delete(threadId);
    }
  }
  async replyUserInput(
    identity: NativeInputEndpointIdentity,
    reply: NativeInputReply,
    beforeWrite: () => RuntimeReplyIntent,
  ): Promise<void> {
    const endpoint = this.nativeEndpoints.get(nativeEndpointKey(identity));
    const child = this.child;
    if (
      !endpoint ||
      !child ||
      identity.runtimeGeneration !== this.currentUserInputGeneration() ||
      endpoint.state !== "pending"
    )
      throw new Error("Native endpoint unavailable");
    const encoded = encodeNativeInputReply(
      endpoint.call.request,
      reply.answers,
    );
    const line = `${JSON.stringify({ id: identity.requestId, result: encoded })}\n`;
    return await new Promise<void>((resolve, reject) => {
      try {
        const intent = beforeWrite();
        if (
          !intent.replyIntentId ||
          intent.answerDigest !== structuredAnswerDigest(encoded.answers)
        )
          throw new Error("Invalid native reply intent");
        if (
          endpoint.state !== "pending" ||
          this.child !== child ||
          identity.runtimeGeneration !== this.currentUserInputGeneration()
        )
          throw new Error("Native endpoint changed before write");
        endpoint.intent = { ...intent };
        endpoint.state = "writing";
        endpoint.writeInFlight = true;
        const orderedReceipt = {
          writeInitiated: ++endpoint.order,
        } as NonNullable<RuntimeUserInputOutcome["orderedReceipt"]>;
        endpoint.orderedReceipt = orderedReceipt;
        child.stdin.write(line, (error) => {
          endpoint.writeInFlight = false;
          if (
            error ||
            this.child !== child ||
            endpoint.state === "uncertain" ||
            endpoint.state === "unavailable"
          ) {
            if (
              (endpoint.state === "uncertain" ||
                endpoint.state === "unavailable") &&
              endpoint.outcomeRecorded
            )
              this.retireNativeEndpoint(endpoint.call.identity);
            else
              this.emitNative(
                endpoint,
                "uncertain",
                "Native write failed or endpoint lost",
              );
            reject(error ?? new Error("Native endpoint unavailable"));
            return;
          }
          orderedReceipt.stdinSucceeded = ++endpoint.order;
          this.emitNative(
            endpoint,
            endpoint.resolved ? "confirmed" : "sent-unconfirmed",
            endpoint.resolved
              ? "Matching resolution after successful stdin write"
              : "Successful stdin write; resolution pending",
          );
          resolve();
        });
      } catch (error) {
        endpoint.writeInFlight = false;
        if (endpoint.intent)
          this.emitNative(endpoint, "uncertain", "Native write failed");
        reject(error);
      }
    });
  }
  private async qualifyExecutable(
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.nativeExecutable = undefined;
    try {
      let executable = this.executable;
      if (!isAbsolute(executable)) {
        for (const directory of (environment.PATH ?? "").split(delimiter)) {
          try {
            await readFile(join(directory, executable));
            executable = join(directory, executable);
            break;
          } catch {}
        }
      }
      const { stdout } = await promisify(execFile)(executable, ["--version"], {
        env: environment,
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      });
      const executableHash = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
      if (
        stdout.trim() === "codex-cli 0.159.0" &&
        executableHash ===
          (this.options.qualifiedExecutableHash ??
            "e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a")
      )
        this.nativeExecutable = { codexVersion: stdout.trim(), executableHash };
    } catch {
      /* General runtime remains usable without native qualification. */
    }
  }
  private captureNativeQualification(threadId: string, input: unknown): void {
    this.nativeQualifications.delete(threadId);
    const parsed = z
      .object({
        thread: z.object({ id: z.literal(threadId) }),
        model: z.string().min(1),
        modelProvider: z.string().min(1),
        reasoningEffort: z.string().nullable(),
        serviceTier: z.string().nullable(),
        collaborationMode: z.object({
          mode: z.literal("default"),
          settings: z.object({
            model: z.string(),
            reasoning_effort: z.string().nullable(),
            developer_instructions: z.string().nullable(),
          }),
        }),
      })
      .safeParse(input);
    const startedSettings = this.nativeThreadSettings.get(threadId);
    if (!parsed.success || !this.nativeExecutable || !this.nativeGeneration)
      return;
    const data = parsed.data;
    if (
      data.collaborationMode.settings.model !== data.model ||
      data.collaborationMode.settings.reasoning_effort !== data.reasoningEffort
    )
      return;
    if (
      startedSettings &&
      ["model", "modelProvider", "reasoningEffort", "serviceTier"].some(
        (key) =>
          startedSettings[key as keyof typeof startedSettings] !==
          data[key as keyof typeof data],
      )
    )
      return;
    const definitions = this.threadTools.get(threadId);
    if (!definitions) return;
    const toolDigest = createHash("sha256")
      .update(JSON.stringify(definitions))
      .digest("hex");
    let prior: RuntimeThreadQualification | null;
    try {
      prior = this.options.safety.threadQualification(threadId);
    } catch {
      return;
    }
    if (!prior || prior.toolDigest !== toolDigest) return;
    const qualification = nativeInputQualificationSchema.safeParse({
      ...this.nativeExecutable,
      threadId,
      runtimeGeneration: this.nativeGeneration,
      mode: "default",
      model: data.model,
      modelProvider: data.modelProvider,
      reasoningEffort: data.reasoningEffort,
      serviceTier: data.serviceTier,
      developerInstructionsDigest: createHash("sha256")
        .update(
          JSON.stringify(
            data.collaborationMode.settings.developer_instructions,
          ),
        )
        .digest("hex"),
      continuation: "synchronous",
    });
    if (!qualification.success) return;
    const observed = {
      threadId,
      toolDigest,
      codexVersion: this.nativeExecutable.codexVersion,
      executableHash: this.nativeExecutable.executableHash,
      model: data.model,
      modelProvider: data.modelProvider,
      reasoningEffort: data.reasoningEffort,
      serviceTier: data.serviceTier,
      developerInstructionsDigest:
        qualification.data.developerInstructionsDigest,
    };
    const priorFacts = [
      prior.codexVersion,
      prior.executableHash,
      prior.model,
      prior.modelProvider,
      prior.reasoningEffort,
      prior.serviceTier,
      prior.developerInstructionsDigest,
    ];
    try {
      if (priorFacts.every((value) => value === null)) {
        if (!startedSettings) return;
        this.options.safety.recordThreadQualification(observed);
      } else if (
        JSON.stringify(priorFacts) !==
        JSON.stringify([
          observed.codexVersion,
          observed.executableHash,
          observed.model,
          observed.modelProvider,
          observed.reasoningEffort,
          observed.serviceTier,
          observed.developerInstructionsDigest,
        ])
      ) {
        return;
      }
    } catch {
      return;
    }
    this.nativeQualifications.set(threadId, qualification.data);
  }
  private receiveNativeRequest(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    input: unknown,
  ): boolean {
    try {
      boundedQuestionPayload(input);
      const request = nativeInputRequestSchema.parse(input);
      nativeInputEndpointIdentitySchema.shape.requestId.parse(id);
      const threadId = request.threadId;
      if (
        !this.nativeExecutable ||
        !this.nativeRequest ||
        !this.nativeGeneration
      )
        return false;
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const identity = {
        requestId: id,
        runtimeGeneration: this.nativeGeneration,
        threadId,
        turnId: request.turnId,
        itemId: request.itemId,
      };
      const knownRequest = this.nativeEndpointByRpcId(identity);
      const terminal = this.persistedTerminal(threadId, request.turnId);
      const history = this.options.safety.nativeEndpointHistory(identity);
      const prior = this.nativeReadbacks.get(threadId);
      // Resume retransmission can arrive after the operator has already answered.
      // It is the same request, never permission to expose or reply a second time.
      if (
        prior &&
        !prior.invalid &&
        prior.child === child &&
        child === this.child &&
        prior.id === id &&
        isDeepStrictEqual(prior.input, input) &&
        prior.requested &&
        prior.responded &&
        prior.replays === 0 &&
        knownRequest !== undefined &&
        nativeEndpointKey(knownRequest.call.identity) ===
          nativeEndpointKey(identity) &&
        history === "exact-identity-seen" &&
        this.nativeTurns.get(threadId) === request.turnId &&
        !this.invalidNativeTurns.has(`${threadId}:${request.turnId}`) &&
        terminal === null &&
        ["pending", "writing", "sent-unconfirmed", "confirmed"].includes(
          knownRequest.state,
        )
      ) {
        prior.replays++;
        return true;
      }
      const nativeReplay = {
        runtimeGeneration: this.nativeGeneration,
        requestId: id,
        itemId: request.itemId,
        paramsDigest: digest,
        originalParamsDigest: prior?.digest ?? knownRequest?.digest ?? null,
        endpointState: knownRequest?.state ?? null,
        acceptedReplays: prior?.replays ?? 0,
        identical: Boolean(
          prior && prior.id === id && isDeepStrictEqual(prior.input, input),
        ),
      };
      if (
        terminal !== null ||
        (history !== "new" && history !== "exact-identity-seen") ||
        (history === "exact-identity-seen" && !knownRequest) ||
        (knownRequest &&
          (knownRequest.state !== "pending" ||
            knownRequest.call.identity.turnId !== request.turnId ||
            knownRequest.call.identity.itemId !== request.itemId))
      ) {
        if (
          knownRequest &&
          ["pending", "writing", "sent-unconfirmed"].includes(
            knownRequest.state,
          )
        ) {
          this.cancelUserInput(
            knownRequest.call.identity,
            "Conflicting or late native replay",
          );
          const waiting = this.nativeReadbacks.get(threadId);
          if (
            waiting &&
            nativeInputRequestSchema.parse(waiting.input).turnId ===
              knownRequest.call.identity.turnId
          )
            waiting.invalid = true;
        }
        this.unexpected?.({
          method: "stale-native-input",
          nativeReplay,
          threadId,
          turnId: request.turnId,
        });
        return true;
      }
      if (prior) {
        const endpoint = this.nativeEndpointsForTurn(
          threadId,
          request.turnId,
        )[0];
        prior.invalid = true;
        if (endpoint)
          this.cancelUserInput(
            endpoint.call.identity,
            "Conflicting or repeated native request",
          );
        this.nativeQualifications.delete(threadId);
        this.unexpected?.({
          method: "conflicting-native-input",
          nativeReplay,
          threadId,
          turnId: request.turnId,
        });
        return true;
      }
      this.nativeReadbacks.set(threadId, {
        input,
        id,
        child,
        digest,
        requested: false,
        responded: false,
        replays: 0,
        invalid: false,
      });
      void this.qualifyNativeRequest(threadId);
      return true;
    } catch {
      return false;
    }
  }
  private async qualifyNativeRequest(threadId: string): Promise<void> {
    const pending = this.nativeReadbacks.get(threadId);
    if (!pending || pending.requested || !this.nativeTurns.has(threadId))
      return;
    pending.requested = true;
    try {
      const rawResponse = await this.request(
        "thread/resume",
        { threadId },
        () => {
          pending.responded = true;
        },
      );
      if (this.nativeReadbacks.get(threadId) !== pending)
        throw new Error("Native readback replaced");
      const resumed = thread.parse(rawResponse);
      if (resumed.thread.id !== threadId)
        throw new Error("Native resume identity mismatch");
      this.captureNativeQualification(threadId, rawResponse);
      const qualification = this.nativeQualifications.get(threadId);
      if (!qualification || pending.invalid || this.child !== pending.child)
        throw new Error("Native request unqualified");
      const request = parseNativeInputRequest(pending.input, qualification);
      if (
        this.nativeTurns.get(threadId) !== request.turnId ||
        this.persistedTerminal(threadId, request.turnId) !== null ||
        this.invalidNativeTurns.has(`${threadId}:${request.turnId}`)
      )
        throw new Error("Native turn unavailable");
      const identity = {
        requestId: pending.id,
        runtimeGeneration: qualification.runtimeGeneration,
        threadId,
        turnId: request.turnId,
        itemId: request.itemId,
      };
      if (this.options.safety.nativeEndpointHistory(identity) !== "new")
        throw new Error("Native endpoint history is not fresh");
      const call = { identity, request, qualification };
      this.addNativeEndpoint({
        call,
        digest: pending.digest,
        state: "pending",
        resolved: false,
        order: 0,
        writeInFlight: false,
        outcomeRecorded: false,
        turnEnded: false,
      });
      this.nativeRequest?.(call);
    } catch {
      if (this.nativeReadbacks.get(threadId) === pending)
        this.nativeQualifications.delete(threadId);
      const turnId = nativeInputRequestSchema.parse(pending.input).turnId;
      this.unexpected?.({
        method: "unqualified-native-input",
        threadId,
        ...(turnId ? { turnId } : {}),
      });
    }
  }
  private receiveNativeNotification(method: string, params: unknown): void {
    if (method === "serverRequest/resolved") {
      const parsed = z
        .object({
          threadId: z.string(),
          requestId: z.union([z.string(), z.number()]),
        })
        .safeParse(params);
      if (!parsed.success) return;
      const waiting = this.nativeReadbacks.get(parsed.data.threadId);
      const endpoint = this.nativeGeneration
        ? this.nativeEndpointByRpcId({
            requestId: parsed.data.requestId,
            runtimeGeneration: this.nativeGeneration,
            threadId: parsed.data.threadId,
            turnId: "",
            itemId: "",
          })
        : undefined;
      if (
        waiting &&
        waiting.child === this.child &&
        waiting.id === parsed.data.requestId &&
        !endpoint
      ) {
        waiting.invalid = true;
        this.unexpected?.({
          method: "native-resolution-before-qualification",
          threadId: parsed.data.threadId,
        });
        return;
      }
      if (endpoint) {
        if (endpoint.state === "pending")
          this.emitNative(
            endpoint,
            "unavailable",
            "Resolution before native write",
          );
        else if (endpoint.state === "writing") {
          if (!endpoint.resolved && endpoint.orderedReceipt)
            endpoint.orderedReceipt.matchingResolution = ++endpoint.order;
          endpoint.resolved = true;
        } else if (endpoint.state === "sent-unconfirmed") {
          if (endpoint.orderedReceipt)
            endpoint.orderedReceipt.matchingResolution = ++endpoint.order;
          this.emitNative(
            endpoint,
            "confirmed",
            "Matching resolution after successful stdin write",
          );
        }
        return;
      }
      this.unexpected?.({
        method: "unmatched-native-resolution",
        threadId: parsed.data.threadId,
      });
    }
    if (method === "item/started" || method === "item/completed") {
      const parsed = z
        .object({
          threadId: z.string(),
          turnId: z.string(),
          item: z.object({
            type: z.string(),
            delivery: z.unknown().optional(),
            questions: z.unknown().optional(),
            name: z.unknown().optional(),
          }),
        })
        .safeParse(params);
      if (parsed.success) {
        const { item, threadId, turnId } = parsed.data;
        if (
          item.delivery === "async" ||
          item.questions != null ||
          item.name === "request_user_input_async"
        ) {
          this.invalidNativeTurns.add(`${threadId}:${turnId}`);
          const waiting = this.nativeReadbacks.get(threadId);
          if (waiting) waiting.invalid = true;
          this.cancelNativeTurn(
            threadId,
            turnId,
            "Unqualified asynchronous input origin",
          );
          this.nativeQualifications.delete(threadId);
          this.unexpected?.({
            method: "unqualified-async-input",
            threadId,
            turnId,
          });
        }
      }
    }
  }
  private processIdentityValue: RuntimeProcessIdentity | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      beforeResolve?(value: unknown): void;
      timer: NodeJS.Timeout;
      method: string;
      params: unknown;
      processIdentity: RuntimeProcessIdentity | null;
    }
  >();
  private readonly events = new EventEmitter();
  private readonly failures = new Map<string, FailureEvidence>();
  private unexpected?: (request: UnexpectedRequest) => void;
  private toolCall?: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
  private readonly threadTools = new Map<
    string,
    readonly RuntimeToolDefinition[]
  >();
  private terminalAnomaly?: (anomaly: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private conversationEvent?: (event: RuntimeConversationEvent) => void;
  private readonly conversationTurns = new Map<
    string,
    PendingConversationTurn
  >();
  private conversationBufferBytes = 0;
  private conversationCaptureSaturated = false;
  private readonly overflowedConversationTurns = new Set<string>();
  private conversationOverflowIdentityCapExceeded = false;
  private failure: Error | undefined;

  private nativeTurnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private nativeRpcKey(identity: NativeInputEndpointIdentity): string {
    return JSON.stringify([
      identity.runtimeGeneration,
      identity.threadId,
      typeof identity.requestId,
      String(identity.requestId),
    ]);
  }

  private addNativeEndpoint(endpoint: NativeEndpoint): void {
    const key = nativeEndpointKey(endpoint.call.identity);
    this.nativeEndpoints.set(key, endpoint);
    const turnKey = this.nativeTurnKey(
      endpoint.call.identity.threadId,
      endpoint.call.identity.turnId,
    );
    const turnKeys =
      this.nativeEndpointsByTurn.get(turnKey) ?? new Set<string>();
    turnKeys.add(key);
    this.nativeEndpointsByTurn.set(turnKey, turnKeys);
    const rpcKey = this.nativeRpcKey(endpoint.call.identity);
    const rpcKeys =
      this.nativeEndpointsByRpcId.get(rpcKey) ?? new Set<string>();
    rpcKeys.add(key);
    this.nativeEndpointsByRpcId.set(rpcKey, rpcKeys);
  }

  private nativeEndpointByRpcId(
    identity: NativeInputEndpointIdentity,
  ): NativeEndpoint | undefined {
    const keys = this.nativeEndpointsByRpcId.get(this.nativeRpcKey(identity));
    if (!keys || keys.size === 0) return undefined;
    if (keys.size !== 1)
      throw new Error("Active native RPC identity is ambiguous");
    const key = keys.values().next().value as string | undefined;
    return key ? this.nativeEndpoints.get(key) : undefined;
  }

  private nativeEndpointsForTurn(
    threadId: string,
    turnId: string,
  ): NativeEndpoint[] {
    const keys = this.nativeEndpointsByTurn.get(
      this.nativeTurnKey(threadId, turnId),
    );
    if (!keys) return [];
    return [...keys]
      .map((key) => this.nativeEndpoints.get(key))
      .filter((endpoint): endpoint is NativeEndpoint => endpoint !== undefined);
  }

  private retireNativeEndpoint(identity: NativeInputEndpointIdentity): void {
    const key = nativeEndpointKey(identity);
    const endpoint = this.nativeEndpoints.get(key);
    if (!endpoint) return;
    this.nativeEndpoints.delete(key);
    const turnKey = this.nativeTurnKey(identity.threadId, identity.turnId);
    const turnKeys = this.nativeEndpointsByTurn.get(turnKey);
    turnKeys?.delete(key);
    if (turnKeys?.size === 0) this.nativeEndpointsByTurn.delete(turnKey);
    const rpcKey = this.nativeRpcKey(identity);
    const rpcKeys = this.nativeEndpointsByRpcId.get(rpcKey);
    rpcKeys?.delete(key);
    if (rpcKeys?.size === 0) this.nativeEndpointsByRpcId.delete(rpcKey);
  }

  private persistedTerminal(
    threadId: string,
    turnId: string,
  ): RuntimeTerminalEvidence | null {
    const generation = this.nativeGeneration;
    if (!generation) throw new Error("Runtime stopped");
    try {
      return this.options.safety.terminal(threadId, turnId, generation);
    } catch {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence could not be read",
      });
      throw new Error("Runtime terminal evidence unavailable");
    }
  }

  private terminalOutcome(
    threadId: string,
    turnId: string,
  ): "completed" | "failed" | null {
    const generation = this.nativeGeneration;
    if (!generation) throw new Error("Runtime stopped");
    let evidence: RuntimeTerminalEvidence | null;
    try {
      evidence = this.options.safety.terminalForWait(
        threadId,
        turnId,
        generation,
      );
    } catch {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence could not be verified for the bound turn",
      });
      throw new Error("Runtime terminal evidence unavailable");
    }
    if (!evidence) return null;
    if (
      evidence.workId === null ||
      evidence.conflicted ||
      evidence.firstStatus === null
    ) {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence is incomplete or conflicting",
      });
      throw new Error("Runtime terminal evidence is uncertain");
    }
    return evidence.firstStatus;
  }

  constructor(
    private readonly executable = "codex",
    private readonly options: {
      safety: RuntimeSafetyPort;
      spawnEnvironment?: () => NodeJS.ProcessEnv;
      /** Test-only executable identity for deterministic stdio fixtures. */
      qualifiedExecutableHash?: string;
      /** Test-only OS boundary for deterministic attached child identity. */
      captureProcessIdentity?: (
        pid: number | undefined,
      ) => Promise<RuntimeProcessIdentity | null>;
    },
  ) {}

  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void {
    this.unexpected = listener;
  }

  onToolCall(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void {
    this.toolCall = listener;
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

  onConversationEvent(
    listener: (event: RuntimeConversationEvent) => void,
  ): void {
    this.conversationEvent = listener;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Runtime already started");
    this.failure = undefined;
    this.failures.clear();
    this.clearConversationCaptures();
    const environment = this.options.spawnEnvironment?.() ?? process.env;
    this.nativeGeneration = randomUUID();
    this.nativeQualifications.clear();
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.threadTools.clear();
    this.nativeThreadSettings.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    const child = spawn(
      this.executable,
      [
        "app-server",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_mode=workspace-write",
      ],
      {
        stdio: "pipe",
        ...(this.options.spawnEnvironment
          ? { env: this.options.spawnEnvironment() }
          : {}),
      },
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
      await this.qualifyExecutable(environment);
      if (this.child !== child) throw new Error("Runtime stopped");
      this.processIdentityValue = await (
        this.options.captureProcessIdentity ?? captureProcessIdentity
      )(child.pid);
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.request("initialize", {
        clientInfo: { name: "ensemble", version: "0.1.0" },
        capabilities: { experimentalApi: true },
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
    for (const endpoint of [...this.nativeEndpoints.values()])
      this.cancelUserInput(endpoint.call.identity, "Runtime stopped");
    this.nativeGeneration = undefined;
    this.nativeQualifications.clear();
    this.child = undefined;
    this.processIdentityValue = null;
    this.fail(new Error("Runtime stopped"));
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.nativeThreadSettings.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    this.threadTools.clear();
    this.failures.clear();
    this.clearConversationCaptures();
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

  async startThread(
    workspace: string,
    tools: readonly RuntimeToolDefinition[] = [],
  ): Promise<string> {
    const definitions = registeredTools(tools);
    let rawResponse: unknown;
    const response = thread.parse(
      await this.request(
        "thread/start",
        {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          ephemeral: false,
          ...(definitions.length > 0 ? { dynamicTools: definitions } : {}),
        },
        (raw) => {
          rawResponse = raw;
          const started = thread.parse(raw);
          this.threadTools.set(started.thread.id, definitions);
        },
      ),
    );
    this.threadTools.set(response.thread.id, definitions);
    const toolDigest = createHash("sha256")
      .update(JSON.stringify(definitions))
      .digest("hex");
    try {
      this.options.safety.registerThreadTools(response.thread.id, toolDigest);
    } catch {
      this.threadTools.delete(response.thread.id);
      this.nativeThreadSettings.delete(response.thread.id);
      throw new Error("Runtime thread safety baseline unavailable");
    }
    const settings = z
      .object({
        model: z.string(),
        modelProvider: z.string(),
        reasoningEffort: z.string().nullable(),
        serviceTier: z.string().nullable(),
      })
      .safeParse(rawResponse);
    if (settings.success && this.nativeExecutable)
      this.nativeThreadSettings.set(response.thread.id, settings.data);
    return response.thread.id;
  }

  async resumeThread(
    threadId: string,
    tools?: readonly RuntimeToolDefinition[],
  ): Promise<void> {
    const definitions = registeredTools(
      tools ?? this.threadTools.get(threadId) ?? [],
    );
    const rawResponse = await this.request("thread/resume", {
      threadId,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ...(definitions.length > 0 ? { dynamicTools: definitions } : {}),
    });
    const resumed = thread.parse(rawResponse);
    if (resumed.thread.id !== threadId)
      throw new Error("Resumed thread identity mismatch");
    if (tools !== undefined || !this.threadTools.has(threadId))
      this.threadTools.set(threadId, definitions);
    this.captureNativeQualification(threadId, rawResponse);
  }

  async startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
  ): Promise<string> {
    // Retire only the ephemeral readback before a new turn can emit callbacks.
    // Saved endpoints/receipts and disqualified turn identities remain historical.
    const previousTurn = this.nativeTurns.get(threadId);
    if (previousTurn)
      this.retireNativeTurn(threadId, previousTurn, "New turn requested");
    else {
      this.nativeReadbacks.delete(threadId);
      this.nativeQualifications.delete(threadId);
    }
    const response = turn.parse(
      await this.request("turn/start", {
        threadId,
        cwd: workspace,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: executionPolicy(workspace),
      }),
    );
    this.nativeTurns.set(threadId, response.turn.id);
    if (this.persistedTerminal(threadId, response.turn.id) !== null)
      this.retireNativeTurn(
        threadId,
        response.turn.id,
        "Turn ended before native request qualification",
      );
    else void this.qualifyNativeRequest(threadId);
    return response.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.cancelNativeTurn(threadId, turnId, "Turn interrupted");
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
    const key = `${threadId}:${turnId}`;
    const evidence = this.failures.get(key);
    this.failures.delete(key);
    return evidence ? { ...evidence } : undefined;
  }

  async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    if (this.failure) throw this.failure;
    const observed = this.terminalOutcome(threadId, turnId);
    if (observed) return observed;
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
        try {
          const persisted = this.terminalOutcome(threadId, turnId);
          if (!persisted)
            throw new Error("Runtime terminal evidence is missing");
          resolve(persisted);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Runtime terminal evidence unavailable"),
          );
        }
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

  private request(
    method: string,
    params: unknown,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Runtime unavailable"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        params,
        processIdentity: this.processIdentityValue,
        ...(beforeResolve ? { beforeResolve } : {}),
      });
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
      if (
        method === "item/tool/requestUserInput" &&
        this.receiveNativeRequest(child, message.id, message.params)
      )
        return;
      if (method === "item/tool/call") {
        this.receiveToolCall(child, message.id, message.params);
        return;
      }
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
      if (message.error !== undefined) {
        const params = z
          .object({ threadId: z.string() })
          .safeParse(pending.params);
        const rejection = archivedResumeRejectionSchema.safeParse({
          method: pending.method,
          requestId: message.id,
          threadId: params.success ? params.data.threadId : undefined,
          processIdentity: pending.processIdentity,
          error: message.error,
        });
        pending.reject(
          rejection.success &&
            message.method === undefined &&
            message.params === undefined &&
            message.result === undefined
            ? new ArchivedResumeRejectedError(rejection.data)
            : new Error(JSON.stringify(message.error)),
        );
      } else {
        try {
          pending.beforeResolve?.(message.result);
          pending.resolve(message.result);
        } catch (error) {
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return;
    }
    if (message.method)
      this.receiveNativeNotification(message.method, message.params);
    if (message.method === "turn/completed") {
      const terminal = completedTurn.safeParse(message.params);
      if (!terminal.success) {
        this.terminalAnomaly?.({
          reason: "Missing terminal identity or status",
        });
      } else {
        const runtimeGeneration = this.nativeGeneration;
        if (!runtimeGeneration) {
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: "Terminal event has no current runtime generation",
          });
          this.failChild(
            child,
            new Error("Runtime terminal evidence unavailable"),
          );
          return;
        }
        const status =
          terminal.data.turn.status === "completed" ? "completed" : "failed";
        let evidence: RuntimeTerminalEvidence;
        try {
          evidence = this.options.safety.recordTerminal({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            status,
            runtimeGeneration,
          });
        } catch {
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: "Terminal status could not be durably recorded",
          });
          this.failChild(
            child,
            new Error("Runtime terminal evidence unavailable"),
          );
          return;
        }
        const key = `${terminal.data.threadId}:${terminal.data.turn.id}`;
        if (terminal.data.turn.status === "failed" && !this.failures.has(key))
          this.failures.set(
            key,
            makeFailureEvidence(
              terminal.data.threadId,
              terminal.data.turn.id,
              terminal.data.turn.error?.codexErrorInfo,
            ),
          );
        if (evidence.conflicted || evidence.firstStatus === null)
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: evidence.conflicted
              ? "Conflicting terminal status"
              : "Terminal status is unknown",
          });
        this.retireNativeTurn(
          terminal.data.threadId,
          terminal.data.turn.id,
          "Turn ended before native receipt",
        );
        this.finishConversationTurn(
          terminal.data.threadId,
          terminal.data.turn.id,
        );
      }
    }
    if (message.method)
      this.projectConversationEvent(message.method, message.params);
    // EventEmitter throws when an unhandled `error` event is emitted. Codex
    // uses this notification for progress such as reconnect retries; turn
    // completion remains the only terminal signal.
    if (message.method && message.method !== "error")
      this.events.emit(message.method, message.params);
  }

  private projectConversationEvent(method: string, params: unknown): void {
    if (method === "item/started") {
      const parsed = z
        .object({
          threadId: conversationIdentity,
          turnId: conversationIdentity,
          item: z.object({
            id: conversationIdentity,
            type: z.string().max(64),
          }),
        })
        .safeParse(params);
      if (!parsed.success || parsed.data.item.type !== "agentMessage") return;
      const { threadId, turnId, item } = parsed.data;
      const turn = this.conversationTurn(threadId, turnId, item.id);
      if (!turn || turn.truncated) return;
      if (turn.completedItems.has(item.id) || turn.items.has(item.id)) return;
      if (
        turn.totalItems >= maxConversationItemsPerTurn ||
        turn.items.size >= maxPendingConversationItems
      ) {
        this.truncateConversationTurn(threadId, turnId, turn, item.id);
        return;
      }
      turn.totalItems += 1;
      turn.items.set(item.id, {
        kind: "capturing",
        chunks: [],
        bytes: 0,
        fragments: 0,
      });
      this.emitConversationEvent({
        threadId,
        turnId,
        itemId: item.id,
        kind: "started",
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const parsed = z
        .object({
          threadId: conversationIdentity,
          turnId: conversationIdentity,
          itemId: conversationIdentity,
          delta: z.string(),
        })
        .safeParse(params);
      if (!parsed.success) return;
      const { threadId, turnId, itemId, delta } = parsed.data;
      const turn = this.conversationTurns.get(
        this.conversationTurnKey(threadId, turnId),
      );
      const item = turn?.items.get(itemId);
      if (!turn || turn.truncated || !item || item.kind !== "capturing") return;
      const bytes = Buffer.byteLength(delta, "utf8");
      if (bytes === 0) return;
      if (
        item.bytes + bytes > maxConversationItemBytes ||
        this.conversationBufferBytes + bytes > maxConversationBufferBytes ||
        item.fragments >= maxConversationFragmentsPerItem
      ) {
        this.conversationBufferBytes -= item.bytes;
        turn.items.set(itemId, { kind: "size-limit" });
        return;
      }
      item.chunks.push(delta);
      item.bytes += bytes;
      item.fragments += 1;
      this.conversationBufferBytes += bytes;
      this.emitConversationEvent({
        threadId,
        turnId,
        itemId,
        kind: "delta",
        bytes,
      });
      return;
    }

    if (method === "item/completed") {
      const parsed = z
        .object({
          threadId: conversationIdentity,
          turnId: conversationIdentity,
          item: z.object({
            id: conversationIdentity,
            type: z.string().max(64),
            text: z.unknown().optional(),
          }),
        })
        .safeParse(params);
      if (!parsed.success || parsed.data.item.type !== "agentMessage") return;
      const { threadId, turnId, item } = parsed.data;
      const turn = this.conversationTurn(threadId, turnId, item.id);
      if (!turn || turn.truncated) return;
      if (turn.completedItems.has(item.id)) return;
      const pending = turn.items.get(item.id);
      if (!pending && turn.totalItems >= maxConversationItemsPerTurn) {
        this.truncateConversationTurn(threadId, turnId, turn, item.id);
        return;
      }
      if (!pending) turn.totalItems += 1;
      turn.items.delete(item.id);
      turn.completedItems.add(item.id);
      this.releaseConversationItem(pending);
      if (typeof item.text === "string") {
        this.emitConversationText(threadId, turnId, item.id, item.text);
      } else if (pending?.kind === "size-limit") {
        this.emitConversationOmission(threadId, turnId, item.id, "size-limit");
      } else if (pending?.kind === "capturing") {
        if (pending.bytes > 0) {
          this.emitConversationText(
            threadId,
            turnId,
            item.id,
            pending.chunks.join(""),
          );
        } else {
          this.emitConversationOmission(
            threadId,
            turnId,
            item.id,
            "missing-text",
          );
        }
      } else {
        this.emitConversationOmission(
          threadId,
          turnId,
          item.id,
          "missing-text",
        );
      }
    }
  }

  private conversationTurn(
    threadId: string,
    turnId: string,
    itemId: string,
  ): PendingConversationTurn | undefined {
    const key = this.conversationTurnKey(threadId, turnId);
    try {
      if (this.persistedTerminal(threadId, turnId)) return undefined;
    } catch {
      return undefined;
    }
    const existing = this.conversationTurns.get(key);
    if (existing) return existing;
    if (this.conversationCaptureSaturated) {
      this.trackOverflowedConversationTurn(key);
      return undefined;
    }
    if (this.conversationTurns.size >= maxActiveConversationTurns) {
      this.conversationCaptureSaturated = true;
      this.trackOverflowedConversationTurn(key);
      this.emitConversationOmission(
        threadId,
        turnId,
        itemId,
        "active-turn-limit",
      );
      return undefined;
    }
    const turn: PendingConversationTurn = {
      items: new Map(),
      completedItems: new Set(),
      totalItems: 0,
      truncated: false,
    };
    this.conversationTurns.set(key, turn);
    return turn;
  }

  private conversationTurnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private finishConversationTurn(threadId: string, turnId: string): void {
    const key = this.conversationTurnKey(threadId, turnId);
    const turn = this.conversationTurns.get(key);
    const overflowed = this.overflowedConversationTurns.delete(key);
    if (!turn) {
      if (overflowed) this.maybeResumeConversationCapture();
      return;
    }
    for (const [itemId, item] of turn.items) {
      this.emitConversationOmission(
        threadId,
        turnId,
        itemId,
        item.kind === "size-limit" ? "size-limit" : "turn-ended",
      );
      this.releaseConversationItem(item);
    }
    this.conversationTurns.delete(key);
    this.maybeResumeConversationCapture();
  }

  private trackOverflowedConversationTurn(key: string): void {
    if (
      this.overflowedConversationTurns.has(key) ||
      this.conversationOverflowIdentityCapExceeded
    )
      return;
    if (this.overflowedConversationTurns.size >= maxActiveConversationTurns) {
      this.conversationOverflowIdentityCapExceeded = true;
      return;
    }
    this.overflowedConversationTurns.add(key);
  }

  private maybeResumeConversationCapture(): void {
    if (
      this.conversationTurns.size === 0 &&
      this.overflowedConversationTurns.size === 0 &&
      !this.conversationOverflowIdentityCapExceeded
    )
      this.conversationCaptureSaturated = false;
  }

  private truncateConversationTurn(
    threadId: string,
    turnId: string,
    turn: PendingConversationTurn,
    itemId: string,
  ): void {
    turn.truncated = true;
    for (const [pendingId, pending] of turn.items) {
      this.emitConversationOmission(threadId, turnId, pendingId, "item-limit");
      this.releaseConversationItem(pending);
    }
    turn.items.clear();
    turn.completedItems.clear();
    this.emitConversationOmission(threadId, turnId, itemId, "item-limit");
  }

  private releaseConversationItem(
    item: PendingConversationItem | undefined,
  ): void {
    if (item?.kind !== "capturing") return;
    this.conversationBufferBytes -= item.bytes;
  }

  private clearConversationCaptures(): void {
    this.conversationTurns.clear();
    this.conversationBufferBytes = 0;
    this.conversationCaptureSaturated = false;
    this.overflowedConversationTurns.clear();
    this.conversationOverflowIdentityCapExceeded = false;
  }

  private emitConversationText(
    threadId: string,
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    if (Buffer.byteLength(text, "utf8") > maxConversationItemBytes) {
      this.emitConversationOmission(threadId, turnId, itemId, "size-limit");
      return;
    }
    this.emitConversationEvent({
      threadId,
      turnId,
      itemId,
      kind: "completed",
      text,
    });
  }

  private emitConversationOmission(
    threadId: string,
    turnId: string,
    itemId: string,
    reason: Extract<RuntimeConversationEvent, { kind: "omitted" }>["reason"],
  ): void {
    this.emitConversationEvent({
      threadId,
      turnId,
      itemId,
      kind: "omitted",
      reason,
    });
  }

  private emitConversationEvent(event: RuntimeConversationEvent): void {
    try {
      this.conversationEvent?.(event);
    } catch {
      // History is diagnostic: a consumer failure must not alter runtime control.
    }
  }

  private receiveToolCall(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    params: unknown,
  ): void {
    const call = parseRuntimeToolCall(params);
    const definitions = call ? this.threadTools.get(call.threadId) : undefined;
    const registered = definitions?.some((tool) => tool.name === call?.tool);
    if (!call || !registered || !this.toolCall) {
      let holdFailed = false;
      try {
        this.unexpected?.(unexpectedRequest("item/tool/call", params));
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
          `${JSON.stringify({
            id,
            result: {
              contentItems: [{ type: "inputText", text: "not authorized" }],
              success: false,
            },
          })}\n`,
        ).then(
          () => {
            if (holdFailed) child.kill("SIGTERM");
          },
          (error: Error) => this.failChild(child, error),
        );
      return;
    }
    void this.dispatchToolCall(child, id, call);
  }

  private async dispatchToolCall(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    call: RuntimeToolCall,
  ): Promise<void> {
    let response: RuntimeToolResult;
    try {
      const rawResult = await this.toolCall?.(call);
      const parsed = runtimeToolResultSchema.safeParse(rawResult);
      response = parsed.success
        ? parsed.data
        : { text: "request failed", success: false };
    } catch {
      response = { text: "request failed", success: false };
    }
    if (this.child !== child) return;
    try {
      await this.send(
        `${JSON.stringify({
          id,
          result: {
            contentItems: [{ type: "inputText", text: response.text }],
            success: response.success,
          },
        })}\n`,
      );
    } catch (error) {
      this.failChild(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    for (const endpoint of [...this.nativeEndpoints.values()])
      this.cancelUserInput(endpoint.call.identity, "Runtime lost");
    this.nativeGeneration = undefined;
    this.nativeQualifications.clear();
    this.nativeThreadSettings.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    this.threadTools.clear();
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.failures.clear();
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.clearConversationCaptures();
    this.events.emit("failure", error);
    if (this.child?.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGTERM");
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child === child) this.fail(error);
  }
}
