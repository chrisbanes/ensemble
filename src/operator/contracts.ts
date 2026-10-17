import { z } from "zod";
import { commentReasonCodes } from "./github-reasons.js";
import { waitCodes, waitSchema } from "./wait-reasons.js";
import { attentionCodes, attentionCodeSchema } from "./attention.js";
import { discoveryCredentialReference } from "../core/credential-reference.js";
import {
  closedIssuesSchema,
  githubConfigurationSchema,
  githubConfigurationCommandSchema,
  readinessConditionSchema,
  readinessSchema,
  setupRepositoriesSchema,
  setupRepositorySchema,
} from "../core/github-source-contracts.js";
import {
  retainedEvidenceIdentitySchema,
  retainedEvidenceSourceObservationSchema,
  reviewAnchorRecordBaseSchema,
  reviewAnchorSelectionSchema,
} from "../core/review-anchor-contracts.js";
import {
  workspaceComparisonAnchorBase,
  workspaceComparisonContentBase,
  workspaceComparisonEntryBase,
  workspaceComparisonHunkBase,
  workspaceComparisonSnapshotBase,
  workspaceTurnCaptureReasonSchema,
  workspaceTurnComparisonBase,
  workspaceTurnIdentityBase,
} from "../core/workspace-comparison-contracts.js";
import {
  questionAnswersSchema,
  questionFormSchema,
  questionPayloadLimit,
} from "../core/question-forms.js";
import {
  feedbackReferenceSchema,
  taskReviewReadSchema,
} from "../core/task-review-contracts.js";
import {
  historicalNoTurnAdoptionBodySchema,
  historicalPreTurnAdoptionBodySchema,
  noTurnRecoveryBodySchema,
  preTurnRecoveryBodySchema,
  recoveryPaths,
  replaceConversationBodySchema,
} from "../core/recovery-contracts.js";
import {
  executionHarnessSchema,
  executionIntentStateSchema,
  profileRuntimeSchema,
  supportedRuntimeSettingsSchema,
} from "../core/execution-runtime.js";
export {
  executionHarnessLabels,
  type ExecutionHarness,
  type ProfileRuntime,
  runtimeSummary,
  type SupportedRuntimeSettings,
  unsupportedRuntimeField,
} from "../core/execution-runtime.js";
export const uuid = z.string().uuid();
const revision = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
/** The most Unicode characters (code points, as zod counts them) any operator text field takes. */
export const textMaxLength = 16000;
const text = z.string().max(textMaxLength);
/** Whether `value` fits a text field, by the same check the service applies. */
export const fitsTextField = (value: string) => text.safeParse(value).success;
const safeText = text.nullable();
const attentionCodesSchema = z
  .array(attentionCodeSchema)
  .max(attentionCodes.length);
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
  .object({
    id: uuid,
    name: safeText,
    summary: safeText,
    version: revision,
    revoked: z.boolean(),
  })
  .strict();
const envelope = <T extends z.ZodType>(schema: T) =>
  z.object({ data: schema, observedAt: time }).strict();
/** What a harness enforces and its disclosed limits; null until disclosable. */
const policyDisclosureSchema = z
  .object({
    lines: z.array(z.string().max(300)).max(10),
    limits: z.array(z.string().max(300)).max(12),
  })
  .strict();
const harnessStatusBase = {
  harness: executionHarnessSchema,
  policy: policyDisclosureSchema.nullable(),
  /** Null until the runtime has read them; then the server validates against them. */
  settings: supportedRuntimeSettingsSchema.nullable(),
};
/** A closed set chosen by the service; runtime error text is never carried (it can hold secrets). */
export const runtimeRestartFailureSchema = z.enum([
  "exited",
  "start-failed",
  "start-timed-out",
  "spawn-failed",
]);
export type RuntimeRestartFailure = z.infer<typeof runtimeRestartFailureSchema>;
export const runtimeRestartAttemptSchema = z
  .object({
    attempt: z.number().int().min(1).max(3),
    at: time,
    outcome: z.enum(["started", "failed"]),
    failure: runtimeRestartFailureSchema.nullable(),
  })
  .strict();
export type RuntimeRestartAttempt = z.infer<typeof runtimeRestartAttemptSchema>;
/** In memory only. `attempt` of a pending retry is the next attempt number. */
export const runtimeRestartSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending"),
      attempt: z.number().int().min(1).max(3),
      nextAt: time,
      lastFailure: runtimeRestartFailureSchema,
      attempts: z.array(runtimeRestartAttemptSchema).max(3),
    })
    .strict(),
  z
    .object({
      state: z.literal("exhausted"),
      since: time,
      lastFailure: runtimeRestartFailureSchema,
      attempts: z.array(runtimeRestartAttemptSchema).max(3),
    })
    .strict(),
]);
export type RuntimeRestart = z.infer<typeof runtimeRestartSchema>;
/**
 * One per harness; `enabled` is the operator's persisted setting. `not-configured` (shown as
 * "Not enabled") is a disabled runtime, or an enabled one whose executable is not on the service
 * `PATH`; `unavailable` is an enabled runtime that failed to start or failed later.
 */
export const harnessStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("available"),
    })
    .strict(),
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("not-configured"),
      reason: z.enum(["disabled", "executable-missing"]),
    })
    .strict(),
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("unavailable"),
      since: time,
      /** Absent while an attempt runs, or when nothing is scheduled. */
      restart: runtimeRestartSchema.optional(),
    })
    .strict(),
]);
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;
/** Workspace profile rows also carry the current revision's execution runtime. */
const workspaceProfileSchema = profileSummarySchema
  .extend({ runtime: profileRuntimeSchema })
  .strict();
export const workspaceSchema = envelope(
  z
    .object({
      projects: z.array(projectSummarySchema),
      profiles: z.array(workspaceProfileSchema),
      runtime: z.discriminatedUnion("state", [
        z.object({ state: z.literal("available") }).strict(),
        z.object({ state: z.literal("unavailable"), since: time }).strict(),
      ]),
      harnesses: z.array(harnessStatusSchema),
      /** Installation facts for the getting-started checklist. */
      gettingStarted: z
        .object({ turnStarted: z.boolean(), dismissed: z.boolean() })
        .strict(),
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
      maxCanvasPixels: z
        .number()
        .int()
        .positive()
        .max(16_000_000)
        .safe()
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mime === "application/pdf") {
        if (value.maxDisplayedPages === undefined)
          context.addIssue({
            code: "custom",
            message: "PDF preview requires a displayed-page limit",
          });
        if (value.maxCanvasPixels === undefined)
          context.addIssue({
            code: "custom",
            message: "PDF preview requires a canvas-pixel limit",
          });
      } else if (
        value.maxDisplayedPages !== undefined ||
        value.maxCanvasPixels !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "PDF limits are only valid for PDF previews",
        });
      }
    }),
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
const retainedEvidenceAvailableItemSchema = z
  .object({
    itemId: uuid,
    kind: z.enum(["file", "diff"]),
    state: z.literal("available"),
    source: z.enum(["artifact-file", "change-file", "observed-diff"]),
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    artifactId: uuid.optional(),
    mime: z.string().min(1).max(128),
    sha256: hash,
    size: z.number().int().nonnegative().safe(),
    capturedAt: time,
    observedAt: time.nullable(),
    provenance: z.record(z.string().max(80), scalar),
  })
  .strict();
