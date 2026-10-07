import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  controlledGit,
  type ControlledGitEvent,
} from "./fixtures/controlled-git.js";
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
import type {
  TaskWorkspaceRepositoryInput,
  WorkspaceManagerOptions,
} from "../src/standalone/workspaces.js";
import { WorkspaceManager } from "../src/standalone/workspaces.js";

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
  workspaceManager?: WorkspaceManagerOptions;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sourceRepository(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Task Writer Test"]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "task-writer@example.invalid",
  ]);
  writeFileSync(join(path, "README.md"), `${name}\n`);
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "initial"]);
  return path;
}

async function waitForControlledGitEvent(
  controlled: ReturnType<typeof controlledGit>,
  predicate: (event: ControlledGitEvent) => boolean,
  timeoutMs = 2000,
): Promise<ControlledGitEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = controlled.events().find(predicate);
    if (event) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    "Task-writer test Git child did not reach the expected state",
  );
}

async function fixture(
  options?: SupervisorTestOptions,
  repositories: TaskWorkspaceRepositoryInput[] = [],
) {
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
  const workspace = await service.provisionTask(taskId, repositories);
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

test("uncertain archive status keeps its archival hold across restart", async (t) => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "ensemble-archive-source-"),
  );
  const source = sourceRepository(repositoryRoot, "source");
  const controlled = controlledGit();
  const failures: Parameters<
    NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
  >[0][] = [];
  const serviceOptions = {
    workspaceManager: {
      gitExecutable: controlled.executable,
      gitTimeoutMs: { "archive-status": 400 },
      gitTerminationGraceMs: 20,
      gitTerminationObservationMs: 40,
      gitFailureObserver: (failure: (typeof failures)[number]) =>
        failures.push(failure),
    },
  };
  const f = await fixture(serviceOptions, [
    { repositoryId: "repo", path: source },
  ]);
  let recovered: StandaloneService | undefined;
  try {
    const binding = await f.service.taskWorkspace(f.taskId);
    const repositoryBinding = binding?.repositories[0];
    assert.ok(repositoryBinding);
    const serviceWithWake = f.service as unknown as {
      wakeScheduler: () => Promise<void>;
    };
    const wakeScheduler = serviceWithWake.wakeScheduler.bind(f.service);
    let archiveWakeCount = 0;
    serviceWithWake.wakeScheduler = async () => {
      archiveWakeCount++;
      await wakeScheduler();
    };
    controlled.setRule({
      commandPrefix: "status --porcelain=v1 --untracked-files=all",
      behavior: "stall",
      holdPipe: true,
    });
    const archival = f.service.archiveTask(f.taskId, {
      deliveryConfirmed: true,
      writerOwnershipResolved: true,
      handoffsPreserved: true,
      reconciliationEvidencePreserved: true,
      workspaceContentsPreserved: true,
    });
    const ready = await waitForControlledGitEvent(
      controlled,
      ({ event, operation }) =>
        event === "ready" && operation === "archive-status",
    );
    assert.ok(ready.atMs !== undefined);

    const liveDb = (f.service as unknown as { db: DatabaseSync }).db;
    assert.equal(
      (
        liveDb
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      1,
    );
    const result = await archival;
    const elapsedMs = Date.now() - ready.atMs;
    assert.ok(elapsedMs < 400 + 20 + 40 + 500, `settled in ${elapsedMs}ms`);
    t.diagnostic(
      `bounded-git-archive-evidence ${JSON.stringify({
        readyToSettleMs: elapsedMs,
        configuredTimeoutMs: 400,
        termGraceMs: 20,
        observationMs: 40,
        childExitSignal: failures.at(-1)?.childExitSignal,
      })}`,
    );
    assert.equal(result.outcome, "retained");
    assert.equal(archiveWakeCount, 1);
    if (result.outcome === "retained") {
      assert.equal(result.binding.state, "held");
      assert.equal(result.binding.gitUncertain, true);
      assert.match(result.reason, /timed-out during archive-status/);
    }
    assert.deepEqual(failures.at(-1), {
      operation: "archive-status",
      kind: "timed-out",
      childExitObserved: true,
      childExitSignal: "SIGKILL",
    });
    assert.equal(existsSync(repositoryBinding.workspacePath), true);
    assert.equal(
      (
        liveDb
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      1,
    );

    const launchesBeforeRestart = controlled
      .events()
      .filter(({ event }) => event === "start").length;
    await f.service.stop();
    recovered = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
      undefined,
      serviceOptions,
    );
    await recovered.start();
    assert.equal(
      controlled.events().filter(({ event }) => event === "start").length,
      launchesBeforeRestart,
    );
    const afterRestart = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    const recoveredBinding = afterRestart
      .prepare(
        "SELECT state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
      )
      .get(f.taskId) as { state: string; gitUncertain: number } | undefined;
    assert.equal(recoveredBinding?.state, "held");
    assert.equal(recoveredBinding?.gitUncertain, 1);
    assert.equal(
      (
        afterRestart
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      1,
    );
    afterRestart.close();

    await assert.rejects(
      recovered.submitTask(
        "blocked-by-uncertain-archive",
        f.assignmentId,
        "Do not admit while archive status is uncertain",
      ),
      /Turn request is queued until its task workspace is ready/,
    );
    const readback = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    assert.equal(
      (
        readback
          .prepare(
            "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
          )
          .get("blocked-by-uncertain-archive") as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        readback
          .prepare(
            "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
          )
          .get(f.taskId) as { count: number }
      ).count,
      1,
    );
    readback.close();
  } finally {
    try {
      await recovered?.stop();
    } finally {
      try {
        await f.close();
      } finally {
        try {
          await controlled.cleanup();
        } finally {
          rmSync(repositoryRoot, { recursive: true, force: true });
        }
      }
    }
  }
});

