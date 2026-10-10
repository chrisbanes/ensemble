import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui08-shell");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { mixedForm } from "./fixtures/question-data.js";
import { seedOwnQuestion } from "./fixtures/questions.js";

async function signIn(
  page: Page,
  origin: string,
  password: string,
  path: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
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
      const display = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).display : "missing";
      };
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const page = document.querySelector<HTMLElement>(".page");
      return {
        sidebar: display(".sidebar"),
        back: display(".page-header-back"),
        menu: display(".phone-nav"),
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
      width <= 1120 ? "none" : "flex",
      `${width}px shell navigation mode`,
    );
    assert.equal(
      geometry.back,
      width <= 1120 ? "flex" : "none",
      `${width}px nested-route Back mode`,
    );
    assert.equal(
      geometry.menu,
      "missing",
      `${width}px nested route has no menu`,
    );
    assert.ok(
      geometry.documentWidth <= geometry.viewportWidth,
      `${width}px page must not scroll horizontally`,
    );
    if (width === 1121) assert.ok(geometry.pageContentWidth >= 856);
    if (width === 1366) assert.ok(geometry.workspaceWidth >= 1142);
  }
  await captureBrowserEvidence(page, "1121-shell-sidebar-threshold");

  // Nested screens use the detail header: Back to the static parent, no menu.
  await page.setViewportSize({ width: 390, height: 844 });
  const back = page.getByRole("link", { name: "Back to Tasks", exact: true });
  assert.ok(
    (await back.evaluate((e) => e.getBoundingClientRect().height)) >= 44,
  );
  assert.equal(await page.locator("main h1").count(), 1);
  await back.click();
  await page.waitForURL("**/app/tasks");
  await page.locator("main.page h1").waitFor();

  const trigger = page.getByRole("button", {
    name: "Projects and navigation",
    exact: true,
  });
  const phoneTargets = await trigger.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.width, rect.height];
  });
  assert.ok(phoneTargets.every((size) => (size ?? 0) >= 44));
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Projects and navigation",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    await dialog.getByRole("link", { name: "Tasks", exact: true }).isVisible(),
    true,
  );
  const signOutHeight = await dialog
    .getByRole("button", { name: "Sign out", exact: true })
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(signOutHeight >= 44, "drawer Sign out is a phone target");
  assert.equal(
    await page
      .getByRole("link", { name: "Existing operator controls" })
      .count(),
    0,
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
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/tasks");

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
  assert.equal(new URL(page.url()).pathname, "/app/tasks");

  // Browser Back from an open drawer to a nested screen closes it; Forward does not reopen it.
  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await page.goBack();
  await page.getByRole("link", { name: "Back to Tasks" }).waitFor();
  assert.equal(await dialog.count(), 0);
  await page.goForward();
  await trigger.waitFor();
  assert.equal(await dialog.count(), 0);

  // Sign out through the drawer ends the session at phone width.
  await trigger.click();
  await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).waitFor();
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

const inboxResponse = (response: import("playwright").Response) =>
  new URL(response.url()).pathname === "/api/operator/inbox";

