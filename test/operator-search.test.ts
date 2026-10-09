import { SqliteWorkspaceBindingStore } from "../src/standalone/workspaces.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { TaskReviewStore } from "../src/core/task-review.js";
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
  f.service.taskWorkspace = async (...args) => {
    entered();
    await barrier;
    return originalWorkspace(...args);
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
  const rows = await store.search({
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
    body = `${"x".repeat(16000 - title.length - 1 - 10) + privateText} tail`,
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

test("actual report callback retains long decisions while bounded search validates exact decision identity and full current privacy", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f),
    d = f.service.domain(),
    prefix = "Long decision query marker ",
    longText = `${prefix + "x".repeat(16000 - prefix.length - 3)}ZZZ`,
    attribution = "Boundary attribution",
    privateText = "PRIVATE DECISION BOUNDARY PHRASE",
    boundaryText =
      "x".repeat(16000 - attribution.length - 2 - 10) + privateText,
    decisions = [
      { attribution: "A", text: longText },
      { attribution, text: boundaryText },
    ];
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    expectedVersion: Number(d.project(a.projectId).version),
    paused: false,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: Number(d.task(a.taskId).version),
    ready: true,
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
          summary: "Supplied decision result",
          review: { sourceId: a.source.sourceId, decisions },
        },
      })
    ).success,
    true,
  );
  const retained = f.service.taskReview().read(a.taskId).results[0];
  assert.ok(retained);
  assert.deepEqual(retained.metadata.decisions, decisions);
  const api = new OperatorApi(f.service, [f.directory]),
    params = new URLSearchParams({
      query: "Long decision query marker",
      type: "decision",
    });
  const read = await api.readSearch(params),
    match = read.data.matches[0];
  assert.equal(read.data.matches.length, 1);
  assert.equal(match?.recordId, `${retained.resultId}:decision:0`);
  assert.equal(match?.resultId, retained.resultId);
  assert.equal(match?.excerpt?.length, 16000);
  assert.ok(match?.excerpt?.startsWith("A: Long decision query marker"));
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({ query: "ZZZ", type: "decision" }),
      )
    ).data.matches.length,
    0,
  );
  const boundaryParams = new URLSearchParams({
      query: attribution,
      type: "decision",
    }),
    initial = await api.readSearch(boundaryParams),
    excerpt = initial.data.matches[0]?.excerpt;
  assert.ok(excerpt?.endsWith(privateText.slice(0, 10)));
  assert.ok(!excerpt?.includes(privateText));
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(d.profile(a.profileId).version),
    instructions: privateText,
  });
  const current = await api.readSearch(boundaryParams);
  assert.equal(current.data.matches.length, 0);
  assert.equal(current.data.omittedCount, 1);
  assert.deepEqual(f.service.taskReview().read(a.taskId).results[0], retained);
  // Corrupt index association is untrusted; the exact retained position is required.
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE task_review_search SET recordId=? WHERE recordId=?")
      .run(
        `${retained.resultId}:decision:999`,
        `${retained.resultId}:decision:0`,
      ),
  );
  assert.equal((await api.readSearch(params)).data.matches.length, 0);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE task_review_search SET recordId=?,excerpt=? WHERE recordId=?",
      )
      .run(
        `${retained.resultId}:decision:0`,
        "Long decision query marker unrelated indexed material",
        `${retained.resultId}:decision:999`,
      ),
  );
  assert.equal((await api.readSearch(params)).data.matches.length, 0);
});

