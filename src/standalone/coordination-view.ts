import { z } from "zod";
import type {
  AssignmentResult,
  CoordinationInteraction,
  CoordinationStore,
  InboxEvent,
  OperatorAttention,
  TaskCompletionRequest,
  UnresolvedResultDestination,
} from "../core/coordination.js";
import type { DomainStore } from "../core/domain.js";
import type { ExecutionIntent, ExecutionState } from "./state.js";
import type {
  RoutingAttempt,
  RoutingAttemptStore,
  RoutingOperation,
} from "./routing.js";

const uuid = z.string().uuid();
const commandKey = z.string().uuid();
const assignmentMessageSchema = z.object({ message: z.string() }).strict();
const answerEventSchema = z
  .object({
    interactionId: uuid,
    revision: z.number().int().positive(),
    answer: z.string(),
  })
  .strict();
const approvalEventSchema = z
  .object({
    interactionId: uuid,
    revision: z.number().int().positive(),
    decision: z.enum(["approved", "denied"]),
    action: z.string(),
    target: z.string().nullable(),
    materialHash: z.string().length(64),
  })
  .strict();
const fallbackEventSchema = z
  .object({
    routingOperationId: uuid,
    brief: z.string(),
    reason: z.string(),
    evidence: z.string(),
  })
  .strict();

export interface CoordinationTaskIdentity {
  id: string;
  projectId: string;
  title: string;
  version: number;
  state: string;
  ready: boolean;
}

export interface CoordinationAssignmentSummary {
  assignmentId: string;
  profileId: string;
  version: number;
  state: string;
}

export interface CoordinationWorkHistoryEntry {
  workId: string;
  assignmentId: string;
  assignmentVersion: number;
  conversationRevision: number;
  state: ExecutionIntent["state"];
  threadId: string | null;
  turnId: string | null;
}

export interface CoordinationViewMessage {
  eventId: string;
  eventType: string;
  recipientAssignmentId: string;
  deliveryState: "pending" | "queued" | "delivered";
  createdAt: number;
  text?: string;
  decision?: "approved" | "denied";
  action?: string;
  target?: string | null;
  resultId?: string;
  routingOperationId?: string;
  routingReason?: string;
  interactionId?: string;
}

