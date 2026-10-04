import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SchedulerStore, TurnScheduler } from "../src/standalone/scheduler.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
import { until } from "./fixtures/questions.js";
import { StandaloneService } from "../src/standalone/service.js";

test("initial local Ready task automatically binds one repository-free workspace, replay and restart never duplicate initial dispatch", async () => {
  const f = await createOperatorFixture();
  const projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID();
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  try {
    run({
      type: "profile.create",
      profileId,
      name: "Local lead",
      instructions: "Local work",
      capabilities: "local",
    });
    run({
      type: "project.create",
      projectId,
      name: "Local project",
      leadProfileId: profileId,
    });
    const create = {
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "Local initial task",
      outcome: "Observe local dispatch",
      ready: true,
    } as const;
    f.service.domain().execute(create);
    assert.equal(f.runtime.turns, 0);
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await until(() => f.runtime.turns === 1);
    const binding = await f.service.taskWorkspace(taskId);
    assert.ok(binding);
    assert.deepEqual(binding.repositories, []);
    assert.equal(binding.state, "ready");
    f.service.domain().execute(create);
    assert.equal(
      (await f.service.taskWorkspace(taskId))?.workspaceId,
      binding.workspaceId,
    );
    assert.equal(f.runtime.turns, 1);
    await f.service.stopTask(taskId);
    await f.service.stop();
    const runtime = new OperatorFixtureRuntime();
    const restarted = new StandaloneService(
      `${f.directory}/data`,
      () => runtime,
      undefined,
      { power: { enabled: false } },
    );
    try {
      await restarted.start();
      assert.equal(runtime.turns, 0);
      assert.equal(
        (await restarted.taskWorkspace(taskId))?.workspaceId,
        binding.workspaceId,
      );
      assert.ok(restarted.taskHold(taskId));
    } finally {
      await restarted.stop();
    }
  } finally {
    await f.close();
  }
});

test("automatic local binding preserves drafts, dependency holds, imported grants and lost existing workspace recovery", async () => {
  const f = await createOperatorFixture();
  const projectId = randomUUID(),
    profileId = randomUUID();
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  try {
    run({
      type: "profile.create",
      profileId,
      name: "Bound lead",
      instructions: "Work",
      capabilities: "local",
    });
    run({
      type: "project.create",
      projectId,
      name: "Held project",
      leadProfileId: profileId,
    });
    const draft = randomUUID(),
      missing = randomUUID(),
      imported = randomUUID(),
      dependent = randomUUID();
    for (const id of [draft, missing, imported, dependent])
      run({
        type: "task.create",
        projectId,
        taskId: id,
        title: id,
        outcome: "Keep authority",
        ready: id === imported,
      });
    f.service
      .domain()
      .markImportedTask(imported, "fixture-issue-node", "fixture-repository");
    const binding = await f.service.provisionTask(missing);
    await rm(binding.path, { recursive: true });
    run({
      type: "dependency.add",
      projectId,
      taskId: dependent,
      blockerTaskId: draft,
      expectedVersion: 1,
    });
    for (const taskId of [missing, dependent])
      run({
        type: "task.configure",
        projectId,
        taskId,
        expectedVersion: Number(f.service.domain().task(taskId).version),
        ready: true,
      });
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await until(() =>
      f.service
        .turnRequests()
        .some((r) => r.taskId === missing && r.reason?.includes("Workspace")),
    );
    assert.equal(f.runtime.turns, 0);
    assert.equal(
      (await f.service.taskWorkspace(missing))?.workspaceId,
      binding.workspaceId,
    );
    assert.equal((await f.service.taskWorkspace(missing))?.state, "held");
    const importedAssignment = f.service
      .domain()
      .ensureLeadAssignment(imported);
    assert.ok(importedAssignment);
    await assert.rejects(
      f.service.submitTask(
        randomUUID(),
        String(importedAssignment.id),
        "Imported work remains unbound",
      ),
      /queued until its task workspace is ready/,
    );
    assert.equal(await f.service.taskWorkspace(imported), undefined);
    assert.equal(f.service.domain().task(draft).ready, 0);
    assert.ok(
      f.service
        .domain()
        .admission(dependent, false)
        .reasons.some((r) => r.includes("depend")),
    );
  } finally {
    await f.close();
  }
});

