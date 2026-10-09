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
import { GitHubSourceStore } from "../src/core/github-source.js";
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
    const batch = stores.c.bindDeliveryBatch(assignmentId, workId);
    if (batch) stores.c.completeDeliveryBatch(workId);
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
      assignmentVersion: 1,
    };
    const context = f.stores.review.contextForWork(
      f.taskId,
      f.assignmentId,
      w.workId,
      1,
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
    assert.equal(
      f.stores.review.contextForWork(f.taskId, f.assignmentId, w.workId, 1)
        ?.captureId,
      context.captureId,
    );
    assert.equal(
      f.stores.review.contextForWork(f.taskId, f.assignmentId, w.workId, 2)
        ?.assignmentVersion,
      2,
    );
    assert.throws(() =>
      f.stores.review.contextForWork(
        f.taskId,
        f.assignmentId,
        w.workId,
        undefined as never,
      ),
    );
    assert.throws(() =>
      f.stores.review.contextForWork(f.taskId, f.assignmentId, w.workId, 0),
    );
    assert.throws(
      () =>
        f.stores.review.recordResult(
          { ...result, assignmentVersion: 3 },
          { sourceId: source.sourceId },
        ),
      /captured work context/,
    );
    f.db
      .prepare("UPDATE task_review_contexts SET recordJson=? WHERE captureId=?")
      .run(
        JSON.stringify({ ...context, assignmentVersion: 2 }),
        context.captureId,
      );
    assert.throws(
      () =>
        f.stores.review.contextForWork(f.taskId, f.assignmentId, w.workId, 1),
      /identity mismatch/,
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

test("upgrade atomically populates only missing retained sources and result indexes without rewriting existing bytes", async () => {
  const f = fixture();
  try {
    const w = f.work();
    const saved = f.stores.c.recordResult({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: "Retained prior result",
        review: {
          decisions: [{ attribution: "Lead", text: "Retained prior decision" }],
        },
      },
    });
    const result = saved.result;
    const originalSource = f.db
      .prepare("SELECT recordJson FROM task_review_sources WHERE taskId=?")
      .get(f.taskId)?.recordJson;
    const originalReview = f.db
      .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
      .get(result.resultId)?.recordJson;
    f.db.exec("DELETE FROM task_review_search");
    f.stores.c.migrate();
    assert.equal(
      f.db
        .prepare("SELECT recordJson FROM task_review_sources WHERE taskId=?")
        .get(f.taskId)?.recordJson,
      originalSource,
    );
    assert.equal(
      f.db
        .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
        .get(result.resultId)?.recordJson,
      originalReview,
    );
    assert.equal(
      (
        await f.stores.review.search({
          query: "Retained prior",
          historical: true,
          limit: 50,
        })
      ).length,
      2,
    );
    const before = f.db
      .prepare("SELECT * FROM task_review_search ORDER BY recordId")
      .all();
    f.reopen();
    assert.deepEqual(
      f.db.prepare("SELECT * FROM task_review_search ORDER BY recordId").all(),
      before,
    );

    new GitHubSourceStore(f.db).migrate();
    f.stores.d.markImportedTask(f.taskId, "imported-node", "repo");
    f.db
      .prepare(
        "INSERT INTO github_external_issues VALUES('github.com','imported-node',?,'repo','owner/repo',7,'Observed imported title','- [ ] Observed imported body','open','[]')",
      )
      .run(f.taskId);
    f.db.exec(
      "DELETE FROM task_review_search; DELETE FROM task_review_results; DELETE FROM task_review_contexts; DELETE FROM task_review_sources",
    );
    const started = Date.now();
    f.stores.c.migrate();
    const source = f.stores.review.sources(f.taskId)[0]!;
    assert.equal(source.kind, "github");
    assert.equal(source.title, "Observed imported title");
    assert.equal(source.body, "- [ ] Observed imported body");
    assert.ok(source.createdAt >= started);
    const review = f.stores.review.result(f.taskId, result.resultId)!;
    assert.equal(review.workId, w.workId);
    assert.deepEqual(review.metadata, {
      criteria: [],
      validations: [],
      artifacts: [],
      decisions: [],
    });
    assert.equal(f.stores.review.read(f.taskId).contexts.length, 0);
    const indexed = (
      await f.stores.review.search({
        query: "Retained prior result",
        type: "result",
        historical: true,
        limit: 50,
      })
    )[0]!;
    assert.equal(indexed.recordId, result.resultId);
    assert.equal(
      indexed.createdAt,
      Number(
        f.db
          .prepare(
            "SELECT createdAt FROM coordination_results WHERE resultId=?",
          )
          .get(result.resultId)?.createdAt,
      ) * 1000,
    );
    const retained = f.db.prepare("SELECT * FROM task_review_sources").all();
    f.reopen();
    assert.deepEqual(
      f.db.prepare("SELECT * FROM task_review_sources").all(),
      retained,
    );
    f.db.exec(
      "DELETE FROM task_review_search; DELETE FROM task_review_sources; DELETE FROM github_external_issues",
    );
    f.stores.c.migrate();
    assert.equal(f.stores.review.sources(f.taskId).length, 0);
  } finally {
    f.close();
  }
});

test("upgrade population rolls back missing source and review/index writes then retries without duplicates", () => {
  const f = fixture();
  try {
    const w = f.work();
    const result = f.stores.c.recordResult({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "PRIVATE INSTRUCTIONS hidden result" },
    }).result;
    f.db.exec(
      "DELETE FROM task_review_search; DELETE FROM task_review_results; DELETE FROM task_review_contexts; DELETE FROM task_review_sources; CREATE TRIGGER reject_upgrade BEFORE INSERT ON task_review_results BEGIN SELECT RAISE(ABORT,'injected upgrade failure'); END;",
    );
    assert.throws(() => f.stores.c.migrate(), /injected upgrade failure/);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM task_review_sources").get()?.n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM task_review_search").get()?.n,
      0,
    );
    f.db.exec("DROP TRIGGER reject_upgrade");
    f.stores.c.migrate();
    f.stores.c.migrate();
    assert.equal(f.stores.review.sources(f.taskId).length, 1);
    assert.equal(f.stores.review.read(f.taskId).results.length, 1);
    assert.equal(
      f.stores.review.result(f.taskId, result.resultId)?.metadata.sourceId,
      undefined,
    );
    assert.equal(
      f.db
        .prepare("SELECT excerpt FROM task_review_search WHERE recordId=?")
        .get(result.resultId)?.excerpt,
      "",
    );
  } finally {
    f.close();
  }
});

