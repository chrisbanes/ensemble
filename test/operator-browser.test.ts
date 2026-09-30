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
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
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
    http = new LocalOperatorHttp(ui, auth);
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
    assert.match(taskHtml, /scheduler.*unavailable/i);
    assert.doesNotMatch(taskHtml, /no work is admitted or running/i);
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
    assert.match(routingHtml, /credential configured/);
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
    http = new LocalOperatorHttp(ui, restartedAuth);
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
