import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "./temp.js";
import { test } from "node:test";
import type { DomainCommand, DomainStore } from "../src/core/domain.js";
import type { CoordinationStore } from "../src/core/coordination.js";
import { nativeEndpointKey } from "../src/core/structured-questions.js";
import type { NativeInputEndpointIdentity } from "../src/core/structured-questions.js";
import { CodexRuntime } from "../src/standalone/codex.js";
import type { RuntimeSpawnContext } from "../src/standalone/service.js";
import { StandaloneService } from "../src/standalone/service.js";
import { ExecutionState } from "../src/standalone/state.js";
import type { RuntimeProcessIdentity } from "../src/standalone/recovery-types.js";

const generation = "retention-generation";
const processIdentity: RuntimeProcessIdentity = {
  processId: "4242",
  processStartedAt: "retention-fixture-start",
  bootId: "retention-fixture-boot",
};
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

type RuntimeInternals = {
  child: ChildProcessWithoutNullStreams | undefined;
  nativeGeneration: string | undefined;
  nativeExecutable:
    | { codexVersion: string; executableHash: string }
    | undefined;
  threadSnapshots: Map<
    string,
    {
      tools?: readonly unknown[];
      settings?: Record<string, unknown>;
    }
  > & {
    settledStats(): {
      count: number;
      utf8Bytes: number;
      pinnedCount: number;
      pinnedUtf8Bytes: number;
    };
  };
  nativeTurns: Map<string, string>;
  nativeEndpoints: Map<string, unknown>;
  nativeEndpointsByTurn: Map<string, Set<string>>;
  nativeEndpointsByRpcId: Map<string, Set<string>>;
  invalidNativeTurns: Set<string>;
  nativeReadbacks: Map<string, unknown>;
  conversationTurns: Map<string, unknown>;
  pending: Map<string | number, unknown>;
  options: { safety: RuntimeSpawnContext["safety"] };
  receive(child: ChildProcessWithoutNullStreams, line: string): void;
  cancelUserInput(identity: NativeInputEndpointIdentity, reason: string): void;
  request(
    method: string,
    params: unknown,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown>;
};

type ServiceInternals = {
  db: import("node:sqlite").DatabaseSync;
  state: ExecutionState;
  domainState: DomainStore;
  coordination: CoordinationStore;
  nativeWaiters: Map<string, unknown>;
  callbacks: Map<string, Set<Promise<unknown>>>;
  active: Set<Promise<unknown>>;
  activeByWorkId: Map<string, Promise<unknown>>;
  backgroundRuns: Set<Promise<unknown>>;
  conversationCaptures: Map<string, unknown>;
  scheduler: { stop(): void };
};

function fixture(root: string, currentGeneration = generation) {
  let runtime: CodexRuntime | undefined;
  let safety: RuntimeSpawnContext["safety"] | undefined;
  let service!: StandaloneService;
  let resumeModel = "fixture-model";
  let startedThreadCount = 0;
  let startedTurnCount = 0;
  let turnStartRequestCount = 0;
  let failTurnStart = false;
  const requestThreads = new Map<
    string,
    { threadId: string; identity: NativeInputEndpointIdentity }
  >();
  let writeIntentObservations = 0;
  let writeIntentViolations = 0;
  const stdin = new PassThrough();
  const child = {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: () => true,
  } as unknown as ChildProcessWithoutNullStreams;
  stdin.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as
      | ((error: Error | null) => void)
      | undefined;
    const message = JSON.parse(String(chunk)) as {
      id?: string | number;
      method?: string;
      result?: unknown;
      params?: { threadId?: string };
    };
    if (message.id !== undefined && runtime) {
      const requestKey = String(message.id);
      const request = requestThreads.get(requestKey);
      if (message.result !== undefined && request) {
        writeIntentObservations++;
        const row = (
          service as unknown as ServiceInternals
        ).coordination.runtimeQuestionByEndpoint(request.identity);
        if (!row?.replyIntentId || row.deliveryState !== "sending")
          writeIntentViolations++;
      }
      const params = {
        threadId: request?.threadId ?? "retention-thread",
        requestId: message.id,
      };
      requestThreads.delete(requestKey);
      const internals = runtime as unknown as RuntimeInternals;
      internals.receive(
        child,
        JSON.stringify({ method: "serverRequest/resolved", params }),
      );
    }
    queueMicrotask(() => callback?.(null));
    return true;
  }) as typeof stdin.write;

  service = new StandaloneService(
    join(root, "data"),
    (context: RuntimeSpawnContext) => {
      safety = context.safety;
      runtime = new CodexRuntime("retention-fixture", context);
      const internals = runtime as unknown as RuntimeInternals;
      runtime.start = async () => {
        internals.child = child;
        internals.nativeGeneration = currentGeneration;
        internals.nativeExecutable = {
          codexVersion: "codex-cli 0.159.0",
          executableHash: "c".repeat(64),
        };
      };
      runtime.stop = async () => {
        internals.child = undefined;
      };
      runtime.processIdentity = () => processIdentity;
      internals.request = async (method, params, beforeResolve) => {
        if (method === "turn/start") {
          turnStartRequestCount++;
          if (failTurnStart) throw new Error("Synthetic turn startup failure");
          return {
            turn: { id: `retention-started-turn-${startedTurnCount++}` },
          };
        }
        const paramsThreadId = (params as { threadId?: string }).threadId;
        const threadId =
          method === "thread/start"
            ? `retention-start-thread-${startedThreadCount++}`
            : (paramsThreadId ?? "retention-thread");
        const response = {
          thread: { id: threadId },
          approvalPolicy: "never",
          sandbox: { type: "workspaceWrite" },
          model: resumeModel,
          modelProvider: "fixture-provider",
          reasoningEffort: null,
          serviceTier: null,
          collaborationMode: {
            mode: "default",
            settings: {
              model: resumeModel,
              reasoning_effort: null,
              developer_instructions: null,
            },
          },
        };
        beforeResolve?.(response);
        return response;
      };
      return runtime;
    },
    undefined,
    { power: { enabled: false }, github: { intervalMs: 60_000 } },
  );
  return {
    service,
    runtime: () => {
      assert.ok(runtime);
      return runtime;
    },
    child,
    associateRequest: (
      requestId: string | number,
      threadId: string,
      identity: NativeInputEndpointIdentity,
    ) => {
      requestThreads.set(String(requestId), { threadId, identity });
    },
    writeIntentEvidence: () => ({
      observations: writeIntentObservations,
      violations: writeIntentViolations,
    }),
    setResumeModel: (value: string) => {
      resumeModel = value;
    },
    setTurnStartFailure: (value: boolean) => {
      failTurnStart = value;
    },
    stageCounts: () => ({
      threadStarts: startedThreadCount,
      turnStartRequests: turnStartRequestCount,
      successfulTurnStarts: startedTurnCount,
    }),
    safety: () => {
      assert.ok(safety);
      return safety;
    },
    internals: () => service as unknown as ServiceInternals,
  };
}

