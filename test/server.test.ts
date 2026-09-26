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
    config.provider = "";
    config.model = "";
    const running = await call("ensemble_delegate", {
      id: assignmentId,
      taskId,
      brief: "Investigate",
    });
    assert.equal(running.state, "running");
    assert.equal(spawns, 1);
    await assert.rejects(
      call("ensemble_report", { assignmentId, result: "done" }, "intruder"),
      /Only the assigned/,
    );
    await call("ensemble_report", { assignmentId, result: "done" }, "worker");
    const completed = await call("ensemble_delegate", {
      id: assignmentId,
      taskId,
      brief: "Investigate",
    });
    assert.equal(completed.state, "completed");
    assert.equal(completed.result, "done");
    await assert.rejects(
      call("ensemble_delegate", {
        id: assignmentId,
        taskId,
        brief: "Changed request",
      }),
      /different|conflict/i,
    );
    const nextTaskId = "10000000-0000-4000-8000-000000000003";
    await call("ensemble_create_task", { id: nextTaskId, title: "Next" });
    await assert.rejects(
      call("ensemble_delegate", {
        id: "10000000-0000-4000-8000-000000000004",
        taskId: nextTaskId,
        brief: "New work",
      }),
      /Configure the worker/,
    );
    assert.equal(spawns, 1);
    const assignments = await call("ensemble_assignments", {});
    assert.equal(assignments[0].result, "done");
    assert.equal(assignments[0].threadId, "worker");
  } finally {
    db.close();
  }
});

test("project selection changed after authorization prevents a BB spawn", async () => {
  const db = new DatabaseSync(":memory:");
  const tools = new Map<
    string,
    {
      execute(input: unknown, context: PluginAgentToolContext): Promise<string>;
    }
  >();
  let reads = 0;
  let spawns = 0;
  const config = {
    project: "original-project",
    coordinatorThread: "lead",
    provider: "provider",
    model: "model",
    instructions: "Investigate only",
  };
  const bb = {
    pluginId: "ensemble",
    storage: { database: () => db },
    settings: {
      define: () => ({
        get: async () => {
          reads++;
          // Create and delegate authorization plus preflight use the original
          // selection. The operator changes it before the final host call.
          return {
            ...config,
            project: reads >= 4 ? "replacement-project" : config.project,
          };
        },
      }),
    },
    agents: {
      registerTool: (tool: {
        name: string;
        execute(
          input: unknown,
          context: PluginAgentToolContext,
        ): Promise<string>;
      }) => tools.set(tool.name, tool),
      configure: () => {},
    },
    background: { service: () => {} },
    sdk: {
      threads: {
        async spawn() {
          spawns++;
          return { id: "unexpected-worker" };
        },
      },
    },
  };
  const context = {
    projectId: "original-project",
    threadId: "lead",
    signal: new AbortController().signal,
  };
  const taskId = "10000000-0000-4000-8000-000000000010";
  try {
    plugin(bb as unknown as BbPluginApi);
    await tools
      .get("ensemble_create_task")!
      .execute({ id: taskId, title: "Race" }, context);
    await assert.rejects(
      tools.get("ensemble_delegate")!.execute(
        {
          id: "10000000-0000-4000-8000-000000000011",
          taskId,
          brief: "Do not launch after project revocation",
        },
        context,
      ),
      /configured project/,
    );
    assert.equal(spawns, 0);
  } finally {
    db.close();
  }
});
