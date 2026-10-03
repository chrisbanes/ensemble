export interface RuntimeProcessIdentity {
  processId: string;
  processStartedAt: string;
  bootId: string;
}

export interface ExactExecutionIdentity {
  workId: string;
  workRevision: number | null;
  requestSequence: number;
  threadId: string;
  turnId: string;
  processIdentity: RuntimeProcessIdentity | null;
}

export type ExecutionInspection =
  | { kind: "exact-live"; identity: ExactExecutionIdentity }
  | {
      kind: "exact-terminal";
      identity: ExactExecutionIdentity;
      status: "completed" | "failed";
    }
  | {
      kind: "no-proof" | "historical-only" | "conflicting" | "unknown";
      reason: string;
    };

export interface ProcessExitEvidence {
  kind: "process-exit";
}

export type TerminationVerification =
  | {
      kind: "verified";
      processIdentity: RuntimeProcessIdentity;
      verifiedAt: string;
      method: "mac-pid-absent-same-boot";
    }
  | { kind: "conflict"; reason: string }
  | { kind: "unknown"; reason: string };

export type VerifiedTermination = Extract<
  TerminationVerification,
  { kind: "verified" }
>;

export interface TerminationVerifier {
  verify(identity: RuntimeProcessIdentity): Promise<TerminationVerification>;
}

export type { RecoveryReceipt } from "./pre-turn-recovery.js";

export interface RecoveryRecord {
  workId: string;
  generation: {
    workRevision: number | null;
    requestSequence: number;
  };
  intent: {
    state: string;
    reason: string | null;
    threadId: string | null;
    turnId: string | null;
  };
  request: {
    state: string;
    reason: string | null;
    assignmentId: string | null;
  } | null;
  binding: {
    taskId: string;
    assignmentId: string;
    assignmentVersion: number;
    instructionsRevision: number;
    profileRevision: number;
  } | null;
  processIdentity: RuntimeProcessIdentity | null;
  pendingEffects: Array<{ state: string; reason: string }>;
  observations: Array<{ kind: string; reason: string | null }>;
  holds: {
    task: string | null;
    writer: boolean;
    capacity: boolean;
    uncertainty: boolean;
    stop: boolean;
  };
  receipt: { id: string; workspaceDisposition: string } | null;
  preTurnRejection?: {
    id: string;
    source: "runtime" | "operator-adopted";
    predecessorThreadId: string;
  };
}
