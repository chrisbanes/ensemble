import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "./temp.js";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import type { NoTurnRecoveryCommand } from "../src/standalone/pre-turn-recovery.js";
import type { RuntimeProcessIdentity } from "../src/standalone/recovery-types.js";

class NoTurnRuntime implements Runtime {
  rejectStart = true;
  threads = 0;
  turnInvocations: string[] = [];
  completions: RuntimeToolResult[] = [];
  hold = false;
  release: (() => void) | undefined;
  readonly identity: RuntimeProcessIdentity = {
    processId: "synthetic-no-turn",
    processStartedAt: "2026-10-03T10:00:00.000Z",
    bootId: "synthetic-boot",
  };
  listener: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  async start() {}
  async stop() {
    this.release?.();
  }
  processIdentity() {
    return this.identity;
  }
  async startThread() {
    const id = `possibly-created-idle-thread-${++this.threads}`;
    if (this.rejectStart) throw new Error("Runtime stopped");
    return id;
  }
  async resumeThread() {
    throw new Error("No predecessor thread should be resumed");
  }
  async startTurn(_thread: string, _workspace: string, prompt: string) {
    this.turnInvocations.push(prompt); // synchronous write-ahead invocation witness
    return `turn-${this.turnInvocations.length}`;
  }
  async interruptTurn() {}
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.listener = listener;
  }
  onTurn: ((threadId: string, turnId: string) => void) | undefined;
  async waitForTurn(threadId: string, turnId: string) {
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    assert.ok(this.listener);
    this.onTurn?.(threadId, turnId);
    this.completions.push(
      await this.listener({
        threadId,
        turnId,
        callId: `completion-${turnId}`,
        tool: "ensemble_request_completion",
        arguments: { reviewedResultIds: [] },
      }),
    );
    return "completed" as const;
  }
}
function db(service: StandaloneService) {
  return (service as unknown as { db: DatabaseSync }).db;
}
function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-no-turn-"));
  const runtime = new NoTurnRuntime();
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
                reason: "Independent termination unavailable",
              };
        },
      },
    });
  const service = makeService();
  await service.start();
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Preserved profile",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "No turn",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: true,
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
    title: "Historical",
    outcome: "Complete fresh work",
    ready: true,
  });
  await service.provisionTask(taskId);
  const assignment = required(service.domain().assignments(taskId)[0]);
  const assignmentId = String(assignment.id);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(service.domain().task(taskId).version),
    title: "Current",
  });
  await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  const initial = required(
    service.turnRequests().find((r) => r.workId.endsWith(":initial")),
  );
  assert.equal(initial.state, "held");
  const oldMessage = {
    key: randomUUID(),
    taskId,
    recipientAssignmentId: assignmentId,
    expectedAssignmentVersion: 1,
    message: "OLD_BATCH_MUST_NOT_REPLAY",
  };
  await service.coordinationView().postOperatorMessage(oldMessage);
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    paused: false,
  });
  await until(
    () =>
      service
        .turnRequests()
        .some((r) => r.workId !== initial.workId && r.state === "held"),
    "admitted no-turn hold",
  );
  const old = required(
    service
      .turnRequests()
      .find((r) => r.workId !== initial.workId && r.state === "held"),
  );
  const row = required(
    service.recoveryView().find((r) => r.workId === old.workId),
  );
  assert.equal(row.intent.threadId, null);
  assert.equal(row.intent.turnId, null);
  assert.equal(runtime.turnInvocations.length, 0);
  assert.equal(runtime.threads, 1);
  const binding = required(
    db(service)
      .prepare(
        "SELECT conversationRevision FROM task_execution_bindings WHERE workId=?",
      )
      .get(old.workId) as { conversationRevision: number } | undefined,
  );
  const admission = required(
    db(service)
      .prepare("SELECT sequence FROM task_writer_admissions WHERE workId=?")
      .get(old.workId) as { sequence: number } | undefined,
  );
  const adoption = {
    key: randomUUID(),
    kind: "historical-no-turn-submission" as const,
    workId: old.workId,
    workRevision: required(row.generation.workRevision),
    requestSequence: row.generation.requestSequence,
    conversationRevision: binding.conversationRevision,
    writerSequence: admission.sequence,
    processIdentity: required(row.processIdentity),
    retainedReason: required(old.reason),
    evidence: {
      frozenSourceRevision: "a".repeat(40),
      frozenHarnessSha256: "b".repeat(64),
      evidenceSha256: "c".repeat(64),
      approvedDecisionSha256: "d".repeat(64),
      invocationLedgerSha256: createHash("sha256")
        .update(JSON.stringify(runtime.turnInvocations))
        .digest("hex"),
      reviewReference: "https://example.com/review",
      approvalReference: "https://example.com/approval",
    },
    attestation: {
      completeSynchronousWriteAheadLedger: true as const,
      noStartTurnInvocation: true as const,
      independentlyReviewed: true as const,
      idleThreadMayExist: true as const,
    },
  };
  const message = {
    key: randomUUID(),
    taskId,
    recipientAssignmentId: assignmentId,
    expectedAssignmentVersion: 1,
    message: "NEW_COMPLETION_ONLY",
  };
  return {
    directory,
    runtime,
    service,
    makeService,
    projectId,
    taskId,
    profileId,
    assignmentId,
    old,
    initial,
    adoption,
    message,
    oldMessage,
    setVerified: (v: boolean) => {
      verified = v;
    },
  };
}
async function close(
  f: Awaited<ReturnType<typeof fixture>>,
  service = f.service,
) {
  await service.stop();
  rmSync(f.directory, { recursive: true, force: true });
}

