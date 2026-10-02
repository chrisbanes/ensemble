import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { tmpdir } from "./temp.js";
const evidence = join(tmpdir(), `ensemble-ui02-evidence-${process.pid}`);
async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
  });
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
  test(`React shell browser lifecycle, states, focus and layout ${viewport.width}`, async (t) => {
    const f = await createOperatorFixture();
    let browser: Browser | undefined;
    t.after(() => f.close(browser));
    const web = await f.startWeb();
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: viewport.width === 683 ? 2 : 1,
    });
    const page = await context.newPage();
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
        };
      });
    assert.equal(loginStyle.background, "rgb(40, 100, 215)");
    assert.equal(loginStyle.foreground, "rgb(255, 255, 255)");
    assert.ok(contrast(loginStyle.foreground, loginStyle.background) >= 4.5);
    assert.match(loginStyle.family, /Instrument Sans/);
    assert.equal(loginStyle.size, "14px");
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
        return {
          active: document.activeElement === el,
          outline: s.outlineStyle,
          width: s.outlineWidth,
          color: s.outlineColor,
        };
      });
    assert.equal(focus.active, true);
    assert.equal(focus.outline, "solid");
    assert.equal(focus.width, "3px");
    assert.equal(focus.color, "rgb(40, 100, 215)");
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
    if (viewport.width < 760) {
      const trigger = page.getByRole("button", {
        name: "Projects and navigation",
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: "Projects and navigation",
      });
      await dialog.waitFor();
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
    assert.match(typography.family, /Space Grotesk/);
    assert.equal(typography.size, "32px");
    assert.equal(typography.weight, "600");
    const supporting = await page
      .locator("main .introduction")
      .evaluate((el) => {
        const s = getComputedStyle(el),
          body = getComputedStyle(document.body);
        return { foreground: s.color, background: body.backgroundColor };
      });
    assert.ok(contrast(supporting.foreground, supporting.background) >= 4.5);
    const badge = await page.locator("main .badge.warning").evaluate((el) => {
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
    console.log(`UI02 browser evidence: ${evidence}`);
  });
test("browser API guards, absolute expiry, successful logout and restart reject private reads and writes", async (t) => {
  const f = await createOperatorFixture();
  let browser: Browser | undefined;
  t.after(() => f.close(browser));
  let web = await f.startWeb();
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
  });
  const page = await context.newPage();
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
  await web.close();
  await f.service.stop();
  await f.service.start();
  web = await f.startWeb();
  assert.notEqual(web.origin, oldOrigin);
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

test("failed browser assertion surfaces without listener/client cleanup deadlock", {
  timeout: 20000,
}, async () => {
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
});
