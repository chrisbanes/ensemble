import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type APIResponse,
  type Response as PlaywrightResponse,
} from "playwright";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
import { OperatorRouteRegistry } from "../src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import { StandaloneService } from "../src/standalone/service.js";

const password = "browser test operator password";

function fakeRuntime() {
  return {
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed" as const;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class BrowserJourneyRuntime implements Runtime {
  turns = 0;
  threads = 0;
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
    return `browser-thread-${++this.threads}`;
  }

  async resumeThread(
    _threadId: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {}

  async startTurn(_threadId: string, _workspace: string, _prompt: string) {
    const turnId = `browser-turn-${++this.turns}`;
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

function serviceRoutes(service: StandaloneService): OperatorRouteRegistry {
  const routes = new OperatorRouteRegistry();
  routes.registerSlot("runtime", runtimeOperatorRoutes(service));
  routes.registerSlot(
    "coordination",
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (projectId) => service.routingAvailability(projectId),
    ),
  );
  return routes;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function signIn(
  page: Page,
  credential: string,
): Promise<PlaywrightResponse> {
  assert.equal(await page.getByRole("button", { name: "Sign in" }).count(), 1);
  await page.locator('input[name="password"]').fill(credential);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/login" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  return response;
}

function sessionId(context: BrowserContext): Promise<string> {
  return context.cookies().then((cookies) => {
    const cookie = cookies.find(
      (candidate) => candidate.name === "ensemble_operator_session",
    );
    assert.ok(cookie);
    return cookie.value;
  });
}

function csrfToken(page: Page): Promise<string> {
  return page.locator('input[name="csrfToken"]').first().inputValue();
}

async function save(page: Page, form: Locator): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/command" &&
      candidate.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Save" }).click();
  assert.equal((await response).status(), 303);
}

async function submitControl(
  page: Page,
  form: Locator,
  path: string,
  buttonName: string,
): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === path &&
      candidate.request().method() === "POST",
    { timeout: 5_000 },
  );
  await form.getByRole("button", { name: buttonName }).click();
  assert.equal((await response).status(), 303);
}

