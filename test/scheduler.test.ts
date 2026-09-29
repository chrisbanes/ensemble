import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import type { Runtime, UnexpectedRequest } from "../src/standalone/codex.js";

class GatedRuntime implements Runtime {
  starts = 0;
  turns = 0;
  prompts: string[] = [];
  entered: (() => void) | undefined;
  release: Promise<void> | undefined;
  async start() {}
  async stop() {}
  async startThread() {
    this.starts++;
    return `thread-${this.starts}`;
  }
  async resumeThread() {}
  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    this.turns++;
    this.prompts.push(prompt);
    return `turn-${this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn() {
    this.entered?.();
    await this.release;
    return "completed" as const;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...command } as never);
}

async function addProject(service: StandaloneService, profileId: string) {
  const projectId = randomUUID();
  execute(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  execute(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  return projectId;
}

async function addReadyAssignment(
  service: StandaloneService,
  projectId: string,
  profileId: string,
  brief: string,
) {
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  execute(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: brief,
    outcome: brief,
    ready: false,
  });
  await service.provisionTask(taskId);
  execute(service, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief,
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute(service, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { assignmentId, taskId, workId: `assignment:${assignmentId}:initial` };
}

async function addProfile(service: StandaloneService) {
  const profileId = randomUUID();
  execute(service, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  return profileId;
}

async function configureCapacity(
  service: StandaloneService,
  globalLimit: number,
  projectOverrides: Record<string, number | null> = {},
) {
  return service.configureCapacity({
    key: randomUUID(),
    globalLimit,
    projectOverrides,
  });
}

interface CapacityRead {
  globalLimit: number;
  defaultProjectLimit: number;
  projectOverrides: Record<string, number>;
  currentUsage: { global: number; projects: Record<string, number> };
  effectiveProjectLimits: Record<string, number>;
}

function capacityLimits(
  service: StandaloneService,
  projectIds: string[],
): CapacityRead {
  return (
    service.domain() as unknown as {
      capacityLimits(ids: string[]): CapacityRead;
    }
  ).capacityLimits(projectIds);
}

function countRows(
  service: StandaloneService,
  sql: string,
  ...args: unknown[]
): number {
  const db = (
    service as unknown as {
      db: {
        prepare(query: string): {
          get(...params: unknown[]): { count: number } | undefined;
        };
      };
    }
  ).db;
  return db.prepare(sql).get(...args)?.count ?? 0;
}

test("eligible pending assignments dispatch once and retain request identity after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-scheduler-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  let service = new StandaloneService(dataDir, () => runtime);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "use deterministic assignments",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Deliver",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const entered = deferred();
    const release = deferred();
    runtime.entered = entered.resolve;
    runtime.release = release.promise;
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Implement the task",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.equal(
      await waitUntil(() => runtime.turns === 1),
      true,
      `eligible assignment was not dispatched: ${JSON.stringify({ requests: service.turnRequests(), intents: service.list(), admission: service.domain().assignmentAdmission(assignmentId) })}`,
    );
    await entered.promise;
    assert.equal(runtime.turns, 1);
    const first = service.list().find((item) => item.state === "running");
    assert.ok(first);
    assert.equal(service.domain().assignment(assignmentId).state, "pending");

    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 2,
      paused: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(runtime.turns, 1);

    release.resolve();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        service.list().find((item) => item.id === first.id)?.state ===
        "completed"
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(
      service.list().find((item) => item.id === first.id)?.state,
      "completed",
      JSON.stringify({
        intent: service.list().find((item) => item.id === first.id),
        request: service.turnRequests(),
      }),
    );
    await service.stop();

    const restartedRuntime = new GatedRuntime();
    service = new StandaloneService(dataDir, () => restartedRuntime);
    await service.start();
    const restored = service.list().find((item) => item.id === first.id);
    assert.equal(restored?.workId, first.workId);
    assert.equal(restored?.state, "completed");
    await service.stop();
    assert.equal(restartedRuntime.turns, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lead bindings are task-scoped and enabled routing waits for an assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-lead-binding-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const routedProjectId = randomUUID();
  const leadProjectId = randomUUID();
  const routedTaskId = randomUUID();
  const leadTaskIds: string[] = [randomUUID(), randomUUID()];
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "coordinate",
      capabilities: "code",
    });
    execute({
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "implement",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId: routedProjectId,
      name: "Routed project",
      leadProfileId,
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId: leadProjectId,
      name: "Lead project",
      leadProfileId,
    });
    for (const projectId of [routedProjectId, leadProjectId])
      execute({
        type: "project.configure",
        actor: "operator",
        projectId,
        expectedVersion: 1,
        paused: false,
      });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId: routedProjectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "route work",
      candidateProfileIds: [workerProfileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId: routedProjectId,
      taskId: routedTaskId,
      title: "Routed task",
      outcome: "Use deterministic routing",
      ready: false,
    });
    for (const taskId of leadTaskIds)
      execute({
        type: "task.create",
        actor: "operator",
        projectId: leadProjectId,
        taskId,
        title: "Lead task",
        outcome: "Ask the lead",
        ready: false,
      });
    await service.provisionTask(routedTaskId);
    for (const taskId of leadTaskIds) await service.provisionTask(taskId);
    const gate = deferred();
    let entered = 0;
    runtime.entered = () => entered++;
    runtime.release = gate.promise;
    for (const taskId of [routedTaskId, ...leadTaskIds])
      execute({
        type: "task.configure",
        actor: "operator",
        projectId: taskId === routedTaskId ? routedProjectId : leadProjectId,
        taskId,
        expectedVersion: 1,
        ready: true,
      });

    const assignmentId = randomUUID();
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId: routedProjectId,
      taskId: routedTaskId,
      assignmentId,
      profileId: workerProfileId,
      brief: "Implement the routed task",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.equal(await waitUntil(() => entered === 3), true);
    const bindings = service.domain().leadBindings();
    assert.equal(bindings.length, 3);
    assert.equal(new Set(bindings.map((binding) => binding.taskId)).size, 3);
    const leadBindings = bindings.filter((binding) =>
      leadTaskIds.includes(String(binding.taskId)),
    );
    assert.equal(
      new Set(leadBindings.map((binding) => binding.assignmentId)).size,
      2,
    );
    assert.equal(service.domain().assignments(routedTaskId).length, 1);
    assert.notEqual(
      service.domain().assignment(assignmentId).id,
      bindings.find((binding) => binding.taskId === routedTaskId)?.assignmentId,
      "routed assignment and task-scoped lead binding must remain distinct",
    );
    const leadRequests = service
      .turnRequests()
      .filter((request) => leadTaskIds.includes(String(request.taskId)));
    assert.equal(leadRequests.length, 2);
    assert.deepEqual(
      new Set(leadRequests.map((request) => request.assignmentId)),
      new Set(leadBindings.map((binding) => binding.assignmentId)),
    );
    gate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct and managed turns share one atomic provisional reservation ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-admission-ledger-"));
  const dataDir = join(root, "data");
  const firstDirect = join(root, "direct-one");
  const secondDirect = join(root, "direct-two");
  mkdirSync(firstDirect);
  mkdirSync(secondDirect);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "use the pending assignment",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Managed task",
      outcome: "Run the assignment",
      ready: false,
    });
    await service.provisionTask(taskId);
    const release = deferred();
    let entered = 0;
    runtime.entered = () => entered++;
    runtime.release = release.promise;
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Managed work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    const directOne = service.submit("direct-one", "Direct one", firstDirect);
    const directTwo = service.submit("direct-two", "Direct two", secondDirect);
    assert.equal(await waitUntil(() => entered === 3), true);
    const db = (
      service as unknown as {
        db: { prepare(sql: string): { all(): unknown[] } };
      }
    ).db;
    const reservations = db
      .prepare(
        "SELECT workId, projectId FROM execution_capacity_reservations ORDER BY workId",
      )
      .all() as { workId: string; projectId: string | null }[];
    assert.equal(reservations.length, 3);
    assert.equal(new Set(reservations.map((row) => row.workId)).size, 3);
    assert.equal(
      reservations.find(
        (row) => row.workId === `assignment:${assignmentId}:initial`,
      )?.projectId,
      projectId,
    );
    assert.equal(
      reservations.filter((row) => row.projectId === null).length,
      2,
    );
    release.resolve();
    await Promise.all([directOne, directTwo]);
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed writer admission rolls back the entire reservation transition", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-admission-rollback-"));
  const service = new StandaloneService(
    join(root, "data"),
    () => new GatedRuntime(),
  );
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "route",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Deliver",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const db = (
      service as unknown as {
        db: {
          exec(sql: string): void;
          prepare(sql: string): { get(...args: unknown[]): { count: number } };
        };
      }
    ).db;
    db.exec(`CREATE TRIGGER fail_writer_admission BEFORE INSERT ON task_writer_admissions
      BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`);
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.equal(
      await waitUntil(() =>
        service
          .turnRequests()
          .some(
            (request) =>
              request.workId === `assignment:${assignmentId}:initial` &&
              request.state === "held",
          ),
      ),
      true,
    );
    assert.equal(
      service
        .list()
        .find((item) => item.workId === `assignment:${assignmentId}:initial`)
        ?.state,
      "held",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM task_writer_admissions").get()
        ?.count,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      service
        .turnRequests()
        .find(
          (request) => request.workId === `assignment:${assignmentId}:initial`,
        )?.state,
      "held",
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default capacity limits count direct and managed turns together", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-capacity-defaults-"));
  const dataDir = join(root, "data");
  const directOne = join(root, "direct-one");
  const directTwo = join(root, "direct-two");
  mkdirSync(directOne);
  mkdirSync(directTwo);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const active = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = active.promise;
  let direct: Promise<unknown>[] = [];
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectA = await addProject(service, profileId);
    const projectB = await addProject(service, profileId);
    direct = [
      service.submit("direct-one", "Direct one", directOne),
      service.submit("direct-two", "Direct two", directTwo),
    ];
    assert.equal(await waitUntil(() => entered === 2), true);

    const managedA = await Promise.all(
      ["A one", "A two", "A three"].map((brief) =>
        addReadyAssignment(service, projectA, profileId, brief),
      ),
    );
    const managedB = await addReadyAssignment(
      service,
      projectB,
      profileId,
      "B one",
    );
    assert.equal(
      await waitUntil(() => entered >= 4),
      true,
      JSON.stringify({
        entered,
        turns: runtime.turns,
        requests: service.turnRequests(),
        intents: service.list(),
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    assert.equal(runtime.turns, 4);
    const db = (
      service as unknown as {
        db: {
          prepare(sql: string): {
            all(...args: unknown[]): unknown[];
          };
        };
      }
    ).db;
    const reservations = db
      .prepare(
        "SELECT workId, projectId FROM execution_capacity_reservations ORDER BY workId",
      )
      .all() as { workId: string; projectId: string | null }[];
    assert.equal(reservations.length, 4);
    assert.equal(
      reservations.filter((row) => row.projectId === null).length,
      2,
    );
    assert.equal(
      reservations.filter((row) => row.projectId === projectA).length,
      2,
    );
    assert.equal(
      reservations.filter((row) => row.projectId === projectB).length,
      0,
    );
    const admittedManaged = managedA.filter((assignment) =>
      reservations.some((row) => row.workId === assignment.workId),
    );
    const waitingManaged = managedA.filter(
      (assignment) =>
        !reservations.some((row) => row.workId === assignment.workId),
    );
    assert.equal(admittedManaged.length, 2);
    assert.equal(waitingManaged.length, 1);
    const waitingManagedWorkId = waitingManaged[0]?.workId;
    assert.ok(waitingManagedWorkId);
    assert.equal(
      reservations.some((row) => row.workId === managedB.workId),
      false,
    );
    for (const workId of [waitingManagedWorkId, managedB.workId]) {
      assert.equal(
        service.list().find((item) => item.workId === workId)?.state,
        "capacity-waiting",
      );
      assert.equal(
        countRows(
          service,
          "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
          workId,
        ),
        0,
      );
    }
  } finally {
    active.resolve();
    await Promise.all(direct);
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lowered capacity preserves active turns and waits for both limits to fit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-capacity-lowering-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  let service = new StandaloneService(dataDir, () => runtime);
  const active = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = active.promise;
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    await configureCapacity(service, 4, { [projectId]: 3 });
    const existing = await Promise.all(
      ["Existing one", "Existing two", "Existing three"].map((brief) =>
        addReadyAssignment(service, projectId, profileId, brief),
      ),
    );
    assert.equal(await waitUntil(() => entered === 3), true);

    await configureCapacity(service, 2, { [projectId]: 1 });
    assert.equal(runtime.turns, 3);
    for (const item of existing)
      assert.equal(
        service.list().find((intent) => intent.workId === item.workId)?.state,
        "running",
      );
    const atLowering = capacityLimits(service, [projectId]);
    assert.equal(atLowering.globalLimit, 2);
    assert.equal(atLowering.defaultProjectLimit, 2);
    assert.equal(atLowering.projectOverrides[projectId], 1);
    assert.equal(atLowering.currentUsage.global, 3);
    assert.equal(atLowering.currentUsage.projects[projectId], 3);
    const waiting = await addReadyAssignment(
      service,
      projectId,
      profileId,
      "After lowering",
    );
    assert.equal(
      await waitUntil(
        () =>
          service.list().find((item) => item.workId === waiting.workId)
            ?.state === "capacity-waiting",
      ),
      true,
      JSON.stringify({
        requests: service.turnRequests(),
        intents: service.list(),
      }),
    );
    assert.equal(runtime.turns, 3);
    assert.equal(
      capacityLimits(service, [projectId]).currentUsage.global,
      3,
      "lowering must not release reservations for admitted work",
    );

    active.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          4,
      ),
      true,
    );
    assert.equal(runtime.turns, 4);
    await service.stop();

    const restartedRuntime = new GatedRuntime();
    service = new StandaloneService(dataDir, () => restartedRuntime);
    await service.start();
    const restored = capacityLimits(service, [projectId]);
    assert.equal(restored.globalLimit, 2);
    assert.equal(restored.projectOverrides[projectId], 1);
    assert.equal(restored.currentUsage.global, 0);
    assert.equal(restartedRuntime.turns, 0);
  } finally {
    active.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity-waiting direct work owns neither ledger and wakes once on the same workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-capacity-waiting-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const firstGate = deferred();
  const secondGate = deferred();
  const thirdGate = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = firstGate.promise;
  let first: Promise<unknown> | undefined;
  try {
    await service.start();
    await configureCapacity(service, 1);
    first = service.submit("first", "First", workspace);
    assert.equal(await waitUntil(() => entered === 1), true);

    runtime.release = secondGate.promise;
    const second = await service.submit("second", "Second", workspace);
    const third = await service.submit("third", "Third", workspace);
    assert.equal(second.state, "capacity-waiting");
    assert.match(
      second.reason ?? "",
      /Capacity waiting: global active-turn limit/,
    );
    assert.equal(third.state, "capacity-waiting");
    assert.equal(runtime.turns, 1);
    for (const workId of ["second", "third"]) {
      assert.equal(
        countRows(
          service,
          "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
          workId,
        ),
        0,
      );
      assert.equal(
        countRows(
          service,
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
          workId,
        ),
        0,
      );
    }

    runtime.release = secondGate.promise;
    firstGate.resolve();
    await first;
    assert.equal(await waitUntil(() => entered === 2), true);
    assert.equal(runtime.prompts[1], "Second");
    runtime.release = thirdGate.promise;
    secondGate.resolve();
    assert.equal(await waitUntil(() => entered === 3), true);
    assert.equal(runtime.prompts[2], "Third");
    thirdGate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.deepEqual(runtime.prompts, ["First", "Second", "Third"]);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    thirdGate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity one yields a completed requester to its child and resumes it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-capacity-yielding-"));
  const runtime = new GatedRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const parentGate = deferred();
  const childGate = deferred();
  const continuationGate = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = parentGate.promise;
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    await configureCapacity(service, 1, { [projectId]: 1 });
    const taskId = randomUUID();
    const parentAssignmentId = randomUUID();
    execute(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Parent task",
      outcome: "Coordinate the child",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: parentAssignmentId,
      profileId,
      brief: "Parent turn",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const parentWorkId = `assignment:${parentAssignmentId}:initial`;
    assert.equal(await waitUntil(() => entered === 1), true);

    const childAssignmentId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: childAssignmentId,
      profileId,
      brief: "Child turn",
      resultDestination: `requester:${parentAssignmentId}`,
      requesterAssignmentId: parentAssignmentId,
    });
    const childWorkId = `assignment:${childAssignmentId}:initial`;
    assert.equal(
      await waitUntil(() =>
        service
          .turnRequests()
          .some((request) => request.workId === childWorkId),
      ),
      true,
    );
    assert.equal(runtime.turns, 1);
    assert.equal(
      service.recordTaskResult(parentWorkId, "early child result"),
      false,
    );
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        childWorkId,
      ),
      0,
    );

    runtime.release = childGate.promise;
    parentGate.resolve();
    assert.equal(await waitUntil(() => entered === 2), true);
    assert.equal(runtime.prompts[0], "Parent turn");
    assert.equal(runtime.prompts[1], "Child turn");
    assert.equal(
      service.list().find((intent) => intent.workId === parentWorkId)?.state,
      "completed",
    );

    const followUpWorkId = "parent-continuation";
    const waitingParent = await service.submitTask(
      followUpWorkId,
      parentAssignmentId,
      "Parent continuation",
      parentWorkId,
    );
    assert.equal(waitingParent.state, "capacity-waiting");
    assert.equal(service.recordTaskResult(followUpWorkId, "early"), false);
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
        followUpWorkId,
      ),
      0,
    );
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        followUpWorkId,
      ),
      0,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.turns, 2);

    runtime.release = continuationGate.promise;
    childGate.resolve();
    assert.equal(await waitUntil(() => entered === 3), true);
    assert.deepEqual(runtime.prompts, [
      "Parent turn",
      "Child turn",
      "Parent continuation",
    ]);
    const wake = (
      service as unknown as { wakeScheduler(): Promise<void> }
    ).wakeScheduler.bind(service);
    await wake();
    await wake();
    assert.equal(runtime.turns, 3);
    continuationGate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().find((intent) => intent.workId === followUpWorkId)
            ?.state === "completed",
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
    assert.equal(
      service
        .turnRequests()
        .filter((request) => request.workId === followUpWorkId).length,
      1,
    );
  } finally {
    parentGate.resolve();
    childGate.resolve();
    continuationGate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
