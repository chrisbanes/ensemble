import { OperatorApi } from "../src/standalone/operator-api.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";
import { test } from "node:test";
import { ExecutionState } from "../src/standalone/state.js";
import { StandaloneService } from "../src/standalone/service.js";
import type { Runtime, UnexpectedRequest } from "../src/standalone/codex.js";
import type {
  RuntimeUserInputRequest,
  RuntimeUserInputOutcome,
  NativeInputEndpointIdentity,
  NativeInputReply,
  RuntimeReplyIntent,
} from "../src/standalone/native-input.js";
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function runtimeQuestion(service: StandaloneService, taskId: string) {
  return required(
    service.coordinationView().readTask(taskId).runtimeQuestions?.[0],
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Native service condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
class NativeRuntime implements Runtime {
  generation = "generation";
  starts = 0;
  turns = 0;
  readonly otherTerminals = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  replies = 0;
  interrupts = 0;
  onRequest?: (call: RuntimeUserInputRequest) => void;
  onOutcome?: (outcome: RuntimeUserInputOutcome) => void;
  readonly terminal = deferred<"completed" | "failed">();
  beforeWrite?: () => void;
  afterGate?: () => Promise<void>;
  receipt?: RuntimeReplyIntent;
  confirm = true;
  early = false;
  startResponse = deferred<string>();
  async start() {}
  async stop() {
    this.terminal.resolve("failed");
    for (const terminal of this.otherTerminals.values())
      terminal.resolve("failed");
  }
  async startThread() {
    this.starts++;
    return this.starts === 1 ? "thread" : `thread-${this.starts}`;
  }
  async resumeThread() {}
  async startTurn() {
    this.turns++;
    if (this.early) {
      this.question();
      return this.startResponse.promise;
    }
    if (this.turns === 1) return "turn";
    const turn = `turn-${this.turns}`;
    this.otherTerminals.set(turn, deferred());
    return turn;
  }
  async interruptTurn() {
    this.interrupts++;
  }
  async waitForTurn(_thread?: string, turnId = "turn") {
    return (this.otherTerminals.get(turnId) ?? this.terminal).promise;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  processIdentity() {
    return {
      processId: "fixture-pid",
      processStartedAt: "fixture-start",
      bootId: "fixture-boot",
    };
  }
  currentUserInputGeneration() {
    return this.generation;
  }
  onUserInputRequest(listener: (call: RuntimeUserInputRequest) => void) {
    this.onRequest = listener;
  }
  onUserInputOutcome(listener: (outcome: RuntimeUserInputOutcome) => void) {
    this.onOutcome = listener;
  }
  question(index = 1) {
    const threadId = index === 1 ? "thread" : `thread-${index}`,
      turnId = index === 1 ? "turn" : `turn-${index}`;
    const identity = {
      requestId: index,
      runtimeGeneration: this.generation,
      threadId,
      turnId,
      itemId: "item",
    };
    this.onRequest?.({
      identity,
      request: {
        threadId,
        turnId,
        itemId: "item",
        isBlocking: false,
        autoResolutionMs: null,
        questions: [
          {
            id: "q",
            header: "Place",
            question: "Where?",
            isOther: true,
            isSecret: false,
            options: [{ label: "Local", description: "Here" }],
          },
        ],
      },
      qualification: {
        codexVersion: "codex-cli 0.159.0",
        executableHash: "a".repeat(64),
        threadId,
        runtimeGeneration: this.generation,
        mode: "default",
        model: "fixture",
        modelProvider: "fixture",
        reasoningEffort: null,
        serviceTier: null,
        developerInstructionsDigest: "b".repeat(64),
        continuation: "synchronous",
      },
    });
  }
  async replyUserInput(
    identity: NativeInputEndpointIdentity,
    _reply: NativeInputReply,
    gate: () => RuntimeReplyIntent,
  ) {
    this.beforeWrite?.();
    this.receipt = gate();
    await this.afterGate?.();
    this.replies++;
    this.onOutcome?.({
      ...identity,
      ...this.receipt,
      outcome: this.confirm ? "confirmed" : "sent-unconfirmed",
      reason: "Fixture ordered receipt",
    });
  }
  cancelUserInput(identity: NativeInputEndpointIdentity, reason: string) {
    this.onOutcome?.({
      ...identity,
      ...this.receipt,
      outcome: this.receipt ? "uncertain" : "unavailable",
      reason,
    });
  }
}
function command(service: StandaloneService, body: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}
async function fixture(options: { early?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-native-service-"));
  const runtime = new NativeRuntime();
  runtime.early = options.early ?? false;
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, supervisor: { observationMs: 5 } },
  );
  await service.start();
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "work",
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Native",
    leadProfileId: profileId,
  });
  command(service, {
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Question",
    outcome: "Answer",
    ready: true,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await until(() => service.list().some((i) => i.state === "running"));
  if (!runtime.early) runtime.question();
  try {
    await until(() =>
      Boolean(
        service.coordinationView().readTask(taskId).runtimeQuestions?.length,
      ),
    );
  } catch (error) {
    const diagnostic = JSON.stringify({
      executions: service.list(),
      task: service.coordinationView().readTask(taskId),
    });
    await service.stop();
    throw new Error(diagnostic, { cause: error });
  }
  return {
    root,
    runtime,
    service,
    projectId,
    taskId,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("paused native answer records durably then ordinary unpause replies once on the admitted turn", async () => {
  const f = await fixture();
  try {
    command(f.service, {
      type: "project.configure",
      actor: "operator",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      paused: true,
    });
    const q = runtimeQuestion(f.service, f.taskId);
    const receipt = await f.service.coordinationView().answerRuntimeQuestion({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: q.interactionId,
      expectedRevision: q.revision,
      answers: { q: { answers: ["Local"] } },
    });
    assert.equal(receipt.recorded, true);
    assert.equal(f.runtime.replies, 0);
    assert.equal(runtimeQuestion(f.service, f.taskId).deliveryState, "held");
    command(f.service, {
      type: "project.configure",
      actor: "operator",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      paused: false,
    });
    await until(() => f.runtime.replies === 1);
    assert.equal(f.runtime.turns, 1);
    assert.equal(
      runtimeQuestion(f.service, f.taskId).deliveryState,
      "confirmed",
    );
  } finally {
    await f.close();
  }
});
for (const hold of ["unready", "profile", "ownership", "power"] as const)
  test(`native ${hold} hold retains the answer with zero replies`, async () => {
    const f = await fixture();
    try {
      if (hold === "unready")
        command(f.service, {
          type: "task.configure",
          actor: "operator",
          projectId: f.projectId,
          taskId: f.taskId,
          expectedVersion: Number(f.service.domain().task(f.taskId).version),
          ready: false,
        });
      if (hold === "profile") {
        const profileId = String(
          f.service.domain().project(f.projectId).leadProfileId,
        );
        command(f.service, {
          type: "profile.configure",
          actor: "operator",
          profileId,
          expectedVersion: Number(
            f.service.domain().profile(profileId).version,
          ),
          revoked: true,
        });
      }
      if (hold === "ownership")
        f.service.holdKnownSurvivor(
          required(f.service.list()[0]).workId,
          "fixture survivor",
        );
      if (hold === "power") {
        const db = new (await import("node:sqlite")).DatabaseSync(
          join(f.root, "data", "standalone.sqlite"),
        );
        try {
          new ExecutionState(db).holdPowerAdmission("fixture-power");
        } finally {
          db.close();
        }
      }
      const q = runtimeQuestion(f.service, f.taskId);
      await f.service.coordinationView().answerRuntimeQuestion({
        taskId: f.taskId,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: q.revision,
        answers: { q: { answers: ["Local"] } },
      });
      assert.deepEqual(runtimeQuestion(f.service, f.taskId).answers, {
        q: { answers: ["Local"] },
      });
      assert.equal(f.runtime.replies, 0);
    } finally {
      await f.close();
    }
  });
test("Stop at the final native write gate records no answer effect and retains its accepted answer", async () => {
  const f = await fixture();
  try {
    f.runtime.beforeWrite = () => {
      void f.service.stopTask(f.taskId);
    };
    const q = runtimeQuestion(f.service, f.taskId);
    await f.service.coordinationView().answerRuntimeQuestion({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: q.interactionId,
      expectedRevision: q.revision,
      answers: { q: { answers: ["Local"] } },
    });
    assert.equal(f.runtime.replies, 0);
    assert.deepEqual(runtimeQuestion(f.service, f.taskId).answers, {
      q: { answers: ["Local"] },
    });
    assert.equal(
      runtimeQuestion(f.service, f.taskId).deliveryState,
      "unavailable",
    );
  } finally {
    await f.close();
  }
});
for (const boundary of ["request", "answer", "intent", "write"] as const)
  test(`service restart at ${boundary} preserves the question without any restored native effect`, async () => {
    const f = await fixture();
    let replacement: StandaloneService | undefined;
    try {
      const q = runtimeQuestion(f.service, f.taskId);
      if (boundary !== "request") {
        if (boundary === "answer")
          command(f.service, {
            type: "project.configure",
            actor: "operator",
            projectId: f.projectId,
            expectedVersion: Number(
              f.service.domain().project(f.projectId).version,
            ),
            paused: true,
          });
        if (boundary === "intent")
          f.runtime.afterGate = () => new Promise(() => {});
        if (boundary === "write") f.runtime.confirm = false;
        await f.service.coordinationView().answerRuntimeQuestion({
          taskId: f.taskId,
          key: randomUUID(),
          interactionId: q.interactionId,
          expectedRevision: q.revision,
          answers: { q: { answers: ["Local"] } },
        });
        if (boundary === "intent" || boundary === "write")
          await until(() => Boolean(f.runtime.receipt));
      }
      await f.service.stop();
      const restored = new NativeRuntime();
      restored.generation = "replacement";
      replacement = new StandaloneService(
        join(f.root, "data"),
        () => restored,
        undefined,
        { power: { enabled: false } },
      );
      await replacement.start();
      const record = runtimeQuestion(replacement, f.taskId);
      assert.equal(Boolean(record.answers), boundary !== "request");
      assert.equal(
        record.deliveryState,
        boundary === "intent" || boundary === "write"
          ? "uncertain"
          : "unavailable",
      );
      assert.equal(restored.turns, 0);
      assert.equal(restored.replies, 0);
      restored.onOutcome?.({
        ...{
          requestId: 1,
          runtimeGeneration: "generation",
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
        },
        ...f.runtime.receipt,
        outcome: f.runtime.receipt ? "confirmed" : "unavailable",
        reason: "Delayed old resolution",
      });
      assert.equal(restored.replies, 0);
      assert.equal(replacement.list()[0]?.state, "held");
    } finally {
      await replacement?.stop();
      await f.close();
    }
  });
test("failed durable native receipt commit keeps the callback and ownership held", async () => {
  const f = await fixture();
  try {
    const db = new (await import("node:sqlite")).DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    try {
      db.exec(
        `CREATE TRIGGER reject_native_confirmation BEFORE UPDATE OF deliveryState ON coordination_runtime_questions WHEN NEW.deliveryState='confirmed' BEGIN SELECT RAISE(ABORT,'fixture receipt commit failed'); END`,
      );
    } finally {
      db.close();
    }
    const q = runtimeQuestion(f.service, f.taskId);
    await f.service.coordinationView().answerRuntimeQuestion({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: q.interactionId,
      expectedRevision: q.revision,
      answers: { q: { answers: ["Local"] } },
    });
    await until(() => f.runtime.replies === 1);
    assert.equal(runtimeQuestion(f.service, f.taskId).deliveryState, "sending");
    assert.equal(f.service.list()[0]?.state, "held");
    f.runtime.terminal.resolve("completed");
    await until(() => Boolean(f.service.list()[0]?.reason));
    assert.equal(f.service.list()[0]?.state, "held");
  } finally {
    await f.close();
  }
});
for (const returned of ["turn", "other"] as const)
  test(`early native prebinding reconciles only the ${returned === "turn" ? "exact" : "conflicting"} start response`, async () => {
    const f = await fixture({ early: true });
    try {
      const question = runtimeQuestion(f.service, f.taskId);
      f.runtime.startResponse.resolve(returned);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (returned === "turn") {
        await f.service.coordinationView().answerRuntimeQuestion({
          taskId: f.taskId,
          key: randomUUID(),
          interactionId: question.interactionId,
          expectedRevision: question.revision,
          answers: { q: { answers: ["Local"] } },
        });
        await until(() => f.runtime.replies === 1);
        assert.equal(
          runtimeQuestion(f.service, f.taskId).deliveryState,
          "confirmed",
        );
      } else {
        assert.equal(f.runtime.replies, 0);
        assert.equal(f.service.list()[0]?.state, "held");
        assert.equal(f.service.list()[0]?.turnId, "turn");
        assert.equal(
          runtimeQuestion(f.service, f.taskId).deliveryState,
          "unavailable",
        );
      }
      assert.equal(f.runtime.turns, 1);
    } finally {
      await f.close();
    }
  });
for (const dependency of [
  "local",
  "imported-open",
  "imported-unknown",
] as const)
  test(`native ${dependency} dependency survives clearing an independent pause`, async () => {
    const f = await fixture();
    try {
      let blockerTaskId: string;
      if (dependency === "local") {
        blockerTaskId = randomUUID();
        command(f.service, {
          type: "task.create",
          actor: "operator",
          projectId: f.projectId,
          taskId: blockerTaskId,
          title: "Dependency",
          outcome: "Finish first",
          ready: false,
        });
      } else {
        command(f.service, {
          type: "github.configure",
          actor: "operator",
          projectId: f.projectId,
          expectedVersion: 1,
          credentialRef: "env:UI01_UNUSED_TEST_GITHUB",
          selections: [
            {
              id: "repo",
              kind: "repository",
              repositoryId: "R_FIXTURE",
              owner: "fixture",
              name: "repo",
            },
          ],
          readiness: {
            mode: "any",
            conditions: [{ kind: "label", name: "ready" }],
          },
          repositories: [],
        });
        command(f.service, {
          type: "github.activate",
          actor: "operator",
          projectId: f.projectId,
          selectionId: "repo",
          expectedVersion: 2,
        });
        const db = new (await import("node:sqlite")).DatabaseSync(
          join(f.root, "data", "standalone.sqlite"),
        );
        try {
          const { GitHubSourceStore } = await import(
            "../src/core/github-source.js"
          );
          const sources = new GitHubSourceStore(db);
          sources.reconcileSelection(f.projectId, "repo", {
            complete: true,
            issues: [
              {
                providerInstance: "github.com",
                nodeId: "I_UI01",
                repositoryId: "R_FIXTURE",
                repositoryName: "fixture/repo",
                number: 1,
                title: "Imported blocker",
                body: "Finish first",
                state: "open",
                labels: ["ready"],
                projectFields: [],
              },
            ],
            reason: null,
          });
          blockerTaskId = String(required(sources.issue("I_UI01")).taskId);
          if (dependency === "imported-unknown")
            sources.recordIssueStatus("I_UI01", {
              status: "unknown",
              reason: "fixture-403",
            });
        } finally {
          db.close();
        }
      }
      command(f.service, {
        type: "dependency.add",
        actor: "operator",
        projectId: f.projectId,
        taskId: f.taskId,
        blockerTaskId,
        expectedVersion: Number(f.service.domain().task(f.taskId).version),
      });
      command(f.service, {
        type: "project.configure",
        actor: "operator",
        projectId: f.projectId,
        expectedVersion: Number(
          f.service.domain().project(f.projectId).version,
        ),
        paused: true,
      });
      const q = runtimeQuestion(f.service, f.taskId);
      await f.service.coordinationView().answerRuntimeQuestion({
        taskId: f.taskId,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: q.revision,
        answers: { q: { answers: ["Local"] } },
      });
      command(f.service, {
        type: "project.configure",
        actor: "operator",
        projectId: f.projectId,
        expectedVersion: Number(
          f.service.domain().project(f.projectId).version,
        ),
        paused: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(f.runtime.replies, 0);
      assert.deepEqual(runtimeQuestion(f.service, f.taskId).answers, {
        q: { answers: ["Local"] },
      });
      assert.equal(runtimeQuestion(f.service, f.taskId).deliveryState, "held");
    } finally {
      await f.close();
    }
  });
test("two requesting tasks keep native answers scoped and a command replay sends no second effect", async () => {
  const f = await fixture();
  try {
    const otherTask = randomUUID();
    command(f.service, {
      type: "task.create",
      actor: "operator",
      projectId: f.projectId,
      taskId: otherTask,
      title: "Second question",
      outcome: "Answer separately",
      ready: true,
    });
    await f.service.provisionTask(otherTask);
    await until(
      () => f.service.list().filter((i) => i.state === "running").length === 2,
    );
    f.runtime.question(2);
    const first = runtimeQuestion(f.service, f.taskId);
    const second = runtimeQuestion(f.service, otherTask);
    await assert.rejects(
      f.service.coordinationView().answerRuntimeQuestion({
        taskId: otherTask,
        key: randomUUID(),
        interactionId: first.interactionId,
        expectedRevision: first.revision,
        answers: { q: { answers: ["Local"] } },
      }),
    );
    const input = {
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: first.interactionId,
      expectedRevision: first.revision,
      answers: { q: { answers: ["Local"] } },
    };
    const receipt = await f.service
      .coordinationView()
      .answerRuntimeQuestion(input);
    await until(() => f.runtime.replies === 1);
    assert.deepEqual(
      await f.service.coordinationView().answerRuntimeQuestion(input),
      receipt,
    );
    assert.equal(f.runtime.replies, 1);
    assert.equal(f.runtime.turns, 2);
    assert.equal(
      runtimeQuestion(f.service, otherTask).interactionId,
      second.interactionId,
    );
    assert.equal(runtimeQuestion(f.service, otherTask).answers, null);
    assert.equal(
      f.service.coordinationView().readTask(f.taskId).messages.length,
      0,
    );
  } finally {
    await f.close();
  }
});
for (const control of ["pause", "stop"] as const)
  test(`${control} after native write intent preserves truthful receipt semantics`, async () => {
    const f = await fixture();
    try {
      f.runtime.afterGate = async () => {
        if (control === "pause")
          command(f.service, {
            type: "project.configure",
            actor: "operator",
            projectId: f.projectId,
            expectedVersion: Number(
              f.service.domain().project(f.projectId).version,
            ),
            paused: true,
          });
        else void f.service.stopTask(f.taskId);
      };
      const q = runtimeQuestion(f.service, f.taskId);
      await f.service.coordinationView().answerRuntimeQuestion({
        taskId: f.taskId,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: q.revision,
        answers: { q: { answers: ["Local"] } },
      });
      await until(() => f.runtime.replies === 1);
      assert.equal(
        runtimeQuestion(f.service, f.taskId).deliveryState,
        control === "pause" ? "confirmed" : "uncertain",
      );
      assert.equal(f.runtime.turns, 1);
      if (control === "stop") assert.equal(f.service.list()[0]?.state, "held");
    } finally {
      await f.close();
    }
  });
for (const confounder of ["stop", "generation"] as const)
  test(`early native start response after ${confounder} cannot revive prebound work`, async () => {
    const f = await fixture({ early: true });
    try {
      if (confounder === "stop") void f.service.stopTask(f.taskId);
      else f.runtime.generation = "replacement";
      f.runtime.startResponse.resolve("turn");
      await until(() => f.service.list()[0]?.state === "held");
      assert.equal(f.runtime.replies, 0);
      assert.equal(f.runtime.turns, 1);
      assert.equal(
        runtimeQuestion(f.service, f.taskId).deliveryState,
        "unavailable",
      );
    } finally {
      await f.close();
    }
  });

test("native invalidation storage failure still stops owned resources and rethrows the original error", async () => {
  const f = await fixture();
  const internals = f.service as unknown as {
    db: { isOpen: boolean; exec(sql: string): void } | undefined;
    runtime: NativeRuntime | undefined;
    owner: unknown;
    power: { stop(): Promise<void> } | undefined;
    supervisor: { settle(): Promise<void> } | undefined;
  };
  const db = required(internals.db);
  let runtimeStops = 0,
    powerStops = 0,
    supervisorSettles = 0;
  const originalStop = f.runtime.stop.bind(f.runtime);
  f.runtime.stop = async () => {
    runtimeStops++;
    await originalStop();
  };
  db.exec(`CREATE TRIGGER ui01_stop_invalidation_fault
    BEFORE UPDATE ON coordination_runtime_questions
    WHEN NEW.reason = 'Service stopped; native endpoints lost'
    BEGIN SELECT RAISE(ABORT, 'native-invalidation-storage-failure'); END`);
  const power = internals.power ?? { async stop() {} },
    supervisor = required(internals.supervisor);
  internals.power = power;
  const originalPowerStop = power.stop.bind(power),
    originalSettle = supervisor.settle.bind(supervisor);
  power.stop = async () => {
    powerStops++;
    await originalPowerStop();
  };
  supervisor.settle = async () => {
    supervisorSettles++;
    await originalSettle();
  };
  try {
    await assert.rejects(
      f.service.stop(),
      /native-invalidation-storage-failure/,
    );
    assert.equal(runtimeStops, 1);
    assert.equal(powerStops, 1);
    assert.equal(supervisorSettles, 1);
    assert.equal(db.isOpen, false);
    assert.equal(internals.db, undefined);
    assert.equal(internals.runtime, undefined);
    assert.equal(internals.owner, undefined);
    await f.service.stop();
    assert.equal(runtimeStops, 1);
  } finally {
    // Remove the SQLite fault if the regression left the DB open for cleanup.
    if (internals.db?.isOpen)
      db.exec("DROP TRIGGER ui01_stop_invalidation_fault");
    await f.close();
  }
});

test("curated native form receipt retains unconfirmed Inbox attention and same-key replay has one native effect", async () => {
  const f = await fixture();
  try {
    f.runtime.confirm = false;
    const api = new OperatorApi(f.service, [f.root]),
      q = runtimeQuestion(f.service, f.taskId);
    const selected = await api.readQuestion(f.taskId, q.interactionId);
    assert.equal(selected.data.source, "native");
    assert.equal(selected.data.form?.questions[0]?.label, "Place");
    const command = {
      type: "question.native.answer" as const,
      key: randomUUID(),
      taskId: f.taskId,
      interactionId: q.interactionId,
      expectedRevision: q.revision,
      answers: { q: { answers: ["Local"] } },
    };
    const receipt = await api.execute(command);
    assert.equal(receipt.kind, "native-question");
    assert.deepEqual(await api.execute(command), receipt);
    await until(() => f.runtime.replies === 1);
    assert.equal(f.runtime.turns, 1);
    assert.equal(
      f.service
        .coordinationView()
        .readTask(f.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      0,
    );
    const queue = await api.readInbox();
    assert.ok(
      queue.data.items.some(
        (item) =>
          item.id === q.interactionId && item.reason?.includes("unresolved"),
      ),
    );
    assert.equal(
      (await api.readQuestion(f.taskId, q.interactionId)).data.status,
      "recorded",
    );
  } finally {
    await f.close();
  }
});
