import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const standaloneProgram = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator, EnsembleService, Store } from "./dist/src/core/index.js";

assert.throws(() => import.meta.resolve("@get-bb/plugin-sdk"), /ERR_MODULE_NOT_FOUND/);
assert.equal(existsSync(resolve("dist/src/adapters/bb/plugin.js")), false);
assert.ok(fileURLToPath(import.meta.resolve("zod")).startsWith(resolve("node_modules/zod") + sep));

const database = resolve("ensemble.db");
const projectId = "10000000-0000-4000-8000-000000000001";
const firstTaskId = "20000000-0000-4000-8000-000000000001";
const firstAssignmentId = "30000000-0000-4000-8000-000000000001";
const lostTaskId = "20000000-0000-4000-8000-000000000002";
const lostAssignmentId = "30000000-0000-4000-8000-000000000002";
const zeroTaskId = "20000000-0000-4000-8000-000000000003";
const zeroAssignmentId = "30000000-0000-4000-8000-000000000003";
const ambiguousTaskId = "20000000-0000-4000-8000-000000000004";
const ambiguousAssignmentId = "30000000-0000-4000-8000-000000000004";
let spawnCount = 0;
let lostAssignment = undefined;
const matches = new Map();

function openStore() {
  const db = new DatabaseSync(database);
  const store = new Store(db);
  const hostKey = store.ensureHost("fake");
  return { db, store, hostKey };
}

function fakeHost(findOverride = undefined) {
  return {
    async spawn(assignment) {
      spawnCount++;
      const conversationId = "worker-" + assignment.id;
      matches.set(assignment.id, [conversationId]);
      if (assignment.id === lostAssignment)
        throw new Error("spawn response lost");
      return conversationId;
    },
    async find(assignment) {
      return findOverride ? findOverride(assignment) : (matches.get(assignment.id) ?? []);
    },
  };
}

function createService(store, hostKey, host) {
  const coordinator = new Coordinator(store, host, hostKey);
  const service = new EnsembleService(store, coordinator, {
    hostKey,
    async getConfiguration() {
      return {
        externalProjectId: "external-project",
        coordinatorConversationId: "lead",
        instructions: "Standalone instructions",
      };
    },
    async validateLaunch() {},
  });
  return { coordinator, service };
}

