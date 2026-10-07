import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { ConversationHistoryStore } from "../src/standalone/conversation-history.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import {
  seedRetainedReviewWindow,
  seedReviewTask,
} from "./fixtures/task-review.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
  "base64",
);
test("exact historical review pins retained source/context and serves decisions/artifacts outside bounded recent windows", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const artifactId = randomUUID();
  const a = await seedRetainedReviewWindow(f, [
    {
      artifactId,
      label: "Ancient artifact",
      role: "evidence",
      revision: 1,
      availability: "available",
      file: {
        relativePath: "ancient.png",
        size: png.length,
        mime: "image/png",
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    },
  ]);
  const workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "ancient.png"), png);
  const store = f.service.taskReview(),
    recent = store.read(a.taskId),
    api = new OperatorApi(f.service, [f.directory]);
  assert.equal(recent.results.length, 128);
  assert.equal(recent.sources.length, 128);
  assert.equal(recent.contexts.length, 256);
  assert.ok(!recent.results.some((r) => r.resultId === a.old.resultId));
  assert.ok(!recent.sources.some((s) => s.sourceId === a.source.sourceId));
  assert.ok(!recent.contexts.some((c) => c.workId === a.old.workId));
  const read = await api.readTask(a.taskId, {
    resultId: a.old.resultId,
    sourceId: a.source.sourceId,
  });
  assert.ok(read.data.review);
  assert.equal(read.data.review.results.length, 128);
  assert.equal(read.data.review.sources.length, 128);
  assert.equal(read.data.review.contexts.length, 256);
  assert.equal(read.data.review.results[0]?.resultId, a.old.resultId);
  assert.equal(read.data.review.sources[0]?.sourceId, a.source.sourceId);
  assert.equal(
    read.data.review.sources.at(-1)?.sourceId,
    recent.sources.at(-1)?.sourceId,
  );
  assert.ok(
    read.data.review.contexts.some(
      (c) => c.workId === a.old.workId && c.sourceId === a.source.sourceId,
    ),
  );
  assert.equal(
    (await api.readReview(a.taskId, { resultId: a.old.resultId })).data
      .results[0]?.metadata.decisions[0]?.text,
    "Ancient decision evidence",
  );
  const matches = (
    await api.readSearch(
      new URLSearchParams({
        query: "Ancient decision",
        type: "decision",
        historical: "true",
      }),
    )
  ).data.matches;
  assert.equal(matches[0]?.recordId, `${a.old.resultId}:decision:0`);
  assert.deepEqual((await api.readArtifact(a.taskId, artifactId)).body, png);
  const reference = {
    resultId: a.old.resultId,
    sourceId: a.source.sourceId,
    criterionId: a.source.criteria[0]!.criterionId,
    artifactId,
    workId: a.old.workId,
  };
  assert.deepEqual(store.validateReference(a.taskId, reference), reference);
  store.recordViewed(a.taskId, randomUUID(), a.source.sourceId, [
    a.old.resultId,
  ]);
  assert.equal(store.read(a.taskId).viewed?.sourceId, a.source.sourceId);
  assert.throws(
    () =>
      store.validateReference(a.taskId, {
        ...reference,
        sourceId: recent.sources.at(-1)!.sourceId,
      }),
    /does not match/,
  );
  const foreign = await seedReviewTask(f, "Foreign");
  await assert.rejects(
    api.readTask(foreign.taskId, { resultId: a.old.resultId }),
  );
  await assert.rejects(
    api.readReview(foreign.taskId, { sourceId: a.source.sourceId }),
  );
  await assert.rejects(api.readArtifact(foreign.taskId, artifactId));
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: 1,
    instructions: "Ancient",
  });
  const privateRead = await api.readReview(a.taskId, {
    resultId: a.old.resultId,
  });
  assert.ok(!JSON.stringify(privateRead).includes("Ancient decision evidence"));
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({
          query: "Ancient decision",
          type: "decision",
          historical: "true",
        }),
      )
    ).data.matches.length,
    0,
  );
  await assert.rejects(api.readArtifact(a.taskId, artifactId));
});
test("omission cursor reaches all retained turns independently with zero/one item and unequal sequence ranges", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedRetainedReviewWindow(f),
    api = new OperatorApi(f.service, [f.directory]);
  const recent = await api.readAssignmentHistory(a.assignmentId);
  assert.equal(recent.data.items.length, 0);
  assert.equal(recent.data.turnOmissions.length, 200);
  assert.equal(recent.data.omittedTurnCount, 71);
  const earlier = await api.readAssignmentHistory(
    a.assignmentId,
    undefined,
    recent.data.turnOmissions[0]!.sequence,
  );
  assert.equal(earlier.data.turnOmissions.length, 71);
  assert.equal(earlier.data.omittedTurnCount, 0);
  assert.equal(
    new Set(
      [...earlier.data.turnOmissions, ...recent.data.turnOmissions].map(
        (o) => o.workId,
      ),
    ).size,
    271,
  );
  const first = a.results[0]!;
  f.seedPersistedState((db) =>
    new ConversationHistoryStore(db).record(
      {
        taskId: a.taskId,
        assignmentId: a.assignmentId,
        workId: first.workId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: 1,
        threadId: first.workId,
        turnId: first.workId,
      },
      {
        kind: "completed",
        itemId: "single-item",
        text: "Only retained item",
        threadId: first.workId,
        turnId: first.workId,
      },
      [],
    ),
  );
  const one = await api.readAssignmentHistory(a.assignmentId);
  assert.equal(one.data.items.length, 1);
  assert.equal(one.data.omittedTurnCount, 71);
  const withItemCursor = await api.readAssignmentHistory(
    a.assignmentId,
    one.data.items[0]!.sequence,
  );
  assert.equal(withItemCursor.data.items.length, 0);
  assert.equal(withItemCursor.data.turnOmissions.length, 200);
  const withOmissionCursor = await api.readAssignmentHistory(
    a.assignmentId,
    undefined,
    one.data.turnOmissions[0]!.sequence,
  );
  assert.equal(withOmissionCursor.data.items.length, 1);
  assert.equal(withOmissionCursor.data.turnOmissions.length, 71);
  await assert.rejects(api.readAssignmentHistory(a.assignmentId, undefined, 0));
});
