import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
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
  a.result(
    "Exact responsibility review result",
    undefined,
    responsibilityAssignmentId,
  );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
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
  const reading = page.locator(`[data-record-id="${r.workId}:item-0"]`);
  await reading.scrollIntoViewIfNeeded();
  const readingY = await reading.evaluate(
    (el) => el.getBoundingClientRect().top,
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
  await reading.locator("summary").focus();
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
  await page
    .getByRole("button", { name: "Collapse all history", exact: true })
    .click();
  assert.ok(
    await page.getByText("Which focus target?", { exact: true }).isVisible(),
  );
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
});
