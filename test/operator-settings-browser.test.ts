import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui06");
import { actionKinds } from "../src/core/delivery.js";
import { chromium, type Browser, type Page } from "playwright";
import {
  seedOperatorRecovery,
  seedOperatorDelivery,
  createOperatorFixture,
} from "./fixtures/operator-web.js";
test("Settings guides empty workspace through profile and paused project creation", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(web.origin + "/app/settings");
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("link", { name: "Create profile", exact: true })
    .waitFor();
  await capture(page, "1366-empty-settings");
  await page.getByRole("link", { name: "Create profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).waitFor();
  await capture(page, "1366-first-profile-setup");
  await page.getByLabel("Profile name", { exact: true }).fill("Setup lead");
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE SETUP INPUT");
  await page.getByLabel("Capabilities", { exact: true }).fill("Coordinate");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await page.getByText("Recorded.", { exact: false }).waitFor();
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page.getByRole("link", { name: "Create project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Setup project");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Setup lead" });
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await page.getByText("Recorded.", { exact: false }).waitFor();
  assert.equal(f.service.domain().projects().length, 1);
  assert.equal(f.service.domain().projects()[0]?.paused, 1);
  assert.equal(f.runtime.turns, 0);
});
async function capture(page: Page, name: string) {
  return captureBrowserEvidence(page, name);
}
async function signIn(
  page: Page,
  web: { origin: string; password: string },
  path: string,
) {
  await page.goto(web.origin + path);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
function seedSettings(f: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID(),
    d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead <script>window.bad=1</script>",
    instructions: "PRIVATE CURRENT PROFILE",
    capabilities: "Coordinate",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Paused configuration project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "PRIVATE CURRENT PROJECT",
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Recovery task",
    outcome: "Work",
    ready: false,
  });
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  return { profileId, projectId, taskId, assignmentId };
}
function contrast(first: string, second: string) {
  const luminance = (color: string) => {
    const parts = (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const linear = value / 255;
        return linear <= 0.04045
          ? linear / 12.92
          : ((linear + 0.055) / 1.055) ** 2.4;
      });
    return (
      (parts[0] ?? 0) * 0.2126 +
      (parts[1] ?? 0) * 0.7152 +
      (parts[2] ?? 0) * 0.0722
    );
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
test("ordinary links stay distinct while styled actions and long controls fit small viewports", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, "/app/settings");

  const ordinary = page.getByRole("link", {
    name: "Paused configuration project",
    exact: true,
  });
  const ordinaryStyle = await ordinary.evaluate((element) => {
    const style = getComputedStyle(element);
    return { decoration: style.textDecorationLine, color: style.color };
  });
  assert.equal(ordinaryStyle.decoration, "underline");
  assert.equal(ordinaryStyle.color, "rgb(250, 250, 250)");

  const navigation = page.locator(".sidebar .nav-link").first();
  assert.equal(
    await navigation.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    "none",
  );
  const action = page.getByRole("link", {
    name: "Create project",
    exact: true,
  });
  const actionStyle = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
      decoration: style.textDecorationLine,
      slot: element.getAttribute("data-slot"),
    };
  });
  assert.equal(actionStyle.slot, "button");
  assert.equal(actionStyle.foreground, "rgb(23, 23, 23)");
  assert.equal(actionStyle.background, "rgb(229, 229, 229)");
  assert.equal(actionStyle.decoration, "none");
  assert.ok(contrast(actionStyle.foreground, actionStyle.background) >= 4.5);

  await page.goto(`${web.origin}/app/projects/${ids.projectId}/settings`);
  const editorLink = page.getByRole("link", { name: "exact source editor" });
  assert.equal(
    await editorLink.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
    "underline",
  );
  const observationButton = page.getByRole("button", {
    name: "Request installation-wide source observations",
    exact: true,
  });
  assert.equal(
    await observationButton.evaluate(
      (element) => getComputedStyle(element).height,
    ),
    "36px",
  );
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await observationButton.scrollIntoViewIfNeeded();
    const layout = await observationButton.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        left: rect.left,
        right: rect.right,
        height: rect.height,
        whiteSpace: style.whiteSpace,
        minHeight: style.minHeight,
        overflowWrap: style.overflowWrap,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(layout.whiteSpace, "normal", `${width}px button wraps`);
    assert.equal(layout.minHeight, "44px", `${width}px phone target remains`);
    assert.ok(
      layout.overflowWrap === "break-word" ||
        layout.overflowWrap === "anywhere",
    );
    assert.ok(
      layout.height >= 44,
      `${width}px button keeps phone touch target`,
    );
    assert.ok(
      layout.left >= 0 && layout.right <= width,
      `${width}px button fits`,
    );
    if (width === 320)
      assert.ok(layout.height > 44, "long label wraps and grows at 320px");
    assert.ok(
      layout.documentWidth <= layout.viewportWidth,
      `${width}px page has no overflow`,
    );
    if (width === 320)
      await captureBrowserEvidence(page, "320-long-source-observations-button");
  }
  assert.equal(f.runtime.turns, 0);
});
test("unknown configuration survives scope navigation and exact reconciliation while auth expiry purges private drafts", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const posts: string[] = [];
  const readBodies: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => {
    if (r.url().includes("/api/operator/") && r.request().method() === "GET")
      readBodies.push(await r.text().catch(() => ""));
  });
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page.getByLabel("Replace instructions", { exact: true }).check();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE WRITE ONLY DRAFT");
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page
    .getByRole("link", { name: "Paused configuration project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  assert.equal(posts.length, 1);
  assert.equal(
    await page.getByLabel("New instructions", { exact: true }).inputValue(),
    "PRIVATE WRITE ONLY DRAFT",
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).isDisabled(),
    true,
  );
  await capture(page, "1366-unknown-private-draft");
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "invalid-input",
          message: "Check input",
          fieldPaths: ["name"],
        },
      }),
    });
  });
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).isDisabled(),
    true,
  );
  await page.unroute("**/api/operator/commands");
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands"))
      posts.push(r.postData() ?? "");
  });
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .click();
  await page
    .getByText("Recorded. Latest observations", { exact: false })
    .waitFor();
  assert.deepEqual(posts, [posts[0], posts[0], posts[0]]);
  assert.equal(f.service.domain().project(ids.projectId).version, 3);
  assert.ok(readBodies.every((s) => !s.includes("PRIVATE")));
  assert.deepEqual(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
    { local: [], session: [] },
  );
  assert.equal(
    await page.evaluate(() =>
      Boolean((window as unknown as { bad?: number }).bad),
    ),
    false,
  );
  await page
    .getByRole("button", {
      name: "Review latest project revision",
      exact: true,
    })
    .click();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE EXPIRES");
  f.advanceClock(61_000);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).waitFor();
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Project configuration", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Replace instructions", { exact: true }).isChecked(),
    false,
  );
  assert.equal(posts.length, 3);
  assert.deepEqual(errors, []);
});
test("configuration inline validation stale revision and revoked lead failures retain editable input", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page.getByLabel("Project name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("Check this field.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel("Project name", { exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await capture(page, "1366-inline-error");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Retained edited name");
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 2,
    name: "External change",
  });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page
    .getByText("Configuration changed. Review", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Retained edited name",
  );
  assert.equal(f.service.domain().project(ids.projectId).version, 3);
  const other = randomUUID();
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: other,
    name: "Candidate",
    instructions: "private",
    capabilities: "work",
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Project configuration", exact: true })
    .waitFor();
  await page.getByLabel("Lead profile", { exact: true }).selectOption(other);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Permission denied input");
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: other,
    expectedVersion: 1,
    revoked: true,
  });
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  assert.equal((await response).status(), 403);
  await page
    .getByText("Submission rejected. Your input is retained.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Permission denied input",
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).isDisabled(),
    false,
  );
  assert.equal(f.service.domain().project(ids.projectId).version, 3);
  await capture(page, "1366-revoked-lead-rejection");
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page.getByRole("link", { name: "Candidate", exact: true }).click();
  await page
    .getByText("Revoked: subsequent actions are denied.", { exact: false })
    .waitFor();
  await capture(page, "1366-revoked-profile-settings");
});
test("source replacement verifies repositories without diagnostic echo and observation refresh remains partial", async (_t, journey) => {
  let reads = 0;
  const reader = {
    async readSelection() {
      reads++;
      return {
        complete: false as const,
        issues: [],
        reason: "PRIVATE PROVIDER FAILURE",
      };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "unknown" as const };
    },
  };
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      null,
      () => reader,
      undefined,
      journey.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f);
  f.service.domain().execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [
      {
        id: "Literal <script>bad()</script>",
        kind: "search",
        query: "PRIVATE SAVED QUERY",
      },
    ],
    repositories: [],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "ready" }],
    },
  });
  f.service.domain().execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    selectionId: "Literal <script>bad()</script>",
    expectedVersion: 2,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page
    .getByRole("button", { name: "Add linked repository", exact: true })
    .click();
  await page.getByLabel("Linked repository ID", { exact: true }).fill("repo");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill("relative-private-path");
  await page
    .getByLabel(
      "Replace all selections, readiness and repositories, including explicit empty lists",
      { exact: true },
    )
    .check();
  const bad = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  assert.equal((await bad).status(), 400);
  await page
    .getByText("Check linked repository IDs, paths and refs.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("New local repository path", { exact: true })
      .inputValue(),
    "relative-private-path",
  );
  assert.equal(
    await page
      .getByLabel("New local repository path", { exact: true })
      .isDisabled(),
    false,
  );
  const repositoryDescription = await page
    .getByLabel("New local repository path", { exact: true })
    .evaluate((e) => {
      const id = e.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    });
  assert.equal(
    repositoryDescription,
    "Check linked repository IDs, paths and refs.",
  );
  await page.waitForFunction(
    () => {
      const field = document.querySelector(
        '[aria-describedby="source-repositories-error"][aria-invalid="true"]',
      );
      return (
        field !== null &&
        getComputedStyle(field).borderTopColor === "rgba(255, 102, 105, 0.6)"
      );
    },
    { timeout: 1000 },
  );
  const invalidStyle = await page
    .getByLabel("New local repository path", { exact: true })
    .evaluate((e) => {
      const style = getComputedStyle(e);
      return {
        border: style.borderTopColor,
        foreground: style.color,
        background: getComputedStyle(document.body).backgroundColor,
        slot: e.getAttribute("data-slot"),
        invalid: e.getAttribute("aria-invalid"),
      };
    });
  assert.equal(invalidStyle.slot, "input");
  assert.equal(invalidStyle.invalid, "true");
  assert.match(invalidStyle.border, /255, 102, 105/);
  assert.equal(invalidStyle.foreground, "rgb(250, 250, 250)");
  assert.equal(invalidStyle.background, "rgb(10, 10, 10)");
  await capture(page, "1366-repository-error");
  await page
    .getByRole("button", {
      name: "Request installation-wide source observations",
      exact: true,
    })
    .click();
  await page
    .getByText("Literal <script>bad()</script>: partial.", { exact: false })
    .waitFor();
  assert.equal(reads, 1);
  await capture(page, "1366-source-partial");
  assert.equal(await page.locator("script").count(), 1);
  assert.equal(
    (await page.locator("body").innerText()).includes(
      "PRIVATE PROVIDER FAILURE",
    ),
    false,
  );
  const repositoryPath = join(f.directory, "verified-repository");
  await mkdir(repositoryPath);
  const git = promisify(execFile);
  await git("git", ["init", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "Fixture repository\n");
  await git("git", ["-C", repositoryPath, "add", "README.md"]);
  await git("git", [
    "-C",
    repositoryPath,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(repositoryPath);
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  await page
    .getByText("Recorded github.configure:", { exact: false })
    .waitFor();
  assert.equal(
    f.service.domain().githubConfiguration(ids.projectId).version,
    3,
  );
  assert.equal(
    f.service.domain().githubConfiguration(ids.projectId).credentialRef,
    "env:FIXTURE_GITHUB",
  );
  assert.equal(
    f.service.domain().githubConfiguration(ids.projectId).repositories.length,
    1,
  );
  const configResponse = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.projectId}/configuration`,
  );
  assert.equal((await configResponse.text()).includes(repositoryPath), false);
  await page
    .getByRole("button", { name: "Review latest source revision", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove repository 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  await page
    .getByText("Recorded github.configure:", { exact: false })
    .waitFor();
  assert.equal(
    f.service.domain().githubConfiguration(ids.projectId).repositories.length,
    0,
  );
  assert.equal(
    f.service.domain().githubConfiguration(ids.projectId).version,
    4,
  );
});
for (const layout of [
  { name: "1366", width: 1366, height: 820, scale: 1 },
  { name: "390", width: 390, height: 844, scale: 1 },
  { name: "683-zoom", width: 683, height: 410, scale: 2 },
])
  test(`settings and omitted recovery ownership remain readable at ${layout.name}`, async (_t, journey) => {
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const ids = seedSettings(f);
    seedOperatorRecovery(f, ids);
    await f.service.resumeTask(ids.taskId);
    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport: { width: layout.width, height: layout.height },
      deviceScaleFactor: layout.scale,
    });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const external: string[] = [],
      errors: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(web.origin)) external.push(r.url());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page, web, "/app/settings");
    await capture(page, `${layout.name}-populated-settings`);
    await page
      .getByRole("link", { name: "Paused configuration project", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Project configuration", exact: true })
      .waitFor();
    await page
      .getByText("Readiness: All conditions: label ready", { exact: true })
      .waitFor();
    assert.equal(
      (await page.locator("[data-current-readiness]").innerText()).includes(
        "{",
      ),
      false,
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: "Open delivery policy and authority editor",
          exact: true,
        })
        .getAttribute("href"),
      `/project/${ids.projectId}`,
    );
    await capture(page, `${layout.name}-paused-configuration`);
    await page.getByLabel("Project name", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByLabel("Lead profile", { exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .getByLabel("Project name", { exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    if (layout.width < 768) {
      await page
        .getByRole("button", { name: "Projects and navigation", exact: true })
        .click();
      await page.getByRole("dialog").waitFor();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
        assert.equal(
          await page
            .getByRole("dialog")
            .evaluate((e) => e.contains(document.activeElement)),
          true,
        );
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Projects and navigation",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Projects and navigation", exact: true })
          .evaluate((e) => e === document.activeElement),
        true,
      );
    }
    await page.goto(
      web.origin + `/app/assignments/${ids.assignmentId}/recovery`,
    );
    await page
      .getByText("1 older recovery records omitted", { exact: false })
      .waitFor();
    assert.ok(
      (await page.locator("body").innerText()).includes(
        "Writer ownership: held",
      ),
    );
    assert.ok(
      (await page.locator("body").innerText()).includes("Capacity: held"),
    );
    assert.equal(
      await page
        .getByRole("button", { name: /Force|unlock|release|proof/i })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: "Advanced recovery evidence and exact Apply",
          exact: true,
        })
        .getAttribute("href"),
      `/runtime/assignment/${ids.assignmentId}`,
    );
    assert.equal(
      await page
        .getByRole("heading", { name: "Page not found", exact: true })
        .count(),
      0,
    );
    await capture(page, `${layout.name}-omitted-recovery`);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      (await page.locator("body").innerText()).includes("PRIVATE"),
      false,
    );
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    assert.equal(f.runtime.turns, 0);
    console.log(
      `UI06 screenshots ${journey.directory}; Chromium ${browser.version()}; ${layout.name}`,
    );
  });

test("Runtime Settings records lowered capacity separately from usage and retains ownership evidence", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f);
  seedOperatorRecovery(f, ids);
  await f.service.resumeTask(ids.taskId);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO execution_capacity_reservations(workId,projectId) VALUES ('recovery-generation-2',?)",
      )
      .run(ids.projectId),
  );
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, "/app/settings/runtime");
  await page
    .getByText("Global usage 2 / 4; default project limit 2.", { exact: true })
    .waitFor();
  await page.getByText("Execution hold recorded", { exact: true }).waitFor();
  const capacityControl = await page
    .getByLabel("Global active-turn cap", { exact: true })
    .evaluate((e) => ({
      height: getComputedStyle(e).height,
      slot: e.getAttribute("data-slot"),
      family: getComputedStyle(e).fontFamily,
    }));
  assert.equal(capacityControl.height, "36px");
  assert.equal(capacityControl.slot, "input");
  assert.match(capacityControl.family, /Inter/);
  const capacityOverride = await page
    .getByLabel("Set capacity override for Paused configuration project", {
      exact: true,
    })
    .evaluate((e) => ({
      width: getComputedStyle(e).width,
      height: getComputedStyle(e).height,
      checked: (e as HTMLInputElement).checked,
    }));
  assert.deepEqual(capacityOverride, {
    width: "20px",
    height: "20px",
    checked: false,
  });
  await page.getByLabel("Global active-turn cap", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Save capacity", exact: true })
    .click();
  await page
    .getByText("Recorded. Latest observations", { exact: false })
    .waitFor();
  await page
    .getByText("Global usage 2 / 1; default project limit 2.", { exact: true })
    .waitFor();
  const recordedCapacity = page.getByText("Recorded capacity limits:", {
    exact: false,
  });
  await recordedCapacity.waitFor();
  assert.equal(
    await recordedCapacity.innerText(),
    "Recorded capacity limits: global 1; default project 2; project overrides none.",
  );
  assert.equal((await recordedCapacity.innerText()).includes("version"), false);
  assert.equal(
    f.service.capacityLimits([ids.projectId]).currentUsage.global,
    2,
  );
  assert.equal(f.service.list().filter((r) => r.state === "held").length, 1);
  await capture(page, "1366-capacity-below-usage");
  await page.getByRole("link", { name: /recovery evidence$/ }).click();
  await page.getByRole("heading", { name: "Recovery", exact: true }).waitFor();
  await page
    .getByText("1 older recovery records omitted", { exact: false })
    .waitFor();
});

function seedPlacement(f: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const ids = seedSettings(f),
    target = randomUUID(),
    destination = randomUUID(),
    taskId = randomUUID(),
    d = f.service.domain();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: target,
    name: "Actual membership target",
    leadProfileId: null,
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: destination,
    name: "Third membership destination",
    leadProfileId: null,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    title: "Conflicting imported task",
    outcome: "Work",
    ready: false,
  });
  d.markImportedTask(taskId, "I_PLACEMENT", "R_PLACEMENT");
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com','I_PLACEMENT',?,'R_PLACEMENT','owner/repo',1,'Imported','Body','open','[]')",
    ).run(taskId);
    for (const projectId of [ids.projectId, target, destination])
      db.prepare(
        "INSERT INTO github_memberships VALUES (?,'selection','I_PLACEMENT','[]')",
      ).run(projectId);
  });
  return { ids, target, destination, taskId, d };
}
test("actual source placement retains its original receipt after transfer removes the conflict", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { ids, target, taskId, d } = seedPlacement(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page
    .getByLabel("Placement project", { exact: true })
    .selectOption({ label: "Actual membership target" });
  const received = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  const response = await received,
    submitted = JSON.parse(response.request().postData() ?? "{}"),
    original = await response.json();
  assert.equal(response.status(), 200);
  await page
    .getByText("Recorded placement outcome", { exact: false })
    .waitFor();
  assert.equal(d.task(taskId).projectId, target);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: target,
    taskId,
    expectedVersion: 2,
    state: "done",
  });
  const session = await (
    await page.request.get(`${web.origin}/api/operator/session`)
  ).json();
  const replay = await page.request.post(
    `${web.origin}/api/operator/commands`,
    {
      headers: { origin: web.origin, "x-csrf-token": session.csrfToken },
      data: submitted,
    },
  );
  assert.equal(replay.status(), 200);
  assert.deepEqual(await replay.json(), original);
  assert.equal(d.task(taskId).version, 3);
});

test("unknown committed placement stays reachable after conflict disappearance and navigation", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { ids, target, taskId, d } = seedPlacement(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page
    .getByLabel("Placement project", { exact: true })
    .selectOption(target);
  const posts: string[] = [];
  let original: unknown;
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    original = await (await route.fetch()).json();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  assert.equal(d.task(taskId).projectId, target);
  assert.equal(d.task(taskId).version, 2);
  assert.equal(f.service.githubSources().conflicts().length, 0);
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page
    .getByRole("link", { name: "Paused configuration project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  await capture(page, "1366-unknown-placement-after-navigation");
  for (const status of [400, 403, 409]) {
    await page.unroute("**/api/operator/commands");
    await page.route("**/api/operator/commands", async (route) => {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code:
              status === 409
                ? "conflict"
                : status === 403
                  ? "permission-denied"
                  : "invalid-input",
            message: "Rejected",
          },
        }),
      });
    });
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .waitFor();
    assert.equal(posts.length, 1 + [400, 403, 409].indexOf(status) + 1);
  }
  await page.unroute("**/api/operator/commands");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands"))
      posts.push(r.postData() ?? "");
  });
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .click();
  assert.deepEqual(await (await response).json(), original);
  await page
    .getByText("Recorded. Latest observations", { exact: false })
    .waitFor();
  assert.deepEqual(posts, Array(5).fill(posts[0]));
  assert.equal(d.task(taskId).version, 2);
  assert.equal(f.runtime.turns, 0);
  await capture(page, "1366-reconciled-placement-original-receipt");
});
test("mounted reference and placement fields have unique associated controls", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { ids, target, d } = seedPlacement(f);
  const second = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: second,
    title: "Second placement",
    outcome: "Work",
    ready: false,
  });
  d.markImportedTask(second, "I_SECOND", "R_SECOND");
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com','I_SECOND',?,'R_SECOND','owner/repo',2,'Second','Body','open','[]')",
    ).run(second);
    for (const projectId of [ids.projectId, target])
      db.prepare(
        "INSERT INTO github_memberships VALUES (?,'selection','I_SECOND','[]')",
      ).run(projectId);
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const references = page.getByLabel("Credential reference change", {
    exact: true,
  });
  let releaseConfiguration!: () => void, configurationEntered!: () => void;
  const configurationBarrier = new Promise<void>(
    (resolve) => (releaseConfiguration = resolve),
  );
  const configurationEntry = new Promise<void>(
    (resolve) => (configurationEntered = resolve),
  );
  const configurationRoute = `**/api/operator/projects/${ids.projectId}/configuration`;
  journey.cleanup(
    async () => releaseConfiguration(),
    "configuration-barrier.release",
  );
  await page.route(configurationRoute, async (route) => {
    const response = await route.fetch();
    configurationEntered();
    await configurationBarrier;
    await route.fulfill({ response });
  });
  try {
    await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
    await configurationEntry;
    // Authentication shell readiness precedes this independently loaded resource.
    assert.equal(await references.count(), 0);
  } finally {
    releaseConfiguration();
  }
  await references.nth(1).waitFor({ state: "visible" });
  await page.unroute(configurationRoute);
  assert.equal(await references.count(), 2);
  for (const reference of await references.all())
    await reference.selectOption("set");
  const duplicated = await page
    .locator("[id]")
    .evaluateAll((elements) =>
      elements.map((e) => e.id).filter((id, i, ids) => ids.indexOf(id) !== i),
    );
  assert.deepEqual(duplicated, []);
  const associated = await page.locator("label[for]").evaluateAll((labels) =>
    labels.every((label) => {
      const html = label as HTMLLabelElement;
      return html.control !== null && html.contains(html.control);
    }),
  );
  assert.equal(associated, true);
  const inputs = page.getByLabel("New environment reference", { exact: true });
  assert.equal(await inputs.count(), 2);
  await inputs.nth(0).fill("env:ROUTING_NEW");
  await inputs.nth(1).fill("env:SOURCE_NEW");
  assert.equal(await inputs.nth(0).inputValue(), "env:ROUTING_NEW");
  const placements = page.getByLabel("Placement project", { exact: true });
  assert.equal(await placements.count(), 2);
  await placements.nth(0).selectOption(target);
  assert.equal(await placements.nth(1).inputValue(), "");
  await placements.nth(1).selectOption(ids.projectId);
  assert.equal(await placements.nth(0).inputValue(), target);
  await capture(page, "1366-unique-reference-placement-controls");
  assert.equal(f.runtime.turns, 0);
});

test("readiness validation focuses the exact invalid row with a real description", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  const labels = page.getByLabel("Ready label", { exact: true });
  await labels.nth(0).fill("");
  await page
    .getByLabel(
      "Replace all selections, readiness and repositories, including explicit empty lists",
      { exact: true },
    )
    .check();
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) posts++;
  });
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  const verify = async (index: number) => {
    const input = labels.nth(index);
    await page.waitForFunction(
      ({ index }) => {
        const inputs = [...document.querySelectorAll("input")].filter(
          (e) => e.closest("label")?.textContent?.trim() === "Ready label",
        );
        return inputs[index] === document.activeElement;
      },
      { index },
    );
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.equal(
      await input.evaluate((e) => {
        const id = e.getAttribute("aria-describedby");
        return id ? document.getElementById(id)?.textContent : null;
      }),
      "Check readiness mode and complete conditions.",
    );
  };
  await verify(0);
  await labels.nth(0).fill("ready");
  await page
    .getByRole("button", { name: "Add readiness condition", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  await verify(1);
  assert.equal(await labels.nth(0).getAttribute("aria-invalid"), "false");
  assert.equal(posts, 0);
  assert.equal(f.runtime.turns, 0);
  await capture(page, "1366-readiness-later-row-error-focus");

  await labels.nth(1).fill("ready-again");
  await page.route("**/api/operator/commands", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "invalid-input",
          message: "Check input",
          fieldPaths: ["readiness.mode"],
        },
      }),
    });
  });
  await page
    .getByRole("button", { name: "Replace source configuration", exact: true })
    .click();
  const mode = page.getByLabel("Readiness matching", { exact: true });
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Readiness matching"][aria-invalid="true"]',
      ) !== null,
    { timeout: 1000 },
  );
  assert.equal(await mode.getAttribute("aria-invalid"), "true");
  const modeDescription = await mode.evaluate((e) => {
    const id = e.getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent : null;
  });
  assert.equal(modeDescription, "Check this field.");
  await page.waitForFunction(
    () => {
      const field = document.querySelector(
        'select[aria-label="Readiness matching"][aria-invalid="true"]',
      );
      return (
        field !== null &&
        getComputedStyle(field).borderTopColor === "rgba(255, 102, 105, 0.6)"
      );
    },
    { timeout: 1000 },
  );
  const modeBorder = await mode.evaluate(
    (e) => getComputedStyle(e).borderTopColor,
  );
  assert.equal(modeBorder, "rgba(255, 102, 105, 0.6)");
  await capture(page, "1366-readiness-mode-select-error");
});

test("Settings retains exact delivery authority and bound-PR detail without provider effects", async (_t, journey) => {
  let providerCalls = 0;
  const unexpectedProviderCall = async () => {
    providerCalls++;
    throw Error("Unexpected fixture provider call");
  };
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      {
        providerFactory: () => ({
          inspectAction: unexpectedProviderCall,
          preflight: unexpectedProviderCall,
          performAction: unexpectedProviderCall,
          inspectPr: unexpectedProviderCall,
        }),
      },
      journey.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    d = f.service.domain();
  const grants = actionKinds.map((action) => ({
    action,
    repositoryId: "R1",
    mode: "approval" as const,
    ...(action === "project.field"
      ? { projectNodeId: "P1", fieldNodeId: "F1", optionNodeIds: ["O1"] }
      : {}),
  }));
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants,
    requiredChecks: [{ name: "check", appId: 42 }],
  });
  const caller = seedOperatorDelivery(f, ids),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const external: string[] = [],
    errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(web.origin)) external.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  await page
    .getByRole("link", {
      name: "Open delivery policy and authority editor",
      exact: true,
    })
    .click();
  const policy = page.locator('form[data-command="delivery.configure"]');
  assert.equal(
    await policy.locator('[name="expectedVersion"]').inputValue(),
    "2",
  );
  assert.equal(
    await policy.getByLabel(/^mode(?:\s|$)/).inputValue(),
    "reviewable-pr",
  );
  assert.deepEqual(
    await policy
      .getByLabel(/^mode(?:\s|$)/)
      .locator("option")
      .allTextContents(),
    ["Reviewable PR", "Through merge"],
  );
  assert.deepEqual(
    JSON.parse(await policy.getByLabel(/^grants(?:\s|$)/).inputValue()),
    grants,
  );
  assert.deepEqual(
    JSON.parse(await policy.getByLabel(/^requiredChecks(?:\s|$)/).inputValue()),
    [{ name: "check", appId: 42 }],
  );
  assert.equal(
    await policy.getByLabel("credentialRef", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await policy.getByLabel("clearCredentialRef", { exact: true }).isChecked(),
    false,
  );
  for (const viewport of [
    { width: 1366, height: 820 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await capture(page, `${viewport.width}-retained-delivery-policy`);
  }
  await page.goto(`${web.origin}/coordination/task/${ids.taskId}`);
  const settlements = page.locator(
    'form[action="/coordination/control/delivery/settle"]',
  );
  assert.equal(await settlements.count(), 2);
  for (const [index, decision] of ["accepted", "closed"].entries()) {
    const form = settlements.nth(index);
    const material = await form
      .locator("input")
      .evaluateAll((inputs) =>
        Object.fromEntries(
          inputs.map((e) => [
            (e as HTMLInputElement).name,
            (e as HTMLInputElement).value,
          ]),
        ),
      );
    assert.equal(material.taskId, ids.taskId);
    assert.equal(material.expectedTaskVersion, String(caller.taskVersion));
    assert.equal(material.expectedDeliveryRevision, "1");
    assert.equal(material.expectedPolicyVersion, "2");
    assert.equal(material.repositoryId, "R1");
    assert.equal(material.prNumber, "7");
    assert.equal(material.expectedPrNodeId, "P7");
    assert.equal(material.expectedHeadSha, "1".repeat(40));
    assert.equal(material.decision, decision);
    assert.equal(
      await form.getByRole("button").innerText(),
      index === 0 ? "Accept handback" : "Settle outcome as closed",
    );
  }
  for (const fact of [
    "No imported issue observation.",
    "Project field observations: None observed.",
    "PR 7 (P7)",
    "provider state OPEN",
    "Provider feedback: None observed.",
    "No external actions.",
    "Local task: open",
    "Delivery holds:",
  ])
    assert.equal(
      (await page.locator("body").innerText()).includes(fact),
      true,
      fact,
    );
  assert.equal(
    await page
      .getByRole("button", {
        name: "Refresh delivery observations",
        exact: true,
      })
      .count(),
    1,
  );
  for (const viewport of [
    { width: 1366, height: 820 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await capture(page, `${viewport.width}-retained-bound-delivery-detail`);
  }
  assert.equal(d.deliveryConfiguration(ids.projectId).version, 2);
  assert.equal(d.task(ids.taskId).version, caller.taskVersion);
  assert.equal(f.service.delivery().delivery(ids.taskId)?.settlement, null);
  assert.equal(f.runtime.turns, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    `UI06 retained delivery: two guarded settlement forms, all nine grant kinds, zero provider calls; screenshots ${journey.directory}`,
  );
});

test("non-owner project keeps one unknown placement and its original receipt after navigation", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { ids, target, destination, taskId, d } = seedPlacement(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${target}/settings`);
  await page
    .getByLabel("Placement project", { exact: true })
    .selectOption(destination);
  const posts: string[] = [];
  let original:
    | { key: string; result: { projectId: string; version: number } }
    | undefined;
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    original = await response.json();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  const command = JSON.parse(posts[0] ?? "null");
  assert.equal(
    command.projectId,
    ids.projectId,
    "canonical command binds the original owner A",
  );
  assert.equal(command.chosenProjectId, destination);
  assert.equal(command.expectedVersion, 1);
  assert.equal(command.taskId, taskId);
  assert.equal(
    command.placementOriginProjectId,
    undefined,
    "presentation scope never enters command bytes",
  );
  assert.equal(d.task(taskId).projectId, destination);
  assert.equal(d.task(taskId).version, 2);
  assert.equal(f.service.githubSources().conflicts().length, 0);
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page
    .getByRole("link", { name: "Paused configuration project", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Project configuration", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Record placement", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .count(),
    0,
  );
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page
    .getByRole("link", { name: "Actual membership target", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  await capture(page, "1366-non-owner-unknown-placement");
  assert.equal(
    await page
      .getByRole("button", { name: "Record placement", exact: true })
      .count(),
    0,
  );
  await page.unroute("**/api/operator/commands");
  for (const [status, code] of [
    [400, "invalid-input"],
    [403, "forbidden"],
    [409, "conflict"],
  ] as const) {
    await page.route("**/api/operator/commands", async (route) => {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code, message: "Safe failure" } }),
      });
    });
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .waitFor();
    await page.unroute("**/api/operator/commands");
  }
  assert.equal(
    await page
      .getByRole("button", {
        name: "Review latest placement revision",
        exact: true,
      })
      .count(),
    0,
  );
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith(`/projects/${target}/configuration`),
  );
  await page
    .getByRole("button", { name: "Reload project configuration", exact: true })
    .click();
  const observed = await (await read).json();
  assert.equal(observed.data.placements.length, 0);
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  assert.equal(
    posts.length,
    4,
    "reload is an observation, never reconciliation or rekey",
  );
  assert.equal(
    await page
      .getByText("Recorded placement outcome", { exact: false })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", {
        name: "Review latest placement revision",
        exact: true,
      })
      .count(),
    0,
  );
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...original,
        result: {
          ...original?.result,
          commandType: "github.place",
          resourceId: taskId,
          projectId: target,
        },
      }),
    });
  });
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText("Recorded. Latest observations", { exact: false })
      .count(),
    0,
  );
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postData() ?? "");
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), original);
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Reconcile exact submission", exact: true })
    .click();
  await page
    .getByText("Recorded. Latest observations", { exact: false })
    .waitFor();
  assert.deepEqual(posts, Array(6).fill(posts[0]));
  assert.equal(original?.key, command.key);
  assert.equal(original?.result.projectId, destination);
  assert.equal(original?.result.version, 2);
  assert.equal(d.task(taskId).version, 2);
  await page.getByRole("link", { name: "Settings home", exact: true }).click();
  await page
    .getByRole("link", { name: "Actual membership target", exact: true })
    .click();
  await page
    .getByText("Recorded placement outcome", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Reconcile exact submission", exact: true })
      .count(),
    0,
  );
  assert.equal(
    (
      await page
        .getByText("Recorded placement outcome", { exact: false })
        .innerText()
    ).includes(`project ${destination}; version 2`),
    true,
  );
  assert.equal(posts.length, 6);
  assert.equal(f.runtime.turns, 0);
  await capture(page, "1366-non-owner-recorded-placement");
});

