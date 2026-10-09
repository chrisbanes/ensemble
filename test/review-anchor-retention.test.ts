import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { retainedEvidenceLimits } from "../src/core/retained-evidence.js";
import { SqliteWorkspaceComparisonStore } from "../src/standalone/comparison-store.js";
import type {
  WorkspaceComparisonContent,
  WorkspaceComparisonEntry,
  WorkspaceComparisonSideContent,
  WorkspaceTurnCaptureRecord,
  WorkspaceTurnComparisonSnapshot,
  WorkspaceTurnWorkIdentity,
} from "../src/standalone/workspace-comparison.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function content(text: string): WorkspaceComparisonContent {
  const bytes = Buffer.from(text, "utf8");
  return {
    sha256: digest(bytes),
    size: bytes.byteLength,
    lineCount: text
      ? [...text].filter((character) => character === "\n").length +
        (text.endsWith("\n") ? 0 : 1)
      : 0,
  };
}

function comparisonEntry(input: {
  path: string;
  change: WorkspaceComparisonEntry["change"];
  left?: string;
  right?: string;
  previousPath?: string;
}): WorkspaceComparisonEntry {
  return {
    path: input.path,
    ...(input.previousPath ? { previousPath: input.previousPath } : {}),
    repositoryId: null,
    change: input.change,
    state: "text",
    ...(input.left !== undefined ? { left: content(input.left) } : {}),
    ...(input.right !== undefined ? { right: content(input.right) } : {}),
    diff: "@@ recorded change @@",
    hunks: [],
  };
}

function turnComparison(
  identity: WorkspaceTurnWorkIdentity,
  threadId: string,
  turnId: string,
  entries: WorkspaceComparisonEntry[],
  comparisonId: string,
): WorkspaceTurnComparisonSnapshot {
  return {
    comparisonId,
    taskId: identity.taskId,
    target: "turn",
    state: "available",
    outcome: "completed",
    startedAt: 10,
    observedAt: 20,
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
    entries,
    truncated: false,
  };
}

