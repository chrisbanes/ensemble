import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
test("API preserves original durable task receipts independently of current version and paused admission", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const projectId = randomUUID();
  f.service
    .domain()
    .execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      name: "Real project",
      leadProfileId: null,
    });
  const api = new OperatorApi(f.service, [f.directory]);
  const command = {
    type: "task.create" as const,
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Actual task",
    outcome: "Finish",
    ready: true,
  };
  const first = await api.execute(command);
  assert.deepEqual(await api.execute(command), first);
  assert.equal(
    (await api.readTask(command.taskId)).data.execution.state,
    "paused",
  );
  assert.equal(f.runtime.turns, 0);
  await api.execute({
    type: "task.configure",
    key: randomUUID(),
    projectId,
    taskId: command.taskId,
    expectedVersion: 1,
    title: "Changed",
  });
  assert.deepEqual(await api.execute(command), first);
  assert.equal(f.service.domain().tasks(projectId).length, 1);
  await assert.rejects(api.execute({ ...command, title: "Different" }));
  assert.equal(
    (await api.readWorkspace()).data.projects[0]?.name,
    "Real project",
  );
});
async function seed(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  active = false,
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "PRIVATE INSTRUCTIONS",
    capabilities: "coordination",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  if (active)
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Task <script>bad()</script>",
    outcome: "PRIVATE INSTRUCTIONS token=SECRET",
    ready: false,
  });
  if (active) {
    await f.service.provisionTask(taskId);
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await until(() => f.runtime.turns === 1);
  }
  return { profileId, projectId, taskId };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}
test("active execution retains its admitted generation while next-turn instructions advance", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  const before = await api.readTask(ids.taskId);
  const a = before.data.assignments[0];
  assert.ok(a);
  assert.equal(before.data.execution.state, "running");
  f.service
    .domain()
    .execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: ids.projectId,
      expectedVersion: 2,
      instructions: "NEW PRIVATE INSTRUCTIONS",
    });
  const command = {
    type: "assignment.apply" as const,
    key: randomUUID(),
    projectId: ids.projectId,
    assignmentId: a.assignmentId,
    expectedVersion: a.version,
  };
  const receipt = await api.execute(command);
  const after = await api.readTask(ids.taskId);
  assert.equal(after.data.execution.state, "running");
  assert.equal(after.data.assignments[0]?.version, a.version + 1);
  assert.deepEqual(
    after.data.assignments[0]?.executionGeneration,
    a.executionGeneration,
  );
  assert.deepEqual(after.data.execution.holds, before.data.execution.holds);
  assert.deepEqual(await api.execute(command), receipt);
  assert.doesNotMatch(
    JSON.stringify(after),
    /PRIVATE INSTRUCTIONS|SECRET|ensemble-ui02-/,
  );
  assert.match(after.data.task.title ?? "", /<script>/);
});
test("scoped interactions preserve exact material, revision conflicts, and original receipt replay", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const call = (tool: string, args: Record<string, unknown>, callId: string) =>
    f.runtime.callTool({
      threadId: work.threadId ?? "",
      turnId: work.turnId ?? "",
      tool,
      arguments: args,
      callId,
    });
  assert.equal(
    (await call("ensemble_ask_question", { question: "Choose target" }, "q1"))
      .success,
    true,
  );
  assert.equal(
    (
      await call(
        "ensemble_request_approval",
        { action: "Publish", target: "next", material: { version: "next" } },
        "a1",
      )
    ).success,
    true,
  );
  const read = await api.readTask(ids.taskId);
  const q = read.data.questions[0],
    a = read.data.approvals[0];
  assert.ok(q && a);
  assert.deepEqual(a.material, { version: "next" });
  assert.equal(a.approvable, true);
  const answer = {
    type: "question.answer" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: q.interactionId,
    expectedRevision: q.revision,
    answer: "Target A",
  };
  const first = await api.execute(answer);
  assert.deepEqual(await api.execute(answer), first);
  await assert.rejects(api.execute({ ...answer, key: randomUUID() }));
  const approval = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: a.interactionId,
    expectedRevision: a.revision,
    decision: "approved" as const,
    action: "Publish",
    target: "next",
    material: { version: "next" },
  };
  const saved = await api.execute(approval);
  assert.deepEqual(await api.execute(approval), saved);
  await assert.rejects(
    api.execute({ ...approval, material: { version: "other" } }),
  );
  assert.equal(
    (
      await call(
        "ensemble_request_approval",
        { action: "Publish", material: { text: "PRIVATE INSTRUCTIONS" } },
        "a2",
      )
    ).success,
    true,
  );
  const unsafe = (await api.readTask(ids.taskId)).data.approvals.find(
    (v) => v.interactionId !== a.interactionId,
  );
  assert.ok(unsafe);
  assert.equal(unsafe.material, null);
  assert.equal(unsafe.approvable, false);
  await assert.rejects(
    api.execute({
      type: "approval.decide",
      key: randomUUID(),
      taskId: ids.taskId,
      interactionId: unsafe.interactionId,
      expectedRevision: unsafe.revision,
      decision: "approved",
      action: "Publish",
      material: { text: "PRIVATE INSTRUCTIONS" },
    }),
  );
});
test("local dependencies reject foreign, self, cycle and stale writes without changing task", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seed(f),
    b = await seed(f);
  const api = new OperatorApi(f.service, [f.directory]);
  const create = await api.execute({
    type: "task.create",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: randomUUID(),
    title: "Blocker",
    outcome: "Done",
    ready: false,
  });
  assert.equal(create.kind, "domain");
  if (create.kind !== "domain") return;
  const blockerId = create.result.id;
  const add = {
    type: "dependency.add" as const,
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    blockerTaskId: blockerId,
    expectedVersion: 1,
  };
  const first = await api.execute(add);
  assert.deepEqual(await api.execute(add), first);
  for (const command of [
    { ...add, key: randomUUID(), blockerTaskId: a.taskId, expectedVersion: 2 },
    { ...add, key: randomUUID(), blockerTaskId: b.taskId, expectedVersion: 2 },
    {
      ...add,
      key: randomUUID(),
      taskId: blockerId,
      blockerTaskId: a.taskId,
      expectedVersion: 1,
    },
    { ...add, key: randomUUID() },
  ])
    await assert.rejects(api.execute(command));
  assert.equal((await api.readTask(a.taskId)).data.localDependencies.length, 1);
});
test("saved command receipt survives service reopen and a stale fresh key cannot replay it", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  let api = new OperatorApi(f.service, [f.directory]);
  const c = {
    type: "task.configure" as const,
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: 1,
    title: "Saved title",
  };
  const receipt = await api.execute(c);
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await api.execute(c), receipt);
  await assert.rejects(api.execute({ ...c, key: randomUUID() }));
  assert.equal((await api.readTask(ids.taskId)).data.task.title, "Saved title");
});
