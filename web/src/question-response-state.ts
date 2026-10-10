import {
  validateQuestionAnswers,
  type QuestionAnswers,
  type QuestionForm,
} from "../../src/core/question-forms.js";
import type {
  OperatorCommand,
  QuestionRead,
  CommandReceipt,
} from "../../src/operator/contracts.js";
import { CommandLifecycle } from "./command-lifecycle.js";

/** Validation issues by question id (`""` for the form), empty when the answers are valid. */
function answerIssues(form: QuestionForm, answers: QuestionAnswers) {
  const errors: Record<string, string> = Object.create(null);
  try {
    validateQuestionAnswers(form, answers);
  } catch (error) {
    const parsed = error as {
      issues?: Array<{ path: PropertyKey[]; message: string }>;
    };
    for (const issue of parsed.issues ?? [])
      errors[String(issue.path[0] ?? "")] = issue.message;
    if (!Object.keys(errors).length) errors[""] = "Answer validation failed";
  }
  return errors;
}

/** Questions whose current answer is valid; an empty optional question counts as complete. */
export function completedQuestionCount(
  form: QuestionForm,
  answers: QuestionAnswers,
) {
  const errors = answerIssues(form, answers);
  return form.questions.filter((q) => !(q.id in errors)).length;
}

/** What the operator selected per question ("Q1 · Red + Home"), and the numbers that still need an answer. */
export function answerSummary(form: QuestionForm, answers: QuestionAnswers) {
  const errors = answerIssues(form, answers),
    lines: string[] = [],
    missing: string[] = [];
  form.questions.forEach((q, index) => {
    const answer = answers[q.id],
      parts = [
        ...(q.kind === "free-text"
          ? []
          : (answer?.optionIds ?? []).map(
              (id) => q.options.find((o) => o.id === id)?.label ?? id,
            )),
        ...(answer?.text ? [answer.text] : []),
      ];
    if (parts.length) lines.push(`Q${index + 1} · ${parts.join(" + ")}`);
    if (q.id in errors) missing.push(`Q${index + 1}`);
  });
  return { lines, missing };
}

export type QuestionOutcome = "recorded" | "unknown" | "conflict" | "failed";
export class QuestionResponseState {
  readonly lifecycle = new CommandLifecycle<OperatorCommand>();
  readonly form: QuestionForm;
  readonly revision: number;
  answers: QuestionAnswers;
  errors: Record<string, string> = Object.create(null);
  notice = "";
  sending = false;
  scrollTop = 0;
  focusId: string | null = null;
  /** How the last submission ended; null until one settles. */
  outcome: QuestionOutcome | null = null;
  recordedAt: number | null = null;
  constructor(data: QuestionRead["data"]) {
    if (!data.form) throw Error("Unavailable form");
    this.form = structuredClone(data.form);
    this.revision = data.revision;
    this.answers = data.answers
      ? structuredClone(data.answers)
      : Object.fromEntries(
          this.form.questions.map((q) => [
            q.id,
            {
              optionIds:
                q.kind === "free-text" ? [] : [...(q.preselected ?? [])],
              text: q.kind === "free-text" ? (q.preselected ?? "") : "",
            },
          ]),
        );
  }
  validate() {
    this.errors = answerIssues(this.form, this.answers);
    return !Object.keys(this.errors).length;
  }
  matches(command: OperatorCommand, receipt: CommandReceipt) {
    return (
      "taskId" in command &&
      "interactionId" in command &&
      receipt.key === command.key &&
      (receipt.kind === "native-question"
        ? receipt.taskId === command.taskId &&
          receipt.interactionId === command.interactionId
        : receipt.kind === "coordination" &&
          receipt.taskId === command.taskId &&
          receipt.eventType === "question-answer")
    );
  }
  setAnswer(id: string, value: QuestionAnswers[string]) {
    if (this.sending || this.lifecycle.uncertain || this.lifecycle.receipt)
      return;
    this.answers = { ...this.answers, [id]: structuredClone(value) };
    delete this.errors[id];
  }
}
export class QuestionResponseStates {
  private states = new Map<string, QuestionResponseState>();
  private listeners = new Set<() => void>();
  forQuestion(data: QuestionRead["data"]) {
    const key = `${data.taskId}:${data.interactionId}`;
    let state = this.states.get(key);
    if (!state) {
      state = new QuestionResponseState(data);
      this.states.set(key, state);
    }
    return state;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
  purge() {
    this.states.clear();
    this.changed();
  }
}
