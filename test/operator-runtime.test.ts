import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type { DomainCommand } from "../src/core/domain.js";
import type { Runtime } from "../src/standalone/codex.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import type { RuntimeProcessIdentity } from "../src/standalone/recovery-types.js";
import { StandaloneService } from "../src/standalone/service.js";

const runtime: Runtime = {
  async start() {},
  async stop() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    return "turn";
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
  onUnexpectedRequest() {},
  onToolCall() {},
};

class HeldRuntime implements Runtime {
  turns = 0;
  private resolveTurn!: (status: "completed" | "failed") => void;
  readonly turn: Promise<"completed" | "failed">;

  constructor() {
    this.turn = new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  async start() {}
  async stop() {
    this.resolveTurn("failed");
  }
  async startThread() {
    return "held-thread";
  }
  async resumeThread() {}
  async startTurn() {
    this.turns += 1;
    return "held-turn";
  }
  async interruptTurn() {}
  async waitForTurn() {
    return this.turn;
  }
  onUnexpectedRequest() {}
  onToolCall() {}
}

function deferredOutcome() {
  let resolve!: (status: "completed" | "failed") => void;
  const promise = new Promise<"completed" | "failed">((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RecoveryEvidenceRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: "fixture-process-<script>",
    processStartedAt: "fixture-started-&-bounded",
    bootId: "fixture-boot-identity",
  };
  threads = 0;
  turns = 0;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferredOutcome>
  >();

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }

  processIdentity() {
    return this.process;
  }

  async startThread() {
    return `fixture-thread-${++this.threads}-<img src=x onerror=alert(1)>`;
  }

  async resumeThread() {}

  async startTurn() {
    const turnId = `fixture-turn-${++this.turns}-&-recorded`;
    this.outcomes.set(turnId, deferredOutcome());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest() {}
  onToolCall() {}

  finish(turnId: string, status: "completed" | "failed") {
    this.outcomes.get(turnId)?.resolve(status);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("runtime fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function command(service: StandaloneService, value: object): unknown {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...value,
  } as DomainCommand);
}

test("runtime overview reports effective access limits without exposing configuration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-runtime-operator-"));
  const service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Private profile",
    instructions: "PRIVATE_PROFILE_SENTINEL",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Private project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Private task",
    outcome: "PRIVATE_OUTCOME_SENTINEL",
    ready: false,
  });

  const route = runtimeOperatorRoutes(service).find(
    (candidate) => candidate.method === "GET" && candidate.path === "/runtime",
  );
  assert.ok(route, "runtime overview route exists");
  const page = await route.handler({
    params: {},
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(page.kind, "html");
  if (page.kind !== "html") return;

  assert.match(page.body, /Runtime/);
  assert.match(page.body, /Global active turns: 4/);
  assert.match(page.body, /Default project active turns: 2/);
  assert.match(page.body, /workspace writes with broad host-permitted reads/i);
  assert.match(page.body, /Command network access is disabled/i);
  assert.match(page.body, /Approval policy is never/i);
  assert.match(page.body, /Stricter isolation.*not proved/i);
  assert.doesNotMatch(page.body, /PRIVATE_(?:PROFILE|OUTCOME)_SENTINEL/);
  assert.ok(
    page.body.includes(`/runtime/task/${taskId}`),
    "runtime overview links to task-specific history",
  );
  const taskRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === "/runtime/task/:taskId",
  );
  assert.ok(taskRoute);
  const taskPage = await taskRoute.handler({
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(taskPage.kind, "html");
  if (taskPage.kind === "html") {
    assert.match(taskPage.body, /Paused/);
    assert.match(taskPage.body, /Not ready/);
  }
});

test("runtime overview shows the restart notice only after a runtime failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-runtime-failure-"));
  let fail!: (error: Error) => void;
  const service = new StandaloneService(join(directory, "data"), () => ({
    ...runtime,
    onFailure(listener: (error: Error) => void) {
      fail = listener;
    },
  }));
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  const route = runtimeOperatorRoutes(service).find(
    (candidate) => candidate.method === "GET" && candidate.path === "/runtime",
  );
  assert.ok(route);
  const read = async () => {
    const page = await route.handler({
      params: {},
      fields: {},
      csrfToken: "test-token",
    });
    assert.equal(page.kind, "html");
    return page.kind === "html" ? page.body : "";
  };
  assert.doesNotMatch(await read(), /Codex runtime unavailable/);
  fail(new Error("Runtime lost <script>"));
  const body = await read();
  assert.match(
    body,
    /<p role="alert">Codex runtime unavailable — restart the service<\/p>/,
  );
  assert.doesNotMatch(body, /Runtime lost|<script>/);
});

