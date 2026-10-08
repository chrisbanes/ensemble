import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CoordinationStore,
  type CoordinationCall,
} from "../src/core/coordination.js";
import { DomainStore, type DomainCommand } from "../src/core/domain.js";
import {
  emptyRetainedEvidenceCandidate,
  retainedEvidenceLimits,
  type RetainedEvidenceCandidate,
} from "../src/core/retained-evidence.js";
import { Store } from "../src/core/store.js";
import { SchedulerStore } from "../src/standalone/scheduler.js";
import { captureRetainedResultEvidence } from "../src/standalone/retained-evidence.js";
import { ExecutionState } from "../src/standalone/state.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const leadProfileId = "30000000-0000-4000-8000-000000000001";
const workerProfileId = "30000000-0000-4000-8000-000000000002";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const workId = "work-retained-result";
const threadId = "thread-retained-result";
const turnId = "turn-retained-result";

type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-retained-result-"));
  const filename = join(directory, "standalone.sqlite");
  let db = new DatabaseSync(filename);
  let domain!: DomainStore;
  let state!: ExecutionState;
  let scheduler!: SchedulerStore;
  let coordination!: CoordinationStore;
  let commandSequence = 0;
  const initialize = () => {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("retained-result-test");
    domain = new DomainStore(db);
    domain.migrate();
    state = new ExecutionState(db);
    scheduler = new SchedulerStore(db);
    coordination = new CoordinationStore(db);
    coordination.migrate();
  };
  initialize();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: randomUUID() } as DomainCommand);

  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfileId,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "review",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfileId,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Retained result test",
    leadProfileId,
  });
  run({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  run({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Retain exact result evidence",
    outcome: "Persist only the exact bound evidence",
    ready: true,
  });
  domain.ensureLeadAssignment(taskId);
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfileId],
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId: workerProfileId,
    brief: "Build and report",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const task = domain.task(taskId);
  const assignment = domain.assignment(assignmentId);
  db.prepare(`INSERT INTO execution_intents
    (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval)
    VALUES (?,?,'work','/tmp/work','running',NULL,?,?,'chatgpt','workspaceWrite','never')`).run(
    randomUUID(),
    workId,
    threadId,
    turnId,
  );
  state.bindTask(workId, {
    taskId,
    assignmentId,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(assignment.instructionsRevision),
    profileRevision: Number(assignment.profileRevision),
  });
  const binding = db
    .prepare(
      "SELECT conversationRevision FROM task_execution_bindings WHERE workId=?",
    )
    .get(workId) as { conversationRevision: number };
  db.prepare(`INSERT INTO task_work_revisions
    (workId,assignmentId,conversationRevision,workRevision) VALUES (?,?,?,1)`).run(
    workId,
    assignmentId,
    binding.conversationRevision,
  );
  db.prepare(`INSERT INTO execution_pending_effects
    (workId,effectKey,state,reason)
    VALUES (?,'assignment-result','pending','Assignment result has not been committed')`).run(
    workId,
  );
  db.prepare("UPDATE domain_assignments SET state='running' WHERE id=?").run(
    assignmentId,
  );
  scheduler.ensure({
    requestKey: `assignment:${assignmentId}:initial`,
    workId,
    kind: "assignment",
    taskId,
    projectId,
    assignmentId,
    taskVersion: Number(task.version),
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(assignment.instructionsRevision),
    profileRevision: Number(assignment.profileRevision),
    prompt: "Build and report",
    workspace: "/tmp/work",
    previousWorkId: null,
  });
  db.prepare("UPDATE turn_requests SET state='active' WHERE workId=?").run(
    workId,
  );

  const identity = () => {
    const currentTask = domain.task(taskId);
    const currentAssignment = domain.assignment(assignmentId);
    const currentBinding = state.taskBinding(workId);
    const admittedRequest = db
      .prepare("SELECT taskVersion FROM turn_requests WHERE workId=?")
      .get(workId) as { taskVersion: number } | undefined;
    const revision = db
      .prepare("SELECT workRevision FROM task_work_revisions WHERE workId=?")
      .get(workId) as { workRevision: number };
    assert.ok(currentBinding);
    assert.ok(admittedRequest);
    return {
      taskId,
      taskVersion: Number(admittedRequest.taskVersion),
      captureTaskVersion: Number(currentTask.version),
      assignmentId,
      assignmentVersion: Number(currentAssignment.version),
      workId,
      workRevision: Number(revision.workRevision),
      requestSequence: scheduler.sequence(workId),
      conversationRevision: Number(currentBinding.conversationRevision),
      instructionsRevision: Number(currentAssignment.instructionsRevision),
      profileRevision: Number(currentAssignment.profileRevision),
      profileId: String(currentAssignment.profileId),
      threadId,
      turnId,
    };
  };

  return {
    directory,
    identity,
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    get coordination() {
      return coordination;
    },
    get scheduler() {
      return scheduler;
    },
    configureTaskTitle(title: string) {
      run({
        type: "task.configure",
        actor: "operator",
        projectId,
        taskId,
        expectedVersion: Number(domain.task(taskId).version),
        title,
      });
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      initialize();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function report(callId: string = randomUUID()): CoordinationCall {
  return {
    threadId,
    turnId,
    callId,
    tool: "ensemble_report_result",
    arguments: { summary: "Completed work" },
  };
}

function candidate(
  identity: ReturnType<ReturnType<typeof fixture>["identity"]>,
  bytes: Uint8Array,
  itemCount = 1,
): RetainedEvidenceCandidate {
  const value = emptyRetainedEvidenceCandidate(identity);
  const capturedAt = value.capturedAt;
  value.items = Array.from({ length: itemCount }, (_, index) => {
    const content = Buffer.from(bytes);
    return {
      itemId: randomUUID(),
      kind: "file" as const,
      state: "available" as const,
      source: "change-file" as const,
      sourceIndex: index,
      repositoryId: null,
      path: `evidence-${index}.txt`,
      originRoot: "/tmp/retained-result-test",
      mime: "text/plain; charset=utf-8",
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      capturedAt,
      observedAt: capturedAt,
      provenance: { changeFileIndex: index },
      bytes: Uint8Array.from(content),
    };
  });
  return value;
}

test("bound result, exact evidence bytes and receipt replay survive a real SQLite reopen", () => {
  const f = fixture();
  try {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("first\r\nsecond\r\nlast", "utf8"),
    ]);
    const call = report("retained-evidence-replay");
    const first = f.coordination.recordResult(
      call,
      candidate(f.identity(), bytes),
    );
    assert.equal(first.replayed, false);
    const manifest = f.coordination
      .retainedEvidence()
      .result(taskId, first.result.resultId);
    assert.ok(manifest);
    assert.equal(manifest.state, "available");
    assert.equal(manifest.payloadBytes, bytes.byteLength);
    const itemId = manifest.items[0]?.itemId;
    assert.ok(itemId);
    assert.deepEqual(
      f.coordination
        .retainedEvidence()
        .item(taskId, first.result.resultId, itemId)?.bytes,
      bytes,
    );

    const replacement = Buffer.from("candidate from replay must be ignored");
    const replay = f.coordination.recordResult(
      call,
      candidate(f.identity(), replacement),
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(
      f.coordination.retainedEvidence().result(taskId, first.result.resultId)
        ?.evidenceId,
      manifest.evidenceId,
    );
    assert.deepEqual(
      f.coordination
        .retainedEvidence()
        .item(taskId, first.result.resultId, itemId)?.bytes,
      bytes,
    );

    f.reopen();
    const reopened = f.coordination
      .retainedEvidence()
      .item(taskId, first.result.resultId, itemId);
    assert.ok(reopened);
    assert.deepEqual(reopened.bytes, bytes);
    assert.equal(
      reopened.item.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
  } finally {
    f.close();
  }
});

test("callback without eligible file links commits a truthful empty manifest while the direct result path does not", () => {
  const f = fixture();
  try {
    const callbackCall = report("empty-retained-evidence");
    const callback = f.coordination.recordResult(
      callbackCall,
      emptyRetainedEvidenceCandidate(f.identity()),
    );
    const manifest = f.coordination
      .retainedEvidence()
      .result(taskId, callback.result.resultId);
    assert.equal(manifest?.state, "empty");
    assert.deepEqual(manifest?.items, []);

    const directFixture = fixture();
    try {
      const direct = directFixture.coordination.recordResult(
        report("direct-result-without-candidate"),
      );
      assert.equal(
        directFixture.coordination
          .retainedEvidence()
          .result(taskId, direct.result.resultId),
        undefined,
      );
      assert.equal(
        (
          directFixture.db
            .prepare("SELECT COUNT(*) AS count FROM retained_result_evidence")
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      directFixture.close();
    }
  } finally {
    f.close();
  }
});

test("task revision change during evidence capture rejects the result receipt and manifest atomically", async () => {
  const f = fixture();
  try {
    const identity = f.identity();
    let policyReads = 0;
    const candidateAtCapture = await captureRetainedResultEvidence({
      identity,
      review: undefined,
      currentWorkspace: async () => ({
        taskId,
        taskVersion: identity.captureTaskVersion,
        visibility: "retained-result-test",
        controlPaths: [],
      }),
      currentPolicy: async () => {
        policyReads++;
        if (policyReads === 2)
          f.configureTaskTitle(
            "Changed while result evidence was being captured",
          );
        const currentVersion = Number(f.domain.task(taskId).version);
        return {
          taskVersion: currentVersion,
          fingerprint: `retained-policy-${currentVersion}`,
          excluded: [],
          authorizedRepositoryIds: [],
        };
      },
      turnCaptures: {},
      exportComparison: () => undefined,
    });
    assert.equal(policyReads, 2);
    assert.equal(
      candidateAtCapture.identity.captureTaskVersion,
      identity.captureTaskVersion,
    );
    const call = report("task-revision-changed-during-capture");
    assert.throws(
      () => f.coordination.recordResult(call, candidateAtCapture),
      /Retained result evidence binding changed/,
    );
    assert.equal(
      (
        f.db
          .prepare("SELECT COUNT(*) AS count FROM coordination_results")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM coordination_receipts WHERE callId=?",
          )
          .get(call.callId) as { count: number }
      ).count,
      0,
    );
    assert.equal(
      f.db
        .prepare("SELECT state FROM domain_assignments WHERE id=?")
        .get(assignmentId)?.state,
      "running",
    );
    assert.equal(
      f.db
        .prepare("SELECT state FROM execution_pending_effects WHERE workId=?")
        .get(workId)?.state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("an available-payload write failure rolls back that subwrite and commits complete gaps with the valid result", () => {
  const f = fixture();
  try {
    const call = report("retained-evidence-item-write-failure");
    const value = candidate(f.identity(), Buffer.from("exact result bytes"));
    f.db.exec(`CREATE TRIGGER fail_available_retained_item BEFORE INSERT ON retained_result_evidence_items
      WHEN NEW.state='available'
      BEGIN SELECT RAISE(ABORT, 'injected available-payload failure'); END`);
    const recorded = f.coordination.recordResult(call, value);
    const manifest = f.coordination
      .retainedEvidence()
      .result(taskId, recorded.result.resultId);
    assert.equal(manifest?.state, "gap");
    assert.equal(manifest?.payloadBytes, 0);
    assert.equal(manifest?.items.length, 1);
    assert.equal(manifest?.items[0]?.state, "gap");
    assert.equal(manifest?.items[0]?.reason, "unavailable");
    assert.deepEqual(
      f.coordination.results(taskId).map((result) => result.resultId),
      [recorded.result.resultId],
    );
    assert.ok(f.coordination.receipt(call));
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT content,state,size FROM retained_result_evidence_items",
          )
          .get() as { content: Uint8Array | null; state: string; size: number }
      ).state,
      "gap",
    );
    const stored = f.db
      .prepare("SELECT content,state,size FROM retained_result_evidence_items")
      .get() as { content: Uint8Array | null; state: string; size: number };
    assert.equal(stored.content, null);
    assert.equal(stored.size, 0);
    assert.equal(
      (
        f.db
          .prepare("SELECT state FROM execution_pending_effects WHERE workId=?")
          .get(workId) as { state: string }
      ).state,
      "settled",
    );
  } finally {
    f.close();
  }
});

test("a receipt commit failure rolls back the result and complete retained evidence", () => {
  const f = fixture();
  try {
    const call = report("retained-evidence-receipt-failure");
    const value = candidate(f.identity(), Buffer.from("exact result bytes"));
    f.db.exec(`CREATE TRIGGER fail_coordination_receipt BEFORE INSERT ON coordination_receipts
      BEGIN SELECT RAISE(ROLLBACK, 'injected receipt commit failure'); END`);
    assert.throws(
      () => f.coordination.recordResult(call, value),
      /injected receipt commit failure/,
    );
    assert.deepEqual(f.coordination.results(taskId), []);
    assert.equal(f.coordination.receipt(call), undefined);
    assert.equal(
      (
        f.db
          .prepare("SELECT COUNT(*) AS count FROM retained_result_evidence")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM retained_result_evidence_items",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        f.db
          .prepare("SELECT state FROM execution_pending_effects WHERE workId=?")
          .get(workId) as { state: string }
      ).state,
      "pending",
    );
    assert.equal(f.domain.assignment(assignmentId).state, "running");
  } finally {
    f.close();
  }
});

test("retained byte quotas turn excess evidence into a gap without rejecting a valid result", () => {
  const f = fixture();
  try {
    const bytes = Buffer.alloc(retainedEvidenceLimits.maxImageOrPdfBytes, 7);
    const value = emptyRetainedEvidenceCandidate(f.identity());
    value.items = Array.from({ length: 5 }, (_, index) => ({
      itemId: randomUUID(),
      kind: "file" as const,
      state: "available" as const,
      source: "change-file" as const,
      sourceIndex: index,
      repositoryId: null,
      path: `evidence-${index}.png`,
      originRoot: "/tmp/retained-result-test",
      mime: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      capturedAt: value.capturedAt,
      observedAt: value.capturedAt,
      provenance: { changeFileIndex: index },
      bytes: Uint8Array.from(bytes),
    }));
    const recorded = f.coordination.recordResult(
      report("retained-evidence-quota"),
      value,
    );
    const manifest = f.coordination
      .retainedEvidence()
      .result(taskId, recorded.result.resultId);
    assert.equal(manifest?.state, "partial");
    assert.equal(manifest?.payloadBytes, retainedEvidenceLimits.maxResultBytes);
    assert.equal(
      manifest?.items.filter((item) => item.state === "available").length,
      4,
    );
    assert.equal(manifest?.items.at(-1)?.state, "gap");
    assert.equal(manifest?.items.at(-1)?.reason, "quota");
    assert.ok(f.coordination.receipt(report("retained-evidence-quota")));
  } finally {
    f.close();
  }
});

test("a callback with a stale thread or turn remains rejected before retaining evidence", () => {
  const f = fixture();
  try {
    const call = {
      ...report("stale-retained-evidence"),
      threadId: "foreign-thread",
    };
    assert.throws(
      () =>
        f.coordination.recordResult(
          call,
          candidate(f.identity(), Buffer.from("must not be stored")),
        ),
      /not bound to current work/,
    );
    assert.deepEqual(f.coordination.results(taskId), []);
    assert.equal(f.coordination.receipt(call), undefined);
    assert.equal(
      (
        f.db
          .prepare("SELECT COUNT(*) AS count FROM retained_result_evidence")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    f.close();
  }
});
