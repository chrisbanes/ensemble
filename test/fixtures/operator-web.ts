import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
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
import { StandaloneService } from "../../src/standalone/service.js";
import type { RoutingChoiceClient } from "../../src/standalone/routing.js";
export class OperatorFixtureRuntime implements Runtime {
  turns = 0;
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
  async startTurn() {
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
export async function createOperatorFixture(
  routingClient: RoutingChoiceClient | null = null,
) {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-ui02-"));
  const runtime = new OperatorFixtureRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient },
  );
  await service.start();
  const listeners = new Set<() => Promise<void>>();
  let initialized = false;
  let now = Date.now();
  return {
    directory,
    runtime,
    service,
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
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
      });
      const address = probe.address();
      if (!address || typeof address === "string")
        throw Error("Fixture port unavailable");
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        probe.close((e) => (e ? reject(e) : resolve())),
      );
      const origin = `http://127.0.0.1:${port}`,
        password = "fixture operator password",
        authFile = join(directory, "operator.auth");
      if (!initialized) {
        await OperatorAuth.initialize(authFile, password);
        initialized = true;
      }
      const auth = await OperatorAuth.open({
        authFile,
        origin,
        now: () => now,
        idleTimeoutMs: 1000 * 60,
        absoluteTimeoutMs: 1000 * 60 * 5,
      });
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
      const bundle = await OperatorWebBundle.open(
        fileURLToPath(new URL("../../operator", import.meta.url)),
      );
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
            new OperatorApi(service, [directory]),
          ),
        },
      );
      await http.start(port);
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await http.stop();
        auth.close();
        listeners.delete(close);
      };
      listeners.add(close);
      return { origin, password, auth, http, close };
    },
    async close() {
      for (const close of listeners) await close();
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
