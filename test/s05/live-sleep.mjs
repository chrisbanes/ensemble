import { execFile, execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  hostname as readHostname,
  tmpdir as operatingSystemTmpdir,
} from "node:os";
import { createServer } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const maximumSleepMs = 60_000;
const maximumSleepDispatchDelayMs = 5_000;
const minimumWakeLeadAtDispatchMs = 55_000;
const commandTimeoutMs = 10_000;
const maximumCommandOutputBytes = 1024 * 1024;
const windowFields = [
  "approvedBy",
  "endAt",
  "hostname",
  "sleepAt",
  "startAt",
  "version",
  "wakeAt",
];
const scheduledActions = new Set([
  "wake",
  "sleep",
  "shutdown",
  "restart",
  "poweron",
]);

function fail(code) {
  return new Error(code);
}

function scheduleFailure(code, wakeSchedule, reconciliation) {
  const error = fail(code);
  error.wakeSchedule = { ...wakeSchedule, reconciliation };
  return error;
}

export function parseLiveArguments(args) {
  if (!args.includes("--live") || !args.includes("--allow-host-sleep"))
    return { ok: false, reason: "live-host-sleep-guards-required" };

  const windowIndexes = args.flatMap((argument, index) =>
    argument === "--window-record" ? [index] : [],
  );
  if (windowIndexes.length !== 1)
    return { ok: false, reason: "controller-window-record-required" };

  const index = windowIndexes[0];
  const windowPath = args[index + 1];
  if (
    typeof windowPath !== "string" ||
    windowPath.startsWith("--") ||
    !isAbsolute(windowPath)
  )
    return { ok: false, reason: "absolute-window-record-required" };

  if (
    args.length !== 4 ||
    args.some(
      (argument, argumentIndex) =>
        argumentIndex !== index &&
        argumentIndex !== index + 1 &&
        argument !== "--live" &&
        argument !== "--allow-host-sleep",
    )
  )
    return { ok: false, reason: "unsupported-live-option" };

  return { ok: true, windowPath };
}

function canonicalUtc(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  try {
    return new Date(parsed).toISOString() === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function validateWindowRecord(value, expectedHostname, now) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Number.isSafeInteger(now) ||
    typeof expectedHostname !== "string" ||
    expectedHostname.length === 0
  )
    throw fail("window-record-invalid");

  const record = value;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== windowFields.length ||
    keys.some((key, index) => key !== windowFields[index]) ||
    record.version !== 1 ||
    record.approvedBy !== "chrisbanes" ||
    record.hostname !== expectedHostname
  )
    throw fail("window-record-invalid");

  const startAt = canonicalUtc(record.startAt);
  const sleepAt = canonicalUtc(record.sleepAt);
  const wakeAt = canonicalUtc(record.wakeAt);
  const endAt = canonicalUtc(record.endAt);
  if (
    startAt === undefined ||
    sleepAt === undefined ||
    wakeAt === undefined ||
    endAt === undefined ||
    startAt > now ||
    now >= sleepAt ||
    sleepAt >= wakeAt ||
    wakeAt >= endAt ||
    wakeAt - sleepAt !== maximumSleepMs ||
    sleepAt % 1000 !== 0 ||
    wakeAt % 1000 !== 0
  )
    throw fail("window-record-invalid");

  return {
    version: 1,
    approvedBy: "chrisbanes",
    hostname: expectedHostname,
    startAt: record.startAt,
    sleepAt: record.sleepAt,
    wakeAt: record.wakeAt,
    endAt: record.endAt,
  };
}

function localTimeFromParts(month, day, year, hour, minute, second) {
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isSafeInteger(nominal)) return undefined;
  const offsets = new Set(
    [-48, -24, -12, 0, 12, 24, 48].map((hours) =>
      new Date(nominal + hours * 60 * 60 * 1000).getTimezoneOffset(),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => nominal + offset * 60 * 1000)
    .filter((candidate) => {
      const date = new Date(candidate);
      return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute &&
        date.getSeconds() === second
      );
    });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function formatLocalPmsetTime(instant) {
  const date = new Date(instant);
  if (
    !Number.isSafeInteger(instant) ||
    Number.isNaN(date.getTime()) ||
    date.getFullYear() < 2000 ||
    date.getFullYear() > 2099
  )
    throw fail("schedule-time-invalid");
  const roundTrip = localTimeFromParts(
    date.getMonth() + 1,
    date.getDate(),
    date.getFullYear(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
  if (roundTrip !== instant) throw fail("schedule-time-ambiguous-or-invalid");
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parsePmsetSchedule(output) {
  if (typeof output !== "string") return { complete: false, events: [] };
  if (output === "") return { complete: true, events: [] };
  const lines = output.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0 || lines[first]?.trim() !== "Scheduled power events:")
    return { complete: false, events: [] };

  const events = [];
  const indexes = new Set();
  for (let lineIndex = first + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    if (line.trim() === "") continue;
    const match =
      /^\s*\[(\d+)\]\s+(wake|sleep|shutdown|restart|poweron)\s+at\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):([0-5]\d):([0-5]\d)\s+by\s+'([^'\r\n]+)'\s*$/i.exec(
        line,
      );
    if (!match) return { complete: false, events: [] };

    const index = Number(match[1]);
    const action = (match[2] ?? "").toLowerCase();
    const month = Number(match[3]);
    const day = Number(match[4]);
    const yearText = match[5] ?? "";
    const yearValue = Number(yearText);
    const year = yearText.length === 2 ? 2000 + yearValue : yearValue;
    const hour = Number(match[6]);
    const minute = Number(match[7]);
    const second = Number(match[8]);
    const owner = match[9] ?? "";
    const instant = localTimeFromParts(month, day, year, hour, minute, second);
    if (
      !Number.isSafeInteger(index) ||
      indexes.has(index) ||
      !scheduledActions.has(action) ||
      instant === undefined ||
      owner.length === 0
    )
      return { complete: false, events: [] };

    indexes.add(index);
    events.push({
      action,
      localTime: formatLocalPmsetTime(instant),
      instant,
      owner,
    });
  }

  return { complete: true, events };
}

