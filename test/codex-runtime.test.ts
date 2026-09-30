import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexRuntime } from "../src/standalone/codex.js";

test("conflicting and identity-free terminal reports are surfaced as anomalies", async () => {
  const runtime = new CodexRuntime();
  const anomalies: string[] = [];
  runtime.onTerminalAnomaly((event) => anomalies.push(event.reason));
  const child = {} as ChildProcessWithoutNullStreams;
  (runtime as unknown as { child: ChildProcessWithoutNullStreams }).child =
    child;
  const receive = (message: unknown) =>
    (
      runtime as unknown as {
        receive(child: ChildProcessWithoutNullStreams, line: string): void;
      }
    ).receive(child, JSON.stringify(message));
  receive({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
  });
  receive({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "failed" } },
  });
  receive({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  assert.deepEqual(anomalies, [
    "Conflicting terminal status",
    "Missing terminal identity or status",
  ]);
  assert.equal(await runtime.waitForTurn("thread", "turn"), "failed");
});

test("failure evidence is exact-turn-bound and only classifies the retry allowlist", () => {
  const runtime = new CodexRuntime();
  const child = {} as ChildProcessWithoutNullStreams;
  (runtime as unknown as { child: ChildProcessWithoutNullStreams }).child =
    child;
  const receive = (
    threadId: string,
    turnId: string,
    error: unknown,
    status = "failed",
  ) =>
    (
      runtime as unknown as {
        receive(child: ChildProcessWithoutNullStreams, line: string): void;
      }
    ).receive(
      child,
      JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status, error } },
      }),
    );

  receive("thread", "overloaded", { codexErrorInfo: "serverOverloaded" });
  receive("thread", "rate-limit", { codexErrorInfo: "rateLimitExceeded" });
  receive("thread", "permanent", { codexErrorInfo: "badRequest" });
  receive("thread", "other", { codexErrorInfo: "internalServerError" });
  receive(
    "thread",
    "interrupted",
    { codexErrorInfo: "serverOverloaded" },
    "interrupted",
  );
  receive("thread", "missing", null);

  const evidence = (threadId: string, turnId: string) =>
    (
      runtime as unknown as {
        failureEvidence(threadId: string, turnId: string): unknown;
      }
    ).failureEvidence(threadId, turnId);
  assert.deepEqual(evidence("thread", "overloaded"), {
    threadId: "thread",
    turnId: "overloaded",
    status: "failed",
    classification: "transient",
    reasonCode: "serverOverloaded",
    source: "codexErrorInfo",
    codexRetries: null,
  });
  assert.equal(
    (evidence("thread", "rate-limit") as { classification: string })
      .classification,
    "transient",
  );
  assert.equal(
    (evidence("thread", "permanent") as { classification: string })
      .classification,
    "permanent",
  );
  assert.equal(
    (evidence("thread", "other") as { classification: string }).classification,
    "unknown",
  );
  assert.equal(evidence("thread", "interrupted"), undefined);
  assert.equal(
    (evidence("thread", "missing") as { classification: string })
      .classification,
    "unknown",
  );
  assert.equal(evidence("another-thread", "overloaded"), undefined);
});

