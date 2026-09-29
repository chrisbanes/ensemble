import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../core/store.js";

const intentSchema = z.object({
  id: z.string().uuid(),
  workId: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  state: z.enum(["ready", "held", "submitting", "running", "completed"]),
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

/** No method retries an uncertain submission. Callers must create a new work ID. */
export class ExecutionState {
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
    CREATE TABLE IF NOT EXISTS task_writer_ambiguity_holds (
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
    )`);
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
  }

  stopTask(taskId: string): void {
    const id = z.string().uuid().parse(taskId);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_writer_holds (taskId, reason) VALUES (?, 'Task stopped')",
      )
      .run(id);
    this.db
      .prepare(`UPDATE execution_intents SET state = 'held', reason = 'Task stopped'
      WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
      AND state IN ('submitting','running')`)
      .run(id);
  }

  resumeTask(taskId: string): void {
    this.db
      .prepare(
        "DELETE FROM task_writer_holds WHERE taskId = ? AND reason = 'Task stopped'",
      )
      .run(z.string().uuid().parse(taskId));
  }

  taskHold(taskId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT reason FROM task_writer_ambiguity_holds WHERE taskId = ?
        UNION ALL SELECT reason FROM task_writer_holds WHERE taskId = ? LIMIT 1`)
      .get(taskId, taskId) as { reason: string } | undefined;
    return row?.reason;
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
      !binding ||
      Object.entries({ ...input, workId, conversationRevision: revision }).some(
        ([key, value]) => binding[key as keyof TaskExecutionBinding] !== value,
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
    return binding;
  }

  taskBinding(workId: string): TaskExecutionBinding | undefined {
    return this.db
      .prepare("SELECT * FROM task_execution_bindings WHERE workId = ?")
      .get(workId) as TaskExecutionBinding | undefined;
  }

  replaceConversation(assignmentId: string): number {
    const id = z.string().uuid().parse(assignmentId);
    const unresolved = this.db
      .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.assignmentId = ? AND e.state IN ('ready','held','submitting','running') LIMIT 1`)
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
    if (inserted) return true;
    const existing = this.db
      .prepare("SELECT payload FROM task_execution_results WHERE workId = ?")
      .get(workId) as { payload: string } | undefined;
    if (existing && existing.payload !== value)
      throw new Error("Result already recorded with different content");
    return existing !== undefined && this.isCurrentResult(workId);
  }

  hasUnresolvedTask(taskId: string): boolean {
    return (
      this.taskHold(taskId) !== undefined ||
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.taskId = ? AND e.state IN ('ready','held','submitting','running') LIMIT 1`)
        .get(taskId) !== undefined
    );
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
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = 'service restarted with unresolved execution' WHERE state IN ('submitting','running')",
      )
      .run();
  }

  begin(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const admitted =
        this.db
          .prepare(
            `UPDATE execution_intents SET state = 'submitting', reason = NULL
           WHERE id = ? AND state = 'ready'
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
             SELECT 1 FROM execution_intents AS other
             WHERE other.workspace = execution_intents.workspace
             AND other.id != execution_intents.id
             AND other.state IN ('held','submitting','running')
           ) RETURNING id`,
          )
          .get(id) !== undefined;
      if (admitted) {
        this.db
          .prepare(`INSERT INTO task_writer_admissions (workId, workspace)
          SELECT workId, workspace FROM execution_intents WHERE id = ?`)
          .run(id);
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
      }
      this.db.exec("COMMIT");
      return admitted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindThread(id: string, threadId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'submitting' AND threadId IS NULL RETURNING id",
        )
        .get(threadId, id) !== undefined
    );
  }

  bindTurn(id: string, turnId: string): boolean {
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET state = 'running', turnId = ? WHERE id = ? AND state = 'submitting' AND turnId IS NULL RETURNING id",
        )
        .get(turnId, id) !== undefined
    )
      return true;
    // The server may return after a callback has held this submission. Record
    // the server turn identity without reviving the writer or admitting work.
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET turnId = ? WHERE id = ? AND state = 'held' AND threadId IS NOT NULL AND turnId IS NULL RETURNING id",
        )
        .get(turnId, id) !== undefined
    )
      return false;
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
          "UPDATE execution_intents SET state = 'held', reason = ?, turnId = ? WHERE id = ? AND state = 'submitting' AND threadId = ? AND turnId IS NULL RETURNING id",
        )
        .get(reason, turnId, id, threadId) !== undefined
    );
  }

  hold(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state != 'completed'",
      )
      .run(reason, id);
  }

  holdTerminalConflict(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state IN ('submitting','running','completed')",
      )
      .run(reason, id);
  }

  complete(id: string, threadId: string, turnId: string): void {
    const row = this.db
      .prepare(
        "UPDATE execution_intents SET state = 'completed', reason = NULL WHERE id = ? AND state = 'running' AND threadId = ? AND turnId = ? RETURNING id",
      )
      .get(id, threadId, turnId);
    if (!row)
      throw new Error(
        "Completion identity or state does not match execution binding",
      );
  }
}
