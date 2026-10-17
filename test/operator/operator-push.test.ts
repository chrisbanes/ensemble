import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { inboxAlertKey } from "../../src/operator/attention.js";
import {
  type InboxItem,
  inboxReadSchema,
  type RuntimeInboxItem,
  type TaskInboxItem,
} from "../../src/operator/contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_REVOKED_SUBSCRIPTIONS,
  type InboxRead,
  OperatorPush,
  OperatorPushStore,
  pushPayload,
} from "../../src/standalone/operator-push.js";
import {
  PushError,
  validatePushEndpoint,
} from "../../src/standalone/web-push.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  type FakeDevice,
  FakePushService,
  ManualPushClock,
} from "../fixtures/fake-push.js";
import {
  createOperatorFixture,
  type FixturePushOptions,
} from "../fixtures/operator-web.js";
import { serveCli } from "../fixtures/operator-cli.js";
import { seedOwnApproval, seedOwnQuestion } from "../fixtures/questions.js";
import { mixedAnswers } from "../fixtures/question-data.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";
import { settle } from "../fixtures/restart-clock.js";
import { tmpdir } from "../fixtures/temp.js";

const subscription = (device: FakeDevice) => ({
  endpoint: device.endpoint,
  keys: device.keys,
  label: device.label,
});

const open = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-push-store-"));
  const file = join(directory, "push.sqlite");
  const db = new DatabaseSync(file);
  return {
    file,
    db,
    store: new OperatorPushStore(db),
    async close() {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};
const add = (
  store: OperatorPushStore,
  fake: FakePushService,
  label = "Browser",
  keyId = "key-a",
  now = 1000,
) => {
  const device = fake.device(label);
  return {
    device,
    row: store.subscribe(
      validatePushEndpoint(subscription(device)),
      keyId,
      now,
    ),
  };
};

test("a subscription is stored but its endpoint and keys are never listed", async () => {
  const s = await open();
  try {
    const fake = new FakePushService();
    const { device, row } = add(s.store, fake, "Work laptop");
    assert.equal(row.state, "active");
    assert.equal(row.serviceHost, "fcm.googleapis.com");
    assert.equal(row.label, "Work laptop");
    const listed = JSON.stringify(s.store.list());
    for (const secret of [
      device.endpoint,
      device.keys.p256dh,
      device.keys.auth,
      new URL(device.endpoint).pathname,
    ])
      assert.equal(listed.includes(secret), false, secret);
    assert.deepEqual(s.store.target(row.id), {
      endpoint: device.endpoint,
      p256dh: device.keys.p256dh,
      auth: device.keys.auth,
    });
  } finally {
    await s.close();
  }
});

test("the 21st active subscription is refused and re-subscribing an endpoint replaces its row", async () => {
  const s = await open();
  try {
    const fake = new FakePushService();
    const devices = Array.from({ length: MAX_ACTIVE_SUBSCRIPTIONS }, (_, i) =>
      add(s.store, fake, `Browser ${i}`, "key-a", 1000 + i),
    );
    assert.throws(
      () => add(s.store, fake, "One too many"),
      (e) => e instanceof PushError && e.code === "conflict",
    );
    assert.equal(s.store.activeIds().length, MAX_ACTIVE_SUBSCRIPTIONS);
    // The same endpoint again is a replacement, not a 21st device.
    const first = devices[0]!;
    const again = s.store.subscribe(
      validatePushEndpoint({ ...subscription(first.device), label: "Renamed" }),
      "key-a",
      5000,
    );
    assert.equal(again.id, first.row.id);
    assert.equal(again.label, "Renamed");
    assert.equal(s.store.activeIds().length, MAX_ACTIVE_SUBSCRIPTIONS);
  } finally {
    await s.close();
  }
});

test("revoking clears the endpoint and keys, is idempotent and keeps twenty revoked rows", async () => {
  const s = await open();
  try {
    const fake = new FakePushService();
    const { device, row } = add(s.store, fake);
    const revoked = s.store.revoke(row.id, "operator", 2000);
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.revokedReason, "operator");
    const raw = s.db
      .prepare("SELECT endpoint, p256dh, auth FROM operator_push_subscriptions")
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...raw }, { endpoint: null, p256dh: null, auth: null });
    assert.equal(s.store.target(row.id), undefined);
    assert.deepEqual(s.store.revoke(row.id, "gone", 3000), revoked);
    // A revoked endpoint can be turned on again as a new active row.
    const back = s.store.subscribe(
      validatePushEndpoint(subscription(device)),
      "key-a",
      4000,
    );
    assert.notEqual(back.id, row.id);
    assert.equal(s.store.activeIds().length, 1);
    assert.equal(back.endpointDigest, revoked.endpointDigest);
    assert.throws(
      () => s.store.revoke(randomUUID(), "operator", 1),
      (e) => e instanceof PushError && e.code === "not-found",
    );
    for (let i = 0; i < MAX_REVOKED_SUBSCRIPTIONS + 5; i++)
      s.store.revoke(
        add(s.store, fake, `Old ${i}`).row.id,
        "operator",
        10_000 + i,
      );
    const states = s.store.list().map((r) => r.state);
    assert.equal(
      states.filter((state) => state === "revoked").length,
      MAX_REVOKED_SUBSCRIPTIONS,
    );
    // Newest revoked rows are the ones kept.
    assert.ok(
      s.store
        .list()
        .some((r) => r.label === `Old ${MAX_REVOKED_SUBSCRIPTIONS + 4}`),
    );
    assert.equal(
      s.store.list().some((r) => r.label === "Old 0"),
      false,
    );
  } finally {
    await s.close();
  }
});

test("subscriptions and the ledger survive reopening the database, including a runtime key", async () => {
  const s = await open();
  const fake = new FakePushService();
  const { row } = add(s.store, fake);
  // The first read after the first device is the baseline: recorded, not new.
  assert.deepEqual(
    s.store.applyRead(["runtime:codex:1760702400000"], true),
    [],
  );
  s.db.close();
  const db = new DatabaseSync(s.file);
  try {
    const store = new OperatorPushStore(db);
    assert.deepEqual(
      store.list().map((r) => r.id),
      [row.id],
    );
    // Already baselined and already holding the key: nothing is new.
    assert.deepEqual(
      store.applyRead(["runtime:codex:1760702400000"], true),
      [],
    );
    assert.deepEqual(
      store.applyRead(["runtime:codex:1760702400000", "q1"], false),
      ["q1"],
    );
  } finally {
    db.close();
    await rm(join(s.file, ".."), { recursive: true, force: true });
  }
});

test("subscriptions made under another VAPID key are revoked as key-changed", async () => {
  const s = await open();
  try {
    const fake = new FakePushService();
    const old = add(s.store, fake, "Old key", "key-a");
    const current = add(s.store, fake, "New key", "key-b");
    s.store.revokeOtherKeys("key-b", 5000);
    const rows = new Map(s.store.list().map((r) => [r.id, r]));
    assert.equal(rows.get(old.row.id)?.revokedReason, "key-changed");
    assert.equal(rows.get(old.row.id)?.state, "revoked");
    assert.equal(rows.get(current.row.id)?.state, "active");
    assert.equal(s.store.target(old.row.id), undefined);
  } finally {
    await s.close();
  }
});

