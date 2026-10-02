import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DomainStore, DomainPolicyError } from "../src/core/domain.js";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import {
  seedOperatorRecovery,
  createOperatorFixture,
} from "./fixtures/operator-web.js";

test("configuration receipts preserve original creation after later configuration and private instructions never cross the API", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const profile = {
    type: "profile.create",
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Lead",
    instructions: "PRIVATE CONFIGURATION SENTINEL",
    capabilities: "Review",
  };
  const receipt = await api.execute(profile);
  await api.execute({
    type: "profile.configure",
    key: randomUUID(),
    profileId: profile.profileId,
    expectedVersion: 1,
    name: "Changed",
    revoked: true,
  });
  assert.deepEqual(await api.execute(profile), receipt);
  assert.equal(JSON.stringify(receipt).includes(profile.instructions), false);
  const project = {
    type: "project.create",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Paused project",
    leadProfileId: null,
  };
  const created = await api.execute(project);
  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId: project.projectId,
    expectedVersion: 1,
    instructions: "PRIVATE PROJECT SENTINEL",
  });
  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId: project.projectId,
    expectedVersion: 2,
    name: "New name",
  });
  assert.deepEqual(await api.execute(project), created);
  assert.equal(
    f.service.domain().project(project.projectId).instructions,
    "PRIVATE PROJECT SENTINEL",
  );
  assert.equal(f.runtime.turns, 0);
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(profile), receipt);
  assert.deepEqual(await reopened.execute(project), created);
});

test("GitHub omitted reference is preserved at apply and its original receipt replays after later changes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Source",
    leadProfileId: null,
  });
  const base = {
    type: "github.configure" as const,
    projectId,
    selections: [],
    repositories: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  };
  await api.execute({
    ...base,
    key: randomUUID(),
    expectedVersion: 1,
    credentialRef: "env:FIRST_REF",
  });
  const omitted = { ...base, key: randomUUID(), expectedVersion: 2 };
  const original = await api.execute(omitted);
  assert.equal(
    f.service.domain().githubConfiguration(projectId).credentialRef,
    "env:FIRST_REF",
  );
  await api.execute({
    ...base,
    key: randomUUID(),
    expectedVersion: 3,
    credentialRef: "env:SECOND_REF",
  });
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(omitted), original);
  await assert.rejects(reopened.execute({ ...omitted, credentialRef: null }), {
    status: 409,
  });
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
  await assert.rejects(
    reopened.execute({
      ...base,
      key: randomUUID(),
      expectedVersion: 4,
      repositories: [
        { repositoryId: "repo", path: "relative-private-path", ref: "main" },
      ],
    }),
    { status: 400, code: "invalid-input", fieldPaths: ["repositories"] },
  );
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
});

test("preview original activation receipt replays without provider access after configuration changes", async (t) => {
  let reads = 0;
  const reader = {
    async readSelection() {
      reads++;
      return { complete: true as const, issues: [], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "unknown" as const };
    },
  };
  const f = await createOperatorFixture(null, () => reader);
  t.after(() => f.close());
  const api = new OperatorApi(
      f.service,
      [f.directory],
      undefined,
      () => reader,
    ),
    projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Preview",
    leadProfileId: null,
  });
  const config = {
    type: "github.configure",
    projectId,
    selections: [
      { id: "search", kind: "search", query: "repo:example/private" },
    ],
    repositories: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    credentialRef: "env:FIXTURE_PREVIEW",
  };
  await api.execute({ ...config, key: randomUUID(), expectedVersion: 1 });
  const command = {
    type: "github.preview",
    key: randomUUID(),
    projectId,
    selectionId: "search",
    expectedVersion: 2,
  };
  const receipt = await api.execute(command);
  assert.equal(reads, 1);
  await api.execute({
    ...config,
    key: randomUUID(),
    expectedVersion: 2,
    credentialRef: null,
  });
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(reads, 1);
  await assert.rejects(api.execute({ ...command, selectionId: "other" }), {
    status: 409,
  });
  assert.equal(reads, 1);
});

