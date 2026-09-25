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
import { test as nodeTest } from "node:test";
import { bbCli, restartBb, rpc, waitFor, withFixture } from "./harness.mjs";

const exec = promisify(execFile);
const fixturePluginId = "ensemble-t1-fixture";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateReportsDirectory = process.env.ENSEMBLE_T5_GATE_REPORT_DIRECTORY
  ? path.resolve(process.env.ENSEMBLE_T5_GATE_REPORT_DIRECTORY)
  : path.join(
      repositoryRoot,
      "node_modules/.cache/ensemble-bb-integration/t5-gates",
      randomUUID(),
    );
let reportStoreInitialization;

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

async function initializeGateReportStore() {
  if (reportStoreInitialization === undefined) {
    reportStoreInitialization = (async () => {
      await mkdir(gateReportsDirectory, { recursive: true });
      await writeFile(path.join(gateReportsDirectory, "reports.jsonl"), "");
    })();
  }
  await reportStoreInitialization;
}

async function writeGateReport(report) {
  await initializeGateReportStore();
  const reportPath = path.join(gateReportsDirectory, `${report.name}.json`);
  const reportLine = `${JSON.stringify(report)}\n`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await appendFile(
    path.join(gateReportsDirectory, "reports.jsonl"),
    reportLine,
  );
  process.stdout.write(`T5_GATE_PATH ${reportPath}\n`);
  process.stdout.write(`T5_GATE ${reportLine}`);
}

async function runGate(name, run) {
  const evidence = {
    stage: "test started",
    identities: {},
    observed: {},
    limits: [],
  };
  const capture = (update) => {
    if (update.stage !== undefined) evidence.stage = update.stage;
    if (update.identities !== undefined) {
      Object.assign(evidence.identities, update.identities);
    }
    if (update.observed !== undefined) {
      Object.assign(evidence.observed, update.observed);
    }
    if (update.limits !== undefined) evidence.limits = update.limits;
  };

  let report;
  try {
    report = await run(capture);
    if (
      !report ||
      !["pass", "fail", "open", "failed-capability"].includes(report.verdict)
    ) {
      throw new Error(`T5 case ${name} returned no valid gate verdict`);
    }
  } catch (error) {
    const failure = {
      stage: evidence.stage,
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
      ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
    };
    const limits = [
      ...evidence.limits,
      `Evidence capture ended at stage '${evidence.stage}'; later runtime identities, statuses, and effects were unavailable after this failure.`,
    ];
    try {
      await writeGateReport({
        name,
        verdict: "fail",
        identities: evidence.identities,
        observed: evidence.observed,
        failure,
        limits,
      });
    } catch (reportError) {
      if (error && typeof error === "object") {
        error.reportWriteError = String(reportError);
      }
    }
    throw error;
  }

  await writeGateReport({ name, ...report });
}

function gateTest(name, title, callback) {
  return nodeTest(title, () =>
    runGate(name, (capture) =>
      withFixture((instance) => callback(instance, capture)),
    ),
  );
}

gateTest(
  "composed-writer-admission",
  "T5 composed writer admission records the second-plugin wait without claiming a safe reservation",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const guardId = await installWaitGuard(instance);
    const { project, machine } = await createProject(instance, "admission");
    capture({
      stage: "isolated project and second-plugin wait guard ready",
      identities: { projectId: project.id, guardPluginId: guardId },
    });
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
    capture({
      stage: "writer thread spawned",
      identities: { threadId: spawned.id },
    });
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
    capture({
      stage: "writer held by second-plugin dispatch wait",
      identities: { queuedMessageId: queued.id },
      observed: {
        threadStatus: thread.status,
        hookObservations: observations,
      },
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].threadId, spawned.id);
    assert.equal(observations[0].environmentId, null);
    assert.equal(thread.status, "pending");
    const effectsBeforeRelease = (await providerTrace(instance)).filter(
      (entry) => entry.method === "t1/tool-result",
    );
    capture({
      stage: "provider trace captured before wait release",
      observed: { preReleaseProviderEffects: effectsBeforeRelease.length },
    });
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
    capture({
      stage: "provider trace captured after wait release",
      identities: { environmentId: completed.environmentId },
      observed: { postReleaseToolEffects: toolEffects.length },
    });
    assert.equal(toolEffects.length, 1);
    assert.equal(toolEffects[0].params.toolName, "capability_ping");
    return {
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
    };
  },
);

