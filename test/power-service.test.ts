import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  processIdentity(): RuntimeProcessIdentity {
    return {
      processId: "fake-pid",
      processStartedAt: "fake-start",
      bootId: "fake-boot",
    };
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
