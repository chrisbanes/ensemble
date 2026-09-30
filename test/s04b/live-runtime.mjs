import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRuntime,
  StandaloneService,
} from "../../dist/src/standalone/index.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";

if (!process.argv.slice(2).includes("--live")) {
  process.stderr.write(
    "Refusing live Codex execution without the explicit --live flag.\n",
  );
  process.exit(2);
}

const evidence = {
  source: {},
  runtime: {},
  task: {},
  callbacks: [],
  scheduler: [],
  results: [],
  events: [],
  cleanup: {
    fixtureCreated: false,
    fixtureRemoved: false,
    appServerProcessesVerifiedExited: [],
    scope: "temporary Ensemble data and its managed task workspace only",
  },
  limitations: {
    typeSafe: "disabled; routing is disabled and routingClient is null",
    providerThreads:
      "The harness does not request provider-thread deletion; Codex records may remain.",
    sharedCodexConfiguration: "not read or changed by this harness",
  },
  failure: null,
};

let stage = "source-identity";
let service;
let runtime;
let root;
let projectId;
let taskId;
let firstResultPauseApplied = false;

function progress(name) {
  stage = name;
  process.stderr.write(`[s04b-live] ${name}\n`);
}

function failureKind(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return "timeout";
  if (/login|auth|account/i.test(message))
    return "authentication-or-account-check";
  if (/interrupt|cancel/i.test(message)) return "cancellation-request";
  if (/approval|policy|sandbox/i.test(message)) return "execution-policy";
  if (/completion|assignments-not-complete|completed-assignment/i.test(message))
    return "completion-contract";
  return "runtime-or-service-error";
}

function command(body) {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...body,
  });
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${description} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processEvidence(identity) {
  return identity
    ? {
        processId: identity.processId,
        processStartedAt: identity.processStartedAt,
      }
    : null;
}