function recordTurnComparison(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  comparison: WorkspaceTurnComparisonSnapshot,
  identity: WorkspaceTurnWorkIdentity,
  sides: readonly WorkspaceComparisonSideContent[],
) {
  const capture: WorkspaceTurnCaptureRecord = {
    comparisonId: comparison.comparisonId,
    identity,
    captureState: "pending",
    outcome: "running",
    startedAt: 10,
    observedAt: 10,
    ...(comparison.threadId ? { threadId: comparison.threadId } : {}),
    ...(comparison.turnId ? { turnId: comparison.turnId } : {}),
    before: {
      observedAt: 10,
      state: "available",
      files: [],
      truncated: false,
    },
  };
  f.seedPersistedState((db: DatabaseSync) => {
    const store = new SqliteWorkspaceComparisonStore(db);
    store.beginTurnCapture(capture);
    const updated: WorkspaceTurnCaptureRecord = {
      ...capture,
      outcome: "completed",
      comparison,
      sides: [...sides],
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
}

test("no-result draft captures exact text and comparison sides, seals, discards, restarts and survives cleanup", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Anchor retention",
    "Review exact lines",
  );
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");

  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("first\r\nsecond\r\nthird\n"),
  ]);
  await writeFile(join(workspace.path, "notes.txt"), original);
  const liveHash = digest(original);
  const assignment = f.service.domain().assignment(task.assignmentId);
  const project = f.service.domain().project(task.projectId);
  const profile = f.service.domain().profile(task.profileId);
  const workIdentity: WorkspaceTurnWorkIdentity = {
    taskId: task.taskId,
    taskVersion: Number(f.service.domain().task(task.taskId).version),
    workId: "anchor-review-work",
    workRevision: 1,
    requestSequence: 1,
    assignmentId: task.assignmentId,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(project.instructionsRevision),
    profileRevision: Number(profile.version),
    profileId: String(profile.id),
  };
  const comparisonId = randomUUID();
  const threadId = "anchor-review-thread";
  const turnId = "anchor-review-turn";
  const entries = [
    comparisonEntry({
      path: "renamed-new.txt",
      previousPath: "renamed-old.txt",
      change: "renamed",
      left: "old line\r\nold second\n",
      right: "new line\r\nnew second\n",
    }),
    comparisonEntry({
      path: "added.txt",
      change: "added",
      right: "added line\nsecond added line\n",
    }),
    comparisonEntry({
      path: "deleted.txt",
      change: "deleted",
      left: "deleted line\nsecond deleted line\n",
    }),
  ];
  const sides: WorkspaceComparisonSideContent[] = [
    {
      entryIndex: 0,
      leftText: "old line\r\nold second\n",
      rightText: "new line\r\nnew second\n",
    },
    { entryIndex: 1, rightText: "added line\nsecond added line\n" },
    { entryIndex: 2, leftText: "deleted line\nsecond deleted line\n" },
  ];
  recordTurnComparison(
    f,
    turnComparison(workIdentity, threadId, turnId, entries, comparisonId),
    workIdentity,
    sides,
  );
  const selections = [
    {
      taskId: task.taskId,
      repositoryId: null,
      path: "notes.txt",
      sourceKind: "workspace-file" as const,
      context: "workspace" as const,
      side: "file" as const,
      startLine: 1,
      endLine: 2,
      contentSha256: liveHash,
    },
    {
      taskId: task.taskId,
      repositoryId: null,
      path: "renamed-old.txt",
      sourceKind: "comparison-side" as const,
      context: "turn" as const,
      comparisonId,
      workId: workIdentity.workId,
      threadId,
      turnId,
      side: "left" as const,
      startLine: 1,
      endLine: 2,
      contentSha256: digest("old line\r\nold second\n"),
    },
    {
      taskId: task.taskId,
      repositoryId: null,
      path: "renamed-new.txt",
      sourceKind: "comparison-side" as const,
      context: "turn" as const,
      comparisonId,
      workId: workIdentity.workId,
      threadId,
      turnId,
      side: "right" as const,
      startLine: 2,
      endLine: 2,
      contentSha256: digest("new line\r\nnew second\n"),
    },
    {
      taskId: task.taskId,
      repositoryId: null,
      path: "added.txt",
      sourceKind: "comparison-side" as const,
      context: "turn" as const,
      comparisonId,
      workId: workIdentity.workId,
      threadId,
      turnId,
      side: "right" as const,
      startLine: 1,
      endLine: 1,
      contentSha256: digest("added line\nsecond added line\n"),
    },
    {
      taskId: task.taskId,
      repositoryId: null,
      path: "deleted.txt",
      sourceKind: "comparison-side" as const,
      context: "turn" as const,
      comparisonId,
      workId: workIdentity.workId,
      threadId,
      turnId,
      side: "left" as const,
      startLine: 1,
      endLine: 2,
      contentSha256: digest("deleted line\nsecond deleted line\n"),
    },
  ];
  assert.equal(
    f.service.retainedEvidence().result(task.taskId, randomUUID()),
    undefined,
    "the review anchors do not require a result record",
  );
  const operationId = randomUUID();
  const request = { taskId: task.taskId, operationId, anchors: selections };
  const staged = await f.service.stageReviewAnchorDraft(request);
  assert.equal(staged.anchorIds.length, selections.length);
  assert.ok(
    staged.anchorStates.every((anchor) => anchor.state === "available"),
  );
  const store = f.service.retainedEvidence();
  const [liveId, renameLeftId, renameRightId, addedId, deletedId] =
    staged.anchorIds;
  assert.ok(liveId && renameLeftId && renameRightId && addedId && deletedId);
  assert.deepEqual(
    store.reviewAnchor(task.taskId, liveId)?.bytes,
    original.subarray(
      0,
      Buffer.byteLength("\uFEFFfirst\r\nsecond\r\n", "utf8"),
    ),
  );
  assert.equal(
    store.reviewAnchor(task.taskId, liveId)?.anchor.sourceSha256,
    liveHash,
  );
  assert.deepEqual(
    store.reviewAnchor(task.taskId, renameLeftId)?.bytes,
    Buffer.from("old line\r\nold second\n"),
  );
  assert.deepEqual(
    store.reviewAnchor(task.taskId, renameRightId)?.bytes,
    Buffer.from("new second\n"),
  );
  assert.deepEqual(
    store.reviewAnchor(task.taskId, addedId)?.bytes,
    Buffer.from("added line\n"),
  );
  assert.deepEqual(
    store.reviewAnchor(task.taskId, deletedId)?.bytes,
    Buffer.from("deleted line\nsecond deleted line\n"),
  );
  const retainedLiveBytes = store.reviewAnchor(task.taskId, liveId)?.bytes;
  assert.ok(retainedLiveBytes);

  await writeFile(join(workspace.path, "notes.txt"), "later file bytes\n");
  const replay = await f.service.stageReviewAnchorDraft(request);
  assert.deepEqual(replay, staged);
  assert.deepEqual(
    store.reviewAnchor(task.taskId, liveId)?.bytes,
    retainedLiveBytes,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      ...request,
      anchors: [{ ...selections[0]!, endLine: 1 }, ...selections.slice(1)],
    }),
    /different material/,
  );

  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [
        {
          ...selections[1]!,
          side: "right",
        },
      ],
    }),
    /source mismatch/,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [{ ...selections[1]!, turnId: "other-turn" }],
    }),
    /turn identity mismatch/,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [
        { ...selections[1]!, contentSha256: digest("forged side bytes") },
      ],
    }),
    /side or range is invalid/,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [{ ...selections[1]!, startLine: 3, endLine: 99 }],
    }),
    /range is invalid/,
  );

  const sealed = f.service.sealReviewAnchorDraft({
    taskId: task.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
    anchorIds: staged.anchorIds,
  });
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.linkState, "durable");
  assert.equal(sealed.deliveryState, "not-attempted");
  assert.equal(sealed.receiptState, "none");
  const discarded = f.service.discardReviewAnchorDraft({
    taskId: task.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
  });
  assert.equal(discarded.submittedContextPreserved, true);
  assert.equal(
    store.reviewAnchorDraft(task.taskId, staged.draftId)?.state,
    "discarded",
  );
  assert.deepEqual(
    store.reviewAnchorSubmittedContext(task.taskId, sealed.submittedContextId)
      ?.anchorIds,
    staged.anchorIds,
  );
  assert.equal(store.reviewAnchorHasReference(task.taskId, liveId), true);
  assert.equal(
    "originRoot" in store.reviewAnchor(task.taskId, liveId)!.anchor,
    false,
  );

  const archived = await f.service.archiveTask(task.taskId, {
    deliveryConfirmed: true,
    writerOwnershipResolved: true,
    handoffsPreserved: true,
    reconciliationEvidencePreserved: true,
    workspaceContentsPreserved: true,
  });
  assert.equal(archived.outcome, "cleaned");
  await assert.rejects(readFile(join(workspace.path, "notes.txt")));
  await f.reopen();
  const reopened = f.service
    .retainedEvidence()
    .reviewAnchor(task.taskId, liveId);
  assert.ok(reopened?.bytes);
  assert.equal(
    digest(reopened.bytes),
    digest(
      original.subarray(
        0,
        Buffer.byteLength("\uFEFFfirst\r\nsecond\r\n", "utf8"),
      ),
    ),
  );
  assert.equal(
    f.service.retainedEvidence().reviewAnchor(task.taskId, renameLeftId)?.anchor
      .turnId,
    turnId,
  );
});

