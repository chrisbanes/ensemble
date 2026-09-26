import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveFixtureManifestPath } from "./harness.mjs";
import {
  REQUIRED_API_ROWS,
  REQUIRED_API_EVIDENCE,
  REQUIRED_PROOF_GATES,
  REQUIRED_T5_REPORTS,
  assertExpectedT4Failure,
  assertIntegrationReport,
  assertT5Reports,
  buildIntegrationReport,
  combineT2FixtureManifests,
  readIntegrationReport,
  serializeIntegrationReport,
  writeIntegrationReport,
} from "./report.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultFixtureManifestPath = process.env.ENSEMBLE_T1_RUN_MANIFEST_PATH
  ? path.resolve(process.env.ENSEMBLE_T1_RUN_MANIFEST_PATH)
  : path.join(
      repositoryRoot,
      "node_modules/.cache/ensemble-bb-integration/run-manifest.json",
    );

function evidenceValue(fieldPath) {
  const field = fieldPath.split(".").at(-1);
  if (fieldPath === "stop.response.ok") return true;
  if (fieldPath === "stop.statusAfterStop") return "idle";
  if (fieldPath === "stop.providerStopRequests") return 1;
  if (fieldPath === "stop.toolEffects") return 0;
  if (field === "effectCount") return 1;
  if (
    field === "providerToolEffectsAfterInvalidation" ||
    field === "unresolvedInteractionCount"
  ) {
    return 0;
  }
  if (field === "replayNoBlindRetry" || field === "publicQueueRowDeleted")
    return true;
  if (field === "threadIds") return ["thread-one", "thread-two"];
  if (field === "effectCounts") return [1, 1, 1];
  if (field === "queueEvents") {
    return ["message.queued", "message.dispatched", "message.cancelled"].map(
      (name) => ({
        name,
        messageId: `message-${name}`,
      }),
    );
  }
  if (field === "eventNames")
    return ["thread.created", "thread.active", "thread.idle"];
  if (field === "pendingInteractionEvents") return ["interaction-one"];
  return `observed-${field}`;
}

function sampleObserved(type, id) {
  if (type === "public-api" && id === "permission-environment-forwarding") {
    return { permissionEnvironmentMatrix: permissionEnvironmentMatrix() };
  }
  const observed = {};
  const evidencePaths =
    type === "public-api" ? (REQUIRED_API_EVIDENCE[id] ?? []) : [];
  for (const fieldPath of evidencePaths) {
    const parts = fieldPath.split(".");
    let target = observed;
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {};
      target = target[part];
    }
    target[parts.at(-1)] = evidenceValue(fieldPath);
  }
  if (type === "t5-scenario") {
    return {
      identities:
        id === "stop-writer-release"
          ? {
              delayedThreadId: "thread-delayed",
              delayedStopResponse: { ok: true },
              delayedQueuedMessageId: "queued-stop",
              delayedDeleteResponse: { ok: true },
            }
          : id === "composed-writer-admission"
            ? writerAdmissionIdentities()
            : id === "initial-workspace-identity"
              ? initialWorkspaceIdentities()
              : id === "a17-shared-worktree-retention"
                ? a17Identities()
                : { threadId: "thread-one" },
      observations:
        id === "stop-writer-release"
          ? stopWriterObserved()
          : id === "composed-writer-admission"
            ? writerAdmissionObserved()
            : id === "initial-workspace-identity"
              ? initialWorkspaceObserved()
              : id === "a17-shared-worktree-retention"
                ? a17Observed()
                : { status: "open" },
    };
  }
  return Object.keys(observed).length > 0
    ? observed
    : { threadId: "thread-test", effectCount: 1 };
}

function permissionEnvironmentMatrix() {
  const modes = ["accept-edits", "auto", "full"];
  const projectId = "project-permission";
  const environmentId = "environment-permission";
  const environment = {
    id: environmentId,
    projectId,
    hostId: "host-permission",
    path: "/fixture/worktree",
    status: "ready",
  };
  const requestedHostWorkspace = {
    type: "host",
    hostId: "host-permission",
    workspace: {
      type: "managed-worktree",
      baseBranch: { kind: "default" },
    },
  };
  const modeRequests = modes.map((permissionMode, index) => {
    const threadId = `thread-${permissionMode}`;
    const prompt = `T1 permission environment ${permissionMode}`;
    return {
      permissionMode,
      prompt,
      thread: { id: threadId, projectId, environmentId, status: "idle" },
      requestedEnvironment:
        index === 0 ? requestedHostWorkspace : { type: "reuse", environmentId },
      environment,
      providerTrace: [
        {
          method: "turn/start",
          params: {
            threadId,
            input: [{ text: prompt }],
            options: {
              model: "fixture-model",
              reasoningLevel: "medium",
              serviceTier: "default",
              permissionMode,
              envVars: {
                BB_PROJECT_ID: projectId,
                BB_ENVIRONMENT_ID: environmentId,
              },
            },
          },
        },
      ],
    };
  });
  return {
    providerId: "ensemble-scripted",
    advertisedModes: modes,
    requestedModes: modes,
    projectId,
    hostId: "host-permission",
    requestedHostWorkspace,
    environmentId,
    environment,
    modeRequests,
    limits: {
      providerRequestForwardingOnly: true,
      shellContainment: "not tested",
      ambientCredentialIsolation: "not tested",
      directBbApiBypass: "not tested",
    },
    unavailableEnvironment: {
      environmentId: "missing-environment",
      rejectedAtSpawn: true,
      threadId: null,
      status: "rejected-at-spawn",
      error: "HTTP 404: Environment not found",
      providerTrace: [],
    },
    environmentAfterRestart: environment,
    threadsAfterRestart: modeRequests.map(({ permissionMode, thread }) => ({
      permissionMode,
      threadId: thread.id,
      environmentId,
    })),
  };
}

function t2FixtureManifest(checks) {
  return {
    outcome: "passed",
    checks: {
      ...checks,
      ownedProcessCleanup: {
        pids: [100, 101],
        allExited: true,
        serverPortClosed: true,
        daemonPortClosed: true,
        forced: false,
      },
      disposableRootCleanup: { removed: true },
    },
  };
}

