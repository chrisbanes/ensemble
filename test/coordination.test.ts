import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../src/core/coordination.js";
import { DomainStore, type DomainCommand } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { ExecutionState } from "../src/standalone/state.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const leadProfile = "30000000-0000-4000-8000-000000000001";
const workerProfile = "30000000-0000-4000-8000-000000000002";
const childA = "40000000-0000-4000-8000-000000000001";
const nestedA = "40000000-0000-4000-8000-000000000002";
const childB = "40000000-0000-4000-8000-000000000003";
let commandSequence = 0;
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function nextCommand(): string {
  commandSequence++;
  return `50000000-0000-4000-8000-${String(commandSequence).padStart(12, "0")}`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-coordination-"));
  const filename = join(directory, "coordination.sqlite");
  let db = new DatabaseSync(filename);
  let domain!: DomainStore;
  let state!: ExecutionState;
  let coordination!: CoordinationStore;
  const initialize = () => {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    state = new ExecutionState(db);
    coordination = new CoordinationStore(db);
    coordination.migrate();
  };
  initialize();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: nextCommand() } as DomainCommand);

  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfile,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfile,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Coordination test",
    leadProfileId: leadProfile,
  });
  for (const id of [taskA, taskB]) {
    run({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: id,
      title: `Task ${id.slice(-1)}`,
      outcome: "Deliver",
      ready: true,
    });
    run({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: id === taskA ? 1 : 2,
      paused: false,
    });
    domain.ensureLeadAssignment(id);
  }
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfile],
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskA,
    assignmentId: childA,
    profileId: workerProfile,
    brief: "Build task A",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskA,
    assignmentId: nestedA,
    profileId: workerProfile,
    brief: "Nested task A",
    resultDestination: "requester",
    requesterAssignmentId: childA,
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskB,
    assignmentId: childB,
    profileId: workerProfile,
    brief: "Build task B",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });

  function addWork(
    assignmentId: string,
    workId: string,
    threadId: string,
    turnId: string,
  ) {
    const assignment = domain.assignment(assignmentId);
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
        "VALUES (?, ?, 'work', '/tmp/work', 'running', NULL, ?, ?, 'chatgpt', 'workspaceWrite', 'never')",
    ).run(nextCommand(), workId, threadId, turnId);
    state.bindTask(workId, {
      taskId: String(assignment.taskId),
      assignmentId,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    const binding = db
      .prepare(
        "SELECT conversationRevision FROM task_execution_bindings WHERE workId = ?",
      )
      .get(workId) as { conversationRevision: number };
    db.prepare(
      "INSERT INTO task_work_revisions (workId, assignmentId, conversationRevision, workRevision) VALUES (?, ?, ?, 1)",
    ).run(workId, assignmentId, binding.conversationRevision);
    db.prepare(`INSERT INTO execution_pending_effects
      (workId, effectKey, state, reason)
      VALUES (?, 'assignment-result', 'pending', 'Assignment result has not been committed')`).run(
      workId,
    );
    db.prepare(
      "UPDATE domain_assignments SET state = 'running' WHERE id = ?",
    ).run(assignmentId);
  }

  addWork(childA, "work-child-a", "thread-child-a", "turn-child-a");
  addWork(nestedA, "work-nested-a", "thread-nested-a", "turn-nested-a");
  addWork(childB, "work-child-b", "thread-child-b", "turn-child-b");

  return {
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    get state() {
      return state;
    },
    get coordination() {
      return coordination;
    },
    leadAssignment(taskId: string) {
      return domain.ensureLeadAssignment(taskId);
    },
    addWork,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      initialize();
    },
    addUnresolvedWork() {
      run({
        type: "assignment.create",
        actor: "agent",
        projectId,
        taskId: taskB,
        assignmentId: "40000000-0000-4000-8000-000000000004",
        profileId: workerProfile,
        brief: "Unresolved destination",
        resultDestination: "requester:foreign",
        requesterAssignmentId: null,
      });
      db.prepare(
        "UPDATE domain_assignments SET resultRecipientAssignmentId = NULL, resultRecipientDisposition = 'unresolved' WHERE id = ?",
      ).run("40000000-0000-4000-8000-000000000004");
      addWork(
        "40000000-0000-4000-8000-000000000004",
        "work-unresolved",
        "thread-unresolved",
        "turn-unresolved",
      );
    },
  };
}

function report(
  threadId: string,
  turnId: string,
  callId: string,
  summary = "Completed work",
) {
  return {
    threadId,
    turnId,
    callId,
    tool: "ensemble_report_result",
    arguments: { summary },
  };
}

