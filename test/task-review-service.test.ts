import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, symlink, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
import { ExecutionState } from "../src/standalone/state.js";
import { CoordinationStore } from "../src/core/coordination.js";
import {
  previewRecordedArtifact,
  type PreviewBinding,
} from "../src/standalone/task-review.js";
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Production fixture did not reach expected state");
}
test("production service creates source, assignment and work captures, and real bound report callback persists attributable metadata", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "PRIVATE UI04 instructions",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Production review",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Supplied requirement",
    outcome: Array.from(
      { length: 130 },
      (_, i) => `- [ ] Requirement ${i + 1}`,
    ).join("\n"),
    ready: false,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => f.runtime.turns === 1);
  await until(() => f.service.list().some((w) => w.state === "running"));
  const w = f.service.list().find((w) => w.state === "running");
  assert.ok(w?.threadId && w.turnId);
  const prepared = f.runtime.prompts[0]
    ?.split("\n")
    .find((line) => line.startsWith("Captured review references (JSON): "));
  assert.ok(prepared);
  const references = JSON.parse(
    prepared.slice("Captured review references (JSON): ".length),
  );
  const source = f.service.taskReview().source(taskId, references.sourceId);
  assert.ok(source);
  assert.equal(source.criteria.length, 128);
  assert.equal(source.criteriaOmittedCount, 2);
  assert.equal(references.criteriaOmittedCount, 2);
  assert.ok(source.body?.includes("Requirement 130"));
  assert.equal(
    references.criteria[0].criterionId,
    source.criteria[0]?.criterionId,
  );
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    expectedVersion: Number(d.task(taskId).version),
    outcome: "- [ ] New scope after preparation",
  });
  assert.notEqual(
    f.service.taskReview().sources(taskId).at(-1)?.sourceId,
    references.sourceId,
  );
  const newer = f.service.taskReview().sources(taskId).at(-1)!;
  const rejectedSource = await f.runtime.callTool({
    threadId: w.threadId,
    turnId: w.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Wrong source",
      review: { sourceId: newer.sourceId },
    },
  });
  assert.equal(rejectedSource.success, false);
  assert.equal(f.service.coordinationView().readTask(taskId).results.length, 0);
  assert.equal(
    f.service.list().find((item) => item.workId === w.workId)?.state,
    "running",
  );
  for (const reference of ["data:text/html,unsafe", "custom://unsafe"]) {
    const invalid = await f.runtime.callTool({
      threadId: w.threadId,
      turnId: w.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: "Rejected reference",
        review: { changes: { reference } },
      },
    });
    assert.equal(invalid.success, false);
    assert.equal(
      f.service.coordinationView().readTask(taskId).results.length,
      0,
    );
    assert.equal(f.service.taskReview().read(taskId).results.length, 0);
    assert.equal(
      f.service.list().find((item) => item.workId === w.workId)?.state,
      "running",
    );
  }
  const futureArtifactId = randomUUID(),
    existingArtifactId = randomUUID();
  const prior = await seedReviewTask(
    f,
    "Prior artifact identifiers",
    "Unrelated retained task",
  );
  prior.result("Unrelated identifiers", {
    decisions: [{ text: futureArtifactId, attribution: "Task lead" }],
    artifacts: [
      {
        artifactId: existingArtifactId,
        label: "Already recorded",
        role: "evidence",
        revision: 1,
        availability: "unavailable",
      },
    ],
  });
  const call = {
    threadId: w.threadId,
    turnId: w.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Restored focus",
      review: {
        sourceId: references.sourceId,
        artifacts: [
          {
            artifactId: futureArtifactId,
            label: "New exact field identity",
            role: "evidence" as const,
            revision: 1,
            availability: "unavailable" as const,
          },
        ],
        changes: { reference: "https://example.com/recorded" },
        criteria: [
          {
            criterionId: references.criteria[0].criterionId,
            outcome: "failed",
            scope: "Literal original checklist only",
            provenance: "Agent supplied browser assertion",
          },
        ],
        validations: [
          {
            label: "Focus return",
            outcome: "failed",
            scope: "Desktop fixture",
            provenance: "Agent supplied assertion",
          },
        ],
        decisions: [
          {
            text: "Retain the exact historical result",
            attribution: "Task lead",
          },
        ],
      },
    },
  };
  const duplicate = structuredClone(call);
  duplicate.callId = randomUUID();
  duplicate.arguments.review.criteria.push({
    ...duplicate.arguments.review.criteria[0]!,
    outcome: "failed",
  });
  const rejected = await f.runtime.callTool(duplicate);
  assert.equal(rejected.success, false);
  assert.equal(f.service.coordinationView().readTask(taskId).results.length, 0);
  assert.equal(f.service.taskReview().read(taskId).results.length, 0);
  assert.equal(
    f.service.list().find((entry) => entry.workId === w.workId)?.state,
    "running",
  );
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId,
    expectedVersion: Number(d.profile(profileId).version),
    instructions: "failed",
  });
  const privateReviews = [
    {
      ...call.arguments.review,
      criteria: [{ ...call.arguments.review.criteria[0], scope: "failed" }],
    },
    {
      ...call.arguments.review,
      validations: [
        { ...call.arguments.review.validations[0], label: "failed" },
      ],
    },
    {
      ...call.arguments.review,
      decisions: [{ text: "failed", attribution: "Task lead" }],
    },
    {
      ...call.arguments.review,
      artifacts: [
        {
          artifactId: randomUUID(),
          label: "Safe label",
          role: "evidence",
          revision: 1,
          availability: "available",
          url: "https://failed.example/evidence",
        },
      ],
    },
    {
      ...call.arguments.review,
      artifacts: [
        {
          artifactId: randomUUID(),
          label: "Safe label",
          role: "evidence",
          revision: 1,
          availability: "available",
          file: {
            relativePath: "failed.png",
            sha256: "a".repeat(64),
            mime: "image/png",
            size: 8,
          },
        },
      ],
    },
    {
      ...call.arguments.review,
      changes: { files: ["failed.ts"], commits: [] },
    },
    {
      ...call.arguments.review,
      changes: {
        files: [],
        commits: [],
        reference: "https://failed.example/diff",
      },
    },
    {
      ...call.arguments.review,
      decisions: [
        { text: "secret=private-callback-token", attribution: "Task lead" },
      ],
    },
  ];
  for (const review of privateReviews) {
    assert.equal(
      (
        await f.runtime.callTool({
          ...call,
          callId: randomUUID(),
          arguments: { ...call.arguments, review },
        })
      ).success,
      false,
    );
    assert.equal(
      f.service.coordinationView().readTask(taskId).results.length,
      0,
    );
    assert.equal(f.service.taskReview().read(taskId).results.length, 0);
    assert.equal(
      f.service.list().find((entry) => entry.workId === w.workId)?.state,
      "running",
    );
  }
  const realDuplicate = structuredClone(call);
  realDuplicate.callId = randomUUID();
  realDuplicate.arguments.review.artifacts[0]!.artifactId = existingArtifactId;
  assert.equal((await f.runtime.callTool(realDuplicate)).success, false);
  f.seedPersistedState((db) =>
    assert.equal(
      new CoordinationStore(db, d).receipt(realDuplicate),
      undefined,
    ),
  );
  assert.equal(f.service.coordinationView().readTask(taskId).results.length, 0);
  assert.equal(f.service.taskReview().read(taskId).results.length, 0);
  assert.equal(
    f.service.list().find((entry) => entry.workId === w.workId)?.state,
    "running",
  );
  const result = await f.runtime.callTool(call);
  assert.equal(result.success, true, result.text);
  assert.equal((await f.runtime.callTool(call)).success, true);
  const read = f.service.taskReview().read(taskId);
  assert.equal(read.results.length, 1);
  assert.equal(
    read.results[0]?.metadata.artifacts[0]?.artifactId,
    futureArtifactId,
  );
  assert.ok(read.contexts.some((c) => c.workId === w.workId));
  assert.equal(read.results[0]?.workId, w.workId);
  assert.ok(!JSON.stringify(read).includes("PRIVATE UI04 instructions"));
  assert.equal(read.results[0]?.metadata.criteria[0]?.outcome, "failed");
  assert.equal(read.results[0]?.metadata.validations[0]?.outcome, "failed");
  assert.equal(f.service.coordinationView().readTask(taskId).results.length, 1);
  f.runtime.complete(1);
  await until(
    () =>
      f.service.list().find((entry) => entry.workId === w.workId)?.state ===
      "completed",
  );
});
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
async function previewFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "ui04-preview-")),
    path = join(workspace, "capture.png");
  await writeFile(path, png);
  const b: PreviewBinding = {
    workspace,
    identity: "task/source/result/work/revision",
    artifact: {
      artifactId: randomUUID(),
      label: "Recorded capture",
      role: "before",
      revision: 1,
      availability: "available",
      file: {
        relativePath: "capture.png",
        sha256: createHash("sha256").update(png).digest("hex"),
        mime: "image/png",
        size: png.length,
      },
    },
  };
  return {
    workspace,
    path,
    b,
    close: () => rm(workspace, { recursive: true, force: true }),
  };
}
test("recorded PNG preview reads correct bytes and rejects symlinks, unsupported magic, size/hash mismatch and traversal", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  assert.deepEqual((await previewRecordedArtifact(async () => f.b)).body, png);
  await symlink(f.path, join(f.workspace, "link.png"));
  await assert.rejects(
    previewRecordedArtifact(async () => ({
      ...f.b,
      artifact: {
        ...f.b.artifact,
        file: { ...f.b.artifact.file!, relativePath: "link.png" },
      },
    })),
  );
  await assert.rejects(
    previewRecordedArtifact(async () => ({
      ...f.b,
      artifact: {
        ...f.b.artifact,
        file: { ...f.b.artifact.file!, relativePath: "../outside.png" },
      },
    })),
  );
  await assert.rejects(
    previewRecordedArtifact(async () => ({
      ...f.b,
      artifact: {
        ...f.b.artifact,
        file: { ...f.b.artifact.file!, size: 5000001 },
      },
    })),
  );
  await writeFile(f.path, Buffer.alloc(png.length));
  await assert.rejects(
    previewRecordedArtifact(async () => f.b),
    /mismatch/,
  );
});
test("path replacement and recorded revision/redaction changes during delayed open cannot leak substituted bytes", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  await assert.rejects(
    previewRecordedArtifact(
      async () => f.b,
      async () => {
        await rename(f.path, join(f.workspace, "old.png"));
        await writeFile(f.path, png);
      },
    ),
    /mismatch/,
  );
  await assert.rejects(
    previewRecordedArtifact(
      async () => f.b,
      async () => {
        f.b.artifact = { ...f.b.artifact, availability: "redacted" };
      },
    ),
    /mismatch/,
  );
});
test("current binding revocation or workspace replacement during async preview fails closed", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  let current: PreviewBinding | undefined = f.b;
  await assert.rejects(
    previewRecordedArtifact(
      async () => current,
      async () => {
        current = undefined;
      },
    ),
    /mismatch/,
  );
  current = f.b;
  await assert.rejects(
    previewRecordedArtifact(
      async () => current,
      async () => {
        current = { ...f.b, identity: "new-revision" };
      },
    ),
    /mismatch/,
  );
});
test("bound workspace alias retarget and file growth while open fail closed within the read cap", async (t) => {
  const f = await previewFixture(),
    other = await previewFixture(),
    alias = join(f.workspace, "alias");
  t.after(f.close);
  t.after(other.close);
  await symlink(f.workspace, alias);
  let current = { ...f.b, workspace: alias };
  await assert.rejects(
    previewRecordedArtifact(
      async () => current,
      async () => {
        await rm(alias);
        await symlink(other.workspace, alias);
      },
    ),
    /mismatch/,
  );
  current = f.b;
  await assert.rejects(
    previewRecordedArtifact(
      async () => current,
      async () => {
        await writeFile(f.path, Buffer.alloc(6000000));
      },
    ),
    /mismatch/,
  );
});

