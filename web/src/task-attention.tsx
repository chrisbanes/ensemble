import {
  ArrowRight,
  CircleAlert,
  CircleQuestionMark,
  TriangleAlert,
} from "lucide-react";
import type {
  InboxItem,
  TaskListSummary,
} from "../../src/operator/contracts.js";
import { ActionLink, ResourceStatus, StatusBadge } from "./components.js";
import { inboxSummaryOf, type loadInbox } from "./inbox.js";
import {
  requestActionLabel,
  requestHref,
  requestMeta,
} from "./request-presentation.js";
import type { ResourceState } from "./resource.js";
import { attentionCandidate, taskColumn, taskDetailHref } from "./tasks.js";

export type InboxRead = Awaited<ReturnType<typeof loadInbox>>;
export type Requests = ResourceState<InboxRead>;
const shown = 3;

function RequestRow({ item }: { item: InboxItem }) {
  const Icon = item.kind === "question" ? CircleQuestionMark : CircleAlert,
    text = `request-${item.id}`;
  return (
    <li
      className="work-request"
      data-request-id={item.id}
      data-kind={item.kind}
    >
      <span className="work-tile" aria-hidden="true">
        <Icon />
      </span>
      <div className="work-request-text" id={text}>
        <p className="metadata muted">
          {item.projectName ?? "Unavailable project"} /{" "}
          <span>{item.taskTitle ?? "Unavailable task"}</span>
        </p>
        <p className="body">{item.reason ?? "Exact details unavailable"}</p>
      </div>
      <p className="metadata muted work-request-meta">{requestMeta(item)}</p>
      <ActionLink
        variant="secondary"
        href={requestHref(item)}
        aria-describedby={text}
      >
        {requestActionLabel(item.kind)}
      </ActionLink>
    </li>
  );
}

/** Overview attention: one row per Inbox request, read from the shell's whole-Inbox read. */
export function AttentionSection({
  requests,
  retry,
}: {
  requests: Requests;
  retry: () => void;
}) {
  const data = requests.data,
    total = inboxSummaryOf(requests)?.count;
  return (
    <section className="work-attention" aria-label="Needs your attention">
      <div className="work-section-head">
        <h2 className="section-heading">Needs your attention</h2>
        {total !== undefined && <StatusBadge>{total} unresolved</StatusBadge>}
        <a className="control work-link" href="/app/inbox">
          View inbox <ArrowRight aria-hidden="true" />
        </a>
      </div>
      {requests.status !== "fresh" && (
        <ResourceStatus state={requests} retry={retry} label="Requests" />
      )}
      {data && !data.complete && (
        <p role="alert" className="body">
          Queue coverage is incomplete. Unavailable requests may remain.
        </p>
      )}
      {data && (
        <ul className="work-requests">
          {data.items.slice(0, shown).map((item) => (
            <RequestRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {data && data.items.length > shown && (
        <p className="metadata muted">
          <a href="/app/inbox">{data.items.length - shown} more in the Inbox</a>
        </p>
      )}
      {data && !data.items.length && (
        <p className="body muted">
          {data.complete
            ? "Nothing needs your attention."
            : "No requests visible in available coverage."}
        </p>
      )}
    </section>
  );
}

/** Done work stays out of Active tasks; this line is the way back to it. */
export function CompletedWork({
  tasks,
  project,
}: {
  tasks: readonly TaskListSummary[];
  project: string;
}) {
  const done = tasks.filter(
    (t) => taskColumn(t) === "Done" && (!project || t.projectId === project),
  ).length;
  if (!done) return null;
  return (
    <section className="work-completed" aria-label="Completed work">
      <h2 className="metadata muted">Completed work</h2>
      <p className="body">
        {done} completed task{done === 1 ? "" : "s"} · no decision needed
      </p>
      <a
        className="control work-link"
        href={`/app/tasks?state=Done${project ? `&project=${project}` : ""}`}
      >
        View completed <ArrowRight aria-hidden="true" />
      </a>
    </section>
  );
}

/** Persistent summary above List and Board: the one task that most needs a look, plus the Inbox. */
export function AttentionBar({
  tasks,
  requests,
}: {
  tasks: readonly TaskListSummary[];
  requests: Requests;
}) {
  const task = attentionCandidate(tasks);
  if (!task) return null;
  const uncertain =
      task.attention.codes.includes("execution-uncertain") ||
      taskColumn(task) === "Uncertain",
    title = task.title ?? "Title unavailable",
    count = inboxSummaryOf(requests)?.count;
  return (
    <section className="work-bar" aria-label="Attention summary">
      <TriangleAlert aria-hidden="true" className="work-bar-icon" />
      <div className="work-bar-text">
        <p className="body">
          {uncertain ? "Inspect execution" : "Stopping"} · {title}
        </p>
        <p className="metadata muted">
          {uncertain
            ? `${task.lead?.name ?? "Responsibility unknown"} · execution may still be active; ownership stays held.`
            : "Next: runtime · confirm execution ended. No operator request recorded."}
        </p>
      </div>
      <ActionLink variant="secondary" href={taskDetailHref(task)}>
        {uncertain ? "Inspect execution" : "Open task"}
      </ActionLink>
      <a className="control work-link" href="/app/inbox">
        Inbox{count === undefined ? "" : ` · ${count}`}{" "}
        <ArrowRight aria-hidden="true" />
      </a>
    </section>
  );
}
