import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { materialDigest } from "../src/core/delivery.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import type { OperatorReviewSessionContext } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function session(ownerKey = randomUUID()): OperatorReviewSessionContext {
  return { ownerKey, current: () => true };
}

async function stageDraft(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  api: OperatorApi,
  task: Awaited<ReturnType<typeof seedReviewTask>>,
  owner: OperatorReviewSessionContext,
  paths: string[],
) {
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.equal(workspace?.state, "ready");
  if (!workspace || workspace.state !== "ready")
    throw new Error("Task workspace unavailable");
  let version = 0;
  const groups: string[] = [];
  for (const [index, path] of paths.entries()) {
    const bytes = `review context ${index + 1}\n`;
    await writeFile(join(workspace.path, path), bytes);
    const receipt = (await api.execute(
      {
        type: "review.anchor.stage",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: version,
        anchors: [
          {
            taskId: task.taskId,
            repositoryId: null,
            path,
            sourceKind: "workspace-file",
            context: "workspace",
            side: "file",
            startLine: 1,
            endLine: 1,
            contentSha256: digest(bytes),
          },
        ],
      },
      owner,
    )) as { kind: string; groupId: string; draftVersion: number };
    assert.equal(receipt.kind, "local-review-anchor");
    version = receipt.draftVersion;
    groups.push(receipt.groupId);
  }
  const draft = {
    summary: "Review the retained changes.",
    comments: groups.map((groupId, index) => ({
      commentId: randomUUID(),
      body: `Check context ${index + 1}.`,
      anchorGroupIds: [groupId],
    })),
  };
  const saved = (await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: version,
      draft,
    },
    owner,
  )) as { kind: string; version: number };
  assert.equal(saved.kind, "local-review-draft");
  return { version: saved.version, groups, draft };
}

function counts(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  taskId: string,
  commandKey?: string,
) {
  let result = { events: 0, receipts: 0, continuations: 0, submissions: 0 };
  f.seedPersistedState((db) => {
    const count = (sql: string, ...values: string[]) =>
      Number(
        (db.prepare(sql).get(...values) as { count: number | bigint }).count,
      );
    result = {
      events: count(
        "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE taskId=? AND eventType='operator-message'",
        taskId,
      ),
      receipts: commandKey
        ? count(
            "SELECT COUNT(*) AS count FROM coordination_operator_receipts WHERE scope='local-review-send' AND commandKey=?",
            commandKey,
          )
        : 0,
      continuations: count(
        "SELECT COUNT(*) AS count FROM coordination_recovery_continuations",
      ),
      submissions: count(
        `SELECT COUNT(*) AS count FROM coordination_local_review_submissions s
         JOIN coordination_local_review_operations o ON o.reviewId=s.reviewId WHERE o.taskId=?`,
        taskId,
      ),
    };
  });
  return result;
}

function requestFor(
  task: Awaited<ReturnType<typeof seedReviewTask>>,
  key: string,
  draftVersion: number,
  assignmentVersion: number,
) {
  return {
    type: "review.send" as const,
    key,
    taskId: task.taskId,
    expectedDraftVersion: draftVersion,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: assignmentVersion,
  };
}

