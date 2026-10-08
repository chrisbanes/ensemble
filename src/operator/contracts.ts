import { z } from "zod";
import {
  githubConfigurationSchema,
  readinessSchema,
} from "../core/github-source-contracts.js";
import {
  questionAnswersSchema,
  questionFormSchema,
  questionPayloadLimit,
} from "../core/question-forms.js";
import {
  feedbackReferenceSchema,
  taskReviewReadSchema,
} from "../core/task-review.js";
export const uuid = z.string().uuid();
const revision = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
const text = z.string().max(16000);
const safeText = text.nullable();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
const scalar = z.union([z.null(), z.boolean(), z.number().finite(), text]);
let boundedJson: z.ZodType<JsonValue> = scalar;
for (let depth = 0; depth < 12; depth++) {
  const child = boundedJson;
  boundedJson = z.union([
    scalar,
    z.array(child).max(256),
    z
      .record(z.string().max(512), child)
      .refine((value) => Object.keys(value).length <= 256),
  ]);
}
export const materialSchema = boundedJson.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8192,
);
export const sessionSchema = z
  .object({
    authenticated: z.boolean(),
    csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const projectSummarySchema = z
  .object({
    id: uuid,
    name: safeText,
    version: revision,
    paused: z.boolean(),
    leadProfileId: uuid.nullable(),
  })
  .strict();
export const profileSummarySchema = z
  .object({ id: uuid, name: safeText, version: revision, revoked: z.boolean() })
  .strict();
const envelope = <T extends z.ZodType>(schema: T) =>
  z.object({ data: schema, observedAt: time }).strict();
export const workspaceSchema = envelope(
  z
    .object({
      projects: z.array(projectSummarySchema),
      profiles: z.array(profileSummarySchema),
    })
    .strict(),
);
const workspaceInspectionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z
    .object({
      kind: z.literal("repository"),
      repositoryId: z.string().min(1).max(512),
    })
    .strict(),
]);
const workspaceInspectionPathSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(255)
      .refine(
        (part) =>
          !/\p{Cc}/u.test(part) && !part.includes("/") && !part.includes("\\"),
      ),
  )
  .max(32)
  .refine((parts) => new TextEncoder().encode(parts.join("/")).length <= 2048);
const workspaceInspectionStateSchema = z.enum([
  "ready",
  "missing",
  "provisioning",
  "held",
  "archiving",
  "archived",
  "excluded",
  "ignored",
  "conflict",
  "unavailable",
]);
const workspaceInspectionEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      repositoryId: z.string().min(1).max(128),
      size: z.null(),
      modifiedAt: z.null(),
      ignored: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["file", "directory", "symlink", "other"]),
      name: z.string().min(1).max(255),
      size: z.number().int().nonnegative().safe().nullable(),
      modifiedAt: z.number().finite().nullable(),
      ignored: z.boolean().nullable(),
    })
    .strict(),
]);
export const workspaceDirectoryReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      workspaceId: uuid.nullable(),
      scope: workspaceInspectionScopeSchema,
      path: workspaceInspectionPathSchema,
      state: workspaceInspectionStateSchema,
      entries: z.array(workspaceInspectionEntrySchema).max(256),
      truncated: z.boolean(),
      ignoreStatus: z.enum(["known", "not-applicable", "incomplete"]),
    })
    .strict(),
);
const workspacePreviewMetadataSchema = z
  .object({
    kind: z.enum(["file", "directory", "symlink", "other"]),
    size: z.number().int().nonnegative().safe().nullable(),
    modifiedAt: z.number().finite().nullable(),
    ignored: z.boolean().nullable(),
    reason: z
      .enum([
        "unsupported-format",
        "binary-content",
        "invalid-content",
        "too-large",
        "multiple-links",
        "image-dimensions-exceed-limit",
      ])
      .optional(),
  })
  .strict();
const workspacePreviewDataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      mime: z.string().min(1).max(128),
      text: z.string().max(1024 * 1024),
      sha256: hash,
      size: z
        .number()
        .int()
        .nonnegative()
        .max(1024 * 1024)
        .safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("base64"),
      mime: z.enum([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
      ]),
      data: z.string().max(4 * Math.ceil((8 * 1024 * 1024) / 3)),
      sha256: hash,
      size: z
        .number()
        .int()
        .nonnegative()
        .max(8 * 1024 * 1024)
        .safe(),
      width: z.number().int().positive().safe().optional(),
      height: z.number().int().positive().safe().optional(),
      maxDisplayedPages: z.number().int().positive().max(10).safe().optional(),
    })
    .strict(),
]);
export const workspacePreviewReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      workspaceId: uuid.nullable(),
      scope: workspaceInspectionScopeSchema,
      path: workspaceInspectionPathSchema,
      state: z.union([
        workspaceInspectionStateSchema,
        z.literal("metadata-only"),
      ]),
      metadata: workspacePreviewMetadataSchema.optional(),
      preview: workspacePreviewDataSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.state === "ready" && (!value.metadata || !value.preview))
        context.addIssue({
          code: "custom",
          message: "ready preview requires metadata and data",
        });
      if (value.state === "metadata-only" && !value.metadata?.reason)
        context.addIssue({
          code: "custom",
          message: "metadata-only preview requires a reason",
        });
      if (value.state !== "ready" && value.preview)
        context.addIssue({
          code: "custom",
          message: "unavailable preview cannot contain file data",
        });
    }),
);
const workspaceComparisonContentSchema = z
  .object({
    sha256: hash.optional(),
    objectId: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    size: z.number().int().nonnegative().safe().nullable(),
    lineCount: z.number().int().nonnegative().safe().nullable(),
    modifiedAt: time.nullable().optional(),
  })
  .strict();
