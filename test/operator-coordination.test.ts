import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
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
  );
  assert.deepEqual(
    routes.map(({ method, path }) => `${method} ${path}`),
    [
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
    capabilities: "review",
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
    enabled: false,
    guidance: "Select only approved candidate profiles.",
    credentialRef: "env:PRIVATE_ROUTING_CREDENTIAL_SENTINEL",
    candidateProfileIds: [workerProfileId],
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
    guidance: "No external routing is enabled.",
    credentialRef: null,
    candidateProfileIds: [workerProfileId],
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
    assert.match(page.body, /credential is configured/);
    assert.match(page.body, /APPROVAL_MATERIAL_SENTINEL/);
    assert.doesNotMatch(
      page.body,
      /PRIVATE_(?:RUNTIME_PROMPT|TASK_OUTCOME|ASSIGNMENT_BRIEF|ROUTING_CREDENTIAL)_SENTINEL|OTHER_TASK_(?:TITLE|OUTCOME)_SENTINEL/,
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
  const leadReport = await runtime.callTool({
    threadId: leadIntent.threadId,
    turnId: leadIntent.turnId,
    callId: "operator-lead-result",
    tool: "ensemble_report_result",
    arguments: { summary: "Lead reviewed the task scope." },
  });
  assert.equal(leadReport.success, true, leadReport.text);
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
