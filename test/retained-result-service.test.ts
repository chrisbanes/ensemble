import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RetainedEvidenceStore } from "../src/core/retained-evidence.js";
import { Store } from "../src/core/store.js";
import { reviewMetadataSchema } from "../src/core/task-review.js";
import {
  captureRetainedResultEvidence,
  type RetainedEvidenceCapturePolicy,
} from "../src/standalone/retained-evidence.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
} from "../src/standalone/workspaces.js";
import type {
  WorkspaceComparisonContent,
  WorkspaceComparisonEntry,
  WorkspaceComparisonExport,
  WorkspaceComparisonSideContent,
  WorkspaceTurnCaptureRecord,
  WorkspaceTurnComparisonSnapshot,
  WorkspaceTurnWorkIdentity,
} from "../src/standalone/workspace-comparison.js";
import type { RetainedEvidenceIdentity } from "../src/core/retained-evidence.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const taskId = "20000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000001";

function turnIdentity(turnId = "retained-turn"): RetainedEvidenceIdentity {
  return {
    taskId,
    taskVersion: 3,
    captureTaskVersion: 3,
    assignmentId,
    assignmentVersion: 2,
    workId: "retained-work",
    workRevision: 4,
    requestSequence: 7,
    conversationRevision: 1,
    instructionsRevision: 2,
    profileRevision: 1,
    profileId,
    threadId: "retained-thread",
    turnId,
  };
}

function workIdentity(
  identity: RetainedEvidenceIdentity,
): WorkspaceTurnWorkIdentity {
  return {
    taskId: identity.taskId,
    taskVersion: identity.taskVersion,
    workId: identity.workId,
    workRevision: identity.workRevision,
    requestSequence: identity.requestSequence,
    assignmentId: identity.assignmentId,
    assignmentVersion: identity.assignmentVersion,
    instructionsRevision: identity.instructionsRevision,
    profileRevision: identity.profileRevision,
    profileId: identity.profileId,
  };
}

function content(text: string): WorkspaceComparisonContent {
  const bytes = Buffer.from(text, "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    lineCount: text
      ? text.endsWith("\n")
        ? [...text].filter((character) => character === "\n").length
        : [...text].filter((character) => character === "\n").length + 1
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
    change: input.change,
    state: "text",
    ...(input.left !== undefined ? { left: content(input.left) } : {}),
    ...(input.right !== undefined ? { right: content(input.right) } : {}),
    diff: "@@ exact observed change @@",
    hunks: [
      {
        oldStart: 1,
        oldLines: input.left === undefined ? 0 : 1,
        newStart: 1,
        newLines: input.right === undefined ? 0 : 1,
        patch: "@@ exact observed change @@",
      },
    ],
  };
}

function exportFor(
  identity: RetainedEvidenceIdentity,
  entries: WorkspaceComparisonEntry[],
  sides: WorkspaceComparisonSideContent[],
  comparisonId = randomUUID(),
): WorkspaceComparisonExport {
  const comparison: WorkspaceTurnComparisonSnapshot = {
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
    threadId: identity.threadId,
    turnId: identity.turnId,
    entries,
    truncated: false,
  };
  return { comparison, sides, captureState: "finished" };
}

function turnCapture(
  identity: RetainedEvidenceIdentity,
  comparisonId: string,
  state: WorkspaceTurnCaptureRecord["captureState"] = "finished",
): WorkspaceTurnCaptureRecord {
  return {
    comparisonId,
    identity: workIdentity(identity),
    captureState: state,
    outcome: state === "finished" ? "completed" : "running",
    startedAt: 10,
    observedAt: 20,
    threadId: identity.threadId,
    turnId: identity.turnId,
  };
}

