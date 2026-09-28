import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexRuntime } from "../src/standalone/codex.js";

test("conflicting and identity-free terminal reports are surfaced as anomalies", async () => {
  const runtime = new CodexRuntime();
  const anomalies: string[] = [];
  runtime.onTerminalAnomaly((event) => anomalies.push(event.reason));
  const receive = (message: unknown) =>
    (runtime as unknown as { receive(line: string): void }).receive(
      JSON.stringify(message),
    );
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

test("App Server exit during initialization rejects promptly", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-init-exit-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({id: message.id, result: {}}) + "\n", () => process.exit(0));
  }
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  try {
    await assert.rejects(
      bounded(runtime.start(), 3000),
      /App Server exited|Runtime stopped/,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