function t2FixtureManifests() {
  const execution = t2FixtureManifest({
    executionSpawn: { threadId: "execution-thread" },
    executionUnsupportedChoice: { threadId: "unsupported-thread" },
    executionRetry: { threadId: "retry-thread" },
    executionLifecycle: [{ name: "thread.created" }],
    executionInteraction: { threadId: "interaction-thread" },
    sharedEnvironmentAfterRestart: { environmentId: "shared-environment" },
  });
  const permissionEnvironment = t2FixtureManifest({
    permissionModeAdvertisementProbe: { providerId: "ensemble-scripted" },
    permissionEnvironmentMatrix: permissionEnvironmentMatrix(),
  });
  return { execution, permissionEnvironment };
}

function writerAdmissionIdentities() {
  return {
    projectId: "project-wait",
    threadId: "thread-wait",
    guardPluginId: "second-plugin",
    queuedMessageId: "queued-wait",
    environmentId: "environment-wait",
  };
}

function writerAdmissionObserved() {
  return {
    waitingOn: {
      kind: "plugin",
      pluginId: "second-plugin",
      reason: "T5 second-plugin wait",
    },
    preReleaseProviderEffects: 0,
    postReleaseToolEffects: 1,
    initialEnvironmentId: null,
  };
}

function initialWorkspaceIdentities() {
  return {
    projectId: "project-workspace",
    taskId: "task-workspace",
    taskOperationId: "operation-workspace",
    competingAttemptIds: ["attempt-owner", "attempt-joiner"],
    rawConcurrentSpawnThreadIds: ["raw-thread-a", "raw-thread-b"],
    rawEnvironmentIds: ["raw-environment-a", "raw-environment-b"],
    chosenTaskThreadId: "chosen-thread",
    chosenTaskEnvironmentId: "chosen-environment",
    missingEnvironmentId: "missing-task-environment",
  };
}

function initialWorkspaceObserved() {
  const identities = initialWorkspaceIdentities();
  const chosen = {
    threadId: identities.chosenTaskThreadId,
    environmentId: identities.chosenTaskEnvironmentId,
    status: "idle",
    environmentStatus: "ready",
  };
  const reconciliation = {
    operationId: identities.taskOperationId,
    taskId: identities.taskId,
    projectId: identities.projectId,
    state: "confirmed",
    ownerAttemptId: identities.competingAttemptIds[0],
    spawnCalls: 1,
    chosenThreadId: identities.chosenTaskThreadId,
    matches: [chosen],
    attempts: [
      { attemptId: identities.competingAttemptIds[0], disposition: "owner" },
      { attemptId: identities.competingAttemptIds[1], disposition: "joined" },
    ],
    publicLookup: "threads.list + getPluginMetadata + threads.get",
  };
  return {
    rawConcurrentSpawnCount: 2,
    rawDistinctEnvironmentCount: 2,
    rawTaskThreadEnvironmentIds: [chosen],
    rawHookObservations: identities.rawConcurrentSpawnThreadIds.map(
      (threadId) => ({
        taskId: identities.taskId,
        threadId,
        environmentId: null,
        threadStatus: "pending",
        attempt: "start-turn",
        queuedMessageIds: [],
      }),
    ),
    duplicateRawTaskEnvironments: [],
    rawProviderToolEffects: 2,
    joinedAttempt: {
      operationId: identities.taskOperationId,
      taskId: identities.taskId,
      attemptId: identities.competingAttemptIds[1],
      disposition: "joined",
      state: "provisioning",
      ownerAttemptId: identities.competingAttemptIds[0],
      spawnCalls: 1,
      chosenThreadId: null,
      replayed: false,
    },
    acceptedReconciliationBeforeRestart: reconciliation,
    reconciliation,
    taskHookObservations: [
      {
        taskId: identities.taskId,
        threadId: identities.chosenTaskThreadId,
        environmentId: null,
        threadStatus: "pending",
        attempt: "start-turn",
        queuedMessageIds: [],
      },
    ],
    totalProviderToolEffects: 3,
    missingEnvironment: {
      environmentId: identities.missingEnvironmentId,
      rejectedAtSpawn: true,
      threadId: null,
      status: "rejected-at-spawn",
      spawnError: "HTTP 404: Environment not found",
      threadEvents: [],
      providerTrace: [],
    },
  };
}

function a17Identities() {
  return {
    projectId: "project-a17",
    threadIds: ["thread-a17-first", "thread-a17-second"],
    environmentId: "environment-a17",
    workspacePath: "/fixture/dirty-worktree",
  };
}

function a17Observed() {
  const { threadIds, environmentId } = a17Identities();
  return {
    statusesBeforeCleanup: ["idle", "idle"],
    firstThreadArchive: {
      archiveResponse: { ok: true, archivedThreadIds: [threadIds[0]] },
      thread: { id: threadIds[0], environmentId },
    },
    firstThreadArchived: true,
    environmentAfterArchive: { id: environmentId, status: "ready" },
    markerRetainedAfterArchive: true,
    environmentRetainedAfterArchive: true,
    firstThreadDelete: { ok: true },
    sharedEnvironmentAfterFirstDelete: { id: environmentId, status: "ready" },
    markerRetainedAfterDelete: true,
    sharedRetentionAfterArchiveAndDelete: true,
    remainingLiveThread: { id: threadIds[1], environmentId, status: "idle" },
    finalThreadArchive: {
      archiveResponse: { ok: true, archivedThreadIds: [threadIds[1]] },
      thread: { id: threadIds[1], environmentId },
    },
    finalThreadArchived: true,
    environmentAfterFinalArchive: { id: environmentId, status: "ready" },
    markerExistsAfterFinalArchive: true,
    workspaceExistsAfterFinalArchive: true,
    markerRetainedWhileShared: true,
    secondThreadDelete: { ok: true },
    environmentAfterLastDelete: { id: environmentId, status: "destroyed" },
    markerExistsAfterLastDelete: false,
    workspaceExistsAfterLastDelete: false,
    retirementWindowMs: 420_000,
    retirementSampleIntervalMs: 15_000,
    retirementObservationCount: 2,
    retirementObservationWindowMs: 15_000,
    retirementObserved: true,
    retirementObservations: [
      {
        elapsedMs: 0,
        environmentId,
        environmentStatus: "ready",
        environmentRetired: false,
        workspaceExists: true,
        markerExists: true,
        retirementObserved: false,
      },
      {
        elapsedMs: 15_000,
        environmentId,
        environmentStatus: "destroyed",
        environmentRetired: true,
        workspaceExists: false,
        markerExists: false,
        retirementObserved: true,
      },
    ],
    providerToolEffects: 2,
  };
}

