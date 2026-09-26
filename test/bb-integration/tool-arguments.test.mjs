import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolArguments } from "./fixture/tool-arguments.ts";

test("scripted tool arguments retain objects and default to empty", () => {
  const input = {
    id: "assignment",
    result: "A result with spaces and Unicode ✓",
  };
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
  assert.deepEqual(
    parseToolArguments(`call_tool:report tool_args:${encoded}`),
    input,
  );
  assert.deepEqual(parseToolArguments("call_tool:capability_ping"), {});
});

test("scripted tool arguments reject malformed, ambiguous and oversized input", () => {
  for (const value of [null, [], "text", 1]) {
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    assert.throws(() => parseToolArguments(`tool_args:${encoded}`), /object/);
  }
  for (const input of [
    "tool_args:!",
    "tool_args:",
    "tool_args:e30=",
    "tool_args:e30 tool_args:e30",
  ])
    assert.throws(() => parseToolArguments(input), /tool_args/);
  assert.throws(
    () => parseToolArguments(`tool_args:${"a".repeat(65537)}`),
    /size/,
  );
  assert.throws(() => parseToolArguments("tool_args:eA"), /JSON/);
});
