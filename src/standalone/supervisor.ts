import { recoveryReceiptSchema } from "./pre-turn-recovery.js";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Runtime } from "./codex.js";
import type {
  ExecutionState,
  RecoveryExecutionIdentity,
  StopTarget,
} from "./state.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RecoveryReceipt,
  RuntimeProcessIdentity,
  TerminationVerification,
  TerminationVerifier,
} from "./recovery-types.js";
import { MacProcessTerminationVerifier } from "./termination.js";

export interface SupervisorClock {
  monotonicNow(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface StopObservationOutcome {
  workId: string;
  threadId: string | null;
  turnId: string | null;
  interrupt: "acknowledged" | "failed" | "unbound";
  terminal: "observed" | "unknown";
  reason?: string;
}

export interface StopObservation {
  taskId: string;
  observationMs: number;
  outcomes: StopObservationOutcome[];
}

export interface ExecutionSupervisorOptions {
  clock?: SupervisorClock;
  observationMs?: number;
}

const defaultClock: SupervisorClock = {
  monotonicNow: () => performance.now(),
  async sleep(milliseconds, signal) {
    try {
      await delay(milliseconds, undefined, { signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  },
};

const processIdentitySchema = z.object({
  processId: z.string().min(1).max(128),
  processStartedAt: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
});

const executionIdentitySchema = z.object({
  workId: z.string().min(1),
  workRevision: z.number().int().positive().nullable(),
  requestSequence: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  processIdentity: processIdentitySchema.nullable(),
});

const executionInspectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact-live"),
    identity: executionIdentitySchema,
  }),
  z.object({
    kind: z.literal("exact-terminal"),
    identity: executionIdentitySchema,
    status: z.enum(["completed", "failed"]),
  }),
  z.object({
    kind: z.enum(["no-proof", "historical-only", "conflicting", "unknown"]),
    reason: z.string().max(2000),
  }),
]);

function exactProcessIdentity(
  left: RuntimeProcessIdentity | null,
  right: RuntimeProcessIdentity | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.processId === right.processId &&
      left.processStartedAt === right.processStartedAt &&
      left.bootId === right.bootId,
  );
}

function exactExecutionIdentity(
  left: ExactExecutionIdentity,
  right: ExactExecutionIdentity,
): boolean {
  return (
    left.workId === right.workId &&
    left.workRevision === right.workRevision &&
    left.requestSequence === right.requestSequence &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    exactProcessIdentity(left.processIdentity, right.processIdentity)
  );
}

function inspectionIdentity(
  identity: RecoveryExecutionIdentity,
): ExactExecutionIdentity | undefined {
  if (!identity.threadId || !identity.turnId || !identity.processIdentity)
    return undefined;
  return {
    workId: identity.workId,
    workRevision: identity.workRevision,
    requestSequence: identity.requestSequence,
    threadId: identity.threadId,
    turnId: identity.turnId,
    processIdentity: identity.processIdentity,
  };
}

/** Owns bounded Stop observation without interpreting acknowledgement as release. */
export class ExecutionSupervisor {
  private readonly clock: SupervisorClock;
  private readonly observationMs: number;
  private readonly events = new EventEmitter();
  private readonly observations = new Set<Promise<StopObservation>>();
  private readonly observationControllers = new Set<AbortController>();
  private readonly interruptRequests = new Set<Promise<void>>();
  private readonly knownRisk = new Set<string>();

  constructor(
    private readonly state: ExecutionState,
    private readonly runtime: Runtime,
    options: ExecutionSupervisorOptions = {},
    private readonly terminationVerifier: TerminationVerifier = new MacProcessTerminationVerifier(),
  ) {
    this.clock = options.clock ?? defaultClock;
    this.observationMs = options.observationMs ?? 3000;
    if (!Number.isSafeInteger(this.observationMs) || this.observationMs <= 0)
      throw new Error("Stop observation window must be a positive integer");
  }

