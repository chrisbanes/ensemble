import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { createOperatorFixture } from "./operator-web.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { seedReviewTask } from "./task-review.js";
import { mixedForm } from "./question-data.js";
import type { QuestionForm } from "../../src/core/question-forms.js";
export async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("Question fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
/** A configured task whose lead has a running turn; the caller decides how that turn ends. */
async function startOwnWork(f: Fixture, title: string, projectName: string) {
  const a = await seedReviewTask(f, projectName, title),
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
  return { a, d, work, priorTurns };
}
/** Pauses the project and completes the turn, leaving the request open for the operator. */
async function finishOwnWork(
  f: Fixture,
  { a, d, work, priorTurns }: Awaited<ReturnType<typeof startOwnWork>>,
) {
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
}
export async function seedOwnQuestion(
  f: Fixture,
  form: QuestionForm = mixedForm,
  title = "Choose full form",
  projectName = "Question project",
) {
  const started = await startOwnWork(f, title, projectName),
    { a, work } = started;
  const call = await f.runtime.callTool({
    threadId: work.threadId!,
    turnId: work.turnId!,
    callId: randomUUID(),
    tool: "ensemble_ask_question",
    arguments: { form },
  });
  assert.equal(call.success, true, call.text);
  const q = f.service.coordinationView().readTask(a.taskId).questions[0]!;
  await finishOwnWork(f, started);
  return { ...a, interactionId: q.interactionId, workId: work.workId, form };
}
/** An open approval request for an exact action and target; the decision control is not in the app. */
export async function seedOwnApproval(
  f: Fixture,
  title = "Approve exact action",
  projectName = "Approval project",
  request = {
    action: "Create a pull request. No merge or deployment.",
    target: "acme/atlas · main ← command-menu",
  },
) {
  const started = await startOwnWork(f, title, projectName),
    { a, work } = started;
  const call = await f.runtime.callTool({
    threadId: work.threadId!,
    turnId: work.turnId!,
    callId: randomUUID(),
    tool: "ensemble_request_approval",
    arguments: { ...request, material: { scope: "fixture" } },
  });
  assert.equal(call.success, true, call.text);
  const approval = f.service.coordinationView().readTask(a.taskId)
    .approvals[0]!;
  await finishOwnWork(f, started);
  return { ...a, interactionId: approval.interactionId, request };
}
/** A task whose running work is held with unknown ownership: the Inbox lists an intervention. */
export async function seedOwnIntervention(
  f: Fixture,
  title = "Restore webhook delivery",
  projectName = "Relay",
) {
  const { a, work } = await startOwnWork(f, title, projectName);
  const intent = f.service.list().find((w) => w.workId === work.workId)!;
  f.seedPersistedState((db) =>
    new ExecutionState(db).hold(intent.id, "Fixture ownership unknown"),
  );
  return { ...a, workId: work.workId };
}
