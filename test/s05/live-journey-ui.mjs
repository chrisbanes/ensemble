import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { CoordinationStore } from "../../dist/src/core/coordination.js";
import {
  CodexRuntime,
  StandaloneService,
} from "../../dist/src/standalone/index.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../dist/src/standalone/operator.js";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";
import { coordinationOperatorRoutes } from "../../dist/src/standalone/operator-coordination.js";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../dist/src/standalone/operator-runtime.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import { tmpdir } from "../../dist/test/temp.js";

const noNetwork =
  "No network access or external tools are needed for this fixture.";
const timeoutMs = 12 * 60 * 1000;
const startupTimeoutMs = 30_000;
const codexTurnTerminalTimeoutMs = 180_000;

function required(condition, stage) {
  if (!condition) throw new Error(`journey assertion failed: ${stage}`);
}

function runCommand(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureRecoveryToken(root, mode) {
  const prefix = `ensemble-s05-${mode}-`;
  const token = basename(root);
  const suffix = token.slice(prefix.length);
  required(
    token.startsWith(prefix) && /^[a-z0-9]{6,32}$/i.test(suffix),
    "fixture-recovery-token",
  );
  return token;
}

function processEvidence(identity) {
  return identity
    ? {
        processId: identity.processId,
        processStartedAt: identity.processStartedAt,
        bootId: identity.bootId,
      }
    : null;
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function artifactValueWitness(filePath, workspacePath) {
  try {
    const actualPath = realpathSync(filePath);
    const workspaceRelative = relative(workspacePath, actualPath);
    if (
      workspaceRelative !== "answer.txt" ||
      workspaceRelative.startsWith(`..${sep}`)
    )
      return {
        fileValue: "outside-workspace",
        fileBytes: null,
        matchesExpectedInitialValue: false,
      };
    const fileBytes = statSync(actualPath).size;
    if (fileBytes > 64)
      return {
        fileValue: "over-limit",
        fileBytes: 65,
        matchesExpectedInitialValue: false,
      };
    const content = readFileSync(actualPath, "utf8");
    const value = new Map([
      ["0\n", "0"],
      ["41\n", "41"],
      ["42\n", "42"],
    ]).get(content);
    return {
      fileValue: value ?? "other",
      fileBytes,
      matchesExpectedInitialValue: content === "41\n",
    };
  } catch {
    return {
      fileValue: "unreadable",
      fileBytes: null,
      matchesExpectedInitialValue: false,
    };
  }
}

function sanitizedRuntimeCallback(call) {
  const safeFields = new Set([
    "tool",
    "threadId",
    "turnId",
    "taskId",
    "assignmentId",
    "profileId",
    "success",
    "requestedProfileId",
    "delegatedAssignmentId",
    "delegatedRequesterAssignmentId",
    "delegatedResultDestination",
    "briefReferencesRevisionTwoResult",
    "recordedResultId",
    "requestedResultId",
    "targetsInitialImplementationResult",
    "reviewedResultIds",
  ]);
  return Object.fromEntries(
    Object.entries(call)
      .filter(([key]) => safeFields.has(key))
      .map(([key, value]) => [
        key,
        key === "reviewedResultIds" && Array.isArray(value)
          ? value.filter(isUuid).slice(0, 20)
          : value,
      ]),
  );
}

function sanitizedWatchedArtifactEvidence(runtime) {
  const watch = runtime.initialReviewWatch;
  if (!watch) return null;
  const callbackWitness = runtime.initialArtifactWitness;
  const currentValue = callbackWitness
    ? callbackWitness
    : artifactValueWitness(watch.filePath, watch.workspacePath);
  return {
    taskId: watch.taskId,
    implementerAssignmentId: watch.implementerAssignmentId ?? null,
    reviewerAssignmentId: watch.reviewerAssignmentId ?? null,
    witnessSource: callbackWitness
      ? "nested-review-report-callback"
      : "failure-boundary-current-file",
    artifactValueWitness: {
      fileValue: currentValue.fileValue,
      fileBytes: currentValue.fileBytes,
      matchesExpectedInitialValue: currentValue.matchesExpectedInitialValue,
    },
    reviewResultId: callbackWitness?.reviewResultId ?? null,
    callbackIndex: callbackWitness?.callbackIndex ?? null,
  };
}

function sanitizedFailure(stage, kind, error) {
  const safeName = new Set([
    "AssertionError",
    "Error",
    "RangeError",
    "TimeoutError",
    "TypeError",
  ]);
  const safeCodes = new Set([
    "EACCES",
    "EADDRINUSE",
    "ECONNRESET",
    "EPERM",
    "ETIMEDOUT",
    "ERR_INVALID_ARG_VALUE",
  ]);
  const message =
    error && typeof error.message === "string" ? error.message : "";
  const assertion = message.match(
    /^journey (?:assertion failed|timeout): ([a-z0-9/_-]{1,160})$/,
  );
  const assertionId = assertion?.[1]
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  const code = error && typeof error.code === "string" ? error.code : undefined;
  return {
    stage,
    kind,
    errorType:
      error && typeof error.name === "string" && safeName.has(error.name)
        ? error.name
        : error instanceof Error
          ? "Error"
          : "non-error",
    ...(assertionId ? { assertionId } : {}),
    ...(code && safeCodes.has(code) ? { code } : {}),
  };
}

async function verifyExited(identity) {
  if (!identity) return { kind: "unproved" };
  const verifier = new MacProcessTerminationVerifier();
  const deadline = Date.now() + 15_000;
  let latest;
  do {
    latest = await verifier.verify(identity);
    if (latest.kind === "verified") return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return latest;
}

export async function awaitJourneyStartup(
  owner,
  stage,
  start,
  deadlineMs = startupTimeoutMs,
) {
  required(/^[a-z0-9-]{1,80}$/.test(stage), "journey-startup-stage-is-safe");
  required(
    Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= startupTimeoutMs,
    "journey-startup-deadline-is-bounded",
  );
  owner.startupStage = stage;
  owner.startupPending = true;
  owner.startupTimedOut = false;
  owner.startupSettled = false;
  const operation = Promise.resolve().then(start);
  owner.startupPromise = operation.then(
    (value) => {
      owner.startupPending = false;
      owner.startupSettled = true;
      return value;
    },
    (error) => {
      owner.startupPending = false;
      owner.startupSettled = true;
      throw error;
    },
  );
  void owner.startupPromise.catch(() => {});

  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
  });
  const outcome = await Promise.race([
    owner.startupPromise.then(
      (value) => ({ kind: "ready", value }),
      (error) => ({ kind: "failed", error }),
    ),
    deadline,
  ]);
  clearTimeout(timeout);
  if (outcome.kind === "timeout") {
    owner.startupTimedOut = true;
    throw new Error(`journey timeout: ${stage}`);
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.value;
}

async function waitUntil(predicate, label, durationMs = timeoutMs, runtime) {
  const deadline = Date.now() + durationMs;
  while (true) {
    required(!runtime?.turnFailures.length, "model-turn-failed-within-bound");
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`journey timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  required(address && typeof address === "object", "loopback-port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function operatorRoutes(service) {
  const routes = new OperatorRouteRegistry();
  routes.registerSlot("runtime", runtimeOperatorRoutes(service));
  routes.registerSlot(
    "coordination",
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (projectId) => service.routingAvailability(projectId),
    ),
  );
  return routes;
}

class ObservedCodexRuntime extends CodexRuntime {
  activeCallbacks = 0;
  callbacks = [];
  stream = new Map();
  turnFailures = [];
  service;
  initialReviewWatch;
  initialArtifactWitness;

  watchInitialReviewArtifact(watch) {
    this.initialReviewWatch = watch;
  }

  async waitForTurn(threadId, turnId) {
    try {
      const outcome = await super.waitForTurn(threadId, turnId);
      if (outcome !== "completed")
        this.turnFailures.push({ threadId, turnId, outcome: "failed" });
      return outcome;
    } catch {
      this.turnFailures.push({ threadId, turnId, outcome: "error" });
      throw new Error("journey assertion failed: model-turn-terminal-error");
    }
  }

  onToolCall(listener) {
    super.onToolCall(async (call) => {
      this.activeCallbacks++;
      let success = false;
      let toolResult;
      try {
        toolResult = await listener(call);
        success = toolResult.success;
        return toolResult;
      } finally {
        const intent = this.service
          ?.list()
          .find(
            (item) =>
              item.threadId === call.threadId && item.turnId === call.turnId,
          );
        const request = intent
          ? this.service
              .turnRequests()
              .find((candidate) => candidate.workId === intent.workId)
          : undefined;
        const assignment = request?.assignmentId
          ? this.service.domain().assignment(request.assignmentId)
          : undefined;
        const callback = {
          tool: call.tool,
          threadId: call.threadId,
          turnId: call.turnId,
          taskId: request?.taskId ?? null,
          assignmentId: request?.assignmentId ?? null,
          profileId: assignment ? String(assignment.profileId) : null,
          success,
        };
        const toolOutputId = (prefix) => {
          const match = toolResult?.text.match(
            new RegExp(`^${prefix} ([0-9a-f-]{36})$`, "i"),
          );
          return match && isUuid(match[1]) ? match[1] : null;
        };
        if (call.tool === "ensemble_delegate") {
          const delegatedAssignmentId = success
            ? toolOutputId("Delegated assignment")
            : null;
          const delegatedAssignment = delegatedAssignmentId
            ? this.service.domain().assignment(delegatedAssignmentId)
            : undefined;
          callback.requestedProfileId = isUuid(call.arguments.profileId)
            ? call.arguments.profileId
            : null;
          callback.delegatedAssignmentId = delegatedAssignmentId;
          callback.delegatedRequesterAssignmentId = delegatedAssignment
            ? String(delegatedAssignment.requesterAssignmentId)
            : null;
          callback.delegatedResultDestination = delegatedAssignment
            ? String(delegatedAssignment.resultDestination)
            : null;
          const watch = this.initialReviewWatch;
          if (
            watch &&
            !watch.implementerAssignmentId &&
            request?.taskId === watch.taskId &&
            String(assignment?.profileId) === watch.leadProfileId &&
            callback.requestedProfileId === watch.implementerProfileId &&
            delegatedAssignment
          ) {
            watch.leadAssignmentId = String(assignment.id);
            watch.implementerAssignmentId = delegatedAssignmentId;
          }
          if (
            watch?.implementerAssignmentId &&
            !watch.reviewerAssignmentId &&
            request?.taskId === watch.taskId &&
            String(assignment?.id) === watch.implementerAssignmentId &&
            callback.requestedProfileId === watch.reviewerProfileId &&
            delegatedAssignment
          )
            watch.reviewerAssignmentId = delegatedAssignmentId;
          if (
            watch?.revisionTwoImplementationResultId &&
            request?.taskId === watch.taskId &&
            String(assignment?.id) === watch.leadAssignmentId &&
            callback.requestedProfileId === watch.reviewerProfileId &&
            delegatedAssignment
          ) {
            watch.revisionTwoReviewerAssignmentId = delegatedAssignmentId;
            callback.briefReferencesRevisionTwoResult =
              typeof call.arguments.brief === "string" &&
              call.arguments.brief.includes(
                watch.revisionTwoImplementationResultId,
              );
          }
        }
        if (call.tool === "ensemble_report_result") {
          callback.recordedResultId = success
            ? toolOutputId("Result recorded:")
            : null;
          const watch = this.initialReviewWatch;
          if (
            success &&
            callback.recordedResultId &&
            watch &&
            request?.taskId === watch.taskId &&
            request.assignmentId === watch.implementerAssignmentId
          ) {
            if (!watch.initialImplementationResultId)
              watch.initialImplementationResultId = callback.recordedResultId;
            else if (
              callback.recordedResultId !==
                watch.initialImplementationResultId &&
              !watch.revisionTwoImplementationResultId
            )
              watch.revisionTwoImplementationResultId =
                callback.recordedResultId;
          }
          if (
            success &&
            callback.recordedResultId &&
            watch &&
            !this.initialArtifactWitness &&
            request?.taskId === watch.taskId &&
            request.assignmentId === watch.reviewerAssignmentId
          )
            this.initialArtifactWitness = {
              taskId: watch.taskId,
              implementerAssignmentId: watch.implementerAssignmentId,
              reviewerAssignmentId: watch.reviewerAssignmentId,
              reviewResultId: callback.recordedResultId,
              callbackIndex: this.callbacks.length,
              ...artifactValueWitness(watch.filePath, watch.workspacePath),
            };
        }
        if (call.tool === "ensemble_request_follow_up")
          callback.requestedResultId = isUuid(call.arguments.resultId)
            ? call.arguments.resultId
            : null;
        if (call.tool === "ensemble_request_follow_up") {
          const watch = this.initialReviewWatch;
          callback.targetsInitialImplementationResult = Boolean(
            watch?.initialImplementationResultId &&
              callback.requestedResultId ===
                watch.initialImplementationResultId,
          );
        }
        if (call.tool === "ensemble_request_completion")
          callback.reviewedResultIds = Array.isArray(
            call.arguments.reviewedResultIds,
          )
            ? call.arguments.reviewedResultIds.filter(isUuid).slice(0, 1000)
            : [];
        this.callbacks.push(callback);
        this.activeCallbacks--;
      }
    });
  }

  onConversationEvent(listener) {
    super.onConversationEvent((event) => {
      let turn = this.stream.get(event.turnId);
      if (!turn) {
        turn = {
          threadId: event.threadId,
          turnId: event.turnId,
          started: 0,
          deltas: 0,
          deltaBytes: 0,
          completed: 0,
          omitted: 0,
          markerMatched: false,
        };
        this.stream.set(event.turnId, turn);
      }
      if (event.kind === "started") turn.started++;
      else if (event.kind === "delta") {
        turn.deltas++;
        turn.deltaBytes += event.bytes;
      } else if (event.kind === "completed") {
        turn.completed++;
        turn.markerMatched ||= this.markers.some((marker) =>
          event.text.includes(marker),
        );
      } else turn.omitted++;
      listener(event);
    });
  }

  markers = [];
}

function verifyCapturedHistory(service, taskId, assignmentId, privateValues) {
  const history = service
    .coordinationView()
    .readAssignmentHistory(assignmentId);
  const rows = history.items;
  const noPrivateValues = rows.every(
    (row) =>
      row.text === null ||
      privateValues.every((value) => !value || !row.text.includes(value)),
  );
  const bound = rows.every(
    (row) => row.taskId === taskId && row.assignmentId === assignmentId,
  );
  return {
    itemCount: rows.length,
    completedCount: rows.filter((row) => row.lifecycle === "completed").length,
    omissionCount: rows.filter((row) => row.lifecycle === "omitted").length,
    turnOmissionCount: history.turnOmissions.length,
    omittedItemCount: history.omittedItemCount,
    exactTaskAssignmentBinding: bound,
    knownPrivateValuesExcluded: noPrivateValues,
    markerMatched: rows.some(
      (row) => row.lifecycle === "completed" && row.text?.includes("S05_"),
    ),
    generations: [
      ...new Map(
        rows.map((row) => [
          `${row.threadId}:${row.turnId}`,
          {
            threadId: row.threadId,
            turnId: row.turnId,
            workId: row.workId,
            assignmentVersion: row.assignmentVersion,
            instructionsRevision: row.instructionsRevision,
            profileRevision: row.profileRevision,
            conversationRevision: row.conversationRevision,
            workRevision: row.workRevision,
          },
        ]),
      ).values(),
    ],
  };
}

function taskIntents(service, taskId) {
  const taskWorkIds = new Set(
    service
      .turnRequests()
      .filter((request) => request.taskId === taskId)
      .map((request) => request.workId),
  );
  return service.list().filter((intent) => taskWorkIds.has(intent.workId));
}

function assignmentTurnBindings(service, taskId, assignmentId) {
  const intents = new Map(
    service.list().map((intent) => [intent.workId, intent]),
  );
  return service
    .turnRequests()
    .filter(
      (request) =>
        request.taskId === taskId && request.assignmentId === assignmentId,
    )
    .flatMap((request) => {
      const intent = intents.get(request.workId);
      return intent?.threadId && intent.turnId
        ? [
            {
              workId: request.workId,
              threadId: intent.threadId,
              turnId: intent.turnId,
            },
          ]
        : [];
    });
}

function startCapacityMeter(service, projectId) {
  const observation = {
    configuredGlobalLimit: service.capacityLimits([projectId]).globalLimit,
    maximumObservedGlobalUsage: 0,
    samples: 0,
  };
  let stopped = false;
  const sample = () => {
    const capacity = service.capacityLimits([projectId]);
    observation.samples++;
    observation.maximumObservedGlobalUsage = Math.max(
      observation.maximumObservedGlobalUsage,
      capacity.currentUsage.global,
    );
  };
  sample();
  const interval = setInterval(sample, 25);
  return {
    observation,
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
        sample();
      }
      return { ...observation };
    },
  };
}

function streamEvidenceForTask(runtime, service, taskId) {
  const identities = new Set(
    taskIntents(service, taskId)
      .filter((intent) => intent.threadId && intent.turnId)
      .map((intent) => `${intent.threadId}:${intent.turnId}`),
  );
  const turns = [...runtime.stream.values()].filter((turn) =>
    identities.has(`${turn.threadId}:${turn.turnId}`),
  );
  const counts = {
    turnCount: turns.length,
    started: turns.reduce((sum, turn) => sum + turn.started, 0),
    deltas: turns.reduce((sum, turn) => sum + turn.deltas, 0),
    deltaBytes: turns.reduce((sum, turn) => sum + turn.deltaBytes, 0),
    completed: turns.reduce((sum, turn) => sum + turn.completed, 0),
    omitted: turns.reduce((sum, turn) => sum + turn.omitted, 0),
    markerMatchedTurns: turns.filter((turn) => turn.markerMatched).length,
  };
  return {
    ...counts,
    lifecycleObserved:
      counts.started > 0 &&
      counts.deltas > 0 &&
      counts.deltaBytes > 0 &&
      counts.completed > 0,
  };
}

async function saveForm(page, form) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/command" &&
      candidate.request().method() === "POST",
    { timeout: 10_000 },
  );
  await form.getByRole("button", { name: "Save" }).click();
  required((await response).status() === 303, "operator-command-redirect");
}

async function submitForm(page, form, path, buttonName) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === path &&
      candidate.request().method() === "POST",
    { timeout: 10_000 },
  );
  await form.getByRole("button", { name: buttonName }).click();
  required((await response).status() === 303, `operator-${path}-redirect`);
}

async function formPayload(form) {
  return form.evaluate((element) =>
    Object.fromEntries(new FormData(element).entries()),
  );
}

async function login(page, origin, password) {
  await page.goto(`${origin}/login`);
  await page.locator('input[name="password"]').fill(password);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/login" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  required((await response).status() === 303, "operator-login");
}

async function createProfile(page, origin, name, instructions, capabilities) {
  await page.goto(`${origin}/`);
  const form = page.locator('form[data-command="profile.create"]');
  const profileId = await form.locator('input[name="profileId"]').inputValue();
  await form.locator('input[name="name"]').fill(name);
  await form.locator('textarea[name="instructions"]').fill(instructions);
  await form.locator('textarea[name="capabilities"]').fill(capabilities);
  await saveForm(page, form);
  return profileId;
}

async function createProject(page, origin, name, leadProfileId) {
  await page.goto(`${origin}/`);
  const form = page.locator('form[data-command="project.create"]');
  const projectId = await form.locator('input[name="projectId"]').inputValue();
  await form.locator('input[name="name"]').fill(name);
  await form
    .locator('select[name="leadProfileId"]')
    .selectOption(leadProfileId);
  await saveForm(page, form);
  return projectId;
}

async function configureProject(page, origin, projectId, instructions, paused) {
  await page.goto(`${origin}/project/${projectId}`);
  const form = page.locator('form[data-command="project.configure"]');
  if (instructions !== undefined)
    await form.locator('textarea[name="instructions"]').fill(instructions);
  const pauseControl = form.locator('input[name="paused"]');
  const currentlyPaused = await pauseControl.isChecked();
  if (currentlyPaused !== paused) {
    if (paused) await pauseControl.check();
    else await pauseControl.uncheck();
  }
  await saveForm(page, form);
}

async function configureRoutingCandidates(
  page,
  origin,
  projectId,
  candidateProfileIds,
) {
  await page.goto(`${origin}/project/${projectId}`);
  let form = page.locator('form[data-command="routing.configure"]');
  const enabled = form.locator('input[name="enabled"]');
  if (await enabled.isChecked()) await enabled.uncheck();
  await form.locator('input[name="credentialRef"]').fill("");
  await form
    .locator('textarea[name="candidateProfileIds"]')
    .fill(JSON.stringify(candidateProfileIds));
  await saveForm(page, form);

  await page.goto(`${origin}/project/${projectId}`);
  form = page.locator('form[data-command="routing.configure"]');
  const savedCandidateProfileIds = JSON.parse(
    await form.locator('textarea[name="candidateProfileIds"]').inputValue(),
  );
  const credentialReference = await form
    .locator('input[name="credentialRef"]')
    .inputValue();
  const routingDisabled = !(await form
    .locator('input[name="enabled"]')
    .isChecked());
  required(
    routingDisabled &&
      credentialReference === "" &&
      JSON.stringify(savedCandidateProfileIds) ===
        JSON.stringify([...new Set(candidateProfileIds)].sort()),
    "candidate-profiles-saved-with-routing-disabled-and-no-credential",
  );
  return {
    candidateProfileIds: savedCandidateProfileIds,
    routingDisabled,
    credentialReferenceEmpty: credentialReference === "",
  };
}

async function createTask(
  page,
  origin,
  service,
  projectId,
  title,
  initialOutcome,
  outcome,
  repositories = [],
  ready = true,
) {
  await page.goto(`${origin}/project/${projectId}`);
  const create = page.locator('form[data-command="task.create"]');
  const taskId = await create.locator('input[name="taskId"]').inputValue();
  await create.locator('input[name="title"]').fill(title);
  await create.locator('textarea[name="outcome"]').fill(initialOutcome);
  required(
    !(await create.locator('input[name="ready"]').isChecked()),
    "new-task-unready",
  );
  await saveForm(page, create);

  await page.goto(`${origin}/task/${taskId}`);
  let edit = page.locator('form[data-command="task.configure"]');
  await edit.locator('input[name="title"]').fill(title);
  await edit.locator('textarea[name="outcome"]').fill(outcome);
  required(
    !(await edit.locator('input[name="ready"]').isChecked()),
    "edited-task-still-unready",
  );
  await saveForm(page, edit);
  await service.provisionTask(taskId, repositories);

  if (ready) {
    await page.goto(`${origin}/task/${taskId}`);
    edit = page.locator('form[data-command="task.configure"]');
    await edit.locator('input[name="ready"]').check();
    await saveForm(page, edit);
  }
  return taskId;
}

async function setTaskReady(page, origin, taskId, ready) {
  await page.goto(`${origin}/task/${taskId}`);
  const form = page.locator('form[data-command="task.configure"]');
  const checkbox = form.locator('input[name="ready"]');
  if ((await checkbox.isChecked()) !== ready) {
    if (ready) await checkbox.check();
    else await checkbox.uncheck();
    await saveForm(page, form);
  }
}

function setTaskStateViaFixtureApi(service, taskId, state) {
  const task = service.domain().task(taskId);
  service.domain().execute({
    key: randomUUID(),
    type: "task.configure",
    actor: "operator",
    projectId: String(task.projectId),
    taskId,
    expectedVersion: Number(task.version),
    state,
  });
}

function readCommandReceipt(root, projectId, key) {
  const database = new DatabaseSync(
    join(root, "service-data", "standalone.sqlite"),
    { readOnly: true },
  );
  try {
    const rows = database
      .prepare(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .all(projectId, key);
    return {
      count: rows.length,
      payloadHash: rows[0]?.payloadHash ?? null,
      result: rows[0]?.result ?? null,
    };
  } finally {
    database.close();
  }
}

function readOperatorReceipt(dataDir, scope, key) {
  const database = new DatabaseSync(join(dataDir, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare(
        `SELECT payloadHash, result FROM coordination_operator_receipts
         WHERE scope = ? AND commandKey = ?`,
      )
      .all(scope, key);
    return {
      count: rows.length,
      payloadHash: rows[0]?.payloadHash ?? null,
      result: rows[0]?.result ?? null,
    };
  } finally {
    database.close();
  }
}

async function replayOperatorForm(
  current,
  taskId,
  interactionId,
  eventType,
  eventId,
  scope,
  path,
  fields,
) {
  required(
    current.restartInvalidatedSessionVerified === true,
    "operator-command-replay-after-service-restart",
  );
  const key = fields.key;
  required(typeof key === "string" && isUuid(key), "operator-command-key");
  const firstReceipt = readOperatorReceipt(current.dataDir, scope, key);
  required(
    firstReceipt.count === 1 && firstReceipt.result !== null,
    "operator-command-first-receipt-committed",
  );
  const response = await current.browserContext.request.post(
    `${current.origin}${path}`,
    {
      headers: { origin: current.origin },
      form: fields,
      maxRedirects: 0,
    },
  );
  const replayedReceipt = readOperatorReceipt(current.dataDir, scope, key);
  const view = taskView(current.service, taskId);
  const events = view.messages.filter(
    (message) =>
      message.eventType === eventType &&
      message.interactionId === interactionId,
  );
  let firstResultEventId = null;
  let replayedResultEventId = null;
  try {
    firstResultEventId = JSON.parse(firstReceipt.result).eventId ?? null;
    replayedResultEventId = JSON.parse(replayedReceipt.result).eventId ?? null;
  } catch {
    required(false, "operator-command-receipt-result-valid");
  }
  const interaction =
    eventType === "question-answer"
      ? view.questions.find((item) => item.interactionId === interactionId)
      : view.approvals.find((item) => item.interactionId === interactionId);
  const evidence = {
    replayedAfterVerifiedServiceRestart: true,
    responseStatus: response.status(),
    receiptCountBeforeReplay: firstReceipt.count,
    receiptCountAfterReplay: replayedReceipt.count,
    payloadHashStable:
      firstReceipt.payloadHash !== null &&
      firstReceipt.payloadHash === replayedReceipt.payloadHash,
    committedResultStable:
      firstReceipt.result !== null &&
      firstReceipt.result === replayedReceipt.result,
    committedResultMatchesEvent:
      firstResultEventId === eventId && replayedResultEventId === eventId,
    eventCount: events.length,
    eventId: events[0]?.eventId ?? null,
    interactionRevision: interaction?.revision ?? null,
  };
  required(
    response.status() === 303 &&
      firstReceipt.count === 1 &&
      replayedReceipt.count === 1 &&
      evidence.payloadHashStable &&
      evidence.committedResultStable &&
      evidence.committedResultMatchesEvent &&
      events.length === 1 &&
      events[0]?.eventId === eventId &&
      interaction?.revision === 2,
    "operator-command-replay-preserves-one-committed-result",
  );
  return evidence;
}

export function runFixtureRelativeFileApprovalAdapter({
  databasePath,
  workspacePath,
  approval,
}) {
  const target = "s05-denied.txt";
  const marker =
    /^S05_(?:ALPHA|BETA)_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST$/;
  required(approval.status === "denied", "fixture-action-has-denied-approval");
  required(
    approval.action === "Write fixture-only relative file" &&
      approval.target === target,
    "fixture-action-exact-relative-target",
  );
  let material;
  try {
    material = JSON.parse(approval.materialJson);
  } catch {
    required(false, "fixture-action-material-valid-json");
  }
  required(
    material.relativePath === target &&
      typeof material.content === "string" &&
      marker.test(material.content),
    "fixture-action-material-bounded",
  );
  const workspace = realpathSync(workspacePath);
  const filePath = join(workspace, target);
  required(
    relative(workspace, filePath) === target && !existsSync(filePath),
    "fixture-action-target-is-new-workspace-relative-file",
  );

  const database = new DatabaseSync(databasePath, { readOnly: true });
  let authorizationGranted;
  try {
    const coordination = new CoordinationStore(database);
    authorizationGranted = coordination.authorizationFor({
      assignmentId: approval.requestingAssignmentId,
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      action: approval.action,
      target: approval.target,
      material,
    });
  } finally {
    database.close();
  }
  if (authorizationGranted)
    writeFileSync(filePath, material.content, { flag: "wx", mode: 0o600 });
  const fileCreated = existsSync(filePath);
  return {
    authorizationChecked: true,
    authorizationGranted,
    targetWithinWorkspace: true,
    fileCreated,
    fileAbsent: !fileCreated,
  };
}

async function setCapacity(page, origin, limit) {
  await page.goto(`${origin}/runtime`);
  const form = page.locator('form[action="/runtime/control/capacity"]');
  await form.locator('input[name="globalLimit"]').fill(String(limit));
  await form.locator('select[name="projectId"]').selectOption("");
  await form.locator('input[name="projectLimit"]').fill("");
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/runtime/control/capacity" &&
      candidate.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Save capacity" }).click();
  required((await response).status() === 303, "capacity-configured-through-ui");
  await page.goto(`${origin}/`);
}

async function createLocalRepository(root) {
  const repositoryPath = join(root, "repository");
  mkdirSync(repositoryPath, { mode: 0o700 });
  writeFileSync(join(repositoryPath, "answer.txt"), "0\n", { mode: 0o600 });
  runCommand("git", ["init", "-b", "main"], repositoryPath);
  runCommand("git", ["add", "answer.txt"], repositoryPath);
  runCommand(
    "git",
    [
      "-c",
      "user.name=Ensemble S05 fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture baseline",
    ],
    repositoryPath,
  );
  return realpathSync(repositoryPath);
}

function safeRepositoryEvidence(repositoryPath, workspace) {
  const repository = workspace.repositories[0];
  required(repository?.workspacePath, "repository-workspace-bound");
  const file = realpathSync(join(repository.workspacePath, "answer.txt"));
  const rootRelative = relative(repository.workspacePath, file);
  required(
    rootRelative === "answer.txt" && !rootRelative.startsWith(`..${sep}`),
    "artifact-remains-in-bound-workspace",
  );
  const content = readFileSync(file, "utf8");
  const diff = runCommand(
    "git",
    ["diff", "--", "answer.txt"],
    repository.workspacePath,
  );
  return {
    fileMatchesExpected: content === "42\n",
    fileBytes: Buffer.byteLength(content),
    gitDiffContainsFinalValue: /\+42\s*$/.test(diff),
    fixtureRepositoryIsLocal: !runCommand("git", ["remote"], repositoryPath),
  };
}

async function serviceReady(
  root,
  privateValues,
  evidence,
  onCreated,
  previous,
) {
  const dataDir = join(root, "service-data");
  const authFile = join(root, "operator-auth.json");
  const password = previous?.password ?? randomBytes(32).toString("base64url");
  privateValues.push(password, root, dataDir, authFile);
  if (previous === undefined) await OperatorAuth.initialize(authFile, password);
  else
    required(existsSync(authFile), "existing-auth-file-retained-for-restart");
  const port = previous?.port ?? (await unusedPort());
  const origin = previous?.origin ?? `http://127.0.0.1:${port}`;
  const runtime = new ObservedCodexRuntime();
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    routingClient: null,
    supervisor: { observationMs: 500 },
    conversationHistoryExclusions: () => privateValues,
  });
  runtime.service = service;
  const owner = {
    startupKind: "service",
    authFile,
    dataDir,
    password,
    port,
    origin,
    runtime,
    service,
    processIdentity: undefined,
    startAttempted: false,
    stopped: false,
    exitVerified: false,
  };
  onCreated(owner);
  owner.startAttempted = true;
  const processIdentity = await awaitJourneyStartup(
    owner,
    "service-startup",
    async () => {
      await service.start();
      const identity = await runtime.processIdentity();
      required(identity, "real-codex-app-server-process-identity");
      owner.processIdentity = identity;
      return identity;
    },
  );
  evidence.runtime.processes.push(processEvidence(processIdentity));
  return owner;
}

async function startOperator(current, evidence, onCreated) {
  const owner = {
    startupKind: "operator",
    auth: undefined,
    http: undefined,
    startAttempted: false,
    httpStopped: true,
    authClosed: true,
  };
  onCreated(owner);
  await awaitJourneyStartup(owner, "operator-startup", async () => {
    owner.auth = await OperatorAuth.open({
      authFile: current.authFile,
      origin: current.origin,
    });
    owner.authClosed = false;
    owner.http = new LocalOperatorHttp(
      new LocalOperatorUi(current.service.domain()),
      owner.auth,
      { routes: operatorRoutes(current.service) },
    );
    owner.startAttempted = true;
    owner.httpStopped = false;
    return await owner.http.start(current.port);
  });
  evidence.operator.authenticated = evidence.operator.authenticated || false;
  return owner;
}

async function signedInPage(current, browserContext, password) {
  const page = await browserContext.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await login(page, current.origin, password);
  return page;
}

function taskView(service, taskId) {
  return service.coordinationView().readTask(taskId);
}

function recordSource(evidence, mode) {
  const sourceFiles = {
    domainSource: "src/core/domain.ts",
    coordinationCoreSource: "src/core/coordination.ts",
    stateSource: "src/standalone/state.ts",
    codexSource: "src/standalone/codex.ts",
    serviceSource: "src/standalone/service.ts",
    operatorSource: "src/standalone/operator.ts",
    coordinationViewSource: "src/standalone/coordination-view.ts",
    operatorCoordinationSource: "src/standalone/operator-coordination.ts",
    operatorRuntimeSource: "src/standalone/operator-runtime.ts",
    historySource: "src/standalone/conversation-history.ts",
    coordinationToolsSource: "src/standalone/coordination-tools.ts",
    domainCompiled: "dist/src/core/domain.js",
    coordinationCoreCompiled: "dist/src/core/coordination.js",
    stateCompiled: "dist/src/standalone/state.js",
    codexCompiled: "dist/src/standalone/codex.js",
    serviceCompiled: "dist/src/standalone/service.js",
    operatorCompiled: "dist/src/standalone/operator.js",
    coordinationViewCompiled: "dist/src/standalone/coordination-view.js",
    operatorCoordinationCompiled:
      "dist/src/standalone/operator-coordination.js",
    operatorRuntimeCompiled: "dist/src/standalone/operator-runtime.js",
    historyCompiled: "dist/src/standalone/conversation-history.js",
    coordinationToolsCompiled: "dist/src/standalone/coordination-tools.js",
    harness: "test/s05/live-journey.mjs",
    uiHarness: "test/s05/live-journey-ui.mjs",
    captureObserverSource: "test/s05/capture-observer.ts",
    captureObserverCompiled: "dist/test/s05/capture-observer.js",
  };
  evidence.source = {
    revision: runCommand("git", ["rev-parse", "HEAD"], process.cwd()),
    node: process.version,
    packageManager: "npm@12.1.0 (package.json pin; direct Node invocation)",
    npmExecPath: process.env.npm_execpath ? "present" : null,
    codex: runCommand("codex", ["--version"], process.cwd()),
    mode,
    hashes: Object.fromEntries(
      Object.entries(sourceFiles).map(([key, path]) => [key, digest(path)]),
    ),
  };
}

async function runRepositoryJourney(
  current,
  page,
  root,
  privateValues,
  evidence,
) {
  const initialLeadInstructions =
    "You are accountable for task completion. Do not edit repository files. First delegate only implementation to the exact implementer profile in the task brief; after the successful durable delegation, return a short final message and end this turn immediately. Do not poll or wait in the active turn; resume only when the implementer's result is delivered through your inbox. The implementer owns the initial nested review and must report its initial result and review finding to you, preserving the exact nested review result ID in that report summary. Then use ensemble_request_follow_up on that exact initial result to ask the same implementer to change answer.txt from 41 to 42; after the successful durable follow-up, end this turn and resume only through the delivered inbox. After the revision-two result reaches you, delegate a new revision-two review to the exact reviewer profile in the task brief; end that turn after successful delegation and resume when the review result is delivered. Only then request completion with exactly all current results: the nested review result ID relayed in the initial report, the revision-two implementation result ID, and the revision-two review result ID. Include S05_REPOSITORY_TASK in each final message. Use registered Ensemble coordination tools; never bypass review or complete from a worker result alone.";
  const implementerInstructions =
    "Work only in the task's bound repository workspace. For your initial assignment, change answer.txt to exactly 41 followed by a newline. Before reporting your initial result to the lead, use ensemble_delegate once for the exact reviewer profile ID in the task brief. Ask that reviewer to inspect the current answer.txt value and compare it with the requested final value 42; do not pass the first review to the lead yourself. After the successful durable delegation, return a short final message containing S05_REPOSITORY_TASK and end this turn immediately. Do not poll or wait in the active turn; resume only when the review result is delivered through your inbox. Then report your initial artifact value and review finding to the lead with ensemble_report_result, copying the exact nested review result ID from your inbox into your initial result summary. Return a short final message, and end the turn. When the lead requests a follow-up on that exact initial result, change answer.txt to exactly 42 followed by a newline and report the revision-two result, then end the turn; the lead will request the second review. Do not delegate the second review. Do not use network or access paths outside the workspace.";
  const reviewerInstructions =
    "Review the exact artifact revision described in your assignment brief by reading answer.txt from the bound task workspace. For the initial nested review, no implementation result ID exists yet: inspect the live file, report its actual value, and compare it with the requested final value 42. For the later revision-two review, use the exact implementation result ID named in the lead's brief and confirm answer.txt is 42. Do not edit files, delegate, request follow-up, or request task completion. Return your finding to your requester with ensemble_report_result.";
  const leadId = await createProfile(
    page,
    current.origin,
    "S05 repository lead",
    initialLeadInstructions,
    "accountable task lead",
  );
  const implementerId = await createProfile(
    page,
    current.origin,
    "S05 repository implementer",
    implementerInstructions,
    "fixture implementation",
  );
  const reviewerId = await createProfile(
    page,
    current.origin,
    "S05 repository reviewer",
    reviewerInstructions,
    "fixture review",
  );
  privateValues.push(
    initialLeadInstructions,
    implementerInstructions,
    reviewerInstructions,
    "S05_REPOSITORY_PROJECT_PRIVATE_INSTRUCTIONS",
    "S05_REPOSITORY_LEAD_PRIVATE_INSTRUCTIONS",
    "S05_REPOSITORY_IMPLEMENTER_PRIVATE_INSTRUCTIONS",
    "S05_REPOSITORY_REVIEWER_PRIVATE_INSTRUCTIONS",
  );
  const leadInstructions = `${initialLeadInstructions} S05_REPOSITORY_LEAD_PRIVATE_INSTRUCTIONS. ${noNetwork} The exact implementer profile is ${implementerId}; the exact reviewer profile is ${reviewerId}.`;
  privateValues.push(leadInstructions);
  await page.goto(`${current.origin}/profile/${leadId}`);
  const leadForm = page.locator('form[data-command="profile.configure"]');
  required((await leadForm.count()) === 1, "lead-profile-configuration-form");
  await leadForm
    .locator('textarea[name="instructions"]')
    .fill(leadInstructions);
  await leadForm
    .locator('textarea[name="capabilities"]')
    .fill("accountable task lead");
  await saveForm(page, leadForm);

  const projectId = await createProject(
    page,
    current.origin,
    "S05 disposable repository journey",
    leadId,
  );
  const projectInstructions = `S05_REPOSITORY_PROJECT_PRIVATE_INSTRUCTIONS. ${noNetwork} Treat this fixture as a delegated implementation with independent review. Only the project lead may request task completion.`;
  privateValues.push(projectInstructions);
  await configureProject(
    page,
    current.origin,
    projectId,
    projectInstructions,
    true,
  );
  const routingSetup = await configureRoutingCandidates(
    page,
    current.origin,
    projectId,
    [implementerId, reviewerId],
  );
  const repositoryPath = await createLocalRepository(root);
  privateValues.push(repositoryPath);
  const initialOutcome =
    "Draft a bounded repository task. This task is not Ready yet.";
  const outcome = [
    "S05_REPOSITORY_TASK: deliver a reviewed fixture result in this repository. Include this marker in each result and your final response.",
    `The exact implementer profile ID is ${implementerId}; the exact reviewer profile ID is ${reviewerId}.`,
    "Delegate only the first implementation to the implementer. It must change answer.txt from 0 to 41. Before reporting its initial result to you, the implementer must delegate the first review to the reviewer; that review must inspect the live file and return to its exact requester, the implementer.",
    "After receiving the implementer's initial result and nested review finding, call ensemble_request_follow_up on that exact initial implementation result and ask the same implementer to change answer.txt to 42.",
    "After the implementer reports revision two, delegate a NEW review to the reviewer. Include the exact revision-two implementation result ID in this review brief; the reviewer must inspect answer.txt and confirm it is 42. This second review is requested by you and returns to you.",
    "Only after the current revision-two implementation and second-review results have been delivered to you, call ensemble_request_completion with those exact two result IDs.",
    "Do not modify files yourself, do not bypass review, do not use network, and do not claim completion from a worker result alone.",
  ].join("\n");
  const repositoryInputs = [
    { repositoryId: "s05-local-fixture", path: repositoryPath, ref: "main" },
  ];
  const taskId = await createTask(
    page,
    current.origin,
    current.service,
    projectId,
    "S05 delegated repository review",
    initialOutcome,
    outcome,
    repositoryInputs,
  );
  const workspace = await current.service.taskWorkspace(taskId);
  required(workspace, "repository-binding-retained-before-ready");
  required(
    workspace.repositories.length === 1 &&
      workspace.repositories[0].repositoryId === "s05-local-fixture",
    "exactly-one-fixture-repository-bound-before-ready",
  );
  const workspacePath = realpathSync(workspace.path);
  const repositoryWorkspacePath = realpathSync(
    workspace.repositories[0].workspacePath,
  );
  required(
    !relative(root, workspacePath).startsWith(`..${sep}`) &&
      relative(root, workspacePath) !== ".." &&
      !relative(root, repositoryWorkspacePath).startsWith(`..${sep}`) &&
      relative(root, repositoryWorkspacePath) !== "..",
    "workspace-root-is-fixture-owned",
  );
  current.runtime.watchInitialReviewArtifact({
    taskId,
    leadProfileId: leadId,
    implementerProfileId: implementerId,
    reviewerProfileId: reviewerId,
    filePath: join(repositoryWorkspacePath, "answer.txt"),
    workspacePath: repositoryWorkspacePath,
  });

  await setCapacity(page, current.origin, 1);
  const capacityLimit = current.service.capacityLimits([projectId]).globalLimit;
  required(capacityLimit === 1, "repository-journey-global-capacity-one");
  required(current.service.powerStatus() === null, "power-trigger-disabled");
  required(
    current.service.list().every((intent) => intent.state !== "running"),
    "ready-paused-no-execution",
  );
  const capacityMeter = startCapacityMeter(current.service, projectId);
  let capacityObservation;
  try {
    current.runtime.markers.push("S05_REPOSITORY_TASK");
    await configureProject(page, current.origin, projectId, undefined, false);
    await waitUntil(
      () => {
        const task = taskView(current.service, taskId);
        return (
          task.task.state === "done" ||
          (task.results.length >= 4 &&
            taskIntents(current.service, taskId).every(
              (intent) =>
                intent.state !== "running" && intent.state !== "submitting",
            ))
        );
      },
      "repository-lead-review-completion",
      timeoutMs,
      current.runtime,
    );
  } finally {
    capacityObservation = capacityMeter.stop();
  }

  const view = taskView(current.service, taskId);
  const assignments = current.service.domain().assignments(taskId);
  const initialLead = assignments.find(
    (assignment) => String(assignment.profileId) === leadId,
  );
  const callsForTask = current.runtime.callbacks.filter(
    (call) => call.taskId === taskId,
  );
  const firstImplementationDelegations = callsForTask.filter(
    (call) =>
      call.tool === "ensemble_delegate" &&
      call.assignmentId === (initialLead ? String(initialLead.id) : null) &&
      call.requestedProfileId === implementerId,
  );
  const firstImplementationDelegation = firstImplementationDelegations[0];
  const firstImplementer = firstImplementationDelegation?.delegatedAssignmentId
    ? current.service
        .domain()
        .assignment(firstImplementationDelegation.delegatedAssignmentId)
    : undefined;
  const reviewers = assignments.filter(
    (assignment) => String(assignment.profileId) === reviewerId,
  );
  const nestedReviewDelegations = callsForTask.filter(
    (call) =>
      call.tool === "ensemble_delegate" &&
      call.assignmentId ===
        (firstImplementer ? String(firstImplementer.id) : null) &&
      call.requestedProfileId === reviewerId,
  );
  const secondReviewDelegations = callsForTask.filter(
    (call) =>
      call.tool === "ensemble_delegate" &&
      call.assignmentId === (initialLead ? String(initialLead.id) : null) &&
      call.requestedProfileId === reviewerId,
  );
  const nestedReviewDelegation = nestedReviewDelegations[0];
  const secondReviewDelegation = secondReviewDelegations[0];
  const nestedReviewer = nestedReviewDelegation?.delegatedAssignmentId
    ? current.service
        .domain()
        .assignment(nestedReviewDelegation.delegatedAssignmentId)
    : undefined;
  const secondReviewer = secondReviewDelegation?.delegatedAssignmentId
    ? current.service
        .domain()
        .assignment(secondReviewDelegation.delegatedAssignmentId)
    : undefined;
  const assignmentThreadBindings = {
    lead: initialLead
      ? assignmentTurnBindings(current.service, taskId, String(initialLead.id))
      : [],
    implementer: firstImplementer
      ? assignmentTurnBindings(
          current.service,
          taskId,
          String(firstImplementer.id),
        )
      : [],
    nestedReviewer: nestedReviewer
      ? assignmentTurnBindings(
          current.service,
          taskId,
          String(nestedReviewer.id),
        )
      : [],
    revisionTwoReviewer: secondReviewer
      ? assignmentTurnBindings(
          current.service,
          taskId,
          String(secondReviewer.id),
        )
      : [],
  };
  const assignmentIds = {
    lead: initialLead ? String(initialLead.id) : null,
    implementer: firstImplementer ? String(firstImplementer.id) : null,
    nestedReviewer: nestedReviewer ? String(nestedReviewer.id) : null,
    revisionTwoReviewer: secondReviewer ? String(secondReviewer.id) : null,
  };
  const selectedAssignmentThreadIds = Object.values(
    assignmentThreadBindings,
  ).map((bindings) => [
    ...new Set(bindings.map((binding) => binding.threadId)),
  ]);
  const callbackThreadBindingsVerified = Object.entries(
    assignmentThreadBindings,
  ).every(([role, bindings]) => {
    const assignmentId = assignmentIds[role];
    const threadIds = new Set(bindings.map((binding) => binding.threadId));
    const callbacks = callsForTask.filter(
      (call) => call.assignmentId === assignmentId,
    );
    return (
      !!assignmentId &&
      bindings.length > 0 &&
      callbacks.length > 0 &&
      callbacks.every((call) => threadIds.has(call.threadId))
    );
  });
  const distinctProfileThreadsVerified =
    selectedAssignmentThreadIds.every((threadIds) => threadIds.length === 1) &&
    new Set(selectedAssignmentThreadIds.map(([threadId]) => threadId)).size ===
      selectedAssignmentThreadIds.length;
  const implementerResults = view.results.filter((result) =>
    assignments.some(
      (assignment) =>
        String(assignment.id) === result.assignmentId &&
        String(assignment.profileId) === implementerId,
    ),
  );
  const reviewResults = view.results.filter((result) =>
    assignments.some(
      (assignment) =>
        String(assignment.id) === result.assignmentId &&
        String(assignment.profileId) === reviewerId,
    ),
  );
  const followUpCalls = callsForTask.filter(
    (call) => call.tool === "ensemble_request_follow_up",
  );
  const completionCalls = callsForTask.filter(
    (call) => call.tool === "ensemble_request_completion",
  );
  const followUp = followUpCalls[0];
  const initialImplementationResult = followUp?.requestedResultId
    ? implementerResults.find(
        (result) => result.resultId === followUp.requestedResultId,
      )
    : undefined;
  const revisionTwoImplementationResult = implementerResults.find(
    (result) =>
      result.resultId ===
      current.runtime.initialReviewWatch?.revisionTwoImplementationResultId,
  );
  const nestedReviewResult = nestedReviewer
    ? reviewResults.find(
        (result) => result.assignmentId === String(nestedReviewer.id),
      )
    : undefined;
  const revisionTwoReviewResult = secondReviewer
    ? reviewResults.find(
        (result) => result.assignmentId === String(secondReviewer.id),
      )
    : undefined;
  const workspaceArtifacts = safeRepositoryEvidence(repositoryPath, workspace);
  const leadHistory = initialLead
    ? verifyCapturedHistory(
        current.service,
        taskId,
        String(initialLead.id),
        privateValues,
      )
    : null;
  const stream = streamEvidenceForTask(
    current.runtime,
    current.service,
    taskId,
  );
  const reviewDeliveryMessage = (result) =>
    result
      ? view.messages.find((message) => message.resultId === result.resultId)
      : undefined;
  const nestedReviewDelivery = reviewDeliveryMessage(nestedReviewResult);
  const initialImplementationDelivery = reviewDeliveryMessage(
    initialImplementationResult,
  );
  const revisionTwoImplementationDelivery = reviewDeliveryMessage(
    revisionTwoImplementationResult,
  );
  const revisionTwoReviewDelivery = reviewDeliveryMessage(
    revisionTwoReviewResult,
  );
  const nestedReviewReportCall = nestedReviewResult
    ? callsForTask.find(
        (call) =>
          call.tool === "ensemble_report_result" &&
          call.assignmentId === nestedReviewResult.assignmentId &&
          call.recordedResultId === nestedReviewResult.resultId,
      )
    : undefined;
  const initialImplementationReportCall = initialImplementationResult
    ? callsForTask.find(
        (call) =>
          call.tool === "ensemble_report_result" &&
          call.assignmentId === initialImplementationResult.assignmentId &&
          call.recordedResultId === initialImplementationResult.resultId,
      )
    : undefined;
  const revisionTwoImplementationReportCall = revisionTwoImplementationResult
    ? callsForTask.find(
        (call) =>
          call.tool === "ensemble_report_result" &&
          call.assignmentId === revisionTwoImplementationResult.assignmentId &&
          call.recordedResultId === revisionTwoImplementationResult.resultId,
      )
    : undefined;
  const revisionTwoReviewReportCall = revisionTwoReviewResult
    ? callsForTask.find(
        (call) =>
          call.tool === "ensemble_report_result" &&
          call.assignmentId === revisionTwoReviewResult.assignmentId &&
          call.recordedResultId === revisionTwoReviewResult.resultId,
      )
    : undefined;
  const callbackIndex = (call) =>
    call ? current.runtime.callbacks.indexOf(call) : -1;
  const nestedFlowOrderVerified =
    callbackIndex(nestedReviewDelegation) >= 0 &&
    callbackIndex(nestedReviewReportCall) >
      callbackIndex(nestedReviewDelegation) &&
    callbackIndex(initialImplementationReportCall) >
      callbackIndex(nestedReviewReportCall);
  const followUpOrderVerified =
    callbackIndex(followUp) > callbackIndex(initialImplementationReportCall) &&
    callbackIndex(revisionTwoImplementationReportCall) >
      callbackIndex(followUp);
  const revisionTwoReviewOrderVerified =
    callbackIndex(secondReviewDelegation) >
      callbackIndex(revisionTwoImplementationReportCall) &&
    callbackIndex(revisionTwoReviewReportCall) >
      callbackIndex(secondReviewDelegation);
  const completionOrderVerified =
    callbackIndex(completionCalls[0]) >
    callbackIndex(revisionTwoReviewReportCall);
  const finalCompletion = view.completionRequests.findLast(
    (request) => request.status === "finalized",
  );
  const currentResultIds = view.results
    .filter(
      (result) =>
        !view.results.some(
          (newer) =>
            newer.assignmentId === result.assignmentId &&
            newer.workRevision > result.workRevision,
        ),
    )
    .map((result) => result.resultId)
    .sort();
  const expectedCurrentResultIds = [
    nestedReviewResult?.resultId,
    revisionTwoImplementationResult?.resultId,
    revisionTwoReviewResult?.resultId,
  ]
    .filter(isUuid)
    .sort();
  const sameResultIds = (left, right) =>
    left.length === right.length &&
    left.every((resultId, index) => resultId === right[index]);
  const completionReviewedCurrentResults = Boolean(
    nestedReviewResult &&
      revisionTwoImplementationResult &&
      revisionTwoReviewResult &&
      sameResultIds(currentResultIds, expectedCurrentResultIds) &&
      finalCompletion &&
      sameResultIds(
        [...finalCompletion.reviewedResultIds].sort(),
        currentResultIds,
      ),
  );
  const completionRejectionReasons = view.completionRequests
    .filter((request) => request.status === "rejected")
    .flatMap((request) => request.rejectionReasons)
    .filter((reason) => /^[a-z][a-z0-9-]{0,63}$/.test(reason))
    .slice(0, 16);
  const initialSummaryRelaysNestedReviewResult = Boolean(
    nestedReviewResult &&
      initialImplementationResult?.summary.includes(
        nestedReviewResult.resultId,
      ),
  );
  const initialArtifactWitness = current.runtime.initialArtifactWitness;
  const initialArtifactWitnessVerified = Boolean(
    initialArtifactWitness &&
      initialArtifactWitness.taskId === taskId &&
      initialArtifactWitness.implementerAssignmentId ===
        (firstImplementer ? String(firstImplementer.id) : null) &&
      initialArtifactWitness.reviewerAssignmentId ===
        (nestedReviewer ? String(nestedReviewer.id) : null) &&
      initialArtifactWitness.reviewResultId === nestedReviewResult?.resultId &&
      initialArtifactWitness.callbackIndex ===
        current.runtime.callbacks.indexOf(nestedReviewReportCall) &&
      initialArtifactWitness.callbackIndex <
        current.runtime.callbacks.indexOf(initialImplementationReportCall) &&
      initialArtifactWitness.fileValue === "41" &&
      initialArtifactWitness.matchesExpectedInitialValue,
  );
  const implementerThreadIds = new Set(
    assignmentThreadBindings.implementer.map((binding) => binding.threadId),
  );
  const implementerThreadReusedAcrossInitialAndFollowUp = Boolean(
    initialImplementationReportCall &&
      revisionTwoImplementationReportCall &&
      initialImplementationReportCall.threadId ===
        revisionTwoImplementationReportCall.threadId &&
      implementerThreadIds.size === 1 &&
      implementerThreadIds.has(initialImplementationReportCall.threadId),
  );
  const capacityOneReturnsVerified =
    capacityObservation?.configuredGlobalLimit === 1 &&
    capacityObservation.maximumObservedGlobalUsage === 1 &&
    capacityObservation.samples > 1;

  evidence.repository = {
    projectId,
    taskId,
    leadAssignmentId: initialLead ? String(initialLead.id) : null,
    implementerAssignmentId: firstImplementer
      ? String(firstImplementer.id)
      : null,
    reviewerAssignmentIds: reviewers.map((assignment) => String(assignment.id)),
    nestedReviewerAssignmentId: nestedReviewer
      ? String(nestedReviewer.id)
      : null,
    revisionTwoReviewerAssignmentId: secondReviewer
      ? String(secondReviewer.id)
      : null,
    assignmentCount: assignments.length,
    resultCount: view.results.length,
    implementationResultCount: implementerResults.length,
    reviewResultCount: reviewResults.length,
    completed: String(view.task.state) === "done",
    completionRequestStatuses: view.completionRequests.map(
      (request) => request.status,
    ),
    completionRejectionReasons,
    callbackTools: callsForTask.map((call) => ({
      tool: call.tool,
      threadId: call.threadId,
      turnId: call.turnId,
      profileId: call.profileId,
      assignmentId: call.assignmentId,
      success: call.success,
      ...(call.requestedResultId
        ? { requestedResultId: call.requestedResultId }
        : {}),
      ...(call.requestedProfileId
        ? { requestedProfileId: call.requestedProfileId }
        : {}),
      ...(call.delegatedAssignmentId
        ? { delegatedAssignmentId: call.delegatedAssignmentId }
        : {}),
      ...(call.delegatedRequesterAssignmentId
        ? {
            delegatedRequesterAssignmentId: call.delegatedRequesterAssignmentId,
          }
        : {}),
      ...(call.delegatedResultDestination
        ? { delegatedResultDestination: call.delegatedResultDestination }
        : {}),
      ...(call.recordedResultId
        ? { recordedResultId: call.recordedResultId }
        : {}),
      ...(call.briefReferencesRevisionTwoResult !== undefined
        ? {
            briefReferencesRevisionTwoResult:
              call.briefReferencesRevisionTwoResult,
          }
        : {}),
      ...(call.targetsInitialImplementationResult !== undefined
        ? {
            targetsInitialImplementationResult:
              call.targetsInitialImplementationResult,
          }
        : {}),
      ...(call.reviewedResultIds
        ? { reviewedResultIds: call.reviewedResultIds }
        : {}),
    })),
    firstImplementerRequesterMatchesLead:
      !!firstImplementer &&
      !!initialLead &&
      firstImplementationDelegations.length === 1 &&
      firstImplementationDelegation?.success === true &&
      firstImplementer.requesterAssignmentId === String(initialLead.id) &&
      firstImplementer.resultDestination === String(initialLead.id),
    nestedReviewReturnedToImplementer:
      !!nestedReviewer &&
      !!nestedReviewResult &&
      nestedReviewer.requesterAssignmentId === String(firstImplementer?.id) &&
      nestedReviewer.resultDestination === String(firstImplementer?.id) &&
      nestedReviewResult.recipientAssignmentId ===
        String(firstImplementer?.id) &&
      nestedReviewDelivery?.recipientAssignmentId ===
        String(firstImplementer?.id) &&
      nestedReviewDelivery.deliveryState === "delivered",
    nestedReviewBeforeInitialImplementationReport:
      nestedFlowOrderVerified &&
      callbackIndex(nestedReviewReportCall) <
        callbackIndex(initialImplementationReportCall),
    firstArtifactWitness: initialArtifactWitness,
    firstArtifactWas41BeforeFollowUp: initialArtifactWitnessVerified,
    initialImplementationResultId:
      initialImplementationResult?.resultId ?? null,
    revisionTwoImplementationResultId:
      revisionTwoImplementationResult?.resultId ?? null,
    nestedReviewResultId: nestedReviewResult?.resultId ?? null,
    initialSummaryRelaysNestedReviewResult,
    revisionTwoReviewResultId: revisionTwoReviewResult?.resultId ?? null,
    secondReviewReturnedToLead:
      !!secondReviewer &&
      !!revisionTwoReviewResult &&
      secondReviewer.requesterAssignmentId === String(initialLead?.id) &&
      secondReviewer.resultDestination === String(initialLead?.id) &&
      revisionTwoReviewResult.recipientAssignmentId ===
        String(initialLead?.id) &&
      revisionTwoReviewDelivery?.recipientAssignmentId ===
        String(initialLead?.id) &&
      revisionTwoReviewDelivery.deliveryState === "delivered",
    revisionTwoReviewBriefReferencesExactResult:
      secondReviewDelegation?.briefReferencesRevisionTwoResult === true,
    initialResultDeliveredToLead:
      !!initialImplementationResult &&
      initialImplementationResult.recipientAssignmentId ===
        String(initialLead?.id) &&
      initialImplementationDelivery?.deliveryState === "delivered",
    revisionTwoResultDeliveredToLead:
      !!revisionTwoImplementationResult &&
      revisionTwoImplementationResult.recipientAssignmentId ===
        String(initialLead?.id) &&
      revisionTwoImplementationDelivery?.deliveryState === "delivered",
    followUpRequested: followUpCalls.length === 1,
    followUpReferencedImplementationResult:
      followUpCalls.length === 1 &&
      followUp?.targetsInitialImplementationResult === true &&
      followUp?.assignmentId === String(initialLead?.id) &&
      followUp?.requestedResultId === initialImplementationResult?.resultId,
    leadRequestedFollowUp:
      followUpCalls.length === 1 &&
      followUp?.success === true &&
      followUp?.assignmentId === String(initialLead?.id),
    nestedReviewDelegationCount: nestedReviewDelegations.length,
    revisionTwoReviewDelegationCount: secondReviewDelegations.length,
    reviewerAssignmentCount: reviewers.length,
    twoRevisionReviewsVerified:
      reviewers.length === 2 &&
      firstImplementationDelegations.length === 1 &&
      nestedReviewDelegations.length === 1 &&
      secondReviewDelegations.length === 1 &&
      nestedReviewDelegation?.success === true &&
      secondReviewDelegation?.success === true,
    assignmentThreadBindings,
    callbackThreadBindingsVerified,
    distinctProfileThreadsVerified,
    implementerThreadReusedAcrossInitialAndFollowUp,
    callbackOrder: {
      nestedReviewBeforeInitialReport: nestedFlowOrderVerified,
      followUpAfterInitialReportAndRevisionTwoAfterFollowUp:
        followUpOrderVerified,
      revisionTwoReviewAfterRevisionTwoReport: revisionTwoReviewOrderVerified,
      completionAfterRevisionTwoReview: completionOrderVerified,
    },
    routingSetup,
    capacity: capacityObservation,
    currentResultIds,
    finalCompletionReviewedResultIds:
      finalCompletion?.reviewedResultIds.slice(0, 20) ?? [],
    capacityOneReturnsVerified,
    completionReviewedCurrentResults,
    artifact: workspaceArtifacts,
    stream,
    leadHistory,
  };
  required(
    evidence.repository.completed &&
      evidence.repository.firstImplementerRequesterMatchesLead &&
      evidence.repository.nestedReviewReturnedToImplementer &&
      evidence.repository.nestedReviewBeforeInitialImplementationReport &&
      evidence.repository.firstArtifactWas41BeforeFollowUp &&
      evidence.repository.secondReviewReturnedToLead &&
      evidence.repository.revisionTwoReviewBriefReferencesExactResult &&
      evidence.repository.initialResultDeliveredToLead &&
      evidence.repository.revisionTwoResultDeliveredToLead &&
      evidence.repository.twoRevisionReviewsVerified &&
      evidence.repository.callbackThreadBindingsVerified &&
      evidence.repository.distinctProfileThreadsVerified &&
      evidence.repository.implementerThreadReusedAcrossInitialAndFollowUp &&
      evidence.repository.callbackOrder
        .followUpAfterInitialReportAndRevisionTwoAfterFollowUp &&
      evidence.repository.callbackOrder
        .revisionTwoReviewAfterRevisionTwoReport &&
      evidence.repository.callbackOrder.completionAfterRevisionTwoReview &&
      evidence.repository.capacityOneReturnsVerified &&
      evidence.repository.routingSetup.routingDisabled &&
      evidence.repository.routingSetup.credentialReferenceEmpty &&
      evidence.repository.followUpRequested &&
      evidence.repository.followUpReferencedImplementationResult &&
      evidence.repository.leadRequestedFollowUp &&
      evidence.repository.initialSummaryRelaysNestedReviewResult &&
      evidence.repository.completionReviewedCurrentResults &&
      stream.lifecycleObserved &&
      stream.markerMatchedTurns > 0 &&
      workspaceArtifacts.fileMatchesExpected &&
      workspaceArtifacts.gitDiffContainsFinalValue &&
      leadHistory?.exactTaskAssignmentBinding &&
      leadHistory.knownPrivateValuesExcluded,
    "repository-journey-evidence",
  );
  required(
    completionCalls.some((call) => call.success),
    "lead-requested-completion",
  );
  return { projectId, taskId, leadId };
}

async function configureChangedRevision(
  page,
  current,
  projectId,
  nextInstructions,
) {
  await page.goto(`${current.origin}/project/${projectId}`);
  const form = page.locator('form[data-command="project.configure"]');
  await form.locator('textarea[name="instructions"]').fill(nextInstructions);
  await form.locator('input[name="paused"]').check();
  const replayFields = await form.evaluate((element) => {
    const data = new FormData(element);
    return Object.fromEntries(data.entries());
  });
  await saveForm(page, form);
  const response = await current.browserContext.request.post(
    `${current.origin}/command`,
    {
      headers: { origin: current.origin },
      form: replayFields,
      maxRedirects: 0,
    },
  );
  required(response.status() === 303, "changed-instruction-keyed-replay");
  return Number(
    current.service.domain().project(projectId).instructionsRevision,
  );
}

async function runRepositoryFreeJourney(
  current,
  page,
  privateValues,
  evidence,
) {
  const leadInstructions =
    'S05 repository-free lead private instructions. For Alpha, delegate exactly once to the configured Alpha worker; after the successful durable delegation, include the task marker in a short final message and end the turn immediately. Do not poll or wait in the active turn; resume only through the delivered worker-result inbox, then request completion using that exact result ID. For Beta, open its one planned question and request approval in the same turn with action "Write fixture-only relative file", target "s05-denied.txt", and material exactly {relativePath: "s05-denied.txt", content: "S05_BETA_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST"}; do not write the file. Then include its task marker in a short final message and end the turn without reporting or requesting completion. Resume only when both operator responses are delivered through the inbox, then request completion with an empty reviewedResultIds list. Never poll or wait inside an active turn.';
  const alphaWorkerInstructions =
    'For the S05 Alpha task only, open exactly one task-marker-bound operator question and request approval with action "Write fixture-only relative file", target "s05-denied.txt", and material exactly {relativePath: "s05-denied.txt", content: "S05_ALPHA_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST"}. Do not write the file or perform any action requiring approval. After both interactions are durably opened, include S05_ALPHA_TASK_MARKER in a short final message and end this turn immediately; do not report a result or request completion yet, and do not poll or wait in the active turn. Resume only when both operator responses are delivered through your inbox. Then report one concise result containing the marker, the answer, and the denied approval to your exact requester with ensemble_report_result, and end that turn. Do not ask again or request completion.';
  const alphaWorkerId = await createProfile(
    page,
    current.origin,
    "S05 repo-free Alpha worker",
    alphaWorkerInstructions,
    "fixture-only Alpha coordination worker",
  );
  const leadId = await createProfile(
    page,
    current.origin,
    "S05 shared project lead",
    leadInstructions,
    "task coordination",
  );
  privateValues.push(leadInstructions, alphaWorkerInstructions);
  const projects = [];
  for (const suffix of ["ALPHA", "BETA"]) {
    const projectInstructions = `S05_${suffix}_PROJECT_PRIVATE_INSTRUCTIONS. ${noNetwork}`;
    privateValues.push(projectInstructions);
    const projectId = await createProject(
      page,
      current.origin,
      `S05 repo-free ${suffix.toLowerCase()} project`,
      leadId,
    );
    await configureProject(
      page,
      current.origin,
      projectId,
      projectInstructions,
      true,
    );
    if (suffix === "ALPHA")
      await configureRoutingCandidates(page, current.origin, projectId, [
        alphaWorkerId,
      ]);
    const outcome =
      suffix === "ALPHA"
        ? [
            "S05_ALPHA_TASK_MARKER: perform a bounded project-free operator coordination probe.",
            `The exact permitted worker profile ID is ${alphaWorkerId}. As the task lead, delegate this probe exactly once to that worker. Its brief must ask for one marker-bound operator question and approval with action "Write fixture-only relative file", target "s05-denied.txt", and material exactly {relativePath: "s05-denied.txt", content: "S05_ALPHA_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST"}. After successful delegation, end your turn; do not poll or wait. The worker must open both interactions in its first turn, then end that turn without result or completion. After both exact operator responses are delivered to the worker, it reports its result to you. Resume from that inbox delivery and request completion with that exact worker result ID. Include the marker in each final message; do not write the file or perform an action requiring approval.`,
          ].join("\n")
        : [
            "S05_BETA_TASK_MARKER: perform a bounded project-free operator coordination probe.",
            'As the task lead, call ensemble_ask_question exactly once with a question containing this task marker and asking for the expected harmless fixture response. In the same turn, call ensemble_request_approval exactly once with action "Write fixture-only relative file", target "s05-denied.txt", and material exactly {relativePath: "s05-denied.txt", content: "S05_BETA_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST"}. Do not write the file. After both interactions are durably opened, include the marker in a short final message and end the turn without reporting or requesting completion. Do not poll or wait. Resume only when both operator responses arrive through your inbox, then call ensemble_request_completion once with an empty reviewedResultIds list. Do not perform any action requiring approval.',
          ].join("\n");
    const taskId = await createTask(
      page,
      current.origin,
      current.service,
      projectId,
      `S05 repo-free ${suffix.toLowerCase()} task`,
      "This initial draft is intentionally unready.",
      outcome,
    );
    projects.push({
      suffix,
      projectId,
      taskId,
      instructions: projectInstructions,
      workerProfileId: suffix === "ALPHA" ? alphaWorkerId : null,
    });
  }
  await setCapacity(page, current.origin, 2);
  current.runtime.markers.push("S05_ALPHA_TASK_MARKER", "S05_BETA_TASK_MARKER");
  for (const project of projects)
    await configureProject(
      page,
      current.origin,
      project.projectId,
      undefined,
      false,
    );

  await waitUntil(
    () =>
      projects.every((project) => {
        const view = taskView(current.service, project.taskId);
        return (
          view.questions.some((item) => item.status === "open") &&
          view.approvals.some((item) => item.status === "open") &&
          current.service
            .list()
            .filter(
              (intent) =>
                intent.state === "running" || intent.state === "submitting",
            )
            .filter((intent) =>
              current.service
                .turnRequests()
                .some(
                  (request) =>
                    request.workId === intent.workId &&
                    request.taskId === project.taskId,
                ),
            ).length === 0
        );
      }),
    "repo-free-open-question-approval-at-idle-terminal",
    timeoutMs,
    current.runtime,
  );
  required(
    current.runtime.activeCallbacks === 0,
    "successful-terminal-no-active-callback",
  );
  const initialStreamEvidence = projects.map((project) => ({
    suffix: project.suffix,
    ...streamEvidenceForTask(current.runtime, current.service, project.taskId),
  }));
  required(
    initialStreamEvidence.every(
      (item) => item.lifecycleObserved && item.markerMatchedTurns > 0,
    ),
    "repo-free-real-runtime-stream-evidence",
  );

  const interactionBindingChecks = [];
  evidence.repoFree = { interactionBindingChecks };
  const initial = projects.map((project) => {
    const view = taskView(current.service, project.taskId);
    const leadAssignment = current.service
      .domain()
      .assignments(project.taskId)
      .find((assignment) => String(assignment.profileId) === leadId);
    required(leadAssignment, "repo-free-lead-assignment");
    const workerAssignments = current.service
      .domain()
      .assignments(project.taskId)
      .filter(
        (assignment) =>
          project.workerProfileId !== null &&
          String(assignment.profileId) === project.workerProfileId,
      );
    const requesterAssignmentId =
      project.suffix === "ALPHA"
        ? String(workerAssignments[0]?.id ?? "")
        : String(leadAssignment.id);
    required(
      project.suffix !== "ALPHA" || workerAssignments.length === 1,
      "alpha-has-one-exact-delegated-worker",
    );
    const question = view.questions.find((item) => item.status === "open");
    const approval = view.approvals.find((item) => item.status === "open");
    required(question && approval, "repo-free-live-interactions");
    const interactionCalls = current.runtime.callbacks.filter(
      (call) =>
        call.taskId === project.taskId &&
        call.assignmentId === requesterAssignmentId &&
        (call.tool === "ensemble_ask_question" ||
          call.tool === "ensemble_request_approval"),
    );
    const questionCalls = interactionCalls.filter(
      (call) => call.tool === "ensemble_ask_question",
    );
    const approvalCalls = interactionCalls.filter(
      (call) => call.tool === "ensemble_request_approval",
    );
    const requesterAssignment = current.service
      .domain()
      .assignment(requesterAssignmentId);
    required(
      interactionCalls.length === 2 &&
        questionCalls.length === 1 &&
        approvalCalls.length === 1 &&
        questionCalls[0]?.success === true &&
        approvalCalls[0]?.success === true &&
        questionCalls[0]?.turnId === approvalCalls[0]?.turnId &&
        question.requestingWorkId === approval.requestingWorkId,
      "both-interactions-opened-once-in-one-initial-turn",
    );
    if (project.suffix === "ALPHA") {
      const leadDelegations = current.runtime.callbacks.filter(
        (call) =>
          call.taskId === project.taskId &&
          call.assignmentId === String(leadAssignment.id) &&
          call.tool === "ensemble_delegate",
      );
      required(
        leadDelegations.length === 1 &&
          leadDelegations[0]?.success === true &&
          leadDelegations[0]?.requestedProfileId === project.workerProfileId &&
          String(requesterAssignment.requesterAssignmentId) ===
            String(leadAssignment.id) &&
          String(requesterAssignment.resultDestination) ===
            String(leadAssignment.id),
        "alpha-worker-delegated-to-and-reports-to-exact-lead",
      );
    } else
      required(
        String(requesterAssignment.id) === String(leadAssignment.id),
        "beta-lead-owns-its-interactions",
      );
    const interactionBinding = {
      project: project.suffix,
      questionCallCount: questionCalls.length,
      approvalCallCount: approvalCalls.length,
      questionPromptMarkerMatches: question.prompt.includes(
        `S05_${project.suffix}_TASK_MARKER`,
      ),
      approvalActionMatches:
        approval.action === "Write fixture-only relative file",
      approvalTargetMatches: approval.target === "s05-denied.txt",
      approvalMaterialMarkerMatches: Boolean(
        approval.materialJson?.includes(
          `S05_${project.suffix}_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST`,
        ),
      ),
      questionRequesterMatches:
        question.requestingAssignmentId === requesterAssignmentId,
      approvalRequesterMatches:
        approval.requestingAssignmentId === requesterAssignmentId,
    };
    interactionBindingChecks.push(interactionBinding);
    required(
      interactionBinding.questionCallCount === 1 &&
        interactionBinding.approvalCallCount === 1 &&
        interactionBinding.questionPromptMarkerMatches &&
        interactionBinding.approvalActionMatches &&
        interactionBinding.approvalTargetMatches &&
        interactionBinding.approvalMaterialMarkerMatches &&
        interactionBinding.questionRequesterMatches &&
        interactionBinding.approvalRequesterMatches,
      "task-specific-interaction-binding",
    );
    return {
      ...project,
      leadAssignmentId: String(leadAssignment.id),
      workerAssignmentId:
        project.suffix === "ALPHA" ? requesterAssignmentId : null,
      requesterAssignmentId,
      interactionTurnId: questionCalls[0].turnId,
      interactionWorkId: question.requestingWorkId,
      questionAndApprovalOpenedOnceInSameTurn: true,
      question,
      approval,
    };
  });

  const previousConversationIdentity = initial.map((project) => {
    const work = current.service
      .list()
      .find((intent) => intent.workId === project.question.requestingWorkId);
    return {
      taskId: project.taskId,
      threadId: work?.threadId ?? null,
      turnId: work?.turnId ?? null,
    };
  });
  required(
    previousConversationIdentity.every(
      (item) => item.threadId && item.turnId,
    ) &&
      new Set(previousConversationIdentity.map((item) => item.threadId))
        .size === 2,
    "two-independent-bound-threads",
  );

  const alpha = initial.find((project) => project.suffix === "ALPHA");
  const beta = initial.find((project) => project.suffix === "BETA");
  required(alpha && beta, "two-projects-created");

  const alphaChangedInstructions =
    "S05_ALPHA_PROJECT_REVISION_THREE_PRIVATE. Preserve queued operator feedback and apply this revision only through explicit next-turn apply.";
  const alphaRevision = await configureChangedRevision(
    page,
    current,
    alpha.projectId,
    alphaChangedInstructions,
  );
  privateValues.push(alphaChangedInstructions);
  await page.goto(`${current.origin}/coordination/task/${alpha.taskId}`);
  const alphaLeadMessage = page
    .locator('form[action="/coordination/control/message"]')
    .filter({
      has: page.locator(
        `input[name="recipientAssignmentId"][value="${alpha.leadAssignmentId}"]`,
      ),
    });
  await alphaLeadMessage
    .locator('textarea[name="message"]')
    .fill(
      "S05_ALPHA_QUEUED_MESSAGE: retain the explicit project revision boundary.",
    );
  const messageResponse = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/coordination/control/message" &&
      candidate.request().method() === "POST",
  );
  await alphaLeadMessage.getByRole("button", { name: "Submit" }).click();
  required((await messageResponse).status() === 303, "paused-message-accepted");
  required(
    current.service.list().filter((intent) => intent.state === "running")
      .length === 0,
    "paused-project-no-running-turn",
  );

  evidence.operator.restartAtIdleSuccessfulTerminal = true;
  evidence.repoFree = {
    interactionBindingChecks,
    projects: initial.map((project, index) => ({
      suffix: project.suffix,
      projectId: project.projectId,
      taskId: project.taskId,
      leadAssignmentId: project.leadAssignmentId,
      workerProfileId: project.workerProfileId,
      workerAssignmentId: project.workerAssignmentId,
      requesterAssignmentId: project.requesterAssignmentId,
      threadId: previousConversationIdentity[index].threadId,
      turnId: previousConversationIdentity[index].turnId,
      questionInteractionId: project.question.interactionId,
      approvalInteractionId: project.approval.interactionId,
      instructionsRevision: Number(
        current.service.domain().project(project.projectId)
          .instructionsRevision,
      ),
    })),
    alphaInstructionsRevisionAfterChange: alphaRevision,
    initialStreamEvidence,
  };
  return { leadId, projects: initial, alphaRevision };
}

