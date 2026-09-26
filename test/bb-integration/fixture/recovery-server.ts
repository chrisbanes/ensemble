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
  attemptId?: string | undefined;
  environmentId?: string | undefined;
  environment?: unknown;
  instructions?: string | undefined;
  mode?: "wait" | "ready" | undefined;
  operation:
    | "archive"
    | "delete"
    | "environment"
    | "environment-by-id"
    | "message-events"
    | "observations"
    | "queue-delete"
    | "set-instructions"
    | "set-task-wait"
    | "stop"
    | "workspace-attempt"
    | "workspace-prepare"
    | "workspace-reconcile";
  operationId?: string | undefined;
  hostId?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  projectId?: string | undefined;
  prompt?: string | undefined;
  reasoningLevel?: string | undefined;
  serviceTier?: string | undefined;
  taskId?: string | undefined;
  threadId?: string | undefined;
  queuedMessageId?: string | undefined;
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
    CREATE TABLE IF NOT EXISTS t5_message_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t5_workspace_operations (
      operation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      environment_json TEXT NOT NULL,
      state TEXT NOT NULL,
      owner_attempt_id TEXT,
      spawn_calls INTEGER NOT NULL DEFAULT 0,
      chosen_thread_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t5_workspace_attempts (
      operation_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(operation_id, attempt_id)
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

  for (const name of ["message.queued", "message.cancelled"] as const) {
    bb.events.on(name, (payload: unknown) => {
      const event = payload as {
        entry?: { id?: string; threadId?: string };
      };
      if (!event.entry?.id || !event.entry.threadId) return;
      database
        .prepare(
          "INSERT INTO t5_message_events (name, thread_id, message_id, payload) VALUES (?, ?, ?, ?)",
        )
        .run(
          name,
          event.entry.threadId,
          event.entry.id,
          JSON.stringify(payload),
        );
    });
  }

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
              "message-events",
              "observations",
              "queue-delete",
              "set-instructions",
              "set-task-wait",
              "stop",
              "workspace-attempt",
              "workspace-prepare",
              "workspace-reconcile",
            ]),
            instructions: z.string().optional(),
            mode: z.enum(["wait", "ready"]).optional(),
            environmentId: z.string().optional(),
            environment: z.unknown().optional(),
            attemptId: z.string().optional(),
            operationId: z.string().optional(),
            hostId: z.string().optional(),
            model: z.string().optional(),
            permissionMode: z.string().optional(),
            projectId: z.string().optional(),
            prompt: z.string().optional(),
            reasoningLevel: z.string().optional(),
            serviceTier: z.string().optional(),
            taskId: z.string().optional(),
            threadId: z.string().optional(),
            queuedMessageId: z.string().optional(),
          }),
        ),
        output: anyOutput,
      },
    },
    {
      "recovery.run": async (args: RecoveryArgs) => {
        switch (args.operation) {
          case "message-events": {
            if (args.threadId === undefined) {
              throw new Error("message-events requires threadId");
            }
            const rows = database
              .prepare(
                "SELECT name, thread_id AS threadId, message_id AS messageId, payload FROM t5_message_events WHERE thread_id = ? ORDER BY id",
              )
              .all(args.threadId) as {
              name: string;
              threadId: string;
              messageId: string;
              payload: string;
            }[];
            return rows.map(({ payload, ...row }) => ({
              ...row,
              data: JSON.parse(payload),
            }));
          }
          case "queue-delete": {
            if (
              args.threadId === undefined ||
              args.queuedMessageId === undefined
            ) {
              throw new Error(
                "queue-delete requires threadId and queuedMessageId",
              );
            }
            try {
              return await bb.sdk.threads.queuedMessages.delete({
                threadId: args.threadId,
                queuedMessageId: args.queuedMessageId,
              });
            } catch (error) {
              return { ok: false, error: String(error) };
            }
          }
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
          case "workspace-prepare": {
            if (
              args.operationId === undefined ||
              args.taskId === undefined ||
              args.projectId === undefined ||
              args.hostId === undefined ||
              args.prompt === undefined ||
              args.environment === undefined
            ) {
              throw new Error(
                "workspace-prepare requires operationId, taskId, projectId, hostId, prompt, and environment",
              );
            }
            const environmentJson = JSON.stringify(args.environment);
            database
              .prepare(
                `INSERT OR IGNORE INTO t5_workspace_operations
                  (operation_id, task_id, project_id, host_id, prompt,
                   environment_json, state, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
              )
              .run(
                args.operationId,
                args.taskId,
                args.projectId,
                args.hostId,
                args.prompt,
                environmentJson,
                Date.now(),
              );
            const operation = database
              .prepare(
                `SELECT operation_id AS operationId, task_id AS taskId,
                        project_id AS projectId, state,
                        owner_attempt_id AS ownerAttemptId,
                        spawn_calls AS spawnCalls,
                        chosen_thread_id AS chosenThreadId
                 FROM t5_workspace_operations WHERE operation_id = ?`,
              )
              .get(args.operationId) as
              | {
                  operationId: string;
                  taskId: string;
                  projectId: string;
                  state: string;
                  ownerAttemptId: string | null;
                  spawnCalls: number;
                  chosenThreadId: string | null;
                }
              | undefined;
            if (
              operation === undefined ||
              operation.taskId !== args.taskId ||
              operation.projectId !== args.projectId
            ) {
              throw new Error("workspace operation identity conflict");
            }
            const storedPayload = database
              .prepare(
                `SELECT host_id AS hostId, prompt, environment_json AS environmentJson
                 FROM t5_workspace_operations WHERE operation_id = ?`,
              )
              .get(args.operationId) as
              | { hostId: string; prompt: string; environmentJson: string }
              | undefined;
            if (
              storedPayload === undefined ||
              storedPayload.hostId !== args.hostId ||
              storedPayload.prompt !== args.prompt ||
              storedPayload.environmentJson !== environmentJson
            ) {
              throw new Error("workspace operation payload conflict");
            }
            return operation;
          }
          case "workspace-attempt": {
            if (
              args.operationId === undefined ||
              args.attemptId === undefined
            ) {
              throw new Error(
                "workspace-attempt requires operationId and attemptId",
              );
            }
            const operationQuery = database.prepare(
              `SELECT operation_id AS operationId, task_id AS taskId,
                      project_id AS projectId, host_id AS hostId, prompt,
                      environment_json AS environmentJson, state,
                      owner_attempt_id AS ownerAttemptId,
                      spawn_calls AS spawnCalls,
                      chosen_thread_id AS chosenThreadId
               FROM t5_workspace_operations WHERE operation_id = ?`,
            );
            const readOperation = () =>
              operationQuery.get(args.operationId) as
                | {
                    operationId: string;
                    taskId: string;
                    projectId: string;
                    hostId: string;
                    prompt: string;
                    environmentJson: string;
                    state: string;
                    ownerAttemptId: string | null;
                    spawnCalls: number;
                    chosenThreadId: string | null;
                  }
                | undefined;
            const existingAttempt = database
              .prepare(
                `SELECT disposition FROM t5_workspace_attempts
                 WHERE operation_id = ? AND attempt_id = ?`,
              )
              .get(args.operationId, args.attemptId) as
              | { disposition: string }
              | undefined;
            let operation = readOperation();
            if (operation === undefined) {
              throw new Error("unknown workspace operation");
            }
            if (existingAttempt !== undefined) {
              return {
                operationId: args.operationId,
                taskId: operation.taskId,
                attemptId: args.attemptId,
                disposition: existingAttempt.disposition,
                state: operation.state,
                ownerAttemptId: operation.ownerAttemptId,
                spawnCalls: operation.spawnCalls,
                chosenThreadId: operation.chosenThreadId,
                replayed: true,
              };
            }
            const claimed =
              database
                .prepare(
                  `UPDATE t5_workspace_operations
                 SET state = 'provisioning', owner_attempt_id = ?,
                     spawn_calls = spawn_calls + 1, updated_at = ?
                 WHERE operation_id = ? AND state = 'pending'`,
                )
                .run(args.attemptId, Date.now(), args.operationId).changes ===
              1;
            const disposition = claimed ? "owner" : "joined";
            database
              .prepare(
                `INSERT INTO t5_workspace_attempts
                  (operation_id, attempt_id, disposition, created_at)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(args.operationId, args.attemptId, disposition, Date.now());
            operation = readOperation();
            if (operation === undefined) {
              throw new Error("workspace operation disappeared");
            }
            if (!claimed) {
              return {
                operationId: args.operationId,
                taskId: operation.taskId,
                attemptId: args.attemptId,
                disposition,
                state: operation.state,
                ownerAttemptId: operation.ownerAttemptId,
                spawnCalls: operation.spawnCalls,
                chosenThreadId: operation.chosenThreadId,
                replayed: false,
              };
            }

            try {
              const request = {
                projectId: operation.projectId,
                providerId: "ensemble-scripted",
                model: "fixture-model",
                reasoningLevel: "medium",
                serviceTier: "default",
                permissionMode: "accept-edits",
                prompt: operation.prompt,
                environment: JSON.parse(operation.environmentJson),
                pluginMetadata: {
                  t5_task_id: operation.taskId,
                  t5_operation_id: operation.operationId,
                },
              } as Parameters<typeof bb.sdk.threads.spawn>[0];
              await bb.sdk.threads.spawn(request);
              database
                .prepare(
                  `UPDATE t5_workspace_operations SET state = 'uncertain',
                   updated_at = ? WHERE operation_id = ?`,
                )
                .run(Date.now(), args.operationId);
              throw new Error(
                `T5_WORKSPACE_RESPONSE_DROPPED_AFTER_ACCEPTANCE:${args.attemptId}`,
              );
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.startsWith(
                  "T5_WORKSPACE_RESPONSE_DROPPED_AFTER_ACCEPTANCE:",
                )
              ) {
                throw error;
              }
              database
                .prepare(
                  `UPDATE t5_workspace_operations SET state = 'failed',
                   updated_at = ? WHERE operation_id = ?`,
                )
                .run(Date.now(), args.operationId);
              throw error;
            }
          }
          case "workspace-reconcile": {
            if (args.operationId === undefined) {
              throw new Error("workspace-reconcile requires operationId");
            }
            const operation = database
              .prepare(
                `SELECT operation_id AS operationId, task_id AS taskId,
                        project_id AS projectId, state,
                        owner_attempt_id AS ownerAttemptId,
                        spawn_calls AS spawnCalls,
                        chosen_thread_id AS chosenThreadId
                 FROM t5_workspace_operations WHERE operation_id = ?`,
              )
              .get(args.operationId) as
              | {
                  operationId: string;
                  taskId: string;
                  projectId: string;
                  state: string;
                  ownerAttemptId: string | null;
                  spawnCalls: number;
                  chosenThreadId: string | null;
                }
              | undefined;
            if (operation === undefined) {
              throw new Error("unknown workspace operation");
            }
            const candidates = await bb.sdk.threads.list({
              projectId: operation.projectId,
              originPluginId: "ensemble-t1-fixture",
              limit: 100,
            });
            const matches = [];
            for (const candidate of candidates) {
              const metadata = await bb.sdk.threads.getPluginMetadata({
                threadId: candidate.id,
                pluginId: "ensemble-t1-fixture",
              });
              if (metadata.t5_operation_id === operation.operationId) {
                const thread = await bb.sdk.threads.get({
                  threadId: candidate.id,
                });
                const environment =
                  thread.environmentId === null
                    ? null
                    : await bb.sdk.environments.get({
                        environmentId: thread.environmentId,
                      });
                matches.push({
                  threadId: thread.id,
                  status: thread.status,
                  environmentId: thread.environmentId,
                  environmentStatus: environment?.status ?? null,
                });
              }
            }
            const state = matches.length === 1 ? "confirmed" : "held";
            const chosenThreadId =
              matches.length === 1 ? (matches[0]?.threadId ?? null) : null;
            database
              .prepare(
                `UPDATE t5_workspace_operations SET state = ?, chosen_thread_id = ?,
                 updated_at = ? WHERE operation_id = ?`,
              )
              .run(state, chosenThreadId, Date.now(), args.operationId);
            const attempts = database
              .prepare(
                `SELECT attempt_id AS attemptId, disposition FROM t5_workspace_attempts
                 WHERE operation_id = ? ORDER BY created_at, attempt_id`,
              )
              .all(args.operationId);
            return {
              ...operation,
              state,
              chosenThreadId,
              matches,
              attempts,
              publicLookup: "threads.list + getPluginMetadata + threads.get",
            };
          }
        }
      },
    },
  );
}