export interface CoordinationInteractionAttention {
  attentionId: string;
  interactionId: string;
  status: OperatorAttention["status"];
  revision: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface CoordinationRoutingAttemptView {
  operationId: string;
  taskVersion: number;
  status: RoutingOperation["status"];
  attemptsUsed: number;
  currentAttempt: number | null;
  snapshotHash: string;
  outcome: RoutingOperation["outcome"];
  staleReason: RoutingOperation["staleReason"];
  attempts: Array<
    Pick<
      RoutingAttempt,
      | "attempt"
      | "status"
      | "failureClass"
      | "requestedModel"
      | "returnedModel"
      | "confidence"
      | "probabilities"
      | "usage"
      | "startedAt"
      | "finishedAt"
    >
  >;
}

export interface CoordinationRoutingDispositionView {
  operationId: string;
  taskVersion: number;
  assignmentId: string | null;
  model: string;
  disposition: string;
  resultDestination: string;
}

export interface CoordinationRoutingFallbackAttention {
  eventId: string;
  operationId: string;
  reason: string;
  createdAt: number;
}

export interface CoordinationTaskView {
  task: CoordinationTaskIdentity;
  assignments: CoordinationAssignmentSummary[];
  history: CoordinationWorkHistoryEntry[];
  results: AssignmentResult[];
  unresolvedResults: UnresolvedResultDestination[];
  messages: CoordinationViewMessage[];
  questions: CoordinationInteraction[];
  approvals: CoordinationInteraction[];
  completionRequests: TaskCompletionRequest[];
  routing: {
    dispositions: CoordinationRoutingDispositionView[];
    attempts: CoordinationRoutingAttemptView[];
  };
  attention: {
    interactions: CoordinationInteractionAttention[];
    completions: TaskCompletionRequest[];
    routingFallbacks: CoordinationRoutingFallbackAttention[];
  };
}

export interface CoordinationCommandReceipt {
  eventId: string;
  taskId: string;
  recipientAssignmentId: string;
  eventType: string;
  createdAt: number;
}

export interface OperatorMessageCommand {
  taskId: string;
  key: string;
  recipientAssignmentId: string;
  expectedAssignmentVersion: number;
  message: string;
}

export interface ResultRecipientCommand {
  taskId: string;
  key: string;
  resultId: string;
  expectedRevision: number;
  recipientAssignmentId: string;
}

export interface QuestionAnswerCommand {
  taskId: string;
  key: string;
  interactionId: string;
  expectedRevision: number;
  answer: string;
}

export interface ApprovalDecisionCommand {
  taskId: string;
  key: string;
  interactionId: string;
  expectedRevision: number;
  decision: "approved" | "denied";
  action: string;
  target?: string;
  material?: unknown;
}

const operatorMessageCommand = z
  .object({
    taskId: uuid,
    key: commandKey,
    recipientAssignmentId: uuid,
    expectedAssignmentVersion: z.number().int().positive(),
    message: z.string().trim().min(1).max(16000),
  })
  .strict();
const resultRecipientCommand = z
  .object({
    taskId: uuid,
    key: commandKey,
    resultId: uuid,
    expectedRevision: z.number().int().positive(),
    recipientAssignmentId: uuid,
  })
  .strict();
const questionAnswerCommand = z
  .object({
    taskId: uuid,
    key: commandKey,
    interactionId: uuid,
    expectedRevision: z.number().int().positive(),
    answer: z.string().trim().min(1).max(16000),
  })
  .strict();
const approvalDecisionCommand = z
  .object({
    taskId: uuid,
    key: commandKey,
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

/** Curated task-scoped operator reads and commands; it never exposes runtime prompts or payloads. */
export class CoordinationView {
  constructor(
    private readonly domain: DomainStore,
    private readonly coordination: CoordinationStore,
    private readonly state: ExecutionState,
    private readonly routingAttempts: RoutingAttemptStore,
    private readonly onCommand: () => Promise<void>,
  ) {}

  readTask(taskId: string): CoordinationTaskView {
    const task = this.domain.task(uuid.parse(taskId));
    const id = String(task.id);
    const assignments = this.domain.assignments(id);
    const assignmentIds = new Set(assignments.map((row) => String(row.id)));
    const assignmentSummaries = assignments.map((row) => ({
      assignmentId: String(row.id),
      profileId: String(row.profileId),
      version: Number(row.version),
      state: String(row.state),
    }));
    const history = this.state
      .list()
      .flatMap((intent) => {
        const binding = this.state.taskBinding(intent.workId);
        if (!binding || binding.taskId !== id) return [];
        return [
          {
            workId: intent.workId,
            assignmentId: binding.assignmentId,
            assignmentVersion: binding.assignmentVersion,
            conversationRevision: binding.conversationRevision,
            state: intent.state,
            threadId: intent.threadId,
            turnId: intent.turnId,
          },
        ];
      })
      .sort((a, b) => a.workId.localeCompare(b.workId));
    const inbox = assignments.flatMap((row) =>
      this.coordination.inboxEvents(String(row.id)),
    );
    for (const event of inbox) {
      if (
        event.taskId !== id ||
        !assignmentIds.has(event.recipientAssignmentId)
      )
        throw new Error("Task inbox contains an out-of-scope event");
    }
    const pending = new Set(
      assignments.flatMap((row) =>
        this.coordination
          .pendingEvents(String(row.id))
          .map((event) => event.eventId),
      ),
    );
    const queued = new Set(
      this.coordination
        .queuedDeliveries()
        .filter((delivery) => delivery.taskId === id)
        .flatMap((delivery) => delivery.events.map((event) => event.eventId)),
    );
    const messages = inbox
      .map((event) => this.messageView(event, pending, queued))
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId),
      );
    const interactions = this.coordination.interactions(id);
    const operatorAttention = this.coordination.operatorAttention(id);
    const completionRequests = this.coordination.completionRequests(id);
    const fallbackAttention = messages.flatMap((message) =>
      message.eventType === "routing-fallback" && message.routingOperationId
        ? [
            {
              eventId: message.eventId,
              operationId: message.routingOperationId,
              reason: message.routingReason ?? "",
              createdAt: message.createdAt,
            },
          ]
        : [],
    );
    const dispositions = this.domain.routingOperations(id).map((row) => ({
      operationId: String(row.id),
      taskVersion: Number(row.taskVersion),
      assignmentId: row.assignmentId === null ? null : String(row.assignmentId),
      model: String(row.model),
      disposition: String(row.disposition),
      resultDestination: String(row.resultDestination),
    }));
    const attempts = this.routingAttempts.operations(id).map((operation) => ({
      operationId: operation.operationId,
      taskVersion: operation.taskVersion,
      status: operation.status,
      attemptsUsed: operation.attemptsUsed,
      currentAttempt: operation.currentAttempt,
      snapshotHash: operation.snapshotHash,
      outcome: operation.outcome,
      staleReason: operation.staleReason,
      attempts: this.routingAttempts
        .attempts(operation.operationId)
        .map(
          ({
            attempt,
            status,
            failureClass,
            requestedModel,
            returnedModel,
            confidence,
            probabilities,
            usage,
            startedAt,
            finishedAt,
          }) => ({
            attempt,
            status,
            failureClass,
            requestedModel,
            returnedModel,
            confidence,
            probabilities,
            usage,
            startedAt,
            finishedAt,
          }),
        ),
    }));
    return {
      task: {
        id,
        projectId: String(task.projectId),
        title: String(task.title),
        version: Number(task.version),
        state: String(task.state),
        ready: Number(task.ready) === 1,
      },
      assignments: assignmentSummaries,
      history,
      results: this.coordination.results(id),
      unresolvedResults: this.coordination.unresolvedResultDestinations(id),
      messages,
      questions: interactions.filter(
        (interaction) => interaction.kind === "question",
      ),
      approvals: interactions.filter(
        (interaction) => interaction.kind === "approval",
      ),
      completionRequests,
      routing: { dispositions, attempts },
      attention: {
        interactions: operatorAttention.map((attention) => ({
          attentionId: attention.attentionId,
          interactionId: attention.interactionId,
          status: attention.status,
          revision: attention.revision,
          createdAt: attention.createdAt,
          resolvedAt: attention.resolvedAt,
        })),
        completions: completionRequests,
        routingFallbacks: fallbackAttention,
      },
    };
  }

  async postOperatorMessage(
    input: OperatorMessageCommand,
  ): Promise<CoordinationCommandReceipt> {
    const command = operatorMessageCommand.parse(input);
    this.requireTask(command.taskId);
    if (
      !this.domain
        .assignments(command.taskId)
        .some((assignment) => assignment.id === command.recipientAssignmentId)
    )
      throw new Error("Message recipient is not in this task");
    return this.commitCommand(
      this.coordination.postOperatorMessage({ actor: "operator", ...command }),
    );
  }

  async reconcileResultRecipient(
    input: ResultRecipientCommand,
  ): Promise<CoordinationCommandReceipt> {
    const command = resultRecipientCommand.parse(input);
    this.requireTask(command.taskId);
    if (
      !this.coordination
        .results(command.taskId)
        .some((result) => result.resultId === command.resultId)
    )
      throw new Error("Result is not in this task");
    return this.commitCommand(
      this.coordination.reconcileResultRecipient({
        actor: "operator",
        key: command.key,
        resultId: command.resultId,
        expectedRevision: command.expectedRevision,
        recipientAssignmentId: command.recipientAssignmentId,
      }),
    );
  }

  async answerQuestion(
    input: QuestionAnswerCommand,
  ): Promise<CoordinationCommandReceipt> {
    const command = questionAnswerCommand.parse(input);
    this.requireInteraction(command.taskId, command.interactionId, "question");
    return this.commitCommand(
      this.coordination.answerQuestion({
        actor: "operator",
        key: command.key,
        interactionId: command.interactionId,
        expectedRevision: command.expectedRevision,
        answer: command.answer,
      }),
    );
  }

  async decideApproval(
    input: ApprovalDecisionCommand,
  ): Promise<CoordinationCommandReceipt> {
    const command = approvalDecisionCommand.parse(input);
    this.requireInteraction(command.taskId, command.interactionId, "approval");
    return this.commitCommand(
      this.coordination.decideApproval({
        actor: "operator",
        key: command.key,
        interactionId: command.interactionId,
        expectedRevision: command.expectedRevision,
        decision: command.decision,
        action: command.action,
        ...(command.target === undefined ? {} : { target: command.target }),
        ...(command.material === undefined
          ? {}
          : { material: command.material }),
      }),
    );
  }

  private requireTask(taskId: string): void {
    this.domain.task(taskId);
  }

  private requireInteraction(
    taskId: string,
    interactionId: string,
    kind: CoordinationInteraction["kind"],
  ): CoordinationInteraction {
    this.requireTask(taskId);
    const interaction = this.coordination
      .interactions(taskId)
      .find((item) => item.interactionId === interactionId);
    if (!interaction || interaction.kind !== kind)
      throw new Error(
        `${kind === "question" ? "Question" : "Approval"} is not in this task`,
      );
    return interaction;
  }

  private async commitCommand(
    event: InboxEvent,
  ): Promise<CoordinationCommandReceipt> {
    const receipt = {
      eventId: event.eventId,
      taskId: event.taskId,
      recipientAssignmentId: event.recipientAssignmentId,
      eventType: event.eventType,
      createdAt: event.createdAt,
    };
    await this.onCommand();
    return receipt;
  }

  private messageView(
    event: InboxEvent,
    pending: Set<string>,
    queued: Set<string>,
  ): CoordinationViewMessage {
    const base: CoordinationViewMessage = {
      eventId: event.eventId,
      eventType: event.eventType,
      recipientAssignmentId: event.recipientAssignmentId,
      deliveryState: pending.has(event.eventId)
        ? "pending"
        : queued.has(event.eventId)
          ? "queued"
          : "delivered",
      createdAt: event.createdAt,
    };
    switch (event.eventType) {
      case "operator-message":
        return {
          ...base,
          text: assignmentMessageSchema.parse(JSON.parse(event.payload))
            .message,
        };
      case "question-answer": {
        const payload = answerEventSchema.parse(JSON.parse(event.payload));
        return {
          ...base,
          interactionId: payload.interactionId,
          text: payload.answer,
        };
      }
      case "approval-decision": {
        const payload = approvalEventSchema.parse(JSON.parse(event.payload));
        return {
          ...base,
          interactionId: payload.interactionId,
          decision: payload.decision,
          action: payload.action,
          target: payload.target,
        };
      }
      case "routing-fallback": {
        const payload = fallbackEventSchema.parse(JSON.parse(event.payload));
        return {
          ...base,
          routingOperationId: payload.routingOperationId,
          routingReason: payload.reason,
          text: payload.reason,
        };
      }
      case "assignment-result":
        return event.resultId ? { ...base, resultId: event.resultId } : base;
      default:
        return base;
    }
  }
}
