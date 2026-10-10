import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { TaskReviewStore } from "../src/core/task-review.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { seedReviewTask } from "./fixtures/task-review.js";
import { leadResumeNotice } from "../web/src/lead-feedback.js";
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
  const beforePng = await readFile(
      join(process.cwd(), "design/assets/command-menu-before.png"),
    ),
    afterPng = await readFile(
      join(process.cwd(), "design/assets/command-menu-after.png"),
    ),
    before = randomUUID(),
    after = randomUUID(),
    missing = randomUUID();
  assert.notEqual(
    createHash("sha256").update(beforePng).digest("hex"),
    createHash("sha256").update(afterPng).digest("hex"),
  );
  await writeFile(join(workspace.path, "before.png"), beforePng);
  await writeFile(join(workspace.path, "after.png"), afterPng);
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
          size: beforePng.length,
          mime: "image/png",
          sha256: createHash("sha256").update(beforePng).digest("hex"),
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
          size: afterPng.length,
          mime: "image/png",
          sha256: createHash("sha256").update(afterPng).digest("hex"),
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
  await page.getByText(/1 new result.*source requirements changed/).waitFor();
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
    bounds.every((h) => h >= 32),
    JSON.stringify(bounds),
  );
  await page.locator("#review").scrollIntoViewIfNeeded();
  await page.getByAltText("before: Before focus").waitFor();
  assert.equal(
    await page
      .getByAltText("before: Before focus")
      .evaluate((el) => el instanceof HTMLImageElement && el.naturalWidth),
    1040,
  );
  await page.getByAltText("after: After focus").waitFor();
  assert.deepEqual(
    await pair
      .locator("img")
      .evaluateAll((images) =>
        images.map((image) =>
          image instanceof HTMLImageElement
            ? [image.naturalWidth, image.naturalHeight]
            : null,
        ),
      ),
    [
      [1040, 480],
      [1040, 480],
    ],
  );
  await captureBrowserEvidence(page, "1366-original-review");
  await pair.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-visible-comparison", {
    fullPage: false,
  });
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
  await pair.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-visible-comparison", {
    fullPage: false,
  });
  const reply = page.getByLabel("Editable reply");
  const criterionAsk = page
    .getByRole("button", { name: "Ask lead about criterion", exact: true })
    .first();
  const artifactAsk = pair
    .locator('[data-artifact-role="before"]')
    .getByRole("button", { name: "Ask lead about artifact", exact: true })
    .first();
  const retainedNotice = page.getByText(
    "Existing lead draft and reference retained. Finish or clear it before starting a new contextual reply.",
    { exact: true },
  );
  await reply.fill("Unfinished ordinary lead message");
  for (const ask of [criterionAsk, artifactAsk]) {
    await ask.click();
    await retainedNotice.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.id === "workspace-reply",
    );
    assert.equal(await reply.inputValue(), "Unfinished ordinary lead message");
    assert.equal(await page.getByText(/^Immutable reference:/).count(), 0);
    assert.equal(
      await reply.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  await reply.fill("");
  await criterionAsk.click();
  const criterionReference = await page
    .getByText(/^Immutable reference:/)
    .textContent();
  assert.ok(criterionReference?.includes(a.source.criteria[0]!.criterionId));
  await reply.fill("Edited contextual criterion A reply");
  // Selecting the same or a different anchor never retargets unfinished text.
  for (const ask of [criterionAsk, artifactAsk]) {
    await ask.click();
    await retainedNotice.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.id === "workspace-reply",
    );
    assert.equal(
      await reply.inputValue(),
      "Edited contextual criterion A reply",
    );
    assert.equal(
      await page.getByText(/^Immutable reference:/).textContent(),
      criterionReference,
    );
    assert.equal(
      await reply.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  await captureBrowserEvidence(page, "390-retained-contextual-draft", {
    fullPage: false,
  });
  await reply.fill("");
  await artifactAsk.click();
  assert.equal(
    await reply.inputValue(),
    "Please review before artifact Before focus.",
  );
  assert.ok(
    (await page.getByText(/^Immutable reference:/).textContent())?.includes(
      before,
    ),
  );

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

for (const [limitCase, sourceBody] of [
  [
    "raw oversized",
    `Prefix requirement ${"x".repeat(17000)}\n- [ ] Tail requirement`,
  ],
  [
    "redaction expanded",
    "Prefix requirement\n" +
      "token=x\n".repeat(1100) +
      "- [ ] Tail requirement",
  ],
] as const) {
  test(`ordinary ${limitCase} GitHub body retains identity but shows unavailable brief and checklist coverage without a prefix`, async (_t, j) => {
    const issue = {
      providerInstance: "github.com" as const,
      nodeId: "I_LARGE",
      repositoryId: "R1",
      repositoryName: "org/repo",
      number: 1,
      title: "Large retained task",
      body: sourceBody,
      state: "open" as const,
      labels: ["ready"],
      projectFields: [],
    };
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(
        null,
        () => ({
          async readSelection() {
            return { complete: true, issues: [issue], reason: null };
          },
          async readBlockers() {
            return { complete: true, blockers: [], reason: null };
          },
          async readIssueStatus() {
            return { status: "open" };
          },
        }),
        undefined,
        j.fixtureOptions,
      ),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const a = await seedReviewTask(f),
      d = f.service.domain();
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 1,
      credentialRef: "env:FIXTURE_SOURCE",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    d.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    await f.service.refreshGitHub();
    const taskId = String(
        f.service.githubSources().issue(issue.nodeId)?.taskId,
      ),
      source = f.service.taskReview().sources(taskId).at(-1);
    assert.ok(source);
    if (limitCase === "redaction expanded")
      assert.ok(issue.body.length < 16000);
    assert.equal(source.body, null);
    assert.equal(source.criteriaOmittedCount, null);
    assert.deepEqual(source.criteria, []);
    assert.ok(!JSON.stringify(source).includes("Prefix requirement"));
    await f.service.provisionTask(taskId);
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: Number(d.project(a.projectId).version),
      paused: false,
    });
    for (
      let n = 0;
      n < 100 && !f.service.list().some((w) => w.state === "running");
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    const w = f.service.list().find((w) => w.state === "running");
    assert.ok(w?.threadId && w.turnId);
    const referencesLine = f.runtime.prompts[0]!.split("\n").find((line) =>
      line.startsWith("Captured review references (JSON): "),
    )!;
    const references = JSON.parse(
      referencesLine.slice("Captured review references (JSON): ".length),
    );
    assert.equal(references.sourceId, source.sourceId);
    assert.equal(references.criteriaOmittedCount, null);
    assert.deepEqual(references.criteria, []);
    assert.equal(
      (
        await f.runtime.callTool({
          threadId: w.threadId,
          turnId: w.turnId,
          callId: randomUUID(),
          tool: "ensemble_report_result",
          arguments: {
            summary: "Reported source coverage gap",
            review: { sourceId: source.sourceId },
          },
        })
      ).success,
      true,
    );
    const api = new OperatorApi(f.service, [f.directory]);
    assert.equal(
      (await api.readTask(taskId)).data.review?.sources[0]?.body,
      null,
    );
    assert.equal(
      (
        await api.readSearch(
          new URLSearchParams({ query: "Large retained task", type: "task" }),
        )
      ).data.matches[0]?.sourceId,
      source.sourceId,
    );
    assert.equal(
      (await api.readSearch(new URLSearchParams({ query: "Tail requirement" })))
        .data.matches.length,
      0,
    );
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    j.observe(page);
    page.setDefaultTimeout(5000);
    await page.goto(`${web.origin}/app/tasks/${taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const brief = page.locator("#brief"),
      gap = /Retained source body and checklist coverage are unavailable/;
    await brief.getByText(gap).waitFor();
    const disclosure = brief.locator("details");
    assert.equal(await disclosure.getAttribute("open"), null);
    assert.equal(
      await brief.getByText(/Prefix requirement|Tail requirement/).count(),
      0,
    );
    await disclosure.locator("summary").click();
    await brief.getByText(gap).waitFor();
    assert.equal(
      await disclosure
        .getByText("Unavailable or redacted", { exact: true })
        .count(),
      1,
    );
    await page
      .getByRole("heading", {
        name: "Supplied criteria — coverage unavailable",
        exact: true,
      })
      .waitFor({ state: "attached" });
    assert.equal(
      await page.getByText(/No literal checklist records/).count(),
      0,
    );
    assert.equal(
      await brief
        .getByRole("link", { name: "Open GitHub to edit source", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await brief
        .getByRole("button", { name: "Ask lead about brief", exact: true })
        .count(),
      1,
    );
    await captureBrowserEvidence(page, "1366-omitted-source-coverage");
    issue.body += " changed tail";
    await f.service.refreshGitHub();
    const next = f.service.taskReview().sources(taskId).at(-1);
    assert.ok(next);
    assert.notEqual(next.sourceId, source.sourceId);
    assert.notEqual(next.digest, source.digest);
    assert.equal(next.body, null);
    assert.deepEqual(next.criteria, []);
    await page
      .getByRole("button", { name: "Refresh task", exact: true })
      .click();
    await brief
      .getByText(`github source revision ${next.revision} · ${next.sourceId}`, {
        exact: true,
      })
      .waitFor();
    await brief.getByText(gap).waitFor();
    assert.equal(
      await brief.getByText(/Prefix requirement|Tail requirement/).count(),
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await captureBrowserEvidence(page, "390-omitted-source-coverage");
  });
}

test("partial literal checklist coverage remains explicit with collapsed and expanded source text", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const body = Array.from(
    { length: 130 },
    (_, i) => `- [ ] Literal requirement ${i + 1}`,
  ).join("\n");
  const a = await seedReviewTask(
    f,
    "Partial checklist",
    "Full retained checklist",
    body,
  );
  const result = a.delegatedResult("Literal subset only", {
    sourceId: a.source.sourceId,
  });
  const read = await new OperatorApi(f.service, [f.directory]).readTask(
    a.taskId,
  );
  assert.ok(read.data.review);
  const source = read.data.review.sources[0]!;
  assert.equal(source.criteria.length, 128);
  assert.equal(source.criteriaOmittedCount, 2);
  assert.equal(source.body, body);
  assert.equal(source.criteria.at(-1)?.position, 127);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?result=${result.resultId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const partial =
    "Checklist coverage is partial: 128 literal checklist records retained; 2 additional records omitted. Consult the full retained brief.";
  await page.locator("#brief").getByText(partial, { exact: true }).waitFor();
  await page
    .locator("#review")
    .getByText(partial, { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(await page.locator("#brief details").getAttribute("open"), null);
  await page.locator("#brief details summary").click();
  await page
    .locator("#brief details pre")
    .getByText(body, { exact: true })
    .waitFor();
  await page
    .locator("#brief")
    .getByText(partial, { exact: true })
    .scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-partial-checklist-coverage", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#brief")
    .getByText(partial, { exact: true })
    .scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-partial-checklist-coverage", {
    fullPage: false,
  });
});

test("bounded captured context warns with exact omitted count while pinning an old result on desktop and phone", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Context coverage");
  const old = a.result("Old exact context", { sourceId: a.source.sourceId });
  for (let i = 0; i < 270; i++)
    f.service
      .taskReview()
      .captureAssignment(
        a.assignmentId,
        `Captured preparation ${i}`,
        `unstarted-${i}`,
      );
  const core = f.service
    .taskReview()
    .read(a.taskId, { resultId: old.resultId });
  assert.equal(core.contexts.length, 256);
  assert.ok(core.contexts.some((c) => c.workId === old.workId));
  assert.equal(core.contextsOmittedCount, 16);
  const read = await new OperatorApi(f.service, [f.directory]).readTask(
    a.taskId,
    { resultId: old.resultId },
  );
  assert.equal(read.data.review?.contextsOmittedCount, 16);
  f.seedPersistedState((db) => {
    const reopened = new TaskReviewStore(db).read(a.taskId, {
      resultId: old.resultId,
    });
    assert.equal(reopened.contextsOmittedCount, 16);
    assert.ok(reopened.contexts.some((c) => c.workId === old.workId));
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?result=${old.resultId}&section=context`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const warning = page.getByText(
    "Partial captured context coverage: 16 retained preparation records are not shown.",
    { exact: true },
  );
  await warning.waitFor();
  await warning.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-context-coverage", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await warning.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-context-coverage", {
    fullPage: false,
  });
});

test("every lead composer shows the same resume line for a completed lead and keeps refused drafts", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Completed lead feedback");
  a.result("Lead finished", {
    sourceId: a.source.sourceId,
    artifacts: [
      {
        artifactId: randomUUID(),
        label: "Lead screenshot",
        role: "evidence",
        revision: 1,
        availability: "unavailable",
      },
    ],
  });
  assert.equal(
    f.service.domain().assignment(a.assignmentId).state,
    "completed",
  );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const expected = leadResumeNotice("Task lead");
  const line = page.getByText(expected, { exact: true });
  const reply = page.getByLabel("Editable reply");
  const sendButton = page.getByRole("button", {
    name: "Send to task lead",
    exact: true,
  });
  // Task composer, then contextual drafts from the result and the artifact.
  await page
    .getByRole("button", { name: "Message task lead", exact: true })
    .click();
  const seen = [await line.first().textContent()];
  for (const name of ["Ask lead about result", "Ask lead about artifact"]) {
    await reply.fill("");
    await page.getByRole("button", { name, exact: true }).first().click();
    await page.getByText(/^Immutable reference:/).waitFor();
    seen.push(await line.first().textContent());
  }
  // The Local review panel renders the same leadResumeNotice (operator-local-review-browser).
  assert.deepEqual(seen, [expected, expected, expected]);
  assert.equal(await sendButton.isEnabled(), true);

  // A held lead refuses definitively and keeps the contextual draft.
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(a.assignmentId),
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/operator/commands") &&
        response.status() === 409,
    ),
    sendButton.click(),
  ]);
  await page.getByText(/conflict: conflict.*Draft retained/).waitFor();
  assert.ok(await reply.isEditable());
  assert.equal(
    await reply.inputValue(),
    "Please review evidence artifact Lead screenshot.",
  );
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='completed' WHERE id=?")
      .run(a.assignmentId),
  );
  // A done task refuses too, with the draft kept.
  f.seedPersistedState((db) =>
    db.prepare("UPDATE domain_tasks SET state='done' WHERE id=?").run(a.taskId),
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/operator/commands") &&
        response.status() === 409,
    ),
    sendButton.click(),
  ]);
  await page.getByText(/conflict: conflict.*Draft retained/).waitFor();
  assert.equal(
    await reply.inputValue(),
    "Please review evidence artifact Lead screenshot.",
  );
  f.seedPersistedState((db) =>
    db.prepare("UPDATE domain_tasks SET state='open' WHERE id=?").run(a.taskId),
  );

  await sendButton.click();
  await page
    .getByText("Receipt recorded. Task lead resumed with this feedback.", {
      exact: true,
    })
    .waitFor();
  const followUp = f.service
    .coordinationView()
    .readTask(a.taskId)
    .messages.find((m) => m.eventType === "assignment-follow-up");
  assert.equal(
    followUp?.text,
    "Please review evidence artifact Lead screenshot.",
  );
  assert.ok(followUp?.reference?.artifactId);
  await page
    .getByText(/assignment-follow-up · requested by operator ·/)
    .first()
    .waitFor();
  assert.equal(f.service.domain().task(a.taskId).state, "open");
  assert.deepEqual(pageErrors, []);
});
