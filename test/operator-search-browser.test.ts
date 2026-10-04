import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
const test = browserSuite("ui04-search");
test("shared Search preserves exact historical target, dates, selected focus and both navigation origins across Back/Forward, failures and phone entry", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Alpha", "Shared command"),
    b = await seedReviewTask(f, "Beta", "Shared command");
  const r = a.result("Shared command R2 original", {
    sourceId: a.source.sourceId,
    decisions: [{ text: "Shared command decision", attribution: "Task lead" }],
  });
  a.result("Shared command R3 current", { sourceId: a.source.sourceId });
  b.result("Shared command Beta");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks?view=board&q=Shared`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Shared command");
  await page.getByLabel("Include historical records").check();
  await page.getByLabel("Record type", { exact: true }).selectOption("result");
  const now = new Date(),
    day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await page.getByLabel("From date", { exact: true }).fill(day);
  await page.getByLabel("Through date", { exact: true }).fill(day);
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  const searchURL = page.url();
  assert.ok(await page.getByText(/Alpha · result/).count());
  assert.ok(await page.getByText(/Beta · result/).count());
  const desktopBounds = await page
    .locator(
      '.search-workspace select, .search-workspace input[type="date"], .search-matches a',
    )
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    desktopBounds.every((h) => h >= 36),
    JSON.stringify(desktopBounds),
  );
  await captureBrowserEvidence(page, "1366-cross-project-search");
  await page.locator(`[data-search-record="${r.resultId}"] a`).click();
  await page.getByText("Shared command R2 original", { exact: true }).waitFor();
  assert.ok(page.url().includes(`result=${r.resultId}`));
  await page
    .getByRole("button", { name: "Back to originating view", exact: true })
    .click();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  assert.equal(page.url(), searchURL);
  assert.equal(
    await page.getByLabel("From date", { exact: true }).inputValue(),
    day,
  );
  assert.equal(
    await page.getByLabel("Through date", { exact: true }).inputValue(),
    day,
  );
  assert.equal(
    await page.getByLabel("Record type", { exact: true }).inputValue(),
    "result",
  );
  assert.equal(
    await page
      .locator(`[data-search-record="${r.resultId}"] a`)
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Absent record");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.getByText(/No permitted retained match/).waitFor();
  await page.goBack();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "Shared command",
  );
  await page.goForward();
  await page.getByText(/No permitted retained match/).waitFor();
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "Absent record",
  );
  await page.goBack();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  await page.route("**/api/operator/search?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await page.getByText(/Last successful matches retained/).waitFor();
  assert.equal(
    await page.locator(`[data-search-record="${r.resultId}"]`).count(),
    1,
  );
  await page.unroute("**/api/operator/search?*");
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  assert.ok(page.url().includes("/app/tasks?view=board&q=Shared"));
  await page.goto(`${web.origin}/app/projects/${b.projectId}`);
  await page.getByRole("heading", { name: "Beta", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Projects and navigation", exact: true })
    .click();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Shared command");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator("[data-search-record]").first().waitFor();
  const phoneBounds = await page
    .locator(
      '.search-workspace select, .search-workspace input[type="date"], .search-matches a',
    )
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    phoneBounds.every((h) => h >= 44),
    JSON.stringify(phoneBounds),
  );
  await captureBrowserEvidence(page, "390-shared-search");
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  assert.ok(page.url().endsWith(`/app/projects/${b.projectId}`));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Shared command");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator("[data-search-record]").first().waitFor();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r));
  await page.route("**/api/operator/search?*", async (route) => {
    const response = await route.fetch();
    entered();
    await barrier;
    await route
      .fulfill({ response })
      .catch((error) =>
        assert.match(String(error), /already handled|Target.*closed/),
      );
  });
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await entry;
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  assert.equal(new URL(page.url()).search, "");
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .waitFor();
  release();
  await page.unroute("**/api/operator/search?*");
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "",
  );
  assert.equal(await page.locator("[data-search-record]").count(), 0);
  for (let i = 0; i < 3; i++) {
    await page.goBack();
    if (new URL(page.url()).pathname === "/app/search") {
      await page
        .getByLabel("Search retained task, decision and result records")
        .waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        await page
          .getByLabel("Search retained task, decision and result records")
          .inputValue(),
        "",
      );
    }
  }
  await page
    .goForward({ waitUntil: "commit" })
    .catch((error) => assert.match(String(error), /ERR_ABORTED/));
  if (new URL(page.url()).pathname === "/app/search")
    assert.equal(new URL(page.url()).search, "");
  for (const unknown of [false, true]) {
    await page
      .getByRole("link", { name: "Search", exact: true })
      .evaluate((el) => (el as HTMLElement).click());
    await page
      .getByLabel("Search retained task, decision and result records")
      .fill("Shared command");
    await page
      .getByRole("button", { name: "Search records", exact: true })
      .click();
    await page.locator("[data-search-record]").first().waitFor();
    let releaseLate!: () => void, enterLate!: () => void;
    const lateBarrier = new Promise<void>((r) => (releaseLate = r)),
      lateEntry = new Promise<void>((r) => (enterLate = r));
    await page.route("**/api/operator/search?*", async (route) => {
      const response = await route.fetch();
      enterLate();
      await lateBarrier;
      await route
        .fulfill({ response })
        .catch((error) =>
          assert.match(String(error), /already handled|Target.*closed/),
        );
    });
    await page
      .getByRole("button", { name: "Refresh results", exact: true })
      .click();
    await lateEntry;
    if (unknown)
      await page.route("**/api/operator/logout", async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Password").waitFor();
    assert.equal(new URL(page.url()).search, "");
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByLabel("Search retained task, decision and result records")
      .waitFor();
    releaseLate();
    await page.unroute("**/api/operator/search?*");
    await page.unroute("**/api/operator/logout");
    assert.equal(
      await page
        .getByLabel("Search retained task, decision and result records")
        .inputValue(),
      "",
    );
    assert.equal(await page.locator("[data-search-record]").count(), 0);
    await page.goBack();
    if (new URL(page.url()).pathname === "/app/search") {
      await page
        .getByLabel("Search retained task, decision and result records")
        .waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        await page
          .getByLabel("Search retained task, decision and result records")
          .inputValue(),
        "",
      );
    }
    await page
      .goForward({ waitUntil: "commit" })
      .catch((error) => assert.match(String(error), /ERR_ABORTED/));
    if (new URL(page.url()).pathname === "/app/search")
      assert.equal(new URL(page.url()).search, "");
  }
});
