import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedDeliveryCoverage } from "./fixtures/delivery-coverage.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { deliveryReadSchema } from "../src/operator/contracts.js";
test("curated retained delivery coverage remains bounded with exact omission counts and unchanged authority", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedDeliveryCoverage(f),
    store = f.service.delivery();
  const policy = store.configuration(task.projectId),
    binding = store.delivery(task.taskId),
    blockers = store.completionBlockers(task.taskId);
  const read = (
    await new OperatorApi(f.service, [f.directory]).readTask(task.taskId)
  ).data.delivery!;
  assert.equal(read.binding?.checks.length, 128);
  assert.equal(read.binding.omittedCheckCount, 1);
  assert.equal(read.binding.feedback.length, 128);
  assert.equal(read.binding.omittedFeedbackCount, 2);
  assert.equal(read.actions.length, 128);
  assert.equal(read.omittedActionCount, 3);
  assert.equal(read.omittedBlockerCount, Math.max(0, blockers.length - 128));
  assert.equal(binding?.observation.checks.length, 129);
  assert.equal(binding.observation.checks.at(-1)?.status, "failure");
  assert.equal(binding.observation.feedback?.length, 130);
  assert.equal(store.actions(task.taskId).length, 131);
  assert.deepEqual(store.configuration(task.projectId), policy);
  assert.deepEqual(store.delivery(task.taskId), binding);
  assert.deepEqual(store.completionBlockers(task.taskId), blockers);
  assert.ok(store.actions(task.taskId).every((a) => a.state === "denied"));
  for (const value of [-1, 0.5, "1"]) {
    assert.equal(
      deliveryReadSchema.safeParse({ ...read, omittedActionCount: value })
        .success,
      false,
    );
    assert.equal(
      deliveryReadSchema.safeParse({ ...read, omittedBlockerCount: value })
        .success,
      false,
    );
    assert.equal(
      deliveryReadSchema.safeParse({
        ...read,
        binding: { ...read.binding, omittedCheckCount: value },
      }).success,
      false,
    );
    assert.equal(
      deliveryReadSchema.safeParse({
        ...read,
        binding: { ...read.binding, omittedFeedbackCount: value },
      }).success,
      false,
    );
  }
});
