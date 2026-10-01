import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
import { coordinationOperatorRoutes } from "../../dist/src/standalone/operator-coordination.js";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../dist/src/standalone/operator-runtime.js";
import { TypeSafeRoutingChoiceClient } from "../../dist/src/standalone/routing.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import {
  MAX_LIVE_CALLS,
  SqliteLiveCallBudget,
  withLiveCallBudget,
} from "../../dist/test/s05/live-call-budget.js";
import { isRoutedTaskSettled } from "../../dist/test/s05/routed-task-settlement.js";
import { tmpdir } from "../../dist/test/temp.js";
import { cleanupRoutingResources } from "./live-routing-cleanup.mjs";

const args = process.argv.slice(2);
const providerFree = args.includes("--provider-free");
const requestedCallLimit = Number(args[args.indexOf("--max-calls") + 1]);
const ledgerArgument = args.indexOf("--ledger");
const ledgerPath = ledgerArgument >= 0 ? args[ledgerArgument + 1] : undefined;
if (!args.includes("--live")) {
  process.stderr.write("Refusing live TypeSafe execution without --live.\n");
  process.exit(2);
}
if (
  !Number.isSafeInteger(requestedCallLimit) ||
  requestedCallLimit < 1 ||
  requestedCallLimit > MAX_LIVE_CALLS
) {
  process.stderr.write(
    `Refusing live execution: --max-calls must be from 1 through ${MAX_LIVE_CALLS}.\n`,
  );
  process.exit(2);
}
if (!ledgerPath || !isAbsolute(ledgerPath)) {
  process.stderr.write(
    "Refusing live execution without an absolute controller-owned --ledger path.\n",
  );
  process.exit(2);
}

const marker = "S05_ROUTED_CODEX_OK";
const evidence = {
  mode: "routing",
  source: {},
  fixture: { created: false, removed: false },
  operator: { authenticated: false },
  provider: {
    providerFree,
    model: "jev-1.13.0",
    configuredMaximum: requestedCallLimit,
    cost: "unknown; not returned by the routing choice adapter",
    accessOutcome: "not-started",
    reservedCalls: 0,
    reservedCallsBefore: null,
    ledgerRetained: false,
    keyRemovedBeforeCodexStart: false,
    retries: 0,
  },
  routedTasks: [],
  disabledPath: null,
  explicitPath: null,
  selectedCandidateExecutedByCodex: false,
  runtime: { process: null },
  cleanup: {
    appServerExited: false,
    fixtureRetained: false,
    resourceStatus: null,
    errors: [],
  },
  limitations: {
    typeSafe: "only bounded jev-1.13.0 routing selection is invoked",
    prompts: "not emitted or persisted by this harness",
    providerThreads: "the harness does not request provider-thread deletion",
    executionBoundary:
      "Codex uses the operator's existing runtime login; this is not an independent sandbox proof",
  },
  failure: null,
};

let stage = "source-identity";
let root;
let service;
let runtime;
let auth;
let http;
let browser;
let context;
let page;
let dataDir;
let authFile;
let password = "";
let origin;
let privateValues;
let budget;
let processIdentity;
let serviceStartAttempted = false;
let fixtureContainsLedger = false;
let currentRouteEvidence;
let currentRouteTaskId;

class ObservedCodexRuntime extends CodexRuntime {
  activeCallbacks = 0;

  onToolCall(listener) {
    super.onToolCall(async (call) => {
      this.activeCallbacks++;
      try {
        return await listener(call);
      } finally {
        this.activeCallbacks--;
      }
    });
  }
}

function progress(next) {
  stage = next;
  process.stderr.write(`[s05-routing] ${next}\n`);
}

function cleanupFailure(cleanupStage, errorType) {
  if (evidence.cleanup.errors.length < 12)
    evidence.cleanup.errors.push({ stage: cleanupStage, errorType });
  evidence.failure ??= {
    stage: cleanupStage,
    kind: "cleanup-error",
    errorType,
  };
  process.exitCode = 1;
}

