import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Coordinator, type WorkerHost } from "../src/core/coordinator.js";
import { Store } from "../src/core/store.js";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "ensemble-"));
  const filename = join(path, "test.db");
  let db = new DatabaseSync(filename);
  const store = new Store(db);
  const hostKey = store.ensureHost("fake");
  const projectId = store.bindProject(hostKey, "project", "lead").projectId;
  store.setProjectInstructions(projectId, "Default worker instructions");
  return {
    store,
    hostKey,
    projectId,
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      const reopened = new Store(db);
      reopened.ensureHost("fake");
      return reopened;
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
    f.store.createTask("task", f.projectId, "Investigate");
    f.store.assign("assignment", "task", f.projectId, "Find the cause");
    const c = new Coordinator(
      f.store,
      {
        spawn: async () => "worker",
        find: async () => [],
      },
      f.hostKey,
    );
    await c.launch("assignment");
    f.store.complete(
      "assignment",
      f.projectId,
      f.hostKey,
      "worker",
      "Found the cause",
    );
    const reopened = f.reopen();
    assert.equal(reopened.get("assignment").result, "Found the cause");
    assert.equal(reopened.get("assignment").state, "completed");
    assert.deepEqual(reopened.createTask("task", f.projectId, "Investigate"), {
      id: "task",
      projectId: f.projectId,
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
    f.store.createTask("task", f.projectId, "Investigate");
    f.store.assign("assignment", "task", f.projectId, "Find the cause");
    await assert.rejects(
      new Coordinator(f.store, host, f.hostKey).launch("assignment"),
    );
    const reopened = f.reopen();
    const restarted = new Coordinator(reopened, host, f.hostKey);
    await restarted.reconcile();
    await restarted.launch("assignment");
    assert.equal(spawns, 1);
    assert.equal(
      reopened.getConversationBinding("assignment")?.externalConversationId,
      "existing-worker",
    );
  } finally {
    f.close();
  }
});

test("an ambiguous launch with no match is held; duplicate matches require intervention", async () => {
  const f = fixture();
  try {
    f.store.createTask("task", f.projectId, "Investigate");
    f.store.assign("assignment", "task", f.projectId, "Find the cause");
    f.store.beginLaunch("assignment");
    const host = {
      spawn: async () => {
        throw new Error("must not spawn");
      },
      find: async () => [] as string[],
    };
    const c = new Coordinator(f.store, host, f.hostKey);
    await c.reconcile();
    assert.equal((await c.launch("assignment")).state, "launching");
    host.find = async () => ["one", "two"];
    await assert.rejects(c.reconcile(), /Multiple host conversations/);
  } finally {
    f.close();
  }
});

test("concurrent delegation launches once; foreign threads cannot report", async () => {
  const f = fixture();
  let spawns = 0;
  try {
    f.store.createTask("task", f.projectId, "Investigate");
    assert.throws(
      () => f.store.assign("wrong", "task", "other", "Find cause"),
      /another project/,
    );
    f.store.assign("assignment", "task", f.projectId, "Find cause");
    const c = new Coordinator(
      f.store,
      {
        spawn: async () => {
          spawns++;
          return "worker";
        },
        find: async () => [],
      },
      f.hostKey,
    );
    await Promise.all([c.launch("assignment"), c.launch("assignment")]);
    assert.equal(spawns, 1);
    assert.throws(
      () =>
        f.store.complete(
          "assignment",
          f.projectId,
          f.hostKey,
          "other-worker",
          "done",
        ),
      /Only the assigned/,
    );
    f.store.complete("assignment", f.projectId, f.hostKey, "worker", "done");
    assert.equal(
      f.store.complete("assignment", f.projectId, f.hostKey, "worker", "done")
        .result,
      "done",
    );
    assert.throws(
      () =>
        f.store.complete(
          "assignment",
          f.projectId,
          f.hostKey,
          "worker",
          "changed",
        ),
      /different result/,
    );
  } finally {
    f.close();
  }
});

test("ambiguous launches do not prevent later assignments from reconciling", async () => {
  const f = fixture();
  try {
    for (const id of ["a-ambiguous", "b-recoverable"]) {
      f.store.createTask(id, f.projectId, id);
      f.store.assign(id, id, f.projectId, "Investigate");
      f.store.beginLaunch(id);
    }
    const coordinator = new Coordinator(
      f.store,
      {
        spawn: async () => {
          throw new Error("must not spawn");
        },
        find: async (assignment) =>
          assignment.id === "a-ambiguous"
            ? ["duplicate-one", "duplicate-two"]
            : ["worker"],
      },
      f.hostKey,
    );
    await assert.rejects(coordinator.reconcile(), /a-ambiguous/);
    assert.equal(f.store.get("a-ambiguous").state, "launching");
    assert.equal(
      f.store.getConversationBinding("b-recoverable")?.externalConversationId,
      "worker",
    );
    assert.equal(
      f.store.complete(
        "b-recoverable",
        f.projectId,
        f.hostKey,
        "worker",
        "done",
      ).state,
      "completed",
    );
  } finally {
    f.close();
  }
});
