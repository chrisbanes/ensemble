import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CodexRuntime,
  type RuntimeConversationEvent,
} from "../src/standalone/codex.js";

test("conflicting and identity-free terminal reports are surfaced as anomalies", async () => {
  const runtime = new CodexRuntime();
  const anomalies: string[] = [];
  runtime.onTerminalAnomaly((event) => anomalies.push(event.reason));
  const child = {} as ChildProcessWithoutNullStreams;
  (runtime as unknown as { child: ChildProcessWithoutNullStreams }).child =
    child;
  const receive = (message: unknown) =>
    (
      runtime as unknown as {
        receive(child: ChildProcessWithoutNullStreams, line: string): void;
      }
    ).receive(child, JSON.stringify(message));
  receive({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
  });
  receive({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "failed" } },
  });
  receive({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  assert.deepEqual(anomalies, [
    "Conflicting terminal status",
    "Missing terminal identity or status",
  ]);
  assert.equal(await runtime.waitForTurn("thread", "turn"), "failed");
});

test("failure evidence is exact-turn-bound and only classifies the retry allowlist", () => {
  const runtime = new CodexRuntime();
  const child = {} as ChildProcessWithoutNullStreams;
  (runtime as unknown as { child: ChildProcessWithoutNullStreams }).child =
    child;
  const receive = (
    threadId: string,
    turnId: string,
    error: unknown,
    status = "failed",
  ) =>
    (
      runtime as unknown as {
        receive(child: ChildProcessWithoutNullStreams, line: string): void;
      }
    ).receive(
      child,
      JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status, error } },
      }),
    );

  receive("thread", "overloaded", { codexErrorInfo: "serverOverloaded" });
  receive("thread", "rate-limit", { codexErrorInfo: "rateLimitExceeded" });
  receive("thread", "permanent", { codexErrorInfo: "badRequest" });
  receive("thread", "other", { codexErrorInfo: "internalServerError" });
  receive(
    "thread",
    "interrupted",
    { codexErrorInfo: "serverOverloaded" },
    "interrupted",
  );
  receive("thread", "missing", null);

  const evidence = (threadId: string, turnId: string) =>
    (
      runtime as unknown as {
        failureEvidence(threadId: string, turnId: string): unknown;
      }
    ).failureEvidence(threadId, turnId);
  assert.deepEqual(evidence("thread", "overloaded"), {
    threadId: "thread",
    turnId: "overloaded",
    status: "failed",
    classification: "transient",
    reasonCode: "serverOverloaded",
    source: "codexErrorInfo",
    codexRetries: null,
  });
  assert.equal(
    (evidence("thread", "rate-limit") as { classification: string })
      .classification,
    "transient",
  );
  assert.equal(
    (evidence("thread", "permanent") as { classification: string })
      .classification,
    "permanent",
  );
  assert.equal(
    (evidence("thread", "other") as { classification: string }).classification,
    "unknown",
  );
  assert.equal(evidence("thread", "interrupted"), undefined);
  assert.equal(
    (evidence("thread", "missing") as { classification: string })
      .classification,
    "unknown",
  );
  assert.equal(evidence("another-thread", "overloaded"), undefined);
});

