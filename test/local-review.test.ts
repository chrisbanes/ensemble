import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { materialDigest } from "../src/core/delivery.js";
import { LocalReviewRecipientUnavailableError } from "../src/core/local-review.js";
import { ExecutionState } from "../src/standalone/state.js";
import { localReviewListReadSchema } from "../src/operator/contracts.js";
import { localReviewDraftReadSchema } from "../src/operator/contracts.js";
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
      // New profile instructions are excluded content, so file access changed.
      const domain = f.service.domain();
      domain.execute({
        type: "profile.configure",
        actor: "operator",
        key: randomUUID(),
        profileId: task.profileId,
        expectedVersion: Number(domain.profile(task.profileId).version),
        instructions: "CHANGED PRIVATE INSTRUCTIONS",
      });
      void taskId;
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
  // Read through the API: the rechecked draft stays editable after rejection.
  const afterRejection = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(afterRejection.data.state, "editable");
  assert.equal(afterRejection.data.draft.summary, "Policy-bound review");
  assert.equal(afterRejection.data.unsentDraftLost, false);
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

test("unrelated task and configuration versions keep the editable draft", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Draft survives versions");
  const other = await seedReviewTask(f, "Other project");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["kept.txt"]);
  const domain = f.service.domain();
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(domain.task(task.taskId).version),
    outcome: "Changed outcome text",
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: other.projectId,
    expectedVersion: Number(domain.project(other.projectId).version),
    paused: false,
  });
  const read = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(read.data.state, "editable");
  assert.deepEqual(read.data.draft, draft.draft);
  assert.equal(read.data.unsentDraftLost, false);
});

test("lost-draft notice counts only drafts with content and clears on the next save", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Loss notice");
  const api = new OperatorApi(f.service, []);
  const store = f.service.localReviews();
  const empty = session();
  await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "", comments: [] },
    },
    empty,
  );
  store.purgeEditableDrafts(empty.ownerKey, task.taskId);
  const next = session();
  assert.equal(
    (await api.readLocalReviewDraft(task.taskId, next)).data.unsentDraftLost,
    false,
  );
  const withContent = session();
  await stageDraft(f, api, task, withContent, ["lost.txt"]);
  store.purgeEditableDrafts(withContent.ownerKey, task.taskId);
  assert.equal(
    (await api.readLocalReviewDraft(task.taskId, next)).data.unsentDraftLost,
    true,
  );
  await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "fresh", comments: [] },
    },
    next,
  );
  assert.equal(
    (await api.readLocalReviewDraft(task.taskId, next)).data.unsentDraftLost,
    false,
  );
});

test("a frozen send is reconcilable from the draft read; unsent text stays with its session", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Pending operation");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["pending.txt"]);
  const command = requestFor(
    task,
    randomUUID(),
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  f.service.localReviews().prepareSend({
    request: {
      key: command.key,
      taskId: command.taskId,
      expectedDraftVersion: command.expectedDraftVersion,
      recipientAssignmentId: command.recipientAssignmentId,
      expectedAssignmentVersion: command.expectedAssignmentVersion,
    },
    ownerKey: owner.ownerKey,
    requestHash: materialDigest({
      taskId: command.taskId,
      expectedDraftVersion: command.expectedDraftVersion,
      recipientAssignmentId: command.recipientAssignmentId,
      expectedAssignmentVersion: command.expectedAssignmentVersion,
    }),
  });
  const read = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(read.data.state, "sending");
  assert.deepEqual(read.data.pendingOperation, {
    key: command.key,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: command.expectedAssignmentVersion,
  });
  const own = await api.readLocalReviewOperation(
    task.taskId,
    command.key,
    owner,
  );
  assert.ok(own.data.comments?.length);
  const rejected = f.service.localReviews().rejectSend(
    command.key,
    materialDigest({
      taskId: command.taskId,
      expectedDraftVersion: command.expectedDraftVersion,
      recipientAssignmentId: command.recipientAssignmentId,
      expectedAssignmentVersion: command.expectedAssignmentVersion,
    }),
    "policy-changed",
  );
  assert.equal(rejected?.state, "rejected");
  const otherSession = await api.readLocalReviewOperation(
    task.taskId,
    command.key,
    session(),
  );
  assert.equal(otherSession.data.state, "rejected");
  assert.equal(otherSession.data.comments, undefined);
  const sameSession = await api.readLocalReviewOperation(
    task.taskId,
    command.key,
    owner,
  );
  assert.ok(sameSession.data.comments?.length);
});

