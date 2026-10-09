// #828 guarded bounded actual-runtime journey: the lead reports a result and
// completes, the operator sends one local review while the project is paused,
// and the resumed lead's turn receives the review's anchors. One attempt only.
// Only Node built-ins load before the argument check, so a refusal constructs nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const requiredArgs = ["--live", "--follow-up"];
const argv = process.argv.slice(2);
if (
  argv.length !== requiredArgs.length ||
  !requiredArgs.every((argument) => argv.includes(argument))
) {
  process.stderr.write(
    "Refusing actual Codex execution without exactly --live --follow-up.\n",
  );
  process.exit(2);
}

const { randomUUID } = await import("node:crypto");
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
const codexVersion = execFileSync(codexExecutable, ["--version"], {
  encoding: "utf8",
}).trim();

const attemptDirectory = mkdtempSync(
  join(tmpdir(), "ensemble-wi828-live-attempt-"),
);
chmodSync(attemptDirectory, 0o700);
const checkpointPath = join(attemptDirectory, "journey.json");
const evidencePath = join(attemptDirectory, "evidence.json");
const fileSha256 = (path) => sha256(readFileSync(path));
const evidence = {
  schemaVersion: 1,
  issue: 828,
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
    coordinationCompiledSha256: fileSha256("dist/src/core/coordination.js"),
  },
  runtime: {
    executable: codexExecutable,
    version: codexVersion,
    executableSha256,
  },
  budgets: { ...budgets },
  starts: [],
  t1: null,
  review: null,
  t2: null,
  shutdown: { serviceStopReturned: false, processExitVerified: false },
  retainedFixture: null,
  checkpointPath,
  checkpoint: null,
  unproved: [],
  failure: null,
  recoveryFailure: null,
};

let harness;
let web;
const runtimes = [];
const prompts = [];
let stage = "construct-private-harness";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameIdentity = (left, right) =>
  Boolean(
    left &&
      right &&
      left.processId === right.processId &&
      left.processStartedAt === right.processStartedAt &&
      left.bootId === right.bootId,
  );

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

const service = () => harness.fixture.service;

function recordStart(role) {
  const start = harness.guard.start(role);
  evidence.starts = evidence.starts.filter((item) => item.role !== role);
  if (start) evidence.starts.push({ ...start });
}

/** Admit one planned lead turn, wait for its terminal and settle its result. */
async function plannedTurn(role) {
  stage = `${role}-admit`;
  const start = await harness.admit(role);
  recordStart(role);
  stage = `${role}-terminal`;
  const terminal = await bounded(
    harness.guard.terminal(role),
    start.enteredAt + budgets.turnMs,
    `follow-up-journey-${role}-terminal`,
  );
  stage = `${role}-settle`;
  const settled = await harness.settle(role, Date.now() + budgets.settleMs);
  recordStart(role);
  if (terminal !== "completed") {
    harness.guard.recordUnproved(`${role}-completed-terminal`);
    throw new Error(`follow-up-journey-${role}-terminal-${terminal}`);
  }
  return { ...settled, terminal, turn: harness.guard.start(role) };
}

function cookieOf(response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("follow-up-journey-session-cookie-missing");
  return cookie;
}

