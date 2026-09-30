import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  CodexRuntime,
  StandaloneService,
} from "../../dist/src/standalone/index.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../dist/src/standalone/operator.js";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { coordinationOperatorRoutes } from "../../dist/src/standalone/operator-coordination.js";
import { runtimeOperatorRoutes } from "../../dist/src/standalone/operator-runtime.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";

if (!process.argv.slice(2).includes("--live")) {
  process.stderr.write(
    "Refusing live Codex execution without the explicit --live flag.\n",
  );
  process.exit(2);
}

const evidence = {
  source: {},
  fixture: { created: false, removed: false },
  task: {},
  operator: { authenticated: false, restartInvalidatedSession: false },
  runtime: { processes: [] },
  question: null,
  stop: null,
  restart: null,
  cleanup: { appServerProcessesVerifiedExited: [] },
  limitations: {
    typeSafe: "disabled; routing is disabled and routingClient is null",
    providerThreads:
      "The harness does not request provider-thread deletion; Codex records may remain.",
    sharedCodexConfiguration: "not read or changed by this harness",
    executionBoundary:
      "Codex uses the operator's existing runtime login; this is not an independent sandbox proof.",
  },
  failure: null,
};

let stage = "source-identity";
let root;
let dataDir;
let authFile;
let password;
let service;
let runtime;
let auth;
let http;
let browser;
let context;
let page;
let taskId;
let releaseQuestionCallback;
let questionCallbackReleased = false;
let activeService;
let questionCallbackResolve;
const questionCallback = new Promise((resolve) => {
  questionCallbackResolve = resolve;
});
const questionCallbackGate = new Promise((resolve) => {
  releaseQuestionCallback = resolve;
});
const processIdentities = [];

function progress(next) {
  stage = next;
  process.stderr.write(`[s04d-live] ${next}\n`);
}

function failureKind(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/login|auth|account/i.test(message))
    return "authentication-or-account-check";
  if (/interrupt|cancel/i.test(message)) return "cancellation-request";
  if (/approval|policy|sandbox/i.test(message)) return "execution-policy";
  if (/exited|termination|process identity/i.test(message))
    return "runtime-cleanup";
  return "runtime-or-operator-assertion";
}

function command(body) {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...body,
  });
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
  const deadline = Date.now() + 10_000;
  let latest;
  do {
    latest = await verifier.verify(identity);
    if (latest.kind === "verified") return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return latest;
}

class ObservedCodexRuntime extends CodexRuntime {
  callbacks = [];

  onToolCall(listener) {
    super.onToolCall(async (call) => {
      const result = await listener(call);
      if (call.tool !== "ensemble_ask_question") return result;
      const intent = activeService
        ?.list()
        .find(
          (item) =>
            item.threadId === call.threadId && item.turnId === call.turnId,
        );
      assert.ok(intent, "question callback is bound to active task work");
      const observed = {
        tool: call.tool,
        callId: call.callId,
        workId: intent.workId,
        threadId: call.threadId,
        turnId: call.turnId,
      };
      this.callbacks.push(observed);
      activeService.registerExecutionCallback(
        intent.workId,
        questionCallbackGate,
      );
      questionCallbackResolve(observed);
      await questionCallbackGate;
      return result;
    });
  }
}

function operatorRoutes(currentService) {
  const routes = new OperatorRouteRegistry();
  routes.registerSlot("runtime", runtimeOperatorRoutes(currentService));
  routes.registerSlot(
    "coordination",
    coordinationOperatorRoutes(
      currentService.coordinationView(),
      currentService.domain(),
      (projectId) => currentService.routingAvailability(projectId),
    ),
  );
  return routes;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startOperator(port, origin) {
  auth = await OperatorAuth.open({ authFile, origin });
  http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
    routes: operatorRoutes(service),
  });
  await http.start(port);
}

async function signIn() {
  assert.match(await page.locator("body").innerText(), /Sign in/);
  await page.locator('input[name="password"]').fill(password);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/login" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const login = await response;
  assert.equal(login.status(), 303);
  assert.equal(login.headers().location, "/");
}

