import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REQUIRED_API_ROWS = [
  "plugin-install-settings-reload",
  "browser-plugin-panel",
  "project-machine-create",
  "thread-spawn-execution-options",
  "provider-tool-result-round-trip",
  "thread-status-events-restart",
  "native-question-answer-resume",
  "queued-message-send-cancel",
  "thread-stop-and-retry",
  "environment-reuse-and-restart",
  "lost-spawn-response-reconciliation",
  "lost-send-response-reconciliation",
  "stale-generation-queue-invalidation",
  "dispatch-hook-core-queue-composition",
  "accepted-queue-startup-failure",
  "instruction-revision-application",
  "shared-worktree-retention",
];

export const REQUIRED_PROOF_GATES = [
  "startup-queued-dispatch",
  "message-acceptance-replay",
  "composed-writer-admission",
  "stop-writer-release",
  "initial-workspace-identity",
  "retry-ownership",
  "revision-application",
];

export const REQUIRED_T5_REPORTS = [
  "composed-writer-admission",
  "stop-writer-release",
  "initial-workspace-identity",
  "retry-ownership",
  "revision-application",
  "a17-shared-worktree-retention",
];

export const REQUIRED_API_EVIDENCE = {
  "plugin-install-settings-reload": ["loader", "settings", "reload"],
  "browser-plugin-panel": ["beforeRestart", "afterRestart"],
  "project-machine-create": ["project.id"],
  "thread-spawn-execution-options": [
    "threadId",
    "environmentId",
    "providerRequest.params.options.model",
    "providerRequest.params.options.reasoningLevel",
    "providerRequest.params.options.serviceTier",
    "providerRequest.params.options.permissionMode",
  ],
  "provider-tool-result-round-trip": [
    "returnedText",
    "effectCount",
    "pluginCounterAfterRestart",
  ],
  "thread-status-events-restart": ["eventNames", "persistedThread"],
  "native-question-answer-resume": [
    "pendingInteractionEvents",
    "answer.threadId",
    "answer.interactionId",
    "answer.answerKind",
    "answer.resumedStatus",
    "answer.unresolvedInteractionCount",
    "answer.output",
  ],
  "queued-message-send-cancel": ["queueEvents"],
  "thread-stop-and-retry": [
    "stop.response.ok",
    "stop.statusAfterStop",
    "stop.providerStopRequests",
    "stop.toolEffects",
    "failedTurnRequestId",
    "firstAttempt",
    "retry.attempt",
    "providerRequestCount",
  ],
  "environment-reuse-and-restart": ["environmentId", "threadIds"],
  "lost-spawn-response-reconciliation": [
    "operationId",
    "threadId",
    "providerToolEffects",
    "replayNoBlindRetry",
  ],
  "lost-send-response-reconciliation": [
    "direct.providerToolEffectCount",
    "direct.providerToolEffectDelta",
    "delayed.providerToolEffectCount",
    "delayed.providerToolEffectDelta",
    "queued.providerToolEffectCount",
    "queued.providerToolEffectDelta",
    "effectCounts",
    "cumulativeEffectCounts",
  ],
  "stale-generation-queue-invalidation": [
    "state",
    "publicQueueRowDeleted",
    "providerToolEffectsAfterInvalidation",
    "effectCount",
  ],
  "dispatch-hook-core-queue-composition": [
    "externalWaitOwnerFailure",
    "pauseAndStopRace",
    "lostQueuedSend",
  ],
  "accepted-queue-startup-failure": [
    "queueId",
    "providerTurnCount",
    "toolCallsBeforeRestart",
    "toolCallsAfterRestart",
    "timelineMatches",
    "effectCount",
  ],
  "instruction-revision-application": ["identities", "observations"],
  "shared-worktree-retention": ["identities", "observations"],
};

function requireString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert(value.trim().length > 0, `${label} must not be empty`);
}

function requireObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert(Object.keys(value).length > 0, `${label} must contain evidence`);
  assert(
    hasEvidenceValue(value),
    `${label} contains no observed identities or effects`,
  );
}

function sortedObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortedObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedObjectKeys(value[key])]),
    );
  }
  return value;
}

export function serializeIntegrationReport(report) {
  return `${JSON.stringify(sortedObjectKeys(report), null, 2)}\n`;
}

export async function writeIntegrationReport(filePath, report) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  try {
    await writeFile(temporaryPath, serializeIntegrationReport(report));
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readIntegrationReport(filePath) {
  const contents = await readFile(filePath, "utf8");
  const report = JSON.parse(contents);
  assert.equal(
    contents,
    serializeIntegrationReport(report),
    "integration report is not in deterministic canonical form",
  );
  return report;
}

function hasEvidenceValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasEvidenceValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasEvidenceValue);
  }
  return false;
}

function evidenceAtPath(value, fieldPath) {
  return fieldPath.split(".").reduce((current, key) => current?.[key], value);
}

function sanitize(value, replacements) {
  if (value === undefined) return null;
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, replacements));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitize(item, replacements),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  let result = value;
  for (const [original, replacement] of replacements) {
    if (original) result = result.replaceAll(original, replacement);
  }
  return result.replace(
    /(?:\/private)?\/(?:var\/folders|tmp|Users\/[^/]+|home\/[^/]+)\/[^\s"']*/gu,
    "<isolated-path>",
  );
}

export function sanitizeIntegrationData(value, replacements = []) {
  return sanitize(value, replacements);
}

