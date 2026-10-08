import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type { RuntimeSpawnContext } from "../src/standalone/service.js";
import {
  createTurnCaptureHarness,
  markerSha256,
  OneTurnAttemptGuard,
  RecordingTurnCaptureRuntime,
  turnCaptureHarnessBudgets,
} from "./fixtures/turn-capture-harness.js";

async function bounded<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 8000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function until(
  check: () => boolean,
  description: string,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${description} did not settle within ${timeoutMs} ms`);
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("turn-capture-http-session-cookie-missing");
  return cookie;
}

async function login(web: { origin: string; password: string }) {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anonymousSession = (await anonymous.json()) as { csrfToken: string };
  const response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(anonymous),
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anonymousSession.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  return { cookie: sessionCookie(response) };
}

function disposeAttemptDirectory(path: string) {
  rmSync(path, { recursive: true, force: true });
}

test("WI03 live entry refuses default invocation before fixture or runtime setup", (t) => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), "ensemble-wi03-default-refusal-"),
  );
  chmodSync(tempRoot, 0o700);
  t.after(() => disposeAttemptDirectory(tempRoot));

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "test/wi03/live-turn-capture.mjs")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TMPDIR: tempRoot },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error)
    assert.fail(`entry subprocess failed: ${result.error.message}`);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr.split(/\r?\n/).filter(Boolean).at(-1),
    "Refusing actual Codex execution without exactly --live --one-attempt.",
  );
  assert.doesNotMatch(result.stderr, /does not provide an export named/);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("the offline live-harness path captures one exact turn through authenticated read and reopen", async (t) => {
  const contexts: RuntimeSpawnContext[] = [];
  const runtimes: RecordingTurnCaptureRuntime[] = [];
  const harness = await createTurnCaptureHarness({
    allowUnverifiedProcessExitForTests: true,
    runtimeFactory(context) {
      contexts.push(context);
      const runtime = new RecordingTurnCaptureRuntime(context);
      runtimes.push(runtime);
      return runtime;
    },
  });
  let web: Awaited<ReturnType<typeof harness.fixture.startWeb>> | undefined;
  let closed = false;
  t.after(async () => {
    if (web) await web.close();
    if (!closed) {
      const current = harness.guard.snapshot();
      if (current.startTurnCalls === 0 || current.terminalStatus !== undefined)
        await harness.fixture.close(undefined, undefined, true);
    }
    disposeAttemptDirectory(harness.fixture.directory);
    disposeAttemptDirectory(harness.checkpointDirectory);
  });

  assert.equal(contexts.length, 1);
  assert.equal(harness.guard.snapshot().contextSafetyProvided, true);
  assert.equal(harness.guard.snapshot().contextSpawnEnvironmentProvided, true);
  assert.equal(runtimes[0]?.context, contexts[0]);
  assert.equal(runtimes[0]?.context.safety, contexts[0]?.safety);
  assert.equal(
    runtimes[0]?.context.spawnEnvironment,
    contexts[0]?.spawnEnvironment,
  );
  assert.equal(harness.guard.snapshot().startTurnCalls, 0);
  assert.equal(runtimes[0]?.turns, 0);
  assert.equal(
    harness.fixture.service
      .list()
      .some(
        (work) => work.workId === harness.workId && work.state === "running",
      ),
    false,
  );

  await harness.activateTarget();
  const runtime = runtimes[0];
  assert.ok(runtime);
  await bounded(runtime.terminalEntered.promise, "single target turn terminal");
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(runtime.turns, 1);
  assert.equal(
    await bounded(harness.guard.terminal, "terminal callback completion"),
    "completed",
  );
  assert.equal(runtime.reportResultResponse?.success, true);
  await until(
    () =>
      harness.fixture.service
        .list()
        .find((work) => work.workId === harness.workId)?.state === "completed",
    "successful task handoff after result callback",
  );
  assert.equal(harness.fixture.service.taskHold(harness.taskId), undefined);

  const capture = harness.latestCapture();
  assert.ok(capture);
  assert.equal(capture.captureState, "finished");
  assert.equal(capture.outcome, "completed");
  assert.equal(capture.identity.taskId, harness.taskId);
  assert.equal(capture.identity.workId, harness.workId);
  assert.equal(capture.identity.assignmentId, harness.assignmentId);
  assert.equal(capture.identity.profileId, harness.profileId);
  assert.equal(capture.threadId, "fixture-thread");
  assert.equal(capture.turnId, "fixture-turn-1");
  const markerEntry = capture.comparison?.entries.find(
    (entry) => entry.path === "turn-marker.txt",
  );
  assert.ok(markerEntry);
  assert.equal(
    markerEntry.left,
    undefined,
    "the exact before side records marker absence",
  );
  assert.equal(markerEntry.right?.sha256, markerSha256());
  assert.equal(capture.comparison?.startedAt, capture.startedAt);
  assert.equal(capture.comparison?.observedAt, capture.observedAt);
  assert.ok(capture.comparison?.state === "available");
  assert.equal(capture.comparison?.profileId, harness.profileId);
  assert.equal(capture.comparison?.threadId, capture.threadId);
  assert.equal(capture.comparison?.turnId, capture.turnId);

  const exported = harness.fixture.service.workspaceComparisonExport(
    harness.taskId,
    capture.comparisonId,
  );
  assert.ok(exported);
  const copiedExport = structuredClone(exported);
  assert.equal(
    copiedExport.sides.find((side) => side.rightText !== undefined)?.rightText,
    "ensemble-turn-capture-marker-v1\n",
  );
  harness.guard.recordCapture(capture);

  web = await harness.fixture.startWeb();
  const credentials = await login(web);
  const firstRead = await fetch(
    `${web.origin}/api/operator/tasks/${harness.taskId}/comparisons?target=last-turn`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(firstRead.status, 200);
  const firstBody = (await firstRead.json()) as {
    data: {
      state: string;
      comparisonId: string;
      comparison: {
        workId: string;
        profileId: string;
        threadId: string;
        turnId: string;
        entries: Array<{ path: string; right?: { sha256: string } }>;
      };
    };
  };
  assert.equal(firstBody.data.state, "available");
  assert.equal(firstBody.data.comparisonId, capture.comparisonId);
  assert.equal(firstBody.data.comparison.workId, harness.workId);
  assert.equal(firstBody.data.comparison.profileId, harness.profileId);
  assert.equal(firstBody.data.comparison.threadId, capture.threadId);
  assert.equal(firstBody.data.comparison.turnId, capture.turnId);
  assert.equal(
    firstBody.data.comparison.entries.find(
      (entry) => entry.path === "turn-marker.txt",
    )?.right?.sha256,
    markerSha256(),
  );
  assert.ok(!JSON.stringify(firstBody).includes(harness.workspacePath));
  await web.close();
  web = undefined;

  await harness.reopen();
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(harness.guard.snapshot().reopenCount, 1);
  assert.equal(runtimes[1]?.turns, 0);
  assert.equal(
    harness.fixture.service.workspaceTurnCaptureSlots(harness.taskId)
      .latestFinished?.comparisonId,
    capture.comparisonId,
  );
  assert.deepEqual(
    harness.fixture.service.workspaceComparisonExport(
      harness.taskId,
      capture.comparisonId,
    ),
    copiedExport,
  );

  web = await harness.fixture.startWeb();
  const reopenedCredentials = await login(web);
  const reopenedRead = await fetch(
    `${web.origin}/api/operator/tasks/${harness.taskId}/comparisons?target=last-turn`,
    { headers: { cookie: reopenedCredentials.cookie } },
  );
  assert.equal(reopenedRead.status, 200);
  const reopenedBody = (await reopenedRead.json()) as {
    data: { state: string; comparisonId: string };
  };
  assert.equal(reopenedBody.data.state, "available");
  assert.equal(reopenedBody.data.comparisonId, capture.comparisonId);
  await web.close();
  web = undefined;

  await assert.rejects(
    runtimes[1]!.startTurn(
      "fixture-thread",
      harness.workspacePath,
      "second turn",
    ),
    /turn-capture-one-attempt-guard-rejected-dispatch/,
  );
  assert.equal(runtimes[1]?.turns, 0);
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(harness.guard.snapshot().rejectedStartTurnCalls, 1);
  assert.equal(
    readFileSync(harness.checkpointPath, "utf8").includes('"attemptLimit": 1'),
    true,
  );
  await harness.close();
  closed = true;
});

test("delayed setup, turn-start response and terminal remain inside the one-dispatch gate", async (t) => {
  const runtimes: RecordingTurnCaptureRuntime[] = [];
  const harness = await createTurnCaptureHarness({
    allowUnverifiedProcessExitForTests: true,
    runtimeFactory(context) {
      const runtime = new RecordingTurnCaptureRuntime(context, {
        delayThreadStart: true,
        delayTurnStartResponse: true,
        delayTerminal: true,
      });
      runtimes.push(runtime);
      return runtime;
    },
  });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      const runtime = runtimes[0];
      runtime?.releaseThreadStart();
      runtime?.releaseTurnStartResponse();
      runtime?.releaseTerminal("completed");
      if (harness.guard.snapshot().terminalStatus !== undefined)
        await harness.fixture.close(undefined, undefined, true);
    }
    disposeAttemptDirectory(harness.fixture.directory);
    disposeAttemptDirectory(harness.checkpointDirectory);
  });

  await harness.activateTarget();
  const runtime = runtimes[0];
  assert.ok(runtime);
  await bounded(runtime.threadStartEntered.promise, "normal lead-thread setup");
  assert.equal(harness.guard.snapshot().startTurnCalls, 0);
  assert.equal(runtime.turns, 0);

  runtime.releaseThreadStart();
  await bounded(harness.guard.startEntered, "single target turn dispatch");
  await bounded(
    runtime.turnStartResponseEntered.promise,
    "delayed turn-start response",
  );
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(runtime.turns, 0);

  runtime.releaseTurnStartResponse();
  await bounded(
    runtime.terminalEntered.promise,
    "delayed terminal observation",
  );
  assert.equal(runtime.turns, 1);
  assert.equal(harness.guard.snapshot().turnId, "fixture-turn-1");
  assert.ok(harness.guard.remainingStartupMs() > 0);
  assert.ok(harness.guard.remainingTotalMs() > 0);
  runtime.releaseTerminal("completed");
  assert.equal(
    await bounded(harness.guard.terminal, "delayed terminal completion"),
    "completed",
  );
  await until(
    () =>
      harness.fixture.service
        .list()
        .find((work) => work.workId === harness.workId)?.state === "completed",
    "delayed successful handoff",
  );
  harness.markCaptureObserved();
  await harness.close();
  closed = true;
});

test("Stop after an assertion failure retains uncertain work and its checkpoint across reopen", async (t) => {
  const runtimes: RecordingTurnCaptureRuntime[] = [];
  const processIdentities: Array<{
    processId: string;
    processStartedAt: string;
    bootId: string;
  }> = [];
  const harness = await createTurnCaptureHarness({
    allowUnverifiedProcessExitForTests: true,
    runtimeFactory(context) {
      const identity = {
        processId: String(51000 + processIdentities.length),
        processStartedAt: `offline fake runtime ${processIdentities.length}`,
        bootId: "offline-fake-boot",
      };
      const runtime = new RecordingTurnCaptureRuntime(context, {
        delayTerminal: true,
      }) as RecordingTurnCaptureRuntime & {
        processIdentity(): typeof identity;
      };
      runtime.processIdentity = () => identity;
      processIdentities.push(identity);
      runtimes.push(runtime);
      return runtime;
    },
  });
  let disposed = false;
  t.after(async () => {
    if (!disposed) {
      const runtime = runtimes[0];
      runtime?.releaseThreadStart();
      runtime?.releaseTurnStartResponse();
      runtime?.releaseTerminal("failed");
      await harness.fixture.close(undefined, undefined, true);
    }
    disposeAttemptDirectory(harness.fixture.directory);
    disposeAttemptDirectory(harness.checkpointDirectory);
  });

  await harness.activateTarget();
  const runtime = runtimes[0];
  assert.ok(runtime);
  await bounded(runtime.terminalEntered.promise, "turn waiting before Stop");
  harness.guard.recordAssertionFailure();
  await assert.rejects(
    harness.close(),
    /turn-capture-unsettled-fixture-retained/,
  );
  assert.equal(
    readFileSync(harness.checkpointPath, "utf8").includes(
      '"startTurnCalls": 1',
    ),
    true,
  );

  harness.guard.recordStopRequest();
  const stop = await bounded(
    harness.fixture.service.stopTask(harness.taskId),
    "bounded service Stop observation",
    turnCaptureHarnessBudgets.shutdownMs,
  );
  harness.guard.recordStopObservation(stop);
  assert.equal(stop.outcomes.length, 1);
  assert.equal(stop.outcomes[0]?.interrupt, "acknowledged");
  assert.equal(stop.outcomes[0]?.terminal, "unknown");
  assert.equal(runtime.stopObservation().interrupted, 1);
  assert.equal(runtime.stopObservation().terminal, undefined);
  assert.ok(harness.fixture.service.taskHold(harness.taskId));
  assert.equal(harness.guard.snapshot().stopTerminal, "unknown");
  assert.equal(harness.guard.snapshot().rejectedStartTurnCalls, 0);
  const firstIdentity = harness.guard.snapshot().processIdentity;
  assert.deepEqual(firstIdentity, processIdentities[0]);

  runtime.releaseTerminal("failed");
  assert.equal(
    await bounded(harness.guard.terminal, "failed terminal reconciliation"),
    "failed",
  );
  await until(() => {
    const slots = harness.fixture.service.workspaceTurnCaptureSlots(
      harness.taskId,
    );
    return slots.pending?.outcome === "failed";
  }, "failed capture settlement after Stop");
  const pending = harness.markCaptureObserved();
  assert.ok(pending);
  assert.equal(pending.outcome, "failed");
  assert.notEqual(pending.captureState, "finished");
  assert.ok(harness.fixture.service.taskHold(harness.taskId));
  await assert.rejects(
    harness.close(),
    /turn-capture-held-or-unfinished-fixture-retained/,
  );
  assert.equal(harness.guard.snapshot().processExitVerifiedAt, undefined);

  await harness.reopen();
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);
  assert.equal(harness.guard.snapshot().reopenCount, 1);
  assert.deepEqual(
    harness.guard.snapshot().processIdentity,
    processIdentities[1],
  );
  assert.notDeepEqual(harness.guard.snapshot().processIdentity, firstIdentity);
  assert.equal(harness.guard.snapshot().serviceStopReturnedAt, undefined);
  assert.equal(harness.guard.snapshot().processExitVerifiedAt, undefined);
  assert.ok(harness.fixture.service.taskHold(harness.taskId));
  assert.equal(runtimes[1]?.turns, 0);
  assert.equal(harness.latestCapture()?.comparisonId, pending.comparisonId);
  await assert.rejects(
    runtimes[1]!.startTurn(
      "fixture-thread",
      harness.workspacePath,
      "repair retry",
    ),
    /turn-capture-one-attempt-guard-rejected-dispatch/,
  );
  assert.equal(runtimes[1]?.turns, 0);
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);

  await harness.stopPreservingFixture();
  const checkpoint = JSON.parse(
    readFileSync(harness.checkpointPath, "utf8"),
  ) as {
    status: string;
    startTurnCalls: number;
    stopTerminal: string;
    terminalStatus: string;
    shutdownCount: number;
    serviceStopReturnedAt: number;
    shutdownTaskHold: string | null;
    processExitVerifiedAt?: string;
  };
  assert.equal(checkpoint.status, "service-stop-returned");
  assert.equal(checkpoint.startTurnCalls, 1);
  assert.equal(checkpoint.stopTerminal, "unknown");
  assert.equal(checkpoint.terminalStatus, "failed");
  assert.equal(checkpoint.shutdownCount, 2);
  assert.equal(checkpoint.processExitVerifiedAt, undefined);
  assert.notEqual(checkpoint.shutdownTaskHold, null);
  assert.equal(existsSync(harness.fixture.directory), true);
  await assert.rejects(
    harness.finalizeVerifiedFixtureCleanup(),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.throws(
    () =>
      harness.guard.recordShutdownVerified(processIdentities[1]!, {
        kind: "verified",
        processIdentity: processIdentities[1]!,
        verifiedAt: new Date(
          checkpoint.serviceStopReturnedAt! + 1,
        ).toISOString(),
        method: "mac-pid-absent-same-boot",
      }),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.equal(existsSync(harness.fixture.directory), true);
  await harness.fixture.close(undefined, undefined, true);
  disposed = true;
});

test("process-proof-required cleanup rejects bad proof and deletes only after exact persisted proof", async (t) => {
  const runtimeIdentity = {
    processId: "42123",
    processStartedAt: "Thu Oct  8 03:59:40 2026",
    bootId: "F899F669-079B-4A1A-AE7B-D0FBDF33047C",
  };
  let testRuntime: RecordingTurnCaptureRuntime | undefined;
  const harness = await createTurnCaptureHarness({
    runtimeFactory(context) {
      const runtime = new RecordingTurnCaptureRuntime(
        context,
      ) as RecordingTurnCaptureRuntime & {
        processIdentity(): typeof runtimeIdentity;
      };
      runtime.processIdentity = () => runtimeIdentity;
      testRuntime = runtime;
      return runtime;
    },
  });
  let removed = false;
  t.after(async () => {
    if (!removed) await harness.fixture.close(undefined, undefined, true);
    disposeAttemptDirectory(harness.fixture.directory);
    disposeAttemptDirectory(harness.checkpointDirectory);
  });

  await harness.activateTarget();
  const runtime = harness.fixture.runtime as RecordingTurnCaptureRuntime;
  await bounded(
    runtime.terminalEntered.promise,
    "cleanup-gate fixture terminal",
  );
  assert.equal(
    await bounded(harness.guard.terminal, "cleanup-gate runtime terminal"),
    "completed",
  );
  await until(
    () =>
      harness.fixture.service
        .list()
        .find((work) => work.workId === harness.workId)?.state === "completed",
    "cleanup-gate successful handoff",
  );
  const capture = harness.markCaptureObserved();
  assert.ok(capture);
  const exported = harness.fixture.service.workspaceComparisonExport(
    harness.taskId,
    capture.comparisonId,
  );
  assert.ok(exported);
  const copiedExport = structuredClone(exported);
  await harness.stopPreservingFixture();

  const checkpoint = harness.guard.snapshot();
  assert.deepEqual(checkpoint.processIdentity, runtimeIdentity);
  assert.ok(checkpoint.shutdownDeadlineAt);
  assert.equal(checkpoint.shutdownTaskHold, null);
  assert.deepEqual(checkpoint.shutdownWorkStates, [
    { workId: harness.workId, state: "completed" },
  ]);
  assert.deepEqual(checkpoint.shutdownRunningWorkIds, []);
  assert.throws(
    () => harness.fixture.service.list(),
    /Service is not started/,
    "the service is closed before exit proof and cleanup",
  );
  assert.throws(
    () => harness.fixture.service.taskHold(harness.taskId),
    /Service is not started/,
  );
  const database = new DatabaseSync(
    join(harness.fixture.directory, "data", "standalone.sqlite"),
    { readOnly: true, timeout: 1000 },
  );
  try {
    const row = database
      .prepare(`SELECT captureState, payloadJson FROM workspace_turn_captures
        WHERE taskId = ? AND comparisonId = ?`)
      .get(harness.taskId, capture.comparisonId) as
      | { captureState: string; payloadJson: string }
      | undefined;
    assert.ok(row);
    const reopenedCapture = JSON.parse(row.payloadJson) as {
      comparisonId: string;
      comparison: unknown;
      sides: unknown;
      captureState: string;
    };
    assert.equal(row.captureState, "finished");
    assert.equal(reopenedCapture.comparisonId, capture.comparisonId);
    assert.deepEqual(reopenedCapture.comparison, copiedExport.comparison);
    assert.deepEqual(reopenedCapture.sides, copiedExport.sides);
  } finally {
    database.close();
  }
  assert.throws(
    () =>
      harness.guard.recordShutdownVerified(runtimeIdentity, {
        kind: "verified",
        processIdentity: { ...runtimeIdentity, processId: "42124" },
        verifiedAt: new Date().toISOString(),
        method: "mac-pid-absent-same-boot",
      }),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.throws(
    () =>
      harness.guard.recordShutdownVerified(runtimeIdentity, {
        kind: "verified",
        processIdentity: runtimeIdentity,
        verifiedAt: new Date(checkpoint.shutdownDeadlineAt! + 1).toISOString(),
        method: "mac-pid-absent-same-boot",
      }),
    /turn-capture-shutdown-exit-not-verified/,
  );

  await assert.rejects(
    harness.finalizeVerifiedFixtureCleanup(),
    /turn-capture-shutdown-exit-not-verified/,
  );
  await assert.rejects(
    harness.close(),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.equal(existsSync(harness.fixture.directory), true);
  assert.equal(harness.guard.snapshot().status, "service-stop-returned");
  assert.equal(harness.guard.snapshot().processExitVerifiedAt, undefined);
  assert.equal(testRuntime?.turns, 1);

  harness.guard.recordShutdownVerified(runtimeIdentity, {
    kind: "verified",
    processIdentity: runtimeIdentity,
    verifiedAt: new Date(checkpoint.serviceStopReturnedAt! + 1).toISOString(),
    method: "mac-pid-absent-same-boot",
  });
  await harness.finalizeVerifiedFixtureCleanup();
  removed = true;
  assert.equal(existsSync(harness.fixture.directory), false);
});

test("setup failure preserves its stopped fixture and checkpoint before any dispatch", async () => {
  let retainedFixture:
    | { directory: string; service: { list(): unknown[] } }
    | undefined;
  let retainedGuard: OneTurnAttemptGuard | undefined;
  let retainedCheckpointPath: string | undefined;
  await assert.rejects(
    createTurnCaptureHarness({
      taskTitle: "",
      runtimeFactory(context) {
        return new RecordingTurnCaptureRuntime(context);
      },
    }),
    (error: unknown) => {
      const partial = error as Error & {
        fixture?: { directory: string; service: { list(): unknown[] } };
        turnCaptureGuard?: OneTurnAttemptGuard;
        turnCaptureCheckpointPath?: string;
        turnCaptureSetupCleanupFailure?: unknown;
      };
      retainedFixture = partial.fixture;
      retainedGuard = partial.turnCaptureGuard;
      retainedCheckpointPath = partial.turnCaptureCheckpointPath;
      assert.ok(retainedFixture);
      assert.ok(retainedGuard);
      assert.equal(partial.turnCaptureSetupCleanupFailure, undefined);
      const checkpoint = retainedGuard.snapshot();
      assert.equal(checkpoint.startTurnCalls, 0);
      assert.equal(checkpoint.attemptLimit, 1);
      assert.ok(checkpoint.runtimeStopReturnedAt);
      assert.equal(checkpoint.serviceStopReturnedAt, undefined);
      assert.equal(existsSync(retainedFixture.directory), true);
      assert.throws(
        () => retainedFixture!.service.list(),
        /Service is not started/,
      );
      return true;
    },
  );
  assert.ok(retainedFixture);
  assert.ok(retainedCheckpointPath);
  assert.equal(existsSync(retainedCheckpointPath), true);
  disposeAttemptDirectory(retainedFixture.directory);
  disposeAttemptDirectory(dirname(retainedCheckpointPath));
});

test("shutdown checkpoint rejects mismatched and out-of-budget process evidence", async (t) => {
  const checkpointDirectory = mkdtempSync(
    join(tmpdir(), "ensemble-turn-capture-shutdown-"),
  );
  const guard = new OneTurnAttemptGuard(
    join(checkpointDirectory, "attempt.json"),
  );
  t.after(() => disposeAttemptDirectory(checkpointDirectory));
  const identity = {
    processId: "42123",
    processStartedAt: "Thu Oct  8 03:59:40 2026",
    bootId: "F899F669-079B-4A1A-AE7B-D0FBDF33047C",
  };
  const context = {
    safety: {} as RuntimeSpawnContext["safety"],
    spawnEnvironment: () => ({}),
  };
  const runtime = new RecordingTurnCaptureRuntime(
    context,
  ) as RecordingTurnCaptureRuntime & {
    processIdentity(): typeof identity;
  };
  runtime.processIdentity = () => identity;
  guard.arm("task", "work", "/private/workspace");
  const guarded = guard.guardRuntime(runtime);
  await guarded.start();
  guard.recordShutdownState({
    observedAt: Date.now(),
    taskHold: undefined,
    workStates: [{ workId: "work", state: "completed" }],
    runningWorkIds: [],
  });
  await guarded.stop();
  guard.recordServiceStopReturned();
  const deadline = guard.snapshot().shutdownDeadlineAt;
  assert.ok(deadline);

  assert.throws(
    () =>
      guard.recordShutdownVerified(identity, {
        kind: "verified",
        processIdentity: { ...identity, processId: "42124" },
        verifiedAt: new Date().toISOString(),
        method: "mac-pid-absent-same-boot",
      }),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.throws(
    () =>
      guard.recordShutdownVerified(identity, {
        kind: "verified",
        processIdentity: identity,
        verifiedAt: new Date(deadline + 1).toISOString(),
        method: "mac-pid-absent-same-boot",
      }),
    /turn-capture-shutdown-exit-not-verified/,
  );
  assert.equal(guard.snapshot().processExitVerifiedAt, undefined);
  assert.equal(guard.snapshot().status, "service-stop-returned");
});

test("the private attempt ledger enforces the single-use and reconciliation bounds", (t) => {
  const checkpointDirectory = mkdtempSync(
    join(tmpdir(), "ensemble-turn-capture-ledger-"),
  );
  const checkpointPath = join(checkpointDirectory, "attempt.json");
  const guard = new OneTurnAttemptGuard(checkpointPath, "ledger-test");
  t.after(() => disposeAttemptDirectory(checkpointDirectory));
  assert.throws(
    () => new OneTurnAttemptGuard(checkpointPath, "retry-is-forbidden"),
    /turn-capture-attempt-checkpoint-already-exists/,
  );

  guard.arm("task", "work", "/private/workspace");
  const armed = guard.snapshot();
  assert.equal(armed.attemptLimit, 1);
  assert.equal(armed.startTurnCalls, 0);
  assert.equal(guard.remainingStartupMs(armed.startupDeadlineAt!), 0);
  assert.equal(guard.remainingTotalMs(armed.totalDeadlineAt!), 0);

  for (
    let read = 1;
    read <= turnCaptureHarnessBudgets.maxReconciliationReads;
    read++
  ) {
    guard.recordReconciliationRead(
      armed.dispatchArmedAt! +
        read * turnCaptureHarnessBudgets.reconciliationIntervalMs,
    );
  }
  assert.equal(
    guard.snapshot().reconciliationReads,
    turnCaptureHarnessBudgets.maxReconciliationReads,
  );
  assert.throws(
    () =>
      guard.recordReconciliationRead(
        armed.dispatchArmedAt! +
          (turnCaptureHarnessBudgets.maxReconciliationReads + 1) *
            turnCaptureHarnessBudgets.reconciliationIntervalMs,
      ),
    /turn-capture-reconciliation-budget-exhausted/,
  );
  assert.equal(guard.snapshot().startTurnCalls, 0);
});

test("a supplied shared checkpoint parent is rejected without changing its mode", async (t) => {
  const sharedDirectory = mkdtempSync(
    join(tmpdir(), "ensemble-wi03-shared-parent-"),
  );
  chmodSync(sharedDirectory, 0o755);
  t.after(() => disposeAttemptDirectory(sharedDirectory));
  const checkpointPath = join(sharedDirectory, "attempt.json");
  const before = lstatSync(sharedDirectory).mode & 0o777;
  await assert.rejects(
    createTurnCaptureHarness({
      checkpointPath,
      runtimeFactory(context) {
        return new RecordingTurnCaptureRuntime(context);
      },
    }),
    /turn-capture-checkpoint-directory-not-private/,
  );
  assert.equal(lstatSync(sharedDirectory).mode & 0o777, before);
  assert.equal(existsSync(checkpointPath), false);
});
