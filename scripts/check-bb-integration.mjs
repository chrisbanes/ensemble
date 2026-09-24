// Run the public plugin SDK against a disposable, pinned BB installation.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const [bbPackage, bbSource] = args;
const keep = args.includes("--keep");
assert(
  bbPackage && bbSource,
  "Usage: node scripts/check-bb-integration.mjs <bb-app package> <pinned provider-source checkout> [--keep]",
);

const EXPECTED_BB_VERSION = "0.43.4";
const EXPECTED_SCRIPTED_PROVIDER_REVISION =
  "fdd3de3b19b97e6cd1ef7300cbb54711431249d3";
const EXPECTED_PLUGIN_SDK_PACKAGE_VERSION = "0.5.24";
const EXPECTED_HOST_PLUGIN_SDK_VERSION = "0.5.9";
const EXPECTED_NODE_VERSION = "24.21.0";
const PLUGIN_ID = "ensemble-t01-integration";
const GUARD_ID = "ensemble-t01-startup-guard";
const RUNTIME_ID = "ensemble-t01-scripted-runtime";
const PROVIDER_ID = "ensemble-scripted";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

assert.equal(
  process.versions.node,
  EXPECTED_NODE_VERSION,
  "Run this harness with Node 24.21.0",
);
const installedBbVersion = JSON.parse(
  await readFile(path.join(bbPackage, "package.json"), "utf8"),
).version;
assert.equal(installedBbVersion, EXPECTED_BB_VERSION);
const installedSdkVersion = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "node_modules/@get-bb/plugin-sdk/package.json"),
    "utf8",
  ),
).version;
assert.equal(installedSdkVersion, EXPECTED_PLUGIN_SDK_PACKAGE_VERSION);
const scriptedProviderRevision = (
  await exec("git", ["-C", bbSource, "rev-parse", "HEAD"])
).stdout.trim();
assert.equal(scriptedProviderRevision, EXPECTED_SCRIPTED_PROVIDER_REVISION);

const root = await mkdtemp(path.join(tmpdir(), "ensemble-bb-t01-"));
const data = path.join(root, "data");
const providerRecord = path.join(root, "provider-record.jsonl");
const ensembleFailure = path.join(root, "fail-ensemble-startup");
const waiterEnabled = path.join(root, "enable-startup-waiter");
const launcher = path.join(bbPackage, "dist/bb-app.js");
const cli = path.join(bbPackage, "dist/bb.js");
const env = {
  ...process.env,
  BB_DATA_DIR: data,
  BB_SERVER_BIND_HOST: "127.0.0.1",
  BB_TELEMETRY: "false",
  SCRIPTED_ECHO_RECORD_PATH: providerRecord,
  T01_FAIL_ENSEMBLE_STARTUP: ensembleFailure,
};

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const serverPort = await freePort();
let daemonPort = await freePort();
while (daemonPort === serverPort) daemonPort = await freePort();
env.BB_SERVER_URL = `http://127.0.0.1:${serverPort}`;
env.BB_SERVER_PORT = String(serverPort);
env.BB_HOST_DAEMON_PORT = String(daemonPort);

let processHandle;
let launcherOutput = "";
const evidence = {
  runtime: {
    node: process.versions.node,
    bb: installedBbVersion,
    hostPluginSdk: EXPECTED_HOST_PLUGIN_SDK_VERSION,
    scriptedProviderRevision,
    pluginSdkPackage: installedSdkVersion,
    platform: `${process.platform}-${process.arch}`,
  },
  checks: {},
};

