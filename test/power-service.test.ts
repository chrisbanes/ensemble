import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { mock, test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../src/standalone/codex.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RuntimeProcessIdentity,
} from "../src/standalone/recovery-types.js";
import { CaffeinateAssertion } from "../src/standalone/power.js";
import type {
  PowerEventBatch,
  PowerEventSource,
} from "../src/standalone/power.js";
import type { PowerEventCursor } from "../src/standalone/state.js";

class FakeChild extends EventEmitter {
  killed = 0;

  kill() {
    this.killed++;
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

function cursor(value: string): PowerEventCursor {
  return { version: 1, value };
}

class FakePowerEvents implements PowerEventSource {
  private current = cursor("baseline");
  private events: PowerEventBatch["events"] = [];
  readGate: Promise<void> | undefined;
  failAdvancement = false;
  reads = 0;

  wake() {
    const next = cursor("wake-1");
    this.events = [
      { cursor: next, previousCursor: this.current, transition: "wake" },
    ];
    this.current = next;
  }

  async readSince(
    requested: PowerEventCursor | null,
  ): Promise<PowerEventBatch> {
    this.reads++;
    await this.readGate;
    if (this.failAdvancement && requested?.value === "wake-1")
      return {
        complete: false,
        fromCursor: requested,
        cursor: requested,
        events: [],
      };
    if (requested === null)
      return {
        complete: true,
        fromCursor: null,
        cursor: this.current,
        events: [],
      };
    const index = this.events.findIndex(
      (event) =>
        event.previousCursor?.version === requested.version &&
        event.previousCursor.value === requested.value,
    );
    return {
      complete: true,
      fromCursor: requested,
      cursor: this.current,
      events: index < 0 ? [] : this.events.slice(index),
    };
  }
}

class FailingStopPowerEvents extends FakePowerEvents {
  async stop() {
    throw new Error("injected power-source shutdown failure");
  }
}

class FakeRuntime implements Runtime {
  starts = 0;
  turns = 0;
  inspectionStarted: (() => void) | undefined;
  inspectionGate: Promise<void> | undefined;
  firstTurnEntered: (() => void) | undefined;
  firstTurnGate: Promise<void> | undefined;
  identityEntered: (() => void) | undefined;
  identityGate: Promise<void> | undefined;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}
  async stop() {}
  async startThread() {
    return `thread-${++this.starts}`;
  }
  async resumeThread() {}
  async startTurn() {
    return `turn-${++this.turns}`;
  }
  async interruptTurn() {}
  onUnexpectedRequest() {}
  processIdentity(): RuntimeProcessIdentity | Promise<RuntimeProcessIdentity> {
    const identity = {
      processId: "fake-pid",
      processStartedAt: "fake-start",
      bootId: "fake-boot",
    };
    const gate = this.identityGate;
    if (!gate) return identity;
    this.identityEntered?.();
    return gate.then(() => identity);
  }
  async waitForTurn(threadId: string, turnId: string) {
    await this.toolCall?.({
      threadId,
      turnId,
      callId: `fixture-question-${threadId}-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: { question: "Power fixture is waiting for the next step" },
    });
    if (this.turns === 1) {
      this.firstTurnEntered?.();
      await this.firstTurnGate;
    }
    return "completed" as const;
  }
  async inspectExecution(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    this.inspectionStarted?.();
    await this.inspectionGate;
    return { kind: "exact-live", identity };
  }
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("standalone service quarantines wake during T4 reconciliation and resumes queued work after the gate clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-service-"));
  const data = join(root, "data");
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  mkdirSync(firstWorkspace);
  mkdirSync(secondWorkspace);
  const runtime = new FakeRuntime();
  const firstTurn = deferred();
  const inspection = deferred();
  runtime.firstTurnGate = firstTurn.promise;
  runtime.inspectionGate = inspection.promise;
  const inspectionEntered = deferred();
  runtime.inspectionStarted = inspectionEntered.resolve;
  const events = new FakePowerEvents();
  const children: FakeChild[] = [];
  const service = new StandaloneService(data, () => runtime, undefined, {
    power: {
      eventSource: events,
      pollIntervalMs: 10,
      assertion: new CaffeinateAssertion((() => {
        const child = new FakeChild();
        children.push(child);
        return child;
      }) as never),
    },
  });
  try {
    await service.start();
    assert.equal(service.powerStatus()?.admissionHeld, false);
    const firstSubmission = service.submit(
      "first",
      "first prompt",
      firstWorkspace,
    );
    await waitUntil(() => runtime.turns === 1);
    await waitUntil(() => children.length === 1);

    events.wake();
    await inspectionEntered.promise;
    await waitUntil(() => service.powerStatus()?.admissionHeld === true);
    const queued = await service.submit(
      "second",
      "second prompt",
      secondWorkspace,
    );
    assert.equal(queued.state, "capacity-waiting");
    assert.equal(
      runtime.starts,
      1,
      "no new runtime starts while wake reconciliation is unresolved",
    );
    assert.equal(service.powerStatus()?.admissionHeld, true);

    inspection.resolve();
    await waitUntil(() => service.powerStatus()?.admissionHeld === false);
    await waitUntil(() => runtime.starts === 2);
    firstTurn.resolve();
    await firstSubmission;
    await waitUntil(() => children[0]?.killed === 1);
    assert.equal(service.powerStatus()?.admissionHeld, false);
  } finally {
    firstTurn.resolve();
    inspection.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("power-source shutdown failure does not retain the service database owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-cleanup-"));
  const data = join(root, "data");
  const events = new FailingStopPowerEvents();
  const service = new StandaloneService(
    data,
    () => new FakeRuntime(),
    undefined,
    {
      power: { enabled: true, eventSource: events, pollIntervalMs: 60_000 },
    },
  );
  try {
    await service.start();
    await assert.rejects(
      service.stop(),
      /injected power-source shutdown failure/,
    );
    const next = new StandaloneService(
      data,
      () => new FakeRuntime(),
      undefined,
      {
        power: { enabled: false },
      },
    );
    await next.start();
    await next.stop();
  } finally {
    const internals = service as unknown as { power: unknown };
    internals.power = undefined;
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("power polling defaults to a 60 second interval", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-default-interval-"));
  const delays: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const spy = mock.method(globalThis, "setInterval", ((
    ...args: Parameters<typeof setInterval>
  ) => {
    delays.push(args[1]);
    return realSetInterval(...args);
  }) as typeof setInterval);
  const service = new StandaloneService(
    join(root, "data"),
    () => new FakeRuntime(),
    undefined,
    { power: { enabled: true, eventSource: new FakePowerEvents() } },
  );
  try {
    await service.start();
    assert.ok(delays.includes(60_000), `intervals: ${delays.join(",")}`);
    assert.ok(!delays.includes(5000));
  } finally {
    spy.mock.restore();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function postTurnPowerFixture(
  run: (fixture: {
    service: StandaloneService;
    runtime: FakeRuntime;
    events: FakePowerEvents;
    secondWorkspace: string;
    queued: () => { state: string; reason: string | null };
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-post-turn-"));
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  mkdirSync(firstWorkspace);
  mkdirSync(secondWorkspace);
  const runtime = new FakeRuntime();
  const events = new FakePowerEvents();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: {
        eventSource: events,
        // No timer poll during the test: only the admission gate may poll.
        pollIntervalMs: 60_000,
        assertion: new CaffeinateAssertion((() => new FakeChild()) as never),
      },
    },
  );
  const store = () =>
    (
      service as unknown as {
        schedulerStore: {
          byWorkId(workId: string): { state: string; reason: string | null };
        };
      }
    ).schedulerStore;
  try {
    await service.start();
    await service.submit("first", "first prompt", firstWorkspace);
    assert.equal(runtime.starts, 1);
    await run({
      service,
      runtime,
      events,
      secondWorkspace,
      queued: () => store().byWorkId("second"),
    });
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test("queued work after a turn waits for a power poll that started after the turn ended", async () => {
  await postTurnPowerFixture(
    async ({ service, runtime, events, secondWorkspace, queued }) => {
      const read = deferred();
      events.readGate = read.promise;
      const readsBefore = events.reads;
      const second = await service.submit(
        "second",
        "second prompt",
        secondWorkspace,
      );
      assert.equal(second.state, "ready");
      assert.equal(runtime.starts, 1, "not admitted before the power poll");
      assert.deepEqual(queued(), {
        ...queued(),
        state: "queued",
        reason: "Waiting for power-event observation",
      });
      await waitUntil(() => events.reads > readsBefore);
      assert.equal(runtime.starts, 1, "not admitted while the poll is running");

      read.resolve();
      await waitUntil(() => runtime.starts === 2);
      assert.equal(service.powerStatus()?.admissionHeld, false);
    },
  );
});

test("a sleep/wake seen by the post-turn power poll holds queued work", async () => {
  await postTurnPowerFixture(
    async ({ service, runtime, events, secondWorkspace }) => {
      events.wake();
      events.failAdvancement = true;
      await service.submit("second", "second prompt", secondWorkspace);
      await waitUntil(() => service.powerStatus()?.admissionHeld === true);
      await waitUntil(
        () =>
          service.powerStatus()?.admissionReason ===
          "Power-event advancement is incomplete or ambiguous",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(runtime.starts, 1, "transition holds new admission");
    },
  );
});

test("a post-turn power poll that resumes admission does not deadlock the scheduler", async () => {
  await postTurnPowerFixture(
    async ({ service, runtime, events, secondWorkspace }) => {
      events.wake();
      const read = deferred();
      events.readGate = read.promise;
      await service.submit("second", "second prompt", secondWorkspace);
      assert.equal(runtime.starts, 1);
      read.resolve();
      // Reconciliation clears the hold and admissionResumed wakes the scheduler.
      await waitUntil(() => runtime.starts === 2);
      assert.equal(service.powerStatus()?.admissionHeld, false);
    },
  );
});

test("a turn ending while admission awaits still requires a later power poll", async () => {
  await postTurnPowerFixture(
    async ({ service, runtime, events, secondWorkspace, queued }) => {
      const power = (
        service as unknown as {
          power: {
            poll(): Promise<void>;
            executionEnded(workId: string): Promise<void>;
          };
        }
      ).power;
      // Make the observation fresh so only the mid-admission end can stale it.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      await power.poll();
      const identity = deferred();
      const identityEntered = deferred();
      runtime.identityGate = identity.promise;
      runtime.identityEntered = identityEntered.resolve;
      const submitted = service.submit(
        "second",
        "second prompt",
        secondWorkspace,
      );
      await identityEntered.promise;
      runtime.identityGate = undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      await power.executionEnded("other-turn");
      const read = deferred();
      events.readGate = read.promise;
      const readsBefore = events.reads;
      identity.resolve();
      const second = await submitted;
      assert.equal(second.state, "ready");
      assert.equal(runtime.starts, 1, "not admitted after a mid-admission end");
      assert.equal(queued().state, "queued");
      assert.equal(queued().reason, "Waiting for power-event observation");
      await waitUntil(() => events.reads > readsBefore);
      assert.equal(runtime.starts, 1, "not admitted while the poll is running");

      read.resolve();
      await waitUntil(() => runtime.starts === 2);
    },
  );
});
