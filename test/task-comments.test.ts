import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { deliveryFixture } from "./delivery-fixture.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { DeliveryCoordinator } from "../src/standalone/delivery.js";
import { runtimeDeliveryCallerSchema } from "../src/core/delivery.js";
const policy = (
  f: Awaited<ReturnType<typeof deliveryFixture>>,
  mode: "allow" | "approval" | null,
) =>
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.delivery().configuration(f.projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: mode ? [{ action: "issue.comment", repositoryId: "R1", mode }] : [],
    requiredChecks: [],
  });
const send = (
  f: Awaited<ReturnType<typeof deliveryFixture>>,
  body = "Exact operator comment",
  key = randomUUID(),
) => ({
  type: "comment.send" as const,
  key,
  taskId: f.taskId,
  expectedTaskVersion: Number(f.domain.task(f.taskId).version),
  body,
});
test("operator issue.comment uses server-owned imported identity, rejects spoofing/non-comment/wrong target and preserves runtime actor material", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    saved = await api.execute(command);
  assert.equal(saved.kind, "delivery");
  if (saved.kind === "delivery") assert.equal(saved.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0]?.kind, "issue.comment");
  if (f.effects[0]?.kind === "issue.comment")
    assert.equal(f.effects[0].target.nodeId, "I1");
  assert.deepEqual(await api.execute(command), saved);
  await assert.rejects(api.execute({ ...send(f), actor: "runtime" }));
  await assert.rejects(api.execute({ ...send(f), target: { nodeId: "I2" } }));
  const caller = f.service.operatorCommentCaller(f.taskId);
  assert.equal(
    f.service.delivery().prepareAction(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.labels",
          target: { nodeId: "I1", repositoryId: "R1", number: 1 },
          add: ["other"],
          remove: [],
        },
      },
      caller,
      true,
    ).state,
    "denied",
  );
  assert.equal(
    f.service.delivery().prepareAction(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.comment",
          target: { nodeId: "I1", repositoryId: "R1", number: 99 },
          body: "wrong number",
        },
      },
      caller,
      true,
    ).state,
    "denied",
  );
  const runtime = await f.call("ensemble_external_action", {
    operationId: randomUUID(),
    action: {
      kind: "issue.comment",
      target: { nodeId: "I1", repositoryId: "R1", number: 1 },
      body: "Runtime original authority",
    },
  });
  assert.equal(runtime.success, true, runtime.text);
  const runtimeRecord = f.service
    .delivery()
    .actions(f.taskId)
    .find(
      (a) =>
        a.request.action.kind === "issue.comment" &&
        a.request.action.body === "Runtime original authority",
    );
  assert.ok(runtimeRecord);
  assert.deepEqual(
    runtimeDeliveryCallerSchema.parse(runtimeRecord.binding),
    runtimeRecord.binding,
  );
  await assert.rejects(
    f.service.postOperatorComment({
      ...send(f),
      key: runtimeRecord.operationId,
    }),
  );
  assert.equal(f.effects.length, 2);
});
test("approval-mode operator comment requires distinct exact durable review and confirmation; login/generic boolean/unrelated runtime approval cannot authorize", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  policy(f, "approval");
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    review = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: command.key,
      expectedTaskVersion: command.expectedTaskVersion,
      body: command.body,
    });
  assert.equal(review.kind, "comment-review");
  if (review.kind !== "comment-review") assert.fail("review receipt absent");
  assert.equal(review.decision, "pending");
  const caller = f.service.operatorCommentCaller(f.taskId),
    action = {
      kind: "issue.comment" as const,
      target: { nodeId: "I1", repositoryId: "R1", number: 1 },
      body: command.body,
    };
  assert.throws(
    () =>
      f.service.delivery().authorize(
        {
          operationId: command.key,
          action,
          operatorReviewId: review.reviewId,
        },
        caller,
        true,
      ),
    /approval/,
  );
  await assert.rejects(
    api.execute({
      type: "comment.confirm",
      key: randomUUID(),
      taskId: f.taskId,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      materialHash: "0".repeat(64),
      decision: "approved",
    }),
  );
  const confirm = {
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  };
  const approved = await api.execute(confirm);
  assert.deepEqual(await api.execute(confirm), approved);
  const result = await api.execute({ ...command, reviewId: review.reviewId });
  assert.equal(result.kind, "delivery");
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
  assert.equal(
    f.service.delivery().operatorReview(review.reviewId)?.decision,
    "approved",
  );
  assert.equal(f.domain.task(f.taskId).state, "open");
});
test("operator no-grant, task/Stop holds and changed policy during delayed preflight prevent provider effect", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]);
  policy(f, null);
  let result = await api.execute(send(f));
  assert.equal(result.kind, "delivery");
  if (result.kind === "delivery") assert.equal(result.state, "denied");
  assert.equal(f.effects.length, 0);
  policy(f, "allow");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.holdPreflight(gate);
  let entered!: () => void;
  const entry = new Promise<void>((r) => (entered = r));
  f.onPreflight(entered);
  const pending = api.execute(send(f));
  await entry;
  policy(f, null);
  release();
  result = await pending;
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-failure");
  assert.equal(f.effects.length, 0);
  policy(f, "allow");
  await f.service.stopTask(f.taskId);
  result = await api.execute(send(f));
  if (result.kind === "delivery") assert.equal(result.state, "denied");
  assert.equal(f.effects.length, 0);
});
test("unknown provider outcome retains original operator intent across restart and read reconciliation never duplicates a comment", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f);
  f.setActionOutcome({
    state: "uncertain",
    reason: "Lost provider response",
    receipt: null,
  });
  const result = await api.execute(command);
  if (result.kind === "delivery") assert.equal(result.state, "uncertain");
  assert.equal(f.effects.length, 1);
  assert.deepEqual(await api.execute(command), result);
  await f.service.stop();
  await f.service.start();
  assert.equal(
    f.service
      .delivery()
      .actions(f.taskId)
      .find((a) => a.operationId === command.key)?.state,
    "uncertain",
  );
  assert.equal((await api.execute(command)).kind, "delivery");
  f.setInspectOutcome({
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: "C1" },
  });
  await api.execute({
    type: "delivery.refresh",
    key: randomUUID(),
    taskId: f.taskId,
  });
  assert.equal(
    f.service
      .delivery()
      .actions(f.taskId)
      .find((a) => a.operationId === command.key)?.state,
    "confirmed-success",
  );
  assert.equal(f.effects.length, 1);
});
test("approved operator material cannot authorize changed body/source or another operation; denial counterpart is durable", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  policy(f, "approval");
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    review = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: command.key,
      expectedTaskVersion: command.expectedTaskVersion,
      body: command.body,
    });
  if (review.kind !== "comment-review") assert.fail("Review absent");
  await api.execute({
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  const unrelated = await api.execute({
    ...send(f),
    reviewId: review.reviewId,
  });
  if (unrelated.kind === "delivery") assert.equal(unrelated.state, "denied");
  const changed = await api.execute({
    ...command,
    body: "Changed body",
    reviewId: review.reviewId,
  });
  if (changed.kind === "delivery") assert.equal(changed.state, "denied");
  assert.equal(f.effects.length, 0);
  const pending = await api.execute({
    type: "comment.review",
    key: randomUUID(),
    taskId: f.taskId,
    operationId: randomUUID(),
    expectedTaskVersion: command.expectedTaskVersion,
    body: "Separate review",
  });
  if (pending.kind !== "comment-review") assert.fail("Review absent");
  const deny = {
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: pending.reviewId,
    expectedRevision: pending.revision,
    materialHash: pending.materialHash,
    decision: "denied",
  };
  assert.deepEqual(await api.execute(deny), await api.execute(deny));
  assert.equal(
    f.service.delivery().operatorReview(pending.reviewId)?.decision,
    "denied",
  );
});
test("actual source snapshot change during delayed preflight retains its hold and rejects the prior source material before effect", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f);
  let release!: () => void, entered!: () => void;
  f.holdPreflight(new Promise<void>((r) => (release = r)));
  const entry = new Promise<void>((r) => (entered = r));
  f.onPreflight(entered);
  const pending = api.execute(command);
  await entry;
  f.setSourceBody("Changed source requirements");
  f.service.githubSources().reconcileSelection(f.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "org/repo",
        number: 1,
        title: "T",
        body: "Changed source requirements",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  release();
  const result = await pending;
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-failure");
  assert.equal(f.effects.length, 0);
  assert.ok(f.service.githubSources().hold("I1")?.active);
  assert.equal(f.service.taskReview().sources(f.taskId).length, 2);
});
