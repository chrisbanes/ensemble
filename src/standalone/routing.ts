import { createHash, randomUUID } from "node:crypto";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  choice,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { z } from "zod";
import type { Database } from "../core/store.js";

export const routingModel = "jev-1.13.0" as const;
const maxAttempts = 2;
const routingProcessId = randomUUID();
const activeRoutes = new WeakMap<
  RoutingAttemptStore,
  Map<string, Promise<RoutingOutcome>>
>();

const routingCandidateSchema = z
  .object({
    profileId: z.string().uuid(),
    name: z.string().trim().min(1).max(512),
    capabilities: z.string().max(16_000),
    profileRevision: z.number().int().positive(),
  })
  .strict();

const routingSnapshotSchema = z
  .object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskVersion: z.number().int().positive(),
    guidanceRevision: z.number().int().positive(),
    brief: z.string().max(16_000),
    findings: z.string().max(16_000),
    guidance: z.string().max(16_000),
    candidates: z.array(routingCandidateSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      new Set(snapshot.candidates.map((candidate) => candidate.profileId))
        .size !== snapshot.candidates.length
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Routing candidates must have unique profile IDs",
      });
  });

export type RoutingSnapshot = z.infer<typeof routingSnapshotSchema>;
export type RoutingCandidate = RoutingSnapshot["candidates"][number];

export interface RoutingChoiceState {
  brief: string;
  findings: string;
  guidance: string;
  candidates: RoutingCandidate[];
}

export interface RoutingChoiceRequest {
  requestedModel: typeof routingModel;
  state: RoutingChoiceState;
  choices: string[];
}

export interface RoutingUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RoutingChoiceResponse {
  choice: string;
  model: string;
  confidence: number;
  probabilities: Record<string, number>;
  usage: RoutingUsage;
}

export interface RoutingChoiceClient {
  choose(
    request: RoutingChoiceRequest,
    signal: AbortSignal,
  ): Promise<RoutingChoiceResponse>;
}

export type RoutingFallbackReason =
  | "missing-credentials"
  | "lead-review"
  | "no-candidates"
  | "missing-context"
  | "malformed-response"
  | "non-retryable-failure"
  | "transient-exhausted";

export type RoutingOutcome =
  | {
      kind: "assigned";
      profileId: string;
      requestedModel: typeof routingModel;
      returnedModel: string;
      confidence: number;
      probabilities: Record<string, number>;
      usage: RoutingUsage;
    }
  | {
      kind: "lead-review";
      reason: RoutingFallbackReason;
      requestedModel: typeof routingModel;
      returnedModel?: string | undefined;
      confidence?: number | undefined;
      probabilities?: Record<string, number> | undefined;
      usage?: RoutingUsage | undefined;
    };

export type RoutingAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out";
export type RoutingFailureClass = "transient" | "permanent";
export type RoutingStaleReason =
  | "task-revision-changed"
  | "routing-revision-changed"
  | "candidate-set-changed"
  | "candidate-profile-changed"
  | "admission-held"
  | "task-held"
  | "assignment-already-exists"
  | "domain-disposition-rejected";

