import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const ORIGIN = "http://127.0.0.1:8787";

type Listener = (event: unknown) => void;
interface FakeClient {
  url: string;
  focused: number;
  navigated: string[];
  focus(): Promise<void>;
  navigate(url: string): Promise<void>;
}

/** The worker source, run against a fake worker scope: no browser. */
async function load(clients: FakeClient[] = []) {
  const source = await readFile(
    new URL("../../../web/public/service-worker.js", import.meta.url),
    "utf8",
  );
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  let claimed = 0;
  let skipped = 0;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    skipWaiting: () => {
      skipped++;
    },
    registration: {
      showNotification: async (
        title: string,
        options: Record<string, unknown>,
      ) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {
        claimed++;
      },
      matchAll: async () => clients,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  runInNewContext(source, { self, URL });
  const waits: Promise<unknown>[] = [];
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits.splice(0));
  };
  const push = (data: unknown) =>
    dispatch("push", {
      data: {
        json: () => {
          if (data instanceof Error) throw data;
          return data;
        },
      },
    });
  const closed: string[] = [];
  const click = (url: unknown) =>
    dispatch("notificationclick", {
      notification: { data: { url }, close: () => closed.push("closed") },
    });
  return {
    listeners,
    shown,
    opened,
    closed,
    push,
    click,
    dispatch,
    counts: () => ({ claimed, skipped }),
  };
}

/** Values built inside the worker's realm, as plain data for comparison. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const valid = (url: string, title = "Question in Relay: 1 waiting") => ({
  v: 1,
  title,
  url,
  tag: "q1",
});

test("a valid push shows the payload's title, tag and link, for a task and for a runtime", async () => {
  const w = await load();
  await w.push(valid("/app/inbox?task=T&request=Q"));
  await w.push({
    v: 1,
    title: "Codex runtime unavailable",
    url: "/app/inbox?request=runtime%3Acodex",
    tag: "runtime:codex:5",
  });
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0]?.title, "Question in Relay: 1 waiting");
  assert.equal(w.shown[0]?.options.tag, "q1");
  assert.deepEqual(plain(w.shown[0]?.options.data), {
    url: "/app/inbox?task=T&request=Q",
  });
  assert.equal(w.shown[1]?.title, "Codex runtime unavailable");
  assert.equal(w.shown[1]?.options.tag, "runtime:codex:5");
  assert.deepEqual(plain(w.shown[1]?.options.data), {
    url: "/app/inbox?request=runtime%3Acodex",
  });
  // The body is fixed text; nothing from the payload becomes body content.
  assert.equal(w.shown[0]?.options.body, "Open Ensemble to respond.");
});

test("the Settings link of a test notification is accepted", async () => {
  const w = await load();
  await w.push({
    v: 1,
    title: "Test notification from Ensemble",
    url: "/app/settings#notifications",
    tag: "test:notification",
  });
  assert.deepEqual(plain(w.shown[0]?.options.data), {
    url: "/app/settings#notifications",
  });
});

test("an invalid link, version, shape or payload shows the fixed notification linking to the Inbox", async () => {
  const w = await load();
  const bad: unknown[] = [
    valid("https://evil.test/"),
    valid("//evil.test"),
    valid("/api/operator/inbox"),
    valid("/app/settings/runtime"),
    valid("/app/inbox"),
    valid("/app/inbox?x= y"),
    valid("javascript:alert(1)"),
    { ...valid("/app/inbox?a=1"), v: 2 },
    { ...valid("/app/inbox?a=1"), title: "" },
    { ...valid("/app/inbox?a=1"), title: "x".repeat(201) },
    { ...valid("/app/inbox?a=1"), tag: "" },
    { ...valid("/app/inbox?a=1"), title: 5 },
    null,
    "text",
    [],
    new Error("not json"),
  ];
  for (const payload of bad) await w.push(payload);
  assert.equal(w.shown.length, bad.length);
  for (const note of w.shown) {
    assert.equal(note.title, "Ensemble needs you");
    assert.deepEqual(plain(note.options.data), { url: "/app/inbox" });
  }
});

const client = (url: string): FakeClient => ({
  url,
  focused: 0,
  navigated: [],
  async focus() {
    this.focused++;
  },
  async navigate(to: string) {
    this.navigated.push(to);
  },
});

test("a click focuses and navigates an open app window and never opens another", async () => {
  const app = client(`${ORIGIN}/app/tasks`);
  const w = await load([
    client("https://other.test/app/x"),
    client(`${ORIGIN}/login`),
    app,
  ]);
  await w.click("/app/inbox?request=runtime%3Acodex");
  assert.equal(app.focused, 1);
  assert.deepEqual(app.navigated, ["/app/inbox?request=runtime%3Acodex"]);
  assert.deepEqual(w.opened, []);
  assert.deepEqual(w.closed, ["closed"]);
});

test("a click with no app window opens one at the link", async () => {
  const w = await load([client("https://other.test/app/x")]);
  await w.click("/app/inbox?task=T&request=Q");
  assert.deepEqual(w.opened, ["/app/inbox?task=T&request=Q"]);
  assert.deepEqual(w.closed, ["closed"]);
});

test("a click on a notification with a foreign link opens the Inbox instead", async () => {
  const w = await load();
  await w.click("https://evil.test/");
  assert.deepEqual(w.opened, ["/app/inbox"]);
});

test("a window the worker cannot navigate is replaced by a new one", async () => {
  const stubborn: FakeClient = {
    ...client(`${ORIGIN}/app/inbox`),
    async navigate() {
      throw new Error("not controlled");
    },
  };
  const w = await load([stubborn]);
  await w.click("/app/inbox?request=Q");
  assert.deepEqual(w.opened, ["/app/inbox?request=Q"]);
});

test("the worker takes over immediately and has no fetch handler", async () => {
  const w = await load();
  await w.dispatch("install", {});
  await w.dispatch("activate", {});
  assert.deepEqual(w.counts(), { claimed: 1, skipped: 1 });
  assert.deepEqual([...w.listeners.keys()].sort(), [
    "activate",
    "install",
    "notificationclick",
    "push",
  ]);
});
