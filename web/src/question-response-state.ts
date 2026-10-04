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
export class QuestionResponseState {
  readonly lifecycle = new CommandLifecycle<OperatorCommand>();
  readonly form: QuestionForm;
  readonly revision: number;
  answers: QuestionAnswers;
  errors: Record<string, string> = {};
  notice = "";
  sending = false;
  scrollTop = 0;
  focusId: string | null = null;
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
    this.errors = {};
    try {
      validateQuestionAnswers(this.form, this.answers);
      return true;
    } catch (error) {
      const parsed = error as {
        issues?: Array<{ path: PropertyKey[]; message: string }>;
      };
      for (const issue of parsed.issues ?? []) {
        const id = String(issue.path[0] ?? "");
        this.errors[id] = issue.message;
      }
      if (!Object.keys(this.errors).length)
        this.errors[""] = "Answer validation failed";
      return false;
    }
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
