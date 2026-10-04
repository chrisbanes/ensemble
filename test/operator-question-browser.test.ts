import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
const test = browserSuite("ui05-questions");
test("production mixed form preserves literal schema, keyboard input, field errors and original unknown command across task navigation", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedOwnQuestion(f),
    web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?request=${a.interactionId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .waitFor();
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
    "open",
  );
  const form = page.getByRole("region", { name: "Exact question response" });
  assert.equal(
    await form.getByRole("radio", { name: /^Red/ }).isChecked(),
    true,
  );
  await form.getByRole("radio", { name: /^Red/ }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await form.getByRole("radio", { name: /^Blue/ }).isChecked(),
    true,
  );
  await form.getByRole("checkbox", { name: "Home", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await form.getByRole("checkbox", { name: "Home", exact: true }).isChecked(),
    true,
  );
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await captureBrowserEvidence(page, "1366-submit-diagnostic", {
    fullPage: false,
  });
  const diagnostic = await form.evaluate((el) => ({
    alerts: [...el.querySelectorAll('[role="alert"]')].map(
      (e) => e.textContent,
    ),
    buttons: [...el.querySelectorAll("button")].map((e) => ({
      text: e.textContent,
      type: e.type,
      disabled: e.disabled,
    })),
    fields: [...el.querySelectorAll("textarea")].map((e) => ({
      id: e.id,
      value: e.value,
      disabled: e.disabled,
    })),
    active: document.activeElement?.outerHTML,
    formCount: el.querySelectorAll("form").length,
    text: el.textContent?.slice(-1800),
  }));
  j.diagnostics.push(
    JSON.stringify({ milestone: "full-form-submit", ...diagnostic }),
  );
  assert.ok(
    diagnostic.alerts.includes("Answer is required"),
    JSON.stringify(diagnostic),
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-question-id"),
    ),
    "notes",
  );
  await captureBrowserEvidence(page, "1366-field-error", { fullPage: false });
  await form
    .getByRole("textbox", { name: "Explain", exact: true })
    .fill("Exact typed answer");
  await form
    .getByRole("textbox", { name: "Custom answer: Places", exact: true })
    .fill("Exact custom place");
  const commands: string[] = [];
  await page.route("**/api/operator/commands", async (route) => {
    commands.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid-input", message: "Rejected fixture" },
      }),
    });
  });
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await form.getByText(/Answer failed \(invalid-input\)/).waitFor();
  assert.equal(
    await form
      .getByRole("textbox", { name: "Explain", exact: true })
      .inputValue(),
    "Exact typed answer",
  );
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
    "open",
  );
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    commands.push(route.request().postData() ?? "");
    await route.fetch();
    await route.abort("failed");
  });
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await form.getByText(/Outcome unknown/).waitFor();
  const original = commands.at(-1)!;
  assert.equal(
    await form
      .getByRole("textbox", { name: "Explain", exact: true })
      .isDisabled(),
    true,
  );
  await captureBrowserEvidence(page, "1366-original-command-unknown", {
    fullPage: false,
  });
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    commands.push(route.request().postData() ?? "");
    await route.continue();
  });
  await form
    .getByRole("button", { name: "Reconcile original answer", exact: true })
    .click();
  await form
    .getByText(
      "Answer recorded. Delivery and admission remain subject to independent holds.",
      { exact: true },
    )
    .waitFor();
  assert.equal(commands.at(-1), original);
  assert.equal(
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter((m) => m.eventType === "question-answer").length,
    1,
  );
  await captureBrowserEvidence(page, "1366-recorded", { fullPage: false });
  const legacy = await page.request.get(
    `${web.origin}/coordination/task/${a.taskId}`,
  );
  const html = await legacy.text();
  assert.ok(html.includes(`/app/tasks/${a.taskId}?request=${a.interactionId}`));
  assert.equal(html.includes("/coordination/control/question/answer"), false);
  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    await form
      .getByRole("button", { name: "Submit answer", exact: true })
      .scrollIntoViewIfNeeded();
    const rect = await form
      .getByRole("button", { name: "Submit answer", exact: true })
      .boundingBox();
    assert.ok(rect && rect.height >= 44);
    const footer = await form.locator(".question-submit").evaluate((el) => ({
      viewport: { width: innerWidth, height: innerHeight },
      buttons: [...el.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          text: b.textContent,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          visible:
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            r.left >= 0 &&
            r.right <= innerWidth,
          hit: b.disabled
            ? el.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              )
            : document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest("button") === b,
        };
      }),
    }));
    j.diagnostics.push(
      JSON.stringify({ milestone: `task-footer-${height}`, footer }),
    );
    assert.ok(
      footer.buttons.every((b) => b.visible && b.hit),
      JSON.stringify(footer),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await captureBrowserEvidence(page, `390x${height}-recorded`, {
      fullPage: false,
    });
    await form
      .getByRole("textbox", { name: "Optional", exact: true })
      .scrollIntoViewIfNeeded();
    const lastField = await form
        .getByRole("textbox", { name: "Optional", exact: true })
        .boundingBox(),
      submitTop = await form.locator(".question-submit").boundingBox();
    assert.ok(
      lastField &&
        submitTop &&
        lastField.y >= 0 &&
        lastField.y + lastField.height <= submitTop.y,
      "Last field remains fully reachable above reserved submission actions",
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await captureBrowserEvidence(page, `390x${height}-last-field`, {
      fullPage: false,
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.getByText("Exact typed answer", { exact: true }).count(),
    0,
  );
});

test("action Inbox preserves drafts across exact task entry, filter and phone queue/detail; resolved selection stays explicit", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedOwnQuestion(f),
    b = await seedOwnQuestion(f, undefined, "Second Inbox task"),
    web = await f.startWeb();
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".inbox-row").first().waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 2);
  assert.ok(
    (await page.locator(".inbox-row time").first().innerText()).includes(
      String(new Date().getFullYear()),
    ),
  );
  await page
    .getByLabel("Request kind", { exact: true })
    .selectOption("question");
  await page
    .locator(".inbox-row")
    .filter({ hasText: "Choose full form" })
    .click();
  const form = page.getByRole("region", { name: "Exact question response" });
  await form
    .getByRole("textbox", { name: "Explain", exact: true })
    .fill("Inbox retained draft");
  await captureBrowserEvidence(page, "1366-inbox-draft", { fullPage: false });
  await page.getByRole("link", { name: "Task evidence", exact: true }).click();
  await page
    .getByRole("link", { name: "Answer question", exact: true })
    .first()
    .click();
  j.diagnostics.push(
    JSON.stringify({
      milestone: "task-question-link",
      url: page.url(),
      text: (await page.locator("main").innerText()).slice(-2000),
    }),
  );
  await page.getByRole("textbox", { name: "Explain", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Explain", exact: true })
      .inputValue(),
    "Inbox retained draft",
  );
  await page.goBack();
  await page.goBack();
  await form.getByRole("textbox", { name: "Explain", exact: true }).waitFor();
  assert.equal(
    await form
      .getByRole("textbox", { name: "Explain", exact: true })
      .inputValue(),
    "Inbox retained draft",
  );
  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    assert.equal(await page.locator(".inbox-queue").isVisible(), false);
    await form
      .getByRole("button", { name: "Submit answer", exact: true })
      .scrollIntoViewIfNeeded();
    const box = await form
      .getByRole("button", { name: "Submit answer", exact: true })
      .boundingBox();
    assert.ok(
      box && box.height >= 44 && box.y >= 0 && box.y + box.height <= height,
    );
    const actions = await form
      .locator(".question-submit button")
      .evaluateAll((buttons) =>
        buttons.map((b) => {
          const r = b.getBoundingClientRect();
          return (
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            document
              .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
              ?.closest("button") === b
          );
        }),
      );
    assert.ok(actions.every(Boolean));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await captureBrowserEvidence(page, `390x${height}-inbox-draft`, {
      fullPage: false,
    });
  }
  await page
    .getByRole("button", { name: "Back to queue", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Request kind", { exact: true }).inputValue(),
    "question",
  );
  await page
    .locator(".inbox-row")
    .filter({ hasText: "Choose full form" })
    .click();
  assert.equal(
    await form
      .getByRole("textbox", { name: "Explain", exact: true })
      .inputValue(),
    "Inbox retained draft",
  );
  await form.getByRole("checkbox", { name: "Home", exact: true }).check();
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await form
    .getByText(/Answer recorded/)
    .first()
    .waitFor();
  await page
    .getByText(
      "This request has left the current queue. Its exact detail remains selected.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    new URL(page.url()).searchParams.get("request"),
    a.interactionId,
  );
  assert.equal(
    f.service.coordinationView().readTask(b.taskId).questions[0]?.status,
    "open",
  );
  await captureBrowserEvidence(page, "390-inbox-recorded-selection", {
    fullPage: false,
  });
});