function createTask(service: StandaloneService) {
  const { domainState } = service as unknown as ServiceInternals;
  const run = (command: WithoutKey<DomainCommand>) =>
    domainState.execute({
      ...command,
      key: randomUUID(),
    } as DomainCommand);
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfileId,
    name: "Retention lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfileId,
    name: "Retention worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Runtime retention fixture",
    leadProfileId,
  });
  run({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Native question retention",
    outcome: "Exercise service callbacks",
    ready: true,
  });
  run({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  domainState.ensureLeadAssignment(taskId);
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfileId],
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId: workerProfileId,
    brief: "Run native request retention fixture",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const assignment = domainState.assignment(assignmentId);
  return {
    projectId,
    taskId,
    assignmentId,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(assignment.instructionsRevision),
    profileRevision: Number(assignment.profileRevision),
  };
}

function nativeRequest(threadId: string, turnId: string, itemId: string) {
  return {
    threadId,
    turnId,
    itemId,
    isBlocking: false,
    autoResolutionMs: null,
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Choose one",
        isOther: false,
        isSecret: false,
        options: [{ label: "A", description: "Option A" }],
      },
    ],
  };
}

async function until(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createNativeWork(
  f: ReturnType<typeof fixture>,
  task: ReturnType<typeof createTask>,
  index: number,
  identity: Partial<{ threadId: string; turnId: string; workId: string }> = {},
) {
  const { state } = f.internals();
  const threadId = identity.threadId ?? `retention-native-thread-${index}`;
  const turnId = identity.turnId ?? `retention-native-turn-${index}`;
  const workId = identity.workId ?? `retention-native-work-${index}`;
  const intent = state.create(
    workId,
    "Synthetic native question retention turn",
    join("/tmp/runtime-retention-native", workId),
  );
  state.bindTask(workId, {
    taskId: task.taskId,
    assignmentId: task.assignmentId,
    assignmentVersion: task.assignmentVersion,
    instructionsRevision: task.instructionsRevision,
    profileRevision: task.profileRevision,
  });
  assert.equal(
    state.begin(intent.id, {
      projectId: task.projectId,
      requestSequence: index + 1,
      processIdentity,
    }),
    true,
  );
  assert.equal(state.bindThread(intent.id, threadId), true);
  assert.equal(state.bindTurn(intent.id, turnId, generation), true);
  const internals = f.runtime() as unknown as RuntimeInternals;
  internals.nativeTurns.set(threadId, turnId);
  internals.threadSnapshots.set(threadId, {
    settings: {
      model: "fixture-model",
      modelProvider: "fixture-provider",
      reasoningEffort: null,
      serviceTier: null,
    },
    tools: [],
  });
  f.safety().registerThreadTools(
    threadId,
    createHash("sha256").update("[]").digest("hex"),
  );
  return { intent, threadId, turnId, workId };
}

function settledRuntimeCounts(f: ReturnType<typeof fixture>) {
  const runtime = f.runtime() as unknown as RuntimeInternals;
  const service = f.internals();
  const state = service.state as unknown as {
    nativePrebindings: Map<string, unknown>;
  };
  return {
    nativeEndpoints: runtime.nativeEndpoints.size,
    endpointsByTurn: runtime.nativeEndpointsByTurn.size,
    endpointsByRpcId: runtime.nativeEndpointsByRpcId.size,
    threadSnapshots: runtime.threadSnapshots.size,
    nativeTurns: runtime.nativeTurns.size,
    invalidNativeTurns: runtime.invalidNativeTurns.size,
    readbacks: runtime.nativeReadbacks.size,
    failureEvidenceCache: 0,
    conversationTurns: runtime.conversationTurns.size,
    pendingRpc: runtime.pending.size,
    nativeWaiters: service.nativeWaiters.size,
    callbackWorkItems: service.callbacks.size,
    callbacks: [...service.callbacks.values()].reduce(
      (sum, entries) => sum + entries.size,
      0,
    ),
    active: service.active.size,
    activeByWorkId: service.activeByWorkId.size,
    backgroundRuns: service.backgroundRuns.size,
    conversationCaptures: service.conversationCaptures.size,
    nativePrebindings: state.nativePrebindings.size,
  };
}

function retainedUtf8Bytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "boolean")
    return Buffer.byteLength(String(value), "utf8");
  if (value === null || value === undefined || typeof value === "function")
    return 0;
  if (value instanceof Map) {
    let bytes = 0;
    for (const [key, item] of value)
      bytes += retainedUtf8Bytes(key, seen) + retainedUtf8Bytes(item, seen);
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 0;
    for (const item of value) bytes += retainedUtf8Bytes(item, seen);
    return bytes;
  }
  if (Array.isArray(value))
    return value.reduce(
      (bytes, item) => bytes + retainedUtf8Bytes(item, seen),
      0,
    );
  if (typeof value === "object") {
    if (seen.has(value)) return 0;
    seen.add(value);
    let bytes = 0;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "child",
          "resolve",
          "reject",
          "timer",
          "stdin",
          "stdout",
          "stderr",
        ].includes(key)
      )
        continue;
      bytes += Buffer.byteLength(key, "utf8") + retainedUtf8Bytes(item, seen);
    }
    return bytes;
  }
  return 0;
}

function runtimeCollectionSizes(f: ReturnType<typeof fixture>) {
  const runtime = f.runtime() as unknown as RuntimeInternals;
  const service = f.internals();
  const state = service.state as unknown as {
    nativePrebindings: Map<string, unknown>;
  };
  const map = (value: Map<unknown, unknown>) => ({
    count: value.size,
    utf8Bytes: retainedUtf8Bytes(value),
  });
  const set = (value: Set<unknown>) => ({
    count: value.size,
    utf8Bytes: retainedUtf8Bytes(value),
  });
  return {
    terminalCache: { count: 0, utf8Bytes: 0 },
    settledNativePayloadCache: { count: 0, utf8Bytes: 0 },
    nativeEndpoints: map(runtime.nativeEndpoints),
    endpointsByTurn: map(runtime.nativeEndpointsByTurn),
    endpointsByRpcId: map(runtime.nativeEndpointsByRpcId),
    threadSnapshots: map(runtime.threadSnapshots),
    nativeTurns: map(runtime.nativeTurns),
    invalidNativeTurns: set(runtime.invalidNativeTurns),
    readbacks: map(runtime.nativeReadbacks),
    failureEvidenceCache: { count: 0, utf8Bytes: 0 },
    conversationTurns: map(runtime.conversationTurns),
    pendingRpc: map(runtime.pending),
    serviceNativeWaiters: map(service.nativeWaiters),
    serviceCallbacks: map(service.callbacks),
    serviceActive: set(service.active),
    serviceActiveByWorkId: map(service.activeByWorkId),
    serviceBackgroundRuns: set(service.backgroundRuns),
    serviceConversationCaptures: map(service.conversationCaptures),
    stateNativePrebindings: map(state.nativePrebindings),
  };
}

