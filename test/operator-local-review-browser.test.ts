import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui10-local-review");

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function sourceRepository(root: string) {
  const path = join(root, "alpha");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  git(path, "config", "user.name", "Local Review Test");
  git(path, "config", "user.email", "local-review@example.invalid");
  writeFileSync(join(path, "review.txt"), "first\nsecond\nthird\nfourth\n");
  writeFileSync(join(path, "diff.txt"), "keep\ndrop one\ndrop two\ntail\n");
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "base");
  return path;
}

async function signIn(
  page: Page,
  origin: string,
  path: string,
  password: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

type Journey = BrowserJourney;

/** A seeded task with a bound repository, a signed-out browser page and web fixture. */
async function startReview(
  j: Journey,
  viewport = { width: 1366, height: 900 },
) {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const source = sourceRepository(join(fixture.directory, "review-sources"));
  const task = await seedReviewTask(
    fixture,
    "Local review",
    "Review exact lines",
    "Send one local review",
    [{ repositoryId: "repo-alpha", path: source }],
  );
  // Production binds repositories only from the project's linked repositories.
  const domain = fixture.service.domain();
  await domain.configureGitHub({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.githubConfiguration(task.projectId).version),
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R_1",
        owner: "org",
        name: "repo",
      },
    ],
    repositories: [{ repositoryId: "repo-alpha", path: source, ref: "main" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  });
  const binding = await fixture.service.taskWorkspace(task.taskId);
  const alpha = binding?.repositories[0]?.workspacePath;
  assert.ok(alpha);
  writeFileSync(join(alpha, "diff.txt"), "keep\ntail\n");
  const events = () => {
    let count = 0;
    fixture.seedPersistedState((db) => {
      count = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE taskId=? AND eventType='operator-message'",
            )
            .get(task.taskId) as { count: number | bigint }
        ).count,
      );
    });
    return count;
  };

  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport,
  });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { fixture, task, web, page, consoleErrors, pageErrors, events };
}