async function answerQuestionAndDenyApproval(page, current, task) {
  await page.goto(`${current.origin}/coordination/task/${task.taskId}`);
  const before = taskView(current.service, task.taskId);
  const openQuestions = before.questions.filter(
    (item) => item.status === "open",
  );
  const openApprovals = before.approvals.filter(
    (item) => item.status === "open",
  );
  const question = openQuestions[0];
  const approval = openApprovals[0];
  required(
    question &&
      approval &&
      openQuestions.length === 1 &&
      openApprovals.length === 1,
    "one-open-question-and-approval-after-restart",
  );
  required(
    question.requestingAssignmentId === task.requesterAssignmentId &&
      approval.requestingAssignmentId === task.requesterAssignmentId,
    "operator-responses-target-exact-requester",
  );
  const answerForm = page
    .locator('form[action="/coordination/control/question/answer"]')
    .filter({
      has: page.locator(
        `input[name="interactionId"][value="${question.interactionId}"]`,
      ),
    });
  await answerForm
    .locator('textarea[name="answer"]')
    .fill(`S05_${task.suffix}_OPERATOR_ANSWER`);
  const answerFields = await formPayload(answerForm);
  await submitForm(
    page,
    answerForm,
    "/coordination/control/question/answer",
    "Submit",
  );
  const afterAnswer = taskView(current.service, task.taskId);
  const initialQuestionEvents = afterAnswer.messages.filter(
    (message) =>
      message.eventType === "question-answer" &&
      message.interactionId === question.interactionId,
  );
  required(
    initialQuestionEvents.length === 1 && initialQuestionEvents[0]?.eventId,
    "operator-question-answer-committed-once",
  );
  const questionCommandReplay = await replayOperatorForm(
    current,
    task.taskId,
    question.interactionId,
    "question-answer",
    initialQuestionEvents[0].eventId,
    "answer-question",
    "/coordination/control/question/answer",
    answerFields,
  );

  const denyForm = page
    .locator('form[action="/coordination/control/approval/decision"]')
    .filter({
      has: page.locator(
        `input[name="interactionId"][value="${approval.interactionId}"]`,
      ),
    })
    .filter({ has: page.locator('input[name="decision"][value="denied"]') });
  const denialFields = await formPayload(denyForm);
  await submitForm(
    page,
    denyForm,
    "/coordination/control/approval/decision",
    "Deny",
  );
  const afterDenial = taskView(current.service, task.taskId);
  const initialApprovalEvents = afterDenial.messages.filter(
    (message) =>
      message.eventType === "approval-decision" &&
      message.interactionId === approval.interactionId,
  );
  required(
    initialApprovalEvents.length === 1 && initialApprovalEvents[0]?.eventId,
    "operator-approval-denial-committed-once",
  );
  const approvalCommandReplay = await replayOperatorForm(
    current,
    task.taskId,
    approval.interactionId,
    "approval-decision",
    initialApprovalEvents[0].eventId,
    "decide-approval",
    "/coordination/control/approval/decision",
    denialFields,
  );
  const after = taskView(current.service, task.taskId);
  const questionAnswerEvents = after.messages.filter(
    (message) =>
      message.eventType === "question-answer" &&
      message.interactionId === question.interactionId,
  );
  const approvalDecisionEvents = after.messages.filter(
    (message) =>
      message.eventType === "approval-decision" &&
      message.interactionId === approval.interactionId,
  );
  const deniedApproval = after.approvals.find(
    (item) => item.interactionId === approval.interactionId,
  );
  const requestingIntent = taskIntents(current.service, task.taskId).find(
    (intent) => intent.workId === approval.requestingWorkId,
  );
  required(requestingIntent?.workspace, "denied-action-bound-workspace");
  required(deniedApproval, "denied-action-current-approval");
  const approvalActionDecision = runFixtureRelativeFileApprovalAdapter({
    databasePath: join(current.dataDir, "standalone.sqlite"),
    workspacePath: requestingIntent.workspace,
    approval: deniedApproval,
  });
  required(
    approvalActionDecision.authorizationChecked &&
      !approvalActionDecision.authorizationGranted &&
      approvalActionDecision.targetWithinWorkspace &&
      approvalActionDecision.fileAbsent,
    "denied-relative-file-action-stays-absent",
  );
  const answerEvidence = {
    questionInteractionId: question.interactionId,
    approvalInteractionId: approval.interactionId,
    questionStatus:
      after.questions.find(
        (item) => item.interactionId === question.interactionId,
      )?.status ?? "missing",
    approvalStatus:
      after.approvals.find(
        (item) => item.interactionId === approval.interactionId,
      )?.status ?? "missing",
    questionAnswerEventCount: questionAnswerEvents.length,
    approvalDecisionEventCount: approvalDecisionEvents.length,
    approvalDecisionWasDenied: approvalDecisionEvents[0]?.decision === "denied",
    requesterAssignmentId: task.requesterAssignmentId,
    questionAnswerEventId: questionAnswerEvents[0]?.eventId ?? null,
    approvalDecisionEventId: approvalDecisionEvents[0]?.eventId ?? null,
    questionAnswerRecipientAssignmentId:
      questionAnswerEvents[0]?.recipientAssignmentId ?? null,
    approvalDecisionRecipientAssignmentId:
      approvalDecisionEvents[0]?.recipientAssignmentId ?? null,
    questionAnswerDeliveryState:
      questionAnswerEvents[0]?.deliveryState ?? "missing",
    approvalDecisionDeliveryState:
      approvalDecisionEvents[0]?.deliveryState ?? "missing",
    questionCommandReplay,
    approvalCommandReplay,
    approvalActionDecision,
  };
  required(
    answerEvidence.questionStatus === "answered" &&
      answerEvidence.approvalStatus === "denied" &&
      answerEvidence.questionAnswerEventCount === 1 &&
      answerEvidence.approvalDecisionEventCount === 1 &&
      answerEvidence.approvalDecisionWasDenied &&
      answerEvidence.questionAnswerRecipientAssignmentId ===
        task.requesterAssignmentId &&
      answerEvidence.approvalDecisionRecipientAssignmentId ===
        task.requesterAssignmentId,
    "question-and-denial-applied-exactly-once",
  );
  return answerEvidence;
}