test("service stop settles direct workspace provisioning before database close", async (t) => {
  const controlled = controlledGit();
  const failures: Parameters<
    NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
  >[0][] = [];
  const databaseOpenAtFailure: boolean[] = [];
  let observingService: StandaloneService | undefined;
  const f = await fixture({
    workspaceManager: {
      gitExecutable: controlled.executable,
      gitTimeoutMs: { "repository-identity": 30_000 },
      gitTerminationGraceMs: 20,
      gitTerminationObservationMs: 40,
      gitFailureObserver: (failure) => {
        failures.push(failure);
        const db = (observingService as unknown as { db?: DatabaseSync })?.db;
        databaseOpenAtFailure.push(db?.isOpen ?? false);
      },
    },
  });
  observingService = f.service;
  try {
    const source = sourceRepository(f.root, "direct-provision-source");
    const taskId = randomUUID();
    f.execute({
      type: "task.create",
      actor: "operator",
      projectId: f.projectId,
      taskId,
      title: "Direct provisioning",
      outcome: "Preserve incomplete Git work",
      ready: false,
    });
    const launchesBeforeProvision = controlled
      .events()
      .filter(
        ({ event, operation }) =>
          event === "start" && operation === "repository-identity",
      ).length;
    controlled.setRule({
      commandPrefix: "rev-parse --show-toplevel",
      behavior: "stall",
      holdPipe: true,
    });
    const provisioning = f.service.provisionTask(taskId, [
      { repositoryId: "repo", path: source },
    ]);
    const ready = await waitForControlledGitEvent(
      controlled,
      ({ event, operation }) =>
        event === "ready" && operation === "repository-identity",
    );
    assert.ok(ready.atMs !== undefined);
    const [binding] = await Promise.all([provisioning, f.service.stop()]);
    const elapsedMs = Date.now() - ready.atMs;
    assert.ok(elapsedMs < 20 + 40 + 800, `settled in ${elapsedMs}ms`);
    t.diagnostic(
      `service-provision-stop-evidence ${JSON.stringify({
        readyToSettleMs: elapsedMs,
        termGraceMs: 20,
        observationMs: 40,
        childExitSignal: failures.at(-1)?.childExitSignal,
        databaseOpenAtChildExit: databaseOpenAtFailure.at(-1),
      })}`,
    );
    assert.equal(binding.state, "held");
    assert.equal(binding.gitUncertain, true);
    assert.deepEqual(failures.at(-1), {
      operation: "repository-identity",
      kind: "cancelled",
      childExitObserved: true,
      childExitSignal: "SIGKILL",
    });
    assert.deepEqual(databaseOpenAtFailure, [true]);
    assert.equal(
      controlled
        .events()
        .filter(
          ({ event, operation }) =>
            event === "start" && operation === "repository-identity",
        ).length,
      launchesBeforeProvision + 1,
      "direct provisioning was not retried during service stop",
    );

    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    const stored = reopened
      .prepare(
        "SELECT workspaceId, path, state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
      )
      .get(taskId) as
      | {
          workspaceId: string;
          path: string;
          state: string;
          gitUncertain: number;
        }
      | undefined;
    reopened.close();
    assert.equal(stored?.workspaceId, binding.workspaceId);
    assert.equal(stored?.path, binding.path);
    assert.equal(stored?.state, "held");
    assert.equal(stored?.gitUncertain, 1);
    assert.equal(existsSync(binding.path), true);
  } finally {
    try {
      await f.close();
    } finally {
      await controlled.cleanup();
    }
  }
});

