import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { bbCli, restartBb, rpc, waitFor, withFixture } from "./harness.mjs";

const exec = promisify(execFile);
const fixturePluginId = "ensemble-t1-fixture";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateReportsDirectory = path.join(
  repositoryRoot,
  "node_modules/.cache/ensemble-bb-integration/t5-gates",
  randomUUID(),
);

async function createProject(instance, label) {
  const machine = (await bbCli(instance, "machine", "list")).find(
    (candidate) => candidate.status === "connected",
  );
  assert(machine, "The isolated BB host is not connected");
  const projectRoot = path.join(instance.root, `${label}-git-project`);
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "README.md"), `${label} fixture\n`);
  await exec("git", ["init", "-b", "main", projectRoot]);
  await exec("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=T5 Fixture",
    "-c",
    "user.email=t5-fixture@example.invalid",
    "add",
    "README.md",
  ]);
  await exec("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=T5 Fixture",
    "-c",
    "user.email=t5-fixture@example.invalid",
    "commit",
    "-m",
    `${label} fixture`,
  ]);
  const project = await bbCli(
    instance,
    "project",
    "create",
    "--name",
    `${label} T5 disposable project`,
    "--root",
    projectRoot,
    "--machine",
    machine.id,
  );
  return { project, machine };
}

