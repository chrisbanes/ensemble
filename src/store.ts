import { z } from "zod";

// Both BB's better-sqlite3 handle and node:sqlite implement this small surface.
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: string[]): unknown;
    get(...parameters: string[]): unknown;
    all(...parameters: string[]): unknown[];
  };
}

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
  threadId: z.string().nullable(),
  result: z.string().nullable(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export class Store {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
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

  createTask(id: string, projectId: string, title: string) {
    const existing = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id);
    if (existing) {
      const task = taskSchema.parse(existing);
      if (task.projectId !== projectId || task.title !== title)
        throw new Error("Task ID already used with different content");
      return task;
    }
    this.db
      .prepare("INSERT INTO tasks VALUES (?, ?, ?)")
      .run(id, projectId, title);
    return { id, projectId, title };
  }

  assign(
    id: string,
    taskId: string,
    projectId: string,
    brief: string,
  ): Assignment {
    const task = taskSchema.parse(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId),
    );
    if (task.projectId !== projectId)
      throw new Error("Task belongs to another project");
    const existing = this.db
      .prepare("SELECT * FROM assignments WHERE id = ?")
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
    this.db
      .prepare(
        "INSERT INTO assignments VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
      )
      .run(id, taskId, projectId, brief);
    return this.get(id);
  }

  get(id: string): Assignment {
    return assignmentSchema.parse(
      this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(id),
    );
  }

  list(projectId?: string): Assignment[] {
    const rows =
      projectId === undefined
        ? this.db.prepare("SELECT * FROM assignments ORDER BY id").all()
        : this.db
            .prepare(
              "SELECT * FROM assignments WHERE projectId = ? ORDER BY id",
            )
            .all(projectId);
    return rows.map((row) => assignmentSchema.parse(row));
  }

  beginLaunch(id: string): boolean {
    // UPDATE RETURNING gives one claimant even with multiple callers/handles.
    return (
      this.db
        .prepare(
          "UPDATE assignments SET state = 'launching' WHERE id = ? AND state = 'pending' RETURNING id",
        )
        .get(id) !== undefined
    );
  }

  attach(id: string, threadId: string): void {
    const assignment = this.get(id);
    if (assignment.threadId !== null && assignment.threadId !== threadId)
      throw new Error("Assignment already has a different thread");
    if (assignment.state !== "launching" && assignment.threadId !== threadId)
      throw new Error("Assignment has no launch intent");
    this.db
      .prepare(
        "UPDATE assignments SET threadId = ?, state = 'running' WHERE id = ? AND state = 'launching'",
      )
      .run(threadId, id);
  }

  complete(
    id: string,
    projectId: string,
    threadId: string,
    result: string,
  ): Assignment {
    const assignment = this.get(id);
    if (assignment.projectId !== projectId || assignment.threadId !== threadId)
      throw new Error("Only the assigned thread can report its result");
    if (assignment.state === "completed") {
      if (assignment.result !== result)
        throw new Error("A different result is already recorded");
      return assignment;
    }
    if (assignment.state !== "running")
      throw new Error("Assignment is not running");
    this.db
      .prepare(
        "UPDATE assignments SET state = 'completed', result = ? WHERE id = ?",
      )
      .run(result, id);
    return this.get(id);
  }
}
