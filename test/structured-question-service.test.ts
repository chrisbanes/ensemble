import {
  seedOwnQuestion,
  until as questionUntil,
} from "./fixtures/questions.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
import { mixedForm, mixedAnswers } from "./fixtures/question-data.js";
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw Error("Full question service condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
for (const hold of ["none", "pause", "stop"] as const)
  test(`full own-tool question after successful terminal records exact >16k group behind ${hold} hold`, async () => {
    const f = await createOperatorFixture();
    try {
      const a = await seedReviewTask(f, "Full questions", "Full form task");
      const d = f.service.domain();
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        expectedVersion: 1,
        paused: false,
      });
      d.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: a.taskId,
        expectedVersion: 1,
        ready: true,
      });
      await until(() => f.runtime.turns === 1);
      const work = f.service.list().find((w) => w.state === "running")!;
      assert.ok(work.threadId && work.turnId);
      const form = structuredClone(mixedForm);
      form.questions.push({
        id: "extra",
        kind: "free-text",
        label: "Additional notes",
        required: true,
      });
      const answers = {
        ...mixedAnswers,
        notes: { optionIds: [], text: "a".repeat(12000) },
        extra: { optionIds: [], text: "b".repeat(12000) },
      };
      const response = await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "full-service-question",
        tool: "ensemble_ask_question",
        arguments: { form },
      });
      assert.equal(response.success, true, response.text);
      const q = f.service.coordinationView().readTask(a.taskId).questions[0]!;
      f.runtime.complete(1);
      await until(() =>
        f.service
          .list()
          .some((w) => w.workId === work.workId && w.state === "completed"),
      );
      if (hold === "pause")
        d.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: a.projectId,
          expectedVersion: 2,
          paused: true,
        });
      if (hold === "stop") await f.service.stopTask(a.taskId);
      const command = {
        taskId: a.taskId,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: 1,
        answers,
      };
      const receipt = await f.service
        .coordinationView()
        .answerQuestionForm(command);
      assert.equal(receipt.recipientAssignmentId, a.assignmentId);
      assert.equal(
        (await f.service.coordinationView().answerQuestionForm(command))
          .eventId,
        receipt.eventId,
      );
      const message = f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.find((m) => m.eventId === receipt.eventId)!;
      assert.deepEqual(message.questionAnswers, answers);
      if (hold === "none") {
        await until(() => f.runtime.turns === 2);
        const prompt = f.runtime.prompts[1]!;
        assert.ok(prompt.includes(JSON.stringify(answers)));
        assert.ok(prompt.includes(work.workId));
        assert.equal(f.runtime.turns, 2);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(f.runtime.turns, 1);
      }
    } finally {
      await f.close();
    }
  });

test("ordinary same-assignment continuation delivers before answer to original request; restart never duplicates answer admission", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f);
    await f.service.stop();
    await f.service.start();
    await f.service.coordinationView().postOperatorMessage({
      taskId: a.taskId,
      key: randomUUID(),
      recipientAssignmentId: a.assignmentId,
      expectedAssignmentVersion: Number(
        f.service.domain().assignment(a.assignmentId).version,
      ),
      message: "Ordinary unrelated follow-up",
    });
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 3,
      paused: false,
    });
    await questionUntil(() => f.runtime.turns === 2);
    assert.ok(f.runtime.prompts[1]?.includes("Ordinary unrelated follow-up"));
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 4,
      paused: true,
    });
    const continuation = f.service.list().find((w) => w.state === "running");
    assert.ok(continuation?.threadId && continuation.turnId);
    const waiting = await f.runtime.callTool({
      threadId: continuation.threadId,
      turnId: continuation.turnId,
      callId: "ordinary-next-action",
      tool: "ensemble_request_approval",
      arguments: { action: "review", material: { revision: 1 } },
    });
    assert.equal(waiting.success, true, waiting.text);
    f.runtime.complete(2);
    await questionUntil(
      () =>
        f.service.list().filter((w) => w.state === "completed").length === 2,
    );
    const command = {
        taskId: a.taskId,
        key: randomUUID(),
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      },
      receipt = await f.service.coordinationView().answerQuestionForm(command);
    await f.service.stop();
    await f.service.start();
    assert.equal(
      (await f.service.coordinationView().answerQuestionForm(command)).eventId,
      receipt.eventId,
    );
    assert.equal(f.runtime.turns, 2);
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 5,
      paused: false,
    });
    await questionUntil(() => f.runtime.turns === 3);
    assert.ok(
      f.runtime.prompts[2]?.includes(JSON.stringify(mixedAnswers)),
      JSON.stringify({
        prompts: f.runtime.prompts,
        requests: f.service.turnRequests(),
        events: f.service.coordinationView().readTask(a.taskId).messages,
      }),
    );
    assert.ok(f.runtime.prompts[2]?.includes(a.workId));
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 6,
      paused: true,
    });
    f.runtime.complete(3);
    await questionUntil(
      () =>
        f.service.list().filter((w) => w.state === "completed").length === 3,
    );
    await f.service.stop();
    await f.service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.runtime.turns, 3);
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      1,
    );
  } finally {
    await f.close();
  }
});
