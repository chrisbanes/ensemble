import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui08-account");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";

const viewports = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** One fixture, web service and browser page per journey. */
async function launch(
  journey: BrowserJourney,
  viewport: { width: number; height: number },
) {
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
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  return { f, web, page };
}

async function submitPassword(page: Page, password: string) {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^Sign in/ }).click();
}

for (const viewport of viewports)
  test(`sign-in layout, failure, pending and success ${viewport.name}`, async (_t, journey) => {
    const { web, page } = await launch(journey, viewport);
    await page.goto(`${web.origin}/login`);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.locator(".sidebar").count(), 0);
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw Error(`missing ${selector}`);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          size: style.fontSize,
          weight: style.fontWeight,
        };
      };
      return {
        content: box(".login-content"),
        wordmark: box(".wordmark"),
        heading: box(".login-content h1"),
        form: box(".login-content form"),
        button: box(".login-content form button"),
        fieldGap: getComputedStyle(
          document.querySelector(".login-content .field") as Element,
        ).rowGap,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
      };
    });
    assert.equal(layout.fieldGap, "8px", "label sits 8px above its field");
    assert.equal(layout.wordmark.size, "16px");
    assert.equal(layout.wordmark.weight, "500");
    assert.equal(layout.heading.size, "18px");
    assert.equal(layout.heading.weight, "600");
    await page.getByText("Your operator workspace.", { exact: true }).waitFor();
    assert.equal(
      layout.content.width,
      viewport.width === 390 ? 350 : 360,
      "content width",
    );
    if (viewport.width === 390)
      assert.equal(layout.content.x, 20, "20px phone gutter");
    assert.ok(
      Math.abs(
        layout.content.y +
          layout.content.height / 2 -
          layout.viewportHeight / 2,
      ) <= 4,
      "content is vertically centred",
    );
    assert.equal(layout.button.width, layout.form.width, "full-width button");
    assert.equal(layout.button.height, viewport.width === 390 ? 44 : 32);
    await captureBrowserEvidence(page, `${viewport.name}-signin`);

    // Failure: one generic message, cleared field, focus returned, aria state.
    await submitPassword(page, "wrong");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    assert.equal(await alert.innerText(), "Sign in failed. Try again.");
    const field = page.getByLabel("Password", { exact: true });
    assert.equal(await field.inputValue(), "");
    assert.equal(await field.getAttribute("aria-invalid"), "true");
    assert.ok(await field.getAttribute("aria-describedby"));
    assert.equal(
      await field.evaluate((el) => el === document.activeElement),
      true,
      "focus returns to the password field",
    );
    await captureBrowserEvidence(page, `${viewport.name}-signin-failed`);

    // A lockout response reveals nothing beyond the generic message.
    await page.route("**/api/operator/login", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "rate-limited",
            message: "Account locked after 5 failed attempts",
          },
        }),
      }),
    );
    await submitPassword(page, "wrong again");
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.getByRole("alert").innerText(),
      "Sign in failed. Try again.",
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /lock|attempt/i,
    );
    await page.unroute("**/api/operator/login");

    // Pending keeps the value, disables the field and button.
    // A failed assertion must not leave the held request blocking cleanup.
    let release: () => void = () => {};
    try {
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/operator/login", async (route) => {
        await held;
        await route.continue();
      });
      await submitPassword(page, web.password);
      const pending = page.getByRole("button", { name: "Signing in…" });
      await pending.waitFor();
      assert.equal(await pending.isDisabled(), true);
      assert.equal(await field.isDisabled(), true);
      assert.equal(await field.inputValue(), web.password);
      await captureBrowserEvidence(page, `${viewport.name}-signin-pending`);
      release();
      await page
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/app");
    } finally {
      release();
    }
  });