test("the ledger records without sending until a device has subscribed and a read has been seen", async () => {
  const s = await open();
  try {
    const fake = new FakePushService();
    // No device: nothing is recorded or returned.
    assert.deepEqual(s.store.applyRead(["a"], true), []);
    assert.equal(
      (
        s.db
          .prepare("SELECT count(*) AS n FROM operator_push_alerts")
          .get() as { n: number }
      ).n,
      0,
    );
    const { row } = add(s.store, fake);
    assert.deepEqual(s.store.applyRead(["a", "b"], true), []);
    assert.deepEqual(s.store.applyRead(["a", "b", "c"], true), ["c"]);
    // A partial read adds but never resolves.
    assert.deepEqual(s.store.applyRead(["d"], false), ["d"]);
    assert.deepEqual(s.store.applyRead(["a", "b", "c", "d"], true), []);
    // A complete read resolves; the key coming back is new.
    assert.deepEqual(s.store.applyRead(["a"], true), []);
    assert.deepEqual(s.store.applyRead(["a", "c"], true), ["c"]);
    // Revoking the last device clears the ledger and the baseline.
    s.store.revoke(row.id, "operator", 9000);
    assert.equal(
      (
        s.db
          .prepare("SELECT count(*) AS n FROM operator_push_alerts")
          .get() as { n: number }
      ).n,
      0,
    );
    add(s.store, fake, "Again");
    assert.deepEqual(s.store.applyRead(["a", "b", "c", "z"], true), []);
  } finally {
    await s.close();
  }
});

// ---- The notifier over a real fixture service --------------------------------------------------

type Exhaustion = ReturnType<typeof exhaustibleRuntime>;
type Options = {
  exhaust?: boolean;
  timeoutMs?: number;
  readInbox?: (
    api: OperatorApi,
  ) => NonNullable<FixturePushOptions["readInbox"]>;
};

async function pushFixture(options: Options = {}) {
  const exhaustion: Exhaustion | undefined = options.exhaust
    ? exhaustibleRuntime()
    : undefined;
  const f = exhaustion
    ? await createOperatorFixture(
        null,
        undefined,
        undefined,
        {},
        exhaustion.factory,
        exhaustion.serviceOptions,
      )
    : await createOperatorFixture();
  const fake = new FakePushService();
  const clock = new ManualPushClock();
  const api = new OperatorApi(f.service, [f.directory]);
  const web = await f.startWeb([f.directory], undefined, {
    transport: fake.transport,
    clock,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.readInbox ? { readInbox: options.readInbox(api) } : {}),
  });
  const push = web.push;
  const subscribe = (label = "Browser") => {
    const device = fake.device(label);
    return { device, row: push.subscribe(subscription(device)) };
  };
  /** Ticks and lets every send finish. */
  const tick = async () => {
    await push.tick();
    await push.settle();
  };
  const items = async () => (await api.readInbox()).data.items;
  return { f, fake, clock, api, web, push, subscribe, tick, items, exhaustion };
}

const sent = (fake: FakePushService, device: FakeDevice) =>
  fake.payloads(device);

test("a new question sends one push per device with the exact minimal payload, and an unchanged one sends none", async () => {
  const x = await pushFixture();
  try {
    const a = x.subscribe("A");
    const b = x.subscribe("B");
    await x.tick();
    assert.equal(x.fake.requests.length, 0, "the baseline tick sends nothing");
    const q = await seedOwnQuestion(x.f);
    const [item] = await x.items();
    assert.ok(item && item.kind === "question");
    await x.tick();
    assert.equal(x.fake.requests.length, 2);
    const expected = {
      v: 1,
      title: `Question in ${item.projectName}: 1 waiting`,
      url: `/app/inbox?task=${q.taskId}&request=${q.interactionId}`,
      tag: q.interactionId,
    };
    assert.deepEqual(sent(x.fake, a.device), [expected]);
    assert.deepEqual(sent(x.fake, b.device), [expected]);
    const headers = x.fake.requests[0]?.request.headers ?? {};
    assert.equal(headers["content-encoding"], "aes128gcm");
    assert.ok(Number(headers.ttl) > 0);
    assert.match(
      headers.authorization ?? "",
      /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/,
    );
    await x.tick();
    await x.tick();
    assert.equal(
      x.fake.requests.length,
      2,
      "an unchanged item is never re-sent",
    );
  } finally {
    await x.f.close();
  }
});

test("a new approval sends one push titled as an approval", async () => {
  const x = await pushFixture();
  try {
    const a = x.subscribe();
    await x.tick();
    const approval = await seedOwnApproval(x.f);
    await x.tick();
    const [item] = await x.items();
    assert.ok(item && item.kind === "approval");
    assert.deepEqual(sent(x.fake, a.device), [
      {
        v: 1,
        title: `Approval in ${item.projectName}: 1 waiting`,
        url: `/app/inbox?task=${approval.taskId}&request=${approval.interactionId}`,
        tag: approval.interactionId,
      },
    ]);
  } finally {
    await x.f.close();
  }
});

test("an unchanged item stays quiet across ticks and a notifier restart on the same database", async () => {
  const x = await pushFixture();
  try {
    x.subscribe();
    await x.tick();
    await seedOwnQuestion(x.f);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    for (let i = 0; i < 3; i++) await x.tick();
    const restarted = await OperatorPush.open({
      store: x.f.service.operatorPush(),
      keyFile: join(x.f.directory, "operator-push-vapid.json"),
      readInbox: (query) => x.api.readInbox(query),
      transport: x.fake.transport,
      clock: x.clock,
      intervalMs: null,
    });
    await restarted.tick();
    await restarted.settle();
    assert.equal(x.fake.requests.length, 1);
  } finally {
    await x.f.close();
  }
});

const ledger = (f: {
  seedPersistedState(s: (db: DatabaseSync) => void): void;
}) => {
  const keys: string[] = [];
  f.seedPersistedState((db) => {
    for (const row of db
      .prepare("SELECT key FROM operator_push_alerts ORDER BY key")
      .all())
      keys.push((row as { key: string }).key);
  });
  return keys;
};

test("a resolved item sends nothing more and leaves the ledger only after a complete read", async () => {
  const x = await pushFixture();
  try {
    x.subscribe();
    await x.tick();
    const q = await seedOwnQuestion(x.f);
    await x.tick();
    assert.deepEqual(ledger(x.f), [q.interactionId]);
    await x.api.execute({
      type: "question.form.answer",
      key: randomUUID(),
      taskId: q.taskId,
      interactionId: q.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    });
    assert.equal((await x.items()).length, 0);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    assert.deepEqual(ledger(x.f), []);
  } finally {
    await x.f.close();
  }
});

