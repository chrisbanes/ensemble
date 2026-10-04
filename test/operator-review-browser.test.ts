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
  const r1 = a.delegatedResult("R1 initial", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: a.source.criteria[0]!.criterionId,
        outcome: "supported",
        scope: "Legacy supporting scope",
        provenance: "Legacy supported evidence",
      },
    ],
  });
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
        artifactId: randomUUID(),
        label: "Secondary before",
        role: "before",
        pairId: "secondary-pair",
        revision: 1,
        availability: "unavailable",
      },
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
  f.seedPersistedState((db) => {
    const row = db
      .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
      .get(r2.resultId) as { recordJson: string };
    const record = JSON.parse(row.recordJson);
    const duplicateId = randomUUID();
    record.metadata.artifacts.push(
      {
        artifactId: randomUUID(),
        label: "Secondary after",
        role: "after",
        pairId: "secondary-pair",
        revision: 1,
        availability: "unavailable",
      },
      {
        artifactId: randomUUID(),
        label: "Unpaired supplied capture",
        role: "evidence",
        revision: 1,
        availability: "unavailable",
      },
      ...["before", "after"].map((role) => ({
        artifactId: duplicateId,
        label: "Legacy duplicate",
        role,
        pairId: "legacy-duplicate",
        revision: 1,
        availability: "unavailable",
      })),
    );
    db.prepare(
      "UPDATE task_review_results SET recordJson=? WHERE resultId=?",
    ).run(JSON.stringify(record), r2.resultId);
    const legacy = JSON.parse(
      (
        db
          .prepare(
            "SELECT recordJson FROM task_review_results WHERE resultId=?",
          )
          .get(r1.resultId) as { recordJson: string }
      ).recordJson,
    );
    legacy.metadata.criteria.push({
      ...legacy.metadata.criteria[0],
      outcome: "failed",
      scope: "Legacy contradictory failed scope",
      provenance: "Legacy failed evidence",
    });
    db.prepare(
      "UPDATE task_review_results SET recordJson=? WHERE resultId=?",
    ).run(JSON.stringify(legacy), r1.resultId);
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
  await page
    .getByRole("button", { name: "Set viewing reference", exact: true })
    .click();
  await page.getByText(/1 new result/).waitFor();
  assert.deepEqual(f.service.taskReview().read(a.taskId).viewed?.resultIds, [
    r2.resultId,
  ]);
  assert.equal(
    f.service.taskReview().read(a.taskId).viewed?.sourceId,
    a.source.sourceId,
  );
  await page.getByLabel("Result revision").selectOption(r1.resultId);
  await page.getByText("R1 initial", { exact: true }).waitFor();
  await page
    .getByText("Duplicate criterion identity; overall outcome unknown.", {
      exact: true,
    })
    .waitFor();
  assert.ok(
    await page.getByText(/supported · Legacy supporting scope/).count(),
  );
  assert.ok(
    await page.getByText(/failed · Legacy contradictory failed scope/).count(),
  );

  await page.getByLabel("Result revision").selectOption(r2.resultId);
  await page.getByText("R2 original scope", { exact: true }).waitFor();
  const pair = page.locator('[data-artifact-pair="focus-pair"]');
  assert.equal(await pair.getByText(/Secondary/).count(), 0);
  assert.equal(
    await pair.locator('[data-artifact-role="before"] figure').count(),
    1,
  );
  assert.equal(
    await pair.locator('[data-artifact-role="after"] figure').count(),
    1,
  );
  assert.equal(await page.getByText(/Duplicate artifact identity/).count(), 2);
  assert.equal(
    await page.getByText("Unpaired recorded evidence", { exact: true }).count(),
    1,
  );
  const bounds = await page
    .locator("nav.task-actions a, #brief select, #review select")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    bounds.every((h) => h >= 36),
    JSON.stringify(bounds),
  );
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
  await page.locator(".artifact-comparisons").first().scrollIntoViewIfNeeded();
  assert.equal(
    await page
      .locator(".artifact-comparisons")
      .first()
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    1,
  );
  const phoneBounds = await page
    .locator("nav.task-actions a, #brief select, #review select")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    phoneBounds.every((h) => h >= 44),
    JSON.stringify(phoneBounds),
  );
  await captureBrowserEvidence(page, "390-original-comparison");
  await pair
    .locator('[data-artifact-role="before"]')
    .getByRole("button", { name: "Ask lead about artifact", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Editable reply")
    .fill("Check this exact before artifact");
  await page.route("**/api/operator/commands", async (route) => {
    const input = route.request().postDataJSON();
    if (input.type !== "message") return route.continue();
    const response = await route.fetch({
      postData: JSON.stringify({
        ...input,
        reference: {
          ...input.reference,
          sourceId: f.service.taskReview().sources(a.taskId).at(-1)?.sourceId,
        },
      }),
    });
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .click();
  await page.getByText(/conflict: conflict.*Draft retained/).waitFor();
  assert.ok(await page.getByLabel("Editable reply").isEditable());
  assert.equal(
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter((m) => m.eventType === "operator-message").length,
    0,
  );
  assert.equal(
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .count(),
    0,
  );
  await page.unroute("**/api/operator/commands");
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
