import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, symlink, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createOperatorFixture } from "./fixtures/operator-web.js";
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
    outcome: "- [ ] Restore keyboard focus",
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
  const call = {
    threadId: w.threadId,
    turnId: w.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Restored focus",
      review: {
        sourceId: references.sourceId,
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
  const result = await f.runtime.callTool(call);
  assert.equal(result.success, true, result.text);
  assert.equal((await f.runtime.callTool(call)).success, true);
  const read = f.service.taskReview().read(taskId);
  assert.equal(read.results.length, 1);
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
