import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeConversationEvent,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import {
  ConversationHistoryCapture,
  ConversationHistoryStore,
} from "../src/standalone/conversation-history.js";
import { StandaloneService } from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("conversation history integration timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface PlannedTurn {
  id: string;
  beforeReturn?: (
    runtime: HistoryRuntime,
    threadId: string,
    turnId: string,
    workspace: string,
  ) => void;
  loseResponse?: boolean;
}

class HistoryRuntime implements Runtime {
  private conversationListener:
    | ((event: RuntimeConversationEvent) => void)
    | undefined;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private started = deferred<{ threadId: string; turnId: string }>();
  private plans: PlannedTurn[] = [];
  private threadCount = 0;
  private turnStartCount = 0;

  get turnStarts() {
    return this.turnStartCount;
  }

  plan(...turns: PlannedTurn[]) {
    this.plans.push(...turns);
  }

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }

  async startThread() {
    return `thread-${++this.threadCount}`;
  }

  async resumeThread(_threadId: string) {}

  async startTurn(threadId: string, workspace: string) {
    this.turnStartCount += 1;
    const plan = this.plans.shift();
    assert.ok(plan, "test runtime received an explicit turn plan");
    this.started = deferred();
    this.outcomes.set(plan.id, deferred());
    plan.beforeReturn?.(this, threadId, plan.id, workspace);
    this.started.resolve({ threadId, turnId: plan.id });
    if (plan.loseResponse) throw new Error("disposable lost response");
    return plan.id;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversationListener = listener;
  }

  onToolCall(
    _listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ) {}

  emit(event: RuntimeConversationEvent) {
    this.conversationListener?.(event);
  }

  async waitForTurnStart(afterCount = 0) {
    await waitUntil(() => this.turnStartCount > afterCount);
    return this.started.promise;
  }

  complete(turnId: string) {
    this.outcomes.get(turnId)?.resolve("completed");
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}

function query<T extends Record<string, unknown>>(
  root: string,
  sql: string,
  ...parameters: (string | number | null)[]
): T[] {
  const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
  try {
    return db.prepare(sql).all(...parameters) as T[];
  } finally {
    db.close();
  }
}

function serviceDatabase(service: StandaloneService): DatabaseSync {
  return (service as unknown as { db: DatabaseSync }).db;
}

function countRows(root: string, workId: string): number {
  return (
    query<{ count: number }>(
      root,
      "SELECT COUNT(*) AS count FROM conversation_history_items WHERE workId = ?",
      workId,
    )[0]?.count ?? 0
  );
}

function executionState(
  service: StandaloneService,
  workId: string,
  turnStarts: number,
) {
  const intent = service.list().find((item) => item.workId === workId);
  return {
    state: intent?.state ?? "missing",
    threadBound: Boolean(intent?.threadId),
    turnBound: Boolean(intent?.turnId),
    turnStarts,
    workIds: service.list().map((item) => item.workId),
  };
}

async function waitForExecutionState(
  service: StandaloneService,
  workId: string,
  state: string,
) {
  try {
    await waitUntil(
      () =>
        service.list().find((item) => item.workId === workId)?.state === state,
    );
  } catch {
    const executions = service.list().map((item) => ({
      workId: item.workId,
      state: item.state,
      threadBound: Boolean(item.threadId),
      turnBound: Boolean(item.turnId),
    }));
    throw new Error(
      `expected execution state ${state}; observed ${JSON.stringify(executions)}`,
    );
  }
}

async function createTaskAssignment(
  service: StandaloneService,
  projectId: string,
  profileId: string,
) {
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "History test task",
    outcome: "Complete the disposable history test.",
  });
  command(service, {
    type: "assignment.create",
    actor: "operator",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Complete the disposable history test.",
    resultDestination: "lead:task",
    requesterAssignmentId: null,
  });
  await service.provisionTask(taskId);
  return {
    taskId,
    assignmentId,
    workId: `assignment:${assignmentId}:initial`,
    activate() {
      command(service, {
        type: "task.configure",
        actor: "operator",
        projectId,
        taskId,
        expectedVersion: 1,
        ready: true,
      });
    },
  };
}

