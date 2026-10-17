import { NativeSelect } from "./ui/native-select.js";
import { Card } from "./ui/card.js";
import {
  Fragment,
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
  type Workspace,
} from "../../src/operator/contracts.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import type { OperatorClient } from "./api.js";
import { ArrowUpRight, ChevronDown, ChevronUp } from "lucide-react";
import { ActionLink, Button, ResourceStatus } from "./components.js";
import { Badge } from "./ui/badge.js";
import { useMediaQuery } from "./use-media-query.js";
import {
  ageLabel,
  filterCounts,
  queueGroups,
  requestActionLabel,
  requestHeading,
  requestIdentity,
  requestKindLabel,
} from "./inbox-presentation.js";
import { clockLabel } from "./presentation.js";
import { inboxSummaryOf, requestKindIcons } from "./request-presentation.js";
import { useOperatorResource } from "./resource.js";
import {
  answerHolds,
  ApprovalDetail,
  InterventionDetail,
  RuntimeDetail,
  useInboxTask,
} from "./inbox-detail.js";
import { InboxContext } from "./inbox-context.js";
import { inboxSelectionHref } from "../../src/operator/attention.js";
import { closeResolvedNotifications } from "./notifications.js";
import { QuestionResponse } from "./question-response.js";
import type { QuestionResponseStates } from "./question-response-state.js";
import "./inbox.css";
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
    /** Absent for a request with no task to open. */
    action?: ReactNode;
  };
}
export async function loadInbox(client: OperatorClient, signal: AbortSignal) {
  // A notification that arrives while this read is in flight is newer than what it saw.
  const startedAt = Date.now();
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
    if (!page.data.nextCursor) {
      // Both callers (the shell's summary and this route) pass through here, so a notification
      // whose request is no longer waiting closes after whichever read happens.
      void closeResolvedNotifications(items, page.data.complete, startedAt);
      return {
        items,
        complete: page.data.complete,
        unavailable: page.data.unavailable,
        observedAt: page.observedAt,
      };
    }
    if (seen.has(page.data.nextCursor)) throw Error("unavailable");
    seen.add(page.data.nextCursor);
    cursor = page.data.nextCursor;
  }
}
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
  chrome,
  queueRefresh,
}: {
  client: OperatorClient;
  session: Session;
  path: string;
  navigate: (path: string) => void;
  state: InboxState;
  questions: QuestionResponseStates;
  /** The workspace read: its change refreshes the list and its projects name the filter. */
  observation: Workspace | null;
  /** Reports the unresolved total and project count (or null) so the shell matches this list. */
  onSummary?: (summary: ReturnType<typeof inboxSummaryOf>) => void;
  /** Reports the header content for this view (null on unmount). */
  onHeader?: (header: InboxHeader | null) => void;
  /** At the sidebar shell the queue header owns the page heading, summary and Refresh. */
  chrome?: { onRefresh: () => void; refreshing: boolean } | undefined;
  /** On a phone the header has no Refresh, so the filter row ends with it. */
  queueRefresh?: { onRefresh: () => void; refreshing: boolean } | undefined;
}) {
  const loader = useCallback(
    (signal: AbortSignal) => loadInbox(client, signal),
    [client],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:action-inbox`,
      loader,
    ),
    poll = useRef(resource.poll);
  poll.current = resource.poll;
  useEffect(() => {
    const timer = setInterval(() => poll.current(), 15000);
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
      if (observation) poll.current();
    }
  }, [observation]);
  const [, render] = useState(0),
    queue = useRef<HTMLDivElement>(null),
    single = useMediaQuery("(max-width: 760px)"),
    // The task-context inspector has room from 1280px.
    inspector = useMediaQuery("(min-width: 1280px)") && !single;
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    urlId = params.get("request"),
    urlTask = params.get("task"),
    // A wide layout without a request in the URL shows the last chosen one, else the one it opened itself.
    implicit = !urlId && !single ? (state.selected ?? state.auto) : null,
    selectedId = urlId ?? implicit?.id ?? null,
    // A runtime item belongs to no task: its id alone selects it.
    runtimeId = Boolean(selectedId?.startsWith("runtime:")),
    taskId =
      urlTask ??
      (implicit?.kind === "runtime" ? null : implicit?.taskId) ??
      null;
  const sameRequest = (item: InboxItem) =>
    item.id === selectedId &&
    (item.kind === "runtime" || item.taskId === taskId);
  const items = resource.state.data?.items ?? [],
    current = items.find(sameRequest);
  if (current && urlId) state.selected = current;
  const selected = selectedId
    ? (current ??
      (urlId
        ? state.selected && sameRequest(state.selected)
          ? state.selected
          : null
        : implicit))
    : null;
  // The queue's display order (grouped) is the one order for position, Previous/Next and focus.
  const rows = queueGroups(
    items.filter(
      (item) =>
        (!state.project ||
          (item.kind !== "runtime" && item.projectId === state.project)) &&
        (!state.kind || item.kind === state.kind),
    ),
  ).flatMap((group) => group.items);
  // One read of the selected request's task serves its holds, approval facts and the inspector.
  const task = useInboxTask(
    client,
    session,
    // An intervention below the inspector width shows nothing from the task read.
    selectedId &&
      taskId &&
      !runtimeId &&
      (inspector || selected?.kind !== "intervention")
      ? taskId
      : null,
    resource.state.fetchedAt,
    "request",
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
    ),
    recorded = Boolean(
      selected &&
        selected.kind !== "runtime" &&
        questions.recordedHere(selected.taskId, selected.id),
    );
  const subtitle =
    count === undefined || projectCount === undefined
      ? undefined
      : leftQueue && recorded
        ? `${count} unresolved · confirmation retained`
        : count === 0
          ? "0 unresolved across your projects"
          : projectCount === 0
            ? `${count} unresolved`
            : `${count} unresolved across ${projectCount} project${projectCount === 1 ? "" : "s"}`;
  const detailTitle = single && selected ? heading : null,
    detailSubtitle =
      (selected?.kind === "runtime" ? null : selected?.projectName) ??
      undefined,
    detailTask = selected?.kind === "runtime" ? undefined : selected?.taskId,
    detailRuntime = selected?.kind === "runtime";
  useEffect(() => {
    onHeader?.(
      detailTitle && (detailTask || detailRuntime)
        ? {
            ...(subtitle ? { subtitle } : {}),
            detail: {
              title: detailTitle,
              ...(detailSubtitle ? { subtitle: detailSubtitle } : {}),
              back: { href: "/app/inbox", label: "Inbox" },
              ...(detailTask
                ? {
                    action: (
                      <ActionLink
                        variant="secondary"
                        href={`/app/tasks/${detailTask}`}
                      >
                        Open task
                      </ActionLink>
                    ),
                  }
                : {}),
            },
          }
        : subtitle
          ? { subtitle }
          : null,
    );
  }, [
    onHeader,
    detailTitle,
    detailSubtitle,
    detailTask,
    detailRuntime,
    subtitle,
  ]);
  useEffect(() => () => onHeader?.(null), [onHeader]);
  const labels = workspaceLabels(observation);
  const loaded = items,
    counts = filterCounts(loaded),
    projects = [
      ...new Map(
        loaded.flatMap((item) =>
          item.kind === "runtime"
            ? []
            : [[item.projectId, item.projectName] as const],
        ),
      ),
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
    navigate(inboxSelectionHref(item));
  };
  /** After a recorded answer: leave the confirmation without opening another request. */
  const back = () => {
    state.selected = null;
    state.auto = null;
    navigate("/app/inbox");
  };
  const clear = () => {
    state.project = "";
    state.kind = "";
    render((v) => v + 1);
  };
  const row = (item: InboxItem) => {
    const Icon = requestKindIcons[item.kind],
      heading = requestHeading(item);
    return (
      <button
        type="button"
        className="inbox-row"
        key={item.id}
        data-record-id={item.id}
        data-kind={item.kind}
        aria-pressed={selectedId === item.id}
        onClick={() => choose(item)}
      >
        <span className="inbox-row-label">
          <Icon aria-hidden="true" />
          {requestKindLabel(item.kind)}
        </span>
        <strong title={heading.title ?? undefined}>
          {heading.title ?? "Unavailable task"}
        </strong>
        {heading.subtitle && (
          <span className="inbox-row-subtitle">{heading.subtitle}</span>
        )}
        {heading.reason && (
          <span className="inbox-row-reason">{heading.reason}</span>
        )}
        <span className="inbox-row-action">{requestActionLabel(item)} →</span>
        {((item.kind !== "runtime" && item.requesterName) ||
          item.createdAt !== null) && (
          <span className="inbox-row-meta">
            {item.kind !== "runtime" && item.requesterName}
            {item.kind !== "runtime" &&
              item.requesterName &&
              item.createdAt !== null &&
              " · "}
            {item.createdAt !== null && (
              <time dateTime={new Date(item.createdAt).toISOString()}>
                {clockLabel(item.createdAt)} · {ageLabel(item.createdAt, now)}
              </time>
            )}
          </span>
        )}
      </button>
    );
  };
  const isQuestion =
      selected?.kind === "question" ||
      (!selected && !selectedId?.startsWith("intervention:") && !runtimeId),
    selectedHeading = selected ? requestHeading(selected) : null,
    KindIcon = selected ? requestKindIcons[selected.kind] : null,
    previous = position > 0 ? rows[position - 1] : undefined,
    next = position >= 0 ? rows[position + 1] : undefined;
  const meta = selected && selected.kind !== "runtime" && (
    <div className="inbox-detail-meta">
      {requestIdentity(selected) && (
        <p className="inbox-identity">{requestIdentity(selected)}</p>
      )}
      {!inspector && (selected.evidence || selected.conversation) && (
        <div className="inbox-detail-links">
          {selected.evidence && (
            <ActionLink variant="secondary" href={selected.evidence}>
              Task evidence
            </ActionLink>
          )}
          {selected.conversation && (
            <ActionLink variant="secondary" href={selected.conversation}>
              Requesting conversation
            </ActionLink>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section
      className={`action-inbox ${selectedId ? "inbox-selected" : ""} ${empty && !selectedId ? "inbox-empty" : ""}`}
      aria-label="Action Inbox"
    >
      <div className="inbox-queue">
        <div className="inbox-queue-head">
          {chrome && (
            <div className="inbox-title">
              <h1 className="inbox-heading">Inbox</h1>
              {subtitle && <p className="inbox-summary">{subtitle}</p>}
              <Button
                variant="secondary"
                onClick={chrome.onRefresh}
                disabled={chrome.refreshing}
              >
                Refresh
              </Button>
            </div>
          )}
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
                  {projectLabel(labels, id, name).text} ·{" "}
                  {counts.project[id] ?? 0}
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
              <option value="runtime">
                Runtime · {counts.kind.runtime ?? 0}
              </option>
            </NativeSelect>
            {queueRefresh && (
              <Button
                variant="secondary"
                onClick={queueRefresh.onRefresh}
                disabled={queueRefresh.refreshing}
              >
                Refresh
              </Button>
            )}
          </div>
        </div>
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
          {queueGroups(rows).map((group) => (
            <Fragment key={group.id}>
              <h2 className="inbox-group">{group.heading}</h2>
              {group.items.map(row)}
            </Fragment>
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
        <p className="inbox-caption">
          Only items that need your decision or intervention. Routine progress
          stays in task views.
        </p>
      </div>
      <section className="inbox-detail" aria-label="Selected request">
        {selectedId && (taskId || runtimeId) ? (
          <>
            {heading && selected && KindIcon && (
              <header className="inbox-detail-header">
                <Badge
                  className="inbox-kind"
                  variant={
                    selected.kind === "intervention" ||
                    selected.kind === "runtime"
                      ? "destructive"
                      : "attention"
                  }
                >
                  <KindIcon aria-hidden="true" />
                  {requestKindLabel(selected.kind)}
                </Badge>
                {position >= 0 && (
                  <span className="inbox-position">
                    {position + 1} of {rows.length}
                  </span>
                )}
                {!single && (
                  <span className="inbox-detail-tools">
                    {selected.kind !== "runtime" && (
                      <a
                        className="inbox-open-task"
                        href={`/app/tasks/${selected.taskId}`}
                      >
                        Open task
                        <ArrowUpRight aria-hidden="true" />
                      </a>
                    )}
                    {position >= 0 && (
                      <>
                        <Button
                          variant="secondary"
                          className="inbox-step"
                          aria-label="Previous request"
                          disabled={!previous}
                          onClick={() => previous && choose(previous)}
                        >
                          <ChevronUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="secondary"
                          className="inbox-step"
                          aria-label="Next request"
                          disabled={!next}
                          onClick={() => next && choose(next)}
                        >
                          <ChevronDown aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </header>
            )}
            <div className="inbox-detail-body">
              {selected && (
                <div className="inbox-detail-intro">
                  {selectedHeading?.subtitle && (
                    <p className="inbox-detail-project">
                      {selectedHeading.subtitle}
                    </p>
                  )}
                  <h2>{selectedHeading?.title ?? "Selected request"}</h2>
                  {selectedHeading?.reason && selected.kind !== "runtime" && (
                    <p className="inbox-reason">{selectedHeading.reason}</p>
                  )}
                  {leftQueue && (
                    <p role="status">
                      This request has left the current queue. Its exact detail
                      remains selected.
                    </p>
                  )}
                </div>
              )}
              {!isQuestion && meta}
              {isQuestion && taskId ? (
                <QuestionResponse
                  client={client}
                  session={session}
                  taskId={taskId}
                  interactionId={selectedId}
                  states={questions}
                  onRecorded={resource.refresh}
                  observedAt={resource.state.fetchedAt}
                  requesterName={selected?.requesterName}
                  compactContext={Boolean(selected)}
                  onBack={back}
                  holds={answerHolds(task.state)}
                />
              ) : selected?.kind === "approval" ? (
                <ApprovalDetail item={selected} resource={task} />
              ) : selected?.kind === "runtime" ? (
                <RuntimeDetail item={selected} />
              ) : selected ? (
                <InterventionDetail item={selected} />
              ) : (
                <p>Selected request is unavailable.</p>
              )}
              {isQuestion && meta}
            </div>
          </>
        ) : (
          <p>Select a request to review its complete form or exact material.</p>
        )}
      </section>
      {inspector && selected && selected.kind !== "runtime" && (
        <InboxContext
          item={selected}
          task={task}
          open={!leftQueue && !recorded}
        />
      )}
    </section>
  );
}