export interface RoutingAttempt {
  operationId: string;
  attempt: number;
  status: RoutingAttemptStatus;
  failureClass: RoutingFailureClass | null;
  failureCode: string | null;
  requestedModel: typeof routingModel;
  returnedModel: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  usage: RoutingUsage | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface RoutingOperation {
  operationId: string;
  projectId: string;
  taskId: string;
  taskVersion: number;
  snapshotHash: string;
  snapshot: RoutingSnapshot;
  status: "pending" | "routing" | "assigned" | "lead-review" | "stale";
  attemptsUsed: number;
  currentAttempt: number | null;
  outcome: RoutingOutcome | null;
  staleReason: RoutingStaleReason | null;
}

export class RoutingOperationStaleError extends Error {
  constructor(
    readonly operationId: string,
    readonly reason: RoutingStaleReason,
  ) {
    super(`Routing operation is stale: ${reason}`);
    this.name = "RoutingOperationStaleError";
  }
}

const staleReasonSchema = z.enum([
  "task-revision-changed",
  "routing-revision-changed",
  "candidate-set-changed",
  "candidate-profile-changed",
  "admission-held",
  "task-held",
  "assignment-already-exists",
  "domain-disposition-rejected",
]);

const routingOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("assigned"),
      profileId: z.string().uuid(),
      requestedModel: z.literal(routingModel),
      returnedModel: z.string().min(1).max(120),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("lead-review"),
      reason: z.enum([
        "missing-credentials",
        "lead-review",
        "no-candidates",
        "missing-context",
        "malformed-response",
        "non-retryable-failure",
        "transient-exhausted",
      ]),
      requestedModel: z.literal(routingModel),
      returnedModel: z.string().min(1).max(120).optional(),
      confidence: z.number().min(0).max(1).optional(),
      probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

const attemptStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed-out",
]);
const failureClassSchema = z.enum(["transient", "permanent"]);
const attemptRowSchema = z.object({
  operationId: z.string().uuid(),
  attempt: z.number().int().positive(),
  ownerId: z.string().uuid().nullable(),
  status: attemptStatusSchema,
  failureClass: failureClassSchema.nullable(),
  failureCode: z.string().nullable(),
  requestedModel: z.literal(routingModel),
  returnedModel: z.string().nullable(),
  confidence: z.number().nullable(),
  probabilitiesJson: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});

const operationRowSchema = z.object({
  operationId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskVersion: z.number().int().positive(),
  snapshotHash: z.string().length(64),
  snapshotJson: z.string(),
  status: z.enum(["pending", "routing", "assigned", "lead-review", "stale"]),
  attemptsUsed: z.number().int().min(0).max(maxAttempts),
  currentAttempt: z.number().int().positive().nullable(),
  outcomeJson: z.string().nullable(),
  staleReason: staleReasonSchema.nullable(),
});

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(
  serialized: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`Persisted ${label} is malformed`);
  }
  return schema.parse(parsed);
}

