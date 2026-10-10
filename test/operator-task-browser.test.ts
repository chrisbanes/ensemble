import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui03");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import {
  openMoreFilters,
  seedCatalog,
  until,
} from "./fixtures/operator-work.js";
async function screenshot(page: Page, name: string) {
  return captureBrowserEvidence(page, name);
}
// Optional composer sections start collapsed; their fields stay mounted.
async function expandComposer(page: Page) {
  const closed = page.locator(".composer-disclosure:not([open]) > summary");
  while ((await closed.count()) > 0) await closed.first().click();
}
async function signIn(
  page: Page,
  origin: string,
  password: string,
  path = "/app/tasks",
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}
test("List and Board preserve identical filtered task IDs and never submit commands", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Readable project",
    leadProfileId: null,
  });
  const ids = [randomUUID(), randomUUID()];
  for (const [i, taskId] of ids.entries())
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title: i ? "Other task" : "Literal <script>malicious()</script>",
      outcome: "Work",
      ready: false,
    });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts++;
  });
  await openMoreFilters(page);
  await page.getByLabel("Search tasks").fill("Literal");
  const links = () =>
    page.locator("[data-task-id]").evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute("data-task-id"),
        href: e.querySelector("a")?.getAttribute("href"),
      })),
    );
  const list = await links();
  assert.deepEqual(list, [{ id: ids[0], href: `/app/tasks/${ids[0]}` }]);
  const rowGeometry = await page
    .locator(`[data-task-id="${ids[0]}"]`)
    .evaluate((el) => ({
      display: getComputedStyle(el).display,
      height: el.getBoundingClientRect().height,
    }));
  assert.equal(rowGeometry.display, "grid");
  assert.ok(
    rowGeometry.height <= 220,
    `desktop task row is ${rowGeometry.height}px`,
  );
  const taskTitleType = await page
    .locator(`[data-task-id="${ids[0]}"] .task-title`)
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        decoration: style.textDecorationLine,
      };
    });
  assert.deepEqual(taskTitleType, {
    fontSize: "14px",
    fontWeight: "600",
    decoration: "underline",
  });
  const beforeSwitch = await Promise.all(
    ["List", "Board"].map((name) =>
      page.getByRole("button", { name, exact: true }).evaluate((el) => ({
        pressed: el.getAttribute("aria-pressed"),
        background: getComputedStyle(el).backgroundColor,
      })),
    ),
  );
  assert.equal(beforeSwitch[0]?.pressed, "true");
  assert.equal(beforeSwitch[1]?.pressed, "false");
  assert.notEqual(beforeSwitch[0]?.background, beforeSwitch[1]?.background);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.deepEqual(await links(), list);
  assert.ok(page.url().includes("q=Literal"));
  await page.reload();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Search tasks").inputValue(), "Literal");
  assert.deepEqual(await links(), list);
  await page.getByRole("button", { name: "Paused · 1", exact: true }).click();
  const boardScroll = await page
    .locator(".board-columns")
    .evaluate((el) => el.scrollLeft);
  await page.locator(`[data-task-id="${ids[0]}"] .task-title`).click();
  await page
    .getByRole("heading", { name: "Evidence review", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Back to originating view", exact: true })
    .click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Paused · 1", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page.locator(".board-columns").evaluate((el) => el.scrollLeft),
    boardScroll,
  );
  assert.equal(
    await page
      .locator(`[data-task-id="${ids[0]}"] .task-title`)
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await screenshot(page, "1366-filtered-board");
  assert.equal(posts, 0);
});