test("a partial read never resolves an alert, so the item returning is not new", async () => {
  const mode = { partial: false };
  const x = await pushFixture({
    readInbox: (api) => async (query) => {
      const read = await api.readInbox(query);
      return mode.partial
        ? inboxReadSchema.parse({
            ...read,
            data: {
              ...read.data,
              items: [],
              complete: false,
              unavailable: true,
            },
          })
        : read;
    },
  });
  try {
    x.subscribe();
    await x.tick();
    const q = await seedOwnQuestion(x.f);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    mode.partial = true;
    await x.tick();
    assert.deepEqual(ledger(x.f), [q.interactionId], "the key stays");
    mode.partial = false;
    await x.tick();
    assert.equal(
      x.fake.requests.length,
      1,
      "nothing is re-sent when it reappears",
    );
  } finally {
    await x.f.close();
  }
});

const inboxOf = (items: InboxItem[], complete = true): InboxRead =>
  inboxReadSchema.parse({
    data: { items, nextCursor: null, complete, unavailable: !complete },
    observedAt: 1,
  });
const projectId = randomUUID();
const taskId = randomUUID();
const intervention = (code: TaskInboxItem["attentionCode"]): TaskInboxItem => ({
  id: `intervention:${taskId}`,
  kind: "intervention",
  urgency: 0,
  createdAt: null,
  taskId,
  projectId,
  projectName: "Relay",
  taskTitle: "SECRET TASK TITLE",
  requestingAssignmentId: null,
  requesterName: null,
  interactionId: null,
  revision: null,
  headline: null,
  reason: "Execution ownership is uncertain",
  attentionCode: code,
  destination: `/app/tasks/${taskId}?section=decisions`,
  evidence: `/app/tasks/${taskId}#history`,
  conversation: null,
});
const interventionFor = (id: string): TaskInboxItem => ({
  ...intervention("execution-uncertain"),
  id: `intervention:${id}`,
  taskId: id,
});
const runtimeItem = (
  harness: "codex" | "claude",
  since: number,
): RuntimeInboxItem => ({
  id: `runtime:${harness}`,
  kind: "runtime",
  urgency: 0,
  createdAt: since,
  harness,
  since,
  headline: `${harness} runtime unavailable`,
  reason: "Restart retries exhausted",
  lastFailure: "start-failed",
  attempts: [],
  destination: "/app/settings/runtime",
});

/** A scripted Inbox: the test says what each read returns. */
function scripted() {
  const state: {
    read: InboxRead;
    reads: number;
    fail: boolean;
    /** Holds every read until released. */
    hold: Promise<void> | null;
  } = {
    read: inboxOf([]),
    reads: 0,
    fail: false,
    hold: null,
  };
  return {
    state,
    set(items: InboxItem[], complete = true) {
      state.read = inboxOf(items, complete);
    },
    readInbox: () => async (): Promise<InboxRead> => {
      state.reads++;
      if (state.hold) await state.hold;
      if (state.fail) throw new Error("503");
      return state.read;
    },
  };
}

test("an intervention is new when its attention code changes and when the same code returns after clearing", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    inbox.set([intervention("execution-uncertain")]);
    await x.tick();
    assert.equal(x.fake.requests.length, 0, "the first read is the baseline");
    inbox.set([intervention("unresolved-result")]);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    assert.equal(
      sent(x.fake, a.device)[0]?.tag,
      `intervention:${taskId}:unresolved-result`,
    );
    assert.equal(
      sent(x.fake, a.device)[0]?.title,
      "Intervention in Relay: 1 waiting",
    );
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    inbox.set([]);
    await x.tick();
    inbox.set([intervention("unresolved-result")]);
    await x.tick();
    assert.equal(
      x.fake.requests.length,
      2,
      "the same code after clearing is new",
    );
  } finally {
    await x.f.close();
  }
});

test("items present before the first subscription are the baseline and later ones are sent", async () => {
  const x = await pushFixture();
  try {
    await seedOwnQuestion(x.f);
    const a = x.subscribe();
    await x.tick();
    assert.equal(x.fake.requests.length, 0);
    await x.tick();
    const second = await seedOwnQuestion(
      x.f,
      undefined,
      "Second task",
      "Other project",
    );
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    assert.equal(sent(x.fake, a.device)[0]?.tag, second.interactionId);
  } finally {
    await x.f.close();
  }
});

test("no payload, header, URL, API read or log carries task content", async () => {
  const x = await pushFixture();
  const stderr: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const a = x.subscribe();
    await x.tick();
    const secrets = [
      "SECRET-TASK-TITLE",
      "SECRET-QUESTION-TEXT",
      "ghp_FAKEFAKEFAKEFAKEFAKE0000",
    ];
    const q = await seedOwnQuestion(
      x.f,
      {
        version: 1,
        questions: [
          {
            id: "only",
            kind: "free-text",
            label: `${secrets[1]} ${secrets[2]}`,
            required: true,
          },
        ],
      },
      secrets[0],
      "Visible project",
    );
    const [item] = await x.items();
    assert.ok(item && item.kind === "question");
    const privateText = [
      ...secrets,
      item.requesterName ?? "",
      "PRIVATE REVIEW INSTRUCTIONS",
    ];
    assert.ok(item.requesterName);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    const wire = JSON.stringify(
      x.fake.requests.map((r) => ({
        endpoint: r.request.endpoint,
        headers: r.request.headers,
        plaintext: r.plaintext,
      })),
    );
    const read = JSON.stringify(x.push.read());
    for (const text of privateText) {
      assert.equal(wire.includes(text), false, `wire: ${text}`);
      assert.equal(read.includes(text), false, `read: ${text}`);
      assert.equal(stderr.join("").includes(text), false, `stderr: ${text}`);
    }
    // The private key, the endpoint and the keys never reach the API read either.
    for (const secret of [
      a.device.endpoint,
      a.device.keys.p256dh,
      a.device.keys.auth,
    ])
      assert.equal(read.includes(secret), false);
    assert.equal(
      wire.includes(q.interactionId),
      true,
      "the deep link is the only identity",
    );
  } finally {
    process.stderr.write = original;
    await x.f.close();
  }
});

test("a revoked device receives nothing and subscribing the same endpoint again receives the next item", async () => {
  const x = await pushFixture();
  try {
    const a = x.subscribe("A");
    const b = x.subscribe("B");
    await x.tick();
    x.push.revoke(b.row.id);
    await seedOwnQuestion(x.f);
    await x.tick();
    assert.equal(x.fake.for(a.device).length, 1);
    assert.equal(x.fake.for(b.device).length, 0);
    x.push.subscribe(subscription(b.device));
    await x.tick();
    assert.equal(
      x.fake.for(b.device).length,
      0,
      "an existing item is not replayed",
    );
    await seedOwnQuestion(x.f, undefined, "Another task", "Another project");
    await x.tick();
    assert.equal(x.fake.for(b.device).length, 1);
    assert.equal(x.fake.for(a.device).length, 2);
  } finally {
    await x.f.close();
  }
});