test("production local review composes exact multi-origin anchors and sends one receipt", async (_t, j) => {
  const { fixture, task, web, page, consoleErrors, pageErrors, events } =
    await startReview(j);
  const taskPath = `/app/tasks/${task.taskId}?section=files`;
  await signIn(page, web.origin, taskPath, web.password);

  // Current file: select lines 2–3 and comment.
  const files = page.locator("#files");
  await files
    .getByRole("button", { name: /repo-alpha, repository, full path/ })
    .click();
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Line 3: third" })
    .click({ modifiers: ["Shift"] });
  await files.getByText("Selected lines 2–3", { exact: true }).waitFor();
  const fileComment = files.getByRole("button", {
    name: "Add review comment",
    exact: true,
  });
  await fileComment.click();
  const fileComposer = files.getByRole("form", { name: "Review comment" });
  assert.match(
    await fileComposer.innerText(),
    /Comment on current file · repo-alpha\/review\.txt · lines 2–3/,
  );
  await page.keyboard.type("Current file comment");
  await fileComposer
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await fileComposer.waitFor({ state: "detached" });
  // Focus returns to the invoking line (lines 2–3; the current line is 3).
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Line 3: third",
  );

  // Escape cancels without saving and restores focus.
  await fileComment.click();
  await page.keyboard.type("discarded text");
  await page.keyboard.press("Escape");
  await fileComposer.waitFor({ state: "detached" });
  // Focus returns to the invoking line (lines 2–3; the current line is 3).
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Line 3: third",
  );

  // Changes: Before deleted lines from an exact Uncommitted comparison.
  const changes = page.locator("#changes");
  await changes.getByLabel("Comparison target").selectOption("uncommitted");
  await changes.getByRole("button", { name: /modified diff\.txt/ }).click();
  await changes
    .getByRole("button", { name: /^Before line 2, diff\.txt;/ })
    .first()
    .click();
  await changes
    .getByRole("button", { name: /^Before line 3, diff\.txt;/ })
    .first()
    .click({ modifiers: ["Shift"] });
  await changes.getByText(/Selected Before lines 2–3 · diff\.txt/).waitFor();
  await changes
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  const changesComposer = changes.getByRole("form", { name: "Review comment" });
  assert.match(
    await changesComposer.innerText(),
    /Comment on uncommitted comparison · repo-alpha\/diff\.txt · lines 2–3 · Before/,
  );
  await page.keyboard.type("Deleted lines comment");
  await changesComposer
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await changesComposer.waitFor({ state: "detached" });

  // The complete draft shows both comments with original context.
  const review = page.locator("#local-review");
  const comments = review.getByRole("list", { name: "Review comments" });
  await comments.locator(":scope > li").nth(1).waitFor();
  await comments.getByText(/diff\.txt · lines 2–3/).waitFor();
  await comments.getByText(/review\.txt · lines 2–3/).waitFor();
  const draftText = await comments.innerText();
  assert.match(draftText, /repo-alpha\/review\.txt · lines 2–3 · workspace/);
  assert.match(draftText, /second\nthird/);
  assert.match(
    draftText,
    /repo-alpha\/diff\.txt · lines 2–3 · uncommitted · Before/,
  );
  assert.match(draftText, /drop one\ndrop two/);
  assert.equal(
    (draftText.match(/Current at last comparison/g) ?? []).length,
    2,
  );
  assert.match(draftText, /(observed|captured) .*\d/);

  // Edit, add summary, reload: draft persists within the live session.
  await comments.getByRole("button", { name: "Edit" }).first().click();
  await review.getByLabel("Edit comment").fill("Edited file comment");
  await review.getByRole("button", { name: "Save edit" }).click();
  await review.getByText("Edited file comment").waitFor();
  await review.getByLabel("Summary (optional)").fill("Two exact notes");
  await review.getByRole("button", { name: "Save summary" }).click();
  await review.getByRole("button", { name: "Save summary" }).waitFor({
    state: "detached",
  });
  await page.reload();
  await review.getByText("Edited file comment").waitFor();
  assert.equal(
    await review.getByLabel("Summary (optional)").inputValue(),
    "Two exact notes",
  );
  assert.match(await review.innerText(), /Destination: .*project lead/);
  await captureBrowserEvidence(page, "1366-local-review-complete-draft");

  // A response lost after commit stays unknown and reconciles to one event.
  assert.equal(events(), 0);
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.send") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await review
    .getByRole("button", { name: /^Send review \(2 comments\)/ })
    .click();
  await review.getByText(/Delivery to .* is unknown/).waitFor();
  await page.unroute("**/api/operator/commands");
  assert.equal(events(), 1);
  await review.getByRole("button", { name: "Check delivery" }).click();
  await review
    .getByText(/Review sent to .*One local message was queued/)
    .waitFor();
  assert.equal(events(), 1, "reconciliation never sends a second event");
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Edited file comment").waitFor();
  await sent.getByText(/diff\.txt · lines 2–3/).waitFor();
  await sent.getByText(/review\.txt · lines 2–3/).waitFor();
  assert.match(await sent.innerText(), /Summary: Two exact notes/);
  assert.match(await sent.innerText(), /drop one\ndrop two/);
  assert.equal(fixture.service.taskHold(task.taskId), undefined);

  // A new review starts empty; submitted context stays inspectable server-side.
  await review.getByRole("button", { name: "Start a new review" }).click();
  await review.getByText("No review comments yet.").waitFor();

  // An unsent draft does not cross sign-out.
  await files
    .getByRole("button", { name: /repo-alpha, repository, full path/ })
    .click();
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 1: first" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Unsent private note");
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await review.getByText("Unsent private note").waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=local-review`,
    web.password,
  );
  await review
    .getByText(
      /An unsent draft was removed when its session ended or its access changed/,
    )
    .waitFor();
  assert.equal(await page.getByText("Unsent private note").count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await review.scrollIntoViewIfNeeded();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone review has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-local-review-after-sign-in", {
    fullPage: false,
  });
  assert.deepEqual(
    // Only the deliberately reset send and the post-sign-out session probe may fail.
    consoleErrors.filter(
      (text) =>
        !/net::ERR_CONNECTION_RESET|status of 401 \(Unauthorized\)/.test(text),
    ),
    [],
  );
  assert.deepEqual(pageErrors, []);
});

/** Selects one current-file line of review.txt and saves a comment on it. */
async function commentOnLine(page: Page, line: string, text: string) {
  const files = page.locator("#files");
  const repository = files.getByRole("button", {
    name: /repo-alpha, repository, full path/,
  });
  const target = files.getByRole("button", { name: line });
  // The first call opens the file; later calls find it already open.
  await repository.or(target).first().waitFor();
  if (await repository.isVisible()) {
    await repository.click();
    await files.getByRole("button", { name: /review\.txt/ }).click();
  }
  await target.click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type(text);
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await page.locator("#local-review").getByText(text).waitFor();
}

const activeAttribute = (page: Page, name: string) =>
  page.waitForFunction(
    (attribute) => document.activeElement?.hasAttribute(attribute),
    name,
  );

test("local review keeps focus on the selection, the next comment and the heading", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  await commentOnLine(page, "Line 2: second", "Second note");
  await commentOnLine(page, "Line 3: third", "Third note");

  // Saving and Escape both return focus to the invoking line.
  const files = page.locator("#files");
  await page.waitForFunction(
    () =>
      document.activeElement?.hasAttribute("data-review-return") === true &&
      document.activeElement?.textContent?.includes("third") === true,
  );
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await files.getByRole("form", { name: "Review comment" }).waitFor({
    state: "detached",
  });
  await page.waitForFunction(
    () =>
      document.activeElement?.hasAttribute("data-review-return") === true &&
      document.activeElement?.textContent?.includes("third") === true,
  );

  const review = page.locator("#local-review");
  const items = review
    .getByRole("list", { name: "Review comments" })
    .locator(":scope > li");
  await items.nth(2).waitFor();

  // Escape cancels an edit, keeps the saved text and returns to its Edit button.
  await items.first().getByRole("button", { name: "Edit" }).click();
  await review.getByLabel("Edit comment").fill("Unsaved edit");
  await page.keyboard.press("Escape");
  await review.getByLabel("Edit comment").waitFor({ state: "detached" });
  await activeAttribute(page, "data-review-edit");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Edit",
  );
  await review.getByText("First note", { exact: true }).waitFor();
  assert.equal(await review.getByText("Unsaved edit").count(), 0);

  // Removing moves focus to the next comment, the previous one when last, and
  // finally to the Local review heading.
  const commentFocused = (text: string) =>
    page.waitForFunction(
      (expected) =>
        document.activeElement?.hasAttribute("data-comment-id") &&
        document.activeElement.textContent?.includes(expected),
      text,
    );
  await items.first().getByRole("button", { name: "Remove" }).click();
  await commentFocused("Second note");
  await items.last().getByRole("button", { name: "Remove" }).click();
  await commentFocused("Second note");
  assert.equal(await items.count(), 1);
  await items.first().getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(
    () => document.activeElement?.id === "local-review-heading",
  );
  await review.getByText("No review comments yet.").waitFor();
  assert.deepEqual(pageErrors, []);
});

test("phone local review comments and sends to a receipt using the keyboard", async (_t, j) => {
  const { web, task, page, events, pageErrors } = await startReview(j, {
    width: 390,
    height: 844,
  });
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  await files
    .getByRole("button", { name: /repo-alpha, repository, full path/ })
    .click();
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  const add = files.getByRole("button", {
    name: "Add review comment",
    exact: true,
  });
  await add.focus();
  await page.keyboard.press("Enter");
  const composer = files.getByRole("form", { name: "Review comment" });
  await composer.waitFor();
  await page.keyboard.type("Phone keyboard comment");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Save comment",
  );
  await page.keyboard.press("Enter");
  await composer.waitFor({ state: "detached" });
  await page.waitForFunction(
    () =>
      document.activeElement?.closest("#files") !== null &&
      document.activeElement !== document.body,
  );

  // Move to the complete review with the section navigation, then send.
  const nav = page.getByRole("navigation", { name: "Task sections" });
  await nav.getByRole("link", { name: "Local review" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.activeElement?.id === "local-review-heading",
  );
  const review = page.locator("#local-review");
  await review.getByText("Phone keyboard comment").waitFor();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone review has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-local-review-keyboard-draft", {
    fullPage: false,
  });
  const send = review.getByRole("button", {
    name: /^Send review \(1 comment\)/,
  });
  await send.focus();
  await page.keyboard.press("Enter");
  await review
    .getByText(/Review sent to .*One local message was queued/)
    .waitFor();
  assert.equal(events(), 1);
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Phone keyboard comment").waitFor();
  await captureBrowserEvidence(page, "390-local-review-keyboard-receipt", {
    fullPage: false,
  });
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone receipt has no horizontal page scroll",
  );
  assert.deepEqual(pageErrors, []);
});

test("send is disabled with an explanation once the project lead has completed", async (_t, j) => {
  const { web, task, page, events, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Comment for a finished lead");
  const review = page.locator("#local-review");
  const send = review.getByRole("button", {
    name: /^Send review \(1 comment\)/,
  });
  assert.equal(await send.isEnabled(), true);

  // A terminal result completes the accountable lead's assignment.
  task.result("Terminal lead result");
  await page.reload();
  await review.getByText("Comment for a finished lead").waitFor();
  assert.equal(await send.isDisabled(), true);
  await review
    .getByText(
      /The project lead's assignment is completed and cannot receive a review/,
    )
    .waitFor();
  assert.equal(events(), 0);
  assert.deepEqual(pageErrors, []);
});

// Depends on the server's local-review-recipient-unavailable (409) rejection.
test("a lead that completes after the page loaded gives a definitive rejection", async (_t, j) => {
  const { web, task, page, events, consoleErrors, pageErrors } =
    await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Comment for a stale lead");
  const review = page.locator("#local-review");
  task.result("Terminal lead result");
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await review
    .getByText(
      /not delivered \(the project lead can no longer receive a review\)/,
    )
    .waitFor();
  assert.equal(events(), 0);
  await review.getByRole("button", { name: "Return to draft" }).click();
  await review.getByText("Comment for a stale lead").waitFor();
  assert.equal(
    await review.getByRole("button", { name: /^Send review/ }).count(),
    1,
  );
  assert.deepEqual(
    consoleErrors.filter((text) => !/status of 409/.test(text)),
    [],
  );
  assert.deepEqual(pageErrors, []);
});

// Depends on the server's GET /api/operator/tasks/{id}/local-reviews route.
test("sent reviews stay inspectable after reload and Start a new review", async (_t, j) => {
  const { web, task, page, events, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Durable sent comment");
  const review = page.locator("#local-review");
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await review
    .getByText(/Review sent to .*One local message was queued/)
    .waitFor();
  assert.equal(events(), 1);

  await page.reload();
  await review.getByRole("button", { name: "Start a new review" }).click();
  await review.getByText("No review comments yet.").waitFor();
  const list = review.getByRole("region", {
    name: "Sent reviews",
    exact: true,
  });
  await list.waitFor();
  assert.equal(await list.getByRole("listitem").count(), 1);
  assert.match(await list.innerText(), /to .* · review [0-9a-f-]{36}/);
  await list.getByRole("button", { name: /^Inspect review/ }).click();
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Durable sent comment").waitFor();
  assert.match(await sent.innerText(), /recorded /);
  assert.equal(events(), 1);
  assert.deepEqual(pageErrors, []);
});