test("local review sends all anchor groups atomically and exact replay returns the one receipt", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Local review atomicity");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, [
    "first.txt",
    "second.txt",
  ]);
  const requestKey = randomUUID();
  const send = requestFor(
    task,
    requestKey,
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  f.seedPersistedState((db) => {
    db.exec(`CREATE TRIGGER interrupt_second_local_review_seal
      BEFORE INSERT ON retained_review_anchor_submitted_refs
      WHEN (SELECT COUNT(*) FROM retained_review_anchor_submitted_refs)=1
      BEGIN SELECT RAISE(ABORT, 'second-local-review-seal-failed'); END`);
  });

  const rolledBack = (await api.execute(send, owner)) as {
    state: string;
    key: string;
  };
  assert.equal(rolledBack.state, "rejected");
  assert.equal(rolledBack.key, requestKey);
  assert.deepEqual(counts(f, task.taskId, requestKey), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
  const unchanged = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(unchanged.data.state, "editable");
  assert.deepEqual(unchanged.data.draft, draft.draft);
  assert.deepEqual(
    unchanged.data.groups.map((group) => group.state),
    ["open", "open"],
  );

  f.seedPersistedState((db) =>
    db.exec("DROP TRIGGER interrupt_second_local_review_seal"),
  );
  const committedKey = randomUUID();
  const committedCommand = requestFor(
    task,
    committedKey,
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const first = await api.execute(committedCommand, owner);
  assert.equal((first as { state: string }).state, "recorded");
  assert.deepEqual(await api.execute(committedCommand, owner), first);
  await assert.rejects(
    api.execute(
      {
        ...committedCommand,
        expectedAssignmentVersion:
          committedCommand.expectedAssignmentVersion + 1,
      },
      owner,
    ),
    /conflict/,
  );
  assert.deepEqual(counts(f, task.taskId, committedKey), {
    events: 1,
    receipts: 1,
    continuations: 0,
    submissions: 2,
  });

  // A sent draft stays frozen for edits but can be cleared for the next review.
  const sent = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(sent.data.state, "sent");
  await assert.rejects(
    api.execute(
      {
        type: "review.draft.save",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: sent.data.version,
        draft: { summary: "edit after send", comments: [] },
      },
      owner,
    ),
  );
  await api.execute(
    {
      type: "review.draft.discard",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: sent.data.version,
    },
    owner,
  );
  const next = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(next.data.state, "editable");
  assert.deepEqual(next.data.draft, { summary: "", comments: [] });
  assert.ok(next.data.groups.every((group) => group.state === "sealed"));
  const inspected = await api.readLocalReviewOperation(
    task.taskId,
    committedKey,
    owner,
  );
  assert.equal(inspected.data.state, "recorded");
  assert.equal(inspected.data.groups?.length, 2);
  assert.deepEqual(counts(f, task.taskId, committedKey), {
    events: 1,
    receipts: 1,
    continuations: 0,
    submissions: 2,
  });
});

test("prepared anchor bytes survive restart purge but the old editable draft does not cross sessions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Prepared review ownership");
  const api = new OperatorApi(f.service, []);
  const oldOwner = session();
  const draft = await stageDraft(f, api, task, oldOwner, ["prepared.txt"]);
  const key = randomUUID();
  const command = requestFor(
    task,
    key,
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const request = {
    key,
    taskId: command.taskId,
    expectedDraftVersion: command.expectedDraftVersion,
    recipientAssignmentId: command.recipientAssignmentId,
    expectedAssignmentVersion: command.expectedAssignmentVersion,
  };
  const prepared = f.service.localReviews().prepareSend({
    request,
    ownerKey: oldOwner.ownerKey,
    requestHash: materialDigest({
      taskId: request.taskId,
      expectedDraftVersion: request.expectedDraftVersion,
      recipientAssignmentId: request.recipientAssignmentId,
      expectedAssignmentVersion: request.expectedAssignmentVersion,
    }),
  });
  assert.equal(prepared.response.state, "prepared");
  const anchorId = prepared.payload?.groups[0]?.anchorIds[0];
  if (!anchorId) throw new Error("Prepared anchor reference missing");

  await f.reopen();
  const currentApi = new OperatorApi(f.service, []);
  const newOwner = session();
  const privateDraft = await currentApi.readLocalReviewDraft(
    task.taskId,
    newOwner,
  );
  assert.deepEqual(privateDraft.data.draft, { summary: "", comments: [] });
  assert.equal(privateDraft.data.version, 0);
  assert.equal(privateDraft.data.unsentDraftLost, true);
  const recoveredAnchor = f.service
    .retainedEvidence()
    .reviewAnchor(task.taskId, anchorId);
  assert.ok(recoveredAnchor?.bytes);
  assert.equal(recoveredAnchor?.bytes.toString("utf8"), "review context 1\n");
  const visibleOperation = await currentApi.readLocalReviewOperation(
    task.taskId,
    key,
    newOwner,
  );
  assert.equal(visibleOperation.data.state, "prepared");
  assert.equal(visibleOperation.data.comments?.[0]?.body, "Check context 1.");

  f.seedPersistedState((db) => {
    db.exec(`CREATE TRIGGER fail_prepared_review_ref_release
      BEFORE INSERT ON retained_review_anchor_operations WHEN NEW.kind='discard'
      BEGIN SELECT RAISE(ABORT, 'prepared-review-ref-release-failed'); END`);
  });
  await assert.rejects(
    currentApi.execute({ ...command, type: "review.send.reconcile" }, newOwner),
  );
  assert.equal(
    f.service.localReviews().operationMaterial(key)?.response.state,
    "prepared",
  );
  assert.equal(
    f.service
      .retainedEvidence()
      .reviewAnchor(task.taskId, anchorId)
      ?.bytes?.toString("utf8"),
    "review context 1\n",
  );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
  f.seedPersistedState((db) =>
    db.exec("DROP TRIGGER fail_prepared_review_ref_release"),
  );
  const reconciled = await currentApi.execute(
    { ...command, type: "review.send.reconcile" },
    newOwner,
  );
  assert.equal((reconciled as { state: string }).state, "not-recorded");
  assert.equal(
    f.service.localReviews().readDraft(task.taskId, oldOwner.ownerKey).version,
    0,
  );
  assert.equal(
    f.service.retainedEvidence().reviewAnchor(task.taskId, anchorId),
    undefined,
  );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});