async function fixture(
  runtime: HistoryRuntime,
  options: { exclusions?: () => readonly string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-history-"));
  const dataDir = join(root, "data");
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    ...(options.exclusions
      ? { conversationHistoryExclusions: options.exclusions }
      : {}),
  });
  const profileId = randomUUID();
  const projectId = randomUUID();
  await service.start();
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "History test profile",
    instructions: "PRIVATE_PROFILE_INSTRUCTION_CANARY",
    capabilities: "test",
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "History test project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
    instructions: "PRIVATE_PROJECT_INSTRUCTION_CANARY",
  });
  const assignment = await createTaskAssignment(service, projectId, profileId);
  return {
    root,
    service,
    profileId,
    projectId,
    ...assignment,
  };
}

test("persists only the response-bound completed item and survives reopen", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime, {
    exclusions: () => ["FIXTURE_SECRET_CANARY"],
  });
  const workId = f.workId;
  const escapedCredential = [
    JSON.stringify({
      token: 'ESCAPED_VALUE_PREFIX_CANARY"ESCAPED_VALUE_SUFFIX_CANARY',
    }),
    "password='SINGLE_ESCAPED_PREFIX_CANARY\\'SINGLE_ESCAPED_SUFFIX_CANARY'",
  ].join(" ");
  runtime.plan({
    id: "turn-bound",
    beforeReturn: (active, threadId, turnId, workspace) => {
      active.emit({
        threadId: "other-thread",
        turnId,
        itemId: "wrong-thread-item",
        kind: "completed",
        text: "WRONG_THREAD_CANARY",
      });
      active.emit({
        threadId,
        turnId: "other-turn",
        itemId: "wrong-turn-item",
        kind: "completed",
        text: "WRONG_TURN_CANARY",
      });
      active.emit({ threadId, turnId, itemId: "answer-1", kind: "started" });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "delta",
        bytes: 9,
      });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "completed",
        text: [
          "A useful answer.",
          "FIXTURE_SECRET_CANARY",
          "PRIVATE_PROFILE_INSTRUCTION_CANARY",
          "PRIVATE_PROJECT_INSTRUCTION_CANARY",
          workspace,
          escapedCredential,
          "Authorization: Bearer BEARER_SECRET_CANARY",
          "password=PASSWORD_SECRET_CANARY",
          "api_key=API_KEY_SECRET_CANARY",
          "https://URL_USER_CANARY:URL_PASSWORD_CANARY@example.test/path",
        ].join(" "),
      });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "completed",
        text: "duplicate must not add a row",
      });
      assert.equal(turnId, "turn-bound");
    },
  });

  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    runtime.emit({
      threadId: bound.threadId,
      turnId: "late-other-turn",
      itemId: "late-wrong-turn",
      kind: "completed",
      text: "LATE_OTHER_TURN_CANARY",
    });
    try {
      await waitUntil(() => countRows(f.root, workId) === 1);
    } catch {
      assert.fail(
        `history row was not written; execution=${JSON.stringify(executionState(f.service, workId, runtime.turnStarts))}`,
      );
    }
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, workId, "completed");

    const rows = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_items WHERE workId = ?",
      workId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.threadId, bound.threadId);
    assert.equal(row.turnId, bound.turnId);
    assert.equal(row.itemId, "answer-1");
    assert.equal(row.lifecycle, "completed");
    const text = String(row.text);
    for (const canary of [
      "FIXTURE_SECRET_CANARY",
      "PRIVATE_PROFILE_INSTRUCTION_CANARY",
      "PRIVATE_PROJECT_INSTRUCTION_CANARY",
      "WRONG_THREAD_CANARY",
      "WRONG_TURN_CANARY",
      "LATE_OTHER_TURN_CANARY",
      "BEARER_SECRET_CANARY",
      "PASSWORD_SECRET_CANARY",
      "API_KEY_SECRET_CANARY",
      "URL_USER_CANARY",
      "URL_PASSWORD_CANARY",
      "ESCAPED_VALUE_PREFIX_CANARY",
      "ESCAPED_VALUE_SUFFIX_CANARY",
      "SINGLE_ESCAPED_PREFIX_CANARY",
      "SINGLE_ESCAPED_SUFFIX_CANARY",
      f.root,
    ])
      assert.ok(
        !text.includes(canary),
        `database projection excludes ${canary}`,
      );
    assert.match(text, /A useful answer\./);
    assert.match(text, /\{"token":\[redacted\]\}/);
    const readItem = f.service
      .coordinationView()
      .readAssignmentHistory(f.assignmentId)
      .items.find((item) => item.itemId === "answer-1");
    assert.equal(readItem?.lifecycle, "completed");
    assert.ok(readItem?.text);
    for (const canary of [
      "ESCAPED_VALUE_PREFIX_CANARY",
      "ESCAPED_VALUE_SUFFIX_CANARY",
      "SINGLE_ESCAPED_PREFIX_CANARY",
      "SINGLE_ESCAPED_SUFFIX_CANARY",
    ])
      assert.ok(!readItem.text.includes(canary));
    await f.service.stop();
    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    try {
      assert.equal(
        (
          reopened
            .prepare(
              "SELECT COUNT(*) AS count FROM conversation_history_items WHERE workId = ? AND itemId = ?",
            )
            .get(workId, "answer-1") as { count: number }
        ).count,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("does not attach an unreturned turn or a response-lost orphan", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const unboundWorkId = f.workId;
  runtime.plan(
    {
      id: "selected-turn",
      beforeReturn: (active, threadId) => {
        active.emit({
          threadId,
          turnId: "unreturned-turn",
          itemId: "unreturned-item",
          kind: "completed",
          text: "UNRETURNED_TURN_CANARY",
        });
      },
    },
    {
      id: "response-lost-turn",
      loseResponse: true,
      beforeReturn: (active, threadId, turnId) => {
        active.emit({
          threadId,
          turnId,
          itemId: "orphan-item",
          kind: "completed",
          text: "ORPHAN_TURN_CANARY",
        });
      },
    },
  );

  try {
    f.activate();
    const selectedTurn = await runtime.waitForTurnStart();
    runtime.emit({
      threadId: selectedTurn.threadId,
      turnId: selectedTurn.turnId,
      itemId: "selected-item",
      kind: "completed",
      text: "SELECTED_TURN_CANARY should remain diagnostic.",
    });
    try {
      await waitUntil(() => countRows(f.root, unboundWorkId) === 1);
    } catch {
      assert.fail(
        `selected history row was not written; execution=${JSON.stringify(executionState(f.service, unboundWorkId, runtime.turnStarts))}`,
      );
    }
    runtime.complete(selectedTurn.turnId);
    await waitForExecutionState(f.service, unboundWorkId, "completed");

    const lostAssignment = await createTaskAssignment(
      f.service,
      f.projectId,
      f.profileId,
    );
    lostAssignment.activate();
    await runtime.waitForTurnStart();
    await waitForExecutionState(f.service, lostAssignment.workId, "held");
    const lostWorkId = lostAssignment.workId;
    assert.equal(countRows(f.root, lostWorkId), 0);
    const allText = query<{ text: string | null }>(
      f.root,
      "SELECT text FROM conversation_history_items",
    )
      .map((row) => row.text ?? "")
      .join(" ");
    assert.ok(!allText.includes("UNRETURNED_TURN_CANARY"));
    assert.ok(!allText.includes("ORPHAN_TURN_CANARY"));
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("keeps incomplete delta bytes out of SQLite and redacts both turn-start and current values", async () => {
  const runtime = new HistoryRuntime();
  let currentSecret = "ROTATED_OLD_SECRET_CANARY";
  const f = await fixture(runtime, { exclusions: () => [currentSecret] });
  const workId = f.workId;
  runtime.plan({
    id: "rotation-turn",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "rotating-item",
        kind: "started",
      });
      active.emit({
        threadId,
        turnId,
        itemId: "rotating-item",
        kind: "delta",
        bytes: 12,
      });
    },
  });

  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    assert.equal(countRows(f.root, workId), 1);
    const activeRows = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_items WHERE workId = ?",
      workId,
    );
    assert.equal(activeRows[0]?.text, null);
    assert.equal(activeRows[0]?.lifecycle, "streaming");

    currentSecret = "ROTATED_NEW_SECRET_CANARY";
    runtime.emit({
      threadId: bound.threadId,
      turnId: bound.turnId,
      itemId: "rotating-item",
      kind: "completed",
      text: `Completed ${currentSecret} and ROTATED_OLD_SECRET_CANARY.`,
    });
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, workId, "completed");
    const completed = query<{ text: string | null }>(
      f.root,
      "SELECT text FROM conversation_history_items WHERE workId = ?",
      workId,
    )[0]?.text;
    assert.ok(completed);
    assert.ok(!completed.includes("ROTATED_OLD_SECRET_CANARY"));
    assert.ok(!completed.includes("ROTATED_NEW_SECRET_CANARY"));
    assert.match(completed, /Completed/);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("early buffer overflow is attached only to the returned immutable turn", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const firstWorkId = f.workId;
  const second = await createTaskAssignment(
    f.service,
    f.projectId,
    f.profileId,
  );
  runtime.plan({
    id: "overflow-selected",
    beforeReturn: (active, threadId, turnId) => {
      for (let index = 0; index <= 8192; index += 1)
        active.emit({
          threadId,
          turnId: index % 2 === 0 ? "other-early-turn" : turnId,
          itemId: `buffered-${index}`,
          kind: "started",
        });
    },
  });
  runtime.plan({
    id: "overflow-other-task",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "shared-item-id",
        kind: "completed",
        text: "Same item identity, different task and thread.",
      });
    },
  });

  try {
    const initialStarts = runtime.turnStarts;
    f.activate();
    const selected = await runtime.waitForTurnStart(initialStarts);
    runtime.emit({
      threadId: selected.threadId,
      turnId: selected.turnId,
      itemId: "shared-item-id",
      kind: "completed",
      text: "The bound turn remains separately visible.",
    });
    const startsBeforeSecond = runtime.turnStarts;
    second.activate();
    const secondTurn = await runtime.waitForTurnStart(startsBeforeSecond);
    runtime.complete(secondTurn.turnId);
    await waitForExecutionState(f.service, second.workId, "completed");
    runtime.complete(selected.turnId);
    await waitForExecutionState(f.service, firstWorkId, "completed");

    const gaps = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_turn_omissions ORDER BY sequence",
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.workId, firstWorkId);
    assert.equal(gaps[0]?.taskId, f.taskId);
    assert.equal(gaps[0]?.turnId, "overflow-selected");
    assert.equal(gaps[0]?.reason, "early-buffer-limit");
    const matchingItems = query<Record<string, unknown>>(
      f.root,
      "SELECT workId, taskId, threadId, turnId, itemId FROM conversation_history_items WHERE itemId = ? ORDER BY sequence",
      "shared-item-id",
    );
    assert.equal(matchingItems.length, 2);
    assert.deepEqual(
      matchingItems.map((row) => row.workId),
      [firstWorkId, second.workId],
    );
    assert.deepEqual(
      matchingItems.map((row) => row.taskId),
      [f.taskId, second.taskId],
    );
    assert.notEqual(matchingItems[0]?.threadId, matchingItems[1]?.threadId);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("history write failures cannot hold or fail the exact bound execution", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const firstWorkId = f.workId;
  const second = await createTaskAssignment(
    f.service,
    f.projectId,
    f.profileId,
  );
  const db = serviceDatabase(f.service);
  runtime.plan({
    id: "flush-write-failure",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "flush-write-item",
        kind: "completed",
        text: "Diagnostic persistence failure is non-authoritative.",
      });
    },
  });
  runtime.plan({
    id: "finish-write-failure",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "finish-write-item",
        kind: "started",
      });
    },
  });

  try {
    db.exec(`CREATE TRIGGER fail_history_insert BEFORE INSERT ON conversation_history_items
      BEGIN SELECT RAISE(ABORT, 'diagnostic write failed'); END`);
    const initialStarts = runtime.turnStarts;
    f.activate();
    const firstTurn = await runtime.waitForTurnStart(initialStarts);
    db.exec("DROP TRIGGER fail_history_insert");

    const startsBeforeSecond = runtime.turnStarts;
    second.activate();
    const secondTurn = await runtime.waitForTurnStart(startsBeforeSecond);
    await waitForExecutionState(f.service, second.workId, "running");
    db.exec(`CREATE TRIGGER fail_history_update BEFORE UPDATE ON conversation_history_items
      BEGIN SELECT RAISE(ABORT, 'diagnostic update failed'); END`);
    runtime.complete(secondTurn.turnId);
    await waitForExecutionState(f.service, second.workId, "completed");
    runtime.complete(firstTurn.turnId);
    await waitForExecutionState(f.service, firstWorkId, "completed");
    const rows = query<Record<string, unknown>>(
      f.root,
      "SELECT workId, lifecycle, text FROM conversation_history_items WHERE workId = ?",
      second.workId,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.lifecycle, "started");
    assert.equal(rows[0]?.text, null);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("assignment history reads are scoped, re-redacted, and bounded in sequence order", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = (index: number, taskId: string, assignmentId: string) => ({
    workId: `work-${index}`,
    taskId,
    assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: `thread-${index}`,
    turnId: `turn-${index}`,
  });

  try {
    for (let index = 0; index <= 200; index += 1) {
      const itemBinding = binding(index, "task-1", "assignment-1");
      history.record(
        itemBinding,
        {
          threadId: itemBinding.threadId,
          turnId: itemBinding.turnId,
          itemId: `item-${index}`,
          kind: "completed",
          text: `history ${index} current-value`,
        },
        [],
      );
    }
    for (const [index, taskId, assignmentId] of [
      [201, "other-task", "assignment-1"],
      [202, "task-1", "other-assignment"],
    ] as const) {
      const itemBinding = binding(index, taskId, assignmentId);
      history.record(
        itemBinding,
        {
          threadId: itemBinding.threadId,
          turnId: itemBinding.turnId,
          itemId: `item-${index}`,
          kind: "completed",
          text: "must not cross assignment scope",
        },
        [],
      );
    }

    const projection = history.readAssignment("task-1", "assignment-1", 200, [
      "current-value",
    ]);
    assert.equal(projection.items.length, 200);
    assert.equal(projection.omittedItemCount, 1);
    assert.equal(projection.turnOmissions.length, 0);
    assert.equal(projection.items[0]?.text, "history 1 [redacted]");
    assert.equal(projection.items.at(-1)?.text, "history 200 [redacted]");
    assert.ok(
      projection.items.every((item) => !item.text?.includes("current-value")),
    );
  } finally {
    db.close();
  }
});

