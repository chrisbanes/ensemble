import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";

const test = browserSuite("ui04-comments");
test("approval-mode exact operator review and unknown remote comment retain original intent through viewing and provider read reconciliation", async (_t, j) => {
  const issue = {
    providerInstance: "github.com" as const,
    nodeId: "I1",
    repositoryId: "R1",
    repositoryName: "org/repo",
    number: 1,
    title: "Imported comment task",
    body: "Supplied GitHub brief",
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  };
  let effects = 0,
    settled = false,
    sourceComplete = true;
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      () => ({
        async readSelection() {
          return sourceComplete
            ? { complete: true as const, issues: [issue], reason: null }
            : {
                complete: false as const,
                issues: [issue],
                reason: "partial-retained-observation",
              };
        },
        async readBlockers() {
          return { complete: true, blockers: [], reason: null };
        },
        async readIssueStatus() {
          return { status: "open" };
        },
      }),
      {
        providerFactory: () => ({
          async preflight() {
            return { nodeId: "I1" };
          },
          async performAction() {
            effects++;
            return {
              state: "uncertain",
              reason: "response-lost",
              receipt: null,
            };
          },
          async inspectAction() {
            return settled
              ? {
                  state: "confirmed-success",
                  reason: null,
                  receipt: { nodeId: "C1" },
                }
              : { state: "uncertain", reason: "unproved", receipt: null };
          },
          async inspectPr() {
            throw Error("No PR in fixture");
          },
        }),
      },
      j.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Accountable lead",
    instructions: "Coordinate",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Comment project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_SOURCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  await f.service.refreshGitHub();
  const taskId = String(f.service.githubSources().issue("I1")?.taskId);
  d.ensureLeadAssignment(taskId);
  await f.service.provisionTask(taskId);
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "approval" }],
    requiredChecks: [],
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Post GitHub comment", exact: true })
    .click();
  await page.getByLabel("Editable reply").fill("Exact operator comment body");
  await page
    .getByRole("button", { name: "Message task lead", exact: true })
    .click();
  await page
    .getByLabel("Editable reply")
    .fill("Unfinished local message beside GitHub draft");
  await page
    .getByRole("button", { name: "Post GitHub comment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Ask lead about brief", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished local message beside GitHub draft",
  );
  assert.equal(await page.getByText(/^Immutable reference:/).count(), 0);
  await page
    .getByText(
      "Existing lead draft and reference retained. Finish or clear it before starting a new contextual reply.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Post GitHub comment", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact operator comment body",
  );
  await page
    .getByRole("button", { name: "Message task lead", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished local message beside GitHub draft",
  );
  await page.getByLabel("Editable reply").fill("");
  await page
    .getByRole("button", { name: "Ask lead about brief", exact: true })
    .click();
  assert.deepEqual(
    JSON.parse(
      (await page.getByText(/^Immutable reference:/).textContent())!.slice(
        "Immutable reference: ".length,
      ),
    ),
    { sourceId: f.service.taskReview().sources(taskId).at(-1)!.sourceId },
  );
  await page
    .getByRole("button", { name: "Post GitHub comment", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact operator comment body",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isEnabled(),
    false,
  );
  await page
    .getByRole("button", { name: "Review exact GitHub comment", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Exact operator comment review",
      exact: true,
    })
    .waitFor();
  assert.equal(effects, 0);
  await captureBrowserEvidence(page, "1366-exact-comment-review");
  await page
    .getByRole("button", { name: "Confirm exact comment", exact: true })
    .click();
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page.getByText(/uncertain: response-lost/).waitFor();
  assert.equal(effects, 1);
  const operation = f.service.delivery().actions()[0];
  assert.ok(operation);
  assert.ok("actor" in operation.binding);
  assert.equal(operation.binding.actor, "operator");
  await page
    .getByRole("button", { name: "Set viewing reference", exact: true })
    .click();
  await page
    .getByText("Observation / review receipt recorded", { exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .isEnabled(),
  );
  settled = true;
  await page
    .getByRole("button", { name: "Refresh delivery observation", exact: true })
    .click();
  await page.getByText(/issue.comment: confirmed-success/).waitFor();
  assert.equal(effects, 1);
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact operator comment body",
  );
  await page
    .getByRole("button", { name: "Reconcile original operation", exact: true })
    .click();
  await page
    .getByText(/confirmed-success: provider receipt recorded/)
    .waitFor();
  assert.equal(effects, 1);
  assert.equal(f.service.delivery().actions().length, 1);
  assert.equal(
    f.service.delivery().actions()[0]?.operationId,
    operation.operationId,
  );
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
  assert.ok(await page.getByText(/source unchanged/).count());
  const settleRender = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const retainedSource = f.service
    .taskReview()
    .sources(taskId)
    .at(-1)!.sourceId;
  const retainedBaseline = f.service.taskReview().read(taskId).viewed;
  sourceComplete = false;
  await f.service.refreshGitHub();
  assert.equal(
    f.service.taskReview().sources(taskId).at(-1)!.sourceId,
    retainedSource,
  );
  await page.goto(`${web.origin}/app/tasks/${taskId}`);
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor();
  assert.deepEqual(
    f.service.taskReview().read(taskId).viewed,
    retainedBaseline,
  );
  assert.equal(
    await page
      .getByText(/source unchanged|source requirements changed|refresh failed/)
      .count(),
    0,
  );
  await page.locator("#review").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-retained-partial-source", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#review").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-retained-partial-source", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  sourceComplete = true;
  await f.service.refreshGitHub();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page.getByText(/source unchanged/).waitFor();
  issue.body += "\nNew complete source observation";
  await f.service.refreshGitHub();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page.getByText(/source requirements changed/).waitFor();
  assert.deepEqual(
    f.service.taskReview().read(taskId).viewed,
    retainedBaseline,
  );
  issue.body = "Supplied GitHub brief";
  await f.service.refreshGitHub();
  const restoredTaskRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/operator/tasks/${taskId}`,
  );
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await (await restoredTaskRead).finished();
  await settleRender();
  await page
    .getByRole("button", { name: "Set viewing reference", exact: true })
    .click();
  await page.getByText(/source unchanged/).waitFor();
  await page.route(
    "**/api/operator/source-refresh",
    async (route) => {
      const response = await route.fetch();
      const observation = await response.json();
      observation.data.projects
        .find((p: { projectId: string }) => p.projectId === projectId)
        .selections.push({
          selectionId: "unrelated-partial-selection",
          state: "partial",
          lastAttemptAt: null,
          lastSuccessfulAt: null,
        });
      await route.fulfill({ response, json: observation });
    },
    { times: 1 },
  );
  const partialTaskRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/operator/tasks/${taskId}`,
  );
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await (await partialTaskRead).finished();
  await settleRender();
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor();
  assert.equal(
    await page
      .getByText(
        /source unchanged|source requirements changed|Source refresh failed/,
      )
      .count(),
    0,
  );
  const ordinaryTaskRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/operator/tasks/${taskId}`,
  );
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await (await ordinaryTaskRead).finished();
  await settleRender();
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor();
  assert.equal(
    await page
      .getByText(/source unchanged|source requirements changed/)
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page.getByText(/source unchanged/).waitFor();
  let releaseSource!: () => void, enterSource!: () => void;
  const sourceBarrier = new Promise<void>((r) => (releaseSource = r)),
    sourceEntry = new Promise<void>((r) => (enterSource = r));
  await page.route("**/api/operator/source-refresh", async (route) => {
    enterSource();
    await sourceBarrier;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    });
  });
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await sourceEntry;
  await page
    .getByText(/source comparison pending/)
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByText(/source unchanged|source requirements changed/)
      .count(),
    0,
  );
  releaseSource();
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByText(/source unchanged|source requirements changed/)
      .count(),
    0,
  );
  assert.ok(
    await page.getByText("Supplied GitHub brief", { exact: true }).count(),
  );
  await page
    .getByRole("link", { name: "Search", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor({ state: "attached" });
  await page.unroute("**/api/operator/source-refresh");
  await page.route("**/api/operator/tasks/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByText(/source comparison unknown; current observation unavailable/)
    .waitFor({ state: "attached" });
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByText(/source unchanged|source requirements changed/)
      .count(),
    0,
  );
  await page.unroute("**/api/operator/tasks/*");
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page.getByText(/source unchanged/).waitFor({ state: "attached" });
  // A successful observation's delayed task read cannot settle a newer failure.
  let releaseRead!: () => void, enterRead!: () => void, settleRead!: () => void;
  const readBarrier = new Promise<void>((r) => (releaseRead = r)),
    readEntry = new Promise<void>((r) => (enterRead = r)),
    readSettled = new Promise<void>((r) => (settleRead = r));
  await page.route("**/api/operator/tasks/*", async (route) => {
    const response = await route.fetch();
    enterRead();
    await readBarrier;
    await route.fulfill({ response });
    settleRead();
  });
  const refreshSource = () =>
    page
      .getByRole("button", { name: "Refresh source observation", exact: true })
      .evaluate((el) => (el as HTMLElement).click());
  const failSource = (route: import("playwright").Route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    });
  const assertUnknown = async () => {
    await page
      .getByText(/source comparison unknown; current observation unavailable/)
      .waitFor({ state: "attached" });
    assert.equal(
      await page
        .getByText(/source unchanged|source requirements changed/)
        .count(),
      0,
    );
  };
  await refreshSource();
  await readEntry;
  await page.route("**/api/operator/source-refresh", failSource);
  await refreshSource();
  await assertUnknown();
  releaseRead();
  await readSettled;
  await settleRender();
  await assertUnknown();
  await page.unroute("**/api/operator/tasks/*");
  await page.unroute("**/api/operator/source-refresh");
  await refreshSource();
  await page.getByText(/source unchanged/).waitFor({ state: "attached" });

  // A delayed provider completion itself must also belong to the current attempt.
  let releaseProvider!: () => void,
    enterProvider!: () => void,
    settleProvider!: () => void;
  const providerBarrier = new Promise<void>((r) => (releaseProvider = r)),
    providerEntry = new Promise<void>((r) => (enterProvider = r)),
    providerSettled = new Promise<void>((r) => (settleProvider = r));
  let providerRequests = 0;
  await page.route("**/api/operator/source-refresh", async (route) => {
    if (++providerRequests > 1) return failSource(route);
    const response = await route.fetch();
    enterProvider();
    await providerBarrier;
    await route.fulfill({ response });
    settleProvider();
  });
  await refreshSource();
  await providerEntry;
  await refreshSource();
  await assertUnknown();
  releaseProvider();
  await providerSettled;
  await settleRender();
  await assertUnknown();
  await page.unroute("**/api/operator/source-refresh");
  await refreshSource();
  await page.getByText(/source unchanged/).waitFor({ state: "attached" });
  let releaseLateSource!: () => void, enterLateSource!: () => void;
  const lateSourceBarrier = new Promise<void>((r) => (releaseLateSource = r)),
    lateSourceEntry = new Promise<void>((r) => (enterLateSource = r));
  await page.route("**/api/operator/source-refresh", async (route) => {
    const response = await route.fetch();
    enterLateSource();
    await lateSourceBarrier;
    await route
      .fulfill({ response })
      .catch((error) =>
        assert.match(String(error), /already handled|Target.*closed/),
      );
  });
  await page
    .getByLabel("Editable reply")
    .fill("Private old-session source draft");
  await page
    .getByRole("button", { name: "Refresh source observation", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await lateSourceEntry;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Editable reply").waitFor({ state: "attached" });
  releaseLateSource();
  await page.unroute("**/api/operator/source-refresh");
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
  assert.equal(await page.getByText(/source comparison pending/).count(), 0);
});