test("maximum bounded review callback discovers exclusions once and rejects a private later-tail field atomically", () => {
  const f = fixture();
  try {
    const w = f.work(),
      metadata = {
        validations: Array.from({ length: 128 }, (_, i) => ({
          label: `Check ${i}`,
          outcome: "passed" as const,
          scope: "Recorded scope",
          provenance: "Fixture producer",
        })),
        artifacts: Array.from({ length: 64 }, (_, i) => ({
          artifactId: randomUUID(),
          label: `Artifact ${i}`,
          role: "evidence" as const,
          revision: 1,
          availability: "unavailable" as const,
        })),
        changes: {
          files: Array.from({ length: 128 }, (_, i) => `file-${i}.ts`),
          findings: Array.from({ length: 128 }, (_, i) => ({
            finding: `Finding ${i}`,
          })),
        },
        decisions: Array.from({ length: 128 }, (_, i) => ({
          text: `Decision ${i}`,
          attribution: "Lead",
        })),
      };
    const prepare = f.db.prepare.bind(f.db);
    let discoveries = 0;
    f.db.prepare = (sql) => {
      if (
        sql.includes(
          "UNION ALL SELECT instructions FROM project_instruction_revisions",
        )
      )
        discoveries++;
      return prepare(sql);
    };
    const call = {
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Maximum recorded review", review: metadata },
    };
    const rejected = structuredClone(call);
    rejected.arguments.review.decisions[127]!.text =
      "PRIVATE INSTRUCTIONS tail";
    assert.throws(() => f.stores.c.recordResult(rejected), /excluded material/);
    assert.equal(discoveries, 1);
    assert.equal(f.stores.c.results(f.taskId).length, 0);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM task_review_artifact_ids").get()
        ?.n,
      0,
    );
    discoveries = 0;
    const result = f.stores.c.recordResult(call);
    assert.equal(discoveries, 1);
    assert.equal(f.stores.c.recordResult(call).replayed, true);
    assert.equal(discoveries, 1);
    assert.equal(
      f.stores.review.result(f.taskId, result.result.resultId)?.metadata
        .artifacts.length,
      64,
    );
  } finally {
    f.close();
  }
});