async function filesystemFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-retained-fs-"));
  const db = new DatabaseSync(join(directory, "workspace.sqlite"));
  new Store(db).ensureHost("retained-evidence-capture-test");
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    join(directory, "workspaces"),
  );
  const binding = await manager.provision(taskId);
  if (binding.state !== "ready") throw new Error("Workspace fixture not ready");
  const currentWorkspace = async () => ({
    taskId,
    taskVersion: 3,
    visibility: "retained-workspace-test",
    binding,
    controlPaths: [],
  });
  const policy: RetainedEvidenceCapturePolicy = {
    taskVersion: 3,
    fingerprint: "retained-policy-test",
    excluded: [],
    authorizedRepositoryIds: [],
  };
  return {
    directory,
    db,
    binding,
    currentWorkspace,
    currentPolicy: async () => policy,
    close() {
      db.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

test("native result capture retains exact workspace bytes in SQLite and receipt replay does not recapture", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const seeded = await seedReviewTask(
    f,
    "Exact evidence capture",
    "Retain callback evidence",
  );
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(d.task(seeded.taskId).version),
    ready: true,
  });
  for (let attempt = 0; attempt < 100 && f.runtime.turns < 1; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  for (
    let attempt = 0;
    attempt < 100 && !f.service.list().some((work) => work.state === "running");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const work = f.service.list().find((entry) => entry.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const admittedRequest = f.service
    .turnRequests()
    .find((request) => request.workId === work.workId);
  assert.ok(admittedRequest);
  const admittedTaskVersion = admittedRequest.taskVersion;
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  assert.ok(workspace?.state === "ready");
  const path = join(workspace.path, "retained-proof.txt");
  const expected = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("first\r\nsecond\r\nfinal-without-newline", "utf8"),
  ]);
  await writeFile(path, expected);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(d.task(seeded.taskId).version),
    title: "Updated after request admission",
  });
  const captureTaskVersion = Number(d.task(seeded.taskId).version);
  const call = {
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Exact evidence callback",
      review: {
        sourceId: seeded.source.sourceId,
        changes: { files: ["retained-proof.txt"] },
      },
    },
  };
  const response = await f.runtime.callTool(call);
  assert.equal(response.success, true, response.text);
  const recorded = f.service.coordinationView().readTask(seeded.taskId)
    .results[0];
  assert.ok(recorded);
  let retainedBytes: Buffer | undefined;
  f.seedPersistedState((db) => {
    const store = new RetainedEvidenceStore(db);
    const manifest = store.result(seeded.taskId, recorded.resultId);
    assert.ok(manifest);
    assert.equal(manifest.taskVersion, admittedTaskVersion);
    assert.equal(manifest.captureTaskVersion, captureTaskVersion);
    assert.equal(manifest.state, "partial");
    assert.match(
      manifest.sourceObservation.comparisonId ?? "",
      /^[0-9a-f-]{36}$/,
    );
    assert.equal(manifest.sourceObservation.captureState, "pending");
    assert.equal(manifest.sourceObservation.outcome, "running");
    assert.ok((manifest.sourceObservation.observedAt ?? 0) > 0);
    const file = manifest.items.find((item) => item.kind === "file");
    assert.ok(file?.state === "available");
    assert.equal(file.path, "retained-proof.txt");
    const diff = manifest.items.find((item) => item.kind === "diff");
    assert.equal(diff?.state, "gap");
    assert.equal(diff?.reason, "comparison-unsettled");
    retainedBytes = store.item(
      seeded.taskId,
      recorded.resultId,
      file.itemId,
    )?.bytes;
  });
  assert.deepEqual(retainedBytes, expected);

  await writeFile(
    path,
    "later filesystem content must not replace retained bytes",
  );
  const replay = await f.runtime.callTool(call);
  assert.deepEqual(replay, response);
  f.seedPersistedState((db) => {
    const store = new RetainedEvidenceStore(db);
    const manifest = store.result(seeded.taskId, recorded.resultId);
    assert.ok(manifest);
    const file = manifest.items.find((item) => item.kind === "file");
    assert.ok(file?.state === "available");
    assert.deepEqual(
      store.item(seeded.taskId, recorded.resultId, file.itemId)?.bytes,
      expected,
    );
  });
});

