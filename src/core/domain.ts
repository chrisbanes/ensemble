import { TaskReviewStore } from "./task-review.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./store.js";
import { DeliveryStore, deliveryPolicySchema } from "./delivery.js";
import {
  GitHubSourceStore,
  githubConfigurationSchema,
  linkedRepositorySchema,
  readinessSchema,
  selectionSchema,
  verifiedRepository,
  type LinkedRepository,
} from "./github-source.js";

const id = z.string().uuid();
const label = z.string().trim().min(1).max(512);
const prose = z.string().max(16000);
const actor = z.enum(["operator", "agent"]);
const defaultProjectLimit = 2 as const;
const commandBase = { key: id, actor };

const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...commandBase,
      type: z.literal("delivery.configure"),
      projectId: id,
      expectedVersion: z.number().int().positive(),
      ...deliveryPolicySchema.shape,
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("project.create"),
      projectId: id,
      name: label,
      leadProfileId: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("project.configure"),
      projectId: id,
      expectedVersion: z.number().int().positive(),
      name: label.optional(),
      paused: z.boolean().optional(),
      instructions: prose.optional(),
      leadProfileId: id.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("task.create"),
      projectId: id,
      taskId: id,
      title: label,
      outcome: prose,
      ready: z.boolean().default(false),
      blockerTaskIds: z
        .array(id)
        .max(128)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Duplicate dependency",
        )
        .optional(),
      initialAssignment: z
        .object({ assignmentId: id, profileId: id })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("task.configure"),
      projectId: id,
      taskId: id,
      expectedVersion: z.number().int().positive(),
      title: label.optional(),
      outcome: prose.optional(),
      ready: z.boolean().optional(),
      state: z.enum(["open", "done", "cancelled"]).optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("profile.create"),
      profileId: id,
      name: label,
      instructions: prose,
      capabilities: prose,
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("profile.configure"),
      profileId: id,
      expectedVersion: z.number().int().positive(),
      name: label.optional(),
      instructions: prose.optional(),
      capabilities: prose.optional(),
      revoked: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("routing.configure"),
      projectId: id,
      expectedVersion: z.number().int().positive(),
      enabled: z.boolean(),
      guidance: prose,
      credentialRef: z
        .string()
        .regex(/^env:[A-Z][A-Z0-9_]*$/)
        .nullable()
        .optional(),
      candidateProfileIds: z.array(id),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("github.configure"),
      projectId: id,
      expectedVersion: z.number().int().positive(),
      ...githubConfigurationSchema.shape,
      credentialRef: githubConfigurationSchema.shape.credentialRef.optional(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("github.activate"),
      projectId: id,
      selectionId: label,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("github.place"),
      projectId: id,
      taskId: id,
      chosenProjectId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("source.review"),
      projectId: id,
      taskId: id,
      expectedVersion: z.number().int().positive(),
      observedDigest: z.string().regex(/^[0-9a-f]{64}$/),
      decision: z.enum([
        "clarification",
        "accept-revised-scope",
        "resume-source-hold",
      ]),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("assignment.create"),
      projectId: id,
      taskId: id,
      assignmentId: id,
      profileId: id,
      brief: prose,
      resultDestination: label,
      requesterAssignmentId: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("assignment.apply"),
      projectId: id,
      assignmentId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("dependency.add"),
      projectId: id,
      taskId: id,
      blockerTaskId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("dependency.remove"),
      projectId: id,
      taskId: id,
      blockerTaskId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("imported-blockers.set"),
      projectId: id,
      taskId: id,
      expectedVersion: z.number().int().positive(),
      state: z.enum(["clear", "blocked", "unknown"]),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("capacity.configure"),
      globalLimit: z.number().int().positive(),
      projectOverrides: z
        .record(id, z.number().int().positive().nullable())
        .default({}),
    })
    .strict(),
]);

function parseCommand(input: unknown) {
  const command = commandSchema.parse(input);
  if (
    command.type === "github.configure" &&
    command.credentialRef === undefined
  )
    delete command.credentialRef;
  return command;
}

export type DomainCommand = z.input<typeof commandSchema>;
export class DomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainConflictError";
  }
}

export class DomainPolicyError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid-input",
    message: string,
  ) {
    super(message);
    this.name = "DomainPolicyError";
  }
}

export type CapacityConfigureCommand = Extract<
  DomainCommand,
  { type: "capacity.configure" }
>;
export interface CapacityLimits {
  globalLimit: number;
  defaultProjectLimit: 2;
  projectOverrides: Record<string, number>;
  currentUsage: { global: number; projects: Record<string, number> };
  effectiveProjectLimits: Record<string, number>;
}
type ParsedCommand = z.output<typeof commandSchema>;
type Row = Record<string, string | number | null>;

