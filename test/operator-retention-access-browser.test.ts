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
import { seedRetainedReviewWindow } from "./fixtures/task-review.js";
import { ConversationHistoryStore } from "../src/standalone/conversation-history.js";
const test = browserSuite("ui04-retention-access");
test("historical Search opens exact old evidence and independently pages all retained omission turns with refresh and reading state", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
      "base64",
    ),
    artifactId = randomUUID();
  const a = await seedRetainedReviewWindow(f, [
    {
      artifactId,
      label: "Ancient artifact",
      role: "evidence",
      revision: 1,
      availability: "available",
      file: {
        relativePath: "ancient.png",
        mime: "image/png",
        size: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    },
  ]);
  const workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "ancient.png"), png);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/search`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Ancient decision");
  await page.getByLabel("Include historical records").check();
  await page
    .getByLabel("Record type", { exact: true })
    .selectOption("decision");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page
    .locator(`[data-search-record="${a.old.resultId}:decision:0"] a`)
    .click();
  await page.getByText("Ancient review result", { exact: true }).waitFor();
  await page
    .locator("#review")
    .getByText(/Ancient criterion · supported/)
    .waitFor();
  assert.ok(page.url().includes(`result=${a.old.resultId}`));
  assert.ok(page.url().includes(`source=${a.source.sourceId}`));
  assert.equal(
    (
      await page.request.get(
        `${web.origin}/api/operator/tasks/${a.taskId}?resultId=invalid`,
      )
    ).status(),
    400,
  );
  assert.equal(
    (
      await page.request.get(
        `${web.origin}/api/operator/assignments/${a.assignmentId}/history?beforeOmissionSequence=0`,
      )
    ).status(),
    400,
  );
  const preview = page.getByRole("img", {
    name: "evidence: Ancient artifact",
    exact: true,
  });
  await preview.scrollIntoViewIfNeeded();
  await preview.waitFor();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'img[alt="evidence: Ancient artifact"]',
        ) as HTMLImageElement | null
      )?.naturalWidth === 1,
  );
  assert.equal(
    await preview.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    1,
  );
  await page
    .locator("#review")
    .getByText(/Ancient criterion · supported/)
    .scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-exact-old-review", {
    fullPage: false,
  });
  await page.getByLabel("Editable reply").fill("Retained exact old draft");
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  const omissionRecords = page.locator('[data-record-id^="turn-omission:"]');
  assert.equal(await omissionRecords.count(), 200);
  await page
    .getByRole("button", {
      name: "Load earlier retained turn omissions (71)",
      exact: true,
    })
    .click();
  const oldRecord = page.locator(
    `[data-record-id="turn-omission:${a.old.workId}:${a.old.workId}:${a.old.workId}"]`,
  );
  await oldRecord.waitFor();
  assert.equal(await omissionRecords.count(), 271);
  assert.equal(
    new Set(
      await omissionRecords.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-record-id")),
      ),
    ).size,
    271,
  );
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  assert.equal(await omissionRecords.count(), 271);
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  await oldRecord.scrollIntoViewIfNeeded();
  await oldRecord.locator("summary").focus();
  const y = await oldRecord.evaluate((el) => el.getBoundingClientRect().top);
  const next = a.result("Newest retained result", {
    sourceId: f.service.taskReview().sources(a.taskId).at(-1)!.sourceId,
  });
  f.seedPersistedState((db) => {
    const capture = new ConversationHistoryStore(db);
    const binding = {
      taskId: a.taskId,
      assignmentId: a.assignmentId,
      workId: next.workId,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      workRevision: 272,
      threadId: next.workId,
      turnId: next.workId,
    };
    capture.recordEarlyBufferLimit(binding);
    const oldBinding = {
      ...binding,
      workId: a.old.workId,
      workRevision: 1,
      threadId: a.old.workId,
      turnId: a.old.workId,
    };
    capture.record(
      oldBinding,
      {
        kind: "completed",
        itemId: "single-item",
        text: "Only retained item",
        threadId: a.old.workId,
        turnId: a.old.workId,
      },
      [],
    );
  });
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const singleItem = page.locator(
    `[data-record-id="${a.old.workId}:single-item"]`,
  );
  await singleItem.waitFor({ state: "attached" });
  assert.equal(await singleItem.count(), 1);
  await oldRecord.waitFor();
  assert.equal(await omissionRecords.count(), 272);
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Retained exact old draft",
  );
  assert.ok(
    Math.abs(
      (await oldRecord.evaluate((el) => el.getBoundingClientRect().top)) - y,
    ) < 4,
  );
  assert.ok(
    await oldRecord
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
  );
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  await oldRecord.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-independent-omission-pages", {
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  assert.equal(await omissionRecords.count(), 272);
  assert.equal(
    new Set(
      await omissionRecords.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-record-id")),
      ),
    ).size,
    272,
  );
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await oldRecord.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-independent-omission-pages", {
    fullPage: false,
  });
});
