import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
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
  assert.fail("Timed out waiting for " + description);
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
