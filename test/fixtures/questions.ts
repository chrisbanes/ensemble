import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";
import { mixedForm } from "./question-data.js";
import type { QuestionForm } from "../../src/core/question-forms.js";
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("Question fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function seedOwnQuestion(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  form: QuestionForm = mixedForm,
  title = "Choose full form",
) {
  const a = await seedReviewTask(f, "Question project", title),
    d = f.service.domain();
  const priorTurns = f.runtime.turns;
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
  await until(() => f.runtime.turns === priorTurns + 1);
  const work = f.service
    .list()
    .find(
      (w) =>
        w.state === "running" &&
        f.service
          .turnRequests()
          .some((r) => r.taskId === a.taskId && r.workId === w.workId),
    );
  assert.ok(work?.threadId && work.turnId);
  const call = await f.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "ensemble_ask_question",
    arguments: { form },
  });
  assert.equal(call.success, true, call.text);
  const q = f.service.coordinationView().readTask(a.taskId).questions[0]!;
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    expectedVersion: 2,
    paused: true,
  });
  f.runtime.complete(priorTurns + 1);
  await until(() =>
    f.service
      .list()
      .some((w) => w.workId === work.workId && w.state === "completed"),
  );
  return { ...a, interactionId: q.interactionId, workId: work.workId, form };
}
