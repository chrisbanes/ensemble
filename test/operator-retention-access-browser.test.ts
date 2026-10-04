import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedRetainedReviewWindow } from "./fixtures/task-review.js";
import { ConversationHistoryStore } from "../src/standalone/conversation-history.js";
const test = browserSuite("ui04-retention-access");
async function retainedJourney(j: BrowserJourney, counterpart: boolean) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const journeyStarted = performance.now();
  let currentStage = "fixture-ready";
  let lastReading: unknown = null;
  const stage = (name: string) => {
    currentStage = name;
    try {
      if (j.diagnostics.length < 40)
        j.diagnostics.push(
          JSON.stringify({
            stage: name,
            elapsedMs: Math.round(performance.now() - journeyStarted),
          }),
        );
    } catch {
      /* Diagnostics must not replace the primary action failure. */
    }
  };
  const deadlineDiagnostic = setTimeout(() => {
    try {
      if (j.diagnostics.length < 40)
        j.diagnostics.push(
          JSON.stringify({
            stage: "execution-deadline-approaching",
            currentStage,
            elapsedMs: Math.round(performance.now() - journeyStarted),
            lastKnownReading: lastReading,
          }),
        );
    } catch {
      /* Cached diagnostics require no live browser call at the deadline. */
    }
  }, 44000);
  deadlineDiagnostic.unref();
  j.cleanup(async () => {
    clearTimeout(deadlineDiagnostic);
  }, "diagnostic-timer.clear");
  stage("fixture-ready");
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
  const readingRequests: { event: string; stream: string; status?: number }[] =
    [];
  const trace = (entry: { event: string; stream: string; status?: number }) => {
    if (readingRequests.length === 32) readingRequests.shift();
    readingRequests.push(entry);
  };
  const readingStream = (url: string) => {
    const u = new URL(url);
    return u.pathname === `/api/operator/tasks/${a.taskId}`
      ? "task"
      : u.pathname === `/api/operator/assignments/${a.assignmentId}/history`
        ? `history:item=${u.searchParams.get("beforeSequence") ?? "recent"}:omission=${u.searchParams.get("beforeOmissionSequence") ?? "recent"}`
        : null;
  };
  page.on("request", (request) => {
    const stream = readingStream(request.url());
    if (stream) trace({ event: "request", stream });
  });
  page.on("response", (response) => {
    const stream = readingStream(response.url());
    if (stream) trace({ event: "response", stream, status: response.status() });
  });
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
  if (!counterpart) {
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
      await preview.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
      1,
    );
    await page
      .locator("#review")
      .getByText(/Ancient criterion · supported/)
      .scrollIntoViewIfNeeded();
    await captureBrowserEvidence(page, "1366-exact-old-review", {
      fullPage: false,
    });
  }
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
  if (counterpart) {
    await page
      .getByRole("button", { name: "Chronological view", exact: true })
      .click();
    assert.equal(await omissionRecords.count(), 271);
    assert.equal(
      await page
        .locator(`[data-record-id="${a.old.workId}:single-item"]`)
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Chronological view", exact: true })
      .click();
  }
  await oldRecord.scrollIntoViewIfNeeded();
  await oldRecord.locator("summary").focus();
  const y = await oldRecord.evaluate((el) => el.getBoundingClientRect().top);
  const inspectReading = ({
    itemId,
    oldId,
    expectedY,
  }: {
    itemId: string;
    oldId: string;
    expectedY: number;
  }) => {
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
    return {
      ...snapshot,
      expectedY,
      delta: top === undefined ? null : top - expectedY,
      activeId: document.activeElement?.id ?? null,
      activeRecord:
        document.activeElement
          ?.closest("[data-record-id]")
          ?.getAttribute("data-record-id") ?? null,
      reading: history.state?.taskWorkspaceReading ?? null,
    };
  };
  const readingArgs = {
    itemId: `${a.old.workId}:single-item`,
    oldId: `turn-omission:${a.old.workId}:${a.old.workId}:${a.old.workId}`,
    expectedY: y,
  };
  const readingDiagnostic = async (phase: string, expectedY = y) => {
    lastReading = await page.evaluate(inspectReading, {
      ...readingArgs,
      expectedY,
    });
    j.diagnostics.push(
      JSON.stringify({
        phase,
        snapshot: lastReading,
        requests: [...readingRequests],
      }),
    );
  };
  const waitReading = async (phase: string) => {
    try {
      await page.waitForFunction(({ itemId, oldId, expectedY }) => {
        const items = document.querySelectorAll(`[data-record-id="${itemId}"]`);
        const omissions = [
          ...document.querySelectorAll('[data-record-id^="turn-omission:"]'),
        ];
        const old = document.querySelector(`[data-record-id="${oldId}"]`);
        const draft = (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value;
        const top = old?.getBoundingClientRect().top;
        return (
          items.length === 1 &&
          omissions.length === 272 &&
          new Set(omissions.map((el) => el.getAttribute("data-record-id")))
            .size === 272 &&
          draft === "Retained exact old draft" &&
          top !== undefined &&
          Math.abs(top - expectedY) < 4 &&
          old?.querySelector("summary") === document.activeElement
        );
      }, readingArgs);
    } catch (error) {
      await readingDiagnostic(`${phase}-failed`);
      throw error;
    }
    await readingDiagnostic(phase);
    return page.evaluate(inspectReading, readingArgs);
  };
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
  await readingDiagnostic("before-header");
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const singleItem = page.locator(
    `[data-record-id="${a.old.workId}:single-item"]`,
  );
  await singleItem.waitFor({ state: "attached" });
  await readingDiagnostic("header-attached");
  let snapshot = await waitReading("header-settled");
  if (!counterpart) {
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
    let releaseHistory!: () => void;
    const heldHistory = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const historyEntered = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/operator/assignments/${a.assignmentId}/history`,
    );
    await page.route(
      `**/api/operator/assignments/${a.assignmentId}/history**`,
      async (route) => {
        await heldHistory;
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
      await readingDiagnostic("timer-pending");
    } finally {
      releaseTask();
    }
    {
      try {
        await historyEntered;
        await readingDiagnostic("overlap-history-pending");
        await page.clock.fastForward(15000);
      } finally {
        releaseHistory();
      }
    }
    snapshot = await waitReading("timer-settled");
    stage("timer-settled");
    assert.equal(snapshot.items, 1);
    assert.equal(snapshot.omissions, 272);
    assert.equal(snapshot.uniqueOmissions, 272);
    assert.equal(snapshot.draft, "Retained exact old draft");
    assert.ok(snapshot.top !== undefined && Math.abs(snapshot.top - y) < 4);
    assert.equal(snapshot.focused, true);
    stage("reading-probe-complete");
    return;
  }
  assert.ok(snapshot);
  stage("validation-label-begin");
  await page
    .getByText(
      `Stale validation; checked head ${headA}, current bound head ${headB}`,
      { exact: false },
    )
    .waitFor();
  stage("validation-label-complete");
  assert.equal(snapshot.items, 1);
  assert.equal(snapshot.omissions, 272);
  assert.equal(snapshot.uniqueOmissions, 272);
  assert.equal(snapshot.draft, "Retained exact old draft");
  assert.ok(snapshot.top !== undefined && Math.abs(snapshot.top - y) < 4);
  assert.equal(snapshot.focused, true);
  stage("validation-scroll-begin");
  await page
    .locator("#review")
    .getByText("Historical check:", { exact: false })
    .scrollIntoViewIfNeeded();
  stage("validation-scroll-complete");
  stage("validation-capture-begin");
  await captureBrowserEvidence(page, "1366-validation-head-state", {
    fullPage: false,
  });
  stage("validation-capture-complete");
  stage("history-expand-begin");
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  stage("history-expand-complete");
  stage("history-scroll-begin");
  await oldRecord.scrollIntoViewIfNeeded();
  stage("history-scroll-complete");
  stage("history-capture-begin");
  await captureBrowserEvidence(page, "1366-independent-omission-pages", {
    fullPage: false,
  });
  stage("history-capture-complete");
  stage("chronological-begin");
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
  stage("chronological-complete");
  await page.setViewportSize({ width: 390, height: 844 });
  stage("phone-scroll-begin");
  await oldRecord.scrollIntoViewIfNeeded();
  stage("phone-scroll-complete");
  stage("phone-capture-begin");
  await captureBrowserEvidence(page, "390-independent-omission-pages", {
    fullPage: false,
  });
  stage("phone-capture-complete");
  const phoneReadingY = await oldRecord.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  let releaseHeadHistory!: () => void, headHistoryEntered!: () => void;
  const headHistory = new Promise<void>((resolve) => {
    releaseHeadHistory = resolve;
  });
  const headHistoryArrival = new Promise<void>((resolve) => {
    headHistoryEntered = resolve;
  });
  await page.route(
    `**/api/operator/assignments/${a.assignmentId}/history**`,
    async (route) => {
      headHistoryEntered();
      await headHistory;
      await route.continue();
    },
    { times: 1 },
  );
  stage("bound-head-read-begin");
  f.service.delivery().recordPrReadFailure(a.taskId);
  try {
    await page
      .getByRole("button", { name: "Refresh task", exact: true })
      .evaluate((el) => (el as HTMLButtonElement).click());
    await headHistoryArrival;
    await page
      .locator("#review")
      .getByText(
        /Historical check:.*Head comparison unknown; current bound head unavailable/,
      )
      .waitFor();
    const gap = await page.evaluate(
      ({ itemId }) => ({
        items: document.querySelectorAll(`[data-record-id="${itemId}"]`).length,
        omissions: document.querySelectorAll(
          '[data-record-id^="turn-omission:"]',
        ).length,
        draft: (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value,
      }),
      readingArgs,
    );
    assert.equal(gap.items, 0);
    assert.equal(gap.omissions, 0);
    assert.equal(gap.draft, "Retained exact old draft");
    j.diagnostics.push(
      JSON.stringify({
        phase: "bound-head-label-ready-history-held",
        snapshot: gap,
        requests: [...readingRequests],
      }),
    );
  } finally {
    releaseHeadHistory();
  }
  try {
    await page.waitForFunction(
      ({ itemId, oldId, expectedY }) => {
        const items = document.querySelectorAll(`[data-record-id="${itemId}"]`),
          omissions = [
            ...document.querySelectorAll('[data-record-id^="turn-omission:"]'),
          ],
          old = document.querySelector(`[data-record-id="${oldId}"]`),
          summary = old?.querySelector("summary");
        return (
          items.length === 1 &&
          omissions.length === 272 &&
          new Set(omissions.map((el) => el.getAttribute("data-record-id")))
            .size === 272 &&
          (
            document.querySelector(
              "#workspace-reply",
            ) as HTMLTextAreaElement | null
          )?.value === "Retained exact old draft" &&
          summary?.isConnected &&
          Math.abs(old!.getBoundingClientRect().top - expectedY) < 4
        );
      },
      { ...readingArgs, expectedY: phoneReadingY },
    );
  } catch (error) {
    await readingDiagnostic(
      "bound-head-history-settlement-failed",
      phoneReadingY,
    );
    throw error;
  }
  await readingDiagnostic("bound-head-history-settled", phoneReadingY);
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
  stage("bound-head-read-complete");
  stage("intentional-scroll-begin");
  const oldSummary = oldRecord.locator("summary");
  await oldSummary.scrollIntoViewIfNeeded();
  await oldSummary.focus();
  assert.equal(
    await oldSummary.evaluate((el) => el === document.activeElement),
    true,
  );
  stage("intentional-scroll-complete");
  let releaseIntentionalHistory!: () => void;
  const intentionalHistory = new Promise<void>((resolve) => {
    releaseIntentionalHistory = resolve;
  });
  const intentionalEntered = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname ===
      `/api/operator/assignments/${a.assignmentId}/history`,
  );
  await page.route(
    `**/api/operator/assignments/${a.assignmentId}/history**`,
    async (route) => {
      await intentionalHistory;
      await route.continue();
    },
    { times: 1 },
  );
  stage("intentional-timer-begin");
  try {
    await page.clock.fastForward(15000);
    await intentionalEntered;
    await singleItem.waitFor({ state: "detached" });
    await page.getByLabel("Editable reply").focus();
    await readingDiagnostic("intentional-control-focus-pending");
    await page.clock.fastForward(15000);
  } finally {
    releaseIntentionalHistory();
  }
  try {
    await page.waitForFunction(
      ({ itemId }) =>
        document.activeElement?.id === "workspace-reply" &&
        document.querySelectorAll(`[data-record-id="${itemId}"]`).length ===
          1 &&
        document.querySelectorAll('[data-record-id^="turn-omission:"]')
          .length === 272 &&
        (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value === "Retained exact old draft",
      readingArgs,
    );
  } catch (error) {
    await readingDiagnostic("intentional-control-focus-failed");
    throw error;
  }
  await readingDiagnostic("intentional-control-focus-settled");
  stage("journey-complete");
}

test("historical Search opens exact old evidence and independently pages all retained omission turns with refresh and reading state", async (_t, j) =>
  retainedJourney(j, false));
test("retained omission chronology phone head observations and intentional focus remain exact after refresh", async (_t, j) =>
  retainedJourney(j, true));
