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