test("runtime details distinguish selected, queued, and running assignments across projects", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-status-matrix-"),
  );
  const heldRuntime = new HeldRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => heldRuntime,
    undefined,
    { power: { enabled: false } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadA = randomUUID();
  const leadB = randomUUID();
  const worker = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const runningTask = randomUUID();
  const queuedTask = randomUUID();
  const selectedTask = randomUUID();
  const selectedWorker = randomUUID();
  const profiles: Array<[string, string]> = [
    [leadA, "Lead A"],
    [leadB, "Lead B"],
    [worker, "Worker"],
  ];
  for (const [profileId, name] of profiles)
    command(service, {
      type: "profile.create",
      profileId,
      name,
      instructions: `PRIVATE_${name.replaceAll(" ", "_")}_INSTRUCTIONS`,
      capabilities: name.startsWith("Lead") ? "coordinate" : "review",
    });
  command(service, {
    type: "project.create",
    projectId: projectA,
    name: "Project A",
    leadProfileId: leadA,
  });
  command(service, {
    type: "project.create",
    projectId: projectB,
    name: "Project B",
    leadProfileId: leadB,
  });
  for (const projectId of [projectA, projectB]) {
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "No external routing is enabled.",
      credentialRef: null,
      candidateProfileIds: [worker],
    });
  }
  for (const [projectId, taskId, title] of [
    [projectA, runningTask, "Running task"],
    [projectA, queuedTask, "Queued task"],
    [projectB, selectedTask, "Selected task"],
  ])
    command(service, {
      type: "task.create",
      projectId,
      taskId,
      title,
      outcome: "PRIVATE_TASK_OUTCOME",
      ready: false,
    });
  command(service, {
    type: "assignment.create",
    projectId: projectB,
    taskId: selectedTask,
    assignmentId: selectedWorker,
    profileId: worker,
    brief: "PRIVATE_ASSIGNMENT_BRIEF",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const selectedLead = service.domain().ensureLeadAssignment(selectedTask);
  assert.ok(selectedLead);
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectA]: 1 },
  });
  await service.provisionTask(runningTask);
  await service.provisionTask(queuedTask);
  command(service, {
    type: "task.configure",
    projectId: projectA,
    taskId: runningTask,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() => heldRuntime.turns === 1);
  command(service, {
    type: "task.configure",
    projectId: projectA,
    taskId: queuedTask,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() =>
    service
      .turnRequests()
      .some(
        (request) =>
          request.taskId === queuedTask && request.state === "queued",
      ),
  );

  const routes = runtimeOperatorRoutes(service);
  const get = (path: string) => {
    const route = routes.find(
      (candidate) => candidate.method === "GET" && candidate.path === path,
    );
    assert.ok(route, `GET ${path} exists`);
    return route;
  };
  const page = async (taskId: string) =>
    get("/runtime/task/:taskId").handler({
      params: { taskId },
      fields: {},
      csrfToken: "test-token",
    });
  const runningLead = service
    .domain()
    .assignments(runningTask)
    .find((assignment) => assignment.profileId === leadA);
  const queuedLead = service
    .domain()
    .assignments(queuedTask)
    .find((assignment) => assignment.profileId === leadA);
  assert.ok(runningLead && queuedLead);
  const runningPage = await page(runningTask);
  assert.equal(runningPage.kind, "html");
  if (runningPage.kind === "html") {
    assert.match(runningPage.body, /Execution status: Running\./);
    assert.match(runningPage.body, /Accountable project lead: Lead A/);
    assert.match(runningPage.body, /Lead A \(project lead\)/);
    assert.doesNotMatch(
      runningPage.body,
      /PRIVATE_(?:TASK_OUTCOME|ASSIGNMENT_BRIEF|LEAD_A_INSTRUCTIONS)/,
    );
  }
  const queuedPage = await page(queuedTask);
  assert.equal(queuedPage.kind, "html");
  if (queuedPage.kind === "html") {
    assert.match(
      queuedPage.body,
      /Execution status: Queued; waiting for capacity admission\./,
    );
    assert.match(
      queuedPage.body,
      /Lead A \(project lead\)<\/a>: Queued; waiting for capacity admission\./,
    );
  }
  const selectedPage = await page(selectedTask);
  assert.equal(selectedPage.kind, "html");
  if (selectedPage.kind === "html") {
    assert.match(
      selectedPage.body,
      /Execution status: Not ready for admission/,
    );
    assert.match(selectedPage.body, /Accountable project lead: Lead B/);
    assert.match(
      selectedPage.body,
      /Worker<\/a>: Selected; blocked from admission/,
    );
    assert.doesNotMatch(
      selectedPage.body,
      /Project A|Running task|Queued task|PRIVATE_/,
    );
  }
  const selectedAssignmentPage = await get(
    "/runtime/assignment/:assignmentId",
  ).handler({
    params: { assignmentId: selectedWorker },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(selectedAssignmentPage.kind, "html");
  if (selectedAssignmentPage.kind === "html") {
    assert.match(
      selectedAssignmentPage.body,
      /Execution status: Selected; blocked from admission/,
    );
    assert.match(
      selectedAssignmentPage.body,
      /Accountable project lead: Lead B/,
    );
    assert.match(
      selectedAssignmentPage.body,
      new RegExp(`/runtime/task/${selectedTask}`),
    );
    assert.doesNotMatch(selectedAssignmentPage.body, /PRIVATE_/);
  }
  const overview = await get("/runtime").handler({
    params: {},
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(overview.kind, "html");
  if (overview.kind === "html") {
    for (const taskId of [runningTask, queuedTask, selectedTask])
      assert.ok(overview.body.includes(`/runtime/task/${taskId}`));
    assert.match(overview.body, /Project A/);
    assert.match(overview.body, /Project B/);
    assert.doesNotMatch(overview.body, /PRIVATE_/);
  }
});

test("capacity control replays the same keyed change", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-runtime-capacity-"));
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Capacity lead",
    instructions: "coordinate",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Capacity project",
    leadProfileId: profileId,
  });
  const route = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/capacity",
  );
  assert.ok(route, "capacity control route exists");
  const fields = {
    key: randomUUID(),
    globalLimit: "1",
    projectId,
    projectLimit: "1",
  };
  const context = { params: {}, fields, csrfToken: "test-token" };

  assert.deepEqual(await route.handler(context), {
    kind: "redirect",
    location: "/runtime",
  });
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  const restartedRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/capacity",
  );
  assert.ok(restartedRoute, "capacity control route exists after restart");
  assert.deepEqual(await restartedRoute.handler(context), {
    kind: "redirect",
    location: "/runtime",
  });
  assert.equal(service.capacityLimits([projectId]).globalLimit, 1);
  assert.equal(
    service.capacityLimits([projectId]).projectOverrides[projectId],
    1,
  );
});