function command(file, argv) {
  return execFileSync(file, argv, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function processEvidence(identity) {
  return identity
    ? {
        processId: identity.processId,
        processStartedAt: identity.processStartedAt,
        bootId: identity.bootId,
      }
    : null;
}

async function verifyExited(identity) {
  if (!identity) return { kind: "unproved" };
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

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

async function startOperator(port) {
  auth = await OperatorAuth.open({ authFile, origin });
  http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
    routes: operatorRoutes(service),
  });
  await http.start(port);
}

async function signIn() {
  await page.goto(`${origin}/login`);
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
  evidence.operator.authenticated = true;
}

async function submitCommand(form) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/command" &&
      candidate.request().method() === "POST",
  );
  await form.locator('button[type="submit"]').click();
  const result = await response;
  assert.equal(result.status(), 303);
  await page.waitForURL(`${origin}/`);
}

async function createProfile(name, instructions, capabilities) {
  await page.goto(`${origin}/`);
  const form = page.locator('form[data-command="profile.create"]');
  const profileId = await form.locator('input[name="profileId"]').inputValue();
  await form.locator('input[name="name"]').fill(name);
  await form.locator('textarea[name="instructions"]').fill(instructions);
  await form.locator('textarea[name="capabilities"]').fill(capabilities);
  await submitCommand(form);
  return profileId;
}

async function createProject(name, leadProfileId) {
  await page.goto(`${origin}/`);
  const form = page.locator('form[data-command="project.create"]');
  const projectId = await form.locator('input[name="projectId"]').inputValue();
  await form.locator('input[name="name"]').fill(name);
  await form
    .locator('select[name="leadProfileId"]')
    .selectOption(leadProfileId);
  await submitCommand(form);
  return projectId;
}

async function configureProject(projectId, paused) {
  await page.goto(`${origin}/project/${projectId}`);
  const form = page.locator('form[data-command="project.configure"]');
  await form.locator('input[name="paused"]').setChecked(paused);
  await submitCommand(form);
}

async function configureRouting(
  projectId,
  enabled,
  candidateProfileIds,
  credentialRef,
) {
  await page.goto(`${origin}/project/${projectId}`);
  const form = page.locator('form[data-command="routing.configure"]');
  await form.locator('input[name="enabled"]').setChecked(enabled);
  await form
    .locator('textarea[name="candidateProfileIds"]')
    .fill(JSON.stringify(candidateProfileIds));
  await form.locator('input[name="credentialRef"]').fill(credentialRef ?? "");
  await submitCommand(form);
}

async function createTask(projectId, title, outcome) {
  await page.goto(`${origin}/project/${projectId}`);
  const form = page.locator('form[data-command="task.create"]');
  const taskId = await form.locator('input[name="taskId"]').inputValue();
  await form.locator('input[name="title"]').fill(title);
  await form.locator('textarea[name="outcome"]').fill(outcome);
  await form.locator('input[name="ready"]').setChecked(false);
  await submitCommand(form);
  return taskId;
}

async function markTaskReady(taskId) {
  await page.goto(`${origin}/task/${taskId}`);
  const form = page.locator('form[data-command="task.configure"]');
  await form.locator('input[name="ready"]').setChecked(true);
  await submitCommand(form);
}

function routedView(taskId) {
  return service.coordinationView().readTask(taskId);
}

async function waitForRouteOutcome(taskId) {
  await waitUntil(
    () =>
      routedView(taskId).routing.attempts.some(
        (operation) =>
          operation.status !== "pending" && operation.status !== "routing",
      ),
    240_000,
    "bounded route outcome",
  );
  return routedView(taskId);
}

function attemptEvidence(view) {
  return view.routing.attempts.map((operation) => ({
    status: operation.status,
    attemptsUsed: operation.attemptsUsed,
    outcomeKind: operation.outcome?.kind ?? null,
    outcomeReason:
      operation.outcome?.kind === "lead-review"
        ? operation.outcome.reason
        : null,
    attempts: operation.attempts.map((attempt) => ({
      status: attempt.status,
      failureClass: attempt.failureClass,
      failureCode: attempt.failureCode,
      requestedModel: attempt.requestedModel,
      returnedModel: attempt.returnedModel,
      confidence: attempt.confidence,
      probabilities: attempt.probabilities,
      usage: attempt.usage,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      latencyMs:
        attempt.finishedAt === null
          ? null
          : Math.max(0, attempt.finishedAt - attempt.startedAt),
    })),
  }));
}