const workspaceComparisonAnchorSchema = z
  .object({
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    comparisonId: uuid,
    context: z.enum(["branch", "uncommitted", "turn", "result"]),
    workId: z.string().min(1).max(512).optional(),
    resultId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    side: z.enum(["left", "right"]),
    startLine: revision,
    endLine: revision,
    contentSha256: hash,
  })
  .strict()
  .refine((anchor) => anchor.endLine >= anchor.startLine);
const workspaceComparisonHunkSchema = z
  .object({
    oldStart: z.number().int().nonnegative().safe(),
    oldLines: z.number().int().nonnegative().safe(),
    newStart: z.number().int().nonnegative().safe(),
    newLines: z.number().int().nonnegative().safe(),
    patch: z.string().max(1024 * 1024),
    leftAnchor: workspaceComparisonAnchorSchema.optional(),
    rightAnchor: workspaceComparisonAnchorSchema.optional(),
  })
  .strict();
const workspaceComparisonEntrySchema = z
  .object({
    path: z.string().min(1).max(2048),
    repositoryId: z.string().min(1).max(512).nullable().optional(),
    previousPath: z.string().min(1).max(2048).optional(),
    change: z.enum(["added", "modified", "deleted", "renamed", "type-changed"]),
    changeSet: z.enum(["branch", "staged", "unstaged"]).optional(),
    state: z.enum(["text", "binary", "unsupported", "gap"]),
    diff: z
      .string()
      .max(1024 * 1024)
      .optional(),
    left: workspaceComparisonContentSchema.optional(),
    right: workspaceComparisonContentSchema.optional(),
    hunks: z.array(workspaceComparisonHunkSchema).max(2048),
    reason: z
      .enum([
        "too-large",
        "invalid-text",
        "unsupported-format",
        "changing",
        "unavailable",
        "output-limit",
        "time-limit",
      ])
      .optional(),
  })
  .strict();
const workspaceComparisonEntriesSchema = z
  .array(workspaceComparisonEntrySchema)
  .max(256);
