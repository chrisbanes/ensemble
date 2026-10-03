import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import { StandaloneService } from "../src/standalone/service.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
import type { CoordinationStore } from "../src/core/coordination.js";
import type { ExecutionState } from "../src/standalone/state.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import type {
  RecoveryReceipt,
  RuntimeProcessIdentity,
} from "../src/standalone/recovery-types.js";
import { DatabaseSync } from "node:sqlite";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import {
  type HistoricalPreTurnAdoption,
  type PreTurnRecoveryCommand,
  ArchivedResumeRejectedError,
  archivedResumeMessage,
} from "../src/standalone/pre-turn-recovery.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class RecoveryContinuationRuntime implements Runtime {
  turns = 0;
  threads = 0;
  prompts: string[] = [];
  completionResults: RuntimeToolResult[] = [];
  holdSuccessor = false;
  failedTurn = 2;
  successorGate = deferred();
  private listener:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  readonly identity: RuntimeProcessIdentity = {
    processId: "synthetic-1001",
    processStartedAt: "2026-10-03T10:00:00.000Z",
    bootId: "synthetic-boot",
  };
  async start() {}
  async stop() {
    this.successorGate.resolve();
  }
  processIdentity() {
    return this.identity;
  }
  async startThread() {
    return `thread-${++this.threads}`;
  }
  rejectResume = false;
  resumeError: Error | undefined;
  async resumeThread(threadId: string) {
    if (this.resumeError) throw this.resumeError;
    if (this.rejectResume)
      throw new ArchivedResumeRejectedError({
        method: "thread/resume",
        requestId: 4,
        threadId,
        processIdentity: this.identity,
        error: { code: -32600, message: archivedResumeMessage(threadId) },
      });
  }
  async startTurn(_thread: string, _workspace: string, prompt: string) {
    this.prompts.push(prompt);
    return `turn-${++this.turns}`;
  }
  async interruptTurn() {}
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.listener = listener;
  }
  async waitForTurn(threadId: string, turnId: string) {
    assert.ok(this.listener);
    const turn = Number(turnId.slice(5));
    if (turn === 1) {
      const r = await this.listener({
        threadId,
        turnId,
        callId: "initial-question",
        tool: "ensemble_ask_question",
        arguments: { question: "Initial waiting turn" },
      });
      assert.equal(r.success, true);
      return "completed" as const;
    }
    if (turn === this.failedTurn) return "failed" as const;
    if (this.holdSuccessor) await this.successorGate.promise;
    const r = await this.listener({
      threadId,
      turnId,
      callId: `fresh-completion-${turn}`,
      tool: "ensemble_request_completion",
      arguments: { reviewedResultIds: [] },
    });
    this.completionResults.push(r);
    return "completed" as const;
  }
}
function internals(service: StandaloneService) {
  return service as unknown as {
    db: DatabaseSync;
    state: ExecutionState;
    coordination: CoordinationStore;
  };
}
function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function heldFixture(
  preTurn:
    | boolean
    | "historical"
    | "wrong-process"
    | "wrong-thread"
    | "timeout" = false,
) {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-recovery-continuation-"),
  );
  const runtime = new RecoveryContinuationRuntime();
  runtime.rejectResume = Boolean(preTurn);
  if (preTurn === "historical")
    runtime.resumeError = new Error(
      JSON.stringify({
        code: -32600,
        message: archivedResumeMessage("thread-1"),
      }),
    );
  if (preTurn === "timeout")
    runtime.resumeError = new Error("thread/resume timed out");
  if (preTurn === "wrong-process" || preTurn === "wrong-thread") {
    const threadId = preTurn === "wrong-thread" ? "other-thread" : "thread-1";
    runtime.resumeError = new ArchivedResumeRejectedError({
      method: "thread/resume",
      requestId: 4,
      threadId,
      processIdentity: {
        ...runtime.identity,
        processId:
          preTurn === "wrong-process"
            ? "other-process"
            : runtime.identity.processId,
      },
      error: { code: -32600, message: archivedResumeMessage(threadId) },
    });
  }
  if (preTurn) runtime.failedTurn = 0;
  let verified = true;
  const makeService = () =>
    new StandaloneService(join(directory, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      terminationVerifier: {
        async verify(identity) {
          return verified
            ? {
                kind: "verified",
                processIdentity: identity,
                verifiedAt: "2026-10-03T10:05:00.000Z",
                method: "mac-pid-absent-same-boot",
              }
            : {
                kind: "unknown",
                reason: "Synthetic process is not proven ended",
              };
        },
      },
    });
  const service = makeService();
  const projectId = randomUUID(),
    taskId = randomUUID(),
    profileId = randomUUID();
  await service.start();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Recovery lead",
    instructions: "Preserved profile",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Recovery",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Recover",
    outcome: "Complete fresh work",
    ready: false,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  await until(
    () =>
      service.coordinationView().readTask(taskId).questions.length === 1 &&
      service.list().every((i) => i.state !== "running"),
    "initial waiting turn",
  );
  const question = service.coordinationView().readTask(taskId).questions[0];
  assert.ok(question);
  const answer = await service.coordinationView().answerQuestion({
    key: randomUUID(),
    taskId,
    interactionId: question.interactionId,
    expectedRevision: question.revision,
    answer: "OLD_BATCH_SHOULD_NOT_REPLAY",
  });
  await until(
    () => service.turnRequests().some((r) => r.state === "held"),
    "old inbox failed",
  );
  const old = service.turnRequests().find((r) => r.state === "held");
  assert.ok(old?.assignmentId);
  const recovery = service.recoveryView().find((r) => r.workId === old.workId);
  assert.ok(recovery?.processIdentity);
  if (!preTurn) assert.ok(recovery.intent.threadId && recovery.intent.turnId);
  const receipt = {
    workId: old.workId,
    workRevision: recovery.generation.workRevision,
    requestSequence: recovery.generation.requestSequence,
    threadId: recovery.intent.threadId,
    turnId: recovery.intent.turnId,
    processIdentity: recovery.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
    ...(preTurn
      ? {
          kind: "pre-turn-rejection",
          witnessId:
            (recovery as unknown as { preTurnRejection?: { id: string } })
              .preTurnRejection?.id ?? "missing-witness",
        }
      : {}),
  } as RecoveryReceipt;
  const message = {
    key: randomUUID(),
    taskId,
    recipientAssignmentId: old.assignmentId,
    expectedAssignmentVersion: Number(old.assignmentVersion),
    message: "FRESH_COMPLETION_ONLY",
  };
  const pause = (paused: boolean, current = service) =>
    command(current, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(current.domain().project(projectId).version),
      paused,
    });
  return {
    directory,
    service,
    runtime,
    makeService,
    projectId,
    taskId,
    profileId,
    old,
    receipt,
    message,
    answer,
    pause,
    setVerified(value: boolean) {
      verified = value;
    },
  };
}
async function close(
  f: Awaited<ReturnType<typeof heldFixture>>,
  current = f.service,
) {
  await current.stop();
  rmSync(f.directory, { recursive: true, force: true });
}
function audit(service: StandaloneService, workId: string) {
  return internals(service)
    .db.prepare(
      "SELECT * FROM coordination_recovery_continuations WHERE workId = ?",
    )
    .get(workId);
}

