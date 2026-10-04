import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
test("curated review API retains historical identities and delivery/context gaps, strips private file paths and explicit viewing survives refresh", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  const r = task.result("Original result", {
    sourceId: task.source.sourceId,
    criteria: [
      {
        criterionId: task.source.criteria[0]!.criterionId,
        outcome: "failed",
        scope: "Original scope",
        provenance: "Agent supplied",
      },
    ],
  });
  const api = new OperatorApi(f.service, [f.directory]);
  let read = await api.readTask(task.taskId);
  assert.equal(read.data.review?.results[0]?.resultId, r.resultId);
  assert.equal(read.data.delivery?.binding, null);
  assert.equal(read.data.review?.viewed, null);
  const c = {
    type: "review.view",
    key: randomUUID(),
    taskId: task.taskId,
    sourceId: task.source.sourceId,
    resultIds: [r.resultId],
  };
  const receipt = await api.execute(c);
  assert.equal(receipt.kind, "review");
  const baseline = f.service.taskReview().read(task.taskId).viewed;
  read = await api.readTask(task.taskId);
  assert.deepEqual(read.data.review?.viewed, baseline);
  assert.deepEqual(await api.execute(c), receipt);
  assert.equal(f.service.domain().task(task.taskId).state, "open");
  assert.equal(f.runtime.turns, 0);
  assert.ok(!JSON.stringify(read).includes("PRIVATE REVIEW INSTRUCTIONS"));
  await assert.rejects(
    api.execute({ ...c, key: randomUUID(), resultIds: [randomUUID()] }),
  );
});
test("artifact API resolves only recorded task-owned regular PNG and rejects foreign/redacted IDs without returning local paths", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f),
    workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    artifactId = randomUUID();
  await writeFile(join(workspace.path, "capture.png"), bytes);
  task.result("Capture result", {
    sourceId: task.source.sourceId,
    artifacts: [
      {
        artifactId,
        label: "Original capture",
        role: "evidence",
        revision: 1,
        availability: "available",
        file: {
          relativePath: "capture.png",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mime: "image/png",
          size: bytes.length,
        },
      },
    ],
  });
  const api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(
    (await api.readArtifact(task.taskId, artifactId)).body,
    bytes,
  );
  const read = await api.readTask(task.taskId);
  assert.ok(!JSON.stringify(read).includes("capture.png"));
  assert.ok(!JSON.stringify(read).includes(workspace.path));
  await assert.rejects(api.readArtifact(task.taskId, randomUUID()));
  const other = await seedReviewTask(f, "Other");
  await assert.rejects(api.readArtifact(other.taskId, artifactId));
});
test("retained history pages earlier records in stable sequence order without manufacturing missing text", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f),
    r = task.result("History result");
  f.seedPersistedState((db) => {
    for (let index = 0; index < 250; index++)
      db.prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      ).run(
        r.workId,
        task.taskId,
        task.assignmentId,
        r.workId,
        r.workId,
        `item-${index}`,
        `Literal retained update ${index}`,
      );
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const recent = await api.readAssignmentHistory(task.assignmentId);
  assert.equal(recent.data.items.length, 200);
  assert.equal(recent.data.omittedItemCount, 50);
  const earlier = await api.readAssignmentHistory(
    task.assignmentId,
    recent.data.items[0]!.sequence,
  );
  assert.equal(earlier.data.items.length, 50);
  assert.equal(earlier.data.omittedItemCount, 0);
  assert.ok(
    earlier.data.items.at(-1)!.sequence < recent.data.items[0]!.sequence,
  );
  assert.equal(earlier.data.items[0]?.text, "Literal retained update 0");
});

test("exact review and paginated history fail closed when visibility/material revisions change during awaited exclusions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  task.result("Retained result");
  const api = new OperatorApi(f.service, [f.directory]);
  for (const kind of ["review", "history"]) {
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((r) => (release = r)),
      entry = new Promise<void>((r) => (entered = r)),
      original = f.service.taskWorkspace.bind(f.service);
    f.service.taskWorkspace = async (id) => {
      entered();
      await pending;
      return original(id);
    };
    const read =
      kind === "review"
        ? api.readReview(task.taskId)
        : api.readAssignmentHistory(task.assignmentId, 999);
    await entry;
    const profile = f.service.domain().profile(task.profileId);
    f.service.domain().execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId: task.profileId,
      expectedVersion: Number(profile.version),
      instructions: `Changed private ${kind} instructions`,
    });
    release();
    await assert.rejects(read, /unavailable/);
    f.service.taskWorkspace = original;
  }
});