function sameScheduleEvent(left, right) {
  return (
    left.action === right.action &&
    left.localTime === right.localTime &&
    left.instant === right.instant &&
    left.owner === right.owner
  );
}

function preservesBaseline(current, baseline) {
  const unmatched = [...current];
  return baseline.every((expected) => {
    const index = unmatched.findIndex((actual) =>
      sameScheduleEvent(actual, expected),
    );
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
}

function ownWake(events, owner, localWakeTime) {
  const owned = events.filter((event) => event.owner === owner);
  if (owned.length !== 1) return undefined;
  const event = owned[0];
  return event?.action === "wake" && event.localTime === localWakeTime
    ? event
    : undefined;
}

function conflictsWithSleepWindow(events, window) {
  const start = Date.parse(window.sleepAt);
  const end = Date.parse(window.wakeAt);
  return events.some((event) => event.instant >= start && event.instant <= end);
}

async function checkNoninteractivePrivilege(run) {
  try {
    await run("/usr/bin/sudo", ["-n", "true"], commandTimeoutMs);
  } catch {
    throw fail("privilege-preflight-failed");
  }
}

async function readSchedule(run) {
  let result;
  try {
    result = await run("/usr/bin/pmset", ["-g", "sched"], commandTimeoutMs);
  } catch {
    throw fail("schedule-read-failed");
  }
  const parsed = parsePmsetSchedule(result.stdout);
  if (!parsed.complete) throw fail("schedule-read-unparseable");
  return parsed.events;
}

async function cancelExact(run, localWakeTime, owner) {
  await run(
    "/usr/bin/sudo",
    [
      "-n",
      "/usr/bin/pmset",
      "schedule",
      "cancel",
      "wake",
      localWakeTime,
      owner,
    ],
    commandTimeoutMs,
  );
}

function cancellationResult(verified, reconciliation) {
  return { verified, reconciliation };
}

export async function cancelOwnedWake({
  owner,
  localWakeTime,
  baseline,
  run,
  scheduleOutcomeUncertain = false,
}) {
  let before;
  try {
    before = await readSchedule(run);
  } catch {
    return cancellationResult(
      false,
      scheduleOutcomeUncertain
        ? "schedule-outcome-uncertain-before-read-unavailable"
        : "before-read-unavailable",
    );
  }

  const owned = before.filter((event) => event.owner === owner);
  if (owned.length === 0) {
    const preserved = preservesBaseline(before, baseline);
    if (scheduleOutcomeUncertain)
      return cancellationResult(
        false,
        preserved
          ? "schedule-outcome-uncertain-event-currently-absent-baseline-preserved"
          : "schedule-outcome-uncertain-event-currently-absent-baseline-not-preserved",
      );
    return cancellationResult(
      preserved,
      preserved ? "already-absent" : "baseline-not-preserved",
    );
  }
  if (ownWake(before, owner, localWakeTime) === undefined)
    return cancellationResult(
      false,
      scheduleOutcomeUncertain
        ? "schedule-outcome-uncertain-owned-event-not-exact"
        : "owned-event-not-exact",
    );

  try {
    await cancelExact(run, localWakeTime, owner);
  } catch {}

  let after;
  try {
    after = await readSchedule(run);
  } catch {
    return cancellationResult(
      false,
      scheduleOutcomeUncertain
        ? "schedule-outcome-uncertain-after-read-unavailable"
        : "after-read-unavailable",
    );
  }
  const unrelatedBefore = before.filter((event) => event.owner !== owner);
  const preserved =
    preservesBaseline(after, baseline) &&
    preservesBaseline(after, unrelatedBefore);
  if (after.some((event) => event.owner === owner))
    return cancellationResult(
      false,
      scheduleOutcomeUncertain
        ? "schedule-outcome-uncertain-owned-event-still-present"
        : "owned-event-still-present",
    );
  if (scheduleOutcomeUncertain)
    return cancellationResult(
      false,
      preserved
        ? "schedule-outcome-uncertain-after-cancel-event-absent-baseline-preserved"
        : "schedule-outcome-uncertain-after-cancel-event-absent-baseline-not-preserved",
    );
  return cancellationResult(
    preserved,
    preserved
      ? "owned-event-absent-and-baseline-preserved"
      : "baseline-not-preserved",
  );
}

export async function prepareWakeSchedule({ window, fixtureId, run, now }) {
  if (typeof fixtureId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(fixtureId))
    throw fail("fixture-identity-invalid");
  const current = now();
  validateWindowRecord(window, window?.hostname, current);
  if (
    current < Date.parse(window.startAt) ||
    current >= Date.parse(window.sleepAt)
  )
    throw fail("sleep-window-not-open");

  const owner = `ensemble-s05-${fixtureId}`;
  const localWakeTime = formatLocalPmsetTime(Date.parse(window.wakeAt));
  await checkNoninteractivePrivilege(run);
  const baseline = await readSchedule(run);
  if (baseline.some((event) => event.owner === owner))
    throw fail("schedule-owner-already-present");
  if (conflictsWithSleepWindow(baseline, window))
    throw fail("schedule-conflict");
  if (now() >= Date.parse(window.sleepAt)) throw fail("sleep-window-missed");

  let scheduleFailed = false;
  try {
    await run(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/pmset", "schedule", "wake", localWakeTime, owner],
      commandTimeoutMs,
    );
  } catch {
    scheduleFailed = true;
  }

  let after;
  try {
    after = await readSchedule(run);
  } catch {
    try {
      after = await readSchedule(run);
    } catch {
      throw scheduleFailure(
        "schedule-readback-unverified",
        {
          owner,
          localWakeTime,
          baseline,
          scheduleOutcomeUncertain: true,
        },
        "schedule-outcome-unreadable",
      );
    }
  }
  const exact = ownWake(after, owner, localWakeTime);
  if (scheduleFailed) {
    const cancellation = exact
      ? await cancelOwnedWake({ owner, localWakeTime, baseline, run })
      : cancellationResult(false, "exact-owned-event-not-observed");
    throw scheduleFailure(
      "schedule-response-uncertain",
      {
        owner,
        localWakeTime,
        baseline,
        scheduleOutcomeUncertain: !exact,
      },
      `schedule-response-uncertain:${cancellation.reconciliation}`,
    );
  }
  if (
    !exact ||
    !preservesBaseline(after, baseline) ||
    conflictsWithSleepWindow(
      after.filter((event) => event.owner !== owner),
      window,
    )
  ) {
    const cancellation = exact
      ? await cancelOwnedWake({ owner, localWakeTime, baseline, run })
      : cancellationResult(false, "exact-owned-event-not-observed");
    throw scheduleFailure(
      "wake-schedule-readback-failed",
      {
        owner,
        localWakeTime,
        baseline,
        scheduleOutcomeUncertain: !exact,
      },
      `schedule-readback-failed:${cancellation.reconciliation}`,
    );
  }
  if (now() >= Date.parse(window.sleepAt)) {
    const cancellation = await cancelOwnedWake({
      owner,
      localWakeTime,
      baseline,
      run,
    });
    throw scheduleFailure(
      "sleep-window-missed",
      { owner, localWakeTime, baseline },
      `sleep-window-missed:${cancellation.reconciliation}`,
    );
  }
  return {
    owner,
    localWakeTime,
    baseline,
    reconciliation: "schedule-exact-readback-verified",
  };
}

export async function sleepAtApprovedTime({
  window,
  owner,
  localWakeTime,
  baseline,
  run,
  now,
  waitUntil,
}) {
  const sleepAt = Date.parse(window.sleepAt);
  const wakeAt = Date.parse(window.wakeAt);
  const endAt = Date.parse(window.endAt);
  if (now() >= sleepAt) {
    await cancelOwnedWake({ owner, localWakeTime, baseline, run });
    throw fail("sleep-window-expired");
  }

  try {
    await waitUntil(sleepAt);
  } catch {
    await cancelOwnedWake({ owner, localWakeTime, baseline, run });
    throw fail("sleep-window-expired");
  }

  let immediateTime;
  try {
    await checkNoninteractivePrivilege(run);
    const current = await readSchedule(run);
    const currentTime = now();
    if (
      !preservesBaseline(current, baseline) ||
      conflictsWithSleepWindow(
        current.filter((event) => event.owner !== owner),
        window,
      ) ||
      !ownWake(current, owner, localWakeTime) ||
      currentTime < sleepAt ||
      currentTime > sleepAt + maximumSleepDispatchDelayMs ||
      wakeAt - currentTime < minimumWakeLeadAtDispatchMs ||
      currentTime >= wakeAt ||
      currentTime >= endAt
    )
      throw fail("pre-sleep-guard-failed");
    immediateTime = now();
    if (
      immediateTime < sleepAt ||
      immediateTime > sleepAt + maximumSleepDispatchDelayMs ||
      wakeAt - immediateTime < minimumWakeLeadAtDispatchMs ||
      immediateTime >= wakeAt ||
      immediateTime >= endAt
    )
      throw fail("pre-sleep-guard-failed");
  } catch {
    await cancelOwnedWake({ owner, localWakeTime, baseline, run });
    throw fail("pre-sleep-guard-failed");
  }

  try {
    await run(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/pmset", "sleepnow"],
      Math.min(90_000, Math.max(1, endAt - immediateTime)),
    );
  } catch {
    throw fail("sleep-command-outcome-uncertain");
  }
}

function defaultCommandRunner(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maximumCommandOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(fail("host-command-failed"));
        else resolve({ stdout, stderr });
      },
    );
  });
}