function transaction<T>(db: Database, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class RoutingAttemptStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS routing_attempt_operations (
      operationId TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      taskVersion INTEGER NOT NULL CHECK(taskVersion > 0),
      snapshotHash TEXT NOT NULL,
      snapshotJson TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','routing','assigned','lead-review','stale')),
      attemptsUsed INTEGER NOT NULL DEFAULT 0 CHECK(attemptsUsed BETWEEN 0 AND 2),
      currentAttempt INTEGER,
      outcomeJson TEXT,
      staleReason TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(projectId, taskId, taskVersion)
    );
    CREATE TABLE IF NOT EXISTS routing_attempts (
      operationId TEXT NOT NULL REFERENCES routing_attempt_operations(operationId) ON DELETE CASCADE,
      attempt INTEGER NOT NULL CHECK(attempt > 0),
      ownerId TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','timed-out')),
      failureClass TEXT CHECK(failureClass IS NULL OR failureClass IN ('transient','permanent')),
      failureCode TEXT,
      requestedModel TEXT NOT NULL,
      returnedModel TEXT,
      confidence REAL,
      probabilitiesJson TEXT,
      inputTokens INTEGER,
      outputTokens INTEGER,
      startedAt INTEGER NOT NULL,
      finishedAt INTEGER,
      PRIMARY KEY(operationId, attempt)
    );
    CREATE INDEX IF NOT EXISTS routing_attempt_operations_by_task
      ON routing_attempt_operations(projectId, taskId, taskVersion);`);
  }

  ensureOperation(input: RoutingSnapshot): RoutingOperation {
    const snapshot = routingSnapshotSchema.parse(input);
    const snapshotJson = stableJson(snapshot);
    const snapshotHash = hash(snapshotJson);
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(`SELECT * FROM routing_attempt_operations
        WHERE projectId = ? AND taskId = ? AND taskVersion = ?`)
        .get(snapshot.projectId, snapshot.taskId, snapshot.taskVersion);
      if (existing !== undefined) {
        const operation = this.parseOperation(existing);
        if (operation.snapshotHash !== snapshotHash)
          throw new Error(
            "Routing operation conflict: captured context changed",
          );
        return operation;
      }
      const operationId = randomUUID();
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO routing_attempt_operations
        (operationId, projectId, taskId, taskVersion, snapshotHash, snapshotJson,
         status, attemptsUsed, currentAttempt, outcomeJson, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`)
        .run(
          operationId,
          snapshot.projectId,
          snapshot.taskId,
          snapshot.taskVersion,
          snapshotHash,
          snapshotJson,
          now,
          now,
        );
      return this.operationById(operationId);
    });
  }

  startAttempt(operationId: string, ownerId?: string): RoutingAttempt {
    return transaction(this.db, () => {
      const operation = this.operationById(operationId);
      if (operation.status === "stale")
        throw new RoutingOperationStaleError(
          operationId,
          operation.staleReason ?? "domain-disposition-rejected",
        );
      if (operation.outcome)
        throw new Error("Routing operation is already complete");
      let interrupted: RoutingAttempt | undefined;
      if (operation.currentAttempt !== null) {
        const prior = this.attemptByNumber(
          operationId,
          operation.currentAttempt,
        );
        if (prior.status === "running") {
          if (
            ownerId !== undefined &&
            this.readOwner(operationId, prior.attempt) === ownerId
          )
            throw new Error("Routing attempt is already active");
          this.db
            .prepare(`UPDATE routing_attempts SET status = 'failed',
            failureClass = 'transient', failureCode = 'interrupted', finishedAt = ?
            WHERE operationId = ? AND attempt = ? AND status = 'running'`)
            .run(Date.now(), operationId, prior.attempt);
          interrupted = this.attemptByNumber(operationId, prior.attempt);
          this.db
            .prepare(`UPDATE routing_attempt_operations SET status = 'pending',
            currentAttempt = NULL, updatedAt = ? WHERE operationId = ?`)
            .run(Date.now(), operationId);
        }
      }
      if (operation.attemptsUsed >= maxAttempts) {
        if (interrupted) return interrupted;
        throw new Error("Routing attempt budget exhausted");
      }
      const next = operation.attemptsUsed + 1;
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO routing_attempts
        (operationId, attempt, ownerId, status, failureClass, failureCode,
         requestedModel, returnedModel, confidence, probabilitiesJson,
         inputTokens, outputTokens, startedAt, finishedAt)
        VALUES (?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`)
        .run(operationId, next, ownerId ?? null, routingModel, now);
      this.db
        .prepare(`UPDATE routing_attempt_operations SET status = 'routing',
        attemptsUsed = ?, currentAttempt = ?, updatedAt = ? WHERE operationId = ?`)
        .run(next, next, now, operationId);
      return this.attemptByNumber(operationId, next);
    });
  }

  finishAttempt(
    operationId: string,
    attempt: number,
    response: RoutingChoiceResponse,
    outcome: RoutingOutcome,
  ): boolean {
    return transaction(this.db, () => {
      const current = this.operationById(operationId);
      if (current.currentAttempt !== attempt || current.outcome !== null)
        return false;
      const now = Date.now();
      this.db
        .prepare(`UPDATE routing_attempts SET status = 'succeeded',
        returnedModel = ?, confidence = ?, probabilitiesJson = ?, inputTokens = ?,
        outputTokens = ?, finishedAt = ? WHERE operationId = ? AND attempt = ? AND status = 'running'`)
        .run(
          response.model,
          response.confidence,
          stableJson(response.probabilities),
          response.usage.inputTokens,
          response.usage.outputTokens,
          now,
          operationId,
          attempt,
        );
      this.db
        .prepare(`UPDATE routing_attempt_operations SET status = ?, outcomeJson = ?,
        currentAttempt = NULL, updatedAt = ? WHERE operationId = ?`)
        .run(
          outcome.kind === "assigned" ? "assigned" : "lead-review",
          stableJson(outcome),
          now,
          operationId,
        );
      return true;
    });
  }

  failAttempt(
    operationId: string,
    attempt: number,
    failureClass: RoutingFailureClass,
    failureCode: string,
    status: "failed" | "timed-out" = "failed",
  ): boolean {
    return transaction(this.db, () => {
      const operation = this.operationById(operationId);
      if (operation.currentAttempt !== attempt || operation.outcome !== null)
        return false;
      const now = Date.now();
      const changed = this.db
        .prepare(`UPDATE routing_attempts SET status = ?,
        failureClass = ?, failureCode = ?, finishedAt = ?
        WHERE operationId = ? AND attempt = ? AND status = 'running'`)
        .run(status, failureClass, failureCode, now, operationId, attempt) as {
        changes?: number;
      };
      if (changed.changes === 0) return false;
      this.db
        .prepare(`UPDATE routing_attempt_operations SET status = 'pending', currentAttempt = NULL,
        updatedAt = ? WHERE operationId = ?`)
        .run(now, operationId);
      return true;
    });
  }

  markStale(operationId: string, reason: RoutingStaleReason): RoutingOperation {
    const validatedReason = staleReasonSchema.parse(reason);
    transaction(this.db, () => {
      const current = this.operationById(operationId);
      if (current.status === "stale") {
        if (current.staleReason !== validatedReason)
          throw new Error("Stale routing disposition conflict");
        return;
      }
      const now = Date.now();
      if (current.currentAttempt !== null)
        this.db
          .prepare(`UPDATE routing_attempts SET status = 'failed',
          failureClass = 'permanent', failureCode = 'stale-context', finishedAt = ?
          WHERE operationId = ? AND attempt = ? AND status = 'running'`)
          .run(now, operationId, current.currentAttempt);
      const changed = this.db
        .prepare(`UPDATE routing_attempt_operations SET status = 'stale',
        staleReason = ?, currentAttempt = NULL, updatedAt = ? WHERE operationId = ?
          AND status != 'stale'`)
        .run(validatedReason, now, operationId) as { changes?: number };
      if (changed.changes !== 1)
        throw new Error(
          "Routing operation is not eligible for stale disposition",
        );
    });
    return this.operationById(operationId);
  }

  completeFallback(
    operationId: string,
    outcome: Extract<RoutingOutcome, { kind: "lead-review" }>,
  ): RoutingOutcome {
    const validated = routingOutcomeSchema.parse(outcome);
    if (validated.kind !== "lead-review")
      throw new Error("Expected a lead-review outcome");
    transaction(this.db, () => {
      const current = this.operationById(operationId);
      if (current.outcome !== null) return;
      if (current.status === "stale")
        throw new RoutingOperationStaleError(
          operationId,
          current.staleReason ?? "domain-disposition-rejected",
        );
      if (current.currentAttempt !== null)
        throw new Error("Cannot fallback while a routing attempt is current");
      const now = Date.now();
      this.db
        .prepare(`UPDATE routing_attempt_operations SET status = 'lead-review', outcomeJson = ?,
        updatedAt = ? WHERE operationId = ?`)
        .run(stableJson(validated), now, operationId);
    });
    return this.operationById(operationId).outcome ?? validated;
  }

  operation(
    projectId: string,
    taskId: string,
    taskVersion: number,
  ): RoutingOperation | undefined {
    const row = this.db
      .prepare(`SELECT * FROM routing_attempt_operations
      WHERE projectId = ? AND taskId = ? AND taskVersion = ?`)
      .get(projectId, taskId, taskVersion);
    return row === undefined ? undefined : this.parseOperation(row);
  }

  operations(taskId?: string): RoutingOperation[] {
    const rows = taskId
      ? this.db
          .prepare(
            "SELECT * FROM routing_attempt_operations WHERE taskId = ? ORDER BY taskVersion",
          )
          .all(taskId)
      : this.db
          .prepare(
            "SELECT * FROM routing_attempt_operations ORDER BY createdAt, operationId",
          )
          .all();
    return rows.map((row) => this.parseOperation(row));
  }

  attempts(operationId: string): RoutingAttempt[] {
    return this.db
      .prepare(
        `SELECT * FROM routing_attempts WHERE operationId = ? ORDER BY attempt`,
      )
      .all(operationId)
      .map((row) => this.parseAttempt(row));
  }

  private operationById(operationId: string): RoutingOperation {
    const row = this.db
      .prepare("SELECT * FROM routing_attempt_operations WHERE operationId = ?")
      .get(operationId);
    if (row === undefined) throw new Error("Routing operation was not found");
    return this.parseOperation(row);
  }

  private attemptByNumber(
    operationId: string,
    attempt: number,
  ): RoutingAttempt {
    const row = this.db
      .prepare(`SELECT * FROM routing_attempts
      WHERE operationId = ? AND attempt = ?`)
      .get(operationId, attempt);
    if (row === undefined) throw new Error("Routing attempt was not found");
    return this.parseAttempt(row);
  }

  private readOwner(operationId: string, attempt: number): string | null {
    const row = this.db
      .prepare(`SELECT ownerId FROM routing_attempts
      WHERE operationId = ? AND attempt = ?`)
      .get(operationId, attempt) as { ownerId: string | null } | undefined;
    return row?.ownerId ?? null;
  }

  private parseOperation(row: unknown): RoutingOperation {
    const value = operationRowSchema.parse(row);
    return {
      operationId: value.operationId,
      projectId: value.projectId,
      taskId: value.taskId,
      taskVersion: value.taskVersion,
      snapshotHash: value.snapshotHash,
      snapshot: parseJson(
        value.snapshotJson,
        routingSnapshotSchema,
        "routing snapshot",
      ),
      status: value.status,
      attemptsUsed: value.attemptsUsed,
      currentAttempt: value.currentAttempt,
      outcome:
        value.outcomeJson === null
          ? null
          : parseJson(
              value.outcomeJson,
              routingOutcomeSchema,
              "routing outcome",
            ),
      staleReason: value.staleReason,
    };
  }

  private parseAttempt(row: unknown): RoutingAttempt {
    const value = attemptRowSchema.parse(row);
    return {
      operationId: value.operationId,
      attempt: value.attempt,
      status: value.status,
      failureClass: value.failureClass,
      failureCode: value.failureCode,
      requestedModel: value.requestedModel,
      returnedModel: value.returnedModel,
      confidence: value.confidence,
      probabilities:
        value.probabilitiesJson === null
          ? null
          : parseJson(
              value.probabilitiesJson,
              z.record(z.string(), z.number().min(0).max(1)),
              "routing probabilities",
            ),
      usage:
        value.inputTokens === null || value.outputTokens === null
          ? null
          : {
              inputTokens: value.inputTokens,
              outputTokens: value.outputTokens,
            },
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
    };
  }
}

export class RoutingFailure extends Error {
  constructor(
    message: string,
    readonly classification: RoutingFailureClass,
    readonly code = "provider-failure",
  ) {
    super(message);
    this.name = "RoutingFailure";
  }
}

export interface RoutingCoordinatorOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const choiceResponseSchema = z
  .object({
    choice: z.string().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    confidence: z.number().finite().min(0).max(1),
    probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

function validateResponse(
  input: RoutingChoiceResponse,
  snapshot: RoutingSnapshot,
): RoutingChoiceResponse {
  const response = choiceResponseSchema.parse(input);
  const choices = [
    ...snapshot.candidates.map((candidate) => candidate.profileId),
    "lead_review",
  ];
  if (!choices.includes(response.choice))
    throw new Error("Provider selected an unlisted candidate");
  if (response.model !== routingModel)
    throw new Error("Provider returned a different model than requested");
  const probabilityKeys = Object.keys(response.probabilities).sort();
  if (probabilityKeys.join("\0") !== [...choices].sort().join("\0"))
    throw new Error(
      "Provider returned probabilities for a different choice set",
    );
  const probabilityTotal = Object.values(response.probabilities).reduce(
    (total, value) => total + value,
    0,
  );
  if (Math.abs(probabilityTotal - 1) > 0.02)
    throw new Error("Provider returned invalid choice probabilities");
  return response;
}

function responseOutcome(response: RoutingChoiceResponse): RoutingOutcome {
  const provenance = {
    requestedModel: routingModel,
    returnedModel: response.model,
    confidence: response.confidence,
    probabilities: response.probabilities,
    usage: response.usage,
  };
  return response.choice === "lead_review"
    ? { kind: "lead-review", reason: "lead-review", ...provenance }
    : { kind: "assigned", profileId: response.choice, ...provenance };
}

function isTransient(error: unknown): error is RoutingFailure {
  if (error instanceof RoutingFailure)
    return error.classification === "transient";
  if (error instanceof APIConnectionError || error instanceof APITimeoutError)
    return true;
  if (error instanceof APIError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return false;
}

function failureCode(error: unknown): string {
  if (error instanceof RoutingFailure) return error.code;
  if (error instanceof APITimeoutError) return "provider-timeout";
  if (error instanceof APIConnectionError) return "connection-failure";
  if (error instanceof APIError) return `http-${error.status}`;
  return "provider-failure";
}

function fallback(
  store: RoutingAttemptStore,
  operationId: string,
  reason: RoutingFallbackReason,
): RoutingOutcome {
  return store.completeFallback(operationId, {
    kind: "lead-review",
    reason,
    requestedModel: routingModel,
  });
}

export class RoutingCoordinator {
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly store: RoutingAttemptStore,
    private readonly client: RoutingChoiceClient,
    options: RoutingCoordinatorOptions = {},
  ) {
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.retryMaxMs = options.retryMaxMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (!Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs < 0)
      throw new Error("retryBaseMs must be a non-negative safe integer");
    if (
      !Number.isSafeInteger(this.retryMaxMs) ||
      this.retryMaxMs < this.retryBaseMs
    )
      throw new Error("retryMaxMs must be a safe integer at least retryBaseMs");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error("timeoutMs must be a positive safe integer");
  }

  async route(input: RoutingSnapshot): Promise<RoutingOutcome> {
    const snapshot = routingSnapshotSchema.parse(input);
    const operation = this.store.ensureOperation(snapshot);
    if (operation.status === "stale")
      throw new RoutingOperationStaleError(
        operation.operationId,
        operation.staleReason ?? "domain-disposition-rejected",
      );
    if (operation.outcome) return Promise.resolve(operation.outcome);
    let operationRoutes = activeRoutes.get(this.store);
    if (!operationRoutes) {
      operationRoutes = new Map();
      activeRoutes.set(this.store, operationRoutes);
    }
    const active = operationRoutes.get(operation.operationId);
    if (active) return active;
    const routePromise = this.routeOperation(operation).finally(() => {
      operationRoutes?.delete(operation.operationId);
    });
    operationRoutes.set(operation.operationId, routePromise);
    return routePromise;
  }

  private async routeOperation(
    operation: RoutingOperation,
  ): Promise<RoutingOutcome> {
    const snapshot = operation.snapshot;
    if (snapshot.candidates.length === 0)
      return fallback(this.store, operation.operationId, "no-candidates");
    if (!snapshot.brief.trim())
      return fallback(this.store, operation.operationId, "missing-context");
    if (
      operation.attemptsUsed >= maxAttempts &&
      operation.currentAttempt === null
    )
      return fallback(this.store, operation.operationId, "transient-exhausted");

    while (true) {
      const previousCount =
        this.store.operation(
          snapshot.projectId,
          snapshot.taskId,
          snapshot.taskVersion,
        )?.attemptsUsed ?? 0;
      let attempt: RoutingAttempt;
      try {
        attempt = this.store.startAttempt(
          operation.operationId,
          routingProcessId,
        );
      } catch (error) {
        const latest = this.store.operation(
          snapshot.projectId,
          snapshot.taskId,
          snapshot.taskVersion,
        );
        if (latest?.status === "stale")
          throw new RoutingOperationStaleError(
            latest.operationId,
            latest.staleReason ?? "domain-disposition-rejected",
          );
        if (latest?.outcome) return latest.outcome;
        if (latest && latest.attemptsUsed >= maxAttempts)
          return fallback(
            this.store,
            latest.operationId,
            "transient-exhausted",
          );
        throw error;
      }

      if (attempt.status !== "running")
        return fallback(
          this.store,
          operation.operationId,
          "transient-exhausted",
        );

      let response: RoutingChoiceResponse;
      try {
        response = await this.chooseWithTimeout(snapshot);
      } catch (error) {
        const transient = isTransient(error);
        const code = failureCode(error);
        this.store.failAttempt(
          operation.operationId,
          attempt.attempt,
          transient ? "transient" : "permanent",
          code,
          error instanceof RoutingFailure && error.code === "timeout"
            ? "timed-out"
            : "failed",
        );
        const current = this.store.operation(
          snapshot.projectId,
          snapshot.taskId,
          snapshot.taskVersion,
        );
        if (current?.status === "stale")
          throw new RoutingOperationStaleError(
            current.operationId,
            current.staleReason ?? "domain-disposition-rejected",
          );
        if (current?.outcome) return current.outcome;
        if (!transient)
          return fallback(
            this.store,
            operation.operationId,
            error instanceof RoutingFailure &&
              error.code === "malformed-response"
              ? "malformed-response"
              : "non-retryable-failure",
          );
        if (attempt.attempt >= maxAttempts)
          return fallback(
            this.store,
            operation.operationId,
            "transient-exhausted",
          );
        const delay = Math.min(
          this.retryBaseMs * 2 ** (attempt.attempt - 1),
          this.retryMaxMs,
        );
        if (delay > 0) await this.sleep(delay);
        continue;
      }

      let validated: RoutingChoiceResponse;
      try {
        validated = validateResponse(response, snapshot);
      } catch {
        this.store.failAttempt(
          operation.operationId,
          attempt.attempt,
          "permanent",
          "malformed-response",
        );
        return fallback(
          this.store,
          operation.operationId,
          "malformed-response",
        );
      }
      const outcome = responseOutcome(validated);
      if (
        this.store.finishAttempt(
          operation.operationId,
          attempt.attempt,
          validated,
          outcome,
        )
      )
        return (
          this.store.operation(
            snapshot.projectId,
            snapshot.taskId,
            snapshot.taskVersion,
          )?.outcome ?? outcome
        );
      const latest = this.store.operation(
        snapshot.projectId,
        snapshot.taskId,
        snapshot.taskVersion,
      );
      if (latest?.status === "stale")
        throw new RoutingOperationStaleError(
          latest.operationId,
          latest.staleReason ?? "domain-disposition-rejected",
        );
      if (latest?.outcome) return latest.outcome;
      if (latest && latest.attemptsUsed <= previousCount)
        return fallback(
          this.store,
          operation.operationId,
          "transient-exhausted",
        );
    }
  }

  private async chooseWithTimeout(
    snapshot: RoutingSnapshot,
  ): Promise<RoutingChoiceResponse> {
    const controller = new AbortController();
    const request: RoutingChoiceRequest = {
      requestedModel: routingModel,
      state: {
        brief: snapshot.brief,
        findings: snapshot.findings,
        guidance: snapshot.guidance,
        candidates: snapshot.candidates,
      },
      choices: [
        ...snapshot.candidates.map((candidate) => candidate.profileId),
        "lead_review",
      ],
    };
    const provider = this.client.choose(request, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = new RoutingFailure(
          "Routing inference timed out",
          "transient",
          "timeout",
        );
        controller.abort(failure);
        reject(failure);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([provider, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

interface TypeSafeSystemOneClient {
  systemOne(
    request: unknown,
    options: { signal: AbortSignal; retry: { maxRetries: 0 } },
  ): Promise<unknown>;
}

export class TypeSafeRoutingChoiceClient implements RoutingChoiceClient {
  private readonly client: TypeSafeSystemOneClient;

  constructor(
    apiKey: string,
    options: {
      createClient?: (apiKey: string) => TypeSafeSystemOneClient;
    } = {},
  ) {
    if (!apiKey.trim()) throw new Error("TypeSafe API key must not be blank");
    this.client =
      options.createClient?.(apiKey) ??
      new TypeSafeClient({
        apiKey,
        defaultModel: routingModel,
        retry: { maxRetries: 0 },
        logLevel: "off",
      });
  }

  async choose(
    request: RoutingChoiceRequest,
    signal: AbortSignal,
  ): Promise<RoutingChoiceResponse> {
    try {
      const descriptions = Object.fromEntries(
        request.choices.map((profileId) => {
          if (profileId === "lead_review")
            return [profileId, "Route to task lead for review"];
          const candidate = request.state.candidates.find(
            (item) => item.profileId === profileId,
          );
          return [
            profileId,
            candidate ? `${candidate.name}: ${candidate.capabilities}` : null,
          ];
        }),
      );
      const response = await this.client.systemOne(
        {
          model: request.requestedModel,
          state: request.state,
          questions: {
            profile: choice(
              "Choose the one eligible profile best suited to complete this brief, or lead_review if unsure.",
              descriptions,
            ),
          },
        },
        { signal, retry: { maxRetries: 0 } },
      );
      const result = response as {
        model?: unknown;
        answers?: {
          profile?: {
            type?: unknown;
            choice?: unknown;
            confidence?: unknown;
            probabilities?: unknown;
          };
        };
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      const answer = result.answers?.profile;
      if (answer?.type !== "choice")
        throw new Error("TypeSafe response did not contain a Choice answer");
      return {
        choice: answer.choice as string,
        model: result.model as string,
        confidence: answer.confidence as number,
        probabilities: answer.probabilities as Record<string, number>,
        usage: {
          inputTokens: result.usage?.input_tokens as number,
          outputTokens: result.usage?.output_tokens as number,
        },
      };
    } catch (error) {
      if (error instanceof APIUserAbortError)
        throw new RoutingFailure(
          "TypeSafe request was cancelled",
          "permanent",
          "cancelled",
        );
      if (
        error instanceof APITimeoutError ||
        error instanceof APIConnectionError
      )
        throw new RoutingFailure(
          "TypeSafe transport failed",
          "transient",
          failureCode(error),
        );
      if (error instanceof APIError)
        throw new RoutingFailure(
          "TypeSafe API rejected the request",
          isTransient(error) ? "transient" : "permanent",
          `http-${error.status}`,
        );
      if (error instanceof RoutingFailure) throw error;
      throw new RoutingFailure(
        "TypeSafe returned an invalid response",
        "permanent",
        "malformed-response",
      );
    }
  }
}

/** Resolves env-backed credentials only inside the production routing adapter. */
export function routingClientFromEnvironment(
  credentialReference: string | null,
): RoutingChoiceClient | undefined {
  const reference = z
    .string()
    .regex(/^env:([A-Z][A-Z0-9_]*)$/)
    .safeParse(credentialReference);
  if (!reference.success) return undefined;
  const name = reference.data.slice("env:".length);
  const apiKey = process.env[name];
  if (!apiKey?.trim()) return undefined;
  return new TypeSafeRoutingChoiceClient(apiKey);
}
