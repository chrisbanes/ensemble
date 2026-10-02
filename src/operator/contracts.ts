import { z } from "zod";
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
const json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    text,
    z.array(json).max(256),
    z.record(z.string().max(512), json),
  ]),
);
export const materialSchema = json.refine(
  (value) => JSON.stringify(value).length <= 8192,
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
    deliveryState: z.enum(["pending", "queued", "delivered"]),
    createdAt: time,
    text: safeText.optional(),
    decision: z.enum(["approved", "denied"]).optional(),
    action: safeText.optional(),
    target: safeText.optional(),
    resultId: uuid.optional(),
    routingOperationId: uuid.optional(),
    routingReason: safeText.optional(),
    interactionId: uuid.optional(),
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
    url: z.string().url().nullable(),
    body: safeText,
    status: safeText,
    projectFields: z.array(
      z.object({ selectionId: z.string(), fields: safeText }).strict(),
    ),
    nativeBlockers: z.array(
      z.object({ nodeId: z.string(), state: safeText }).strict(),
    ),
    observation: z.literal("stored-observation"),
    lastSuccessfulSync: z.null(),
    historyAvailable: z.literal(false),
  })
  .strict()
  .nullable();
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
      state: taskState.optional(),
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
      type: z.literal("message.post"),
      taskId: uuid,
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
      message: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answer: z.string().trim().min(1).max(16000),
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
]);
const savedTask = z
  .object({
    id: uuid,
    projectId: uuid,
    title: safeText,
    outcome: safeText,
    version: revision,
    state: taskState,
    ready: z.boolean(),
  })
  .strict();
const savedAssignment = z
  .object({
    assignmentId: uuid,
    taskId: uuid,
    projectId: uuid,
    version: revision,
    profileRevision: revision,
    instructionsRevision: revision,
    state: z.enum(["pending", "running", "completed", "held", "cancelled"]),
  })
  .strict();
const savedEvent = z
  .object({
    eventId: uuid,
    taskId: uuid,
    recipientAssignmentId: uuid,
    eventType: z.string(),
    createdAt: time,
  })
  .strict();
export const commandReceiptSchema = z
  .object({
    key: uuid,
    type: z.enum([
      "task.create",
      "task.configure",
      "dependency.add",
      "dependency.remove",
      "assignment.apply",
      "message.post",
      "question.answer",
      "approval.decide",
      "result.recipient",
    ]),
    result: z.union([savedTask, savedAssignment, savedEvent]),
  })
  .strict();
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
        fields: z.array(z.string().max(128)).optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type TaskRead = z.infer<typeof taskSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Session = z.infer<typeof sessionSchema>;