function verifyOperatorResponseDelivery(service, taskId, responses) {
  const messages = taskView(service, taskId).messages;
  const questionAnswer = messages.find(
    (message) => message.eventId === responses.questionAnswerEventId,
  );
  const approvalDecision = messages.find(
    (message) => message.eventId === responses.approvalDecisionEventId,
  );
  responses.questionAnswerDeliveryState =
    questionAnswer?.deliveryState ?? "missing";
  responses.approvalDecisionDeliveryState =
    approvalDecision?.deliveryState ?? "missing";
  responses.responsesDeliveredOnceToExactRequester =
    questionAnswer?.deliveryState === "delivered" &&
    approvalDecision?.deliveryState === "delivered" &&
    questionAnswer?.recipientAssignmentId === responses.requesterAssignmentId &&
    approvalDecision?.recipientAssignmentId === responses.requesterAssignmentId;
  required(
    responses.responsesDeliveredOnceToExactRequester,
    "operator-responses-delivered-once-to-exact-requester",
  );
}

async function completeRepoFree(current, page, repositoryFree, evidence) {
  const alpha = repositoryFree.projects.find(
    (project) => project.suffix === "ALPHA",
  );
  const beta = repositoryFree.projects.find(
    (project) => project.suffix === "BETA",
  );
  const alphaRevision = repositoryFree.alphaRevision;
  required(alpha && beta, "repo-free-tasks-retained");
  required(
    Number.isInteger(alphaRevision),
    "alpha-revision-retained-for-apply",
  );
  const betaInteractionResponses = await answerQuestionAndDenyApproval(
    page,
    current,
    beta,
  );
  await waitUntil(
    () => taskView(current.service, beta.taskId).task.state === "done",
    "unpaused-project-proceeds-while-alpha-paused",
    timeoutMs,
    current.runtime,
  );
  verifyOperatorResponseDelivery(
    current.service,
    beta.taskId,
    betaInteractionResponses,
  );
  const betaCompletion = taskView(
    current.service,
    beta.taskId,
  ).completionRequests.find((request) => request.status === "finalized");
  const betaCompletionVerified =
    betaCompletion?.leadAssignmentId === beta.leadAssignmentId &&
    betaCompletion.reviewedResultIds.length === 0;
  required(betaCompletionVerified, "beta-lead-completed-own-probe");
  required(
    current.service.domain().project(alpha.projectId).paused === 1 &&
      current.service.domain().project(beta.projectId).paused === 0,
    "independent-project-pause-state",
  );

  const alphaView = taskView(current.service, alpha.taskId);
  const queuedMessage = alphaView.messages.find((message) =>
    message.text?.includes("S05_ALPHA_QUEUED_MESSAGE"),
  );
  required(
    queuedMessage?.deliveryState === "queued",
    "paused-message-remains-queued",
  );
  await configureProject(
    page,
    current.origin,
    alpha.projectId,
    undefined,
    false,
  );
  required(
    current.service.domain().project(alpha.projectId).paused === 0,
    "alpha-resumed",
  );
  required(
    !taskIntents(current.service, alpha.taskId).some(
      (intent) => intent.state === "running",
    ),
    "changed-captured-revision-does-not-auto-adopt",
  );
  for (const assignment of current.service.domain().assignments(alpha.taskId))
    required(
      Number(assignment.instructionsRevision) < alphaRevision,
      "old-assignment-keeps-old-instruction-revision",
    );

  const alphaInteractionResponses = await answerQuestionAndDenyApproval(
    page,
    current,
    alpha,
  );
  const staleCount = taskIntents(current.service, alpha.taskId).filter(
    (intent) => intent.state !== "completed",
  ).length;
  await page.goto(`${current.origin}/runtime/task/${alpha.taskId}`);
  const assignments = current.service.domain().assignments(alpha.taskId);
  for (const assignment of assignments) {
    if (
      Number(assignment.instructionsRevision) === alphaRevision &&
      Number(assignment.profileRevision) ===
        Number(current.service.domain().profile(assignment.profileId).version)
    )
      continue;
    await page.goto(`${current.origin}/runtime/assignment/${assignment.id}`);
    const apply = page.locator(
      'form[action="/runtime/control/instruction-apply"]',
    );
    if (await apply.count())
      await submitForm(
        page,
        apply,
        "/runtime/control/instruction-apply",
        "Apply current instructions for the next turn",
      );
  }
  await waitUntil(
    () => taskView(current.service, alpha.taskId).task.state === "done",
    "alpha-explicit-apply-and-lead-completion",
    timeoutMs,
    current.runtime,
  );
  verifyOperatorResponseDelivery(
    current.service,
    alpha.taskId,
    alphaInteractionResponses,
  );
  required(staleCount > 0, "stale-alpha-turn-was-held-before-apply");
  const postRestartStreamEvidence = [alpha, beta].map((project) => ({
    suffix: project.suffix,
    ...streamEvidenceForTask(current.runtime, current.service, project.taskId),
  }));
  required(
    postRestartStreamEvidence.every(
      (item) => item.lifecycleObserved && item.markerMatchedTurns > 0,
    ),
    "post-restart-real-runtime-stream-evidence",
  );
  const alphaViewAfterCompletion = taskView(current.service, alpha.taskId);
  const alphaWorkerResults = alphaViewAfterCompletion.results.filter(
    (result) => result.assignmentId === alpha.workerAssignmentId,
  );
  const alphaWorkerResult = alphaWorkerResults[0];
  const alphaWorkerResultDelivery = alphaWorkerResult
    ? alphaViewAfterCompletion.messages.find(
        (message) =>
          message.eventType === "assignment-result" &&
          message.resultId === alphaWorkerResult.resultId,
      )
    : undefined;
  const alphaCompletion = alphaViewAfterCompletion.completionRequests.find(
    (request) => request.status === "finalized",
  );
  const alphaWorkerDeliveryVerified =
    alphaWorkerResults.length === 1 &&
    !!alphaWorkerResult &&
    alphaWorkerResult.recipientAssignmentId === alpha.leadAssignmentId &&
    alphaWorkerResult.destinationDisposition === "delivered" &&
    alphaWorkerResultDelivery?.recipientAssignmentId ===
      alpha.leadAssignmentId &&
    alphaWorkerResultDelivery.deliveryState === "delivered" &&
    alphaCompletion?.leadAssignmentId === alpha.leadAssignmentId &&
    alphaCompletion.reviewedResultIds.length === 1 &&
    alphaCompletion.reviewedResultIds[0] === alphaWorkerResult.resultId;
  const alphaAssignments = current.service.domain().assignments(alpha.taskId);
  const alphaHistory = alphaAssignments.map((assignment) =>
    verifyCapturedHistory(
      current.service,
      alpha.taskId,
      String(assignment.id),
      current.privateValues,
    ),
  );
  const betaAssignments = current.service.domain().assignments(beta.taskId);
  const betaHistory = betaAssignments.map((assignment) =>
    verifyCapturedHistory(
      current.service,
      beta.taskId,
      String(assignment.id),
      current.privateValues,
    ),
  );
  const alphaBodies = [];
  for (const assignment of alphaAssignments) {
    await page.goto(
      `${current.origin}/coordination/assignment/${assignment.id}`,
    );
    alphaBodies.push(await page.locator("body").innerText());
  }
  const betaBodies = [];
  for (const assignment of betaAssignments) {
    await page.goto(
      `${current.origin}/coordination/assignment/${assignment.id}`,
    );
    betaBodies.push(await page.locator("body").innerText());
  }
  const alphaNoPrivateValues = alphaBodies.every((body) =>
    current.privateValues.every((value) => !value || !body.includes(value)),
  );
  const betaNoPrivateValues = betaBodies.every((body) =>
    current.privateValues.every((value) => !value || !body.includes(value)),
  );
  const alphaNoBetaMarker = alphaBodies.every(
    (body) => !body.includes("S05_BETA_TASK_MARKER"),
  );
  const betaNoAlphaMarker = betaBodies.every(
    (body) => !body.includes("S05_ALPHA_TASK_MARKER"),
  );
  evidence.repoFree.pauseAndRevision = {
    betaInteractionResponses,
    alphaInteractionResponses,
    alphaWorkerResultDelivery: {
      requesterAssignmentId: alpha.requesterAssignmentId,
      workerAssignmentId: alpha.workerAssignmentId,
      leadAssignmentId: alpha.leadAssignmentId,
      workerResultCount: alphaWorkerResults.length,
      workerResultId: alphaWorkerResult?.resultId ?? null,
      workerResultRecipientAssignmentId:
        alphaWorkerResult?.recipientAssignmentId ?? null,
      workerResultDeliveryState:
        alphaWorkerResultDelivery?.deliveryState ?? "missing",
      completionLeadAssignmentId: alphaCompletion?.leadAssignmentId ?? null,
      completionReviewedResultIds: alphaCompletion?.reviewedResultIds ?? [],
      verified: alphaWorkerDeliveryVerified,
    },
    betaLeadCompletion: {
      leadAssignmentId: beta.leadAssignmentId,
      completionLeadAssignmentId: betaCompletion?.leadAssignmentId ?? null,
      reviewedResultCount: betaCompletion?.reviewedResultIds.length ?? 0,
      verified: betaCompletionVerified,
    },
    alphaMessageWasQueued: queuedMessage.deliveryState === "queued",
    turnsHeldBeforeApply: staleCount,
    assignmentsAppliedToExplicitRevision: alphaAssignments.every(
      (assignment) => Number(assignment.instructionsRevision) === alphaRevision,
    ),
    alphaCompletedAfterExplicitApply:
      String(taskView(current.service, alpha.taskId).task.state) === "done",
    betaCompletedWhileAlphaPaused: true,
    alphaHistoryItemCount: alphaHistory.reduce(
      (sum, item) => sum + item.itemCount,
      0,
    ),
    betaHistoryItemCount: betaHistory.reduce(
      (sum, item) => sum + item.itemCount,
      0,
    ),
    historyBindingsExact: [...alphaHistory, ...betaHistory].every(
      (item) => item.exactTaskAssignmentBinding,
    ),
    historyPrivateValuesExcluded: [...alphaHistory, ...betaHistory].every(
      (item) => item.knownPrivateValuesExcluded,
    ),
    authenticatedUiPrivateValuesExcluded:
      alphaNoPrivateValues && betaNoPrivateValues,
    taskHistoryIsolation: alphaNoBetaMarker && betaNoAlphaMarker,
    postRestartStreamEvidence,
  };
  required(
    evidence.repoFree.pauseAndRevision.alphaCompletedAfterExplicitApply &&
      alphaWorkerDeliveryVerified &&
      betaCompletionVerified &&
      evidence.repoFree.pauseAndRevision.assignmentsAppliedToExplicitRevision &&
      evidence.repoFree.pauseAndRevision.historyBindingsExact &&
      evidence.repoFree.pauseAndRevision.historyPrivateValuesExcluded &&
      evidence.repoFree.pauseAndRevision.authenticatedUiPrivateValuesExcluded &&
      evidence.repoFree.pauseAndRevision.taskHistoryIsolation,
    "repo-free-history-and-explicit-apply-evidence",
  );
}

