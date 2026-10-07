import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StandaloneService } from "../../dist/src/standalone/service.js";
import { OperatorFixtureRuntime } from "../../dist/test/fixtures/operator-web.js";
import { renderLaunchAgent } from "../../dist/src/standalone/launchd.js";
import {
  captureProcessIdentity,
  MacProcessTerminationVerifier,
} from "../../dist/src/standalone/termination.js";

if (process.argv[2] !== "--qualify" || process.platform !== "darwin")
  throw Error("Requires explicit --qualify on macOS; no skipped qualification");
const started = performance.now(),
  deadline = started + 50000;
const record = {
  runtime: process.version,
  platform: process.platform,
  source: {},
  counts: {
    children: 0,
    descendants: 0,
    modelCalls: 0,
    providerCalls: 0,
    admissionsAfterRestart: 0,
  },
  steps: [],
  cleanup: {
    childExited: false,
    verifiedAbsent: false,
    serviceStopped: false,
    rootRemoved: false,
  },
  limitations: [
    "Synthetic runtime bound to one owned harmless process; not Codex descendant containment",
    "No reboot, launchd load, prototype access, provider effects or cutover",
  ],
  failure: null,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const p of [
  "src/standalone/termination.ts",
  "src/standalone/service.ts",
  "test/s08b/owned-recovery.mjs",
])
  record.source[p] = hash(readFileSync(resolve(p)));