function approvedWindowFromFile(windowPath, now) {
  let contents;
  try {
    contents = readFileSync(windowPath);
  } catch {
    throw fail("window-record-unavailable");
  }
  if (contents.byteLength > 8192) throw fail("window-record-invalid");
  let value;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw fail("window-record-invalid");
  }
  return {
    window: validateWindowRecord(value, readHostname(), now),
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashDirectory(repositoryRoot, directory, extension) {
  const digest = createHash("sha256");
  const root = join(repositoryRoot, directory);
  const collectFiles = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return collectFiles(child);
      return entry.isFile() && child.endsWith(extension) ? [child] : [];
    });
  for (const file of collectFiles(root).sort()) {
    digest
      .update(relative(root, file).split(sep).join("/"))
      .update("\0")
      .update(readFileSync(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function identityHash(identity) {
  return identity ? hash(JSON.stringify(identity)) : null;
}

function scheduleBaselineHash(events) {
  return hash(JSON.stringify(events));
}

const safeFailureKinds = new Set([
  "active-ownership-hold-not-retained",
  "active-runtime-count-mismatch",
  "active-work-identity-unavailable",
  "app-server-identity-unavailable",
  "app-server-not-alive-before-sleep",
  "app-server-not-alive-after-wake",
  "assertion-failure-reported",
  "assertion-identity-unavailable",
  "assertion-not-alive-before-sleep",
  "assertion-process-unavailable",
  "assertion-not-alive-after-wake",
  "capacity-one-not-active",
  "duplicate-or-replacement-execution-observed",
  "fixture-identity-invalid",
  "fixture-root-identity-changed",
  "idle-assertion-present",
  "operation-failed",
  "physical-power-log-incomplete-or-ambiguous",
  "physical-sleep-duration-out-of-window",
  "port-unavailable",
  "power-baseline-held",
  "power-baseline-unavailable",
  "pre-sleep-guard-failed",
  "privilege-preflight-failed",
  "question-callback-not-bound",
  "queued-task-not-waiting",
  "queued-work-not-held-after-wake",
  "schedule-conflict",
  "schedule-owner-already-present",
  "schedule-read-failed",
  "schedule-read-unparseable",
  "schedule-readback-unverified",
  "schedule-response-uncertain",
  "schedule-time-ambiguous-or-invalid",
  "schedule-time-invalid",
  "sleep-command-outcome-uncertain",
  "sleep-window-expired",
  "sleep-window-missed",
  "sleep-window-not-open",
  "timeout",
  "wake-reconciliation-did-not-hold-admission",
  "wake-schedule-readback-failed",
  "window-record-invalid",
  "window-record-unavailable",
]);

function failureKind(error) {
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === "string" && safeFailureKinds.has(message)
    ? message
    : "journey-step-failed";
}

function commandText(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: maximumCommandOutputBytes,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

function bounded(action, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail("timeout")), timeoutMs);
    action.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(fail("operation-failed"));
      },
    );
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw fail("timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitUntilTimestamp(timestamp, endAt) {
  while (Date.now() < timestamp) {
    if (Date.now() >= endAt) throw fail("sleep-window-expired");
    const delay = Math.min(1000, timestamp - Date.now(), endAt - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw fail("port-unavailable");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function verifyProcess(verifier, identity, expected) {
  if (!identity || !verifier) return false;
  const deadline = Date.now() + 10_000;
  let latest;
  do {
    try {
      latest = await verifier.verify(identity);
    } catch {
      return false;
    }
    if (expected === "exit" && latest.kind === "verified") return true;
    if (
      expected === "alive" &&
      latest.kind === "conflict" &&
      latest.reason === "Original execution process is still present"
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

function parseEventTimestamp(cursor) {
  const match = /^pmset-event:(\d+):\d+:[a-f0-9]{16}$/.exec(
    cursor?.value ?? "",
  );
  return match ? Number(match[1]) : undefined;
}

function operatorRoutes(currentService, routeTypes) {
  const routes = new routeTypes.OperatorRouteRegistry();
  routes.registerSlot(
    "runtime",
    routeTypes.runtimeOperatorRoutes(currentService),
  );
  routes.registerSlot(
    "coordination",
    routeTypes.coordinationOperatorRoutes(
      currentService.coordinationView(),
      currentService.domain(),
      (projectId) => currentService.routingAvailability(projectId),
    ),
  );
  return routes;
}

async function runLiveJourney(approval) {
  const evidence = {
    source: {},
    window: {
      recordSha256: approval.digest,
      hostIdentitySha256: hash(approval.window.hostname),
    },
    fixture: { created: false, removed: false },
    operator: {
      authenticated: false,
      liveQuestionVisible: false,
      recoveryVisible: false,
    },
    task: { activeTaskId: null, queuedTaskId: null, queuedWhileActive: false },
    runtime: {
      processIdentitySha256: null,
      appServerAliveAfterWake: false,
      threadId: null,
      turnId: null,
      workId: null,
      threadStarts: 0,
      turnStarts: 0,
      questionCallbacks: 0,
    },
    power: {
      idleAssertionAbsent: false,
      activeAssertionVerified: false,
      activeAssertionAliveAfterWake: false,
      assertionProcessIdentitySha256: null,
      assertionFailure: false,
      baselineCursor: null,
      finalCursor: null,
      sleepEvents: 0,
      wakeEvents: 0,
      sleepCursor: null,
      wakeCursor: null,
      admissionHeldAfterWake: false,
      sleepCommandOutcome: "not-run",
      wakeSchedule: null,
    },
    queuedWork: {
      remainedQueuedAfterWake: false,
      additionalRuntimeStarts: 0,
      noExecutionIdentity: false,
    },
    cleanup: {
      browserClosed: false,
      operatorStopped: false,
      serviceStopped: false,
      appServerExitVerified: false,
      caffeinateExitVerified: false,
      wakeScheduleCancellationVerified: null,
    },
    limitations: {
      liveWindowRecordIsAWorkflowGuard:
        "controller-provided approval is not an independent security boundary",
      runtimeIdentity: "Codex uses the existing operator login",
      liveReattachment:
        "unsupported unique inspection retains conservative ownership holds",
      taskContent:
        "prompts, tool payloads, workspace paths and raw logs are omitted",
      prototype:
        "Haze/prototype databases and shared Codex configuration are not read or changed",
    },
    failure: null,
  };

  let stage = "source-identity";
  let root;
  let dataDir;
  let authFile;
  let password = "";
  let service;
  let runtime;
  let auth;
  let http;
  let browser;
  let context;
  let page;
  let eventSource;
  let caffeinateIdentity;
  let caffeinateIdentityPromise;
  let caffeinateChild;
  let caffeinateStartCount = 0;
  let caffeinateFailure = false;
  let appServerIdentity;
  let serviceStartAttempted = false;
  let activeService;
  let activeTaskId;
  let queuedTaskId;
  let preparedWake;
  let questionReleased = false;
  let releaseQuestionCallback;
  const questionCallbackGate = new Promise((resolve) => {
    releaseQuestionCallback = resolve;
  });
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const temporaryRoot = realpathSync(operatingSystemTmpdir());
  let verifier;

  function progress(next) {
    stage = next;
    process.stderr.write(`[s05-sleep] ${next}\n`);
  }

  function command(body) {
    return service.domain().execute({
      key: randomUUID(),
      actor: "operator",
      ...body,
    });
  }

  function noteWakeSchedule(wakeSchedule, preparation) {
    preparedWake = wakeSchedule;
    evidence.power.wakeSchedule = {
      owner: wakeSchedule.owner,
      localTime: wakeSchedule.localWakeTime,
      baselineEventCount: wakeSchedule.baseline.length,
      baselineSha256: scheduleBaselineHash(wakeSchedule.baseline),
      preparation,
      scheduleOutcomeUncertain: wakeSchedule.scheduleOutcomeUncertain === true,
      cleanup: null,
    };
  }

  try {
    progress("source-identity");
    const { MacProcessTerminationVerifier } = await import(
      "../../dist/src/standalone/termination.js"
    );
    verifier = new MacProcessTerminationVerifier();
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    );
    evidence.source = {
      revision: commandText("git", ["rev-parse", "HEAD"], repositoryRoot),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      packageManager: packageJson.packageManager,
      codex: commandText("codex", ["--version"], repositoryRoot),
      productionSourceSha256: hashDirectory(
        repositoryRoot,
        "src/standalone",
        ".ts",
      ),
      compiledProductionSha256: hashDirectory(
        repositoryRoot,
        "dist/src/standalone",
        ".js",
      ),
      codexRuntimeSha256: hash(
        readFileSync(join(repositoryRoot, "src/standalone/codex.ts")),
      ),
      compiledCodexRuntimeSha256: hash(
        readFileSync(join(repositoryRoot, "dist/src/standalone/codex.js")),
      ),
      powerImplementationSha256: hash(
        readFileSync(join(repositoryRoot, "src/standalone/power.ts")),
      ),
      liveHarnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    };

    progress("disposable-fixture-setup");
    root = realpathSync(
      mkdtempSync(join(temporaryRoot, "ensemble-s05-sleep-")),
    );
    chmodSync(root, 0o700);
    evidence.fixture.created = true;
    dataDir = join(root, "data");
    authFile = join(root, "operator-auth.json");
    password = randomBytes(32).toString("base64url");

    const [standalone, operatorTypes, authTypes, powerTypes, terminationTypes] =
      await Promise.all([
        import("../../dist/src/standalone/index.js"),
        import("../../dist/src/standalone/operator.js"),
        import("../../dist/src/standalone/operator-auth.js"),
        import("../../dist/src/standalone/power.js"),
        import("../../dist/src/standalone/termination.js"),
      ]);
    let questionPromiseResolve;
    const questionCallback = new Promise((resolve) => {
      questionPromiseResolve = resolve;
    });

    class ObservedMacPowerEventSource extends powerTypes.MacPowerEventSource {
      batches = [];

      async readSince(cursor) {
        const batch = await super.readSince(cursor);
        this.batches.push({
          complete: batch.complete,
          fromCursor: batch.fromCursor,
          cursor: batch.cursor,
          events: batch.events.map((event) => ({
            cursor: event.cursor,
            transition: event.transition,
          })),
        });
        return batch;
      }
    }

    class ObservedCodexRuntime extends standalone.CodexRuntime {
      threadStarts = 0;
      turnStarts = 0;
      callbacks = [];

      async startThread(...args) {
        this.threadStarts++;
        return super.startThread(...args);
      }

      async startTurn(...args) {
        this.turnStarts++;
        return super.startTurn(...args);
      }

      onToolCall(listener) {
        super.onToolCall(async (call) => {
          const result = await listener(call);
          if (call.tool !== "ensemble_ask_question") return result;
          const intent = activeService
            ?.list()
            .find(
              (item) =>
                item.threadId === call.threadId && item.turnId === call.turnId,
            );
          if (!intent) throw fail("question-callback-not-bound");
          const observed = {
            callId: call.callId,
            workId: intent.workId,
            threadId: call.threadId,
            turnId: call.turnId,
          };
          this.callbacks.push(observed);
          activeService.registerExecutionCallback(
            intent.workId,
            questionCallbackGate,
          );
          questionPromiseResolve(observed);
          await questionCallbackGate;
          return result;
        });
      }
    }

    eventSource = new ObservedMacPowerEventSource();
    const assertion = new powerTypes.CaffeinateAssertion((file, args) => {
      if (
        file !== "/usr/bin/caffeinate" ||
        args.join(" ") !== `-i -w ${process.pid}`
      )
        throw fail("unexpected-assertion-command");
      caffeinateStartCount++;
      caffeinateChild = spawn(file, args, { stdio: "ignore" });
      caffeinateIdentityPromise = new Promise((resolve) => {
        caffeinateChild.once("error", () => resolve(null));
        caffeinateChild.once("spawn", () => {
          if (!caffeinateChild.pid) {
            resolve(null);
            return;
          }
          void terminationTypes
            .captureProcessIdentity(caffeinateChild.pid)
            .then(resolve, () => resolve(null));
        });
      });
      return caffeinateChild;
    });
    assertion.on("failure", () => {
      caffeinateFailure = true;
    });

    runtime = new ObservedCodexRuntime();
    service = new standalone.StandaloneService(
      dataDir,
      () => runtime,
      undefined,
      {
        power: {
          eventSource,
          assertion,
          pollIntervalMs: 1000,
        },
        routingClient: null,
        supervisor: { observationMs: 500 },
      },
    );
    activeService = service;

    progress("existing-login-service-start");
    serviceStartAttempted = true;
    await bounded(service.start(), 30_000);
    appServerIdentity = await runtime.processIdentity();
    if (!appServerIdentity) throw fail("app-server-identity-unavailable");
    evidence.runtime.processIdentitySha256 = identityHash(appServerIdentity);
    await waitUntil(
      () => eventSource.batches.some((batch) => batch.fromCursor === null),
      10_000,
    );
    const baselineBatch = eventSource.batches.find(
      (batch) => batch.fromCursor === null,
    );
    if (!baselineBatch?.complete || !baselineBatch.cursor)
      throw fail("power-baseline-unavailable");
    evidence.power.baselineCursor = baselineBatch.cursor.value;
    if (service.powerStatus()?.admissionHeld) throw fail("power-baseline-held");
    evidence.power.idleAssertionAbsent = caffeinateStartCount === 0;
    if (!evidence.power.idleAssertionAbsent)
      throw fail("idle-assertion-present");

    progress("active-local-task-question");
    const profileId = randomUUID();
    const projectId = randomUUID();
    activeTaskId = randomUUID();
    queuedTaskId = randomUUID();
    command({
      type: "profile.create",
      profileId,
      name: "S05 physical sleep lead",
      instructions:
        "Use only registered Ensemble coordination tools for this disposable task.",
      capabilities: "local task coordination",
    });
    command({
      type: "project.create",
      projectId,
      name: "Disposable S05 physical sleep fixture",
      leadProfileId: profileId,
    });
    command({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command({
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    command({
      type: "capacity.configure",
      globalLimit: 1,
      projectOverrides: { [projectId]: 1 },
    });
    command({
      type: "task.create",
      projectId,
      taskId: activeTaskId,
      title: "S05 active sleep-wake recovery task",
      outcome: [
        "This is a disposable local runtime test. Use only registered Ensemble coordination tools. Do not use shell, filesystem, browser, network or other tools.",
        "Call ensemble_ask_question exactly once with question text S05_PHYSICAL_SLEEP_V1: Please confirm the physical sleep and wake checkpoint. Do not answer it. After the call, end the turn without any more tools.",
      ].join("\n"),
      ready: false,
    });
    await service.provisionTask(activeTaskId);
    command({
      type: "task.configure",
      projectId,
      taskId: activeTaskId,
      expectedVersion: 1,
      ready: true,
    });
    evidence.task.activeTaskId = activeTaskId;

    const callback = await bounded(questionCallback, 240_000);
    const activeIntent = service
      .list()
      .find(
        (item) =>
          item.threadId === callback.threadId &&
          item.turnId === callback.turnId,
      );
    if (!activeIntent) throw fail("active-work-identity-unavailable");
    evidence.runtime.workId = activeIntent.workId;
    evidence.runtime.threadId = callback.threadId;
    evidence.runtime.turnId = callback.turnId;
    evidence.runtime.questionCallbacks = runtime.callbacks.length;
    if (
      runtime.callbacks.length !== 1 ||
      runtime.threadStarts !== 1 ||
      runtime.turnStarts !== 1
    )
      throw fail("active-runtime-count-mismatch");

    if (!caffeinateIdentityPromise) throw fail("assertion-process-unavailable");
    caffeinateIdentity = await bounded(caffeinateIdentityPromise, 10_000);
    if (!caffeinateIdentity) throw fail("assertion-identity-unavailable");
    evidence.power.assertionProcessIdentitySha256 =
      identityHash(caffeinateIdentity);
    evidence.power.assertionFailure =
      caffeinateFailure || service.powerStatus()?.assertionFailure === true;
    if (evidence.power.assertionFailure)
      throw fail("assertion-failure-reported");
    if (!(await verifyProcess(verifier, appServerIdentity, "alive")))
      throw fail("app-server-not-alive-before-sleep");
    if (!(await verifyProcess(verifier, caffeinateIdentity, "alive")))
      throw fail("assertion-not-alive-before-sleep");
    evidence.power.activeAssertionVerified = true;

    progress("queued-capacity-one-task");
    command({
      type: "task.create",
      projectId,
      taskId: queuedTaskId,
      title: "S05 queued task remains held after wake",
      outcome:
        "This task must remain queued until the active task has been independently resolved.",
      ready: false,
    });
    await service.provisionTask(queuedTaskId);
    command({
      type: "task.configure",
      projectId,
      taskId: queuedTaskId,
      expectedVersion: 1,
      ready: true,
    });
    await waitUntil(
      () =>
        service
          .turnRequests()
          .some((request) => request.taskId === queuedTaskId),
      20_000,
    );
    const queuedBeforeSleep = service
      .turnRequests()
      .find((request) => request.taskId === queuedTaskId);
    if (queuedBeforeSleep?.state !== "queued")
      throw fail("queued-task-not-waiting");
    if (service.capacityLimits([projectId]).currentUsage.global !== 1)
      throw fail("capacity-one-not-active");
    evidence.task.queuedTaskId = queuedTaskId;
    evidence.task.queuedWhileActive = true;
    evidence.runtime.threadStarts = runtime.threadStarts;
    evidence.runtime.turnStarts = runtime.turnStarts;

    progress("authenticated-operator-views");
    await authTypes.OperatorAuth.initialize(authFile, password);
    const port = await bounded(unusedPort(), 10_000);
    const origin = `http://127.0.0.1:${port}`;
    auth = await bounded(
      authTypes.OperatorAuth.open({ authFile, origin }),
      10_000,
    );
    const routes = operatorRoutes(service, {
      OperatorRouteRegistry: (
        await import("../../dist/src/standalone/operator-routes.js")
      ).OperatorRouteRegistry,
      runtimeOperatorRoutes: (
        await import("../../dist/src/standalone/operator-runtime.js")
      ).runtimeOperatorRoutes,
      coordinationOperatorRoutes: (
        await import("../../dist/src/standalone/operator-coordination.js")
      ).coordinationOperatorRoutes,
    });
    http = new operatorTypes.LocalOperatorHttp(
      new operatorTypes.LocalOperatorUi(service.domain()),
      auth,
      { routes },
    );
    await bounded(http.start(Number(new URL(origin).port)), 10_000);
    const { chromium } = await import("playwright");
    browser = await bounded(chromium.launch({ headless: true }), 30_000);
    context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    await page.goto(`${origin}/login`);
    assert.match(await page.locator("body").innerText(), /Sign in/);
    await page.locator('input[name="password"]').fill(password);
    const loginResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/login" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    const login = await loginResponse;
    assert.equal(login.status(), 303);
    evidence.operator.authenticated = true;
    await page.goto(`${origin}/coordination/task/${activeTaskId}`);
    assert.match(
      await page.locator("body").innerText(),
      /S05_PHYSICAL_SLEEP_V1/,
    );
    evidence.operator.liveQuestionVisible = true;
    await page.goto(`${origin}/runtime/task/${activeTaskId}`);
    assert.match(
      await page.locator("body").innerText(),
      /Execution status: Running\./,
    );

    progress("owned-wake-schedule-preflight");
    const fixtureId = randomUUID();
    try {
      const wakeSchedule = await prepareWakeSchedule({
        window: approval.window,
        fixtureId,
        run: defaultCommandRunner,
        now: Date.now,
      });
      noteWakeSchedule(wakeSchedule, wakeSchedule.reconciliation);
    } catch (error) {
      if (error?.wakeSchedule)
        noteWakeSchedule(error.wakeSchedule, error.wakeSchedule.reconciliation);
      throw error;
    }

    const batchStart = eventSource.batches.length;
    progress("approved-physical-sleep");
    try {
      await sleepAtApprovedTime({
        window: approval.window,
        ...preparedWake,
        run: defaultCommandRunner,
        now: Date.now,
        waitUntil: (timestamp) =>
          waitUntilTimestamp(timestamp, Date.parse(approval.window.endAt)),
      });
      evidence.power.sleepCommandOutcome = "returned";
    } catch (error) {
      if (error?.message === "sleep-command-outcome-uncertain")
        evidence.power.sleepCommandOutcome = "uncertain";
      else throw error;
    }

    progress("real-power-log-and-reconciliation");
    const timeoutMs = Math.max(
      1,
      Math.min(120_000, Date.parse(approval.window.endAt) - Date.now()),
    );
    await waitUntil(() => {
      const observed = eventSource.batches
        .slice(batchStart)
        .flatMap((batch) => batch.events);
      return (
        observed.some((event) => event.transition === "sleep") &&
        observed.some((event) => event.transition === "wake") &&
        service.powerStatus()?.admissionHeld === true
      );
    }, timeoutMs);

    const powerBatches = eventSource.batches.slice(batchStart);
    const physicalEvents = powerBatches.flatMap((batch) => batch.events);
    const transitions = physicalEvents.map((event) => event.transition);
    if (
      powerBatches.some((batch) => !batch.complete) ||
      transitions.length !== 2 ||
      transitions[0] !== "sleep" ||
      transitions[1] !== "wake"
    )
      throw fail("physical-power-log-incomplete-or-ambiguous");
    const sleepInstant = parseEventTimestamp(physicalEvents[0]?.cursor);
    const wakeInstant = parseEventTimestamp(physicalEvents[1]?.cursor);
    if (
      sleepInstant === undefined ||
      wakeInstant === undefined ||
      sleepInstant < Date.parse(approval.window.sleepAt) ||
      sleepInstant >= Date.parse(approval.window.wakeAt) ||
      wakeInstant <= sleepInstant ||
      wakeInstant < Date.parse(approval.window.wakeAt) ||
      wakeInstant > Date.parse(approval.window.endAt) ||
      wakeInstant - sleepInstant > maximumSleepMs
    )
      throw fail("physical-sleep-duration-out-of-window");
    evidence.power.sleepEvents = 1;
    evidence.power.wakeEvents = 1;
    evidence.power.sleepCursor = physicalEvents[0].cursor.value;
    evidence.power.wakeCursor = physicalEvents[1].cursor.value;
    evidence.power.finalCursor = powerBatches.at(-1)?.cursor?.value ?? null;
    evidence.power.admissionHeldAfterWake =
      service.powerStatus()?.admissionHeld === true;
    if (!evidence.power.admissionHeldAfterWake)
      throw fail("wake-reconciliation-did-not-hold-admission");
    evidence.runtime.appServerAliveAfterWake = await verifyProcess(
      verifier,
      appServerIdentity,
      "alive",
    );
    if (!evidence.runtime.appServerAliveAfterWake)
      throw fail("app-server-not-alive-after-wake");
    evidence.power.assertionFailure =
      caffeinateFailure || service.powerStatus()?.assertionFailure === true;
    evidence.power.activeAssertionAliveAfterWake =
      !evidence.power.assertionFailure &&
      (await verifyProcess(verifier, caffeinateIdentity, "alive"));
    if (!evidence.power.activeAssertionAliveAfterWake)
      throw fail("assertion-not-alive-after-wake");
    const unresolved = service
      .recoveryView()
      .find((record) => record.workId === activeIntent.workId);
    if (
      !unresolved ||
      !(
        unresolved.holds.writer ||
        unresolved.holds.capacity ||
        unresolved.holds.uncertainty
      )
    )
      throw fail("active-ownership-hold-not-retained");
    const queuedAfterWake = service
      .turnRequests()
      .find((request) => request.taskId === queuedTaskId);
    if (queuedAfterWake?.state !== "queued")
      throw fail("queued-work-not-held-after-wake");
    evidence.queuedWork.remainedQueuedAfterWake = true;
    evidence.queuedWork.additionalRuntimeStarts = runtime.turnStarts - 1;
    evidence.queuedWork.noExecutionIdentity = !service
      .list()
      .some((item) => item.threadId && item.workId !== activeIntent.workId);
    if (
      runtime.threadStarts !== 1 ||
      runtime.turnStarts !== 1 ||
      runtime.callbacks.length !== 1 ||
      !evidence.queuedWork.noExecutionIdentity
    )
      throw fail("duplicate-or-replacement-execution-observed");

    progress("authenticated-recovery-view");
    await page.goto(`${origin}/runtime/task/${activeTaskId}`);
    const recoveryBody = await page.locator("body").innerText();
    assert.match(recoveryBody, /Execution state is uncertain/);
    assert.match(recoveryBody, /Writer ownership remains held/);
    assert.match(recoveryBody, /Capacity remains held/);
    evidence.operator.recoveryVisible = true;
  } catch (error) {
    evidence.failure = { stage, kind: failureKind(error) };
  } finally {
    if (preparedWake) {
      const cancellation = await cancelOwnedWake({
        owner: preparedWake.owner,
        localWakeTime: preparedWake.localWakeTime,
        baseline: preparedWake.baseline,
        scheduleOutcomeUncertain:
          preparedWake.scheduleOutcomeUncertain === true,
        run: defaultCommandRunner,
      }).catch(() => cancellationResult(false, "cleanup-error"));
      evidence.cleanup.wakeScheduleCancellationVerified = cancellation.verified;
      evidence.power.wakeSchedule.cleanup = cancellation.reconciliation;
      if (!evidence.cleanup.wakeScheduleCancellationVerified)
        evidence.failure ??= {
          stage: "owned-wake-cleanup",
          kind: "cleanup-unverified",
        };
    }
    if (releaseQuestionCallback && !questionReleased) {
      releaseQuestionCallback();
      questionReleased = true;
    }
    password = "";
    let contextClosed = true;
    let browserClosed = true;
    try {
      if (context) await bounded(context.close(), 10_000);
    } catch {
      contextClosed = false;
    }
    try {
      if (browser) await bounded(browser.close(), 10_000);
    } catch {
      browserClosed = false;
    }
    evidence.cleanup.browserClosed = contextClosed && browserClosed;
    if (!evidence.cleanup.browserClosed)
      evidence.failure ??= { stage: "browser-cleanup", kind: "cleanup-failed" };
    let httpStopped = true;
    let authClosed = true;
    try {
      if (http) await bounded(http.stop(), 10_000);
    } catch {
      httpStopped = false;
      evidence.failure ??= {
        stage: "operator-cleanup",
        kind: "cleanup-failed",
      };
    }
    try {
      auth?.close();
    } catch {
      authClosed = false;
      evidence.failure ??= {
        stage: "operator-cleanup",
        kind: "cleanup-failed",
      };
    }
    evidence.cleanup.operatorStopped = httpStopped && authClosed;
    try {
      if (service) await bounded(service.stop(), 20_000);
      evidence.cleanup.serviceStopped = true;
    } catch {
      evidence.failure ??= { stage: "service-cleanup", kind: "cleanup-failed" };
    }

    const caffeinateIdentityResult = caffeinateIdentityPromise
      ? await caffeinateIdentityPromise
      : null;
    caffeinateIdentity ??= caffeinateIdentityResult;
    evidence.cleanup.appServerExitVerified = appServerIdentity
      ? await verifyProcess(verifier, appServerIdentity, "exit")
      : !serviceStartAttempted;
    evidence.cleanup.caffeinateExitVerified = caffeinateIdentity
      ? await verifyProcess(verifier, caffeinateIdentity, "exit")
      : caffeinateStartCount === 0;
    if (!evidence.cleanup.appServerExitVerified)
      evidence.failure ??= {
        stage: "app-server-exit-verification",
        kind: "cleanup-unverified",
      };
    if (!evidence.cleanup.caffeinateExitVerified)
      evidence.failure ??= {
        stage: "caffeinate-exit-verification",
        kind: "cleanup-unverified",
      };

    if (
      root &&
      evidence.cleanup.browserClosed &&
      evidence.cleanup.operatorStopped &&
      evidence.cleanup.serviceStopped &&
      evidence.cleanup.appServerExitVerified &&
      evidence.cleanup.caffeinateExitVerified &&
      evidence.cleanup.wakeScheduleCancellationVerified !== false
    ) {
      let exactRoot = false;
      try {
        exactRoot =
          realpathSync(root) === root &&
          dirname(root) === temporaryRoot &&
          basename(root).startsWith("ensemble-s05-sleep-");
      } catch {}
      if (exactRoot) {
        try {
          rmSync(root, { recursive: true, force: false });
          evidence.fixture.removed = !existsSync(root);
        } catch {
          evidence.failure ??= {
            stage: "fixture-cleanup",
            kind: "cleanup-failed",
          };
        }
      } else {
        evidence.failure ??= {
          stage: "fixture-cleanup",
          kind: "cleanup-failed",
        };
      }
    }
    if (!evidence.fixture.removed && root)
      evidence.failure ??= {
        stage: "fixture-retained",
        kind: "process-exit-unverified",
      };
    if (evidence.failure || !evidence.fixture.removed) process.exitCode = 1;
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
}

function directExecution() {
  const path = process.argv[1];
  return (
    typeof path === "string" && import.meta.url === pathToFileURL(path).href
  );
}

if (directExecution()) {
  const args = process.argv.slice(2);
  const parsed = parseLiveArguments(args);
  if (!parsed.ok) {
    process.stderr.write("Refusing host sleep without live approval guards.\n");
    process.exitCode = 2;
  } else if (process.platform !== "darwin") {
    process.stderr.write("Refusing physical sleep outside macOS.\n");
    process.exitCode = 2;
  } else {
    let approved;
    try {
      approved = approvedWindowFromFile(parsed.windowPath, Date.now());
    } catch {
      process.stderr.write(
        "Refusing invalid or out-of-window approval record.\n",
      );
      process.exitCode = 2;
    }
    if (approved) {
      void runLiveJourney(approved).catch(() => {
        process.stderr.write("S05 physical sleep journey failed safely.\n");
        process.exitCode = 1;
      });
    }
  }
}
