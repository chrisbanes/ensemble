import { randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../src/standalone/operator.js";
import {
  OperatorWebBundle,
  OperatorWebBoundary,
} from "../../src/standalone/operator-web.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { OperatorRouteRegistry } from "../../src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
import { coordinationOperatorRoutes } from "../../src/standalone/operator-coordination.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "../temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  StandaloneService,
  type StandaloneServiceOptions,
} from "../../src/standalone/service.js";
import { DeliveryStore } from "../../src/core/delivery.js";
import type { RoutingChoiceClient } from "../../src/standalone/routing.js";
import {
  FixtureLifecycle,
  type FixtureLifecycleOptions,
  type FixtureStep,
  fixtureStepCompleted,
  fixtureStepPending,
  throwFixtureCleanup,
} from "./fixture-lifecycle.js";
export class OperatorFixtureRuntime implements Runtime {
  turns = 0;
  prompts: string[] = [];
  private outcomes = new Map<string, (value: "completed" | "failed") => void>();
  private tool:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  async start() {}
  async stop() {
    for (const done of this.outcomes.values()) done("completed");
  }
  async startThread() {
    return "fixture-thread";
  }
  async resumeThread() {}
  async startTurn(_thread?: string, _workspace?: string, prompt?: string) {
    if (prompt) this.prompts.push(prompt);
    return `fixture-turn-${++this.turns}`;
  }
  async interruptTurn() {}
  waitForTurn(_thread: string, turn: string): Promise<"completed" | "failed"> {
    return new Promise((done) => this.outcomes.set(turn, done));
  }
  onUnexpectedRequest() {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
  callTool(call: RuntimeToolCall) {
    if (!this.tool) throw Error("Fixture listener unavailable");
    return this.tool(call);
  }
  complete(turn: number) {
    this.outcomes.get(`fixture-turn-${turn}`)?.("completed");
  }
}
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";

interface OwnedWeb {
  id: number;
  probe: Server;
  probeClosed: boolean;
  auth?: OperatorAuth;
  http?: LocalOperatorHttp;
  starting: boolean;
  startSteps: FixtureStep[];
  closeSteps: Map<string, FixtureStep>;
}

export async function createOperatorFixture<
  R extends OperatorFixtureRuntime = OperatorFixtureRuntime,
>(
  routingClient: RoutingChoiceClient | null = null,
  readerFactory?: GitHubReaderFactory,
  delivery?: StandaloneServiceOptions["delivery"],
  lifecycleOptions: FixtureLifecycleOptions = {},
  runtimeFactory?: () => R,
) {
  const lifecycle = new FixtureLifecycle(lifecycleOptions);
  const fixtureDeadline = performance.now() + lifecycle.startupTimeoutMs;
  const startupSteps: FixtureStep[] = [];
  let directory = "";
  const directoryOwner = {
    get directory() {
      return directory;
    },
    lifecycle,
    async close(primaryFailure?: unknown) {
      const step = startupSteps.some(fixtureStepPending)
        ? lifecycle.skip("directory.remove")
        : await lifecycle.attempt(
            "directory.remove",
            "cleanup",
            async () => {
              if (directory)
                await rm(directory, { recursive: true, force: true });
            },
            lifecycle.cleanupTimeoutMs,
          );
      throwFixtureCleanup([step], primaryFailure);
    },
  };
  try {
    await lifecycle.start(
      "directory.create",
      async () => {
        directory = await mkdtemp(join(tmpdir(), "ensemble-ui02-"));
      },
      fixtureDeadline,
      startupSteps,
    );
  } catch (error) {
    try {
      await directoryOwner.close(error);
    } catch (failure) {
      throw Object.assign(
        failure instanceof Error ? failure : Error(String(failure)),
        { fixture: directoryOwner },
      );
    }
    throw Object.assign(error instanceof Error ? error : Error(String(error)), {
      fixture: directoryOwner,
    });
  }
  let runtime = runtimeFactory
    ? runtimeFactory()
    : (new OperatorFixtureRuntime() as R);
  const makeService = () =>
    new StandaloneService(join(directory, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient,
      ...(delivery ? { delivery } : {}),
      ...(readerFactory ? { github: { readerFactory } } : {}),
    });
  let service = makeService();
  const listeners = new Map<number, OwnedWeb>();
  let listenerSequence = 0;
  let ownedBrowser: Browser | undefined;
  let browserStep: FixtureStep | undefined;
  let serviceStep: FixtureStep | undefined;
  let directoryStep: FixtureStep | undefined;
  let initialized = false;
  let now = Date.now();
  const cleanupOperation = async (
    name: string,
    operation: () => Promise<void>,
    previous?: FixtureStep,
  ) =>
    previous && fixtureStepCompleted(previous)
      ? previous
      : lifecycle.attempt(
          name,
          "cleanup",
          operation,
          lifecycle.cleanupTimeoutMs,
        );
  const closeWeb = async (web: OwnedWeb, clientsClosed: boolean) => {
    const steps: FixtureStep[] = [];
    const pending = web.starting || web.startSteps.some(fixtureStepPending);
    const attempt = async (
      name: string,
      operation: () => Promise<void>,
      safe: boolean,
    ) => {
      const step = safe
        ? await cleanupOperation(name, operation, web.closeSteps.get(name))
        : lifecycle.skip(name);
      if (safe) web.closeSteps.set(name, step);
      steps.push(step);
      return fixtureStepCompleted(step);
    };
    if (pending) steps.push(lifecycle.skip(`web-${web.id}.cleanup`));
    const safe = clientsClosed && !pending;
    if (!web.probeClosed)
      await attempt(
        `probe-${web.id}.close`,
        async () => {
          if (web.probe.listening)
            await new Promise<void>((resolve, reject) =>
              web.probe.close((error) => (error ? reject(error) : resolve())),
            );
          web.probeClosed = true;
        },
        safe,
      );
    const { http, auth } = web;
    const listenerClosed = http
      ? await attempt(`listener-${web.id}.close`, () => http.stop(), safe)
      : safe;
    if (auth)
      await attempt(
        `auth-${web.id}.close`,
        async () => auth.close(),
        listenerClosed,
      );
    if (!pending && steps.every(fixtureStepCompleted)) listeners.delete(web.id);
    return steps;
  };
  const fixture = {
    directory,
    get runtime() {
      return runtime;
    },
    get service() {
      return service;
    },
    async reopen() {
      if (listeners.size)
        throw Error("Close web clients/listeners before reopening");
      if (service.list().some((i) => i.state === "running"))
        throw Error("Settle active work before reopening");
      await service.stop();
      runtime = runtimeFactory
        ? runtimeFactory()
        : (new OperatorFixtureRuntime() as R);
      service = makeService();
      await service.start();
    },
    lifecycle,
    seedPersistedState(seed: (db: DatabaseSync) => void) {
      const db = new DatabaseSync(join(directory, "data", "standalone.sqlite"));
      try {
        seed(db);
      } finally {
        db.close();
      }
    },
    advanceClock(ms: number) {
      now += ms;
    },
    async startWeb() {
      const id = ++listenerSequence;
      const owned: OwnedWeb = {
        id,
        probe: createServer(),
        probeClosed: false,
        starting: true,
        startSteps: [],
        closeSteps: new Map(),
      };
      listeners.set(id, owned);
      const deadline =
        id === 1
          ? fixtureDeadline
          : performance.now() + lifecycle.startupTimeoutMs;
      const start = (name: string, operation: () => Promise<void>) =>
        lifecycle.start(name, operation, deadline, owned.startSteps);
      try {
        const probe = owned.probe;
        await start(
          `probe-${id}.start`,
          () =>
            new Promise<void>((resolve, reject) => {
              probe.once("error", reject);
              probe.listen(0, "127.0.0.1", resolve);
            }),
        );
        const address = probe.address();
        if (!address || typeof address === "string")
          throw Error("Fixture port unavailable");
        const port = address.port;
        await start(
          `probe-${id}.close`,
          () =>
            new Promise<void>((resolve, reject) =>
              probe.close((e) => (e ? reject(e) : resolve())),
            ),
        );
        owned.probeClosed = true;
        const origin = `http://127.0.0.1:${port}`,
          password = "fixture operator password",
          authFile = join(directory, "operator.auth");
        if (!initialized) {
          await start(`auth-${id}.initialize`, async () => {
            await OperatorAuth.initialize(authFile, password);
            initialized = true;
          });
        }
        await start(`auth-${id}.open`, async () => {
          owned.auth = await OperatorAuth.open({
            authFile,
            origin,
            now: () => now,
            idleTimeoutMs: 1000 * 60,
            absoluteTimeoutMs: 1000 * 60 * 5,
          });
        });
        const auth = owned.auth;
        if (!auth) throw Error("Fixture authentication unavailable");
        const routes = new OperatorRouteRegistry();
        routes.registerSlot("runtime", runtimeOperatorRoutes(service));
        routes.registerSlot(
          "coordination",
          coordinationOperatorRoutes(
            service.coordinationView(),
            service.domain(),
            (id) => service.routingAvailability(id),
          ),
        );
        let bundle!: OperatorWebBundle;
        await start(`bundle-${id}.open`, async () => {
          bundle = await OperatorWebBundle.open(
            fileURLToPath(new URL("../../operator", import.meta.url)),
          );
        });
        const http = new LocalOperatorHttp(
          new LocalOperatorUi(
            service.domain(),
            undefined,
            service.githubSources(),
            () => service.refreshGitHub(),
          ),
          auth,
          {
            routes,
            web: new OperatorWebBoundary(
              bundle,
              new OperatorApi(service, [directory], undefined, readerFactory),
            ),
          },
        );
        owned.http = http;
        await start(`listener-${id}.start`, async () => {
          await http.start(port);
        });
        const close = async () => {
          throwFixtureCleanup(
            await closeWeb(
              owned,
              !ownedBrowser || fixtureStepCompleted(browserStep),
            ),
          );
        };
        return { origin, password, auth, http, close };
      } finally {
        owned.starting = false;
      }
    },
    async close(browser?: Browser, primaryFailure?: unknown) {
      // Clients must close before server.close waits for their connections.
      const steps: FixtureStep[] = [];
      let clientsClosed = true;
      if (browser && browser !== ownedBrowser) {
        if (ownedBrowser && !fixtureStepCompleted(browserStep))
          throwFixtureCleanup(
            [lifecycle.skip("browser.replace")],
            primaryFailure,
          );
        ownedBrowser = browser;
        browserStep = undefined;
      }
      if (ownedBrowser) {
        const client = ownedBrowser;
        const step =
          browserStep && fixtureStepCompleted(browserStep)
            ? browserStep
            : await lifecycle.attempt(
                "browser.close",
                "cleanup",
                () => client.close(),
                lifecycle.cleanupTimeoutMs,
              );
        browserStep = step;
        steps.push(step);
        clientsClosed = fixtureStepCompleted(step);
      }
      let listenersClosed = clientsClosed;
      for (const listener of listeners.values()) {
        const listenerSteps = await closeWeb(listener, clientsClosed);
        steps.push(...listenerSteps);
        if (listenerSteps.some((step) => !fixtureStepCompleted(step)))
          listenersClosed = false;
      }
      const stopped =
        listenersClosed && !startupSteps.some(fixtureStepPending)
          ? await cleanupOperation(
              "service.stop",
              () => service.stop(),
              serviceStep,
            )
          : lifecycle.skip("service.stop");
      if (stopped.status !== "dependency-skipped") serviceStep = stopped;
      steps.push(stopped);
      const removed = fixtureStepCompleted(stopped)
        ? await cleanupOperation(
            "directory.remove",
            () => rm(directory, { recursive: true, force: true }),
            directoryStep,
          )
        : lifecycle.skip("directory.remove");
      if (removed.status !== "dependency-skipped") directoryStep = removed;
      steps.push(removed);
      throwFixtureCleanup(steps, primaryFailure);
    },
  };
  try {
    await lifecycle.start(
      "service.start",
      () => service.start(),
      fixtureDeadline,
      startupSteps,
    );
  } catch (error) {
    try {
      await fixture.close(undefined, error);
    } catch (failure) {
      throw Object.assign(
        failure instanceof Error ? failure : Error(String(failure)),
        { fixture },
      );
    }
    throw Object.assign(error instanceof Error ? error : Error(String(error)), {
      fixture,
    });
  }
  return fixture;
}

export function seedOperatorRecovery(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  ids: { taskId: string; assignmentId: string; projectId: string },
  count = 21,
) {
  f.seedPersistedState((db) => {
    for (let i = 0; i < count; i++) {
      const workId = `recovery-generation-${i + 1}`;
      db.prepare(
        "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'PRIVATE RECOVERY PROMPT','/PRIVATE/RECOVERY/PATH',?,'PRIVATE RECOVERY REASON','PRIVATE THREAD','PRIVATE TURN','chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId, i === 0 ? "held" : "completed");
      db.prepare(
        "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence,processId,processStartedAt,bootId,threadId,turnId) VALUES (?,1,?,'PRIVATE PROCESS','PRIVATE START','PRIVATE BOOT','PRIVATE THREAD','PRIVATE TURN')",
      ).run(workId, i + 1);
      db.prepare(
        "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
      ).run(workId, ids.taskId, ids.assignmentId);
      db.prepare(
        "INSERT INTO execution_recovery_observations (id,workId,kind,reason,recordedAt) VALUES (?,?,?,'PRIVATE OBSERVATION REASON',?)",
      ).run(
        `observation-${i}`,
        workId,
        i === 0 ? "unknown" : "exact-terminal-completed",
        i,
      );
      if (i === 0) {
        db.prepare(
          "INSERT INTO task_writer_admissions (workId,workspace) VALUES (?,'/PRIVATE/RECOVERY/PATH')",
        ).run(workId);
        db.prepare(
          "INSERT INTO execution_capacity_reservations (workId,projectId) VALUES (?,?)",
        ).run(workId, ids.projectId);
      }
      if (i === count - 1)
        db.prepare(
          "INSERT INTO execution_recovery_receipts (id,workId,workRevision,requestSequence,threadId,turnId,processId,processStartedAt,bootId,terminationMethod,terminationVerifiedAt,effectsState,workspaceDisposition,createdAt) VALUES ('newer-receipt',?,1,?,'PRIVATE THREAD','PRIVATE TURN','PRIVATE PROCESS','PRIVATE START','PRIVATE BOOT','mac-pid-absent-same-boot','PRIVATE TIME','settled','preserved',1)",
        ).run(workId, i + 1);
    }
    db.prepare(
      "INSERT INTO task_writer_holds (taskId,reason) VALUES (?,'Task stopped')",
    ).run(ids.taskId);
  });
}

// A registered synthetic PR makes the retained settlement controls observable.
// No runtime admission or provider call occurs in this read-only fixture.
export function seedOperatorDelivery(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  ids: { projectId: string; taskId: string; assignmentId: string },
) {
  const d = f.service.domain(),
    assignment = d.assignment(ids.assignmentId),
    task = d.task(ids.taskId),
    workId = "ui06-bound-delivery-work";
  const caller = {
    ...ids,
    taskVersion: Number(task.version),
    assignmentVersion: Number(assignment.version),
    workId,
    workRevision: 1,
    conversationRevision: 1,
  };
  f.seedPersistedState((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'fixture','fixture','completed',NULL,'fixture-thread','fixture-turn','chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId);
      db.prepare(
        "INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,?,?,?,?)",
      ).run(
        workId,
        ids.taskId,
        ids.assignmentId,
        caller.assignmentVersion,
        Number(assignment.instructionsRevision),
        Number(assignment.profileRevision),
        caller.conversationRevision,
      );
      const binding = new DeliveryStore(db).registerPrWithinTransaction(
        caller,
        {
          repositoryId: "R1",
          nodeId: "P7",
          number: 7,
          baseRef: "main",
          headRef: "cb/change",
          headSha: "1".repeat(40),
          baseSha: "2".repeat(40),
          state: "OPEN",
          draft: false,
          merged: false,
          reviewDecision: null,
          checks: [],
          closedIssueNodeIds: [],
          mergeBlockers: [],
          allowedMethods: ["squash"],
        },
        ids.assignmentId,
      );
      db.exec("COMMIT");
      return binding;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return caller;
}
