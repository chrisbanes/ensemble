import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DomainStore } from "../src/core/domain.js";
import { CoordinationStore } from "../src/core/coordination.js";
import { CoordinationView } from "../src/standalone/coordination-view.js";
import { ExecutionState } from "../src/standalone/state.js";
import { RoutingAttemptStore } from "../src/standalone/routing.js";
import { ConversationHistoryStore } from "../src/standalone/conversation-history.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
test("API preserves original durable task receipts independently of current version and paused admission", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const projectId = randomUUID();
  f.service.domain().execute({
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
  f.service.domain().execute({
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
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "next",
  });
  assert.equal(
    (await api.readTask(ids.taskId)).data.approvals.find(
      (v) => v.interactionId === a.interactionId,
    )?.approvable,
    false,
  );
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
  const denied = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: unsafe.interactionId,
    expectedRevision: unsafe.revision,
    decision: "denied" as const,
    action: unsafe.action ?? "",
    ...(unsafe.target === null ? {} : { target: unsafe.target }),
  };
  const deniedReceipt = await api.execute(denied);
  assert.deepEqual(await api.execute(denied), deniedReceipt);
  assert.doesNotMatch(
    JSON.stringify(deniedReceipt),
    /PRIVATE INSTRUCTIONS|SECRET/,
  );
  await assert.rejects(api.execute({ ...denied, key: randomUUID() }));
  await assert.rejects(api.execute({ ...denied, action: "Changed" }));
  await assert.rejects(api.execute({ ...denied, target: "Changed" }));
  await assert.rejects(
    api.execute({ ...denied, material: { text: "Altered" } }),
  );

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
test("unresolved result supplies exact revision and permitted recipient; replay survives resolution and reopen", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const workerId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    assignmentId: workerId,
    profileId: ids.profileId,
    brief: "Report findings",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET resultRecipientDisposition='unresolved' WHERE id=?",
      )
      .run(workerId),
  );
  f.runtime.complete(1);
  await until(() => f.runtime.turns >= 2);
  await until(() =>
    f.service
      .turnRequests()
      .some((r) => r.assignmentId === workerId && r.state === "active"),
  );
  const request = f.service
    .turnRequests()
    .find((r) => r.assignmentId === workerId && r.state === "active");
  assert.ok(request);
  const work = f.service
    .list()
    .find((w) => w.workId === request.workId && w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const result = await f.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: "result1",
    tool: "ensemble_report_result",
    arguments: { summary: "Exact retained result <script>still text</script>" },
  });
  assert.equal(result.success, true, result.text);
  let api = new OperatorApi(f.service, [f.directory]);
  let u = (await api.readTask(ids.taskId)).data.unresolvedResults[0];
  assert.ok(u?.permittedRecipient);
  assert.equal(u.reasonCode, "unresolved-destination");
  const recipientId = u.permittedRecipient.assignmentId;
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET requesterAssignmentId=? WHERE id=?",
      )
      .run(randomUUID(), workerId),
  );
  const unavailable = (await api.readTask(ids.taskId)).data
    .unresolvedResults[0];
  assert.equal(unavailable?.availability, "recipient-unavailable");
  assert.equal(unavailable?.permittedRecipient, null);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET requesterAssignmentId=NULL WHERE id=?",
      )
      .run(workerId),
  );
  u = (await api.readTask(ids.taskId)).data.unresolvedResults[0];
  assert.ok(u?.permittedRecipient);
  const command = {
    type: "result.recipient" as const,
    key: randomUUID(),
    taskId: u.taskId,
    resultId: u.resultId,
    expectedRevision: u.revision,
    recipientAssignmentId: u.permittedRecipient.assignmentId,
  };
  const other = await seed(f);
  const foreignId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: other.projectId,
    taskId: other.taskId,
    assignmentId: foreignId,
    profileId: other.profileId,
    brief: "Foreign",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await assert.rejects(
    api.execute({
      ...command,
      key: randomUUID(),
      recipientAssignmentId: foreignId,
    }),
  );
  const saved = await api.execute(command);
  assert.deepEqual(await api.execute(command), saved);
  assert.equal(
    (await api.readTask(ids.taskId)).data.unresolvedResults.length,
    0,
  );
  assert.equal(
    (await api.readTask(ids.taskId)).data.results[0]?.recipientAssignmentId,
    recipientId,
  );
  await assert.rejects(api.execute({ ...command, key: randomUUID() }));
  await assert.rejects(
    api.execute({ ...command, recipientAssignmentId: foreignId }),
  );
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await api.execute(command), saved);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.resultId === command.resultId,
    ).length,
    1,
  );
});
test("post-commit wakeup rejection is unknown and matching key reconciles one original saved event", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const assignment = f.service.domain().assignments(ids.taskId)[0];
  assert.ok(assignment);
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const domain = new DomainStore(db);
  const coordination = new CoordinationStore(db, domain);
  let rejectWakeup = true;
  const view = new CoordinationView(
    domain,
    coordination,
    new ExecutionState(db),
    new RoutingAttemptStore(db),
    async () => {
      if (rejectWakeup) throw Error("PRIVATE WAKEUP DIAGNOSTIC");
    },
  );
  const api = new OperatorApi(f.service, [f.directory], () => view);
  const command = {
    type: "message" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    recipientAssignmentId: String(assignment.id),
    expectedAssignmentVersion: Number(assignment.version),
    message: "Durable input",
  };
  await assert.rejects(
    api.execute(command),
    (error) =>
      error instanceof Error && error.message === "command-outcome-unknown",
  );
  const before = (await api.readTask(ids.taskId)).data.messages.filter(
    (m) => m.text === "Durable input",
  );
  assert.equal(before.length, 1);
  rejectWakeup = false;
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "coordination");
  if (receipt.kind === "coordination")
    assert.equal(receipt.eventId, before[0]?.eventId);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.text === "Durable input",
    ).length,
    1,
  );
  await assert.rejects(api.execute({ ...command, message: "Different" }));
});
test("history preserves omission identities and excludes captured instructions and paths", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const assignment = f.service.domain().assignments(ids.taskId)[0];
  const request = f.service
    .turnRequests()
    .find((r) => r.assignmentId === assignment?.id);
  const work = f.service.list().find((w) => w.workId === request?.workId);
  assert.ok(assignment && request && work?.threadId && work.turnId);
  const binding = {
    workId: work.workId,
    taskId: ids.taskId,
    assignmentId: String(assignment.id),
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: work.threadId,
    turnId: work.turnId,
  };
  f.seedPersistedState((db) => {
    const history = new ConversationHistoryStore(db);
    history.omitItem(binding, "omitted1", "size-limit");
    history.recordEarlyBufferLimit(binding);
    history.record(
      binding,
      {
        kind: "completed",
        threadId: work.threadId ?? "",
        turnId: work.turnId ?? "",
        itemId: "safe1",
        text: `PRIVATE INSTRUCTIONS ${f.directory} token=SECRET visible text`,
      },
      ["PRIVATE INSTRUCTIONS", f.directory],
    );
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const history = api.readAssignmentHistory(String(assignment.id));
  assert.equal(
    history.data.items.find((i) => i.itemId === "omitted1")?.omissionReason,
    "size-limit",
  );
  assert.equal(history.data.turnOmissions[0]?.reason, "early-buffer-limit");
  assert.equal(
    history.data.items.every((i) => i.assignmentId === assignment.id),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(history),
    /PRIVATE INSTRUCTIONS|SECRET|ensemble-ui02-/,
  );
});
test("retained ownership without a confirmed active intent and held request stays uncertain", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const request = f.service.turnRequests().find((r) => r.state === "active");
  assert.ok(request);
  const api = new OperatorApi(f.service, [f.directory]);
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE execution_intents SET state='held' WHERE workId=?")
      .run(request.workId),
  );
  let read = await api.readTask(ids.taskId);
  assert.equal(read.data.execution.state, "uncertain");
  assert.equal(read.data.execution.holds.writer, true);
  assert.equal(read.data.execution.holds.capacity, true);
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId=?",
    ).run(request.workId);
    db.prepare("UPDATE turn_requests SET state='held' WHERE workId=?").run(
      request.workId,
    );
  });
  read = await api.readTask(ids.taskId);
  assert.equal(read.data.execution.state, "uncertain");
});
test("imported projections validate provider fields and distinguish attempted sync from successful sync", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const d = f.service.domain();
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    credentialRef: "env:UI02_SYNTHETIC_REFERENCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "owner",
        name: "repo",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  const source = f.service.githubSources();
  source.reconcileSelection(ids.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported <script>text</script>",
        body: "PRIVATE INSTRUCTIONS token=SECRET",
        state: "open",
        labels: ["ready"],
        projectFields: [
          { projectNodeId: "P1", fieldNodeId: "F1", optionNodeId: "O1" },
        ],
      },
    ],
  });
  const task = d
    .tasks(ids.projectId)
    .find((t) => t.title === "Imported <script>text</script>");
  assert.ok(task);
  const api = new OperatorApi(f.service, [f.directory]);
  let read = await api.readTask(String(task.id));
  assert.equal(
    read.data.source?.url,
    "https://github.com/owner/repo/issues/42",
  );
  assert.equal(
    read.data.source?.memberships[0]?.projectFields[0]?.optionNodeId,
    "O1",
  );
  assert.ok(read.data.source?.memberships[0]?.sync.lastSuccessfulAt);
  assert.doesNotMatch(
    JSON.stringify(read),
    /PRIVATE INSTRUCTIONS|SECRET|UI02_SYNTHETIC_REFERENCE/,
  );
  await assert.rejects(
    api.execute({
      type: "task.configure",
      key: randomUUID(),
      projectId: ids.projectId,
      taskId: String(task.id),
      expectedVersion: Number(task.version),
      title: "Local override",
    }),
  );
  source.reconcileSelection(ids.projectId, "repo", {
    complete: false,
    reason: "PRIVATE PROVIDER ERROR",
    issues: [],
  });
  read = await api.readTask(String(task.id));
  assert.equal(read.data.source?.memberships[0]?.sync.lastSuccessfulAt, null);
  assert.equal(
    read.data.source?.memberships[0]?.sync.reasonCode,
    "partial-sync",
  );
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE PROVIDER ERROR/);
});
test("omitted-material denial replay remains exact after privacy-context change and service reopen", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "unsafe-denial",
        tool: "ensemble_request_approval",
        arguments: {
          action: "Publish",
          material: { value: "PRIVATE INSTRUCTIONS" },
        },
      })
    ).success,
    true,
  );
  let api = new OperatorApi(f.service, [f.directory]);
  const approval = (await api.readTask(ids.taskId)).data.approvals[0];
  assert.ok(approval);
  assert.equal(approval.materialUnavailable, true);
  const command = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: approval.interactionId,
    expectedRevision: approval.revision,
    decision: "denied" as const,
    action: approval.action ?? "",
  };
  const receipt = await api.execute(command);
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "Different current instructions",
  });
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, []);
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.interactionId === approval.interactionId,
    ).length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE INSTRUCTIONS|SECRET/);
});