function stopWriterObserved() {
  return {
    delayedStatusBeforeStop: "pending",
    delayedStatusAfterStop: "pending",
    delayedStopConfirmed: false,
    delayedCancellationConfirmed: true,
    delayedCancellationEvent: {
      name: "message.cancelled",
      threadId: "thread-delayed",
      messageId: "queued-stop",
    },
    delayedQueueAfterStopBeforeRelease: [],
    delayedProviderTurnStartsBeforeRelease: 0,
    delayedProviderToolEffectsBeforeRelease: 0,
    releaseAttempted: true,
    releaseAttemptedAfterCancellationConfirmation: true,
    releaseEvidence: {
      threadId: "thread-delayed",
      status: "pending",
      queue: [],
      observationWindowMs: 2_000,
      stableNoStartMs: 2_000,
      stableNoStartWindowMs: 2_000,
    },
    delayedProviderTurnStartsAfterRelease: 0,
    delayedProviderToolEffectsAfterRelease: 0,
  };
}

function failedStopWriterObserved() {
  return {
    ...stopWriterObserved(),
    delayedCancellationConfirmed: false,
    delayedCancellationEvent: null,
    delayedQueueAfterStopBeforeRelease: [
      { id: "queued-stop", waitingOn: { kind: "plugin" } },
    ],
    releaseAttempted: false,
    releaseAttemptedAfterCancellationConfirmation: false,
    releaseEvidence: null,
  };
}

function validT5Reports() {
  return REQUIRED_T5_REPORTS.map((name) => ({
    name,
    verdict: "open",
    identities:
      name === "stop-writer-release"
        ? {
            delayedThreadId: "thread-delayed",
            delayedStopResponse: { ok: true },
            delayedQueuedMessageId: "queued-stop",
            delayedDeleteResponse: { ok: true },
          }
        : name === "composed-writer-admission"
          ? writerAdmissionIdentities()
          : name === "initial-workspace-identity"
            ? initialWorkspaceIdentities()
            : name === "a17-shared-worktree-retention"
              ? a17Identities()
              : { threadId: `thread-${name}` },
    observed:
      name === "stop-writer-release"
        ? stopWriterObserved()
        : name === "composed-writer-admission"
          ? writerAdmissionObserved()
          : name === "initial-workspace-identity"
            ? initialWorkspaceObserved()
            : name === "a17-shared-worktree-retention"
              ? a17Observed()
              : { status: "observed" },
    limits: ["Fixture evidence does not implement the product gate."],
  }));
}

function slice(id, testOutcome) {
  const t4Diagnostic = id === "T4";
  return {
    id,
    exitCode: t4Diagnostic ? 1 : testOutcome === "passed" ? 0 : 1,
    expectedExitCode: t4Diagnostic ? 1 : 0,
    timedOut: false,
    testOutcome,
    manifest: {
      outcome: t4Diagnostic ? "failed" : testOutcome,
      checks: {
        ownedProcessCleanup: {
          allExited: true,
          serverPortClosed: true,
          daemonPortClosed: true,
          forced: false,
        },
      },
    },
  };
}

function validSlices() {
  return {
    T1: slice("T1", "passed"),
    T2: slice("T2", "passed"),
    T3: slice("T3", "passed"),
    T4: slice("T4", "expected-diagnostic"),
    T5: slice("T5", "passed"),
  };
}

function stopWriterFailureReport() {
  const report = validReport();
  const scenario = report.rows.find(
    (entry) =>
      entry.type === "t5-scenario" && entry.id === "stop-writer-release",
  );
  scenario.verdict = "failed-capability";
  scenario.observed = {
    identities: {
      delayedThreadId: "thread-delayed",
      delayedStopResponse: { ok: true },
      delayedQueuedMessageId: "queued-stop",
      delayedDeleteResponse: { ok: false },
    },
    observations: failedStopWriterObserved(),
  };
  report.rows.find(
    (entry) =>
      entry.type === "proof-gate" && entry.id === "stop-writer-release",
  ).verdict = "failed-capability";
  const t5Stop = report.t5Reports.find(
    (entry) => entry.name === "stop-writer-release",
  );
  t5Stop.verdict = scenario.verdict;
  t5Stop.identities = scenario.observed.identities;
  t5Stop.observed = scenario.observed.observations;
  report.dependentExecutionBlocked = ["T02", "T06", "T08"];
  return report;
}

function row(type, id, overrides = {}) {
  return {
    type,
    id,
    ...(type === "public-api" ? { publicApi: id } : {}),
    scenario: `scenario for ${id}`,
    evidenceScope: "BB fixture observation",
    runtime: {
      bb: "0.44.0",
      hostSdk: "0.5.29",
      pluginSdk: "0.5.30",
      node: "24.21.0",
      playwright: "1.63.0",
    },
    sourceRevisions: {
      ensembleHead: "abc123",
      integrationSourceDigest: "digest-abc123",
      providerBridge: "fdd3de3b19b97e6cd1ef7300cbb54711431249d3",
      installedBbSource: null,
      providerBridgeSha256: "c".repeat(64),
      fixtureSourceSha256: {
        scriptedProvider: "d".repeat(64),
        executionRpc: "e".repeat(64),
        recoveryRpc: "f".repeat(64),
      },
    },
    packageArtifacts: {
      lockfileTarballIntegrity: {
        bbApp: "sha512-bb-integrity",
        pluginSdk: "sha512-sdk-integrity",
      },
      installedTreeSha256: {
        bbApp: "a".repeat(64),
        pluginSdk: "b".repeat(64),
      },
    },
    observed: sampleObserved(type, id),
    verdict: "passed",
    evidenceLimit: "Credential-free scripted fixture only.",
    ...overrides,
  };
}