for (const viewport of viewports)
  test(`expired session returns to sign-in at the same address ${viewport.name}`, async (_t, journey) => {
    const { f, web, page } = await launch(journey, viewport);
    f.service.domain().execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId: randomUUID(),
      name: "Expiry project",
      leadProfileId: null,
    });
    // Cold visit: sign-in without any expiry text.
    await page.goto(`${web.origin}/app/tasks`);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.getByText(/session expired/i).count(), 0);
    await submitPassword(page, web.password);
    await page
      .getByRole("heading", { name: "All tasks", exact: true })
      .waitFor();
    await page.goto(`${web.origin}/app/tasks/new`);
    const title = page.getByLabel("Task title");
    await title.fill("Private draft title that must not survive expiry");
    f.advanceClock(61_000);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    const notice = page.getByRole("status");
    await notice
      .getByText("Your session expired. Sign in to continue.")
      .waitFor();
    await notice.getByText("Private state cleared", { exact: true }).waitFor();
    await notice
      .getByText(
        "Unsent local drafts and private reading/navigation state were cleared under the existing session rules.",
      )
      .waitFor();
    await notice
      .getByText(
        "Unfinished task input is offered for recovery on this device.",
      )
      .waitFor();
    assert.equal(new URL(page.url()).pathname, "/app/tasks/new");
    assert.doesNotMatch(await page.content(), /Private draft title/);
    await captureBrowserEvidence(page, `${viewport.name}-signin-expired`);
    await submitPassword(page, web.password);
    // Existing on-device recovery: unfinished composer input is offered, never restored silently.
    await page
      .getByRole("button", { name: "Discard unfinished input", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/app/tasks/new");
    assert.equal(await page.getByLabel("Task title").inputValue(), "");
    assert.equal(await page.getByText(/session expired/i).count(), 0);
  });

for (const viewport of viewports)
  test(`unknown addresses render Page not found inside the shell ${viewport.name}`, async (_t, journey) => {
    const { web, page } = await launch(journey, viewport);
    // Signed out: sign-in first, then the same address shows Page not found.
    await page.goto(`${web.origin}/app/no-such-page`);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await submitPassword(page, web.password);
    const heading = page.getByRole("heading", {
      name: "Page not found",
      exact: true,
    });
    await heading.waitFor();
    assert.equal(new URL(page.url()).pathname, "/app/no-such-page");

    const response = await page.goto(`${web.origin}/app/no-such-page`);
    assert.equal(response?.status(), 404);
    await heading.waitFor();
    await page
      .getByText(
        "This address doesn't match an Ensemble page. Nothing was changed.",
        { exact: true },
      )
      .waitFor();
    if (viewport.width === 390)
      await page
        .getByRole("button", { name: "Projects and navigation" })
        .waitFor();
    else await page.locator(".sidebar").waitFor();
    assert.equal(await page.locator('[aria-current="page"]').count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Refresh", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("link", { name: /Open existing/ }).count(),
      0,
    );
    assert.equal(await page.locator("main h1").count(), 1);
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth)) <=
        (await page.evaluate(() => document.documentElement.clientWidth)),
      "no horizontal scroll",
    );
    await captureBrowserEvidence(page, `${viewport.name}-not-found`);
    await page
      .getByRole("link", { name: "Go to Overview", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).pathname, "/app");

    // Signed in, /login lands on Overview.
    await page.goto(`${web.origin}/login`);
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).pathname, "/app");
  });