test("service stop settles archive status and worktree removal before database close", async (t) => {
  const scenarios = [
    {
      name: "archive status",
      commandPrefix: "status --porcelain=v1 --untracked-files=all",
      operation: "archive-status",
    },
    {
      name: "worktree removal",
      commandPrefix: "worktree remove",
      operation: "worktree-remove",
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const repositoryRoot = mkdtempSync(
        join(tmpdir(), "ensemble-archive-stop-source-"),
      );
      const source = sourceRepository(repositoryRoot, "source");
      const controlled = controlledGit();
      const failures: Parameters<
        NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
      >[0][] = [];
      const databaseOpenAtFailure: boolean[] = [];
      let observingService: StandaloneService | undefined;
      const serviceOptions = {
        workspaceManager: {
          gitExecutable: controlled.executable,
          gitTimeoutMs: {
            "archive-status": 30_000,
            "worktree-remove": 30_000,
          },
          gitTerminationGraceMs: 20,
          gitTerminationObservationMs: 40,
          gitFailureObserver: (failure: (typeof failures)[number]) => {
            failures.push(failure);
            const db = (observingService as unknown as { db?: DatabaseSync })
              ?.db;
            databaseOpenAtFailure.push(db?.isOpen ?? false);
          },
        },
      };
      const f = await fixture(serviceOptions, [
        { repositoryId: "repo", path: source },
      ]);
      observingService = f.service;
      try {
        const binding = await f.service.taskWorkspace(f.taskId);
        const repository = binding?.repositories[0];
        assert.ok(binding);
        assert.ok(repository);
        controlled.setRule({
          commandPrefix: scenario.commandPrefix,
          behavior: "stall",
          holdPipe: true,
        });
        const archival = f.service.archiveTask(f.taskId, {
          deliveryConfirmed: true,
          writerOwnershipResolved: true,
          handoffsPreserved: true,
          reconciliationEvidencePreserved: true,
          workspaceContentsPreserved: true,
        });
        const ready = await waitForControlledGitEvent(
          controlled,
          ({ event, operation }) =>
            event === "ready" && operation === scenario.operation,
        );
        assert.ok(ready.atMs !== undefined);
        const [result] = await Promise.all([archival, f.service.stop()]);
        const elapsedMs = Date.now() - ready.atMs;
        assert.ok(elapsedMs < 20 + 40 + 800, `settled in ${elapsedMs}ms`);
        t.diagnostic(
          `service-archive-stop-evidence ${JSON.stringify({
            operation: scenario.operation,
            readyToSettleMs: elapsedMs,
            termGraceMs: 20,
            observationMs: 40,
            childExitSignal: failures.at(-1)?.childExitSignal,
            databaseOpenAtChildExit: databaseOpenAtFailure.at(-1),
          })}`,
        );
        assert.equal(result.outcome, "retained");
        if (result.outcome === "retained") {
          assert.equal(result.binding.workspaceId, binding.workspaceId);
          assert.equal(result.binding.state, "held");
          assert.equal(result.binding.gitUncertain, true);
          assert.match(
            result.reason,
            new RegExp(`cancelled during ${scenario.operation}`),
          );
        }
        assert.deepEqual(failures.at(-1), {
          operation: scenario.operation,
          kind: "cancelled",
          childExitObserved: true,
          childExitSignal: "SIGKILL",
        });
        assert.deepEqual(databaseOpenAtFailure, [true]);
        assert.equal(existsSync(repository.workspacePath), true);
        assert.equal(
          controlled
            .events()
            .filter(
              ({ event, operation }) =>
                event === "start" && operation === scenario.operation,
            ).length,
          1,
          `${scenario.operation} was not retried during service stop`,
        );
        if (scenario.operation === "archive-status")
          assert.equal(
            controlled
              .events()
              .some(
                ({ event, operation }) =>
                  event === "start" && operation === "worktree-remove",
              ),
            false,
            "archive status cancellation never reached removal",
          );

        const reopened = new DatabaseSync(
          join(f.root, "data", "standalone.sqlite"),
        );
        const stored = reopened
          .prepare(
            "SELECT workspaceId, path, state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
          )
          .get(f.taskId) as
          | {
              workspaceId: string;
              path: string;
              state: string;
              gitUncertain: number;
            }
          | undefined;
        const holdCount = (
          reopened
            .prepare(
              "SELECT COUNT(*) AS count FROM task_archival_holds WHERE taskId = ?",
            )
            .get(f.taskId) as { count: number }
        ).count;
        reopened.close();
        assert.equal(stored?.workspaceId, binding.workspaceId);
        assert.equal(stored?.path, binding.path);
        assert.equal(stored?.state, "held");
        assert.equal(stored?.gitUncertain, 1);
        assert.equal(holdCount, 1);
      } finally {
        try {
          await f.close();
        } finally {
          try {
            await controlled.cleanup();
          } finally {
            rmSync(repositoryRoot, { recursive: true, force: true });
          }
        }
      }
    });
  }
});

