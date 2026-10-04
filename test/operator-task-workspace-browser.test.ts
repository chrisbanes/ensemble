import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { CoordinationStore } from "../src/core/coordination.js";
import { ConversationHistoryStore } from "../src/standalone/conversation-history.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { ExecutionState } from "../src/standalone/state.js";
import { seedReviewTask } from "./fixtures/task-review.js";
const test = browserSuite("ui04-workspace");
test("production workspace retains literal history, pending request, focused reply and exact result through updates and failed reads on desktop and phone", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f),
    r = a.delegatedResult("Original source-faithful result"),
    questionId = randomUUID();
  f.seedPersistedState((db) => {
    for (let i = 0; i < 250; i++)
      db.prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      ).run(
        r.workId,
        a.taskId,
        r.assignmentId,
        r.workId,
        r.workId,
        `item-${i}`,
        `Literal update ${i} ` +
          "long supplied text ".repeat(i === 249 ? 500 : 1),
      );
    db.prepare(
      "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,revision) VALUES(?,?,?,?,1,1,1,'question','open','Which focus target?',1)",
    ).run(questionId, a.taskId, r.assignmentId, r.workId);
  });
  const responsibilityAssignmentId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    assignmentId: responsibilityAssignmentId,
    projectId: a.projectId,
    taskId: a.taskId,
    profileId: a.profileId,
    brief: "Review responsibility distinct from implementation",
    resultDestination: a.assignmentId,
    requesterAssignmentId: a.assignmentId,
  });
  const responsibilityResult = a.result(
    "Exact responsibility review result",
    undefined,
    responsibilityAssignmentId,
  );
  f.seedPersistedState((db) => {
    const capture = new ConversationHistoryStore(db);
    for (const result of [
      r,
      { ...responsibilityResult, assignmentId: responsibilityAssignmentId },
    ]) {
      const binding = {
        taskId: a.taskId,
        assignmentId: result.assignmentId,
        workId: result.workId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: result === r ? 1 : 2,
        threadId: result.workId,
        turnId: result.workId,
      };
      capture.recordEarlyBufferLimit(binding);
      capture.recordEarlyBufferLimit(binding);
    }
  });
  const omissionApi = new OperatorApi(f.service, [f.directory]);
  const omissionOnly = await omissionApi.readAssignmentHistory(
    responsibilityAssignmentId,
  );
  assert.equal(omissionOnly.data.items.length, 0);
  assert.equal(omissionOnly.data.turnOmissions.length, 1);
  assert.equal(
    omissionOnly.data.turnOmissions[0]?.reason,
    "early-buffer-limit",
  );
  const mixed = await omissionApi.readAssignmentHistory(r.assignmentId);
  assert.equal(mixed.data.turnOmissions.length, 1);
  const earlierMixed = await omissionApi.readAssignmentHistory(
    r.assignmentId,
    mixed.data.items[0]!.sequence,
  );
  assert.equal(earlierMixed.data.turnOmissions.length, 1);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?result=${r.resultId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Evidence review", exact: true })
    .waitFor();
  await page
    .locator("#history")
    .getByText("Review responsibility distinct from implementation", {
      exact: true,
    })
    .waitFor({ state: "attached" });
  assert.ok((await page.getByText(/Requester assignment:/).count()) >= 2);
  assert.equal(
    await page.getByText("Which focus target?", { exact: true }).count(),
    1,
  );
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Load earlier retained history/ })
    .click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  const omission = page.locator(
    `[data-record-id="turn-omission:${r.workId}:${r.workId}:${r.workId}"]`,
  );
  await omission
    .getByText(
      `Early buffer limit (early-buffer-limit). Work ${r.workId}; assignment ${r.assignmentId}; thread ${r.workId}; turn ${r.workId}. Captured turn content is unavailable.`,
      { exact: true },
    )
    .waitFor();
  await omission.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-retained-turn-omissions", {
    fullPage: false,
  });
  const reading = page.locator(`[data-record-id="${r.workId}:item-0"]`);
  await reading.scrollIntoViewIfNeeded();
  const readingY = await reading.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  // Advance the actual retained window after its earlier page was loaded.
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      )
      .run(
        r.workId,
        a.taskId,
        r.assignmentId,
        r.workId,
        r.workId,
        "item-250",
        "Literal update 250 newer retained item",
      ),
  );
  await reading.locator("summary").focus();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await reading.evaluate((el) => el.getBoundingClientRect().top)) -
        readingY,
    ) < 4,
    JSON.stringify({
      readingY,
      actualY: await reading.evaluate((el) => el.getBoundingClientRect().top),
      scroll: await page.evaluate(() => scrollY),
    }),
  );
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const retainedIds = await page
    .locator(`[data-record-id^="${r.workId}:item-"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-record-id")));
  assert.equal(retainedIds.length, 251);
  assert.equal(new Set(retainedIds).size, 251);
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  for (let item = 0; item <= 250; item++)
    assert.ok(retainedIds.includes(`${r.workId}:item-${item}`));
  // Exercise the production 15-second polling callback without waiting wall-clock time.
  const timerHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await page.clock.runFor(15000);
  await timerHistory;
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const explicitRefresh = page.getByRole("button", {
    name: "Refresh task",
    exact: true,
  });
  const explicitHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await explicitRefresh.click();
  await explicitHistory;
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await explicitRefresh.evaluate((el) => el === document.activeElement),
    true,
  );
  await reading.locator("summary").focus();
  let releaseFocus!: () => void, enterFocus!: () => void;
  const focusBarrier = new Promise<void>((r) => (releaseFocus = r)),
    focusEntry = new Promise<void>((r) => (enterFocus = r));
  let focusHeld = false;
  const focusRoute = `**/api/operator/assignments/${r.assignmentId}/history*`;
  await page.route(focusRoute, async (route) => {
    const response = await route.fetch();
    if (!focusHeld) {
      focusHeld = true;
      enterFocus();
      await focusBarrier;
    }
    await route.fulfill({ response });
  });
  await explicitRefresh.evaluate((el) => (el as HTMLElement).click());
  await focusEntry;
  await reading.waitFor({ state: "detached" });
  await page.getByLabel("Editable reply").focus();
  releaseFocus();
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.unroute(focusRoute);
  await reading.scrollIntoViewIfNeeded();
  await reading.locator("summary").focus();
  const navigationReadingY = await reading.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await page
    .getByRole("link", { name: "Search", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await reading.evaluate((el) => el.getBoundingClientRect().top)) -
        navigationReadingY,
    ) < 4,
    JSON.stringify({
      readingY: navigationReadingY,
      actualY: await reading.evaluate((el) => el.getBoundingClientRect().top),
      scroll: await page.evaluate(() => scrollY),
    }),
  );
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByLabel("Editable reply")
    .fill("Navigation draft remains exact");
  const exactLink = page.getByRole("link", {
    name: `Open exact assignment result ${responsibilityResult.resultId}`,
    exact: true,
  });
  await exactLink.scrollIntoViewIfNeeded();
  await exactLink.focus();
  const exactY = await exactLink.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await exactLink.click();
  const reviewHeading = page.getByRole("heading", {
    name: "Evidence review",
    exact: true,
  });
  await page
    .getByText("Exact responsibility review result", { exact: true })
    .waitFor();
  const destination = await page.locator("#review").evaluate((el) => ({
    y: el.getBoundingClientRect().top,
    margin: parseFloat(getComputedStyle(el).scrollMarginTop),
  }));
  assert.ok(
    Math.abs(destination.y - destination.margin) < 4,
    JSON.stringify(destination),
  );
  assert.equal(
    await reviewHeading.evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByText("Exact responsibility review result", { exact: true })
    .waitFor();
  const returnedTask = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/operator/tasks/${a.taskId}` &&
      url.searchParams.get("resultId") === r.resultId
    );
  });
  const returnedHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await page.goBack();
  await returnedTask;
  await returnedHistory;
  await reading.waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await exactLink.evaluate((el) => el.getBoundingClientRect().top)) -
        exactY,
    ) < 4,
    JSON.stringify({
      expected: exactY,
      actual: await exactLink.evaluate((el) => el.getBoundingClientRect().top),
      path: page.url(),
      focus: await page.evaluate(() => document.activeElement?.outerHTML),
    }),
  );
  assert.equal(
    await exactLink.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Navigation draft remains exact",
  );
  await page
    .getByRole("button", { name: "Collapse all history", exact: true })
    .click();
  assert.ok(
    await page.getByText("Which focus target?", { exact: true }).isVisible(),
  );
  // The restored navigation draft has been checked; explicitly finish that intent.
  await page.getByLabel("Editable reply").fill("");
  await page
    .getByRole("button", { name: "Ask lead about result", exact: true })
    .click();
  await page.getByLabel("Editable reply").fill("Unfinished contextual reply");
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  a.delegatedResult("Newer result must not replace selected historical result");
  await page.getByLabel("Editable reply").focus();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => {
      if (el instanceof HTMLElement) el.click();
    });
  await page
    .getByText("Original source-faithful result", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page.getByLabel("Editable reply").focus();
  await page.route("**/api/operator/tasks/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page.getByText("unavailable", { exact: false }).first().waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  assert.ok(
    await page
      .getByText("Original source-faithful result", { exact: true })
      .isVisible(),
  );
  await captureBrowserEvidence(page, "1366-task-failed-refresh");
  await page.unroute("**/api/operator/tasks/*");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Editable reply").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-reply-with-anchor");
  await page.setViewportSize({ width: 390, height: 480 });
  await page.getByLabel("Editable reply").focus();
  assert.ok(
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .isEnabled(),
  );
  await captureBrowserEvidence(page, "390-keyboard-reply", { fullPage: false });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .waitFor();
  let lost = true;
  const replyRequests: string[] = [];
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type === "message") {
      replyRequests.push(route.request().postData() ?? "");
      if (lost) {
        lost = false;
        await route.fetch();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "command-outcome-unknown" } }),
        });
        return;
      }
    }
    await route.continue();
  });
  const taskBefore = f.service.domain().task(a.taskId).version;
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .click();
  await page.getByText(/unknown: command-outcome-unknown/).waitFor();
  assert.equal(await page.getByLabel("Editable reply").isDisabled(), true);
  await page
    .getByRole("button", { name: "Set viewing reference", exact: true })
    .click();
  await page
    .getByText("Observation / review receipt recorded", { exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .isEnabled(),
  );
  await page
    .getByRole("button", { name: "Refresh delivery observation", exact: true })
    .click();
  await page
    .getByText("Observation / review receipt recorded", { exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .isEnabled(),
  );
  await page.getByLabel("Editable reply").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-uncertain-reply", {
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Reconcile original operation", exact: true })
    .click();
  await page.getByText("Receipt recorded", { exact: true }).waitFor();
  assert.equal(replyRequests.length, 2);
  assert.equal(replyRequests[0], replyRequests[1]);
  assert.equal(f.service.domain().task(a.taskId).version, taskBefore);
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
  const local = f.service
    .coordinationView()
    .readTask(a.taskId)
    .messages.filter((m) => m.text === "Unfinished contextual reply");
  assert.equal(local.length, 1);
  assert.equal(local[0]?.reference?.resultId, r.resultId);
  a.result("Terminal accountable lead result");
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByText(/Task lead is completed; local message delivery is unavailable/)
    .waitFor();
  await page
    .getByRole("button", { name: "Ask lead about result", exact: true })
    .click();
  assert.ok(await page.getByLabel("Editable reply").isEditable());
  assert.equal(
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(replyRequests.length, 2);
  let releaseHistory!: () => void,
    historyEntered!: () => void,
    historySettled!: () => void;
  const historyBarrier = new Promise<void>((r) => (releaseHistory = r)),
    historyEntry = new Promise<void>((r) => (historyEntered = r)),
    historyDone = new Promise<void>((r) => (historySettled = r));
  let delayedHistory = false;
  const batchRequests: string[] = [];
  const historyRoute = `**/api/operator/assignments/${r.assignmentId}/history*`;
  await page.route(historyRoute, async (route) => {
    batchRequests.push(route.request().url());
    const response = await route.fetch();
    if (!delayedHistory && !route.request().url().includes("beforeSequence")) {
      delayedHistory = true;
      historyEntered();
      await historyBarrier;
      await route.fulfill({ response });
      historySettled();
    } else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await historyEntry;
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(f.service.domain().profile(a.profileId).version),
    instructions: "Literal update 0 long supplied text",
  });
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "detached" });
  await reading.getByText(/\[redacted\]/).waitFor({ state: "attached" });
  const replacementRequests = [...batchRequests];
  assert.equal(replacementRequests.length, 3);
  assert.equal(
    replacementRequests.filter((url) => url.includes("beforeSequence")).length,
    1,
  );
  releaseHistory();
  await historyDone;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(
    await page
      .getByText("Literal update 0 long supplied text ", { exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    batchRequests,
    replacementRequests,
    "Superseded recent-page response must not issue its next retained cursor",
  );
  assert.equal(
    await page.locator(`[data-record-id^="${r.workId}:item-"]`).count(),
    251,
  );
  await page.unroute(historyRoute);
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(f.service.domain().profile(a.profileId).version),
    instructions: "Literal update 1 long supplied text",
  });
  await page.route(historyRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByText(/History refresh failed:/)
    .first()
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByText("Literal update 1 long supplied text ", { exact: true })
      .count(),
    0,
  );
});

