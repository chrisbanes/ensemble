import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { signOutFromSidebar } from "./fixtures/operator-account.js";
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
    desktopBounds.every((h) => h >= 32),
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
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
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
  let documentReplacements = 0,
    lostEvaluationResponses = 0;
  const traversePrivateHistory = async (direction: "back" | "forward") => {
    // Observe the browser's actual traversal, including document replacement,
    // rather than depending on CDP history-command cancellation error strings.
    const previousDocument = await page.evaluate(() => performance.timeOrigin);
    const [navigation, evaluation] = await Promise.allSettled([
      page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 5000,
      }),
      page.evaluate((next) => history[next](), direction),
    ]);
    if (navigation.status === "rejected") throw navigation.reason;
    if (evaluation.status === "rejected") {
      assert.ok(evaluation.reason instanceof Error);
      assert.equal(
        evaluation.reason.message,
        "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
      );
    }
    const pathname = new URL(page.url()).pathname;
    assert.ok(
      ["/app/search", "/app/tasks", `/app/projects/${b.projectId}`].includes(
        pathname,
      ),
      `Unexpected history destination: ${pathname}`,
    );
    if (pathname === "/app/search") {
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
      assert.equal(await page.locator("[data-search-record]").count(), 0);
    } else {
      await page
        .getByRole("heading", {
          name: pathname === "/app/tasks" ? "All tasks" : "Beta",
          exact: true,
        })
        .waitFor();
    }
    const currentDocument = await page.evaluate(() => performance.timeOrigin);
    const replaced = currentDocument !== previousDocument;
    if (replaced) documentReplacements++;
    if (evaluation.status === "rejected") {
      assert.ok(
        replaced,
        "A lost evaluation response requires an observed replacement document",
      );
      lostEvaluationResponses++;
    }
    return pathname;
  };
  const privateHistory = [];
  for (let i = 0; i < 3; i++)
    privateHistory.push(await traversePrivateHistory("back"));
  const forwardDestination = await traversePrivateHistory("forward");
  assert.equal(forwardDestination, privateHistory[1]);
  assert.ok(
    documentReplacements > 0,
    "Private history journey must traverse an actual replacement document",
  );
  console.log(
    `private-history traversals=4 documentReplacements=${documentReplacements} lostEvaluationResponses=${lostEvaluationResponses}`,
  );
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
    await signOutFromSidebar(page);
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

test("same-task historical Search entries preserve manual origin selections and shared replies while fresh task links use latest", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Entry ownership", "Entry task");
  const old = a.result("Entry ancient result", { sourceId: a.source.sourceId });
  const d = f.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: Number(d.task(a.taskId).version),
    outcome: "- [ ] Entry newer source",
  });
  const source = f.service.taskReview().sources(a.taskId).at(-1)!;
  const manual = a.result("Entry manually selected result", {
    sourceId: source.sourceId,
  });
  const latest = a.result("Entry latest result", { sourceId: source.sourceId });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?result=${old.resultId}&source=${a.source.sourceId}&assignment=${a.assignmentId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.getByLabel("Result revision").selectOption(manual.resultId);
  await page
    .getByLabel("Retained source revision")
    .selectOption(source.sourceId);
  await page
    .getByText("Entry manually selected result", { exact: true })
    .waitFor();
  await page.getByLabel("Editable reply").fill("Shared unfinished entry reply");
  const assignmentDisclosure = page.locator(
    `#history details[data-record-id="${a.assignmentId}"]`,
  );
  assert.equal(
    await assignmentDisclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    ),
    true,
  );
  await assignmentDisclosure.locator(":scope > summary").click();

  const brief = page.locator(`#brief [data-record-id="${source.sourceId}"]`);
  await brief.locator("summary").click();
  await brief.evaluate((el) => el.scrollIntoView());
  await brief.locator("summary").focus();
  const y = await brief.evaluate((el) => el.getBoundingClientRect().top);
  await page
    .getByRole("link", { name: "Search", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Entry ancient result");
  await page.getByLabel("Include historical records").check();
  await page.getByLabel("Record type", { exact: true }).selectOption("result");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator(`[data-search-record="${old.resultId}"] a`).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  await page.goBack();
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await page.goBack();
  await page
    .getByText("Entry manually selected result", { exact: true })
    .waitFor();
  await page.waitForFunction(
    ({ id, y }) => {
      const el = document.querySelector(`[data-record-id="${id}"]`);
      return (
        el instanceof HTMLDetailsElement &&
        el.open &&
        Math.abs(el.getBoundingClientRect().top - y) < 4 &&
        document.activeElement === el.querySelector("summary")
      );
    },
    { id: source.sourceId, y },
  );
  assert.equal(
    await page.getByLabel("Result revision").inputValue(),
    manual.resultId,
  );
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    source.sourceId,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  assert.equal(
    await assignmentDisclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    ),
    false,
  );
  await captureBrowserEvidence(page, "1366-restored-manual-task-entry");
  await page.goForward();
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await page.goForward();
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  await page.goForward();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  await page.getByRole("link", { name: "Entry task", exact: true }).click();
  await page.getByText("Entry latest result", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Result revision").inputValue(), "");
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  assert.equal(
    latest.resultId,
    f.service.taskReview().read(a.taskId).results.at(-1)?.resultId,
  );
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Entry ancient result");
  await page.getByLabel("Include historical records").check();
  await page.getByLabel("Record type", { exact: true }).selectOption("result");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator(`[data-search-record="${old.resultId}"] a`).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.goBack();
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await page.goBack();
  await page.getByText("Entry latest result", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Result revision").inputValue(), "");
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
});

test("in-flight exact reply becomes original-key reconciliation across same-task entry disposal", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Reply entry", "Pending entry task");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage();
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Editable reply").fill("Exact in-flight reply");
  let release!: () => void, entered!: () => void, settled!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    arrival = new Promise<void>((r) => (entered = r)),
    done = new Promise<void>((r) => (settled = r));
  let originalKey = "";
  await page.route("**/api/operator/commands", async (route) => {
    const input = route.request().postDataJSON();
    if (input.type !== "message" || originalKey) {
      await route.continue();
      return;
    }
    originalKey = input.key;
    const response = await route.fetch();
    entered();
    await barrier;
    await route.fulfill({ response });
    settled();
  });
  try {
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .click();
    await arrival;
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page
      .getByRole("heading", { name: "All tasks", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Pending entry task", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.getByLabel("Editable reply").inputValue(),
      "Exact in-flight reply",
    );
    assert.equal(await page.getByLabel("Editable reply").isDisabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Message task lead", exact: true })
        .isDisabled(),
      true,
    );
    release();
    await done;
    assert.equal(
      await page.getByLabel("Editable reply").inputValue(),
      "Exact in-flight reply",
    );
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .click();
    await page.getByText(new RegExp(`Receipt key ${originalKey}`)).waitFor();
    assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.text === "Exact in-flight reply").length,
      1,
    );
  } finally {
    release();
  }
});