test("error notifications do not settle an exact turn before its terminal", async () => {
  const runtime = new CodexRuntime();
  const child = {} as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child: ChildProcessWithoutNullStreams;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
  };
  internal.child = child;
  const receive = (message: unknown) =>
    internal.receive(child, JSON.stringify(message));

  let completedSettled = false;
  const completed = runtime
    .waitForTurn("thread-completed", "turn-completed")
    .then((status) => {
      completedSettled = true;
      return status;
    });
  try {
    assert.doesNotThrow(() =>
      receive({
        method: "error",
        params: {
          error: {
            message: "Reconnecting...2/5",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 403 },
            },
          },
          additionalDetails: "simulated provider response",
          willRetry: true,
          threadId: "thread-completed",
          turnId: "turn-completed",
        },
      }),
    );
    assert.doesNotThrow(() =>
      receive({
        method: "error",
        params: { error: { message: "malformed identity" }, willRetry: true },
      }),
    );
    receive({
      method: "turn/completed",
      params: {
        threadId: "unrelated-thread",
        turn: { id: "unrelated-turn", status: "completed" },
      },
    });
    await Promise.resolve();
    assert.equal(completedSettled, false);
    receive({
      method: "turn/completed",
      params: {
        threadId: "thread-completed",
        turn: { id: "turn-completed", status: "completed" },
      },
    });
    assert.equal(await completed, "completed");
  } finally {
    if (!completedSettled)
      receive({
        method: "turn/completed",
        params: {
          threadId: "thread-completed",
          turn: { id: "turn-completed", status: "completed" },
        },
      });
    await completed.catch(() => undefined);
  }

  let failedSettled = false;
  const failed = runtime
    .waitForTurn("thread-failed", "turn-failed")
    .then((status) => {
      failedSettled = true;
      return status;
    });
  try {
    assert.doesNotThrow(() =>
      receive({
        method: "error",
        params: {
          error: { message: "Reconnecting...1/5" },
          willRetry: true,
          threadId: "thread-failed",
          turnId: "turn-failed",
        },
      }),
    );
    await Promise.resolve();
    assert.equal(failedSettled, false);
    assert.equal(
      runtime.failureEvidence("thread-failed", "turn-failed"),
      undefined,
    );
    receive({
      method: "turn/completed",
      params: {
        threadId: "thread-failed",
        turn: {
          id: "turn-failed",
          status: "failed",
          error: { codexErrorInfo: "serverOverloaded" },
        },
      },
    });
    assert.equal(await failed, "failed");
    assert.equal(
      runtime.failureEvidence("thread-failed", "turn-failed")?.classification,
      "transient",
    );
  } finally {
    if (!failedSettled)
      receive({
        method: "turn/completed",
        params: {
          threadId: "thread-failed",
          turn: {
            id: "turn-failed",
            status: "failed",
            error: { codexErrorInfo: "serverOverloaded" },
          },
        },
      });
    await failed.catch(() => undefined);
  }
});

function bounded<T>(action: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fake App Server RPC stalled")),
      milliseconds,
    );
    action.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function captureTwoTurns(
  rootPrefix: string,
  firstTurnId: string,
  secondTurnId: string,
  firstEvents: unknown[],
  secondEvents: unknown[],
): Promise<{
  firstStatus: "completed" | "failed";
  secondStatus: "completed" | "failed";
  captured: RuntimeConversationEvent[];
}> {
  const root = mkdtempSync(join(tmpdir(), rootPrefix));
  const executable = join(root, "fake-codex.mjs");
  const source = [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    `const firstEvents = ${JSON.stringify(firstEvents)};`,
    `const secondEvents = ${JSON.stringify(secondEvents)};`,
    `const firstTurnId = ${JSON.stringify(firstTurnId)};`,
    `const secondTurnId = ${JSON.stringify(secondTurnId)};`,
    "let turnStarts = 0;",
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
    "  else if (message.method === 'account/read') write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
    "  else if (message.method === 'config/read') write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
    "  else if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } } });",
    "  else if (message.method === 'turn/start') {",
    "    const first = turnStarts++ === 0;",
    "    for (const event of first ? firstEvents : secondEvents) write(event);",
    "    const turnId = first ? firstTurnId : secondTurnId;",
    "    write({ id: message.id, result: { turn: { id: turnId } } });",
    "  }",
    "}",
  ].join("\n");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);

  const runtime = new CodexRuntime(executable);
  const captured: RuntimeConversationEvent[] = [];
  runtime.onConversationEvent?.((event) => captured.push(event));
  try {
    await bounded(runtime.start(), 3000);
    assert.equal(await bounded(runtime.startThread(root), 3000), "thread-1");
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "first"), 3000),
      firstTurnId,
    );
    const firstStatus = await bounded(
      runtime.waitForTurn("thread-1", firstTurnId),
      3000,
    );
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "second"), 3000),
      secondTurnId,
    );
    const secondStatus = await bounded(
      runtime.waitForTurn("thread-1", secondTurnId),
      3000,
    );
    return { firstStatus, secondStatus, captured };
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function itemStartedEvent(turnId: string, itemId: string) {
  return {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId,
      item: { id: itemId, type: "agentMessage" },
    },
  };
}