test("current exclusions are computed only for completed items", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = {
    workId: "work-1",
    taskId: "task-1",
    assignmentId: "assignment-1",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-1",
    turnId: "turn-1",
  };
  let exclusionCalls = 0;
  const capture = new ConversationHistoryCapture({
    store: history,
    workId: binding.workId,
    threadId: binding.threadId,
    captureStartExclusions: ["start-value"],
    currentExclusions: () => {
      exclusionCalls += 1;
      return ["current-value"];
    },
  });
  const event = { threadId: binding.threadId, turnId: binding.turnId };

  try {
    assert.equal(capture.bind(binding), true);
    capture.receive({ ...event, itemId: "item-1", kind: "started" });
    capture.receive({ ...event, itemId: "item-1", kind: "delta", bytes: 5 });
    capture.receive({
      ...event,
      itemId: "item-2",
      kind: "omitted",
      reason: "size-limit",
    });
    assert.equal(exclusionCalls, 0);
    capture.receive({
      ...event,
      itemId: "item-1",
      kind: "completed",
      text: "start-value and current-value",
    });
    assert.equal(exclusionCalls, 1);
    const projection = history.readAssignment(
      "task-1",
      "assignment-1",
      200,
      [],
    );
    assert.deepEqual(
      projection.items.map((item) => [item.itemId, item.lifecycle, item.text]),
      [
        ["item-1", "completed", "[redacted] and [redacted]"],
        ["item-2", "omitted", null],
      ],
    );
  } finally {
    db.close();
  }
});