test("an access change purges only a draft whose text became excluded", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Exclusion recheck");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "mentions NEWSECRETVALUE later", comments: [] },
    },
    owner,
  );
  const domain = f.service.domain();
  domain.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: task.profileId,
    expectedVersion: Number(domain.profile(task.profileId).version),
    instructions: "NEWSECRETVALUE",
  });
  const read = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(read.data.draft.summary, "");
  assert.equal(read.data.unsentDraftLost, true);
});

test("large reviews drop excerpts before a definitive too-large rejection", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Review size");
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace);
  const api = new OperatorApi(f.service, []);
  const stageMany = async (
    owner: OperatorReviewSessionContext,
    count: number,
    body: string,
  ) => {
    let version = 0;
    const comments = [];
    for (let index = 0; index < count; index++) {
      const path = `big-${index}.txt`;
      const bytes = Array.from({ length: 12 }, (_, line) =>
        `${line}`.padEnd(60, "x"),
      ).join("\n");
      await writeFile(join(workspace.path, path), `${bytes}\n`);
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
              endLine: 12,
              contentSha256: createHash("sha256")
                .update(`${bytes}\n`)
                .digest("hex"),
            },
          ],
        },
        owner,
      )) as { groupId: string; draftVersion: number };
      version = receipt.draftVersion;
      comments.push({
        commentId: randomUUID(),
        body,
        anchorGroupIds: [receipt.groupId],
      });
    }
    const saved = (await api.execute(
      {
        type: "review.draft.save",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: version,
        draft: { summary: "", comments },
      },
      owner,
    )) as { version: number };
    return saved.version;
  };
  const version = Number(
    f.service.domain().assignment(task.assignmentId).version,
  );

  const fits = session();
  const fitsVersion = await stageMany(fits, 14, "a".repeat(600));
  const key = randomUUID();
  const sent = (await api.execute(
    requestFor(task, key, fitsVersion, version),
    fits,
  )) as { state: string };
  assert.equal(sent.state, "recorded");
  let message = "";
  f.seedPersistedState((db) => {
    message = String(
      (
        db
          .prepare(
            "SELECT payloadJson FROM coordination_local_review_operations WHERE operationId=?",
          )
          .get(key) as { payloadJson: string }
      ).payloadJson,
    );
  });
  assert.match(message, /Excerpt omitted to fit the message limit/);

  const tooLarge = session();
  const tooLargeVersion = await stageMany(tooLarge, 26, "b".repeat(380));
  await assert.rejects(
    api.execute(
      requestFor(task, randomUUID(), tooLargeVersion, version),
      tooLarge,
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "local-review-batch-too-large",
  );
  const still = await api.readLocalReviewDraft(task.taskId, tooLarge);
  assert.equal(still.data.state, "editable");
  assert.equal(still.data.draft.comments.length, 26);
});

