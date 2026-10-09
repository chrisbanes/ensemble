import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser } from "playwright";
import {
  RetainedEvidenceStore,
  type RetainedEvidenceCandidate,
  type RetainedEvidenceIdentity,
} from "../src/core/retained-evidence.js";
import { transaction } from "../src/core/store.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui09-retained-inspection");
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iY9sAAAAASUVORK5CYII=",
  "base64",
);

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("production retained result evidence keeps original bytes and opens current files only explicitly", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const seeded = await seedReviewTask(
    fixture,
    "Retained inspection",
    "Inspect retained result evidence",
    "Keep original result bytes",
  );
  const workspace = await fixture.service.taskWorkspace(seeded.taskId);
  assert.ok(workspace);
  const textPath = join(workspace.path, "retained-proof.txt");
  await writeFile(textPath, "before first\nbefore second\n");
  await writeFile(join(workspace.path, "retained-proof.png"), png);

  const domain = fixture.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: Number(domain.project(seeded.projectId).version),
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(domain.task(seeded.taskId).version),
    ready: true,
  });
  await until(
    () => fixture.service.list().some((work) => work.state === "running"),
    "running lead turn",
  );
  const work = fixture.service.list().find((item) => item.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const callbackText = "callback first\ncallback second\n";
  await writeFile(textPath, callbackText);
  const reported = await fixture.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Retain callback evidence",
      review: {
        sourceId: seeded.source.sourceId,
        changes: { files: ["retained-proof.txt"] },
        artifacts: [
          {
            artifactId: randomUUID(),
            label: "Original screenshot",
            role: "evidence",
            revision: 1,
            availability: "available",
            file: {
              relativePath: "retained-proof.png",
              sha256: digest(png),
              mime: "image/png",
              size: png.byteLength,
            },
          },
        ],
      },
    },
  });
  assert.equal(reported.success, true, reported.text);
  fixture.runtime.complete(fixture.runtime.turns);
  await until(
    () => !fixture.service.list().some((item) => item.state === "running"),
    "finished lead turn",
  );
  const result = fixture.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((item) => item.workId === work.workId);
  assert.ok(result);
  const manifest = fixture.service
    .retainedEvidence()
    .result(seeded.taskId, result.resultId);
  const textItem = manifest?.items.find(
    (item) => item.kind === "file" && item.path === "retained-proof.txt",
  );
  assert.ok(textItem?.state === "available");

  // Later workspace bytes must never replace the retained original.
  await writeFile(textPath, "later workspace bytes\n");

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

  const direct = `/app/tasks/${seeded.taskId}?section=review&result=${result.resultId}&evidence=${textItem.itemId}`;
  await page.goto(web.origin + direct);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const retained = page.locator(".retained-evidence");
  await retained
    .getByRole("heading", { name: "Retained result evidence", exact: true })
    .waitFor();
  await retained.getByText("callback first", { exact: true }).waitFor();
  assert.equal(await retained.getByText("later workspace bytes").count(), 0);
  assert.match(await retained.innerText(), new RegExp(result.resultId));
  await retained.getByText("Capture provenance", { exact: true }).click();
  const provenance = await retained.locator(".retained-provenance").innerText();
  assert.match(provenance, new RegExp(work.turnId));
  assert.match(provenance, new RegExp(result.assignmentId));
  assert.match(
    await retained.getByLabel("Retained evidence items").innerText(),
    /diff gap: comparison-unsettled/,
  );
  await captureBrowserEvidence(page, "1366-retained-original-text");

  // Opening current contents is a separate, explicit action.
  await retained
    .getByRole("button", { name: "Open current file in Files", exact: true })
    .click();
  const files = page.locator("#files");
  await files.getByText("later workspace bytes", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Files",
  );
  assert.equal(
    await retained.getByText("callback first", { exact: true }).count(),
    1,
  );

  await retained
    .getByRole("button", { name: /^file · retained-proof\.png/ })
    .click();
  await retained.getByText(/Bounded raster preview · 1 × 1 pixels/).waitFor();

  // Removing the workspace file and reloading keeps the original bytes.
  await rm(textPath);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(web.origin + direct);
  await retained.getByText("callback first", { exact: true }).waitFor();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone retained evidence has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-retained-after-removal", {
    fullPage: false,
  });

  // Start/End controls build a range over retained bytes and mark the focus-return line.
  const setStart = retained.getByRole("button", {
    name: "Set start",
    exact: true,
  });
  const setEnd = retained.getByRole("button", { name: "Set end", exact: true });
  for (const control of [setStart, setEnd])
    assert.ok(
      (await control.evaluate(
        (element) => element.getBoundingClientRect().height,
      )) >= 44,
    );
  await retained
    .getByRole("button", { name: /^Line 1: callback first/ })
    .click();
  await setStart.click();
  await retained
    .getByRole("button", { name: /^Line 2: callback second/ })
    .click();
  await setEnd.click();
  await retained.getByText("Selected lines 1–2", { exact: true }).waitFor();
  assert.equal(
    await retained
      .locator(`[data-review-return="retained:${textItem.itemId}"]`)
      .getAttribute("aria-label"),
    "Line 2: callback second",
  );

  // An unknown evidence item explains unavailability without current bytes.
  await page.goto(
    web.origin +
      `/app/tasks/${seeded.taskId}?section=review&result=${result.resultId}&evidence=${randomUUID()}`,
  );
  await retained
    .getByText(/Retained item is unavailable|Retained item could not be read/)
    .waitFor();
  assert.equal(await retained.getByText("callback first").count(), 0);

  assert.equal(fixture.service.taskHold(seeded.taskId), undefined);
  assert.deepEqual(
    consoleErrors.filter((text) => !/\b404\b/.test(text)),
    [],
  );
  assert.deepEqual(pageErrors, []);
});