test("a 404 or 410 from the push service revokes the device and clears its secrets", async () => {
  for (const status of [404, 410]) {
    const x = await pushFixture();
    try {
      const gone = x.subscribe("Gone");
      const kept = x.subscribe("Kept");
      await x.tick();
      x.fake.script(gone.device, { status });
      await seedOwnQuestion(x.f);
      await x.tick();
      const rows = new Map(x.push.read().subscriptions.map((r) => [r.id, r]));
      assert.equal(rows.get(gone.row.id)?.state, "revoked");
      assert.equal(rows.get(gone.row.id)?.revokedReason, "gone");
      assert.equal(x.f.service.operatorPush().target(gone.row.id), undefined);
      assert.equal(rows.get(kept.row.id)?.state, "active");
      await seedOwnQuestion(x.f, undefined, "Another task", "Another project");
      await x.tick();
      assert.equal(x.fake.for(gone.device).length, 1, "no further sends to it");
      assert.equal(x.fake.for(kept.device).length, 2);
    } finally {
      await x.f.close();
    }
  }
});

test("429 and 5xx retry at 30 s and 120 s then give up, Retry-After is capped and 4xx is not retried", async () => {
  const x = await pushFixture();
  try {
    const flaky = x.subscribe("Flaky");
    const rejected = x.subscribe("Rejected");
    const forbidden = x.subscribe("Forbidden");
    await x.tick();
    x.fake.script(
      flaky.device,
      { status: 429 },
      { status: 503 },
      { status: 502 },
    );
    x.fake.script(rejected.device, { status: 400 });
    x.fake.script(forbidden.device, { status: 403 });
    await seedOwnQuestion(x.f);
    await x.tick();
    const count = (d: FakeDevice) => x.fake.for(d).length;
    assert.deepEqual(
      [flaky, rejected, forbidden].map((s) => count(s.device)),
      [1, 1, 1],
    );
    x.clock.advance(29_999);
    await x.push.settle();
    assert.equal(count(flaky.device), 1);
    x.clock.advance(1);
    await x.push.settle();
    assert.equal(count(flaky.device), 2);
    x.clock.advance(119_999);
    await x.push.settle();
    assert.equal(count(flaky.device), 2);
    x.clock.advance(1);
    await x.push.settle();
    assert.equal(count(flaky.device), 3);
    x.clock.advance(1_000_000);
    await x.push.settle();
    assert.equal(count(flaky.device), 3, "three attempts in all");
    const rows = new Map(x.push.read().subscriptions.map((r) => [r.label, r]));
    assert.equal(rows.get("Flaky")?.lastFailure, "unavailable");
    assert.equal(rows.get("Flaky")?.state, "active");
    for (const label of ["Rejected", "Forbidden"]) {
      assert.equal(rows.get(label)?.lastFailure, "rejected");
      assert.equal(
        rows.get(label)?.state,
        "active",
        "a bad token must not wipe a device",
      );
    }
    assert.equal(count(rejected.device), 1);
    assert.equal(count(forbidden.device), 1);
  } finally {
    await x.f.close();
  }
});

test("a Retry-After beyond ten minutes waits exactly ten minutes", async () => {
  const x = await pushFixture();
  try {
    const d = x.subscribe();
    await x.tick();
    x.fake.script(
      d.device,
      { status: 429, retryAfterSeconds: 99_999 },
      { status: 201 },
    );
    await seedOwnQuestion(x.f);
    await x.tick();
    x.clock.advance(599_999);
    await x.push.settle();
    assert.equal(x.fake.for(d.device).length, 1);
    x.clock.advance(1);
    await x.push.settle();
    assert.equal(x.fake.for(d.device).length, 2);
    assert.ok(
      x.push.read().subscriptions[0]?.lastSuccessAt,
      "the retry after the capped wait was delivered",
    );
  } finally {
    await x.f.close();
  }
});