test("the sent list holds only recorded reviews, newest first, with recordedAt, over HTTP too", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Sent review list");
  const api = new OperatorApi(f.service, []);
  const sendOne = async (label: string) => {
    const owner = session();
    const draft = await stageDraft(f, api, task, owner, [`${label}.txt`]);
    const key = randomUUID();
    const receipt = (await api.execute(
      requestFor(
        task,
        key,
        draft.version,
        Number(f.service.domain().assignment(task.assignmentId).version),
      ),
      owner,
    )) as { state: string; eventId: string };
    assert.equal(receipt.state, "recorded");
    return { key, eventId: receipt.eventId, owner };
  };
  const reader = session();
  assert.deepEqual((await api.readLocalReviewList(task.taskId, reader)).data, {
    taskId: task.taskId,
    reviews: [],
  });
  const first = await sendOne("first");
  const second = await sendOne("second");
  // An unsent operation never appears in the list.
  f.seedPersistedState((db) => {
    db.prepare(
      `INSERT INTO coordination_local_review_operations
      (operationId,taskId,ownerKey,requestHash,requestJson,reviewId,recipientAssignmentId,
       assignmentVersion,draftVersion,state,reason,createdAt,updatedAt)
      SELECT ?,taskId,ownerKey,?,requestJson,?,recipientAssignmentId,assignmentVersion,
        draftVersion,'rejected','policy-changed',createdAt,updatedAt+1000
      FROM coordination_local_review_operations WHERE operationId=?`,
    ).run(randomUUID(), randomUUID(), randomUUID(), second.key);
  });

  const listed = (await api.readLocalReviewList(task.taskId, reader)).data;
  assert.deepEqual(
    listed.reviews.map((review) => [review.operationId, review.eventId]),
    [
      [second.key, second.eventId],
      [first.key, first.eventId],
    ],
  );
  const single = (
    await api.readLocalReviewOperation(task.taskId, first.key, reader)
  ).data;
  assert.equal(single.recordedAt, listed.reviews[1]?.recordedAt);
  assert.ok((single.recordedAt ?? 0) > 0);
  await assert.rejects(
    api.readLocalReviewList(task.taskId, {
      ownerKey: randomUUID(),
      current: () => false,
    }),
    (error: unknown) => (error as { status?: number }).status === 401,
  );

  const web = await f.startWeb();
  t.after(() => web.close());
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrfToken = ((await response.json()) as { csrfToken: string })
    .csrfToken;
  const path = `${web.origin}/api/operator/tasks/${task.taskId}/local-reviews`;
  assert.equal((await fetch(path)).status, 401);
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
  const read = await fetch(path, { headers: { cookie } });
  assert.equal(read.status, 200);
  const body = localReviewListReadSchema.parse(await read.json());
  assert.deepEqual(body.data, listed);
  assert.equal(
    (await fetch(`${path}?limit=1`, { headers: { cookie } })).status,
    400,
  );
});

test("an unavailable anchor at send is a definitive rejection that keeps the draft editable", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Unavailable anchor at send");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["gone.txt"]);
  const key = randomUUID();
  const readAnchor = api.readRetainedReviewAnchor.bind(api);
  api.readRetainedReviewAnchor = async (taskId, anchorId) => {
    const read = await readAnchor(taskId, anchorId);
    return {
      ...read,
      data: {
        taskId,
        anchorId,
        state: "unavailable" as const,
        reason: "unavailable" as const,
      },
    };
  };
  const receipt = (await api.execute(
    requestFor(
      task,
      key,
      draft.version,
      Number(f.service.domain().assignment(task.assignmentId).version),
    ),
    owner,
  )) as { state: string };
  assert.equal(receipt.state, "rejected");
  assert.equal(
    f.service.localReviews().operationMaterial(key)?.response.reason,
    "anchor-unavailable",
  );
  const after = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(after.data.state, "editable");
  assert.deepEqual(after.data.draft, draft.draft);
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
  assert.deepEqual(
    (await api.readLocalReviewList(task.taskId, owner)).data.reviews,
    [],
  );
});

test("a lead completed without a recorded result is a definitive rejection before any operation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Lead no longer active");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["lead.txt"]);
  const version = Number(
    f.service.domain().assignment(task.assignmentId).version,
  );
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_assignments SET state='completed' WHERE id=?",
    ).run(task.assignmentId);
  });
  const key = randomUUID();
  await assert.rejects(
    api.execute(requestFor(task, key, draft.version, version), owner),
    (error: unknown) =>
      (error as { status?: number }).status === 409 &&
      (error as { code?: string }).code ===
        "local-review-recipient-unavailable",
  );
  assert.equal(f.service.localReviews().operationMaterial(key), undefined);
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
  const after = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(after.data.state, "editable");
  assert.deepEqual(after.data.draft, draft.draft);
});

function followUpState(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  taskId: string,
) {
  let state = {
    followUps: [] as Array<{ resultId: string; requester: string }>,
    events: [] as Array<{ eventId: string; payload: string }>,
  };
  f.seedPersistedState((db) => {
    state = {
      followUps: (
        db
          .prepare(
            "SELECT resultId, requester FROM coordination_follow_ups WHERE taskId=? ORDER BY createdAt",
          )
          .all(taskId) as typeof state.followUps
      ).map((row) => ({ ...row })),
      events: db
        .prepare(
          "SELECT eventId, payload FROM coordination_inbox_events WHERE taskId=? AND eventType='assignment-follow-up' ORDER BY sequence",
        )
        .all(taskId) as typeof state.events,
    };
  });
  return state;
}

