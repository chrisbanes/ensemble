#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log(
    process.env.ENSEMBLE_UI01_NATIVE_TRANSPORT_FIXTURE === "unknown-version"
      ? "codex-cli 0.160.0"
      : "codex-cli 0.159.0",
  );
  process.exit(0);
}
const transport = process.env.ENSEMBLE_UI01_NATIVE_TRANSPORT_FIXTURE;
const proof = process.env.ENSEMBLE_UI01_NATIVE_PROOF_FIXTURE;
const twoTurn = transport?.startsWith("two-turn-early");
let turns = 0;
let lastNative;
let firstNative;
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const thread = {
  thread: { id: "native-thread" },
  approvalPolicy: "never",
  sandbox: { type: "workspaceWrite" },
  model: "fixture-model",
  modelProvider: "fixture",
  reasoningEffort: null,
  serviceTier: null,
};
const terminal = () =>
  send({
    method: "turn/completed",
    params: {
      threadId: "native-thread",
      turn: {
        id: lastNative?.params.turnId ?? "native-turn",
        status: "completed",
      },
    },
  });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize" && proof !== "startup-stall")
    send({ id: m.id, result: {} });
  if (
    (m.method === "fixture/replay" || m.method === "turn/interrupt") &&
    transport === "replay-after-stop"
  ) {
    if (m.method === "turn/interrupt") send({ id: m.id, result: {} });
    send(lastNative);
    terminal();
  }
  if (m.method === "account/read")
    send({ id: m.id, result: { account: { type: "chatgpt" } } });
  if (m.method === "config/read")
    send({
      id: m.id,
      result: {
        config: { approval_policy: "never", sandbox_mode: "workspace-write" },
      },
    });
  if (m.method === "thread/start") send({ id: m.id, result: thread });
  if (m.method === "thread/resume")
    send({
      id: m.id,
      result: {
        ...thread,
        collaborationMode: {
          mode:
            transport === "plan" ||
            (transport === "two-turn-early-plan" && turns === 2)
              ? "plan"
              : "default",
          settings: {
            model: thread.model,
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
  if (twoTurn && m.method === "turn/start") {
    turns++;
    const turnId = turns === 1 ? "native-turn" : "native-turn-2";
    const request = {
      id: turns === 1 ? "native-id" : 702,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-thread",
        turnId,
        itemId: turns === 1 ? "native-item" : "native-item-2",
        isBlocking: false,
        autoResolutionMs: null,
        questions: [
          {
            id: "q",
            header: "Place",
            question: "Where?",
            isOther: true,
            isSecret: false,
            options: [{ label: "Local", description: "Here" }],
          },
        ],
      },
    };
    lastNative = request;
    if (turns === 1) {
      firstNative = request;
      send({ id: m.id, result: { turn: { id: turnId } } });
      send(request);
    } else {
      if (transport === "two-turn-early-async")
        send({
          method: "item/started",
          params: {
            threadId: "native-thread",
            turnId,
            item: { type: "toolCall", name: "request_user_input_async" },
          },
        });
      send(request);
      if (transport === "two-turn-early-resolution")
        send({
          method: "serverRequest/resolved",
          params: { threadId: "native-thread", requestId: request.id },
        });
      if (transport === "two-turn-early-conflict")
        send({
          ...request,
          params: { ...request.params, itemId: "conflicting-item" },
        });
      if (transport === "two-turn-early-old-replay") {
        send(firstNative);
        send({
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: { id: "native-turn", status: "completed" },
          },
        });
      }
      setTimeout(
        () => send({ id: m.id, result: { turn: { id: turnId } } }),
        30,
      );
    }
    return;
  }
  if (twoTurn && m.id === lastNative?.id && m.result) {
    if (turns === 2 && transport === "two-turn-early-late-replay")
      send(lastNative);
    const resolved = {
      method: "serverRequest/resolved",
      params: { threadId: "native-thread", requestId: m.id },
    };
    send(resolved);
    if (transport === "two-turn-early-duplicate-resolution") send(resolved);
    send({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: lastNative.params.turnId, status: "completed" },
      },
    });
    return;
  }
  if (m.method === "turn/start") {
    const turnId =
      process.env.ENSEMBLE_UI01_NATIVE_TRANSPORT_INSTANCE === "2"
        ? "native-turn-replacement"
        : "native-turn";
    send({ id: m.id, result: { turn: { id: turnId } } });
    if (transport === "async-before")
      send({
        method: "item/started",
        params: {
          threadId: "native-thread",
          turnId,
          item: { type: "toolCall", name: "request_user_input_async" },
        },
      });
    lastNative = {
      id: "native-id",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-thread",
        turnId,
        itemId: "native-item",
        isBlocking: false,
        autoResolutionMs: null,
        questions: [
          proof
            ? {
                id: "delivery",
                header: "Delivery",
                question: "Select delivery",
                isOther: true,
                isSecret: proof === "secret",
                options: [
                  { label: "Local", description: "Local output" },
                  { label: "Remote", description: "Remote output" },
                ],
              }
            : {
                id: "q",
                header: "Place",
                question: "Where?",
                isOther: true,
                isSecret: false,
                options: [{ label: "Local", description: "Here" }],
              },
        ],
      },
    };
    send(lastNative);
  }
  if (m.id === "native-id" && m.result) {
    if (transport?.startsWith("reply-replay") || proof === "reply-replay") {
      const replay = structuredClone(lastNative);
      if (transport === "reply-replay-changed")
        replay.params.questions[0].question = "Changed";
      if (transport === "reply-replay-type") replay.id = 0;
      if (transport !== "reply-replay-confirmed") send(replay);
      if (transport === "reply-replay-excess") send(replay);
    }
    if (
      transport !== "no-resolution" &&
      transport !== "reply-replay-no-resolution" &&
      transport !== "cancelled"
    )
      send({
        method: "serverRequest/resolved",
        params: {
          threadId: transport === "wrong-thread" ? "wrong" : "native-thread",
          requestId: transport === "wrong-type" ? 1 : "native-id",
        },
      });
    if (transport === "reply-replay-confirmed") {
      send(lastNative);
      terminal();
    }
    if (transport) return;
    if (proof)
      send({
        id: "service-report",
        method: "item/tool/call",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          callId: "service-report",
          tool: "ui01_report_answers",
          arguments: { answers: m.result.answers },
        },
      });
    else terminal();
  }
  if (m.method === "thread/resume" && transport === "early-resolution")
    setTimeout(
      () =>
        send({
          method: "serverRequest/resolved",
          params: { threadId: "native-thread", requestId: "native-id" },
        }),
      10,
    );
  if (m.id === "service-report" && m.result) terminal();
});
