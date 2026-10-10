import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
const test = browserSuite("ui08-inbox");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
const projects = ["Atlas", "Relay", "Fieldnotes"];

/** Starts a fixture with `count` own questions across distinct projects and signs in at `path`. */
async function openInbox(
  j: BrowserJourney,
  count: number,
  viewport: { width: number; height: number },
  path = "/app/inbox",
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const seeded = [];
  for (let i = 0; i < count; i++)
    seeded.push(
      await seedOwnQuestion(
        f,
        undefined,
        `Request ${i + 1}`,
        projects[i % projects.length],
      ),
    );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}${path}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return { f: f as Fixture, page, web, seeded };
}

async function createdAtOf(page: Page, origin: string, title: string) {
  const inbox = (await (
    await page.request.get(`${origin}/api/operator/inbox`)
  ).json()) as {
    data: { items: Array<{ taskTitle: string; createdAt: number | null }> };
  };
  return inbox.data.items.find((item) => item.taskTitle === title)?.createdAt;
}

test("queue rows are request cards with kind, action and relative age; filters are compact; advanced controls are secondary (desktop)", async (_t, j) => {
  const { page, web } = await openInbox(j, 3, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  // The queue replaces the old heading and intro; the section keeps its name.
  assert.equal(
    await page.getByRole("heading", { name: "Action Inbox" }).count(),
    0,
  );
  assert.equal(
    await page
      .getByText("Questions, approvals and recorded interventions")
      .count(),
    0,
  );
  await page.getByRole("region", { name: "Action Inbox" }).waitFor();
  const project = page.getByLabel("Project", { exact: true }),
    kind = page.getByLabel("Request kind", { exact: true });
  assert.equal(
    await project.evaluate(
      (s) =>
        (s as HTMLSelectElement).options[(s as HTMLSelectElement).selectedIndex]
          ?.text,
    ),
    "All projects · 3",
  );
  assert.equal(
    await kind.evaluate(
      (s) =>
        (s as HTMLSelectElement).options[(s as HTMLSelectElement).selectedIndex]
          ?.text,
    ),
    "All request types · 3",
  );
  assert.deepEqual(
    await kind.evaluate((s) =>
      [...(s as HTMLSelectElement).options].map((o) => o.text),
    ),
    [
      "All request types · 3",
      "Questions · 3",
      "Approvals · 0",
      "Interventions · 0",
    ],
  );
  await page
    .getByText("Intervention first · then oldest", { exact: true })
    .waitFor();
  // Filters are compact controls, not full-width labelled fields.
  assert.ok((await project.boundingBox())!.width < 260);
  assert.equal(await page.locator(".inbox-filters label").count(), 0);

  // Rows created in the same second have no stable relative order, so pick by title.
  const first = rows.filter({ hasText: "Request 1" });
  // DOM text: the label is uppercased by CSS only.
  const text = (await first.textContent()) ?? "";
  for (const expected of ["Atlas", "Question", "Request 1", "Answer question"])
    assert.ok(text.includes(expected), `${expected} in ${text}`);
  assert.equal(
    await first.locator(".inbox-row-label").textContent(),
    "Atlas / Question",
  );
  const created = await createdAtOf(page, web.origin, "Request 1");
  assert.ok(created);
  assert.equal(
    await first.locator("time").getAttribute("datetime"),
    new Date(created).toISOString(),
  );
  // 106 minutes after the request reads "1h 46m".
  await page.clock.setFixedTime(created + 106 * 60_000);
  await page.reload();
  await rows.nth(2).waitFor();
  assert.ok(
    (await first.locator(".inbox-row-meta").innerText()).endsWith("1h 46m"),
  );

  const advanced = page.getByRole("link", {
    name: "Advanced coordination controls",
    exact: true,
  });
  assert.equal(await advanced.getAttribute("href"), "/coordination");
  // Not the primary-filled variant used for the one primary action of a view.
  assert.equal(
    await advanced.evaluate((el) => el.classList.contains("bg-primary")),
    false,
  );
  await captureBrowserEvidence(page, "1366-inbox-queue", { fullPage: false });
});

test("filtered-empty and all-empty states explain themselves and offer the way out (desktop)", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 1366, height: 900 });
  await page.locator(".inbox-row").nth(2).waitFor();
  await page
    .getByLabel("Request kind", { exact: true })
    .selectOption("approval");
  await page.getByText("No matching requests.", { exact: true }).waitFor();
  await page
    .getByText(
      "Nothing matches these filters. There are still 3 unresolved items across all projects.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 0);
  await captureBrowserEvidence(page, "1366-inbox-filtered-empty", {
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.locator(".inbox-row").nth(2).waitFor();
  assert.equal(
    await page.getByLabel("Request kind", { exact: true }).inputValue(),
    "",
  );
});

test("an Inbox with nothing unresolved says so and links to Overview", async (_t, j) => {
  const { page } = await openInbox(j, 0, { width: 1366, height: 900 });
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  await page
    .getByText(
      "Questions, approvals and execution problems will appear here. Routine progress and completed work stay in Overview.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Back to overview", exact: true })
      .getAttribute("href"),
    "/app",
  );
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "0 unresolved across your projects",
  );
  await captureBrowserEvidence(page, "1366-inbox-empty", { fullPage: false });
});

