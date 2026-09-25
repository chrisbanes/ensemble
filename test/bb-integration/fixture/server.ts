import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerExecutionServer } from "./execution-server.js";

const providerId = "ensemble-scripted";
const retryFailureThreadIds = new Set<string>();

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "Ensemble T1 fixture",
      types: {} as { input: z.input<Schema>; output: z.output<Schema> },
      validate(value) {
        const result = schema.safeParse(value);
        return result.success
          ? { value: result.data }
          : {
              issues: result.error.issues.map((issue) => ({
                message: issue.message,
              })),
            };
      },
    },
  };
}

function registerScriptedProvider(bb: BbPluginApi): void {
  bb.providers.register({
    id: providerId,
    displayName: "T1 scripted fixture provider",
    icon: "Workflow",
    strings: {
      signInHint: "Offline integration fixture",
      expiredHint: "Offline integration fixture",
      installUrl: "https://github.com/get-bb/bb",
      brandPrefix: "T1 fixture",
      planModeCopy: "Scripted integration test",
      iconTint: { light: "#222222", dark: "#eeeeee" },
    },
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    reasoningLevels: [{ id: "medium", label: "Medium" }],
    serviceTiers: [{ id: "default", label: "Default" }],
    models: {
      fallback: [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          description:
            "Offline scripted provider used by the BB integration test.",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    },
    deriveProviderOptions: ({ threadId }) => ({
      scripted: {
        uniqueProviderThreadIds: true,
        ...(retryFailureThreadIds.has(threadId)
          ? {
              failMethods: [
                {
                  method: "turn/start",
                  message: "T2 scripted first-attempt failure",
                  times: 1,
                },
              ],
            }
          : {}),
      },
    }),
  });
}

export default function t1Fixture(bb: BbPluginApi): void {
  const database = bb.storage.database();
  bb.storage.migrate(database, [
    `CREATE TABLE IF NOT EXISTS t1_fixture_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      migration_version INTEGER NOT NULL,
      migration_runs INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL,
      server_loads INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO t1_fixture_state
      (id, migration_version, migration_runs, tool_calls, server_loads)
      VALUES (1, 0, 0, 0, 0)`,
    `CREATE TABLE IF NOT EXISTS t1_fixture_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      thread_id TEXT NOT NULL
    )`,
    `UPDATE t1_fixture_state
      SET migration_version = 1, migration_runs = migration_runs + 1
      WHERE id = 1`,
  ]);
  database
    .prepare(
      "UPDATE t1_fixture_state SET server_loads = server_loads + 1 WHERE id = 1",
    )
    .run();

  const settings = bb.settings.define({
    fixture_mode: {
      type: "string",
      label: "Fixture mode",
      description: "Stored by the disposable T1 plugin.",
      default: "active",
    },
  });

  const recordEvent = (name: string, threadId: string) => {
    database
      .prepare("INSERT INTO t1_fixture_events (name, thread_id) VALUES (?, ?)")
      .run(name, threadId);
  };
  bb.events.on("thread.created", ({ thread }) =>
    recordEvent("created", thread.id),
  );
  bb.events.on("thread.active", ({ thread }) =>
    recordEvent("active", thread.id),
  );
  bb.events.on("thread.idle", ({ thread }) => recordEvent("idle", thread.id));

  bb.agents.registerTool({
    name: "capability_ping",
    description:
      "Increment the disposable T1 SQLite counter and return its value.",
    parameters: z.object({}),
    execute: () => {
      database
        .prepare(
          "UPDATE t1_fixture_state SET tool_calls = tool_calls + 1 WHERE id = 1",
        )
        .run();
      const { tool_calls: toolCalls } = database
        .prepare("SELECT tool_calls FROM t1_fixture_state WHERE id = 1")
        .get() as { tool_calls: number };
      return `capability result ${toolCalls}`;
    },
  });

  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      snapshot: { input: rpcSchema(z.object({})), output: anyOutput },
      spawn: {
        input: rpcSchema(
          z.object({ projectId: z.string(), hostId: z.string() }),
        ),
        output: anyOutput,
      },
      timeline: {
        input: rpcSchema(z.object({ threadId: z.string() })),
        output: anyOutput,
      },
      thread: {
        input: rpcSchema(z.object({ threadId: z.string() })),
        output: anyOutput,
      },
    },
    {
      snapshot: async () => {
        const state = database
          .prepare(
            "SELECT migration_version AS migrationVersion, migration_runs AS migrationRuns, tool_calls AS toolCalls, server_loads AS serverLoads FROM t1_fixture_state WHERE id = 1",
          )
          .get();
        const events = database
          .prepare(
            "SELECT name, thread_id AS threadId FROM t1_fixture_events ORDER BY id",
          )
          .all();
        return { state, events, settings: await settings.get() };
      },
      spawn: ({ projectId, hostId }) =>
        bb.sdk.threads.spawn({
          projectId,
          prompt: "call_tool:capability_ping",
          providerId,
          model: "fixture-model",
          reasoningLevel: "medium",
          serviceTier: "default",
          permissionMode: "accept-edits",
          environment: {
            type: "host",
            hostId,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      timeline: ({ threadId }) => bb.sdk.threads.timeline({ threadId }),
      thread: ({ threadId }) => bb.sdk.threads.get({ threadId }),
    },
  );
  registerExecutionServer(bb, database, (threadId, armed = true) => {
    if (armed) retryFailureThreadIds.add(threadId);
    else retryFailureThreadIds.delete(threadId);
  });
  registerScriptedProvider(bb);
}
