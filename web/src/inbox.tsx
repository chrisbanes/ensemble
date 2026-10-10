import { NativeSelect } from "./ui/native-select.js";
import { Card } from "./ui/card.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  inboxReadSchema,
  type InboxItem,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button, ResourceStatus } from "./components.js";
import {
  ageLabel,
  clockLabel,
  filterCounts,
  requestActionLabel,
  requestKindLabel,
} from "./inbox-presentation.js";
import { useOperatorResource, type ResourceState } from "./resource.js";
import { QuestionResponse } from "./question-response.js";
import type { QuestionResponseStates } from "./question-response-state.js";
export class InboxState {
  project = "";
  kind = "";
  scrollTop = 0;
  selected: InboxItem | null = null;
  clear() {
    this.project = "";
    this.kind = "";
    this.scrollTop = 0;
    this.selected = null;
  }
}
export async function loadInbox(client: OperatorClient, signal: AbortSignal) {
  const items: InboxItem[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page: import("zod").infer<typeof inboxReadSchema> = await client.read(
      `/api/operator/inbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      inboxReadSchema,
      signal,
    );
    items.push(...page.data.items);
    if (!page.data.nextCursor)
      return {
        items,
        complete: page.data.complete,
        unavailable: page.data.unavailable,
        observedAt: page.observedAt,
      };
    if (seen.has(page.data.nextCursor)) throw Error("unavailable");
    seen.add(page.data.nextCursor);
    cursor = page.data.nextCursor;
  }
}
/** A count is a total only when the whole Inbox was read and the last read succeeded. */
export function inboxSummaryOf(state: ResourceState<InboxRead>) {
  return state.data?.complete && !state.data.unavailable && !state.error
    ? {
        count: state.data.items.length,
        projects: new Set(state.data.items.map((item) => item.projectId)).size,
      }
    : null;
}
type InboxRead = Awaited<ReturnType<typeof loadInbox>>;
export function Inbox({
  client,
  session,
  path,
  navigate,
  state,
  questions,
  observation,
  onSummary,
}: {
  client: OperatorClient;
  session: Session;
  path: string;
  navigate: (path: string) => void;
  state: InboxState;
  questions: QuestionResponseStates;
  observation: object | null;
  /** Reports the unresolved total and project count (or null) so the shell matches this list. */
  onSummary?: (summary: ReturnType<typeof inboxSummaryOf>) => void;
}) {
  const loader = useCallback(
    (signal: AbortSignal) => loadInbox(client, signal),
    [client],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:action-inbox`,
      loader,
    ),
    refresh = useRef(resource.refresh);
  refresh.current = resource.refresh;
  useEffect(() => {
    const timer = setInterval(() => refresh.current(), 15000);
    return () => clearInterval(timer);
  }, []);
  const count = inboxSummaryOf(resource.state)?.count,
    projectCount = inboxSummaryOf(resource.state)?.projects;
  useEffect(() => {
    onSummary?.(
      count === undefined || projectCount === undefined
        ? null
        : { count, projects: projectCount },
    );
    return () => onSummary?.(null);
  }, [count, projectCount, onSummary]);
  const seen = useRef(observation);
  useEffect(() => {
    if (seen.current !== observation) {
      seen.current = observation;
      if (observation) refresh.current();
    }
  }, [observation]);
  const [, render] = useState(0),
    queue = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (queue.current) queue.current.scrollTop = state.scrollTop;
  }, [state]);
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    selectedId = params.get("request"),
    taskId = params.get("task");
  const current = resource.state.data?.items.find(
    (item) => item.id === selectedId && item.taskId === taskId,
  );
  if (current) state.selected = current;
  const selected = selectedId
    ? (current ??
      (state.selected?.id === selectedId && state.selected.taskId === taskId
        ? state.selected
        : null))
    : null;
  const rows = (resource.state.data?.items ?? []).filter(
    (item) =>
      (!state.project || item.projectId === state.project) &&
      (!state.kind || item.kind === state.kind),
  );
  const loaded = resource.state.data?.items ?? [],
    counts = filterCounts(loaded),
    projects = [
      ...new Map(loaded.map((item) => [item.projectId, item.projectName])),
    ],
    filtered = Boolean(state.project || state.kind),
    complete = Boolean(resource.state.data?.complete),
    empty = complete && !loaded.length;
  const now = Date.now();
  const choose = (item: InboxItem) => {
    state.selected = item;
    navigate(
      `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`,
    );
  };
  const clear = () => {
    state.project = "";
    state.kind = "";
    render((v) => v + 1);
  };
  return (
    <section
      className={`action-inbox ${selectedId ? "inbox-selected" : ""} ${empty && !selectedId ? "inbox-empty" : ""}`}
      aria-label="Action Inbox"
    >
      <div className="inbox-filters">
        <NativeSelect
          aria-label="Project"
          value={state.project}
          onChange={(e) => {
            state.project = e.target.value;
            render((v) => v + 1);
          }}
        >
          <option value="">All projects · {counts.total}</option>
          {projects.map(([id, name]) => (
            <option key={id} value={id}>
              {name ?? "Unavailable project"} · {counts.project[id] ?? 0}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Request kind"
          value={state.kind}
          onChange={(e) => {
            state.kind = e.target.value;
            render((v) => v + 1);
          }}
        >
          <option value="">All request types · {counts.total}</option>
          <option value="question">
            Questions · {counts.kind.question ?? 0}
          </option>
          <option value="approval">
            Approvals · {counts.kind.approval ?? 0}
          </option>
          <option value="intervention">
            Interventions · {counts.kind.intervention ?? 0}
          </option>
        </NativeSelect>
        <p className="metadata muted">Intervention first · then oldest</p>
      </div>
      <div className="inbox-queue">
        <ResourceStatus state={resource.state} retry={resource.refresh} />
        {resource.state.data && !resource.state.data.complete && (
          <p role="alert">
            Queue coverage is incomplete. Unavailable requests may remain.
          </p>
        )}
        <div
          className="inbox-rows"
          ref={queue}
          onScroll={(e) => {
            state.scrollTop = e.currentTarget.scrollTop;
          }}
        >
          {rows.map((item) => (
            <button
              type="button"
              className="inbox-row"
              key={item.id}
              data-record-id={item.id}
              aria-pressed={selectedId === item.id}
              onClick={() => choose(item)}
            >
              <span className="inbox-row-label">
                {item.projectName ?? "Unavailable project"} /{" "}
                {requestKindLabel(item.kind)}
              </span>
              <strong>{item.taskTitle ?? "Unavailable task"}</strong>
              <span>{item.reason ?? "Exact details unavailable"}</span>
              <span className="inbox-row-action">
                {requestActionLabel(item.kind)} →
              </span>
              <span className="inbox-row-meta">
                {item.requesterName ?? "Responsibility unknown"} ·{" "}
                {item.createdAt === null ? (
                  <time>{ageLabel(null, now)}</time>
                ) : (
                  <time dateTime={new Date(item.createdAt).toISOString()}>
                    {clockLabel(item.createdAt)} ·{" "}
                    {ageLabel(item.createdAt, now)}
                  </time>
                )}
              </span>
            </button>
          ))}
          {!rows.length && resource.state.status === "fresh" && (
            <Card className="inbox-empty-card">
              {!complete ? (
                <p>No requests visible in available coverage.</p>
              ) : filtered && loaded.length ? (
                <>
                  <h2 className="small-heading">No matching requests.</h2>
                  <p className="body muted">
                    Nothing matches these filters. There are still{" "}
                    {loaded.length} unresolved items across all projects.
                  </p>
                  <Button variant="secondary" onClick={clear}>
                    Clear filters
                  </Button>
                </>
              ) : (
                <>
                  <h2 className="small-heading">
                    Nothing needs your attention.
                  </h2>
                  <p className="body muted">
                    Questions, approvals and execution problems will appear
                    here. Routine progress and completed work stay in Overview.
                  </p>
                  <ActionLink variant="secondary" href="/app">
                    Back to overview
                  </ActionLink>
                </>
              )}
            </Card>
          )}
        </div>
        <ActionLink
          variant="secondary"
          className="inbox-advanced"
          href="/coordination"
        >
          Advanced coordination controls
        </ActionLink>
      </div>
      <section className="inbox-detail" aria-label="Selected request">
        <Button variant="secondary" onClick={() => navigate("/app/inbox")}>
          Back to queue
        </Button>
        {selectedId && taskId ? (
          <>
            {selected && (
              <>
                <h2>{selected.taskTitle ?? "Selected request"}</h2>
                <p>{selected.reason}</p>
                {!current && resource.state.status === "fresh" && (
                  <p role="status">
                    This request has left the current queue. Its exact detail
                    remains selected.
                  </p>
                )}
                <ActionLink href={selected.evidence}>Task evidence</ActionLink>
                {selected.conversation && (
                  <ActionLink href={selected.conversation}>
                    Requesting conversation
                  </ActionLink>
                )}
              </>
            )}
            {selected?.kind === "question" ||
            (!selected &&
              selectedId &&
              !selectedId.startsWith("intervention:")) ? (
              <QuestionResponse
                client={client}
                session={session}
                taskId={taskId}
                interactionId={selectedId}
                states={questions}
                onRecorded={resource.refresh}
              />
            ) : selected ? (
              <>
                <p>
                  Review the exact recorded material and recovery state before
                  acting.
                </p>
                <ActionLink href={selected.destination}>
                  Open exact {selected.kind}
                </ActionLink>
              </>
            ) : (
              <p>Selected request is unavailable.</p>
            )}
          </>
        ) : (
          <p>Select a request to review its complete form or exact material.</p>
        )}
      </section>
    </section>
  );
}