function assertSettledRuntimeCounts(f: ReturnType<typeof fixture>): void {
  const counts = settledRuntimeCounts(f);
  for (const [name, count] of Object.entries(counts))
    assert.equal(count, 0, `${name} should retire after the turn settles`);
  const sizes = runtimeCollectionSizes(f);
  for (const [name, value] of Object.entries(sizes))
    assert.deepEqual(
      value,
      { count: 0, utf8Bytes: 0 },
      `${name} bytes should retire after settlement`,
    );
}

function summarizeTimings(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const at = (percentile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)
    ] ?? 0;
  return {
    iterations: sorted.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function timeIterations(count: number, action: (index: number) => void) {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    const started = process.hrtime.bigint();
    action(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return summarizeTimings(samples);
}

function seedTerminalRows(service: StandaloneService, count: number): void {
  const { db } = service as unknown as ServiceInternals;
  const insertIntent = db.prepare(`INSERT INTO execution_intents
    (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval)
    VALUES (?,?,? ,?,'completed',NULL,?,?,'chatgpt','workspaceWrite','never')`);
  const insertRecovery = db.prepare(`INSERT INTO execution_recovery_identities
    (workId,requestSequence,processId,processStartedAt,bootId,threadId,turnId,
      runtimeGeneration,terminalEvidenceObserved)
    VALUES (?,1,NULL,NULL,NULL,?,?,?,0)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const workId = `retention-work-${index}`;
      const turnId = `retention-turn-${index}`;
      const workspace =
        index < 2
          ? "/tmp/retention-conflict-workspace"
          : `/tmp/retention-${index}`;
      insertIntent.run(
        randomUUID(),
        workId,
        "synthetic retention turn",
        workspace,
        "retention-thread",
        turnId,
      );
      insertRecovery.run(workId, "retention-thread", turnId, generation);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function receiveTerminal(
  runtime: CodexRuntime,
  child: ChildProcessWithoutNullStreams,
  turnId: string,
  status: "completed" | "failed" = "completed",
  threadId = "retention-thread",
  errorCode?: string,
): void {
  (runtime as unknown as RuntimeInternals).receive(
    child,
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status,
          ...(status === "failed" && errorCode !== undefined
            ? { error: { codexErrorInfo: errorCode } }
            : {}),
        },
      },
    }),
  );
}

test("production adapter terminal evidence remains SQLite-backed past cache limits", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-retention-"));
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const count = 10_000;
    seedTerminalRows(f.service, count);
    const runtime = f.runtime();
    const db = (f.service as unknown as ServiceInternals).db;
    const collect = (globalThis as unknown as { gc?: () => void }).gc;
    const heapSamples: Array<{ settled: number; heapUsed: number }> = [];
    for (let index = 0; index < count; index++) {
      receiveTerminal(runtime, f.child, `retention-turn-${index}`);
      if (collect && (index + 1) % 5_000 === 0) {
        collect();
        heapSamples.push({
          settled: index + 1,
          heapUsed: process.memoryUsage().heapUsed,
        });
      }
    }
    const state = f.internals().state;
    assert.equal(
      state.runtimeTerminal(
        "retention-thread",
        `retention-turn-${count - 1}`,
        generation,
      )?.firstStatus,
      "completed",
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM runtime_terminal_evidence")
          .get() as {
          count: number;
        }
      ).count,
      count,
    );
    // Turn zero is beyond the 10k settled cohort. Its duplicate remains exact,
    // while an opposite report conflicts durably and retracts its workspace tail.
    receiveTerminal(runtime, f.child, "retention-turn-0", "completed");
    assert.equal(
      state.runtimeTerminal("retention-thread", "retention-turn-0", generation)
        ?.conflicted,
      false,
    );
    receiveTerminal(runtime, f.child, "retention-turn-0", "failed");
    assert.equal(
      state.runtimeTerminal("retention-thread", "retention-turn-0", generation)
        ?.conflicted,
      true,
    );
    assert.equal(state.byWorkId("retention-work-0")?.state, "held");
    assert.equal(state.byWorkId("retention-work-1")?.state, "held");
    assert.equal(
      state.byWorkId("retention-work-2")?.state,
      "completed",
      "retraction is limited to the conflicted workspace tail",
    );
    await assert.rejects(
      runtime.waitForTurn("retention-thread", "retention-turn-0"),
      /uncertain/,
    );
    assert.equal(
      runtime.failureEvidence("retention-thread", "retention-turn-0"),
      undefined,
      "conflicted durable failure evidence cannot authorize a retry",
    );
    assertSettledRuntimeCounts(f);

    const terminalPlan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT firstStatus FROM runtime_terminal_evidence
        WHERE threadId = ? AND turnId = ?`)
      .all("retention-thread", "retention-turn-0") as Array<{
      detail: string;
    }>;
    const terminalLookups = timeIterations(1_000, (index) => {
      assert.ok(
        state.runtimeTerminal(
          "retention-thread",
          `retention-turn-${index + 1}`,
          generation,
        ),
      );
    });
    const terminalStorage = db
      .prepare(`SELECT COUNT(*) AS count, SUM(
        LENGTH(CAST(threadId AS BLOB)) + LENGTH(CAST(turnId AS BLOB)) +
        LENGTH(CAST(COALESCE(firstStatus, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(workId, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(firstRuntimeGeneration, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(lastRuntimeGeneration, '') AS BLOB))
      ) AS utf8Bytes FROM runtime_terminal_evidence`)
      .get() as { count: number; utf8Bytes: number };
    console.log(
      `runtime-retention-terminal ${JSON.stringify({
        fixture: "actual-codex-runtime-receive-real-service-real-sqlite",
        rows: count,
        durableTerminalEvidence: terminalStorage,
        explicitGcAvailable: Boolean(collect),
        heapSamples,
        terminalLookup: terminalLookups,
        settledCollections: runtimeCollectionSizes(f),
        queryPlan: terminalPlan.map((row) => row.detail),
        conflict: {
          turnZero: state.runtimeTerminal(
            "retention-thread",
            "retention-turn-0",
            generation,
          ),
          writer: state.byWorkId("retention-work-0")?.state,
          workspaceSuccessor: state.byWorkId("retention-work-1")?.state,
          unrelated: state.byWorkId("retention-work-2")?.state,
        },
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unbound failed terminals retain exact retry facts only in durable evidence", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-failure-retention-"),
  );
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const runtime = f.runtime();
    const db = f.internals().db;
    const count = 1_024;
    for (let index = 0; index < count; index++)
      receiveTerminal(
        runtime,
        f.child,
        `unbound-failure-${index}`,
        "failed",
        "unbound-failure-thread",
        "serverOverloaded",
      );

    const unbound = f
      .internals()
      .state.runtimeTerminal(
        "unbound-failure-thread",
        "unbound-failure-0",
        generation,
      );
    assert.equal(unbound?.firstStatus, "failed");
    assert.equal(unbound?.failure?.classification, "transient");
    assert.equal(unbound?.workId, null);
    assert.equal(
      runtime.failureEvidence("unbound-failure-thread", "unbound-failure-0"),
      undefined,
      "an unbound receipt has no retry authority",
    );
    assert.equal(runtimeCollectionSizes(f).failureEvidenceCache.count, 0);

    const task = createTask(f.service);
    const early = {
      threadId: "retention-early-failure-thread",
      turnId: "retention-early-failure-turn",
    };
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "failed",
      early.threadId,
      "serverOverloaded",
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId),
      undefined,
    );
    const bound = createNativeWork(f, task, 50_000, {
      ...early,
      workId: "retention-early-failure-work",
    });
    assert.equal(bound.workId, "retention-early-failure-work");
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId)?.classification,
      "transient",
      "an early failure is classifiable after exact SQLite binding, without an adapter cache",
    );
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "failed",
      early.threadId,
      "unauthorized",
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId)?.reasonCode,
      "serverOverloaded",
      "a same-status duplicate cannot replace first failure facts",
    );
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "completed",
      early.threadId,
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId),
      undefined,
    );
    assert.equal(
      f
        .internals()
        .state.runtimeTerminal(early.threadId, early.turnId, generation)
        ?.conflicted,
      true,
    );

    const unknown = {
      threadId: "retention-unknown-failure-thread",
      turnId: "retention-unknown-failure-turn",
    };
    receiveTerminal(
      runtime,
      f.child,
      unknown.turnId,
      "failed",
      unknown.threadId,
      "not-a-codex-error-code",
    );
    createNativeWork(f, task, 50_001, {
      ...unknown,
      workId: "retention-unknown-failure-work",
    });
    assert.deepEqual(
      {
        classification: runtime.failureEvidence(
          unknown.threadId,
          unknown.turnId,
        )?.classification,
        reasonCode: runtime.failureEvidence(unknown.threadId, unknown.turnId)
          ?.reasonCode,
        source: runtime.failureEvidence(unknown.threadId, unknown.turnId)
          ?.source,
      },
      { classification: "unknown", reasonCode: "unknown", source: "missing" },
    );

    const stored = db
      .prepare(`SELECT COUNT(*) AS count,
        SUM(LENGTH(CAST(failureEvidence AS BLOB))) AS failureUtf8Bytes
        FROM runtime_terminal_evidence WHERE threadId = ?`)
      .get("unbound-failure-thread") as {
      count: number;
      failureUtf8Bytes: number;
    };
    assert.equal(stored.count, count);
    assert.ok(stored.failureUtf8Bytes > 0);
    console.log(
      `runtime-retention-failed-terminals ${JSON.stringify({
        fixture: "actual-codex-runtime-receive-real-service-real-sqlite",
        unboundNonconsumerRows: stored,
        adapterFailureEvidenceCache: { count: 0, utf8Bytes: 0 },
        earlyBoundClassification: "transient-first-fact",
        duplicatePreservedFirstFact: true,
        conflictedRetryEvidence: runtime.failureEvidence(
          early.threadId,
          early.turnId,
        ),
        unknownClassification: runtime.failureEvidence(
          unknown.threadId,
          unknown.turnId,
        ),
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("service bounds settled thread snapshots after held bindings and failed turn startup", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-thread-retention-"),
  );
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals()
      .db.prepare(
        "UPDATE scheduler_capacity_limits SET globalLimit = 256 WHERE singleton = 1",
      )
      .run();
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const baselineThread = await f.runtime().startThread(workspace, []);
    await f.runtime().resumeThread(baselineThread, []);
    const baseline = f
      .internals()
      .state.runtimeThreadQualification(baselineThread);
    assert.equal(baseline?.model, "fixture-model");
    f.setTurnStartFailure(true);
    await assert.rejects(
      f
        .runtime()
        .startTurn(baselineThread, workspace, "synthetic failed startup"),
      /Synthetic turn startup failure/,
    );
    f.setTurnStartFailure(false);
    assert.equal(runtime.nativeEndpoints.size, 0);

    const heldBindingWorkId = "retention-held-binding-work";
    let heldBindingThread: string | undefined;
    const originalStartThread = f.runtime().startThread.bind(f.runtime());
    f.runtime().startThread = async (...args) => {
      const threadId = await originalStartThread(...args);
      heldBindingThread = threadId;
      const intent = f.internals().state.byWorkId(heldBindingWorkId);
      assert.ok(intent);
      f.internals().state.hold(
        intent.id,
        "Synthetic hold after thread creation",
      );
      return threadId;
    };
    const heldWorkspace = join(root, "held-binding-workspace");
    mkdirSync(heldWorkspace);
    const heldBinding = await f.service.submit(
      heldBindingWorkId,
      "synthetic held binding",
      heldWorkspace,
    );
    f.runtime().startThread = originalStartThread;
    assert.equal(heldBinding.state, "held");
    assert.ok(heldBindingThread);
    assert.ok(runtime.threadSnapshots.has(heldBindingThread));
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 0);

    f.setTurnStartFailure(true);
    const failedStarts = 140;
    for (let index = 0; index < failedStarts; index++) {
      const failedWorkspace = join(root, `failed-start-workspace-${index}`);
      mkdirSync(failedWorkspace);
      const result = await f.service.submit(
        `retention-failed-start-${index}`,
        "synthetic failed turn start",
        failedWorkspace,
      );
      assert.equal(result.state, "held");
      assert.ok(result.threadId);
      assert.equal(result.turnId, null);
    }
    f.setTurnStartFailure(false);
    assert.deepEqual(f.stageCounts(), {
      threadStarts: failedStarts + 2,
      turnStartRequests: failedStarts + 1,
      successfulTurnStarts: 0,
    });
    const countStats = runtime.threadSnapshots.settledStats();
    assert.ok(countStats.count <= 128);
    assert.ok(countStats.utf8Bytes <= 256 * 1024);
    assert.equal(countStats.pinnedCount, 0);
    assert.equal(runtime.threadSnapshots.has(baselineThread), false);

    const largeThreads: string[] = [];
    const largeTools = (index: number) => [
      {
        type: "function" as const,
        name: `large-retention-tool-${index}`,
        description: "Large synthetic tool schema",
        inputSchema: {
          type: "object",
          description: "x".repeat(60_000),
        },
      },
    ];
    for (let index = 0; index < 5; index++)
      largeThreads.push(
        await f.runtime().startThread(workspace, largeTools(index)),
      );
    const byteStats = runtime.threadSnapshots.settledStats();
    assert.ok(byteStats.count < 128);
    assert.ok(byteStats.utf8Bytes <= 256 * 1024);
    assert.equal(byteStats.pinnedCount, 0);
    assert.equal(runtime.threadSnapshots.has(largeThreads[0]!), false);

    const activeThread = await f.runtime().startThread(workspace, []);
    const activeTurn = await f
      .runtime()
      .startTurn(activeThread, workspace, "synthetic active turn");
    assert.ok(runtime.threadSnapshots.has(activeThread));
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 1);
    await f.runtime().startThread(workspace, largeTools(6));
    const pinnedStats = runtime.threadSnapshots.settledStats();
    assert.ok(pinnedStats.count <= 128);
    assert.ok(pinnedStats.utf8Bytes <= 256 * 1024);
    assert.equal(pinnedStats.pinnedCount, 1);
    assert.ok(runtime.threadSnapshots.has(activeThread));
    receiveTerminal(
      f.runtime(),
      f.child,
      activeTurn,
      "completed",
      activeThread,
    );
    assert.equal(runtime.threadSnapshots.has(activeThread), false);
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 0);

    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "eviction preserves the exact durable first qualification",
    );
    await f.runtime().resumeThread(baselineThread, []);
    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "a matching resumed thread retains its exact durable first facts",
    );
    f.setResumeModel("different-model");
    await f.runtime().resumeThread(baselineThread, []);
    assert.equal(runtime.nativeEndpoints.size, 0);
    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "a changed current readback cannot overwrite the durable first settings",
    );

    console.log(
      `runtime-retention-thread-snapshots ${JSON.stringify({
        fixture: "production-codex-runtime-and-standalone-service-real-sqlite",
        heldBindingSnapshot: {
          created: true,
          pinnedAfterHold: false,
          retainedBeforeChurn: true,
        },
        failedTurnStartupCohort: failedStarts,
        afterCountChurn: countStats,
        afterByteChurn: byteStats,
        activeTurnPinDuringChurn: pinnedStats,
        nativeQualificationAfterEvictedSnapshot: "exact durable prior matched",
        changedReadback: "withheld without overwriting first facts",
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful resumes do not retain unused native qualifications", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-resume-qualification-retention-"),
  );
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = fixture(root);
  try {
    await f.service.start();
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const qualificationCount = 140;
    let durableFacts = 0;
    for (let index = 0; index < qualificationCount; index++) {
      const tools = [
        {
          type: "function" as const,
          name: `retention-resume-tool-${index}`,
          description: `Tool snapshot ${index}`,
          inputSchema: {
            type: "object",
            properties: { index: { type: "number" } },
          },
        },
      ];
      const threadId = await f.runtime().startThread(workspace, tools);
      await f.runtime().resumeThread(threadId, tools);
      const prior = f.internals().state.runtimeThreadQualification(threadId);
      assert.equal(prior?.model, "fixture-model");
      assert.equal(
        prior?.toolDigest,
        createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
      );
      durableFacts++;
    }

    const stats = runtime.threadSnapshots.settledStats();
    assert.equal(durableFacts, qualificationCount);
    assert.ok(stats.count <= 128);
    assert.ok(stats.utf8Bytes <= 256 * 1024);
    assert.equal(stats.pinnedCount, 0);
    assert.equal(runtime.nativeEndpoints.size, 0);
    assert.equal(runtime.nativeTurns.size, 0);
    assert.equal(runtime.nativeReadbacks.size, 0);
    assert.equal(
      Object.hasOwn(runtime, "nativeQualifications"),
      false,
      "validated resume facts are returned to their immediate consumer, not retained by thread",
    );
    const stored = f
      .internals()
      .db.prepare("SELECT COUNT(*) AS count FROM runtime_thread_qualification")
      .get() as { count: number };
    assert.equal(stored.count, qualificationCount);
    assert.deepEqual(f.stageCounts(), {
      threadStarts: qualificationCount,
      turnStartRequests: 0,
      successfulTurnStarts: 0,
    });
    console.log(
      `runtime-retention-unused-resume-qualifications ${JSON.stringify({
        fixture: "production-codex-adapter-and-standalone-service-real-sqlite",
        successfulThreadStartsAndResumes: qualificationCount,
        durableFirstFactsPreserved: durableFacts,
        turnsStarted: 0,
        nativeEndpoints: runtime.nativeEndpoints.size,
        threadSnapshotCache: stats,
        unownedQualificationMap: false,
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("service trims settled snapshots as concurrent failed turn-start owners release", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-thread-release-retention-"),
  );
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(workspaceRoot);
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals()
      .db.prepare(
        "UPDATE scheduler_capacity_limits SET globalLimit = 256 WHERE singleton = 1",
      )
      .run();

    const runtime = f.runtime();
    const internals = runtime as unknown as RuntimeInternals;
    const productionRequest = (
      Object.getPrototypeOf(runtime) as {
        request: RuntimeInternals["request"];
      }
    ).request.bind(runtime);
    internals.request = productionRequest;

    const pendingTurnStarts: Array<{
      id: number | string;
      threadId: string;
    }> = [];
    let threadStartCount = 0;
    const threadStartResult = (threadId: string) => ({
      thread: { id: threadId },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      model: "fixture-model",
      modelProvider: "fixture-provider",
      reasoningEffort: null,
      serviceTier: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fixture-model",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
    const stdin = f.child.stdin as unknown as PassThrough;
    stdin.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === "function") as
        | ((error: Error | null) => void)
        | undefined;
      const message = JSON.parse(String(chunk)) as {
        id?: number | string;
        method?: string;
        params?: { threadId?: string };
      };
      if (message.id !== undefined && message.method === "thread/start") {
        const threadId = `retention-release-thread-${threadStartCount++}`;
        queueMicrotask(() =>
          internals.receive(
            f.child,
            JSON.stringify({
              id: message.id,
              result: threadStartResult(threadId),
            }),
          ),
        );
      } else if (
        message.id !== undefined &&
        message.method === "turn/start" &&
        message.params?.threadId
      ) {
        pendingTurnStarts.push({
          id: message.id,
          threadId: message.params.threadId,
        });
      }
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof stdin.write;

    const largeTools = (index: number) => [
      {
        type: "function" as const,
        name: `release-retention-tool-${index}`,
        description: "Large synthetic tool schema",
        inputSchema: {
          type: "object",
          description: "x".repeat(100_000),
        },
      },
    ];
    const originalStartThread = runtime.startThread.bind(runtime);
    let toolSet = 0;
    runtime.startThread = async (workspace) =>
      originalStartThread(workspace, largeTools(toolSet++));

    const submissions = Array.from({ length: 4 }, (_, index) => {
      const workspace = join(workspaceRoot, String(index));
      mkdirSync(workspace);
      return f.service.submit(
        `retention-release-failed-start-${index}`,
        "synthetic concurrent turn startup",
        workspace,
      );
    });
    await until(
      () => pendingTurnStarts.length === 4,
      "four pending production turn/start requests",
    );

    const activeStats = internals.threadSnapshots.settledStats();
    assert.equal(activeStats.pinnedCount, 4);
    assert.ok(activeStats.pinnedUtf8Bytes > 256 * 1024);
    for (const pending of pendingTurnStarts)
      assert.ok(internals.threadSnapshots.has(pending.threadId));

    for (const pending of pendingTurnStarts)
      internals.receive(
        f.child,
        JSON.stringify({
          id: pending.id,
          error: { code: -32000, message: "Synthetic turn startup failure" },
        }),
      );
    const results = await Promise.all(submissions);

    assert.equal(threadStartCount, 4);
    assert.equal(pendingTurnStarts.length, 4);
    assert.equal(internals.pending.size, 0);
    assert.ok(results.every((result) => result.state === "held"));
    assert.ok(results.every((result) => result.turnId === null));
    const releasedStats = internals.threadSnapshots.settledStats();
    assert.ok(releasedStats.count <= 128);
    assert.ok(releasedStats.utf8Bytes <= 256 * 1024);
    assert.equal(releasedStats.pinnedCount, 0);
    console.log(
      `runtime-retention-thread-pin-release ${JSON.stringify({
        fixture:
          "production-runtime-rpc-response-and-standalone-service-real-sqlite",
        concurrentFailedTurnStarts: pendingTurnStarts.length,
        activeOwners: activeStats,
        ownersReleasedWithoutFurtherInsertion: true,
        serviceStates: results.map((result) => result.state),
        nativeQualificationAuthority:
          "none; held submissions have no endpoint or turn",
        afterRelease: releasedStats,
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production service settles 2,000 native waiters and callbacks with SQLite authority", {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-retention-native-"),
  );
  const f = fixture(root);
  let serviceToStop = f.service;
  let waitingTurn:
    | {
        threadId: string;
        turnId: string;
        result: Promise<"completed" | "failed">;
      }
    | undefined;
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const task = createTask(f.service);
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const coordination = f.internals().coordination;
    const count = 2_000;
    const cohortSize = 250;
    const cohorts: Array<{ settled: number; elapsedMs: number }> = [];
    const collect = (globalThis as unknown as { gc?: () => void }).gc;
    const heapSamples: Array<{ settled: number; heapUsed: number }> = [];
    const started = process.hrtime.bigint();
    let activePins:
      | {
          rawRequestBytes: number;
          endpoints: number;
          endpointTurnIndexes: number;
          endpointRpcIndexes: number;
          readbacks: number;
          nativeTurns: number;
          threadSnapshots: number;
          serviceWaiters: number;
          callbackWorkItems: number;
          callbacks: number;
        }
      | undefined;
    let activeCollections:
      | ReturnType<typeof runtimeCollectionSizes>
      | undefined;
    for (let index = 0; index < count; index++) {
      const work = createNativeWork(f, task, index);
      const requestId = index + 1;
      const itemId = `retention-native-item-${index}`;
      const request = nativeRequest(work.threadId, work.turnId, itemId);
      const identity: NativeInputEndpointIdentity = {
        requestId,
        runtimeGeneration: generation,
        threadId: work.threadId,
        turnId: work.turnId,
        itemId,
      };
      const endpointKey = nativeEndpointKey(identity);
      f.associateRequest(requestId, work.threadId, identity);
      runtime.receive(
        f.child,
        JSON.stringify({
          id: requestId,
          method: "item/tool/requestUserInput",
          params: request,
        }),
      );
      await until(
        () => Boolean(coordination.runtimeQuestionByEndpoint(identity)),
        `durable native question ${index}`,
      );
      const question = coordination.runtimeQuestionByEndpoint(identity);
      assert.ok(question);
      assert.ok(f.internals().nativeWaiters.has(endpointKey));
      assert.equal(f.internals().callbacks.get(work.workId)?.size, 1);
      if (index === 0) {
        activeCollections = runtimeCollectionSizes(f);
        activePins = {
          rawRequestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
          endpoints: runtime.nativeEndpoints.size,
          endpointTurnIndexes: runtime.nativeEndpointsByTurn.size,
          endpointRpcIndexes: runtime.nativeEndpointsByRpcId.size,
          readbacks: runtime.nativeReadbacks.size,
          nativeTurns: runtime.nativeTurns.size,
          threadSnapshots: runtime.threadSnapshots.size,
          serviceWaiters: f.internals().nativeWaiters.size,
          callbackWorkItems: f.internals().callbacks.size,
          callbacks: [...f.internals().callbacks.values()].reduce(
            (sum, entries) => sum + entries.size,
            0,
          ),
        };
        assert.ok(activePins.rawRequestBytes > 0);
        for (const key of [
          "endpoints",
          "endpointTurnIndexes",
          "endpointRpcIndexes",
          "readbacks",
          "nativeTurns",
          "threadSnapshots",
          "serviceWaiters",
          "callbackWorkItems",
          "callbacks",
        ] as const)
          assert.equal(
            activePins[key],
            1,
            `${key} remains pinned while awaiting the operator`,
          );
      }

      await f.service.coordinationView().answerRuntimeQuestion({
        taskId: task.taskId,
        key: randomUUID(),
        interactionId: question.interactionId,
        expectedRevision: question.revision,
        answers: { q: { answers: ["A"] } },
      });
      await until(() => {
        const current = coordination.runtimeQuestionByEndpoint(identity);
        return (
          current?.deliveryState === "confirmed" &&
          !f.internals().nativeWaiters.has(endpointKey) &&
          !f.internals().callbacks.has(work.workId)
        );
      }, `confirmed reply and callback retirement ${index}`);
      const saved = coordination.runtimeQuestionByEndpoint(identity);
      assert.equal(saved?.deliveryState, "confirmed");
      assert.ok(saved?.replyIntentId);

      const turnResult = f.runtime().waitForTurn(work.threadId, work.turnId);
      waitingTurn = {
        threadId: work.threadId,
        turnId: work.turnId,
        result: turnResult,
      };
      receiveTerminal(
        f.runtime(),
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      assert.equal(await turnResult, "completed");
      waitingTurn = undefined;
      f.internals().state.complete(work.intent.id, work.threadId, work.turnId);

      if ((index + 1) % cohortSize === 0) {
        assertSettledRuntimeCounts(f);
        const settled = index + 1;
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        cohorts.push({ settled, elapsedMs });
        const questionCount = (
          f
            .internals()
            .db.prepare(
              "SELECT COUNT(*) AS count FROM coordination_runtime_questions",
            )
            .get() as { count: number }
        ).count;
        assert.equal(questionCount, settled);
        if (collect && settled % 1_000 === 0) {
          collect();
          heapSamples.push({
            settled,
            heapUsed: process.memoryUsage().heapUsed,
          });
        }
      }
    }

    const db = f.internals().db;
    const replyRows = db
      .prepare(
        "SELECT replyIntentId, deliveryState FROM coordination_runtime_questions",
      )
      .all() as Array<{
      replyIntentId: string | null;
      deliveryState: string;
    }>;
    assert.equal(replyRows.length, count);
    assert.ok(
      replyRows.every(
        (row) => row.replyIntentId && row.deliveryState === "confirmed",
      ),
    );
    assert.equal(
      new Set(replyRows.map((row) => row.replyIntentId)).size,
      count,
    );
    assert.deepEqual(f.writeIntentEvidence(), {
      observations: count,
      violations: 0,
    });
    assertSettledRuntimeCounts(f);
    const questionRows = db
      .prepare(`SELECT identityJson, requestJson, qualificationJson, answerJson,
          answerDigest, replyIntentId FROM coordination_runtime_questions ORDER BY rowid`)
      .all() as Array<Record<string, string | null>>;
    const durableQuestionBytes = questionRows.reduce(
      (sum, row) =>
        sum +
        Object.values(row).reduce(
          (bytes, value) =>
            bytes + (value ? Buffer.byteLength(value, "utf8") : 0),
          0,
        ),
      0,
    );
    const durableQualification = f
      .internals()
      .db.prepare(`SELECT COUNT(*) AS count, SUM(
          LENGTH(CAST(threadId AS BLOB)) + LENGTH(CAST(COALESCE(toolDigest, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(codexVersion, '') AS BLOB)) + LENGTH(CAST(COALESCE(executableHash, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(model, '') AS BLOB)) + LENGTH(CAST(COALESCE(modelProvider, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(reasoningEffort, '') AS BLOB)) + LENGTH(CAST(COALESCE(serviceTier, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(developerInstructionsDigest, '') AS BLOB))
        ) AS utf8Bytes FROM runtime_thread_qualification`)
      .get() as { count: number; utf8Bytes: number };
    const terminalLookups = timeIterations(1_000, (index) => {
      assert.ok(
        f
          .internals()
          .state.runtimeTerminal(
            `retention-native-thread-${index + 1}`,
            `retention-native-turn-${index + 1}`,
            generation,
          ),
      );
    });
    const nativeLookups = timeIterations(1_000, (index) => {
      const identity: NativeInputEndpointIdentity = {
        requestId: index + 1,
        runtimeGeneration: generation,
        threadId: `retention-native-thread-${index}`,
        turnId: `retention-native-turn-${index}`,
        itemId: `retention-native-item-${index}`,
      };
      assert.ok(coordination.runtimeQuestionByEndpoint(identity));
    });
    const directCancellation = timeIterations(1_000, (index) => {
      runtime.cancelUserInput(
        {
          requestId: index + 1,
          runtimeGeneration: generation,
          threadId: `retention-native-thread-${index + 1}`,
          turnId: `retention-native-turn-${index + 1}`,
          itemId: `retention-native-item-${index + 1}`,
        },
        "retention lookup of settled endpoint",
      );
    });
    const nativePlan = f
      .internals()
      .db.prepare(`EXPLAIN QUERY PLAN SELECT interactionId FROM coordination_runtime_questions
          WHERE endpointKey = ?`)
      .all(
        nativeEndpointKey({
          requestId: 1,
          runtimeGeneration: generation,
          threadId: "retention-native-thread-0",
          turnId: "retention-native-turn-0",
          itemId: "retention-native-item-0",
        }),
      ) as Array<{ detail: string }>;
    const terminalPlan = f
      .internals()
      .db.prepare(`EXPLAIN QUERY PLAN SELECT firstStatus FROM runtime_terminal_evidence
          WHERE threadId = ? AND turnId = ?`)
      .all("retention-native-thread-0", "retention-native-turn-0") as Array<{
      detail: string;
    }>;

    await f.service.stop();
    const reopened = fixture(root, "retention-generation-restarted");
    serviceToStop = reopened.service;
    await reopened.service.start();
    const firstIdentity: NativeInputEndpointIdentity = {
      requestId: 1,
      runtimeGeneration: generation,
      threadId: "retention-native-thread-0",
      turnId: "retention-native-turn-0",
      itemId: "retention-native-item-0",
    };
    assert.equal(
      reopened.internals().coordination.runtimeQuestionByEndpoint(firstIdentity)
        ?.deliveryState,
      "confirmed",
      "confirmed durable answer survives a production service restart",
    );
    assert.equal(
      reopened.runtime().currentUserInputGeneration(),
      "retention-generation-restarted",
    );
    assert.equal(
      reopened
        .internals()
        .state.runtimeTerminal(
          "retention-native-thread-0",
          "retention-native-turn-0",
          generation,
        )?.firstStatus,
      "completed",
    );
    assertSettledRuntimeCounts(reopened);
    assert.ok(activePins);
    console.log(
      `runtime-retention-native ${JSON.stringify({
        fixture: "synthetic-child-injected-receive-real-service-real-sqlite",
        count,
        cohortSize,
        cohorts,
        explicitGcAvailable: Boolean(collect),
        heapSamples,
        activePins,
        activeCollections,
        settledCollections: runtimeCollectionSizes(reopened),
        settledRuntime: settledRuntimeCounts(reopened),
        durableRows: questionRows.length,
        durableQuestionBytes,
        durableQualification,
        measurementHarness: {
          questionRowsMaterialized: questionRows.length,
          questionPayloadBytes: durableQuestionBytes,
          timingSamplesPerOperation: 1_000,
          timingSampleStoragePeak: 1_000,
        },
        terminalLookup: terminalLookups,
        nativeLookup: nativeLookups,
        settledDirectCancellationLookup: directCancellation,
        queryPlans: {
          terminal: terminalPlan.map((row) => row.detail),
          nativeEndpoint: nativePlan.map((row) => row.detail),
        },
        runtime: {
          version: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
        restart: {
          generationChanged: true,
          confirmedQuestionStayedConfirmed: true,
          oldTerminalRemainedReadable: true,
        },
        writeIntentEvidence: f.writeIntentEvidence(),
      })}`,
    );
  } finally {
    if (waitingTurn) {
      receiveTerminal(
        f.runtime(),
        f.child,
        waitingTurn.turnId,
        "completed",
        waitingTurn.threadId,
      );
      await Promise.race([
        waitingTurn.result,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Timed out settling fixture turn")),
            2_000,
          ),
        ),
      ]).catch(() => {});
    }
    await serviceToStop.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed or missing legacy native qualification facts stay unqualified", {
  timeout: 20_000,
}, async () => {
  for (const mode of [
    "changed-settings",
    "missing-legacy-settings",
    "changed-tools",
  ] as const) {
    const root = mkdtempSync(
      join(tmpdir(), `ensemble-runtime-retention-${mode}-`),
    );
    const f = fixture(root);
    try {
      await f.service.start();
      f.internals().scheduler.stop();
      const task = createTask(f.service);
      const work = createNativeWork(f, task, 20_000);
      const runtime = f.runtime() as unknown as RuntimeInternals;
      if (mode === "changed-settings") f.setResumeModel("different-model");
      if (mode === "missing-legacy-settings") {
        const snapshot = runtime.threadSnapshots.get(work.threadId);
        assert.ok(snapshot);
        runtime.threadSnapshots.set(
          work.threadId,
          snapshot.tools === undefined ? {} : { tools: snapshot.tools },
        );
      }
      if (mode === "changed-tools")
        runtime.threadSnapshots.set(work.threadId, {
          settings: {
            model: "fixture-model",
            modelProvider: "fixture-provider",
            reasoningEffort: null,
            serviceTier: null,
          },
          tools: [
            {
              type: "function",
              name: "changed-tool",
              description: "Changed tool",
              inputSchema: { type: "object" },
            },
          ],
        });
      const identity: NativeInputEndpointIdentity = {
        requestId: 20_000,
        runtimeGeneration: generation,
        threadId: work.threadId,
        turnId: work.turnId,
        itemId: "retention-unqualified-item",
      };
      runtime.receive(
        f.child,
        JSON.stringify({
          id: identity.requestId,
          method: "item/tool/requestUserInput",
          params: nativeRequest(
            identity.threadId,
            identity.turnId,
            identity.itemId,
          ),
        }),
      );
      await until(
        () => f.internals().state.byWorkId(work.workId)?.state === "held",
        `${mode} to fail closed at the service boundary`,
      );
      assert.equal(
        f.internals().coordination.runtimeQuestionByEndpoint(identity),
        undefined,
        `${mode} must not persist a qualified question`,
      );
      assert.equal(f.internals().nativeWaiters.size, 0);
      assert.equal(f.internals().callbacks.size, 0);
      assert.equal(runtime.nativeEndpoints.size, 0);
      receiveTerminal(
        f.runtime(),
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      assertSettledRuntimeCounts(f);
    } finally {
      await f.service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("missing, corrupt, and failed terminal evidence storage never authorizes turn completion", {
  timeout: 20_000,
}, async () => {
  for (const mode of [
    "missing-expected",
    "corrupt-row",
    "write-failure",
  ] as const) {
    const root = mkdtempSync(
      join(tmpdir(), `ensemble-runtime-retention-${mode}-`),
    );
    const f = fixture(root);
    try {
      await f.service.start();
      f.internals().scheduler.stop();
      const task = createTask(f.service);
      const work = createNativeWork(f, task, 30_000);
      const runtime = f.runtime();
      const db = f.internals().db;
      if (mode === "write-failure")
        db.exec(`CREATE TRIGGER reject_terminal_receipt
            BEFORE INSERT ON runtime_terminal_evidence
            BEGIN SELECT RAISE(ABORT, 'injected terminal receipt write failure'); END`);
      const terminalWait = runtime.waitForTurn(work.threadId, work.turnId);
      receiveTerminal(
        runtime,
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      if (mode === "write-failure") {
        await assert.rejects(
          terminalWait,
          /Runtime terminal evidence unavailable/,
        );
      } else {
        assert.equal(await terminalWait, "completed");
        if (mode === "missing-expected")
          db.prepare(
            "DELETE FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
          ).run(work.threadId, work.turnId);
        else {
          db.exec("PRAGMA ignore_check_constraints = ON");
          db.prepare(`UPDATE runtime_terminal_evidence SET firstStatus = 'corrupt'
              WHERE threadId = ? AND turnId = ?`).run(
            work.threadId,
            work.turnId,
          );
          db.exec("PRAGMA ignore_check_constraints = OFF");
          assert.throws(() =>
            f
              .internals()
              .state.runtimeTerminal(work.threadId, work.turnId, generation),
          );
        }
        const failedWait = runtime.waitForTurn(work.threadId, work.turnId);
        receiveTerminal(
          runtime,
          f.child,
          work.turnId,
          "completed",
          work.threadId,
        );
        await assert.rejects(
          failedWait,
          /Runtime terminal evidence unavailable/,
        );
      }
      assert.equal(
        f.internals().state.byWorkId(work.workId)?.state,
        "held",
        `${mode} must retain ownership uncertainty`,
      );
      assert.equal(runtime.currentUserInputGeneration(), undefined);
      assertSettledRuntimeCounts(f);
    } finally {
      await f.service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy bound turns migrate to unknown evidence and cannot complete", {
  timeout: 10_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-retention-legacy-"),
  );
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const task = createTask(f.service);
    const work = createNativeWork(f, task, 40_000);
    const db = f.internals().db;
    db.prepare(
      "DELETE FROM runtime_retention_migrations WHERE migrationId = ?",
    ).run("runtime-retention-v1");
    db.prepare(
      "DELETE FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
    ).run(work.threadId, work.turnId);
    const migratedState = new ExecutionState(db);
    const unknown = migratedState.runtimeTerminal(
      work.threadId,
      work.turnId,
      generation,
    );
    assert.equal(unknown?.firstStatus, null);
    assert.equal(unknown?.conflicted, false);
    assert.equal(unknown?.workId, work.workId);
    await assert.rejects(
      f.runtime().waitForTurn(work.threadId, work.turnId),
      /uncertain/,
    );
    assert.equal(
      f.internals().state.byWorkId(work.workId)?.state,
      "held",
      "legacy intent state cannot be promoted to observed completion",
    );
    receiveTerminal(
      f.runtime(),
      f.child,
      work.turnId,
      "completed",
      work.threadId,
    );
    const afterLateEvent = migratedState.runtimeTerminal(
      work.threadId,
      work.turnId,
      generation,
    );
    assert.equal(afterLateEvent?.firstStatus, null);
    assert.equal(afterLateEvent?.conflicted, true);
    assert.equal(f.internals().state.byWorkId(work.workId)?.state, "held");
    assertSettledRuntimeCounts(f);
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
