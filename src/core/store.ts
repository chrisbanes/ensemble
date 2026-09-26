import { randomUUID } from "node:crypto";
import { z } from "zod";

type SqlValue = string | number | null;

// Both BB's better-sqlite3 handle and node:sqlite implement this small surface.
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: SqlValue[]): unknown;
    get(...parameters: SqlValue[]): unknown;
    all(...parameters: SqlValue[]): unknown[];
  };
}

const schemaVersion = 1;
const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
});
const assignmentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  brief: z.string(),
  state: z.enum(["pending", "launching", "running", "completed"]),
  instructions: z.string().nullable(),
  result: z.string().nullable(),
});
const projectBindingSchema = z.object({
  projectId: z.string(),
  hostKey: z.string().uuid(),
  externalProjectId: z.string(),
  coordinatorConversationId: z.string().nullable(),
});
const conversationBindingSchema = z.object({
  assignmentId: z.string(),
  hostKey: z.string().uuid(),
  externalConversationId: z.string(),
});
const hostInstallationSchema = z.object({
  hostKind: z.string(),
  hostKey: z.string().uuid(),
});
const schemaVersionSchema = z.object({
  user_version: z.number().int().nonnegative(),
});
const hostKindSchema = z.string().trim().min(1).max(80);
const instructionsSchema = z.string().max(16000);

export type Assignment = z.infer<typeof assignmentSchema>;
export type ProjectBinding = z.infer<typeof projectBindingSchema>;
export type ConversationBinding = z.infer<typeof conversationBindingSchema>;

export class Store {
  private hostKey: string | undefined;

  constructor(private readonly db: Database) {}

  ensureHost(kind: string): string {
    const hostKind = hostKindSchema.parse(kind);
    const hostKey = this.transaction(() => {
      const version = schemaVersionSchema.parse(
        this.db.prepare("PRAGMA user_version").get(),
      ).user_version;
      if (version > schemaVersion)
        throw new Error(
          `Database schema ${version} is newer than supported schema ${schemaVersion}`,
        );

      if (version === 0) {
        this.createLegacyTables();
        this.createCoreTables();
        this.addInstructionsColumn();
        const installed = this.db
          .prepare(
            "SELECT hostKind, hostKey FROM host_installation WHERE singleton = 1",
          )
          .get();
        const host = installed
          ? hostInstallationSchema.parse(installed)
          : { hostKind, hostKey: randomUUID() };
        if (host.hostKind !== hostKind)
          throw new Error(
            `Database is bound to execution host ${host.hostKind}, not ${hostKind}`,
          );
        if (!installed)
          this.db
            .prepare(
              "INSERT INTO host_installation (singleton, hostKind, hostKey) VALUES (1, ?, ?)",
            )
            .run(host.hostKind, host.hostKey);
        this.migrateLegacyBindings(host.hostKey);
        this.validatePersistedRows();
        this.db.exec(`PRAGMA user_version = ${schemaVersion}`);
        return host.hostKey;
      }

      const host = hostInstallationSchema.parse(
        this.db
          .prepare(
            "SELECT hostKind, hostKey FROM host_installation WHERE singleton = 1",
          )
          .get(),
      );
      if (host.hostKind !== hostKind)
        throw new Error(
          `Database is bound to execution host ${host.hostKind}, not ${hostKind}`,
        );
      return host.hostKey;
    });
    this.hostKey = hostKey;
    return hostKey;
  }

