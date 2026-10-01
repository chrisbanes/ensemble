import { z } from "zod";
import type { Database } from "../core/store.js";
import type { RuntimeConversationEvent } from "./codex.js";

export interface ConversationHistoryBinding {
  workId: string;
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
  conversationRevision: number;
  workRevision: number;
  threadId: string;
  turnId: string;
}

export type ConversationHistoryLifecycle =
  | "started"
  | "streaming"
  | "completed"
  | "omitted";

export type ConversationHistoryOmissionReason =
  | "size-limit"
  | "item-limit"
  | "active-turn-limit"
  | "turn-ended"
  | "missing-text"
  | "redaction-unavailable";

export interface ConversationHistoryEntry extends ConversationHistoryBinding {
  sequence: number;
  itemId: string;
  lifecycle: ConversationHistoryLifecycle;
  text: string | null;
  omissionReason: ConversationHistoryOmissionReason | null;
  deltaBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationHistoryTurnOmission
  extends ConversationHistoryBinding {
  sequence: number;
  reason: "early-buffer-limit";
  createdAt: number;
}

export interface ConversationHistoryAssignmentRead {
  items: ConversationHistoryEntry[];
  turnOmissions: ConversationHistoryTurnOmission[];
  /** Number of older item rows omitted because the returned view is bounded. */
  omittedItemCount: number;
}

const maxHistoryTextBytes = 64 * 1024;
const maxExcludedValues = 128;
const maxExcludedValueLength = 64 * 1024;
const maxExclusionBytes = 256 * 1024;
const maxBufferedEvents = 8192;
const maxBufferedTextBytes = 4 * 1024 * 1024;

const sensitiveAssignment =
  /((?:"?(?:password|token|api[_-]?key|secret)"?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|([^\s,;]+))/gi;
const authorizationHeader = /\b(authorization\s*:\s*)[^\r\n]+/gi;
const bearerToken = /\bbearer\s+[^\s,;]+/gi;
const urlCredentials = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const bindingSchema = z.object({
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
});
const historyEntrySchema = bindingSchema.extend({
  sequence: z.number().int().positive(),
  itemId: z.string().min(1),
  lifecycle: z.enum(["started", "streaming", "completed", "omitted"]),
  text: z.string().nullable(),
  omissionReason: z
    .enum([
      "size-limit",
      "item-limit",
      "active-turn-limit",
      "turn-ended",
      "missing-text",
      "redaction-unavailable",
    ])
    .nullable(),
  deltaBytes: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
});
const turnOmissionSchema = bindingSchema.extend({
  sequence: z.number().int().positive(),
  reason: z.literal("early-buffer-limit"),
  createdAt: z.number().int().nonnegative().safe(),
});

/** Redacts whole completed text before any persistence or history projection. */
export function sanitizeConversationText(
  text: string,
  excludedValues: readonly string[],
): string | undefined {
  if (Buffer.byteLength(text, "utf8") > maxHistoryTextBytes) return undefined;
  if (excludedValues.length > maxExcludedValues) return undefined;
  let totalBytes = 0;
  const values = new Set<string>();
  for (const value of excludedValues) {
    if (
      typeof value !== "string" ||
      value.length > maxExcludedValueLength ||
      Buffer.byteLength(value, "utf8") > maxExcludedValueLength
    )
      return undefined;
    if (value.length === 0) continue;
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > maxExclusionBytes) return undefined;
    values.add(value);
  }

  let result = text
    .replace(authorizationHeader, "$1[redacted]")
    .replace(bearerToken, "Bearer [redacted]")
    .replace(sensitiveAssignment, "$1[redacted]")
    .replace(urlCredentials, "$1[redacted]@");
  for (const value of [...values].sort((a, b) => b.length - a.length))
    result = result.split(value).join("[redacted]");
  return result;
}

/** Additive diagnostic storage; it never participates in execution decisions. */
export class ConversationHistoryStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_history_items (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL,
      instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL,
      conversationRevision INTEGER NOT NULL,
      workRevision INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('started','streaming','completed','omitted')),
      text TEXT,
      omissionReason TEXT,
      deltaBytes INTEGER NOT NULL DEFAULT 0 CHECK(deltaBytes >= 0),
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      CHECK (
        (lifecycle = 'completed' AND text IS NOT NULL AND omissionReason IS NULL) OR
        (lifecycle = 'omitted' AND text IS NULL AND omissionReason IS NOT NULL) OR
        (lifecycle IN ('started','streaming') AND text IS NULL AND omissionReason IS NULL)
      ),
      UNIQUE(workId, threadId, turnId, itemId)
    );
    CREATE INDEX IF NOT EXISTS conversation_history_task_sequence
      ON conversation_history_items(taskId, sequence);
    CREATE TABLE IF NOT EXISTS conversation_history_turn_omissions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL,
      instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL,
      conversationRevision INTEGER NOT NULL,
      workRevision INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason = 'early-buffer-limit'),
      createdAt INTEGER NOT NULL,
      UNIQUE(workId, threadId, turnId)
    );
    CREATE INDEX IF NOT EXISTS conversation_history_turn_omissions_task
      ON conversation_history_turn_omissions(taskId, sequence)`);
  }

  record(
    binding: ConversationHistoryBinding,
    event: RuntimeConversationEvent,
    exclusions: readonly string[],
  ): void {
    const now = this.checkedNow();
    if (event.kind === "started") {
      this.db
        .prepare(`INSERT OR IGNORE INTO conversation_history_items
          (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
            profileRevision, conversationRevision, workRevision, threadId, turnId,
            itemId, lifecycle, text, omissionReason, deltaBytes, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', NULL, NULL, 0, ?, ?)`)
        .run(...this.bindingValues(binding), event.itemId, now, now);
      return;
    }
    if (event.kind === "delta") {
      if (
        !Number.isSafeInteger(event.bytes) ||
        event.bytes <= 0 ||
        event.bytes > maxHistoryTextBytes
      )
        return;
      this.db
        .prepare(`INSERT INTO conversation_history_items
          (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
            profileRevision, conversationRevision, workRevision, threadId, turnId,
            itemId, lifecycle, text, omissionReason, deltaBytes, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'streaming', NULL, NULL, ?, ?, ?)
          ON CONFLICT(workId, threadId, turnId, itemId) DO UPDATE SET
            lifecycle = 'streaming', deltaBytes = MIN(?, deltaBytes + excluded.deltaBytes),
            updatedAt = excluded.updatedAt
          WHERE conversation_history_items.lifecycle IN ('started','streaming')`)
        .run(
          ...this.bindingValues(binding),
          event.itemId,
          event.bytes,
          now,
          now,
          Number.MAX_SAFE_INTEGER,
        );
      return;
    }
    if (event.kind === "omitted") {
      this.recordOmission(binding, event.itemId, event.reason, now);
      return;
    }

    const text = sanitizeConversationText(event.text, exclusions);
    if (text === undefined) {
      this.recordOmission(binding, event.itemId, "redaction-unavailable", now);
      return;
    }
    this.db
      .prepare(`INSERT INTO conversation_history_items
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, workRevision, threadId, turnId,
          itemId, lifecycle, text, omissionReason, deltaBytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, NULL, 0, ?, ?)
        ON CONFLICT(workId, threadId, turnId, itemId) DO UPDATE SET
          lifecycle = 'completed', text = excluded.text, omissionReason = NULL,
          updatedAt = excluded.updatedAt
        WHERE conversation_history_items.lifecycle IN ('started','streaming')`)
      .run(...this.bindingValues(binding), event.itemId, text, now, now);
  }

  recordEarlyBufferLimit(binding: ConversationHistoryBinding): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO conversation_history_turn_omissions
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, workRevision, threadId, turnId,
          reason, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'early-buffer-limit', ?)`)
      .run(...this.bindingValues(binding), this.checkedNow());
  }

  omitItem(
    binding: ConversationHistoryBinding,
    itemId: string,
    reason: ConversationHistoryOmissionReason,
  ): void {
    this.recordOmission(binding, itemId, reason, this.checkedNow());
  }

  omitIncomplete(binding: ConversationHistoryBinding): void {
    this.db
      .prepare(`UPDATE conversation_history_items
        SET lifecycle = 'omitted', text = NULL, omissionReason = 'turn-ended',
          updatedAt = ?
        WHERE workId = ? AND threadId = ? AND turnId = ?
          AND lifecycle IN ('started','streaming')`)
      .run(this.checkedNow(), binding.workId, binding.threadId, binding.turnId);
  }

  readAssignment(
    taskId: string,
    assignmentId: string,
    limit = 200,
    currentExclusions?: readonly string[],
  ): ConversationHistoryAssignmentRead {
    const boundedLimit = z.number().int().positive().max(200).parse(limit);
    const task = z.string().min(1).parse(taskId);
    const assignment = z.string().min(1).parse(assignmentId);
    const rawItems = this.db
      .prepare(`SELECT sequence, workId, taskId, assignmentId, assignmentVersion,
          instructionsRevision, profileRevision, conversationRevision,
          workRevision, threadId, turnId, itemId, lifecycle, text,
          omissionReason, deltaBytes, createdAt, updatedAt
        FROM conversation_history_items WHERE taskId = ? AND assignmentId = ?
        ORDER BY sequence DESC LIMIT ?`)
      .all(task, assignment, boundedLimit)
      .reverse()
      .map((row) => historyEntrySchema.parse(row));
    const rawOmissions = this.db
      .prepare(`SELECT sequence, workId, taskId, assignmentId, assignmentVersion,
          instructionsRevision, profileRevision, conversationRevision,
          workRevision, threadId, turnId, reason, createdAt
        FROM conversation_history_turn_omissions WHERE taskId = ? AND assignmentId = ?
        ORDER BY sequence DESC LIMIT ?`)
      .all(task, assignment, boundedLimit)
      .reverse()
      .map((row) => turnOmissionSchema.parse(row));
    const itemCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM conversation_history_items
          WHERE taskId = ? AND assignmentId = ?`)
        .get(task, assignment) as { count: number }
    ).count;
    const items: ConversationHistoryEntry[] = rawItems.map((item) => {
      if (item.lifecycle !== "completed") return item;
      const text =
        currentExclusions === undefined
          ? undefined
          : sanitizeConversationText(item.text ?? "", currentExclusions);
      return text === undefined
        ? {
            ...item,
            lifecycle: "omitted",
            text: null,
            omissionReason: "redaction-unavailable",
          }
        : { ...item, text };
    });
    return {
      items,
      turnOmissions: rawOmissions,
      omittedItemCount: Math.max(0, itemCount - items.length),
    };
  }

  private recordOmission(
    binding: ConversationHistoryBinding,
    itemId: string,
    reason: ConversationHistoryOmissionReason,
    now: number,
  ) {
    this.db
      .prepare(`INSERT INTO conversation_history_items
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, workRevision, threadId, turnId,
          itemId, lifecycle, text, omissionReason, deltaBytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'omitted', NULL, ?, 0, ?, ?)
        ON CONFLICT(workId, threadId, turnId, itemId) DO UPDATE SET
          lifecycle = 'omitted', text = NULL, omissionReason = excluded.omissionReason,
          updatedAt = excluded.updatedAt
        WHERE conversation_history_items.lifecycle IN ('started','streaming')`)
      .run(...this.bindingValues(binding), itemId, reason, now, now);
  }

  private bindingValues(binding: ConversationHistoryBinding) {
    return [
      binding.workId,
      binding.taskId,
      binding.assignmentId,
      binding.assignmentVersion,
      binding.instructionsRevision,
      binding.profileRevision,
      binding.conversationRevision,
      binding.workRevision,
      binding.threadId,
      binding.turnId,
    ] as const;
  }

  private checkedNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Conversation history clock is invalid");
    return value;
  }
}