test("an unrelated retained result does not become an implicit anchor result binding", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Independent anchor",
    "Do not infer a result",
  );
  const unrelated = task.result("An existing, unrelated result", {
    sourceId: task.source.sourceId,
  });
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const bytes = Buffer.from("anchor from current file\n");
  await writeFile(join(workspace.path, "current.txt"), bytes);
  const staged = await f.service.stageReviewAnchorDraft({
    taskId: task.taskId,
    operationId: randomUUID(),
    anchors: [
      {
        taskId: task.taskId,
        repositoryId: null,
        path: "current.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 1,
        contentSha256: digest(bytes),
      },
    ],
  });
  const anchor = f.service
    .retainedEvidence()
    .reviewAnchor(task.taskId, staged.anchorIds[0]!);
  assert.deepEqual(anchor?.bytes, bytes);
  assert.equal(anchor?.anchor.resultId, undefined);
  assert.equal(
    Boolean(f.service.taskReview().result(task.taskId, unrelated.resultId)),
    true,
  );
  const resultSelection = {
    taskId: task.taskId,
    repositoryId: null,
    path: "current.txt",
    sourceKind: "result-evidence" as const,
    context: "result" as const,
    side: "file" as const,
    startLine: 1,
    endLine: 1,
    contentSha256: digest(bytes),
    resultItemId: randomUUID(),
    workId: unrelated.workId,
  };
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [resultSelection],
    }),
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [{ ...resultSelection, resultId: unrelated.resultId }],
    }),
    /result source mismatch/,
  );
});

