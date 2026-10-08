import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Runtime } from "../../src/standalone/codex.js";
import type {
  RuntimeProcessIdentity,
  TerminationVerification,
} from "../../src/standalone/recovery-types.js";
import type {
  RuntimeSpawnContext,
  StandaloneServiceOptions,
} from "../../src/standalone/service.js";
import type { StopObservation } from "../../src/standalone/supervisor.js";
import type { WorkspaceTurnCaptureRecord } from "../../src/standalone/workspace-comparison.js";
import { createOperatorFixture } from "./operator-web.js";
import {
  privateCheckpointDirectory,
  writeCheckpointAtomically,
} from "./turn-capture-harness.js";

/**
 * #782 reduced actual-runtime journey: one repository-free task, one service
 * lifetime, one runtime process and at most three planned `startTurn` calls.
 * Unlike #780's `OneTurnAttemptGuard`, each start must be armed for an exact
 * planned role and work identity; anything else is refused before the runtime.
 */
export const inspectionJourneyBudgets = Object.freeze({
  startLimit: 3,
  /** Arming a planned start until the runtime start call is entered. */
  admissionMs: 30_000,
  /** T1/T2 start until terminal status. */
  turnMs: 300_000,
  /** Terminal until result callback, handoff and capture settle. */
  settleMs: 30_000,
  /** T3 start until Stop is observed and its terminal settles. */
  stopMs: 60_000,
  /** Authenticated HTTP reads after T3 settles. */
  readsMs: 60_000,
  /** Production Chromium pass at both widths. */
  uiMs: 180_000,
  shutdownMs: 10_000,
  /** From arming T1 to the end of the UI pass. */
  totalMs: 1_200_000,
});

export const inspectionJourneyRequiredArgs = Object.freeze([
  "--live",
  "--three-turns",
]);

export const inspectionJourneyMarkers = Object.freeze({
  marker1A: "ensemble-782-marker-1-A\n",
  marker1B: "ensemble-782-marker-1-B\n",
  marker2: "ensemble-782-marker-2\n",
  marker3: "ensemble-782-marker-3\n",
});

const scope =
  "Use only these local workspace writes and the required result-reporting action. Do not delegate, ask a question, request approval, invoke an external action, use network access or modify any other file.";

export const inspectionJourneyInstructions = Object.freeze({
  T1: `Create marker-1.txt in the workspace root containing exactly ${inspectionJourneyMarkers.marker1A.trimEnd()} followed by one newline. Then call ensemble_report_result with a short summary and review {"changes":{"files":["marker-1.txt"]}}. ${scope}`,
  T2: `Overwrite marker-1.txt in the workspace root so it contains exactly ${inspectionJourneyMarkers.marker1B.trimEnd()} followed by one newline, and create marker-2.txt containing exactly ${inspectionJourneyMarkers.marker2.trimEnd()} followed by one newline. Then call ensemble_report_result with a short summary and review {"changes":{"files":["marker-1.txt","marker-2.txt"]}}. ${scope}`,
  T3: `Create marker-3.txt in the workspace root containing exactly ${inspectionJourneyMarkers.marker3.trimEnd()} followed by one newline. Then run the shell command \`sleep 900\` in the workspace and wait for it to finish. Only after it finishes, call ensemble_report_result with a short summary and review {"changes":{"files":["marker-3.txt"]}}. ${scope}`,
});

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

/** Mirrors #780's preflight: the controller-verified hash must match the approved executable. */
export function verifyInspectionJourneyExecutable(
  executable: string,
  expectedSha256: string | undefined,
) {
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256))
    throw new Error("inspection-journey-executable-hash-missing");
  if (!existsSync(executable) || !statSync(executable).isFile())
    throw new Error("inspection-journey-executable-unavailable");
  const actual = sha256(readFileSync(executable));
  if (actual !== expectedSha256)
    throw new Error("inspection-journey-executable-hash-mismatch");
  return actual;
}

export type JourneyRole = "T1" | "T2" | "T3";
const roles: readonly JourneyRole[] = ["T1", "T2", "T3"];