type WorkspaceComparisonAnchorContainer = {
  comparisonId: string;
  taskId: string;
  target: "branch" | "uncommitted" | "turn";
  repositoryId?: string | undefined;
  workId?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  entries: z.infer<typeof workspaceComparisonEntriesSchema>;
};
function validateWorkspaceComparisonAnchors(
  comparison: WorkspaceComparisonAnchorContainer,
  context: z.RefinementCtx,
) {
  for (const [entryIndex, entry] of comparison.entries.entries()) {
    for (const [hunkIndex, hunk] of entry.hunks.entries()) {
      for (const [anchorSide, anchor] of [
        ["left", hunk.leftAnchor],
        ["right", hunk.rightAnchor],
      ] as const) {
        if (!anchor) continue;
        const content = entry[anchorSide];
        const expectedRepositoryId =
          comparison.repositoryId ?? entry.repositoryId ?? null;
        const expectedPath =
          anchorSide === "left"
            ? (entry.previousPath ?? entry.path)
            : entry.path;
        if (
          anchor.taskId !== comparison.taskId ||
          anchor.comparisonId !== comparison.comparisonId ||
          anchor.side !== anchorSide ||
          anchor.path !== expectedPath ||
          anchor.context !== comparison.target ||
          anchor.contentSha256 !== content?.sha256 ||
          content?.lineCount === null ||
          content?.lineCount === undefined ||
          anchor.endLine > content.lineCount ||
          anchor.repositoryId !== expectedRepositoryId ||
          (comparison.workId !== undefined &&
            (anchor.workId !== comparison.workId ||
              anchor.threadId !== comparison.threadId ||
              anchor.turnId !== comparison.turnId))
        )
          context.addIssue({
            code: "custom",
            path: ["entries", entryIndex, "hunks", hunkIndex],
            message: "comparison-anchor-context-mismatch",
          });
      }
    }
  }
}
const workspaceRepositoryComparisonSchema = z
  .object({
    comparisonId: uuid,
    taskId: uuid,
    repositoryId: z.string().min(1).max(512),
    target: z.enum(["branch", "uncommitted"]),
    changeSet: z.enum(["all", "staged", "unstaged"]).optional(),
    state: z.enum(["available", "unavailable", "gap"]),
    observedAt: time,
    baseline: z
      .object({
        kind: z.enum(["merge-base", "head"]),
        branch: z.string().min(1).max(255).optional(),
        commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      })
      .strict()
      .optional(),
    availableBaseBranches: z.array(z.string().min(1).max(255)).max(4096),
    entries: workspaceComparisonEntriesSchema,
    truncated: z.boolean(),
    reason: z
      .enum([
        "workspace-unavailable",
        "repository-unavailable",
        "base-branch-required",
        "base-branch-unavailable",
        "no-merge-base",
        "head-unavailable",
        "git-failed",
        "time-limit",
        "output-limit",
        "unsafe-path",
        "workspace-changed",
      ])
      .optional(),
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceTurnComparisonSchema = z
  .object({
    comparisonId: uuid,
    taskId: uuid,
    target: z.literal("turn"),
    state: z.enum(["available", "gap", "unavailable"]),
    outcome: z.enum(["completed", "failed", "unknown"]),
    startedAt: time,
    observedAt: time,
    workId: z.string().min(1).max(512),
    workRevision: revision,
    requestSequence: revision,
    assignmentId: z.string().min(1).max(512),
    assignmentVersion: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    profileId: uuid,
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    entries: workspaceComparisonEntriesSchema,
    truncated: z.boolean(),
    reason: z
      .enum([
        "workspace-unavailable",
        "repository-unavailable",
        "base-branch-required",
        "base-branch-unavailable",
        "no-merge-base",
        "head-unavailable",
        "git-failed",
        "time-limit",
        "output-limit",
        "unsafe-path",
        "workspace-changed",
        "unsupported-content",
      ])
      .optional(),
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceComparisonSnapshotSchema = z.union([
  workspaceRepositoryComparisonSchema,
  workspaceTurnComparisonSchema,
]);
const workspaceTurnCaptureIdentitySchema = z
  .object({
    taskId: uuid,
    workId: z.string().min(1).max(512),
    workRevision: revision,
    requestSequence: revision,
    assignmentId: z.string().min(1).max(512),
    assignmentVersion: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    profileId: uuid,
  })
  .strict();
const workspacePendingTurnSchema = z
  .object({
    comparisonId: uuid,
    identity: workspaceTurnCaptureIdentitySchema,
    captureState: z.enum(["pending", "unsettled"]),
    outcome: z.enum(["running", "completed", "failed", "unknown"]),
    startedAt: time,
    observedAt: time,
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    beforeState: z.enum(["available", "gap"]).optional(),
    beforeObservedAt: time.optional(),
    afterState: z.enum(["available", "gap"]).optional(),
    afterObservedAt: time.optional(),
    comparison: workspaceTurnComparisonSchema.optional(),
    reason: z
      .enum([
        "workspace-unavailable",
        "repository-unavailable",
        "base-branch-required",
        "base-branch-unavailable",
        "no-merge-base",
        "head-unavailable",
        "git-failed",
        "time-limit",
        "output-limit",
        "unsafe-path",
        "workspace-changed",
        "unsupported-content",
        "runtime-uncertain",
        "turn-unbound",
        "callback-unfinished",
        "capture-store-failed",
      ])
      .optional(),
  })
  .strict();
export const workspaceComparisonReadRequestSchema = z.union([
  z
    .object({
      target: z.enum(["branch", "uncommitted", "last-turn"]),
      comparisonId: uuid,
    })
    .strict(),
  z
    .object({
      target: z.literal("branch"),
      repositoryId: z.string().min(1).max(512),
      baseBranch: z.string().min(1).max(255).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      target: z.literal("uncommitted"),
      repositoryId: z.string().min(1).max(512),
      changeSet: z.enum(["all", "staged", "unstaged"]).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z.object({ target: z.literal("last-turn") }).strict(),
]);
export const workspaceComparisonReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("available"),
        comparisonId: uuid,
        comparison: workspaceComparisonSnapshotSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("gap"),
        comparisonId: uuid.optional(),
        comparison: workspaceComparisonSnapshotSchema.optional(),
        reason: z.string().min(1).max(80).optional(),
        availableBaseBranches: z
          .array(z.string().min(1).max(255))
          .max(4096)
          .optional(),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("unavailable"),
        comparisonId: uuid.optional(),
        comparison: workspaceComparisonSnapshotSchema.optional(),
        reason: z.string().min(1).max(80),
        availableBaseBranches: z
          .array(z.string().min(1).max(255))
          .max(4096)
          .optional(),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.literal("last-turn"),
        state: z.literal("unsettled"),
        pending: workspacePendingTurnSchema,
        latestFinished: workspaceTurnComparisonSchema.optional(),
      })
      .strict(),
  ]),
);
export const executionSchema = z
  .object({
    state: z.enum([
      "idle",
      "selected",
      "queued",
      "starting",
      "running",
      "waiting",
      "paused",
      "stopping",
      "uncertain",
      "completed",
      "cancelled",
    ]),
    reasonCodes: z.array(
      z.enum([
        "project-paused",
        "task-held",
        "recovery-held",
        "admission-blocked",
        "runtime-unconfirmed",
      ]),
    ),
    holds: z
      .object({
        stop: z.boolean(),
        writer: z.boolean(),
        capacity: z.boolean(),
        uncertainty: z.boolean(),
        task: z.boolean(),
      })
      .strict(),
  })
  .strict();
const taskState = z.enum(["open", "done", "cancelled"]);
const sourceIdentity = z
  .object({
    provider: z.literal("github.com"),
    nodeId: z.string().min(1),
    repositoryId: z.string().min(1),
  })
  .strict();
const taskSummary = z
  .object({
    id: uuid,
    projectId: uuid,
    title: safeText,
    version: revision,
    state: taskState,
    ready: z.boolean(),
    execution: executionSchema,
    sourceIdentity: sourceIdentity.nullable(),
  })
  .strict();
export const projectSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      profiles: z.array(profileSummarySchema),
      tasks: z.array(taskSummary),
    })
    .strict(),
);
export const admissionSchema = taskSchemaAdmission();
function taskSchemaAdmission() {
  return z
    .object({
      eligible: z.boolean(),
      reasons: z.array(
        z.enum([
          "project-paused",
          "project-lead-unconfigured",
          "project-lead-revoked",
          "task-unready",
          "task-not-open",
          "local-dependency",
          "imported-blockers-unknown",
          "imported-blockers-blocked",
          "source-held",
          "admission-blocked",
        ]),
      ),
    })
    .strict();
}
export const taskSourceSummarySchema = z
  .object({
    identity: sourceIdentity,
    repositoryName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    number: revision.nullable(),
    url: z.string().url().nullable(),
    state: z.enum(["open", "closed"]).nullable(),
  })
  .strict()
  .nullable();
