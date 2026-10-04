import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import type { RoutingChoiceClient } from "../src/standalone/routing.js";
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

test("coordination adapter owns task-scoped read and mutation routes", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-coordination-"),
  );
  const service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const routes = coordinationOperatorRoutes(
    service.coordinationView(),
    service.domain(),
    (projectId) => service.routingAvailability(projectId),
  );
  assert.deepEqual(
    routes.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /coordination/control/delivery/settle",
      "POST /coordination/control/delivery/refresh",
      "GET /coordination",
      "GET /coordination/task/:taskId",
      "GET /coordination/assignment/:assignmentId",
      "POST /coordination/control/message",
      "POST /coordination/control/question/answer",
      "POST /coordination/control/approval/decision",
      "POST /coordination/control/result/recipient",
    ],
  );
});

test("operator status follows a newer queued continuation over completed history", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-current-status-"),
  );
  const runtime = new OperatorRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const capacityTaskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Current-status lead",
    instructions: "Coordinate the task.",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Current-status project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Current assignment status",
    outcome: "Report the task outcome.",
    ready: false,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId: capacityTaskId,
    title: "Capacity-holding task",
    outcome: "Report the capacity task outcome.",
    ready: false,
  });
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });
  await service.provisionTask(taskId);
  await service.provisionTask(capacityTaskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() => runtime.turns === 1);
  command(service, {
    type: "task.configure",
    projectId,
    taskId: capacityTaskId,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() =>
    service
      .turnRequests()
      .some(
        (request) =>
          request.taskId === capacityTaskId && request.state === "queued",
      ),
  );

  const assignment = service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  await service.coordinationView().postOperatorMessage({
    taskId,
    key: randomUUID(),
    recipientAssignmentId: String(assignment.id),
    expectedAssignmentVersion: Number(assignment.version),
    message: "Continue with the latest operator direction.",
  });
  runtime.complete("operator-turn-1");
  await waitUntil(
    () =>
      service
        .turnRequests()
        .filter((request) => request.assignmentId === assignment.id).length ===
        2 &&
      service
        .turnRequests()
        .filter((request) => request.assignmentId === assignment.id)[1]
        ?.state === "queued" &&
      runtime.turns === 2,
  );

  const requests = service
    .turnRequests()
    .filter((request) => request.assignmentId === assignment.id);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.state, "completed");
  assert.equal(requests[1]?.state, "queued");
  const history = service.coordinationView().readTask(taskId).history;
  assert.ok(history.some((entry) => entry.state === "completed"));

  const runtimeTaskRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === "/runtime/task/:taskId",
  );
  assert.ok(runtimeTaskRoute);
  const runtimePage = await runtimeTaskRoute.handler({
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(runtimePage.kind, "html");
  const runtimeAssignmentRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path === "/runtime/assignment/:assignmentId",
  );
  assert.ok(runtimeAssignmentRoute);
  const runtimeAssignmentPage = await runtimeAssignmentRoute.handler({
    params: { assignmentId: String(assignment.id) },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(runtimeAssignmentPage.kind, "html");
  if (runtimeAssignmentPage.kind === "html")
    assert.match(
      runtimeAssignmentPage.body,
      /Execution status: Queued; waiting for capacity admission\./,
    );

  const coordinationTaskRoute = route(
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (projectId) => service.routingAvailability(projectId),
    ),
    "GET",
    "/coordination/task/:taskId",
  );
  const coordinationPage = await coordinationTaskRoute.handler({
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(coordinationPage.kind, "html");
  assert.deepEqual(
    {
      runtimeShowsCurrentQueue:
        runtimePage.kind === "html" &&
        /Current-status lead \(project lead\)<\/a>: Queued; waiting for capacity admission\./.test(
          runtimePage.body,
        ),
      coordinationShowsCurrentQueue:
        coordinationPage.kind === "html" &&
        /execution: Queued; waiting for capacity admission\./.test(
          coordinationPage.body,
        ),
    },
    {
      runtimeShowsCurrentQueue: true,
      coordinationShowsCurrentQueue: true,
    },
  );
  if (coordinationPage.kind === "html")
    assert.ok(
      coordinationPage.body.includes(
        `<a href="/runtime/task/${taskId}">Task-scoped runtime controls and recovery</a>`,
      ),
    );
});

test("operator pages retain an active worker turn after applying next-turn revisions", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-active-old-version-"),
  );
  const runtime = new OperatorRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
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
  const assignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Active-turn lead",
    instructions: "Coordinate the task.",
    capabilities: "coordinate",
  });
  command(service, {
    type: "profile.create",
    profileId: workerProfileId,
    name: "Active-turn worker",
    instructions: "Review the initial task context.",
    capabilities: "review",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Active-turn project",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
    instructions: "Initial project instructions.",
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "Routing is not enabled.",
    candidateProfileIds: [workerProfileId],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Active worker version probe",
    outcome: "Keep the current turn active during the revision update.",
    ready: false,
  });
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId: workerProfileId,
    brief: "Work against the current task context.",
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

  const assignment = service.domain().assignment(assignmentId);
  assert.equal(assignment.state, "running");
  const activeRequest = service
    .turnRequests()
    .find(
      (request) =>
        request.assignmentId === assignmentId && request.state === "active",
    );
  assert.ok(activeRequest);
  assert.equal(activeRequest.assignmentVersion, 1);
  const activeIntent = service
    .list()
    .find((intent) => intent.workId === activeRequest.workId);
  assert.equal(activeIntent?.state, "running");

  command(service, {
    type: "profile.configure",
    profileId: workerProfileId,
    expectedVersion: 1,
    instructions: "Updated worker instructions for the next turn.",
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    instructions: "Updated project instructions for the next turn.",
  });
  command(service, {
    type: "assignment.apply",
    projectId,
    assignmentId,
    expectedVersion: 1,
  });
  const updatedAssignment = service.domain().assignment(assignmentId);
  assert.equal(Number(updatedAssignment.version), 2);
  assert.equal(Number(updatedAssignment.profileRevision), 2);
  assert.equal(
    Number(updatedAssignment.instructionsRevision),
    Number(service.domain().project(projectId).instructionsRevision),
  );
  assert.equal(
    service
      .turnRequests()
      .find((request) => request.workId === activeRequest.workId)
      ?.assignmentVersion,
    1,
  );
  assert.equal(
    service
      .turnRequests()
      .find((request) => request.workId === activeRequest.workId)?.state,
    "active",
  );
  assert.equal(
    service.list().find((intent) => intent.workId === activeRequest.workId)
      ?.state,
    "running",
  );

  const runtimeRoutes = runtimeOperatorRoutes(service);
  const runtimeTaskPage = await route(
    runtimeRoutes,
    "GET",
    "/runtime/task/:taskId",
  ).handler({ params: { taskId }, fields: {}, csrfToken: "test-token" });
  const runtimeAssignmentPage = await route(
    runtimeRoutes,
    "GET",
    "/runtime/assignment/:assignmentId",
  ).handler({
    params: { assignmentId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(runtimeTaskPage.kind, "html");
  assert.equal(runtimeAssignmentPage.kind, "html");
  if (runtimeTaskPage.kind === "html") {
    assert.match(runtimeTaskPage.body, /Execution status: Running\./);
    assert.match(runtimeTaskPage.body, /Active-turn worker<\/a>: Running\./);
  }
  if (runtimeAssignmentPage.kind === "html") {
    assert.match(runtimeAssignmentPage.body, /Execution status: Running\./);
    assert.ok(
      runtimeAssignmentPage.body.includes(
        `Captured instruction revision ${updatedAssignment.instructionsRevision}; profile revision ${updatedAssignment.profileRevision}.`,
      ),
    );
  }

  const coordinationRoutes = coordinationOperatorRoutes(
    service.coordinationView(),
    service.domain(),
    (id) => service.routingAvailability(id),
  );
  const coordinationTaskPage = await route(
    coordinationRoutes,
    "GET",
    "/coordination/task/:taskId",
  ).handler({ params: { taskId }, fields: {}, csrfToken: "test-token" });
  const coordinationAssignmentPage = await route(
    coordinationRoutes,
    "GET",
    "/coordination/assignment/:assignmentId",
  ).handler({
    params: { assignmentId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(coordinationTaskPage.kind, "html");
  assert.equal(coordinationAssignmentPage.kind, "html");
  if (coordinationTaskPage.kind === "html")
    assert.match(
      coordinationTaskPage.body,
      /Active-turn worker<\/a> — selected assignment state running; execution: Running\./,
    );
  if (coordinationAssignmentPage.kind === "html") {
    assert.match(
      coordinationAssignmentPage.body,
      /Assignment state: running; execution: Running\./,
    );
    assert.match(
      coordinationAssignmentPage.body,
      /Assignment revision 1; conversation revision [0-9]+; runtime intent running\./,
    );
  }

  runtime.complete("operator-turn-1");
  await waitUntil(
    () =>
      service
        .turnRequests()
        .find((request) => request.workId === activeRequest.workId)?.state ===
      "completed",
  );
  const completedRuntimeTaskPage = await route(
    runtimeOperatorRoutes(service),
    "GET",
    "/runtime/task/:taskId",
  ).handler({ params: { taskId }, fields: {}, csrfToken: "test-token" });
  const completedCoordinationTaskPage = await route(
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (id) => service.routingAvailability(id),
    ),
    "GET",
    "/coordination/task/:taskId",
  ).handler({ params: { taskId }, fields: {}, csrfToken: "test-token" });
  assert.equal(completedRuntimeTaskPage.kind, "html");
  assert.equal(completedCoordinationTaskPage.kind, "html");
  if (completedRuntimeTaskPage.kind === "html")
    assert.doesNotMatch(
      completedRuntimeTaskPage.body,
      /Execution status: Running\./,
    );
  if (completedCoordinationTaskPage.kind === "html")
    assert.doesNotMatch(
      completedCoordinationTaskPage.body,
      /execution: Running\./,
    );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("coordination adapter fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class OperatorRuntime implements Runtime {
  starts = 0;
  turns = 0;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("completed");
  }

  async startThread(
    _workspace: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {
    return `operator-thread-${++this.starts}`;
  }

  async resumeThread(
    _threadId: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {}

  async startTurn(_threadId: string, _workspace: string, _prompt: string) {
    const turnId = `operator-turn-${++this.turns}`;
    this.outcomes.set(turnId, deferred());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  callTool(call: RuntimeToolCall) {
    assert.ok(this.toolCall, "service registered the runtime tool listener");
    return this.toolCall(call);
  }

  complete(turnId: string) {
    this.outcomes.get(turnId)?.resolve("completed");
  }
}

function command(service: StandaloneService, body: object): unknown {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...body,
  } as never);
}

function route(
  routes: ReturnType<typeof coordinationOperatorRoutes>,
  method: "GET" | "POST",
  path: string,
) {
  const result = routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  assert.ok(result, `${method} ${path} route exists`);
  return result;
}

test("routing availability distinguishes credentials, clients, and project scope", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-routing-availability-"),
  );
  const missingService = new StandaloneService(
    join(directory, "missing"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  let injectedRequests = 0;
  const injectedClient: RoutingChoiceClient = {
    async choose() {
      injectedRequests += 1;
      throw new Error("availability inspection must not call the provider");
    },
  };
  const injectedService = new StandaloneService(
    join(directory, "injected"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: injectedClient },
  );
  t.after(async () => {
    await missingService.stop();
    await injectedService.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await missingService.start();
  await injectedService.start();

  const leadProfileId = randomUUID();
  const candidateProfileId = randomUUID();
  const enabledProjectId = randomUUID();
  const unrelatedProjectId = randomUUID();
  const injectedProjectId = randomUUID();
  const unreferencedProjectId = randomUUID();
  const noCandidateProjectId = randomUUID();
  const revokedCandidateProfileId = randomUUID();
  command(missingService, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Availability lead",
    instructions: "Coordinate the project.",
    capabilities: "coordinate",
  });
  command(missingService, {
    type: "profile.create",
    profileId: candidateProfileId,
    name: "Available candidate",
    instructions: "Review the supplied task.",
    capabilities: "review; TypeScript",
  });
  command(injectedService, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Availability lead",
    instructions: "Coordinate the project.",
    capabilities: "coordinate",
  });
  command(injectedService, {
    type: "profile.create",
    profileId: candidateProfileId,
    name: "Available candidate",
    instructions: "Review the supplied task.",
    capabilities: "review; TypeScript",
  });
  command(injectedService, {
    type: "profile.create",
    profileId: revokedCandidateProfileId,
    name: "Revoked candidate",
    instructions: "No longer available for routing.",
    capabilities: "historical review",
  });
  for (const [service, projectId, name] of [
    [missingService, enabledProjectId, "Credential-missing project"],
    [missingService, unrelatedProjectId, "Unrelated project"],
    [injectedService, injectedProjectId, "Injected-client project"],
    [injectedService, unreferencedProjectId, "Unreferenced project"],
  ] as const) {
    command(service, {
      type: "project.create",
      projectId,
      name,
      leadProfileId,
    });
  }
  const missingEnvironmentName = `ENSEMBLE_TEST_ROUTING_${randomUUID()
    .replaceAll("-", "")
    .toUpperCase()}`;
  assert.equal(process.env[missingEnvironmentName], undefined);
  command(missingService, {
    type: "routing.configure",
    projectId: enabledProjectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "Prefer the configured candidate capabilities.",
    credentialRef: `env:${missingEnvironmentName}`,
    candidateProfileIds: [candidateProfileId],
  });
  command(injectedService, {
    type: "routing.configure",
    projectId: injectedProjectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "Use the injected client with a configured reference.",
    credentialRef: "env:ENSEMBLE_TEST_INJECTED_ROUTING",
    candidateProfileIds: [candidateProfileId],
  });
  command(injectedService, {
    type: "routing.configure",
    projectId: unreferencedProjectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "A client alone is insufficient without a stored reference.",
    credentialRef: null,
    candidateProfileIds: [candidateProfileId],
  });
  command(injectedService, {
    type: "project.create",
    projectId: noCandidateProjectId,
    name: "No-candidate project",
    leadProfileId,
  });
  command(injectedService, {
    type: "routing.configure",
    projectId: noCandidateProjectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "No eligible profiles are configured.",
    credentialRef: "env:ENSEMBLE_TEST_NO_CANDIDATE_ROUTING",
    candidateProfileIds: [revokedCandidateProfileId],
  });
  command(injectedService, {
    type: "profile.configure",
    profileId: revokedCandidateProfileId,
    expectedVersion: 1,
    revoked: true,
  });

  const missing = missingService.routingAvailability(enabledProjectId);
  assert.deepEqual(missing, {
    enabled: true,
    credentialReferenceConfigured: true,
    routingClientAvailable: false,
    eligibleCandidateCount: 1,
    available: false,
    reason: "missing-client-credentials",
  });
  assert.doesNotMatch(JSON.stringify(missing), /ENSEMBLE_TEST_ROUTING/);
  assert.deepEqual(missingService.routingAvailability(unrelatedProjectId), {
    enabled: false,
    credentialReferenceConfigured: false,
    routingClientAvailable: false,
    eligibleCandidateCount: 0,
    available: false,
    reason: "disabled",
  });
  assert.deepEqual(injectedService.routingAvailability(injectedProjectId), {
    enabled: true,
    credentialReferenceConfigured: true,
    routingClientAvailable: true,
    eligibleCandidateCount: 1,
    available: true,
    reason: null,
  });
  assert.deepEqual(injectedService.routingAvailability(unreferencedProjectId), {
    enabled: true,
    credentialReferenceConfigured: false,
    routingClientAvailable: true,
    eligibleCandidateCount: 1,
    available: false,
    reason: "missing-client-credentials",
  });
  assert.deepEqual(injectedService.routingAvailability(noCandidateProjectId), {
    enabled: true,
    credentialReferenceConfigured: true,
    routingClientAvailable: true,
    eligibleCandidateCount: 0,
    available: false,
    reason: "no-eligible-candidates",
  });
  assert.equal(injectedRequests, 0);
});

test("coordination histories and keyed controls stay scoped and durable", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-coordination-flow-"),
  );
  const filename = join(directory, "data");
  const runtime = new OperatorRuntime();
  let service = new StandaloneService(filename, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
  });
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const revokedProfileId = randomUUID();
  const otherWorkerProfileId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const otherTaskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Task-scoped lead",
    instructions: "PRIVATE_RUNTIME_PROMPT_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "profile.create",
    profileId: workerProfileId,
    name: "Worker",
    instructions: "review",
    capabilities: "review; TypeScript implementation",
  });
  command(service, {
    type: "profile.create",
    profileId: revokedProfileId,
    name: "Revoked candidate",
    instructions: "This profile has been revoked.",
    capabilities: "historical review",
  });
  command(service, {
    type: "profile.create",
    profileId: otherWorkerProfileId,
    name: "Other project candidate",
    instructions: "Keep this profile scoped to another project.",
    capabilities: "other-project-only",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Coordination project",
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
    enabled: true,
    guidance:
      "PROJECT_ROUTING_GUIDANCE_SENTINEL: prefer implementation skills.",
    credentialRef: "env:PRIVATE_ROUTING_CREDENTIAL_SENTINEL",
    candidateProfileIds: [workerProfileId, revokedProfileId],
  });
  command(service, {
    type: "profile.configure",
    profileId: revokedProfileId,
    expectedVersion: 1,
    revoked: true,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Scoped coordination task",
    outcome: "PRIVATE_TASK_OUTCOME_SENTINEL",
    ready: false,
  });
  command(service, {
    type: "project.create",
    projectId: otherProjectId,
    name: "Unrelated project",
    leadProfileId,
  });
  command(service, {
    type: "task.create",
    projectId: otherProjectId,
    taskId: otherTaskId,
    title: "OTHER_TASK_TITLE_SENTINEL",
    outcome: "OTHER_TASK_OUTCOME_SENTINEL",
    ready: false,
  });
  command(service, {
    type: "routing.configure",
    projectId: otherProjectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "OTHER_PROJECT_ROUTING_GUIDANCE_SENTINEL",
    credentialRef: null,
    candidateProfileIds: [workerProfileId, otherWorkerProfileId],
  });
  const messageAssignmentId = randomUUID();
  command(service, {
    type: "assignment.create",
    projectId: otherProjectId,
    taskId: otherTaskId,
    assignmentId: messageAssignmentId,
    profileId: workerProfileId,
    brief: "A separate, paused assignment.",
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
  await waitUntil(() => runtime.turns > 0);
  const leadAssignment = service
    .domain()
    .assignments(taskId)
    .find((assignment) => assignment.profileId === leadProfileId);
  assert.ok(leadAssignment);
  const leadRequest = service
    .turnRequests()
    .find((request) => request.assignmentId === leadAssignment.id);
  assert.ok(leadRequest);
  const leadIntent = service
    .list()
    .find((intent) => intent.workId === leadRequest.workId);
  assert.ok(leadIntent?.threadId && leadIntent.turnId);

  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId: workerProfileId,
    brief: "PRIVATE_ASSIGNMENT_BRIEF_SENTINEL",
    resultDestination: "requester:foreign",
    requesterAssignmentId: null,
  });
  const workerAssignment = service
    .domain()
    .assignments(taskId)
    .find((assignment) => assignment.profileId === workerProfileId);
  assert.ok(workerAssignment);

  await runtime.callTool({
    threadId: leadIntent.threadId,
    turnId: leadIntent.turnId,
    callId: "operator-question",
    tool: "ensemble_ask_question",
    arguments: { question: "Which supported format should I use?" },
  });
  await runtime.callTool({
    threadId: leadIntent.threadId,
    turnId: leadIntent.turnId,
    callId: "operator-approval",
    tool: "ensemble_request_approval",
    arguments: {
      action: "publish",
      target: "artifact-4",
      material: { version: "next", marker: "APPROVAL_MATERIAL_SENTINEL" },
    },
  });
  const view = service.coordinationView();
  const taskView = view.readTask(taskId);
  const question = taskView.questions[0];
  const approval = taskView.approvals[0];
  assert.ok(question && approval);
  const workerRequest = service
    .turnRequests()
    .find((request) => request.assignmentId === workerAssignment.id);
  assert.ok(workerRequest);
  assert.equal(workerRequest.state, "queued");
  // Exercise the persisted unresolved-recipient edge using the real SQLite fixture.
  // The public domain command path normally captures the configured task lead.
  const database = (
    service as unknown as {
      db: {
        prepare(sql: string): {
          run(assignmentId: string): { changes: number };
        };
      };
    }
  ).db;
  assert.equal(
    database
      .prepare(
        "UPDATE domain_assignments SET resultRecipientAssignmentId = NULL, resultRecipientDisposition = 'unresolved' WHERE id = ?",
      )
      .run(String(workerAssignment.id)).changes,
    1,
  );

  const messageKey = randomUUID();
  const answerKey = randomUUID();
  const approvalKey = randomUUID();
  const messageContext = {
    params: {},
    fields: {
      key: messageKey,
      taskId: otherTaskId,
      recipientAssignmentId: messageAssignmentId,
      expectedAssignmentVersion: "1",
      message: "Please preserve the current interface.",
    },
    csrfToken: "test-token",
  };
  const answerContext = {
    params: {},
    fields: {
      key: answerKey,
      taskId,
      interactionId: question.interactionId,
      expectedRevision: String(question.revision),
      answer: "Use format B.",
    },
    csrfToken: "test-token",
  };
  const approvalContext = {
    params: {},
    fields: {
      key: approvalKey,
      taskId,
      interactionId: approval.interactionId,
      expectedRevision: String(approval.revision),
      decision: "denied",
      action: approval.action ?? "",
      ...(approval.target === null ? {} : { target: approval.target }),
      materialJson: approval.materialJson ?? "",
    },
    csrfToken: "test-token",
  };
  let routes = coordinationOperatorRoutes(
    service.coordinationView(),
    service.domain(),
    (projectId) => service.routingAvailability(projectId),
  );
  const getTask = route(routes, "GET", "/coordination/task/:taskId");
  const page = await getTask.handler({
    params: { taskId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(page.kind, "html");
  if (page.kind === "html") {
    assert.match(page.body, /Task-scoped lead/);
    assert.match(page.body, /task-scoped lead history/);
    assert.match(page.body, /Routing selection is not execution admission/);
    assert.match(page.body, /Credential reference: configured/);
    assert.match(page.body, /Routing client: unavailable/);
    assert.match(
      page.body,
      /Effective routing availability: unavailable \(missing client credentials\)/,
    );
    assert.match(
      page.body,
      /Project routing guidance: PROJECT_ROUTING_GUIDANCE_SENTINEL: prefer implementation skills\./,
    );
    assert.match(
      page.body,
      /Worker — capabilities: review; TypeScript implementation; eligible routing candidate/,
    );
    assert.match(
      page.body,
      /Revoked candidate — capabilities: historical review; unavailable: profile revoked/,
    );
    assert.match(page.body, /APPROVAL_MATERIAL_SENTINEL/);
    assert.doesNotMatch(
      page.body,
      /PRIVATE_(?:RUNTIME_PROMPT|TASK_OUTCOME|ASSIGNMENT_BRIEF|ROUTING_CREDENTIAL)_SENTINEL|OTHER_TASK_(?:TITLE|OUTCOME)_SENTINEL|OTHER_PROJECT_ROUTING_GUIDANCE_SENTINEL|Other project candidate/,
    );
  }
  const assignmentPage = await route(
    routes,
    "GET",
    "/coordination/assignment/:assignmentId",
  ).handler({
    params: { assignmentId: String(workerAssignment.id) },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(assignmentPage.kind, "html");
  if (assignmentPage.kind === "html") {
    assert.match(assignmentPage.body, /Scoped coordination task/);
    assert.match(assignmentPage.body, /Queued|Running/);
    assert.doesNotMatch(
      assignmentPage.body,
      /PRIVATE_ASSIGNMENT_BRIEF_SENTINEL/,
    );
  }

  const messageRoute = route(routes, "POST", "/coordination/control/message");
  const answerRoute = route(
    routes,
    "POST",
    "/coordination/control/question/answer",
  );
  const approvalRoute = route(
    routes,
    "POST",
    "/coordination/control/approval/decision",
  );
  assert.deepEqual(await messageRoute.handler(messageContext), {
    kind: "redirect",
    location: `/coordination/task/${otherTaskId}`,
  });
  assert.deepEqual(await messageRoute.handler(messageContext), {
    kind: "redirect",
    location: `/coordination/task/${otherTaskId}`,
  });
  // Record while the requester remains current. Later completed-assignment
  // acknowledgements below are historical same-key replay, never fresh input.
  assert.deepEqual(await answerRoute.handler(answerContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  assert.deepEqual(await approvalRoute.handler(approvalContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  runtime.complete(leadIntent.turnId);
  await waitUntil(() =>
    service
      .list()
      .some(
        (intent) =>
          intent.workId === workerRequest.workId && intent.state === "running",
      ),
  );
  const workerIntent = service
    .list()
    .find((intent) => intent.workId === workerRequest.workId);
  assert.ok(workerIntent?.threadId && workerIntent.turnId);

  const report = await runtime.callTool({
    threadId: workerIntent.threadId,
    turnId: workerIntent.turnId,
    callId: "operator-result",
    tool: "ensemble_report_result",
    arguments: { summary: "Reviewed parser output." },
  });
  assert.equal(report.success, true, report.text);
  runtime.complete(workerIntent.turnId);
  await waitUntil(
    () =>
      service.coordinationView().readTask(taskId).unresolvedResults.length ===
      1,
  );
  await waitUntil(() =>
    service
      .list()
      .some(
        (intent) =>
          service
            .turnRequests()
            .some(
              (request) =>
                request.assignmentId === leadAssignment.id &&
                request.workId === intent.workId,
            ) &&
          intent.workId !== leadIntent.workId &&
          intent.state === "running",
      ),
  );
  const leadContinuation = service
    .list()
    .find(
      (intent) =>
        service
          .turnRequests()
          .some(
            (request) =>
              request.assignmentId === leadAssignment.id &&
              request.workId === intent.workId,
          ) &&
        intent.workId !== leadIntent.workId &&
        intent.state === "running",
    );
  assert.ok(leadContinuation?.threadId && leadContinuation.turnId);
  const leadReport = await runtime.callTool({
    threadId: leadContinuation.threadId,
    turnId: leadContinuation.turnId,
    callId: "operator-lead-result",
    tool: "ensemble_report_result",
    arguments: { summary: "Lead reviewed the task scope." },
  });
  assert.equal(leadReport.success, true, leadReport.text);
  runtime.complete(leadContinuation.turnId);
  await assert.rejects(
    async () =>
      answerRoute.handler({
        ...answerContext,
        fields: { ...answerContext.fields, key: randomUUID() },
      }),
    /stale, cancelled or ambiguous|not open/,
  );
  assert.deepEqual(await answerRoute.handler(answerContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  assert.deepEqual(await answerRoute.handler(answerContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  assert.deepEqual(await approvalRoute.handler(approvalContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  assert.deepEqual(await approvalRoute.handler(approvalContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });
  const unresolved = service.coordinationView().readTask(taskId)
    .unresolvedResults[0];
  assert.ok(unresolved);
  const recipientKey = randomUUID();
  const recipientContext = {
    params: {},
    fields: {
      key: recipientKey,
      taskId,
      resultId: unresolved.resultId,
      expectedRevision: String(unresolved.revision),
      recipientAssignmentId: String(leadAssignment.id),
    },
    csrfToken: "test-token",
  };
  const recipientRoute = route(
    routes,
    "POST",
    "/coordination/control/result/recipient",
  );
  assert.deepEqual(await recipientRoute.handler(recipientContext), {
    kind: "redirect",
    location: `/coordination/task/${taskId}`,
  });

  await service.stop();
  service = new StandaloneService(filename, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
  });
  await service.start();
  routes = coordinationOperatorRoutes(
    service.coordinationView(),
    service.domain(),
    (projectId) => service.routingAvailability(projectId),
  );
  assert.deepEqual(
    await route(routes, "POST", "/coordination/control/message").handler(
      messageContext,
    ),
    { kind: "redirect", location: `/coordination/task/${otherTaskId}` },
  );
  assert.deepEqual(
    await route(
      routes,
      "POST",
      "/coordination/control/question/answer",
    ).handler(answerContext),
    { kind: "redirect", location: `/coordination/task/${taskId}` },
  );
  assert.deepEqual(
    await route(
      routes,
      "POST",
      "/coordination/control/approval/decision",
    ).handler(approvalContext),
    { kind: "redirect", location: `/coordination/task/${taskId}` },
  );
  assert.deepEqual(
    await route(
      routes,
      "POST",
      "/coordination/control/result/recipient",
    ).handler(recipientContext),
    { kind: "redirect", location: `/coordination/task/${taskId}` },
  );
  const finalView = service.coordinationView().readTask(taskId);
  assert.equal(
    finalView.messages.filter((item) => item.eventType === "operator-message")
      .length,
    0,
  );
  assert.equal(
    finalView.messages.filter((item) => item.eventType === "question-answer")
      .length,
    1,
  );
  assert.equal(
    finalView.messages.filter((item) => item.eventType === "approval-decision")
      .length,
    1,
  );
  assert.equal(
    finalView.messages.filter((item) => item.eventType === "assignment-result")
      .length,
    2,
  );
  assert.equal(finalView.questions[0]?.status, "answered");
  assert.equal(finalView.approvals[0]?.status, "denied");
  assert.equal(finalView.unresolvedResults.length, 0);
  assert.equal(finalView.results.length, 2);
  assert.ok(
    finalView.results.every(
      (result) => result.recipientAssignmentId === String(leadAssignment.id),
    ),
  );
  const otherPage = await route(
    routes,
    "GET",
    "/coordination/task/:taskId",
  ).handler({
    params: { taskId: otherTaskId },
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(otherPage.kind, "html");
  if (otherPage.kind === "html") {
    assert.doesNotMatch(otherPage.body, new RegExp(taskId));
    assert.doesNotMatch(
      otherPage.body,
      /APPROVAL_MATERIAL_SENTINEL|Scoped coordination task/,
    );
    assert.match(otherPage.body, /Please preserve the current interface\./);
  }
  assert.equal(
    service
      .coordinationView()
      .readTask(otherTaskId)
      .messages.filter((item) => item.eventType === "operator-message").length,
    1,
  );
});
