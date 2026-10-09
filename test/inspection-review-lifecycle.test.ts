import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
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

// The deterministic shape of the bounded #782 live journey: exactly three turn
// starts (initial, automatic reporting repair, review delivery), a review queued
// while admission is paused, and a third turn that reports a result before Stop.
test("three-start lifecycle: paused review, reporting repair, then a stopped review-delivery turn with a result", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Lifecycle",
    "Inspect a bounded lifecycle",
    "Capture turns and send one review",
  );
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace);
  const marker = join(workspace.path, "marker.txt");
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.project(task.projectId).version),
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(domain.task(task.taskId).version),
    ready: true,
  });

  // Turn 1 finishes without a result; pause before its automatic repair runs.
  await until(() => f.runtime.hasPending(1), "turn 1");
  await writeFile(marker, "turn one\n");
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.project(task.projectId).version),
    paused: true,
  });
  f.runtime.complete(1);
  await until(
    () =>
      f.service.workspaceTurnCaptureSlots(task.taskId).latestFinished !==
      undefined,
    "turn 1 capture",
  );
  const capture1 = f.service.workspaceTurnCaptureSlots(
    task.taskId,
  ).latestFinished;

  // While paused, one local review is recorded for the still-active lead.
  const api = new OperatorApi(f.service, []);
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
          path: "marker.txt",
          sourceKind: "workspace-file",
          context: "workspace",
          side: "file",
          startLine: 1,
          endLine: 1,
          contentSha256: digest("turn one\n"),
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
            body: "Review after the bounded turns",
            anchorGroupIds: [staged.groupId],
          },
        ],
      },
    },
    owner,
  )) as { version: number };
  const sent = (await api.execute(
    {
      type: "review.send",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: saved.version,
      recipientAssignmentId: task.assignmentId,
      expectedAssignmentVersion: Number(
        domain.assignment(task.assignmentId).version,
      ),
    },
    owner,
  )) as { state: string };
  assert.equal(sent.state, "recorded");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, 1, "a paused review starts no turn");

  // Unpausing first runs the automatic reporting repair as turn 2.
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.project(task.projectId).version),
    paused: false,
  });
  await f.service.resumeTask(task.taskId);
  await until(() => f.runtime.hasPending(2), "turn 2");
  assert.match(f.runtime.prompts[1] ?? "", /Reporting repair/);
  await writeFile(marker, "turn two\n");
  f.runtime.complete(2);
  await until(
    () =>
      f.service.workspaceTurnCaptureSlots(task.taskId).latestFinished
        ?.comparisonId !== capture1?.comparisonId,
    "turn 2 capture",
  );
  const capture2 = f.service.workspaceTurnCaptureSlots(
    task.taskId,
  ).latestFinished;
  assert.notEqual(capture2?.turnId, capture1?.turnId);

  // Turn 3 delivers the queued review; it reports a real result, then is stopped.
  await until(() => f.runtime.hasPending(3), "turn 3");
  const delivered = f.runtime.prompts[2] ?? "";
  assert.match(delivered, /operator-message.*Review after the bounded turns/);
  // The lead receives exact identity and the original excerpt, not path/line alone.
  assert.match(
    delivered,
    /task workspace marker\.txt · lines 1-1 · workspace · sha256 [a-f0-9]{64} · retained anchor /,
  );
  assert.match(delivered, /\| turn one/);
  const third = f.service.list().find((work) => work.state === "running");
  assert.ok(third?.threadId && third.turnId);
  await writeFile(marker, "turn three\n");
  const reported = await f.runtime.callTool({
    threadId: third.threadId,
    turnId: third.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Turn three result",
      review: {
        sourceId: task.source.sourceId,
        changes: { files: ["marker.txt"] },
      },
    },
  });
  assert.equal(reported.success, true, reported.text);
  const result = f.service
    .coordinationView()
    .readTask(task.taskId)
    .results.find((item) => item.workId === third.workId);
  assert.ok(result);
  const retained = f.service.retainedEvidence();
  const original = retained
    .result(task.taskId, result.resultId)
    ?.items.find((item) => item.path === "marker.txt");
  assert.ok(original?.state === "available");
  const stopped = f.service.stopTask(task.taskId);
  f.runtime.fail(3);
  await stopped;
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn 3 settlement",
  );
  const hold = f.service.taskHold(task.taskId);
  assert.ok(hold, "Stop leaves a task hold");

  // Later bytes never replace the retained result; nothing starts a fourth turn.
  await writeFile(marker, "after the journey\n");
  assert.deepEqual(
    retained.item(task.taskId, result.resultId, original.itemId)?.bytes,
    Buffer.from("turn three\n"),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, 3, "no fourth start");
  assert.equal(f.service.taskHold(task.taskId), hold);
});
