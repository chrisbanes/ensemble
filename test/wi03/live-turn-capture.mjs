import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CodexRuntime } from "../../dist/src/standalone/index.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import {
  createTurnCaptureHarness,
  turnCaptureHarnessBudgets,
} from "../../dist/test/fixtures/turn-capture-harness.js";
import { tmpdir } from "../../dist/test/temp.js";

const requiredArgs = ["--live", "--one-attempt"];
if (
  process.argv.slice(2).length !== requiredArgs.length ||
  !requiredArgs.every((argument) => process.argv.slice(2).includes(argument))
) {
  process.stderr.write(
    "Refusing actual Codex execution without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}

const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const codexVersion = "0.162.0-alpha.2";
const markerText = "ensemble-turn-capture-marker-v1\n";
const markerHash = createHash("sha256")
  .update(Buffer.from(markerText, "utf8"))
  .digest("hex");
const expectedExecutableHash = process.env.ENSEMBLE_WI03_CODEX_SHA256;
if (!expectedExecutableHash || !/^[0-9a-f]{64}$/.test(expectedExecutableHash)) {
  process.stderr.write(
    "Refusing actual Codex execution without the controller-verified executable SHA-256.\n",
  );
  process.exit(2);
}
if (!statSync(codexExecutable).isFile()) {
  process.stderr.write(
    "Refusing actual Codex execution: approved executable is unavailable.\n",
  );
  process.exit(2);
}
const actualExecutableHash = createHash("sha256")
  .update(readFileSync(codexExecutable))
  .digest("hex");
if (actualExecutableHash !== expectedExecutableHash) {
  process.stderr.write(
    "Refusing actual Codex execution: executable hash differs from preflight.\n",
  );
  process.exit(2);
}

const attemptDirectory = mkdtempSync(
  join(tmpdir(), "ensemble-wi03-live-attempt-"),
);
chmodSync(attemptDirectory, 0o700);
const checkpointPath = join(attemptDirectory, "attempt.json");
const evidencePath = join(attemptDirectory, "evidence.json");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceRuntimeHash = createHash("sha256")
  .update(readFileSync("src/standalone/codex.ts"))
  .digest("hex");
const compiledRuntimeHash = createHash("sha256")
  .update(readFileSync("dist/src/standalone/codex.js"))
  .digest("hex");
const evidence = {
  schemaVersion: 1,
  state: "running",
  source: {
    revision: sourceRevision,
    node: process.version,
    packageManager: "npm@12.2.0",
    runtimeSourceSha256: sourceRuntimeHash,
    runtimeCompiledSha256: compiledRuntimeHash,
  },
  runtime: {
    executable: codexExecutable,
    version: codexVersion,
    executableSha256: actualExecutableHash,
    processIdentities: [],
    preflight: null,
  },
  budgets: { ...turnCaptureHarnessBudgets },
  attempt: { limit: 1, startTurnCalls: 0, checkpointPath },
  capture: null,
  sqliteReopen: null,
  reads: [],
  cleanup: {
    serviceStopReturned: false,
    processExitVerified: false,
    fixtureDirectoryRemoved: false,
    fixtureDirectory: null,
    partialFixtureRetained: null,
  },
  failure: null,
  recoveryFailure: null,
};

let harness;
let web;
let runtimeInstances = [];
let partialFixture;
let partialGuard;
let partialCheckpointPath;
let stage = "construct-private-harness";

function identitySnapshot(identity) {
  return identity
    ? {
        processId: identity.processId,
        processStartedAt: identity.processStartedAt,
        bootId: identity.bootId,
      }
    : null;
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.processId === right.processId &&
      left.processStartedAt === right.processStartedAt &&
      left.bootId === right.bootId,
  );
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("turn-capture-http-session-cookie-missing");
  return cookie;
}

async function login(operatorWeb) {
  const anonymous = await fetch(`${operatorWeb.origin}/api/operator/session`);
  const anonymousSession = (await anonymous.json()).csrfToken;
  const response = await fetch(`${operatorWeb.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(anonymous),
      origin: operatorWeb.origin,
      "content-type": "application/json",
      "x-csrf-token": anonymousSession,
    },
    body: JSON.stringify({ password: operatorWeb.password }),
  });
  assert.equal(response.status, 200);
  return sessionCookie(response);
}

async function bounded(promise, deadline, description) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${description}-deadline-exceeded`);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description}-deadline-exceeded`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(check, deadline, description) {
  while (Date.now() < deadline) {
    harness.guard.assertWithinTotalDeadline();
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description}-deadline-exceeded`);
}

