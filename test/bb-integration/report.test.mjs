import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  REQUIRED_API_ROWS,
  REQUIRED_API_EVIDENCE,
  REQUIRED_PROOF_GATES,
  REQUIRED_T5_REPORTS,
  assertExpectedT4Failure,
  assertIntegrationReport,
  assertT5Reports,
  buildIntegrationReport,
  readIntegrationReport,
  serializeIntegrationReport,
  writeIntegrationReport,
} from "./report.mjs";

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
          : { threadId: "thread-one" },
      observations:
        id === "stop-writer-release"
          ? stopWriterObserved()
          : { status: "open" },
    };
  }
  return Object.keys(observed).length > 0
    ? observed
    : { threadId: "thread-test", effectCount: 1 };
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
        : { threadId: `thread-${name}` },
    observed:
      name === "stop-writer-release"
        ? stopWriterObserved()
        : { status: "observed" },
    limits: ["Fixture evidence does not implement the product gate."],
  }));
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
  report.dependentExecutionBlocked = ["T02", "T06", "T08"];
  return report;
}

function row(type, id, overrides = {}) {
  return {
    type,
    id,
    ...(type === "public-api" ? { publicApi: id } : {}),
    scenario: `scenario for ${id}`,
    runtime: {
      bb: "0.44.0",
      hostSdk: "0.5.29",
      pluginSdk: "0.5.29",
      node: "24.21.0",
      playwright: "1.63.0",
    },
    sourceRevisions: {
      ensembleHead: "abc123",
      integrationSourceDigest: "digest-abc123",
      providerBridge: "fdd3de3b19b97e6cd1ef7300cbb54711431249d3",
      installedBbSource: null,
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
    });
  });
  return {
    schemaVersion: 2,
    sourceRevision: "abc123",
    integrationSourceDigest: "digest-abc123",
    outcome: "completed-with-capability-gaps",
    toolchain: { node: "24.21.0", npm: "12.1.0" },
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
    slices: {},
    t5Reports: validOpen,
  });
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
    const report = buildIntegrationReport({ slices: {}, t5Reports });
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