const retainedEvidenceItemReadSchema = z.discriminatedUnion("state", [
  retainedEvidenceAvailableItemSchema,
  z
    .object({
      itemId: uuid,
      kind: z.enum(["file", "diff"]),
      state: z.literal("gap"),
      reason: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      itemId: uuid,
      kind: z.enum(["file", "diff"]),
      state: z.literal("unavailable"),
      reason: z.enum(["excluded", "unavailable"]),
    })
    .strict(),
]);
export const retainedResultEvidenceReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        state: z.enum(["empty", "available", "partial", "gap"]),
        evidenceId: uuid,
        // The result route supplies the task; the identity does not repeat it.
        identity: retainedEvidenceIdentitySchema.omit({ taskId: true }),
        capturedAt: time,
        sourceObservation: retainedEvidenceSourceObservationSchema,
        items: z.array(retainedEvidenceItemReadSchema).max(320),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["not-retained", "excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
export const retainedEvidenceItemContentReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("available"),
        item: retainedEvidenceAvailableItemSchema,
        preview: workspacePreviewDataSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("gap"),
        reason: z.string().min(1).max(80),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
// Reads stay open-ended on `reason`; the store records the closed gap-reason enum.
const retainedReviewAnchorRecordSchema = reviewAnchorRecordBaseSchema
  .extend({ reason: z.string().min(1).max(80).optional() })
  .strict();
export const retainedReviewAnchorReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("available"),
        status: z.enum(["current", "outdated", "unknown"]),
        anchor: retainedReviewAnchorRecordSchema.extend({
          state: z.literal("available"),
        }),
        preview: workspacePreviewDataSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("gap"),
        status: z.literal("unavailable"),
        anchor: retainedReviewAnchorRecordSchema.extend({
          state: z.literal("gap"),
        }),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
// Each schema below extends its shared lenient base with this layer's stricter
// rules (UUIDs, bounds, non-negative times). An `.extend` does not reach into
// child schemas, so every tightened child is re-declared one level up.
const workspaceComparisonContentSchema = workspaceComparisonContentBase
  .extend({ modifiedAt: time.nullable().optional() })
  .strict();
const workspaceComparisonAnchorSchema = workspaceComparisonAnchorBase
  .extend({
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    workId: z.string().min(1).max(512).optional(),
    resultId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((anchor) => anchor.endLine >= anchor.startLine);
const workspaceComparisonHunkSchema = workspaceComparisonHunkBase
  .extend({
    leftAnchor: workspaceComparisonAnchorSchema.optional(),
    rightAnchor: workspaceComparisonAnchorSchema.optional(),
  })
  .strict();
const workspaceComparisonEntrySchema = workspaceComparisonEntryBase
  .extend({
    path: z.string().min(1).max(2048),
    repositoryId: z.string().min(1).max(512).nullable().optional(),
    previousPath: z.string().min(1).max(2048).optional(),
    left: workspaceComparisonContentSchema.optional(),
    right: workspaceComparisonContentSchema.optional(),
    hunks: z.array(workspaceComparisonHunkSchema).max(2048),
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
const workspaceRepositoryComparisonSchema = workspaceComparisonSnapshotBase
  .extend({
    taskId: uuid,
    repositoryId: z.string().min(1).max(512),
    baseline: workspaceComparisonSnapshotBase.shape.baseline
      .unwrap()
      .extend({ branch: z.string().min(1).max(255).optional() })
      .strict()
      .optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    availableBaseBranches: z.array(z.string().min(1).max(255)).max(4096),
    entries: workspaceComparisonEntriesSchema,
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceTurnComparisonSchema = workspaceTurnComparisonBase
  .extend({
    taskId: uuid,
    workId: z.string().min(1).max(512),
    assignmentId: z.string().min(1).max(512),
    profileId: uuid,
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    entries: workspaceComparisonEntriesSchema,
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceComparisonSnapshotSchema = z.union([
  workspaceRepositoryComparisonSchema,
  workspaceTurnComparisonSchema,
]);
const workspaceTurnCaptureIdentitySchema = workspaceTurnIdentityBase
  .extend({
    taskId: uuid,
    workId: z.string().min(1).max(512),
    assignmentId: z.string().min(1).max(512),
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
    reason: workspaceTurnCaptureReasonSchema.optional(),
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
// The server only builds https GitHub URLs; reject javascript: and data: links.
const sourceUrl = z.url().startsWith("https://");
/**
 * Provider-closure provenance: closed on GitHub while held, completed by that closure, or
 * held because GitHub's closure could not be attributed to Ensemble's own delivery.
 */
const sourceClosure = z.enum(["held", "completed", "unattributed"]).nullable();
/**
 * A project's readiness rule as a read may show it: `none` only for a stored null rule
 * (no filtering); `unavailable` when disclosure is withheld, so no condition text leaves.
 */
export const readinessRuleViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({
      kind: z.literal("rule"),
      mode: readinessSchema.shape.mode,
      conditions: readinessSchema.shape.conditions,
    })
    .strict(),
]);
/** Why an imported task is Draft under the rule; matching is never Ready or admissible. */
export const taskReadinessSchema = z
  .object({
    rule: readinessRuleViewSchema,
    outcome: z.enum(["matched", "unmet", "not-evaluated"]),
    unmet: z.array(readinessConditionSchema).max(20),
  })
  .strict();
const observationCount = z.number().int().nonnegative();
/** Per-selection counts from stored observations; never summed across selections. */
export const selectionCountsSchema = z
  .object({
    observed: observationCount,
    open: observationCount,
    closedSkipped: observationCount,
    matching: observationCount.nullable(),
    complete: z.boolean(),
  })
  .strict();
export const taskSourceSummarySchema = z
  .object({
    identity: sourceIdentity,
    repositoryName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    number: revision.nullable(),
    url: sourceUrl.nullable(),
    state: z.enum(["open", "closed"]).nullable(),
    closure: sourceClosure,
    readiness: taskReadinessSchema,
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
        codes: attentionCodesSchema,
        count: time,
      })
      .strict(),
  })
  .strict();
export const taskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: uuid.optional(),
    projectId: uuid.optional(),
    state: taskState.optional(),
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
              /** Whether it would hold a new dependent, by admission's rule. */
              blocking: z.boolean(),
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
      /** Project-level waits a new task would have; the composer adds selected dependencies. */
      waits: z.array(waitSchema).max(waitCodes.length),
      /** Runtime waits per permitted profile, used in place of the lead's when it is the explicit assignee. */
      assigneeWaits: z.record(uuid, z.array(waitSchema).max(3)),
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
    harness: executionHarnessSchema.nullable(),
    /** The latest failed turn's bounded classification; null when none failed. */
    failure: z
      .object({
        classification: z.enum(["transient", "permanent", "unknown"]),
        reasonCode: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
      })
      .strict()
      .nullable(),
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
    /** The execution runtime of the captured profile revision. */
    runtime: profileRuntimeSchema,
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
    requester: z.enum(["assignment", "operator"]).optional(),
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
    url: sourceUrl.nullable(),
    title: safeText,
    body: safeText,
    state: z.enum(["open", "closed"]).nullable(),
    closure: sourceClosure,
    readiness: taskReadinessSchema,
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
        /** Built by the server for the PR's own repository only; the web renders no other link. */
        url: z.url().startsWith("https://github.com/").optional(),
        draft: z.boolean().optional(),
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
      leadFeedback: z
        .object({
          mode: z.enum(["receives", "resumes", "unavailable"]),
          awaitingRecoveryMessage: z.boolean(),
        })
        .strict()
        .optional(),
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
      waits: z.array(waitSchema).max(waitCodes.length),
      execution: executionSchema,
      // The recorded reason of a task hold other than Stop; null when there is none.
      taskHold: z.object({ reason: safeText }).strict().nullable(),
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
          codes: attentionCodesSchema,
          count: time,
        })
        .strict(),
      review: taskReviewReadSchema.optional(),
      delivery: deliveryReadSchema.optional(),
      commentPolicy: z
        .object({
          available: z.boolean(),
          mode: z.enum(["allow", "approval"]).nullable(),
          reason: safeText,
          /** Why a comment cannot be posted; absent from older servers. `available` and `reason` are unchanged. */
          reasonCode: z.enum(commentReasonCodes).nullable().optional(),
        })
        .strict()
        .optional(),
      /** True when the task's project links at least one GitHub repository; no names or paths. */
      repositoryLinked: z.boolean().optional(),
      contentUnavailable: z.boolean(),
    })
    .strict(),
);
/** Paged results or messages of one task, projected exactly as in `taskSchema`. */
export const taskRecordQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: uuid.optional(),
    resultId: uuid.optional(),
  })
  .strict()
  .refine((q) => !(q.cursor && q.resultId));