test("a malformed project id renders Page not found without a task action", async (_t, journey) => {
  const { web, page } = await launch(journey, viewports[0]);
  await page.goto(`${web.origin}/app`);
  await submitPassword(page, web.password);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.goto(`${web.origin}/app/projects/not-a-uuid`);
  await page
    .getByRole("heading", { name: "Page not found", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Go to Overview", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "New task", exact: true }).count(),
    0,
  );
});

test("an unknown settings address keeps the phone menu header, not a detail header", async (_t, journey) => {
  const { web, page } = await launch(journey, viewports[1]);
  await page.goto(`${web.origin}/app`);
  await submitPassword(page, web.password);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.goto(`${web.origin}/app/settings/typo`);
  await page
    .getByRole("heading", { name: "Page not found", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Projects and navigation" }).waitFor();
  assert.equal(await page.getByRole("link", { name: /^Back to/ }).count(), 0);
});

test("desktop account menu: pointer, keyboard, pending and unknown-outcome sign-out", async (_t, journey) => {
  const { web, page } = await launch(journey, viewports[0]);
  await page.goto(`${web.origin}/app`);
  await submitPassword(page, web.password);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const sidebar = page.locator(".sidebar");
  const trigger = page.getByRole("button", {
    name: "Operator account",
    exact: true,
  });

  // Closed: only the trigger, with avatar, name and a decorative chevron.
  assert.equal(await trigger.locator(".account-avatar").innerText(), "OP");
  assert.match(await trigger.innerText(), /Operator/);
  assert.equal(await trigger.locator("svg[aria-hidden='true']").count(), 1);
  assert.equal(await trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    await sidebar.getByRole("link", { name: "Settings" }).count(),
    0,
  );
  assert.equal(
    await sidebar.getByRole("button", { name: "Sign out" }).count(),
    0,
  );

  // Pointer: opens with the label and three items; an outside press closes it.
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await menu.getByText("Signed in as Operator", { exact: true }).waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Settings", exact: true })
      .getAttribute("href"),
    "/app/settings",
  );
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Runtime", exact: true })
      .getAttribute("href"),
    "/app/settings/runtime",
  );
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 3);
  await captureBrowserEvidence(page, "desktop-account-menu");
  await page.locator("main h1").click();
  await menu.waitFor({ state: "detached" });

  // A pointer-opened menu keeps focus on the trigger; Tab leaves it and closes the menu.
  await trigger.click();
  await menu.waitFor();
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");

  // Keyboard.
  await page.getByRole("link", { name: "New project", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await trigger.evaluate((el) => el === document.activeElement),
    true,
  );
  const focused = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  await menu.waitFor();
  assert.equal(await focused(), "Settings");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "Runtime");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "Sign out");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "Settings", "wraps to the first item");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "Sign out", "wraps to the last item");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "Runtime");
  await page.keyboard.press("Home");
  assert.equal(await focused(), "Settings");
  await page.keyboard.press("End");
  assert.equal(await focused(), "Sign out");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(
    await trigger.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("ArrowUp");
  await menu.waitFor();
  assert.equal(await focused(), "Sign out", "ArrowUp opens on the last item");
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  assert.equal(
    await trigger.evaluate((el) => el === document.activeElement),
    true,
    "Tab closes the menu and returns focus to the trigger",
  );
  await page.keyboard.press("ArrowDown");
  await menu.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/app/settings/runtime");
  await menu.waitFor({ state: "detached" });
  await page.keyboard.press("Tab");
  assert.equal(
    await menu.count(),
    0,
    "history navigation leaves the menu closed",
  );
  await page
    .getByRole("menuitem", { name: "Runtime" })
    .waitFor({ state: "detached" });

  // Pending sign-out keeps the menu open and the item disabled.
  // A failed assertion must not leave the held request blocking cleanup.
  let release: () => void = () => {};
  try {
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/operator/logout", async (route) => {
      await held;
      await route.continue();
    });
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    const pending = menu.getByRole("menuitem", { name: "Signing out…" });
    await pending.waitFor();
    assert.equal(await pending.getAttribute("aria-disabled"), "true");
    await captureBrowserEvidence(page, "desktop-account-menu-signing-out");
    release();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await page.unroute("**/api/operator/logout");

    // Unknown outcome: the status check keeps the session and Sign out can be retried.
    await submitPassword(page, web.password);
    await trigger.waitFor();
    await page.route("**/api/operator/logout", (route) => route.abort());
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({
        hasText:
          "Sign-out outcome is unknown. Session status has been checked; review before retrying.",
      })
      .waitFor();
    await page.unroute("**/api/operator/logout");
    await trigger.click();
    assert.equal(
      await menu
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .isEnabled(),
      true,
    );
    await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  } finally {
    release();
  }
});

test("phone drawer shows the account group with Settings, Runtime and Sign out", async (_t, journey) => {
  const { web, page } = await launch(journey, viewports[1]);
  await page.goto(`${web.origin}/app`);
  await submitPassword(page, web.password);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const open = () =>
    page.getByRole("button", { name: "Projects and navigation" }).click();
  await open();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Signed in as Operator", { exact: true }).waitFor();
  for (const name of ["Settings", "Runtime"]) {
    const row = dialog.getByRole("link", { name, exact: true });
    assert.ok(
      (await row.evaluate((el) => el.getBoundingClientRect().height)) >= 44,
      `${name} row is a phone target`,
    );
  }
  assert.ok(
    (await dialog
      .getByRole("button", { name: "Sign out", exact: true })
      .evaluate((el) => el.getBoundingClientRect().height)) >= 44,
  );
  await captureBrowserEvidence(page, "phone-account-drawer");
  await dialog.getByRole("link", { name: "Runtime", exact: true }).click();
  await page.waitForURL("**/app/settings/runtime");
  const back = page.getByRole("link", {
    name: "Back to Settings",
    exact: true,
  });
  await back.click();
  await page.waitForURL("**/app/settings");
  await open();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
});