gateTest(
  "stop-writer-release",
  "T5 stop confirms active and delayed-start observations before release",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "stop");
    capture({
      stage: "isolated stop project ready",
      identities: { projectId: project.id },
    });

    const active = await spawnThread(
      instance,
      project,
      machine,
      "T5_TASK=active-stop hold_turn",
    );
    const running = await waitFor(async () => {
      const thread = await execution(instance, "get", {
        threadId: active.id,
      });
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
    capture({
      stage: "active provider turn and workspace observed before stop",
      identities: {
        activeThreadId: active.id,
        activeEnvironmentId: running.environmentId,
      },
      observed: {
        activeStatusBeforeStop: running.status,
        activeEnvironmentStatus: activeEnvironment.environment.status,
        activeWorkspacePath: activeEnvironment.environment.path,
      },
    });

    const activeStop = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "stop", threadId: active.id },
    );
    assert.equal(activeStop.stopResponse.ok, true);
    const stoppedActive = await waitFor(async () => {
      const thread = await execution(instance, "get", {
        threadId: active.id,
      });
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
    capture({
      stage: "active stop confirmed and provider trace captured",
      observed: {
        activeStatusAfterStop: stoppedActive.status,
        activeProviderStopRequests: activeStopRequests.length,
        activeToolEffects: activeEffects.length,
      },
    });

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
    capture({
      stage: "delayed-start writer held in the plugin queue",
      identities: {
        delayedThreadId: delayed.id,
        delayedQueuedMessageId: delayedQueued.id,
      },
      observed: { delayedStatusBeforeStop: delayedBeforeStop.status },
    });
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
    capture({
      stage: "delayed stop disposition observed before any release",
      observed: {
        delayedStatusAfterStop: delayedAfterStop.status,
        delayedStopConfirmed,
        delayedProviderTurnStartsBeforeRelease:
          delayedStartsBeforeRelease.length,
        delayedProviderToolEffectsBeforeRelease: effectsBeforeRelease.length,
        delayedQueueAfterStopBeforeRelease: preReleaseQueue,
        delayedHookObservations: preReleaseObservations,
      },
    });
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
    const unexpectedExecution =
      delayedStartsBeforeRelease.length > 0 ||
      effectsBeforeRelease.length > 0 ||
      delayedStartsAfterRelease.length > 0 ||
      effectsAfterRelease.length > effectsBeforeRelease.length;
    const report = {
      verdict: unexpectedExecution
        ? "fail"
        : delayedStopConfirmed
          ? "open"
          : "failed-capability",
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
        activeStopResponse: activeStop.stopResponse,
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
        "The fixture observes BB's scripted provider and a plugin-held delayed start only; it does not implement an Ensemble writer reservation or enumerate arbitrary surviving workspace processes.",
        ...(delayedStopConfirmed
          ? []
          : [
              "BB returned ok for the delayed stop but left the thread pending, so the fixture withheld recheck and could not establish safe writer release.",
            ]),
      ],
    };
    capture({
      stage: "stop and release traces collected before safety assertions",
      observed: {
        delayedStopConfirmed,
        releaseAttempted,
        releaseWithheldReason: report.observed.releaseWithheldReason,
        delayedProviderTurnStartsAfterRelease: delayedStartsAfterRelease.length,
        delayedProviderToolEffectsAfterRelease:
          effectsAfterRelease.length - effectsBeforeRelease.length,
        releaseEvidence: report.observed.releaseEvidence,
      },
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
    return report;
  },
);

gateTest(
  "initial-workspace-identity",
  "T5 competing task workspace attempts reconcile to one BB environment",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "workspace");
    capture({
      stage: "isolated workspace project ready",
      identities: { projectId: project.id },
    });

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
    const rawEnvironmentIds = [
      leftReady.environmentId,
      rightReady.environmentId,
    ];
    const rawDistinctEnvironmentCount = new Set(rawEnvironmentIds).size;
    assert.equal(
      rawDistinctEnvironmentCount,
      2,
      "two unrelated raw BB spawns should retain their distinct environments",
    );
    const rawTrace = await providerTrace(instance);
    const rawEffects = rawTrace.filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(rawEffects.length, 2);
    const rawObservations = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "observations", taskId: "initial-workspace" },
    );
    assert.equal(rawObservations.length, 2);
    assert.deepEqual(
      rawObservations.map((entry) => entry.threadId).sort(),
      [left.id, right.id].sort(),
    );
    capture({
      stage: "independent raw BB spawns each retain a distinct environment",
      identities: {
        rawThreadIds: [left.id, right.id],
        rawEnvironmentIds,
      },
      observed: {
        rawSpawnCount: 2,
        rawDistinctEnvironmentCount,
        rawThreadStatuses: [leftReady.status, rightReady.status],
        rawProviderToolEffects: rawEffects.length,
        rawHookObservations: rawObservations,
      },
    });

    const operationId = `t5-workspace-${randomUUID()}`;
    const taskId = `initial-workspace-${randomUUID().replaceAll("-", "")}`;
    const taskPrompt = `T5_TASK=${taskId} call_tool:capability_ping`;
    const environment = {
      type: "host",
      hostId: machine.id,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    };
    const operation = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      {
        operation: "workspace-prepare",
        operationId,
        taskId,
        projectId: project.id,
        hostId: machine.id,
        prompt: taskPrompt,
        environment,
      },
    );
    assert.equal(operation.state, "pending");
    capture({
      stage: "test-local SQLite workspace operation prepared",
      identities: { taskId, taskOperationId: operationId },
      observed: { taskOperationState: operation.state },
    });

    const competingAttemptIds = [
      `attempt-a-${randomUUID()}`,
      `attempt-b-${randomUUID()}`,
    ];
    const competingAttempts = await Promise.allSettled(
      competingAttemptIds.map((attemptId) =>
        pluginRpc(instance, fixturePluginId, "recovery.run", {
          operation: "workspace-attempt",
          operationId,
          attemptId,
        }),
      ),
    );
    const droppedAttempt = competingAttempts.find(
      (result) => result.status === "rejected",
    );
    const joinedAttempt = competingAttempts.find(
      (result) => result.status === "fulfilled",
    );
    assert(droppedAttempt && droppedAttempt.status === "rejected");
    assert.match(
      String(droppedAttempt.reason),
      /T5_WORKSPACE_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    assert(joinedAttempt && joinedAttempt.status === "fulfilled");
    assert.equal(joinedAttempt.value.disposition, "joined");
    assert.equal(joinedAttempt.value.spawnCalls, 1);
    capture({
      stage: "two competing SQLite attempts resulted in one accepted spawn",
      observed: {
        competingAttemptIds,
        droppedAttemptError: String(droppedAttempt.reason),
        joinedAttempt: joinedAttempt.value,
      },
    });

    const publicReconciliationAttempts = [];
    const acceptedMatch = await waitFor(async () => {
      const result = await pluginRpc(
        instance,
        fixturePluginId,
        "recovery.run",
        { operation: "workspace-reconcile", operationId },
      );
      publicReconciliationAttempts.push({
        state: result.state,
        spawnCalls: result.spawnCalls,
        matches: result.matches,
        attempts: result.attempts,
      });
      capture({
        stage: "public reconciliation queried after dropped response",
        observed: {
          publicReconciliationCallCount: publicReconciliationAttempts.length,
          latestPublicReconciliation: publicReconciliationAttempts.at(-1),
        },
      });
      return result.matches.length === 1 && result.matches[0].status === "idle"
        ? result
        : false;
    }, "public reconciliation finds one settled thread after the dropped response");
    const acceptedCandidate = acceptedMatch.matches[0];
    assert(acceptedCandidate);
    assert.equal(acceptedCandidate.environmentStatus, "ready");
    await restartBb(instance);
    const reconciled = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "workspace-reconcile", operationId },
    );
    const chosen = reconciled.matches[0];
    const chosenThread = await execution(instance, "get", {
      threadId: chosen.threadId,
    });
    assert.equal(reconciled.state, "confirmed");
    assert.equal(reconciled.matches.length, 1);
    assert.equal(acceptedCandidate.threadId, chosen.threadId);
    assert.equal(acceptedCandidate.environmentId, chosen.environmentId);
    assert.equal(chosenThread.id, chosen.threadId);
    assert.equal(chosenThread.status, "idle");
    assert.equal(typeof chosen.threadId, "string");
    assert.equal(typeof chosen.environmentId, "string");
    assert.equal(chosen.environmentStatus, "ready");
    assert.equal(reconciled.spawnCalls, 1);
    assert.equal(reconciled.attempts.length, 2);
    assert.deepEqual(
      reconciled.attempts.map((attempt) => attempt.disposition).sort(),
      ["joined", "owner"],
    );
    assert.equal(
      reconciled.ownerAttemptId,
      reconciled.attempts.find((attempt) => attempt.disposition === "owner")
        .attemptId,
    );
    const taskObservations = await pluginRpc(
      instance,
      fixturePluginId,
      "recovery.run",
      { operation: "observations", taskId },
    );
    assert.equal(taskObservations.length, 1);
    assert.equal(taskObservations[0].threadId, chosen.threadId);
    const allToolEffects = (await providerTrace(instance)).filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(allToolEffects.length, 3);
    capture({
      stage: "restart recovery chose one public thread and environment",
      identities: {
        chosenTaskThreadId: chosen.threadId,
        chosenTaskEnvironmentId: chosen.environmentId,
      },
      observed: {
        acceptedReconciliationBeforeRestart: acceptedMatch,
        reconciliation: reconciled,
        taskHookObservations: taskObservations,
        totalProviderToolEffects: allToolEffects.length,
      },
    });

    return {
      verdict: "open",
      identities: {
        projectId: project.id,
        rawConcurrentSpawnThreadIds: [left.id, right.id],
        rawEnvironmentIds,
        taskId,
        taskOperationId: operationId,
        competingAttemptIds,
        chosenTaskThreadId: chosen.threadId,
        chosenTaskEnvironmentId: chosen.environmentId,
      },
      observed: {
        rawConcurrentSpawnCount: 2,
        rawDistinctEnvironmentCount,
        rawProviderToolEffects: rawEffects.length,
        rawHookObservations: rawObservations,
        droppedAttemptError: String(droppedAttempt.reason),
        joinedAttempt: joinedAttempt.value,
        acceptedReconciliationBeforeRestart: acceptedMatch,
        reconciliation: reconciled,
        taskHookObservations: taskObservations,
        totalProviderToolEffects: allToolEffects.length,
      },
      limits: [
        "Two separate raw BB spawns created two environments and do not establish one-task identity. A test-local SQLite operation arbitrated two competing attempts, simulated a dropped accepted response, then public BB thread/metadata reads reconciled exactly one task thread and environment after restart; this does not establish the production Ensemble task-to-environment binding or its concurrency policy.",
      ],
    };
  },
);