function taskExecutionSnapshot(current, taskId) {
  const requests = current.service
    .turnRequests()
    .filter((request) => request.taskId === taskId);
  const intents = taskIntents(current.service, taskId);
  const callbacks = current.runtime.callbacks.filter(
    (callback) => callback.taskId === taskId,
  );
  return {
    requestCount: requests.length,
    activeRequestCount: requests.filter((request) => request.state === "active")
      .length,
    boundIntentCount: intents.filter((intent) =>
      Boolean(intent.threadId || intent.turnId),
    ).length,
    runningIntentCount: intents.filter(
      (intent) => intent.state === "running" || intent.state === "submitting",
    ).length,
    callbackCount: callbacks.length,
    runtimeTurnCount: current.runtime.stream.size,
  };
}

async function assertNoTaskTurn(
  current,
  taskId,
  assertionId,
  durationMs = 1000,
) {
  const baseline = taskExecutionSnapshot(current, taskId);
  const deadline = Date.now() + durationMs;
  const assertUnchanged = () => {
    const observed = taskExecutionSnapshot(current, taskId);
    required(
      observed.runtimeTurnCount === baseline.runtimeTurnCount &&
        observed.callbackCount === baseline.callbackCount &&
        observed.activeRequestCount === 0 &&
        observed.boundIntentCount === 0 &&
        observed.runningIntentCount === 0,
      assertionId,
    );
    return observed;
  };
  let observed = assertUnchanged();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    observed = assertUnchanged();
  }
  return observed;
}

