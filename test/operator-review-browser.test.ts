import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
const test = browserSuite("ui04-review");
test("exact S1 R2 R3 S2 review retains scoped outcomes, captured context, comparison identities and local artifact feedback on desktop and phone", async (_t, j) => {
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
    workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
      "base64",
    ),
    before = randomUUID(),
    after = randomUUID(),
    missing = randomUUID();
  await writeFile(join(workspace.path, "before.png"), png);
  await writeFile(join(workspace.path, "after.png"), png);
  a.delegatedResult("R1 initial");
  const r2 = a.delegatedResult("R2 original scope", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: a.source.criteria[0]!.criterionId,
        outcome: "supported",
        scope: "Original focus scope",
        provenance: "Recorded keyboard check",
      },
      {
        criterionId: a.source.criteria[1]!.criterionId,
        outcome: "failed",
        scope: "Draft retention scope",
        provenance: "Recorded failed draft check",
      },
    ],
    validations: [
      {
        label: "Draft check",
        outcome: "failed",
        scope: "Original draft flow",
        provenance: "Fixture check",
      },
    ],
    artifacts: [
      {
        artifactId: before,
        label: "Before focus",
        role: "before",
        pairId: "focus-pair",
        revision: 1,
        availability: "available",
        file: {
          relativePath: "before.png",
          size: png.length,
          mime: "image/png",
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      },
      {
        artifactId: after,
        label: "After focus",
        role: "after",
        pairId: "focus-pair",
        revision: 2,
        availability: "available",
        file: {
          relativePath: "after.png",
          size: png.length,
          mime: "image/png",
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      },
      {
        artifactId: missing,
        label: "Unavailable historical side",
        role: "before",
        pairId: "missing-pair",
        revision: 1,
        availability: "unavailable",
      },
    ],
    changes: {
      files: ["web/focus.ts"],
      commits: ["1".repeat(40)],
      findings: [
        { finding: "Draft issue", repairAssignmentId: a.assignmentId },
      ],
    },
  });
  a.delegatedResult("R3 fixes only original draft scope", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: a.source.criteria[1]!.criterionId,
        outcome: "supported",
        scope: "Original draft scope only",
        provenance: "Recorded replacement check",
      },
    ],
  });
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: Number(f.service.domain().task(a.taskId).version),
    outcome:
      "- [ ] Restore focus\n- [ ] Retain drafts\n- [ ] New toolbar requirement",
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?section=review&result=${r2.resultId}&source=${a.source.sourceId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("R2 original scope", { exact: true }).waitFor();
  assert.ok(await page.getByText(/supported.*stale source revision/).count());
  assert.ok(await page.getByText(/failed.*stale source revision/).count());
  assert.equal(
    await page
      .getByText(
        "No viewing baseline. Comparison with previously viewed material is unknown.",
        { exact: true },
      )
      .count(),
    1,
  );
  assert.ok(await page.getByText(/Newer source revision 2/).count());
  assert.ok(await page.getByText(/No bound PR/).count());
  await page.locator("#review").scrollIntoViewIfNeeded();
  await page.getByAltText("before: Before focus").waitFor();
  assert.equal(
    await page
      .getByAltText("before: Before focus")
      .evaluate((el) => el instanceof HTMLImageElement && el.naturalWidth),
    1,
  );
  await captureBrowserEvidence(page, "1366-original-review");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".artifact-comparisons").scrollIntoViewIfNeeded();
  assert.equal(
    await page
      .locator(".artifact-comparisons")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    1,
  );
  await captureBrowserEvidence(page, "390-original-comparison");
  await page
    .getByRole("button", { name: "Ask lead about artifact", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Editable reply")
    .fill("Check this exact before artifact");
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .click();
  await page.getByText("Receipt recorded", { exact: true }).waitFor();
  const message = f.service
    .coordinationView()
    .readTask(a.taskId)
    .messages.find((m) => m.text === "Check this exact before artifact");
  assert.equal(message?.reference?.resultId, r2.resultId);
  assert.equal(message?.reference?.artifactId, before);
  assert.equal(message?.reference?.sourceId, a.source.sourceId);
  assert.equal(f.service.domain().task(a.taskId).state, "open");
  assert.equal(f.runtime.turns, 0);
});
