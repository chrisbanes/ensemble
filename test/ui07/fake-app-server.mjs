#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.159.0");
  process.exit(0);
}
const mode = process.env.UI07_FIXTURE_MODE;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const terminal = () =>
  send({
    method: "turn/completed",
    params: {
      threadId: "native-thread",
      turn: { id: "native-turn", status: "completed" },
    },
  });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "account/read")
    send({ id: m.id, result: { account: { type: "chatgpt" } } });
  if (m.method === "config/read")
    send({
      id: m.id,
      result: {
        config: { approval_policy: "never", sandbox_mode: "workspace-write" },
      },
    });
  if (m.method === "thread/start" || m.method === "thread/resume")
    send({
      id: m.id,
      result: {
        thread: { id: "native-thread" },
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite" },
        model: "fixture-model",
        modelProvider: "fixture",
        reasoningEffort: null,
        serviceTier: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "fixture-model",
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
  if (m.method === "turn/interrupt") send({ id: m.id, result: {} });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "native-turn" } } });
    if (mode === "terminal-before-consumption") {
      terminal();
      return;
    }
    if (mode !== "missing-request")
      setTimeout(
        () =>
          send({
            id: "native-id",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "native-thread",
              turnId: "native-turn",
              itemId: "native-item",
              isBlocking: false,
              autoResolutionMs: null,
              questions: [
                {
                  id: "delivery",
                  header: "Delivery",
                  question: "Select delivery",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "Local", description: "Local output" },
                    { label: "Remote", description: "Remote output" },
                  ],
                },
              ],
            },
          }),
        mode === "delayed-native" ? 100 : 0,
      );
  }
  if (m.id === "native-id" && m.result) {
    send({
      method: "serverRequest/resolved",
      params: { threadId: "native-thread", requestId: "native-id" },
    });
    if (mode !== "missing-report")
      send({
        id: "service-report",
        method: "item/tool/call",
        params: {
          threadId:
            mode === "foreign-report" ? "foreign-thread" : "native-thread",
          turnId: "native-turn",
          callId: "service-report",
          tool: "ui07_report_answers",
          arguments:
            mode === "malformed-report"
              ? { answers: {} }
              : { answers: m.result.answers },
        },
      });
  }
  if (m.id === "service-report" && m.result) terminal();
});
