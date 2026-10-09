// #782 guarded reduced actual-runtime journey. NOT AUTHORISED until the owner
// grants one run. Only Node built-ins load before the argument check, so a
// refusal constructs nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const requiredArgs = ["--live", "--three-turns"];
const argv = process.argv.slice(2);
if (
  argv.length !== requiredArgs.length ||
  !requiredArgs.every((argument) => argv.includes(argument))
) {
  process.stderr.write(
    "Refusing actual Codex execution without exactly --live --three-turns.\n",
  );
  process.exit(2);
}

const { CodexRuntime } = await import("../../dist/src/standalone/index.js");
const { MacProcessTerminationVerifier } = await import(
  "../../dist/src/standalone/termination.js"
);
const {
  createInspectionJourneyHarness,
  inspectionJourneyBudgets: budgets,
  inspectionJourneyMarkers: markers,
  sha256,
  verifyInspectionJourneyExecutable,
} = await import("../../dist/test/fixtures/inspection-journey-harness.js");
const { tmpdir } = await import("../../dist/test/temp.js");

const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const codexVersion = "0.162.0-alpha.2";
let executableSha256;
try {
  executableSha256 = verifyInspectionJourneyExecutable(
    codexExecutable,
    process.env.ENSEMBLE_WI782_CODEX_SHA256,
  );
} catch (error) {
  process.stderr.write(
    `Refusing actual Codex execution: ${error instanceof Error ? error.message : String(error)}.\n`,
  );
  process.exit(2);
}

const attemptDirectory = mkdtempSync(
  join(tmpdir(), "ensemble-wi782-live-attempt-"),
);
chmodSync(attemptDirectory, 0o700);
const checkpointPath = join(attemptDirectory, "journey.json");
const evidencePath = join(attemptDirectory, "evidence.json");
const fileSha256 = (path) => sha256(readFileSync(path));
const evidence = {
  schemaVersion: 1,
  issue: 782,
  state: "running",
  source: {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    packageManager: "npm@12.2.0",
    entrySha256: fileSha256(new URL(import.meta.url)),
    harnessCompiledSha256: fileSha256(
      "dist/test/fixtures/inspection-journey-harness.js",
    ),
    runtimeSourceSha256: fileSha256("src/standalone/codex.ts"),
    runtimeCompiledSha256: fileSha256("dist/src/standalone/codex.js"),
  },
  runtime: {
    executable: codexExecutable,
    version: codexVersion,
    executableSha256,
    processIdentity: null,
    preflight: null,
  },
  budgets: { ...budgets },
  starts: [],
  captures: {},
  results: {},
  stop: null,
  reads: [],
  ui: { screenshots: [], assertions: [], consoleErrors: [], race503s: [] },
  sqliteReopen: null,
  shutdown: {
    serviceStopReturned: false,
    processExitVerified: false,
    processExit: null,
  },
  retainedFixture: null,
  checkpointPath,
  checkpoint: null,
  unproved: [],
  failure: null,
  recoveryFailure: null,
};

let harness;
let web;
let browser;
const runtimes = [];
let stage = "construct-private-harness";

const identitySnapshot = (identity) =>
  identity
    ? {
        processId: identity.processId,
        processStartedAt: identity.processStartedAt,
        bootId: identity.bootId,
      }
    : null;
const sameIdentity = (left, right) =>
  Boolean(
    left &&
      right &&
      left.processId === right.processId &&
      left.processStartedAt === right.processStartedAt &&
      left.bootId === right.bootId,
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    clearTimeout(timer);
  }
}

async function waitFor(check, deadline, description) {
  while (Date.now() < deadline) {
    harness.guard.assertWithinTotalDeadline();
    const value = check();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`${description}-deadline-exceeded`);
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("inspection-journey-session-cookie-missing");
  return cookie;
}

