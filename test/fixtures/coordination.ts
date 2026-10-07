import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainStore, type DomainCommand } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const leadProfile = "30000000-0000-4000-8000-000000000001";
const workerProfile = "30000000-0000-4000-8000-000000000002";
const childA = "40000000-0000-4000-8000-000000000001";
const nestedA = "40000000-0000-4000-8000-000000000002";
const childB = "40000000-0000-4000-8000-000000000003";
let commandSequence = 0;
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function nextCommand(): string {
  commandSequence++;
  return `50000000-0000-4000-8000-${String(commandSequence).padStart(12, "0")}`;
}

export function coordinationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-coordination-"));
  const filename = join(directory, "coordination.sqlite");
  let db = new DatabaseSync(filename);
  let domain!: DomainStore;
  let state!: ExecutionState;
  let coordination!: CoordinationStore;
  const initialize = () => {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    state = new ExecutionState(db);
    coordination = new CoordinationStore(db);
    coordination.migrate();
  };
  initialize();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: nextCommand() } as DomainCommand);

  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfile,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfile,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Coordination test",
    leadProfileId: leadProfile,
  });
  for (const id of [taskA, taskB]) {
    run({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: id,
      title: `Task ${id.slice(-1)}`,
      outcome: "Deliver",
      ready: true,
    });
    run({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: id === taskA ? 1 : 2,
      paused: false,
    });
    domain.ensureLeadAssignment(id);
  }
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfile],
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskA,
    assignmentId: childA,
    profileId: workerProfile,
    brief: "Build task A",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskA,
    assignmentId: nestedA,
    profileId: workerProfile,
    brief: "Nested task A",
    resultDestination: "requester",
    requesterAssignmentId: childA,
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId: taskB,
    assignmentId: childB,
    profileId: workerProfile,
    brief: "Build task B",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });

  function addWork(
    assignmentId: string,
    workId: string,
    threadId: string,
    turnId: string,
  ) {
    const assignment = domain.assignment(assignmentId);
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
        "VALUES (?, ?, 'work', '/tmp/work', 'running', NULL, ?, ?, 'chatgpt', 'workspaceWrite', 'never')",
    ).run(nextCommand(), workId, threadId, turnId);
    state.bindTask(workId, {
      taskId: String(assignment.taskId),
      assignmentId,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    const binding = db
      .prepare(
        "SELECT conversationRevision FROM task_execution_bindings WHERE workId = ?",
      )
      .get(workId) as { conversationRevision: number };
    db.prepare(
      "INSERT INTO task_work_revisions (workId, assignmentId, conversationRevision, workRevision) SELECT ?, ?, ?, COALESCE(MAX(workRevision),0)+1 FROM task_work_revisions WHERE assignmentId=? AND conversationRevision=?",
    ).run(
      workId,
      assignmentId,
      binding.conversationRevision,
      assignmentId,
      binding.conversationRevision,
    );
    db.prepare(`INSERT INTO execution_pending_effects
      (workId, effectKey, state, reason)
      VALUES (?, 'assignment-result', 'pending', 'Assignment result has not been committed')`).run(
      workId,
    );
    db.prepare(
      "UPDATE domain_assignments SET state = 'running' WHERE id = ?",
    ).run(assignmentId);
  }

  addWork(childA, "work-child-a", "thread-child-a", "turn-child-a");
  addWork(nestedA, "work-nested-a", "thread-nested-a", "turn-nested-a");
  addWork(childB, "work-child-b", "thread-child-b", "turn-child-b");

  return {
    filename,
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    get state() {
      return state;
    },
    get coordination() {
      return coordination;
    },
    leadAssignment(taskId: string) {
      return domain.ensureLeadAssignment(taskId);
    },
    addWork,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      initialize();
    },
    addUnresolvedWork() {
      run({
        type: "assignment.create",
        actor: "agent",
        projectId,
        taskId: taskB,
        assignmentId: "40000000-0000-4000-8000-000000000004",
        profileId: workerProfile,
        brief: "Unresolved destination",
        resultDestination: "requester:foreign",
        requesterAssignmentId: null,
      });
      db.prepare(
        "UPDATE domain_assignments SET resultRecipientAssignmentId = NULL, resultRecipientDisposition = 'unresolved' WHERE id = ?",
      ).run("40000000-0000-4000-8000-000000000004");
      addWork(
        "40000000-0000-4000-8000-000000000004",
        "work-unresolved",
        "thread-unresolved",
        "turn-unresolved",
      );
    },
  };
}