function credentialRejected(view) {
  return view.routing.attempts.some((operation) =>
    operation.attempts.some(
      (attempt) =>
        attempt.failureCode === "http-401" ||
        attempt.failureCode === "http-403",
    ),
  );
}

async function waitForAssignmentTerminal(assignmentId, expectedMarker) {
  let matched;
  await waitUntil(
    () => {
      const requests = service
        .turnRequests()
        .filter((request) => request.assignmentId === assignmentId);
      matched = service
        .list()
        .find((intent) =>
          requests.some((request) => request.workId === intent.workId),
        );
      return Boolean(
        matched && ["completed", "failed", "held"].includes(matched.state),
      );
    },
    240_000,
    "actual Codex assignment turn",
  );
  if (!matched?.threadId || !matched.turnId || matched.state !== "completed")
    throw new Error("selected assignment did not complete on Codex");
  const history = service
    .coordinationView()
    .readAssignmentHistory(assignmentId);
  const taskId = String(service.domain().assignment(assignmentId).taskId);
  const resultText = routedView(taskId)
    .results.filter((result) => result.assignmentId === assignmentId)
    .map((result) => result.summary)
    .join("\n");
  const markerMatched = expectedMarker
    ? history.items.some((item) => item.text?.includes(expectedMarker)) ||
      resultText.includes(expectedMarker)
    : null;
  return {
    assignmentId,
    workId: matched.workId,
    threadId: matched.threadId,
    turnId: matched.turnId,
    terminal: matched.state,
    markerMatched,
    historyItems: history.items.length,
    omissionCount: history.omittedItemCount,
  };
}

async function settleSelectedAssignment(
  taskId,
  leadProfileId,
  candidateProfileIds,
  expectedMarker,
) {
  const view = routedView(taskId);
  const assignmentId = view.routing.dispositions.find(
    (item) => item.assignmentId !== null,
  )?.assignmentId;
  if (!assignmentId) {
    if (
      view.routing.attempts.some(
        (operation) => operation.outcome?.kind === "lead-review",
      )
    ) {
      const lead = service
        .domain()
        .assignments(taskId)
        .find((assignment) => String(assignment.profileId) === leadProfileId);
      if (lead) return waitForAssignmentTerminal(String(lead.id));
    }
    return null;
  }
  const assignment = service.domain().assignment(assignmentId);
  const selectedProfileId = String(assignment.profileId);
  const expected = candidateProfileIds.includes(selectedProfileId)
    ? expectedMarker
    : undefined;
  const observation = await waitForAssignmentTerminal(assignmentId, expected);
  if (candidateProfileIds.includes(selectedProfileId)) {
    if (expectedMarker) assert.equal(observation.markerMatched, true);
    evidence.selectedCandidateExecutedByCodex = true;
  }
  return observation;
}

async function settleTaskTurns(taskId) {
  await waitUntil(
    () => {
      const task = service.domain().task(taskId);
      const requests = service
        .turnRequests()
        .filter((request) => request.taskId === taskId);
      const intents = requests.map((request) =>
        service.list().find((intent) => intent.workId === request.workId),
      );
      const intentStates = intents.map((intent) => intent?.state ?? "missing");
      if (intentStates.some((state) => state === "failed" || state === "held"))
        throw new Error("routed-task-has-unsuccessful-terminal-work");
      const assignments = service.domain().assignments(taskId);
      const assignmentStates = assignments.map((assignment) =>
        String(assignment.state),
      );
      const requestStates = requests.map((request) => request.state);
      const activeIntents = service.list().filter((intent) => {
        const request = service
          .turnRequests()
          .find((candidate) => candidate.workId === intent.workId);
        return (
          request?.taskId === taskId &&
          ["ready", "capacity-waiting", "submitting", "running"].includes(
            intent.state,
          )
        );
      }).length;
      const messagesDelivered = routedView(taskId).messages.every(
        (message) => message.deliveryState === "delivered",
      );
      return isRoutedTaskSettled({
        taskState: String(task.state),
        requestStates,
        intentStates,
        assignmentStates,
        messagesDelivered,
        activeIntents,
        activeCallbacks: runtime.activeCallbacks,
      });
    },
    240_000,
    "bounded routed task work to settle",
  );
}