test("Save draft and Create and start record real task outcomes without claiming running", async (_t, journey) => {
  let routeCalls = 0;
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      {
        async choose() {
          routeCalls++;
          throw Error("Explicit assignment must bypass routing");
        },
      },
      undefined,
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
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    workerId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Explicit lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Paused project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: workerId,
    name: "Permitted worker",
    instructions: "build",
    capabilities: "code",
  });
  d.execute({
    type: "routing.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "choose",
    candidateProfileIds: [workerId],
    credentialRef: "env:FIXTURE_ROUTING_UNUSED",
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Open blocker",
    outcome: "Finish",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page.getByLabel("Task title").fill("Saved outcome");
  await page.getByLabel("Desired outcome").fill("Ship a useful result");
  await expandComposer(page);
  await page.getByLabel("Optional context").fill("Review supplied evidence");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await page.getByLabel("Assignee").selectOption(workerId);
  await page.getByLabel("Open blocker", { exact: true }).check();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByText("Draft task saved in Ensemble.", { exact: true })
    .waitFor();
  const draft = d.tasks(projectId).find((t) => t.title === "Saved outcome");
  assert.ok(draft);
  assert.equal(draft.ready, 0);
  assert.equal(d.assignments(String(draft.id)).length, 1);
  assert.deepEqual(d.dependencies(String(draft.id)), [blocker]);
  assert.equal(f.runtime.turns, 0);
  assert.equal(
    draft.outcome,
    "Ship a useful result\n\nContext:\nReview supplied evidence\n\nReference links (passive context; no repository access):\nhttps://example.com/one\nhttps://example.com/two",
  );
  await screenshot(page, "1366-confirmed-draft");
  await page.goto(`${web.origin}/app/tasks/new?project=${projectId}`);
  await page.getByLabel("Task title").fill("Ready dependent");
  await page.getByLabel("Desired outcome").fill("Ship after blocker");
  await expandComposer(page);
  await page.getByLabel("Assignee").selectOption(workerId);
  await page.getByLabel("Open blocker", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByText(
      "Task recorded as Ready. Creation does not establish execution.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    d.tasks(projectId).find((t) => t.title === "Ready dependent")?.ready,
    1,
  );
  assert.equal(f.runtime.turns, 0);
  await page
    .getByText("Waiting on a task dependency", { exact: true })
    .waitFor();
  await screenshot(page, "1366-confirmed-ready-held");
  const dependent = d
    .tasks(projectId)
    .find((t) => t.title === "Ready dependent");
  assert.ok(dependent);
  await f.service.provisionTask(String(dependent.id));
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  assert.equal(f.runtime.turns, 0);
  d.execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    expectedVersion: 1,
    state: "done",
  });
  await until(() => f.runtime.turns === 1);
  const deadline = Date.now() + 5000;
  while (
    (
      await new OperatorApi(f.service, [f.directory]).readTask(
        String(dependent.id),
      )
    ).data.execution.state !== "running"
  ) {
    if (Date.now() > deadline)
      throw Error("Actual execution did not become running");
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(routeCalls, 0);
  assert.equal(d.assignments(String(dependent.id))[0]?.profileId, workerId);
  await page
    .getByRole("button", { name: "Refresh execution", exact: true })
    .click();
  await page.getByText("running", { exact: true }).waitFor();
  await screenshot(page, "1366-confirmed-ready-running");
});

test("composer disclosures keep supplied values and open the section of each validation error", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    leadId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: leadId,
    name: "Disclosure lead",
    instructions: "build",
    capabilities: "code",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Disclosure project",
    leadProfileId: leadId,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Disclosure blocker",
    outcome: "Finish",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let commandWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      commandWrites++;
  });
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  const sections = page.locator(".composer-disclosure");
  const summaries = () =>
    sections.evaluateAll((all) =>
      all.map((section) => ({
        open: (section as HTMLDetailsElement).open,
        summary: section.querySelector("summary")?.textContent,
      })),
    );
  await page.getByLabel("Disclosure blocker").waitFor({ state: "attached" });
  assert.deepEqual(await summaries(), [
    { open: false, summary: "Optional contextNone" },
    { open: false, summary: "Reference linksNone" },
    { open: false, summary: "AssigneeDefault project lead allocation" },
    { open: false, summary: "DependenciesNone" },
  ]);
  await page.getByLabel("Task title").fill("Disclosed outcome");
  await page.getByLabel("Desired outcome").fill("Ship a useful result");
  await expandComposer(page);
  await page.getByLabel("Optional context").fill("Review supplied evidence");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await page.getByLabel("Assignee").selectOption(leadId);
  await page.getByLabel("Disclosure blocker", { exact: true }).check();
  const collapse = async () => {
    const open = page.locator(".composer-disclosure[open] > summary");
    while ((await open.count()) > 0) await open.first().click();
  };
  await collapse();
  const supplied = [
    { open: false, summary: "Optional context24 characters" },
    { open: false, summary: "Reference links2 links" },
    { open: false, summary: "AssigneeDisclosure lead" },
    { open: false, summary: "Dependencies1 selected" },
  ];
  assert.deepEqual(await summaries(), supplied);
  assert.equal(
    await page.getByLabel("Optional context").inputValue(),
    "Review supplied evidence",
  );
  assert.equal(await page.getByLabel("Assignee").inputValue(), leadId);
  assert.equal(
    await page.getByLabel("Disclosure blocker", { exact: true }).isChecked(),
    true,
  );
  await screenshot(page, "390-composer-collapsed-summaries");

  // An invalid link opens its section and focuses the field without a command.
  await expandComposer(page);
  await page.getByLabel("Reference links").fill("not a link");
  await collapse();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-links",
  );
  assert.equal((await summaries())[1]?.open, true);
  assert.equal(commandWrites, 0);
  await screenshot(page, "390-composer-link-error-expanded");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await collapse();

  // A stored assignee that is no longer permitted fails before submission.
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: leadId,
    expectedVersion: 1,
    revoked: true,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  await page.getByLabel("Disclosure blocker").waitFor({ state: "attached" });
  assert.equal(
    (await summaries())[2]?.summary,
    "AssigneeSelected assignee unavailable",
  );
  // Fresh options reveal the problem before submission; both actions stay enabled.
  await page
    .getByText("Choose a currently permitted assignee.", { exact: true })
    .waitFor();
  assert.equal((await summaries())[2]?.open, true);
  for (const name of ["Create and start", "Save draft"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isEnabled(),
      true,
    );
  assert.equal(commandWrites, 0);
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-profileId",
  );
  assert.equal((await summaries())[2]?.open, true);
  await page
    .getByText("Choose a currently permitted assignee.", { exact: true })
    .waitFor();
  assert.equal(commandWrites, 0);
  assert.equal(
    d.tasks(projectId).some((t) => t.title === "Disclosed outcome"),
    false,
  );
});