test("service stop cancels startup workspace recovery and settles before database close", async (t) => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "ensemble-startup-recovery-source-"),
  );
  const source = sourceRepository(repositoryRoot, "source");
  const controlled = controlledGit();
  const failures: Parameters<
    NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
  >[0][] = [];
  const databaseOpenAtFailure: boolean[] = [];
  let observingService: StandaloneService | undefined;
  const serviceOptions = {
    workspaceManager: {
      gitExecutable: controlled.executable,
      gitTimeoutMs: { "repository-identity": 30_000 },
      gitTerminationGraceMs: 20,
      gitTerminationObservationMs: 40,
      gitFailureObserver: (failure: (typeof failures)[number]) => {
        failures.push(failure);
        const db = (observingService as unknown as { db?: DatabaseSync })?.db;
        databaseOpenAtFailure.push(db?.isOpen ?? false);
      },
    },
  };
  const f = await fixture(serviceOptions, [
    { repositoryId: "repo", path: source },
  ]);
  observingService = f.service;
  let recovered: StandaloneService | undefined;
  let reopenedService: StandaloneService | undefined;
  let runtimeFactoryCalls = 0;
  let runtimeStartCalls = 0;
  let runtimeStopCalls = 0;
  const recoveryRuntime = new RuntimeFixture();
  try {
    const binding = await f.service.taskWorkspace(f.taskId);
    const repository = binding?.repositories[0];
    assert.ok(binding);
    assert.ok(repository);
    const db = (f.service as unknown as { db: DatabaseSync }).db;
    db.prepare(
      "UPDATE task_workspace_bindings SET state = 'provisioning', reason = NULL, gitUncertain = 0 WHERE taskId = ?",
    ).run(f.taskId);
    await f.service.stop();

    controlled.setRule({
      commandPrefix: "rev-parse --show-toplevel",
      behavior: "stall",
      holdPipe: true,
    });
    recoveryRuntime.start = async () => {
      runtimeStartCalls++;
    };
    recoveryRuntime.stop = async () => {
      runtimeStopCalls++;
    };
    recovered = new StandaloneService(
      join(f.root, "data"),
      () => {
        runtimeFactoryCalls++;
        return recoveryRuntime;
      },
      undefined,
      serviceOptions,
    );
    observingService = recovered;
    const launchesBeforeRecovery = controlled
      .events()
      .filter(
        ({ event, operation }) =>
          event === "start" && operation === "repository-identity",
      ).length;
    const startup = recovered.start();
    const ready = await waitForControlledGitEvent(
      controlled,
      ({ event, operation }) =>
        event === "ready" && operation === "repository-identity",
    );
    assert.ok(ready.atMs !== undefined);
    const settled = Promise.allSettled([startup, recovered.stop()]);
    let timeout: NodeJS.Timeout | undefined;
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Startup recovery stop exceeded its cleanup bound"),
              ),
            1500,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const elapsedMs = Date.now() - ready.atMs;
    assert.ok(elapsedMs < 20 + 40 + 800, `settled in ${elapsedMs}ms`);
    t.diagnostic(
      `startup-recovery-stop-evidence ${JSON.stringify({
        readyToSettleMs: elapsedMs,
        termGraceMs: 20,
        observationMs: 40,
        childExitSignal: failures.at(-1)?.childExitSignal,
        databaseOpenAtChildExit: databaseOpenAtFailure.at(-1),
        startupOutcome: results[0]?.status,
        runtimeFactoryCalls,
        runtimeStartCalls,
        runtimeStopCalls,
        threadStarts: recoveryRuntime.starts,
        turnStarts: recoveryRuntime.turns,
        startupError:
          results[0]?.status === "rejected"
            ? String(results[0].reason)
            : undefined,
      })}`,
    );
    assert.equal(results[0]?.status, "rejected");
    assert.deepEqual(failures.at(-1), {
      operation: "repository-identity",
      kind: "cancelled",
      childExitObserved: true,
      childExitSignal: "SIGKILL",
    });
    assert.deepEqual(databaseOpenAtFailure, [true]);
    assert.equal(results[1]?.status, "fulfilled");
    assert.equal(runtimeFactoryCalls, 0);
    assert.equal(runtimeStartCalls, 0);
    assert.equal(runtimeStopCalls, 0);
    assert.equal(
      recoveryRuntime.starts,
      0,
      "aborted startup admitted no thread",
    );
    assert.equal(recoveryRuntime.turns, 0, "aborted startup admitted no turn");
    assert.equal(
      controlled
        .events()
        .filter(
          ({ event, operation }) =>
            event === "start" && operation === "repository-identity",
        ).length,
      launchesBeforeRecovery + 1,
      "startup recovery was not retried while stopping",
    );

    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    const stored = reopened
      .prepare(
        "SELECT workspaceId, path, state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
      )
      .get(f.taskId) as
      | {
          workspaceId: string;
          path: string;
          state: string;
          gitUncertain: number;
        }
      | undefined;
    reopened.close();
    assert.equal(stored?.workspaceId, binding.workspaceId);
    assert.equal(stored?.path, binding.path);
    assert.equal(stored?.state, "held");
    assert.equal(stored?.gitUncertain, 1);
    assert.equal(existsSync(repository.workspacePath), true);

    const launchesAfterAbort = controlled
      .events()
      .filter(
        ({ event, operation }) =>
          event === "start" && operation === "repository-identity",
      ).length;
    reopenedService = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
      undefined,
      serviceOptions,
    );
    await reopenedService.start();
    const recoveredBinding = await reopenedService.taskWorkspace(f.taskId);
    assert.equal(recoveredBinding?.state, "held");
    assert.equal(recoveredBinding?.gitUncertain, true);
    assert.equal(
      controlled
        .events()
        .filter(
          ({ event, operation }) =>
            event === "start" && operation === "repository-identity",
        ).length,
      launchesAfterAbort,
      "restart retained the uncertain binding without another Git attempt",
    );
  } finally {
    try {
      await reopenedService?.stop();
    } finally {
      try {
        await recovered?.stop();
      } finally {
        try {
          await f.close();
        } finally {
          try {
            await controlled.cleanup();
          } finally {
            rmSync(repositoryRoot, { recursive: true, force: true });
          }
        }
      }
    }
  }
});