function taskStateEvidence(taskId) {
  const task = service.domain().task(taskId);
  const assignments = service.domain().assignments(taskId);
  const requests = service
    .turnRequests()
    .filter((request) => request.taskId === taskId);
  const work = requests.map((request) => {
    const intent = service
      .list()
      .find((candidate) => candidate.workId === request.workId);
    return {
      workId: request.workId,
      assignmentId: request.assignmentId,
      requestState: request.state,
      intentState: intent?.state ?? "missing",
      holdClass: intent?.reason
        ? ([
            "Runtime submission or observation uncertain",
            "Storage failure before submission",
            "Admission recheck failed",
            "Request binding refused",
            "Request refused: captured revisions no longer match",
            "Previous work is not a completed binding",
            "Workspace admission",
          ].find((prefix) => intent.reason.startsWith(prefix)) ?? "other")
        : null,
      threadId: intent?.threadId ?? null,
      turnId: intent?.turnId ?? null,
    };
  });
  const view = routedView(taskId);
  return {
    taskState: String(task.state),
    assignments: assignments.slice(0, 16).map((assignment) => ({
      assignmentId: String(assignment.id),
      profileId: String(assignment.profileId),
      state: String(assignment.state),
      version: Number(assignment.version),
    })),
    work: work.slice(-16),
    messages: {
      total: view.messages.length,
      delivered: view.messages.filter(
        (message) => message.deliveryState === "delivered",
      ).length,
      pending: view.messages.filter(
        (message) => message.deliveryState !== "delivered",
      ).length,
    },
    results: view.results.slice(0, 16).map((result) => ({
      resultId: result.resultId,
      assignmentId: result.assignmentId,
      workId: result.workId,
      workRevision: result.workRevision,
      destinationDisposition: result.destinationDisposition,
    })),
    completionRequests: view.completionRequests.slice(0, 8).map((request) => ({
      status: request.status,
      reviewedResultCount: request.reviewedResultIds.length,
      rejectionReasons: request.rejectionReasons.slice(0, 8),
    })),
    openQuestions: view.questions.filter(
      (question) => question.status === "open",
    ).length,
    openApprovals: view.approvals.filter(
      (approval) => approval.status === "open",
    ).length,
    activeCallbacks: runtime.activeCallbacks,
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExactCreatedRoutingRoot(candidate) {
  if (!candidate || evidence.fixture.created !== true) return false;
  const name = basename(candidate);
  const prefix = "ensemble-s05-routing-";
  if (
    dirname(candidate) !== tmpdir() ||
    !name.startsWith(prefix) ||
    !/^[a-z0-9]{6,32}$/i.test(name.slice(prefix.length))
  )
    return false;
  try {
    const status = lstatSync(candidate);
    return (
      realpathSync(candidate) === candidate &&
      !status.isSymbolicLink() &&
      status.isDirectory()
    );
  } catch {
    return false;
  }
}

async function run() {
  progress("controller-owned-durable-ledger");
  const ledgerAlreadyExists = existsSync(ledgerPath);
  budget = new SqliteLiveCallBudget(ledgerPath, requestedCallLimit);
  if (!ledgerAlreadyExists) chmodSync(ledgerPath, 0o600);
  evidence.provider.ledgerRetained = true;
  const reservedCallsBefore = budget.reservedCalls();
  evidence.provider.reservedCallsBefore = reservedCallsBefore;
  evidence.provider.reservedCalls = reservedCallsBefore;

  progress("bounded-provider-client-setup");
  let apiKey = process.env.TYPESAFE_API_KEY;
  if (!providerFree && !apiKey?.trim())
    throw new Error("provider credential unavailable");
  privateValues = new Set(apiKey ? [apiKey] : []);
  const productionClient = providerFree
    ? {
        choose: async () => {
          throw new Error("provider-free-probe-forbids-provider-call");
        },
      }
    : new TypeSafeRoutingChoiceClient(apiKey);
  apiKey = "";
  delete process.env.TYPESAFE_API_KEY;
  evidence.provider.keyRemovedBeforeCodexStart = !Object.hasOwn(
    process.env,
    "TYPESAFE_API_KEY",
  );

  progress("source-identity");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const npmUserAgent = process.env.npm_config_user_agent ?? "";
  evidence.source = {
    revision: command("git", ["rev-parse", "HEAD"]),
    node: process.version,
    npm: /(?:^|\s)npm\/([^\s]+)/.exec(npmUserAgent)?.[1] ?? null,
    packageManager: packageJson.packageManager,
    codex: command("codex", ["--version"]),
    hashes: {
      source: {
        harness: sha256File("test/s05/live-routing.mjs"),
        cleanup: sha256File("test/s05/live-routing-cleanup.mjs"),
        service: sha256File("src/standalone/service.ts"),
        coordination: sha256File("src/core/coordination.ts"),
        domain: sha256File("src/core/domain.ts"),
        state: sha256File("src/standalone/state.ts"),
        operator: sha256File("src/standalone/operator.ts"),
        routing: sha256File("src/standalone/routing.ts"),
        history: sha256File("src/standalone/conversation-history.ts"),
        runtime: sha256File("src/standalone/codex.ts"),
        view: sha256File("src/standalone/coordination-view.ts"),
        budget: sha256File("test/s05/live-call-budget.ts"),
      },
      compiled: {
        service: sha256File("dist/src/standalone/service.js"),
        coordination: sha256File("dist/src/core/coordination.js"),
        domain: sha256File("dist/src/core/domain.js"),
        state: sha256File("dist/src/standalone/state.js"),
        operator: sha256File("dist/src/standalone/operator.js"),
        routing: sha256File("dist/src/standalone/routing.js"),
        history: sha256File("dist/src/standalone/conversation-history.js"),
        runtime: sha256File("dist/src/standalone/codex.js"),
        view: sha256File("dist/src/standalone/coordination-view.js"),
        budget: sha256File("dist/test/s05/live-call-budget.js"),
      },
    },
  };

  progress("private-disposable-fixture");
  root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s05-routing-")));
  evidence.fixture.created = true;
  chmodSync(root, 0o700);
  const ledgerRelativeToFixture = relative(root, realpathSync(ledgerPath));
  fixtureContainsLedger =
    ledgerRelativeToFixture === "" ||
    (ledgerRelativeToFixture !== ".." &&
      !ledgerRelativeToFixture.startsWith(`..${sep}`) &&
      !isAbsolute(ledgerRelativeToFixture));
  if (fixtureContainsLedger)
    throw new Error(
      "controller-owned ledger must remain outside the disposable fixture",
    );
  dataDir = join(root, "data");
  authFile = join(root, "operator-auth.json");
  password = randomBytes(32).toString("base64url");
  await OperatorAuth.initialize(authFile, password);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  runtime = new ObservedCodexRuntime();
  service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: providerFree
      ? productionClient
      : withLiveCallBudget(productionClient, budget),
    conversationHistoryExclusions: () => [...privateValues],
    supervisor: { observationMs: 500 },
  });

  progress("authenticated-codex-runtime-start");
  serviceStartAttempted = true;
  await service.start();
  processIdentity = await runtime.processIdentity();
  if (!processIdentity) throw new Error("Codex process identity unavailable");
  evidence.runtime.process = processEvidence(processIdentity);
  evidence.provider.keyRemovedBeforeCodexStart = !Object.hasOwn(
    process.env,
    "TYPESAFE_API_KEY",
  );
  await startOperator(port);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await signIn();

  progress("authenticated-profile-and-enabled-routing-setup");
  const leadProfileId = await createProfile(
    "S05 live routing lead",
    "Use only Ensemble coordination tools. As the task lead, complete a lead-review or disabled-routing task by calling ensemble_request_completion once with the exact result IDs in its durable inbox, or an empty list when there are none. If a candidate result arrives, review that result ID and request completion once. Do not delegate, ask questions, or request follow-up.",
    "Route review and accountability",
  );
  const candidateProfileId = await createProfile(
    "S05 live routing candidate",
    "Use only Ensemble coordination tools. For this bounded one-step task, report the requested exact marker as your result once with ensemble_report_result, then stop. Do not ask questions or request follow-up.",
    "Best eligible profile for clear exact-marker tasks; can return requested markers as a durable result without repository changes",
  );
  const alternateCandidateProfileId = await createProfile(
    "S05 live routing alternate candidate",
    "Use only Ensemble coordination tools. For this bounded one-step task, report the requested exact marker as your result once with ensemble_report_result, then stop. Do not ask questions or request follow-up.",
    "Eligible for simple one-step exact-marker work and can return requested markers as a durable result without repository changes",
  );
  const projectId = await createProject(
    "S05 bounded live routing",
    leadProfileId,
  );
  await configureProject(projectId, true);
  await configureRouting(
    projectId,
    true,
    [candidateProfileId, alternateCandidateProfileId],
    "env:TYPESAFE_API_KEY",
  );
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });

  const routedScenarios = [
    {
      name: "clear-classification",
      title: "S05 clear routing brief",
      brief: `Classify this simple one-step exact-marker task for the best eligible assignee. Both candidates are eligible; candidate capabilities identify the better fit. If appropriate, route it to a candidate rather than lead review. The selected Codex assignee must reply with the exact marker ${marker} and no other text.`,
      expectedMarker: marker,
      initiallyPaused: true,
    },
    {
      name: "ambiguous-classification",
      title: "S05 ambiguous routing brief",
      brief:
        "Please help with the matter when you can. No subject, expected outcome, constraints, or evidence are available yet.",
      expectedMarker: undefined,
      initiallyPaused: false,
    },
  ];

  for (const scenario of routedScenarios) {
    if (providerFree) break;
    if (budget.reservedCalls() >= requestedCallLimit) break;
    if (evidence.routedTasks.some((item) => item.credentialRejected)) break;
    progress(`route-${scenario.name}-provider-outcome`);
    const taskId = await createTask(projectId, scenario.title, scenario.brief);
    currentRouteTaskId = taskId;
    await service.provisionTask(taskId);
    await markTaskReady(taskId);
    if (scenario.initiallyPaused) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(service.domain().assignments(taskId).length, 0);
      assert.equal(
        service.turnRequests().some((request) => request.taskId === taskId),
        false,
      );
      await configureProject(projectId, false);
    }
    const view = await waitForRouteOutcome(taskId);
    const selected = view.routing.dispositions.find(
      (item) => item.assignmentId !== null,
    );
    const item = {
      name: scenario.name,
      taskId,
      operationCount: view.routing.attempts.length,
      attempts: attemptEvidence(view),
      disposition: selected?.disposition ?? null,
      selectedAssignment: selected?.assignmentId ?? null,
      selectedProfileIsEligibleCandidate: selected
        ? String(
            service.domain().assignment(selected.assignmentId).profileId,
          ) === candidateProfileId ||
          String(
            service.domain().assignment(selected.assignmentId).profileId,
          ) === alternateCandidateProfileId
        : false,
      codex: null,
      credentialRejected: credentialRejected(view),
      settlementStage: "provider-outcome-recorded",
    };
    evidence.routedTasks.push(item);
    currentRouteEvidence = item;
    evidence.provider.reservedCalls = budget.reservedCalls();
    evidence.provider.accessOutcome = item.credentialRejected
      ? "rejected"
      : "routing-response-recorded";
    try {
      item.settlementStage = "selected-assignment-terminal";
      progress(`route-${scenario.name}-selected-assignment-terminal`);
      item.codex = await settleSelectedAssignment(
        taskId,
        leadProfileId,
        [candidateProfileId, alternateCandidateProfileId],
        scenario.expectedMarker,
      );
      if (item.codex) {
        item.settlementStage = "durable-task-completion";
        progress(`route-${scenario.name}-durable-task-completion`);
        await settleTaskTurns(taskId);
      }
      item.taskCompleted = service.domain().task(taskId).state === "done";
      if (!item.taskCompleted) {
        item.failureAssertion = "route-task-not-durably-completed";
        throw new Error(item.failureAssertion);
      }
      item.settlementStage = "complete";
      item.finalState = taskStateEvidence(taskId);
    } catch (error) {
      item.failureAssertion ??= `${item.settlementStage}-failed`;
      item.failureType = error instanceof Error ? error.name : "non-error";
      item.failureState = taskStateEvidence(taskId);
      throw error;
    }
  }

  currentRouteEvidence = undefined;
  currentRouteTaskId = undefined;
  progress("disabled-routing-create-project");
  const callsBeforeDisabled = budget.reservedCalls();
  const disabledProjectId = await createProject(
    "S05 routing disabled path",
    leadProfileId,
  );
  progress("disabled-routing-pause-project");
  await configureProject(disabledProjectId, true);
  progress("disabled-routing-configure");
  await configureRouting(disabledProjectId, false, [candidateProfileId], null);
  progress("disabled-routing-create-task");
  const disabledTaskId = await createTask(
    disabledProjectId,
    "S05 disabled routing task",
    `Complete this disabled-routing probe through ensemble_request_completion with an empty reviewedResultIds list. Include marker S05_DISABLED_CODEX_OK in a brief response before calling the tool.`,
  );
  currentRouteTaskId = disabledTaskId;
  progress("disabled-routing-provision-task");
  await service.provisionTask(disabledTaskId);
  progress("disabled-routing-resume-project");
  await configureProject(disabledProjectId, false);
  progress("disabled-routing-mark-ready");
  await markTaskReady(disabledTaskId);
  progress("disabled-routing-wait-assignment");
  await waitUntil(
    () => service.domain().assignments(disabledTaskId).length > 0,
    60_000,
    "disabled project lead assignment",
  );
  const disabledView = routedView(disabledTaskId);
  const disabledAssignment = disabledView.assignments.find(
    (item) => item.profileId === leadProfileId,
  );
  if (!disabledAssignment)
    throw new Error("disabled path did not use project lead");
  progress("disabled-routing-wait-terminal");
  const disabledTurn = await waitForAssignmentTerminal(
    disabledAssignment.assignmentId,
  );
  progress("disabled-routing-wait-settlement");
  await settleTaskTurns(disabledTaskId);
  assert.equal(service.domain().task(disabledTaskId).state, "done");
  evidence.disabledPath = {
    routingEnabled: service.domain().routing(disabledProjectId).enabled === 1,
    routingOperationCount: disabledView.routing.attempts.length,
    assignmentUsesLead: disabledAssignment.profileId === leadProfileId,
    codexTerminal: disabledTurn.terminal,
  };
  assert.equal(budget.reservedCalls(), callsBeforeDisabled);

  progress("explicit-assignment-no-provider-call");
  const callsBeforeExplicit = budget.reservedCalls();
  const explicitProjectId = await createProject(
    "S05 explicit assignment path",
    leadProfileId,
  );
  await configureProject(explicitProjectId, true);
  await configureRouting(
    explicitProjectId,
    true,
    [candidateProfileId, alternateCandidateProfileId],
    "env:TYPESAFE_API_KEY",
  );
  const explicitTaskId = await createTask(
    explicitProjectId,
    "S05 explicit assignment task",
    "This task has an explicit operator-selected assignment.",
  );
  currentRouteTaskId = explicitTaskId;
  await service.provisionTask(explicitTaskId);
  await configureProject(explicitProjectId, false);
  const explicitAssignmentId = randomUUID();
  service.domain().execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId: explicitProjectId,
    taskId: explicitTaskId,
    assignmentId: explicitAssignmentId,
    profileId: candidateProfileId,
    brief:
      "Complete the exact-marker task S05_EXPLICIT_CODEX_OK by reporting that exact marker through ensemble_report_result, then stop.",
    resultDestination: "S05 explicit verification",
    requesterAssignmentId: null,
  });
  await markTaskReady(explicitTaskId);
  const explicitTurn = await waitForAssignmentTerminal(explicitAssignmentId);
  await settleTaskTurns(explicitTaskId);
  assert.equal(service.domain().task(explicitTaskId).state, "done");
  const explicitView = routedView(explicitTaskId);
  evidence.explicitPath = {
    routingEnabled: service.domain().routing(explicitProjectId).enabled === 1,
    routingOperationCount: explicitView.routing.attempts.length,
    explicitAssignmentUsed: explicitView.assignments.some(
      (item) => item.assignmentId === explicitAssignmentId,
    ),
    codexTerminal: explicitTurn.terminal,
  };
  assert.equal(budget.reservedCalls(), callsBeforeExplicit);
  evidence.provider.reservedCalls = budget.reservedCalls();
  evidence.provider.accessOutcome = evidence.routedTasks.some(
    (item) => item.credentialRejected,
  )
    ? "rejected"
    : "completed-or-not-rejected";
  if (evidence.routedTasks.some((item) => item.credentialRejected))
    evidence.failure = {
      stage: "provider-routing",
      kind: "provider-access-rejected",
    };
  if (evidence.failure) process.exitCode = 1;

  progress("operator-logout");
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
  const message = error instanceof Error ? error.message : String(error);
  const accessRejected =
    /provider credential|unauthori[sz]ed|HTTP 401|HTTP 403/i.test(message);
  evidence.failure = {
    stage,
    kind: accessRejected
      ? "provider-access-rejected"
      : /timeout|timed out/i.test(message)
        ? "timeout"
        : /login|auth|account/i.test(message)
          ? "authentication-or-account"
          : "runtime-or-operator-assertion",
    errorType: error instanceof Error ? error.name : "non-error",
    assertionId:
      currentRouteEvidence?.failureAssertion ??
      currentRouteEvidence?.settlementStage ??
      null,
  };
  if (service && currentRouteTaskId) {
    try {
      const state = taskStateEvidence(currentRouteTaskId);
      if (currentRouteEvidence) currentRouteEvidence.failureState ??= state;
      evidence.failure.state = currentRouteEvidence?.failureState ?? state;
    } catch {
      evidence.failure.state = { available: false };
    }
  }
  process.exitCode = 1;
} finally {
  password = "";
  const cleanup = await cleanupRoutingResources({
    context,
    browser,
    http,
    auth,
    service,
    serviceStartAttempted,
    processIdentity,
    verifyExited,
    budget,
    privateValues,
  });
  evidence.cleanup.appServerExited = cleanup.appServerExited;
  evidence.cleanup.resourceStatus = {
    contextClosed: cleanup.contextClosed,
    browserClosed: cleanup.browserClosed,
    httpStopped: cleanup.httpStopped,
    authClosed: cleanup.authClosed,
    serviceStopped: cleanup.serviceStopped,
    appServerExitStatus: cleanup.appServerExitStatus,
    ledgerReservationsRead: cleanup.ledgerReservationsRead,
    ledgerClosed: cleanup.ledgerClosed,
    privateValuesCleared: cleanup.privateValuesCleared,
    safeToRemoveFixture: cleanup.safeToRemoveFixture,
  };
  evidence.cleanup.errors = cleanup.errors;
  if (cleanup.errors.length > 0) {
    const firstError = cleanup.errors[0];
    evidence.failure ??= {
      stage: firstError.stage,
      kind: "cleanup-error",
      errorType: firstError.errorType,
    };
  }
  if (Number.isSafeInteger(cleanup.reservedCalls))
    evidence.provider.reservedCalls = cleanup.reservedCalls;
  if (providerFree)
    evidence.provider.accessOutcome = "provider-disabled-by-probe";
  if (
    evidence.provider.reservedCalls > 0 &&
    evidence.provider.accessOutcome === "not-started"
  )
    evidence.provider.accessOutcome = "reserved-without-recorded-response";
  const exactCreatedRoot = root && isExactCreatedRoutingRoot(root);
  if (
    root &&
    exactCreatedRoot &&
    !fixtureContainsLedger &&
    cleanup.safeToRemoveFixture
  ) {
    try {
      rmSync(root, { recursive: true, force: false });
      evidence.fixture.removed = !existsSync(root);
      if (!evidence.fixture.removed)
        cleanupFailure("fixture-removal", "FixtureNotRemoved");
    } catch {
      cleanupFailure("fixture-removal", "Error");
    }
  } else if (root) {
    if (!exactCreatedRoot)
      cleanupFailure("fixture-root-identity", "OwnedFixtureIdentityUnverified");
    else process.exitCode = 1;
  }
  evidence.cleanup.fixtureRetained = Boolean(root && !evidence.fixture.removed);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