test("results route to same-task lead or requester and histories stay isolated", () => {
  const f = fixture();
  try {
    const leadA = f.domain.ensureLeadAssignment(taskA);
    const leadB = f.domain.ensureLeadAssignment(taskB);
    const first = f.coordination.recordResult(
      report("thread-child-a", "turn-child-a", "call-a"),
    );
    const nested = f.coordination.recordResult(
      report("thread-nested-a", "turn-nested-a", "call-nested"),
    );
    const otherTask = f.coordination.recordResult(
      report("thread-child-b", "turn-child-b", "call-b"),
    );
    assert.equal(first.result.recipientAssignmentId, leadA?.id);
    assert.equal(nested.result.recipientAssignmentId, childA);
    assert.equal(otherTask.result.recipientAssignmentId, leadB?.id);
    assert.deepEqual(
      f.coordination.inboxEvents(childA).map((event) => event.resultId),
      [nested.result.resultId],
    );
    assert.deepEqual(
      f.coordination
        .inboxEvents(String(leadA?.id))
        .map((event) => event.resultId),
      [first.result.resultId],
    );
    assert.deepEqual(
      f.coordination
        .inboxEvents(String(leadB?.id))
        .map((event) => event.resultId),
      [otherTask.result.resultId],
    );
    assert.deepEqual(
      f.coordination.results(taskA).map((result) => result.taskId),
      [taskA, taskA],
    );
    assert.equal(f.coordination.results(taskB).length, 1);
  } finally {
    f.close();
  }
});

test("unresolved result destinations survive reopen and reconcile once", () => {
  const f = fixture();
  try {
    f.addUnresolvedWork();
    const recorded = f.coordination.recordResult(
      report("thread-unresolved", "turn-unresolved", "call-unresolved"),
    );
    assert.equal(recorded.result.destinationDisposition, "unresolved");
    assert.equal(f.coordination.inboxEvents(childB).length, 0);
    assert.equal(f.coordination.unresolvedResultDestinations(taskB).length, 1);
    f.reopen();
    const holds = f.coordination.unresolvedResultDestinations(taskB);
    assert.equal(holds.length, 1);
    const leadB = String(f.domain.ensureLeadAssignment(taskB)?.id);
    assert.throws(
      () =>
        f.coordination.reconcileResultRecipient({
          actor: "operator",
          key: nextCommand(),
          resultId: recorded.result.resultId,
          expectedRevision: 1,
          recipientAssignmentId: childA,
        }),
      /not permitted/,
    );
    const staleKey = nextCommand();
    const eventsBeforeStale = f.coordination.inboxEvents(leadB).length;
    assert.throws(
      () =>
        f.coordination.reconcileResultRecipient({
          actor: "operator",
          key: staleKey,
          resultId: recorded.result.resultId,
          expectedRevision: 2,
          recipientAssignmentId: leadB,
        }),
      /revision conflict/,
    );
    assert.equal(f.coordination.inboxEvents(leadB).length, eventsBeforeStale);
    assert.equal(f.coordination.unresolvedResultDestinations(taskB).length, 1);
    const key = nextCommand();
    const event = f.coordination.reconcileResultRecipient({
      actor: "operator",
      key,
      resultId: recorded.result.resultId,
      expectedRevision: 1,
      recipientAssignmentId: leadB,
    });
    assert.equal(event.resultId, recorded.result.resultId);
    assert.deepEqual(
      f.coordination.reconcileResultRecipient({
        actor: "operator",
        key,
        resultId: recorded.result.resultId,
        expectedRevision: 1,
        recipientAssignmentId: leadB,
      }),
      event,
    );
    assert.throws(
      () =>
        f.coordination.reconcileResultRecipient({
          actor: "operator",
          key,
          resultId: recorded.result.resultId,
          expectedRevision: 2,
          recipientAssignmentId: leadB,
        }),
      /key reused with different content/,
    );
    assert.equal(f.coordination.inboxEvents(leadB).length, 1);
    assert.deepEqual(f.coordination.unresolvedResultDestinations(taskB), []);
    assert.throws(
      () =>
        f.coordination.reconcileResultRecipient({
          actor: "operator",
          key: nextCommand(),
          resultId: recorded.result.resultId,
          expectedRevision: 1,
          recipientAssignmentId: leadB,
        }),
      /already reconciled|revision conflict/,
    );
  } finally {
    f.close();
  }
});