test("desktop shell lists the designed destinations, an honest Inbox count and a footer account group", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await seedOwnQuestion(f);
  await seedOwnQuestion(f, mixedForm, "Second task");
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const sidebar = page.locator(".sidebar");
  await sidebar.locator('a[href="/app/inbox"] .nav-count').waitFor();
  const labels = await sidebar
    .locator('nav[aria-label="Operator navigation"] a')
    .evaluateAll((links) =>
      links.map((link) => ({
        label: link.querySelector(".nav-label")?.textContent?.trim(),
        href: link.getAttribute("href"),
      })),
    );
  assert.deepEqual(labels.slice(0, 4), [
    { label: "Overview", href: "/app" },
    { label: "Inbox", href: "/app/inbox" },
    { label: "Tasks", href: "/app/tasks" },
    { label: "Search", href: "/app/search" },
  ]);
  assert.deepEqual(labels.at(-1), {
    label: "New project",
    href: "/app/settings/projects/new",
  });
  assert.ok(
    labels
      .slice(4, -1)
      .every((entry) => entry.href?.startsWith("/app/projects/")),
  );
  assert.equal(
    await sidebar.locator('a[href="/app/inbox"] .nav-count').textContent(),
    "2",
  );
  assert.equal(
    await sidebar
      .getByRole("link", { name: "Inbox", exact: true })
      .evaluate(
        (link) =>
          document.getElementById(link.getAttribute("aria-describedby") ?? "")
            ?.textContent,
      ),
    "2 unresolved",
  );
  assert.equal(
    await sidebar.locator('nav a svg[aria-hidden="true"]').count(),
    labels.length,
    "every sidebar item has a decorative icon",
  );
  // The account menu replaces the footer's Settings link and Sign out button.
  assert.equal(
    await sidebar.getByRole("link", { name: "Settings", exact: true }).count(),
    0,
  );
  await sidebar
    .getByRole("button", { name: "Operator account", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Existing operator controls" })
      .count(),
    0,
  );
  assert.equal(await page.getByText("Operator workspace").count(), 0);
  assert.equal(await page.locator("main h1").count(), 1);

  // On the Inbox route the shell count is the list's own total, and the header explains it.
  await page.goto(`${web.origin}/app/inbox`);
  await page.locator(".inbox-row").first().waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 2);
  await sidebar.locator('a[href="/app/inbox"] .nav-count').waitFor();
  assert.equal(
    await sidebar.locator('a[href="/app/inbox"] .nav-count').textContent(),
    "2",
  );
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "2 unresolved across 2 projects",
  );
  assert.equal(
    await page.locator(".page-header-count").textContent(),
    "2 unresolved",
  );

  await page.goto(`${web.origin}/app/tasks?view=board`);
  await page.locator("main.page h1").waitFor();
  const current = await sidebar
    .locator('a[aria-current="page"]')
    .evaluateAll((links) => links.map((link) => link.textContent?.trim()));
  assert.deepEqual(current, ["Tasks"]);
  await page.goto(`${web.origin}/app/tasks`);
  // goto resolves before the shell mounts; evaluateAll does not auto-wait.
  await sidebar.locator('a[aria-current="page"]').first().waitFor();
  assert.deepEqual(
    await sidebar
      .locator('a[aria-current="page"]')
      .evaluateAll((links) => links.map((link) => link.textContent?.trim())),
    ["Tasks"],
  );
  // Overview and the task views carry their subtitle and the one primary action in the header.
  await page.goto(`${web.origin}/app`);
  await page.locator("main.page h1").waitFor();
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "Tasks across your projects. Action requests and ordinary progress remain distinct.",
  );
  assert.equal(
    await page
      .locator(".page-header")
      .getByRole("link", { name: "New task", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page.getByRole("link", { name: "New task", exact: true }).count(),
    1,
  );

  // A failed Inbox read shows no number rather than a stale or partial one.
  await page.route("**/api/operator/inbox*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "Unavailable." },
      }),
    }),
  );
  const failed = page.waitForResponse(inboxResponse);
  await page.goto(`${web.origin}/app/settings`);
  await failed;
  await page.locator("main.page h1").waitFor();
  assert.equal(await sidebar.locator(".nav-count").count(), 0);
  await sidebar.getByRole("link", { name: "Inbox", exact: true }).waitFor();
  await captureBrowserEvidence(page, "1366-shell-inbox-count-unavailable");
});

test("page-owned refresh replaces the shell Refresh and still re-reads the workspace", async (_t, journey) => {
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
    name: "Refresh project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Refresh task fixture",
    outcome: "Inspect refresh ownership",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const owned: [string, string][] = [
    ["/app", "Refresh tasks"],
    ["/app/tasks", "Refresh tasks"],
    [`/app/projects/${projectId}`, "Refresh tasks"],
    [`/app/tasks/${taskId}`, "Refresh task"],
    ["/app/search?query=Refresh", "Refresh results"],
  ];
  for (const [route, name] of owned) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    const button = page.getByRole("button", { name, exact: true });
    await button.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh", exact: true }).count(),
      0,
      `${route} has only its page-owned refresh`,
    );
    const workspace = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/operator/workspace",
    );
    const inbox = page.waitForResponse(inboxResponse);
    await button.click();
    await workspace;
    await inbox;
  }
  for (const route of ["/app/inbox", "/app/settings"]) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh", exact: true }).count(),
      1,
      `${route} keeps one Refresh`,
    );
  }
  for (const route of [
    ...owned.map(([r]) => r),
    "/app/inbox",
    "/app/settings",
  ]) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(
      await page.getByText(/^Fetched /).count(),
      0,
      `${route} shows no fresh Fetched line`,
    );
  }
});