export const taskResultPageSchema = envelope(
  z
    .object({
      results: z.array(result).max(200),
      total: time,
      nextCursor: uuid.nullable(),
    })
    .strict(),
);
export const taskMessagePageSchema = envelope(
  z
    .object({
      messages: z.array(message).max(200),
      total: time,
      nextCursor: uuid.nullable(),
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
const localReviewCommentSchema = z
  .object({
    commentId: uuid,
    body: z.string().trim().min(1).max(4000),
    // Reads accept stored drafts from before the anchor rule.
    anchorGroupIds: z.array(uuid).max(32),
  })
  .strict();
const localReviewDraftContentSchema = z
  .object({
    summary: z.string().trim().max(4000),
    comments: z.array(localReviewCommentSchema).max(32),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const ids = draft.comments.flatMap((comment) => comment.anchorGroupIds);
    if (
      new Set(draft.comments.map((comment) => comment.commentId)).size !==
        draft.comments.length ||
      new Set(ids).size !== ids.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate-local-review-reference",
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
    if (bytes > 16000)
      ctx.addIssue({ code: "custom", message: "local-review-batch-too-large" });
  });
/** Saved drafts bind every comment to exact anchor context. */
const localReviewDraftWriteSchema = localReviewDraftContentSchema.refine(
  (draft) =>
    draft.comments.every((comment) => comment.anchorGroupIds.length > 0),
  { message: "local-review-comment-anchor-required" },
);
export const localReviewDraftReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      version: z.number().int().nonnegative().safe(),
      state: z.enum(["editable", "sending", "sent"]),
      draft: localReviewDraftContentSchema,
      accessFingerprint: z.string().max(128).nullable(),
      updatedAt: time.nullable(),
      pendingOperation: z
        .object({
          key: uuid,
          recipientAssignmentId: uuid,
          expectedAssignmentVersion: revision,
        })
        .strict()
        .nullable(),
      groups: z
        .array(
          z
            .object({
              groupId: uuid,
              anchorIds: z.array(uuid).max(32),
              state: z.enum(["open", "sealed", "discarded"]),
              submittedContextId: uuid.nullable(),
              createdAt: time,
            })
            .strict(),
        )
        .max(1024),
      unsentDraftLost: z.boolean(),
    })
    .strict(),
);
const localReviewOperationAnchorSchema = z.union([
  z
    .object({
      anchorId: uuid,
      state: z.literal("unavailable"),
      reason: z.enum(["excluded", "unavailable"]),
    })
    .strict(),
  z
    .object({
      anchorId: uuid,
      state: z.enum(["available", "gap"]),
      status: z.enum(["current", "outdated", "unknown"]).optional(),
      path: z.string().min(1).max(2048),
      context: z.enum(["workspace", "branch", "uncommitted", "turn", "result"]),
      startLine: revision,
      endLine: revision,
    })
    .strict(),
]);
/** Recorded reviews for a task, newest first; unsent operations are never listed. */
export const localReviewListReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      reviews: z
        .array(
          z
            .object({
              operationId: uuid,
              reviewId: uuid,
              recipientAssignmentId: uuid,
              eventId: uuid,
              recordedAt: time,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
);
export const localReviewOperationReadSchema = envelope(
  z
    .object({
      operationId: uuid,
      taskId: uuid,
      reviewId: uuid,
      state: z.enum(["prepared", "recorded", "rejected", "not-recorded"]),
      eventId: uuid.optional(),
      recipientAssignmentId: uuid.optional(),
      reason: z.string().max(128).optional(),
      recordedAt: time.optional(),
      resumedLead: z.literal(true).optional(),
      summary: z.string().max(16000).nullable().optional(),
      comments: z
        .array(
          z
            .object({
              commentId: uuid,
              body: z.string().max(4000).nullable(),
              anchorGroupIds: z.array(uuid).max(32),
            })
            .strict(),
        )
        .max(32)
        .optional(),
      groups: z
        .array(
          z
            .object({
              groupId: uuid,
              anchors: z.array(localReviewOperationAnchorSchema).max(32),
            })
            .strict(),
        )
        .max(32)
        .optional(),
    })
    .strict(),
);
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
      type: z.literal("review.anchor.stage"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      anchors: z.array(reviewAnchorSelectionSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.draft.save"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      draft: localReviewDraftWriteSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.draft.discard"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.send"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.send.reconcile"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
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
      instructions: text.optional(),
      repositories: setupRepositoriesSchema.optional(),
      githubProject: z
        .object({ projectNodeId: z.string().trim().min(1).max(512) })
        .strict()
        .optional(),
      sourceCredentialRef: z.literal("gh:github.com").optional(),
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
      diagnosticCapture: z.enum(["enhanced", "baseline"]).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.create"),
      profileId: uuid,
      name: z.string().trim().min(1).max(512),
      summary: z.string().trim().max(120).optional(),
      instructions: text,
      capabilities: text,
      runtime: profileRuntimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.configure"),
      profileId: uuid,
      expectedVersion: revision,
      name: z.string().trim().min(1).max(512).optional(),
      summary: z.string().trim().max(120).optional(),
      instructions: text.optional(),
      capabilities: text.optional(),
      revoked: z.boolean().optional(),
      runtime: profileRuntimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("routing.configure"),
      expectedVersion: revision,
      enabled: z.boolean(),
      guidance: text.optional(),
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
      ...githubConfigurationCommandSchema.shape,
      credentialRef: githubConfigurationSchema.shape.credentialRef.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("capacity.configure"),
      globalLimit: revision,
      projectOverrides: z.record(uuid, revision.nullable()),
      /** Optional compare-and-swap: the limits this change was prepared against. */
      expectedCurrent: z
        .object({
          globalLimit: revision,
          projectOverrides: z.record(uuid, revision.nullable()).default({}),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("discovery.configure"),
      credentialRef: discoveryCredentialReference.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("claude-token.configure"),
      /** `env:NAME`, or `file:` and an absolute path with no empty, `.` or `..` segment. */
      credentialRef: z
        .string()
        .max(1024)
        .regex(
          /^(?:env:[A-Z][A-Z0-9_]*|file:(?:\/(?!\.{1,2}(?:\/|$))[^/\0\r\n]+)+)$/,
        )
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("getting-started.configure"),
      dismissed: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("runtime.configure"),
      harness: executionHarnessSchema,
      enabled: z.boolean(),
      /**
       * The bound-task count the operator confirmed. Disabling a runtime that bound tasks
       * use is refused without it, or when the service now counts more.
       */
      confirmedBoundTasks: z.number().int().nonnegative().safe().optional(),
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
  // Optional fence: Stop and Resume act on a hold, so an unrelated edit must not block them.
  z
    .object({
      ...base,
      type: z.literal("task.stop"),
      taskId: uuid,
      expectedVersion: revision.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.resume"),
      taskId: uuid,
      expectedVersion: revision.optional(),
    })
    .strict(),
  // Evidence-bearing recovery: the inner service command plus its assignment scope.
  z
    .object({
      ...base,
      type: z.literal("recovery.pre-turn.adopt"),
      assignmentId: uuid,
      ...historicalPreTurnAdoptionBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.pre-turn.recover"),
      assignmentId: uuid,
      ...preTurnRecoveryBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.no-turn.adopt"),
      assignmentId: uuid,
      ...historicalNoTurnAdoptionBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.no-turn.recover"),
      assignmentId: uuid,
      ...noTurnRecoveryBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.conversation.replace"),
      ...replaceConversationBodySchema.shape,
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
          commandType: z.literal("discovery.configure"),
          resourceId: z.literal("system:discovery"),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("claude-token.configure"),
          resourceId: z.literal("system:claude-token"),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("getting-started.configure"),
          resourceId: z.literal("system:getting-started"),
          dismissed: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("runtime.configure"),
          resourceId: z.enum(["system:runtime:codex", "system:runtime:claude"]),
          harness: executionHarnessSchema,
          enabled: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.preview"),
          resourceId: uuid,
          selectionId: z.string().min(1).max(512),
          configVersion: revision,
          active: z.literal(true),
          alreadyActive: z.boolean().optional(),
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
      /** Each execution runtime's setting and the tasks a disable would make wait. */
      runtimes: z.array(
        z
          .object({
            harness: executionHarnessSchema,
            enabled: z.boolean(),
            boundTasks: time,
          })
          .strict(),
      ),
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
const assignmentRecoveryRecordSchema = z
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
    // "unknown" is operator-only: the API reports it for an unrecognised stored state.
    intentState: z.enum([...executionIntentStateSchema.options, "unknown"]),
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
      records: z.array(assignmentRecoveryRecordSchema).max(20),
    })
    .strict(),
);
/** Closed reasons a recovery path is not currently eligible; advisory, the service decides. */
export const recoveryBlockerSchema = z.enum([
  "not-held",
  "ownership-released",
  "context-unavailable",
  "witness-missing",
  "witness-present",
  "other-witness",
  "already-reconciled",
  "reason-withheld",
  "identity-withheld",
  "task-held",
  "unresolved-execution",
]);
export const recoveryPathSchema = z.enum(recoveryPaths);
const boundedText = z.string().max(4000);
/** Exact recovery identity of one assignment's generations, with advisory eligibility. */
export const recoveryOptionsSchema = envelope(
  z
    .object({
      assignmentId: uuid,
      taskId: uuid,
      projectId: uuid,
      assignmentVersion: revision,
      conversationRevision: revision,
      held: z.boolean(),
      holds: recoveryHolds,
      evidenceAvailable: z.boolean(),
      omittedCount: time,
      /** Exact strings withheld because redaction changed them or was unavailable. */
      gaps: z.array(z.enum(["content-redacted", "redaction-unavailable"])),
      replacement: z
        .object({
          eligible: z.boolean(),
          blockedBy: z.array(recoveryBlockerSchema),
          expectedAssignmentVersion: revision,
          expectedConversationRevision: revision,
        })
        .strict(),
      records: z
        .array(
          z
            .object({
              workId: z.string().max(512).nullable(),
              generation: z
                .object({
                  workRevision: revision.nullable(),
                  requestSequence: revision,
                })
                .strict(),
              intentState: assignmentRecoveryRecordSchema.shape.intentState,
              requestState: assignmentRecoveryRecordSchema.shape.requestState,
              holds: recoveryHolds,
              observations: z.array(recoveryObservationSchema).max(12),
              process: z
                .object({
                  processId: boundedText,
                  processStartedAt: boundedText,
                  bootId: boundedText,
                })
                .strict()
                .nullable(),
              retainedReason: boundedText.nullable(),
              writerSequence: revision.nullable(),
              conversationRevision: revision.nullable(),
              predecessor: z
                .object({ workId: boundedText, threadId: boundedText })
                .strict()
                .nullable(),
              witnesses: z
                .object({
                  preTurn: z
                    .object({
                      id: uuid,
                      source: z.enum(["runtime", "operator-adopted"]),
                    })
                    .strict()
                    .nullable(),
                  noTurn: z.object({ id: uuid }).strict().nullable(),
                })
                .strict(),
              receiptRecorded: z.boolean(),
              workspace: z.enum(["preserved", "reconciled", "unknown"]),
              paths: z
                .array(
                  z
                    .object({
                      path: recoveryPathSchema,
                      eligible: z.boolean(),
                      blockedBy: z.array(recoveryBlockerSchema),
                    })
                    .strict(),
                )
                .max(4),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
);
/** The GitHub CLI login for github.com, detected on every status read. Never the token. */
export const ghLoginStateSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("signed-in"),
      login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    })
    .strict(),
  z
    .object({
      state: z.enum(["not-installed", "not-signed-in", "unreadable"]),
    })
    .strict(),
]);
export const sourceCredentialReasonSchema = z.enum([
  "missing-credential",
  "invalid-credential-reference",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
]);
export const sourceCredentialStatusSchema = z
  .object({
    configured: z.boolean(),
    source: z.enum(["env", "gh"]).nullable(),
    usable: z.boolean(),
    reason: sourceCredentialReasonSchema.nullable(),
    gh: ghLoginStateSchema,
  })
  .strict();

export const sourceObservationSchema = envelope(
  z
    .object({
      projects: z.array(
        z
          .object({
            projectId: uuid,
            credential: sourceCredentialStatusSchema.optional(),
            readiness: readinessRuleViewSchema,
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
                  credentialReason: sourceCredentialReasonSchema
                    .nullable()
                    .optional(),
                  lastAttemptAt: z.string().nullable(),
                  lastSuccessfulAt: z.string().nullable(),
                  counts: selectionCountsSchema.nullable(),
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
      runtime: profileRuntimeSchema,
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
      /** Optional so older services still parse; absent means not reported. */
      diagnosticCapture: z.enum(["enhanced", "baseline"]).optional(),
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
          credential: sourceCredentialStatusSchema.optional(),
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
          readiness: readinessRuleViewSchema,
          closedIssues: closedIssuesSchema,
          repositories: z.array(
            z.object({ repositoryId: safeText, ref: safeText }).strict(),
          ),
        })
        .strict(),
    })
    .strict(),
);
/**
 * Exact private text for one project, readable only by a signed-in web session.
 * Never reuse these schemas in a configuration read, list or CLI output.
 */
export const projectPrivateValuesSchema = envelope(
  z
    .object({
      project: z
        .object({
          version: revision,
          instructionsRevision: revision,
          instructions: text,
        })
        .strict(),
      routing: z.object({ version: revision, guidance: text }).strict(),
      source: z
        .object({
          version: revision,
          searches: z.array(z.object({ id: text, query: text }).strict()),
          repositories: z.array(
            z.object({ repositoryId: text, path: text }).strict(),
          ),
        })
        .strict(),
    })
    .strict(),
);
/** Exact private instructions of one profile, readable only by a signed-in web session. */
export const profilePrivateValuesSchema = envelope(
  z
    .object({
      profile: z.object({ version: revision, instructions: text }).strict(),
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
export const taskInboxItemSchema = z
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
    // The first question's label or the approval's exact action; null when withheld.
    headline: safeText,
    reason: safeText,
    attentionCode: attentionCodeSchema.nullable(),
    destination: z.string().max(512),
    evidence: z.string().max(512),
    conversation: z.string().max(512).nullable(),
  })
  .strict();
/**
 * A runtime whose automatic restarts are exhausted. Derived on every read from in-memory
 * restart state, never stored, and carries no task or project field.
 */
export const runtimeInboxItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.literal("runtime"),
    urgency: z.literal(0),
    /** The wall time of exhaustion, equal to `since`. */
    createdAt: time,
    harness: executionHarnessSchema,
    since: time,
    headline: z.string().max(200),
    reason: z.string().max(200),
    lastFailure: runtimeRestartFailureSchema,
    attempts: z.array(runtimeRestartAttemptSchema).max(3),
    destination: z.string().max(512),
  })
  .strict();
export const inboxItemSchema = z.union([
  taskInboxItemSchema,
  runtimeInboxItemSchema,
]);
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
export type TaskInboxItem = z.infer<typeof taskInboxItemSchema>;
export type RuntimeInboxItem = z.infer<typeof runtimeInboxItemSchema>;
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
      kind: z.literal("local-review-draft"),
      key: uuid,
      taskId: uuid,
      version: revision,
      state: z.enum(["editable", "discarded"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-review-anchor"),
      key: uuid,
      taskId: uuid,
      groupId: uuid,
      anchorIds: z.array(uuid).max(32),
      draftVersion: revision,
      state: z.literal("staged"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-review-operation"),
      key: uuid,
      taskId: uuid,
      reviewId: uuid,
      state: z.enum(["prepared", "recorded", "rejected", "not-recorded"]),
      eventId: uuid.optional(),
      recipientAssignmentId: uuid.optional(),
      resumedLead: z.literal(true).optional(),
    })
    .strict(),
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
      resumedLead: z.literal(true).optional(),
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
  z
    .object({
      kind: z.literal("task-stop"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      /** Active executions asked to stop; cancellation itself is best-effort. */
      cancellationRequested: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task-resume"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      /** False when no operator Stop was in effect (a recorded no-op). */
      stopCleared: z.boolean(),
      requeued: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery-adoption"),
      key: uuid,
      recorded: z.literal(true),
      path: z.enum(["pre-turn-adopt", "no-turn-adopt"]),
      assignmentId: uuid,
      workId: z.string().min(1).max(512),
      witnessId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery-resolution"),
      key: uuid,
      recorded: z.literal(true),
      path: z.enum(["pre-turn-recover", "no-turn-recover"]),
      assignmentId: uuid,
      workId: z.string().min(1).max(512),
      receiptId: uuid,
      state: z.literal("reconciled"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conversation-replacement"),
      key: uuid,
      recorded: z.literal(true),
      assignmentId: uuid,
      revision,
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
          "local-review-batch-too-large",
          "local-review-recipient-unavailable",
          "local-review-comment-anchor-required",
          "credential-invalid",
          "insufficient-scope",
          "runtime-executable-missing",
          "runtime-confirmation-required",
        ]),
        message: z.string().max(256),
        fieldPaths: z.array(z.string().max(128)).optional(),
        credentialReason: sourceCredentialReasonSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
/** Exact source passed to `review.anchor.stage`; never a specimen or a later match. */
export type ReviewAnchorCandidate = z.infer<typeof reviewAnchorSelectionSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceComparisonRead = z.infer<
  typeof workspaceComparisonReadSchema
>;
export type TaskRead = z.infer<typeof taskSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Session = z.infer<typeof sessionSchema>;

const githubSegment = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
/**
 * The Claude subscription token reference: booleans and a closed state only, never the
 * reference name or value. `restart-required`: configured after the service started.
 */
export const claudeTokenStatusSchema = envelope(
  z
    .object({
      configured: z.boolean(),
      available: z.boolean(),
      state: z.enum([
        "not-configured",
        "missing-value",
        "restart-required",
        "available",
      ]),
    })
    .strict(),
);
/**
 * Installation discovery credential: whether a reference is set, its kind and whether it
 * resolves, plus the detected GitHub CLI logins. Never the variable name or a token.
 */
export const discoveryStatusSchema = envelope(
  z
    .object({
      configured: z.boolean(),
      available: z.boolean(),
      source: z.enum(["env", "gh"]).nullable(),
      gh: ghLoginStateSchema,
      /** The login a new project's `gh:github.com` source would use; status only. */
      sourceGh: ghLoginStateSchema,
    })
    .strict(),
);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;
export const discoveryUnavailableReasons = [
  "unconfigured",
  "missing-credential",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "unreadable",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
] as const;
const discoveryUnavailable = z
  .object({
    state: z.literal("unavailable"),
    reason: z.enum(discoveryUnavailableReasons),
  })
  .strict();
const discoveryRead = <T extends z.ZodRawShape>(shape: T) =>
  envelope(
    z.discriminatedUnion("state", [
      z
        .object({ state: z.literal("ready"), truncated: z.boolean(), ...shape })
        .strict(),
      discoveryUnavailable,
    ]),
  );
export const discoveredRepositorySchema = z
  .object({
    repositoryId: z.string().min(1).max(512),
    owner: githubSegment,
    name: githubSegment,
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();
export const discoveryRepositoriesSchema = discoveryRead({
  repositories: z.array(discoveredRepositorySchema).max(1000),
});
export const discoveryBranchesSchema = discoveryRead({
  branches: z.array(z.string().min(1).max(255)).max(500),
});
const discoveredProjectSchema = z
  .object({
    projectNodeId: z.string().min(1).max(512),
    title: z.string().max(512),
    number: revision,
  })
  .strict();
export const discoveryProjectsSchema = discoveryRead({
  ownerLogin: githubSegment,
  linked: z.array(discoveredProjectSchema).max(100),
  owned: z.array(discoveredProjectSchema).max(100),
});
export const discoveryProjectFieldsSchema = discoveryRead({
  fields: z
    .array(
      z
        .object({
          fieldNodeId: z.string().min(1).max(512),
          name: z.string().max(512),
          options: z
            .array(
              z
                .object({
                  optionNodeId: z.string().min(1).max(512),
                  name: z.string().max(512),
                })
                .strict(),
            )
            .max(500),
        })
        .strict(),
    )
    .max(100),
});
export const folderListRequestSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict();
/**
 * The service's home folder for Add Claude's suggested token path, or null when it is
 * unusable. Session-only: local-path data that no bearer credential may read.
 */
export const setupHomeSchema = envelope(
  z.object({ home: z.string().min(1).max(4096).nullable() }).strict(),
);
export const folderListingSchema = envelope(
  z
    .object({
      /** Home-relative (`~` or `~/…`); never an absolute path. */
      path: z.string().min(1).max(4096),
      parent: z.string().min(1).max(4096).nullable(),
      entries: z
        .array(
          z
            .object({
              name: z.string().min(1).max(255),
              kind: z.enum(["folder", "git"]),
              /** `owner/name` of a `github.com` origin, else null. */
              origin: z.string().max(201).nullable(),
              branch: z.string().max(255).nullable(),
            })
            .strict(),
        )
        .max(200),
      truncated: z.boolean(),
    })
    .strict(),
);
export const repositoryVerificationReasons = [
  "path-invalid",
  "not-checkout",
  "origin-missing",
  "origin-provider",
  "origin-mismatch",
  "ref-unavailable",
  "unreadable",
] as const;
export const checkoutVerifyRequestSchema = z
  .object({
    path: z.string().trim().min(1).max(4096),
    repository: z
      .object({ owner: githubSegment, name: githubSegment })
      .strict(),
    ref: setupRepositorySchema.shape.ref,
  })
  .strict();
export const checkoutVerificationSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("verified"),
        origin: z.string().max(201),
        branch: z.string().max(255).nullable(),
      })
      .strict(),
    z
      .object({
        state: z.literal("rejected"),
        reason: z.enum(repositoryVerificationReasons),
        origin: z.string().max(201).nullable(),
      })
      .strict(),
  ]),
);
export type DiscoveryUnavailableReason =
  (typeof discoveryUnavailableReasons)[number];
export type RepositoryVerificationReason =
  (typeof repositoryVerificationReasons)[number];
export type FolderListing = z.infer<typeof folderListingSchema>;
export type CheckoutVerification = z.infer<typeof checkoutVerificationSchema>;

export const operatorCredentialScopeSchema = z.enum(["read", "read-write"]);
export const operatorCredentialNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
export const operatorCredentialSchema = z
  .object({
    id: uuid,
    name: operatorCredentialNameSchema,
    scope: operatorCredentialScopeSchema,
    createdAt: time,
    expiresAt: time,
    lastUsedAt: time.nullable(),
    revokedAt: time.nullable(),
    replacesId: uuid.nullable(),
    state: z.enum(["active", "expired", "revoked"]),
  })
  .strict();
export type OperatorCredential = z.infer<typeof operatorCredentialSchema>;
export const operatorCredentialListSchema = envelope(
  z
    .object({ credentials: z.array(operatorCredentialSchema).max(1000) })
    .strict(),
);
export const operatorCredentialIssueRequestSchema = z
  .object({
    name: operatorCredentialNameSchema,
    scope: operatorCredentialScopeSchema,
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();
/** Capture groups: credential id, secret. */
export const OPERATOR_CREDENTIAL_TOKEN_PATTERN =
  /^ens_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;
export const operatorCredentialTokenSchema = z
  .string()
  .regex(OPERATOR_CREDENTIAL_TOKEN_PATTERN);
export const operatorCredentialIssuedSchema = z
  .object({
    credential: operatorCredentialSchema,
    token: operatorCredentialTokenSchema,
  })
  .strict();
/** Push subscription label: 1 to 64 characters, no control characters. */
export const pushSubscriptionLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\p{Cc}\u2028\u2029]/u.test(value));
/** The browser's PushSubscription JSON. Hosts, key lengths and curve points are checked server-side. */
export const pushSubscribeRequestSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    keys: z
      .object({
        p256dh: z.string().min(1).max(128),
        auth: z.string().min(1).max(64),
      })
      .strict(),
    label: pushSubscriptionLabelSchema,
  })
  .strict();
export const pushRevokedReasonSchema = z.enum([
  "operator",
  "gone",
  "key-changed",
]);
export const pushFailureSchema = z.enum(["rejected", "unavailable", "timeout"]);
/** Metadata only: never the endpoint, p256dh or auth. */
export const pushSubscriptionSchema = z
  .object({
    id: uuid,
    label: pushSubscriptionLabelSchema,
    serviceHost: z.string().min(1).max(253),
    endpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: time,
    lastSuccessAt: time.nullable(),
    lastFailure: pushFailureSchema.nullable(),
    state: z.enum(["active", "revoked"]),
    revokedAt: time.nullable(),
    revokedReason: pushRevokedReasonSchema.nullable(),
  })
  .strict();
export type PushSubscriptionRecord = z.infer<typeof pushSubscriptionSchema>;
export const pushNotificationsReadSchema = envelope(
  z
    .object({
      available: z.boolean(),
      publicKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{87}$/)
        .nullable(),
      subscriptions: z.array(pushSubscriptionSchema).max(100),
    })
    .strict(),
);
export const pushSubscriptionResultSchema = z
  .object({ subscription: pushSubscriptionSchema })
  .strict();
export const pushTestOutcomeSchema = z.enum([
  "sent",
  "gone",
  "rejected",
  "unavailable",
  "timeout",
]);
export const pushTestResultSchema = z
  .object({ outcome: pushTestOutcomeSchema })
  .strict();
export const cliIdentitySchema = z
  .object({
    apiVersion: z.number().int().positive().safe(),
    capabilities: z.array(z.string().max(64)).max(64),
    service: z
      .object({ installationId: uuid, origin: z.string().max(2048) })
      .strict(),
    credential: z
      .object({
        id: uuid,
        name: operatorCredentialNameSchema,
        scope: operatorCredentialScopeSchema,
        createdAt: time,
        expiresAt: time,
      })
      .strict(),
  })
  .strict();
export type CliIdentity = z.infer<typeof cliIdentitySchema>;
/** Capability families the CLI bearer API serves, in negotiation order. */
export const cliCapabilities = [
  "cli.identity",
  "task.read",
  "workspace.read",
  "task.list",
  "task.search",
  "task.records",
  "assignment.read",
  "instructions.read",
  "result.read",
  "artifact.read",
  "configuration.write",
  "operation.read",
  "capacity.read",
  "configuration.impact",
  "execution.read",
  "diagnostics.read",
  "task.write",
  "attention.read",
  "attention.write",
  "source.write",
  "delivery.write",
  "recovery.read",
  "recovery.write",
] as const;
/** Assignments a profile or project change would affect, observed at read time. */
export const configurationImpactSchema = envelope(
  z
    .object({
      target: z
        .object({ kind: z.enum(["project", "profile"]), id: uuid })
        .strict(),
      assignments: z
        .array(
          z
            .object({
              assignmentId: uuid,
              taskId: uuid,
              projectId: uuid,
              profileId: uuid,
              state: z.enum(["pending", "running", "completed", "held"]),
              lead: z.boolean(),
              bound: z
                .object({
                  profileRevision: revision,
                  instructionsRevision: revision,
                })
                .strict(),
              current: z
                .object({
                  profileRevision: revision,
                  instructionsRevision: revision,
                })
                .strict(),
              stale: z
                .object({ profile: z.boolean(), instructions: z.boolean() })
                .strict(),
            })
            .strict(),
        )
        .max(200),
      total: z.number().int().nonnegative().safe(),
      truncated: z.boolean(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
);
/** Commands whose receipts `GET /api/operator/operations` reads back. */
export const operationTypeSchema = z.enum([
  "profile.create",
  "profile.configure",
  "project.create",
  "project.configure",
  "routing.configure",
  "capacity.configure",
  "runtime.configure",
  "assignment.apply",
  "github.configure",
  "github.preview",
  "recovery.pre-turn.adopt",
  "recovery.pre-turn.recover",
  "recovery.no-turn.adopt",
  "recovery.no-turn.recover",
  "recovery.conversation.replace",
]);
/** `project:<id>`, `profile:<id>`, `assignment:<id>`, `system:capacity` or `system:runtime:<harness>`; nothing else is a readable scope. */
export const operationScopeSchema = z
  .string()
  .regex(
    /^(?:(?:project|profile|assignment):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|system:capacity|system:runtime:(?:codex|claude))$/i,
  );
export const operationReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({ state: z.literal("recorded"), receipt: commandReceiptSchema })
      .strict(),
    z.object({ state: z.literal("not-recorded") }).strict(),
  ]),
);
/** Instruction views are reconstructed from retained revisions, never a captured prompt. */
const instructionProvenanceSchema = z
  .object({
    source: z.literal("retained-revision-records"),
    reconstructed: z.literal(true),
    submittedPrompt: z.literal("not-captured"),
  })
  .strict();
export const instructionProvenance = {
  source: "retained-revision-records",
  reconstructed: true,
  submittedPrompt: "not-captured",
} as const;
export const instructionBodySchema = z
  .object({
    revision,
    state: z.enum(["available", "omitted"]),
    reason: z.literal("redaction-unavailable").nullable(),
    text: text.nullable(),
    redacted: z.boolean(),
  })
  .strict();
const profileInstructionBodySchema = instructionBodySchema
  .extend({
    name: safeText,
    capabilities: safeText,
    revoked: z.boolean(),
    runtime: profileRuntimeSchema,
  })
  .strict();
const instructionRevisionListSchema = z
  .array(
    z
      .object({ revision, current: z.boolean(), instructionChars: time })
      .strict(),
  )
  .max(128);
export const profileInstructionsSchema = envelope(
  z
    .object({
      summary: profileSummarySchema,
      currentRevision: revision,
      revisions: instructionRevisionListSchema,
      selected: profileInstructionBodySchema,
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
export const projectInstructionsSchema = envelope(
  z
    .object({
      summary: projectSummarySchema,
      currentRevision: revision,
      revisions: instructionRevisionListSchema,
      selected: instructionBodySchema,
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
const instructionPairSchema = z
  .object({
    profile: profileInstructionBodySchema,
    project: instructionBodySchema,
  })
  .strict();
const instructionComparisonSchema = z
  .object({ sameRevision: z.boolean(), sameContent: z.boolean().nullable() })
  .strict();
export const assignmentInstructionsSchema = envelope(
  z
    .object({
      assignmentId: uuid,
      taskId: uuid,
      projectId: uuid,
      profileId: uuid,
      bound: instructionPairSchema,
      current: instructionPairSchema,
      comparison: z
        .object({
          profile: instructionComparisonSchema,
          project: instructionComparisonSchema,
          boundIsCurrent: z.boolean(),
        })
        .strict(),
      execution: z
        .object({
          workId: z.string().min(1),
          requestSequence: revision,
          profileRevision: revision,
          instructionsRevision: revision,
          matchesBound: z.boolean(),
        })
        .strict()
        .nullable(),
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
export const assignmentDetailSchema = envelope(
  assignmentSchema
    .extend({
      taskId: uuid,
      projectId: uuid,
      taskVersion: revision,
      lead: z.boolean(),
      execution: executionSchema,
    })
    .strict(),
);
/** Work ids are opaque service identifiers, never paths. */
export const workIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
const diagnosticGapCodeSchema = z.enum([
  "capture-baseline",
  "capture-failed",
  "capture-interrupted",
  "input-failed",
  "size-limit",
  "redaction-unavailable",
  "execution-limit",
  "item-limit",
  "expired",
  "evicted",
  "late-event",
  "early-buffer-limit",
  "unsupported-event",
]);
const diagnosticGapSchema = z
  .object({
    code: diagnosticGapCodeSchema,
    count: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().safe(),
    firstAt: time,
    lastAt: time,
  })
  .strict();
/** `captured` (enhanced), `baseline`, or `not-captured` (no capture row). */
const captureStateSchema = z.enum(["captured", "baseline", "not-captured"]);
const executionSummarySchema = z
  .object({
    workId: workIdSchema,
    requestSequence: z.number().int().positive().safe(),
    taskId: uuid,
    projectId: uuid,
    assignmentId: uuid,
    state: z.enum(["queued", "active", "completed", "held"]),
    reason: safeText,
    capture: captureStateSchema,
    threadId: safeText,
    turnId: safeText,
    startedAt: time.nullable(),
    finishedAt: time.nullable(),
  })
  .strict();
export const executionListSchema = envelope(
  z
    .object({
      executions: z.array(executionSummarySchema).max(200),
      /** Pass as `before` for the next older page; null on the last page. */
      nextBefore: z.number().int().positive().safe().nullable(),
    })
    .strict(),
);
const settingEntrySchema = z
  .object({
    name: z.string().max(64),
    value: z.union([z.string().max(1024), z.null()]),
    source: z.enum(["service-admitted", "runtime-reported", "unknown"]),
  })
  .strict();
/** Capture coverage facts; observation is never claimed complete. */
const captureHealthSchema = z
  .object({
    mode: z.enum(["enhanced", "baseline"]).nullable(),
    eventSource: z.enum(["supported", "unsupported"]).nullable(),
    toolObservation: z.literal("incomplete"),
    reasoning: z.literal("not-collected"),
    gaps: z.array(diagnosticGapSchema),
    unrecorded: z.number().int().nonnegative().safe(),
  })
  .strict();
export const executionDetailSchema = envelope(
  z
    .object({
      execution: executionSummarySchema,
      identity: z
        .object({
          assignmentVersion: revision,
          instructionsRevision: revision,
          profileRevision: revision,
          conversationRevision: z.number().int().nonnegative().safe(),
          harness: executionHarnessSchema,
        })
        .strict()
        .nullable(),
      settings: z.array(settingEntrySchema).nullable(),
      counts: z
        .object({
          items: z.number().int().nonnegative().safe(),
          payloadBytes: z.number().int().nonnegative().safe(),
        })
        .strict(),
      health: captureHealthSchema,
    })
    .strict(),
);
const inputSegmentSchema = z
  .object({
    name: z.enum([
      "request",
      "role",
      "review-references",
      "project-instructions",
      "profile-instructions",
    ]),
    revision: revision.nullable(),
    state: z.enum(["available", "omitted"]),
    reason: diagnosticGapCodeSchema.nullable(),
    /** Up to 64 KiB captured; redaction markers can lengthen it. */
    text: z.string().max(140000).nullable(),
    redacted: z.boolean(),
  })
  .strict();
export const executionInputsSchema = envelope(
  z
    .object({
      workId: workIdSchema,
      capture: captureStateSchema,
      /** Ensemble-supplied inputs as submitted; never the runtime's effective prompt. */
      provenance: z
        .object({
          source: z.enum(["captured-submission", "not-captured"]),
          effectivePrompt: z.literal("not-captured"),
        })
        .strict(),
      segments: z.array(inputSegmentSchema).max(8),
      submitted: z
        .object({ bytes: z.number().int().nonnegative().safe(), sha256: hash })
        .strict()
        .nullable(),
      /** Only when no instruction segment was captured: retained revisions instead. */
      reconstructed: z
        .object({
          provenance: instructionProvenanceSchema,
          profile: instructionBodySchema,
          project: instructionBodySchema,
        })
        .strict()
        .nullable(),
      comparison: z
        .object({
          instructions: z.array(
            z
              .object({
                name: z.enum(["project-instructions", "profile-instructions"]),
                boundRevision: revision,
                currentRevision: revision,
                sameRevision: z.boolean(),
                sameContent: z.boolean().nullable(),
              })
              .strict(),
          ),
          settings: z.array(
            z
              .object({
                name: z.string().max(64),
                captured: z.union([z.string().max(1024), z.null()]),
                current: z.union([z.string().max(1024), z.null()]),
                same: z.boolean().nullable(),
              })
              .strict(),
          ),
        })
        .strict()
        .nullable(),
    })
    .strict(),
);
const diagnosticItemSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    kind: z.enum(["input", "setting", "runtime", "tool", "service"]),
    name: z.string().max(256),
    severity: z.enum(["info", "warn", "error"]),
    itemId: z.string().max(256).nullable(),
    state: z.enum(["available", "omitted"]),
    reason: diagnosticGapCodeSchema.nullable(),
    payload: z.unknown(),
    redacted: z.boolean(),
    createdAt: time,
  })
  .strict();
export const executionEventsSchema = envelope(
  z
    .object({
      workId: workIdSchema,
      capture: captureStateSchema,
      items: z.array(diagnosticItemSchema).max(200),
      /** Expired or evicted ranges after the cursor, plus other capture gaps. */
      gaps: z.array(
        diagnosticGapSchema.extend({
          maxPrunedSequence: z.number().int().nonnegative().safe(),
        }),
      ),
      /** The last returned sequence, or the request cursor when nothing was returned. */
      resumeAfter: z.number().int().nonnegative().safe(),
      more: z.boolean(),
      finished: z.boolean(),
      health: captureHealthSchema,
    })
    .strict(),
);
