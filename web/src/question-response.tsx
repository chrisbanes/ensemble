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
  type QuestionForm,
} from "../../src/core/question-forms.js";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { Card } from "./ui/card.js";
import { Textarea } from "./ui/textarea.js";
import {
  answerSummary,
  completedQuestionCount,
  type QuestionResponseStates,
} from "./question-response-state.js";
import { clockLabel } from "./inbox-presentation.js";
export function QuestionResponse({
  client,
  session,
  taskId,
  interactionId,
  states,
  onRecorded,
  requesterName,
  onBack,
  compactContext = false,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  interactionId: string;
  states: QuestionResponseStates;
  onRecorded?: () => void;
  /** Who recommended an option; the task page does not pass it yet, so it reads "Recommended". */
  requesterName?: string | null | undefined;
  /** Leaves a recorded confirmation (the Inbox clears its detail). */
  onBack?: () => void;
  /** The caller's own intro already names the requester and links the conversation. */
  compactContext?: boolean;
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
    // The bounded Inbox detail owns question scrolling there; elsewhere the body does.
    const owner =
      content.current?.closest<HTMLElement>(".inbox-detail") ?? content.current;
    if (!owner || !state) return;
    owner.scrollTop = state.scrollTop;
    if (state.focusId)
      document.getElementById(state.focusId)?.focus({ preventScroll: true });
    const record = () => {
      state.scrollTop = owner.scrollTop;
    };
    owner.addEventListener("scroll", record);
    return () => owner.removeEventListener("scroll", record);
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
    state.outcome = disposition === "rejected" ? "failed" : disposition;
    state.failureCode =
      disposition === "rejected" && result.state !== "recorded"
        ? result.code
        : null;
    state.notice =
      disposition === "recorded"
        ? "Answer recorded. Delivery and admission remain subject to independent holds."
        : disposition === "unknown"
          ? "Outcome unknown. Original answer and key are frozen; reconcile before editing."
          : disposition === "conflict"
            ? "Request is stale, cancelled or already answered. Your input is retained."
            : "Answer not recorded. Your selection is retained. The request remains unresolved.";
    states.changed();
    if (disposition === "recorded") {
      resource.refresh();
      onRecorded?.();
    } else if (disposition === "conflict") resource.refresh();
  };
  const recorded = data?.status === "recorded" || state?.outcome === "recorded",
    staleRead = Boolean(resource.state.error && resource.state.data),
    total = state?.form.questions.length ?? 0,
    summary =
      state && data
        ? answerSummary(
            state.form,
            (recorded && data.answers ? data.answers : state.answers) ?? {},
          )
        : null,
    notice = state ? statusNotice(data?.status) : null,
    evidenceFocus = (id: string) => () => {
      if (state) state.focusId = id;
    },
    evidenceId = `question-${interactionId}-evidence`,
    conversationId = `question-${interactionId}-conversation`;
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
            {state && total > 1 && (
              <span
                className="question-progress metadata muted"
                aria-live="polite"
              >
                {completedQuestionCount(
                  state.form,
                  recorded && data.answers ? data.answers : state.answers,
                )}{" "}
                of {total} completed
              </span>
            )}
            <p className="metadata muted">
              {compactContext
                ? ""
                : `Requester: assignment ${data.requestingAssignmentId}. `}
              Conversation revision {data.conversationRevision}.
            </p>
            {!compactContext && (
              <ActionLink
                id={conversationId}
                variant="secondary"
                onFocus={evidenceFocus(conversationId)}
                href={`/app/tasks/${taskId}?assignment=${data.requestingAssignmentId}#history`}
              >
                Requesting conversation
              </ActionLink>
            )}
            <ActionLink
              id={evidenceId}
              variant="secondary"
              onFocus={evidenceFocus(evidenceId)}
              href={`/app/tasks/${taskId}?request=${interactionId}#history`}
            >
              Question evidence
            </ActionLink>
          </div>
          {notice && (
            <Card className="question-notice" role="alert">
              <h3 className="small-heading">{notice.title}</h3>
              <p className="body muted">{notice.text}</p>
              {data.reason && <p className="body">{data.reason}</p>}
              {notice.action === "refresh" ? (
                <Button variant="secondary" onClick={resource.refresh}>
                  {notice.label}
                </Button>
              ) : (
                <ActionLink variant="secondary" href={`/app/tasks/${taskId}`}>
                  {notice.label}
                </ActionLink>
              )}
            </Card>
          )}
          {!notice && data.reason && <p role="alert">{data.reason}</p>}
          {data.deliveryState && <p>{data.deliveryState}</p>}
          {!state ? (
            <p>Exact form unavailable. This request remains unresolved.</p>
          ) : recorded ? (
            <Card className="question-recorded">
              <h3 className="small-heading">Answer recorded</h3>
              {summary?.lines.map((line) => (
                <p key={line} className="body literal">
                  {line}
                </p>
              ))}
              <p className="body muted">
                Delivery waits for the requester's next eligible turn;
                independent holds are unchanged.
              </p>
              {onBack && (
                <Button variant="secondary" onClick={onBack}>
                  Back to Inbox
                </Button>
              )}
            </Card>
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
              <p className="question-hint metadata muted">
                Preselected and recommended choices are drafts. Submit the
                complete group explicitly.
              </p>
              <div
                className={`question-content ${total > 1 ? "question-content-grouped" : ""}`}
                ref={content}
              >
                {state.form.questions.map((q, questionIndex) => {
                  const answer = (data.status === "recorded" && data.answers
                      ? data.answers
                      : state.answers)[q.id] ?? { optionIds: [], text: "" },
                    error = state.errors[q.id],
                    qid = `question-${interactionId}-q${questionIndex}`;
                  const update = (optionIds: string[], text: string) => {
                    state.setAnswer(q.id, { optionIds, text });
                    states.changed();
                  };
                  return (
                    <fieldset
                      key={q.id}
                      tabIndex={-1}
                      id={`${qid}-group`}
                      data-question-id={q.id}
                      className="question-field"
                      aria-describedby={error ? `${qid}-error` : undefined}
                      onFocusCapture={(e) => {
                        state.focusId = (e.target as HTMLElement).id || null;
                      }}
                    >
                      <legend>{q.label}</legend>
                      <p className="question-constraint metadata muted">
                        {constraintLine(q)}
                      </p>
                      {q.description && (
                        <p className="literal">{q.description}</p>
                      )}
                      {q.kind === "free-text" ? (
                        <label htmlFor={`${qid}-text`}>
                          <span className="sr-only">{q.label}</span>
                          <Textarea
                            id={`${qid}-text`}
                            autoGrow
                            value={answer.text}
                            disabled={!canEdit}
                            maxLength={q.maxLength ?? 16000}
                            onChange={(e) => update([], e.target.value)}
                          />
                        </label>
                      ) : (
                        <>
                          <div className="question-options">
                            {q.options.map((option, i) => (
                              <label
                                className="question-option"
                                key={option.id}
                                htmlFor={`${qid}-option-${i}`}
                              >
                                <input
                                  id={`${qid}-option-${i}`}
                                  type={
                                    q.kind === "single-choice"
                                      ? "radio"
                                      : "checkbox"
                                  }
                                  name={`${qid}-options`}
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
                                <span className="question-option-text">
                                  <span className="question-option-label">
                                    {option.label}
                                  </span>
                                  {option.description && (
                                    <span className="option-description literal">
                                      {option.description}
                                    </span>
                                  )}
                                  {q.recommended?.includes(option.id) && (
                                    <span className="recommendation">
                                      {requesterName
                                        ? `Recommended by ${requesterName}`
                                        : "Recommended"}
                                    </span>
                                  )}
                                </span>
                              </label>
                            ))}
                          </div>
                          {canSupplyCustomText(q) && (
                            <label
                              htmlFor={`${qid}-custom`}
                              className="question-custom"
                            >
                              Custom answer: {q.label}
                              <Textarea
                                id={`${qid}-custom`}
                                autoGrow
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
                <p role="status" className="question-status">
                  {state.notice ||
                    (staleRead
                      ? `Stale read · last read ${resource.state.fetchedAt ? clockLabel(resource.state.fetchedAt) : "unknown"} · refresh to continue`
                      : draftStatus(state, summary))}
                </p>
                {state.failureCode && state.outcome === "failed" && (
                  <p className="metadata muted">Reason: {state.failureCode}</p>
                )}
                <div className="question-actions">
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
                        : state.outcome === "failed"
                          ? "Retry answer"
                          : total > 1
                            ? "Submit answers"
                            : "Submit answer"}
                  </Button>
                  <Button
                    type="button"
                    variant={staleRead ? "primary" : "secondary"}
                    onClick={resource.refresh}
                  >
                    {state.outcome === "conflict"
                      ? "Review current request"
                      : "Refresh request"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

/** "Required · select 1–2" and its siblings: what the form asks, in one line. */
function constraintLine(q: QuestionForm["questions"][number]) {
  const need = q.required ? "Required" : "Optional";
  if (q.kind === "free-text") {
    const bounds =
      q.minLength !== undefined
        ? ` · ${q.minLength}–${q.maxLength ?? 16000} characters`
        : q.maxLength !== undefined
          ? ` · up to ${q.maxLength} characters`
          : "";
    return `${need} · free text${bounds}`;
  }
  const custom = canSupplyCustomText(q);
  if (q.kind === "single-choice")
    return `${need} · choose one${custom ? " · custom text allowed" : ""}`;
  const min = q.minSelections ?? Number(q.required),
    max = q.maxSelections ?? q.options.length + Number(custom);
  return `${need} · select ${min}–${max}${custom ? " · custom text allowed" : ""}`;
}

/** What has been picked and what is still missing; never implies anything was sent. */
function draftStatus(
  state: { form: QuestionForm },
  summary: ReturnType<typeof answerSummary> | null,
) {
  if (!summary) return "";
  if (state.form.questions.length === 1)
    return summary.lines.length
      ? `Selected: ${summary.lines[0]?.replace(/^Q1 · /, "")} · unsent`
      : "Not submitted";
  return summary.missing.length
    ? `Not submitted · answer ${summary.missing.join(", ")} to continue`
    : `All ${state.form.questions.length} answers ready · not submitted`;
}

type Notice = {
  title: string;
  text: string;
  label: string;
  action: "refresh" | "task";
};
/** Titled notices for a request that can no longer take an answer. */
function statusNotice(status: string | undefined): Notice | null {
  switch (status) {
    case "stale":
      return {
        title: "Stale request",
        text: "This request was replaced by a newer one. Your answers cannot be submitted to a different revision; review the current request.",
        label: "Refresh request",
        action: "refresh",
      };
    case "cancelled":
      return {
        title: "Cancelled request",
        text: "The requester withdrew this request. No answer is required and submission is unavailable.",
        label: "Return to task",
        action: "task",
      };
    case "unsupported":
      return {
        title: "Question interaction unsupported",
        text: "This request cannot take an answer from here. No answer has been submitted.",
        label: "Return to task",
        action: "task",
      };
    case "offline":
      return {
        title: "Interaction unavailable",
        text: "The current request cannot be verified or submitted. Retain unfinished input, then recheck request state.",
        label: "Check connection",
        action: "refresh",
      };
    case "unavailable":
      return {
        title: "Exact question unavailable",
        text: "The exact request cannot be shown. This request remains unresolved.",
        label: "Return to task",
        action: "task",
      };
    default:
      return null;
  }
}
