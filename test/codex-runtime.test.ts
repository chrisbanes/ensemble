import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { structuredAnswerDigest } from "../src/core/structured-questions.js";
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
import { mock, test } from "node:test";
import {
  CodexRuntime,
  type RuntimeConversationEvent,
} from "../src/standalone/codex.js";
import {
  closeRuntimeSafetyFixtures,
  persistRuntimeOutcome,
  persistRuntimeQuestion,
  runtimeSafetyFixture,
} from "./fixtures/runtime-safety.js";

type TestRuntimeOptions = Omit<
  NonNullable<ConstructorParameters<typeof CodexRuntime>[1]>,
  "safety"
>;
type TestRuntimeSafety = ReturnType<typeof runtimeSafetyFixture>["safety"];
type TerminalRecord = {
  input: Parameters<TestRuntimeSafety["recordTerminal"]>[0];
  result: ReturnType<TestRuntimeSafety["recordTerminal"]>;
};
const runtimeFixtures = new WeakMap<
  CodexRuntime,
  {
    fixture: ReturnType<typeof runtimeSafetyFixture>;
    safetyPort: TestRuntimeSafety;
    bindTurn: (threadId: string, turnId: string, generation: string) => string;
    terminalRecords: () => TerminalRecord[];
  }
>();

function newTestRuntime(
  executable?: string,
  options: TestRuntimeOptions = {},
): CodexRuntime {
  const fixture = runtimeSafetyFixture();
  const terminalRecords: TerminalRecord[] = [];
  const safety = {
    ...fixture.safety,
    recordTerminal: (
      input: Parameters<typeof fixture.safety.recordTerminal>[0],
    ) => {
      const result = fixture.safety.recordTerminal(input);
      terminalRecords.push({ input, result });
      return result;
    },
  };
  const runtime = new CodexRuntime(executable, {
    ...options,
    safety,
  });
  const onUserInputRequest = runtime.onUserInputRequest.bind(runtime);
  runtime.onUserInputRequest = (listener) =>
    onUserInputRequest((request) => {
      persistRuntimeQuestion(fixture, request);
      listener(request);
    });
  const onUserInputOutcome = runtime.onUserInputOutcome.bind(runtime);
  runtime.onUserInputOutcome = (listener) =>
    onUserInputOutcome((outcome) => {
      persistRuntimeOutcome(fixture, outcome);
      listener(outcome);
    });
  const replyUserInput = runtime.replyUserInput.bind(runtime);
  runtime.replyUserInput = (identity, reply, beforeWrite) =>
    replyUserInput(identity, reply, () => {
      beforeWrite();
      const question = fixture.coordination.runtimeQuestionByEndpoint(identity);
      if (!question) throw new Error("Runtime test question was not persisted");
      if (!question.answers)
        fixture.coordination.answerRuntimeQuestion({
          actor: "operator",
          key: randomUUID(),
          taskId: question.taskId,
          interactionId: question.interactionId,
          expectedRevision: question.revision,
          answers: reply.answers,
        });
      return fixture.coordination.beginRuntimeReply(
        question.interactionId,
        identity,
      );
    });
  const boundTurns = new Set<string>();
  const bindTurn = (threadId: string, turnId: string, generation: string) => {
    const key = `${threadId}\u0000${turnId}`;
    if (boundTurns.has(key)) return "already-bound";
    const workId = fixture.bindTurn(threadId, turnId, generation);
    boundTurns.add(key);
    return workId;
  };
  runtimeFixtures.set(runtime, {
    fixture,
    safetyPort: safety,
    bindTurn,
    terminalRecords: () => terminalRecords.map((entry) => ({ ...entry })),
  });
  // Direct receive tests model the current owned child without spawning it.
  (runtime as unknown as { nativeGeneration: string }).nativeGeneration =
    "runtime-test-generation";
  const startTurn = runtime.startTurn.bind(runtime);
  runtime.startTurn = async (threadId, workspace, prompt) => {
    const turnId = await startTurn(threadId, workspace, prompt);
    const generation = (runtime as unknown as { nativeGeneration?: string })
      .nativeGeneration;
    if (!generation) throw new Error("Runtime test generation unavailable");
    bindTurn(threadId, turnId, generation);
    return turnId;
  };
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    nativeGeneration?: string;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
  };
  const receive = internal.receive.bind(runtime);
  internal.receive = (child, line) => {
    if (child === internal.child && internal.nativeGeneration) {
      try {
        const message = JSON.parse(line) as {
          method?: string;
          params?: { threadId?: unknown; turnId?: unknown };
        };
        if (
          message.method === "item/tool/requestUserInput" &&
          typeof message.params?.threadId === "string" &&
          typeof message.params.turnId === "string"
        )
          bindTurn(
            message.params.threadId,
            message.params.turnId,
            internal.nativeGeneration,
          );
      } catch {
        // Let the production parser report malformed test input.
      }
    }
    receive(child, line);
  };
  return runtime;
}

function bindTestTurn(runtime: CodexRuntime, threadId: string, turnId: string) {
  const generation = (runtime as unknown as { nativeGeneration?: string })
    .nativeGeneration;
  if (!generation) throw new Error("Runtime test generation unavailable");
  const fixture = runtimeFixtures.get(runtime);
  if (!fixture) throw new Error("Runtime test safety fixture unavailable");
  return fixture.bindTurn(threadId, turnId, generation);
}

test.after(closeRuntimeSafetyFixtures);