test("validated recovery requires a new operator message, processes old batch without replay, and completes across restart", async () => {
  const f = await heldFixture();
  let service = f.service;
  try {
    const resolved = await service.resolveHeldExecution(f.receipt);
    const { coordination, state, db } = internals(service);
    assert.equal(
      state.isNeverAdmittedRefusedAssignmentWork(f.old.workId),
      false,
    );
    assert.ok(state.reconciledAssignmentProof(f.old.workId));
    assert.equal(coordination.hasRecoveryContinuation(f.old.workId), false);
    const oldIntent = service.list().find((i) => i.workId === f.old.workId);
    const oldRequest = service
      .turnRequests()
      .find((r) => r.workId === f.old.workId);
    const oldBatch = coordination.deliveryForWork(f.old.workId);
    assert.ok(oldBatch);
    const oldLinks = db
      .prepare(
        "SELECT * FROM coordination_delivery_events WHERE batchId = ? ORDER BY ordinal",
      )
      .all(oldBatch.batchId);
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    assert.equal(f.runtime.turns, 2, "receipt alone cannot dispatch");
    f.pause(true);
    const fresh = await service
      .coordinationView()
      .postOperatorMessage(f.message);
    const retainedAudit = audit(service, f.old.workId) as Record<
      string,
      unknown
    >;
    assert.equal(retainedAudit.receiptId, resolved.id);
    assert.equal(retainedAudit.operatorEventId, fresh.eventId);
    assert.equal(retainedAudit.operatorCommandKey, f.message.key);
    assert.equal(retainedAudit.batchId, oldBatch.batchId);
    assert.equal(
      coordination.deliveryForWork(f.old.workId)?.state,
      "completed",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM coordination_delivery_events WHERE batchId = ? ORDER BY ordinal",
        )
        .all(oldBatch.batchId),
      oldLinks,
    );
    assert.equal(
      service
        .coordinationView()
        .readTask(f.taskId)
        .messages.find((m) => m.eventId === f.answer.eventId)?.deliveryState,
      "operator-reconciled",
    );
    assert.equal(
      service
        .coordinationView()
        .readTask(f.taskId)
        .history.find((h) => h.workId === f.old.workId)?.recoveryDisposition,
      "operator-reconciled",
    );
    const api = new OperatorApi(service, [f.directory]);
    assert.equal(
      (await api.readTask(f.taskId)).data.messages.find(
        (m) => m.eventId === f.answer.eventId,
      )?.deliveryState,
      "operator-reconciled",
    );
    const routes = coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (id) => service.routingAvailability(id),
    );
    for (const [path, params] of [
      ["/coordination/task/:taskId", { taskId: f.taskId }],
      [
        "/coordination/assignment/:assignmentId",
        { assignmentId: String(f.old.assignmentId) },
      ],
    ] as const) {
      const route = routes.find((r) => r.method === "GET" && r.path === path);
      assert.ok(route);
      const rendered = await route.handler({
        params,
        fields: {},
        csrfToken: "test-token",
      });
      assert.equal(rendered.kind, "html");
      if (rendered.kind === "html")
        assert.match(rendered.body, /operator-reconciled/);
    }
    assert.equal(
      (await service.coordinationView().postOperatorMessage(f.message)).eventId,
      fresh.eventId,
    );
    assert.deepEqual(audit(service, f.old.workId), retainedAudit);
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(
      (await service.coordinationView().postOperatorMessage(f.message)).eventId,
      fresh.eventId,
    );
    assert.deepEqual(audit(service, f.old.workId), retainedAudit);
    assert.equal(f.runtime.turns, 2);
    f.pause(false, service);
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    await until(
      () => service.domain().task(f.taskId).state === "done",
      "fresh completion",
    );
    assert.equal(f.runtime.turns, 3);
    assert.equal(f.runtime.completionResults[0]?.success, true);
    assert.match(f.runtime.prompts[2] ?? "", /FRESH_COMPLETION_ONLY/);
    assert.doesNotMatch(
      f.runtime.prompts[2] ?? "",
      /OLD_BATCH_SHOULD_NOT_REPLAY/,
    );
    assert.deepEqual(
      service.list().find((i) => i.workId === f.old.workId),
      oldIntent,
    );
    assert.deepEqual(
      service.turnRequests().find((r) => r.workId === f.old.workId),
      oldRequest,
    );
    assert.deepEqual(audit(service, f.old.workId), retainedAudit);
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(
      (await service.coordinationView().postOperatorMessage(f.message)).eventId,
      fresh.eventId,
    );
    assert.equal(f.runtime.turns, 3);
    assert.equal(service.domain().task(f.taskId).state, "done");
    assert.deepEqual(audit(service, f.old.workId), retainedAudit);
  } finally {
    await close(f, service);
  }
});

