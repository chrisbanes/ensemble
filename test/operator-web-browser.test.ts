import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui02");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
async function screenshot(page: Page, name: string) {
  return captureBrowserEvidence(page, name);
}
function contrast(first: string, second: string) {
  const luminance = (color: string) => {
    const parts = (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const linear = value / 255;
        return linear <= 0.04045
          ? linear / 12.92
          : ((linear + 0.055) / 1.055) ** 2.4;
      });
    return (
      (parts[0] ?? 0) * 0.2126 +
      (parts[1] ?? 0) * 0.7152 +
      (parts[2] ?? 0) * 0.0722
    );
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
for (const viewport of [
  { width: 1366, height: 820 },
  { width: 390, height: 844 },
  { width: 683, height: 410 },
])
  test(`React shell browser lifecycle, states, focus and layout ${viewport.width}`, async (_t, journey) => {
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
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: viewport.width === 683 ? 2 : 1,
    });
    const page = await context.newPage();
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const external: string[] = [];
    const violations: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(web.origin)) external.push(r.url());
    });
    page.on("console", (m) => {
      if (m.text().includes("Content Security Policy"))
        violations.push(m.text());
    });
    await page.goto(`${web.origin}/login`);
    const loadedFonts = await page.evaluate(async () => {
      await document.fonts.load('400 14px "Inter"');
      await document.fonts.load('400 12px "JetBrains Mono"');
      await document.fonts.ready;
      return {
        inter: document.fonts.check('400 14px "Inter"'),
        mono: document.fonts.check('400 12px "JetBrains Mono"'),
      };
    });
    assert.equal(loadedFonts.inter, true);
    assert.equal(loadedFonts.mono, true);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Existing operator controls", exact: true })
        .count(),
      0,
    );
    await screenshot(page, `${viewport.width}-signin`);
    const loginStyle = await page
      .getByRole("button", { name: "Sign in", exact: true })
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          foreground: s.color,
          background: s.backgroundColor,
          family: s.fontFamily,
          size: s.fontSize,
          height: s.height,
        };
      });
    assert.equal(loginStyle.background, "rgb(229, 229, 229)");
    assert.equal(loginStyle.foreground, "rgb(23, 23, 23)");
    assert.ok(contrast(loginStyle.foreground, loginStyle.background) >= 4.5);
    assert.match(loginStyle.family, /Inter/);
    assert.equal(loginStyle.size, "14px");
    assert.equal(loginStyle.height, viewport.width < 760 ? "44px" : "36px");
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByLabel("Password", { exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await page.keyboard.press("Tab");
    const focus = await page
      .getByRole("button", { name: "Sign in", exact: true })
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { active: document.activeElement === el, ring: s.boxShadow };
      });
    assert.equal(focus.active, true);
    assert.match(focus.ring, /115, 115, 115/);
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .getByLabel("Password", { exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await page.getByLabel("Password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Sign in failed/);
    let release!: () => void;
    const delayed = new Promise<void>((r) => (release = r));
    await page.route("**/api/operator/workspace", async (route) => {
      await delayed;
      await route.continue();
    });
    await page.getByLabel("Password", { exact: true }).fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("Loading projects…", { exact: true }).waitFor();
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    const primaryAction = await page
      .getByRole("link", { name: "New task", exact: true })
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return { foreground: style.color, background: style.backgroundColor };
      });
    assert.equal(primaryAction.foreground, "rgb(23, 23, 23)");
    assert.equal(primaryAction.background, "rgb(229, 229, 229)");
    assert.ok(
      contrast(primaryAction.foreground, primaryAction.background) >= 4.5,
    );
    await screenshot(page, `${viewport.width}-loading`);
    release();
    await page
      .getByText("No projects yet.", { exact: true })
      .first()
      .waitFor({ state: viewport.width < 760 ? "attached" : "visible" });
    await page.unroute("**/api/operator/workspace");
    if (viewport.width < 760)
      await page
        .getByRole("button", { name: "Projects and navigation" })
        .click();
    await screenshot(page, `${viewport.width}-empty`);
    if (viewport.width < 760) await page.keyboard.press("Escape");
    const projectId = randomUUID();
    const name = "Project <script>window.injected=true</script>";
    f.service.domain().execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name,
      leadProfileId: null,
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page
      .locator(`a[href="/app/projects/${projectId}"]`)
      .first()
      .waitFor({ state: viewport.width < 760 ? "attached" : "visible" });
    if (viewport.width >= 760) {
      const desktopNavLinkHeight = await page
        .locator('.sidebar nav[aria-label="Operator navigation"] .nav-link')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      assert.equal(desktopNavLinkHeight, 33.5);
      console.log(
        `UI08 navigation geometry ${viewport.width}px desktop: first sidebar target ${desktopNavLinkHeight}px`,
      );
    }
    if (viewport.width < 760) {
      const trigger = page.getByRole("button", {
        name: "Projects and navigation",
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: "Projects and navigation",
      });
      await dialog.waitFor();
      const phoneNavLinks = await dialog
        .locator('nav[aria-label="Operator navigation"] .nav-link')
        .evaluateAll((links) =>
          links.map((link) => ({
            label: link.textContent?.trim(),
            href: link.getAttribute("href"),
            height: link.getBoundingClientRect().height,
          })),
        );
      assert.deepEqual(
        phoneNavLinks.map(({ href }) => href),
        [
          "/app",
          "/app/inbox",
          "/app/tasks",
          "/app/search",
          `/app/projects/${projectId}`,
          "/app/settings",
          "/",
        ],
      );
      assert.ok(
        phoneNavLinks.every(({ height }) => height >= 44),
        `phone navigation destinations must each be at least 44px tall: ${JSON.stringify(phoneNavLinks)}`,
      );
      console.log(
        `UI08 navigation geometry ${viewport.width}px phone sheet: ${JSON.stringify(phoneNavLinks)}`,
      );
      for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
      assert.equal(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+Tab");
      assert.equal(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      await screenshot(page, `${viewport.width}-populated`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Projects and navigation",
      );
      assert.equal(
        await trigger.evaluate((el) => document.activeElement === el),
        true,
      );
      await trigger.click();
      await dialog.getByRole("link", { name }).click();
      await dialog.waitFor({ state: "hidden" });
      await trigger.click();
      assert.equal(
        await dialog
          .locator(`a[href="/app/projects/${projectId}"]`)
          .getAttribute("aria-current"),
        "page",
      );
      await page.keyboard.press("Escape");
    } else {
      await screenshot(page, `${viewport.width}-populated`);
      await page.getByRole("link", { name }).click();
    }
    await page.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => Object.hasOwn(window, "injected")),
      false,
    );
    await page.reload();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await page.route("**/api/operator/workspace", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unavailable", message: "Unavailable." },
        }),
      }),
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page
      .getByText("Refresh failed. Showing the last fetched data.", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await screenshot(page, `${viewport.width}-stale`);
    await page.unroute("**/api/operator/workspace");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const typography = await page
      .getByRole("heading", { name, exact: true })
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          family: s.fontFamily,
          size: s.fontSize,
          weight: s.fontWeight,
          line: s.lineHeight,
        };
      });
    assert.match(typography.family, /Inter/);
    assert.equal(typography.size, "18px");
    assert.equal(typography.weight, "600");
    const supporting = await page
      .locator("main .introduction")
      .evaluate((el) => {
        const s = getComputedStyle(el),
          body = getComputedStyle(document.body);
        return {
          foreground: s.color,
          background: body.backgroundColor,
          family: s.fontFamily,
          size: s.fontSize,
          weight: s.fontWeight,
        };
      });
    assert.ok(contrast(supporting.foreground, supporting.background) >= 4.5);
    assert.match(supporting.family, /Inter/);
    assert.equal(supporting.size, "14px");
    assert.equal(supporting.weight, "400");
    const badge = await page
      .locator('main [data-slot="badge"]')
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { foreground: s.color, background: s.backgroundColor };
      });
    assert.ok(contrast(badge.foreground, badge.background) >= 4.5);
    if (viewport.width === 683) await screenshot(page, "1366-zoom200");
    const action = page.getByRole("link", {
      name: "Open existing project controls",
      exact: true,
    });
    await action.scrollIntoViewIfNeeded();
    assert.equal(
      await action.evaluate((el) => {
        const box = el.getBoundingClientRect(),
          x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        return (
          box.x >= 0 &&
          box.right <= innerWidth &&
          y >= 0 &&
          y <= innerHeight &&
          el.contains(document.elementFromPoint(x, y))
        );
      }),
      true,
    );
    await page
      .getByRole("link", {
        name: "Open existing project controls",
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", { name: "Project configuration", exact: true })
      .waitFor();
    await page.goto(`${web.origin}/app`);
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    await page.route("**/api/operator/logout", (route) => route.abort());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Sign-out outcome is unknown" })
      .waitFor();
    await page.unroute("**/api/operator/logout");
    f.advanceClock(60001);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name }).count(), 0);
    assert.deepEqual(external, []);
    assert.deepEqual(violations, []);
    assert.deepEqual(pageErrors, []);
    console.log(`UI02 browser evidence: ${journey.directory}`);
  });
