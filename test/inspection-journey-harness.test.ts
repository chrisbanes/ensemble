import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { StandaloneService } from "../src/standalone/service.js";
import {
  createInspectionJourneyHarness,
  type InspectionJourneyHarness,
  InspectionJourneyGuard,
  inspectionJourneyBudgets,
  inspectionJourneyMarkers as markers,
  sha256,
  verifyInspectionJourneyExecutable,
} from "./fixtures/inspection-journey-harness.js";
import { OperatorFixtureRuntime } from "./fixtures/operator-web.js";
import { tmpdir } from "./temp.js";

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function privateDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function journey(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-wi782-test-"));
  chmodSync(directory, 0o700);
  let runtime!: OperatorFixtureRuntime;
  const harness = await createInspectionJourneyHarness({
    checkpointPath: join(directory, "journey.json"),
    runtimeFactory() {
      runtime = new OperatorFixtureRuntime();
      return runtime;
    },
  });
  t.after(async () => {
    if (harness.guard.snapshot().serviceStopReturnedAt === undefined)
      await harness.fixture.close(undefined, undefined, true);
    rmSync(harness.fixture.directory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  return { harness, runtime };
}

function intent(service: StandaloneService, workId: string) {
  const found = service.list().find((item) => item.workId === workId);
  assert.ok(found?.threadId && found.turnId, `${workId} bound`);
  return { threadId: found.threadId, turnId: found.turnId };
}

/** Plays the model for one planned turn: optional writes, optional report, terminal. */
async function playTurn(
  h: InspectionJourneyHarness,
  runtime: OperatorFixtureRuntime,
  role: "T1" | "T2" | "T3",
  writes: Record<string, string>,
  report: string[] | undefined,
) {
  const turn = h.guard.snapshot().startTurnCalls;
  await until(() => runtime.hasPending(turn), `${role} pending`);
  for (const [name, text] of Object.entries(writes))
    writeFileSync(join(h.workspacePath, name), text);
  if (report) {
    const reported = await runtime.callTool({
      ...intent(h.fixture.service, h.plan[role]!.workId),
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: `${role} result`,
        review: { changes: { files: report } },
      },
    });
    assert.equal(reported.success, true, reported.text);
  }
  runtime.complete(turn);
  assert.equal(await h.guard.terminal(role), "completed");
  return h.settle(role, Date.now() + inspectionJourneyBudgets.settleMs);
}

function retainedBytes(
  h: InspectionJourneyHarness,
  resultId: string,
  path: string,
) {
  const store = h.fixture.service.retainedEvidence();
  const item = store
    .result(h.taskId, resultId)
    ?.items.find((candidate) => candidate.path === path);
  assert.ok(item?.state === "available", `${path} retained`);
  return store.item(h.taskId, resultId, item.itemId)?.bytes.toString("utf8");
}

test("WI782 entry refuses without exactly --live --three-turns before any setup", (t) => {
  const root = privateDirectory(t, "ensemble-wi782-refusal-");
  for (const args of [[], ["--three-turns"], ["--one-attempt"]]) {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "test/wi782/live-inspection-journey.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, TMPDIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.trim(),
      "Refusing actual Codex execution without exactly --live --three-turns.",
    );
  }
  assert.deepEqual(readdirSync(root), []);
});

test("WI782 executable preflight refuses a missing, malformed or mismatched hash", (t) => {
  const directory = privateDirectory(t, "ensemble-wi782-exe-");
  const executable = join(directory, "codex");
  writeFileSync(executable, "approved bytes");
  const hash = sha256("approved bytes");
  assert.throws(
    () => verifyInspectionJourneyExecutable(executable, undefined),
    /hash-missing/,
  );
  assert.throws(
    () => verifyInspectionJourneyExecutable(executable, "ABC"),
    /hash-missing/,
  );
  assert.throws(
    () => verifyInspectionJourneyExecutable(join(directory, "absent"), hash),
    /executable-unavailable/,
  );
  assert.throws(
    () => verifyInspectionJourneyExecutable(executable, sha256("other")),
    /hash-mismatch/,
  );
  assert.equal(verifyInspectionJourneyExecutable(executable, hash), hash);
});

test("WI782 guard persists its checkpoint, refuses restart and fails closed on deadlines and order", async (t) => {
  const directory = privateDirectory(t, "ensemble-wi782-guard-");
  const path = join(directory, "journey.json");
  const guard = new InspectionJourneyGuard(path);
  assert.throws(() => new InspectionJourneyGuard(path), /already-exists/);
  const open = privateDirectory(t, "ensemble-wi782-open-");
  chmodSync(open, 0o755);
  assert.throws(
    () => new InspectionJourneyGuard(join(open, "j.json")),
    /not-private/,
  );

  const runtime = guard.guardRuntime(new OperatorFixtureRuntime());
  guard.bindWorkResolver(() => "work-1");
  assert.throws(
    () => guard.arm("T1", "work-1"),
    /T1-not-armable/,
    "task must be bound",
  );
  guard.bindTask(randomUUID(), "/workspace");
  assert.throws(
    () => guard.arm("T2", "work-2"),
    /T2-not-armable/,
    "roles are ordered",
  );
  await assert.rejects(
    runtime.startTurn("thread", "/workspace", "p"),
    /unplanned-start/,
  );
  assert.equal(guard.snapshot().startTurnCalls, 0);
  assert.throws(
    () => guard.arm("T1", "work-1"),
    /not-armable/,
    "a refusal is final",
  );

  const second = new InspectionJourneyGuard(join(directory, "second.json"));
  const guarded = second.guardRuntime(new OperatorFixtureRuntime());
  second.bindWorkResolver(() => "work-1");
  second.bindTask(randomUUID(), "/workspace");
  const armedAt = Date.now() - inspectionJourneyBudgets.admissionMs - 1;
  second.arm("T1", "work-1", armedAt);
  await assert.rejects(
    guarded.startTurn("thread", "/workspace", "p"),
    /admission-deadline-exceeded/,
  );
  await assert.rejects(second.started("T1"), /admission-deadline-exceeded/);
  assert.throws(
    () =>
      second.assertWithinTotalDeadline(
        armedAt + inspectionJourneyBudgets.totalMs + 1,
      ),
    /total-deadline-exceeded/,
  );
  const snapshot = second.snapshot();
  assert.equal(snapshot.status, "uncertain");
  assert.equal(snapshot.startTurnCalls, 0);
  assert.deepEqual(
    snapshot.rejectedStarts.map((rejection) => rejection.reason),
    ["admission-deadline-exceeded"],
  );
  const persisted = join(directory, "second.json");
  assert.deepEqual(
    JSON.parse(readFileSync(persisted, "utf8")),
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.equal(lstatSync(persisted).mode & 0o777, 0o600);
});

test("WI782 offline journey: three planned starts, retained R1 bytes, then Stop leaves a hold and a retained fixture", async (t) => {
  const { harness: h, runtime } = await journey(t);
  const service = h.fixture.service;
  assert.equal(Number(service.domain().project(h.projectId).paused), 1);
  assert.equal(h.guard.snapshot().contextSafetyProvided, true);

  await h.admit("T1");
  const t1 = await playTurn(
    h,
    runtime,
    "T1",
    { "marker-1.txt": markers.marker1A },
    ["marker-1.txt"],
  );
  assert.ok(t1.resultId);
  assert.equal(t1.capture?.captureState, "finished");
  assert.equal(retainedBytes(h, t1.resultId, "marker-1.txt"), markers.marker1A);

  h.createPlannedAssignment("T2");
  await h.admit("T2");
  const t2 = await playTurn(
    h,
    runtime,
    "T2",
    { "marker-1.txt": markers.marker1B, "marker-2.txt": markers.marker2 },
    ["marker-1.txt", "marker-2.txt"],
  );
  assert.ok(t2.resultId);
  const slots = service.workspaceTurnCaptureSlots(h.taskId);
  assert.equal(slots.latestFinished?.comparisonId, t2.capture?.comparisonId);
  assert.notEqual(t2.capture?.comparisonId, t1.capture?.comparisonId);
  assert.notEqual(t2.capture?.turnId, t1.capture?.turnId);
  assert.equal(retainedBytes(h, t1.resultId, "marker-1.txt"), markers.marker1A);
  assert.equal(retainedBytes(h, t2.resultId, "marker-1.txt"), markers.marker1B);

  h.createPlannedAssignment("T3");
  await h.admit("T3");
  await until(() => runtime.hasPending(3), "T3 pending");
  await until(
    () =>
      service.workspaceTurnCaptureSlots(h.taskId).pending?.identity.workId ===
      h.plan.T3?.workId,
    "T3 pending capture",
  );
  writeFileSync(join(h.workspacePath, "marker-3.txt"), markers.marker3);
  const stop = h.stopTask();
  runtime.fail(3);
  await stop;
  assert.equal(await h.guard.terminal("T3"), "failed");
  await h.settle("T3", Date.now() + inspectionJourneyBudgets.settleMs);
  const hold = service.taskHold(h.taskId);
  assert.ok(hold, "Stop leaves a task hold");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtime.turns, 3);
  const checkpoint = h.guard.snapshot();
  assert.deepEqual(
    checkpoint.starts.map((start) => [start.role, start.workId]),
    [
      ["T1", h.plan.T1?.workId],
      ["T2", h.plan.T2?.workId],
      ["T3", h.plan.T3?.workId],
    ],
  );
  assert.deepEqual(checkpoint.rejectedStarts, []);
  assert.deepEqual(checkpoint.unproved, []);
  assert.equal(checkpoint.starts[2]?.terminal, "failed");

  await h.stopPreservingFixture();
  const stopped = h.guard.snapshot();
  assert.equal(stopped.status, "service-stop-returned");
  assert.equal(stopped.shutdownTaskHold, hold);
  assert.deepEqual(stopped.shutdownUnsettledWorkIds, []);
  assert.ok(
    existsSync(h.fixture.directory),
    "fixture with a Stop hold is retained",
  );
});

test("WI782 guard refuses a fourth start: an unreported T3 queues a reporting repair", async (t) => {
  const { harness: h, runtime } = await journey(t);
  await h.admit("T1");
  await playTurn(h, runtime, "T1", { "marker-1.txt": markers.marker1A }, [
    "marker-1.txt",
  ]);
  h.createPlannedAssignment("T2");
  await h.admit("T2");
  await playTurn(h, runtime, "T2", { "marker-2.txt": markers.marker2 }, [
    "marker-2.txt",
  ]);
  h.createPlannedAssignment("T3");
  await h.admit("T3");
  // The model ends T3 without reporting, so the service queues a reporting repair.
  const t3 = await playTurn(h, runtime, "T3", {}, undefined);
  assert.equal(t3.resultId, null);
  assert.ok(h.unplannedWork().length > 0, "reporting repair is queued");

  // Simulate an admission leak: the repair reaches the guard and is refused.
  h.setPaused(false);
  await h.fixture.service.provisionTask(h.taskId);
  await until(
    () => h.guard.snapshot().rejectedStarts.length > 0,
    "fourth start refusal",
  );
  h.setPaused(true);
  const checkpoint = h.guard.snapshot();
  assert.equal(checkpoint.startTurnCalls, 3);
  assert.equal(checkpoint.rejectedStarts[0]?.reason, "start-limit-reached");
  assert.equal(checkpoint.status, "deviation");
  assert.deepEqual(checkpoint.unproved, []);
  assert.equal(runtime.turns, 3, "the refused start never reached the runtime");
});

test("WI782 journey stops before T2 when T1 ends without a result and a repair is queued", async (t) => {
  const { harness: h, runtime } = await journey(t);
  await h.admit("T1");
  const t1 = await playTurn(
    h,
    runtime,
    "T1",
    { "marker-1.txt": markers.marker1A },
    undefined,
  );
  assert.equal(t1.resultId, null);
  h.createPlannedAssignment("T2");
  await assert.rejects(h.admit("T2"), /unplanned-work-before-T2/);
  const checkpoint = h.guard.snapshot();
  assert.deepEqual(checkpoint.deviations, ["unplanned-work-queued-before-T2"]);
  assert.deepEqual(checkpoint.unproved, ["T1-result"]);
  assert.equal(
    Number(h.fixture.service.domain().project(h.projectId).paused),
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtime.turns, 1);
});