function recovery(
  f: Awaited<ReturnType<typeof fixture>>,
  witnessId: string,
): NoTurnRecoveryCommand {
  return {
    key: randomUUID(),
    receipt: {
      kind: "no-turn-submission",
      witnessId,
      workId: f.old.workId,
      workRevision: f.adoption.workRevision,
      requestSequence: f.adoption.requestSequence,
      threadId: null,
      turnId: null,
      processIdentity: f.runtime.identity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    },
  };
}
function snapshot(service: StandaloneService, workId: string) {
  const database = db(service);
  return JSON.stringify({
    witness: database
      .prepare("SELECT * FROM execution_no_turn_submissions WHERE workId=?")
      .get(workId),
    receipt: database
      .prepare("SELECT * FROM execution_recovery_receipts WHERE workId=?")
      .get(workId),
    discriminator: database
      .prepare("SELECT * FROM execution_no_turn_receipts WHERE workId=?")
      .get(workId),
    audit: database
      .prepare(
        "SELECT * FROM coordination_recovery_continuations WHERE workId=?",
      )
      .get(workId),
  });
}
function replace(f: Awaited<ReturnType<typeof fixture>>, service = f.service) {
  return service.replaceConversationCommand({
    key: randomUUID(),
    assignmentId: f.assignmentId,
    expectedAssignmentVersion: 1,
    expectedConversationRevision: f.adoption.conversationRevision,
  });
}

