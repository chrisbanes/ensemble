import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { taskSchema } from "../src/operator/contracts.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { ExecutionState } from "../src/standalone/state.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

function configure(f: Fixture, projectId: string, paused: boolean) {
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    paused,
  });
}

/** Runs the lead's first turn through the real scheduler until it reports a result. */
async function completedLead(f: Fixture, name: string) {
  const task = await seedReviewTask(f, name);
  const domain = f.service.domain();
  configure(f, task.projectId, false);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(domain.task(task.taskId).version),
    ready: true,
  });
  await until(() => f.runtime.hasPending(1), "turn 1");
  const first = f.service.list().find((work) => work.state === "running");
  assert.ok(first?.threadId && first.turnId);
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace?.state === "ready");
  await writeFile(join(workspace.path, "lead.txt"), "lead output\n");
  const reported = await f.runtime.callTool({
    threadId: first.threadId,
    turnId: first.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: { summary: "Lead finished the first pass" },
  });
  assert.equal(reported.success, true, reported.text);
  f.runtime.complete(1);
  await until(
    () =>
      domain.assignment(task.assignmentId).state === "completed" &&
      !f.service.list().some((work) => work.state === "running"),
    "lead completion",
  );
  return { task, first, api: new OperatorApi(f.service, []) };
}

function workRevision(f: Fixture, workId: string) {
  let revision = 0;
  f.seedPersistedState((db) => {
    revision = Number(
      (
        db
          .prepare(
            "SELECT workRevision FROM task_work_revisions WHERE workId=?",
          )
          .get(workId) as { workRevision: number }
      ).workRevision,
    );
  });
  return revision;
}

function completionRequests(f: Fixture, taskId: string) {
  let count = 0;
  f.seedPersistedState((db) => {
    count = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM coordination_completion_requests WHERE taskId=?",
          )
          .get(taskId) as { count: number }
      ).count,
    );
  });
  return count;
}

test("a message to a completed lead resumes its conversation through the scheduler", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, first, api } = await completedLead(f, "Message follow-up");
  const before = await api.readTask(task.taskId);
  assert.deepEqual(before.data.leadFeedback, {
    mode: "resumes",
    awaitingRecoveryMessage: false,
  });
  const { leadFeedback: _leadFeedback, ...withoutLeadFeedback } = before.data;
  assert.equal(
    taskSchema.safeParse({ ...before, data: withoutLeadFeedback }).success,
    true,
  );
  assert.equal(
    taskSchema.safeParse({
      ...before,
      data: {
        ...before.data,
        leadFeedback: { mode: "reopens", awaitingRecoveryMessage: false },
      },
    }).success,
    false,
  );
  const version = Number(
    f.service.domain().assignment(task.assignmentId).version,
  );
  const command = {
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: version,
    message: "Please also handle the empty state.",
  };
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "coordination");
  assert.equal(
    (receipt as { eventType: string }).eventType,
    "assignment-follow-up",
  );
  assert.equal((receipt as { resumedLead?: true }).resumedLead, true);

  await until(() => f.runtime.hasPending(2), "resumed turn");
  assert.match(
    f.runtime.prompts[1] ?? "",
    /assignment-follow-up:.*Please also handle the empty state\./,
  );
  const resumed = f.service
    .list()
    .find((work) => work.state === "running" && work.workId !== first.workId);
  assert.ok(resumed);
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(
    workRevision(f, resumed.workId),
    workRevision(f, first.workId) + 1,
  );
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(f.runtime.turns, 2);

  const read = await api.readTask(task.taskId);
  assert.equal(read.data.leadFeedback?.mode, "receives");
  const followUp = read.data.messages.find(
    (message) => message.eventType === "assignment-follow-up",
  );
  assert.equal(followUp?.text, command.message);
  assert.equal(followUp?.requester, "operator");
  // Holds, approval, readiness and merge authority are untouched.
  assert.equal(read.data.task.state, "open");
  assert.equal(read.data.task.ready, true);
  assert.equal(read.data.approvals.length, 0);
  assert.equal(read.data.delivery?.actions.length ?? 0, 0);
  assert.equal(completionRequests(f, task.taskId), 0);
  assert.equal(f.service.taskHold(task.taskId), undefined);
});