export interface JourneyStart {
  role: JourneyRole;
  workId: string;
  threadId: string;
  turnId?: string;
  enteredAt: number;
  turnStartedAt?: number;
  terminal?: "completed" | "failed";
  terminalAt?: number;
  resultId?: string | null;
  captureId?: string;
  captureState?: WorkspaceTurnCaptureRecord["captureState"];
  captureOutcome?: WorkspaceTurnCaptureRecord["outcome"];
}

export interface InspectionJourneyCheckpoint {
  version: 1;
  journeyId: string;
  startLimit: 3;
  status:
    | "prepared"
    | "armed"
    | "turn-starting"
    | "turn-running"
    | "terminal-observed"
    | "stop-requested"
    | "deviation"
    | "uncertain"
    | "assertion-failed"
    | "service-stop-returned"
    | "shutdown-verified";
  taskId?: string;
  workspacePath?: string;
  armed?:
    | {
        role: JourneyRole;
        workId: string;
        armedAt: number;
        deadlineAt: number;
      }
    | undefined;
  starts: JourneyStart[];
  startTurnCalls: number;
  rejectedStarts: Array<{
    at: number;
    workId: string | null;
    armedRole: JourneyRole | null;
    reason: string;
  }>;
  runtimeStarts: number;
  processIdentity?: RuntimeProcessIdentity;
  totalDeadlineAt?: number;
  stopRequestedAt?: number;
  stopObservedAt?: number;
  stopOutcomes?: StopObservation["outcomes"];
  deviations: string[];
  unproved: string[];
  shutdownObservedAt?: number;
  shutdownTaskHold?: string | null;
  shutdownUnsettledWorkIds?: string[];
  shutdownRequestedAt?: number;
  shutdownDeadlineAt?: number;
  runtimeStopReturnedAt?: number;
  serviceStopReturnedAt?: number;
  processExitVerifiedAt?: string;
  processExitMethod?: string;
  contextSafetyProvided: boolean;
  contextSpawnEnvironmentProvided: boolean;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const unsettledStates = new Set([
  "ready",
  "capacity-waiting",
  "held",
  "submitting",
  "running",
]);

export class InspectionJourneyGuard {
  private checkpoint: InspectionJourneyCheckpoint;
  private resolveWorkId: ((threadId: string) => string | undefined) | undefined;
  private readonly startedSignals = new Map(
    roles.map((role) => [role, deferred<JourneyStart>()]),
  );
  private readonly terminalSignals = new Map(
    roles.map((role) => [role, deferred<"completed" | "failed">()]),
  );

  constructor(
    readonly checkpointPath: string,
    journeyId: string = randomUUID(),
  ) {
    if (!isAbsolute(checkpointPath))
      throw new Error("inspection-journey-checkpoint-path-not-absolute");
    if (!existsSync(dirname(checkpointPath)))
      throw new Error("inspection-journey-checkpoint-directory-missing");
    // A checkpoint is never resumed or reset: a restart is a new, refused attempt.
    if (existsSync(checkpointPath))
      throw new Error("inspection-journey-checkpoint-already-exists");
    privateCheckpointDirectory(checkpointPath);
    const now = Date.now();
    this.checkpoint = {
      version: 1,
      journeyId,
      startLimit: 3,
      status: "prepared",
      starts: [],
      startTurnCalls: 0,
      rejectedStarts: [],
      runtimeStarts: 0,
      deviations: [],
      unproved: [],
      contextSafetyProvided: false,
      contextSpawnEnvironmentProvided: false,
      createdAt: now,
      updatedAt: now,
    };
    writeCheckpointAtomically(checkpointPath, this.checkpoint, true);
  }

  snapshot(): InspectionJourneyCheckpoint {
    return structuredClone(this.checkpoint);
  }

  private update(patch: Partial<InspectionJourneyCheckpoint>) {
    this.checkpoint = { ...this.checkpoint, ...patch, updatedAt: Date.now() };
    writeCheckpointAtomically(this.checkpointPath, this.checkpoint);
    return this.snapshot();
  }

  private patchStart(role: JourneyRole, patch: Partial<JourneyStart>) {
    return this.update({
      starts: this.checkpoint.starts.map((start) =>
        start.role === role ? { ...start, ...patch } : start,
      ),
    });
  }

  start(role: JourneyRole): JourneyStart | undefined {
    return this.snapshot().starts.find((start) => start.role === role);
  }

