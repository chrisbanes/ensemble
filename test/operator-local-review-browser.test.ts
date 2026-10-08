import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
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

test("production local review composes exact multi-origin anchors and sends one receipt", async (_t, j) => {
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
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Add review comment",
  );

  // Escape cancels without saving and restores focus.
  await fileComment.click();
  await page.keyboard.type("discarded text");
  await page.keyboard.press("Escape");
  await fileComposer.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Add review comment",
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
  assert.equal((draftText.match(/ · current\b/g) ?? []).length, 2);

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
  const sent = review.getByRole("region", { name: "Sent review" });
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
    .getByText(/An unsent draft from an earlier session was removed/)
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
