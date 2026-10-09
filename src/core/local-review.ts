import { randomUUID } from "node:crypto";
import { z } from "zod";
import { materialDigest } from "./delivery.js";
import type {
  RetainedEvidenceStore,
  RetainedReviewAnchorCandidate,
} from "./retained-evidence.js";
import { transaction, type Database } from "./store.js";
import type { InboxEvent } from "./coordination.js";

const uuid = z.string().uuid();
const maxReviewItems = 32;
const maxReviewMessageBytes = 16_000;
const commentSchema = z
  .object({
    commentId: uuid,
    body: z.string().trim().min(1).max(4000),
    // Stored drafts and payloads stay readable; new writes require an anchor.
    anchorGroupIds: z.array(uuid).max(maxReviewItems),
  })
  .strict();
const draftSchema = z
  .object({
    summary: z.string().trim().max(4000),
    comments: z.array(commentSchema).max(maxReviewItems),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const commentIds = draft.comments.map((comment) => comment.commentId);
    const groupIds = draft.comments.flatMap(
      (comment) => comment.anchorGroupIds,
    );
    if (
      new Set(commentIds).size !== commentIds.length ||
      new Set(groupIds).size !== groupIds.length
    )
      ctx.addIssue({
        code: "custom",
        message: "duplicate-local-review-reference",
      });
    if (
      Buffer.byteLength(JSON.stringify(draft), "utf8") > maxReviewMessageBytes
    )
      ctx.addIssue({ code: "custom", message: "local-review-batch-too-large" });
  });
const operationState = z.enum([
  "prepared",
  "recorded",
  "rejected",
  "not-recorded",
]);
const groupState = z.enum(["open", "sealed", "discarded"]);
const frozenPayloadSchema = z
  .object({
    taskId: uuid,
    reviewId: uuid,
    summary: z.string().max(4000),
    comments: z.array(commentSchema).max(maxReviewItems),
    message: z.string().min(1).max(maxReviewMessageBytes),
    groups: z
      .array(
        z
          .object({
            groupId: uuid,
            anchorDraftId: uuid,
            anchorIds: z.array(uuid).min(1).max(maxReviewItems),
            sealOperationId: uuid,
          })
          .strict(),
      )
      .max(maxReviewItems),
  })
  .strict();
/** New drafts bind every comment to exact anchor context. */
const writableDraftSchema = draftSchema.refine(
  (draft) =>
    draft.comments.every((comment) => comment.anchorGroupIds.length > 0),
  { message: "local-review-comment-anchor-required" },
);
type Draft = z.infer<typeof draftSchema>;
type FrozenPayload = z.infer<typeof frozenPayloadSchema>;
type Row = Record<string, string | number | null>;

/** Definitive pre-operation rejection: nothing was recorded or sent. */
/** Definitive pre-operation rejection: a comment has no exact anchor context. */
export class LocalReviewAnchorRequiredError extends Error {
  constructor() {
    super("Local review comment requires an anchor");
    this.name = "LocalReviewAnchorRequiredError";
  }
}

export class LocalReviewBatchTooLargeError extends Error {
  constructor() {
    super("Local review batch exceeds the message limit");
    this.name = "LocalReviewBatchTooLargeError";
  }
}

/** Definitive pre-operation rejection: the recipient is no longer the active lead. */
export class LocalReviewRecipientUnavailableError extends Error {
  constructor() {
    super("Local review recipient must be the accountable lead");
    this.name = "LocalReviewRecipientUnavailableError";
  }
}

const maxExcerptLines = 12;
const maxExcerptCharacters = 800;