test("capacity receipts replay original limits and recovery exposes bounded independent evidence", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  await api.execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Held",
    leadProfileId: profileId,
  });
  f.service.domain().execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Recovery",
    outcome: "Done",
    ready: false,
  });
  f.service.domain().execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  const command = {
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 3,
    projectOverrides: { [projectId]: 1 },
  };
  const receipt = await api.execute(command);
  await api.execute({
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 4,
    projectOverrides: { [projectId]: null },
  });
  assert.deepEqual(await api.execute(command), receipt);
  const settings = await api.readRuntimeSettings();
  assert.equal(settings.data.globalLimit, 4);
  assert.equal(settings.data.projects[0]?.limit, 2);
  const recovery = await api.readAssignmentRecovery(assignmentId);
  assert.equal(recovery.data.assignment.assignmentId, assignmentId);
  assert.equal(recovery.data.evidenceAvailable, false);
  assert.equal(recovery.data.records.length, 0);
  assert.equal(JSON.stringify(recovery).includes("private"), false);
});

test("recovery aggregates omitted old ownership after Resume separately from task-wide Stop and newer receipt", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Recovery",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Recovery task",
    outcome: "Done",
    ready: false,
  });
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  seedOperatorRecovery(f, { projectId, taskId, assignmentId });
  f.seedPersistedState((db) => {
    for (const workId of ["foreign-record", "unbound-record"]) {
      db.prepare(
        "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'Private','/private','held',NULL,NULL,NULL,'chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId);
      db.prepare(
        "INSERT INTO execution_recovery_identities(workId,workRevision,requestSequence) VALUES (?,1,99)",
      ).run(workId);
      if (workId === "foreign-record")
        db.prepare(
          "INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
        ).run(workId, randomUUID(), assignmentId);
    }
  });

  const stopped = (await api.readAssignmentRecovery(assignmentId)).data;
  assert.equal(stopped.holds.stop, true);
  assert.ok(stopped.records.every((r) => r.holds.stop));
  await f.service.resumeTask(taskId);
  const after = (await api.readAssignmentRecovery(assignmentId)).data;
  assert.deepEqual(after.holds, {
    stop: false,
    task: false,
    writer: true,
    capacity: true,
    uncertainty: true,
  });
  assert.equal(after.held, true);
  assert.equal(after.omittedCount, 1);
  assert.equal(after.records.length, 20);
  assert.equal(after.records[0]?.generation.requestSequence, 2);
  assert.equal(after.records.at(-1)?.generation.requestSequence, 21);
  assert.ok(
    after.records.every(
      (r) => r.workId !== "foreign-record" && r.workId !== "unbound-record",
    ),
  );
  assert.ok(
    after.records.every(
      (r) =>
        !r.holds.writer &&
        !r.holds.capacity &&
        !r.holds.uncertainty &&
        !r.holds.stop,
    ),
  );
  assert.equal(after.records.at(-1)?.receiptRecorded, true);
  assert.equal(JSON.stringify(after).includes("PRIVATE"), false);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_holds (taskId,reason) VALUES (?,'PRIVATE HOLD REASON')",
      )
      .run(taskId),
  );
  assert.equal(
    (await api.readAssignmentRecovery(assignmentId)).data.holds.task,
    true,
  );
});

