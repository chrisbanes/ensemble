import assert from "node:assert/strict";
import { chromium, webkit, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { signOutFromSidebar } from "./fixtures/operator-account.js";
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
    .getByRole("button", { name: "Submit answers", exact: true })
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
    .getByRole("button", { name: "Submit answers", exact: true })
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
    .getByRole("button", { name: "Submit answers", exact: true })
    .click();
  await form
    .getByText(
      "Answer not recorded. Your selection is retained. The request remains unresolved.",
      { exact: true },
    )
    .waitFor();
  await form.getByText("Reason: invalid-input", { exact: true }).waitFor();
  assert.equal(
    await form.getByRole("button", { name: "Retry answer" }).count(),
    1,
  );
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
  await form.getByRole("button", { name: "Retry answer", exact: true }).click();
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
  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    // The frozen original answer is awaiting reconciliation, so its action is the submit button.
    const action = form.getByRole("button", {
      name: "Reconcile original answer",
      exact: true,
    });
    await action.scrollIntoViewIfNeeded();
    const rect = await action.boundingBox();
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
      `Last field remains fully reachable above reserved submission actions: ${JSON.stringify({ lastField, submitTop, height, content: await form.locator(".question-content").boundingBox() })}`,
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
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    commands.push(route.request().postData() ?? "");
    await route.continue();
  });
  await form
    .getByRole("button", { name: "Reconcile original answer", exact: true })
    .click();
  await form.getByRole("heading", { name: "Answer recorded" }).waitFor();
  await form
    .getByText(
      "Delivery waits for the requester's next eligible turn; independent holds are unchanged.",
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
  // Sign out is in the sidebar footer; a nested phone screen reaches it only via its parent.
  await page.setViewportSize({ width: 1366, height: 900 });
  await signOutFromSidebar(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.getByText("Exact typed answer", { exact: true }).count(),
    0,
  );
});

test("opt-in answer textarea grows to its measured bound and preserves selection across Chromium and WebKit resize", async (_t, j) => {
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
  const engines = [
    { name: "chromium", type: chromium },
    { name: "webkit", type: webkit },
  ] as const;
  for (const engine of engines) {
    browser = await j.start(`browser.launch.${engine.name}`, () =>
      engine.type.launch(),
    );
    const page = await browser.newPage({
      viewport: { width: 390, height: 480 },
    });
    j.observe(page);
    page.setDefaultTimeout(5000);
    let commandWrites = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/operator/commands"
      )
        commandWrites++;
    });
    await page.goto(
      `${web.origin}/app/tasks/${a.taskId}?request=${a.interactionId}`,
    );
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const form = page.getByRole("region", { name: "Exact question response" });
    const answer = form.getByRole("textbox", { name: "Explain", exact: true });
    await answer.waitFor();
    await answer.focus();
    const ordinaryFocus = await answer.evaluate((element) => ({
      outlineStyle: getComputedStyle(element).outlineStyle,
      outlineWidth: getComputedStyle(element).outlineWidth,
    }));
    assert.deepEqual(ordinaryFocus, {
      outlineStyle: "solid",
      outlineWidth: "2px",
    });
    if (engine.name === "chromium") {
      await page.emulateMedia({ forcedColors: "active" });
      const forcedFocus = await answer.evaluate((element) => ({
        active: document.activeElement === element,
        outlineStyle: getComputedStyle(element).outlineStyle,
        outlineWidth: getComputedStyle(element).outlineWidth,
        outlineColor: getComputedStyle(element).outlineColor,
      }));
      assert.equal(forcedFocus.active, true);
      assert.equal(forcedFocus.outlineStyle, "solid");
      assert.equal(forcedFocus.outlineWidth, "2px");
      assert.notEqual(forcedFocus.outlineColor, "rgba(0, 0, 0, 0)");
      await page.emulateMedia({ forcedColors: "none" });
    }
    await page.addStyleTag({
      content: ":root { --operator-safe-area-inset-bottom: 24px; }",
    });
    const inset = await form.locator(".question-submit").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        top: Number.parseFloat(style.paddingTop),
        bottom: Number.parseFloat(style.paddingBottom),
      };
    });
    assert.ok(
      inset.bottom >= inset.top + 24,
      `The action footer keeps the emulated 24px inset: ${JSON.stringify(inset)}`,
    );

    const longAnswer = "Review evidence and recovery status. ".repeat(36);
    await answer.fill(longAnswer);
    const initial = await answer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      return {
        value: textarea.value,
        height: textarea.clientHeight,
        scrollHeight: textarea.scrollHeight,
        overflowY: getComputedStyle(textarea).overflowY,
      };
    });
    assert.equal(initial.value, longAnswer);
    assert.ok(
      initial.height >= 96 && initial.height <= 320,
      JSON.stringify(initial),
    );
    assert.ok(initial.scrollHeight > initial.height, JSON.stringify(initial));
    assert.equal(initial.overflowY, "auto");
    await captureBrowserEvidence(page, `${engine.name}-390x480-answer-cap`, {
      fullPage: false,
    });

    const selection = { start: 81, end: 117 };
    await answer.evaluate((element, range) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(range.start, range.end, "forward");
    }, selection);
    await page.setViewportSize({ width: 800, height: 480 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const resized = await answer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      return {
        value: textarea.value,
        height: textarea.clientHeight,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        direction: textarea.selectionDirection,
        focused: document.activeElement === textarea,
      };
    });
    assert.equal(resized.value, longAnswer);
    assert.equal(
      resized.height <= initial.height,
      true,
      JSON.stringify(resized),
    );
    assert.equal(resized.start, selection.start);
    assert.equal(resized.end, selection.end);
    assert.equal(resized.direction, "forward");
    assert.equal(resized.focused, true);
    await page.keyboard.insertText("EDIT");
    const edited = `${longAnswer.slice(0, selection.start)}EDIT${longAnswer.slice(selection.end)}`;
    assert.equal(await answer.inputValue(), edited);
    await page.setViewportSize({ width: 390, height: 480 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const content = form.locator(".question-content");
    const contentMetrics = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        overscroll: getComputedStyle(element).overscrollBehaviorY,
      };
    });
    assert.ok(contentMetrics.scrollHeight > contentMetrics.height);
    assert.ok(contentMetrics.scrollTop > 0);
    assert.equal(contentMetrics.overscroll, "contain");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await form.locator(".question-submit").scrollIntoViewIfNeeded();
    const actions = await form
      .locator(".question-submit button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            document
              .elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              )
              ?.closest("button") === button
          );
        }),
      );
    assert.ok(actions.every(Boolean), JSON.stringify(actions));
    assert.equal(commandWrites, 0);
    j.diagnostics.push(
      JSON.stringify({
        milestone: `${engine.name}-textarea-growth-resize`,
        initial,
        resized,
        inset,
        contentMetrics,
        commandWrites,
        browser: browser.version(),
      }),
    );
    await captureBrowserEvidence(
      page,
      `${engine.name}-800x480-resized-answer`,
      {
        fullPage: false,
      },
    );
    await browser.close();
    browser = undefined;
  }
});

