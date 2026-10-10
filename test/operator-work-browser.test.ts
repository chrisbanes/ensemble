import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { openMoreFilters, seedCatalog } from "./fixtures/operator-work.js";
import { seedOwnQuestion } from "./fixtures/questions.js";

const test = browserSuite("ui08-work");
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
const desktop = { width: 1366, height: 900 },
  phone = { width: 390, height: 844 };

/** One fixture, one Chromium page and the seeded catalog, signed in on `path`. */
async function start(journey: BrowserJourney, path = "/app/tasks") {
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
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let commandPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commandPosts++;
  });
  await page.goto(web.origin + path);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  return { f, ids, web, page, commands: () => commandPosts };
}
const shot = (page: Page, name: string) => captureBrowserEvidence(page, name);
const taskIds = (page: Page, scope = "main") =>
  page
    .locator(`${scope} [data-task-id]`)
    .evaluateAll((es) => es.map((e) => e.getAttribute("data-task-id")).sort());
const noPageOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
const mainText = (page: Page) => page.locator("main").innerText();

test("toolbar puts the filters, switch and count on one row with Active tasks as the default", async (_t, journey) => {
  const { ids, web, page, commands } = await start(journey);
  const state = page.getByRole("combobox", { name: "State", exact: true }),
    project = page.getByRole("combobox", { name: "Project", exact: true });
  await page
    .getByRole("heading", { name: "Across your projects", level: 2 })
    .waitFor();
  await page
    .locator(`.task-list [data-task-id="${ids.question.id}"]`)
    .waitFor();
  const tops = await Promise.all(
    [
      project,
      state,
      page.getByRole("button", { name: "List", exact: true }),
      page.getByRole("button", { name: "Board", exact: true }),
    ].map((c) => c.evaluate((e) => e.getBoundingClientRect().top)),
  );
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, `one row: ${tops}`);
  assert.equal(await page.locator(".work-toolbar label").count(), 0);
  assert.equal(await page.getByLabel("Source").isVisible(), false);
  assert.equal(
    await state.evaluate(
      (s: HTMLSelectElement) => s.selectedOptions[0]?.textContent,
    ),
    "Active tasks",
  );
  const active = page.locator(".task-list");
  for (const hidden of ["Completed result", "Cancelled work"])
    assert.equal(
      await active.getByRole("link", { name: hidden, exact: true }).count(),
      0,
    );
  assert.equal(
    await page.locator(".work-count").innerText(),
    `${(await taskIds(page, ".task-list")).length} tasks`,
  );
  await shot(page, "1366-tasks-toolbar");

  await state.selectOption("All tasks");
  await page.waitForURL((u) => u.searchParams.get("state") === "all");
  for (const shown of ["Completed result", "Cancelled work"])
    await active.getByRole("link", { name: shown, exact: true }).waitFor();
  await state.selectOption("Stopping");
  await page.waitForURL((u) => u.searchParams.get("state") === "Stopping");
  assert.deepEqual(
    await taskIds(page),
    [ids.normal.id, ids.uncertainStop.id].sort(),
  );
  await page.reload();
  assert.equal(await state.inputValue(), "Stopping");
  await page.goBack();
  await page.waitForURL((u) => u.searchParams.get("state") === "all");
  await page.goForward();
  await page.waitForURL((u) => u.searchParams.get("state") === "Stopping");

  // Search, Source and Readiness live in the disclosure, which opens for a URL filter.
  await page.goto(`${web.origin}/app/tasks?q=Question`);
  assert.equal(await page.locator(".work-more").getAttribute("open"), "");
  assert.equal(await page.getByLabel("Search tasks").inputValue(), "Question");
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.equal(await page.locator(".work-more").getAttribute("open"), null);
  await openMoreFilters(page);
  await page.getByLabel("Search tasks").fill("Normal Stop");
  await page.waitForURL((u) => u.searchParams.get("q") === "Normal Stop");
  assert.deepEqual(await taskIds(page), [ids.normal.id]);
  await page.getByLabel("Search tasks").fill("");
  await page.getByLabel("Source").selectOption("github");
  await page.waitForURL((u) => u.searchParams.get("source") === "github");
  assert.deepEqual(await taskIds(page), [ids.importedId]);
  await page.getByLabel("Source").selectOption("");
  await page.getByLabel("Readiness").selectOption("no");
  await page.waitForURL((u) => u.searchParams.get("ready") === "no");
  assert.ok((await taskIds(page)).includes(ids.draft));

  // The switch keeps every filter and the same task set, and sends no command.
  await page.goto(
    `${web.origin}/app/tasks?project=${ids.projectId}&state=all&q=a&source=local&ready=yes`,
  );
  await page.locator(".task-list [data-task-id]").first().waitFor();
  const before = await taskIds(page);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.locator(".board-columns").waitFor();
  const url = new URL(page.url());
  for (const [key, value] of [
    ["project", ids.projectId],
    ["state", "all"],
    ["q", "a"],
    ["source", "local"],
    ["ready", "yes"],
    ["view", "board"],
  ] as const)
    assert.equal(url.searchParams.get(key), value, key);
  assert.deepEqual(await taskIds(page), before);
  assert.equal(commands(), 0);
});