test("mounted Inbox discovers new requests and holds through timer and header refresh while retaining known detail focus", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Inbox questions", "Question task"),
    b = await seedReviewTask(f, "Inbox approvals", "Approval task"),
    routine = await seedReviewTask(f, "Routine result", "Routine task");
  routine.delegatedResult("Routine delivered result");
  const d = f.service.domain();
  for (const task of [a, b]) {
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      expectedVersion: Number(d.project(task.projectId).version),
      paused: false,
    });
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      ready: true,
    });
  }
  for (
    let n = 0;
    n < 100 && f.service.list().filter((w) => w.state === "running").length < 2;
    n++
  )
    await new Promise((r) => setTimeout(r, 10));
  const work = (taskId: string) => {
    const request = f.service
        .turnRequests()
        .find((r) => r.taskId === taskId && r.state === "active"),
      w = f.service.list().find((w) => w.workId === request?.workId);
    assert.ok(w?.threadId && w.turnId);
    return w;
  };
  const wa = work(a.taskId),
    wb = work(b.taskId);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("No recorded task attention.", { exact: true })
    .waitFor();
  const question = async (prompt: string) => {
    assert.equal(
      (
        await f.runtime.callTool({
          threadId: wa.threadId!,
          turnId: wa.turnId!,
          callId: randomUUID(),
          tool: "ensemble_ask_question",
          arguments: { question: prompt },
        })
      ).success,
      true,
    );
  };
  await question("New timer-discovered question");
  const catalogResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/task-list" && r.ok(),
  );
  await page.clock.runFor(15000);
  await catalogResponse;
  const firstLink = page.getByRole("link", {
    name: "question: New timer-discovered question",
    exact: true,
  });
  await firstLink.waitFor();
  assert.ok(
    (await firstLink.getAttribute("href"))?.includes(
      `tasks/${a.taskId}?request=`,
    ),
  );
  await firstLink.focus();
  await question("Second question on known Inbox task");
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByRole("link", {
      name: "question: Second question on known Inbox task",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await firstLink.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: wb.threadId!,
        turnId: wb.turnId!,
        callId: randomUUID(),
        tool: "ensemble_request_approval",
        arguments: {
          action: "Inspect retained material",
          material: { scope: "fixture" },
        },
      })
    ).success,
    true,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const approvalLink = page.getByRole("link", {
    name: "approval: Approval requested for Inspect retained material",
    exact: true,
  });
  await approvalLink.waitFor();
  assert.ok(
    (await approvalLink.getAttribute("href"))?.includes(
      `tasks/${b.taskId}?request=`,
    ),
  );
  assert.equal(
    await page.getByRole("link", { name: "Routine task", exact: true }).count(),
    0,
  );
  f.seedPersistedState((db) => {
    const c = new CoordinationStore(db, d);
    for (const q of c
      .interactions(a.taskId)
      .filter((q) => q.kind === "question" && q.status === "open"))
      c.answerQuestion({
        actor: "operator",
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: q.revision,
        answer: "Recorded answer",
      });
    for (const approval of c
      .interactions(b.taskId)
      .filter((q) => q.kind === "approval" && q.status === "open"))
      c.decideApproval({
        actor: "operator",
        key: randomUUID(),
        interactionId: approval.interactionId,
        expectedRevision: approval.revision,
        decision: "denied",
        action: "Inspect retained material",
        material: { scope: "fixture" },
      });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("No recorded task attention.", { exact: true })
    .waitFor();
  f.seedPersistedState((db) =>
    new ExecutionState(db).hold(wa.id, "Fixture ownership unknown"),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("link", { name: "Question task", exact: true })
    .waitFor();
  await captureBrowserEvidence(page, "1366-inbox-new-attention");
  await page.route("**/api/operator/task-list*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Question task", exact: true })
      .count(),
    1,
  );
});
