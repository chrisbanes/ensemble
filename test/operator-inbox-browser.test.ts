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