test("browser frozen storage failure sends zero commands and restores only last saved input", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Storage project",
    leadProfileId: null,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page.getByLabel("Task title", { exact: true }).fill("Last saved input");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Finish the work");
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) posts++;
  });
  const saved = await page.evaluate(() =>
    sessionStorage.getItem("ensemble.ui03.composer.v1"),
  );
  assert.ok(saved);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "ensemble.ui03.composer.v1")
        throw new DOMException("Fixture quota", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Newer unsaved input");
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.getByText(/Submission not sent/).waitFor();
  assert.equal(posts, 0);
  assert.equal(d.tasks(projectId).length, 0);
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Newer unsaved input",
  );
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    ),
    saved,
  );
  await screenshot(page, "390-storage-unavailable-current-input");
  await page.reload();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Last saved input",
  );
  assert.equal(posts, 0);
  await screenshot(page, "390-restored-last-saved-input");
});
test("committed lost-response creation survives reload expiry and exact reconciliation; failed read retains receipt", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Chosen agent",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Recovery project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Recovery blocker",
    outcome: "First",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page
    .getByLabel("Task title", { exact: true })
    .fill("One uncertain creation");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Finish exactly once");
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(profileId);
  await page.getByLabel("Recovery blocker", { exact: true }).check();
  const sent: string[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    sent.push(route.request().postData() ?? "");
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reconcile submission", exact: true })
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(d.tasks(projectId).length, 2);
  const material = JSON.parse(sent[0] ?? "{}");
  assert.equal(d.assignments(material.taskId).length, 1);
  await screenshot(page, "1366-unknown-submission");
  await page.reload();
  await page
    .getByRole("button", { name: "Reconcile submission", exact: true })
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).isEnabled(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Create and start", exact: true })
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
      sent.push(route.request().postData() ?? "");
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code, message: "Safe failure" } }),
      });
    });
    await page
      .getByRole("button", { name: "Reconcile submission", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reconcile submission", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).isDisabled(),
      true,
    );
    await page.unroute("**/api/operator/commands");
  }
  await page.route("**/api/operator/commands", async (route) => {
    sent.push(route.request().postData() ?? "");
    await route.continue();
  });
  f.advanceClock(70000);
  await page
    .getByRole("button", { name: "Reconcile submission", exact: true })
    .click();
  await page.getByLabel("Password").waitFor();
  assert.equal(
    await page.getByText("One uncertain creation", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Reconcile submission", exact: true })
    .waitFor();
  await page.route(`**/api/operator/tasks/${material.taskId}`, (route) =>
    route.abort("failed"),
  );
  await page
    .getByRole("button", { name: "Reconcile submission", exact: true })
    .click();
  await page
    .getByText(
      "Task recorded as Ready. Creation does not establish execution.",
      { exact: true },
    )
    .waitFor();
  await page.getByText(/original creation receipt remains confirmed/).waitFor();
  assert.equal(sent.length, 6);
  assert.ok(sent.every((bytes) => bytes === sent[0]));
  assert.equal(d.tasks(projectId).length, 2);
  assert.equal(d.assignments(material.taskId).length, 1);
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    ),
    null,
  );
  await screenshot(page, "1366-recorded-receipt-read-failed");
});

