import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  Runtime,
  RuntimeToolDefinition,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import type { WorkspaceTurnCaptureRecord } from "../../src/standalone/workspace-comparison.js";
import type {
  RuntimeSpawnContext,
  StandaloneServiceOptions,
} from "../../src/standalone/service.js";
import type {
  RuntimeProcessIdentity,
  TerminationVerification,
} from "../../src/standalone/recovery-types.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./operator-web.js";

export const turnCaptureHarnessBudgets = Object.freeze({
  attemptLimit: 1,
  startupMs: 30_000,
  totalMs: 240_000,
  reconciliationIntervalMs: 5_000,
  maxReconciliationReads: 10,
  shutdownMs: 10_000,
});

export type TurnCaptureHarnessCheckpoint = {
  version: 1;
  attemptId: string;
  attemptLimit: 1;
  status:
    | "prepared"
    | "dispatch-armed"
    | "turn-starting"
    | "turn-started"
    | "terminal-observed"
    | "capture-observed"
    | "assertion-failed"
    | "stop-requested"
    | "uncertain"
    | "runtime-stop-returned"
    | "service-stop-returned"
    | "shutdown-verified";
  taskId?: string;
  workId?: string;
  workspacePath?: string;
  startTurnCalls: number;
  rejectedStartTurnCalls: number;
  threadId?: string;
  turnId?: string;
  turnStartEnteredAt?: number;
  terminalStatus?: "completed" | "failed";
  terminalObservedAt?: number;
  captureObservedAt?: number;
  captureState?: WorkspaceTurnCaptureRecord["captureState"];
  captureOutcome?: WorkspaceTurnCaptureRecord["outcome"];
  comparisonId?: string;
  reconciliationReads: number;
  lastReconciliationReadAt?: number;
  stopRequestedAt?: number;
  stopObservedAt?: number;
  stopInterrupt?: "acknowledged" | "failed" | "unbound";
  stopTerminal?: "observed" | "unknown";
  dispatchArmedAt?: number;
  startupDeadlineAt?: number;
  totalDeadlineAt?: number;
  shutdownDeadlineAt?: number | undefined;
  shutdownRequestedAt?: number | undefined;
  shutdownCount: number;
  serviceStopReturnedAt?: number | undefined;
  processIdentity?: RuntimeProcessIdentity | undefined;
  processExitVerifiedAt?: string | undefined;
  processExitMethod?: "mac-pid-absent-same-boot" | undefined;
  shutdownObservedAt?: number | undefined;
  shutdownWorkStates?: Array<{ workId: string; state: string }> | undefined;
  shutdownTaskHold?: string | null | undefined;
  shutdownRunningWorkIds?: string[] | undefined;
  runtimeStopReturnedAt?: number | undefined;
  reopenCount: number;
  contextSafetyProvided: boolean;
  contextSpawnEnvironmentProvided: boolean;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
};

function hasSettledShutdownState(checkpoint: TurnCaptureHarnessCheckpoint) {
  const workStates = checkpoint.shutdownWorkStates;
  const targetWork = workStates?.find(
    (work) => work.workId === checkpoint.workId,
  );
  return (
    targetWork?.state === "completed" &&
    workStates !== undefined &&
    workStates.length > 0 &&
    workStates.every((work) => work.state === "completed") &&
    checkpoint.shutdownTaskHold === null &&
    checkpoint.shutdownRunningWorkIds?.length === 0
  );
}

function privateCheckpointDirectory(path: string) {
  const directoryStat = lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (uid !== undefined && directoryStat.uid !== uid) ||
    (directoryStat.mode & 0o077) !== 0
  )
    throw new Error("turn-capture-checkpoint-directory-not-private");
}