test("indexed raw batches yield before sparse search completes without losing literal tails or equal-time cursors", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(
    f,
    "Batch project",
    "Batch source",
    "x".repeat(15900),
  );
  const d = f.service.domain();
  for (let i = 1; i <= 104; i++)
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      taskId: a.taskId,
      expectedVersion: Number(d.task(a.taskId).version),
      title:
        i === 70 || i === 100 ? `Literal %_\\Case ${i}` : `Batch source ${i}`,
      outcome: `${i} ${"x".repeat(15900)}`,
    });
  const store = f.service.taskReview(),
    api = new OperatorApi(f.service, [f.directory]);
  const plans: string[] = [];
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE task_review_search SET createdAt=42 WHERE taskId=?")
      .run(a.taskId),
  );
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
  });
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!sql.startsWith("WITH raw AS MATERIALIZED")) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...args: Parameters<typeof statement.all>) => {
      plans.push(
        ...originalPrepare
          .call(this, `EXPLAIN QUERY PLAN ${sql}`)
          .all(...args)
          .map((row) => String(row.detail)),
      );
      return all(...args);
    }) as typeof statement.all;
    return statement;
  };
  setImmediate(() =>
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      taskId: a.taskId,
      expectedVersion: Number(d.task(a.taskId).version),
      title: "Appending match after frontier",
      outcome: "New append source",
    }),
  );
  assert.equal(
    (
      await store.search({
        query: "Appending match",
        historical: true,
        limit: 2,
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await store.search({
        query: "Appending match",
        historical: true,
        limit: 2,
      })
    ).length,
    1,
  );
  let progressed = false;
  let unrelated: Promise<unknown> | undefined;
  setImmediate(() => {
    progressed = true;
    unrelated = api.readWorkspace();
  });
  assert.equal(
    (
      await store.search({
        query: "No retained match",
        historical: true,
        limit: 2,
      })
    ).length,
    0,
  );
  assert.equal(
    progressed,
    true,
    "unrelated event-loop work must run before a multi-batch no-match search resolves",
  );
  await unrelated;
  const literal = await store.search({
    query: "%_\\case",
    historical: true,
    limit: 1,
  });
  assert.equal(literal.length, 2);
  assert.ok(
    literal.every((row) => String(row.excerpt).includes("Literal %_\\Case")),
  );
  assert.ok(String(literal[0]!.recordId) < String(literal[1]!.recordId));
  const tail = await store.search({
    query: "%_\\case",
    historical: true,
    limit: 1,
    cursor: String(literal[0]!.recordId),
  });
  assert.deepEqual(
    tail.map((row) => row.recordId),
    [literal[1]!.recordId],
  );
  assert.deepEqual(
    await store.search({
      query: "%_\\case",
      historical: true,
      limit: 1,
      cursor: randomUUID(),
    }),
    [],
  );
  assert.equal(
    (await store.search({ query: "%_\\case", historical: false, limit: 10 }))
      .length,
    0,
  );
  assert.equal(
    (
      await store.search({
        query: "%_\\case",
        historical: true,
        limit: 10,
        after: 42,
        before: 42,
        type: "task",
        projectId: a.projectId,
      })
    ).length,
    2,
  );
  assert.equal(
    (
      await store.search({
        query: "%_\\case",
        historical: true,
        limit: 10,
        before: 41,
      })
    ).length,
    0,
  );
  assert.ok(plans.some((plan) => plan.includes("MATERIALIZE raw")));
  assert.ok(plans.some((plan) => plan.includes("task_review_search_order")));
  assert.ok(
    plans.some((plan) => plan.includes("coordination_results_task_created")),
  );
  assert.ok(
    !plans.some((plan) =>
      /SCAN coordination_results|SCAN task_review_search$/.test(plan),
    ),
  );
  const reopened = new DatabaseSync(
    join(f.directory, "data", "standalone.sqlite"),
  );
  try {
    const retained = await new TaskReviewStore(reopened).search({
      query: "%_\\case",
      historical: true,
      limit: 1,
    });
    assert.deepEqual(
      retained.map((row) => row.recordId),
      literal.map((row) => row.recordId),
    );
    assert.deepEqual(
      reopened
        .prepare("PRAGMA index_info(coordination_results_task_created)")
        .all()
        .map((row) => row.name),
      ["taskId", "createdAt"],
    );
  } finally {
    reopened.close();
  }
  let closedSearch: Promise<unknown> | undefined;
  f.seedPersistedState((db) => {
    closedSearch = new TaskReviewStore(db).search({
      query: "No retained match",
      historical: true,
      limit: 2,
    });
  });
  await assert.rejects(closedSearch!, /database.*(?:open|closed)/i);
  console.info(
    "bounded-search-query-plan",
    JSON.stringify([...new Set(plans)]),
  );
});