function bounded<T>(action: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fake App Server RPC stalled")),
      milliseconds,
    );
    action.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("large discarded stderr cannot stall App Server initialization or RPC", {
  timeout: 12000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-pipe-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({input: process.stdin});
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  // More than a typical OS pipe can buffer. Reply only after stderr drains.
  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 88), () => {
    let result = {};
    if (message.method === "account/read") result = {account: {type: "chatgpt"}};
    if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
    if (message.method === "thread/start") result = {thread: {id: "thread-1"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
    if (message.method === "turn/start") result = {turn: {id: "turn-1"}};
    process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
    if (message.method === "turn/start") process.stdout.write(JSON.stringify({method: "turn/completed", params: {threadId: "thread-1", turn: {id: "turn-1", status: "completed"}}}) + "\n");
  });
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const started = runtime.start();
  try {
    await bounded(started, 5000);
    assert.equal(await bounded(runtime.startThread(root), 5000), "thread-1");
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "test"), 5000),
      "turn-1",
    );
    assert.equal(
      await bounded(runtime.waitForTurn("thread-1", "turn-1"), 5000),
      "completed",
    );
  } finally {
    await runtime.stop();
    await Promise.allSettled([started]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn interrupt uses the bound App Server identities and validates its response", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-interrupt-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "account/read") {
    process.stdout.write(JSON.stringify({id: message.id, result: {account: {type: "chatgpt"}}}) + "\n");
    continue;
  }
  if (message.method === "config/read") {
    process.stdout.write(JSON.stringify({id: message.id, result: {config: {approval_policy: "never", sandbox_mode: "workspace-write"}}}) + "\n");
    continue;
  }
  if (message.method === "turn/interrupt" && (message.params.threadId !== "thread-7" || message.params.turnId !== "turn-9")) {
    process.stdout.write(JSON.stringify({id: message.id, error: {message: "Unexpected interrupt identity"}}) + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify({id: message.id, result: {}}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  try {
    await bounded(runtime.start(), 3000);
    await bounded(
      (
        runtime as unknown as {
          interruptTurn(threadId: string, turnId: string): Promise<void>;
        }
      ).interruptTurn("thread-7", "turn-9"),
      3000,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdin closure during initialization rejects promptly", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-init-pipe-"));
  const executable = join(root, "fake-codex.sh");
  writeFileSync(
    executable,
    `#!/bin/sh
IFS= read -r request
exec 0<&-
printf '{"id":1,"result":{}}\\n'
exec sleep 10
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  try {
    await assert.rejects(
      bounded(runtime.start(), 3000),
      /stdin closed|EPIPE|Runtime stopped/,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("late events from a stopped child cannot fail a restarted runtime", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-restart-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result = {};
  if (message.method === "account/read") result = {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
  if (message.method === "thread/start") result = {thread: {id: "new-thread"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const processRef = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
  };
  let stopping: Promise<void> | undefined;
  try {
    await bounded(runtime.start(), 3000);
    const old = processRef.child;
    assert.ok(old);
    stopping = runtime.stop();
    await bounded(runtime.start(), 3000);
    old.stdout.emit("data", Buffer.from("invalid old message\n"));
    old.kill("SIGKILL");
    await bounded(stopping, 3000);
    old.stdin.emit("error", new Error("late old stdin error"));
    assert.equal(await bounded(runtime.startThread(root), 3000), "new-thread");
    const pending = runtime.startThread(root);
    const current = processRef.child;
    assert.ok(current);
    current.stdin.emit("close");
    await assert.rejects(bounded(pending, 1000), /stdin closed/);
  } finally {
    processRef.child?.kill("SIGKILL");
    await runtime.stop();
    if (stopping) await Promise.allSettled([stopping]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic tool registration is passed to thread/start", async () => {
  const runtime = new CodexRuntime();
  const request = runtime as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
    startThread(workspace: string, tools: unknown[]): Promise<string>;
  };
  let observed: unknown;
  request.request = async (method, params) => {
    assert.equal(method, "thread/start");
    observed = params;
    return {
      thread: { id: "thread-1" },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
    };
  };
  const tools = [
    {
      type: "function",
      name: "test_tool",
      description: "A test-only dynamic tool.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  assert.equal(await request.startThread("/tmp/workspace", tools), "thread-1");
  assert.deepEqual(observed, {
    cwd: "/tmp/workspace",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
    dynamicTools: tools,
  });
});

test("App Server dynamic callbacks use the registered function and server identity", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-tool-call-"));
  const executable = join(root, "fake-codex.mjs");
  const reportPath = join(root, "report.json");
  const source = [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    "import { writeFile } from 'node:fs/promises';",
    `const reportPath = ${JSON.stringify(reportPath)};`,
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') {",
    "    if (message.params.capabilities?.experimentalApi !== true) {",
    "      write({ id: message.id, error: { message: 'experimental API missing' } });",
    "    } else write({ id: message.id, result: {} });",
    "  } else if (message.method === 'account/read') {",
    "    write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
    "  } else if (message.method === 'config/read') {",
    "    write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
    "  } else if (message.method === 'thread/start') {",
    "    const tool = message.params.dynamicTools?.find((item) => item.name === 'test_tool');",
    "    if (!tool) { write({ id: message.id, error: { message: 'tool missing' } }); continue; }",
    "    await writeFile(reportPath, JSON.stringify({ experimentalApi: true, tool }));",
    "    write({ id: message.id, result: { thread: { id: 'thread-1' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } } });",
    "    write({ id: 700, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'test_tool', arguments: { value: 'payload' } } });",
    "  } else if (message.id === 700) {",
    "    const accepted = message.result?.success === true && message.result?.contentItems?.[0]?.text === 'accepted';",
    "    await writeFile(reportPath, JSON.stringify({ ...(JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'))), response: message.result }));",
    "    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: accepted ? 'completed' : 'failed' } } });",
    "  }",
    "}",
  ].join("\n");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const calls: unknown[] = [];
  runtime.onToolCall?.(async (call) => {
    calls.push(call);
    return { text: "accepted", success: true };
  });
  const tools = [
    {
      type: "function" as const,
      name: "test_tool",
      description: "A test-only dynamic tool.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ];
  try {
    await bounded(runtime.start(), 3000);
    const threadId = await bounded(runtime.startThread(root, tools), 3000);
    const turnId = await bounded(
      (async () => {
        for (let i = 0; i < 100; i++) {
          if (calls.length > 0) return "turn-1";
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("dynamic tool callback was not dispatched");
      })(),
      2000,
    );
    assert.equal(threadId, "thread-1");
    assert.equal(
      await bounded(runtime.waitForTurn(threadId, turnId), 2000),
      "completed",
    );
    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "test_tool",
        arguments: { value: "payload" },
      },
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      experimentalApi: boolean;
      tool: unknown;
      response: unknown;
    };
    assert.equal(report.experimentalApi, true);
    assert.deepEqual(report.tool, tools[0]);
    assert.deepEqual(report.response, {
      contentItems: [{ type: "inputText", text: "accepted" }],
      success: true,
    });
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unregistered and malformed callbacks fail closed while approvals stay denied", async () => {
  const runtime = new CodexRuntime();
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {},
  } as unknown as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    send(line: string): Promise<void>;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
    threadTools: Map<string, readonly { name: string }[]>;
  };
  internal.child = child;
  internal.threadTools.set("thread-1", [{ name: "test_tool" }]);
  const responses: unknown[] = [];
  const unexpected: unknown[] = [];
  internal.send = async (line) => {
    responses.push(JSON.parse(line));
  };
  runtime.onUnexpectedRequest((request) => unexpected.push(request));
  runtime.onToolCall?.(async () => ({ text: "should not run", success: true }));
  internal.receive(
    child,
    JSON.stringify({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "unknown",
        tool: "unregistered",
        arguments: {},
      },
    }),
  );
  internal.receive(
    child,
    JSON.stringify({
      id: 2,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "test_tool",
        arguments: [],
      },
    }),
  );
  internal.receive(
    child,
    JSON.stringify({
      id: 3,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unexpected.length, 3);
  assert.deepEqual(responses, [
    {
      id: 1,
      result: {
        contentItems: [{ type: "inputText", text: "not authorized" }],
        success: false,
      },
    },
    {
      id: 2,
      result: {
        contentItems: [{ type: "inputText", text: "not authorized" }],
        success: false,
      },
    },
    { id: 3, result: { decision: "cancel" } },
  ]);
});

test("handler rejection is bounded and response-pipe failure fails the runtime", async () => {
  const runtime = new CodexRuntime();
  let kills = 0;
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {
      kills++;
    },
  } as unknown as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    send(line: string): Promise<void>;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
    threadTools: Map<string, readonly { name: string }[]>;
  };
  internal.child = child;
  internal.threadTools.set("thread-1", [{ name: "test_tool" }]);
  const responses: unknown[] = [];
  internal.send = async (line) => {
    responses.push(JSON.parse(line));
  };
  runtime.onToolCall?.(async () => {
    throw new Error("private implementation detail");
  });
  internal.receive(
    child,
    JSON.stringify({
      id: 4,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-4",
        tool: "test_tool",
        arguments: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses, [
    {
      id: 4,
      result: {
        contentItems: [{ type: "inputText", text: "request failed" }],
        success: false,
      },
    },
  ]);

  internal.send = async () => {
    throw new Error("response pipe failed");
  };
  internal.receive(
    child,
    JSON.stringify({
      id: 5,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-5",
        tool: "test_tool",
        arguments: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
});