/** A signed-in browser session against a started fixture web listener. */
async function signIn(web: { origin: string; password: string }) {
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  let csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
  response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
  return {
    get: (path: string) =>
      fetch(`${web.origin}${path}`, { headers: { cookie } }),
    post: (path: string, body: unknown) =>
      fetch(`${web.origin}${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: web.origin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  };
}

test("a slow endpoint does not delay another device or the Inbox and then times out", async () => {
  const x = await pushFixture({ timeoutMs: 50 });
  try {
    const slow = x.subscribe("Slow");
    const quick = x.subscribe("Quick");
    await x.tick();
    x.fake.script(slow.device, "hang", "hang", "hang");
    await seedOwnQuestion(x.f);
    const session = await signIn(x.web);
    await x.push.tick();
    await settle(() => x.fake.for(quick.device).length === 1);
    assert.equal(x.fake.for(slow.device).length, 1);
    assert.equal((await session.get("/api/operator/inbox")).status, 200);
    assert.equal(
      x.push.read().subscriptions.find((r) => r.label === "Slow")?.lastFailure,
      null,
      "not timed out before its 50 ms",
    );
    x.clock.advance(50);
    await x.push.settle();
    const rows = new Map(x.push.read().subscriptions.map((r) => [r.label, r]));
    assert.equal(
      rows.get("Slow")?.lastFailure,
      null,
      "a timeout is retried first",
    );
    x.clock.advance(30_000);
    await settle(() => x.fake.for(slow.device).length === 2);
    x.clock.advance(50);
    await x.push.settle();
    x.clock.advance(120_000);
    await settle(() => x.fake.for(slow.device).length === 3);
    x.clock.advance(50);
    await x.push.settle();
    assert.equal(
      x.push.read().subscriptions.find((r) => r.label === "Slow")?.lastFailure,
      "timeout",
    );
    assert.equal(x.fake.for(quick.device).length, 1);
  } finally {
    await x.f.close();
  }
});

test("at most four sends are in flight at once and the rest wait their turn", async () => {
  const x = await pushFixture({ timeoutMs: 50 });
  try {
    const devices = Array.from({ length: 6 }, (_, i) =>
      x.subscribe(`Device ${i}`),
    );
    await x.tick();
    for (const d of devices) x.fake.script(d.device, "hang", "hang", "hang");
    await seedOwnQuestion(x.f);
    await x.push.tick();
    await settle(() => x.fake.requests.length === 4);
    assert.equal(x.fake.requests.length, 4);
    assert.equal(x.fake.inFlight, 4);
    x.clock.advance(50);
    await settle(() => x.fake.requests.length === 6);
    assert.equal(x.fake.maxInFlight, 4);
    x.clock.advance(50);
    await x.push.settle();
  } finally {
    await x.f.close();
  }
});

test("a partial first read does not end the baseline, so an item it could not see is not announced later", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    inbox.set([interventionFor(randomUUID())], false);
    await x.tick();
    inbox.set([interventionFor(randomUUID()), interventionFor(randomUUID())]);
    await x.tick();
    assert.equal(
      x.fake.requests.length,
      0,
      "the baseline ends on a complete read",
    );
    inbox.set([...inbox.state.read.data.items, interventionFor(randomUUID())]);
    await x.tick();
    assert.equal(x.fake.for(a.device).length, 1, "later alerts are announced");
  } finally {
    await x.f.close();
  }
});

test("a task that never reads cannot hold the baseline open for ever", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    const known = interventionFor(randomUUID());
    inbox.set([known], false);
    for (let i = 0; i < 3; i++) await x.tick();
    assert.equal(
      x.fake.requests.length,
      0,
      "what the baseline saw is not announced",
    );
    inbox.set([known, interventionFor(randomUUID())], false);
    await x.tick();
    assert.equal(
      x.fake.for(a.device).length,
      1,
      "after three partial reads new alerts are sent",
    );
  } finally {
    await x.f.close();
  }
});

test("a stored endpoint outside the allowlist, or unparseable, is rejected at send time and never fetched", async () => {
  const x = await pushFixture();
  try {
    const bad = x.subscribe("Tampered");
    const broken = x.subscribe("Broken");
    x.f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE operator_push_subscriptions SET endpoint = ? WHERE id = ?",
      ).run("https://evil.test/x", bad.row.id);
      db.prepare(
        "UPDATE operator_push_subscriptions SET endpoint = ? WHERE id = ?",
      ).run("not a url", broken.row.id);
    });
    assert.equal(await x.push.test(bad.row.id), "rejected");
    assert.equal(await x.push.test(broken.row.id), "rejected");
    assert.equal(x.fake.requests.length, 0);
    assert.equal(
      x.push.read().subscriptions.find((r) => r.id === bad.row.id)?.lastFailure,
      "rejected",
    );
  } finally {
    await x.f.close();
  }
});

test("a tick never overlaps itself and a stop in the middle of a read records nothing", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    x.subscribe();
    await x.tick();
    let release!: () => void;
    inbox.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    inbox.set([interventionFor(randomUUID())]);
    const before = inbox.state.reads;
    const first = x.push.tick();
    const second = x.push.tick();
    assert.equal(second, first, "the second call joins the running tick");
    await settle(() => inbox.state.reads === before + 1);
    const stopping = x.push.stop();
    release();
    await stopping;
    await first;
    assert.equal(inbox.state.reads, before + 1);
    assert.deepEqual(
      ledger(x.f),
      [],
      "an alert read during a stop is not recorded unsent",
    );
    assert.equal(x.fake.requests.length, 0);
  } finally {
    await x.f.close();
  }
});

test("a Retry-After shorter than the schedule still waits the schedule", async () => {
  const x = await pushFixture();
  try {
    const d = x.subscribe();
    await x.tick();
    x.fake.script(
      d.device,
      { status: 429, retryAfterSeconds: 1 },
      { status: 201 },
    );
    await seedOwnQuestion(x.f);
    await x.tick();
    x.clock.advance(29_999);
    await x.push.settle();
    assert.equal(x.fake.for(d.device).length, 1);
    x.clock.advance(1);
    await x.push.settle();
    assert.equal(x.fake.for(d.device).length, 2);
  } finally {
    await x.f.close();
  }
});

test("every other 4xx and a redirect is a rejected push, not retried and not a revocation", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const statuses = [401, 413, 418, 301];
    const devices = statuses.map((status) => {
      const d = x.subscribe(`Status ${status}`);
      x.fake.script(d.device, { status });
      return d;
    });
    inbox.set([]);
    await x.tick();
    inbox.set([interventionFor(randomUUID())]);
    await x.tick();
    x.clock.advance(1_000_000);
    await x.push.settle();
    for (const d of devices) {
      assert.equal(x.fake.for(d.device).length, 1, d.row.label);
      const row = x.push.read().subscriptions.find((r) => r.id === d.row.id);
      assert.equal(row?.lastFailure, "rejected", d.row.label);
      assert.equal(row?.state, "active", d.row.label);
    }
  } finally {
    await x.f.close();
  }
});

test("past 500 pending pushes the oldest waiting ones are dropped and recorded, and sends stay bounded", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const devices = Array.from({ length: 20 }, (_, i) => {
      const d = x.subscribe(`Device ${i}`);
      x.fake.script(d.device, ...Array(40).fill("hang"));
      return d;
    });
    inbox.set([]);
    await x.tick();
    // 26 alerts to 20 devices is 520 pushes; four are in flight and hung.
    inbox.set(Array.from({ length: 26 }, () => interventionFor(randomUUID())));
    await x.push.tick();
    await settle(() => x.fake.requests.length === 4);
    assert.equal(x.fake.requests.length, 4);
    const dropped = x.push
      .read()
      .subscriptions.filter((r) => r.lastFailure === "unavailable").length;
    assert.ok(dropped > 0, "some waiting pushes were dropped and recorded");
    assert.equal(devices.length, 20);
  } finally {
    await x.f.close();
  }
});

test("a failed Inbox read changes nothing and the next read sends normally", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    await x.tick();
    const before = ledger(x.f);
    inbox.state.fail = true;
    inbox.set([intervention("execution-uncertain")]);
    await x.tick();
    assert.deepEqual(ledger(x.f), before);
    assert.equal(x.fake.requests.length, 0);
    inbox.state.fail = false;
    await x.tick();
    assert.equal(x.fake.for(a.device).length, 1);
  } finally {
    await x.f.close();
  }
});

test("with no subscription the notifier reads nothing and writes nothing", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const before = databaseDigest(x.f);
    inbox.set([intervention("execution-uncertain")]);
    await x.tick();
    await x.tick();
    assert.equal(inbox.state.reads, 0);
    assert.equal(databaseDigest(x.f), before);
  } finally {
    await x.f.close();
  }
});

test("an unusable key file leaves push unavailable while the rest of the operator answers", async () => {
  const f = await createOperatorFixture();
  try {
    const keyFile = join(f.directory, "operator-push-vapid.json");
    await writeFile(keyFile, "{}", { mode: 0o600 });
    await chmod(keyFile, 0o644);
    const fake = new FakePushService();
    const web = await f.startWeb([f.directory], undefined, {
      transport: fake.transport,
    });
    const session = await signIn(web);
    const read = (await (
      await session.get("/api/operator/notifications")
    ).json()) as {
      data: {
        available: boolean;
        publicKey: string | null;
        subscriptions: unknown[];
      };
    };
    assert.equal(read.data.available, false);
    assert.equal(read.data.publicKey, null);
    assert.equal((await session.get("/api/operator/inbox")).status, 200);
    const device = fake.device();
    const refused = await session.post(
      "/api/operator/notifications/subscriptions",
      subscription(device),
    );
    assert.equal(refused.status, 503);
    assert.equal(JSON.stringify(await refused.json()).includes(keyFile), false);
  } finally {
    await f.close();
  }
});

// ---- Runtime kind ------------------------------------------------------------------------------

test("exhausting a runtime sends exactly one push with only its name", async () => {
  const x = await pushFixture({ exhaust: true });
  try {
    const a = x.subscribe();
    await x.tick();
    assert.equal(x.fake.requests.length, 0, "a healthy runtime sends nothing");
    await x.exhaustion!.exhaust(x.f.runtime);
    await x.tick();
    const [runtime] = (await x.items()).filter((i) => i.kind === "runtime");
    assert.ok(runtime?.kind === "runtime");
    assert.equal(x.fake.requests.length, 1);
    assert.deepEqual(sent(x.fake, a.device), [
      {
        v: 1,
        title: "Codex runtime unavailable",
        url: "/app/inbox?request=runtime%3Acodex",
        tag: `runtime:codex:${runtime.since}`,
      },
    ]);
  } finally {
    await x.f.close();
  }
});

test("an unchanged exhausted runtime never re-fires across ticks, a notifier restart or a second device", async () => {
  const x = await pushFixture({ exhaust: true });
  try {
    const a = x.subscribe("A");
    await x.tick();
    await x.exhaustion!.exhaust(x.f.runtime);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    for (let i = 0; i < 3; i++) await x.tick();
    assert.equal(x.fake.requests.length, 1);
    const restarted = await OperatorPush.open({
      store: x.f.service.operatorPush(),
      keyFile: join(x.f.directory, "operator-push-vapid.json"),
      readInbox: (query) => x.api.readInbox(query),
      transport: x.fake.transport,
      clock: x.clock,
      intervalMs: null,
    });
    await restarted.tick();
    await restarted.settle();
    assert.equal(x.fake.requests.length, 1);
    const b = x.subscribe("B");
    await x.tick();
    assert.equal(x.fake.for(a.device).length, 1);
    assert.equal(x.fake.for(b.device).length, 0);
  } finally {
    await x.f.close();
  }
});

test("a runtime already exhausted before the first subscription is the baseline", async () => {
  const x = await pushFixture({ exhaust: true });
  try {
    await x.exhaustion!.exhaust(x.f.runtime);
    x.subscribe();
    await x.tick();
    await x.tick();
    assert.equal(x.fake.requests.length, 0);
  } finally {
    await x.f.close();
  }
});

test("recovery clears the alert and a later exhaustion fires another with the newer time", async () => {
  const x = await pushFixture({ exhaust: true });
  try {
    const a = x.subscribe();
    await x.tick();
    await x.exhaustion!.exhaust(x.f.runtime);
    await x.tick();
    const first = sent(x.fake, a.device)[0];
    assert.match(first?.tag, /^runtime:codex:\d+$/);
    assert.deepEqual(ledger(x.f), [first.tag]);
    x.exhaustion!.gate.failStarts = false;
    await x.f.service.configureRuntime({
      key: randomUUID(),
      harness: "codex",
      enabled: true,
    });
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    assert.deepEqual(
      ledger(x.f),
      [],
      "a complete read dropped the recovered alert",
    );
    x.exhaustion!.clock.advance(60_000);
    await x.exhaustion!.exhaust(x.f.runtime);
    await x.tick();
    assert.equal(x.fake.requests.length, 2);
    const second = sent(x.fake, a.device)[1];
    assert.notEqual(second.tag, first.tag);
    assert.ok(
      Number(second.tag.split(":")[2]) > Number(first.tag.split(":")[2]),
    );
  } finally {
    await x.f.close();
  }
});

test("a new exhaustion episode is new even when partial reads kept the old key", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    inbox.set([]);
    await x.tick();
    inbox.set([runtimeItem("codex", 1_000)]);
    await x.tick();
    assert.equal(x.fake.requests.length, 1);
    inbox.set([], false);
    await x.tick();
    await x.tick();
    assert.deepEqual(ledger(x.f), ["runtime:codex:1000"]);
    inbox.set([runtimeItem("codex", 2_000)]);
    await x.tick();
    assert.equal(x.fake.requests.length, 2);
    assert.equal(sent(x.fake, a.device)[1]?.tag, "runtime:codex:2000");
    assert.deepEqual(ledger(x.f), ["runtime:codex:2000"]);
  } finally {
    await x.f.close();
  }
});

test("each exhausted harness is pushed once, by name, and re-pushed only for its own new episode", async () => {
  const inbox = scripted();
  const x = await pushFixture({ readInbox: inbox.readInbox });
  try {
    const a = x.subscribe();
    inbox.set([]);
    await x.tick();
    inbox.set([runtimeItem("codex", 1_000), runtimeItem("claude", 1_500)]);
    await x.tick();
    assert.deepEqual(
      sent(x.fake, a.device).map((p) => p.title),
      ["Codex runtime unavailable", "Claude runtime unavailable"],
    );
    await x.tick();
    assert.equal(x.fake.requests.length, 2);
    inbox.set([runtimeItem("codex", 1_000)]);
    await x.tick();
    inbox.set([runtimeItem("codex", 1_000), runtimeItem("claude", 3_000)]);
    await x.tick();
    assert.equal(x.fake.requests.length, 3);
    assert.equal(sent(x.fake, a.device)[2]?.tag, "runtime:claude:3000");
  } finally {
    await x.f.close();
  }
});

test("a runtime push carries no failure detail and does not count as a waiting task", async () => {
  const x = await pushFixture({ exhaust: true });
  try {
    const a = x.subscribe();
    await x.tick();
    const q = await seedOwnQuestion(x.f);
    await x.exhaustion!.exhaust(x.f.runtime);
    const items = await x.items();
    const task = items.find((i): i is TaskInboxItem => i.kind === "question");
    assert.ok(task);
    await x.tick();
    const payloads = sent(x.fake, a.device);
    assert.equal(payloads.length, 2);
    const runtime = payloads.find((p) => p.tag.startsWith("runtime:"));
    const question = payloads.find((p) => p.tag === q.interactionId);
    assert.equal(question?.title, `Question in ${task.projectName}: 1 waiting`);
    assert.equal(runtime?.title, "Codex runtime unavailable");
    const text = JSON.stringify(runtime);
    for (const detail of [
      "lastFailure",
      "attempts",
      "reason",
      "destination",
      "start-failed",
      "App Server will not start",
      "Restart retries exhausted",
      task.projectId,
      task.projectName ?? "",
      q.taskId,
    ])
      assert.equal(text.includes(detail), false, detail);
    assert.deepEqual(Object.keys(runtime).sort(), ["tag", "title", "url", "v"]);
    // The same task push as it would be without a runtime problem.
    assert.deepEqual(question, {
      v: 1,
      title: `Question in ${task.projectName}: 1 waiting`,
      url: `/app/inbox?task=${q.taskId}&request=${q.interactionId}`,
      tag: q.interactionId,
    });
  } finally {
    await x.f.close();
  }
});

test("every Inbox kind has an alert key and a payload", () => {
  const samples = {
    question: { ...intervention("question"), kind: "question", id: "q1" },
    approval: { ...intervention("approval"), kind: "approval", id: "a1" },
    intervention: intervention("execution-uncertain"),
    runtime: runtimeItem("codex", 7),
  } as const satisfies Record<InboxItem["kind"], InboxItem>;
  assert.deepEqual(Object.values(samples).map(inboxAlertKey), [
    "q1",
    "a1",
    `intervention:${taskId}:execution-uncertain`,
    "runtime:codex:7",
  ]);
  const all = Object.values(samples);
  assert.deepEqual(
    all.map((item) => pushPayload(item, all).title),
    [
      "Question in Relay: 3 waiting",
      "Approval in Relay: 3 waiting",
      "Intervention in Relay: 3 waiting",
      "Codex runtime unavailable",
    ],
  );
  // Long names are cut and control characters never reach a title.
  assert.equal(
    pushPayload(
      { ...samples.question, projectName: `${"x".repeat(80)}\n!` },
      all,
    ).title,
    `Question in ${"x".repeat(64)}: 3 waiting`,
  );
  assert.equal(
    pushPayload({ ...samples.question, projectName: null }, all).title,
    "Question in a project: 3 waiting",
  );
});

// ---- HTTP routes ---------------------------------------------------------------------------------

async function httpFixture(t: { after(fn: () => unknown): void }) {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const fake = new FakePushService();
  const clock = new ManualPushClock();
  const api = new OperatorApi(f.service, [f.directory]);
  const push = await OperatorPush.open({
    store: f.service.operatorPush(),
    keyFile: join(f.directory, "operator-push-vapid.json"),
    readInbox: (query) => api.readInbox(query),
    transport: fake.transport,
    clock,
    intervalMs: null,
  });
  const s = await serveCli(t, f, { push });
  return { f, fake, clock, push, s };
}

const NOTIFICATIONS = "/api/operator/notifications";
const SUBSCRIPTIONS = `${NOTIFICATIONS}/subscriptions`;

test("subscribe, list, test and revoke round trip through the session routes", async (t) => {
  const { fake, push, s } = await httpFixture(t);
  const device = fake.device("Phone");
  let r = await s.sessionPost(SUBSCRIPTIONS, subscription(device));
  assert.equal(r.status, 200);
  const created = (await r.json()) as {
    subscription: { id: string; state: string; label: string };
  };
  assert.equal(created.subscription.state, "active");
  assert.equal(created.subscription.label, "Phone");
  const listed = await (await s.sessionGet(NOTIFICATIONS)).text();
  const read = JSON.parse(listed) as {
    data: {
      available: boolean;
      publicKey: string;
      subscriptions: { id: string }[];
    };
    observedAt: number;
  };
  assert.equal(read.data.available, true);
  assert.equal(read.data.publicKey, push.read().publicKey);
  assert.deepEqual(
    read.data.subscriptions.map((x) => x.id),
    [created.subscription.id],
  );
  for (const secret of [device.endpoint, device.keys.p256dh, device.keys.auth])
    assert.equal(listed.includes(secret), false);
  r = await s.sessionPost(
    `${SUBSCRIPTIONS}/${created.subscription.id}/test`,
    {},
  );
  assert.deepEqual(await r.json(), { outcome: "sent" });
  assert.deepEqual(fake.payloads(device), [
    {
      v: 1,
      title: "Test notification from Ensemble",
      url: "/app/settings#notifications",
      tag: "test:notification",
    },
  ]);
  fake.script(device, { status: 503 });
  r = await s.sessionPost(
    `${SUBSCRIPTIONS}/${created.subscription.id}/test`,
    {},
  );
  assert.deepEqual(await r.json(), { outcome: "unavailable" });
  assert.equal(fake.for(device).length, 2, "a test is never retried");
  r = await s.sessionPost(
    `${SUBSCRIPTIONS}/${created.subscription.id}/revoke`,
    {},
  );
  assert.equal(r.status, 200);
  assert.equal(
    ((await r.json()) as { subscription: { state: string } }).subscription
      .state,
    "revoked",
  );
  r = await s.sessionPost(
    `${SUBSCRIPTIONS}/${created.subscription.id}/revoke`,
    {},
  );
  assert.equal(r.status, 200, "revoking again is idempotent");
  r = await s.sessionPost(
    `${SUBSCRIPTIONS}/${created.subscription.id}/test`,
    {},
  );
  assert.equal(r.status, 409);
  assert.equal(fake.for(device).length, 2);
});

test("a session that ends while a test is in flight gets no answer", async (t) => {
  const { fake, clock, s } = await httpFixture(t);
  const device = fake.device("Slow");
  const { subscription: row } = (await (
    await s.sessionPost(SUBSCRIPTIONS, subscription(device))
  ).json()) as { subscription: { id: string } };
  fake.script(device, "hang");
  const pending = s.sessionPost(`${SUBSCRIPTIONS}/${row.id}/test`, {});
  await settle(() => fake.requests.length === 1);
  assert.equal((await s.sessionPost("/api/operator/logout", {})).status, 200);
  clock.advance(10_000);
  const answer = await pending;
  assert.equal(answer.status, 401);
  assert.equal(JSON.stringify(await answer.json()).includes("outcome"), false);
});

test("a test notification answered 410 revokes the device", async (t) => {
  const { fake, push, s } = await httpFixture(t);
  const device = fake.device("Gone");
  const { subscription: row } = (await (
    await s.sessionPost(SUBSCRIPTIONS, subscription(device))
  ).json()) as { subscription: { id: string } };
  fake.script(device, { status: 410 });
  const r = await s.sessionPost(`${SUBSCRIPTIONS}/${row.id}/test`, {});
  assert.deepEqual(await r.json(), { outcome: "gone" });
  const stored = push.read().subscriptions[0];
  assert.equal(stored?.state, "revoked");
  assert.equal(stored?.revokedReason, "gone");
});

test("push routes refuse a missing session, origin or CSRF token and create nothing", async (t) => {
  const { fake, push, s } = await httpFixture(t);
  const device = fake.device();
  const body = JSON.stringify(subscription(device));
  const json = { "content-type": "application/json" };
  const anonymous = await fetch(`${s.origin}/api/operator/session`);
  const anonymousCookie =
    anonymous.headers.get("set-cookie")?.split(";")[0] ?? "";
  const refusals: [string, Response][] = [
    [
      "unauthenticated post",
      await fetch(`${s.origin}${SUBSCRIPTIONS}`, {
        method: "POST",
        headers: json,
        body,
      }),
    ],
    [
      "anonymous session post",
      await fetch(`${s.origin}${SUBSCRIPTIONS}`, {
        method: "POST",
        headers: { ...json, cookie: anonymousCookie, origin: s.authOrigin },
        body,
      }),
    ],
    ["unauthenticated list", await fetch(`${s.origin}${NOTIFICATIONS}`)],
    [
      "foreign origin",
      await s.sessionPost(SUBSCRIPTIONS, subscription(device), {
        origin: "http://evil.test",
      }),
    ],
    [
      "no origin",
      await fetch(`${s.origin}${SUBSCRIPTIONS}`, {
        method: "POST",
        headers: { ...json, cookie: s.cookie },
        body,
      }),
    ],
    [
      "wrong csrf",
      await s.sessionPost(SUBSCRIPTIONS, subscription(device), {
        "x-csrf-token": "wrong",
      }),
    ],
    [
      "no csrf",
      await fetch(`${s.origin}${SUBSCRIPTIONS}`, {
        method: "POST",
        headers: { ...json, cookie: s.cookie, origin: s.authOrigin },
        body,
      }),
    ],
  ];
  assert.deepEqual(
    refusals.map(([name, r]) => [name, r.status]),
    [
      ["unauthenticated post", 401],
      ["anonymous session post", 401],
      ["unauthenticated list", 401],
      ["foreign origin", 403],
      ["no origin", 403],
      ["wrong csrf", 403],
      ["no csrf", 403],
    ],
  );
  assert.deepEqual(push.read().subscriptions, []);
});

test("a CLI credential of either scope is refused on every push route", async (t) => {
  const { fake, push, s } = await httpFixture(t);
  const device = fake.device();
  const { subscription: row } = (await (
    await s.sessionPost(SUBSCRIPTIONS, subscription(device))
  ).json()) as { subscription: { id: string } };
  for (const scope of ["read", "read-write"] as const) {
    const { token } = await s.issue(scope, `cli-${scope}`);
    for (const [method, path, body] of [
      ["GET", NOTIFICATIONS, undefined],
      ["POST", SUBSCRIPTIONS, subscription(fake.device())],
      ["POST", `${SUBSCRIPTIONS}/${row.id}/revoke`, {}],
      ["POST", `${SUBSCRIPTIONS}/${row.id}/test`, {}],
    ] as const) {
      const r = await s.bearer(token, path, {
        method,
        ...(body ? { body } : {}),
      });
      assert.equal(r.status, 403, `${scope} ${method} ${path}`);
      assert.equal(
        ((await r.json()) as { error: { code: string } }).error.code,
        "forbidden",
      );
    }
  }
  assert.equal(push.read().subscriptions.length, 1);
  assert.equal(fake.requests.length, 0);
});

test("push routes validate bodies, ids and methods", async (t) => {
  const { fake, push, s } = await httpFixture(t);
  const device = fake.device();
  const post = async (body: unknown, path = SUBSCRIPTIONS) =>
    (await s.sessionPost(path, body)).status;
  assert.equal(await post({ ...subscription(device), extra: true }), 400);
  assert.equal(
    await post({
      ...subscription(device),
      endpoint: "http://fcm.googleapis.com/x",
    }),
    400,
  );
  assert.equal(
    await post({ ...subscription(device), endpoint: "https://evil.test/x" }),
    400,
  );
  assert.equal(await post({ ...subscription(device), label: "" }), 400);
  assert.equal(await post({}), 400);
  const big = await s.sessionPost(SUBSCRIPTIONS, {
    ...subscription(device),
    label: "x".repeat(200_000),
  });
  assert.equal(big.status, 413);
  assert.equal(
    ((await big.json()) as { error: { code: string } }).error.code,
    "body-too-large",
  );
  // A body that is not JSON is refused by type, with a valid session and token.
  assert.equal(
    (await s.sessionPost(SUBSCRIPTIONS, "x", { "content-type": "text/plain" }))
      .status,
    415,
  );
  assert.deepEqual(push.read().subscriptions, []);
  const missing = randomUUID();
  assert.equal(await post({}, `${SUBSCRIPTIONS}/${missing}/revoke`), 404);
  assert.equal(await post({}, `${SUBSCRIPTIONS}/${missing}/test`), 404);
  assert.equal(await post({}, `${SUBSCRIPTIONS}/not-a-uuid/revoke`), 404);
  const { subscription: row } = (await (
    await s.sessionPost(SUBSCRIPTIONS, subscription(device))
  ).json()) as { subscription: { id: string } };
  assert.equal(
    await post({ force: true }, `${SUBSCRIPTIONS}/${row.id}/revoke`),
    400,
  );
  assert.equal(
    await post({ force: true }, `${SUBSCRIPTIONS}/${row.id}/test`),
    400,
  );
  assert.equal(push.read().subscriptions[0]?.state, "active");
  for (const path of [
    SUBSCRIPTIONS,
    `${SUBSCRIPTIONS}/${row.id}/revoke`,
    `${SUBSCRIPTIONS}/${row.id}/test`,
  ])
    assert.equal((await s.sessionGet(path)).status, 405, path);
  assert.equal(await post({}, NOTIFICATIONS), 405);
  assert.equal((await s.sessionGet(`${NOTIFICATIONS}?x=1`)).status, 400);
  assert.equal(
    (
      await fetch(`${s.origin}${SUBSCRIPTIONS}/${row.id}`, {
        method: "DELETE",
        headers: { cookie: s.cookie, origin: s.authOrigin },
      })
    ).status,
    404,
  );
});

test("the service worker is served publicly with its scope and without caching", async () => {
  const f = await createOperatorFixture();
  try {
    const web = await f.startWeb();
    const response = await fetch(`${web.origin}/app/service-worker.js`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/javascript/,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.match(text, /addEventListener\("push"/);
    const head = await fetch(`${web.origin}/app/service-worker.js`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await fetch(`${web.origin}/app/service-worker.js`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 405);
    // An unknown address under /app is still the 404 shell, not the worker.
    const unknown = await fetch(`${web.origin}/app/service-worker.js/extra`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.text()).includes("addEventListener"), false);
  } finally {
    await f.close();
  }
});

test("a push listener stops its timers and in-flight sends when the listener stops", async () => {
  const f = await createOperatorFixture();
  try {
    const fake = new FakePushService();
    const clock = new ManualPushClock();
    const web = await f.startWeb([f.directory], undefined, {
      transport: fake.transport,
      clock,
      intervalMs: 15_000,
    });
    const push = web.push;
    assert.equal(
      clock.pending(),
      1,
      "the poll is armed after the listener starts",
    );
    const device = fake.device();
    const row = push.subscribe(subscription(device));
    // A send that never answers must not hold shutdown up.
    fake.script(device, "hang");
    const hung = push.test(row.id);
    await settle(() => fake.requests.length === 1);
    await web.http.stop();
    assert.equal(await hung, "unavailable");
    assert.equal(fake.inFlight, 0, "the abort released the in-flight send");
    assert.equal(clock.pending(), 0, "the poll timer is cleared on stop");
    clock.advance(60_000);
    await push.settle();
    assert.equal(fake.requests.length, 1, "nothing is sent after stop");
    assert.equal(await push.test(row.id), "unavailable");
    assert.equal(fake.requests.length, 1);
  } finally {
    await f.close();
  }
});
