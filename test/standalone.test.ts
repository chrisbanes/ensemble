import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/core/store.js";
import { StandaloneService } from "../src/standalone/service.js";
import { ExecutionState } from "../src/standalone/state.js";
import type { Runtime } from "../src/standalone/codex.js";
import {
  CodexRuntime,
  deniedServerRequest,
  executionPolicy,
  unexpectedRequest,
  type UnexpectedRequest,
} from "../src/standalone/codex.js";

class FakeRuntime implements Runtime {
  onRequest: ((request: UnexpectedRequest) => void) | undefined;
  failAt: "start" | "thread" | "turn" | "wait" | undefined;
  starts = 0;
  turnStarts = 0;
  approveDuringWait = false;
  failStop = false;
  threadGate: Promise<void> | undefined;
  onThreadEntered: (() => void) | undefined;
  turnGate: Promise<void> | undefined;
  onTurnEntered: (() => void) | undefined;
  async start() {
    if (this.failAt === "start") throw new Error("login unavailable");
  }
  async stop() {
    if (this.failStop) {
      this.failStop = false;
      throw new Error("injected stop failure");
    }
  }
  async startThread() {
    this.starts++;
    this.onThreadEntered?.();
    await this.threadGate;
    if (this.failAt === "thread") throw new Error("lost thread response");
    return "thread-1";
  }
  async resumeThread(id: string) {
    assert.equal(id, "thread-1");
  }
  async startTurn() {
    this.turnStarts++;
    this.onTurnEntered?.();
    await this.turnGate;
    if (this.failAt === "turn") throw new Error("lost turn response");
    return "turn-1";
  }
  async interruptTurn() {}
  async waitForTurn() {
    if (this.approveDuringWait)
      this.onRequest?.({ method: "item/permissions/requestApproval" });
    if (this.failAt === "wait") throw new Error("lost terminal status");
    return "completed" as const;
  }
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void) {
    this.onRequest = listener;
  }
}

const ownerScript = `
import { StandaloneService } from process.argv[1];
const service = new StandaloneService(process.argv[2], () => ({
  async start() {}, async stop() {}, onUnexpectedRequest() {}
}));
await service.start();
process.stdout.write('ready\\n');
process.stdin.once('data', async () => { await service.stop(); process.exit(0); });
`;

async function ownerProcess(
  data: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      ownerScript.replace(
        "import { StandaloneService } from process.argv[1];",
        "const { StandaloneService } = await import(process.argv[1]);",
      ),
      new URL("../src/standalone/service.js", import.meta.url).href,
      data,
    ],
    { stdio: "pipe" },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`Owner exited ${code}`)));
    setTimeout(
      () => reject(new Error("Owner startup timed out")),
      5000,
    ).unref();
  });
  return child;
}