import { OperatorApi } from "../src/standalone/operator-api.js";
async function visibleControl(page: Page, name: string) {
  const control = page.getByRole("button", { name, exact: true });
  await control.scrollIntoViewIfNeeded();
  assert.ok(
    await control.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return (
        r.width > 0 &&
        r.height > 0 &&
        x >= 0 &&
        x < innerWidth &&
        y >= 0 &&
        y < innerHeight &&
        el.contains(document.elementFromPoint(x, y))
      );
    }),
    `${name} is visible and unobscured`,
  );
}
test("populated task List and Board keep the approved hierarchy at responsive widths", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedCatalog(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  let commandPosts = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/operator/commands") &&
      request.method() === "POST"
    )
      commandPosts++;
  });

  const widths = [390, 759, 760, 800, 1024, 1119, 1120, 1121, 1366];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    assert.ok(
      overflow.document <= overflow.viewport,
      `${width}px List has no horizontal page overflow`,
    );
    const listIds = await page
      .locator(".task-list [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      );
    assert.ok(listIds.includes(ids.importedId));
    assert.ok(listIds.includes(ids.question.id));

    const importedRow = page.locator(
      `.task-list [data-task-id="${ids.importedId}"]`,
    );
    const titleMetrics = await importedRow
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          text: element.textContent?.trim(),
        };
      });
    assert.equal(titleMetrics.text, ids.importedTitle, `${width}px title text`);
    assert.ok(
      titleMetrics.width >= 200,
      `${width}px title has readable width (${titleMetrics.width}px)`,
    );
    assert.ok(
      titleMetrics.scrollWidth <= titleMetrics.clientWidth,
      `${width}px long title wraps inside its link`,
    );
    const importedMetadata = await importedRow
      .locator(".task-project-metadata")
      .innerText();
    assert.match(importedMetadata, /Service integration/);
    assert.match(importedMetadata, /fixture\/source#42/);
    assert.equal(
      await importedRow.locator(".task-lead").innerText(),
      "Accountable lead · lead",
    );
    assert.equal(await importedRow.locator(".task-source-state").count(), 0);
    const questionRow = page.locator(
      `.task-list [data-task-id="${ids.question.id}"]`,
    );
    assert.match(
      await questionRow.locator(".task-status").innerText(),
      /Running/,
    );
    await questionRow
      .getByText("Question needs an answer", { exact: true })
      .waitFor({ state: "visible" });
    await questionRow
      .getByText("Accountable lead · lead", { exact: true })
      .waitFor({ state: "visible" });
    const rowOverflow = await page
      .locator(".task-list .task-row")
      .evaluateAll((rows) =>
        rows
          .map((row) => ({
            title: row.querySelector<HTMLElement>(".task-title"),
            rowWidth: row.clientWidth,
            rowScrollWidth: row.scrollWidth,
          }))
          .filter(
            (item) =>
              !item.title ||
              item.rowScrollWidth > item.rowWidth ||
              item.title.scrollWidth > item.title.clientWidth,
          ),
      );
    assert.deepEqual(rowOverflow, [], `${width}px task rows do not clip`);
    if ([390, 760, 800, 1121, 1366].includes(width))
      await screenshot(page, `${width}-responsive-list`);

    await page.getByRole("button", { name: "Board", exact: true }).click();
    const boardIds = await page
      .locator(".board-columns [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      );
    assert.deepEqual(boardIds, listIds, `${width}px List and Board task IDs`);
    assert.equal(
      await page
        .locator(`.board-columns [data-task-id="${ids.question.id}"]`)
        .evaluate((element) =>
          element
            .closest<HTMLElement>(".board-column")
            ?.getAttribute("aria-label"),
        ),
      "Running tasks",
      `${width}px preserves state-derived Board grouping`,
    );
    assert.equal(
      await page
        .locator(
          `.board-columns [data-task-id="${ids.importedId}"] .task-title`,
        )
        .textContent(),
      ids.importedTitle,
      `${width}px Board keeps long source title`,
    );
    const boardOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    assert.equal(boardOverflow, false, `${width}px Board has no page overflow`);
    if ([390, 760, 800, 1121, 1366].includes(width))
      await screenshot(page, `${width}-responsive-board`);
    await page.getByRole("button", { name: "List", exact: true }).click();
  }

  await page.setViewportSize({ width: 800, height: 768 });
  await page.goto(`${web.origin}/app/tasks?state=all`);
  await page
    .locator(`.task-list [data-task-id="${ids.paused}"]`)
    .waitFor({ state: "visible" });
  const crossProjectIds = await page
    .locator(".task-list [data-task-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")).sort(),
    );
  const expectedProjectIds = f.service
    .domain()
    .tasks(ids.projectId)
    .map((task) => task.id)
    .sort();
  assert.ok(crossProjectIds.includes(ids.paused));
  assert.ok(
    expectedProjectIds.length < crossProjectIds.length,
    `all-project List has ${crossProjectIds.length} rows; project filter has ${expectedProjectIds.length}`,
  );
  await page.getByLabel("Project", { exact: true }).selectOption(ids.projectId);
  await page.waitForURL(
    (url) => url.searchParams.get("project") === ids.projectId,
  );
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".task-list [data-task-id]").length === count,
    expectedProjectIds.length,
  );
  const filteredListIds = await page
    .locator(".task-list [data-task-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")).sort(),
    );
  assert.deepEqual(filteredListIds, expectedProjectIds);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.deepEqual(
    await page
      .locator(".board-columns [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      ),
    expectedProjectIds,
    "project filter selects the same tasks in Board",
  );
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === null);
  await page
    .locator(`.task-list [data-task-id="${ids.importedId}"] .task-title`)
    .click();
  await page
    .getByRole("heading", { name: "Evidence review", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Back to originating view", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("project"), ids.projectId);
  assert.deepEqual(
    await page
      .locator(".task-list [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      ),
    expectedProjectIds,
    "task return restores the selected project and task IDs",
  );
  assert.equal(commandPosts, 0);
});

for (const viewport of [
  { width: 1366, height: 820 },
  { width: 390, height: 844 },
  { width: 683, height: 410 },
])
  test(`UI03 critical journeys remain usable at laptop phone and scaled layout ${viewport.width}`, async (_t, journey) => {
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
    const context = await browser.newContext({
        viewport,
        deviceScaleFactor: viewport.width === 683 ? 2 : 1,
      }),
      page = await context.newPage();
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      external: string[] = [],
      violations: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(web.origin)) external.push(r.url());
    });
    page.on("console", (m) => {
      if (m.text().includes("Content Security Policy"))
        violations.push(m.text());
    });
    assert.equal(
      (
        await context.request.get(`${web.origin}/api/operator/task-list`)
      ).status(),
      401,
    );
    assert.equal(
      (
        await context.request.get(
          web.origin +
            `/api/operator/projects/${randomUUID()}/composer-options`,
        )
      ).status(),
      401,
    );
    await signIn(page, web.origin, web.password);
    await page
      .getByText("Create a project in existing operator controls to begin.", {
        exact: true,
      })
      .waitFor();
    await screenshot(page, `${viewport.width}-no-projects`);
    const ids = await seedCatalog(f);
    const emptyProject = randomUUID();
    f.service.domain().execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId: emptyProject,
      name: "Ready for first task",
      leadProfileId: null,
    });
    const emptyRead = page.waitForResponse(
      (response) =>
        response.url() === `${web.origin}/api/operator/task-list` &&
        response.request().method() === "GET",
    );
    await page.goto(`${web.origin}/app/projects/${emptyProject}`);
    assert.equal(
      (await emptyRead).status(),
      200,
      "exact task catalog read for empty-project route succeeds",
    );
    await page
      .getByText(
        "Ready for your first task. Create an outcome or save a draft.",
        { exact: true },
      )
      .waitFor();
    await screenshot(page, `${viewport.width}-empty-project`);
    await page.goto(`${web.origin}/app`);
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    const attention = page.getByRole("region", {
        name: "Needs your attention",
        exact: true,
      }),
      work = page.getByRole("region", {
        name: "Across your projects",
        exact: true,
      });
    await attention.locator(".work-request").first().waitFor();
    assert.equal(
      await attention
        .getByText("Normal Stop observation", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await work
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await attention
        .getByText("Stop with uncertain ownership", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await attention
        .getByText("Question requiring action", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await work
        .getByRole("link", { name: "Ready but dependent", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await work
        .locator(`[data-task-id="${ids.running.id}"]`)
        .getByText(/Capacity currently full/)
        .count(),
      1,
      "occupied project limit preserves eligible Ready work in its real capacity queue",
    );
    await screenshot(page, `${viewport.width}-overview-attention-work`);
    let commandPosts = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/operator/commands") && r.method() === "POST")
        commandPosts++;
    });
    await page.getByRole("link", { name: "View inbox", exact: true }).click();
    assert.equal(
      await page
        .getByRole("link", {
          name: "Advanced coordination controls",
          exact: true,
        })
        .getAttribute("href"),
      "/coordination",
    );
    await page.goto(`${web.origin}/app/tasks`);
    await page
      .locator(`[data-task-id="${ids.question.id}"]`)
      .getByText("Question needs an answer", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(`[data-task-id="${ids.uncertainStop.id}"]`)
        .getByText("Execution ownership is uncertain", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator(`[data-task-id="${ids.normal.id}"]`)
        .getByText("Execution ownership is uncertain", { exact: true })
        .count(),
      0,
    );
    await screenshot(page, `${viewport.width}-list-interventions`);
    await page.goto(`${web.origin}/app/tasks?view=board&state=all`);
    await page
      .getByRole("heading", { name: "All tasks", exact: true })
      .waitFor();
    const samples: Record<string, string> = {
      Stopping: "Normal Stop observation",
      Uncertain: "Uncertain execution",
      Running: "Work running normally",
      Done: "Completed result",
      Cancelled: "Cancelled work",
      Paused: "Paused work",
      Draft: "Literal <script>malicious()</script>",
      Waiting: "Ready but dependent",
      Ready: "Ready selected",
    };
    for (const [column, title] of Object.entries(samples)) {
      const tab = page.getByRole("button", {
        name: new RegExp(`^${column} · `),
      });
      await tab.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("region", { name: `${column} tasks`, exact: true })
        .getByRole("link", { name: title, exact: true })
        .waitFor({ state: "visible" });
      if (column === "Running")
        await page
          .locator(`[data-task-id="${ids.question.id}"]`)
          .getByText("Question needs an answer", { exact: true })
          .waitFor({ state: "visible" });
      if (column === "Stopping")
        assert.equal(
          await page
            .locator(`[data-task-id="${ids.uncertainStop.id}"]`)
            .getByText("Execution ownership is uncertain", { exact: true })
            .count(),
          1,
        );
      if (column === "Done" || column === "Cancelled") {
        const terminal = page.getByRole("region", {
          name: `${column} tasks`,
          exact: true,
        });
        assert.equal(
          await terminal.getByText("Draft: not Ready", { exact: true }).count(),
          0,
        );
        assert.equal(
          await terminal.getByText(/Capacity currently full/).count(),
          0,
        );
      }
      await screenshot(page, `${viewport.width}-board-${column.toLowerCase()}`);
    }
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 1 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await page.getByRole("button", { name: /^Running · / }).click();
    await page
      .locator(`[data-task-id="${ids.running.id}"]`)
      .getByText("Capacity currently full; admission rechecks usage", {
        exact: true,
      })
      .waitFor({ state: "visible" });
    await screenshot(page, `${viewport.width}-board-actual-capacity-full`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page
      .locator(`[data-task-id="${ids.running.id}"]`)
      .getByText("Capacity currently full; admission rechecks usage", {
        exact: true,
      })
      .waitFor({ state: "visible" });
    await screenshot(page, `${viewport.width}-list-actual-capacity-full`);
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 10 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await page
      .locator(`[data-task-id="${ids.running.id}"]`)
      .getByText(/Capacity currently full/)
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: /^Waiting · / }).click();
    if (viewport.width < 760) {
      await visibleControl(page, "Previous column: Running");
      await page
        .getByRole("button", { name: "Previous column: Running", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: /^Running · / })
          .getAttribute("aria-pressed"),
        "true",
      );
      await visibleControl(page, "Next column: Waiting");
      await page
        .getByRole("button", { name: "Next column: Waiting", exact: true })
        .click();
    }
    await page.getByLabel("State", { exact: true }).selectOption("Stopping");
    await page.getByRole("button", { name: "List", exact: true }).click();
    const stopIds = await page
      .locator("[data-task-id]")
      .evaluateAll((es) =>
        es.map((e) => e.getAttribute("data-task-id")).sort(),
      );
    assert.deepEqual(stopIds, [ids.normal.id, ids.uncertainStop.id].sort());
    await page.getByRole("button", { name: "Board", exact: true }).click();
    if (viewport.width < 760)
      await page
        .getByRole("region", { name: "Stopping tasks", exact: true })
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .waitFor({ state: "visible" });
    assert.deepEqual(
      await page
        .locator("[data-task-id]")
        .evaluateAll((es) =>
          es.map((e) => e.getAttribute("data-task-id")).sort(),
        ),
      stopIds,
    );
    await page.reload();
    await page.getByLabel("State", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("State", { exact: true }).inputValue(),
      "Stopping",
    );
    await page.goBack();
    await page.goForward();
    assert.ok(page.url().includes("state=Stopping"));
    assert.equal(commandPosts, 0);
    await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
    await page
      .locator(`[data-task-id="${ids.question.id}"]`)
      .getByText("Question needs an answer", { exact: true })
      .waitFor();
    await page.goto(
      `${web.origin}/app/projects/${ids.projectId}?source=github`,
    );
    await page
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(`a[href="/app/projects/${ids.projectId}"]`)
        .first()
        .getAttribute("aria-current"),
      "page",
    );
    await page
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .click();
    assert.ok(page.url().endsWith(`/app/tasks/${ids.importedId}`));
    await page
      .getByRole("link", { name: "Runtime / Stop / Resume", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('input[name="title"],textarea[name="outcome"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: "Runtime / Stop / Resume",
          exact: true,
        })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: "Requests and coordination",
          exact: true,
        })
        .count(),
      1,
    );
    await page.goBack();
    await page
      .getByRole("heading", { name: "Service integration", exact: true })
      .waitFor();
    assert.ok(page.url().includes("source=github"));
    await page.goto(`${web.origin}/app/tasks`);
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    await page.route("**/api/operator/task-list", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unavailable", message: "Tasks unavailable" },
        }),
      }),
    );
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await page
      .getByText("Refresh failed. Showing the last fetched data.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      1,
    );
    await screenshot(page, `${viewport.width}-stale-tasks`);
    await page.reload();
    await page
      .getByText("Tasks are unavailable. Try again.", { exact: true })
      .waitFor();
    await screenshot(page, `${viewport.width}-error-tasks`);
    await page.unroute("**/api/operator/task-list");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    await openMoreFilters(page);
    await page
      .getByLabel("Search tasks", { exact: true })
      .fill("No matching outcome");
    await page
      .getByText("No tasks match these filters.", { exact: true })
      .waitFor();
    await screenshot(page, `${viewport.width}-no-match`);
    await page.goto(`${web.origin}/app/tasks/new?project=${ids.projectId}`);
    await page.getByText(/^Capacity: \d+\/10 project/).waitFor();
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 1 },
    });
    await page.reload();
    await page.getByText(/^Capacity: \d+\/1 project/).waitFor();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.waitForFunction(
      () => document.activeElement?.id === "composer-title",
    );
    await page
      .getByLabel("Task title", { exact: true })
      .fill("Long laptop and phone outcome");
    await page
      .getByLabel("Desired outcome", { exact: true })
      .fill("Detailed desired outcome.\n".repeat(180));
    await expandComposer(page);
    await page
      .getByLabel("Optional context", { exact: true })
      .fill("Supplied context remains readable.\n".repeat(90));
    await page
      .getByLabel("Reference links", { exact: true })
      .fill("https://example.com/passive-context");
    await page
      .getByLabel("Assignee", { exact: true })
      .selectOption(ids.profileId);
    await page.getByLabel("Open dependency", { exact: true }).check();
    await visibleControl(page, "Create and start");
    await visibleControl(page, "Save draft");
    await screenshot(page, `${viewport.width}-long-composer`);
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    if (viewport.width < 760) {
      // The composer is a nested screen: its phone header has Back, not the menu.
      assert.equal(
        await page
          .getByRole("button", { name: "Projects and navigation", exact: true })
          .count(),
        0,
      );
      assert.ok(
        (await page
          .getByRole("link", { name: /^Back to / })
          .first()
          .evaluate((el) => el.getBoundingClientRect().height)) >= 44,
      );
    }
    f.advanceClock(70000);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(violations, []);
    console.log(
      `UI03 ${viewport.width} browser ${browser.version()} evidence: ${journey.directory}; fixture ${f.directory} awaits teardown`,
    );
  });

