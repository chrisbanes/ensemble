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
  const headA = "a".repeat(40),
    headB = "b".repeat(40);
  const observation = {
    repositoryId: "R1",
    nodeId: "P_OLD",
    number: 1,
    baseRef: "main",
    headRef: "cb/review",
    headSha: headA,
    baseSha: "c".repeat(40),
    state: "OPEN" as const,
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash" as const],
  };
  f.service.delivery().registerPrWithinTransaction(
    {
      projectId: a.projectId,
      taskId: a.taskId,
      taskVersion: Number(f.service.domain().task(a.taskId).version),
      assignmentId: a.assignmentId,
      assignmentVersion: Number(
        f.service.domain().assignment(a.assignmentId).version,
      ),
      workId: a.old.workId,
      workRevision: 1,
      conversationRevision: 1,
    },
    observation,
    a.assignmentId,
  );
  // Simulate retained pre-fix metadata; parsing remains compatible, links do not.
  f.seedPersistedState((db) => {
    const row = db
      .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
      .get(a.old.resultId) as { recordJson: string };
    const record = JSON.parse(row.recordJson);
    record.metadata.changes = {
      files: [],
      commits: [],
      findings: [],
      reference: "data:text/html,unsafe",
    };
    record.metadata.validations = [
      {
        label: "Historical check",
        scope: "Recorded fixture",
        provenance: "Reported only",
        outcome: "failed",
        checkedHead: headA,
      },
    ];
    db.prepare(
      "UPDATE task_review_results SET recordJson=? WHERE resultId=?",
    ).run(JSON.stringify(record), a.old.resultId);
  });
  const workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "ancient.png"), png);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  await page.clock.install();
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
  await page
    .getByText(`Recorded against the current bound head ${headA}`, {
      exact: false,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Recorded change reference", exact: true })
      .count(),
    0,
  );
  await page
    .getByText("No available recorded change reference.", { exact: true })
    .waitFor();
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
  f.service
    .delivery()
    .observePrWithinTransaction(a.taskId, { ...observation, headSha: headB });
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const singleItem = page.locator(
    `[data-record-id="${a.old.workId}:single-item"]`,
  );
  await singleItem.waitFor({ state: "attached" });
  // Drive the real production timer through its pending visibility boundary.
  let releaseTask!: () => void;
  const heldTask = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const taskEntered = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === `/api/operator/tasks/${a.taskId}`,
  );
  await page.route(
    `**/api/operator/tasks/${a.taskId}?*`,
    async (route) => {
      await heldTask;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.clock.fastForward(15000);
    await taskEntered;
    await singleItem.waitFor({ state: "detached" });
    assert.equal(
      await singleItem.count(),
      0,
      "pending refresh hides unvalidated history",
    );
  } finally {
    releaseTask();
  }
  const settled = await page.waitForFunction(
    ({ itemId, oldId, expectedY }) => {
      const items = document.querySelectorAll(`[data-record-id="${itemId}"]`);
      const omissions = [
        ...document.querySelectorAll('[data-record-id^="turn-omission:"]'),
      ];
      const old = document.querySelector(`[data-record-id="${oldId}"]`);
      const draft = (
        document.querySelector("#workspace-reply") as HTMLTextAreaElement | null
      )?.value;
      const top = old?.getBoundingClientRect().top;
      const focused = old?.querySelector("summary") === document.activeElement;
      const snapshot = {
        items: items.length,
        omissions: omissions.length,
        uniqueOmissions: new Set(
          omissions.map((el) => el.getAttribute("data-record-id")),
        ).size,
        draft,
        top,
        focused,
      };
      return items.length === 1 &&
        omissions.length === 272 &&
        snapshot.uniqueOmissions === 272 &&
        draft === "Retained exact old draft" &&
        top !== undefined &&
        Math.abs(top - expectedY) < 4 &&
        focused
        ? snapshot
        : false;
    },
    {
      itemId: `${a.old.workId}:single-item`,
      oldId: `turn-omission:${a.old.workId}:${a.old.workId}:${a.old.workId}`,
      expectedY: y,
    },
  );
  const snapshot = await settled.jsonValue();
  assert.ok(snapshot);
  await page
    .getByText(
      `Stale validation; checked head ${headA}, current bound head ${headB}`,
      { exact: false },
    )
    .waitFor();
  assert.equal(snapshot.items, 1);
  assert.equal(snapshot.omissions, 272);
  assert.equal(snapshot.uniqueOmissions, 272);
  assert.equal(snapshot.draft, "Retained exact old draft");
  assert.ok(snapshot.top !== undefined && Math.abs(snapshot.top - y) < 4);
  assert.equal(snapshot.focused, true);
  await page
    .locator("#review")
    .getByText("Historical check:", { exact: false })
    .scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-validation-head-state", {
    fullPage: false,
  });
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
  f.service.delivery().recordPrReadFailure(a.taskId);
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  await page
    .locator("#review")
    .getByText(
      /Historical check:.*Head comparison unknown; current bound head unavailable/,
    )
    .waitFor();
  assert.equal(
    await page
      .locator("#review")
      .getByText(/Stale validation;/)
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Retained exact old draft",
  );
});
