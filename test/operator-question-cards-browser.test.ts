import assert from "node:assert/strict";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { choiceForm, guideForm } from "./fixtures/question-data.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
import { questionReadSchema } from "../src/operator/contracts.js";
const test = browserSuite("ui08-question-cards");
const engines: Array<[string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

/** One grouped request (and optionally a second one) in the Inbox, signed in. */
async function openQuestions(
  j: BrowserJourney,
  engine: BrowserType,
  viewport: { width: number; height: number },
  others: Array<typeof choiceForm> = [],
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Awaited<ReturnType<BrowserType["launch"]>> | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const group = await seedOwnQuestion(
    f,
    guideForm,
    "Shape the first-run guide",
    "Fieldnotes",
  );
  const more = [];
  for (const [i, form] of others.entries())
    more.push(
      await seedOwnQuestion(f, form, `Choose audience ${i + 1}`, "Atlas"),
    );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => engine.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return { f, page, web, group, more };
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

for (const [name, engine] of engines) {
  test(`${name}: choices are cards with the control beside the label, constraint lines, progress and keyboard use`, async (_t, j) => {
    const { page, group } = await openQuestions(j, engine, {
      width: 1366,
      height: 900,
    });
    const form = page.getByRole("region", { name: "Exact question response" });
    await form.getByRole("radio", { name: /^Every new member/ }).waitFor();
    // (a) the radio sits on the label's row, to its left; the description is under it.
    const radio = (await form
        .getByRole("radio", { name: /^Every new member/ })
        .boundingBox())!,
      label = (await form
        .locator(".question-option-label", { hasText: "Every new member" })
        .boundingBox())!,
      description = (await form
        .getByText("Daily use, with separate owner setup.")
        .boundingBox())!;
    assert.ok(radio.x + radio.width <= label.x + 1, "radio left of label");
    assert.ok(Math.abs(radio.y - label.y) < 16, "same row");
    assert.ok(description.y >= label.y + label.height - 1, "description below");
    await form.getByText("Recommended by Task lead", { exact: true }).waitFor();
    // (c) constraint lines replace the "(required)" suffix.
    for (const line of [
      "Required · choose one · custom text allowed",
      "Required · select 1–2",
      "Required · free text · up to 240 characters",
    ])
      await form.getByText(line, { exact: true }).waitFor();
    assert.equal(await form.getByText("(required)").count(), 0);
    // (d) progress and the draft status never claim anything was sent.
    const progress = form.locator(".question-progress");
    assert.equal((await progress.textContent())?.trim(), "0 of 3 completed");
    await form
      .getByText("Not submitted · answer Q1, Q2, Q3 to continue", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await form
        .getByRole("button", { name: "Submit answers", exact: true })
        .count(),
      1,
    );
    // (a) selection style and keyboard.
    const card = (text: string) =>
      form.locator(".question-option", { hasText: text });
    const style = (text: string) =>
      card(text).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          border: s.borderColor,
          outline: s.outlineWidth,
          ring: s.boxShadow,
        };
      });
    const before = await style("Every new member");
    await form.getByRole("radio", { name: /^Every new member/ }).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await form.getByRole("radio", { name: /^Workspace owners/ }).isChecked(),
      true,
    );
    const selected = await style("Workspace owners"),
      unselected = await style("Every new member");
    assert.notEqual(selected.border, unselected.border);
    assert.equal(selected.outline, "2px");
    assert.notEqual(unselected.outline, "2px");
    assert.notEqual(selected.ring, "none", "keyboard focus draws a ring");
    assert.equal(before.outline === "2px", false);
    await page.keyboard.press("ArrowUp");
    assert.equal(
      await form.getByRole("radio", { name: /^Every new member/ }).isChecked(),
      true,
    );
    await form
      .getByRole("checkbox", { name: /^Find everyday actions/ })
      .focus();
    await page.keyboard.press("Space");
    assert.equal(
      await form
        .getByRole("checkbox", { name: /^Find everyday actions/ })
        .isChecked(),
      true,
    );
    await form
      .getByRole("textbox", {
        name: "How should the opening sound?",
        exact: true,
      })
      .fill("Friendly and direct.");
    assert.equal((await progress.textContent())?.trim(), "3 of 3 completed");
    await form
      .getByText("All 3 answers ready · not submitted", { exact: true })
      .waitFor();
    // (b) two columns: the first question alone on the left, the rest on the right.
    const left = async (q: string) =>
      (await form.locator(`[data-question-id="${q}"]`).boundingBox())!;
    const [q1, q2, q3] = [
      await left("audience"),
      await left("sections"),
      await left("tone"),
    ];
    assert.ok(q2.x > q1.x + 100, JSON.stringify({ q1, q2 }));
    assert.ok(
      Math.abs(q2.x - q3.x) < 2,
      "questions 2 and 3 share the right column",
    );
    assert.ok(q3.y > q2.y, "question 3 follows question 2");
    await captureBrowserEvidence(page, `${name}-1366-grouped-cards`, {
      fullPage: false,
    });
    // Phone: one column.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".inbox-row").click();
    await form.getByRole("radio", { name: /^Every new member/ }).waitFor();
    await settle(page);
    const phone = [
      await left("audience"),
      await left("sections"),
      await left("tone"),
    ];
    assert.ok(
      phone.every((b) => Math.abs(b.x - phone[0]!.x) < 2),
      JSON.stringify(phone),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await captureBrowserEvidence(page, `${name}-390-grouped-cards`, {
      fullPage: false,
    });
    assert.ok(group.interactionId);
  });

  test(`${name}: a single question lays options in two columns, reads Submit answer, and a recorded answer stays in context`, async (_t, j) => {
    const { page, f, more } = await openQuestions(
      j,
      engine,
      { width: 1366, height: 900 },
      [choiceForm],
    );
    const rows = page.locator(".inbox-row");
    await rows.nth(1).waitFor();
    await rows.filter({ hasText: "Choose audience 1" }).click();
    const form = page.getByRole("region", { name: "Exact question response" });
    await form.getByRole("radio", { name: /^Every new member/ }).waitFor();
    await settle(page);
    const a = (await form.locator(".question-option").nth(0).boundingBox())!,
      b = (await form.locator(".question-option").nth(1).boundingBox())!;
    assert.ok(
      b.x > a.x + 100 && Math.abs(a.y - b.y) < 2,
      JSON.stringify({ a, b }),
    );
    assert.equal(await form.locator(".question-progress").count(), 0);
    const submit = form.getByRole("button", {
      name: "Submit answer",
      exact: true,
    });
    await submit.waitFor();
    await form.getByText("Required · choose one", { exact: true }).waitFor();
    await form.getByText("Not submitted", { exact: true }).waitFor();
    await form.getByRole("radio", { name: /^Team owners/ }).check();
    await form
      .getByText("Selected: Team owners · unsent", { exact: true })
      .waitFor();
    await submit.click();
    // (g) the confirmation replaces the controls and stays in the detail.
    await form.getByRole("heading", { name: "Answer recorded" }).waitFor();
    await form.getByText("Q1 · Team owners", { exact: true }).waitFor();
    await form
      .getByText(
        "Delivery waits for the requester's next eligible turn; independent holds are unchanged.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await form.getByRole("radio").count(), 0);
    await page
      .getByText("1 unresolved · confirmation retained", { exact: true })
      .waitFor();
    await rows.nth(0).waitFor();
    assert.equal(await rows.count(), 1);
    assert.equal(
      f.service.coordinationView().readTask(more[0]!.taskId).questions[0]
        ?.status,
      "answered",
    );
    await captureBrowserEvidence(page, `${name}-1366-recorded`, {
      fullPage: false,
    });
    await form
      .getByRole("button", { name: "Back to Inbox", exact: true })
      .click();
    await page
      .getByText(
        "Select a request to review its complete form or exact material.",
        {
          exact: true,
        },
      )
      .waitFor();
    assert.equal(
      await page.locator('.inbox-row[aria-pressed="true"]').count(),
      0,
    );
    assert.equal(new URL(page.url()).search, "");
  });

  test(`${name}: a failed answer keeps the selection and retries once; a stale read disables Submit until refreshed; a conflict keeps input`, async (_t, j) => {
    const { page, f, group } = await openQuestions(j, engine, {
      width: 1366,
      height: 900,
    });
    const form = page.getByRole("region", { name: "Exact question response" });
    await form.getByRole("radio", { name: /^Every new member/ }).check();
    await form.getByRole("checkbox", { name: /^Invite teammates/ }).check();
    await form
      .getByRole("textbox", {
        name: "How should the opening sound?",
        exact: true,
      })
      .fill("Friendly and direct.");
    const status = form.locator(".question-status"),
      submit = form.getByRole("button", {
        name: "Submit answers",
        exact: true,
      });
    // (f) a failed read leaves the form stale: input retained, Submit off, Refresh primary.
    const readUrl = `**/api/operator/tasks/${group.taskId}/questions/${group.interactionId}`;
    await page.route(readUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable" } }),
      }),
    );
    await form
      .getByRole("button", { name: "Refresh request", exact: true })
      .click();
    await status
      .filter({ hasText: /^Stale read · last read \d\d:\d\d/ })
      .waitFor();
    assert.equal(await submit.isDisabled(), true);
    assert.equal(
      await form
        .getByRole("button", { name: "Refresh request", exact: true })
        .evaluate((el) => el.classList.contains("bg-primary")),
      true,
    );
    assert.equal(
      await form.getByRole("radio", { name: /^Every new member/ }).isChecked(),
      true,
    );
    await page.unroute(readUrl);
    await form
      .getByRole("button", { name: "Refresh request", exact: true })
      .click();
    await submit.waitFor();
    // The refresh settles when Submit is available again.
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Submit answers" && !b.disabled,
      ),
    );

    // (e) a failed submission is not a recorded one.
    const commands = "**/api/operator/commands";
    await page.route(commands, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unavailable", message: "down" },
        }),
      }),
    );
    await submit.click();
    const failed =
      "Answer not recorded. Your selection is retained. The request remains unresolved.";
    await form.getByText(failed, { exact: true }).waitFor();
    assert.equal(
      await form.getByRole("heading", { name: "Answer recorded" }).count(),
      0,
    );
    assert.equal(
      await form.getByRole("radio", { name: /^Every new member/ }).isChecked(),
      true,
    );
    assert.equal(
      f.service.coordinationView().readTask(group.taskId).questions[0]?.status,
      "open",
    );
    await captureBrowserEvidence(page, `${name}-1366-answer-failed`, {
      fullPage: false,
    });
    await page.unroute(commands);
    // A conflict keeps input and offers the current request.
    await page.route(commands, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "conflict", message: "stale" } }),
      }),
    );
    await form
      .getByRole("button", { name: "Retry answer", exact: true })
      .click();
    await form
      .getByText(
        "Request is stale, cancelled or already answered. Your input is retained.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await form
        .getByRole("checkbox", { name: /^Invite teammates/ })
        .isChecked(),
      true,
    );
    await form
      .getByRole("button", { name: "Review current request", exact: true })
      .waitFor();
    await page.unroute(commands);
    await form
      .getByRole("button", { name: /^Retry answer$|^Submit answers$/ })
      .click();
    await form.getByRole("heading", { name: "Answer recorded" }).waitFor();
    assert.equal(
      f.service.coordinationView().readTask(group.taskId).questions[0]?.status,
      "answered",
    );
    assert.equal(
      f.service
        .coordinationView()
        .readTask(group.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      1,
    );
  });

  test(`${name}: requests that cannot take an answer show titled notices with the server reason, and evidence return restores selection, scroll and focus`, async (_t, j) => {
    const { page, group } = await openQuestions(j, engine, {
      width: 1366,
      height: 600,
    });
    const form = page.getByRole("region", { name: "Exact question response" });
    await form.getByRole("radio", { name: /^Every new member/ }).waitFor();
    // (i) inspect evidence and return.
    await form.getByRole("radio", { name: /^Workspace owners/ }).check();
    const detail = page.locator(".inbox-detail");
    assert.ok(
      (await detail.evaluate((e) => e.scrollHeight - e.clientHeight)) > 40,
    );
    await detail.evaluate((e) => {
      e.scrollTop = 60;
      e.dispatchEvent(new Event("scroll"));
    });
    const evidence = form.getByRole("link", {
      name: "Question evidence",
      exact: true,
    });
    await evidence.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/app\/tasks\//);
    await page.goBack();
    await form.getByRole("radio", { name: /^Workspace owners/ }).waitFor();
    await settle(page);
    // The request opened by itself, so it returns from the Inbox's own state, not the URL.
    assert.equal(
      await form.getAttribute("data-record-id"),
      group.interactionId,
    );
    assert.equal(
      await form.getByRole("radio", { name: /^Workspace owners/ }).isChecked(),
      true,
    );
    assert.ok(Math.abs((await detail.evaluate((e) => e.scrollTop)) - 60) <= 1);
    assert.equal(
      await evidence.evaluate((el) => document.activeElement === el),
      true,
    );
    // (j) other statuses.
    const readUrl = `**/api/operator/tasks/${group.taskId}/questions/${group.interactionId}`;
    for (const [status, reason, title] of [
      ["cancelled", "Withdrawn by the requester", "Cancelled request"],
      [
        "unsupported",
        "Request is unavailable; no answer can be submitted",
        "Question interaction unsupported",
      ],
      ["offline", "Runtime is offline", "Interaction unavailable"],
      ["stale", "Replaced by revision 3", "Stale request"],
    ] as const) {
      await page.route(readUrl, async (route) => {
        const response = await route.fetch(),
          body = questionReadSchema.parse(await response.json());
        body.data.status = status;
        body.data.reason = reason;
        await route.fulfill({ response, json: body });
      });
      await form
        .getByRole("button", { name: "Refresh request", exact: true })
        .first()
        .click();
      await form.getByRole("heading", { name: title, exact: true }).waitFor();
      await form.getByText(reason, { exact: true }).waitFor();
      assert.equal(
        await form
          .getByRole("button", { name: /^Submit answers?$/ })
          .isDisabled(),
        true,
      );
      assert.equal(
        await form
          .getByRole("radio", { name: /^Workspace owners/ })
          .isChecked(),
        true,
        "retained input stays visible",
      );
      assert.equal(
        await form
          .getByRole("radio", { name: /^Workspace owners/ })
          .isDisabled(),
        true,
      );
      await page.unroute(readUrl);
      await form
        .getByRole("button", {
          name: /Refresh request|Review current request|Check connection/,
        })
        .first()
        .click();
      await form
        .getByRole("heading", { name: title, exact: true })
        .waitFor({ state: "detached" });
    }
  });
}
