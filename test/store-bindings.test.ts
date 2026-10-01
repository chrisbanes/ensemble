import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/core/store.js";

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

test("host identity persists across reopen and rejects a different host", () => {
  const f = fixture();
  try {
    const store = new Store(f.db);
    const hostKey = store.ensureHost("fake");
    assert.throws(() => store.ensureHost("other"), /host/i);

    const reopened = new Store(f.reopen());
    assert.equal(reopened.ensureHost("fake"), hostKey);
    assert.throws(() => reopened.ensureHost("other"), /host/i);
  } finally {
    f.close();
  }
});

test("new database creates assignments without host-specific columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("fake");
    const columns = db.prepare("PRAGMA table_info(assignments)").all();
    assert.deepEqual(
      columns.map((column) => column.name),
      ["id", "taskId", "projectId", "brief", "state", "result", "instructions"],
    );
  } finally {
    db.close();
  }
});

test("previous and unversioned databases are not opened as fresh installations", () => {
  for (const version of [0, 1]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('preserve'); PRAGMA user_version = ${version};`,
      );
      assert.throws(() => new Store(db).ensureHost("fake"), /fresh database/);
      assert.equal(
        db.prepare("SELECT value FROM marker").get()?.value,
        "preserve",
      );
      assert.equal(
        db.prepare("PRAGMA user_version").get()?.user_version,
        version,
      );
    } finally {
      db.close();
    }
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
