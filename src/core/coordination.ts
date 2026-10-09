import {
  questionToolArgumentsSchema,
  questionFormSchema,
  questionAnswersSchema,
  validateQuestionAnswers,
  type QuestionForm,
  type QuestionAnswers,
} from "./question-forms.js";
import {
  TaskReviewStore,
  reviewMetadataSchema,
  feedbackReferenceSchema,
} from "./task-review.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  validateStructuredAnswers,
  type StructuredQuestionAnswers,
} from "./structured-questions.js";
import {
  nativeInputEndpointIdentitySchema,
  nativeEndpointKey,
  parseNativeInputRequest,
  runtimeUserInputOutcomeSchema,
  type NativeInputEndpointIdentity,
  type RuntimeReplyIntent,
  type RuntimeUserInputOutcome,
  type RuntimeUserInputRequest,
} from "./structured-questions.js";
import { DomainStore } from "./domain.js";
import {
  RetainedEvidenceStore,
  unavailableRetainedEvidenceCandidate,
  type RetainedEvidenceCandidate,
} from "./retained-evidence.js";
import {
  DeliveryStore,
  externalActionSchema,
  actionKinds,
  type RuntimeDeliveryCaller,
} from "./delivery.js";
import { transaction, type Database } from "./store.js";
import { LocalReviewStore } from "./local-review.js";

const uuid = z.string().uuid();
const summarySchema = z.string().trim().min(1).max(16000);
const reportCallSchema = z
  .object({
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    callId: z.string().min(1).max(512),
    tool: z.literal("ensemble_report_result"),
    arguments: z
      .object({
        summary: summarySchema,
        review: reviewMetadataSchema.optional(),
      })
      .strict(),
  })
  .strict();