async function runLocalDependencyJourney(
  current,
  page,
  root,
  privateValues,
  evidence,
  progress,
) {
  const leadInstructions = [
    "You are the accountable project lead for two finite local dependency fixtures.",
    "When the task outcome asks you to complete this fixture, call ensemble_request_completion exactly once with reviewedResultIds as an empty array, then end the turn.",
    "Do not delegate, ask questions, request approval, modify files, or use network.",
    noNetwork,
  ].join(" ");
  const projectInstructions =
    "Use only the registered Ensemble completion tool for the finite local dependency task outcomes. Do not delegate or perform other actions.";
  privateValues.push(leadInstructions, projectInstructions);

  const leadProfileId = await createProfile(
    page,
    current.origin,
    "S05 local dependency lead",
    leadInstructions,
    "accountable local task lead",
  );
  const projectId = await createProject(
    page,
    current.origin,
    "S05 local dependency journey",
    leadProfileId,
  );
  await configureProject(
    page,
    current.origin,
    projectId,
    projectInstructions,
    true,
  );
  const routing = await configureRoutingCandidates(
    page,
    current.origin,
    projectId,
    [],
  );
  await setCapacity(page, current.origin, 1);

  const blockerMarker = "S05_LOCAL_DEPENDENCY_BLOCKER_COMPLETED";
  const dependentMarker = "S05_LOCAL_DEPENDENCY_DEPENDENT_COMPLETED";
  const blockerTaskId = await createTask(
    page,
    current.origin,
    current.service,
    projectId,
    "S05 local dependency blocker",
    "Fixture blocker is not Ready yet.",
    `Before requesting completion, emit a completed assistant message containing the exact marker ${blockerMarker} as text (not only in a prompt or tool argument). Then call ensemble_request_completion with reviewedResultIds as an empty array and end the turn.`,
    [],
    false,
  );
  const dependentTaskId = await createTask(
    page,
    current.origin,
    current.service,
    projectId,
    "S05 local dependency dependent",
    "Fixture dependent is not Ready yet.",
    `Before requesting completion, emit a completed assistant message containing the exact marker ${dependentMarker} as text (not only in a prompt or tool argument). Then call ensemble_request_completion with reviewedResultIds as an empty array and end the turn.`,
    [],
    false,
  );

  const dependentBeforeEdge = current.service.domain().task(dependentTaskId);
  required(
    current.service.domain().project(projectId).paused === 1 &&
      Number(dependentBeforeEdge.ready) === 0 &&
      Number(current.service.domain().task(blockerTaskId).ready) === 0,
    "dependency-fixture-paused-and-both-tasks-unready-before-edge",
  );

  progress("local-dependency-ui-add-and-exact-replay");
  await page.goto(`${current.origin}/runtime/task/${dependentTaskId}`);
  const dependencyForm = page.locator(
    'form[action="/runtime/control/dependency/add"]',
  );
  required((await dependencyForm.count()) === 1, "dependency-add-form-present");
  await dependencyForm
    .locator('select[name="blockerTaskId"]')
    .selectOption(blockerTaskId);
  const capturedFields = await dependencyForm.evaluate((form) =>
    Object.fromEntries(
      Array.from(new FormData(form).entries(), ([name, value]) => [
        name,
        String(value),
      ]),
    ),
  );
  required(
    capturedFields.projectId === projectId &&
      capturedFields.taskId === dependentTaskId &&
      capturedFields.blockerTaskId === blockerTaskId &&
      capturedFields.expectedVersion === String(dependentBeforeEdge.version) &&
      typeof capturedFields.key === "string" &&
      typeof capturedFields.csrfToken === "string",
    "exact-authenticated-dependency-post-captured",
  );
  const dependencyPath = "/runtime/control/dependency/add";
  const firstPostPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === dependencyPath &&
      response.request().method() === "POST",
    { timeout: 10_000 },
  );
  await dependencyForm.getByRole("button", { name: "Add dependency" }).click();
  const firstPost = await firstPostPromise;
  const firstLocation = new URL(
    firstPost.headers().location ?? "",
    current.origin,
  ).pathname;
  const firstVersion = Number(
    current.service.domain().task(dependentTaskId).version,
  );
  const firstEdges = current.service.domain().dependencies(dependentTaskId);
  const receiptAfterFirst = readCommandReceipt(
    root,
    projectId,
    capturedFields.key,
  );
  required(
    firstPost.status() === 303 &&
      firstLocation === `/runtime/task/${dependentTaskId}` &&
      new URL(page.url()).pathname === firstLocation &&
      firstVersion === Number(dependentBeforeEdge.version) + 1 &&
      firstEdges.length === 1 &&
      firstEdges[0] === blockerTaskId &&
      receiptAfterFirst.count === 1,
    "dependency-ui-post-created-one-edge-and-receipt",
  );

  const replayPost = await current.browserContext.request.post(
    `${current.origin}${dependencyPath}`,
    {
      form: capturedFields,
      headers: { origin: current.origin },
      maxRedirects: 0,
    },
  );
  const replayLocation = new URL(
    replayPost.headers().location ?? "",
    current.origin,
  ).pathname;
  const replayVersion = Number(
    current.service.domain().task(dependentTaskId).version,
  );
  const replayEdges = current.service.domain().dependencies(dependentTaskId);
  const receiptAfterReplay = readCommandReceipt(
    root,
    projectId,
    capturedFields.key,
  );
  const receiptPayloadHashStable =
    receiptAfterFirst.payloadHash !== null &&
    receiptAfterFirst.payloadHash === receiptAfterReplay.payloadHash;
  const receiptResultStable =
    receiptAfterFirst.result !== null &&
    receiptAfterFirst.result === receiptAfterReplay.result;
  const dependencyReplayVerified =
    replayPost.status() === 303 &&
    replayLocation === firstLocation &&
    replayVersion === firstVersion &&
    replayEdges.length === 1 &&
    replayEdges[0] === blockerTaskId &&
    receiptAfterReplay.count === receiptAfterFirst.count &&
    receiptPayloadHashStable &&
    receiptResultStable;
  await replayPost.dispose();
  required(dependencyReplayVerified, "dependency-exact-post-replayed-once");

  const journey = {
    projectId,
    leadProfileId,
    blockerTaskId,
    dependentTaskId,
    routingDisabled: routing.routingDisabled,
    credentialReferenceEmpty: routing.credentialReferenceEmpty,
    candidateProfileCount: routing.candidateProfileIds.length,
    dependencyPostReplay: {
      postedThroughUi: true,
      exactCapturedFieldsReplayed: true,
      sameRedirectLocation: true,
      edgeCountAfterPost: firstEdges.length,
      edgeCountAfterReplay: replayEdges.length,
      dependentVersionBeforePost: Number(dependentBeforeEdge.version),
      dependentVersionAfterPost: firstVersion,
      dependentVersionAfterReplay: replayVersion,
      versionIncrementedOnce:
        firstVersion === Number(dependentBeforeEdge.version) + 1 &&
        replayVersion === firstVersion,
      receiptRowsAfterPost: receiptAfterFirst.count,
      receiptRowsAfterReplay: receiptAfterReplay.count,
      receiptPayloadHashStable: receiptPayloadHashStable,
      receiptResultStable: receiptResultStable,
      verified: dependencyReplayVerified,
    },
    capacity: null,
    openBlockerGate: null,
    cancelledBlockerGate: null,
    stoppedDependentAfterBlockerDone: null,
    completedBlocker: null,
    resumedDependent: null,
  };
  evidence.localDependency = journey;

  progress("local-dependency-ready-and-open-blocker-gate");
  await setTaskReady(page, current.origin, dependentTaskId, true);
  await configureProject(page, current.origin, projectId, undefined, false);
  const openBlocker = current.service.domain().task(blockerTaskId);
  const readyDependent = current.service.domain().task(dependentTaskId);
  const openAdmission = current.service.domain().admission(dependentTaskId);
  required(
    openBlocker.state === "open" &&
      Number(openBlocker.ready) === 0 &&
      readyDependent.state === "open" &&
      Number(readyDependent.ready) === 1 &&
      openAdmission.reasons.includes("local-dependency"),
    "open-unready-blocker-holds-ready-dependent",
  );
  await page.goto(`${current.origin}/runtime/task/${dependentTaskId}`);
  const openTaskText = await page.locator("body").innerText();
  required(
    openTaskText.includes("Task state: open; Ready") &&
      openTaskText.includes(
        "Task admission blocked: A local dependency is incomplete",
      ),
    "ready-dependent-visible-with-local-blocker-reason",
  );
  const openBlockerNoTurn = await assertNoTaskTurn(
    current,
    dependentTaskId,
    "open-blocker-starts-no-dependent-turn",
  );
  journey.openBlockerGate = {
    blockerOpen: true,
    blockerUnready: true,
    dependentReady: true,
    localDependencyReason: true,
    observation: openBlockerNoTurn,
  };

  progress("local-dependency-cancelled-blocker-api-witness");
  setTaskStateViaFixtureApi(current.service, blockerTaskId, "cancelled");
  const cancelledBlocker = current.service.domain().task(blockerTaskId);
  const cancelledAdmission = current.service
    .domain()
    .admission(dependentTaskId);
  required(
    cancelledBlocker.state === "cancelled" &&
      Number(cancelledBlocker.ready) === 0 &&
      cancelledAdmission.reasons.includes("local-dependency"),
    "cancelled-blocker-does-not-release-ready-dependent",
  );
  const cancelledBlockerNoTurn = await assertNoTaskTurn(
    current,
    dependentTaskId,
    "cancelled-blocker-starts-no-dependent-turn",
  );
  setTaskStateViaFixtureApi(current.service, blockerTaskId, "open");
  const reopenedBlocker = current.service.domain().task(blockerTaskId);
  const reopenedAdmission = current.service.domain().admission(dependentTaskId);
  required(
    reopenedBlocker.state === "open" &&
      Number(reopenedBlocker.ready) === 0 &&
      reopenedAdmission.reasons.includes("local-dependency"),
    "reopened-unready-blocker-retains-dependent-gate",
  );
  const reopenedBlockerNoTurn = await assertNoTaskTurn(
    current,
    dependentTaskId,
    "reopened-blocker-starts-no-dependent-turn",
  );
  journey.cancelledBlockerGate = {
    stateChangePath:
      "fixture domain API; task configuration UI has no state control",
    cancelledStateObserved: true,
    localDependencyRemained: true,
    reopenedUnready: true,
    noDependentTurnWhileCancelled: cancelledBlockerNoTurn,
    noDependentTurnAfterReopen: reopenedBlockerNoTurn,
  };

  progress("local-dependency-stop-dependent-before-blocker-completion");
  await page.goto(`${current.origin}/runtime/task/${dependentTaskId}`);
  const stopForm = page.locator('form[action="/runtime/control/stop"]');
  required((await stopForm.count()) === 1, "dependent-stop-control-present");
  await submitForm(page, stopForm, "/runtime/control/stop", "Best-effort Stop");
  required(
    current.service.taskHold(dependentTaskId) !== undefined,
    "dependent-stop-hold-set-through-ui",
  );
  await assertNoTaskTurn(
    current,
    dependentTaskId,
    "stopped-dependent-remains-without-turn-before-release",
    500,
  );

  const capacityMeter = startCapacityMeter(current.service, projectId);
  let capacityObservation;
  try {
    current.runtime.markers.push(blockerMarker, dependentMarker);
    await setTaskReady(page, current.origin, blockerTaskId, true);
    await waitUntil(
      () => taskView(current.service, blockerTaskId).task.state === "done",
      "local-blocker-lead-completion",
      timeoutMs,
      current.runtime,
    );

    const blockerView = taskView(current.service, blockerTaskId);
    const blockerAssignments = current.service
      .domain()
      .assignments(blockerTaskId);
    const blockerLead = blockerAssignments[0];
    const blockerCompletionCalls = current.runtime.callbacks.filter(
      (callback) =>
        callback.taskId === blockerTaskId &&
        callback.tool === "ensemble_request_completion",
    );
    const blockerCompletion = blockerView.completionRequests.filter(
      (request) => request.status === "finalized",
    );
    const blockerStream = streamEvidenceForTask(
      current.runtime,
      current.service,
      blockerTaskId,
    );
    const blockerRequestCount = current.service
      .turnRequests()
      .filter((request) => request.taskId === blockerTaskId).length;
    const blockerTurnCount = taskIntents(current.service, blockerTaskId).length;
    const blockerTotalRuntimeTurns = current.runtime.stream.size;
    const blockerVerified =
      blockerAssignments.length === 1 &&
      String(blockerLead?.profileId) === leadProfileId &&
      blockerRequestCount === 1 &&
      blockerTurnCount === 1 &&
      blockerCompletionCalls.length === 1 &&
      blockerCompletionCalls[0]?.success === true &&
      blockerCompletionCalls[0]?.reviewedResultIds?.length === 0 &&
      blockerCompletion.length === 1 &&
      blockerCompletion[0]?.leadAssignmentId === blockerLead?.id &&
      blockerCompletion[0]?.reviewedResultIds.length === 0 &&
      blockerStream.lifecycleObserved &&
      blockerStream.markerMatchedTurns > 0;
    journey.completedBlocker = {
      blockerDone: true,
      leadAssignmentCount: blockerAssignments.length,
      leadAssignmentId: blockerLead?.id ?? null,
      turnRequestCount: blockerRequestCount,
      actualTurnCount: blockerTurnCount,
      completionCallbackCount: blockerCompletionCalls.length,
      finalizedCompletionCount: blockerCompletion.length,
      totalRuntimeTurns: blockerTotalRuntimeTurns,
      stream: blockerStream,
      verified: blockerVerified,
    };
    required(blockerVerified, "actual-blocker-lead-completed-once");

    const releasedAdmission = current.service
      .domain()
      .admission(dependentTaskId);
    const retainedEdge = current.service
      .domain()
      .dependencies(dependentTaskId)
      .includes(blockerTaskId);
    const stopStillHeld =
      current.service.taskHold(dependentTaskId) !== undefined;
    required(
      current.service.domain().task(blockerTaskId).state === "done" &&
        releasedAdmission.eligible &&
        retainedEdge &&
        stopStillHeld,
      "done-blocker-clears-dependency-gate-but-not-stop",
    );
    await page.goto(`${current.origin}/runtime/task/${dependentTaskId}`);
    const releasedTaskText = await page.locator("body").innerText();
    required(
      releasedTaskText.includes("Task admission gates are clear") &&
        releasedTaskText.includes("Stop") &&
        current.service.taskHold(dependentTaskId) !== undefined,
      "released-dependency-remains-held-by-stop-in-operator-view",
    );
    const stoppedNoTurn = await assertNoTaskTurn(
      current,
      dependentTaskId,
      "stopped-dependent-does-not-run-after-blocker-done",
    );
    journey.stoppedDependentAfterBlockerDone = {
      dependencyGateClear: releasedAdmission.eligible,
      dependencyEdgeRetained: retainedEdge,
      stopStillHeld,
      noTurnWhileStopped: stoppedNoTurn,
    };

    progress("local-dependency-resume-dependent-and-complete");
    await page.goto(`${current.origin}/runtime/task/${dependentTaskId}`);
    const resumeForm = page.locator('form[action="/runtime/control/resume"]');
    required(
      (await resumeForm.count()) === 1,
      "dependent-resume-control-present",
    );
    await submitForm(
      page,
      resumeForm,
      "/runtime/control/resume",
      "Resume task",
    );
    required(
      current.service.taskHold(dependentTaskId) === undefined,
      "dependent-stop-cleared-through-ui-resume",
    );
    await waitUntil(
      () => taskView(current.service, dependentTaskId).task.state === "done",
      "local-dependent-lead-completion-after-resume",
      timeoutMs,
      current.runtime,
    );

    const dependentView = taskView(current.service, dependentTaskId);
    const dependentAssignments = current.service
      .domain()
      .assignments(dependentTaskId);
    const dependentLead = dependentAssignments[0];
    const dependentCompletionCalls = current.runtime.callbacks.filter(
      (callback) =>
        callback.taskId === dependentTaskId &&
        callback.tool === "ensemble_request_completion",
    );
    const dependentCompletion = dependentView.completionRequests.filter(
      (request) => request.status === "finalized",
    );
    const dependentStream = streamEvidenceForTask(
      current.runtime,
      current.service,
      dependentTaskId,
    );
    const dependentRequestCount = current.service
      .turnRequests()
      .filter((request) => request.taskId === dependentTaskId).length;
    const dependentTurnCount = taskIntents(
      current.service,
      dependentTaskId,
    ).length;
    const dependentTotalRuntimeTurns = current.runtime.stream.size;
    const dependentVerified =
      dependentAssignments.length === 1 &&
      String(dependentLead?.profileId) === leadProfileId &&
      dependentRequestCount === 1 &&
      dependentTurnCount === 1 &&
      dependentCompletionCalls.length === 1 &&
      dependentCompletionCalls[0]?.success === true &&
      dependentCompletionCalls[0]?.reviewedResultIds?.length === 0 &&
      dependentCompletion.length === 1 &&
      dependentCompletion[0]?.leadAssignmentId === dependentLead?.id &&
      dependentCompletion[0]?.reviewedResultIds.length === 0 &&
      dependentStream.lifecycleObserved &&
      dependentStream.markerMatchedTurns > 0 &&
      dependentTotalRuntimeTurns === 2;
    journey.resumedDependent = {
      stopClearedByUiResume: true,
      leadAssignmentCount: dependentAssignments.length,
      leadAssignmentId: dependentLead?.id ?? null,
      turnRequestCount: dependentRequestCount,
      actualTurnCount: dependentTurnCount,
      completionCallbackCount: dependentCompletionCalls.length,
      finalizedCompletionCount: dependentCompletion.length,
      totalRuntimeTurns: dependentTotalRuntimeTurns,
      stream: dependentStream,
      verified: dependentVerified,
    };
    required(dependentVerified, "actual-dependent-lead-completed-exactly-once");
    capacityObservation = capacityMeter.stop();
    required(
      capacityObservation.configuredGlobalLimit === 1 &&
        capacityObservation.maximumObservedGlobalUsage === 1,
      "real-turns-respected-and-exercised-capacity-one",
    );
    journey.capacity = capacityObservation;
  } finally {
    capacityObservation = capacityMeter.stop();
    journey.capacity = capacityObservation;
  }
}

