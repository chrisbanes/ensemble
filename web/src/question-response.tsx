import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  questionReadSchema,
  operatorCommandSchema,
  type Session,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import {
  nativeQuestionAnswers,
  canSupplyCustomText,
} from "../../src/core/question-forms.js";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { Textarea } from "./ui/textarea.js";
import type { QuestionResponseStates } from "./question-response-state.js";
export function QuestionResponse({
  client,
  session,
  taskId,
  interactionId,
  states,
  onRecorded,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  interactionId: string;
  states: QuestionResponseStates;
  onRecorded?: () => void;
}) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/tasks/${taskId}/questions/${interactionId}`,
        questionReadSchema,
        signal,
      ),
    [client, taskId, interactionId],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:question:${taskId}:${interactionId}`,
      loader,
    ),
    data = resource.state.data?.data;
  const [, render] = useState(0);
  useEffect(() => states.subscribe(() => render((v) => v + 1)), [states]);
  const content = useRef<HTMLDivElement>(null),
    formElement = useRef<HTMLFormElement>(null);
  const state = data?.form ? states.forQuestion(data) : null;
  useLayoutEffect(() => {
    if (content.current && state) {
      content.current.scrollTop = state.scrollTop;
      if (state.focusId)
        document.getElementById(state.focusId)?.focus({ preventScroll: true });
    }
  }, [state]);
  const sameForm =
    state &&
    data?.form &&
    JSON.stringify(state.form) === JSON.stringify(data.form);
  const frozen = Boolean(
    state?.sending || state?.lifecycle.uncertain || state?.lifecycle.receipt,
  );
  const canEdit = Boolean(
    state &&
      data?.status === "pending" &&
      sameForm &&
      state.revision === data.revision &&
      !frozen &&
      resource.state.status === "fresh",
  );
  const submit = async () => {
    if (!state || !data) return;
    if (!state.lifecycle.uncertain) {
      if (!canEdit || !state.validate()) {
        states.changed();
        const id = Object.keys(state.errors)[0];
        (id
          ? formElement.current?.querySelector<HTMLElement>(
              `[data-question-id="${CSS.escape(id)}"]`,
            )
          : formElement.current?.querySelector<HTMLElement>(
              "[data-question-id]",
            )
        )?.focus();
        return;
      }
      const command: OperatorCommand =
        data.source === "native"
          ? {
              type: "question.native.answer",
              key: crypto.randomUUID(),
              taskId,
              interactionId,
              expectedRevision: state.revision,
              answers: nativeQuestionAnswers(state.form, state.answers),
            }
          : data.source === "plain"
            ? {
                type: "question.answer",
                key: crypto.randomUUID(),
                taskId,
                interactionId,
                expectedRevision: state.revision,
                answer: state.answers.answer?.text ?? "",
              }
            : {
                type: "question.form.answer",
                key: crypto.randomUUID(),
                taskId,
                interactionId,
                expectedRevision: state.revision,
                answers: state.answers,
              };
      if (!state.lifecycle.freeze(operatorCommandSchema.parse(command))) return;
    }
    const command = state.lifecycle.begin();
    if (!command) return;
    const currentAuthentication = client.captureAuthenticationScope();
    state.sending = true;
    state.notice = "Recording answer…";
    states.changed();
    const result = await client.command(command, session.csrfToken);
    if (!currentAuthentication()) return;
    state.sending = false;
    const disposition = state.lifecycle.settle(result, (c, r) =>
      state.matches(c, r),
    );
    state.notice =
      disposition === "recorded"
        ? "Answer recorded. Delivery and admission remain subject to independent holds."
        : disposition === "unknown"
          ? "Outcome unknown. Original answer and key are frozen; reconcile before editing."
          : disposition === "conflict"
            ? "Request is stale, cancelled or already answered. Your input is retained."
            : `Answer failed (${result.state === "recorded" ? "invalid-receipt" : result.code}). Your input is retained.`;
    states.changed();
    if (disposition === "recorded") {
      resource.refresh();
      onRecorded?.();
    } else if (disposition === "conflict") resource.refresh();
  };
  return (
    <section
      className="question-response"
      aria-label="Exact question response"
      data-record-id={interactionId}
    >
      <ResourceStatus state={resource.state} retry={resource.refresh} />
      {data && (
        <>
          <div className="question-context">
            <StatusBadge>{data.status}</StatusBadge>
            <p>
              Requester: assignment {data.requestingAssignmentId}. Conversation
              revision {data.conversationRevision}.
            </p>
            <ActionLink
              href={`/app/tasks/${taskId}?assignment=${data.requestingAssignmentId}#history`}
            >
              Requesting conversation
            </ActionLink>
            <ActionLink
              href={`/app/tasks/${taskId}?request=${interactionId}#history`}
            >
              Question evidence
            </ActionLink>
          </div>
          {data.reason && <p role="alert">{data.reason}</p>}
          {data.deliveryState && <p>{data.deliveryState}</p>}
          {!state ? (
            <p>Exact form unavailable. This request remains unresolved.</p>
          ) : (
            <form
              ref={formElement}
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {!sameForm && (
                <p role="alert">
                  Request schema changed. Original input is retained; it cannot
                  be retargeted.
                </p>
              )}
              <div
                className="question-content"
                ref={content}
                onScroll={(e) => {
                  state.scrollTop = e.currentTarget.scrollTop;
                }}
              >
                {state.form.questions.map((q) => {
                  const answer = (data.status === "recorded" && data.answers
                      ? data.answers
                      : state.answers)[q.id] ?? { optionIds: [], text: "" },
                    error = state.errors[q.id],
                    qid = `question-${interactionId}-${q.id}`;
                  const update = (optionIds: string[], text: string) => {
                    state.setAnswer(q.id, { optionIds, text });
                    states.changed();
                  };
                  return (
                    <fieldset
                      key={q.id}
                      tabIndex={-1}
                      data-question-id={q.id}
                      className="question-field"
                      aria-describedby={error ? `${qid}-error` : undefined}
                      onFocusCapture={(e) => {
                        state.focusId = (e.target as HTMLElement).id || null;
                      }}
                    >
                      <legend>
                        {q.label}
                        {q.required ? " (required)" : " (optional)"}
                      </legend>
                      {q.description && (
                        <p className="literal">{q.description}</p>
                      )}
                      {q.kind === "free-text" ? (
                        <label htmlFor={qid}>
                          {q.label}
                          <Textarea
                            id={qid}
                            value={answer.text}
                            disabled={!canEdit}
                            maxLength={q.maxLength ?? 16000}
                            onChange={(e) => update([], e.target.value)}
                          />
                        </label>
                      ) : (
                        <>
                          {q.options.map((option, i) => (
                            <label
                              className="question-option"
                              key={option.id}
                              htmlFor={`${qid}-${i}`}
                            >
                              <input
                                id={`${qid}-${i}`}
                                type={
                                  q.kind === "single-choice"
                                    ? "radio"
                                    : "checkbox"
                                }
                                name={qid}
                                disabled={!canEdit}
                                checked={answer.optionIds.includes(option.id)}
                                onChange={(e) => {
                                  const ids =
                                    q.kind === "single-choice"
                                      ? [option.id]
                                      : e.target.checked
                                        ? [...answer.optionIds, option.id]
                                        : answer.optionIds.filter(
                                            (id) => id !== option.id,
                                          );
                                  update(
                                    ids,
                                    q.kind === "single-choice"
                                      ? ""
                                      : answer.text,
                                  );
                                }}
                              />
                              <span>
                                {option.label}
                                {q.recommended?.includes(option.id) && (
                                  <span className="recommendation">
                                    {" "}
                                    Recommended
                                  </span>
                                )}
                                {option.description && (
                                  <span className="option-description literal">
                                    {option.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                          {q.kind === "multiple-choice" && (
                            <p>
                              Choose {q.minSelections ?? Number(q.required)} to{" "}
                              {q.maxSelections ??
                                q.options.length +
                                  Number(canSupplyCustomText(q))}{" "}
                              selections.
                            </p>
                          )}
                          {canSupplyCustomText(q) && (
                            <label htmlFor={`${qid}-custom`}>
                              Custom answer: {q.label}
                              <Textarea
                                id={`${qid}-custom`}
                                disabled={!canEdit}
                                value={answer.text}
                                maxLength={q.maxLength ?? 16000}
                                onChange={(e) =>
                                  update(
                                    q.kind === "single-choice"
                                      ? []
                                      : answer.optionIds,
                                    e.target.value,
                                  )
                                }
                              />
                            </label>
                          )}
                        </>
                      )}
                      {(q.minLength !== undefined ||
                        q.maxLength !== undefined) && (
                        <p>
                          Text length: {q.minLength ?? 0}–{q.maxLength ?? 16000}{" "}
                          characters.
                        </p>
                      )}
                      {error && (
                        <p role="alert" id={`${qid}-error`}>
                          {error}
                        </p>
                      )}
                    </fieldset>
                  );
                })}
                {state.errors[""] && <p role="alert">{state.errors[""]}</p>}
              </div>
              <div className="question-submit">
                <p role="status">
                  {state.notice ||
                    "Preselected and recommended choices are drafts. Submit the complete group explicitly."}
                </p>
                <Button
                  type="submit"
                  disabled={
                    state.sending ||
                    Boolean(state.lifecycle.receipt) ||
                    (!canEdit && !state.lifecycle.uncertain)
                  }
                >
                  {state.lifecycle.uncertain
                    ? "Reconcile original answer"
                    : state.sending
                      ? "Recording…"
                      : "Submit answer"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={resource.refresh}
                >
                  Refresh request
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