/** Binds a later work revision of the lead's conversation that has no result yet. */
function addNewerLeadWork(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  task: Awaited<ReturnType<typeof seedReviewTask>>,
) {
  const workId = randomUUID();
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval) VALUES(?,?,'fixture','/tmp/fixture','running',?,?,'chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId, workId, workId);
    new ExecutionState(db).bindTask(workId, {
      taskId: task.taskId,
      assignmentId: task.assignmentId,
      assignmentVersion: Number(
        f.service.domain().assignment(task.assignmentId).version,
      ),
      instructionsRevision: 1,
      profileRevision: 1,
    });
    db.prepare(
      "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) SELECT ?,assignmentId,conversationRevision,MAX(workRevision)+1 FROM task_work_revisions WHERE assignmentId=?",
    ).run(workId, task.assignmentId);
  });
}

test("a review to a completed lead resumes it as one follow-up with exact anchors", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Completed lead review");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["followup.txt"]);
  const { resultId } = task.result("Lead finished");
  const lead = f.service.domain().assignment(task.assignmentId);
  assert.equal(lead.state, "completed");
  const version = Number(lead.version);
  const key = randomUUID();
  const command = requestFor(task, key, draft.version, version);
  const receipt = (await api.execute(command, owner)) as { state: string };
  assert.equal(receipt.state, "recorded");
  const store = f.service.localReviews();
  assert.equal(store.operationMaterial(key)?.response.resumedLead, true);
  const resumed = f.service.domain().assignment(task.assignmentId);
  assert.equal(resumed.state, "pending");
  assert.equal(Number(resumed.version), version + 1);
  const state = followUpState(f, task.taskId);
  assert.deepEqual(state.followUps, [{ resultId, requester: "operator" }]);
  assert.equal(state.events.length, 1);
  const payload = JSON.parse(String(state.events[0]?.payload)) as {
    instructions: string;
    requester: string;
  };
  assert.equal(payload.requester, "operator");
  assert.match(payload.instructions, /Check context 1\./);
  assert.match(payload.instructions, /followup\.txt/);
  assert.match(payload.instructions, /lines 1-1/);
  assert.match(payload.instructions, /\| review context 1/);
  const operation = await api.readLocalReviewOperation(task.taskId, key, owner);
  assert.equal(operation.data.state, "recorded");
  const anchorIds =
    operation.data.groups?.flatMap((g) => g.anchors.map((a) => a.anchorId)) ??
    [];
  assert.equal(anchorIds.length, 1);
  for (const anchorId of anchorIds)
    assert.match(
      payload.instructions,
      new RegExp(`retained anchor ${anchorId}`),
    );
  assert.deepEqual(counts(f, task.taskId, key), {
    events: 0,
    receipts: 1,
    continuations: 0,
    submissions: 1,
  });

  // Exact replay and reconciliation return the recorded resume without a second one.
  assert.deepEqual(await api.execute(command, owner), receipt);
  assert.deepEqual(
    await api.execute({ ...command, type: "review.send.reconcile" }, owner),
    receipt,
  );
  assert.equal(store.operationMaterial(key)?.response.resumedLead, true);
  assert.equal(followUpState(f, task.taskId).events.length, 1);
  assert.equal(
    Number(f.service.domain().assignment(task.assignmentId).version),
    version + 1,
  );
});

test("a review composed while the lead ran is delivered as a follow-up after it completes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Lead completes mid-send");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  const draft = await stageDraft(f, api, task, owner, ["race.txt"]);
  const key = randomUUID();
  const command = requestFor(
    task,
    key,
    draft.version,
    Number(f.service.domain().assignment(task.assignmentId).version),
  );
  const originalPolicy = api.retainedEvidencePolicy.bind(api);
  let completed = false;
  api.retainedEvidencePolicy = async (taskId) => {
    // prepareSend has frozen the operation before the first policy read.
    if (!completed) {
      completed = true;
      assert.equal(
        f.service.localReviews().operationMaterial(key)?.response.state,
        "prepared",
      );
      task.result("Lead finished while the review was sending");
    }
    return originalPolicy(taskId);
  };
  const receipt = (await api.execute(command, owner)) as { state: string };
  assert.equal(completed, true);
  assert.equal(receipt.state, "recorded");
  assert.equal(
    f.service.localReviews().operationMaterial(key)?.response.resumedLead,
    true,
  );
  assert.equal(followUpState(f, task.taskId).followUps.length, 1);
});