test("conflicting and identity-free terminal reports are surfaced as anomalies", async () => {
  const runtime = newTestRuntime();
  bindTestTurn(runtime, "thread", "turn");
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
  await assert.rejects(runtime.waitForTurn("thread", "turn"), /uncertain/);
  bindTestTurn(runtime, "thread", "pending");
  const pending = runtime.waitForTurn("thread", "pending");
  receive({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  assert.deepEqual(anomalies, [
    "Conflicting terminal status",
    "Terminal evidence is incomplete or conflicting",
    "Missing terminal identity or status",
  ]);
  // Without a terminal identity no waiting turn can settle, so the runtime fails.
  await assert.rejects(bounded(pending, 1000), /terminal evidence unavailable/);
});

test("failure evidence is exact-turn-bound and only classifies the retry allowlist", () => {
  const runtime = newTestRuntime();
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

  for (const turnId of [
    "overloaded",
    "rate-limit",
    "permanent",
    "other",
    "interrupted",
    "missing",
  ])
    bindTestTurn(runtime, "thread", turnId);

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
  assert.equal(
    (evidence("thread", "interrupted") as { classification: string })
      .classification,
    "unknown",
    "non-failed terminal labels cannot inherit transient retry classification",
  );
  assert.equal(
    (evidence("thread", "missing") as { classification: string })
      .classification,
    "unknown",
  );
  assert.equal(evidence("another-thread", "overloaded"), undefined);
});

test("a bound turn wait has no fixed deadline and still resolves on its terminal", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const runtime = newTestRuntime();
  bindTestTurn(runtime, "thread-long", "turn-long");
  const child = {} as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child: ChildProcessWithoutNullStreams;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
  };
  internal.child = child;

  let settled = false;
  const wait = runtime.waitForTurn("thread-long", "turn-long").then(
    (status) => {
      settled = true;
      return status;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  mock.timers.tick(181_000);
  await Promise.resolve();
  assert.equal(settled, false);
  internal.receive(
    child,
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-long",
        turn: { id: "turn-long", status: "completed" },
      },
    }),
  );
  assert.equal(await wait, "completed");
});

test("a runtime failure rejects a pending turn wait", async () => {
  const runtime = newTestRuntime();
  bindTestTurn(runtime, "thread-lost", "turn-lost");
  const wait = runtime.waitForTurn("thread-lost", "turn-lost");
  (runtime as unknown as { fail(error: Error): void }).fail(
    new Error("Runtime lost"),
  );
  await assert.rejects(wait, /Runtime lost/);
});

