import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorClient } from "../web/src/api.js";
import { ComposerState, storageKey } from "../web/src/composer-state.js";
test("frozen recovery persistence is a prerequisite to every task creation POST", async () => {
  let posts = 0;
  const saved = new Map<string, string>();
  let fail = false;
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fail) throw Error("quota");
      saved.set(k, v);
    },
    removeItem: (k: string) => saved.delete(k),
  };
  const client = new OperatorClient(async () => {
    posts++;
    return new Response("{}", { status: 503 });
  });
  const state = new ComposerState(storage);
  state.edit({
    projectId: randomUUID(),
    title: "Last saved",
    outcome: "A useful outcome",
  });
  const last = saved.get(storageKey);
  assert.ok(last);
  fail = true;
  state.edit({ title: "Newer unsaved edit" });
  await state.submit(client, "csrf", false);
  assert.equal(posts, 0);
  assert.equal(state.phase, "editable");
  assert.equal(state.input.title, "Newer unsaved edit");
  assert.equal(saved.get(storageKey), last);
  assert.match(state.notice, /not sent|recovery unavailable/i);
  const restored = new ComposerState(storage);
  assert.equal(restored.input.title, "Last saved");
});

test("only an exact original task receipt confirms a frozen submission", async () => {
  for (const mismatch of [
    "key",
    "task",
    "project",
    "ready",
    "version",
    "kind",
  ]) {
    const storage = memoryStorage();
    const state = new ComposerState(storage);
    state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
    const client = new OperatorClient(async (_path, init) => {
      const command = JSON.parse(String(init?.body));
      const receipt =
        mismatch === "kind"
          ? {
              kind: "coordination",
              key: command.key,
              recorded: true,
              eventId: randomUUID(),
              taskId: command.taskId,
              recipientAssignmentId: randomUUID(),
              eventType: "message",
              createdAt: 1,
            }
          : {
              kind: "domain",
              key: mismatch === "key" ? randomUUID() : command.key,
              recorded: true,
              result: {
                id: mismatch === "task" ? randomUUID() : command.taskId,
                projectId:
                  mismatch === "project" ? randomUUID() : command.projectId,
                version: mismatch === "version" ? 2 : 1,
                state: "open",
                ready: mismatch === "ready" ? !command.ready : command.ready,
              },
            };
      return new Response(JSON.stringify(receipt), { status: 200 });
    });
    await state.submit(client, "csrf", true);
    assert.equal(state.phase, "unknown", mismatch);
    assert.ok(state.frozen);
    assert.ok(storage.getItem(storageKey));
  }
});
function memoryStorage() {
  const bytes = new Map<string, string>();
  return {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bytes.set(key, value);
    },
    removeItem: (key: string) => {
      bytes.delete(key);
    },
  };
}