test("task runtime detail keeps stop and writer holds visible after Resume", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-runtime-task-"));
  const heldRuntime = new HeldRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => heldRuntime,
    undefined,
    { power: { enabled: false }, supervisor: { observationMs: 5 } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Task lead",
    instructions: "PRIVATE_PROFILE_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Hold project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Held <script>window.privateValue=1</script>",
    outcome: "PRIVATE_OUTCOME_SENTINEL",
    ready: true,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await waitUntil(() => heldRuntime.turns > 0);

  const routes = runtimeOperatorRoutes(service);
  const taskRoute = routes.find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === "/runtime/task/:taskId",
  );
  assert.ok(taskRoute, "task runtime history route exists");
  const context = {
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  };
  const runningPage = await taskRoute.handler(context);
  assert.equal(runningPage.kind, "html");
  if (runningPage.kind !== "html") return;
  assert.match(runningPage.body, /Task lead/);
  assert.match(runningPage.body, /Running/);
  assert.match(runningPage.body, /&lt;script&gt;/);
  assert.doesNotMatch(runningPage.body, /<script>/);
  assert.doesNotMatch(runningPage.body, /PRIVATE_(?:PROFILE|OUTCOME)_SENTINEL/);

  await service.stopTask(taskId);
  const stopRoute = routes.find(
    (candidate) =>
      candidate.method === "POST" && candidate.path === "/runtime/control/stop",
  );
  assert.ok(stopRoute, "stop route exists");
  const stopResult = await stopRoute.handler({
    params: {},
    fields: { taskId },
    csrfToken: "test-token",
  });
  assert.deepEqual(stopResult, {
    kind: "redirect",
    location: `/runtime/task/${taskId}`,
  });

  await service.resumeTask(taskId);
  const resumedPage = await taskRoute.handler(context);
  assert.equal(resumedPage.kind, "html");
  if (resumedPage.kind !== "html") return;
  assert.match(resumedPage.body, /Writer ownership remains held/);
  assert.match(resumedPage.body, /may continue/i);
  assert.doesNotMatch(resumedPage.body, /force unlock|stopped and released/i);
  const leadAssignment = service
    .domain()
    .assignments(taskId)
    .find((assignment) => assignment.profileId === profileId);
  assert.ok(leadAssignment);
  const assignmentRoute = routes.find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path === "/runtime/assignment/:assignmentId",
  );
  assert.ok(assignmentRoute);
  const heldAssignmentPage = await assignmentRoute.handler({
    params: { assignmentId: String(leadAssignment.id) },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(heldAssignmentPage.kind, "html");
  if (heldAssignmentPage.kind === "html")
    assert.match(
      heldAssignmentPage.body,
      /Execution status: Held; recovery is required\./,
    );
});