test("canonical directory has one process owner; crash and failed startup release ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-owner-"));
  const data = join(root, "data");
  const alias = join(root, "alias");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = await ownerProcess(data);
    symlinkSync(root, alias);
    const second = new StandaloneService(
      join(alias, "data"),
      () => new FakeRuntime(),
    );
    await assert.rejects(second.start(), /already owned/);
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    const state = new ExecutionState(db);
    const row = state.create("live", "test", workspace);
    assert.equal(state.begin(row.id), true);
    assert.equal(state.bindThread(row.id, "thread-live"), true);
    assert.equal(state.bindTurn(row.id, "turn-live"), true);
    for (const args of [
      ["list", data],
      ["run", join(alias, "data"), "second", "test", workspace],
    ]) {
      const attempt = spawnSync(
        process.execPath,
        [
          new URL("../src/standalone/cli.js", import.meta.url).pathname,
          ...args,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.notEqual(attempt.status, 0);
      assert.match(attempt.stderr, /already owned/);
    }
    await assert.rejects(
      new StandaloneService(data, () => new FakeRuntime()).start(),
      /already owned/,
    );
    assert.equal(state.get(row.id).state, "running");
    db.close();
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    child = undefined;
    const recovered = new StandaloneService(data, () => new FakeRuntime());
    await recovered.start();
    assert.equal(
      recovered.list().find((item) => item.workId === "live")?.state,
      "held",
    );
    assert.equal(
      (await recovered.submit("live", "test", workspace)).state,
      "held",
    );
    await recovered.stop();
    const failed = new FakeRuntime();
    failed.failAt = "start";
    await assert.rejects(
      new StandaloneService(data, () => failed).start(),
      /login unavailable/,
    );
    const next = new StandaloneService(data, () => new FakeRuntime());
    await next.start();
    await next.stop();
  } finally {
    child?.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruption before ownership-file creation leaves a restartable marked directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-marker-restart-"));
  const data = join(root, "data");
  mkdirSync(data);
  writeFileSync(join(data, ".ensemble-standalone"), "ensemble-standalone-v1\n");
  assert.equal(existsSync(join(data, ".ensemble-owner.sqlite")), false);
  const first = new StandaloneService(data, () => new FakeRuntime());
  const second = new StandaloneService(data, () => new FakeRuntime());
  try {
    const starts = await Promise.allSettled([first.start(), second.start()]);
    assert.equal(
      starts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = starts.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected")
      assert.match(String(rejected.reason), /already owned/);
    assert.equal(existsSync(join(data, "standalone.sqlite")), true);
    await first.stop();
    await second.stop();
    const recovered = new StandaloneService(data, () => new FakeRuntime());
    await recovered.start();
    assert.deepEqual(recovered.list(), []);
    await recovered.stop();
  } finally {
    await first.stop();
    await second.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted first-start owner and partial marker recover under the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-first-start-"));
  const crashed = join(root, "crashed");
  const partial = join(root, "partial");
  const unrelated = join(root, "unrelated");
  mkdirSync(crashed);
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "prototype.db"), "preserve");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const { join } = require('node:path');
      const owner = new DatabaseSync(join(process.argv[1], '.ensemble-owner.sqlite'));
      owner.exec('BEGIN IMMEDIATE');
      process.kill(process.pid, 'SIGKILL');
    `,
        crashed,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.signal, "SIGKILL", result.stderr);
    assert.equal(existsSync(join(crashed, ".ensemble-standalone")), false);
    const recovered = new StandaloneService(crashed, () => new FakeRuntime());
    await recovered.start();
    await recovered.stop();
    assert.equal(
      readFileSync(join(crashed, ".ensemble-standalone"), "utf8"),
      "ensemble-standalone-v1\n",
    );

    const failed = new StandaloneService(
      partial,
      () => new FakeRuntime(),
      (path, flag) => {
        writeFileSync(path, "ensemble-", { flag });
        throw new Error("injected marker write failure");
      },
    );
    await assert.rejects(failed.start(), /injected marker write failure/);
    const afterFailure = new StandaloneService(
      partial,
      () => new FakeRuntime(),
    );
    await afterFailure.start();
    await afterFailure.stop();
    assert.equal(
      readFileSync(join(partial, ".ensemble-standalone"), "utf8"),
      "ensemble-standalone-v1\n",
    );

    await assert.rejects(
      new StandaloneService(unrelated, () => new FakeRuntime()).start(),
      /Unmarked data directory/,
    );
    assert.equal(
      readFileSync(join(unrelated, "prototype.db"), "utf8"),
      "preserve",
    );
    assert.equal(existsSync(join(unrelated, ".ensemble-owner.sqlite")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injected turn/start EPIPE settles submission and holds it across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-turn-pipe-"));
  const executable = join(root, "fake-codex.mjs");
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (!message.id) continue;
  let result = {};
  if (message.method === "account/read") result = {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
  if (message.method === "thread/start") result = {thread: {id: "thread-1"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
  if (message.method === "turn/start") continue;
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  let service = new StandaloneService(data, () => runtime, undefined, {
    power: { enabled: false },
  });
  try {
    await service.start();
    const child = (
      runtime as unknown as { child: ChildProcessWithoutNullStreams }
    ).child;
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (...args) => {
      child.stdin.destroy(
        Object.assign(new Error("injected EPIPE"), { code: "EPIPE" }),
      );
      return startTurn(...args);
    };
    const held = await service.submit("pipe-turn", "test", workspace);
    assert.equal(held.state, "held");
    assert.equal(held.threadId, "thread-1");
    assert.equal(held.turnId, null);
    assert.match(held.reason ?? "", /EPIPE/);
    await service.stop();
    service = new StandaloneService(data, () => new FakeRuntime());
    await service.start();
    assert.equal(
      (await service.submit("pipe-turn", "test", workspace)).state,
      "held",
    );
    assert.equal(
      (await service.submit("other", "test", workspace)).state,
      "ready",
    );
    assert.match(
      service.list().find((item) => item.workId === "other")?.reason ?? "",
      /Workspace has unresolved execution/,
    );
    assert.equal(
      service.turnRequests().find((item) => item.workId === "other")?.state,
      "queued",
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval denial pipe failure preserves a durable hold without granting access", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-approval-pipe-"));
  const executable = join(root, "fake-codex.mjs");
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (!message.id) continue;
  let result = {};
  if (message.method === "account/read") result = {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
  if (message.method === "thread/start") result = {thread: {id: "thread-1"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
  if (message.method === "turn/start") result = {turn: {id: "turn-1"}};
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
  if (message.method === "turn/start")
    process.stdout.write(JSON.stringify({id: 999, method: "item/commandExecution/requestApproval", params: {threadId: "thread-1", turnId: "turn-1"}}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  let service = new StandaloneService(data, () => runtime, undefined, {
    power: { enabled: false },
  });
  try {
    await service.start();
    const internals = runtime as unknown as {
      child: ChildProcessWithoutNullStreams;
      unexpected: (request: UnexpectedRequest) => void;
    };
    const hold = internals.unexpected;
    runtime.onUnexpectedRequest((request) => {
      hold(request);
      internals.child.stdin.destroy(
        Object.assign(new Error("injected EPIPE"), { code: "EPIPE" }),
      );
    });
    const held = await service.submit("approval-pipe", "test", workspace);
    assert.equal(held.state, "held");
    assert.match(held.reason ?? "", /Unexpected App Server request denied/);
    await service.stop();
    service = new StandaloneService(data, () => new FakeRuntime());
    await service.start();
    assert.equal(
      (await service.submit("approval-pipe", "test", workspace)).state,
      "held",
    );
    assert.equal(
      (await service.submit("next", "test", workspace)).state,
      "ready",
    );
    assert.equal(
      service.turnRequests().find((item) => item.workId === "next")?.state,
      "queued",
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("all installed approval callback forms deny without policy expansion", () => {
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
    "item/permissions/requestApproval",
  ]) {
    const response = deniedServerRequest(7, method);
    assert.equal(JSON.stringify(response).includes("accept"), false);
    assert.equal(JSON.stringify(response).includes("approved"), false);
    assert.equal(JSON.stringify(response).includes("grant"), false);
  }
  assert.deepEqual(executionPolicy("/work"), {
    type: "workspaceWrite",
    writableRoots: ["/work"],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  });
  assert.deepEqual(
    unexpectedRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
    }),
    {
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
    },
  );
  assert.deepEqual(
    unexpectedRequest("execCommandApproval", { conversationId: "thread-1" }),
    { method: "execCommandApproval" },
  );
});

test("fresh schema, restart, completed binding and no duplicate dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "new-data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  let runtime = new FakeRuntime();
  let service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const first = await service.submit("work-1", "reply only OK", workspace);
    assert.equal(first.state, "completed");
    assert.equal(first.threadId, "thread-1");
    await service.stop();
    runtime = new FakeRuntime();
    service = new StandaloneService(data, () => runtime);
    await service.start();
    assert.equal(
      (await service.submit("work-1", "reply only OK", workspace)).id,
      first.id,
    );
    assert.equal(runtime.starts, 0);
    const followup = await service.submit(
      "work-2",
      "reply again",
      workspace,
      "work-1",
    );
    assert.equal(followup.state, "completed");
    assert.equal(followup.threadId, first.threadId);
    assert.equal(runtime.starts, 0);
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      6,
    );
    assert.equal(
      (
        db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        }
      ).integrity_check,
      "ok",
    );
    db.close();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lost submission blocks a second work ID before and after reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  let runtime = new FakeRuntime();
  runtime.failAt = "turn";
  let service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const lost = await service.submit("lost", "test", workspace);
    assert.equal(lost.state, "held");
    assert.equal(lost.threadId, "thread-1");
    assert.equal(lost.turnId, null);
    const second = await service.submit(
      "second",
      "test",
      `${workspace}/../work`,
    );
    assert.equal(second.state, "ready");
    assert.match(second.reason ?? "", /Workspace has unresolved execution/);
    assert.equal(runtime.starts, 1);
    assert.equal(runtime.turnStarts, 1);
    await service.stop();
    runtime = new FakeRuntime();
    service = new StandaloneService(data, () => runtime);
    await service.start();
    assert.equal(
      (await service.submit("lost", "test", workspace)).state,
      "held",
    );
    assert.equal(runtime.starts, 0);
    const pending = await service.submit(
      "other",
      "test",
      `${workspace}/../work`,
    );
    assert.equal(pending.state, "ready");
    assert.match(pending.reason ?? "", /Workspace has unresolved execution/);
    assert.equal(runtime.starts, 0);
    assert.equal(runtime.turnStarts, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deterministic predecessor refusal leaves no writer reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const runtime = new FakeRuntime();
  const service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    await assert.rejects(
      service.submit("bad", "test", workspace, "missing"),
      /Previous work is not a completed binding/,
    );
    assert.equal(
      service.list().some((item) => item.workId === "bad"),
      false,
    );
    assert.equal(
      (await service.submit("good", "test", workspace)).state,
      "completed",
    );
    assert.equal(runtime.turnStarts, 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unbound approval callback during delayed thread start prevents turn submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const runtime = new FakeRuntime();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  runtime.threadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.onThreadEntered = entered;
  const service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const pending = service.submit("callback-race", "test", workspace);
    await started;
    runtime.onRequest?.({ method: "item/permissions/requestApproval" });
    release();
    const held = await pending;
    assert.equal(held.state, "held");
    assert.equal(held.threadId, null);
    assert.equal(runtime.turnStarts, 0);
    assert.match(held.reason ?? "", /Unexpected App Server request denied/);
    await service.stop();
    await service.start();
    assert.equal(
      (await service.submit("callback-race", "test", workspace)).state,
      "held",
    );
    assert.equal(runtime.turnStarts, 0);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("callback during turn submission preserves server turn identity and hold across reopen", async () => {
  for (const request of [
    {
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
    },
    { method: "execCommandApproval" },
    {
      method: "item/fileChange/requestApproval",
      threadId: "thread-1",
      turnId: "callback-turn",
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
    const data = join(root, "data");
    const workspace = join(root, "work");
    mkdirSync(workspace);
    let runtime = new FakeRuntime();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    runtime.turnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.onTurnEntered = entered;
    let service = new StandaloneService(data, () => runtime);
    try {
      await service.start();
      const pending = service.submit("turn-race", "test", workspace);
      await started;
      runtime.onRequest?.(request);
      release();
      const held = await pending;
      assert.equal(held.state, "held");
      assert.equal(held.threadId, "thread-1");
      const expectedTurnId = request.turnId ?? "turn-1";
      assert.equal(held.turnId, expectedTurnId);
      assert.match(held.reason ?? "", /Unexpected App Server request denied/);
      if (expectedTurnId !== "turn-1")
        assert.match(
          held.reason ?? "",
          /conflicting turn\/start response: turn-1/,
        );
      assert.equal(runtime.turnStarts, 1);
      assert.equal(
        (await service.submit("next", "test", workspace)).state,
        "ready",
      );
      assert.equal(runtime.turnStarts, 1);
      await service.stop();
      runtime = new FakeRuntime();
      service = new StandaloneService(data, () => runtime);
      await service.start();
      assert.equal(
        service.list().find((item) => item.workId === "turn-race")?.turnId,
        expectedTurnId,
      );
      assert.equal(
        (await service.submit("after-reopen", "test", workspace)).state,
        "ready",
      );
      assert.equal(runtime.turnStarts, 0);
    } finally {
      release();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("approval callback on a bound turn retains hold after terminal completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const runtime = new FakeRuntime();
  runtime.approveDuringWait = true;
  const service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const held = await service.submit("callback", "test", workspace);
    assert.equal(held.state, "held");
    assert.equal(held.threadId, "thread-1");
    assert.equal(held.turnId, "turn-1");
    assert.match(held.reason ?? "", /Unexpected App Server request denied/);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted callback identity holds only its bound turn; unknown identity holds all active turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const runtime = new FakeRuntime();
  const service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    const state = new ExecutionState(db);
    const first = state.create("first", "test", join(root, "work-a"));
    const second = state.create("second", "test", join(root, "work-b"));
    assert.equal(state.begin(first.id), true);
    assert.equal(state.bindThread(first.id, "thread-a"), true);
    assert.equal(state.bindTurn(first.id, "turn-a"), true);
    assert.equal(state.begin(second.id), true);
    assert.equal(state.bindThread(second.id, "thread-b"), true);
    assert.equal(state.bindTurn(second.id, "turn-b"), true);
    state.complete(first.id, "thread-a", "turn-a");
    runtime.onRequest?.({
      method: "item/commandExecution/requestApproval",
      threadId: "thread-a",
      turnId: "turn-a",
    });
    assert.equal(state.get(first.id).state, "held");
    assert.equal(state.get(second.id).state, "running");
    runtime.onRequest?.({
      method: "item/fileChange/requestApproval",
      threadId: "thread-a",
      turnId: "turn-a",
    });
    assert.equal(state.get(first.id).state, "held");
    assert.equal(state.get(second.id).state, "running");
    runtime.onRequest?.({
      method: "item/permissions/requestApproval",
      threadId: "unknown",
      turnId: "unknown",
    });
    assert.equal(state.get(second.id).state, "held");
    db.close();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed stop closes SQLite and allows restart on the same service object", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const runtime = new FakeRuntime();
  const service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    runtime.failStop = true;
    await assert.rejects(service.stop(), /injected stop failure/);
    await service.start();
    assert.deepEqual(service.list(), []);
    await service.stop();
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    assert.equal(
      (
        db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        }
      ).integrity_check,
      "ok",
    );
    db.close();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup login failure holds ready work; unmarked prototype directory is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  let service = new StandaloneService(data, () => new FakeRuntime());
  try {
    await service.start();
    await assert.rejects(
      service.submit("bad", "test", join(root, "missing")),
      /Workspace must be an existing real directory/,
    );
    assert.equal(
      service.turnRequests().some((item) => item.workId === "bad"),
      false,
    );
    await service.stop();
    const queuedDb = new DatabaseSync(join(data, "standalone.sqlite"));
    new ExecutionState(queuedDb).create("queued", "test", workspace);
    queuedDb.close();
    const unavailable = new FakeRuntime();
    unavailable.failAt = "start";
    service = new StandaloneService(data, () => unavailable);
    await assert.rejects(service.start(), /login unavailable/);
    const heldDb = new DatabaseSync(join(data, "standalone.sqlite"));
    assert.equal(new ExecutionState(heldDb).byWorkId("queued")?.state, "held");
    heldDb.close();
    const prototype = join(root, "prototype");
    mkdirSync(prototype);
    writeFileSync(join(prototype, "prototype.sqlite"), "private");
    await assert.rejects(
      new StandaloneService(prototype).start(),
      /Unmarked data directory/,
    );
    const linked = join(root, "linked");
    mkdirSync(linked);
    writeFileSync(
      join(linked, ".ensemble-standalone"),
      "ensemble-standalone-v1\n",
    );
    symlinkSync(
      join(prototype, "prototype.sqlite"),
      join(linked, "standalone.sqlite"),
    );
    await assert.rejects(
      new StandaloneService(linked).start(),
      /must not be a symlink/,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite binding failure leaves a durable held submission, while corrupt initialization never starts runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  let runtime = new FakeRuntime();
  let service = new StandaloneService(data, () => runtime);
  try {
    await service.start();
    const fault = new DatabaseSync(join(data, "standalone.sqlite"));
    fault.exec(
      "CREATE TRIGGER fail_binding BEFORE UPDATE ON execution_intents WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    const held = await service.submit("fault", "test", workspace);
    assert.equal(held.state, "held");
    assert.equal(held.threadId, "thread-1");
    assert.match(held.reason ?? "", /injected storage failure/);
    fault.close();
    await service.stop();
    runtime = new FakeRuntime();
    service = new StandaloneService(data, () => runtime);
    await service.start();
    assert.equal(
      (await service.submit("fault", "test", workspace)).state,
      "held",
    );
    assert.equal(runtime.starts, 0);
    await service.stop();
    const corrupt = join(root, "corrupt");
    mkdirSync(corrupt);
    writeFileSync(
      join(corrupt, ".ensemble-standalone"),
      "ensemble-standalone-v1\n",
    );
    writeFileSync(join(corrupt, "standalone.sqlite"), "not sqlite");
    runtime = new FakeRuntime();
    service = new StandaloneService(corrupt, () => runtime);
    await assert.rejects(service.start());
    assert.equal(runtime.starts, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 2 core schema migrates transactionally to standalone schema", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s02-"));
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try {
    const key = new Store(db).ensureHost("standalone-codex");
    db.exec("DROP TABLE execution_intents; PRAGMA user_version = 2");
    assert.equal(new Store(db).ensureHost("standalone-codex"), key);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      6,
    );
    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'execution_intents'",
        )
        .get(),
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 3 execution state migration preserves writer bindings and admits capacity waits", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE host_installation (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        hostKind TEXT NOT NULL,
        hostKey TEXT NOT NULL UNIQUE
      );
      INSERT INTO host_installation VALUES (1, 'standalone-codex', '10000000-0000-4000-8000-000000000001');
      CREATE TABLE execution_intents (
        id TEXT PRIMARY KEY,
        workId TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ready','held','submitting','running','completed')),
        reason TEXT,
        threadId TEXT,
        turnId TEXT,
        accountType TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK(sandbox = 'workspaceWrite'),
        approval TEXT NOT NULL CHECK(approval = 'never')
      );
      INSERT INTO execution_intents VALUES (
        '10000000-0000-4000-8000-000000000002', 'work-1', 'Prompt', '/workspace',
        'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never'
      );
      CREATE TABLE task_writer_admissions (
        workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
        workspace TEXT NOT NULL
      );
      INSERT INTO task_writer_admissions VALUES ('work-1', '/workspace');
      PRAGMA user_version = 3;`);

    const key = new Store(db).ensureHost("standalone-codex");
    assert.equal(key, "10000000-0000-4000-8000-000000000001");
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      6,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT workspace FROM task_writer_admissions WHERE workId = ?",
          )
          .get("work-1") as { workspace: string }
      ).workspace,
      "/workspace",
    );
    db.prepare(
      "UPDATE execution_intents SET state = 'capacity-waiting' WHERE workId = ?",
    ).run("work-1");
    db.prepare(
      "UPDATE execution_intents SET state = 'reconciled' WHERE workId = ?",
    ).run("work-1");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
});