test("exact receipts replay after completion before live binding checks", () => {
  const f = fixture();
  try {
    const call = report("thread-child-a", "turn-child-a", "call-replay");
    const first = f.coordination.recordResult(call);
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
      )
      .run("work-child-a");
    f.db
      .prepare("UPDATE domain_assignments SET state = 'completed' WHERE id = ?")
      .run(childA);
    const replay = f.coordination.recordResult(call);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(
      f.coordination.inboxEvents(
        String(f.domain.ensureLeadAssignment(taskA)?.id),
      ).length,
      1,
    );
    assert.throws(
      () =>
        f.coordination.recordResult(
          report(
            "thread-child-a",
            "turn-child-a",
            "call-replay",
            "Changed payload",
          ),
        ),
      /different content/,
    );
    assert.throws(
      () =>
        f.coordination.recordResult(
          report("thread-child-a", "turn-unknown", "call-new"),
        ),
      /not bound/,
    );
    assert.throws(
      () =>
        f.coordination.recordResult(
          report("thread-child-a", "turn-child-a", "call-new-terminal"),
        ),
      /not bound/,
    );
  } finally {
    f.close();
  }
});

test("a superseded work revision cannot record a result", () => {
  const f = fixture();
  try {
    const assignment = f.domain.assignment(childA);
    f.db
      .prepare(
        "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
          "VALUES ($id, 'work-child-a-newer', 'work', '/tmp/work', 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')",
      )
      .run({ $id: nextCommand() });
    f.state.bindTask("work-child-a-newer", {
      taskId: taskA,
      assignmentId: childA,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    const binding = f.db
      .prepare(
        "SELECT conversationRevision FROM task_execution_bindings WHERE workId = ?",
      )
      .get("work-child-a-newer") as { conversationRevision: number };
    f.db
      .prepare(
        "INSERT INTO task_work_revisions (workId, assignmentId, conversationRevision, workRevision) VALUES (?, ?, ?, 2)",
      )
      .run("work-child-a-newer", childA, binding.conversationRevision);
    f.db
      .prepare("DELETE FROM task_work_revision_pending WHERE workId = ?")
      .run("work-child-a-newer");
    assert.throws(
      () =>
        f.coordination.recordResult(
          report("thread-child-a", "turn-child-a", "call-stale"),
        ),
      /not bound/,
    );
    assert.deepEqual(f.coordination.results(), []);
    assert.equal(
      f.coordination.inboxEvents(
        String(f.domain.ensureLeadAssignment(taskA)?.id),
      ).length,
      0,
    );
  } finally {
    f.close();
  }
});

test("result and inbox or unresolved hold commit atomically", () => {
  for (const [table, call] of [
    [
      "coordination_inbox_events",
      report("thread-child-a", "turn-child-a", "call-fail-event"),
    ],
    [
      "coordination_unresolved_result_destinations",
      report("thread-unresolved", "turn-unresolved", "call-fail-hold"),
    ],
  ] as const) {
    const f = fixture();
    try {
      if (table === "coordination_unresolved_result_destinations")
        f.addUnresolvedWork();
      f.db.exec(
        "CREATE TRIGGER fail_effect BEFORE INSERT ON " +
          table +
          " BEGIN SELECT RAISE(ABORT, 'injected effect failure'); END",
      );
      assert.throws(
        () => f.coordination.recordResult(call),
        /injected effect failure/,
      );
      assert.equal(f.coordination.results().length, 0);
      assert.equal(
        f.coordination.inboxEvents(
          String(f.domain.ensureLeadAssignment(taskA)?.id),
        ).length,
        0,
      );
      assert.equal(f.coordination.unresolvedResultDestinations().length, 0);
      assert.equal(f.coordination.receipt(call), undefined);
    } finally {
      f.close();
    }
  }
});

test("high-water delivery batches survive reopen and leave later events pending", () => {
  const f = fixture();
  try {
    const recipient = String(f.domain.ensureLeadAssignment(taskA)?.id);
    const insertEvent = (eventId: string, payload: string) =>
      f.db
        .prepare(
          "INSERT INTO coordination_inbox_events (eventId, taskId, recipientAssignmentId, eventType, payload) VALUES ($eventId, $taskId, $recipient, 'message', $payload)",
        )
        .run({
          $eventId: eventId,
          $taskId: taskA,
          $recipient: recipient,
          $payload: payload,
        });
    insertEvent("event-first", "first");
    insertEvent("event-second", "second");
    const batch = f.coordination.bindDeliveryBatch(recipient, "delivery-one");
    assert.ok(batch);
    const otherRecipient = String(f.domain.ensureLeadAssignment(taskB)?.id);
    assert.throws(
      () => f.coordination.bindDeliveryBatch(otherRecipient, "delivery-one"),
      /reused for another recipient/,
    );
    assert.equal(batch.events.length, 2);
    assert.equal(batch.highWaterSequence, batch.events[1]?.sequence);
    insertEvent("event-late", "late");
    assert.deepEqual(
      f.coordination.pendingEvents(recipient).map((event) => event.eventId),
      ["event-late"],
    );
    f.reopen();
    const replay = f.coordination.bindDeliveryBatch(
      recipient,
      "delivery-retry",
    );
    assert.equal(replay?.batchId, batch.batchId);
    assert.deepEqual(
      replay?.events.map((event) => event.eventId),
      ["event-first", "event-second"],
    );
    f.coordination.completeDeliveryBatch("delivery-one");
    const next = f.coordination.bindDeliveryBatch(recipient, "delivery-two");
    assert.deepEqual(
      next?.events.map((event) => event.eventId),
      ["event-late"],
    );
    assert.equal(
      f.coordination.bindDeliveryBatch(recipient, "delivery-duplicate")
        ?.batchId,
      next?.batchId,
    );
  } finally {
    f.close();
  }
});

test("delegation derives same-task requester identity and replays exactly once", () => {
  const f = fixture();
  try {
    const call = {
      threadId: "thread-child-a",
      turnId: "turn-child-a",
      callId: "call-delegate",
      tool: "ensemble_delegate",
      arguments: { profileId: workerProfile, brief: "Focused child work" },
    };
    const first = f.coordination.delegate(call);
    const duplicate = f.coordination.delegate(call);
    assert.deepEqual(duplicate, first);
    const assignmentId = first.text.split(" ").at(-1) ?? "";
    const assignment = f.domain.assignment(assignmentId);
    assert.equal(assignment.taskId, taskA);
    assert.equal(assignment.requesterAssignmentId, childA);
    assert.equal(assignment.resultRecipientAssignmentId, childA);
    assert.equal(assignment.state, "pending");
    assert.equal(
      f.domain
        .assignments(taskA)
        .filter((row) => row.requesterAssignmentId === childA).length,
      2,
    );
    assert.throws(
      () =>
        f.coordination.delegate({
          ...call,
          arguments: { profileId: workerProfile, brief: "Changed work" },
        }),
      /different content/,
    );
  } finally {
    f.close();
  }
});

test("questions and approvals stay in operator attention until one exact response", () => {
  const f = fixture();
  try {
    const questionResponse = f.coordination.requestQuestion({
      threadId: "thread-child-a",
      turnId: "turn-child-a",
      callId: "call-question",
      tool: "ensemble_ask_question",
      arguments: { question: "Which supported format should I use?" },
    });
    const questionId = questionResponse.text.split(" ").at(-1) ?? "";
    const material = { operation: "publish", privateMarker: "do-not-persist" };
    const approvalResponse = f.coordination.requestApproval({
      threadId: "thread-nested-a",
      turnId: "turn-nested-a",
      callId: "call-approval",
      tool: "ensemble_request_approval",
      arguments: { action: "publish", target: "artifact-4", material },
    });
    const approvalId = approvalResponse.text.split(" ").at(-1) ?? "";
    assert.equal(f.coordination.pendingEvents(childA).length, 0);
    assert.equal(f.coordination.operatorAttention(taskA).length, 2);
    f.reopen();
    assert.deepEqual(
      f.coordination.interactions(taskA).map((item) => item.status),
      ["open", "open"],
    );
    assert.doesNotMatch(
      JSON.stringify(f.coordination.interactions(taskA)),
      /do-not-persist/,
    );

    const questionKey = "60000000-0000-4000-8000-000000000001";
    const answered = f.coordination.answerQuestion({
      actor: "operator",
      key: questionKey,
      interactionId: questionId,
      expectedRevision: 1,
      answer: "Use format B.",
    });
    assert.equal(answered.recipientAssignmentId, childA);
    assert.equal(answered.eventType, "question-answer");
    assert.equal(
      f.coordination.answerQuestion({
        actor: "operator",
        key: questionKey,
        interactionId: questionId,
        expectedRevision: 1,
        answer: "Use format B.",
      }).eventId,
      answered.eventId,
    );
    assert.throws(
      () =>
        f.coordination.answerQuestion({
          actor: "operator",
          key: questionKey,
          interactionId: questionId,
          expectedRevision: 1,
          answer: "Different answer.",
        }),
      /different content/,
    );
    assert.throws(
      () =>
        f.coordination.answerQuestion({
          actor: "operator",
          key: "60000000-0000-4000-8000-000000000002",
          interactionId: questionId,
          expectedRevision: 1,
          answer: "Stale answer.",
        }),
      /not open|revision conflict/,
    );

    assert.throws(
      () =>
        f.coordination.decideApproval({
          actor: "operator",
          key: "60000000-0000-4000-8000-000000000003",
          interactionId: approvalId,
          expectedRevision: 1,
          decision: "approved",
          action: "publish",
          target: "artifact-4",
          material: { operation: "publish", privateMarker: "different" },
        }),
      /material does not match/,
    );
    const approved = f.coordination.decideApproval({
      actor: "operator",
      key: "60000000-0000-4000-8000-000000000003",
      interactionId: approvalId,
      expectedRevision: 1,
      decision: "approved",
      action: "publish",
      target: "artifact-4",
      material,
    });
    assert.equal(approved.recipientAssignmentId, nestedA);
    assert.equal(approved.eventType, "approval-decision");
    assert.equal(
      f.coordination
        .inboxEvents(childA)
        .filter((event) => event.interactionId === questionId).length,
      1,
    );
    assert.equal(
      f.coordination
        .inboxEvents(nestedA)
        .filter((event) => event.interactionId === approvalId).length,
      1,
    );
    const answerDelivery = f.coordination.bindDeliveryBatch(
      childA,
      "delivery-child-answer",
      1,
    );
    assert.ok(answerDelivery);
    assert.equal(
      f.coordination.hasDurableWaitingAction("work-child-a", childA),
      true,
    );
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: nestedA,
        interactionId: approvalId,
        expectedRevision: 2,
        action: "publish",
        target: "artifact-4",
        material,
      }),
      true,
    );
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: nestedA,
        interactionId: approvalId,
        expectedRevision: 2,
        action: "publish",
        target: "artifact-4",
        material: { operation: "publish", privateMarker: "different" },
      }),
      false,
    );
    assert.deepEqual(
      f.coordination.operatorAttention(taskA).map((item) => item.status),
      ["resolved", "resolved"],
    );
    f.reopen();
    assert.equal(
      f.coordination
        .inboxEvents(childA)
        .filter((event) => event.interactionId === questionId).length,
      1,
    );
    assert.equal(
      f.coordination
        .inboxEvents(nestedA)
        .filter((event) => event.interactionId === approvalId).length,
      1,
    );
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: nestedA,
        interactionId: approvalId,
        expectedRevision: 2,
        action: "publish",
        target: "artifact-4",
        material,
      }),
      true,
    );
    assert.equal(
      f.coordination.hasDurableWaitingAction("work-child-a", childA),
      true,
    );
  } finally {
    f.close();
  }
});