function check(name, status, detail) {
  evidence.checks[name] = { status, detail };
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, label, timeoutMs) {
  if (hasExited(child)) return Promise.resolve();
  return Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`BB launcher did not stop ${label}`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

async function bb(...commandArgs) {
  const result = await exec(process.execPath, [cli, ...commandArgs, "--json"], {
    env,
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function rpc(method, input = {}) {
  const inputPath = path.join(root, `${method}-${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  const response = await bb(
    "plugin",
    "rpc",
    "call",
    PLUGIN_ID,
    method,
    "--input-file",
    inputPath,
  );
  return response.result ?? response;
}

async function until(fn, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function start() {
  processHandle = spawn(process.execPath, [launcher, "start"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle.stdout.on("data", (chunk) => {
    launcherOutput += chunk;
  });
  processHandle.stderr.on("data", (chunk) => {
    launcherOutput += chunk;
  });
  await until(async () => {
    assert.equal(
      hasExited(processHandle),
      false,
      `BB launcher exited: ${launcherOutput.slice(-2000)}`,
    );
    try {
      return (await bb("machine", "list")).find(
        (machine) => machine.status === "connected",
      );
    } catch {
      return false;
    }
  }, "isolated BB host connection");
}

async function stop() {
  if (!processHandle || hasExited(processHandle)) return;
  try {
    await exec(process.execPath, [launcher, "stop"], {
      env,
      timeout: 30000,
    });
    await waitForExit(processHandle, "after bb stop", 10000);
  } catch (error) {
    processHandle.kill("SIGTERM");
    await waitForExit(processHandle, "after SIGTERM", 5000).catch(() => {});
    if (!hasExited(processHandle)) {
      processHandle.kill("SIGKILL");
      await waitForExit(processHandle, "after SIGKILL", 5000);
    }
    throw new Error("BB launcher required forced cleanup", { cause: error });
  }
}

async function writeManifest(directory, name, extra = {}) {
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${name}`,
      version: "0.0.1",
      type: "module",
      dependencies: {
        "@get-bb/plugin-sdk": EXPECTED_PLUGIN_SDK_PACKAGE_VERSION,
        zod: "4.3.6",
      },
      engines: {
        bb: `>=${EXPECTED_BB_VERSION}`,
        bbPluginSdk: `>=${EXPECTED_HOST_PLUGIN_SDK_VERSION}`,
      },
      bb: {
        name,
        description: "Disposable T01 integration fixture",
        branding: { icon: "FlaskConical" },
        server: "./server.ts",
        ...extra,
      },
    }),
  );
}

async function installPlugin(directory, id) {
  const result = await bb("plugin", "install", `path:${directory}`, "--yes");
  assert.equal(result.plugin.id, id);
  assert.equal(result.plugin.status, "running", result.plugin.statusDetail);
  return result.plugin;
}

function toolCallCount(snapshot) {
  return snapshot.toolCalls?.tool_calls;
}

async function countMarkerRows(timeline, marker) {
  return timeline.rows.filter((row) => JSON.stringify(row).includes(marker));
}

let fatalError;
try {
  const fixture = path.join(root, "integration-plugin");
  const guard = path.join(root, "startup-guard-plugin");
  const runtime = path.join(root, "scripted-runtime-plugin");
  const tempRepo = path.join(root, "repo");
  const guardFailure = path.join(root, "fail-startup-guard");
  await mkdir(fixture, { recursive: true });
  await mkdir(guard, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(fixture, "node_modules"),
    "dir",
  );
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(runtime, "node_modules"),
    "dir",
  );
  await writeManifest(fixture, "ensemble-t01-integration");
  await writeManifest(runtime, RUNTIME_ID, { host: "./host.ts" });
  await copyFile(
    path.join(repositoryRoot, "test/fixtures/bb-integration/server.ts"),
    path.join(fixture, "server.ts"),
  );
  await copyFile(
    path.join(
      repositoryRoot,
      "test/fixtures/bb-integration/scripted-runtime.ts",
    ),
    path.join(runtime, "server.ts"),
  );
  const providerBridgeSource = await readFile(
    path.join(bbSource, "tests/scripted-echo-provider/src/provider-bridge.ts"),
    "utf8",
  );
  const responseMarker =
    "  pendingReplies.delete(id);\n  const session = sessions.get(pending.threadId);";
  assert.equal(
    providerBridgeSource.split(responseMarker).length - 1,
    1,
    "Pinned scripted provider response hook changed",
  );
  await writeFile(
    path.join(runtime, "src-provider-bridge.ts"),
    providerBridgeSource.replace(
      responseMarker,
      `  pendingReplies.delete(id);
  if (pending.kind === "tool") {
    recordRequest("t01/tool-result", {
      toolName: pending.toolName,
      result,
      error: error ?? null,
    });
  }
  const session = sessions.get(pending.threadId);`,
    ),
  );
  await copyFile(
    path.join(bbSource, "LICENSE"),
    path.join(runtime, "UPSTREAM-LICENSE"),
  );
  await writeFile(
    path.join(runtime, "host.ts"),
    'export { experimental_providerBridge } from "./src-provider-bridge.js";\n',
  );
  await writeManifest(guard, "ensemble-t01-startup-guard");
  await writeFile(
    path.join(guard, "server.ts"),
    `import { existsSync } from "node:fs";
export default function startupGuard(bb) {
  if (existsSync(${JSON.stringify(guardFailure)})) {
    throw new Error("Intentional T01 startup guard failure");
  }
  bb.experimental_hooks.on("message.dispatch", ({ thread }) =>
    (thread.providerId === ${JSON.stringify(PROVIDER_ID)} || thread.provider === ${JSON.stringify(PROVIDER_ID)}) && existsSync(${JSON.stringify(waiterEnabled)})
      ? { action: "wait", reason: "T01 startup queue proof" }
      : { action: "proceed" },
  );
}\n`,
  );
  await exec("git", ["init", "-b", "main", tempRepo]);
  await exec("git", [
    "-C",
    tempRepo,
    "-c",
    "user.name=T01 Fixture",
    "-c",
    "user.email=t01@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "T01 disposable repository",
  ]);

  await start();
  check(
    "isolatedInstance",
    "passed",
    "Dedicated BB_DATA_DIR and loopback ports",
  );
  check("publicPluginLoader", "passed", {
    externalWaiter: await installPlugin(guard, GUARD_ID),
    scriptedRuntime: await installPlugin(runtime, RUNTIME_ID),
    ensembleFixture: await installPlugin(fixture, PLUGIN_ID),
  });
  const machine = (await bb("machine", "list")).find(
    (item) => item.status === "connected",
  );
  assert(machine, "No connected host in isolated BB instance");
  const project = await bb(
    "project",
    "create",
    "--name",
    "T01 disposable project",
    "--root",
    tempRepo,
    "--machine",
    machine.id,
  );
  const spawned = await rpc("spawn", {
    projectId: project.id,
    hostId: machine.id,
    prompt: "call_tool:integration_ping",
  });
  const threadId = spawned.id;
  assert.equal(
    typeof threadId,
    "string",
    "Public threads.spawn returned no thread id",
  );
  await until(
    async () => toolCallCount(await rpc("snapshot")) === 1,
    "scripted tool result round trip",
  );
  let thread = await until(async () => {
    const value = await rpc("thread", { threadId });
    return value.status === "idle" ? value : false;
  }, "spawn turn to become idle");
  assert.equal(thread.projectId, project.id);
  assert.equal(thread.providerId, PROVIDER_ID);
  assert.equal(typeof thread.environmentId, "string");
  const environmentId = thread.environmentId;
  const providerRequests = (await readFile(providerRecord, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  const initialStart = providerRequests.find(
    (entry) =>
      entry.method === "thread/start" && entry.params.threadId === threadId,
  );
  const initialTurn = providerRequests.find(
    (entry) =>
      entry.method === "turn/start" &&
      entry.params.input.some(
        (item) => item.text === "call_tool:integration_ping",
      ),
  );
  assert(
    initialStart,
    "Scripted provider did not record the initial thread start",
  );
  assert(initialTurn, "Scripted provider did not record the initial turn");
  assert.equal(initialTurn.params.options.model, "fixture-model");
  assert.equal(initialTurn.params.options.reasoningLevel, "high");
  assert.equal(initialTurn.params.options.serviceTier, "fast");
  assert.equal(initialStart.params.options.permissionMode, "accept-edits");
  assert.equal(
    initialStart.params.options.providerOptions.scripted
      .uniqueProviderThreadIds,
    true,
  );
  assert.ok(initialStart.params.cwd.startsWith(data));
  const providerToolResults = providerRequests.filter(
    (entry) =>
      entry.method === "t01/tool-result" &&
      entry.params.toolName === "integration_ping",
  );
  assert.ok(providerToolResults.length > 0);
  assert.ok(
    providerToolResults.some((entry) => {
      const result = entry.params.result;
      return (
        entry.params.error === null &&
        result?.success === true &&
        result.contentItems?.some(
          (item) =>
            item.type === "inputText" &&
            item.text === "integration tool result",
        )
      );
    }),
    "Scripted provider did not receive the tool's returned result",
  );
  check("spawnAndRichExecutionConfig", "passed", {
    threadId,
    projectId: thread.projectId,
    providerId: thread.providerId,
    environmentId,
    requested: {
      model: "fixture-model",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      workspace: "managed-worktree",
    },
    providerObserved: {
      model: initialTurn.params.options.model,
      reasoningLevel: initialTurn.params.options.reasoningLevel,
      serviceTier: initialTurn.params.options.serviceTier,
      permissionMode: initialStart.params.options.permissionMode,
      uniqueProviderThreadIds:
        initialStart.params.options.providerOptions.scripted
          .uniqueProviderThreadIds,
    },
  });
  check("pluginToolAndResultRoundTrip", "passed", {
    toolCalls: toolCallCount(await rpc("snapshot")),
    providerReceivedToolResult: true,
  });

  const startCountBeforeWaitComposition = toolCallCount(await rpc("snapshot"));
  await writeFile(waiterEnabled, "enabled");
  const externallyWaited = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_waiter_order:${randomUUID()} call_tool:integration_ping`,
  });
  assert.equal(
    externallyWaited.status,
    "accepted",
    JSON.stringify(externallyWaited),
  );
  assert.equal(externallyWaited.sendResponse.delivery, "queued");
  assert.equal(
    externallyWaited.sendResponse.queuedMessage.waitingOn?.pluginId,
    GUARD_ID,
  );
  const externallyWaitedRows = await rpc("queuedMessages", { threadId });
  assert.equal(externallyWaitedRows.length, 1);
  await rpc("setDispatchGate", { mode: "paused" });
  const rejectedAfterWait = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_reject_after_wait:${randomUUID()} call_tool:integration_ping`,
  });
  assert.equal(rejectedAfterWait.status, "rejected");
  assert.match(rejectedAfterWait.message, /T01 dispatch gate is paused/u);
  assert.equal(
    (await rpc("queuedMessages", { threadId })).length,
    externallyWaitedRows.length,
    "A later Ensemble reject persisted a row after an earlier plugin voted wait",
  );
  await rpc("setDispatchGate", { mode: "stopped" });
  const rejectedDuringStop = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_reject_during_stop:${randomUUID()} call_tool:integration_ping`,
  });
  assert.equal(rejectedDuringStop.status, "rejected");
  assert.match(rejectedDuringStop.message, /T01 dispatch gate is stopped/u);
  assert.equal(
    (await rpc("queuedMessages", { threadId })).length,
    externallyWaitedRows.length,
  );
  await rpc("setDispatchGate", { mode: "paused" });
  assert.equal(
    toolCallCount(await rpc("snapshot")),
    startCountBeforeWaitComposition,
  );
  await rm(waiterEnabled, { force: true });
  await rpc("recheckDispatch");
  const rejectedQueuedRow = await until(async () => {
    const rows = await rpc("queuedMessages", { threadId });
    return rows.length === 1 && rows[0].failureReason !== null ? rows : false;
  }, "queued plugin wait to be rejected by paused Ensemble gate");
  assert.equal(
    rejectedQueuedRow[0].failureReason,
    "T01 dispatch gate is paused",
  );
  assert.equal(
    toolCallCount(await rpc("snapshot")),
    startCountBeforeWaitComposition,
  );
  await rpc("setDispatchGate", { mode: "ready" });
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) ===
      startCountBeforeWaitComposition + 1,
    "accepted plugin-waited row to dispatch after gate resume",
  );
  await until(
    async () => (await rpc("queuedMessages", { threadId })).length === 0,
    "accepted plugin-waited row to leave queue after resume",
  );
  check("rejectComposesWithAnotherPluginWait", "passed", {
    pluginInstallOrder: [GUARD_ID, PLUGIN_ID],
    firstPluginWaitWasAccepted: true,
    laterRejectDidNotCreateAnotherQueueRow: true,
    rejectedExistingQueueRowStayedHeld: true,
    resumeDispatchedExactlyOnce: true,
  });

  const countBeforeCoreQueueGate = toolCallCount(await rpc("snapshot"));
  const delayedTurn = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_core_queue_source:${randomUUID()} delay:3000`,
  });
  assert.equal(delayedTurn.status, "accepted", JSON.stringify(delayedTurn));
  await until(
    async () => (await rpc("thread", { threadId })).status === "active",
    "delayed core-queue source turn",
  );
  await rpc("setDispatchGate", { mode: "paused" });
  const rejectedBeforeCoreQueue = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_core_queue_reject:${randomUUID()} call_tool:integration_ping`,
    mode: "queue-if-active",
  });
  assert.equal(rejectedBeforeCoreQueue.status, "rejected");
  assert.match(rejectedBeforeCoreQueue.message, /T01 dispatch gate is paused/u);
  assert.equal((await rpc("queuedMessages", { threadId })).length, 0);
  await rpc("setDispatchGate", { mode: "stopped" });
  const rejectedAfterCoreStop = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_core_queue_stop:${randomUUID()} call_tool:integration_ping`,
    mode: "queue-if-active",
  });
  assert.equal(rejectedAfterCoreStop.status, "rejected");
  assert.match(rejectedAfterCoreStop.message, /T01 dispatch gate is stopped/u);
  assert.equal((await rpc("queuedMessages", { threadId })).length, 0);
  await rpc("setDispatchGate", { mode: "ready" });
  const coreQueued = await rpc("sendAdmissionProbe", {
    threadId,
    prompt: `t01_core_queue_accepted:${randomUUID()} call_tool:integration_ping`,
    mode: "queue-if-active",
  });
  assert.equal(coreQueued.status, "accepted", JSON.stringify(coreQueued));
  assert.equal(coreQueued.sendResponse.delivery, "queued");
  assert.equal(
    coreQueued.sendResponse.queuedMessage.waitingOn?.kind,
    "thread-busy",
  );
  await rpc("setDispatchGate", { mode: "paused" });
  await until(
    async () => (await rpc("thread", { threadId })).status === "idle",
    "delayed core-queue source turn to finish",
  );
  const rejectedCoreQueuedRow = await until(async () => {
    const rows = await rpc("queuedMessages", { threadId });
    return rows.length === 1 && rows[0].failureReason !== null ? rows : false;
  }, "core-busy row to be rejected before dispatch");
  assert.equal(
    rejectedCoreQueuedRow[0].failureReason,
    "T01 dispatch gate is paused",
  );
  assert.equal(toolCallCount(await rpc("snapshot")), countBeforeCoreQueueGate);
  await rpc("setDispatchGate", { mode: "ready" });
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) === countBeforeCoreQueueGate + 1,
    "core-busy row to dispatch after gate resume",
  );
  await until(
    async () => (await rpc("queuedMessages", { threadId })).length === 0,
    "core-busy row to leave queue after resume",
  );
  check("rejectRunsBeforeCoreQueueing", "passed", {
    sourceTurnHeldThreadBusy: true,
    rejectWithQueueIfActiveCreatedNoQueueRow: true,
    acceptedCoreBusyRowStayedHeldWhilePaused: true,
    resumeDispatchedExactlyOnce: true,
  });

  await until(
    async () => (await rpc("thread", { threadId })).status === "idle",
    "thread to become idle before public queue creation",
  );
  const countBeforePublicQueueCreate = toolCallCount(await rpc("snapshot"));
  const manuallyCreated = await rpc("createQueuedMessage", {
    threadId,
    prompt: `t01_public_queue_create:${randomUUID()} call_tool:integration_ping`,
  });
  assert.equal(manuallyCreated.waitingOn?.kind, "thread-busy");
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) === countBeforePublicQueueCreate + 1,
    "public queuedMessages.create on an idle conversation",
  );
  check("queuedMessagesCreateIsDispatching", "passed", {
    rowInitiallyWaitedFor: "thread-busy",
    idleConversationDispatchedIt: true,
    implication: "create does not provide a durable operator-controlled hold",
  });

  const pendingId = `pending-${randomUUID()}`;
  const pendingPrompt = `t01_unsent:${pendingId} call_tool:integration_ping`;
  const staged = await rpc("stagePending", {
    operationId: pendingId,
    threadId,
    prompt: pendingPrompt,
  });
  assert.equal(staged.status, "pending");
  const countBeforeHealthyRestart = toolCallCount(await rpc("snapshot"));
  await stop();
  await start();
  let snapshot = await rpc("snapshot");
  assert.equal(toolCallCount(snapshot), countBeforeHealthyRestart);
  assert.equal(
    snapshot.pending.find((item) => item.operation_id === pendingId)?.status,
    "pending",
  );
  thread = await rpc("thread", { threadId });
  assert.equal(thread.environmentId, environmentId);
  check("restartAndEnvironmentRetention", "passed", {
    toolCalls: toolCallCount(snapshot),
    operationStillPending: true,
    environmentId: thread.environmentId,
  });
  const stagedReceipt = await rpc("dispatchPending", {
    operationId: pendingId,
  });
  assert.equal(stagedReceipt.delivery, "sent");
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) === countBeforeHealthyRestart + 1,
    "staged send result",
  );
  await until(
    async () => (await rpc("thread", { threadId })).status === "idle",
    "staged send idle",
  );
  check("ensembleOwnedUnsentPending", "passed", {
    detail:
      "A local SQLite intent survived restart without dispatch, then was sent after healthy plugin load.",
    delivery: stagedReceipt.delivery,
  });

  const questionId = `question-${randomUUID()}`;
  const question = await rpc("stagePending", {
    operationId: questionId,
    threadId,
    prompt: "ask_user",
  });
  assert.equal(question.status, "pending");
  await rpc("dispatchPending", { operationId: questionId });
  const interactions = await until(async () => {
    const current = await rpc("pendingInteractions", { threadId });
    return current.length > 0 ? current : false;
  }, "public provider question");
  assert.equal(interactions[0].payload.kind, "user_question");
  const answer = await rpc("answerQuestion", { threadId });
  assert.ok(
    answer.status === "resolved" || answer.status === "resolving",
    JSON.stringify(answer),
  );
  assert.equal(answer.resolution.kind, "user_answer");
  await until(
    async () => (await rpc("pendingInteractions", { threadId })).length === 0,
    "public question answer",
  );
  await until(
    async () => (await rpc("thread", { threadId })).status === "idle",
    "question turn completion",
  );
  check("humanInteraction", "passed", {
    interactionId: interactions[0].id,
    payloadKind: interactions[0].payload.kind,
    answerStatus: answer.status,
    answer: "staging",
  });

  const lostId = `lost-${randomUUID()}`;
  const countBeforeLostSend = toolCallCount(await rpc("snapshot"));
  const lostResponse = await rpc("sendWithLostResponse", {
    operationId: lostId,
    threadId,
  });
  assert.equal(lostResponse.status, "uncertain", JSON.stringify(lostResponse));
  snapshot = await rpc("snapshot");
  assert.ok(snapshot.droppedResponses.dropped_responses >= 1);
  const expectedLostMarker = `t01_lost_response_marker:${lostId}`;
  const expectedCountAfterLostSend = countBeforeLostSend + 1;
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) === expectedCountAfterLostSend,
    "tool call after lost response",
  );
  await until(
    async () => (await rpc("thread", { threadId })).status === "idle",
    "lost-response turn completion",
  );
  let timeline = await rpc("timeline", { threadId });
  const matchingRows = await countMarkerRows(timeline, expectedLostMarker);
  assert.equal(
    matchingRows.length,
    1,
    `Expected one timeline identity for ${expectedLostMarker}`,
  );
  const lostMessageId = matchingRows[0].id;
  assert.equal(typeof lostMessageId, "string");
  await stop();
  await start();
  snapshot = await rpc("snapshot");
  assert.equal(
    snapshot.pending.find((item) => item.operation_id === lostId)?.status,
    "uncertain",
  );
  const recovered = await rpc("recoverLostResponse", { operationId: lostId });
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.matches, 1);
  assert.equal(recovered.delivery, "observed-in-timeline");
  assert.equal(recovered.queuedMessageId, null);
  timeline = await rpc("timeline", { threadId });
  const recoveredRows = await countMarkerRows(timeline, expectedLostMarker);
  assert.equal(recoveredRows.length, 1);
  assert.equal(recoveredRows[0].id, lostMessageId);
  assert.equal(
    toolCallCount(await rpc("snapshot")),
    expectedCountAfterLostSend,
  );
  check("lostResponseAcceptance", "partial", {
    droppedResponse: true,
    recoveredFromPublicTimeline: true,
    messageId: lostMessageId,
    exactlyOneTimelineMatch: true,
    duplicateToolEffectObserved: false,
    limitation:
      "Send receipt has no stable operation id; correlation used a unique marker in the public timeline.",
  });

  const queuedLostId = `lost-queued-${randomUUID()}`;
  const queuedLostMarker = `t01_lost_response_marker:${queuedLostId}`;
  const countBeforeQueuedLostResponse = toolCallCount(await rpc("snapshot"));
  await writeFile(waiterEnabled, "enabled");
  const queuedLostResponse = await rpc("sendWithLostResponse", {
    operationId: queuedLostId,
    threadId,
  });
  assert.equal(queuedLostResponse.status, "uncertain");
  const queuedBeforeLostResponseRestart = await rpc("queuedMessages", {
    threadId,
  });
  const queuedLostRows = queuedBeforeLostResponseRestart.filter((row) =>
    JSON.stringify(row.content).includes(queuedLostMarker),
  );
  assert.equal(queuedLostRows.length, 1);
  assert.equal(queuedLostRows[0].waitingOn?.pluginId, GUARD_ID);
  await stop();
  await start();
  const recoveredQueuedLost = await rpc("recoverLostResponse", {
    operationId: queuedLostId,
  });
  assert.equal(recoveredQueuedLost.status, "accepted");
  assert.equal(recoveredQueuedLost.matches, 1);
  assert.equal(recoveredQueuedLost.delivery, "observed-in-queue");
  assert.equal(recoveredQueuedLost.queuedMessageId, queuedLostRows[0].id);
  snapshot = await rpc("snapshot");
  assert.equal(toolCallCount(snapshot), countBeforeQueuedLostResponse);
  assert.equal(
    snapshot.pending.find((item) => item.operation_id === queuedLostId)
      ?.queued_message_id,
    queuedLostRows[0].id,
  );
  assert.equal(
    (await rpc("queuedMessages", { threadId })).some(
      (row) => row.id === queuedLostRows[0].id,
    ),
    true,
  );
  await rm(waiterEnabled, { force: true });
  await rpc("recheckDispatch");
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) ===
      countBeforeQueuedLostResponse + 1,
    "queued send to execute after lost response recovery",
  );
  await until(
    async () => (await rpc("queuedMessages", { threadId })).length === 0,
    "recovered queued send to leave queue",
  );
  check("lostQueuedResponseAcceptance", "partial", {
    droppedAcceptedQueuedResponse: true,
    restartedBeforeRecovery: true,
    recoveredFromPublicQueue: true,
    queuedMessageId: recoveredQueuedLost.queuedMessageId,
    duplicateToolEffectObserved: false,
    limitation:
      "A unique marker found one accepted public queue row and avoided resend; zero or multiple matches remain uncertain because BB exposes no caller operation id or in-flight request lookup.",
  });

  const localPendingAfterFailureId = `pending-at-failure-${randomUUID()}`;
  await rpc("stagePending", {
    operationId: localPendingAfterFailureId,
    threadId,
    prompt: `t01_unsent:${localPendingAfterFailureId} call_tool:integration_ping`,
  });
  await writeFile(waiterEnabled, "enabled");
  const countBeforeQueuedStart = toolCallCount(await rpc("snapshot"));
  const queuePrompt = `t01_queued_startup:${randomUUID()} call_tool:integration_ping`;
  const queued = await rpc("send", { threadId, prompt: queuePrompt });
  assert.equal(queued.delivery, "queued", JSON.stringify(queued));
  assert.equal(queued.queuedMessage.waitingOn?.kind, "plugin");
  assert.equal(queued.queuedMessage.waitingOn?.pluginId, GUARD_ID);
  assert.equal(toolCallCount(await rpc("snapshot")), countBeforeQueuedStart);
  await rpc("setDispatchGate", { mode: "paused" });
  await writeFile(guardFailure, "intentional guard initialization error");
  await stop();
  await start();
  const pluginList = await bb("plugin", "list");
  const guardState = pluginList.plugins.find(
    (plugin) => plugin.id === GUARD_ID,
  );
  const ensembleState = pluginList.plugins.find(
    (plugin) => plugin.id === PLUGIN_ID,
  );
  assert.equal(guardState.status, "error");
  assert.equal(ensembleState.status, "running");
  const gateHeldQueue = await until(async () => {
    const rows = await rpc("queuedMessages", { threadId });
    return rows.length === 1 && rows[0].failureReason !== null ? rows : false;
  }, "Ensemble reject to hold orphaned queue after another plugin fails startup");
  assert.equal(gateHeldQueue[0].failureReason, "T01 dispatch gate is paused");
  snapshot = await rpc("snapshot");
  assert.equal(toolCallCount(snapshot), countBeforeQueuedStart);
  assert.equal(
    snapshot.pending.find(
      (item) => item.operation_id === localPendingAfterFailureId,
    )?.status,
    "pending",
  );
  check("startupGuardFailureWithEnsembleLoaded", "passed", {
    beforeRestartCount: countBeforeQueuedStart,
    afterRestartCount: toolCallCount(snapshot),
    failedPluginStatus: guardState.status,
    ensembleStatus: ensembleState.status,
    bbAcceptedQueuedMessageStayedHeld: true,
    failureReason: gateHeldQueue[0].failureReason,
    requestedSendMode: "start",
    localUnsentIntentStayedPending: true,
  });
  await rpc("setDispatchGate", { mode: "ready" });
  await until(
    async () =>
      toolCallCount(await rpc("snapshot")) === countBeforeQueuedStart + 1,
    "queued send dispatch after Ensemble gate resumes",
  );
  await until(
    async () => (await rpc("queuedMessages", { threadId })).length === 0,
    "queued send to leave queue after Ensemble gate resumes",
  );

  await rm(guardFailure, { force: true });
  await stop();
  await start();
  const recoveredPluginList = await bb("plugin", "list");
  assert.equal(
    recoveredPluginList.plugins.find((plugin) => plugin.id === GUARD_ID).status,
    "running",
  );
  assert.equal(
    recoveredPluginList.plugins.find((plugin) => plugin.id === PLUGIN_ID)
      .status,
    "running",
  );
  const countBeforeEnsembleUnavailable = toolCallCount(await rpc("snapshot"));
  await writeFile(waiterEnabled, "enabled");
  const noEnsembleMarker = `t01_no_ensemble:${randomUUID()}`;
  const queuedWithoutEnsemble = await rpc("send", {
    threadId,
    prompt: noEnsembleMarker,
  });
  assert.equal(queuedWithoutEnsemble.delivery, "queued");
  assert.equal(
    queuedWithoutEnsemble.queuedMessage.waitingOn?.pluginId,
    GUARD_ID,
  );
  await writeFile(guardFailure, "intentional guard initialization error");
  await writeFile(ensembleFailure, "intentional Ensemble initialization error");
  await stop();
  await start();
  const unavailablePluginList = await bb("plugin", "list");
  const unavailableGuardState = unavailablePluginList.plugins.find(
    (plugin) => plugin.id === GUARD_ID,
  );
  const unavailableEnsembleState = unavailablePluginList.plugins.find(
    (plugin) => plugin.id === PLUGIN_ID,
  );
  assert.equal(unavailableGuardState.status, "error");
  assert.equal(unavailableEnsembleState.status, "error");
  await until(async () => {
    const lines = (await readFile(providerRecord, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    return lines.some(
      (entry) =>
        entry.method === "turn/start" &&
        entry.params.input.some((item) => item.text === noEnsembleMarker),
    );
  }, "previously accepted queued row to start while Ensemble is unavailable");
  const publicThreadAfterUnavailableDispatch = await bb(
    "thread",
    "get",
    threadId,
  );
  const publicLogAfterUnavailableDispatch = await bb("thread", "log", threadId);
  const publicLogMarkerMatches =
    JSON.stringify(publicLogAfterUnavailableDispatch).split(noEnsembleMarker)
      .length - 1;
  const queueWithoutEnsemble = await bb("thread", "queue", "list", threadId);
  assert.equal(queueWithoutEnsemble.length, 0);
  check("startupWithoutEnsembleDispatchesAcceptedQueue", "failed", {
    beforeRestartCount: countBeforeEnsembleUnavailable,
    ensembleStatus: unavailableEnsembleState.status,
    externalWaitOwnerStatus: unavailableGuardState.status,
    providerObservedPreviouslyAcceptedPrompt: noEnsembleMarker,
    publicThreadStatusAfterProviderAttempt:
      publicThreadAfterUnavailableDispatch.thread.status,
    publicTimelineMarkerMatches: publicLogMarkerMatches,
    queueAfterRestart: queueWithoutEnsemble.length,
    limitation:
      "With both dispatch hooks unavailable, BB orphan recovery clears the persisted plugin wait and dispatches the accepted row through the separately loaded provider.",
  });
  const eventNames = [
    ...new Set(snapshot.events.map((event) => event.eventName)),
  ].sort();
  const requiredEvents = [
    "interaction.pending",
    "message.dispatched",
    "message.queued",
    "thread.active",
    "thread.created",
    "thread.idle",
  ];
  assert.deepEqual(
    requiredEvents.filter((eventName) => !eventNames.includes(eventName)),
    [],
    `Missing required lifecycle events: ${eventNames.join(", ")}`,
  );
  check("lifecycleEvents", "passed", { eventNames });
} catch (error) {
  fatalError = error;
} finally {
  try {
    await stop();
  } catch (error) {
    fatalError ??= error;
  }
  try {
    await writeFile(path.join(root, "launcher.log"), launcherOutput);
  } catch {
    // A fixture setup failure can happen before the root is ready.
  }
  if (keep) {
    evidence.evidenceDirectory = root;
  } else {
    await rm(root, { recursive: true, force: true });
    evidence.cleanup =
      "isolated data directory, fixture plugins, repository, logs and launcher stopped/removed";
  }
}

if (fatalError) {
  evidence.failure =
    fatalError instanceof Error ? fatalError.message : String(fatalError);
  if (keep) evidence.failureLogs = launcherOutput.slice(-6000);
  process.stderr.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const gates = Object.values(evidence.checks);
  const hasUnsupportedGate = gates.some((item) => item.status === "failed");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (hasUnsupportedGate) process.exitCode = 2;
}
