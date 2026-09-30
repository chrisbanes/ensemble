import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RecoveryRecord,
  RecoveryReceipt,
  RuntimeProcessIdentity,
  TerminationVerifier,
  TerminationVerification,
} from "../src/standalone/recovery-types.js";

interface RecoveryApi {
  recoveryView(): RecoveryRecord[];
  resolveHeldExecution(receipt: RecoveryReceipt): Promise<{
    id: string;
    workId: string;
    state: "reconciled";
  }>;
}

interface ServiceOptions {
  supervisor?: {
    clock: {
      monotonicNow(): number;
      sleep(ms: number, signal: AbortSignal): Promise<void>;
    };
    observationMs: number;
  };
  terminationVerifier?: TerminationVerifier;
}

function recoveryApi(service: StandaloneService): RecoveryApi {
  return service as unknown as RecoveryApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

class RecoveryRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: "codex-pid-1001",
    processStartedAt: "2026-09-29T09:00:00.000Z",
    bootId: "boot-before-restart",
  };
  threads = 0;
  turns = 0;
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly inspections: ExactExecutionIdentity[] = [];
  inspection:
    | ((identity: ExactExecutionIdentity) => ExecutionInspection)
    | undefined;
  turnStartGate: Promise<string> | undefined;
  readonly turnStartEntered = deferred<void>();
  readonly turnEntered = deferred<void>();
  readonly turnGate = deferred<void>();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  private currentThreadId = "";
  private currentTurnId = "";

  async start() {}

  async stop() {
    this.turnGate.resolve();
    this.turnStartGate = Promise.resolve("late-turn");
  }

  processIdentity() {
    return this.process;
  }

  async inspectExecution(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    this.inspections.push(identity);
    return (
      this.inspection?.(identity) ?? {
        kind: "unknown",
        reason: "Inspector supplied no proof",
      }
    );
  }

  async startThread() {
    this.currentThreadId = `thread-${++this.threads}`;
    return this.currentThreadId;
  }

  async resumeThread(threadId: string) {
    this.currentThreadId = threadId;
  }

  async startTurn() {
    this.turnStartEntered.resolve();
    this.currentTurnId = this.turnStartGate
      ? "late-turn"
      : `turn-${++this.turns}`;
    return this.turnStartGate ?? this.currentTurnId;
  }

  async interruptTurn(threadId: string, turnId: string) {
    this.interrupts.push({ threadId, turnId });
  }

  async waitForTurn() {
    await this.toolCall?.({
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
      callId: `fixture-question-${this.currentThreadId}-${this.currentTurnId}`,
      tool: "ensemble_ask_question",
      arguments: { question: "Recovery fixture is waiting for the next step" },
    });
    this.turnEntered.resolve();
    await this.turnGate.promise;
    return "completed" as const;
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }
}

class ManualClock {
  now = 0;
  readonly sleepEntered = deferred<void>();
  private advanceSleep: (() => void) | undefined;

  monotonicNow() {
    return this.now;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      this.sleepEntered.resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.now += ms;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.advanceSleep = finish;
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }

  advance(ms: number) {
    this.advanceSleep?.();
    this.now = Math.max(this.now, ms);
  }
}

