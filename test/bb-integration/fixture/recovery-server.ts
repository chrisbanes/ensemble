import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";
import t1Fixture from "./server.js";

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "Ensemble T5 recovery fixture",
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

type RecoveryArgs = {
  environmentId?: string | undefined;
  instructions?: string | undefined;
  mode?: "wait" | "ready" | undefined;
  operation:
    | "archive"
    | "delete"
    | "environment"
    | "environment-by-id"
    | "observations"
    | "set-instructions"
    | "set-task-wait"
    | "stop";
  taskId?: string | undefined;
  threadId?: string | undefined;
};

type ObservationRow = {
  taskId: string;
  threadId: string;
  environmentId: string | null;
  threadStatus: string;
  attempt: string;
  queuedMessageIds: string;
  inputText: string;
  createdAt: number;
};

export default function recoveryFixture(bb: BbPluginApi): void {
  t1Fixture(bb);

  const database = bb.storage.database();
  database.exec(`
    CREATE TABLE IF NOT EXISTS t5_recovery_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t5_dispatch_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      environment_id TEXT,
      thread_status TEXT NOT NULL,
      attempt TEXT NOT NULL,
      queued_message_ids TEXT NOT NULL,
      input_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO t5_recovery_settings (key, value)
      VALUES ('instructions', 'T5_INSTRUCTIONS_REV=initial');
  `);

  const setting = (key: string, fallback: string) =>
    (
      database
        .prepare("SELECT value FROM t5_recovery_settings WHERE key = ?")
        .get(key) as { value: string } | undefined
    )?.value ?? fallback;

  bb.agents.contributeInstructions(() => setting("instructions", ""));

  bb.experimental_hooks.on("message.dispatch", (context) => {
    const marker = /(?:^|\s)T5_TASK=([a-z0-9_-]+)(?:\s|$)/u.exec(
      context.input.text,
    );
    if (marker === null) return { action: "proceed" };

    const taskId = marker[1];
    database
      .prepare(
        `INSERT INTO t5_dispatch_observations
          (task_id, thread_id, environment_id, thread_status, attempt,
           queued_message_ids, input_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        context.thread.id,
        context.environment?.id ?? null,
        context.thread.status,
        context.attempt,
        JSON.stringify(context.queuedMessages.map((message) => message.id)),
        context.input.text,
        Date.now(),
      );

    return setting(`wait:${taskId}`, "ready") === "wait"
      ? { action: "wait", reason: `T5 fixture wait for ${taskId}` }
      : { action: "proceed" };
  });

  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      "recovery.run": {
        input: rpcSchema(
          z.object({
            operation: z.enum([
              "archive",
              "delete",
              "environment",
              "environment-by-id",
              "observations",
              "set-instructions",
              "set-task-wait",
              "stop",
            ]),
            instructions: z.string().optional(),
            mode: z.enum(["wait", "ready"]).optional(),
            environmentId: z.string().optional(),
            taskId: z.string().optional(),
            threadId: z.string().optional(),
          }),
        ),
        output: anyOutput,
      },
    },
    {
      "recovery.run": async (args: RecoveryArgs) => {
        switch (args.operation) {
          case "observations": {
            const rows =
              args.taskId === undefined
                ? database
                    .prepare(
                      `SELECT task_id AS taskId, thread_id AS threadId,
                            environment_id AS environmentId,
                            thread_status AS threadStatus, attempt,
                            queued_message_ids AS queuedMessageIds,
                            input_text AS inputText, created_at AS createdAt
                       FROM t5_dispatch_observations ORDER BY id`,
                    )
                    .all()
                : database
                    .prepare(
                      `SELECT task_id AS taskId, thread_id AS threadId,
                            environment_id AS environmentId,
                            thread_status AS threadStatus, attempt,
                            queued_message_ids AS queuedMessageIds,
                            input_text AS inputText, created_at AS createdAt
                       FROM t5_dispatch_observations WHERE task_id = ? ORDER BY id`,
                    )
                    .all(args.taskId);
            return rows.map((row: ObservationRow) => {
              const observation = row;
              return {
                ...observation,
                queuedMessageIds: JSON.parse(observation.queuedMessageIds),
              };
            });
          }
          case "set-task-wait": {
            if (args.taskId === undefined || args.mode === undefined) {
              throw new Error("set-task-wait requires taskId and mode");
            }
            database
              .prepare(
                `INSERT INTO t5_recovery_settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              )
              .run(`wait:${args.taskId}`, args.mode);
            if (args.mode === "ready") {
              await bb.experimental_hooks.recheck("message.dispatch");
            }
            return { taskId: args.taskId, mode: args.mode };
          }
          case "set-instructions": {
            if (args.instructions === undefined) {
              throw new Error("set-instructions requires instructions");
            }
            database
              .prepare(
                `INSERT INTO t5_recovery_settings (key, value) VALUES ('instructions', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              )
              .run(args.instructions);
            return { instructions: args.instructions };
          }
          case "stop": {
            if (args.threadId === undefined) {
              throw new Error("stop requires threadId");
            }
            const result = await bb.sdk.threads.stop({
              threadId: args.threadId,
            });
            const thread = await bb.sdk.threads.get({
              threadId: args.threadId,
            });
            return { stopResponse: result, thread };
          }
          case "archive": {
            if (args.threadId === undefined) {
              throw new Error("archive requires threadId");
            }
            const result = await bb.sdk.threads.archive({
              threadId: args.threadId,
            });
            const thread = await bb.sdk.threads.get({
              threadId: args.threadId,
            });
            return { archiveResponse: result, thread };
          }
          case "delete": {
            if (args.threadId === undefined) {
              throw new Error("delete requires threadId");
            }
            return bb.sdk.threads.delete({
              threadId: args.threadId,
              childThreadsConfirmed: true,
            });
          }
          case "environment": {
            if (args.threadId === undefined) {
              throw new Error("environment requires threadId");
            }
            const thread = await bb.sdk.threads.get({
              threadId: args.threadId,
            });
            if (thread.environmentId === null)
              return { thread, environment: null };
            const environment = await bb.sdk.environments.get({
              environmentId: thread.environmentId,
            });
            return { thread, environment };
          }
          case "environment-by-id": {
            if (args.environmentId === undefined) {
              throw new Error("environment-by-id requires environmentId");
            }
            return {
              environment: await bb.sdk.environments.get({
                environmentId: args.environmentId,
              }),
            };
          }
        }
      },
    },
  );
}