function command(service: StandaloneService, value: object): unknown {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...value,
  } as never);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("browser fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

test("Chromium verifies the independent login and guarded browser session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-browser-"));
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  let service = new StandaloneService(directory, fakeRuntime);
  let browser: Browser | undefined;
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  let context: BrowserContext | undefined;
  try {
    await service.start();
    let domain = service.domain();
    let ui = new LocalOperatorUi(domain);
    const profile = (await ui.submit({
      key: randomUUID(),
      type: "profile.create",
      name: "Private lead profile",
      instructions: "Private operator instructions",
      capabilities: "coordinate",
    })) as { id: string };
    const project = (await ui.submit({
      key: randomUUID(),
      type: "project.create",
      name: "Private browser project",
      leadProfileId: profile.id,
    })) as { id: string };

    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const time = { now: 1_000 };
    const authOptions = {
      authFile,
      origin,
      now: () => time.now,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
    };
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open(authOptions);
    http = new LocalOperatorHttp(ui, auth, { routes: serviceRoutes(service) });
    await http.start(port);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/project/${project.id}`);
    assert.equal(new URL(page.url()).pathname, `/project/${project.id}`);
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /Private browser project/,
    );
    assert.match(await page.locator("body").innerText(), /Sign in/);

    const loginUrl = `${origin}/login`;
    const preLoginCookie = await sessionId(context);
    const preLoginCsrf = await csrfToken(page);
    const failedLogin = await signIn(page, "wrong password");
    assert.equal(failedLogin.status(), 401);
    const failedHtml = await page.locator("body").innerText();
    assert.match(failedHtml, /Sign in failed/);
    assert.doesNotMatch(failedHtml, /Private browser project|wrong password/);
    assert.ok(
      (await sessionId(context)) === preLoginCookie,
      "failed login retains the anonymous session",
    );

    const badPreLoginCsrf = await context.request.post(loginUrl, {
      headers: { origin },
      form: { password, csrfToken: "wrong" },
    });
    assert.equal(badPreLoginCsrf.status(), 403);
    const missingPreLoginOrigin = await context.request.post(loginUrl, {
      form: { password, csrfToken: preLoginCsrf },
    });
    assert.equal(missingPreLoginOrigin.status(), 403);
    const foreignPreLoginOrigin = await context.request.post(loginUrl, {
      headers: { origin: "https://elsewhere.example" },
      form: { password, csrfToken: preLoginCsrf },
    });
    assert.equal(foreignPreLoginOrigin.status(), 403);
    const opaquePreLoginOrigin = await context.request.post(loginUrl, {
      headers: { origin: "null" },
      form: { password, csrfToken: preLoginCsrf },
    });
    assert.equal(opaquePreLoginOrigin.status(), 403);

    const successfulLogin = await signIn(page, password);
    assert.equal(successfulLogin.status(), 303);
    assert.equal(new URL(page.url()).pathname, "/");
    const responseCookie =
      (await successfulLogin.allHeaders())["set-cookie"] ?? "";
    assert.ok(/HttpOnly/.test(responseCookie), "session cookie is HttpOnly");
    assert.ok(
      /SameSite=Strict/.test(responseCookie),
      "cookie is SameSite Strict",
    );
    assert.ok(/Path=\//.test(responseCookie), "cookie path is root");
    assert.ok(!/Domain=/i.test(responseCookie), "cookie is host-only");
    assert.ok(
      (await sessionId(context)) !== preLoginCookie,
      "successful login rotates the session",
    );
    const storedCookie = (await context.cookies()).find(
      (candidate) => candidate.name === "ensemble_operator_session",
    );
    assert.ok(storedCookie);
    assert.equal(storedCookie.httpOnly, true);
    assert.equal(storedCookie.sameSite, "Strict");
    assert.equal(storedCookie.secure, false, "loopback test origin uses HTTP");
    assert.equal(storedCookie.domain, "127.0.0.1");
    assert.match(
      await page.locator("body").innerText(),
      /Private browser project/,
    );
    assert.ok(await page.getByRole("link", { name: "Runtime" }).count());
    assert.ok(await page.getByRole("link", { name: "Coordination" }).count());
    await page.getByRole("link", { name: "Runtime", exact: true }).click();
    assert.match(
      await page.locator("body").innerText(),
      /Effective execution policy/,
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /does not start or control execution/,
    );
    const capacityForm = page.locator(
      'form[action="/runtime/control/capacity"]',
    );
    await capacityForm.locator('input[name="globalLimit"]').fill("3");
    await capacityForm
      .locator('select[name="projectId"]')
      .selectOption(project.id);
    await capacityForm.locator('input[name="projectLimit"]').fill("1");
    const capacityResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/runtime/control/capacity" &&
        candidate.request().method() === "POST",
    );
    await capacityForm.getByRole("button", { name: "Save capacity" }).click();
    assert.equal((await capacityResponse).status(), 303);
    assert.equal(service.capacityLimits([project.id]).globalLimit, 3);
    assert.equal(
      service.capacityLimits([project.id]).projectOverrides[project.id],
      1,
    );
    await page.getByRole("link", { name: "Coordination", exact: true }).click();
    assert.match(
      await page.locator("body").innerText(),
      /Private browser project/,
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /Coordination state is not implemented/,
    );

    await page.goto(`${origin}/project/${project.id}`);
    const originalProjectForm = page.locator(
      'form[data-command="project.configure"]',
    );
    await originalProjectForm
      .locator('textarea[name="instructions"]')
      .fill("Original project's private instructions");
    await save(page, originalProjectForm);

    const protectedToken = await csrfToken(page);
    const rejectedForms = [
      { headers: { origin }, csrfToken: "wrong" },
      { headers: { origin }, csrfToken: "" },
      { headers: {}, csrfToken: protectedToken },
      { headers: { origin: "null" }, csrfToken: protectedToken },
      {
        headers: { origin: "https://elsewhere.example" },
        csrfToken: protectedToken,
      },
    ];
    for (const attempt of rejectedForms) {
      const response: APIResponse = await context.request.post(
        `${origin}/command`,
        {
          headers: attempt.headers,
          form: {
            type: "project.create",
            key: randomUUID(),
            projectId: randomUUID(),
            name: "Must not be created",
            csrfToken: attempt.csrfToken,
          },
        },
      );
      assert.equal(response.status(), 403);
    }
    assert.equal(domain.projects().length, 1);

    const forgedHost = await context.request.get(origin, {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": `127.0.0.1:${port}`,
      },
      maxRedirects: 0,
    });
    assert.equal(forgedHost.status(), 403);
    assert.doesNotMatch(await forgedHost.text(), /Private browser project/);

    const form = page.locator('form[data-command="project.create"]');
    const browserProjectId = await form
      .locator('input[name="projectId"]')
      .inputValue();
    await form.locator('input[name="name"]').fill("Browser-created project");
    const validPost = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/command" &&
        candidate.request().method() === "POST",
    );
    await form.getByRole("button", { name: "Save" }).click();
    assert.equal((await validPost).status(), 303);
    assert.match(
      await page.locator("body").innerText(),
      /Browser-created project/,
    );
    assert.equal(domain.projects().length, 2);
    await page.goto(`${origin}/profile/${profile.id}`);
    const profileForm = page.locator('form[data-command="profile.configure"]');
    await profileForm
      .locator('input[name="name"]')
      .fill("Browser-edited profile");
    await profileForm
      .locator('textarea[name="instructions"]')
      .fill("Browser-edited profile instructions");
    await save(page, profileForm);
    assert.equal(domain.profile(profile.id).name, "Browser-edited profile");

    await page.goto(`${origin}/project/${browserProjectId}`);
    const projectForm = page.locator('form[data-command="project.configure"]');
    await projectForm
      .locator('input[name="name"]')
      .fill("Browser-configured project");
    await projectForm
      .locator('select[name="leadProfileId"]')
      .selectOption(profile.id);
    await projectForm
      .locator('textarea[name="instructions"]')
      .fill("Project-specific operator guidance");
    await save(page, projectForm);
    assert.equal(domain.project(browserProjectId).leadProfileId, profile.id);
    assert.equal(domain.project(project.id).leadProfileId, profile.id);
    assert.notEqual(
      domain.project(project.id).instructions,
      domain.project(browserProjectId).instructions,
    );
    assert.equal(domain.project(project.id).paused, 1);
    assert.equal(domain.project(browserProjectId).paused, 1);

    await page.goto(`${origin}/project/${browserProjectId}`);
    const taskForm = page.locator('form[data-command="task.create"]');
    assert.match(await taskForm.innerText(), /Create and start/);
    assert.equal(
      await taskForm.locator('input[name="ready"]').isChecked(),
      false,
    );
    await taskForm.locator('input[name="title"]').fill("Browser-created task");
    await taskForm
      .locator('textarea[name="outcome"]')
      .fill("Deliver the operator form journey");
    const taskId = await taskForm.locator('input[name="taskId"]').inputValue();
    await save(page, taskForm);
    assert.equal(domain.tasks(browserProjectId).length, 1);
    assert.equal(domain.task(taskId).ready, 0);

    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== origin) {
        externalRequests.push(request.url());
      }
    });
    await page.goto(`${origin}/project/${browserProjectId}`);
    const startForm = page.locator('form[data-command="task.create"]');
    await startForm.locator('input[name="title"]').fill("Browser-started task");
    await startForm
      .locator('textarea[name="outcome"]')
      .fill("Set Ready from the create form only");
    await startForm.locator('input[name="ready"]').check();
    const startedTaskId = await startForm
      .locator('input[name="taskId"]')
      .inputValue();
    await save(page, startForm);
    assert.equal(domain.task(startedTaskId).ready, 1);
    assert.deepEqual(domain.admission(startedTaskId).reasons, [
      "project-paused",
    ]);
    assert.equal(domain.project(browserProjectId).paused, 1);
    assert.deepEqual(
      externalRequests,
      [],
      "the operator browser journey makes no cross-origin request",
    );
    assert.equal(domain.tasks(browserProjectId).length, 2);

    await page.goto(`${origin}/task/${taskId}`);
    const taskHtml = await page.locator("body").innerText();
    assert.match(taskHtml, /Deliver the operator form journey/);
    assert.match(taskHtml, /eligibility only/i);
    assert.match(taskHtml, /do not confirm runtime admission or execution/i);
    const taskConfigure = page.locator('form[data-command="task.configure"]');
    await taskConfigure
      .locator('input[name="title"]')
      .fill("Browser-edited task");
    await taskConfigure.locator('input[name="ready"]').check();
    await save(page, taskConfigure);
    assert.equal(domain.task(taskId).title, "Browser-edited task");
    assert.equal(domain.task(taskId).ready, 1);
    assert.deepEqual(domain.admission(taskId).reasons, ["project-paused"]);

    await page.goto(`${origin}/project/${browserProjectId}`);
    const routingForm = page.locator('form[data-command="routing.configure"]');
    await routingForm.locator('input[name="enabled"]').check();
    await routingForm
      .locator('textarea[name="guidance"]')
      .fill("Use only this configured candidate");
    await routingForm
      .locator('input[name="credentialRef"]')
      .fill("env:PRIVATE_BROWSER_CREDENTIAL_REF");
    await routingForm
      .locator('textarea[name="candidateProfileIds"]')
      .fill(JSON.stringify([profile.id], null, 2));
    await save(page, routingForm);
    assert.equal(domain.routing(browserProjectId).credentialAvailable, 1);
    await page.goto(`${origin}/project/${browserProjectId}`);
    const routingHtml = await page.locator("body").innerText();
    assert.match(routingHtml, /credential reference configured/);
    assert.doesNotMatch(routingHtml, /PRIVATE_BROWSER_CREDENTIAL_REF/);
    assert.equal(
      domain.routing(browserProjectId).candidateProfileIds,
      JSON.stringify([profile.id]),
    );

    const logoutForm = page.locator('form[action="/logout"]');
    const logoutResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/logout" &&
        candidate.request().method() === "POST",
    );
    await logoutForm.getByRole("button", { name: "Log out" }).click();
    assert.equal((await logoutResponse).status(), 303);
    assert.equal(new URL(page.url()).pathname, "/login");

    const restartedLogin = await signIn(page, password);
    assert.equal(restartedLogin.status(), 303);
    const priorServiceToken = await sessionId(context);
    const priorServer = http;
    const priorAuth = auth;
    await priorServer.stop();
    priorAuth.close();
    await service.stop();
    service = new StandaloneService(directory, fakeRuntime);
    await service.start();
    domain = service.domain();
    ui = new LocalOperatorUi(domain);
    const restartedAuth = await OperatorAuth.open(authOptions);
    auth = restartedAuth;
    http = new LocalOperatorHttp(ui, restartedAuth, {
      routes: serviceRoutes(service),
    });
    await http.start(port);
    assert.equal(
      Boolean(restartedAuth.getSession(priorServiceToken)),
      false,
      "service restart invalidates prior sessions",
    );
    assert.equal(domain.project(project.id).leadProfileId, profile.id);
    assert.equal(
      domain.project(project.id).instructions,
      "Original project's private instructions",
    );
    assert.equal(domain.project(browserProjectId).leadProfileId, profile.id);
    assert.equal(
      domain.project(browserProjectId).instructions,
      "Project-specific operator guidance",
    );
    assert.equal(domain.task(taskId).ready, 1);
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /Private browser project/,
    );

    const expiryLogin = await signIn(page, password);
    assert.equal(expiryLogin.status(), 303);
    time.now += 1_001;
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /Private browser project/,
    );
    assert.equal(domain.projects().length, 2);
  } finally {
    await context?.close();
    await browser?.close();
    await http?.stop();
    auth?.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Chromium submits coordination and runtime controls with durable readback", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-operator-forms-browser-"),
  );
  chmodSync(directory, 0o700);
  const dataFile = join(directory, "data");
  const authFile = join(directory, "operator-auth.json");
  const runtime = new BrowserJourneyRuntime();
  const serviceOptions = {
    power: { enabled: false },
    routingClient: null,
    supervisor: { observationMs: 5 },
  } as const;
  let service = new StandaloneService(
    dataFile,
    () => runtime,
    undefined,
    serviceOptions,
  );
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let auth: OperatorAuth | undefined;
  let http: LocalOperatorHttp | undefined;
  try {
    await service.start();
    const leadProfileId = randomUUID();
    const workerProfileId = randomUUID();
    const revokedProfileId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const blockerTaskId = randomUUID();
    const instructionTaskId = randomUUID();
    const workerAssignmentId = randomUUID();
    command(service, {
      type: "profile.create",
      profileId: leadProfileId,
      name: "Browser lead",
      instructions: "Coordinate the browser fixture.",
      capabilities: "coordinate",
    });
    command(service, {
      type: "profile.create",
      profileId: workerProfileId,
      name: "Browser worker",
      instructions: "Review and report the supplied fixture.",
      capabilities: "review; browser verification",
    });
    command(service, {
      type: "profile.create",
      profileId: revokedProfileId,
      name: "Browser revoked candidate",
      instructions: "This profile is no longer available for routing.",
      capabilities: "historical verification",
    });
    command(service, {
      type: "project.create",
      projectId,
      name: "Operator forms project",
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
        "BROWSER_ROUTING_GUIDANCE_SENTINEL: prefer browser verification.",
      credentialRef: "env:PRIVATE_BROWSER_ROUTING_SECRET",
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
      title: "Operator forms task",
      outcome: "Exercise coordination and runtime operator forms.",
      ready: false,
    });
    command(service, {
      type: "task.create",
      projectId,
      taskId: blockerTaskId,
      title: "Operator dependency blocker",
      outcome: "Remain incomplete during the operator journey.",
      ready: false,
    });
    command(service, {
      type: "task.create",
      projectId,
      taskId: instructionTaskId,
      title: "Instruction apply task",
      outcome: "Remain selected while instructions are updated.",
      ready: false,
    });
    service.domain().ensureLeadAssignment(instructionTaskId);
    service.domain().ensureLeadAssignment(taskId);
    command(service, {
      type: "assignment.create",
      projectId,
      taskId,
      assignmentId: workerAssignmentId,
      profileId: workerProfileId,
      brief: "Review the fixture and return one result.",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    const fixtureDb = (
      service as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): void } };
      }
    ).db;
    fixtureDb
      .prepare(`UPDATE domain_assignments
        SET resultRecipientAssignmentId = NULL,
          resultRecipientDisposition = 'unresolved'
        WHERE id = ?`)
      .run(workerAssignmentId);
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await waitUntil(() => runtime.turns === 1);
    const leadAssignment = service
      .domain()
      .assignments(taskId)
      .find((assignment) => assignment.profileId === leadProfileId);
    assert.ok(leadAssignment);
    const leadWork = service
      .list()
      .find((intent) => intent.turnId === "browser-turn-1");
    assert.ok(leadWork?.threadId && leadWork.turnId);
    for (const [tool, arguments_, callId] of [
      [
        "ensemble_ask_question",
        { question: "Which result format should I retain?" },
        "browser-question",
      ],
      [
        "ensemble_request_approval",
        {
          action: "Record fixture-only operator approval",
          target: "fixture-only",
          material: { version: "fixture-approve" },
        },
        "browser-approval-approve",
      ],
      [
        "ensemble_request_approval",
        {
          action: "Publish the fixture result",
          target: "operator-forms-fixture",
          material: { version: "fixture-deny" },
        },
        "browser-approval-deny",
      ],
    ] as const) {
      const result = await runtime.callTool({
        threadId: leadWork.threadId,
        turnId: leadWork.turnId,
        callId,
        tool,
        arguments: arguments_,
      });
      assert.equal(result.success, true, result.text);
    }

    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const authOptions = { authFile, origin };
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open(authOptions);
    const ui = new LocalOperatorUi(service.domain());
    http = new LocalOperatorHttp(ui, auth, { routes: serviceRoutes(service) });
    await http.start(port);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    assert.match(await page.locator("body").innerText(), /Sign in/);
    assert.equal((await signIn(page, password)).status(), 303);

    await page.goto(`${origin}/coordination/task/${taskId}`);
    const routingView = await page.locator("body").innerText();
    assert.match(routingView, /Credential reference: configured/);
    assert.match(routingView, /Routing client: unavailable/);
    assert.match(
      routingView,
      /Effective routing availability: unavailable \(missing client credentials\)/,
    );
    assert.match(
      routingView,
      /Project routing guidance: BROWSER_ROUTING_GUIDANCE_SENTINEL: prefer browser verification\./,
    );
    assert.match(
      routingView,
      /Browser worker — capabilities: review; browser verification; eligible routing candidate/,
    );
    assert.match(
      routingView,
      /Browser revoked candidate — capabilities: historical verification; unavailable: profile revoked/,
    );
    assert.doesNotMatch(routingView, /PRIVATE_BROWSER_ROUTING_SECRET/);
    const messageForm = page
      .locator('form[action="/coordination/control/message"]')
      .filter({
        has: page.locator(
          `input[name="recipientAssignmentId"][value="${leadAssignment.id}"]`,
        ),
      });
    await messageForm
      .locator('textarea[name="message"]')
      .fill("Please use the new operator direction on the next turn.");
    await submitControl(
      page,
      messageForm,
      "/coordination/control/message",
      "Submit",
    );
    const answerForm = page.locator(
      'form[action="/coordination/control/question/answer"]',
    );
    await answerForm
      .locator('textarea[name="answer"]')
      .fill("Retain the reviewed summary format.");
    await submitControl(
      page,
      answerForm,
      "/coordination/control/question/answer",
      "Submit",
    );
    const approvalForm = page
      .locator('form[action="/coordination/control/approval/decision"]')
      .filter({
        has: page.locator('input[name="decision"][value="approved"]'),
      })
      .filter({
        has: page.locator(
          'input[name="action"][value="Record fixture-only operator approval"]',
        ),
      });
    assert.equal(
      await approvalForm.locator('input[name="materialJson"]').inputValue(),
      '{"version":"fixture-approve"}',
    );
    await submitControl(
      page,
      approvalForm,
      "/coordination/control/approval/decision",
      "Approve this exact material",
    );
    const denialForm = page
      .locator('form[action="/coordination/control/approval/decision"]')
      .filter({ has: page.locator('input[name="decision"][value="denied"]') });
    await submitControl(
      page,
      denialForm,
      "/coordination/control/approval/decision",
      "Deny",
    );
    let taskView = service.coordinationView().readTask(taskId);
    assert.equal(taskView.questions[0]?.status, "answered");
    assert.equal(
      taskView.approvals.find(
        (approval) =>
          approval.action === "Record fixture-only operator approval",
      )?.status,
      "approved",
    );
    assert.equal(
      taskView.approvals.find(
        (approval) => approval.action === "Publish the fixture result",
      )?.status,
      "denied",
    );
    assert.ok(
      taskView.messages.some(
        (message) =>
          message.eventType === "operator-message" &&
          message.text ===
            "Please use the new operator direction on the next turn.",
      ),
    );

    runtime.complete("browser-turn-1");
    await waitUntil(
      () =>
        runtime.turns === 2 &&
        service
          .turnRequests()
          .some(
            (request) =>
              request.assignmentId === workerAssignmentId &&
              request.state === "active",
          ),
    );
    const workerWork = service
      .list()
      .find((intent) => intent.turnId === "browser-turn-2");
    assert.ok(workerWork?.threadId && workerWork.turnId);
    const reported = await runtime.callTool({
      threadId: workerWork.threadId,
      turnId: workerWork.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Browser-reviewed result awaiting reconciliation" },
    });
    assert.equal(reported.success, true, reported.text);
    runtime.complete(workerWork.turnId);
    await waitUntil(
      () =>
        service.coordinationView().readTask(taskId).unresolvedResults.length ===
        1,
    );
    await page.goto(`${origin}/coordination/task/${taskId}`);
    const reconciliationForm = page.locator(
      'form[action="/coordination/control/result/recipient"]',
    );
    await submitControl(
      page,
      reconciliationForm,
      "/coordination/control/result/recipient",
      "Reconcile to Browser lead",
    );
    taskView = service.coordinationView().readTask(taskId);
    assert.equal(taskView.unresolvedResults.length, 0);
    assert.equal(taskView.results[0]?.recipientAssignmentId, leadAssignment.id);

    await waitUntil(() => runtime.turns === 3);
    await page.goto(`${origin}/coordination/task/${taskId}`);
    await page
      .getByRole("link", { name: "Task-scoped runtime controls and recovery" })
      .click();
    assert.equal(new URL(page.url()).pathname, `/runtime/task/${taskId}`);

    const dependencyForm = page.locator(
      'form[action="/runtime/control/dependency/add"]',
    );
    await dependencyForm
      .locator('select[name="blockerTaskId"]')
      .selectOption(blockerTaskId);
    await submitControl(
      page,
      dependencyForm,
      "/runtime/control/dependency/add",
      "Add dependency",
    );
    assert.deepEqual(service.domain().dependencies(taskId), [blockerTaskId]);

    await page.goto(`${origin}/project/${projectId}`);
    const projectForm = page.locator('form[data-command="project.configure"]');
    await projectForm
      .locator('textarea[name="instructions"]')
      .fill("Browser-applied current project instructions.");
    await save(page, projectForm);
    assert.equal(
      Number(service.domain().project(projectId).instructionsRevision),
      2,
    );
    await page.goto(`${origin}/runtime/task/${instructionTaskId}`);
    const instructionAssignment = service
      .domain()
      .assignments(instructionTaskId)
      .find((assignment) => assignment.profileId === leadProfileId);
    assert.ok(instructionAssignment);
    const instructionForm = page
      .locator('form[action="/runtime/control/instruction-apply"]')
      .filter({
        has: page.locator(
          `input[name="assignmentId"][value="${instructionAssignment.id}"]`,
        ),
      });
    await submitControl(
      page,
      instructionForm,
      "/runtime/control/instruction-apply",
      "Apply current instructions for the next turn",
    );
    assert.equal(
      Number(
        service.domain().assignment(String(instructionAssignment.id))
          .instructionsRevision,
      ),
      2,
    );

    await page.goto(`${origin}/runtime/task/${taskId}`);
    const stopForm = page.locator('form[action="/runtime/control/stop"]');
    await submitControl(
      page,
      stopForm,
      "/runtime/control/stop",
      "Best-effort Stop",
    );
    let runtimeText = await page.locator("body").innerText();
    assert.match(runtimeText, /Operator Stop remains active/);
    assert.match(runtimeText, /Writer ownership remains held/);
    assert.match(runtimeText, /Effects may continue/);
    const stoppedRecoveryRecord = service
      .recoveryView()
      .find((record) => record.binding?.taskId === taskId);
    assert.ok(stoppedRecoveryRecord?.binding);
    assert.ok(stoppedRecoveryRecord.intent.threadId);
    assert.ok(stoppedRecoveryRecord.intent.turnId);
    assert.ok(
      runtimeText.includes(`Recovery record: ${stoppedRecoveryRecord.workId}`),
    );
    assert.ok(
      runtimeText.includes(
        `Assignment ${stoppedRecoveryRecord.binding.assignmentId} (version ${stoppedRecoveryRecord.binding.assignmentVersion};`,
      ),
    );
    assert.match(runtimeText, /Generation: work revision .*; request sequence/);
    assert.ok(
      runtimeText.includes(
        `Recorded thread identity: ${stoppedRecoveryRecord.intent.threadId}`,
      ),
    );
    assert.ok(
      runtimeText.includes(
        `Recorded turn identity: ${stoppedRecoveryRecord.intent.turnId}`,
      ),
    );
    assert.match(runtimeText, /not proof of termination or release/);
    await submitControl(
      page,
      page.locator('form[action="/runtime/control/resume"]'),
      "/runtime/control/resume",
      "Resume task",
    );
    runtimeText = await page.locator("body").innerText();
    assert.match(runtimeText, /Operator Stop is not active/);
    assert.match(runtimeText, /Writer ownership remains held/);
    assert.match(runtimeText, /Effects may continue/);

    await http.stop();
    http = undefined;
    auth.close();
    auth = undefined;
    await service.stop();
    const nextRuntime = new BrowserJourneyRuntime();
    service = new StandaloneService(
      dataFile,
      () => nextRuntime,
      undefined,
      serviceOptions,
    );
    await service.start();
    auth = await OperatorAuth.open(authOptions);
    http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
      routes: serviceRoutes(service),
    });
    await http.start(port);
    await page.goto(origin);
    assert.match(await page.locator("body").innerText(), /Sign in/);
    assert.equal((await signIn(page, password)).status(), 303);

    taskView = service.coordinationView().readTask(taskId);
    assert.equal(taskView.questions[0]?.status, "answered");
    assert.equal(
      taskView.approvals.find(
        (approval) =>
          approval.action === "Record fixture-only operator approval",
      )?.status,
      "approved",
    );
    assert.equal(
      taskView.approvals.find(
        (approval) => approval.action === "Publish the fixture result",
      )?.status,
      "denied",
    );
    assert.equal(taskView.unresolvedResults.length, 0);
    assert.equal(taskView.results[0]?.recipientAssignmentId, leadAssignment.id);
    assert.ok(
      taskView.messages.some(
        (message) =>
          message.eventType === "operator-message" &&
          message.text ===
            "Please use the new operator direction on the next turn.",
      ),
    );
    assert.deepEqual(service.domain().dependencies(taskId), [blockerTaskId]);
    assert.equal(
      Number(
        service.domain().assignment(String(instructionAssignment.id))
          .instructionsRevision,
      ),
      2,
    );
    assert.ok(
      service
        .recoveryView()
        .some(
          (record) => record.binding?.taskId === taskId && record.holds.writer,
        ),
    );
    const persistedRecoveryRecord = service
      .recoveryView()
      .find((record) => record.binding?.assignmentId === workerAssignmentId);
    assert.ok(persistedRecoveryRecord?.binding);
    await page.goto(
      `${origin}/runtime/assignment/${persistedRecoveryRecord.binding.assignmentId}`,
    );
    const persistedAssignmentText = await page.locator("body").innerText();
    assert.ok(
      persistedAssignmentText.includes(
        `Recovery record: ${persistedRecoveryRecord.workId}`,
      ),
    );
    assert.match(persistedAssignmentText, /Observations:/);
    assert.match(persistedAssignmentText, /Pending effects:/);
    assert.match(
      persistedAssignmentText,
      /Recorded identities, observations, receipts, and dispositions are evidence only/,
    );
    await page.goto(`${origin}/runtime/task/${taskId}`);
    const persistedDependency = page.locator(
      'form[action="/runtime/control/dependency/remove"]',
    );
    await submitControl(
      page,
      persistedDependency,
      "/runtime/control/dependency/remove",
      "Remove dependency",
    );
    assert.deepEqual(service.domain().dependencies(taskId), []);
  } finally {
    await context?.close();
    await browser?.close();
    await http?.stop();
    auth?.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
