import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseNativeInputRequest,
  encodeNativeInputReply,
  type NativeInputProtocolQualification,
} from "../src/standalone/native-input.js";
const qualification: NativeInputProtocolQualification = {
  codexVersion: "codex-cli 0.159.0",
  executableHash: "a".repeat(64),
  threadId: "thread",
  runtimeGeneration: "process",
  mode: "default",
  model: "model",
  modelProvider: "provider",
  reasoningEffort: null,
  serviceTier: null,
  developerInstructionsDigest: "b".repeat(64),
  continuation: "synchronous",
};
const input = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  isBlocking: false,
  autoResolutionMs: null,
  questions: [
    {
      id: "where",
      header: "Location",
      question: "Where?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Local", description: "Here" },
        { label: "Remote", description: "There" },
      ],
    },
  ],
};
test("qualified native choice preserves source text and validates a complete exact answer", () => {
  const request = parseNativeInputRequest(input, qualification);
  assert.deepEqual(request.questions, input.questions);
  assert.deepEqual(
    encodeNativeInputReply(request, {
      where: { answers: ["Custom location"] },
    }),
    { answers: { where: { answers: ["Custom location"] } } },
  );
  assert.throws(() =>
    encodeNativeInputReply(request, {
      where: { answers: ["Local", "Remote"] },
    }),
  );
  assert.throws(() => encodeNativeInputReply(request, {}));
});
for (const [name, change] of Object.entries({
  secret: { questions: [{ ...input.questions[0], isSecret: true }] },
  standalone: { questions: [{ ...input.questions[0], options: null }] },
  multiple: { questions: [{ ...input.questions[0], multiple: true }] },
  recommended: { questions: [{ ...input.questions[0], recommended: "Local" }] },
  duplicateIds: { questions: [input.questions[0], input.questions[0]] },
  duplicateLabels: {
    questions: [
      {
        ...input.questions[0],
        options: [
          input.questions[0]?.options[0],
          input.questions[0]?.options[0],
        ],
      },
    ],
  },
  blocking: { isBlocking: true },
  timed: { autoResolutionMs: 100 },
  foreign: { threadId: "other" },
  tooLong: { itemId: "a".repeat(513) },
}))
  test(`native shape ${name} is explicitly unsupported`, () =>
    assert.throws(() =>
      parseNativeInputRequest({ ...input, ...change }, qualification),
    ));
test("group answers are all-or-nothing and custom text is rejected without permission", () => {
  const request = parseNativeInputRequest(
    {
      ...input,
      questions: [
        { ...input.questions[0], isOther: false },
        { ...input.questions[0], id: "second" },
      ],
    },
    qualification,
  );
  assert.throws(() =>
    encodeNativeInputReply(request, {
      where: { answers: ["custom"] },
      second: { answers: ["Local"] },
    }),
  );
  assert.throws(() =>
    encodeNativeInputReply(request, { where: { answers: ["Local"] } }),
  );
  assert.throws(() =>
    encodeNativeInputReply(request, {
      where: { answers: ["Local"] },
      second: { answers: ["Local"] },
      unknown: { answers: ["Local"] },
    }),
  );
  assert.deepEqual(
    encodeNativeInputReply(request, {
      where: { answers: ["Local"] },
      second: { answers: ["Remote"] },
    }).answers.second,
    { answers: ["Remote"] },
  );
});