test("a permanent fence keeps refs still referenced by the restored editable draft", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Surviving review draft refs");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["surviving.txt"]);
  const key = randomUUID();
  const command = requestFor(
    task,
    key,
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const request = {
    key,
    taskId: command.taskId,
    expectedDraftVersion: command.expectedDraftVersion,
    recipientAssignmentId: command.recipientAssignmentId,
    expectedAssignmentVersion: command.expectedAssignmentVersion,
  };
  const prepared = f.service.localReviews().prepareSend({
    request,
    ownerKey: owner.ownerKey,
    requestHash: materialDigest({
      taskId: request.taskId,
      expectedDraftVersion: request.expectedDraftVersion,
      recipientAssignmentId: request.recipientAssignmentId,
      expectedAssignmentVersion: request.expectedAssignmentVersion,
    }),
  });
  const groupId = prepared.payload?.groups[0]?.groupId;
  const anchorId = prepared.payload?.groups[0]?.anchorIds[0];
  if (!groupId || !anchorId)
    throw new Error("Prepared anchor references missing");
  const reconciled = await api.execute(
    { ...command, type: "review.send.reconcile" },
    owner,
  );
  assert.equal((reconciled as { state: string }).state, "not-recorded");
  const restored = f.service
    .localReviews()
    .readDraft(task.taskId, owner.ownerKey);
  assert.equal(restored.state, "editable");
  assert.deepEqual(restored.draft, draft.draft);
  assert.equal(
    restored.groups.find((group) => group.groupId === groupId)?.state,
    "open",
  );
  assert.equal(
    f.service
      .retainedEvidence()
      .reviewAnchor(task.taskId, anchorId)
      ?.bytes?.toString("utf8"),
    "review context 1\n",
  );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});

test("active send reconciliation cannot fence during policy capture", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Active review fence");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const saved = (await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "Review summary", comments: [] },
    },
    owner,
  )) as { version: number };
  const key = randomUUID();
  const command = requestFor(
    task,
    key,
    saved.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const originalPolicy = api.retainedEvidencePolicy.bind(api);
  let entered!: () => void;
  const policyEntered = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let hold = true;
  api.retainedEvidencePolicy = async (taskId) => {
    if (hold) {
      hold = false;
      entered();
      await gate;
    }
    return originalPolicy(taskId);
  };
  const sending = api.execute(command, owner);
  await policyEntered;
  const reconcile = (await api.execute(
    { ...command, type: "review.send.reconcile" },
    owner,
  )) as { state: string };
  assert.equal(reconcile.state, "prepared");
  assert.equal(
    f.service.localReviews().operationMaterial(key)?.response.state,
    "prepared",
  );
  release();
  const recorded = (await sending) as { state: string };
  assert.equal(recorded.state, "recorded");
  assert.equal(counts(f, task.taskId, key).events, 1);
});

