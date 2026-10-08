import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Database } from "./store.js";

export const retainedEvidenceLimits = Object.freeze({
  maxTextBytes: 1024 * 1024,
  maxImageOrPdfBytes: 8 * 1024 * 1024,
  maxDiffBytes: 1024 * 1024,
  maxFilesPerResult: 32,
  maxResultBytes: 32 * 1024 * 1024,
  maxTaskResultBytes: 128 * 1024 * 1024,
  maxInstallationBytes: 512 * 1024 * 1024,
  maxReviewAnchorBytes: 256 * 1024,
  maxReviewAnchorsPerTask: 128,
  maxTaskReviewBytes: 16 * 1024 * 1024,
});

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
const retainedMime = z.union([
  z.enum([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/vnd.ensemble.workspace-diff+json",
  ]),
  z
    .string()
    .max(128)
    .regex(/^(text\/[a-z0-9.+-]+|application\/(json|sql)); charset=utf-8$/),
]);
const identitySchema = z
  .object({
    taskId: uuid,
    // taskVersion is the request's admitted revision. Capture safety uses the
    // separately revalidated revision observed while reading workspace bytes.
    taskVersion: revision,
    captureTaskVersion: revision,
    assignmentId: uuid,
    assignmentVersion: revision,
    workId: z.string().min(1).max(512),
    workRevision: revision,
    requestSequence: revision,
    conversationRevision: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    profileId: uuid,
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
  })
  .strict();

const sourceObservationSchema = z
  .object({
    comparisonId: uuid.nullable(),
    captureState: z.enum(["missing", "pending", "unsettled", "finished"]),
    outcome: z.enum(["running", "completed", "failed", "unknown"]).nullable(),
    observedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

const scalar = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.null(),
]);
const itemSchema = z
  .object({
    itemId: uuid,
    kind: z.enum(["file", "diff"]),
    state: z.enum(["available", "gap"]),
    reason: z
      .enum([
        "excluded",
        "unsafe-path",
        "too-large",
        "binary",
        "unsupported",
        "missing",
        "changing",
        "unavailable",
        "comparison-unavailable",
        "comparison-unsettled",
        "binding-changed",
        "quota",
        "source-mismatch",
        "invalid-content",
        "too-many-links",
        "no-change",
      ])
      .optional(),
    source: z.enum(["artifact-file", "change-file", "observed-diff"]),
    sourceIndex: z.number().int().nonnegative(),
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048).nullable(),
    originRoot: z.string().min(1).max(4096).nullable(),
    artifactId: uuid.optional(),
    mime: retainedMime.optional(),
    sha256: hash.optional(),
    size: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    observedAt: z.number().int().nonnegative().nullable(),
    provenance: z.record(z.string().max(80), scalar),
    bytes: z.instanceof(Uint8Array).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.state === "available") {
      if (
        !item.bytes ||
        !item.mime ||
        !item.sha256 ||
        !item.path ||
        !item.originRoot
      )
        ctx.addIssue({
          code: "custom",
          message: "available-evidence-is-incomplete",
        });
      else {
        if (item.size !== item.bytes.byteLength)
          ctx.addIssue({ code: "custom", message: "evidence-size-mismatch" });
        if (
          createHash("sha256").update(item.bytes).digest("hex") !== item.sha256
        )
          ctx.addIssue({ code: "custom", message: "evidence-hash-mismatch" });
        const limit =
          item.kind === "diff"
            ? retainedEvidenceLimits.maxDiffBytes
            : item.mime?.startsWith("text/") ||
                item.mime === "application/json; charset=utf-8" ||
                item.mime === "application/sql; charset=utf-8"
              ? retainedEvidenceLimits.maxTextBytes
              : retainedEvidenceLimits.maxImageOrPdfBytes;
        if (item.size > limit)
          ctx.addIssue({
            code: "custom",
            message: "evidence-exceeds-item-limit",
          });
      }
      if (item.reason !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "available-evidence-has-gap-reason",
        });
    } else {
      if (item.bytes || item.mime || item.sha256 || item.size !== 0)
        ctx.addIssue({ code: "custom", message: "gap-evidence-has-bytes" });
      if (!item.reason)
        ctx.addIssue({ code: "custom", message: "gap-evidence-needs-reason" });
    }
  });

const candidateSchema = z
  .object({
    version: z.literal(1),
    evidenceId: uuid,
    capturedAt: z.number().int().nonnegative(),
    identity: identitySchema,
    sourceObservation: sourceObservationSchema,
    items: z.array(itemSchema).max(320),
  })
  .strict();

const reviewAnchorCandidateSchema = z
  .object({
    anchorId: uuid,
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    originRoot: z.string().min(1).max(4096).optional(),
    sourceKind: z.enum([
      "workspace-file",
      "comparison-side",
      "result-evidence",
    ]),
    context: z.enum(["workspace", "branch", "uncommitted", "turn", "result"]),
    comparisonId: uuid.optional(),
    resultId: uuid.optional(),
    resultItemId: uuid.optional(),
    workId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    side: z.enum(["file", "left", "right"]),
    startLine: revision,
    endLine: revision,
    sourceSha256: hash.optional(),
    claimedSha256: hash.optional(),
    excerptSha256: hash.optional(),
    byteStart: z.number().int().nonnegative().safe().optional(),
    byteEnd: z.number().int().nonnegative().safe().optional(),
    mime: z.string().min(1).max(128).optional(),
    state: z.enum(["available", "gap"]),
    reason: z
      .enum([
        "missing",
        "unavailable",
        "comparison-unavailable",
        "comparison-unsettled",
        "quota",
      ])
      .optional(),
    size: z.number().int().nonnegative().safe(),
    capturedAt: z.number().int().nonnegative().safe(),
    observedAt: z.number().int().nonnegative().safe().nullable(),
    bytes: z.instanceof(Uint8Array).optional(),
  })
  .strict()
  .superRefine((anchor, ctx) => {
    if (anchor.endLine < anchor.startLine)
      ctx.addIssue({ code: "custom", message: "invalid-anchor-range" });
    if (
      (anchor.sourceKind === "workspace-file" &&
        anchor.context !== "workspace") ||
      (anchor.sourceKind === "comparison-side" &&
        !["branch", "uncommitted", "turn"].includes(anchor.context)) ||
      (anchor.sourceKind === "result-evidence" && anchor.context !== "result")
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-source-context-mismatch",
      });
    if (
      (anchor.sourceKind === "comparison-side") !==
      (anchor.comparisonId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-comparison-identity-mismatch",
      });
    if (
      (anchor.context === "result" && anchor.resultId === undefined) ||
      (anchor.sourceKind === "result-evidence" &&
        anchor.resultItemId === undefined) ||
      (anchor.sourceKind !== "result-evidence" &&
        anchor.resultItemId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-result-identity-mismatch",
      });
    if (anchor.state === "available") {
      if (
        !anchor.bytes ||
        !anchor.sourceSha256 ||
        !anchor.excerptSha256 ||
        anchor.byteStart === undefined ||
        anchor.byteEnd === undefined ||
        !anchor.originRoot ||
        !anchor.mime ||
        anchor.reason !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "available-anchor-is-incomplete",
        });
      else {
        if (anchor.size !== anchor.bytes.byteLength)
          ctx.addIssue({ code: "custom", message: "anchor-size-mismatch" });
        if (
          createHash("sha256").update(anchor.bytes).digest("hex") !==
          anchor.excerptSha256
        )
          ctx.addIssue({ code: "custom", message: "anchor-hash-mismatch" });
      }
    } else if (
      anchor.bytes ||
      anchor.sourceSha256 !== undefined ||
      anchor.excerptSha256 !== undefined ||
      anchor.byteStart !== undefined ||
      anchor.byteEnd !== undefined ||
      anchor.originRoot !== undefined ||
      anchor.mime !== undefined ||
      anchor.size !== 0 ||
      anchor.reason === undefined
    )
      ctx.addIssue({ code: "custom", message: "gap-anchor-is-invalid" });
  });

const retainedReviewAnchorResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    state: z.literal("staged"),
    anchorIds: z.array(uuid).max(32),
    anchorStates: z
      .array(
        z
          .object({
            anchorId: uuid,
            state: z.enum(["available", "gap"]),
            reason: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const retainedReviewAnchorSealResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    submittedContextId: uuid,
    state: z.literal("sealed"),
    linkState: z.literal("durable"),
    deliveryState: z.literal("not-attempted"),
    receiptState: z.literal("none"),
    anchorIds: z.array(uuid).max(32),
  })
  .strict();
const retainedReviewAnchorDiscardResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    state: z.literal("discarded"),
    submittedContextPreserved: z.boolean(),
  })
  .strict();
const reviewAnchorOperationSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    kind: z.enum(["stage", "seal", "discard"]),
    materialHash: hash,
    responseJson: z.string().max(64 * 1024),
  })
  .strict();

export type RetainedReviewAnchorCandidate = z.input<
  typeof reviewAnchorCandidateSchema
>;
export type RetainedReviewAnchorStageResponse = z.infer<
  typeof retainedReviewAnchorResponseSchema
>;
export type RetainedReviewAnchorSealResponse = z.infer<
  typeof retainedReviewAnchorSealResponseSchema
>;
export type RetainedReviewAnchorDiscardResponse = z.infer<
  typeof retainedReviewAnchorDiscardResponseSchema
>;
export type RetainedReviewAnchorState = "available" | "gap";
export interface RetainedReviewAnchorRecord {
  anchorId: string;
  taskId: string;
  repositoryId: string | null;
  path: string;
  sourceKind: "workspace-file" | "comparison-side" | "result-evidence";
  context: "workspace" | "branch" | "uncommitted" | "turn" | "result";
  comparisonId?: string;
  resultId?: string;
  resultItemId?: string;
  workId?: string;
  threadId?: string;
  turnId?: string;
  side: "file" | "left" | "right";
  startLine: number;
  endLine: number;
  sourceSha256?: string;
  claimedSha256?: string;
  excerptSha256?: string;
  byteStart?: number;
  byteEnd?: number;
  mime?: string;
  state: RetainedReviewAnchorState;
  reason?:
    | "missing"
    | "unavailable"
    | "comparison-unavailable"
    | "comparison-unsettled"
    | "quota";
  size: number;
  capturedAt: number;
  observedAt: number | null;
}
export interface RetainedReviewAnchorContent {
  anchor: RetainedReviewAnchorRecord;
  bytes?: Buffer;
  /** Internal only: used to reapply current path policy after workspace cleanup. */
  originRoot?: string;
}

export interface RetainedReviewAnchorDraft {
  draftId: string;
  taskId: string;
  state: "open" | "sealed" | "discarded";
  submittedContextId: string | null;
  createdAt: number;
  updatedAt: number;
  anchorIds: string[];
}

export interface RetainedReviewAnchorSubmittedContext {
  submittedContextId: string;
  taskId: string;
  createdAt: number;
  anchorIds: string[];
}

export const retainedEvidenceItemRecordSchema = z
  .object({
    itemId: uuid,
    kind: z.enum(["file", "diff"]),
    state: z.enum(["available", "gap"]),
    reason: itemSchema.shape.reason,
    source: itemSchema.shape.source,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048).nullable(),
    artifactId: uuid.optional(),
    mime: retainedMime.optional(),
    sha256: hash.optional(),
    size: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    observedAt: z.number().int().nonnegative().nullable(),
    provenance: z.record(z.string().max(80), scalar),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.state === "available") {
      if (!item.path || !item.mime || !item.sha256 || item.reason !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "available-evidence-is-incomplete",
        });
    } else if (
      item.path !== null ||
      item.mime !== undefined ||
      item.sha256 !== undefined ||
      item.size !== 0 ||
      item.reason === undefined
    )
      ctx.addIssue({ code: "custom", message: "gap-evidence-is-invalid" });
  });

export type RetainedEvidenceIdentity = z.infer<typeof identitySchema>;
export type RetainedEvidenceSourceObservation = z.infer<
  typeof sourceObservationSchema
>;
export type RetainedEvidenceCandidate = z.input<typeof candidateSchema>;
export type RetainedEvidenceItemInput = z.input<typeof itemSchema>;

export interface RetainedEvidenceItemRecord {
  itemId: string;
  kind: "file" | "diff";
  state: "available" | "gap";
  reason?: z.infer<typeof itemSchema.shape.reason>;
  source: "artifact-file" | "change-file" | "observed-diff";
  repositoryId: string | null;
  path: string | null;
  artifactId?: string;
  mime?: string;
  sha256?: string;
  size: number;
  capturedAt: number;
  observedAt: number | null;
  provenance: Record<string, string | number | boolean | null>;
}

export interface RetainedEvidenceManifest {
  version: 1;
  resultId: string;
  evidenceId: string;
  taskId: string;
  taskVersion: number;
  captureTaskVersion: number;
  assignmentId: string;
  assignmentVersion: number;
  workId: string;
  workRevision: number;
  requestSequence: number;
  conversationRevision: number;
  instructionsRevision: number;
  profileRevision: number;
  profileId: string;
  threadId: string;
  turnId: string;
  capturedAt: number;
  sourceObservation: RetainedEvidenceSourceObservation;
  state: "empty" | "available" | "partial" | "gap";
  payloadBytes: number;
  items: RetainedEvidenceItemRecord[];
}

