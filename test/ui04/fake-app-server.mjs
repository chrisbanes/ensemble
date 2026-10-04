#!/usr/bin/env node
import { createInterface } from "node:readline";
const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let turns = 0,
  threads = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") write({ id: m.id, result: {} });
  else if (m.method === "account/read")
    write({ id: m.id, result: { account: { type: "chatgpt" } } });
  else if (m.method === "config/read")
    write({
      id: m.id,
      result: {
        config: { approval_policy: "never", sandbox_mode: "workspace-write" },
      },
    });
  else if (m.method === "thread/start") {
    if (++threads !== 1) process.exit(4);
    write({
      id: m.id,
      result: {
        thread: { id: "ui04-thread" },
        model: "fixture-model",
        modelProvider: "fixture",
        reasoningEffort: "medium",
        serviceTier: null,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite" },
      },
    });
  } else if (m.method === "thread/resume")
    write({
      id: m.id,
      error: { code: -32600, message: "no rollout before first turn" },
    });
  else if (m.method === "turn/start") {
    if (++turns !== 1) process.exit(4);
    const text = m.params.input.map((x) => x.text ?? "").join("\n"),
      marker = text
        .split("\n")
        .find((x) => x.startsWith("UI04_CALLBACK_JSON="));
    if (!marker) process.exit(5);
    write({ id: m.id, result: { turn: { id: "ui04-turn" } } });
    setTimeout(
      () =>
        write({
          id: "ui04-report",
          method: "item/tool/call",
          params: {
            threadId: "ui04-thread",
            turnId: "ui04-turn",
            callId: "ui04-call",
            tool: "ensemble_report_result",
            arguments: {
              ...JSON.parse(marker.slice("UI04_CALLBACK_JSON=".length)),
              ...(process.env.UI04_FIXTURE_MALFORMED === "1"
                ? { summary: "wrong material" }
                : {}),
            },
          },
        }),
      Number(process.env.UI04_FIXTURE_DELAY ?? 25),
    );
  } else if (m.id === "ui04-report") {
    write({
      method: "turn/completed",
      params: {
        threadId: "ui04-thread",
        turn: { id: "ui04-turn", status: "completed" },
      },
    });
  } else if (m.method === "turn/interrupt") write({ id: m.id, result: {} });
  else if (m.method && m.id !== undefined)
    write({
      id: m.id,
      error: { code: -32601, message: "unsupported fixture method" },
    });
}