test("composer switches scoped options despite delayed prior response and preserves input after revoked assignee", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    a = randomUUID(),
    b = randomUUID(),
    leadA = randomUUID(),
    leadB = randomUUID();
  for (const [projectId, profileId, name] of [
    [a, leadA, "First"],
    [b, leadB, "Second"],
  ] as const) {
    d.execute({
      type: "profile.create",
      key: randomUUID(),
      actor: "operator",
      profileId,
      name: `${name} lead`,
      instructions: "private",
      capabilities: "coordinate",
    });
    d.execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      name: `${name} project`,
      leadProfileId: profileId,
    });
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId: randomUUID(),
      title: `${name} dependency`,
      outcome: "Finish",
      ready: false,
    });
  }
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted!: () => void;
  const entered = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  let first = true;
  await page.route(
    `**/api/operator/projects/${a}/composer-options`,
    async (route) => {
      if (first) {
        first = false;
        const response = await route.fetch();
        intercepted();
        await held;
        try {
          await route.fulfill({ response });
        } catch {
          /* aborted obsolete read */
        }
      } else await route.continue();
    },
  );
  journey.cleanup(async () => release(), "pending-request.release");
  await signIn(page, web.origin, web.password, `/app/tasks/new?project=${a}`);
  await entered;
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Preserved outcome");
  await page.getByLabel("Desired outcome", { exact: true }).fill("Do the work");
  await page.getByLabel("Project", { exact: true }).selectOption(b);
  await page
    .getByLabel("Second dependency", { exact: true })
    .waitFor({ state: "attached" });
  release();
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(leadB);
  assert.equal(
    await page.getByLabel("First dependency", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Second dependency", { exact: true }).check();
  await page.getByLabel("Project", { exact: true }).selectOption(a);
  await page
    .getByLabel("First dependency", { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByLabel("Assignee", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("First dependency", { exact: true }).isChecked(),
    false,
  );
  await page
    .getByText(
      "Project changed. Assignee and dependency selections were cleared.",
      { exact: true },
    )
    .waitFor();
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(leadA);
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: leadA,
    expectedVersion: 1,
    revoked: true,
  });
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByText("Submission rejected (forbidden). Input retained.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Preserved outcome",
  );
  assert.equal(
    await page.getByLabel("Desired outcome", { exact: true }).inputValue(),
    "Do the work",
  );
  assert.equal(d.tasks(a).length, 1);
  assert.equal(f.runtime.turns, 0);
});
test("replacement composer owns recovery before a detached committed receipt or old-session 401 arrives", async (_t, journey) => {
  for (const mode of ["receipt-navigation", "401-expiry"] as const) {
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
    const d = f.service.domain(),
      projectId = randomUUID(),
      profileId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: "Delayed agent",
      instructions: "private",
      capabilities: "coordinate",
    });
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Delayed recovery project",
      leadProfileId: profileId,
    });
    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport:
        mode === "receipt-navigation"
          ? { width: 1366, height: 820 }
          : { width: 390, height: 844 },
    });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      sent: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(
      page,
      web.origin,
      web.password,
      `/app/tasks/new?project=${projectId}`,
    );
    await page
      .getByLabel("Task title", { exact: true })
      .fill("Delayed original creation");
    await page
      .getByLabel("Desired outcome", { exact: true })
      .fill("Finish exactly once");
    await expandComposer(page);
    await page.getByLabel("Assignee", { exact: true }).selectOption(profileId);
    let release!: () => void, committed!: () => void;
    const held = new Promise<void>((done) => {
      committed = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/operator/commands", async (route) => {
      sent.push(route.request().postData() ?? "");
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      committed();
      await gate;
      if (mode === "401-expiry")
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unauthenticated", message: "Sign in" },
          }),
        });
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await held;
    const recovery = await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    );
    assert.ok(recovery);
    const command = JSON.parse(sent[0] ?? "null");
    assert.equal(d.tasks(projectId).length, 1);
    assert.equal(d.assignments(command.taskId).length, 1);
    if (mode === "receipt-navigation") {
      await page
        .getByRole("link", { name: "Tasks", exact: true })
        .first()
        .click();
      await page.getByRole("link", { name: "New task", exact: true }).click();
    } else {
      f.advanceClock(61_000);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByLabel("Password", { exact: true }).fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Reconcile submission", exact: true })
      .waitFor();
    assert.equal(sent.length, 1);
    const delivered = page.waitForResponse((r) =>
      r.url().endsWith("/api/operator/commands"),
    );
    release();
    await delivered;
    await page
      .getByRole("button", { name: "Reconcile submission", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).inputValue(),
      "Delayed original creation",
    );
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("ensemble.ui03.composer.v1"),
      ),
      recovery,
    );
    assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
    assert.equal(sent.length, 1);
    await screenshot(
      page,
      `${mode === "receipt-navigation" ? "1366" : "390"}-${mode}-replacement-unknown`,
    );
    await page.unroute("**/api/operator/commands");
    page.on("request", (r) => {
      if (r.url().endsWith("/api/operator/commands"))
        sent.push(r.postData() ?? "");
    });
    await page
      .getByRole("button", { name: "Reconcile submission", exact: true })
      .click();
    await page
      .getByText("Draft task saved in Ensemble.", { exact: true })
      .waitFor();
    assert.deepEqual(sent, [sent[0], sent[0]]);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("ensemble.ui03.composer.v1"),
      ),
      null,
    );
    assert.equal(d.tasks(projectId).length, 1);
    assert.equal(d.assignments(command.taskId).length, 1);
    assert.equal(f.runtime.turns, 0);
    assert.deepEqual(errors, []);
    await screenshot(
      page,
      `${mode === "receipt-navigation" ? "1366" : "390"}-${mode}-reconciled`,
    );
  }
});
