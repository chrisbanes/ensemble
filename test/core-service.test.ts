import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Coordinator, type WorkerHost } from "../src/core/coordinator.js";
import { EnsembleService, type CallerContext } from "../src/core/service.js";
import { Store } from "../src/core/store.js";

const taskId = "10000000-0000-4000-8000-000000000001";
const secondTaskId = "10000000-0000-4000-8000-000000000003";
const assignmentId = "20000000-0000-4000-8000-000000000001";
const secondAssignmentId = "20000000-0000-4000-8000-000000000002";

function fixture(
  options: { spawn?: WorkerHost["spawn"]; find?: WorkerHost["find"] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"));
  const filename = join(directory, "ensemble.db");
  const db = new DatabaseSync(filename);
  const store = new Store(db);
  const hostKey = store.ensureHost("fake");
  const initialProject = store.bindProject(hostKey, "host-project", "lead");
  store.setProjectInstructions(initialProject.projectId, "First instructions");
  let configuration = {
    externalProjectId: "host-project",
    coordinatorConversationId: "lead",
    instructions: "First instructions",
  };
  let launchConfigurationValid = true;
  let spawnCount = 0;
  const conversationIds = new Map<string, string>();
  const host: WorkerHost = {
    async spawn(assignment, coordinatorConversationId) {
      spawnCount++;
      const conversationId = await (options.spawn ?? (async () => "worker"))(
        assignment,
        coordinatorConversationId,
      );
      conversationIds.set(assignment.id, conversationId);
      return conversationId;
    },
    async find(assignment) {
      if (options.find) return options.find(assignment);
      const conversationId = conversationIds.get(assignment.id);
      return conversationId ? [conversationId] : [];
    },
  };
  const coordinator = new Coordinator(store, host, hostKey);
  const service = new EnsembleService(store, coordinator, {
    hostKey,
    getConfiguration: async () => configuration,
    async validateLaunch() {
      if (!launchConfigurationValid)
        throw new Error("Configure the worker provider and model first");
    },
  });
  return {
    store,
    service,
    hostKey,
    get spawnCount() {
      return spawnCount;
    },
    setLaunchConfigurationValid(valid: boolean) {
      launchConfigurationValid = valid;
    },
    setConfiguration(next: typeof configuration) {
      configuration = next;
    },
    caller(overrides: Partial<CallerContext> = {}): CallerContext {
      return {
        hostKey,
        externalProjectId: configuration.externalProjectId,
        externalConversationId: configuration.coordinatorConversationId,
        ...overrides,
      };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createTask(
  service: EnsembleService,
  context: CallerContext,
  id: string,
  title: string,
) {
  return service.createTask(context, { id, title });
}

async function delegate(
  service: EnsembleService,
  context: CallerContext,
  id: string,
  taskIdValue: string,
  brief: string,
) {
  return service.delegate(context, { id, taskId: taskIdValue, brief });
}

test("core service authorizes coordinator commands and assigned-worker reports", async () => {
  const f = fixture();
  try {
    const context = f.caller();
    const binding = f.store.resolveProject(f.hostKey, "host-project");
    assert.notEqual(binding.projectId, "host-project");
    assert.deepEqual(
      await createTask(f.service, context, taskId, "Investigate"),
      { id: taskId, projectId: binding.projectId, title: "Investigate" },
    );
    const assignment = await delegate(
      f.service,
      context,
      assignmentId,
      taskId,
      "Find the cause",
    );
    assert.equal(assignment.projectId, binding.projectId);
    assert.equal(assignment.state, "running");
    assert.equal(assignment.instructions, "First instructions");
    assert.deepEqual(await f.service.assignments(context), [assignment]);

    await assert.rejects(
      f.service.report(f.caller({ externalConversationId: "another-worker" }), {
        assignmentId,
        result: "unassigned result",
      }),
      /assigned|conversation/i,
    );
    const reported = await f.service.report(
      f.caller({ externalConversationId: "worker" }),
      { assignmentId, result: "Found the cause" },
    );
    assert.equal(reported.state, "completed");
    assert.equal(reported.result, "Found the cause");
  } finally {
    f.close();
  }
});

test("foreign host, project, conversation, worker delegation, and spoofed input are denied", async () => {
  const f = fixture();
  try {
    const context = f.caller();
    await createTask(f.service, context, taskId, "Investigate");
    await assert.rejects(
      createTask(
        f.service,
        f.caller({ hostKey: "foreign" }),
        secondTaskId,
        "Foreign host",
      ),
      /host|coordinator/i,
    );
    await assert.rejects(
      createTask(
        f.service,
        f.caller({ externalProjectId: "foreign-project" }),
        secondTaskId,
        "Foreign project",
      ),
      /project|coordinator/i,
    );
    await assert.rejects(
      createTask(
        f.service,
        f.caller({ externalConversationId: "foreign-conversation" }),
        secondTaskId,
        "Foreign conversation",
      ),
      /coordinator/i,
    );
    await assert.rejects(
      f.service.delegate(f.caller({ externalConversationId: "worker" }), {
        id: assignmentId,
        taskId,
        brief: "Try delegating",
      }),
      /coordinator/i,
    );
    await assert.rejects(
      f.service.createTask(
        { ...context, role: "coordinator" } as CallerContext,
        {
          id: secondTaskId,
          title: "Spoofed role",
        },
      ),
      /role|unknown|context/i,
    );
    await assert.rejects(
      f.service.delegate(context, {
        id: assignmentId,
        taskId,
        brief: "Try changed scope",
        role: "coordinator",
      }),
      /unknown|different content|conflict|unrecognized/i,
    );
    assert.equal(f.spawnCount, 0);
  } finally {
    f.close();
  }
});

test("early worker report reconciles the conversation before validating authority", async () => {
  let service: EnsembleService | undefined;
  let earlyContext: CallerContext | undefined;
  const f = fixture({
    async spawn(assignment) {
      earlyContext ??= {
        hostKey: f.hostKey,
        externalProjectId: "host-project",
        externalConversationId: "early-worker",
      };
      assert.ok(service);
      const reported = await service.report(earlyContext, {
        assignmentId: assignment.id,
        result: "Reported before spawn returned",
      });
      assert.equal(reported.state, "completed");
      return "early-worker";
    },
    async find() {
      return ["early-worker"];
    },
  });
  service = f.service;
  try {
    await createTask(f.service, f.caller(), taskId, "Early result");
    const result = await delegate(
      f.service,
      f.caller(),
      assignmentId,
      taskId,
      "Report early",
    );
    assert.equal(result.state, "completed");
    assert.equal(result.result, "Reported before spawn returned");
    assert.equal(
      f.store.getConversationBinding(assignmentId)?.externalConversationId,
      "early-worker",
    );
  } finally {
    f.close();
  }
});

test("uncertain launches with zero or multiple matches remain held", async () => {
  const f = fixture({
    async spawn() {
      throw new Error("response lost");
    },
    async find() {
      return [];
    },
  });
  try {
    await createTask(f.service, f.caller(), taskId, "Uncertain");
    await assert.rejects(
      delegate(f.service, f.caller(), assignmentId, taskId, "Launch"),
      /response lost/,
    );
    assert.equal(f.store.get(assignmentId).state, "launching");
    await assert.rejects(
      f.service.report(
        f.caller({ externalConversationId: "unverified-worker" }),
        { assignmentId, result: "unverified" },
      ),
      /conversation|assigned|launching/i,
    );
    assert.equal(f.store.get(assignmentId).state, "launching");

    const ambiguous = fixture({
      async find() {
        return ["duplicate-one", "duplicate-two"];
      },
    });
    try {
      const binding = ambiguous.store.resolveProject(
        ambiguous.hostKey,
        "host-project",
      );
      ambiguous.store.createTask(taskId, binding.projectId, "Ambiguous");
      ambiguous.store.assign(assignmentId, taskId, binding.projectId, "Launch");
      ambiguous.store.beginLaunch(assignmentId);
      await assert.rejects(
        ambiguous.service.reconcile(),
        /Multiple host conversations/,
      );
      assert.equal(ambiguous.store.get(assignmentId).state, "launching");
      assert.equal(
        ambiguous.store.getConversationBinding(assignmentId),
        undefined,
      );
    } finally {
      ambiguous.close();
    }
  } finally {
    f.close();
  }
});

test("launch preflight preserves pending intent, instruction snapshots, and replay", async () => {
  const f = fixture();
  try {
    await createTask(f.service, f.caller(), taskId, "Preflight");
    f.setLaunchConfigurationValid(false);
    await assert.rejects(
      delegate(f.service, f.caller(), assignmentId, taskId, "Launch"),
      /Configure/,
    );
    assert.equal(f.store.get(assignmentId).state, "pending");
    assert.equal(f.spawnCount, 0);

    f.setLaunchConfigurationValid(true);
    const launched = await delegate(
      f.service,
      f.caller(),
      assignmentId,
      taskId,
      "Launch",
    );
    assert.equal(launched.state, "running");
    assert.equal(launched.instructions, "First instructions");
    f.setConfiguration({
      externalProjectId: "host-project",
      coordinatorConversationId: "lead",
      instructions: "Changed instructions",
    });
    f.setLaunchConfigurationValid(false);
    const replay = await delegate(
      f.service,
      f.caller(),
      assignmentId,
      taskId,
      "Launch",
    );
    assert.equal(replay.instructions, "First instructions");
    assert.equal(replay.state, "running");
    assert.equal(f.spawnCount, 1);
    await f.service.report(f.caller({ externalConversationId: "worker" }), {
      assignmentId,
      result: "Completed before blank-settings replay",
    });
    const completedReplay = await delegate(
      f.service,
      f.caller(),
      assignmentId,
      taskId,
      "Launch",
    );
    assert.equal(completedReplay.state, "completed");
    assert.equal(completedReplay.instructions, "First instructions");
    assert.equal(f.spawnCount, 1);
    assert.deepEqual(
      (await f.service.assignments(f.caller())).map(
        (assignment) => assignment.instructions,
      ),
      ["First instructions"],
    );
    await assert.rejects(
      delegate(
        f.service,
        f.caller(),
        secondAssignmentId,
        taskId,
        "Different assignment",
      ),
      /one assignment|unique|UNIQUE/i,
    );
  } finally {
    f.close();
  }
});

test("historical coordinator loses authority after project selection changes while assigned worker can report", async () => {
  const f = fixture();
  try {
    const oldLead = f.caller();
    await createTask(f.service, oldLead, taskId, "Old project task");
    await delegate(
      f.service,
      oldLead,
      assignmentId,
      taskId,
      "Finish this task",
    );

    f.setConfiguration({
      externalProjectId: "new-host-project",
      coordinatorConversationId: "new-lead",
      instructions: "New project instructions",
    });
    await assert.rejects(
      createTask(f.service, oldLead, secondTaskId, "Old lead follow-up"),
      /coordinator|project/i,
    );
    await assert.rejects(
      f.service.assignments(oldLead),
      /coordinator|project/i,
    );

    const newLead = f.caller();
    const newTask = await createTask(
      f.service,
      newLead,
      secondTaskId,
      "New project task",
    );
    assert.notEqual(
      newTask.projectId,
      f.store.resolveProject(f.hostKey, "host-project").projectId,
    );
    const reported = await f.service.report(
      f.caller({
        externalProjectId: "host-project",
        externalConversationId: "worker",
      }),
      { assignmentId, result: "Old worker finished" },
    );
    assert.equal(reported.state, "completed");
  } finally {
    f.close();
  }
});
