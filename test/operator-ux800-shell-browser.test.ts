import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui08-shell");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";

async function signIn(
  page: Page,
  origin: string,
  password: string,
  path: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}

async function focusByTab(page: Page, target: import("playwright").Locator) {
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  assert.fail("Keyboard traversal did not reach the expected operator control");
}

test("production shell keeps direct task links usable and the navigation drawer keyboard-safe", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const longProjectName =
    "A project with a deliberately long navigation label for narrow operator layouts";
  const projectId = randomUUID(),
    taskId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: longProjectName,
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Direct shell task",
    outcome: "Inspect responsive navigation",
    ready: false,
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, `/app/tasks/${taskId}`);
  await page
    .getByRole("heading", { name: "Direct shell task", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, `/app/tasks/${taskId}`);

  for (const width of [759, 760, 800, 1119, 1120, 1121, 1366]) {
    await page.setViewportSize({ width, height: 768 });
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const phoneNavigation = document.querySelector<HTMLElement>(".phone-nav");
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const page = document.querySelector<HTMLElement>(".page");
      return {
        sidebar: sidebar ? getComputedStyle(sidebar).display : "missing",
        phoneNavigation: phoneNavigation
          ? getComputedStyle(phoneNavigation).display
          : "missing",
        workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
        pageContentWidth:
          (page?.getBoundingClientRect().width ?? 0) -
          (page ? parseFloat(getComputedStyle(page).paddingInline) * 2 : 0),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(
      geometry.sidebar,
      width <= 1120 ? "none" : "block",
      `${width}px shell navigation mode`,
    );
    assert.equal(
      geometry.phoneNavigation,
      width <= 1120 ? "block" : "none",
      `${width}px drawer trigger mode`,
    );
    assert.ok(
      geometry.documentWidth <= geometry.viewportWidth,
      `${width}px page must not scroll horizontally`,
    );
    if (width === 1121) assert.ok(geometry.pageContentWidth >= 856);
    if (width === 1366) assert.ok(geometry.workspaceWidth >= 1142);
  }
  await captureBrowserEvidence(page, "1121-shell-sidebar-threshold");

  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", {
    name: "Projects and navigation",
    exact: true,
  });
  const phoneTargets = await Promise.all([
    trigger.evaluate((element) => element.getBoundingClientRect().height),
    page
      .getByRole("button", { name: "Sign out", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ]);
  assert.ok(phoneTargets.every((height) => height >= 44));
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Projects and navigation",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    await dialog
      .getByRole("link", { name: "All tasks", exact: true })
      .isVisible(),
    true,
  );
  const longProjectLink = dialog.getByRole("link", {
    name: new RegExp(longProjectName),
  });
  await longProjectLink.waitFor({ state: "visible" });
  const longProjectLayout = await longProjectLink.evaluate((element) => ({
    projectLabel: element.querySelector("span")?.textContent?.trim(),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  assert.equal(longProjectLayout.projectLabel, longProjectName);
  assert.equal(longProjectLayout.whiteSpace, "normal");
  assert.ok(
    longProjectLayout.scrollWidth <= longProjectLayout.clientWidth,
    "long project navigation label wraps without overflowing its link",
  );
  const drawerLinkHeights = await dialog
    .locator(".nav-link")
    .evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height),
    );
  assert.ok(drawerLinkHeights.length > 0);
  assert.ok(drawerLinkHeights.every((height) => height >= 44));
  await dialog.getByRole("link", { name: "Search", exact: true }).click();
  await page.waitForURL("**/app/search");
  await page.goBack();
  await page
    .getByRole("heading", { name: "Direct shell task", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, `/app/tasks/${taskId}`);

  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await page.keyboard.press("Shift+Tab");
  const focusedInsideAfterShiftTab = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  assert.equal(focusedInsideAfterShiftTab, true);
  await page.keyboard.press("Tab");
  const focusedInsideAfterTab = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  assert.equal(focusedInsideAfterTab, true);
  await captureBrowserEvidence(page, "390-shell-drawer-open");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const trigger = document.querySelector(".phone-nav [data-slot=button]");
    return trigger !== null && trigger === document.activeElement;
  });
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
    "closing the drawer restores focus to its trigger",
  );
  assert.equal(new URL(page.url()).pathname, `/app/tasks/${taskId}`);
});

test("shared controls retain visible focus in forced colours and remove optional motion", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID(),
    taskId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Focus fixture project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Focus fixture task",
    outcome: "Inspect keyboard-visible controls",
    ready: false,
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks");
  const search = page.getByRole("textbox", {
    name: "Search tasks",
    exact: true,
  });
  const project = page.getByRole("combobox", { name: "Project", exact: true });
  const list = page.getByRole("button", { name: "List", exact: true });
  await search.waitFor();
  await project.waitFor();
  await focusByTab(page, search);
  const ordinaryFocus = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
    };
  });
  assert.equal(ordinaryFocus.visible, true);
  assert.equal(ordinaryFocus.outlineStyle, "solid");
  assert.ok(ordinaryFocus.outlineWidth >= 2);
  await page.emulateMedia({ forcedColors: "active" });

  for (const control of [search, project, list]) {
    await focusByTab(page, control);
    const focus = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        visible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      };
    });
    assert.equal(focus.visible, true);
    assert.equal(focus.outlineStyle, "solid");
    assert.ok(focus.outlineWidth >= 2);
  }
  assert.equal(await list.getAttribute("aria-pressed"), "true");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  const motion = await list.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      transitionDuration: style.transitionDuration,
      animationDuration: style.animationDuration,
    };
  });
  assert.equal(motion.transitionDuration, "0s");
  assert.equal(motion.animationDuration, "0s");
  assert.equal(await list.textContent(), "List");
  await captureBrowserEvidence(page, "1366-shell-reduced-motion-focus");
});