test("approval denial and profile revocation never authorize", () => {
  const f = fixture();
  try {
    const material = { change: "delete-one-file" };
    const response = f.coordination.requestApproval({
      threadId: "thread-child-a",
      turnId: "turn-child-a",
      callId: "call-approval-denied",
      tool: "ensemble_request_approval",
      arguments: { action: "delete", target: "file-A", material },
    });
    const interactionId = response.text.split(" ").at(-1) ?? "";
    f.coordination.decideApproval({
      actor: "operator",
      key: "60000000-0000-4000-8000-000000000004",
      interactionId,
      expectedRevision: 1,
      decision: "denied",
      action: "delete",
      target: "file-A",
      material,
    });
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: childA,
        interactionId,
        expectedRevision: 2,
        action: "delete",
        target: "file-A",
        material,
      }),
      false,
    );

    const approval = f.coordination.requestApproval({
      threadId: "thread-nested-a",
      turnId: "turn-nested-a",
      callId: "call-approval-revocation",
      tool: "ensemble_request_approval",
      arguments: { action: "publish", material },
    });
    const approvalId = approval.text.split(" ").at(-1) ?? "";
    f.coordination.decideApproval({
      actor: "operator",
      key: "60000000-0000-4000-8000-000000000005",
      interactionId: approvalId,
      expectedRevision: 1,
      decision: "approved",
      action: "publish",
      material,
    });
    f.domain.execute({
      key: nextCommand(),
      type: "profile.configure",
      actor: "operator",
      profileId: workerProfile,
      expectedVersion: 1,
      revoked: true,
    });
    assert.equal(
      f.coordination.authorizationFor({
        assignmentId: nestedA,
        interactionId: approvalId,
        expectedRevision: 2,
        action: "publish",
        material,
      }),
      false,
    );
  } finally {
    f.close();
  }
});