import { OperatorApi } from "../src/standalone/operator-api.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import {
  byteLength,
  encodeOutcome,
  encodeRecovery,
  readRecovery,
  recoveryLimit,
} from "../web/src/composer-state.js";
test("unknown task creation freezes original command across reload and cannot rekey after authentication failure", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    blocker = randomUUID();
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
    name: "Project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "Finish",
    ready: false,
  });
  let api = new OperatorApi(f.service, [f.directory]);
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  state.edit({
    projectId,
    title: "One task",
    outcome: "Ship",
    blockerTaskIds: [blocker],
    profileId,
  });
  let posts = 0;
  const sent: string[] = [];
  const lost = new OperatorClient(async (_path, init) => {
    posts++;
    sent.push(String(init?.body));
    await api.execute(JSON.parse(String(init?.body)));
    throw Error("lost response");
  });
  await state.submit(lost, "csrf", true);
  assert.equal(state.phase, "unknown");
  assert.equal(posts, 1);
  const original = JSON.stringify(state.frozen);
  const restored = new ComposerState(storage);
  assert.equal(posts, 1);
  assert.equal(restored.phase, "unknown");
  assert.equal(JSON.stringify(restored.frozen), original);
  restored.edit({ title: "Must not change" });
  assert.equal(restored.input.title, "One task");
  for (const [status, code] of [
    [401, "unauthenticated"],
    [403, "forbidden"],
    [503, "unavailable"],
    [400, "invalid-input"],
    [409, "conflict"],
  ] as const) {
    const rejected = new OperatorClient(async (_path, init) => {
      posts++;
      sent.push(String(init?.body));
      return new Response(
        JSON.stringify({ error: { code, message: "Safe failure" } }),
        { status },
      );
    });
    await restored.submit(rejected, "csrf", false);
    assert.equal(restored.phase, "unknown");
    assert.equal(JSON.stringify(restored.frozen), original);
  }
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  const replay = new OperatorClient(async (_path, init) => {
    posts++;
    sent.push(String(init?.body));
    return new Response(
      JSON.stringify(await api.execute(JSON.parse(String(init?.body)))),
      { status: 200 },
    );
  });
  await restored.submit(replay, "csrf", false);
  assert.equal(restored.phase, "recorded");
  assert.ok(sent.every((bytes) => bytes === original));
  assert.equal(storage.getItem(storageKey), null);
  const tasks = f.service.domain().tasks(projectId);
  assert.equal(tasks.length, 2);
  const taskId = restored.frozen?.taskId;
  assert.ok(taskId);
  assert.deepEqual(f.service.domain().dependencies(taskId), [blocker]);
  assert.equal(f.service.domain().assignments(taskId).length, 1);
  assert.equal(f.runtime.turns, 0);
});
test("composer validates encoded command bytes and preserves editable invalid fields", async () => {
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  let posts = 0;
  const client = new OperatorClient(async () => {
    posts++;
    throw Error("not expected");
  });
  state.edit({
    projectId: randomUUID(),
    title: " ",
    outcome: " ",
    links: ["file:///private"],
  });
  await state.submit(client, "csrf", false);
  assert.equal(posts, 0);
  assert.ok(state.errors.title);
  assert.ok(state.errors.outcome);
  assert.ok(state.errors.links);
  assert.equal(state.input.links[0], "file:///private");
  state.edit({ title: "x".repeat(512), outcome: "x".repeat(16000), links: [] });
  assert.equal(encodeOutcome(state.input).length, 16000);
  await state.submit(client, "csrf", false);
  assert.equal(posts, 1);
  const frozen = state.frozen;
  assert.ok(frozen);
  assert.ok(byteLength(JSON.stringify(frozen)) <= 65536);
  assert.ok(
    byteLength(
      encodeRecovery({
        version: 1,
        status: "unknown",
        input: state.input,
        command: frozen,
      }),
    ) < recoveryLimit,
  );
  const wide = new ComposerState(memoryStorage());
  wide.edit({
    projectId: randomUUID(),
    title: "Task",
    outcome: "\u0000".repeat(16000),
  });
  await wide.submit(client, "csrf", false);
  assert.equal(posts, 1);
  assert.match(wide.errors.outcome ?? "", /64 KiB/);
  const combined = new ComposerState(memoryStorage());
  combined.edit({
    projectId: randomUUID(),
    title: "Task",
    outcome: "x".repeat(16000),
    context: "extra",
  });
  await combined.submit(client, "csrf", false);
  assert.equal(posts, 1);
  assert.match(combined.errors.outcome ?? "", /16,000/);
});
test("recovery has symmetric UTF-8 bounds and rejects malformed unknown versions", () => {
  const storage = memoryStorage();
  for (const bytes of [
    "{bad",
    JSON.stringify({ version: 2, status: "unfinished", input: {} }),
    "x".repeat(recoveryLimit + 1),
  ]) {
    storage.setItem(storageKey, bytes);
    assert.equal(readRecovery(storage), null);
  }
  const state = new ComposerState(memoryStorage());
  const base = {
    version: 1 as const,
    status: "unfinished" as const,
    input: state.input,
  };
  const overhead = byteLength(encodeRecovery(base));
  const exact = {
    ...base,
    input: { ...base.input, outcome: "x".repeat(recoveryLimit - overhead) },
  };
  assert.equal(byteLength(encodeRecovery(exact)), recoveryLimit);
  assert.throws(
    () =>
      encodeRecovery({
        ...exact,
        input: { ...exact.input, outcome: `${exact.input.outcome}x` },
      }),
    /recovery-too-large/,
  );
  storage.setItem(storageKey, encodeRecovery(exact));
  assert.ok(readRecovery(storage));
});

