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
