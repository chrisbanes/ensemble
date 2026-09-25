import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";

const providerId = "ensemble-scripted";
type OperationArgs = Record<string, unknown>;

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "T4 public dispatch fixture",
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export default function dispatchFixture(bb: BbPluginApi): void {
  const failPath = process.env.T4_FAIL_GATE_PATH;
  if (failPath && existsSync(failPath)) {
    throw new Error("T4 intentional gate initialization failure");
  }
  const databasePath = process.env.T4_INTENTS_DB_PATH;
  if (!databasePath) throw new Error("T4_INTENTS_DB_PATH is required");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS t4_dispatch_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL
    );
    INSERT OR IGNORE INTO t4_dispatch_state (id, mode) VALUES (1, 'ready');
    CREATE TABLE IF NOT EXISTS t4_dispatch_intents (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL,
      send_calls INTEGER NOT NULL DEFAULT 0,
      queued_message_id TEXT,
      timeline_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t4_dispatch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const record = (
    name: string,
    payload: unknown,
    operationId: string | null = null,
  ): void => {
    database
      .prepare(
        "INSERT INTO t4_dispatch_events (operation_id, name, payload, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(operationId, name, JSON.stringify(payload), Date.now());
  };

  const getMode = (): string => {
    const row = database
      .prepare("SELECT mode FROM t4_dispatch_state WHERE id = 1")
      .get() as { mode: string } | undefined;
    return row?.mode ?? "ready";
  };

  const getIntent = (operationId: string) =>
    database
      .prepare(
        `SELECT operation_id AS operationId, thread_id AS threadId,
           prompt, state, send_calls AS sendCalls,
           queued_message_id AS queuedMessageId,
           timeline_message_id AS timelineMessageId,
           created_at AS createdAt, updated_at AS updatedAt
         FROM t4_dispatch_intents WHERE operation_id = ?`,
      )
      .get(operationId) as
      | {
          operationId: string;
          threadId: string;
          prompt: string;
          state: string;
          sendCalls: number;
          queuedMessageId: string | null;
          timelineMessageId: string | null;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

  const requireIntent = (operationId: string) => {
    const row = getIntent(operationId);
    if (!row) throw new Error(`Unknown T4 intent ${operationId}`);
    return row;
  };

  const createIntent = (args: OperationArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const threadId = requiredString(args.threadId, "threadId");
    const prompt = requiredString(args.prompt, "prompt");
    const existing = getIntent(operationId);
    if (existing) {
      if (existing.threadId !== threadId || existing.prompt !== prompt) {
        throw new Error(`T4 operation payload conflict: ${operationId}`);
      }
      return existing;
    }
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO t4_dispatch_intents
          (operation_id, thread_id, prompt, state, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(operationId, threadId, prompt, now, now);
    record("intent.staged", { operationId, threadId, prompt }, operationId);
    return requireIntent(operationId);
  };

  const waitAtBarrier = async (operationId: string): Promise<void> => {
    const barrierPath = process.env.T4_BARRIER_PATH;
    if (!barrierPath) throw new Error("T4_BARRIER_PATH is required");
    record("send.barrier-entered", { barrierPath }, operationId);
    const deadline = Date.now() + 20_000;
    while (!existsSync(barrierPath)) {
      if (Date.now() >= deadline) {
        throw new Error("T4 send barrier was not released within 20 seconds");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    record("send.barrier-released", {}, operationId);
  };

  bb.experimental_hooks.on("message.dispatch", (context) => {
    const mode = getMode();
    if (context.requestedExecution.providerId !== providerId) {
      return { action: "proceed" };
    }
    record("message.dispatch", {
      threadId: context.thread.id,
      mode,
      input: context.input.text,
      attempt: context.attempt,
      queuedMessageIds: context.queuedMessages.map((message) => message.id),
    });
    if (mode === "paused" || mode === "stopped") {
      return { action: "reject", message: `T4 dispatch gate is ${mode}` };
    }
    return { action: "proceed" };
  });

  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      "dispatch.run": {
        input: rpcSchema(
          z.object({
            operation: z.enum([
              "state",
              "set-mode",
              "stage",
              "send",
              "reconcile",
              "intent",
              "events",
            ]),
            args: z.record(z.string(), z.unknown()).default({}),
          }),
        ),
        output: anyOutput,
      },
    },
    {
      "dispatch.run": async ({ operation, args }) => {
        const input = args as OperationArgs;
        switch (operation) {
          case "state":
            return { mode: getMode() };
          case "set-mode": {
            const mode = requiredString(input.mode, "mode");
            if (mode !== "ready" && mode !== "paused" && mode !== "stopped") {
              throw new Error(`Unsupported T4 gate mode: ${mode}`);
            }
            database
              .prepare("UPDATE t4_dispatch_state SET mode = ? WHERE id = 1")
              .run(mode);
            record("gate.mode-changed", { mode });
            if (input.recheck === true) {
              await bb.experimental_hooks.recheck("message.dispatch");
            }
            return { mode, recheckScheduled: input.recheck === true };
          }
          case "stage":
            return createIntent(input);
          case "send": {
            const intent = createIntent(input);
            const operationId = intent.operationId;
            if (intent.sendCalls !== 0) {
              return {
                ...intent,
                replayed: true,
                noBlindRetry: true,
              };
            }
            database
              .prepare(
                "UPDATE t4_dispatch_intents SET send_calls = 1, updated_at = ? WHERE operation_id = ?",
              )
              .run(Date.now(), operationId);
            record("send.started", { threadId: intent.threadId }, operationId);
            if (input.barrier === true) await waitAtBarrier(operationId);
            const result = await bb.sdk.threads.send({
              threadId: intent.threadId,
              mode: "auto",
              input: [{ type: "text", text: intent.prompt, mentions: [] }],
            });
            const queuedMessageId =
              result.delivery === "queued" ? result.queuedMessage.id : null;
            record(
              "send.accepted",
              { delivery: result.delivery, queuedMessageId },
              operationId,
            );
            if (input.dropCallerResponse === true) {
              database
                .prepare(
                  "UPDATE t4_dispatch_intents SET state = 'uncertain', updated_at = ? WHERE operation_id = ?",
                )
                .run(Date.now(), operationId);
              record(
                "send.response-dropped",
                { delivery: result.delivery },
                operationId,
              );
              throw new Error("T4_RESPONSE_DROPPED_AFTER_ACCEPTANCE");
            }
            database
              .prepare(
                `UPDATE t4_dispatch_intents SET state = ?, queued_message_id = ?,
                 updated_at = ? WHERE operation_id = ?`,
              )
              .run(
                result.delivery === "queued" ? "queued" : "sent",
                queuedMessageId,
                Date.now(),
                operationId,
              );
            return { delivery: result.delivery, queuedMessageId };
          }
          case "reconcile": {
            const operationId = requiredString(
              input.operationId,
              "operationId",
            );
            const intent = requireIntent(operationId);
            const [timeline, queue] = await Promise.all([
              bb.sdk.threads.timeline({ threadId: intent.threadId }),
              bb.sdk.threads.queuedMessages.list({ threadId: intent.threadId }),
            ]);
            const timelineMatches = timeline.rows.filter(
              (row) =>
                row.kind === "conversation" &&
                "role" in row &&
                row.role === "user" &&
                row.text === intent.prompt,
            );
            const queueMatches = queue.filter((row) =>
              row.content.some(
                (part) => part.type === "text" && part.text === intent.prompt,
              ),
            );
            let state = "held";
            let queuedMessageId: string | null = null;
            let timelineMessageId: string | null = null;
            if (queueMatches.length === 1 && timelineMatches.length === 0) {
              state = "queued";
              queuedMessageId = queueMatches[0]?.id ?? null;
            } else if (
              queueMatches.length === 0 &&
              timelineMatches.length === 1
            ) {
              state = "sent";
              timelineMessageId = timelineMatches[0]?.id ?? null;
            }
            database
              .prepare(
                `UPDATE t4_dispatch_intents SET state = ?, queued_message_id = ?,
                 timeline_message_id = ?, updated_at = ? WHERE operation_id = ?`,
              )
              .run(
                state,
                queuedMessageId,
                timelineMessageId,
                Date.now(),
                operationId,
              );
            record(
              "send.reconciled",
              {
                state,
                queueMatches: queueMatches.map((row) => row.id),
                timelineMatches: timelineMatches.map((row) => row.id),
              },
              operationId,
            );
            return {
              ...requireIntent(operationId),
              timelineMatches: timelineMatches.map((row) => ({
                id: row.id,
                turnId: row.turnId,
              })),
              queueMatches: queueMatches.map((row) => ({
                id: row.id,
                waitingOn: row.waitingOn,
              })),
              publicLookup: "threads.timeline + queuedMessages.list",
            };
          }
          case "intent":
            return requireIntent(
              requiredString(input.operationId, "operationId"),
            );
          case "events":
            return database
              .prepare(
                `SELECT id, operation_id AS operationId, name, payload,
                   created_at AS createdAt
                 FROM t4_dispatch_events ORDER BY id`,
              )
              .all()
              .map((row) => {
                const item = row as {
                  id: number;
                  operationId: string | null;
                  name: string;
                  payload: string;
                  createdAt: number;
                };
                return { ...item, payload: JSON.parse(item.payload) };
              });
          default:
            throw new Error(`Unknown T4 dispatch operation: ${operation}`);
        }
      },
    },
  );
}