test("collision-shaped literal IDs keep unique DOM controls, label activation and shared restored focus", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const formSchema = {
    version: 1 as const,
    questions: [
      {
        id: "x",
        kind: "single-choice" as const,
        label: "Choice x",
        required: true,
        customAllowed: true,
        options: [
          { id: "a", label: "First option" },
          { id: "b", label: "Second option" },
        ],
      },
      ...["x-0", "x-custom", "x-error"].map((id) => ({
        id,
        kind: "free-text" as const,
        label: `Literal ${id}`,
        required: true,
      })),
    ],
  };
  const a = await seedOwnQuestion(f, formSchema),
    web = await f.startWeb();
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?request=${a.interactionId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const form = page.getByRole("region", { name: "Exact question response" });
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .waitFor();
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  const uniqueIds = async () => {
    const ids = await form
      .locator("[id]")
      .evaluateAll((elements) => elements.map((el) => el.id));
    assert.equal(
      ids.length,
      new Set(ids).size,
      "All control/group/error DOM IDs are unique for literal collision-shaped IDs",
    );
  };
  await uniqueIds();
  const errorField = form.locator('[data-question-id="x-error"]');
  await errorField.locator("label").click();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        ?.closest("[data-question-id]")
        ?.getAttribute("data-question-id"),
    ),
    "x-error",
  );
  await errorField.getByRole("textbox").fill("Retained x-error value");
  const focusedId = await errorField.getByRole("textbox").getAttribute("id");
  assert.ok(focusedId);
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await page.locator(".inbox-row").click();
  await form
    .getByRole("textbox", { name: "Literal x-error", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    focusedId,
  );
  assert.equal(
    await form
      .getByRole("textbox", { name: "Literal x-error", exact: true })
      .inputValue(),
    "Retained x-error value",
  );
  await uniqueIds();
  await page.getByRole("link", { name: "Task evidence", exact: true }).click();
  await page
    .getByRole("link", { name: "Answer question", exact: true })
    .click();
  await form
    .getByRole("textbox", { name: "Literal x-error", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    focusedId,
  );
  await uniqueIds();
  await form.getByText("First option", { exact: true }).click();
  assert.equal(
    await form
      .getByRole("radio", { name: "First option", exact: true })
      .isChecked(),
    true,
  );
  const ordinary = form.locator('[data-question-id="x-0"]');
  await ordinary.locator("label").click();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        ?.closest("[data-question-id]")
        ?.getAttribute("data-question-id"),
    ),
    "x-0",
  );
  await ordinary.getByRole("textbox").fill("Independent x-0");
  assert.equal(
    await form
      .getByRole("radio", { name: "First option", exact: true })
      .isChecked(),
    true,
  );
  const literalCustom = form.locator('[data-question-id="x-custom"]');
  await literalCustom.locator("label").click();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        ?.closest("[data-question-id]")
        ?.getAttribute("data-question-id"),
    ),
    "x-custom",
  );
  await literalCustom.getByRole("textbox").fill("Independent x-custom");
  assert.equal(
    await form
      .getByRole("textbox", { name: "Custom answer: Choice x", exact: true })
      .inputValue(),
    "",
  );
  await form.getByText("Custom answer: Choice x", { exact: true }).click();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        ?.closest("[data-question-id]")
        ?.getAttribute("data-question-id"),
    ),
    "x",
  );
  await form
    .getByRole("textbox", { name: "Custom answer: Choice x", exact: true })
    .fill("Custom x");
  assert.equal(
    await literalCustom.getByRole("textbox").inputValue(),
    "Independent x-custom",
  );
  await form.getByText("Second option", { exact: true }).click();
  assert.equal(
    await form
      .getByRole("radio", { name: "Second option", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await form
      .getByRole("textbox", { name: "Custom answer: Choice x", exact: true })
      .inputValue(),
    "",
  );
  await captureBrowserEvidence(page, "1366-collision-ids", { fullPage: false });
  await form
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await form
    .getByText(/Answer recorded/)
    .first()
    .waitFor();
  const saved = f.service
    .coordinationView()
    .questionForm(a.interactionId)?.answers;
  assert.deepEqual(
    saved,
    Object.fromEntries([
      ["x", { optionIds: ["b"], text: "" }],
      ["x-0", { optionIds: [], text: "Independent x-0" }],
      ["x-custom", { optionIds: [], text: "Independent x-custom" }],
      ["x-error", { optionIds: [], text: "Retained x-error value" }],
    ]),
  );
});