test("initial placement conflict requires explicit loaded revision adoption while preserving choice", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { ids, target, taskId, d } = seedPlacement(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/projects/${target}/settings`);
  await page
    .getByLabel("Placement project", { exact: true })
    .selectOption(target);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    expectedVersion: 1,
    state: "open",
  });
  assert.equal(d.task(taskId).version, 2);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/operator/commands"))
      posts.push(request.postData() ?? "");
  });
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  assert.equal((await response).status(), 409);
  await page
    .getByText("Configuration changed. Review", { exact: false })
    .waitFor();
  const first = JSON.parse(posts[0] ?? "null");
  assert.equal(first.expectedVersion, 1);
  assert.equal(first.projectId, ids.projectId);
  assert.equal(first.chosenProjectId, target);
  assert.equal(d.recordedCommand({ ...first, actor: "operator" }), undefined);
  await page
    .getByRole("button", { name: "Reload project configuration", exact: true })
    .click();
  await page
    .getByText("Conflicting imported task; task version 2.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Placement project", { exact: true }).inputValue(),
    target,
  );
  assert.equal(posts.length, 1, "refresh never submits or silently adopts");
  const stillStale = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  assert.equal((await stillStale).status(), 409);
  assert.deepEqual(
    posts,
    [posts[0], posts[0]],
    "loaded observations preserve the original dirty revision/key",
  );
  await page
    .getByRole("button", {
      name: "Review latest placement revision",
      exact: true,
    })
    .waitFor();
  await capture(page, "1366-placement-initial-conflict-loaded-revision");
  await page
    .getByRole("button", {
      name: "Review latest placement revision",
      exact: true,
    })
    .click();
  await page
    .getByText("Latest revision explicitly adopted; input retained.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByLabel("Placement project", { exact: true }).inputValue(),
    target,
  );
  assert.equal(
    posts.length,
    2,
    "explicit adoption prepares a new operation without submitting it",
  );
  const saved = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Record placement", exact: true })
    .click();
  const result = await saved;
  assert.equal(result.status(), 200);
  const second = JSON.parse(posts[2] ?? "null");
  assert.notEqual(second.key, first.key);
  assert.equal(second.expectedVersion, 2);
  assert.equal(second.projectId, ids.projectId);
  assert.equal(second.chosenProjectId, target);
  const receipt = await result.json();
  assert.equal(receipt.key, second.key);
  assert.equal(receipt.result.projectId, target);
  assert.equal(receipt.result.version, 3);
  await page
    .getByText("Recorded placement outcome", { exact: false })
    .waitFor();
  assert.equal(d.task(taskId).projectId, target);
  assert.equal(d.task(taskId).version, 3);
  assert.equal(f.service.githubSources().conflicts().length, 0);
  assert.equal(f.runtime.turns, 0);
  await capture(page, "1366-placement-adopted-revision-recorded");
});

test("profile configuration reload observes its current revision without replacing dirty input", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/app/profiles/${ids.profileId}/settings`);
  await page
    .getByLabel("Profile name", { exact: true })
    .fill("Retained profile edit");
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    name: "Observed profile name",
  });
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/operator/commands"))
      posts.push(request.postData() ?? "");
  });
  await page
    .getByRole("button", { name: "Reload profile configuration", exact: true })
    .click();
  await page.getByText("Current revision 2.", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("Profile name", { exact: true }).inputValue(),
    "Retained profile edit",
  );
  assert.equal(posts.length, 0, "configuration reload performs no command");
  const rejected = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert.equal((await rejected).status(), 409);
  await page
    .getByText("Configuration changed. Review", { exact: false })
    .waitFor();
  const original = JSON.parse(posts[0] ?? "null");
  assert.equal(
    original.expectedVersion,
    1,
    "reload must not adopt the dirty captured revision",
  );
  assert.equal(original.name, "Retained profile edit");
  await capture(page, "1366-profile-in-place-reload-retained-draft");
  await page
    .getByRole("button", {
      name: "Review latest profile revision",
      exact: true,
    })
    .click();
  await page
    .getByText("Latest revision explicitly adopted; input retained.", {
      exact: true,
    })
    .waitFor();
  const saved = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const adopted = JSON.parse(posts[1] ?? "null");
  assert.equal(adopted.expectedVersion, 2);
  assert.notEqual(adopted.key, original.key);
  assert.equal(adopted.name, "Retained profile edit");
  assert.equal(f.service.domain().profile(ids.profileId).version, 3);
  assert.equal(f.runtime.turns, 0);
});
test("new private input survives a detached receipt and old-session 401 after same-document reauthentication", async (_t, journey) => {
  for (const mode of ["receipt-expiry", "401-logout"] as const) {
    journey.restart();
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const ids = seedSettings(f),
      web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport:
        mode === "receipt-expiry"
          ? { width: 1366, height: 820 }
          : { width: 390, height: 844 },
    });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const posts: string[] = [],
      publicBodies: string[] = [],
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", async (r) => {
      if (r.url().includes("/api/operator/") && r.request().method() === "GET")
        publicBodies.push(await r.text().catch(() => ""));
    });
    await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
    await page.getByLabel("Replace instructions", { exact: true }).check();
    await page
      .getByLabel("New instructions", { exact: true })
      .fill("PRIVATE OLD DELAYED INPUT");
    let release!: () => void, committed!: () => void;
    const held = new Promise<void>((done) => {
      committed = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/operator/commands", async (route) => {
      posts.push(route.request().postData() ?? "");
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      publicBodies.push(await response.text());
      committed();
      await gate;
      if (mode === "401-logout")
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unauthenticated", message: "Sign in" },
          }),
        });
      else await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Save project", exact: true })
      .click();
    await held;
    assert.equal(f.service.domain().project(ids.projectId).version, 3);
    if (mode === "receipt-expiry") {
      f.advanceClock(61_000);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Password", { exact: true }).waitFor();
    await capture(
      page,
      `${mode === "receipt-expiry" ? "1366" : "390"}-${mode}-privacy-purged`,
    );
    await page.getByLabel("Password", { exact: true }).fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Project configuration", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Replace instructions", { exact: true })
        .isChecked(),
      false,
    );
    await page.getByLabel("Replace instructions", { exact: true }).check();
    await page
      .getByLabel("New instructions", { exact: true })
      .fill("PRIVATE NEW SESSION INPUT");
    assert.equal(posts.length, 1);
    const delivered = page.waitForResponse((r) =>
      r.url().endsWith("/api/operator/commands"),
    );
    release();
    await delivered;
    await page
      .getByRole("button", { name: "Save project", exact: true })
      .waitFor();
    assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Sign out", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await page.getByLabel("New instructions", { exact: true }).inputValue(),
      "PRIVATE NEW SESSION INPUT",
    );
    assert.equal(
      await page.getByLabel("New instructions", { exact: true }).isDisabled(),
      false,
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Reconcile exact submission",
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByText("Recorded. Latest observations", { exact: false })
        .count(),
      0,
    );
    assert.equal(posts.length, 1);
    assert.equal(page.url().includes("PRIVATE"), false);
    assert.ok(publicBodies.every((body) => !body.includes("PRIVATE")));
    assert.deepEqual(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
      { local: [], session: [] },
    );
    await capture(
      page,
      `${mode === "receipt-expiry" ? "1366" : "390"}-${mode}-new-private-owner`,
    );
    await page.unroute("**/api/operator/commands");
    // A current-session 401 still purges this new private input.
    f.advanceClock(61_000);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByLabel("Password", { exact: true }).fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Project configuration", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Replace instructions", { exact: true })
        .isChecked(),
      false,
    );
    assert.equal(posts.length, 1);
    assert.equal(f.runtime.turns, 0);
    assert.deepEqual(errors, []);
  }
});
test("aborted old configuration read preserves new input and a current logout 401 releases its pending control", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = seedSettings(f),
    web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  let posts = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) posts++;
  });
  await signIn(page, web, `/app/projects/${ids.projectId}/settings`);
  let release!: () => void, arrived!: () => void, completed!: () => void;
  const handled = new Promise<void>((done) => {
    completed = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const held = new Promise<void>((done) => {
    arrived = done;
  });
  const configurationPath = `**/api/operator/projects/${ids.projectId}/configuration`;
  await page.route(configurationPath, async (route) => {
    arrived();
    await gate;
    try {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unauthenticated", message: "Sign in" },
        }),
      });
    } finally {
      completed();
    }
  });
  await page
    .getByRole("button", { name: "Reload project configuration", exact: true })
    .click();
  await held;
  await page.route("**/api/operator/logout", async (route) => {
    await route.fetch();
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unauthenticated", message: "Sign in" },
      }),
    });
  });
  const oldReadFailure = page.waitForEvent("requestfailed", (request) =>
    request.url().endsWith(`/projects/${ids.projectId}/configuration`),
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  // Let only subsequent reads through while retaining the original handler's gate.
  await page.unroute(configurationPath);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Project configuration", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Sign out", exact: true })
      .isEnabled(),
    true,
  );
  await page.getByLabel("Replace instructions", { exact: true }).check();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE NEW READ OWNER");
  assert.match((await oldReadFailure).failure()?.errorText ?? "", /ABORTED/i);
  release();
  await handled;
  assert.equal(
    await page.getByLabel("New instructions", { exact: true }).inputValue(),
    "PRIVATE NEW READ OWNER",
  );
  assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
  assert.equal(posts, 0);
  assert.equal(f.runtime.turns, 0);
  assert.deepEqual(errors, []);
  await capture(page, "1366-aborted-old-read-new-private-owner");
});