test("recovered frozen commands must agree with their validated input", () => {
  const state = new ComposerState(memoryStorage());
  const input = {
    ...state.input,
    projectId: randomUUID(),
    title: "Task",
    outcome: "Finish",
  };
  const command = {
    type: "task.create" as const,
    key: randomUUID(),
    projectId: input.projectId,
    taskId: randomUUID(),
    title: "Different title",
    outcome: "Finish",
    ready: true,
  };
  assert.throws(() =>
    encodeRecovery({ version: 1, status: "unknown", input, command }),
  );
});
test("failed frozen readback sends no POST and reconciliation also requires storage readback", async () => {
  const storage = memoryStorage(),
    state = new ComposerState(storage);
  state.edit({ projectId: randomUUID(), title: "Task", outcome: "Finish" });
  let posts = 0,
    broken = false;
  const originalGet = storage.getItem;
  storage.getItem = (k) => (broken ? null : originalGet(k));
  broken = true;
  await state.submit(
    new OperatorClient(async () => {
      posts++;
      throw Error("unexpected");
    }),
    "csrf",
    true,
  );
  assert.equal(posts, 0);
  assert.equal(state.phase, "editable");
  assert.equal(state.input.title, "Task");
  broken = false;
  const unknown = new ComposerState(storage);
  assert.equal(unknown.phase, "unknown");
  const frozen = JSON.stringify(unknown.frozen);
  broken = true;
  await unknown.submit(
    new OperatorClient(async () => {
      posts++;
      throw Error("unexpected");
    }),
    "csrf",
    false,
  );
  assert.equal(posts, 0);
  assert.equal(unknown.phase, "unknown");
  assert.equal(JSON.stringify(unknown.frozen), frozen);
});

test("valid multibyte selected input fits recovery and exact HTTP byte boundary rejects one byte over", async () => {
  let posts = 0;
  const client = new OperatorClient(async () => {
    posts++;
    throw Error("Fixture lost response");
  });
  const state = new ComposerState(memoryStorage());
  state.edit({
    projectId: randomUUID(),
    title: "😀".repeat(256),
    outcome: "界".repeat(6000),
    context: "é".repeat(2000),
    links: Array.from(
      { length: 32 },
      (_, i) => `https://example.com/reference/${i}`,
    ),
    profileId: randomUUID(),
    blockerTaskIds: Array.from({ length: 128 }, () => randomUUID()),
  });
  await state.submit(client, "csrf", true);
  assert.equal(posts, 1);
  assert.equal(state.phase, "unknown");
  assert.ok(state.frozen);
  assert.equal(state.frozen.blockerTaskIds?.length, 128);
  assert.ok(byteLength(JSON.stringify(state.frozen)) <= 65536);
  assert.ok(
    byteLength(
      encodeRecovery({
        version: 1,
        status: "unknown",
        input: state.input,
        command: state.frozen,
      }),
    ) < recoveryLimit,
  );
  const projectId = randomUUID(),
    title = "Byte boundary",
    base = {
      type: "task.create",
      key: randomUUID(),
      projectId,
      taskId: randomUUID(),
      title,
      outcome: "",
      ready: true,
    };
  const control = "\u0000".repeat(10800),
    padding = 65536 - byteLength(JSON.stringify({ ...base, outcome: control }));
  assert.ok(padding > 0);
  const outcome = control + "x".repeat(padding);
  const exactStorage = memoryStorage();
  const exact = new ComposerState(exactStorage);
  exact.edit({ projectId, title, outcome });
  await exact.submit(client, "csrf", true);
  assert.equal(posts, 2);
  assert.equal(exact.phase, "unknown");
  assert.equal(byteLength(JSON.stringify(exact.frozen)), 65536);
  assert.ok(readRecovery(exactStorage));
  const over = new ComposerState(memoryStorage());
  over.edit({ projectId, title, outcome: `${outcome}x` });
  await over.submit(client, "csrf", true);
  assert.equal(posts, 2);
  assert.equal(over.phase, "editable");
  assert.match(over.errors.outcome ?? "", /64 KiB/);
});