test("headers carry the new subtitles, one New task action and the page-owned refresh", async (_t, journey) => {
  const { ids, web, page } = await start(journey, "/app");
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  assert.equal(
    await page.locator(".page-header-title p").innerText(),
    "Decisions first. Work and completed results stay separate.",
  );
  assert.equal(
    await page.getByRole("link", { name: "New task", exact: true }).count(),
    1,
  );
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.match(
    await page.locator(".page-header-title p").innerText(),
    /^\d+ active tasks? · \d+ projects?$/,
  );
  await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.match(
    await page.locator(".page-header-title p").innerText(),
    /^\d+ active tasks? · accountable lead Accountable lead$/,
  );
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Open existing project controls", exact: true })
    .waitFor();
  assert.equal(await page.locator(".task-actions").count(), 0);
  await page.getByText(/^Task states read /).waitFor();
  const reads = [
    page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/operator/workspace",
    ),
    page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/operator/inbox",
    ),
  ];
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await Promise.all(reads);
  await shot(page, "1366-overview-toolbar");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.ok(await noPageOverflow(page));
  const heights = await page
    .locator(".work-toolbar button, .work-toolbar select")
    .evaluateAll((es) =>
      es.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
  assert.ok(
    heights.length >= 4 && heights.every((h) => h >= 44),
    `touch targets ${heights}`,
  );
  await shot(page, "390-tasks-toolbar");
});

