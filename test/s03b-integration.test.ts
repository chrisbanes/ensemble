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
} from "../src/standalone/recovery-types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("integration condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class IntegrationRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: "fixture-codex-1001",
    processStartedAt: "2026-09-29T10:00:00.000Z",
    bootId: "fixture-boot-1",
  };
  turns = 0;
  starts = 0;
  readonly prompts: string[] = [];
  readonly interrupts: string[] = [];
  private readonly outcomes = new Map<
    string,
    Deferred<"completed" | "failed">
  >();
  private readonly entered = new Map<number, Deferred<void>>();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("completed");
  }

  processIdentity() {
    return this.process;
  }

  async inspectExecution(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    return { kind: "exact-terminal", identity, status: "completed" };
  }

  async startThread() {
    return `thread-${++this.starts}`;
  }

  async resumeThread() {}

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    const turn = `turn-${++this.turns}`;
    this.prompts.push(prompt);
    this.outcomes.set(turn, deferred<"completed" | "failed">());
    this.entered.set(this.turns, deferred<void>());
    return turn;
  }

  async interruptTurn(_threadId: string, turnId: string) {
    this.interrupts.push(turnId);
  }

  async waitForTurn(_threadId: string, turnId: string) {
    const outcome = this.outcomes.get(turnId);
    if (!outcome) throw new Error("Unknown fixture turn");
    await this.toolCall?.({
      threadId: _threadId,
      turnId,
      callId: `fixture-question-${_threadId}-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: {
        question: "Integration fixture is waiting for the next step",
      },
    });
    const turnNumber = Number(turnId.slice("turn-".length));
    this.entered.get(turnNumber)?.resolve();
    return outcome.promise;
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  async waitForTurnNumber(turn: number): Promise<void> {
    await waitUntil(() => this.turns >= turn);
    const entry = this.entered.get(turn);
    if (!entry)
      throw new Error(`Turn ${turn} has not entered terminal observation`);
    await entry.promise;
  }

  complete(turn: number): void {
    this.outcomes.get(`turn-${turn}`)?.resolve("completed");
  }
}

function command(
  service: StandaloneService,
  body: Record<string, unknown>,
): unknown {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}

async function createProject(
  service: StandaloneService,
  profileId: string,
  name: string,
) {
  const projectId = randomUUID();
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name,
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  return projectId;
}

async function createTask(
  service: StandaloneService,
  projectId: string,
  profileId: string,
  title: string,
  requesterAssignmentId: string | null = null,
) {
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title,
    outcome: title,
    ready: false,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: title,
    resultDestination: requesterAssignmentId
      ? `requester:${requesterAssignmentId}`
      : "lead",
    requesterAssignmentId,
  });
  command(service, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { taskId, assignmentId, workId: `assignment:${assignmentId}:initial` };
}

function createAssignment(
  service: StandaloneService,
  projectId: string,
  taskId: string,
  profileId: string,
  title: string,
  requesterAssignmentId: string,
) {
  const assignmentId = randomUUID();
  command(service, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: title,
    resultDestination: `requester:${requesterAssignmentId}`,
    requesterAssignmentId,
  });
  return { taskId, assignmentId, workId: `assignment:${assignmentId}:initial` };
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

function recoveryRecord(
  service: StandaloneService,
  workId: string,
): RecoveryRecord {
  const record = service
    .recoveryView()
    .find((candidate) => candidate.workId === workId);
  assert.ok(record, `missing recovery record for ${workId}`);
  return record;
}

function receiptFor(record: RecoveryRecord): RecoveryReceipt {
  assert.ok(record.processIdentity);
  assert.ok(record.intent.threadId);
  assert.ok(record.intent.turnId);
  return {
    workId: record.workId,
    workRevision: record.generation.workRevision,
    requestSequence: record.generation.requestSequence,
    threadId: record.intent.threadId,
    turnId: record.intent.turnId,
    processIdentity: record.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
  };
}

test("S03b integrates yielding, pause, Stop, restart reconciliation and exact recovery without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s03b-integration-"));
  const dataDir = join(root, "data");
  const profileId = randomUUID();
  const verifier: TerminationVerifier = {
    async verify(processIdentity) {
      return {
        kind: "verified",
        processIdentity,
        verifiedAt: "2026-09-29T10:05:00.000Z",
        method: "mac-pid-absent-same-boot",
      };
    },
  };
  const firstRuntime = new IntegrationRuntime();
  const first = new StandaloneService(dataDir, () => firstRuntime, undefined, {
    supervisor: { observationMs: 5 },
  });
  let recovered: StandaloneService | undefined;
  try {
    await first.start();
    command(first, {
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Lead and worker",
      instructions: "Build safely",
      capabilities: "code",
    });
    const leadProject = await createProject(first, profileId, "Lead project");
    const workerProject = await createProject(
      first,
      profileId,
      "Worker project",
    );
    await first.configureCapacity({
      key: randomUUID(),
      globalLimit: 1,
      projectOverrides: { [leadProject]: 1, [workerProject]: 1 },
    });

    const parent = await createTask(first, leadProject, profileId, "Lead task");
    await firstRuntime.waitForTurnNumber(1);
    const child = createAssignment(
      first,
      leadProject,
      parent.taskId,
      profileId,
      "Synthetic worker child",
      parent.assignmentId,
    );
    await waitUntil(() =>
      first.turnRequests().some((request) => request.workId === child.workId),
    );
    await waitUntil(() =>
      first.list().some((intent) => intent.workId === child.workId),
    );
    assert.equal(
      firstRuntime.turns,
      1,
      "the child waits for the capacity-one lead turn",
    );
    assert.equal(first.capacityLimits([leadProject]).currentUsage.global, 1);
    assert.equal(
      first.turnRequests().find((request) => request.workId === child.workId)
        ?.state,
      "queued",
    );

    firstRuntime.complete(1);
    await firstRuntime.waitForTurnNumber(2);
    const continuationId = "lead-follow-up-after-child";
    const continuation = await first.submitTask(
      continuationId,
      parent.assignmentId,
      "Continue after child result",
      parent.workId,
    );
    assert.equal(continuation.state, "capacity-waiting");
    assert.equal(first.recordTaskResult(continuationId, "premature"), false);

    const worker = await createTask(
      first,
      workerProject,
      profileId,
      "Independent worker task",
    );
    await waitUntil(() =>
      first.turnRequests().some((request) => request.workId === worker.workId),
    );
    await waitUntil(() =>
      first.list().some((intent) => intent.workId === worker.workId),
    );
    const waitingWorker = first
      .list()
      .find((intent) => intent.workId === worker.workId);
    assert.equal(waitingWorker?.state, "capacity-waiting");
    assert.equal(
      first.capacityLimits([workerProject]).currentUsage.projects[
        workerProject
      ] ?? 0,
      0,
    );
    command(first, {
      type: "project.configure",
      actor: "operator",
      projectId: workerProject,
      expectedVersion: Number(first.domain().project(workerProject).version),
      paused: true,
    });

    const stopObservation = await first.stopTask(child.taskId);
    assert.equal(stopObservation.outcomes[0]?.terminal, "unknown");
    assert.equal(firstRuntime.interrupts.length, 1);
    assert.equal(
      first.list().find((intent) => intent.workId === child.workId)?.state,
      "held",
    );
    assert.equal(first.capacityLimits([leadProject]).currentUsage.global, 1);
    crash(first);

    const restartRuntime = new IntegrationRuntime();
    recovered = new StandaloneService(
      dataDir,
      () => restartRuntime,
      undefined,
      {
        supervisor: { observationMs: 5 },
        terminationVerifier: verifier,
      },
    );
    await recovered.start();
    assert.equal(
      restartRuntime.starts,
      0,
      "startup observes but never replays an uncertain turn",
    );
    const observed = recoveryRecord(recovered, child.workId);
    assert.equal(
      observed.observations.at(-1)?.kind,
      "exact-terminal-completed",
    );
    assert.equal(observed.holds.writer, true);
    assert.equal(observed.holds.capacity, true);
    const resolved = await recovered.resolveHeldExecution(receiptFor(observed));
    assert.equal(resolved.state, "reconciled");
    assert.equal(
      recovered.capacityLimits([leadProject]).currentUsage.global,
      0,
    );
    assert.equal(recovered.taskHold(child.taskId), "Task stopped");
    assert.equal(
      recovered.recordTaskResult(child.workId, "stale child result"),
      false,
    );

    await recovered.resumeTask(child.taskId);
    await restartRuntime.waitForTurnNumber(1);
    restartRuntime.complete(1);
    await waitUntil(
      () =>
        recovered?.list().find((intent) => intent.workId === continuationId)
          ?.state === "completed",
    );
    assert.equal(
      restartRuntime.turns,
      1,
      "repeated scheduler wake does not create a duplicate fresh turn",
    );

    command(recovered, {
      type: "project.configure",
      actor: "operator",
      projectId: workerProject,
      expectedVersion: Number(
        recovered.domain().project(workerProject).version,
      ),
      paused: false,
    });
    await restartRuntime.waitForTurnNumber(2);
    assert.equal(restartRuntime.prompts[1], "Independent worker task");
    restartRuntime.complete(2);
    await waitUntil(
      () =>
        recovered?.list().find((intent) => intent.workId === worker.workId)
          ?.state === "completed",
    );
    assert.equal(
      recovered
        .turnRequests()
        .filter((request) => request.workId === worker.workId).length,
      1,
    );
    assert.equal(restartRuntime.turns, 2);
  } finally {
    for (let turn = 1; turn <= firstRuntime.turns; turn++)
      firstRuntime.complete(turn);
    if (recovered) await recovered.stop();
    await first.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
