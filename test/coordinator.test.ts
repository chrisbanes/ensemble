import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Coordinator, type WorkerHost } from "../src/coordinator.js";
import { Store } from "../src/store.js";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "ensemble-"));
  const filename = join(path, "test.db");
  let db = new DatabaseSync(filename);
  return {
    store: new Store(db),
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      return new Store(db);
    },
    close() {
      db.close();
      rmSync(path, { recursive: true });
    },
  };
}

test("local task, worker result, and identity survive a database reopen", async () => {
  const f = fixture();
  try {
    f.store.createTask("task", "project", "Investigate");
    f.store.assign("assignment", "task", "project", "Find the cause");
    const c = new Coordinator(f.store, {
      spawn: async () => "worker",
      find: async () => [],
    });
    await c.launch("assignment");
    f.store.complete("assignment", "project", "worker", "Found the cause");
    const reopened = f.reopen();
    assert.equal(reopened.get("assignment").result, "Found the cause");
    assert.equal(reopened.get("assignment").state, "completed");
    assert.deepEqual(reopened.createTask("task", "project", "Investigate"), {
      id: "task",
      projectId: "project",
      title: "Investigate",
    });
  } finally {
    f.close();
  }
});

test("lost spawn response is reconciled after restart without a second worker", async () => {
  const f = fixture();
  let spawns = 0;
  const host: WorkerHost = {
    async spawn() {
      spawns++;
      throw new Error("response lost after BB created worker");
    },
    async find() {
      return ["existing-worker"];
    },
  };
  try {
    f.store.createTask("task", "project", "Investigate");
    f.store.assign("assignment", "task", "project", "Find the cause");
    await assert.rejects(new Coordinator(f.store, host).launch("assignment"));
    const reopened = f.reopen();
    const restarted = new Coordinator(reopened, host);
    await restarted.reconcile();
    await restarted.launch("assignment");
    assert.equal(spawns, 1);
    assert.equal(reopened.get("assignment").threadId, "existing-worker");
  } finally {
    f.close();
  }
});

test("an ambiguous launch with no match is held; duplicate matches require intervention", async () => {
  const f = fixture();
  try {
    f.store.createTask("task", "project", "Investigate");
    f.store.assign("assignment", "task", "project", "Find the cause");
    f.store.beginLaunch("assignment");
    const host = {
      spawn: async () => {
        throw new Error("must not spawn");
      },
      find: async () => [] as string[],
    };
    const c = new Coordinator(f.store, host);
    await c.reconcile();
    assert.equal((await c.launch("assignment")).state, "launching");
    host.find = async () => ["one", "two"];
    await assert.rejects(c.reconcile(), /Multiple BB threads/);
  } finally {
    f.close();
  }
});

test("concurrent delegation launches once; foreign threads cannot report", async () => {
  const f = fixture();
  let spawns = 0;
  try {
    f.store.createTask("task", "project", "Investigate");
    assert.throws(
      () => f.store.assign("wrong", "task", "other", "Find cause"),
      /another project/,
    );
    f.store.assign("assignment", "task", "project", "Find cause");
    const c = new Coordinator(f.store, {
      spawn: async () => {
        spawns++;
        return "worker";
      },
      find: async () => [],
    });
    await Promise.all([c.launch("assignment"), c.launch("assignment")]);
    assert.equal(spawns, 1);
    assert.throws(
      () => f.store.complete("assignment", "project", "other-worker", "done"),
      /Only the assigned/,
    );
    f.store.complete("assignment", "project", "worker", "done");
    assert.equal(
      f.store.complete("assignment", "project", "worker", "done").result,
      "done",
    );
    assert.throws(
      () => f.store.complete("assignment", "project", "worker", "changed"),
      /different result/,
    );
  } finally {
    f.close();
  }
});