async function activeFixture(
  options?: ServiceOptions & { holdTurnStart?: boolean },
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-recovery-"));
  const dataDir = join(root, "data");
  const runtime = new RecoveryRuntime();
  const turnStartResponse = options?.holdTurnStart
    ? deferred<string>()
    : undefined;
  if (turnStartResponse) runtime.turnStartGate = turnStartResponse.promise;
  const ServiceWithOptions = StandaloneService as unknown as new (
    dataDir: string,
    runtimeFactory: () => Runtime,
    markerWriter?: (path: string, flag: "wx" | "w") => void,
    options?: ServiceOptions,
  ) => StandaloneService;
  const service = new ServiceWithOptions(
    dataDir,
    () => runtime,
    undefined,
    options,
  );
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const workId = `assignment:${assignmentId}:initial`;
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  await service.start();
  execute({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  execute({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Recovery",
    leadProfileId: profileId,
  });
  execute({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Recover",
    outcome: "Preserve one execution",
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Recovered work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute({
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  assert.equal(await runtime.turnStartEntered.promise.then(() => true), true);
  if (!turnStartResponse) await runtime.turnEntered.promise;
  for (let attempt = 0; attempt < 100; attempt++) {
    const item = service
      .list()
      .find((candidate) => candidate.workId === workId);
    if (item?.threadId && item.turnId) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const active = service
    .list()
    .find((candidate) => candidate.workId === workId);
  assert.equal(active?.state, turnStartResponse ? "submitting" : "running");
  assert.equal(service.domain().assignment(assignmentId).state, "running");
  assert.ok(active?.threadId);
  if (!turnStartResponse) assert.ok(active?.turnId);
  return {
    root,
    dataDir,
    service,
    runtime,
    projectId,
    taskId,
    assignmentId,
    workId,
    active,
    turnStartResponse,
  };
}

function crash(service: StandaloneService): void {
  const internals = service as unknown as {
    scheduler: { stop(): void } | undefined;
    db: { close(): void } | undefined;
    owner: { close(): void } | undefined;
  };
  internals.scheduler?.stop();
  internals.scheduler = undefined;
  internals.db?.close();
  internals.db = undefined;
  internals.owner?.close();
  internals.owner = undefined;
}

async function finishOld(
  service: StandaloneService,
  runtime: RecoveryRuntime,
): Promise<void> {
  runtime.turnGate.resolve();
  runtime.turnStartGate = Promise.resolve("late-turn");
  await service.stop();
}

function exactIdentity(view: RecoveryRecord): ExactExecutionIdentity {
  assert.ok(view.intent.threadId);
  assert.ok(view.intent.turnId);
  return {
    workId: view.workId,
    workRevision: view.generation.workRevision,
    requestSequence: view.generation.requestSequence,
    threadId: view.intent.threadId,
    turnId: view.intent.turnId,
    processIdentity: view.processIdentity,
  };
}

function validReceipt(view: RecoveryRecord): RecoveryReceipt {
  const identity = exactIdentity(view);
  assert.ok(identity.processIdentity);
  return {
    ...identity,
    processIdentity: identity.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
  };
}

test("startup inspects only a bound original generation and never blindly resubmits it", async () => {
  const old = await activeFixture();
  let recovered: StandaloneService | undefined;
  const runtime = new RecoveryRuntime();
  try {
    crash(old.service);
    const oldView = exactIdentity({
      workId: old.workId,
      generation: { workRevision: 1, requestSequence: 1 },
      intent: {
        state: old.active.state,
        reason: old.active.reason,
        threadId: old.active.threadId,
        turnId: old.active.turnId,
      },
      request: null,
      binding: null,
      processIdentity: old.runtime.process,
      pendingEffects: [],
      observations: [],
      holds: {
        task: null,
        writer: true,
        capacity: true,
        uncertainty: true,
        stop: false,
      },
      receipt: null,
    });
    runtime.inspection = (identity) => ({ kind: "exact-live", identity });
    recovered = new StandaloneService(old.dataDir, () => runtime);
    await recovered.start();
    assert.deepEqual(runtime.inspections, [oldView]);
    const record = recoveryApi(recovered)
      .recoveryView()
      .find((item) => item.workId === old.workId);
    assert.equal(record?.intent.state, "held");
    assert.equal(record?.observations.at(-1)?.kind, "exact-live");
    assert.equal(record?.holds.writer, true);
    assert.equal(record?.holds.capacity, true);
    assert.equal(
      recovered.domain().assignment(old.assignmentId).state,
      "running",
      "a recovered uncertain generation must not demote its admitted assignment",
    );
    assert.equal(runtime.threads, 0);
    assert.equal(runtime.turns, 0);
    assert.equal(
      recovered.turnRequests().find((item) => item.workId === old.workId)
        ?.state,
      "held",
    );
  } finally {
    runtime.turnGate.resolve();
    await recovered?.stop();
    await finishOld(old.service, old.runtime);
    rmSync(old.root, { recursive: true, force: true });
  }
});

test("lost turn-start response is quarantined without inspection or replay", async () => {
  const old = await activeFixture({ holdTurnStart: true });
  const oldItem = old.service.list().find((item) => item.workId === old.workId);
  const oldThreadId = oldItem?.threadId;
  assert.ok(oldThreadId);
  let recovered: StandaloneService | undefined;
  const runtime = new RecoveryRuntime();
  try {
    crash(old.service);
    runtime.inspection = () => ({
      kind: "exact-live",
      identity: {
        workId: old.workId,
        workRevision: 1,
        requestSequence: 1,
        threadId: oldThreadId,
        turnId: "unknown-turn",
        processIdentity: old.runtime.process,
      },
    });
    recovered = new StandaloneService(old.dataDir, () => runtime);
    await recovered.start();
    assert.equal(runtime.inspections.length, 0);
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.state,
      "held",
    );
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.turnId,
      null,
    );
    assert.equal(
      recovered.domain().assignment(old.assignmentId).state,
      "running",
      "a lost turn-start response must retain the admitted assignment state",
    );
    assert.equal(
      recovered.capacityLimits([old.projectId]).currentUsage.global,
      1,
    );
    assert.equal(runtime.threads, 0);
    assert.equal(runtime.turns, 0);
  } finally {
    old.turnStartResponse?.resolve("late-turn");
    await recovered?.stop();
    await finishOld(old.service, old.runtime);
    rmSync(old.root, { recursive: true, force: true });
  }
});

test("historical, conflicting and terminal startup reports retain every unresolved hold", async () => {
  for (const inspection of [
    {
      kind: "historical-only",
      reason: "Only stored history is visible",
    } as const,
    { kind: "conflicting", reason: "More than one identity matches" } as const,
    { kind: "no-proof", reason: "No current execution is proven" } as const,
  ]) {
    const old = await activeFixture();
    let recovered: StandaloneService | undefined;
    const runtime = new RecoveryRuntime();
    try {
      crash(old.service);
      runtime.inspection = () => inspection;
      recovered = new StandaloneService(old.dataDir, () => runtime);
      await recovered.start();
      const record = recoveryApi(recovered)
        .recoveryView()
        .find((item) => item.workId === old.workId);
      assert.equal(record?.observations.at(-1)?.kind, inspection.kind);
      assert.equal(record?.holds.writer, true);
      assert.equal(record?.holds.capacity, true);
      assert.equal(recovered.taskHold(old.taskId), undefined);
      assert.equal(runtime.threads, 0);
      assert.equal(runtime.turns, 0);
    } finally {
      runtime.turnGate.resolve();
      await recovered?.stop();
      await finishOld(old.service, old.runtime);
      rmSync(old.root, { recursive: true, force: true });
    }
  }
});

test("validated recovery receipt releases only the exact generation and preserves Stop until Resume", async () => {
  const clock = new ManualClock();
  const old = await activeFixture({
    supervisor: { clock, observationMs: 3000 },
  });
  const stopping = old.service.stopTask(old.taskId);
  assert.equal(
    await waitUntil(() => old.runtime.interrupts.length === 1),
    true,
  );
  await clock.sleepEntered.promise;
  clock.advance(3000);
  await stopping;
  let recovered: StandaloneService | undefined;
  const runtime = new RecoveryRuntime();
  let terminationOutcome: "verified" | "conflict" | "unknown" = "unknown";
  const terminationVerifier: TerminationVerifier = {
    async verify(identity) {
      if (terminationOutcome === "verified")
        return {
          kind: "verified",
          processIdentity: identity,
          verifiedAt: "2026-09-29T09:05:00.000Z",
          method: "mac-pid-absent-same-boot",
        };
      return {
        kind: terminationOutcome,
        reason: terminationOutcome === "conflict" ? "wrong PID" : "unavailable",
      } as TerminationVerification;
    },
  };
  try {
    crash(old.service);
    runtime.inspection = (identity) => ({
      kind: "exact-terminal",
      identity,
      status: "completed",
    });
    recovered = new StandaloneService(old.dataDir, () => runtime, undefined, {
      terminationVerifier,
    });
    await recovered.start();
    const api = recoveryApi(recovered);
    const view = api.recoveryView().find((item) => item.workId === old.workId);
    assert.ok(view);
    assert.equal(view.pendingEffects.length, 1);
    assert.equal(view.holds.stop, true);
    const receipt = validReceipt(view);

    await assert.rejects(
      () =>
        api.resolveHeldExecution({
          ...receipt,
          workRevision: (receipt.workRevision ?? 0) + 1,
        }),
      /generation|identity/i,
    );
    await assert.rejects(
      () =>
        api.resolveHeldExecution({
          ...receipt,
          processIdentity: {
            ...receipt.processIdentity,
            processId: "other-pid",
          },
        }),
      /process|identity/i,
    );
    await assert.rejects(
      () =>
        api.resolveHeldExecution({
          ...receipt,
          effects: "unsettled",
        } as unknown as RecoveryReceipt),
      /effect|settled/i,
    );
    await assert.rejects(
      () =>
        api.resolveHeldExecution({
          ...receipt,
          workspace: "deleted",
        } as unknown as RecoveryReceipt),
      /workspace|disposition/i,
    );
    await assert.rejects(
      () => api.resolveHeldExecution(receipt),
      /could not be verified/i,
    );
    terminationOutcome = "conflict";
    await assert.rejects(
      () => api.resolveHeldExecution(receipt),
      /conflicts with the stored identity/i,
    );
    assert.equal(
      recovered.capacityLimits([old.projectId]).currentUsage.global,
      1,
    );
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.state,
      "held",
    );

    terminationOutcome = "verified";
    const resolved = await api.resolveHeldExecution(receipt);
    assert.equal(resolved.state, "reconciled");
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.state,
      "reconciled",
    );
    assert.equal(
      recovered.capacityLimits([old.projectId]).currentUsage.global,
      0,
    );
    assert.equal(
      recovered.isCurrentResult(old.workId),
      false,
      "reconciled is not successful completion",
    );
    assert.equal(recovered.taskHold(old.taskId), "Task stopped");
    assert.equal(runtime.threads, 0);
    assert.equal(runtime.turns, 0);

    await recovered.registerExecutionCallback(old.workId, Promise.resolve());
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.state,
      "reconciled",
    );

    await recovered.stop();
    const reopenedRuntime = new RecoveryRuntime();
    recovered = new StandaloneService(
      old.dataDir,
      () => reopenedRuntime,
      undefined,
      {
        terminationVerifier,
      },
    );
    await recovered.start();
    const reopenedApi = recoveryApi(recovered);
    const persisted = reopenedApi
      .recoveryView()
      .find((item) => item.workId === old.workId);
    assert.equal(persisted?.intent.state, "reconciled");
    assert.ok(persisted?.receipt?.id);
    assert.equal(persisted?.holds.stop, true);
    assert.equal(persisted?.holds.writer, false);
    assert.equal(persisted?.holds.capacity, false);
    assert.equal(reopenedRuntime.inspections.length, 0);

    const internals = recovered as unknown as {
      state: {
        beginArchive(taskId: string): boolean;
        endArchive(taskId: string): void;
      };
    };
    assert.equal(
      internals.state.beginArchive(old.taskId),
      false,
      "Stop remains an independent archive hold",
    );
    await recovered.resumeTask(old.taskId);
    assert.equal(
      internals.state.beginArchive(old.taskId),
      true,
      "reconciled is terminal for archive admission after Resume",
    );
    internals.state.endArchive(old.taskId);
    void recovered
      .submitTask("fresh-generation", old.assignmentId, "new captured work")
      .catch(() => {});
    assert.equal(await waitUntil(() => reopenedRuntime.turns === 1), true);
    assert.equal(
      recovered.list().find((item) => item.workId === "fresh-generation")
        ?.state,
      "running",
    );
    const afterResume = reopenedApi
      .recoveryView()
      .find((item) => item.workId === old.workId);
    assert.equal(afterResume?.receipt?.workspaceDisposition, "preserved");
  } finally {
    runtime.turnGate.resolve();
    await recovered?.stop();
    await finishOld(old.service, old.runtime);
    rmSync(old.root, { recursive: true, force: true });
  }
});

test("already committed completion is not quarantined or dispatched again after restart", async () => {
  const old = await activeFixture();
  old.runtime.turnGate.resolve();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      old.service.list().find((item) => item.workId === old.workId)?.state ===
      "completed"
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(
    old.service.list().find((item) => item.workId === old.workId)?.state,
    "completed",
  );
  crash(old.service);
  const runtime = new RecoveryRuntime();
  let recovered: StandaloneService | undefined;
  try {
    recovered = new StandaloneService(old.dataDir, () => runtime);
    await recovered.start();
    assert.equal(runtime.inspections.length, 0);
    assert.equal(
      recovered.list().find((item) => item.workId === old.workId)?.state,
      "completed",
    );
    assert.equal(runtime.threads, 0);
    assert.equal(runtime.turns, 0);
  } finally {
    await recovered?.stop();
    await finishOld(old.service, old.runtime);
    rmSync(old.root, { recursive: true, force: true });
  }
});