const generalCallSchema = z
  .object({
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    callId: z.string().min(1).max(512),
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
const responseSchema = z
  .object({
    text: z.string().max(16000),
    success: z.boolean(),
  })
  .strict();
const reconcileSchema = z
  .object({
    actor: z.literal("operator"),
    key: z.string().uuid(),
    resultId: uuid,
    expectedRevision: z.number().int().positive(),
    recipientAssignmentId: uuid,
  })
  .strict();
const toolIdentity = {
  threadId: z.string().min(1).max(512),
  turnId: z.string().min(1).max(512),
  callId: z.string().min(1).max(512),
};
const delegateCallSchema = z
  .object({
    ...toolIdentity,
    tool: z.literal("ensemble_delegate"),
    arguments: z.object({ profileId: uuid, brief: summarySchema }).strict(),
  })
  .strict();
const questionCallSchema = z
  .object({
    ...toolIdentity,
    tool: z.literal("ensemble_ask_question"),
    arguments: questionToolArgumentsSchema,
  })
  .strict();
const approvalCallSchema = z
  .object({
    ...toolIdentity,
    tool: z.literal("ensemble_request_approval"),
    arguments: z
      .object({
        action: z.string().trim().min(1).max(512),
        target: z.string().trim().min(1).max(2000).optional(),
        material: z.unknown(),
      })
      .strict(),
  })
  .strict();
const followUpCallSchema = z
  .object({
    ...toolIdentity,
    tool: z.literal("ensemble_request_follow_up"),
    arguments: z
      .object({
        resultId: uuid,
        instructions: summarySchema,
      })
      .strict(),
  })
  .strict();
const completionCallSchema = z
  .object({
    ...toolIdentity,
    tool: z.literal("ensemble_request_completion"),
    arguments: z
      .object({ reviewedResultIds: z.array(uuid).max(1000) })
      .strict(),
  })
  .strict();
const operatorCommandKey = z.string().uuid();
const answerSchema = z
  .object({
    actor: z.literal("operator"),
    key: operatorCommandKey,
    interactionId: uuid,
    expectedRevision: z.number().int().positive(),
    answer: z.string().min(1).max(16000),
  })
  .strict();
const approvalDecisionSchema = z
  .object({
    actor: z.literal("operator"),
    key: operatorCommandKey,
    interactionId: uuid,
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approved", "denied"]),
    action: z.string().trim().min(1).max(512),
    target: z.string().trim().min(1).max(2000).optional(),
    material: z.unknown().optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.decision === "approved" && command.material === undefined)
      context.addIssue({
        code: "custom",
        message: "Approval material is required to approve",
        path: ["material"],
      });
  });
const operatorMessageSchema = z
  .object({
    actor: z.literal("operator"),
    key: operatorCommandKey,
    taskId: uuid,
    recipientAssignmentId: uuid,
    expectedAssignmentVersion: z.number().int().positive(),
    message: summarySchema,
    reference: feedbackReferenceSchema.optional(),
  })
  .strict();
const routingFallbackAttentionSchema = z
  .object({
    routingOperationId: uuid,
    taskId: uuid,
    recipientAssignmentId: uuid,
    brief: z.string().max(16000),
    reason: z.string().trim().min(1).max(128),
    evidence: z.string().max(16000),
  })
  .strict();
const completionFinalizeSchema = z
  .object({
    requestId: uuid,
    workId: z.string().min(1).max(512),
    terminal: z.enum(["completed", "failed"]),
  })
  .strict();
type Row = Record<string, string | number | null>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export type RuntimeQuestionDeliveryState =
  | "unanswered"
  | "recorded"
  | "held"
  | "sending"
  | "sent-unconfirmed"
  | "confirmed"
  | "unavailable"
  | "uncertain";
export interface RuntimeQuestionRecord {
  interactionId: string;
  taskId: string;
  requestingAssignmentId: string;
  requestingWorkId: string;
  revision: number;
  identity: NativeInputEndpointIdentity;
  request: RuntimeUserInputRequest["request"];
  qualification: RuntimeUserInputRequest["qualification"];
  answers: StructuredQuestionAnswers | null;
  answerDigest: string | null;
  replyIntentId: string | null;
  deliveryState: RuntimeQuestionDeliveryState;
  requestState: "available" | "unavailable";
  reason: string | null;
}
export interface RuntimeQuestionAnswerReceipt {
  interactionId: string;
  revision: number;
  recorded: true;
  deliveryState: RuntimeQuestionDeliveryState;
}
export const runtimeQuestionAnswerCommandSchema = z
  .object({
    actor: z.literal("operator"),
    key: operatorCommandKey,
    taskId: uuid,
    interactionId: uuid,
    expectedRevision: z.number().int().positive(),
    answers: z.unknown(),
  })
  .strict();
const runtimeAnswerReceiptSchema = z
  .object({
    interactionId: uuid,
    revision: z.number().int().positive(),
    recorded: z.literal(true),
    deliveryState: z.enum([
      "unanswered",
      "recorded",
      "held",
      "sending",
      "sent-unconfirmed",
      "confirmed",
      "unavailable",
      "uncertain",
    ]),
  })
  .strict();

export interface CoordinationCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface CoordinationToolResponse {
  text: string;
  success: boolean;
}

export interface CoordinationReceipt {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  payloadHash: string;
  taskId: string;
  assignmentId: string;
  workId: string;
  workRevision: number;
  response: CoordinationToolResponse;
}

export interface AssignmentResult {
  resultId: string;
  taskId: string;
  assignmentId: string;
  workId: string;
  workRevision: number;
  assignmentVersion: number;
  summary: string;
  recipientAssignmentId: string | null;
  destinationDisposition: "delivered" | "unresolved";
  createdAt: number;
}

export interface UnresolvedResultDestination {
  resultId: string;
  taskId: string;
  assignmentId: string;
  originalDestination: string | null;
  reason: string;
  revision: number;
}

/** Snapshot of a validated reconciled assignment generation; not continuation authority. */
export interface ReconciledAssignmentProof {
  workId: string;
  receiptId: string;
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  material: string;
}

export interface InboxEvent {
  sequence: number;
  eventId: string;
  taskId: string;
  recipientAssignmentId: string;
  eventType: string;
  resultId: string | null;
  interactionId: string | null;
  payload: string;
  createdAt: number;
}

export interface RoutingFallbackAttention {
  routingOperationId: string;
  taskId: string;
  recipientAssignmentId: string;
  brief: string;
  reason: string;
  evidence: string;
}

export interface InboxDelivery {
  batchId: string;
  deliveryWorkId: string;
  taskId: string;
  recipientAssignmentId: string;
  assignmentVersion: number;
  highWaterSequence: number;
  state: "queued" | "completed";
  events: InboxEvent[];
}

export interface CoordinationInteraction {
  interactionId: string;
  taskId: string;
  requestingAssignmentId: string;
  requestingWorkId: string;
  requestingWorkRevision: number;
  requestingAssignmentVersion: number;
  conversationRevision: number;
  kind: "question" | "approval";
  status: "open" | "answered" | "approved" | "denied";
  prompt: string;
  action: string | null;
  target: string | null;
  materialHash: string | null;
  materialJson: string | null;
  response: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface OperatorAttention {
  attentionId: string;
  taskId: string;
  interactionId: string;
  status: "open" | "resolved";
  revision: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface FollowUpRequest {
  followUpId: string;
  resultId: string;
  taskId: string;
  requestingAssignmentId: string;
  targetAssignmentId: string;
  priorWorkId: string;
  priorWorkRevision: number;
  priorAssignmentVersion: number;
  nextAssignmentVersion: number;
  instructions: string;
  revision: number;
  createdAt: number;
}

export interface TaskCompletionRequest {
  requestId: string;
  taskId: string;
  leadAssignmentId: string;
  leadWorkId: string;
  leadWorkRevision: number;
  taskVersion: number;
  reviewedResultIds: string[];
  status: "pending" | "rejected" | "finalized";
  rejectionReasons: string[];
  revision: number;
  createdAt: number;
  finalizedAt: number | null;
}

export interface ReportingRepair {
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  missedWorkId: string;
  repairWorkId: string;
  attempts: number;
  state: "queued" | "held" | "resolved";
  reason: string | null;
}

/** Durable result, receipt, inbox, and delivery state over the service SQLite DB. */
export class CoordinationStore {
  private readonly domain: DomainStore;
  private readonly isNeverAdmittedRefusedAssignmentWork:
    | ((workId: string) => boolean)
    | undefined;

  constructor(
    private readonly db: Database,
    domain?: DomainStore,
    isNeverAdmittedRefusedAssignmentWork?: (workId: string) => boolean,
    private readonly reconciledAssignmentProof?: (
      workId: string,
    ) => ReconciledAssignmentProof | undefined,
  ) {
    this.domain = domain ?? new DomainStore(db);
    this.isNeverAdmittedRefusedAssignmentWork =
      isNeverAdmittedRefusedAssignmentWork;
  }

  taskReview(): TaskReviewStore {
    return new TaskReviewStore(this.db);
  }

  retainedEvidence(): RetainedEvidenceStore {
    return new RetainedEvidenceStore(this.db);
  }

  localReviews(): LocalReviewStore {
    return new LocalReviewStore(this.db, this.retainedEvidence(), {
      createMessage: (taskId, recipientAssignmentId, message) =>
        this.newEvent(
          taskId,
          recipientAssignmentId,
          "operator-message",
          null,
          JSON.stringify({ message }),
        ),
      saveReceipt: (key, request, eventId) =>
        this.saveOperatorReceipt("local-review-send", key, request, eventId),
      readEvent: (eventId) =>
        this.parseEvent(
          this.required(
            `SELECT sequence,eventId,taskId,recipientAssignmentId,eventType,resultId,interactionId,payload,createdAt
        FROM coordination_inbox_events WHERE eventId=?`,
            eventId,
          ),
        ),
    });
  }

  hasResultForWork(workId: string, workRevision: number): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM coordination_results WHERE workId=? AND workRevision=?",
        )
        .get(workId, workRevision),
    );
  }

  migrate(): void {
    new TaskReviewStore(this.db).migrate();
    transaction(this.db, () => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS coordination_external_delivery_notices (taskId TEXT NOT NULL REFERENCES domain_tasks(id),identity TEXT NOT NULL,eventId TEXT NOT NULL,PRIMARY KEY(taskId,identity));
      CREATE TABLE IF NOT EXISTS coordination_receipts (
        threadId TEXT NOT NULL, turnId TEXT NOT NULL, callId TEXT NOT NULL,
        tool TEXT NOT NULL, payloadHash TEXT NOT NULL,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        workId TEXT NOT NULL REFERENCES execution_intents(workId),
        workRevision INTEGER NOT NULL CHECK(workRevision > 0),
        response TEXT NOT NULL,
        PRIMARY KEY(threadId, turnId, callId)
      );
      CREATE TABLE IF NOT EXISTS coordination_results (
        resultId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
        workRevision INTEGER NOT NULL CHECK(workRevision > 0),
        assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
        summary TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        recipientAssignmentId TEXT,
        destinationDisposition TEXT NOT NULL
          CHECK(destinationDisposition IN ('resolved','unresolved')),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(assignmentId, workRevision)
      );
      CREATE INDEX IF NOT EXISTS coordination_results_task_created ON coordination_results(taskId,createdAt);
      CREATE TABLE IF NOT EXISTS coordination_unresolved_result_destinations (
        resultId TEXT PRIMARY KEY REFERENCES coordination_results(resultId),
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        originalDestination TEXT,
        reason TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        status TEXT NOT NULL CHECK(status IN ('unresolved','resolved')),
        resolvedRecipientAssignmentId TEXT,
        resolvedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS coordination_interactions (
        interactionId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        requestingAssignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        requestingWorkId TEXT NOT NULL REFERENCES execution_intents(workId),
        requestingWorkRevision INTEGER NOT NULL CHECK(requestingWorkRevision > 0),
        requestingAssignmentVersion INTEGER NOT NULL CHECK(requestingAssignmentVersion > 0),
        conversationRevision INTEGER NOT NULL CHECK(conversationRevision > 0),
        kind TEXT NOT NULL CHECK(kind IN ('question','approval')),
        status TEXT NOT NULL CHECK(status IN ('open','answered','approved','denied')),
        prompt TEXT NOT NULL,
        action TEXT,
        target TEXT,
        materialHash TEXT,
        materialJson TEXT,
        response TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK((kind = 'question' AND action IS NULL AND materialHash IS NULL) OR
          (kind = 'approval' AND action IS NOT NULL AND materialHash IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS coordination_question_forms (
        interactionId TEXT PRIMARY KEY REFERENCES coordination_interactions(interactionId),
        schemaJson TEXT NOT NULL, schemaDigest TEXT NOT NULL, answerJson TEXT, answerDigest TEXT,
        requestState TEXT NOT NULL DEFAULT 'available' CHECK(requestState IN ('available','cancelled','superseded','unavailable'))
      );
      CREATE TABLE IF NOT EXISTS coordination_runtime_questions (
        interactionId TEXT PRIMARY KEY REFERENCES coordination_interactions(interactionId),
        endpointKey TEXT NOT NULL UNIQUE, identityJson TEXT NOT NULL, requestJson TEXT NOT NULL,
        qualificationJson TEXT NOT NULL, requestDigest TEXT NOT NULL,
        runtimeGeneration TEXT, threadId TEXT, turnId TEXT, itemId TEXT,
        rpcIdKind TEXT CHECK(rpcIdKind IS NULL OR rpcIdKind IN ('number','string')),
        rpcIdValue TEXT,
        answerJson TEXT, answerDigest TEXT, replyIntentId TEXT UNIQUE,
        requestState TEXT NOT NULL CHECK(requestState IN ('available','unavailable')),
        deliveryState TEXT NOT NULL CHECK(deliveryState IN ('unanswered','recorded','held','sending','sent-unconfirmed','confirmed','unavailable','uncertain')),
        reason TEXT, outcomeJson TEXT
      );
      CREATE TABLE IF NOT EXISTS coordination_operator_attention (
        attentionId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        interactionId TEXT NOT NULL UNIQUE
          REFERENCES coordination_interactions(interactionId),
        status TEXT NOT NULL CHECK(status IN ('open','resolved')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        resolvedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS coordination_runtime_migrations (
        migrationId TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS coordination_operator_receipts (
        scope TEXT NOT NULL,
        commandKey TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY(scope, commandKey)
      );
      CREATE TABLE IF NOT EXISTS coordination_follow_ups (
        followUpId TEXT PRIMARY KEY,
        resultId TEXT NOT NULL UNIQUE REFERENCES coordination_results(resultId),
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        requestingAssignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        targetAssignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        priorWorkId TEXT NOT NULL REFERENCES execution_intents(workId),
        priorWorkRevision INTEGER NOT NULL CHECK(priorWorkRevision > 0),
        priorAssignmentVersion INTEGER NOT NULL CHECK(priorAssignmentVersion > 0),
        nextAssignmentVersion INTEGER NOT NULL CHECK(nextAssignmentVersion > 0),
        instructions TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS coordination_completion_requests (
        requestId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        leadAssignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        leadWorkId TEXT NOT NULL REFERENCES execution_intents(workId),
        leadWorkRevision INTEGER NOT NULL CHECK(leadWorkRevision > 0),
        taskVersion INTEGER NOT NULL CHECK(taskVersion > 0),
        reviewedResultIds TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','rejected','finalized')),
        rejectionReasons TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL CHECK(revision > 0),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        finalizedAt INTEGER,
        UNIQUE(leadWorkId)
      );
      CREATE TABLE IF NOT EXISTS coordination_reporting_repairs (
        assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
        assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        missedWorkId TEXT NOT NULL REFERENCES execution_intents(workId),
        repairWorkId TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL CHECK(attempts IN (1,2)),
        state TEXT NOT NULL CHECK(state IN ('queued','held','resolved')),
        reason TEXT,
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(assignmentId, assignmentVersion)
      );
      CREATE TABLE IF NOT EXISTS coordination_inbox_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        eventId TEXT NOT NULL UNIQUE,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        recipientAssignmentId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        resultId TEXT UNIQUE REFERENCES coordination_results(resultId),
        interactionId TEXT,
        routingOperationId TEXT REFERENCES routing_operations(id),
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS coordination_delivery_batches (
        batchId TEXT PRIMARY KEY,
        deliveryWorkId TEXT NOT NULL UNIQUE,
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        recipientAssignmentId TEXT NOT NULL,
        assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
        highWaterSequence INTEGER NOT NULL CHECK(highWaterSequence > 0),
        state TEXT NOT NULL CHECK(state IN ('queued','completed')),
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        completedAt INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS coordination_one_queued_delivery
        ON coordination_delivery_batches(recipientAssignmentId)
        WHERE state = 'queued';
      CREATE TABLE IF NOT EXISTS coordination_recovery_continuations (
        workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
        receiptId TEXT NOT NULL UNIQUE REFERENCES execution_recovery_receipts(id),
        taskId TEXT NOT NULL REFERENCES domain_tasks(id),
        assignmentId TEXT NOT NULL,
        proofMaterial TEXT NOT NULL,
        operatorCommandKey TEXT NOT NULL,
        operatorPayloadHash TEXT NOT NULL,
        operatorEventId TEXT NOT NULL REFERENCES coordination_inbox_events(eventId),
        operatorEventPayload TEXT NOT NULL,
        batchId TEXT UNIQUE REFERENCES coordination_delivery_batches(batchId),
        batchMaterial TEXT,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS coordination_delivery_events (
        eventId TEXT PRIMARY KEY REFERENCES coordination_inbox_events(eventId),
        batchId TEXT NOT NULL REFERENCES coordination_delivery_batches(batchId),
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        UNIQUE(batchId, ordinal)
      );
      CREATE TABLE IF NOT EXISTS coordination_source_hold_notices (
        nodeId TEXT NOT NULL, generation INTEGER NOT NULL,
        recipientAssignmentId TEXT NOT NULL,
        eventId TEXT NOT NULL UNIQUE REFERENCES coordination_inbox_events(eventId),
        PRIMARY KEY(nodeId, generation, recipientAssignmentId)
      );`);
      const interactionColumns = this.db
        .prepare("PRAGMA table_info(coordination_interactions)")
        .all() as Row[];
      if (!interactionColumns.some((column) => column.name === "materialJson"))
        this.db.exec(
          "ALTER TABLE coordination_interactions ADD COLUMN materialJson TEXT",
        );
      this.migrateRuntimeQuestionIdentity();
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS coordination_one_interaction_event
        ON coordination_inbox_events(interactionId) WHERE interactionId IS NOT NULL;`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS coordination_one_routing_fallback
        ON coordination_inbox_events(routingOperationId)
        WHERE routingOperationId IS NOT NULL;`);
      new TaskReviewStore(this.db).populateMissingWithinTransaction();
      new RetainedEvidenceStore(this.db).migrate();
      this.localReviews().migrate();
    });
  }

  private migrateRuntimeQuestionIdentity(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(coordination_runtime_questions)")
      .all() as Row[];
    const names = new Set(columns.map((column) => String(column.name)));
    for (const [name, definition] of [
      ["runtimeGeneration", "TEXT"],
      ["threadId", "TEXT"],
      ["turnId", "TEXT"],
      ["itemId", "TEXT"],
      [
        "rpcIdKind",
        "TEXT CHECK(rpcIdKind IS NULL OR rpcIdKind IN ('number','string'))",
      ],
      ["rpcIdValue", "TEXT"],
    ] as const)
      if (!names.has(name))
        this.db.exec(
          `ALTER TABLE coordination_runtime_questions ADD COLUMN ${name} ${definition}`,
        );

    if (
      !this.db
        .prepare(
          "SELECT 1 FROM coordination_runtime_migrations WHERE migrationId = ?",
        )
        .get("runtime-question-identity-v1")
    ) {
      let cursor = 0;
      for (;;) {
        const rows = this.db
          .prepare(`SELECT rowid AS cursor, interactionId, identityJson, endpointKey
            FROM coordination_runtime_questions WHERE rowid > ?
            ORDER BY rowid LIMIT 128`)
          .all(cursor) as Row[];
        if (rows.length === 0) break;
        for (const row of rows) {
          const rowCursor = z
            .number()
            .int()
            .positive()
            .safe()
            .parse(row.cursor);
          const identity = nativeInputEndpointIdentitySchema.parse(
            JSON.parse(z.string().parse(row.identityJson)),
          );
          if (String(row.endpointKey) !== nativeEndpointKey(identity))
            throw new Error("Stored native endpoint identity is inconsistent");
          const rpcId = identity.requestId;
          this.db
            .prepare(`UPDATE coordination_runtime_questions SET
              runtimeGeneration = ?, threadId = ?, turnId = ?, itemId = ?,
              rpcIdKind = ?, rpcIdValue = ? WHERE interactionId = ?`)
            .run(
              identity.runtimeGeneration,
              identity.threadId,
              identity.turnId,
              identity.itemId,
              typeof rpcId,
              String(rpcId),
              z.string().uuid().parse(row.interactionId),
            );
          cursor = rowCursor;
        }
      }
      this.db
        .prepare(
          "INSERT INTO coordination_runtime_migrations (migrationId) VALUES (?)",
        )
        .run("runtime-question-identity-v1");
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS coordination_runtime_typed_rpc
        ON coordination_runtime_questions(runtimeGeneration,threadId,rpcIdKind,rpcIdValue);
      CREATE INDEX IF NOT EXISTS coordination_runtime_pending_generation_answers
        ON coordination_runtime_questions(runtimeGeneration,requestState,interactionId)
        WHERE answerDigest IS NOT NULL AND replyIntentId IS NULL;
      CREATE INDEX IF NOT EXISTS coordination_interactions_requesting_work
        ON coordination_interactions(requestingWorkId,interactionId)`);
  }

  ensureDeliveryEventWithinTransaction(
    taskId: string,
    reason: string,
    identity: string,
  ): void {
    const lead = this.required(
      "SELECT assignmentId FROM task_lead_bindings WHERE taskId=?",
      taskId,
    );
    const prior = this.one(
      "SELECT 1 AS present FROM coordination_external_delivery_notices WHERE taskId=? AND identity=?",
      taskId,
      identity,
    );
    if (prior) return;
    const event = this.newEvent(
      taskId,
      String(lead.assignmentId),
      "pr-delivery",
      null,
      JSON.stringify({ reason, identity }),
    );
    this.db
      .prepare(
        "INSERT INTO coordination_external_delivery_notices VALUES (?,?,?)",
      )
      .run(taskId, identity, event.eventId);
  }
  deliveryActionBlockers(
    caller: RuntimeDeliveryCaller,
    reviewedResultIds: string[],
    exceptOperationId: string,
  ): string[] {
    const request: TaskCompletionRequest = {
      requestId: exceptOperationId,
      taskId: caller.taskId,
      leadAssignmentId: caller.assignmentId,
      leadWorkId: caller.workId,
      leadWorkRevision: caller.workRevision,
      taskVersion: caller.taskVersion,
      reviewedResultIds: [...new Set(reviewedResultIds)].sort(),
      status: "pending",
      rejectionReasons: [],
      revision: 1,
      createdAt: Date.now(),
      finalizedAt: null,
    };
    return [
      ...new Set([
        ...this.completionBlockers(request, "completed", true),
        ...new DeliveryStore(this.db).actionBlockers(
          caller.taskId,
          exceptOperationId,
        ),
        ...this.domain
          .admission(caller.taskId)
          .reasons.filter((r) => !r.startsWith("external-action-")),
      ]),
    ];
  }
  deliveryCaller(call: CoordinationCall): RuntimeDeliveryCaller {
    const parsed = generalCallSchema.parse(call),
      row = this.currentBinding(parsed.threadId, parsed.turnId);
    if (!row) throw new Error("Delivery call is not bound to current work");
    return {
      projectId: String(row.projectId),
      taskId: String(row.taskId),
      taskVersion: Number(row.taskVersion),
      assignmentId: String(row.assignmentId),
      assignmentVersion: Number(row.assignmentVersion),
      workId: String(row.workId),
      workRevision: Number(row.workRevision),
      conversationRevision: Number(row.conversationRevision),
    };
  }
  recordAsyncReceipt(
    call: CoordinationCall,
    caller: RuntimeDeliveryCaller,
    response: CoordinationToolResponse,
  ): CoordinationToolResponse {
    return transaction(this.db, () => {
      const prior = this.cachedToolResponse(call);
      if (prior) {
        return prior;
      }
      this.insertToolReceipt(call, caller as unknown as Row, response);
      return response;
    });
  }
  /** Matching lost-response retries replay before any current-generation query. */
  receipt(input: CoordinationCall): CoordinationReceipt | undefined {
    const call =
      input.tool === "ensemble_report_result"
        ? reportCallSchema.parse(input)
        : generalCallSchema.parse(input);
    const row = this.one(
      "SELECT threadId, turnId, callId, tool, payloadHash, taskId, assignmentId, workId, workRevision, response " +
        "FROM coordination_receipts WHERE threadId = ? AND turnId = ? AND callId = ?",
      call.threadId,
      call.turnId,
      call.callId,
    );
    if (!row) return undefined;
    if (
      row.threadId !== call.threadId ||
      row.turnId !== call.turnId ||
      row.callId !== call.callId
    )
      throw new Error("Stored coordination receipt identity mismatch");
    if (
      row.tool !== call.tool ||
      row.payloadHash !==
        payloadHash({ tool: call.tool, arguments: call.arguments })
    )
      throw new Error(
        "Coordination callback identity reused with different content",
      );
    return this.parseReceipt(row);
  }

  recordResult(
    input: CoordinationCall,
    evidenceCandidate?: RetainedEvidenceCandidate,
    options: { nativeResultCallback?: boolean } = {},
  ): {
    result: AssignmentResult;
    response: CoordinationToolResponse;
    replayed: boolean;
  } {
    const call = reportCallSchema.parse(input);
    const callHash = payloadHash({
      tool: call.tool,
      arguments: call.arguments,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.one(
        "SELECT threadId, turnId, callId, tool, payloadHash, taskId, assignmentId, workId, workRevision, response " +
          "FROM coordination_receipts WHERE threadId = ? AND turnId = ? AND callId = ?",
        call.threadId,
        call.turnId,
        call.callId,
      );
      if (prior) {
        if (
          prior.threadId !== call.threadId ||
          prior.turnId !== call.turnId ||
          prior.callId !== call.callId
        )
          throw new Error("Stored coordination receipt identity mismatch");
        if (prior.tool !== call.tool || prior.payloadHash !== callHash)
          throw new Error(
            "Coordination callback identity reused with different content",
          );
        const receipt = this.parseReceipt(prior);
        const result = this.resultByWork(receipt.workId);
        this.db.exec("COMMIT");
        return { result, response: receipt.response, replayed: true };
      }

      const binding = this.currentBinding(call.threadId, call.turnId);
      if (!binding)
        throw new Error("Coordination callback is not bound to current work");
      const unfinishedChild = this.one(
        `SELECT 1 FROM domain_assignments
        WHERE requesterAssignmentId = ? AND state <> 'completed'
        LIMIT 1`,
        String(binding.assignmentId),
      );
      if (unfinishedChild)
        throw new Error(
          "Assignment cannot report while delegated assignments are not completed",
        );
      const undeliveredInboxEvent = this.one(
        `SELECT 1 FROM coordination_inbox_events event
        WHERE event.recipientAssignmentId = ? AND event.eventType <> 'source-hold' AND (
          NOT EXISTS (
            SELECT 1 FROM coordination_delivery_events delivered
            WHERE delivered.eventId = event.eventId
          ) OR EXISTS (
            SELECT 1 FROM coordination_delivery_events delivered
            JOIN coordination_delivery_batches batch
              ON batch.batchId = delivered.batchId
            WHERE delivered.eventId = event.eventId
              AND batch.state = 'queued' AND batch.deliveryWorkId <> ?
          )
        )
        LIMIT 1`,
        String(binding.assignmentId),
        String(binding.workId),
      );
      if (undeliveredInboxEvent)
        throw new Error(
          "Assignment cannot report while inbox events remain undelivered",
        );
      const priorResult = this.one(
        "SELECT resultId, taskId, assignmentId, workId, workRevision, assignmentVersion, summary, payloadHash, recipientAssignmentId, destinationDisposition, createdAt " +
          "FROM coordination_results WHERE assignmentId = ? AND workRevision = ?",
        String(binding.assignmentId),
        Number(binding.workRevision),
      );
      if (
        options.nativeResultCallback === true &&
        !priorResult &&
        !evidenceCandidate
      )
        throw new Error(
          "Native result callback requires retained evidence capture",
        );
      let result: AssignmentResult;
      if (priorResult) {
        if (priorResult.payloadHash !== callHash)
          throw new Error("Result already recorded with different content");
        result = this.parseResult(priorResult);
      } else {
        const recipient = this.resolveRecipient(binding);
        const resultId = randomUUID();
        this.db
          .prepare(`INSERT INTO coordination_results
          (resultId, taskId, assignmentId, workId, workRevision, assignmentVersion,
            summary, payloadHash, recipientAssignmentId, destinationDisposition)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            resultId,
            String(binding.taskId),
            String(binding.assignmentId),
            String(binding.workId),
            Number(binding.workRevision),
            Number(binding.assignmentVersion),
            call.arguments.summary,
            callHash,
            recipient.id,
            recipient.resolved ? "resolved" : "unresolved",
          );
        if (recipient.resolved && recipient.id) {
          this.db
            .prepare(`INSERT INTO coordination_inbox_events
            (eventId, taskId, recipientAssignmentId, eventType, resultId, payload)
            VALUES (?, ?, ?, 'assignment-result', ?, ?)`)
            .run(
              randomUUID(),
              String(binding.taskId),
              recipient.id,
              resultId,
              JSON.stringify({
                resultId,
                assignmentId: binding.assignmentId,
                workId: binding.workId,
                workRevision: binding.workRevision,
                summary: call.arguments.summary,
              }),
            );
        } else {
          this.db
            .prepare(`INSERT INTO coordination_unresolved_result_destinations
            (resultId, taskId, assignmentId, originalDestination, reason, revision, status)
            VALUES (?, ?, ?, ?, ?, 1, 'unresolved')`)
            .run(
              resultId,
              String(binding.taskId),
              String(binding.assignmentId),
              binding.resultDestination === null
                ? null
                : String(binding.resultDestination),
              recipient.reason,
            );
        }
        this.db
          .prepare(
            "UPDATE domain_assignments SET state = 'completed' WHERE id = ? AND version = ?",
          )
          .run(String(binding.assignmentId), Number(binding.assignmentVersion));
        this.db
          .prepare(`UPDATE coordination_reporting_repairs
          SET state = 'resolved', reason = NULL, updatedAt = unixepoch()
          WHERE assignmentId = ? AND assignmentVersion = ? AND state = 'queued'`)
          .run(String(binding.assignmentId), Number(binding.assignmentVersion));
        result = this.resultById(resultId);
        if (call.arguments.review)
          new TaskReviewStore(this.db).recordResult(
            result,
            call.arguments.review,
          );
        else
          new TaskReviewStore(this.db).indexResult(
            result.resultId,
            result.taskId,
            String(binding.projectId),
            result.summary,
            result.createdAt * 1000,
          );
        if (evidenceCandidate) {
          const currentIdentity = this.retainedEvidenceIdentity(binding, call);
          if (!currentIdentity)
            throw new Error("Coordination callback request identity changed");
          const evidenceStore = this.retainedEvidence();
          const owner = {
            resultId: result.resultId,
            taskId: result.taskId,
            assignmentId: result.assignmentId,
            assignmentVersion: result.assignmentVersion,
            workId: result.workId,
            workRevision: result.workRevision,
          };
          this.db.exec("SAVEPOINT retained_result_evidence_write");
          try {
            evidenceStore.recordResultWithinTransaction(
              owner,
              currentIdentity,
              evidenceCandidate,
            );
            this.db.exec("RELEASE SAVEPOINT retained_result_evidence_write");
          } catch (evidenceWriteFailure) {
            try {
              this.db.exec(
                "ROLLBACK TO SAVEPOINT retained_result_evidence_write",
              );
              this.db.exec("RELEASE SAVEPOINT retained_result_evidence_write");
            } catch {
              // SQLite may have aborted the transaction; retain the original write failure.
              throw evidenceWriteFailure;
            }
            evidenceStore.recordResultWithinTransaction(
              owner,
              currentIdentity,
              unavailableRetainedEvidenceCandidate(evidenceCandidate),
            );
          }
        }
      }
      const settledEffect = this.db
        .prepare(`UPDATE execution_pending_effects
        SET state = 'settled', reason = NULL
        WHERE workId = ? AND effectKey = 'assignment-result' AND state = 'pending'
          AND EXISTS (
            SELECT 1 FROM task_execution_bindings exact
            WHERE exact.workId = ? AND exact.taskId = ?
              AND exact.assignmentId = ? AND exact.assignmentVersion = ?
          )
        RETURNING workId`)
        .get(
          String(binding.workId),
          String(binding.workId),
          String(binding.taskId),
          String(binding.assignmentId),
          Number(binding.assignmentVersion),
        ) as Row | undefined;
      if (
        settledEffect &&
        String(settledEffect.workId) !== String(binding.workId)
      )
        throw new Error("Assignment result settled a different work effect");
      const response = {
        text: `Result recorded: ${result.resultId}`,
        success: true,
      };
      this.db
        .prepare(`INSERT INTO coordination_receipts
        (threadId, turnId, callId, tool, payloadHash, taskId, assignmentId,
          workId, workRevision, response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          call.threadId,
          call.turnId,
          call.callId,
          call.tool,
          callHash,
          result.taskId,
          result.assignmentId,
          result.workId,
          result.workRevision,
          JSON.stringify(response),
        );
      this.db.exec("COMMIT");
      return { result, response, replayed: false };
    } catch (error) {
      try {
        if (this.db.isTransaction !== false) this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite already aborted the transaction.
      }
      throw error;
    }
  }

  delegate(
    input: CoordinationCall,
    externalAdmission: () => boolean = () => true,
  ): CoordinationToolResponse {
    const call = delegateCallSchema.parse(input);
    return transaction(this.db, () => {
      const replay = this.cachedToolResponse(call);
      if (replay) {
        return replay;
      }
      const binding = this.currentBinding(call.threadId, call.turnId);
      if (!binding) throw new Error("Delegation is not bound to current work");
      const admission = this.domain.admission(String(binding.taskId));
      if (!admission.eligible)
        throw new Error(
          `Task admission rejected delegation: ${admission.reasons.join(", ")}`,
        );
      if (!externalAdmission())
        throw new Error("External task hold blocks delegation");
      const profile = this.required(
        "SELECT version, revoked FROM profiles WHERE id = ?",
        call.arguments.profileId,
      );
      if (profile.revoked !== 0)
        throw new Error("Delegated profile is revoked");
      const project = this.required(
        "SELECT leadProfileId, instructionsRevision FROM domain_projects WHERE id = ?",
        String(binding.projectId),
      );
      const routing = this.required(
        "SELECT candidateProfileIds FROM project_routing WHERE projectId = ?",
        String(binding.projectId),
      );
      const permittedProfiles = JSON.parse(
        String(routing.candidateProfileIds),
      ) as string[];
      if (
        project.leadProfileId !== call.arguments.profileId &&
        !permittedProfiles.includes(call.arguments.profileId)
      )
        throw new Error("Delegated profile is not permitted for this project");
      const assignmentId = randomUUID();
      this.db
        .prepare(`INSERT INTO domain_assignments
        (id, taskId, projectId, version, profileId, profileRevision,
          instructionsRevision, brief, resultDestination, requesterAssignmentId,
          resultRecipientAssignmentId, resultRecipientDisposition, state)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'resolved', 'pending')`)
        .run(
          assignmentId,
          String(binding.taskId),
          String(binding.projectId),
          call.arguments.profileId,
          Number(profile.version),
          Number(project.instructionsRevision),
          call.arguments.brief,
          String(binding.assignmentId),
          String(binding.assignmentId),
          String(binding.assignmentId),
        );
      const response = {
        text: `Delegated assignment ${assignmentId}`,
        success: true,
      };
      this.insertToolReceipt(call, binding, response);
      return response;
    });
  }

  requestQuestion(input: CoordinationCall): CoordinationToolResponse {
    const call = questionCallSchema.parse(input);
    return this.requestInteraction(call, "question", {
      prompt:
        "question" in call.arguments
          ? call.arguments.question
          : "Structured question",
      ...("form" in call.arguments ? { form: call.arguments.form } : {}),
      action: null,
      target: null,
      materialHash: null,
      materialJson: null,
    });
  }

  requestApproval(input: CoordinationCall): CoordinationToolResponse {
    const call = approvalCallSchema.parse(input);
    const materialJson = canonical(call.arguments.material);
    if (new TextEncoder().encode(materialJson).byteLength > 8192)
      throw new Error("Approval material exceeds the 8 KiB operator limit");
    return this.requestInteraction(call, "approval", {
      prompt: `Approval requested for ${call.arguments.action}`,
      action: call.arguments.action,
      target: call.arguments.target ?? null,
      materialHash: payloadHash(call.arguments.material),
      materialJson,
    });
  }

  private parseRuntimeQuestion(row: Row): RuntimeQuestionRecord {
    const identity = nativeInputEndpointIdentitySchema.parse(
      JSON.parse(String(row.identityJson)),
    );
    const qualification = JSON.parse(
      String(row.qualificationJson),
    ) as RuntimeUserInputRequest["qualification"];
    const request = parseNativeInputRequest(
      JSON.parse(String(row.requestJson)),
      qualification,
    );
    const answers =
      row.answerJson === null
        ? null
        : validateStructuredAnswers(
            request.questions,
            JSON.parse(String(row.answerJson)),
          );
    return {
      interactionId: String(row.interactionId),
      taskId: String(row.taskId),
      requestingAssignmentId: String(row.requestingAssignmentId),
      requestingWorkId: String(row.requestingWorkId),
      revision: Number(row.revision),
      identity,
      request,
      qualification,
      answers,
      answerDigest: row.answerDigest === null ? null : String(row.answerDigest),
      replyIntentId:
        row.replyIntentId === null ? null : String(row.replyIntentId),
      deliveryState: runtimeAnswerReceiptSchema.shape.deliveryState.parse(
        row.deliveryState,
      ),
      requestState: z
        .enum(["available", "unavailable"])
        .parse(row.requestState),
      reason: row.reason === null ? null : String(row.reason),
    };
  }

  private runtimeQuestionSelect(): string {
    return `SELECT runtime.*,interaction.taskId,interaction.requestingAssignmentId,
      interaction.requestingWorkId,interaction.revision
      FROM coordination_runtime_questions runtime
      JOIN coordination_interactions interaction USING(interactionId)`;
  }

  runtimeQuestions(taskId?: string): RuntimeQuestionRecord[] {
    const sql = `SELECT runtime.*,interaction.taskId,interaction.requestingAssignmentId,interaction.requestingWorkId,interaction.revision FROM coordination_runtime_questions runtime JOIN coordination_interactions interaction USING(interactionId)${taskId ? " WHERE interaction.taskId = ?" : ""} ORDER BY interaction.createdAt,interaction.interactionId`;
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseRuntimeQuestion(row));
  }

  runtimeQuestionByInteractionId(
    interactionId: string,
    taskId?: string,
  ): RuntimeQuestionRecord | undefined {
    const row = this.db
      .prepare(`${this.runtimeQuestionSelect()}
        WHERE runtime.interactionId = ?${taskId ? " AND interaction.taskId = ?" : ""}`)
      .get(
        uuid.parse(interactionId),
        ...(taskId ? [uuid.parse(taskId)] : []),
      ) as Row | undefined;
    return row ? this.parseRuntimeQuestion(row) : undefined;
  }

  runtimeQuestionByEndpoint(
    identity: NativeInputEndpointIdentity,
  ): RuntimeQuestionRecord | undefined {
    const endpoint = nativeInputEndpointIdentitySchema.parse(identity);
    const row = this.db
      .prepare(`${this.runtimeQuestionSelect()} WHERE runtime.endpointKey = ?`)
      .get(nativeEndpointKey(endpoint)) as Row | undefined;
    if (!row) return undefined;
    const record = this.parseRuntimeQuestion(row);
    if (nativeEndpointKey(record.identity) !== nativeEndpointKey(endpoint))
      throw new Error("Stored native endpoint identity is inconsistent");
    return record;
  }

  runtimeQuestionsForWork(
    workId: string,
    activeOnly = false,
    runtimeGeneration?: string,
  ): RuntimeQuestionRecord[] {
    if (activeOnly && !runtimeGeneration)
      throw new Error("Active native questions require a runtime generation");
    const activeFilter = activeOnly
      ? ` AND runtime.requestState = 'available'
          AND runtime.deliveryState IN ('unanswered','recorded','held','sending','sent-unconfirmed','uncertain')${runtimeGeneration ? " AND runtime.runtimeGeneration = ?" : ""}`
      : "";
    const rows = this.db
      .prepare(`${this.runtimeQuestionSelect()}
        WHERE interaction.requestingWorkId = ?${activeFilter}
        ORDER BY runtime.interactionId`)
      .all(
        z.string().min(1).parse(workId),
        ...(activeOnly && runtimeGeneration
          ? [z.string().min(1).max(128).parse(runtimeGeneration)]
          : []),
      ) as Row[];
    return rows.map((row) => this.parseRuntimeQuestion(row));
  }

  pendingRuntimeAnswersPage(
    runtimeGeneration: string,
    afterInteractionId: string,
    limit = 64,
  ): RuntimeQuestionRecord[] {
    const pageSize = z.number().int().min(1).max(128).parse(limit);
    const rows = this.db
      .prepare(`${this.runtimeQuestionSelect()}
        WHERE runtime.runtimeGeneration = ?
          AND runtime.requestState = 'available'
          AND runtime.answerDigest IS NOT NULL
          AND runtime.replyIntentId IS NULL
          AND runtime.interactionId > ?
        ORDER BY runtime.interactionId LIMIT ?`)
      .all(
        z.string().min(1).max(128).parse(runtimeGeneration),
        z.string().max(128).parse(afterInteractionId),
        pageSize,
      ) as Row[];
    return rows.map((row) => this.parseRuntimeQuestion(row));
  }

  runtimeNativeEndpointHistory(
    identity: NativeInputEndpointIdentity,
  ): "new" | "exact-identity-seen" | "typed-id-reused" {
    const endpoint = nativeInputEndpointIdentitySchema.parse(identity);
    const endpointKey = nativeEndpointKey(endpoint);
    const exact = this.db
      .prepare(`SELECT identityJson, endpointKey, runtimeGeneration, threadId,
        turnId, itemId, rpcIdKind, rpcIdValue
        FROM coordination_runtime_questions WHERE endpointKey = ? LIMIT 2`)
      .all(endpointKey) as Row[];
    if (exact.length > 1)
      throw new Error("Stored native endpoint identity is ambiguous");
    if (exact.length === 1) {
      const row = exact[0]!;
      const stored = nativeInputEndpointIdentitySchema.parse(
        JSON.parse(String(row.identityJson)),
      );
      if (
        nativeEndpointKey(stored) !== endpointKey ||
        row.runtimeGeneration !== stored.runtimeGeneration ||
        row.threadId !== stored.threadId ||
        row.turnId !== stored.turnId ||
        row.itemId !== stored.itemId ||
        row.rpcIdKind !== typeof stored.requestId ||
        row.rpcIdValue !== String(stored.requestId)
      )
        throw new Error("Stored native endpoint index is inconsistent");
      return "exact-identity-seen";
    }
    const reused = this.db
      .prepare(`SELECT identityJson, runtimeGeneration, threadId, turnId, itemId,
        rpcIdKind, rpcIdValue FROM coordination_runtime_questions
        WHERE runtimeGeneration = ? AND threadId = ?
          AND rpcIdKind = ? AND rpcIdValue = ? LIMIT 1`)
      .get(
        endpoint.runtimeGeneration,
        endpoint.threadId,
        typeof endpoint.requestId,
        String(endpoint.requestId),
      ) as Row | undefined;
    if (!reused) return "new";
    const stored = nativeInputEndpointIdentitySchema.parse(
      JSON.parse(String(reused.identityJson)),
    );
    if (
      reused.runtimeGeneration !== stored.runtimeGeneration ||
      reused.threadId !== stored.threadId ||
      reused.turnId !== stored.turnId ||
      reused.itemId !== stored.itemId ||
      reused.rpcIdKind !== typeof stored.requestId ||
      reused.rpcIdValue !== String(stored.requestId)
    )
      throw new Error("Stored native endpoint index is inconsistent");
    return "typed-id-reused";
  }
  private requiredRuntimeQuestion(
    interactionId: string,
    taskId?: string,
  ): RuntimeQuestionRecord {
    const record = this.runtimeQuestionByInteractionId(interactionId, taskId);
    if (!record) throw new Error("Persisted native question is unavailable");
    return record;
  }
  recordRuntimeQuestion(input: RuntimeUserInputRequest): RuntimeQuestionRecord {
    const identity = nativeInputEndpointIdentitySchema.parse(input.identity);
    const request = parseNativeInputRequest(input.request, input.qualification);
    if (
      identity.threadId !== request.threadId ||
      identity.turnId !== request.turnId ||
      identity.itemId !== request.itemId ||
      identity.runtimeGeneration !== input.qualification.runtimeGeneration
    )
      throw new Error("Native request identity mismatch");
    const key = nativeEndpointKey(identity);
    const digest = payloadHash(request);
    return transaction(this.db, () => {
      const prior = this.one(
        "SELECT interactionId,requestDigest FROM coordination_runtime_questions WHERE endpointKey = ?",
        key,
      );
      if (prior) {
        if (prior.requestDigest !== digest)
          throw new Error("Conflicting native request replay");
        if (
          this.runtimeNativeEndpointHistory(identity) !== "exact-identity-seen"
        )
          throw new Error("Stored native endpoint identity is inconsistent");
        return this.requiredRuntimeQuestion(String(prior.interactionId));
      }
      if (this.runtimeNativeEndpointHistory(identity) !== "new")
        throw new Error("Native RPC identity was already used");
      const binding = this.currentBinding(identity.threadId, identity.turnId);
      if (!binding)
        throw new Error("Native request is not bound to running work");
      const interactionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO coordination_interactions (interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,revision) VALUES (?,?,?,?,?,?,?,'question','open',?,1)`,
        )
        .run(
          interactionId,
          String(binding.taskId),
          String(binding.assignmentId),
          String(binding.workId),
          Number(binding.workRevision),
          Number(binding.assignmentVersion),
          Number(binding.conversationRevision),
          request.questions.map((q) => q.question).join("\n"),
        );
      this.db
        .prepare(
          `INSERT INTO coordination_runtime_questions
          (interactionId,endpointKey,identityJson,requestJson,qualificationJson,
            requestDigest,runtimeGeneration,threadId,turnId,itemId,rpcIdKind,
            rpcIdValue,requestState,deliveryState)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'available','unanswered')`,
        )
        .run(
          interactionId,
          key,
          JSON.stringify(identity),
          JSON.stringify(request),
          JSON.stringify(input.qualification),
          digest,
          identity.runtimeGeneration,
          identity.threadId,
          identity.turnId,
          identity.itemId,
          typeof identity.requestId,
          String(identity.requestId),
        );
      this.db
        .prepare(
          `INSERT INTO coordination_operator_attention (attentionId,taskId,interactionId,status,revision) VALUES (?,?,?,'open',1)`,
        )
        .run(randomUUID(), String(binding.taskId), interactionId);
      return this.requiredRuntimeQuestion(
        interactionId,
        String(binding.taskId),
      );
    });
  }
  answerRuntimeQuestion(
    input: z.infer<typeof runtimeQuestionAnswerCommandSchema>,
  ): RuntimeQuestionAnswerReceipt {
    const command = runtimeQuestionAnswerCommandSchema.parse(input);
    const { key: _key, actor: _actor, ...payload } = command;
    return transaction(this.db, () => {
      const prior = this.one(
        `SELECT payloadHash,result FROM coordination_operator_receipts WHERE scope='answer-runtime-question' AND commandKey=?`,
        command.key,
      );
      if (prior) {
        if (prior.payloadHash !== payloadHash(payload))
          throw new Error("Operator command key reused with different content");
        return runtimeAnswerReceiptSchema.parse(
          JSON.parse(String(prior.result)),
        );
      }
      const question = this.runtimeQuestionByInteractionId(
        command.interactionId,
        command.taskId,
      );
      if (
        question?.requestState !== "available" ||
        question.answers ||
        question.revision !== command.expectedRevision
      )
        throw new Error(
          "Native question unavailable, already answered or stale",
        );
      if (
        !this.one(
          `SELECT binding.workId FROM task_execution_bindings binding JOIN execution_intents intent ON intent.workId=binding.workId JOIN task_work_revisions revision ON revision.workId=binding.workId JOIN domain_assignments assignment ON assignment.id=binding.assignmentId JOIN assignment_conversations conversation ON conversation.assignmentId=binding.assignmentId JOIN coordination_interactions interaction ON interaction.requestingWorkId=binding.workId WHERE interaction.interactionId=? AND intent.threadId=? AND intent.turnId=? AND intent.state IN ('running','held') AND assignment.version=binding.assignmentVersion AND conversation.revision=binding.conversationRevision AND revision.workRevision=interaction.requestingWorkRevision AND NOT EXISTS(SELECT 1 FROM task_work_revisions newer WHERE newer.assignmentId=revision.assignmentId AND newer.conversationRevision=revision.conversationRevision AND newer.workRevision>revision.workRevision) AND NOT EXISTS(SELECT 1 FROM task_work_revision_ambiguities ambiguous WHERE ambiguous.assignmentId=binding.assignmentId AND ambiguous.conversationRevision=binding.conversationRevision)`,
          question.interactionId,
          question.identity.threadId,
          question.identity.turnId,
        )
      )
        throw new Error("Native requesting work is stale");
      const answers = validateStructuredAnswers(
        question.request.questions,
        command.answers,
      );
      const answerDigest = payloadHash(answers);
      const receipt: RuntimeQuestionAnswerReceipt = {
        interactionId: question.interactionId,
        revision: question.revision + 1,
        recorded: true,
        deliveryState: "recorded",
      };
      this.db
        .prepare(
          `UPDATE coordination_runtime_questions SET answerJson=?,answerDigest=?,deliveryState='recorded' WHERE interactionId=? AND answerJson IS NULL`,
        )
        .run(JSON.stringify(answers), answerDigest, question.interactionId);
      this.db
        .prepare(
          `UPDATE coordination_interactions SET status='answered',response='Structured answer recorded; runtime delivery pending',revision=revision+1,updatedAt=unixepoch() WHERE interactionId=?`,
        )
        .run(question.interactionId);
      this.db
        .prepare(
          `INSERT INTO coordination_operator_receipts (scope,commandKey,payloadHash,result) VALUES ('answer-runtime-question',?,?,?)`,
        )
        .run(command.key, payloadHash(payload), JSON.stringify(receipt));
      return receipt;
    });
  }
  holdRuntimeAnswer(interactionId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE coordination_runtime_questions SET deliveryState='held',reason=? WHERE interactionId=? AND answerJson IS NOT NULL AND replyIntentId IS NULL AND requestState='available'`,
      )
      .run(reason.slice(0, 1024), uuid.parse(interactionId));
  }
  beginRuntimeReply(
    interactionId: string,
    identity: NativeInputEndpointIdentity,
  ): RuntimeReplyIntent {
    return transaction(this.db, () => {
      const question = this.runtimeQuestionByInteractionId(interactionId);
      if (
        !question ||
        nativeEndpointKey(question.identity) !== nativeEndpointKey(identity) ||
        question.requestState !== "available" ||
        !question.answers ||
        !question.answerDigest ||
        question.replyIntentId
      )
        throw new Error("Native reply intent unavailable");
      const replyIntentId = randomUUID();
      this.db
        .prepare(
          `UPDATE coordination_runtime_questions SET replyIntentId=?,deliveryState='sending',reason=NULL WHERE interactionId=? AND replyIntentId IS NULL`,
        )
        .run(replyIntentId, interactionId);
      return { replyIntentId, answerDigest: question.answerDigest };
    });
  }
  recordRuntimeReplyOutcome(
    input: RuntimeUserInputOutcome,
  ): RuntimeQuestionRecord {
    const outcome = runtimeUserInputOutcomeSchema.parse(input);
    const {
      outcome: _outcome,
      reason: _reason,
      replyIntentId: _intent,
      answerDigest: _digest,
      orderedReceipt: _receipt,
      ...identity
    } = outcome;
    return transaction(this.db, () => {
      const question = this.runtimeQuestionByEndpoint(identity);
      if (!question) throw new Error("Unknown native outcome identity");
      if (
        question.replyIntentId !== (outcome.replyIntentId ?? null) ||
        (question.replyIntentId !== null &&
          question.answerDigest !== outcome.answerDigest)
      )
        throw new Error("Native outcome intent mismatch");
      if (!question.replyIntentId && outcome.outcome !== "unavailable")
        throw new Error("Native outcome requires an intent");
      if (question.deliveryState === "confirmed") return question;
      if (
        ["uncertain", "unavailable"].includes(question.deliveryState) &&
        outcome.outcome !== question.deliveryState
      )
        throw new Error("Native uncertain outcome cannot upgrade");
      this.db
        .prepare(
          `UPDATE coordination_runtime_questions SET deliveryState=?,requestState=?,reason=?,outcomeJson=? WHERE interactionId=?`,
        )
        .run(
          outcome.outcome,
          outcome.outcome === "sent-unconfirmed" ? "available" : "unavailable",
          outcome.reason,
          JSON.stringify(outcome),
          question.interactionId,
        );
      if (outcome.outcome === "confirmed")
        this.resolveAttention(question.interactionId);
      return this.requiredRuntimeQuestion(
        question.interactionId,
        question.taskId,
      );
    });
  }
  invalidateRuntimeQuestions(reason: string): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE coordination_runtime_questions SET requestState='unavailable',deliveryState=CASE WHEN replyIntentId IS NULL THEN 'unavailable' ELSE 'uncertain' END,reason=? WHERE deliveryState<>'confirmed'`,
        )
        .run(reason.slice(0, 1024));
    });
  }

  interactions(taskId?: string): CoordinationInteraction[] {
    const sql =
      "SELECT interactionId, taskId, requestingAssignmentId, " +
      "requestingWorkId, requestingWorkRevision, requestingAssignmentVersion, " +
      "conversationRevision, kind, status, prompt, action, target, materialHash, " +
      "materialJson, response, revision, createdAt, updatedAt FROM coordination_interactions" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY createdAt, interactionId";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseInteraction(row));
  }

  operatorAttention(taskId?: string): OperatorAttention[] {
    const sql =
      "SELECT attentionId, taskId, interactionId, status, revision, " +
      "createdAt, resolvedAt FROM coordination_operator_attention" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY createdAt, attentionId";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseAttention(row));
  }

  answerQuestion(input: {
    actor: "operator";
    key: string;
    interactionId: string;
    expectedRevision: number;
    answer: string;
  }): InboxEvent {
    const command = answerSchema.parse(input);
    const payload = {
      interactionId: command.interactionId,
      expectedRevision: command.expectedRevision,
      answer: command.answer,
    };
    return transaction(this.db, () => {
      const replay = this.replayOperatorEvent(
        "answer-question",
        command.key,
        payload,
      );
      if (replay) {
        return replay;
      }
      const interaction = this.required(
        "SELECT * FROM coordination_interactions WHERE interactionId = ?",
        command.interactionId,
      );
      if (
        this.one(
          "SELECT interactionId FROM coordination_runtime_questions WHERE interactionId=?",
          command.interactionId,
        )
      )
        throw new Error("Native questions require their native answer command");
      this.requireOpenInteraction(
        interaction,
        "question",
        command.expectedRevision,
      );
      this.requireOwnQuestionEligibility(interaction);
      if (this.questionForm(command.interactionId))
        throw new Error(
          "Structured questions require their form answer command",
        );
      const event = this.insertInteractionEvent(
        String(interaction.taskId),
        String(interaction.requestingAssignmentId),
        String(interaction.interactionId),
        "question-answer",
        {
          interactionId: command.interactionId,
          revision: command.expectedRevision + 1,
          answer: command.answer,
          ...this.questionAttribution(interaction),
        },
      );
      this.db
        .prepare(`UPDATE coordination_interactions
        SET status = 'answered', response = ?, revision = revision + 1,
          updatedAt = unixepoch()
        WHERE interactionId = ? AND status = 'open' AND revision = ?`)
        .run(command.answer, command.interactionId, command.expectedRevision);
      this.resolveAttention(command.interactionId);
      this.saveOperatorReceipt(
        "answer-question",
        command.key,
        payload,
        event.eventId,
      );
      return event;
    });
  }

  questionForm(interactionId: string): {
    form: QuestionForm;
    answers: QuestionAnswers | null;
    requestState: "available" | "cancelled" | "superseded" | "unavailable";
  } | null {
    const row = this.one(
      "SELECT * FROM coordination_question_forms WHERE interactionId=?",
      interactionId,
    );
    return row
      ? {
          form: questionFormSchema.parse(JSON.parse(String(row.schemaJson))),
          answers:
            row.answerJson === null
              ? null
              : questionAnswersSchema.parse(JSON.parse(String(row.answerJson))),
          requestState: z
            .enum(["available", "cancelled", "superseded", "unavailable"])
            .parse(row.requestState),
        }
      : null;
  }

  questionFormSummaries(
    taskId: string,
  ): Array<{ interactionId: string; requestState: string }> {
    return (
      this.db
        .prepare(
          "SELECT form.interactionId,form.requestState FROM coordination_question_forms form JOIN coordination_interactions interaction ON interaction.interactionId=form.interactionId WHERE interaction.taskId=?",
        )
        .all(taskId) as Row[]
    ).map((row) => ({
      interactionId: String(row.interactionId),
      requestState: String(row.requestState),
    }));
  }
  ownQuestionEligibility(interactionId: string): boolean {
    try {
      const interaction = this.required(
        "SELECT * FROM coordination_interactions WHERE interactionId=?",
        interactionId,
      );
      this.requireOwnQuestionEligibility(interaction);
      return true;
    } catch {
      return false;
    }
  }
  recordedQuestionFormAnswer(input: {
    key: string;
    interactionId: string;
    expectedRevision: number;
    answers: QuestionAnswers;
  }): InboxEvent | undefined {
    const { key, ...payload } = input;
    return this.replayOperatorEvent("answer-question-form", key, payload);
  }
  recordedRuntimeQuestionAnswer(input: {
    key: string;
    taskId: string;
    interactionId: string;
    expectedRevision: number;
    answers: StructuredQuestionAnswers;
  }): RuntimeQuestionAnswerReceipt | undefined {
    const { key, ...payload } = input;
    const prior = this.one(
      "SELECT payloadHash,result FROM coordination_operator_receipts WHERE scope='answer-runtime-question' AND commandKey=?",
      key,
    );
    if (!prior) return undefined;
    if (prior.payloadHash !== payloadHash(payload))
      throw new Error("Operator command key reused with different content");
    return runtimeAnswerReceiptSchema.parse(JSON.parse(String(prior.result)));
  }
  private questionAttribution(row: Row) {
    return {
      requestingWorkId: String(row.requestingWorkId),
      requestingWorkRevision: Number(row.requestingWorkRevision),
      requestingAssignmentVersion: Number(row.requestingAssignmentVersion),
      conversationRevision: Number(row.conversationRevision),
    };
  }

  private requireOwnQuestionEligibility(interaction: Row): void {
    const rows = this.db
      .prepare(`SELECT binding.workId FROM task_execution_bindings binding
      JOIN domain_tasks task ON task.id=binding.taskId
      JOIN domain_assignments assignment ON assignment.id=binding.assignmentId AND assignment.taskId=binding.taskId
      JOIN execution_intents intent ON intent.workId=binding.workId
      JOIN task_work_revisions revision ON revision.workId=binding.workId
      JOIN assignment_conversations conversation ON conversation.assignmentId=binding.assignmentId
      WHERE binding.workId=? AND binding.taskId=? AND binding.assignmentId=?
        AND binding.assignmentVersion=? AND assignment.version=binding.assignmentVersion
        AND binding.conversationRevision=? AND conversation.revision=binding.conversationRevision
        AND revision.workRevision=? AND revision.assignmentId=binding.assignmentId AND revision.conversationRevision=binding.conversationRevision
        AND task.state='open' AND assignment.state IN ('pending','running','held')
        AND intent.state IN ('running','held','completed') AND intent.threadId IS NOT NULL AND intent.turnId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM task_work_revision_ambiguities ambiguous WHERE ambiguous.assignmentId=binding.assignmentId AND ambiguous.conversationRevision=binding.conversationRevision)
        AND NOT EXISTS (SELECT 1 FROM coordination_question_forms form WHERE form.interactionId=? AND form.requestState!='available')
        AND NOT EXISTS (SELECT 1 FROM execution_intents duplicate WHERE duplicate.workId!=intent.workId AND duplicate.threadId=intent.threadId AND duplicate.turnId=intent.turnId)
      LIMIT 2`)
      .all(
        String(interaction.requestingWorkId),
        String(interaction.taskId),
        String(interaction.requestingAssignmentId),
        Number(interaction.requestingAssignmentVersion),
        Number(interaction.conversationRevision),
        Number(interaction.requestingWorkRevision),
        String(interaction.interactionId),
      );
    if (rows.length !== 1)
      throw new Error(
        "Question requesting work is stale, cancelled or ambiguous",
      );
  }

  answerQuestionForm(input: {
    actor: "operator";
    key: string;
    interactionId: string;
    expectedRevision: number;
    answers: QuestionAnswers;
  }): InboxEvent {
    const command = z
      .object({
        actor: z.literal("operator"),
        key: operatorCommandKey,
        interactionId: uuid,
        expectedRevision: z.number().int().positive(),
        answers: questionAnswersSchema,
      })
      .strict()
      .parse(input);
    const { key: _key, actor: _actor, ...payload } = command;
    return transaction(this.db, () => {
      const replay = this.replayOperatorEvent(
        "answer-question-form",
        command.key,
        payload,
      );
      if (replay) return replay;
      const interaction = this.required(
        "SELECT * FROM coordination_interactions WHERE interactionId=?",
        command.interactionId,
      );
      this.requireOpenInteraction(
        interaction,
        "question",
        command.expectedRevision,
      );
      this.requireOwnQuestionEligibility(interaction);
      const stored = this.questionForm(command.interactionId);
      if (!stored || stored.answers)
        throw new Error("Structured question unavailable or already answered");
      const answers = validateQuestionAnswers(stored.form, command.answers);
      const event = this.insertInteractionEvent(
        String(interaction.taskId),
        String(interaction.requestingAssignmentId),
        command.interactionId,
        "question-answer",
        {
          interactionId: command.interactionId,
          revision: command.expectedRevision + 1,
          formVersion: 1,
          answers,
          ...this.questionAttribution(interaction),
        },
      );
      this.db
        .prepare(
          "UPDATE coordination_question_forms SET answerJson=?,answerDigest=? WHERE interactionId=?",
        )
        .run(
          JSON.stringify(answers),
          payloadHash(answers),
          command.interactionId,
        );
      this.db
        .prepare(
          "UPDATE coordination_interactions SET status='answered',response='Structured answer recorded',revision=revision+1,updatedAt=unixepoch() WHERE interactionId=?",
        )
        .run(command.interactionId);
      this.resolveAttention(command.interactionId);
      this.saveOperatorReceipt(
        "answer-question-form",
        command.key,
        payload,
        event.eventId,
      );
      return event;
    });
  }

  decideApproval(input: {
    actor: "operator";
    key: string;
    interactionId: string;
    expectedRevision: number;
    decision: "approved" | "denied";
    action: string;
    target?: string;
    material?: unknown;
  }): InboxEvent {
    const command = approvalDecisionSchema.parse(input);
    const payload = {
      interactionId: command.interactionId,
      expectedRevision: command.expectedRevision,
      decision: command.decision,
      action: command.action,
      target: command.target ?? null,
      materialHash:
        command.material === undefined ? null : payloadHash(command.material),
    };
    return transaction(this.db, () => {
      const replay = this.replayOperatorEvent(
        "decide-approval",
        command.key,
        payload,
      );
      if (replay) {
        return replay;
      }
      const interaction = this.required(
        "SELECT interactionId, taskId, requestingAssignmentId, kind, status, action, target, materialHash, materialJson, revision FROM coordination_interactions WHERE interactionId = ?",
        command.interactionId,
      );
      this.requireOpenInteraction(
        interaction,
        "approval",
        command.expectedRevision,
      );
      if (
        interaction.action !== command.action ||
        interaction.target !== (command.target ?? null)
      )
        throw new Error(
          "Approval material does not match the requested revision",
        );
      if (interaction.materialJson === null) {
        if (command.decision === "approved")
          throw new Error(
            "Legacy approval material is unavailable and cannot be approved",
          );
        if (
          command.material !== undefined &&
          interaction.materialHash !== payload.materialHash
        )
          throw new Error(
            "Approval material does not match the requested revision",
          );
      } else if (
        command.material === undefined ||
        canonical(command.material) !== interaction.materialJson ||
        interaction.materialHash !== payload.materialHash
      ) {
        throw new Error(
          "Approval material does not match the requested revision",
        );
      }
      const materialHash = String(interaction.materialHash);
      const event = this.insertInteractionEvent(
        String(interaction.taskId),
        String(interaction.requestingAssignmentId),
        String(interaction.interactionId),
        "approval-decision",
        {
          interactionId: command.interactionId,
          revision: command.expectedRevision + 1,
          decision: command.decision,
          action: command.action,
          target: command.target ?? null,
          materialHash,
        },
      );
      this.db
        .prepare(`UPDATE coordination_interactions
        SET status = ?, response = ?, revision = revision + 1,
          updatedAt = unixepoch()
        WHERE interactionId = ? AND status = 'open' AND revision = ?`)
        .run(
          command.decision,
          command.decision,
          command.interactionId,
          command.expectedRevision,
        );
      this.resolveAttention(command.interactionId);
      this.saveOperatorReceipt(
        "decide-approval",
        command.key,
        payload,
        event.eventId,
      );
      return event;
    });
  }

  postOperatorMessage(input: {
    actor: "operator";
    key: string;
    taskId: string;
    recipientAssignmentId: string;
    expectedAssignmentVersion: number;
    message: string;
    reference?: z.infer<typeof feedbackReferenceSchema> | undefined;
  }): InboxEvent {
    const command = operatorMessageSchema.parse(input);
    const payload = {
      taskId: command.taskId,
      recipientAssignmentId: command.recipientAssignmentId,
      expectedAssignmentVersion: command.expectedAssignmentVersion,
      message: command.message,
      ...(command.reference ? { reference: command.reference } : {}),
    };
    return transaction(this.db, () => {
      const replay = this.replayOperatorEvent(
        "operator-message",
        command.key,
        payload,
      );
      if (replay) {
        return replay;
      }
      const assignment = this.required(
        "SELECT id, taskId, version, state FROM domain_assignments WHERE id = ?",
        command.recipientAssignmentId,
      );
      if (assignment.taskId !== command.taskId)
        throw new Error("Message recipient belongs to another task");
      if (Number(assignment.version) !== command.expectedAssignmentVersion)
        throw new Error("Message recipient assignment version conflict");
      if (assignment.state !== "pending" && assignment.state !== "running")
        throw new Error("Message recipient must be pending or running");
      if (command.reference) {
        const lead = this.one(
          "SELECT assignmentId FROM task_lead_bindings WHERE taskId=?",
          command.taskId,
        );
        if (lead?.assignmentId !== command.recipientAssignmentId)
          throw Error("Contextual feedback must target the accountable lead");
      }
      if (command.reference)
        new TaskReviewStore(this.db).validateReference(
          command.taskId,
          command.reference,
        );
      const event = this.newEvent(
        command.taskId,
        command.recipientAssignmentId,
        "operator-message",
        null,
        JSON.stringify({
          message: command.message,
          ...(command.reference ? { reference: command.reference } : {}),
        }),
      );
      this.saveOperatorReceipt(
        "operator-message",
        command.key,
        payload,
        event.eventId,
      );
      this.recordRecoveryContinuation(event, command.key, payloadHash(payload));
      return event;
    });
  }

  authorizationFor(input: {
    assignmentId: string;
    interactionId: string;
    expectedRevision: number;
    action: string;
    target?: string;
    material: unknown;
  }): boolean {
    const request = z
      .object({
        assignmentId: uuid,
        interactionId: uuid,
        expectedRevision: z.number().int().positive(),
        action: z.string().trim().min(1).max(512),
        target: z.string().trim().min(1).max(2000).optional(),
        material: z.unknown(),
      })
      .strict()
      .parse(input);
    const row = this.one(
      `SELECT interaction.requestingAssignmentId,
      interaction.requestingAssignmentVersion, interaction.status,
      interaction.revision, interaction.action, interaction.target,
      interaction.materialHash, interaction.materialJson,
      assignment.version, profile.revoked
      FROM coordination_interactions interaction
      JOIN domain_assignments assignment
        ON assignment.id = interaction.requestingAssignmentId
      JOIN profiles profile ON profile.id = assignment.profileId
      WHERE interaction.interactionId = ? AND interaction.kind = 'approval'
        AND assignment.id = ?`,
      request.interactionId,
      request.assignmentId,
    );
    return Boolean(
      row &&
        row.requestingAssignmentId === request.assignmentId &&
        Number(row.requestingAssignmentVersion) === Number(row.version) &&
        row.status === "approved" &&
        Number(row.revision) === request.expectedRevision &&
        row.revoked === 0 &&
        row.action === request.action &&
        row.target === (request.target ?? null) &&
        row.materialJson === canonical(request.material) &&
        row.materialHash === payloadHash(request.material),
    );
  }

  requestFollowUp(input: CoordinationCall): CoordinationToolResponse {
    const call = followUpCallSchema.parse(input);
    return transaction(this.db, () => {
      const replay = this.cachedToolResponse(call);
      if (replay) {
        return replay;
      }
      const caller = this.currentBinding(call.threadId, call.turnId);
      if (!caller) throw new Error("Follow-up is not bound to current work");
      const result = this.required(
        `SELECT result.resultId, result.taskId,
        result.assignmentId, result.workId, result.workRevision,
        result.assignmentVersion, result.summary, result.recipientAssignmentId,
        result.destinationDisposition, assignment.requesterAssignmentId,
        assignment.projectId, assignment.version, assignment.state,
        revision.conversationRevision
        FROM coordination_results result
        JOIN domain_assignments assignment ON assignment.id = result.assignmentId
        JOIN task_work_revisions revision ON revision.workId = result.workId
        JOIN assignment_conversations conversation
          ON conversation.assignmentId = assignment.id
          AND conversation.revision = revision.conversationRevision
        WHERE result.resultId = ? AND assignment.taskId = result.taskId
          AND assignment.version = result.assignmentVersion
          AND assignment.state = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM task_work_revisions newer
            WHERE newer.assignmentId = revision.assignmentId
              AND newer.conversationRevision = revision.conversationRevision
              AND newer.workRevision > revision.workRevision
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_work_revision_ambiguities ambiguous
            WHERE ambiguous.assignmentId = revision.assignmentId
              AND ambiguous.conversationRevision = revision.conversationRevision
          )`,
        call.arguments.resultId,
      );
      if (result.destinationDisposition !== "resolved")
        throw new Error("Cannot follow up an unresolved result destination");
      const taskLead = this.one(
        "SELECT assignmentId FROM task_lead_bindings WHERE taskId = ?",
        String(result.taskId),
      );
      if (
        result.recipientAssignmentId !== caller.assignmentId &&
        taskLead?.assignmentId !== caller.assignmentId
      )
        throw new Error("Caller is not the result requester or task lead");
      const prior = this.one(
        "SELECT followUpId, requestingAssignmentId, instructions FROM coordination_follow_ups WHERE resultId = ?",
        call.arguments.resultId,
      );
      if (prior) {
        if (
          prior.requestingAssignmentId !== caller.assignmentId ||
          prior.instructions !== call.arguments.instructions
        )
          throw new Error("Result already has a different follow-up request");
        const response = {
          text: `Follow-up queued ${String(prior.followUpId)}`,
          success: true,
        };
        this.insertToolReceipt(call, caller, response);
        return response;
      }
      const nextVersion = Number(result.version) + 1;
      const updated = this.db
        .prepare(`UPDATE domain_assignments
        SET version = ?, state = 'pending'
        WHERE id = ? AND version = ? AND state = 'completed' RETURNING id`)
        .get(nextVersion, String(result.assignmentId), Number(result.version));
      if (!updated) throw new Error("Follow-up target assignment changed");
      const followUpId = randomUUID();
      this.db
        .prepare(`INSERT INTO coordination_follow_ups
        (followUpId, resultId, taskId, requestingAssignmentId, targetAssignmentId,
          priorWorkId, priorWorkRevision, priorAssignmentVersion,
          nextAssignmentVersion, instructions, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(
          followUpId,
          call.arguments.resultId,
          String(result.taskId),
          String(caller.assignmentId),
          String(result.assignmentId),
          String(result.workId),
          Number(result.workRevision),
          Number(result.assignmentVersion),
          nextVersion,
          call.arguments.instructions,
        );
      this.newEvent(
        String(result.taskId),
        String(result.assignmentId),
        "assignment-follow-up",
        null,
        JSON.stringify({
          followUpId,
          resultId: result.resultId,
          workId: result.workId,
          workRevision: result.workRevision,
          assignmentVersion: nextVersion,
          instructions: call.arguments.instructions,
        }),
      );
      const response = {
        text: `Follow-up queued ${followUpId}`,
        success: true,
      };
      this.insertToolReceipt(call, caller, response);
      return response;
    });
  }

  followUps(taskId?: string): FollowUpRequest[] {
    const sql =
      "SELECT followUpId, resultId, taskId, requestingAssignmentId, " +
      "targetAssignmentId, priorWorkId, priorWorkRevision, priorAssignmentVersion, " +
      "nextAssignmentVersion, instructions, revision, createdAt " +
      "FROM coordination_follow_ups" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY createdAt, followUpId";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseFollowUp(row));
  }

  requestTaskCompletion(input: CoordinationCall): CoordinationToolResponse {
    const call = completionCallSchema.parse(input);
    return transaction(this.db, () => {
      const replay = this.cachedToolResponse(call);
      if (replay) {
        return replay;
      }
      const lead = this.currentBinding(call.threadId, call.turnId);
      if (!lead)
        throw new Error("Completion request is not bound to current work");
      const leadBinding = this.one(
        "SELECT assignmentId FROM task_lead_bindings WHERE taskId = ?",
        String(lead.taskId),
      );
      if (leadBinding?.assignmentId !== lead.assignmentId)
        throw new Error("Only the task lead may request completion");
      const deliveryReasons = new DeliveryStore(this.db).completionBlockers(
        String(lead.taskId),
        Number(lead.taskVersion),
      );
      if (deliveryReasons.length)
        throw new Error(`Completion held: ${deliveryReasons.join(", ")}`);
      const reviewed = [...new Set(call.arguments.reviewedResultIds)].sort();
      for (const resultId of reviewed) {
        const result = this.required(
          "SELECT taskId, destinationDisposition FROM coordination_results WHERE resultId = ?",
          resultId,
        );
        if (
          result.taskId !== lead.taskId ||
          result.destinationDisposition !== "resolved"
        )
          throw new Error(
            "Reviewed results must be current and delivered in this task",
          );
      }
      const prior = this.one(
        "SELECT requestId, reviewedResultIds FROM coordination_completion_requests WHERE leadWorkId = ?",
        String(lead.workId),
      );
      if (prior) {
        if (prior.reviewedResultIds !== JSON.stringify(reviewed))
          throw new Error(
            "Lead work already requested a different completion review",
          );
        const response = {
          text: `Completion requested ${String(prior.requestId)}`,
          success: true,
        };
        this.insertToolReceipt(call, lead, response);
        return response;
      }
      const requestId = randomUUID();
      this.db
        .prepare(`INSERT INTO coordination_completion_requests
        (requestId, taskId, leadAssignmentId, leadWorkId, leadWorkRevision,
          taskVersion, reviewedResultIds, status, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1)`)
        .run(
          requestId,
          String(lead.taskId),
          String(lead.assignmentId),
          String(lead.workId),
          Number(lead.workRevision),
          Number(lead.taskVersion),
          JSON.stringify(reviewed),
        );
      const response = {
        text: `Completion requested ${requestId}`,
        success: true,
      };
      this.insertToolReceipt(call, lead, response);
      return response;
    });
  }

  completionRequests(taskId?: string): TaskCompletionRequest[] {
    const sql =
      "SELECT requestId, taskId, leadAssignmentId, leadWorkId, " +
      "leadWorkRevision, taskVersion, reviewedResultIds, status, revision, " +
      "rejectionReasons, createdAt, finalizedAt FROM coordination_completion_requests" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY createdAt, requestId";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseCompletionRequest(row));
  }

  reportingRepairs(taskId?: string): ReportingRepair[] {
    const sql =
      `SELECT taskId, assignmentId, assignmentVersion, missedWorkId,
      repairWorkId, attempts, state, reason FROM coordination_reporting_repairs` +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY updatedAt, assignmentId";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => ({
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      assignmentVersion: Number(row.assignmentVersion),
      missedWorkId: String(row.missedWorkId),
      repairWorkId: String(row.repairWorkId),
      attempts: Number(row.attempts),
      state: z.enum(["queued", "held", "resolved"]).parse(row.state),
      reason: row.reason === null ? null : String(row.reason),
    }));
  }

  completedWorkNeedingDisposition(): string[] {
    return (
      this.db
        .prepare(`SELECT binding.workId
      FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
        AND conversation.revision = binding.conversationRevision
      JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
      WHERE intent.state = 'completed'
        AND assignment.state = 'running'
        AND assignment.version = binding.assignmentVersion
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = revision.assignmentId
            AND newer.conversationRevision = revision.conversationRevision
            AND newer.workRevision > revision.workRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = binding.assignmentId
            AND ambiguous.conversationRevision = binding.conversationRevision
        )
      ORDER BY revision.workRevision`)
        .all() as Array<{ workId: string }>
    ).map((row) => row.workId);
  }

  recordSuccessfulTerminal(workId: string): ReportingRepair | undefined {
    const work = z.string().min(1).max(512).parse(workId);
    return transaction(this.db, () => {
      const binding = this.one(
        `SELECT binding.taskId, binding.assignmentId,
        binding.assignmentVersion, binding.conversationRevision,
        revision.workRevision, intent.state, assignment.version,
        conversation.revision AS currentConversationRevision
        FROM task_execution_bindings binding
        JOIN task_work_revisions revision ON revision.workId = binding.workId
        JOIN execution_intents intent ON intent.workId = binding.workId
        JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
        JOIN assignment_conversations conversation
          ON conversation.assignmentId = binding.assignmentId
        WHERE binding.workId = ?`,
        work,
      );
      if (
        binding?.state !== "completed" ||
        Number(binding.assignmentVersion) !== Number(binding.version) ||
        Number(binding.conversationRevision) !==
          Number(binding.currentConversationRevision) ||
        this.one(
          `SELECT 1 AS newer FROM task_work_revisions
          WHERE assignmentId = ? AND conversationRevision = ?
            AND workRevision > ? LIMIT 1`,
          String(binding.assignmentId),
          Number(binding.conversationRevision),
          Number(binding.workRevision),
        )
      ) {
        return undefined;
      }

      const assignmentId = String(binding.assignmentId);
      const assignmentVersion = Number(binding.assignmentVersion);
      const hasResult = Boolean(
        this.one(
          "SELECT 1 AS found FROM coordination_results WHERE workId = ?",
          work,
        ) ||
          this.one(
            "SELECT 1 AS found FROM task_execution_results WHERE workId = ?",
            work,
          ),
      );
      const finalizedCompletionRequest = this.one(
        `SELECT 1 AS found FROM coordination_completion_requests
        WHERE leadWorkId = ? AND status = 'finalized' LIMIT 1`,
        work,
      );
      if (
        hasResult ||
        finalizedCompletionRequest ||
        this.hasDurableWaitingAction(work, assignmentId)
      ) {
        const completionRequest = this.one(
          `SELECT status FROM coordination_completion_requests
          WHERE leadWorkId = ? AND status IN ('pending', 'finalized') LIMIT 1`,
          work,
        );
        if (!completionRequest) {
          const settledEffect = this.db
            .prepare(`UPDATE execution_pending_effects
            SET state = 'settled',
              reason = 'Successful terminal has a durable result or waiting action'
            WHERE workId = ? AND effectKey = 'assignment-result' AND state = 'pending'
              AND EXISTS (
                SELECT 1 FROM task_execution_bindings exact
                WHERE exact.workId = ? AND exact.assignmentId = ?
                  AND exact.taskId = ?
              )
            RETURNING workId`)
            .get(work, work, assignmentId, String(binding.taskId)) as
            | Row
            | undefined;
          if (settledEffect && String(settledEffect.workId) !== work)
            throw new Error(
              "Successful terminal settled a different work effect",
            );
        }
        this.db
          .prepare(`UPDATE coordination_reporting_repairs
          SET state = 'resolved', reason = NULL, updatedAt = unixepoch()
          WHERE assignmentId = ? AND assignmentVersion = ? AND state = 'queued'`)
          .run(assignmentId, assignmentVersion);
        return undefined;
      }

      const prior = this.one(
        `SELECT taskId, assignmentId, assignmentVersion,
        missedWorkId, repairWorkId, attempts, state, reason
        FROM coordination_reporting_repairs
        WHERE assignmentId = ? AND assignmentVersion = ?`,
        assignmentId,
        assignmentVersion,
      );
      if (!prior) {
        const taskId = String(binding.taskId);
        const repairWorkId = `assignment:${assignmentId}:v${assignmentVersion}:repair:${Number(binding.workRevision)}`;
        this.db
          .prepare(`INSERT INTO coordination_reporting_repairs
          (assignmentId, assignmentVersion, taskId, missedWorkId, repairWorkId,
            attempts, state)
          VALUES (?, ?, ?, ?, ?, 1, 'queued')`)
          .run(assignmentId, assignmentVersion, taskId, work, repairWorkId);
        const result = this.one(
          `SELECT taskId, assignmentId, assignmentVersion,
          missedWorkId, repairWorkId, attempts, state, reason
          FROM coordination_reporting_repairs WHERE assignmentId = ? AND assignmentVersion = ?`,
          assignmentId,
          assignmentVersion,
        );
        return result ? this.parseReportingRepair(result) : undefined;
      }

      const repair = this.parseReportingRepair(prior);
      if (repair.state === "queued" && repair.repairWorkId === work) {
        const reason =
          "Assignment ended without a durable result or waiting action after one reporting repair";
        this.db
          .prepare(`UPDATE coordination_reporting_repairs
          SET attempts = 2, state = 'held', reason = ?, updatedAt = unixepoch()
          WHERE assignmentId = ? AND assignmentVersion = ? AND state = 'queued'`)
          .run(reason, assignmentId, assignmentVersion);
        this.db
          .prepare(`UPDATE domain_assignments SET state = 'held'
          WHERE id = ? AND version = ? AND state IN ('pending','running')`)
          .run(assignmentId, assignmentVersion);
      }
      const result = this.one(
        `SELECT taskId, assignmentId, assignmentVersion,
        missedWorkId, repairWorkId, attempts, state, reason
        FROM coordination_reporting_repairs WHERE assignmentId = ? AND assignmentVersion = ?`,
        assignmentId,
        assignmentVersion,
      );
      return result ? this.parseReportingRepair(result) : undefined;
    });
  }

  finalizeTaskCompletion(input: {
    requestId: string;
    workId: string;
    terminal: "completed" | "failed";
    deliveryValidation?: () => string[];
  }): {
    completed: boolean;
    reasons: string[];
    request: TaskCompletionRequest;
  } {
    const { deliveryValidation, ...material } = input;
    const command = completionFinalizeSchema.parse(material);
    return transaction(this.db, () => {
      const raw = this.required(
        `SELECT requestId, taskId, leadAssignmentId,
        leadWorkId, leadWorkRevision, taskVersion, reviewedResultIds,
        status, rejectionReasons, revision, createdAt, finalizedAt
        FROM coordination_completion_requests WHERE requestId = ?`,
        command.requestId,
      );
      const request = this.parseCompletionRequest(raw);
      if (request.leadWorkId !== command.workId)
        throw new Error("Completion terminal work does not match the request");
      if (request.status === "finalized") {
        return { completed: true, reasons: [], request };
      }
      if (request.status === "rejected") {
        return {
          completed: false,
          reasons: request.rejectionReasons,
          request,
        };
      }
      const reasons = [
        ...this.completionBlockers(request, command.terminal),
        ...new DeliveryStore(this.db).completionBlockers(
          request.taskId,
          request.taskVersion,
        ),
        ...(deliveryValidation?.() ??
          (new DeliveryStore(this.db).delivery(request.taskId)
            ? ["delivery-fresh-inspection-required"]
            : [])),
      ];
      if (reasons.length > 0) {
        const rejectionReasons = [...new Set(reasons)].slice(0, 32);
        const rejectedRow = this.db
          .prepare(`UPDATE coordination_completion_requests
          SET status = 'rejected', rejectionReasons = ?, revision = revision + 1
          WHERE requestId = ? AND status = 'pending' AND revision = ?
          RETURNING requestId, taskId, leadAssignmentId, leadWorkId,
            leadWorkRevision, taskVersion, reviewedResultIds, status,
            rejectionReasons, revision, createdAt, finalizedAt`)
          .get(
            JSON.stringify(rejectionReasons),
            request.requestId,
            request.revision,
          ) as Row | undefined;
        if (!rejectedRow)
          throw new Error("Completion request changed during rejection");
        if (
          command.terminal === "completed" &&
          !rejectionReasons.includes("lead-result-effect-missing")
        ) {
          const rejectionReason =
            `Completion rejected: ${rejectionReasons.join(", ")}`.slice(0, 512);
          const settledLeadEffect = this.db
            .prepare(`UPDATE execution_pending_effects
            SET state = 'settled', reason = ?
            WHERE workId = ? AND effectKey = 'assignment-result' AND state = 'pending'
              AND EXISTS (
                SELECT 1 FROM task_execution_bindings exact
                WHERE exact.workId = ? AND exact.taskId = ?
                  AND exact.assignmentId = ?
              )
            RETURNING workId`)
            .get(
              rejectionReason,
              request.leadWorkId,
              request.leadWorkId,
              request.taskId,
              request.leadAssignmentId,
            ) as Row | undefined;
          if (
            !settledLeadEffect ||
            String(settledLeadEffect.workId) !== request.leadWorkId
          )
            throw new Error(
              "Rejected lead result effect changed during finalization",
            );
        }
        const rejected = this.parseCompletionRequest(rejectedRow);
        return {
          completed: false,
          reasons: rejected.rejectionReasons,
          request: rejected,
        };
      }
      const settledLeadEffect = this.db
        .prepare(`UPDATE execution_pending_effects
        SET state = 'settled', reason = NULL
        WHERE workId = ? AND effectKey = 'assignment-result' AND state = 'pending'
          AND EXISTS (
            SELECT 1 FROM task_execution_bindings exact
            WHERE exact.workId = ? AND exact.taskId = ?
              AND exact.assignmentId = ?
          )
        RETURNING workId`)
        .get(
          request.leadWorkId,
          request.leadWorkId,
          request.taskId,
          request.leadAssignmentId,
        ) as Row | undefined;
      if (
        !settledLeadEffect ||
        String(settledLeadEffect.workId) !== request.leadWorkId
      )
        throw new Error(
          "Lead completion result effect changed during finalization",
        );
      const leadBinding = this.one(
        `SELECT binding.assignmentVersion
        FROM task_execution_bindings binding
        JOIN task_work_revisions revision ON revision.workId = binding.workId
        WHERE binding.workId = ? AND binding.taskId = ?
          AND binding.assignmentId = ? AND revision.workRevision = ?`,
        request.leadWorkId,
        request.taskId,
        request.leadAssignmentId,
        request.leadWorkRevision,
      );
      if (!leadBinding)
        throw new Error("Lead work binding changed during completion");
      const completedLead = this.db
        .prepare(`UPDATE domain_assignments SET state = 'completed'
        WHERE id = ? AND taskId = ? AND version = ? AND state = 'running'
        RETURNING id`)
        .get(
          request.leadAssignmentId,
          request.taskId,
          Number(leadBinding.assignmentVersion),
        ) as Row | undefined;
      if (!completedLead)
        throw new Error("Lead assignment changed during completion");
      const completedTask = this.db
        .prepare(`UPDATE domain_tasks SET state = 'done', version = version + 1
        WHERE id = ? AND version = ? AND state = 'open' RETURNING id`)
        .get(request.taskId, request.taskVersion) as Row | undefined;
      if (!completedTask) throw new Error("Task changed during completion");
      const finalizedRow = this.db
        .prepare(`UPDATE coordination_completion_requests
        SET status = 'finalized', rejectionReasons = '[]', revision = revision + 1,
          finalizedAt = unixepoch()
        WHERE requestId = ? AND status = 'pending' AND revision = ?
        RETURNING requestId, taskId, leadAssignmentId, leadWorkId,
          leadWorkRevision, taskVersion, reviewedResultIds, status,
          rejectionReasons, revision, createdAt, finalizedAt`)
        .get(request.requestId, request.revision) as Row | undefined;
      if (!finalizedRow)
        throw new Error("Completion request changed during finalization");
      const finalized = this.parseCompletionRequest(finalizedRow);
      return { completed: true, reasons: [], request: finalized };
    });
  }

  reconcileResultRecipient(input: {
    actor: "operator";
    key: string;
    resultId: string;
    expectedRevision: number;
    recipientAssignmentId: string;
  }): InboxEvent {
    const command = reconcileSchema.parse(input);
    const payload = {
      resultId: command.resultId,
      expectedRevision: command.expectedRevision,
      recipientAssignmentId: command.recipientAssignmentId,
    };
    return transaction(this.db, () => {
      const replay = this.replayOperatorEvent(
        "reconcile-result-recipient",
        command.key,
        payload,
      );
      if (replay) {
        return replay;
      }
      const hold = this.required(
        "SELECT resultId, taskId, assignmentId, revision, status FROM coordination_unresolved_result_destinations WHERE resultId = ?",
        command.resultId,
      );
      if (hold.status !== "unresolved")
        throw new Error("Result destination is already reconciled");
      if (Number(hold.revision) !== command.expectedRevision)
        throw new Error("Result destination revision conflict");
      const result = this.resultById(command.resultId);
      if (
        !this.permittedRecipient(
          result.taskId,
          result.assignmentId,
          command.recipientAssignmentId,
          command.recipientAssignmentId,
        )
      )
        throw new Error("Recipient is not permitted by the assignment");
      this.insertResultEvent(result, command.recipientAssignmentId);
      this.db
        .prepare(`UPDATE coordination_unresolved_result_destinations
        SET status = 'resolved', resolvedRecipientAssignmentId = ?,
          resolvedAt = unixepoch(), revision = revision + 1
        WHERE resultId = ? AND revision = ? AND status = 'unresolved'`)
        .run(
          command.recipientAssignmentId,
          command.resultId,
          command.expectedRevision,
        );
      this.db
        .prepare(`UPDATE coordination_results
        SET recipientAssignmentId = ?, destinationDisposition = 'resolved'
        WHERE resultId = ?`)
        .run(command.recipientAssignmentId, command.resultId);
      const event = this.one(
        "SELECT sequence, eventId, taskId, recipientAssignmentId, eventType, resultId, interactionId, payload, createdAt FROM coordination_inbox_events WHERE resultId = ?",
        command.resultId,
      );
      if (!event) throw new Error("Reconciled inbox event was not committed");
      this.saveOperatorReceipt(
        "reconcile-result-recipient",
        command.key,
        payload,
        String(event.eventId),
      );
      return this.parseEvent(event);
    });
  }

  results(taskId?: string): AssignmentResult[] {
    const sql =
      "SELECT resultId, taskId, assignmentId, workId, workRevision, " +
      "assignmentVersion, summary, recipientAssignmentId, destinationDisposition, createdAt " +
      "FROM coordination_results" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY createdAt, rowid";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => this.parseResult(row));
  }

  unresolvedResultDestinations(taskId?: string): UnresolvedResultDestination[] {
    const sql =
      "SELECT resultId, taskId, assignmentId, originalDestination, reason, revision " +
      "FROM coordination_unresolved_result_destinations WHERE status = 'unresolved'" +
      (taskId ? " AND taskId = ?" : "") +
      " ORDER BY rowid";
    const rows = (
      taskId
        ? this.db.prepare(sql).all(uuid.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((row) => ({
      resultId: String(row.resultId),
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      originalDestination:
        row.originalDestination === null
          ? null
          : String(row.originalDestination),
      reason: String(row.reason),
      revision: Number(row.revision),
    }));
  }

  inboxEvents(recipientAssignmentId: string): InboxEvent[] {
    return this.db
      .prepare(
        "SELECT sequence, eventId, taskId, recipientAssignmentId, eventType, resultId, interactionId, payload, createdAt " +
          "FROM coordination_inbox_events WHERE recipientAssignmentId = ? ORDER BY sequence",
      )
      .all(uuid.parse(recipientAssignmentId))
      .map((row) => this.parseEvent(row as Row));
  }

  ensureRoutingFallbackEvent(input: RoutingFallbackAttention): InboxEvent {
    const command = routingFallbackAttentionSchema.parse(input);
    const payload = JSON.stringify({
      routingOperationId: command.routingOperationId,
      brief: command.brief,
      reason: command.reason,
      evidence: command.evidence,
    });
    return transaction(this.db, () => {
      const existing = this.one(
        "SELECT sequence, eventId, taskId, recipientAssignmentId, eventType, resultId, interactionId, payload, createdAt FROM coordination_inbox_events WHERE routingOperationId = ?",
        command.routingOperationId,
      );
      if (existing) {
        if (
          existing.taskId !== command.taskId ||
          existing.recipientAssignmentId !== command.recipientAssignmentId ||
          existing.eventType !== "routing-fallback" ||
          existing.payload !== payload
        )
          throw new Error("Routing fallback event conflict");
        const event = this.parseEvent(existing);
        return event;
      }
      const event = this.newEvent(
        command.taskId,
        command.recipientAssignmentId,
        "routing-fallback",
        null,
        payload,
        null,
        command.routingOperationId,
      );
      return event;
    });
  }

  ensureSourceHoldEvent(input: {
    nodeId: string;
    generation: number;
    taskId: string;
    recipientAssignmentId: string;
    reason: string;
  }): InboxEvent {
    const recipient = uuid.parse(input.recipientAssignmentId);
    const taskId = uuid.parse(input.taskId);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1)
      throw new Error("Invalid source hold generation");
    const payload = JSON.stringify({
      reason: input.reason,
      disposition: "safe-stop-new-work",
    });
    return transaction(this.db, () => {
      const existing = this.one(
        `SELECT event.sequence, event.eventId, event.taskId, event.recipientAssignmentId,
        event.eventType, event.resultId, event.interactionId, event.payload, event.createdAt
        FROM coordination_source_hold_notices notice JOIN coordination_inbox_events event ON event.eventId = notice.eventId
        WHERE notice.nodeId = ? AND notice.generation = ? AND notice.recipientAssignmentId = ?`,
        input.nodeId,
        input.generation,
        recipient,
      );
      if (existing) {
        if (
          existing.taskId !== taskId ||
          existing.eventType !== "source-hold" ||
          existing.payload !== payload
        )
          throw new Error("Source hold notice conflict");
        return this.parseEvent(existing);
      }
      const event = this.newEvent(
        taskId,
        recipient,
        "source-hold",
        null,
        payload,
      );
      this.db
        .prepare(
          "INSERT INTO coordination_source_hold_notices (nodeId, generation, recipientAssignmentId, eventId) VALUES (?, ?, ?, ?)",
        )
        .run(input.nodeId, input.generation, recipient, event.eventId);
      return event;
    });
  }

  pendingEvents(recipientAssignmentId: string): InboxEvent[] {
    return this.db
      .prepare(`SELECT event.sequence, event.eventId, event.taskId,
      event.recipientAssignmentId, event.eventType, event.resultId, event.interactionId,
      event.payload, event.createdAt
      FROM coordination_inbox_events event
      LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
      WHERE event.recipientAssignmentId = ? AND delivery.eventId IS NULL
      ORDER BY event.sequence`)
      .all(uuid.parse(recipientAssignmentId))
      .map((row) => this.parseEvent(row as Row));
  }

  pendingEventRecipients(): string[] {
    return (
      this.db
        .prepare(`SELECT event.recipientAssignmentId
      FROM coordination_inbox_events event
      LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
      WHERE delivery.eventId IS NULL
      GROUP BY event.recipientAssignmentId
      ORDER BY MIN(event.sequence)`)
        .all() as Array<{
        recipientAssignmentId: string;
      }>
    ).map((row) => uuid.parse(row.recipientAssignmentId));
  }

  queuedDeliveries(): InboxDelivery[] {
    const rows = this.db
      .prepare(`SELECT batchId FROM coordination_delivery_batches
      WHERE state = 'queued' ORDER BY createdAt, batchId`)
      .all() as Array<{
      batchId: string;
    }>;
    return rows.map((row) => this.delivery(row.batchId));
  }

  deliveryForWork(deliveryWorkId: string): InboxDelivery | undefined {
    const row = this.one(
      "SELECT batchId FROM coordination_delivery_batches WHERE deliveryWorkId = ?",
      z.string().min(1).max(512).parse(deliveryWorkId),
    );
    return row ? this.delivery(String(row.batchId)) : undefined;
  }

  hasDurableWaitingAction(workId: string, assignmentId: string): boolean {
    const work = z.string().min(1).max(512).parse(workId);
    const assignment = uuid.parse(assignmentId);
    return Boolean(
      new DeliveryStore(this.db).hasWaitingPr(work) ||
        this.one(
          "SELECT 1 AS found FROM coordination_results WHERE workId = ?",
          work,
        ) ||
        this.one(
          `SELECT 1 AS found FROM coordination_interactions
        WHERE requestingWorkId = ? AND status = 'open' LIMIT 1`,
          work,
        ) ||
        this.one(
          `SELECT 1 AS found FROM coordination_completion_requests
        WHERE leadWorkId = ? AND status = 'pending' LIMIT 1`,
          work,
        ) ||
        this.one(
          `SELECT 1 AS found FROM coordination_receipts
        WHERE workId = ? AND tool IN
          ('ensemble_delegate','ensemble_request_follow_up') LIMIT 1`,
          work,
        ) ||
        this.one(
          `SELECT 1 AS found FROM coordination_inbox_events event
        LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
        WHERE event.recipientAssignmentId = ? AND delivery.eventId IS NULL LIMIT 1`,
          assignment,
        ) ||
        this.one(
          `SELECT 1 AS found FROM coordination_delivery_batches
        WHERE recipientAssignmentId = ? AND state IN ('queued', 'held') LIMIT 1`,
          assignment,
        ),
    );
  }

  bindDeliveryBatch(
    recipientAssignmentId: string,
    deliveryWorkId: string,
    assignmentVersion?: number,
  ): InboxDelivery | undefined {
    const recipient = uuid.parse(recipientAssignmentId);
    const workId = z.string().min(1).max(512).parse(deliveryWorkId);
    const requestedVersion =
      assignmentVersion === undefined
        ? undefined
        : z.number().int().positive().parse(assignmentVersion);
    return transaction(this.db, () => {
      const sameWork = this.one(
        "SELECT batchId, recipientAssignmentId, state FROM coordination_delivery_batches WHERE deliveryWorkId = ?",
        workId,
      );
      if (sameWork) {
        if (sameWork.recipientAssignmentId !== recipient)
          throw new Error(
            "Delivery work identity reused for another recipient",
          );
        const batch = this.delivery(String(sameWork.batchId));
        const recipientState = this.required(
          "SELECT state FROM domain_assignments WHERE id = ?",
          recipient,
        ).state;
        if (
          requestedVersion !== undefined &&
          batch.assignmentVersion !== requestedVersion
        )
          throw new Error(
            "Delivery work identity reused for another assignment version",
          );
        if (
          sameWork.state !== "completed" &&
          recipientState !== "pending" &&
          recipientState !== "running"
        ) {
          return undefined;
        }
        return batch;
      }
      const recipientState = this.required(
        "SELECT state FROM domain_assignments WHERE id = ?",
        recipient,
      ).state;
      if (recipientState !== "pending" && recipientState !== "running") {
        return undefined;
      }
      const active = this.one(
        "SELECT batchId FROM coordination_delivery_batches WHERE recipientAssignmentId = ? AND state = 'queued'",
        recipient,
      );
      if (active) {
        const batch = this.delivery(String(active.batchId));
        return batch;
      }
      const pending = this.db
        .prepare(`SELECT event.sequence, event.eventId, event.taskId,
        event.recipientAssignmentId, event.eventType, event.resultId, event.interactionId,
        event.payload, event.createdAt
        FROM coordination_inbox_events event
        LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
        WHERE event.recipientAssignmentId = ? AND delivery.eventId IS NULL
        ORDER BY event.sequence`)
        .all(recipient) as Row[];
      if (pending.length === 0) {
        return undefined;
      }
      const taskId = String(pending[0]?.taskId);
      const storedVersion = Number(
        this.required(
          "SELECT version FROM domain_assignments WHERE id = ?",
          recipient,
        ).version,
      );
      const boundVersion = requestedVersion ?? storedVersion;
      if (storedVersion !== boundVersion)
        throw new Error("Delivery assignment version changed before binding");
      const highWater = Math.max(...pending.map((row) => Number(row.sequence)));
      const batchId = randomUUID();
      this.db
        .prepare(`INSERT INTO coordination_delivery_batches
        (batchId, deliveryWorkId, taskId, recipientAssignmentId, assignmentVersion,
          highWaterSequence, state)
        VALUES (?, ?, ?, ?, ?, ?, 'queued')`)
        .run(batchId, workId, taskId, recipient, boundVersion, highWater);
      pending.forEach((event, index) => {
        this.db
          .prepare(
            "INSERT INTO coordination_delivery_events (eventId, batchId, ordinal) VALUES (?, ?, ?)",
          )
          .run(String(event.eventId), batchId, index + 1);
      });
      const batch = this.delivery(batchId);
      return batch;
    });
  }

  completeDeliveryBatch(deliveryWorkId: string): InboxDelivery {
    const workId = z.string().min(1).max(512).parse(deliveryWorkId);
    return transaction(this.db, () => {
      const row = this.required(
        "SELECT batchId, state FROM coordination_delivery_batches WHERE deliveryWorkId = ?",
        workId,
      );
      if (row.state === "queued")
        this.db
          .prepare(
            "UPDATE coordination_delivery_batches SET state = 'completed', completedAt = unixepoch() WHERE batchId = ? AND state = 'queued'",
          )
          .run(String(row.batchId));
      const result = this.delivery(String(row.batchId));
      return result;
    });
  }

  /** Historical exceptions never bypass the current generation's independent gates. */
  isHistoricalWorkResolved(workId: string): boolean {
    return Boolean(
      this.isNeverAdmittedRefusedAssignmentWork?.(workId) ||
        this.hasRecoveryContinuation(workId) ||
        (this.one(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_request_supersessions'",
        ) &&
          this.one(
            `WITH RECURSIVE successor(newWorkId,batchId,sourceId,sourceDigest) AS (
            SELECT s.newWorkId,s.batchId,s.sourceId,s.sourceDigest
            FROM inbox_request_supersessions s JOIN execution_intents i ON i.workId=s.oldWorkId
            WHERE s.oldWorkId=? AND i.state='reconciled' AND i.threadId IS NULL AND i.turnId IS NULL
            UNION
            SELECT s.newWorkId,s.batchId,s.sourceId,s.sourceDigest
            FROM successor prior JOIN inbox_request_supersessions s ON s.oldWorkId=prior.newWorkId
            JOIN execution_intents i ON i.workId=s.oldWorkId
            WHERE s.batchId=prior.batchId AND s.sourceId=prior.sourceId AND s.sourceDigest=prior.sourceDigest
              AND i.state='reconciled' AND i.threadId IS NULL AND i.turnId IS NULL
          ) SELECT 1 FROM successor
          JOIN turn_requests request ON request.workId=successor.newWorkId
          JOIN coordination_delivery_batches batch ON batch.batchId=successor.batchId
          WHERE batch.deliveryWorkId=request.workId AND batch.taskId=request.taskId
            AND batch.recipientAssignmentId=request.assignmentId LIMIT 1`,
            workId,
          )),
    );
  }

  hasRecoveryContinuation(workId: string): boolean {
    const audit = this.one(
      "SELECT * FROM coordination_recovery_continuations WHERE workId = ?",
      workId,
    );
    if (!audit) return false;
    const proof = this.reconciledAssignmentProof?.(workId);
    if (
      !proof ||
      proof.receiptId !== audit.receiptId ||
      proof.taskId !== audit.taskId ||
      proof.assignmentId !== audit.assignmentId ||
      proof.material !== audit.proofMaterial
    )
      return false;
    const event = this.one(
      `SELECT taskId, recipientAssignmentId, eventType, payload
      FROM coordination_inbox_events WHERE eventId = ?`,
      String(audit.operatorEventId),
    );
    const receipt = this.one(
      `SELECT payloadHash, result FROM coordination_operator_receipts
      WHERE scope = 'operator-message' AND commandKey = ?`,
      String(audit.operatorCommandKey),
    );
    if (
      !event ||
      !receipt ||
      event.eventType !== "operator-message" ||
      event.taskId !== proof.taskId ||
      event.recipientAssignmentId !== proof.assignmentId ||
      event.payload !== audit.operatorEventPayload ||
      receipt.payloadHash !== audit.operatorPayloadHash ||
      receipt.result !== JSON.stringify({ eventId: audit.operatorEventId })
    )
      return false;
    const batch = this.deliveryForWork(workId);
    if (audit.batchId === null) return batch === undefined;
    return Boolean(
      batch &&
        batch.state === "completed" &&
        batch.batchId === audit.batchId &&
        this.recoveryBatchMaterial(batch) === audit.batchMaterial,
    );
  }

  /** Delivery processing by an operator never claims a successful runtime turn. */
  recoveryDispositionForEvent(
    eventId: string,
  ): "operator-reconciled" | undefined {
    return this.one(
      `SELECT 1 AS reconciled FROM coordination_delivery_events event
      JOIN coordination_recovery_continuations audit ON audit.batchId = event.batchId
      WHERE event.eventId = ?`,
      eventId,
    )
      ? "operator-reconciled"
      : undefined;
  }

  recoveryDispositionForWork(
    workId: string,
  ): "operator-reconciled" | undefined {
    return this.one(
      "SELECT 1 AS reconciled FROM coordination_recovery_continuations WHERE workId = ?",
      workId,
    )
      ? "operator-reconciled"
      : undefined;
  }

  private recoveryBatchMaterial(batch: InboxDelivery): string {
    const { state: _state, ...material } = batch;
    return JSON.stringify(material);
  }

  private recordRecoveryContinuation(
    event: InboxEvent,
    commandKey: string,
    commandHash: string,
  ): void {
    if (!this.reconciledAssignmentProof) return;
    const requests = this.db
      .prepare(`SELECT workId FROM turn_requests
      WHERE taskId = ? AND assignmentId = ? AND state = 'held' ORDER BY sequence`)
      .all(event.taskId, event.recipientAssignmentId) as Array<{
      workId: string;
    }>;
    for (const { workId } of requests) {
      if (
        this.one(
          "SELECT 1 AS recorded FROM coordination_recovery_continuations WHERE workId = ?",
          workId,
        )
      )
        continue;
      const proof = this.reconciledAssignmentProof(workId);
      if (
        !proof ||
        proof.taskId !== event.taskId ||
        proof.assignmentId !== event.recipientAssignmentId
      )
        continue;
      const batch = this.deliveryForWork(workId);
      if (
        batch &&
        (batch.state !== "queued" ||
          batch.taskId !== proof.taskId ||
          batch.recipientAssignmentId !== proof.assignmentId ||
          batch.assignmentVersion !== proof.assignmentVersion)
      )
        continue;
      this.db
        .prepare(`INSERT INTO coordination_recovery_continuations
        (workId, receiptId, taskId, assignmentId, proofMaterial, operatorCommandKey, operatorPayloadHash,
          operatorEventId, operatorEventPayload, batchId, batchMaterial)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          workId,
          proof.receiptId,
          proof.taskId,
          proof.assignmentId,
          proof.material,
          commandKey,
          commandHash,
          event.eventId,
          event.payload,
          batch?.batchId ?? null,
          batch ? this.recoveryBatchMaterial(batch) : null,
        );
      if (batch)
        this.db
          .prepare(`UPDATE coordination_delivery_batches SET state = 'completed',
        completedAt = unixepoch() WHERE batchId = ? AND state = 'queued'`)
          .run(batch.batchId);
    }
  }

  /** Withdraw only a queued inbox batch whose exact request was safely refused
   * before admission and whose assignment has since been explicitly applied
   * to the current project/profile instruction revisions. */
  withdrawStaleRefusedDelivery(deliveryWorkId: string): boolean {
    const workId = z.string().min(1).max(512).parse(deliveryWorkId);
    return transaction(this.db, () => {
      const batch = this.one(
        `SELECT batch.batchId, batch.taskId, batch.recipientAssignmentId,
          batch.assignmentVersion, batch.highWaterSequence, batch.state,
          request.kind, request.taskId AS requestTaskId,
          request.projectId AS requestProjectId,
          request.assignmentId AS requestAssignmentId,
          request.taskVersion AS requestTaskVersion,
          request.assignmentVersion AS requestAssignmentVersion,
          request.state AS requestState,
          task.version AS taskVersion, task.state AS taskState,
          assignment.projectId, assignment.profileId,
          assignment.version AS currentAssignmentVersion,
          assignment.instructionsRevision,
          assignment.profileRevision,
          assignment.state AS assignmentState,
          project.instructionsRevision AS currentInstructionsRevision,
          project.leadProfileId, profile.version AS currentProfileRevision,
          profile.revoked, routing.candidateProfileIds
        FROM coordination_delivery_batches batch
        JOIN turn_requests request ON request.workId = batch.deliveryWorkId
        JOIN domain_tasks task ON task.id = batch.taskId
          JOIN domain_assignments assignment
          ON assignment.id = batch.recipientAssignmentId
            AND assignment.taskId = batch.taskId
        JOIN domain_projects project ON project.id = assignment.projectId
          AND task.projectId = project.id
        JOIN profiles profile ON profile.id = assignment.profileId
        JOIN project_routing routing ON routing.projectId = assignment.projectId
        WHERE batch.deliveryWorkId = ?`,
        workId,
      ) as
        | {
            batchId: string;
            taskId: string;
            recipientAssignmentId: string;
            assignmentVersion: number;
            highWaterSequence: number;
            state: string;
            kind: string;
            requestTaskId: string;
            requestProjectId: string;
            requestAssignmentId: string;
            requestTaskVersion: number;
            requestAssignmentVersion: number;
            requestState: string;
            taskVersion: number;
            taskState: string;
            projectId: string;
            profileId: string;
            currentAssignmentVersion: number;
            instructionsRevision: number;
            profileRevision: number;
            assignmentState: string;
            currentInstructionsRevision: number;
            leadProfileId: string | null;
            currentProfileRevision: number;
            revoked: number;
            candidateProfileIds: string;
          }
        | undefined;
      if (
        batch?.state !== "queued" ||
        batch.kind !== "assignment" ||
        batch.taskId !== batch.requestTaskId ||
        batch.projectId !== batch.requestProjectId ||
        batch.recipientAssignmentId !== batch.requestAssignmentId ||
        batch.assignmentVersion !== batch.requestAssignmentVersion ||
        batch.requestState !== "held" ||
        batch.currentAssignmentVersion <= batch.assignmentVersion ||
        batch.taskState !== "open" ||
        batch.taskVersion !== batch.requestTaskVersion ||
        (batch.assignmentState !== "pending" &&
          batch.assignmentState !== "running") ||
        batch.instructionsRevision !== batch.currentInstructionsRevision ||
        batch.profileRevision !== batch.currentProfileRevision ||
        batch.revoked !== 0 ||
        !this.isNeverAdmittedRefusedAssignmentWork?.(workId)
      ) {
        return false;
      }

      if (
        this.domain
          .assignmentAdmission(String(batch.recipientAssignmentId))
          .reasons.some((reason) => reason !== "project-paused")
      ) {
        return false;
      }

      let candidateProfileIds: unknown;
      try {
        candidateProfileIds = JSON.parse(String(batch.candidateProfileIds));
      } catch {
        return false;
      }
      const permittedCandidates = z.array(uuid).safeParse(candidateProfileIds);
      if (
        !permittedCandidates.success ||
        (batch.profileId !== batch.leadProfileId &&
          !permittedCandidates.data.includes(String(batch.profileId))) ||
        this.one(
          `SELECT 1 AS held FROM task_writer_holds WHERE taskId = ?
          UNION ALL SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = ?
          UNION ALL SELECT 1 FROM task_archival_holds WHERE taskId = ? LIMIT 1`,
          String(batch.taskId),
          String(batch.taskId),
          String(batch.taskId),
        )
      ) {
        return false;
      }

      const events = this.db
        .prepare(`SELECT delivery.eventId, delivery.ordinal, event.sequence,
          event.taskId, event.recipientAssignmentId
        FROM coordination_delivery_events delivery
        JOIN coordination_inbox_events event ON event.eventId = delivery.eventId
        WHERE delivery.batchId = ? ORDER BY delivery.ordinal`)
        .all(String(batch.batchId)) as Array<{
        eventId: string;
        ordinal: number;
        sequence: number;
        taskId: string;
        recipientAssignmentId: string;
      }>;
      if (
        events.length === 0 ||
        events.some(
          (event, index) =>
            event.ordinal !== index + 1 ||
            event.taskId !== batch.taskId ||
            event.recipientAssignmentId !== batch.recipientAssignmentId ||
            event.sequence > batch.highWaterSequence,
        ) ||
        Math.max(...events.map((event) => event.sequence)) !==
          batch.highWaterSequence
      ) {
        return false;
      }

      this.db
        .prepare("DELETE FROM coordination_delivery_events WHERE batchId = ?")
        .run(String(batch.batchId));
      this.db
        .prepare(
          "DELETE FROM coordination_delivery_batches WHERE batchId = ? AND state = 'queued'",
        )
        .run(String(batch.batchId));
      const remains = this.one(
        "SELECT 1 AS present FROM coordination_delivery_batches WHERE batchId = ?",
        String(batch.batchId),
      );
      if (remains)
        throw new Error("Refused delivery batch changed during withdrawal");
      return true;
    });
  }

  private currentBinding(threadId: string, turnId: string): Row | undefined {
    const hasTurnRequests = Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_requests'",
        )
        .get(),
    );
    const rows = this.db
      .prepare(`SELECT binding.taskId, task.version AS taskVersion,
      binding.assignmentId, binding.conversationRevision,
      binding.assignmentVersion, binding.instructionsRevision, binding.profileRevision,
      assignment.profileId,
      ${hasTurnRequests ? "request.sequence" : "NULL"} AS requestSequence,
      ${hasTurnRequests ? "request.taskVersion" : "NULL"} AS admittedTaskVersion,
      revision.workRevision, intent.workId, assignment.resultDestination,
      assignment.resultRecipientAssignmentId, assignment.resultRecipientDisposition,
      assignment.requesterAssignmentId, assignment.projectId
      FROM task_execution_bindings binding
      JOIN domain_tasks task ON task.id = binding.taskId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN domain_assignments assignment
        ON assignment.id = binding.assignmentId AND assignment.taskId = binding.taskId
        AND assignment.instructionsRevision = binding.instructionsRevision
        AND assignment.profileRevision = binding.profileRevision
      ${
        hasTurnRequests
          ? `LEFT JOIN turn_requests request ON request.workId = binding.workId
        AND request.kind = 'assignment' AND request.taskId = binding.taskId
        AND request.assignmentId = binding.assignmentId
        AND request.assignmentVersion = binding.assignmentVersion
        AND request.instructionsRevision = binding.instructionsRevision
        AND request.profileRevision = binding.profileRevision`
          : ""
      }
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
        AND conversation.revision = binding.conversationRevision
      WHERE intent.threadId = ? AND intent.turnId = ? AND intent.state = 'running'
        AND assignment.version = binding.assignmentVersion
        AND assignment.state = 'running'
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
      .all(threadId, turnId) as Row[];
    if (rows.length > 1)
      throw new Error("Coordination callback matches ambiguous work");
    return rows[0];
  }

  private retainedEvidenceIdentity(binding: Row, call: CoordinationCall) {
    if (
      binding.requestSequence === null ||
      binding.requestSequence === undefined ||
      binding.admittedTaskVersion === null ||
      binding.admittedTaskVersion === undefined
    )
      return undefined;
    return {
      taskId: String(binding.taskId),
      taskVersion: Number(binding.admittedTaskVersion),
      captureTaskVersion: Number(binding.taskVersion),
      assignmentId: String(binding.assignmentId),
      assignmentVersion: Number(binding.assignmentVersion),
      workId: String(binding.workId),
      workRevision: Number(binding.workRevision),
      requestSequence: Number(binding.requestSequence),
      conversationRevision: Number(binding.conversationRevision),
      instructionsRevision: Number(binding.instructionsRevision),
      profileRevision: Number(binding.profileRevision),
      profileId: String(binding.profileId),
      threadId: call.threadId,
      turnId: call.turnId,
    };
  }

  private resolveRecipient(binding: Row): {
    id: string | null;
    resolved: boolean;
    reason: string;
  } {
    const id =
      binding.resultRecipientAssignmentId === null
        ? null
        : String(binding.resultRecipientAssignmentId);
    const resolved =
      id !== null &&
      binding.resultRecipientDisposition === "resolved" &&
      this.permittedRecipient(
        String(binding.taskId),
        String(binding.assignmentId),
        id,
        id,
        binding,
      );
    return {
      id: resolved ? id : null,
      resolved,
      reason: resolved
        ? ""
        : binding.resultRecipientDisposition !== "resolved"
          ? "Assignment has no resolved result recipient"
          : "Result recipient is missing, ambiguous, or belongs to another task",
    };
  }

  private permittedRecipient(
    taskId: string,
    assignmentId: string,
    recipientId: string,
    storedRecipient: string | null,
    binding?: Row,
  ): boolean {
    if (storedRecipient !== recipientId) return false;
    const source =
      binding ??
      this.required(
        "SELECT requesterAssignmentId, projectId, resultDestination FROM domain_assignments WHERE id = ? AND taskId = ?",
        assignmentId,
        taskId,
      );
    if (source.requesterAssignmentId !== null)
      return (
        String(source.requesterAssignmentId) === recipientId &&
        this.sameTaskRecipient(taskId, recipientId)
      );
    if (source.resultDestination === recipientId)
      return this.sameTaskRecipient(taskId, recipientId);
    const lead = this.one(
      "SELECT assignmentId FROM task_lead_bindings WHERE taskId = ? AND projectId = ?",
      taskId,
      String(source.projectId),
    );
    return (
      lead?.assignmentId === recipientId &&
      this.sameTaskRecipient(taskId, recipientId)
    );
  }

  private sameTaskRecipient(taskId: string, recipientId: string): boolean {
    return Boolean(
      this.one(
        "SELECT id FROM domain_assignments WHERE id = ? AND taskId = ?",
        recipientId,
        taskId,
      ) ??
        this.one(
          "SELECT assignmentId AS id FROM task_lead_bindings WHERE assignmentId = ? AND taskId = ?",
          recipientId,
          taskId,
        ),
    );
  }

  private insertResultEvent(
    result: AssignmentResult,
    recipientId: string,
  ): void {
    this.newEvent(
      result.taskId,
      recipientId,
      "assignment-result",
      result.resultId,
      JSON.stringify({
        resultId: result.resultId,
        assignmentId: result.assignmentId,
        workId: result.workId,
        workRevision: result.workRevision,
        summary: result.summary,
      }),
    );
  }

  private requestInteraction(
    input: CoordinationCall,
    kind: "question" | "approval",
    value: {
      prompt: string;
      action: string | null;
      target: string | null;
      materialHash: string | null;
      materialJson: string | null;
      form?: QuestionForm;
    },
  ): CoordinationToolResponse {
    const call = generalCallSchema.parse(input);
    return transaction(this.db, () => {
      const replay = this.cachedToolResponse(call);
      if (replay) {
        return replay;
      }
      const binding = this.currentBinding(call.threadId, call.turnId);
      if (!binding) throw new Error("Interaction is not bound to current work");
      const interactionId = randomUUID();
      this.db
        .prepare(`INSERT INTO coordination_interactions
        (interactionId, taskId, requestingAssignmentId, requestingWorkId,
          requestingWorkRevision, requestingAssignmentVersion, conversationRevision,
          kind, status, prompt, action, target, materialHash, materialJson, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1)`)
        .run(
          interactionId,
          String(binding.taskId),
          String(binding.assignmentId),
          String(binding.workId),
          Number(binding.workRevision),
          Number(binding.assignmentVersion),
          Number(binding.conversationRevision),
          kind,
          value.prompt,
          value.action,
          value.target,
          value.materialHash,
          value.materialJson,
        );
      if (value.form)
        this.db
          .prepare(
            "INSERT INTO coordination_question_forms (interactionId,schemaJson,schemaDigest) VALUES (?,?,?)",
          )
          .run(
            interactionId,
            JSON.stringify(value.form),
            payloadHash(value.form),
          );
      if (
        kind === "approval" &&
        actionKinds.some((action) => action === value.action)
      ) {
        const material = externalActionSchema.parse(
          JSON.parse(value.materialJson ?? "null"),
        );
        if (
          material.kind !== value.action ||
          canonical(material.target) !== value.target
        )
          throw new Error(
            "External approval requires exact action and target material",
          );
        new DeliveryStore(this.db).recordApprovalContextWithinTransaction(
          interactionId,
          this.deliveryCaller(call),
          material,
        );
      }
      const attentionId = randomUUID();
      this.db
        .prepare(`INSERT INTO coordination_operator_attention
        (attentionId, taskId, interactionId, status, revision)
        VALUES (?, ?, ?, 'open', 1)`)
        .run(attentionId, String(binding.taskId), interactionId);
      const response = {
        text:
          kind === "question"
            ? `Question queued for operator attention ${interactionId}`
            : `Approval queued for operator attention ${interactionId}`,
        success: true,
      };
      this.insertToolReceipt(call, binding, response);
      return response;
    });
  }

  private cachedToolResponse(
    call: CoordinationCall,
  ): CoordinationToolResponse | undefined {
    return this.receipt(call)?.response;
  }

  private insertToolReceipt(
    call: CoordinationCall,
    binding: Row,
    response: CoordinationToolResponse,
  ): void {
    this.db
      .prepare(`INSERT INTO coordination_receipts
      (threadId, turnId, callId, tool, payloadHash, taskId, assignmentId,
        workId, workRevision, response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        call.threadId,
        call.turnId,
        call.callId,
        call.tool,
        payloadHash({ tool: call.tool, arguments: call.arguments }),
        String(binding.taskId),
        String(binding.assignmentId),
        String(binding.workId),
        Number(binding.workRevision),
        JSON.stringify(response),
      );
  }

  private insertInteractionEvent(
    taskId: string,
    recipientAssignmentId: string,
    interactionId: string,
    eventType: string,
    payload: unknown,
  ): InboxEvent {
    return this.newEvent(
      taskId,
      recipientAssignmentId,
      eventType,
      null,
      JSON.stringify(payload),
      interactionId,
    );
  }

  private newEvent(
    taskId: string,
    recipientAssignmentId: string,
    eventType: string,
    resultId: string | null,
    payload: string,
    interactionId: string | null = null,
    routingOperationId: string | null = null,
  ): InboxEvent {
    const eventId = randomUUID();
    this.db
      .prepare(`INSERT INTO coordination_inbox_events
      (eventId, taskId, recipientAssignmentId, eventType, resultId,
        interactionId, routingOperationId, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        eventId,
        taskId,
        recipientAssignmentId,
        eventType,
        resultId,
        interactionId,
        routingOperationId,
        payload,
      );
    return this.parseEvent(
      this.required(
        "SELECT sequence, eventId, taskId, recipientAssignmentId, eventType, resultId, interactionId, payload, createdAt FROM coordination_inbox_events WHERE eventId = ?",
        eventId,
      ),
    );
  }

  private replayOperatorEvent(
    scope: string,
    key: string,
    payload: unknown,
  ): InboxEvent | undefined {
    const row = this.one(
      "SELECT payloadHash, result FROM coordination_operator_receipts WHERE scope = ? AND commandKey = ?",
      scope,
      key,
    );
    if (!row) return undefined;
    if (row.payloadHash !== payloadHash(payload))
      throw new Error("Operator command key reused with different content");
    const receipt = z
      .object({ eventId: z.string().uuid() })
      .parse(JSON.parse(String(row.result)));
    return this.parseEvent(
      this.required(
        "SELECT sequence, eventId, taskId, recipientAssignmentId, eventType, resultId, interactionId, payload, createdAt FROM coordination_inbox_events WHERE eventId = ?",
        receipt.eventId,
      ),
    );
  }

  private saveOperatorReceipt(
    scope: string,
    key: string,
    payload: unknown,
    eventId: string,
  ): void {
    this.db
      .prepare(`INSERT INTO coordination_operator_receipts
      (scope, commandKey, payloadHash, result) VALUES (?, ?, ?, ?)`)
      .run(scope, key, payloadHash(payload), JSON.stringify({ eventId }));
  }

  private requireOpenInteraction(
    interaction: Row,
    kind: "question" | "approval",
    expectedRevision: number,
  ): void {
    if (interaction.kind !== kind || interaction.status !== "open")
      throw new Error("Interaction is not open for this response");
    if (Number(interaction.revision) !== expectedRevision)
      throw new Error("Interaction revision conflict");
  }

  private resolveAttention(interactionId: string): void {
    this.db
      .prepare(`UPDATE coordination_operator_attention
      SET status = 'resolved', revision = revision + 1, resolvedAt = unixepoch()
      WHERE interactionId = ? AND status = 'open'`)
      .run(interactionId);
    if (
      this.one(
        "SELECT status FROM coordination_operator_attention WHERE interactionId = ?",
        interactionId,
      )?.status !== "resolved"
    )
      throw new Error("Operator attention was already resolved");
  }

  private parseInteraction(row: Row): CoordinationInteraction {
    return {
      interactionId: String(row.interactionId),
      taskId: String(row.taskId),
      requestingAssignmentId: String(row.requestingAssignmentId),
      requestingWorkId: String(row.requestingWorkId),
      requestingWorkRevision: Number(row.requestingWorkRevision),
      requestingAssignmentVersion: Number(row.requestingAssignmentVersion),
      conversationRevision: Number(row.conversationRevision),
      kind: z.enum(["question", "approval"]).parse(row.kind),
      status: z
        .enum(["open", "answered", "approved", "denied"])
        .parse(row.status),
      prompt: String(row.prompt),
      action: row.action === null ? null : String(row.action),
      target: row.target === null ? null : String(row.target),
      materialHash: row.materialHash === null ? null : String(row.materialHash),
      materialJson: row.materialJson === null ? null : String(row.materialJson),
      response: row.response === null ? null : String(row.response),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private parseAttention(row: Row): OperatorAttention {
    return {
      attentionId: String(row.attentionId),
      taskId: String(row.taskId),
      interactionId: String(row.interactionId),
      status: z.enum(["open", "resolved"]).parse(row.status),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
      resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt),
    };
  }

  private parseFollowUp(row: Row): FollowUpRequest {
    return {
      followUpId: String(row.followUpId),
      resultId: String(row.resultId),
      taskId: String(row.taskId),
      requestingAssignmentId: String(row.requestingAssignmentId),
      targetAssignmentId: String(row.targetAssignmentId),
      priorWorkId: String(row.priorWorkId),
      priorWorkRevision: Number(row.priorWorkRevision),
      priorAssignmentVersion: Number(row.priorAssignmentVersion),
      nextAssignmentVersion: Number(row.nextAssignmentVersion),
      instructions: String(row.instructions),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
    };
  }

  private parseCompletionRequest(row: Row): TaskCompletionRequest {
    return {
      requestId: String(row.requestId),
      taskId: String(row.taskId),
      leadAssignmentId: String(row.leadAssignmentId),
      leadWorkId: String(row.leadWorkId),
      leadWorkRevision: Number(row.leadWorkRevision),
      taskVersion: Number(row.taskVersion),
      reviewedResultIds: z
        .array(uuid)
        .parse(JSON.parse(String(row.reviewedResultIds))),
      status: z.enum(["pending", "rejected", "finalized"]).parse(row.status),
      rejectionReasons: z
        .array(z.string().min(1).max(128))
        .max(32)
        .parse(JSON.parse(String(row.rejectionReasons))),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
      finalizedAt: row.finalizedAt === null ? null : Number(row.finalizedAt),
    };
  }

  private completionBlockers(
    request: TaskCompletionRequest,
    terminal: "completed" | "failed",
    externalAction = false,
  ): string[] {
    const reasons: string[] = [];
    if (
      this.one(
        `SELECT 1 FROM coordination_runtime_questions runtime
        JOIN coordination_interactions interaction USING(interactionId)
        WHERE interaction.taskId = ? AND runtime.deliveryState <> 'confirmed'
        LIMIT 1`,
        request.taskId,
      )
    )
      reasons.push("unresolved-native-delivery");
    if (!externalAction)
      reasons.push(...this.domain.admission(request.taskId, true).reasons);
    if (terminal !== "completed") reasons.push("lead-work-not-successful");
    const lead = this.one(
      `SELECT task.state AS taskState, task.version AS taskVersion,
      project.paused AS projectPaused, intent.state AS workState,
      binding.assignmentId, binding.assignmentVersion, binding.conversationRevision,
      revision.workRevision, assignment.version AS currentAssignmentVersion,
      assignment.state AS assignmentState, lead.assignmentId AS taskLeadAssignmentId
      FROM domain_tasks task
      JOIN domain_projects project ON project.id = task.projectId
      JOIN task_execution_bindings binding ON binding.workId = ?
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
      JOIN task_lead_bindings lead ON lead.taskId = task.id
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
        AND conversation.revision = binding.conversationRevision
      WHERE task.id = ? AND project.paused = 0
        AND binding.assignmentId = ? AND revision.workRevision = ?
        AND task.version = ? AND task.state = 'open'
        AND assignment.version = binding.assignmentVersion
        AND assignment.state = 'running'
        AND lead.assignmentId = binding.assignmentId
        AND intent.state = '${externalAction ? "running" : "completed"}'
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = revision.assignmentId
            AND newer.conversationRevision = revision.conversationRevision
            AND newer.workRevision > revision.workRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = revision.assignmentId
            AND ambiguous.conversationRevision = revision.conversationRevision
        )`,
      request.leadWorkId,
      request.taskId,
      request.leadAssignmentId,
      request.leadWorkRevision,
      request.taskVersion,
    );
    if (!lead) reasons.push("lead-work-or-task-revision-is-stale");
    const leadResultEffect = this.one(
      `SELECT effect.workId FROM execution_pending_effects effect
      JOIN task_execution_bindings binding ON binding.workId = effect.workId
      WHERE effect.workId = ? AND effect.effectKey = 'assignment-result'
        AND effect.state = 'pending' AND binding.taskId = ?
        AND binding.assignmentId = ?`,
      request.leadWorkId,
      request.taskId,
      request.leadAssignmentId,
    );
    if (!leadResultEffect) reasons.push("lead-result-effect-missing");
    if (
      this.one(
        "SELECT 1 AS blocked FROM domain_tasks task JOIN domain_projects project ON project.id = task.projectId WHERE task.id = ? AND project.paused = 1",
        request.taskId,
      )
    )
      reasons.push("project-paused");

    const assignments = this.db
      .prepare(
        "SELECT id, state FROM domain_assignments WHERE taskId = ? ORDER BY id",
      )
      .all(request.taskId) as Row[];
    if (
      assignments.some(
        (assignment) =>
          assignment.id !== request.leadAssignmentId &&
          assignment.state !== "completed",
      )
    )
      reasons.push("assignments-not-complete");
    const leadBinding = this.one(
      "SELECT assignmentId FROM task_lead_bindings WHERE taskId = ?",
      request.taskId,
    );
    const currentResults = this.db
      .prepare(`SELECT result.resultId,
      result.assignmentId, result.destinationDisposition, assignment.state
      FROM coordination_results result
      JOIN domain_assignments assignment ON assignment.id = result.assignmentId
      JOIN task_work_revisions revision ON revision.workId = result.workId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = revision.assignmentId
        AND conversation.revision = revision.conversationRevision
      WHERE result.taskId = ? AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions newer
        WHERE newer.assignmentId = revision.assignmentId
          AND newer.conversationRevision = revision.conversationRevision
          AND newer.workRevision > revision.workRevision
      ) ORDER BY result.resultId`)
      .all(request.taskId) as Row[];
    const currentResultIds = currentResults
      .map((row) => String(row.resultId))
      .sort();
    if (canonical(currentResultIds) !== canonical(request.reviewedResultIds))
      reasons.push("current-results-not-fully-reviewed");
    if (currentResults.some((row) => row.destinationDisposition !== "resolved"))
      reasons.push("unresolved-result-destination");
    if (
      this.one(
        `SELECT 1 AS missing FROM domain_assignments assignment
      JOIN task_lead_bindings lead ON lead.taskId = assignment.taskId
      JOIN task_execution_bindings binding ON binding.assignmentId = assignment.id
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN execution_intents intent ON intent.workId = binding.workId
      WHERE assignment.taskId = ? AND assignment.id <> lead.assignmentId
        AND assignment.state = 'completed' AND intent.state = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = revision.assignmentId
            AND newer.conversationRevision = revision.conversationRevision
            AND newer.workRevision > revision.workRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM coordination_results result
          WHERE result.workId = binding.workId
        ) LIMIT 1`,
        request.taskId,
      )
    )
      reasons.push("completed-assignment-missing-result");
    if (
      this.one(
        "SELECT 1 AS open FROM coordination_interactions WHERE taskId = ? AND status = 'open' LIMIT 1",
        request.taskId,
      )
    )
      reasons.push("open-interaction");
    if (
      this.one(
        `SELECT 1 AS pending FROM coordination_unresolved_result_destinations
      WHERE taskId = ? AND status = 'unresolved' LIMIT 1`,
        request.taskId,
      )
    )
      reasons.push("unresolved-result-hold");
    if (
      this.one(
        `SELECT 1 AS pending FROM coordination_inbox_events event
      LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
      WHERE event.taskId = ? AND delivery.eventId IS NULL LIMIT 1`,
        request.taskId,
      )
    )
      reasons.push("pending-inbox-event");
    if (
      this.one(
        `SELECT 1 AS queued FROM coordination_delivery_batches
      WHERE taskId = ? AND state = 'queued' AND (? = 0 OR deliveryWorkId <> ?) LIMIT 1`,
        request.taskId,
        Number(externalAction),
        request.leadWorkId,
      )
    )
      reasons.push("queued-inbox-delivery");
    const unfinishedWork = this.db
      .prepare(`SELECT intent.workId FROM execution_intents intent
      JOIN task_execution_bindings binding ON binding.workId = intent.workId
      WHERE binding.taskId = ? AND intent.state IN
        ('ready','capacity-waiting','held','submitting','running')`)
      .all(request.taskId) as Array<{ workId: string }>;
    if (
      unfinishedWork.some(
        (item) =>
          !(externalAction && item.workId === request.leadWorkId) &&
          !this.isHistoricalWorkResolved(item.workId),
      )
    )
      reasons.push("unfinished-execution");
    if (
      this.one(
        "SELECT 1 AS held FROM task_writer_holds WHERE taskId = ? LIMIT 1",
        request.taskId,
      )
    )
      reasons.push("task-stop-or-writer-hold");
    if (
      this.one(
        "SELECT 1 AS held FROM task_writer_ambiguity_holds WHERE taskId = ? LIMIT 1",
        request.taskId,
      )
    )
      reasons.push("task-writer-ambiguity-hold");
    if (
      this.one(
        "SELECT 1 AS held FROM task_archival_holds WHERE taskId = ? LIMIT 1",
        request.taskId,
      )
    )
      reasons.push("task-archival-hold");
    if (
      this.one(
        `SELECT 1 AS pending FROM execution_pending_effects effect
      JOIN task_execution_bindings binding ON binding.workId = effect.workId
      WHERE binding.taskId = ? AND effect.state = 'pending'
        AND NOT (effect.workId = ? AND effect.effectKey = 'assignment-result'
          AND binding.assignmentId = ?) LIMIT 1`,
        request.taskId,
        request.leadWorkId,
        request.leadAssignmentId,
      )
    )
      reasons.push("unfinished-callback-effect");
    if (
      this.one(
        `SELECT 1 AS stopped FROM execution_stop_targets target
      WHERE target.taskId = ? AND target.terminalState != 'completed' LIMIT 1`,
        request.taskId,
      )
    )
      reasons.push("unresolved-stop-target");
    if (
      this.one(`SELECT 1 AS queued FROM sqlite_master
      WHERE type = 'table' AND name = 'turn_requests'`)
    ) {
      const unfinishedRequests = this.db
        .prepare(`SELECT request.workId FROM turn_requests request
        WHERE request.taskId = ? AND request.state IN ('queued','active','held')`)
        .all(request.taskId) as Array<{ workId: string }>;
      if (
        unfinishedRequests.some(
          (item) =>
            !(externalAction && item.workId === request.leadWorkId) &&
            !this.isHistoricalWorkResolved(item.workId),
        )
      )
        reasons.push("unfinished-turn-request");
    }
    if (leadBinding?.assignmentId !== request.leadAssignmentId)
      reasons.push("task-lead-binding-changed");
    return [...new Set(reasons)];
  }

  private parseReceipt(row: Row): CoordinationReceipt {
    return {
      threadId: String(row.threadId),
      turnId: String(row.turnId),
      callId: String(row.callId),
      tool: String(row.tool),
      payloadHash: String(row.payloadHash),
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      workId: String(row.workId),
      workRevision: Number(row.workRevision),
      response: responseSchema.parse(JSON.parse(String(row.response))),
    };
  }

  private parseReportingRepair(row: Row): ReportingRepair {
    return {
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      assignmentVersion: Number(row.assignmentVersion),
      missedWorkId: String(row.missedWorkId),
      repairWorkId: String(row.repairWorkId),
      attempts: Number(row.attempts),
      state: z.enum(["queued", "held", "resolved"]).parse(row.state),
      reason: row.reason === null ? null : String(row.reason),
    };
  }

  private resultByWork(workId: string): AssignmentResult {
    return this.parseResult(
      this.required(
        "SELECT resultId, taskId, assignmentId, workId, workRevision, assignmentVersion, summary, recipientAssignmentId, destinationDisposition, createdAt FROM coordination_results WHERE workId = ?",
        workId,
      ),
    );
  }

  private resultById(resultId: string): AssignmentResult {
    return this.parseResult(
      this.required(
        "SELECT resultId, taskId, assignmentId, workId, workRevision, assignmentVersion, summary, recipientAssignmentId, destinationDisposition, createdAt FROM coordination_results WHERE resultId = ?",
        resultId,
      ),
    );
  }

  private parseResult(row: Row): AssignmentResult {
    return {
      resultId: String(row.resultId),
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      workId: String(row.workId),
      workRevision: Number(row.workRevision),
      assignmentVersion: Number(row.assignmentVersion),
      summary: String(row.summary),
      recipientAssignmentId:
        row.recipientAssignmentId === null
          ? null
          : String(row.recipientAssignmentId),
      destinationDisposition:
        row.destinationDisposition === "resolved" ? "delivered" : "unresolved",
      createdAt: Number(row.createdAt),
    };
  }

  private parseEvent(row: Row): InboxEvent {
    return {
      sequence: Number(row.sequence),
      eventId: String(row.eventId),
      taskId: String(row.taskId),
      recipientAssignmentId: String(row.recipientAssignmentId),
      eventType: String(row.eventType),
      resultId: row.resultId === null ? null : String(row.resultId),
      interactionId:
        row.interactionId === null || row.interactionId === undefined
          ? null
          : String(row.interactionId),
      payload: String(row.payload),
      createdAt: Number(row.createdAt),
    };
  }

  private delivery(batchId: string): InboxDelivery {
    const row = this.required(
      "SELECT batchId, deliveryWorkId, taskId, recipientAssignmentId, assignmentVersion, highWaterSequence, state FROM coordination_delivery_batches WHERE batchId = ?",
      batchId,
    );
    const events = this.db
      .prepare(`SELECT event.sequence, event.eventId, event.taskId,
      event.recipientAssignmentId, event.eventType, event.resultId, event.interactionId,
      event.payload, event.createdAt
      FROM coordination_delivery_events delivery
      JOIN coordination_inbox_events event ON event.eventId = delivery.eventId
      WHERE delivery.batchId = ? ORDER BY delivery.ordinal`)
      .all(batchId)
      .map((event) => this.parseEvent(event as Row));
    return {
      batchId: String(row.batchId),
      deliveryWorkId: String(row.deliveryWorkId),
      taskId: String(row.taskId),
      recipientAssignmentId: String(row.recipientAssignmentId),
      assignmentVersion: Number(row.assignmentVersion),
      highWaterSequence: Number(row.highWaterSequence),
      state: z.enum(["queued", "completed"]).parse(row.state),
      events,
    };
  }

  private one(
    sql: string,
    ...parameters: (string | number | null)[]
  ): Row | undefined {
    const row = this.db.prepare(sql).get(...parameters) as Row | undefined;
    return row ? { ...row } : undefined;
  }

  private required(
    sql: string,
    ...parameters: (string | number | null)[]
  ): Row {
    const row = this.one(sql, ...parameters);
    if (!row) throw new Error("Unknown coordination record");
    return row;
  }
}