test("native callback after a task metadata update records an empty manifest and exact receipt", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const seeded = await seedReviewTask(
    f,
    "Empty evidence after update",
    "Retain an empty native callback",
  );
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(d.task(seeded.taskId).version),
    ready: true,
  });
  for (let attempt = 0; attempt < 100 && f.runtime.turns < 1; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  for (
    let attempt = 0;
    attempt < 100 && !f.service.list().some((work) => work.state === "running");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const work = f.service.list().find((entry) => entry.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const admittedRequest = f.service
    .turnRequests()
    .find((request) => request.workId === work.workId);
  assert.ok(admittedRequest);
  const admittedTaskVersion = admittedRequest.taskVersion;
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(d.task(seeded.taskId).version),
    title: "Metadata updated during admitted turn",
  });
  const captureTaskVersion = Number(d.task(seeded.taskId).version);
  const call = {
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: { summary: "No eligible evidence links" },
  };
  const response = await f.runtime.callTool(call);
  assert.equal(response.success, true, response.text);
  const result = f.service.coordinationView().readTask(seeded.taskId)
    .results[0];
  assert.ok(result);
  let capturedAt = 0;
  f.seedPersistedState((db) => {
    const store = new RetainedEvidenceStore(db);
    const manifest = store.result(seeded.taskId, result.resultId);
    assert.ok(manifest);
    assert.equal(manifest.state, "empty");
    assert.deepEqual(manifest.items, []);
    assert.equal(manifest.taskVersion, admittedTaskVersion);
    assert.equal(manifest.captureTaskVersion, captureTaskVersion);
    capturedAt = manifest.capturedAt;
    const receipt = db
      .prepare(
        "SELECT response, workId FROM coordination_receipts WHERE callId=?",
      )
      .get(call.callId) as { response: string; workId: string } | undefined;
    assert.ok(receipt);
    assert.equal(receipt.workId, work.workId);
    assert.deepEqual(JSON.parse(receipt.response), response);
  });
  const replay = await f.runtime.callTool(call);
  assert.deepEqual(replay, response);
  f.seedPersistedState((db) => {
    const manifest = new RetainedEvidenceStore(db).result(
      seeded.taskId,
      result.resultId,
    );
    assert.ok(manifest);
    assert.equal(manifest.capturedAt, capturedAt);
    assert.equal(manifest.taskVersion, admittedTaskVersion);
    assert.equal(manifest.captureTaskVersion, captureTaskVersion);
  });
});

