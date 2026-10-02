import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { OperatorClient } from "../web/src/api.js";
import {
  ConfigurationDraft,
  ConfigurationDrafts,
} from "../web/src/settings-state.js";
test("unknown private configuration remains frozen after later rejection and deliberate reconciliation uses original bytes", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const client = new OperatorClient(async (_url, init) => {
    calls.push(String(init?.body));
    attempt++;
    if (attempt === 1) throw Error("lost");
    if (attempt === 2)
      return Response.json(
        { error: { code: "conflict", message: "Conflict" } },
        { status: 409 },
      );
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "profile.configure",
        resourceId: c.profileId,
        version: 4,
        revoked: false,
      },
    });
  });
  const draft = new ConfigurationDraft();
  draft.set("instructions", "PRIVATE NEW INSTRUCTIONS");
  const c = {
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    expectedVersion: 3,
    instructions: "PRIVATE NEW INSTRUCTIONS",
  };
  await draft.submit(client, c, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.equal(draft.set("instructions", "changed"), false);
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "unknown");
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(JSON.parse(calls[0] ?? "null"), c);
  assert.deepEqual(calls, [calls[0], calls[0], calls[0]]);
  draft.purge();
  assert.equal(draft.frozen, null);
  assert.deepEqual(draft.values, {});
});
test("safe inline rejection preserves editable input and purge suppresses delayed command completion", async () => {
  const draft = new ConfigurationDraft();
  draft.set("name", "Entered name");
  draft.set("instructions", "PRIVATE");
  const c = {
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    expectedVersion: 1,
    name: "Entered name",
    instructions: "PRIVATE",
  };
  const reject = new OperatorClient(async () =>
    Response.json(
      {
        error: {
          code: "invalid-input",
          message: "Check input",
          fieldPaths: ["name"],
        },
      },
      { status: 400 },
    ),
  );
  await draft.submit(reject, c, "csrf");
  assert.equal(draft.phase, "rejected");
  assert.equal(draft.values.instructions, "PRIVATE");
  assert.equal(draft.errors.name, "Check this field.");
  assert.equal(draft.set("name", "Corrected"), true);
  let finish!: (r: Response) => void;
  const slow = new OperatorClient(
    async () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  const sending = draft.submit(slow, c, "csrf");
  draft.purge();
  finish(
    Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "profile.configure",
        resourceId: c.profileId,
        version: 2,
        revoked: false,
      },
    }),
  );
  await sending;
  assert.deepEqual(draft.values, {});
  assert.equal(draft.receipt, null);
  assert.equal(draft.frozen, null);
});
test("configuration cannot accept another command's otherwise valid recorded receipt", async () => {
  const c = {
    type: "project.configure" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    expectedVersion: 2,
    name: "Name",
  };
  for (const result of [
    {
      commandType: "project.configure",
      resourceId: randomUUID(),
      version: 3,
      paused: true,
      leadProfileId: null,
      instructionsRevision: 1,
    },
    {
      commandType: "project.configure",
      resourceId: c.projectId,
      version: 4,
      paused: true,
      leadProfileId: null,
      instructionsRevision: 1,
    },
    {
      commandType: "profile.configure",
      resourceId: c.projectId,
      version: 3,
      revoked: false,
    },
  ]) {
    const d = new ConfigurationDraft(),
      client = new OperatorClient(async () =>
        Response.json({
          kind: "configuration",
          key: c.key,
          recorded: true,
          result,
        }),
      );
    await d.submit(client, c, "csrf");
    assert.equal(d.phase, "unknown");
    assert.equal(d.set("name", "changed"), false);
  }
});
test("placement receipt must confirm the exact frozen chosen project", async () => {
  const command = {
    type: "github.place" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    chosenProjectId: randomUUID(),
    expectedVersion: 2,
  };
  let chosen = randomUUID();
  const sent: string[] = [];
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: command.key,
      recorded: true,
      result: {
        commandType: "github.place",
        resourceId: command.taskId,
        projectId: chosen,
        version: 3,
      },
    });
  });
  const draft = new ConfigurationDraft();
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.equal(draft.receipt, null);
  assert.equal(draft.set("chosenProjectId", randomUUID()), false);
  const original = draft.bytes;
  chosen = command.chosenProjectId;
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(sent, [original, original]);
});