gateTest(
  "retry-ownership",
  "T5 BB retry ownership remains observable across restart",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "retry");
    capture({
      stage: "isolated retry project ready",
      identities: { projectId: project.id },
    });
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
    capture({
      stage: "retry thread and environment provisioned",
      identities: { threadId: thread.id, environmentId },
      observed: { initialStatus: initial.status },
    });
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
      capture({
        stage: `retry round ${retryNumber} recovered after failure`,
        observed: {
          failedAndRetriedTurns: [...turns],
          cumulativeToolEffectsAfterEachRetry: [...effectsByRetry],
        },
      });
    }

    return {
      verdict: "open",
      identities: {
        projectId: project.id,
        threadId: thread.id,
        environmentId,
      },
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
    };
  },
);

gateTest(
  "revision-application",
  "T5 dynamic instruction contribution reaches the provider on the next turn",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "revision");
    await pluginRpc(instance, fixturePluginId, "recovery.run", {
      operation: "set-instructions",
      instructions: "T5_INSTRUCTIONS_REV=one",
    });
    capture({
      stage: "initial dynamic instruction contribution configured",
      identities: { projectId: project.id },
    });
    const thread = await spawnThread(
      instance,
      project,
      machine,
      "T5_TASK=revision initial turn",
    );
    const initialIdle = await waitForIdle(
      instance,
      thread.id,
      "revision initial turn idle",
    );
    const firstTrace = await providerTrace(instance);
    const providerInputText = (entry) =>
      Array.isArray(entry.params?.input)
        ? entry.params.input
            .map((block) => (typeof block?.text === "string" ? block.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
    const providerRequestsFor = (trace, promptMarker) =>
      trace.filter(
        (entry) =>
          ["thread/start", "turn/start"].includes(entry.method) &&
          providerInputText(entry).includes(promptMarker),
      );
    const initialRequests = providerRequestsFor(
      firstTrace,
      "T5_TASK=revision initial turn",
    );
    const revisionOneRequests = initialRequests.filter((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=one"),
    );
    assert(initialRequests.length > 0, "initial prompt reached provider");
    assert(
      initialRequests.every((entry) => entry.params.threadId === thread.id),
    );
    assert(
      revisionOneRequests.length > 0,
      "revision one reached matching request",
    );
    capture({
      stage: "initial prompt and revision one matched provider requests",
      identities: {
        threadId: thread.id,
        environmentId: initialIdle.environmentId,
      },
      observed: {
        initialProviderRequests: initialRequests.map((entry) => ({
          method: entry.method,
          threadId: entry.params.threadId,
          hasRevisionOne: JSON.stringify(entry.params).includes(
            "T5_INSTRUCTIONS_REV=one",
          ),
        })),
      },
    });

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
    const ordinaryNextTurnRequests = providerRequestsFor(
      ordinaryTrace,
      "T5_TASK=revision ordinary next turn",
    );
    const revisionTwoRequests = ordinaryNextTurnRequests.filter((entry) =>
      JSON.stringify(entry.params).includes("T5_INSTRUCTIONS_REV=two"),
    );
    assert(
      ordinaryNextTurnRequests.length > 0,
      "ordinary next-turn prompt reached provider",
    );
    assert(
      ordinaryNextTurnRequests.every(
        (entry) => entry.params.threadId === thread.id,
      ),
      "ordinary next-turn requests match the observed thread",
    );
    assert(
      revisionTwoRequests.length > 0,
      "dynamic revision two reached the ordinary next-turn provider request",
    );
    const instructionProviderTrace = ordinaryTrace
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
    capture({
      stage:
        "dynamic revision two matched ordinary next-turn provider requests",
      observed: {
        ordinaryNextTurnStatus: ordinaryIdle.status,
        ordinaryNextTurnProviderRequests: ordinaryNextTurnRequests.map(
          (entry) => ({
            method: entry.method,
            threadId: entry.params.threadId,
            hasRevisionTwo: JSON.stringify(entry.params).includes(
              "T5_INSTRUCTIONS_REV=two",
            ),
          }),
        ),
        revisionTwoRequestCount: revisionTwoRequests.length,
        instructionProviderTrace,
      },
    });

    return {
      verdict: "open",
      identities: {
        projectId: project.id,
        threadId: thread.id,
        environmentId: ordinaryIdle.environmentId,
      },
      observed: {
        initialStatus: initialIdle.status,
        initialProviderRequestCount: initialRequests.length,
        revisionOneReachedMatchingProviderRequest:
          revisionOneRequests.length > 0,
        ordinaryNextTurnStatus: ordinaryIdle.status,
        ordinaryNextTurnProviderRequests: ordinaryNextTurnRequests.map(
          (entry) => ({
            method: entry.method,
            threadId: entry.params.threadId,
            hasRevisionTwo: JSON.stringify(entry.params).includes(
              "T5_INSTRUCTIONS_REV=two",
            ),
          }),
        ),
        revisionTwoReachedMatchingProviderRequest:
          revisionTwoRequests.length > 0,
        instructionProviderTrace,
      },
      limits: [
        "The fixture verifies a dynamic plugin instruction contribution on an ordinary next turn. It has no Ensemble operator-authorized apply operation or immutable task-assignment snapshot, so the revision-application policy remains open.",
      ],
    };
  },
);

gateTest(
  "a17-shared-worktree-retention",
  "T5 shared worktree remains while another live thread retains it",
  async (instance, capture) => {
    await installRecoveryFixture(instance);
    const { project, machine } = await createProject(instance, "retention");
    capture({
      stage: "isolated retention project ready",
      identities: { projectId: project.id },
    });
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
    capture({
      stage: "first thread provisioned shared-worktree environment",
      identities: { firstThreadId: first.id, environmentId },
      observed: { firstThreadStatus: firstIdle.status },
    });
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
    capture({
      stage: "second live thread shares the environment",
      identities: { secondThreadId: second.id },
      observed: { secondThreadStatus: secondIdle.status },
    });
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
    capture({
      stage: "shared workspace and retention marker observed",
      identities: { workspacePath },
      observed: { markerPath },
    });

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
    const firstThreadArchived =
      firstArchive.archiveResponse?.ok === true &&
      firstArchive.archiveResponse.archivedThreadIds?.includes(first.id) &&
      firstArchive.thread?.id === first.id &&
      typeof firstArchive.thread.archivedAt === "number";
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
    capture({
      stage: "first thread archive and delete retention observed",
      observed: {
        firstThreadArchive: firstArchive,
        firstThreadDelete: firstDeletion,
        sharedEnvironmentAfterArchiveAndDelete:
          environmentSharedAfterArchiveAndDelete,
        markerRetainedAfterArchive: markerAfterArchive,
        markerRetainedAfterDelete: markerRetained,
        secondThreadAfterArchive: secondAfterArchive,
      },
    });
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
      firstThreadArchived &&
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
        firstThreadArchived,
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
    assert.equal(firstDeletion.ok, true, JSON.stringify(firstDeletion));
    assert.equal(lastDeletion.ok, true, JSON.stringify(lastDeletion));
    assert.equal(retentionPassed, true);
    assert.equal(remainingLiveThread.status, "idle");
    assert.equal(remainingLiveThread.environmentId, environmentId);
    capture({
      stage: "A17 second-thread retention assertions passed",
      observed: {
        retentionPassed,
        remainingLiveThread,
        secondThreadDelete: lastDeletion,
        markerExistsAfterLastDelete,
      },
    });
    return finalReport;
  },
);