export interface RetainedEvidenceItemContent {
  manifest: RetainedEvidenceManifest;
  item: RetainedEvidenceItemRecord;
  bytes: Buffer;
  originRoot: string;
}

type ResultOwner = {
  resultId: string;
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  workId: string;
  workRevision: number;
};

type Row = Record<string, string | number | Uint8Array | null>;

export const retainedEvidenceManifestSchema = z
  .object({
    version: z.literal(1),
    resultId: uuid,
    evidenceId: uuid,
    taskId: uuid,
    taskVersion: revision,
    captureTaskVersion: revision.optional(),
    assignmentId: uuid,
    assignmentVersion: revision,
    workId: z.string().min(1).max(512),
    workRevision: revision,
    requestSequence: revision,
    conversationRevision: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    profileId: uuid,
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    capturedAt: z.number().int().nonnegative(),
    sourceObservation: sourceObservationSchema,
    state: z.enum(["empty", "available", "partial", "gap"]),
    payloadBytes: z.number().int().nonnegative(),
    items: z.array(retainedEvidenceItemRecordSchema),
  })
  .strict();

function parseManifest(value: unknown): RetainedEvidenceManifest {
  const parsed = retainedEvidenceManifestSchema.parse(value);
  return {
    ...parsed,
    // Older accepted callbacks required admitted and current task versions to
    // match, so their single stored version is an exact value for both fields.
    captureTaskVersion: parsed.captureTaskVersion ?? parsed.taskVersion,
  } as RetainedEvidenceManifest;
}

function rowItem(row: Row): RetainedEvidenceItemRecord {
  return {
    itemId: String(row.itemId),
    kind: row.kind as "file" | "diff",
    state: row.state as "available" | "gap",
    ...(row.reason === null
      ? {}
      : { reason: String(row.reason) as RetainedEvidenceItemRecord["reason"] }),
    source: row.source as RetainedEvidenceItemRecord["source"],
    repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
    path: row.path === null ? null : String(row.path),
    ...(row.artifactId === null ? {} : { artifactId: String(row.artifactId) }),
    ...(row.mime === null ? {} : { mime: String(row.mime) }),
    ...(row.sha256 === null ? {} : { sha256: String(row.sha256) }),
    size: Number(row.size),
    capturedAt: Number(row.capturedAt),
    observedAt: row.observedAt === null ? null : Number(row.observedAt),
    provenance: JSON.parse(String(row.provenanceJson)) as Record<
      string,
      string | number | boolean | null
    >,
  };
}

function identityMatches(
  expected: RetainedEvidenceIdentity,
  actual: RetainedEvidenceIdentity,
): boolean {
  return (
    expected.taskId === actual.taskId &&
    expected.taskVersion === actual.taskVersion &&
    expected.captureTaskVersion === actual.captureTaskVersion &&
    expected.assignmentId === actual.assignmentId &&
    expected.assignmentVersion === actual.assignmentVersion &&
    expected.workId === actual.workId &&
    expected.workRevision === actual.workRevision &&
    expected.requestSequence === actual.requestSequence &&
    expected.conversationRevision === actual.conversationRevision &&
    expected.instructionsRevision === actual.instructionsRevision &&
    expected.profileRevision === actual.profileRevision &&
    expected.profileId === actual.profileId &&
    expected.threadId === actual.threadId &&
    expected.turnId === actual.turnId
  );
}

function asGap(
  item: z.infer<typeof itemSchema>,
  reason: z.infer<typeof itemSchema.shape.reason>,
) {
  return {
    itemId: item.itemId,
    kind: item.kind,
    state: "gap" as const,
    reason,
    source: item.source,
    sourceIndex: item.sourceIndex,
    repositoryId: item.repositoryId,
    path: null,
    originRoot: null,
    ...(item.artifactId ? { artifactId: item.artifactId } : {}),
    size: 0,
    capturedAt: item.capturedAt,
    observedAt: item.observedAt,
    provenance: item.provenance,
  };
}

function gapReviewAnchor(
  candidate: z.infer<typeof reviewAnchorCandidateSchema>,
  reason: NonNullable<z.infer<typeof reviewAnchorCandidateSchema>["reason"]>,
) {
  const {
    bytes: _bytes,
    sourceSha256,
    excerptSha256: _excerptSha256,
    byteStart: _byteStart,
    byteEnd: _byteEnd,
    mime: _mime,
    originRoot: _originRoot,
    ...rest
  } = candidate;
  return reviewAnchorCandidateSchema.parse({
    ...rest,
    ...(sourceSha256 ? { claimedSha256: sourceSha256 } : {}),
    state: "gap",
    reason,
    size: 0,
  });
}

