import { randomUUID } from "node:crypto";
import { z } from "zod";

type SqlValue = string | number | null;

// The storage contract is deliberately limited to the SQLite operations used here.
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: SqlValue[]): unknown;
    get(...parameters: SqlValue[]): unknown;
    all(...parameters: SqlValue[]): unknown[];
  };
}

const schemaVersion = 6;
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
export class Store {
  constructor(private readonly db: Database) {}

  ensureHost(kind: string): string {
    const hostKind = hostKindSchema.parse(kind);
    const version = schemaVersionSchema.parse(
      this.db.prepare("PRAGMA user_version").get(),
    ).user_version;
    if (version === 3 || version === 4 || version === 5) {
      const existingHost = hostInstallationSchema.parse(
        this.db
          .prepare(
            "SELECT hostKind, hostKey FROM host_installation WHERE singleton = 1",
          )
          .get(),
      );
      if (existingHost.hostKind !== hostKind)
        throw new Error(
          `Database is bound to execution host ${existingHost.hostKind}, not ${hostKind}`,
        );
      this.migrateExecutionStateToV6();
    }
    const hostKey = this.transaction(() => {
      const currentVersion = schemaVersionSchema.parse(
        this.db.prepare("PRAGMA user_version").get(),
      ).user_version;
      if (currentVersion > schemaVersion)
        throw new Error(
          `Database schema ${currentVersion} is newer than supported schema ${schemaVersion}`,
        );
      if (
        currentVersion !== 0 &&
        currentVersion !== 2 &&
        currentVersion !== schemaVersion
      )
        throw new Error(
          `Database schema ${currentVersion} requires a fresh database`,
        );

      if (currentVersion === 0) {
        if (
          this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
            )
            .get()
        )
          throw new Error(
            "Existing unversioned database requires a fresh database",
          );
        this.createTables();
        this.createCoreTables();
        this.createExecutionTables();
        const host = { hostKind, hostKey: randomUUID() };
        this.db
          .prepare(
            "INSERT INTO host_installation (singleton, hostKind, hostKey) VALUES (1, ?, ?)",
          )
          .run(host.hostKind, host.hostKey);
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
      if (currentVersion === 2) {
        this.createExecutionTables();
        this.db.exec(`PRAGMA user_version = ${schemaVersion}`);
      }
      return host.hostKey;
    });
    return hostKey;
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

  private createTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      projectId TEXT NOT NULL, brief TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','launching','running','completed')),
      result TEXT, instructions TEXT,
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

  private createExecutionTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_intents (
      id TEXT PRIMARY KEY,
      workId TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      workspace TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','capacity-waiting','held','submitting','running','completed','reconciled','resolved-failed')),
      reason TEXT,
      threadId TEXT,
      turnId TEXT,
      accountType TEXT NOT NULL,
      sandbox TEXT NOT NULL CHECK(sandbox = 'workspaceWrite'),
      approval TEXT NOT NULL CHECK(approval = 'never')
    );`);
  }

  private migrateExecutionStateToV6(): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE execution_intents_v6 (
          id TEXT PRIMARY KEY,
          workId TEXT NOT NULL UNIQUE,
          prompt TEXT NOT NULL,
          workspace TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('ready','capacity-waiting','held','submitting','running','completed','reconciled','resolved-failed')),
          reason TEXT,
          threadId TEXT,
          turnId TEXT,
          accountType TEXT NOT NULL,
          sandbox TEXT NOT NULL CHECK(sandbox = 'workspaceWrite'),
          approval TEXT NOT NULL CHECK(approval = 'never')
        );
        INSERT INTO execution_intents_v6 SELECT * FROM execution_intents;
        DROP TABLE execution_intents;
        ALTER TABLE execution_intents_v6 RENAME TO execution_intents;
        PRAGMA user_version = ${schemaVersion}`);
        if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0)
          throw new Error("Execution state migration broke a foreign key");
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
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