test("missing binding with prior completed execution never creates a replacement initial workspace", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedReviewTask(f);
    a.result("Prior completed work");
    f.seedPersistedState((db) => {
      db.prepare("DELETE FROM task_workspace_bindings WHERE taskId=?").run(
        a.taskId,
      );
    });
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
    await assert.rejects(
      f.service.submitTask(
        randomUUID(),
        a.assignmentId,
        "Continue prior local work",
      ),
      /queued until its task workspace is ready/,
    );
    assert.equal(await f.service.taskWorkspace(a.taskId), undefined);
    assert.equal(f.runtime.turns, 0);
    assert.ok(
      f.service
        .turnRequests()
        .some(
          (r) =>
            r.taskId === a.taskId && r.reason?.includes("no workspace binding"),
        ),
    );
  } finally {
    await f.close();
  }
});

test("stopped scheduler settlement waits for deferred admission while SQLite remains open and never attempts its queued successor", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SchedulerStore(db);
  for (const workId of ["first", "successor"])
    store.ensure({
      requestKey: workId,
      workId,
      kind: "direct",
      taskId: null,
      projectId: null,
      assignmentId: null,
      taskVersion: null,
      assignmentVersion: null,
      instructionsRevision: null,
      profileRevision: null,
      prompt: "Deferred admission",
      workspace: "/synthetic",
      previousWorkId: null,
    });
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const attempts: string[] = [];
  const scheduler = new TurnScheduler(store, async (request) => {
    attempts.push(request.workId);
    entered();
    await gate;
    store.wait(request.workId, "Admission ended while store open");
  });
  try {
    scheduler.start();
    const wake = scheduler.wake();
    await entering;
    scheduler.stop();
    let settled = false;
    const settlement = scheduler.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await Promise.all([wake, settlement]);
    assert.equal(
      store.byWorkId("first").reason,
      "Admission ended while store open",
    );
    assert.deepEqual(attempts, ["first"]);
  } finally {
    release();
    await scheduler.settle();
    db.close();
  }
});

test("service shutdown waits for real deferred workspace admission before closing SQLite and never starts a late turn", async () => {
  const f = await createOperatorFixture();
  const projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID();
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const manager = (
    f.service as unknown as {
      workspaces: { forExecution(id: string): Promise<unknown> };
    }
  ).workspaces;
  const forExecution = manager.forExecution.bind(manager);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  manager.forExecution = async (id) => {
    entered();
    await gate;
    return forExecution(id);
  };
  try {
    run({
      type: "profile.create",
      profileId,
      name: "Deferred lead",
      instructions: "Local work",
      capabilities: "local",
    });
    run({
      type: "project.create",
      projectId,
      name: "Deferred project",
      leadProfileId: profileId,
    });
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    run({
      type: "task.create",
      projectId,
      taskId,
      title: "Deferred initial task",
      outcome: "No late dispatch",
      ready: true,
    });
    await entering;
    let stopped = false;
    const stopping = f.service.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(f.runtime.turns, 0);
    const reader = new DatabaseSync(
      join(f.directory, "data", "standalone.sqlite"),
      { readOnly: true },
    );
    try {
      const request = reader
        .prepare("SELECT state, reason FROM turn_requests WHERE taskId=?")
        .get(taskId);
      assert.equal(request?.state, "held");
      assert.match(String(request?.reason), /Runtime unavailable/);
    } finally {
      reader.close();
    }
  } finally {
    release();
    await f.close();
  }
});