async function run() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const npmUserAgent = process.env.npm_config_user_agent ?? "";
  const npmVersion = /(?:^|\s)npm\/([^\s]+)/.exec(npmUserAgent)?.[1] ?? null;
  evidence.source = {
    revision,
    node: process.version,
    npm: npmVersion,
    codex: execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
  };

  progress("disposable-fixture-setup");
  root = mkdtempSync(join(tmpdir(), "ensemble-s04d-operator-"));
  chmodSync(root, 0o700);
  evidence.fixture.created = true;
  dataDir = join(root, "data");
  authFile = join(root, "operator-auth.json");
  password = randomBytes(32).toString("base64url");
  await OperatorAuth.initialize(authFile, password);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;

  runtime = new ObservedCodexRuntime();
  service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
    supervisor: { observationMs: 500 },
  });
  activeService = service;

  progress("authenticated-runtime-start");
  await service.start();
  const initialProcess = await runtime.processIdentity();
  assert.ok(initialProcess, "expected real Codex App Server process identity");
  processIdentities.push(initialProcess);
  evidence.runtime.processes.push(processEvidence(initialProcess));

  progress("operator-task-setup");
  const profileId = randomUUID();
  const projectId = randomUUID();
  taskId = randomUUID();
  command({
    type: "profile.create",
    profileId,
    name: "S04d live operator lead",
    instructions:
      "Use only the registered Ensemble coordination tools for this task.",
    capabilities: "task coordination",
  });
  command({
    type: "project.create",
    projectId,
    name: "Disposable S04d operator integration",
    leadProfileId: profileId,
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
    candidateProfileIds: [],
  });
  command({
    type: "task.create",
    projectId,
    taskId,
    title: "S04d live operator question and Stop",
    outcome: [
      "This is a disposable live operator-integration probe. Use only the registered Ensemble coordination tools. Do not use shell, filesystem, browser, network, or any other tools.",
      "Call ensemble_ask_question exactly once with question text S04D_OPERATOR_QUESTION_V1: Please confirm the operator review checkpoint. Do not attempt to answer the question. After the call, end the turn without using any more tools.",
    ].join("\n"),
    ready: false,
  });
  await service.provisionTask(taskId);
  command({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  evidence.task = { taskId, projectId, profileId };

  progress("operator-login");
  await startOperator(port, origin);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await page.goto(`${origin}/login`);
  await signIn();
  evidence.operator.authenticated = true;

  progress("live-question-callback");
  let callbackTimeout;
  const callback = await Promise.race([
    questionCallback,
    new Promise((_, reject) => {
      callbackTimeout = setTimeout(
        () => reject(new Error("live question callback timed out")),
        240_000,
      );
    }),
  ]).finally(() => clearTimeout(callbackTimeout));
  const taskView = service.coordinationView().readTask(taskId);
  const question = taskView.questions.find((item) => item.status === "open");
  assert.ok(question, "real runtime question is durably visible to operator");
  assert.match(question.prompt, /S04D_OPERATOR_QUESTION_V1/);
  evidence.question = {
    kind: question.kind,
    status: question.status,
    interactionId: question.interactionId,
    requestingAssignmentId: question.requestingAssignmentId,
    runtimeCallback: callback,
  };

  progress("chromium-live-runtime-and-coordination-views");
  await page.goto(`${origin}/runtime/task/${taskId}`);
  assert.equal(new URL(page.url()).origin, origin);
  const runtimeBeforeStop = await page.locator("body").innerText();
  assert.match(runtimeBeforeStop, /S04d live operator question and Stop/);
  assert.match(runtimeBeforeStop, /Best-effort Stop/);
  await page.goto(`${origin}/coordination/task/${taskId}`);
  assert.equal(new URL(page.url()).origin, origin);
  const coordinationBody = await page.locator("body").innerText();
  assert.match(coordinationBody, /S04D_OPERATOR_QUESTION_V1/);
  assert.match(coordinationBody, /open/i);
  assert.equal((await page.locator('a[href="/runtime"]').count()) > 0, true);

  progress("best-effort-stop-through-operator");
  await page.goto(`${origin}/runtime/task/${taskId}`);
  const stopResponse = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/runtime/control/stop" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Best-effort Stop" }).click();
  const stop = await stopResponse;
  assert.equal(stop.status(), 303);
  await page.waitForURL(`${origin}/runtime/task/${taskId}`);
  const afterStop = await page.locator("body").innerText();
  assert.match(afterStop, /Operator Stop remains active/);
  assert.match(afterStop, /Writer ownership remains held/);
  assert.match(
    afterStop,
    /Effects may continue while an execution is stopping/,
  );
  assert.doesNotMatch(
    afterStop,
    /force unlock|execution stopped and released/i,
  );
  evidence.stop = {
    responseStatus: stop.status(),
    outcomeCount: service
      .recoveryView()
      .filter((record) => record.binding?.taskId === taskId).length,
    uiReportsStopHold: /Operator Stop remains active/.test(afterStop),
    uiReportsWriterHold: /Writer ownership remains held/.test(afterStop),
    uiDisclosesEffectsMayContinue: /Effects may continue/.test(afterStop),
    noForceUnlockClaim: !/force unlock|execution stopped and released/i.test(
      afterStop,
    ),
  };

  progress("service-and-app-server-restart");
  releaseQuestionCallback();
  questionCallbackReleased = true;
  await http.stop();
  http = undefined;
  auth.close();
  auth = undefined;
  await service.stop();
  const firstExit = await verifyExited(initialProcess);
  assert.equal(firstExit.kind, "verified");
  evidence.cleanup.appServerProcessesVerifiedExited.push(
    processEvidence(initialProcess),
  );

  runtime = new ObservedCodexRuntime();
  service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
    supervisor: { observationMs: 500 },
  });
  activeService = service;
  await service.start();
  const restartedProcess = await runtime.processIdentity();
  assert.ok(restartedProcess, "expected restarted App Server process identity");
  processIdentities.push(restartedProcess);
  evidence.runtime.processes.push(processEvidence(restartedProcess));
  await startOperator(port, origin);

  progress("restart-invalidates-session-and-retains-history-holds");
  await page.goto(`${origin}/runtime/task/${taskId}`);
  const afterRestartLogin = await page.locator("body").innerText();
  assert.match(afterRestartLogin, /Sign in/);
  evidence.operator.restartInvalidatedSession = true;
  await signIn();
  await page.goto(`${origin}/coordination/task/${taskId}`);
  const retainedCoordination = await page.locator("body").innerText();
  assert.match(retainedCoordination, /S04D_OPERATOR_QUESTION_V1/);
  assert.match(retainedCoordination, /open/i);
  await page.goto(`${origin}/runtime/task/${taskId}`);
  const retainedRuntime = await page.locator("body").innerText();
  assert.match(retainedRuntime, /Operator Stop remains active/);
  assert.match(retainedRuntime, /Writer ownership remains held/);
  assert.doesNotMatch(
    retainedRuntime,
    /execution stopped and released|force unlock/i,
  );
  evidence.restart = {
    questionRetained: /S04D_OPERATOR_QUESTION_V1/.test(retainedCoordination),
    questionStillOpen: /open/i.test(retainedCoordination),
    stopHoldRetained: /Operator Stop remains active/.test(retainedRuntime),
    writerHoldRetained: /Writer ownership remains held/.test(retainedRuntime),
    noForceUnlockClaim: !/execution stopped and released|force unlock/i.test(
      retainedRuntime,
    ),
    runtimeCallbacksAfterRestart: runtime.callbacks.length,
  };
  assert.equal(runtime.callbacks.length, 0);

  progress("browser-logout");
  await page.goto(`${origin}/`);
  const logoutResponse = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/logout" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Log out" }).click();
  assert.equal((await logoutResponse).status(), 303);
}

try {
  await run();
} catch (error) {
  evidence.failure = { stage, kind: failureKind(error) };
  process.exitCode = 1;
} finally {
  if (!questionCallbackReleased) releaseQuestionCallback();
  password = "";
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await http?.stop().catch(() => undefined);
  auth?.close();
  try {
    await service?.stop();
  } catch {
    evidence.failure ??= { stage: "service-shutdown", kind: "cleanup-error" };
    process.exitCode = 1;
  }
  for (const identity of processIdentities) {
    const exit = await verifyExited(identity);
    if (exit.kind === "verified") {
      if (
        !evidence.cleanup.appServerProcessesVerifiedExited.some(
          (item) => item.processId === identity.processId,
        )
      )
        evidence.cleanup.appServerProcessesVerifiedExited.push(
          processEvidence(identity),
        );
    } else {
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
      evidence.fixture.removed = !existsSync(root);
    } catch {
      evidence.fixture.removed = false;
      evidence.failure ??= { stage: "fixture-cleanup", kind: "cleanup-error" };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