test("version 4 execution state migration accepts reconciled as terminal", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE host_installation (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        hostKind TEXT NOT NULL,
        hostKey TEXT NOT NULL UNIQUE
      );
      INSERT INTO host_installation VALUES (1, 'standalone-codex', '10000000-0000-4000-8000-000000000001');
      CREATE TABLE execution_intents (
        id TEXT PRIMARY KEY,
        workId TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ready','capacity-waiting','held','submitting','running','completed')),
        reason TEXT,
        threadId TEXT,
        turnId TEXT,
        accountType TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK(sandbox = 'workspaceWrite'),
        approval TEXT NOT NULL CHECK(approval = 'never')
      );
      INSERT INTO execution_intents VALUES (
        '10000000-0000-4000-8000-000000000002', 'work-1', 'Prompt', '/workspace',
        'held', NULL, 'thread-1', 'turn-1', 'chatgpt', 'workspaceWrite', 'never'
      );
      PRAGMA user_version = 4;`);

    new Store(db).ensureHost("standalone-codex");
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      6,
    );
    db.prepare(
      "UPDATE execution_intents SET state = 'reconciled' WHERE workId = ?",
    ).run("work-1");
    assert.equal(
      (
        db
          .prepare("SELECT state FROM execution_intents WHERE workId = ?")
          .get("work-1") as { state: string }
      ).state,
      "reconciled",
    );
  } finally {
    db.close();
  }
});