function validReport() {
  const apiRows = REQUIRED_API_ROWS.map((id) => {
    const eventContract =
      id === "thread-status-events-restart"
        ? ["thread.created", "thread.active", "thread.idle"]
        : id === "queued-message-send-cancel"
          ? ["message.queued", "message.dispatched", "message.cancelled"]
          : undefined;
    return row("public-api", id, {
      ...(eventContract === undefined
        ? {}
        : { requiredEvents: eventContract, observedEvents: eventContract }),
      ...(id === "shared-worktree-retention" ? { verdict: "open" } : {}),
    });
  });
  return {
    schemaVersion: 2,
    sourceRevision: "abc123",
    integrationSourceDigest: "digest-abc123",
    outcome: "completed-with-capability-gaps",
    toolchain: { node: "24.21.0", npm: "12.1.0" },
    slices: {
      T5: {
        exitCode: 0,
        expectedExitCode: 0,
        timedOut: false,
        testOutcome: "passed",
        manifestAvailable: true,
        manifestOutcome: "passed",
        cleanupVerified: true,
      },
    },
    rows: [
      ...apiRows,
      ...REQUIRED_PROOF_GATES.map((id) =>
        row("proof-gate", id, {
          verdict:
            id === "startup-queued-dispatch"
              ? "failed-capability"
              : id === "message-acceptance-replay"
                ? "partial"
                : "open",
          evidenceLimit:
            id === "startup-queued-dispatch"
              ? "#665 is open and blocks T06/T08."
              : "Evidence limit remains open.",
        }),
      ),
      ...REQUIRED_T5_REPORTS.map((id) =>
        row("t5-scenario", id, { verdict: "open" }),
      ),
    ],
    t5Reports: validT5Reports(),
    proposedEnsembleContract: {
      evidenceScope: "proposed-Ensemble-contract",
      actionAuthorization: "dependent-future-acceptance",
      userInterface: "dependent-future-acceptance",
      permissionBoundary:
        "BB/provider request forwarding only; shell, ambient credentials and direct BB API bypass are not tested.",
      cleanupDecisionTable: [
        {
          mode: "default",
          delivery: "confirmed",
          preservedWork: "preserved",
          effects: "resolved",
          workspace: "present",
          decision: "retain-until-operator-archive",
        },
        {
          mode: "automatic",
          delivery: "confirmed",
          preservedWork: "preserved",
          effects: "resolved",
          workspace: "present",
          decision: "archive",
        },
        {
          mode: "automatic",
          delivery: "unknown",
          preservedWork: "preserved",
          effects: "resolved",
          workspace: "present",
          decision: "hold-cleanup",
        },
        {
          mode: "automatic",
          delivery: "confirmed",
          preservedWork: "unknown",
          effects: "resolved",
          workspace: "present",
          decision: "hold-cleanup",
        },
        {
          mode: "automatic",
          delivery: "confirmed",
          preservedWork: "preserved",
          effects: "unknown",
          workspace: "present",
          decision: "hold-cleanup",
        },
        {
          mode: "any",
          delivery: "any",
          preservedWork: "any",
          effects: "any",
          workspace: "missing-or-unknown",
          decision: "hold-cleanup-and-dispatch",
        },
      ],
    },
    dependentExecutionBlocked: ["T06", "T08"],
  };
}

function validT4Evidence() {
  return {
    exitCode: 1,
    timedOut: false,
    output:
      "not ok 1 - public dispatch handoff records bounded holds and an open startup capability gate\nT4_CAPABILITY_FAILED: BB dispatched accepted queue qmsg_test while both hook owners failed initialization; providerTurns=1; toolCalls=3->4; dependency=#665 (T06/T08 blocked)",
    manifest: {
      outcome: "failed",
      t4CapabilityStatus: "failed-capability",
      t4DependencyStatus: "open",
      dependentExecutionBlocked: ["T06", "T08"],
      checks: {
        t4PluginSdkCompatibility: {
          status: "passed",
          bbHostPluginSdk: "0.5.29",
          incompatibleFixture: {
            status: "incompatible",
            statusDetail:
              "requires bb plugin SDK >=0.6.0, running SDK is 0.5.29",
          },
          compatibleFixtureResponded: true,
        },
        ownedProcessCleanup: {
          allExited: true,
          serverPortClosed: true,
          daemonPortClosed: true,
          forced: false,
        },
        disposableRootCleanup: { removed: true },
        startupWithoutBothGateOwners: {
          status: "failed",
          safety: false,
          queueId: "qmsg_test",
          providerTurnCount: 1,
          toolCallsBeforeRestart: 3,
          toolCallsAfterRestart: 4,
          failedPluginStatuses: {
            "dispatch-gate": "error",
            "wait-guard": "error",
          },
          queueContainsAcceptedIdAfterDispatch: false,
          timelineMatches: 1,
          dependency: "#665 remains open; T06/T08 must remain blocked",
        },
        t4DispatchHarness: {
          status: "failed-capability",
          diagnosticCompleted: true,
          rawTestOutcome: "fail",
          dependency: "#665",
        },
      },
    },
  };
}

test("integration report requires one complete row per API and proof gate", () => {
  assert.doesNotThrow(() => assertIntegrationReport(validReport()));

  const missingGate = validReport();
  missingGate.rows = missingGate.rows.filter(
    (entry) => entry.id !== "startup-queued-dispatch",
  );
  assert.throws(() => assertIntegrationReport(missingGate), /proof-gate/u);
});

test("integration report requires a passed, verified T5 slice", () => {
  const missingSlice = validReport();
  delete missingSlice.slices.T5;
  missingSlice.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(missingSlice),
    /T5 slice must exit successfully/u,
  );

  const failedSlice = validReport();
  failedSlice.slices.T5.exitCode = 1;
  failedSlice.slices.T5.testOutcome = "failed";
  failedSlice.slices.T5.manifestOutcome = "failed";
  failedSlice.outcome = "failed-harness";
  failedSlice.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(failedSlice),
    /T5 slice must exit successfully/u,
  );

  const unverifiedSlice = validReport();
  unverifiedSlice.slices.T5.manifestAvailable = false;
  unverifiedSlice.slices.T5.cleanupVerified = false;
  unverifiedSlice.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(unverifiedSlice),
    /T5 slice must have a verified manifest/u,
  );
});

test("combined stop and retry row requires confirmed stop evidence", () => {
  const report = validReport();
  const row = report.rows.find((entry) => entry.id === "thread-stop-and-retry");
  row.observed.stop.statusAfterStop = "active";
  assert.throws(
    () => assertIntegrationReport(report),
    /post-stop thread status/u,
  );
});

