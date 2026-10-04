import { z } from "zod";

export const questionPayloadLimit = 256 * 1024;
const identity = z.string().min(1).max(512);
const prose = z.string().max(16000);
const count = z.number().int().min(0).max(101);
const option = z
  .object({ id: identity, label: identity, description: prose.optional() })
  .strict();
const common = {
  id: identity,
  label: identity,
  description: prose.optional(),
  required: z.boolean(),
  maxLength: z.number().int().min(0).max(16000).optional(),
  minLength: z.number().int().min(0).max(16000).optional(),
};
const choices = {
  options: z.array(option).min(1).max(100),
  customAllowed: z.boolean(),
  recommended: z.array(identity).max(100).optional(),
  preselected: z.array(identity).max(100).optional(),
};
export function canSupplyCustomText(question: {
  customAllowed: boolean;
  maxLength?: number | undefined;
  minLength?: number | undefined;
}) {
  return (
    question.customAllowed &&
    (question.maxLength ?? 16000) >= Math.max(1, question.minLength ?? 0)
  );
}
export const questionFormSchema = z
  .object({
    version: z.literal(1),
    questions: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...common,
              kind: z.literal("free-text"),
              preselected: prose.optional(),
            })
            .strict(),
          z
            .object({ ...common, ...choices, kind: z.literal("single-choice") })
            .strict(),
          z
            .object({
              ...common,
              ...choices,
              kind: z.literal("multiple-choice"),
              minSelections: count.optional(),
              maxSelections: count.optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((form, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const ids = new Set<string>();
    form.questions.forEach((q, i) => {
      const path = ["questions", i];
      if (ids.has(q.id)) issue([...path, "id"], "Duplicate question identity");
      ids.add(q.id);
      if ((q.minLength ?? 0) > (q.maxLength ?? 16000))
        issue(path, "Invalid text constraints");
      if (q.kind === "free-text") {
        if (q.required && (q.maxLength ?? 16000) === 0)
          issue(path, "Required text must allow a nonempty answer");
        return;
      }
      const options = new Set(q.options.map((o) => o.id));
      if (options.size !== q.options.length)
        issue([...path, "options"], "Duplicate option identity");
      for (const key of ["recommended", "preselected"] as const) {
        const values = q[key] ?? [];
        if (
          new Set(values).size !== values.length ||
          values.some((v) => !options.has(v)) ||
          (q.kind === "single-choice" && values.length > 1)
        )
          issue([...path, key], "Invalid option identities");
      }
      if (q.kind === "multiple-choice") {
        const customAvailable = canSupplyCustomText(q);
        const available = q.options.length + Number(customAvailable);
        const minimum = Math.max(
          Number(q.required),
          q.minSelections ?? Number(q.required),
        );
        if (
          minimum > (q.maxSelections ?? available) ||
          (q.maxSelections ?? available) > available
        )
          issue(path, "Invalid selection constraints");
      }
    });
    if (
      new TextEncoder().encode(JSON.stringify(form)).byteLength >
      questionPayloadLimit
    )
      issue([], "Question payload exceeds limit");
  });
export type QuestionForm = z.infer<typeof questionFormSchema>;
export const questionAnswersSchema = z
  .record(
    identity,
    z.object({ optionIds: z.array(identity).max(100), text: prose }).strict(),
  )
  .superRefine((answers, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(answers)).byteLength >
      questionPayloadLimit
    )
      ctx.addIssue({ code: "custom", message: "Answer payload exceeds limit" });
  });
export type QuestionAnswers = z.infer<typeof questionAnswersSchema>;
export function validateQuestionAnswers(
  form: QuestionForm,
  input: unknown,
): QuestionAnswers {
  const answers = questionAnswersSchema.parse(input);
  const errors: z.core.$ZodIssue[] = [];
  const issue = (id: string, message: string) =>
    errors.push({ code: "custom", path: [id], message });
  if (
    Object.keys(answers).length !== form.questions.length ||
    Object.keys(answers).some((id) => !form.questions.some((q) => q.id === id))
  )
    issue("", "Incomplete or unknown answer identities");
  for (const q of form.questions) {
    const answer = answers[q.id];
    if (!answer) {
      issue(
        q.id,
        "Answer is required (optional questions use an explicit empty answer)",
      );
      continue;
    }
    const { optionIds, text } = answer;
    const empty = !optionIds.length && !text.length;
    if (empty && !q.required) continue;
    if (q.required && empty) {
      issue(q.id, "Answer is required");
      continue;
    }
    if (
      text.length > (q.maxLength ?? 16000) ||
      (text.length > 0 && text.length < (q.minLength ?? 0))
    )
      issue(q.id, "Text length is outside the requested bounds");
    if (q.kind === "free-text") {
      if (optionIds.length || text.length < (q.minLength ?? 0))
        issue(q.id, "Invalid free-text answer");
    } else {
      if (
        new Set(optionIds).size !== optionIds.length ||
        optionIds.some((id) => !q.options.some((o) => o.id === id)) ||
        (text.length > 0 && !q.customAllowed)
      )
        issue(q.id, "Invalid selected option or custom text");
      const selections = optionIds.length + Number(text.length > 0);
      if (q.kind === "single-choice" && selections > 1)
        issue(q.id, "Choose one option or custom text");
      if (
        q.kind === "multiple-choice" &&
        (selections < (q.minSelections ?? Number(q.required)) ||
          selections >
            (q.maxSelections ??
              q.options.length + Number(canSupplyCustomText(q))))
      )
        issue(q.id, "Selection count is outside the requested bounds");
    }
  }
  if (errors.length) throw new z.ZodError(errors);
  return answers;
}
export const questionToolArgumentsSchema = z.union([
  z.object({ question: z.string().min(1).max(16000) }).strict(),
  z.object({ form: questionFormSchema }).strict(),
]);

export function nativeQuestionForm(
  questions: import("./structured-questions.js").StructuredQuestionSet,
): QuestionForm {
  return questionFormSchema.parse({
    version: 1,
    questions: questions.map((q) => ({
      id: q.id,
      kind: "single-choice",
      label: q.header,
      description: q.question,
      required: true,
      customAllowed: q.isOther,
      options: q.options.map((o, i) => ({
        id: String(i),
        label: o.label,
        description: o.description,
      })),
    })),
  });
}
export function nativeQuestionAnswers(
  form: QuestionForm,
  answers: QuestionAnswers,
): import("./structured-questions.js").StructuredQuestionAnswers {
  validateQuestionAnswers(form, answers);
  return Object.fromEntries(
    form.questions.map((q) => {
      const answer = answers[q.id]!;
      return [
        q.id,
        {
          answers: [
            answer.text ||
              (q.kind !== "free-text"
                ? q.options.find((o) => o.id === answer.optionIds[0])?.label
                : undefined) ||
              "",
          ],
        },
      ];
    }),
  );
}
