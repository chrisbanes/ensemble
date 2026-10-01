import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import { CodexRuntime } from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";

type FixtureMode =
  | "all-forms"
  | "delayed-exact"
  | "delayed-unknown"
  | "pipe-failure";

function executableFixture(root: string, mode: FixtureMode) {
  const executable = join(root, "fake-codex.mjs");
  const proofPath = join(root, "fixture-proof.json");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { closeSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";

const mode = ${JSON.stringify(mode)};
const proofPath = ${JSON.stringify(proofPath)};
let previousTurns = 0;
try {
  previousTurns = JSON.parse(readFileSync(proofPath, "utf8")).turnStarts ?? 0;
} catch {}
const proof = { turnStarts: previousTurns, responses: [], threadPolicy: null, policy: null, terminalSent: false };
const save = () => writeFileSync(proofPath, JSON.stringify(proof));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const responseMethods = new Map();
let threadId = "s05-thread";
let turnId = "s05-turn";
let turnStartRequestId;
let delayedNotificationId;
let requestIndex = 0;
const requests = [
  ["item/commandExecution/requestApproval", { threadId, turnId }],
  ["item/fileChange/requestApproval", { threadId, turnId }],
  ["applyPatchApproval", { threadId, turnId }],
  ["execCommandApproval", { threadId, turnId }],
  ["item/permissions/requestApproval", { threadId, turnId }],
  ["unregisteredServerRequest", { threadId, turnId }],
  ["item/permissions/requestApproval", { threadId }],
  ["item/tool/call", { threadId, turnId, callId: "fixture-call", tool: "unregistered", arguments: {} }],
];

function savePolicy(params) {
  const sandbox = params.sandboxPolicy ?? {};
  proof.policy = {
    approvalNever: params.approvalPolicy === "never",
    workspaceWrite: sandbox.type === "workspaceWrite",
    networkDisabled: sandbox.networkAccess === false,
    oneWritableRootMatchesCwd:
      Array.isArray(sandbox.writableRoots) &&
      sandbox.writableRoots.length === 1 &&
      sandbox.writableRoots[0] === params.cwd,
    temporaryRootsExcluded: sandbox.excludeSlashTmp === true && sandbox.excludeTmpdirEnvVar === true,
  };
  save();
}

function receipt(method, message) {
  const result = message.result ?? {};
  return {
    method,
    decision: typeof result.decision === "string" ? result.decision : null,
    errorCode: Number.isInteger(message.error?.code) ? message.error.code : null,
    toolFailed: result.success === false,
    toolRefusal: result.contentItems?.[0]?.text === "not authorized",
  };
}

function emitNextRequest() {
  if (requestIndex >= requests.length) {
    proof.terminalSent = true;
    save();
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  const [method, params] = requests[requestIndex++];
  const id = 70 + requestIndex;
  responseMethods.set(String(id), method);
  send({ id, method, params });
}

function finishDelayedTurn() {
  if (turnStartRequestId === undefined) return;
  send({ id: turnStartRequestId, result: { turn: { id: turnId } } });
  setTimeout(() => {
    proof.terminalSent = true;
    save();
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }, 10);
}

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "account/read") {
    send({ id: message.id, result: { account: { type: "chatgpt" } } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { approval_policy: "never", sandbox_mode: "workspace-write" } } });
  } else if (message.method === "thread/start") {
    threadId = "s05-thread";
    proof.threadPolicy = {
      approvalNever: message.params.approvalPolicy === "never",
      workspaceWrite: message.params.sandbox === "workspace-write",
    };
    save();
    send({ id: message.id, result: { thread: { id: threadId }, approvalPolicy: "never", sandbox: { type: "workspaceWrite" } } });
  } else if (message.method === "turn/start") {
    proof.turnStarts += 1;
    savePolicy(message.params);
    turnStartRequestId = message.id;
    turnId = "s05-turn";
    if (mode === "delayed-exact") {
      delayedNotificationId = 90;
      responseMethods.set(String(delayedNotificationId), "item/commandExecution/requestApproval");
      send({ id: delayedNotificationId, method: "item/commandExecution/requestApproval", params: { threadId, turnId } });
    } else if (mode === "delayed-unknown") {
      delayedNotificationId = 91;
      responseMethods.set(String(delayedNotificationId), "item/permissions/requestApproval");
      send({ id: delayedNotificationId, method: "item/permissions/requestApproval", params: { threadId } });
    } else if (mode === "pipe-failure") {
      send({ id: message.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        send({ id: 92, method: "item/commandExecution/requestApproval", params: { threadId, turnId } });
        closeSync(0);
        setTimeout(() => process.exit(0), 1500);
      }, 25);
    } else {
      send({ id: message.id, result: { turn: { id: turnId } } });
      setTimeout(emitNextRequest, 25);
    }
  } else if (message.id !== undefined && responseMethods.has(String(message.id))) {
    const method = responseMethods.get(String(message.id));
    responseMethods.delete(String(message.id));
    proof.responses.push(receipt(method, message));
    save();
    if (mode === "all-forms") setTimeout(emitNextRequest, 5);
    else if (mode === "delayed-exact" || mode === "delayed-unknown")
      setTimeout(finishDelayedTurn, 10);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
}
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return { executable, proofPath };
}

