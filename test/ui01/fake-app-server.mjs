#!/usr/bin/env node
import { createInterface } from "node:readline";

const mode = process.argv[2];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const requestId = mode === "numeric-id" ? 71 : "71";
let nativeReplies = 0;
let turns = 0;
let threads = 0;
let resumes = 0;
function asyncMarker(
  threadId = "thread-1",
  turnId = "turn-1",
  functionOutput = false,
) {
  write({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: functionOutput
        ? {
            type: "functionCallOutput",
            id: "async-1",
            name: "request_user_input_async",
            namespace: "functions",
            output: "PRIVATE_ASYNC_OUTPUT",
          }
        : {
            type: "agentMessage",
            id: "async-1",
            delivery: "async",
            questions: [{ title: "PRIVATE_ASYNC_QUESTION", options: null }],
            text: "PRIVATE_ASYNC_TEXT",
          },
    },
  });
}
const settings = {
  model: "fixture-model",
  modelProvider: "fixture-provider",
  reasoningEffort: "high",
  serviceTier: null,
};
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
      message.params.dynamicTools[0].name !== "ui01_report_answers" ||
      [
        "model",
        "modelProvider",
        "effort",
        "collaborationMode",
        "config",
        "baseInstructions",
        "developerInstructions",
      ].some((key) => key in message.params)
    )
      process.exit(4);
    write({
      id: message.id,
      result: {
        thread: { id: "thread-1" },
        ...settings,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite" },
      },
    });
  } else if (message.method === "thread/resume") {
    resumes++;
    if (turns === 0) {
      write({
        id: message.id,
        error: { code: -32600, message: "no rollout found before first turn" },
      });
      continue;
    }
    if (
      resumes !== 1 ||
      turns !== 1 ||
      nativeReplies !== 0 ||
      message.params.threadId !== "thread-1" ||
      Object.keys(message.params).length !== 1
    )
      process.exit(4);
    if (mode === "mode-resume-failed") {
      write({
        id: message.id,
        error: { code: -32600, message: "no rollout found" },
      });
      continue;
    }
    if (mode === "mode-resume-timeout") continue;
    if (mode.startsWith("mode-pending-")) {
      if (mode === "mode-pending-async") asyncMarker();
      if (mode === "mode-pending-foreign-async") asyncMarker("foreign");
      if (mode === "mode-pending-resolution")
        write({
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId },
        });
      if (mode === "mode-pending-report")
        write({
          id: "report-rpc",
          method: "item/tool/call",
          params: {
            tool: "ui01_report_answers",
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "report-1",
            arguments: { answers: {} },
          },
        });
      if (
        ["mode-pending-terminal", "mode-pending-foreign-terminal"].includes(
          mode,
        )
      )
        write({
          method: "turn/completed",
          params: {
            threadId:
              mode === "mode-pending-foreign-terminal" ? "foreign" : "thread-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      // Leave mode unresolved: the injected confounder must stop before any answer effect.
      continue;
    }
    const response = {
      thread: { id: mode === "foreign-resume-thread" ? "foreign" : "thread-1" },
      ...settings,
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      collaborationMode: {
        mode: mode === "plan-mode" ? "plan" : "default",
        settings: {
          model: "fixture-model",
          reasoning_effort: "high",
          developer_instructions: "PRIVATE_MODE_INSTRUCTIONS_DO_NOT_RETAIN",
        },
      },
    };
    if (mode === "missing-mode") response.collaborationMode = null;
    if (mode === "unknown-mode") response.collaborationMode.mode = "unknown";
    if (mode === "changed-model") response.model = "foreign-model";
    if (mode === "changed-provider")
      response.modelProvider = "foreign-provider";
    if (mode === "changed-effort") response.reasoningEffort = "low";
    if (mode === "changed-tier") response.serviceTier = "priority";
    if (mode === "conflicting-mode-settings")
      response.collaborationMode.settings.model = "foreign-model";
    if (mode === "missing-instruction-settings")
      delete response.collaborationMode.settings.developer_instructions;
    if (mode === "mode-delayed")
      setTimeout(() => write({ id: message.id, result: response }), 40);
    else write({ id: message.id, result: response });
  } else if (message.method === "turn/start") {
    turns++;
    if (
      turns !== 1 ||
      [
        "model",
        "modelProvider",
        "effort",
        "collaborationMode",
        "config",
        "baseInstructions",
        "developerInstructions",
      ].some((key) => key in message.params) ||
      message.params.approvalPolicy !== "never" ||
      message.params.sandboxPolicy.networkAccess !== false ||
      message.params.sandboxPolicy.writableRoots[0] !== message.params.cwd
    )
      process.exit(4);
    if (mode === "prompt") {
      const prompt = message.params.input?.[0]?.text ?? "";
      if (
        (prompt.match(/\bfunctions\.request_user_input\b/g) ?? []).length !==
          1 ||
        !prompt.includes("synchronously") ||
        !prompt.includes("functions.exec") ||
        !prompt.includes("ALL_TOOLS") ||
        !prompt.includes("async") ||
        !prompt.includes("plaintext") ||
        prompt.includes("free-text goal")
      )
        process.exit(4);
    }
    if (mode === "timeout") continue;
    const params = {
      threadId: mode === "wrong-thread" ? "foreign" : "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      isBlocking: mode === "plan-flag",
      autoResolutionMs: mode === "timed" ? 100 : null,
      questions: [
        {
          id: "delivery",
          header: "Delivery",
          question: "Select delivery",
          isOther: ["custom", "default"].includes(mode),
          isSecret: mode === "secret",
          options: [
            { label: "Local", description: "Local output" },
            { label: "Remote", description: "Remote output" },
          ],
        },
      ],
    };
    if (mode === "free-text-only") params.questions[0].options = null;
    if (mode === "wrong-question") params.questions[0].id = "formats";
    if (mode === "free-text-group")
      params.questions.push({
        id: "goal",
        header: "Goal",
        question: "Name a goal",
        isOther: false,
        isSecret: false,
        options: null,
      });
    if (mode === "oversized-native")
      params.questions[0].question = "😀".repeat(350_000);
    if (mode === "oversized-unknown")
      write({
        method: "unknown/notification",
        params: { padding: "x".repeat(1_048_576) },
      });
    if (mode === "async-before-native") asyncMarker();
    if (mode === "async-function-output")
      asyncMarker("thread-1", "turn-1", true);
    if (mode === "foreign-async-marker") asyncMarker("foreign");
    if (mode === "async-rpc")
      write({
        id: "async-rpc",
        method: "item/tool/requestUserInputAsync",
        params,
      });
    write({ id: requestId, method: "item/tool/requestUserInput", params });
    if (mode === "async-held") setTimeout(() => asyncMarker(), 5);
    write({
      id: message.id,
      result: { turn: { id: mode === "wrong-turn" ? "foreign" : "turn-1" } },
    });
    if (mode === "terminal-held")
      setTimeout(
        () =>
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            },
          }),
        5,
      );
    if (mode === "report-held")
      setTimeout(
        () =>
          write({
            id: "report-rpc",
            method: "item/tool/call",
            params: {
              tool: "ui01_report_answers",
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "report-1",
              arguments: { answers: {} },
            },
          }),
        5,
      );
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
    if (mode === "async-after-write") asyncMarker();
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
    if (mode === "async-after-confirmed") asyncMarker();
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
