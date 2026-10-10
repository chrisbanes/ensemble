import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  Clock,
  FilePen,
  LoaderCircle,
  Pause,
  Square,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useState, useRef, useLayoutEffect } from "react";
import type {
  InboxItem,
  Workspace,
  TaskListSummary,
} from "../../src/operator/contracts.js";
import { ResourceStatus, StatusBadge } from "./components.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import type { ResourceState } from "./resource.js";
import { requestActionLabel, requestHref } from "./request-presentation.js";
import {
  AttentionBar,
  AttentionSection,
  CompletedWork,
  type Requests,
} from "./task-attention.js";
import { TaskToolbar } from "./task-filters.js";
import {
  columns as allColumns,
  columnCounts,
  filterTasks,
  parseTaskFilters,
  safeSourceUrl,
  taskColumn,
  taskDetailHref,
  taskFiltersUrl,
  taskNext,
  taskReasons,
  visibleColumns,
  type TaskAggregate,
  type TaskColumn,
  type TaskFilters,
} from "./tasks.js";
import "./work.css";

const stateIcons: Record<TaskColumn, LucideIcon> = {
  Ready: CircleDot,
  Running: LoaderCircle,
  Waiting: Clock,
  Paused: Pause,
  Stopping: Square,
  Uncertain: CircleQuestionMark,
  Draft: FilePen,
  Done: CircleCheck,
  Cancelled: CircleX,
};
function TaskStateMark({ task }: { task: TaskListSummary }) {
  const column = taskColumn(task),
    Icon = stateIcons[column];
  return (
    <span className="task-state" data-column={column}>
      <Icon aria-hidden="true" />
      {column}
    </span>
  );
}
const identity = (task: TaskListSummary) =>
  task.source
    ? `${task.source.repositoryName ?? "repository unavailable"}#${task.source.number ?? "?"}`
    : "Local task";
const leadName = (task: TaskListSummary) =>
  task.lead?.name ?? (task.lead ? "Name unavailable" : null);
