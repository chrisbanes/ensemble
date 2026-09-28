import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StandaloneService } from "../src/standalone/service.js";
import { ExecutionState } from "../src/standalone/state.js";
import type { Runtime, UnexpectedRequest } from "../src/standalone/codex.js";

class RuntimeFixture implements Runtime {
  starts = 0;
  turns = 0;
  outcome: "completed" | "failed" = "completed";
  entered?: () => void;
  gate?: Promise<void>;
  anomaly?: (event: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  async start() {}
  async stop() {}
  async startThread() {
    return `thread-${++this.starts}`;
  }
  async resumeThread() {}
  async startTurn() {
    return `turn-${++this.turns}`;
  }
  async waitForTurn() {
    this.entered?.();
    await this.gate;
    return this.outcome;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onTerminalAnomaly(
    listener: (event: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ) {
    this.anomaly = listener;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ensemble-task-writer-"));
  const runtime = new RuntimeFixture();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  await service.start();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  execute({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  execute({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  execute({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Task",
    outcome: "Deliver",
    ready: true,
  });
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const workspace = await service.provisionTask(taskId);
  assert.equal(workspace.state, "ready");
  return {
    root,
    service,
    runtime,
    taskId,
    assignmentId,
    projectId,
    execute,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("task writer admits one successor; waiting turns hold no reservation", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const first = f.service.submitTask("first", f.assignmentId, "write");
    await entered.promise;
    assert.equal(f.service.recordTaskResult("first", "early"), false);
    const waiting = await f.service.submitTask(
      "waiting",
      f.assignmentId,
      "next",
    );
    assert.equal(waiting.state, "ready");
    assert.equal(f.runtime.starts, 1);
    gate.resolve();
    assert.equal((await first).state, "completed");
    assert.equal(f.service.isCurrentResult("first"), true);
    assert.equal(f.service.recordTaskResult("first", "done"), true);
    const nextGate = deferred();
    const nextEntered = deferred();
    f.runtime.gate = nextGate.promise;
    f.runtime.entered = nextEntered.resolve;
    const successor = f.service.submitTask("waiting", f.assignmentId, "next");
    await nextEntered.promise;
    const competing = await f.service.submitTask(
      "third",
      f.assignmentId,
      "later",
    );
    assert.equal(competing.state, "ready");
    assert.equal(f.runtime.starts, 2);
    nextGate.resolve();
    assert.equal((await successor).state, "completed");
  } finally {
    await f.close();
  }
});

test("a follow-up queued before its predecessor finishes stays unreserved", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const first = f.service.submitTask("first", f.assignmentId, "write");
    await entered.promise;
    assert.equal(
      (
        await f.service.submitTask(
          "follow",
          f.assignmentId,
          "continue",
          "first",
        )
      ).state,
      "ready",
    );
    gate.resolve();
    assert.equal((await first).state, "completed");
    assert.equal(
      (
        await f.service.submitTask(
          "follow",
          f.assignmentId,
          "continue",
          "first",
        )
      ).state,
      "completed",
    );
    assert.equal(f.runtime.starts, 1);
    assert.equal(f.runtime.turns, 2);
  } finally {
    await f.close();
  }
});

test("failure, known survivor and unfinished callback retain task writer holds", async () => {
  const f = await fixture();
  try {
    f.runtime.outcome = "failed";
    assert.equal(
      (await f.service.submitTask("failed", f.assignmentId, "write")).state,
      "held",
    );
    assert.equal(
      (await f.service.submitTask("waiting", f.assignmentId, "next")).state,
      "ready",
    );
    assert.equal(f.runtime.starts, 1);
    const archived = await f.service.archiveTask(f.taskId, {
      deliveryConfirmed: true,
      writerOwnershipResolved: true,
      handoffsPreserved: true,
      reconciliationEvidencePreserved: true,
      workspaceContentsPreserved: true,
    });
    assert.equal(archived.outcome, "retained");
  } finally {
    await f.close();
  }

  const survivor = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    survivor.runtime.gate = gate.promise;
    survivor.runtime.entered = entered.resolve;
    const first = survivor.service.submitTask(
      "survivor",
      survivor.assignmentId,
      "write",
    );
    await entered.promise;
    survivor.service.holdKnownSurvivor("survivor", "child still running");
    gate.resolve();
    const held = await first;
    assert.equal(held.state, "held");
    assert.match(held.reason ?? "", /child still running/);
    assert.equal(
      (
        await survivor.service.submitTask(
          "other",
          survivor.assignmentId,
          "next",
        )
      ).state,
      "ready",
    );
  } finally {
    await survivor.close();
  }

  const callback = await fixture();
  try {
    const pending = deferred();
    callback.service.registerExecutionCallback("callback", pending.promise);
    const held = await callback.service.submitTask(
      "callback",
      callback.assignmentId,
      "write",
    );
    assert.equal(held.state, "held");
    assert.match(held.reason ?? "", /callback is unfinished/);
    pending.resolve();
  } finally {
    await callback.close();
  }
});

test("replacement retains assignment snapshots and rejects stale results", async () => {
  const f = await fixture();
  try {
    const first = await f.service.submitTask("first", f.assignmentId, "write");
    assert.equal(first.state, "completed");
    const before = f.service.domain().assignment(f.assignmentId);
    assert.equal(f.service.replaceConversation(f.assignmentId), 2);
    assert.equal(f.service.isCurrentResult("first"), false);
    assert.equal(f.service.recordTaskResult("first", "done"), false);
    const after = f.service.domain().assignment(f.assignmentId);
    assert.equal(after.version, before.version);
    assert.equal(after.instructionsRevision, before.instructionsRevision);
    assert.equal(after.profileRevision, before.profileRevision);
    await assert.rejects(
      f.service.submitTask("first", f.assignmentId, "write"),
      /another task or assignment revision/,
    );
    assert.equal(
      (
        await f.service.submitTask(
          "replacement",
          f.assignmentId,
          "continue",
          "first",
        )
      ).state,
      "completed",
    );
    assert.equal(f.service.isCurrentResult("replacement"), true);
    f.execute({
      type: "assignment.apply",
      actor: "operator",
      projectId: f.projectId,
      assignmentId: f.assignmentId,
      expectedVersion: 1,
    });
    assert.equal(f.service.isCurrentResult("replacement"), false);
  } finally {
    await f.close();
  }
});

test("Stop persists across restart and resume does not clear an unresolved writer", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const first = f.service.submitTask("active", f.assignmentId, "write");
    await entered.promise;
    f.service.stopTask(f.taskId);
    assert.equal(f.service.taskHold(f.taskId), "Task stopped");
    gate.resolve();
    assert.equal((await first).state, "held");
    assert.equal(
      (await f.service.submitTask("waiting", f.assignmentId, "next")).state,
      "ready",
    );
    await f.service.stop();
    const recovered = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
    );
    await recovered.start();
    assert.equal(recovered.taskHold(f.taskId), "Task stopped");
    recovered.resumeTask(f.taskId);
    assert.equal(recovered.taskHold(f.taskId), undefined);
    assert.equal(
      (await recovered.submitTask("waiting", f.assignmentId, "next")).state,
      "ready",
    );
    await recovered.stop();
    assert.equal(f.runtime.starts, 1);
  } finally {
    await f.close();
  }
});

test("late conflicting terminal report retracts completion and holds an active successor", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.service.submitTask("first", f.assignmentId, "write")).state,
      "completed",
    );
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const successor = f.service.submitTask("successor", f.assignmentId, "next");
    await entered.promise;
    f.runtime.anomaly?.({
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "Conflicting terminal status",
    });
    gate.resolve();
    assert.equal((await successor).state, "held");
    assert.equal(
      f.service.list().find((item) => item.workId === "first")?.state,
      "held",
    );
    assert.equal(f.service.isCurrentResult("first"), false);
  } finally {
    await f.close();
  }
});

