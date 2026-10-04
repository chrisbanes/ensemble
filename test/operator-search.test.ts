import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";
test("bounded retained search attributes same wording across projects and opens exact historical result and decision records", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f, "Alpha", "Command focus"),
    b = await seedReviewTask(f, "Beta", "Command focus");
  const r1 = a.result("Command focus original", {
    sourceId: a.source.sourceId,
    decisions: [
      { text: "Command focus remains explicit", attribution: "Task lead" },
    ],
  });
  const r2 = a.result("Command focus revised", { sourceId: a.source.sourceId });
  b.result("Command focus Beta");
  const api = new OperatorApi(f.service, [f.directory]);
  const search = await api.readSearch(
    new URLSearchParams({ query: "Command focus", historical: "true" }),
  );
  assert.equal(search.data.coverage, "retained-records-only");
  assert.ok(search.data.matches.some((m) => m.projectName === "Alpha"));
  assert.ok(search.data.matches.some((m) => m.projectName === "Beta"));
  const old = search.data.matches.find(
    (m) => m.type === "result" && m.resultId === r1.resultId,
  );
  assert.equal(old?.historical, true);
  assert.ok(old?.href.includes(`result=${r1.resultId}`));
  assert.ok(
    search.data.matches.some(
      (m) =>
        m.type === "decision" && m.recordId === `${r1.resultId}:decision:0`,
    ),
  );
  const current = await api.readSearch(
    new URLSearchParams({
      query: "Command focus",
      projectId: a.projectId,
      type: "result",
    }),
  );
  assert.deepEqual(
    current.data.matches.map((m) => m.resultId),
    [r2.resultId],
  );
  const first = await api.readSearch(
    new URLSearchParams({
      query: "Command focus",
      historical: "true",
      limit: "1",
    }),
  );
  assert.equal(first.data.matches.length, 1);
  assert.ok(first.data.nextCursor);
  const next = await api.readSearch(
    new URLSearchParams({
      query: "Command focus",
      historical: "true",
      limit: "1",
      cursor: first.data.nextCursor!,
    }),
  );
  assert.notEqual(
    first.data.matches[0]?.recordId,
    next.data.matches[0]?.recordId,
  );
  const empty = await api.readSearch(new URLSearchParams({ query: "absent" }));
  assert.equal(empty.data.matches.length, 0);
  await assert.rejects(
    api.readSearch(
      new URLSearchParams({ query: "Command", projectId: randomUUID() }),
    ),
  );
});
test("search honors type/date/history filters and current exclusions; no broad transcript or private material index", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(
    f,
    "Private",
    "Review",
    "secret=hidden\nSupplied prose criteria",
  );
  a.result("Retained safe result");
  const api = new OperatorApi(f.service, [f.directory]);
  const safe = await api.readSearch(
    new URLSearchParams({
      query: "Retained",
      type: "result",
      after: "0",
      before: String(Date.now() + 1000),
    }),
  );
  assert.equal(safe.data.matches.length, 1);
  assert.equal(
    (await api.readSearch(new URLSearchParams({ query: "hidden" }))).data
      .matches.length,
    0,
  );
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "PRIVATE REVIEW INSTRUCTIONS" }),
      )
    ).data.matches.length,
    0,
  );
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "Retained", before: "1" }),
      )
    ).data.matches.length,
    0,
  );
  await assert.rejects(
    api.readSearch(new URLSearchParams({ query: "x".repeat(257) })),
  );
});
test("actual imported state-only configure keeps GitHub source provenance; placement search filters current owning project", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    ids = [randomUUID(), randomUUID()];
  for (const projectId of ids) {
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: projectId,
      leadProfileId: null,
    });
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
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
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    f.service.githubSources().reconcileSelection(projectId, "repo", {
      complete: true,
      reason: null,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_TRANSFER",
          repositoryId: "R1",
          repositoryName: "org/repo",
          number: 1,
          title: "Transferred command focus",
          body: "GitHub supplied checklist\n- [ ] Keep focus",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
    });
  }
  const taskId = String(f.service.githubSources().issue("I_TRANSFER")?.taskId),
    original = f.service.taskReview().sources(taskId);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids[0]!,
    taskId,
    expectedVersion: Number(d.task(taskId).version),
    state: "cancelled",
  });
  assert.deepEqual(f.service.taskReview().sources(taskId), original);
  assert.equal(original[0]?.kind, "github");
  const api = new OperatorApi(f.service, [f.directory]);
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r));
  const originalWorkspace = f.service.taskWorkspace.bind(f.service);
  f.service.taskWorkspace = async (id) => {
    entered();
    await barrier;
    return originalWorkspace(id);
  };
  const delayed = api.readSearch(
    new URLSearchParams({ query: "Transferred", projectId: ids[0]! }),
  );
  await entry;
  d.execute({
    type: "github.place",
    actor: "operator",
    key: randomUUID(),
    projectId: ids[0]!,
    taskId,
    expectedVersion: Number(d.task(taskId).version),
    chosenProjectId: ids[1]!,
  });
  release();
  const stale = await delayed;
  assert.equal(stale.data.matches.length, 0);
  f.service.taskWorkspace = originalWorkspace;
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "Transferred", projectId: ids[0]! }),
      )
    ).data.matches.length,
    0,
  );
  const moved = await api.readSearch(
    new URLSearchParams({ query: "Transferred", projectId: ids[1]! }),
  );
  assert.equal(moved.data.matches[0]?.projectId, ids[1]);
  assert.equal(moved.data.matches[0]?.sourceId, original[0]?.sourceId);
  assert.equal(f.service.taskReview().sources(taskId)[0]?.projectId, ids[0]);
});