test("operator messages are task-scoped, revision-bound, and replay once", () => {
  const f = fixture();
  try {
    const key = "60000000-0000-4000-8000-000000000006";
    const command = {
      actor: "operator" as const,
      key,
      taskId: taskA,
      recipientAssignmentId: childA,
      expectedAssignmentVersion: 1,
      message: "Please preserve the existing API.",
    };
    const first = f.coordination.postOperatorMessage(command);
    assert.equal(first.eventType, "operator-message");
    assert.equal(
      f.coordination.postOperatorMessage(command).eventId,
      first.eventId,
    );
    assert.equal(f.coordination.pendingEvents(childA).length, 1);
    assert.throws(
      () =>
        f.coordination.postOperatorMessage({
          ...command,
          taskId: taskB,
          key: "60000000-0000-4000-8000-000000000007",
        }),
      /another task/,
    );
    assert.throws(
      () =>
        f.coordination.postOperatorMessage({
          ...command,
          expectedAssignmentVersion: 2,
          key: "60000000-0000-4000-8000-000000000008",
        }),
      /version conflict/,
    );
    assert.throws(
      () =>
        f.coordination.postOperatorMessage({
          ...command,
          message: "Changed message.",
        }),
      /different content/,
    );
    f.reopen();
    assert.equal(
      f.coordination
        .inboxEvents(childA)
        .filter((event) => event.eventType === "operator-message").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("follow-up reuses the completed assignment and binds the exact result", () => {
  const f = fixture();
  try {
    const result = f.coordination.recordResult(
      report("thread-child-a", "turn-child-a", "call-follow-up-result"),
    ).result;
    const leadId = String(f.leadAssignment(taskA)?.id);
    f.addWork(leadId, "work-lead-a", "thread-lead-a", "turn-lead-a");
    const call = {
      threadId: "thread-lead-a",
      turnId: "turn-lead-a",
      callId: "call-follow-up",
      tool: "ensemble_request_follow_up",
      arguments: {
        resultId: result.resultId,
        instructions: "Add regression coverage.",
      },
    };
    const response = f.coordination.requestFollowUp(call);
    assert.equal(f.coordination.requestFollowUp(call).text, response.text);
    const followUp = f.coordination.followUps(taskA)[0];
    assert.ok(followUp);
    assert.equal(followUp.resultId, result.resultId);
    assert.equal(followUp.priorWorkId, "work-child-a");
    assert.equal(followUp.priorWorkRevision, 1);
    assert.equal(followUp.priorAssignmentVersion, 1);
    assert.equal(followUp.nextAssignmentVersion, 2);
    const assignment = f.domain.assignment(childA);
    assert.equal(assignment.version, 2);
    assert.equal(assignment.state, "pending");
    assert.equal(assignment.profileId, workerProfile);
    assert.equal(
      f.coordination
        .inboxEvents(childA)
        .filter((event) => event.eventType === "assignment-follow-up").length,
      1,
    );
    f.reopen();
    assert.equal(f.coordination.followUps(taskA).length, 1);
    assert.equal(
      f.coordination
        .inboxEvents(childA)
        .filter((event) => event.eventType === "assignment-follow-up").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("completion requires current lead work and all durable task gates", () => {
  const f = fixture();
  try {
    const workerResult = f.coordination.recordResult(
      report("thread-child-a", "turn-child-a", "call-completion-child"),
    ).result;
    const nestedResult = f.coordination.recordResult(
      report("thread-nested-a", "turn-nested-a", "call-completion-nested"),
    ).result;
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-child-a") as { state: string }
      ).state,
      "settled",
      "worker result callback settles its own exact assignment effect",
    );
    const leadId = String(f.leadAssignment(taskA)?.id);
    const leadDelivery = f.coordination.bindDeliveryBatch(
      leadId,
      "delivery-lead-results",
    );
    assert.ok(leadDelivery);
    f.coordination.completeDeliveryBatch(leadDelivery.deliveryWorkId);
    const childDelivery = f.coordination.bindDeliveryBatch(
      childA,
      "delivery-child-result",
    );
    assert.ok(childDelivery);
    f.coordination.completeDeliveryBatch(childDelivery.deliveryWorkId);
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId IN (?, ?)",
      )
      .run("work-child-a", "work-nested-a");
    f.addWork(leadId, "work-lead-completion", "thread-lead", "turn-lead");
    const call = {
      threadId: "thread-lead",
      turnId: "turn-lead",
      callId: "call-task-completion",
      tool: "ensemble_request_completion",
      arguments: {
        reviewedResultIds: [workerResult.resultId, nestedResult.resultId],
      },
    };
    const response = f.coordination.requestTaskCompletion(call);
    const requestId = response.text.split(" ").at(-1) ?? "";
    assert.equal(
      f.coordination.requestTaskCompletion(call).text,
      response.text,
    );
    const question = f.coordination.requestQuestion({
      threadId: "thread-lead",
      turnId: "turn-lead",
      callId: "call-completion-question",
      tool: "ensemble_ask_question",
      arguments: { question: "Confirm the release note summary." },
    });
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
      )
      .run("work-lead-completion");
    const project = f.domain.project(projectId);
    f.domain.execute({
      key: nextCommand(),
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: Number(project.version),
      paused: true,
    });
    const blocked = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-lead-completion",
      terminal: "completed",
    });
    assert.equal(blocked.completed, false);
    assert.ok(blocked.reasons.includes("open-interaction"));
    assert.ok(blocked.reasons.includes("project-paused"));
    assert.equal(blocked.reasons.includes("assignments-not-complete"), false);
    assert.equal(blocked.request.status, "rejected");
    assert.deepEqual(blocked.request.rejectionReasons, blocked.reasons);
    assert.equal(
      f.db.prepare("SELECT state FROM domain_tasks WHERE id = ?").get(taskA)
        ?.state,
      "open",
    );
    assert.equal(f.domain.assignment(leadId).state, "running");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-lead-completion") as { state: string }
      ).state,
      "settled",
      "successfully terminal rejected lead work settles only its own effect",
    );
    const questionId = question.text.split(" ").at(-1) ?? "";
    const answer = f.coordination.answerQuestion({
      actor: "operator",
      key: "60000000-0000-4000-8000-000000000009",
      interactionId: questionId,
      expectedRevision: 1,
      answer: "Approved wording.",
    });
    const answerDelivery = f.coordination.bindDeliveryBatch(
      leadId,
      "delivery-completion-answer",
    );
    assert.ok(answerDelivery);
    assert.equal(answerDelivery.events[0]?.eventId, answer.eventId);
    f.coordination.completeDeliveryBatch(answerDelivery.deliveryWorkId);
    const unpaused = f.domain.project(projectId);
    f.domain.execute({
      key: nextCommand(),
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: Number(unpaused.version),
      paused: false,
    });
    const rejectedReplay = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-lead-completion",
      terminal: "completed",
    });
    assert.equal(rejectedReplay.completed, false);
    assert.equal(rejectedReplay.request.status, "rejected");
    assert.deepEqual(rejectedReplay.reasons, blocked.reasons);
    assert.equal(f.domain.assignment(leadId).state, "running");
    assert.equal(
      f.db.prepare("SELECT state FROM domain_tasks WHERE id = ?").get(taskA)
        ?.state,
      "open",
    );

    f.state.replaceConversation(leadId);
    f.addWork(
      leadId,
      "work-lead-completion-retry",
      "thread-lead",
      "turn-lead-retry",
    );
    const retryCall = {
      ...call,
      turnId: "turn-lead-retry",
      callId: "call-task-completion-retry",
    };
    const retryResponse = f.coordination.requestTaskCompletion(retryCall);
    const retryRequestId = retryResponse.text.split(" ").at(-1) ?? "";
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
      )
      .run("work-lead-completion-retry");
    const completed = f.coordination.finalizeTaskCompletion({
      requestId: retryRequestId,
      workId: "work-lead-completion-retry",
      terminal: "completed",
    });
    assert.deepEqual(completed.reasons, []);
    assert.equal(completed.completed, true);
    assert.equal(completed.request.status, "finalized");
    assert.equal(completed.request.revision, 2);
    assert.equal(
      f.db.prepare("SELECT state FROM domain_tasks WHERE id = ?").get(taskA)
        ?.state,
      "done",
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-lead-completion-retry") as { state: string }
      ).state,
      "settled",
      "successful finalization settles the exact lead work effect",
    );
    assert.equal(
      f.coordination.recordSuccessfulTerminal("work-lead-completion-retry"),
      undefined,
      "a finalized completion request is the lead generation's terminal outcome",
    );
    assert.deepEqual(f.coordination.reportingRepairs(taskA), []);
    assert.equal(f.domain.assignment(leadId).state, "completed");
    assert.equal(f.domain.task(taskA).state, "done");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-lead-completion-retry") as { reason: string | null }
      ).reason,
      null,
      "terminal bookkeeping leaves completion-effect settlement to the finalizer",
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-lead-completion") as { reason: string }
      ).reason?.startsWith("Completion rejected:") ?? false,
      true,
      "the rejected generation keeps a bounded terminal reason",
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-child-b") as { state: string }
      ).state,
      "pending",
      "finalizing task A cannot settle another assignment's work effect",
    );
    const oldRequestReplay = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-lead-completion",
      terminal: "completed",
    });
    assert.equal(oldRequestReplay.completed, false);
    assert.equal(oldRequestReplay.request.status, "rejected");
    assert.deepEqual(oldRequestReplay.reasons, blocked.reasons);
    assert.equal(f.domain.assignment(leadId).state, "completed");
  } finally {
    f.close();
  }
});

