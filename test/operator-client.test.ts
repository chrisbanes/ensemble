import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorClient, ClientError } from "../web/src/api.js";
import { ResourceController } from "../web/src/resource.js";
import { workspaceSchema, type Workspace } from "../src/operator/contracts.js";
const good: Workspace = {
  data: { projects: [], profiles: [], runtime: { state: "available" } },
  observedAt: 42,
};
test("validated client rejects invalid success and lost writes remain unknown with original key", async () => {
  const sent: string[] = [];
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    if (init?.method === "POST") throw Error("lost");
    return new Response(JSON.stringify({ unexpected: "row" }), { status: 200 });
  });
  await assert.rejects(
    client.read("/api/operator/workspace", workspaceSchema),
    ClientError,
  );
  const command = {
    type: "task.create" as const,
    key: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    title: "Task",
    outcome: "Finish",
    ready: false,
  };
  for (let i = 0; i < 2; i++) {
    const result = await client.command(command, "token");
    assert.equal(result.state, "unknown");
  }
  assert.equal(sent[1], sent[2]);
});
test("resource retains last good fetch on failed refresh and excludes older completion", async () => {
  const resource = new ResourceController<typeof good>();
  let finish!: (value: typeof good) => void;
  const old = resource.load(() => new Promise((done) => (finish = done)));
  assert.equal(resource.state.status, "loading");
  await resource.load(async () => good);
  finish({ ...good, observedAt: 1 });
  await old;
  assert.equal(resource.state.data?.observedAt, 42);
  await resource.load(async () => {
    throw new ClientError("unavailable", 503);
  });
  assert.equal(resource.state.status, "stale");
  assert.equal(resource.state.data?.observedAt, 42);
  resource.clear();
  assert.equal(resource.state.data, null);
});
test("401 discards private resource; 409 keeps command key and entered material", async () => {
  let expired = 0;
  let status = 401;
  const client = new OperatorClient(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: status === 401 ? "unauthenticated" : "conflict",
            message: "Review state.",
          },
        }),
        { status },
      ),
    () => expired++,
  );
  const resource = new ResourceController<typeof good>();
  await resource.load(async () => good);
  await resource.load((signal) =>
    client.read("/api/operator/workspace", workspaceSchema, signal),
  );
  assert.equal(expired, 1);
  assert.equal(resource.state.data, null);
  status = 409;
  const command = {
    type: "task.create" as const,
    key: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    title: "Retain entered title",
    outcome: "Keep input",
    ready: true,
  };
  const result = await client.command(command, "csrf");
  assert.equal(result.state, "conflict");
  assert.deepEqual(result.command, command);
});
test("disposed and replaced resources abort delayed reads without updating retained data", async () => {
  const resource = new ResourceController<typeof good>();
  let finish!: (value: typeof good) => void;
  let signal: AbortSignal | undefined;
  const pending = resource.load((s) => {
    signal = s;
    return new Promise((done) => (finish = done));
  });
  resource.dispose();
  assert.equal(signal?.aborted, true);
  finish(good);
  await pending;
  assert.equal(resource.state.data, null);
  const next = new ResourceController<typeof good>();
  assert.equal(JSON.stringify(next.state.data), "null");
  await next.load(async () => good);
  assert.equal(next.state.data?.observedAt, 42);
});
test("old command and read 401 cannot expire a replacement authentication lifetime; current 401 still expires", async () => {
  for (const method of ["read", "command"] as const) {
    let release!: (r: Response) => void;
    let expired = 0;
    const client = new OperatorClient(
      () =>
        new Promise<Response>((done) => {
          release = done;
        }),
      () => expired++,
    );
    const c = {
      type: "task.create" as const,
      key: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: "Task",
      outcome: "Finish",
      ready: false,
    };
    const sending =
      method === "command"
        ? client.command(c, "old")
        : client
            .read("/api/operator/workspace", workspaceSchema)
            .catch(() => null);
    client.invalidateAuthentication();
    release(
      Response.json(
        { error: { code: "unauthenticated", message: "Sign in" } },
        { status: 401 },
      ),
    );
    await sending;
    assert.equal(expired, 0, method);
    const current = client
      .read("/api/operator/workspace", workspaceSchema)
      .catch(() => null);
    release(Response.json({}, { status: 401 }));
    await current;
    assert.equal(expired, 1, method);
  }
});
test("captured session callbacks discard old success and error while current observations retain authority", async () => {
  for (const failed of [false, true]) {
    let release!: (r: Response) => void;
    const client = new OperatorClient(
      () =>
        new Promise<Response>((done) => {
          release = done;
        }),
    );
    let session = "r".repeat(43);
    let error = false;
    const isCurrent = client.captureAuthenticationScope();
    const pending = client.session().then(
      (s) => {
        if (isCurrent()) session = s.csrfToken;
      },
      () => {
        if (isCurrent()) error = true;
      },
    );
    client.invalidateAuthentication();
    release(
      failed
        ? Response.json({}, { status: 503 })
        : Response.json({ authenticated: true, csrfToken: "o".repeat(43) }),
    );
    await pending;
    assert.equal(session, "r".repeat(43));
    assert.equal(error, false);
    const scope = client.captureAuthenticationScope();
    const observation = client.session().then((s) => {
      if (scope()) session = s.csrfToken;
    });
    release(Response.json({ authenticated: true, csrfToken: "r".repeat(43) }));
    await observation;
    assert.equal(scope(), true);
    assert.equal(session, "r".repeat(43));
  }
});
import { ConfigurationDrafts } from "../web/src/settings-state.js";
import { ComposerState, storageKey } from "../web/src/composer-state.js";
test("request authentication scope preserves replacement private draft and durable composer owner after old 401", async () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      saved.set(k, v);
    },
    removeItem: (k: string) => {
      saved.delete(k);
    },
  };
  const composer = new ComposerState(storage);
  composer.edit({
    projectId: crypto.randomUUID(),
    title: "Original",
    outcome: "Finish",
  });
  let release!: (r: Response) => void;
  const drafts = new ConfigurationDrafts();
  let session = "old",
    expiry = 0;
  const client = new OperatorClient(
    () =>
      new Promise<Response>((done) => {
        release = done;
      }),
    () => {
      expiry++;
      session = "expired";
      drafts.purge();
    },
  );
  const sending = composer.submit(client, "old", false);
  const bytes = storage.getItem(storageKey);
  client.invalidateAuthentication();
  drafts.purge();
  composer.dispose();
  session = "new";
  const replacement = new ComposerState(storage);
  const draft = drafts.get("profile", () => {});
  draft.set("instructions", "NEW PRIVATE INPUT");
  release(Response.json({}, { status: 401 }));
  await sending;
  assert.equal(expiry, 0);
  assert.equal(session, "new");
  assert.equal(draft.values.instructions, "NEW PRIVATE INPUT");
  assert.equal(replacement.phase, "unknown");
  assert.equal(storage.getItem(storageKey), bytes);
  const current = client
    .read("/api/operator/workspace", workspaceSchema)
    .catch(() => null);
  release(Response.json({}, { status: 401 }));
  await current;
  assert.equal(expiry, 1);
  assert.equal(session, "expired");
  assert.deepEqual(draft.values, {});
  assert.equal(storage.getItem(storageKey), bytes);
});