test("queue rows are full-width touch targets without horizontal scroll (phone)", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 390, height: 844 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  const boxes = await rows.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().toJSON()),
  );
  for (const box of boxes) {
    assert.ok(box.height >= 44, JSON.stringify(box));
    assert.ok(box.width >= 390 - 2 * 20 - 2, JSON.stringify(box));
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await captureBrowserEvidence(page, "390-inbox-queue", { fullPage: false });
});

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

test("a wide Inbox opens the first request by itself without navigating, and keeps it through filters and polls", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 1366, height: 900 });
  await page.clock.install();
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  const first = rows.first(),
    detail = page.getByRole("region", { name: "Selected request" });
  await first.waitFor();
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  await detail.getByRole("heading", { level: 2 }).waitFor();
  const firstTitle = await first.locator("strong").textContent();
  assert.equal(
    await detail.getByRole("heading", { level: 2 }).textContent(),
    firstTitle,
  );
  assert.equal(new URL(page.url()).pathname, "/app/inbox");
  assert.equal(new URL(page.url()).search, "");
  const entries = await page.evaluate(() => history.length);
  // Selection state is not navigation; the header reads Question · 1 of 3 with one Open task link.
  await detail.getByText("Question", { exact: true }).first().waitFor();
  await detail.getByText("1 of 3", { exact: true }).waitFor();
  const open = detail.getByRole("link", { name: "Open task" });
  assert.match(
    (await open.getAttribute("href"))!,
    /^\/app\/tasks\/[0-9a-f-]{36}$/,
  );
  assert.equal(
    await page.getByRole("button", { name: "Back to queue" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("link", { name: "Back to Inbox" }).count(),
    0,
  );
  // Top-level header stays on a wide layout.
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "3 unresolved across 3 projects",
  );

  // A poll and a filter change leave the selection where it was.
  const poll = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/inbox" && r.ok(),
  );
  await page.clock.runFor(15000);
  await poll;
  await page
    .getByLabel("Request kind", { exact: true })
    .selectOption("question");
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 1 });
  assert.equal(
    await detail.getByRole("heading", { level: 2 }).textContent(),
    firstTitle,
  );
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 0 });
  await rows.nth(2).waitFor();
  assert.equal(await page.evaluate(() => history.length), entries);
  assert.equal(new URL(page.url()).search, "");

  // Choosing another row is navigation: one history entry, and the position follows.
  await rows.nth(1).click();
  await detail.getByText("2 of 3", { exact: true }).waitFor();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await rows.first().getAttribute("aria-pressed"), "false");
  assert.ok(new URL(page.url()).searchParams.get("request"));
  assert.equal(await page.evaluate(() => history.length), entries + 1);
  await captureBrowserEvidence(page, "1366-inbox-selected", {
    fullPage: false,
  });
});

test("the Inbox is two independent scroll regions in one viewport, with the detail header and submit area in view (desktop)", async (_t, j) => {
  const { page } = await openInbox(j, 7, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(6).waitFor();
  const queue = page.locator(".inbox-rows"),
    detail = page.locator(".inbox-detail");
  await page.getByRole("button", { name: /^Submit answers?$/ }).waitFor();
  await settle(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
    true,
    "the page itself does not scroll",
  );
  assert.equal((await page.locator(".inbox-queue").boundingBox())!.width, 368);
  const metrics = (el: typeof queue) =>
    el.evaluate((e) => ({
      client: e.clientHeight,
      scroll: e.scrollHeight,
      top: e.scrollTop,
    }));
  assert.ok((await metrics(queue)).scroll > (await metrics(queue)).client);
  assert.ok((await metrics(detail)).scroll > (await metrics(detail)).client);
  // Wheel over the queue moves only the queue.
  const queueBox = (await queue.boundingBox())!;
  await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + 100);
  await page.mouse.wheel(0, 300);
  await settle(page);
  assert.ok((await metrics(queue)).top > 0);
  assert.equal((await metrics(detail)).top, 0);
  // Wheel over the detail moves only the detail.
  const queueTop = (await metrics(queue)).top;
  const detailBox = (await detail.boundingBox())!;
  await page.mouse.move(detailBox.x + detailBox.width / 2, detailBox.y + 200);
  await page.mouse.wheel(0, 200);
  await settle(page);
  assert.ok((await metrics(detail)).top > 0);
  assert.equal((await metrics(queue)).top, queueTop);

  const header = page.locator(".inbox-detail-header"),
    submit = page.locator(".question-submit");
  const inView = async (label: string) => {
    const box = (await detail.boundingBox())!,
      h = (await header.boundingBox())!,
      s = (await submit.boundingBox())!;
    assert.ok(
      Math.abs(h.y - box.y) <= 1,
      `${label}: header at top ${h.y} vs ${box.y}`,
    );
    assert.ok(
      s.y + s.height <= box.y + box.height + 1,
      `${label}: submit visible`,
    );
    assert.ok(s.y >= box.y, `${label}: submit within pane`);
  };
  for (const where of [0, 0.5, 1]) {
    await detail.evaluate((e, f) => {
      e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
    }, where);
    await settle(page);
    await inView(`at ${where}`);
  }
  await captureBrowserEvidence(page, "1366-inbox-scrolled-detail", {
    fullPage: false,
  });
});

