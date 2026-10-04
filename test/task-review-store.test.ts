import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/core/store.js";
import { DomainStore, type DomainCommand } from "../src/core/domain.js";
import { CoordinationStore } from "../src/core/coordination.js";
import {
  sourceSnapshotSchema,
  TaskReviewStore,
} from "../src/core/task-review.js";
import { ExecutionState } from "../src/standalone/state.js";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ui04-review-")),
    file = join(directory, "state.sqlite");
  let db = new DatabaseSync(file);
  const init = () => {
    db.exec("PRAGMA foreign_keys=ON");
    new Store(db).ensureHost("test");
    const d = new DomainStore(db);
    d.migrate();
    const c = new CoordinationStore(db, d);
    c.migrate();
    return { d, c, s: new ExecutionState(db), review: new TaskReviewStore(db) };
  };
  let stores = init();
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const run = (v: Omit<DomainCommand, "key">) =>
    stores.d.execute({ ...v, key: randomUUID() } as DomainCommand);
  run({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "PRIVATE INSTRUCTIONS",
    capabilities: "review",
  } as Omit<DomainCommand, "key">);
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Review project",
    leadProfileId: profileId,
  } as Omit<DomainCommand, "key">);
  run({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Supplied brief",
    outcome: "- [ ] First criterion\n- [ ] Second criterion",
    ready: false,
  } as Omit<DomainCommand, "key">);
  const a = stores.d.ensureLeadAssignment(taskId);
  assert.ok(a);
  const assignmentId = String(a.id);
  function work() {
    const workId = randomUUID(),
      threadId = randomUUID(),
      turnId = randomUUID();
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval) VALUES(?,?,'work','/tmp/work','running',?,?,'chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId, threadId, turnId);
    stores.s.bindTask(workId, {
      taskId,
      assignmentId,
      assignmentVersion: 1,
      profileRevision: 1,
      instructionsRevision: 1,
    });
    db.prepare(
      "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES(?,?,1,?)",
    ).run(workId, assignmentId, stores.c.results(taskId).length + 1);
    db.prepare("UPDATE domain_assignments SET state='running' WHERE id=?").run(
      assignmentId,
    );
    stores.review.captureAssignment(
      assignmentId,
      "Fixture work preparation",
      workId,
    );
    return { workId, threadId, turnId };
  }
  return {
    get stores() {
      return stores;
    },
    get db() {
      return db;
    },
    projectId,
    taskId,
    assignmentId,
    work,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      stores = init();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("literal source snapshots and creation/preparation context survive restart without private text or invented prose criteria", () => {
  const f = fixture();
  try {
    const s1 = f.stores.review.sources(f.taskId)[0];
    assert.equal(s1?.criteria.length, 2);
    const w = f.work();
    assert.ok(
      f.stores.review
        .read(f.taskId)
        .contexts.some((c) => c.workId === w.workId),
    );
    f.stores.d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: 1,
      outcome: "Supplied prose acceptance requirements",
    });
    const s2 = f.stores.review.sources(f.taskId)[1];
    assert.equal(s2?.criteria.length, 0);
    assert.notEqual(s2?.sourceId, s1?.sourceId);
    f.reopen();
    assert.equal(f.stores.review.sources(f.taskId).length, 2);
    assert.ok(
      !JSON.stringify(f.stores.review.read(f.taskId)).includes(
        "PRIVATE INSTRUCTIONS",
      ),
    );
  } finally {
    f.close();
  }
});
test("review metadata is atomic with real result and receipt; replay compares all material and foreign anchors fail before commit", () => {
  const f = fixture();
  try {
    const w = f.work(),
      source = f.stores.review.sources(f.taskId)[0];
    assert.ok(source);
    const call = {
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: "Recorded result",
        review: {
          sourceId: String(randomUUID()),
          criteria: [],
          validations: [],
          artifacts: [],
          decisions: [],
        },
      },
    };
    assert.throws(() => f.stores.c.recordResult(call), /Review source/);
    assert.equal(f.stores.c.results(f.taskId).length, 0);
    assert.equal(f.stores.c.receipt(call), undefined);
    call.arguments.review.sourceId = source.sourceId;
    const saved = f.stores.c.recordResult(call);
    assert.equal(f.stores.c.recordResult(call).replayed, true);
    assert.equal(f.stores.review.read(f.taskId).results.length, 1);
    assert.throws(
      () =>
        f.stores.c.recordResult({
          ...call,
          arguments: {
            ...call.arguments,
            review: {
              ...call.arguments.review,
              decisions: [
                { text: "A different decision", attribution: "assignee" },
              ],
            },
          },
        }),
      /different content/,
    );
    f.reopen();
    assert.equal(
      f.stores.review.read(f.taskId).results[0]?.resultId,
      saved.result.resultId,
    );
    assert.equal(f.stores.c.recordResult(call).replayed, true);
  } finally {
    f.close();
  }
});
test("recorded criterion scope, artifacts, decisions and repair ownership are supplied; unsafe and cross-task references reject atomically", () => {
  const f = fixture();
  try {
    const w = f.work(),
      source = f.stores.review.sources(f.taskId)[0];
    assert.ok(source);
    const review = {
      sourceId: source.sourceId,
      criteria: [
        {
          criterionId: source.criteria[0]?.criterionId ?? "",
          outcome: "supported",
          scope: "Original criterion only",
          provenance: "Agent supplied check",
        },
      ],
      artifacts: [
        {
          artifactId: randomUUID(),
          label: "Before",
          role: "before",
          revision: 1,
          availability: "available",
          file: {
            relativePath: "../escape.png",
            sha256: "a".repeat(64),
            mime: "image/png",
            size: 10,
          },
        },
      ],
      validations: [],
      decisions: [],
    };
    const call = {
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Recorded", review },
    };
    assert.throws(() => f.stores.c.recordResult(call), /Unsafe artifact/);
    review.artifacts[0]!.file.relativePath = "capture.png";
    const r = f.stores.c.recordResult(call);
    const ref = {
      sourceId: source.sourceId,
      resultId: r.result.resultId,
      criterionId: review.criteria[0]!.criterionId,
      artifactId: review.artifacts[0]!.artifactId,
      workId: w.workId,
    };
    assert.deepEqual(f.stores.review.validateReference(f.taskId, ref), ref);
    f.stores.d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: 1,
      outcome: "- [ ] New scope",
    });
    const newer = f.stores.review.sources(f.taskId).at(-1)!;
    assert.throws(
      () =>
        f.stores.review.validateReference(f.taskId, {
          ...ref,
          sourceId: newer.sourceId,
        }),
      /does not match result/,
    );
    assert.throws(
      () =>
        f.stores.review.validateReference(f.taskId, {
          ...ref,
          sourceId: undefined,
          criterionId: newer.criteria[0]!.criterionId,
        }),
      /does not match result/,
    );
    assert.throws(
      () => f.stores.review.validateReference(randomUUID(), ref),
      /unavailable/,
    );
    assert.throws(
      () =>
        f.stores.review.validateReference(f.taskId, {
          ...ref,
          workId: "different",
        }),
      /work unavailable/,
    );
  } finally {
    f.close();
  }
});
test("legacy result has absent optional metadata and first visit has no viewing baseline; explicit idempotent viewing does not mutate task state", () => {
  const f = fixture();
  try {
    const w = f.work();
    const saved = f.stores.c.recordResult({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Legacy result" },
    });
    assert.equal(f.stores.review.read(f.taskId).results.length, 0);
    assert.equal(f.stores.review.read(f.taskId).viewed, null);
    const source = f.stores.review.sources(f.taskId)[0];
    assert.ok(source);
    const key = randomUUID();
    f.stores.review.recordViewed(f.taskId, key, source.sourceId, [
      saved.result.resultId,
    ]);
    const viewed = f.stores.review.read(f.taskId).viewed;
    f.stores.review.recordViewed(f.taskId, key, source.sourceId, [
      saved.result.resultId,
    ]);
    assert.deepEqual(f.stores.review.read(f.taskId).viewed, viewed);
    assert.throws(
      () => f.stores.review.recordViewed(f.taskId, key, null, []),
      /reused/,
    );
    f.reopen();
    assert.deepEqual(f.stores.review.read(f.taskId).viewed, viewed);
    assert.equal(f.stores.d.task(f.taskId).state, "open");
  } finally {
    f.close();
  }
});