test("task rows show state, next actor and lead from recorded facts without raw identifiers", async (_t, journey) => {
  const { ids, web, page } = await start(journey, "/app/tasks?state=all");
  const row = (id: string) => page.locator(`.task-list [data-task-id="${id}"]`);
  await row(ids.importedId).waitFor();
  const imported = await row(ids.importedId)
    .locator(".task-project-metadata")
    .innerText();
  assert.match(imported, /Service integration/);
  assert.match(imported, /fixture\/source#42/);
  assert.doesNotMatch(imported, /GitHub fixture/);
  assert.equal(
    await row(ids.importedId).locator(".task-lead").innerText(),
    "Accountable lead · lead",
  );
  assert.equal(
    await row(ids.importedId).locator(".task-source-state").count(),
    0,
  );
  const question = row(ids.question.id);
  assert.match(await question.locator(".task-status").innerText(), /Running/);
  await question
    .getByText("Question needs an answer", { exact: true })
    .waitFor();
  await question
    .getByText("Next: you · answer question", { exact: true })
    .waitFor();
  await row(ids.running.id)
    .getByText("No operator decision", { exact: true })
    .waitFor();
  await row(ids.done)
    .getByText("Next: none · no decision", { exact: true })
    .waitFor();
  await row(ids.cancelled)
    .getByText("Next: none · history retained", { exact: true })
    .waitFor();
  assert.doesNotMatch(await mainText(page), uuidText);
  // The whole row is the title link's target.
  await row(ids.running.id).scrollIntoViewIfNeeded();
  const box = (await row(ids.running.id).boundingBox())!;
  const at = [box.x + box.width - 8, box.y + box.height / 2] as const;
  assert.equal(
    await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.className,
      at,
    ),
    "small-heading task-title",
  );
  await page.mouse.click(...at);
  await page.waitForURL((u) => u.pathname === `/app/tasks/${ids.running.id}`);
  await page.goBack();
  await shot(page, "1366-list");

  await page.goto(`${web.origin}/app`);
  await page
    .getByRole("region", { name: "Across your projects" })
    .locator(".task-row")
    .first()
    .waitFor();
  // A task that needs attention is also in the work list.
  await row(ids.question.id).waitFor();
  assert.doesNotMatch(await mainText(page), uuidText);
  await shot(page, "1366-overview-work");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?state=all`);
  await row(ids.importedId).waitFor();
  assert.ok(await noPageOverflow(page));
  const narrow = await page.locator(".task-row > *").evaluateAll((es) =>
    es
      .filter((e) => e.textContent?.trim())
      .map((e) => [e.className, e.getBoundingClientRect().width] as const)
      .filter(([c, w]) => w < (String(c).includes("task-status") ? 56 : 100)),
  );
  assert.deepEqual(narrow, []);
  await shot(page, "390-list");
});

test("overview attention rows read the Inbox and cover its failure and partial states", async (_t, journey) => {
  const { f, ids, web, page } = await start(journey, "/app");
  const attention = page.getByRole("region", {
    name: "Needs your attention",
    exact: true,
  });
  await attention
    .getByRole("heading", { level: 2, name: "Needs your attention" })
    .waitFor();
  const rows = attention.locator(".work-request");
  await rows.first().waitFor();
  const navCount = await page
    .locator('.sidebar a[href="/app/inbox"] .nav-count')
    .innerText();
  await attention
    .getByText(`${navCount} unresolved`, { exact: true })
    .waitFor();
  assert.ok((await rows.count()) <= 3);
  for (const text of await rows.evaluateAll((es) =>
    es.map((e) => e.textContent ?? ""),
  )) {
    assert.match(text, /Question|Approval|Intervention/);
    assert.match(
      text,
      /Responsibility unknown|\w+ · \d\d:\d\d|Age unknown|\d\d:\d\d/,
    );
    assert.doesNotMatch(text, uuidText);
  }
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    assert.equal(await row.getByRole("link").count(), 1);
    const link = row.getByRole("link");
    const name = (await link.innerText()).trim();
    assert.match(
      name,
      /^(Answer question|Review material & decide|Inspect execution)$/,
    );
    const describedBy = await link.getAttribute("aria-describedby");
    assert.ok(
      describedBy && (await row.locator(`[id="${describedBy}"]`).count()) === 1,
    );
  }
  assert.equal(
    await attention
      .getByText("Normal Stop observation", { exact: true })
      .count(),
    0,
  );
  const question = rows.filter({ hasText: "Question requiring action" }),
    questionLink = question.getByRole("link", {
      name: "Answer question",
      exact: true,
    });
  assert.match(
    (await questionLink.getAttribute("href")) ?? "",
    new RegExp(`^/app/inbox\\?task=${ids.question.id}&request=`),
  );
  const intervention = rows.filter({
    hasText: "Stop with uncertain ownership",
  });
  assert.equal(
    await intervention.getByRole("link").getAttribute("href"),
    `/app/tasks/${ids.uncertainStop.id}`,
  );
  await attention
    .getByRole("link", { name: "View inbox", exact: true })
    .waitFor();
  assert.equal(await attention.getByText(/more in the Inbox/).count(), 0);
  await shot(page, "1366-overview-attention");

  // Answering opens the Inbox with that request selected; Back restores Overview.
  await questionLink.click();
  await page.locator(".inbox-row[aria-pressed='true']").waitFor();
  await page.goBack();
  await attention.waitFor();

  // A fourth request shows "N more" and the badge follows the sidebar count.
  await seedOwnQuestion(f, undefined, "Fourth request");
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await attention.getByText("1 more in the Inbox", { exact: true }).waitFor();
  assert.equal(await rows.count(), 3);
  await attention
    .getByText(`${Number(navCount) + 1} unresolved`, { exact: true })
    .waitFor();

  // Completed work stays reachable although Active tasks hides it.
  const completed = page.getByRole("region", {
    name: "Completed work",
    exact: true,
  });
  await completed
    .getByText("1 completed task · no decision needed", { exact: true })
    .waitFor();
  assert.equal(
    await completed
      .getByRole("link", { name: "View completed" })
      .getAttribute("href"),
    "/app/tasks?state=Done",
  );
  await shot(page, "1366-overview-completed");

  // Unavailable Inbox: the work list still renders and the badge is absent.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/operator/inbox**", async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    });
  });
  try {
    await page.reload();
    release();
    await attention
      .getByText("Requests are unavailable. Try again.", { exact: true })
      .waitFor();
    await page
      .locator(`.task-list [data-task-id="${ids.question.id}"]`)
      .waitFor();
    assert.equal(await attention.getByText(/unresolved/).count(), 0);
  } finally {
    release();
    await page.unroute("**/api/operator/inbox**");
  }
  await attention
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await rows.first().waitFor();

  // A partial read says so and shows no total.
  await page.route("**/api/operator/inbox**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.data.complete = false;
    await route.fulfill({ response, json: body });
  });
  try {
    await page.reload();
    await attention
      .getByText(
        "Queue coverage is incomplete. Unavailable requests may remain.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await attention.getByText(/unresolved/).count(), 0);
  } finally {
    await page.unroute("**/api/operator/inbox**");
  }

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app`);
  await rows.first().waitFor();
  assert.ok(await noPageOverflow(page));
  const action = await rows.first().getByRole("link").boundingBox();
  assert.ok(action && action.height >= 44);
  await shot(page, "390-overview-attention");
});

