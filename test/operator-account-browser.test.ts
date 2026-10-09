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
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
      };
    });
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
    let release!: () => void;
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