function present(row: Row, key: string): string | number | null {
  const value = row[key];
  if (value === undefined) throw new Error(`Missing persisted column ${key}`);
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Durable S04a command and read boundary. All commands use one SQLite transaction. */
export class DomainStore {
  constructor(
    private readonly db: Database,
    private readonly onChange?: () => void,
    private readonly verifyRepository: typeof verifiedRepository = verifiedRepository,
  ) {}

  migrate(): void {
    new TaskReviewStore(this.db).migrate();
    new DeliveryStore(this.db).migrate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS domain_schema (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS domain_projects (
          id TEXT PRIMARY KEY REFERENCES projects(id), name TEXT NOT NULL,
          version INTEGER NOT NULL, paused INTEGER NOT NULL CHECK(paused IN (0,1)),
          leadProfileId TEXT, instructionsRevision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_instruction_revisions (
          projectId TEXT NOT NULL REFERENCES domain_projects(id), revision INTEGER NOT NULL,
          instructions TEXT NOT NULL, PRIMARY KEY(projectId, revision)
        );
        CREATE TABLE IF NOT EXISTS domain_tasks (
          id TEXT PRIMARY KEY REFERENCES tasks(id), projectId TEXT NOT NULL REFERENCES domain_projects(id),
          version INTEGER NOT NULL, outcome TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)),
          state TEXT NOT NULL CHECK(state IN ('open','done','cancelled')),
          importedBlockers TEXT NOT NULL CHECK(importedBlockers IN ('clear','blocked','unknown'))
        );
        CREATE TABLE IF NOT EXISTS profiles (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL,
          instructions TEXT NOT NULL, capabilities TEXT NOT NULL,
          revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS profile_revisions (
          profileId TEXT NOT NULL REFERENCES profiles(id), revision INTEGER NOT NULL,
          name TEXT NOT NULL, instructions TEXT NOT NULL, capabilities TEXT NOT NULL,
          revoked INTEGER NOT NULL, PRIMARY KEY(profileId, revision)
        );
        CREATE TABLE IF NOT EXISTS project_routing (
          projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), guidance TEXT NOT NULL,
          credentialRef TEXT, candidateProfileIds TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_github_sources (
          projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
          credentialRef TEXT, selections TEXT NOT NULL, readiness TEXT NOT NULL,
          repositories TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_github_active (
          projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
          configVersion INTEGER NOT NULL, PRIMARY KEY(projectId, selectionId)
        );
        CREATE TABLE IF NOT EXISTS github_imported_tasks (
          taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
          providerInstance TEXT NOT NULL CHECK(providerInstance = 'github.com'),
          nodeId TEXT NOT NULL, repositoryId TEXT NOT NULL,
          UNIQUE(providerInstance, nodeId)
        );
        CREATE TABLE IF NOT EXISTS github_issue_status (
          nodeId TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('open','closed','unknown')),
          reason TEXT, refreshedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS domain_assignments (
          id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
          projectId TEXT NOT NULL REFERENCES domain_projects(id), version INTEGER NOT NULL,
          profileId TEXT NOT NULL REFERENCES profiles(id), profileRevision INTEGER NOT NULL,
          instructionsRevision INTEGER NOT NULL, brief TEXT NOT NULL,
          resultDestination TEXT NOT NULL, requesterAssignmentId TEXT,
          resultRecipientAssignmentId TEXT,
          resultRecipientDisposition TEXT NOT NULL DEFAULT 'unresolved'
            CHECK(resultRecipientDisposition IN ('resolved','unresolved')),
          state TEXT NOT NULL CHECK(state IN ('pending','running','completed','held'))
        );
        CREATE TABLE IF NOT EXISTS task_lead_bindings (
          taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
          projectId TEXT NOT NULL REFERENCES domain_projects(id),
          profileId TEXT NOT NULL REFERENCES profiles(id),
          profileRevision INTEGER NOT NULL,
          instructionsRevision INTEGER NOT NULL,
          assignmentId TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS local_dependencies (
          taskId TEXT NOT NULL REFERENCES domain_tasks(id), blockerTaskId TEXT NOT NULL REFERENCES domain_tasks(id),
          PRIMARY KEY(taskId, blockerTaskId), CHECK(taskId != blockerTaskId)
        );
        CREATE TABLE IF NOT EXISTS command_receipts (
          scope TEXT NOT NULL, key TEXT NOT NULL, payloadHash TEXT NOT NULL,
          result TEXT NOT NULL, PRIMARY KEY(scope, key)
        );
        CREATE TABLE IF NOT EXISTS scheduler_capacity_limits (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          globalLimit INTEGER NOT NULL CHECK(globalLimit > 0)
        );
        CREATE TABLE IF NOT EXISTS scheduler_project_capacity_limits (
          projectId TEXT PRIMARY KEY REFERENCES domain_projects(id),
          projectLimit INTEGER NOT NULL CHECK(projectLimit > 0)
        );
        CREATE TABLE IF NOT EXISTS routing_operations (
          id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES domain_projects(id),
          taskId TEXT NOT NULL REFERENCES domain_tasks(id), taskVersion INTEGER NOT NULL,
          assignmentId TEXT, candidateRevisions TEXT NOT NULL,
          guidanceRevision INTEGER NOT NULL, model TEXT NOT NULL,
          question TEXT NOT NULL, judgment TEXT, disposition TEXT NOT NULL,
          resultDestination TEXT NOT NULL, brief TEXT NOT NULL,
          payloadHash TEXT NOT NULL,
          UNIQUE(projectId, taskId, taskVersion)
        );`);
      const version = this.db
        .prepare("SELECT version FROM domain_schema")
        .get() as Row | undefined;
      if (
        version &&
        version.version !== 1 &&
        version.version !== 2 &&
        version.version !== 3
      )
        throw new Error("Unsupported domain schema version");
      const assignmentColumns = this.db
        .prepare("PRAGMA table_info(domain_assignments)")
        .all() as Row[];
      if (
        !assignmentColumns.some(
          (column) => column.name === "resultRecipientAssignmentId",
        )
      )
        this.db.exec(
          "ALTER TABLE domain_assignments ADD COLUMN resultRecipientAssignmentId TEXT",
        );
      const routingColumns = this.db
        .prepare("PRAGMA table_info(routing_operations)")
        .all() as Row[];
      if (!routingColumns.some((column) => column.name === "brief"))
        this.db.exec(
          "ALTER TABLE routing_operations ADD COLUMN brief TEXT NOT NULL DEFAULT ''",
        );
      if (
        !assignmentColumns.some(
          (column) => column.name === "resultRecipientDisposition",
        )
      )
        this.db.exec(
          "ALTER TABLE domain_assignments ADD COLUMN resultRecipientDisposition TEXT NOT NULL DEFAULT 'unresolved' CHECK(resultRecipientDisposition IN ('resolved','unresolved'))",
        );
      if (!version || version.version === 1) {
        this.db.exec(
          "UPDATE domain_assignments\n" +
            "SET resultRecipientAssignmentId = requesterAssignmentId\n" +
            "WHERE requesterAssignmentId IS NOT NULL\n" +
            "AND EXISTS (SELECT 1 FROM domain_assignments requester\n" +
            "WHERE requester.id = domain_assignments.requesterAssignmentId\n" +
            "AND requester.taskId = domain_assignments.taskId);\n" +
            "UPDATE domain_assignments\n" +
            "SET resultRecipientAssignmentId = resultDestination\n" +
            "WHERE resultRecipientAssignmentId IS NULL\n" +
            "AND resultDestination <> 'lead'\n" +
            "AND EXISTS (SELECT 1 FROM domain_assignments recipient\n" +
            "WHERE recipient.id = domain_assignments.resultDestination\n" +
            "AND recipient.taskId = domain_assignments.taskId);\n" +
            "UPDATE domain_assignments\n" +
            "SET resultRecipientAssignmentId = (SELECT binding.assignmentId\n" +
            "FROM task_lead_bindings binding WHERE binding.taskId = domain_assignments.taskId\n" +
            "AND binding.projectId = domain_assignments.projectId)\n" +
            "WHERE resultRecipientAssignmentId IS NULL AND resultDestination = 'lead';\n" +
            "UPDATE domain_assignments SET resultRecipientDisposition = CASE\n" +
            "WHEN resultRecipientAssignmentId IS NOT NULL THEN 'resolved' ELSE 'unresolved' END;\n" +
            "UPDATE domain_schema SET version = 2",
        );
        if (!version)
          this.db
            .prepare("INSERT INTO domain_schema (version) VALUES (2)")
            .run();
      }
      if (!version || Number(version.version) < 3) {
        this.db.exec(`UPDATE routing_operations
          SET brief = COALESCE((SELECT outcome FROM domain_tasks
            WHERE domain_tasks.id = routing_operations.taskId), '')
          WHERE brief = '';
          UPDATE domain_schema SET version = 3`);
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO scheduler_capacity_limits (singleton, globalLimit) VALUES (1, 4)",
        )
        .run();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO project_github_sources (projectId, version, credentialRef, selections, readiness, repositories) SELECT id, 1, NULL, '[]', ?, '[]' FROM domain_projects",
        )
        .run(
          JSON.stringify({
            mode: "all",
            conditions: [{ kind: "label", name: "ready" }],
          }),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  execute(input: DomainCommand): unknown {
    const command = parseCommand(input);
    if (
      command.type === "github.configure" &&
      command.repositories.length > 0
    ) {
      const hash = createHash("sha256")
        .update(canonical(command))
        .digest("hex");
      const prior = this.one(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
        command.projectId,
        command.key,
      );
      if (prior) {
        if (prior.payloadHash !== hash)
          throw new DomainConflictError(
            "Command key already used with different payload",
          );
        return JSON.parse(String(prior.result));
      }
      throw new Error(
        "Linked GitHub configuration requires asynchronous verification",
      );
    }
    return this.executeParsed(command);
  }

  async configureGitHub(
    input: Extract<DomainCommand, { type: "github.configure" }>,
  ): Promise<unknown> {
    const command = parseCommand(input);
    if (command.type !== "github.configure")
      throw new Error("Expected GitHub configuration");
    const hash = createHash("sha256").update(canonical(command)).digest("hex");
    const prior = this.one(
      "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      command.projectId,
      command.key,
    );
    if (prior) {
      if (prior.payloadHash !== hash)
        throw new DomainConflictError(
          "Command key already used with different payload",
        );
      return JSON.parse(String(prior.result));
    }
    this.operator(command);
    this.version(
      { version: this.githubConfiguration(command.projectId).version },
      command.expectedVersion,
    );
    let verified: LinkedRepository[];
    try {
      verified = await Promise.all(
        command.repositories.map((link) => this.verifyRepository(link)),
      );
    } catch {
      throw new DomainPolicyError(
        "invalid-input",
        "Repository verification failed",
      );
    }
    return this.executeParsed(command, verified);
  }

  recordedCommand(input: DomainCommand): unknown | undefined {
    const command = parseCommand(input);
    this.operator(command);
    const scope =
      "projectId" in command
        ? command.projectId
        : "profileId" in command
          ? `profile:${command.profileId}`
          : "system:capacity";
    const hash = createHash("sha256").update(canonical(command)).digest("hex");
    const receipt = this.one(
      "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      scope,
      command.key,
    );
    if (!receipt) return undefined;
    if (receipt.payloadHash !== hash)
      throw new DomainConflictError(
        "Command key already used with different payload",
      );
    return JSON.parse(String(receipt.result));
  }

  private executeParsed(
    command: ParsedCommand,
    verifiedRepositories?: LinkedRepository[],
  ): unknown {
    const scope =
      "projectId" in command
        ? command.projectId
        : "profileId" in command
          ? `profile:${command.profileId}`
          : "system:capacity";
    const hash = createHash("sha256").update(canonical(command)).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const receipt = this.one(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
        scope,
        command.key,
      );
      if (receipt) {
        if (receipt.payloadHash !== hash)
          throw new DomainConflictError(
            "Command key already used with different payload",
          );
        this.db.exec("COMMIT");
        committed = true;
        return JSON.parse(String(receipt.result));
      }
      const result = this.apply(command, verifiedRepositories);
      const review = new TaskReviewStore(this.db);
      if (
        command.type === "task.create" ||
        (command.type === "task.configure" &&
          !this.importedTask(command.taskId) &&
          (command.title !== undefined || command.outcome !== undefined))
      )
        review.captureSource(command.taskId);
      if (command.type === "assignment.create")
        review.captureAssignment(
          command.assignmentId,
          command.requesterAssignmentId
            ? `assignment:${command.requesterAssignmentId}`
            : command.actor,
        );
      if (command.type === "task.create" && command.initialAssignment)
        review.captureAssignment(
          command.initialAssignment.assignmentId,
          command.actor,
        );
      this.db
        .prepare(
          "INSERT INTO command_receipts (scope, key, payloadHash, result) VALUES (?, ?, ?, ?)",
        )
        .run(scope, command.key, hash, JSON.stringify(result));
      this.db.exec("COMMIT");
      committed = true;
      this.onChange?.();
      return result;
    } catch (error) {
      if (committed)
        throw new Error("Command committed but change notification failed", {
          cause: error,
        });
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  project(projectId: string): Row {
    return this.required(
      "SELECT p.id, p.name, p.version, p.paused, p.leadProfileId, p.instructionsRevision, i.instructions FROM domain_projects p JOIN project_instruction_revisions i ON i.projectId = p.id AND i.revision = p.instructionsRevision WHERE p.id = ?",
      id.parse(projectId),
    );
  }

  deliveryConfiguration(projectId: string) {
    this.project(projectId);
    return new DeliveryStore(this.db).publicConfiguration(projectId);
  }
  deliveryCredentialReference(projectId: string): string | null {
    this.project(projectId);
    return new DeliveryStore(this.db).configuration(projectId).credentialRef;
  }
  githubConfiguration(projectId: string): {
    version: number;
    credentialRef: string | null;
    selections: z.output<typeof selectionSchema>[];
    readiness: z.output<typeof readinessSchema>;
    repositories: LinkedRepository[];
  } {
    this.project(projectId);
    const row = this.required(
      "SELECT version, credentialRef, selections, readiness, repositories FROM project_github_sources WHERE projectId = ?",
      id.parse(projectId),
    );
    return {
      version: Number(row.version),
      credentialRef:
        row.credentialRef === null ? null : String(row.credentialRef),
      selections: z
        .array(selectionSchema)
        .parse(JSON.parse(String(row.selections))),
      readiness: readinessSchema.parse(JSON.parse(String(row.readiness))),
      repositories: z
        .array(linkedRepositorySchema)
        .parse(JSON.parse(String(row.repositories))),
    };
  }

  markImportedTask(taskId: string, nodeId: string, repositoryId: string): void {
    this.task(taskId);
    this.db
      .prepare(
        "INSERT INTO github_imported_tasks (taskId, providerInstance, nodeId, repositoryId) VALUES (?, 'github.com', ?, ?)",
      )
      .run(id.parse(taskId), label.parse(nodeId), label.parse(repositoryId));
  }

  importedTask(taskId: string): Row | undefined {
    return this.one(
      "SELECT taskId, providerInstance, nodeId, repositoryId FROM github_imported_tasks WHERE taskId = ?",
      id.parse(taskId),
    );
  }

  githubActiveSelectionIds(projectId: string): string[] {
    const config = this.githubConfiguration(projectId);
    return (
      this.db
        .prepare(
          "SELECT selectionId FROM project_github_active WHERE projectId = ? AND configVersion = ? ORDER BY selectionId",
        )
        .all(id.parse(projectId), config.version) as Row[]
    ).map((row) => String(row.selectionId));
  }

  capacityLimits(projectIds: string[] = []): CapacityLimits {
    const config = this.required(
      "SELECT globalLimit FROM scheduler_capacity_limits WHERE singleton = 1",
    );
    const projectOverrides: Record<string, number> = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT projectId, projectLimit FROM scheduler_project_capacity_limits ORDER BY projectId",
          )
          .all() as Row[]
      ).map((row) => [String(row.projectId), Number(row.projectLimit)]),
    );
    const effectiveProjectLimits: Record<string, number> = {};
    for (const projectId of new Set(
      projectIds.map((value) => id.parse(value)),
    )) {
      this.project(projectId);
      effectiveProjectLimits[projectId] =
        projectOverrides[projectId] ?? defaultProjectLimit;
    }

    const currentUsage = { global: 0, projects: {} as Record<string, number> };
    if (
      this.one(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'execution_capacity_reservations'",
      )
    ) {
      const reservations = this.db
        .prepare(
          "SELECT projectId, COUNT(*) AS count FROM execution_capacity_reservations GROUP BY projectId",
        )
        .all() as Row[];
      for (const row of reservations) {
        const count = Number(row.count);
        currentUsage.global += count;
        if (row.projectId !== null)
          currentUsage.projects[String(row.projectId)] = count;
      }
    }
    return {
      globalLimit: Number(config.globalLimit),
      defaultProjectLimit,
      projectOverrides,
      currentUsage,
      effectiveProjectLimits,
    };
  }

  projects(): Row[] {
    return this.db
      .prepare(
        "SELECT p.id, p.name, p.version, p.paused, p.leadProfileId, p.instructionsRevision, i.instructions FROM domain_projects p JOIN project_instruction_revisions i ON i.projectId = p.id AND i.revision = p.instructionsRevision ORDER BY p.name",
      )
      .all() as Row[];
  }

  /** Bounded catalog membership only; policy-bearing rows are projected separately. */
  taskCatalog(): { id: string; projectId: string }[] {
    return this.db
      .prepare(
        "SELECT t.id, t.projectId FROM domain_tasks t JOIN tasks base ON base.id=t.id ORDER BY t.id LIMIT 10001",
      )
      .all() as { id: string; projectId: string }[];
  }

  tasks(projectId: string): Row[] {
    return this.db
      .prepare(
        "SELECT t.id, t.projectId, t.version, t.outcome, t.ready, t.state, t.importedBlockers, base.title FROM domain_tasks t JOIN tasks base ON base.id = t.id WHERE t.projectId = ? ORDER BY base.title",
      )
      .all(id.parse(projectId)) as Row[];
  }

  profiles(): Row[] {
    return this.db
      .prepare(
        "SELECT id, version, name, capabilities, revoked FROM profiles ORDER BY name",
      )
      .all() as Row[];
  }

  assignments(taskId: string): Row[] {
    return this.db
      .prepare(
        "SELECT id, taskId, projectId, version, profileId, profileRevision, instructionsRevision, brief, resultDestination, requesterAssignmentId, resultRecipientAssignmentId, resultRecipientDisposition, state FROM domain_assignments WHERE taskId = ? ORDER BY rowid",
      )
      .all(id.parse(taskId)) as Row[];
  }

  pendingAssignments(): Row[] {
    return this.db
      .prepare(
        "SELECT id, taskId, projectId, version, profileId, profileRevision, " +
          "instructionsRevision, brief, resultDestination, requesterAssignmentId, " +
          "resultRecipientAssignmentId, resultRecipientDisposition, state " +
          "FROM domain_assignments WHERE state = 'pending' ORDER BY rowid",
      )
      .all() as Row[];
  }

  readyTasksWithLead(): Row[] {
    return this.db
      .prepare(`SELECT t.id, t.projectId, t.version, p.leadProfileId
        FROM domain_tasks t JOIN domain_projects p ON p.id = t.projectId
        WHERE t.ready = 1 AND t.state = 'open' AND p.leadProfileId IS NOT NULL
        ORDER BY t.rowid`)
      .all() as Row[];
  }

  leadBindings(): Row[] {
    return this.db
      .prepare(`SELECT taskId, projectId, profileId, profileRevision,
        instructionsRevision, assignmentId FROM task_lead_bindings ORDER BY rowid`)
      .all() as Row[];
  }

  ensureLeadBinding(taskId: string): Row | undefined {
    const key = id.parse(taskId);
    const existing = this.db
      .prepare("SELECT * FROM task_lead_bindings WHERE taskId = ?")
      .get(key) as Row | undefined;
    if (existing) return existing;
    const task = this.task(key);
    const project = this.project(String(task.projectId));
    const leadProfileId = present(project, "leadProfileId");
    if (!leadProfileId) return undefined;
    const profile = this.activeProfile(String(leadProfileId));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT OR IGNORE INTO task_lead_bindings
          (taskId, projectId, profileId, profileRevision, instructionsRevision, assignmentId)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          key,
          present(task, "projectId"),
          leadProfileId,
          present(profile, "version"),
          present(project, "instructionsRevision"),
          randomUUID(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.db
      .prepare("SELECT * FROM task_lead_bindings WHERE taskId = ?")
      .get(key) as Row;
  }

  ensureLeadAssignment(taskId: string): Row | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assignment = this.ensureLeadAssignmentWithinTransaction(
        id.parse(taskId),
      );
      this.db.exec("COMMIT");
      return assignment;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  task(taskId: string): Row {
    return this.required(
      "SELECT t.id, t.projectId, t.version, t.outcome, t.ready, t.state, t.importedBlockers, base.title FROM domain_tasks t JOIN tasks base ON base.id = t.id WHERE t.id = ?",
      id.parse(taskId),
    );
  }

  profile(profileId: string): Row {
    return this.required(
      "SELECT id, version, name, instructions, capabilities, revoked FROM profiles WHERE id = ?",
      id.parse(profileId),
    );
  }

  assignment(assignmentId: string): Row {
    return this.required(
      "SELECT * FROM domain_assignments WHERE id = ?",
      id.parse(assignmentId),
    );
  }

  instructionRevision(projectId: string, revision: number): string {
    return String(
      this.required(
        "SELECT instructions FROM project_instruction_revisions WHERE projectId = ? AND revision = ?",
        id.parse(projectId),
        revision,
      ).instructions,
    );
  }

  profileRevision(profileId: string, revision: number): Row {
    return this.required(
      "SELECT profileId, revision, name, instructions, capabilities, revoked FROM profile_revisions WHERE profileId = ? AND revision = ?",
      id.parse(profileId),
      revision,
    );
  }

  assignmentAdmission(assignmentId: string): {
    eligible: boolean;
    reasons: string[];
  };
  assignmentAdmission(
    assignmentId: string,
    expected: {
      taskVersion: number;
      assignmentVersion: number;
      instructionsRevision: number;
      profileRevision: number;
    },
  ): {
    eligible: boolean;
    reasons: string[];
  };
  assignmentAdmission(
    assignmentId: string,
    expected?: {
      taskVersion: number;
      assignmentVersion: number;
      instructionsRevision: number;
      profileRevision: number;
    },
  ): {
    eligible: boolean;
    reasons: string[];
  } {
    const assignment = this.assignment(assignmentId);
    const isLead = this.leadBindings().some(
      (b) => b.taskId === assignment.taskId && b.assignmentId === assignment.id,
    );
    const admission = this.admission(String(assignment.taskId), isLead);
    const reasons = [...admission.reasons];
    const profile = this.profile(String(assignment.profileId));
    const project = this.project(String(assignment.projectId));
    const routing = this.routing(String(assignment.projectId));
    const permitted = z
      .array(id)
      .parse(JSON.parse(String(routing.candidateProfileIds))) as string[];
    if (profile.revoked) reasons.push("profile-revoked");
    if (Number(assignment.profileRevision) !== Number(profile.version))
      reasons.push("assignment-profile-revision-stale");
    if (
      Number(assignment.instructionsRevision) !==
      Number(project.instructionsRevision)
    )
      reasons.push("assignment-instructions-revision-stale");
    if (
      project.leadProfileId !== assignment.profileId &&
      !permitted.includes(String(assignment.profileId))
    )
      reasons.push("profile-not-permitted");
    if (assignment.state === "held") reasons.push("assignment-held");
    if (assignment.state === "completed") reasons.push("assignment-completed");
    if (expected) {
      if (Number(assignment.version) !== expected.assignmentVersion)
        reasons.push("assignment-revision-changed");
      if (
        Number(assignment.instructionsRevision) !==
        expected.instructionsRevision
      )
        reasons.push("assignment-instructions-changed");
      if (Number(assignment.profileRevision) !== expected.profileRevision)
        reasons.push("assignment-profile-changed");
      if (
        Number(this.task(String(assignment.taskId)).version) !==
        expected.taskVersion
      )
        reasons.push("task-revision-changed");
    }
    return { eligible: reasons.length === 0, reasons };
  }

  routing(projectId: string): Row {
    const row = this.required(
      "SELECT projectId, version, enabled, guidance, credentialRef, candidateProfileIds FROM project_routing WHERE projectId = ?",
      id.parse(projectId),
    );
    return {
      projectId: present(row, "projectId"),
      version: present(row, "version"),
      enabled: present(row, "enabled"),
      guidance: present(row, "guidance"),
      credentialAvailable: row.credentialRef === null ? 0 : 1,
      candidateProfileIds: present(row, "candidateProfileIds"),
    };
  }

  /** Internal credential reference for the TypeSafe adapter; never part of routing(). */
  routingCredentialReference(projectId: string): string | null {
    const row = this.required(
      "SELECT credentialRef FROM project_routing WHERE projectId = ?",
      id.parse(projectId),
    );
    return row.credentialRef === null ? null : String(row.credentialRef);
  }

  routingCandidates(projectId: string): Row[] {
    const configured = JSON.parse(
      String(this.routing(projectId).candidateProfileIds),
    ) as unknown;
    return z
      .array(id)
      .parse(configured)
      .map((profileId) => this.profile(profileId))
      .filter((profile) => Number(profile.revoked) === 0)
      .map((profile) => ({
        profileId: present(profile, "id"),
        name: present(profile, "name"),
        capabilities: present(profile, "capabilities"),
        profileRevision: present(profile, "version"),
      }));
  }

  routingOperations(taskId?: string): Row[] {
    const sql =
      "SELECT id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, " +
      "guidanceRevision, model, question, judgment, disposition, resultDestination, brief " +
      "FROM routing_operations" +
      (taskId ? " WHERE taskId = ?" : "") +
      " ORDER BY rowid";
    return (
      taskId
        ? this.db.prepare(sql).all(id.parse(taskId))
        : this.db.prepare(sql).all()
    ) as Row[];
  }

  dependencies(taskId: string): string[] {
    return this.db
      .prepare(
        "SELECT blockerTaskId FROM local_dependencies WHERE taskId = ? ORDER BY blockerTaskId",
      )
      .all(id.parse(taskId))
      .map((row) => String((row as Row).blockerTaskId));
  }

  hasOwnDeliveryClosure(taskId: string): boolean {
    if (
      !this.one(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='github_external_issues'",
      )
    )
      return false;
    const external = this.one(
      "SELECT nodeId,observedState FROM github_external_issues WHERE taskId=?",
      taskId,
    );
    return (
      external?.observedState === "closed" &&
      !!this.one(
        "SELECT 1 AS present FROM github_delivery_closures WHERE nodeId=?",
        String(external.nodeId),
      ) &&
      new DeliveryStore(this.db).ownsConfirmedClosure(
        taskId,
        String(external.nodeId),
      )
    );
  }
  admission(
    taskId: string,
    deliveryContinuation = false,
  ): { eligible: boolean; reasons: string[] } {
    const task = this.task(taskId);
    const project = this.project(String(task.projectId));
    const reasons: string[] = [
      ...new DeliveryStore(this.db).actionBlockers(taskId),
    ];
    if (project.paused) reasons.push("project-paused");
    const lead = project.leadProfileId
      ? this.one(
          "SELECT revoked FROM profiles WHERE id = ?",
          String(project.leadProfileId),
        )
      : undefined;
    if (!lead) reasons.push("project-lead-unconfigured");
    else if (lead.revoked) reasons.push("project-lead-revoked");
    const ownClosure =
      deliveryContinuation && this.hasOwnDeliveryClosure(taskId);
    if (!task.ready && !ownClosure) reasons.push("task-unready");
    if (task.state !== "open") reasons.push("task-not-open");
    if (task.importedBlockers !== "clear")
      reasons.push(`imported-blockers-${task.importedBlockers}`);
    const imported = this.importedTask(taskId);
    if (imported) {
      const sourceTables = this.one(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'github_external_issues'",
      );
      if (!sourceTables) reasons.push("source-unknown");
      else {
        const external = this.one(
          "SELECT nodeId FROM github_external_issues WHERE taskId = ?",
          taskId,
        );
        if (!external) reasons.push("source-unknown");
        else {
          const review = this.one(
            "SELECT observedDigest, acceptedDigest FROM github_source_reviews WHERE nodeId = ?",
            String(external.nodeId),
          );
          if (review && review.observedDigest !== review.acceptedDigest)
            reasons.push("source-review-required");
          if (
            this.one(
              "SELECT 1 AS active FROM github_source_holds WHERE nodeId = ? AND active = 1 AND (?=0 OR reason<>'closed')",
              String(external.nodeId),
              Number(ownClosure),
            )
          )
            reasons.push("source-hold");
          const memberships = this.db
            .prepare(`SELECT CASE WHEN a.configVersion = c.version THEN s.complete ELSE 0 END AS complete FROM github_memberships m
            LEFT JOIN github_sync_state s ON s.projectId = m.projectId AND s.selectionId = m.selectionId
            LEFT JOIN project_github_active a ON a.projectId = m.projectId AND a.selectionId = m.selectionId
            JOIN project_github_sources c ON c.projectId = m.projectId
            WHERE m.nodeId = ? AND m.projectId = ?`)
            .all(String(external.nodeId), String(task.projectId)) as Row[];
          if (memberships.length === 0) {
            const closureOnlyHold =
              ownClosure &&
              this.one(
                "SELECT 1 AS present FROM github_source_holds WHERE nodeId=? AND active=1 AND reason='closed'",
                String(external.nodeId),
              );
            const config = this.githubConfiguration(String(task.projectId));
            const closureSelection =
              closureOnlyHold &&
              config.selections.some(
                (selection) =>
                  selection.kind === "repository" &&
                  selection.repositoryId === imported.repositoryId &&
                  this.one(
                    "SELECT 1 AS present FROM project_github_active a JOIN github_sync_state s ON s.projectId=a.projectId AND s.selectionId=a.selectionId WHERE a.projectId=? AND a.selectionId=? AND a.configVersion=? AND s.complete=1",
                    String(task.projectId),
                    selection.id,
                    config.version,
                  ),
              );
            if (!closureSelection) reasons.push("source-withdrawn");
          } else if (
            memberships.some((membership) => membership.complete !== 1)
          )
            reasons.push("source-unknown");
          const projects = this.db
            .prepare(
              "SELECT DISTINCT projectId FROM github_memberships WHERE nodeId = ?",
            )
            .all(String(external.nodeId)) as Row[];
          if (
            projects.length > 1 &&
            !this.one(
              "SELECT 1 AS present FROM github_placement_decisions WHERE nodeId = ?",
              String(external.nodeId),
            ) &&
            !this.one(
              "SELECT 1 AS present FROM domain_assignments WHERE taskId = ? LIMIT 1",
              taskId,
            )
          )
            reasons.push("source-placement-conflict");
        }
      }
    }
    if (
      this.one(
        `SELECT 1 AS blocked FROM local_dependencies d
      JOIN domain_tasks b ON b.id = d.blockerTaskId
      LEFT JOIN github_imported_tasks i ON i.taskId = b.id
      LEFT JOIN github_issue_status s ON s.nodeId = i.nodeId
      WHERE d.taskId = ? AND ((i.taskId IS NULL AND b.state != 'done')
        OR (i.taskId IS NOT NULL AND COALESCE(s.status, 'unknown') != 'closed')) LIMIT 1`,
        taskId,
      )
    )
      reasons.push("local-dependency");
    return { eligible: reasons.length === 0, reasons };
  }

  recordRouting(
    input: {
      id: string;
      projectId: string;
      taskId: string;
      taskVersion: number;
      assignmentId: string | null;
      candidateRevisions: Record<string, number>;
      guidanceRevision: number;
      model: string;
      question: string;
      judgment: string | null;
      disposition: string;
      resultDestination: string;
      brief?: string;
      assignment?: {
        profileId: string;
        brief: string;
        requesterAssignmentId: string | null;
      };
    },
    externallyAdmitted?: () => boolean,
  ): Row {
    const data = z
      .object({
        id,
        projectId: id,
        taskId: id,
        taskVersion: z.number().int().positive(),
        assignmentId: id.nullable(),
        candidateRevisions: z.record(id, z.number().int().positive()),
        guidanceRevision: z.number().int().positive(),
        model: label,
        question: prose,
        judgment: prose.nullable(),
        disposition: label,
        resultDestination: label,
        brief: prose.optional(),
        assignment: z
          .object({
            profileId: id,
            brief: prose,
            requesterAssignmentId: id.nullable(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input);
    const hash = createHash("sha256").update(canonical(data)).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.one(
        "SELECT id, payloadHash FROM routing_operations WHERE id = ? OR (projectId = ? AND taskId = ? AND taskVersion = ?)",
        data.id,
        data.projectId,
        data.taskId,
        data.taskVersion,
      );
      if (existing) {
        if (existing.id !== data.id || existing.payloadHash !== hash)
          throw new DomainConflictError("Routing operation conflict");
        this.db.exec("COMMIT");
        return this.routingOperation(data.id);
      }
      if (externallyAdmitted && !externallyAdmitted())
        throw new Error("External admission rejected routing disposition");
      const task = this.task(data.taskId);
      if (task.projectId !== data.projectId)
        throw new DomainPolicyError(
          "forbidden",
          "Task belongs to another project",
        );
      const routing = this.routing(data.projectId);
      if (
        task.version !== data.taskVersion ||
        routing.version !== data.guidanceRevision ||
        !routing.enabled ||
        !this.admission(data.taskId).eligible
      )
        throw new Error("Routing decision is stale or task is held");
      const candidateIds = this.routingCandidates(data.projectId).map(
        (candidate) => String(candidate.profileId),
      );
      if (
        canonical(candidateIds) !==
        canonical(Object.keys(data.candidateRevisions).sort())
      )
        throw new Error("Routing candidate set changed");
      for (const profileId of candidateIds)
        if (
          this.profile(profileId).version !== data.candidateRevisions[profileId]
        )
          throw new Error("Candidate profile revision changed");
      if (this.assignments(data.taskId).length > 0)
        throw new Error("Routing decision became stale: task already assigned");
      if (data.disposition === "assigned") {
        if (!data.assignmentId || !data.assignment)
          throw new Error("Assigned routing requires an assignment");
        if (!routing.credentialAvailable)
          throw new Error("Routing credentials unavailable");
        if (!candidateIds.includes(data.assignment.profileId))
          throw new Error("Selected profile is not a candidate");
        this.apply({
          type: "assignment.create",
          key: data.id,
          actor: "agent",
          projectId: data.projectId,
          taskId: data.taskId,
          assignmentId: data.assignmentId,
          profileId: data.assignment.profileId,
          brief: data.assignment.brief,
          resultDestination: data.resultDestination,
          requesterAssignmentId: data.assignment.requesterAssignmentId,
        });
      } else if (data.assignmentId || data.assignment)
        throw new Error("Non-assigned routing cannot create an assignment");
      else if (!this.ensureLeadAssignmentWithinTransaction(data.taskId))
        throw new Error("Routing fallback requires a configured task lead");
      this.db
        .prepare(
          "INSERT INTO routing_operations (id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          data.id,
          data.projectId,
          data.taskId,
          data.taskVersion,
          data.assignmentId,
          canonical(data.candidateRevisions),
          data.guidanceRevision,
          data.model,
          data.question,
          data.judgment,
          data.disposition,
          data.resultDestination,
          data.brief ?? String(task.outcome),
          hash,
        );
      this.db.exec("COMMIT");
      this.onChange?.();
      return this.routingOperation(data.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  routingOperation(operationId: string): Row {
    return this.required(
      "SELECT id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief FROM routing_operations WHERE id = ?",
      id.parse(operationId),
    );
  }

  private apply(
    command: ParsedCommand,
    verifiedRepositories?: LinkedRepository[],
  ): unknown {
    switch (command.type) {
      case "project.create": {
        this.operator(command);
        if (command.leadProfileId) this.activeProfile(command.leadProfileId);
        this.db
          .prepare("INSERT INTO projects (id, instructions) VALUES (?, '')")
          .run(command.projectId);
        this.db
          .prepare(
            "INSERT INTO domain_projects (id, name, version, paused, leadProfileId, instructionsRevision) VALUES (?, ?, 1, 1, ?, 1)",
          )
          .run(command.projectId, command.name, command.leadProfileId);
        this.db
          .prepare(
            "INSERT INTO project_instruction_revisions (projectId, revision, instructions) VALUES (?, 1, '')",
          )
          .run(command.projectId);
        this.db
          .prepare(
            "INSERT INTO project_routing (projectId, version, enabled, guidance, credentialRef, candidateProfileIds) VALUES (?, 1, 0, '', NULL, '[]')",
          )
          .run(command.projectId);
        this.db
          .prepare(
            "INSERT INTO project_github_sources (projectId, version, credentialRef, selections, readiness, repositories) VALUES (?, 1, NULL, '[]', ?, '[]')",
          )
          .run(
            command.projectId,
            JSON.stringify({
              mode: "all",
              conditions: [{ kind: "label", name: "ready" }],
            }),
          );
        return this.project(command.projectId);
      }
      case "project.configure": {
        this.operator(command);
        const current = this.project(command.projectId);
        this.version(current, command.expectedVersion);
        if (command.leadProfileId) this.activeProfile(command.leadProfileId);
        const revision =
          Number(current.instructionsRevision) +
          (command.instructions === undefined ? 0 : 1);
        if (command.instructions !== undefined)
          this.db
            .prepare(
              "INSERT INTO project_instruction_revisions (projectId, revision, instructions) VALUES (?, ?, ?)",
            )
            .run(command.projectId, revision, command.instructions);
        this.db
          .prepare(
            "UPDATE domain_projects SET name = ?, paused = ?, leadProfileId = ?, instructionsRevision = ?, version = version + 1 WHERE id = ?",
          )
          .run(
            command.name ?? present(current, "name"),
            command.paused === undefined
              ? present(current, "paused")
              : Number(command.paused),
            command.leadProfileId === undefined
              ? present(current, "leadProfileId")
              : command.leadProfileId,
            revision,
            command.projectId,
          );
        return this.project(command.projectId);
      }
      case "task.create": {
        this.operator(command);
        this.project(command.projectId);
        this.db
          .prepare("INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)")
          .run(command.taskId, command.projectId, command.title);
        this.db
          .prepare(
            "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, ?, ?, 'open', 'clear')",
          )
          .run(
            command.taskId,
            command.projectId,
            command.outcome,
            Number(command.ready),
          );
        for (const blockerTaskId of command.blockerTaskIds ?? []) {
          this.apply({
            type: "dependency.add",
            key: command.key,
            actor: command.actor,
            projectId: command.projectId,
            taskId: command.taskId,
            blockerTaskId,
            expectedVersion: Number(this.task(command.taskId).version),
          });
        }
        if (command.initialAssignment) {
          this.apply({
            type: "assignment.create",
            key: command.key,
            actor: command.actor,
            projectId: command.projectId,
            taskId: command.taskId,
            ...command.initialAssignment,
            brief: `Task: ${command.title}\nOutcome: ${command.outcome}`,
            resultDestination: "lead",
            requesterAssignmentId: null,
          });
        }
        return this.task(command.taskId);
      }
      case "task.configure": {
        this.operator(command);
        const current = this.task(command.taskId);
        this.projectMatch(current, command.projectId);
        this.version(current, command.expectedVersion);
        if (
          this.importedTask(command.taskId) &&
          (command.title !== undefined ||
            command.outcome !== undefined ||
            command.ready !== undefined)
        )
          throw new DomainConflictError(
            "Imported provider fields and readiness are provider-owned",
          );
        if (command.title !== undefined)
          this.db
            .prepare("UPDATE tasks SET title = ? WHERE id = ?")
            .run(command.title, command.taskId);
        this.db
          .prepare(
            "UPDATE domain_tasks SET outcome = ?, ready = ?, state = ?, version = version + 1 WHERE id = ?",
          )
          .run(
            command.outcome ?? present(current, "outcome"),
            command.ready === undefined
              ? present(current, "ready")
              : Number(command.ready),
            command.state ?? present(current, "state"),
            command.taskId,
          );
        return this.task(command.taskId);
      }
      case "profile.create": {
        this.operator(command);
        this.db
          .prepare(
            "INSERT INTO profiles (id, version, name, instructions, capabilities, revoked) VALUES (?, 1, ?, ?, ?, 0)",
          )
          .run(
            command.profileId,
            command.name,
            command.instructions,
            command.capabilities,
          );
        this.snapshotProfile(command.profileId);
        return this.profile(command.profileId);
      }
      case "profile.configure": {
        this.operator(command);
        const current = this.profile(command.profileId);
        this.version(current, command.expectedVersion);
        this.db
          .prepare(
            "UPDATE profiles SET version = version + 1, name = ?, instructions = ?, capabilities = ?, revoked = ? WHERE id = ?",
          )
          .run(
            command.name ?? present(current, "name"),
            command.instructions ?? present(current, "instructions"),
            command.capabilities ?? present(current, "capabilities"),
            command.revoked === undefined
              ? present(current, "revoked")
              : Number(command.revoked),
            command.profileId,
          );
        this.snapshotProfile(command.profileId);
        return this.profile(command.profileId);
      }
      case "routing.configure": {
        this.operator(command);
        this.project(command.projectId);
        const current = this.required(
          "SELECT version, credentialRef FROM project_routing WHERE projectId = ?",
          command.projectId,
        );
        this.version(current, command.expectedVersion);
        for (const profileId of command.candidateProfileIds)
          this.activeProfile(profileId);
        this.db
          .prepare(
            "UPDATE project_routing SET version = version + 1, enabled = ?, guidance = ?, credentialRef = ?, candidateProfileIds = ? WHERE projectId = ?",
          )
          .run(
            Number(command.enabled),
            command.guidance,
            command.credentialRef === undefined
              ? present(current, "credentialRef")
              : command.credentialRef,
            canonical([...new Set(command.candidateProfileIds)].sort()),
            command.projectId,
          );
        return this.routing(command.projectId);
      }
      case "delivery.configure": {
        this.operator(command);
        this.project(command.projectId);
        const {
          key: _key,
          actor: _actor,
          type: _type,
          projectId,
          expectedVersion,
          ...policy
        } = command;
        return new DeliveryStore(this.db).configureWithinTransaction(
          projectId,
          expectedVersion,
          policy,
        );
      }
      case "github.configure": {
        this.operator(command);
        const current = this.githubConfiguration(command.projectId);
        this.version({ version: current.version }, command.expectedVersion);
        const repositories = verifiedRepositories ?? [];
        if (command.repositories.length !== repositories.length)
          throw new Error(
            "Linked GitHub configuration requires asynchronous verification",
          );
        this.db
          .prepare(
            "UPDATE project_github_sources SET version = version + 1, credentialRef = ?, selections = ?, readiness = ?, repositories = ? WHERE projectId = ?",
          )
          .run(
            command.credentialRef === undefined
              ? current.credentialRef
              : command.credentialRef,
            JSON.stringify(command.selections),
            JSON.stringify(command.readiness),
            JSON.stringify(repositories),
            command.projectId,
          );
        if (
          this.one(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'github_sync_state'",
          )
        ) {
          const selectionIds = JSON.stringify(
            command.selections.map((selection) => selection.id),
          );
          const members = this.db
            .prepare(`SELECT DISTINCT e.taskId FROM github_memberships m
            JOIN github_external_issues e ON e.nodeId = m.nodeId
            WHERE m.projectId = ? AND m.selectionId NOT IN (SELECT value FROM json_each(?))`)
            .all(command.projectId, selectionIds) as Row[];
          const affectedTasks = members.map((member) => String(member.taskId));
          for (const table of [
            "github_memberships",
            "github_sync_state",
            "project_github_active",
          ])
            this.db
              .prepare(
                `DELETE FROM ${table} WHERE projectId = ? AND selectionId NOT IN (SELECT value FROM json_each(?))`,
              )
              .run(command.projectId, selectionIds);
          const sources = new GitHubSourceStore(this.db);
          for (const taskId of affectedTasks) sources.updateReadiness(taskId);
          this.db
            .prepare(
              "UPDATE github_sync_state SET complete = 0, reason = 'configuration-changed' WHERE projectId = ?",
            )
            .run(command.projectId);
          this.db
            .prepare(`UPDATE domain_tasks SET importedBlockers = 'unknown'
            WHERE projectId = ? AND id IN (SELECT taskId FROM github_imported_tasks)`)
            .run(command.projectId);
          this.db
            .prepare(`UPDATE github_dependency_observations SET complete = 0, reason = 'configuration-changed'
            WHERE nodeId IN (SELECT nodeId FROM github_imported_tasks WHERE taskId IN
              (SELECT id FROM domain_tasks WHERE projectId = ?))`)
            .run(command.projectId);
          this.db
            .prepare(`UPDATE domain_tasks SET version = version + 1 WHERE id IN (
            SELECT d.taskId FROM local_dependencies d JOIN github_imported_tasks i ON i.taskId = d.blockerTaskId
            JOIN domain_tasks b ON b.id = i.taskId JOIN github_issue_status s ON s.nodeId = i.nodeId
            WHERE b.projectId = ? AND s.status = 'closed')`)
            .run(command.projectId);
          this.db
            .prepare(`UPDATE github_issue_status SET status = 'unknown', reason = 'configuration-changed'
            WHERE nodeId IN (SELECT i.nodeId FROM github_imported_tasks i
              JOIN domain_tasks t ON t.id = i.taskId WHERE t.projectId = ?)`)
            .run(command.projectId);
          this.db
            .prepare(
              "UPDATE domain_tasks SET version = version + 1 WHERE projectId = ? AND id IN (SELECT taskId FROM github_imported_tasks)",
            )
            .run(command.projectId);
        }
        return this.githubConfiguration(command.projectId);
      }
      case "github.activate": {
        this.operator(command);
        const config = this.githubConfiguration(command.projectId);
        this.version({ version: config.version }, command.expectedVersion);
        if (
          !config.selections.some(
            (selection) =>
              typeof selection === "object" &&
              selection !== null &&
              "id" in selection &&
              selection.id === command.selectionId,
          )
        )
          throw new DomainConflictError("Unknown GitHub selection");
        this.db
          .prepare(
            "INSERT INTO project_github_active (projectId, selectionId, configVersion) VALUES (?, ?, ?) ON CONFLICT(projectId, selectionId) DO UPDATE SET configVersion = excluded.configVersion",
          )
          .run(command.projectId, command.selectionId, config.version);
        return {
          projectId: command.projectId,
          selectionId: command.selectionId,
          configVersion: config.version,
          active: true,
        };
      }
      case "github.place": {
        this.operator(command);
        const task = this.task(command.taskId);
        this.projectMatch(task, command.projectId);
        this.version(task, command.expectedVersion);
        const imported = this.importedTask(command.taskId);
        if (!imported) throw new DomainConflictError("Task is not imported");
        const membership = this.one(
          "SELECT 1 AS present FROM github_memberships WHERE nodeId = ? AND projectId = ?",
          String(imported.nodeId),
          command.chosenProjectId,
        );
        if (!membership)
          throw new DomainConflictError(
            "Chosen project has no source membership",
          );
        if (
          this.one(
            "SELECT 1 AS present FROM domain_assignments WHERE taskId = ? LIMIT 1",
            command.taskId,
          )
        )
          throw new DomainConflictError(
            "Assigned imported task cannot transfer projects",
          );
        if (command.projectId !== command.chosenProjectId) {
          if (
            this.one(
              "SELECT 1 AS present FROM local_dependencies WHERE taskId = ? OR blockerTaskId = ? LIMIT 1",
              command.taskId,
              command.taskId,
            )
          )
            throw new DomainConflictError(
              "Imported task with local dependencies cannot transfer projects",
            );
          this.db
            .prepare("DELETE FROM task_lead_bindings WHERE taskId = ?")
            .run(command.taskId);
          this.db
            .prepare("UPDATE tasks SET projectId = ? WHERE id = ?")
            .run(command.chosenProjectId, command.taskId);
          this.db
            .prepare("UPDATE domain_tasks SET projectId = ? WHERE id = ?")
            .run(command.chosenProjectId, command.taskId);
        }
        this.db
          .prepare(
            "INSERT INTO github_placement_decisions (nodeId, projectId) VALUES (?, ?) ON CONFLICT(nodeId) DO UPDATE SET projectId = excluded.projectId",
          )
          .run(String(imported.nodeId), command.chosenProjectId);
        new GitHubSourceStore(this.db).updateReadiness(command.taskId);
        this.db
          .prepare("UPDATE domain_tasks SET version = version + 1 WHERE id = ?")
          .run(command.taskId);
        return this.task(command.taskId);
      }
      case "source.review": {
        this.operator(command);
        const task = this.task(command.taskId);
        this.projectMatch(task, command.projectId);
        this.version(task, command.expectedVersion);
        const imported = this.importedTask(command.taskId);
        if (!imported) throw new DomainConflictError("Task is not imported");
        const external = this.one(
          "SELECT observedTitle, observedBody, observedState FROM github_external_issues WHERE nodeId = ?",
          String(imported.nodeId),
        );
        const review = this.one(
          "SELECT observedDigest, acceptedDigest FROM github_source_reviews WHERE nodeId = ?",
          String(imported.nodeId),
        );
        const hold = this.one(
          "SELECT active FROM github_source_holds WHERE nodeId = ?",
          String(imported.nodeId),
        );
        if (
          !external ||
          !review ||
          review.observedDigest !== command.observedDigest ||
          (review.acceptedDigest === review.observedDigest && !hold?.active)
        )
          throw new DomainConflictError(
            "Source review digest is stale or already classified",
          );
        if (command.decision === "resume-source-hold" && !hold?.active)
          throw new DomainConflictError("No source hold to resume");
        if (
          command.decision === "resume-source-hold" &&
          review.acceptedDigest !== review.observedDigest
        )
          throw new DomainConflictError(
            "Changed text requires explicit text review",
          );
        if (
          command.decision !== "resume-source-hold" &&
          review.acceptedDigest === review.observedDigest
        )
          throw new DomainConflictError("Source text is already classified");
        const reasons = this.admission(command.taskId).reasons;
        if (
          external.observedState !== "open" ||
          reasons.includes("source-unknown") ||
          reasons.includes("source-withdrawn") ||
          reasons.includes("task-unready")
        )
          throw new DomainConflictError(
            "Current complete source/readiness evidence is required",
          );
        this.db
          .prepare(
            "UPDATE github_source_reviews SET acceptedDigest = observedDigest, decision = ?, decidedAt = ? WHERE nodeId = ?",
          )
          .run(
            command.decision,
            new Date().toISOString(),
            String(imported.nodeId),
          );
        this.db
          .prepare("UPDATE github_source_holds SET active = 0 WHERE nodeId = ?")
          .run(String(imported.nodeId));
        this.db
          .prepare("UPDATE tasks SET title = ? WHERE id = ?")
          .run(String(external.observedTitle), command.taskId);
        this.db
          .prepare(
            "UPDATE domain_tasks SET outcome = ?, version = version + 1 WHERE id = ?",
          )
          .run(String(external.observedBody), command.taskId);
        return this.task(command.taskId);
      }
      case "assignment.create": {
        if (
          this.one(
            "SELECT id FROM domain_assignments WHERE id = ?",
            command.assignmentId,
          )
        )
          throw new DomainConflictError("Assignment identity already exists");
        const task = this.task(command.taskId);
        this.projectMatch(task, command.projectId);
        const profile = this.activeProfile(command.profileId);
        const project = this.project(command.projectId);
        const routing = this.routing(command.projectId);
        const permitted = JSON.parse(
          String(routing.candidateProfileIds),
        ) as string[];
        if (
          project.leadProfileId !== command.profileId &&
          !permitted.includes(command.profileId)
        )
          throw new DomainPolicyError(
            "forbidden",
            "Profile is not permitted for this project",
          );
        if (command.requesterAssignmentId) {
          const requester = this.assignment(command.requesterAssignmentId);
          this.projectMatch(requester, command.projectId);
          if (requester.taskId !== command.taskId)
            throw new Error("Requester assignment belongs to another task");
        }
        const resultRecipientAssignmentId =
          command.requesterAssignmentId ??
          this.ensureLeadBindingWithinTransaction(command.taskId);
        this.db
          .prepare(
            "INSERT INTO domain_assignments (id, taskId, projectId, version, profileId, profileRevision, instructionsRevision, brief, resultDestination, requesterAssignmentId, resultRecipientAssignmentId, resultRecipientDisposition, state) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
          )
          .run(
            command.assignmentId,
            command.taskId,
            command.projectId,
            command.profileId,
            present(profile, "version"),
            present(project, "instructionsRevision"),
            command.brief,
            command.resultDestination,
            command.requesterAssignmentId,
            resultRecipientAssignmentId,
            resultRecipientAssignmentId ? "resolved" : "unresolved",
          );
        return this.assignment(command.assignmentId);
      }
      case "assignment.apply": {
        this.operator(command);
        const assignment = this.assignment(command.assignmentId);
        this.projectMatch(assignment, command.projectId);
        this.version(assignment, command.expectedVersion);
        const profile = this.activeProfile(String(assignment.profileId));
        const project = this.project(command.projectId);
        this.db
          .prepare(
            "UPDATE domain_assignments SET version = version + 1, profileRevision = ?, instructionsRevision = ? WHERE id = ?",
          )
          .run(
            present(profile, "version"),
            present(project, "instructionsRevision"),
            command.assignmentId,
          );
        return this.assignment(command.assignmentId);
      }
      case "dependency.add":
      case "dependency.remove": {
        this.operator(command);
        const task = this.task(command.taskId);
        const blocker = this.task(command.blockerTaskId);
        this.projectMatch(task, command.projectId);
        this.projectMatch(blocker, command.projectId);
        this.version(task, command.expectedVersion);
        if (command.taskId === command.blockerTaskId)
          throw new DomainPolicyError(
            "invalid-input",
            "Task cannot block itself",
          );
        if (command.type === "dependency.add") {
          if (this.importedTask(command.taskId))
            throw new DomainConflictError(
              "Imported dependent cannot own a local dependency edge",
            );
          const cycle = this.one(
            "WITH RECURSIVE walk(id) AS (SELECT blockerTaskId FROM local_dependencies WHERE taskId = ? UNION SELECT d.blockerTaskId FROM local_dependencies d JOIN walk w ON d.taskId = w.id) SELECT id FROM walk WHERE id = ?",
            command.blockerTaskId,
            command.taskId,
          );
          if (cycle)
            throw new DomainPolicyError(
              "invalid-input",
              "Local dependency cycle",
            );
          this.db
            .prepare(
              "INSERT INTO local_dependencies (taskId, blockerTaskId) VALUES (?, ?)",
            )
            .run(command.taskId, command.blockerTaskId);
        } else
          this.db
            .prepare(
              "DELETE FROM local_dependencies WHERE taskId = ? AND blockerTaskId = ?",
            )
            .run(command.taskId, command.blockerTaskId);
        this.db
          .prepare("UPDATE domain_tasks SET version = version + 1 WHERE id = ?")
          .run(command.taskId);
        return this.task(command.taskId);
      }
      case "imported-blockers.set": {
        this.operator(command);
        const task = this.task(command.taskId);
        this.projectMatch(task, command.projectId);
        this.version(task, command.expectedVersion);
        if (this.importedTask(command.taskId))
          throw new DomainConflictError("Imported blockers are provider-owned");
        this.db
          .prepare(
            "UPDATE domain_tasks SET importedBlockers = ?, version = version + 1 WHERE id = ?",
          )
          .run(command.state, command.taskId);
        return this.task(command.taskId);
      }
      case "capacity.configure": {
        this.operator(command);
        this.db
          .prepare(
            "UPDATE scheduler_capacity_limits SET globalLimit = ? WHERE singleton = 1",
          )
          .run(command.globalLimit);
        for (const [projectId, projectLimit] of Object.entries(
          command.projectOverrides,
        )) {
          this.project(projectId);
          if (projectLimit === null)
            this.db
              .prepare(
                "DELETE FROM scheduler_project_capacity_limits WHERE projectId = ?",
              )
              .run(projectId);
          else
            this.db
              .prepare(`INSERT INTO scheduler_project_capacity_limits
                (projectId, projectLimit) VALUES (?, ?)
                ON CONFLICT(projectId) DO UPDATE SET projectLimit = excluded.projectLimit`)
              .run(projectId, projectLimit);
        }
        return this.capacityLimits(Object.keys(command.projectOverrides));
      }
    }
  }

  private ensureLeadAssignmentWithinTransaction(
    taskId: string,
  ): Row | undefined {
    const assignmentId = this.ensureLeadBindingWithinTransaction(taskId);
    if (!assignmentId) return undefined;
    const existing = this.one(
      "SELECT * FROM domain_assignments WHERE id = ?",
      assignmentId,
    );
    if (existing) return existing;
    const binding = this.required(
      "SELECT taskId, projectId, profileId, profileRevision, instructionsRevision, assignmentId FROM task_lead_bindings WHERE taskId = ?",
      taskId,
    );
    const task = this.task(taskId);
    this.db
      .prepare(`INSERT OR IGNORE INTO domain_assignments
        (id, taskId, projectId, version, profileId, profileRevision,
          instructionsRevision, brief, resultDestination, requesterAssignmentId,
          resultRecipientAssignmentId, resultRecipientDisposition, state)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'lead', NULL, ?, 'resolved', 'pending')`)
      .run(
        assignmentId,
        taskId,
        String(binding.projectId),
        String(binding.profileId),
        Number(binding.profileRevision),
        Number(binding.instructionsRevision),
        `Task: ${task.title}\nOutcome: ${task.outcome}`,
        assignmentId,
      );
    new TaskReviewStore(this.db).captureAssignment(
      assignmentId,
      "service:project-lead",
    );
    return this.assignment(assignmentId);
  }

  private ensureLeadBindingWithinTransaction(taskId: string): string | null {
    const existing = this.one(
      "SELECT assignmentId FROM task_lead_bindings WHERE taskId = ?",
      taskId,
    );
    if (existing) return String(existing.assignmentId);
    const task = this.task(taskId);
    const project = this.project(String(task.projectId));
    if (typeof project.leadProfileId !== "string") return null;
    const profile = this.activeProfile(project.leadProfileId);
    const assignmentId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO task_lead_bindings " +
          "(taskId, projectId, profileId, profileRevision, instructionsRevision, assignmentId) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        taskId,
        String(task.projectId),
        project.leadProfileId,
        present(profile, "version"),
        present(project, "instructionsRevision"),
        assignmentId,
      );
    return assignmentId;
  }

  private snapshotProfile(profileId: string): void {
    const p = this.profile(profileId);
    this.db
      .prepare(
        "INSERT INTO profile_revisions (profileId, revision, name, instructions, capabilities, revoked) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        profileId,
        present(p, "version"),
        present(p, "name"),
        present(p, "instructions"),
        present(p, "capabilities"),
        present(p, "revoked"),
      );
  }

  private activeProfile(profileId: string): Row {
    const profile = this.profile(profileId);
    if (profile.revoked)
      throw new DomainPolicyError("forbidden", "Profile revoked");
    return profile;
  }

  private operator(command: { actor: "operator" | "agent" }): void {
    if (command.actor !== "operator")
      throw new DomainPolicyError("forbidden", "Operator authority required");
  }

  private version(row: Row, expected: number): void {
    if (row.version !== expected)
      throw new DomainConflictError("Version conflict");
  }

  private projectMatch(row: Row, projectId: string): void {
    if (row.projectId !== projectId)
      throw new DomainPolicyError(
        "forbidden",
        "Task belongs to another project",
      );
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
    if (!row) throw new Error("Unknown domain record");
    return row;
  }
}

/** Shares an in-flight command promise; durable receipts handle later retries. */
export class DomainCommands {
  private readonly inFlight = new Map<
    string,
    { hash: string; promise: Promise<unknown> }
  >();

  constructor(private readonly store: DomainStore) {}

  execute(input: DomainCommand): Promise<unknown> {
    const command = parseCommand(input);
    const scope =
      "projectId" in command
        ? command.projectId
        : "profileId" in command
          ? `profile:${command.profileId}`
          : "system:capacity";
    const key = `${scope}:${command.key}`;
    const hash = createHash("sha256").update(canonical(command)).digest("hex");
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.hash !== hash)
        return Promise.reject(
          new DomainConflictError(
            "Command key already used with different payload",
          ),
        );
      return existing.promise;
    }
    const promise = Promise.resolve().then(() =>
      command.type === "github.configure" && command.repositories.length > 0
        ? this.store.configureGitHub(command)
        : this.store.execute(command),
    );
    this.inFlight.set(key, { hash, promise });
    void promise.finally(() => this.inFlight.delete(key)).catch(() => {});
    return promise;
  }
}