async function verifyExited(identity) {
  if (!identity)
    return { kind: "unproved", reason: "missing process identity" };
  const verifier = new MacProcessTerminationVerifier();
  const deadline = Date.now() + 7000;
  let latest;
  do {
    latest = await verifier.verify(identity);
    if (latest.kind === "verified") return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return latest;
}

let activeService;
class ObservedCodexRuntime extends CodexRuntime {
  callbacks = [];
  resumptions = [];
  startedThreads = [];
  afterCallback;

  onToolCall(listener) {
    super.onToolCall(async (call) => {
      const intent = activeService
        ?.list()
        .find(
          (item) =>
            item.threadId === call.threadId && item.turnId === call.turnId,
        );
      const request = intent
        ? activeService
            .turnRequests()
            .find((item) => item.workId === intent.workId)
        : undefined;
      const observation = {
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId,
        tool: call.tool,
        profileId:
          call.tool === "ensemble_delegate" &&
          typeof call.arguments.profileId === "string"
            ? call.arguments.profileId
            : null,
        workId: intent?.workId ?? null,
        assignmentId: request?.assignmentId ?? null,
        success: null,
      };
      this.callbacks.push(observation);
      evidence.callbacks.push(observation);
      const result = await listener(call);
      observation.success = result.success;
      await this.afterCallback?.(call, observation);
      return result;
    });
  }

  async startThread(workspace, tools) {
    const threadId = await super.startThread(workspace, tools);
    this.startedThreads.push({
      threadId,
      tools: tools?.map((tool) => tool.name) ?? [],
    });
    return threadId;
  }

  async resumeThread(threadId, tools) {
    await super.resumeThread(threadId, tools);
    this.resumptions.push({
      threadId,
      tools: tools?.map((tool) => tool.name) ?? [],
    });
  }
}

async function waitForTool(runtimeInstance, tool, offset = 0) {
  await waitUntil(
    () =>
      runtimeInstance.callbacks
        .slice(offset)
        .some((item) => item.tool === tool),
    240_000,
    `registered callback ${tool}`,
  );
  const call = runtimeInstance.callbacks
    .slice(offset)
    .find((item) => item.tool === tool);
  assert.ok(call, `expected callback ${tool}`);
  assert.equal(call.success, true, `${tool} callback was rejected`);
  return call;
}

async function waitForWorkState(workId, state, description) {
  await waitUntil(
    () =>
      service
        .list()
        .some((item) => item.workId === workId && item.state === state),
    240_000,
    description,
  );
}

function recordScheduler(label) {
  evidence.scheduler.push({
    label,
    requests: service.turnRequests().map((request) => ({
      workId: request.workId,
      assignmentId: request.assignmentId,
      state: request.state,
    })),
    work: service.list().map((item) => ({
      workId: item.workId,
      state: item.state,
      threadId: item.threadId,
      turnId: item.turnId,
    })),
  });
}

async function setup() {
  progress("profile-project-task-setup");
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  projectId = randomUUID();
  taskId = randomUUID();
  command({
    type: "profile.create",
    profileId: leadProfileId,
    name: "S04b live lead",
    instructions: "Use only the task-scoped Ensemble coordination tools.",
    capabilities: "task coordination",
  });
  command({
    type: "profile.create",
    profileId: workerProfileId,
    name: "S04b live worker",
    instructions:
      "Use only Ensemble coordination tools to report assigned work.",
    capabilities: "verification",
  });
  command({
    type: "project.create",
    projectId,
    name: "Disposable S04b live verification",
    leadProfileId,
  });
  command({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfileId],
  });
  command({
    type: "task.create",
    projectId,
    taskId,
    title: "S04b coordination runtime verification",
    outcome: [
      "This is a disposable coordination integration probe. Use only the registered Ensemble tools. Do not use shell, filesystem, browser, network, or any other tools.",
      `Lead profile ID: ${leadProfileId}. Worker profile ID: ${workerProfileId}.`,
      "As lead, call ensemble_delegate exactly once with profileId set to the exact Worker profile ID literal above, not the Lead ID. Give the worker a brief requiring summary S04B_RESULT_V1 through ensemble_report_result.",
      "When the first result is delivered, request one follow-up for that exact result ID. The follow-up instructions must ask the worker to report summary S04B_RESULT_V2 through ensemble_report_result.",
      "When the revised result is delivered, request task completion with exactly the current result ID in reviewedResultIds.",
      "The service is configured for capacity one. Do not claim completion without using the completion tool.",
    ].join("\n"),
    ready: false,
  });
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });
  progress("task-workspace-provisioning");
  await service.provisionTask(taskId);
  progress("task-admission");
  command({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { leadProfileId, workerProfileId };
}

async function run() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const npmUserAgent = process.env.npm_config_user_agent ?? "";
  const npmVersion = /(?:^|\s)npm\/([^\s]+)/.exec(npmUserAgent)?.[1] ?? null;
  evidence.source = {
    baseRevision: revision,
    node: process.version,
    npm: npmVersion,
    codex: execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
  };

  progress("fixture-setup");
  root = mkdtempSync(join(tmpdir(), "ensemble-s04b-live-"));
  evidence.cleanup.fixtureCreated = true;
  const dataDir = join(root, "data");
  runtime = new ObservedCodexRuntime();
  service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
  });
  activeService = service;

  progress("authenticated-runtime-start");
  await service.start();
  const firstProcess = await runtime.processIdentity();
  assert.ok(firstProcess, "expected macOS App Server process identity");
  evidence.runtime.firstProcess = processEvidence(firstProcess);
  const { leadProfileId, workerProfileId } = await setup();
  progress("initial-lead-admission");
  await waitUntil(
    () =>
      service
        .turnRequests()
        .some(
          (request) => request.assignmentId && request.kind === "assignment",
        ),
    30_000,
    "initial lead turn request",
  );
  const initialLeadRequest = service
    .turnRequests()
    .find((request) => request.assignmentId && request.kind === "assignment");
  assert.ok(initialLeadRequest);
  progress("initial-lead-execution-admission");
  await waitUntil(
    () =>
      service
        .list()
        .some(
          (item) =>
            item.workId === initialLeadRequest.workId &&
            item.state === "running" &&
            item.threadId !== null &&
            item.turnId !== null,
        ),
    30_000,
    "initial lead execution admission",
  );
  const leadAssignmentId = initialLeadRequest.assignmentId;
  assert.equal(
    service.domain().assignment(leadAssignmentId).profileId,
    leadProfileId,
  );
  const leadTurn = service
    .list()
    .find(
      (item) =>
        item.workId === initialLeadRequest.workId && item.state === "running",
    );
  assert.ok(leadTurn?.threadId && leadTurn.turnId);
  const initialLeadThreadId = leadTurn.threadId;
  const initialLeadTurnId = leadTurn.turnId;
  evidence.task = {
    taskId,
    projectId,
    leadAssignmentId,
    leadProfileId,
    workerProfileId,
  };
  evidence.runtime.startedThreads = runtime.startedThreads;
  recordScheduler("lead-started");

  progress("lead-delegation");
  const firstDelegate = await waitForTool(runtime, "ensemble_delegate");
  assert.equal(firstDelegate.threadId, initialLeadThreadId);
  assert.equal(firstDelegate.turnId, initialLeadTurnId);
  assert.equal(firstDelegate.assignmentId, leadAssignmentId);
  progress("verify-worker-assignment");
  const delegatedAssignments = service
    .domain()
    .assignments(taskId)
    .filter(
      (assignment) => assignment.requesterAssignmentId === leadAssignmentId,
    )
    .map((assignment) => ({
      assignmentId: String(assignment.id),
      profileId: String(assignment.profileId),
      state: String(assignment.state),
    }));
  evidence.task.delegatedAssignments = delegatedAssignments;
  const childAssignment = service
    .domain()
    .assignments(taskId)
    .find(
      (assignment) => assignment.requesterAssignmentId === leadAssignmentId,
    );
  assert.ok(
    childAssignment,
    "lead delegation must create the worker assignment",
  );
  assert.equal(childAssignment.profileId, workerProfileId);
  const childAssignmentId = String(childAssignment.id);
  evidence.task.workerAssignmentId = childAssignmentId;
  await waitForWorkState(
    initialLeadRequest.workId,
    "completed",
    "lead terminal",
  );
  const childWork = `assignment:${childAssignmentId}:initial`;
  await waitUntil(
    () =>
      service
        .list()
        .some((item) => item.workId === childWork && item.state === "running"),
    240_000,
    "worker admitted at capacity one",
  );
  const workerTurn = service.list().find((item) => item.workId === childWork);
  assert.ok(workerTurn?.threadId && workerTurn.turnId);
  assert.equal(service.domain().assignment(childAssignmentId).version, 1);
  evidence.runtime.startedThreads = runtime.startedThreads;
  recordScheduler("worker-initial-started");

  runtime.afterCallback = async (_call, observation) => {
    if (
      observation.tool !== "ensemble_report_result" ||
      observation.assignmentId !== childAssignmentId ||
      firstResultPauseApplied
    )
      return;
    const current = service.domain().project(projectId);
    command({
      type: "project.configure",
      projectId,
      expectedVersion: Number(current.version),
      paused: true,
    });
    firstResultPauseApplied = true;
    recordScheduler("paused-during-first-result-callback");
  };

  progress("initial-worker-result-held");
  const firstResultCall = await waitForTool(
    runtime,
    "ensemble_report_result",
    1,
  );
  assert.equal(firstResultCall.threadId, workerTurn.threadId);
  assert.equal(firstResultCall.turnId, workerTurn.turnId);
  assert.equal(firstResultPauseApplied, true);
  await waitForWorkState(
    childWork,
    "completed",
    "initial worker result terminal",
  );
  const firstView = service.coordinationView().readTask(taskId);
  const firstResult = firstView.results.find(
    (item) => item.assignmentId === childAssignmentId,
  );
  assert.ok(firstResult);
  evidence.results.push({
    resultId: firstResult.resultId,
    assignmentId: firstResult.assignmentId,
    workId: firstResult.workId,
    workRevision: firstResult.workRevision,
    destinationDisposition: firstResult.destinationDisposition,
  });
  const firstResultEvent = firstView.messages.find(
    (message) =>
      message.eventType === "assignment-result" &&
      message.resultId === firstResult.resultId,
  );
  assert.ok(firstResultEvent, "result must have one durable lead event");
  assert.notEqual(firstResultEvent.deliveryState, "delivered");
  evidence.events.push({
    eventId: firstResultEvent.eventId,
    eventType: firstResultEvent.eventType,
    recipientAssignmentId: firstResultEvent.recipientAssignmentId,
    deliveryState: firstResultEvent.deliveryState,
  });
  recordScheduler("first-result-retained-before-restart");

  progress("service-app-server-restart");
  await service.stop();
  const firstProcessExit = await verifyExited(firstProcess);
  assert.equal(firstProcessExit.kind, "verified");
  evidence.cleanup.appServerProcessesVerifiedExited.push(
    processEvidence(firstProcess),
  );
  runtime = new ObservedCodexRuntime();
  service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
  });
  activeService = service;
  await service.start();
  const resumedProcess = await runtime.processIdentity();
  assert.ok(resumedProcess, "expected restarted App Server process identity");
  evidence.runtime.resumedProcess = processEvidence(resumedProcess);
  const reopened = service.coordinationView().readTask(taskId);
  assert.equal(reopened.results.length, 1);
  assert.equal(reopened.results[0]?.resultId, firstResult.resultId);
  assert.equal(
    reopened.messages.find(
      (message) => message.resultId === firstResult.resultId,
    )?.deliveryState,
    firstResultEvent.deliveryState,
  );
  assert.equal(runtime.callbacks.length, 0);
  const paused = service.domain().project(projectId);
  command({
    type: "project.configure",
    projectId,
    expectedVersion: Number(paused.version),
    paused: false,
  });

  progress("resumed-lead-follow-up-callback");
  const resumedFollowUp = await waitForTool(
    runtime,
    "ensemble_request_follow_up",
  );
  assert.equal(resumedFollowUp.threadId, initialLeadThreadId);
  assert.notEqual(resumedFollowUp.turnId, initialLeadTurnId);
  assert.ok(resumedFollowUp.callId);
  assert.ok(
    runtime.resumptions.some(
      (item) =>
        item.threadId === initialLeadThreadId &&
        item.tools.includes("ensemble_request_follow_up"),
    ),
    "the restarted App Server must register dynamic tools on the resumed lead thread",
  );
  evidence.runtime.resumptions = runtime.resumptions;
  evidence.runtime.startedThreads = runtime.startedThreads;
  await waitForWorkState(
    resumedFollowUp.workId,
    "completed",
    "lead follow-up decision terminal",
  );
  recordScheduler("lead-follow-up-decision-completed");

  const followUpRequest = service
    .coordinationView()
    .readTask(taskId)
    .messages.find((message) => message.eventType === "assignment-follow-up");
  assert.ok(followUpRequest, "lead follow-up must create a worker inbox event");
  await waitUntil(
    () =>
      service
        .list()
        .some(
          (item) =>
            item.workId !== childWork &&
            item.state === "running" &&
            item.threadId === workerTurn.threadId,
        ),
    240_000,
    "worker follow-up revision admission",
  );
  const revisedWorkerTurn = service
    .list()
    .find(
      (item) =>
        item.threadId === workerTurn.threadId && item.state === "running",
    );
  assert.ok(
    revisedWorkerTurn?.turnId && revisedWorkerTurn.workId !== childWork,
  );
  assert.equal(service.domain().assignment(childAssignmentId).version, 2);

  progress("worker-revision-result");
  const revisedResultCall = await waitForTool(
    runtime,
    "ensemble_report_result",
    0,
  );
  assert.equal(revisedResultCall.threadId, workerTurn.threadId);
  assert.equal(revisedResultCall.turnId, revisedWorkerTurn.turnId);
  await waitForWorkState(
    revisedWorkerTurn.workId,
    "completed",
    "worker revision result terminal",
  );
  const revisedView = service.coordinationView().readTask(taskId);
  const resultVersions = revisedView.results
    .filter((item) => item.assignmentId === childAssignmentId)
    .sort((a, b) => a.workRevision - b.workRevision);
  assert.equal(resultVersions.length, 2);
  assert.ok(
    resultVersions.every((item, index) => item.workRevision === index + 1),
  );
  evidence.results = resultVersions.map((item) => ({
    resultId: item.resultId,
    assignmentId: item.assignmentId,
    workId: item.workId,
    workRevision: item.workRevision,
    destinationDisposition: item.destinationDisposition,
  }));
  evidence.events = revisedView.messages.map((message) => ({
    eventId: message.eventId,
    eventType: message.eventType,
    recipientAssignmentId: message.recipientAssignmentId,
    resultId: message.resultId ?? null,
    deliveryState: message.deliveryState,
  }));
  recordScheduler("worker-revision-result-completed");

  progress("resumed-lead-completion-callback");
  const completion = await waitForTool(runtime, "ensemble_request_completion");
  assert.equal(completion.threadId, initialLeadThreadId);
  assert.ok(completion.callId);
  assert.ok(
    runtime.resumptions.some((item) => item.threadId === initialLeadThreadId),
  );
  await waitUntil(
    () => service.domain().task(taskId).state === "done",
    60_000,
    "final task completion",
  );
  const finalView = service.coordinationView().readTask(taskId);
  assert.equal(finalView.task.state, "done");
  const finalLeadTurn = finalView.history.find(
    (item) =>
      item.threadId === initialLeadThreadId &&
      item.turnId === completion.turnId,
  );
  assert.ok(finalLeadTurn);
  assert.ok(
    finalView.completionRequests.some((item) => item.status === "finalized"),
  );
  assert.equal(
    new Set(runtime.callbacks.map((item) => item.callId)).size,
    runtime.callbacks.length,
    "tool callback IDs must be unique",
  );
  assert.equal(
    new Set(finalView.results.map((item) => item.resultId)).size,
    finalView.results.length,
    "result IDs must be unique",
  );
  assert.equal(
    new Set(finalView.messages.map((item) => item.eventId)).size,
    finalView.messages.length,
    "event IDs must be unique",
  );
  assert.equal(
    new Set(finalView.history.map((item) => item.turnId).filter(Boolean)).size,
    finalView.history.filter((item) => item.turnId).length,
    "turn IDs must be unique",
  );
  evidence.task.finalState = finalView.task.state;
  evidence.runtime.callbackCount = evidence.callbacks.length;
  evidence.runtime.callbacks = evidence.callbacks;
  evidence.runtime.resumptions = runtime.resumptions;
  evidence.runtime.startedThreads = runtime.startedThreads;
  recordScheduler("task-finalized");

  const routingAttempts = service.coordinationView().readTask(taskId)
    .routing.attempts;
  assert.equal(
    routingAttempts.length,
    0,
    "TypeSafe routing must remain disabled",
  );
  evidence.runtime.typeSafeCalls = 0;
}

try {
  await run();
} catch (error) {
  evidence.failure = { stage, kind: failureKind(error) };
  process.exitCode = 1;
} finally {
  const currentProcess = runtime?.processIdentity?.() ?? null;
  try {
    await service?.stop();
  } catch {
    evidence.failure ??= { stage: "service-shutdown", kind: "cleanup-error" };
    process.exitCode = 1;
  }
  if (currentProcess) {
    const exit = await verifyExited(currentProcess);
    if (exit.kind === "verified") {
      evidence.cleanup.appServerProcessesVerifiedExited.push(
        processEvidence(currentProcess),
      );
    } else {
      evidence.cleanup.appServerProcessesVerifiedExited.push({
        ...processEvidence(currentProcess),
        verification: exit.kind,
      });
      evidence.failure ??= {
        stage: "app-server-cleanup-verification",
        kind: "cleanup-error",
      };
      process.exitCode = 1;
    }
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      evidence.cleanup.fixtureRemoved = !existsSync(root);
    } catch {
      evidence.cleanup.fixtureRemoved = false;
      evidence.failure ??= { stage: "fixture-cleanup", kind: "cleanup-error" };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