function rowMetadata(slice, ensembleHead, sourceDigest, hostSdkEvidence) {
  const manifest = slice?.manifest ?? {};
  const hostSdk =
    manifest.checks?.t4PluginSdkCompatibility?.bbHostPluginSdk ??
    hostSdkEvidence ??
    null;
  return {
    runtime: {
      bb: manifest.bb ?? null,
      hostSdk,
      pluginSdk: manifest.pluginSdk ?? null,
      node: manifest.node ?? null,
      playwright: manifest.playwright ?? null,
      platform: manifest.platform ?? null,
    },
    sourceRevisions: {
      ensembleHead: ensembleHead ?? null,
      integrationSourceDigest: sourceDigest ?? null,
      providerBridge: manifest.providerBridgeRevision ?? null,
      installedBbSource: null,
    },
    packageArtifacts: {
      lockfileTarballIntegrity: {
        bbApp: manifest.bbLockfileTarballIntegrity ?? null,
        pluginSdk: manifest.pluginSdkLockfileTarballIntegrity ?? null,
      },
      installedTreeSha256: {
        bbApp: manifest.bbInstalledTreeSha256 ?? null,
        pluginSdk: manifest.pluginSdkInstalledTreeSha256 ?? null,
      },
    },
  };
}

function checkedApiRow({
  id,
  api,
  scenario,
  slice,
  observed,
  verdict = "passed",
  evidenceLimit,
  ensembleHead,
  sourceDigest,
  hostSdkEvidence,
  expectedEffectCount,
  expectedEffectCounts,
  requiredEvents,
  observedEvents,
  evidencePresent = true,
}) {
  const missing =
    !slice?.manifest ||
    !observed ||
    !["passed", "expected-diagnostic"].includes(slice.testOutcome) ||
    !evidencePresent ||
    !hasEvidenceValue(observed);
  const metadata = rowMetadata(
    slice,
    ensembleHead,
    sourceDigest,
    hostSdkEvidence,
  );
  return {
    type: "public-api",
    id,
    publicApi: api,
    scenario,
    ...metadata,
    observed: observed ?? { evidenceMissing: true },
    verdict: missing ? "failed" : verdict,
    evidenceLimit: missing
      ? `Required live evidence was missing for ${scenario}.`
      : evidenceLimit,
    ...(expectedEffectCount === undefined ? {} : { expectedEffectCount }),
    ...(expectedEffectCounts === undefined ? {} : { expectedEffectCounts }),
    ...(requiredEvents === undefined ? {} : { requiredEvents, observedEvents }),
  };
}

function t5Observed(report) {
  if (!report) return undefined;
  return {
    identities: report.identities ?? {},
    observations: report.observed ?? {},
  };
}

function hasCheck(checks, name, predicate = () => true) {
  return (
    checks?.[name] !== undefined &&
    checks[name] !== null &&
    predicate(checks[name])
  );
}

function hasEvents(events, names) {
  return (
    Array.isArray(events) &&
    names.every((name) => events.some((event) => event.name === name))
  );
}

function gateRow({
  id,
  slice,
  scenario,
  observed,
  verdict,
  evidenceLimit,
  ensembleHead,
  sourceDigest,
  hostSdkEvidence,
  evidencePresent = true,
}) {
  const missing =
    !slice?.manifest ||
    !observed ||
    !evidencePresent ||
    !hasEvidenceValue(observed);
  return {
    type: "proof-gate",
    id,
    scenario,
    ...rowMetadata(slice, ensembleHead, sourceDigest, hostSdkEvidence),
    observed: observed ?? { evidenceMissing: true },
    verdict: missing ? "failed" : verdict,
    evidenceLimit: missing
      ? `Required live evidence was missing for ${scenario}.`
      : evidenceLimit,
  };
}

function t5Map(rows) {
  return new Map((rows ?? []).map((report) => [report.name, report]));
}