function turnCompletedEvent(turnId: string) {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: turnId, status: "completed" },
    },
  };
}

test("conversation capture resumes after tracked and omitted turns terminate", async () => {
  const trackedTurnIds = Array.from({ length: 16 }, (_, index) =>
    index === 0 ? "first-bound-turn" : `tracked-turn-${index + 1}`,
  );
  const overflowTurnId = "overflow-turn-17";
  const overflowItemId = "omitted-overflow-item";
  const firstEvents = [
    ...trackedTurnIds.map((turnId, index) =>
      itemStartedEvent(turnId, `tracked-item-${index + 1}`),
    ),
    itemStartedEvent(overflowTurnId, overflowItemId),
    ...trackedTurnIds.map(turnCompletedEvent),
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: overflowTurnId,
        item: {
          id: overflowItemId,
          type: "agentMessage",
          text: "OVERFLOW_TEXT_MUST_STAY_OMITTED",
        },
      },
    },
    turnCompletedEvent(overflowTurnId),
  ];
  const freshTurnId = "fresh-turn-after-drain";
  const freshItemId = "fresh-item-after-drain";
  const secondEvents = [
    itemStartedEvent(freshTurnId, freshItemId),
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: freshTurnId,
        itemId: freshItemId,
        delta: "fresh",
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: freshTurnId,
        item: {
          id: freshItemId,
          type: "agentMessage",
          text: "FRESH_BOUND_TURN_COMPLETED",
        },
      },
    },
    turnCompletedEvent(freshTurnId),
  ];

  const result = await captureTwoTurns(
    "ensemble-codex-history-drain-",
    trackedTurnIds[0] ?? "missing-bound-turn",
    freshTurnId,
    firstEvents,
    secondEvents,
  );

  assert.equal(result.firstStatus, "completed");
  assert.equal(result.secondStatus, "completed");
  assert.deepEqual(
    result.captured.filter((event) => event.turnId === overflowTurnId),
    [
      {
        threadId: "thread-1",
        turnId: overflowTurnId,
        itemId: overflowItemId,
        kind: "omitted",
        reason: "active-turn-limit",
      },
    ],
  );
  assert.deepEqual(
    result.captured.filter((event) => event.turnId === freshTurnId),
    [
      {
        threadId: "thread-1",
        turnId: freshTurnId,
        itemId: freshItemId,
        kind: "started",
      },
      {
        threadId: "thread-1",
        turnId: freshTurnId,
        itemId: freshItemId,
        kind: "delta",
        bytes: 5,
      },
      {
        threadId: "thread-1",
        turnId: freshTurnId,
        itemId: freshItemId,
        kind: "completed",
        text: "FRESH_BOUND_TURN_COMPLETED",
      },
    ],
  );
  assert.equal(
    JSON.stringify(result.captured).includes("OVERFLOW_TEXT_MUST_STAY_OMITTED"),
    false,
  );
});

test("capture remains bounded and fails closed after overflow identity cap", async () => {
  const trackedTurnIds = Array.from({ length: 16 }, (_, index) =>
    index === 0 ? "first-bound-turn" : `tracked-turn-${index + 1}`,
  );
  const overflowTurnIds = Array.from(
    { length: 17 },
    (_, index) => `overflow-turn-${index + 17}`,
  );
  const firstEvents = [
    ...trackedTurnIds.map((turnId, index) =>
      itemStartedEvent(turnId, `tracked-item-${index + 1}`),
    ),
    ...overflowTurnIds.map((turnId, index) =>
      itemStartedEvent(turnId, `overflow-item-${index + 1}`),
    ),
    ...trackedTurnIds.map(turnCompletedEvent),
    ...overflowTurnIds.map(turnCompletedEvent),
  ];
  const freshTurnId = "fresh-turn-after-overflow-cap";
  const freshItemId = "fresh-item-after-overflow-cap";
  const secondEvents = [
    itemStartedEvent(freshTurnId, freshItemId),
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: freshTurnId,
        item: {
          id: freshItemId,
          type: "agentMessage",
          text: "MUST_REMAIN_FAIL_CLOSED",
        },
      },
    },
    turnCompletedEvent(freshTurnId),
  ];

  const result = await captureTwoTurns(
    "ensemble-codex-history-overflow-cap-",
    trackedTurnIds[0] ?? "missing-bound-turn",
    freshTurnId,
    firstEvents,
    secondEvents,
  );

  assert.equal(result.firstStatus, "completed");
  assert.equal(result.secondStatus, "completed");
  assert.equal(
    result.captured.filter(
      (event) =>
        event.kind === "omitted" && event.reason === "active-turn-limit",
    ).length,
    1,
  );
  assert.equal(
    result.captured.some((event) => event.turnId === freshTurnId),
    false,
  );
  assert.equal(
    JSON.stringify(result.captured).includes("MUST_REMAIN_FAIL_CLOSED"),
    false,
  );
});