  async reconcileOnStart(): Promise<void> {
    for (const workId of this.state.admittedWorkIds()) {
      const stored = this.state.recoveryIdentity(workId);
      if (!stored) {
        this.recordObservation(workId, "no-proof");
        continue;
      }
      const identity = inspectionIdentity(stored);
      if (!identity) {
        this.recordObservation(stored.workId, "no-proof");
        continue;
      }
      if (!this.runtime.inspectExecution) {
        this.recordObservation(stored.workId, "unknown");
        continue;
      }
      let inspection: ExecutionInspection;
      try {
        inspection = executionInspectionSchema.parse(
          await this.runtime.inspectExecution(identity),
        );
      } catch {
        this.recordObservation(stored.workId, "unknown");
        continue;
      }
      if (
        inspection.kind === "exact-live" ||
        inspection.kind === "exact-terminal"
      ) {
        if (!exactExecutionIdentity(identity, inspection.identity)) {
          this.recordObservation(stored.workId, "conflicting");
          continue;
        }
        this.recordObservation(
          stored.workId,
          inspection.kind === "exact-live"
            ? "exact-live"
            : inspection.status === "completed"
              ? "exact-terminal-completed"
              : "exact-terminal-failed",
          inspection.kind === "exact-terminal" ? inspection.status : undefined,
        );
      } else this.recordObservation(stored.workId, inspection.kind);
    }
  }

  recordObservation(
    workId: string,
    kind: string,
    terminalStatus?: "completed" | "failed",
  ): void {
    this.state.recordRecoveryObservation(workId, kind, terminalStatus);
  }

  async resolveHeldExecution(
    receipt: RecoveryReceipt,
    command?: { key: string; receipt: RecoveryReceipt },
  ) {
    const value = recoveryReceiptSchema.parse(receipt);
    const stored = this.state.recoveryIdentity(value.workId);
    if (
      !stored?.processIdentity ||
      stored.workRevision !== value.workRevision ||
      stored.requestSequence !== value.requestSequence ||
      stored.threadId !== value.threadId ||
      stored.turnId !== value.turnId ||
      !exactProcessIdentity(stored.processIdentity, value.processIdentity)
    )
      throw new Error(
        "Recovery receipt generation or execution identity does not match",
      );

    let verification: TerminationVerification;
    try {
      verification = await this.terminationVerifier.verify(
        stored.processIdentity,
      );
    } catch {
      this.recordObservation(value.workId, "termination-unknown");
      throw new Error("Original process termination could not be verified");
    }
    if (verification.kind !== "verified") {
      this.recordObservation(
        value.workId,
        verification.kind === "conflict"
          ? "termination-conflict"
          : "termination-unknown",
      );
      throw new Error(
        verification.kind === "conflict"
          ? "Process termination evidence conflicts with the stored identity"
          : "Original process termination could not be verified",
      );
    }
    if (
      !exactProcessIdentity(
        stored.processIdentity,
        verification.processIdentity,
      )
    ) {
      this.recordObservation(value.workId, "termination-conflict");
      throw new Error(
        "Verified termination proof has a different process identity",
      );
    }
    this.recordObservation(value.workId, "termination-verified");
    return this.state.resolveHeldExecution(value, verification, command);
  }

  observeStop(
    taskId: string,
    targets = this.state.stopTargets(taskId),
  ): Promise<StopObservation> {
    const controller = new AbortController();
    this.observationControllers.add(controller);
    const action = this.observe(taskId, targets, controller.signal).catch(() =>
      this.currentObservation(taskId),
    );
    this.observations.add(action);
    void action
      .finally(() => {
        controller.abort();
        this.observations.delete(action);
        this.observationControllers.delete(controller);
      })
      .catch(() => {});
    return action;
  }

  /** A late turn/start response is bound durably before this is called. */
  turnBound(workId: string, threadId: string, turnId: string): void {
    this.state.bindStopIdentity(workId, threadId, turnId);
    const target = this.state.stopTarget(workId);
    if (target?.interruptState === "pending") this.interrupt(target);
  }