  bindProject(
    hostKey: string,
    externalProjectId: string,
    coordinatorConversationId: string | null,
  ): ProjectBinding {
    this.requireHost(hostKey);
    const externalId = z.string().min(1).max(512).parse(externalProjectId);
    const coordinatorId = z
      .string()
      .min(1)
      .max(512)
      .nullable()
      .parse(coordinatorConversationId);
    const existing = this.db
      .prepare(
        "SELECT projectId, hostKey, externalProjectId, coordinatorConversationId FROM project_host_bindings WHERE hostKey = ? AND externalProjectId = ?",
      )
      .get(hostKey, externalId);
    if (existing) {
      const binding = projectBindingSchema.parse(existing);
      this.db
        .prepare(
          "UPDATE project_host_bindings SET coordinatorConversationId = ? WHERE projectId = ? AND hostKey = ?",
        )
        .run(coordinatorId, binding.projectId, hostKey);
      return this.getProjectBinding(binding.projectId);
    }

    const projectId = randomUUID();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO projects (id, instructions) VALUES (?, NULL)")
        .run(projectId);
      this.db
        .prepare(
          "INSERT INTO project_host_bindings (projectId, hostKey, externalProjectId, coordinatorConversationId) VALUES (?, ?, ?, ?)",
        )
        .run(projectId, hostKey, externalId, coordinatorId);
    });
    return this.getProjectBinding(projectId);
  }

  resolveProject(hostKey: string, externalProjectId: string): ProjectBinding {
    this.requireHost(hostKey);
    return projectBindingSchema.parse(
      this.db
        .prepare(
          "SELECT projectId, hostKey, externalProjectId, coordinatorConversationId FROM project_host_bindings WHERE hostKey = ? AND externalProjectId = ?",
        )
        .get(hostKey, externalProjectId),
    );
  }

  getProjectBinding(projectId: string): ProjectBinding {
    this.requireInitialized();
    return projectBindingSchema.parse(
      this.db
        .prepare(
          "SELECT projectId, hostKey, externalProjectId, coordinatorConversationId FROM project_host_bindings WHERE projectId = ?",
        )
        .get(projectId),
    );
  }

  getConversationBinding(
    assignmentId: string,
  ): ConversationBinding | undefined {
    this.requireInitialized();
    const row = this.db
      .prepare(
        "SELECT assignmentId, hostKey, externalConversationId FROM conversation_bindings WHERE assignmentId = ?",
      )
      .get(assignmentId);
    return row === undefined ? undefined : conversationBindingSchema.parse(row);
  }

  setProjectInstructions(projectId: string, instructions: string): void {
    this.requireInitialized();
    const text = instructionsSchema.parse(instructions);
    this.db
      .prepare("UPDATE projects SET instructions = ? WHERE id = ?")
      .run(text, projectId);
    if (!this.hasProject(projectId))
      throw new Error("Unknown Ensemble project");
  }

  createTask(id: string, projectId: string, title: string) {
    this.requireInitialized();
    const input = taskSchema.parse({ id, projectId, title });
    if (!this.hasProject(projectId))
      throw new Error("Unknown Ensemble project");
    const existing = this.db
      .prepare("SELECT id, projectId, title FROM tasks WHERE id = ?")
      .get(input.id);
    if (existing) {
      const task = taskSchema.parse(existing);
      if (task.projectId !== input.projectId || task.title !== input.title)
        throw new Error("Task ID already used with different content");
      return task;
    }
    this.db
      .prepare("INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)")
      .run(input.id, input.projectId, input.title);
    return input;
  }

  assign(
    id: string,
    taskId: string,
    projectId: string,
    brief: string,
  ): Assignment {
    this.requireInitialized();
    const task = taskSchema.parse(
      this.db
        .prepare("SELECT id, projectId, title FROM tasks WHERE id = ?")
        .get(taskId),
    );
    if (task.projectId !== projectId)
      throw new Error("Task belongs to another project");
    const existing = this.db
      .prepare(
        "SELECT id, taskId, projectId, brief, state, instructions, result FROM assignments WHERE id = ?",
      )
      .get(id);
    if (existing) {
      const assignment = assignmentSchema.parse(existing);
      if (
        assignment.taskId !== taskId ||
        assignment.projectId !== projectId ||
        assignment.brief !== brief
      )
        throw new Error("Assignment ID already used with different content");
      return assignment;
    }
    const instructions = this.getProjectInstructions(projectId);
    if (instructions === undefined) throw new Error("Unknown Ensemble project");
    this.db
      .prepare(
        "INSERT INTO assignments (id, taskId, projectId, brief, state, threadId, result, instructions) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)",
      )
      .run(id, taskId, projectId, brief, instructions);
    return this.get(id);
  }

  get(id: string): Assignment {
    this.requireInitialized();
    return assignmentSchema.parse(
      this.db
        .prepare(
          "SELECT id, taskId, projectId, brief, state, instructions, result FROM assignments WHERE id = ?",
        )
        .get(id),
    );
  }

  list(projectId?: string): Assignment[] {
    this.requireInitialized();
    const rows =
      projectId === undefined
        ? this.db
            .prepare(
              "SELECT id, taskId, projectId, brief, state, instructions, result FROM assignments ORDER BY id",
            )
            .all()
        : this.db
            .prepare(
              "SELECT id, taskId, projectId, brief, state, instructions, result FROM assignments WHERE projectId = ? ORDER BY id",
            )
            .all(projectId);
    return rows.map((row) => assignmentSchema.parse(row));
  }

  beginLaunch(id: string): boolean {
    this.requireInitialized();
    return (
      this.db
        .prepare(
          "UPDATE assignments SET state = 'launching' WHERE id = ? AND state = 'pending' RETURNING id",
        )
        .get(id) !== undefined
    );
  }

  attachConversation(
    assignmentId: string,
    hostKey: string,
    externalConversationId: string,
  ): void {
    this.requireHost(hostKey);
    const conversationId = z
      .string()
      .min(1)
      .max(512)
      .parse(externalConversationId);
    this.transaction(() => {
      const assignment = this.get(assignmentId);
      const existing = this.getConversationBinding(assignmentId);
      if (existing) {
        if (
          existing.hostKey !== hostKey ||
          existing.externalConversationId !== conversationId
        )
          throw new Error(
            "Assignment already has a different host conversation",
          );
        return;
      }
      if (assignment.state !== "launching")
        throw new Error("Assignment has no launch intent");
      this.db
        .prepare(
          "INSERT INTO conversation_bindings (assignmentId, hostKey, externalConversationId) VALUES (?, ?, ?)",
        )
        .run(assignmentId, hostKey, conversationId);
      this.db
        .prepare(
          "UPDATE assignments SET state = 'running' WHERE id = ? AND state = 'launching'",
        )
        .run(assignmentId);
    });
  }

  captureInstructions(assignmentId: string, instructions: string): Assignment {
    this.requireInitialized();
    const text = instructionsSchema.parse(instructions);
    this.db
      .prepare(
        "UPDATE assignments SET instructions = ? WHERE id = ? AND state = 'pending' AND instructions IS NULL",
      )
      .run(text, assignmentId);
    return this.get(assignmentId);
  }

  complete(
    id: string,
    projectId: string,
    hostKey: string,
    externalConversationId: string,
    result: string,
  ): Assignment {
    this.requireHost(hostKey);
    const output = z.string().trim().min(1).max(16000).parse(result);
    const assignment = this.get(id);
    const binding = this.getConversationBinding(id);
    if (
      assignment.projectId !== projectId ||
      !binding ||
      binding.hostKey !== hostKey ||
      binding.externalConversationId !== externalConversationId
    )
      throw new Error(
        "Only the assigned host conversation can report its result",
      );
    if (assignment.state === "completed") {
      if (assignment.result !== output)
        throw new Error("A different result is already recorded");
      return assignment;
    }
    if (assignment.state !== "running")
      throw new Error("Assignment is not running");
    this.db
      .prepare(
        "UPDATE assignments SET state = 'completed', result = ? WHERE id = ?",
      )
      .run(output, id);
    return this.get(id);
  }

  private getProjectInstructions(projectId: string): string | null | undefined {
    const row = this.db
      .prepare("SELECT instructions FROM projects WHERE id = ?")
      .get(projectId);
    return row === undefined
      ? undefined
      : z.object({ instructions: z.string().nullable() }).parse(row)
          .instructions;
  }

  private hasProject(projectId: string): boolean {
    return (
      this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) !==
      undefined
    );
  }

  private requireHost(hostKey: string): void {
    this.requireInitialized();
    if (hostKey !== this.hostKey)
      throw new Error("Host key does not match this installation");
  }

  private requireInitialized(): void {
    if (!this.hostKey)
      throw new Error("Initialize storage with ensureHost(kind) first");
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the migration or command error that triggered rollback.
      }
      throw error;
    }
  }

  private createLegacyTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      projectId TEXT NOT NULL, brief TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','launching','running','completed')),
      threadId TEXT UNIQUE, result TEXT,
      UNIQUE(taskId)
    );`);
  }

  private createCoreTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_installation (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      hostKind TEXT NOT NULL,
      hostKey TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      instructions TEXT
    );
    CREATE TABLE IF NOT EXISTS project_host_bindings (
      projectId TEXT NOT NULL REFERENCES projects(id),
      hostKey TEXT NOT NULL REFERENCES host_installation(hostKey),
      externalProjectId TEXT NOT NULL,
      coordinatorConversationId TEXT,
      PRIMARY KEY(projectId, hostKey),
      UNIQUE(hostKey, externalProjectId)
    );
    CREATE TABLE IF NOT EXISTS conversation_bindings (
      assignmentId TEXT PRIMARY KEY REFERENCES assignments(id),
      hostKey TEXT NOT NULL REFERENCES host_installation(hostKey),
      externalConversationId TEXT NOT NULL,
      UNIQUE(hostKey, externalConversationId)
    );`);
  }

  private addInstructionsColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(assignments)").all();
    const hasInstructions = columns.some(
      (column) =>
        z.object({ name: z.string() }).parse(column).name === "instructions",
    );
    if (!hasInstructions)
      this.db.exec("ALTER TABLE assignments ADD COLUMN instructions TEXT");
  }

  private migrateLegacyBindings(hostKey: string): void {
    const invalidAssignments = this.db
      .prepare(
        "SELECT a.id FROM assignments a JOIN tasks t ON t.id = a.taskId WHERE a.projectId <> t.projectId",
      )
      .all();
    if (invalidAssignments.length)
      throw new Error("Legacy assignments contain mismatched task projects");

    const projects = this.db
      .prepare(
        "SELECT projectId FROM tasks UNION SELECT projectId FROM assignments",
      )
      .all()
      .map((row) => z.object({ projectId: z.string() }).parse(row).projectId);
    const insertProject = this.db.prepare(
      "INSERT INTO projects (id, instructions) VALUES (?, NULL)",
    );
    const insertBinding = this.db.prepare(
      "INSERT INTO project_host_bindings (projectId, hostKey, externalProjectId, coordinatorConversationId) VALUES (?, ?, ?, NULL)",
    );
    for (const projectId of projects) {
      insertProject.run(projectId);
      insertBinding.run(projectId, hostKey, projectId);
    }

    const legacyConversations = this.db
      .prepare(
        "SELECT id, projectId, threadId FROM assignments WHERE threadId IS NOT NULL",
      )
      .all();
    for (const row of legacyConversations) {
      const legacy = z
        .object({ id: z.string(), projectId: z.string(), threadId: z.string() })
        .parse(row);
      this.db
        .prepare(
          "INSERT INTO conversation_bindings (assignmentId, hostKey, externalConversationId) VALUES (?, ?, ?)",
        )
        .run(legacy.id, hostKey, legacy.threadId);
    }
  }

  private validatePersistedRows(): void {
    const tasks = this.db
      .prepare("SELECT id, projectId, title FROM tasks")
      .all();
    for (const task of tasks) taskSchema.parse(task);
    const assignments = this.db
      .prepare(
        "SELECT id, taskId, projectId, brief, state, instructions, result FROM assignments",
      )
      .all();
    for (const assignment of assignments) assignmentSchema.parse(assignment);
    const projects = this.db
      .prepare(
        "SELECT projectId, hostKey, externalProjectId, coordinatorConversationId FROM project_host_bindings",
      )
      .all();
    for (const binding of projects) projectBindingSchema.parse(binding);
    const conversations = this.db
      .prepare(
        "SELECT assignmentId, hostKey, externalConversationId FROM conversation_bindings",
      )
      .all();
    for (const binding of conversations)
      conversationBindingSchema.parse(binding);
  }
}