export function buildIntegrationReport({
  ensembleHead,
  sourceDigest,
  slices,
  t5Reports,
  replacements = [],
}) {
  const runtime = slices?.T1;
  const execution = slices?.T2;
  const lost = slices?.T3;
  const dispatch = slices?.T4;
  const recovery = slices?.T5;
  const t5 = t5Map(t5Reports);
  const hostSdkEvidence =
    dispatch?.manifest?.checks?.t4PluginSdkCompatibility?.bbHostPluginSdk;
  const metadataContext = { ensembleHead, sourceDigest, hostSdkEvidence };
  const t1Checks = runtime?.manifest?.checks ?? {};
  const t2Checks = execution?.manifest?.checks ?? {};
  const t3Checks = lost?.manifest?.checks ?? {};
  const t4Checks = dispatch?.manifest?.checks ?? {};
  const t5Gate = (name) => t5.get(name);
  const stopEvidence = t5Gate("stop-writer-release")?.observed;
  const staleEffectBaseline =
    t3Checks.lostResponse?.queuedSendRecovered?.providerToolEffectCount;
  const staleEffectCount =
    t3Checks.lostResponse?.staleGenerationInvalidated
      ?.providerToolEffectsAfterInvalidation;
  const staleEffectDelta =
    typeof staleEffectBaseline === "number" &&
    typeof staleEffectCount === "number"
      ? staleEffectCount - staleEffectBaseline
      : undefined;
  const apiRows = [
    checkedApiRow({
      id: REQUIRED_API_ROWS[0],
      api: "plugins.install, plugins.list, plugins.config, plugins.reload",
      scenario:
        "T1 installs, configures, lists and reloads the actual fixture plugin.",
      slice: runtime,
      observed: {
        loader: t1Checks.publicPluginLoader ?? null,
        settings: t1Checks.pluginSettings ?? null,
        reload: t1Checks.pluginReloadPersistence ?? null,
      },
      evidenceLimit:
        "The live plugin is the disposable capability fixture, not the Ensemble product plugin.",
      evidencePresent: [
        "publicPluginLoader",
        "pluginSettings",
        "pluginReloadPersistence",
        "bbRestartPersistence",
      ].every((name) => hasCheck(t1Checks, name)),
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[1],
      api: "BB plugin UI route",
      scenario:
        "T1 opens the fixture panel in automated Chromium before and after BB restart.",
      slice: runtime,
      observed: {
        beforeRestart: t1Checks.browserPanel ?? null,
        afterRestart: t1Checks.browserPanelAfterRestart ?? null,
      },
      evidenceLimit:
        "The browser displays an inert fixture panel; this does not validate an Ensemble task UI.",
      evidencePresent: ["browserPanel", "browserPanelAfterRestart"].every(
        (name) => hasCheck(t1Checks, name),
      ),
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[2],
      api: "machines.list and projects.create",
      scenario:
        "T1 provisions a project over a temporary Git repository on the isolated BB machine.",
      slice: runtime,
      observed: { project: t1Checks.temporaryGitProject ?? null },
      evidenceLimit:
        "The Git project and machine are disposable fixture resources.",
      evidencePresent: typeof t1Checks.temporaryGitProject?.id === "string",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[3],
      api: "threads.spawn with provider, model, reasoning, tier, permission, prompt and environment",
      scenario:
        "T2 reads the requested execution settings back from the provider request and BB thread.",
      slice: execution,
      observed: {
        threadId: t2Checks.executionSpawn?.threadId ?? null,
        environmentId: t2Checks.executionSpawn?.environmentId ?? null,
        providerRequest: t2Checks.executionSpawn?.providerTrace?.[0] ?? null,
        executionMetadata: t2Checks.executionSpawn?.metadata ?? null,
      },
      evidenceLimit:
        "One credential-free scripted provider and the requested fixture environment path were exercised.",
      evidencePresent:
        typeof t2Checks.executionSpawn?.threadId === "string" &&
        typeof t2Checks.executionSpawn?.environmentId === "string" &&
        t2Checks.executionSpawn?.providerTrace?.[0]?.params?.options?.model ===
          "fixture-model" &&
        t2Checks.executionSpawn?.providerTrace?.[0]?.params?.options
          ?.reasoningLevel === "medium" &&
        t2Checks.executionSpawn?.providerTrace?.[0]?.params?.options
          ?.serviceTier === "default" &&
        t2Checks.executionSpawn?.providerTrace?.[0]?.params?.options
          ?.permissionMode === "accept-edits",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[4],
      api: "Provider tool call and public plugin tool result",
      scenario:
        "T1 observes one SQLite-backed tool effect and the exact result returned to the scripted provider.",
      slice: runtime,
      observed: {
        ...(t1Checks.scriptedToolResult ?? {}),
        effectCount: t1Checks.scriptedToolResult?.toolCalls ?? null,
        pluginCounterAfterRestart:
          t1Checks.bbRestartPersistence?.toolCalls ?? null,
      },
      expectedEffectCount: 1,
      evidencePresent:
        t1Checks.scriptedToolResult?.toolCalls === 1 &&
        typeof t1Checks.scriptedToolResult?.environmentId === "string" &&
        t1Checks.scriptedToolResult?.returnedText === "capability result 1",
      evidenceLimit:
        "The tool is a test fixture capability; no authenticated model was used.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[5],
      api: "threads.get and public thread/message events",
      scenario:
        "T1/T2 assert lifecycle, queue and cancellation events against fresh public reads.",
      slice: execution,
      observed: {
        eventNames: Array.isArray(t2Checks.executionLifecycle)
          ? t2Checks.executionLifecycle.map((event) => event.name)
          : [],
        persistedThread: t1Checks.bbRestartPersistence ?? null,
      },
      evidenceLimit:
        "The event assertions cover named fixture scenarios, not all BB event delivery races.",
      evidencePresent:
        hasEvents(t2Checks.executionLifecycle, [
          "thread.created",
          "thread.active",
          "thread.idle",
          "message.queued",
          "message.dispatched",
          "message.cancelled",
        ]) && hasCheck(t1Checks, "bbRestartPersistence"),
      requiredEvents: ["thread.created", "thread.active", "thread.idle"],
      observedEvents: Array.isArray(t2Checks.executionLifecycle)
        ? t2Checks.executionLifecycle.map((event) => event.name)
        : [],
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[6],
      api: "threads.interactions.list and interaction resolve",
      scenario:
        "T2 lists the native ask_user interaction, answers it and observes provider resume.",
      slice: execution,
      observed: {
        pendingInteractionEvents: Array.isArray(t2Checks.executionInteraction)
          ? t2Checks.executionInteraction
              .filter((event) => event.name === "interaction.pending")
              .map((event) => event.data?.interaction?.id ?? null)
          : [],
        answer: t2Checks.executionInteractionAnswer ?? null,
      },
      evidenceLimit: "One scripted question and answer path was exercised.",
      evidencePresent:
        Array.isArray(t2Checks.executionInteraction) &&
        t2Checks.executionInteraction.some(
          (event) => event.name === "interaction.pending",
        ) &&
        typeof t2Checks.executionInteractionAnswer?.interactionId ===
          "string" &&
        t2Checks.executionInteractionAnswer?.resumedStatus === "idle" &&
        t2Checks.executionInteractionAnswer?.answerKind === "user_answer" &&
        t2Checks.executionInteractionAnswer?.unresolvedInteractionCount === 0 &&
        t2Checks.executionInteractionAnswer?.output?.includes(
          "Question answered: staging",
        ),
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[7],
      api: "threads.send and queued-message list, send, delete APIs",
      scenario:
        "T2 observes queued, dispatched and cancelled events with matching fresh queue reads.",
      slice: execution,
      observed: {
        queueEvents: Array.isArray(t2Checks.executionLifecycle)
          ? t2Checks.executionLifecycle
              .filter((event) =>
                [
                  "message.queued",
                  "message.dispatched",
                  "message.cancelled",
                ].includes(event.name),
              )
              .map((event) => ({
                name: event.name,
                messageId: event.data?.entry?.id,
              }))
          : [],
      },
      evidenceLimit:
        "Scheduled queue events and the explicit dispatch/cancel paths are covered; every queue timing is not.",
      evidencePresent:
        hasEvents(t2Checks.executionLifecycle, [
          "message.queued",
          "message.dispatched",
          "message.cancelled",
        ]) &&
        t2Checks.executionLifecycle
          .filter((event) =>
            [
              "message.queued",
              "message.dispatched",
              "message.cancelled",
            ].includes(event.name),
          )
          .every((event) => typeof event.data?.entry?.id === "string"),
      requiredEvents: [
        "message.queued",
        "message.dispatched",
        "message.cancelled",
      ],
      observedEvents: Array.isArray(t2Checks.executionLifecycle)
        ? t2Checks.executionLifecycle.map((event) => event.name)
        : [],
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[8],
      api: "threads.stop and threads.retry",
      scenario:
        "T5 confirms an active stop and post-stop status; T2 confirms retry identity across restart.",
      slice: execution,
      observed: {
        stop: {
          response: stopEvidence?.activeStopResponse ?? null,
          statusAfterStop: stopEvidence?.activeStatusAfterStop ?? null,
          providerStopRequests:
            stopEvidence?.activeProviderStopRequests ?? null,
          toolEffects: stopEvidence?.activeToolEffects ?? null,
        },
        failedTurnRequestId:
          t2Checks.executionRetry?.failedTurnRequestId ?? null,
        firstAttempt: t2Checks.executionRetry?.failureAttempt ?? null,
        retry: t2Checks.executionRetry?.retry ?? null,
        providerRequestCount:
          t2Checks.executionRetry?.providerTrace?.length ?? null,
      },
      evidenceLimit:
        "The retry is explicit and per-thread; a global two-retry owner is not implemented or proved.",
      evidencePresent:
        recovery?.testOutcome === "passed" &&
        stopEvidence?.activeStopResponse?.ok === true &&
        ["idle", "error"].includes(stopEvidence?.activeStatusAfterStop) &&
        stopEvidence?.activeProviderStopRequests === 1 &&
        stopEvidence?.activeToolEffects === 0 &&
        typeof t2Checks.executionRetry?.failedTurnRequestId === "string" &&
        t2Checks.executionRetry?.failureAttempt === 1 &&
        t2Checks.executionRetry?.retry?.attempt === 2 &&
        t2Checks.executionRetry?.providerTrace?.length === 2,
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[9],
      api: "thread environment read/reuse and restart",
      scenario:
        "T2 reuses one environment across two threads and reads it after restart.",
      slice: execution,
      observed: t2Checks.sharedEnvironmentAfterRestart ?? undefined,
      evidenceLimit:
        "Shared environment identity is observed; concurrent initial provisioning is covered separately and remains open.",
      evidencePresent:
        typeof t2Checks.sharedEnvironmentAfterRestart?.environmentId ===
          "string" &&
        t2Checks.sharedEnvironmentAfterRestart?.threadIds?.length === 2,
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[10],
      api: "threads.spawn plus public thread metadata/timeline reconciliation",
      scenario:
        "T3 restarts after a dropped accepted spawn response and reconnects one marker-matched thread.",
      slice: lost,
      observed: {
        ...(t3Checks.lostResponse?.acceptedSpawnRecovered ?? {}),
        effectCount:
          t3Checks.lostResponse?.acceptedSpawnRecovered?.providerToolEffects ??
          null,
      },
      expectedEffectCount:
        t3Checks.lostResponse?.acceptedSpawnRecovered?.providerToolEffects,
      evidencePresent:
        typeof t3Checks.lostResponse?.acceptedSpawnRecovered?.operationId ===
          "string" &&
        typeof t3Checks.lostResponse?.acceptedSpawnRecovered?.threadId ===
          "string" &&
        t3Checks.lostResponse?.acceptedSpawnRecovered?.providerToolEffects ===
          1 &&
        t3Checks.lostResponse?.acceptedSpawnRecovered?.replayNoBlindRetry ===
          true,
      evidenceLimit:
        t3Checks.lostResponse?.idempotencyBoundary ??
        "Marker-based scenario only; missing or multiple matches stay uncertain.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[11],
      api: "threads.send and public timeline/queue reads",
      scenario:
        "T3 reconciles dropped sent and queued responses without a second send attempt.",
      slice: lost,
      observed: {
        direct: t3Checks.lostResponse?.directSendRecovered ?? null,
        delayed: t3Checks.lostResponse?.delayedSendResponse ?? null,
        queued: t3Checks.lostResponse?.queuedSendRecovered ?? null,
        ambiguous: t3Checks.lostResponse?.ambiguousQueueHeld ?? null,
        effectCounts: [
          t3Checks.lostResponse?.directSendRecovered?.providerToolEffectDelta,
          t3Checks.lostResponse?.delayedSendResponse?.providerToolEffectDelta,
          t3Checks.lostResponse?.queuedSendRecovered?.providerToolEffectDelta,
        ],
        cumulativeEffectCounts: [
          t3Checks.lostResponse?.directSendRecovered?.providerToolEffectCount,
          t3Checks.lostResponse?.delayedSendResponse?.providerToolEffectCount,
          t3Checks.lostResponse?.queuedSendRecovered?.providerToolEffectCount,
        ],
      },
      expectedEffectCounts: [1, 1, 1],
      evidencePresent:
        [
          t3Checks.lostResponse?.directSendRecovered,
          t3Checks.lostResponse?.delayedSendResponse,
          t3Checks.lostResponse?.queuedSendRecovered,
        ].every((entry) => entry?.providerToolEffectDelta === 1) &&
        t3Checks.lostResponse?.directSendRecovered?.sendCallsAfterReplay ===
          1 &&
        t3Checks.lostResponse?.queuedSendRecovered?.sendCallsAfterReplay ===
          1 &&
        staleEffectDelta === 0,
      verdict: "partial",
      evidenceLimit:
        t3Checks.lostResponse?.idempotencyBoundary ??
        "Bounded marker reconciliation; general idempotency is not established.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[12],
      api: "public queued-message delete and generation readback",
      scenario:
        "T3 invalidates a stale-generation queued message before provider effect.",
      slice: lost,
      expectedEffectCount: staleEffectDelta,
      evidencePresent:
        t3Checks.lostResponse?.staleGenerationInvalidated?.state ===
          "invalidated" &&
        t3Checks.lostResponse?.staleGenerationInvalidated
          ?.publicQueueRowDeleted === true &&
        staleEffectDelta === 0,
      observed: {
        ...(t3Checks.lostResponse?.staleGenerationInvalidated ?? {}),
        providerToolEffectCountBeforeInvalidation: staleEffectBaseline ?? null,
        providerToolEffectDelta: staleEffectDelta ?? null,
        effectCount: staleEffectDelta ?? null,
      },
      verdict: "partial",
      evidenceLimit:
        "The fixture exercises a bounded public delete path; it does not prove an atomic generation interlock.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[13],
      api: "public message.dispatch hooks with core busy queue",
      scenario:
        "T4 records reject/wait ordering and a BB core busy row held by a loaded paused gate.",
      slice: dispatch,
      observed: {
        externalWaitOwnerFailure:
          t4Checks.externalWaitOwnerFailureWithGateLoaded ?? null,
        pauseAndStopRace: t4Checks.pauseAndTaskStopRace ?? null,
        lostQueuedSend: t4Checks.lostQueuedSendRestartReconciliation ?? null,
      },
      evidencePresent:
        hasCheck(t4Checks, "externalWaitOwnerFailureWithGateLoaded") &&
        hasCheck(t4Checks, "pauseAndTaskStopRace") &&
        hasCheck(t4Checks, "lostQueuedSendRestartReconciliation"),
      verdict: "partial",
      evidenceLimit:
        "The pause/stop race was rejected by the paused gate; this is not an independent task-stop guarantee.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[14],
      api: "public threads.send accepted queue and message.dispatch startup hooks",
      scenario:
        "T4 injects failed startup of both wait owners and observes BB dispatch the previously accepted row.",
      slice: dispatch,
      observed: {
        ...(t4Checks.startupWithoutBothGateOwners ?? {}),
        effectCount: t4Checks.startupWithoutBothGateOwners
          ? t4Checks.startupWithoutBothGateOwners.toolCallsAfterRestart -
            t4Checks.startupWithoutBothGateOwners.toolCallsBeforeRestart
          : null,
      },
      expectedEffectCount: t4Checks.startupWithoutBothGateOwners
        ? t4Checks.startupWithoutBothGateOwners.toolCallsAfterRestart -
          t4Checks.startupWithoutBothGateOwners.toolCallsBeforeRestart
        : undefined,
      evidencePresent:
        t4Checks.startupWithoutBothGateOwners?.status === "failed" &&
        t4Checks.startupWithoutBothGateOwners?.safety === false &&
        t4Checks.startupWithoutBothGateOwners?.providerTurnCount === 1 &&
        t4Checks.startupWithoutBothGateOwners?.timelineMatches === 1,
      verdict: "failed-capability",
      evidenceLimit:
        "The known #665 startup boundary is a failed capability, not a harness failure or safety pass; T06 and T08 remain blocked.",
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[15],
      api: "dynamic thread instruction contribution and next turn",
      scenario:
        "T5 records provider request parameters before and after the explicit revision operation.",
      slice: recovery,
      observed: t5Observed(t5Gate("revision-application")),
      verdict: t5Gate("revision-application")?.verdict ?? "open",
      evidenceLimit:
        t5Gate("revision-application")?.limits?.join(" ") ??
        "T5 revision evidence is missing; capability remains open.",
      evidencePresent: Boolean(t5Gate("revision-application")),
      ...metadataContext,
    }),
    checkedApiRow({
      id: REQUIRED_API_ROWS[16],
      api: "environment archive/delete while another thread retains the worktree",
      scenario:
        "T5 checks direct BB archive/delete and shared-worktree retention for two live fixture threads.",
      slice: recovery,
      observed: t5Observed(t5Gate("a17-shared-worktree-retention")),
      verdict: t5Gate("a17-shared-worktree-retention")?.verdict ?? "open",
      evidenceLimit:
        t5Gate("a17-shared-worktree-retention")?.limits?.join(" ") ??
        "T5 retention evidence is missing.",
      evidencePresent: Boolean(t5Gate("a17-shared-worktree-retention")),
      ...metadataContext,
    }),
  ];

  const gateDefs = [
    {
      id: "startup-queued-dispatch",
      slice: dispatch,
      scenario: "T4 accepted queue after both hook owners fail initialization.",
      observed: t4Checks.startupWithoutBothGateOwners,
      verdict: "failed-capability",
      evidencePresent:
        t4Checks.startupWithoutBothGateOwners?.status === "failed" &&
        t4Checks.startupWithoutBothGateOwners?.safety === false &&
        t4Checks.startupWithoutBothGateOwners?.providerTurnCount === 1 &&
        t4Checks.startupWithoutBothGateOwners?.toolCallsAfterRestart ===
          t4Checks.startupWithoutBothGateOwners?.toolCallsBeforeRestart + 1,
      evidenceLimit:
        "BB delivered one accepted provider turn and one additional tool effect with neither hook owner available; #665 remains open and blocks T06/T08.",
    },
    {
      id: "message-acceptance-replay",
      slice: lost,
      scenario:
        "T3 dropped spawn/send responses, restart reconciliation, duplicate matches and stale-generation queue handling.",
      observed: t3Checks.lostResponse,
      verdict: "partial",
      evidencePresent:
        t3Checks.lostResponse?.acceptedSpawnRecovered?.providerToolEffects ===
          1 &&
        t3Checks.lostResponse?.directSendRecovered?.providerToolEffectDelta ===
          1 &&
        t3Checks.lostResponse?.delayedSendResponse?.providerToolEffectDelta ===
          1 &&
        t3Checks.lostResponse?.queuedSendRecovered?.providerToolEffectDelta ===
          1 &&
        staleEffectDelta === 0,
      evidenceLimit:
        t3Checks.lostResponse?.idempotencyBoundary ??
        "T3 message-recovery evidence is missing.",
    },
    {
      id: "composed-writer-admission",
      slice: recovery,
      scenario: "T5 second-plugin wait and writer-admission observations.",
      observed: t5Observed(t5Gate("composed-writer-admission")),
      verdict: t5Gate("composed-writer-admission")?.verdict ?? "open",
      evidencePresent: Boolean(t5Gate("composed-writer-admission")),
      evidenceLimit:
        t5Gate("composed-writer-admission")?.limits?.join(" ") ??
        "T5 evidence is missing.",
    },
    {
      id: "stop-writer-release",
      slice: recovery,
      scenario: "T5 active and delayed-start stop observations before release.",
      observed: t5Observed(t5Gate("stop-writer-release")),
      verdict: t5Gate("stop-writer-release")?.verdict ?? "open",
      evidencePresent: Boolean(t5Gate("stop-writer-release")),
      evidenceLimit:
        t5Gate("stop-writer-release")?.limits?.join(" ") ??
        "T5 evidence is missing.",
    },
    {
      id: "initial-workspace-identity",
      slice: recovery,
      scenario:
        "T5 concurrent raw launches and persisted task-intent reconciliation.",
      observed: t5Observed(t5Gate("initial-workspace-identity")),
      verdict: t5Gate("initial-workspace-identity")?.verdict ?? "open",
      evidencePresent: Boolean(t5Gate("initial-workspace-identity")),
      evidenceLimit:
        t5Gate("initial-workspace-identity")?.limits?.join(" ") ??
        "T5 evidence is missing.",
    },
    {
      id: "retry-ownership",
      slice: recovery,
      scenario: "T5 explicit BB retry ownership across restart.",
      observed: t5Observed(t5Gate("retry-ownership")),
      verdict: t5Gate("retry-ownership")?.verdict ?? "open",
      evidencePresent: Boolean(t5Gate("retry-ownership")),
      evidenceLimit:
        t5Gate("retry-ownership")?.limits?.join(" ") ??
        "T5 evidence is missing.",
    },
    {
      id: "revision-application",
      slice: recovery,
      scenario:
        "T5 dynamic instruction revision and provider request observations.",
      observed: t5Observed(t5Gate("revision-application")),
      verdict: t5Gate("revision-application")?.verdict ?? "open",
      evidencePresent: Boolean(t5Gate("revision-application")),
      evidenceLimit:
        t5Gate("revision-application")?.limits?.join(" ") ??
        "T5 evidence is missing.",
    },
  ];
  const gateRows = gateDefs.map((definition) =>
    gateRow({ ...definition, ensembleHead, sourceDigest, hostSdkEvidence }),
  );
  const t5Rows = (t5Reports ?? []).map((entry) => ({
    type: "t5-scenario",
    id: entry.name,
    scenario: `T5 scenario ${entry.name}`,
    ...rowMetadata(recovery, ensembleHead, sourceDigest, hostSdkEvidence),
    observed: t5Observed(entry) ?? { evidenceMissing: true },
    verdict: entry.verdict ?? "failed",
    evidenceLimit:
      entry.limits?.join(" ") ?? `T5 evidence is missing for ${entry.name}.`,
    evidencePresent:
      hasEvidenceValue(entry.identities) &&
      hasEvidenceValue(entry.observed) &&
      Array.isArray(entry.limits) &&
      entry.limits.length > 0,
  }));
  const suitePassed =
    Object.values(slices ?? {}).length === 5 &&
    ["T1", "T2", "T3", "T5"].every(
      (id) => slices[id]?.testOutcome === "passed",
    ) &&
    slices.T4?.testOutcome === "expected-diagnostic";

  return {
    schemaVersion: 2,
    sourceRevision: ensembleHead ?? null,
    integrationSourceDigest: sourceDigest ?? null,
    outcome: suitePassed ? "completed-with-capability-gaps" : "failed-harness",
    suite: "T1-T5 live BB integration evidence",
    slices: sanitize(
      Object.fromEntries(
        Object.entries(slices ?? {}).map(([name, slice]) => [
          name,
          {
            command: slice.command,
            exitCode: slice.exitCode,
            expectedExitCode: slice.expectedExitCode,
            timedOut: slice.timedOut,
            testOutcome: slice.testOutcome,
            manifestAvailable: Boolean(slice.manifest),
            cleanupVerified: Boolean(
              slice.manifest?.checks?.ownedProcessCleanup?.allExited &&
                slice.manifest.checks.ownedProcessCleanup.serverPortClosed &&
                slice.manifest.checks.ownedProcessCleanup.daemonPortClosed,
            ),
          },
        ]),
      ),
      replacements,
    ),
    rows: [...apiRows, ...gateRows, ...t5Rows].map((entry) =>
      sanitize(entry, replacements),
    ),
    t5Reports: (t5Reports ?? []).map((entry) => sanitize(entry, replacements)),
    dependentExecutionBlocked: ["T06", "T08"],
  };
}

