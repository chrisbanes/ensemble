import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui08-workspace-changes");

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function sourceRepository(root: string, name: string, baseBranch: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  git(path, "config", "user.name", "Workspace Changes Test");
  git(path, "config", "user.email", "workspace-changes@example.invalid");
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  writeFileSync(
    join(path, "guide.md"),
    "-- " +
      name +
      " heading\n-- secondary " +
      name +
      " heading\nkeep " +
      name +
      "\n",
  );
  writeFileSync(join(path, "staged.txt"), "staged before\n");
  writeFileSync(join(path, "unstaged.txt"), "unstaged before\n");
  writeFileSync(join(path, "deleted.txt"), "delete this\n");
  writeFileSync(
    join(path, "rename-old.txt"),
    "rename first\nrename second\nrename third\n",
  );
  writeFileSync(join(path, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "base snapshot");
  git(path, "branch", baseBranch);
  writeFileSync(
    join(path, "guide.md"),
    "++ " +
      name +
      " heading\n++ secondary " +
      name +
      " heading\nkeep " +
      name +
      "\n",
  );
  writeFileSync(join(path, `${name}-only.md`), `${name} repository only\n`);
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "topic snapshot");
  const disconnectedTree = git(path, "write-tree");
  const disconnectedCommit = execFileSync(
    "git",
    ["-C", path, "commit-tree", disconnectedTree, "-m", "disconnected fixture"],
    { encoding: "utf8" },
  ).trim();
  git(path, "branch", "unrelated", disconnectedCommit);
  return path;
}

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