test("stale lead completion is durably rejected and cannot finalize later", () => {
  const f = fixture();
  try {
    const workerResult = f.coordination.recordResult(
      report("thread-child-a", "turn-child-a", "call-stale-completion-child"),
    ).result;
    const nestedResult = f.coordination.recordResult(
      report(
        "thread-nested-a",
        "turn-nested-a",
        "call-stale-completion-nested",
      ),
    ).result;
    const leadId = String(f.leadAssignment(taskA)?.id);
    const leadDelivery = f.coordination.bindDeliveryBatch(
      leadId,
      "delivery-stale-lead",
    );
    assert.ok(leadDelivery);
    f.coordination.completeDeliveryBatch(leadDelivery.deliveryWorkId);
    const childDelivery = f.coordination.bindDeliveryBatch(
      childA,
      "delivery-stale-child",
    );
    assert.ok(childDelivery);
    f.coordination.completeDeliveryBatch(childDelivery.deliveryWorkId);
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId IN (?, ?)",
      )
      .run("work-child-a", "work-nested-a");
    f.addWork(
      leadId,
      "work-stale-lead",
      "thread-stale-lead",
      "turn-stale-lead",
    );
    const response = f.coordination.requestTaskCompletion({
      threadId: "thread-stale-lead",
      turnId: "turn-stale-lead",
      callId: "call-stale-completion",
      tool: "ensemble_request_completion",
      arguments: {
        reviewedResultIds: [workerResult.resultId, nestedResult.resultId],
      },
    });
    const requestId = response.text.split(" ").at(-1) ?? "";
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
      )
      .run("work-stale-lead");
    const task = f.domain.task(taskA);
    f.domain.execute({
      key: nextCommand(),
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId: taskA,
      expectedVersion: Number(task.version),
      title: "Changed after the lead request",
    });

    const rejected = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-stale-lead",
      terminal: "completed",
    });
    assert.equal(rejected.completed, false);
    assert.ok(rejected.reasons.includes("lead-work-or-task-revision-is-stale"));
    assert.equal(rejected.request.status, "rejected");
    assert.equal(f.domain.assignment(leadId).state, "running");
    assert.equal(f.domain.task(taskA).state, "open");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-stale-lead") as { state: string }
      ).state,
      "settled",
      "an exactly bound successful but stale generation has a durable terminal disposition",
    );

    const replay = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-stale-lead",
      terminal: "completed",
    });
    assert.deepEqual(replay.reasons, rejected.reasons);
    assert.equal(replay.request.status, "rejected");
    assert.equal(f.domain.task(taskA).state, "open");
  } finally {
    f.close();
  }
});