test("second yielding search revalidates visibility and task revisions before returning any private match", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f, "Yield privacy", "Visible retained phrase");
  a.result("Visible retained phrase result");
  const api = new OperatorApi(f.service, [f.directory]);
  const store = f.service.taskReview(),
    original = store.search.bind(store);
  const originalFactory = f.service.taskReview.bind(f.service);
  f.service.taskReview = () => store;
  t.after(() => {
    f.service.taskReview = originalFactory;
  });
  let searches = 0;
  store.search = async (input) => {
    const rows = await original(input);
    if (++searches === 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const d = f.service.domain();
      d.execute({
        type: "profile.configure",
        actor: "operator",
        key: randomUUID(),
        profileId: a.profileId,
        expectedVersion: Number(d.profile(a.profileId).version),
        instructions: "Visible retained phrase",
      });
    }
    return rows;
  };
  await assert.rejects(
    api.readSearch(
      new URLSearchParams({
        query: "Visible retained phrase",
        historical: "true",
      }),
    ),
    /unavailable/,
  );
  assert.equal(searches, 2);

  const b = await seedReviewTask(
    f,
    "Revision after await",
    "Revision scoped phrase",
  );
  b.result("Revision scoped phrase result");
  searches = 0;
  store.search = async (input) => {
    const rows = await original(input);
    if (++searches === 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const d = f.service.domain();
      d.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: b.projectId,
        taskId: b.taskId,
        expectedVersion: Number(d.task(b.taskId).version),
        ready: true,
      });
    }
    return rows;
  };
  const changed = await api.readSearch(
    new URLSearchParams({
      query: "Revision scoped phrase",
      historical: "true",
    }),
  );
  assert.equal(changed.data.matches.length, 0);
  assert.equal(searches, 2);

  const c = await seedReviewTask(
    f,
    "Latest after await",
    "Current result phrase",
  );
  c.result("Current result phrase");
  const version = f.service.domain().task(c.taskId).version;
  searches = 0;
  store.search = async (input) => {
    const rows = await original(input);
    if (++searches === 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      c.result("Newer unrelated result");
    }
    return rows;
  };
  const superseded = await api.readSearch(
    new URLSearchParams({
      query: "Current result phrase",
      type: "result",
      historical: "false",
    }),
  );
  assert.equal(f.service.domain().task(c.taskId).version, version);
  assert.equal(superseded.data.matches.length, 0);
  assert.equal(searches, 2);

  const h = await seedReviewTask(
    f,
    "Historical label after await",
    "Historical label phrase",
  );
  const old = h.result("Historical label phrase");
  const historicalVersion = f.service.domain().task(h.taskId).version;
  searches = 0;
  store.search = async (input) => {
    const rows = await original(input);
    if (++searches === 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      h.result("Newer unrelated historical result");
    }
    return rows;
  };
  const retained = await api.readSearch(
    new URLSearchParams({
      query: "Historical label phrase",
      type: "result",
      historical: "true",
    }),
  );
  assert.equal(f.service.domain().task(h.taskId).version, historicalVersion);
  assert.equal(retained.data.matches.length, 1);
  assert.equal(retained.data.matches[0]?.resultId, old.resultId);
  assert.equal(retained.data.matches[0]?.historical, true);
  assert.equal(searches, 2);
});

test("held actual Search GET rechecks its exact session after logout and emits no retained payload", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f, "Session scope", "Session private result");
  a.result("Session private result");
  const web = await f.startWeb();
  const anonymous = await fetch(`${web.origin}/api/operator/session`),
    anon = (await anonymous.json()) as { csrfToken: string };
  const cookie = anonymous.headers.get("set-cookie")!.split(";")[0]!;
  const login = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(login.status, 200);
  const session = (await login.json()) as { csrfToken: string };
  const authenticatedCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const store = f.service.taskReview(),
    factory = f.service.taskReview.bind(f.service),
    original = store.search.bind(store);
  f.service.taskReview = () => store;
  t.after(() => {
    f.service.taskReview = factory;
  });
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    arrival = new Promise<void>((r) => (entered = r));
  let held = false;
  store.search = async (input) => {
    const rows = await original(input);
    if (!held) {
      held = true;
      entered();
      await barrier;
    }
    return rows;
  };
  const pending = fetch(`${web.origin}/api/operator/search?query=Session`, {
    headers: { cookie: authenticatedCookie },
  });
  try {
    await arrival;
    const logout = await fetch(`${web.origin}/api/operator/logout`, {
      method: "POST",
      headers: {
        cookie: authenticatedCookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /unauthenticated/);
    assert.ok(!body.includes("Session private result"));
    assert.ok(!body.includes('"matches"'));
  } finally {
    release();
    await pending;
  }
});