function writeCheckpointAtomically(
  path: string,
  checkpoint: TurnCaptureHarnessCheckpoint,
  createOnly = false,
) {
  privateCheckpointDirectory(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(checkpoint, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  if (createOnly) {
    try {
      linkSync(temporary, path);
    } finally {
      unlinkSync(temporary);
    }
  } else {
    renameSync(temporary, path);
  }
  const fileStat = lstatSync(path);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    (fileStat.mode & 0o777) !== 0o600
  )
    throw new Error("turn-capture-checkpoint-not-private");
}

export class OneTurnAttemptGuard {
  private checkpoint: TurnCaptureHarnessCheckpoint;
  private startEnteredResolve!: () => void;
  private terminalResolve!: (status: "completed" | "failed") => void;
  readonly startEntered = new Promise<void>(
    (resolve) => (this.startEnteredResolve = resolve),
  );
  readonly terminal = new Promise<"completed" | "failed">(
    (resolve) => (this.terminalResolve = resolve),
  );

  constructor(
    readonly checkpointPath: string,
    attemptId: string = randomUUID(),
  ) {
    if (!existsSync(dirname(checkpointPath)))
      throw new Error("turn-capture-checkpoint-directory-missing");
    if (existsSync(checkpointPath))
      throw new Error("turn-capture-attempt-checkpoint-already-exists");
    privateCheckpointDirectory(checkpointPath);
    const now = Date.now();
    this.checkpoint = {
      version: 1,
      attemptId,
      attemptLimit: 1,
      status: "prepared",
      startTurnCalls: 0,
      rejectedStartTurnCalls: 0,
      reconciliationReads: 0,
      reopenCount: 0,
      shutdownCount: 0,
      contextSafetyProvided: false,
      contextSpawnEnvironmentProvided: false,
      createdAt: now,
      updatedAt: now,
    };
    this.persist(true);
  }

  snapshot(): TurnCaptureHarnessCheckpoint {
    return structuredClone(this.checkpoint);
  }

  private update(
    patch: Partial<TurnCaptureHarnessCheckpoint>,
  ): TurnCaptureHarnessCheckpoint {
    this.checkpoint = {
      ...this.checkpoint,
      ...patch,
      updatedAt: Date.now(),
    };
    this.persist();
    return this.snapshot();
  }

  private persist(createOnly = false) {
    writeCheckpointAtomically(this.checkpointPath, this.checkpoint, createOnly);
  }

  remainingStartupMs(now = Date.now()): number {
    const deadline = this.checkpoint.startupDeadlineAt;
    return deadline === undefined ? 0 : Math.max(0, deadline - now);
  }

  remainingTotalMs(now = Date.now()): number {
    const deadline = this.checkpoint.totalDeadlineAt;
    return deadline === undefined ? 0 : Math.max(0, deadline - now);
  }

  assertWithinTotalDeadline(now = Date.now()) {
    if (this.remainingTotalMs(now) > 0) return;
    this.update({
      status: "uncertain",
      failureCode: "total-deadline-exceeded",
    });
    throw new Error("turn-capture-total-deadline-exceeded");
  }

  recordRuntimeContext(context: RuntimeSpawnContext) {
    if (!context.safety || typeof context.spawnEnvironment !== "function")
      throw new Error("turn-capture-production-runtime-context-incomplete");
    this.update({
      contextSafetyProvided: true,
      contextSpawnEnvironmentProvided: true,
    });
  }

  recordRuntimeProcessIdentity(
    identity: RuntimeProcessIdentity | null | undefined,
  ) {
    const stopped =
      this.checkpoint.shutdownRequestedAt !== undefined ||
      this.checkpoint.runtimeStopReturnedAt !== undefined ||
      this.checkpoint.serviceStopReturnedAt !== undefined;
    const nextStatus = !stopped
      ? this.checkpoint.status
      : this.checkpoint.terminalStatus !== undefined &&
          this.checkpoint.captureObservedAt !== undefined
        ? "capture-observed"
        : this.checkpoint.startTurnCalls > 0
          ? "uncertain"
          : this.checkpoint.dispatchArmedAt !== undefined
            ? "dispatch-armed"
            : "prepared";
    this.update({
      status: nextStatus,
      processIdentity: identity ? { ...identity } : undefined,
      ...(stopped
        ? {
            shutdownRequestedAt: undefined,
            shutdownDeadlineAt: undefined,
            serviceStopReturnedAt: undefined,
            shutdownObservedAt: undefined,
            shutdownWorkStates: undefined,
            shutdownTaskHold: undefined,
            shutdownRunningWorkIds: undefined,
            runtimeStopReturnedAt: undefined,
          }
        : {}),
      processExitVerifiedAt: undefined,
      processExitMethod: undefined,
    });
  }

  recordObservedRuntimeProcessIdentity(
    identity: RuntimeProcessIdentity | null | undefined,
  ) {
    if (identity) this.update({ processIdentity: { ...identity } });
  }

  arm(taskId: string, workId: string, workspacePath: string) {
    if (
      this.checkpoint.status !== "prepared" ||
      this.checkpoint.startTurnCalls !== 0
    )
      throw new Error("turn-capture-attempt-already-dispatched");
    const now = Date.now();
    this.update({
      status: "dispatch-armed",
      taskId,
      workId,
      workspacePath,
      dispatchArmedAt: now,
      startupDeadlineAt: now + turnCaptureHarnessBudgets.startupMs,
      totalDeadlineAt: now + turnCaptureHarnessBudgets.totalMs,
    });
  }

  guardRuntime<T extends Runtime>(runtime: T): T {
    const start = runtime.start.bind(runtime);
    runtime.start = async () => {
      await start();
      const identity = await runtime.processIdentity?.();
      this.recordRuntimeProcessIdentity(identity);
    };
    const stop = runtime.stop.bind(runtime);
    runtime.stop = async () => {
      if (this.checkpoint.runtimeStopReturnedAt !== undefined)
        throw new Error("turn-capture-runtime-stop-already-returned");
      const identity = await runtime.processIdentity?.();
      if (identity) this.update({ processIdentity: { ...identity } });
      const now = Date.now();
      const alreadyArmed =
        this.checkpoint.shutdownRequestedAt !== undefined &&
        this.checkpoint.serviceStopReturnedAt === undefined;
      this.update({
        shutdownRequestedAt: alreadyArmed
          ? this.checkpoint.shutdownRequestedAt
          : now,
        shutdownDeadlineAt: alreadyArmed
          ? this.checkpoint.shutdownDeadlineAt
          : now + turnCaptureHarnessBudgets.shutdownMs,
        shutdownCount: alreadyArmed
          ? this.checkpoint.shutdownCount
          : this.checkpoint.shutdownCount + 1,
        serviceStopReturnedAt: undefined,
        processExitVerifiedAt: undefined,
        processExitMethod: undefined,
      });
      await stop();
      const stoppedAt = Date.now();
      this.update({
        status: "runtime-stop-returned",
        runtimeStopReturnedAt: stoppedAt,
        ...(this.checkpoint.shutdownDeadlineAt !== undefined &&
        stoppedAt > this.checkpoint.shutdownDeadlineAt
          ? { failureCode: "shutdown-deadline-exceeded" }
          : {}),
      });
    };
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (threadId, workspace, prompt) => {
      const expected = this.checkpoint;
      const now = Date.now();
      if (
        expected.status !== "dispatch-armed" ||
        expected.startTurnCalls !== 0 ||
        workspace !== expected.workspacePath ||
        expected.startupDeadlineAt === undefined ||
        now > expected.startupDeadlineAt
      ) {
        this.update({
          rejectedStartTurnCalls: expected.rejectedStartTurnCalls + 1,
          failureCode:
            expected.startTurnCalls > 0
              ? "attempt-limit-reached"
              : expected.startupDeadlineAt !== undefined &&
                  now > expected.startupDeadlineAt
                ? "startup-deadline-exceeded"
                : expected.status !== "dispatch-armed"
                  ? "unexpected-start-turn-path"
                  : "unexpected-workspace",
        });
        throw new Error("turn-capture-one-attempt-guard-rejected-dispatch");
      }
      this.update({
        status: "turn-starting",
        startTurnCalls: 1,
        threadId,
        turnStartEnteredAt: Date.now(),
      });
      this.startEnteredResolve();
      try {
        const turnId = await startTurn(threadId, workspace, prompt);
        this.update({ status: "turn-started", turnId });
        return turnId;
      } catch {
        this.update({
          status: "uncertain",
          failureCode: "turn-start-response-uncertain",
        });
        throw new Error("turn-capture-runtime-start-response-uncertain");
      }
    };
    const waitForTurn = runtime.waitForTurn.bind(runtime);
    runtime.waitForTurn = async (threadId, turnId) => {
      try {
        const status = await waitForTurn(threadId, turnId);
        const late =
          this.checkpoint.totalDeadlineAt === undefined ||
          Date.now() > this.checkpoint.totalDeadlineAt;
        this.update({
          status: "terminal-observed",
          threadId,
          turnId,
          terminalStatus: status,
          terminalObservedAt: Date.now(),
          ...(late ? { failureCode: "total-deadline-exceeded" } : {}),
        });
        this.terminalResolve(status);
        return status;
      } catch {
        this.update({
          status: "uncertain",
          failureCode: "terminal-wait-uncertain",
        });
        throw new Error("turn-capture-runtime-terminal-uncertain");
      }
    };
    return runtime;
  }

  recordCapture(capture: WorkspaceTurnCaptureRecord | undefined) {
    if (!capture || capture.captureState !== "finished")
      return this.update({
        status: "uncertain",
        captureObservedAt: Date.now(),
        ...(capture
          ? {
              captureState: capture.captureState,
              captureOutcome: capture.outcome,
              comparisonId: capture.comparisonId,
            }
          : { failureCode: "capture-unavailable" }),
        ...(capture
          ? { failureCode: capture.reason ?? "capture-not-finished" }
          : {}),
      });
    return this.update({
      status: "capture-observed",
      captureObservedAt: Date.now(),
      captureState: capture.captureState,
      captureOutcome: capture.outcome,
      comparisonId: capture.comparisonId,
      ...(capture.reason ? { failureCode: capture.reason } : {}),
    });
  }

  recordAssertionFailure() {
    this.update({
      status: "assertion-failed",
      failureCode: "assertion-failed",
    });
  }

  recordStopRequest() {
    if (this.checkpoint.stopRequestedAt !== undefined)
      throw new Error("turn-capture-stop-already-requested");
    return this.update({
      status: "stop-requested",
      stopRequestedAt: Date.now(),
    });
  }

  recordStopObservation(observation: {
    outcomes: readonly {
      interrupt: "acknowledged" | "failed" | "unbound";
      terminal: "observed" | "unknown";
    }[];
  }) {
    if (this.checkpoint.stopRequestedAt === undefined)
      throw new Error("turn-capture-stop-not-recorded");
    if (this.checkpoint.stopObservedAt !== undefined)
      throw new Error("turn-capture-stop-observation-already-recorded");
    const first = observation.outcomes[0];
    return this.update({
      status:
        first?.terminal === "observed" ? "terminal-observed" : "uncertain",
      stopObservedAt: Date.now(),
      ...(first
        ? { stopInterrupt: first.interrupt, stopTerminal: first.terminal }
        : {}),
      ...(first?.terminal === "unknown"
        ? { failureCode: "stop-terminal-unknown" }
        : {}),
    });
  }

  recordReconciliationRead(
    observedAt: number,
    intervalMs = turnCaptureHarnessBudgets.reconciliationIntervalMs,
  ) {
    const previous = this.checkpoint.lastReconciliationReadAt;
    if (
      this.checkpoint.reconciliationReads >=
        turnCaptureHarnessBudgets.maxReconciliationReads ||
      (previous !== undefined && observedAt - previous < intervalMs) ||
      this.checkpoint.totalDeadlineAt === undefined ||
      observedAt > this.checkpoint.totalDeadlineAt
    )
      throw new Error("turn-capture-reconciliation-budget-exhausted");
    return this.update({
      reconciliationReads: this.checkpoint.reconciliationReads + 1,
      lastReconciliationReadAt: observedAt,
    });
  }

  recordReopen() {
    this.update({ reopenCount: this.checkpoint.reopenCount + 1 });
  }

  recordShutdownState(observation: {
    observedAt: number;
    taskHold: string | undefined;
    workStates: readonly { workId: string; state: string }[];
    runningWorkIds: readonly string[];
  }) {
    if (this.checkpoint.shutdownRequestedAt !== undefined)
      throw new Error("turn-capture-shutdown-already-requested");
    if (!Number.isFinite(observation.observedAt))
      throw new Error("turn-capture-shutdown-observation-invalid");
    return this.update({
      shutdownObservedAt: observation.observedAt,
      shutdownWorkStates: observation.workStates.map((work) => ({ ...work })),
      shutdownTaskHold: observation.taskHold ?? null,
      shutdownRunningWorkIds: [...observation.runningWorkIds],
      ...(!observation.workStates.some(
        (work) => work.workId === this.checkpoint.workId,
      )
        ? { failureCode: "shutdown-target-work-missing" }
        : {}),
    });
  }

  armShutdown() {
    if (
      this.checkpoint.shutdownObservedAt === undefined ||
      this.checkpoint.shutdownWorkStates === undefined ||
      this.checkpoint.shutdownRunningWorkIds === undefined ||
      this.checkpoint.shutdownRequestedAt !== undefined
    )
      throw new Error("turn-capture-shutdown-state-not-recorded");
    const now = Date.now();
    return this.update({
      shutdownRequestedAt: now,
      shutdownDeadlineAt: now + turnCaptureHarnessBudgets.shutdownMs,
      shutdownCount: this.checkpoint.shutdownCount + 1,
      runtimeStopReturnedAt: undefined,
      serviceStopReturnedAt: undefined,
      processExitVerifiedAt: undefined,
      processExitMethod: undefined,
    });
  }

  recordServiceStopReturned() {
    const runtimeStopReturnedAt = this.checkpoint.runtimeStopReturnedAt;
    const shutdownDeadlineAt = this.checkpoint.shutdownDeadlineAt;
    if (
      this.checkpoint.shutdownRequestedAt === undefined ||
      this.checkpoint.shutdownObservedAt === undefined ||
      runtimeStopReturnedAt === undefined ||
      shutdownDeadlineAt === undefined ||
      runtimeStopReturnedAt > shutdownDeadlineAt
    )
      throw new Error("turn-capture-runtime-stop-not-settled");
    const serviceStopReturnedAt = Date.now();
    if (serviceStopReturnedAt > shutdownDeadlineAt)
      throw new Error("turn-capture-shutdown-deadline-exceeded");
    return this.update({
      status: "service-stop-returned",
      serviceStopReturnedAt,
    });
  }

  recordShutdownVerified(
    identity: RuntimeProcessIdentity,
    verification: TerminationVerification,
  ) {
    const original = this.checkpoint.processIdentity;
    const runningWorkIds = this.checkpoint.shutdownRunningWorkIds;
    const verifiedAt =
      verification.kind === "verified"
        ? Date.parse(verification.verifiedAt)
        : Number.NaN;
    if (
      !original ||
      original.processId !== identity.processId ||
      original.processStartedAt !== identity.processStartedAt ||
      original.bootId !== identity.bootId ||
      verification.kind !== "verified" ||
      verification.processIdentity.processId !== identity.processId ||
      verification.processIdentity.processStartedAt !==
        identity.processStartedAt ||
      verification.processIdentity.bootId !== identity.bootId ||
      this.checkpoint.status !== "service-stop-returned" ||
      this.checkpoint.shutdownObservedAt === undefined ||
      !hasSettledShutdownState(this.checkpoint) ||
      !runningWorkIds ||
      runningWorkIds.length > 0 ||
      this.checkpoint.shutdownRequestedAt === undefined ||
      this.checkpoint.runtimeStopReturnedAt === undefined ||
      this.checkpoint.serviceStopReturnedAt === undefined ||
      this.checkpoint.shutdownDeadlineAt === undefined ||
      this.checkpoint.shutdownObservedAt >
        this.checkpoint.shutdownRequestedAt ||
      this.checkpoint.shutdownRequestedAt >
        this.checkpoint.runtimeStopReturnedAt ||
      this.checkpoint.runtimeStopReturnedAt >
        this.checkpoint.serviceStopReturnedAt ||
      this.checkpoint.serviceStopReturnedAt >
        this.checkpoint.shutdownDeadlineAt ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt < this.checkpoint.serviceStopReturnedAt ||
      verifiedAt > this.checkpoint.shutdownDeadlineAt
    )
      throw new Error("turn-capture-shutdown-exit-not-verified");
    return this.update({
      status: "shutdown-verified",
      processExitVerifiedAt: verification.verifiedAt,
      processExitMethod: verification.method,
    });
  }
}

export interface RecordingTurnCaptureRuntimeOptions {
  delayThreadStart?: boolean;
  delayTurnStartResponse?: boolean;
  delayTerminal?: boolean;
  terminalStatus?: "completed" | "failed";
  markerName?: string;
  markerText?: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

export class RecordingTurnCaptureRuntime extends OperatorFixtureRuntime {
  readonly context: RuntimeSpawnContext;
  readonly options: RecordingTurnCaptureRuntimeOptions;
  readonly threadStartEntered = deferred<void>();
  readonly turnStartResponseEntered = deferred<void>();
  readonly terminalEntered = deferred<void>();
  private readonly threadStartGate = deferred<void>();
  private readonly turnStartGate = deferred<void>();
  private readonly terminalGate = deferred<"completed" | "failed">();
  private terminalResolved: "completed" | "failed" | undefined;
  private interrupted = 0;
  reportResultResponse: RuntimeToolResult | undefined;

  constructor(
    context: RuntimeSpawnContext,
    options: RecordingTurnCaptureRuntimeOptions = {},
  ) {
    super();
    this.context = context;
    this.options = options;
  }

  override async startThread(
    workspace: string,
    tools?: readonly RuntimeToolDefinition[],
  ) {
    this.threadStartEntered.resolve(undefined);
    if (this.options.delayThreadStart) await this.threadStartGate.promise;
    assert.ok(tools?.some((tool) => tool.name === "ensemble_report_result"));
    return super.startThread(workspace, tools);
  }

  override async startTurn(
    threadId?: string,
    workspace?: string,
    prompt?: string,
  ) {
    this.turnStartResponseEntered.resolve(undefined);
    if (this.options.delayTurnStartResponse) await this.turnStartGate.promise;
    assert.ok(threadId);
    assert.ok(workspace);
    assert.ok(prompt);
    writeFileSync(
      join(workspace, this.options.markerName ?? "turn-marker.txt"),
      this.options.markerText ?? "ensemble-turn-capture-marker-v1\n",
      { flag: "wx", mode: 0o600 },
    );
    return super.startTurn(threadId, workspace, prompt);
  }

  override async waitForTurn(threadId: string, turnId: string) {
    this.terminalEntered.resolve(undefined);
    const status = this.options.delayTerminal
      ? await this.terminalGate.promise
      : (this.options.terminalStatus ?? "completed");
    this.terminalResolved = status;
    if (status === "completed") {
      this.reportResultResponse = await this.callTool({
        threadId,
        turnId,
        callId: `turn-capture-result-${turnId}`,
        tool: "ensemble_report_result",
        arguments: {
          summary: "Wrote the bounded turn-capture marker as requested.",
        },
      });
      assert.equal(this.reportResultResponse.success, true);
    }
    return status;
  }

  override async interruptTurn(threadId: string, turnId: string) {
    assert.ok(threadId);
    assert.ok(turnId);
    this.interrupted++;
  }

  releaseThreadStart() {
    this.threadStartGate.resolve(undefined);
  }

  releaseTurnStartResponse() {
    this.turnStartGate.resolve(undefined);
  }

  releaseTerminal(status: "completed" | "failed") {
    this.terminalResolved = status;
    this.terminalGate.resolve(status);
  }

  stopObservation() {
    return { interrupted: this.interrupted, terminal: this.terminalResolved };
  }
}

export type TurnCaptureHarnessFixture = Awaited<
  ReturnType<typeof createOperatorFixture<Runtime>>
>;

export interface TurnCaptureHarnessOptions {
  checkpointPath?: string;
  attemptId?: string;
  taskTitle?: string;
  taskOutcome?: string;
  /** Fake runtimes have no OS process to verify; native qualification must omit this. */
  allowUnverifiedProcessExitForTests?: boolean;
  runtimeFactory: (context: RuntimeSpawnContext) => Runtime;
  serviceOptions?: StandaloneServiceOptions;
}

export interface TurnCaptureHarness {
  fixture: TurnCaptureHarnessFixture;
  guard: OneTurnAttemptGuard;
  checkpointPath: string;
  checkpointDirectory: string;
  taskId: string;
  projectId: string;
  profileId: string;
  assignmentId: string;
  workId: string;
  workspacePath: string;
  activateTarget(): Promise<void>;
  latestCapture(): WorkspaceTurnCaptureRecord | undefined;
  markCaptureObserved(): WorkspaceTurnCaptureRecord | undefined;
  reopen(): Promise<void>;
  stopPreservingFixture(): Promise<void>;
  finalizeVerifiedFixtureCleanup(): Promise<void>;
  close(): Promise<void>;
}

export async function createTurnCaptureHarness(
  options: TurnCaptureHarnessOptions,
): Promise<TurnCaptureHarness> {
  const checkpointDirectory = options.checkpointPath
    ? dirname(options.checkpointPath)
    : mkdtempSync(join(tmpdir(), "ensemble-wi03-attempt-"));
  if (!existsSync(checkpointDirectory))
    throw new Error("turn-capture-checkpoint-directory-missing");
  const checkpointPath =
    options.checkpointPath ?? join(checkpointDirectory, "attempt.json");
  if (!isAbsolute(checkpointPath))
    throw new Error("turn-capture-checkpoint-path-not-absolute");
  privateCheckpointDirectory(checkpointPath);
  const guard = new OneTurnAttemptGuard(checkpointPath, options.attemptId);
  let fixture: TurnCaptureHarnessFixture | undefined;
  try {
    fixture = await createOperatorFixture(
      null,
      undefined,
      undefined,
      {
        startupTimeoutMs: turnCaptureHarnessBudgets.startupMs,
        cleanupTimeoutMs: turnCaptureHarnessBudgets.shutdownMs,
        preserveDirectoryOnStartupFailure: true,
      },
      (context) => {
        guard.recordRuntimeContext(context);
        return guard.guardRuntime(options.runtimeFactory(context));
      },
      options.serviceOptions,
    );
    const domain = fixture.service.domain();
    const profileId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const execute = (command: Record<string, unknown>) =>
      domain.execute({
        key: randomUUID(),
        actor: "operator",
        ...command,
      } as never);
    execute({
      type: "profile.create",
      profileId,
      name: "Turn capture lead",
      instructions:
        "Write the requested marker and report the completed result.",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      projectId,
      name: "Turn capture qualification",
      leadProfileId: profileId,
    });
    const pausedProject = domain.project(projectId);
    assert.equal(Number(pausedProject.paused), 1);
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: options.taskTitle ?? "Write a turn marker",
      outcome:
        options.taskOutcome ??
        "Create turn-marker.txt containing exactly ensemble-turn-capture-marker-v1 followed by a newline, then call ensemble_report_result with a short completion summary.",
      ready: false,
    });
    const assignment = domain.ensureLeadAssignment(taskId);
    if (!assignment) throw new Error("turn-capture-lead-assignment-missing");
    const assignmentId = String(assignment.id);
    const workId = `assignment:${assignmentId}:initial`;
    const binding = await fixture.service.provisionTask(taskId);
    if (binding.state !== "ready" || binding.repositories.length !== 0)
      throw new Error("turn-capture-repository-free-workspace-unavailable");
    const task = domain.task(taskId);
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: Number(task.version),
      ready: true,
    });
    guard.arm(taskId, workId, binding.path);
    if (
      guard.snapshot().startTurnCalls !== 0 ||
      fixture.service
        .list()
        .some((work) => work.workId === workId && work.state === "running")
    )
      throw new Error("turn-capture-setup-dispatched-before-target");

    const finalizeVerifiedFixtureCleanup = async () => {
      const checkpoint = guard.snapshot();
      const persisted = JSON.parse(
        readFileSync(checkpointPath, "utf8"),
      ) as TurnCaptureHarnessCheckpoint;
      if (
        !isDeepStrictEqual(
          persisted,
          JSON.parse(
            JSON.stringify(checkpoint),
          ) as TurnCaptureHarnessCheckpoint,
        )
      )
        throw new Error("turn-capture-checkpoint-not-durable");
      const identity = checkpoint.processIdentity;
      if (
        checkpoint.status !== "shutdown-verified" ||
        !identity ||
        checkpoint.serviceStopReturnedAt === undefined ||
        !checkpoint.processExitVerifiedAt ||
        !checkpoint.processExitMethod
      )
        throw new Error("turn-capture-shutdown-exit-not-verified");
      if (!hasSettledShutdownState(checkpoint))
        throw new Error("turn-capture-held-or-unfinished-fixture-retained");
      const before = guard.snapshot();
      await fixture!.removeDirectoryAfterServiceStop();
      const after = guard.snapshot();
      if (
        after.status !== "shutdown-verified" ||
        after.shutdownCount !== before.shutdownCount ||
        after.serviceStopReturnedAt !== before.serviceStopReturnedAt ||
        after.processExitVerifiedAt !== before.processExitVerifiedAt ||
        after.processExitMethod !== before.processExitMethod ||
        !isDeepStrictEqual(
          after.shutdownWorkStates,
          before.shutdownWorkStates,
        ) ||
        after.shutdownTaskHold !== before.shutdownTaskHold ||
        !isDeepStrictEqual(
          after.shutdownRunningWorkIds,
          before.shutdownRunningWorkIds,
        ) ||
        after.processIdentity?.processId !== identity.processId ||
        after.processIdentity.processStartedAt !== identity.processStartedAt ||
        after.processIdentity.bootId !== identity.bootId
      )
        throw new Error("turn-capture-shutdown-proof-invalidated");
    };

    return {
      fixture,
      guard,
      checkpointPath,
      checkpointDirectory,
      taskId,
      projectId,
      profileId,
      assignmentId,
      workId,
      workspacePath: binding.path,
      async activateTarget() {
        if (guard.snapshot().status !== "dispatch-armed")
          throw new Error("turn-capture-target-not-armed");
        execute({
          type: "project.configure",
          projectId,
          expectedVersion: Number(domain.project(projectId).version),
          paused: false,
        });
        const current = await fixture!.service.provisionTask(taskId);
        if (current.state !== "ready")
          throw new Error("turn-capture-target-workspace-not-ready");
      },
      latestCapture() {
        const slots = fixture?.service.workspaceTurnCaptureSlots(taskId);
        return slots?.pending ?? slots?.latestFinished;
      },
      markCaptureObserved() {
        const slots = fixture?.service.workspaceTurnCaptureSlots(taskId);
        const capture = slots?.pending ?? slots?.latestFinished;
        guard.recordCapture(capture);
        return capture;
      },
      async reopen() {
        const checkpoint = guard.snapshot();
        if (
          checkpoint.startTurnCalls > 0 &&
          (checkpoint.terminalStatus === undefined ||
            checkpoint.captureObservedAt === undefined)
        )
          throw new Error("turn-capture-reopen-before-settled-observation");
        if (
          fixture?.service
            .list()
            .some((work) => work.workId === workId && work.state === "running")
        )
          throw new Error("turn-capture-reopen-before-terminal");
        await fixture?.reopen();
        guard.recordReopen();
      },
      async stopPreservingFixture() {
        const checkpoint = guard.snapshot();
        if (
          checkpoint.startTurnCalls > 0 &&
          (checkpoint.terminalStatus === undefined ||
            checkpoint.captureObservedAt === undefined)
        )
          throw new Error("turn-capture-unsettled-fixture-retained");
        const work = fixture!.service.list();
        const runningWorkIds = work
          .filter((intent) => intent.state === "running")
          .map((intent) => intent.workId);
        guard.recordShutdownState({
          observedAt: Date.now(),
          taskHold: fixture!.service.taskHold(taskId),
          workStates: work.map((intent) => ({
            workId: intent.workId,
            state: intent.state,
          })),
          runningWorkIds,
        });
        guard.armShutdown();
        await fixture!.close(undefined, undefined, true);
        guard.recordServiceStopReturned();
      },
      async finalizeVerifiedFixtureCleanup() {
        await finalizeVerifiedFixtureCleanup();
      },
      async close() {
        const checkpoint = guard.snapshot();
        if (checkpoint.serviceStopReturnedAt !== undefined) {
          await finalizeVerifiedFixtureCleanup();
          return;
        }
        if (checkpoint.runtimeStopReturnedAt !== undefined)
          throw new Error("turn-capture-service-stop-not-settled");
        if (
          checkpoint.startTurnCalls > 0 &&
          (checkpoint.terminalStatus === undefined ||
            checkpoint.captureObservedAt === undefined)
        )
          throw new Error("turn-capture-unsettled-fixture-retained");
        const work = fixture!.service.list();
        const runningWorkIds = work
          .filter((intent) => intent.state === "running")
          .map((intent) => intent.workId);
        guard.recordShutdownState({
          observedAt: Date.now(),
          taskHold: fixture!.service.taskHold(taskId),
          workStates: work.map((intent) => ({
            workId: intent.workId,
            state: intent.state,
          })),
          runningWorkIds,
        });
        if (!hasSettledShutdownState(guard.snapshot()))
          throw new Error("turn-capture-held-or-unfinished-fixture-retained");
        if (options.allowUnverifiedProcessExitForTests) {
          if (checkpoint.processIdentity)
            throw new Error(
              "turn-capture-test-cleanup-cannot-dispose-native-process",
            );
          guard.armShutdown();
          await fixture!.close();
          guard.recordServiceStopReturned();
          return;
        }
        await finalizeVerifiedFixtureCleanup();
      },
    };
  } catch (error) {
    const attached = error as Error & { fixture?: TurnCaptureHarnessFixture };
    const retainedFixture = fixture ?? attached.fixture;
    let setupCleanupFailure: unknown;
    if (fixture) {
      try {
        const runtimeIdentity = await fixture.runtime.processIdentity?.();
        guard.recordObservedRuntimeProcessIdentity(runtimeIdentity);
      } catch (failure) {
        setupCleanupFailure = failure;
      }
      try {
        await fixture.close(undefined, undefined, true);
      } catch (failure) {
        setupCleanupFailure ??= failure;
      }
    }
    throw Object.assign(error instanceof Error ? error : Error(String(error)), {
      ...(retainedFixture ? { fixture: retainedFixture } : {}),
      turnCaptureGuard: guard,
      turnCaptureCheckpointPath: checkpointPath,
      ...(setupCleanupFailure
        ? { turnCaptureSetupCleanupFailure: setupCleanupFailure }
        : {}),
    });
  }
}

export function markerSha256(text = "ensemble-turn-capture-marker-v1\n") {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