function recordStartupState(evidence, owner, kind, index) {
  const reference = {
    owner: `${kind}-${index + 1}`,
    stage: owner.startupStage ?? `${kind}-startup`,
  };
  if (owner.startupPending) {
    evidence.cleanup.startupOwnersPending.push({
      ...reference,
      state: "pending",
    });
  }
  if (owner.startupTimedOut) {
    evidence.cleanup.startupTimeouts.push(reference);
  }
}

function attachLateStartupDisposer(owner) {
  if (owner.lateCleanupPromise || !owner.startupPromise) return;
  const dispose = async () => {
    if (owner.startupKind === "service") {
      if (owner.startAttempted && !owner.stopped) {
        await owner.service.stop();
        owner.stopped = true;
      }
      if (owner.processIdentity && !owner.exitVerified) {
        const exit = await verifyExited(owner.processIdentity);
        if (exit.kind === "verified") owner.exitVerified = true;
      }
      return;
    }
    if (owner.startupKind === "operator") {
      try {
        if (owner.startAttempted && !owner.httpStopped && owner.http) {
          await owner.http.stop();
          owner.httpStopped = true;
        }
      } finally {
        if (!owner.authClosed && owner.auth) {
          owner.auth.close();
          owner.authClosed = true;
        }
      }
    }
  };
  owner.lateCleanupPromise = owner.startupPromise
    .then(dispose, dispose)
    .catch(() => {
      owner.lateCleanupFailed = true;
    });
  void owner.lateCleanupPromise.catch(() => {});
}