test("error notifications do not settle an exact turn before its terminal", async () => {
  const runtime = newTestRuntime();
  bindTestTurn(runtime, "thread-completed", "turn-completed");
  bindTestTurn(runtime, "thread-failed", "turn-failed");
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

  const runtime = newTestRuntime(executable);
  const captured: RuntimeConversationEvent[] = [];
  const anomalies: unknown[] = [];
  let stage = "runtime-start";
  runtime.onConversationEvent?.((event) => captured.push(event));
  runtime.onTerminalAnomaly((anomaly) => anomalies.push(anomaly));
  try {
    await bounded(runtime.start(), 3000);
    stage = "thread-start";
    assert.equal(await bounded(runtime.startThread(root), 3000), "thread-1");
    stage = "first-turn-start";
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "first"), 3000),
      firstTurnId,
    );
    stage = "first-turn-wait";
    const firstStatus = await bounded(
      runtime.waitForTurn("thread-1", firstTurnId),
      3000,
    );
    stage = "second-turn-start";
    assert.equal(
      await bounded(runtime.startTurn("thread-1", root, "second"), 3000),
      secondTurnId,
    );
    stage = "second-turn-wait";
    const secondStatus = await bounded(
      runtime.waitForTurn("thread-1", secondTurnId),
      3000,
    );
    return { firstStatus, secondStatus, captured };
  } catch (error) {
    const records = runtimeFixtures.get(runtime)?.terminalRecords() ?? [];
    throw new Error(
      `conversation fixture failed at ${stage}; terminalRecords=${JSON.stringify(records)}; anomalies=${JSON.stringify(anomalies)}`,
      { cause: error },
    );
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
  const runtime = newTestRuntime(executable);
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
  const runtime = newTestRuntime(executable);
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
  const runtime = newTestRuntime(executable);
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
  const runtime = newTestRuntime(executable);
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
  const runtime = newTestRuntime(executable);
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
  const runtime = newTestRuntime(executable);
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

test("stdout closure while the App Server lives fails a pending turn wait", {
  timeout: 7000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-stdout-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result = {};
  if (message.method === "account/read") result = {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: "never", sandbox_mode: "workspace-write"}};
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const runtime = newTestRuntime(executable);
  try {
    await bounded(runtime.start(), 3000);
    const child = (
      runtime as unknown as { child?: ChildProcessWithoutNullStreams }
    ).child;
    assert.ok(child);
    bindTestTurn(runtime, "thread-1", "turn-1");
    const waiting = runtime.waitForTurn("thread-1", "turn-1");
    child.stdout.emit("close");
    await assert.rejects(bounded(waiting, 1000), /stdout closed/);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic tool registration is passed to thread/start", async () => {
  const runtime = newTestRuntime();
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
  const runtime = newTestRuntime(executable);
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
    bindTestTurn(runtime, threadId, turnId);
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
  const runtime = newTestRuntime();
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {},
  } as unknown as ChildProcessWithoutNullStreams;
  const internal = runtime as unknown as {
    child?: ChildProcessWithoutNullStreams;
    send(line: string): Promise<void>;
    receive(child: ChildProcessWithoutNullStreams, line: string): void;
    threadSnapshots: Map<string, { tools?: readonly { name: string }[] }>;
  };
  internal.child = child;
  internal.threadSnapshots.set("thread-1", {
    tools: [{ name: "test_tool" }],
  });
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
  const runtime = newTestRuntime();
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
    threadSnapshots: Map<string, { tools?: readonly { name: string }[] }>;
  };
  internal.child = child;
  internal.threadSnapshots.set("thread-1", {
    tools: [{ name: "test_tool" }],
  });
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
  const runtime = newTestRuntime(executable, {
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

test("qualified native runtime waits for one exact reply and confirms only its ordered receipt", async () => {
  const runtime = newTestRuntime(
    join(process.cwd(), "test/ui01/native-runtime-fixture.mjs"),
    {
      qualifiedExecutableHash: createHash("sha256")
        .update(
          readFileSync(
            join(process.cwd(), "test/ui01/native-runtime-fixture.mjs"),
          ),
        )
        .digest("hex"),
    },
  );
  const received: import("../src/standalone/native-input.js").RuntimeUserInputRequest[] =
    [];
  const outcomes: import("../src/standalone/native-input.js").RuntimeUserInputOutcome[] =
    [];
  let notify!: () => void;
  const waiting = new Promise<void>((resolve) => {
    notify = resolve;
  });
  runtime.onUserInputRequest((request) => {
    received.push(request);
    notify();
  });
  runtime.onUserInputOutcome((outcome) => outcomes.push(outcome));
  await runtime.start();
  try {
    const threadId = await runtime.startThread(process.cwd());
    const turnId = await runtime.startTurn(threadId, process.cwd(), "fixture");
    await waiting;
    assert.equal(outcomes.length, 0);
    const request = received[0];
    assert.ok(request);
    const identity = request.identity;
    await assert.rejects(
      runtime.replyUserInput(
        { ...identity, requestId: 1 },
        { answers: { q: { answers: ["Local"] } } },
        () => ({
          replyIntentId: "intent",
          answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
        }),
      ),
    );
    await runtime.replyUserInput(
      identity,
      { answers: { q: { answers: ["Local"] } } },
      () => ({
        replyIntentId: "intent",
        answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
      }),
    );
    assert.equal(await runtime.waitForTurn(threadId, turnId), "completed");
    assert.equal(outcomes.filter((o) => o.outcome === "confirmed").length, 1);
    const receiptOrder = outcomes.find(
      (o) => o.outcome === "confirmed",
    )?.orderedReceipt;
    assert.ok(receiptOrder?.stdinSucceeded && receiptOrder.matchingResolution);
    assert.ok(receiptOrder.writeInitiated < receiptOrder.stdinSucceeded);
    assert.ok(receiptOrder.writeInitiated < receiptOrder.matchingResolution);
    await assert.rejects(
      runtime.replyUserInput(
        identity,
        { answers: { q: { answers: ["Local"] } } },
        () => ({
          replyIntentId: "intent",
          answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
        }),
      ),
    );
  } finally {
    await runtime.stop();
  }
});
async function nativeTransport(mode: string) {
  const executable = join(
    process.cwd(),
    "test/ui01/native-runtime-fixture.mjs",
  );
  let processInstance = 0;
  const runtime = newTestRuntime(executable, {
    qualifiedExecutableHash: createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex"),
    spawnEnvironment: () => {
      return {
        ...process.env,
        ENSEMBLE_UI01_NATIVE_TRANSPORT_FIXTURE: mode,
        ENSEMBLE_UI01_NATIVE_TRANSPORT_INSTANCE: String(processInstance),
      };
    },
  });
  const startRuntime = runtime.start.bind(runtime);
  runtime.start = async () => {
    processInstance++;
    await startRuntime();
  };
  let call!: import("../src/standalone/native-input.js").RuntimeUserInputRequest;
  let requestCallbacks = 0;
  let replyAttempts = 0;
  let terminalEvents = 0;
  let terminalEventData: unknown;
  let resolve!: () => void;
  const received = new Promise<void>((done) => {
    resolve = done;
  });
  const outcomes: import("../src/standalone/native-input.js").RuntimeUserInputOutcome[] =
    [];
  const anomalies: string[] = [];
  runtime.onUserInputRequest((request) => {
    call = request;
    requestCallbacks++;
    resolve();
  });
  runtime.onUserInputOutcome((outcome) => outcomes.push(outcome));
  const unexpected: import("../src/standalone/codex.js").UnexpectedRequest[] =
    [];
  runtime.onUnexpectedRequest((request) => {
    anomalies.push(request.method);
    unexpected.push(request);
  });
  const terminalAnomalies: string[] = [];
  runtime.onTerminalAnomaly((anomaly) =>
    terminalAnomalies.push(anomaly.reason),
  );
  await runtime.start();
  const threadId = await runtime.startThread(process.cwd());
  await runtime.startTurn(threadId, process.cwd(), "fixture");
  await received;
  const internal = runtime as unknown as {
    events: { on(event: string, listener: (data: unknown) => void): void };
  };
  internal.events.on("turn/completed", (data) => {
    terminalEvents++;
    terminalEventData = data;
  });
  const fixture = runtimeFixtures.get(runtime);
  if (!fixture) throw new Error("Runtime test safety fixture unavailable");
  return {
    runtime,
    call,
    outcomes,
    anomalies,
    unexpected,
    get requestCallbacks() {
      return requestCallbacks;
    },
    get replyAttempts() {
      return replyAttempts;
    },
    get terminalEvents() {
      return terminalEvents;
    },
    get terminalEventData() {
      return terminalEventData;
    },
    get terminalRecords() {
      return fixture.terminalRecords();
    },
    terminalEvidence: () => {
      const generation = runtime.currentUserInputGeneration();
      if (!generation) return "runtime generation missing";
      try {
        return fixture.safetyPort.terminal(
          threadId,
          call.identity.turnId,
          generation,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    terminalAnomalies,
    fixtureStoragePath: fixture.fixture.storagePath,
    safetyPortMatchesFixtureTerminal:
      fixture.safetyPort.terminal === fixture.fixture.safety.terminal,
    reply: () => {
      replyAttempts++;
      return runtime.replyUserInput(
        call.identity,
        { answers: { q: { answers: ["Local"] } } },
        () => ({
          replyIntentId: "intent",
          answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
        }),
      );
    },
  };
}
async function nativeUntil(
  predicate: () => boolean,
  diagnostics: () => unknown = () => undefined,
) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `Native receipt deadline: ${JSON.stringify(diagnostics())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
async function nativeDeadline<T>(
  label: string,
  action: Promise<T>,
  diagnostics: () => unknown,
  timeoutMs = 2000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} deadline: ${JSON.stringify(diagnostics())}`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test("native early resolution makes an unanswered endpoint unavailable with zero reply effects", async () => {
  const f = await nativeTransport("early-resolution");
  try {
    await nativeUntil(() => f.outcomes.length > 0);
    assert.equal(f.outcomes[0]?.outcome, "unavailable");
    let gate = 0;
    await assert.rejects(
      f.runtime.replyUserInput(
        f.call.identity,
        { answers: { q: { answers: ["Local"] } } },
        () => {
          gate++;
          return {
            replyIntentId: "intent",
            answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
          };
        },
      ),
    );
    assert.equal(gate, 0);
  } finally {
    await f.runtime.stop();
  }
});
test("native stdin success without resolution remains unconfirmed", async () => {
  const f = await nativeTransport("no-resolution");
  try {
    await f.reply();
    assert.deepEqual(
      f.outcomes.map((o) => o.outcome),
      ["sent-unconfirmed"],
    );
    f.runtime.cancelUserInput(f.call.identity, "Stop");
    assert.deepEqual(
      f.outcomes.map((o) => o.outcome),
      ["sent-unconfirmed", "uncertain"],
    );
  } finally {
    await f.runtime.stop();
  }
});
for (const mode of [
  "buffered",
  "write-error",
  "cancelled",
  "resolved-cancelled",
  "wrong-thread",
  "wrong-type",
] as const)
  test(`native ordered receipt ${mode} does not confirm before all required evidence`, async () => {
    const f = await nativeTransport(mode);
    let callback: ((error: Error | null) => void) | undefined;
    let writeComplete = false;
    const child = (
      f.runtime as unknown as { child: ChildProcessWithoutNullStreams }
    ).child;
    const original = child.stdin.write.bind(child.stdin);
    try {
      child.stdin.write = ((
        line: string,
        done: (error: Error | null) => void,
      ) =>
        original(line, (error) => {
          writeComplete = true;
          callback = done;
          if (error) done(error);
        })) as typeof child.stdin.write;
      const sent = f.reply();
      sent.catch(() => {});
      await nativeUntil(() => writeComplete);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fixture = runtimeFixtures.get(f.runtime)?.fixture;
      assert.ok(fixture, "Runtime test safety fixture unavailable");
      const persistedBeforeAck = fixture.coordination.runtimeQuestionByEndpoint(
        f.call.identity,
      );
      assert.equal(persistedBeforeAck?.deliveryState, "sending");
      assert.ok(persistedBeforeAck?.replyIntentId);
      assert.equal(
        f.outcomes.filter((o) => o.outcome === "confirmed").length,
        0,
      );
      if (mode === "cancelled")
        f.runtime.cancelUserInput(
          f.call.identity,
          "Stop before acknowledgement",
        );
      if (mode === "resolved-cancelled")
        f.runtime.cancelUserInput(
          f.call.identity,
          "Stop after acknowledgement before write callback",
        );
      assert.ok(callback);
      callback(
        mode === "write-error"
          ? new Error("fixture write callback error")
          : null,
      );
      if (mode === "write-error" || mode === "cancelled")
        await assert.rejects(sent);
      else await sent;
      const persistedAfterAck = fixture.coordination.runtimeQuestionByEndpoint(
        f.call.identity,
      );
      assert.equal(
        persistedAfterAck?.replyIntentId,
        persistedBeforeAck.replyIntentId,
      );
      if (mode === "buffered" || mode === "resolved-cancelled") {
        assert.deepEqual(
          f.outcomes.map((o) => o.outcome),
          ["confirmed"],
        );
        assert.equal(persistedAfterAck?.deliveryState, "confirmed");
        const receiptOrder = f.outcomes[0]?.orderedReceipt;
        assert.ok(
          receiptOrder?.stdinSucceeded && receiptOrder.matchingResolution,
        );
        assert.ok(
          receiptOrder.writeInitiated < receiptOrder.matchingResolution,
        );
        assert.ok(
          receiptOrder.matchingResolution < receiptOrder.stdinSucceeded,
        );
        if (mode === "buffered")
          f.runtime.cancelUserInput(f.call.identity, "Stop after confirmation");
        assert.equal(f.outcomes.length, 1);
      } else if (mode === "write-error" || mode === "cancelled") {
        assert.equal(f.outcomes.at(-1)?.outcome, "uncertain");
        assert.equal(persistedAfterAck?.deliveryState, "uncertain");
      } else {
        assert.deepEqual(
          f.outcomes.map((o) => o.outcome),
          ["sent-unconfirmed"],
        );
        await nativeUntil(() =>
          f.anomalies.includes("unmatched-native-resolution"),
        );
        assert.ok(f.anomalies.includes("unmatched-native-resolution"));
      }
    } finally {
      child.stdin.write = original;
      await f.runtime.stop();
    }
  });
for (const mode of [
  "reply-replay",
  "reply-replay-confirmed",
  "reply-replay-changed",
  "reply-replay-excess",
  "reply-replay-type",
] as const)
  test(`native ${mode} preserves one reply and distinguishes retransmission from conflict`, async () => {
    const f = await nativeTransport(mode);
    try {
      const diagnostics = () => ({
        requestCallbacks: f.requestCallbacks,
        replyAttempts: f.replyAttempts,
        identity: f.call.identity,
        outcomes: f.outcomes.map((outcome) => outcome.outcome),
        anomalies: f.anomalies,
        calls: f.unexpected.length,
        terminalEvents: f.terminalEvents,
        terminalEventData: f.terminalEventData,
        terminalRecords: f.terminalRecords,
        terminalEvidence: f.terminalEvidence(),
        terminalAnomalies: f.terminalAnomalies,
        fixtureStoragePath: f.fixtureStoragePath,
        safetyPortMatchesFixtureTerminal: f.safetyPortMatchesFixtureTerminal,
      });
      await nativeDeadline("native reply", f.reply(), diagnostics);
      const rejected =
        mode === "reply-replay-changed" ||
        mode === "reply-replay-excess" ||
        mode === "reply-replay-type";
      await nativeUntil(() =>
        f.outcomes.some(
          (o) => o.outcome === (rejected ? "uncertain" : "confirmed"),
        ),
      );
      assert.equal(
        f.outcomes.filter((o) => o.outcome === "confirmed").length,
        rejected ? 0 : 1,
      );
      if (mode === "reply-replay-confirmed")
        assert.equal(
          await nativeDeadline(
            "native terminal wait",
            f.runtime.waitForTurn(
              f.call.identity.threadId,
              f.call.identity.turnId,
            ),
            diagnostics,
          ),
          "completed",
        );
      assert.equal(f.anomalies.length > 0, rejected);
      if (rejected) {
        const diagnostic = f.unexpected[0]?.nativeReplay;
        assert.ok(diagnostic);
        assert.equal(
          diagnostic.runtimeGeneration,
          f.call.identity.runtimeGeneration,
        );
        assert.match(diagnostic.paramsDigest, /^[0-9a-f]{64}$/);
        assert.equal(diagnostic.identical, mode === "reply-replay-excess");
        assert.equal(
          diagnostic.acceptedReplays,
          mode === "reply-replay-excess" ? 1 : 0,
        );
        assert.equal(JSON.stringify(diagnostic).includes("Changed"), false);
      }
      let gates = 0;
      await assert.rejects(
        f.runtime.replyUserInput(
          f.call.identity,
          { answers: { q: { answers: ["Local"] } } },
          () => {
            gates++;
            return {
              replyIntentId: "duplicate",
              answerDigest: structuredAnswerDigest({
                q: { answers: ["Local"] },
              }),
            };
          },
        ),
      );
      assert.equal(gates, 0);
    } finally {
      await nativeDeadline(
        "native runtime stop",
        f.runtime.stop(),
        () => ({
          requestCallbacks: f.requestCallbacks,
          replyAttempts: f.replyAttempts,
          outcomes: f.outcomes.map((outcome) => outcome.outcome),
          anomalies: f.anomalies,
          terminalEvents: f.terminalEvents,
          terminalEventData: f.terminalEventData,
          terminalRecords: f.terminalRecords,
          terminalEvidence: f.terminalEvidence(),
          terminalAnomalies: f.terminalAnomalies,
          fixtureStoragePath: f.fixtureStoragePath,
          safetyPortMatchesFixtureTerminal: f.safetyPortMatchesFixtureTerminal,
        }),
        2000,
      );
    }
  });
for (const control of ["cancel", "interrupt"] as const)
  test(`native ${control} after confirmation retires replay eligibility without rewriting receipt`, async () => {
    const f = await nativeTransport("replay-after-stop");
    try {
      await f.reply();
      await nativeUntil(() =>
        f.outcomes.some((o) => o.outcome === "confirmed"),
      );
      const receipt = structuredClone(f.outcomes);
      if (control === "interrupt")
        await f.runtime.interruptTurn(
          f.call.identity.threadId,
          f.call.identity.turnId,
        );
      else {
        f.runtime.cancelUserInput(f.call.identity, "Stop after confirmation");
        const child = (
          f.runtime as unknown as { child: ChildProcessWithoutNullStreams }
        ).child;
        child.stdin.write(JSON.stringify({ method: "fixture/replay" }) + "\n");
      }
      await f.runtime.waitForTurn(
        f.call.identity.threadId,
        f.call.identity.turnId,
      );
      assert.ok(f.anomalies.includes("stale-native-input"));
      assert.deepEqual(f.outcomes, receipt);
    } finally {
      await f.runtime.stop();
    }
  });
test("native exact replay without resolution never confirms delivery", async () => {
  const f = await nativeTransport("reply-replay-no-resolution");
  try {
    await f.reply();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      f.outcomes.map((o) => o.outcome),
      ["sent-unconfirmed"],
    );
    assert.deepEqual(f.anomalies, []);
    f.runtime.cancelUserInput(f.call.identity, "Stop");
    assert.equal(f.outcomes.at(-1)?.outcome, "uncertain");
  } finally {
    await f.runtime.stop();
  }
});
test("native exact replay during an outstanding stdin callback still requires successful write and resolution", async () => {
  const f = await nativeTransport("reply-replay");
  const child = (
    f.runtime as unknown as { child: ChildProcessWithoutNullStreams }
  ).child;
  const original = child.stdin.write.bind(child.stdin);
  const receiver = f.runtime as unknown as {
    receiveNativeRequest(
      child: ChildProcessWithoutNullStreams,
      id: string | number,
      input: unknown,
    ): boolean;
  };
  const receive = receiver.receiveNativeRequest.bind(f.runtime);
  let replayProcessed = false;
  receiver.receiveNativeRequest = (attached, id, input) => {
    const result = receive(attached, id, input);
    replayProcessed = true;
    return result;
  };
  let callback: ((error: Error | null) => void) | undefined;
  try {
    child.stdin.write = ((line: string, done: (error: Error | null) => void) =>
      original(line, () => {
        callback = done;
      })) as typeof child.stdin.write;
    const sent = f.reply();
    sent.catch(() => {});
    await nativeUntil(() => Boolean(callback));
    await nativeUntil(() => replayProcessed);
    assert.equal(f.outcomes.length, 0);
    assert.ok(callback);
    callback(null);
    await sent;
    await nativeUntil(() => f.outcomes.some((o) => o.outcome === "confirmed"));
    assert.deepEqual(f.anomalies, []);
  } finally {
    receiver.receiveNativeRequest = receive;
    child.stdin.write = original;
    await f.runtime.stop();
  }
});
test("replacement process reusing a typed RPC ID cannot receive an old answer", async () => {
  const f = await nativeTransport("no-resolution");
  try {
    await f.runtime.stop();
    assert.equal(f.runtime.currentUserInputGeneration(), undefined);
    let next!: import("../src/standalone/native-input.js").RuntimeUserInputRequest;
    let resolve!: () => void;
    const received = new Promise<void>((done) => {
      resolve = done;
    });
    f.runtime.onUserInputRequest((request) => {
      next = request;
      resolve();
    });
    await f.runtime.start();
    const thread = await f.runtime.startThread(process.cwd());
    await f.runtime.startTurn(thread, process.cwd(), "replacement fixture");
    await received;
    assert.equal(next.identity.requestId, f.call.identity.requestId);
    assert.equal(next.identity.turnId, "native-turn-replacement");
    assert.notEqual(next.identity.turnId, f.call.identity.turnId);
    assert.notEqual(
      next.identity.runtimeGeneration,
      f.call.identity.runtimeGeneration,
    );
    const fixture = runtimeFixtures.get(f.runtime)?.fixture;
    assert.ok(fixture);
    const previousWork = fixture.bindTurn(
      f.call.identity.threadId,
      f.call.identity.turnId,
      f.call.identity.runtimeGeneration,
    );
    const replacementWork = fixture.bindTurn(
      next.identity.threadId,
      next.identity.turnId,
      next.identity.runtimeGeneration,
    );
    assert.notEqual(replacementWork, previousWork);
    let gates = 0;
    await assert.rejects(
      f.runtime.replyUserInput(
        f.call.identity,
        { answers: { q: { answers: ["Local"] } } },
        () => {
          gates++;
          return {
            replyIntentId: "old-intent",
            answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
          };
        },
      ),
    );
    assert.equal(gates, 0);
    assert.equal(f.outcomes.filter((o) => o.outcome === "confirmed").length, 0);
  } finally {
    await f.runtime.stop();
  }
});
for (const mode of [
  "unknown-version",
  "plan",
  "wrong-hash",
  "async-before",
] as const)
  test(`native ${mode} disables support before question exposure or answer effects`, async () => {
    const executable = join(
      process.cwd(),
      "test/ui01/native-runtime-fixture.mjs",
    );
    const runtime = newTestRuntime(executable, {
      qualifiedExecutableHash:
        mode === "wrong-hash"
          ? "0".repeat(64)
          : createHash("sha256").update(readFileSync(executable)).digest("hex"),
      spawnEnvironment: () => ({
        ...process.env,
        ENSEMBLE_UI01_NATIVE_TRANSPORT_FIXTURE: mode,
      }),
    });
    let requests = 0;
    const anomalies: string[] = [];
    runtime.onUserInputRequest(() => requests++);
    runtime.onUnexpectedRequest((request) => anomalies.push(request.method));
    try {
      await runtime.start();
      const thread = await runtime.startThread(process.cwd());
      await runtime.startTurn(thread, process.cwd(), "unsupported fixture");
      await nativeUntil(() => anomalies.length > 0);
      if (mode === "async-before") {
        await nativeUntil(() => anomalies.includes("unqualified-native-input"));
      }
      assert.equal(requests, 0);
    } finally {
      await runtime.stop();
    }
  });

for (const mode of [
  "two-turn-early",
  "two-turn-early-old-replay",
  "two-turn-early-conflict",
  "two-turn-early-async",
  "two-turn-early-plan",
  "two-turn-early-duplicate-resolution",
  "two-turn-early-late-replay",
  "two-turn-early-resolution",
] as const)
  test(`native adapter resumed thread ${mode} isolates early callback and historical receipt`, async () => {
    const executable = join(
      process.cwd(),
      "test/ui01/native-runtime-fixture.mjs",
    );
    const runtime = newTestRuntime(executable, {
      qualifiedExecutableHash: createHash("sha256")
        .update(readFileSync(executable))
        .digest("hex"),
      spawnEnvironment: () => ({
        ...process.env,
        ENSEMBLE_UI01_NATIVE_TRANSPORT_FIXTURE: mode,
      }),
    });
    const calls: import("../src/standalone/native-input.js").RuntimeUserInputRequest[] =
      [];
    const outcomes: import("../src/standalone/native-input.js").RuntimeUserInputOutcome[] =
      [];
    const anomalies: string[] = [];
    const terminalAnomalies: string[] = [];
    let secondResponseBound = false;
    runtime.onUserInputRequest((call) => {
      if (calls.length === 1)
        assert.equal(
          secondResponseBound,
          true,
          "second callback exposed before turn response",
        );
      calls.push(call);
    });
    runtime.onUserInputOutcome((outcome) => outcomes.push(outcome));
    runtime.onUnexpectedRequest((request) => anomalies.push(request.method));
    runtime.onTerminalAnomaly((anomaly) =>
      terminalAnomalies.push(anomaly.reason),
    );
    let replyAttempts = 0;
    const reply = (index: number) => {
      replyAttempts++;
      const call = calls[index];
      assert.ok(call);
      return runtime.replyUserInput(
        call.identity,
        { answers: { q: { answers: ["Local"] } } },
        () => ({
          replyIntentId: `intent-${index}`,
          answerDigest: structuredAnswerDigest({ q: { answers: ["Local"] } }),
        }),
      );
    };
    try {
      await runtime.start();
      const thread = await runtime.startThread(process.cwd());
      const firstTurn = await runtime.startTurn(
        thread,
        process.cwd(),
        "first fixture turn",
      );
      await nativeUntil(() => calls.length === 1);
      await reply(0);
      assert.equal(await runtime.waitForTurn(thread, firstTurn), "completed");
      const firstReceipt = outcomes.find((o) => o.outcome === "confirmed");
      assert.ok(firstReceipt);
      await runtime.resumeThread(thread);
      const secondTurn = await runtime.startTurn(
        thread,
        process.cwd(),
        "second fixture turn",
      );
      secondResponseBound = true;
      const rejected = [
        "two-turn-early-conflict",
        "two-turn-early-async",
        "two-turn-early-plan",
      ].includes(mode);
      if (mode === "two-turn-early-resolution") {
        await nativeUntil(
          () =>
            calls.length === 2 ||
            anomalies.includes("unqualified-native-input"),
        );
        let secondWrites = 0;
        await assert.rejects(
          runtime.replyUserInput(
            {
              requestId: 702,
              runtimeGeneration: firstReceipt.runtimeGeneration,
              threadId: thread,
              turnId: secondTurn,
              itemId: "native-item-2",
            },
            { answers: { q: { answers: ["Local"] } } },
            () => {
              secondWrites++;
              return {
                replyIntentId: "intent-second",
                answerDigest: structuredAnswerDigest({
                  q: { answers: ["Local"] },
                }),
              };
            },
          ),
          /unavailable/,
        );
        assert.equal(secondWrites, 0);
        assert.equal(calls.length, 1);
        assert.ok(anomalies.includes("native-resolution-before-qualification"));
        assert.equal(
          outcomes.filter((o) => o.outcome === "confirmed").length,
          1,
        );
      } else if (rejected) {
        await nativeUntil(() => anomalies.includes("unqualified-native-input"));
        assert.equal(calls.length, 1);
        assert.equal(
          outcomes.filter((o) => o.outcome === "confirmed").length,
          1,
        );
      } else {
        await nativeUntil(
          () => calls.length === 2,
          () => {
            const internals = runtime as unknown as {
              nativeTurns: Map<string, string>;
              nativeReadbacks: Map<
                string,
                {
                  input: unknown;
                  id: string | number;
                  requested: boolean;
                  responded: boolean;
                  replays: number;
                  invalid: boolean;
                }
              >;
            };
            const generation = runtime.currentUserInputGeneration();
            const fixture = runtimeFixtures.get(runtime)?.fixture;
            const terminal = (turnId: string) => {
              if (!generation || !fixture) return "fixture unavailable";
              try {
                return fixture.safety.terminal(thread, turnId, generation);
              } catch (error) {
                return error instanceof Error ? error.message : String(error);
              }
            };
            const pending = internals.nativeReadbacks.get(thread);
            return {
              secondTurn,
              calls: calls.map((call) => call.identity),
              replyAttempts,
              outcomes: outcomes.map((outcome) => outcome.outcome),
              anomalies,
              terminalAnomalies,
              currentTurn: internals.nativeTurns.get(thread),
              qualificationPresent: Boolean(calls[1]?.qualification),
              pending: pending
                ? {
                    input: pending.input,
                    id: pending.id,
                    requested: pending.requested,
                    responded: pending.responded,
                    replays: pending.replays,
                    invalid: pending.invalid,
                  }
                : null,
              firstTerminal: terminal(firstTurn),
              secondTerminal: terminal(secondTurn),
            };
          },
        );
        assert.equal(calls[1]?.identity.turnId, secondTurn);
        assert.equal(calls[1]?.identity.requestId, 702);
        const threadState = runtime as unknown as {
          threadSnapshots: Map<string, unknown>;
        };
        assert.equal(calls[1]?.qualification.threadId, thread);
        assert.equal(
          calls[1]?.qualification.runtimeGeneration,
          calls[1]?.identity.runtimeGeneration,
        );
        assert.ok(threadState.threadSnapshots.has(thread));
        const fixture = runtimeFixtures.get(runtime)?.fixture;
        assert.ok(fixture);
        const previousWork = fixture.bindTurn(
          thread,
          firstTurn,
          firstReceipt.runtimeGeneration,
        );
        const replacementWork = fixture.bindTurn(
          thread,
          secondTurn,
          calls[1]!.identity.runtimeGeneration,
        );
        assert.notEqual(previousWork, replacementWork);
        assert.equal(
          fixture.safety.terminal(
            thread,
            firstTurn,
            firstReceipt.runtimeGeneration,
          )?.workId,
          previousWork,
        );
        assert.equal(
          fixture.coordination.runtimeQuestionByEndpoint(calls[0]!.identity)
            ?.deliveryState,
          "confirmed",
        );
        await reply(1);
        assert.equal(
          await runtime.waitForTurn(thread, secondTurn),
          "completed",
        );
        assert.equal(
          outcomes.filter((o) => o.outcome === "confirmed").length,
          2,
        );
        if (mode === "two-turn-early-old-replay")
          assert.ok(anomalies.includes("stale-native-input"));
        else assert.deepEqual(anomalies, []);
      }
      assert.deepEqual(
        outcomes.find((o) => o.outcome === "confirmed"),
        firstReceipt,
      );
      await assert.rejects(reply(0), /unavailable/);
    } finally {
      await nativeDeadline("two-turn runtime stop", runtime.stop(), () => ({
        calls: calls.map((call) => call.identity),
        replyAttempts,
        outcomes: outcomes.map((outcome) => outcome.outcome),
        anomalies,
        terminalAnomalies,
      }));
    }
  });

test("archived resume rejection retains its exact correlated request and process before any turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-archived-resume-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      "import { createInterface } from 'node:readline';",
      "const write = m => process.stdout.write(JSON.stringify(m) + '\\n');",
      "for await (const line of createInterface({input:process.stdin})) {",
      "const m=JSON.parse(line);",
      "if(m.method==='initialize') write({id:m.id,result:{}});",
      "if(m.method==='account/read') write({id:m.id,result:{account:{type:'chatgpt'}}});",
      "if(m.method==='config/read') write({id:m.id,result:{config:{approval_policy:'never',sandbox_mode:'workspace-write'}}});",
      "if(m.method==='thread/resume') write({id:m.id,error:{code:-32600,message:'session '+m.params.threadId+' is archived. Run `codex unarchive '+m.params.threadId+'` to unarchive it first.'}});",
      "}",
    ].join("\n"),
  );
  chmodSync(executable, 0o700);
  const runtime = newTestRuntime(executable, {
    captureProcessIdentity: async () => ({
      processId: "synthetic-123",
      processStartedAt: "synthetic-birth",
      bootId: "synthetic-boot",
    }),
  });
  try {
    await runtime.start();
    await assert.rejects(
      runtime.resumeThread("archived-thread"),
      (error: unknown) => {
        const rejection = (
          error as {
            rejection?: {
              method: string;
              requestId: number;
              threadId: string;
              processIdentity: unknown;
            };
          }
        ).rejection;
        assert.ok(
          rejection,
          "positive rejection must retain structured RPC correlation",
        );
        assert.equal(rejection.method, "thread/resume");
        assert.equal(rejection.threadId, "archived-thread");
        assert.ok(Number.isSafeInteger(rejection.requestId));
        assert.deepEqual(rejection.processIdentity, runtime.processIdentity());
        return true;
      },
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archived RPC text cannot qualify wrong methods, identities or malformed responses", async (t) => {
  for (const mode of [
    "wrong-code",
    "wrong-thread",
    "malformed",
    "result-and-error",
    "method-empty",
    "params-present",
    "method-and-params",
    "string-id",
    "wrong-method",
    "no-response",
  ] as const)
    await t.test(mode, async () => {
      const root = mkdtempSync(join(tmpdir(), "ensemble-archived-negative-"));
      const executable = join(root, "fake-codex.mjs");
      const error = {
        code: mode === "wrong-code" ? -32000 : -32600,
        message: `session ${mode === "wrong-thread" ? "other-thread" : "archived-thread"} is archived. Run \`codex unarchive ${mode === "wrong-thread" ? "other-thread" : "archived-thread"}\` to unarchive it first.`,
      };
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          "import {createInterface} from 'node:readline';",
          "const write=m=>process.stdout.write(JSON.stringify(m)+'\\n');",
          "for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);",
          "if(m.method==='initialize')write({id:m.id,result:{}});",
          "if(m.method==='account/read')write({id:m.id,result:{account:{type:'chatgpt'}}});",
          "if(m.method==='config/read')write({id:m.id,result:{config:{approval_policy:'never',sandbox_mode:'workspace-write'}}});",
          `if(m.method==='${mode === "wrong-method" ? "thread/start" : "thread/resume"}' && '${mode}'!=='no-response')write({id:${mode === "string-id" ? "String(m.id)" : "m.id"},error:${JSON.stringify(mode === "malformed" ? { ...error, code: "-32600" } : error)},${mode === "result-and-error" ? "result:{}," : ""}${mode === "method-empty" || mode === "method-and-params" ? "method:''," : ""}${mode === "params-present" || mode === "method-and-params" ? "params:{malformed:true}," : ""}});`,
          "}",
        ].join("\n"),
      );
      chmodSync(executable, 0o700);
      const runtime = newTestRuntime(executable, {
        captureProcessIdentity: async () => ({
          processId: "synthetic-123",
          processStartedAt: "synthetic-birth",
          bootId: "synthetic-boot",
        }),
      });
      try {
        await runtime.start();
        const call =
          mode === "wrong-method"
            ? runtime.startThread(root)
            : runtime.resumeThread("archived-thread");
        await assert.rejects(
          mode === "no-response"
            ? bounded(
                call.then(() => undefined),
                30,
              )
            : call,
          (error: unknown) => {
            assert.equal(
              (error as { rejection?: unknown }).rejection,
              undefined,
            );
            return true;
          },
        );
      } finally {
        await runtime.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });
});
