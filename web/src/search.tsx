import { useCallback, useEffect, useState } from "react";
import {
  searchReadSchema,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import { Button, ActionLink, ResourceStatus, TextField } from "./components.js";
import { NativeSelect } from "./ui/native-select.js";
const localDay = (value: string | null) => {
  if (!value) return "";
  const d = new Date(Number(value));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export class SearchState {
  dataPath = "";
  data: z.infer<typeof searchReadSchema> | null = null;
  origin: string | null = null;
  selected: string | null = null;
  scrollY = 0;
}
export function Search({
  client,
  session,
  workspace,
  path,
  navigate,
  state,
}: {
  client: OperatorClient;
  session: Session;
  workspace: Workspace | null;
  path: string;
  navigate: (p: string) => void;
  state: SearchState;
}) {
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    query = params.get("query") ?? "",
    project = params.get("projectId") ?? "",
    type = params.get("type") ?? "",
    historical = params.get("historical") === "true";
  const [input, setInput] = useState(query),
    [projectInput, setProject] = useState(project),
    [typeInput, setType] = useState(type),
    [historyInput, setHistorical] = useState(historical),
    [after, setAfter] = useState(localDay(params.get("after"))),
    [before, setBefore] = useState(localDay(params.get("before")));
  if (state.origin === null)
    state.origin =
      (history.state as { workspaceOrigin?: string } | null)?.workspaceOrigin ??
      "/app/tasks";
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/search?${path.split("?")[1] ?? ""}`,
        searchReadSchema,
        signal,
      ),
    [client, path],
  );
  const resource = useOperatorResource(
      query ? `${session.csrfToken}:${path}` : null,
      loader,
    ),
    data = resource.state.data ?? (state.dataPath === path ? state.data : null);
  useEffect(() => {
    if (resource.state.data) {
      state.data = resource.state.data;
      state.dataPath = path;
      requestAnimationFrame(() => {
        scrollTo(0, state.scrollY);
        if (state.selected)
          [...document.querySelectorAll<HTMLElement>("[data-search-record]")]
            .find((el) => el.dataset.searchRecord === state.selected)
            ?.querySelector<HTMLElement>("a")
            ?.focus({ preventScroll: true });
      });
    }
  }, [resource.state.data, state, path]);
  useEffect(
    () => () => {
      state.scrollY = scrollY;
    },
    [state],
  );
  function submit() {
    state.data = null;
    state.scrollY = 0;
    const p = new URLSearchParams({
      query: input,
      historical: String(historyInput),
    });
    if (projectInput) p.set("projectId", projectInput);
    if (typeInput) p.set("type", typeInput);
    if (after) p.set("after", String(new Date(`${after}T00:00:00`).getTime()));
    if (before)
      p.set("before", String(new Date(`${before}T23:59:59.999`).getTime()));
    navigate(`/app/search?${p}`);
  }
  return (
    <section className="search-workspace" aria-label="Retained record search">
      {history.state?.origin ? (
        <Button
          variant="secondary"
          onClick={() => {
            const delta =
              (history.state?.workspaceIndex ?? 0) -
              (history.state?.entryIndex ?? 0);
            if (delta < 0) history.go(delta);
            else navigate(state.origin ?? "/app/tasks");
          }}
        >
          Back to originating workspace
        </Button>
      ) : (
        <ActionLink href={state.origin}>
          Back to originating workspace
        </ActionLink>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          id="retained-query"
          label="Search retained task, decision and result records"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={256}
        />
        <div className="task-actions">
          <label htmlFor="search-project">
            Project
            <NativeSelect
              id="search-project"
              aria-label="Project"
              value={projectInput}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">All permitted projects</option>
              {workspace?.data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? "Unavailable"}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor="search-type">
            Record type
            <NativeSelect
              id="search-type"
              aria-label="Record type"
              value={typeInput}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All types</option>
              {["task", "decision", "result"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="search-history">
            <input
              type="checkbox"
              checked={historyInput}
              onChange={(e) => setHistorical(e.target.checked)}
            />
            Include historical records
          </label>
          <label>
            From date
            <input
              className="control"
              type="date"
              value={after}
              onChange={(e) => setAfter(e.target.value)}
            />
          </label>
          <label>
            Through date
            <input
              className="control"
              type="date"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            />
          </label>
        </div>
        <Button disabled={!input.trim()}>Search records</Button>
      </form>
      <p>
        Search covers permitted retained task, decision and result projections.
        It does not search complete agent transcripts or generate summaries.
      </p>
      {query && (
        <Button variant="secondary" onClick={resource.refresh}>
          Refresh results
        </Button>
      )}
      {query && (
        <ResourceStatus state={resource.state} retry={resource.refresh} />
      )}{" "}
      {!query && <p>Enter a phrase to search across projects.</p>}
      {query && resource.state.error && data && (
        <p role="status">
          Failed refresh. Last successful matches retained from{" "}
          {new Date(data.observedAt).toLocaleString()}.
        </p>
      )}
      {query && data && (
        <>
          <p>
            {data.data.matches.length} match(es) · retained records only ·{" "}
            {data.data.omittedCount} omitted or inaccessible
          </p>
          {!data.data.matches.length && (
            <p>
              No permitted retained match. Other or omitted history is outside
              this search.
            </p>
          )}
          <ul className="search-matches">
            {data.data.matches.map((m) => (
              <li
                key={m.recordId}
                data-search-record={m.recordId}
                aria-current={
                  state.selected === m.recordId ? "true" : undefined
                }
              >
                <p>
                  {m.projectName ?? "Project unavailable"} · {m.type}{" "}
                  {m.historical ? "· historical" : ""} ·{" "}
                  {new Date(m.createdAt).toLocaleString()}
                </p>
                <a
                  className="control task-title"
                  href={m.href}
                  onClick={() => {
                    state.selected = m.recordId;
                    state.scrollY = scrollY;
                  }}
                >
                  {m.taskTitle ?? "Title unavailable"}
                </a>
                <p className="literal-preview">
                  {m.excerpt ?? "Excerpt unavailable"}
                </p>
                <p className="metadata">
                  Record {m.recordId} · source {m.sourceId ?? "unavailable"} ·
                  result {m.resultId ?? "not supplied"}
                </p>
              </li>
            ))}
          </ul>
          {data.data.nextCursor && (
            <Button
              variant="secondary"
              onClick={() => {
                const p = new URLSearchParams(path.split("?")[1]);
                if (!data.data.nextCursor) return;
                p.set("cursor", data.data.nextCursor);
                navigate(`/app/search?${p}`);
              }}
            >
              Next retained matches
            </Button>
          )}
        </>
      )}
    </section>
  );
}