test("wrong or unproved recovery never upgrades a pre-recovery message on replay", async () => {
  const f = await heldFixture();
  try {
    for (const altered of [
      { ...f.receipt, requestSequence: f.receipt.requestSequence + 1 },
      { ...f.receipt, workRevision: (f.receipt.workRevision ?? 0) + 1 },
      { ...f.receipt, threadId: "wrong-thread" },
      { ...f.receipt, turnId: "wrong-turn" },
      {
        ...f.receipt,
        processIdentity: {
          ...f.receipt.processIdentity,
          processId: "wrong-process",
        },
      },
    ])
      await assert.rejects(
        f.service.resolveHeldExecution(altered as RecoveryReceipt),
        /generation|identity/,
      );
    f.setVerified(false);
    await assert.rejects(
      f.service.resolveHeldExecution(f.receipt),
      /could not be verified/,
    );
    const event = await f.service
      .coordinationView()
      .postOperatorMessage(f.message);
    assert.equal(audit(f.service, f.old.workId), undefined);
    f.setVerified(true);
    await f.service.resolveHeldExecution(f.receipt);
    internals(f.service).coordination.ensureDeliveryEventWithinTransaction(
      f.taskId,
      "Confirmed PR feedback",
      "synthetic-feedback",
    );
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    assert.equal(
      audit(f.service, f.old.workId),
      undefined,
      "provider feedback cannot grant operator continuation",
    );
    assert.equal(
      (await f.service.coordinationView().postOperatorMessage(f.message))
        .eventId,
      event.eventId,
    );
    assert.equal(
      audit(f.service, f.old.workId),
      undefined,
      "existing key cannot retroactively authorize continuation",
    );
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    assert.equal(f.runtime.turns, 2);
  } finally {
    await close(f);
  }
});