test("one task placement keeps its initiating project separate from the immutable owner command", async () => {
  const drafts = new ConfigurationDrafts(),
    taskId = randomUUID(),
    owner = randomUUID(),
    origin = randomUUID();
  const draft = drafts.get(`github.place:${taskId}`, () => {}),
    key = randomUUID();
  draft.initialize({
    key,
    expectedVersion: "1",
    chosenProjectId: origin,
    placementOriginProjectId: origin,
  });
  draft.set("chosenProjectId", origin);
  const command = {
    type: "github.place" as const,
    key,
    projectId: owner,
    taskId,
    chosenProjectId: origin,
    expectedVersion: 1,
  };
  const sent: string[] = [];
  let attempt = 0;
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    if (++attempt === 1) throw Error("lost committed response");
    return Response.json({
      kind: "configuration",
      recorded: true,
      key,
      result: {
        commandType: "github.place",
        resourceId: taskId,
        projectId: origin,
        version: 2,
      },
    });
  });
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.deepEqual(drafts.unsettledPlacements(origin), [command]);
  assert.equal(drafts.unsettledPlacements(owner).length, 0);
  assert.equal(
    drafts.get(`github.place:${taskId}`, () => {}),
    draft,
  );
  assert.equal(draft.set("placementOriginProjectId", owner), false);
  assert.equal(draft.set("chosenProjectId", owner), false);
  assert.equal(
    draft.frozen?.type === "github.place" && draft.frozen.projectId,
    owner,
  );
  assert.equal(
    JSON.parse(draft.bytes ?? "null").placementOriginProjectId,
    undefined,
  );
  await draft.reconcile(client, "csrf");
  assert.deepEqual(JSON.parse(sent[0] ?? "null"), command);
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.equal(drafts.placementReceipts(origin).length, 1);
  assert.equal(drafts.placementReceipts(owner).length, 0);
  assert.equal(
    drafts.placementReceipts(origin)[0]?.result.commandType,
    "github.place",
  );
  drafts.purge();
  assert.deepEqual(draft.values, {});
  assert.equal(drafts.placementReceipts(origin).length, 0);
});