async function stopWeb() {
  if (!web) return;
  const current = web;
  web = undefined;
  await current.close();
}

async function readLastTurn() {
  web = await harness.fixture.startWeb();
  const cookie = await login(web);
  const response = await fetch(
    `${web.origin}/api/operator/tasks/${harness.taskId}/comparisons?target=last-turn`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  evidence.reads.push({ status: response.status, state: body.data.state });
  assert.equal(body.data.state, "available");
  assert.equal(body.data.comparisonId, harness.guard.snapshot().comparisonId);
  assert.equal(body.data.comparison.taskId, harness.taskId);
  assert.equal(body.data.comparison.workId, harness.workId);
  assert.equal(body.data.comparison.profileId, harness.profileId);
  assert.equal(
    body.data.comparison.threadId,
    harness.guard.snapshot().threadId,
  );
  assert.equal(body.data.comparison.turnId, harness.guard.snapshot().turnId);
  const marker = body.data.comparison.entries.find(
    (entry) => entry.path === "turn-marker.txt",
  );
  assert.ok(marker);
  assert.equal(marker.left, undefined);
  assert.equal(marker.right.sha256, markerHash);
  assert.ok(!JSON.stringify(body).includes(harness.workspacePath));
  await stopWeb();
  return body.data;
}

async function verifyStoppedProcess(identity) {
  const checkpoint = harness.guard.snapshot();
  if (!identity || !sameIdentity(identity, checkpoint.processIdentity))
    throw new Error("turn-capture-runtime-process-identity-mismatch");
  const deadline = checkpoint.shutdownDeadlineAt;
  if (!deadline) throw new Error("turn-capture-shutdown-deadline-missing");
  const verifier = new MacProcessTerminationVerifier();
  let latest;
  while (Date.now() <= deadline) {
    latest = await verifier.verify(identity);
    if (latest.kind === "verified") {
      evidence.cleanup.processExitVerified = true;
      evidence.cleanup.processExit = {
        verifiedAt: latest.verifiedAt,
        method: latest.method,
        processIdentity: identitySnapshot(latest.processIdentity),
      };
      harness.guard.recordShutdownVerified(identity, latest);
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
    );
  }
  evidence.cleanup.processExit = latest ?? { kind: "unknown" };
  throw new Error("turn-capture-process-exit-not-verified-within-budget");
}

async function stopAndVerifyPreservingFixture() {
  const checkpoint = harness.guard.snapshot();
  let identity = checkpoint.processIdentity;
  if (checkpoint.serviceStopReturnedAt === undefined) {
    identity = await runtimeInstances.at(-1)?.processIdentity?.();
    if (!identity || !sameIdentity(identity, checkpoint.processIdentity))
      throw new Error("turn-capture-runtime-process-identity-mismatch");
    evidence.cleanup.processIdentityAtShutdown = identitySnapshot(identity);
    await bounded(
      harness.stopPreservingFixture(),
      Date.now() + turnCaptureHarnessBudgets.shutdownMs,
      "turn-capture-service-stop",
    );
  }
  evidence.cleanup.serviceStopReturned =
    harness.guard.snapshot().serviceStopReturnedAt !== undefined;
  if (!evidence.cleanup.serviceStopReturned) return;
  await verifyStoppedProcess(identity);
}

async function recoverFailure() {
  if (!harness) return;
  try {
    await stopWeb();
  } catch (error) {
    evidence.recoveryFailure = `web-close:${error.message}`;
  }
  try {
    const checkpoint = harness.guard.snapshot();
    if (
      checkpoint.startTurnCalls > 0 &&
      checkpoint.terminalStatus === undefined
    ) {
      if (checkpoint.stopRequestedAt === undefined)
        harness.guard.recordStopRequest();
      const stop = await bounded(
        harness.fixture.service.stopTask(harness.taskId),
        Math.min(
          Date.now() + turnCaptureHarnessBudgets.shutdownMs,
          checkpoint.totalDeadlineAt ?? Date.now(),
        ),
        "turn-capture-supported-stop",
      );
      if (harness.guard.snapshot().stopObservedAt === undefined)
        harness.guard.recordStopObservation(stop);
    }

    const totalDeadline = harness.guard.snapshot().totalDeadlineAt;
    if (harness.guard.snapshot().startTurnCalls > 0 && totalDeadline) {
      for (
        let read = 0;
        read < turnCaptureHarnessBudgets.maxReconciliationReads;
        read++
      ) {
        const before = harness.guard.snapshot();
        if (
          before.terminalStatus !== undefined &&
          before.captureObservedAt !== undefined
        )
          break;
        if (read > 0) {
          const pause = Math.min(
            turnCaptureHarnessBudgets.reconciliationIntervalMs,
            Math.max(0, totalDeadline - Date.now()),
          );
          if (pause === 0) break;
          await new Promise((resolve) => setTimeout(resolve, pause));
        }
        harness.guard.assertWithinTotalDeadline();
        harness.guard.recordReconciliationRead(Date.now());
        const work = harness.fixture.service
          .list()
          .find((item) => item.workId === harness.workId);
        const capture = harness.latestCapture();
        evidence.reads.push({
          kind: "reconciliation",
          workState: work?.state ?? "missing",
          captureState: capture?.captureState ?? "missing",
        });
        if (
          harness.guard.snapshot().terminalStatus !== undefined &&
          harness.guard.snapshot().captureObservedAt === undefined &&
          capture
        )
          harness.markCaptureObserved();
      }
    }

    const settled = harness.guard.snapshot();
    const work = harness.fixture.service
      .list()
      .find((item) => item.workId === harness.workId);
    if (
      (settled.startTurnCalls === 0 ||
        (settled.terminalStatus !== undefined &&
          settled.captureObservedAt !== undefined)) &&
      work?.state !== "running" &&
      settled.serviceStopReturnedAt === undefined
    ) {
      await stopAndVerifyPreservingFixture();
    } else if (settled.serviceStopReturnedAt !== undefined) {
      await verifyStoppedProcess(settled.processIdentity);
    }
  } catch (error) {
    evidence.recoveryFailure ??=
      error instanceof Error ? error.message : String(error);
  }
}

try {
  stage = "create-production-service-harness";
  try {
    harness = await createTurnCaptureHarness({
      checkpointPath,
      taskTitle: "Capture one real workspace turn",
      taskOutcome: `Create turn-marker.txt containing exactly ${markerText.trimEnd()} followed by a newline, then call ensemble_report_result with a short completion summary. Use only the local workspace write and required result-reporting action. Do not delegate, ask a question, request approval, invoke an external action, use network access or modify any other file.`,
      runtimeFactory(context) {
        if (!context.safety || typeof context.spawnEnvironment !== "function")
          throw new Error("turn-capture-production-runtime-context-incomplete");
        const runtime = new CodexRuntime(codexExecutable, context);
        runtimeInstances.push(runtime);
        return runtime;
      },
    });
  } catch (error) {
    const partial = error;
    partialFixture = partial?.fixture;
    partialGuard = partial?.turnCaptureGuard;
    partialCheckpointPath = partial?.turnCaptureCheckpointPath;
    throw error;
  }
  evidence.cleanup.fixtureDirectory = harness.fixture.directory;
  const firstIdentity = await runtimeInstances[0]?.processIdentity?.();
  assert.ok(firstIdentity);
  evidence.runtime.processIdentities.push(identitySnapshot(firstIdentity));
  assert.equal(harness.guard.snapshot().startTurnCalls, 0);
  assert.equal(
    harness.guard.snapshot().contextSafetyProvided &&
      harness.guard.snapshot().contextSpawnEnvironmentProvided,
    true,
  );
  assert.equal(
    Number(harness.fixture.service.domain().project(harness.projectId).paused),
    1,
  );
  evidence.runtime.preflight = {
    accountReadValidatedAs: "chatgpt",
    configReadValidated: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    },
    runtimeStartReturnedBeforeDispatch: true,
    serviceSafetyAndSpawnEnvironmentProvided: true,
    projectPaused: true,
    startTurnCallsBeforeDispatch: harness.guard.snapshot().startTurnCalls,
  };
  assert.equal(
    harness.fixture.service
      .list()
      .some(
        (work) => work.workId === harness.workId && work.state === "running",
      ),
    false,
  );

  stage = "admit-one-target-turn";
  await bounded(
    harness.activateTarget(),
    harness.guard.snapshot().startupDeadlineAt,
    "turn-capture-target-activation",
  );
  await bounded(
    harness.guard.startEntered,
    harness.guard.snapshot().startupDeadlineAt,
    "turn-capture-target-turn-start",
  );
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(harness.guard.snapshot().workId, harness.workId);
  assert.equal(harness.guard.snapshot().threadId !== undefined, true);

  stage = "observe-one-turn-and-report";
  const terminalDeadline = harness.guard.snapshot().totalDeadlineAt;
  const terminal = await bounded(
    harness.guard.terminal,
    terminalDeadline,
    "turn-capture-terminal",
  );
  assert.equal(terminal, "completed");
  const completedWork = await waitFor(
    () =>
      harness.fixture.service
        .list()
        .find((work) => work.workId === harness.workId)?.state === "completed",
    terminalDeadline,
    "turn-capture-result-callback-and-handoff",
  );
  assert.equal(completedWork, true);
  assert.equal(harness.fixture.service.taskHold(harness.taskId), undefined);
  const capture = harness.markCaptureObserved();
  assert.ok(capture);
  assert.equal(capture.captureState, "finished");
  assert.equal(capture.outcome, "completed");
  assert.equal(capture.identity.taskId, harness.taskId);
  assert.equal(capture.identity.workId, harness.workId);
  assert.equal(capture.identity.assignmentId, harness.assignmentId);
  assert.equal(capture.identity.profileId, harness.profileId);
  assert.equal(capture.threadId, harness.guard.snapshot().threadId);
  assert.equal(capture.turnId, harness.guard.snapshot().turnId);
  assert.ok(capture.comparison);
  assert.equal(capture.comparison.state, "available");
  assert.equal(capture.comparison.startedAt, capture.startedAt);
  assert.equal(capture.comparison.observedAt, capture.observedAt);
  const marker = capture.comparison.entries.find(
    (entry) => entry.path === "turn-marker.txt",
  );
  assert.ok(marker);
  assert.equal(marker.left, undefined);
  assert.equal(marker.right.sha256, markerHash);
  const exported = harness.fixture.service.workspaceComparisonExport(
    harness.taskId,
    capture.comparisonId,
  );
  assert.ok(exported);
  const copiedExport = structuredClone(exported);
  assert.equal(
    copiedExport.sides.find((side) => side.rightText !== undefined)?.rightText,
    markerText,
  );
  evidence.capture = {
    comparisonId: capture.comparisonId,
    taskId: capture.identity.taskId,
    workId: capture.identity.workId,
    assignmentId: capture.identity.assignmentId,
    profileId: capture.identity.profileId,
    threadId: capture.threadId,
    turnId: capture.turnId,
    outcome: capture.outcome,
    captureState: capture.captureState,
    startedAt: new Date(capture.startedAt).toISOString(),
    observedAt: new Date(capture.observedAt).toISOString(),
    beforeMarkerAbsent: marker.left === undefined,
    afterMarkerSha256: marker.right.sha256,
  };

  stage = "authenticated-last-turn-read";
  const firstRead = await readLastTurn();
  assert.equal(firstRead.comparisonId, capture.comparisonId);

  stage = "verified-service-stop-and-process-exit";
  await stopAndVerifyPreservingFixture();
  evidence.cleanup.serviceStopReturned = true;

  stage = "read-only-sqlite-reopen";
  const database = new DatabaseSync(
    join(harness.fixture.directory, "data", "standalone.sqlite"),
    { readOnly: true, timeout: 1000 },
  );
  let reopenedCapture;
  try {
    const row = database
      .prepare(`SELECT captureState, payloadJson FROM workspace_turn_captures
        WHERE taskId = ? AND comparisonId = ?`)
      .get(harness.taskId, capture.comparisonId);
    assert.ok(row);
    reopenedCapture = JSON.parse(row.payloadJson);
    assert.equal(row.captureState, "finished");
    assert.equal(reopenedCapture.captureState, "finished");
    assert.equal(reopenedCapture.comparisonId, capture.comparisonId);
    assert.deepEqual(reopenedCapture.identity, capture.identity);
    assert.equal(reopenedCapture.threadId, capture.threadId);
    assert.equal(reopenedCapture.turnId, capture.turnId);
    assert.deepEqual(reopenedCapture.comparison, copiedExport.comparison);
    assert.deepEqual(reopenedCapture.sides, copiedExport.sides);
    const slot = database
      .prepare(`SELECT latestFinishedId, pendingId
        FROM workspace_turn_capture_slots WHERE taskId = ?`)
      .get(harness.taskId);
    assert.ok(slot);
    assert.equal(slot.latestFinishedId, capture.comparisonId);
    assert.equal(slot.pendingId, null);
  } finally {
    database.close();
  }
  const reopenedMarkerSide = reopenedCapture.sides.find(
    (side) => side.rightText !== undefined,
  );
  assert.equal(reopenedMarkerSide?.rightText, markerText);
  evidence.sqliteReopen = {
    openedReadOnly: true,
    comparisonId: reopenedCapture.comparisonId,
    captureState: reopenedCapture.captureState,
    latestFinishedId: reopenedCapture.comparisonId,
    pendingId: null,
    markerSha256: markerHash,
  };
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(harness.guard.snapshot().reopenCount, 0);
  assert.equal(runtimeInstances.length, 1);
  evidence.attempt.startTurnCalls = harness.guard.snapshot().startTurnCalls;

  stage = "proof-gated-fixture-cleanup";
  await harness.finalizeVerifiedFixtureCleanup();
  evidence.cleanup.fixtureDirectoryRemoved = !existsSync(
    harness.fixture.directory,
  );
  assert.equal(evidence.cleanup.fixtureDirectoryRemoved, true);
  evidence.state = "passed";
} catch (error) {
  evidence.state = "failed";
  evidence.failure = {
    stage,
    message: error instanceof Error ? error.message : String(error),
  };
  if (harness && harness.guard.snapshot().status !== "shutdown-verified") {
    try {
      harness.guard.recordAssertionFailure();
    } catch (recordError) {
      evidence.recoveryFailure = `assertion-record:${recordError.message}`;
    }
    await recoverFailure();
  } else if (!harness) {
    const partial = error;
    if (partialFixture) {
      evidence.cleanup.fixtureDirectory = partialFixture.directory;
      evidence.cleanup.partialFixtureRetained = existsSync(
        partialFixture.directory,
      );
    }
    if (partialGuard) {
      const checkpoint = partialGuard.snapshot();
      evidence.attempt = {
        limit: 1,
        startTurnCalls: checkpoint.startTurnCalls,
        checkpointPath: partialCheckpointPath ?? checkpointPath,
        checkpoint,
      };
      evidence.recoveryFailure = partial?.turnCaptureSetupCleanupFailure
        ? String(partial.turnCaptureSetupCleanupFailure)
        : null;
    }
  }
}

if (harness) {
  evidence.attempt = {
    limit: 1,
    startTurnCalls: harness.guard.snapshot().startTurnCalls,
    checkpointPath,
    checkpoint: harness.guard.snapshot(),
  };
  evidence.cleanup.serviceStopReturned =
    harness.guard.snapshot().serviceStopReturnedAt !== undefined;
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`,
);
if (evidence.state !== "passed") process.exitCode = 1;
