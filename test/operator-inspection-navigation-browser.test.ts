import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui11-inspection-navigation");

test("inspection sections are reached from task origins and exact direct links without substitution", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await seedReviewTask(f, "Navigation", "Navigable inspection");
  const result = task.result("Navigable inspection result", {
    sourceId: task.source.sourceId,
  });
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "notes.md"), "navigation notes\n");

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const files = page.locator("#files");

  // Board origin → task → Files → back restores the board and its filter.
  await page.goto(`${web.origin}/app/tasks?view=board&q=Navigable`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  const boardURL = page.url();
  await page
    .getByRole("link", { name: /Navigable inspection/ })
    .first()
    .click();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await files.getByRole("button", { name: /notes\.md/ }).click();
  await files.getByText("navigation notes", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Back to originating view", exact: true })
    .click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(page.url(), boardURL);

  // Search origin → exact historical result → Files → back keeps the query.
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Navigable inspection result");
  await page.getByLabel("Include historical records").check();
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator(`[data-search-record="${result.resultId}"]`).waitFor();
  const searchURL = page.url();
  await page.locator(`[data-search-record="${result.resultId}"] a`).click();
  await page
    .getByText("Navigable inspection result", { exact: true })
    .waitFor();
  assert.ok(page.url().includes(`result=${result.resultId}`));
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await files.getByRole("button", { name: /notes\.md/ }).click();
  await files.getByText("navigation notes", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Back to originating view", exact: true })
    .click();
  await page.locator(`[data-search-record="${result.resultId}"]`).waitFor();
  assert.equal(page.url(), searchURL);
  await captureBrowserEvidence(page, "1366-search-return-after-files");

  // Exact direct links resolve their context; missing material is explained.
  const base = `${web.origin}/app/tasks/${task.taskId}`;
  await page.goto(`${base}?section=files&path=notes.md`);
  await files.getByText("navigation notes", { exact: true }).waitFor();
  await page.goto(`${base}?section=files&path=/notes.md`);
  await files
    .getByText("The linked file path is not valid, so no file was opened.")
    .waitFor();
  assert.equal(await files.getByText("navigation notes").count(), 0);
  await page.goto(`${base}?section=files&path=missing.md`);
  await files.getByText(/Preview is (missing|unavailable)/).waitFor();
  assert.equal(await files.getByText("navigation notes").count(), 0);
  await page.goto(`${base}?section=changes&target=last-turn`);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Comparison target"]',
      )?.value === "last-turn",
  );
  await page.goto(`${base}?section=local-review&review=${randomUUID()}`);
  await page
    .locator("#local-review")
    .getByText(/This sent review is unavailable or not authorised/)
    .waitFor();

  // Phone entry keeps the same task-scoped inspection.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?section=files&path=notes.md`);
  await files.getByText("navigation notes", { exact: true }).waitFor();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
  );
  await captureBrowserEvidence(page, "390-direct-file-link", {
    fullPage: false,
  });

  assert.equal(f.service.taskHold(task.taskId), undefined);
  assert.deepEqual(pageErrors, []);
});

test("overview, project list and inbox origins return correctly from Files", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await seedReviewTask(f, "Origin project", "Origin inspection");
  const question = await seedOwnQuestion(f);
  for (const taskId of [task.taskId, question.taskId]) {
    const workspace = await f.service.taskWorkspace(taskId);
    assert.ok(workspace);
    await writeFile(join(workspace.path, "notes.md"), "origin notes\n");
  }

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const files = page.locator("#files");
  const inspectAndReturn = async () => {
    await page.getByRole("link", { name: "Files", exact: true }).click();
    await files.getByRole("button", { name: /notes\.md/ }).click();
    await files.getByText("origin notes", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Back to originating view", exact: true })
      .click();
  };

  // Overview → task → Files → back.
  await page.goto(`${web.origin}/app`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const overviewURL = page.url();
  await page
    .getByRole("link", { name: /Origin inspection/ })
    .first()
    .click();
  await inspectAndReturn();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  assert.equal(page.url(), overviewURL);

  // Project list → task → Files → back.
  const projectURL = `${web.origin}/app/projects/${task.projectId}`;
  await page.goto(projectURL);
  await page
    .getByRole("link", { name: /Origin inspection/ })
    .first()
    .click();
  await inspectAndReturn();
  await page
    .getByRole("link", { name: /Origin inspection/ })
    .first()
    .waitFor();
  assert.equal(page.url(), projectURL);

  // Inbox request → task evidence → Files → back to that request, not a task list.
  const interactionId = f.service.coordinationView().readTask(question.taskId)
    .questions[0]?.interactionId;
  assert.ok(interactionId);
  await page.goto(`${web.origin}/app/inbox`);
  await page.locator(`[data-record-id="${interactionId}"]`).click();
  await page.getByRole("link", { name: "Task evidence", exact: true }).click();
  await inspectAndReturn();
  await page.getByRole("region", { name: "Selected request" }).waitFor();
  assert.ok(page.url().includes("/app/inbox"));
  assert.ok(page.url().includes(interactionId));

  assert.equal(f.service.taskHold(task.taskId), undefined);
  assert.deepEqual(pageErrors, []);
});