test("placement adopts a loaded revision explicitly after definite conflict but never after unknown", async () => {
  const owner = randomUUID(),
    taskId = randomUUID(),
    chosen = randomUUID(),
    initialKey = randomUUID();
  const command = {
    type: "github.place" as const,
    key: initialKey,
    projectId: owner,
    taskId,
    chosenProjectId: chosen,
    expectedVersion: 1,
  };
  const draft = new ConfigurationDraft();
  draft.initialize({
    key: initialKey,
    expectedVersion: "1",
    chosenProjectId: "",
    placementOriginProjectId: chosen,
  });
  draft.set("chosenProjectId", chosen);
  let attempt = 0;
  const sent: string[] = [];
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    if (++attempt === 1)
      return Response.json(
        { error: { code: "conflict", message: "Conflict" } },
        { status: 409 },
      );
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "github.place",
        resourceId: taskId,
        projectId: chosen,
        version: 3,
      },
    });
  });
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "conflict");
  draft.initialize({
    key: randomUUID(),
    expectedVersion: "2",
    chosenProjectId: "",
  });
  assert.equal(draft.values.expectedVersion, "1");
  assert.equal(draft.values.key, initialKey);
  assert.equal(draft.values.chosenProjectId, chosen);
  draft.adoptVersion(2);
  assert.equal(draft.phase, "editing");
  assert.equal(draft.values.expectedVersion, "2");
  assert.notEqual(draft.values.key, initialKey);
  assert.equal(draft.values.chosenProjectId, chosen);
  assert.equal(draft.values.placementOriginProjectId, chosen);
  await draft.submit(
    client,
    { ...command, key: draft.values.key, expectedVersion: 2 },
    "csrf",
  );
  assert.equal(draft.phase, "recorded");
  assert.equal(JSON.parse(sent[1] ?? "null").expectedVersion, 2);
  assert.equal(JSON.parse(sent[1] ?? "null").projectId, owner);
  const unknown = new ConfigurationDraft();
  unknown.initialize({
    key: initialKey,
    expectedVersion: "1",
    chosenProjectId: chosen,
    placementOriginProjectId: chosen,
  });
  const lost = new OperatorClient(async () => {
    throw Error("lost");
  });
  await unknown.submit(lost, command, "csrf");
  const bytes = unknown.bytes,
    frozen = structuredClone(unknown.frozen),
    values = structuredClone(unknown.values);
  const conflict = new OperatorClient(async () =>
    Response.json(
      { error: { code: "conflict", message: "Conflict" } },
      { status: 409 },
    ),
  );
  await unknown.reconcile(conflict, "csrf");
  unknown.adoptVersion(2);
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.bytes, bytes);
  assert.deepEqual(unknown.frozen, frozen);
  assert.deepEqual(unknown.values, values);
});
test("configuration frozen views cannot redirect placement identity or its origin projections", async () => {
  const drafts = new ConfigurationDrafts();
  const owner = randomUUID(),
    origin = randomUUID(),
    destination = randomUUID(),
    taskId = randomUUID();
  const command = {
    type: "github.place" as const,
    key: randomUUID(),
    projectId: owner,
    taskId: taskId,
    chosenProjectId: destination,
    expectedVersion: 1,
  };
  const draft = drafts.get(`github.place:${taskId}`, () => {});
  draft.initialize({
    placementOriginProjectId: origin,
    chosenProjectId: destination,
  });
  await draft.submit(
    new OperatorClient(async () => {
      throw Error("lost");
    }),
    command,
    "csrf",
  );
  const view = draft.frozen;
  assert.ok(view);
  if (view.type === "github.place") {
    view.projectId = origin;
    view.chosenProjectId = origin;
  }
  assert.deepEqual(draft.frozen, command);
  assert.deepEqual(drafts.unsettledPlacements(origin), [command]);
  assert.deepEqual(drafts.unsettledPlacements(owner), []);
  assert.deepEqual(drafts.unsettledPlacements(destination), []);
  assert.equal(
    JSON.parse(draft.bytes ?? "null").placementOriginProjectId,
    undefined,
  );
});
test("private uncertainty survives every later definite failure while edits adoption and new operations stay blocked", async () => {
  for (const [status, code] of [
    [400, "invalid-input"],
    [403, "forbidden"],
    [409, "conflict"],
  ] as const) {
    const draft = new ConfigurationDraft();
    draft.initialize({
      instructions: "PRIVATE",
      expectedVersion: "3",
      key: randomUUID(),
    });
    const command = {
      type: "profile.configure" as const,
      key: randomUUID(),
      profileId: randomUUID(),
      expectedVersion: 3,
      instructions: "PRIVATE",
    };
    const sent: string[] = [];
    let attempt = 0;
    const client = new OperatorClient(async (_url, init) => {
      sent.push(String(init?.body));
      if (++attempt === 1) throw Error("lost");
      return Response.json(
        { error: { code, message: "Safe failure" } },
        { status },
      );
    });
    await draft.submit(client, command, "csrf");
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "unknown");
    assert.equal(draft.set("instructions", "changed"), false);
    draft.adoptVersion(20);
    draft.startOperation({ instructions: "changed" });
    await draft.submit(client, { ...command, key: randomUUID() }, "csrf");
    assert.equal(draft.values.instructions, "PRIVATE");
    assert.equal(draft.frozen?.key, command.key);
    assert.deepEqual(JSON.parse(sent[0] ?? "null"), command);
    assert.deepEqual(sent, [sent[0], sent[0]]);
  }
});
test("complete configuration receipt predicates keep schema-valid mismatches unknown until exact replay", async () => {
  const projectId = randomUUID(),
    profileId = randomUUID();
  const cases = [
    {
      command: {
        type: "profile.create",
        key: randomUUID(),
        profileId,
        name: "New profile",
        instructions: "Synthetic",
        capabilities: "Coordinate",
      },
      result: {
        commandType: "profile.create",
        resourceId: profileId,
        version: 1,
        revoked: false,
      },
      changes: [{ version: 2 }, { resourceId: randomUUID() }],
    },
    {
      command: {
        type: "project.create",
        key: randomUUID(),
        projectId,
        name: "New project",
        leadProfileId: null,
      },
      result: {
        commandType: "project.create",
        resourceId: projectId,
        version: 1,
        paused: true,
        leadProfileId: null,
        instructionsRevision: 1,
      },
      changes: [{ version: 2 }, { resourceId: randomUUID() }],
    },
    {
      command: {
        type: "profile.configure",
        key: randomUUID(),
        profileId,
        expectedVersion: 3,
        name: "Name",
      },
      result: {
        commandType: "profile.configure",
        resourceId: profileId,
        version: 4,
        revoked: false,
      },
      changes: [
        { resourceId: randomUUID() },
        { version: 5 },
        { commandType: "profile.create", version: 1 },
      ],
    },
    {
      command: {
        type: "github.preview",
        key: randomUUID(),
        projectId,
        expectedVersion: 2,
        selectionId: "selection",
      },
      result: {
        commandType: "github.preview",
        resourceId: projectId,
        configVersion: 2,
        selectionId: "selection",
        active: true,
      },
      changes: [
        { selectionId: "another" },
        { configVersion: 3 },
        { active: false },
        { resourceId: randomUUID() },
      ],
    },
    {
      command: {
        type: "capacity.configure",
        key: randomUUID(),
        globalLimit: 4,
        projectOverrides: { [projectId]: null, [profileId]: 2 },
      },
      result: {
        commandType: "capacity.configure",
        resourceId: "system:capacity",
        globalLimit: 4,
        defaultProjectLimit: 2,
        projectOverrides: { [profileId]: 2 },
      },
      changes: [
        { resourceId: "system:other" },
        { globalLimit: 5 },
        { projectOverrides: { [projectId]: 1, [profileId]: 2 } },
        { projectOverrides: { [profileId]: 3 } },
      ],
    },
  ];
  for (const entry of cases) {
    for (const change of [
      ...entry.changes,
      { key: randomUUID() },
      { kind: "coordination" },
    ]) {
      const draft = new ConfigurationDraft();
      let mismatch = true;
      const client = new OperatorClient(async () => {
        const changed = mismatch ? change : {};
        if ("kind" in changed)
          return Response.json({
            kind: "coordination",
            key: entry.command.key,
            recorded: true,
            eventId: randomUUID(),
            taskId: randomUUID(),
            recipientAssignmentId: randomUUID(),
            eventType: "message",
            createdAt: 1,
          });
        return Response.json({
          kind: "configuration",
          key: "key" in changed ? changed.key : entry.command.key,
          recorded: true,
          result: { ...entry.result, ...("key" in changed ? {} : changed) },
        });
      });
      await draft.submit(client, entry.command, "csrf");
      assert.equal(draft.phase, "unknown", JSON.stringify(change));
      assert.equal(draft.receipt, null);
      mismatch = false;
      await draft.reconcile(client, "csrf");
      assert.equal(draft.phase, "recorded", JSON.stringify(entry.command));
    }
  }
});
