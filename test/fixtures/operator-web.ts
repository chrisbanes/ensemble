import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "../temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
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
export async function createOperatorFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-ui02-"));
  const runtime = new OperatorFixtureRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  await service.start();
  return {
    directory,
    runtime,
    service,
    async close() {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
