import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";

type ToolListener = (call: RuntimeToolCall) => Promise<RuntimeToolResult>;

class JourneyRuntime implements Runtime {
  turns = 0;
  starts = 0;
  prompts: string[] = [];
  handleTurn: ((threadId: string, turnId: string) => Promise<void>) | undefined;
  private listener: ToolListener | undefined;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async startThread(): Promise<string> {
    this.starts++;
    return `thread-${this.starts}`;
  }

  async resumeThread(): Promise<void> {}

  async startTurn(
    _threadId: string,
    _workspace: string,
    prompt: string,
  ): Promise<string> {
    this.turns++;
    this.prompts.push(prompt);
    return `turn-${this.turns}`;
  }

  async interruptTurn(): Promise<void> {}

  async waitForTurn(threadId: string, turnId: string) {
    await this.handleTurn?.(threadId, turnId);
    return "completed" as const;
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void): void {}

  onToolCall(listener: ToolListener): void {
    this.listener = listener;
  }

  async callTool(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    assert.ok(this.listener, "service registers the runtime tool callback");
    return this.listener(call);
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  diagnostics: () => unknown = () => undefined,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(
        `${description} timed out; ${JSON.stringify(diagnostics())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function db(service: StandaloneService) {
  return (service as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

async function refusedInitial(initialBatch = false) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-refused-initial-"));
  const projectId = randomUUID(),
    taskId = randomUUID(),
    profileId = randomUUID();
  const runtime = new JourneyRuntime();
  const makeService = () =>
    new StandaloneService(join(root, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    });
  const service = makeService();
  await service.start();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "PRESERVED_PROFILE",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "PRESERVED_PROJECT",
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
    title: "Old title",
    outcome: "OLD_OUTCOME",
    ready: true,
  });
  await service.provisionTask(taskId);
  const assignment = service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  const workId = `assignment:${assignment.id}:initial`;
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(service.domain().task(taskId).version),
    title: "CURRENT_TITLE",
    outcome: "CURRENT_OUTCOME",
  });
  await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  const old = service.turnRequests().find((r) => r.workId === workId);
  assert.ok(old);
  assert.equal(old.state, "held");
  assert.match(old.reason ?? "", /task-revision-changed/);
  assert.equal(runtime.turns, 0);
  if (initialBatch) {
    const coordination = (
      service as unknown as {
        coordination: import("../src/core/coordination.js").CoordinationStore;
      }
    ).coordination;
    coordination.postOperatorMessage({
      actor: "operator",
      key: randomUUID(),
      taskId,
      recipientAssignmentId: String(assignment.id),
      expectedAssignmentVersion: Number(assignment.version),
      message: "HELD_INITIAL_BATCH",
    });
    assert.ok(
      coordination.bindDeliveryBatch(
        String(assignment.id),
        workId,
        Number(assignment.version),
      ),
    );
  }
  return {
    root,
    projectId,
    taskId,
    profileId,
    assignmentId: String(assignment.id),
    workId,
    old,
    runtime,
    service,
    makeService,
  };
}

function unpause(
  f: Awaited<ReturnType<typeof refusedInitial>>,
  service = f.service,
) {
  command(service, {
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(service.domain().project(f.projectId).version),
    paused: false,
  });
}

function message(
  f: Awaited<ReturnType<typeof refusedInitial>>,
  service = f.service,
) {
  return {
    key: randomUUID(),
    taskId: f.taskId,
    recipientAssignmentId: f.assignmentId,
    expectedAssignmentVersion: Number(
      service.domain().assignment(f.assignmentId).version,
    ),
    message: "FRESH_OPERATOR_CONTINUATION",
  };
}

test("fresh operator message continues a refused canonical initial with exact current material and durable completion", async () => {
  const f = await refusedInitial();
  let service = f.service;
  try {
    const oldIntent = service.list().find((i) => i.workId === f.workId);
    const oldRefusal = db(service)
      .prepare("SELECT * FROM execution_request_refusals WHERE workId = ?")
      .get(f.workId);
    assert.ok(oldIntent);
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(
      db(service)
        .prepare("SELECT 1 FROM execution_pending_effects WHERE workId = ?")
        .get(f.workId),
      undefined,
    );
    const input = message(f, service);
    const receipt = await service.coordinationView().postOperatorMessage(input);
    assert.equal(
      (await service.coordinationView().postOperatorMessage(input)).eventId,
      receipt.eventId,
    );
    assert.equal(f.runtime.turns, 0, "paused admission remains enforced");
    assert.equal(
      service.turnRequests().filter((r) => r.workId === f.workId).length,
      1,
    );
    await service.stop();
    service = f.makeService();
    f.runtime.handleTurn = async (threadId, turnId) => {
      const result = await f.runtime.callTool({
        threadId,
        turnId,
        callId: "initial-continuation-completion",
        tool: "ensemble_request_completion",
        arguments: { reviewedResultIds: [] },
      });
      assert.equal(result.success, true);
    };
    await service.start();
    unpause(f, service);
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    await waitUntil(
      () => service.domain().task(f.taskId).state === "done",
      "fresh initial continuation completion",
      () => service.turnRequests(),
    );
    assert.equal(f.runtime.turns, 1);
    const successor = service.turnRequests().find((r) => r.workId !== f.workId);
    assert.ok(successor);
    assert.equal(
      successor.taskVersion,
      Number(service.domain().task(f.taskId).version) - 1,
    );
    assert.match(f.runtime.prompts[0] ?? "", /CURRENT_TITLE/);
    assert.match(
      f.runtime.prompts[0] ?? "",
      /Preserved assignment brief:\nTask: Old title\nOutcome: OLD_OUTCOME/,
    );
    assert.match(f.runtime.prompts[0] ?? "", /CURRENT_OUTCOME/);
    assert.match(f.runtime.prompts[0] ?? "", /PRESERVED_PROFILE/);
    assert.match(f.runtime.prompts[0] ?? "", /PRESERVED_PROJECT/);
    assert.match(f.runtime.prompts[0] ?? "", /FRESH_OPERATOR_CONTINUATION/);
    assert.deepEqual(
      service.turnRequests().find((r) => r.workId === f.workId),
      f.old,
    );
    assert.deepEqual(
      service.list().find((i) => i.workId === f.workId),
      oldIntent,
    );
    assert.deepEqual(
      db(service)
        .prepare("SELECT * FROM execution_request_refusals WHERE workId = ?")
        .get(f.workId),
      oldRefusal,
    );
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(
      (await service.coordinationView().postOperatorMessage(input)).eventId,
      receipt.eventId,
    );
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    assert.equal(
      f.runtime.turns,
      1,
      "completed event does not replay after restart",
    );
    assert.equal(service.domain().task(f.taskId).state, "done");
  } finally {
    await service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

function proof(service: StandaloneService, workId: string) {
  return (
    service as unknown as {
      state: { isNeverAdmittedRefusedAssignmentWork(id: string): boolean };
    }
  ).state.isNeverAdmittedRefusedAssignmentWork(workId);
}

test("canonical initial refusal proof rejects altered identity and every admission witness", async (t) => {
  for (const witness of [
    "noncanonical",
    "binding",
    "request-refusal",
    "intent-refusal",
    "unknown-reason",
    "thread",
    "turn",
    "writer",
    "capacity",
    "recovery",
    "effect",
    "stop",
  ] as const) {
    await t.test(witness, async () => {
      const f = await refusedInitial();
      try {
        assert.equal(proof(f.service, f.workId), true);
        const database = db(f.service);
        if (witness === "noncanonical") {
          assert.equal(proof(f.service, f.workId + ":extra"), false);
          // Retain relational identity while changing all referencing work IDs.
          database.exec("PRAGMA foreign_keys = OFF");
          for (const table of [
            "turn_requests",
            "execution_intents",
            "task_execution_bindings",
            "execution_request_refusals",
            "execution_request_predecessors",
            "task_work_revision_pending",
          ])
            database
              .prepare(`UPDATE ${table} SET workId = ? WHERE workId = ?`)
              .run(f.workId + ":extra", f.workId);
          database.exec("PRAGMA foreign_keys = ON");
          assert.equal(proof(f.service, f.workId + ":extra"), false);
        } else if (witness === "binding")
          database
            .prepare(
              "UPDATE task_execution_bindings SET assignmentVersion = assignmentVersion + 1 WHERE workId = ?",
            )
            .run(f.workId);
        else if (witness === "request-refusal")
          database
            .prepare(
              "UPDATE turn_requests SET reason = 'different' WHERE workId = ?",
            )
            .run(f.workId);
        else if (witness === "intent-refusal")
          database
            .prepare(
              "UPDATE execution_intents SET reason = 'different' WHERE workId = ?",
            )
            .run(f.workId);
        else if (witness === "unknown-reason") {
          const reason =
            "Request refused: captured revisions no longer match (task-revision-changed, unknown-reason)";
          for (const table of [
            "turn_requests",
            "execution_intents",
            "execution_request_refusals",
          ])
            database
              .prepare(`UPDATE ${table} SET reason = ? WHERE workId = ?`)
              .run(reason, f.workId);
        } else if (witness === "thread" || witness === "turn")
          database
            .prepare(
              `UPDATE execution_intents SET ${witness}Id = 'observed-runtime-identity' WHERE workId = ?`,
            )
            .run(f.workId);
        else if (witness === "writer")
          database
            .prepare(
              "INSERT INTO task_writer_admissions (workId, workspace) SELECT workId, workspace FROM execution_intents WHERE workId = ?",
            )
            .run(f.workId);
        else if (witness === "capacity")
          database
            .prepare(
              "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
            )
            .run(f.workId, f.projectId);
        else if (witness === "recovery")
          database
            .prepare(
              "INSERT INTO execution_recovery_identities (workId, requestSequence) VALUES (?, ?)",
            )
            .run(f.workId, f.old.sequence);
        else if (witness === "effect")
          database
            .prepare(
              "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'other-callback', 'pending', 'unresolved')",
            )
            .run(f.workId);
        else
          database
            .prepare(
              "INSERT INTO execution_stop_targets (taskId, workId, interruptState, terminalState, requestedAt) VALUES (?, ?, 'unbound', 'unknown', 1)",
            )
            .run(f.taskId, f.workId);
        if (witness !== "noncanonical")
          assert.equal(proof(f.service, f.workId), false);
        unpause(f);
        if (witness === "noncanonical") {
          await assert.rejects(
            f.service.coordinationView().postOperatorMessage(message(f)),
            /identity already used/,
          );
        } else {
          await f.service.coordinationView().postOperatorMessage(message(f));
          await f.service.configureCapacity({
            key: randomUUID(),
            globalLimit: 1,
          });
        }
        assert.equal(
          f.runtime.turns,
          0,
          `${witness} never permits a successor`,
        );
      } finally {
        await f.service.stop();
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
});

test("initial inbox batch remains bound and fresh messages cannot orphan or replay it", async () => {
  const f = await refusedInitial(true);
  try {
    const batch = db(f.service)
      .prepare(
        "SELECT * FROM coordination_delivery_batches WHERE deliveryWorkId = ?",
      )
      .get(f.workId);
    assert.ok(batch);
    assert.equal(proof(f.service, f.workId), true);
    unpause(f);
    await f.service.coordinationView().postOperatorMessage(message(f));
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    assert.equal(f.runtime.turns, 0);
    assert.deepEqual(
      db(f.service)
        .prepare(
          "SELECT * FROM coordination_delivery_batches WHERE deliveryWorkId = ?",
        )
        .get(f.workId),
      batch,
    );
    assert.equal(f.service.turnRequests().length, 1);
    assert.equal(
      f.service
        .coordinationView()
        .readTask(f.taskId)
        .messages.filter((m) => m.deliveryState === "delivered").length,
      0,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fresh initial continuation still enforces Stop, stale profile, dependency and independent writer holds", async (t) => {
  for (const gate of [
    "stop",
    "profile",
    "dependency",
    "writer-hold",
  ] as const) {
    await t.test(gate, async () => {
      const f = await refusedInitial();
      try {
        unpause(f);
        if (gate === "stop") await f.service.stopTask(f.taskId);
        else if (gate === "profile")
          command(f.service, {
            type: "profile.configure",
            profileId: f.profileId,
            expectedVersion: 1,
            instructions: "CHANGED_PROFILE",
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
        } else {
          // A historical refusal cannot remove an independent task hold.
          db(f.service)
            .prepare(
              "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent pending callback')",
            )
            .run(f.taskId);
        }
        await f.service.coordinationView().postOperatorMessage(message(f));
        await f.service.configureCapacity({
          key: randomUUID(),
          globalLimit: 1,
        });
        assert.equal(f.runtime.turns, 0);
        assert.equal(f.service.domain().task(f.taskId).state, "open");
      } finally {
        await f.service.stop();
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
});

test("refused initial exemption feeds external completion actions and preserves admitted execution and callback blockers", async () => {
  const f = await refusedInitial();
  try {
    f.runtime.handleTurn = async (threadId, turnId) => {
      const coordination = (
        f.service as unknown as {
          coordination: import("../src/core/coordination.js").CoordinationStore;
        }
      ).coordination;
      const call = {
        threadId,
        turnId,
        callId: "completion-action-proof",
        tool: "ensemble_request_completion",
        arguments: { reviewedResultIds: [] },
      };
      const caller = coordination.deliveryCaller(call);
      const blockers = () =>
        coordination.deliveryActionBlockers(caller, [], randomUUID());
      assert.deepEqual(
        blockers(),
        [],
        "proven initial refusal does not block the current completion action",
      );
      const database = db(f.service);
      // Late evidence disqualifies precisely the old refusal; it never loses authority
      // merely because legitimate successor work has already been admitted.
      database
        .prepare(
          "INSERT INTO task_writer_admissions (workId, workspace) SELECT workId, workspace FROM execution_intents WHERE workId = ?",
        )
        .run(f.workId);
      assert.ok(blockers().includes("unfinished-execution"));
      assert.ok(blockers().includes("unfinished-turn-request"));
      database
        .prepare("DELETE FROM task_writer_admissions WHERE workId = ?")
        .run(f.workId);
      database
        .prepare(
          "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'callback', 'pending', 'unresolved')",
        )
        .run(caller.workId);
      assert.ok(blockers().includes("unfinished-callback-effect"));
      database
        .prepare(
          "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent hold')",
        )
        .run(f.taskId);
      assert.ok(blockers().includes("task-stop-or-writer-hold"));
      database
        .prepare("DELETE FROM task_writer_holds WHERE taskId = ?")
        .run(f.taskId);
      assert.ok(
        blockers().includes("unfinished-callback-effect"),
        "removing one hold cannot settle another callback",
      );
      const result = await f.runtime.callTool(call);
      assert.equal(result.success, true);
    };
    unpause(f);
    await f.service.coordinationView().postOperatorMessage(message(f));
    await waitUntil(
      () =>
        f.service
          .coordinationView()
          .readTask(f.taskId)
          .completionRequests.some((r) => r.status === "rejected"),
      "callback blocks terminal completion",
    );
    const completion = f.service.coordinationView().readTask(f.taskId)
      .completionRequests[0];
    assert.ok(
      completion?.rejectionReasons.includes("unfinished-callback-effect"),
    );
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(
      proof(f.service, f.workId),
      true,
      "independent successor callback does not change old historical proof",
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