test("reconciling a prepared review fences against the completed lead's version", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Reconcile completed lead");
  const api = new OperatorApi(f.service, []);
  const store = f.service.localReviews();
  const prepare = async (owner: OperatorReviewSessionContext) => {
    const saved = (await api.execute(
      {
        type: "review.draft.save",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: 0,
        draft: { summary: "Reconcile me", comments: [] },
      },
      owner,
    )) as { version: number };
    const command = requestFor(
      task,
      randomUUID(),
      saved.version,
      Number(f.service.domain().assignment(task.assignmentId).version),
    );
    const { type: _type, ...material } = command;
    const { key: _key, ...hashed } = material;
    const prepared = store.prepareSend({
      request: material,
      ownerKey: owner.ownerKey,
      requestHash: materialDigest(hashed),
    });
    assert.equal(prepared.response.state, "prepared");
    return command;
  };
  const owner = session();
  const first = await prepare(owner);
  task.result("Lead finished");
  const notRecorded = (await api.execute(
    { ...first, type: "review.send.reconcile" },
    owner,
  )) as { state: string };
  assert.equal(notRecorded.state, "not-recorded");

  const other = session();
  const second = await prepare(other);
  await api.execute({
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: second.expectedAssignmentVersion,
    message: "A different follow-up resumed the lead first.",
  });
  const rejected = (await api.execute(
    { ...second, type: "review.send.reconcile" },
    other,
  )) as { state: string };
  assert.equal(rejected.state, "rejected");
  assert.equal(
    store.operationMaterial(second.key)?.response.reason,
    "recipient-changed",
  );
  assert.equal(followUpState(f, task.taskId).followUps.length, 1);
});

