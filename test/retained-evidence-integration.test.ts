import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RetainedEvidenceStore } from "../src/core/retained-evidence.js";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../src/standalone/operations.js";
import { SqliteWorkspaceComparisonStore } from "../src/standalone/comparison-store.js";
import type {
  WorkspaceTurnCaptureRecord,
  WorkspaceTurnComparisonSnapshot,
} from "../src/standalone/workspace-comparison.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iY9sAAAAASUVORK5CYII=",
  "base64",
);

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for fixture state");
}

async function login(web: { origin: string; password: string }) {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anon = (await anonymous.json()) as { csrfToken: string };
  const response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: anonymous.headers.get("set-cookie")!.split(";")[0]!,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

function replaceLatestCapture(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  prior: WorkspaceTurnCaptureRecord,
) {
  const comparisonId = randomUUID();
  const identity = {
    ...prior.identity,
    workId: `${prior.identity.workId}-replacement`,
    workRevision: prior.identity.workRevision + 1,
    requestSequence: prior.identity.requestSequence + 1,
  };
  const threadId = `${prior.threadId}-replacement`;
  const turnId = `${prior.turnId}-replacement`;
  const now = Date.now();
  const comparison: WorkspaceTurnComparisonSnapshot = {
    comparisonId,
    taskId: identity.taskId,
    target: "turn",
    state: "available",
    outcome: "completed",
    startedAt: now,
    observedAt: now + 1,
    taskVersion: identity.taskVersion,
    workId: identity.workId,
    workRevision: identity.workRevision,
    requestSequence: identity.requestSequence,
    assignmentId: identity.assignmentId,
    assignmentVersion: identity.assignmentVersion,
    instructionsRevision: identity.instructionsRevision,
    profileRevision: identity.profileRevision,
    profileId: identity.profileId,
    threadId,
    turnId,
    entries: [],
    truncated: false,
  };
  const pending: WorkspaceTurnCaptureRecord = {
    comparisonId,
    identity,
    captureState: "pending",
    outcome: "running",
    startedAt: now,
    observedAt: now,
    threadId,
    turnId,
    before: {
      observedAt: now,
      state: "available",
      files: [],
      truncated: false,
    },
  };
  f.seedPersistedState((db) => {
    const store = new SqliteWorkspaceComparisonStore(db);
    store.beginTurnCapture(pending);
    const updated = {
      ...pending,
      captureState: "unsettled" as const,
      outcome: "completed" as const,
      comparison,
      sides: [],
    };
    assert.equal(store.updatePendingTurnCapture(updated), true);
    const { before: _before, ...finished } = updated;
    assert.equal(
      store.finishTurnCapture({
        ...finished,
        captureState: "finished",
        outcome: "completed",
      }),
      true,
    );
  });
  return comparisonId;
}

test("retained evidence and submitted comparison context survive replacement, cleanup, restart and SQLite backup", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const seeded = await seedReviewTask(
    f,
    "Integrated evidence retention",
    "Preserve the exact callback evidence and review context",
  );
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");

  const beforeBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("before first\r\nbefore second", "utf8"),
  ]);
  const callbackBytes = Buffer.from(
    "callback first\r\ncallback second\r\n",
    "utf8",
  );
  const textPath = join(workspace.path, "retained-proof.txt");
  const artifactPath = join(workspace.path, "retained-proof.png");
  await writeFile(textPath, beforeBytes);
  await writeFile(artifactPath, png);

  const domain = f.service.domain();
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
  await waitFor(() => f.runtime.turns > 0);
  await waitFor(() =>
    f.service.list().some((work) => work.state === "running"),
  );
  const work = f.service.list().find((item) => item.state === "running");
  assert.ok(work?.threadId && work.turnId);

  await writeFile(textPath, callbackBytes);
  const artifactId = randomUUID();
  const callback = {
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
            artifactId,
            label: "Original screenshot",
            role: "evidence" as const,
            revision: 1,
            availability: "available" as const,
            file: {
              relativePath: "retained-proof.png",
              sha256: digest(png),
              mime: "image/png" as const,
              size: png.byteLength,
            },
          },
        ],
      },
    },
  };
  const callbackResult = await f.runtime.callTool(callback);
  assert.equal(callbackResult.success, true, callbackResult.text);
  const result = f.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((item) => item.workId === work.workId);
  assert.ok(result);
  const retained = f.service.retainedEvidence();
  const originalManifest = retained.result(seeded.taskId, result.resultId);
  assert.ok(originalManifest);
  assert.equal(originalManifest.sourceObservation.captureState, "pending");
  const sourceComparisonId = originalManifest.sourceObservation.comparisonId;
  assert.ok(sourceComparisonId);
  const diffGap = originalManifest.items.find((item) => item.kind === "diff");
  assert.equal(diffGap?.state, "gap");
  assert.equal(diffGap?.reason, "comparison-unsettled");
  const textItem = originalManifest.items.find(
    (item) => item.kind === "file" && item.path === "retained-proof.txt",
  );
  assert.ok(textItem?.state === "available");
  assert.deepEqual(
    retained.item(seeded.taskId, result.resultId, textItem.itemId)?.bytes,
    callbackBytes,
  );

  f.runtime.complete(f.runtime.turns);
  await waitFor(
    () => !f.service.list().some((item) => item.state === "running"),
  );
  const latest = f.service.workspaceTurnCaptureSlots(
    seeded.taskId,
  ).latestFinished;
  assert.ok(latest?.comparison);
  if (!latest?.comparison) throw new Error("Finished comparison missing");
  if (!latest.threadId || !latest.turnId)
    throw new Error("Finished comparison runtime identity missing");
  assert.equal(latest.comparisonId, sourceComparisonId);
  assert.equal(latest.comparison.state, "available");
  assert.equal(latest.comparison.outcome, "completed");
  const exported = f.service.workspaceComparisonExport(
    seeded.taskId,
    sourceComparisonId,
  );
  assert.equal(exported?.captureState, "finished");
  assert.equal(exported?.comparison.observedAt, latest.comparison.observedAt);
  const changed = exported?.comparison.entries.find(
    (entry) => entry.path === "retained-proof.txt",
  );
  assert.ok(changed);
  assert.equal(changed.change, "modified");
  assert.equal(changed.left?.sha256, digest(beforeBytes));
  assert.equal(changed.right?.sha256, digest(callbackBytes));
  const changedIndex = exported!.comparison.entries.indexOf(changed);
  const side = exported?.sides.find(
    (entry) => entry.entryIndex === changedIndex,
  );
  assert.ok(side?.leftText && side.rightText);

  const leftSelection = {
    taskId: seeded.taskId,
    repositoryId: null,
    path: "retained-proof.txt",
    sourceKind: "comparison-side" as const,
    context: "turn" as const,
    comparisonId: sourceComparisonId,
    resultId: result.resultId,
    workId: result.workId,
    threadId: work.threadId,
    turnId: work.turnId,
    side: "left" as const,
    startLine: 1,
    endLine: 2,
    contentSha256: digest(beforeBytes),
  };
  const alternateComparisonId = randomUUID();
  const alternateComparison = {
    ...latest.comparison,
    comparisonId: alternateComparisonId,
    observedAt: latest.comparison.observedAt + 1,
    entries: latest.comparison.entries.map((entry) => ({
      ...entry,
      hunks: entry.hunks.map((hunk) => ({
        ...hunk,
        ...(hunk.leftAnchor
          ? {
              leftAnchor: {
                ...hunk.leftAnchor,
                comparisonId: alternateComparisonId,
              },
            }
          : {}),
        ...(hunk.rightAnchor
          ? {
              rightAnchor: {
                ...hunk.rightAnchor,
                comparisonId: alternateComparisonId,
              },
            }
          : {}),
      })),
    })),
  };
  const alternateCapture: WorkspaceTurnCaptureRecord = {
    comparisonId: alternateComparisonId,
    identity: latest.identity,
    captureState: "finished",
    outcome: "completed",
    startedAt: latest.startedAt,
    observedAt: alternateComparison.observedAt,
    threadId: latest.threadId,
    turnId: latest.turnId,
    comparison: alternateComparison,
    sides: exported!.sides,
  };
  f.seedPersistedState((db) => {
    db.prepare(`INSERT INTO workspace_turn_captures
      (comparisonId, taskId, captureState, payloadJson)
      VALUES (?, ?, 'finished', ?)`).run(
      alternateComparisonId,
      seeded.taskId,
      JSON.stringify(alternateCapture),
    );
  });
  assert.equal(
    f.service.workspaceComparisonExport(seeded.taskId, alternateComparisonId)
      ?.captureState,
    "finished",
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: seeded.taskId,
      operationId: randomUUID(),
      anchors: [{ ...leftSelection, turnId: "different-turn" }],
    }),
    /turn identity mismatch/,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: seeded.taskId,
      operationId: randomUUID(),
      anchors: [{ ...leftSelection, comparisonId: alternateComparisonId }],
    }),
    /result binding mismatch/,
  );

  const taskBeforeAnchor = f.service.domain().task(seeded.taskId);
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(taskBeforeAnchor.version),
    title: "Metadata changed after immutable result capture",
  });
  const manifestBeforeAnchor = retained.result(seeded.taskId, result.resultId);
  assert.deepEqual(manifestBeforeAnchor, originalManifest);
  const laterBytes = Buffer.from("newer live file content\n");
  await writeFile(textPath, laterBytes);
  const resultItem = originalManifest.items.find(
    (item) => item.kind === "file" && item.path === "retained-proof.txt",
  );
  assert.ok(resultItem?.state === "available");

  const staged = await f.service.stageReviewAnchorDraft({
    taskId: seeded.taskId,
    operationId: randomUUID(),
    anchors: [
      {
        ...leftSelection,
      },
      {
        taskId: seeded.taskId,
        repositoryId: null,
        path: "retained-proof.txt",
        sourceKind: "comparison-side",
        context: "turn",
        comparisonId: sourceComparisonId,
        resultId: result.resultId,
        workId: result.workId,
        threadId: work.threadId,
        turnId: work.turnId,
        side: "right",
        startLine: 1,
        endLine: 2,
        contentSha256: digest(callbackBytes),
      },
      {
        taskId: seeded.taskId,
        repositoryId: null,
        path: "retained-proof.txt",
        sourceKind: "result-evidence",
        context: "result",
        resultId: result.resultId,
        resultItemId: resultItem.itemId,
        workId: result.workId,
        side: "file",
        startLine: 1,
        endLine: 2,
        contentSha256: digest(callbackBytes),
      },
    ],
  });
  assert.equal(staged.anchorIds.length, 3);
  const leftAnchor = retained.reviewAnchor(seeded.taskId, staged.anchorIds[0]!);
  const rightAnchor = retained.reviewAnchor(
    seeded.taskId,
    staged.anchorIds[1]!,
  );
  const resultAnchor = retained.reviewAnchor(
    seeded.taskId,
    staged.anchorIds[2]!,
  );
  assert.ok(leftAnchor?.bytes && rightAnchor?.bytes && resultAnchor?.bytes);
  assert.deepEqual(leftAnchor.bytes, beforeBytes);
  assert.deepEqual(rightAnchor.bytes, callbackBytes);
  assert.deepEqual(resultAnchor.bytes, callbackBytes);
  assert.equal(leftAnchor.anchor.sourceKind, "comparison-side");
  assert.equal(leftAnchor.anchor.resultId, result.resultId);
  assert.equal(leftAnchor.anchor.observedAt, exported!.comparison.observedAt);
  assert.equal(rightAnchor.anchor.observedAt, exported!.comparison.observedAt);
  assert.equal(resultAnchor.anchor.sourceKind, "result-evidence");
  assert.equal(resultAnchor.anchor.resultId, result.resultId);
  assert.equal(resultAnchor.anchor.resultItemId, resultItem.itemId);
  assert.equal(resultAnchor.anchor.observedAt, textItem.observedAt);
  assert.deepEqual(
    retained.result(seeded.taskId, result.resultId),
    originalManifest,
    "later metadata and anchors do not rewrite the original result manifest",
  );
  assert.equal(
    retained
      .result(seeded.taskId, result.resultId)
      ?.items.find((item) => item.kind === "diff")?.state,
    "gap",
    "completed comparison context does not backfill the result's callback-time gap",
  );

  const seal = {
    taskId: seeded.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
    anchorIds: staged.anchorIds,
  };
  f.seedPersistedState((db) => {
    db.exec(`CREATE TRIGGER interrupt_integrated_anchor_seal
      BEFORE INSERT ON retained_review_anchor_submitted_refs
      BEGIN SELECT RAISE(ABORT, 'integrated-anchor-seal-interrupted'); END`);
  });
  assert.throws(
    () => f.service.sealReviewAnchorDraft(seal),
    /integrated-anchor-seal-interrupted/,
  );
  f.seedPersistedState((db) => {
    const submitted = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM retained_review_anchor_submitted_refs",
          )
          .get() as { count: number }
      ).count,
    );
    assert.equal(submitted, 0);
    db.exec("DROP TRIGGER interrupt_integrated_anchor_seal");
  });

  await f.reopen();
  const sealed = f.service.sealReviewAnchorDraft(seal);
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.linkState, "durable");
  assert.equal(sealed.deliveryState, "not-attempted");
  assert.equal(sealed.receiptState, "none");
  const discarded = f.service.discardReviewAnchorDraft({
    taskId: seeded.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
  });
  assert.equal(discarded.submittedContextPreserved, true);
  const reopenedEvidence = f.service.retainedEvidence();
  assert.equal(
    reopenedEvidence.reviewAnchorDraft(seeded.taskId, staged.draftId)?.state,
    "discarded",
  );
  assert.deepEqual(
    reopenedEvidence.reviewAnchorSubmittedContext(
      seeded.taskId,
      sealed.submittedContextId,
    )?.anchorIds,
    staged.anchorIds,
  );

  await writeFile(
    textPath,
    "later file contents must not replace original context\n",
  );
  await rename(textPath, join(workspace.path, "renamed-after-review.txt"));
  await rm(artifactPath);
  const replacementComparisonId = replaceLatestCapture(f, latest);
  assert.notEqual(replacementComparisonId, sourceComparisonId);
  assert.equal(
    f.service.workspaceComparisonExport(seeded.taskId, sourceComparisonId),
    undefined,
  );
  const archived = await f.service.archiveTask(seeded.taskId, {
    deliveryConfirmed: true,
    writerOwnershipResolved: true,
    handoffsPreserved: true,
    reconciliationEvidencePreserved: true,
    workspaceContentsPreserved: true,
  });
  assert.equal(archived.outcome, "cleaned");
  await f.reopen();

  const web = await f.startWeb();
  t.after(() => web.close());
  const cookie = await login(web);
  const api =
    web.origin +
    "/api/operator/tasks/" +
    seeded.taskId +
    "/results/" +
    result.resultId +
    "/evidence";
  const beforeRead = {
    work: f.service
      .list()
      .map((item) => [item.workId, item.state, item.turnId]),
    hold: f.service.taskHold(seeded.taskId) ?? null,
    resultIds: f.service
      .coordinationView()
      .readTask(seeded.taskId)
      .results.map((item) => item.resultId),
    latestComparisonId: f.service.workspaceTurnCaptureSlots(seeded.taskId)
      .latestFinished?.comparisonId,
  };
  const manifestResponse = await fetch(api, { headers: { cookie } });
  assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()) as {
    data: {
      sourceObservation: { comparisonId: string; captureState: string };
      items: Array<{
        itemId: string;
        kind: string;
        state: string;
        reason?: string;
      }>;
    };
  };
  assert.equal(
    manifest.data.sourceObservation.comparisonId,
    sourceComparisonId,
  );
  assert.equal(manifest.data.sourceObservation.captureState, "pending");
  assert.ok(
    manifest.data.items.some(
      (item) =>
        item.kind === "diff" &&
        item.state === "gap" &&
        item.reason === "comparison-unsettled",
    ),
  );
  const textResponse = await fetch(`${api}/${textItem.itemId}`, {
    headers: { cookie },
  });
  assert.equal(textResponse.status, 200);
  const textBody = (await textResponse.json()) as {
    data: { preview: { kind: "text"; text: string } };
  };
  assert.deepEqual(
    Buffer.from(textBody.data.preview.text, "utf8"),
    callbackBytes,
  );
  const artifactResponse = await fetch(
    web.origin +
      "/api/operator/tasks/" +
      seeded.taskId +
      "/artifacts/" +
      artifactId,
    { headers: { cookie } },
  );
  assert.equal(artifactResponse.status, 200);
  assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), png);
  for (const [anchorId, expected] of [
    [staged.anchorIds[0]!, beforeBytes],
    [staged.anchorIds[1]!, callbackBytes],
  ] as const) {
    const anchorResponse = await fetch(
      web.origin +
        "/api/operator/tasks/" +
        seeded.taskId +
        "/review-anchors/" +
        anchorId,
      { headers: { cookie } },
    );
    assert.equal(anchorResponse.status, 200);
    const anchorBody = (await anchorResponse.json()) as {
      data: {
        state: string;
        status: string;
        anchor: Record<string, unknown>;
        preview: { kind: "text"; text: string };
      };
    };
    assert.equal(anchorBody.data.state, "available");
    assert.equal(anchorBody.data.status, "unknown");
    assert.deepEqual(
      Buffer.from(anchorBody.data.preview.text, "utf8"),
      expected,
    );
    assert.equal(anchorBody.data.anchor.sourceKind, "comparison-side");
    assert.equal(anchorBody.data.anchor.resultId, result.resultId);
    assert.equal(anchorBody.data.anchor.comparisonId, sourceComparisonId);
    assert.equal("originRoot" in anchorBody.data.anchor, false);
    assert.equal(JSON.stringify(anchorBody).includes(workspace.path), false);
  }
  const afterRead = {
    work: f.service
      .list()
      .map((item) => [item.workId, item.state, item.turnId]),
    hold: f.service.taskHold(seeded.taskId) ?? null,
    resultIds: f.service
      .coordinationView()
      .readTask(seeded.taskId)
      .results.map((item) => item.resultId),
    latestComparisonId: f.service.workspaceTurnCaptureSlots(seeded.taskId)
      .latestFinished?.comparisonId,
  };
  assert.deepEqual(
    afterRead,
    beforeRead,
    "GETs do not mutate task or latest-turn state",
  );

  await web.close();
  await f.service.stop();
  const restoredPath = join(f.directory, "retained-restored");
  await mkdir(join(f.directory, "snapshots"), { mode: 0o700 });
  const snapshotDirectory = join(f.directory, "snapshots", "retained");
  const created = await createSnapshot(
    join(f.directory, "data"),
    snapshotDirectory,
  );
  const verified = await verifySnapshot(snapshotDirectory);
  assert.equal(verified.logicalContentSha256, created.logicalContentSha256);
  await restoreSnapshot(snapshotDirectory, restoredPath);
  const restoredDb = new DatabaseSync(join(restoredPath, "standalone.sqlite"));
  try {
    const check = restoredDb.prepare("PRAGMA integrity_check").get() as Record<
      string,
      string
    >;
    assert.equal(Object.values(check)[0], "ok");
    assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
    const restored = new RetainedEvidenceStore(restoredDb);
    const restoredManifest = restored.result(seeded.taskId, result.resultId);
    assert.ok(restoredManifest);
    assert.equal(
      restoredManifest.items.find((item) => item.kind === "diff")?.state,
      "gap",
    );
    assert.deepEqual(
      restored.item(seeded.taskId, result.resultId, textItem.itemId)?.bytes,
      callbackBytes,
    );
    assert.deepEqual(
      restored.reviewAnchor(seeded.taskId, staged.anchorIds[0]!)?.bytes,
      beforeBytes,
    );
    assert.deepEqual(
      restored.reviewAnchor(seeded.taskId, staged.anchorIds[1]!)?.bytes,
      callbackBytes,
    );
    assert.deepEqual(
      restored.reviewAnchor(seeded.taskId, staged.anchorIds[2]!)?.bytes,
      callbackBytes,
    );
    assert.equal(
      restored.reviewAnchorSubmittedContext(
        seeded.taskId,
        sealed.submittedContextId,
      )?.anchorIds.length,
      3,
    );
  } finally {
    restoredDb.close();
  }
});
