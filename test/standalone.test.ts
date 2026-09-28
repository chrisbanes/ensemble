import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
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
  deniedServerRequest,
  executionPolicy,
} from "../src/standalone/codex.js";

class FakeRuntime implements Runtime {
  onRequest: ((method: string) => void) | undefined;
  failAt: "start" | "thread" | "turn" | "wait" | undefined;
  starts = 0;
  approveDuringWait = false;
  async start() {
    if (this.failAt === "start") throw new Error("login unavailable");
  }
  async stop() {}
  async startThread() {
    this.starts++;
    if (this.failAt === "thread") throw new Error("lost thread response");
    return "thread-1";
  }
  async resumeThread(id: string) {
    assert.equal(id, "thread-1");
  }
  async startTurn() {
    if (this.failAt === "turn") throw new Error("lost turn response");
    return "turn-1";
  }
  async waitForTurn() {
    if (this.approveDuringWait)
      this.onRequest?.("item/permissions/requestApproval");
    if (this.failAt === "wait") throw new Error("lost terminal status");
    return "completed" as const;
  }
  onUnexpectedRequest(listener: (method: string) => void) {
    this.onRequest = listener;
  }
}

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
      3,
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

test("lost submission and approval callback hold across reopen", async () => {
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
    await service.stop();
    runtime = new FakeRuntime();
    service = new StandaloneService(data, () => runtime);
    await service.start();
    assert.equal(
      (await service.submit("lost", "test", workspace)).state,
      "held",
    );
    assert.equal(runtime.starts, 0);
    runtime.approveDuringWait = true;
    const pending = await service.submit("other", "test", workspace);
    assert.equal(pending.state, "held");
    assert.match(pending.reason ?? "", /Unexpected App Server request denied/);
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
    const refused = await service.submit("bad", "test", join(root, "missing"));
    assert.equal(refused.state, "held");
    assert.match(refused.reason ?? "", /Pre-submission refusal/);
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
      3,
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
