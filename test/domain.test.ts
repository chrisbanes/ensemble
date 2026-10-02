import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DomainCommands,
  DomainPolicyError,
  DomainStore,
  type DomainCommand,
} from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { ExecutionState } from "../src/standalone/state.js";

const p = "10000000-0000-4000-8000-000000000001";
const q = "10000000-0000-4000-8000-000000000002";
const profile = "20000000-0000-4000-8000-000000000001";
const a = "30000000-0000-4000-8000-000000000001";
const b = "30000000-0000-4000-8000-000000000002";
const c = "30000000-0000-4000-8000-000000000003";
const assignment = "40000000-0000-4000-8000-000000000001";
const nested = "40000000-0000-4000-8000-000000000002";
const allocated = "40000000-0000-4000-8000-000000000003";
let serial = 0;
const key = () =>
  `50000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-domain-"));
  const filename = join(directory, "db.sqlite");
  let db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  let domain = new DomainStore(db);
  domain.migrate();
  return {
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      db.exec("PRAGMA foreign_keys = ON");
      new Store(db).ensureHost("test");
      domain = new DomainStore(db);
      domain.migrate();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function run(store: DomainStore, command: WithoutKey<DomainCommand>) {
  return store.execute({ ...command, key: key() } as DomainCommand);
}

test("nested assignments stay on the requester's task", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    for (const taskId of [a, b])
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId: p,
        taskId,
        title: "Task",
        outcome: "Ship",
        ready: true,
      });
    run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Own A",
      resultDestination: "lead:A",
      requesterAssignmentId: null,
    });
    const nestedCommand = {
      type: "assignment.create" as const,
      actor: "agent" as const,
      projectId: p,
      taskId: b,
      assignmentId: nested,
      profileId: profile,
      brief: "Delegate",
      resultDestination: "requester:A",
      requesterAssignmentId: assignment,
    };
    assert.throws(() => run(f.domain, nestedCommand), /Requester.*task/);
    assert.equal(f.domain.assignments(b).length, 0);
    const sameTask = run(f.domain, { ...nestedCommand, taskId: a }) as {
      taskId: string;
      requesterAssignmentId: string;
    };
    assert.equal(sameTask.taskId, a);
    assert.equal(sameTask.requesterAssignmentId, assignment);
    const explicit = run(f.domain, {
      ...nestedCommand,
      taskId: b,
      assignmentId: allocated,
      requesterAssignmentId: null,
    }) as { taskId: string };
    assert.equal(explicit.taskId, b);
  } finally {
    f.close();
  }
});

test("versioned commands retain revisions and replay matching stale retries", async () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "original",
      capabilities: "code",
    });
    const project = run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    }) as { paused: number; version: number };
    assert.equal(project.paused, 1);
    const task = run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: false,
    }) as { ready: number };
    assert.equal(task.ready, 0);
    const command: DomainCommand = {
      type: "project.configure",
      key: key(),
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      instructions: "new",
    };
    const first = f.domain.execute(command);
    assert.equal(
      (first as { instructionsRevision: number }).instructionsRevision,
      2,
    );
    assert.deepEqual(f.domain.execute(command), first);
    assert.throws(
      () => f.domain.execute({ ...command, instructions: "changed" }),
      /different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "project.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 1,
          instructions: "stale",
        }),
      /Version conflict/,
    );
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      instructions: "updated",
    });
    const created = run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Work",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    }) as { profileRevision: number; instructionsRevision: number };
    assert.equal(created.profileRevision, 2);
    assert.equal(created.instructionsRevision, 2);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 2,
      instructions: "third",
    });
    assert.equal(f.domain.assignment(assignment).profileRevision, 2);
    run(f.domain, {
      type: "assignment.apply",
      actor: "operator",
      projectId: p,
      assignmentId: assignment,
      expectedVersion: 1,
    });
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 3,
      revoked: true,
    });
    assert.equal(f.domain.instructionRevision(p, 1), "");
    assert.equal(f.domain.instructionRevision(p, 2), "new");
    assert.equal(f.domain.profileRevision(profile, 1).instructions, "original");
    assert.equal(f.domain.profileRevision(profile, 3).instructions, "third");
    assert.ok(
      f.domain
        .assignmentAdmission(assignment)
        .reasons.includes("profile-revoked"),
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "assignment.apply",
          actor: "operator",
          projectId: p,
          assignmentId: assignment,
          expectedVersion: 2,
        }),
      /revoked/,
    );
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    f.reopen();
    assert.equal(f.domain.project(p).instructionsRevision, 2);
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    assert.equal(
      f.domain.execute(command) &&
        (f.domain.execute(command) as { version: number }).version,
      2,
    );
  } finally {
    f.close();
  }
});

test("in-flight command duplicates share one promise", async () => {
  const f = fixture();
  try {
    const commands = new DomainCommands(f.domain);
    const command: DomainCommand = {
      type: "project.create",
      key: key(),
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    };
    const one = commands.execute(command);
    const two = commands.execute(command);
    assert.equal(one, two);
    await assert.rejects(
      commands.execute({ ...command, name: "Other" }),
      /different payload/,
    );
    assert.deepEqual(await one, await two);
  } finally {
    f.close();
  }
});

test("routing settings, provenance and destinations persist without credential values in views", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Do work",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    assert.equal(f.domain.routing(p).enabled, 0);
    const routing = run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Best fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    assert.equal(
      (routing as { credentialAvailable: number }).credentialAvailable,
      1,
    );
    assert.doesNotMatch(JSON.stringify(routing), /TYPESAFE_KEY/);
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    assert.throws(
      () =>
        run(f.domain, {
          type: "routing.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 2,
          enabled: true,
          guidance: "Bad",
          credentialRef: "sk-secret",
          candidateProfileIds: [profile],
        }),
      /invalid_string|regex/i,
    );
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: null,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Who fits?",
      judgment: "Builder",
      disposition: "lead-fallback",
      resultDestination: "lead:task",
    };
    const operation = f.domain.recordRouting(input);
    assert.equal(operation.resultDestination, "lead:task");
    assert.deepEqual(f.domain.recordRouting(input), operation);
    assert.throws(
      () => f.domain.recordRouting({ ...input, disposition: "assigned" }),
      /conflict/,
    );
    assert.throws(
      () => f.domain.recordRouting({ ...input, id: key() }),
      /conflict/,
    );
    f.reopen();
    assert.equal(f.domain.routing(p).enabled, 1);
    assert.equal(
      f.domain.routingOperation(String(operation.id)).disposition,
      "lead-fallback",
    );
  } finally {
    f.close();
  }
});

test("routing assignment and operation commit together after revision and admission checks", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Code",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: assignment,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Choose",
      judgment: "Builder",
      disposition: "assigned",
      resultDestination: "lead:task",
      assignment: {
        profileId: profile,
        brief: "Ship",
        requesterAssignmentId: null,
      },
    };
    assert.throws(() => f.domain.recordRouting(input), /held/);
    assert.throws(() => f.domain.assignment(assignment), /Unknown/);
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    const operation = f.domain.recordRouting(input);
    assert.equal(operation.assignmentId, assignment);
    assert.equal(
      f.domain.assignment(assignment).resultDestination,
      "lead:task",
    );
    assert.deepEqual(f.domain.recordRouting(input), operation);
    f.reopen();
    assert.equal(f.domain.routingOperation(input.id).assignmentId, assignment);
  } finally {
    f.close();
  }
});

test("routing checks a committed standalone hold before writing any disposition", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Code",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    const state = new ExecutionState(f.db);
    state.stopTask(a);
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: key(),
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "jev-1.13.0",
      question: "Choose",
      judgment: "Builder",
      disposition: "assigned",
      resultDestination: "lead:task",
      assignment: {
        profileId: profile,
        brief: "Ship",
        requesterAssignmentId: null,
      },
    };

    assert.throws(
      () => f.domain.recordRouting(input, () => !state.taskHold(a)),
      /external admission/i,
    );
    assert.deepEqual(f.domain.routingOperations(a), []);
    assert.throws(() => f.domain.assignment(input.assignmentId), /Unknown/);
  } finally {
    f.close();
  }
});

test("delayed fallback cannot become actionable after routing or admission changes", () => {
  for (const change of [
    "task",
    "opt-out",
    "pause",
    "guidance",
    "candidates",
    "blocker",
    "profile",
  ] as const) {
    const f = fixture();
    try {
      run(f.domain, {
        type: "profile.create",
        actor: "operator",
        profileId: profile,
        name: "Lead",
        instructions: "Own",
        capabilities: "coordinate",
      });
      run(f.domain, {
        type: "project.create",
        actor: "operator",
        projectId: p,
        name: "Alpha",
        leadProfileId: profile,
      });
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId: p,
        taskId: a,
        title: "Task",
        outcome: "Ship",
        ready: true,
      });
      run(f.domain, {
        type: "project.configure",
        actor: "operator",
        projectId: p,
        expectedVersion: 1,
        paused: false,
      });
      run(f.domain, {
        type: "routing.configure",
        actor: "operator",
        projectId: p,
        expectedVersion: 1,
        enabled: true,
        guidance: "Fit",
        credentialRef: null,
        candidateProfileIds: [profile],
      });
      const input = {
        id: key(),
        projectId: p,
        taskId: a,
        taskVersion: 1,
        assignmentId: null,
        candidateRevisions: { [profile]: 1 },
        guidanceRevision: 2,
        model: "deterministic",
        question: "Who fits?",
        judgment: null,
        disposition: "lead-fallback",
        resultDestination: "lead:task",
      };
      switch (change) {
        case "task":
          run(f.domain, {
            type: "task.configure",
            actor: "operator",
            projectId: p,
            taskId: a,
            expectedVersion: 1,
            outcome: "Changed",
          });
          break;
        case "opt-out":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: false,
            guidance: "Fit",
            credentialRef: null,
            candidateProfileIds: [profile],
          });
          break;
        case "pause":
          run(f.domain, {
            type: "project.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            paused: true,
          });
          break;
        case "guidance":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: true,
            guidance: "New fit",
            credentialRef: null,
            candidateProfileIds: [profile],
          });
          break;
        case "candidates":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: true,
            guidance: "Fit",
            credentialRef: null,
            candidateProfileIds: [],
          });
          break;
        case "blocker":
          run(f.domain, {
            type: "imported-blockers.set",
            actor: "operator",
            projectId: p,
            taskId: a,
            expectedVersion: 1,
            state: "unknown",
          });
          break;
        case "profile":
          run(f.domain, {
            type: "profile.configure",
            actor: "operator",
            profileId: profile,
            expectedVersion: 1,
            capabilities: "new",
          });
          break;
      }
      assert.throws(
        () => f.domain.recordRouting(input),
        /stale|changed|revision/,
        change,
      );
      assert.throws(() => f.domain.routingOperation(input.id), /Unknown/);
      if (change === "opt-out") {
        const explicit = run(f.domain, {
          type: "assignment.create",
          actor: "agent",
          projectId: p,
          taskId: a,
          assignmentId: assignment,
          profileId: profile,
          brief: "Lead allocates",
          resultDestination: "lead:task",
          requesterAssignmentId: null,
        }) as { state: string };
        assert.equal(explicit.state, "pending");
      }
    } finally {
      f.close();
    }
  }
});

test("matching fallback retry replays after later state changes", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Own",
      capabilities: "coordinate",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: null,
      candidateProfileIds: [profile],
    });
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: null,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Who fits?",
      judgment: null,
      disposition: "lead-fallback",
      resultDestination: "lead:task",
    };
    const first = f.domain.recordRouting(input);
    run(f.domain, {
      type: "task.configure",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 1,
      outcome: "Changed",
    });
    f.reopen();
    assert.deepEqual(f.domain.recordRouting(input), first);
  } finally {
    f.close();
  }
});

test("dependency authority, cycle and unknown imported-blocker holds survive restart", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: q,
      name: "Beta",
      leadProfileId: null,
    });
    for (const [projectId, taskId] of [
      [p, a],
      [p, b],
      [q, c],
    ] as const)
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId,
        taskId,
        title: taskId,
        outcome: "Work",
        ready: true,
      });
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "agent",
          projectId: p,
          taskId: a,
          blockerTaskId: b,
          expectedVersion: 1,
        }),
      /Operator/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: a,
          blockerTaskId: a,
          expectedVersion: 1,
        }),
      /itself/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: a,
          blockerTaskId: c,
          expectedVersion: 1,
        }),
      /another project/,
    );
    run(f.domain, {
      type: "dependency.add",
      actor: "operator",
      projectId: p,
      taskId: a,
      blockerTaskId: b,
      expectedVersion: 1,
    });
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: b,
          blockerTaskId: a,
          expectedVersion: 1,
        }),
      /cycle/,
    );
    run(f.domain, {
      type: "imported-blockers.set",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 2,
      state: "unknown",
    });
    f.reopen();
    assert.deepEqual(f.domain.dependencies(a), [b]);
    assert.deepEqual(f.domain.admission(a).reasons, [
      "project-paused",
      "project-lead-unconfigured",
      "imported-blockers-unknown",
      "local-dependency",
    ]);
  } finally {
    f.close();
  }
});

test("capacity limits default, configure sparsely, replay and persist", () => {
  const f = fixture();
  const otherProject = "10000000-0000-4000-8000-000000000003";
  const limits = (projectIds: string[] = []) =>
    (
      f.domain as unknown as {
        capacityLimits(ids: string[]): {
          globalLimit: number;
          defaultProjectLimit: number;
          projectOverrides: Record<string, number>;
          currentUsage: { global: number; projects: Record<string, number> };
          effectiveProjectLimits: Record<string, number>;
        };
      }
    ).capacityLimits(projectIds);
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: null,
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: q,
      name: "Other project",
      leadProfileId: null,
    });
    assert.equal(limits([p, q]).globalLimit, 4);
    assert.equal(limits([p, q]).defaultProjectLimit, 2);
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 2 });

    const initial = {
      type: "capacity.configure" as const,
      actor: "operator" as const,
      globalLimit: 6,
      projectOverrides: { [p]: 3, [q]: 1 },
      key: key(),
    };
    const first = f.domain.execute(initial as never);
    assert.deepEqual(f.domain.execute(initial as never), first);
    const configured = limits([p, q]);
    assert.equal(configured.globalLimit, 6);
    assert.deepEqual(configured.projectOverrides, { [p]: 3, [q]: 1 });
    assert.deepEqual(configured.effectiveProjectLimits, { [p]: 3, [q]: 1 });
    assert.deepEqual(configured.currentUsage, { global: 0, projects: {} });

    assert.throws(
      () =>
        f.domain.execute({
          ...initial,
          globalLimit: 5,
        } as never),
      /Command key already used with different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "agent",
          globalLimit: 5,
          projectOverrides: {},
        } as never),
      /Operator authority required/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "operator",
          globalLimit: 0,
          projectOverrides: {},
        } as never),
      /expected number to be >0/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "operator",
          globalLimit: 5,
          projectOverrides: { [otherProject]: 1 },
        } as never),
      /Unknown domain record/,
    );
    assert.equal(limits([p, q]).globalLimit, 6, "invalid changes roll back");

    run(f.domain, {
      type: "capacity.configure",
      actor: "operator",
      globalLimit: 5,
      projectOverrides: { [p]: null },
    } as never);
    assert.deepEqual(limits([p, q]).projectOverrides, { [q]: 1 });
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 1 });
    f.reopen();
    assert.equal(limits([p, q]).globalLimit, 5);
    assert.deepEqual(limits([p, q]).projectOverrides, { [q]: 1 });
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 1 });
  } finally {
    f.close();
  }
});

test("task.create atomically records dependencies and explicit assignment before readiness wakeup", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: b,
      title: "Blocker",
      outcome: "Finish first",
      ready: false,
    });
    let observed = false;
    const d = new DomainStore(f.db, () => {
      observed = true;
      assert.equal(d.dependencies(a).length, 1);
      assert.equal(d.assignments(a).length, 1);
      assert.equal(d.task(a).version, 2);
      assert.equal(d.admission(a).eligible, false);
    });
    const command = {
      type: "task.create",
      key: key(),
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Rich task",
      outcome: "Ship",
      ready: true,
      blockerTaskIds: [b],
      initialAssignment: { assignmentId: assignment, profileId: profile },
    } as unknown as DomainCommand;
    const receipt = d.execute(command);
    assert.ok(observed);
    assert.equal(d.assignments(a)[0]?.brief, "Task: Rich task\nOutcome: Ship");
    assert.equal(d.assignments(a)[0]?.profileRevision, 1);
    assert.equal(
      d.leadBindings().find((x) => x.taskId === a)?.profileId,
      profile,
    );
    assert.deepEqual(d.execute(command), receipt);
    f.reopen();
    assert.deepEqual(f.domain.execute(command), receipt);
    assert.equal(f.domain.assignments(a).length, 1);
  } finally {
    f.close();
  }
});

test("rich task creation rolls back invalid setup and preserves legacy omitted-field receipts", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "private",
      capabilities: "assign",
    });
    for (const projectId of [p, q])
      run(f.domain, {
        type: "project.create",
        actor: "operator",
        projectId,
        name: "Project",
        leadProfileId: profile,
      });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: q,
      taskId: b,
      title: "Foreign",
      outcome: "Work",
      ready: false,
    });
    const base = {
      type: "task.create" as const,
      actor: "operator" as const,
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    };
    for (const invalid of [
      { blockerTaskIds: [b] },
      { blockerTaskIds: [a] },
      { blockerTaskIds: [b, b] },
      { blockerTaskIds: Array(129).fill(b) },
      {
        initialAssignment: {
          assignmentId: assignment,
          profileId: randomProfile,
        },
      },
      { actor: "agent" },
    ]) {
      assert.throws(() =>
        f.domain.execute({ ...base, ...invalid, key: key() } as DomainCommand),
      );
      assert.equal(f.domain.tasks(p).length, 0);
      assert.equal(f.domain.assignments(a).length, 0);
      assert.equal(f.domain.leadBindings().length, 0);
    }
    const legacy = { ...base, key: key() };
    const receipt = f.domain.execute(legacy);
    f.reopen();
    assert.deepEqual(f.domain.execute(legacy), receipt);
    assert.throws(
      () => f.domain.execute({ ...legacy, blockerTaskIds: [] }),
      /different payload/,
    );
  } finally {
    f.close();
  }
});
const randomProfile = "20000000-0000-4000-8000-000000000099";

test("committed rich creation replays its original receipt after wakeup failure and policy revocation", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "private",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    const command = {
      type: "task.create" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: false,
      initialAssignment: { assignmentId: assignment, profileId: profile },
    };
    const d = new DomainStore(f.db, () => {
      throw new DomainPolicyError("forbidden", "Wakeup unavailable");
    });
    assert.throws(
      () => d.execute(command),
      (error) =>
        error instanceof Error && !(error instanceof DomainPolicyError),
      "committed callback policy class is not a definite precommit rejection",
    );
    assert.equal(f.domain.tasks(p).length, 1);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      revoked: true,
    });
    run(f.domain, {
      type: "task.configure",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 1,
      title: "Changed",
    });
    assert.equal((d.execute(command) as { title: string }).title, "Task");
    f.reopen();
    assert.equal(
      (f.domain.execute(command) as { title: string }).title,
      "Task",
    );
    assert.equal(f.domain.assignments(a).length, 1);
  } finally {
    f.close();
  }
});