test("authenticated historical no-turn adoption recovers exact admitted ownership without claiming thread noncreation", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const before = db(service)
      .prepare("SELECT * FROM execution_request_refusals WHERE workId=?")
      .get(f.initial.workId);
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.noTurnSubmission,
      undefined,
    );
    const adopted = service.adoptHistoricalNoTurnSubmission(f.adoption);
    assert.deepEqual(
      service.adoptHistoricalNoTurnSubmission(f.adoption),
      adopted,
    );
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)?.holds
        .capacity,
      true,
    );
    assert.equal(f.runtime.turnInvocations.length, 0);
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.deepEqual(
      service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.noTurnSubmission,
      {
        id: adopted.witnessId,
        source: "operator-adopted",
        idleThreadMayExist: true,
      },
    );
    const input = recovery(f, adopted.witnessId);
    f.setVerified(false);
    await assert.rejects(service.recoverNoTurnExecution(input), /termination/);
    assert.equal(
      service.recoveryView().find((r) => r.workId === f.old.workId)?.holds
        .capacity,
      true,
    );
    f.setVerified(true);
    const results = await Promise.all([
      service.recoverNoTurnExecution(input),
      service.recoverNoTurnExecution(input),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await service.recoverNoTurnExecution(input), results[0]);
    assert.equal(f.runtime.turnInvocations.length, 0);
    assert.equal(
      service.turnRequests().find((r) => r.workId === f.old.workId)?.state,
      "held",
    );
    assert.equal(
      service.list().find((i) => i.workId === f.old.workId)?.state,
      "reconciled",
    );
    assert.equal(
      db(service)
        .prepare(
          "SELECT COUNT(*) AS n FROM execution_pending_effects WHERE workId=? AND state='pending'",
        )
        .get(f.old.workId)?.n,
      0,
    );
    await service.coordinationView().postOperatorMessage({
      ...f.message,
      message: "PRE_REPLACEMENT_NOT_AUTHORITY",
    });
    assert.equal(
      db(service)
        .prepare(
          "SELECT 1 FROM coordination_recovery_continuations WHERE workId=?",
        )
        .get(f.old.workId),
      undefined,
    );
    const replacement = {
      key: randomUUID(),
      assignmentId: f.assignmentId,
      expectedAssignmentVersion: 1,
      expectedConversationRevision: f.adoption.conversationRevision,
    };
    assert.deepEqual(service.replaceConversationCommand(replacement), {
      revision: 2,
    });
    assert.deepEqual(service.replaceConversationCommand(replacement), {
      revision: 2,
    });
    await service.coordinationView().postOperatorMessage({
      ...f.message,
      message: "PRE_REPLACEMENT_NOT_AUTHORITY",
    });
    assert.equal(
      db(service)
        .prepare(
          "SELECT 1 FROM coordination_recovery_continuations WHERE workId=?",
        )
        .get(f.old.workId),
      undefined,
    );
    f.runtime.rejectStart = false;
    const fresh = { ...f.message, key: randomUUID() };
    await service.coordinationView().postOperatorMessage(fresh);
    await until(
      () => service.domain().task(f.taskId).state === "done",
      "fresh R4 completion",
    );
    assert.equal(f.runtime.turnInvocations.length, 1);
    assert.equal(f.runtime.threads, 2);
    assert.ok(
      f.runtime.turnInvocations.every(
        (prompt) => !prompt.includes("OLD_BATCH_MUST_NOT_REPLAY"),
      ),
    );
    assert.equal(f.runtime.completions[0]?.success, true);
    const material = snapshot(service, f.old.workId);
    const delivery = service.coordinationView().readTask(f.taskId);
    assert.ok(JSON.stringify(delivery).includes("operator-reconciled"));
    assert.deepEqual(
      db(service)
        .prepare("SELECT * FROM execution_request_refusals WHERE workId=?")
        .get(f.initial.workId),
      before,
    );
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.deepEqual(
      service.adoptHistoricalNoTurnSubmission(f.adoption),
      adopted,
    );
    assert.deepEqual(await service.recoverNoTurnExecution(input), results[0]);
    assert.deepEqual(service.replaceConversationCommand(replacement), {
      revision: 2,
    });
    await service.coordinationView().postOperatorMessage(fresh);
    assert.equal(snapshot(service, f.old.workId), material);
    assert.equal(f.runtime.turnInvocations.length, 1);
  } finally {
    await close(f, service);
  }
});