function TaskFacts({ task }: { task: TaskListSummary }) {
  return (
    <>
      {taskReasons(task).map((reason) => (
        <p key={reason} className="body muted task-reason">
          {reason}
        </p>
      ))}
      <p className="body task-next">{taskNext(task)}</p>
    </>
  );
}
export function TaskRow({ task }: { task: TaskListSummary }) {
  return (
    <article className="task-row" data-task-id={task.id}>
      <a className="small-heading task-title" href={taskDetailHref(task)}>
        {task.title ?? "Title unavailable"}
      </a>
      <p className="metadata muted task-project-metadata">
        {task.project.name ?? "Project name unavailable"} · {identity(task)}
      </p>
      <p className="body task-status">
        <TaskStateMark task={task} />
      </p>
      <div className="task-detail">
        <TaskFacts task={task} />
        {task.source && task.source.state !== "open" && (
          <p className="metadata muted task-source-state">
            GitHub source: {task.source.state ?? "state unavailable"}
          </p>
        )}
      </div>
      <p className="metadata muted task-lead">
        {leadName(task) ? `${leadName(task)} · lead` : "No lead configured"}
      </p>
      <ChevronRight aria-hidden="true" className="task-chevron" />
    </article>
  );
}
export function TaskCard({
  task,
  request,
}: {
  task: TaskListSummary;
  request?: InboxItem | undefined;
}) {
  const url = safeSourceUrl(task.source?.url),
    lead = leadName(task);
  return (
    <article data-task-id={task.id}>
      <Card className="task-card">
        <a className="small-heading task-title" href={taskDetailHref(task)}>
          {task.title ?? "Title unavailable"}
        </a>
        <p className="metadata muted task-project-metadata">
          {task.project.name ?? "Project name unavailable"} ·{" "}
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {identity(task)}
              <ArrowUpRight aria-hidden="true" />
              <span className="sr-only"> (opens GitHub)</span>
            </a>
          ) : (
            identity(task)
          )}
        </p>
        <p className="body task-status">
          <TaskStateMark task={task} />
        </p>
        <TaskFacts task={task} />
        {task.source && task.source.state !== "open" && (
          <p className="metadata muted task-source-state">
            GitHub source: {task.source.state ?? "state unavailable"}
          </p>
        )}
        {request && (
          <a className="body task-request" href={requestHref(request)}>
            {requestActionLabel(request.kind)} →
          </a>
        )}
        <p className="metadata task-lead task-card-lead">
          {lead && (
            <span className="task-avatar" aria-hidden="true">
              {lead.slice(0, 1)}
            </span>
          )}
          {lead ? `${lead} · accountable lead` : "No lead configured"}
          <ArrowUpRight aria-hidden="true" className="task-card-mark" />
        </p>
      </Card>
    </article>
  );
}
export function TaskBoard({
  tasks,
  columns,
  initial,
  requests,
}: {
  tasks: TaskListSummary[];
  columns: readonly TaskColumn[];
  /** The column a State filter names, shown first unless the operator already chose one. */
  initial: TaskColumn | undefined;
  requests: Requests;
}) {
  const [stored, updateSelected] = useState<number>(
      () =>
        history.state?.board?.selected ??
        (initial ? Math.max(0, columns.indexOf(initial)) : 0),
    ),
    // The visible columns change with the State filter, so a saved index may point past the end.
    selected = Math.min(stored, columns.length - 1);
  const board = useRef<HTMLDivElement>(null);
  const counts = columnCounts(tasks);
  const firstRequest = new Map<string, InboxItem>();
  for (const item of requests.data?.items ?? [])
    if (!firstRequest.has(item.taskId)) firstRequest.set(item.taskId, item);
  const setSelected = (next: number) => {
    updateSelected(next);
    history.replaceState(
      { ...history.state, board: { ...history.state?.board, selected: next } },
      "",
    );
  };
  useLayoutEffect(() => {
    if (board.current)
      board.current.scrollLeft = history.state?.board?.scrollLeft ?? 0;
  }, []);
  // A State filter has no saved scroll position: bring its column into view once tasks
  // have been laid out. Only the board scrolls, never the page.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const area = board.current,
      column = area?.querySelector<HTMLElement>(
        `[id="column-${columns[selected]}"]`,
      );
    if (
      placed.current ||
      !area ||
      !column ||
      !initial ||
      !tasks.length ||
      history.state?.board?.scrollLeft !== undefined
    )
      return;
    placed.current = true;
    const a = area.getBoundingClientRect(),
      c = column.getBoundingClientRect();
    if (c.right > a.right)
      area.scrollLeft += Math.min(c.right - a.right, c.left - a.left);
    else if (c.left < a.left) area.scrollLeft -= a.left - c.left;
  }, [tasks.length, initial, columns, selected]);
  const before = columns[selected - 1],
    after = columns[selected + 1];
  return (
    <div className="task-board">
      <div
        className="column-navigation"
        role="toolbar"
        aria-label="Board columns"
      >
        {columns.map((column, index) => (
          <Button
            key={column}
            type="button"
            variant="ghost"
            className="column-tab"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index);
              document
                .getElementById(`column-${column}`)
                ?.scrollIntoView({ block: "nearest", inline: "start" });
            }}
          >
            {column} · {counts[column]}
          </Button>
        ))}
      </div>
      <div
        className="board-columns"
        ref={board}
        onScroll={(e) =>
          history.replaceState(
            {
              ...history.state,
              board: { selected, scrollLeft: e.currentTarget.scrollLeft },
            },
            "",
          )
        }
      >
        {columns.map((column, index) => (
          <section
            key={column}
            id={`column-${column}`}
            className={`board-column ${selected === index ? "selected-column" : ""}`}
            data-empty={counts[column] ? undefined : "true"}
            aria-label={`${column} tasks`}
          >
            <h2 className="small-heading">
              {column} · {counts[column]}
            </h2>
            {tasks
              .filter((t) => taskColumn(t) === column)
              .map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  request={firstRequest.get(t.id)}
                />
              ))}
            {!counts[column] && (
              <p className="metadata muted">
                {column === "Ready"
                  ? "None ready. Held Ready work is in Waiting."
                  : "No tasks"}
              </p>
            )}
          </section>
        ))}
      </div>
      <div className="phone-column-controls">
        <Button
          variant="outline"
          disabled={!before}
          aria-label={
            before
              ? `Previous column: ${before}`
              : `Previous column: none, column 1 of ${columns.length}`
          }
          onClick={() => setSelected(selected - 1)}
        >
          {before ? `← ${before}` : `1 of ${columns.length}`}
        </Button>
        <Button
          variant="outline"
          disabled={!after}
          aria-label={
            after
              ? `Next column: ${after}`
              : `Next column: none, column ${columns.length} of ${columns.length}`
          }
          onClick={() => setSelected(selected + 1)}
        >
          {after ? `${after} →` : `${columns.length} of ${columns.length}`}
        </Button>
      </div>
      <p className="metadata muted board-footer">
        <span className="board-footer-wide">
          Scroll horizontally or choose a column above.{" "}
        </span>
        <span className="board-footer-narrow">Choose a column above. </span>
        Empty columns are collapsed.
      </p>
    </div>
  );
}
export function TaskViews({
  state,
  requests,
  refresh,
  workspace,
  path,
  navigate,
  projectId,
  overview = false,
}: {
  state: ResourceState<TaskAggregate>;
  requests: Requests;
  refresh: () => void;
  workspace: Workspace | null;
  path: string;
  navigate: (path: string) => void;
  projectId?: string;
  overview?: boolean;
}) {
  const base = path.split("?")[0] ?? "/app/tasks",
    filters = parseTaskFilters(
      path.includes("?") ? path.slice(path.indexOf("?")) : "",
    );
  const update = (patch: Partial<TaskFilters>) =>
    navigate(taskFiltersUrl(base, { ...filters, ...patch }));
  const all = state.data?.tasks ?? [],
    tasks = filterTasks(all, filters, projectId);
  const project = workspace?.data.projects.find((p) => p.id === projectId),
    scope = projectId || filters.project;
  return (
    <>
      {project?.paused && (
        <p className="body">
          <StatusBadge tone="warning">Project paused</StatusBadge> New turns are
          held.
        </p>
      )}
      {projectId && (
        <p className="metadata muted work-project-links">
          <a href={`/app/projects/${projectId}/settings`}>Project settings</a>
          <a href={`/project/${projectId}`}>Open existing project controls</a>
        </p>
      )}
      {state.status !== "fresh" && (
        <ResourceStatus state={state} retry={refresh} label="Tasks" />
      )}
      {overview ? (
        <AttentionSection requests={requests} retry={refresh} />
      ) : (
        <AttentionBar
          tasks={all.filter((t) => !scope || t.projectId === scope)}
          requests={requests}
        />
      )}
      <section
        aria-label={projectId ? "Project tasks" : "Across your projects"}
      >
        <TaskToolbar
          filters={filters}
          update={update}
          workspace={workspace}
          projectId={projectId}
          overview={overview}
          count={tasks.length}
          refresh={refresh}
          pending={state.pending}
        />
        {state.data && !tasks.length && (
          <p className="body empty-state">
            {all.some((t) => !projectId || t.projectId === projectId)
              ? "No tasks match these filters."
              : workspace?.data.projects.length
                ? "Ready for your first task. Create an outcome or save a draft."
                : "Create a project in existing operator controls to begin."}
          </p>
        )}
        {filters.view === "board" ? (
          <TaskBoard
            // A new State filter picks its column again; other filters keep the operator's tab.
            key={filters.state}
            tasks={tasks}
            columns={visibleColumns(filters.state)}
            initial={allColumns.find((c) => c === filters.state)}
            requests={requests}
          />
        ) : (
          <div
            className="task-list"
            data-density={overview ? "compact" : undefined}
          >
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
        {state.data && (
          <p className="metadata muted">
            Task states read{" "}
            {new Date(state.data.firstObservedAt).toLocaleTimeString()}–
            {new Date(state.data.lastObservedAt).toLocaleTimeString()}.
          </p>
        )}
      </section>
      {overview && <CompletedWork tasks={all} project={filters.project} />}
    </>
  );
}
