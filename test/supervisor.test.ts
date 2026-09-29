import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import type { Runtime, UnexpectedRequest } from "../src/standalone/codex.js";

interface StopOutcome {
  workId: string;
  threadId: string | null;
  turnId: string | null;
  interrupt: "acknowledged" | "failed" | "unbound";
  terminal: "observed" | "unknown";
  reason?: string;
}

interface StopObservation {
  taskId: string;
  observationMs: number;
  outcomes: StopOutcome[];
}

interface SupervisorClock {
  monotonicNow(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

interface ServiceOptions {
  supervisor?: { clock: SupervisorClock; observationMs: number };
}

class ManualClock implements SupervisorClock {
  private now = 0;
  private sleeper:
    | { deadline: number; resolve(): void; reject(error: Error): void }
    | undefined;

  monotonicNow() {
    return this.now;
  }

  get sleeping() {
    return this.sleeper !== undefined;
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const sleeper = { deadline: this.now + milliseconds, resolve, reject };
      this.sleeper = sleeper;
      signal.addEventListener(
        "abort",
        () => {
          if (this.sleeper === sleeper) this.sleeper = undefined;
          reject(new Error("Observation cancelled"));
        },
        { once: true },
      );
    });
  }

  advance(milliseconds: number) {
    this.now += milliseconds;
    const sleeper = this.sleeper;
    if (sleeper && this.now >= sleeper.deadline) {
      this.sleeper = undefined;
      sleeper.resolve();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

class SupervisorRuntime implements Runtime {
  threads = 0;
  turns = 0;
  prompts: string[] = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  interruptError: Error | undefined;
  startThreadGate: Promise<string> | undefined;
  startTurnGate: Promise<string> | undefined;
  turnGate: Promise<void> | undefined;
  turnEntered: (() => void) | undefined;
  threadStartEntered: (() => void) | undefined;
  turnStartEntered: (() => void) | undefined;
  beforeInterrupt: (() => void) | undefined;
  terminal: "completed" | "failed" = "completed";
  private anomaly?: (event: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;

  async start() {}
  async stop() {}

  async startThread() {
    this.threadStartEntered?.();
    return this.startThreadGate ?? `thread-${++this.threads}`;
  }

  async resumeThread() {}

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    this.turnStartEntered?.();
    this.prompts.push(prompt);
    return this.startTurnGate ?? `turn-${++this.turns}`;
  }

  async waitForTurn() {
    this.turnEntered?.();
    await this.turnGate;
    return this.terminal;
  }

  async interruptTurn(threadId: string, turnId: string) {
    this.beforeInterrupt?.();
    if (this.interruptError) throw this.interruptError;
    this.interrupts.push({ threadId, turnId });
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

  reportAnomaly(event: { threadId?: string; turnId?: string; reason: string }) {
    this.anomaly?.(event);
  }
}

function createService(
  dataDir: string,
  runtime: SupervisorRuntime,
  options?: ServiceOptions,
) {
  const ServiceWithOptions = StandaloneService as unknown as new (
    dataDir: string,
    runtimeFactory: () => Runtime,
    markerWriter?: (path: string, flag: "wx" | "w") => void,
    options?: ServiceOptions,
  ) => StandaloneService;
  return new ServiceWithOptions(dataDir, () => runtime, undefined, options);
}

async function fixture(options?: ServiceOptions) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-supervisor-"));
  const runtime = new SupervisorRuntime();
  const service = createService(join(root, "data"), runtime, options);
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  await service.start();
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
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Initial work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute({
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  assert.equal(
    await waitUntil(
      () =>
        service
          .list()
          .find((item) => item.workId === `assignment:${assignmentId}:initial`)
          ?.state === "completed",
    ),
    true,
  );
  runtime.prompts = [];
  return {
    root,
    service,
    runtime,
    projectId,
    taskId,
    profileId,
    assignmentId,
    execute,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Stop during delayed turn/start records the late identity, interrupts once, and observes for three seconds", async () => {
  const clock = new ManualClock();
  const f = await fixture({
    supervisor: { clock, observationMs: 3000 },
  });
  const turnStart = deferred<string>();
  const turnStartEntered = deferred<void>();
  f.runtime.startTurnGate = turnStart.promise;
  f.runtime.turnStartEntered = turnStartEntered.resolve;
  try {
    const run = f.service.submitTask(
      "stopped-during-turn-start",
      f.assignmentId,
      "Write safely",
    );
    await turnStartEntered.promise;
    const stopping = f.service.stopTask(
      f.taskId,
    ) as unknown as Promise<StopObservation>;
    assert.equal(f.service.taskHold(f.taskId), "Task stopped");
    assert.equal(
      f.service
        .list()
        .find((item) => item.workId === "stopped-during-turn-start")?.state,
      "held",
    );
    assert.equal(await waitUntil(() => clock.sleeping), true);
    assert.deepEqual(f.runtime.interrupts, []);

    turnStart.resolve("turn-late");
    assert.equal(
      await waitUntil(() => f.runtime.interrupts.length === 1),
      true,
    );
    assert.deepEqual(f.runtime.interrupts, [
      { threadId: "thread-2", turnId: "turn-late" },
    ]);
    clock.advance(3000);
    const observation = await stopping;
    assert.deepEqual(observation, {
      taskId: f.taskId,
      observationMs: 3000,
      outcomes: [
        {
          workId: "stopped-during-turn-start",
          threadId: "thread-2",
          turnId: "turn-late",
          interrupt: "acknowledged",
          terminal: "unknown",
          reason: "No terminal status observed during the bounded window",
        },
      ],
    });
    assert.equal((await run).state, "held");
    assert.equal(
      f.service.capacityLimits([f.projectId]).currentUsage.global,
      1,
    );
  } finally {
    turnStart.resolve("turn-late");
    await f.close();
  }
});

test("Stop before capacity admission keeps queued work stopped until explicit resume", async () => {
  const f = await fixture();
  const activeGate = deferred<void>();
  const entered = deferred<void>();
  try {
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    f.runtime.turnGate = activeGate.promise;
    f.runtime.turnEntered = entered.resolve;
    const active = f.service.submitTask(
      "active-parent",
      f.assignmentId,
      "Parent",
    );
    await entered.promise;

    const stoppedTaskId = randomUUID();
    const stoppedAssignmentId = randomUUID();
    f.execute({
      type: "task.create",
      actor: "operator",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      title: "Stopped before admission",
      outcome: "Wait",
      ready: false,
    });
    await f.service.provisionTask(stoppedTaskId);
    f.execute({
      type: "assignment.create",
      actor: "agent",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      assignmentId: stoppedAssignmentId,
      profileId: f.profileId,
      brief: "Queued worker",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    f.execute({
      type: "task.configure",
      actor: "operator",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      expectedVersion: 1,
      ready: true,
    });
    const queuedWorkId = `assignment:${stoppedAssignmentId}:initial`;
    assert.equal(
      await waitUntil(
        () =>
          f.service.list().find((item) => item.workId === queuedWorkId)
            ?.state === "capacity-waiting",
      ),
      true,
    );
    const stopping = f.service.stopTask(
      stoppedTaskId,
    ) as unknown as Promise<StopObservation>;
    const observation = await stopping;
    assert.deepEqual(observation.outcomes, []);
    assert.equal(f.service.taskHold(stoppedTaskId), "Task stopped");

    activeGate.resolve();
    assert.equal((await active).state, "completed");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(f.runtime.prompts.includes("Queued worker"), false);
    assert.notEqual(
      f.service.list().find((item) => item.workId === queuedWorkId)?.state,
      "running",
    );

    await f.service.resumeTask(stoppedTaskId);
    assert.equal(
      await waitUntil(() => f.runtime.prompts.includes("Queued worker")),
      true,
    );
    assert.equal(
      f.runtime.prompts.filter((prompt) => prompt === "Queued worker").length,
      1,
    );
  } finally {
    activeGate.resolve();
    await f.close();
  }
});
