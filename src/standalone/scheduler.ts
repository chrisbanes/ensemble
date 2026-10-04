import { z } from "zod";
import type { Database } from "../core/store.js";

const requestSchema = z.object({
  requestKey: z.string().min(1),
  workId: z.string().min(1),
  kind: z.enum(["direct", "assignment"]),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  assignmentId: z.string().uuid().nullable(),
  taskVersion: z.number().int().positive().nullable(),
  assignmentVersion: z.number().int().positive().nullable(),
  instructionsRevision: z.number().int().positive().nullable(),
  profileRevision: z.number().int().positive().nullable(),
  prompt: z.string().min(1),
  workspace: z.string().min(1).nullable(),
  previousWorkId: z.string().min(1).nullable(),
});

export type TurnRequestInput = z.input<typeof requestSchema>;
export type TurnRequest = z.infer<typeof requestSchema> & {
  sequence: number;
  state: "queued" | "active" | "completed" | "held";
  reason: string | null;
  nextEligibleAt: number | null;
};

/** Durable request identity and fair FIFO order, separate from execution ownership. */
export class SchedulerStore {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      requestKey TEXT NOT NULL UNIQUE,
      workId TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('direct','assignment')),
      taskId TEXT,
      projectId TEXT,
      assignmentId TEXT,
      taskVersion INTEGER,
      assignmentVersion INTEGER,
      instructionsRevision INTEGER,
      profileRevision INTEGER,
      prompt TEXT NOT NULL,
      workspace TEXT,
      previousWorkId TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','active','completed','held')),
      reason TEXT,
      nextEligibleAt INTEGER
    )`);
    const columns = this.db
      .prepare("PRAGMA table_info(turn_requests)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "nextEligibleAt"))
      this.db.exec(
        "ALTER TABLE turn_requests ADD COLUMN nextEligibleAt INTEGER",
      );
  }

  ensure(input: TurnRequestInput): TurnRequest {
    const value = requestSchema.parse(input);
    const existing = this.db
      .prepare("SELECT * FROM turn_requests WHERE requestKey = ? OR workId = ?")
      .get(value.requestKey, value.workId) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      const current = this.parse(existing);
      if (current.previousWorkId !== value.previousWorkId)
        throw new Error(
          "Turn request identity already used with different predecessor",
        );
      if (current.prompt !== value.prompt)
        throw new Error(
          "Turn request identity already used with different prompt",
        );
      if (
        current.taskVersion !== value.taskVersion ||
        current.assignmentVersion !== value.assignmentVersion ||
        current.instructionsRevision !== value.instructionsRevision ||
        current.profileRevision !== value.profileRevision
      )
        throw new Error(
          "Turn request identity already used with different captured revisions",
        );
      if (value.workspace !== null && current.workspace !== value.workspace)
        throw new Error(
          "Turn request identity already used with different workspace",
        );
      if (
        current.requestKey !== value.requestKey ||
        current.workId !== value.workId ||
        current.kind !== value.kind ||
        current.taskId !== value.taskId ||
        current.projectId !== value.projectId ||
        current.assignmentId !== value.assignmentId
      )
        throw new Error(
          "Turn request identity already used with different content",
        );
      return current;
    }
    this.db
      .prepare(`INSERT INTO turn_requests
        (requestKey, workId, kind, taskId, projectId, assignmentId, taskVersion,
          assignmentVersion, instructionsRevision, profileRevision, prompt,
          workspace, previousWorkId, state, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL)`)
      .run(
        value.requestKey,
        value.workId,
        value.kind,
        value.taskId,
        value.projectId,
        value.assignmentId,
        value.taskVersion,
        value.assignmentVersion,
        value.instructionsRevision,
        value.profileRevision,
        value.prompt,
        value.workspace,
        value.previousWorkId,
      );
    return this.byWorkId(value.workId);
  }

  createAssignment(
    input: Omit<
      TurnRequestInput,
      "requestKey" | "workId" | "kind" | "workspace"
    >,
    generation?: { requestKey: string; workId: string },
  ): TurnRequest {
    if (!input.assignmentId)
      throw new Error("Assignment request needs an assignment ID");
    return this.ensure({
      ...input,
      requestKey:
        generation?.requestKey ?? `assignment:${input.assignmentId}:initial`,
      workId: generation?.workId ?? `assignment:${input.assignmentId}:initial`,
      kind: "assignment",
      workspace: null,
    });
  }

  queued(now = Date.now()): TurnRequest[] {
    return this.db
      .prepare(`SELECT * FROM turn_requests WHERE state = 'queued'
        AND (nextEligibleAt IS NULL OR nextEligibleAt <= ?) ORDER BY sequence`)
      .all(now)
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  nextEligibility(now = Date.now()): number | undefined {
    const row = this.db
      .prepare(`SELECT MIN(nextEligibleAt) AS nextEligibleAt
      FROM turn_requests WHERE state = 'queued' AND nextEligibleAt > ?`)
      .get(now) as { nextEligibleAt: number | null };
    return row.nextEligibleAt === null ? undefined : row.nextEligibleAt;
  }

  byWorkId(workId: string): TurnRequest {
    const row = this.db
      .prepare("SELECT * FROM turn_requests WHERE workId = ?")
      .get(workId);
    if (!row) throw new Error("Turn request disappeared");
    return this.parse(row as Record<string, unknown>);
  }

  sequence(workId: string): number {
    const row = this.db
      .prepare("SELECT sequence FROM turn_requests WHERE workId = ?")
      .get(workId) as { sequence: number } | undefined;
    if (!row) throw new Error("Turn request sequence is unavailable");
    return z.number().int().positive().parse(row.sequence);
  }

  list(): TurnRequest[] {
    return this.db
      .prepare("SELECT * FROM turn_requests ORDER BY sequence")
      .all()
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  setWorkspace(workId: string, workspace: string): void {
    const current = this.byWorkId(workId);
    if (current.workspace !== null && current.workspace !== workspace)
      throw new Error("Turn request workspace identity changed");
    this.db
      .prepare("UPDATE turn_requests SET workspace = ? WHERE workId = ?")
      .run(workspace, workId);
  }

  wait(workId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
      )
      .run(reason, workId);
  }

  hold(workId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = ?",
      )
      .run(reason, workId);
  }

  private parse(row: Record<string, unknown>): TurnRequest {
    const value = requestSchema.parse({
      requestKey: row.requestKey,
      workId: row.workId,
      kind: row.kind,
      taskId: row.taskId,
      projectId: row.projectId,
      assignmentId: row.assignmentId,
      taskVersion: row.taskVersion,
      assignmentVersion: row.assignmentVersion,
      instructionsRevision: row.instructionsRevision,
      profileRevision: row.profileRevision,
      prompt: row.prompt,
      workspace: row.workspace,
      previousWorkId: row.previousWorkId,
    });
    const state = z
      .enum(["queued", "active", "completed", "held"])
      .parse(row.state);
    return {
      ...value,
      sequence: z.number().int().positive().parse(row.sequence),
      state,
      reason: z.string().nullable().parse(row.reason),
      nextEligibleAt:
        row.nextEligibleAt === null || row.nextEligibleAt === undefined
          ? null
          : z.number().int().nonnegative().safe().parse(row.nextEligibleAt),
    };
  }
}

/** Serializes scheduler wakeups while execution itself continues independently. */
export class TurnScheduler {
  private stopped = true;
  private draining: Promise<void> | undefined;
  private wakeAgain = false;
  private readonly attempting = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: SchedulerStore,
    private readonly attempt: (request: TurnRequest) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async settle(): Promise<void> {
    await this.draining;
  }

  async wake(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeAgain = true;
    while (!this.stopped) {
      const draining = this.draining ?? this.startDrain();
      await draining;
      if (!this.draining && !this.wakeAgain) return;
    }
  }

  private startDrain(): Promise<void> {
    const draining = this.drain().finally(() => {
      if (this.draining !== draining) return;
      this.draining = undefined;
      if (this.wakeAgain && !this.stopped) this.startDrain();
      else this.scheduleNextWake();
    });
    this.draining = draining;
    return draining;
  }

  private scheduleNextWake(): void {
    if (this.stopped) return;
    const next = this.store.nextEligibility(this.now());
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(next - this.now(), 2_147_483_647));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.wake().catch(() => {});
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    while (this.wakeAgain && !this.stopped) {
      this.wakeAgain = false;
      for (const request of this.store.queued(this.now())) {
        if (this.stopped) return;
        if (this.attempting.has(request.workId)) continue;
        this.attempting.add(request.workId);
        try {
          await this.attempt(request);
        } finally {
          this.attempting.delete(request.workId);
        }
      }
    }
  }
}