  started(role: JourneyRole): Promise<JourneyStart> {
    return this.startedSignals.get(role)!.promise;
  }

  terminal(role: JourneyRole): Promise<"completed" | "failed"> {
    return this.terminalSignals.get(role)!.promise;
  }

  /** Exact work identity of the intent whose thread is being submitted. */
  bindWorkResolver(resolve: (threadId: string) => string | undefined) {
    this.resolveWorkId = resolve;
  }

  bindTask(taskId: string, workspacePath: string) {
    if (this.checkpoint.taskId !== undefined)
      throw new Error("inspection-journey-task-already-bound");
    this.update({ taskId, workspacePath });
  }

  assertWithinTotalDeadline(now = Date.now()) {
    const deadline = this.checkpoint.totalDeadlineAt;
    if (deadline !== undefined && now <= deadline) return;
    this.update({
      status: "uncertain",
      failureCode: "total-deadline-exceeded",
    });
    throw new Error("inspection-journey-total-deadline-exceeded");
  }

  recordRuntimeContext(context: RuntimeSpawnContext) {
    if (!context.safety || typeof context.spawnEnvironment !== "function")
      throw new Error(
        "inspection-journey-production-runtime-context-incomplete",
      );
    this.update({
      contextSafetyProvided: true,
      contextSpawnEnvironmentProvided: true,
    });
  }

  /** Records a deviation; every later start is refused and no stage continues. */
  recordDeviation(code: string) {
    return this.update({
      status: "deviation",
      armed: undefined,
      deviations: [...this.checkpoint.deviations, code],
      failureCode: this.checkpoint.failureCode ?? code,
    });
  }

  recordUnproved(row: string) {
    if (this.checkpoint.unproved.includes(row)) return this.snapshot();
    return this.update({ unproved: [...this.checkpoint.unproved, row] });
  }

  recordAssertionFailure(code = "assertion-failed") {
    // After service stop the shutdown status is kept so exit proof stays checkable.
    const stopped = this.checkpoint.serviceStopReturnedAt !== undefined;
    return this.update({
      status: stopped ? this.checkpoint.status : "assertion-failed",
      armed: undefined,
      failureCode: this.checkpoint.failureCode ?? code,
    });
  }

  arm(role: JourneyRole, workId: string, now = Date.now()) {
    const index = roles.indexOf(role);
    const c = this.checkpoint;
    const previous = index > 0 ? c.starts[index - 1] : undefined;
    if (
      c.taskId === undefined ||
      c.armed !== undefined ||
      c.rejectedStarts.length > 0 ||
      c.deviations.length > 0 ||
      ["deviation", "uncertain", "assertion-failed"].includes(c.status) ||
      c.startTurnCalls !== index ||
      c.starts.length !== index ||
      (index > 0 && previous?.terminal === undefined) ||
      c.stopRequestedAt !== undefined ||
      c.shutdownRequestedAt !== undefined
    )
      throw new Error(`inspection-journey-${role}-not-armable`);
    if (index > 0) this.assertWithinTotalDeadline(now);
    return this.update({
      status: "armed",
      armed: {
        role,
        workId,
        armedAt: now,
        deadlineAt: now + inspectionJourneyBudgets.admissionMs,
      },
      ...(index === 0
        ? { totalDeadlineAt: now + inspectionJourneyBudgets.totalMs }
        : {}),
    });
  }

  private refuse(reason: string, workId: string | null, now: number) {
    const armedRole = this.checkpoint.armed?.role ?? null;
    this.update({
      status: "deviation",
      armed: undefined,
      rejectedStarts: [
        ...this.checkpoint.rejectedStarts,
        { at: now, workId, armedRole, reason },
      ],
      deviations: [...this.checkpoint.deviations, `start-refused:${reason}`],
      failureCode: this.checkpoint.failureCode ?? reason,
    });
    const error = new Error(`inspection-journey-start-refused:${reason}`);
    for (const role of roles)
      if (!this.start(role)) this.startedSignals.get(role)!.reject(error);
    return error;
  }