test("interrupted stage and seal roll back atomically, retry, and leave no orphan context", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Interrupted anchor",
    "Keep durable refs atomic",
  );
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const bytes = Buffer.from("one exact line\n");
  await writeFile(join(workspace.path, "atomic.txt"), bytes);
  const request = {
    taskId: task.taskId,
    operationId: randomUUID(),
    anchors: [
      {
        taskId: task.taskId,
        repositoryId: null,
        path: "atomic.txt",
        sourceKind: "workspace-file" as const,
        context: "workspace" as const,
        side: "file" as const,
        startLine: 1,
        endLine: 1,
        contentSha256: digest(bytes),
      },
    ],
  };
  f.seedPersistedState((db) => {
    db.exec(`CREATE TRIGGER interrupt_anchor_stage
      BEFORE INSERT ON retained_review_anchor_draft_refs
      BEGIN SELECT RAISE(ABORT, 'interrupted-stage'); END`);
  });
  await assert.rejects(
    f.service.stageReviewAnchorDraft(request),
    /interrupted-stage/,
  );
  f.seedPersistedState((db) => {
    const count = (table: string) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      );
    assert.equal(count("retained_review_anchor_contexts"), 0);
    assert.equal(count("retained_review_anchor_drafts"), 0);
    assert.equal(count("retained_review_anchor_draft_refs"), 0);
    assert.equal(count("retained_review_anchor_operations"), 0);
    db.exec("DROP TRIGGER interrupt_anchor_stage");
  });
  const staged = await f.service.stageReviewAnchorDraft(request);
  const seal = {
    taskId: task.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
    anchorIds: staged.anchorIds,
  };
  f.seedPersistedState((db) => {
    db.exec(`CREATE TRIGGER interrupt_anchor_seal
      BEFORE INSERT ON retained_review_anchor_submitted_refs
      BEGIN SELECT RAISE(ABORT, 'interrupted-seal'); END`);
  });
  assert.throws(
    () => f.service.sealReviewAnchorDraft(seal),
    /interrupted-seal/,
  );
  assert.equal(
    f.service.retainedEvidence().reviewAnchorDraft(task.taskId, staged.draftId)
      ?.state,
    "open",
  );
  f.seedPersistedState((db) => {
    const count = (table: string) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      );
    assert.equal(count("retained_review_anchor_submitted_contexts"), 0);
    assert.equal(count("retained_review_anchor_submitted_refs"), 0);
    assert.equal(count("retained_review_anchor_draft_submissions"), 0);
    assert.equal(count("retained_review_anchor_contexts"), 1);
    assert.equal(
      count("retained_review_anchor_operations"),
      1,
      "only the stage receipt is committed",
    );
    db.exec("DROP TRIGGER interrupt_anchor_seal");
  });
  const sealed = f.service.sealReviewAnchorDraft(seal);
  assert.equal(sealed.deliveryState, "not-attempted");
  assert.equal(
    f.service
      .retainedEvidence()
      .reviewAnchorHasReference(task.taskId, staged.anchorIds[0]!),
    true,
  );
  assert.throws(
    () =>
      f.service.sealReviewAnchorDraft({ ...seal, anchorIds: [randomUUID()] }),
    /different material/,
  );
});