function fixtureProof(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as {
    turnStarts: number;
    responses: Array<{
      method: string;
      decision: string | null;
      errorCode: number | null;
      toolFailed: boolean;
      toolRefusal: boolean;
    }>;
    threadPolicy: {
      approvalNever: boolean;
      workspaceWrite: boolean;
    } | null;
    policy: {
      approvalNever: boolean;
      workspaceWrite: boolean;
      networkDisabled: boolean;
      oneWritableRootMatchesCwd: boolean;
      temporaryRootsExcluded: boolean;
    } | null;
    terminalSent: boolean;
  };
}

function childOf(
  runtime: CodexRuntime,
): ChildProcessWithoutNullStreams | undefined {
  return (runtime as unknown as { child?: ChildProcessWithoutNullStreams })
    .child;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("bounded observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runtimeFailure(
  runtime: CodexRuntime,
): NodeJS.ErrnoException | undefined {
  // This one test-only read proves the response-pipe failure itself, rather
  // than inferring it from stdin.destroy() or eventual fixture exit.
  return (runtime as unknown as { failure?: NodeJS.ErrnoException }).failure;
}

function assertExited(child: ChildProcessWithoutNullStreams | undefined) {
  assert.ok(child, "fixture process was started");
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "exact App Server process exited",
  );
}

const powerOff = { power: { enabled: false } } as const;

