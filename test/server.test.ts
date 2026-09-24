import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { z } from "zod";
import plugin from "../src/server.js";

test("plugin tools enforce actor scope and reconnect after a lost BB response", async () => {
  const db = new DatabaseSync(":memory:");
  type Tool = {
    name: string;
    parameters: z.ZodType;
    execute(input: unknown, context: PluginAgentToolContext): Promise<string>;
  };
  const tools = new Map<string, Tool>();
  const config = {
    project: "project",
    coordinatorThread: "lead",
    provider: "provider",
    model: "model",
    instructions: "Investigate only",
  };
  let metadata: Record<string, unknown> = {};
  let spawns = 0;
  let reconcile = async () => {};
  // Explicit fake for the public surfaces this prototype uses. Unexpected SDK
  // access fails rather than falling back to a real server or provider.
  const bb = {
    pluginId: "ensemble",
    storage: { database: () => db },
    settings: { define: () => ({ get: async () => config }) },
    agents: {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      configure: () => {},
    },
    background: {
      service: (_name: string, service: { start(): Promise<void> }) => {
        reconcile = service.start;
      },
    },
    sdk: {
      threads: {
        async spawn(input: {
          projectId: string;
          pluginMetadata: Record<string, unknown>;
        }) {
          assert.equal(input.projectId, "project");
          metadata = input.pluginMetadata;
          spawns++;
          throw new Error("response lost");
        },
        async list(input: { projectId: string; originPluginId: string }) {
          assert.equal(input.projectId, "project");
          assert.equal(input.originPluginId, "ensemble");
          return spawns ? [{ id: "worker" }] : [];
        },
        async getPluginMetadata() {
          return metadata;
        },
      },
    },
  };
  async function call(
    name: string,
    input: unknown,
    threadId = "lead",
    projectId = "project",
  ) {
    const tool = tools.get(name);
    assert.ok(tool);
    return JSON.parse(
      await tool.execute(tool.parameters.parse(input), {
        threadId,
        projectId,
        signal: new AbortController().signal,
      }),
    );
  }
  const taskId = "10000000-0000-4000-8000-000000000001";
  const assignmentId = "10000000-0000-4000-8000-000000000002";
  try {
    plugin(bb as unknown as BbPluginApi);
    await assert.rejects(
      call("ensemble_create_task", { id: taskId, title: "Test" }, "intruder"),
      /configured coordinator/,
    );
    await assert.rejects(
      call("ensemble_create_task", { id: "invalid", title: "Test" }),
    );
    await call("ensemble_create_task", { id: taskId, title: "Test" });
    await assert.rejects(
      call("ensemble_delegate", {
        id: assignmentId,
        taskId,
        brief: "Investigate",
      }),
      /response lost/,
    );
    // Reload the plugin over persisted storage; BB still has the worker.
    plugin(bb as unknown as BbPluginApi);
    await reconcile();
    await call("ensemble_delegate", {
      id: assignmentId,
      taskId,
      brief: "Investigate",
    });
    assert.equal(spawns, 1);
    await assert.rejects(
      call("ensemble_report", { assignmentId, result: "done" }, "intruder"),
      /Only the assigned/,
    );
    await call("ensemble_report", { assignmentId, result: "done" }, "worker");
    config.provider = ""; // Results remain available if a provider is removed.
    const assignments = await call("ensemble_assignments", {});
    assert.equal(assignments[0].result, "done");
    assert.equal(assignments[0].threadId, "worker");
  } finally {
    db.close();
  }
});