test("overview without requests or completed work says so and omits the completed line", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Quiet project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: randomUUID(),
    title: "Quiet draft",
    outcome: "Work",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  await page.getByText("Quiet draft", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: "Completed work" }).count(),
    0,
  );
});

test("board shows a link bar with every count, collapsed empty columns and drawn cards", async (_t, journey) => {
  const { ids, web, page, commands } = await start(
    journey,
    "/app/tasks?view=board&state=all",
  );
  const bar = page.getByRole("toolbar", { name: "Board columns" });
  await bar.waitFor();
  const counts = new Map<string, number>();
  for (const button of await bar.getByRole("button").all()) {
    const [, column, count] =
      /^(\w+) · (\d+)$/.exec((await button.innerText()).trim()) ?? [];
    assert.ok(column, "tab label");
    const section = page.getByRole("region", {
      name: `${column} tasks`,
      exact: true,
    });
    assert.equal(
      await section.locator("[data-task-id]").count(),
      Number(count),
      column,
    );
    counts.set(column!, Number(count));
  }
  assert.deepEqual(
    [...counts.keys()],
    [
      "Ready",
      "Running",
      "Waiting",
      "Paused",
      "Stopping",
      "Uncertain",
      "Draft",
      "Done",
      "Cancelled",
    ],
  );
  const widths = await page
    .locator(".board-column")
    .evaluateAll((es) =>
      es.map(
        (e) =>
          [
            e.getAttribute("data-empty"),
            e.getBoundingClientRect().width,
          ] as const,
      ),
    );
  for (const [empty, width] of widths)
    assert.ok(empty ? width <= 160 : width >= 300, `${empty} ${width}`);
  await shot(page, "1366-board");

  await bar.getByRole("button", { name: /^Uncertain · 1$/ }).click();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Uncertain · 1$/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.waitForFunction(() => {
    const board = document
        .querySelector(".board-columns")!
        .getBoundingClientRect(),
      column = document
        .querySelector("#column-Uncertain")!
        .getBoundingClientRect();
    return column.left >= board.left - 1 && column.right <= board.right + 1;
  });
  await shot(page, "1366-board-later");

  const card = page.locator(`[data-task-id="${ids.question.id}"]`);
  const text = (await card.innerText())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const order = [
    "Question requiring action",
    "Service integration · Local task",
    "Running",
    "Question needs an answer",
    "Next: you · answer question",
    "Answer question →",
    "Accountable lead · accountable lead",
  ];
  let at = -1;
  for (const expected of order) {
    const next = text.findIndex((l, i) => i > at && l.startsWith(expected));
    assert.ok(next > at, `${expected} in ${JSON.stringify(text)}`);
    at = next;
  }
  assert.match(
    (await card
      .getByRole("link", { name: "Answer question" })
      .getAttribute("href")) ?? "",
    /^\/app\/inbox\?task=/,
  );
  const source = page
    .locator(`[data-task-id="${ids.importedId}"]`)
    .getByRole("link", { name: /fixture\/source#42/ });
  assert.equal(await source.getAttribute("target"), "_blank");
  assert.match((await source.getAttribute("rel")) ?? "", /noopener/);
  assert.match(await source.innerText(), /opens GitHub/);
  assert.equal(
    await card
      .locator(".task-card")
      .evaluate((e) => getComputedStyle(e).padding),
    "12px",
  );
  assert.doesNotMatch(await mainText(page), uuidText);

  // Keyboard: Tab reaches a card's title and Enter opens the task; Back restores the column.
  await card
    .getByRole("link", { name: "Question requiring action", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname === `/app/tasks/${ids.question.id}`);
  await page.goBack();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Uncertain · 1$/ })
      .getAttribute("aria-pressed"),
    "true",
  );

  // A failed Inbox read keeps the reasons and drops the action link.
  await page.route("**/api/operator/inbox**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  try {
    await page.reload();
    await card.waitFor();
    await card.getByText("Question needs an answer", { exact: true }).waitFor();
    assert.equal(
      await card.getByRole("link", { name: "Answer question" }).count(),
      0,
    );
  } finally {
    await page.unroute("**/api/operator/inbox**");
  }

  // Active tasks with only Done added shows the terminal column the filter names.
  await page.goto(`${web.origin}/app/tasks?view=board&state=Done`);
  await bar.waitFor();
  assert.equal(await bar.getByRole("button").count(), 8);
  assert.equal(
    await bar.getByRole("button", { name: /^Done · 1$/ }).count(),
    1,
  );
  // The filtered column is on screen without a tab click, and the page itself did not scroll.
  await page.waitForFunction(() => {
    const area = document
        .querySelector(".board-columns")!
        .getBoundingClientRect(),
      column = document.querySelector("#column-Done")!.getBoundingClientRect();
    return column.left >= area.left - 1 && column.right <= area.right + 1;
  });
  assert.equal(await page.evaluate(() => scrollY), 0);
  // Nothing but Done matches, so every other column is empty and collapsed.
  const empties = await page
    .locator(".board-column")
    .evaluateAll((es) =>
      es.map(
        (e) =>
          [
            e.id,
            e.getAttribute("data-empty"),
            e.getBoundingClientRect().width,
          ] as const,
      ),
    );
  assert.equal(empties.length, 8);
  for (const [id, empty, width] of empties)
    if (id === "column-Done") assert.equal(empty, null);
    else {
      assert.equal(empty, "true", id);
      assert.ok(width <= 160, `${id} collapses to ${width}px`);
    }
  assert.equal(
    await page.locator("#column-Ready p").innerText(),
    "None ready. Held Ready work is in Waiting.",
  );
  assert.equal(await page.locator("#column-Paused p").innerText(), "No tasks");
  await shot(page, "1366-board-collapsed-empty");
  assert.equal(commands(), 0);

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board&state=all`);
  await bar.waitFor();
  assert.ok(await noPageOverflow(page));
  const tabs = await bar
    .getByRole("button")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect()));
  assert.ok(tabs.every((r) => r.height >= 44));
  assert.equal(
    new Set(tabs.map((r) => Math.round(r.top))).size,
    3,
    "3-column grid of 9 tabs",
  );
  await bar.getByRole("button", { name: /^Waiting · / }).click();
  assert.equal(await bar.locator('[aria-pressed="true"]').count(), 1);
  assert.deepEqual(
    await page
      .locator(".board-column")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.id),
      ),
    ["column-Waiting"],
  );
  const next = page.getByRole("button", { name: "Next column: Paused" }),
    previous = page.getByRole("button", { name: "Previous column: Running" });
  assert.equal(await next.innerText(), "Paused →");
  assert.equal(await previous.innerText(), "← Running");
  await shot(page, "390-board-waiting");
  await next.click();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Paused · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Previous column: Waiting" }).click();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Waiting · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await bar.getByRole("button", { name: /^Ready · / }).click();
  const first = page.getByRole("button", { name: /^Previous column/ });
  assert.equal(await first.isDisabled(), true);
  assert.equal(await first.innerText(), "1 of 9");
  await bar.getByRole("button", { name: /^Cancelled · / }).click();
  const last = page.getByRole("button", { name: /^Next column/ });
  assert.equal(await last.isDisabled(), true);
  assert.equal(await last.innerText(), "9 of 9");
  await bar.getByRole("button", { name: /^Uncertain · / }).click();
  await shot(page, "390-board-uncertain");

  // Choosing a State on an open Board selects that column without a reload; with the
  // same filter the operator's own tab choice stays.
  const visible = () =>
    page
      .locator(".board-column")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.id),
      );
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("Waiting");
  await page.waitForURL((u) => u.searchParams.get("state") === "Waiting");
  assert.deepEqual(await visible(), ["column-Waiting"]);
  assert.equal(
    await bar
      .getByRole("button", { name: /^Waiting · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await bar.getByRole("button", { name: /^Draft · / }).click();
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(ids.projectId);
  await page.waitForURL((u) => u.searchParams.get("project") === ids.projectId);
  assert.deepEqual(await visible(), ["column-Draft"]);
});

test("attention summary names the uncertain or stopping task and links to the Inbox", async (_t, journey) => {
  const { ids, web, page } = await start(journey);
  const summary = page.getByRole("region", {
    name: "Attention summary",
    exact: true,
  });
  await summary.waitFor();
  const text = await summary.innerText();
  assert.match(text, /^Inspect execution · /);
  // The requester of the matching Inbox request, as on Overview; never the task lead.
  assert.match(text, /Responsibility unknown/);
  assert.doesNotMatch(text, /Accountable lead/);
  assert.equal(await summary.locator("[data-task-id]").count(), 0);
  const action = summary.getByRole("link", {
    name: "Inspect execution",
    exact: true,
  });
  assert.match(
    (await action.getAttribute("href")) ?? "",
    /^\/app\/tasks\/[0-9a-f-]{36}$/,
  );
  const navCount = await page
    .locator('.sidebar a[href="/app/inbox"] .nav-count')
    .innerText();
  const inbox = summary.getByRole("link", { name: /^Inbox/ });
  assert.equal(
    (await inbox.innerText()).replace(/\s+/g, " ").trim(),
    `Inbox · ${navCount}`,
  );
  assert.equal(await inbox.getAttribute("href"), "/app/inbox");
  const list = await taskIds(page);
  await shot(page, "1366-tasks-attention-bar");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await summary.waitFor();
  assert.deepEqual(await taskIds(page), list);

  // Scoped to the project; the Inbox number stays global.
  await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
  await summary.waitFor();
  await page.locator('.sidebar a[href="/app/inbox"] .nav-count').waitFor();
  assert.equal(
    await summary
      .getByRole("link", { name: /^Inbox/ })
      .innerText()
      .then((t) => t.replace(/\s+/g, " ").trim()),
    `Inbox · ${navCount}`,
  );
  // Without uncertain tasks the bar names the Stopping one; without either it is absent.
  const without = (
    drop: (t: {
      execution: { state: string };
      attention: { codes: string[] };
    }) => boolean,
  ) =>
    page.route("**/api/operator/task-list", async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      body.data.tasks = body.data.tasks.filter(
        (t: Parameters<typeof drop>[0]) => !drop(t),
      );
      await route.fulfill({ response, json: body });
    });
  await without(
    (t) =>
      t.execution.state === "uncertain" ||
      t.attention.codes.includes("execution-uncertain"),
  );
  await page.goto(`${web.origin}/app/tasks`);
  await summary.getByText(/^Stopping · Normal Stop observation/).waitFor();
  await summary.getByRole("link", { name: "Open task", exact: true }).waitFor();
  await page.unroute("**/api/operator/task-list");
  await without(
    (t) =>
      t.execution.state === "uncertain" ||
      t.execution.state === "stopping" ||
      t.attention.codes.includes("execution-uncertain"),
  );
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.equal(await summary.count(), 0);
  await page.unroute("**/api/operator/task-list");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board`);
  await summary.waitFor();
  assert.ok(await noPageOverflow(page));
  await shot(page, "390-board-attention-bar");
});