test("artifact identity migration preserves bytes, rolls back conflicting owners and uses an indexed point lookup", () => {
  const f = fixture();
  try {
    const id = randomUUID(),
      artifact = {
        artifactId: id,
        label: "Retained identity",
        role: "evidence" as const,
        revision: 1,
        availability: "unavailable" as const,
      },
      w = f.work();
    const first = f.stores.c.recordResult({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Owner one", review: { artifacts: [artifact] } },
    }).result;
    const v = f.work();
    const second = f.stores.c.recordResult({
      threadId: v.threadId,
      turnId: v.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: { summary: "Owner two", review: {} },
    }).result;
    for (let index = 0; index < 128; index++) {
      const owned = f.work();
      f.stores.c.recordResult({
        threadId: owned.threadId,
        turnId: owned.turnId,
        callId: randomUUID(),
        tool: "ensemble_report_result",
        arguments: {
          summary: `Corpus ${index}`,
          review: { artifacts: [{ ...artifact, artifactId: randomUUID() }] },
        },
      });
    }
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM task_review_artifact_ids").get()
        ?.n,
      129,
    );
    const original = f.db
      .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
      .get(second.resultId)!.recordJson as string;
    const conflict = JSON.parse(original);
    conflict.metadata.artifacts = [artifact];
    f.db
      .prepare("UPDATE task_review_results SET recordJson=? WHERE resultId=?")
      .run(JSON.stringify(conflict), second.resultId);
    f.db.exec("DELETE FROM task_review_artifact_ids");
    assert.throws(
      () => f.stores.c.migrate(),
      /Conflicting retained artifact identity/,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM task_review_artifact_ids").get()
        ?.n,
      0,
    );
    f.db
      .prepare("UPDATE task_review_results SET recordJson=? WHERE resultId=?")
      .run(original, second.resultId);
    f.stores.c.migrate();
    const rows = f.db.prepare("SELECT * FROM task_review_artifact_ids").all();
    f.reopen();
    assert.deepEqual(
      f.db.prepare("SELECT * FROM task_review_artifact_ids").all(),
      rows,
    );
    assert.equal(
      f.stores.review.artifactOwner(f.taskId, id)?.resultId,
      first.resultId,
    );
    const plan = f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT resultId,taskId FROM task_review_artifact_ids WHERE artifactId=?",
      )
      .all(id) as { detail: string }[];
    assert.ok(
      plan.some((r) =>
        /SEARCH task_review_artifact_ids USING INDEX/.test(r.detail),
      ),
    );
    assert.ok(!plan.some((r) => /SCAN/.test(r.detail)));
    console.info("artifact-identity-query-plan", JSON.stringify(plan));
    const bad = f.work();
    assert.throws(
      () =>
        f.stores.c.recordResult({
          threadId: bad.threadId,
          turnId: bad.turnId,
          callId: randomUUID(),
          tool: "ensemble_report_result",
          arguments: {
            summary: "Duplicate owner",
            review: { artifacts: [artifact] },
          },
        }),
      /already recorded/,
    );
    assert.equal(f.stores.c.results(f.taskId).length, 130);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM task_review_artifact_ids").all(),
      rows,
    );
  } finally {
    f.close();
  }
});