test("task and assignment recovery views render every scoped record without implying release", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-recovery-view-"),
  );
  const runtime = new RecoveryEvidenceRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      supervisor: { observationMs: 5 },
      terminationVerifier: {
        async verify(processIdentity) {
          return {
            kind: "verified",
            processIdentity,
            verifiedAt: "2026-09-30T12:00:00.000Z",
            method: "mac-pid-absent-same-boot",
          };
        },
      },
    },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const workerAssignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Recovery lead",
    instructions: "PRIVATE_RECOVERY_INSTRUCTIONS_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "profile.create",
    profileId: workerProfileId,
    name: "Recovery worker",
    instructions: "PRIVATE_RECOVERY_WORKER_INSTRUCTIONS_SENTINEL",
    capabilities: "review",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Recovery evidence project",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "No routing calls are made by this view fixture.",
    credentialRef: "env:PRIVATE_RECOVERY_CREDENTIAL_SENTINEL",
    candidateProfileIds: [workerProfileId],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Task-scoped recovery evidence",
    outcome: "PRIVATE_RECOVERY_OUTCOME_SENTINEL",
    ready: false,
  });
  const leadAssignment = service.domain().ensureLeadAssignment(taskId);
  assert.ok(leadAssignment);
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId: workerAssignmentId,
    profileId: workerProfileId,
    brief: "PRIVATE_RECOVERY_BRIEF_SENTINEL",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() => runtime.turns === 1);

  await service.stopTask(taskId);
  const firstRecord = service
    .recoveryView()
    .find((record) => record.binding?.taskId === taskId);
  assert.ok(firstRecord?.binding);
  assert.ok(firstRecord.intent.threadId);
  assert.ok(firstRecord.intent.turnId);
  assert.ok(firstRecord.processIdentity);
  const firstTurnId = firstRecord.intent.turnId;
  await service.resolveHeldExecution({
    workId: firstRecord.workId,
    workRevision: firstRecord.generation.workRevision,
    requestSequence: firstRecord.generation.requestSequence,
    threadId: firstRecord.intent.threadId,
    turnId: firstTurnId,
    processIdentity: firstRecord.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "reconciled",
  });
  runtime.finish(firstTurnId, "failed");
  await service.resumeTask(taskId);
  await waitUntil(() => runtime.turns === 2);
  await service.stopTask(taskId);

  const records = service
    .recoveryView()
    .filter((record) => record.binding?.taskId === taskId);
  assert.equal(
    records.length,
    2,
    "both SQLite-backed generations are retained",
  );
  const receiptRecord = records.find((record) => record.receipt !== null);
  const pendingRecord = records.find(
    (record) => record.receipt === null && record.pendingEffects.length > 0,
  );
  assert.ok(receiptRecord?.receipt);
  assert.ok(receiptRecord?.binding);
  assert.ok(pendingRecord?.binding);
  assert.notEqual(receiptRecord.workId, pendingRecord.workId);

  const taskRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === "/runtime/task/:taskId",
  );
  const assignmentRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path === "/runtime/assignment/:assignmentId",
  );
  assert.ok(taskRoute);
  assert.ok(assignmentRoute);
  const taskPage = await taskRoute.handler({
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  });
  const assignmentPage = await assignmentRoute.handler({
    params: { assignmentId: pendingRecord.binding.assignmentId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(taskPage.kind, "html");
  assert.equal(assignmentPage.kind, "html");
  if (taskPage.kind !== "html" || assignmentPage.kind !== "html") return;

  for (const page of [taskPage.body, assignmentPage.body]) {
    assert.match(page, new RegExp(`Recovery record: ${receiptRecord.workId}`));
    assert.match(page, new RegExp(`Recovery record: ${pendingRecord.workId}`));
    assert.ok(
      page.includes(
        `Assignment ${receiptRecord.binding.assignmentId} (version ${receiptRecord.binding.assignmentVersion}; instructions revision ${receiptRecord.binding.instructionsRevision}; profile revision ${receiptRecord.binding.profileRevision})`,
      ),
    );
    assert.match(page, /Generation: work revision 1; request sequence 1/);
    assert.match(page, /Runtime intent: reconciled/);
    assert.match(
      page,
      /intent reason: Execution state requires operator attention/,
    );
    assert.match(page, /Turn request: held/);
    assert.match(
      page,
      /request reason: Execution state requires operator attention/,
    );
    assert.match(
      page,
      /Recorded thread identity.*not proof of termination or release/,
    );
    assert.match(
      page,
      /Recorded turn identity: fixture-turn-[0-9]+-&amp;-recorded/,
    );
    assert.match(page, /Recorded process identity/);
    assert.match(page, /process ID fixture-process-&lt;script&gt;/);
    assert.match(page, /started fixture-started-&amp;-bounded/);
    assert.match(page, /boot identity fixture-boot-identity/);
    assert.match(
      page,
      /Recorded recovery receipt: [0-9a-f-]+; workspace disposition: reconciled/,
    );
    assert.match(
      page,
      /Observation: termination-verified — Original process termination was independently verified/,
    );
    assert.match(
      page,
      /Observation: receipt-accepted — A validated recovery receipt resolved this generation/,
    );
    assert.match(
      page,
      /Pending effect: pending — Assignment result has not been committed/,
    );
    assert.match(page, /Task hold reason: Task stopped/);
    assert.match(
      page,
      /fixture-thread-[0-9]+-&lt;img src=x onerror=alert\(1\)&gt;/,
    );
    assert.doesNotMatch(page, /<img src=x onerror=alert\(1\)>/);
    assert.match(page, /Effects may continue while an execution is stopping/);
    assert.doesNotMatch(page, /no unresolved execution hold is reported/i);
    assert.doesNotMatch(page, /execution stopped and released/i);
    assert.doesNotMatch(
      page,
      /PRIVATE_RECOVERY_(?:INSTRUCTIONS|WORKER_INSTRUCTIONS|OUTCOME|BRIEF|CREDENTIAL)_SENTINEL/,
    );
  }
});

test("dependency controls replay add and remove commands across restart", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-dependencies-"),
  );
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const blockerId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Dependency lead",
    instructions: "coordinate",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Dependency project",
    leadProfileId: profileId,
  });
  for (const [id, title] of [
    [taskId, "Dependent task"],
    [blockerId, "Blocking task"],
  ])
    command(service, {
      type: "task.create",
      projectId,
      taskId: id,
      title,
      outcome: "Deliver work",
      ready: false,
    });

  const routes = runtimeOperatorRoutes(service);
  const add = routes.find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/dependency/add",
  );
  const remove = routes.find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/dependency/remove",
  );
  assert.ok(add, "dependency add route exists");
  assert.ok(remove, "dependency remove route exists");
  const addFields = {
    key: randomUUID(),
    projectId,
    taskId,
    blockerTaskId: blockerId,
    expectedVersion: "1",
  };
  const addContext = { params: {}, fields: addFields, csrfToken: "token" };
  assert.deepEqual(await add.handler(addContext), {
    kind: "redirect",
    location: `/runtime/task/${taskId}`,
  });
  assert.deepEqual(await add.handler(addContext), {
    kind: "redirect",
    location: `/runtime/task/${taskId}`,
  });
  assert.deepEqual(service.domain().dependencies(taskId), [blockerId]);

  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  const restartedAdd = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/dependency/add",
  );
  assert.ok(restartedAdd);
  await restartedAdd.handler(addContext);
  assert.deepEqual(service.domain().dependencies(taskId), [blockerId]);

  const removeFields = {
    key: randomUUID(),
    projectId,
    taskId,
    blockerTaskId: blockerId,
    expectedVersion: "2",
  };
  const removeContext = {
    params: {},
    fields: removeFields,
    csrfToken: "token",
  };
  const restartedRemove = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/dependency/remove",
  );
  assert.ok(restartedRemove);
  assert.deepEqual(await restartedRemove.handler(removeContext), {
    kind: "redirect",
    location: `/runtime/task/${taskId}`,
  });
  assert.deepEqual(await restartedRemove.handler(removeContext), {
    kind: "redirect",
    location: `/runtime/task/${taskId}`,
  });
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  const finalRemove = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/dependency/remove",
  );
  assert.ok(finalRemove);
  await finalRemove.handler(removeContext);
  assert.deepEqual(service.domain().dependencies(taskId), []);
});