test("long source search keeps its title in a bounded excerpt and honestly excludes the unindexed tail", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const title = `Long source title marker ${"T".repeat(100)}`,
    body = `Source beginning ${"x".repeat(15900)} Unindexed tail marker`,
    a = await seedReviewTask(f, "Long source", title, body),
    store = f.service.taskReview(),
    api = new OperatorApi(f.service, [f.directory]);
  assert.equal(a.source.title, title);
  assert.equal(a.source.body, body);
  assert.equal(store.captureSource(a.taskId).sourceId, a.source.sourceId);
  const rows = store.search({
    query: "Long source title marker",
    historical: false,
    limit: 10,
  });
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]?.excerpt).length, 16000);
  assert.ok(String(rows[0]?.excerpt).startsWith(`${title}\nSource beginning`));
  const read = await api.readSearch(
    new URLSearchParams({ query: "Long source title marker" }),
  );
  assert.equal(read.data.matches.length, 1);
  assert.equal(read.data.matches[0]?.sourceId, a.source.sourceId);
  assert.equal(read.data.matches[0]?.taskTitle, title);
  assert.equal(read.data.matches[0]?.excerpt, rows[0]?.excerpt);
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "Unindexed tail marker" }),
      )
    ).data.matches.length,
    0,
  );
  assert.deepEqual(store.sources(a.taskId), [a.source]);
});

test("source search revalidates full retained prose when a later exclusion crosses the excerpt boundary", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const title = `Boundary title marker ${"T".repeat(100)}`,
    privateText = "PRIVATE CROSSING BOUNDARY PHRASE",
    body = "x".repeat(16000 - title.length - 1 - 10) + privateText + " tail",
    a = await seedReviewTask(f, "Boundary source", title, body),
    api = new OperatorApi(f.service, [f.directory]),
    params = new URLSearchParams({ query: "Boundary title marker" });
  const initial = await api.readSearch(params);
  assert.equal(initial.data.matches.length, 1);
  const excerpt = initial.data.matches[0]?.excerpt;
  assert.ok(excerpt);
  assert.ok(excerpt.endsWith(privateText.slice(0, 10)));
  assert.ok(!excerpt.includes(privateText));
  const d = f.service.domain();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(d.profile(a.profileId).version),
    instructions: privateText,
  });
  const current = await api.readSearch(params);
  assert.equal(current.data.matches.length, 0);
  assert.equal(current.data.omittedCount, 1);
  assert.equal(
    f.service.taskReview().captureSource(a.taskId).sourceId,
    a.source.sourceId,
  );
  assert.deepEqual(f.service.taskReview().sources(a.taskId), [a.source]);
  const omitted = await seedReviewTask(
    f,
    "Omitted body",
    "Separately safe title",
    "PRIVATE REVIEW INSTRUCTIONS",
  );
  assert.equal(omitted.source.body, null);
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "Separately safe title" }),
      )
    ).data.matches[0]?.sourceId,
    omitted.source.sourceId,
  );
});
