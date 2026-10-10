import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { ExecutionState } from "../../src/standalone/state.js";
import type { createOperatorFixture } from "./operator-web.js";
export async function until(predicate: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** Search, Source and Readiness live in the closed "More filters" disclosure. */
export async function openMoreFilters(page: Page) {
  await page.locator(".work-more").waitFor();
  const closed = page.locator(".work-more:not([open]) > summary");
  if (await closed.count()) await closed.click();
}
export async function seedCatalog(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
) {
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Accountable lead",
    instructions: "PRIVATE SCENARIO INSTRUCTIONS",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Service integration",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "capacity.configure",
    key: randomUUID(),
    actor: "operator",
    globalLimit: 10,
    projectOverrides: { [projectId]: 10 },
  });
  const task = (title: string, ready = false, blockerTaskIds?: string[]) => {
    const taskId = randomUUID();
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title,
      outcome: "A useful result",
      ready,
      ...(blockerTaskIds ? { blockerTaskIds } : {}),
    });
    return taskId;
  };
  const active = async (title: string) => {
    const id = task(title),
      before = f.runtime.turns;
    await f.service.provisionTask(id);
    d.execute({
      type: "task.configure",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId: id,
      expectedVersion: 1,
      ready: true,
    });
    await until(() =>
      f.service
        .turnRequests()
        .some((r) => r.taskId === id && r.state === "active"),
    );
    await until(() => f.runtime.turns >= before + 1, 15_000);
    const request = f.service
      .turnRequests()
      .find((r) => r.taskId === id && r.state === "active");
    assert.ok(request);
    return { id, request };
  };
  const blocker = task("Open dependency"),
    draft = task("Literal <script>malicious()</script>");
  const waiting = task("Ready but dependent", true, [blocker]);
  const done = task("Completed result"),
    cancelled = task("Cancelled work");
  for (const [taskId, state] of [
    [done, "done"],
    [cancelled, "cancelled"],
  ] as const)
    d.execute({
      type: "task.configure",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      state,
    });
  const question = await active("Question requiring action"),
    normal = await active("Normal Stop observation"),
    uncertainStop = await active("Stop with uncertain ownership"),
    uncertain = await active("Uncertain execution"),
    running = await active("Work running normally");
  const occupied = d.capacityLimits([projectId]).currentUsage.projects[
    projectId
  ];
  assert.equal(occupied, 5);
  d.execute({
    type: "capacity.configure",
    actor: "operator",
    key: randomUUID(),
    globalLimit: 10,
    projectOverrides: { [projectId]: occupied },
  });
  const ready = task("Ready selected", true);
  await f.service.provisionTask(ready);
  await until(() =>
    f.service
      .turnRequests()
      .some((r) => r.taskId === ready && r.state === "queued"),
  );
  assert.equal(d.admission(ready).eligible, true);
  assert.equal(
    f.service
      .turnRequests()
      .filter((r) => r.taskId === ready && r.state === "active").length,
    0,
  );
  const work = f.service
    .list()
    .find((w) => w.workId === question.request.workId);
  assert.ok(work?.threadId && work.turnId);
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "question",
        tool: "ensemble_ask_question",
        arguments: { question: "Which target should be used?" },
      })
    ).success,
    true,
  );
  f.seedPersistedState((db) => {
    const state = new ExecutionState(db);
    state.stopTask(normal.id);
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId=?",
    ).run(normal.request.workId);
    db.prepare("UPDATE turn_requests SET state='active' WHERE workId=?").run(
      normal.request.workId,
    );
    state.stopTask(uncertainStop.id);
    db.prepare("UPDATE execution_intents SET state='held' WHERE workId=?").run(
      uncertain.request.workId,
    );
  });
  const pausedProject = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId: pausedProject,
    name: "Paused project",
    leadProfileId: profileId,
  });
  const paused = randomUUID();
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId: pausedProject,
    taskId: paused,
    title: "Paused work",
    outcome: "Work",
    ready: true,
  });
  await f.service.provisionTask(paused);
  d.execute({
    type: "github.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R-UI03",
        owner: "fixture",
        name: "source",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  const importedTitle =
    "Imported task with a deliberately long source title for narrow operator list and board layouts";
  d.execute({
    type: "github.activate",
    key: randomUUID(),
    actor: "operator",
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  f.service.githubSources().reconcileSelection(projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I-UI03",
        repositoryId: "R-UI03",
        repositoryName: "fixture/source",
        number: 42,
        title: importedTitle,
        body: "Source-owned imported outcome",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  const imported = d.tasks(projectId).find((t) => t.title === importedTitle);
  assert.ok(imported);
  return {
    projectId,
    importedTitle,
    profileId,
    blocker,
    draft,
    waiting,
    ready,
    done,
    cancelled,
    question,
    normal,
    uncertainStop,
    uncertain,
    running,
    paused,
    importedId: String(imported.id),
  };
}
