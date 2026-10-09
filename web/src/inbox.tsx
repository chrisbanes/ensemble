import { NativeSelect } from "./ui/native-select.js";
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
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
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
export function inboxTotal(state: ResourceState<InboxRead>) {
  return state.data?.complete && !state.data.unavailable && !state.error
    ? state.data.items.length
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
  onTotal,
}: {
  client: OperatorClient;
  session: Session;
  path: string;
  navigate: (path: string) => void;
  state: InboxState;
  questions: QuestionResponseStates;
  observation: object | null;
  /** Reports the unresolved total (or null) so the shell count matches this list. */
  onTotal?: (total: number | null) => void;
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
  const total = inboxTotal(resource.state);
  useEffect(() => {
    onTotal?.(total);
    return () => onTotal?.(null);
  }, [total, onTotal]);
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
  const projects = [
    ...new Map(
      (resource.state.data?.items ?? []).map((item) => [
        item.projectId,
        item.projectName,
      ]),
    ).entries(),
  ];
  const choose = (item: InboxItem) => {
    state.selected = item;
    navigate(
      `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`,
    );
  };
  return (
    <section
      className={`action-inbox ${selectedId ? "inbox-selected" : ""}`}
      aria-label="Action Inbox"
    >
      <div className="inbox-queue">
        <h2>Action Inbox</h2>
        <ActionLink href="/coordination">
          Advanced coordination controls
        </ActionLink>
        <p>Questions, approvals and recorded interventions across projects.</p>
        <ResourceStatus state={resource.state} retry={resource.refresh} />
        {resource.state.data && !resource.state.data.complete && (
          <p role="alert">
            Queue coverage is incomplete. Unavailable requests may remain.
          </p>
        )}
        <div className="inbox-filters">
          <label htmlFor="inbox-project">Project</label>
          <NativeSelect
            id="inbox-project"
            value={state.project}
            onChange={(e) => {
              state.project = e.target.value;
              render((v) => v + 1);
            }}
          >
            <option value="">All projects</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name ?? "Unavailable project"}
              </option>
            ))}
          </NativeSelect>
          <label htmlFor="inbox-kind">Request kind</label>
          <NativeSelect
            id="inbox-kind"
            value={state.kind}
            onChange={(e) => {
              state.kind = e.target.value;
              render((v) => v + 1);
            }}
          >
            <option value="">All requests</option>
            <option value="question">Questions</option>
            <option value="approval">Approvals</option>
            <option value="intervention">Interventions</option>
          </NativeSelect>
        </div>
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
              <StatusBadge>{item.kind}</StatusBadge>
              <strong>{item.taskTitle ?? "Unavailable task"}</strong>
              <span>
                {item.projectName ?? "Unavailable project"} ·{" "}
                {item.requesterName ?? "Responsibility unknown"}
              </span>
              <span>{item.reason ?? "Exact details unavailable"}</span>
              <time>
                {item.createdAt === null
                  ? "Age unknown"
                  : new Date(item.createdAt).toLocaleString()}
              </time>
            </button>
          ))}
          {!rows.length && resource.state.status === "fresh" && (
            <p>
              {resource.state.data?.complete
                ? "No matching requests need your action."
                : "No requests visible in available coverage."}
            </p>
          )}
        </div>
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
