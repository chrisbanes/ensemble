import { type ReactNode, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
  composerOptionsSchema,
  taskSchema,
  uuid,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import { ComposerState, type ComposerInput } from "./composer-state.js";
import { useOperatorResource } from "./resource.js";
import { reasonLabels } from "./tasks.js";
export function TaskComposer({
  client,
  session,
  workspace,
  initialProject = "",
  onRecorded,
}: {
  client: OperatorClient;
  session: Session;
  workspace: Workspace | null;
  initialProject?: string;
  onRecorded: () => void;
}) {
  const [, render] = useState(0);
  const [state] = useState(() => {
    const s = new ComposerState(
      {
        getItem: (k) => sessionStorage.getItem(k),
        setItem: (k, v) => sessionStorage.setItem(k, v),
        removeItem: (k) => sessionStorage.removeItem(k),
      },
      () => render((n) => n + 1),
    );
    if (!s.recovered && uuid.safeParse(initialProject).success)
      s.input = { ...s.input, projectId: initialProject };
    return s;
  });
  useEffect(() => {
    state.activate(() => render((n) => n + 1));
    return () => state.dispose();
  }, [state]);
  const [resumed, setResumed] = useState(
      !state.recovered || state.phase === "unknown",
    ),
    [linkText, setLinkText] = useState(state.input.links.join("\n")),
    [dependencyQuery, setDependencyQuery] = useState(""),
    [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const input = state.input,
    locked = state.phase !== "editable";
  const optionsLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/projects/${input.projectId}/composer-options`,
        composerOptionsSchema,
        signal,
      ),
    [client, input.projectId],
  );
  const options = useOperatorResource(
    input.projectId ? `${session.csrfToken}:${input.projectId}` : null,
    optionsLoader,
  );
  const recordedId = state.phase === "recorded" ? state.frozen?.taskId : null;
  const taskLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(`/api/operator/tasks/${recordedId}`, taskSchema, signal),
    [client, recordedId],
  );
  const current = useOperatorResource(
    recordedId ? `${session.csrfToken}:${recordedId}` : null,
    taskLoader,
  );
  const edit = (patch: Partial<ComposerInput>) => state.edit(patch);
  // Collapsed sections stay mounted, so an error target only needs its section opened.
  const reveal = (field: string) => {
    flushSync(() =>
      setExpanded((open) => new Set(open).add(sectionOf[field] ?? field)),
    );
    document.getElementById(`composer-${field}`)?.focus();
  };
  async function submit(ready: boolean) {
    if (
      state.phase === "editable" &&
      input.projectId &&
      (!options.state.data || options.state.status !== "fresh")
    ) {
      state.notice =
        "Project options are unavailable. Refresh options before submitting.";
      render((n) => n + 1);
      return;
    }
    if (state.phase === "editable" && options.state.data) {
      const o = options.state.data.data;
      if (
        input.profileId &&
        !o.profiles.some((p) => p.id === input.profileId)
      ) {
        state.errors.profileId = "Choose a currently permitted assignee.";
        render((n) => n + 1);
        reveal("profileId");
        return;
      }
      if (
        input.blockerTaskIds.some(
          (id) => !o.dependencies.some((d) => d.id === id),
        )
      ) {
        state.errors.blockerTaskIds =
          "Choose existing dependencies in this project.";
        render((n) => n + 1);
        reveal("blockerTaskIds");
        return;
      }
    }
    const isCurrent = state.captureScope();
    await state.submit(client, session.csrfToken, ready);
    if (!isCurrent()) return;
    const first = Object.keys(state.errors)[0];
    if (first) reveal(first);
    if (state.phase === "recorded") onRecorded();
  }
  if (state.recovered && !resumed && state.phase === "editable")
    return (
      <section
        className="composer recovery-prompt"
        aria-label="Unfinished input"
      >
        <h2 className="section-heading">Unfinished input on this device</h2>
        <p className="body">
          This input was kept in this tab. It is not a saved Ensemble task.
        </p>
        <p className="body">{input.title || "Untitled input"}</p>
        <div className="task-actions">
          <Button onClick={() => setResumed(true)}>
            Resume unfinished input
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              state.discard();
              setLinkText("");
              setResumed(true);
            }}
          >
            Discard unfinished input
          </Button>
        </div>
      </section>
    );
  if (state.phase === "recorded")
    return (
      <section className="composer" aria-label="Creation receipt">
        <h2 className="section-heading">
          {state.frozen?.ready ? "Task Ready" : "Draft saved"}
        </h2>
        <p className="body" role="status">
          {state.notice}
        </p>
        <ActionLink
          variant="primary"
          href={`/app/tasks/${state.frozen?.taskId}`}
        >
          Open task
        </ActionLink>
        <h3 className="small-heading">Current execution</h3>
        <Button
          variant="secondary"
          onClick={current.refresh}
          disabled={current.state.pending}
        >
          Refresh execution
        </Button>
        <ResourceStatus
          state={current.state}
          retry={current.refresh}
          label="Execution observations"
        />
        {current.state.data ? (
          <>
            <p className="body">
              <StatusBadge>
                {current.state.data.data.execution.state}
              </StatusBadge>
            </p>
            {current.state.data.data.admission.reasons.map((r) => (
              <p className="body muted" key={r}>
                {reasonLabels[r]}
              </p>
            ))}
          </>
        ) : (
          <p className="body muted">
            Execution status unavailable. The original creation receipt remains
            confirmed.
          </p>
        )}
        <a className="control" href="/app/tasks">
          Back to tasks
        </a>
      </section>
    );
  const error = (field: string) =>
    state.errors[field] && (
      <span role="alert" className="body error-text">
        {state.errors[field]}
      </span>
    );
  const o = options.state.data?.data;
  const disclosure = (
    section: string,
    label: string,
    summary: string,
    children: ReactNode,
  ) => (
    <details
      className="composer-disclosure"
      open={expanded.has(section)}
      onToggle={(e) => {
        const open = e.currentTarget.open;
        setExpanded((current) => {
          const next = new Set(current);
          if (open) next.add(section);
          else next.delete(section);
          return next;
        });
      }}
    >
      <summary>
        <span className="small-heading">{label}</span>
        <span className="metadata muted">{summary}</span>
      </summary>
      {children}
    </details>
  );
  const assigneeName = input.profileId
    ? (o?.profiles.find((p) => p.id === input.profileId)?.name ??
      "Selected assignee unavailable")
    : o?.routingEnabled
      ? "Automatic allocation via project routing"
      : "Default project lead allocation";
  const count = (n: number, one: string, many: string) =>
    n === 0 ? "None" : `${n} ${n === 1 ? one : many}`;
  return (
    <section className="composer" aria-label="Task composer">
      <p className="introduction muted">
        Describe the outcome you want. Ensemble records a draft or Ready task;
        execution remains subject to project policy and existing holds.
      </p>
      {state.notice && (
        <Alert
          className="resource-status"
          role={state.phase === "unknown" ? "alert" : "status"}
        >
          {state.notice}
        </Alert>
      )}
      {state.phase === "unknown" && (
        <div className="task-actions">
          <Button onClick={() => void submit(state.frozen?.ready ?? false)}>
            Reconcile submission
          </Button>
          <p className="body muted">
            Original task and command IDs are retained. No automatic replay or
            alternate creation is available.
          </p>
        </div>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <fieldset disabled={locked} className="composer-fields">
          <label className="field body" htmlFor="composer-projectId">
            Project
            <NativeSelect
              id="composer-projectId"
              aria-label="Project"
              value={input.projectId}
              onChange={(e) => {
                edit({
                  projectId: e.target.value,
                  profileId: "",
                  blockerTaskIds: [],
                });
                state.notice =
                  "Project changed. Assignee and dependency selections were cleared.";
                setDependencyQuery("");
              }}
            >
              <option value="">Choose a project</option>
              {workspace?.data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? "Name unavailable"}
                </option>
              ))}
            </NativeSelect>
            {error("projectId")}
          </label>
          {input.projectId && (
            <>
              <ResourceStatus
                state={options.state}
                retry={options.refresh}
                label="Project options"
              />
              {o && (
                <div className="composer-policy">
                  <p className="body">
                    Configured project lead:{" "}
                    {o.lead?.name ??
                      (o.lead ? "Name unavailable" : "Unconfigured")}
                  </p>
                  {o.project.paused && (
                    <p className="body">
                      Project paused: Ready is recorded, but new turns remain
                      held.
                    </p>
                  )}
                  {!o.lead && (
                    <p className="body">
                      Configure a project lead before execution can begin.
                    </p>
                  )}
                  <p className="body muted">
                    Capacity: {o.capacity.projectUsage}/
                    {o.capacity.projectLimit} project · {o.capacity.globalUsage}
                    /{o.capacity.globalLimit} global. Dependencies, Stop and
                    ownership are rechecked at admission.
                  </p>
                </div>
              )}
            </>
          )}
          <label className="field body" htmlFor="composer-title">
            Task title
            <Input
              id="composer-title"
              aria-label="Task title"
              className="control"
              value={input.title}
              onChange={(e) => edit({ title: e.target.value })}
              aria-invalid={Boolean(state.errors.title)}
            />
            {error("title")}
          </label>
          <label className="field body" htmlFor="composer-outcome">
            Desired outcome
            <Textarea
              id="composer-outcome"
              aria-label="Desired outcome"
              className="control outcome-input"
              rows={9}
              autoGrow
              maxAutoGrowHeight={480}
              value={input.outcome}
              onChange={(e) => edit({ outcome: e.target.value })}
              aria-invalid={Boolean(state.errors.outcome)}
            />
            <span className="metadata muted">
              Outcome, optional context and reference links share a
              16,000-character brief limit.
            </span>
            {error("outcome")}
          </label>
          {disclosure(
            "context",
            "Optional context",
            input.context.trim()
              ? `${input.context.trim().length.toLocaleString()} characters`
              : "None",
            <label className="field body" htmlFor="composer-context">
              Optional context
              <Textarea
                id="composer-context"
                aria-label="Optional context"
                className="control"
                rows={5}
                autoGrow
                value={input.context}
                onChange={(e) => edit({ context: e.target.value })}
              />
              {error("context")}
            </label>,
          )}
          {disclosure(
            "links",
            "Reference links",
            count(input.links.length, "link", "links"),
            <label className="field body" htmlFor="composer-links">
              Reference links
              <Textarea
                id="composer-links"
                aria-label="Reference links"
                className="control"
                rows={3}
                value={linkText}
                onChange={(e) => {
                  setLinkText(e.target.value);
                  edit({ links: e.target.value.split("\n").filter(Boolean) });
                }}
              />
              <span className="metadata muted">
                One HTTP or HTTPS link per line. References are passive context
                and grant no repository access.
              </span>
              {error("links")}
            </label>,
          )}
          {disclosure(
            "assignee",
            "Assignee",
            assigneeName,
            <label className="field body" htmlFor="composer-profileId">
              Assignee
              <NativeSelect
                id="composer-profileId"
                aria-label="Assignee"
                value={input.profileId}
                onChange={(e) => edit({ profileId: e.target.value })}
                disabled={!o || options.state.status !== "fresh"}
              >
                <option value="">
                  {o?.routingEnabled
                    ? "Automatic allocation via project routing"
                    : "Default project lead allocation"}
                </option>
                {o?.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? "Name unavailable"}
                  </option>
                ))}
              </NativeSelect>
              <span className="metadata muted">
                An explicit permitted assignee bypasses routing, while all
                admission holds still apply. The project lead remains
                accountable.
              </span>
              {error("profileId")}
            </label>,
          )}
          {disclosure(
            "dependencies",
            "Dependencies",
            count(input.blockerTaskIds.length, "selected", "selected"),
            <fieldset
              className="dependency-options"
              disabled={!o || options.state.status !== "fresh"}
            >
              <legend className="small-heading">Dependencies</legend>
              <p className="body muted">
                Choose existing tasks in this project. These must finish before
                execution can begin.
              </p>
              <label className="field body" htmlFor="dependency-search">
                Find dependencies
                <Input
                  id="dependency-search"
                  className="control"
                  value={dependencyQuery}
                  onChange={(e) => setDependencyQuery(e.target.value)}
                />
              </label>
              <div
                id="composer-blockerTaskIds"
                className="dependency-list"
                tabIndex={-1}
              >
                {o?.dependencies
                  .filter(
                    (d) =>
                      !dependencyQuery ||
                      d.title
                        ?.toLocaleLowerCase()
                        .includes(dependencyQuery.toLocaleLowerCase()),
                  )
                  .map((d) => (
                    <label className="dependency-choice body" key={d.id}>
                      <input
                        type="checkbox"
                        aria-label={d.title ?? "Title unavailable"}
                        checked={input.blockerTaskIds.includes(d.id)}
                        onChange={(e) =>
                          edit({
                            blockerTaskIds: e.target.checked
                              ? [...input.blockerTaskIds, d.id]
                              : input.blockerTaskIds.filter(
                                  (id) => id !== d.id,
                                ),
                          })
                        }
                      />
                      <span>{d.title ?? "Title unavailable"}</span>
                      <span className="metadata muted">
                        {d.state}
                        {d.source ? ` · GitHub #${d.source.number ?? "?"}` : ""}
                      </span>
                    </label>
                  ))}
              </div>
              {o?.dependencies.length === 0 && (
                <p className="body muted">No existing tasks in this project.</p>
              )}
              {error("blockerTaskIds")}
            </fieldset>,
          )}
        </fieldset>
        {!locked && (
          <div className="composer-actions">
            <Button type="submit">Create and start</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void submit(false)}
            >
              Save draft
            </Button>
            <p className="metadata muted">
              Saved drafts are not Ready. Create and start records Ready without
              bypassing holds.
            </p>
          </div>
        )}
        {state.phase === "pending" && (
          <p className="body" role="status">
            Waiting for the command outcome. Input is frozen.
          </p>
        )}
      </form>
    </section>
  );
}

const sectionOf: Record<string, string> = {
  context: "context",
  links: "links",
  profileId: "assignee",
  blockerTaskIds: "dependencies",
};
