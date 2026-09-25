import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { terminateOwnedProcessGroup } from "./owned-process-group.mjs";

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function waitWithin(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

test("timeout cleanup kills descendants after the process-group leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const grandchildSource = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("READY:" + process.pid);',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const leaderSource = [
    'import { spawn } from "node:child_process";',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1_000);",
  ].join("\n");

  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", leaderSource],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  assert(child.pid, "owned process group has a leader PID");

  let stdout = "";
  const descendantPid = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/READY:(\d+)/u);
      if (match) resolve(Number(match[1]));
    });
    child.once("error", reject);
  });
  const leaderExit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });

  let cleaned = false;
  let testFailure;
  let cleanupFailure;
  try {
    const pid = await waitWithin(descendantPid, 2_000, "grandchild readiness");
    assert(Number.isSafeInteger(pid) && pid > 0, "grandchild PID is reported");
    assert(pidExists(pid), "grandchild started before timeout cleanup");

    const cleanup = terminateOwnedProcessGroup({
      child,
      processGroupId: child.pid,
      closePromise: closed,
      graceMs: 250,
      closeTimeoutMs: 2_000,
    });

    const exit = await waitWithin(leaderExit, 1_000, "leader SIGTERM exit");
    assert.equal(exit.code, 0, "leader exited during the SIGTERM grace period");
    assert(pidExists(pid), "grandchild survives after its leader exits");

    await cleanup;
    await closed;
    // The grandchild inherited stdout, so this close event proves it released
    // the pipe after group termination. Avoid kill(pid, 0) here: a dead child
    // may remain a zombie until the platform reaps it.
    cleaned = true;
  } catch (error) {
    testFailure = error;
  } finally {
    if (!cleaned) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupFailure = error;
      }
    }
  }
  if (testFailure) throw testFailure;
  if (cleanupFailure) throw cleanupFailure;
});

test("timeout cleanup bounds its post-SIGKILL close wait", {
  skip: process.platform === "win32",
}, async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("READY"); setInterval(() => {}, 1_000);',
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  assert(child.pid, "owned process group has a leader PID");

  const ready = new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });

  let cleaned = false;
  let testFailure;
  let cleanupFailure;
  try {
    await waitWithin(ready, 1_000, "stubborn leader readiness");
    const startedAt = Date.now();
    await assert.rejects(
      terminateOwnedProcessGroup({
        child,
        processGroupId: child.pid,
        closePromise: new Promise(() => {}),
        graceMs: 20,
        closeTimeoutMs: 50,
      }),
      /did not close within 50ms after SIGKILL/u,
    );
    assert(Date.now() - startedAt < 500, "post-kill wait remained bounded");
    const close = await waitWithin(closed, 1_000, "forced leader close");
    assert.equal(close.signal, "SIGKILL");
    cleaned = true;
  } catch (error) {
    testFailure = error;
  } finally {
    if (!cleaned) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupFailure = error;
      }
    }
  }
  if (testFailure) throw testFailure;
  if (cleanupFailure) throw cleanupFailure;
});
