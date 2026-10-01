import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./store.js";

const identity = z.string().trim().min(1).max(512);
export const actionKinds = [
  "issue.comment",
  "issue.labels",
  "issue.edit",
  "project.field",
  "pr.create",
  "pr.edit",
  "pr.ready",
  "pr.merge",
  "issue.close",
] as const;
export const deliveryPolicySchema = z
  .object({
    mode: z.enum(["reviewable-pr", "through-merge"]),
    credentialRef: z
      .string()
      .regex(/^env:[A-Z][A-Z0-9_]*$/)
      .nullable(),
    grants: z
      .array(
        z
          .object({
            action: z.enum(actionKinds),
            repositoryId: identity,
            mode: z.enum(["allow", "approval"]),
            projectNodeId: identity.optional(),
            fieldNodeId: identity.optional(),
            optionNodeIds: z.array(identity).optional(),
          })
          .strict(),
      )
      .max(256),
    requiredChecks: z
      .array(
        z
          .object({
            name: identity,
            appId: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type DeliveryPolicy = z.output<typeof deliveryPolicySchema> & {
  version: number;
};

const targetSchema = z
  .object({
    repositoryId: identity,
    number: z.number().int().positive(),
    nodeId: identity,
  })
  .strict();
const prTargetSchema = targetSchema
  .extend({
    baseRef: identity,
    headRef: identity,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
const textFields = {
  title: z.string().trim().min(1).max(512).optional(),
  body: z.string().max(64000).optional(),
};
const edits = z
  .object(textFields)
  .strict()
  .refine(
    (v) => v.title !== undefined || v.body !== undefined,
    "Edit requires title or body",
  );
export const externalActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("issue.comment"),
      target: targetSchema,
      body: z.string().min(1).max(64000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.labels"),
      target: targetSchema,
      add: z.array(identity).max(100),
      remove: z.array(identity).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.edit"),
      target: targetSchema,
      fields: edits,
    })
    .strict(),
  z
    .object({
      kind: z.literal("project.field"),
      target: targetSchema,
      projectNodeId: identity,
      itemNodeId: identity,
      fieldNodeId: identity,
      optionNodeId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.create"),
      target: z
        .object({
          repositoryId: identity,
          baseRef: identity,
          headRef: identity,
          expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
        })
        .strict(),
      title: z.string().min(1).max(512),
      body: z.string().max(64000),
      draft: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.edit"),
      target: prTargetSchema,
      fields: edits,
    })
    .strict(),
  z.object({ kind: z.literal("pr.ready"), target: prTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("pr.merge"),
      target: prTargetSchema,
      method: z.enum(["merge", "squash", "rebase"]),
      reviewedResultIds: z.array(z.string().uuid()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.close"),
      target: targetSchema,
      reviewedResultIds: z.array(z.string().uuid()),
    })
    .strict(),
]);
export const externalActionArgumentsSchema = z
  .object({
    operationId: z.string().uuid(),
    action: externalActionSchema,
    approval: z
      .object({
        interactionId: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExternalAction = z.output<typeof externalActionSchema>;
export type ExternalActionArguments = z.output<
  typeof externalActionArgumentsSchema
>;
const bindingSchema = z
  .object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskVersion: z.number().int().positive(),
    assignmentId: z.string().uuid(),
    assignmentVersion: z.number().int().positive(),
    workId: identity,
    workRevision: z.number().int().positive(),
    conversationRevision: z.number().int().positive(),
  })
  .strict();
export type DeliveryCaller = z.output<typeof bindingSchema>;
export const actionObservationSchema = z
  .object({
    state: z.enum(["uncertain", "confirmed-success", "confirmed-failure"]),
    reason: identity.nullable(),
    receipt: z
      .object({
        nodeId: identity,
        number: z.number().int().positive().optional(),
        headSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        merged: z.boolean().optional(),
        issueClosed: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ProviderActionObservation = z.output<
  typeof actionObservationSchema
>;
export const prObservationSchema = z
  .object({
    repositoryId: identity,
    nodeId: identity,
    number: z.number().int().positive(),
    baseRef: identity,
    headRef: identity,
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    draft: z.boolean(),
    merged: z.boolean(),
    reviewDecision: z
      .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
      .nullable(),
    checks: z.array(
      z
        .object({
          name: identity,
          appId: z.number().int().nullable(),
          sha: z.string(),
          status: z.enum(["success", "pending", "failure"]),
          nodeId: identity.optional(),
          updatedAt: identity.optional(),
        })
        .strict(),
    ),
    feedback: z
      .array(
        z
          .object({
            kind: z.enum(["comment", "review", "review-comment"]),
            nodeId: identity,
            author: identity,
            updatedAt: identity,
            state: identity,
            body: z.string().max(2000),
            commitSha: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
    mergeBlockers: z.array(identity),
    closedIssueNodeIds: z.array(identity).default([]),
    allowedMethods: z.array(z.enum(["merge", "squash", "rebase"])),
  })
  .strict();
export type PrDeliveryObservation = z.output<typeof prObservationSchema>;
export const registerPrArgumentsSchema = z
  .object({
    repositoryId: identity,
    prNumber: z.number().int().positive(),
    expectedPrNodeId: identity,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
export const handbackSettlementSchema = registerPrArgumentsSchema
  .extend({
    actor: z.literal("operator"),
    key: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedTaskVersion: z.number().int().positive(),
    expectedDeliveryRevision: z.number().int().positive(),
    expectedPolicyVersion: z.number().int().positive(),
    decision: z.enum(["accepted", "closed"]),
  })
  .strict();
export type HandbackSettlement = z.output<typeof handbackSettlementSchema>;
const prBindingSchema = z
  .object({
    taskId: z.string().uuid(),
    projectId: z.string().uuid(),
    leadAssignmentId: z.string().uuid(),
    registeredWorkId: identity,
    revision: z.number().int().positive(),
    mode: z.enum(["reviewable-pr", "through-merge"]),
    observation: prObservationSchema,
    observationDigest: z.string().length(64),
    observedAt: z.number(),
    readError: identity.nullable(),
    settlement: z
      .object({
        key: z.string().uuid(),
        decision: z.enum(["accepted", "closed"]),
        headSha: z.string().length(40),
        taskVersion: z.number().int().positive(),
        policyVersion: z.number().int().positive(),
        createdAt: z.number(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PrDeliveryBinding = z.output<typeof prBindingSchema>;
export type TaskDeliveryView = ReturnType<DeliveryStore["publicTask"]>;
const actionRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    request: externalActionArgumentsSchema,
    binding: bindingSchema,
    policyVersion: z.number().int().positive(),
    state: z.enum([
      "prepared",
      "attempting",
      "uncertain",
      "confirmed-success",
      "confirmed-failure",
      "denied",
    ]),
    attempts: z.number().int().nonnegative(),
    beforeState: z.record(z.string(), z.json()).nullable(),
    observation: actionObservationSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type DeliveryActionRecord = z.output<typeof actionRecordSchema>;

export function canonicalMaterial(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalMaterial).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalMaterial(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function materialDigest(value: unknown): string {
  return createHash("sha256").update(canonicalMaterial(value)).digest("hex");
}

/** Methods suffixed WithinTransaction compose with existing SQLite command transactions. */
export class DeliveryStore {
  constructor(private readonly db: Database) {}
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_policies (
      projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
      policyJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_actions (
      operationId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      materialHash TEXT NOT NULL, recordJson TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS delivery_actions_task ON delivery_actions(taskId);
    CREATE TABLE IF NOT EXISTS delivery_pr_bindings (taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id), recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_observations (taskId TEXT NOT NULL REFERENCES domain_tasks(id), digest TEXT NOT NULL, observationJson TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(taskId,digest));
    CREATE TABLE IF NOT EXISTS delivery_approval_bindings (interactionId TEXT PRIMARY KEY REFERENCES coordination_interactions(interactionId),taskId TEXT NOT NULL,assignmentId TEXT NOT NULL,taskVersion INTEGER NOT NULL,assignmentVersion INTEGER NOT NULL,conversationRevision INTEGER NOT NULL,workRevision INTEGER NOT NULL,policyVersion INTEGER NOT NULL,materialHash TEXT NOT NULL,operationId TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS delivery_waiting_work (workId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES domain_tasks(id),assignmentId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_settlement_receipts (commandKey TEXT PRIMARY KEY,payloadHash TEXT NOT NULL,recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      operationId TEXT NOT NULL REFERENCES delivery_actions(operationId), attempt INTEGER NOT NULL,
      beforeJson TEXT NOT NULL, observationJson TEXT, PRIMARY KEY(operationId,attempt));
    `);
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private save(record: DeliveryActionRecord): void {
    this.db
      .prepare("UPDATE delivery_actions SET recordJson=? WHERE operationId=?")
      .run(
        canonicalMaterial(actionRecordSchema.parse(record)),
        record.operationId,
      );
  }
  action(operationId: string): DeliveryActionRecord {
    const row = this.db
      .prepare("SELECT recordJson FROM delivery_actions WHERE operationId=?")
      .get(operationId) as { recordJson: string } | undefined;
    if (!row) throw new Error("Unknown delivery action");
    try {
      return actionRecordSchema.parse(JSON.parse(row.recordJson));
    } catch {
      throw new Error("Invalid persisted delivery action");
    }
  }
  actions(taskId?: string): DeliveryActionRecord[] {
    const rows = (
      taskId
        ? this.db
            .prepare(
              "SELECT operationId FROM delivery_actions WHERE taskId=? ORDER BY rowid",
            )
            .all(taskId)
        : this.db
            .prepare("SELECT operationId FROM delivery_actions ORDER BY rowid")
            .all()
    ) as { operationId: string }[];
    return rows.map((row) => this.action(row.operationId));
  }
  actionBlockers(taskId: string, exceptOperationId?: string): string[] {
    return [
      ...new Set(
        this.actions(taskId)
          .filter(
            (record) =>
              record.operationId !== exceptOperationId &&
              ["prepared", "attempting", "uncertain"].includes(record.state),
          )
          .map((record) => `external-action-${record.state}`),
      ),
    ];
  }
  authorize(
    request: ExternalActionArguments,
    binding: DeliveryCaller,
    approved: boolean,
    policyVersion?: number,
  ): void {
    const policy = this.configuration(binding.projectId);
    if (policyVersion !== undefined && policy.version !== policyVersion)
      throw new Error("Delivery policy changed");
    const action = request.action;
    const grant = policy.grants.find(
      (g) =>
        g.action === action.kind &&
        g.repositoryId === action.target.repositoryId &&
        (action.kind !== "project.field" ||
          (g.projectNodeId === action.projectNodeId &&
            g.fieldNodeId === action.fieldNodeId &&
            g.optionNodeIds?.includes(action.optionNodeId))),
    );
    if (!grant) throw new Error("External action denied by project policy");
    if (
      (grant.mode === "approval" ||
        action.kind === "issue.edit" ||
        action.kind === "pr.edit") &&
      !approved
    )
      throw new Error("Exact material approval required");
    if (action.kind === "pr.merge" && policy.mode !== "through-merge")
      throw new Error("Project delivery mode forbids merge");
    const source = this.db
      .prepare("SELECT readiness FROM project_github_sources WHERE projectId=?")
      .get(binding.projectId) as { readiness: string } | undefined;
    if (source) {
      const readiness = z
        .object({
          conditions: z.array(
            z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("label"), name: identity }),
              z.object({
                kind: z.literal("project-field"),
                projectNodeId: identity,
                fieldNodeId: identity,
                optionNodeId: identity,
              }),
            ]),
          ),
        })
        .parse(JSON.parse(source.readiness));
      if (
        action.kind === "issue.labels" &&
        readiness.conditions.some(
          (c) =>
            c.kind === "label" &&
            [...action.add, ...action.remove].includes(c.name),
        )
      )
        throw new Error("Agent cannot change readiness labels");
      if (
        action.kind === "project.field" &&
        readiness.conditions.some(
          (c) =>
            c.kind === "project-field" &&
            c.projectNodeId === action.projectNodeId &&
            c.fieldNodeId === action.fieldNodeId,
        )
      )
        throw new Error("Agent cannot change readiness fields");
    }
  }
  recordApprovalContextWithinTransaction(
    interactionId: string,
    caller: DeliveryCaller,
    action: ExternalAction,
  ): void {
    this.db
      .prepare(
        "INSERT INTO delivery_approval_bindings VALUES (?,?,?,?,?,?,?,?,?,NULL)",
      )
      .run(
        interactionId,
        caller.taskId,
        caller.assignmentId,
        caller.taskVersion,
        caller.assignmentVersion,
        caller.conversationRevision,
        caller.workRevision,
        this.configuration(caller.projectId).version,
        materialDigest(action),
      );
  }
  approvalCurrent(
    interactionId: string,
    caller: DeliveryCaller,
    action: ExternalAction,
    operationId: string,
  ): boolean {
    const row = this.db
      .prepare("SELECT * FROM delivery_approval_bindings WHERE interactionId=?")
      .get(interactionId) as
      | {
          taskId: string;
          assignmentId: string;
          taskVersion: number;
          assignmentVersion: number;
          conversationRevision: number;
          workRevision: number;
          policyVersion: number;
          materialHash: string;
          operationId: string | null;
        }
      | undefined;
    return Boolean(
      row &&
        row.taskId === caller.taskId &&
        row.assignmentId === caller.assignmentId &&
        row.taskVersion === caller.taskVersion &&
        row.assignmentVersion === caller.assignmentVersion &&
        row.conversationRevision === caller.conversationRevision &&
        row.workRevision <= caller.workRevision &&
        row.policyVersion === this.configuration(caller.projectId).version &&
        row.materialHash === materialDigest(action) &&
        (!row.operationId || row.operationId === operationId),
    );
  }
  prepareAction(
    input: unknown,
    caller: DeliveryCaller,
    approved: boolean,
    admission: () => void = () => {},
  ): DeliveryActionRecord {
    const request = externalActionArgumentsSchema.parse(input),
      binding = bindingSchema.parse(caller);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT materialHash FROM delivery_actions WHERE operationId=?",
        )
        .get(request.operationId) as { materialHash: string } | undefined;
      const hash = materialDigest({ request, binding });
      if (prior) {
        if (prior.materialHash !== hash)
          throw new Error(
            "Operation key used with different material or caller",
          );
        return this.action(request.operationId);
      }
      let denied = false;
      try {
        admission();
        this.authorize(request, binding, approved);
        if (this.actionBlockers(binding.taskId).length)
          throw new Error("Task has unresolved external action");
        if (approved && request.approval) {
          if (
            !this.approvalCurrent(
              request.approval.interactionId,
              binding,
              request.action,
              request.operationId,
            )
          )
            throw new Error("Approval is stale or bound to another operation");
          this.db
            .prepare(
              "UPDATE delivery_approval_bindings SET operationId=? WHERE interactionId=? AND (operationId IS NULL OR operationId=?)",
            )
            .run(
              request.operationId,
              request.approval.interactionId,
              request.operationId,
            );
        }
      } catch {
        denied = true;
      }
      const now = Date.now();
      const record: DeliveryActionRecord = {
        operationId: request.operationId,
        request,
        binding,
        policyVersion: this.configuration(binding.projectId).version,
        state: denied ? "denied" : "prepared",
        attempts: 0,
        beforeState: null,
        observation: denied
          ? {
              state: "confirmed-failure",
              reason: "delivery-authority-denied",
              receipt: null,
            }
          : null,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare("INSERT INTO delivery_actions VALUES (?,?,?,?)")
        .run(
          request.operationId,
          binding.taskId,
          hash,
          canonicalMaterial(record),
        );
      return record;
    });
  }
  beginAttempt(
    operationId: string,
    beforeState: Record<string, z.output<ReturnType<typeof z.json>>>,
    validate: () => void = () => {},
  ): DeliveryActionRecord {
    return this.transaction(() => {
      validate();
      const record = this.action(operationId);
      if (
        record.state !== "prepared" &&
        !(
          record.state === "confirmed-failure" &&
          record.observation?.retryable &&
          record.attempts < 3
        )
      )
        throw new Error(
          "Effect cannot be replayed without confirmed no-effect failure",
        );
      record.state = "attempting";
      record.attempts++;
      record.beforeState = beforeState;
      record.updatedAt = Date.now();
      record.observation = null;
      this.db
        .prepare("INSERT INTO delivery_attempts VALUES (?,?,?,NULL)")
        .run(operationId, record.attempts, canonicalMaterial(beforeState));
      this.save(record);
      return record;
    });
  }
  recordObservation(
    operationId: string,
    input: ProviderActionObservation,
  ): DeliveryActionRecord {
    const observation = actionObservationSchema.parse(input);
    return this.transaction(() => {
      const record = this.action(operationId);
      if (record.state === "confirmed-success") return record;
      record.state = observation.state;
      record.observation = observation;
      record.updatedAt = Date.now();
      this.save(record);
      this.db
        .prepare(
          "UPDATE delivery_attempts SET observationJson=? WHERE operationId=? AND attempt=?",
        )
        .run(canonicalMaterial(observation), operationId, record.attempts);
      return record;
    });
  }
  delivery(taskId: string): PrDeliveryBinding | null {
    const row = this.db
      .prepare("SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?")
      .get(taskId) as { recordJson: string } | undefined;
    if (!row) return null;
    try {
      return prBindingSchema.parse(JSON.parse(row.recordJson));
    } catch {
      throw new Error("Invalid persisted PR delivery");
    }
  }
  deliveries(): PrDeliveryBinding[] {
    return (
      this.db
        .prepare("SELECT taskId FROM delivery_pr_bindings ORDER BY rowid")
        .all() as { taskId: string }[]
    ).map((row) => {
      const binding = this.delivery(row.taskId);
      if (!binding) throw new Error("PR delivery disappeared");
      return binding;
    });
  }
  private saveDelivery(binding: PrDeliveryBinding): void {
    this.db
      .prepare(
        "INSERT INTO delivery_pr_bindings VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET recordJson=excluded.recordJson",
      )
      .run(binding.taskId, canonicalMaterial(prBindingSchema.parse(binding)));
  }
  registerPrWithinTransaction(
    caller: DeliveryCaller,
    observation: PrDeliveryObservation,
    leadAssignmentId: string,
  ): PrDeliveryBinding {
    const current = this.delivery(caller.taskId),
      policy = this.configuration(caller.projectId);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_waiting_work VALUES (?,?,?)")
      .run(caller.workId, caller.taskId, leadAssignmentId);
    if (current) {
      if (
        current.observation.nodeId !== observation.nodeId ||
        current.observation.repositoryId !== observation.repositoryId
      )
        throw new Error("Task already has another PR delivery");
      return this.observePrWithinTransaction(caller.taskId, observation)
        .binding;
    }
    const binding: PrDeliveryBinding = {
      taskId: caller.taskId,
      projectId: caller.projectId,
      leadAssignmentId,
      registeredWorkId: caller.workId,
      revision: 1,
      mode: policy.mode,
      observation,
      observationDigest: materialDigest(observation),
      observedAt: Date.now(),
      readError: null,
      settlement: null,
    };
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_observations VALUES (?,?,?,?)")
      .run(
        caller.taskId,
        binding.observationDigest,
        canonicalMaterial(observation),
        Date.now(),
      );
    return binding;
  }
  observePrWithinTransaction(
    taskId: string,
    input: PrDeliveryObservation,
  ): { binding: PrDeliveryBinding; changed: boolean; firstSeen: boolean } {
    const observation = prObservationSchema.parse(input),
      binding = this.delivery(taskId);
    if (!binding) throw new Error("Unknown PR delivery");
    if (
      observation.nodeId !== binding.observation.nodeId ||
      observation.repositoryId !== binding.observation.repositoryId ||
      observation.number !== binding.observation.number
    )
      throw new Error("PR observation identity changed");
    const digest = materialDigest(observation),
      changed = digest !== binding.observationDigest;
    const firstSeen = !this.db
      .prepare(
        "SELECT 1 FROM delivery_observations WHERE taskId=? AND digest=?",
      )
      .get(taskId, digest);
    if (changed || binding.readError) binding.revision++;
    if (
      observation.headSha !== binding.observation.headSha ||
      observation.state !== binding.observation.state ||
      observation.draft !== binding.observation.draft
    )
      binding.settlement = null;
    binding.observation = observation;
    binding.observationDigest = digest;
    binding.observedAt = Date.now();
    binding.readError = null;
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_observations VALUES (?,?,?,?)")
      .run(taskId, digest, canonicalMaterial(observation), Date.now());
    return { binding, changed, firstSeen };
  }
  recordPrReadFailure(taskId: string): void {
    this.transaction(() => {
      const binding = this.delivery(taskId);
      if (!binding) return;
      if (binding.readError !== "provider-read-unavailable") binding.revision++;
      binding.readError = "provider-read-unavailable";
      this.saveDelivery(binding);
    });
  }
  settlementReceipt(command: HandbackSettlement): PrDeliveryBinding | null {
    const row = this.db
      .prepare(
        "SELECT payloadHash,recordJson FROM delivery_settlement_receipts WHERE commandKey=?",
      )
      .get(command.key) as
      | { payloadHash: string; recordJson: string }
      | undefined;
    if (!row) return null;
    if (row.payloadHash !== materialDigest(command))
      throw new Error("Settlement key has different material");
    return prBindingSchema.parse(JSON.parse(row.recordJson));
  }
  settleHandbackWithinTransaction(
    command: HandbackSettlement,
  ): PrDeliveryBinding {
    const binding = this.delivery(command.taskId);
    if (!binding) throw new Error("Unknown PR delivery");
    if (
      binding.mode !== "reviewable-pr" ||
      binding.revision !== command.expectedDeliveryRevision ||
      binding.observation.headSha !== command.expectedHeadSha ||
      binding.readError ||
      this.configuration(binding.projectId).version !==
        command.expectedPolicyVersion
    )
      throw new Error("Handback material changed");
    if (
      command.decision === "accepted" &&
      (binding.observation.draft || binding.observation.state === "CLOSED")
    )
      throw new Error("PR is not reviewable");
    binding.revision++;
    binding.settlement = {
      key: command.key,
      decision: command.decision,
      headSha: command.expectedHeadSha,
      taskVersion: command.expectedTaskVersion,
      policyVersion: command.expectedPolicyVersion,
      createdAt: Date.now(),
    };
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT INTO delivery_settlement_receipts VALUES (?,?,?)")
      .run(command.key, materialDigest(command), canonicalMaterial(binding));
    return binding;
  }
  completionBlockers(taskId: string, taskVersion?: number): string[] {
    const reasons = this.actionBlockers(taskId),
      binding = this.delivery(taskId);
    if (!binding) return reasons;
    if (binding.readError) reasons.push("delivery-provider-read-unavailable");
    const policy = this.configuration(binding.projectId);
    if (binding.mode !== policy.mode) reasons.push("delivery-mode-changed");
    if (binding.observation.merged) return reasons;
    if (binding.mode === "through-merge")
      reasons.push("pr-not-confirmed-merged");
    else if (
      !binding.settlement ||
      binding.settlement.headSha !== binding.observation.headSha ||
      binding.settlement.policyVersion !== policy.version ||
      (taskVersion !== undefined &&
        binding.settlement.taskVersion !== taskVersion)
    )
      reasons.push("reviewable-pr-awaiting-current-settlement");
    return [...new Set(reasons)];
  }
  publicTask(taskId: string) {
    const task = this.db
      .prepare("SELECT projectId,version FROM domain_tasks WHERE id=?")
      .get(taskId) as { projectId: string; version: number } | undefined;
    if (!task) throw new Error("Unknown task");
    const configuration = this.publicConfiguration(task.projectId);
    const sourceRow = this.db
      .prepare(
        "SELECT nodeId,repositoryId,issueNumber,observedState,labels FROM github_external_issues WHERE taskId=?",
      )
      .get(taskId);
    const issue = sourceRow
      ? z
          .object({
            nodeId: identity,
            repositoryId: identity,
            issueNumber: z.number().int().positive(),
            observedState: z.enum(["open", "closed"]),
            labels: z.string(),
          })
          .parse(sourceRow)
      : null;
    const projectFields = issue
      ? this.db
          .prepare(
            "SELECT projectFields FROM github_memberships WHERE projectId=? AND nodeId=?",
          )
          .all(task.projectId, issue.nodeId)
          .flatMap((row) =>
            z
              .array(
                z
                  .object({
                    projectNodeId: identity,
                    fieldNodeId: identity,
                    optionNodeId: identity,
                  })
                  .strict(),
              )
              .parse(
                JSON.parse(
                  z.object({ projectFields: z.string() }).parse(row)
                    .projectFields,
                ),
              ),
          )
      : [];
    return {
      issueObservation: issue
        ? {
            ...issue,
            labels: z.array(identity).parse(JSON.parse(issue.labels)),
          }
        : null,
      projectFieldObservations: projectFields,
      policyVersion: configuration.version,
      mode: configuration.mode,
      binding: this.delivery(taskId),
      blockers: this.completionBlockers(taskId, task.version),
      actions: this.actions(taskId).map((a) => ({
        operationId: a.operationId,
        kind: a.request.action.kind,
        target: a.request.action.target,
        state: a.state,
        attempts: a.attempts,
        reason: a.observation?.reason ?? null,
        receipt: a.observation?.receipt ?? null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    };
  }
  ownsConfirmedClosure(taskId: string, nodeId: string): boolean {
    return this.actions(taskId).some(
      (a) =>
        a.state === "confirmed-success" &&
        ((a.request.action.kind === "issue.close" &&
          a.request.action.target.nodeId === nodeId &&
          a.observation?.receipt?.issueClosed === true &&
          a.beforeState?.state === "open") ||
          (a.request.action.kind === "pr.merge" &&
            a.observation?.receipt?.merged === true &&
            this.delivery(taskId)?.observation.nodeId ===
              a.request.action.target.nodeId &&
            this.delivery(taskId)?.observation.closedIssueNodeIds.includes(
              nodeId,
            ))),
    );
  }
  hasWaitingPr(workId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM delivery_waiting_work WHERE workId=?")
        .get(workId),
    );
  }
  configuration(projectId: string): DeliveryPolicy {
    const row = this.db
      .prepare(
        "SELECT version, policyJson FROM delivery_policies WHERE projectId = ?",
      )
      .get(z.string().uuid().parse(projectId)) as
      | { version: number; policyJson: string }
      | undefined;
    if (!row)
      return {
        version: 1,
        mode: "reviewable-pr",
        credentialRef: null,
        grants: [],
        requiredChecks: [],
      };
    try {
      return {
        ...deliveryPolicySchema.parse(JSON.parse(row.policyJson)),
        version: z.number().int().positive().parse(row.version),
      };
    } catch {
      throw new Error("Invalid persisted delivery policy");
    }
  }
  publicConfiguration(projectId: string) {
    const { credentialRef, ...policy } = this.configuration(projectId);
    return { ...policy, credentialConfigured: credentialRef !== null };
  }
  configureWithinTransaction(
    projectId: string,
    expectedVersion: number,
    input: unknown,
  ) {
    const current = this.configuration(projectId);
    if (current.version !== expectedVersion)
      throw new Error("Version conflict: delivery policy changed");
    const policy = deliveryPolicySchema.parse(input);
    for (const grant of policy.grants) {
      if (
        grant.action === "project.field" &&
        (!grant.projectNodeId ||
          !grant.fieldNodeId ||
          !grant.optionNodeIds?.length)
      )
        throw new Error("Project field grant requires exact field and options");
    }
    this.db
      .prepare(
        "INSERT INTO delivery_policies VALUES (?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET version=excluded.version, policyJson=excluded.policyJson",
      )
      .run(projectId, current.version + 1, canonicalMaterial(policy));
    return this.publicConfiguration(projectId);
  }
}