class ChangesRuntime extends OperatorFixtureRuntime {
  override async waitForTurn(threadId: string, turnId: string) {
    const outcome = await super.waitForTurn(threadId, turnId);
    await this.callTool({
      threadId,
      turnId,
      callId: `changes-report-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: {
        question: "The deterministic Changes fixture finished its observation",
      },
    });
    return outcome;
  }
}

async function startChangesJourney(
  j: BrowserJourney,
  { recordResult = true }: { recordResult?: boolean } = {},
) {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      j.fixtureOptions,
      () => new ChangesRuntime(),
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );

  const sourceRoot = join(fixture.directory, "changes-sources");
  const alphaSource = sourceRepository(sourceRoot, "alpha", "base-alpha");
  const betaSource = sourceRepository(sourceRoot, "beta", "base-beta");
  const task = await seedReviewTask(
    fixture,
    "Workspace comparison test",
    "Inspect exact workspace changes",
    "Keep repository comparisons local",
    [
      { repositoryId: "repo-alpha", path: alphaSource },
      { repositoryId: "repo-beta", path: betaSource },
    ],
  );
  // A recorded lead result settles the assignment, so admission starts no initial turn.
  const result = recordResult
    ? task.result("Recorded provider summary", {
        sourceId: task.source.sourceId,
        changes: {
          files: ["legacy-recorded.txt"],
          commits: [],
          findings: [],
          diff: "literal recorded provider diff",
        },
      })
    : undefined;
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const alpha = binding.repositories.find(
    (repository) => repository.repositoryId === "repo-alpha",
  );
  const beta = binding.repositories.find(
    (repository) => repository.repositoryId === "repo-beta",
  );
  assert.ok(alpha);
  assert.ok(beta);
  const alphaHead = git(alpha.workspacePath, "rev-parse", "HEAD");

  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  const comparisonRequests: string[] = [];
  const comparisonResponses: Array<{ url: string; status: number }> = [];
  const consoleErrors: string[] = [];
  const consoleState = { expected503Window: false, historyRaceAllowed: false };
  const historyRace503s: string[] = [];
  const race503Responses: Array<{
    method: string;
    path: string;
    code: string;
  }> = [];
  const expected503ConsoleErrors: Array<{
    text: string;
    url: string;
    observedAt: number;
  }> = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/comparisons"))
      comparisonRequests.push(url.toString());
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      consoleState.historyRaceAllowed &&
      response.status() === 503 &&
      url.pathname.startsWith("/api/operator/")
    )
      race503Responses.push({
        method: response.request().method(),
        path: url.pathname,
        code: String(
          (
            (await response.json().catch(() => null)) as {
              error?: { code?: string };
            } | null
          )?.error?.code,
        ),
      });
    if (url.pathname.endsWith("/comparisons"))
      comparisonResponses.push({
        url: url.toString(),
        status: response.status(),
      });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (consoleState.expected503Window && /\b503\b/.test(message.text()))
      expected503ConsoleErrors.push({
        text: message.text(),
        url: location.url,
        observedAt: Date.now(),
      });
    // Reads deliberately return 503 when a turn changes the task mid-read; the
    // UI retries. Each one is checked below as a GET "unavailable" response.
    else if (consoleState.historyRaceAllowed && /\b503\b/.test(message.text()))
      historyRace503s.push(location.url);
    else consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const changes = page.locator("#changes");
  const directPath = `/app/tasks/${task.taskId}?section=changes`;
  await page.goto(web.origin + directPath);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await changes
    .getByRole("heading", { name: "Changes and delivery", exact: true })
    .waitFor();
  await changes
    .getByRole("heading", { name: "Workspace comparisons", exact: true })
    .waitFor();
  const comparisonTargetControl = changes.getByLabel("Comparison target");

  return {
    fixture,
    task,
    result,
    alpha,
    beta,
    alphaHead,
    web,
    browser,
    page,
    changes,
    directPath,
    comparisonTargetControl,
    comparisonRequests,
    comparisonResponses,
    consoleErrors,
    expected503ConsoleErrors,
    historyRace503s,
    race503Responses,
    pageErrors,
    consoleState,
  };
}

test("production Changes preserves exact repository baselines and last-good refreshes", async (t, j) => {
  const {
    fixture,
    task,
    result,
    alpha,
    alphaHead,
    web,
    page,
    changes,
    directPath,
    comparisonTargetControl,
    comparisonRequests,
    comparisonResponses,
    consoleErrors,
    expected503ConsoleErrors,
    pageErrors,
    consoleState,
  } = await startChangesJourney(j);

  let controlledFailureUrl: string | null = null;
  let expected503WindowStartedAt = 0;
  let expected503WindowEndedAt = 0;
  assert.equal(await comparisonTargetControl.inputValue(), "branch");
  assert.equal(await comparisonTargetControl.isVisible(), true);
  assert.equal(await comparisonTargetControl.isEnabled(), true);

  await page.goto(
    web.origin +
      "/app/tasks/" +
      task.taskId +
      "?section=changes" +
      (result ? `&result=${result.resultId}` : ""),
  );
  await changes
    .getByRole("heading", { name: "Changes and delivery", exact: true })
    .waitFor();
  await changes.getByText("legacy-recorded.txt", { exact: false }).waitFor();
  await changes
    .getByText("literal recorded provider diff", { exact: true })
    .waitFor();
  await page.goto(web.origin + directPath);
  await changes
    .getByRole("heading", { name: "Workspace comparisons", exact: true })
    .waitFor();

  await page
    .getByLabel("Repository", { exact: true })
    .selectOption("repo-alpha");
  await page.waitForFunction(
    (value) =>
      Array.from(
        document.querySelector<HTMLSelectElement>(
          'select[aria-label="Local base branch"]',
        )?.options ?? [],
      ).some((option) => option.value === value),
    "base-alpha",
  );
  const baseBranchControl = page.getByLabel("Local base branch");
  assert.equal(await baseBranchControl.isVisible(), true);
  assert.equal(await baseBranchControl.isEnabled(), true);
  await baseBranchControl.selectOption("");
  const alphaBranchRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "branch" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("baseBranch") === "base-alpha" &&
      !url.searchParams.has("comparisonId")
    );
  });
  const alphaBranchStartedAt = Date.now();
  await page.getByLabel("Local base branch").selectOption("base-alpha");
  const alphaResponse = await alphaBranchRead;
  const alphaBody = (await alphaResponse.json()) as {
    data: {
      state: string;
      reason?: string;
      comparisonId: string;
      comparison: {
        comparisonId: string;
        repositoryId: string;
        baseline?: { branch?: string };
        state: string;
        reason?: string;
        truncated: boolean;
        entries: Array<{ path: string; state: string; reason?: string }>;
      };
    };
  };
  assert.equal(
    alphaBody.data.comparisonId,
    alphaBody.data.comparison.comparisonId,
  );
  await until(
    () =>
      comparisonResponses.some(
        ({ url }) =>
          new URL(url).searchParams.get("comparisonId") ===
          alphaBody.data.comparisonId,
      ),
    "exact alpha branch comparison read by comparisonId",
  );
  await changes
    .locator(".changes-observation")
    .getByText(`Comparison ${alphaBody.data.comparisonId}`, { exact: true })
    .waitFor();
  const alphaRequestUrl = new URL(alphaResponse.url());
  if (alphaBody.data.state !== "available")
    t.diagnostic(
      `alpha branch observation ${JSON.stringify({
        request: {
          method: alphaResponse.request().method(),
          target: alphaRequestUrl.searchParams.get("target"),
          repositoryId: alphaRequestUrl.searchParams.get("repositoryId"),
          baseBranch: alphaRequestUrl.searchParams.get("baseBranch"),
          refresh: alphaRequestUrl.searchParams.get("refresh"),
        },
        requestUrl: alphaResponse.url(),
        responseStatus: alphaResponse.status(),
        elapsedMs: Date.now() - alphaBranchStartedAt,
        state: alphaBody.data.state,
        reason: alphaBody.data.reason,
        comparison: {
          comparisonId: alphaBody.data.comparisonId,
          repositoryId: alphaBody.data.comparison?.repositoryId,
          baseline: alphaBody.data.comparison?.baseline,
          state: alphaBody.data.comparison?.state,
          reason: alphaBody.data.comparison?.reason,
          truncated: alphaBody.data.comparison?.truncated,
          entries: alphaBody.data.comparison?.entries,
        },
        observation: await changes.locator(".changes-observation").innerText(),
        boundedDom: (await changes.innerText()).slice(0, 2000),
      })}`,
    );
  assert.equal(alphaBody.data.state, "available");
  assert.equal(alphaBody.data.comparison.repositoryId, "repo-alpha");
  assert.equal(alphaBody.data.comparison.baseline?.branch, "base-alpha");
  assert.ok(
    alphaBody.data.comparison.entries.some(
      (entry) => entry.path === "alpha-only.md",
    ),
  );
  await page.waitForFunction(() =>
    Array.from(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Local base branch"]',
      )?.options ?? [],
    ).some((option) => option.value === "unrelated"),
  );
  const noMergeBaseRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "branch" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("baseBranch") === "unrelated" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await baseBranchControl.selectOption("unrelated");
  await changes
    .getByText("Reading the selected comparison…", { exact: true })
    .waitFor();
  assert.equal(await baseBranchControl.inputValue(), "unrelated");
  assert.ok(
    (
      await baseBranchControl
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        )
    ).includes("unrelated"),
  );
  assert.equal(await changes.locator(".changes-observation").count(), 0);
  const noMergeBaseResponse = await noMergeBaseRead;
  const noMergeBaseUrl = new URL(noMergeBaseResponse.url());
  const noMergeBaseBody = (await noMergeBaseResponse.json()) as {
    data: {
      taskId: string;
      target: string;
      state: string;
      comparisonId?: string;
      reason?: string;
      availableBaseBranches?: string[];
      comparison?: {
        taskId: string;
        repositoryId: string;
        target: string;
        state: string;
        reason?: string;
        baseline?: { branch?: string; commit?: string };
        availableBaseBranches: string[];
        entries: unknown[];
      };
    };
  };
  assert.equal(noMergeBaseResponse.status(), 200);
  assert.equal(noMergeBaseUrl.searchParams.get("target"), "branch");
  assert.equal(noMergeBaseUrl.searchParams.get("repositoryId"), "repo-alpha");
  assert.equal(noMergeBaseUrl.searchParams.get("baseBranch"), "unrelated");
  assert.equal(noMergeBaseBody.data.taskId, task.taskId);
  assert.equal(noMergeBaseBody.data.target, "branch");
  assert.ok(noMergeBaseBody.data.comparisonId);
  assert.equal(noMergeBaseBody.data.state, "unavailable");
  assert.equal(noMergeBaseBody.data.reason, "no-merge-base");
  assert.ok(noMergeBaseBody.data.availableBaseBranches?.includes("unrelated"));
  assert.equal(noMergeBaseBody.data.comparison?.taskId, task.taskId);
  assert.equal(noMergeBaseBody.data.comparison?.repositoryId, "repo-alpha");
  assert.equal(noMergeBaseBody.data.comparison?.target, "branch");
  assert.equal(noMergeBaseBody.data.comparison?.state, "unavailable");
  assert.equal(noMergeBaseBody.data.comparison?.reason, "no-merge-base");
  assert.equal(noMergeBaseBody.data.comparison?.baseline, undefined);
  assert.ok(
    noMergeBaseBody.data.comparison?.availableBaseBranches.includes(
      "unrelated",
    ),
  );
  assert.deepEqual(noMergeBaseBody.data.comparison?.entries, []);
  t.diagnostic(
    `No-merge-base browser state: ${JSON.stringify({
      response: noMergeBaseBody,
      selectedBase: await baseBranchControl.inputValue(),
      observationCount: await changes.locator(".changes-observation").count(),
      dom: (await changes.innerText()).slice(0, 1800),
      comparisonRequests: comparisonRequests.slice(-5),
    })}`,
  );
  await changes
    .getByText("The selected local branch has no usable merge base.", {
      exact: true,
    })
    .waitFor();
  await until(
    () =>
      comparisonResponses.some(
        ({ url }) =>
          new URL(url).searchParams.get("comparisonId") ===
          noMergeBaseBody.data.comparisonId,
      ),
    "exact no-merge comparison read by comparisonId",
  );
  t.diagnostic(
    `No-merge-base exact-read settled in UI: ${JSON.stringify({
      selectedRepository: await page
        .getByLabel("Repository", { exact: true })
        .inputValue(),
      selectedBase: await baseBranchControl.inputValue(),
      observation: await changes.locator(".changes-observation").innerText(),
      responses: comparisonResponses.slice(-5),
      dom: (await changes.innerText()).slice(0, 1800),
    })}`,
  );
  assert.equal(
    await page.getByLabel("Repository", { exact: true }).inputValue(),
    "repo-alpha",
  );
  assert.equal(await baseBranchControl.inputValue(), "unrelated");
  assert.match(
    await changes.locator(".changes-observation").innerText(),
    new RegExp(noMergeBaseBody.data.comparisonId),
  );
  const requestCountBeforeCachedRestore = comparisonRequests.length;
  await baseBranchControl.selectOption("base-alpha");
  await changes
    .getByRole("button", { name: "modified guide.md, text", exact: true })
    .waitFor();
  assert.equal(await baseBranchControl.inputValue(), "base-alpha");
  assert.match(
    await changes.locator(".changes-observation").innerText(),
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.doesNotMatch(
    await changes.locator(".changes-observation").innerText(),
    /no-merge-base/,
  );
  assert.equal(
    comparisonRequests.length,
    requestCountBeforeCachedRestore,
    "restoring a cached local base displays its exact prior response without rereading",
  );
  const guide = changes.getByRole("button", {
    name: "modified guide.md, text",
    exact: true,
  });
  await guide.click();
  const beforeLine = changes.getByRole("button", {
    name: /^Before line 1, guide\.md;/,
  });
  await beforeLine.waitFor();
  assert.match((await beforeLine.textContent()) ?? "", /-- alpha heading/);
  await beforeLine.focus();
  await page.keyboard.press("ArrowRight");
  assert.match(
    (await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    )) ?? "",
    /^After line 1, guide\.md;/,
  );
  const afterBranchLine = changes.getByRole("button", {
    name: /^After line 1, guide\.md;/,
  });
  assert.match(
    (await afterBranchLine.textContent()) ?? "",
    /\+\+ alpha heading/,
  );
  await page.keyboard.press("Enter");
  await changes.getByText(/Selected After lines 1–1 · guide\.md/).waitFor();
  const afterContextLine = changes.getByRole("button", {
    name: /^After line 3, guide\.md;/,
  });
  await afterContextLine.click();
  await changes.getByText(/Selected After lines 3–3 · guide\.md/).waitFor();
  await page.keyboard.press("Shift+ArrowUp");
  await changes.getByText(/Selected After lines 2–3 · guide\.md/).waitFor();
  const beforeContextLine = changes.getByRole("button", {
    name: /^Before line 3, guide\.md;/,
  });
  await beforeContextLine.click();
  await changes.getByText(/Selected Before lines 3–3 · guide\.md/).waitFor();
  await page.keyboard.press("Shift+ArrowUp");
  await changes.getByText(/Selected Before lines 2–3 · guide\.md/).waitFor();
  await afterBranchLine.click();
  await page.keyboard.press("Shift+ArrowDown");
  await changes.getByText(/Selected After lines 1–2 · guide\.md/).waitFor();
  await captureBrowserEvidence(page, "1366-branch-diff-anchor");

  // Roving tabindex: one tab stop per diff side; arrows move within it.
  const panels = await changes
    .locator(".changes-diff-side")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        stops: element.querySelectorAll(
          'button.changes-selectable-line[tabindex="0"]',
        ).length,
        lines: element.querySelectorAll("button.changes-selectable-line")
          .length,
      })),
    );
  assert.equal(panels.length, 2);
  for (const panel of panels) {
    assert.equal(panel.stops, 1);
    assert.ok(panel.lines > 1);
  }
  await afterBranchLine.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Set start",
    "Tab leaves the After panel for the range controls",
  );
  // The composer's focus return targets the current line of this comparison.
  const returnTargets = await changes
    .locator("[data-review-return]")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        origin: element.getAttribute("data-review-return"),
        label: element.getAttribute("aria-label"),
      })),
    );
  assert.deepEqual(returnTargets, [
    {
      origin: `changes:${alphaBody.data.comparisonId}`,
      label: "After line 2, guide.md; hunk lines 1–3",
    },
  ]);

  // Phone: unified rows keep old and new numbers apart; labelled 44px Start/End
  // controls build a range on either side without Shift.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneDiff = changes.locator(".changes-diff-unified");
  await phoneDiff.waitFor();
  const numbers = (name: RegExp) =>
    changes.getByRole("button", { name }).evaluate((element) => ({
      old: element.querySelector(".changes-line-old")?.textContent,
      next: element.querySelector(".changes-line-new")?.textContent,
    }));
  assert.deepEqual(await numbers(/^Before line 1, guide\.md;/), {
    old: "1",
    next: "",
  });
  assert.deepEqual(await numbers(/^After line 1, guide\.md;/), {
    old: "",
    next: "1",
  });
  assert.deepEqual(await numbers(/^After line 3, guide\.md;/), {
    old: "3",
    next: "3",
  });
  assert.equal(
    await phoneDiff
      .getByRole("button", { name: /^After line 3, guide\.md;/ })
      .count(),
    1,
    "an unchanged row appears once in the unified diff",
  );
  const setStart = changes.getByRole("button", {
    name: "Set start",
    exact: true,
  });
  const setEnd = changes.getByRole("button", { name: "Set end", exact: true });
  for (const control of [setStart, setEnd])
    assert.ok(
      (await control.evaluate(
        (element) => element.getBoundingClientRect().height,
      )) >= 44,
    );
  await changes
    .getByRole("button", { name: /^Before line 1, guide\.md;/ })
    .click();
  await setStart.click();
  await changes.getByText("Edge fixed at line 1.", { exact: false }).waitFor();
  await changes
    .getByRole("button", { name: /^Before line 2, guide\.md;/ })
    .click();
  await setEnd.click();
  await changes.getByText(/Selected Before lines 1–2 · guide\.md/).waitFor();
  await captureBrowserEvidence(page, "390-phone-before-range-controls", {
    fullPage: false,
  });
  // Switching side starts a new selection instead of transforming the range.
  await setStart.click();
  await changes
    .getByRole("button", { name: /^After line 1, guide\.md;/ })
    .click();
  await changes.getByText(/Selected After lines 1–1 · guide\.md/).waitFor();
  await setStart.click();
  await changes
    .getByRole("button", { name: /^After line 3, guide\.md;/ })
    .click();
  await setEnd.click();
  await changes.getByText(/Selected After lines 1–3 · guide\.md/).waitFor();
  await page.setViewportSize({ width: 1366, height: 900 });
  await afterBranchLine.click();
  await page.keyboard.press("Shift+ArrowDown");
  await changes.getByText(/Selected After lines 1–2 · guide\.md/).waitFor();

  const failRefreshRoute = "**/api/operator/tasks/*/comparisons*";
  let markFailureRequestSeen!: () => void;
  const failureRequestSeen = new Promise<void>((resolve) => {
    markFailureRequestSeen = resolve;
  });
  let releaseFailureResponse!: () => void;
  await page.route(failRefreshRoute, async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("refresh") === "true" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("target") === "branch"
    ) {
      controlledFailureUrl = url.toString();
      markFailureRequestSeen();
      await new Promise<void>((resolve) => {
        releaseFailureResponse = resolve;
      });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable" } }),
      });
    } else {
      await route.continue();
    }
  });
  const inspectReadingAnchor = () =>
    changes.locator(".changes-reading-area").evaluate((pane) => {
      const line = pane.querySelector<HTMLButtonElement>(
        "button.changes-selectable-line[aria-pressed='true']",
      );
      const paneBounds = pane.getBoundingClientRect();
      const lineBounds = line?.getBoundingClientRect();
      return {
        scrollTop: pane.scrollTop,
        label: line?.getAttribute("aria-label") ?? null,
        paneRelativeTop: lineBounds
          ? Math.round(lineBounds.top - paneBounds.top)
          : null,
      };
    });
  const beforeFailure = {
    comparison: await changes.locator(".changes-observation").innerText(),
    selection: await changes.locator(".changes-selection").innerText(),
    anchor: await inspectReadingAnchor(),
  };
  t.diagnostic(
    `Changes before controlled refresh failure: ${JSON.stringify(beforeFailure)}`,
  );
  assert.match(
    beforeFailure.comparison,
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.match(
    beforeFailure.selection,
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.equal(
    beforeFailure.anchor.label,
    "After line 1, guide.md; hunk lines 1–3",
  );
  consoleState.expected503Window = true;
  expected503WindowStartedAt = Date.now();
  const failedRefreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("refresh") === "true" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("target") === "branch"
    );
  });
  await changes
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  await failureRequestSeen;
  await changes.getByText("Refreshing…", { exact: true }).waitFor({
    timeout: 1_000,
  });
  const whileFailureHeld = {
    comparison: await changes.locator(".changes-observation").innerText(),
    selection: await changes.locator(".changes-selection").innerText(),
    anchor: await inspectReadingAnchor(),
    refreshDisabled: await changes
      .getByRole("button", { name: "Refresh comparison", exact: true })
      .isDisabled(),
  };
  t.diagnostic(
    `Changes while exact controlled refresh request is held: ${JSON.stringify(whileFailureHeld)}`,
  );
  assert.match(
    whileFailureHeld.comparison,
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.match(whileFailureHeld.comparison, /Refreshing…/);
  assert.equal(whileFailureHeld.refreshDisabled, true);
  assert.equal(whileFailureHeld.selection, beforeFailure.selection);
  assert.deepEqual(whileFailureHeld.anchor, beforeFailure.anchor);
  releaseFailureResponse();
  const failedRefresh = await failedRefreshResponse;
  assert.equal(failedRefresh.status(), 503);
  assert.equal(failedRefresh.url(), controlledFailureUrl);
  await changes
    .getByRole("alert")
    .getByText(/Refresh failed/)
    .waitFor();
  expected503WindowEndedAt = Date.now();
  consoleState.expected503Window = false;
  const afterFailure = {
    comparison: await changes.locator(".changes-observation").innerText(),
    selection: await changes.locator(".changes-selection").innerText(),
    anchor: await inspectReadingAnchor(),
  };
  t.diagnostic(
    `Changes after confirmed 503 and retained comparison notice: ${JSON.stringify(afterFailure)}`,
  );
  assert.match(
    afterFailure.comparison,
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.match(afterFailure.comparison, /Refresh failed/);
  assert.doesNotMatch(afterFailure.comparison, /Refreshing…/);
  assert.equal(afterFailure.selection, beforeFailure.selection);
  assert.equal(afterFailure.anchor.label, beforeFailure.anchor.label);
  assert.ok(beforeFailure.anchor.paneRelativeTop !== null);
  assert.ok(afterFailure.anchor.paneRelativeTop !== null);
  assert.ok(
    Math.abs(
      afterFailure.anchor.paneRelativeTop -
        beforeFailure.anchor.paneRelativeTop,
    ) <= 1,
  );
  assert.equal(await guide.count(), 1);
  assert.ok(controlledFailureUrl);
  assert.ok(expected503ConsoleErrors.length <= 1);
  for (const consoleError of expected503ConsoleErrors) {
    assert.equal(consoleError.url, controlledFailureUrl);
    assert.match(consoleError.text, /\b503\b/);
    assert.ok(consoleError.observedAt >= expected503WindowStartedAt);
    assert.ok(consoleError.observedAt <= expected503WindowEndedAt);
  }
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  t.diagnostic(
    `Controlled Changes refresh returned 503 at ${controlledFailureUrl}; exact in-window Chromium errors ${JSON.stringify(expected503ConsoleErrors)}`,
  );
  await page.unroute(failRefreshRoute);

  await page
    .getByLabel("Repository", { exact: true })
    .selectOption("repo-beta");
  await page.waitForFunction(
    (value) =>
      Array.from(
        document.querySelector<HTMLSelectElement>(
          'select[aria-label="Local base branch"]',
        )?.options ?? [],
      ).some((option) => option.value === value),
    "base-beta",
  );
  const betaBaseControl = page.getByLabel("Local base branch");
  await betaBaseControl.selectOption("");
  const betaRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "branch" &&
      url.searchParams.get("repositoryId") === "repo-beta" &&
      url.searchParams.get("baseBranch") === "base-beta" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await betaBaseControl.selectOption("base-beta");
  const betaBody = (await (await betaRead).json()) as {
    data: {
      state: string;
      comparisonId: string;
      comparison: {
        repositoryId: string;
        baseline?: { branch?: string };
        entries: Array<{
          path: string;
          left?: { sha256: string };
          right?: { sha256: string };
        }>;
      };
    };
  };
  assert.equal(betaBody.data.state, "available");
  assert.equal(betaBody.data.comparison.repositoryId, "repo-beta");
  assert.equal(betaBody.data.comparison.baseline?.branch, "base-beta");
  assert.notEqual(betaBody.data.comparisonId, alphaBody.data.comparisonId);
  const betaGuide = betaBody.data.comparison.entries.find(
    (entry) => entry.path === "guide.md",
  );
  assert.equal(betaGuide?.left?.sha256?.length, 64);
  assert.equal(betaGuide?.right?.sha256?.length, 64);
  await changes
    .getByRole("button", { name: "modified guide.md, text", exact: true })
    .waitFor();
  const betaList = await changes
    .locator('[aria-label="Workspace comparison files"]')
    .innerText();
  assert.match(betaList, /beta-only\.md/);
  assert.doesNotMatch(betaList, /alpha-only\.md/);
  const alphaRequestCount = comparisonRequests.filter((request) => {
    const url = new URL(request);
    return (
      url.searchParams.get("target") === "branch" &&
      url.searchParams.get("repositoryId") === "repo-alpha"
    );
  }).length;
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption("repo-alpha");
  await changes
    .getByRole("button", { name: "modified guide.md, text", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Local base branch").inputValue(),
    "base-alpha",
  );
  assert.match(
    await changes.locator(".changes-observation").innerText(),
    new RegExp(alphaBody.data.comparisonId),
  );
  assert.equal(
    comparisonRequests.filter((request) => {
      const url = new URL(request);
      return (
        url.searchParams.get("target") === "branch" &&
        url.searchParams.get("repositoryId") === "repo-alpha"
      );
    }).length,
    alphaRequestCount,
    "a cached return uses repo-alpha's exact response without rereading repo-beta bytes",
  );
  const alphaList = await changes
    .locator('[aria-label="Workspace comparison files"]')
    .innerText();
  assert.match(alphaList, /alpha-only\.md/);
  assert.doesNotMatch(alphaList, /beta-only\.md/);

  assert.equal(git(alpha.workspacePath, "rev-parse", "HEAD"), alphaHead);
  assert.equal(git(alpha.workspacePath, "status", "--porcelain"), "");
  assert.equal(fixture.service.taskHold(task.taskId), undefined);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
});
test("production Changes separates staged and unstaged snapshots and retains explicit refresh selection", async (t, j) => {
  const {
    fixture,
    task,
    alpha,
    alphaHead,
    page,
    changes,
    comparisonRequests,
    consoleErrors,
    pageErrors,
  } = await startChangesJourney(j);
  const comparisonTargetControl = changes.getByLabel("Comparison target");
  let alphaStatusBefore = "";
  const failRefreshRoute = "**/api/operator/tasks/*/comparisons*";
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption("repo-alpha");

  writeFileSync(join(alpha.workspacePath, "staged.txt"), "staged after\n");
  git(alpha.workspacePath, "add", "staged.txt");
  writeFileSync(join(alpha.workspacePath, "unstaged.txt"), "unstaged after\n");
  unlinkSync(join(alpha.workspacePath, "deleted.txt"));
  execFileSync("git", [
    "-C",
    alpha.workspacePath,
    "mv",
    "rename-old.txt",
    "rename-new.txt",
  ]);
  writeFileSync(
    join(alpha.workspacePath, "binary.bin"),
    Buffer.from([0, 255, 0, 10]),
  );
  writeFileSync(
    join(alpha.workspacePath, "untracked.txt"),
    "new workspace file\n",
  );
  alphaStatusBefore = git(alpha.workspacePath, "status", "--porcelain");
  const allRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "uncommitted" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("changeSet") === "all" &&
      !url.searchParams.has("comparisonId")
    );
  });
  let partialComparisonId: string | null = null;
  await page.route(failRefreshRoute, async (route) => {
    const url = new URL(route.request().url());
    const isAllComparison =
      url.searchParams.get("target") === "uncommitted" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("changeSet") === "all";
    // The UI's follow-up exact read carries only target and comparisonId.
    const isExactPartialRead =
      partialComparisonId !== null &&
      url.searchParams.get("comparisonId") === partialComparisonId;
    if (!isAllComparison && !isExactPartialRead) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: {
        state: "available" | "gap" | "unavailable";
        comparisonId?: string;
        reason?: string;
        comparison?: {
          comparisonId: string;
          state: "available" | "gap" | "unavailable";
          reason?: string;
        };
      };
      observedAt: number;
    };
    const isInitialAllRead =
      !url.searchParams.has("refresh") && !url.searchParams.has("comparisonId");
    if (isInitialAllRead)
      partialComparisonId =
        body.data.comparisonId ?? body.data.comparison?.comparisonId ?? null;
    const isExactRead =
      partialComparisonId !== null &&
      url.searchParams.get("comparisonId") === partialComparisonId;
    if (isInitialAllRead || isExactRead) {
      assert.ok(body.data.comparison);
      body.data.state = "gap";
      body.data.reason = "time-limit";
      body.data.comparison.state = "gap";
      body.data.comparison.reason = "time-limit";
      await route.fulfill({ response, body: JSON.stringify(body) });
    } else {
      await route.fulfill({ response });
    }
  });
  const allReadStartedAt = Date.now();
  await page.getByLabel("Comparison target").selectOption("uncommitted");
  const allResponse = await allRead;
  const allBody = (await allResponse.json()) as {
    data: {
      state: string;
      reason?: string;
      comparisonId: string;
      comparison: {
        state: string;
        reason?: string;
        truncated: boolean;
        entries: Array<{
          path: string;
          change: string;
          state: string;
          changeSet?: string;
        }>;
      };
    };
  };
  if (allBody.data.state !== "available") {
    const allRequestUrl = new URL(allResponse.url());
    t.diagnostic(
      `alpha uncommitted all observation ${JSON.stringify({
        request: {
          method: allResponse.request().method(),
          target: allRequestUrl.searchParams.get("target"),
          repositoryId: allRequestUrl.searchParams.get("repositoryId"),
          changeSet: allRequestUrl.searchParams.get("changeSet"),
        },
        requestUrl: allResponse.url(),
        responseStatus: allResponse.status(),
        elapsedMs: Date.now() - allReadStartedAt,
        state: allBody.data.state,
        reason: allBody.data.reason,
        comparison: {
          comparisonId: allBody.data.comparisonId,
          state: allBody.data.comparison?.state,
          reason: allBody.data.comparison?.reason,
          truncated: allBody.data.comparison?.truncated,
          entries: allBody.data.comparison?.entries,
        },
        observation: await changes.locator(".changes-observation").innerText(),
        boundedDom: (await changes.innerText()).slice(0, 2000),
      })}`,
    );
  }
  assert.equal(allBody.data.state, "gap");
  assert.equal(allBody.data.reason, "time-limit");
  assert.equal(allBody.data.comparison.reason, "time-limit");
  assert.equal(allBody.data.comparison.truncated, false);
  await changes
    .getByText(
      "This observation contains gaps; unavailable or unsupported entries remain identified as such.",
      { exact: true },
    )
    .waitFor();
  assert.equal(partialComparisonId, allBody.data.comparisonId);
  assert.match(
    await changes.locator(".changes-observation").innerText(),
    new RegExp(partialComparisonId),
  );
  await page.unroute(failRefreshRoute);
  const list = changes.locator('[aria-label="Workspace comparison files"]');
  assert.match(await list.innerText(), /staged\.txt/);
  assert.match(await list.innerText(), /unstaged\.txt/);

  const stagedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "uncommitted" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("changeSet") === "staged" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await page.getByLabel("Change set").selectOption("staged");
  const staged = (await (await stagedRead).json()) as {
    data: {
      state: string;
      reason?: string;
      comparison: {
        state: string;
        reason?: string;
        entries: Array<{ path: string; change: string; changeSet?: string }>;
      };
    };
  };
  assert.equal(staged.data.state, "available");
  assert.equal(staged.data.comparison.state, "available");
  assert.equal(staged.data.reason, undefined);
  assert.ok(
    staged.data.comparison.entries.some((entry) => entry.path === "staged.txt"),
  );
  assert.ok(
    staged.data.comparison.entries.some(
      (entry) => entry.path === "rename-new.txt",
    ),
  );
  assert.ok(
    staged.data.comparison.entries.some(
      (entry) =>
        entry.path === "rename-new.txt" &&
        entry.change === "renamed" &&
        entry.changeSet === "staged",
    ),
  );
  assert.ok(
    !staged.data.comparison.entries.some(
      (entry) => entry.path === "unstaged.txt",
    ),
  );

  const unstagedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "uncommitted" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("changeSet") === "unstaged" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await page.getByLabel("Change set").selectOption("unstaged");
  const unstaged = (await (await unstagedRead).json()) as {
    data: {
      state: string;
      reason?: string;
      comparison: {
        state: string;
        reason?: string;
        entries: Array<{
          path: string;
          change: string;
          changeSet?: string;
          state: string;
        }>;
      };
    };
  };
  assert.equal(unstaged.data.state, "available");
  assert.equal(unstaged.data.comparison.state, "available");
  for (const path of [
    "unstaged.txt",
    "deleted.txt",
    "binary.bin",
    "untracked.txt",
  ])
    assert.ok(
      unstaged.data.comparison.entries.some((entry) => entry.path === path),
      path,
    );
  assert.ok(
    unstaged.data.comparison.entries.some(
      (entry) => entry.path === "deleted.txt" && entry.change === "deleted",
    ),
  );
  assert.ok(
    unstaged.data.comparison.entries.some(
      (entry) => entry.path === "binary.bin" && entry.state === "binary",
    ),
  );
  assert.ok(
    unstaged.data.comparison.entries.some(
      (entry) => entry.path === "untracked.txt" && entry.change === "added",
    ),
  );
  const allReadCountBeforeCachedReturn = comparisonRequests.length;
  await page.getByLabel("Change set").selectOption("all");
  await changes
    .getByText(
      "This observation contains gaps; unavailable or unsupported entries remain identified as such.",
      { exact: true },
    )
    .waitFor();
  assert.match(
    await changes.locator(".changes-observation").innerText(),
    new RegExp(allBody.data.comparisonId),
  );
  assert.equal(
    comparisonRequests.length,
    allReadCountBeforeCachedReturn,
    "returning to cached All changes does not read newer workspace bytes",
  );
  const beforeRefresh = allBody;
  await list.getByRole("button", { name: /modified unstaged\.txt/ }).click();
  const afterLine = changes.getByRole("button", {
    name: /^After line 1, unstaged\.txt;/,
  });
  await afterLine.waitFor();
  await afterLine.click();
  writeFileSync(
    join(alpha.workspacePath, "later.txt"),
    "explicit refresh only\n",
  );
  writeFileSync(
    join(alpha.workspacePath, "long.txt"),
    `${Array.from({ length: 120 }, (_, index) => `long line ${index + 1}`).join(
      "\n",
    )}\n`,
  );
  assert.equal(
    await list.getByRole("button", { name: /later\.txt/ }).count(),
    0,
  );
  assert.equal(
    await list.getByRole("button", { name: /long\.txt/ }).count(),
    0,
  );
  const refreshedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "uncommitted" &&
      url.searchParams.get("repositoryId") === "repo-alpha" &&
      url.searchParams.get("changeSet") === "all" &&
      url.searchParams.get("refresh") === "true" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await changes
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  const refreshed = (await (await refreshedRead).json()) as {
    data: {
      comparisonId: string;
      comparison: { entries: Array<{ path: string }> };
    };
  };
  assert.notEqual(refreshed.data.comparisonId, beforeRefresh.data.comparisonId);
  assert.ok(
    refreshed.data.comparison.entries.some(
      (entry) => entry.path === "later.txt",
    ),
  );
  assert.ok(
    refreshed.data.comparison.entries.some(
      (entry) => entry.path === "long.txt",
    ),
  );
  await list.getByRole("button", { name: /added later\.txt/ }).waitFor();
  assert.equal(
    await changes.locator(".changes-refresh-notice").innerText(),
    "Refresh found a different comparison since the previous observation: 2 added, 0 removed, 0 changed file entries.",
  );
  await changes.getByText(/Selected After lines 1–1 · unstaged\.txt/).waitFor();
  await list.getByRole("button", { name: /added long\.txt/ }).click();
  const longLastLine = changes.getByRole("button", {
    name: /^After line 120, long\.txt;/,
  });
  await longLastLine.waitFor();
  const readingArea = changes.locator(".changes-reading-area");
  await readingArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const longScrollBefore = await readingArea.evaluate(
    (element) => element.scrollTop,
  );
  await longLastLine.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await changes.getByText(/Selected After lines 119–120 · long\.txt/).waitFor();
  assert.ok(longScrollBefore > 0);
  assert.ok((await readingArea.evaluate((element) => element.scrollTop)) > 0);
  await captureBrowserEvidence(page, "1366-long-diff-range");
  await captureBrowserEvidence(page, "1366-refreshed-uncommitted");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await comparisonTargetControl.isVisible(), true);
  assert.equal(await comparisonTargetControl.isEnabled(), true);
  await comparisonTargetControl.selectOption("branch");
  await comparisonTargetControl.focus();
  // Native select arrow keys differ by platform; this checks the focused control.
  await comparisonTargetControl.selectOption("uncommitted");
  const mobileRow = list.getByRole("button", {
    name: /modified unstaged\.txt/,
  });
  assert.equal(
    await mobileRow.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
    44,
  );
  await mobileRow.click();
  await changes
    .getByRole("button", { name: "Back to changed files", exact: true })
    .waitFor();
  assert.equal(
    await changes
      .locator(".changes-rail")
      .evaluate((element) => getComputedStyle(element).display),
    "none",
  );
  assert.notEqual(
    await changes
      .locator(".changes-reading-area")
      .evaluate((element) => getComputedStyle(element).display),
    "none",
  );
  assert.notEqual(
    await changes
      .locator(".changes-diff-unified")
      .evaluate((element) => getComputedStyle(element).display),
    "none",
  );
  assert.ok(
    (await changes
      .getByRole("button", { name: "Back to changed files", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height)) >= 44,
  );
  await captureBrowserEvidence(page, "390-phone-list-to-diff", {
    fullPage: false,
  });

  assert.equal(git(alpha.workspacePath, "rev-parse", "HEAD"), alphaHead);
  const finalStatus = git(alpha.workspacePath, "status", "--porcelain").split(
    "\n",
  );
  assert.deepEqual(
    finalStatus.filter(
      (line) => line !== "?? later.txt" && line !== "?? long.txt",
    ),
    alphaStatusBefore.split("\n"),
  );
  assert.equal(fixture.service.taskHold(task.taskId), undefined);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
});
test("production Changes retains pending and latest-finished Last-turn provenance", async (_t, j) => {
  const {
    fixture,
    task,
    page,
    changes,
    consoleErrors,
    historyRace503s,
    race503Responses,
    pageErrors,
    consoleState,
  } = await startChangesJourney(j, { recordResult: false });
  consoleState.historyRaceAllowed = true;
  const domain = fixture.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(
    () => fixture.runtime.turns >= 1 && fixture.runtime.hasPending(1),
    "first deterministic Last-turn capture",
  );
  fixture.runtime.complete(1);
  await until(
    () =>
      fixture.service
        .list()
        .find(
          (work) => work.workId === `assignment:${task.assignmentId}:initial`,
        )?.state === "completed",
    "first Last-turn capture completion",
  );
  const secondAction = fixture.service.submitTask(
    "changes-second-turn",
    task.assignmentId,
    "Keep the previous actual capture visible",
  );
  await until(
    () => fixture.runtime.turns >= 2 && fixture.runtime.hasPending(2),
    "second deterministic Last-turn capture",
  );
  const initialLastTurnRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "last-turn" &&
      !url.searchParams.has("comparisonId")
    );
  });
  const pendingExactRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "last-turn" &&
      url.searchParams.has("comparisonId")
    );
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  const target = changes.getByLabel("Comparison target");
  await target.selectOption("branch");
  await target.focus();
  // Native select arrow keys differ by platform; this checks the focused control.
  await target.selectOption("last-turn");
  const initialReadBody = (await (await initialLastTurnRead).json()) as {
    data: {
      taskId: string;
      target: string;
      state: string;
      pending: {
        comparisonId: string;
        identity: { taskId: string; workId: string; assignmentId: string };
        turnId?: string;
        captureState: string;
        outcome: string;
      };
      latestFinished?: {
        comparisonId: string;
        taskId: string;
        workId: string;
        assignmentId: string;
        turnId?: string;
        outcome: string;
        beforeObservedAt?: number;
        observedAt: number;
      };
    };
  };
  assert.equal(initialReadBody.data.taskId, task.taskId);
  assert.equal(initialReadBody.data.target, "last-turn");
  assert.equal(initialReadBody.data.state, "unsettled");
  assert.equal(initialReadBody.data.pending.identity.taskId, task.taskId);
  assert.equal(
    initialReadBody.data.pending.identity.assignmentId,
    task.assignmentId,
  );
  assert.equal(initialReadBody.data.pending.captureState, "pending");
  assert.equal(initialReadBody.data.pending.outcome, "running");
  assert.ok(initialReadBody.data.pending.turnId);
  const latestFinished = initialReadBody.data.latestFinished;
  assert.ok(latestFinished);
  assert.equal(latestFinished.taskId, task.taskId);
  assert.equal(latestFinished.assignmentId, task.assignmentId);
  assert.equal(
    latestFinished.workId,
    `assignment:${task.assignmentId}:initial`,
  );
  assert.ok(latestFinished.turnId);
  assert.notEqual(
    initialReadBody.data.pending.comparisonId,
    latestFinished.comparisonId,
  );
  const pendingExactResponse = await pendingExactRead;
  const exactPendingBody = (await pendingExactResponse.json()) as {
    data: {
      taskId: string;
      state: string;
      pending: { comparisonId: string };
      latestFinished?: {
        comparisonId: string;
        workId: string;
        turnId?: string;
      };
    };
  };
  assert.equal(pendingExactResponse.status(), 200);
  assert.equal(exactPendingBody.data.taskId, task.taskId);
  assert.equal(exactPendingBody.data.state, "unsettled");
  assert.equal(
    exactPendingBody.data.pending.comparisonId,
    initialReadBody.data.pending.comparisonId,
  );
  assert.equal(
    exactPendingBody.data.latestFinished?.comparisonId,
    latestFinished.comparisonId,
  );
  assert.equal(
    exactPendingBody.data.latestFinished?.workId,
    latestFinished.workId,
  );
  assert.equal(
    exactPendingBody.data.latestFinished?.turnId,
    latestFinished.turnId,
  );
  await changes
    .getByRole("heading", { name: "Current actual turn", exact: true })
    .waitFor();
  const pendingText = await changes
    .locator(".changes-pending-turn")
    .innerText();
  assert.match(pendingText, /changes-second-turn/);
  assert.match(pendingText, /Latest finished capture remains separate/);
  assert.match(pendingText, new RegExp(latestFinished.workId));
  assert.match(pendingText, new RegExp(latestFinished.turnId));
  assert.match(pendingText, /assignment:/);
  assert.match(pendingText, /Capture started/);
  assert.equal(fixture.service.taskHold(task.taskId), undefined);
  await captureBrowserEvidence(page, "1366-pending-latest-finished");

  fixture.runtime.complete(2);
  await secondAction;
  await until(
    () =>
      fixture.service.workspaceTurnCaptureSlots(task.taskId).latestFinished
        ?.identity.workId !== latestFinished.workId,
    "second Last-turn capture to finish",
  );

  // The finished capture is identified in full, not only while a turn runs.
  const finishedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/comparisons") &&
      url.searchParams.get("target") === "last-turn" &&
      !url.searchParams.has("comparisonId")
    );
  });
  await changes
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  const finishedBody = (await (await finishedRead).json()) as {
    data: {
      state: string;
      comparison: {
        comparisonId: string;
        workId: string;
        threadId?: string;
        turnId?: string;
        profileId: string;
        assignmentId: string;
      };
    };
  };
  assert.equal(finishedBody.data.state, "available");
  const finishedTurn = changes.getByLabel("Last turn identity");
  await finishedTurn.waitFor();
  const finished = finishedBody.data.comparison;
  assert.ok(finished.threadId && finished.turnId);
  assert.notEqual(finished.workId, latestFinished.workId);
  const finishedText = await finishedTurn.innerText();
  for (const expected of [
    finished.workId,
    finished.assignmentId,
    finished.profileId,
    finished.threadId,
    finished.turnId,
    "outcome completed",
    "capture available",
    "Capture started",
    "before observation",
    "after observation",
  ])
    assert.ok(finishedText.includes(expected), expected);
  assert.doesNotMatch(finishedText, /Capture incomplete/);
  assert.match(
    await changes.locator(".changes-refresh-notice").innerText(),
    /^Refresh found a different comparison since the previous observation: \d+ added, \d+ removed, \d+ changed file entries\.$/,
  );
  await captureBrowserEvidence(page, "1366-finished-last-turn-identity");

  // An incomplete finished capture discloses its gap instead of looking complete.
  const gapRoute = "**/api/operator/tasks/*/comparisons*";
  await page.route(gapRoute, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("target") !== "last-turn") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: {
        state: string;
        reason?: string;
        comparison?: { state: string; reason?: string };
      };
    };
    if (body.data.comparison) {
      body.data.state = "gap";
      body.data.reason = "time-limit";
      body.data.comparison.state = "gap";
      body.data.comparison.reason = "time-limit";
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await changes
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  await finishedTurn.getByText(/capture gap/).waitFor();
  await finishedTurn.getByText(/Capture incomplete: time-limit\./).waitFor();
  await page.unroute(gapRoute);
  assert.equal(fixture.service.taskHold(task.taskId), undefined);
  assert.deepEqual(consoleErrors, []);
  assert.ok(historyRace503s.length <= 4, JSON.stringify(historyRace503s));
  assert.ok(
    race503Responses.every(
      (response) =>
        response.method === "GET" && response.code === "unavailable",
    ),
    JSON.stringify(race503Responses),
  );
  assert.deepEqual(pageErrors, []);
});