test("production retained diff evidence renders its original Before and After read-only on desktop and phone", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const seeded = await seedReviewTask(
    fixture,
    "Retained diff",
    "Inspect a retained diff",
    "Keep the original diff",
  );
  const legacy = seeded.result("Retained exact diff owner", {
    sourceId: seeded.source.sourceId,
  });
  const result = fixture.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((item) => item.resultId === legacy.resultId);
  assert.ok(result);
  const workspace = await fixture.service.taskWorkspace(seeded.taskId);
  assert.ok(workspace);
  const domain = fixture.service.domain();
  const task = domain.task(seeded.taskId);
  const assignment = domain.assignment(result.assignmentId);
  const profile = domain.profile(String(assignment.profileId));
  const project = domain.project(seeded.projectId);
  const identity: RetainedEvidenceIdentity = {
    taskId: seeded.taskId,
    taskVersion: Number(task.version),
    captureTaskVersion: Number(task.version),
    assignmentId: result.assignmentId,
    assignmentVersion: result.assignmentVersion,
    workId: result.workId,
    workRevision: result.workRevision,
    requestSequence: 1,
    conversationRevision: 1,
    instructionsRevision: Number(project.instructionsRevision),
    profileRevision: Number(profile.version),
    profileId: String(profile.id),
    threadId: result.workId,
    turnId: result.workId,
  };
  const comparisonId = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      repositoryId: null,
      path: "notes.txt",
      left: { state: "text", text: "line one\nline two\nline three\n" },
      right: {
        state: "text",
        text: "line one\nline 2 changed\nline three\nline four\n",
      },
    }),
  );
  const itemId = randomUUID();
  const capturedAt = Date.now();
  const candidate: RetainedEvidenceCandidate = {
    version: 1,
    evidenceId: randomUUID(),
    capturedAt,
    identity,
    sourceObservation: {
      comparisonId,
      captureState: "finished",
      outcome: "completed",
      observedAt: capturedAt,
    },
    items: [
      {
        itemId,
        kind: "diff",
        state: "available",
        source: "observed-diff",
        sourceIndex: 0,
        repositoryId: null,
        path: "notes.txt",
        originRoot: workspace.path,
        mime: "application/vnd.ensemble.workspace-diff+json",
        sha256: digest(payload),
        size: payload.byteLength,
        capturedAt,
        observedAt: capturedAt,
        provenance: { comparisonId, entryIndex: 0, change: "modified" },
        bytes: Uint8Array.from(payload),
      },
    ],
  };
  const database = new DatabaseSync(
    join(fixture.directory, "data", "standalone.sqlite"),
  );
  try {
    transaction(database, () =>
      new RetainedEvidenceStore(database).recordResultWithinTransaction(
        {
          resultId: result.resultId,
          taskId: result.taskId,
          assignmentId: result.assignmentId,
          assignmentVersion: result.assignmentVersion,
          workId: result.workId,
          workRevision: result.workRevision,
        },
        identity,
        candidate,
      ),
    );
  } finally {
    database.close();
  }

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

  await page.goto(
    `${web.origin}/app/tasks/${seeded.taskId}?section=review&result=${result.resultId}&evidence=${itemId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const retained = page.locator(".retained-evidence");
  const diff = retained.locator(".retained-diff");
  await diff.waitFor();

  // Original Before and After, not the raw workspace-diff JSON.
  assert.equal(await retained.getByText(/"version"/).count(), 0);
  const panels = diff.locator(".changes-diff-side");
  assert.deepEqual(await panels.locator("h6").allTextContents(), [
    "Before",
    "After",
  ]);
  assert.deepEqual(
    await panels.nth(0).locator(".changes-line-deleted code").allTextContents(),
    ["line two"],
  );
  assert.deepEqual(
    await panels.nth(1).locator(".changes-line-added code").allTextContents(),
    ["line 2 changed", "line four"],
  );
  assert.deepEqual(
    await panels.nth(0).locator(".changes-line-number").allTextContents(),
    ["1", "2", "3"],
  );
  assert.equal(
    await panels.nth(0).locator(".changes-line-empty").count(),
    1,
    "the added line has no Before counterpart",
  );
  assert.deepEqual(
    await panels.nth(1).locator(".changes-line-number").allTextContents(),
    ["1", "2", "3", "4"],
  );
  const text = await retained.innerText();
  assert.match(text, /notes\.txt · Before 3 lines · After 4 lines/);
  assert.match(text, new RegExp(digest(payload)));

  // Comments are not offered for diffs; the limitation is stated instead.
  await diff
    .getByText(/Review comments cannot be added to a retained diff/)
    .waitFor();
  assert.equal(await diff.locator("button.changes-selectable-line").count(), 0);
  assert.equal(
    await retained
      .getByRole("button", { name: "Add review comment", exact: true })
      .count(),
    0,
  );
  await captureBrowserEvidence(page, "1366-retained-diff-split");

  await diff.getByRole("button", { name: "Unified", exact: true }).click();
  const added = diff
    .locator(".changes-diff-unified .changes-line-added")
    .first();
  assert.deepEqual(
    await added.evaluate((element) => ({
      old: element.querySelector(".changes-line-old")?.textContent,
      next: element.querySelector(".changes-line-new")?.textContent,
    })),
    { old: "", next: "2" },
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await diff.locator(".changes-diff-unified").waitFor();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone retained diff has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-retained-diff-unified", {
    fullPage: false,
  });

  assert.equal(fixture.service.taskHold(seeded.taskId), undefined);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
});