test("claimed result sources require one exact retained work context; absent claims stay unknown", () => {
  const f = fixture();
  try {
    const source = f.stores.review.sources(f.taskId)[0]!;
    const w = f.work();
    const result = {
      resultId: randomUUID(),
      taskId: f.taskId,
      assignmentId: f.assignmentId,
      workId: w.workId,
      workRevision: 1,
    };
    const context = f.stores.review.contextForWork(
      f.taskId,
      f.assignmentId,
      w.workId,
    )!;
    f.db
      .prepare("DELETE FROM task_review_contexts WHERE captureId=?")
      .run(context.captureId);
    assert.throws(
      () => f.stores.review.recordResult(result, { sourceId: source.sourceId }),
      /captured work context/,
    );
    const insert = (record: typeof context, taskId = f.taskId) =>
      f.db
        .prepare("INSERT INTO task_review_contexts VALUES(?,?,?,?,?,?)")
        .run(
          record.captureId,
          taskId,
          record.assignmentId,
          record.assignmentVersion,
          record.workId,
          JSON.stringify(record),
        );
    insert({ ...context, sourceId: null });
    assert.throws(
      () => f.stores.review.recordResult(result, { sourceId: source.sourceId }),
      /captured work context/,
    );
    f.db
      .prepare("DELETE FROM task_review_contexts WHERE captureId=?")
      .run(context.captureId);
    insert({ ...context, taskId: randomUUID() });
    assert.throws(
      () => f.stores.review.recordResult(result, { sourceId: source.sourceId }),
      /identity mismatch/,
    );
    f.db
      .prepare("DELETE FROM task_review_contexts WHERE captureId=?")
      .run(context.captureId);
    insert(context);
    insert({ ...context, captureId: randomUUID(), assignmentVersion: 2 });
    assert.throws(
      () => f.stores.review.recordResult(result, { sourceId: source.sourceId }),
      /ambiguous/,
    );
    assert.equal(f.stores.review.read(f.taskId).results.length, 0);
    f.db
      .prepare("DELETE FROM task_review_contexts WHERE workId=?")
      .run(w.workId);
    f.stores.c.recordResult({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "No claimed source", review: {} },
    });
    assert.equal(
      f.stores.review.read(f.taskId).results[0]?.metadata.sourceId,
      undefined,
    );
    const { criteriaOmittedCount: _count, ...historical } = source;
    assert.equal(
      sourceSnapshotSchema.parse(historical).criteriaOmittedCount,
      null,
    );
  } finally {
    f.close();
  }
});