  guardRuntime<T extends Runtime>(runtime: T): T {
    const start = runtime.start.bind(runtime);
    runtime.start = async () => {
      // One runtime process per journey: a restart would hide the identity to verify.
      if (this.checkpoint.runtimeStarts > 0) {
        this.recordDeviation("runtime-restart-refused");
        throw new Error("inspection-journey-runtime-restart-refused");
      }
      this.update({ runtimeStarts: 1 });
      await start();
      const identity = await runtime.processIdentity?.();
      if (identity) this.update({ processIdentity: { ...identity } });
    };
    const stop = runtime.stop.bind(runtime);
    runtime.stop = async () => {
      const identity = await runtime.processIdentity?.();
      if (identity && !this.checkpoint.processIdentity)
        this.update({ processIdentity: { ...identity } });
      await stop();
      this.update({ runtimeStopReturnedAt: Date.now() });
    };
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (threadId, workspace, prompt) => {
      const now = Date.now();
      const c = this.checkpoint;
      const armed = c.armed;
      const workId = this.resolveWorkId?.(threadId) ?? null;
      const reason =
        c.startTurnCalls >= inspectionJourneyBudgets.startLimit
          ? "start-limit-reached"
          : c.rejectedStarts.length > 0 || c.deviations.length > 0
            ? "journey-stopped-after-deviation"
            : !armed
              ? "unplanned-start"
              : workId !== armed.workId
                ? "unexpected-work"
                : workspace !== c.workspacePath
                  ? "unexpected-workspace"
                  : now > armed.deadlineAt
                    ? "admission-deadline-exceeded"
                    : c.totalDeadlineAt === undefined || now > c.totalDeadlineAt
                      ? "total-deadline-exceeded"
                      : undefined;
      if (reason || !armed)
        throw this.refuse(reason ?? "unplanned-start", workId, now);
      const record: JourneyStart = {
        role: armed.role,
        workId: armed.workId,
        threadId,
        enteredAt: now,
      };
      this.update({
        status: "turn-starting",
        armed: undefined,
        startTurnCalls: c.startTurnCalls + 1,
        starts: [...c.starts, record],
      });
      this.startedSignals.get(armed.role)!.resolve(record);
      try {
        const turnId = await startTurn(threadId, workspace, prompt);
        this.patchStart(armed.role, { turnId, turnStartedAt: Date.now() });
        this.update({ status: "turn-running" });
        return turnId;
      } catch {
        this.update({
          status: "uncertain",
          failureCode: `${armed.role}-turn-start-response-uncertain`,
        });
        throw new Error("inspection-journey-runtime-start-response-uncertain");
      }
    };
    const waitForTurn = runtime.waitForTurn.bind(runtime);
    runtime.waitForTurn = async (threadId, turnId) => {
      const role = this.checkpoint.starts.find(
        (start) => start.threadId === threadId && start.turnId === turnId,
      )?.role;
      try {
        const status = await waitForTurn(threadId, turnId);
        if (role) {
          this.patchStart(role, { terminal: status, terminalAt: Date.now() });
          if (this.checkpoint.status === "turn-running")
            this.update({ status: "terminal-observed" });
          this.terminalSignals.get(role)!.resolve(status);
        }
        return status;
      } catch {
        this.update({
          status: "uncertain",
          failureCode: `${role ?? "unknown"}-terminal-wait-uncertain`,
        });
        throw new Error("inspection-journey-runtime-terminal-uncertain");
      }
    };
    return runtime;
  }

  recordResult(role: JourneyRole, resultId: string | null) {
    // T3 is stopped before it can report, so only T1/T2 results are required.
    if (resultId === null && role !== "T3")
      this.recordUnproved(`${role}-result`);
    return this.patchStart(role, { resultId });
  }

  recordCapture(
    role: JourneyRole,
    capture: WorkspaceTurnCaptureRecord | undefined,
  ) {
    if (!capture) {
      this.recordUnproved(`${role}-capture`);
      return this.snapshot();
    }
    return this.patchStart(role, {
      captureId: capture.comparisonId,
      captureState: capture.captureState,
      captureOutcome: capture.outcome,
    });
  }

  recordStopRequest() {
    if (this.checkpoint.stopRequestedAt !== undefined)
      throw new Error("inspection-journey-stop-already-requested");
    return this.update({
      status: "stop-requested",
      stopRequestedAt: Date.now(),
    });
  }