export function assertExpectedT4Failure({
  exitCode,
  timedOut,
  output,
  manifest,
}) {
  assert.equal(timedOut, false, "T4 expected diagnostic must not time out");
  assert.equal(
    exitCode,
    1,
    "T4 raw diagnostic must exit 1 on the known capability failure",
  );
  assert.equal(typeof output, "string");
  const markers = output.match(/T4_CAPABILITY_FAILED:/gu) ?? [];
  assert.equal(
    markers.length,
    1,
    "T4 must emit exactly one known diagnostic marker",
  );
  const match = output.match(
    /T4_CAPABILITY_FAILED: BB dispatched accepted queue ([A-Za-z0-9_-]+) while both hook owners failed initialization; providerTurns=(\d+); toolCalls=(\d+)->(\d+); dependency=#665 \(T06\/T08 blocked\)/u,
  );
  assert(match, "T4 diagnostic changed or failed for an unrelated reason");
  assert.equal(
    (output.match(/^not ok /gmu) ?? []).length,
    1,
    "T4 must have one raw failing test",
  );
  assert.match(
    output,
    /^not ok 1 - public dispatch handoff records bounded holds and an open startup capability gate$/mu,
  );

  assert(manifest, "T4 must persist the failed diagnostic manifest");
  assert.equal(manifest.outcome, "failed");
  assert.equal(manifest.t4CapabilityStatus, "failed-capability");
  assert.equal(manifest.t4DependencyStatus, "open");
  assert.deepEqual(manifest.dependentExecutionBlocked, ["T06", "T08"]);
  const startup = manifest.checks?.startupWithoutBothGateOwners;
  assert(startup, "T4 startup failure evidence is missing");
  assert.equal(startup.status, "failed");
  assert.equal(startup.safety, false);
  assert.equal(
    startup.queueId,
    match[1],
    "T4 output queue identity disagrees with manifest",
  );
  assert.equal(startup.providerTurnCount, Number(match[2]));
  assert.equal(startup.toolCallsBeforeRestart, Number(match[3]));
  assert.equal(
    startup.toolCallsAfterRestart,
    Number(match[4]),
    "T4 diagnostic tool effect count must match its raw failure marker",
  );
  assert(
    startup.toolCallsAfterRestart === startup.toolCallsBeforeRestart + 1,
    "T4 startup diagnostic must preserve the observed single tool effect",
  );
  assert.equal(startup.providerTurnCount, 1);
  assert.equal(startup.timelineMatches, 1);
  assert.equal(startup.queueContainsAcceptedIdAfterDispatch, false);
  assert.match(startup.dependency, /#665.*T06\/T08/u);
  assert.equal(
    Object.keys(startup.failedPluginStatuses ?? {}).length,
    2,
    "T4 must report both unavailable hook owners",
  );
  assert(
    Object.values(startup.failedPluginStatuses).every(
      (status) => status !== "running",
    ),
    "T4 hook owner unexpectedly reported running",
  );
  const diagnostic = manifest.checks?.t4DispatchHarness;
  assert.equal(diagnostic?.status, "failed-capability");
  assert.equal(diagnostic?.diagnosticCompleted, true);
  assert.equal(diagnostic?.rawTestOutcome, "fail");
  assert.equal(diagnostic?.dependency, "#665");
  const cleanup = manifest.checks?.ownedProcessCleanup;
  assert(cleanup, "T4 cleanup evidence is missing");
  assert.equal(cleanup.allExited, true, "T4 cleanup leaked owned processes");
  assert.equal(cleanup.serverPortClosed, true, "T4 server port remained open");
  assert.equal(cleanup.daemonPortClosed, true, "T4 daemon port remained open");
  assert.equal(cleanup.forced, false, "T4 required forced process cleanup");
  assert.equal(
    manifest.checks?.disposableRootCleanup?.removed,
    true,
    "T4 disposable BB root was not removed",
  );
  return {
    queueId: startup.queueId,
    providerTurns: startup.providerTurnCount,
    toolEffectDelta:
      startup.toolCallsAfterRestart - startup.toolCallsBeforeRestart,
    failedPluginStatuses: startup.failedPluginStatuses,
  };
}

export function assertIntegrationReport(report) {
  assert.equal(
    report?.schemaVersion,
    2,
    "Unsupported integration report schema",
  );
  requireString(report.sourceRevision, "report.sourceRevision");
  requireString(
    report.integrationSourceDigest,
    "report.integrationSourceDigest",
  );
  assert.equal(report.toolchain?.node, "24.21.0", "report Node.js pin changed");
  assert.equal(report.toolchain?.npm, "11.20.0", "report npm pin changed");
  assert(Array.isArray(report.rows), "report.rows must be an array");
  const keyed = new Map();
  for (const entry of report.rows) {
    requireString(entry.id, "row.id");
    const key = `${entry.type}:${entry.id}`;
    assert(!keyed.has(key), `duplicate report row ${key}`);
    keyed.set(key, entry);
    requireString(entry.scenario, `${entry.id}.scenario`);
    requireString(entry.runtime?.bb, `${entry.id}.runtime.bb`);
    requireString(entry.runtime?.hostSdk, `${entry.id}.runtime.hostSdk`);
    requireString(entry.runtime?.pluginSdk, `${entry.id}.runtime.pluginSdk`);
    requireString(entry.runtime?.node, `${entry.id}.runtime.node`);
    requireString(entry.runtime?.playwright, `${entry.id}.runtime.playwright`);
    requireString(
      entry.sourceRevisions?.ensembleHead,
      `${entry.id}.sourceRevisions.ensembleHead`,
    );
    assert.equal(
      entry.sourceRevisions.ensembleHead,
      report.sourceRevision,
      `${entry.id}.ensembleHead does not match the report revision`,
    );
    requireString(
      entry.sourceRevisions?.integrationSourceDigest,
      `${entry.id}.sourceRevisions.integrationSourceDigest`,
    );
    assert.equal(
      entry.sourceRevisions.integrationSourceDigest,
      report.integrationSourceDigest,
      `${entry.id}.integrationSourceDigest does not match the report source digest`,
    );
    requireString(
      entry.sourceRevisions?.providerBridge,
      `${entry.id}.sourceRevisions.providerBridge`,
    );
    requireString(
      entry.packageArtifacts?.lockfileTarballIntegrity?.bbApp,
      `${entry.id}.packageArtifacts.lockfileTarballIntegrity.bbApp`,
    );
    requireString(
      entry.packageArtifacts?.lockfileTarballIntegrity?.pluginSdk,
      `${entry.id}.packageArtifacts.lockfileTarballIntegrity.pluginSdk`,
    );
    for (const name of ["bbApp", "pluginSdk"]) {
      const digest = entry.packageArtifacts?.installedTreeSha256?.[name];
      requireString(
        digest,
        `${entry.id}.packageArtifacts.installedTreeSha256.${name}`,
      );
      assert.match(
        digest,
        /^[a-f0-9]{64}$/u,
        `${entry.id}.packageArtifacts.installedTreeSha256.${name} must be SHA-256 hex`,
      );
    }
    assert.equal(
      Object.hasOwn(entry.sourceRevisions ?? {}, "installedBbSource"),
      true,
      `${entry.id}.sourceRevisions.installedBbSource must be explicit`,
    );
    requireObject(entry.observed, `${entry.id}.observed`);
    requireString(entry.verdict, `${entry.id}.verdict`);
    requireString(entry.evidenceLimit, `${entry.id}.evidenceLimit`);
    if (entry.type === "public-api") {
      requireString(entry.publicApi, `${entry.id}.publicApi`);
      for (const fieldPath of REQUIRED_API_EVIDENCE[entry.id] ?? []) {
        assert(
          hasEvidenceValue(evidenceAtPath(entry.observed, fieldPath)),
          `${entry.id}.observed.${fieldPath} is missing required scenario evidence`,
        );
      }
    }
    if (entry.requiredEvents !== undefined) {
      assert(
        Array.isArray(entry.requiredEvents) && entry.requiredEvents.length > 0,
        `${entry.id}.requiredEvents must be a nonempty array`,
      );
      assert(
        Array.isArray(entry.observedEvents),
        `${entry.id}.observedEvents must be an array`,
      );
      for (const eventName of entry.requiredEvents) {
        assert(
          entry.observedEvents.includes(eventName),
          `${entry.id} did not produce required event ${eventName}`,
        );
      }
    }
    assert.notEqual(
      entry.verdict,
      "failed",
      `${entry.id} did not produce required evidence`,
    );
    if (entry.expectedEffectCount !== undefined) {
      assert.equal(
        entry.observed.effectCount,
        entry.expectedEffectCount,
        `${entry.id} observed duplicate or missing effects`,
      );
    }
    if (entry.expectedEffectCounts !== undefined) {
      assert.deepEqual(
        entry.observed.effectCounts,
        entry.expectedEffectCounts,
        `${entry.id} observed duplicate or missing effects`,
      );
    }
  }

  for (const [type, required] of [
    ["public-api", REQUIRED_API_ROWS],
    ["proof-gate", REQUIRED_PROOF_GATES],
    ["t5-scenario", REQUIRED_T5_REPORTS],
  ]) {
    for (const id of required) {
      assert(keyed.has(`${type}:${id}`), `missing required ${type} row ${id}`);
    }
    const found = [...keyed.values()]
      .filter((entry) => entry.type === type)
      .map((entry) => entry.id);
    assert.deepEqual(found, required, `unexpected or reordered ${type} rows`);
  }
  const stop = keyed.get("public-api:thread-stop-and-retry")?.observed?.stop;
  assert.equal(stop?.response?.ok, true, "stop response must be confirmed");
  assert(
    ["idle", "error"].includes(stop?.statusAfterStop),
    "post-stop thread status must be confirmed",
  );
  assert.equal(stop?.providerStopRequests, 1);
  assert.equal(stop?.toolEffects, 0);
  const startup = keyed.get("proof-gate:startup-queued-dispatch");
  assert.equal(
    startup.verdict,
    "failed-capability",
    "Known T4 startup capability failure must remain visible",
  );
  assert.deepEqual(report.dependentExecutionBlocked, ["T06", "T08"]);
  assert.match(startup.evidenceLimit, /#665/u);
  assert.equal(
    keyed.get("proof-gate:message-acceptance-replay").verdict,
    "partial",
    "Message replay remains a bounded partial capability proof",
  );
  for (const id of [
    "composed-writer-admission",
    "stop-writer-release",
    "initial-workspace-identity",
    "retry-ownership",
    "revision-application",
  ]) {
    assert.equal(
      keyed.get(`proof-gate:${id}`).verdict,
      "open",
      `${id} remains open after fixture-only T5 evidence`,
    );
  }
  for (const id of REQUIRED_T5_REPORTS) {
    assert.equal(
      keyed.get(`t5-scenario:${id}`).verdict,
      "open",
      `T5 ${id} remains fixture evidence, not a closed product gate`,
    );
  }
  assert.equal(report.outcome, "completed-with-capability-gaps");
  return true;
}

export function assertT5Reports(rows) {
  assert(Array.isArray(rows), "T5 report rows must be an array");
  const names = rows.map((row) => row?.name);
  assert.deepEqual(
    names,
    REQUIRED_T5_REPORTS,
    "T5 must emit the six named rows in stable order",
  );
  for (const row of rows) {
    assert.equal(typeof row.verdict, "string", `T5 ${row.name} has no verdict`);
    requireObject(row.identities, `T5 ${row.name}.identities`);
    requireObject(row.observed, `T5 ${row.name}.observed`);
    assert(
      Array.isArray(row.limits) && row.limits.length > 0,
      `T5 ${row.name}.limits must be nonempty`,
    );
    assert(
      row.limits.every(
        (limit) => typeof limit === "string" && limit.length > 0,
      ),
    );
    assert.equal(
      row.verdict,
      "open",
      `T5 ${row.name} is fixture evidence; its product gate remains open`,
    );
  }
  return true;
}