export const taskListSummarySchema = z
  .object({
    id: uuid,
    projectId: uuid,
    title: safeText,
    version: revision,
    state: taskState,
    ready: z.boolean(),
    project: projectSummarySchema,
    lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
    execution: executionSchema,
    admission: admissionSchema,
    capacity: z
      .object({
        globalUsage: time,
        globalLimit: revision,
        projectUsage: time,
        projectLimit: revision,
      })
      .strict(),
    source: taskSourceSummarySchema,
    attention: z
      .object({
        codes: z
          .array(
            z.enum([
              "question",
              "approval",
              "unresolved-result",
              "completion-rejected",
              "execution-uncertain",
              "lead-review",
            ]),
          )
          .max(6),
        count: time,
      })
      .strict(),
  })
  .strict();
export const taskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: uuid.optional(),
  })
  .strict();
export const taskListPageSchema = envelope(
  z
    .object({
      tasks: z.array(taskListSummarySchema).max(100),
      nextCursor: uuid.nullable(),
      catalogFingerprint: hash,
    })
    .strict(),
);
export const composerOptionsSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
      profiles: z.array(profileSummarySchema),
      dependencies: z
        .array(
          z
            .object({
              id: uuid,
              title: safeText,
              state: taskState,
              source: taskSourceSummarySchema,
            })
            .strict(),
        )
        .max(10000),
      capacity: z
        .object({
          globalUsage: time,
          globalLimit: revision,
          projectUsage: time,
          projectLimit: revision,
        })
        .strict(),
      routingEnabled: z.boolean(),
    })
    .strict(),
);
export type TaskListPage = z.infer<typeof taskListPageSchema>;
export type TaskListSummary = z.infer<typeof taskListSummarySchema>;
export type ComposerOptions = z.infer<typeof composerOptionsSchema>;
const generation = z
  .object({
    workId: z.string().min(1),
    assignmentVersion: revision,
    requestSequence: revision,
    instructionsRevision: revision,
    profileRevision: revision,
  })
  .strict();
export const assignmentSchema = z
  .object({
    assignmentId: uuid,
    profileId: uuid,
    name: safeText,
    brief: safeText.optional(),
    requesterAssignmentId: uuid.nullable().optional(),
    resultDestination: safeText.optional(),
    resultRecipientAssignmentId: uuid.nullable().optional(),
    resultRecipientDisposition: safeText.optional(),
    waitReason: safeText.optional(),
    version: revision,
    state: z.enum(["pending", "running", "completed", "held", "cancelled"]),
    profileRevision: revision,
    instructionsRevision: revision,
    currentProfileRevision: revision,
    currentInstructionsRevision: revision,
    executionGeneration: generation.nullable(),
  })
  .strict();
const message = z
  .object({
    eventId: uuid,
    eventType: z.string(),
    recipientAssignmentId: uuid,
    deliveryState: z.enum([
      "pending",
      "queued",
      "delivered",
      "operator-reconciled",
    ]),
    createdAt: time,
    text: safeText.optional(),
    decision: z.enum(["approved", "denied"]).optional(),
    action: safeText.optional(),
    target: safeText.optional(),
    resultId: uuid.optional(),
    routingOperationId: uuid.optional(),
    routingReason: safeText.optional(),
    questionAnswers: questionAnswersSchema.optional(),
    interactionId: uuid.optional(),
    reference: feedbackReferenceSchema.optional(),
  })
  .strict();
const result = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    workId: z.string().min(1),
    workRevision: revision,
    assignmentVersion: revision,
    summary: safeText,
    recipientAssignmentId: uuid.nullable(),
    destinationDisposition: z.enum(["delivered", "unresolved"]),
    createdAt: time,
  })
  .strict();
const interaction = z
  .object({
    interactionId: uuid,
    taskId: uuid,
    requestingAssignmentId: uuid,
    requestingWorkId: z.string().min(1),
    requestingWorkRevision: revision,
    requestingAssignmentVersion: revision,
    conversationRevision: revision,
    kind: z.enum(["question", "approval"]),
    status: z.enum(["open", "answered", "approved", "denied"]),
    prompt: safeText,
    action: safeText,
    target: safeText,
    materialHash: hash.nullable(),
    material: materialSchema.nullable(),
    approvable: z.boolean(),
    materialUnavailable: z.boolean(),
    response: safeText,
    revision,
    createdAt: time,
    updatedAt: time,
  })
  .strict();