test("report writer and reader round-trip deterministic JSON", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ensemble-report-test-"),
  );
  const file = path.join(directory, "report.json");
  const report = validReport();
  try {
    const expected = serializeIntegrationReport(report);
    await writeIntegrationReport(file, report);
    const first = await readIntegrationReport(file);
    assert.deepEqual(first, report);
    assert.equal(serializeIntegrationReport(first), expected);
    await writeIntegrationReport(file, first);
    assert.deepEqual(await readIntegrationReport(file), report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("integration report rejects incomplete runtime and source identity", () => {
  const report = validReport();
  report.rows[0].runtime.hostSdk = null;
  assert.throws(() => assertIntegrationReport(report), /hostSdk/u);

  report.rows[0].runtime.hostSdk = "0.5.29";
  report.rows[0].sourceRevisions.providerBridge = null;
  assert.throws(() => assertIntegrationReport(report), /providerBridge/u);

  report.rows[0].sourceRevisions.providerBridge = "bridge-revision";
  report.rows[0].sourceRevisions.integrationSourceDigest = null;
  assert.throws(
    () => assertIntegrationReport(report),
    /integrationSourceDigest/u,
  );
});

test("integration report requires installed package trees separately from lockfile integrity", () => {
  const report = validReport();
  const row = report.rows[0];
  assert.equal(
    row.packageArtifacts.lockfileTarballIntegrity.bbApp,
    "sha512-bb-integrity",
  );
  assert.equal(row.packageArtifacts.installedTreeSha256.bbApp, "a".repeat(64));

  row.packageArtifacts.installedTreeSha256.bbApp = null;
  assert.throws(
    () => assertIntegrationReport(report),
    /installedTreeSha256.bbApp/u,
  );

  row.packageArtifacts.installedTreeSha256.bbApp = "not-a-digest";
  assert.throws(() => assertIntegrationReport(report), /SHA-256 hex/u);

  row.packageArtifacts.installedTreeSha256.bbApp = "a".repeat(64);
  row.packageArtifacts.installedTreeSha256.pluginSdk = null;
  assert.throws(
    () => assertIntegrationReport(report),
    /installedTreeSha256.pluginSdk/u,
  );
});

test("integration report rejects duplicate API rows and empty evidence", () => {
  const report = validReport();
  report.rows[1].id = report.rows[0].id;
  assert.throws(() => assertIntegrationReport(report), /duplicate/u);

  report.rows[1].id = REQUIRED_API_ROWS[1];
  report.rows[1].observed = {};
  assert.throws(() => assertIntegrationReport(report), /observed/u);

  report.rows[1].id = REQUIRED_API_ROWS[1];
  report.rows[1].observed = { threadId: null, effectCount: null };
  assert.throws(
    () => assertIntegrationReport(report),
    /no observed identities/u,
  );
});

test("permission forwarding report requires every mode, matching IDs and no hidden start", () => {
  assert.doesNotThrow(() => assertIntegrationReport(validReport()));

  const missingMode = validReport();
  missingMode.rows.find(
    (entry) => entry.id === "permission-environment-forwarding",
  ).observed.permissionEnvironmentMatrix.modeRequests[1].permissionMode =
    "full";
  assert.throws(
    () => assertIntegrationReport(missingMode),
    /auto request is missing/u,
  );

  const missingId = validReport();
  delete missingId.rows.find(
    (entry) => entry.id === "permission-environment-forwarding",
  ).observed.permissionEnvironmentMatrix.modeRequests[0].thread.id;
  assert.throws(() => assertIntegrationReport(missingId), /thread ID/u);

  const hiddenStart = validReport();
  hiddenStart.rows
    .find((entry) => entry.id === "permission-environment-forwarding")
    .observed.permissionEnvironmentMatrix.unavailableEnvironment.providerTrace.push(
      { method: "turn/start", params: { threadId: "unexpected-thread" } },
    );
  assert.throws(
    () => assertIntegrationReport(hiddenStart),
    /zero provider starts/u,
  );
});

test("thread spawn report uses the permission matrix when execution spawn is absent", () => {
  const slices = validSlices();
  const matrix = permissionEnvironmentMatrix();
  slices.T2.manifest.checks.permissionEnvironmentMatrix = matrix;

  const report = buildIntegrationReport({
    ensembleHead: "abc123",
    sourceDigest: "digest-abc123",
    slices,
    t5Reports: validT5Reports(),
  });
  const spawnRow = report.rows.find(
    (entry) => entry.id === "thread-spawn-execution-options",
  );
  const acceptedEdits = matrix.modeRequests[0];

  assert.equal(spawnRow.observed.threadId, acceptedEdits.thread.id);
  assert.equal(spawnRow.observed.environmentId, acceptedEdits.environment.id);
  assert.deepEqual(
    spawnRow.observed.providerRequest,
    acceptedEdits.providerTrace[0],
  );
  assert.equal(spawnRow.verdict, "passed");
});

test("T2 combines the two validated fixture manifests and keeps their checks", () => {
  const { execution, permissionEnvironment } = t2FixtureManifests();

  const combined = combineT2FixtureManifests(execution, permissionEnvironment);

  assert.deepEqual(
    combined.checks.executionSpawn,
    execution.checks.executionSpawn,
  );
  assert.deepEqual(
    combined.checks.permissionEnvironmentMatrix,
    permissionEnvironment.checks.permissionEnvironmentMatrix,
  );
  assert.equal(combined.checks.ownedProcessCleanup.allExited, true);
  assert.deepEqual(
    combined.checks.ownedProcessCleanup.fixtureRuns.map((run) => run.name),
    ["execution", "permissionEnvironment"],
  );
  assert.deepEqual(combined.checks.disposableRootCleanup.fixtureRoots, {
    execution: true,
    permissionEnvironment: true,
  });
});

test("T2 aggregation rejects either missing fixture manifest", () => {
  const { execution, permissionEnvironment } = t2FixtureManifests();

  assert.throws(
    () => combineT2FixtureManifests(undefined, permissionEnvironment),
    /T2 execution fixture manifest is missing/u,
  );
  assert.throws(
    () => combineT2FixtureManifests(execution, undefined),
    /T2 permissionEnvironment fixture manifest is missing/u,
  );
});

test("T2 fixture manifest path keeps the fixture default without an override", () => {
  assert.equal(
    resolveFixtureManifestPath(undefined),
    defaultFixtureManifestPath,
  );
  assert.equal(resolveFixtureManifestPath(""), defaultFixtureManifestPath);
});

test("T2 fixture manifest path honors an explicit environment override", () => {
  const override = path.join(repositoryRoot, "direct-t2-run-manifest.json");
  assert.equal(resolveFixtureManifestPath(override), override);
});

test("report binds fixture and provider bridge hashes separately from package artifacts", () => {
  const report = validReport();
  const row = report.rows[0];
  assert.match(row.sourceRevisions.providerBridgeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(row.sourceRevisions.fixtureSourceSha256), [
    "scriptedProvider",
    "executionRpc",
    "recoveryRpc",
  ]);
  row.sourceRevisions.fixtureSourceSha256.recoveryRpc = null;
  assert.throws(
    () => assertIntegrationReport(report),
    /fixtureSourceSha256.recoveryRpc/u,
  );
});

test("workspace intent report rejects competing owners, duplicate matches and missing environment starts", () => {
  const duplicateOwner = validT5Reports();
  duplicateOwner.find(
    (entry) => entry.name === "initial-workspace-identity",
  ).observed.reconciliation.attempts[1].disposition = "owner";
  assert.throws(
    () => assertT5Reports(duplicateOwner),
    /one owner and one joined/u,
  );

  const duplicateMatch = validT5Reports();
  const reconciliation = duplicateMatch.find(
    (entry) => entry.name === "initial-workspace-identity",
  ).observed.reconciliation;
  reconciliation.matches.push({ ...reconciliation.matches[0] });
  assert.throws(
    () => assertT5Reports(duplicateMatch),
    /duplicate workspace matches/u,
  );

  const hiddenStart = validT5Reports();
  hiddenStart
    .find((entry) => entry.name === "initial-workspace-identity")
    .observed.missingEnvironment.providerTrace.push({ method: "turn/start" });
  assert.throws(
    () => assertT5Reports(hiddenStart),
    /must not start a provider/u,
  );
});

test("workspace reconciliation follows the observed owner in either input order", () => {
  for (const ownerIndex of [0, 1]) {
    const reports = validT5Reports();
    const row = reports.find(
      (entry) => entry.name === "initial-workspace-identity",
    );
    if (ownerIndex === 1) row.identities.competingAttemptIds.reverse();
    const ownerAttemptId = row.identities.competingAttemptIds[ownerIndex];
    const joinedAttemptId = row.identities.competingAttemptIds[1 - ownerIndex];
    const observed = row.observed;
    observed.joinedAttempt.ownerAttemptId = ownerAttemptId;
    observed.joinedAttempt.attemptId = joinedAttemptId;
    for (const label of [
      "acceptedReconciliationBeforeRestart",
      "reconciliation",
    ]) {
      const reconciliation = observed[label];
      reconciliation.ownerAttemptId = ownerAttemptId;
      reconciliation.attempts = row.identities.competingAttemptIds.map(
        (attemptId) => ({
          attemptId,
          disposition: attemptId === ownerAttemptId ? "owner" : "joined",
        }),
      );
      if (ownerIndex === 1) reconciliation.attempts.reverse();
    }
    assert.doesNotThrow(() => assertT5Reports(reports));
  }
});

test("workspace reconciliation rejects inconsistent owner and spawn observations", () => {
  const inconsistentOwner = validT5Reports();
  const row = inconsistentOwner.find(
    (entry) => entry.name === "initial-workspace-identity",
  );
  row.observed.reconciliation.ownerAttemptId = "unobserved-owner";
  assert.throws(() => assertT5Reports(inconsistentOwner), /ownerAttemptId/u);

  const duplicateAttempt = validT5Reports();
  const reconciliation = duplicateAttempt.find(
    (entry) => entry.name === "initial-workspace-identity",
  ).observed.reconciliation;
  reconciliation.attempts[1].attemptId = reconciliation.attempts[0].attemptId;
  assert.throws(
    () => assertT5Reports(duplicateAttempt),
    /unique competing attempts/u,
  );

  const duplicateSpawn = validT5Reports();
  duplicateSpawn.find(
    (entry) => entry.name === "initial-workspace-identity",
  ).observed.joinedAttempt.spawnCalls = 2;
  assert.throws(
    () => assertT5Reports(duplicateSpawn),
    /joinedAttempt.spawnCalls/u,
  );
});

test("workspace report accepts either order for concurrent hook observations", () => {
  const reports = validT5Reports();
  reports
    .find((entry) => entry.name === "initial-workspace-identity")
    .observed.rawHookObservations.reverse();

  assert.doesNotThrow(() => assertT5Reports(reports));
});

test("A17 requires dirty-file observations and a finite retirement window", () => {
  const missingWindow = validT5Reports();
  delete missingWindow.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed.retirementWindowMs;
  assert.throws(() => assertT5Reports(missingWindow), /finite window/u);

  const unboundedWindow = validT5Reports();
  unboundedWindow.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed.retirementWindowMs = 7 * 60 * 1000 + 1;
  assert.throws(() => assertT5Reports(unboundedWindow), /finite window/u);

  const missingDirtyFile = validT5Reports();
  missingDirtyFile.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed.markerExistsAfterFinalArchive = undefined;
  assert.throws(
    () => assertT5Reports(missingDirtyFile),
    /markerExistsAfterFinalArchive/u,
  );
});

test("A17 accepts retirement confirmed by a missing environment response", () => {
  const reports = validT5Reports();
  const observed = reports.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed;
  const finalSample = observed.retirementObservations.at(-1);
  Object.assign(finalSample, {
    environmentId: null,
    environmentStatus: null,
    environmentLookupError: "HTTP 404: Environment not found",
    environmentConfirmedMissing: true,
    environmentRetired: true,
  });
  observed.environmentAfterLastDelete = finalSample.environmentLookupError;

  assert.doesNotThrow(() => assertT5Reports(reports));
});

test("A17 accepts a null environment ID only with confirmed missing retirement", () => {
  const unconfirmedMissing = validT5Reports();
  const unconfirmedObserved = unconfirmedMissing.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed;
  const unconfirmedSample = unconfirmedObserved.retirementObservations.at(-1);
  Object.assign(unconfirmedSample, {
    environmentId: null,
    environmentStatus: null,
    environmentLookupError: "temporary lookup failure",
    environmentConfirmedMissing: false,
    environmentRetired: false,
    retirementObserved: false,
  });
  unconfirmedObserved.retirementObserved = false;
  unconfirmedObserved.environmentAfterLastDelete =
    unconfirmedSample.environmentLookupError;
  assert.throws(() => assertT5Reports(unconfirmedMissing), /missing/u);

  const nonMissingFailure = validT5Reports();
  const failedObserved = nonMissingFailure.find(
    (entry) => entry.name === "a17-shared-worktree-retention",
  ).observed;
  const failedSample = failedObserved.retirementObservations.at(-1);
  Object.assign(failedSample, {
    environmentId: null,
    environmentStatus: null,
    environmentLookupError: "HTTP 500: temporary server error",
    environmentConfirmedMissing: true,
    environmentRetired: true,
  });
  failedObserved.environmentAfterLastDelete =
    failedSample.environmentLookupError;
  assert.throws(
    () => assertT5Reports(nonMissingFailure),
    /confirmed missing response/u,
  );

  const wrongReturnedId = validT5Reports();
  wrongReturnedId
    .find((entry) => entry.name === "a17-shared-worktree-retention")
    .observed.retirementObservations.at(-1).environmentId = "other-environment";
  assert.throws(() => assertT5Reports(wrongReturnedId), /environment-a17/u);
});

test("cleanup policy table stays proposed and fails closed for unknown evidence", () => {
  const report = validReport();
  assert.doesNotThrow(() => assertIntegrationReport(report));
  const unknownDelivery =
    report.proposedEnsembleContract.cleanupDecisionTable.find(
      (entry) => entry.delivery === "unknown",
    );
  unknownDelivery.decision = "archive";
  assert.throws(
    () => assertIntegrationReport(report),
    /cleanup decision table/u,
  );
});

test("unproved writer, stop, A17 and accepted-queue guarantees cannot pass", () => {
  const writer = validReport();
  writer.rows.find(
    (entry) =>
      entry.type === "proof-gate" && entry.id === "composed-writer-admission",
  ).verdict = "passed";
  assert.throws(
    () => assertIntegrationReport(writer),
    /must preserve the T5 capability verdict/u,
  );

  const stop = validReport();
  stop.rows.find(
    (entry) =>
      entry.type === "proof-gate" && entry.id === "stop-writer-release",
  ).verdict = "passed";
  assert.throws(
    () => assertIntegrationReport(stop),
    /Stop proof gate.*remains open/u,
  );

  const a17 = validReport();
  a17.rows.find(
    (entry) =>
      entry.type === "public-api" && entry.id === "shared-worktree-retention",
  ).verdict = "passed";
  assert.throws(() => assertIntegrationReport(a17), /A17 remains/u);

  const startup = validReport();
  startup.rows.find(
    (entry) =>
      entry.type === "proof-gate" && entry.id === "startup-queued-dispatch",
  ).verdict = "passed";
  assert.throws(
    () => assertIntegrationReport(startup),
    /Known T4 startup capability failure/u,
  );
});

test("T5 confirms exact cancellation before release and keeps the product gate open", () => {
  const rows = validT5Reports();
  assert.doesNotThrow(() => assertT5Reports(rows));
  rows[0].verdict = "pass";
  assert.throws(() => assertT5Reports(rows), /product gate remains open/u);

  const report = validReport();
  assert.deepEqual(report.dependentExecutionBlocked, ["T06", "T08"]);
  assert.doesNotThrow(() => assertIntegrationReport(report));
  report.rows.find((entry) => entry.id === REQUIRED_T5_REPORTS[0]).verdict =
    "passed";
  assert.throws(() => assertIntegrationReport(report), /remains open/u);
});

test("T5 keeps the writer held when cancellation is unconfirmed", () => {
  const rows = validT5Reports();
  rows[1].verdict = "failed-capability";
  rows[1].identities.delayedDeleteResponse = { ok: false };
  rows[1].observed = failedStopWriterObserved();
  assert.doesNotThrow(() => assertT5Reports(rows));

  const report = stopWriterFailureReport();
  assert.deepEqual(report.dependentExecutionBlocked, ["T02", "T06", "T08"]);
  assert.doesNotThrow(() => assertIntegrationReport(report));
});

test("report blocks T02 unless stop evidence validates as open", () => {
  const validOpen = validT5Reports();
  const openReport = buildIntegrationReport({
    slices: validSlices(),
    t5Reports: validOpen,
  });
  assert.equal(openReport.outcome, "completed-with-capability-gaps");
  assert.deepEqual(openReport.dependentExecutionBlocked, ["T06", "T08"]);
  assert.equal(
    openReport.rows.filter((entry) => entry.type === "t5-scenario").length,
    REQUIRED_T5_REPORTS.length,
  );
  assert.doesNotThrow(() => assertT5Reports(validOpen));

  const failed = validT5Reports();
  const failedStop = failed.find(
    (entry) => entry.name === "stop-writer-release",
  );
  failedStop.verdict = "failed-capability";
  failedStop.identities.delayedDeleteResponse = { ok: false };
  failedStop.observed = failedStopWriterObserved();

  const missing = validT5Reports().filter(
    (entry) => entry.name !== "stop-writer-release",
  );

  const inconclusive = validT5Reports();
  inconclusive.find((entry) => entry.name === "stop-writer-release").verdict =
    "inconclusive";

  const invalidOpen = validT5Reports();
  const invalidOpenStop = invalidOpen.find(
    (entry) => entry.name === "stop-writer-release",
  );
  invalidOpenStop.identities.delayedDeleteResponse = { ok: false };
  invalidOpenStop.observed = failedStopWriterObserved();

  const blocked = ["T02", "T06", "T08"];
  for (const [label, t5Reports] of [
    ["failed", failed],
    ["missing", missing],
    ["inconclusive", inconclusive],
    ["invalid open", invalidOpen],
  ]) {
    const report = buildIntegrationReport({
      slices: validSlices(),
      t5Reports,
    });
    assert.equal(
      report.outcome,
      label === "failed" ? "completed-with-capability-gaps" : "failed-harness",
      label,
    );
    assert.deepEqual(report.dependentExecutionBlocked, blocked, label);
  }

  assert.doesNotThrow(() => assertT5Reports(failed));
  assert.throws(() => assertT5Reports(missing), /six named rows/u);
  assert.throws(
    () => assertT5Reports(inconclusive),
    /product gate remains open/u,
  );
  assert.throws(
    () => assertT5Reports(invalidOpen),
    /unconfirmed cancellation must remain a failed capability/u,
  );
});

test("T02 stays blocked when the T5 slice is missing, failed, or unverified", () => {
  const t5Reports = validT5Reports();
  const missingSlice = validSlices();
  delete missingSlice.T5;

  const failedSlice = validSlices();
  failedSlice.T5.testOutcome = "failed";
  failedSlice.T5.exitCode = 1;
  failedSlice.T5.manifest.outcome = "failed";

  const unverifiedSlice = validSlices();
  delete unverifiedSlice.T5.manifest;

  for (const [label, slices] of [
    ["missing", missingSlice],
    ["failed", failedSlice],
    ["unverified", unverifiedSlice],
  ]) {
    const report = buildIntegrationReport({ slices, t5Reports });
    assert.equal(report.outcome, "failed-harness", `${label} T5 outcome`);
    assert.deepEqual(
      report.dependentExecutionBlocked,
      ["T02", "T06", "T08"],
      `${label} T5 dependencies`,
    );
  }
});

test("integration report validates stop evidence before allowing T02 to unblock", () => {
  const failedEvidence = stopWriterFailureReport();
  assert.doesNotThrow(() => assertIntegrationReport(failedEvidence));
  failedEvidence.dependentExecutionBlocked = ["T06", "T08"];
  assert.throws(() => assertIntegrationReport(failedEvidence));

  const missingEvidence = validReport();
  missingEvidence.rows = missingEvidence.rows.filter(
    (entry) =>
      !(entry.type === "t5-scenario" && entry.id === "stop-writer-release"),
  );
  missingEvidence.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(missingEvidence),
    /missing required t5-scenario/u,
  );

  const inconclusiveEvidence = validReport();
  inconclusiveEvidence.rows.find(
    (entry) =>
      entry.type === "t5-scenario" && entry.id === "stop-writer-release",
  ).verdict = "inconclusive";
  inconclusiveEvidence.rows.find(
    (entry) =>
      entry.type === "proof-gate" && entry.id === "stop-writer-release",
  ).verdict = "inconclusive";
  inconclusiveEvidence.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(inconclusiveEvidence),
    /Stop product gate remains open/u,
  );

  const invalidOpenEvidence = validReport();
  const invalidOpenScenario = invalidOpenEvidence.rows.find(
    (entry) =>
      entry.type === "t5-scenario" && entry.id === "stop-writer-release",
  );
  invalidOpenScenario.observed.observations = failedStopWriterObserved();
  invalidOpenScenario.observed.identities.delayedDeleteResponse = { ok: false };
  invalidOpenEvidence.dependentExecutionBlocked = ["T02", "T06", "T08"];
  assert.throws(
    () => assertIntegrationReport(invalidOpenEvidence),
    /unconfirmed cancellation must remain a failed capability/u,
  );
});