test("held, done, non-lead and newer-work recipients refuse a review before any operation", async () => {
  const cases: Array<{
    name: string;
    arrange: (
      f: Awaited<ReturnType<typeof createOperatorFixture>>,
      task: Awaited<ReturnType<typeof seedReviewTask>>,
    ) => string | undefined;
  }> = [
    {
      name: "held lead",
      arrange: (f, task) => {
        f.seedPersistedState((db) =>
          db
            .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
            .run(task.assignmentId),
        );
        return undefined;
      },
    },
    {
      name: "done task",
      arrange: (f, task) => {
        f.seedPersistedState((db) =>
          db
            .prepare("UPDATE domain_tasks SET state='done' WHERE id=?")
            .run(task.taskId),
        );
        return undefined;
      },
    },
    {
      name: "completed non-lead",
      arrange: (_f, task) => task.delegatedResult("Delegate done").assignmentId,
    },
    {
      name: "newer lead work",
      arrange: (f, task) => {
        addNewerLeadWork(f, task);
        return undefined;
      },
    },
  ];
  for (const testCase of cases) {
    const f = await createOperatorFixture();
    try {
      const task = await seedReviewTask(f, `Refusal ${testCase.name}`);
      const api = new OperatorApi(f.service, []);
      const owner = session();
      const draft = await stageDraft(f, api, task, owner, ["refused.txt"]);
      task.result("Lead finished");
      const recipient = testCase.arrange(f, task) ?? task.assignmentId;
      const request = {
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: draft.version,
        recipientAssignmentId: recipient,
        expectedAssignmentVersion: Number(
          f.service.domain().assignment(recipient).version,
        ),
      };
      const { key: _key, ...hashed } = request;
      assert.throws(
        () =>
          f.service.localReviews().prepareSend({
            request,
            ownerKey: owner.ownerKey,
            requestHash: materialDigest(hashed),
          }),
        LocalReviewRecipientUnavailableError,
        testCase.name,
      );
      assert.equal(
        f.service.localReviews().operationMaterial(request.key),
        undefined,
      );
      const after = await api.readLocalReviewDraft(task.taskId, owner);
      assert.equal(after.data.state, "editable", testCase.name);
      assert.deepEqual(after.data.draft, draft.draft, testCase.name);
      assert.equal(followUpState(f, task.taskId).followUps.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("an anchor excerpt that becomes excluded removes the draft and blocks a stale save", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Excerpt exclusion");
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace);
  const api = new OperatorApi(f.service, []);
  const bytes = "contains EXCERPTSECRET value\n";
  await writeFile(join(workspace.path, "excerpt.txt"), bytes);
  const stage = async (owner: OperatorReviewSessionContext) =>
    (await api.execute(
      {
        type: "review.anchor.stage",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: 0,
        anchors: [
          {
            taskId: task.taskId,
            repositoryId: null,
            path: "excerpt.txt",
            sourceKind: "workspace-file",
            context: "workspace",
            side: "file",
            startLine: 1,
            endLine: 1,
            contentSha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
      owner,
    )) as { groupId: string; draftVersion: number };
  const reader = session();
  const readerGroup = await stage(reader);
  await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: readerGroup.draftVersion,
      draft: {
        summary: "",
        comments: [
          {
            commentId: randomUUID(),
            body: "Safe comment text",
            anchorGroupIds: [readerGroup.groupId],
          },
        ],
      },
    },
    reader,
  );
  const staleTab = session();
  const staleGroup = await stage(staleTab);
  const domain = f.service.domain();
  domain.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: task.profileId,
    expectedVersion: Number(domain.profile(task.profileId).version),
    instructions: "EXCERPTSECRET",
  });

  const read = await api.readLocalReviewDraft(task.taskId, reader);
  assert.deepEqual(read.data.draft.comments, []);
  assert.equal(read.data.unsentDraftLost, true);

  await assert.rejects(
    api.execute(
      {
        type: "review.draft.save",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: staleGroup.draftVersion,
        draft: {
          summary: "",
          comments: [
            {
              commentId: randomUUID(),
              body: "Stale tab comment",
              anchorGroupIds: [staleGroup.groupId],
            },
          ],
        },
      },
      staleTab,
    ),
    (error: unknown) => (error as { code?: string }).code === "forbidden",
  );
});

test("every review comment must carry exact anchor context", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Unanchored comment");
  const api = new OperatorApi(f.service, []);
  await assert.rejects(
    api.execute(
      {
        type: "review.draft.save",
        key: randomUUID(),
        taskId: task.taskId,
        expectedDraftVersion: 0,
        draft: {
          summary: "",
          comments: [
            {
              commentId: randomUUID(),
              body: "No anchor",
              anchorGroupIds: [],
            },
          ],
        },
      },
      session(),
    ),
  );
});

test("a stored unanchored draft from before the anchor rule stays readable", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Legacy unanchored draft");
  const api = new OperatorApi(f.service, []);
  const owner = session();
  await api.execute(
    {
      type: "review.draft.save",
      key: randomUUID(),
      taskId: task.taskId,
      expectedDraftVersion: 0,
      draft: { summary: "legacy", comments: [] },
    },
    owner,
  );
  const legacy = {
    summary: "legacy",
    comments: [
      { commentId: randomUUID(), body: "Unanchored", anchorGroupIds: [] },
    ],
  };
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE coordination_local_review_drafts SET draftJson=? WHERE taskId=? AND ownerKey=?",
    ).run(JSON.stringify(legacy), task.taskId, owner.ownerKey);
  });
  const read = await api.readLocalReviewDraft(task.taskId, owner);
  assert.deepEqual(read.data.draft, legacy);
  // The transport read schema accepts it, so the browser can show and fix it.
  assert.equal(localReviewDraftReadSchema.safeParse(read).success, true);
  // A new send still refuses the unanchored comment and records nothing.
  await assert.rejects(
    api.execute(
      requestFor(
        task,
        randomUUID(),
        read.data.version,
        Number(f.service.domain().assignment(task.assignmentId).version),
      ),
      owner,
    ),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "local-review-comment-anchor-required",
  );
  const stillEditable = await api.readLocalReviewDraft(task.taskId, owner);
  assert.equal(stillEditable.data.state, "editable");
  assert.deepEqual(counts(f, task.taskId), {
    events: 0,
    receipts: 0,
    continuations: 0,
    submissions: 0,
  });
});