test("a review sent to a completed lead while paused resumes it with exact anchors on unpause", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, api } = await completedLead(f, "Review follow-up");
  configure(f, task.projectId, true);
  const owner = { ownerKey: randomUUID(), current: () => true };
  const staged = (await api.execute(
    {
      type: "review.anchor.stage",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      anchors: [
        {
          taskId: task.taskId,
          repositoryId: null,
          path: "lead.txt",
          sourceKind: "workspace-file",
          context: "workspace",
          side: "file",
          startLine: 1,
          endLine: 1,
          contentSha256: digest("lead output\n"),
        },
      ],
    },
    owner,
  )) as { groupId: string; draftVersion: number };
  const saved = (await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: staged.draftVersion,
      draft: {
        summary: "",
        comments: [
          {
            commentId: randomUUID(),
            body: "Rename the output file",
            anchorGroupIds: [staged.groupId],
          },
        ],
      },
    },
    owner,
  )) as { version: number };
  const version = Number(
    f.service.domain().assignment(task.assignmentId).version,
  );
  const key = randomUUID();
  const sent = (await api.execute(
    {
      type: "review.send",
      key,
      taskId: task.taskId,
      expectedDraftVersion: saved.version,
      recipientAssignmentId: task.assignmentId,
      expectedAssignmentVersion: version,
    },
    owner,
  )) as { kind: string; state: string; resumedLead?: true };
  assert.equal(sent.kind, "local-review-operation");
  assert.equal(sent.state, "recorded");
  assert.equal(sent.resumedLead, true);
  const operation = await api.readLocalReviewOperation(task.taskId, key, owner);
  assert.equal(operation.data.resumedLead, true);
  const lead = f.service.domain().assignment(task.assignmentId);
  assert.equal(lead.state, "pending");
  assert.equal(Number(lead.version), version + 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, 1, "a paused project starts no turn");
  // The live journey (test/wi828) plans the resumed turn from this queued batch.
  let batch: { deliveryWorkId: string; eventTypes: string[]; first: string } = {
    deliveryWorkId: "",
    eventTypes: [],
    first: "",
  };
  f.seedPersistedState((db) => {
    const rows = db
      .prepare(
        "SELECT batchId, deliveryWorkId FROM coordination_delivery_batches WHERE recipientAssignmentId = ? AND state = 'queued'",
      )
      .all(task.assignmentId) as Array<{
      batchId: string;
      deliveryWorkId: string;
    }>;
    assert.equal(rows.length, 1);
    const events = db
      .prepare(
        "SELECT event.eventId, event.eventType FROM coordination_delivery_events delivery JOIN coordination_inbox_events event ON event.eventId = delivery.eventId WHERE delivery.batchId = ? ORDER BY delivery.ordinal",
      )
      .all(rows[0]!.batchId) as Array<{ eventId: string; eventType: string }>;
    batch = {
      deliveryWorkId: rows[0]!.deliveryWorkId,
      eventTypes: events.map((event) => event.eventType),
      first: events[0]!.eventId,
    };
  });
  assert.ok(batch.eventTypes.includes("assignment-follow-up"));
  assert.equal(
    batch.deliveryWorkId,
    `assignment:${task.assignmentId}:v${version + 1}:inbox:${batch.first}`,
  );

  configure(f, task.projectId, false);
  await until(() => f.runtime.hasPending(2), "resumed review turn");
  const prompt = f.runtime.prompts[1] ?? "";
  assert.match(prompt, /assignment-follow-up:.*Rename the output file/);
  assert.match(prompt, /lead\.txt · lines 1-1/);
  assert.match(prompt, /retained anchor [0-9a-f-]{36}/);
});

test("feedback refusals for a completed lead are definitive conflicts with no events", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, []);
  const cases: Array<{
    name: string;
    arrange: (
      task: Awaited<ReturnType<typeof seedReviewTask>>,
    ) => { recipient?: string; versionOffset?: number } | undefined;
  }> = [
    {
      name: "done task",
      arrange: (task) => {
        f.seedPersistedState((db) =>
          db
            .prepare("UPDATE domain_tasks SET state='done' WHERE id=?")
            .run(task.taskId),
        );
        return undefined;
      },
    },
    {
      name: "held lead",
      arrange: (task) => {
        f.seedPersistedState((db) =>
          db
            .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
            .run(task.assignmentId),
        );
        return undefined;
      },
    },
    {
      name: "cancelled task",
      arrange: (task) => {
        f.seedPersistedState((db) =>
          db
            .prepare("UPDATE domain_tasks SET state='cancelled' WHERE id=?")
            .run(task.taskId),
        );
        return undefined;
      },
    },
    {
      name: "newer lead work",
      arrange: (task) => {
        const workId = randomUUID();
        f.seedPersistedState((db) => {
          db.prepare(
            "INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval) VALUES(?,?,'fixture','/tmp/fixture','running',?,?,'chatgpt','workspaceWrite','never')",
          ).run(randomUUID(), workId, workId, workId);
          new ExecutionState(db).bindTask(workId, {
            taskId: task.taskId,
            assignmentId: task.assignmentId,
            assignmentVersion: Number(
              f.service.domain().assignment(task.assignmentId).version,
            ),
            instructionsRevision: 1,
            profileRevision: 1,
          });
          db.prepare(
            "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) SELECT ?,assignmentId,conversationRevision,MAX(workRevision)+1 FROM task_work_revisions WHERE assignmentId=?",
          ).run(workId, task.assignmentId);
        });
        return undefined;
      },
    },
    { name: "stale version", arrange: () => ({ versionOffset: 1 }) },
    {
      name: "completed non-lead",
      arrange: (task) => ({
        recipient: task.delegatedResult("Delegate done").assignmentId,
      }),
    },
    {
      name: "ambiguous lead work",
      arrange: (task) => {
        f.seedPersistedState((db) =>
          db
            .prepare(
              "INSERT INTO task_work_revision_ambiguities (workId, assignmentId, conversationRevision, reason) SELECT workId, assignmentId, conversationRevision, 'test' FROM task_work_revisions WHERE assignmentId=?",
            )
            .run(task.assignmentId),
        );
        return undefined;
      },
    },
  ];
  for (const testCase of cases) {
    const task = await seedReviewTask(f, `Refused ${testCase.name}`);
    task.result("Lead finished");
    const arranged = testCase.arrange(task) ?? {};
    const recipient = arranged.recipient ?? task.assignmentId;
    const before = (await api.readTask(task.taskId)).data.messages.length;
    await assert.rejects(
      api.execute({
        type: "message",
        key: randomUUID(),
        taskId: task.taskId,
        recipientAssignmentId: recipient,
        expectedAssignmentVersion:
          Number(f.service.domain().assignment(recipient).version) +
          (arranged.versionOffset ?? 0),
        message: "Refused feedback",
      }),
      (error: unknown) =>
        (error as { status?: number }).status === 409 &&
        (error as { code?: string }).code === "conflict",
      testCase.name,
    );
    const after = await api.readTask(task.taskId);
    assert.equal(after.data.messages.length, before, testCase.name);
    assert.equal(
      after.data.messages.some(
        (message) => message.eventType === "assignment-follow-up",
      ),
      false,
      testCase.name,
    );
  }
});