test("App Server projects only complete bounded agent-message history", {
  timeout: 12000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-history-"));
  const executable = join(root, "fake-codex.mjs");
  const message = "The bounded answer.";
  const tooLong = "x".repeat(64 * 1024 + 1);
  const emptyDeltas = 5000;
  const fragmentDeltas = 4097;
  const events: unknown[] = [
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "message-1",
          type: "agentMessage",
          text: "",
          privateInstruction: "NEVER-EXPOSE-THIS",
        },
        workspacePath: "/private/workspace",
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "The bounded ",
        credential: "NEVER-EXPOSE-THIS",
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "answer.",
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "message-1",
          type: "agentMessage",
          text: message,
          phase: "final_answer",
          command: "NEVER-EXPOSE-THIS",
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message-1", type: "agentMessage", text: message },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "empty-delta-1", type: "agentMessage" },
      },
    },
    ...Array.from({ length: emptyDeltas }, () => ({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "empty-delta-1",
        delta: "",
      },
    })),
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "empty-delta-1", type: "agentMessage" },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "fragmented-1", type: "agentMessage" },
      },
    },
    ...Array.from({ length: fragmentDeltas }, () => ({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "fragmented-1",
        delta: "x",
      },
    })),
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "fragmented-1", type: "agentMessage" },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning", text: "PRIVATE" },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "tool-1", type: "commandExecution", command: "PRIVATE" },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        delta: "UNBOUND-DELTA",
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: { id: "malformed-1", type: "agentMessage" },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "large-1", type: "agentMessage" },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "large-1",
        delta: tooLong,
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "large-1", type: "agentMessage", text: tooLong },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "unfinished-1", type: "agentMessage" },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "unfinished-1",
        delta: "PARTIAL-MUST-NOT-ESCAPE",
      },
    },
    ...Array.from({ length: 65 }, (_, index) => ({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: `pending-${index}`, type: "agentMessage" },
      },
    })),
    {
      method: "account/updated",
      params: { token: "NEVER-EXPOSE-THIS" },
    },
    ...Array.from({ length: 17 }, (_, index) => ({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: `unbound-turn-${index + 2}`,
        item: { id: `unbound-item-${index}`, type: "agentMessage" },
      },
    })),
    {
      method: "item/started",
      params: {
        threadId: "t".repeat(257),
        turnId: "turn-1",
        item: { id: "too-long-identity", type: "agentMessage" },
      },
    },
  ];
  const source = [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    `const events = ${JSON.stringify(events)};`,
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
    "  else if (message.method === 'account/read') write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
    "  else if (message.method === 'config/read') write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
    "  else if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } } });",
    "  else if (message.method === 'turn/start') {",
    "    for (const event of events) write(event);",
    "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
    "    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
    "  }",
    "}",
  ].join("\n");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const captured: RuntimeConversationEvent[] = [];
  let listenerFailures = 0;
  runtime.onConversationEvent?.((event) => {
    captured.push(event);
    if (event.kind === "omitted" && event.itemId === "large-1") {
      listenerFailures += 1;
      throw new Error("diagnostic history sink failed");
    }
  });
  try {
    await bounded(runtime.start(), 3000);
    assert.equal(await bounded(runtime.startThread(root), 3000), "thread-1");
    const turnId = await bounded(
      runtime.startTurn("thread-1", root, "test"),
      3000,
    );
    assert.equal(turnId, "turn-1");
    assert.equal(
      await bounded(runtime.waitForTurn("thread-1", turnId), 3000),
      "completed",
    );
    assert.deepEqual(captured[0], {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      kind: "started",
    });
    assert.deepEqual(
      captured.find((event) => event.kind === "completed"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        kind: "completed",
        text: message,
      },
    );
    const deltas = captured.filter((event) => event.kind === "delta");
    assert.equal(deltas.length, 3 + 4096);
    assert.equal(
      deltas.filter((event) => event.itemId === "empty-delta-1").length,
      0,
    );
    assert.equal(
      deltas.filter((event) => event.itemId === "fragmented-1").length,
      4096,
    );
    assert.equal(
      captured.filter((event) => event.kind === "started").length,
      83,
    );
    const omissions = captured.filter(
      (
        event,
      ): event is Extract<RuntimeConversationEvent, { kind: "omitted" }> =>
        event.kind === "omitted",
    );
    assert.equal(omissions.length, 69);
    assert.equal(
      captured.some(
        (event) =>
          event.kind === "completed" && event.itemId === "empty-delta-1",
      ),
      false,
    );
    assert.deepEqual(
      omissions.find((event) => event.itemId === "empty-delta-1"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "empty-delta-1",
        kind: "omitted",
        reason: "missing-text",
      },
    );
    assert.deepEqual(
      omissions.find((event) => event.itemId === "fragmented-1"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "fragmented-1",
        kind: "omitted",
        reason: "size-limit",
      },
    );
    assert.deepEqual(
      omissions.find((event) => event.itemId === "large-1"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "large-1",
        kind: "omitted",
        reason: "size-limit",
      },
    );
    assert.deepEqual(
      omissions.find((event) => event.itemId === "unfinished-1"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "unfinished-1",
        kind: "omitted",
        reason: "item-limit",
      },
    );
    assert.deepEqual(
      omissions.find((event) => event.itemId === "pending-63"),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "pending-63",
        kind: "omitted",
        reason: "item-limit",
      },
    );
    assert.equal(
      omissions.some((event) => event.itemId === "pending-64"),
      false,
    );
    assert.equal(
      omissions.filter((event) => event.reason === "active-turn-limit").length,
      1,
    );
    assert.deepEqual(
      omissions.find((event) => event.reason === "active-turn-limit"),
      {
        threadId: "thread-1",
        turnId: "unbound-turn-17",
        itemId: "unbound-item-15",
        kind: "omitted",
        reason: "active-turn-limit",
      },
    );
    assert.equal(listenerFailures, 1);
    assert.equal(JSON.stringify(captured).includes("NEVER-EXPOSE-THIS"), false);
    assert.equal(
      JSON.stringify(captured).includes("/private/workspace"),
      false,
    );
    assert.equal(
      JSON.stringify(captured).includes("PARTIAL-MUST-NOT-ESCAPE"),
      false,
    );
    assert.equal(JSON.stringify(captured).includes(tooLong), false);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation projection bounds completed items and ignores post-terminal replay", {
  timeout: 12000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-history-bound-"));
  const executable = join(root, "fake-codex.mjs");
  const events: unknown[] = [
    ...Array.from({ length: 258 }, (_, index) => ({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: `message-${index}`,
          type: "agentMessage",
          text: `message-${index}`,
          privateInstruction: "NEVER-EXPOSE-THIS",
        },
      },
    })),
    ...Array.from({ length: 17 }, (_, index) => ({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: `unbound-${index + 2}`,
        item: { id: `unbound-item-${index}`, type: "agentMessage" },
      },
    })),
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message-0", type: "agentMessage", text: "message-0" },
      },
    },
  ];
  const source = [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    `const events = ${JSON.stringify(events)};`,
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
    "  else if (message.method === 'account/read') write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
    "  else if (message.method === 'config/read') write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
    "  else if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } } });",
    "  else if (message.method === 'turn/start') {",
    "    for (const event of events) write(event);",
    "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
    "  }",
    "}",
  ].join("\n");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const captured: RuntimeConversationEvent[] = [];
  runtime.onConversationEvent?.((event) => captured.push(event));
  try {
    await bounded(runtime.start(), 3000);
    await bounded(runtime.startThread(root), 3000);
    const turnId = await bounded(
      runtime.startTurn("thread-1", root, "test"),
      3000,
    );
    assert.equal(turnId, "turn-1");
    assert.equal(
      await bounded(runtime.waitForTurn("thread-1", turnId), 3000),
      "completed",
    );
    assert.equal(
      captured.filter((event) => event.kind === "completed").length,
      256,
    );
    assert.equal(
      captured.filter(
        (event) => event.kind === "completed" && event.itemId === "message-0",
      ).length,
      1,
    );
    assert.deepEqual(
      captured.find(
        (event) => event.kind === "omitted" && event.itemId === "message-256",
      ),
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-256",
        kind: "omitted",
        reason: "item-limit",
      },
    );
    assert.equal(
      captured.filter(
        (event) =>
          event.kind === "omitted" && event.reason === "active-turn-limit",
      ).length,
      1,
    );
    assert.equal(JSON.stringify(captured).includes("NEVER-EXPOSE-THIS"), false);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("large discarded stderr cannot stall App Server initialization or RPC", {
  timeout: 12000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-pipe-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({input: process.stdin});
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  // More than a typical OS pipe can buffer. Reply only after stderr drains.
  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 88), () => {
    let result = {};
    if (message.method === "account/read") result = {account: {type: "chatgpt"}};
    if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
    if (message.method === "thread/start") result = {thread: {id: "thread-1"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
    if (message.method === "turn/start") result = {turn: {id: "turn-1"}};
    process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
    if (message.method === "turn/start") process.stdout.write(JSON.stringify({method: "turn/completed", params: {threadId: "thread-1", turn: {id: "turn-1", status: "completed"}}}) + "\n");
  });
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const started = runtime.start();
  try {
    await bounded(started, 5000);
    assert.equal(await bounded(runtime.startThread(root), 5000), "thread-1");
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "test"), 5000),
      "turn-1",
    );
    assert.equal(
      await bounded(runtime.waitForTurn("thread-1", "turn-1"), 5000),
      "completed",
    );
  } finally {
    await runtime.stop();
    await Promise.allSettled([started]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn interrupt uses the bound App Server identities and validates its response", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-interrupt-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "account/read") {
    process.stdout.write(JSON.stringify({id: message.id, result: {account: {type: "chatgpt"}}}) + "\n");
    continue;
  }
  if (message.method === "config/read") {
    process.stdout.write(JSON.stringify({id: message.id, result: {config: {approval_policy: "never", sandbox_mode: "workspace-write"}}}) + "\n");
    continue;
  }
  if (message.method === "turn/interrupt" && (message.params.threadId !== "thread-7" || message.params.turnId !== "turn-9")) {
    process.stdout.write(JSON.stringify({id: message.id, error: {message: "Unexpected interrupt identity"}}) + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify({id: message.id, result: {}}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  try {
    await bounded(runtime.start(), 3000);
    await bounded(
      (
        runtime as unknown as {
          interruptTurn(threadId: string, turnId: string): Promise<void>;
        }
      ).interruptTurn("thread-7", "turn-9"),
      3000,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdin closure during initialization rejects promptly", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-init-pipe-"));
  const executable = join(root, "fake-codex.sh");
  writeFileSync(
    executable,
    `#!/bin/sh
IFS= read -r request
exec 0<&-
printf '{"id":1,"result":{}}\\n'
exec sleep 10
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  try {
    await assert.rejects(
      bounded(runtime.start(), 3000),
      /stdin closed|EPIPE|Runtime stopped/,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("late events from a stopped child cannot fail a restarted runtime", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-restart-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result = {};
  if (message.method === "account/read") result = {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
  if (message.method === "thread/start") result = {thread: {id: "new-thread"}, approvalPolicy: "never", sandbox: {type: "workspaceWrite"}};
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const processRef = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
  };
  let stopping: Promise<void> | undefined;
  try {
    await bounded(runtime.start(), 3000);
    const old = processRef.child;
    assert.ok(old);
    stopping = runtime.stop();
    await bounded(runtime.start(), 3000);
    old.stdout.emit("data", Buffer.from("invalid old message\n"));
    old.kill("SIGKILL");
    await bounded(stopping, 3000);
    old.stdin.emit("error", new Error("late old stdin error"));
    assert.equal(await bounded(runtime.startThread(root), 3000), "new-thread");
    const pending = runtime.startThread(root);
    const current = processRef.child;
    assert.ok(current);
    current.stdin.emit("close");
    await assert.rejects(bounded(pending, 1000), /stdin closed/);
  } finally {
    processRef.child?.kill("SIGKILL");
    await runtime.stop();
    if (stopping) await Promise.allSettled([stopping]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic tool registration is passed to thread/start", async () => {
  const runtime = new CodexRuntime();
  const request = runtime as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
    startThread(workspace: string, tools: unknown[]): Promise<string>;
  };
  let observed: unknown;
  request.request = async (method, params) => {
    assert.equal(method, "thread/start");
    observed = params;
    return {
      thread: { id: "thread-1" },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
    };
  };
  const tools = [
    {
      type: "function",
      name: "test_tool",
      description: "A test-only dynamic tool.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  assert.equal(await request.startThread("/tmp/workspace", tools), "thread-1");
  assert.deepEqual(observed, {
    cwd: "/tmp/workspace",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
    dynamicTools: tools,
  });
});

test("App Server dynamic callbacks use the registered function and server identity", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-tool-call-"));
  const executable = join(root, "fake-codex.mjs");
  const reportPath = join(root, "report.json");
  const source = [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    "import { writeFile } from 'node:fs/promises';",
    `const reportPath = ${JSON.stringify(reportPath)};`,
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') {",
    "    if (message.params.capabilities?.experimentalApi !== true) {",
    "      write({ id: message.id, error: { message: 'experimental API missing' } });",
    "    } else write({ id: message.id, result: {} });",
    "  } else if (message.method === 'account/read') {",
    "    write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
    "  } else if (message.method === 'config/read') {",
    "    write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
    "  } else if (message.method === 'thread/start') {",
    "    const tool = message.params.dynamicTools?.find((item) => item.name === 'test_tool');",
    "    if (!tool) { write({ id: message.id, error: { message: 'tool missing' } }); continue; }",
    "    await writeFile(reportPath, JSON.stringify({ experimentalApi: true, tool }));",
    "    write({ id: message.id, result: { thread: { id: 'thread-1' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } } });",
    "    write({ id: 700, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'test_tool', arguments: { value: 'payload' } } });",
    "  } else if (message.id === 700) {",
    "    const accepted = message.result?.success === true && message.result?.contentItems?.[0]?.text === 'accepted';",
    "    await writeFile(reportPath, JSON.stringify({ ...(JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'))), response: message.result }));",
    "    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: accepted ? 'completed' : 'failed' } } });",
    "  }",
    "}",
  ].join("\n");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  const runtime = new CodexRuntime(executable);
  const calls: unknown[] = [];
  runtime.onToolCall?.(async (call) => {
    calls.push(call);
    return { text: "accepted", success: true };
  });
  const tools = [
    {
      type: "function" as const,
      name: "test_tool",
      description: "A test-only dynamic tool.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ];
  try {
    await bounded(runtime.start(), 3000);
    const threadId = await bounded(runtime.startThread(root, tools), 3000);
    const turnId = await bounded(
      (async () => {
        for (let i = 0; i < 100; i++) {
          if (calls.length > 0) return "turn-1";
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("dynamic tool callback was not dispatched");
      })(),
      2000,
    );
    assert.equal(threadId, "thread-1");
    assert.equal(
      await bounded(runtime.waitForTurn(threadId, turnId), 2000),
      "completed",
    );
    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "test_tool",
        arguments: { value: "payload" },
      },
    ]);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      experimentalApi: boolean;
      tool: unknown;
      response: unknown;
    };
    assert.equal(report.experimentalApi, true);
    assert.deepEqual(report.tool, tools[0]);
    assert.deepEqual(report.response, {
      contentItems: [{ type: "inputText", text: "accepted" }],
      success: true,
    });
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unregistered and malformed callbacks fail closed while approvals stay denied", async () => {
  const runtime = new CodexRuntime();
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {},
  } as unknown as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    send(line: string): Promise<void>;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
    threadTools: Map<string, readonly { name: string }[]>;
  };
  internal.child = child;
  internal.threadTools.set("thread-1", [{ name: "test_tool" }]);
  const responses: unknown[] = [];
  const unexpected: unknown[] = [];
  internal.send = async (line) => {
    responses.push(JSON.parse(line));
  };
  runtime.onUnexpectedRequest((request) => unexpected.push(request));
  runtime.onToolCall?.(async () => ({ text: "should not run", success: true }));
  internal.receive(
    child,
    JSON.stringify({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "unknown",
        tool: "unregistered",
        arguments: {},
      },
    }),
  );
  internal.receive(
    child,
    JSON.stringify({
      id: 2,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "test_tool",
        arguments: [],
      },
    }),
  );
  internal.receive(
    child,
    JSON.stringify({
      id: 3,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unexpected.length, 3);
  assert.deepEqual(responses, [
    {
      id: 1,
      result: {
        contentItems: [{ type: "inputText", text: "not authorized" }],
        success: false,
      },
    },
    {
      id: 2,
      result: {
        contentItems: [{ type: "inputText", text: "not authorized" }],
        success: false,
      },
    },
    { id: 3, result: { decision: "cancel" } },
  ]);
});

test("handler rejection is bounded and response-pipe failure fails the runtime", async () => {
  const runtime = new CodexRuntime();
  let kills = 0;
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {
      kills++;
    },
  } as unknown as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    send(line: string): Promise<void>;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
    threadTools: Map<string, readonly { name: string }[]>;
  };
  internal.child = child;
  internal.threadTools.set("thread-1", [{ name: "test_tool" }]);
  const responses: unknown[] = [];
  internal.send = async (line) => {
    responses.push(JSON.parse(line));
  };
  runtime.onToolCall?.(async () => {
    throw new Error("private implementation detail");
  });
  internal.receive(
    child,
    JSON.stringify({
      id: 4,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-4",
        tool: "test_tool",
        arguments: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses, [
    {
      id: 4,
      result: {
        contentItems: [{ type: "inputText", text: "request failed" }],
        success: false,
      },
    },
  ]);

  internal.send = async () => {
    throw new Error("response pipe failed");
  };
  internal.receive(
    child,
    JSON.stringify({
      id: 5,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-5",
        tool: "test_tool",
        arguments: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
});

import { deliveryRuntimeEnvironment } from "../src/standalone/delivery.js";
test("delivery spawn snapshot excludes configured key and exact-value aliases while retaining login environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-delivery-spawn-")),
    executable = join(root, "codex.mjs"),
    report = join(root, "report.json");
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport{createInterface}from'node:readline';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(report)},JSON.stringify({keyAbsent:process.env.ENSEMBLE_S07A_DELIVERY_SENTINEL===undefined,aliasAbsent:process.env.S07A_ALIAS===undefined,pathPresent:Boolean(process.env.PATH),homePresent:Boolean(process.env.HOME)}));for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id!==undefined){let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{approval_policy:'never',sandbox_mode:'workspace-write'}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}}`,
  );
  chmodSync(executable, 0o700);
  const environment = {
    ...process.env,
    ENSEMBLE_S07A_DELIVERY_SENTINEL: "S07A_NON_SECRET_TEST_MARKER",
    S07A_ALIAS: "S07A_NON_SECRET_TEST_MARKER",
  };
  const runtime = new CodexRuntime(executable, {
    spawnEnvironment: () =>
      deliveryRuntimeEnvironment(environment, [
        {
          version: 2,
          mode: "reviewable-pr",
          credentialRef: "env:ENSEMBLE_S07A_DELIVERY_SENTINEL",
          grants: [],
          requiredChecks: [],
        },
      ]),
  });
  try {
    await runtime.start();
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
      keyAbsent: true,
      aliasAbsent: true,
      pathPresent: true,
      homePresent: true,
    });
    assert.equal(
      environment.ENSEMBLE_S07A_DELIVERY_SENTINEL,
      "S07A_NON_SECRET_TEST_MARKER",
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
