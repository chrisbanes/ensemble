import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../core/store.js";
import type {
  RecoveryRecord,
  RecoveryReceipt,
  RuntimeProcessIdentity,
  VerifiedTermination,
} from "./recovery-types.js";
import type { ConversationHistoryBinding } from "./conversation-history.js";

const intentSchema = z.object({
  id: z.string().uuid(),
  workId: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  state: z.enum([
    "ready",
    "capacity-waiting",
    "held",
    "submitting",
    "running",
    "completed",
    "reconciled",
    "resolved-failed",
  ]),
  reason: z.string().nullable(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  accountType: z.literal("chatgpt"),
  sandbox: z.literal("workspaceWrite"),
  approval: z.literal("never"),
});
export type ExecutionIntent = z.infer<typeof intentSchema>;

export interface TaskExecutionContext {
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
}

export interface TaskExecutionBinding extends TaskExecutionContext {
  workId: string;
  conversationRevision: number;
}

export interface CoordinationExecutionBinding extends TaskExecutionBinding {
  state: "running" | "completed";
}

export interface NativeTurnPrebinding extends TaskExecutionBinding {
  intentId: string;
  workRevision: number;
  requestSequence: number;
  threadId: string;
  turnId: string;
  runtimeGeneration: string;
  processIdentity: RuntimeProcessIdentity;
}

export interface StopTarget {
  taskId: string;
  workId: string;
  threadId: string | null;
  turnId: string | null;
  interruptState: "pending" | "acknowledged" | "failed" | "unbound";
  terminalState: "unknown" | "completed" | "failed";
  reason: string | null;
}

export interface RecoveryExecutionIdentity {
  workId: string;
  workRevision: number | null;
  requestSequence: number;
  threadId: string | null;
  turnId: string | null;
  processIdentity: RuntimeProcessIdentity | null;
}

export interface TaskTurnRequest {
  workId: string;
  assignmentId: string | null;
  assignmentVersion: number | null;
  sequence: number;
  state: "queued" | "active" | "completed" | "held";
}

export interface PowerEventCursor {
  version: 1;
  value: string;
}

export interface PowerAdmissionState {
  cursor: PowerEventCursor | null;
  held: boolean;
  reason: string | null;
  revision: number;
}

const powerEventCursorSchema = z
  .object({
    version: z.literal(1),
    value: z.string().min(1).max(512),
  })
  .strict();
const refusedRevisionPrefix =
  "Request refused: captured revisions no longer match (";
const safeRefusedAssignmentRevisionReasons = new Set([
  "assignment-revision-changed",
  "assignment-instructions-changed",
  "assignment-profile-changed",
  "assignment-instructions-revision-stale",
  "assignment-profile-revision-stale",
  "project-paused",
]);
const refusedAssignmentRevisionReasons = new Set(
  [...safeRefusedAssignmentRevisionReasons].filter(
    (reason) => reason !== "project-paused",
  ),
);

export interface FailureResolutionEvidence {
  workId: string;
  workRevision: number | null;
  requestSequence: number;
  threadId: string;
  turnId: string;
  terminalStatus: "failed";
  classification: "transient";
  reasonCode: "serverOverloaded" | "rateLimitExceeded";
  source: "codexErrorInfo";
  codexRetries: number;
  callbacksEnded: true;
  noSurvivor: true;
  effects: "settled";
  nextEligibleAt: number;
}

export interface FailedGenerationResolution {
  failedWorkId: string;
  retryWorkId: string;
  retryIndex: number;
  ensembleRetriesUsed: number;
  codexRetriesUsed: number;
  nextEligibleAt: number;
}

const failureResolutionSchema = z
  .object({
    workId: z.string().min(1),
    workRevision: z.number().int().positive().nullable(),
    requestSequence: z.number().int().positive(),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    terminalStatus: z.literal("failed"),
    classification: z.literal("transient"),
    reasonCode: z.enum(["serverOverloaded", "rateLimitExceeded"]),
    source: z.literal("codexErrorInfo"),
    codexRetries: z.number().int().nonnegative().safe(),
    callbacksEnded: z.literal(true),
    noSurvivor: z.literal(true),
    effects: z.literal("settled"),
    nextEligibleAt: z.number().int().nonnegative().safe(),
  })
  .strict();

const processIdentitySchema = z.object({
  processId: z.string().min(1).max(128),
  processStartedAt: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
});

const recoveryReceiptSchema = z
  .object({
    workId: z.string().min(1),
    workRevision: z.number().int().positive().nullable(),
    requestSequence: z.number().int().positive(),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    processIdentity: processIdentitySchema,
    termination: z.object({ kind: z.literal("process-exit") }).strict(),
    effects: z.literal("settled"),
    workspace: z.enum(["preserved", "reconciled"]),
  })
  .strict();

const verifiedTerminationSchema = z
  .object({
    kind: z.literal("verified"),
    processIdentity: processIdentitySchema,
    verifiedAt: z.string().datetime({ offset: true }),
    method: z.literal("mac-pid-absent-same-boot"),
  })
  .strict();

function recoveryReason(kind: string): string {
  switch (kind) {
    case "exact-live":
      return "The exact original execution was confirmed live";
    case "exact-terminal-completed":
      return "The exact original execution reported completion";
    case "exact-terminal-failed":
      return "The exact original execution reported failure";
    case "historical-only":
      return "Only historical execution information was available";
    case "conflicting":
      return "Execution identity evidence conflicted";
    case "no-proof":
      return "No exact execution identity could be proven";
    case "termination-verified":
      return "Original process termination was independently verified";
    case "termination-conflict":
      return "Process termination evidence conflicted with the stored identity";
    case "termination-unknown":
      return "Original process termination could not be verified";
    case "receipt-accepted":
      return "A validated recovery receipt resolved this generation";
    case "retry-enqueued":
      return "A validated transient failure queued one bounded retry generation";
    default:
      return "Execution state requires operator attention";
  }
}

/** No method retries an uncertain submission. Callers must create a new work ID. */
export class ExecutionState {
  private readonly hasTurnRequests: boolean;

  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS assignment_conversations (
      assignmentId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0)
    );
    CREATE TABLE IF NOT EXISTS task_execution_bindings (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      taskId TEXT NOT NULL, assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL, instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL, conversationRevision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_writer_holds (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_stop_targets (
      taskId TEXT NOT NULL,
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      threadId TEXT,
      turnId TEXT,
      interruptState TEXT NOT NULL CHECK(interruptState IN ('pending','acknowledged','failed','unbound')),
      terminalState TEXT NOT NULL CHECK(terminalState IN ('unknown','completed','failed')),
      reason TEXT,
      requestedAt INTEGER NOT NULL,
      PRIMARY KEY(taskId, workId)
    );
    CREATE TABLE IF NOT EXISTS task_writer_ambiguity_holds (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_archival_holds (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_execution_results (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_writer_admissions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      workspace TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_work_revisions (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      assignmentId TEXT NOT NULL,
      conversationRevision INTEGER NOT NULL,
      workRevision INTEGER NOT NULL CHECK(workRevision > 0),
      UNIQUE(assignmentId, conversationRevision, workRevision)
    );
    CREATE TABLE IF NOT EXISTS task_work_revision_ambiguities (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      assignmentId TEXT NOT NULL,
      conversationRevision INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_work_revision_pending (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId)
    );
    CREATE TABLE IF NOT EXISTS execution_request_predecessors (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      previousWorkId TEXT,
      predecessorKnown INTEGER NOT NULL CHECK(predecessorKnown IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS execution_request_refusals (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_capacity_reservations (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      projectId TEXT,
      admittedAt INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS scheduler_capacity_limits (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      globalLimit INTEGER NOT NULL CHECK(globalLimit > 0)
    );
    CREATE TABLE IF NOT EXISTS scheduler_project_capacity_limits (
      projectId TEXT PRIMARY KEY, projectLimit INTEGER NOT NULL CHECK(projectLimit > 0)
    );
    CREATE TABLE IF NOT EXISTS execution_retry_chains (
      chainId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      ensembleRetriesUsed INTEGER NOT NULL CHECK(ensembleRetriesUsed >= 0),
      codexRetriesUsed INTEGER NOT NULL CHECK(codexRetriesUsed >= 0),
      nextEligibleAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS execution_retry_attempts (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      reasonCode TEXT NOT NULL CHECK(reasonCode IN ('serverOverloaded','rateLimitExceeded')),
      failureSource TEXT NOT NULL CHECK(failureSource = 'codexErrorInfo'),
      codexRetries INTEGER NOT NULL CHECK(codexRetries >= 0),
      disposition TEXT NOT NULL CHECK(disposition IN ('retry-queued','budget-exhausted')),
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_retry_generations (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      retryIndex INTEGER NOT NULL CHECK(retryIndex >= 0)
    );
    CREATE TABLE IF NOT EXISTS execution_retry_resolutions (
      failedWorkId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      retryWorkId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      retryIndex INTEGER NOT NULL CHECK(retryIndex > 0),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      reasonCode TEXT NOT NULL CHECK(reasonCode IN ('serverOverloaded','rateLimitExceeded')),
      failureSource TEXT NOT NULL CHECK(failureSource = 'codexErrorInfo'),
      codexRetries INTEGER NOT NULL CHECK(codexRetries >= 0),
      ensembleRetriesUsed INTEGER NOT NULL CHECK(ensembleRetriesUsed >= 0),
      codexRetriesUsed INTEGER NOT NULL CHECK(codexRetriesUsed >= 0),
      nextEligibleAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_recovery_identities (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL CHECK(requestSequence > 0),
      processId TEXT,
      processStartedAt TEXT,
      bootId TEXT,
      threadId TEXT,
      turnId TEXT,
      inspectionKind TEXT,
      terminalStatus TEXT CHECK(terminalStatus IS NULL OR terminalStatus IN ('completed','failed')),
      CHECK((processId IS NULL AND processStartedAt IS NULL AND bootId IS NULL)
        OR (processId IS NOT NULL AND processStartedAt IS NOT NULL AND bootId IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS execution_recovery_observations (
      id TEXT PRIMARY KEY,
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      recordedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_pending_effects (
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      effectKey TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','settled')),
      reason TEXT,
      PRIMARY KEY(workId, effectKey)
    );
    CREATE TABLE IF NOT EXISTS execution_recovery_receipts (
      id TEXT PRIMARY KEY,
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      processId TEXT NOT NULL,
      processStartedAt TEXT NOT NULL,
      bootId TEXT NOT NULL,
      terminationMethod TEXT NOT NULL,
      terminationVerifiedAt TEXT NOT NULL,
      effectsState TEXT NOT NULL CHECK(effectsState = 'settled'),
      workspaceDisposition TEXT NOT NULL CHECK(workspaceDisposition IN ('preserved','reconciled')),
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_power_supervision (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      cursor TEXT,
      wakeHeld INTEGER NOT NULL DEFAULT 0 CHECK(wakeHeld IN (0,1)),
      reason TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS execution_power_reconciliation_pending (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      revision INTEGER NOT NULL CHECK(revision > 0)
    );
    INSERT OR IGNORE INTO execution_power_supervision (singleton) VALUES (1);
    INSERT OR IGNORE INTO scheduler_capacity_limits (singleton, globalLimit)
      VALUES (1, 4)`);
    // Workspace recovery runs before this state is opened. Any remaining hold
    // belonged to an interrupted process; the recovered workspace state now
    // decides whether execution or another cleanup attempt is possible.
    this.db.exec("DELETE FROM task_archival_holds");
    this.db.exec(`INSERT OR IGNORE INTO task_writer_ambiguity_holds (taskId, reason)
      SELECT taskId, reason FROM task_writer_holds
      WHERE reason = 'Legacy work revision order is ambiguous';
    DELETE FROM task_writer_holds
      WHERE reason = 'Legacy work revision order is ambiguous'`);
    this.db.exec(`INSERT OR IGNORE INTO execution_request_predecessors
      (workId, previousWorkId, predecessorKnown)
      SELECT workId, NULL, 0 FROM execution_intents`);
    this.db.exec(`INSERT OR IGNORE INTO task_work_revisions
      (workId, assignmentId, conversationRevision, workRevision)
      SELECT b.workId, b.assignmentId, b.conversationRevision,
        ROW_NUMBER() OVER (
          PARTITION BY b.assignmentId, b.conversationRevision
          ORDER BY a.sequence
        )
      FROM task_writer_admissions a
      JOIN task_execution_bindings b ON b.workId = a.workId;
    INSERT OR IGNORE INTO task_work_revision_pending (workId)
      SELECT b.workId FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE e.state = 'ready' AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions disposition
        WHERE disposition.workId = b.workId
      )`);
    this.db.exec(`INSERT OR IGNORE INTO task_work_revisions
      (workId, assignmentId, conversationRevision, workRevision)
      SELECT b.workId, b.assignmentId, b.conversationRevision, 1
      FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE NOT EXISTS (
        SELECT 1 FROM task_work_revisions existing
        WHERE existing.workId = b.workId
      ) AND NOT EXISTS (
        SELECT 1 FROM task_work_revision_pending pending
        WHERE pending.workId = b.workId
      ) AND e.state IN ('submitting', 'running', 'completed') AND (
        SELECT COUNT(*) FROM task_execution_bindings onlyBinding
        WHERE onlyBinding.assignmentId = b.assignmentId
        AND onlyBinding.conversationRevision = b.conversationRevision
      ) = 1;
    INSERT OR IGNORE INTO task_work_revision_ambiguities
      (workId, assignmentId, conversationRevision, reason)
      SELECT b.workId, b.assignmentId, b.conversationRevision,
        'Legacy work revision order is ambiguous'
      FROM task_execution_bindings b
      WHERE EXISTS (
        SELECT 1 FROM task_execution_bindings missing
        WHERE missing.assignmentId = b.assignmentId
        AND missing.conversationRevision = b.conversationRevision
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions disposition
          WHERE disposition.workId = missing.workId
        ) AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_pending pending
          WHERE pending.workId = missing.workId
        )
      );
    UPDATE execution_intents SET state = 'held',
      reason = 'Legacy work revision order is ambiguous'
      WHERE workId IN (SELECT workId FROM task_work_revision_ambiguities);
    INSERT OR IGNORE INTO task_writer_ambiguity_holds (taskId, reason)
      SELECT DISTINCT b.taskId, 'Legacy work revision order is ambiguous'
      FROM task_execution_bindings b
      JOIN task_work_revision_ambiguities a ON a.workId = b.workId;
    UPDATE execution_intents SET state = 'held',
      reason = 'Legacy predecessor identity is unknown'
      WHERE state = 'ready' AND workId IN (
        SELECT b.workId FROM task_execution_bindings b
        JOIN execution_request_predecessors p ON p.workId = b.workId
        WHERE p.predecessorKnown = 0
      )`);
    this.db.exec(`INSERT OR IGNORE INTO execution_capacity_reservations (workId, projectId)
      SELECT e.workId, (
        SELECT a.projectId FROM task_execution_bindings b
        JOIN domain_assignments a ON a.id = b.assignmentId
        WHERE b.workId = e.workId
      )
      FROM execution_intents e
      JOIN task_writer_admissions admitted ON admitted.workId = e.workId
      WHERE e.state IN ('held','submitting','running')`);
    this.hasTurnRequests =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_requests'",
        )
        .get() !== undefined;
    if (this.hasTurnRequests) {
      this.db.exec(`INSERT OR IGNORE INTO execution_recovery_identities
        (workId, workRevision, requestSequence, processId, processStartedAt,
          bootId, threadId, turnId)
        SELECT e.workId, revision.workRevision, request.sequence, NULL, NULL, NULL,
          e.threadId, e.turnId
        FROM execution_intents e
        JOIN turn_requests request ON request.workId = e.workId
        LEFT JOIN task_work_revisions revision ON revision.workId = e.workId
        WHERE e.state IN ('held','submitting','running')
        AND EXISTS (SELECT 1 FROM task_writer_admissions admission WHERE admission.workId = e.workId);
      `);
      const unresolvedAssignments = this.db
        .prepare(`SELECT binding.workId
          FROM task_execution_bindings binding
          JOIN execution_intents intent ON intent.workId = binding.workId
          WHERE intent.state IN ('held','submitting','running')`)
        .all() as { workId: string }[];
      const recordPendingAssignmentResult = this.db.prepare(
        `INSERT OR IGNORE INTO execution_pending_effects
          (workId, effectKey, state, reason)
        VALUES (?, 'assignment-result', 'pending',
          'Assignment result has not been committed')`,
      );
      for (const { workId } of unresolvedAssignments)
        if (!this.isNeverAdmittedRefusedInboxWork(workId))
          recordPendingAssignmentResult.run(workId);
    }
  }

  stopTask(taskId: string): StopTarget[] {
    const id = z.string().uuid().parse(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO task_writer_holds (taskId, reason) VALUES (?, 'Task stopped')",
        )
        .run(id);
      const active = this.db
        .prepare(`SELECT e.workId, e.threadId, e.turnId FROM execution_intents e
          JOIN task_execution_bindings b ON b.workId = e.workId
          WHERE b.taskId = ? AND (
            e.state IN ('submitting','running') OR (
              e.state = 'held' AND EXISTS (
                SELECT 1 FROM execution_capacity_reservations r
                WHERE r.workId = e.workId
              )
            )
          )`)
        .all(id) as Array<{
        workId: string;
        threadId: string | null;
        turnId: string | null;
      }>;
      const insertTarget =
        this.db.prepare(`INSERT OR IGNORE INTO execution_stop_targets
        (taskId, workId, threadId, turnId, interruptState, terminalState, reason, requestedAt)
        VALUES (?, ?, ?, ?, ?, 'unknown', NULL, ?)`);
      for (const item of active)
        insertTarget.run(
          id,
          item.workId,
          item.threadId,
          item.turnId,
          item.threadId && item.turnId ? "pending" : "unbound",
          Date.now(),
        );
      this.db
        .prepare(`UPDATE execution_intents SET state = 'held', reason = 'Task stopped'
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('submitting','running')`)
        .run(id);
      this.db
        .prepare(`UPDATE execution_intents SET reason = 'Task stopped'
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('ready','capacity-waiting')`)
        .run(id);
      if (this.hasTurnRequests) {
        this.db
          .prepare(`UPDATE turn_requests SET state = 'held', reason = 'Task stopped'
            WHERE workId IN (SELECT workId FROM execution_stop_targets WHERE taskId = ?)
            AND state = 'active'`)
          .run(id);
        this.db
          .prepare(`UPDATE turn_requests SET reason = 'Task stopped'
            WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
            AND state = 'queued'`)
          .run(id);
      }
      this.db.exec("COMMIT");
      return this.stopTargets(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stopTargets(taskId: string): StopTarget[] {
    return this.db
      .prepare(
        "SELECT * FROM execution_stop_targets WHERE taskId = ? ORDER BY requestedAt, workId",
      )
      .all(z.string().uuid().parse(taskId))
      .map((row) => stopTargetSchema.parse(row));
  }

  stopTarget(workId: string): StopTarget | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_stop_targets WHERE workId = ?")
      .get(z.string().min(1).parse(workId));
    return row === undefined ? undefined : stopTargetSchema.parse(row);
  }

  bindStopIdentity(workId: string, threadId: string, turnId?: string): void {
    const target = this.stopTarget(workId);
    if (!target) return;
    if (
      (target.threadId && target.threadId !== threadId) ||
      (turnId && target.turnId && target.turnId !== turnId)
    ) {
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET interruptState = 'failed', reason = 'Conflicting late execution identity' WHERE workId = ?",
        )
        .run(workId);
      return;
    }
    if (turnId)
      this.db
        .prepare(`UPDATE execution_stop_targets SET threadId = ?, turnId = ?,
          interruptState = CASE WHEN interruptState = 'unbound' THEN 'pending' ELSE interruptState END
          WHERE workId = ?`)
        .run(threadId, turnId, workId);
    else
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET threadId = ? WHERE workId = ?",
        )
        .run(threadId, workId);
  }

  claimStopInterrupt(workId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE execution_stop_targets
        SET interruptState = 'failed', reason = 'Codex interrupt request outcome is uncertain'
        WHERE workId = ? AND interruptState = 'pending' AND threadId IS NOT NULL
        AND turnId IS NOT NULL RETURNING workId`)
        .get(workId) !== undefined
    );
  }

  recordStopInterrupt(
    workId: string,
    result: "acknowledged" | "failed",
    reason: string | null,
  ): void {
    this.db
      .prepare(`UPDATE execution_stop_targets SET interruptState = ?, reason = ?
        WHERE workId = ? AND interruptState = 'failed'
        AND reason = 'Codex interrupt request outcome is uncertain'`)
      .run(result, reason, workId);
  }

  recordStopTerminal(
    workId: string,
    threadId: string,
    turnId: string,
    status: "completed" | "failed",
  ): void {
    this.db
      .prepare(`UPDATE execution_stop_targets SET terminalState = ?
        WHERE workId = ? AND threadId = ? AND turnId = ?`)
      .run(status, workId, threadId, turnId);
    const identity = this.recoveryIdentity(workId);
    if (identity?.threadId === threadId && identity.turnId === turnId)
      this.recordRecoveryObservation(
        workId,
        status === "completed"
          ? "exact-terminal-completed"
          : "exact-terminal-failed",
        status,
      );
  }

  recordStopAnomaly(workId: string | undefined, reason: string): void {
    if (workId)
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET reason = ? WHERE workId = ?",
        )
        .run(reason, workId);
    else
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET reason = ? WHERE interruptState != 'acknowledged'",
        )
        .run(reason);
  }

  resumeTask(taskId: string): void {
    const id = z.string().uuid().parse(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM task_writer_holds WHERE taskId = ? AND reason = 'Task stopped'",
        )
        .run(id);
      this.db
        .prepare(`UPDATE execution_intents SET state = 'ready', reason = NULL
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('ready','capacity-waiting') AND reason = 'Task stopped'`)
        .run(id);
      if (this.hasTurnRequests)
        this.db
          .prepare(`UPDATE turn_requests SET reason = NULL WHERE state = 'queued'
            AND workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
            AND reason = 'Task stopped'`)
          .run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  taskHold(taskId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT reason FROM task_writer_ambiguity_holds WHERE taskId = ?
        UNION ALL SELECT reason FROM task_writer_holds WHERE taskId = ?
        UNION ALL SELECT reason FROM task_archival_holds WHERE taskId = ? LIMIT 1`)
      .get(taskId, taskId, taskId) as { reason: string } | undefined;
    return row?.reason;
  }

  beginArchive(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const acquired =
        this.db
          .prepare(`INSERT INTO task_archival_holds (taskId, reason)
          SELECT ?, 'Task archival in progress'
          WHERE NOT EXISTS (
            SELECT 1 FROM task_archival_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_writer_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_execution_bindings b
            JOIN execution_intents e ON e.workId = b.workId
            WHERE b.taskId = ?
            AND e.state IN ('ready','capacity-waiting','held','submitting','running')
            AND NOT EXISTS (
              SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId
            )
          ) RETURNING taskId`)
          .get(id, id, id, id, id) !== undefined;
      this.db.exec("COMMIT");
      return acquired;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isArchiveHeld(taskId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM task_archival_holds WHERE taskId = ?")
        .get(z.string().uuid().parse(taskId)) !== undefined
    );
  }

  confirmArchive(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const confirmed =
        this.db
          .prepare(`SELECT 1 FROM task_archival_holds archival
          WHERE archival.taskId = ?
          AND NOT EXISTS (
            SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_writer_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_execution_bindings b
            JOIN execution_intents e ON e.workId = b.workId
            WHERE b.taskId = ?
            AND e.state IN ('ready','capacity-waiting','held','submitting','running')
            AND NOT EXISTS (
              SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId
            )
          )`)
          .get(id, id, id, id) !== undefined;
      this.db.exec("COMMIT");
      return confirmed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  endArchive(taskId: string): void {
    this.db
      .prepare("DELETE FROM task_archival_holds WHERE taskId = ?")
      .run(z.string().uuid().parse(taskId));
  }

  bindTask(
    workId: string,
    context: TaskExecutionContext,
  ): TaskExecutionBinding {
    const input = z
      .object({
        taskId: z.string().uuid(),
        assignmentId: z.string().uuid(),
        assignmentVersion: z.number().int().positive(),
        instructionsRevision: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
      })
      .parse(context);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assignment_conversations (assignmentId, revision) VALUES (?, 1)",
      )
      .run(input.assignmentId);
    const revision = Number(
      (
        this.db
          .prepare(
            "SELECT revision FROM assignment_conversations WHERE assignmentId = ?",
          )
          .get(input.assignmentId) as { revision: number }
      ).revision,
    );
    this.db
      .prepare(`INSERT OR IGNORE INTO task_execution_bindings
      (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workId,
        input.taskId,
        input.assignmentId,
        input.assignmentVersion,
        input.instructionsRevision,
        input.profileRevision,
        revision,
      );
    const binding = this.taskBinding(workId);
    if (
      binding?.taskId === input.taskId &&
      binding.assignmentId === input.assignmentId &&
      (binding.assignmentVersion !== input.assignmentVersion ||
        binding.instructionsRevision !== input.instructionsRevision ||
        binding.profileRevision !== input.profileRevision)
    )
      this.db
        .prepare(`UPDATE task_execution_bindings
        SET assignmentVersion = ?, instructionsRevision = ?,
          profileRevision = ?
        WHERE workId = ? AND taskId = ? AND assignmentId = ?
        AND EXISTS (
          SELECT 1 FROM execution_intents e
          WHERE e.workId = task_execution_bindings.workId AND e.state = 'ready'
        ) AND NOT EXISTS (
          SELECT 1 FROM task_writer_admissions a
          WHERE a.workId = task_execution_bindings.workId
        ) AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions revision
          WHERE revision.workId = task_execution_bindings.workId
        )`)
        .run(
          input.assignmentVersion,
          input.instructionsRevision,
          input.profileRevision,
          workId,
          input.taskId,
          input.assignmentId,
        );
    const current = this.taskBinding(workId);
    if (
      !current ||
      Object.entries({ ...input, workId, conversationRevision: revision }).some(
        ([key, value]) => current[key as keyof TaskExecutionBinding] !== value,
      )
    )
      throw new Error(
        "Work ID already bound to another task or assignment revision",
      );
    this.db
      .prepare(`INSERT OR IGNORE INTO task_work_revision_pending (workId)
      SELECT b.workId FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.workId = ? AND e.state = 'ready' AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions disposition
        WHERE disposition.workId = b.workId
      )`)
      .run(workId);
    return current;
  }

  taskBinding(workId: string): TaskExecutionBinding | undefined {
    return this.db
      .prepare("SELECT * FROM task_execution_bindings WHERE workId = ?")
      .get(workId) as TaskExecutionBinding | undefined;
  }

  /** Historical diagnostic binding only; it does not authorize commands or recovery. */
  conversationHistoryBinding(
    workId: string,
    threadId: string,
    turnId: string,
  ): ConversationHistoryBinding | undefined {
    const rows = this.db
      .prepare(`SELECT binding.workId, binding.taskId, binding.assignmentId,
        binding.assignmentVersion, binding.instructionsRevision,
        binding.profileRevision, binding.conversationRevision,
        revision.workRevision, intent.threadId, intent.turnId
        FROM task_execution_bindings binding
        JOIN execution_intents intent ON intent.workId = binding.workId
        JOIN task_work_revisions revision ON revision.workId = binding.workId
        WHERE binding.workId = ? AND intent.threadId = ? AND intent.turnId = ?
          AND (SELECT COUNT(*) FROM execution_intents duplicate
            WHERE duplicate.threadId = intent.threadId
              AND duplicate.turnId = intent.turnId) = 1
        LIMIT 2`)
      .all(workId, threadId, turnId) as Array<Record<string, unknown>>;
    if (rows.length !== 1) return undefined;
    return z
      .object({
        workId: z.string().min(1),
        taskId: z.string().min(1),
        assignmentId: z.string().min(1),
        assignmentVersion: z.number().int().positive(),
        instructionsRevision: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
        conversationRevision: z.number().int().positive(),
        workRevision: z.number().int().positive(),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
      })
      .parse(rows[0]);
  }

  private readonly nativePrebindings = new Map<string, NativeTurnPrebinding>();
  runtimeQuestionBinding(
    threadId: string,
    turnId: string,
  ): CoordinationExecutionBinding | undefined {
    const binding = this.coordinationBinding(threadId, turnId);
    return binding?.state === "running" ? binding : undefined;
  }
  nativeTurnPrebinding(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): NativeTurnPrebinding | undefined {
    const matches = this.list().filter(
      (intent) =>
        intent.threadId === threadId &&
        intent.state === "submitting" &&
        intent.turnId === null,
    );
    if (matches.length !== 1) return undefined;
    const intent = matches[0];
    if (!intent) return undefined;
    const binding = this.taskBinding(intent.workId);
    const recovery = this.recoveryIdentity(intent.workId);
    if (
      !binding ||
      !recovery?.processIdentity ||
      recovery.workRevision === null ||
      this.taskHold(binding.taskId) ||
      this.powerAdmissionState().held ||
      this.stopTarget(intent.workId)
    )
      return undefined;
    return {
      ...binding,
      intentId: intent.id,
      workRevision: recovery.workRevision,
      requestSequence: recovery.requestSequence,
      threadId,
      turnId,
      runtimeGeneration,
      processIdentity: recovery.processIdentity,
    };
  }
  prebindNativeTurn(input: NativeTurnPrebinding): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.nativeTurnPrebinding(
        input.threadId,
        input.turnId,
        input.runtimeGeneration,
      );
      if (!current || JSON.stringify(current) !== JSON.stringify(input)) {
        this.db.exec("COMMIT");
        return false;
      }
      const bound = this.bindTurn(input.intentId, input.turnId);
      if (bound && !this.runtimeQuestionBinding(input.threadId, input.turnId))
        throw new Error("Native prebinding revisions changed");
      if (bound)
        this.nativePrebindings.set(input.workId, Object.freeze({ ...input }));
      this.db.exec("COMMIT");
      return bound;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reconcileNativeTurnStartResponse(input: {
    intentId: string;
    workId: string;
    threadId: string;
    turnId: string;
    runtimeGeneration: string | undefined;
  }): "matched" | "absent" | "rejected" {
    const proof = this.nativePrebindings.get(input.workId);
    if (!proof) return "absent";
    this.nativePrebindings.delete(input.workId);
    const intent = this.byWorkId(input.workId);
    const binding = this.runtimeQuestionBinding(input.threadId, input.turnId);
    const recovery = this.recoveryIdentity(input.workId);
    if (
      !intent ||
      intent.id !== input.intentId ||
      intent.state !== "running" ||
      !binding ||
      !recovery ||
      (
        [
          "workId",
          "taskId",
          "assignmentId",
          "assignmentVersion",
          "instructionsRevision",
          "profileRevision",
          "conversationRevision",
        ] as const
      ).some((key) => binding[key] !== proof[key]) ||
      proof.runtimeGeneration !== input.runtimeGeneration ||
      proof.threadId !== input.threadId ||
      proof.turnId !== input.turnId ||
      proof.workRevision !== recovery.workRevision ||
      proof.requestSequence !== recovery.requestSequence ||
      JSON.stringify(proof.processIdentity) !==
        JSON.stringify(recovery.processIdentity) ||
      this.taskHold(binding.taskId) ||
      this.powerAdmissionState().held ||
      this.stopTarget(input.workId)
    )
      return "rejected";
    return "matched";
  }

  coordinationBinding(
    threadId: string,
    turnId: string,
  ): CoordinationExecutionBinding | undefined {
    const rows = this.db
      .prepare(`SELECT binding.workId, binding.taskId,
      binding.assignmentId, binding.assignmentVersion,
      binding.instructionsRevision, binding.profileRevision,
      binding.conversationRevision, intent.state
      FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
      JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
      WHERE intent.threadId = ? AND intent.turnId = ?
        AND intent.state IN ('running','completed')
        AND assignment.version = binding.assignmentVersion
        AND conversation.revision = binding.conversationRevision
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = binding.assignmentId
            AND ambiguous.conversationRevision = binding.conversationRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = revision.assignmentId
            AND newer.conversationRevision = revision.conversationRevision
            AND newer.workRevision > revision.workRevision
        )
      LIMIT 2`)
      .all(threadId, turnId) as Array<
      TaskExecutionBinding & { state: "running" | "completed" }
    >;
    if (rows.length > 1)
      throw new Error("Coordination callback matches ambiguous work");
    return rows[0];
  }

  latestCompletedAssignmentWork(assignmentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT binding.workId
      FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
        AND conversation.revision = binding.conversationRevision
      WHERE binding.assignmentId = ? AND intent.state = 'completed'
        AND intent.threadId IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = binding.assignmentId
            AND ambiguous.conversationRevision = binding.conversationRevision
        )
      ORDER BY revision.workRevision DESC LIMIT 1`)
      .get(z.string().uuid().parse(assignmentId)) as
      | { workId: string }
      | undefined;
    return row?.workId;
  }

  assignmentHasUnfinishedExecution(assignmentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      WHERE binding.assignmentId = ?
        AND intent.state IN ('ready','capacity-waiting','held','submitting','running')
        AND NOT EXISTS (
          SELECT 1 FROM execution_request_refusals refusal
          WHERE refusal.workId = intent.workId
        ) LIMIT 1`)
        .get(z.string().uuid().parse(assignmentId)) !== undefined
    );
  }

  /**
   * A revision refusal is ignorable only when the exact held request and
   * intent still match their immutable refusal, identify a durable inbox
   * event, and have no evidence of runtime admission or effects. Current
   * assignment eligibility is deliberately checked by delivery withdrawal,
   * not here, so this historical proof remains stable after later completion.
   */
  isNeverAdmittedRefusedInboxWork(workId: string): boolean {
    const id = z.string().min(1).max(512).parse(workId);
    if (
      !this.hasTurnRequests ||
      this.db
        .prepare(`SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coordination_inbox_events'`)
        .get() === undefined
    )
      return false;
    const row = this.db
      .prepare(`SELECT request.kind, request.taskId, request.projectId,
        request.assignmentId, request.taskVersion, request.assignmentVersion,
        request.instructionsRevision, request.profileRevision,
        request.state AS requestState, request.reason AS requestReason,
        intent.state AS intentState, intent.reason AS intentReason,
        intent.threadId, intent.turnId,
        binding.taskId AS bindingTaskId,
        binding.assignmentId AS bindingAssignmentId,
        binding.assignmentVersion AS bindingAssignmentVersion,
        binding.instructionsRevision AS bindingInstructionsRevision,
        binding.profileRevision AS bindingProfileRevision,
        refusal.reason AS refusalReason,
        EXISTS (SELECT 1 FROM task_writer_admissions admission
          WHERE admission.workId = intent.workId) AS hasWriterAdmission,
        EXISTS (SELECT 1 FROM execution_capacity_reservations capacity
          WHERE capacity.workId = intent.workId) AS hasCapacityReservation,
        EXISTS (SELECT 1 FROM execution_recovery_identities recovery
          WHERE recovery.workId = intent.workId) AS hasRecoveryIdentity,
        EXISTS (SELECT 1 FROM execution_pending_effects effect
          WHERE effect.workId = intent.workId AND effect.state = 'pending')
          AS hasPendingEffect,
        EXISTS (SELECT 1 FROM execution_stop_targets stop
          WHERE stop.workId = intent.workId) AS hasStopTarget
        FROM turn_requests request
        JOIN execution_intents intent ON intent.workId = request.workId
        JOIN task_execution_bindings binding ON binding.workId = intent.workId
        JOIN execution_request_refusals refusal ON refusal.workId = intent.workId
        JOIN domain_tasks task ON task.id = request.taskId
          AND task.projectId = request.projectId
        JOIN domain_assignments assignment ON assignment.id = request.assignmentId
          AND assignment.taskId = request.taskId
          AND assignment.projectId = request.projectId
        WHERE request.workId = ?`)
      .get(id) as
      | {
          kind: string;
          taskId: string | null;
          projectId: string | null;
          assignmentId: string | null;
          taskVersion: number | null;
          assignmentVersion: number | null;
          instructionsRevision: number | null;
          profileRevision: number | null;
          requestState: string;
          requestReason: string | null;
          intentState: string;
          intentReason: string | null;
          threadId: string | null;
          turnId: string | null;
          bindingTaskId: string;
          bindingAssignmentId: string;
          bindingAssignmentVersion: number;
          bindingInstructionsRevision: number;
          bindingProfileRevision: number;
          refusalReason: string;
          hasWriterAdmission: number;
          hasCapacityReservation: number;
          hasRecoveryIdentity: number;
          hasPendingEffect: number;
          hasStopTarget: number;
        }
      | undefined;
    if (
      !row ||
      row.kind !== "assignment" ||
      !row.taskId ||
      !row.projectId ||
      !row.assignmentId ||
      row.taskVersion === null ||
      row.assignmentVersion === null ||
      row.instructionsRevision === null ||
      row.profileRevision === null ||
      row.requestState !== "held" ||
      row.intentState !== "held" ||
      !row.refusalReason ||
      row.requestReason !== row.refusalReason ||
      row.intentReason !== row.refusalReason ||
      row.bindingTaskId !== row.taskId ||
      row.bindingAssignmentId !== row.assignmentId ||
      row.bindingAssignmentVersion !== row.assignmentVersion ||
      row.bindingInstructionsRevision !== row.instructionsRevision ||
      row.bindingProfileRevision !== row.profileRevision ||
      row.threadId !== null ||
      row.turnId !== null ||
      row.hasWriterAdmission !== 0 ||
      row.hasCapacityReservation !== 0 ||
      row.hasRecoveryIdentity !== 0 ||
      row.hasPendingEffect !== 0 ||
      row.hasStopTarget !== 0
    )
      return false;

    const refusal = row.refusalReason;
    if (!refusal.startsWith(refusedRevisionPrefix) || !refusal.endsWith(")"))
      return false;
    const reasons = refusal.slice(refusedRevisionPrefix.length, -1).split(", ");
    if (
      reasons.length === 0 ||
      !reasons.some((reason) => refusedAssignmentRevisionReasons.has(reason)) ||
      reasons.some(
        (reason) => !safeRefusedAssignmentRevisionReasons.has(reason),
      )
    )
      return false;

    const eventPrefix = `assignment:${row.assignmentId}:v${row.assignmentVersion}:inbox:`;
    if (!id.startsWith(eventPrefix)) return false;
    const eventId = id.slice(eventPrefix.length);
    if (!z.string().uuid().safeParse(eventId).success) return false;
    return (
      this.db
        .prepare(`SELECT 1 FROM coordination_inbox_events event
          WHERE event.eventId = ? AND event.taskId = ?
            AND event.recipientAssignmentId = ? LIMIT 1`)
        .get(eventId, row.taskId, row.assignmentId) !== undefined
    );
  }

  replaceConversation(assignmentId: string): number {
    const id = z.string().uuid().parse(assignmentId);
    const unresolved = this.db
      .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.assignmentId = ? AND e.state IN ('ready','capacity-waiting','held','submitting','running')
      AND NOT EXISTS (
        SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId
      ) LIMIT 1`)
      .get(id);
    if (unresolved) throw new Error("Assignment has unresolved execution");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assignment_conversations (assignmentId, revision) VALUES (?, 1)",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE assignment_conversations SET revision = revision + 1 WHERE assignmentId = ?",
      )
      .run(id);
    return Number(
      (
        this.db
          .prepare(
            "SELECT revision FROM assignment_conversations WHERE assignmentId = ?",
          )
          .get(id) as { revision: number }
      ).revision,
    );
  }

  isCurrentResult(workId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      JOIN assignment_conversations c ON c.assignmentId = b.assignmentId
      JOIN domain_assignments a ON a.id = b.assignmentId
      JOIN task_work_revisions w ON w.workId = b.workId
      WHERE b.workId = ? AND e.state = 'completed' AND
        c.revision = b.conversationRevision AND a.version = b.assignmentVersion
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = b.assignmentId
          AND ambiguous.conversationRevision = b.conversationRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = w.assignmentId
          AND newer.conversationRevision = w.conversationRevision
          AND newer.workRevision > w.workRevision
        )
      LIMIT 1`)
        .get(workId) !== undefined
    );
  }

  recordResult(workId: string, payload: string): boolean {
    const value = z.string().max(16000).parse(payload);
    const inserted = this.db
      .prepare(`INSERT OR IGNORE INTO task_execution_results (workId, payload)
      SELECT b.workId, ? FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      JOIN assignment_conversations c ON c.assignmentId = b.assignmentId
      JOIN domain_assignments a ON a.id = b.assignmentId
      JOIN task_work_revisions w ON w.workId = b.workId
      WHERE b.workId = ? AND e.state = 'completed'
      AND c.revision = b.conversationRevision AND a.version = b.assignmentVersion
      AND NOT EXISTS (
        SELECT 1 FROM task_work_revision_ambiguities ambiguous
        WHERE ambiguous.assignmentId = b.assignmentId
        AND ambiguous.conversationRevision = b.conversationRevision
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions newer
        WHERE newer.assignmentId = w.assignmentId
        AND newer.conversationRevision = w.conversationRevision
        AND newer.workRevision > w.workRevision
      )
      RETURNING workId`)
      .get(value, workId);
    if (inserted) {
      this.db
        .prepare(`UPDATE execution_pending_effects
        SET state = 'settled', reason = NULL WHERE workId = ? AND effectKey = 'assignment-result'`)
        .run(workId);
      return true;
    }
    const existing = this.db
      .prepare("SELECT payload FROM task_execution_results WHERE workId = ?")
      .get(workId) as { payload: string } | undefined;
    if (existing && existing.payload !== value)
      throw new Error("Result already recorded with different content");
    return existing !== undefined && this.isCurrentResult(workId);
  }

  create(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): ExecutionIntent {
    const input = z
      .object({
        workId: z.string().min(1),
        prompt: z.string().min(1),
        workspace: z.string().min(1),
        previousWorkId: z.string().min(1).nullable(),
      })
      .parse({
        workId,
        prompt,
        workspace,
        previousWorkId: previousWorkId ?? null,
      });
    const existing = this.byWorkId(input.workId);
    if (existing) {
      if (
        existing.prompt !== input.prompt ||
        existing.workspace !== input.workspace
      )
        throw new Error("Work ID already used with different content");
      const predecessor = this.db
        .prepare(`SELECT previousWorkId, predecessorKnown
        FROM execution_request_predecessors WHERE workId = ?`)
        .get(input.workId) as
        | { previousWorkId: string | null; predecessorKnown: number }
        | undefined;
      if (predecessor?.predecessorKnown !== 1)
        throw new Error("Work ID has unknown legacy predecessor identity");
      if (predecessor.previousWorkId !== input.previousWorkId)
        throw new Error("Work ID already used with different predecessor");
      return existing;
    }
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')",
        )
        .run(id, input.workId, input.prompt, input.workspace);
      this.db
        .prepare(`INSERT INTO execution_request_predecessors
        (workId, previousWorkId, predecessorKnown) VALUES (?, ?, 1)`)
        .run(input.workId, input.previousWorkId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  get(id: string): ExecutionIntent {
    return intentSchema.parse(
      this.db.prepare("SELECT * FROM execution_intents WHERE id = ?").get(id),
    );
  }

  byWorkId(workId: string): ExecutionIntent | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_intents WHERE workId = ?")
      .get(workId);
    return row === undefined ? undefined : intentSchema.parse(row);
  }

  list(): ExecutionIntent[] {
    return this.db
      .prepare("SELECT * FROM execution_intents ORDER BY rowid")
      .all()
      .map((row) => intentSchema.parse(row));
  }

  taskTurnRequests(taskId: string): TaskTurnRequest[] {
    if (!this.hasTurnRequests) return [];
    return this.db
      .prepare(`SELECT workId, assignmentId, assignmentVersion, sequence, state
        FROM turn_requests
        WHERE taskId = ? AND kind = 'assignment'
        ORDER BY sequence`)
      .all(z.string().uuid().parse(taskId))
      .map((row) => {
        const value = z
          .object({
            workId: z.string().min(1),
            assignmentId: z.string().uuid().nullable(),
            assignmentVersion: z.number().int().positive().nullable(),
            sequence: z.number().int().positive(),
            state: z.enum(["queued", "active", "completed", "held"]),
          })
          .parse(row);
        return value;
      });
  }

  recoveryIdentity(workId: string): RecoveryExecutionIdentity | undefined {
    const row = this.db
      .prepare(`SELECT identity.workId, identity.workRevision, identity.requestSequence,
      COALESCE(identity.threadId, intent.threadId) AS threadId,
      COALESCE(identity.turnId, intent.turnId) AS turnId,
      processId, processStartedAt, bootId
      FROM execution_recovery_identities identity
      JOIN execution_intents intent ON intent.workId = identity.workId
      WHERE identity.workId = ?`)
      .get(z.string().min(1).parse(workId)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const processIdentity =
      row.processId === null
        ? null
        : processIdentitySchema.parse({
            processId: row.processId,
            processStartedAt: row.processStartedAt,
            bootId: row.bootId,
          });
    return {
      workId: z.string().min(1).parse(row.workId),
      workRevision: z
        .number()
        .int()
        .positive()
        .nullable()
        .parse(row.workRevision),
      requestSequence: z.number().int().positive().parse(row.requestSequence),
      threadId: z.string().min(1).nullable().parse(row.threadId),
      turnId: z.string().min(1).nullable().parse(row.turnId),
      processIdentity,
    };
  }

  recoveryCandidates(): RecoveryExecutionIdentity[] {
    const workIds = this.db
      .prepare(`SELECT identity.workId
      FROM execution_recovery_identities identity
      JOIN execution_intents intent ON intent.workId = identity.workId
      WHERE intent.state IN ('held','submitting','running')
      AND EXISTS (SELECT 1 FROM task_writer_admissions admission WHERE admission.workId = intent.workId)
      ORDER BY intent.rowid`)
      .all() as Array<{ workId: string }>;
    return workIds.flatMap(({ workId }) => {
      const identity = this.recoveryIdentity(workId);
      return identity ? [identity] : [];
    });
  }

  admittedWorkIds(): string[] {
    return (
      this.db
        .prepare(`SELECT intent.workId
      FROM task_writer_admissions admission
      JOIN execution_intents intent ON intent.workId = admission.workId
      WHERE intent.state IN ('held','submitting','running')
      ORDER BY admission.sequence`)
        .all() as Array<{ workId: string }>
    ).map((row) => row.workId);
  }

  powerAdmissionState(): PowerAdmissionState {
    const row = this.db
      .prepare(`SELECT cursor, wakeHeld, reason, revision
      FROM execution_power_supervision WHERE singleton = 1`)
      .get() as
      | {
          cursor: string | null;
          wakeHeld: number;
          reason: string | null;
          revision: number;
        }
      | undefined;
    if (!row) throw new Error("Power admission state is unavailable");
    let cursor: PowerEventCursor | null = null;
    let invalidCursor = false;
    if (row.cursor !== null) {
      try {
        cursor = powerEventCursorSchema.parse(JSON.parse(row.cursor));
      } catch {
        invalidCursor = true;
      }
    }
    return {
      cursor,
      held: row.wakeHeld === 1 || invalidCursor,
      reason: row.reason,
      revision: row.revision,
    };
  }

  holdPowerAdmission(reason: string): number {
    const safeReason = z.string().trim().min(1).max(200).parse(reason);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const revision =
        (
          this.db
            .prepare(`SELECT revision FROM execution_power_supervision
        WHERE singleton = 1`)
            .get() as { revision: number }
        ).revision + 1;
      this.db
        .prepare(`UPDATE execution_power_supervision
        SET wakeHeld = 1, reason = ?, revision = ? WHERE singleton = 1`)
        .run(safeReason, revision);
      this.db
        .prepare(`INSERT INTO execution_power_reconciliation_pending (workId, revision)
        SELECT intent.workId, ? FROM task_writer_admissions admission
        JOIN execution_intents intent ON intent.workId = admission.workId
        WHERE intent.state IN ('held','submitting','running')
        ON CONFLICT(workId) DO UPDATE SET revision = excluded.revision`)
        .run(revision);
      this.db.exec("COMMIT");
      return revision;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setPowerCursorBaseline(cursor: PowerEventCursor): boolean {
    const value = powerEventCursorSchema.parse(cursor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.db
        .prepare(`SELECT wakeHeld FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number };
      const active = this.db
        .prepare(`SELECT 1 FROM task_writer_admissions admission
        JOIN execution_intents intent ON intent.workId = admission.workId
        WHERE intent.state IN ('held','submitting','running') LIMIT 1`)
        .get();
      const accepted = state.wakeHeld === 0 && active === undefined;
      if (accepted)
        this.db
          .prepare(`UPDATE execution_power_supervision
        SET cursor = ?, reason = NULL WHERE singleton = 1`)
          .run(JSON.stringify(value));
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completePowerReconciliation(
    cursor: PowerEventCursor,
    expectedRevision: number,
  ): boolean {
    const value = powerEventCursorSchema.parse(cursor);
    const revision = z.number().int().positive().parse(expectedRevision);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.db
        .prepare(`SELECT wakeHeld, revision FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number; revision: number };
      const pending = this.db
        .prepare(`SELECT 1 FROM execution_power_reconciliation_pending LIMIT 1`)
        .get();
      const accepted =
        state.wakeHeld === 1 &&
        state.revision === revision &&
        pending === undefined;
      if (accepted)
        this.db
          .prepare(`UPDATE execution_power_supervision
        SET cursor = ?, wakeHeld = 0, reason = NULL WHERE singleton = 1 AND revision = ?`)
          .run(JSON.stringify(value), revision);
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  powerReconciliationPending(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS count
      FROM execution_power_reconciliation_pending`)
        .get() as { count: number }
    ).count;
  }

  recordRecoveryObservation(
    workId: string,
    kind: string,
    terminalStatus?: "completed" | "failed",
  ): void {
    const safeKind = z
      .enum([
        "exact-live",
        "exact-terminal-completed",
        "exact-terminal-failed",
        "historical-only",
        "conflicting",
        "no-proof",
        "unknown",
        "termination-verified",
        "termination-conflict",
        "termination-unknown",
        "receipt-accepted",
        "retry-enqueued",
      ])
      .parse(kind);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const identity = this.db
        .prepare("SELECT 1 FROM execution_recovery_identities WHERE workId = ?")
        .get(z.string().min(1).parse(workId));
      const admitted = this.db
        .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
        .get(workId);
      if (!identity && !admitted)
        throw new Error("Execution recovery identity is unavailable");
      const parsedTerminal =
        terminalStatus === undefined
          ? undefined
          : z.enum(["completed", "failed"]).parse(terminalStatus);
      if (
        safeKind === "exact-terminal-completed" ||
        safeKind === "exact-terminal-failed"
      )
        this.db
          .prepare(`UPDATE execution_recovery_identities
          SET inspectionKind = ?, terminalStatus = ? WHERE workId = ?`)
          .run(
            safeKind,
            parsedTerminal ??
              (safeKind.endsWith("completed") ? "completed" : "failed"),
            workId,
          );
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt) VALUES (?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          workId,
          safeKind,
          recoveryReason(safeKind),
          Date.now(),
        );
      this.db
        .prepare(`DELETE FROM execution_power_reconciliation_pending
        WHERE workId = ?`)
        .run(workId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoveryView(): RecoveryRecord[] {
    const workIds = (
      this.db
        .prepare(`SELECT workId FROM execution_recovery_identities
      ORDER BY rowid`)
        .all() as Array<{ workId: string }>
    ).map((row) => row.workId);
    return workIds.map((workId) => {
      const row = this.db
        .prepare(`SELECT intent.state, intent.reason,
        COALESCE(identity.threadId, intent.threadId) AS threadId,
        COALESCE(identity.turnId, intent.turnId) AS turnId,
        identity.workRevision, identity.requestSequence,
        identity.processId, identity.processStartedAt, identity.bootId
        FROM execution_intents intent
        JOIN execution_recovery_identities identity ON identity.workId = intent.workId
        WHERE intent.workId = ?`)
        .get(workId) as Record<string, unknown>;
      const requestRow = this.hasTurnRequests
        ? (this.db
            .prepare(
              "SELECT state, reason, assignmentId FROM turn_requests WHERE workId = ?",
            )
            .get(workId) as Record<string, unknown> | undefined)
        : undefined;
      const bindingRow = this.db
        .prepare(`SELECT taskId, assignmentId,
        assignmentVersion, instructionsRevision, profileRevision
        FROM task_execution_bindings WHERE workId = ?`)
        .get(workId) as Record<string, unknown> | undefined;
      const effectRows = this.db
        .prepare(`SELECT state FROM execution_pending_effects
        WHERE workId = ? AND state = 'pending' ORDER BY effectKey`)
        .all(workId) as Array<{ state: string }>;
      const observationRows = this.db
        .prepare(`SELECT kind FROM execution_recovery_observations
        WHERE workId = ? ORDER BY recordedAt, rowid`)
        .all(workId) as Array<{ kind: string }>;
      const holdRow = this.db
        .prepare(`SELECT h.reason,
        EXISTS (SELECT 1 FROM task_writer_admissions admission WHERE admission.workId = ?) AS writer,
        EXISTS (SELECT 1 FROM execution_capacity_reservations reservation WHERE reservation.workId = ?) AS capacity,
        EXISTS (SELECT 1 FROM task_writer_holds stop WHERE stop.taskId = h.taskId AND stop.reason = 'Task stopped') AS stop
        FROM task_execution_bindings binding
        JOIN task_writer_holds h ON h.taskId = binding.taskId
        WHERE binding.workId = ? LIMIT 1`)
        .get(workId, workId, workId) as
        | { reason: string; writer: number; capacity: number; stop: number }
        | undefined;
      const writerAndCapacity = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM task_writer_admissions WHERE workId = ?) AS writer,
        EXISTS (SELECT 1 FROM execution_capacity_reservations WHERE workId = ?) AS capacity`)
        .get(workId, workId) as { writer: number; capacity: number };
      const uncertainty =
        row.state === "held" && writerAndCapacity.writer === 1;
      const receiptRow = this.db
        .prepare(`SELECT id, workspaceDisposition
        FROM execution_recovery_receipts WHERE workId = ?`)
        .get(workId) as
        | { id: string; workspaceDisposition: string }
        | undefined;
      const processIdentity =
        row.processId === null
          ? null
          : processIdentitySchema.parse({
              processId: row.processId,
              processStartedAt: row.processStartedAt,
              bootId: row.bootId,
            });
      const taskReason =
        holdRow?.reason === "Task stopped"
          ? "Task stopped"
          : holdRow
            ? recoveryReason("unknown")
            : null;
      return {
        workId,
        generation: {
          workRevision: z
            .number()
            .int()
            .positive()
            .nullable()
            .parse(row.workRevision),
          requestSequence: z
            .number()
            .int()
            .positive()
            .parse(row.requestSequence),
        },
        intent: {
          state: z.string().parse(row.state),
          reason: row.reason === null ? null : recoveryReason("unknown"),
          threadId: z.string().min(1).nullable().parse(row.threadId),
          turnId: z.string().min(1).nullable().parse(row.turnId),
        },
        request: requestRow
          ? {
              state: z.string().parse(requestRow.state),
              reason:
                requestRow.reason === null ? null : recoveryReason("unknown"),
              assignmentId: z
                .string()
                .min(1)
                .nullable()
                .parse(requestRow.assignmentId),
            }
          : null,
        binding: bindingRow
          ? {
              taskId: z.string().uuid().parse(bindingRow.taskId),
              assignmentId: z.string().uuid().parse(bindingRow.assignmentId),
              assignmentVersion: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.assignmentVersion),
              instructionsRevision: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.instructionsRevision),
              profileRevision: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.profileRevision),
            }
          : null,
        processIdentity,
        pendingEffects: effectRows.map((effect) => ({
          state: effect.state,
          reason: "Assignment result has not been committed",
        })),
        observations: observationRows.map((observation) => ({
          kind: observation.kind,
          reason: recoveryReason(observation.kind),
        })),
        holds: {
          task: taskReason,
          writer:
            writerAndCapacity.writer === 1 &&
            ["held", "submitting", "running"].includes(String(row.state)),
          capacity: writerAndCapacity.capacity === 1,
          uncertainty,
          stop: holdRow?.stop === 1,
        },
        receipt: receiptRow
          ? {
              id: receiptRow.id,
              workspaceDisposition: receiptRow.workspaceDisposition,
            }
          : null,
      };
    });
  }

  resolveHeldExecution(
    receipt: RecoveryReceipt,
    verification: VerifiedTermination,
  ): { id: string; workId: string; state: "reconciled" } {
    const value = recoveryReceiptSchema.parse(receipt);
    const proof = verifiedTerminationSchema.parse(verification);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const intent = this.db
        .prepare(`SELECT id, state, threadId, turnId
        FROM execution_intents WHERE workId = ?`)
        .get(value.workId) as
        | {
            id: string;
            state: string;
            threadId: string | null;
            turnId: string | null;
          }
        | undefined;
      const identity = this.recoveryIdentity(value.workId);
      if (intent?.state !== "held" || !identity)
        throw new Error("Execution generation is not held for recovery");
      const requestSequence = this.hasTurnRequests
        ? (
            this.db
              .prepare("SELECT sequence FROM turn_requests WHERE workId = ?")
              .get(value.workId) as { sequence: number } | undefined
          )?.sequence
        : undefined;
      const actualWorkRevision =
        (
          this.db
            .prepare(
              "SELECT workRevision FROM task_work_revisions WHERE workId = ?",
            )
            .get(value.workId) as { workRevision: number } | undefined
        )?.workRevision ?? null;
      if (
        identity.workRevision !== value.workRevision ||
        actualWorkRevision !== value.workRevision ||
        identity.requestSequence !== value.requestSequence ||
        requestSequence !== value.requestSequence ||
        identity.threadId !== value.threadId ||
        intent.threadId !== value.threadId ||
        identity.turnId !== value.turnId ||
        intent.turnId !== value.turnId ||
        !identity.processIdentity ||
        identity.processIdentity.processId !==
          value.processIdentity.processId ||
        identity.processIdentity.processStartedAt !==
          value.processIdentity.processStartedAt ||
        identity.processIdentity.bootId !== value.processIdentity.bootId ||
        proof.processIdentity.processId !==
          identity.processIdentity.processId ||
        proof.processIdentity.processStartedAt !==
          identity.processIdentity.processStartedAt ||
        proof.processIdentity.bootId !== identity.processIdentity.bootId
      )
        throw new Error(
          "Recovery receipt generation or execution identity does not match",
        );
      if (
        this.db
          .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
          .get(value.workId) === undefined ||
        this.db
          .prepare(
            "SELECT 1 FROM execution_capacity_reservations WHERE workId = ?",
          )
          .get(value.workId) === undefined
      )
        throw new Error(
          "Exact generation no longer owns its writer and capacity holds",
        );

      const receiptId = randomUUID();
      const changed = this.db
        .prepare(`UPDATE execution_intents
        SET state = 'reconciled', reason = 'Execution reconciled from validated recovery receipt'
        WHERE workId = ? AND state = 'held' AND threadId = ? AND turnId = ?
        RETURNING id`)
        .get(value.workId, value.threadId, value.turnId) as
        | { id: string }
        | undefined;
      if (!changed)
        throw new Error(
          "Recovery generation changed during receipt validation",
        );
      this.db
        .prepare(`INSERT INTO execution_recovery_receipts
        (id, workId, workRevision, requestSequence, threadId, turnId, processId,
          processStartedAt, bootId, terminationMethod, terminationVerifiedAt,
          effectsState, workspaceDisposition, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?)`)
        .run(
          receiptId,
          value.workId,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.processIdentity.processId,
          value.processIdentity.processStartedAt,
          value.processIdentity.bootId,
          proof.method,
          proof.verifiedAt,
          value.workspace,
          Date.now(),
        );
      this.db
        .prepare(`UPDATE execution_pending_effects SET state = 'settled', reason = NULL
        WHERE workId = ? AND state = 'pending'`)
        .run(value.workId);
      this.db
        .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
        .run(value.workId);
      if (this.hasTurnRequests)
        this.db
          .prepare(`UPDATE turn_requests SET state = 'held',
          reason = 'Execution reconciled; no automatic successor' WHERE workId = ?`)
          .run(value.workId);
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt) VALUES (?, ?, 'receipt-accepted', ?, ?)`)
        .run(
          randomUUID(),
          value.workId,
          recoveryReason("receipt-accepted"),
          Date.now(),
        );
      this.db.exec("COMMIT");
      return { id: receiptId, workId: value.workId, state: "reconciled" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  writerAndSuccessors(workId: string): ExecutionIntent[] {
    const admission = this.db
      .prepare(
        "SELECT sequence, workspace FROM task_writer_admissions WHERE workId = ?",
      )
      .get(workId) as { sequence: number; workspace: string } | undefined;
    if (!admission) {
      const writer = this.byWorkId(workId);
      return writer
        ? this.list().filter(
            (item) =>
              item.workspace === writer.workspace &&
              (item.state === "completed" ||
                item.state === "submitting" ||
                item.state === "running"),
          )
        : [];
    }
    return this.db
      .prepare(`SELECT e.* FROM task_writer_admissions a
      JOIN execution_intents e ON e.workId = a.workId
      WHERE a.workspace = ? AND a.sequence >= ? ORDER BY a.sequence`)
      .all(admission.workspace, admission.sequence)
      .map((row) => intentSchema.parse(row));
  }

  setWorkspaceKey(id: string, workspace: string): void {
    this.db
      .prepare("UPDATE execution_intents SET workspace = ? WHERE id = ?")
      .run(workspace, id);
  }

  /** An interrupted service cannot prove a send failed or a writer stopped. */
  holdUnfinishedOnOpen(): void {
    const held = this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = 'service restarted with unresolved execution' WHERE state IN ('submitting','running') RETURNING workId",
      )
      .all() as { workId: string }[];
    if (this.hasTurnRequests)
      for (const row of held)
        this.db
          .prepare(
            "UPDATE turn_requests SET state = 'held', reason = 'service restarted with unresolved execution' WHERE workId = ?",
          )
          .run(row.workId);
  }

  begin(
    id: string,
    options: {
      projectId: string | null;
      requestSequence?: number;
      processIdentity?: RuntimeProcessIdentity | null;
      validate?: () => string[];
      refuse?: (reasons: string[]) => boolean;
    } = {
      projectId: null,
    },
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reasons = options.validate?.() ?? [];
      if (reasons.length > 0) {
        const refused = options.refuse?.(reasons) ?? false;
        const reason = refused
          ? `Request refused: captured revisions no longer match (${reasons.join(", ")})`
          : `Admission waiting: ${reasons.join(", ")}`;
        this.db
          .prepare(
            `UPDATE execution_intents SET state = ?, reason = ?
           WHERE id = ? AND state IN ('ready','capacity-waiting')`,
          )
          .run(refused ? "held" : "ready", reason, id);
        if (refused) {
          const intent = this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string } | undefined;
          if (intent) {
            this.db
              .prepare(
                "INSERT OR REPLACE INTO execution_request_refusals (workId, reason) VALUES (?, ?)",
              )
              .run(intent.workId, reason);
            if (this.hasTurnRequests)
              this.db
                .prepare(
                  "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = ? AND state = 'queued'",
                )
                .run(reason, intent.workId);
          }
        } else if (this.hasTurnRequests) {
          const intent = this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string } | undefined;
          if (intent)
            this.db
              .prepare(
                "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
              )
              .run(reason, intent.workId);
        }
        this.db.exec("COMMIT");
        return false;
      }
      const pending = this.db
        .prepare("SELECT workId, state FROM execution_intents WHERE id = ?")
        .get(id) as { state: string; workId: string } | undefined;
      if (
        !pending ||
        (pending.state !== "ready" && pending.state !== "capacity-waiting")
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      const powerGate = this.db
        .prepare(`SELECT wakeHeld FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number } | undefined;
      if (powerGate?.wakeHeld === 1) {
        const reason = "Admission waiting: power-event reconciliation";
        this.db
          .prepare(`UPDATE execution_intents
          SET state = 'capacity-waiting', reason = ?
          WHERE id = ? AND state IN ('ready','capacity-waiting')`)
          .run(reason, id);
        if (this.hasTurnRequests)
          this.db
            .prepare(`UPDATE turn_requests SET reason = ?
            WHERE workId = ? AND state = 'queued'`)
            .run(reason, pending.workId);
        this.db.exec("COMMIT");
        return false;
      }
      const configuredGlobalLimit = this.db
        .prepare(
          "SELECT globalLimit FROM scheduler_capacity_limits WHERE singleton = 1",
        )
        .get() as { globalLimit: number } | undefined;
      const globalLimit = configuredGlobalLimit?.globalLimit ?? 4;
      const globalUsage = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_capacity_reservations",
          )
          .get() as { count: number }
      ).count;
      const projectLimit = options.projectId
        ? ((
            this.db
              .prepare(
                "SELECT projectLimit FROM scheduler_project_capacity_limits WHERE projectId = ?",
              )
              .get(options.projectId) as { projectLimit: number } | undefined
          )?.projectLimit ?? 2)
        : undefined;
      const projectUsage = options.projectId
        ? (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE projectId = ?",
              )
              .get(options.projectId) as { count: number }
          ).count
        : 0;
      const capacityReason =
        globalUsage >= globalLimit
          ? `Capacity waiting: global active-turn limit (${globalLimit})`
          : projectLimit !== undefined && projectUsage >= projectLimit
            ? `Capacity waiting: project active-turn limit (${projectLimit})`
            : undefined;
      if (capacityReason) {
        this.db
          .prepare(
            "UPDATE execution_intents SET state = 'capacity-waiting', reason = ? WHERE id = ? AND state IN ('ready','capacity-waiting')",
          )
          .run(capacityReason, id);
        if (this.hasTurnRequests)
          this.db
            .prepare(
              "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
            )
            .run(capacityReason, pending.workId);
        this.db.exec("COMMIT");
        return false;
      }
      const admitted =
        this.db
          .prepare(
            `UPDATE execution_intents SET state = 'submitting', reason = NULL
           WHERE id = ? AND state IN ('ready','capacity-waiting')
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b JOIN task_writer_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b
             JOIN task_writer_ambiguity_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b
             JOIN task_archival_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM execution_intents AS other
             WHERE other.workspace = execution_intents.workspace
             AND other.id != execution_intents.id
             AND other.state IN ('held','submitting','running')
             AND NOT EXISTS (
               SELECT 1 FROM execution_request_refusals r WHERE r.workId = other.workId
             )
           ) RETURNING id`,
          )
          .get(id) !== undefined;
      if (admitted) {
        const workId = (
          this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string }
        ).workId;
        const retryGeneration = this.db
          .prepare(`SELECT chainId FROM execution_retry_generations
          WHERE workId = ?`)
          .get(workId) as { chainId: string } | undefined;
        if (!retryGeneration) {
          this.db
            .prepare(`INSERT INTO execution_retry_chains
            (chainId, ensembleRetriesUsed, codexRetriesUsed, nextEligibleAt)
            VALUES (?, 0, 0, NULL)`)
            .run(workId);
          this.db
            .prepare(`INSERT INTO execution_retry_generations
            (workId, chainId, retryIndex) VALUES (?, ?, 0)`)
            .run(workId, workId);
        }
        this.db
          .prepare(`INSERT INTO task_writer_admissions (workId, workspace)
          SELECT workId, workspace FROM execution_intents WHERE id = ?`)
          .run(id);
        this.db
          .prepare(`INSERT INTO execution_capacity_reservations (workId, projectId)
          VALUES (?, ?)`)
          .run(workId, options.projectId);
        const taskBinding = this.taskBinding(workId);
        if (taskBinding) {
          const activated = this.db
            .prepare(`UPDATE domain_assignments SET state = 'running'
            WHERE id = ? AND taskId = ? AND version = ?
              AND state IN ('pending', 'running')
              AND EXISTS (
                SELECT 1 FROM task_execution_bindings binding
                WHERE binding.workId = ?
                  AND binding.assignmentId = domain_assignments.id
                  AND binding.taskId = domain_assignments.taskId
                  AND binding.assignmentVersion = domain_assignments.version
              ) RETURNING id`)
            .get(
              taskBinding.assignmentId,
              taskBinding.taskId,
              taskBinding.assignmentVersion,
              workId,
            ) as { id: string } | undefined;
          if (!activated)
            throw new Error(
              "Assignment admission no longer matches its bound version",
            );
        }
        if (this.hasTurnRequests)
          this.db
            .prepare(
              "UPDATE turn_requests SET state = 'active', reason = NULL WHERE workId = ? AND state = 'queued'",
            )
            .run(workId);
        this.db
          .prepare(`INSERT INTO task_work_revisions
          (workId, assignmentId, conversationRevision, workRevision)
          SELECT b.workId, b.assignmentId, b.conversationRevision,
            COALESCE((
              SELECT MAX(existing.workRevision) FROM task_work_revisions existing
              WHERE existing.assignmentId = b.assignmentId
              AND existing.conversationRevision = b.conversationRevision
            ), 0) + 1
          FROM task_execution_bindings b
          JOIN execution_intents e ON e.workId = b.workId
          WHERE e.id = ?`)
          .run(id);
        this.db
          .prepare(`DELETE FROM task_work_revision_pending
          WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?) `)
          .run(id);
        if (options.requestSequence !== undefined) {
          const requestSequence = z
            .number()
            .int()
            .positive()
            .parse(options.requestSequence);
          const workRevision =
            (
              this.db
                .prepare(
                  "SELECT workRevision FROM task_work_revisions WHERE workId = ?",
                )
                .get(pending.workId) as { workRevision: number } | undefined
            )?.workRevision ?? null;
          const processIdentity = options.processIdentity
            ? processIdentitySchema.parse(options.processIdentity)
            : null;
          this.db
            .prepare(`INSERT INTO execution_recovery_identities
            (workId, workRevision, requestSequence, processId, processStartedAt,
              bootId, threadId, turnId, inspectionKind, terminalStatus)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
            .run(
              pending.workId,
              workRevision,
              requestSequence,
              processIdentity?.processId ?? null,
              processIdentity?.processStartedAt ?? null,
              processIdentity?.bootId ?? null,
            );
          this.db
            .prepare(`INSERT OR IGNORE INTO execution_pending_effects
            (workId, effectKey, state, reason)
            SELECT ?, 'assignment-result', 'pending',
              'Assignment result has not been committed'
            WHERE EXISTS (SELECT 1 FROM task_execution_bindings WHERE workId = ?)`)
            .run(pending.workId, pending.workId);
        }
      } else {
        const intent = this.db
          .prepare(
            "SELECT workId, workspace, state FROM execution_intents WHERE id = ?",
          )
          .get(id) as
          | { state: string; workId: string; workspace: string }
          | undefined;
        if (intent?.state === "ready" || intent?.state === "capacity-waiting") {
          const binding = this.db
            .prepare(
              "SELECT taskId FROM task_execution_bindings WHERE workId = ?",
            )
            .get(intent.workId) as { taskId: string } | undefined;
          const taskHold = binding ? this.taskHold(binding.taskId) : undefined;
          const unresolved = this.db
            .prepare(`SELECT state, reason FROM execution_intents
              WHERE workspace = ? AND id != ? AND state IN ('held','submitting','running')
              ORDER BY rowid LIMIT 1`)
            .get(intent.workspace, id) as
            | { state: string; reason: string | null }
            | undefined;
          const reason = taskHold
            ? `Admission waiting: ${taskHold}`
            : unresolved?.state === "held"
              ? `Workspace has unresolved execution${unresolved.reason ? `: ${unresolved.reason}` : ""}`
              : "Waiting for workspace writer";
          this.db
            .prepare(
              "UPDATE execution_intents SET state = 'ready', reason = ? WHERE id = ?",
            )
            .run(reason, id);
          if (this.hasTurnRequests)
            this.db
              .prepare(
                "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
              )
              .run(reason, intent.workId);
        }
      }
      this.db.exec("COMMIT");
      return admitted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindThread(id: string, threadId: string): boolean {
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'submitting' AND threadId IS NULL RETURNING id",
        )
        .get(threadId, id) !== undefined
    ) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET threadId = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(threadId, id);
      return true;
    }
    const held = this.db
      .prepare(`UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'held'
        AND threadId IS NULL AND turnId IS NULL AND EXISTS (
          SELECT 1 FROM execution_stop_targets s WHERE s.workId = execution_intents.workId
        ) RETURNING workId`)
      .get(threadId, id) as { workId: string } | undefined;
    if (held) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET threadId = ? WHERE workId = ?",
        )
        .run(threadId, held.workId);
      this.bindStopIdentity(held.workId, threadId);
    }
    return false;
  }

  bindTurn(id: string, turnId: string): boolean {
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET state = 'running', turnId = ? WHERE id = ? AND state = 'submitting' AND turnId IS NULL RETURNING id",
        )
        .get(turnId, id) !== undefined
    ) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET turnId = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(turnId, id);
      return true;
    }
    const stoppedThreadId = this.get(id).threadId;
    if (stoppedThreadId) {
      const stopped = this.db
        .prepare(`UPDATE execution_intents SET turnId = ? WHERE id = ? AND state = 'held'
          AND threadId = ? AND turnId IS NULL AND EXISTS (
            SELECT 1 FROM execution_stop_targets s WHERE s.workId = execution_intents.workId
          ) RETURNING workId`)
        .get(turnId, id, stoppedThreadId) as { workId: string } | undefined;
      if (stopped) {
        this.db
          .prepare(
            "UPDATE execution_recovery_identities SET turnId = ? WHERE workId = ?",
          )
          .run(turnId, stopped.workId);
        this.bindStopIdentity(stopped.workId, stoppedThreadId, turnId);
        return false;
      }
    }
    // The server may return after a callback has held this submission. Record
    // the server turn identity without reviving the writer or admitting work.
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET turnId = ? WHERE id = ? AND state = 'held' AND threadId IS NOT NULL AND turnId IS NULL RETURNING id",
        )
        .get(turnId, id) !== undefined
    ) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET turnId = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(turnId, id);
      return false;
    }
    this.db
      .prepare(
        "UPDATE execution_intents SET reason = COALESCE(reason, '') || '; conflicting turn/start response: ' || ? WHERE id = ? AND state = 'held' AND turnId IS NOT NULL AND turnId != ?",
      )
      .run(turnId, id, turnId);
    return false;
  }

  holdPendingTurn(
    id: string,
    threadId: string,
    turnId: string,
    reason: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE execution_intents SET state = 'held', reason = ?, turnId = ? WHERE id = ? AND state IN ('submitting','held') AND threadId = ? AND turnId IS NULL RETURNING id",
        )
        .get(reason, turnId, id, threadId) !== undefined
    );
  }

  hold(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state NOT IN ('completed','reconciled','resolved-failed')",
      )
      .run(reason, id);
    if (this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(reason, id);
  }

  wait(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'ready', reason = ? WHERE id = ? AND state IN ('ready','capacity-waiting')",
      )
      .run(reason, id);
    if (this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET reason = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?) AND state = 'queued'",
        )
        .run(reason, id);
  }

  holdTerminalConflict(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state IN ('submitting','running','completed')",
      )
      .run(reason, id);
    if (this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(reason, id);
  }

  resolveFailedGeneration(
    input: FailureResolutionEvidence,
  ): FailedGenerationResolution | undefined {
    const value = failureResolutionSchema.parse(input);
    if (!this.hasTurnRequests)
      throw new Error("Retry resolution requires durable turn requests");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const committed = this.db
        .prepare(`SELECT * FROM execution_retry_resolutions
        WHERE failedWorkId = ?`)
        .get(value.workId) as
        | {
            failedWorkId: string;
            retryWorkId: string;
            retryIndex: number;
            ensembleRetriesUsed: number;
            codexRetriesUsed: number;
            workRevision: number | null;
            requestSequence: number;
            threadId: string;
            turnId: string;
            reasonCode: string;
            failureSource: string;
            codexRetries: number;
            nextEligibleAt: number;
          }
        | undefined;
      if (committed) {
        if (
          committed.workRevision !== value.workRevision ||
          committed.requestSequence !== value.requestSequence ||
          committed.threadId !== value.threadId ||
          committed.turnId !== value.turnId ||
          committed.reasonCode !== value.reasonCode ||
          committed.failureSource !== value.source ||
          committed.codexRetries !== value.codexRetries
        )
          throw new Error(
            "Retry resolution proof does not match the committed generation",
          );
        this.db.exec("COMMIT");
        return {
          failedWorkId: committed.failedWorkId,
          retryWorkId: committed.retryWorkId,
          retryIndex: committed.retryIndex,
          ensembleRetriesUsed: committed.ensembleRetriesUsed,
          codexRetriesUsed: committed.codexRetriesUsed,
          nextEligibleAt: committed.nextEligibleAt,
        };
      }

      const current = this.db
        .prepare(`SELECT intent.id, intent.state, intent.threadId,
        intent.turnId, intent.workspace, request.requestKey, request.kind,
        request.taskId, request.projectId, request.assignmentId, request.taskVersion,
        request.assignmentVersion, request.instructionsRevision,
        request.profileRevision, request.prompt, request.state AS requestState,
        request.sequence AS requestSequence, identity.workRevision,
        identity.requestSequence AS identitySequence,
        identity.threadId AS identityThreadId, identity.turnId AS identityTurnId,
        identity.inspectionKind, identity.terminalStatus
        FROM execution_intents intent
        JOIN turn_requests request ON request.workId = intent.workId
        JOIN execution_recovery_identities identity ON identity.workId = intent.workId
        WHERE intent.workId = ?`)
        .get(value.workId) as
        | {
            id: string;
            state: string;
            threadId: string | null;
            turnId: string | null;
            workspace: string;
            requestKey: string;
            kind: string;
            taskId: string | null;
            projectId: string | null;
            assignmentId: string | null;
            taskVersion: number | null;
            assignmentVersion: number | null;
            instructionsRevision: number | null;
            profileRevision: number | null;
            prompt: string;
            requestState: string;
            requestSequence: number;
            workRevision: number | null;
            identitySequence: number;
            identityThreadId: string | null;
            identityTurnId: string | null;
            inspectionKind: string | null;
            terminalStatus: string | null;
          }
        | undefined;
      const actualWorkRevision =
        (
          this.db
            .prepare(`SELECT workRevision FROM task_work_revisions
        WHERE workId = ?`)
            .get(value.workId) as { workRevision: number } | undefined
        )?.workRevision ?? null;
      if (
        current?.state !== "held" ||
        current.requestState !== "held" ||
        current.workRevision !== value.workRevision ||
        actualWorkRevision !== value.workRevision ||
        current.requestSequence !== value.requestSequence ||
        current.identitySequence !== value.requestSequence ||
        current.threadId !== value.threadId ||
        current.identityThreadId !== value.threadId ||
        current.turnId !== value.turnId ||
        current.identityTurnId !== value.turnId ||
        current.inspectionKind !== "exact-terminal-failed" ||
        current.terminalStatus !== "failed"
      )
        throw new Error(
          "Retry resolution evidence does not match the exact failed generation",
        );

      const writer = this.db
        .prepare(`SELECT 1 FROM task_writer_admissions
        WHERE workId = ?`)
        .get(value.workId);
      const reservation = this.db
        .prepare(`SELECT 1 FROM execution_capacity_reservations
        WHERE workId = ?`)
        .get(value.workId);
      if (!writer || !reservation)
        throw new Error(
          "Failed generation no longer owns its exact writer and capacity",
        );

      const independentlyHeld = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM execution_stop_targets WHERE workId = ?) AS stopped,
        EXISTS (SELECT 1 FROM execution_request_refusals WHERE workId = ?) AS refused,
        EXISTS (SELECT 1 FROM execution_pending_effects
          WHERE workId = ? AND state = 'pending') AS pendingEffect,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS taskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_ambiguity_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS ambiguousTaskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_archival_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS archivalHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_execution_bindings otherBinding ON otherBinding.taskId = binding.taskId
          JOIN execution_intents other ON other.workId = otherBinding.workId
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE binding.workId = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherTaskWriter,
        EXISTS (SELECT 1 FROM execution_intents other
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE other.workspace = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherWorkspaceWriter`)
        .get(
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          current.workspace,
          value.workId,
        ) as {
        stopped: number;
        refused: number;
        pendingEffect: number;
        taskHold: number;
        ambiguousTaskHold: number;
        archivalHold: number;
        otherTaskWriter: number;
        otherWorkspaceWriter: number;
      };
      if (
        !value.callbacksEnded ||
        !value.noSurvivor ||
        independentlyHeld.stopped ||
        independentlyHeld.refused ||
        independentlyHeld.pendingEffect ||
        independentlyHeld.taskHold ||
        independentlyHeld.ambiguousTaskHold ||
        independentlyHeld.archivalHold ||
        independentlyHeld.otherTaskWriter ||
        independentlyHeld.otherWorkspaceWriter
      ) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const generation = this.db
        .prepare(`SELECT chainId, retryIndex
        FROM execution_retry_generations WHERE workId = ?`)
        .get(value.workId) as
        | { chainId: string; retryIndex: number }
        | undefined;
      const chain = generation
        ? (this.db
            .prepare(`SELECT ensembleRetriesUsed, codexRetriesUsed
            FROM execution_retry_chains WHERE chainId = ?`)
            .get(generation.chainId) as
            | { ensembleRetriesUsed: number; codexRetriesUsed: number }
            | undefined)
        : undefined;
      if (
        !generation ||
        !chain ||
        generation.retryIndex !== chain.ensembleRetriesUsed
      )
        throw new Error(
          "Retry accounting state is unavailable or inconsistent",
        );

      const priorAttempt = this.db
        .prepare(`SELECT chainId, workRevision, requestSequence,
        threadId, turnId, reasonCode, failureSource, codexRetries, disposition
        FROM execution_retry_attempts WHERE workId = ?`)
        .get(value.workId) as
        | {
            chainId: string;
            workRevision: number | null;
            requestSequence: number;
            threadId: string;
            turnId: string;
            reasonCode: string;
            failureSource: string;
            codexRetries: number;
            disposition: string;
          }
        | undefined;
      if (priorAttempt) {
        if (
          priorAttempt.chainId !== generation.chainId ||
          priorAttempt.workRevision !== value.workRevision ||
          priorAttempt.requestSequence !== value.requestSequence ||
          priorAttempt.threadId !== value.threadId ||
          priorAttempt.turnId !== value.turnId ||
          priorAttempt.reasonCode !== value.reasonCode ||
          priorAttempt.failureSource !== value.source ||
          priorAttempt.codexRetries !== value.codexRetries
        )
          throw new Error(
            "Retry attempt evidence conflicts with the recorded terminal failure",
          );
        this.db.exec("COMMIT");
        return undefined;
      }

      const codexRetriesUsed = chain.codexRetriesUsed + value.codexRetries;
      const ensembleRetriesUsed = chain.ensembleRetriesUsed + 1;
      if (codexRetriesUsed + ensembleRetriesUsed > 2) {
        this.db
          .prepare(`UPDATE execution_retry_chains SET codexRetriesUsed = ?,
          nextEligibleAt = NULL WHERE chainId = ?`)
          .run(codexRetriesUsed, generation.chainId);
        this.db
          .prepare(`INSERT INTO execution_retry_attempts
          (workId, chainId, workRevision, requestSequence, threadId, turnId,
            reasonCode, failureSource, codexRetries, disposition, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'budget-exhausted', ?)`)
          .run(
            value.workId,
            generation.chainId,
            value.workRevision,
            value.requestSequence,
            value.threadId,
            value.turnId,
            value.reasonCode,
            value.source,
            value.codexRetries,
            Date.now(),
          );
        this.db.exec("COMMIT");
        return undefined;
      }

      const retryIndex = ensembleRetriesUsed;
      const retryWorkId = `retry:${generation.chainId}:${retryIndex}`;
      const retryRequestKey = retryWorkId;
      this.db
        .prepare(`INSERT INTO execution_intents
        (id, workId, prompt, workspace, state, reason, threadId, turnId,
          accountType, sandbox, approval)
        VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')`)
        .run(randomUUID(), retryWorkId, current.prompt, current.workspace);
      this.db
        .prepare(`INSERT INTO execution_request_predecessors
        (workId, previousWorkId, predecessorKnown) VALUES (?, NULL, 1)`)
        .run(retryWorkId);
      this.db
        .prepare(`INSERT INTO task_execution_bindings
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision)
        SELECT ?, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision FROM task_execution_bindings
        WHERE workId = ?`)
        .run(retryWorkId, value.workId);
      this.db
        .prepare(`INSERT INTO turn_requests
        (requestKey, workId, kind, taskId, projectId, assignmentId, taskVersion,
          assignmentVersion, instructionsRevision, profileRevision, prompt,
          workspace, previousWorkId, state, reason, nextEligibleAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, ?)`)
        .run(
          retryRequestKey,
          retryWorkId,
          current.kind,
          current.taskId,
          current.projectId,
          current.assignmentId,
          current.taskVersion,
          current.assignmentVersion,
          current.instructionsRevision,
          current.profileRevision,
          current.prompt,
          current.workspace,
          value.nextEligibleAt,
        );
      const resolved = this.db
        .prepare(`UPDATE execution_intents SET state = 'resolved-failed',
        reason = ? WHERE workId = ? AND state = 'held' RETURNING workId`)
        .get(
          `Confirmed transient failure (${value.reasonCode}); retry queued`,
          value.workId,
        );
      if (!resolved)
        throw new Error("Failed generation changed before retry resolution");
      this.db
        .prepare(`UPDATE turn_requests SET state = 'held',
        reason = 'Confirmed transient failure resolved; retry queued'
        WHERE workId = ? AND state = 'held'`)
        .run(value.workId);
      this.db
        .prepare(`DELETE FROM execution_capacity_reservations WHERE workId = ?`)
        .run(value.workId);
      this.db
        .prepare(`DELETE FROM task_writer_admissions WHERE workId = ?`)
        .run(value.workId);
      this.db
        .prepare(`UPDATE execution_retry_chains SET ensembleRetriesUsed = ?,
        codexRetriesUsed = ?, nextEligibleAt = ? WHERE chainId = ?`)
        .run(
          ensembleRetriesUsed,
          codexRetriesUsed,
          value.nextEligibleAt,
          generation.chainId,
        );
      this.db
        .prepare(`INSERT INTO execution_retry_generations
        (workId, chainId, retryIndex) VALUES (?, ?, ?)`)
        .run(retryWorkId, generation.chainId, retryIndex);
      this.db
        .prepare(`INSERT INTO execution_retry_attempts
        (workId, chainId, workRevision, requestSequence, threadId, turnId,
          reasonCode, failureSource, codexRetries, disposition, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'retry-queued', ?)`)
        .run(
          value.workId,
          generation.chainId,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.reasonCode,
          value.source,
          value.codexRetries,
          Date.now(),
        );
      this.db
        .prepare(`INSERT INTO execution_retry_resolutions
        (failedWorkId, retryWorkId, chainId, retryIndex, workRevision,
          requestSequence, threadId, turnId, reasonCode, failureSource,
          codexRetries, ensembleRetriesUsed, codexRetriesUsed,
          nextEligibleAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          value.workId,
          retryWorkId,
          generation.chainId,
          retryIndex,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.reasonCode,
          value.source,
          value.codexRetries,
          ensembleRetriesUsed,
          codexRetriesUsed,
          value.nextEligibleAt,
          Date.now(),
        );
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt)
        VALUES (?, ?, 'retry-enqueued', ?, ?)`)
        .run(
          randomUUID(),
          value.workId,
          recoveryReason("retry-enqueued"),
          Date.now(),
        );
      this.db.exec("COMMIT");
      return {
        failedWorkId: value.workId,
        retryWorkId,
        retryIndex,
        ensembleRetriesUsed,
        codexRetriesUsed,
        nextEligibleAt: value.nextEligibleAt,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(id: string, threadId: string, turnId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "UPDATE execution_intents SET state = 'completed', reason = NULL WHERE id = ? AND state = 'running' AND threadId = ? AND turnId = ? RETURNING workId",
        )
        .get(id, threadId, turnId) as { workId: string } | undefined;
      if (!row)
        throw new Error(
          "Completion identity or state does not match execution binding",
        );
      this.db
        .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
        .run(row.workId);
      if (this.hasTurnRequests)
        this.db
          .prepare(
            "UPDATE turn_requests SET state = 'completed', reason = NULL WHERE workId = ?",
          )
          .run(row.workId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const stopTargetSchema = z.object({
  taskId: z.string().uuid(),
  workId: z.string().min(1),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  interruptState: z.enum(["pending", "acknowledged", "failed", "unbound"]),
  terminalState: z.enum(["unknown", "completed", "failed"]),
  reason: z.string().nullable(),
  requestedAt: z.number().int(),
});
