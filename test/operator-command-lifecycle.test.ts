import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operatorCommandSchema,
  type CommandReceipt,
} from "../src/operator/contracts.js";
import { CommandLifecycle } from "../web/src/command-lifecycle.js";
const command = operatorCommandSchema.options[0].parse({
  type: "task.create",
  key: "00000000-0000-4000-8000-000000000001",
  taskId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  title: "Task",
  outcome: "Finish",
  ready: false,
});
const receipt: CommandReceipt = {
  kind: "domain",
  key: command.key,
  recorded: true,
  result: {
    id: command.taskId,
    projectId: command.projectId,
    state: "open",
    ready: false,
    version: 1,
  },
};
const matches = (c: typeof command, r: CommandReceipt) =>
  r.kind === "domain" &&
  "state" in r.result &&
  r.result.id === c.taskId &&
  r.result.projectId === c.projectId &&
  r.result.version === 1;
test("uncertain command keeps an immutable original snapshot through deliberate reconciliation", () => {
  const lifecycle = new CommandLifecycle<typeof command>();
  const input = structuredClone(command);
  assert.equal(lifecycle.freeze(input), true);
  input.title = "Changed input";
  const view = lifecycle.frozen;
  assert.ok(view);
  view.title = "Changed view";
  assert.equal(lifecycle.begin()?.title, "Task");
  assert.equal(lifecycle.begin(), null);
  assert.equal(
    lifecycle.settle(
      { state: "unknown", command, code: "command-outcome-unknown" },
      matches,
    ),
    "unknown",
  );
  assert.equal(
    lifecycle.freeze({ ...command, key: crypto.randomUUID() }),
    false,
  );
  assert.equal(lifecycle.begin()?.key, command.key);
  assert.equal(lifecycle.uncertain, true);
  assert.equal(
    lifecycle.settle(
      { state: "rejected", command, code: "forbidden" },
      matches,
    ),
    "unknown",
  );
  assert.equal(lifecycle.bytes, JSON.stringify(command));
  lifecycle.begin();
  assert.equal(
    lifecycle.settle({ state: "recorded", receipt }, matches),
    "recorded",
  );
  assert.equal(lifecycle.begin(), null);
  assert.equal(lifecycle.freeze(command), false);
  assert.deepEqual(lifecycle.receipt, receipt);
});
test("first definite failures clear the operation; restoration, key correlation and reset stay explicit", () => {
  for (const state of ["rejected", "conflict"] as const) {
    const l = new CommandLifecycle<typeof command>();
    l.freeze(command);
    l.begin();
    assert.equal(l.settle({ state, command, code: state }, matches), state);
    assert.equal(l.frozen, null);
    assert.equal(l.bytes, null);
    assert.equal(l.freeze(command), true);
  }
  const l = new CommandLifecycle<typeof command>();
  l.restoreUnknown(command);
  assert.equal(l.uncertain, true);
  assert.equal(l.bytes, JSON.stringify(command));
  assert.equal(l.freeze(command), false);
  l.begin();
  assert.equal(
    l.settle(
      { state: "recorded", receipt: { ...receipt, key: crypto.randomUUID() } },
      () => true,
    ),
    "unknown",
  );
  l.begin();
  assert.equal(
    l.settle({ state: "conflict", command, code: "conflict" }, matches),
    "unknown",
  );
  l.reset();
  assert.equal(l.uncertain, false);
  assert.equal(l.receipt, null);
  assert.equal(l.begin(), null);
  assert.equal(l.freeze(command), true);
  l.begin();
  assert.equal(
    l.settle(
      {
        state: "recorded",
        receipt: {
          ...receipt,
          result: { ...receipt.result, id: crypto.randomUUID() },
        },
      },
      matches,
    ),
    "unknown",
  );
});
test("configuration revision and omitted fields remain original through uncertainty", () => {
  const c = operatorCommandSchema.parse({
    type: "profile.configure",
    key: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    expectedVersion: 3,
    instructions: "PRIVATE SYNTHETIC",
  });
  const l = new CommandLifecycle<typeof c>();
  const r: CommandReceipt = {
    kind: "configuration",
    recorded: true,
    key: c.key,
    result: {
      commandType: "profile.configure",
      resourceId: "profileId" in c ? c.profileId : "",
      version: 4,
      revoked: false,
    },
  };
  const predicate = (original: typeof c, receipt: CommandReceipt) =>
    original.type === "profile.configure" &&
    receipt.kind === "configuration" &&
    receipt.result.commandType === "profile.configure" &&
    receipt.result.resourceId === original.profileId &&
    receipt.result.version === original.expectedVersion + 1;
  l.freeze(c);
  l.begin();
  l.settle(
    { state: "unknown", command: c, code: "command-outcome-unknown" },
    predicate,
  );
  assert.equal(l.bytes, JSON.stringify(c));
  const frozen = l.frozen;
  assert.ok(frozen);
  assert.equal(Object.hasOwn(frozen, "name"), false);
  l.begin();
  assert.equal(
    l.settle(
      {
        state: "recorded",
        receipt: {
          ...r,
          result: {
            commandType: "profile.configure",
            resourceId: "profileId" in c ? c.profileId : "",
            version: 9,
            revoked: false,
          },
        },
      },
      predicate,
    ),
    "unknown",
  );
  l.begin();
  assert.equal(
    l.settle({ state: "recorded", receipt: r }, predicate),
    "recorded",
  );
  const view = l.receipt;
  assert.ok(view);
  view.key = crypto.randomUUID();
  assert.equal(l.receipt?.key, c.key);
});
test("a receipt predicate cannot mutate the original command used for later reconciliation", () => {
  const lifecycle = new CommandLifecycle<typeof command>();
  lifecycle.freeze(command);
  lifecycle.begin();
  assert.equal(
    lifecycle.settle({ state: "recorded", receipt }, (view) => {
      view.projectId = crypto.randomUUID();
      view.title = "Changed by predicate";
      return false;
    }),
    "unknown",
  );
  assert.deepEqual(lifecycle.begin(), command);
  assert.equal(lifecycle.bytes, JSON.stringify(command));
});
