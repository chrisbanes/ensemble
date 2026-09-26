import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  bbCli,
  fixtureGit,
  pluginRpc,
  restartBb,
  rpc,
  waitFor,
  withFixture,
} from "./harness.mjs";

const fixturePluginId = "ensemble-t1-fixture";
const gatePluginId = "t4-dispatch-gate";
const waitPluginId = "t4-other-wait";

async function installFixturePlugin(
  instance,
  packageName,
  sourceName,
  minimumSdk = ">=0.5.9",
) {
  const directory = path.join(instance.root, packageName);
  await mkdir(directory, { recursive: true });
  await copyFile(
    path.join(instance.fixtureDirectory, sourceName),
    path.join(directory, "server.ts"),
  );
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${packageName}`,
      version: "0.0.1",
      private: true,
      type: "module",
      engines: { node: ">=24 <25", bb: ">=0.43.4", bbPluginSdk: minimumSdk },
      dependencies: { "@get-bb/plugin-sdk": "0.5.29", zod: "4.6.5" },
      bb: {
        name: packageName,
        description: "Disposable T4 integration fixture",
        branding: { icon: "Workflow" },
        server: "./server.ts",
      },
    }),
  );
  await symlink(
    path.join(instance.fixtureDirectory, "node_modules"),
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
  return installed.plugin;
}

async function createProject(instance) {
  const machine = (await bbCli(instance, "machine", "list")).find(
    (candidate) => candidate.status === "connected",
  );
  assert(machine, "The isolated BB host is not connected");
  const projectRoot = path.join(instance.root, "t4-git-project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "README.md"), "T4 fixture\n");
  await fixtureGit(instance, ["init", "-b", "main", projectRoot]);
  await fixtureGit(instance, [
    "-C",
    projectRoot,
    "-c",
    "user.name=T4 Fixture",
    "-c",
    "user.email=t4-fixture@example.invalid",
    "add",
    "README.md",
  ]);
  await fixtureGit(instance, [
    "-C",
    projectRoot,
    "-c",
    "user.name=T4 Fixture",
    "-c",
    "user.email=t4-fixture@example.invalid",
    "commit",
    "-m",
    "T4 disposable project",
  ]);
  const project = await bbCli(
    instance,
    "project",
    "create",
    "--name",
    "T4 disposable project",
    "--root",
    projectRoot,
    "--machine",
    machine.id,
  );
  return { project, machine };
}

const dispatch = (instance, operation, args = {}) =>
  pluginRpc(instance, gatePluginId, "dispatch.run", { operation, args });
const execution = (instance, operation, args = {}) =>
  pluginRpc(instance, fixturePluginId, "execution.run", { operation, args });

async function toolCount(instance) {
  return (await rpc(instance, "snapshot")).state.toolCalls;
}

async function queueRows(instance, threadId) {
  return execution(instance, "queue-list", { threadId });
}

async function readFixtureRows(instance, query, ...parameters) {
  const database = new DatabaseSync(instance.env.T4_INTENTS_DB_PATH, {
    readOnly: true,
  });
  try {
    return database.prepare(query).all(...parameters);
  } finally {
    database.close();
  }
}

async function intent(instance, operationId) {
  return dispatch(instance, "intent", { operationId });
}

function record(instance, name, details) {
  instance.runtimeManifest.checks[name] = details;
}

function sendArgs(operationId, threadId, prompt, extra = {}) {
  return { operationId, threadId, prompt, ...extra };
}

test("public dispatch handoff records bounded holds and an open startup capability gate", async () => {
  await withFixture(async (instance) => {
    const waiter = await installFixturePlugin(
      instance,
      "t4-other-wait",
      "other-wait-server.ts",
    );
    assert.equal(waiter.id, waitPluginId);
    const gate = await installFixturePlugin(
      instance,
      "t4-dispatch-gate",
      "dispatch-server.ts",
    );
    assert.equal(gate.id, gatePluginId);
    const fixture = await bbCli(
      instance,
      "plugin",
      "install",
      `path:${instance.fixtureDirectory}`,
      "--yes",
    );
    assert.equal(fixture.plugin.id, fixturePluginId);
    assert.equal((await dispatch(instance, "state")).mode, "ready");
    const incompatible = await installFixturePlugin(
      instance,
      "t4-sdk-floor-probe",
      "other-wait-server.ts",
      ">=0.5.27",
    );
    assert.equal(incompatible.status, "incompatible");
    const hostSdkMatch = incompatible.statusDetail?.match(
      /^requires bb plugin SDK >=0\.5\.27, running SDK is (\d+\.\d+\.\d+)$/u,
    );
    assert(hostSdkMatch, "BB did not report its running plugin SDK version");
    assert.equal(hostSdkMatch[1], "0.5.9");
    record(instance, "t4PluginSdkCompatibility", {
      status: "passed",
      runtimeNode: process.versions.node,
      bbArtifact: instance.runtimeManifest.bb,
      installedPluginSdkPackage: instance.runtimeManifest.pluginSdk,
      bbHostPluginSdk: hostSdkMatch[1],
      incompatibleFixture: {
        id: incompatible.id,
        status: incompatible.status,
        statusDetail: incompatible.statusDetail,
      },
      compatibleFixtureResponded: true,
    });

    const { project, machine } = await createProject(instance);
    const workThread = await rpc(instance, "spawn", {
      projectId: project.id,
      hostId: machine.id,
    });
    const idle = await waitFor(async () => {
      const thread = await rpc(instance, "thread", { threadId: workThread.id });
      return thread.status === "idle" ? thread : false;
    }, "T4 work thread initial scripted tool turn");
    assert.equal(idle.id, workThread.id);

    const stopThread = await rpc(instance, "spawn", {
      projectId: project.id,
      hostId: machine.id,
    });
    await waitFor(async () => {
      const thread = await rpc(instance, "thread", { threadId: stopThread.id });
      return thread.status === "idle" ? thread : false;
    }, "T4 task-stop fixture thread initial turn");
    const held = await execution(instance, "send", {
      threadId: stopThread.id,
      mode: "auto",
      input: [{ type: "text", text: "hold_turn", mentions: [] }],
    });
    assert.equal(held.delivery, "sent");
    await waitFor(async () => {
      const thread = await rpc(instance, "thread", { threadId: stopThread.id });
      return thread.status === "active" ? thread : false;
    }, "scripted active turn before stop race");

    // An explicit file barrier holds the attempted send before BB admission.
    // Task stop and barrier release are then issued together while both the
    // external wait and the paused gate are installed.
    await writeFile(instance.env.T4_WAITER_ENABLED_PATH, "hold\n");
    await dispatch(instance, "set-mode", { mode: "paused" });
    const raceOperationId = "t4-stop-race-rejected-before-acceptance";
    const racePrompt = `${raceOperationId} call_tool:capability_ping`;
    await dispatch(
      instance,
      "stage",
      sendArgs(raceOperationId, stopThread.id, racePrompt),
    );
    const racedSend = dispatch(
      instance,
      "send",
      sendArgs(raceOperationId, stopThread.id, racePrompt, { barrier: true }),
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    await waitFor(async () => {
      const events = await readFixtureRows(
        instance,
        "SELECT name FROM t4_dispatch_events WHERE operation_id = ?",
        raceOperationId,
      );
      return events.some((event) => event.name === "send.barrier-entered")
        ? true
        : false;
    }, "explicit stop-race send barrier");
    const [stopped] = await Promise.all([
      execution(instance, "stop", { threadId: stopThread.id }),
      writeFile(instance.env.T4_BARRIER_PATH, "release\n"),
    ]);
    const stopThreadAfterRace = await rpc(instance, "thread", {
      threadId: stopThread.id,
    });
    assert.deepEqual(stopped, { ok: true });
    const raceSubmission = await racedSend;
    assert.equal(raceSubmission.ok, false);
    assert.match(raceSubmission.error.message, /T4 dispatch gate is paused/u);
    assert.equal(
      (await queueRows(instance, stopThread.id)).filter((row) =>
        row.content.some(
          (part) => part.type === "text" && part.text === racePrompt,
        ),
      ).length,
      0,
      "Paused gate admitted a submission racing with task stop",
    );
    const raceIntent = await intent(instance, raceOperationId);
    assert.equal(raceIntent.state, "pending");
    assert.equal(raceIntent.queuedMessageId, null);
    assert.equal(await toolCount(instance), 2);
    record(instance, "pauseAndTaskStopRace", {
      status: "passed",
      operationId: raceOperationId,
      stopReturnedOk: true,
      statusAfterStop: stopThreadAfterRace.status,
      submissionRejectedBy: "T4 dispatch gate is paused",
      queueRowsForPrompt: 0,
      toolCallsAfterRace: await toolCount(instance),
      barrier: "fixture-controlled file release",
      limitation:
        "The observed rejection came from the paused dispatch gate. This does not establish a separate task-stop submission guarantee.",
    });

    await rm(instance.env.T4_WAITER_ENABLED_PATH, { force: true });
    await dispatch(instance, "set-mode", { mode: "ready", recheck: true });

    // Lost caller result, then restart while BB still owns a row waiting on the
    // external plugin. The local T4 intent precedes the public send.
    const lostOperationId = "t4-lost-queued-send-response";
    const lostPrompt = `${lostOperationId} call_tool:capability_ping`;
    await writeFile(instance.env.T4_WAITER_ENABLED_PATH, "hold\n");
    await dispatch(
      instance,
      "stage",
      sendArgs(lostOperationId, workThread.id, lostPrompt),
    );
    await assert.rejects(
      dispatch(
        instance,
        "send",
        sendArgs(lostOperationId, workThread.id, lostPrompt, {
          dropCallerResponse: true,
        }),
      ),
      /T4_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    const beforeLostRestart = await intent(instance, lostOperationId);
    assert.equal(beforeLostRestart.state, "uncertain");
    assert.equal(beforeLostRestart.sendCalls, 1);
    const lostRows = await queueRows(instance, workThread.id);
    const lostRow = lostRows.find((row) =>
      row.content.some(
        (part) => part.type === "text" && part.text === lostPrompt,
      ),
    );
    assert(lostRow, "The accepted message is missing from BB's public queue");
    assert.equal(lostRow.waitingOn?.pluginId, waitPluginId);
    assert.equal(await toolCount(instance), 2);

    await dispatch(instance, "set-mode", { mode: "paused" });
    await writeFile(instance.env.T4_FAIL_WAITER_PATH, "fail on restart\n");
    await restartBb(instance);
    const firstRestartPlugins = (await bbCli(instance, "plugin", "list"))
      .plugins;
    assert.equal(
      firstRestartPlugins.find((plugin) => plugin.id === waitPluginId)?.status,
      "error",
    );
    assert.equal(
      firstRestartPlugins.find((plugin) => plugin.id === gatePluginId)?.status,
      "running",
    );
    const rowAfterRestart = (await queueRows(instance, workThread.id)).find(
      (row) => row.id === lostRow.id,
    );
    assert(
      rowAfterRestart,
      "Accepted queue row disappeared during external waiter failure",
    );
    assert.equal(await toolCount(instance), 2);
    const holdCheckStarted = Date.now();
    await dispatch(instance, "set-mode", { mode: "paused", recheck: true });
    const heldRows = await waitFor(
      async () => {
        const rows = await queueRows(instance, workThread.id);
        const row = rows.find((candidate) => candidate.id === lostRow.id);
        return row?.failureReason === "T4 dispatch gate is paused"
          ? rows
          : false;
      },
      "paused public hook to reject the orphaned queued row after restart",
      20_000,
    );
    const stillHeld = heldRows.find((row) => row.id === lostRow.id);
    assert(
      stillHeld,
      "BB dropped its queued row while the dispatch gate remained available",
    );
    assert.equal(stillHeld.failureReason, "T4 dispatch gate is paused");
    assert.equal(await toolCount(instance), 2);
    record(instance, "externalWaitOwnerFailureWithGateLoaded", {
      status: "passed",
      queueId: lostRow.id,
      failedWaiterStatus: "error",
      gateStatus: "running",
      gateMode: "paused",
      rowPresentAfterRestart: true,
      failureReason: stillHeld.failureReason,
      toolCallsBeforeRestart: 2,
      toolCallsWhileHeld: await toolCount(instance),
      publicRecheckScheduled: true,
      recheckToRejectedRowMs: Date.now() - holdCheckStarted,
    });

    const reconciled = await dispatch(instance, "reconcile", {
      operationId: lostOperationId,
    });
    assert.equal(reconciled.state, "queued");
    assert.equal(reconciled.queuedMessageId, lostRow.id);
    assert.equal(reconciled.queueMatches.length, 1);
    assert.equal(reconciled.timelineMatches.length, 0);
    assert.equal(
      reconciled.publicLookup,
      "threads.timeline + queuedMessages.list",
    );
    await dispatch(instance, "set-mode", { mode: "ready", recheck: true });
    await waitFor(async () => {
      return (await toolCount(instance)) === 3 ? true : false;
    }, "single explicit recovery of lost queued send");
    await waitFor(async () => {
      return (await queueRows(instance, workThread.id)).every(
        (row) => row.id !== lostRow.id,
      )
        ? true
        : false;
    }, "reconciled queue row to leave BB queue");
    const lostReplay = await dispatch(instance, "send", {
      ...sendArgs(lostOperationId, workThread.id, lostPrompt),
    });
    assert.equal(lostReplay.noBlindRetry, true);
    assert.equal(lostReplay.sendCalls, 1);
    assert.equal(await toolCount(instance), 3);
    record(instance, "lostQueuedSendRestartReconciliation", {
      status: "passed",
      operationId: lostOperationId,
      queueId: lostRow.id,
      responseDroppedAfterAcceptance: true,
      recoveredFromPublicQueue: true,
      resumedToolCalls: 1,
      sendAttempts: lostReplay.sendCalls,
      publicLookup: reconciled.publicLookup,
    });

    await rm(instance.env.T4_FAIL_WAITER_PATH, { force: true });
    await restartBb(instance);
    const restoredPlugins = (await bbCli(instance, "plugin", "list")).plugins;
    assert.equal(
      restoredPlugins.find((plugin) => plugin.id === waitPluginId)?.status,
      "running",
    );
    assert.equal(
      restoredPlugins.find((plugin) => plugin.id === gatePluginId)?.status,
      "running",
    );

    // Keep an Ensemble-owned unsent intent beside a second BB-accepted row.
    // When both hook owners fail startup, public BB recovery dispatches the
    // accepted row, while the independently persisted unsent intent remains
    // pending. This is recorded as a failed capability gate, not a safety pass.
    const unsentOperationId = "t4-local-unsent-survives-gate-failure";
    const unsentPrompt = `${unsentOperationId} call_tool:capability_ping`;
    await dispatch(
      instance,
      "stage",
      sendArgs(unsentOperationId, workThread.id, unsentPrompt),
    );
    const unsafeOperationId = "t4-accepted-row-no-gate-startup";
    const unsafePrompt = `${unsafeOperationId} call_tool:capability_ping`;
    await writeFile(instance.env.T4_WAITER_ENABLED_PATH, "hold\n");
    await dispatch(
      instance,
      "stage",
      sendArgs(unsafeOperationId, workThread.id, unsafePrompt),
    );
    const countBeforeUnsafeRestart = await toolCount(instance);
    const acceptedUnsafe = await dispatch(
      instance,
      "send",
      sendArgs(unsafeOperationId, workThread.id, unsafePrompt),
    );
    assert.equal(acceptedUnsafe.delivery, "queued");
    assert.equal(typeof acceptedUnsafe.queuedMessageId, "string");
    const unsafeQueueId = acceptedUnsafe.queuedMessageId;
    assert.equal(await toolCount(instance), countBeforeUnsafeRestart);
    await dispatch(instance, "set-mode", { mode: "paused" });
    await writeFile(instance.env.T4_FAIL_WAITER_PATH, "fail on restart\n");
    await writeFile(instance.env.T4_FAIL_GATE_PATH, "fail on restart\n");
    await restartBb(instance);

    const unavailablePlugins = (await bbCli(instance, "plugin", "list"))
      .plugins;
    const unavailableWaiter = unavailablePlugins.find(
      (plugin) => plugin.id === waitPluginId,
    );
    const unavailableGate = unavailablePlugins.find(
      (plugin) => plugin.id === gatePluginId,
    );
    assert.equal(unavailableWaiter?.status, "error");
    assert.equal(unavailableGate?.status, "error");
    const unsafeDispatch = await waitFor(async () => {
      const requests = (
        await readFile(instance.env.SCRIPTED_ECHO_RECORD_PATH, "utf8")
      )
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      return (
        requests.find(
          (entry) =>
            entry.method === "turn/start" &&
            entry.params.input.some((item) => item.text === unsafePrompt),
        ) ?? false
      );
    }, "accepted BB queue row to reach provider while both hook owners failed");
    const unsafeToolCount = await waitFor(async () => {
      const count = await toolCount(instance);
      return count === countBeforeUnsafeRestart + 1 ? count : false;
    }, "one tool effect from the accepted row released without either gate");
    const afterUnsafeQueue = await queueRows(instance, workThread.id);
    assert.equal(
      afterUnsafeQueue.some((row) => row.id === unsafeQueueId),
      false,
    );
    const unsafeTimeline = await rpc(instance, "timeline", {
      threadId: workThread.id,
    });
    assert.equal(
      unsafeTimeline.rows.filter(
        (row) => row.kind === "conversation" && row.text === unsafePrompt,
      ).length,
      1,
    );

    const persistedUnsent = await readFixtureRows(
      instance,
      `SELECT operation_id AS operationId, state, send_calls AS sendCalls,
         queued_message_id AS queuedMessageId
       FROM t4_dispatch_intents WHERE operation_id = ?`,
      unsentOperationId,
    );
    assert.equal(persistedUnsent.length, 1);
    assert.equal(persistedUnsent[0].state, "pending");
    assert.equal(persistedUnsent[0].sendCalls, 0);
    assert.equal(persistedUnsent[0].queuedMessageId, null);
    assert.equal(unsafeToolCount, countBeforeUnsafeRestart + 1);

    const providerTrace = (
      await readFile(instance.env.SCRIPTED_ECHO_RECORD_PATH, "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const unsafeProviderTurns = providerTrace.filter(
      (entry) =>
        entry.method === "turn/start" &&
        entry.params.input.some((item) => item.text === unsafePrompt),
    );
    const startupGate = {
      status: "failed",
      safety: false,
      capability:
        "accepted BB queued send remains held when both hook owners fail startup",
      queueId: unsafeQueueId,
      operationId: unsafeOperationId,
      providerObservedPrompt: unsafeDispatch.params.input.some(
        (item) => item.text === unsafePrompt,
      ),
      providerTurnCount: unsafeProviderTurns.length,
      providerTrace: unsafeProviderTurns.map((entry) => ({
        method: entry.method,
        prompt: entry.params.input
          .filter((item) => typeof item.text === "string")
          .map((item) => item.text),
      })),
      toolCallsBeforeRestart: countBeforeUnsafeRestart,
      toolCallsAfterRestart: unsafeToolCount,
      failedPluginStatuses: {
        [waitPluginId]: unavailableWaiter.status,
        [gatePluginId]: unavailableGate.status,
      },
      queueContainsAcceptedIdAfterDispatch: false,
      timelineMatches: 1,
      localUnsentIntent: persistedUnsent[0],
      phaseTrace: await readFixtureRows(
        instance,
        `SELECT name, payload FROM t4_dispatch_events
         WHERE operation_id = ? ORDER BY id`,
        unsafeOperationId,
      ),
      dependency: "#665 remains open; T06/T08 must remain blocked",
    };
    record(instance, "startupWithoutBothGateOwners", startupGate);
    instance.runtimeManifest.dependentExecutionBlocked = ["T06", "T08"];
    instance.runtimeManifest.t4CapabilityStatus = "failed-capability";
    instance.runtimeManifest.t4DependencyStatus = "open";

    assert.equal(
      unsafeProviderTurns.length,
      1,
      "The unsafe accepted prompt must be visible exactly once in provider trace",
    );
    record(instance, "t4DispatchHarness", {
      status: "failed-capability",
      diagnosticCompleted: true,
      rawTestOutcome: "fail",
      pinnedNode: process.versions.node,
      pinnedBb: instance.runtimeManifest.bb,
      pinnedPluginSdk: instance.runtimeManifest.pluginSdk,
      queueId: unsafeQueueId,
      providerToolCalls: unsafeToolCount,
      dependency: "#665",
    });

    assert.fail(
      `T4_CAPABILITY_FAILED: BB dispatched accepted queue ${unsafeQueueId} while both hook owners failed initialization; providerTurns=${unsafeProviderTurns.length}; toolCalls=${countBeforeUnsafeRestart}->${unsafeToolCount}; dependency=#665 (T06/T08 blocked)`,
    );
  });
});
