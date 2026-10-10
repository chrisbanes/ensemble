import { NativeSelect } from "./ui/native-select.js";
import { Card } from "./ui/card.js";
import {
  type ReactNode,
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
import { ArrowUpRight } from "lucide-react";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { useMediaQuery } from "./use-media-query.js";
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
  /** The request a wide layout opened by itself; not navigation, so no history entry. */
  auto: InboxItem | null = null;
  /** Where the phone detail came from, so Back can focus it without selecting anything. */
  returnFocus: { id: string; index: number } | null = null;
  clear() {
    this.project = "";
    this.kind = "";
    this.scrollTop = 0;
    this.selected = null;
    this.auto = null;
    this.returnFocus = null;
  }
}
/** What the Inbox asks the shell header to show; the shell only merges it into its props. */
export interface InboxHeader {
  subtitle?: string;
  /** Single-column layout with a request open: a Back link, the request title and one action. */
  detail?: {
    title: string;
    subtitle?: string;
    back: { href: string; label: string };
    action: ReactNode;
  };
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
  onHeader,
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
  /** Reports the header content for this view (null on unmount). */
  onHeader?: (header: InboxHeader | null) => void;
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
    queue = useRef<HTMLDivElement>(null),
    single = useMediaQuery("(max-width: 760px)");
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    urlId = params.get("request"),
    urlTask = params.get("task"),
    // A wide layout without a chosen request shows the one it opened by itself.
    implicit = !urlId && !single ? state.auto : null,
    selectedId = urlId ?? implicit?.id ?? null,
    taskId = urlTask ?? implicit?.taskId ?? null;
  const items = resource.state.data?.items ?? [],
    current = items.find(
      (item) => item.id === selectedId && item.taskId === taskId,
    );
  if (current && urlId) state.selected = current;
  const selected = selectedId
    ? (current ??
      (urlId
        ? state.selected?.id === selectedId && state.selected.taskId === taskId
          ? state.selected
          : null
        : implicit))
    : null;
  const rows = items.filter(
    (item) =>
      (!state.project || item.projectId === state.project) &&
      (!state.kind || item.kind === state.kind),
  );
  // Open the first request once per visit when the first fresh read arrives on a wide layout.
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || resource.state.status !== "fresh") return;
    autoDone.current = true;
    const first = rows[0];
    if (!single && !urlId && !state.selected && !state.auto && first) {
      state.auto = first;
      render((v) => v + 1);
    }
  });
  // Keep the queue's own scroll across detail visits (a hidden queue forgets its offset).
  useLayoutEffect(() => {
    if (queue.current && !(single && urlId))
      queue.current.scrollTop = state.scrollTop;
  }, [state, single, urlId]);
  // Returning from the phone detail focuses the opened row, or the row now at its place.
  useLayoutEffect(() => {
    if (!single || urlId || !state.returnFocus || !queue.current) return;
    const { id, index } = state.returnFocus,
      list = [...queue.current.querySelectorAll<HTMLElement>(".inbox-row")],
      row =
        list.find((el) => el.dataset.recordId === id) ??
        list[Math.min(index, list.length - 1)];
    if (row || resource.state.status === "fresh") state.returnFocus = null;
    row?.focus({ preventScroll: true });
  }, [single, urlId, state, resource.state.status]);
  const position = selected ? rows.findIndex((r) => r.id === selected.id) : -1,
    heading = selected
      ? `${requestKindLabel(selected.kind)}${position >= 0 ? ` · ${position + 1} of ${rows.length}` : ""}`
      : null,
    leftQueue = Boolean(
      selected && !current && resource.state.status === "fresh",
    );
  const subtitle =
    count === undefined || projectCount === undefined
      ? undefined
      : leftQueue
        ? `${count} unresolved · confirmation retained`
        : count === 0
          ? "0 unresolved across your projects"
          : `${count} unresolved across ${projectCount} project${projectCount === 1 ? "" : "s"}`;
  const detailTitle = single && selected ? heading : null,
    detailSubtitle = selected?.projectName ?? undefined,
    detailTask = selected?.taskId;
  useEffect(() => {
    onHeader?.(
      detailTitle && detailTask
        ? {
            ...(subtitle ? { subtitle } : {}),
            detail: {
              title: detailTitle,
              ...(detailSubtitle ? { subtitle: detailSubtitle } : {}),
              back: { href: "/app/inbox", label: "Inbox" },
              action: (
                <ActionLink
                  variant="secondary"
                  href={`/app/tasks/${detailTask}`}
                >
                  Open task
                </ActionLink>
              ),
            },
          }
        : subtitle
          ? { subtitle }
          : null,
    );
  }, [onHeader, detailTitle, detailSubtitle, detailTask, subtitle]);
  useEffect(() => () => onHeader?.(null), [onHeader]);
  const loaded = items,
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
    state.returnFocus = {
      id: item.id,
      index: Math.max(
        0,
        rows.findIndex((r) => r.id === item.id),
      ),
    };
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
        {selectedId && taskId ? (
          <>
            {heading && selected && (
              <header className="inbox-detail-header">
                <StatusBadge>{requestKindLabel(selected.kind)}</StatusBadge>
                {position >= 0 && (
                  <span className="metadata muted inbox-position">
                    {position + 1} of {rows.length}
                  </span>
                )}
                {!single && (
                  <a
                    className="inbox-open-task"
                    href={`/app/tasks/${selected.taskId}`}
                  >
                    Open task
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                )}
              </header>
            )}
            <div className="inbox-detail-body">
              {selected && (
                <div className="inbox-detail-intro">
                  <p className="metadata muted">
                    {selected.projectName ?? "Unavailable project"}
                  </p>
                  <h2>{selected.taskTitle ?? "Selected request"}</h2>
                  <p className="body muted">
                    Requested by{" "}
                    {selected.requesterName ?? "Responsibility unknown"}
                  </p>
                  <p>{selected.reason ?? "Exact details unavailable"}</p>
                  {leftQueue && (
                    <p role="status">
                      This request has left the current queue. Its exact detail
                      remains selected.
                    </p>
                  )}
                  <div className="inbox-detail-links">
                    <ActionLink variant="secondary" href={selected.evidence}>
                      Task evidence
                    </ActionLink>
                    {selected.conversation && (
                      <ActionLink
                        variant="secondary"
                        href={selected.conversation}
                      >
                        Requesting conversation
                      </ActionLink>
                    )}
                  </div>
                </div>
              )}
              {selected?.kind === "question" ||
              (!selected && !selectedId.startsWith("intervention:")) ? (
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
            </div>
          </>
        ) : (
          <p>Select a request to review its complete form or exact material.</p>
        )}
      </section>
    </section>
  );
}