test("never-admitted same work rebind retains provisional captures but prompt and structured/unstructured result reads use exact bound version", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  for (const structured of [true, false]) {
    const task = await seedReviewTask(
      f,
      `Version ${structured}`,
      "Versioned task",
      "- [ ] Original version scope",
    );
    const d = f.service.domain(),
      workspace = await f.service.taskWorkspace(task.taskId);
    assert.ok(workspace);
    const workId = `assignment:${task.assignmentId}:initial`,
      assignment = d.assignment(task.assignmentId);
    f.seedPersistedState((db) => {
      const state = new ExecutionState(db);
      state.create(workId, String(assignment.brief), workspace.path);
      state.bindTask(workId, {
        taskId: task.taskId,
        assignmentId: task.assignmentId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
      });
    });
    const old = f.service
      .taskReview()
      .contextForWork(task.taskId, task.assignmentId, workId, 1)!;
    assert.equal(old.sourceId, task.source.sourceId);
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      outcome: "- [ ] New version scope",
    });
    d.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId: task.profileId,
      expectedVersion: 1,
      instructions: "New bound instructions",
    });
    d.execute({
      type: "assignment.apply",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      assignmentId: task.assignmentId,
      expectedVersion: 1,
    });
    f.seedPersistedState((db) =>
      new ExecutionState(db).bindTask(workId, {
        taskId: task.taskId,
        assignmentId: task.assignmentId,
        assignmentVersion: 2,
        instructionsRevision: 1,
        profileRevision: 2,
      }),
    );
    const current = f.service
      .taskReview()
      .contextForWork(task.taskId, task.assignmentId, workId, 2)!;
    assert.notEqual(current.captureId, old.captureId);
    assert.notEqual(current.sourceId, old.sourceId);
    assert.equal(
      f.service
        .taskReview()
        .contextForWork(task.taskId, task.assignmentId, workId, 1)?.captureId,
      old.captureId,
    );
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      expectedVersion: Number(d.project(task.projectId).version),
      paused: false,
    });
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      ready: true,
    });
    await until(() =>
      f.service
        .list()
        .some((w) => w.workId === workId && w.state === "running"),
    );
    const work = f.service.list().find((w) => w.workId === workId)!;
    assert.ok(work.threadId && work.turnId);
    const prompt = f.runtime.prompts.at(-1)!;
    assert.ok(prompt.includes("New bound instructions"));
    const line = prompt
      .split("\n")
      .find((l) => l.startsWith("Captured review references (JSON): "))!;
    assert.ok(line);
    assert.equal(
      JSON.parse(line.slice("Captured review references (JSON): ".length))
        .sourceId,
      current.sourceId,
    );
    const wrong = await f.runtime.callTool({
      threadId: work.threadId,
      turnId: work.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: "Wrong provisional source",
        review: { sourceId: old.sourceId! },
      },
    });
    assert.equal(wrong.success, false);
    assert.equal(
      f.service.coordinationView().readTask(task.taskId).results.length,
      0,
    );
    const call = {
      threadId: work.threadId,
      turnId: work.turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: "Version bound result",
        ...(structured ? { review: { sourceId: current.sourceId! } } : {}),
      },
    };
    const first = await f.runtime.callTool(call);
    assert.equal(first.success, true);
    assert.deepEqual(await f.runtime.callTool(call), first);
    const result = f.service.coordinationView().readTask(task.taskId)
      .results[0]!;
    assert.equal(result.assignmentVersion, 2);
    d.execute({
      type: "assignment.apply",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      assignmentId: task.assignmentId,
      expectedVersion: 2,
    });
    const read = f.service
      .taskReview()
      .read(task.taskId, { resultId: result.resultId });
    assert.ok(read.contexts.some((c) => c.captureId === current.captureId));
    assert.ok(read.contexts.some((c) => c.captureId === old.captureId));
    assert.equal(
      read.contexts.find((c) => c.captureId === current.captureId)
        ?.assignmentVersion,
      2,
    );
    assert.equal(
      f.service
        .taskReview()
        .contextForWork(task.taskId, task.assignmentId, workId, 2)?.sourceId,
      current.sourceId,
    );
    f.runtime.complete(f.runtime.turns);
    await until(
      () =>
        f.service.list().find((w) => w.workId === workId)?.state ===
        "completed",
    );
  }
});