test("the last field stays reachable above the sticky submit area on a short phone", async (_t, j) => {
  const { page } = await openInbox(j, 1, { width: 390, height: 480 });
  await page.locator(".inbox-row").first().click();
  const form = page.getByRole("region", { name: "Exact question response" });
  await form.getByRole("textbox", { name: "Optional", exact: true }).waitFor();
  const detail = page.locator(".inbox-detail");
  await detail.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await settle(page);
  const last = (await form
      .getByRole("textbox", { name: "Optional", exact: true })
      .boundingBox())!,
    submit = (await form.locator(".question-submit").boundingBox())!,
    box = (await detail.boundingBox())!;
  assert.ok(last.y + last.height <= submit.y, JSON.stringify({ last, submit }));
  assert.ok(submit.y + submit.height <= box.y + box.height + 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
});

test("phone: queue to detail to queue restores the anchor and focus without selecting", async (_t, j) => {
  const { page } = await openInbox(j, 9, { width: 390, height: 844 });
  const rows = page.locator(".inbox-row");
  await rows.nth(8).waitFor();
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".page-header-count").textContent(),
    "9 unresolved",
  );
  const queue = page.locator(".inbox-rows");
  assert.ok(
    (await queue.evaluate((e) => e.scrollHeight - e.clientHeight)) > 150,
    "queue is scrollable",
  );
  await queue.evaluate((e) => {
    e.scrollTop = 150;
    e.dispatchEvent(new Event("scroll"));
  });
  await settle(page);
  const before = await queue.evaluate((e) => e.scrollTop);
  // Open a row that is fully visible.
  const target = rows.nth(4);
  const targetId = await target.getAttribute("data-record-id");
  await target.click();
  const header = page.locator("header.page-header");
  await page
    .getByRole("link", { name: "Back to Inbox", exact: true })
    .waitFor();
  assert.equal(await header.locator("h1").textContent(), "Question · 5 of 9");
  assert.match(
    (await header.locator(".page-header-title p").textContent())!,
    /^(Atlas|Relay|Fieldnotes)$/,
  );
  assert.equal(
    await header.getByRole("link", { name: "Open task" }).count(),
    1,
  );
  assert.equal(
    await header.locator("a, button").count(),
    2,
    "Back and Open task only",
  );
  assert.equal(await page.locator(".inbox-queue").isVisible(), false);
  assert.equal(
    await page.getByRole("button", { name: "Back to queue" }).count(),
    0,
  );
  await captureBrowserEvidence(page, "390-inbox-detail", { fullPage: false });

  await page.getByRole("link", { name: "Back to Inbox", exact: true }).click();
  await rows.first().waitFor({ state: "visible" });
  await settle(page);
  assert.ok(Math.abs((await queue.evaluate((e) => e.scrollTop)) - before) <= 1);
  const opened = page.locator(`.inbox-row[data-record-id="${targetId}"]`);
  assert.equal(
    await opened.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(await opened.getAttribute("aria-pressed"), "false");
  assert.equal(
    await page.locator('.inbox-row[aria-pressed="true"]').count(),
    0,
  );
  assert.equal(new URL(page.url()).search, "");
});

test("sign-out clears the Inbox filters and in-memory selection; the header is not stale after signing in", async (_t, j) => {
  const { page, web } = await openInbox(j, 3, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 1 });
  await rows.nth(0).waitFor();
  assert.equal(await rows.count(), 1);
  await rows.first().click();
  await page.getByText("1 of 1", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "3 unresolved across 3 projects",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The URL still names the request, so it reopens; the filter and header start fresh.
  await rows.nth(2).waitFor();
  assert.equal(
    await page.getByLabel("Project", { exact: true }).inputValue(),
    "",
  );
  await page.getByText(/^\d of 3$/).waitFor();
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "3 unresolved across 3 projects",
  );
});
