import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";

const providerId = "ensemble-scripted";
const lostResponseMarkerKey = "t01_lost_response_marker";
const failStartupPath = process.env.T01_FAIL_ENSEMBLE_STARTUP;

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "Ensemble T01",
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

export default function integrationFixture(bb: BbPluginApi): void {
  if (failStartupPath !== undefined && existsSync(failStartupPath)) {
    throw new Error("Intentional T01 Ensemble startup failure");
  }
  const database = bb.storage.database();
  database.exec(`
    CREATE TABLE IF NOT EXISTS integration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tool_calls INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO integration_state (id, tool_calls) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS integration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_dispatch (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'uncertain', 'accepted')),
      delivery TEXT,
      queued_message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS fault_injection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dropped_responses INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO fault_injection (id, dropped_responses) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS dispatch_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL CHECK (mode IN ('ready', 'paused', 'stopped'))
    );
    INSERT OR IGNORE INTO dispatch_control (id, mode) VALUES (1, 'ready');
  `);
  const recordEvent = (eventName: string, threadId: string) => {
    database
      .prepare(
        "INSERT INTO integration_events (event_name, thread_id) VALUES (?, ?)",
      )
      .run(eventName, threadId);
  };

  bb.events.on("thread.created", ({ thread }) =>
    recordEvent("thread.created", thread.id),
  );
  bb.events.on("thread.active", ({ thread }) =>
    recordEvent("thread.active", thread.id),
  );
  bb.events.on("thread.idle", ({ thread }) =>
    recordEvent("thread.idle", thread.id),
  );
  bb.events.on("thread.failed", ({ thread }) =>
    recordEvent("thread.failed", thread.id),
  );
  bb.events.on("thread.archived", ({ thread }) =>
    recordEvent("thread.archived", thread.id),
  );
  bb.events.on("interaction.pending", ({ thread }) =>
    recordEvent("interaction.pending", thread.id),
  );
  bb.events.on("message.queued", ({ entry }) =>
    recordEvent("message.queued", entry.threadId),
  );
  bb.events.on("message.dispatched", ({ entry }) =>
    recordEvent("message.dispatched", entry.threadId),
  );

  bb.experimental_hooks.on("message.dispatch", ({ thread }) => {
    if (thread.providerId !== providerId) return { action: "proceed" };
    const { mode } = database
      .prepare("SELECT mode FROM dispatch_control WHERE id = 1")
      .get() as { mode: "ready" | "paused" | "stopped" };
    return mode === "ready"
      ? { action: "proceed" }
      : {
          action: "reject",
          message: `T01 dispatch gate is ${mode}`,
        };
  });

  bb.agents.registerTool({
    name: "integration_ping",
    description: "Record one scripted BB integration tool call.",
    parameters: z.object({}),
    execute: () => {
      database
        .prepare(
          "UPDATE integration_state SET tool_calls = tool_calls + 1 WHERE id = 1",
        )
        .run();
      return "integration tool result";
    },
  });

  const fault = { marker: null as string | null };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const requestBody = typeof init?.body === "string" ? init.body : "";
    const response = await nativeFetch(input, init);
    if (fault.marker === null || !requestBody.includes(fault.marker)) {
      return response;
    }

    const acceptedResponse: unknown = await response.clone().json();
    if (
      typeof acceptedResponse !== "object" ||
      acceptedResponse === null ||
      !("ok" in acceptedResponse) ||
      acceptedResponse.ok !== true ||
      !("delivery" in acceptedResponse) ||
      typeof acceptedResponse.delivery !== "string"
    ) {
      return response;
    }

    fault.marker = null;
    database
      .prepare(
        "UPDATE fault_injection SET dropped_responses = dropped_responses + 1 WHERE id = 1",
      )
      .run();
    throw new TypeError("T01 injected response loss after BB accepted send");
  };

  const emptyInput = rpcSchema(z.object({}));
  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      snapshot: {
        input: emptyInput,
        output: anyOutput,
      },
      spawn: {
        input: rpcSchema(
          z.object({
            projectId: z.string(),
            hostId: z.string(),
            prompt: z.string(),
            environmentId: z.string().optional(),
          }),
        ),
        output: anyOutput,
      },
      stagePending: {
        input: rpcSchema(
          z.object({
            operationId: z.string(),
            threadId: z.string(),
            prompt: z.string(),
          }),
        ),
        output: anyOutput,
      },
      dispatchPending: {
        input: rpcSchema(z.object({ operationId: z.string() })),
        output: anyOutput,
      },
      send: {
        input: rpcSchema(
          z.object({ threadId: z.string(), prompt: z.string() }),
        ),
        output: anyOutput,
      },
      sendWithLostResponse: {
        input: rpcSchema(
          z.object({
            operationId: z.string(),
            threadId: z.string(),
          }),
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
      pendingInteractions: {
        input: rpcSchema(z.object({ threadId: z.string() })),
        output: anyOutput,
      },
      recoverLostResponse: {
        input: rpcSchema(z.object({ operationId: z.string() })),
        output: anyOutput,
      },
      answerQuestion: {
        input: rpcSchema(z.object({ threadId: z.string() })),
        output: anyOutput,
      },
      setDispatchGate: {
        input: rpcSchema(
          z.object({ mode: z.enum(["ready", "paused", "stopped"]) }),
        ),
        output: anyOutput,
      },
      recheckDispatch: {
        input: emptyInput,
        output: anyOutput,
      },
      sendAdmissionProbe: {
        input: rpcSchema(
          z.object({
            threadId: z.string(),
            prompt: z.string(),
            mode: z.enum(["start", "queue-if-active"]).default("start"),
          }),
        ),
        output: anyOutput,
      },
      queuedMessages: {
        input: rpcSchema(z.object({ threadId: z.string() })),
        output: anyOutput,
      },
      createQueuedMessage: {
        input: rpcSchema(
          z.object({ threadId: z.string(), prompt: z.string() }),
        ),
        output: anyOutput,
      },
    },
    {
      snapshot: () => ({
        toolCalls: database
          .prepare("SELECT tool_calls FROM integration_state WHERE id = 1")
          .get(),
        pending: database
          .prepare("SELECT * FROM pending_dispatch ORDER BY operation_id")
          .all(),
        droppedResponses: database
          .prepare("SELECT dropped_responses FROM fault_injection WHERE id = 1")
          .get(),
        events: database
          .prepare(
            "SELECT event_name AS eventName, thread_id AS threadId FROM integration_events ORDER BY id",
          )
          .all(),
      }),
      spawn: async ({ projectId, hostId, prompt, environmentId }) =>
        bb.sdk.threads.spawn({
          projectId,
          prompt,
          providerId,
          model: "fixture-model",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "accept-edits",
          environment:
            environmentId === undefined
              ? {
                  type: "host",
                  hostId,
                  workspace: {
                    type: "managed-worktree",
                    baseBranch: { kind: "default" },
                  },
                }
              : { type: "reuse", environmentId },
        }),
      stagePending: ({ operationId, threadId, prompt }) => {
        database
          .prepare(
            "INSERT INTO pending_dispatch (operation_id, thread_id, prompt, status) VALUES (?, ?, ?, 'pending')",
          )
          .run(operationId, threadId, prompt);
        return { operationId, status: "pending" };
      },
      dispatchPending: async ({ operationId }) => {
        const operation = database
          .prepare("SELECT * FROM pending_dispatch WHERE operation_id = ?")
          .get(operationId) as
          | {
              operation_id: string;
              thread_id: string;
              prompt: string;
              status: string;
            }
          | undefined;
        if (operation === undefined)
          throw new Error(`Unknown operation: ${operationId}`);
        if (operation.status !== "pending") {
          throw new Error(
            `Operation is ${operation.status}; it must not be resent`,
          );
        }
        const response = await bb.sdk.threads.send({
          threadId: operation.thread_id,
          input: [{ type: "text", text: operation.prompt, mentions: [] }],
          mode: "auto",
        });
        database
          .prepare(
            "UPDATE pending_dispatch SET status = 'accepted', delivery = ?, queued_message_id = ? WHERE operation_id = ?",
          )
          .run(
            response.delivery,
            response.delivery === "queued" ? response.queuedMessage.id : null,
            operationId,
          );
        return response;
      },
      send: ({ threadId, prompt }) =>
        bb.sdk.threads.send({
          threadId,
          input: [{ type: "text", text: prompt, mentions: [] }],
          mode: "start",
        }),
      sendWithLostResponse: async ({ operationId, threadId }) => {
        const marker = `${lostResponseMarkerKey}:${operationId}`;
        const prompt = `${marker} call_tool:integration_ping`;
        database
          .prepare(
            "INSERT INTO pending_dispatch (operation_id, thread_id, prompt, status) VALUES (?, ?, ?, 'pending')",
          )
          .run(operationId, threadId, prompt);
        fault.marker = marker;
        try {
          const response = await bb.sdk.threads.send({
            threadId,
            input: [{ type: "text", text: prompt, mentions: [] }],
            mode: "auto",
          });
          database
            .prepare(
              "UPDATE pending_dispatch SET status = 'accepted', delivery = ?, queued_message_id = ? WHERE operation_id = ?",
            )
            .run(
              response.delivery,
              response.delivery === "queued" ? response.queuedMessage.id : null,
              operationId,
            );
          return { status: "accepted", delivery: response.delivery };
        } catch (error) {
          database
            .prepare(
              "UPDATE pending_dispatch SET status = 'uncertain' WHERE operation_id = ?",
            )
            .run(operationId);
          return {
            status: "uncertain",
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          fault.marker = null;
        }
      },
      timeline: ({ threadId }) => bb.sdk.threads.timeline({ threadId }),
      thread: ({ threadId }) => bb.sdk.threads.get({ threadId }),
      pendingInteractions: ({ threadId }) =>
        bb.sdk.threads.interactions.list({ threadId }),
      recoverLostResponse: async ({ operationId }) => {
        const operation = database
          .prepare("SELECT * FROM pending_dispatch WHERE operation_id = ?")
          .get(operationId) as
          | {
              operation_id: string;
              thread_id: string;
              prompt: string;
              status: string;
            }
          | undefined;
        if (operation === undefined)
          throw new Error(`Unknown operation: ${operationId}`);
        if (operation.status !== "uncertain") {
          throw new Error(
            `Operation is ${operation.status}; recovery is only for uncertain sends`,
          );
        }
        const [timeline, queuedMessages] = await Promise.all([
          bb.sdk.threads.timeline({ threadId: operation.thread_id }),
          bb.sdk.threads.queuedMessages.list({ threadId: operation.thread_id }),
        ]);
        const marker = `${lostResponseMarkerKey}:${operationId}`;
        const timelineMatches =
          JSON.stringify(timeline).split(marker).length - 1;
        const queuedMatches = queuedMessages.filter((message) =>
          JSON.stringify(message.content).includes(marker),
        );
        const matches = timelineMatches + queuedMatches.length;
        if (matches !== 1) {
          return {
            status: "uncertain",
            matches,
            timelineMatches,
            queuedMatches: queuedMatches.length,
          };
        }
        const queuedMessage = queuedMatches[0];
        const delivery =
          queuedMessage === undefined
            ? "observed-in-timeline"
            : "observed-in-queue";
        database
          .prepare(
            "UPDATE pending_dispatch SET status = 'accepted', delivery = ?, queued_message_id = ? WHERE operation_id = ?",
          )
          .run(delivery, queuedMessage?.id ?? null, operationId);
        return {
          status: "accepted",
          matches,
          delivery,
          queuedMessageId: queuedMessage?.id ?? null,
        };
      },
      answerQuestion: async ({ threadId }) => {
        const pending = await bb.sdk.threads.interactions.list({ threadId });
        const interaction = pending.find(
          (candidate) => candidate.payload.kind === "user_question",
        );
        if (
          interaction === undefined ||
          interaction.payload.kind !== "user_question"
        ) {
          throw new Error(
            "The scripted provider did not create a user question",
          );
        }
        const question = interaction.payload.questions[0];
        if (question === undefined || question.options?.[0] === undefined) {
          throw new Error(
            "The scripted provider user question had no answer option",
          );
        }
        return bb.sdk.threads.interactions.resolve({
          threadId,
          interactionId: interaction.id,
          resolution: {
            kind: "user_answer",
            answers: {
              [question.id]: { selected: [question.options[0].value] },
            },
          },
        });
      },
      setDispatchGate: async ({ mode }) => {
        database
          .prepare("UPDATE dispatch_control SET mode = ? WHERE id = 1")
          .run(mode);
        if (mode === "ready") {
          await bb.experimental_hooks.recheck("message.dispatch");
        }
        return { mode };
      },
      recheckDispatch: async () => {
        await bb.experimental_hooks.recheck("message.dispatch");
        return { rechecked: true };
      },
      sendAdmissionProbe: async ({ threadId, prompt, mode }) => {
        try {
          const result = await bb.sdk.threads.send({
            threadId,
            input: [{ type: "text", text: prompt, mentions: [] }],
            mode,
          });
          return { status: "accepted", sendResponse: result };
        } catch (error) {
          return {
            status: "rejected",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      queuedMessages: ({ threadId }) =>
        bb.sdk.threads.queuedMessages.list({ threadId }),
      createQueuedMessage: ({ threadId, prompt }) =>
        bb.sdk.threads.queuedMessages.create({
          threadId,
          input: [{ type: "text", text: prompt, mentions: [] }],
        }),
    },
  );
}