test("closed task cannot prepare a send or freeze its editable draft", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Closed local review task");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const saved = (await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "Keep this editable", comments: [] },
    },
    owner,
  )) as { version: number };
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_tasks SET state='done',version=version+1 WHERE id=?",
    ).run(task.taskId);
  });
  const key = randomUUID();
  await assert.rejects(
    api.execute(
      requestFor(
        task,
        key,
        saved.version,
        Number(f.service.domain().assignment(task.assignmentId).version),
      ),
      owner,
    ),
  );
  assert.equal(f.service.localReviews().operationMaterial(key), undefined);
  const retained = f.service
    .localReviews()
    .readDraft(task.taskId, owner.ownerKey);
  assert.equal(retained.state, "editable");
  assert.equal(retained.draft.summary, "Keep this editable");
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});

test("policy change during send rejects the frozen operation and restores editing", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Policy-changed local review task");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const saved = (await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "Policy-bound review", comments: [] },
    },
    owner,
  )) as { version: number };
  const key = randomUUID();
  const command = requestFor(
    task,
    key,
    saved.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const originalPolicy = api.retainedEvidencePolicy.bind(api);
  let entered!: () => void;
  const policyEntered = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let hold = true;
  api.retainedEvidencePolicy = async (taskId) => {
    if (hold) {
      hold = false;
      entered();
      await gate;
      f.seedPersistedState((db) => {
        db.prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?").run(
          taskId,
        );
      });
    }
    return originalPolicy(taskId);
  };
  const sending = api.execute(command, owner);
  await policyEntered;
  release();
  const rejected = (await sending) as { state: string };
  assert.equal(rejected.state, "rejected");
  assert.equal(
    f.service.localReviews().operationMaterial(key)?.response.reason,
    "policy-changed",
  );
  assert.equal(
    f.service.localReviews().readDraft(task.taskId, owner.ownerKey).state,
    "editable",
  );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});

test("HTTP reconciliation tombstone fences an original POST delayed before server arrival", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Delayed local review POST");
  const web = await f.startWeb();
  t.after(() => web.close());
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  let csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  const post = (command: unknown) =>
    fetch(`${web.origin}/api/operator/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
  const savedResponse = await post({
    type: "review.draft.save",
    key: randomUUID(),
    taskId: task.taskId,
    expectedDraftVersion: 0,
    draft: { summary: "Original delayed review", comments: [] },
  });
  assert.equal(savedResponse.status, 200);
  const saved = (await savedResponse.json()) as { version: number };
  const key = randomUUID();
  const original = requestFor(
    task,
    key,
    saved.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const operationPath = `/api/operator/tasks/${task.taskId}/local-reviews/${key}`;
  const absent = await fetch(`${web.origin}${operationPath}`, {
    headers: { cookie },
  });
  assert.equal(absent.status, 404);

  const reconciledResponse = await post({
    ...original,
    type: "review.send.reconcile",
  });
  assert.equal(reconciledResponse.status, 200);
  assert.equal(
    ((await reconciledResponse.json()) as { state: string }).state,
    "not-recorded",
  );
  const changed = await post({
    type: "review.draft.save",
    key: randomUUID(),
    taskId: task.taskId,
    expectedDraftVersion: saved.version,
    draft: { summary: "Edited after the fence", comments: [] },
  });
  assert.equal(changed.status, 200);

  const delayedOriginalResponse = await post(original);
  assert.equal(delayedOriginalResponse.status, 200);
  assert.equal(
    ((await delayedOriginalResponse.json()) as { state: string }).state,
    "not-recorded",
  );
  const current = await fetch(
    `${web.origin}/api/operator/tasks/${task.taskId}/review-draft`,
    {
      headers: { cookie },
    },
  );
  assert.equal(current.status, 200);
  assert.equal(
    ((await current.json()) as { data: { draft: { summary: string } } }).data
      .draft.summary,
    "Edited after the fence",
  );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});