const completion = z
  .object({
    requestId: uuid,
    taskId: uuid,
    leadAssignmentId: uuid,
    leadWorkId: z.string().min(1),
    leadWorkRevision: revision,
    taskVersion: revision,
    reviewedResultIds: z.array(uuid),
    status: z.enum(["pending", "rejected", "finalized"]),
    rejectionReasons: z.array(z.literal("completion-rejected")),
    revision,
    createdAt: time,
    finalizedAt: time.nullable(),
  })
  .strict();
export const unresolvedResultSchema = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    revision,
    reasonCode: z.literal("unresolved-destination"),
    permittedRecipient: z
      .object({ assignmentId: uuid, name: safeText })
      .strict()
      .nullable(),
    availability: z.enum(["available", "recipient-unavailable"]),
  })
  .strict();
const source = z
  .object({
    identity: sourceIdentity,
    repositoryName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    number: revision.nullable(),
    url: z.string().url().nullable(),
    title: safeText,
    body: safeText,
    state: z.enum(["open", "closed"]).nullable(),
    memberships: z.array(
      z
        .object({
          selectionId: z.string().max(512),
          projectFields: z.array(
            z
              .object({
                projectNodeId: z.string().max(512),
                fieldNodeId: z.string().max(512),
                optionNodeId: z.string().max(512),
              })
              .strict(),
          ),
          sync: z
            .object({
              lastAttemptAt: z.string().nullable(),
              lastSuccessfulAt: z.string().nullable(),
              complete: z.boolean().nullable(),
              reasonCode: z
                .enum(["partial-sync", "sync-unavailable"])
                .nullable(),
            })
            .strict(),
        })
        .strict(),
    ),
    nativeBlockers: z.array(
      z
        .object({
          nodeId: z.string().max(512),
          repositoryId: z.string().max(512),
          repositoryName: z.string().max(512),
          number: revision,
          state: z.enum(["open", "closed"]),
        })
        .strict(),
    ),
    review: z
      .object({
        observedDigest: hash,
        acceptedDigest: hash,
        decision: safeText,
        decidedAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    hold: z
      .object({
        active: z.boolean(),
        revision,
        reasonCode: z.literal("source-held"),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .nullable();
export const reviewReadSchema = envelope(taskReviewReadSchema);
export const deliveryReadSchema = z
  .object({
    mode: z.enum(["reviewable-pr", "through-merge"]),
    policyVersion: revision,
    blockers: z.array(text).max(128),
    omittedBlockerCount: z.number().int().nonnegative(),
    omittedActionCount: z.number().int().nonnegative(),
    binding: z
      .object({
        revision,
        number: revision,
        repositoryName: text,
        headSha: text,
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        observedAt: time,
        readError: safeText,
        omittedCheckCount: z.number().int().nonnegative(),
        omittedFeedbackCount: z.number().int().nonnegative(),
        checks: z
          .array(
            z
              .object({
                name: safeText,
                sha: text,
                status: z.enum(["success", "pending", "failure"]),
              })
              .strict(),
          )
          .max(128),
        feedback: z
          .array(
            z
              .object({
                nodeId: text,
                kind: text,
                author: safeText,
                body: safeText,
                commitSha: safeText,
                updatedAt: text,
                state: text,
              })
              .strict(),
          )
          .max(128),
      })
      .strict()
      .nullable(),
    actions: z
      .array(
        z
          .object({
            operationId: uuid,
            kind: text,
            state: text,
            reason: safeText,
            createdAt: time,
            updatedAt: time,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const searchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(256),
    projectId: uuid.optional(),
    type: z.enum(["task", "decision", "result"]).optional(),
    after: z.coerce.number().int().nonnegative().optional(),
    before: z.coerce.number().int().nonnegative().optional(),
    historical: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    cursor: z
      .string()
      .regex(/^[a-f0-9-]{36}(?::decision:[0-9]+)?$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const searchReadSchema = envelope(
  z
    .object({
      matches: z
        .array(
          z
            .object({
              recordId: text,
              type: z.enum(["task", "decision", "result"]),
              taskId: uuid,
              projectId: uuid,
              projectName: safeText,
              taskTitle: safeText,
              sourceId: uuid.nullable(),
              resultId: uuid.nullable(),
              excerpt: safeText,
              createdAt: time,
              historical: z.boolean(),
              href: text,
            })
            .strict(),
        )
        .max(50),
      nextCursor: text.nullable(),
      coverage: z.literal("retained-records-only"),
      omittedCount: time,
    })
    .strict(),
);
export const taskSchema = envelope(
  z
    .object({
      task: z
        .object({
          id: uuid,
          projectId: uuid,
          title: safeText,
          outcome: safeText,
          version: revision,
          state: taskState,
          ready: z.boolean(),
        })
        .strict(),
      lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
      leadAssignmentId: uuid.nullable().optional(),
      assignments: z.array(assignmentSchema),
      admission: z
        .object({
          eligible: z.boolean(),
          reasons: z.array(
            z.enum([
              "project-paused",
              "project-lead-unconfigured",
              "project-lead-revoked",
              "task-unready",
              "task-not-open",
              "local-dependency",
              "imported-blockers-unknown",
              "imported-blockers-blocked",
              "source-held",
              "admission-blocked",
            ]),
          ),
        })
        .strict(),
      execution: executionSchema,
      localDependencies: z.array(
        z.object({ id: uuid, title: safeText, state: taskState }).strict(),
      ),
      source,
      messages: z.array(message),
      results: z.array(result),
      unresolvedResults: z.array(unresolvedResultSchema),
      questions: z.array(interaction),
      approvals: z.array(interaction),
      completionRequests: z.array(completion),
      attention: z
        .object({
          interactions: z.array(
            z
              .object({
                attentionId: uuid,
                interactionId: uuid,
                status: z.enum(["open", "resolved"]),
                revision,
                createdAt: time,
                resolvedAt: time.nullable(),
              })
              .strict(),
          ),
          completions: z.array(
            z
              .object({
                requestId: uuid,
                status: z.enum(["pending", "rejected", "finalized"]),
                revision,
              })
              .strict(),
          ),
          routingFallbacks: z.array(
            z
              .object({
                eventId: uuid,
                operationId: uuid,
                reasonCode: z.literal("routing-fallback"),
                createdAt: time,
              })
              .strict(),
          ),
        })
        .strict(),
      review: taskReviewReadSchema.optional(),
      delivery: deliveryReadSchema.optional(),
      commentPolicy: z
        .object({
          available: z.boolean(),
          mode: z.enum(["allow", "approval"]).nullable(),
          reason: safeText,
        })
        .strict()
        .optional(),
      contentUnavailable: z.boolean(),
    })
    .strict(),
);
const binding = {
  workId: z.string().min(1),
  taskId: uuid,
  assignmentId: uuid,
  assignmentVersion: revision,
  instructionsRevision: revision,
  profileRevision: revision,
  conversationRevision: revision,
  workRevision: revision,
  threadId: z.string().min(1),
  turnId: z.string().min(1),
};
export const assignmentHistorySchema = envelope(
  z
    .object({
      visibilityRevision: hash.optional(),
      items: z.array(
        z
          .object({
            ...binding,
            sequence: revision,
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
            deltaBytes: time,
            createdAt: time,
            updatedAt: time,
          })
          .strict(),
      ),
      turnOmissions: z.array(
        z
          .object({
            ...binding,
            sequence: revision,
            reason: z.literal("early-buffer-limit"),
            createdAt: time,
          })
          .strict(),
      ),
      omittedItemCount: time,
      omittedTurnCount: z.number().int().nonnegative(),
    })
    .strict(),
);
const base = { key: uuid };
const domainBase = { ...base, projectId: uuid };
export const operatorCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...domainBase,
      type: z.literal("task.create"),
      taskId: uuid,
      title: z.string().trim().min(1).max(512),
      outcome: text,
      ready: z.boolean(),
      blockerTaskIds: z
        .array(uuid)
        .max(128)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
      initialAssignment: z
        .object({ assignmentId: uuid, profileId: uuid })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("task.configure"),
      taskId: uuid,
      expectedVersion: revision,
      title: z.string().trim().min(1).max(512).optional(),
      outcome: text.optional(),
      ready: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("dependency.add"),
      taskId: uuid,
      blockerTaskId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("dependency.remove"),
      taskId: uuid,
      blockerTaskId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("assignment.apply"),
      assignmentId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("message"),
      taskId: uuid,
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
      message: z.string().trim().min(1).max(16000),
      reference: feedbackReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answer: z.string().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.form.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answers: questionAnswersSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.native.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answers: z
        .record(
          z.string().min(1).max(512),
          z
            .object({
              answers: z.array(z.string().min(1).max(16000)).length(1),
            })
            .strict(),
        )
        .superRefine((value, ctx) => {
          if (
            new TextEncoder().encode(JSON.stringify(value)).byteLength >
            questionPayloadLimit
          )
            ctx.addIssue({
              code: "custom",
              message: "Answer payload exceeds limit",
            });
        }),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.decide"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      decision: z.enum(["approved", "denied"]),
      action: text,
      target: text.optional(),
      material: materialSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("result.recipient"),
      taskId: uuid,
      resultId: uuid,
      expectedRevision: revision,
      recipientAssignmentId: uuid,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("project.create"),
      name: z.string().trim().min(1).max(512),
      leadProfileId: uuid.nullable(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("project.configure"),
      expectedVersion: revision,
      name: z.string().trim().min(1).max(512).optional(),
      paused: z.boolean().optional(),
      leadProfileId: uuid.nullable().optional(),
      instructions: text.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.create"),
      profileId: uuid,
      name: z.string().trim().min(1).max(512),
      instructions: text,
      capabilities: text,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.configure"),
      profileId: uuid,
      expectedVersion: revision,
      name: z.string().trim().min(1).max(512).optional(),
      instructions: text.optional(),
      capabilities: text.optional(),
      revoked: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("routing.configure"),
      expectedVersion: revision,
      enabled: z.boolean(),
      guidance: text,
      credentialRef: z
        .string()
        .regex(/^env:[A-Z][A-Z0-9_]*$/)
        .nullable()
        .optional(),
      candidateProfileIds: z
        .array(uuid)
        .max(128)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.configure"),
      expectedVersion: revision,
      ...githubConfigurationSchema.shape,
      credentialRef: githubConfigurationSchema.shape.credentialRef.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("capacity.configure"),
      globalLimit: revision,
      projectOverrides: z.record(uuid, revision.nullable()),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.preview"),
      selectionId: z.string().trim().min(1).max(512),
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.place"),
      taskId: uuid,
      chosenProjectId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.view"),
      taskId: uuid,
      sourceId: uuid.nullable(),
      resultIds: z.array(uuid).max(128),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("delivery.refresh"), taskId: uuid })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.review"),
      taskId: uuid,
      operationId: uuid,
      expectedTaskVersion: revision,
      body: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.confirm"),
      taskId: uuid,
      reviewId: uuid,
      expectedRevision: revision,
      materialHash: hash,
      decision: z.enum(["approved", "denied"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.send"),
      taskId: uuid,
      expectedTaskVersion: revision,
      body: z.string().trim().min(1).max(16000),
      reviewId: uuid.optional(),
    })
    .strict(),
]);
export const configurationReceiptSchema = z
  .object({
    kind: z.literal("configuration"),
    key: uuid,
    recorded: z.literal(true),
    result: z.discriminatedUnion("commandType", [
      z
        .object({
          commandType: z.enum(["project.create", "project.configure"]),
          resourceId: uuid,
          version: revision,
          paused: z.boolean(),
          leadProfileId: uuid.nullable(),
          instructionsRevision: revision,
        })
        .strict(),
      z
        .object({
          commandType: z.enum(["profile.create", "profile.configure"]),
          resourceId: uuid,
          version: revision,
          revoked: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("routing.configure"),
          resourceId: uuid,
          version: revision,
          enabled: z.boolean(),
          credentialConfigured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.configure"),
          resourceId: uuid,
          version: revision,
          credentialConfigured: z.boolean(),
          selectionCount: time,
          repositoryCount: time,
        })
        .strict(),
      z
        .object({
          commandType: z.literal("capacity.configure"),
          resourceId: z.literal("system:capacity"),
          globalLimit: revision,
          defaultProjectLimit: z.literal(2),
          projectOverrides: z.record(uuid, revision),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.preview"),
          resourceId: uuid,
          selectionId: z.string().min(1).max(512),
          configVersion: revision,
          active: z.literal(true),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.place"),
          resourceId: uuid,
          projectId: uuid,
          version: revision,
        })
        .strict(),
    ]),
  })
  .strict();
export const runtimeSettingsSchema = envelope(
  z
    .object({
      globalLimit: revision,
      defaultProjectLimit: z.literal(2),
      globalUsage: time,
      projects: z.array(
        z
          .object({
            project: projectSummarySchema,
            limit: revision,
            usage: time,
            override: revision.nullable(),
            tasks: z.array(
              z
                .object({
                  taskId: uuid,
                  title: safeText,
                  paused: z.boolean(),
                  held: z.boolean(),
                  assignments: z.array(
                    z.object({ assignmentId: uuid, name: safeText }).strict(),
                  ),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
);
export const recoveryObservationSchema = z.enum([
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
]);
const recoveryHolds = z
  .object({
    stop: z.boolean(),
    writer: z.boolean(),
    capacity: z.boolean(),
    uncertainty: z.boolean(),
    task: z.boolean(),
  })
  .strict();
export const assignmentRecoverySchema = envelope(
  z
    .object({
      assignment: assignmentSchema,
      taskId: uuid,
      project: projectSummarySchema,
      held: z.boolean(),
      holds: recoveryHolds,
      evidenceAvailable: z.boolean(),
      omittedCount: time,
      records: z
        .array(
          z
            .object({
              workId: safeText,
              generation: z
                .object({
                  workRevision: revision.nullable(),
                  requestSequence: revision,
                })
                .strict(),
              binding: z
                .object({
                  assignmentId: uuid,
                  assignmentVersion: revision,
                  instructionsRevision: revision,
                  profileRevision: revision,
                })
                .strict()
                .nullable(),
              intentState: z.enum([
                "ready",
                "capacity-waiting",
                "held",
                "submitting",
                "running",
                "completed",
                "reconciled",
                "resolved-failed",
                "unknown",
              ]),
              requestState: z
                .enum(["queued", "active", "completed", "held", "unknown"])
                .nullable(),
              holds: recoveryHolds,
              observations: z.array(recoveryObservationSchema).max(12),
              pendingEffectCount: time,
              noTurnSubmission: z
                .object({
                  id: uuid,
                  source: z.literal("operator-adopted"),
                  idleThreadMayExist: z.literal(true),
                })
                .strict()
                .optional(),
              preTurnRejection: z
                .object({
                  id: uuid,
                  source: z.enum(["runtime", "operator-adopted"]),
                  predecessorThreadId: safeText,
                })
                .strict()
                .optional(),
              receiptRecorded: z.boolean(),
              workspace: z.enum(["preserved", "reconciled", "unknown"]),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
);
export const sourceObservationSchema = envelope(
  z
    .object({
      projects: z.array(
        z
          .object({
            projectId: uuid,
            selections: z.array(
              z
                .object({
                  selectionId: safeText,
                  state: z.enum([
                    "complete",
                    "partial",
                    "never",
                    "unavailable",
                  ]),
                  lastAttemptAt: z.string().nullable(),
                  lastSuccessfulAt: z.string().nullable(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
);
export const profileConfigurationSchema = envelope(
  z
    .object({
      profile: profileSummarySchema,
      instructionPresent: z.boolean(),
      instructionRevision: revision,
      capabilities: safeText,
    })
    .strict(),
);
export const projectConfigurationSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      profiles: z.array(profileSummarySchema),
      instructionsRevision: revision,
      instructionPresent: z.boolean(),
      routing: z
        .object({
          version: revision,
          enabled: z.boolean(),
          candidateProfileIds: z.array(uuid),
          credentialConfigured: z.boolean(),
          availability: z.enum([
            "available",
            "disabled",
            "missing-client-credentials",
            "no-eligible-candidates",
          ]),
        })
        .strict(),
      placements: z.array(
        z
          .object({
            taskId: uuid,
            projectId: uuid,
            version: revision,
            title: safeText,
            choices: z.array(projectSummarySchema),
          })
          .strict(),
      ),
      source: z
        .object({
          version: revision,
          credentialConfigured: z.boolean(),
          selections: z.array(
            z
              .object({
                id: safeText,
                kind: z.enum(["repository", "search", "project"]),
                descriptor: safeText,
                active: z.boolean(),
              })
              .strict(),
          ),
          readiness: readinessSchema.nullable(),
          repositories: z.array(
            z.object({ repositoryId: safeText, ref: safeText }).strict(),
          ),
        })
        .strict(),
    })
    .strict(),
);
export const questionReadSchema = z
  .object({
    data: z
      .object({
        taskId: uuid,
        interactionId: uuid,
        requestingAssignmentId: uuid,
        conversationRevision: revision,
        revision,
        source: z.enum(["plain", "ensemble", "native"]),
        status: z.enum([
          "pending",
          "recorded",
          "stale",
          "cancelled",
          "offline",
          "unsupported",
          "unavailable",
        ]),
        form: questionFormSchema.nullable(),
        answers: questionAnswersSchema.nullable(),
        reason: safeText,
        deliveryState: safeText,
      })
      .strict(),
    observedAt: time,
  })
  .strict();
export type QuestionRead = z.infer<typeof questionReadSchema>;
export const inboxItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["question", "approval", "intervention"]),
    urgency: z.number().int().min(0).max(1),
    createdAt: time.nullable(),
    taskId: uuid,
    projectId: uuid,
    projectName: safeText,
    taskTitle: safeText,
    requestingAssignmentId: uuid.nullable(),
    requesterName: safeText,
    interactionId: uuid.nullable(),
    revision: revision.nullable(),
    reason: safeText,
    destination: z.string().max(512),
    evidence: z.string().max(512),
    conversation: z.string().max(512).nullable(),
  })
  .strict();
export const inboxReadSchema = z
  .object({
    data: z
      .object({
        items: z.array(inboxItemSchema).max(100),
        nextCursor: z.string().max(256).nullable(),
        complete: z.boolean(),
        unavailable: z.boolean(),
      })
      .strict(),
    observedAt: time,
  })
  .strict();
export type InboxItem = z.infer<typeof inboxItemSchema>;
// Fixed strict command envelope maxima; question JSON independently remains <=256 KiB.
export const questionCommandRawLimit =
  questionPayloadLimit +
  new TextEncoder().encode(
    JSON.stringify({
      type: "question.native.answer",
      key: "f".repeat(36),
      taskId: "f".repeat(36),
      interactionId: "f".repeat(36),
      expectedRevision: Number.MAX_SAFE_INTEGER,
      answers: {},
    }),
  ).byteLength -
  2;

export const commandReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native-question"),
      key: uuid,
      taskId: uuid,
      interactionId: uuid,
      revision,
      recorded: z.literal(true),
      deliveryState: z.literal("recorded"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      operation: z.enum(["review.view", "delivery.refresh"]),
    })
    .strict(),
  configurationReceiptSchema,
  z
    .object({
      kind: z.literal("domain"),
      key: uuid,
      recorded: z.literal(true),
      result: z.union([
        z
          .object({
            id: uuid,
            projectId: uuid,
            version: revision,
            state: taskState,
            ready: z.boolean(),
          })
          .strict(),
        z
          .object({
            id: uuid,
            taskId: uuid,
            projectId: uuid,
            version: revision,
            profileRevision: revision,
            instructionsRevision: revision,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("coordination"),
      key: uuid,
      recorded: z.literal(true),
      eventId: uuid,
      taskId: uuid,
      recipientAssignmentId: uuid,
      eventType: z.string(),
      createdAt: time,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comment-review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      reviewId: uuid,
      operationId: uuid,
      revision,
      materialHash: hash,
      decision: z.enum(["pending", "approved", "denied"]),
      body: safeText,
      target: z
        .object({ repositoryId: text, nodeId: text, number: revision })
        .strict(),
      taskVersion: revision,
      sourceId: uuid,
      sourceRevision: revision,
      sourceDigest: hash,
      policyVersion: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delivery"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      operationId: uuid,
      state: z.enum([
        "prepared",
        "attempting",
        "uncertain",
        "confirmed-success",
        "confirmed-failure",
        "denied",
      ]),
      reason: safeText,
    })
    .strict(),
]);
export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthenticated",
          "forbidden",
          "not-found",
          "method-not-allowed",
          "invalid-input",
          "unsupported-media",
          "body-too-large",
          "conflict",
          "unavailable",
          "command-outcome-unknown",
        ]),
        message: z.string().max(256),
        fieldPaths: z.array(z.string().max(128)).optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceComparisonRead = z.infer<
  typeof workspaceComparisonReadSchema
>;
export type TaskRead = z.infer<typeof taskSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Session = z.infer<typeof sessionSchema>;