test("every route renders in the shell on desktop and phone without horizontal scroll", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const domain = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Shell lead",
    instructions: "Fixture only",
    capabilities: "Coordinate",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Shell project",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Shell task",
    outcome: "Inspect every route",
    ready: false,
  });
  domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Inspect every route",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  await seedOwnQuestion(f);
  await seedOwnQuestion(f, mixedForm, "Second task");
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const notFound = "/app/does-not-exist";
  // [route, evidence name, top-level on a phone]
  const routes: [string, string | null, boolean][] = [
    ["/app", "overview", true],
    ["/app/inbox", "inbox", true],
    ["/app/tasks", null, true],
    ["/app/tasks?view=board", null, true],
    ["/app/search", null, true],
    [`/app/projects/${projectId}`, null, true],
    [`/app/projects/${projectId}/settings`, null, false],
    ["/app/tasks/new", null, false],
    [`/app/tasks/${taskId}`, null, false],
    ["/app/settings", "settings", true],
    ["/app/settings/runtime", null, false],
    ["/app/settings/projects/new", null, false],
    ["/app/settings/profiles/new", null, false],
    [`/app/profiles/${profileId}/settings`, null, false],
    [`/app/assignments/${assignmentId}/recovery`, null, false],
    [notFound, null, true],
  ];
  for (const [width, height] of [
    [1366, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const [route, evidence, topLevel] of routes) {
      // The service answers unknown /app paths itself, so the in-app
      // not-found screen is reached by client-side navigation.
      if (route === notFound)
        await page.evaluate((path) => {
          history.pushState({}, "", path);
          dispatchEvent(new PopStateEvent("popstate"));
        }, route);
      else await page.goto(web.origin + route);
      await page
        .locator("main.page h1")
        .waitFor()
        .catch(() => assert.fail(`${width} ${route}: no signed-in title`));
      await page.waitForLoadState("networkidle");
      const state = await page.evaluate(() => {
        const visible = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          return (
            element !== null &&
            getComputedStyle(element).display !== "none" &&
            element.getBoundingClientRect().width > 0
          );
        };
        return {
          h1: document.querySelectorAll("main h1").length,
          sidebar: visible(".sidebar"),
          variant: document
            .querySelector(".page-header")
            ?.getAttribute("data-variant"),
          menu: visible(".phone-nav [data-slot=button]"),
          back: visible(".page-header-back"),
          overflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      assert.equal(state.h1, 1, `${width} ${route}: one h1`);
      assert.equal(state.overflow, false, `${width} ${route}: no scroll`);
      if (width === 1366)
        assert.equal(state.sidebar, true, `${route}: sidebar visible`);
      else {
        assert.equal(state.sidebar, false, `${route}: drawer replaces sidebar`);
        assert.equal(
          state.variant,
          topLevel ? "top-level" : "detail",
          `${route}: phone header variant`,
        );
        assert.equal(state.menu, topLevel, `${route}: menu button`);
        assert.equal(state.back, !topLevel, `${route}: Back link`);
      }
      if (width === 390 && route === "/app/inbox")
        assert.equal(
          await page.locator(".page-header-count").textContent(),
          "2 unresolved",
          "phone header count reads as text",
        );
      if (evidence) await captureBrowserEvidence(page, `${width}-${evidence}`);
      if (width === 390 && route === `/app/tasks/${taskId}`)
        await captureBrowserEvidence(page, "390-task-detail-header");
    }
    if (width === 390) {
      await page.goto(`${web.origin}/app`);
      await page.locator("main.page h1").waitFor();
      await page
        .getByRole("button", { name: "Projects and navigation", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Projects and navigation", exact: true })
        .waitFor();
      await captureBrowserEvidence(page, "390-drawer");
    }
  }
});