async function installRecoveryFixture(instance) {
  await copyFile(
    path.join(repositoryRoot, "test/bb-integration/fixture/recovery-server.ts"),
    path.join(instance.fixtureDirectory, "recovery-server.ts"),
  );
  const manifestPath = path.join(instance.fixtureDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bb.server = "./recovery-server.ts";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const installed = await bbCli(
    instance,
    "plugin",
    "install",
    `path:${instance.fixtureDirectory}`,
    "--yes",
  );
  assert.equal(installed.plugin.id, fixturePluginId);
}

async function pluginRpc(instance, pluginId, method, input = {}) {
  const inputPath = path.join(instance.root, `${method}-${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  const response = await bbCli(
    instance,
    "plugin",
    "rpc",
    "call",
    pluginId,
    method,
    "--input-file",
    inputPath,
  );
  return response.result ?? response;
}

const waitGuardServer = `
import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";

function schema<S extends z.ZodType>(value: S): StandardSchemaV1<z.input<S>, z.output<S>> {
  return { "~standard": {
    version: 1,
    vendor: "T5 wait guard",
    types: {} as { input: z.input<S>; output: z.output<S> },
    validate(input) {
      const result = value.safeParse(input);
      return result.success ? { value: result.data } : { issues: result.error.issues.map((issue) => ({ message: issue.message })) };
    },
  } };
}

export default function waitGuard(bb: BbPluginApi): void {
  const database = bb.storage.database();
  database.exec("CREATE TABLE IF NOT EXISTS t5_wait_guard (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL)");
  database.prepare("INSERT OR IGNORE INTO t5_wait_guard (id, mode) VALUES (1, 'wait')").run();
  bb.experimental_hooks.on("message.dispatch", ({ input }) => {
    if (!input.text.includes("T5_TASK=admission")) return { action: "proceed" };
    const { mode } = database.prepare("SELECT mode FROM t5_wait_guard WHERE id = 1").get() as { mode: string };
    return mode === "wait" ? { action: "wait", reason: "T5 second-plugin wait" } : { action: "proceed" };
  });
  const output = schema(z.any());
  bb.rpc.register({
    "wait.run": { input: schema(z.object({ operation: z.enum(["set", "get"]), mode: z.enum(["wait", "ready"]).optional() })), output },
  }, {
    "wait.run": async ({ operation, mode }) => {
      if (operation === "set") {
        database.prepare("UPDATE t5_wait_guard SET mode = ? WHERE id = 1").run(mode);
        if (mode === "ready") await bb.experimental_hooks.recheck("message.dispatch");
      }
      return database.prepare("SELECT mode FROM t5_wait_guard WHERE id = 1").get();
    },
  });
}
`;

async function installWaitGuard(instance) {
  const directory = path.join(instance.root, "t5-wait-guard");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "bb-plugin-t5-wait-guard",
        version: "0.0.1",
        private: true,
        type: "module",
        dependencies: {
          "@get-bb/plugin-sdk": "0.5.24",
          zod: "4.3.6",
        },
        bb: {
          name: "T5 Wait Guard",
          description: "Disposable second-plugin dispatch wait fixture.",
          branding: { icon: "Workflow" },
          server: "./server.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(directory, "server.ts"), waitGuardServer);
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  const installed = await bbCli(
    instance,
    "plugin",
    "install",
    `path:${directory}`,
    "--yes",
  );
  assert.equal(installed.plugin.status, "running");
  return installed.plugin.id;
}

async function execution(instance, operation, args = {}) {
  return rpc(instance, "execution.run", { operation, args });
}

async function loss(instance, operation, args = {}) {
  return rpc(instance, "loss.run", { operation, args });
}

async function spawnThread(instance, project, machine, prompt, environment) {
  return execution(instance, "spawn", {
    projectId: project.id,
    providerId: "ensemble-scripted",
    model: "fixture-model",
    reasoningLevel: "medium",
    serviceTier: "default",
    permissionMode: "accept-edits",
    prompt,
    environment: environment ?? {
      type: "host",
      hostId: machine.id,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    },
  });
}

async function waitForIdle(instance, threadId, label) {
  return waitFor(async () => {
    const thread = await execution(instance, "get", { threadId });
    return thread.status === "idle" ? thread : false;
  }, label);
}

async function providerTrace(instance) {
  let content;
  try {
    content = await readFile(instance.env.SCRIPTED_ECHO_RECORD_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForQueue(instance, threadId, label) {
  return waitFor(async () => {
    const queue = await execution(instance, "queue-list", { threadId });
    return queue[0] ?? false;
  }, label);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function recordGate(instance, name, result) {
  const report = { name, ...result };
  instance.runtimeManifest.checks[`T5:${name}`] = report;
  const reportPath = path.join(gateReportsDirectory, `${name}.json`);
  const reportLine = `${JSON.stringify(report)}\n`;
  await mkdir(gateReportsDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await appendFile(
    path.join(gateReportsDirectory, "reports.jsonl"),
    reportLine,
  );
  process.stdout.write(`T5_GATE_PATH ${reportPath}\n`);
  process.stdout.write(`T5_GATE ${reportLine}`);
}

test("T5 composed writer admission records the second-plugin wait without claiming a safe reservation", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const guardId = await installWaitGuard(instance);
    const { project, machine } = await createProject(instance, "admission");
    const spawned = await execution(instance, "spawn", {
      projectId: project.id,
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      prompt: "T5_TASK=admission call_tool:capability_ping",
      environment: {
        type: "host",
        hostId: machine.id,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    });
    assert.equal(typeof spawned.id, "string");
    const thread = await waitFor(async () => {
      const observed = await execution(instance, "get", {
        threadId: spawned.id,
      });
      return observed.status === "pending" ? observed : false;
    }, "thread queued behind T5 second-plugin wait");
    const queued = await waitFor(async () => {
      const rows = await execution(instance, "queue-list", {
        threadId: spawned.id,
      });
      return (
        rows.find(
          (row) =>
            row.waitingOn?.kind === "plugin" &&
            row.waitingOn.pluginId === guardId,
        ) ?? false
      );
    }, "queued row held by the separate plugin");
    const observations = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      {
        operation: "observations",
        taskId: "admission",
      },
    );
    assert.equal(observations.length, 1);
    assert.equal(observations[0].threadId, spawned.id);
    assert.equal(observations[0].environmentId, null);
    assert.equal(thread.status, "pending");
    const effectsBeforeRelease = (await providerTrace(instance)).filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(effectsBeforeRelease.length, 0);

    await pluginRpc(instance, guardId, "wait.run", {
      operation: "set",
      mode: "ready",
    });
    const completed = await waitFor(async () => {
      const current = await execution(instance, "get", {
        threadId: spawned.id,
      });
      return current.status === "idle" ? current : false;
    }, "admission probe after second-plugin release");
    assert.equal(completed.id, spawned.id);
    assert.equal(typeof completed.environmentId, "string");
    const trace = await providerTrace(instance);
    const toolEffects = trace.filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(toolEffects.length, 1);
    assert.equal(toolEffects[0].params.toolName, "capability_ping");
    await recordGate(instance, "composed-writer-admission", {
      verdict: "open",
      identities: {
        projectId: project.id,
        threadId: spawned.id,
        guardPluginId: guardId,
        queuedMessageId: queued.id,
        environmentId: completed.environmentId,
      },
      observed: {
        waitingOn: queued.waitingOn,
        preReleaseProviderEffects: 0,
        postReleaseToolEffects: 1,
        initialEnvironmentId: observations[0].environmentId,
      },
      limits: [
        "BB exposes per-plugin waits and hook observations, but this fixture has no Ensemble writer reservation to prove release or serialization of two task writers.",
      ],
    });
  });
});

test("T5 stop confirms active and delayed-start observations before release", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "stop");

    const active = await spawnThread(
      instance,
      project,
      machine,
      "T5_TASK=active-stop hold_turn",
    );
    const running = await waitFor(async () => {
      const thread = await execution(instance, "get", { threadId: active.id });
      return thread.status === "active" ? thread : false;
    }, "active scripted provider turn before stop");
    const activeEnvironment = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "environment", threadId: active.id },
    );
    assert.equal(activeEnvironment.thread.id, active.id);
    assert.equal(activeEnvironment.thread.environmentId, running.environmentId);
    assert.equal(activeEnvironment.environment.id, running.environmentId);
    assert.equal(activeEnvironment.environment.status, "ready");
    assert.equal(typeof activeEnvironment.environment.path, "string");

    const activeStop = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "stop", threadId: active.id },
    );
    assert.equal(activeStop.stopResponse.ok, true);
    const stoppedActive = await waitFor(async () => {
      const thread = await execution(instance, "get", { threadId: active.id });
      return thread.status === "idle" || thread.status === "error"
        ? thread
        : false;
    }, "active provider stop confirmation");
    const traceAfterActiveStop = await providerTrace(instance);
    const activeStopRequests = traceAfterActiveStop.filter(
      (entry) =>
        entry.method === "thread/stop" && entry.params.threadId === active.id,
    );
    assert.equal(activeStopRequests.length, 1);
    const activeEffects = traceAfterActiveStop.filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(activeEffects.length, 0);

    await pluginRpc(instance, fixturePluginId, "recovery.run", {
      operation: "set-task-wait",
      taskId: "delayed-stop",
      mode: "wait",
    });
    const delayed = await spawnThread(
      instance,
      project,
      machine,
      "T5_TASK=delayed-stop hold_turn",
    );
    const delayedQueued = await waitForQueue(
      instance,
      delayed.id,
      "delayed-start message held by T5 fixture hook",
    );
    assert.equal(delayedQueued.waitingOn?.kind, "plugin");
    assert.equal(delayedQueued.waitingOn.pluginId, fixturePluginId);
    const delayedBeforeStop = await execution(instance, "get", {
      threadId: delayed.id,
    });
    assert.equal(delayedBeforeStop.status, "pending");
    const delayedStop = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "stop", threadId: delayed.id },
    );
    assert.equal(delayedStop.stopResponse.ok, true);
    const delayedAfterStop = await waitFor(
      async () => {
        const current = await execution(instance, "get", {
          threadId: delayed.id,
        });
        return current.status === "idle" || current.status === "error"
          ? current
          : false;
      },
      "delayed start stop confirmation",
      3_000,
    ).catch(() => execution(instance, "get", { threadId: delayed.id }));
    const delayedStopConfirmed =
      delayedAfterStop.status === "idle" || delayedAfterStop.status === "error";
    const preReleaseTrace = await providerTrace(instance);
    const preReleaseQueue = await execution(instance, "queue-list", {
      threadId: delayed.id,
    });
    const preReleaseThread = await execution(instance, "get", {
      threadId: delayed.id,
    });
    const preReleaseObservations = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "observations", taskId: "delayed-stop" },
    );
    const delayedStartsBeforeRelease = preReleaseTrace.filter(
      (entry) =>
        entry.method === "turn/start" && entry.params.threadId === delayed.id,
    );
    const effectsBeforeRelease = preReleaseTrace.filter(
      (entry) => entry.method === "t1/tool-result",
    );
    let releaseAttempted = false;
    let releaseEvidence = null;
    if (delayedStopConfirmed) {
      releaseAttempted = true;
      await pluginRpc(instance, fixturePluginId, "recovery.run", {
        operation: "set-task-wait",
        taskId: "delayed-stop",
        mode: "ready",
      });
      const releaseWindowMs = 5_000;
      const stableNoStartWindowMs = 2_000;
      const releaseObservedAt = Date.now();
      let stableState = null;
      let stableSince = releaseObservedAt;
      while (Date.now() - releaseObservedAt < releaseWindowMs) {
        const [trace, queue, current, observations] = await Promise.all([
          providerTrace(instance),
          execution(instance, "queue-list", { threadId: delayed.id }),
          execution(instance, "get", { threadId: delayed.id }),
          pluginRpc(instance, fixturePluginId, "recovery.run", {
            operation: "observations",
            taskId: "delayed-stop",
          }),
        ]);
        const turnStarts = trace.filter(
          (entry) =>
            entry.method === "turn/start" &&
            entry.params.threadId === delayed.id,
        );
        const state = JSON.stringify({
          status: current.status,
          queuedMessageIds: queue.map((row) => row.id),
          hookObservationCount: observations.length,
        });
        if (state !== stableState) {
          stableState = state;
          stableSince = Date.now();
        }
        releaseEvidence = {
          trace,
          queue,
          thread: current,
          observations,
          turnStarts,
          stableNoStartMs: Date.now() - stableSince,
          stableNoStartWindowMs,
        };
        if (
          turnStarts.length > 0 ||
          releaseEvidence.stableNoStartMs >= stableNoStartWindowMs
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const delayedStartsAfterRelease = releaseEvidence?.turnStarts ?? [];
    const effectsAfterRelease = (
      releaseEvidence?.trace ?? preReleaseTrace
    ).filter((entry) => entry.method === "t1/tool-result");
    const policyViolation = !delayedStopConfirmed && releaseAttempted;
    await recordGate(instance, "stop-writer-release", {
      verdict:
        policyViolation ||
        delayedStartsBeforeRelease.length > 0 ||
        effectsBeforeRelease.length > 0 ||
        delayedStartsAfterRelease.length > 0 ||
        effectsAfterRelease.length > effectsBeforeRelease.length
          ? "fail"
          : "open",
      identities: {
        projectId: project.id,
        activeThreadId: active.id,
        activeEnvironmentId: running.environmentId,
        delayedThreadId: delayed.id,
        delayedQueuedMessageId: delayedQueued.id,
        delayedStopResponse: delayedStop.stopResponse,
      },
      observed: {
        activeStatusBeforeStop: running.status,
        activeStatusAfterStop: stoppedActive.status,
        activeProviderStopRequests: activeStopRequests.length,
        activeToolEffects: activeEffects.length,
        delayedStatusBeforeStop: delayedBeforeStop.status,
        delayedStatusAfterStop: delayedAfterStop.status,
        delayedStopConfirmed,
        delayedProviderTurnStartsBeforeRelease:
          delayedStartsBeforeRelease.length,
        delayedProviderTurnStartTraceBeforeRelease: delayedStartsBeforeRelease,
        delayedProviderToolEffectsBeforeRelease: effectsBeforeRelease.length,
        delayedProviderToolEffectTraceBeforeRelease: effectsBeforeRelease,
        releaseAttempted,
        releaseWithheldReason: delayedStopConfirmed
          ? null
          : "BB stop returned ok but thread stayed pending; no hook recheck was issued because a stop was not confirmed.",
        delayedProviderTurnStartsAfterRelease: delayedStartsAfterRelease.length,
        delayedProviderTurnStartTraceAfterRelease: delayedStartsAfterRelease,
        delayedProviderToolEffectsAfterRelease:
          effectsAfterRelease.length - effectsBeforeRelease.length,
        delayedProviderToolEffectTraceAfterRelease: effectsAfterRelease,
        delayedQueueBeforeStop: delayedQueued,
        delayedQueueAfterStopBeforeRelease: preReleaseQueue,
        delayedStatusBeforeRelease: preReleaseThread.status,
        hookObservationCountBeforeRelease: preReleaseObservations.length,
        delayedQueuedMessageIdsObservedByHook: preReleaseObservations.map(
          (entry) => entry.queuedMessageIds,
        ),
        delayedHookObservations: preReleaseObservations,
        releaseEvidence:
          releaseEvidence === null
            ? null
            : {
                queue: releaseEvidence.queue,
                status: releaseEvidence.thread.status,
                hookObservationCount: releaseEvidence.observations.length,
                stableNoStartMs: releaseEvidence.stableNoStartMs,
                stableNoStartWindowMs: releaseEvidence.stableNoStartWindowMs,
              },
        workspace: {
          environmentStatus: activeEnvironment.environment.status,
          path: activeEnvironment.environment.path,
        },
      },
      limits: [
        "The fixture observes BB's scripted provider and a plugin-held delayed start only; it does not implement an Ensemble writer reservation or enumerate arbitrary surviving workspace processes. If BB's stop leaves the thread pending, the fixture withholds recheck and cannot establish release behavior after a confirmed stop.",
      ],
    });
    assert.equal(
      releaseAttempted,
      delayedStopConfirmed,
      "Do not recheck the delayed writer until the thread is confirmed stopped",
    );
    assert.equal(
      delayedStartsBeforeRelease.length,
      0,
      "A delayed writer must not start before an explicit post-stop release",
    );
    assert.equal(
      effectsBeforeRelease.length,
      0,
      "A delayed writer must not create provider effects before release",
    );
    assert.equal(
      delayedStartsAfterRelease.length,
      0,
      "A confirmed stop must not let recheck start the delayed writer",
    );
    assert.equal(
      effectsAfterRelease.length - effectsBeforeRelease.length,
      0,
      "A confirmed stop must not allow provider effects after release",
    );
  });
});

test("T5 concurrent initial workspace launches retain their actual environment identities", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "workspace");
    const [left, right] = await Promise.all([
      spawnThread(
        instance,
        project,
        machine,
        "T5_TASK=initial-workspace call_tool:capability_ping",
      ),
      spawnThread(
        instance,
        project,
        machine,
        "T5_TASK=initial-workspace call_tool:capability_ping",
      ),
    ]);
    assert.notEqual(left.id, right.id);
    const [leftReady, rightReady] = await Promise.all([
      waitForIdle(instance, left.id, "first concurrent workspace thread idle"),
      waitForIdle(
        instance,
        right.id,
        "second concurrent workspace thread idle",
      ),
    ]);
    assert.equal(typeof leftReady.environmentId, "string");
    assert.equal(typeof rightReady.environmentId, "string");
    const trace = await providerTrace(instance);
    const effects = trace.filter((entry) => entry.method === "t1/tool-result");
    assert.equal(effects.length, 2);
    const observations = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "observations", taskId: "initial-workspace" },
    );
    assert.equal(observations.length, 2);
    assert.deepEqual(
      observations.map((entry) => entry.threadId).sort(),
      [left.id, right.id].sort(),
    );
    const environmentIds = [leftReady.environmentId, rightReady.environmentId];
    const operationId = `t5-workspace-${randomUUID()}`;
    const uncertainSpawnRequest = {
      operationId,
      projectId: project.id,
      hostId: machine.id,
      prompt: "T5_TASK=initial-workspace-uncertain call_tool:capability_ping",
      environment: {
        type: "host",
        hostId: machine.id,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    };
    let droppedResponse;
    try {
      await loss(instance, "spawn", {
        ...uncertainSpawnRequest,
        dropCallerResponse: true,
      });
      droppedResponse = "unexpected response";
    } catch (error) {
      droppedResponse = String(error);
    }
    const uncertainIntent = await loss(instance, "intent", { operationId });
    const acceptedMatch = await waitFor(async () => {
      const lookup = await loss(instance, "find-spawn-matches", {
        operationId,
      });
      return lookup.matches.length === 1 && lookup.matches[0].status === "idle"
        ? lookup.matches[0]
        : false;
    }, "one accepted initial-workspace spawn after its caller response is dropped");
    await restartBb(instance);
    const reconciled = await loss(instance, "reconcile-spawn", { operationId });
    const chosenThread = await execution(instance, "get", {
      threadId: reconciled.threadId,
    });
    const replay = await loss(instance, "spawn", uncertainSpawnRequest);
    const taskEffects = await loss(instance, "effects", { operationId });
    const allToolEffects = (await providerTrace(instance)).filter(
      (entry) => entry.method === "t1/tool-result",
    );
    await recordGate(instance, "initial-workspace-identity", {
      verdict: "open",
      identities: {
        projectId: project.id,
        concurrentRawSpawnThreadIds: [left.id, right.id],
        environmentIds,
        taskOperationId: operationId,
        chosenTaskThreadId: reconciled.threadId,
        chosenTaskEnvironmentId: chosenThread.environmentId,
      },
      observed: {
        rawConcurrentSpawnCount: 2,
        threadStatuses: [leftReady.status, rightReady.status],
        distinctEnvironmentCount: new Set(environmentIds).size,
        concurrentProviderToolEffects: effects.length,
        hookObservations: observations,
        droppedSpawnResponse: droppedResponse,
        uncertainIntent,
        acceptedPublicMatch: acceptedMatch,
        reconciliation: reconciled,
        chosenThreadStatus: chosenThread.status,
        chosenThreadEnvironmentId: chosenThread.environmentId,
        idempotentReplay: replay,
        taskSpawnEffects: taskEffects,
        totalProviderToolEffects: allToolEffects.length,
      },
      limits: [
        "The two raw concurrent BB spawns made two threads and two environments and do not themselves identify one Ensemble task. A separate T3-style SQLite intent reconciled one accepted spawn to one BB thread/environment after a dropped response and restart; this test fixture does not create the production Ensemble task-to-environment binding.",
      ],
    });
    assert.match(droppedResponse, /T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u);
    assert.equal(uncertainIntent.state, "uncertain");
    assert.equal(uncertainIntent.spawnCalls, 1);
    assert.equal(reconciled.state, "confirmed");
    assert.equal(reconciled.matches.length, 1);
    assert.equal(reconciled.threadId, acceptedMatch.threadId);
    assert.equal(typeof chosenThread.environmentId, "string");
    assert.equal(replay.replayed, true);
    assert.equal(replay.spawnCalls, 1);
    assert.deepEqual(
      taskEffects.map((effect) => effect.kind),
      ["spawn"],
    );
    assert.equal(allToolEffects.length, 3);
  });
});

test("T5 BB retry ownership remains observable across restart", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "retry");
    const thread = await spawnThread(
      instance,
      project,
      machine,
      "T5 retry fixture base turn",
    );
    const initial = await waitForIdle(
      instance,
      thread.id,
      "retry fixture initial turn idle",
    );
    const environmentId = initial.environmentId;
    const turns = [];
    const effectsByRetry = [];
    const retriedFailureIds = new Set();

    for (let retryNumber = 1; retryNumber <= 3; retryNumber += 1) {
      if (retryNumber > 1) {
        await restartBb(instance);
        const afterRestart = await execution(instance, "get", {
          threadId: thread.id,
        });
        assert.equal(afterRestart.status, "idle");
        assert.equal(afterRestart.environmentId, environmentId);
      }
      const queued = await execution(instance, "send", {
        threadId: thread.id,
        mode: "auto",
        sendAt: Date.now() + 24 * 60 * 60 * 1_000,
        input: [
          {
            type: "text",
            text: `T5_TASK=retry-work retry-round-${retryNumber} call_tool:capability_ping`,
          },
        ],
      });
      assert.equal(queued.delivery, "queued");
      const queuedMessage = queued.queuedMessage;
      assert(queuedMessage.id);
      await execution(instance, "arm-retry-failure", { threadId: thread.id });
      const released = await execution(instance, "queue-send", {
        threadId: thread.id,
        queuedMessageId: queuedMessage.id,
        mode: "auto",
      });
      assert.equal(released.delivery, "sent");
      const failed = await waitFor(async () => {
        const current = await execution(instance, "get", {
          threadId: thread.id,
        });
        return current.status === "error" ? current : false;
      }, `retry round ${retryNumber} failure`);
      const events = await execution(instance, "events", {
        threadId: thread.id,
      });
      const failure = [...events]
        .reverse()
        .find(
          (event) =>
            event.name === "turn.failed" &&
            event.data.attemptNumber === 1 &&
            event.data.requestId &&
            !retriedFailureIds.has(event.data.requestId),
        );
      assert(failure, `retry round ${retryNumber} has a public failed turn`);
      retriedFailureIds.add(failure.data.requestId);
      await execution(instance, "disarm-retry-failure", {
        threadId: thread.id,
      });
      const retry = await execution(instance, "retry", {
        threadId: thread.id,
        turnRequestId: failure.data.requestId,
        reason: `T5 retry round ${retryNumber}`,
      });
      assert.equal(retry.delivery, "sent");
      assert.equal(retry.attempt, 2);
      const recovered = await waitForIdle(
        instance,
        thread.id,
        `retry round ${retryNumber} recovered idle`,
      );
      assert.equal(recovered.environmentId, environmentId);
      turns.push({
        retryNumber,
        threadId: thread.id,
        environmentId: recovered.environmentId,
        failedStatus: failed.status,
        failedTurnRequestId: failure.data.requestId,
        failedAttempt: failure.data.attemptNumber,
        retryAttempt: retry.attempt,
        retryDelivery: retry.delivery,
      });
      const toolEffects = (await providerTrace(instance)).filter(
        (entry) => entry.method === "t1/tool-result",
      );
      effectsByRetry.push(toolEffects.length);
      assert.equal(toolEffects.length, retryNumber);
    }

    await recordGate(instance, "retry-ownership", {
      verdict: "open",
      identities: { projectId: project.id, threadId: thread.id, environmentId },
      observed: {
        failedAndRetriedTurns: turns,
        cumulativeToolEffectsAfterEachRetry: effectsByRetry,
        retryCountAcrossRestarts: turns.length,
        providerTurnStarts: (await providerTrace(instance)).filter(
          (entry) =>
            entry.method === "turn/start" &&
            entry.params.threadId === thread.id,
        ).length,
      },
      limits: [
        "BB records per-turn retry attempts and survives restart; the fixture has no Ensemble logical work revision or shared retry counter, so it cannot prove the two-retry ceiling across BB and Ensemble mechanisms.",
      ],
    });
  });
});

test("T5 dynamic instruction revisions are observed on a settled conversation", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "revision");
    await pluginRpc(instance, fixturePluginId, "recovery.run", {
      operation: "set-instructions",
      instructions: "T5_INSTRUCTIONS_REV=one",
    });
    const thread = await spawnThread(
      instance,
      project,
      machine,
      "T5_TASK=revision initial turn",
    );
    await waitForIdle(instance, thread.id, "revision initial turn idle");
    const firstTrace = await providerTrace(instance);
    const hasRevisionOne = firstTrace.some((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=one"),
    );

    await pluginRpc(instance, fixturePluginId, "recovery.run", {
      operation: "set-instructions",
      instructions: "T5_INSTRUCTIONS_REV=two",
    });
    const ordinarySend = await execution(instance, "send", {
      threadId: thread.id,
      mode: "auto",
      input: [{ type: "text", text: "T5_TASK=revision ordinary next turn" }],
    });
    assert.equal(ordinarySend.delivery, "sent");
    const ordinaryIdle = await waitForIdle(
      instance,
      thread.id,
      "revision ordinary next turn idle",
    );
    const ordinaryTrace = await providerTrace(instance);
    const providerInputText = (entry) =>
      Array.isArray(entry.params?.input)
        ? entry.params.input
            .map((block) => (typeof block?.text === "string" ? block.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
    const ordinaryNextTurnRequests = ordinaryTrace.filter((entry) =>
      providerInputText(entry).includes("T5_TASK=revision ordinary next turn"),
    );
    const ordinaryHasRevisionTwo = ordinaryNextTurnRequests.some((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=two"),
    );

    const settledStop = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "stop", threadId: thread.id },
    );
    assert.equal(settledStop.stopResponse.ok, true);
    const explicitlyApplied = await execution(instance, "send", {
      threadId: thread.id,
      mode: "auto",
      input: [
        { type: "text", text: "T5_TASK=revision explicit apply next turn" },
      ],
    });
    assert.equal(explicitlyApplied.delivery, "sent");
    const finalIdle = await waitForIdle(
      instance,
      thread.id,
      "revision explicit apply next turn idle",
    );
    const finalTrace = await providerTrace(instance);
    const explicitNextTurnRequests = finalTrace.filter((entry) =>
      providerInputText(entry).includes(
        "T5_TASK=revision explicit apply next turn",
      ),
    );
    const hasRevisionTwoAfterStop = explicitNextTurnRequests.some((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=two"),
    );
    const revisionOneEntries = firstTrace.filter((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=one"),
    );
    const revisionTwoEntries = finalTrace.filter((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=two"),
    );
    const instructionProviderTrace = finalTrace
      .filter((entry) => {
        const serialized = JSON.stringify(entry.params);
        return (
          serialized.includes("T5_INSTRUCTIONS_REV=one") ||
          serialized.includes("T5_INSTRUCTIONS_REV=two")
        );
      })
      .map((entry) => ({
        method: entry.method,
        threadId: entry.params?.threadId,
        inputText: providerInputText(entry),
        revision: JSON.stringify(entry.params).includes(
          "T5_INSTRUCTIONS_REV=one",
        )
          ? "one"
          : "two",
      }));
    await recordGate(instance, "revision-application", {
      verdict: "open",
      identities: {
        projectId: project.id,
        threadId: thread.id,
        environmentId: finalIdle.environmentId,
      },
      observed: {
        revisionOneReachedProvider: hasRevisionOne,
        revisionOneRequests: revisionOneEntries.length,
        ordinaryNextTurnStatus: ordinaryIdle.status,
        revisionTwoVisibleBeforeExplicitStop: ordinaryHasRevisionTwo,
        stopConfirmed: settledStop.stopResponse.ok,
        revisionTwoVisibleAfterStopAndNextTurn: hasRevisionTwoAfterStop,
        revisionTwoRequests: revisionTwoEntries.length,
        ordinaryNextTurnProviderRequests: ordinaryNextTurnRequests.map(
          (entry) => ({
            method: entry.method,
            threadId: entry.params?.threadId,
            inputText: providerInputText(entry),
            hasRevisionTwo: JSON.stringify(entry.params).includes(
              "T5_INSTRUCTIONS_REV=two",
            ),
          }),
        ),
        explicitNextTurnProviderRequests: explicitNextTurnRequests.map(
          (entry) => ({
            method: entry.method,
            threadId: entry.params?.threadId,
            inputText: providerInputText(entry),
            hasRevisionTwo: JSON.stringify(entry.params).includes(
              "T5_INSTRUCTIONS_REV=two",
            ),
          }),
        ),
        instructionProviderTrace,
        providerTraceMethods: finalTrace
          .filter((entry) => entry.params?.threadId === thread.id)
          .map((entry) => entry.method),
      },
      limits: [
        "The fixture changes a global dynamic instruction contribution, not an immutable task assignment snapshot; the evidence cannot prove operator authorization or same-assignment revision policy.",
      ],
    });
  });
});

test("T5 shared worktree remains while another live thread retains it", async () => {
  await withFixture(async (instance) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "retention");
    const first = await spawnThread(
      instance,
      project,
      machine,
      "T5 A17 first shared-worktree thread call_tool:capability_ping",
    );
    const firstIdle = await waitForIdle(
      instance,
      first.id,
      "first shared-worktree thread idle",
    );
    const environmentId = firstIdle.environmentId;
    const second = await spawnThread(
      instance,
      project,
      machine,
      "T5 A17 second shared-worktree thread call_tool:capability_ping",
      { type: "reuse", environmentId },
    );
    const secondIdle = await waitForIdle(
      instance,
      second.id,
      "second shared-worktree thread idle",
    );
    assert.equal(secondIdle.environmentId, environmentId);
    const envRecord = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      {
        operation: "environment-by-id",
        environmentId,
      },
    );
    assert.equal(envRecord.environment.id, environmentId);
    assert.equal(typeof envRecord.environment.path, "string");
    const workspacePath = envRecord.environment.path;
    assert(
      path.resolve(workspacePath).startsWith(path.resolve(instance.root)),
      "The managed worktree must remain inside the disposable T1 BB home",
    );
    const markerPath = path.join(workspacePath, "T5-A17-retention.txt");
    await writeFile(markerPath, "Retain while second thread is live.\n");

    let firstArchive;
    try {
      firstArchive = await pluginRpc(
        instance,
        fixturePluginId,
        "recovery.run",
        { operation: "archive", threadId: first.id },
      );
    } catch (error) {
      firstArchive = { error: String(error) };
    }
    const environmentAfterArchive = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "environment-by-id", environmentId },
    ).catch((error) => ({ error: String(error) }));
    const markerAfterArchive = await fileExists(markerPath);
    const secondAfterArchive = await execution(instance, "get", {
      threadId: second.id,
    }).catch((error) => ({ error: String(error) }));

    const firstDeletion = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "delete", threadId: first.id },
    ).catch((error) => ({ error: String(error) }));
    const environmentWhileShared = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "environment-by-id", environmentId },
    ).catch((error) => ({ error: String(error) }));
    const markerRetained = await fileExists(markerPath);
    const environmentRetainedAfterArchive =
      environmentAfterArchive.environment?.id === environmentId &&
      markerAfterArchive &&
      secondAfterArchive.environmentId === environmentId;
    const environmentSharedAfterArchiveAndDelete =
      environmentWhileShared.environment?.id === environmentId &&
      markerAfterArchive &&
      markerRetained &&
      secondAfterArchive.environmentId === environmentId;
    const remainingLiveThread = await execution(instance, "get", {
      threadId: second.id,
    }).catch((error) => ({ error: String(error) }));

    const lastDeletion = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "delete", threadId: second.id },
    ).catch((error) => ({ error: String(error) }));
    const environmentAfterLastDelete = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "environment-by-id", environmentId },
    ).catch((error) => ({ error: String(error) }));
    const markerExistsAfterLastDelete = await fileExists(markerPath);
    const retentionPassed =
      firstDeletion.ok === true &&
      lastDeletion.ok === true &&
      environmentRetainedAfterArchive &&
      environmentSharedAfterArchiveAndDelete &&
      secondAfterArchive.status === "idle" &&
      remainingLiveThread.status === "idle" &&
      remainingLiveThread.environmentId === environmentId;
    const finalReport = {
      verdict: retentionPassed ? "open" : "fail",
      identities: {
        projectId: project.id,
        threadIds: [first.id, second.id],
        environmentId,
        workspacePath,
      },
      observed: {
        statusesBeforeCleanup: [firstIdle.status, secondIdle.status],
        firstThreadArchive: firstArchive,
        environmentAfterArchive: environmentAfterArchive.environment,
        markerRetainedAfterArchive: markerAfterArchive,
        environmentRetainedAfterArchive,
        secondThreadAfterArchive: secondAfterArchive,
        firstThreadDelete: firstDeletion,
        sharedEnvironmentAfterFirstDelete:
          environmentWhileShared.environment ?? environmentWhileShared.error,
        markerRetainedAfterDelete: markerRetained,
        sharedRetentionAfterArchiveAndDelete:
          environmentSharedAfterArchiveAndDelete,
        remainingLiveThread,
        markerRetainedWhileShared: markerRetained,
        secondThreadDelete: lastDeletion,
        environmentAfterLastDelete:
          environmentAfterLastDelete.environment ??
          environmentAfterLastDelete.error,
        markerExistsAfterLastDelete,
        providerToolEffects: (await providerTrace(instance)).filter(
          (entry) => entry.method === "t1/tool-result",
        ).length,
      },
      limits: [
        "Direct BB archive and delete were exercised for this fixture provider; this does not establish Ensemble cleanup modes, preservation checks, or delivery confirmation.",
      ],
    };
    await recordGate(instance, "a17-shared-worktree-retention", finalReport);
    assert.equal(firstDeletion.ok, true, JSON.stringify(firstDeletion));
    assert.equal(lastDeletion.ok, true, JSON.stringify(lastDeletion));
    assert.equal(retentionPassed, true);
    assert.equal(remainingLiveThread.status, "idle");
    assert.equal(remainingLiveThread.environmentId, environmentId);
  });
});