test("post-commit configuration notification failure stays uncertain and exact receipt replay does not reapply", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  let failure = true;
  const store = new DomainStore(db, () => {
    if (failure)
      throw new DomainPolicyError(
        "invalid-input",
        "PRIVATE POSTCOMMIT DIAGNOSTIC",
      );
  });
  const command = {
    type: "project.create" as const,
    actor: "operator" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Recorded once",
    leadProfileId: null,
  };
  assert.throws(
    () => store.execute(command),
    (e) =>
      e instanceof Error &&
      !(e instanceof DomainPolicyError) &&
      e.message === "Command committed but change notification failed",
  );
  failure = false;
  const original = store.recordedCommand(command);
  assert.ok(original);
  assert.deepEqual(store.execute(command), original);
  assert.equal(store.project(command.projectId).version, 1);
});
test("private labels are unavailable for editing and strict public configuration rejects authority extensions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    profileId = randomUUID(),
    projectId = randomUUID();
  await api.execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "PRIVATE SECRET PROFILE",
    instructions: "PRIVATE SECRET PROFILE",
    capabilities: "Capabilities PRIVATE SECRET PROFILE",
  });
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "PRIVATE SECRET PROFILE",
    leadProfileId: null,
  });
  const profile = await api.readProfileConfiguration(profileId),
    project = await api.readProjectConfiguration(projectId);
  assert.equal(profile.data.profile.name, null);
  assert.equal(project.data.project.name, null);
  assert.equal(
    JSON.stringify({ profile, project }).includes("PRIVATE SECRET PROFILE"),
    false,
  );
  for (const type of [
    "github.activate",
    "recovery.resolve",
    "imported-blockers.set",
  ]) {
    await assert.rejects(
      api.execute({ type, key: randomUUID(), projectId, actor: "operator" }),
    );
  }
  await assert.rejects(
    api.execute({
      type: "project.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      actor: "operator",
      instructions: "New",
    }),
  );
  assert.equal(f.service.domain().project(projectId).version, 1);
});

test("delivery and source credential reference, key and value are excluded from public configuration and receipts", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const envKey = "UI06_FAKE_DELIVERY_REDACTION",
    previous = process.env[envKey],
    hadKey = Object.hasOwn(process.env, envKey),
    envValue = "UI06_FAKE_PRIVATE_DELIVERY_VALUE",
    reference = `env:${envKey}`;
  process.env[envKey] = envValue;
  t.after(() => {
    if (hadKey) process.env[envKey] = previous;
    else delete process.env[envKey];
  });
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  for (const privateText of [reference, envKey, envValue]) {
    const projectId = randomUUID(),
      profileId = randomUUID(),
      taskId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: privateText,
      instructions: "Ordinary instructions",
      capabilities: privateText,
    });
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: privateText,
      leadProfileId: profileId,
    });
    d.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: reference,
      grants: [],
      requiredChecks: [],
    });
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [],
      repositories: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: privateText }],
      },
    });
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: privateText,
      outcome: privateText,
      ready: false,
    });
    const receipt = await api.execute({
      type: "profile.configure",
      key: randomUUID(),
      profileId,
      expectedVersion: 1,
      name: privateText,
    });
    const publicData = {
      workspace: await api.readWorkspace(),
      project: await api.readProjectConfiguration(projectId),
      profile: await api.readProfileConfiguration(profileId),
      task: await api.readTask(taskId),
      receipt,
    };
    for (const excluded of [reference, envKey, envValue])
      assert.equal(
        JSON.stringify(publicData).includes(excluded),
        false,
        "private delivery material excluded",
      );
    assert.equal(publicData.project.data.project.name, null);
    assert.equal(publicData.project.data.source.readiness, null);
    assert.equal(publicData.profile.data.capabilities, "[redacted]");
    await assert.rejects(
      api.execute({
        type: "delivery.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: 2,
        mode: "reviewable-pr",
        credentialRef: reference,
        grants: [],
        requiredChecks: [],
      }),
    );
  }
  assert.equal(f.runtime.turns, 0);
});

test("unavailable delivery exclusions fail closed without replacing safe labels with private material", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const projectId = randomUUID(),
    api = new OperatorApi(f.service, [f.directory]);
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Project label",
    leadProfileId: null,
  });
  const original = DomainStore.prototype.deliveryCredentialReference;
  DomainStore.prototype.deliveryCredentialReference = () => {
    throw Error("private lookup failure");
  };
  try {
    const result = await api.readProjectConfiguration(projectId);
    assert.equal(result.data.project.name, null);
    assert.equal(
      JSON.stringify(result).includes("private lookup failure"),
      false,
    );
  } finally {
    DomainStore.prototype.deliveryCredentialReference = original;
  }
  assert.equal(f.runtime.turns, 0);
});