interface ConversationHistoryCaptureOptions {
  store: ConversationHistoryStore;
  workId: string;
  threadId: string;
  captureStartExclusions: readonly string[] | undefined;
  currentExclusions: () => readonly string[] | undefined;
}

/** Buffers only while the startTurn response has not bound its exact turn ID. */
export class ConversationHistoryCapture {
  private binding: ConversationHistoryBinding | undefined;
  private readonly buffered: RuntimeConversationEvent[] = [];
  private bufferedTextBytes = 0;
  private exceededBuffer = false;
  private closed = false;

  constructor(private readonly options: ConversationHistoryCaptureOptions) {}

  receive(event: RuntimeConversationEvent): void {
    if (this.closed || event.threadId !== this.options.threadId) return;
    const binding = this.binding;
    if (binding) {
      if (event.turnId === binding.turnId) this.persist(event, binding);
      return;
    }
    if (this.exceededBuffer) return;
    const textBytes =
      event.kind === "completed" ? Buffer.byteLength(event.text, "utf8") : 0;
    if (
      this.buffered.length >= maxBufferedEvents ||
      this.bufferedTextBytes + textBytes > maxBufferedTextBytes
    ) {
      this.buffered.length = 0;
      this.bufferedTextBytes = 0;
      this.exceededBuffer = true;
      return;
    }
    this.buffered.push(event);
    this.bufferedTextBytes += textBytes;
  }