async function login(operatorWeb) {
  const anonymous = await fetch(`${operatorWeb.origin}/api/operator/session`);
  const csrf = (await anonymous.json()).csrfToken;
  const response = await fetch(`${operatorWeb.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(anonymous),
      origin: operatorWeb.origin,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    },
    body: JSON.stringify({ password: operatorWeb.password }),
  });
  assert.equal(response.status, 200);
  return sessionCookie(response);
}

async function read(cookie, path) {
  const response = await fetch(`${web.origin}${path}`, { headers: { cookie } });
  const text = await response.text();
  assert.ok(!text.includes(harness.workspacePath), `${path} hides workspace`);
  evidence.reads.push({ path, status: response.status });
  assert.equal(response.status, 200, path);
  return JSON.parse(text).data;
}

function service() {
  return harness.fixture.service;
}

function recordStart(role) {
  const start = harness.guard.start(role);
  const planned = harness.plan[role];
  evidence.starts = evidence.starts.filter((item) => item.role !== role);
  evidence.starts.push({
    role,
    assignmentId: planned?.assignmentId,
    ...start,
    durationMs:
      start?.terminalAt !== undefined
        ? start.terminalAt - start.enteredAt
        : null,
  });
}

function entry(capture, path) {
  return capture.comparison?.entries.find((item) => item.path === path);
}

function retainedItem(resultId, path) {
  const store = service().retainedEvidence();
  const item = store
    .result(harness.taskId, resultId)
    ?.items.find((candidate) => candidate.path === path);
  assert.ok(item?.state === "available", `${path} retained for ${resultId}`);
  const bytes = store.item(harness.taskId, resultId, item.itemId)?.bytes;
  assert.ok(bytes);
  return { item, text: Buffer.from(bytes).toString("utf8") };
}

/** One planned completed turn (T1/T2): admit, terminal, settle, identity checks. */
async function plannedTurn(role) {
  stage = `${role}-admit`;
  const start = await harness.admit(role);
  recordStart(role);
  stage = `${role}-terminal`;
  const terminal = await bounded(
    harness.guard.terminal(role),
    start.enteredAt + budgets.turnMs,
    `inspection-journey-${role}-terminal`,
  );
  stage = `${role}-settle`;
  const settled = await harness.settle(role, Date.now() + budgets.settleMs);
  recordStart(role);
  const turn = harness.guard.start(role);
  if (terminal !== "completed") {
    harness.guard.recordUnproved(`${role}-completed-terminal`);
    harness.guard.recordDeviation(`${role}-terminal-${terminal}`);
    throw new Error(`inspection-journey-${role}-terminal-${terminal}`);
  }
  const capture = settled.capture;
  assert.ok(capture, `${role} capture`);
  assert.equal(capture.captureState, "finished");
  assert.equal(capture.identity.workId, harness.plan[role].workId);
  assert.equal(capture.identity.assignmentId, harness.plan[role].assignmentId);
  assert.equal(capture.threadId, turn.threadId);
  assert.equal(capture.turnId, turn.turnId);
  assert.equal(
    service().workspaceTurnCaptureSlots(harness.taskId).latestFinished
      ?.comparisonId,
    capture.comparisonId,
  );
  evidence.captures[role] = {
    comparisonId: capture.comparisonId,
    workId: capture.identity.workId,
    assignmentId: capture.identity.assignmentId,
    threadId: capture.threadId,
    turnId: capture.turnId,
    captureState: capture.captureState,
    outcome: capture.outcome,
    startedAt: new Date(capture.startedAt).toISOString(),
    observedAt: new Date(capture.observedAt).toISOString(),
  };
  evidence.results[role] = { resultId: settled.resultId };
  // A turn without a result stays unproved. The next planned admission refuses
  // while its automatic reporting repair is queued, so the journey stops there.
  return { ...settled, turn };
}

async function stopWeb() {
  const current = web;
  web = undefined;
  if (current) await current.close();
}

async function closeBrowser() {
  const current = browser;
  browser = undefined;
  if (current) await current.close();
}

async function verifyStoppedProcess() {
  const checkpoint = harness.guard.snapshot();
  const identity = checkpoint.processIdentity;
  if (!identity || !checkpoint.shutdownDeadlineAt)
    throw new Error("inspection-journey-shutdown-identity-missing");
  const verifier = new MacProcessTerminationVerifier();
  let latest;
  while (Date.now() <= checkpoint.shutdownDeadlineAt) {
    latest = await verifier.verify(identity);
    if (latest.kind === "verified") {
      harness.guard.recordShutdownVerified(identity, latest);
      evidence.shutdown.processExitVerified = true;
      evidence.shutdown.processExit = {
        verifiedAt: latest.verifiedAt,
        method: latest.method,
        processIdentity: identitySnapshot(latest.processIdentity),
      };
      return;
    }
    await pause(100);
  }
  evidence.shutdown.processExit = latest ?? { kind: "unknown" };
  throw new Error("inspection-journey-process-exit-not-verified-within-budget");
}

async function shutdown() {
  await stopWeb();
  const identity = await runtimes.at(-1)?.processIdentity?.();
  if (!sameIdentity(identity, harness.guard.snapshot().processIdentity))
    throw new Error("inspection-journey-runtime-process-identity-mismatch");
  await bounded(
    harness.stopPreservingFixture(),
    Date.now() + budgets.shutdownMs,
    "inspection-journey-service-stop",
  );
  evidence.shutdown.serviceStopReturned = true;
  await verifyStoppedProcess();
}

async function uiPass(expected) {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(15_000);
    const consoleErrors = [];
    const unavailable503s = [];
    page.on("response", (response) => {
      if (
        response.status() === 503 &&
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.startsWith("/api/operator/")
      )
        unavailable503s.push(response.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.goto(
      `${web.origin}/app/tasks/${harness.taskId}?section=changes`,
    );
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const changes = page.locator("#changes");
    await changes
      .getByRole("heading", { name: "Workspace comparisons", exact: true })
      .waitFor();
    await changes.getByLabel("Comparison target").selectOption("last-turn");
    const identity = changes.getByLabel(
      expected.lastTurnPending ? "Current actual turn" : "Last turn identity",
    );
    await identity.waitFor();
    const identityText = await identity.innerText();
    for (const value of [expected.lastTurnWorkId, expected.lastTurnTurnId])
      assert.ok(identityText.includes(value), `${viewport.width} ${value}`);
    const lastTurnShot = join(
      attemptDirectory,
      `ui-${viewport.width}-last-turn.png`,
    );
    await identity.screenshot({ path: lastTurnShot });
    chmodSync(lastTurnShot, 0o600);

    await page.goto(
      `${web.origin}/app/tasks/${harness.taskId}?section=review&result=${expected.r1}&evidence=${expected.r1ItemId}`,
    );
    const retained = page.locator(".retained-evidence");
    await retained
      .getByRole("heading", { name: "Retained result evidence", exact: true })
      .waitFor();
    await retained
      .getByText(markers.marker1A.trimEnd(), { exact: true })
      .first()
      .waitFor();
    assert.equal(
      await retained.getByText(markers.marker1B.trimEnd()).count(),
      0,
      "retained R1 never shows later bytes",
    );
    assert.ok((await retained.innerText()).includes(expected.r1));
    const retainedShot = join(
      attemptDirectory,
      `ui-${viewport.width}-retained-r1.png`,
    );
    await retained.screenshot({ path: retainedShot });
    chmodSync(retainedShot, 0o600);

    // Only documented race 503s (a GET observed as 503 unavailable) are tolerated.
    const unexpected = consoleErrors.filter(
      (text) => !(/\b503\b/.test(text) && unavailable503s.length > 0),
    );
    evidence.ui.race503s.push(...unavailable503s);
    evidence.ui.consoleErrors.push(...consoleErrors);
    evidence.ui.screenshots.push(lastTurnShot, retainedShot);
    evidence.ui.assertions.push({
      width: viewport.width,
      lastTurnIdentity: identityText.replace(/\s+/g, " ").trim(),
      retainedR1Visible: true,
      laterBytesHidden: true,
      unexpectedConsoleErrors: unexpected.length,
    });
    assert.deepEqual(unexpected, []);
    await page.close();
  }
  await closeBrowser();
}

function sqliteReopen(expected) {
  const database = new DatabaseSync(
    join(harness.fixture.directory, "data", "standalone.sqlite"),
    { readOnly: true, timeout: 1000 },
  );
  try {
    const slot = database
      .prepare(`SELECT latestFinishedId, pendingId
        FROM workspace_turn_capture_slots WHERE taskId = ?`)
      .get(harness.taskId);
    assert.ok(slot);
    assert.equal(slot.latestFinishedId, expected.slots.latestFinishedId);
    assert.equal(slot.pendingId, expected.slots.pendingId);
    const captures = {};
    for (const role of ["T1", "T2", "T3"]) {
      const id = evidence.captures[role]?.comparisonId;
      if (!id) continue;
      const row = database
        .prepare(`SELECT captureState FROM workspace_turn_captures
          WHERE taskId = ? AND comparisonId = ?`)
        .get(harness.taskId, id);
      captures[role] = row?.captureState ?? "missing";
    }
    // Only the latest-turn slots persist: C2 replaced C1, and T3 is pending or finished.
    assert.equal(captures.T1, "missing");
    assert.equal(
      captures.T2,
      expected.slots.latestFinishedId === evidence.captures.T2?.comparisonId
        ? "finished"
        : "missing",
    );
    if (expected.slots.pendingId)
      assert.equal(captures.T3, expected.pendingCaptureState);
    const item = database
      .prepare(`SELECT content, sha256 FROM retained_result_evidence_items
        WHERE resultId = ? AND path = 'marker-1.txt' AND state = 'available'`)
      .get(expected.r1);
    assert.ok(item);
    assert.equal(Buffer.from(item.content).toString("utf8"), markers.marker1A);
    assert.equal(item.sha256, sha256(markers.marker1A));
    const hold = database
      .prepare(`SELECT reason FROM task_writer_ambiguity_holds WHERE taskId = ?
        UNION ALL SELECT reason FROM task_writer_holds WHERE taskId = ?
        UNION ALL SELECT reason FROM task_archival_holds WHERE taskId = ? LIMIT 1`)
      .get(harness.taskId, harness.taskId, harness.taskId);
    assert.equal(hold?.reason ?? null, expected.hold ?? null);
    evidence.sqliteReopen = {
      openedReadOnly: true,
      slot,
      captures,
      r1Marker1Sha256: item.sha256,
      hold: hold?.reason ?? null,
    };
  } finally {
    database.close();
  }
}

async function recoverFailure() {
  try {
    await stopWeb();
    await closeBrowser();
  } catch (error) {
    evidence.recoveryFailure = `ui-close:${error.message}`;
  }
  try {
    try {
      harness.setPaused(true);
    } catch {
      // Already paused or the service is stopped.
    }
    const checkpoint = harness.guard.snapshot();
    if (checkpoint.serviceStopReturnedAt === undefined) {
      const unfinished = checkpoint.starts.some(
        (start) => start.terminal === undefined,
      );
      if (unfinished && checkpoint.stopRequestedAt === undefined) {
        const observation = await bounded(
          harness.stopTask(),
          Date.now() + budgets.stopMs,
          "inspection-journey-recovery-stop",
        );
        evidence.stop = { recovery: true, outcomes: observation.outcomes };
      }
      if (unfinished) {
        const deadline = Date.now() + budgets.settleMs;
        while (
          Date.now() < deadline &&
          harness.guard.snapshot().starts.some((s) => s.terminal === undefined)
        )
          await pause(100);
      }
      // Stop the service even if work is unsettled: the fixture and any hold are
      // retained, and the runtime process must not outlive the journey.
      await shutdown();
    } else if (harness.guard.snapshot().processExitVerifiedAt === undefined) {
      await verifyStoppedProcess();
    }
  } catch (error) {
    evidence.recoveryFailure ??=
      error instanceof Error ? error.message : String(error);
  }
}

try {
  stage = "create-production-service-harness";
  try {
    harness = await createInspectionJourneyHarness({
      checkpointPath,
      runtimeFactory(context) {
        if (!context.safety || typeof context.spawnEnvironment !== "function")
          throw new Error(
            "inspection-journey-production-runtime-context-incomplete",
          );
        const runtime = new CodexRuntime(codexExecutable, context);
        runtimes.push(runtime);
        return runtime;
      },
    });
  } catch (error) {
    if (error?.fixture) evidence.retainedFixture = error.fixture.directory;
    if (error?.journeyGuard)
      evidence.checkpoint = error.journeyGuard.snapshot();
    throw error;
  }
  evidence.retainedFixture = harness.fixture.directory;

  stage = "preflight";
  const identity = await runtimes[0]?.processIdentity?.();
  assert.ok(identity);
  assert.equal(runtimes.length, 1);
  assert.ok(sameIdentity(identity, harness.guard.snapshot().processIdentity));
  evidence.runtime.processIdentity = identitySnapshot(identity);
  const preflight = harness.guard.snapshot();
  assert.equal(preflight.startTurnCalls, 0);
  assert.equal(preflight.runtimeStarts, 1);
  assert.equal(
    preflight.contextSafetyProvided &&
      preflight.contextSpawnEnvironmentProvided,
    true,
  );
  assert.equal(Number(service().domain().project(harness.projectId).paused), 1);
  evidence.runtime.preflight = {
    // CodexRuntime.start validates both reads and rejects anything else.
    accountReadValidatedAs: "chatgpt",
    configReadValidated: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
    },
    runtimeStartReturnedBeforeDispatch: true,
    serviceSafetyAndSpawnEnvironmentProvided: true,
    projectPaused: true,
    startTurnCallsBeforeDispatch: preflight.startTurnCalls,
  };

  // T1: the task's initial lead turn writes marker-1 = A and reports R1.
  const t1 = await plannedTurn("T1");
  assert.ok(t1.capture);
  const c1Marker = entry(t1.capture, "marker-1.txt");
  assert.ok(c1Marker);
  assert.equal(c1Marker.left, undefined);
  assert.equal(c1Marker.right?.sha256, sha256(markers.marker1A));
  if (t1.resultId) {
    assert.equal(
      retainedItem(t1.resultId, "marker-1.txt").text,
      markers.marker1A,
    );
  }

  // T2: an operator-created assignment on the same task overwrites marker-1 = B.
  stage = "T2-create";
  harness.createPlannedAssignment("T2");
  const t2 = await plannedTurn("T2");
  assert.notEqual(t2.capture.comparisonId, t1.capture.comparisonId);
  assert.notEqual(t2.capture.turnId, t1.capture.turnId);
  const c2Marker1 = entry(t2.capture, "marker-1.txt");
  assert.equal(c2Marker1?.left?.sha256, sha256(markers.marker1A));
  assert.equal(c2Marker1?.right?.sha256, sha256(markers.marker1B));
  const c2Marker2 = entry(t2.capture, "marker-2.txt");
  assert.equal(c2Marker2?.left, undefined);
  assert.equal(c2Marker2?.right?.sha256, sha256(markers.marker2));
  if (!t1.resultId) throw new Error("inspection-journey-R1-unavailable");
  // WI07: the later change leaves R1's retained bytes unchanged.
  const r1 = retainedItem(t1.resultId, "marker-1.txt");
  assert.equal(r1.text, markers.marker1A);
  evidence.results.T1.marker1Sha256 = r1.item.sha256;

  // T3: writes marker-3, then a long bounded command; Stop as soon as it runs.
  stage = "T3-create";
  harness.createPlannedAssignment("T3");
  stage = "T3-admit";
  const t3Start = await harness.admit("T3");
  recordStart("T3");
  const stopDeadline = t3Start.enteredAt + budgets.stopMs;
  stage = "T3-observe-running";
  await waitFor(
    () =>
      harness.guard.start("T3")?.turnId !== undefined &&
      service().workspaceTurnCaptureSlots(harness.taskId).pending?.identity
        .workId === harness.plan.T3.workId,
    stopDeadline,
    "inspection-journey-T3-running",
  );
  stage = "T3-stop";
  const observation = await bounded(
    harness.stopTask(),
    stopDeadline,
    "inspection-journey-T3-stop",
  );
  const t3Terminal = await bounded(
    harness.guard.terminal("T3"),
    stopDeadline,
    "inspection-journey-T3-terminal",
  );
  const t3 = await harness.settle("T3", Date.now() + budgets.settleMs);
  recordStart("T3");
  const hold = service().taskHold(harness.taskId);
  evidence.stop = {
    requestedAt: harness.guard.snapshot().stopRequestedAt,
    outcomes: observation.outcomes,
    terminal: t3Terminal,
    hold: hold ?? null,
    marker3PresentAfterStop: existsSync(
      join(harness.workspacePath, "marker-3.txt"),
    ),
  };
  if (t3.capture)
    evidence.captures.T3 = {
      comparisonId: t3.capture.comparisonId,
      workId: t3.capture.identity.workId,
      turnId: t3.capture.turnId,
      captureState: t3.capture.captureState,
      outcome: t3.capture.outcome,
      reason: t3.capture.reason ?? null,
    };
  evidence.results.T3 = { resultId: t3.resultId };
  // Model behaviour is uncontrolled: a T3 that finished before Stop is unproved, not retried.
  if (t3Terminal === "completed")
    harness.guard.recordUnproved("T3-interrupted-terminal");
  if (!hold) harness.guard.recordUnproved("T3-stop-hold");
  if (
    !t3.capture ||
    (t3.capture.captureState === "finished" &&
      t3.capture.outcome === "completed" &&
      !t3.capture.reason)
  )
    harness.guard.recordUnproved("T3-uncertain-capture-disclosure");

  stage = "authenticated-production-reads";
  const readsDeadline = Date.now() + budgets.readsMs;
  web = await bounded(harness.fixture.startWeb(), readsDeadline, "web-start");
  const cookie = await bounded(login(web), readsDeadline, "login");
  const slots = service().workspaceTurnCaptureSlots(harness.taskId);
  const lastTurn = await bounded(
    read(
      cookie,
      `/api/operator/tasks/${harness.taskId}/comparisons?target=last-turn`,
    ),
    readsDeadline,
    "last-turn-read",
  );
  let lastTurnWorkId;
  let lastTurnTurnId;
  if (slots.pending) {
    assert.equal(lastTurn.state, "unsettled");
    assert.equal(lastTurn.pending.comparisonId, slots.pending.comparisonId);
    assert.equal(lastTurn.pending.identity.workId, harness.plan.T3.workId);
    assert.equal(lastTurn.pending.turnId, harness.guard.start("T3").turnId);
    assert.equal(
      lastTurn.latestFinished?.comparisonId,
      slots.latestFinished?.comparisonId,
    );
    lastTurnWorkId = lastTurn.pending.identity.workId;
    lastTurnTurnId = lastTurn.pending.turnId;
  } else {
    assert.ok(slots.latestFinished);
    assert.equal(lastTurn.comparisonId, slots.latestFinished.comparisonId);
    const role = ["T1", "T2", "T3"].find(
      (candidate) =>
        harness.plan[candidate]?.workId === lastTurn.comparison.workId,
    );
    assert.ok(role);
    assert.equal(lastTurn.comparison.turnId, harness.guard.start(role).turnId);
    lastTurnWorkId = lastTurn.comparison.workId;
    lastTurnTurnId = lastTurn.comparison.turnId;
  }
  const r1Evidence = await bounded(
    read(
      cookie,
      `/api/operator/tasks/${harness.taskId}/results/${t1.resultId}/evidence`,
    ),
    readsDeadline,
    "r1-evidence-read",
  );
  assert.ok(["available", "partial", "gap"].includes(r1Evidence.state));
  assert.equal(r1Evidence.identity.workId, harness.plan.T1.workId);
  assert.equal(r1Evidence.identity.turnId, t1.turn.turnId);
  const r1Listed = r1Evidence.items.find(
    (item) => item.path === "marker-1.txt",
  );
  assert.equal(r1Listed?.state, "available");
  assert.equal(r1Listed.sha256, sha256(markers.marker1A));
  const r1Item = await bounded(
    read(
      cookie,
      `/api/operator/tasks/${harness.taskId}/results/${t1.resultId}/evidence/${r1Listed.itemId}`,
    ),
    readsDeadline,
    "r1-item-read",
  );
  assert.equal(r1Item.state, "available");
  assert.equal(r1Item.preview.kind, "text");
  assert.equal(r1Item.preview.text, markers.marker1A);

  stage = "production-ui";
  await bounded(
    uiPass({
      lastTurnPending: Boolean(slots.pending),
      lastTurnWorkId,
      lastTurnTurnId,
      r1: t1.resultId,
      r1ItemId: r1Listed.itemId,
    }),
    Math.min(
      Date.now() + budgets.uiMs,
      harness.guard.snapshot().totalDeadlineAt,
    ),
    "production-ui",
  );

  stage = "verified-service-stop-and-process-exit";
  const expectedSlots = {
    latestFinishedId:
      service().workspaceTurnCaptureSlots(harness.taskId).latestFinished
        ?.comparisonId ?? null,
    pendingId:
      service().workspaceTurnCaptureSlots(harness.taskId).pending
        ?.comparisonId ?? null,
  };
  const pendingCaptureState = service().workspaceTurnCaptureSlots(
    harness.taskId,
  ).pending?.captureState;
  const expectedHold = service().taskHold(harness.taskId);
  await shutdown();

  stage = "read-only-sqlite-reopen";
  sqliteReopen({
    slots: expectedSlots,
    pendingCaptureState,
    r1: t1.resultId,
    hold: expectedHold,
  });
  assert.equal(harness.guard.snapshot().startTurnCalls, 3);
  assert.deepEqual(harness.guard.snapshot().rejectedStarts, []);
  evidence.state =
    harness.guard.snapshot().unproved.length === 0
      ? "passed"
      : "completed-with-unproved-rows";
} catch (error) {
  evidence.state = "failed";
  evidence.failure = {
    stage,
    message: error instanceof Error ? error.message : String(error),
  };
  if (harness) {
    if (harness.guard.snapshot().status !== "deviation") {
      try {
        harness.guard.recordAssertionFailure(`${stage}-failed`);
      } catch (recordError) {
        evidence.recoveryFailure = `assertion-record:${recordError.message}`;
      }
    }
    await recoverFailure();
  }
}

if (harness) {
  const checkpoint = harness.guard.snapshot();
  for (const role of ["T1", "T2", "T3"]) {
    const start = checkpoint.starts.find((item) => item.role === role);
    if (!start) harness.guard.recordUnproved(`${role}-start`);
    if (start && !evidence.starts.some((item) => item.role === role))
      recordStart(role);
  }
  if (evidence.sqliteReopen === null)
    harness.guard.recordUnproved("sqlite-reopen");
  if (evidence.ui.assertions.length < 2)
    harness.guard.recordUnproved("production-ui");
  evidence.checkpoint = harness.guard.snapshot();
  evidence.unproved = evidence.checkpoint.unproved;
  evidence.shutdown.serviceStopReturned =
    evidence.checkpoint.serviceStopReturnedAt !== undefined;
  // The fixture is never removed: a Stop hold or uncertain owner stays for recovery.
  evidence.retainedFixture = harness.fixture.directory;
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`,
);
if (evidence.state !== "passed") process.exitCode = 1;
