import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type {
  FailureEvidence,
  Runtime,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";

interface RetryRuntime extends Runtime {
  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  attempts = 150,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

class RetryFixtureRuntime implements RetryRuntime {
  turns = 0;
  readonly started = deferred<void>();
  readonly failureEntered = deferred<void>();
  readonly retryEntered = deferred<void>();
  readonly retryGate = deferred<void>();
  failureGate: Promise<void> | undefined;
  failure: FailureEvidence | undefined;
  readonly failuresByTurn = new Map<string, FailureEvidence>();
  readonly outcomesByTurn = new Map<
    string,
    "completed" | "failed" | "timeout"
  >();
  evidenceMismatch = false;
  evidenceTurnMismatch = false;

  async start() {}

  async stop() {
    this.retryGate.resolve();
  }

  async startThread() {
    return "thread-1";
  }

  async resumeThread() {}

  async startTurn() {
    this.turns++;
    return `turn-${this.turns}`;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    const outcome =
      this.outcomesByTurn.get(turnId) ??
      (turnId === "turn-1" ? "failed" : "completed");
    if (outcome === "failed" || outcome === "timeout") {
      if (turnId === "turn-1") this.started.resolve();
      else this.retryEntered.resolve();
      this.failureEntered.resolve();
      await this.failureGate;
      if (outcome === "timeout")
        throw new Error("Turn terminal status timed out");
      return "failed" as const;
    }
    if (turnId === "turn-1") this.started.resolve();
    else {
      this.retryEntered.resolve();
      await this.retryGate.promise;
    }
    return "completed" as const;
  }

  failureEvidence(threadId: string, turnId: string) {
    const evidence =
      this.failuresByTurn.get(turnId) ??
      (turnId === "turn-1" ? this.failure : undefined);
    if (!evidence) return undefined;
    return {
      ...evidence,
      threadId: this.evidenceMismatch ? "stale-thread" : threadId,
      turnId: this.evidenceTurnMismatch ? "stale-turn" : turnId,
    };
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
}

const transientEvidence = (
  threadId = "thread-1",
  turnId = "turn-1",
): FailureEvidence => ({
  threadId,
  turnId,
  status: "failed",
  classification: "transient",
  reasonCode: "serverOverloaded",
  source: "codexErrorInfo",
  codexRetries: 0,
});

async function fixture(runtime: RetryFixtureRuntime) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-retry-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    retry: { fallbackBackoffMs: 0 },
  });
  await service.start();
  return {
    root,
    workspace,
    service,
    async close() {
      runtime.retryGate.resolve();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function managedFixture(runtime: RetryFixtureRuntime) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-managed-retry-"));
  const dataDir = join(root, "data");
  const service = new StandaloneService(dataDir, () => runtime);
  await service.start();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const workId = `assignment:${assignmentId}:initial`;
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
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
    name: "Retry",
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
    title: "Retry",
    outcome: "Retry safely",
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
    brief: "retry",
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
  await runtime.started.promise;
  assert.equal(
    await waitUntil(() =>
      service
        .list()
        .some((item) => item.workId === workId && item.state === "running"),
    ),
    true,
  );
  return {
    root,
    service,
    taskId,
    workId,
    async close() {
      runtime.retryGate.resolve();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rows<T>(service: StandaloneService, sql: string): T[] {
  const db = (service as unknown as { db: DatabaseSync }).db;
  return db.prepare(sql).all() as T[];
}

test("a qualified transient failure atomically releases its generation and queues one fresh retry", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.failure = transientEvidence();
  const f = await fixture(runtime);
  try {
    const original = f.service.submit("first", "try safely", f.workspace);
    await runtime.started.promise;
    assert.equal(
      await waitUntil(() => runtime.turns === 2),
      true,
      "a positively proven transient terminal failure should create a fresh retry turn",
    );
    const originalIntent = f.service
      .list()
      .find((item) => item.workId === "first");
    assert.equal(originalIntent?.state, "resolved-failed");
    const reservations = rows<{ workId: string }>(
      f.service,
      "SELECT workId FROM execution_capacity_reservations ORDER BY workId",
    );
    assert.equal(reservations.length, 1);
    assert.notEqual(reservations[0]?.workId, "first");
    assert.equal(f.service.turnRequests().length, 2);
    assert.equal(
      f.service.turnRequests().filter((request) => request.state === "queued")
        .length,
      0,
    );
    runtime.retryGate.resolve();
    await original;
  } finally {
    await f.close();
  }
});

test("missing, mismatched, generic, permanent, or uncounted failure evidence never retries", async () => {
  const cases: Array<{
    name: string;
    evidence?: FailureEvidence;
    mismatch?: boolean;
    mismatchTurn?: boolean;
  }> = [
    { name: "missing evidence" },
    {
      name: "mismatched bound identity",
      evidence: transientEvidence(),
      mismatch: true,
    },
    {
      name: "stale generation terminal identity",
      evidence: transientEvidence(),
      mismatchTurn: true,
    },
    {
      name: "generic failed",
      evidence: {
        ...transientEvidence(),
        classification: "unknown",
        reasonCode: "other",
      },
    },
    {
      name: "permanent error",
      evidence: {
        ...transientEvidence(),
        classification: "permanent",
        reasonCode: "badRequest",
      },
    },
    {
      name: "unrecognized transient code",
      evidence: { ...transientEvidence(), reasonCode: "other" },
    },
    {
      name: "missing Codex retry telemetry",
      evidence: { ...transientEvidence(), codexRetries: null },
    },
    {
      name: "negative retry telemetry",
      evidence: { ...transientEvidence(), codexRetries: -1 },
    },
    {
      name: "invalid retry telemetry",
      evidence: { ...transientEvidence(), codexRetries: 2.5 },
    },
    {
      name: "Codex exhausted shared allowance",
      evidence: { ...transientEvidence(), codexRetries: 2 },
    },
  ];

  for (const item of cases) {
    const runtime = new RetryFixtureRuntime();
    runtime.failure = item.evidence;
    runtime.evidenceMismatch = item.mismatch ?? false;
    runtime.evidenceTurnMismatch = item.mismatchTurn ?? false;
    const f = await fixture(runtime);
    try {
      assert.equal(
        (
          await f.service.submit(
            item.name,
            "do not multiply retries",
            f.workspace,
          )
        ).state,
        "held",
        item.name,
      );
      assert.equal(runtime.turns, 1, item.name);
      assert.equal(
        rows(f.service, "SELECT workId FROM execution_capacity_reservations")
          .length,
        1,
        item.name,
      );
    } finally {
      await f.close();
    }
  }
});

test("the shared retry budget permits no more than two later turns", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.retryGate.resolve();
  for (const turnId of ["turn-1", "turn-2", "turn-3"]) {
    runtime.failuresByTurn.set(turnId, transientEvidence("thread-1", turnId));
    runtime.outcomesByTurn.set(turnId, "failed");
  }
  const f = await fixture(runtime);
  try {
    const first = f.service.submit("bounded", "bounded retries", f.workspace);
    await runtime.started.promise;
    assert.equal(
      await waitUntil(() => runtime.turns === 3),
      true,
      "the initial turn plus two later turns should be the maximum",
    );
    await first;
    assert.equal(
      await waitUntil(() => f.service.turnRequests().length === 3),
      true,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(runtime.turns, 3);
    assert.equal(
      f.service
        .list()
        .filter((intent) => String(intent.state) === "resolved-failed").length,
      2,
    );
    assert.equal(
      f.service.list().filter((intent) => intent.state === "held").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("reported Codex retry usage consumes the same persisted allowance", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.retryGate.resolve();
  runtime.failuresByTurn.set("turn-1", {
    ...transientEvidence(),
    codexRetries: 1,
  });
  runtime.failuresByTurn.set("turn-2", {
    ...transientEvidence(),
    codexRetries: 1,
  });
  runtime.outcomesByTurn.set("turn-1", "failed");
  runtime.outcomesByTurn.set("turn-2", "failed");
  const f = await fixture(runtime);
  try {
    const first = f.service.submit(
      "shared-budget",
      "share retry allowance",
      f.workspace,
    );
    await runtime.started.promise;
    assert.equal(
      await waitUntil(() => runtime.turns === 2),
      true,
      "one provider retry plus one Ensemble retry should exhaust the shared allowance",
    );
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(runtime.turns, 2);
    assert.equal(f.service.turnRequests().length, 2);
    assert.equal(
      f.service
        .list()
        .filter((intent) => String(intent.state) === "resolved-failed").length,
      1,
    );
    assert.equal(
      f.service.list().filter((intent) => intent.state === "held").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("retry count and queued generation survive restart without duplicating work", async () => {
  const firstRuntime = new RetryFixtureRuntime();
  const firstFailureGate = deferred<void>();
  firstRuntime.failureGate = firstFailureGate.promise;
  firstRuntime.failure = { ...transientEvidence(), codexRetries: 1 };
  const f = await fixture(firstRuntime);
  const scheduler = (f.service as unknown as { scheduler: { stop(): void } })
    .scheduler;
  try {
    const original = f.service.submit(
      "restart-budget",
      "survive retry restart",
      f.workspace,
    );
    await firstRuntime.failureEntered.promise;
    scheduler.stop();
    firstFailureGate.resolve();
    await original;
    assert.equal(
      f.service.turnRequests().length,
      2,
      "eligible retry must be durably queued before the stopped scheduler can drain it",
    );
    assert.equal(
      f.service.turnRequests().filter((request) => request.state === "queued")
        .length,
      1,
    );
    await f.service.stop();

    const secondRuntime = new RetryFixtureRuntime();
    secondRuntime.failure = { ...transientEvidence(), codexRetries: 1 };
    const restarted = new StandaloneService(
      join(f.root, "data"),
      () => secondRuntime,
      undefined,
      {
        retry: { fallbackBackoffMs: 0 },
      },
    );
    try {
      await restarted.start();
      assert.equal(
        await waitUntil(() => secondRuntime.turns === 1, 3000),
        true,
        "the persisted retry generation should resume after restart",
      );
      await secondRuntime.failureEntered.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(
        secondRuntime.turns,
        1,
        "persisted Codex and Ensemble retry usage must prevent a third later turn",
      );
      assert.equal(
        restarted.turnRequests().length,
        2,
        "restart and duplicate wakes must not create a second queued successor",
      );
      assert.equal(
        restarted
          .list()
          .filter((intent) => String(intent.state) === "resolved-failed")
          .length,
        1,
      );
      assert.equal(
        restarted.list().filter((intent) => intent.state === "held").length,
        1,
      );
    } finally {
      await restarted.stop();
    }
  } finally {
    firstFailureGate.resolve();
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("failed-generation release is atomic, idempotent, and stale proof cannot release the next writer", async () => {
  const runtime = new RetryFixtureRuntime();
  const f = await fixture(runtime);
  try {
    const first = await f.service.submit(
      "atomic",
      "prove exact failed release",
      f.workspace,
    );
    assert.equal(first.state, "held");
    const scheduler = (f.service as unknown as { scheduler: { stop(): void } })
      .scheduler;
    scheduler.stop();
    const recovery = f.service
      .recoveryView()
      .find((item) => item.workId === "atomic");
    assert.ok(recovery);
    assert.ok(recovery.intent.threadId);
    assert.ok(recovery.intent.turnId);
    const proof = {
      workId: "atomic",
      workRevision: recovery.generation.workRevision,
      requestSequence: recovery.generation.requestSequence,
      threadId: recovery.intent.threadId,
      turnId: recovery.intent.turnId,
      terminalStatus: "failed" as const,
      classification: "transient" as const,
      reasonCode: "serverOverloaded" as const,
      source: "codexErrorInfo" as const,
      codexRetries: 0,
      callbacksEnded: true,
      noSurvivor: true,
      effects: "settled" as const,
      nextEligibleAt: Date.now() + 30_000,
    };
    const state = (f.service as unknown as { state: unknown }).state as {
      resolveFailedGeneration(input: typeof proof): unknown;
      begin(id: string, options: unknown): boolean;
    };
    state.resolveFailedGeneration(proof);
    assert.equal(f.service.turnRequests().length, 2);
    assert.equal(
      f.service.turnRequests().filter((item) => item.state === "queued").length,
      1,
    );
    assert.equal(
      String(f.service.list().find((item) => item.workId === "atomic")?.state),
      "resolved-failed",
    );
    assert.equal(
      rows(f.service, "SELECT workId FROM execution_capacity_reservations")
        .length,
      0,
      "a retry stays unreserved until it enters full admission",
    );

    const later = await f.service.submit(
      "later-writer",
      "new owner",
      f.workspace,
    );
    assert.equal(later.state, "ready");
    const sequence = f.service
      .turnRequests()
      .find((item) => item.workId === "later-writer");
    assert.ok(sequence);
    assert.equal(
      state.begin(later.id, {
        projectId: null,
        requestSequence: f.service.turnRequests().length,
        processIdentity: null,
      }),
      true,
    );
    state.resolveFailedGeneration(proof);
    assert.equal(
      f.service.turnRequests().length,
      3,
      "repeating the committed resolution must not create another retry",
    );
    assert.equal(
      f.service.turnRequests().filter((item) => item.state === "queued").length,
      1,
    );

    const stale = { ...proof, requestSequence: proof.requestSequence + 1 };
    try {
      state.resolveFailedGeneration(stale as typeof proof);
    } catch {
      // A stale proof may be rejected or conservatively ignored.
    }
    assert.deepEqual(
      rows<{ workId: string }>(
        f.service,
        "SELECT workId FROM execution_capacity_reservations",
      ).map((row) => row.workId),
      ["later-writer"],
      "an older generation proof must not free a newer writer or its capacity",
    );
    assert.equal(
      runtime.turns,
      1,
      "the direct low-level transition must not start runtime work",
    );
  } finally {
    await f.close();
  }
});

test("transport timeout cannot be upgraded into a retry by a transient-looking classification", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.failure = transientEvidence();
  runtime.outcomesByTurn.set("turn-1", "timeout");
  const f = await fixture(runtime);
  try {
    const outcome = await f.service.submit(
      "timeout",
      "do not retry uncertainty",
      f.workspace,
    );
    assert.equal(outcome.state, "held");
    assert.equal(runtime.turns, 1);
    assert.equal(f.service.turnRequests().length, 1);
    assert.equal(
      rows(f.service, "SELECT workId FROM execution_capacity_reservations")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a pending Ensemble callback or known survivor keeps the failed generation held", async () => {
  for (const hold of ["callback", "survivor"] as const) {
    const runtime = new RetryFixtureRuntime();
    runtime.failure = transientEvidence();
    const failureGate = deferred<void>();
    runtime.failureGate = failureGate.promise;
    const f = await fixture(runtime);
    try {
      const submission = f.service.submit(
        hold,
        "keep unresolved effects held",
        f.workspace,
      );
      await runtime.failureEntered.promise;
      if (hold === "callback") {
        f.service.registerExecutionCallback(hold, new Promise<void>(() => {}));
      } else {
        f.service.holdKnownSurvivor(hold, "synthetic unfinished child");
      }
      failureGate.resolve();
      const result = await submission;
      assert.equal(result.state, "held");
      assert.equal(runtime.turns, 1);
      assert.equal(f.service.turnRequests().length, 1);
      assert.equal(
        rows(f.service, "SELECT workId FROM execution_capacity_reservations")
          .length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("an unresolved assignment effect keeps a transient failure held for recovery", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.failure = transientEvidence();
  const f = await managedFixture(runtime);
  try {
    const before = rows<{ state: string }>(
      f.service,
      "SELECT state FROM execution_pending_effects WHERE state = 'pending'",
    );
    assert.equal(before.length, 1);
    runtime.failureGate = undefined;
    const result = f.service.list().find((item) => item.workId === f.workId);
    assert.ok(result);
    await runtime.failureEntered.promise;
    await waitUntil(
      () =>
        f.service.list().find((item) => item.workId === f.workId)?.state ===
        "held",
    );
    assert.equal(runtime.turns, 1);
    assert.equal(f.service.turnRequests().length, 1);
    assert.equal(
      rows(
        f.service,
        "SELECT state FROM execution_pending_effects WHERE state = 'pending'",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Stop remains an independent hold and never enters the retry path", async () => {
  const runtime = new RetryFixtureRuntime();
  runtime.failure = transientEvidence();
  const failureGate = deferred<void>();
  runtime.failureGate = failureGate.promise;
  const f = await managedFixture(runtime);
  try {
    const observation = f.service.stopTask(f.taskId);
    assert.equal(
      f.service.list().find((item) => item.workId === f.workId)?.state,
      "held",
    );
    failureGate.resolve();
    await observation;
    await waitUntil(
      () =>
        f.service.list().find((item) => item.workId === f.workId)?.state ===
        "held",
    );
    assert.equal(runtime.turns, 1);
    assert.equal(f.service.turnRequests().length, 1);
    assert.equal(
      rows(f.service, "SELECT workId FROM execution_capacity_reservations")
        .length,
      1,
    );
  } finally {
    failureGate.resolve();
    await f.close();
  }
});