test("identity-free terminal report holds the active task writer", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const action = f.service.submitTask("unknown", f.assignmentId, "write");
    await entered.promise;
    f.runtime.anomaly?.({ reason: "Missing terminal identity or status" });
    gate.resolve();
    assert.equal((await action).state, "held");
  } finally {
    await f.close();
  }
});

test("a survivor discovered after successful terminal status retracts writer release", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.service.submitTask("first", f.assignmentId, "write")).state,
      "completed",
    );
    f.service.holdKnownSurvivor("first", "detached child observed");
    assert.equal(
      f.service.list().find((item) => item.workId === "first")?.state,
      "held",
    );
    assert.equal(f.service.isCurrentResult("first"), false);
    assert.equal(
      (await f.service.submitTask("next", f.assignmentId, "next")).state,
      "ready",
    );
  } finally {
    await f.close();
  }
});

test("missing task workspace holds execution visibly", async () => {
  const f = await fixture();
  try {
    const binding = await f.service.taskWorkspace(f.taskId);
    assert.ok(binding);
    await assert.rejects(
      f.service.submit("raw", "write", binding.path),
      /durable assignment binding/,
    );
    rmSync(binding.path, { recursive: true, force: true });
    await assert.rejects(
      f.service.submitTask("missing", f.assignmentId, "write"),
      /workspace/i,
    );
    assert.equal((await f.service.taskWorkspace(f.taskId))?.state, "held");
    assert.equal(f.runtime.starts, 0);
  } finally {
    await f.close();
  }
});

test("crashed task writer stays held after SQLite reopen", async () => {
  const f = await fixture();
  try {
    const workspace = await f.service.taskWorkspace(f.taskId);
    assert.ok(workspace);
    const assignment = f.service.domain().assignment(f.assignmentId);
    await f.service.stop();
    const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
    const state = new ExecutionState(db);
    const intent = state.create("crashed", "write", workspace.path);
    state.bindTask("crashed", {
      taskId: f.taskId,
      assignmentId: f.assignmentId,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    assert.equal(state.begin(intent.id), true);
    assert.equal(state.bindThread(intent.id, "thread-crashed"), true);
    assert.equal(state.bindTurn(intent.id, "turn-crashed"), true);
    db.close();
    const runtime = new RuntimeFixture();
    const recovered = new StandaloneService(
      join(f.root, "data"),
      () => runtime,
    );
    await recovered.start();
    assert.equal(
      recovered.list().find((item) => item.workId === "crashed")?.state,
      "held",
    );
    assert.equal(
      (await recovered.submitTask("next", f.assignmentId, "next")).state,
      "ready",
    );
    assert.equal(runtime.starts, 0);
    await recovered.stop();
  } finally {
    await f.close();
  }
});