test("T5 rejects unconfirmed or incomplete cancellation evidence before release", () => {
  const cases = [
    [
      "missing cancellation event",
      (observed) => {
        observed.delayedCancellationEvent = null;
      },
      /cancellation event/u,
    ],
    [
      "cancellation event for another message",
      (observed) => {
        observed.delayedCancellationEvent.messageId = "another-message";
      },
      /cancellation event/u,
    ],
    [
      "cancellation event for another thread",
      (observed) => {
        observed.delayedCancellationEvent.threadId = "another-thread";
      },
      /cancellation event/u,
    ],
    [
      "retained queue row",
      (observed) => {
        observed.delayedQueueAfterStopBeforeRelease = [
          { id: "queued-stop", waitingOn: { kind: "plugin" } },
        ];
      },
      /queue row/u,
    ],
    [
      "release before cancellation confirmation",
      (observed) => {
        observed.releaseAttemptedAfterCancellationConfirmation = false;
      },
      /before confirmed cancellation/u,
    ],
    [
      "missing post-release observation window",
      (observed) => {
        delete observed.releaseEvidence.observationWindowMs;
      },
      /observation window/u,
    ],
    [
      "retained queue row after release",
      (observed) => {
        observed.releaseEvidence.queue = [
          { id: "queued-stop", waitingOn: { kind: "plugin" } },
        ];
      },
      /queue row/u,
    ],
    [
      "provider turn after release",
      (observed) => {
        observed.delayedProviderTurnStartsAfterRelease = 1;
      },
      /provider turn started after release/u,
    ],
    [
      "tool effect after release",
      (observed) => {
        observed.delayedProviderToolEffectsAfterRelease = 1;
      },
      /tool effect after release/u,
    ],
  ];

  for (const [label, mutate, message] of cases) {
    const rows = validT5Reports();
    mutate(rows[1].observed);
    assert.throws(() => assertT5Reports(rows), message, label);
  }

  const releasedUnconfirmed = validT5Reports();
  releasedUnconfirmed[1].verdict = "failed-capability";
  releasedUnconfirmed[1].identities.delayedDeleteResponse = { ok: false };
  releasedUnconfirmed[1].observed = failedStopWriterObserved();
  releasedUnconfirmed[1].observed.releaseAttempted = true;
  assert.throws(
    () => assertT5Reports(releasedUnconfirmed),
    /cannot release when cancellation is unconfirmed/u,
  );
});