test("review projection redacts supplied prose while preserving outcome enums and immutable structural identities", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  const r = task.result("Result", {
    sourceId: task.source.sourceId,
    criteria: [
      {
        criterionId: task.source.criteria[0]!.criterionId,
        outcome: "failed",
        scope: "failed private scope",
        provenance: "failed supplied evidence",
      },
    ],
    validations: [
      {
        label: "failed check",
        outcome: "failed",
        scope: "failed scope",
        provenance: "failed evidence",
        checkedHead: "f".repeat(40),
      },
    ],
  });
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: task.profileId,
    expectedVersion: Number(f.service.domain().profile(task.profileId).version),
    instructions: "failed",
  });
  const read = await new OperatorApi(f.service, [f.directory]).readTask(
    task.taskId,
  );
  const record = read.data.review?.results.find(
    (v) => v.resultId === r.resultId,
  );
  assert.equal(record?.metadata.sourceId, task.source.sourceId);
  assert.equal(
    record?.metadata.criteria[0]?.criterionId,
    task.source.criteria[0]!.criterionId,
  );
  assert.equal(record?.metadata.criteria[0]?.outcome, "failed");
  assert.equal(record?.metadata.validations[0]?.outcome, "failed");
  assert.equal(record?.metadata.validations[0]?.checkedHead, "f".repeat(40));
  assert.ok(!record?.metadata.criteria[0]?.scope.includes("failed"));
  assert.ok(!record?.metadata.validations[0]?.label.includes("failed"));
});

test("ordinary GitHub observation identity survives changed redaction exclusions while current prose stays private", async (t) => {
  const issue = {
    providerInstance: "github.com" as const,
    nodeId: "I_STABLE",
    repositoryId: "R1",
    repositoryName: "org/repo",
    number: 1,
    title: "Stable source",
    body: "- [ ] failed behavior\nsecret=private-credential",
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  };
  const f = await createOperatorFixture(null, () => ({
    async readSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  }));
  t.after(() => f.close());
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
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
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
  const taskId = String(f.service.githubSources().issue(issue.nodeId)?.taskId),
    source = f.service.taskReview().sources(taskId).at(-1)!;
  assert.ok(!source.body?.includes("private-credential"));
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
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: w.threadId,
        turnId: w.turnId,
        callId: randomUUID(),
        tool: "ensemble_report_result",
        arguments: {
          summary: "Stable retained result",
          review: {
            sourceId: source.sourceId,
            criteria: [
              {
                criterionId: source.criteria[0]!.criterionId,
                outcome: "failed",
                scope: "failed scope",
                provenance: "Supplied evidence",
              },
            ],
          },
        },
      })
    ).success,
    true,
  );
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(d.profile(a.profileId).version),
    instructions: "failed",
  });
  await f.service.refreshGitHub();
  assert.deepEqual(f.service.taskReview().sources(taskId), [source]);
  const api = new OperatorApi(f.service, [f.directory]),
    read = await api.readTask(taskId);
  assert.equal(read.data.review?.sources[0]?.sourceId, source.sourceId);
  assert.equal(
    read.data.review?.sources[0]?.criteria[0]?.criterionId,
    source.criteria[0]?.criterionId,
  );
  assert.ok(!JSON.stringify(read.data.review?.sources).includes("failed"));
  assert.equal(
    read.data.review?.results[0]?.metadata.sourceId,
    source.sourceId,
  );
  assert.equal(
    read.data.review?.results[0]?.metadata.criteria[0]?.outcome,
    "failed",
  );
  issue.body += "\n- [ ] Actually changed";
  await f.service.refreshGitHub();
  assert.equal(f.service.taskReview().sources(taskId).length, 2);
  assert.notEqual(
    f.service.taskReview().sources(taskId).at(-1)?.sourceId,
    source.sourceId,
  );
  assert.ok(
    !JSON.stringify(f.service.taskReview().sources(taskId)).includes(
      "private-credential",
    ),
  );
});

test("recorded change references preserve supported web links and keep legacy unsupported material readable without a link", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  const api = new OperatorApi(f.service, [f.directory]);
  for (const reference of [
    "http://example.com/record",
    "https://example.com/record",
  ]) {
    const result = task.result("Web reference", {
      changes: { reference, files: [], commits: [], findings: [] },
    });
    assert.equal(
      (
        await api.readReview(task.taskId, { resultId: result.resultId })
      ).data.results.find((r) => r.resultId === result.resultId)?.metadata
        .changes?.reference,
      reference,
    );
  }
  const old = task.result("Legacy material", {
    changes: {
      reference: "https://example.com/legacy",
      files: ["retained.ts"],
      commits: [],
      findings: [],
    },
  });
  for (const reference of ["data:text/html,unsafe", "custom://unsafe"]) {
    f.seedPersistedState((db) => {
      const row = db
        .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
        .get(old.resultId) as { recordJson: string };
      const record = JSON.parse(row.recordJson);
      record.metadata.changes.reference = reference;
      db.prepare(
        "UPDATE task_review_results SET recordJson=? WHERE resultId=?",
      ).run(JSON.stringify(record), old.resultId);
    });
    for (const read of [
      (await api.readTask(task.taskId)).data.review!,
      (await api.readReview(task.taskId)).data,
    ]) {
      const changes = read.results.find((r) => r.resultId === old.resultId)
        ?.metadata.changes;
      assert.deepEqual(changes?.files, ["retained.ts"]);
      assert.equal(changes?.reference, undefined);
    }
  }
});