test("no-turn adoption rejects stale generation, missing attestation, altered keys and predecessor identity", async (t) => {
  for (const field of [
    "work",
    "revision",
    "sequence",
    "conversation",
    "writer",
    "process",
    "birth",
    "boot",
    "reason",
    "digest",
    "ledger",
    "incomplete",
    "called-turn",
    "unreviewed",
    "idle-denied",
    "predecessor",
    "identity",
    "capacity",
  ] as const)
    await t.test(field, async () => {
      const f = await fixture();
      try {
        const input = structuredClone(f.adoption);
        if (field === "work") input.workId = "other";
        if (field === "revision") input.workRevision++;
        if (field === "sequence") input.requestSequence++;
        if (field === "conversation") input.conversationRevision++;
        if (field === "writer") input.writerSequence++;
        if (field === "process") input.processIdentity.processId = "other";
        if (field === "birth") input.processIdentity.processStartedAt = "other";
        if (field === "boot") input.processIdentity.bootId = "other";
        if (field === "reason") input.retainedReason = "Other error";
        if (field === "digest") input.evidence.frozenHarnessSha256 = "invalid";
        if (field === "ledger")
          input.evidence.invocationLedgerSha256 = "invalid";
        if (field === "incomplete")
          Object.assign(input.attestation, {
            completeSynchronousWriteAheadLedger: false,
          });
        if (field === "called-turn")
          Object.assign(input.attestation, { noStartTurnInvocation: false });
        if (field === "unreviewed")
          Object.assign(input.attestation, { independentlyReviewed: false });
        if (field === "idle-denied")
          Object.assign(input.attestation, { idleThreadMayExist: false });
        if (field === "predecessor")
          db(f.service)
            .prepare(
              "UPDATE execution_request_predecessors SET predecessorKnown=0 WHERE workId=?",
            )
            .run(f.old.workId);
        if (field === "identity")
          db(f.service)
            .prepare(
              "UPDATE execution_recovery_identities SET threadId='unknown-bound-thread' WHERE workId=?",
            )
            .run(f.old.workId);
        if (field === "capacity")
          db(f.service)
            .prepare(
              "DELETE FROM execution_capacity_reservations WHERE workId=?",
            )
            .run(f.old.workId);
        assert.throws(() => f.service.adoptHistoricalNoTurnSubmission(input));
        assert.equal(
          db(f.service)
            .prepare(
              "SELECT 1 FROM execution_no_turn_submissions WHERE workId=?",
            )
            .get(f.old.workId),
          undefined,
        );
        assert.equal(f.runtime.turnInvocations.length, 0);
      } finally {
        await close(f);
      }
    });
  const f = await fixture();
  try {
    const adopted = f.service.adoptHistoricalNoTurnSubmission(f.adoption);
    assert.throws(
      () =>
        f.service.adoptHistoricalNoTurnSubmission({
          ...f.adoption,
          retainedReason: "changed",
        }),
      /key.*different material/,
    );
    assert.throws(
      () =>
        f.service.replaceConversationCommand({
          key: f.adoption.key,
          assignmentId: f.assignmentId,
          expectedAssignmentVersion: 1,
          expectedConversationRevision: 1,
        }),
      /key.*different material/,
    );
    const input = recovery(f, adopted.witnessId);
    await assert.rejects(
      f.service.resolveHeldExecution(input.receipt),
      /keyed command/,
    );
    await assert.rejects(
      f.service.recoverNoTurnExecution({
        ...input,
        receipt: { ...input.receipt, witnessId: randomUUID() },
      }),
      /persisted witness/,
    );
    await assert.rejects(
      f.service.recoverPreTurnExecution({
        ...input,
        receipt: { ...input.receipt, kind: "pre-turn-rejection" },
      }),
      /pre-turn|receipt kinds/i,
    );
    assert.equal(
      f.service.recoveryView().find((r) => r.workId === f.old.workId)?.holds
        .capacity,
      true,
    );
  } finally {
    await close(f);
  }
});