test("failed lead terminal rejection leaves its exact result effect pending", () => {
  const f = fixture();
  try {
    const leadId = String(f.leadAssignment(taskA)?.id);
    f.addWork(
      leadId,
      "work-failed-lead",
      "thread-failed-lead",
      "turn-failed-lead",
    );
    const response = f.coordination.requestTaskCompletion({
      threadId: "thread-failed-lead",
      turnId: "turn-failed-lead",
      callId: "call-failed-completion",
      tool: "ensemble_request_completion",
      arguments: { reviewedResultIds: [] },
    });
    const requestId = response.text.split(" ").at(-1) ?? "";
    const rejected = f.coordination.finalizeTaskCompletion({
      requestId,
      workId: "work-failed-lead",
      terminal: "failed",
    });

    assert.equal(rejected.completed, false);
    assert.equal(rejected.request.status, "rejected");
    assert.ok(rejected.reasons.includes("lead-work-not-successful"));
    assert.equal(f.domain.assignment(leadId).state, "running");
    assert.equal(f.domain.task(taskA).state, "open");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-failed-lead") as { state: string }
      ).state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("a successful durable delegation settles only that work effect without completing its assignment", () => {
  const f = fixture();
  try {
    const leadId = String(f.leadAssignment(taskA)?.id);
    f.addWork(
      leadId,
      "work-lead-delegate",
      "thread-lead-delegate",
      "turn-lead-delegate",
    );
    const delegation = f.coordination.delegate({
      threadId: "thread-lead-delegate",
      turnId: "turn-lead-delegate",
      callId: "call-durable-delegation",
      tool: "ensemble_delegate",
      arguments: { profileId: workerProfile, brief: "Check the parser." },
    });
    assert.equal(delegation.success, true);
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
      )
      .run("work-lead-delegate");

    assert.equal(
      f.coordination.recordSuccessfulTerminal("work-lead-delegate"),
      undefined,
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state, reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-lead-delegate") as { state: string; reason: string }
      ).state,
      "settled",
    );
    assert.equal(f.domain.assignment(leadId).state, "running");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          )
          .get("work-child-a") as { state: string }
      ).state,
      "pending",
      "settling the lead delegation effect must not settle a worker work effect",
    );
  } finally {
    f.close();
  }
});
