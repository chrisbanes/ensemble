import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  QuestionResponseStates,
  answerSummary,
  completedQuestionCount,
} from "../web/src/question-response-state.js";
import { mixedForm, mixedAnswers } from "./fixtures/question-data.js";
import type { QuestionRead } from "../src/operator/contracts.js";
const data: QuestionRead["data"] = {
  taskId: randomUUID(),
  interactionId: randomUUID(),
  requestingAssignmentId: randomUUID(),
  conversationRevision: 1,
  revision: 1,
  source: "ensemble",
  status: "pending",
  form: mixedForm,
  answers: null,
  reason: null,
  deliveryState: null,
};
test("shared response draft preselection never freezes a command and survives entry changes until auth purge", () => {
  const states = new QuestionResponseStates(),
    state = states.forQuestion(data);
  assert.deepEqual(state.answers.color?.optionIds, ["red"]);
  assert.equal(state.lifecycle.bytes, null);
  assert.equal(state.validate(), false);
  assert.ok(state.errors.notes);
  state.answers = structuredClone(mixedAnswers);
  assert.equal(state.validate(), true);
  state.scrollTop = 122;
  assert.equal(states.forQuestion({ ...data, revision: 2 }), state);
  assert.equal(state.revision, 1);
  const command = {
    type: "question.form.answer" as const,
    key: randomUUID(),
    taskId: data.taskId,
    interactionId: data.interactionId,
    expectedRevision: 1,
    answers: state.answers,
  };
  assert.equal(state.lifecycle.freeze(command), true);
  state.lifecycle.begin();
  state.lifecycle.settle(
    { state: "unknown", command, code: "command-outcome-unknown" },
    () => false,
  );
  const bytes = state.lifecycle.bytes;
  state.setAnswer("notes", { optionIds: [], text: "Changed" });
  assert.equal(state.answers.notes?.text, mixedAnswers.notes.text);
  assert.equal(state.lifecycle.bytes, bytes);
  assert.deepEqual(state.lifecycle.begin(), command);
  states.purge();
  const clean = states.forQuestion(data);
  assert.notEqual(clean, state);
  assert.equal(clean.lifecycle.bytes, null);
  assert.equal(clean.scrollTop, 0);
});

test("oversized aggregate drafts remain editable and validation reports the aggregate bound", () => {
  const form = {
    version: 1 as const,
    questions: Array.from({ length: 32 }, (_, i) => ({
      id: String(i),
      kind: "free-text" as const,
      label: `Notes ${i}`,
      required: true,
    })),
  };
  const state = new QuestionResponseStates().forQuestion({ ...data, form });
  for (const question of form.questions)
    state.setAnswer(question.id, { optionIds: [], text: "界".repeat(16000) });
  assert.equal(state.validate(), false);
  assert.ok(state.errors[""]);
  state.setAnswer("0", { optionIds: [], text: "Changed draft" });
  assert.equal(state.answers["0"]?.text, "Changed draft");
  assert.equal(state.lifecycle.bytes, null);
});

test("missing prototype-shaped IDs retain own field validation errors", () => {
  const form = {
      version: 1 as const,
      questions: [
        {
          id: "__proto__",
          kind: "free-text" as const,
          label: "Literal",
          required: true,
        },
      ],
    },
    state = new QuestionResponseStates().forQuestion({ ...data, form });
  state.answers = {};
  assert.equal(state.validate(), false);
  assert.equal(Object.hasOwn(state.errors, "__proto__"), true);
  // biome-ignore lint/suspicious/noProto: verifies an own "__proto__" answer key.
  assert.ok(state.errors.__proto__?.includes("required"));
  state.setAnswer("__proto__", { optionIds: [], text: "Valid" });
  assert.equal(state.validate(), true);
});

test("progress counts valid answers, an empty optional question counts, and the summary lists what is missing", () => {
  const states = new QuestionResponseStates(),
    state = states.forQuestion(data);
  state.answers = {
    notes: { optionIds: [], text: "" },
    color: { optionIds: [], text: "" },
    places: { optionIds: [], text: "" },
    optional: { optionIds: [], text: "" },
  };
  // Only the optional question is complete while nothing else is answered.
  assert.equal(completedQuestionCount(state.form, state.answers), 1);
  state.answers = { ...state.answers, notes: { optionIds: [], text: "Hello" } };
  assert.equal(completedQuestionCount(state.form, state.answers), 2);
  state.answers = {
    ...state.answers,
    color: { optionIds: ["blue"], text: "" },
  };
  assert.equal(completedQuestionCount(state.form, state.answers), 3);
  state.answers = structuredClone(mixedAnswers);
  assert.equal(completedQuestionCount(state.form, state.answers), 4);
  assert.deepEqual(answerSummary(state.form, state.answers), {
    lines: ["Q1 · Exact text", "Q2 · Blue", "Q3 · Home + Other exact place"],
    missing: [],
  });
  state.answers = { ...state.answers, places: { optionIds: [], text: "" } };
  assert.deepEqual(answerSummary(state.form, state.answers).missing, ["Q3"]);
  assert.equal(state.outcome, null);
});
