import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
test("exact contextual feedback remains anchored to the original result/source after a revised result and source; one receipt/message and no provider/task/approval effect", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f),
    r2 = task.result("R2 original scope", {
      sourceId: task.source.sourceId,
      criteria: [
        {
          criterionId: task.source.criteria[1]!.criterionId,
          outcome: "failed",
          scope: "Original drafts criterion",
          provenance: "Agent supplied",
        },
      ],
    });
  const reference = {
    resultId: r2.resultId,
    sourceId: task.source.sourceId,
    criterionId: task.source.criteria[1]!.criterionId,
    workId: r2.workId,
  };
  task.result("R3 revised scope", { sourceId: task.source.sourceId });
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: 1,
    outcome: "- [ ] New toolbar requirement",
  });
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='pending' WHERE id=?")
      .run(task.assignmentId),
  );
  const api = new OperatorApi(f.service, [f.directory]),
    command = {
      type: "message",
      key: randomUUID(),
      taskId: task.taskId,
      recipientAssignmentId: task.assignmentId,
      expectedAssignmentVersion: 1,
      message: "Please fix the original drafts criterion",
      reference,
    };
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "coordination");
  assert.deepEqual(await api.execute(command), receipt);
  const read = await api.readTask(task.taskId);
  assert.equal(
    read.data.messages.filter((m) => m.eventType === "operator-message").length,
    1,
  );
  assert.deepEqual(
    read.data.messages.find((m) => m.eventType === "operator-message")
      ?.reference,
    reference,
  );
  assert.equal(read.data.task.state, "open");
  assert.equal(read.data.approvals.length, 0);
  assert.equal(read.data.delivery?.actions.length, 0);
  assert.equal(f.runtime.turns, 0);
  await assert.rejects(
    api.execute({
      ...command,
      key: randomUUID(),
      reference: {
        ...reference,
        sourceId: f.service.taskReview().sources(task.taskId).at(-1)!.sourceId,
      },
    }),
  );
  await assert.rejects(api.execute({ ...command, message: "Changed" }));
});

test("implicit artifact owner rejects partial mismatched source/criterion/work and actual coordination API returns definite conflict without effect", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const artifactId = randomUUID();
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: 1,
    outcome: "- [ ] Revised criterion",
  });
  const source2 = f.service.taskReview().sources(a.taskId).at(-1)!;
  const r = a.delegatedResult("Revised result", {
    sourceId: source2.sourceId,
    artifacts: [
      {
        artifactId,
        label: "Revised artifact",
        role: "evidence",
        revision: 1,
        availability: "unavailable",
      },
    ],
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const command = {
    type: "message",
    key: randomUUID(),
    taskId: a.taskId,
    recipientAssignmentId: a.assignmentId,
    expectedAssignmentVersion: 1,
    message: "Exact editable draft",
    reference: {
      artifactId,
      sourceId: a.source.sourceId,
      criterionId: a.source.criteria[0]!.criterionId,
    },
  };
  for (const reference of [
    command.reference,
    { artifactId, workId: "wrong-work" },
    { resultId: r.resultId, sourceId: a.source.sourceId },
  ]) {
    await assert.rejects(
      api.execute({ ...command, key: randomUUID(), reference }),
      /conflict/,
    );
  }
  assert.equal(
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter((m) => m.eventType === "operator-message").length,
    0,
  );
  assert.equal(f.service.domain().task(a.taskId).state, "open");
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).approvals.length,
    0,
  );
  assert.equal(f.runtime.turns, 0);
  const duplicateId = randomUUID();
  assert.throws(
    () =>
      a.delegatedResult("Duplicate identities", {
        artifacts: ["before", "after"].map((role) => ({
          artifactId: duplicateId,
          label: role,
          role: role as "before" | "after",
          revision: 1,
          availability: "unavailable",
        })),
      }),
    /Duplicate artifact identity/,
  );
});

test("contextual feedback to a completed lead resumes it as a follow-up carrying the exact reference", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  const r = task.result("Lead result", { sourceId: task.source.sourceId });
  assert.equal(
    f.service.domain().assignment(task.assignmentId).state,
    "completed",
  );
  const api = new OperatorApi(f.service, [f.directory]);
  const reference = {
    resultId: r.resultId,
    sourceId: task.source.sourceId,
    workId: r.workId,
  };
  const command = {
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: Number(
      f.service.domain().assignment(task.assignmentId).version,
    ),
    message: "Please revisit this result",
    reference,
  };
  await assert.rejects(
    api.execute({
      ...command,
      key: randomUUID(),
      reference: { ...reference, workId: "wrong-work" },
    }),
    /conflict/,
  );
  assert.equal(
    f.service.domain().assignment(task.assignmentId).state,
    "completed",
  );
  const receipt = await api.execute(command);
  assert.equal(
    (receipt as { eventType: string }).eventType,
    "assignment-follow-up",
  );
  assert.equal((receipt as { resumedLead?: true }).resumedLead, true);
  assert.deepEqual(await api.execute(command), receipt);
  const followUps = (await api.readTask(task.taskId)).data.messages.filter(
    (m) => m.eventType === "assignment-follow-up",
  );
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.text, command.message);
  assert.deepEqual(followUps[0]?.reference, reference);
  assert.equal(f.runtime.turns, 0);
});