test("recovery generation proof rejects changed identity, admission/effects and independent holds before a new message", async (t) => {
  for (const witness of [
    "request-sequence",
    "work-revision",
    "binding",
    "thread",
    "turn",
    "process",
    "workspace",
    "capacity",
    "effect",
    "stop-target",
    "writer-hold",
    "archive-hold",
    "callback",
  ] as const) {
    await t.test(witness, async () => {
      const f = await heldFixture();
      const callback = deferred();
      try {
        await f.service.resolveHeldExecution(f.receipt);
        const { db } = internals(f.service);
        if (witness === "request-sequence")
          db.prepare(
            "UPDATE turn_requests SET sequence = sequence + 100 WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "work-revision")
          db.prepare(
            "UPDATE task_work_revisions SET workRevision = workRevision + 1 WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "binding")
          db.prepare(
            "UPDATE task_execution_bindings SET assignmentVersion = assignmentVersion + 1 WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "thread" || witness === "turn")
          db.prepare(
            `UPDATE execution_intents SET ${witness}Id = 'different-runtime' WHERE workId = ?`,
          ).run(f.old.workId);
        else if (witness === "process")
          db.prepare(
            "UPDATE execution_recovery_identities SET processId = 'different-process' WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "workspace")
          db.prepare(
            "UPDATE task_writer_admissions SET workspace = 'different-workspace' WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "capacity")
          db.prepare(
            "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
          ).run(f.old.workId, f.projectId);
        else if (witness === "effect")
          db.prepare(
            "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'callback', 'pending', 'unfinished')",
          ).run(f.old.workId);
        else if (witness === "stop-target")
          db.prepare(
            "INSERT INTO execution_stop_targets (workId, taskId, interruptState, terminalState, requestedAt) VALUES (?, ?, 'unbound', 'unknown', 1)",
          ).run(f.old.workId, f.taskId);
        else if (witness === "writer-hold" || witness === "archive-hold")
          db.prepare(
            `INSERT INTO ${witness === "writer-hold" ? "task_writer_holds" : "task_archival_holds"} (taskId, reason) VALUES (?, 'independent hold')`,
          ).run(f.taskId);
        else
          f.service.registerExecutionCallback(f.old.workId, callback.promise);
        await f.service.coordinationView().postOperatorMessage(f.message);
        assert.equal(audit(f.service, f.old.workId), undefined);
        assert.equal(
          internals(f.service).coordination.deliveryForWork(f.old.workId)
            ?.state,
          "queued",
        );
        assert.equal(f.runtime.turns, 2);
      } finally {
        callback.resolve();
        await close(f);
      }
    });
  }
});

test("recorded recovery continuation still enforces current profile, dependency and Stop gates", async (t) => {
  for (const gate of ["profile", "dependency", "stop"] as const) {
    await t.test(gate, async () => {
      const f = await heldFixture();
      try {
        await f.service.resolveHeldExecution(f.receipt);
        if (gate === "profile")
          command(f.service, {
            type: "profile.configure",
            profileId: f.profileId,
            expectedVersion: 1,
            instructions: "Changed profile",
          });
        else if (gate === "dependency") {
          const blockerTaskId = randomUUID();
          command(f.service, {
            type: "task.create",
            projectId: f.projectId,
            taskId: blockerTaskId,
            title: "Blocker",
            outcome: "Unfinished",
          });
          command(f.service, {
            type: "dependency.add",
            projectId: f.projectId,
            taskId: f.taskId,
            blockerTaskId,
            expectedVersion: Number(f.service.domain().task(f.taskId).version),
          });
        } else await f.service.stopTask(f.taskId);
        await f.service.coordinationView().postOperatorMessage(f.message);
        await f.service.configureCapacity({
          key: randomUUID(),
          globalLimit: 1,
        });
        assert.equal(f.runtime.turns, 2);
        assert.equal(f.service.domain().task(f.taskId).state, "open");
      } finally {
        await close(f);
      }
    });
  }
});

test("every admission revalidates the recorded audit and current recovered proof", async (t) => {
  for (const witness of [
    "receipt",
    "event",
    "receipt-link",
    "batch",
    "effect",
    "capacity",
    "stop",
  ] as const) {
    await t.test(witness, async () => {
      const f = await heldFixture();
      try {
        await f.service.resolveHeldExecution(f.receipt);
        f.pause(true);
        const message = await f.service
          .coordinationView()
          .postOperatorMessage(f.message);
        const { db, coordination } = internals(f.service);
        assert.equal(coordination.hasRecoveryContinuation(f.old.workId), true);
        if (witness === "receipt")
          db.prepare(
            "UPDATE execution_recovery_receipts SET workspaceDisposition = 'reconciled' WHERE workId = ?",
          ).run(f.old.workId);
        else if (witness === "event")
          db.prepare(
            "UPDATE coordination_inbox_events SET payload = '{}' WHERE eventId = ?",
          ).run(message.eventId);
        else if (witness === "receipt-link")
          db.prepare(
            "UPDATE coordination_operator_receipts SET result = '{}' WHERE scope = 'operator-message' AND commandKey = ?",
          ).run(f.message.key);
        else if (witness === "batch")
          db.prepare(
            "UPDATE coordination_delivery_batches SET highWaterSequence = highWaterSequence + 1 WHERE deliveryWorkId = ?",
          ).run(f.old.workId);
        else if (witness === "effect")
          db.prepare(
            "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'late-effect', 'pending', 'unfinished')",
          ).run(f.old.workId);
        else if (witness === "capacity")
          db.prepare(
            "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
          ).run(f.old.workId, f.projectId);
        else await f.service.stopTask(f.taskId);
        assert.equal(coordination.hasRecoveryContinuation(f.old.workId), false);
        f.pause(false);
        await f.service.configureCapacity({
          key: randomUUID(),
          globalLimit: 1,
        });
        assert.equal(
          f.runtime.turns,
          2,
          "queued successor cannot use a cached exemption",
        );
        assert.equal(f.service.domain().task(f.taskId).state, "open");
      } finally {
        await close(f);
      }
    });
  }
});

test("late callback or known survivor after recorded continuation persistently holds and retracts successors", async (t) => {
  for (const risk of ["callback", "survivor"] as const) {
    await t.test(risk, async () => {
      const f = await heldFixture();
      let service = f.service;
      const callback = deferred();
      try {
        await service.resolveHeldExecution(f.receipt);
        const oldIntent = service.list().find((i) => i.workId === f.old.workId);
        const oldRequest = service
          .turnRequests()
          .find((r) => r.workId === f.old.workId);
        f.runtime.holdSuccessor = true;
        const event = await service
          .coordinationView()
          .postOperatorMessage(f.message);
        await until(
          () =>
            f.runtime.turns === 3 &&
            service.list().some((i) => i.state === "running"),
          "successor admitted",
        );
        const retained = audit(service, f.old.workId);
        const active = service.list().find((i) => i.state === "running");
        assert.ok(active?.threadId && active.turnId);
        const coordination = internals(service).coordination;
        const caller = coordination.deliveryCaller({
          threadId: active.threadId,
          turnId: active.turnId,
          callId: "completion-action-gate",
          tool: "ensemble_request_completion",
          arguments: { reviewedResultIds: [] },
        });
        assert.deepEqual(
          coordination.deliveryActionBlockers(caller, [], randomUUID()),
          [],
          "valid explicit recovery no longer blocks the current external completion action",
        );
        if (risk === "callback")
          service.registerExecutionCallback(f.old.workId, callback.promise);
        else
          service.holdKnownSurvivor(f.old.workId, "synthetic known survivor");
        assert.match(
          service.taskHold(f.taskId) ?? "",
          /Known unfinished execution/,
        );
        assert.equal(
          internals(service).coordination.hasRecoveryContinuation(f.old.workId),
          false,
        );
        assert.ok(
          coordination
            .deliveryActionBlockers(caller, [], randomUUID())
            .includes("task-writer-ambiguity-hold"),
        );
        assert.ok(
          coordination
            .deliveryActionBlockers(caller, [], randomUUID())
            .includes("unfinished-turn-request"),
        );
        callback.resolve();
        await callback.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.match(
          service.taskHold(f.taskId) ?? "",
          /Known unfinished execution/,
        );
        assert.deepEqual(
          service.list().find((i) => i.workId === f.old.workId),
          oldIntent,
        );
        assert.deepEqual(
          service.turnRequests().find((r) => r.workId === f.old.workId),
          oldRequest,
        );
        assert.deepEqual(audit(service, f.old.workId), retained);
        const successor = service
          .turnRequests()
          .find((r) => r.sequence > f.old.sequence);
        assert.equal(successor?.state, "held");
        f.runtime.successorGate.resolve();
        await until(
          () => f.runtime.completionResults.length === 1,
          "retracted successor cannot complete",
        );
        assert.equal(f.runtime.completionResults[0]?.success, false);
        assert.equal(service.domain().task(f.taskId).state, "open");
        await service.stop();
        service = f.makeService();
        await service.start();
        assert.match(
          service.taskHold(f.taskId) ?? "",
          /Known unfinished execution/,
        );
        assert.equal(
          internals(service).coordination.hasRecoveryContinuation(f.old.workId),
          false,
        );
        assert.deepEqual(audit(service, f.old.workId), retained);
        assert.equal(
          (await service.coordinationView().postOperatorMessage(f.message))
            .eventId,
          event.eventId,
        );
        assert.equal(f.runtime.turns, 3);
      } finally {
        callback.resolve();
        f.runtime.successorGate.resolve();
        await close(f, service);
      }
    });
  }
});

test("completed Stop history survives Resume without becoming a new recovery gate", async () => {
  const f = await heldFixture();
  try {
    await f.service.resolveHeldExecution(f.receipt);
    internals(f.service)
      .db.prepare(`INSERT INTO execution_stop_targets
      (workId, taskId, threadId, turnId, interruptState, terminalState, requestedAt)
      VALUES (?, ?, ?, ?, 'acknowledged', 'completed', 1)`)
      .run(f.old.workId, f.taskId, f.receipt.threadId, f.receipt.turnId);
    await f.service.stopTask(f.taskId);
    assert.equal(
      internals(f.service).state.reconciledAssignmentProof(f.old.workId),
      undefined,
    );
    await f.service.resumeTask(f.taskId);
    assert.ok(
      internals(f.service).state.reconciledAssignmentProof(f.old.workId),
    );
    await f.service.coordinationView().postOperatorMessage(f.message);
    await until(
      () => f.service.domain().task(f.taskId).state === "done",
      "resumed continuation completes",
    );
    assert.equal(f.runtime.turns, 3);
  } finally {
    await close(f);
  }
});

function required<T>(value: T | null | undefined): T {
  assert.ok(
    value !== null && value !== undefined,
    "Required fixture evidence is missing",
  );
  return value;
}

test("positively rejected archived resume stays held until keyed recovery, conversation replacement and a new operator message", async () => {
  const f = await heldFixture(true);
  try {
    const record = f.service
      .recoveryView()
      .find((r) => r.workId === f.old.workId) as unknown as {
      preTurnRejection?: { id: string; source: string };
    };
    assert.ok(
      record.preTurnRejection,
      "persist positive before-turn witness before context is lost",
    );
    assert.equal(record.preTurnRejection.source, "runtime");
    assert.equal(f.runtime.turns, 1);
    assert.throws(
      () => f.service.replaceConversation(required(f.old.assignmentId)),
      /unresolved execution/,
    );
    f.pause(true);
    const recoveryCommand = preTurnRecovery(f);
    const concurrent = await Promise.all([
      f.service.recoverPreTurnExecution(recoveryCommand),
      f.service.recoverPreTurnExecution(recoveryCommand),
    ]);
    assert.deepEqual(
      concurrent[0],
      concurrent[1],
      "same command concurrent replay is atomic",
    );
    assert.equal(f.runtime.turns, 1, "receipt replay must not dispatch");
    const beforeReplacement = {
      ...f.message,
      key: randomUUID(),
      message: "before replacement",
    };
    await f.service.coordinationView().postOperatorMessage(beforeReplacement);
    assert.equal(
      audit(f.service, f.old.workId),
      undefined,
      "message before explicit replacement cannot authorize",
    );
    f.service.replaceConversation(required(f.old.assignmentId));
    await f.service.coordinationView().postOperatorMessage(beforeReplacement);
    assert.equal(
      audit(f.service, f.old.workId),
      undefined,
      "replaying earlier message cannot upgrade authority",
    );
    await f.service.coordinationView().postOperatorMessage(f.message);
    assert.ok(audit(f.service, f.old.workId));
    f.runtime.rejectResume = false;
    f.pause(false);
    await until(() => f.runtime.turns === 2, "new conversation turn");
    await until(
      () => f.runtime.completionResults.length === 1,
      "fresh completion response",
    );
    assert.equal(
      f.runtime.completionResults[0]?.success,
      true,
      JSON.stringify(f.runtime.completionResults),
    );
    await until(
      () => f.service.domain().task(f.taskId).state === "done",
      "fresh completion",
    );
    assert.equal(
      f.runtime.threads,
      2,
      "new conversation must start a fresh thread",
    );
    assert.equal(
      f.runtime.prompts[1]?.includes("OLD_BATCH_SHOULD_NOT_REPLAY"),
      false,
    );
  } finally {
    await close(f);
  }
});

function adoption(
  f: Awaited<ReturnType<typeof heldFixture>>,
): HistoricalPreTurnAdoption {
  const rpcError = {
    code: -32600 as const,
    message: archivedResumeMessage("thread-1"),
  };
  return {
    key: randomUUID(),
    workId: f.old.workId,
    workRevision: required(f.receipt.workRevision),
    requestSequence: f.old.sequence,
    predecessorWorkId: required(f.old.previousWorkId),
    predecessorThreadId: "thread-1",
    processIdentity: f.runtime.identity,
    retainedReason: `Runtime submission or observation uncertain: Error: ${JSON.stringify(rpcError)}`,
    rpcError,
    evidence: {
      frozenSourceRevision: "1".repeat(40),
      frozenHarnessSha256: "2".repeat(64),
      evidenceSha256: "3".repeat(64),
      approvedDecisionSha256: "4".repeat(64),
      reviewReference: "https://example.test/review",
      approvalReference: "https://example.test/approval",
    },
    attestation: {
      beforeTurnRejected: true,
      noTurnSubmitted: true,
      independentlyReviewed: true,
    },
  };
}
function preTurnRecovery(
  f: Awaited<ReturnType<typeof heldFixture>>,
  witnessId?: string,
): PreTurnRecoveryCommand {
  assert.equal(f.receipt.kind, "pre-turn-rejection");
  return {
    key: randomUUID(),
    receipt: {
      ...f.receipt,
      kind: "pre-turn-rejection",
      workRevision: required(f.receipt.workRevision),
      threadId: null,
      turnId: null,
      witnessId:
        witnessId ??
        required(
          required(
            f.service.recoveryView().find((r) => r.workId === f.old.workId),
          ).preTurnRejection,
        ).id,
    },
  };
}

test("historical pre-turn proof requires explicit exact operator adoption and immutable command replay", async () => {
  const f = await heldFixture("historical");
  let service = f.service;
  try {
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.preTurnRejection,
      undefined,
    );
    const input = adoption(f);
    for (const changed of [
      { ...input, workRevision: input.workRevision + 1 },
      { ...input, requestSequence: input.requestSequence + 1 },
      { ...input, predecessorWorkId: "wrong-predecessor" },
      { ...input, predecessorThreadId: "wrong-thread" },
      {
        ...input,
        processIdentity: {
          ...input.processIdentity,
          processId: "different-process",
        },
      },
      { ...input, retainedReason: "different-reason" },
      {
        ...input,
        evidence: { ...input.evidence, frozenSourceRevision: "missing" },
      },
      {
        ...input,
        attestation: { ...input.attestation, noTurnSubmitted: false },
      },
    ])
      assert.throws(() =>
        service.adoptHistoricalPreTurnRejection(
          changed as HistoricalPreTurnAdoption,
        ),
      );
    const adopted = service.adoptHistoricalPreTurnRejection(input);
    assert.deepEqual(service.adoptHistoricalPreTurnRejection(input), adopted);
    assert.throws(
      () =>
        service.adoptHistoricalPreTurnRejection({
          ...input,
          evidence: { ...input.evidence, evidenceSha256: "5".repeat(64) },
        }),
      /key was reused/,
    );
    assert.equal(f.runtime.turns, 1);
    f.pause(true);
    const recovery = preTurnRecovery(f, adopted.witnessId);
    f.setVerified(false);
    await assert.rejects(
      service.recoverPreTurnExecution(recovery),
      /termination could not be verified/,
    );
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)?.holds
        .capacity,
      true,
    );
    f.setVerified(true);
    for (const receipt of [
      { ...recovery.receipt, witnessId: randomUUID() },
      { ...recovery.receipt, workRevision: recovery.receipt.workRevision + 1 },
      {
        ...recovery.receipt,
        requestSequence: recovery.receipt.requestSequence + 1,
      },
      { ...recovery.receipt, threadId: "thread-1" },
      {
        ...recovery.receipt,
        processIdentity: {
          ...f.runtime.identity,
          processStartedAt: "other-birth",
        },
      },
      { ...recovery.receipt, effects: "unknown" },
    ])
      await assert.rejects(async () =>
        service.recoverPreTurnExecution({
          key: randomUUID(),
          receipt,
        } as PreTurnRecoveryCommand),
      );
    const resolved = await service.recoverPreTurnExecution(recovery);
    assert.deepEqual(await service.recoverPreTurnExecution(recovery), resolved);
    await assert.rejects(
      async () =>
        service.recoverPreTurnExecution({
          ...recovery,
          receipt: { ...recovery.receipt, workspace: "reconciled" },
        }),
      /key was reused/,
    );
    const replace = {
      key: randomUUID(),
      assignmentId: required(f.old.assignmentId),
      expectedAssignmentVersion: Number(f.old.assignmentVersion),
      expectedConversationRevision: 1,
    };
    const route = required(
      runtimeOperatorRoutes(service).find(
        (r) => r.path === "/runtime/control/conversation-replace",
      ),
    );
    const fields = Object.fromEntries(
      Object.entries(replace).map(([k, v]) => [k, String(v)]),
    );
    await route.handler({ params: {}, fields, csrfToken: "fixture" });
    await route.handler({ params: {}, fields, csrfToken: "fixture" });
    assert.deepEqual(service.replaceConversationCommand(replace), {
      revision: 2,
    });
    assert.throws(
      () =>
        service.replaceConversationCommand({
          ...replace,
          expectedConversationRevision: 2,
        }),
      /key was reused/,
    );
    assert.throws(
      () =>
        service.replaceConversationCommand({ ...replace, key: randomUUID() }),
      /stale/,
    );
    const fresh = await service
      .coordinationView()
      .postOperatorMessage(f.message);
    const retained = audit(service, f.old.workId);
    const witness = service
      .recoveryView()
      .find((r) => r.workId === f.old.workId)?.preTurnRejection;
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.deepEqual(service.adoptHistoricalPreTurnRejection(input), adopted);
    assert.deepEqual(await service.recoverPreTurnExecution(recovery), resolved);
    assert.deepEqual(service.replaceConversationCommand(replace), {
      revision: 2,
    });
    assert.deepEqual(
      service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.preTurnRejection,
      witness,
    );
    assert.equal(
      (await service.coordinationView().postOperatorMessage(f.message)).eventId,
      fresh.eventId,
    );
    assert.deepEqual(audit(service, f.old.workId), retained);
    f.runtime.resumeError = undefined;
    f.runtime.rejectResume = false;
    f.pause(false, service);
    await until(
      () => service.domain().task(f.taskId).state === "done",
      "adopted fresh completion",
    );
    assert.equal(f.runtime.turns, 2);
    assert.equal(f.runtime.threads, 2);
    assert.doesNotMatch(
      required(f.runtime.prompts[1]),
      /OLD_BATCH_SHOULD_NOT_REPLAY/,
    );
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(service.domain().task(f.taskId).state, "done");
    assert.deepEqual(audit(service, f.old.workId), retained);
    assert.deepEqual(await service.recoverPreTurnExecution(recovery), resolved);
    assert.equal(f.runtime.turns, 2);
  } finally {
    await close(f, service);
  }
});

test("ambiguous resume errors and mismatched structured identities retain admitted ownership", async (t) => {
  for (const mode of [
    "historical",
    "timeout",
    "wrong-process",
    "wrong-thread",
  ] as const)
    await t.test(mode, async () => {
      const f = await heldFixture(mode);
      try {
        const record = required(
          f.service.recoveryView().find((r) => r.workId === f.old.workId),
        );
        assert.equal(record.preTurnRejection, undefined);
        assert.equal(record.intent.threadId, null);
        assert.equal(record.intent.turnId, null);
        assert.equal(record.holds.writer, true);
        assert.equal(record.holds.capacity, true);
        assert.equal(f.runtime.turns, 1);
        await assert.rejects(async () =>
          f.service.recoverPreTurnExecution({
            key: randomUUID(),
            receipt: {
              ...f.receipt,
              kind: "pre-turn-rejection",
              workRevision: required(f.receipt.workRevision),
              threadId: null,
              turnId: null,
              witnessId: randomUUID(),
            },
          }),
        );
        assert.throws(
          () =>
            f.service.replaceConversationCommand({
              key: randomUUID(),
              assignmentId: required(f.old.assignmentId),
              expectedAssignmentVersion: 1,
              expectedConversationRevision: 1,
            }),
          /unresolved execution/,
        );
      } finally {
        await close(f);
      }
    });
});

test("nullable receipt migration preserves existing bound-turn receipt and continuation audit material byte for byte", async () => {
  const f = await heldFixture();
  let service = f.service;
  try {
    f.pause(true);
    await service.resolveHeldExecution(f.receipt);
    await service.coordinationView().postOperatorMessage(f.message);
    const before = internals(service);
    const receipt = JSON.stringify(
      before.db.prepare("SELECT * FROM execution_recovery_receipts").all(),
    );
    const retained = JSON.stringify(audit(service, f.old.workId));
    const material = required(
      before.state.reconciledAssignmentProof(f.old.workId),
    ).material;
    await service.stop();
    const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='execution_recovery_receipts'",
        )
        .get() as { sql: string }
    ).sql;
    db.exec("PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE");
    db.exec(
      sql
        .replace("execution_recovery_receipts", "legacy_receipts")
        .replace("threadId TEXT,", "threadId TEXT NOT NULL,")
        .replace("turnId TEXT,", "turnId TEXT NOT NULL,"),
    );
    db.exec(
      "INSERT INTO legacy_receipts SELECT * FROM execution_recovery_receipts;DROP TABLE execution_recovery_receipts;ALTER TABLE legacy_receipts RENAME TO execution_recovery_receipts;COMMIT",
    );
    assert.equal(
      (
        db
          .prepare("PRAGMA table_info(execution_recovery_receipts)")
          .all() as Array<{ name: string; notnull: number }>
      ).find((c) => c.name === "threadId")?.notnull,
      1,
    );
    db.close();
    service = f.makeService();
    await service.start();
    const after = internals(service);
    assert.equal(
      JSON.stringify(
        after.db.prepare("SELECT * FROM execution_recovery_receipts").all(),
      ),
      receipt,
    );
    assert.equal(JSON.stringify(audit(service, f.old.workId)), retained);
    assert.equal(
      after.state.reconciledAssignmentProof(f.old.workId)?.material,
      material,
    );
    assert.equal(
      after.coordination.hasRecoveryContinuation(f.old.workId),
      true,
    );
    assert.deepEqual(after.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      (
        after.db.prepare("PRAGMA foreign_keys").get() as {
          foreign_keys: number;
        }
      ).foreign_keys,
      1,
    );
    assert.equal(
      (
        after.db
          .prepare("PRAGMA table_info(execution_recovery_receipts)")
          .all() as Array<{ name: string; notnull: number }>
      ).find((c) => c.name === "threadId")?.notnull,
      0,
    );
    assert.equal(
      (await service.coordinationView().postOperatorMessage(f.message)).eventId,
      JSON.parse(retained).operatorEventId,
    );
    f.pause(false, service);
    await until(
      () => service.domain().task(f.taskId).state === "done",
      "legacy continuation after migration",
    );
  } finally {
    await close(f, service);
  }
});