  bind(binding: ConversationHistoryBinding): boolean {
    if (
      this.closed ||
      this.binding ||
      binding.workId !== this.options.workId ||
      binding.threadId !== this.options.threadId
    ) {
      this.discard();
      return false;
    }
    this.binding = binding;
    if (this.exceededBuffer) {
      try {
        this.options.store.recordEarlyBufferLimit(binding);
      } catch {
        // A diagnostic storage failure cannot change execution control.
      }
      this.clearBuffered();
      return true;
    }
    for (const event of this.buffered)
      if (event.turnId === binding.turnId) this.persist(event, binding);
    this.clearBuffered();
    return true;
  }

  finish(): void {
    if (this.binding && !this.closed) {
      try {
        this.options.store.omitIncomplete(this.binding);
      } catch {
        // A diagnostic storage failure cannot change execution control.
      }
    }
    this.discard();
  }

  discard(): void {
    this.closed = true;
    this.clearBuffered();
  }

  private persist(
    event: RuntimeConversationEvent,
    binding: ConversationHistoryBinding,
  ) {
    const start = this.options.captureStartExclusions;
    let current: readonly string[] | undefined;
    try {
      current = this.options.currentExclusions();
    } catch {
      current = undefined;
    }
    if (!start || !current) {
      try {
        if (event.kind === "completed")
          this.options.store.omitItem(
            binding,
            event.itemId,
            "redaction-unavailable",
          );
        else this.options.store.record(binding, event, []);
      } catch {
        // A diagnostic storage failure cannot change execution control.
      }
      return;
    }
    try {
      this.options.store.record(binding, event, [...start, ...current]);
    } catch {
      // A diagnostic storage failure cannot change execution control.
    }
  }

  private clearBuffered() {
    this.buffered.length = 0;
    this.bufferedTextBytes = 0;
    this.exceededBuffer = false;
  }
}
