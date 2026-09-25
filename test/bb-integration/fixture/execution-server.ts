import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pluginId = "ensemble-t1-fixture";

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "Ensemble T2 execution fixture",
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

type ExecutionArgs = Record<string, unknown>;

export function registerExecutionServer(
  bb: BbPluginApi,
  database: ReturnType<BbPluginApi["storage"]["database"]>,
  armRetryFailure: (threadId: string, armed?: boolean) => void,
): void {
  database.exec(`CREATE TABLE IF NOT EXISTS t2_execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);

  const record = (name: string, payload: unknown, threadId: string | null) => {
    if (!threadId) return;
    database
      .prepare(
        "INSERT INTO t2_execution_events (name, thread_id, payload) VALUES (?, ?, ?)",
      )
      .run(name, threadId, JSON.stringify(payload));
  };
  const lifecycleEvents = [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "interaction.pending",
    "message.queued",
    "message.dispatched",
    "message.cancelled",
    "turn.failed",
  ] as const;
  for (const eventName of lifecycleEvents) {
    bb.events.on(eventName, (payload: unknown) => {
      const event = payload as {
        thread?: { id?: string };
        entry?: { threadId?: string };
        threadId?: string;
      };
      const threadId =
        event.thread?.id ?? event.entry?.threadId ?? event.threadId;
      record(eventName, payload, threadId ?? null);
    });
  }

  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      "execution.run": {
        input: rpcSchema(
          z.object({
            operation: z.enum([
              "spawn",
              "arm-retry-failure",
              "disarm-retry-failure",
              "get",
              "output",
              "metadata",
              "environment",
              "events",
              "send",
              "queue-list",
              "queue-send",
              "queue-delete",
              "stop",
              "interactions",
              "answer",
              "retry",
            ]),
            args: z.record(z.string(), z.unknown()).default({}),
          }),
        ),
        output: anyOutput,
      },
    },
    {
      "execution.run": async ({ operation, args }) => {
        const input = args as ExecutionArgs;
        switch (operation) {
          case "spawn":
            return bb.sdk.threads.spawn(
              input as unknown as Parameters<typeof bb.sdk.threads.spawn>[0],
            );
          case "arm-retry-failure":
            armRetryFailure(String(input.threadId));
            return { armed: true, threadId: input.threadId };
          case "disarm-retry-failure":
            armRetryFailure(String(input.threadId), false);
            return { armed: false, threadId: input.threadId };
          case "get":
            return bb.sdk.threads.get({ threadId: String(input.threadId) });
          case "output":
            return bb.sdk.threads.output({ threadId: String(input.threadId) });
          case "metadata":
            return bb.sdk.threads.getPluginMetadata({
              threadId: String(input.threadId),
              pluginId,
            });
          case "environment":
            return bb.sdk.environments.get({
              environmentId: String(input.environmentId),
            });
          case "events": {
            const rows = database
              .prepare(
                "SELECT name, thread_id AS threadId, payload FROM t2_execution_events WHERE thread_id = ? ORDER BY id",
              )
              .all(String(input.threadId)) as {
              name: string;
              threadId: string;
              payload: string;
            }[];
            return rows.map((row) => ({
              name: row.name,
              threadId: row.threadId,
              data: JSON.parse(row.payload),
            }));
          }
          case "send":
            return bb.sdk.threads.send(
              input as unknown as Parameters<typeof bb.sdk.threads.send>[0],
            );
          case "queue-list":
            return bb.sdk.threads.queuedMessages.list({
              threadId: String(input.threadId),
            });
          case "queue-send":
            return bb.sdk.threads.queuedMessages.send(
              input as unknown as Parameters<
                typeof bb.sdk.threads.queuedMessages.send
              >[0],
            );
          case "queue-delete":
            return bb.sdk.threads.queuedMessages.delete(
              input as unknown as Parameters<
                typeof bb.sdk.threads.queuedMessages.delete
              >[0],
            );
          case "stop":
            return bb.sdk.threads.stop({
              threadId: String(input.threadId),
            });
          case "interactions":
            return bb.sdk.threads.interactions.list({
              threadId: String(input.threadId),
            });
          case "answer":
            return bb.sdk.threads.interactions.resolve(
              input as unknown as Parameters<
                typeof bb.sdk.threads.interactions.resolve
              >[0],
            );
          case "retry":
            return bb.sdk.threads.retry(
              input as unknown as Parameters<typeof bb.sdk.threads.retry>[0],
            );
          default:
            throw new Error(`Unknown T2 execution operation: ${operation}`);
        }
      },
    },
  );
}