let open = openStore();
let openDatabase = true;
function closeDatabase() {
  if (!openDatabase) return;
  open.db.close();
  openDatabase = false;
}
function reopenDatabase() {
  closeDatabase();
  open = openStore();
  openDatabase = true;
}
try {
  const binding = open.store.bindProject(open.hostKey, "external-project", "lead");
  open.store.setProjectInstructions(binding.projectId, "Standalone instructions");
  assert.notEqual(binding.projectId, "external-project");
  const caller = {
    hostKey: open.hostKey,
    externalProjectId: "external-project",
    externalConversationId: "lead",
  };
  const { service } = createService(open.store, open.hostKey, fakeHost());
  await service.createTask(caller, { id: firstTaskId, title: "Standalone task" });
  const first = await service.delegate(caller, {
    id: firstAssignmentId,
    taskId: firstTaskId,
    brief: "Complete without BB",
  });
  assert.equal(first.projectId, binding.projectId);
  assert.equal(first.state, "running");
  assert.equal(first.instructions, "Standalone instructions");
  const firstResult = await service.report(
    { ...caller, externalConversationId: "worker-" + firstAssignmentId },
    { assignmentId: firstAssignmentId, result: "Standalone result" },
  );
  assert.equal(firstResult.state, "completed");
  reopenDatabase();
  assert.equal(open.hostKey, caller.hostKey);
  assert.equal(open.store.resolveProject(open.hostKey, "external-project").projectId, binding.projectId);
  assert.equal(open.store.get(firstAssignmentId).result, "Standalone result");
  const lostHost = fakeHost();
  const lost = createService(open.store, open.hostKey, lostHost);
  await lost.service.createTask(caller, { id: lostTaskId, title: "Lost response" });
  lostAssignment = lostAssignmentId;
  await assert.rejects(
    lost.service.delegate(caller, {
      id: lostAssignmentId,
      taskId: lostTaskId,
      brief: "Reconcile after reopen",
    }),
    /spawn response lost/,
  );
  assert.equal(open.store.get(lostAssignmentId).state, "launching");
  reopenDatabase();
  const restartedHost = fakeHost();
  const restarted = createService(open.store, open.hostKey, restartedHost);
  await restarted.service.reconcile();
  assert.equal(open.store.get(lostAssignmentId).state, "running");
  assert.equal(
    open.store.getConversationBinding(lostAssignmentId)?.externalConversationId,
    "worker-" + lostAssignmentId,
  );
  await restarted.service.report(
    { ...caller, externalConversationId: "worker-" + lostAssignmentId },
    { assignmentId: lostAssignmentId, result: "Recovered result" },
  );
  const beforeReplay = spawnCount;
  const replay = await restarted.service.delegate(caller, {
    id: lostAssignmentId,
    taskId: lostTaskId,
    brief: "Reconcile after reopen",
  });
  assert.equal(replay.state, "completed");
  assert.equal(replay.result, "Recovered result");
  assert.equal(spawnCount, beforeReplay);
  assert.equal(open.store.get(lostAssignmentId).id, lostAssignmentId);

  await restarted.service.createTask(caller, { id: zeroTaskId, title: "No match" });
  open.store.assign(zeroAssignmentId, zeroTaskId, binding.projectId, "Wait for recovery");
  open.store.beginLaunch(zeroAssignmentId);
  const zero = createService(open.store, open.hostKey, fakeHost(() => []));
  await zero.service.reconcile();
  const spawnCountBeforeZeroReplay = spawnCount;
  const zeroReplay = await zero.service.delegate(caller, {
    id: zeroAssignmentId,
    taskId: zeroTaskId,
    brief: "Wait for recovery",
  });
  assert.equal(zeroReplay.state, "launching");
  assert.equal(spawnCount, spawnCountBeforeZeroReplay);

  await restarted.service.createTask(caller, { id: ambiguousTaskId, title: "Multiple matches" });
  open.store.assign(ambiguousAssignmentId, ambiguousTaskId, binding.projectId, "Hold ambiguity");
  open.store.beginLaunch(ambiguousAssignmentId);
  const ambiguous = createService(
    open.store,
    open.hostKey,
    fakeHost((assignment) =>
      assignment.id === ambiguousAssignmentId ? ["duplicate-one", "duplicate-two"] : [],
    ),
  );
  await assert.rejects(ambiguous.service.reconcile(), /Multiple host conversations/);
  const spawnCountBeforeAmbiguousReplay = spawnCount;
  const ambiguousReplay = await ambiguous.service.delegate(caller, {
    id: ambiguousAssignmentId,
    taskId: ambiguousTaskId,
    brief: "Hold ambiguity",
  });
  assert.equal(ambiguousReplay.state, "launching");
  assert.equal(spawnCount, spawnCountBeforeAmbiguousReplay);

  await assert.rejects(
    restarted.service.createTask({ ...caller, hostKey: "10000000-0000-4000-8000-000000000099" }, {
      id: "20000000-0000-4000-8000-000000000005",
      title: "Foreign host",
    }),
    /execution host/,
  );
  await assert.rejects(
    restarted.service.createTask({ ...caller, externalProjectId: "foreign-project" }, {
      id: "20000000-0000-4000-8000-000000000006",
      title: "Foreign project",
    }),
    /coordinator project/,
  );
  await assert.rejects(
    restarted.service.createTask({ ...caller, externalConversationId: "worker" }, {
      id: "20000000-0000-4000-8000-000000000007",
      title: "Foreign conversation",
    }),
    /coordinator conversation/,
  );
  await assert.rejects(
    restarted.service.createTask({ ...caller, role: "coordinator" }, {
      id: "20000000-0000-4000-8000-000000000008",
      title: "Spoofed role",
    }),
    /Unrecognized key/,
  );
  process.stdout.write("standalone-core-ok");
} finally {
  closeDatabase();
}
`;

test("compiled core runs through authorization and recovery with BB unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-core-standalone-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    const coreDirectory = join(directory, "dist", "src", "core");
    mkdirSync(coreDirectory, { recursive: true });
    cpSync(resolve(process.cwd(), "dist/src/core"), coreDirectory, {
      recursive: true,
    });
    const zodDirectory = join(directory, "node_modules", "zod");
    mkdirSync(join(directory, "node_modules"), { recursive: true });
    cpSync(resolve(process.cwd(), "node_modules/zod"), zodDirectory, {
      recursive: true,
    });
    const runner = join(directory, "standalone.mjs");
    writeFileSync(runner, standaloneProgram);
    assert.equal(
      existsSync(join(directory, "node_modules", "@get-bb", "plugin-sdk")),
      false,
    );

    const result = spawnSync(process.execPath, [runner], {
      cwd: directory,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /standalone-core-ok/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