test("exact finished turn exports retain added, deleted and renamed sides with explicit absent-side provenance", async (t) => {
  const f = await filesystemFixture();
  t.after(() => f.close());
  const identity = turnIdentity();
  const addedText = "added line\nsecond line";
  const deletedText = "original deleted line\n";
  const oldNameText = "before rename\n";
  const newNameText = "after rename\n";
  await writeFile(join(f.binding.path, "added.txt"), addedText);
  await writeFile(join(f.binding.path, "renamed.txt"), newNameText);
  const entries = [
    comparisonEntry({ path: "added.txt", change: "added", right: addedText }),
    comparisonEntry({
      path: "removed.txt",
      change: "deleted",
      left: deletedText,
    }),
    comparisonEntry({
      path: "renamed.txt",
      previousPath: "old-name.txt",
      change: "renamed",
      left: oldNameText,
      right: newNameText,
    }),
  ];
  const sides: WorkspaceComparisonSideContent[] = [
    { entryIndex: 0, rightText: addedText },
    { entryIndex: 1, leftText: deletedText },
    { entryIndex: 2, leftText: oldNameText, rightText: newNameText },
  ];
  const comparisonId = randomUUID();
  const exported = exportFor(identity, entries, sides, comparisonId);
  const candidate = await captureRetainedResultEvidence({
    identity,
    review: reviewMetadataSchema.parse({
      changes: { files: ["added.txt", "removed.txt", "old-name.txt"] },
    }),
    currentWorkspace: f.currentWorkspace,
    currentPolicy: f.currentPolicy,
    turnCaptures: { latestFinished: turnCapture(identity, comparisonId) },
    exportComparison: (id) => (id === comparisonId ? exported : undefined),
  });
  const diffs = candidate.items.filter((item) => item.kind === "diff");
  assert.equal(diffs.length, 3);
  assert.ok(diffs.every((item) => item.state === "available"));
  const added = JSON.parse(Buffer.from(diffs[0]!.bytes!).toString("utf8")) as {
    left: { state: string };
    right: { state: string; text: string };
  };
  const deleted = JSON.parse(
    Buffer.from(diffs[1]!.bytes!).toString("utf8"),
  ) as { left: { state: string; text: string }; right: { state: string } };
  const renamed = JSON.parse(
    Buffer.from(diffs[2]!.bytes!).toString("utf8"),
  ) as {
    previousPath: string;
    left: { text: string };
    right: { text: string };
  };
  assert.deepEqual(added.left, { state: "absent" });
  assert.equal(added.right.text, addedText);
  assert.equal(deleted.left.text, deletedText);
  assert.deepEqual(deleted.right, { state: "absent" });
  assert.equal(renamed.previousPath, "old-name.txt");
  assert.equal(renamed.left.text, oldNameText);
  assert.equal(renamed.right.text, newNameText);
  assert.deepEqual(candidate.sourceObservation, {
    comparisonId,
    captureState: "finished",
    outcome: "completed",
    observedAt: 20,
  });
});

test("older finished turns are never substituted and a current pending export remains an explicit gap", async (t) => {
  const f = await filesystemFixture();
  t.after(() => f.close());
  const identity = turnIdentity("current-turn");
  await writeFile(join(f.binding.path, "current.txt"), "current file\n");
  const previousIdentity = turnIdentity("older-turn");
  const previousCapture = turnCapture(previousIdentity, randomUUID());
  let exportCalls = 0;
  const review = reviewMetadataSchema.parse({
    changes: { files: ["current.txt"] },
  });
  const noSubstitution = await captureRetainedResultEvidence({
    identity,
    review,
    currentWorkspace: f.currentWorkspace,
    currentPolicy: f.currentPolicy,
    turnCaptures: { latestFinished: previousCapture },
    exportComparison: () => {
      exportCalls++;
      return undefined;
    },
  });
  assert.equal(exportCalls, 0);
  assert.deepEqual(noSubstitution.sourceObservation, {
    comparisonId: null,
    captureState: "missing",
    outcome: null,
    observedAt: null,
  });
  assert.equal(
    noSubstitution.items.find((item) => item.kind === "diff")?.state,
    "gap",
  );
  assert.equal(
    noSubstitution.items.find((item) => item.kind === "diff")?.reason,
    "comparison-unavailable",
  );

  const pendingId = randomUUID();
  const pending = turnCapture(identity, pendingId, "pending");
  const pendingExport: WorkspaceComparisonExport = {
    comparison: {
      ...exportFor(identity, [], [], pendingId).comparison,
      state: "unavailable",
      outcome: "unknown",
    } as WorkspaceTurnComparisonSnapshot,
    sides: [],
    captureState: "pending",
  };
  const pendingGap = await captureRetainedResultEvidence({
    identity,
    review,
    currentWorkspace: f.currentWorkspace,
    currentPolicy: f.currentPolicy,
    turnCaptures: { pending },
    exportComparison: (id) => (id === pendingId ? pendingExport : undefined),
  });
  assert.equal(pendingGap.sourceObservation.captureState, "pending");
  assert.equal(pendingGap.sourceObservation.comparisonId, pendingId);
  assert.equal(
    pendingGap.items.find((item) => item.kind === "diff")?.reason,
    "comparison-unsettled",
  );
});