test("pre-turn witness is exposed safely through operator API and both shared runtime history pages", async () => {
  const f = await heldFixture(true);
  try {
    const witness = required(
      required(f.service.recoveryView().find((r) => r.workId === f.old.workId))
        .preTurnRejection,
    );
    const api = new OperatorApi(f.service, [f.directory]);
    assert.deepEqual(
      (
        await api.readAssignmentRecovery(required(f.old.assignmentId))
      ).data.records.find((r) => r.workId === f.old.workId)?.preTurnRejection,
      witness,
    );
    for (const path of [
      "/runtime/task/:taskId",
      "/runtime/assignment/:assignmentId",
    ]) {
      const route = required(
        runtimeOperatorRoutes(f.service).find((r) => r.path === path),
      );
      const result = await route.handler({
        params: {
          taskId: f.taskId,
          assignmentId: required(f.old.assignmentId),
        },
        fields: {},
        csrfToken: "fixture",
      });
      assert.equal(result.kind, "html");
      if (result.kind === "html")
        assert.match(result.body, new RegExp(witness.id));
    }
    const adoptRoute = required(
      runtimeOperatorRoutes(f.service).find(
        (r) => r.path === "/runtime/control/pre-turn/adopt",
      ),
    );
    assert.throws(() =>
      adoptRoute.handler({
        params: {},
        fields: { payload: "{}" },
        csrfToken: "fixture",
      }),
    );
  } finally {
    await close(f);
  }
});

