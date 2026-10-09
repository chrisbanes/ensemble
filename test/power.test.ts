import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { ExecutionState } from "../src/standalone/state.js";

interface PowerEventCursor {
  version: 1;
  value: string;
}

interface TestPowerEvent {
  cursor: PowerEventCursor;
  previousCursor: PowerEventCursor | null;
  transition: "sleep" | "wake";
}

interface PowerEventSource {
  readSince(cursor: PowerEventCursor | null): Promise<{
    complete: boolean;
    fromCursor: PowerEventCursor | null;
    cursor: PowerEventCursor | null;
    events: TestPowerEvent[];
  }>;
}

interface CaffeinateAssertionPort {
  on(event: string, listener: (reason: unknown) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ExecutionPowerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(): Promise<void>;
  executionStarted(workId: string): Promise<void>;
  executionEnded(workId: string): Promise<void>;
  admissionHeld(): boolean;
  observedForAdmission(now?: number): boolean;
  status(): { assertionFailure: string | null };
}

// These runtime imports deliberately fail against the pre-T6 baseline.
const powerModulePath: string = "../src/standalone/power.js";
const powerModule = await import(powerModulePath);
const CaffeinateAssertion = powerModule.CaffeinateAssertion as unknown as new (
  spawn: (command: string, args: string[]) => FakeChild,
) => CaffeinateAssertionPort;
const ExecutionPower = powerModule.ExecutionPower as unknown as new (
  state: ExecutionState,
  events: PowerEventSource,
  assertion: CaffeinateAssertionPort,
  reconcile: () => Promise<void>,
) => ExecutionPowerPort;
const parsePmsetPowerLog = powerModule.parsePmsetPowerLog as (
  output: string,
  cursor: PowerEventCursor | null,
) => Awaited<ReturnType<PowerEventSource["readSince"]>>;
type PowerLogReader = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxLineBytes: number },
) => AsyncIterable<string>;
const MacPowerEventSource = powerModule.MacPowerEventSource as unknown as new (
  readLog?: PowerLogReader,
  timeoutMs?: number,
  maxLineBytes?: number,
  now?: () => number,
) => PowerEventSource;
const spawnPowerLogReader = powerModule.spawnPowerLogReader as PowerLogReader;

class FakePowerEvents implements PowerEventSource {
  cursor: PowerEventCursor | null = null;
  complete = true;
  events: TestPowerEvent[] = [];
  stopCalls = 0;
  failStop = false;
  stopFailure: unknown;

  async readSince(cursor: PowerEventCursor | null) {
    const requested = cursor;
    const first = this.events.findIndex((event) =>
      sameCursor(event.previousCursor, requested),
    );
    return {
      complete: this.complete,
      fromCursor: requested,
      cursor: this.cursor,
      events: first < 0 ? [] : this.events.slice(first),
    };
  }

  async stop() {
    this.stopCalls++;
    if (this.failStop) throw this.stopFailure;
  }
}

function powerCursor(value: string): PowerEventCursor {
  return { version: 1, value };
}

function sameCursor(
  left: PowerEventCursor | null,
  right: PowerEventCursor | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.version === right.version &&
        left.value === right.value;
}

class FakeChild extends EventEmitter {
  killed = 0;

  constructor(private readonly automaticClose = true) {
    super();
  }

  kill() {
    this.killed++;
    if (this.automaticClose)
      queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

function powerStore(path: string) {
  const db = new DatabaseSync(path);
  new Store(db).ensureHost("standalone-codex");
  new DomainStore(db).migrate();
  return { db, state: new ExecutionState(db) };
}

function begin(state: ExecutionState, workId: string, workspace: string) {
  const intent = state.create(workId, `prompt:${workId}`, workspace);
  assert.equal(state.begin(intent.id), true);
  return intent;
}

function hasWriterOrCapacity(db: DatabaseSync, workId: string) {
  const writer = db
    .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
    .get(workId);
  const capacity = db
    .prepare("SELECT 1 FROM execution_capacity_reservations WHERE workId = ?")
    .get(workId);
  return writer !== undefined || capacity !== undefined;
}

function waitUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error("condition timed out"));
      else setTimeout(check, 0);
    };
    check();
  });
}