function isOwnedJourneyFixture(root, mode, evidence) {
  const allowedModes = new Set([
    "repository",
    "repository-free",
    "local-dependency",
  ]);
  if (
    !root ||
    evidence.fixture.created !== true ||
    evidence.fixture.retained === true ||
    !allowedModes.has(mode)
  )
    return false;
  const name = basename(root);
  const prefix = `ensemble-s05-${mode}-`;
  if (
    evidence.fixture.recoveryToken !== name ||
    !name.startsWith(prefix) ||
    !/^[a-z0-9]{6,32}$/i.test(name.slice(prefix.length))
  )
    return false;
  try {
    const canonicalTemp = tmpdir();
    const status = lstatSync(root);
    return (
      dirname(root) === canonicalTemp &&
      realpathSync(root) === root &&
      !status.isSymbolicLink() &&
      status.isDirectory()
    );
  } catch {
    return false;
  }
}

export async function cleanupJourneyResources({
  root,
  mode,
  evidence,
  browserLaunchAttempted,
  browserContext,
  browser,
  operatorOwners,
  serviceOwners,
}) {
  evidence.cleanup.startupOwnersPending ??= [];
  evidence.cleanup.startupTimeouts ??= [];
  const cleanupFailure = (cleanupStage, error) => {
    const failure = sanitizedFailure(cleanupStage, "cleanup-error", error);
    if (evidence.cleanup.errors.length < 6)
      evidence.cleanup.errors.push(failure);
    evidence.failure ??= failure;
    process.exitCode = 1;
  };

  let browserResourcesClosed = !browserLaunchAttempted;
  if (browserContext) {
    try {
      await browserContext.close();
    } catch (error) {
      cleanupFailure("browser-context-close", error);
    }
  }
  if (browser) {
    try {
      await browser.close();
      browserResourcesClosed = true;
    } catch (error) {
      cleanupFailure("browser-close", error);
    }
  }
  evidence.cleanup.browserClosed = browserResourcesClosed;

  for (let index = operatorOwners.length - 1; index >= 0; index -= 1) {
    const owner = operatorOwners[index];
    recordStartupState(evidence, owner, "operator", index);
    if (owner.startupPending) {
      cleanupFailure(
        "operator-startup-pending-cleanup",
        new Error("operator startup remains pending"),
      );
      attachLateStartupDisposer(owner);
      continue;
    }
    if (owner.startupTimedOut)
      cleanupFailure(
        "operator-startup-timeout-cleanup",
        new Error("operator startup timed out"),
      );
    if (owner.startAttempted && !owner.httpStopped) {
      try {
        await owner.http.stop();
        owner.httpStopped = true;
      } catch (error) {
        cleanupFailure("operator-http-stop", error);
      }
    }
    if (!owner.authClosed && owner.auth) {
      try {
        owner.auth.close();
        owner.authClosed = true;
      } catch (error) {
        cleanupFailure("operator-auth-close", error);
      }
    } else if (!owner.auth) {
      owner.authClosed = true;
    }
  }
  const allOperatorServersStopped = operatorOwners.every(
    (owner) =>
      !owner.startupPending &&
      !owner.startupTimedOut &&
      (!owner.startAttempted || owner.httpStopped),
  );
  const allOperatorAuthClosed = operatorOwners.every(
    (owner) =>
      !owner.startupPending && !owner.startupTimedOut && owner.authClosed,
  );
  evidence.cleanup.allOperatorServersStopped = allOperatorServersStopped;
  evidence.cleanup.allOperatorAuthClosed = allOperatorAuthClosed;

  for (const [index, owner] of serviceOwners.entries()) {
    recordStartupState(evidence, owner, "service", index);
    if (owner.startupPending) {
      cleanupFailure(
        "service-startup-pending-cleanup",
        new Error("service startup remains pending"),
      );
      attachLateStartupDisposer(owner);
      continue;
    }
    if (owner.startupTimedOut)
      cleanupFailure(
        "service-startup-timeout-cleanup",
        new Error("service startup timed out"),
      );
    if (owner.startAttempted && !owner.stopped) {
      try {
        await owner.service.stop();
        owner.stopped = true;
      } catch (error) {
        cleanupFailure("service-stop", error);
      }
    }
    if (!owner.startAttempted || owner.exitVerified) continue;
    if (owner.processIdentity) {
      const exit = await verifyExited(owner.processIdentity);
      if (exit.kind === "verified") {
        owner.exitVerified = true;
        if (
          !evidence.cleanup.appServerProcessesVerifiedExited.some(
            (item) => item.processId === owner.processIdentity.processId,
          )
        )
          evidence.cleanup.appServerProcessesVerifiedExited.push(
            processEvidence(owner.processIdentity),
          );
      } else {
        cleanupFailure("app-server-cleanup-verification", exit);
      }
    } else {
      cleanupFailure(
        "app-server-cleanup-verification",
        new Error("missing exact process identity"),
      );
    }
  }
  const allServicesExited = serviceOwners.every(
    (owner) =>
      !owner.startupPending &&
      !owner.startupTimedOut &&
      (!owner.startAttempted || (owner.stopped && owner.exitVerified)),
  );
  evidence.cleanup.allServicesExited = allServicesExited;

  const allOwnedResourcesClosed =
    allServicesExited &&
    allOperatorServersStopped &&
    allOperatorAuthClosed &&
    browserResourcesClosed;
  if (root && allOwnedResourcesClosed) {
    try {
      required(
        isOwnedJourneyFixture(root, mode, evidence),
        "fixture-cleanup-target-is-exact-owned-fixture",
      );
      rmSync(root, { recursive: true, force: false });
      evidence.fixture.removed = !existsSync(root);
    } catch (error) {
      evidence.fixture.removed = false;
      cleanupFailure("fixture-cleanup", error);
    }
  } else if (root) {
    evidence.fixture.retained = true;
    process.exitCode = 1;
  }
  if (!evidence.fixture.removed && root) evidence.fixture.retained = true;
  if (!evidence.fixture.retained) evidence.fixture.recoveryToken = null;
  if (evidence.failure || !evidence.fixture.removed) process.exitCode = 1;

  return {
    allServicesExited,
    allOperatorServersStopped,
    allOperatorAuthClosed,
    browserClosed: browserResourcesClosed,
    fixtureRemoved: evidence.fixture.removed,
    fixtureRetained: evidence.fixture.retained,
  };
}

