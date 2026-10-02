import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorClient, ClientError } from "../web/src/api.js";
import { ResourceController } from "../web/src/resource.js";
import { workspaceSchema, type Workspace } from "../src/operator/contracts.js";
const good: Workspace = {
  data: { projects: [], profiles: [] },
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
