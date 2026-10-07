import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import type { Runtime } from "../src/standalone/codex.js";
import type { GitHubSourceReader } from "../src/standalone/github-source.js";
import type { RuntimeProcessIdentity } from "../src/standalone/recovery-types.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorWebBundle } from "../src/standalone/operator-web.js";
import {
  TurnScheduler,
  type SchedulerStore,
} from "../src/standalone/scheduler.js";
import {
  StandaloneService,
  type BackgroundFailureDiagnostic,
  type StandaloneServiceOptions,
} from "../src/standalone/service.js";
import { main, waitForServiceExit } from "../src/standalone/cli.js";
import { tmpdir } from "./temp.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function rejectionReason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise rejection");
}

class FixtureRuntime implements Runtime {
  starts = 0;
  turns = 0;
  stopFailure: unknown;
  waitFailure: unknown;
  identity: (() => Promise<RuntimeProcessIdentity | null>) | undefined;
  onIdentity: (() => void) | undefined;
  waitGate: Promise<void> | undefined;
  onWait: (() => void) | undefined;
  async start() {}
  async stop() {
    if (this.stopFailure !== undefined) {
      const error = this.stopFailure;
      this.stopFailure = undefined;
      throw error;
    }
  }
  async startThread() {
    this.starts++;
    return "fixture-thread";
  }
  async resumeThread() {}
  async startTurn() {
    this.turns++;
    return `fixture-turn-${this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn() {
    this.onWait?.();
    await this.waitGate;
    if (this.waitFailure !== undefined) throw this.waitFailure;
    return "completed" as const;
  }
  onUnexpectedRequest() {}
  processIdentity() {
    this.onIdentity?.();
    return this.identity?.() ?? null;
  }
}

type IntervalCall = { callback: () => void; delay: number };

async function withCapturedIntervals<T>(
  run: (calls: IntervalCall[]) => Promise<T>,
): Promise<T> {
  const calls: IntervalCall[] = [];
  const setIntervalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "setInterval",
  );
  const clearIntervalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "clearInterval",
  );
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: ((callback: () => void, delay = 0) => {
      calls.push({ callback, delay });
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    value: (() => {}) as typeof clearInterval,
  });
  try {
    return await run(calls);
  } finally {
    if (setIntervalDescriptor)
      Object.defineProperty(globalThis, "setInterval", setIntervalDescriptor);
    if (clearIntervalDescriptor)
      Object.defineProperty(
        globalThis,
        "clearInterval",
        clearIntervalDescriptor,
      );
  }
}

function serviceAccess(service: StandaloneService) {
  return service as unknown as {
    generation?: unknown;
    backgroundRuns: Set<Promise<void>>;
    githubPollTimer?: NodeJS.Timeout;
    powerPollTimer?: NodeJS.Timeout;
    power?: { poll(): Promise<void> };
    scheduler?: TurnScheduler;
    schedulerStore?: SchedulerStore;
    db?: DatabaseSync;
    stopPromise?: Promise<void>;
    stopOwned(): Promise<void>;
    wakeScheduler(...args: unknown[]): Promise<void>;
    refreshGitHub(): Promise<void>;
    attemptRequest(...args: unknown[]): Promise<void>;
  };
}

function powerSource(complete = true) {
  return {
    async readSince(cursor: { version: 1; value: string } | null) {
      return {
        complete,
        fromCursor: cursor,
        cursor: cursor ?? { version: 1 as const, value: "fixture-baseline" },
        events: [],
      };
    },
    async stop() {},
  };
}

function makeService(
  data: string,
  runtime: FixtureRuntime,
  diagnostics: BackgroundFailureDiagnostic[],
  options: StandaloneServiceOptions = {},
): StandaloneService {
  return new StandaloneService(data, () => runtime, undefined, {
    ...options,
    backgroundDiagnosticSink:
      options.backgroundDiagnosticSink ??
      ((event) => {
        diagnostics.push(event);
      }),
  });
}

function assertSafeDiagnostic(
  diagnostic: BackgroundFailureDiagnostic,
  operation: BackgroundFailureDiagnostic["operation"],
): void {
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "errorCode",
    "incident",
    "operation",
    "serviceId",
  ]);
  assert.match(diagnostic.serviceId, /^[0-9a-f-]{36}$/);
  assert.equal(diagnostic.incident, 1);
  assert.equal(diagnostic.operation, operation);
  assert.equal(diagnostic.errorCode, "unexpected-background-failure");
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /private|secret|exception|stack/i,
  );
}

function fireInterval(calls: IntervalCall[], delay: number): void {
  const timer = calls.filter((call) => call.delay === delay).at(-1);
  assert.ok(timer, `service registered an interval at ${delay}ms`);
  timer.callback();
}

function configureGitHubSource(service: StandaloneService): {
  projectId: string;
  profileId: string;
} {
  const domain = service.domain();
  const profileId = randomUUID();
  const projectId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Fixture lead",
    instructions: "Fixture lead instructions",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Fixture project",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [
      {
        id: "fixture-repository",
        kind: "repository",
        repositoryId: "R_fixture",
        owner: "fixture",
        name: "repository",
      },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "fixture-repository",
    expectedVersion: 2,
  });
  return { projectId, profileId };
}

test("unattended GitHub polling failures close admission and emit one fixed diagnostic", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-github-"));
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const service = makeService(root, runtime, diagnostics, {
      github: { intervalMs: 1000 },
    });
    const failure = new Error("private token and /Users/person/workspace");
    try {
      await service.start();
      const access = serviceAccess(service);
      access.refreshGitHub = async () => {
        throw failure;
      };
      const notification = service.waitForBackgroundFailure();
      fireInterval(intervals, 1000);
      const diagnostic = await notification;
      assertSafeDiagnostic(diagnostic, "github-poll");
      await service.waitForBackgroundShutdown(notification);
      assert.equal(runtime.starts, 0);
      assert.equal(diagnostics.length, 1);
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("power polling failures are fatal while known incomplete power history remains held and nonfatal", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-power-"));
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const service = makeService(root, runtime, diagnostics, {
      power: {
        enabled: true,
        eventSource: powerSource(),
        pollIntervalMs: 5000,
      },
    });
    try {
      await service.start();
      const access = serviceAccess(service);
      assert.ok(access.power);
      access.power.poll = async () => {
        throw new Error("private power reader failure");
      };
      const notification = service.waitForBackgroundFailure();
      fireInterval(intervals, 5000);
      const diagnostic = await notification;
      assertSafeDiagnostic(diagnostic, "power-poll");
      await service.waitForBackgroundShutdown(notification);
      assert.equal(diagnostics.length, 1);
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }

    const heldRoot = mkdtempSync(join(tmpdir(), "ensemble-known-power-hold-"));
    const heldDiagnostics: BackgroundFailureDiagnostic[] = [];
    const heldService = makeService(
      heldRoot,
      new FixtureRuntime(),
      heldDiagnostics,
      {
        power: {
          enabled: true,
          eventSource: powerSource(false),
          pollIntervalMs: 5000,
        },
      },
    );
    try {
      await heldService.start();
      assert.equal(heldService.powerStatus()?.admissionHeld, true);
      fireInterval(intervals, 5000);
      await waitUntil(
        () => serviceAccess(heldService).backgroundRuns.size === 0,
      );
      assert.equal(heldService.powerStatus()?.admissionHeld, true);
      assert.equal(heldDiagnostics.length, 0);
    } finally {
      await heldService.stop().catch(() => {});
      rmSync(heldRoot, { recursive: true, force: true });
    }
  });
});

test("domain wake failures use the generation latch", async () => {
  await withCapturedIntervals(async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-domain-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const service = makeService(data, runtime, diagnostics, {
      github: { intervalMs: 1000 },
    });
    try {
      await service.start();
      const access = serviceAccess(service);
      access.wakeScheduler = async () => {
        throw new Error("domain wake secret");
      };
      const notification = service.waitForBackgroundFailure();
      service.domain().execute({
        type: "profile.create",
        actor: "operator",
        key: randomUUID(),
        profileId: randomUUID(),
        name: "Fixture",
        instructions: "Fixture instructions",
        capabilities: "work",
      });
      const diagnostic = await notification;
      assertSafeDiagnostic(diagnostic, "domain-wake");
      await service.waitForBackgroundShutdown(notification);
      assert.equal(runtime.starts, 0);
      assert.equal(diagnostics.length, 1);
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("admission closes across a gated process-identity await for queued and direct requests", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-admission-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const identity = deferred<RuntimeProcessIdentity | null>();
    const identityEntered = deferred<void>();
    runtime.identity = () => identity.promise;
    runtime.onIdentity = () => identityEntered.resolve();
    const service = makeService(data, runtime, diagnostics, {
      github: { intervalMs: 1000 },
    });
    try {
      await service.start();
      const access = serviceAccess(service);
      access.refreshGitHub = async () => {
        throw new Error("fatal during identity lookup");
      };
      const firstSubmission = service.submit("race-first", "first", workspace);
      await identityEntered.promise;
      const notification = service.waitForBackgroundFailure();
      fireInterval(intervals, 1000);
      assertSafeDiagnostic(await notification, "github-poll");
      const secondSubmission = service.submit(
        "race-second",
        "second",
        workspace,
      );
      identity.resolve(null);
      const [first, second] = await Promise.all([
        firstSubmission,
        secondSubmission,
      ]);
      await service.waitForBackgroundShutdown(notification);
      assert.notEqual(first.state, "running");
      assert.notEqual(second.state, "running");
      assert.equal(runtime.starts, 0);
      assert.equal(runtime.turns, 0);
      assert.equal(diagnostics.length, 1);
    } finally {
      identity.resolve(null);
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("post-turn wake failure is observed after the turn without self-deadlocking shutdown", async () => {
  await withCapturedIntervals(async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-post-turn-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const waitGate = deferred<void>();
    const waitEntered = deferred<void>();
    runtime.waitGate = waitGate.promise;
    runtime.onWait = () => waitEntered.resolve();
    const service = makeService(data, runtime, diagnostics);
    try {
      await service.start();
      const submitted = service.submit("work-one", "fixture prompt", workspace);
      await waitEntered.promise;
      serviceAccess(service).wakeScheduler = async () => {
        throw new Error("post-turn secret");
      };
      const notification = service.waitForBackgroundFailure();
      waitGate.resolve();
      assert.equal((await submitted).state, "completed");
      const diagnostic = await notification;
      assertSafeDiagnostic(diagnostic, "post-turn-wake");
      await service.waitForBackgroundShutdown(notification);
      assert.equal(runtime.turns, 1);
      assert.equal(diagnostics.length, 1);
    } finally {
      waitGate.resolve();
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("replacement scheduler drain failures use the production service observer once", async () => {
  await withCapturedIntervals(async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-scheduler-"));
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const service = makeService(root, runtime, diagnostics);
    try {
      await service.start();
      const access = serviceAccess(service);
      const store = access.schedulerStore!;
      store.ensure({
        requestKey: "fixture:first",
        workId: "fixture:first",
        kind: "direct",
        taskId: null,
        projectId: null,
        assignmentId: null,
        taskVersion: null,
        assignmentVersion: null,
        instructionsRevision: null,
        profileRevision: null,
        prompt: "first",
        workspace: "/synthetic",
        previousWorkId: null,
      });
      store.ensure({
        requestKey: "fixture:replacement",
        workId: "fixture:replacement",
        kind: "direct",
        taskId: null,
        projectId: null,
        assignmentId: null,
        taskVersion: null,
        assignmentVersion: null,
        instructionsRevision: null,
        profileRevision: null,
        prompt: "replacement",
        workspace: "/synthetic",
        previousWorkId: null,
      });
      const firstEntered = deferred<void>();
      const firstGate = deferred<void>();
      const replacementEntered = deferred<void>();
      const replacementGate = deferred<void>();
      let firstError: Error | undefined;
      const replacementError = new Error("replacement drain secret");
      access.attemptRequest = async (request: { workId: string }) => {
        if (request.workId === "fixture:first") {
          firstEntered.resolve();
          await firstGate.promise;
          store.hold(request.workId, "first attempt failed");
          firstError = new Error("direct drain error is caller-owned");
          throw firstError;
        }
        replacementEntered.resolve();
        await replacementGate.promise;
        store.hold(request.workId, "replacement attempt failed");
        throw replacementError;
      };
      const notification = service.waitForBackgroundFailure();
      const firstWake = access.scheduler!.wake().then(
        () => undefined,
        (error: unknown) => error,
      );
      await firstEntered.promise;
      const overlap = access.scheduler!.wake().then(
        () => undefined,
        (error: unknown) => error,
      );
      firstGate.resolve();
      await replacementEntered.promise;
      assert.equal(await firstWake, firstError);
      assert.equal(await overlap, firstError);
      replacementGate.resolve();
      const diagnostic = await notification;
      assertSafeDiagnostic(diagnostic, "scheduler-drain");
      await service.waitForBackgroundShutdown(notification);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostic.operation, "scheduler-drain");
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("GitHub reader failures remain durable incomplete-source evidence and direct refresh errors stay caller-owned", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-known-github-failure-"));
    const data = join(root, "data");
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const readerFactory = (_credentialRef: string): GitHubSourceReader => ({
      async readSelection() {
        throw new Error("private provider response body");
      },
      async readBlockers() {
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        return { status: "open" };
      },
    });
    const service = makeService(data, new FixtureRuntime(), diagnostics, {
      github: { intervalMs: 1000, readerFactory },
    });
    try {
      await service.start();
      const { projectId } = configureGitHubSource(service);
      await service.refreshGitHub();
      assert.equal(
        Number(
          service.githubSources().syncState(projectId, "fixture-repository")
            ?.complete,
        ),
        0,
      );
      fireInterval(intervals, 1000);
      await waitUntil(() => serviceAccess(service).backgroundRuns.size === 0);
      assert.equal(diagnostics.length, 0);
      const access = serviceAccess(service);
      access.refreshGitHub = async () => {
        throw new Error("direct caller owns this rejection");
      };
      await assert.rejects(
        service.refreshGitHub(),
        /direct caller owns this rejection/,
      );
      assert.equal(diagnostics.length, 0);
      const wake = access.wakeScheduler.bind(service);
      access.scheduler!.wake = async () => {
        throw new Error("direct wake caller owns this rejection");
      };
      await assert.rejects(wake(), /direct wake caller owns this rejection/);
      assert.equal(diagnostics.length, 0);
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("diagnostic sink throw, rejection, and hang use one bounded redacted stderr fallback", async () => {
  await withCapturedIntervals(async (intervals) => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      process.stderr,
      "write",
    );
    const fallbackWrites: string[] = [];
    Object.defineProperty(process.stderr, "write", {
      configurable: true,
      value: (chunk: string | Uint8Array) => {
        fallbackWrites.push(String(chunk));
        return true;
      },
    });
    const roots: string[] = [];
    try {
      for (const mode of ["throws", "rejects", "hangs"] as const) {
        const root = mkdtempSync(
          join(tmpdir(), `ensemble-diagnostic-${mode}-`),
        );
        roots.push(root);
        const diagnostics: BackgroundFailureDiagnostic[] = [];
        const service = makeService(root, new FixtureRuntime(), diagnostics, {
          github: { intervalMs: 1000 },
          backgroundDiagnosticSink: (event) => {
            diagnostics.push(event);
            if (mode === "throws") throw new Error("secret sink exception");
            if (mode === "rejects")
              return Promise.reject(new Error("secret sink rejection"));
            return new Promise<void>(() => {});
          },
        });
        try {
          await service.start();
          serviceAccess(service).refreshGitHub = async () => {
            throw new Error("private poll error");
          };
          const started = Date.now();
          const notification = service.waitForBackgroundFailure();
          fireInterval(intervals, 1000);
          await notification;
          await service.waitForBackgroundShutdown(notification);
          assert.ok(Date.now() - started < 1000);
          assert.equal(diagnostics.length, 1);
          assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
          const fallback = fallbackWrites.at(-1);
          assert.equal(fallback, '{"errorCode":"diagnostic-writer-failed"}\n');
        } finally {
          await service.stop().catch(() => {});
        }
      }
      assert.equal(fallbackWrites.length, 3);
    } finally {
      if (originalDescriptor)
        Object.defineProperty(process.stderr, "write", originalDescriptor);
      else delete (process.stderr as unknown as { write?: unknown }).write;
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a failed fatal shutdown retains the SQLite owner, records shutdown failure, and retries cleanup", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-stop-hold-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const service = makeService(data, runtime, diagnostics, {
      github: { intervalMs: 1000 },
    });
    let db: DatabaseSync | undefined;
    let originalClose: (() => void) | undefined;
    try {
      await service.start();
      runtime.waitFailure = new Error("uncertain execution detail");
      const held = await service.submit(
        "held-work",
        "fixture prompt",
        workspace,
      );
      assert.equal(held.state, "held");
      runtime.waitFailure = undefined;
      db = serviceAccess(service).db;
      assert.ok(db?.isOpen);
      originalClose = db.close.bind(db);
      const closeFailure = new Error("private database close detail");
      Object.defineProperty(db, "close", {
        configurable: true,
        value: () => {
          throw closeFailure;
        },
      });
      serviceAccess(service).refreshGitHub = async () => {
        throw new Error("background failure with private path");
      };
      const notification = service.waitForBackgroundFailure();
      fireInterval(intervals, 1000);
      const fatal = await notification;
      assertSafeDiagnostic(fatal, "github-poll");
      await assert.rejects(service.waitForBackgroundShutdown(notification));
      assert.equal(db.isOpen, true);
      assert.ok(
        diagnostics.some((event) => event.errorCode === "shutdown-failed"),
      );
      const blockedRestart = new StandaloneService(
        data,
        () => new FixtureRuntime(),
      );
      await assert.rejects(blockedRestart.start(), /already owned/i);

      Object.defineProperty(db, "close", {
        configurable: true,
        value: originalClose,
      });
      await service.stop();
      assert.equal(db.isOpen, false);
      const recovered = new StandaloneService(data, () => new FixtureRuntime());
      await recovered.start();
      assert.equal(
        recovered.list().find((intent) => intent.workId === "held-work")?.state,
        "held",
      );
      await recovered.stop();
    } finally {
      if (db?.isOpen && originalClose)
        Object.defineProperty(db, "close", {
          configurable: true,
          value: originalClose,
        });
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("repeated synthetic timer-clear failures keep a late callback fatal signal bounded and joinable", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-repeated-stop-failure-"),
    );
    const data = join(root, "data");
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    const poll = deferred<void>();
    const service = makeService(data, runtime, diagnostics, {
      github: { intervalMs: 1000 },
    });
    const priorExitCode = process.exitCode;
    const originalClearInterval = Object.getOwnPropertyDescriptor(
      globalThis,
      "clearInterval",
    );
    let clearAttempts = 0;
    let clearPatched = false;
    const restoreClearInterval = () => {
      if (!clearPatched) return;
      if (originalClearInterval)
        Object.defineProperty(
          globalThis,
          "clearInterval",
          originalClearInterval,
        );
      else
        delete (globalThis as unknown as { clearInterval?: unknown })
          .clearInterval;
      clearPatched = false;
    };
    try {
      await service.start();
      serviceAccess(service).refreshGitHub = () => poll.promise;
      const notification = service.waitForBackgroundFailure();
      fireInterval(intervals, 1000);
      await waitUntil(() => serviceAccess(service).backgroundRuns.size === 1);

      // A synthetic early timer-clear error lets the already-started poll
      // reject after multiple manual stop attempts. Normal stops coalesce and
      // join tracked background callbacks before returning.
      Object.defineProperty(globalThis, "clearInterval", {
        configurable: true,
        value: () => {
          const failures: unknown[] = [undefined, null, undefined];
          const reason = failures[clearAttempts++];
          throw reason;
        },
      });
      clearPatched = true;

      assert.equal(await rejectionReason(service.stop()), undefined);
      await service.waitForBackgroundShutdown();
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "safe-shutdown");
      assert.equal(diagnostics[0]?.errorCode, "shutdown-failed");
      assert.equal(diagnostics[0]?.incident, 1);

      assert.equal(await rejectionReason(service.stop()), null);
      await service.waitForBackgroundShutdown();
      assert.equal(diagnostics.length, 1);
      const blockedRestart = new StandaloneService(
        data,
        () => new FixtureRuntime(),
      );
      await assert.rejects(blockedRestart.start(), /already owned/i);

      poll.reject(new Error("late private poll failure"));
      const fatal = await notification;
      assert.deepEqual(Object.keys(fatal).sort(), [
        "errorCode",
        "incident",
        "operation",
        "serviceId",
      ]);
      assert.match(fatal.serviceId, /^[0-9a-f-]{36}$/);
      assert.equal(fatal.incident, 2);
      assert.equal(fatal.operation, "github-poll");
      assert.equal(fatal.errorCode, "unexpected-background-failure");

      // The third failed stop preserves its original undefined rejection;
      // joining the fatal generation must still finish and surface it.
      assert.equal(
        await rejectionReason(service.waitForBackgroundShutdown(notification)),
        undefined,
      );
      await waitUntil(() => serviceAccess(service).backgroundRuns.size === 0);
      assert.equal(diagnostics.length, 2);
      assert.equal(diagnostics[1]?.incident, 2);
      assert.equal(diagnostics[1]?.operation, "github-poll");
      assert.equal(diagnostics[1]?.errorCode, "unexpected-background-failure");
      assert.equal(JSON.stringify(diagnostics).includes("private"), false);
      assert.equal(runtime.starts, 0);

      restoreClearInterval();
      await service.stop();
      const recovered = new StandaloneService(data, () => new FixtureRuntime());
      await recovered.start();
      await recovered.stop();
    } finally {
      restoreClearInterval();
      poll.resolve();
      await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("serve-style signal wait succeeds normally and a fatal notification already latched remains visible", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-serve-"));
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const service = makeService(root, new FixtureRuntime(), diagnostics, {
      github: { intervalMs: 1000 },
    });
    try {
      process.exitCode = 0;
      await service.start();
      const firstNotification = service.waitForBackgroundFailure();
      const signalWait = waitForServiceExit(service, firstNotification);
      process.emit("SIGTERM");
      assert.equal(await signalWait, "signal");
      await service.stop();
      assert.equal(process.exitCode, 0);

      await service.start();
      serviceAccess(service).refreshGitHub = async () => {
        throw new Error("fatal before CLI wait attaches");
      };
      const oldGenerationNotification = service.waitForBackgroundFailure();
      fireInterval(intervals, 1000);
      await oldGenerationNotification;
      await service.waitForBackgroundShutdown(oldGenerationNotification);
      await service.start();
      assert.equal(
        service.backgroundFailureObserved(oldGenerationNotification),
        true,
      );
      const lateWait = await waitForServiceExit(
        service,
        oldGenerationNotification,
      );
      assert.equal(lateWait, "background-failure");
      assert.equal(process.exitCode, 1);
    } finally {
      await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a late timer callback from a stopped generation cannot affect a restarted service", async () => {
  await withCapturedIntervals(async (intervals) => {
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-old-callback-"),
    );
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const service = makeService(root, new FixtureRuntime(), diagnostics, {
      github: { intervalMs: 1000 },
    });
    try {
      await service.start();
      const oldCallback = intervals.find(
        (call) => call.delay === 1000,
      )?.callback;
      assert.ok(oldCallback);
      await service.stop();
      await service.start();
      let refreshes = 0;
      serviceAccess(service).refreshGitHub = async () => {
        refreshes++;
        throw new Error("old callback must not run");
      };
      oldCallback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(refreshes, 0);
      assert.equal(diagnostics.length, 0);
      assert.doesNotThrow(() => service.list());
    } finally {
      await service.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("run and list CLI branches remain bounded and keep their existing cleanup path", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-background-cli-bounded-"));
  const originalExitCode = process.exitCode;
  const prototype = StandaloneService.prototype;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const output: string[] = [];
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "write",
  );
  let starts = 0;
  let stops = 0;
  const notification = new Promise<BackgroundFailureDiagnostic>(() => {});
  const patch = (name: keyof StandaloneService, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(prototype, name));
    Object.defineProperty(prototype, name, {
      configurable: true,
      value,
    });
  };
  try {
    process.exitCode = 0;
    patch("start", async () => {
      starts++;
    });
    patch("list", () => []);
    patch("submit", async () => ({ state: "completed" }));
    patch("stop", async () => {
      stops++;
    });
    patch("waitForBackgroundFailure", () => notification);
    patch("waitForBackgroundShutdown", async () => {});
    patch("backgroundFailureObserved", () => false);
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: (chunk: string | Uint8Array) => {
        if (typeof chunk === "string") output.push(chunk);
        return true;
      },
    });

    const listStarted = Date.now();
    await main(["list", join(root, "list-data")]);
    assert.ok(Date.now() - listStarted < 1000);
    assert.equal(output[0], "[]\n");

    const runStarted = Date.now();
    await main(["run", join(root, "run-data"), "fixture-work", "prompt", root]);
    assert.ok(Date.now() - runStarted < 1000);
    assert.equal(JSON.parse(output[1] ?? "{}").state, "completed");
    assert.equal(starts, 2);
    assert.equal(stops, 2);
    assert.equal(process.exitCode, 0);
  } finally {
    if (stdoutDescriptor)
      Object.defineProperty(process.stdout, "write", stdoutDescriptor);
    else delete (process.stdout as unknown as { write?: unknown }).write;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete (prototype as unknown as Record<string, unknown>)[name];
    }
    process.exitCode = originalExitCode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an operator fatal notification already latched before its wait closes the live listener", async () => {
  await withCapturedIntervals(async () => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-operator-early-"),
    );
    chmodSync(root, 0o700);
    const data = join(root, "data");
    const authFile = join(root, "operator-auth.json");
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const service = makeService(data, new FixtureRuntime(), diagnostics);
    const operatorDb = new DatabaseSync(join(root, "operator.sqlite"));
    new Store(operatorDb).ensureHost("operator-early-fixture");
    const domain = new DomainStore(operatorDb);
    domain.migrate();
    let auth: OperatorAuth | undefined;
    let listener: LocalOperatorHttp | undefined;
    let listenerStops = 0;
    let authCloses = 0;
    let serviceDb: DatabaseSync | undefined;
    let originalClose: (() => void) | undefined;
    try {
      process.exitCode = 0;
      await service.start();
      serviceDb = serviceAccess(service).db;
      assert.ok(serviceDb?.isOpen);
      originalClose = serviceDb.close.bind(serviceDb);
      let failClose = true;
      Object.defineProperty(serviceDb, "close", {
        configurable: true,
        value: () => {
          if (failClose) {
            failClose = false;
            throw new Error("private service database failure");
          }
          originalClose?.();
        },
      });
      await OperatorAuth.initialize(authFile, "fixture password");
      auth = await OperatorAuth.open({
        authFile,
        origin: "http://127.0.0.1:8788",
      });
      const closeAuth = auth.close.bind(auth);
      auth.close = () => {
        authCloses++;
        closeAuth();
      };
      listener = new LocalOperatorHttp(new LocalOperatorUi(domain), auth);
      const closeListener = listener.stop.bind(listener);
      listener.stop = async () => {
        listenerStops++;
        await closeListener();
      };
      await listener.start(0);
      const access = serviceAccess(service);
      access.wakeScheduler = async () => {
        throw new Error("fatal before operator wait is installed");
      };
      service.domain().execute({
        type: "profile.create",
        actor: "operator",
        key: randomUUID(),
        profileId: randomUUID(),
        name: "Fatal fixture",
        instructions: "not diagnostic content",
        capabilities: "work",
      });
      const notification = service.waitForBackgroundFailure();
      await notification;

      assert.equal(
        await waitForServiceExit(service, notification),
        "background-failure",
      );
      await listener.stop();
      await waitUntil(() => serviceAccess(service).stopPromise === undefined);
      await service.stop();
      auth.close();
      assert.equal(process.exitCode, 1);
      assert.equal(listenerStops, 1);
      assert.equal(
        (listener as unknown as { server?: unknown }).server,
        undefined,
      );
      assert.equal(authCloses, 1);
      assert.throws(() => auth!.createAnonymousSession());
      assert.ok(serviceDb && !serviceDb.isOpen);
      assert.ok(diagnostics.some((event) => event.operation === "domain-wake"));
      assert.ok(
        diagnostics.some((event) => event.errorCode === "shutdown-failed"),
      );
    } finally {
      if (listener && listenerStops === 0)
        await listener.stop().catch(() => {});
      if (auth && authCloses === 0) auth.close();
      if (operatorDb.isOpen) operatorDb.close();
      if (serviceDb?.isOpen && originalClose)
        Object.defineProperty(serviceDb, "close", {
          configurable: true,
          value: originalClose,
        });
      await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("production operator CLI joins an already-fatal service and closes the live listener", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const priorAuthFile = process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
    const priorOrigin = process.env.ENSEMBLE_OPERATOR_ORIGIN;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-cli-operator-early-"),
    );
    chmodSync(root, 0o700);
    const data = join(root, "data");
    const authFile = join(root, "operator-auth.json");
    process.env.ENSEMBLE_OPERATOR_AUTH_FILE = authFile;
    process.env.ENSEMBLE_OPERATOR_ORIGIN = "http://127.0.0.1:8790";
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const listenerStarted = deferred<void>();
    const cliService = deferred<StandaloneService>();
    let auth: OperatorAuth | undefined;
    let authCloses = 0;
    let listenerStops = 0;
    let stopOwnedCalls = 0;
    const prototype = LocalOperatorHttp.prototype;
    const startDescriptor = Object.getOwnPropertyDescriptor(prototype, "start");
    const stopDescriptor = Object.getOwnPropertyDescriptor(prototype, "stop");
    const authOpenDescriptor = Object.getOwnPropertyDescriptor(
      OperatorAuth,
      "open",
    );
    const originalStart = prototype.start;
    const originalStop = prototype.stop;
    const originalAuthOpen = OperatorAuth.open;
    try {
      process.exitCode = 0;
      await OperatorAuth.initialize(authFile, "fixture password");
      Object.defineProperty(OperatorAuth, "open", {
        configurable: true,
        value: async (options: Parameters<typeof OperatorAuth.open>[0]) => {
          auth = await originalAuthOpen.call(OperatorAuth, options);
          const close = auth.close.bind(auth);
          auth.close = () => {
            authCloses++;
            close();
          };
          return auth;
        },
      });
      Object.defineProperty(prototype, "start", {
        configurable: true,
        value: async function (port?: number) {
          const result = await originalStart.call(this, port);
          const service = await cliService.promise;
          const notification = service.waitForBackgroundFailure();
          serviceAccess(service).refreshGitHub = async () => {
            throw new Error("fatal before main reaches its wait");
          };
          fireInterval(intervals, 1000);
          await notification;
          listenerStarted.resolve();
          return result;
        },
      });
      Object.defineProperty(prototype, "stop", {
        configurable: true,
        value: async function () {
          listenerStops++;
          return originalStop.call(this);
        },
      });
      const command = main(["operator", data, "0"], (directory) => {
        const service = makeService(
          directory,
          new FixtureRuntime(),
          diagnostics,
          {
            github: { intervalMs: 1000 },
          },
        );
        const access = serviceAccess(service);
        const stop = access.stopOwned.bind(service);
        access.stopOwned = () => {
          stopOwnedCalls++;
          return stop();
        };
        cliService.resolve(service);
        return service;
      });
      await listenerStarted.promise;
      await command;
      assert.equal(process.exitCode, 1);
      assert.equal(listenerStops, 1);
      assert.equal(authCloses, 1);
      assert.throws(() => auth!.createAnonymousSession());
      assert.equal(stopOwnedCalls, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "github-poll");
    } finally {
      if (startDescriptor)
        Object.defineProperty(prototype, "start", startDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).start;
      if (stopDescriptor)
        Object.defineProperty(prototype, "stop", stopDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).stop;
      if (authOpenDescriptor)
        Object.defineProperty(OperatorAuth, "open", authOpenDescriptor);
      else delete (OperatorAuth as unknown as Record<string, unknown>).open;
      if (auth && authCloses === 0) auth.close();
      process.exitCode = priorExitCode;
      if (priorAuthFile === undefined)
        delete process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
      else process.env.ENSEMBLE_OPERATOR_AUTH_FILE = priorAuthFile;
      if (priorOrigin === undefined)
        delete process.env.ENSEMBLE_OPERATOR_ORIGIN;
      else process.env.ENSEMBLE_OPERATOR_ORIGIN = priorOrigin;
      await cliService.promise
        .then((service) => service.stop().catch(() => {}))
        .catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("operator CLI consumes fatal failures before first accessor and after bundle loading", async () => {
  await withCapturedIntervals(async (intervals) => {
    for (const timing of [
      "before-first-accessor",
      "during-bundle-open",
    ] as const) {
      const priorExitCode = process.exitCode;
      const priorAuthFile = process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
      const priorOrigin = process.env.ENSEMBLE_OPERATOR_ORIGIN;
      const root = mkdtempSync(join(tmpdir(), `ensemble-operator-${timing}-`));
      chmodSync(root, 0o700);
      const data = join(root, "data");
      const workspace = join(root, "workspace");
      const authFile = join(root, "operator-auth.json");
      mkdirSync(workspace);
      process.env.ENSEMBLE_OPERATOR_AUTH_FILE = authFile;
      process.env.ENSEMBLE_OPERATOR_ORIGIN = "http://127.0.0.1:8792";
      const diagnostics: BackgroundFailureDiagnostic[] = [];
      const bundleEntered = deferred<void>();
      const releaseBundle = deferred<void>();
      let service: StandaloneService | undefined;
      let restart: StandaloneService | undefined;
      let runtime: FixtureRuntime | undefined;
      let notification: Promise<BackgroundFailureDiagnostic> | undefined;
      let auth: OperatorAuth | undefined;
      let authCloses = 0;
      let listenerStarts = 0;
      let bundleOpens = 0;
      let accessorsAfterFatal = 0;
      let pollInjected = false;
      const authOpenDescriptor = Object.getOwnPropertyDescriptor(
        OperatorAuth,
        "open",
      );
      const bundleOpenDescriptor = Object.getOwnPropertyDescriptor(
        OperatorWebBundle,
        "open",
      );
      const listenerStartDescriptor = Object.getOwnPropertyDescriptor(
        LocalOperatorHttp.prototype,
        "start",
      );
      const originalAuthOpen = OperatorAuth.open;
      const originalBundleOpen = OperatorWebBundle.open;
      try {
        process.exitCode = 0;
        await OperatorAuth.initialize(authFile, "fixture password");
        Object.defineProperty(OperatorAuth, "open", {
          configurable: true,
          value: async (options: Parameters<typeof OperatorAuth.open>[0]) => {
            auth = await originalAuthOpen.call(OperatorAuth, options);
            const close = auth.close.bind(auth);
            auth.close = () => {
              authCloses++;
              close();
            };
            return auth;
          },
        });
        Object.defineProperty(OperatorWebBundle, "open", {
          configurable: true,
          value: async (directory: string) => {
            bundleOpens++;
            if (timing === "during-bundle-open") {
              bundleEntered.resolve();
              await releaseBundle.promise;
            }
            return originalBundleOpen.call(OperatorWebBundle, directory);
          },
        });
        Object.defineProperty(LocalOperatorHttp.prototype, "start", {
          configurable: true,
          value: async () => {
            listenerStarts++;
            throw new Error("fatal operator setup must not start a listener");
          },
        });

        const command = main(["operator", data, "0"], (directory) => {
          runtime = new FixtureRuntime();
          service = makeService(directory, runtime, diagnostics, {
            github: { intervalMs: 1000 },
          });
          const actualStart = service.start.bind(service);
          service.start = async () => {
            await actualStart();
            runtime!.waitFailure = new Error("fixture execution remains held");
            try {
              const held = await service!.submit(
                "operator-held-work",
                "fixture prompt",
                workspace,
              );
              assert.equal(held.state, "held");
            } finally {
              runtime!.waitFailure = undefined;
            }
          };
          const actualWait = service.waitForBackgroundFailure.bind(service);
          service.waitForBackgroundFailure = () => {
            notification = actualWait();
            return notification;
          };
          const actualObserved =
            service.backgroundFailureObserved.bind(service);
          service.backgroundFailureObserved = (failureNotification) => {
            if (timing === "before-first-accessor" && !pollInjected) {
              pollInjected = true;
              fireInterval(intervals, 1000);
            }
            return actualObserved(failureNotification);
          };
          const checkAfterFatal = () => {
            if (
              notification &&
              service!.backgroundFailureObserved(notification)
            )
              accessorsAfterFatal++;
          };
          const actualDomain = service.domain.bind(service);
          service.domain = () => {
            checkAfterFatal();
            return actualDomain();
          };
          const actualCoordinationView = service.coordinationView.bind(service);
          service.coordinationView = () => {
            checkAfterFatal();
            return actualCoordinationView();
          };
          const actualGitHubSources = service.githubSources.bind(service);
          service.githubSources = () => {
            checkAfterFatal();
            return actualGitHubSources();
          };
          serviceAccess(service).refreshGitHub = () => {
            throw new Error("private fixture poll failure");
          };
          return service;
        });

        if (timing === "during-bundle-open") {
          await bundleEntered.promise;
          assert.ok(service);
          assert.ok(notification);
          fireInterval(intervals, 1000);
          assertSafeDiagnostic(await notification, "github-poll");
          await service.waitForBackgroundShutdown(notification);
          assert.equal(serviceAccess(service).db, undefined);

          restart = new StandaloneService(data, () => new FixtureRuntime());
          await restart.start();
          assert.equal(
            restart
              .list()
              .find((intent) => intent.workId === "operator-held-work")?.state,
            "held",
          );
          await restart.stop();
          restart = undefined;
          releaseBundle.resolve();
        }

        await command;
        if (timing === "before-first-accessor") {
          assert.ok(service);
          assert.ok(notification);
          assertSafeDiagnostic(await notification, "github-poll");
          await service.waitForBackgroundShutdown(notification);
          assert.equal(serviceAccess(service).db, undefined);
          restart = new StandaloneService(data, () => new FixtureRuntime());
          await restart.start();
          assert.equal(
            restart
              .list()
              .find((intent) => intent.workId === "operator-held-work")?.state,
            "held",
          );
          await restart.stop();
          restart = undefined;
        }
        assert.equal(process.exitCode, 1);
        assert.equal(listenerStarts, 0);
        assert.equal(authCloses, 1);
        assert.throws(() => auth!.createAnonymousSession());
        assert.equal(accessorsAfterFatal, 0);
        assert.equal(bundleOpens, timing === "before-first-accessor" ? 0 : 1);
        assert.equal(pollInjected, timing === "before-first-accessor");
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.operation, "github-poll");
      } finally {
        releaseBundle.resolve();
        if (restart) await restart.stop().catch(() => {});
        if (service) {
          if (notification && service.backgroundFailureObserved(notification))
            await service
              .waitForBackgroundShutdown(notification)
              .catch(() => {});
          else await service.stop().catch(() => {});
        }
        if (auth && authCloses === 0) auth.close();
        if (authOpenDescriptor)
          Object.defineProperty(OperatorAuth, "open", authOpenDescriptor);
        else delete (OperatorAuth as unknown as Record<string, unknown>).open;
        if (bundleOpenDescriptor)
          Object.defineProperty(
            OperatorWebBundle,
            "open",
            bundleOpenDescriptor,
          );
        else
          delete (OperatorWebBundle as unknown as Record<string, unknown>).open;
        if (listenerStartDescriptor)
          Object.defineProperty(
            LocalOperatorHttp.prototype,
            "start",
            listenerStartDescriptor,
          );
        else
          delete (
            LocalOperatorHttp.prototype as unknown as Record<string, unknown>
          ).start;
        process.exitCode = priorExitCode;
        if (priorAuthFile === undefined)
          delete process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
        else process.env.ENSEMBLE_OPERATOR_AUTH_FILE = priorAuthFile;
        if (priorOrigin === undefined)
          delete process.env.ENSEMBLE_OPERATOR_ORIGIN;
        else process.env.ENSEMBLE_OPERATOR_ORIGIN = priorOrigin;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

test("production operator CLI handles SIGTERM first, then joins fatal shutdown and closes listener once", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const priorAuthFile = process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
    const priorOrigin = process.env.ENSEMBLE_OPERATOR_ORIGIN;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-cli-operator-race-"),
    );
    chmodSync(root, 0o700);
    const data = join(root, "data");
    const authFile = join(root, "operator-auth.json");
    process.env.ENSEMBLE_OPERATOR_AUTH_FILE = authFile;
    process.env.ENSEMBLE_OPERATOR_ORIGIN = "http://127.0.0.1:8791";
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const listenerStarted = deferred<void>();
    const stopStarted = deferred<void>();
    const cliService = deferred<StandaloneService>();
    const poll = deferred<void>();
    let auth: OperatorAuth | undefined;
    let authCloses = 0;
    let listenerStops = 0;
    let stopOwnedCalls = 0;
    const prototype = LocalOperatorHttp.prototype;
    const startDescriptor = Object.getOwnPropertyDescriptor(prototype, "start");
    const stopDescriptor = Object.getOwnPropertyDescriptor(prototype, "stop");
    const authOpenDescriptor = Object.getOwnPropertyDescriptor(
      OperatorAuth,
      "open",
    );
    const originalStart = prototype.start;
    const originalStop = prototype.stop;
    const originalAuthOpen = OperatorAuth.open;
    try {
      process.exitCode = 0;
      await OperatorAuth.initialize(authFile, "fixture password");
      Object.defineProperty(OperatorAuth, "open", {
        configurable: true,
        value: async (options: Parameters<typeof OperatorAuth.open>[0]) => {
          auth = await originalAuthOpen.call(OperatorAuth, options);
          const close = auth.close.bind(auth);
          auth.close = () => {
            authCloses++;
            close();
          };
          return auth;
        },
      });
      Object.defineProperty(prototype, "start", {
        configurable: true,
        value: async function (port?: number) {
          const result = await originalStart.call(this, port);
          listenerStarted.resolve();
          return result;
        },
      });
      Object.defineProperty(prototype, "stop", {
        configurable: true,
        value: async function () {
          listenerStops++;
          return originalStop.call(this);
        },
      });
      const command = main(["operator", data, "0"], (directory) => {
        const service = makeService(
          directory,
          new FixtureRuntime(),
          diagnostics,
          {
            github: { intervalMs: 1000 },
          },
        );
        const access = serviceAccess(service);
        access.refreshGitHub = () => poll.promise;
        const stop = access.stopOwned.bind(service);
        access.stopOwned = () => {
          stopOwnedCalls++;
          stopStarted.resolve();
          return stop();
        };
        cliService.resolve(service);
        return service;
      });
      await listenerStarted.promise;
      const signalBaseline = process.listenerCount("SIGTERM");
      await waitUntil(() => process.listenerCount("SIGTERM") > signalBaseline);
      const service = await cliService.promise;
      fireInterval(intervals, 1000);
      process.emit("SIGTERM");
      await stopStarted.promise;
      poll.reject(new Error("background failure after SIGTERM won"));
      await command;

      assert.equal(process.exitCode, 1);
      assert.equal(listenerStops, 1);
      assert.equal(authCloses, 1);
      assert.throws(() => auth!.createAnonymousSession());
      assert.equal(stopOwnedCalls, 1);
      assert.equal(service.backgroundFailureObserved(), true);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "github-poll");
    } finally {
      poll.resolve();
      if (startDescriptor)
        Object.defineProperty(prototype, "start", startDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).start;
      if (stopDescriptor)
        Object.defineProperty(prototype, "stop", stopDescriptor);
      else delete (prototype as unknown as Record<string, unknown>).stop;
      if (authOpenDescriptor)
        Object.defineProperty(OperatorAuth, "open", authOpenDescriptor);
      else delete (OperatorAuth as unknown as Record<string, unknown>).open;
      if (auth && authCloses === 0) auth.close();
      process.exitCode = priorExitCode;
      if (priorAuthFile === undefined)
        delete process.env.ENSEMBLE_OPERATOR_AUTH_FILE;
      else process.env.ENSEMBLE_OPERATOR_AUTH_FILE = priorAuthFile;
      if (priorOrigin === undefined)
        delete process.env.ENSEMBLE_OPERATOR_ORIGIN;
      else process.env.ENSEMBLE_OPERATOR_ORIGIN = priorOrigin;
      await cliService.promise
        .then((service) => service.stop().catch(() => {}))
        .catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("production serve CLI sees a fatal service signal that predates its wait", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-cli-serve-early-"),
    );
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const runtime = new FixtureRuntime();
    let service: StandaloneService | undefined;
    let stopOwnedCalls = 0;
    try {
      process.exitCode = 0;
      await main(["serve", root], (directory) => {
        service = makeService(directory, runtime, diagnostics, {
          github: { intervalMs: 1000 },
        });
        const access = serviceAccess(service);
        access.refreshGitHub = () => {
          throw new Error("synchronous fatal before wait");
        };
        const stop = access.stopOwned.bind(service);
        access.stopOwned = () => {
          stopOwnedCalls++;
          return stop();
        };
        const wait = service.waitForBackgroundFailure.bind(service);
        let injected = false;
        service.waitForBackgroundFailure = () => {
          const notification = wait();
          if (!injected) {
            injected = true;
            fireInterval(intervals, 1000);
          }
          return notification;
        };
        return service;
      });
      assert.equal(process.exitCode, 1);
      assert.equal(stopOwnedCalls, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "github-poll");
    } finally {
      if (service) await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("production serve CLI exits successfully on a normal SIGTERM", async () => {
  await withCapturedIntervals(async () => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-cli-serve-signal-"),
    );
    let service: StandaloneService | undefined;
    let stopOwnedCalls = 0;
    try {
      process.exitCode = 0;
      const signalBaseline = process.listenerCount("SIGTERM");
      const command = main(["serve", root], (directory) => {
        service = makeService(directory, new FixtureRuntime(), []);
        const access = serviceAccess(service);
        const stop = access.stopOwned.bind(service);
        access.stopOwned = () => {
          stopOwnedCalls++;
          return stop();
        };
        return service;
      });
      await waitUntil(() => process.listenerCount("SIGTERM") > signalBaseline);
      process.emit("SIGTERM");
      await command;
      assert.equal(process.exitCode, 0);
      assert.equal(stopOwnedCalls, 1);
    } finally {
      if (service) await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("production serve CLI joins a fatal failure that arrives after SIGTERM wins", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-background-cli-serve-race-"),
    );
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const poll = deferred<void>();
    const stopStarted = deferred<void>();
    let service: StandaloneService | undefined;
    let stopOwnedCalls = 0;
    try {
      process.exitCode = 0;
      const signalBaseline = process.listenerCount("SIGTERM");
      const command = main(["serve", root], (directory) => {
        service = makeService(directory, new FixtureRuntime(), diagnostics, {
          github: { intervalMs: 1000 },
        });
        const access = serviceAccess(service);
        access.refreshGitHub = () => poll.promise;
        const stop = access.stopOwned.bind(service);
        access.stopOwned = () => {
          stopOwnedCalls++;
          stopStarted.resolve();
          return stop();
        };
        return service;
      });
      await waitUntil(() => process.listenerCount("SIGTERM") > signalBaseline);
      const activeService = service;
      assert.ok(activeService);
      fireInterval(intervals, 1000);
      process.emit("SIGTERM");
      await stopStarted.promise;
      poll.reject(new Error("fatal after SIGTERM wins"));
      await command;
      assert.equal(process.exitCode, 1);
      assert.equal(stopOwnedCalls, 1);
      assert.equal(activeService.backgroundFailureObserved(), true);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "github-poll");
    } finally {
      poll.resolve();
      if (service) await service.stop().catch(() => {});
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("operator signal-first shutdown joins a later fatal failure and closes its listener and auth once", async () => {
  await withCapturedIntervals(async (intervals) => {
    const priorExitCode = process.exitCode;
    const root = mkdtempSync(join(tmpdir(), "ensemble-background-operator-"));
    chmodSync(root, 0o700);
    const data = join(root, "data");
    const authFile = join(root, "operator-auth.json");
    const diagnostics: BackgroundFailureDiagnostic[] = [];
    const service = makeService(data, new FixtureRuntime(), diagnostics, {
      github: { intervalMs: 1000 },
    });
    const poll = deferred<void>();
    let auth: OperatorAuth | undefined;
    let listener: LocalOperatorHttp | undefined;
    let operatorDb: DatabaseSync | undefined;
    let stopCount = 0;
    let authCloseCount = 0;
    let serviceStopCount = 0;
    let notification: Promise<BackgroundFailureDiagnostic> | undefined;
    try {
      process.exitCode = 0;
      await service.start();
      serviceAccess(service).refreshGitHub = () => poll.promise;

      operatorDb = new DatabaseSync(join(root, "operator.sqlite"));
      new Store(operatorDb).ensureHost("operator-fixture");
      const domain = new DomainStore(operatorDb);
      domain.migrate();
      await OperatorAuth.initialize(authFile, "fixture password");
      auth = await OperatorAuth.open({
        authFile,
        origin: "http://127.0.0.1:8787",
      });
      const originalAuthClose = auth.close.bind(auth);
      auth.close = () => {
        authCloseCount++;
        originalAuthClose();
      };
      const actualListener = new LocalOperatorHttp(
        new LocalOperatorUi(domain),
        auth,
      );
      const originalListenerStop = actualListener.stop.bind(actualListener);
      actualListener.stop = async () => {
        stopCount++;
        await originalListenerStop();
      };
      listener = actualListener;
      await listener.start(0);
      const operatorAccess = listener as unknown as { server?: unknown };

      notification = service.waitForBackgroundFailure();
      const wait = waitForServiceExit(service, notification);
      fireInterval(intervals, 1000);
      process.emit("SIGTERM");
      assert.equal(await wait, "signal");

      await listener.stop();
      const access = serviceAccess(service);
      const originalStopOwned = access.stopOwned.bind(service);
      access.stopOwned = () => {
        serviceStopCount++;
        return originalStopOwned();
      };
      const stopping = service.stop();
      poll.reject(new Error("late fatal failure during SIGTERM cleanup"));
      await stopping;
      await service.waitForBackgroundShutdown(notification);
      if (service.backgroundFailureObserved(notification)) process.exitCode = 1;
      auth.close();

      assert.equal(process.exitCode, 1);
      assert.equal(serviceStopCount, 1);
      assert.equal(stopCount, 1);
      assert.equal(operatorAccess.server, undefined);
      assert.equal(authCloseCount, 1);
      assert.throws(() => auth!.createAnonymousSession());
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.operation, "github-poll");
    } finally {
      poll.resolve();
      if (listener) await listener.stop().catch(() => {});
      if (notification)
        await service.waitForBackgroundShutdown(notification).catch(() => {});
      await service.stop().catch(() => {});
      if (auth && authCloseCount === 0) auth.close();
      if (operatorDb?.isOpen) operatorDb.close();
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