  recordStopObservation(observation: StopObservation) {
    if (
      this.checkpoint.stopRequestedAt === undefined ||
      this.checkpoint.stopObservedAt !== undefined
    )
      throw new Error("inspection-journey-stop-observation-out-of-order");
    return this.update({
      stopObservedAt: Date.now(),
      stopOutcomes: observation.outcomes.map((outcome) => ({ ...outcome })),
    });
  }

  recordShutdownState(observation: {
    taskHold: string | undefined;
    unsettledWorkIds: readonly string[];
  }) {
    if (this.checkpoint.shutdownRequestedAt !== undefined)
      throw new Error("inspection-journey-shutdown-already-requested");
    const now = Date.now();
    return this.update({
      shutdownObservedAt: now,
      shutdownTaskHold: observation.taskHold ?? null,
      shutdownUnsettledWorkIds: [...observation.unsettledWorkIds],
      shutdownRequestedAt: now,
      shutdownDeadlineAt: now + inspectionJourneyBudgets.shutdownMs,
    });
  }

  recordServiceStopReturned() {
    const c = this.checkpoint;
    const now = Date.now();
    if (
      c.shutdownRequestedAt === undefined ||
      c.shutdownDeadlineAt === undefined ||
      now > c.shutdownDeadlineAt
    )
      throw new Error("inspection-journey-shutdown-deadline-exceeded");
    return this.update({
      status: "service-stop-returned",
      serviceStopReturnedAt: now,
    });
  }