test("instruction apply refreshes the selected assignment revision once", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-instructions-"),
  );
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Instruction lead",
    instructions: "original profile instructions",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Instruction project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Instruction task",
    outcome: "Deliver work",
    ready: false,
  });
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "PRIVATE_ASSIGNMENT_PROMPT",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "updated project instructions",
  });

  const route = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/instruction-apply",
  );
  assert.ok(route, "instruction apply route exists");
  const context = {
    params: {},
    fields: {
      key: randomUUID(),
      projectId,
      assignmentId,
      expectedVersion: "1",
    },
    csrfToken: "token",
  };
  assert.deepEqual(await route.handler(context), {
    kind: "redirect",
    location: `/runtime/assignment/${assignmentId}`,
  });
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  const restartedRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/instruction-apply",
  );
  assert.ok(restartedRoute);
  assert.deepEqual(await restartedRoute.handler(context), {
    kind: "redirect",
    location: `/runtime/assignment/${assignmentId}`,
  });
  const assignment = service.domain().assignment(assignmentId);
  assert.equal(Number(assignment.version), 2);
  assert.equal(Number(assignment.instructionsRevision), 2);
  const readRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path === "/runtime/assignment/:assignmentId",
  );
  assert.ok(readRoute);
  const page = await readRoute.handler({
    params: { assignmentId },
    fields: {},
    csrfToken: "token",
  });
  assert.equal(page.kind, "html");
  if (page.kind === "html")
    assert.doesNotMatch(
      page.body,
      /PRIVATE_ASSIGNMENT_PROMPT/,
      "assignment prompts stay out of the operator route",
    );
});
