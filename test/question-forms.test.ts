import assert from "node:assert/strict";
import { test } from "node:test";
import {
  questionFormSchema,
  validateQuestionAnswers,
} from "../src/core/question-forms.js";
import { mixedForm, mixedAnswers } from "./fixtures/question-data.js";
test("full form retains exact labels, recommendations and explicit empty optional answers", () => {
  assert.deepEqual(questionFormSchema.parse(mixedForm), mixedForm);
  assert.deepEqual(
    validateQuestionAnswers(mixedForm, mixedAnswers),
    mixedAnswers,
  );
  const custom = structuredClone(mixedAnswers);
  custom.color = { optionIds: [], text: "  custom  " };
  assert.equal(
    validateQuestionAnswers(mixedForm, custom).color?.text,
    "  custom  ",
  );
});
test("stored-schema constraints reject unknown, duplicate, incomplete and disallowed answers with affected question paths", () => {
  for (const answer of [
    { ...mixedAnswers, notes: { optionIds: [], text: "x" } },
    { ...mixedAnswers, color: { optionIds: ["unknown"], text: "" } },
    { ...mixedAnswers, places: { optionIds: ["home", "home"], text: "" } },
    {
      ...mixedAnswers,
      places: { optionIds: ["home", "work"], text: "custom" },
    },
    { ...mixedAnswers, color: { optionIds: ["blue"], text: "custom" } },
    { notes: mixedAnswers.notes },
  ])
    assert.throws(() => validateQuestionAnswers(mixedForm, answer));
  const noCustom = structuredClone(mixedForm);
  const color = noCustom.questions[1];
  if (color?.kind !== "free-text" && color) color.customAllowed = false;
  assert.throws(() =>
    validateQuestionAnswers(noCustom, {
      ...mixedAnswers,
      color: { optionIds: [], text: "custom" },
    }),
  );
});
test("schema enforces identities, bounds, cardinality and aggregate UTF8 limits", () => {
  const duplicate = structuredClone(mixedForm);
  duplicate.questions.push(mixedForm.questions[0]!);
  assert.throws(() => questionFormSchema.parse(duplicate));
  const invalid = structuredClone(mixedForm);
  const q = invalid.questions[1];
  if (q && q.kind !== "free-text") q.recommended = ["missing"];
  assert.throws(() => questionFormSchema.parse(invalid));
  for (const changes of [
    { label: "x".repeat(513) },
    { minLength: 10, maxLength: 1 },
  ])
    assert.throws(() =>
      questionFormSchema.parse({
        ...mixedForm,
        questions: [{ ...mixedForm.questions[0], ...changes }],
      }),
    );
  const huge = {
    version: 1,
    questions: Array.from({ length: 32 }, (_, i) => ({
      id: String(i),
      kind: "free-text",
      label: "Text",
      description: "界".repeat(16000),
      required: true,
    })),
  };
  assert.throws(() => questionFormSchema.parse(huge));
});

test("constraints reject required zero-capacity forms and custom text that cannot satisfy cardinality", () => {
  const text = {
    id: "q",
    kind: "free-text" as const,
    label: "Text",
    required: true,
    maxLength: 0,
  };
  assert.throws(() =>
    questionFormSchema.parse({ version: 1, questions: [text] }),
  );
  const multi = {
    id: "q",
    kind: "multiple-choice" as const,
    label: "Choices",
    required: true,
    options: [{ id: "one", label: "One" }],
    customAllowed: false,
    minSelections: 0,
    maxSelections: 0,
  };
  assert.throws(() =>
    questionFormSchema.parse({ version: 1, questions: [multi] }),
  );
  assert.throws(() =>
    questionFormSchema.parse({
      version: 1,
      questions: [
        {
          ...multi,
          options: Array.from({ length: 100 }, (_, i) => ({
            id: String(i),
            label: `Option ${i}`,
          })),
          customAllowed: true,
          maxLength: 0,
          minSelections: 101,
          maxSelections: 101,
        },
      ],
    }),
  );
  const optional = questionFormSchema.parse({
    version: 1,
    questions: [{ ...text, required: false }],
  });
  assert.deepEqual(
    validateQuestionAnswers(optional, { q: { optionIds: [], text: "" } }),
    { q: { optionIds: [], text: "" } },
  );
  const optionalChoices = questionFormSchema.parse({
    version: 1,
    questions: [{ ...multi, required: false }],
  });
  assert.deepEqual(
    validateQuestionAnswers(optionalChoices, {
      q: { optionIds: [], text: "" },
    }),
    { q: { optionIds: [], text: "" } },
  );
  const choice = questionFormSchema.parse({
    version: 1,
    questions: [
      {
        ...multi,
        customAllowed: true,
        maxLength: 0,
        minSelections: 1,
        maxSelections: 1,
      },
    ],
  });
  assert.deepEqual(
    validateQuestionAnswers(choice, { q: { optionIds: ["one"], text: "" } }),
    { q: { optionIds: ["one"], text: "" } },
  );
});

test("literal prototype-shaped question IDs preserve supplied JSON entries and missing IDs produce field issues", () => {
  const form = questionFormSchema.parse({
    version: 1,
    questions: ["__proto__", "constructor", "toString"].map((id) => ({
      id,
      kind: "free-text",
      label: id,
      required: true,
    })),
  });
  const answers = Object.fromEntries(
    form.questions.map((q) => [q.id, { optionIds: [], text: "Valid answer" }]),
  );
  const parsed = validateQuestionAnswers(
    form,
    JSON.parse(JSON.stringify(answers)),
  );
  assert.deepEqual(parsed, answers);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.throws(
    () => validateQuestionAnswers(form, {}),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError" &&
      "issues" in error &&
      (error.issues as Array<{ path: unknown[] }>).some(
        (issue) => issue.path[0] === "__proto__",
      ),
  );
  assert.throws(
    () =>
      validateQuestionAnswers(
        form,
        Object.create({
          constructor: { optionIds: [], text: "Inherited answer" },
        }),
      ),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError",
  );
});