test("production service rejects installed approval and unknown request forms without widening policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-approval-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const { executable, proofPath } = executableFixture(root, "all-forms");
  let runtime = new CodexRuntime(executable);
  let service = new StandaloneService(data, () => runtime, undefined, powerOff);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await service.start();
    child = childOf(runtime);
    const held = await service.submit(
      "s05-approval",
      "fixture brief",
      workspace,
    );
    assert.equal(held.state, "held");
    assert.equal(held.threadId, "s05-thread");
    assert.equal(held.turnId, "s05-turn");
    assert.match(held.reason ?? "", /Unexpected App Server request denied/);

    const proof = fixtureProof(proofPath);
    assert.equal(proof.turnStarts, 1);
    assert.equal(proof.terminalSent, true);
    assert.deepEqual(
      proof.responses.map((item) => item.method),
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "applyPatchApproval",
        "execCommandApproval",
        "item/permissions/requestApproval",
        "unregisteredServerRequest",
        "item/permissions/requestApproval",
        "item/tool/call",
      ],
    );
    assert.deepEqual(
      proof.responses.map((item) => item.decision),
      ["cancel", "cancel", "abort", "abort", null, null, null, null],
    );
    assert.deepEqual(
      proof.responses.map((item) => item.errorCode),
      [null, null, null, null, -32601, -32601, -32601, null],
    );
    assert.equal(proof.responses[7]?.toolFailed, true);
    assert.equal(proof.responses[7]?.toolRefusal, true);
    assert.ok(
      proof.responses.every(
        (item) =>
          !JSON.stringify(item).includes("approved") &&
          !JSON.stringify(item).includes("accept") &&
          !JSON.stringify(item).includes("grant"),
      ),
    );
    assert.deepEqual(proof.policy, {
      approvalNever: true,
      workspaceWrite: true,
      networkDisabled: true,
      oneWritableRootMatchesCwd: true,
      temporaryRootsExcluded: true,
    });
    assert.deepEqual(proof.threadPolicy, {
      approvalNever: true,
      workspaceWrite: true,
    });

    const successor = await service.submit(
      "s05-successor",
      "must remain queued",
      workspace,
    );
    assert.equal(successor.state, "ready");
    assert.equal(
      service.turnRequests().find((item) => item.workId === "s05-successor")
        ?.state,
      "queued",
    );
    await service.stop();
    assertExited(child);

    runtime = new CodexRuntime(executable);
    service = new StandaloneService(data, () => runtime, undefined, powerOff);
    await service.start();
    assert.equal(
      service.list().find((item) => item.workId === "s05-approval")?.state,
      "held",
    );
    const duplicate = await service.submit(
      "s05-approval",
      "fixture brief",
      workspace,
    );
    assert.equal(duplicate.state, "held");
    assert.equal(fixtureProof(proofPath).turnStarts, 1);
  } finally {
    const restartedChild = childOf(runtime);
    await service.stop().catch(() => {});
    assertExited(restartedChild);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production callback binds an exact approval during a delayed turn response", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-delayed-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const { executable, proofPath } = executableFixture(root, "delayed-exact");
  const runtime = new CodexRuntime(executable);
  const service = new StandaloneService(
    data,
    () => runtime,
    undefined,
    powerOff,
  );
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await service.start();
    child = childOf(runtime);
    const held = await service.submit(
      "s05-delayed",
      "fixture brief",
      workspace,
    );
    assert.equal(held.state, "held");
    assert.equal(held.threadId, "s05-thread");
    assert.equal(held.turnId, "s05-turn");
    assert.match(held.reason ?? "", /Unexpected App Server request denied/);
    const proof = fixtureProof(proofPath);
    assert.deepEqual(proof.responses, [
      {
        method: "item/commandExecution/requestApproval",
        decision: "cancel",
        errorCode: null,
        toolFailed: false,
        toolRefusal: false,
      },
    ]);
    assert.equal(proof.turnStarts, 1);
  } finally {
    await service.stop().catch(() => {});
    assertExited(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed identity holds the active production execution and denial-pipe failure survives reopen", async () => {
  for (const mode of ["delayed-unknown", "pipe-failure"] as const) {
    const root = mkdtempSync(join(tmpdir(), "ensemble-s05-denial-failure-"));
    const data = join(root, "data");
    const workspace = join(root, "work");
    mkdirSync(workspace);
    const { executable, proofPath } = executableFixture(root, mode);
    let runtime = new CodexRuntime(executable);
    let service = new StandaloneService(
      data,
      () => runtime,
      undefined,
      powerOff,
    );
    let firstChild: ChildProcessWithoutNullStreams | undefined;
    try {
      await service.start();
      firstChild = childOf(runtime);
      const held = await service.submit(
        "s05-fail-closed",
        "fixture brief",
        workspace,
      );
      assert.equal(held.state, "held");
      assert.equal(held.threadId, "s05-thread");
      assert.equal(held.turnId, "s05-turn");
      assert.match(held.reason ?? "", /Unexpected App Server request denied/);
      if (mode === "delayed-unknown") {
        assert.deepEqual(fixtureProof(proofPath).responses, [
          {
            method: "item/permissions/requestApproval",
            decision: null,
            errorCode: -32601,
            toolFailed: false,
            toolRefusal: false,
          },
        ]);
      } else {
        await waitUntil(() => runtimeFailure(runtime) !== undefined, 2_000);
        assert.equal(runtimeFailure(runtime)?.code, "EPIPE");
      }
      await service.stop();
      assertExited(firstChild);

      runtime = new CodexRuntime(executable);
      service = new StandaloneService(data, () => runtime, undefined, powerOff);
      await service.start();
      assert.equal(
        service.list().find((item) => item.workId === "s05-fail-closed")?.state,
        "held",
      );
      const duplicate = await service.submit(
        "s05-fail-closed",
        "fixture brief",
        workspace,
      );
      assert.equal(duplicate.state, "held");
      const successor = await service.submit(
        "s05-after-reopen",
        "must remain queued",
        workspace,
      );
      assert.equal(successor.state, "ready");
      assert.equal(
        service
          .turnRequests()
          .find((item) => item.workId === "s05-after-reopen")?.state,
        "queued",
      );
      assert.equal(fixtureProof(proofPath).turnStarts, 1);
    } finally {
      const restartedChild = childOf(runtime);
      await service.stop().catch(() => {});
      assertExited(firstChild);
      if (restartedChild !== firstChild) assertExited(restartedChild);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
