import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StandaloneService } from "../src/standalone/service.js";
import {
  ExecutionState,
  type ExecutionIntent,
} from "../src/standalone/state.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import type { WorkspaceManager } from "../src/standalone/workspaces.js";

class RuntimeFixture implements Runtime {
  starts = 0;
  resumes = 0;
  turns = 0;
  private threadIds = 0;
  private turnIds = 0;
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  beforeInterrupt?: () => void;
  outcome: "completed" | "failed" = "completed";
  entered?: () => void;
  gate?: Promise<void>;
  anomaly?: (event: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  async start() {}
  async stop() {}
  async startThread() {
    this.starts++;
    return `thread-${++this.threadIds}`;
  }
  async resumeThread() {
    this.resumes++;
  }
  async startTurn() {
    this.turns++;
    return `turn-${++this.turnIds}`;
  }
  async waitForTurn(threadId: string, turnId: string) {
    await this.toolCall?.({
      threadId,
      turnId,
      callId: `fixture-question-${threadId}-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: {
        question: "Task-writer fixture is waiting for the next step",
      },
    });
    this.entered?.();
    await this.gate;
    return this.outcome;
  }
  async interruptTurn(threadId: string, turnId: string) {
    this.beforeInterrupt?.();
    this.interrupts.push({ threadId, turnId });
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }
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

interface SupervisorTestClock {
  monotonicNow(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

interface SupervisorTestOptions {
  supervisor?: { clock: SupervisorTestClock; observationMs: number };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(options?: SupervisorTestOptions) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-task-writer-"));
  const runtime = new RuntimeFixture();
  const ServiceWithOptions = StandaloneService as unknown as new (
    dataDir: string,
    createRuntime: () => Runtime,
    markerWriter?: (path: string, flag: "wx" | "w") => void,
    options?: SupervisorTestOptions,
  ) => StandaloneService;
  const service = new ServiceWithOptions(
    join(root, "data"),
    () => runtime,
    undefined,
    options,
  );
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
  const firstIntent = `assignment:${assignmentId}:initial`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      service.list().find((item) => item.workId === firstIntent)?.state ===
      "completed"
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(
    service.list().find((item) => item.workId === firstIntent)?.state,
    "completed",
  );
  runtime.starts = 0;
  runtime.turns = 0;
  return {
    root,
    service,
    runtime,
    taskId,
    assignmentId,
    projectId,
    profileId,
    execute,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("eligibility changes during workspace admission prevent execution", async () => {
  for (const changed of ["pause", "profile", "dependency"] as const) {
    const f = await fixture();
    const release = deferred();
    try {
      const manager = (
        f.service as unknown as {
          workspaces: { forExecution(taskId: string): Promise<unknown> };
        }
      ).workspaces;
      const original = manager.forExecution.bind(manager);
      const entered = deferred();
      manager.forExecution = async (taskId) => {
        entered.resolve();
        await release.promise;
        return original(taskId);
      };
      const action = f.service.submitTask(changed, f.assignmentId, "write");
      await entered.promise;
      if (changed === "pause")
        f.execute({
          type: "project.configure",
          actor: "operator",
          projectId: f.projectId,
          expectedVersion: Number(
            f.service.domain().project(f.projectId).version,
          ),
          paused: true,
        });
      else if (changed === "profile")
        f.execute({
          type: "profile.configure",
          actor: "operator",
          profileId: f.profileId,
          expectedVersion: Number(
            f.service.domain().profile(f.profileId).version,
          ),
          revoked: true,
        });
      else {
        const blockerTaskId = randomUUID();
        f.execute({
          type: "task.create",
          actor: "operator",
          projectId: f.projectId,
          taskId: blockerTaskId,
          title: "Blocker",
          outcome: "Deliver",
          ready: false,
        });
        f.execute({
          type: "dependency.add",
          actor: "operator",
          projectId: f.projectId,
          taskId: f.taskId,
          blockerTaskId,
          expectedVersion: Number(f.service.domain().task(f.taskId).version),
        });
      }
      release.resolve();
      const refused = await action;
      const request = f.service
        .turnRequests()
        .find((item) => item.workId === changed);
      if (changed === "pause") {
        assert.equal(refused.state, "ready");
        assert.match(refused.reason ?? "", /Admission waiting: /);
        assert.equal(request?.state, "queued");
        assert.match(request?.reason ?? "", /Admission waiting: /);
      } else {
        assert.equal(refused.state, "held");
        assert.match(
          refused.reason ?? "",
          /Request refused: captured revisions/,
        );
        assert.equal(request?.state, "held");
        assert.match(
          request?.reason ?? "",
          /Request refused: captured revisions/,
        );
      }
      assert.equal(f.runtime.starts, 0);
      assert.equal(
        f.service.list().filter((item) => item.workId === changed).length,
        1,
      );
      const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
            )
            .get(changed) as { count: number }
        ).count,
        0,
      );
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
            )
            .get(changed) as { count: number }
        ).count,
        0,
      );
      db.close();
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

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
    assert.equal(f.runtime.resumes, 1);
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
    const duplicate = await f.service.submitTask(
      "first",
      f.assignmentId,
      "write",
    );
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.state, "completed");
    assert.equal(f.runtime.starts, 1);
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
    assert.equal(f.runtime.starts, 2);
    assert.equal(f.runtime.resumes, 0);
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

test("newer work revisions reject predecessor results across restart and idempotent reuse", async () => {
  const f = await fixture();
  let recovered: StandaloneService | undefined;
  try {
    assert.equal(
      (await f.service.submitTask("predecessor", f.assignmentId, "first"))
        .state,
      "completed",
    );
    assert.equal(
      (await f.service.submitTask("successor", f.assignmentId, "second")).state,
      "completed",
    );
    await f.service.stop();

    const path = join(f.root, "data", "standalone.sqlite");
    const db = new DatabaseSync(path);
    const revisions = db
      .prepare(
        "SELECT workId, workRevision FROM task_work_revisions WHERE assignmentId = ? ORDER BY workRevision",
      )
      .all(f.assignmentId) as { workId: string; workRevision: number }[];
    assert.deepEqual(
      revisions.map((row) => ({ ...row })),
      [
        {
          workId: `assignment:${f.assignmentId}:initial`,
          workRevision: 1,
        },
        { workId: "predecessor", workRevision: 2 },
        { workId: "successor", workRevision: 3 },
      ],
    );
    db.close();

    recovered = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
    );
    await recovered.start();
    assert.equal(recovered.isCurrentResult("predecessor"), false);
    assert.equal(recovered.recordTaskResult("predecessor", "late"), false);
    assert.equal(recovered.isCurrentResult("successor"), true);
    assert.equal(recovered.recordTaskResult("successor", "current"), true);
    assert.equal(
      (await recovered.submitTask("successor", f.assignmentId, "second")).state,
      "completed",
    );
    await recovered.stop();
    recovered = undefined;

    const verified = new DatabaseSync(path);
    assert.equal(
      (
        verified
          .prepare(
            "SELECT COUNT(*) AS count FROM task_work_revisions WHERE assignmentId = ?",
          )
          .get(f.assignmentId) as { count: number }
      ).count,
      3,
    );
    assert.equal(
      (
        verified
          .prepare(
            "SELECT workRevision FROM task_work_revisions WHERE workId = 'successor'",
          )
          .get() as { workRevision: number }
      ).workRevision,
      3,
    );
    verified.close();
  } finally {
    await recovered?.stop();
    await f.close();
  }
});

test("legacy work revisions preserve only provable result ordering", async () => {
  const single = await fixture();
  let recoveredSingle: StandaloneService | undefined;
  try {
    assert.equal(
      (await single.service.submitTask("only", single.assignmentId, "work"))
        .state,
      "completed",
    );
    assert.equal(single.service.recordTaskResult("only", "result"), true);
    await single.service.stop();
    const path = join(single.root, "data", "standalone.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`DELETE FROM task_work_revisions;
      DELETE FROM task_writer_admissions;
      DELETE FROM execution_request_predecessors;`);
    legacy.close();

    recoveredSingle = new StandaloneService(
      join(single.root, "data"),
      () => new RuntimeFixture(),
    );
    await recoveredSingle.start();
    assert.equal(recoveredSingle.isCurrentResult("only"), false);
    assert.equal(recoveredSingle.recordTaskResult("only", "result"), false);
    assert.equal(
      recoveredSingle.list().find((item) => item.workId === "only")?.state,
      "held",
    );
    assert.match(
      recoveredSingle.taskHold(single.taskId) ?? "",
      /revision order is ambiguous/,
    );
    const disposition = new DatabaseSync(path);
    assert.equal(
      (
        disposition
          .prepare(
            "SELECT COUNT(*) AS count FROM task_work_revision_ambiguities WHERE assignmentId = ?",
          )
          .get(single.assignmentId) as { count: number }
      ).count,
      2,
    );
    disposition.close();
  } finally {
    await recoveredSingle?.stop();
    await single.close();
  }

  const mixed = await fixture();
  let recoveredMixed: StandaloneService | undefined;
  try {
    assert.equal(
      (await mixed.service.submitTask("legacy", mixed.assignmentId, "first"))
        .state,
      "completed",
    );
    assert.equal(
      (await mixed.service.submitTask("known", mixed.assignmentId, "second"))
        .state,
      "completed",
    );
    assert.equal(mixed.service.recordTaskResult("known", "result"), true);
    await mixed.service.stop();
    const path = join(mixed.root, "data", "standalone.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`DELETE FROM task_work_revisions WHERE workId = 'legacy';
      DELETE FROM task_writer_admissions WHERE workId = 'legacy';`);
    legacy.close();

    recoveredMixed = new StandaloneService(
      join(mixed.root, "data"),
      () => new RuntimeFixture(),
    );
    await recoveredMixed.start();
    for (const workId of ["legacy", "known"]) {
      const matched: ExecutionIntent | undefined = recoveredMixed
        .list()
        .find((item) => item.workId === workId);
      assert.equal(matched?.state, "held");
      assert.match(matched?.reason ?? "", /revision order is ambiguous/);
      assert.equal(recoveredMixed.isCurrentResult(workId), false);
    }
    assert.equal(recoveredMixed.recordTaskResult("known", "result"), false);
    assert.match(
      recoveredMixed.taskHold(mixed.taskId) ?? "",
      /revision order is ambiguous/,
    );
    const dispositions = new DatabaseSync(path);
    assert.equal(
      (
        dispositions
          .prepare(
            "SELECT COUNT(*) AS count FROM task_work_revision_ambiguities",
          )
          .get() as { count: number }
      ).count,
      3,
    );
    dispositions.close();
  } finally {
    await recoveredMixed?.stop();
    await mixed.close();
  }
});

test("legacy held work is ambiguous and preserves Stop independently", async () => {
  for (const ordering of ["stop-first", "ambiguity-first"] as const) {
    const f = await fixture();
    let recovered: StandaloneService | undefined;
    let restarted: StandaloneService | undefined;
    try {
      assert.equal(
        (await f.service.submitTask("legacy-held", f.assignmentId, "work"))
          .state,
        "completed",
      );
      assert.equal(
        f.service.recordTaskResult("legacy-held", "legacy result"),
        true,
      );
      if (ordering === "stop-first") f.service.stopTask(f.taskId);
      await f.service.stop();

      const path = join(f.root, "data", "standalone.sqlite");
      const legacy = new DatabaseSync(path);
      legacy.exec(`UPDATE execution_intents SET state = 'held', reason = 'legacy hold'
        WHERE workId = 'legacy-held';
      DELETE FROM task_work_revisions WHERE workId = 'legacy-held';
      DELETE FROM task_writer_admissions WHERE workId = 'legacy-held';
      DELETE FROM task_work_revision_pending WHERE workId = 'legacy-held';`);
      legacy.close();

      recovered = new StandaloneService(
        join(f.root, "data"),
        () => new RuntimeFixture(),
      );
      await recovered.start();
      if (ordering === "ambiguity-first") {
        recovered.stopTask(f.taskId);
        await recovered.stop();
        recovered = undefined;
        restarted = new StandaloneService(
          join(f.root, "data"),
          () => new RuntimeFixture(),
        );
        await restarted.start();
      }
      const active = restarted ?? recovered;
      assert.ok(active);
      assert.match(
        active.taskHold(f.taskId) ?? "",
        /revision order is ambiguous/,
      );
      assert.equal(active.isCurrentResult("legacy-held"), false);
      assert.equal(
        active.recordTaskResult("legacy-held", "legacy result"),
        false,
      );

      const held = new DatabaseSync(path);
      assert.equal(
        (
          held
            .prepare(
              "SELECT COUNT(*) AS count FROM task_writer_holds WHERE taskId = ? AND reason = 'Task stopped'",
            )
            .get(f.taskId) as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          held
            .prepare(
              "SELECT COUNT(*) AS count FROM task_writer_ambiguity_holds WHERE taskId = ?",
            )
            .get(f.taskId) as { count: number }
        ).count,
        1,
      );
      assert.equal(
        (
          held
            .prepare(
              "SELECT COUNT(*) AS count FROM task_work_revisions WHERE workId = 'legacy-held'",
            )
            .get() as { count: number }
        ).count,
        0,
      );
      held.close();

      active.resumeTask(f.taskId);
      assert.match(
        active.taskHold(f.taskId) ?? "",
        /revision order is ambiguous/,
      );
      const resumed = new DatabaseSync(path);
      assert.equal(
        (
          resumed
            .prepare(
              "SELECT COUNT(*) AS count FROM task_writer_holds WHERE taskId = ?",
            )
            .get(f.taskId) as { count: number }
        ).count,
        0,
      );
      assert.equal(
        (
          resumed
            .prepare(
              "SELECT COUNT(*) AS count FROM task_writer_ambiguity_holds WHERE taskId = ?",
            )
            .get(f.taskId) as { count: number }
        ).count,
        1,
      );
      resumed.close();
    } finally {
      await restarted?.stop();
      await recovered?.stop();
      await f.close();
    }
  }
});

test("predecessor identity is immutable across restart", async () => {
  const f = await fixture();
  let recovered: StandaloneService | undefined;
  try {
    assert.equal(
      (await f.service.submitTask("first", f.assignmentId, "first")).state,
      "completed",
    );
    assert.equal(
      (await f.service.submitTask("second", f.assignmentId, "second")).state,
      "completed",
    );
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const blocker = f.service.submitTask("blocker", f.assignmentId, "block");
    await entered.promise;
    assert.equal(
      (await f.service.submitTask("null-request", f.assignmentId, "null"))
        .state,
      "ready",
    );
    assert.equal(
      (
        await f.service.submitTask(
          "id-request",
          f.assignmentId,
          "identified",
          "first",
        )
      ).state,
      "ready",
    );
    gate.resolve();
    assert.equal((await blocker).state, "completed");
    await f.service.stop();

    const runtime = new RuntimeFixture();
    recovered = new StandaloneService(join(f.root, "data"), () => runtime);
    await recovered.start();
    const startsBeforeConflicts = runtime.starts;
    await assert.rejects(
      recovered.submitTask("null-request", f.assignmentId, "changed prompt"),
      /different prompt/,
    );
    await assert.rejects(
      recovered.submitTask("null-request", f.assignmentId, "null", "first"),
      /different predecessor/,
    );
    await assert.rejects(
      recovered.submitTask(
        "id-request",
        f.assignmentId,
        "identified",
        "second",
      ),
      /different predecessor/,
    );
    assert.equal(runtime.starts, startsBeforeConflicts);

    const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
    const saved = db
      .prepare(`SELECT workId, previousWorkId FROM execution_request_predecessors
      WHERE workId IN ('null-request','id-request') ORDER BY workId`)
      .all() as { workId: string; previousWorkId: string | null }[];
    assert.deepEqual(
      saved.map((row) => ({ ...row })),
      [
        { workId: "id-request", previousWorkId: "first" },
        { workId: "null-request", previousWorkId: null },
      ],
    );
    db.close();

    assert.equal(
      (await recovered.submitTask("null-request", f.assignmentId, "null"))
        .state,
      "completed",
    );
    assert.equal(
      (
        await recovered.submitTask(
          "id-request",
          f.assignmentId,
          "identified",
          "first",
        )
      ).state,
      "completed",
    );
  } finally {
    await recovered?.stop();
    await f.close();
  }
});

test("legacy ready work with unknown predecessor is held and refused", async () => {
  const f = await fixture();
  let recovered: StandaloneService | undefined;
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const active = f.service.submitTask("active", f.assignmentId, "first");
    await entered.promise;
    assert.equal(
      (
        await f.service.submitTask(
          "legacy-ready",
          f.assignmentId,
          "follow-up",
          "active",
        )
      ).state,
      "ready",
    );
    gate.resolve();
    assert.equal((await active).state, "completed");
    await f.service.stop();
    const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
    db.prepare(
      "DELETE FROM execution_request_predecessors WHERE workId = 'legacy-ready'",
    ).run();
    db.close();

    const runtime = new RuntimeFixture();
    recovered = new StandaloneService(join(f.root, "data"), () => runtime);
    await recovered.start();
    const held = recovered
      .list()
      .find((item) => item.workId === "legacy-ready");
    assert.equal(held?.state, "held");
    assert.match(held?.reason ?? "", /predecessor identity is unknown/);
    const refused = await recovered.submitTask(
      "legacy-ready",
      f.assignmentId,
      "follow-up",
      "active",
    );
    assert.equal(refused.state, "held");
    assert.match(refused.reason ?? "", /predecessor identity is unknown/);
    assert.equal(runtime.starts, 0);
    const disposition = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    assert.deepEqual(
      {
        ...(disposition
          .prepare(`SELECT p.predecessorKnown,
            CASE WHEN pending.workId IS NULL THEN 0 ELSE 1 END AS pending
            FROM execution_request_predecessors p
            LEFT JOIN task_work_revision_pending pending ON pending.workId = p.workId
            WHERE p.workId = 'legacy-ready'`)
          .get() as { predecessorKnown: number; pending: number }),
      },
      { predecessorKnown: 0, pending: 1 },
    );
    disposition.close();
  } finally {
    await recovered?.stop();
    await f.close();
  }
});

test("ready work prevents conversation replacement and remains retryable", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const first = f.service.submitTask("active", f.assignmentId, "first");
    await entered.promise;
    assert.equal(
      (
        await f.service.submitTask(
          "ready",
          f.assignmentId,
          "follow-up",
          "active",
        )
      ).state,
      "ready",
    );

    const path = join(f.root, "data", "standalone.sqlite");
    const revision = () => {
      const db = new DatabaseSync(path);
      try {
        return Number(
          (
            db
              .prepare(
                "SELECT revision FROM assignment_conversations WHERE assignmentId = ?",
              )
              .get(f.assignmentId) as { revision: number }
          ).revision,
        );
      } finally {
        db.close();
      }
    };
    assert.equal(revision(), 1);
    assert.throws(
      () => f.service.replaceConversation(f.assignmentId),
      /unresolved execution/,
    );
    assert.equal(revision(), 1);
    assert.equal(
      (
        await f.service.archiveTask(f.taskId, {
          deliveryConfirmed: true,
          writerOwnershipResolved: true,
          handoffsPreserved: true,
          reconciliationEvidencePreserved: true,
          workspaceContentsPreserved: true,
        })
      ).outcome,
      "retained",
    );

    gate.resolve();
    assert.equal((await first).state, "completed");
    assert.equal(
      (
        await f.service.submitTask(
          "ready",
          f.assignmentId,
          "follow-up",
          "active",
        )
      ).state,
      "completed",
    );
    assert.equal(f.service.isCurrentResult("ready"), true);
    assert.equal(
      (
        await f.service.archiveTask(f.taskId, {
          deliveryConfirmed: true,
          writerOwnershipResolved: true,
          handoffsPreserved: true,
          reconciliationEvidencePreserved: true,
          workspaceContentsPreserved: true,
        })
      ).outcome,
      "cleaned",
    );
  } finally {
    await f.close();
  }
});

test("stale queued assignment work is refused without admission and needs a fresh generation", async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    const first = f.service.submitTask("active", f.assignmentId, "first");
    await entered.promise;
    assert.equal(
      (
        await f.service.submitTask(
          "ready",
          f.assignmentId,
          "follow-up",
          "active",
        )
      ).state,
      "ready",
    );

    f.execute({
      type: "assignment.apply",
      actor: "operator",
      projectId: f.projectId,
      assignmentId: f.assignmentId,
      expectedVersion: 1,
    });
    gate.resolve();
    assert.equal((await first).state, "completed");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        f.service.list().find((item) => item.workId === "ready")?.state ===
        "held"
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const stale = f.service.list().find((item) => item.workId === "ready");
    assert.equal(stale?.state, "held");
    assert.match(stale?.reason ?? "", /assignment-revision-changed/);
    const staleRequest = f.service
      .turnRequests()
      .find((item) => item.workId === "ready");
    assert.equal(staleRequest?.state, "held");
    assert.match(staleRequest?.reason ?? "", /assignment-revision-changed/);
    const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = 'ready'",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = 'ready'",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    db.close();
    f.runtime.gate = Promise.resolve();
    assert.equal(
      (
        await f.service.submitTask(
          "fresh",
          f.assignmentId,
          "new material",
          "active",
        )
      ).state,
      "completed",
    );
    assert.equal(
      (
        f.service as unknown as {
          state: ExecutionState;
        }
      ).state.taskBinding("ready")?.assignmentVersion,
      1,
    );
    assert.equal(
      (
        f.service as unknown as {
          state: ExecutionState;
        }
      ).state.taskBinding("fresh")?.assignmentVersion,
      2,
    );
    assert.equal(f.runtime.starts, 1);
    assert.equal(f.runtime.resumes, 1);
  } finally {
    await f.close();
  }
});

test("archival hold prevents writer admission after workspace validation", async () => {
  const f = await fixture();
  try {
    const cleanupGate = deferred();
    const cleanupEntered = deferred();
    const manager = (f.service as unknown as { workspaces: WorkspaceManager })
      .workspaces;
    const archiveAndCleanup = manager.archiveAndCleanup.bind(manager);
    manager.archiveAndCleanup = async (...args) => {
      cleanupEntered.resolve();
      await cleanupGate.promise;
      return archiveAndCleanup(...args);
    };

    const archival = f.service.archiveTask(f.taskId, {
      deliveryConfirmed: true,
      writerOwnershipResolved: true,
      handoffsPreserved: true,
      reconciliationEvidencePreserved: true,
      workspaceContentsPreserved: true,
    });
    await cleanupEntered.promise;

    const queued = await f.service.submitTask(
      "racing-writer",
      f.assignmentId,
      "write",
    );
    assert.equal(queued.state, "ready");
    assert.match(queued.reason ?? "", /Task archival in progress/);
    assert.equal(f.runtime.starts, 0);
    assert.equal(
      f.service.list().find((item) => item.workId === "racing-writer")?.state,
      "ready",
    );

    const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      1,
    );
    db.close();
    const notAdmitted = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    assert.equal(
      (
        notAdmitted
          .prepare(
            "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = 'racing-writer'",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        notAdmitted
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = 'racing-writer'",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    notAdmitted.close();

    cleanupGate.resolve();
    assert.equal((await archival).outcome, "retained");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        f.service.turnRequests().find((item) => item.workId === "racing-writer")
          ?.state === "completed"
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const afterArchive = f.service
      .turnRequests()
      .find((item) => item.workId === "racing-writer");
    assert.equal(afterArchive?.state, "completed");
    assert.equal(f.runtime.starts, 1);

    const released = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    assert.equal(
      (
        released
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      0,
    );
    released.close();
  } finally {
    await f.close();
  }
});

test("archival rechecks writer ownership after cleanup validation", async () => {
  const f = await fixture();
  const callback = deferred();
  try {
    assert.equal(
      (await f.service.submitTask("completed", f.assignmentId, "write")).state,
      "completed",
    );
    const manager = (f.service as unknown as { workspaces: WorkspaceManager })
      .workspaces;
    const archiveAndCleanup = manager.archiveAndCleanup.bind(manager);
    manager.archiveAndCleanup = async (...args) => {
      f.service.registerExecutionCallback("completed", callback.promise);
      return archiveAndCleanup(...args);
    };

    const result = await f.service.archiveTask(f.taskId, {
      deliveryConfirmed: true,
      writerOwnershipResolved: true,
      handoffsPreserved: true,
      reconciliationEvidencePreserved: true,
      workspaceContentsPreserved: true,
    });
    assert.equal(result.outcome, "retained");
    if (result.outcome === "retained")
      assert.match(result.reason, /writer ownership changed/);
    assert.equal(result.binding.state, "ready");
    assert.equal(
      f.service.list().find((item) => item.workId === "completed")?.state,
      "held",
    );
  } finally {
    callback.resolve();
    await f.close();
  }
});

test("a completed successor loses its result after predecessor release is retracted", async () => {
  for (const cause of ["conflict", "survivor"] as const) {
    const f = await fixture();
    try {
      assert.equal(
        (await f.service.submitTask("first", f.assignmentId, "write")).state,
        "completed",
      );
      assert.equal(
        (await f.service.submitTask("successor", f.assignmentId, "next")).state,
        "completed",
      );
      assert.equal(f.service.recordTaskResult("successor", "delivered"), true);
      if (cause === "conflict")
        f.runtime.anomaly?.({
          threadId: "thread-1",
          turnId: "turn-1",
          reason: "Conflicting terminal status",
        });
      else f.service.holdKnownSurvivor("first", "detached child observed");
      assert.equal(f.service.isCurrentResult("first"), false);
      assert.equal(f.service.isCurrentResult("successor"), false);
      assert.equal(f.service.recordTaskResult("successor", "delivered"), false);
      assert.equal(
        f.service.list().find((item) => item.workId === "successor")?.state,
        "held",
      );
      assert.equal(
        (await f.service.submitTask("later", f.assignmentId, "later")).state,
        "ready",
      );
      assert.equal(f.runtime.starts, 2);
    } finally {
      await f.close();
    }
  }
});

test("writer retraction follows admission order for a queued successor", async () => {
  const f = await fixture();
  let recovered: StandaloneService | undefined;
  try {
    const firstGate = deferred();
    const firstEntered = deferred();
    f.runtime.gate = firstGate.promise;
    f.runtime.entered = firstEntered.resolve;
    const first = f.service.submitTask("first", f.assignmentId, "write");
    await firstEntered.promise;
    assert.equal(
      (await f.service.submitTask("contender-c", f.assignmentId, "later"))
        .state,
      "ready",
    );
    firstGate.resolve();
    assert.equal((await first).state, "completed");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        f.service.list().find((item) => item.workId === "contender-c")
          ?.state === "completed"
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(
      f.service.list().find((item) => item.workId === "contender-c")?.state,
      "completed",
    );

    f.runtime.gate = Promise.resolve();
    assert.equal(
      (await f.service.submitTask("writer-b", f.assignmentId, "next")).state,
      "completed",
    );
    assert.equal(
      (await f.service.submitTask("contender-c", f.assignmentId, "later"))
        .state,
      "completed",
    );
    assert.equal(f.service.recordTaskResult("contender-c", "delivered"), false);
    assert.equal(
      f.service.recordTaskResult("writer-b", "newer delivery"),
      true,
    );

    await f.service.stop();
    const runtime = new RuntimeFixture();
    recovered = new StandaloneService(join(f.root, "data"), () => runtime);
    await recovered.start();
    runtime.anomaly?.({
      threadId: "thread-2",
      turnId: "turn-2",
      reason: "Conflicting terminal status",
    });
    assert.equal(
      recovered.list().find((item) => item.workId === "writer-b")?.state,
      "held",
    );
    assert.equal(
      recovered.list().find((item) => item.workId === "contender-c")?.state,
      "held",
    );
    assert.equal(recovered.isCurrentResult("contender-c"), false);
    assert.equal(recovered.recordTaskResult("contender-c", "delivered"), false);
    assert.equal(
      recovered.recordTaskResult("writer-b", "newer delivery"),
      false,
    );
  } finally {
    await recovered?.stop();
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

test("Stop persists bound execution identity before interrupt and keeps ownership after acknowledgement", async () => {
  let now = 0;
  const sleeps: number[] = [];
  let advanceObservation: (() => void) | undefined;
  const f = await fixture({
    supervisor: {
      observationMs: 3000,
      clock: {
        monotonicNow: () => now,
        sleep(milliseconds, signal) {
          sleeps.push(milliseconds);
          return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              now += milliseconds;
              signal.removeEventListener("abort", finish);
              resolve();
            };
            if (signal.aborted) finish();
            else signal.addEventListener("abort", finish, { once: true });
            advanceObservation = finish;
          });
        },
      },
    },
  });
  const gate = deferred();
  try {
    const entered = deferred();
    f.runtime.gate = gate.promise;
    f.runtime.entered = entered.resolve;
    let observedBeforeInterrupt:
      | {
          stop: string | undefined;
          state: string;
          threadId: string | null;
          turnId: string | null;
        }
      | undefined;
    f.runtime.beforeInterrupt = () => {
      const active = f.service
        .list()
        .find((item) => item.workId === "stoppable");
      observedBeforeInterrupt = {
        stop: f.service.taskHold(f.taskId),
        state: active?.state ?? "missing",
        threadId: active?.threadId ?? null,
        turnId: active?.turnId ?? null,
      };
    };
    const run = f.service.submitTask("stoppable", f.assignmentId, "write");
    await entered.promise;
    const active = f.service.list().find((item) => item.workId === "stoppable");
    assert.ok(active?.threadId);
    assert.ok(active?.turnId);

    const stopping = f.service.stopTask(f.taskId) as unknown as Promise<{
      taskId: string;
      observationMs: number;
      outcomes: Array<{
        workId: string;
        threadId: string | null;
        turnId: string | null;
        interrupt: string;
        terminal: string;
        reason?: string;
      }>;
    }>;
    for (
      let attempt = 0;
      attempt < 100 && f.runtime.interrupts.length === 0;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let attempt = 0; attempt < 100 && sleeps.length === 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(f.runtime.interrupts, [
      { threadId: active.threadId, turnId: active.turnId },
    ]);
    assert.deepEqual(observedBeforeInterrupt, {
      stop: "Task stopped",
      state: "held",
      threadId: active.threadId,
      turnId: active.turnId,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    advanceObservation?.();
    const observation = await stopping;
    assert.equal(observation.taskId, f.taskId);
    assert.equal(observation.observationMs, 3000);
    assert.deepEqual(sleeps, [3000]);
    assert.deepEqual(observation.outcomes, [
      {
        workId: "stoppable",
        threadId: active.threadId,
        turnId: active.turnId,
        interrupt: "acknowledged",
        terminal: "unknown",
        reason: "No terminal status observed during the bounded window",
      },
    ]);
    assert.equal(
      f.service.list().find((item) => item.workId === "stoppable")?.state,
      "held",
    );
    assert.equal(
      f.service.capacityLimits([f.projectId]).currentUsage.global,
      1,
    );
    assert.equal(
      f.service.recordTaskResult("stoppable", "too early"),
      false,
      "interrupt acknowledgement must not release the active writer",
    );

    gate.resolve();
    assert.equal((await run).state, "held");
    await f.service.stop();
    const recovered = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
    );
    await recovered.start();
    assert.equal(recovered.taskHold(f.taskId), "Task stopped");
    assert.equal(
      recovered.capacityLimits([f.projectId]).currentUsage.global,
      1,
    );
    recovered.resumeTask(f.taskId);
    assert.equal(recovered.taskHold(f.taskId), undefined);
    assert.equal(
      recovered.list().find((item) => item.workId === "stoppable")?.state,
      "held",
    );
    assert.equal(
      recovered.capacityLimits([f.projectId]).currentUsage.global,
      1,
    );
    await recovered.stop();
  } finally {
    gate.resolve();
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

test("identity-free terminal report retracts the recent writer and active successor", async () => {
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
    const action = f.service.submitTask(
      "successor",
      f.assignmentId,
      "next",
      "first",
    );
    await entered.promise;
    f.runtime.anomaly?.({ reason: "Missing terminal identity or status" });
    gate.resolve();
    assert.equal((await action).state, "held");
    assert.equal(
      f.service.list().find((item) => item.workId === "first")?.state,
      "held",
    );
    assert.equal(f.service.isCurrentResult("first"), false);
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