test("R4 proof and current gates are revalidated after operator audit, including malformed mixed proof", async (t) => {
  for (const gate of [
    "witness",
    "receipt",
    "discriminator",
    "command",
    "predecessor",
    "mixed",
    "effect",
    "capacity",
    "stop-target",
    "profile",
    "dependency",
    "paused",
    "Stop",
  ] as const)
    await t.test(gate, async () => {
      const f = await fixture();
      try {
        const adopted = f.service.adoptHistoricalNoTurnSubmission(f.adoption);
        await f.service.recoverNoTurnExecution(recovery(f, adopted.witnessId));
        replace(f);
        command(f.service, {
          type: "project.configure",
          projectId: f.projectId,
          expectedVersion: Number(
            f.service.domain().project(f.projectId).version,
          ),
          paused: true,
        });
        await f.service.coordinationView().postOperatorMessage(f.message);
        const audit = JSON.stringify(
          db(f.service)
            .prepare(
              "SELECT * FROM coordination_recovery_continuations WHERE workId=?",
            )
            .get(f.old.workId),
        );
        assert.notEqual(audit, undefined);
        const d = db(f.service);
        if (gate === "witness")
          d.prepare(
            "UPDATE execution_no_turn_submissions SET evidenceMaterial='{}' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "receipt")
          d.prepare(
            "UPDATE execution_recovery_receipts SET processId='changed' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "discriminator")
          d.prepare(
            "UPDATE execution_no_turn_receipts SET witnessMaterial='{}' WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "command")
          d.prepare(
            "UPDATE execution_pre_turn_commands SET payloadMaterial='{}' WHERE commandKey=?",
          ).run(f.adoption.key);
        if (gate === "predecessor")
          d.prepare(
            "UPDATE execution_request_predecessors SET predecessorKnown=0 WHERE workId=?",
          ).run(f.old.workId);
        if (gate === "mixed")
          d.prepare(
            "INSERT INTO execution_pre_turn_rejections VALUES (?,?,'operator-adopted','{}','{}')",
          ).run(randomUUID(), f.old.workId);
        if (gate === "effect")
          d.prepare(
            "INSERT INTO execution_pending_effects VALUES (?,?,'pending','late')",
          ).run(f.old.workId, "late-effect");
        if (gate === "capacity")
          d.prepare(
            "INSERT INTO execution_capacity_reservations (workId,projectId) VALUES (?,?)",
          ).run(f.old.workId, f.projectId);
        if (gate === "stop-target")
          d.prepare(
            "INSERT INTO execution_stop_targets(taskId,workId,threadId,turnId,interruptState,terminalState,requestedAt) VALUES (?,?,NULL,NULL,'unbound','unknown',1)",
          ).run(f.taskId, f.old.workId);
        if (gate === "profile")
          command(f.service, {
            type: "profile.configure",
            profileId: f.profileId,
            expectedVersion: Number(
              f.service.domain().profile(f.profileId).version,
            ),
            instructions: "changed profile",
          });
        if (gate === "dependency") {
          const blockerTaskId = randomUUID();
          command(f.service, {
            type: "task.create",
            projectId: f.projectId,
            taskId: blockerTaskId,
            title: "Blocker",
            outcome: "Unfinished",
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
        if (gate === "Stop") await f.service.stopTask(f.taskId);
        f.runtime.rejectStart = false;
        if (gate !== "paused")
          command(f.service, {
            type: "project.configure",
            projectId: f.projectId,
            expectedVersion: Number(
              f.service.domain().project(f.projectId).version,
            ),
            paused: false,
          });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(f.runtime.turnInvocations.length, 0);
        assert.equal(
          JSON.stringify(
            d
              .prepare(
                "SELECT * FROM coordination_recovery_continuations WHERE workId=?",
              )
              .get(f.old.workId),
          ),
          audit,
        );
        await f.service.coordinationView().postOperatorMessage(f.message);
        assert.equal(f.runtime.turnInvocations.length, 0);
      } finally {
        await close(f);
      }
    });
});

test("R4 late callback and known survivor retract successors and persist hold after callback end and restart", async (t) => {
  for (const risk of ["callback", "survivor"] as const)
    await t.test(risk, async () => {
      const f = await fixture();
      let service = f.service;
      try {
        const adopted = service.adoptHistoricalNoTurnSubmission(f.adoption);
        await service.recoverNoTurnExecution(recovery(f, adopted.witnessId));
        replace(f);
        f.runtime.rejectStart = false;
        f.runtime.hold = true;
        await service.coordinationView().postOperatorMessage(f.message);
        await until(
          () => f.runtime.turnInvocations.length === 1,
          "successor admitted",
        );
        const material = snapshot(service, f.old.workId);
        if (risk === "callback")
          service.registerExecutionCallback(f.old.workId, Promise.resolve());
        else
          service.holdKnownSurvivor(
            f.old.workId,
            "Known late no-turn survivor after continuation",
          );
        await until(
          () => Boolean(service.taskHold(f.taskId)),
          "persistent ambiguity hold",
        );
        f.runtime.release?.();
        await until(
          () => service.list().every((i) => i.state !== "running"),
          "successor retracted",
        );
        assert.notEqual(service.domain().task(f.taskId).state, "done");
        await service.stop();
        service = f.makeService();
        await service.start();
        assert.ok(service.taskHold(f.taskId));
        assert.equal(snapshot(service, f.old.workId), material);
        assert.equal(f.runtime.turnInvocations.length, 1);
      } finally {
        await close(f, service);
      }
    });
});

test("authenticated no-turn routes acknowledge bounded witnesses on task, assignment and curated API views", async () => {
  const f = await fixture();
  try {
    const routes = runtimeOperatorRoutes(f.service);
    const route = required(
      routes.find((r) => r.path === "/runtime/control/no-turn/adopt"),
    );
    assert.deepEqual(
      await route.handler({
        fields: { payload: JSON.stringify(f.adoption) },
        csrfToken: "fixture",
      } as never),
      { kind: "redirect", location: "/runtime" },
    );
    const witness = required(
      f.service.recoveryView().find((r) => r.workId === f.old.workId)
        ?.noTurnSubmission,
    );
    for (const path of [
      "/runtime/task/:taskId",
      "/runtime/assignment/:assignmentId",
    ]) {
      const page = required(routes.find((r) => r.path === path));
      const response = await page.handler({
        params: { taskId: f.taskId, assignmentId: f.assignmentId },
        fields: {},
        csrfToken: "fixture",
      } as never);
      assert.equal(response.kind, "html");
      if (response.kind === "html") {
        assert.ok(response.body.includes(witness.id));
        assert.ok(response.body.includes("idle thread may exist"));
      }
    }
    const curated = await new OperatorApi(f.service, [
      f.directory,
    ]).readAssignmentRecovery(f.assignmentId);
    assert.ok(JSON.stringify(curated).includes(witness.id));
    assert.ok(
      !JSON.stringify(curated).includes(
        f.adoption.evidence.invocationLedgerSha256,
      ),
    );
    const recoverRoute = required(
      routes.find((r) => r.path === "/runtime/control/no-turn/recover"),
    );
    const input = recovery(f, witness.id);
    assert.deepEqual(
      await recoverRoute.handler({
        fields: { payload: JSON.stringify(input) },
        csrfToken: "fixture",
      } as never),
      { kind: "redirect", location: "/runtime" },
    );
  } finally {
    await close(f);
  }
});

test("R4 current external completion actions and terminal completion reject invalidated historical proof", async () => {
  const f = await fixture();
  try {
    const adopted = f.service.adoptHistoricalNoTurnSubmission(f.adoption);
    await f.service.recoverNoTurnExecution(recovery(f, adopted.witnessId));
    replace(f);
    let before = snapshot(f.service, f.old.workId);
    let checked = false;
    f.runtime.onTurn = (threadId, turnId) => {
      before = snapshot(f.service, f.old.workId);
      const coordination = (
        f.service as unknown as {
          coordination: import("../src/core/coordination.js").CoordinationStore;
        }
      ).coordination;
      const call = {
        threadId,
        turnId,
        callId: "proof-check",
        tool: "ensemble_request_completion",
        arguments: { reviewedResultIds: [] },
      };
      const caller = coordination.deliveryCaller(call);
      assert.deepEqual(
        coordination.deliveryActionBlockers(caller, [], randomUUID()),
        [],
      );
      db(f.service)
        .prepare(
          "UPDATE execution_no_turn_submissions SET evidenceMaterial='{}' WHERE workId=?",
        )
        .run(f.old.workId);
      assert.ok(
        coordination
          .deliveryActionBlockers(caller, [], randomUUID())
          .includes("unfinished-turn-request"),
      );
      checked = true;
    };
    f.runtime.rejectStart = false;
    await f.service.coordinationView().postOperatorMessage(f.message);
    await until(
      () => f.runtime.completions.length === 1,
      "completion tool response",
    );
    assert.equal(checked, true);
    if (f.runtime.completions[0]?.success) {
      await until(
        () =>
          f.service
            .coordinationView()
            .readTask(f.taskId)
            .completionRequests.some((r) => r.status === "rejected"),
        "terminal completion rejected",
      );
      assert.ok(
        f.service
          .coordinationView()
          .readTask(f.taskId)
          .completionRequests.some((r) =>
            r.rejectionReasons.includes("unfinished-turn-request"),
          ),
      );
    } else assert.equal(f.runtime.completions[0]?.success, false);
    assert.notEqual(f.service.domain().task(f.taskId).state, "done");
    for (const field of ["receipt", "discriminator", "audit"])
      assert.deepEqual(
        JSON.parse(snapshot(f.service, f.old.workId))[field],
        JSON.parse(before)[field],
      );
  } finally {
    await close(f);
  }
});