  recordShutdownVerified(
    identity: RuntimeProcessIdentity,
    verification: TerminationVerification,
  ) {
    const c = this.checkpoint;
    const original = c.processIdentity;
    const verifiedAt =
      verification.kind === "verified"
        ? Date.parse(verification.verifiedAt)
        : NaN;
    const same = (other: RuntimeProcessIdentity | undefined) =>
      other?.processId === identity.processId &&
      other.processStartedAt === identity.processStartedAt &&
      other.bootId === identity.bootId;
    if (
      !same(original) ||
      verification.kind !== "verified" ||
      !same(verification.processIdentity) ||
      c.status !== "service-stop-returned" ||
      c.serviceStopReturnedAt === undefined ||
      c.shutdownDeadlineAt === undefined ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt < c.serviceStopReturnedAt ||
      verifiedAt > c.shutdownDeadlineAt
    )
      throw new Error("inspection-journey-shutdown-exit-not-verified");
    return this.update({
      status: "shutdown-verified",
      processExitVerifiedAt: verification.verifiedAt,
      processExitMethod: verification.method,
    });
  }
}

export type InspectionJourneyFixture = Awaited<
  ReturnType<typeof createOperatorFixture<Runtime>>
>;

export interface InspectionJourneyHarnessOptions {
  checkpointPath?: string;
  journeyId?: string;
  runtimeFactory: (context: RuntimeSpawnContext) => Runtime;
  serviceOptions?: StandaloneServiceOptions;
}

export interface PlannedWork {
  assignmentId: string;
  workId: string;
}

export interface InspectionJourneyHarness {
  fixture: InspectionJourneyFixture;
  guard: InspectionJourneyGuard;
  checkpointPath: string;
  checkpointDirectory: string;
  taskId: string;
  projectId: string;
  profileId: string;
  workspacePath: string;
  plan: Partial<Record<JourneyRole, PlannedWork>>;
  createPlannedAssignment(role: "T2" | "T3"): PlannedWork;
  unplannedWork(planned?: string): string[];
  admit(role: JourneyRole): Promise<JourneyStart>;
  setPaused(paused: boolean): void;
  settle(
    role: JourneyRole,
    deadline: number,
  ): Promise<{
    resultId: string | null;
    capture: WorkspaceTurnCaptureRecord | undefined;
  }>;
  stopTask(): Promise<StopObservation>;
  stopPreservingFixture(): Promise<void>;
}

async function bounded<T>(promise: Promise<T>, deadline: number, code: string) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${code}-deadline-exceeded`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${code}-deadline-exceeded`)),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createInspectionJourneyHarness(
  options: InspectionJourneyHarnessOptions,
): Promise<InspectionJourneyHarness> {
  const checkpointPath =
    options.checkpointPath ??
    join(
      mkdtempSync(join(tmpdir(), "ensemble-wi782-attempt-")),
      "journey.json",
    );
  const checkpointDirectory = dirname(checkpointPath);
  const guard = new InspectionJourneyGuard(checkpointPath, options.journeyId);
  let fixture: InspectionJourneyFixture | undefined;
  try {
    fixture = await createOperatorFixture(
      null,
      undefined,
      undefined,
      {
        startupTimeoutMs: inspectionJourneyBudgets.admissionMs,
        cleanupTimeoutMs: inspectionJourneyBudgets.shutdownMs,
        preserveDirectoryOnStartupFailure: true,
      },
      (context) => {
        guard.recordRuntimeContext(context);
        return guard.guardRuntime(options.runtimeFactory(context));
      },
      options.serviceOptions,
    );
    const service = fixture.service;
    const domain = service.domain();
    guard.bindWorkResolver(
      (threadId) =>
        service
          .list()
          .find(
            (intent) =>
              intent.threadId === threadId && intent.state === "submitting",
          )?.workId,
    );
    const execute = (command: Record<string, unknown>) =>
      domain.execute({
        key: randomUUID(),
        actor: "operator",
        ...command,
      } as never);
    const profileId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    execute({
      type: "profile.create",
      profileId,
      name: "Inspection journey lead",
      instructions: "Write only the requested markers and report results.",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      projectId,
      name: "Inspection journey qualification",
      leadProfileId: profileId,
    });
    if (Number(domain.project(projectId).paused) !== 1)
      throw new Error("inspection-journey-project-not-created-paused");
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: "Inspect three bounded turns",
      outcome: inspectionJourneyInstructions.T1,
      ready: false,
    });
    const lead = domain.ensureLeadAssignment(taskId);
    if (!lead) throw new Error("inspection-journey-lead-assignment-missing");
    const leadAssignmentId = String(lead.id);
    const binding = await service.provisionTask(taskId);
    if (binding.state !== "ready" || binding.repositories.length !== 0)
      throw new Error(
        "inspection-journey-repository-free-workspace-unavailable",
      );
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      ready: true,
    });
    guard.bindTask(taskId, binding.path);
    const plan: Partial<Record<JourneyRole, PlannedWork>> = {
      T1: {
        assignmentId: leadAssignmentId,
        workId: `assignment:${leadAssignmentId}:initial`,
      },
    };
    const databasePath = join(fixture.directory, "data", "standalone.sqlite");
    const setPaused = (paused: boolean) =>
      execute({
        type: "project.configure",
        projectId,
        expectedVersion: Number(domain.project(projectId).version),
        paused,
      });
    const unplannedWork = (planned?: string) => {
      const database = new DatabaseSync(databasePath, {
        readOnly: true,
        timeout: 1000,
      });
      try {
        const requests = database
          .prepare(`SELECT workId FROM turn_requests
            WHERE taskId = ? AND state IN ('queued','active','held')`)
          .all(taskId) as Array<{ workId: string }>;
        const repairs = database
          .prepare(`SELECT repairWorkId AS workId FROM coordination_reporting_repairs
            WHERE taskId = ? AND state = 'queued'`)
          .all(taskId) as Array<{ workId: string }>;
        const intents = service
          .list()
          .filter((intent) => unsettledStates.has(intent.state))
          .map((intent) => ({ workId: intent.workId }));
        return [
          ...new Set(
            [...requests, ...repairs, ...intents]
              .map((row) => String(row.workId))
              .filter((workId) => workId !== planned),
          ),
        ];
      } finally {
        database.close();
      }
    };
    if (
      guard.snapshot().startTurnCalls !== 0 ||
      unplannedWork(plan.T1?.workId).length > 0
    )
      throw new Error("inspection-journey-setup-dispatched-before-target");

    return {
      fixture,
      guard,
      checkpointPath,
      checkpointDirectory,
      taskId,
      projectId,
      profileId,
      workspacePath: binding.path,
      plan,
      unplannedWork,
      setPaused,
      createPlannedAssignment(role) {
        if (plan[role])
          throw new Error(`inspection-journey-${role}-already-created`);
        if (Number(domain.project(projectId).paused) !== 1)
          throw new Error("inspection-journey-assignment-created-unpaused");
        const assignmentId = randomUUID();
        execute({
          type: "assignment.create",
          projectId,
          taskId,
          assignmentId,
          profileId,
          brief: inspectionJourneyInstructions[role],
          resultDestination: "lead",
          requesterAssignmentId: null,
        });
        plan[role] = {
          assignmentId,
          workId: `assignment:${assignmentId}:initial`,
        };
        return plan[role];
      },
      async admit(role) {
        const planned = plan[role];
        if (!planned) throw new Error(`inspection-journey-${role}-not-planned`);
        if (Number(domain.project(projectId).paused) !== 1)
          throw new Error("inspection-journey-admission-not-controlled");
        // A task hold or any other queued work (for example an automatic reporting
        // repair after a turn without a result) means the next admitted start is
        // not guaranteed to be this planned one. Stop rather than race it.
        if (service.taskHold(taskId) !== undefined) {
          guard.recordDeviation(`task-held-before-${role}`);
          throw new Error(`inspection-journey-task-held-before-${role}`);
        }
        const unexpected = unplannedWork(planned.workId);
        if (unexpected.length > 0) {
          guard.recordDeviation(`unplanned-work-queued-before-${role}`);
          throw new Error(`inspection-journey-unplanned-work-before-${role}`);
        }
        const armed = guard.arm(role, planned.workId).armed!;
        try {
          setPaused(false);
          await service.provisionTask(taskId);
          return await bounded(
            guard.started(role),
            armed.deadlineAt,
            `inspection-journey-${role}-admission`,
          );
        } catch (error) {
          if (!guard.start(role) && guard.snapshot().status === "armed")
            guard.recordDeviation(`${role}-admission-failed`);
          throw error;
        } finally {
          // Re-pause at once so nothing else (repair, delivery) can be admitted.
          setPaused(true);
        }
      },
      async settle(role, deadline) {
        const planned = plan[role];
        if (!planned) throw new Error(`inspection-journey-${role}-not-planned`);
        for (;;) {
          const intent = service
            .list()
            .find((item) => item.workId === planned.workId);
          const slots = service.workspaceTurnCaptureSlots(taskId);
          if (
            intent &&
            !["submitting", "running"].includes(intent.state) &&
            // An interrupted turn's capture stays unsettled by design.
            (slots.pending?.identity.workId !== planned.workId ||
              slots.pending.captureState === "unsettled")
          )
            break;
          if (Date.now() > deadline) {
            guard.recordDeviation(`${role}-settle-deadline-exceeded`);
            throw new Error(
              `inspection-journey-${role}-settle-deadline-exceeded`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const resultId =
          service
            .coordinationView()
            .readTask(taskId)
            .results.find((result) => result.workId === planned.workId)
            ?.resultId ?? null;
        guard.recordResult(role, resultId);
        const slots = service.workspaceTurnCaptureSlots(taskId);
        const capture = [slots.pending, slots.latestFinished].find(
          (record) => record?.identity.workId === planned.workId,
        );
        guard.recordCapture(role, capture);
        return { resultId, capture };
      },
      async stopTask() {
        guard.recordStopRequest();
        const observation = await service.stopTask(taskId);
        guard.recordStopObservation(observation);
        return observation;
      },
      async stopPreservingFixture() {
        guard.recordShutdownState({
          taskHold: service.taskHold(taskId),
          unsettledWorkIds: service
            .list()
            .filter((intent) =>
              ["submitting", "running"].includes(intent.state),
            )
            .map((intent) => intent.workId),
        });
        // The fixture is always retained: a Stop hold persists by design and an
        // uncertain owner is never deleted as cleanup.
        await fixture!.close(undefined, undefined, true);
        guard.recordServiceStopReturned();
      },
    };
  } catch (error) {
    if (fixture) {
      try {
        await fixture.close(undefined, undefined, true);
      } catch {
        // The original setup failure is reported; the fixture directory is retained.
      }
    }
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        journeyGuard: guard,
        journeyCheckpointPath: checkpointPath,
        ...(fixture ? { fixture } : {}),
      },
    );
  }
}