test("ordinary service upgrade from missing review tables exposes retained source and exact historical results without fabricated context", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(
    f,
    "Upgrade project",
    "Upgrade current title",
    "- [ ] Retained current requirement",
  );
  const old = task.result("Upgrade historical result"),
    latest = task.result("Upgrade latest result");
  await f.service.stop();
  f.seedPersistedState((db) => {
    for (const name of [
      "task_review_search",
      "task_review_results",
      "task_review_contexts",
      "task_review_viewed",
      "task_review_view_receipts",
      "task_review_sources",
    ])
      db.exec(`DROP TABLE ${name}`);
  });
  await f.service.start();
  const api = new OperatorApi(f.service, [f.directory]);
  const source = f.service.taskReview().sources(task.taskId)[0]!;
  assert.equal(source.kind, "local");
  assert.equal(source.title, "Upgrade current title");
  assert.equal(source.body, "- [ ] Retained current requirement");
  const results = await api.readSearch(
    new URLSearchParams({
      query: "Upgrade",
      type: "result",
      historical: "true",
    }),
  );
  assert.deepEqual(
    new Map(results.data.matches.map((m) => [m.resultId, m.historical])),
    new Map([
      [old.resultId, true],
      [latest.resultId, false],
    ]),
  );
  const current = await api.readSearch(
    new URLSearchParams({
      query: "Upgrade",
      type: "result",
      historical: "false",
    }),
  );
  assert.equal(current.data.matches.length, 1);
  assert.equal(current.data.matches[0]?.resultId, latest.resultId);
  const sources = await api.readSearch(
    new URLSearchParams({
      query: "Upgrade current title",
      type: "task",
      historical: "false",
    }),
  );
  assert.equal(sources.data.matches[0]?.sourceId, source.sourceId);
  const exact = await api.readTask(task.taskId, { resultId: old.resultId });
  assert.ok(
    exact.data.review?.results.some(
      (r) =>
        r.resultId === old.resultId &&
        r.workId === old.workId &&
        r.metadata.sourceId === undefined,
    ),
  );
  assert.equal(exact.data.review?.contexts.length, 0);
  assert.deepEqual(
    (
      await api.readReview(task.taskId, { resultId: old.resultId })
    ).data.results.find((r) => r.resultId === old.resultId)?.metadata,
    { criteria: [], validations: [], artifacts: [], decisions: [] },
  );
  let bytes: unknown;
  f.seedPersistedState((db) => {
    bytes = db.prepare("SELECT * FROM task_review_sources").all();
  });
  await f.service.stop();
  await f.service.start();
  f.seedPersistedState((db) =>
    assert.deepEqual(
      db.prepare("SELECT * FROM task_review_sources").all(),
      bytes,
    ),
  );
  assert.equal(
    (
      await api.readSearch(
        new URLSearchParams({
          query: "Upgrade",
          type: "result",
          historical: "true",
        }),
      )
    ).data.matches.length,
    2,
  );
});

test("second yielding search excludes matches after same-version repository visibility changes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(
    f,
    "Binding visibility",
    "/newly/protected/git-common-dir",
  );
  a.result("/newly/protected/git-common-dir result");
  const binding = await f.service.taskWorkspace(a.taskId);
  assert.ok(binding);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE task_workspace_bindings SET repositories=? WHERE taskId=?",
      )
      .run(
        JSON.stringify([
          {
            repositoryId: "repository",
            sourcePath: "/retained/source",
            workspacePath: binding.path,
            ref: "main",
            gitCommonDir: null,
            commit: null,
          },
        ]),
        a.taskId,
      ),
  );
  const originalWorkspace = f.service.taskWorkspace.bind(f.service);
  f.service.taskWorkspace = async () => binding;
  const store = f.service.taskReview(),
    original = store.search.bind(store),
    factory = f.service.taskReview.bind(f.service);
  f.service.taskReview = () => store;
  t.after(() => {
    f.service.taskReview = factory;
    f.service.taskWorkspace = originalWorkspace;
  });
  const version = f.service.domain().task(a.taskId).version;
  let scans = 0;
  store.search = async (input) => {
    const rows = await original(input);
    if (++scans === 2)
      f.seedPersistedState((db) =>
        new SqliteWorkspaceBindingStore(db).bindRepository(
          a.taskId,
          "repository",
          "/newly/protected/git-common-dir",
          "b".repeat(40),
        ),
      );
    return rows;
  };
  const read = await new OperatorApi(f.service, [f.directory]).readSearch(
    new URLSearchParams({
      query: "/newly/protected/git-common-dir",
      historical: "true",
    }),
  );
  assert.equal(read.data.matches.length, 0);
  assert.equal(scans, 2);
  assert.equal(f.service.domain().task(a.taskId).version, version);
});
