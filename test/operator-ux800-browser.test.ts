import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ux800-matrix");
import { chromium, webkit, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedOwnQuestion } from "./fixtures/questions.js";

const longTitle =
  "Reconcile the deliberately long operator task title that must stay readable in compact rows";

// Controls that are clipped by the viewport or squeezed below a readable width.
function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const inScroller = (element: Element) => {
      for (let e = element.parentElement; e; e = e.parentElement) {
        const x = getComputedStyle(e).overflowX;
        // Only a real horizontal scroller (the Board) may hold controls offscreen.
        if ((x === "auto" || x === "scroll") && e.scrollWidth > e.clientWidth)
          return true;
      }
      return false;
    };
    if (document.documentElement.scrollWidth > innerWidth)
      problems.push(
        `page scrolls horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`,
      );
    for (const element of document.querySelectorAll(
      "main a, main button, main input, main select, main textarea",
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || inScroller(element)) continue;
      if (rect.left < -1 || rect.right > innerWidth + 1)
        problems.push(
          `clipped ${element.tagName} "${element.textContent?.trim().slice(0, 40)}"`,
        );
    }
    // Any squeezed row fact reproduces the original letter-per-line collapse.
    for (const fact of document.querySelectorAll(".task-row > *")) {
      const width = fact.getBoundingClientRect().width;
      if (fact.textContent?.trim() && width < 100)
        problems.push(
          `task row fact "${fact.textContent.trim().slice(0, 30)}" squeezed to ${Math.round(width)}px`,
        );
    }
    return problems;
  });
}

test("finite Chromium and WebKit matrix keeps operator routes usable without clipping", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const question = await seedOwnQuestion(f, undefined, longTitle);
  const d = f.service.domain();
  for (let index = 0; index < 4; index++)
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: question.projectId,
      taskId: randomUUID(),
      title: `${longTitle} ${index + 1}`,
      outcome: "Inspect responsive layout",
      ready: index % 2 === 0,
    });
  const web = await journey.start("fixture.web", () => f.startWeb());
  const routes = {
    overview: "/app",
    tasks: "/app/tasks",
    project: `/app/projects/${question.projectId}`,
    inbox: "/app/inbox",
    question: `/app/tasks/${question.taskId}?request=${question.interactionId}`,
    composer: `/app/tasks/new?project=${question.projectId}`,
    search: "/app/search?query=Reconcile",
    settings: "/app/settings",
  };
  const all = Object.keys(routes) as (keyof typeof routes)[];
  const matrix: [number, number, (keyof typeof routes)[]][] = [
    [390, 844, all],
    [390, 480, ["inbox", "question", "composer"]],
    [759, 768, ["overview", "tasks"]],
    [760, 768, ["overview", "tasks", "inbox"]],
    [800, 768, ["tasks", "project", "inbox", "question"]],
    [1024, 768, all],
    [1121, 768, ["overview", "tasks"]],
    [1366, 900, all],
    // 200% zoom of a 1366×900 laptop, expressed in CSS pixels.
    [683, 450, ["tasks", "question", "composer"]],
  ];
  const evidence = new Set([
    "390x844:tasks",
    "390x480:question",
    "800x768:inbox",
    "1024x768:composer",
    "1366x900:project",
  ]);
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    // Each engine pass is its own bounded startup; Chromium's pass must not spend WebKit's launch window.
    journey.restart();
    browser = await journey.start(`browser.launch.${name}`, () =>
      type.launch(),
    );
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    let commandWrites = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/operator/commands"
      )
        commandWrites++;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(web.origin + routes.overview);
    await page.getByLabel("Password", { exact: true }).waitFor();
    assert.deepEqual(await layoutProblems(page), [], `${name} phone login`);
    await page.getByLabel("Password", { exact: true }).fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("main.page h1").waitFor();
    const failures: string[] = [];
    let checked = 0;
    for (const [width, height, names] of matrix) {
      await page.setViewportSize({ width, height });
      for (const route of names) {
        await page.goto(web.origin + routes[route]);
        await page.locator("main h1").first().waitFor();
        if (route === "tasks" || route === "project" || route === "overview")
          await page.locator(".task-title").first().waitFor();
        if (route === "inbox")
          await page.locator(".inbox-row").first().waitFor();
        if (route === "question")
          await page
            .getByRole("region", { name: "Exact question response" })
            .waitFor();
        for (const problem of await layoutProblems(page))
          failures.push(`${name} ${width}x${height} ${route}: ${problem}`);
        checked++;
        const key = `${width}x${height}:${route}`;
        if (evidence.has(key))
          await captureBrowserEvidence(
            page,
            `${name}-${key.replace(":", "-")}`,
            {
              fullPage: false,
            },
          );
      }
    }
    assert.deepEqual(failures, []);

    // Drawer keyboard journey at phone width in each engine.
    await page.setViewportSize({ width: 390, height: 844 });
    // The task route is a nested screen with a Back header; the drawer lives on top-level routes.
    await page.goto(web.origin + routes.inbox);
    await page.locator(".inbox-row").first().waitFor();
    const trigger = page.getByRole("button", {
      name: "Projects and navigation",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Projects and navigation",
      exact: true,
    });
    await dialog.waitFor({ state: "visible" });
    for (const key of ["Tab", "Shift+Tab", "Tab"]) {
      await page.keyboard.press(key);
      assert.equal(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
        true,
        `${name} drawer keeps focus after ${key}`,
      );
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector(".phone-nav [data-slot=button]"),
    );
    assert.equal(commandWrites, 0);
    journey.diagnostics.push(
      JSON.stringify({
        milestone: `${name}-matrix`,
        browser: browser.version(),
        checked,
        commandWrites,
      }),
    );
    await browser.close();
    browser = undefined;
  }
});