async function operatorSession() {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anonymousCsrf = (await anonymous.json()).csrfToken;
  const response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: cookieOf(anonymous),
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anonymousCsrf,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  const cookie = cookieOf(response);
  const csrf = (await response.json()).csrfToken;
  const post = async (command) => {
    const result = await fetch(`${web.origin}/api/operator/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(command),
    });
    const body = await result.json();
    assert.equal(
      result.status,
      200,
      `${command.type}: ${JSON.stringify(body)}`,
    );
    return body;
  };
  const get = async (path) => {
    const result = await fetch(`${web.origin}${path}`, { headers: { cookie } });
    const text = await result.text();
    assert.ok(!text.includes(harness.workspacePath), `${path} hides workspace`);
    assert.equal(result.status, 200, path);
    return JSON.parse(text).data;
  };
  return { post, get };
}

function readDatabase(read) {
  const database = new DatabaseSync(
    join(harness.fixture.directory, "data", "standalone.sqlite"),
    { readOnly: true, timeout: 1000 },
  );
  try {
    return read(database);
  } finally {
    database.close();
  }
}

async function verifyStoppedProcess() {
  const checkpoint = harness.guard.snapshot();
  const identity = checkpoint.processIdentity;
  if (!identity || !checkpoint.shutdownDeadlineAt)
    throw new Error("follow-up-journey-shutdown-identity-missing");
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
      };
      return;
    }
    await pause(100);
  }
  evidence.shutdown.processExit = latest ?? { kind: "unknown" };
  throw new Error("follow-up-journey-process-exit-not-verified-within-budget");
}

async function shutdown() {
  const current = web;
  web = undefined;
  if (current) await current.close();
  const identity = await runtimes.at(-1)?.processIdentity?.();
  if (!sameIdentity(identity, harness.guard.snapshot().processIdentity))
    throw new Error("follow-up-journey-runtime-process-identity-mismatch");
  await bounded(
    harness.stopPreservingFixture(),
    Date.now() + budgets.shutdownMs,
    "follow-up-journey-service-stop",
  );
  evidence.shutdown.serviceStopReturned = true;
  await verifyStoppedProcess();
}

async function recoverFailure() {
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
          "follow-up-journey-recovery-stop",
        );
        evidence.recoveryStop = observation.outcomes;
      }
      await shutdown();
    } else if (harness.guard.snapshot().processExitVerifiedAt === undefined) {
      await verifyStoppedProcess();
    }
  } catch (error) {
    evidence.recoveryFailure ??=
      error instanceof Error ? error.message : String(error);
  }
}

const scope =
  "Use only this local workspace write and the required result-reporting action. Do not delegate, ask a question, request approval, invoke an external action, use network access or modify any other file.";

try {
  stage = "create-production-service-harness";
  try {
    harness = await createInspectionJourneyHarness({
      checkpointPath,
      runtimeFactory(context) {
        if (!context.safety || typeof context.spawnEnvironment !== "function")
          throw new Error("follow-up-journey-runtime-context-incomplete");
        const runtime = new CodexRuntime(codexExecutable, context);
        // Keep each submitted prompt so the resumed turn's input can be checked.
        const startTurn = runtime.startTurn.bind(runtime);
        runtime.startTurn = async (threadId, workspace, prompt) => {
          prompts.push({ threadId, prompt });
          return startTurn(threadId, workspace, prompt);
        };
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
  const leadId = harness.plan.T1.assignmentId;

  stage = "preflight";
  assert.equal(runtimes.length, 1);
  assert.ok(
    sameIdentity(
      await runtimes[0].processIdentity(),
      harness.guard.snapshot().processIdentity,
    ),
  );
  assert.equal(harness.guard.snapshot().startTurnCalls, 0);
  assert.equal(Number(service().domain().project(harness.projectId).paused), 1);

  // T1: the lead writes marker-1 and reports its result, completing its assignment.
  const t1 = await plannedTurn("T1");
  evidence.t1 = {
    workId: t1.turn.workId,
    threadId: t1.turn.threadId,
    turnId: t1.turn.turnId,
    resultId: t1.resultId,
    leadState: service().domain().assignment(leadId).state,
    leadVersion: Number(service().domain().assignment(leadId).version),
  };
  if (!t1.resultId) throw new Error("follow-up-journey-T1-result-unavailable");
  assert.equal(evidence.t1.leadState, "completed");

  // The operator reviews marker-1 over HTTP while the project stays paused.
  stage = "operator-review";
  web = await bounded(
    harness.fixture.startWeb(),
    Date.now() + budgets.readsMs,
    "web-start",
  );
  const operator = await operatorSession();
  const before = await operator.get(`/api/operator/tasks/${harness.taskId}`);
  assert.equal(before.leadFeedback?.mode, "resumes");
  const staged = await operator.post({
    type: "review.anchor.stage",
    key: randomUUID(),
    taskId: harness.taskId,
    expectedDraftVersion: 0,
    anchors: [
      {
        taskId: harness.taskId,
        repositoryId: null,
        path: "marker-1.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 1,
        contentSha256: sha256(markers.marker1A),
      },
    ],
  });
  const comment = `Create followup-ack.txt in the workspace root containing exactly the retained anchor ID printed in this comment's context (the UUID after "retained anchor") followed by one newline. Then call ensemble_report_result with a short summary and review {"changes":{"files":["followup-ack.txt"]}}. ${scope}`;
  const saved = await operator.post({
    type: "review.draft.save",
    key: randomUUID(),
    taskId: harness.taskId,
    expectedDraftVersion: staged.draftVersion,
    draft: {
      summary: "",
      comments: [
        {
          commentId: randomUUID(),
          body: comment,
          anchorGroupIds: [staged.groupId],
        },
      ],
    },
  });
  const reviewKey = randomUUID();
  const sent = await operator.post({
    type: "review.send",
    key: reviewKey,
    taskId: harness.taskId,
    expectedDraftVersion: saved.version,
    recipientAssignmentId: leadId,
    expectedAssignmentVersion: evidence.t1.leadVersion,
  });
  const operation = await operator.get(
    `/api/operator/tasks/${harness.taskId}/local-reviews/${reviewKey}`,
  );
  const anchorIds = operation.groups.flatMap((group) =>
    group.anchors.map((anchor) => anchor.anchorId),
  );
  assert.equal(anchorIds.length, 1);
  const lead = service().domain().assignment(leadId);
  evidence.review = {
    receiptState: sent.state,
    resumedLead: sent.resumedLead ?? false,
    operationResumedLead: operation.resumedLead ?? false,
    anchorId: anchorIds[0],
    leadStateAfterSend: lead.state,
    leadVersionAfterSend: Number(lead.version),
    startTurnCallsAfterSend: harness.guard.snapshot().startTurnCalls,
  };
  assert.equal(sent.state, "recorded");
  assert.equal(sent.resumedLead, true);
  assert.equal(operation.resumedLead, true);
  assert.equal(lead.state, "pending");
  assert.equal(Number(lead.version), evidence.t1.leadVersion + 1);
  assert.equal(harness.guard.snapshot().startTurnCalls, 1);

  // T2 is the resumed lead turn. Its inbox work id derives from the lead's first
  // pending event, which is the lead's own earlier result event.
  stage = "T2-plan";
  const pending = readDatabase((database) =>
    database
      .prepare(`SELECT event.eventId, event.eventType
        FROM coordination_inbox_events event
        LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
        WHERE event.recipientAssignmentId = ? AND delivery.eventId IS NULL
        ORDER BY event.sequence`)
      .all(leadId),
  );
  evidence.review.pendingEventTypes = pending.map((row) => row.eventType);
  assert.ok(pending.some((row) => row.eventType === "assignment-follow-up"));
  harness.plan.T2 = {
    assignmentId: leadId,
    workId: `assignment:${leadId}:v${evidence.t1.leadVersion + 1}:inbox:${pending[0].eventId}`,
  };
  const t2 = await plannedTurn("T2");
  assert.equal(prompts.length, 2);
  const t2Prompt = prompts[1].prompt;
  const ackPath = join(harness.workspacePath, "followup-ack.txt");
  const ack = existsSync(ackPath) ? readFileSync(ackPath, "utf8") : null;
  const revisions = readDatabase((database) =>
    database
      .prepare(
        "SELECT workId, workRevision FROM task_work_revisions WHERE assignmentId = ? ORDER BY workRevision",
      )
      .all(leadId)
      .map((row) => ({ workId: row.workId, workRevision: row.workRevision })),
  );
  evidence.t2 = {
    workId: t2.turn.workId,
    threadId: t2.turn.threadId,
    turnId: t2.turn.turnId,
    sameThreadAsT1: t2.turn.threadId === evidence.t1.threadId,
    promptHasFollowUpEvent: /assignment-follow-up:/.test(t2Prompt ?? ""),
    promptHasComment: Boolean(t2Prompt?.includes("Create followup-ack.txt")),
    promptHasAnchor: Boolean(
      t2Prompt?.includes(`retained anchor ${evidence.review.anchorId}`),
    ),
    promptSha256: t2Prompt ? sha256(t2Prompt) : null,
    resultId: t2.resultId,
    workRevisions: revisions,
    ackContainsAnchor: ack?.trim() === evidence.review.anchorId,
    ackPresent: ack !== null,
  };
  assert.equal(evidence.t2.sameThreadAsT1, true);
  assert.equal(evidence.t2.promptHasFollowUpEvent, true);
  assert.equal(evidence.t2.promptHasComment, true);
  assert.equal(evidence.t2.promptHasAnchor, true);
  assert.deepEqual(
    revisions.map((row) => row.workRevision),
    [1, 2],
  );
  // Model-dependent rows are disclosed, never retried.
  if (!t2.resultId) harness.guard.recordUnproved("T2-result");
  if (!evidence.t2.ackContainsAnchor)
    harness.guard.recordUnproved("T2-followup-ack-anchor");

  stage = "verified-service-stop-and-process-exit";
  await shutdown();
  assert.equal(harness.guard.snapshot().startTurnCalls, 2);
  assert.equal(
    harness.guard.snapshot().starts.some((start) => start.role === "T3"),
    false,
  );
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
  evidence.checkpoint = harness.guard.snapshot();
  evidence.unproved = evidence.checkpoint.unproved;
  evidence.shutdown.serviceStopReturned =
    evidence.checkpoint.serviceStopReturnedAt !== undefined;
  // The fixture is never removed: an uncertain owner stays for recovery.
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