test("caffeinate holds exactly one idle-sleep assertion only while execution is active", async () => {
  const children: FakeChild[] = [];
  const invocations: Array<{ command: string; args: string[] }> = [];
  const assertion = new CaffeinateAssertion(
    (command: string, args: string[]) => {
      invocations.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  );
  const events = new FakePowerEvents();
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    assert.equal(
      invocations.length,
      0,
      "idle supervision must not prevent sleep",
    );
    await power.executionStarted("work-a");
    await power.executionStarted("work-b");
    assert.deepEqual(invocations, [
      {
        command: "/usr/bin/caffeinate",
        args: ["-i", "-w", String(process.pid)],
      },
    ]);
    await power.executionEnded("work-a");
    assert.equal(
      children[0]?.killed,
      0,
      "one remaining execution retains the assertion",
    );
    await power.executionEnded("work-b");
    assert.equal(
      children[0]?.killed,
      1,
      "last execution releases the assertion",
    );
    await power.executionStarted("work-c");
    assert.equal(invocations.length, 2);
    await power.stop();
    assert.equal(
      children[1]?.killed,
      1,
      "supervisor shutdown releases its assertion",
    );
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission observation needs a completed poll started after the last execution ended", async () => {
  let clock = 1_000_000;
  const clockMock = mock.method(Date, "now", () => clock);
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-observed-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const events = new FakePowerEvents();
  events.cursor = powerCursor("baseline");
  const assertion: CaffeinateAssertionPort = {
    on() {
      return this;
    },
    async start() {},
    async stop() {},
  };
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    assert.equal(power.observedForAdmission(), false, "no completed poll");
    await power.poll();
    assert.equal(power.observedForAdmission(), true);

    await power.executionStarted("work-a");
    clock += 1;
    await power.executionEnded("work-a");
    assert.equal(power.observedForAdmission(), false, "stale after end");
    await power.poll();
    assert.equal(
      power.observedForAdmission(),
      false,
      "a poll starting in the same millisecond is not after the end",
    );

    // A poll already in flight when the execution ends does not count.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const readSince = events.readSince.bind(events);
    events.readSince = async (cursor) => {
      await readGate;
      return readSince(cursor);
    };
    clock += 1;
    const inFlight = power.poll();
    clock += 1;
    await power.executionStarted("work-b");
    await power.executionEnded("work-b");
    releaseRead();
    await inFlight;
    assert.equal(power.observedForAdmission(), false, "poll began before end");

    clock += 1;
    await power.poll();
    const startedAt = clock;
    assert.equal(power.observedForAdmission(), true, "later poll is fresh");
    assert.equal(power.observedForAdmission(startedAt + 14_999), true);
    assert.equal(power.observedForAdmission(startedAt + 15_000), false);
    assert.equal(
      power.observedForAdmission(startedAt - 1),
      false,
      "a wall clock that moved backwards is stale",
    );

    // A poll that throws does not refresh the observation.
    clock += 20_000;
    const admissionState = state.powerAdmissionState.bind(state);
    state.powerAdmissionState = () => {
      throw new Error("injected power-state failure");
    };
    await assert.rejects(power.poll(), /injected power-state failure/);
    state.powerAdmissionState = admissionState;
    assert.equal(power.observedForAdmission(), false, "failed poll is stale");
  } finally {
    clockMock.mock.restore();
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertion child failure is visible without releasing execution state", async () => {
  const children: FakeChild[] = [];
  const assertion = new CaffeinateAssertion(
    (command: string, args: string[]) => {
      assert.equal(command, "/usr/bin/caffeinate");
      assert.deepEqual(args, ["-i", "-w", String(process.pid)]);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  );
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-failure-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(
    state,
    new FakePowerEvents(),
    assertion,
    async () => {},
  );
  try {
    const active = begin(
      state,
      "active-before-assertion-failure",
      "/workspace/a",
    );
    assert.equal(state.bindThread(active.id, "thread-a"), true);
    assert.equal(state.bindTurn(active.id, "turn-a"), true);
    await power.start();
    await power.executionStarted(active.workId);
    children[0]?.emit("close", 1, null);
    await waitUntil(() => power.status().assertionFailure !== null);
    assert.match(power.status().assertionFailure ?? "", /caffeinate.*exited/i);
    assert.equal(hasWriterOrCapacity(db, active.workId), true);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("power stop attempts event-source cleanup after assertion failure and preserves holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-stop-assertion-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const active = begin(state, "active-at-power-stop", "/workspace/a");
  assert.equal(state.bindThread(active.id, "thread-a"), true);
  assert.equal(state.bindTurn(active.id, "turn-a"), true);
  state.holdPowerAdmission("Injected power-admission hold");
  const events = new FakePowerEvents();
  const assertionFailure = new Error("injected assertion stop failure");
  let assertionStops = 0;
  const assertion: CaffeinateAssertionPort = {
    on() {
      return this;
    },
    async start() {},
    async stop() {
      assertionStops++;
      throw assertionFailure;
    },
  };
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    await power.executionStarted(active.workId);
    const result = await power.stop().then(
      () => ({ rejected: false as const, error: undefined }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    assert.equal(result.rejected, true);
    assert.equal(result.error, assertionFailure);
    assert.equal(assertionStops, 1);
    assert.equal(events.stopCalls, 1);
    assert.equal(state.get(active.id).state, "running");
    assert.equal(state.powerAdmissionState().held, true);

    db.close();
    const reopened = new DatabaseSync(path);
    try {
      const persisted = new ExecutionState(reopened);
      assert.equal(persisted.get(active.id).state, "running");
      assert.equal(persisted.powerAdmissionState().held, true);
    } finally {
      reopened.close();
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("power stop reports assertion and event-source failures in shutdown order", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-stop-both-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const queued = state.create("queued-at-power-stop", "prompt", "/workspace/a");
  state.holdPowerAdmission("Injected power-admission hold");
  const events = new FakePowerEvents();
  const assertionFailure = new Error("injected assertion stop failure");
  const eventSourceFailure = new Error("injected event-source stop failure");
  events.failStop = true;
  events.stopFailure = eventSourceFailure;
  const power = new ExecutionPower(
    state,
    events,
    {
      on() {
        return this;
      },
      async start() {},
      async stop() {
        throw assertionFailure;
      },
    },
    async () => {},
  );
  try {
    await power.start();
    const result = await power.stop().then(
      () => ({ rejected: false as const, error: undefined }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    assert.equal(result.rejected, true);
    assert.ok(result.error instanceof AggregateError);
    assert.deepEqual(result.error.errors, [
      assertionFailure,
      eventSourceFailure,
    ]);
    assert.match(result.error.message, /assertion stop/);
    assert.match(result.error.message, /power event source stop/);
    assert.equal(events.stopCalls, 1);
    assert.equal(state.get(queued.id).state, "ready");
    assert.equal(state.powerAdmissionState().held, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new execution racing final assertion release reacquires before its first turn", async () => {
  const children: FakeChild[] = [];
  const invocations: string[] = [];
  const assertion = new CaffeinateAssertion((command: string) => {
    invocations.push(command);
    const child = new FakeChild(false);
    children.push(child);
    return child;
  });
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-race-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(
    state,
    new FakePowerEvents(),
    assertion,
    async () => {},
  );
  try {
    await power.start();
    await power.executionStarted("work-before-idle");
    const ending = power.executionEnded("work-before-idle");
    await waitUntil(() => children[0]?.killed === 1);
    const starting = power.executionStarted("work-after-idle");
    children[0]?.emit("close", 0, "SIGTERM");
    await Promise.all([ending, starting]);
    assert.deepEqual(invocations, [
      "/usr/bin/caffeinate",
      "/usr/bin/caffeinate",
    ]);
    assert.equal(
      children.length,
      2,
      "the newly active turn needs its own live assertion",
    );
  } finally {
    const stopping = power.stop();
    children[1]?.emit("close", 0, "SIGTERM");
    await stopping;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sleep/wake installs the durable admission gate before reconciling active generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-wake-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const active = state.create(
    "active-before-wake",
    "prompt:active-before-wake",
    "/workspace/active",
  );
  assert.equal(
    state.begin(active.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  assert.equal(state.bindThread(active.id, "thread-active"), true);
  assert.equal(state.bindTurn(active.id, "turn-active"), true);
  const queued = state.create(
    "queued-during-wake",
    "queued",
    "/workspace/queued",
  );
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-2");
  events.events = [
    {
      cursor: powerCursor("sleep-1"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("wake-2"),
      previousCursor: powerCursor("sleep-1"),
      transition: "wake",
    },
  ];
  let reconciliations = 0;
  let releaseReconciliation!: () => void;
  const reconciliation = new Promise<void>(
    (resolve) => (releaseReconciliation = resolve),
  );
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      reconciliations++;
      assert.equal(
        power.admissionHeld(),
        true,
        "persist wake gate before T4 reconciliation starts",
      );
      state.recordRecoveryObservation(active.workId, "no-proof");
      await reconciliation;
    },
  );
  try {
    await power.start();
    const polling = power.poll();
    await waitUntil(() => reconciliations > 0);
    assert.equal(
      state.begin(queued.id),
      false,
      "new turn cannot enter admission during wake reconciliation",
    );
    assert.equal(state.get(queued.id).state, "capacity-waiting");
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
    assert.equal(
      hasWriterOrCapacity(db, active.workId),
      true,
      "wake never releases admitted ownership",
    );
    releaseReconciliation();
    await polling;
    assert.equal(power.admissionHeld(), false);
    assert.equal(
      state.begin(queued.id),
      true,
      "reconciled wake permits current admission checks to resume",
    );
    await power.poll();
    assert.equal(
      reconciliations,
      1,
      "duplicate wake reads do not reconcile or dispatch twice",
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        )
        .get(queued.workId)?.count,
      1,
    );
  } finally {
    releaseReconciliation();
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an incomplete or ambiguous power-event cursor persists a global hold across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-cursor-"));
  const path = join(root, "power.sqlite");
  const opened = powerStore(path);
  const events = new FakePowerEvents();
  events.complete = false;
  const power = new ExecutionPower(
    opened.state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(power.admissionHeld(), true);
    await power.stop();
    opened.db.close();
    const reopened = powerStore(path);
    try {
      const queued = reopened.state.create(
        "after-incomplete-cursor",
        "queued",
        "/workspace/next",
      );
      assert.equal(reopened.state.begin(queued.id), false);
      assert.equal(hasWriterOrCapacity(reopened.db, queued.workId), false);
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated or out-of-order power cursor holds admission instead of guessing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-ambiguous-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("duplicate-2");
  events.events = [
    {
      cursor: powerCursor("duplicate-2"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("duplicate-2"),
      previousCursor: powerCursor("duplicate-2"),
      transition: "wake",
    },
  ];
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(power.admissionHeld(), true);
    const queued = state.create(
      "after-ambiguous-cursor",
      "queued",
      "/workspace/next",
    );
    assert.equal(state.begin(queued.id), false);
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wake cursor survives restart and an already reconciled wake is not replayed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-restart-"));
  const path = join(root, "power.sqlite");
  const opened = powerStore(path);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-2");
  events.events = [
    {
      cursor: powerCursor("sleep-1"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("wake-2"),
      previousCursor: powerCursor("sleep-1"),
      transition: "wake",
    },
  ];
  let reconciliations = 0;
  const power = new ExecutionPower(
    opened.state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      reconciliations++;
    },
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(reconciliations, 1);
    await power.stop();
    opened.db.close();
    const reopened = powerStore(path);
    const afterRestart = new ExecutionPower(
      reopened.state,
      events,
      new CaffeinateAssertion(() => new FakeChild()),
      async () => {
        reconciliations++;
      },
    );
    try {
      await afterRestart.start();
      await afterRestart.poll();
      assert.equal(
        reconciliations,
        1,
        "durable cursor suppresses duplicate wake reconciliation",
      );
      const queued = reopened.state.create(
        "dispatch-after-restart",
        "queued",
        "/workspace/restarted",
      );
      assert.equal(reopened.state.begin(queued.id), true);
    } finally {
      await afterRestart.stop();
      reopened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wake admission stays held until every admitted generation is reconciled", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-power-pending-reconciliation-"),
  );
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const active = state.create(
    "active-needs-reconciliation",
    "prompt:active-needs-reconciliation",
    "/workspace/active",
  );
  assert.equal(
    state.begin(active.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  assert.equal(state.bindThread(active.id, "thread-active"), true);
  assert.equal(state.bindTurn(active.id, "turn-active"), true);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-1");
  events.events = [
    { cursor: powerCursor("wake-1"), previousCursor: null, transition: "wake" },
  ];
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(
      power.admissionHeld(),
      true,
      "a callback without T4 observations cannot clear the gate",
    );
    const queued = state.create(
      "queued-behind-unreconciled-wake",
      "queued",
      "/workspace/next",
    );
    assert.equal(state.begin(queued.id), false);
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete cursor can establish an idle baseline but not bypass active recovery", async () => {
  const idleRoot = mkdtempSync(join(tmpdir(), "ensemble-power-idle-baseline-"));
  const idle = powerStore(join(idleRoot, "power.sqlite"));
  const idleEvents = new FakePowerEvents();
  idleEvents.cursor = powerCursor("baseline-1");
  const idlePower = new ExecutionPower(
    idle.state,
    idleEvents,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await idlePower.start();
    await idlePower.poll();
    assert.equal(idlePower.admissionHeld(), false);
  } finally {
    await idlePower.stop();
    idle.db.close();
    rmSync(idleRoot, { recursive: true, force: true });
  }

  const activeRoot = mkdtempSync(
    join(tmpdir(), "ensemble-power-active-baseline-"),
  );
  const active = powerStore(join(activeRoot, "power.sqlite"));
  const intent = active.state.create(
    "active-without-history",
    "prompt",
    "/workspace/active",
  );
  assert.equal(
    active.state.begin(intent.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  const activeEvents = new FakePowerEvents();
  activeEvents.cursor = powerCursor("baseline-1");
  const activePower = new ExecutionPower(
    active.state,
    activeEvents,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      active.state.recordRecoveryObservation(intent.workId, "no-proof");
    },
  );
  try {
    await activePower.start();
    await activePower.poll();
    assert.equal(
      activePower.admissionHeld(),
      true,
      "unknown pre-cursor history with active work must remain quarantined",
    );
  } finally {
    await activePower.stop();
    active.db.close();
    rmSync(activeRoot, { recursive: true, force: true });
  }
});

test("macOS pmset source accepts ordered sleep/wake rows and rejects gaps or ambiguous rows", async () => {
  const fixture = [
    "PM ASL data store: /var/log/powermanagement",
    "2026-09-29 09:50:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
    "2026-09-29 10:00:00 +0100 Sleep\tEntering Sleep state due to 'Clamshell Sleep'",
    "2026-09-29 10:05:00 +0100 Wake\tWake from Deep Idle due to EC.LidOpen",
    "2026-09-29 10:06:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
    "2026-09-29 10:07:00 +0100 : Showing all currently held IOKit power assertions",
    "Assertion status system-wide:",
    "   PreventSystemSleep             0",
    "Listed by owning process:",
    "Kernel Assertions: 0x0=NONE",
  ].join("\n");
  const readLog: PowerLogReader = async function* (command, args, options) {
    assert.equal(command, "/usr/bin/pmset");
    assert.deepEqual(args, ["-g", "log"]);
    assert.equal(options.timeoutMs, 2500);
    assert.equal(options.maxLineBytes, 4096);
    yield* fixture.split(/\r?\n/);
  };
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  const source = new MacPowerEventSource(readLog, 2500, 4096, () => baselineMs);
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  assert.deepEqual(baseline.cursor, powerCursor(`pmset-time:${baselineMs}`));
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.events.map((event) => event.transition),
    ["sleep", "wake"],
  );
  assert.deepEqual(batch.events[0]?.previousCursor, baseline.cursor);
  assert.deepEqual(batch.events[1]?.previousCursor, batch.events[0]?.cursor);
  assert.deepEqual(batch.cursor, batch.events[1]?.cursor);
  assert.equal(
    parsePmsetPowerLog(fixture, powerCursor("pmset-event:1:2:0123456789abcdef"))
      .complete,
    false,
  );

  const ambiguous = fixture.replace(
    "2026-09-29 10:06:00 +0100 Assertions",
    "2026-09-29 10:06:00 +0100 UnknownWakeSummary",
  );
  assert.equal(parsePmsetPowerLog(ambiguous, baseline.cursor).complete, false);
});

const pmsetRows = [
  "PM ASL data store: /var/log/powermanagement",
  "2026-09-29 09:50:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
  "2026-09-29 10:00:00 +0100 Sleep\tEntering Sleep state due to 'Clamshell Sleep'",
  "2026-09-29 10:05:00 +0100 Wake\tWake from Deep Idle due to EC.LidOpen",
  "2026-09-29 10:06:00 +0100 Sleep\tEntering Sleep state due to 'Idle Sleep'",
  "2026-09-29 10:07:00 +0100 Wake\tWake from Normal Sleep",
  "Assertion status system-wide:",
  "   PreventSystemSleep             0",
  "",
];

function printLines(lines: string[], eol: string): string[] {
  return ["-e", `process.stdout.write(${JSON.stringify(lines.join(eol))})`];
}

test("the default pmset reader streams lines so cursors match the whole-output parser, with CRLF or a trailing newline", async () => {
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  for (const eol of ["\n", "\r\n"]) {
    for (const text of [pmsetRows, [...pmsetRows, ""]]) {
      const reader: PowerLogReader = (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, printLines(text, eol), options);
      const source = new MacPowerEventSource(
        reader,
        10_000,
        65_536,
        () => baselineMs,
      );
      const baseline = await source.readSince(null);
      const batch = await source.readSince(baseline.cursor);
      const expected = parsePmsetPowerLog(text.join(eol), baseline.cursor);
      assert.equal(batch.complete, true);
      assert.deepEqual(batch, expected);
      assert.deepEqual(
        batch.events.map((event) => event.cursor.value.split(":")[2]),
        ["2", "3", "4", "5"],
      );
      const resumed = await source.readSince(batch.events[1]?.cursor ?? null);
      assert.deepEqual(
        resumed.events.map((event) => event.transition),
        ["sleep", "wake"],
      );
    }
  }
});

test("a multi-megabyte valid log streams to a complete batch without a total-size cap", async () => {
  const script = `const row="2026-09-29 09:50:00 +0100 Assertions\\tPID 10(app) Created PreventUserIdleSystemSleep";
let out="";for(let i=0;i<60000;i++){out+=row+"\\n";if(out.length>1e5){process.stdout.write(out);out=""}}
process.stdout.write(out+"2026-09-29 10:00:00 +0100 Sleep\\tx\\n");`;
  const reader: PowerLogReader = (_c, _a, options) =>
    spawnPowerLogReader(process.execPath, ["-e", script], options);
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  const source = new MacPowerEventSource(
    reader,
    20_000,
    65_536,
    () => baselineMs,
  );
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.events.map((event) => event.transition),
    ["sleep"],
  );
});

test("an over-long line, a timeout, a failing exit or a reader error make the batch incomplete and stop the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-power-reader-"));
  try {
    const pidFile = join(dir, "pid");
    const hang = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write("2026-09-29 10:00:00 +0100 Sleep\\n");setInterval(()=>{},1000)`;
    const flood = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write("x".repeat(70*1024));setInterval(()=>{},1000)`;
    const cases: Array<[string, string[], number]> = [
      ["timeout", ["-e", hang], 1000],
      ["70 KiB line", ["-e", flood], 10_000],
      ["non-zero exit", ["-e", "process.exit(3)"], 10_000],
    ];
    for (const [label, args, timeoutMs] of cases) {
      const reader: PowerLogReader = (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, args, { ...options, timeoutMs });
      const source = new MacPowerEventSource(
        reader,
        timeoutMs,
        64 * 1024,
        () => 0,
      );
      const batch = await source.readSince(null);
      assert.equal(batch.complete, false, label);
      if (label === "non-zero exit") continue;
      const pid = Number(readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.throws(
        () => process.kill(pid, 0),
        /ESRCH/,
        `${label}: child stopped`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failing: PowerLogReader = async function* () {
    yield "2026-09-29 10:00:00 +0100 Sleep";
    throw new Error("injected reader failure");
  };
  const batch = await new MacPowerEventSource(failing).readSince(null);
  assert.equal(batch.complete, false);
});

test("the pmset source defaults to a 10 second timeout and 64 KiB lines", async () => {
  let seen: { timeoutMs: number; maxLineBytes: number } | undefined;
  const reader: PowerLogReader = async function* (_c, _a, options) {
    seen = options;
    yield* pmsetRows;
  };
  await new MacPowerEventSource(reader).readSince(null);
  assert.deepEqual(seen, { timeoutMs: 10_000, maxLineBytes: 64 * 1024 });
});