let root, child, exit, identity, service, runtime;
const pendingOperations = new Set();
async function step(name, action, cleanup = false) {
  const remaining = cleanup
    ? 10000
    : Math.min(5000, deadline - performance.now());
  if (remaining <= 0) throw Error("Overall qualification deadline exceeded");
  let timer;
  const controller = new AbortController();
  const operation = Promise.resolve().then(() => action(controller.signal));
  if (!cleanup) pendingOperations.add(operation);
  operation.then(
    () => pendingOperations.delete(operation),
    () => pendingOperations.delete(operation),
  );
  const begin = performance.now();
  try {
    const result = await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error(`Deadline: ${name}`));
        }, remaining);
      }),
    ]);
    record.steps.push({
      name,
      status: "passed",
      elapsedMs: Math.round(performance.now() - begin),
    });
    return result;
  } catch (error) {
    record.steps.push({
      name,
      status: "failed",
      elapsedMs: Math.round(performance.now() - begin),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, signal) {
  while (!predicate()) {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 5);
      const abort = () => {
        clearTimeout(timer);
        reject(Error("Fixture wait cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
class OwnedRuntime extends OperatorFixtureRuntime {
  endings = new Map();
  waitForTurn(_thread, turn) {
    return new Promise((resolve) => this.endings.set(turn, resolve));
  }
  processIdentity() {
    return identity;
  }
  async inspectExecution() {
    return {
      kind: "unknown",
      reason: "Synthetic inspector cannot prove reattachment",
    };
  }
  async stop() {
    for (const resolve of this.endings.values()) resolve("failed");
  }
}
const verifier = new MacProcessTerminationVerifier();
try {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s08b-owned-")));
  chmodSync(root, 0o700);
  const data = join(root, "data"),
    auth = join(root, "auth"),
    logs = join(root, "logs");
  for (const p of [data, auth, logs]) mkdirSync(p, { mode: 0o700 });
  const authFile = join(auth, "synthetic.json");
  writeFileSync(authFile, "{}", { mode: 0o600 });
  const plist = join(root, "com.example.ensemble.s08b.plist");
  writeFileSync(
    plist,
    renderLaunchAgent({
      label: "com.example.ensemble.s08b",
      nodePath: realpathSync(process.execPath),
      cliPath: resolve("dist/src/standalone/cli.js"),
      dataDirectory: data,
      authFile,
      origin: "http://127.0.0.1:28787",
      port: 28787,
      stdoutPath: join(logs, "out"),
      stderrPath: join(logs, "err"),
    }),
    { mode: 0o600 },
  );
  const env = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-extract", "EnvironmentVariables", "json", "-o", "-", plist],
      { encoding: "utf8", timeout: 5000 },
    ),
  );
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  const sentinel = join(root, "writer-sentinel"),
    effects = join(root, "synthetic-effects.json");
  // This exact child program performs one known file write and no spawn or network operation.
  const code = `import {writeFileSync} from 'node:fs'; import {captureProcessIdentity} from ${JSON.stringify(pathToFileURL(resolve("dist/src/standalone/termination.js")).href)};writeFileSync(${JSON.stringify(sentinel)},'one owned synthetic write\\n');writeFileSync(${JSON.stringify(effects)},JSON.stringify({writes:1,externalEffects:0}));console.log(JSON.stringify(await captureProcessIdentity(process.pid)));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  child = spawn(
    realpathSync(process.execPath),
    ["--input-type=module", "-e", code],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  record.counts.children++;
  exit = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  await step("generated-environment child identity", (signal) =>
    until(() => output.includes("\n"), signal),
  );
  identity = JSON.parse(output.trim());
  if (process.argv.includes("--fault-wait"))
    await step("injected cancellable wait", (signal) =>
      until(() => false, signal),
    );
  assert.ok(identity);
  assert.deepEqual(
    await step("independent identity capture", () =>
      captureProcessIdentity(child.pid),
    ),
    identity,
  );
  record.identitySha256 = hash(JSON.stringify(identity));
  assert.equal(
    (
      await step("alive process verification conflicts", () =>
        verifier.verify(identity),
      )
    ).kind,
    "conflict",
  );
  const topology = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(topology.filter(([, ppid]) => ppid === child.pid).length, 0);
  const fileBytes = readFileSync(sentinel);
  assert.deepEqual(JSON.parse(readFileSync(effects, "utf8")), {
    writes: 1,
    externalEffects: 0,
  });
  record.sentinelSha256 = hash(fileBytes);
  runtime = new OwnedRuntime();
  service = new StandaloneService(data, () => runtime, undefined, {
    power: { enabled: false },
    supervisor: { observationMs: 20 },
  });
  await step("fresh service", () => service.start());
  const projectId = randomUUID(),
    taskId = randomUUID(),
    profileId = randomUUID();
  const command = (c) =>
    service.domain().execute({ ...c, key: randomUUID(), actor: "operator" });
  command({
    type: "profile.create",
    profileId,
    name: "Synthetic owner",
    instructions: "No external execution",
    capabilities: "fixture",
  });
  command({
    type: "project.create",
    projectId,
    name: "Owned recovery fixture",
    leadProfileId: profileId,
  });
  command({
    type: "task.create",
    projectId,
    taskId,
    title: "Owned child",
    outcome: "Verify exact recovery",
    ready: true,
  });
  await step("managed fixture workspace", () => service.provisionTask(taskId));
  command({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await step("one admitted bound synthetic generation", (signal) =>
    until(() => service.list().some((i) => i.state === "running"), signal),
  );
  assert.equal(runtime.turns, 1);
  await step("Stop retains uncertainty", () => service.stopTask(taskId));
  await step("stop owned service", () => service.stop());
  runtime = new OwnedRuntime();
  service = new StandaloneService(data, () => runtime, undefined, {
    power: { enabled: false },
    supervisor: { observationMs: 20 },
  });
  await step("one real-storage restart", () => service.start());
  let view = service.recoveryView().find((v) => v.binding?.taskId === taskId);
  assert.ok(view?.processIdentity);
  assert.ok(view.intent.threadId && view.intent.turnId);
  assert.equal(view.holds.writer, true);
  assert.equal(view.holds.capacity, true);
  assert.equal(view.holds.stop, true);
  assert.equal(runtime.turns, 0);
  const receipt = {
    workId: view.workId,
    workRevision: view.generation.workRevision,
    requestSequence: view.generation.requestSequence,
    threadId: view.intent.threadId,
    turnId: view.intent.turnId,
    processIdentity: view.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
  };
  await step("wrong generation denied", () =>
    assert.rejects(() =>
      service.resolveHeldExecution({
        ...receipt,
        requestSequence: receipt.requestSequence + 1,
      }),
    ),
  );
  await step("wrong process denied", () =>
    assert.rejects(() =>
      service.resolveHeldExecution({
        ...receipt,
        processIdentity: {
          ...identity,
          processId: String(Number(identity.processId) + 1),
        },
      }),
    ),
  );
  await step("missing original identity denied", () =>
    assert.rejects(() =>
      service.resolveHeldExecution({ ...receipt, processIdentity: null }),
    ),
  );
  await step("acknowledgement without termination denied", () =>
    assert.rejects(() =>
      service.resolveHeldExecution({
        ...receipt,
        termination: { kind: "acknowledged" },
      }),
    ),
  );
  await step("alive survivor cannot release", () =>
    assert.rejects(() => service.resolveHeldExecution(receipt)),
  );
  assert.equal(
    service.recoveryView().find((v) => v.workId === view.workId).holds.writer,
    true,
  );
  await step("graceful exact-child exit", async () => {
    child.kill("SIGTERM");
    const result = await exit;
    assert.equal(result.code, 0);
    record.cleanup.childExited = true;
  });
  const verification = await step("independent same-boot absence", () =>
    verifier.verify(identity),
  );
  assert.equal(verification.kind, "verified");
  assert.equal(verification.method, "mac-pid-absent-same-boot");
  record.cleanup.verifiedAbsent = true;
  assert.equal(readFileSync(sentinel).equals(fileBytes), true);
  assert.deepEqual(JSON.parse(readFileSync(effects, "utf8")), {
    writes: 1,
    externalEffects: 0,
  });
  await step("exact receipt release", () =>
    service.resolveHeldExecution(receipt),
  );
  view = service.recoveryView().find((v) => v.workId === view.workId);
  assert.equal(view.intent.state, "reconciled");
  assert.equal(view.holds.writer, false);
  assert.equal(view.holds.capacity, false);
  assert.equal(view.holds.stop, true);
  await step("repeated receipt is refused without duplicate release", () =>
    assert.rejects(() => service.resolveHeldExecution(receipt)),
  );
  assert.equal(runtime.turns, 0);
  await step("explicit Resume clears only Stop", () =>
    service.resumeTask(taskId),
  );
  assert.equal(service.taskHold(taskId), undefined);
  assert.equal(runtime.turns, 0);
  assert.equal(
    service.turnRequests().find((r) => r.workId === view.workId).state,
    "held",
  );
  record.counts.admissionsAfterRestart = runtime.turns;
  record.recoveryQualified = true;
} catch (error) {
  record.failure = {
    name: error.name,
    stage: record.steps.at(-1)?.name ?? "setup",
  };
  process.exitCode = 1;
} finally {
  try {
    await step(
      "cleanup",
      async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await Promise.race([exit, new Promise((r) => setTimeout(r, 1000))]);
          if (child.exitCode === null && child.signalCode === null) {
            assert.ok(identity && String(child.pid) === identity.processId);
            assert.equal(
              (await captureProcessIdentity(child.pid))?.processStartedAt,
              identity.processStartedAt,
            );
            child.kill("SIGKILL");
            await exit;
          }
        }
        if (child) {
          record.cleanup.childExited =
            child.exitCode !== null || child.signalCode !== null;
          if (identity)
            record.cleanup.verifiedAbsent =
              (await verifier.verify(identity)).kind === "verified";
        }
        // No timed-out startup may finish after ownership/root removal.
        const unsettled = [...pendingOperations];
        if (unsettled.length) {
          let timer;
          try {
            await Promise.race([
              Promise.allSettled(unsettled),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(Error("Unsettled fixture operation; root retained")),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        await service?.stop();
        record.cleanup.serviceStopped = true;
        if (
          record.cleanup.childExited &&
          record.cleanup.verifiedAbsent &&
          root
        ) {
          rmSync(root, { recursive: true, force: true });
          record.cleanup.rootRemoved = !existsSync(root);
        }
        assert.equal(record.cleanup.rootRemoved, true);
      },
      true,
    );
  } catch (error) {
    record.cleanup.failure = error.name;
    process.exitCode = 1;
  }
  record.durationMs = Math.round(performance.now() - started);
  if (process.argv[3])
    writeFileSync(
      process.argv[3],
      JSON.stringify(
        { ...record, privateProcessIdentity: identity, privateRoot: root },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  process.stdout.write(JSON.stringify(record) + "\n");
  // This finite runner owns itself; unresolved in-process operations cannot run after handoff.
  if (process.exitCode) process.exit(process.exitCode);
}