/** Exact identity plus a short original excerpt, so the lead never relies on path and line alone. */
function anchorContext(
  {
    anchor,
    bytes,
  }: NonNullable<ReturnType<RetainedEvidenceStore["reviewAnchor"]>>,
  includeExcerpt: boolean,
): string {
  const source = [
    `${anchor.repositoryId ? `repository ${anchor.repositoryId}` : "task workspace"} ${anchor.path}`,
    `lines ${anchor.startLine}-${anchor.endLine}`,
    anchor.context,
    anchor.side === "left" ? "Before" : anchor.side === "right" ? "After" : "",
    anchor.comparisonId ? `comparison ${anchor.comparisonId}` : "",
    anchor.resultId ? `result ${anchor.resultId}` : "",
    anchor.resultItemId ? `item ${anchor.resultItemId}` : "",
    anchor.turnId ? `turn ${anchor.turnId}` : "",
    anchor.sourceSha256 ? `sha256 ${anchor.sourceSha256}` : "",
    `retained anchor ${anchor.anchorId}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!includeExcerpt)
    return `  Context: ${source}\n  Excerpt omitted to fit the message limit; the retained anchor keeps it.`;
  if (anchor.state !== "available" || !bytes)
    return `  Context: ${source}\n  Original excerpt unavailable${anchor.reason ? ` (${anchor.reason})` : ""}.`;
  const text = bytes.toString("utf8");
  const lines = text.replace(/\n$/, "").split("\n");
  let excerpt = lines.slice(0, maxExcerptLines).join("\n");
  if (excerpt.length > maxExcerptCharacters)
    excerpt = excerpt.slice(0, maxExcerptCharacters);
  const shortened = excerpt.length < text.replace(/\n$/, "").length;
  return `  Context: ${source}\n${excerpt
    .split("\n")
    .map((line) => `    | ${line}`)
    .join(
      "\n",
    )}${shortened ? "\n    | … (excerpt shortened; the retained anchor keeps the full context)" : ""}`;
}

export type LocalReviewResponse = {
  operationId: string;
  taskId: string;
  reviewId: string;
  state: z.infer<typeof operationState>;
  eventId?: string | undefined;
  recipientAssignmentId?: string | undefined;
  reason?: string | undefined;
  recordedAt?: number | undefined;
};

export type LocalReviewRequest = {
  key: string;
  taskId: string;
  expectedDraftVersion: number;
  recipientAssignmentId: string;
  expectedAssignmentVersion: number;
};

export type LocalReviewSyncIdentity = {
  projectId: string;
  taskVersion: number;
  visibility: string;
  workspaceVisibility: string;
};

export type LocalReviewEventPort = {
  createMessage(
    taskId: string,
    recipientAssignmentId: string,
    message: string,
  ): InboxEvent;
  saveReceipt(key: string, request: LocalReviewRequest, eventId: string): void;
  readEvent(eventId: string): InboxEvent;
};

function responseSchema() {
  return z
    .object({
      operationId: uuid,
      taskId: uuid,
      reviewId: uuid,
      state: operationState,
      eventId: uuid.optional(),
      recipientAssignmentId: uuid.optional(),
      reason: z.string().max(128).optional(),
      recordedAt: z.number().int().nonnegative().optional(),
    })
    .strict();
}

function asResponse(row: Row): LocalReviewResponse {
  return responseSchema().parse({
    operationId: String(row.operationId),
    taskId: String(row.taskId),
    reviewId: String(row.reviewId),
    state: row.state,
    ...(row.eventId === null ? {} : { eventId: String(row.eventId) }),
    ...(row.recipientAssignmentId === null
      ? {}
      : { recipientAssignmentId: String(row.recipientAssignmentId) }),
    ...(row.reason === null ? {} : { reason: String(row.reason) }),
    // A recorded operation's updatedAt is the moment commitSend recorded it.
    ...(row.state === "recorded" ? { recordedAt: Number(row.updatedAt) } : {}),
  });
}

/** Coordination-owned editable drafts and atomic local-review delivery. */
export class LocalReviewStore {
  constructor(
    private readonly db: Database,
    private readonly retained: RetainedEvidenceStore,
    private readonly events: LocalReviewEventPort,
  ) {}

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS coordination_local_review_drafts (
      taskId TEXT NOT NULL REFERENCES domain_tasks(id), ownerKey TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      state TEXT NOT NULL CHECK(state IN ('editable','sending','sent')),
      draftJson TEXT NOT NULL, accessFingerprint TEXT NOT NULL,
      updatedAt INTEGER NOT NULL CHECK(updatedAt >= 0), PRIMARY KEY(taskId,ownerKey));
    CREATE TABLE IF NOT EXISTS coordination_local_review_groups (
      groupId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      ownerKey TEXT NOT NULL, anchorDraftId TEXT NOT NULL REFERENCES retained_review_anchor_drafts(draftId),
      stageOperationId TEXT NOT NULL UNIQUE, anchorIdsJson TEXT NOT NULL,
      accessFingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','sealed','discarded')),
      submittedContextId TEXT, createdAt INTEGER NOT NULL CHECK(createdAt >= 0));
    CREATE TABLE IF NOT EXISTS coordination_local_review_stage_operations (
      commandKey TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      ownerKey TEXT NOT NULL, requestHash TEXT NOT NULL,
      stageOperationId TEXT NOT NULL UNIQUE, groupId TEXT NOT NULL,
      responseJson TEXT NOT NULL, createdAt INTEGER NOT NULL CHECK(createdAt >= 0));
    CREATE TABLE IF NOT EXISTS coordination_local_review_draft_operations (
      scope TEXT NOT NULL CHECK(scope IN ('save','discard')), commandKey TEXT NOT NULL,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id), ownerKey TEXT NOT NULL,
      requestHash TEXT NOT NULL, responseJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0), PRIMARY KEY(scope,commandKey));
    CREATE TABLE IF NOT EXISTS coordination_local_review_operations (
      operationId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      ownerKey TEXT NOT NULL, requestHash TEXT NOT NULL, requestJson TEXT NOT NULL,
      payloadJson TEXT, payloadHash TEXT, reviewId TEXT NOT NULL UNIQUE,
      accessFingerprint TEXT, recipientAssignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
      draftVersion INTEGER NOT NULL CHECK(draftVersion > 0), eventId TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','recorded','rejected','not-recorded')),
      reason TEXT, createdAt INTEGER NOT NULL CHECK(createdAt >= 0),
      updatedAt INTEGER NOT NULL CHECK(updatedAt >= createdAt));
    CREATE TABLE IF NOT EXISTS coordination_local_review_submissions (
      reviewId TEXT NOT NULL REFERENCES coordination_local_review_operations(reviewId),
      groupId TEXT NOT NULL, submittedContextId TEXT NOT NULL REFERENCES retained_review_anchor_submitted_contexts(submittedContextId),
      anchorIdsJson TEXT NOT NULL, sealOperationId TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(reviewId,groupId),
      UNIQUE(reviewId,position));
    CREATE TABLE IF NOT EXISTS coordination_local_review_losses (
      taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id), count INTEGER NOT NULL CHECK(count > 0),
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0));
    CREATE INDEX IF NOT EXISTS coordination_local_review_drafts_owner
      ON coordination_local_review_drafts(ownerKey,taskId);
    CREATE INDEX IF NOT EXISTS coordination_local_review_operations_task
      ON coordination_local_review_operations(taskId,createdAt);`);
  }

  readDraft(taskId: string, ownerKey: string) {
    uuid.parse(taskId);
    this.owner(ownerKey);
    const row = this.one(
      `SELECT version,state,draftJson,accessFingerprint,updatedAt
      FROM coordination_local_review_drafts WHERE taskId=? AND ownerKey=?`,
      taskId,
      ownerKey,
    );
    const groups = this.db
      .prepare(`SELECT groupId,anchorIdsJson,state,submittedContextId,createdAt
      FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=?
      ORDER BY createdAt,groupId`)
      .all(taskId, ownerKey) as Row[];
    const draft = row
      ? draftSchema.parse(JSON.parse(String(row.draftJson)))
      : draftSchema.parse({ summary: "", comments: [] });
    const referenced = new Set(
      draft.comments.flatMap((comment) => comment.anchorGroupIds),
    );
    // A frozen send stays reconcilable from any tab of the owning session.
    const pending =
      row?.state === "sending"
        ? this.one(
            `SELECT operationId,requestJson FROM coordination_local_review_operations
            WHERE taskId=? AND ownerKey=? AND draftVersion=? AND state='prepared'`,
            taskId,
            ownerKey,
            Number(row.version),
          )
        : undefined;
    return {
      taskId,
      version: row ? Number(row.version) : 0,
      state: row ? String(row.state) : "editable",
      draft,
      pendingOperation: pending
        ? {
            key: String(pending.operationId),
            ...z
              .object({
                recipientAssignmentId: uuid,
                expectedAssignmentVersion: z.number().int().positive(),
              })
              .parse(JSON.parse(String(pending.requestJson))),
          }
        : null,
      accessFingerprint: row ? String(row.accessFingerprint) : null,
      updatedAt: row ? Number(row.updatedAt) : null,
      groups: groups
        .filter((group) => referenced.has(String(group.groupId)))
        .map((group) => ({
          groupId: String(group.groupId),
          anchorIds: z
            .array(uuid)
            .max(maxReviewItems)
            .parse(JSON.parse(String(group.anchorIdsJson))),
          state: groupState.parse(group.state),
          submittedContextId:
            group.submittedContextId === null
              ? null
              : String(group.submittedContextId),
          createdAt: Number(group.createdAt),
        })),
      unsentDraftLost: Boolean(
        this.one(
          "SELECT 1 AS found FROM coordination_local_review_losses WHERE taskId=?",
          taskId,
        ),
      ),
    };
  }

  replayStage(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    requestHash: string;
  }) {
    const row = this.one(
      `SELECT taskId,ownerKey,requestHash,groupId,responseJson
      FROM coordination_local_review_stage_operations WHERE commandKey=?`,
      input.commandKey,
    );
    if (!row) return undefined;
    if (
      row.taskId !== input.taskId ||
      row.ownerKey !== input.ownerKey ||
      row.requestHash !== input.requestHash
    )
      throw new Error(
        "Local review anchor operation ID reused with different material",
      );
    const group = this.one(
      "SELECT state FROM coordination_local_review_groups WHERE groupId=? AND taskId=? AND ownerKey=?",
      String(row.groupId),
      input.taskId,
      input.ownerKey,
    );
    if (group?.state !== "open")
      throw new Error("Local review anchor group is no longer editable");
    return z
      .object({
        groupId: uuid,
        anchorIds: z.array(uuid).max(maxReviewItems),
        draftVersion: z.number().int().positive(),
      })
      .strict()
      .parse(JSON.parse(String(row.responseJson)));
  }

  stageGroup(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    expectedDraftVersion: number;
    requestHash: string;
    stageOperationId: string;
    stageMaterialHash: string;
    candidates: readonly RetainedReviewAnchorCandidate[];
    accessFingerprint: string;
  }) {
    const replay = this.replayStage(input);
    if (replay) return replay;
    return transaction(this.db, () => {
      const prior = this.replayStage(input);
      if (prior) return prior;
      const draftRow = this.one(
        `SELECT version,state,draftJson FROM coordination_local_review_drafts
        WHERE taskId=? AND ownerKey=?`,
        input.taskId,
        input.ownerKey,
      );
      const current = draftRow ? Number(draftRow.version) : 0;
      if (current !== input.expectedDraftVersion)
        throw new Error("Local review draft version conflict");
      if (draftRow && draftRow.state !== "editable")
        throw new Error("Local review draft is frozen");
      const staged = this.retained.stageReviewAnchorDraftWithinTransaction(
        input.taskId,
        input.stageOperationId,
        input.stageMaterialHash,
        input.candidates,
      );
      const now = Date.now();
      const version = current + 1;
      const draftJson = draftRow
        ? String(draftRow.draftJson)
        : JSON.stringify({ summary: "", comments: [] });
      if (draftRow)
        this.db
          .prepare(`UPDATE coordination_local_review_drafts
          SET version=?,accessFingerprint=?,updatedAt=? WHERE taskId=? AND ownerKey=? AND version=? AND state='editable'`)
          .run(
            version,
            input.accessFingerprint,
            now,
            input.taskId,
            input.ownerKey,
            current,
          );
      else
        this.db
          .prepare(`INSERT INTO coordination_local_review_drafts
          (taskId,ownerKey,version,state,draftJson,accessFingerprint,updatedAt)
          VALUES (?,?,?,'editable',?,?,?)`)
          .run(
            input.taskId,
            input.ownerKey,
            version,
            draftJson,
            input.accessFingerprint,
            now,
          );
      const groupId = staged.draftId;
      this.db
        .prepare(`INSERT INTO coordination_local_review_groups
        (groupId,taskId,ownerKey,anchorDraftId,stageOperationId,anchorIdsJson,accessFingerprint,state,createdAt)
        VALUES (?,?,?,?,?,?,?,'open',?)`)
        .run(
          groupId,
          input.taskId,
          input.ownerKey,
          staged.draftId,
          input.stageOperationId,
          JSON.stringify(staged.anchorIds),
          input.accessFingerprint,
          now,
        );
      const result = {
        groupId,
        anchorIds: staged.anchorIds,
        draftVersion: version,
      };
      this.db
        .prepare(`INSERT INTO coordination_local_review_stage_operations
        (commandKey,taskId,ownerKey,requestHash,stageOperationId,groupId,responseJson,createdAt)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          input.commandKey,
          input.taskId,
          input.ownerKey,
          input.requestHash,
          input.stageOperationId,
          groupId,
          JSON.stringify(result),
          now,
        );
      return result;
    });
  }

  saveDraft(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    expectedDraftVersion: number;
    draft: Draft;
    requestHash: string;
    accessFingerprint: string;
  }) {
    const draft = writableDraftSchema.parse(input.draft);
    return transaction(this.db, () => {
      const prior = this.draftOperation("save", input.commandKey);
      if (prior) return this.replayDraftOperation(prior, input);
      const currentRow = this.one(
        `SELECT version,state FROM coordination_local_review_drafts WHERE taskId=? AND ownerKey=?`,
        input.taskId,
        input.ownerKey,
      );
      const current = currentRow ? Number(currentRow.version) : 0;
      if (current !== input.expectedDraftVersion)
        throw new Error("Local review draft version conflict");
      if (currentRow && currentRow.state !== "editable")
        throw new Error("Local review draft is frozen");
      const refs = new Set(
        draft.comments.flatMap((comment) => comment.anchorGroupIds),
      );
      const groups = this.db
        .prepare(`SELECT groupId,anchorDraftId,anchorIdsJson,state
        FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=?`)
        .all(input.taskId, input.ownerKey) as Row[];
      const byId = new Map(
        groups.map((group) => [String(group.groupId), group]),
      );
      for (const groupId of refs) {
        const group = byId.get(groupId);
        if (group?.state !== "open")
          throw new Error("Local review anchor group is unavailable");
        const retained = this.retained.reviewAnchorDraft(
          input.taskId,
          String(group.anchorDraftId),
        );
        const expected = z
          .array(uuid)
          .max(maxReviewItems)
          .parse(JSON.parse(String(group.anchorIdsJson)));
        if (
          retained?.state !== "open" ||
          retained.anchorIds.length !== expected.length ||
          retained.anchorIds.some((id, index) => id !== expected[index])
        )
          throw new Error("Local review anchor group membership changed");
      }
      const next = current + 1;
      const now = Date.now();
      if (currentRow)
        this.db
          .prepare(`UPDATE coordination_local_review_drafts
          SET version=?,draftJson=?,accessFingerprint=?,updatedAt=?
          WHERE taskId=? AND ownerKey=? AND version=? AND state='editable'`)
          .run(
            next,
            JSON.stringify(draft),
            input.accessFingerprint,
            now,
            input.taskId,
            input.ownerKey,
            current,
          );
      else
        this.db
          .prepare(`INSERT INTO coordination_local_review_drafts
          (taskId,ownerKey,version,state,draftJson,accessFingerprint,updatedAt)
          VALUES (?,?,?,'editable',?,?,?)`)
          .run(
            input.taskId,
            input.ownerKey,
            next,
            JSON.stringify(draft),
            input.accessFingerprint,
            now,
          );
      for (const group of groups)
        if (group.state === "open" && !refs.has(String(group.groupId)))
          this.discardGroup(input.taskId, group);
      const result = { version: next, state: "editable" as const };
      this.recordDraftOperation("save", input, result, now);
      return result;
    });
  }

  discardDraft(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    expectedDraftVersion: number;
    requestHash: string;
    accessFingerprint: string;
  }) {
    return transaction(this.db, () => {
      const prior = this.draftOperation("discard", input.commandKey);
      if (prior) return this.replayDraftOperation(prior, input);
      const row = this.one(
        `SELECT version,state FROM coordination_local_review_drafts WHERE taskId=? AND ownerKey=?`,
        input.taskId,
        input.ownerKey,
      );
      const current = row ? Number(row.version) : 0;
      if (current !== input.expectedDraftVersion)
        throw new Error("Local review draft version conflict");
      // A sent draft may be cleared to start the next review; sending stays frozen.
      if (row && row.state !== "editable" && row.state !== "sent")
        throw new Error("Local review draft is frozen");
      const groups = this.db
        .prepare(`SELECT groupId,anchorDraftId,anchorIdsJson,state
        FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=?`)
        .all(input.taskId, input.ownerKey) as Row[];
      for (const group of groups)
        if (group.state === "open") this.discardGroup(input.taskId, group);
      const next = current + 1,
        now = Date.now(),
        empty = JSON.stringify({ summary: "", comments: [] });
      if (row)
        this.db
          .prepare(`UPDATE coordination_local_review_drafts SET version=?,state='editable',draftJson=?,accessFingerprint=?,updatedAt=?
          WHERE taskId=? AND ownerKey=? AND version=?`)
          .run(
            next,
            empty,
            input.accessFingerprint,
            now,
            input.taskId,
            input.ownerKey,
            current,
          );
      else
        this.db
          .prepare(`INSERT INTO coordination_local_review_drafts
          (taskId,ownerKey,version,state,draftJson,accessFingerprint,updatedAt) VALUES (?,?,?,'editable',?,?,?)`)
          .run(
            input.taskId,
            input.ownerKey,
            next,
            empty,
            input.accessFingerprint,
            now,
          );
      const result = { version: next, state: "discarded" as const };
      this.recordDraftOperation("discard", input, result, now);
      return result;
    });
  }

  prepareSend(input: {
    request: LocalReviewRequest;
    ownerKey: string;
    requestHash: string;
  }) {
    const request = input.request;
    const requestJson = JSON.stringify({
      taskId: request.taskId,
      expectedDraftVersion: request.expectedDraftVersion,
      recipientAssignmentId: request.recipientAssignmentId,
      expectedAssignmentVersion: request.expectedAssignmentVersion,
    });
    return transaction(this.db, () => {
      const existing = this.operation(request.key);
      if (existing) {
        if (
          existing.requestHash !== input.requestHash ||
          existing.requestJson !== requestJson
        )
          throw new Error(
            "Local review send key reused with different material",
          );
        return {
          response: asResponse(existing),
          payload:
            existing.payloadJson === null
              ? undefined
              : frozenPayloadSchema.parse(
                  JSON.parse(String(existing.payloadJson)),
                ),
          accessFingerprint:
            existing.accessFingerprint === null
              ? undefined
              : String(existing.accessFingerprint),
        };
      }
      this.owner(input.ownerKey);
      const draftRow = this.one(
        `SELECT version,state,draftJson,accessFingerprint
        FROM coordination_local_review_drafts WHERE taskId=? AND ownerKey=?`,
        request.taskId,
        input.ownerKey,
      );
      if (
        !draftRow ||
        Number(draftRow.version) !== request.expectedDraftVersion
      )
        throw new Error("Local review draft version conflict");
      if (draftRow.state !== "editable")
        throw new Error("Local review draft is frozen");
      // A new send applies the write rule; frozen operations above stay lenient.
      const draft = draftSchema.parse(JSON.parse(String(draftRow.draftJson)));
      if (!writableDraftSchema.safeParse(draft).success)
        throw new LocalReviewAnchorRequiredError();
      if (!draft.summary && draft.comments.length === 0)
        throw new Error("Local review draft is empty");
      this.validateLead(request, true);
      const groupIds = draft.comments.flatMap(
        (comment) => comment.anchorGroupIds,
      );
      const groups = this.db
        .prepare(`SELECT groupId,anchorDraftId,anchorIdsJson,state
        FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=?`)
        .all(request.taskId, input.ownerKey) as Row[];
      const byId = new Map(
        groups.map((group) => [String(group.groupId), group]),
      );
      const used = [...new Set(groupIds)];
      const frozenGroups = used.map((groupId) => {
        const group = byId.get(groupId);
        if (group?.state !== "open")
          throw new Error("Local review anchor group is unavailable");
        const anchorIds = z
          .array(uuid)
          .min(1)
          .max(maxReviewItems)
          .parse(JSON.parse(String(group.anchorIdsJson)));
        const retainedDraft = this.retained.reviewAnchorDraft(
          request.taskId,
          String(group.anchorDraftId),
        );
        if (
          retainedDraft?.state !== "open" ||
          retainedDraft.anchorIds.length !== anchorIds.length ||
          retainedDraft.anchorIds.some((id, index) => id !== anchorIds[index])
        )
          throw new Error("Local review anchor group membership changed");
        return {
          groupId,
          anchorDraftId: String(group.anchorDraftId),
          anchorIds,
          sealOperationId: randomUUID(),
        };
      });
      const render = (includeExcerpt: boolean) =>
        [
          draft.summary ? `Review summary:\n${draft.summary}` : "",
          ...draft.comments.map((comment) => {
            const lines = comment.anchorGroupIds.flatMap((groupId) => {
              const group = frozenGroups.find(
                (item) => item.groupId === groupId,
              );
              return (
                group?.anchorIds.map((anchorId) => {
                  const retainedAnchor = this.retained.reviewAnchor(
                    request.taskId,
                    anchorId,
                  );
                  if (!retainedAnchor)
                    throw new Error("Local review anchor is unavailable");
                  return anchorContext(retainedAnchor, includeExcerpt);
                }) ?? []
              );
            });
            return `Comment:\n${comment.body}${lines.length ? `\n${lines.join("\n")}` : ""}`;
          }),
        ]
          .filter(Boolean)
          .join("\n\n");
      // Excerpts are dropped as a whole before the batch is refused as too large.
      const withExcerpts = render(true);
      const message =
        Buffer.byteLength(withExcerpts, "utf8") <= maxReviewMessageBytes
          ? withExcerpts
          : render(false);
      if (
        !message ||
        Buffer.byteLength(message, "utf8") > maxReviewMessageBytes
      )
        throw new LocalReviewBatchTooLargeError();
      const reviewId = randomUUID();
      const payload = frozenPayloadSchema.parse({
        taskId: request.taskId,
        reviewId,
        summary: draft.summary,
        comments: draft.comments,
        message,
        groups: frozenGroups,
      });
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO coordination_local_review_operations
        (operationId,taskId,ownerKey,requestHash,requestJson,payloadJson,payloadHash,reviewId,
         recipientAssignmentId,assignmentVersion,draftVersion,state,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
        .run(
          request.key,
          request.taskId,
          input.ownerKey,
          input.requestHash,
          requestJson,
          JSON.stringify(payload),
          materialDigest(payload),
          reviewId,
          request.recipientAssignmentId,
          request.expectedAssignmentVersion,
          request.expectedDraftVersion,
          now,
          now,
        );
      this.db
        .prepare(`UPDATE coordination_local_review_operations SET accessFingerprint=?
        WHERE operationId=? AND state='prepared'`)
        .run(String(draftRow.accessFingerprint), request.key);
      this.db
        .prepare(`UPDATE coordination_local_review_drafts SET state='sending',updatedAt=?
        WHERE taskId=? AND ownerKey=? AND version=? AND state='editable'`)
        .run(now, request.taskId, input.ownerKey, request.expectedDraftVersion);
      return {
        response: {
          operationId: request.key,
          taskId: request.taskId,
          reviewId,
          state: "prepared" as const,
        },
        payload,
        accessFingerprint: String(draftRow.accessFingerprint),
      };
    });
  }

  commitSend(input: {
    request: LocalReviewRequest;
    requestHash: string;
    payload: FrozenPayload;
    accessFingerprint: string;
    expectedIdentity: LocalReviewSyncIdentity;
    currentIdentity: () => LocalReviewSyncIdentity;
  }): { response: LocalReviewResponse; event?: InboxEvent } {
    return transaction(this.db, () => {
      const row = this.operation(input.request.key);
      if (!row || row.requestHash !== input.requestHash)
        throw new Error("Local review operation is unavailable");
      if (row.state === "recorded") {
        const response = asResponse(row);
        return { response, event: this.events.readEvent(String(row.eventId)) };
      }
      if (row.state !== "prepared") return { response: asResponse(row) };
      if (
        row.payloadJson === null ||
        row.payloadHash !== materialDigest(input.payload) ||
        String(row.payloadJson) !== JSON.stringify(input.payload)
      )
        throw new Error("Local review frozen payload changed");
      const identity = input.currentIdentity();
      if (
        identity.projectId !== input.expectedIdentity.projectId ||
        identity.taskVersion !== input.expectedIdentity.taskVersion ||
        identity.visibility !== input.expectedIdentity.visibility ||
        identity.workspaceVisibility !==
          input.expectedIdentity.workspaceVisibility
      )
        throw new Error(
          "Local review task or access binding changed before commit",
        );
      if (
        input.payload.taskId !== input.request.taskId ||
        input.payload.reviewId !== row.reviewId
      )
        throw new Error("Local review identity changed");
      this.validateLead(input.request);
      const storedGroups = this.db
        .prepare(`SELECT groupId,ownerKey,anchorDraftId,anchorIdsJson,state
        FROM coordination_local_review_groups WHERE taskId=?`)
        .all(input.request.taskId) as Row[];
      const byId = new Map(
        storedGroups.map((group) => [String(group.groupId), group]),
      );
      const sealed = [];
      for (const [position, group] of input.payload.groups.entries()) {
        const stored = byId.get(group.groupId);
        if (
          stored?.state !== "open" ||
          stored.ownerKey !== row.ownerKey ||
          stored.anchorDraftId !== group.anchorDraftId
        )
          throw new Error("Local review anchor group changed before commit");
        const ids = z
          .array(uuid)
          .min(1)
          .max(maxReviewItems)
          .parse(JSON.parse(String(stored.anchorIdsJson)));
        if (
          ids.length !== group.anchorIds.length ||
          ids.some((id, index) => id !== group.anchorIds[index])
        )
          throw new Error("Local review anchor group membership changed");
        const anchorDraft = this.retained.reviewAnchorDraft(
          input.request.taskId,
          group.anchorDraftId,
        );
        if (
          anchorDraft?.state !== "open" ||
          anchorDraft.anchorIds.length !== ids.length ||
          anchorDraft.anchorIds.some((id, index) => id !== ids[index])
        )
          throw new Error("Local review staged anchor references changed");
        const seal = this.retained.sealReviewAnchorDraftWithinTransaction(
          input.request.taskId,
          group.anchorDraftId,
          group.sealOperationId,
          materialDigest({
            taskId: input.request.taskId,
            draftId: group.anchorDraftId,
            anchorIds: group.anchorIds,
          }),
          group.anchorIds,
        );
        this.db
          .prepare(`INSERT INTO coordination_local_review_submissions
          (reviewId,groupId,submittedContextId,anchorIdsJson,sealOperationId,position)
          VALUES (?,?,?,?,?,?)`)
          .run(
            input.payload.reviewId,
            group.groupId,
            seal.submittedContextId,
            JSON.stringify(group.anchorIds),
            group.sealOperationId,
            position,
          );
        this.db
          .prepare(`UPDATE coordination_local_review_groups SET state='sealed',submittedContextId=?
          WHERE groupId=? AND state='open'`)
          .run(seal.submittedContextId, group.groupId);
        sealed.push(group.groupId);
      }
      const event = this.events.createMessage(
        input.request.taskId,
        input.request.recipientAssignmentId,
        input.payload.message,
      );
      this.events.saveReceipt(input.request.key, input.request, event.eventId);
      const now = Date.now();
      this.db
        .prepare(`UPDATE coordination_local_review_operations
        SET state='recorded',eventId=?,accessFingerprint=?,updatedAt=?
        WHERE operationId=? AND state='prepared'`)
        .run(event.eventId, input.accessFingerprint, now, input.request.key);
      this.db
        .prepare(`UPDATE coordination_local_review_drafts SET state='sent',updatedAt=?
        WHERE taskId=? AND ownerKey=? AND version=? AND state='sending'`)
        .run(
          now,
          input.request.taskId,
          String(row.ownerKey),
          input.request.expectedDraftVersion,
        );
      const latest = this.operation(input.request.key);
      if (!latest) throw new Error("Local review receipt was not persisted");
      return { response: asResponse(latest), event };
    });
  }

  rejectSend(operationId: string, requestHash: string, reason: string) {
    return transaction(this.db, () => {
      const row = this.operation(operationId);
      if (!row) return undefined;
      if (row.requestHash !== requestHash)
        throw new Error("Local review send key reused with different material");
      if (row.state !== "prepared") return asResponse(row);
      const now = Date.now();
      this.db
        .prepare(`UPDATE coordination_local_review_operations SET state='rejected',reason=?,updatedAt=?
        WHERE operationId=? AND state='prepared'`)
        .run(reason.slice(0, 128), now, operationId);
      this.db
        .prepare(`UPDATE coordination_local_review_drafts SET state='editable',updatedAt=?
        WHERE taskId=? AND ownerKey=? AND version=? AND state='sending'`)
        .run(
          now,
          String(row.taskId),
          String(row.ownerKey),
          Number(row.draftVersion),
        );
      const updated = this.operation(operationId);
      return updated ? asResponse(updated) : undefined;
    });
  }

  reconcileSend(input: {
    request: LocalReviewRequest;
    ownerKey: string;
    requestHash: string;
    currentIdentity: LocalReviewSyncIdentity;
    currentAccessFingerprint: string;
  }) {
    const requestJson = JSON.stringify({
      taskId: input.request.taskId,
      expectedDraftVersion: input.request.expectedDraftVersion,
      recipientAssignmentId: input.request.recipientAssignmentId,
      expectedAssignmentVersion: input.request.expectedAssignmentVersion,
    });
    return transaction(this.db, () => {
      const task = this.one(
        "SELECT projectId,version FROM domain_tasks WHERE id=?",
        input.request.taskId,
      );
      if (
        !task ||
        task.projectId !== input.currentIdentity.projectId ||
        Number(task.version) !== input.currentIdentity.taskVersion
      )
        throw new Error(
          "Local review task identity changed before reconciliation",
        );
      const row = this.operation(input.request.key);
      if (
        row &&
        (row.requestHash !== input.requestHash ||
          row.requestJson !== requestJson)
      )
        throw new Error(
          "Local review reconcile key reused with different material",
        );
      if (row && row.state !== "prepared") return asResponse(row);
      const lead = this.leadIdentity(
        input.request.taskId,
        input.request.recipientAssignmentId,
      );
      const exactLead =
        lead && lead.version === input.request.expectedAssignmentVersion;
      const samePolicy =
        !row || row.accessFingerprint === input.currentAccessFingerprint;
      const state = exactLead && samePolicy ? "not-recorded" : "rejected";
      const reason = !exactLead
        ? "recipient-changed"
        : samePolicy
          ? undefined
          : "policy-changed";
      const now = Date.now();
      if (!row) {
        this.db
          .prepare(`INSERT INTO coordination_local_review_operations
          (operationId,taskId,ownerKey,requestHash,requestJson,payloadJson,payloadHash,reviewId,
           accessFingerprint,recipientAssignmentId,assignmentVersion,draftVersion,state,reason,createdAt,updatedAt)
          VALUES (?,?,?,?,?,NULL,NULL,?,NULL,?,?,?,?,?,?,?)`)
          .run(
            input.request.key,
            input.request.taskId,
            input.ownerKey,
            input.requestHash,
            requestJson,
            randomUUID(),
            input.request.recipientAssignmentId,
            input.request.expectedAssignmentVersion,
            Math.max(1, input.request.expectedDraftVersion),
            state,
            reason ?? null,
            now,
            now,
          );
      } else {
        this.db
          .prepare(`UPDATE coordination_local_review_operations SET state=?,reason=?,updatedAt=?
          WHERE operationId=? AND state='prepared'`)
          .run(state, reason ?? null, now, input.request.key);
        this.db
          .prepare(`UPDATE coordination_local_review_drafts SET state='editable',updatedAt=?
          WHERE taskId=? AND ownerKey=? AND version=? AND state='sending'`)
          .run(
            now,
            String(row.taskId),
            String(row.ownerKey),
            Number(row.draftVersion),
          );
        if (row.payloadJson !== null)
          this.releaseUnreferencedPreparedGroups(
            String(row.taskId),
            String(row.ownerKey),
            frozenPayloadSchema.parse(JSON.parse(String(row.payloadJson))),
          );
      }
      const updated = this.operation(input.request.key);
      if (!updated) throw new Error("Local review fence was not persisted");
      return asResponse(updated);
    });
  }

  /** Recorded reviews only, newest first; unsent operations are never listed. */
  listRecorded(taskId: string, limit = 50) {
    uuid.parse(taskId);
    return (
      this.db
        .prepare(`SELECT operationId,reviewId,recipientAssignmentId,eventId,updatedAt
        FROM coordination_local_review_operations WHERE taskId=? AND state='recorded'
        ORDER BY updatedAt DESC,rowid DESC LIMIT ?`)
        .all(taskId, limit) as Row[]
    ).map((row) => ({
      operationId: String(row.operationId),
      reviewId: String(row.reviewId),
      recipientAssignmentId: String(row.recipientAssignmentId),
      eventId: String(row.eventId),
      recordedAt: Number(row.updatedAt),
    }));
  }

  operationMaterial(operationId: string) {
    const row = this.operation(operationId);
    if (!row) return undefined;
    return {
      response: asResponse(row),
      payload:
        row.payloadJson === null
          ? undefined
          : frozenPayloadSchema.parse(JSON.parse(String(row.payloadJson))),
      accessFingerprint:
        row.accessFingerprint === null
          ? undefined
          : String(row.accessFingerprint),
      requestHash: String(row.requestHash),
      ownerKey: String(row.ownerKey),
    };
  }

  /** Anchor IDs of the owner's named groups; unknown groups contribute none. */
  groupAnchorIds(
    taskId: string,
    ownerKey: string,
    groupIds: readonly string[],
  ) {
    if (groupIds.length === 0) return [];
    const wanted = new Set(groupIds);
    return (
      this.db
        .prepare(`SELECT groupId,anchorIdsJson FROM coordination_local_review_groups
        WHERE taskId=? AND ownerKey=?`)
        .all(taskId, ownerKey) as Row[]
    )
      .filter((row) => wanted.has(String(row.groupId)))
      .flatMap((row) =>
        z
          .array(uuid)
          .max(maxReviewItems)
          .parse(JSON.parse(String(row.anchorIdsJson))),
      );
  }

  /** Re-binds an editable draft whose content was rechecked under current access. */
  refreshAccessFingerprint(
    taskId: string,
    ownerKey: string,
    version: number,
    accessFingerprint: string,
  ) {
    this.db
      .prepare(`UPDATE coordination_local_review_drafts SET accessFingerprint=?
      WHERE taskId=? AND ownerKey=? AND version=? AND state='editable'`)
      .run(accessFingerprint, taskId, ownerKey, version);
  }

  purgeEditableDrafts(ownerKey?: string, taskId?: string): number {
    return transaction(this.db, () => {
      const drafts = this.db
        .prepare(`SELECT taskId,ownerKey,draftJson FROM coordination_local_review_drafts
        WHERE state IN ('editable','sending')${ownerKey === undefined ? "" : " AND ownerKey=?"}${taskId === undefined ? "" : " AND taskId=?"}`)
        .all(
          ...[
            ...(ownerKey === undefined ? [] : [ownerKey]),
            ...(taskId === undefined ? [] : [taskId]),
          ],
        ) as Row[];
      const protectedGroups = new Set<string>();
      const prepared = this.db
        .prepare(`SELECT payloadJson FROM coordination_local_review_operations
        WHERE state='prepared' AND payloadJson IS NOT NULL`)
        .all() as Row[];
      for (const row of prepared) {
        const payload = frozenPayloadSchema.safeParse(
          JSON.parse(String(row.payloadJson)),
        );
        if (payload.success)
          for (const group of payload.data.groups)
            protectedGroups.add(group.groupId);
      }
      const affected = new Map<string, number>();
      for (const draft of drafts) {
        const taskId = String(draft.taskId),
          currentOwner = String(draft.ownerKey);
        const groups = this.db
          .prepare(`SELECT groupId,anchorDraftId,anchorIdsJson,state
          FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=?`)
          .all(taskId, currentOwner) as Row[];
        const content = draftSchema.safeParse(
          JSON.parse(String(draft.draftJson)),
        );
        // Only drafts with text or anchors are reported as lost.
        const hadContent =
          !content.success ||
          content.data.summary !== "" ||
          content.data.comments.length > 0 ||
          groups.some((group) => group.state === "open");
        for (const group of groups)
          if (
            group.state === "open" &&
            !protectedGroups.has(String(group.groupId))
          )
            this.discardGroup(taskId, group);
        if (hadContent) affected.set(taskId, (affected.get(taskId) ?? 0) + 1);
        this.db
          .prepare(
            `DELETE FROM coordination_local_review_drafts WHERE taskId=? AND ownerKey=?`,
          )
          .run(taskId, currentOwner);
      }
      for (const [taskId, count] of affected) {
        this.db
          .prepare(`INSERT INTO coordination_local_review_losses(taskId,count,createdAt)
          VALUES (?,?,?) ON CONFLICT(taskId) DO UPDATE SET count=coordination_local_review_losses.count+excluded.count,createdAt=excluded.createdAt`)
          .run(taskId, count, Date.now());
      }
      return drafts.length;
    });
  }

  private validateLead(
    request: LocalReviewRequest,
    beforeOperation = false,
  ): void {
    const lead = this.leadIdentity(
      request.taskId,
      request.recipientAssignmentId,
    );
    // Only before the operation row exists is this a definitive no-delivery rejection.
    if (!lead)
      throw beforeOperation
        ? new LocalReviewRecipientUnavailableError()
        : new Error("Local review recipient must be the accountable lead");
    if (lead.version !== request.expectedAssignmentVersion)
      throw new Error("Local review recipient assignment version conflict");
  }

  private leadIdentity(taskId: string, assignmentId: string) {
    const row = this.one(
      `SELECT a.id,a.taskId,a.version,a.state,b.projectId
      FROM domain_assignments a JOIN task_lead_bindings b ON b.taskId=a.taskId AND b.assignmentId=a.id
      WHERE a.id=? AND a.taskId=?`,
      assignmentId,
      taskId,
    );
    if (!row || (row.state !== "pending" && row.state !== "running"))
      return undefined;
    return { version: Number(row.version), projectId: String(row.projectId) };
  }

  private operation(operationId: string) {
    return this.one(
      `SELECT operationId,taskId,ownerKey,requestHash,requestJson,payloadJson,payloadHash,
      reviewId,accessFingerprint,recipientAssignmentId,assignmentVersion,draftVersion,eventId,state,reason,updatedAt
      FROM coordination_local_review_operations WHERE operationId=?`,
      operationId,
    );
  }

  private discardGroup(taskId: string, group: Row) {
    const draftId = String(group.anchorDraftId);
    this.retained.discardReviewAnchorDraftWithinTransaction(
      taskId,
      draftId,
      randomUUID(),
      materialDigest({ taskId, draftId }),
    );
    this.db
      .prepare(
        "UPDATE coordination_local_review_groups SET state='discarded' WHERE groupId=? AND state='open'",
      )
      .run(String(group.groupId));
  }

  private releaseUnreferencedPreparedGroups(
    taskId: string,
    ownerKey: string,
    payload: FrozenPayload,
  ): void {
    const draft = this.one(
      `SELECT draftJson FROM coordination_local_review_drafts
      WHERE taskId=? AND ownerKey=?`,
      taskId,
      ownerKey,
    );
    const referenced = new Set(
      draft
        ? draftSchema
            .parse(JSON.parse(String(draft.draftJson)))
            .comments.flatMap((comment) => comment.anchorGroupIds)
        : [],
    );
    for (const frozen of payload.groups) {
      if (referenced.has(frozen.groupId)) continue;
      const group = this.one(
        `SELECT groupId,anchorDraftId,anchorIdsJson,state
        FROM coordination_local_review_groups WHERE taskId=? AND ownerKey=? AND groupId=?`,
        taskId,
        ownerKey,
        frozen.groupId,
      );
      if (group?.state === "open") this.discardGroup(taskId, group);
    }
  }

  private draftOperation(scope: "save" | "discard", commandKey: string) {
    return this.one(
      `SELECT taskId,ownerKey,requestHash,responseJson FROM coordination_local_review_draft_operations
      WHERE scope=? AND commandKey=?`,
      scope,
      commandKey,
    );
  }

  private replayDraftOperation(
    prior: Row,
    input: { taskId: string; ownerKey: string; requestHash: string },
  ) {
    if (
      prior.taskId !== input.taskId ||
      prior.ownerKey !== input.ownerKey ||
      prior.requestHash !== input.requestHash
    )
      throw new Error("Local review draft key reused with different material");
    return z
      .object({
        version: z.number().int().positive(),
        state: z.enum(["editable", "discarded"]),
      })
      .strict()
      .parse(JSON.parse(String(prior.responseJson)));
  }

  private recordDraftOperation(
    scope: "save" | "discard",
    input: {
      commandKey: string;
      taskId: string;
      ownerKey: string;
      requestHash: string;
    },
    result: unknown,
    now: number,
  ) {
    // Saving or clearing a draft acknowledges any earlier lost-draft notice.
    this.db
      .prepare("DELETE FROM coordination_local_review_losses WHERE taskId=?")
      .run(input.taskId);
    this.db
      .prepare(`INSERT INTO coordination_local_review_draft_operations
      (scope,commandKey,taskId,ownerKey,requestHash,responseJson,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(
        scope,
        input.commandKey,
        input.taskId,
        input.ownerKey,
        input.requestHash,
        JSON.stringify(result),
        now,
      );
  }

  private owner(ownerKey: string) {
    z.string().min(32).max(128).parse(ownerKey);
  }

  private one(
    sql: string,
    ...values: (string | number | null)[]
  ): Row | undefined {
    const row = this.db.prepare(sql).get(...values) as Row | undefined;
    return row ? { ...row } : undefined;
  }
}