test("ordinary GitHub selection capture shares one fresh exclusion snapshot and rolls back a failed later index", () => {
  const f = fixture();
  try {
    const d = f.stores.d,
      sources = new GitHubSourceStore(f.db);
    sources.migrate();
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 1,
      credentialRef: "env:UI04_BATCH_GITHUB",
      selections: [
        {
          id: "batch",
          kind: "repository",
          repositoryId: "R_BATCH",
          owner: "org",
          name: "batch",
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
      projectId: f.projectId,
      selectionId: "batch",
      expectedVersion: 2,
    });
    const issues = Array.from({ length: 50 }, (_, i) => ({
      providerInstance: "github.com" as const,
      nodeId: `I_BATCH_${i}`,
      repositoryId: "R_BATCH",
      repositoryName: "org/batch",
      number: i + 1,
      title: `Batch issue ${i}`,
      body: `- [ ] batch-protected requirement ${i}`,
      state: "open" as const,
      labels: ["ready"],
      projectFields: [],
    }));
    const prepare = f.db.prepare.bind(f.db);
    let discoveries = 0;
    f.db.prepare = (sql) => {
      if (
        sql.includes(
          "UNION ALL SELECT instructions FROM project_instruction_revisions",
        )
      )
        discoveries++;
      return prepare(sql);
    };
    sources.reconcileSelection(f.projectId, "batch", {
      complete: true,
      reason: null,
      issues,
    });
    assert.equal(discoveries, 1);
    const initial = issues.map((issue) => {
      const taskId = String(sources.issue(issue.nodeId)!.taskId);
      const source = f.stores.review.sources(taskId)[0]!;
      assert.equal(source.body, issue.body);
      assert.equal(source.criteria.length, 1);
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM task_review_search WHERE sourceId=?",
          )
          .get(source.sourceId)?.n,
        1,
      );
      return { taskId, source };
    });
    discoveries = 0;
    sources.reconcileSelection(f.projectId, "batch", {
      complete: true,
      reason: null,
      issues: [...issues, issues[0]!],
    });
    assert.equal(discoveries, 1);
    for (const { taskId, source } of initial)
      assert.deepEqual(f.stores.review.sources(taskId), [source]);
    const profileId = String(d.assignment(f.assignmentId).profileId);
    d.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId,
      expectedVersion: 1,
      instructions: "batch-protected",
    });
    const changed = issues.map((issue) => ({
      ...issue,
      body: `${issue.body} changed`,
    }));
    discoveries = 0;
    sources.reconcileSelection(f.projectId, "batch", {
      complete: true,
      reason: null,
      issues: changed,
    });
    assert.equal(discoveries, 1);
    for (const { taskId, source } of initial) {
      const next = f.stores.review.sources(taskId).at(-1)!;
      assert.equal(next.body, null);
      assert.equal(next.criteriaOmittedCount, null);
      assert.deepEqual(next.criteria, []);
      assert.notEqual(next.digest, source.digest);
      assert.equal(next.revision, 2);
    }
    const counts = () =>
      [
        "tasks",
        "github_external_issues",
        "github_memberships",
        "task_review_sources",
        "task_review_search",
      ].map(
        (name) => f.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n,
      );
    const before = counts();
    f.db.exec(
      "CREATE TEMP TRIGGER reject_late_source BEFORE INSERT ON task_review_search WHEN NEW.excerpt LIKE '%late-index-failure%' BEGIN SELECT RAISE(ABORT,'late-index-failure'); END",
    );
    const later = issues.slice(0, 3).map((issue, i) => ({
      ...issue,
      nodeId: `I_NEW_${i}`,
      title: i === 2 ? "late-index-failure" : "New retained source",
      body: "- [ ] Safe new criterion",
    }));
    assert.throws(
      () =>
        sources.reconcileSelection(f.projectId, "batch", {
          complete: false,
          reason: "fixture-partial",
          issues: later,
        }),
      /late-index-failure/,
    );
    assert.deepEqual(counts(), before);
    assert.equal(sources.issue("I_NEW_0"), undefined);
    f.db.exec("DROP TRIGGER reject_late_source");
    sources.reconcileSelection(f.projectId, "batch", {
      complete: false,
      reason: "fixture-partial",
      issues: later,
    });
    for (const issue of later)
      assert.equal(
        f.stores.review.sources(String(sources.issue(issue.nodeId)!.taskId))
          .length,
        1,
      );
    discoveries = 0;
    f.stores.review.captureSource(f.taskId);
    assert.equal(discoveries, 1);
    discoveries = 0;
    assert.deepEqual(f.stores.review.captureSources([]), []);
    assert.equal(discoveries, 0);
  } finally {
    f.close();
  }
});