test("integration report detects missing events and unexpected duplicate effects", () => {
  const missingEvent = validReport();
  missingEvent.rows[0].requiredEvents = ["message.queued"];
  missingEvent.rows[0].observedEvents = [];
  missingEvent.rows[0].evidenceLimit = "A required event was missing.";
  missingEvent.rows[0].verdict = "failed";
  assert.throws(
    () => assertIntegrationReport(missingEvent),
    /did not produce/u,
  );

  const missingScenarioValue = validReport();
  missingScenarioValue.rows[0].observed.loader = null;
  assert.throws(
    () => assertIntegrationReport(missingScenarioValue),
    /loader is missing/u,
  );

  const duplicateEffect = validReport();
  duplicateEffect.rows[0].expectedEffectCount = 1;
  duplicateEffect.rows[0].observed.effectCount = 2;
  assert.throws(
    () => assertIntegrationReport(duplicateEffect),
    /duplicate or missing effects/u,
  );
});

test("known T4 failure is accepted only with exact diagnostic, state, and cleanup", () => {
  assert.doesNotThrow(() => assertExpectedT4Failure(validT4Evidence()));

  const changedResult = validT4Evidence();
  changedResult.manifest.checks.startupWithoutBothGateOwners.toolCallsAfterRestart = 3;
  assert.throws(() => assertExpectedT4Failure(changedResult), /tool effect/u);

  const hiddenGate = validT4Evidence();
  hiddenGate.manifest.dependentExecutionBlocked = [];
  assert.throws(() => assertExpectedT4Failure(hiddenGate), /T06/u);

  const leakedProcess = validT4Evidence();
  leakedProcess.manifest.checks.ownedProcessCleanup.allExited = false;
  assert.throws(() => assertExpectedT4Failure(leakedProcess), /cleanup/u);

  const inventedHostSdk = validT4Evidence();
  inventedHostSdk.manifest.checks.t4PluginSdkCompatibility.bbHostPluginSdk =
    "0.5.27";
  assert.throws(() => assertExpectedT4Failure(inventedHostSdk));

  const missingDiagnostic = validT4Evidence();
  missingDiagnostic.output = "the test failed for an unrelated reason";
  assert.throws(
    () => assertExpectedT4Failure(missingDiagnostic),
    /diagnostic/u,
  );
});
