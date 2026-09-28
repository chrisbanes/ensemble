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

/** No method retries an uncertain submission. Callers must create a new work ID. */
export class ExecutionState {
  constructor(private readonly db: Database) {}

  create(workId: string, prompt: string, workspace: string): ExecutionIntent {
    const input = z
      .object({
        workId: z.string().min(1),
        prompt: z.string().min(1),
        workspace: z.string().min(1),
      })
      .parse({ workId, prompt, workspace });
    const existing = this.byWorkId(input.workId);
    if (existing) {
      if (
        existing.prompt !== input.prompt ||
        existing.workspace !== input.workspace
      )
        throw new Error("Work ID already used with different content");
      return existing;
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')",
      )
      .run(id, input.workId, input.prompt, input.workspace);
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

  /** An interrupted service cannot prove a send failed or a writer stopped. */
  holdUnfinishedOnOpen(): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = 'service restarted with unresolved execution' WHERE state IN ('submitting','running')",
      )
      .run();
  }

  begin(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE execution_intents SET state = 'submitting', reason = NULL WHERE id = ? AND state = 'ready' RETURNING id",
        )
        .get(id) !== undefined
    );
  }

  bindThread(id: string, threadId: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'submitting' AND threadId IS NULL",
      )
      .run(threadId, id);
  }

  bindTurn(id: string, turnId: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'running', turnId = ? WHERE id = ? AND state = 'submitting' AND turnId IS NULL",
      )
      .run(turnId, id);
  }

  hold(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state != 'completed'",
      )
      .run(reason, id);
  }

  /** Only a proven refusal before any App Server submission may return to ready. */
  preSubmissionRefusal(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'ready', reason = ? WHERE id = ? AND state = 'submitting' AND threadId IS NULL AND turnId IS NULL",
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