test("browser API guards, absolute expiry, successful logout and restart reject private reads and writes", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  let web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  let context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
  });
  let page = await context.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const session = (await (
    await context.request.get(`${web.origin}/api/operator/session`)
  ).json()) as { csrfToken: string };
  for (const headers of [
    { Origin: "null", "X-CSRF-Token": session.csrfToken },
    { Origin: "https://foreign.invalid", "X-CSRF-Token": session.csrfToken },
    { Origin: web.origin, "X-CSRF-Token": "wrong" },
    { "X-CSRF-Token": session.csrfToken },
  ]) {
    const response = await context.request.post(
      `${web.origin}/api/operator/commands`,
      { headers, data: {} },
    );
    assert.equal(response.status(), 403);
  }
  const spoof = await context.request.get(
    `${web.origin}/api/operator/workspace`,
    {
      headers: {
        Host: "foreign.invalid",
        "X-Forwarded-Host": new URL(web.origin).host,
        "X-Forwarded-Proto": "http",
      },
    },
  );
  assert.equal(spoof.status(), 403);
  assert.equal(f.service.domain().projects().length, 0);
  for (let i = 0; i < 5; i++) {
    f.advanceClock(50000);
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/operator/workspace"),
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  }
  f.advanceClock(50001);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    (
      await context.request.get(`${web.origin}/api/operator/workspace`)
    ).status(),
    401,
  );
  assert.equal(
    (
      await context.request.post(`${web.origin}/api/operator/commands`, {
        headers: { Origin: web.origin, "X-CSRF-Token": session.csrfToken },
        data: {},
      })
    ).status(),
    401,
  );
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    (
      await context.request.get(`${web.origin}/api/operator/workspace`)
    ).status(),
    401,
  );
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const oldOrigin = web.origin;
  const authenticatedState = await context.storageState();
  assert.ok(
    authenticatedState.cookies.some(
      (cookie) =>
        cookie.name === "ensemble_operator_session" && cookie.value.length > 0,
    ),
  );
  const oldBrowser = browser;
  assert.ok(oldBrowser);
  await journey.closeStep(
    "browser.close.before-restart",
    () => oldBrowser.close(),
    f.lifecycle,
  );
  browser = undefined;
  assert.equal(
    f.lifecycle.steps.find(
      (step) => step.name === "browser.close.before-restart",
    )?.status,
    "completed",
  );
  await web.close();
  await journey.closeStep("service.stop", () => f.service.stop(), f.lifecycle);
  journey.restart();
  await journey.start("service.start", () => f.service.start());
  web = await journey.start("fixture.web", () => f.startWeb());
  assert.notEqual(web.origin, oldOrigin);
  browser = await journey.start("browser.launch.after-restart", () =>
    chromium.launch(),
  );
  context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    storageState: authenticatedState,
  });
  page = await context.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  assert.equal(
    (
      await context.request.get(`${web.origin}/api/operator/workspace`)
    ).status(),
    401,
  );
  await page.goto(`${web.origin}/app`);
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(f.runtime.turns, 0);
});