test("pre-turn continuation revalidates witness, receipt, effects and current admission gates", async (t) => {
  for (const gate of [
    "witness",
    "receipt",
    "discriminator",
    "effect",
    "capacity",
    "stop-target",
    "profile",
    "dependency",
    "stop",
  ] as const)
    await t.test(gate, async () => {
      const f = await heldFixture(true);
      try {
        f.pause(true);
        await f.service.recoverPreTurnExecution(preTurnRecovery(f));
        f.service.replaceConversation(required(f.old.assignmentId));
        const event = await f.service
          .coordinationView()
          .postOperatorMessage(f.message);
        const retained = audit(f.service, f.old.workId);
        assert.ok(retained);
        const { db, coordination } = internals(f.service);
        if (gate === "witness")
          db.prepare(
            "UPDATE execution_pre_turn_rejections SET evidenceMaterial='{}' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "receipt")
          db.prepare(
            "UPDATE execution_recovery_receipts SET workspaceDisposition='reconciled' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "discriminator")
          db.prepare(
            "UPDATE execution_pre_turn_receipts SET witnessMaterial='{}' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "effect")
          db.prepare(
            "UPDATE execution_pending_effects SET state='pending' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "capacity")
          db.prepare(
            "INSERT INTO execution_capacity_reservations (workId,projectId) VALUES (?,?)",
          ).run(f.old.workId, f.projectId);
        if (gate === "stop-target")
          db.prepare(
            "INSERT INTO execution_stop_targets (taskId,workId,threadId,turnId,interruptState,terminalState,requestedAt) VALUES (?,?,NULL,NULL,'unbound','unknown',1)",
          ).run(f.taskId, f.old.workId);
        if (gate === "profile")
          command(f.service, {
            type: "profile.configure",
            profileId: f.profileId,
            expectedVersion: 1,
            instructions: "changed profile",
          });
        if (gate === "dependency") {
          const blockerTaskId = randomUUID();
          command(f.service, {
            type: "task.create",
            projectId: f.projectId,
            taskId: blockerTaskId,
            title: "Blocker",
            outcome: "Must finish",
            ready: false,
          });
          command(f.service, {
            type: "dependency.add",
            projectId: f.projectId,
            taskId: f.taskId,
            blockerTaskId,
            expectedVersion: Number(f.service.domain().task(f.taskId).version),
          });
        }
        if (gate === "stop") await f.service.stopTask(f.taskId);
        if (!["profile", "dependency"].includes(gate))
          assert.equal(
            coordination.hasRecoveryContinuation(f.old.workId),
            false,
          );
        f.pause(false);
        await f.service.configureCapacity({
          key: randomUUID(),
          globalLimit: 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(f.runtime.turns, 1);
        assert.equal(f.service.domain().task(f.taskId).state, "open");
        assert.deepEqual(audit(f.service, f.old.workId), retained);
        assert.equal(
          (await f.service.coordinationView().postOperatorMessage(f.message))
            .eventId,
          event.eventId,
        );
      } finally {
        await close(f);
      }
    });
});

test("late callback and known survivor persistently invalidate pre-turn continuation and retract successors across restart", async (t) => {
  for (const risk of ["callback", "survivor"] as const)
    await t.test(risk, async () => {
      const f = await heldFixture(true);
      let service = f.service;
      const callback = deferred();
      try {
        f.pause(true);
        await service.recoverPreTurnExecution(preTurnRecovery(f));
        service.replaceConversation(required(f.old.assignmentId));
        await service.coordinationView().postOperatorMessage(f.message);
        const retained = audit(service, f.old.workId);
        const receipt = internals(service)
          .db.prepare(
            "SELECT * FROM execution_recovery_receipts WHERE workId=?",
          )
          .get(f.old.workId);
        const witness = service
          .recoveryView()
          .find((r) => r.workId === f.old.workId)?.preTurnRejection;
        f.runtime.rejectResume = false;
        f.runtime.holdSuccessor = true;
        f.pause(false);
        await until(() => f.runtime.turns === 2, "admitted successor");
        if (risk === "callback")
          service.registerExecutionCallback(f.old.workId, callback.promise);
        else
          service.holdKnownSurvivor(
            f.old.workId,
            "known pre-turn process survivor",
          );
        assert.match(
          service.taskHold(f.taskId) ?? "",
          /Known unfinished execution/,
        );
        assert.equal(
          internals(service).coordination.hasRecoveryContinuation(f.old.workId),
          false,
        );
        assert.equal(
          service.turnRequests().find((r) => r.sequence > f.old.sequence)
            ?.state,
          "held",
        );
        callback.resolve();
        await callback.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        f.runtime.successorGate.resolve();
        await until(
          () => f.runtime.completionResults.length === 1,
          "successor retracted",
        );
        assert.equal(f.runtime.completionResults[0]?.success, false);
        await service.stop();
        service = f.makeService();
        await service.start();
        assert.match(
          service.taskHold(f.taskId) ?? "",
          /Known unfinished execution/,
        );
        assert.equal(
          internals(service).coordination.hasRecoveryContinuation(f.old.workId),
          false,
        );
        assert.deepEqual(audit(service, f.old.workId), retained);
        assert.deepEqual(
          internals(service)
            .db.prepare(
              "SELECT * FROM execution_recovery_receipts WHERE workId=?",
            )
            .get(f.old.workId),
          receipt,
        );
        assert.deepEqual(
          service.recoveryView().find((r) => r.workId === f.old.workId)
            ?.preTurnRejection,
          witness,
        );
        assert.equal(service.domain().task(f.taskId).state, "open");
      } finally {
        callback.resolve();
        f.runtime.successorGate.resolve();
        await close(f, service);
      }
    });
});

test("structured pre-turn witness survives restart before recovery without automatic dispatch", async () => {
  const f = await heldFixture(true);
  let service = f.service;
  try {
    f.pause(true);
    const before = required(
      service.recoveryView().find((r) => r.workId === f.old.workId),
    ).preTurnRejection;
    const recovery = preTurnRecovery(f);
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.deepEqual(
      service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.preTurnRejection,
      before,
    );
    assert.equal(f.runtime.turns, 1);
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)?.holds
        .capacity,
      true,
    );
    await service.recoverPreTurnExecution(recovery);
    assert.equal(f.runtime.turns, 1);
    service.replaceConversationCommand({
      key: randomUUID(),
      assignmentId: required(f.old.assignmentId),
      expectedAssignmentVersion: 1,
      expectedConversationRevision: 1,
    });
    await service.coordinationView().postOperatorMessage(f.message);
    f.runtime.rejectResume = false;
    f.pause(false, service);
    await until(
      () => service.domain().task(f.taskId).state === "done",
      "restarted pre-turn completion",
    );
    assert.equal(f.runtime.turns, 2);
    assert.equal(f.runtime.threads, 2);
  } finally {
    await close(f, service);
  }
});

test("receipt migration rejects unknown column order, constraints, indexes and triggers without changing retained rows", async (t) => {
  for (const unknown of [
    "column-order",
    "literal-case",
    "index",
    "trigger",
  ] as const)
    await t.test(unknown, async () => {
      const f = await heldFixture();
      let service = f.service;
      try {
        f.pause(true);
        await service.resolveHeldExecution(f.receipt);
        await service.coordinationView().postOperatorMessage(f.message);
        const retained = JSON.stringify(audit(service, f.old.workId));
        await service.stop();
        const db = new DatabaseSync(
          join(f.directory, "data", "standalone.sqlite"),
        );
        if (unknown === "column-order" || unknown === "literal-case") {
          const sql = (
            db
              .prepare(
                "SELECT sql FROM sqlite_master WHERE name='execution_recovery_receipts'",
              )
              .get() as { sql: string }
          ).sql;
          db.exec("PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE");
          const renamed = sql.replace(
            /"?execution_recovery_receipts"?/,
            "unknown_receipts",
          );
          db.exec(
            unknown === "literal-case"
              ? renamed.replace("'settled'", "'SETTLED'")
              : renamed.replace(
                  "threadId TEXT,\n      turnId TEXT,",
                  "turnId TEXT,\n      threadId TEXT,",
                ),
          );
          const columns = (
            db.prepare("PRAGMA table_info(unknown_receipts)").all() as Array<{
              name: string;
            }>
          )
            .map((c) => c.name)
            .join(",");
          const selected = columns
            .split(",")
            .map((column) =>
              unknown === "literal-case" && column === "effectsState"
                ? "'SETTLED'"
                : column,
            )
            .join(",");
          db.exec(
            `INSERT INTO unknown_receipts (${columns}) SELECT ${selected} FROM execution_recovery_receipts;DROP TABLE execution_recovery_receipts;ALTER TABLE unknown_receipts RENAME TO execution_recovery_receipts;COMMIT`,
          );
        } else if (unknown === "index")
          db.exec(
            "CREATE INDEX custom_receipt_index ON execution_recovery_receipts(processId)",
          );
        else
          db.exec(
            "CREATE TRIGGER custom_receipt_trigger AFTER UPDATE ON execution_recovery_receipts BEGIN SELECT 1;END",
          );
        const rows = JSON.stringify(
          db.prepare("SELECT * FROM execution_recovery_receipts").all(),
        );
        const schema = (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE name='execution_recovery_receipts'",
            )
            .get() as { sql: string }
        ).sql;
        db.close();
        service = f.makeService();
        await assert.rejects(
          service.start(),
          /Unrecognized recovery receipt schema/,
        );
        const after = new DatabaseSync(
          join(f.directory, "data", "standalone.sqlite"),
        );
        assert.equal(
          JSON.stringify(
            after.prepare("SELECT * FROM execution_recovery_receipts").all(),
          ),
          rows,
        );
        assert.equal(
          (
            after
              .prepare(
                "SELECT sql FROM sqlite_master WHERE name='execution_recovery_receipts'",
              )
              .get() as { sql: string }
          ).sql,
          schema,
        );
        assert.equal(
          JSON.stringify(
            after
              .prepare(
                "SELECT * FROM coordination_recovery_continuations WHERE workId=?",
              )
              .get(f.old.workId),
          ),
          retained,
        );
        after.close();
      } finally {
        await close(f, service);
      }
    });
});
