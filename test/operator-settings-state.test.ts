import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { OperatorClient } from "../web/src/api.js";
import { ConfigurationDraft } from "../web/src/settings-state.js";
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