test("startup does not continue after workspace recovery returns to a cancelled manager", async (t) => {
  const f = await fixture();
  let recovered: StandaloneService | undefined;
  let reopenedService: StandaloneService | undefined;
  let runtimeFactoryCalls = 0;
  let runtimeStartCalls = 0;
  let runtimeStopCalls = 0;
  const recoveryRuntime = new RuntimeFixture();
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const recoveryReturned = deferred();
  const releaseRecovery = deferred();
  const stopSettlementEntered = deferred();
  const releaseStopSettlement = deferred();
  let manager: WorkspaceManager | undefined;
  let settleCallCount = 0;
  const originalRecover = WorkspaceManager.prototype.recover;

  try {
    const binding = await f.service.taskWorkspace(f.taskId);
    assert.ok(binding);
    const db = (f.service as unknown as { db: DatabaseSync }).db;
    db.prepare(
      "UPDATE task_workspace_bindings SET state = 'held', reason = 'Retained for cancellation recovery', gitUncertain = 1 WHERE taskId = ?",
    ).run(f.taskId);
    await f.service.stop();

    WorkspaceManager.prototype.recover = async function () {
      await originalRecover.call(this);
      manager = this;
      recoveryReturned.resolve();
      await releaseRecovery.promise;
    };
    recovered = new StandaloneService(join(f.root, "data"), () => {
      runtimeFactoryCalls++;
      return recoveryRuntime;
    });
    recoveryRuntime.start = async () => {
      runtimeStartCalls++;
    };
    recoveryRuntime.stop = async () => {
      runtimeStopCalls++;
    };

    const startupPromise = recovered.start();
    startup = startupPromise;
    await withTimeout(
      recoveryReturned.promise,
      1500,
      "Workspace recovery did not reach its return barrier",
    );
    assert.ok(manager);
    const originalSettle = manager.settle.bind(manager);
    manager.settle = async () => {
      await originalSettle();
      settleCallCount++;
      if (settleCallCount === 1) {
        stopSettlementEntered.resolve();
        await releaseStopSettlement.promise;
      }
    };

    const stoppingPromise = recovered.stop();
    stopping = stoppingPromise;
    await withTimeout(
      stopSettlementEntered.promise,
      1500,
      "Service stop did not reach workspace settlement",
    );
    assert.equal(
      (recovered as unknown as { db: DatabaseSync }).db.isOpen,
      true,
      "service stop is held before database close while recovery returns",
    );
    releaseRecovery.resolve();

    let startupResult: PromiseSettledResult<void>;
    startupResult = await withTimeout(
      startupPromise.then(
        () => ({ status: "fulfilled" as const, value: undefined }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      1500,
      "Cancelled startup did not settle within its cleanup bound",
    );
    t.diagnostic(
      `startup-recover-return-cancel-evidence ${JSON.stringify({
        startupOutcome: startupResult.status,
        startupError:
          startupResult.status === "rejected"
            ? String(startupResult.reason)
            : undefined,
        runtimeFactoryCalls,
        runtimeStartCalls,
        runtimeStopCalls,
        threadStarts: recoveryRuntime.starts,
        turnStarts: recoveryRuntime.turns,
        databaseOpenBeforeRecoveryRelease: true,
        stopSettlementCalls: settleCallCount,
      })}`,
    );
    assert.equal(startupResult.status, "rejected");
    if (startupResult.status === "rejected")
      assert.match(
        String(startupResult.reason),
        /Workspace manager is stopping/,
      );
    assert.equal(runtimeFactoryCalls, 0);
    assert.equal(runtimeStartCalls, 0);
    assert.equal(runtimeStopCalls, 0);
    assert.equal(
      recoveryRuntime.starts,
      0,
      "cancelled startup admitted no thread",
    );
    assert.equal(
      recoveryRuntime.turns,
      0,
      "cancelled startup admitted no turn",
    );

    releaseStopSettlement.resolve();
    const stoppingResult = await withTimeout(
      stoppingPromise.then(
        () => ({ status: "fulfilled" as const, value: undefined }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      1500,
      "Workspace stop did not settle within its cleanup bound",
    );
    assert.equal(stoppingResult.status, "fulfilled");

    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    const stored = reopened
      .prepare(
        "SELECT workspaceId, path, state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
      )
      .get(f.taskId) as
      | {
          workspaceId: string;
          path: string;
          state: string;
          gitUncertain: number;
        }
      | undefined;
    reopened.close();
    assert.equal(stored?.workspaceId, binding.workspaceId);
    assert.equal(stored?.path, binding.path);
    assert.equal(stored?.state, "held");
    assert.equal(stored?.gitUncertain, 1);

    reopenedService = new StandaloneService(
      join(f.root, "data"),
      () => new RuntimeFixture(),
    );
    await reopenedService.start();
    const recoveredBinding = await reopenedService.taskWorkspace(f.taskId);
    assert.equal(recoveredBinding?.workspaceId, binding.workspaceId);
    assert.equal(recoveredBinding?.state, "held");
    assert.equal(recoveredBinding?.gitUncertain, true);
  } finally {
    releaseRecovery.resolve();
    releaseStopSettlement.resolve();
    WorkspaceManager.prototype.recover = originalRecover;
    const pending = [startup, stopping].filter(
      (promise): promise is Promise<void> => promise !== undefined,
    );
    if (pending.length > 0)
      await withTimeout(
        Promise.allSettled(pending).then(() => {}),
        1500,
        "Startup or service stop did not settle during test cleanup",
      );
    try {
      if (reopenedService)
        await withTimeout(
          reopenedService.stop(),
          1500,
          "Reopened service did not stop during test cleanup",
        );
    } finally {
      try {
        if (recovered)
          await withTimeout(
            recovered.stop(),
            1500,
            "Recovered service did not stop during test cleanup",
          );
      } finally {
        if (runtimeFactoryCalls > 0 && runtimeStopCalls === 0)
          await withTimeout(
            recoveryRuntime.stop(),
            1500,
            "Fixture runtime did not stop during test cleanup",
          );
        await withTimeout(
          f.close(),
          1500,
          "Task-writer fixture did not close during test cleanup",
        );
      }
    }
  }
});

test("real Git service provisioning, execution lookup, and clean archive stay within measured bounds", async (t) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "ensemble-git-timing-"));
  const source = sourceRepository(repositoryRoot, "timing-source");
  const secondSource = sourceRepository(repositoryRoot, "timing-source-two");
  const controlled = controlledGit();
  const f = await fixture(
    {
      workspaceManager: {
        gitExecutable: controlled.executable,
      },
    },
    [
      { repositoryId: "repo-a", path: source },
      { repositoryId: "repo-b", path: secondSource },
    ],
  );
  try {
    const binding = await f.service.taskWorkspace(f.taskId);
    assert.equal(binding?.state, "ready");
    assert.equal(binding?.repositories.length, 2);
    const archived = await f.service.archiveTask(f.taskId, {
      deliveryConfirmed: true,
      writerOwnershipResolved: true,
      handoffsPreserved: true,
      reconciliationEvidencePreserved: true,
      workspaceContentsPreserved: true,
    });
    assert.equal(archived.outcome, "cleaned");
    assert.equal(existsSync(binding?.path ?? ""), false);
    const measurements = new Map<string, number[]>();
    for (const event of controlled.events()) {
      if (event.event !== "finish" || event.elapsedMs === undefined) continue;
      const values = measurements.get(event.operation ?? "other") ?? [];
      values.push(event.elapsedMs);
      measurements.set(event.operation ?? "other", values);
    }
    const summary = Object.fromEntries(
      [...measurements.entries()].map(([operation, values]) => {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        const medianMs =
          sorted.length % 2 === 0
            ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
            : (sorted[middle] ?? 0);
        return [
          operation,
          {
            count: sorted.length,
            minMs: sorted[0],
            medianMs,
            maxMs: sorted.at(-1),
          },
        ];
      }),
    );
    assert.ok(summary["worktree-add"]);
    assert.ok(summary["archive-status"]);
    assert.ok(summary["worktree-remove"]);
    const maximumObservedMs = Math.max(...[...measurements.values()].flat());
    for (const [operation, values] of measurements) {
      const limitMs =
        operation === "repository-identity" ||
        operation === "ref-resolution" ||
        operation === "checkout-validation"
          ? 30_000
          : 120_000;
      assert.ok(
        Math.max(...values) < limitMs,
        `${operation} exceeded its bound`,
      );
    }
    t.diagnostic(
      `bounded-git-service-evidence ${JSON.stringify({
        node: process.version,
        git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
        result:
          "two-repository service provisioning, execution lookup, clean archive",
        operations: summary,
        maxObservedMs: maximumObservedMs,
      })}`,
    );
  } finally {
    try {
      await f.close();
    } finally {
      try {
        await controlled.cleanup();
      } finally {
        rmSync(repositoryRoot, { recursive: true, force: true });
      }
    }
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