test("anchor quota gaps keep no payload and explicit discard removes unreferenced context", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Anchor quota", "Keep bounded context");
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const bytes = Buffer.alloc(
    retainedEvidenceLimits.maxReviewAnchorBytes + 1,
    0x61,
  );
  await writeFile(join(workspace.path, "large-anchor.txt"), bytes);
  const staged = await f.service.stageReviewAnchorDraft({
    taskId: task.taskId,
    operationId: randomUUID(),
    anchors: [
      {
        taskId: task.taskId,
        repositoryId: null,
        path: "large-anchor.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 1,
        contentSha256: digest(bytes),
      },
    ],
  });
  const anchorId = staged.anchorIds[0]!;
  assert.deepEqual(staged.anchorStates, [
    { anchorId, state: "gap", reason: "quota" },
  ]);
  assert.equal(
    f.service.retainedEvidence().reviewAnchor(task.taskId, anchorId)?.bytes,
    undefined,
  );
  assert.equal(
    f.service.retainedEvidence().reviewAnchor(task.taskId, anchorId)?.anchor
      .size,
    0,
  );
  const discarded = f.service.discardReviewAnchorDraft({
    taskId: task.taskId,
    draftId: staged.draftId,
    operationId: randomUUID(),
  });
  assert.equal(discarded.submittedContextPreserved, false);
  assert.equal(
    f.service.retainedEvidence().reviewAnchor(task.taskId, anchorId),
    undefined,
  );
  assert.equal(
    f.service
      .retainedEvidence()
      .reviewAnchorHasReference(task.taskId, anchorId),
    false,
  );
});

test("a comparison owned by another task is rejected without creating a draft", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Anchor owner",
    "Reject foreign comparison",
  );
  const foreignTask = await seedReviewTask(
    f,
    "Foreign anchor owner",
    "Do not share source",
  );
  const assignment = f.service.domain().assignment(foreignTask.assignmentId);
  const project = f.service.domain().project(foreignTask.projectId);
  const profile = f.service.domain().profile(foreignTask.profileId);
  const foreignIdentity: WorkspaceTurnWorkIdentity = {
    taskId: foreignTask.taskId,
    taskVersion: Number(f.service.domain().task(foreignTask.taskId).version),
    workId: randomUUID(),
    workRevision: 1,
    requestSequence: 1,
    assignmentId: foreignTask.assignmentId,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(project.instructionsRevision),
    profileRevision: Number(profile.version),
    profileId: String(profile.id),
  };
  const comparisonId = randomUUID();
  const threadId = "foreign-thread";
  const turnId = "foreign-turn";
  const entries = [
    comparisonEntry({
      path: "foreign.txt",
      change: "added",
      right: "foreign\n",
    }),
  ];
  recordTurnComparison(
    f,
    turnComparison(foreignIdentity, threadId, turnId, entries, comparisonId),
    foreignIdentity,
    [{ entryIndex: 0, rightText: "foreign\n" }],
  );
  assert.equal(
    f.service.workspaceComparisonOwner(comparisonId),
    foreignTask.taskId,
  );
  await assert.rejects(
    f.service.stageReviewAnchorDraft({
      taskId: task.taskId,
      operationId: randomUUID(),
      anchors: [
        {
          taskId: task.taskId,
          repositoryId: null,
          path: "foreign.txt",
          sourceKind: "comparison-side",
          context: "turn",
          comparisonId,
          workId: foreignIdentity.workId,
          threadId,
          turnId,
          side: "right",
          startLine: 1,
          endLine: 1,
          contentSha256: digest("foreign\n"),
        },
      ],
    }),
    /comparison identity mismatch/,
  );
  f.seedPersistedState((db) => {
    assert.equal(
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM retained_review_anchor_drafts WHERE taskId=?",
            )
            .get(task.taskId) as { count: number }
        ).count,
      ),
      0,
    );
  });
});
