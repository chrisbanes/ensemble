import { useState } from "react";
import type {
  Workspace,
  TaskListSummary,
} from "../../src/operator/contracts.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import type { ResourceState } from "./resource.js";
import {
  columns,
  filterTasks,
  parseTaskFilters,
  taskColumn,
  taskDetailHref,
  taskFiltersUrl,
  taskReasons,
  type TaskAggregate,
  type TaskFilters,
} from "./tasks.js";
function TaskContents({ task }: { task: TaskListSummary }) {
  return (
    <>
      <p className="metadata muted task-project-metadata">
        {task.project.name ?? "Project name unavailable"} ·{" "}
        {task.source
          ? `GitHub ${task.source.repositoryName ?? "repository unavailable"} #${task.source.number ?? "?"}`
          : "Local task"}
      </p>
      <a className="small-heading task-title" href={taskDetailHref(task)}>
        {task.title ?? "Title unavailable"}
      </a>
      <p className="body task-status">
        <StatusBadge tone={task.attention.count ? "warning" : "neutral"}>
          {taskColumn(task)}
        </StatusBadge>{" "}
        <span>
          {task.ready ? "Ready" : "Not Ready"} · {task.execution.state}
        </span>
      </p>
      <p className="metadata task-lead">
        Task lead:{" "}
        {task.lead?.name ?? (task.lead ? "Name unavailable" : "Unconfigured")}
      </p>
      {task.source && (
        <p className="metadata muted task-source-state">
          GitHub source: {task.source.state ?? "state unavailable"}
        </p>
      )}
      {taskReasons(task).map((reason) => (
        <p key={reason} className="body muted task-reason">
          {reason}
        </p>
      ))}
    </>
  );
}
export function TaskRow({ task }: { task: TaskListSummary }) {
  return (
    <article className="task-row" data-task-id={task.id}>
      <TaskContents task={task} />
    </article>
  );
}
export function TaskCard({ task }: { task: TaskListSummary }) {
  return (
    <article data-task-id={task.id}>
      <Card className="task-card">
        <TaskContents task={task} />
      </Card>
    </article>
  );
}
export function TaskBoard({ tasks }: { tasks: TaskListSummary[] }) {
  const [selected, setSelected] = useState(0);
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
            variant={selected === index ? "primary" : "secondary"}
            className="column-tab"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index);
              document
                .getElementById(`column-${column}`)
                ?.scrollIntoView({ block: "nearest", inline: "start" });
            }}
          >
            {column} ({tasks.filter((t) => taskColumn(t) === column).length})
          </Button>
        ))}
      </div>
      <div className="phone-column-controls">
        <Button
          variant="secondary"
          onClick={() => setSelected((i) => Math.max(0, i - 1))}
          disabled={selected === 0}
        >
          Previous column
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            setSelected((i) => Math.min(columns.length - 1, i + 1))
          }
          disabled={selected === columns.length - 1}
        >
          Next column
        </Button>
      </div>
      <div className="board-columns">
        {columns.map((column, index) => (
          <section
            key={column}
            id={`column-${column}`}
            className={`board-column ${selected === index ? "selected-column" : ""}`}
            aria-label={`${column} tasks`}
          >
            <h2 className="small-heading">
              {column}{" "}
              <span className="muted">
                ({tasks.filter((t) => taskColumn(t) === column).length})
              </span>
            </h2>
            {tasks
              .filter((t) => taskColumn(t) === column)
              .map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            {!tasks.some((t) => taskColumn(t) === column) && (
              <p className="body muted">No tasks</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
export function TaskViews({
  state,
  refresh,
  workspace,
  path,
  navigate,
  projectId,
  overview = false,
}: {
  state: ResourceState<TaskAggregate>;
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
  const tasks = filterTasks(state.data?.tasks ?? [], filters, projectId);
  const attention = tasks.filter((t) => t.attention.count > 0),
    work = overview ? tasks.filter((t) => t.attention.count === 0) : tasks;
  const project = workspace?.data.projects.find((p) => p.id === projectId);
  return (
    <>
      <p className="introduction muted">
        {projectId
          ? "Tasks in this project. Readiness, source status and execution are separate."
          : "Tasks across your projects. Action requests and ordinary progress remain distinct."}
      </p>
      {project?.paused && (
        <p className="body">
          <StatusBadge tone="warning">Project paused</StatusBadge> New turns are
          held.
        </p>
      )}
      <div className="task-actions">
        {projectId && (
          <ActionLink
            variant="secondary"
            href={`/app/projects/${projectId}/settings`}
          >
            Project settings
          </ActionLink>
        )}
        {projectId && (
          <ActionLink variant="secondary" href={`/project/${projectId}`}>
            Open existing project controls
          </ActionLink>
        )}
        <ActionLink
          variant="primary"
          href={`/app/tasks/new${projectId ? `?project=${projectId}` : ""}`}
          onClick={(e) => {
            e.preventDefault();
            navigate(e.currentTarget.getAttribute("href") ?? "/app/tasks/new");
          }}
        >
          New task
        </ActionLink>
        <Button variant="secondary" onClick={refresh} disabled={state.pending}>
          Refresh tasks
        </Button>
      </div>
      {state.status !== "fresh" && (
        <ResourceStatus state={state} retry={refresh} label="Tasks" />
      )}
      {state.data && (
        <p className="metadata muted">
          Task states read{" "}
          {new Date(state.data.firstObservedAt).toLocaleTimeString()}–
          {new Date(state.data.lastObservedAt).toLocaleTimeString()}.
        </p>
      )}
      {overview && (
        <section aria-label="Needs attention">
          <Card className="attention-preview">
            <div className="section-title">
              <h2 className="section-heading">Needs attention</h2>
              <a
                className="control"
                href="/app/inbox"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/app/inbox");
                }}
              >
                View Inbox
              </a>
            </div>
            {state.data && !attention.length && (
              <p className="body muted">
                No action requests in this observation.
              </p>
            )}
            {attention.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </Card>
        </section>
      )}
      <section aria-label={overview ? "Work" : "Tasks"}>
        {overview && <h2 className="section-heading">Work</h2>}
        <div className="task-filters">
          <label className="field body" htmlFor="task-search">
            Search tasks
            <Input
              id="task-search"
              value={filters.q}
              maxLength={512}
              onChange={(e) => update({ q: e.target.value })}
            />
          </label>
          {!projectId && (
            <label className="field body" htmlFor="task-project">
              Project
              <NativeSelect
                id="task-project"
                aria-label="Project"
                value={filters.project}
                onChange={(e) => update({ project: e.target.value })}
              >
                <option value="">All projects</option>
                {workspace?.data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? "Name unavailable"}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          <label className="field body" htmlFor="task-state">
            State
            <NativeSelect
              id="task-state"
              aria-label="State"
              value={filters.state}
              onChange={(e) => update({ state: e.target.value })}
            >
              <option value="">All states</option>
              {columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="field body" htmlFor="task-source">
            Source
            <NativeSelect
              id="task-source"
              aria-label="Source"
              value={filters.source}
              onChange={(e) => update({ source: e.target.value })}
            >
              <option value="">All sources</option>
              <option value="local">Local</option>
              <option value="github">GitHub</option>
            </NativeSelect>
          </label>
          <label className="field body" htmlFor="task-ready">
            Readiness
            <NativeSelect
              id="task-ready"
              aria-label="Readiness"
              value={filters.ready}
              onChange={(e) => update({ ready: e.target.value })}
            >
              <option value="">Any readiness</option>
              <option value="yes">Ready</option>
              <option value="no">Not Ready</option>
            </NativeSelect>
          </label>
        </div>
        <div
          className="view-toggle"
          role="toolbar"
          aria-label="Task presentation"
        >
          <Button
            variant={filters.view === "list" ? "primary" : "secondary"}
            aria-pressed={filters.view === "list"}
            onClick={() => update({ view: "list" })}
          >
            List
          </Button>
          <Button
            variant={filters.view === "board" ? "primary" : "secondary"}
            aria-pressed={filters.view === "board"}
            onClick={() => update({ view: "board" })}
          >
            Board
          </Button>
          <p className="metadata muted">{work.length} tasks</p>
        </div>
        {state.data && !tasks.length && (
          <p className="body empty-state">
            {state.data.tasks.some(
              (t) => !projectId || t.projectId === projectId,
            )
              ? "No tasks match these filters."
              : workspace?.data.projects.length
                ? "Ready for your first task. Create an outcome or save a draft."
                : "Create a project in existing operator controls to begin."}
          </p>
        )}
        {filters.view === "board" ? (
          <TaskBoard tasks={work} />
        ) : (
          <div className="task-list">
            {work.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
