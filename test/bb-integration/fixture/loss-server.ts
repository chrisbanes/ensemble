import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pluginId = "ensemble-t1-fixture";
const delayedSendResults = new Map<string, unknown>();

interface IntentRow {
  operation_id: string;
  kind: "spawn" | "send";
  state: string;
  payload_json: string;
  project_id: string | null;
  thread_id: string | null;
  request_text: string | null;
  send_at: number | null;
  generation: number;
  current_generation: number;
  spawn_calls: number;
  send_calls: number;
  queue_release_calls: number;
  queue_delete_calls: number;
  response_dropped: number;
  late_response_count: number;
  queued_message_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  hold_reason: string | null;
}

type LossArgs = Record<string, unknown>;

function rpcSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> {
  return {
    "~standard": {
      version: 1,
      vendor: "Ensemble T3 lost-response fixture",
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

function holdUntilTomorrow(): number {
  return Date.now() + 24 * 60 * 60 * 1_000;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function intentPayload(args: LossArgs): string {
  const {
    dropCallerResponse: _dropCallerResponse,
    delayCallerResponse: _delayCallerResponse,
    dropBeforeAcceptance: _dropBeforeAcceptance,
    ...payload
  } = args;
  return JSON.stringify(canonical(payload));
}

export function registerLossServer(
  bb: BbPluginApi,
  database: ReturnType<BbPluginApi["storage"]["database"]>,
): void {
  database.exec(`CREATE TABLE IF NOT EXISTS t3_loss_intents (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    project_id TEXT,
    thread_id TEXT,
    request_text TEXT,
    send_at INTEGER,
    generation INTEGER NOT NULL DEFAULT 1,
    current_generation INTEGER NOT NULL DEFAULT 1,
    spawn_calls INTEGER NOT NULL DEFAULT 0,
    send_calls INTEGER NOT NULL DEFAULT 0,
    queue_release_calls INTEGER NOT NULL DEFAULT 0,
    queue_delete_calls INTEGER NOT NULL DEFAULT 0,
    response_dropped INTEGER NOT NULL DEFAULT 0,
    late_response_count INTEGER NOT NULL DEFAULT 0,
    queued_message_id TEXT,
    message_id TEXT,
    turn_id TEXT,
    hold_reason TEXT,
    updated_at INTEGER NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS t3_loss_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT,
    created_at INTEGER NOT NULL
  )`);

  const readIntent = (operationId: string): IntentRow | undefined =>
    database
      .prepare("SELECT * FROM t3_loss_intents WHERE operation_id = ?")
      .get(operationId) as IntentRow | undefined;

  const requireIntent = (operationId: string): IntentRow => {
    const row = readIntent(operationId);
    if (!row) throw new Error(`Unknown T3 operation ${operationId}`);
    return row;
  };

  const createIntent = (kind: IntentRow["kind"], args: LossArgs): IntentRow => {
    const operationId = requiredString(args.operationId, "operationId");
    const payload = intentPayload(args);
    const existing = readIntent(operationId);
    if (existing) {
      if (existing.kind !== kind || existing.payload_json !== payload) {
        throw new Error(`T3 operation payload conflict: ${operationId}`);
      }
      return existing;
    }
    const projectId =
      typeof args.projectId === "string" ? args.projectId : null;
    const threadId = typeof args.threadId === "string" ? args.threadId : null;
    const requestText = typeof args.text === "string" ? args.text : null;
    const sendAt = typeof args.sendAt === "number" ? args.sendAt : null;
    const generation =
      typeof args.generation === "number" ? args.generation : 1;
    database
      .prepare(
        `INSERT INTO t3_loss_intents
          (operation_id, kind, state, payload_json, project_id, thread_id,
           request_text, send_at, generation, current_generation, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        kind,
        payload,
        projectId,
        threadId,
        requestText,
        sendAt,
        generation,
        generation,
        Date.now(),
      );
    return requireIntent(operationId);
  };

  const recordEffect = (
    operationId: string,
    kind: string,
    externalId?: string,
  ): void => {
    database
      .prepare(
        "INSERT INTO t3_loss_effects (operation_id, kind, external_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(operationId, kind, externalId ?? null, Date.now());
  };

  const incrementSpawnCalls = (operationId: string): void => {
    database
      .prepare(
        "UPDATE t3_loss_intents SET spawn_calls = spawn_calls + 1, updated_at = ? WHERE operation_id = ?",
      )
      .run(Date.now(), operationId);
  };

  const incrementSendCalls = (operationId: string): void => {
    database
      .prepare(
        "UPDATE t3_loss_intents SET send_calls = send_calls + 1, updated_at = ? WHERE operation_id = ?",
      )
      .run(Date.now(), operationId);
  };

  const intentView = (row: IntentRow) => ({
    operationId: row.operation_id,
    kind: row.kind,
    state: row.state,
    projectId: row.project_id,
    threadId: row.thread_id,
    requestText: row.request_text,
    sendAt: row.send_at,
    generation: row.generation,
    currentGeneration: row.current_generation,
    spawnCalls: row.spawn_calls,
    sendCalls: row.send_calls,
    queueReleaseCalls: row.queue_release_calls,
    queueDeleteCalls: row.queue_delete_calls,
    responseDropped: row.response_dropped === 1,
    lateResponseCount: row.late_response_count,
    queuedMessageId: row.queued_message_id,
    messageId: row.message_id,
    turnId: row.turn_id,
    holdReason: row.hold_reason,
  });

  const spawnRequest = (
    args: LossArgs,
    operationId: string,
    prompt: string,
    sendAt?: number,
  ) =>
    ({
      projectId: requiredString(args.projectId, "projectId"),
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      environment: args.environment,
      prompt,
      pluginMetadata: { t3_operation_id: operationId },
      ...(sendAt === undefined ? {} : { sendAt }),
    }) as Parameters<typeof bb.sdk.threads.spawn>[0];

  const spawn = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = createIntent("spawn", args);
    if (row.state === "confirmed" || row.state === "held") {
      return { ...intentView(row), replayed: true, noBlindRetry: true };
    }
    if (row.spawn_calls > 0) {
      return { ...intentView(row), noBlindRetry: true };
    }
    if (args.dropBeforeAcceptance === true) {
      database
        .prepare(
          "UPDATE t3_loss_intents SET state = 'uncertain', response_dropped = 1, updated_at = ? WHERE operation_id = ?",
        )
        .run(Date.now(), operationId);
      throw new Error("T3_RESPONSE_DROPPED_BEFORE_ACCEPTANCE");
    }
    const prompt = requiredString(args.prompt, "prompt");
    const sendAt = typeof args.sendAt === "number" ? args.sendAt : undefined;
    incrementSpawnCalls(operationId);
    recordEffect(operationId, "spawn");
    const accepted = await bb.sdk.threads.spawn(
      spawnRequest(args, operationId, prompt, sendAt),
    );
    if (args.dropCallerResponse === true) {
      database
        .prepare(
          "UPDATE t3_loss_intents SET state = 'uncertain', response_dropped = 1, updated_at = ? WHERE operation_id = ?",
        )
        .run(Date.now(), operationId);
      throw new Error("T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE");
    }
    database
      .prepare(
        "UPDATE t3_loss_intents SET state = 'confirmed', thread_id = ?, hold_reason = NULL, updated_at = ? WHERE operation_id = ?",
      )
      .run(accepted.id, Date.now(), operationId);
    return { ...intentView(requireIntent(operationId)), replayed: false };
  };

  const prepareSpawn = (args: LossArgs) => {
    const row = createIntent("spawn", args);
    return intentView(row);
  };

  const injectMultipleSpawnMatches = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = requireIntent(operationId);
    if (row.kind !== "spawn") throw new Error("T3 operation is not a spawn");
    const savedArgs = JSON.parse(row.payload_json) as LossArgs;
    const count = Number(args.count ?? 2);
    if (count !== 2) throw new Error("T3 injects exactly two spawn matches");
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      incrementSpawnCalls(operationId);
      recordEffect(operationId, "injected-spawn-match");
      const candidate = await bb.sdk.threads.spawn(
        spawnRequest(
          savedArgs,
          operationId,
          `T3 duplicate candidate ${index + 1}`,
          holdUntilTomorrow(),
        ),
      );
      ids.push(candidate.id);
    }
    return { operationId, candidateThreadIds: ids };
  };

  const findSpawnMatches = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = requireIntent(operationId);
    if (row.kind !== "spawn" || !row.project_id) {
      throw new Error("T3 spawn intent is incomplete");
    }
    const threads = await bb.sdk.threads.list({
      projectId: row.project_id,
      originPluginId: pluginId,
      limit: 100,
    });
    const matches: Array<{
      threadId: string;
      status: string;
      metadata: unknown;
    }> = [];
    for (const thread of threads) {
      const metadata = await bb.sdk.threads.getPluginMetadata({
        threadId: thread.id,
        pluginId,
      });
      if (metadata.t3_operation_id === operationId) {
        matches.push({
          threadId: thread.id,
          status: thread.status,
          metadata,
        });
      }
    }
    return {
      operationId,
      matches,
      publicLookup: "threads.list + getPluginMetadata",
    };
  };

  const reconcileSpawn = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const { matches, publicLookup } = await findSpawnMatches(args);
    if (matches.length === 1) {
      const match = matches[0];
      if (!match) throw new Error("T3 match disappeared");
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'confirmed', thread_id = ?,
           hold_reason = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(match.threadId, Date.now(), operationId);
    } else {
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'held', hold_reason = ?,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          matches.length === 0
            ? "No matching thread; absence cannot prove a timed-out spawn will not complete"
            : `Multiple matching threads (${matches.length}); operator resolution required`,
          Date.now(),
          operationId,
        );
    }
    return {
      ...intentView(requireIntent(operationId)),
      matches,
      publicLookup,
    };
  };

  const prepareSend = (args: LossArgs) => {
    const row = createIntent("send", args);
    return intentView(row);
  };

  const send = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = createIntent("send", args);
    if (
      row.state === "confirmed" ||
      row.state === "queued" ||
      row.state === "held" ||
      row.state === "invalidated"
    ) {
      return { ...intentView(row), replayed: true, noBlindRetry: true };
    }
    if (row.send_calls > 0) {
      return { ...intentView(row), noBlindRetry: true };
    }
    const threadId = requiredString(args.threadId, "threadId");
    const text = requiredString(args.text, "text");
    incrementSendCalls(operationId);
    recordEffect(operationId, "send");
    const result = await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
      ...(typeof args.sendAt === "number" ? { sendAt: args.sendAt } : {}),
    });
    if (args.dropCallerResponse === true) {
      database
        .prepare(
          "UPDATE t3_loss_intents SET state = 'uncertain', response_dropped = 1, updated_at = ? WHERE operation_id = ?",
        )
        .run(Date.now(), operationId);
      throw new Error("T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE");
    }
    if (args.delayCallerResponse === true) {
      delayedSendResults.set(operationId, result);
      database
        .prepare(
          "UPDATE t3_loss_intents SET state = 'uncertain', updated_at = ? WHERE operation_id = ?",
        )
        .run(Date.now(), operationId);
      return { operationId, responseDelayed: true };
    }
    return applySendResult(operationId, result);
  };

  const applySendResult = (operationId: string, result: unknown) => {
    const row = requireIntent(operationId);
    const delivery =
      typeof result === "object" && result !== null && "delivery" in result
        ? String(result.delivery)
        : "unknown";
    if (
      delivery === "queued" &&
      typeof result === "object" &&
      result !== null
    ) {
      const queuedMessage = (result as { queuedMessage?: { id?: string } })
        .queuedMessage;
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'queued', queued_message_id = ?,
           hold_reason = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(queuedMessage?.id ?? null, Date.now(), operationId);
    } else if (delivery === "sent" && row.state === "pending") {
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'uncertain', hold_reason = ?,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          "Sent response does not expose a stable message identity; reconcile the public timeline",
          Date.now(),
          operationId,
        );
    }
    return { delivery, ...intentView(requireIntent(operationId)) };
  };

  const reconcileSend = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = requireIntent(operationId);
    if (row.kind !== "send" || !row.thread_id || !row.request_text) {
      throw new Error("T3 send intent is incomplete");
    }
    const [timeline, queued] = await Promise.all([
      bb.sdk.threads.timeline({ threadId: row.thread_id }),
      bb.sdk.threads.queuedMessages.list({ threadId: row.thread_id }),
    ]);
    const timelineMatches = timeline.rows.filter(
      (item) =>
        item.kind === "conversation" &&
        "role" in item &&
        item.role === "user" &&
        item.text === row.request_text,
    );
    const queueMatches = queued.filter((entry) =>
      entry.content.some(
        (content) =>
          content.type === "text" && content.text === row.request_text,
      ),
    );
    if (timelineMatches.length === 1 && queueMatches.length === 0) {
      const message = timelineMatches[0];
      if (
        message?.kind !== "conversation" ||
        !("role" in message) ||
        message.role !== "user"
      ) {
        throw new Error("T3 timeline match disappeared");
      }
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'confirmed', message_id = ?,
           turn_id = ?, queued_message_id = NULL, hold_reason = NULL,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(message.id, message.turnId, Date.now(), operationId);
    } else if (timelineMatches.length === 0 && queueMatches.length === 1) {
      const queuedMessage = queueMatches[0];
      if (!queuedMessage) throw new Error("T3 queue match disappeared");
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'queued', queued_message_id = ?,
           hold_reason = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(queuedMessage.id, Date.now(), operationId);
    } else {
      const count = timelineMatches.length + queueMatches.length;
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'held', hold_reason = ?,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          count === 0
            ? "No public message or queue match; explicit uncertain hold"
            : `Ambiguous public matches (${count}); no automatic resend`,
          Date.now(),
          operationId,
        );
    }
    return {
      ...intentView(requireIntent(operationId)),
      timelineMatches: timelineMatches.map((item) => ({
        id: item.id,
        turnId: item.turnId,
        role: "role" in item ? item.role : undefined,
        text: "text" in item ? item.text : null,
        turnRequest: "turnRequest" in item ? item.turnRequest : null,
      })),
      queueMatches: queueMatches.map((entry) => ({
        id: entry.id,
        threadId: entry.threadId,
        content: entry.content,
        waitingOn: entry.waitingOn,
      })),
      publicLookup: "threads.timeline + queuedMessages.list",
    };
  };

  const injectDuplicateQueuedSends = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = requireIntent(operationId);
    if (row.kind !== "send" || !row.thread_id || !row.request_text) {
      throw new Error("T3 send intent is incomplete");
    }
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      incrementSendCalls(operationId);
      recordEffect(operationId, "injected-duplicate-queued-send");
      const result = await bb.sdk.threads.send({
        threadId: row.thread_id,
        mode: "auto",
        sendAt: holdUntilTomorrow(),
        input: [{ type: "text", text: row.request_text, mentions: [] }],
      });
      if (result.delivery !== "queued") {
        throw new Error("T3 ambiguous send fixture did not remain queued");
      }
      ids.push(result.queuedMessage.id);
    }
    return { operationId, queuedMessageIds: ids };
  };

  const releaseQueued = async (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const row = requireIntent(operationId);
    if (row.state !== "queued" || !row.thread_id || !row.queued_message_id) {
      return {
        ...intentView(row),
        released: false,
        reason: "not uniquely queued",
      };
    }
    if (row.generation !== row.current_generation) {
      database
        .prepare(
          `UPDATE t3_loss_intents SET queue_delete_calls = queue_delete_calls + 1,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(Date.now(), operationId);
      recordEffect(
        operationId,
        "invalidate-stale-queue",
        row.queued_message_id,
      );
      const deleted = await bb.sdk.threads.queuedMessages.delete({
        threadId: row.thread_id,
        queuedMessageId: row.queued_message_id,
      });
      database
        .prepare(
          `UPDATE t3_loss_intents SET state = 'invalidated', hold_reason = ?,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          "Queued input generation is stale; public queue row deleted before provider effect",
          Date.now(),
          operationId,
        );
      return {
        ...intentView(requireIntent(operationId)),
        invalidated: deleted.ok,
      };
    }
    database
      .prepare(
        `UPDATE t3_loss_intents SET queue_release_calls = queue_release_calls + 1,
         updated_at = ? WHERE operation_id = ?`,
      )
      .run(Date.now(), operationId);
    recordEffect(operationId, "release-queued-send", row.queued_message_id);
    const result = await bb.sdk.threads.queuedMessages.send({
      threadId: row.thread_id,
      queuedMessageId: row.queued_message_id,
      mode: "auto",
    });
    return {
      ...intentView(requireIntent(operationId)),
      delivery: result.delivery,
    };
  };

  const advanceGeneration = (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const currentGeneration = Number(args.currentGeneration);
    if (!Number.isInteger(currentGeneration) || currentGeneration < 1) {
      throw new Error("currentGeneration must be a positive integer");
    }
    database
      .prepare(
        "UPDATE t3_loss_intents SET current_generation = ?, updated_at = ? WHERE operation_id = ?",
      )
      .run(currentGeneration, Date.now(), operationId);
    return intentView(requireIntent(operationId));
  };

  const releaseDelayed = (args: LossArgs) => {
    const operationId = requiredString(args.operationId, "operationId");
    const originalResult = delayedSendResults.get(operationId);
    if (originalResult === undefined) {
      throw new Error(`No delayed T3 send response for ${operationId}`);
    }
    delayedSendResults.delete(operationId);
    const row = requireIntent(operationId);
    if (
      row.state === "confirmed" ||
      row.state === "held" ||
      row.state === "invalidated"
    ) {
      database
        .prepare(
          `UPDATE t3_loss_intents SET late_response_count = late_response_count + 1,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(Date.now(), operationId);
      const lateDelivery =
        typeof originalResult === "object" &&
        originalResult !== null &&
        "delivery" in originalResult
          ? String(originalResult.delivery)
          : "unknown";
      return {
        ...intentView(requireIntent(operationId)),
        lateDelivery,
        lateResponseIgnored: true,
      };
    }
    return applySendResult(operationId, originalResult);
  };

  const anyOutput = rpcSchema(z.any());
  bb.rpc.register(
    {
      "loss.run": {
        input: rpcSchema(
          z.object({
            operation: z.enum([
              "spawn",
              "prepare-spawn",
              "inject-multiple-spawns",
              "reconcile-spawn",
              "find-spawn-matches",
              "send",
              "prepare-send",
              "inject-duplicate-queued-sends",
              "reconcile-send",
              "release-queued",
              "advance-generation",
              "release-delayed",
              "intent",
              "thread",
              "metadata",
              "timeline",
              "queue-list",
              "tool-count",
              "effects",
            ]),
            args: z.record(z.string(), z.unknown()).default({}),
          }),
        ),
        output: anyOutput,
      },
    },
    {
      "loss.run": async ({ operation, args }) => {
        const input = args as LossArgs;
        switch (operation) {
          case "spawn":
            return spawn(input);
          case "prepare-spawn":
            return prepareSpawn(input);
          case "inject-multiple-spawns":
            return injectMultipleSpawnMatches(input);
          case "reconcile-spawn":
            return reconcileSpawn(input);
          case "find-spawn-matches":
            return findSpawnMatches(input);
          case "send":
            return send(input);
          case "prepare-send":
            return prepareSend(input);
          case "inject-duplicate-queued-sends":
            return injectDuplicateQueuedSends(input);
          case "reconcile-send":
            return reconcileSend(input);
          case "release-queued":
            return releaseQueued(input);
          case "advance-generation":
            return advanceGeneration(input);
          case "release-delayed":
            return releaseDelayed(input);
          case "intent":
            return intentView(
              requireIntent(requiredString(input.operationId, "operationId")),
            );
          case "thread":
            return bb.sdk.threads.get({
              threadId: requiredString(input.threadId, "threadId"),
            });
          case "metadata":
            return bb.sdk.threads.getPluginMetadata({
              threadId: requiredString(input.threadId, "threadId"),
              pluginId,
            });
          case "timeline":
            return bb.sdk.threads.timeline({
              threadId: requiredString(input.threadId, "threadId"),
            });
          case "queue-list":
            return bb.sdk.threads.queuedMessages.list({
              threadId: requiredString(input.threadId, "threadId"),
            });
          case "tool-count":
            return database
              .prepare(
                "SELECT tool_calls AS toolCalls FROM t1_fixture_state WHERE id = 1",
              )
              .get();
          case "effects":
            return database
              .prepare(
                `SELECT operation_id AS operationId, kind, external_id AS externalId
                 FROM t3_loss_effects WHERE operation_id = ? ORDER BY id`,
              )
              .all(requiredString(input.operationId, "operationId"));
          default:
            throw new Error(`Unknown T3 loss operation: ${operation}`);
        }
      },
    },
  );
}
