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

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
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
  };
}

const native = {
  identity: {
    requestId: 7,
    runtimeGeneration: "generation",
    threadId: "thread-child-a",
    turnId: "turn-child-a",
    itemId: "item",
  },
  request: {
    threadId: "thread-child-a",
    turnId: "turn-child-a",
    itemId: "item",
    isBlocking: false as const,
    autoResolutionMs: null,
    questions: [
      {
        id: "q",
        header: "Place",
        question: "Where?",
        isOther: true,
        isSecret: false as const,
        options: [{ label: "Local", description: "Here" }],
      },
    ],
  },
  qualification: {
    codexVersion: "codex-cli 0.159.0" as const,
    executableHash: "a".repeat(64),
    threadId: "thread-child-a",
    runtimeGeneration: "generation",
    mode: "default" as const,
    model: "fixture",
    modelProvider: "fixture",
    reasoningEffort: null,
    serviceTier: null,
    developerInstructionsDigest: "b".repeat(64),
    continuation: "synchronous" as const,
  },
};
test("runtime question answer survives restart without inbox delivery or closing attention", () => {
  const f = fixture();
  try {
    const question = f.coordination.recordRuntimeQuestion(native);
    const command = {
      actor: "operator" as const,
      key: nextCommand(),
      taskId: taskA,
      interactionId: question.interactionId,
      expectedRevision: 1,
      answers: { q: { answers: ["Local"] } },
    };
    const receipt = f.coordination.answerRuntimeQuestion(command);
    assert.equal(receipt.recorded, true);
    assert.equal(f.coordination.inboxEvents(childA).length, 0);
    assert.equal(f.coordination.operatorAttention(taskA)[0]?.status, "open");
    f.reopen();
    assert.deepEqual(f.coordination.answerRuntimeQuestion(command), receipt);
    assert.deepEqual(
      f.coordination.runtimeQuestions(taskA)[0]?.answers,
      command.answers,
    );
    assert.throws(() =>
      f.coordination.answerQuestion({
        actor: "operator",
        key: nextCommand(),
        interactionId: question.interactionId,
        expectedRevision: 2,
        answer: "plain",
      }),
    );
  } finally {
    f.close();
  }
});
test("native immutable intent and exact receipt are monotonic and close only delivery attention", () => {
  const f = fixture();
  try {
    const q = f.coordination.recordRuntimeQuestion(native);
    assert.equal(
      f.coordination.recordRuntimeQuestion(native).interactionId,
      q.interactionId,
    );
    assert.throws(() =>
      f.coordination.recordRuntimeQuestion({
        ...native,
        request: {
          ...native.request,
          questions: [
            { ...required(native.request.questions[0]), question: "Changed" },
          ],
        },
      }),
    );
    const key = nextCommand();
    const command = {
      actor: "operator" as const,
      key,
      taskId: taskA,
      interactionId: q.interactionId,
      expectedRevision: 1,
      answers: { q: { answers: ["Local"] } },
    };
    f.coordination.answerRuntimeQuestion(command);
    assert.throws(() =>
      f.coordination.answerRuntimeQuestion({
        ...command,
        answers: { q: { answers: ["Changed"] } },
      }),
    );
    assert.throws(() =>
      f.coordination.answerRuntimeQuestion({ ...command, key: nextCommand() }),
    );
    const intent = f.coordination.beginRuntimeReply(
      q.interactionId,
      native.identity,
    );
    assert.throws(() =>
      f.coordination.beginRuntimeReply(q.interactionId, native.identity),
    );
    assert.throws(() =>
      f.coordination.recordRuntimeReplyOutcome({
        ...native.identity,
        ...intent,
        answerDigest: "c".repeat(64),
        outcome: "confirmed",
        reason: "Wrong digest",
      }),
    );
    f.coordination.recordRuntimeReplyOutcome({
      ...native.identity,
      ...intent,
      outcome: "sent-unconfirmed",
      reason: "stdin",
      orderedReceipt: { writeInitiated: 1, stdinSucceeded: 2 },
    });
    f.reopen();
    assert.equal(
      f.coordination.runtimeQuestions(taskA)[0]?.deliveryState,
      "sent-unconfirmed",
    );
    const confirmed = f.coordination.recordRuntimeReplyOutcome({
      ...native.identity,
      ...intent,
      outcome: "confirmed",
      reason: "resolution",
      orderedReceipt: {
        writeInitiated: 1,
        stdinSucceeded: 2,
        matchingResolution: 3,
      },
    });
    assert.equal(confirmed.deliveryState, "confirmed");
    assert.equal(
      f.coordination.runtimeQuestionByEndpoint(native.identity)?.deliveryState,
      "confirmed",
      "durable resolution must remain queryable before the runtime retires its endpoint",
    );
    assert.equal(
      f.coordination.runtimeNativeEndpointHistory(native.identity),
      "exact-identity-seen",
    );
    assert.equal(
      f.coordination.recordRuntimeReplyOutcome({
        ...native.identity,
        ...intent,
        outcome: "sent-unconfirmed",
        reason: "late",
      }).deliveryState,
      "confirmed",
    );
    assert.equal(
      f.coordination.recordRuntimeReplyOutcome({
        ...native.identity,
        ...intent,
        outcome: "confirmed",
        reason: "duplicate",
      }).deliveryState,
      "confirmed",
    );
    assert.equal(
      f.coordination.operatorAttention(taskA)[0]?.status,
      "resolved",
    );
    f.coordination.invalidateRuntimeQuestions("restart");
    assert.equal(
      f.coordination.runtimeQuestions(taskA)[0]?.deliveryState,
      "confirmed",
    );
  } finally {
    f.close();
  }
});
for (const boundary of ["request", "answer", "intent", "write"] as const)
  test(`restart at ${boundary} preserves answer truth and unavailable ownership`, () => {
    const f = fixture();
    try {
      const q = f.coordination.recordRuntimeQuestion(native);
      if (boundary !== "request")
        f.coordination.answerRuntimeQuestion({
          actor: "operator",
          key: nextCommand(),
          taskId: taskA,
          interactionId: q.interactionId,
          expectedRevision: 1,
          answers: { q: { answers: ["Local"] } },
        });
      if (boundary === "intent" || boundary === "write") {
        const intent = f.coordination.beginRuntimeReply(
          q.interactionId,
          native.identity,
        );
        if (boundary === "write")
          f.coordination.recordRuntimeReplyOutcome({
            ...native.identity,
            ...intent,
            outcome: "sent-unconfirmed",
            reason: "stdin-only",
          });
      }
      f.reopen();
      f.coordination.invalidateRuntimeQuestions("restart loses exact endpoint");
      const saved = required(f.coordination.runtimeQuestions(taskA)[0]);
      assert.equal(
        saved.deliveryState,
        boundary === "intent" || boundary === "write"
          ? "uncertain"
          : "unavailable",
      );
      assert.equal(Boolean(saved.answers), boundary !== "request");
      assert.equal(f.coordination.operatorAttention(taskA)[0]?.status, "open");
      assert.throws(() =>
        f.coordination.beginRuntimeReply(q.interactionId, native.identity),
      );
    } finally {
      f.close();
    }
  });