test("Inbox queue and selected detail scroll independently at phone heights", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const questions = [];
  for (let index = 0; index < 7; index++)
    questions.push(
      await seedOwnQuestion(
        f,
        undefined,
        `Scrollable request ${index + 1} ${"project recovery review ".repeat(4)}`,
      ),
    );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch.chromium", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  let commandWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      commandWrites++;
  });
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator(".inbox-row")
    .nth(questions.length - 1)
    .waitFor();
  assert.equal(await page.locator(".inbox-row").count(), questions.length);
  const rows = page.locator(".inbox-rows");
  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    const metrics = await rows.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: getComputedStyle(element).maxHeight,
      overscroll: getComputedStyle(element).overscrollBehaviorY,
    }));
    assert.ok(
      metrics.scrollHeight > metrics.clientHeight,
      JSON.stringify(metrics),
    );
    assert.equal(metrics.overscroll, "contain");
    await rows.evaluate((element) => {
      element.scrollTop = 0;
    });
    await rows.scrollIntoViewIfNeeded();
    const rowBox = await rows.boundingBox();
    assert.ok(rowBox);
    await page.mouse.move(
      rowBox.x + rowBox.width / 2,
      rowBox.y + rowBox.height / 2,
    );
    await page.mouse.wheel(0, 10000);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const atEnd = await rows.evaluate((element) => ({
      scrollTop: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    }));
    assert.ok(
      atEnd.scrollTop > 0 && atEnd.scrollTop >= atEnd.max - 1,
      JSON.stringify({ atEnd, rowBox, height }),
    );
    await captureBrowserEvidence(page, `390x${height}-inbox-queue-end`, {
      fullPage: false,
    });
  }

  await page.setViewportSize({ width: 390, height: 480 });
  await rows.evaluate((element) => {
    element.scrollTop = 0;
  });
  await rows.scrollIntoViewIfNeeded();
  const queuePageScroll = await page.evaluate(() => window.scrollY);
  // A page that cannot scroll up would make the no-chaining check vacuous.
  assert.ok(queuePageScroll > 0, String(queuePageScroll));
  const rowBox = await rows.boundingBox();
  assert.ok(rowBox && rowBox.y >= 0 && rowBox.y + rowBox.height <= 480);
  await page.mouse.move(
    rowBox.x + rowBox.width / 2,
    rowBox.y + rowBox.height / 2,
  );
  await page.mouse.wheel(0, -800);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(await page.evaluate(() => window.scrollY), queuePageScroll);
  await rows
    .locator(".inbox-row")
    .filter({ hasText: "Scrollable request 1" })
    .click();
  const detail = page.locator(".inbox-detail");
  const form = page.getByRole("region", { name: "Exact question response" });
  await form.getByRole("textbox", { name: "Explain", exact: true }).waitFor();
  const detailMetrics = await detail.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overscroll: getComputedStyle(element).overscrollBehaviorY,
  }));
  assert.ok(
    detailMetrics.scrollHeight > detailMetrics.clientHeight,
    JSON.stringify(detailMetrics),
  );
  assert.equal(detailMetrics.overscroll, "contain");
  // The detail is the only question scroll owner; a nested bound would trap the wheel.
  const questionMetrics = await form
    .locator(".question-content")
    .evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
  assert.ok(
    questionMetrics.scrollHeight <= questionMetrics.clientHeight + 1,
    JSON.stringify(questionMetrics),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await detail.evaluate((element) => {
    element.scrollTop = 0;
  });
  const detailPageScroll = await page.evaluate(() => window.scrollY);
  const detailBox = await detail.boundingBox();
  assert.ok(detailBox && detailBox.y + detailBox.height <= 480);
  const submit = form.getByRole("button", {
    name: "Submit answers",
    exact: true,
  });
  // Wheel over the detail, as a reader would, until the action shows.
  let actionBox = null,
    visibleDetail = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.mouse.move(
      detailBox.x + detailBox.width / 2,
      detailBox.y + detailBox.height / 2,
    );
    await page.mouse.wheel(0, 200);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    actionBox = await submit.boundingBox();
    visibleDetail = await detail.boundingBox();
    if (
      actionBox &&
      visibleDetail &&
      actionBox.y >= visibleDetail.y &&
      actionBox.y + actionBox.height <=
        visibleDetail.y + visibleDetail.height &&
      actionBox.y + actionBox.height <= 480
    )
      break;
  }
  assert.ok(
    actionBox &&
      visibleDetail &&
      actionBox.y >= Math.max(0, visibleDetail.y) &&
      actionBox.y + actionBox.height <=
        Math.min(480, visibleDetail.y + visibleDetail.height),
    JSON.stringify({ actionBox, visibleDetail }),
  );
  // Further wheeling at the detail end does not chain into the page.
  await page.mouse.wheel(0, 800);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(await page.evaluate(() => window.scrollY), detailPageScroll);
  await captureBrowserEvidence(page, "390x480-inbox-question-detail", {
    fullPage: false,
  });

  // Each request keeps its own reading position in the shared detail scroller.
  await page.setViewportSize({ width: 1024, height: 600 });
  // Earlier wheel input can leave a smooth-scroll animation running; wait it out.
  const settledScrollTop = () =>
    detail.evaluate(
      (element) =>
        new Promise<number>((resolve) => {
          let last = -1,
            stable = 0;
          const step = () => {
            stable = element.scrollTop === last ? stable + 1 : 0;
            last = element.scrollTop;
            if (stable >= 10) resolve(last);
            else requestAnimationFrame(step);
          };
          step();
        }),
    );
  await settledScrollTop();
  const open = async (title: string) => {
    await rows.locator(".inbox-row").filter({ hasText: title }).click();
    await page
      .getByRole("region", { name: "Exact question response" })
      .getByRole("textbox", { name: "Explain", exact: true })
      .waitFor();
    return settledScrollTop();
  };
  await open("Scrollable request 1");
  await detail.evaluate((element) => {
    element.scrollTop = 150;
    element.dispatchEvent(new Event("scroll"));
  });
  const first = await detail.evaluate((element) => element.scrollTop);
  assert.ok(first > 0, String(first));
  assert.equal(await open("Scrollable request 2"), 0);
  assert.equal(await open("Scrollable request 1"), first);
  assert.equal(commandWrites, 0);
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
  // The datetime attribute carries the millisecond timestamp the read converted from seconds.
  assert.equal(
    new Date(
      (await page.locator(".inbox-row time").first().getAttribute("datetime"))!,
    ).getFullYear(),
    new Date().getFullYear(),
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
      .getByRole("button", { name: "Submit answers", exact: true })
      .scrollIntoViewIfNeeded();
    const box = await form
      .getByRole("button", { name: "Submit answers", exact: true })
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
  // On a phone the header's Back link returns to the queue.
  await page.getByRole("link", { name: "Back to Inbox", exact: true }).click();
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
    .getByRole("button", { name: "Submit answers", exact: true })
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
    .getByRole("button", { name: "Submit answers", exact: true })
    .waitFor();
  await form
    .getByRole("button", { name: "Submit answers", exact: true })
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
  // The only request opens by itself on a wide layout; its draft focus is restored.
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
    .getByRole("button", { name: "Submit answers", exact: true })
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