/** Durable bounded evidence. Write methods ending in WithinTransaction require the caller's transaction. */
export class RetainedEvidenceStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS retained_result_evidence (
      resultId TEXT PRIMARY KEY REFERENCES coordination_results(resultId) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
      assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
      workId TEXT NOT NULL,
      workRevision INTEGER NOT NULL CHECK(workRevision > 0),
      requestSequence INTEGER NOT NULL CHECK(requestSequence > 0),
      conversationRevision INTEGER NOT NULL CHECK(conversationRevision > 0),
      instructionsRevision INTEGER NOT NULL CHECK(instructionsRevision > 0),
      profileRevision INTEGER NOT NULL CHECK(profileRevision > 0),
      profileId TEXT NOT NULL,
      taskVersion INTEGER NOT NULL CHECK(taskVersion > 0),
      captureTaskVersion INTEGER NOT NULL CHECK(captureTaskVersion > 0),
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      evidenceId TEXT NOT NULL UNIQUE,
      capturedAt INTEGER NOT NULL CHECK(capturedAt >= 0),
      comparisonId TEXT,
      comparisonCaptureState TEXT NOT NULL CHECK(comparisonCaptureState IN ('missing','pending','unsettled','finished')),
      comparisonOutcome TEXT CHECK(comparisonOutcome IS NULL OR comparisonOutcome IN ('running','completed','failed','unknown')),
      comparisonObservedAt INTEGER,
      state TEXT NOT NULL CHECK(state IN ('empty','available','partial','gap')),
      payloadBytes INTEGER NOT NULL CHECK(payloadBytes >= 0),
      manifestJson TEXT NOT NULL,
      UNIQUE(resultId,taskId,assignmentId,assignmentVersion,workId,workRevision)
    );
    CREATE INDEX IF NOT EXISTS retained_result_evidence_task
      ON retained_result_evidence(taskId,resultId);
    CREATE TABLE IF NOT EXISTS retained_result_evidence_items (
      itemId TEXT PRIMARY KEY,
      resultId TEXT NOT NULL REFERENCES retained_result_evidence(resultId) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      kind TEXT NOT NULL CHECK(kind IN ('file','diff')),
      state TEXT NOT NULL CHECK(state IN ('available','gap')),
      reason TEXT,
      source TEXT NOT NULL CHECK(source IN ('artifact-file','change-file','observed-diff')),
      repositoryId TEXT,
      path TEXT,
      originRoot TEXT,
      artifactId TEXT REFERENCES task_review_artifact_ids(artifactId) ON DELETE CASCADE,
      mime TEXT,
      sha256 TEXT,
      size INTEGER NOT NULL CHECK(size >= 0),
      capturedAt INTEGER NOT NULL CHECK(capturedAt >= 0),
      observedAt INTEGER,
      provenanceJson TEXT NOT NULL,
      content BLOB,
      CHECK((state = 'available' AND content IS NOT NULL AND mime IS NOT NULL AND sha256 IS NOT NULL AND path IS NOT NULL AND originRoot IS NOT NULL AND reason IS NULL) OR
            (state = 'gap' AND content IS NULL AND mime IS NULL AND sha256 IS NULL AND path IS NULL AND originRoot IS NULL AND reason IS NOT NULL AND size = 0))
    );
    CREATE INDEX IF NOT EXISTS retained_result_items_result
      ON retained_result_evidence_items(resultId,itemId);
    CREATE INDEX IF NOT EXISTS retained_result_items_task
      ON retained_result_evidence_items(taskId,resultId,itemId);`);
    const evidenceColumns = this.db
      .prepare("PRAGMA table_info(retained_result_evidence)")
      .all() as Array<{ name: string }>;
    if (
      !evidenceColumns.some((column) => column.name === "captureTaskVersion")
    ) {
      this.db.exec(
        "ALTER TABLE retained_result_evidence ADD COLUMN captureTaskVersion INTEGER",
      );
      this.db.exec(
        "UPDATE retained_result_evidence SET captureTaskVersion=taskVersion WHERE captureTaskVersion IS NULL",
      );
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS retained_review_anchor_contexts (
      anchorId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      repositoryId TEXT,
      path TEXT NOT NULL,
      originRoot TEXT,
      sourceKind TEXT NOT NULL CHECK(sourceKind IN ('workspace-file','comparison-side','result-evidence')),
      context TEXT NOT NULL CHECK(context IN ('workspace','branch','uncommitted','turn','result')),
      comparisonId TEXT,
      resultId TEXT,
      resultItemId TEXT,
      workId TEXT,
      threadId TEXT,
      turnId TEXT,
      side TEXT NOT NULL CHECK(side IN ('file','left','right')),
      startLine INTEGER NOT NULL CHECK(startLine > 0),
      endLine INTEGER NOT NULL CHECK(endLine >= startLine),
      sourceSha256 TEXT,
      claimedSha256 TEXT,
      excerptSha256 TEXT,
      byteStart INTEGER,
      byteEnd INTEGER,
      mime TEXT,
      state TEXT NOT NULL CHECK(state IN ('available','gap')),
      reason TEXT CHECK(reason IS NULL OR reason IN ('missing','unavailable','comparison-unavailable','comparison-unsettled','quota')),
      size INTEGER NOT NULL CHECK(size >= 0),
      capturedAt INTEGER NOT NULL CHECK(capturedAt >= 0),
      observedAt INTEGER,
      recordJson TEXT NOT NULL,
      content BLOB,
      CHECK((state='available' AND content IS NOT NULL AND sourceSha256 IS NOT NULL AND excerptSha256 IS NOT NULL AND byteStart IS NOT NULL AND byteEnd IS NOT NULL AND mime IS NOT NULL AND reason IS NULL) OR
            (state='gap' AND content IS NULL AND sourceSha256 IS NULL AND excerptSha256 IS NULL AND byteStart IS NULL AND byteEnd IS NULL AND mime IS NULL AND reason IS NOT NULL AND size=0))
    );
    CREATE INDEX IF NOT EXISTS retained_review_anchor_context_task
      ON retained_review_anchor_contexts(taskId,anchorId);
    CREATE TABLE IF NOT EXISTS retained_review_anchor_submitted_contexts (
      submittedContextId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_drafts (
      draftId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      state TEXT NOT NULL CHECK(state IN ('open','sealed','discarded')),
      submittedContextId TEXT REFERENCES retained_review_anchor_submitted_contexts(submittedContextId),
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0),
      updatedAt INTEGER NOT NULL CHECK(updatedAt >= createdAt),
      CHECK((state='sealed' AND submittedContextId IS NOT NULL) OR
            (state<>'sealed'))
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_draft_refs (
      draftId TEXT NOT NULL REFERENCES retained_review_anchor_drafts(draftId) ON DELETE CASCADE,
      anchorId TEXT NOT NULL REFERENCES retained_review_anchor_contexts(anchorId) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(draftId,anchorId),
      UNIQUE(draftId,position)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_submitted_refs (
      submittedContextId TEXT NOT NULL REFERENCES retained_review_anchor_submitted_contexts(submittedContextId) ON DELETE CASCADE,
      anchorId TEXT NOT NULL REFERENCES retained_review_anchor_contexts(anchorId) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(submittedContextId,anchorId),
      UNIQUE(submittedContextId,position)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_draft_submissions (
      draftId TEXT PRIMARY KEY REFERENCES retained_review_anchor_drafts(draftId) ON DELETE CASCADE,
      submittedContextId TEXT NOT NULL UNIQUE REFERENCES retained_review_anchor_submitted_contexts(submittedContextId)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_operations (
      operationId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      kind TEXT NOT NULL CHECK(kind IN ('stage','seal','discard')),
      materialHash TEXT NOT NULL,
      responseJson TEXT NOT NULL
    );`);
  }

  /** Called inside CoordinationStore.recordResult's existing BEGIN IMMEDIATE. */
  recordResultWithinTransaction(
    owner: ResultOwner,
    currentIdentity: RetainedEvidenceIdentity,
    input: RetainedEvidenceCandidate,
  ): RetainedEvidenceManifest {
    if (this.db.isTransaction === false)
      throw new Error(
        "Retained result evidence requires the result transaction",
      );
    const candidate = candidateSchema.parse(input);
    const identity = identitySchema.parse(currentIdentity);
    if (!identityMatches(candidate.identity, identity))
      throw new Error("Retained result evidence binding changed");
    const preparedItems = candidate.items.map((item) => itemSchema.parse(item));
    const prior = this.db
      .prepare(
        "SELECT manifestJson FROM retained_result_evidence WHERE resultId=?",
      )
      .get(owner.resultId) as Row | undefined;
    if (prior) {
      const manifest = parseManifest(JSON.parse(String(prior.manifestJson)));
      if (
        manifest.taskId !== owner.taskId ||
        manifest.assignmentId !== owner.assignmentId ||
        manifest.assignmentVersion !== owner.assignmentVersion ||
        manifest.workId !== owner.workId ||
        manifest.workRevision !== owner.workRevision
      )
        throw new Error("Retained result evidence identity mismatch");
      return manifest;
    }

    let taskResultBytes = this.storedBytes(
      "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_result_evidence_items WHERE taskId=? AND state='available'",
      owner.taskId,
    );
    let installationBytes = this.storedBytes(
      "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_result_evidence_items WHERE state='available'",
    );
    if (this.tableExists("retained_review_anchor_contexts")) {
      installationBytes += this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_review_anchor_contexts WHERE state='available'",
      );
    }
    let payloadBytes = 0;
    let fileCount = 0;
    const storedItems: Array<z.infer<typeof itemSchema>> = [];
    for (const item of preparedItems) {
      let next = item;
      if (item.kind === "file") {
        fileCount++;
        if (fileCount > retainedEvidenceLimits.maxFilesPerResult)
          next = asGap(item, "too-many-links");
      }
      if (next.state === "available") {
        const amount = next.size;
        if (
          payloadBytes + amount > retainedEvidenceLimits.maxResultBytes ||
          taskResultBytes + amount >
            retainedEvidenceLimits.maxTaskResultBytes ||
          installationBytes + amount >
            retainedEvidenceLimits.maxInstallationBytes
        ) {
          next = asGap(next, "quota");
        } else {
          payloadBytes += amount;
          taskResultBytes += amount;
          installationBytes += amount;
        }
      }
      storedItems.push(next);
    }

    const state =
      storedItems.length === 0
        ? "empty"
        : storedItems.every((item) => item.state === "gap")
          ? "gap"
          : storedItems.some((item) => item.state === "gap")
            ? "partial"
            : "available";
    const manifest: RetainedEvidenceManifest = {
      version: 1,
      resultId: owner.resultId,
      evidenceId: candidate.evidenceId,
      ...identity,
      capturedAt: candidate.capturedAt,
      sourceObservation: candidate.sourceObservation,
      state,
      payloadBytes,
      items: storedItems.map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        state: item.state,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        source: item.source,
        repositoryId: item.repositoryId,
        path: item.path,
        ...(item.artifactId === undefined
          ? {}
          : { artifactId: item.artifactId }),
        ...(item.mime === undefined ? {} : { mime: item.mime }),
        ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
        size: item.size,
        capturedAt: item.capturedAt,
        observedAt: item.observedAt,
        provenance: item.provenance,
      })),
    };
    const checkedManifest = parseManifest(manifest);
    this.db
      .prepare(`INSERT INTO retained_result_evidence
      (resultId,taskId,assignmentId,assignmentVersion,workId,workRevision,
       requestSequence,conversationRevision,instructionsRevision,profileRevision,
       profileId,taskVersion,captureTaskVersion,threadId,turnId,evidenceId,capturedAt,comparisonId,
       comparisonCaptureState,comparisonOutcome,comparisonObservedAt,state,payloadBytes,manifestJson)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        owner.resultId,
        owner.taskId,
        owner.assignmentId,
        owner.assignmentVersion,
        owner.workId,
        owner.workRevision,
        identity.requestSequence,
        identity.conversationRevision,
        identity.instructionsRevision,
        identity.profileRevision,
        identity.profileId,
        identity.taskVersion,
        identity.captureTaskVersion,
        identity.threadId,
        identity.turnId,
        candidate.evidenceId,
        candidate.capturedAt,
        candidate.sourceObservation.comparisonId,
        candidate.sourceObservation.captureState,
        candidate.sourceObservation.outcome,
        candidate.sourceObservation.observedAt,
        state,
        payloadBytes,
        JSON.stringify(checkedManifest),
      );
    const insert = this.db.prepare(`INSERT INTO retained_result_evidence_items
      (itemId,resultId,taskId,kind,state,reason,source,repositoryId,path,originRoot,
       artifactId,mime,sha256,size,capturedAt,observedAt,provenanceJson,content)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of storedItems) {
      insert.run(
        item.itemId,
        owner.resultId,
        owner.taskId,
        item.kind,
        item.state,
        item.reason ?? null,
        item.source,
        item.repositoryId,
        item.path,
        item.originRoot,
        item.artifactId ?? null,
        item.mime ?? null,
        item.sha256 ?? null,
        item.size,
        item.capturedAt,
        item.observedAt,
        JSON.stringify(item.provenance),
        item.state === "available"
          ? Buffer.from(item.bytes as Uint8Array)
          : null,
      );
    }
    return checkedManifest;
  }

  result(
    taskId: string,
    resultId: string,
  ): RetainedEvidenceManifest | undefined {
    const row = this.db
      .prepare(`SELECT evidence.manifestJson,evidence.assignmentId,
        evidence.assignmentVersion,evidence.workId,evidence.workRevision,
        evidence.captureTaskVersion,
        result.taskId AS resultTaskId,result.assignmentId AS resultAssignmentId,
        result.assignmentVersion AS resultAssignmentVersion,result.workId AS resultWorkId,
        result.workRevision AS resultWorkRevision
        FROM retained_result_evidence evidence
        JOIN coordination_results result ON result.resultId=evidence.resultId
        WHERE evidence.taskId=? AND evidence.resultId=?`)
      .get(taskId, resultId) as Row | undefined;
    if (!row) return undefined;
    const manifest = parseManifest(JSON.parse(String(row.manifestJson)));
    if (
      manifest.taskId !== taskId ||
      manifest.resultId !== resultId ||
      manifest.assignmentId !== row.assignmentId ||
      manifest.assignmentId !== row.resultAssignmentId ||
      manifest.assignmentVersion !== row.assignmentVersion ||
      manifest.assignmentVersion !== row.resultAssignmentVersion ||
      manifest.workId !== row.workId ||
      manifest.workId !== row.resultWorkId ||
      manifest.workRevision !== row.workRevision ||
      manifest.workRevision !== row.resultWorkRevision ||
      manifest.captureTaskVersion !== row.captureTaskVersion ||
      manifest.taskId !== row.resultTaskId
    )
      throw new Error("Retained result evidence lookup identity mismatch");
    return manifest;
  }

  item(
    taskId: string,
    resultId: string,
    itemId: string,
  ): RetainedEvidenceItemContent | undefined {
    const manifest = this.result(taskId, resultId);
    if (!manifest) return undefined;
    const row = this.db
      .prepare(`SELECT itemId,resultId,taskId,kind,state,reason,source,repositoryId,path,originRoot,
        artifactId,mime,sha256,size,capturedAt,observedAt,provenanceJson,content
        FROM retained_result_evidence_items WHERE taskId=? AND resultId=? AND itemId=?`)
      .get(taskId, resultId, itemId) as Row | undefined;
    if (!row) return undefined;
    const item = rowItem(row);
    if (item.state !== "available" || !(row.content instanceof Uint8Array))
      return undefined;
    const bytes = Buffer.from(row.content);
    if (
      bytes.byteLength !== item.size ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw new Error("Retained result evidence payload integrity mismatch");
    if (row.originRoot === null)
      throw new Error("Retained result evidence origin is missing");
    return { manifest, item, bytes, originRoot: String(row.originRoot) };
  }

  reviewAnchorOperation(
    taskId: string,
    operationId: string,
    kind: "stage" | "seal" | "discard",
    materialHash: string,
  ):
    | RetainedReviewAnchorStageResponse
    | RetainedReviewAnchorSealResponse
    | RetainedReviewAnchorDiscardResponse
    | undefined {
    const row = this.db
      .prepare(
        `SELECT operationId,taskId,kind,materialHash,responseJson
        FROM retained_review_anchor_operations WHERE operationId=?`,
      )
      .get(operationId) as Row | undefined;
    if (!row) return undefined;
    const operation = reviewAnchorOperationSchema.parse({
      operationId: String(row.operationId),
      taskId: String(row.taskId),
      kind: String(row.kind),
      materialHash: String(row.materialHash),
      responseJson: String(row.responseJson),
    });
    if (
      operation.taskId !== taskId ||
      operation.kind !== kind ||
      operation.materialHash !== materialHash
    )
      throw new Error(
        "Review anchor operation ID reused with different material",
      );
    const response = JSON.parse(operation.responseJson) as unknown;
    if (kind === "stage")
      return retainedReviewAnchorResponseSchema.parse(response);
    if (kind === "seal")
      return retainedReviewAnchorSealResponseSchema.parse(response);
    return retainedReviewAnchorDiscardResponseSchema.parse(response);
  }

  stageReviewAnchorDraft(
    taskId: string,
    operationId: string,
    materialHash: string,
    candidates: readonly RetainedReviewAnchorCandidate[],
  ): RetainedReviewAnchorStageResponse {
    uuid.parse(taskId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    if (candidates.length > 32)
      throw new Error("Review anchor operation exceeds its selection limit");
    const checked = candidates.map((candidate) =>
      reviewAnchorCandidateSchema.parse(candidate),
    );
    if (
      checked.some((candidate) => candidate.taskId !== taskId) ||
      new Set(checked.map((candidate) => candidate.anchorId)).size !==
        checked.length
    )
      throw new Error("Review anchor task or identity mismatch");
    const stage = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "stage",
        materialHash,
      );
      if (prior) return retainedReviewAnchorResponseSchema.parse(prior);
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM retained_review_anchor_contexts WHERE taskId=?",
        )
        .get(taskId) as Row;
      if (
        Number(countRow.count) + checked.length >
        retainedEvidenceLimits.maxReviewAnchorsPerTask
      )
        throw new Error("Review anchor count quota exceeded");

      const draftId = randomUUID();
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO retained_review_anchor_drafts
        (draftId,taskId,state,submittedContextId,createdAt,updatedAt)
        VALUES (?,?,'open',NULL,?,?)`)
        .run(draftId, taskId, now, now);

      let taskBytes = this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_review_anchor_contexts WHERE taskId=? AND state='available'",
        taskId,
      );
      let installationBytes = this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_review_anchor_contexts WHERE state='available'",
      );
      installationBytes += this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_result_evidence_items WHERE state='available'",
      );
      const anchorIds: string[] = [];
      const anchorStates: RetainedReviewAnchorStageResponse["anchorStates"] =
        [];
      const insertRef =
        this.db.prepare(`INSERT INTO retained_review_anchor_draft_refs
        (draftId,anchorId,position) VALUES (?,?,?)`);
      for (const [position, candidate] of checked.entries()) {
        let stored = candidate;
        const amount = candidate.state === "available" ? candidate.size : 0;
        if (
          candidate.state === "available" &&
          (amount > retainedEvidenceLimits.maxReviewAnchorBytes ||
            taskBytes + amount > retainedEvidenceLimits.maxTaskReviewBytes ||
            installationBytes + amount >
              retainedEvidenceLimits.maxInstallationBytes)
        ) {
          stored = gapReviewAnchor(candidate, "quota");
        } else if (candidate.state === "available") {
          taskBytes += amount;
          installationBytes += amount;
        }
        this.insertReviewAnchor(stored);
        insertRef.run(draftId, stored.anchorId, position);
        anchorIds.push(stored.anchorId);
        anchorStates.push({
          anchorId: stored.anchorId,
          state: stored.state,
          ...(stored.reason ? { reason: stored.reason } : {}),
        });
      }
      const response = retainedReviewAnchorResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        state: "staged",
        anchorIds,
        anchorStates,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "stage",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true
      ? stage()
      : transaction(this.db, stage);
  }

  /** Called inside a coordination transaction; keeps the #781 stage contract intact. */
  stageReviewAnchorDraftWithinTransaction(
    taskId: string,
    operationId: string,
    materialHash: string,
    candidates: readonly RetainedReviewAnchorCandidate[],
  ): RetainedReviewAnchorStageResponse {
    if (this.db.isTransaction === false)
      throw new Error(
        "Review anchor staging requires the coordination transaction",
      );
    return this.stageReviewAnchorDraft(
      taskId,
      operationId,
      materialHash,
      candidates,
    );
  }

  sealReviewAnchorDraft(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
    anchorIds: readonly string[],
  ): RetainedReviewAnchorSealResponse {
    uuid.parse(taskId);
    uuid.parse(draftId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    const checkedIds = anchorIds.map((id) => uuid.parse(id));
    if (
      checkedIds.length > 32 ||
      new Set(checkedIds).size !== checkedIds.length
    )
      throw new Error("Invalid review anchor references");
    const seal = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "seal",
        materialHash,
      );
      if (prior) return retainedReviewAnchorSealResponseSchema.parse(prior);
      const draft = this.db
        .prepare(`SELECT draftId,taskId,state,submittedContextId,createdAt,updatedAt
        FROM retained_review_anchor_drafts WHERE draftId=?`)
        .get(draftId) as Row | undefined;
      if (!draft || draft.taskId !== taskId)
        throw new Error("Review anchor draft is unavailable");
      const refs = this.db
        .prepare(
          "SELECT anchorId FROM retained_review_anchor_draft_refs WHERE draftId=? ORDER BY position",
        )
        .all(draftId)
        .map((row) => String((row as Row).anchorId));
      if (
        refs.length !== checkedIds.length ||
        refs.some((anchorId, index) => anchorId !== checkedIds[index])
      )
        throw new Error("Review anchor draft references changed");
      if (draft.state === "discarded" && draft.submittedContextId === null)
        throw new Error("Discarded review anchor draft cannot be sealed");

      let submittedContextId =
        draft.submittedContextId === null
          ? undefined
          : String(draft.submittedContextId);
      if (!submittedContextId) {
        submittedContextId = randomUUID();
        const createdAt = Date.now();
        this.db
          .prepare(`INSERT INTO retained_review_anchor_submitted_contexts
          (submittedContextId,taskId,createdAt) VALUES (?,?,?)`)
          .run(submittedContextId, taskId, createdAt);
        const insert =
          this.db.prepare(`INSERT INTO retained_review_anchor_submitted_refs
          (submittedContextId,anchorId,position) VALUES (?,?,?)`);
        for (const [position, anchorId] of checkedIds.entries())
          insert.run(submittedContextId, anchorId, position);
        this.db
          .prepare(`INSERT INTO retained_review_anchor_draft_submissions
          (draftId,submittedContextId) VALUES (?,?)`)
          .run(draftId, submittedContextId);
        this.db
          .prepare(`UPDATE retained_review_anchor_drafts
          SET state='sealed',submittedContextId=?,updatedAt=? WHERE draftId=? AND state='open'`)
          .run(submittedContextId, createdAt, draftId);
      } else {
        const submittedIds = this.db
          .prepare(
            "SELECT anchorId FROM retained_review_anchor_submitted_refs WHERE submittedContextId=? ORDER BY position",
          )
          .all(submittedContextId)
          .map((row) => String((row as Row).anchorId));
        if (
          submittedIds.length !== checkedIds.length ||
          submittedIds.some((anchorId, index) => anchorId !== checkedIds[index])
        )
          throw new Error("Submitted review anchor references changed");
      }
      const response = retainedReviewAnchorSealResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        submittedContextId,
        state: "sealed",
        linkState: "durable",
        deliveryState: "not-attempted",
        receiptState: "none",
        anchorIds: checkedIds,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "seal",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true ? seal() : transaction(this.db, seal);
  }

  /** Called inside SendLocalReview's one outer transaction. */
  sealReviewAnchorDraftWithinTransaction(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
    anchorIds: readonly string[],
  ): RetainedReviewAnchorSealResponse {
    if (this.db.isTransaction === false)
      throw new Error(
        "Review anchor sealing requires the coordination transaction",
      );
    return this.sealReviewAnchorDraft(
      taskId,
      draftId,
      operationId,
      materialHash,
      anchorIds,
    );
  }

  discardReviewAnchorDraft(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
  ): RetainedReviewAnchorDiscardResponse {
    uuid.parse(taskId);
    uuid.parse(draftId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    const discard = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "discard",
        materialHash,
      );
      if (prior) return retainedReviewAnchorDiscardResponseSchema.parse(prior);
      const draft = this.db
        .prepare(`SELECT draftId,taskId,state,submittedContextId
        FROM retained_review_anchor_drafts WHERE draftId=?`)
        .get(draftId) as Row | undefined;
      if (!draft || draft.taskId !== taskId)
        throw new Error("Review anchor draft is unavailable");
      const preserved = draft.submittedContextId !== null;
      const orphanIds = this.db
        .prepare(
          `SELECT anchorId FROM retained_review_anchor_draft_refs
          WHERE draftId=? AND anchorId NOT IN (
            SELECT anchorId FROM retained_review_anchor_submitted_refs
          )`,
        )
        .all(draftId)
        .map((row) => String((row as Row).anchorId));
      this.db
        .prepare(
          "DELETE FROM retained_review_anchor_draft_refs WHERE draftId=?",
        )
        .run(draftId);
      this.db
        .prepare(`UPDATE retained_review_anchor_drafts
        SET state='discarded',updatedAt=? WHERE draftId=?`)
        .run(Date.now(), draftId);
      if (orphanIds.length) {
        const remove = this.db.prepare(
          "DELETE FROM retained_review_anchor_contexts WHERE anchorId=? AND NOT EXISTS (SELECT 1 FROM retained_review_anchor_draft_refs WHERE anchorId=?) AND NOT EXISTS (SELECT 1 FROM retained_review_anchor_submitted_refs WHERE anchorId=?)",
        );
        for (const anchorId of orphanIds)
          remove.run(anchorId, anchorId, anchorId);
      }
      const response = retainedReviewAnchorDiscardResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        state: "discarded",
        submittedContextPreserved: preserved,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "discard",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true
      ? discard()
      : transaction(this.db, discard);
  }

  /** Called inside a coordination transaction when reclaiming an unreferenced draft group. */
  discardReviewAnchorDraftWithinTransaction(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
  ): RetainedReviewAnchorDiscardResponse {
    if (this.db.isTransaction === false)
      throw new Error(
        "Review anchor discard requires the coordination transaction",
      );
    return this.discardReviewAnchorDraft(
      taskId,
      draftId,
      operationId,
      materialHash,
    );
  }

  reviewAnchorDraft(
    taskId: string,
    draftId: string,
  ): RetainedReviewAnchorDraft | undefined {
    const row = this.db
      .prepare(`SELECT draftId,taskId,state,submittedContextId,createdAt,updatedAt
      FROM retained_review_anchor_drafts WHERE taskId=? AND draftId=?`)
      .get(taskId, draftId) as Row | undefined;
    if (!row) return undefined;
    const refs = this.db
      .prepare(
        "SELECT anchorId FROM retained_review_anchor_draft_refs WHERE draftId=? ORDER BY position",
      )
      .all(draftId)
      .map((item) => String((item as Row).anchorId));
    return {
      draftId: String(row.draftId),
      taskId: String(row.taskId),
      state: String(row.state) as RetainedReviewAnchorDraft["state"],
      submittedContextId:
        row.submittedContextId === null ? null : String(row.submittedContextId),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      anchorIds: refs,
    };
  }

  reviewAnchorSubmittedContext(
    taskId: string,
    submittedContextId: string,
  ): RetainedReviewAnchorSubmittedContext | undefined {
    const row = this.db
      .prepare(`SELECT submittedContextId,taskId,createdAt
      FROM retained_review_anchor_submitted_contexts
      WHERE taskId=? AND submittedContextId=?`)
      .get(taskId, submittedContextId) as Row | undefined;
    if (!row) return undefined;
    const refs = this.db
      .prepare(
        "SELECT anchorId FROM retained_review_anchor_submitted_refs WHERE submittedContextId=? ORDER BY position",
      )
      .all(submittedContextId)
      .map((item) => String((item as Row).anchorId));
    return {
      submittedContextId: String(row.submittedContextId),
      taskId: String(row.taskId),
      createdAt: Number(row.createdAt),
      anchorIds: refs,
    };
  }

  reviewAnchor(
    taskId: string,
    anchorId: string,
  ): RetainedReviewAnchorContent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM retained_review_anchor_contexts
      WHERE taskId=? AND anchorId=?`)
      .get(taskId, anchorId) as Row | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(String(row.recordJson)) as Record<
      string,
      unknown
    >;
    const bytes =
      row.content instanceof Uint8Array ? Buffer.from(row.content) : undefined;
    const anchor = reviewAnchorCandidateSchema.parse({
      ...stored,
      ...(bytes ? { bytes } : {}),
    });
    if (
      anchor.taskId !== taskId ||
      anchor.anchorId !== anchorId ||
      anchor.state !== row.state ||
      anchor.size !== Number(row.size) ||
      anchor.repositoryId !== row.repositoryId ||
      anchor.path !== row.path ||
      (anchor.originRoot ?? null) !== row.originRoot ||
      anchor.context !== row.context ||
      anchor.sourceKind !== row.sourceKind ||
      anchor.startLine !== Number(row.startLine) ||
      anchor.endLine !== Number(row.endLine)
    )
      throw new Error("Retained review anchor identity mismatch");
    if (anchor.state === "available") {
      if (!bytes || bytes.byteLength !== anchor.size)
        throw new Error("Retained review anchor payload is missing");
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        anchor.excerptSha256
      )
        throw new Error("Retained review anchor payload integrity mismatch");
    }
    const record: RetainedReviewAnchorRecord = {
      anchorId: anchor.anchorId,
      taskId: anchor.taskId,
      repositoryId: anchor.repositoryId,
      path: anchor.path,
      sourceKind: anchor.sourceKind,
      context: anchor.context,
      ...(anchor.comparisonId ? { comparisonId: anchor.comparisonId } : {}),
      ...(anchor.resultId ? { resultId: anchor.resultId } : {}),
      ...(anchor.resultItemId ? { resultItemId: anchor.resultItemId } : {}),
      ...(anchor.workId ? { workId: anchor.workId } : {}),
      ...(anchor.threadId ? { threadId: anchor.threadId } : {}),
      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
      side: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      ...(anchor.sourceSha256 ? { sourceSha256: anchor.sourceSha256 } : {}),
      ...(anchor.claimedSha256 ? { claimedSha256: anchor.claimedSha256 } : {}),
      ...(anchor.excerptSha256 ? { excerptSha256: anchor.excerptSha256 } : {}),
      ...(anchor.byteStart === undefined
        ? {}
        : { byteStart: anchor.byteStart }),
      ...(anchor.byteEnd === undefined ? {} : { byteEnd: anchor.byteEnd }),
      ...(anchor.mime ? { mime: anchor.mime } : {}),
      state: anchor.state,
      ...(anchor.reason ? { reason: anchor.reason } : {}),
      size: anchor.size,
      capturedAt: anchor.capturedAt,
      observedAt: anchor.observedAt,
    };
    return {
      anchor: record,
      ...(bytes ? { bytes } : {}),
      ...(anchor.originRoot ? { originRoot: anchor.originRoot } : {}),
    };
  }

  reviewAnchorHasReference(taskId: string, anchorId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 AS found FROM retained_review_anchor_contexts anchor
        WHERE anchor.taskId=? AND anchor.anchorId=? AND (
          EXISTS (SELECT 1 FROM retained_review_anchor_draft_refs draft WHERE draft.anchorId=anchor.anchorId) OR
          EXISTS (SELECT 1 FROM retained_review_anchor_submitted_refs submitted WHERE submitted.anchorId=anchor.anchorId)
        )`)
        .get(taskId, anchorId),
    );
  }

  private insertReviewAnchor(
    candidate: z.infer<typeof reviewAnchorCandidateSchema>,
  ): void {
    const { bytes: _bytes, ...record } = candidate;
    this.db
      .prepare(`INSERT INTO retained_review_anchor_contexts
      (anchorId,taskId,repositoryId,path,originRoot,sourceKind,context,comparisonId,resultId,resultItemId,
       workId,threadId,turnId,side,startLine,endLine,sourceSha256,claimedSha256,excerptSha256,
       byteStart,byteEnd,mime,state,reason,size,capturedAt,observedAt,recordJson,content)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        candidate.anchorId,
        candidate.taskId,
        candidate.repositoryId,
        candidate.path,
        candidate.originRoot ?? null,
        candidate.sourceKind,
        candidate.context,
        candidate.comparisonId ?? null,
        candidate.resultId ?? null,
        candidate.resultItemId ?? null,
        candidate.workId ?? null,
        candidate.threadId ?? null,
        candidate.turnId ?? null,
        candidate.side,
        candidate.startLine,
        candidate.endLine,
        candidate.sourceSha256 ?? null,
        candidate.claimedSha256 ?? null,
        candidate.excerptSha256 ?? null,
        candidate.byteStart ?? null,
        candidate.byteEnd ?? null,
        candidate.mime ?? null,
        candidate.state,
        candidate.reason ?? null,
        candidate.size,
        candidate.capturedAt,
        candidate.observedAt,
        JSON.stringify(record),
        candidate.state === "available"
          ? Buffer.from(candidate.bytes as Uint8Array)
          : null,
      );
  }

  private recordReviewAnchorOperation(
    operationId: string,
    taskId: string,
    kind: "stage" | "seal" | "discard",
    materialHash: string,
    response: unknown,
  ): void {
    this.db
      .prepare(`INSERT INTO retained_review_anchor_operations
      (operationId,taskId,kind,materialHash,responseJson) VALUES (?,?,?,?,?)`)
      .run(operationId, taskId, kind, materialHash, JSON.stringify(response));
  }

  private tableExists(name: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name),
    );
  }

  private storedBytes(sql: string, ...args: (string | number)[]): number {
    const row = this.db.prepare(sql).get(...args) as Row;
    const bytes = Number(row.bytes ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Retained evidence quota count is invalid");
    return bytes;
  }
}

export function emptyRetainedEvidenceCandidate(
  identity: RetainedEvidenceIdentity,
  sourceObservation: RetainedEvidenceSourceObservation = {
    comparisonId: null,
    captureState: "missing",
    outcome: null,
    observedAt: null,
  },
): RetainedEvidenceCandidate {
  return {
    version: 1,
    evidenceId: randomUUID(),
    capturedAt: Date.now(),
    identity,
    sourceObservation,
    items: [],
  };
}

/** Preserve source links and identity when payload persistence is unavailable. */
export function unavailableRetainedEvidenceCandidate(
  input: RetainedEvidenceCandidate,
): RetainedEvidenceCandidate {
  const candidate = candidateSchema.parse(input);
  return {
    ...candidate,
    items: candidate.items.map((item) => asGap(item, "unavailable")),
  };
}
