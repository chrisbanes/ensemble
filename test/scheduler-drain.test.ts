import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SchedulerStore,
  TurnScheduler,
  type TurnRequestInput,
} from "../src/standalone/scheduler.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rejectionOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function request(workId: string): TurnRequestInput {
  return {
    requestKey: `test:${workId}`,
    workId,
    kind: "direct",
    taskId: null,
    projectId: null,
    assignmentId: null,
    taskVersion: null,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: null,
    prompt: `Request ${workId}`,
    workspace: "/synthetic",
    previousWorkId: null,
  };
}

async function withStore(
  run: (db: DatabaseSync, store: SchedulerStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-scheduler-drain-"));
  const db = new DatabaseSync(join(directory, "standalone.sqlite"));
  try {
    await run(db, new SchedulerStore(db));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const observerFailure of ["records", "throws", "rejects"] as const) {
  test(`replacement drain failures are observed once and later wake recovers when observer ${observerFailure}`, async () => {
    await withStore(async (_db, store) => {
      store.ensure(request("first"));
      store.ensure(request("replacement"));
      const firstEntered = deferred();
      const firstGate = deferred();
      const replacementEntered = deferred();
      const replacementGate = deferred();
      const firstError = new Error("first drain failed");
      const replacementError = new Error("replacement drain failed");
      const observerError = new Error("observer failed");
      const attempts: string[] = [];
      const observed: unknown[] = [];
      const scheduler = new TurnScheduler(
        store,
        async ({ workId }) => {
          attempts.push(workId);
          if (workId === "first") {
            firstEntered.resolve();
            await firstGate.promise;
            store.hold(workId, "First attempt failed");
            throw firstError;
          }
          if (workId === "replacement") {
            replacementEntered.resolve();
            await replacementGate.promise;
            store.hold(workId, "Replacement attempt failed");
            throw replacementError;
          }
          store.hold(workId, "Recovered successfully");
        },
        undefined,
        (error: unknown) => {
          observed.push(error);
          if (observerFailure === "throws") throw observerError;
          if (observerFailure === "rejects")
            return Promise.reject(observerError);
        },
      );

      scheduler.start();
      const firstWake = rejectionOf(scheduler.wake());
      await firstEntered.promise;
      const overlappingWake = rejectionOf(scheduler.wake());
      firstGate.resolve();

      assert.deepEqual(await Promise.all([firstWake, overlappingWake]), [
        firstError,
        firstError,
      ]);
      await replacementEntered.promise;
      assert.deepEqual(attempts, ["first", "replacement"]);
      assert.deepEqual(observed, []);

      const replacementSettlement = rejectionOf(scheduler.settle());
      replacementGate.resolve();
      assert.strictEqual(await replacementSettlement, replacementError);
      assert.deepEqual(observed, [replacementError]);

      store.ensure(request("recovery"));
      await scheduler.wake();
      assert.deepEqual(attempts, ["first", "replacement", "recovery"]);
      assert.equal(store.byWorkId("recovery").state, "held");
      scheduler.stop();
    });
  });
}

test("stopping before a failed drain finishes suppresses its replacement", async () => {
  await withStore(async (_db, store) => {
    store.ensure(request("first"));
    store.ensure(request("successor"));
    const entered = deferred();
    const gate = deferred();
    const failure = new Error("stopped drain failed");
    const attempts: string[] = [];
    const observed: unknown[] = [];
    const scheduler = new TurnScheduler(
      store,
      async ({ workId }) => {
        attempts.push(workId);
        entered.resolve();
        await gate.promise;
        store.hold(workId, "Stopped before retry");
        throw failure;
      },
      Date.now,
      (error: unknown) => {
        observed.push(error);
      },
    );

    scheduler.start();
    const firstWake = rejectionOf(scheduler.wake());
    await entered.promise;
    const overlappingWake = rejectionOf(scheduler.wake());
    scheduler.stop();
    let settled = false;
    const settlement = rejectionOf(scheduler.settle()).then((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    gate.resolve();
    assert.deepEqual(await Promise.all([firstWake, overlappingWake]), [
      failure,
      failure,
    ]);
    assert.strictEqual(await settlement, failure);
    assert.deepEqual(attempts, ["first"]);
    assert.deepEqual(observed, []);
  });
});

test("stopping while a replacement is gated settles only after its rejection", async () => {
  await withStore(async (_db, store) => {
    store.ensure(request("first"));
    store.ensure(request("replacement"));
    const firstEntered = deferred();
    const firstGate = deferred();
    const replacementEntered = deferred();
    const replacementGate = deferred();
    const firstError = new Error("first drain failed");
    const replacementError = new Error("replacement drain failed");
    const attempts: string[] = [];
    const observed: unknown[] = [];
    const scheduler = new TurnScheduler(
      store,
      async ({ workId }) => {
        attempts.push(workId);
        if (workId === "first") {
          firstEntered.resolve();
          await firstGate.promise;
          store.hold(workId, "First attempt failed");
          throw firstError;
        }
        replacementEntered.resolve();
        await replacementGate.promise;
        store.hold(workId, "Replacement attempt failed");
        throw replacementError;
      },
      Date.now,
      (error: unknown) => {
        observed.push(error);
      },
    );

    scheduler.start();
    const firstWake = rejectionOf(scheduler.wake());
    await firstEntered.promise;
    const overlappingWake = rejectionOf(scheduler.wake());
    firstGate.resolve();
    assert.deepEqual(await Promise.all([firstWake, overlappingWake]), [
      firstError,
      firstError,
    ]);
    await replacementEntered.promise;

    scheduler.stop();
    let settled = false;
    const settlement = rejectionOf(scheduler.settle()).then((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    replacementGate.resolve();

    assert.strictEqual(await settlement, replacementError);
    assert.deepEqual(attempts, ["first", "replacement"]);
    assert.deepEqual(observed, [replacementError]);
  });
});

test("overlapping successful wakes stay serial and consume the pending request", async () => {
  await withStore(async (_db, store) => {
    store.ensure(request("first"));
    const entered = deferred();
    const gate = deferred();
    const attempts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = new TurnScheduler(store, async ({ workId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      attempts.push(workId);
      try {
        if (workId === "first") {
          entered.resolve();
          await gate.promise;
        }
        store.hold(workId, "Attempt completed");
      } finally {
        active -= 1;
      }
    });

    scheduler.start();
    const firstWake = scheduler.wake();
    await entered.promise;
    store.ensure(request("pending"));
    const overlappingWake = scheduler.wake();
    gate.resolve();
    await Promise.all([firstWake, overlappingWake]);

    assert.deepEqual(attempts, ["first", "pending"]);
    assert.equal(maxActive, 1);
    assert.equal(store.byWorkId("pending").state, "held");
    scheduler.stop();
  });
});

test("timer-triggered failure reaches the background observer once", async () => {
  await withStore(async (db, store) => {
    let now = 1_000;
    store.ensure(request("timer"));
    db.prepare(
      "UPDATE turn_requests SET nextEligibleAt = ? WHERE workId = ?",
    ).run(now + 40, "timer");
    const observedFailure = deferred();
    const failure = new Error("timer drain failed");
    const attempts: string[] = [];
    const observed: unknown[] = [];
    const scheduler = new TurnScheduler(
      store,
      async ({ workId }) => {
        attempts.push(workId);
        store.hold(workId, "Timer attempt failed");
        throw failure;
      },
      () => now,
      (error: unknown) => {
        observed.push(error);
        observedFailure.resolve();
      },
    );

    scheduler.start();
    await scheduler.wake();
    now += 40;
    const timeout = setTimeout(() => {
      observedFailure.reject(new Error("Timer failure was not observed"));
    }, 2_000);
    try {
      await observedFailure.promise;
    } finally {
      clearTimeout(timeout);
      scheduler.stop();
      await scheduler.settle();
    }

    assert.deepEqual(attempts, ["timer"]);
    assert.deepEqual(observed, [failure]);
  });
});