test("React shell announces an unavailable Codex runtime without a reload", async (_t, journey) => {
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
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
  });
  const page = await context.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/login`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const banner = page
    .getByRole("alert")
    .filter({ hasText: "Codex runtime unavailable — restart the service" });
  await page.getByText("No projects yet.", { exact: true }).first().waitFor();
  assert.equal(await banner.count(), 0);
  f.runtime.crash();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await banner.waitFor();
  assert.equal(await banner.count(), 1);
});

test("React shell Inbox poll surfaces a runtime failure on its own", async (_t, journey) => {
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
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
  });
  const page = await context.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/login`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const loaded = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/workspace"),
  );
  await page.goto(`${web.origin}/app/inbox`);
  await loaded;
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  const banner = page
    .getByRole("alert")
    .filter({ hasText: "Codex runtime unavailable — restart the service" });
  assert.equal(await banner.count(), 0);
  f.runtime.crash();
  await page.clock.fastForward(16000);
  await banner.waitFor();
});

nodeTest(
  "failed browser assertion surfaces without listener/client cleanup deadlock",
  {
    timeout: 20000,
  },
  async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--test-timeout=15000",
        fileURLToPath(
          new URL("./fixtures/operator-browser-failure.js", import.meta.url),
        ),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const [code] = await once(child, "close");
    assert.equal(code, 1, output);
    assert.match(
      output,
      /Injected browser assertion must surface before cleanup rescue/,
    );
    assert.doesNotMatch(output, /owned client watchdog rescue/, output);
    const directory = output.match(/failure fixture removed: ([^\r\n]+)/)?.[1];
    assert.ok(directory, output);
    await assert.rejects(access(directory));
  },
);
