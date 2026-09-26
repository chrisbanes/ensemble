import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Coordinator } from "../src/core/coordinator.js";
import { Store, type Database } from "../src/core/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-bindings-"));
  const filename = join(directory, "ensemble.db");
  let db = new DatabaseSync(filename);
  return {
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      return db;
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createLegacySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      projectId TEXT NOT NULL, brief TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','launching','running','completed')),
      threadId TEXT UNIQUE, result TEXT,
      UNIQUE(taskId)
    );
  `);
  const task = db.prepare("INSERT INTO tasks VALUES (?, ?, ?)");
  const assignment = db.prepare(
    "INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const rows: [string, string, string | null, string | null][] = [
    ["legacy-pending", "pending", null, null],
    ["legacy-launching", "launching", null, null],
    ["legacy-running", "running", "legacy-worker-running", null],
    [
      "legacy-completed",
      "completed",
      "legacy-worker-completed",
      "legacy result",
    ],
  ];
  for (const [id, state, conversationId, result] of rows) {
    task.run(`task-${id}`, "legacy-host-project", id);
    assignment.run(
      id,
      `task-${id}`,
      "legacy-host-project",
      `brief-${id}`,
      state,
      conversationId,
      result,
    );
  }
}

test("project bindings distinguish Ensemble identity and persist one host across reopen", () => {
  const f = fixture();
  try {
    const store = new Store(f.db);
    assert.throws(
      () => store.createTask("task", "project", "Not initialized"),
      /ensureHost/,
    );
    const hostKey = store.ensureHost("fake");
    const binding = store.bindProject(hostKey, "host-project", "lead");
    assert.notEqual(binding.projectId, "host-project");
    assert.equal(binding.externalProjectId, "host-project");
    assert.equal(binding.coordinatorConversationId, "lead");

    const repeated = store.bindProject(
      hostKey,
      "host-project",
      "replacement-lead",
    );
    assert.equal(repeated.projectId, binding.projectId);
    assert.equal(repeated.coordinatorConversationId, "replacement-lead");
    assert.equal(
      store.resolveProject(hostKey, "host-project").projectId,
      binding.projectId,
    );
    assert.deepEqual(store.getProjectBinding(binding.projectId), repeated);
    assert.throws(
      () => store.bindProject("foreign-host-key", "host-project", "lead"),
      /host/i,
    );
    assert.throws(() => store.ensureHost("bb"), /host/i);

    const reopened = new Store(f.reopen());
    assert.equal(reopened.ensureHost("fake"), hostKey);
    assert.equal(
      reopened.resolveProject(hostKey, "host-project").projectId,
      binding.projectId,
    );
  } finally {
    f.close();
  }
});

test("legacy assignments and results migrate to explicit host bindings idempotently", async () => {
  const f = fixture();
  try {
    createLegacySchema(f.db);
    const store = new Store(f.db);
    const hostKey = store.ensureHost("fake");
    const binding = store.resolveProject(hostKey, "legacy-host-project");
    assert.equal(binding.projectId, "legacy-host-project");

    const pending = store.get("legacy-pending");
    assert.equal(pending.state, "pending");
    assert.equal(pending.instructions, null);
    assert.equal(store.getConversationBinding(pending.id), undefined);
    const launching = store.get("legacy-launching");
    assert.equal(launching.state, "launching");
    assert.equal(launching.instructions, null);
    assert.equal(store.getConversationBinding(launching.id), undefined);
    const running = store.get("legacy-running");
    assert.equal(running.state, "running");
    assert.deepEqual(store.getConversationBinding(running.id), {
      assignmentId: running.id,
      hostKey,
      externalConversationId: "legacy-worker-running",
    });
    const completed = store.get("legacy-completed");
    assert.equal(completed.state, "completed");
    assert.equal(completed.result, "legacy result");
    assert.equal(
      store.getConversationBinding(completed.id)?.externalConversationId,
      "legacy-worker-completed",
    );

    const reopened = new Store(f.reopen());
    assert.equal(reopened.ensureHost("fake"), hostKey);
    assert.equal(reopened.get("legacy-completed").result, "legacy result");
    assert.equal(reopened.list(binding.projectId).length, 4);
    let spawnCount = 0;
    const coordinator = new Coordinator(
      reopened,
      {
        async spawn() {
          spawnCount++;
          return "must-not-spawn";
        },
        async find(assignment) {
          return assignment.id === "legacy-launching"
            ? ["recovered-worker"]
            : [];
        },
      },
      hostKey,
    );
    await coordinator.reconcile();
    assert.equal(spawnCount, 0);
    assert.equal(reopened.get("legacy-launching").state, "running");
    assert.equal(
      reopened.getConversationBinding("legacy-launching")
        ?.externalConversationId,
      "recovered-worker",
    );
  } finally {
    f.close();
  }
});

test("failed legacy migration rolls back schema and records", () => {
  const f = fixture();
  try {
    createLegacySchema(f.db);
    const failingDatabase: Database = {
      exec(sql) {
        return f.db.exec(sql);
      },
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          run(...parameters) {
            if (/INSERT INTO project_host_bindings/i.test(sql))
              throw new Error("injected binding migration failure");
            return statement.run(...parameters);
          },
          get(...parameters) {
            return statement.get(...parameters);
          },
          all(...parameters) {
            return statement.all(...parameters);
          },
        };
      },
    };
    assert.throws(
      () => new Store(failingDatabase).ensureHost("fake"),
      /injected binding migration failure/,
    );
    assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'projects'",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      f.db
        .prepare("SELECT result FROM assignments WHERE id = ?")
        .get("legacy-completed")?.result,
      "legacy result",
    );
  } finally {
    f.close();
  }
});

test("newer database schemas are rejected without changing records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('preserve'); PRAGMA user_version = 9;",
    );
    assert.throws(
      () => new Store(db).ensureHost("fake"),
      /newer than supported/,
    );
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 9);
    assert.equal(
      db.prepare("SELECT value FROM marker").get()?.value,
      "preserve",
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'host_installation'",
        )
        .get()?.count,
      0,
    );
  } finally {
    db.close();
  }
});
