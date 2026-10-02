#!/usr/bin/env node
import { createInterface } from "node:readline";

const mode = process.argv[2];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const requestId = mode === "numeric-id" ? 71 : "71";
let nativeReplies = 0;
let turns = 0;
let threads = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params.capabilities.experimentalApi !== true) process.exit(4);
    write({ id: message.id, result: {} });
  } else if (message.method === "account/read") {
    write({
      id: message.id,
      result: {
        account: { type: "chatgpt" },
        ...(mode === "oversized-account"
          ? { padding: "x".repeat(1_048_576) }
          : {}),
      },
    });
  } else if (message.method === "config/read") {
    const response = {
      id:
        mode === "oversized-config-wrong-id-type"
          ? String(message.id)
          : message.id,
      result: {
        config: { approval_policy: "never", sandbox_mode: "workspace-write" },
      },
    };
    if (mode.startsWith("oversized-config")) {
      response.result.config.discarded = "PRIVATE_CONFIG_PAYLOAD_DO_NOT_RETAIN";
      const bytes =
        mode === "oversized-config-overbound" ? 2_097_153 : 1_601_330;
      response.result.config.discarded += "x".repeat(
        bytes - Buffer.byteLength(JSON.stringify(response)),
      );
      if (mode === "oversized-config-error")
        response.error = {
          code: -1,
          message: "PRIVATE_CONFIG_ERROR_DO_NOT_RETAIN",
        };
    }
    write(response);
  } else if (message.method === "thread/start") {
    threads++;
    if (
      threads !== 1 ||
      message.params.approvalPolicy !== "never" ||
      message.params.sandbox !== "workspace-write" ||
      message.params.dynamicTools[0].name !== "ui01_report_answers"
    )
      process.exit(4);
    write({
      id: message.id,
      result: {
        thread: { id: "thread-1" },
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite" },
      },
    });
  } else if (message.method === "turn/start") {
    turns++;
    if (
      turns !== 1 ||
      message.params.collaborationMode !== undefined ||
      message.params.approvalPolicy !== "never" ||
      message.params.sandboxPolicy.networkAccess !== false ||
      message.params.sandboxPolicy.writableRoots[0] !== message.params.cwd
    )
      process.exit(4);
    if (mode === "timeout") continue;
    const params = {
      threadId: mode === "wrong-thread" ? "foreign" : "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      isBlocking: mode !== "nonblocking",
      autoResolutionMs: mode === "timed" ? 100 : null,
      questions: [
        {
          id: "delivery",
          header: "Delivery",
          question: "Select delivery",
          isOther: mode === "custom",
          isSecret: mode === "secret",
          options: [
            { label: "Local", description: "Local output" },
            { label: "Remote", description: "Remote output" },
          ],
        },
      ],
    };
    if (mode === "oversized-native")
      params.questions[0].question = "😀".repeat(350_000);
    if (mode === "oversized-unknown")
      write({
        method: "unknown/notification",
        params: { padding: "x".repeat(1_048_576) },
      });
    write({ id: requestId, method: "item/tool/requestUserInput", params });
    write({
      id: message.id,
      result: { turn: { id: mode === "wrong-turn" ? "foreign" : "turn-1" } },
    });
    if (mode === "early-resolution")
      write({
        method: "serverRequest/resolved",
        params: { threadId: "thread-1", requestId },
      });
    if (mode === "cancelled")
      write({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
    if (mode === "duplicate")
      write({ id: requestId, method: "item/tool/requestUserInput", params });
  } else if (message.method === "turn/interrupt") {
    if (
      message.params.threadId !== "thread-1" ||
      message.params.turnId !== "turn-1"
    )
      process.exit(4);
    write({ id: message.id, result: {} });
  } else if (message.id === requestId && message.method === undefined) {
    nativeReplies++;
    if (nativeReplies !== 1 || !message.result?.answers?.delivery)
      process.exit(4);
    if (mode !== "no-resolution")
      write({
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: mode === "wrong-id-type" ? 71 : requestId,
        },
      });
    write({
      id: "report-rpc",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "report-1",
        tool: "ui01_report_answers",
        arguments: {
          answers:
            mode === "wrong-report"
              ? { delivery: { answers: ["Remote"] } }
              : message.result.answers,
          threads,
          turns,
          nativeReplies,
        },
      },
    });
  } else if (message.id === "report-rpc") {
    write({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "report-rpc" },
    });
    write({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
  }
}