export async function runLiveJourney(mode) {
  const evidence = {
    mode,
    source: {},
    fixture: {
      created: false,
      removed: false,
      retained: false,
      recoveryToken: null,
    },
    operator: {
      authenticated: false,
      restartInvalidatedSession: false,
      restartAtIdleSuccessfulTerminal: false,
    },
    runtime: {
      processes: [],
      streamTurnCount: 0,
      streamOwnerCounts: [],
      callbacks: [],
      callbackCount: 0,
      watchedArtifactEvidence: [],
      turnTerminalTimeoutMs: codexTurnTerminalTimeoutMs,
      turnFailures: [],
    },
    cleanup: {
      appServerProcessesVerifiedExited: [],
      errors: [],
      startupTimeoutMs,
      allServicesExited: false,
      allOperatorServersStopped: false,
      allOperatorAuthClosed: false,
      browserClosed: false,
      startupOwnersPending: [],
      startupTimeouts: [],
    },
    repository: null,
    repoFree: null,
    localDependency: null,
    limitations: {
      provider: "TypeSafe routing client is disabled and never invoked",
      hostSleep: "not scheduled or performed",
      executionBoundary:
        "Codex uses the operator's existing runtime login; this does not prove an independent sandbox",
      externalRepository:
        "all Git operations are local to this disposable fixture",
      providerThreads: "provider-side thread deletion is not requested",
    },
    failure: null,
  };
  let stage = "source-identity";
  let root;
  let browser;
  let browserContext;
  let page;
  let current;
  let browserLaunchAttempted = false;
  const serviceOwners = [];
  const operatorOwners = [];
  const privateValues = [];
  evidence.runtime.callbacks = [];

  const progress = (next) => {
    stage = next;
    process.stderr.write(`[s05-journey] ${next}\n`);
  };

  try {
    recordSource(evidence, mode);
    progress("disposable-fixture");
    root = realpathSync(mkdtempSync(join(tmpdir(), `ensemble-s05-${mode}-`)));
    evidence.fixture.recoveryToken = fixtureRecoveryToken(root, mode);
    chmodSync(root, 0o700);
    evidence.fixture.created = true;
    progress("standalone-service-start");
    current = await serviceReady(root, privateValues, evidence, (owner) => {
      current = owner;
      serviceOwners.push(owner);
    });
    evidence.runtime.capability = {
      runtime: "CodexRuntime",
      powerWakeSchedulingEnabled: false,
      routingClient: "disabled",
      processIdentityBound: true,
    };

    progress("operator-http-start");
    await startOperator(current, evidence, (owner) => {
      operatorOwners.push(owner);
    });
    progress("browser-launch");
    browserLaunchAttempted = true;
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    browserContext = await browser.newContext();
    progress("authenticated-operator-ui");
    page = await signedInPage(current, browserContext, current.password);
    evidence.operator.authenticated = true;
    current.browserContext = browserContext;
    current.privateValues = privateValues;

    if (mode === "repository") {
      progress("repository-ui-setup-and-live-journey");
      await runRepositoryJourney(current, page, root, privateValues, evidence);
    } else if (mode === "local-dependency") {
      progress("local-dependency-ui-setup-and-live-journey");
      await runLocalDependencyJourney(
        current,
        page,
        root,
        privateValues,
        evidence,
        progress,
      );
    } else {
      progress("repository-free-ui-setup-and-live-journey");
      const repoFree = await runRepositoryFreeJourney(
        current,
        page,
        privateValues,
        evidence,
      );

      progress("idle-boundary-service-app-server-restart");
      const previousIdentity = current.processIdentity;
      const previousOperator = operatorOwners.at(-1);
      required(previousOperator, "operator-owner-registered-before-restart");
      await previousOperator.http.stop();
      previousOperator.httpStopped = true;
      previousOperator.auth.close();
      previousOperator.authClosed = true;
      await current.service.stop();
      current.stopped = true;
      const exit = await verifyExited(previousIdentity);
      required(exit.kind === "verified", "pre-restart-app-server-exited");
      current.exitVerified = true;
      evidence.cleanup.appServerProcessesVerifiedExited.push(
        processEvidence(previousIdentity),
      );

      const next = await serviceReady(
        root,
        privateValues,
        evidence,
        (owner) => {
          current = owner;
          serviceOwners.push(owner);
        },
        current,
      );
      current = next;
      current.browserContext = browserContext;
      current.privateValues = privateValues;
      current.runtime.markers.push(
        "S05_ALPHA_TASK_MARKER",
        "S05_BETA_TASK_MARKER",
      );
      await startOperator(current, evidence, (owner) => {
        operatorOwners.push(owner);
      });
      await page.goto(
        `${current.origin}/coordination/task/${repoFree.projects[0].taskId}`,
      );
      required(
        /Sign in/.test(await page.locator("body").innerText()),
        "restart-invalidates-old-session",
      );
      evidence.operator.restartInvalidatedSession = true;
      page = await signedInPage(current, browserContext, current.password);
      current.restartInvalidatedSessionVerified = true;

      progress("post-restart-operator-question-and-approval");
      await completeRepoFree(current, page, repoFree, evidence);
    }
  } catch (error) {
    evidence.failure ??= sanitizedFailure(
      stage,
      "journey-or-operator-assertion",
      error,
    );
    process.exitCode = 1;
  } finally {
    const runtimeOwners = serviceOwners.map((owner) => owner.runtime);
    const allCallbacks = runtimeOwners.flatMap((runtime) =>
      runtime.callbacks.map(sanitizedRuntimeCallback),
    );
    const allStreams = runtimeOwners.flatMap((runtime) =>
      [...runtime.stream.values()].map((turn) => ({
        threadId: turn.threadId,
        turnId: turn.turnId,
        started: turn.started,
        deltas: turn.deltas,
        deltaBytes: turn.deltaBytes,
        completed: turn.completed,
        omitted: turn.omitted,
        markerMatched: turn.markerMatched,
      })),
    );
    evidence.runtime.streamTurnCount = allStreams.length;
    evidence.runtime.streamOwnerCounts = runtimeOwners.map((runtime, index) => {
      const turns = [...runtime.stream.values()];
      return {
        runtimeOwnerIndex: index,
        turnCount: turns.length,
        started: turns.reduce((sum, turn) => sum + turn.started, 0),
        deltas: turns.reduce((sum, turn) => sum + turn.deltas, 0),
        deltaBytes: turns.reduce((sum, turn) => sum + turn.deltaBytes, 0),
        completed: turns.reduce((sum, turn) => sum + turn.completed, 0),
        omitted: turns.reduce((sum, turn) => sum + turn.omitted, 0),
        markerMatchedTurns: turns.filter((turn) => turn.markerMatched).length,
      };
    });
    evidence.runtime.callbacks = allCallbacks.slice(0, 1000);
    evidence.runtime.callbackCount = allCallbacks.length;
    evidence.runtime.watchedArtifactEvidence = runtimeOwners
      .map(sanitizedWatchedArtifactEvidence)
      .filter(Boolean)
      .slice(0, 20);
    evidence.runtime.turnFailures = serviceOwners.flatMap((owner) =>
      owner.runtime.turnFailures.map((failure) => ({ ...failure })),
    );
    await cleanupJourneyResources({
      root,
      mode,
      evidence,
      browserLaunchAttempted,
      browserContext,
      browser,
      operatorOwners,
      serviceOwners,
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
}