  threadBound(workId: string, threadId: string): void {
    this.state.bindStopIdentity(workId, threadId);
  }

  terminalObserved(
    workId: string,
    threadId: string,
    turnId: string,
    status: "completed" | "failed",
  ): void {
    this.state.recordStopTerminal(workId, threadId, turnId, status);
    const target = this.state.stopTarget(workId);
    if (target && target.terminalState !== "unknown")
      this.events.emit("terminal", target.taskId);
  }

  noteSurvivor(workId: string): void {
    this.knownRisk.add(workId);
    this.state.recordStopAnomaly(
      workId,
      "Known unfinished execution remains after terminal status",
    );
  }

  noteAnomaly(workId: string): void {
    this.knownRisk.add(workId);
    this.state.recordStopAnomaly(
      workId,
      "A runtime terminal report conflicted with the bound execution",
    );
  }

  hasKnownRisk(workId: string): boolean {
    return this.knownRisk.has(workId);
  }

  cancelObservations(): void {
    for (const controller of this.observationControllers) controller.abort();
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.observations, ...this.interruptRequests]);
  }

  private async observe(
    taskId: string,
    initialTargets: StopTarget[],
    signal: AbortSignal,
  ): Promise<StopObservation> {
    for (const target of initialTargets)
      if (target.interruptState === "pending") this.interrupt(target);

    if (initialTargets.length > 0)
      await Promise.race([
        this.clock.sleep(this.observationMs, signal).catch(() => {}),
        this.waitForTerminal(taskId, signal),
      ]);
    return this.currentObservation(taskId, initialTargets);
  }

  private async waitForTerminal(
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      this.state
        .stopTargets(taskId)
        .some((target) => target.terminalState !== "unknown")
    )
      return;
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        this.events.off("terminal", terminal);
        signal.removeEventListener("abort", abort);
      };
      const terminal = (observedTaskId: string) => {
        if (observedTaskId === taskId) {
          cleanup();
          resolve();
        }
      };
      const abort = () => {
        cleanup();
        resolve();
      };
      this.events.on("terminal", terminal);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private currentObservation(
    taskId: string,
    targets = this.state.stopTargets(taskId),
  ): StopObservation {
    const outcomes = targets.map((initial): StopObservationOutcome => {
      const current = this.state.stopTarget(initial.workId) ?? initial;
      const interrupt =
        current.interruptState === "pending"
          ? "failed"
          : current.interruptState;
      const terminal =
        current.terminalState === "unknown" ? "unknown" : "observed";
      const reason =
        interrupt === "failed"
          ? (current.reason ?? "Codex interrupt request outcome is uncertain")
          : interrupt === "unbound"
            ? (current.reason ??
              "Turn identity was not bound during Stop observation")
            : terminal === "unknown"
              ? "No terminal status observed during the bounded window"
              : undefined;
      return {
        workId: current.workId,
        threadId: current.threadId,
        turnId: current.turnId,
        interrupt,
        terminal,
        ...(reason ? { reason } : {}),
      };
    });
    return { taskId, observationMs: this.observationMs, outcomes };
  }

  private interrupt(target: StopTarget): void {
    const { threadId, turnId } = target;
    if (!threadId || !turnId) return;
    let claimed = false;
    try {
      claimed = this.state.claimStopInterrupt(target.workId);
    } catch {
      return;
    }
    if (!claimed) return;
    const action = Promise.resolve()
      .then(() => this.runtime.interruptTurn(threadId, turnId))
      .then(() =>
        this.state.recordStopInterrupt(target.workId, "acknowledged", null),
      )
      .catch(() =>
        this.state.recordStopInterrupt(
          target.workId,
          "failed",
          "Codex interrupt request failed",
        ),
      );
    this.interruptRequests.add(action);
    void action
      .finally(() => this.interruptRequests.delete(action))
      .catch(() => {});
  }
}
