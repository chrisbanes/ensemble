import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  workspaceComparisonReadSchema,
  workspaceDirectoryReadSchema,
  type Session,
  type WorkspaceComparisonRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  matchesWorkspaceComparisonRead,
  type ExpectedWorkspaceComparisonRead,
} from "./comparison-read-match.js";
import { Button, StatusBadge } from "./components.js";
import { DiffHunk, DiffLayoutControls, type Anchor } from "./diff-view.js";
import { CommentAction, ReviewComposer } from "./local-review.js";
import { RangeControls } from "./range-controls.js";
import { useOperatorResource } from "./resource.js";
import { comparisonSideAnchor } from "./review-anchor.js";
import type {
  TaskChangeSelection,
  TaskChangesState,
} from "./task-workspace-state.js";
import { dateLabel, FinishedTurn, PendingTurn } from "./turn-identity.js";
import { NativeSelect } from "./ui/native-select.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type Snapshot = Extract<ComparisonData, { state: "available" }>["comparison"];
type Entry = Snapshot["entries"][number];
type SelectableAnchor = Omit<Anchor, "context"> & {
  context: Exclude<Anchor["context"], "result">;
};
type Target = TaskChangesState["target"];

function entryKey(entry: Entry, index: number) {
  return [
    entry.repositoryId ?? "",
    entry.path,
    entry.previousPath ?? "",
    entry.change,
    entry.changeSet ?? "",
    String(index),
  ].join("\u0000");
}

function snapshotFor(data: ComparisonData | undefined): Snapshot | undefined {
  if (data?.state === "available") return data.comparison;
  if (data?.state === "unsettled") return data.latestFinished;
  if ("comparison" in (data ?? {}) && data?.comparison)
    return data.comparison as Snapshot;
  return undefined;
}

function responseId(data: ComparisonData | undefined): string | null {
  if (data?.state === "available") return data.comparisonId;
  if (data?.state === "unsettled")
    return data.latestFinished?.comparisonId ?? data.pending.comparisonId;
  return data?.comparisonId ?? null;
}

function responseIdForExactRead(data: ComparisonData): string | null {
  if (data.state === "available") return data.comparisonId;
  if (data.state === "unsettled") return data.pending.comparisonId;
  return (
    data.comparisonId ??
    ("comparison" in data ? (data.comparison?.comparisonId ?? null) : null)
  );
}

function exactReadMatches(data: ComparisonData, requestedId: string) {
  if (data.state === "unsettled")
    return data.pending.comparisonId === requestedId;
  return responseIdForExactRead(data) === requestedId;
}

type SelectionMatch = {
  entry: Entry;
  index: number;
  anchor: SelectableAnchor;
  minLine: number;
  maxLine: number;
};

function selectionMatch(
  selection: TaskChangeSelection,
  snapshot: Snapshot,
  taskId: string,
): SelectionMatch | null {
  for (const [index, entry] of snapshot.entries.entries()) {
    const entryPath =
      selection.side === "left"
        ? (entry.previousPath ?? entry.path)
        : entry.path;
    const sideContent = selection.side === "left" ? entry.left : entry.right;
    if (
      entryPath !== selection.path ||
      (entry.repositoryId ?? null) !== selection.repositoryId ||
      sideContent?.sha256 !== selection.contentSha256 ||
      sideContent.lineCount === null ||
      sideContent.lineCount === undefined ||
      selection.startLine < 1 ||
      selection.endLine < selection.startLine ||
      selection.endLine > sideContent.lineCount ||
      selection.currentLine < selection.startLine ||
      selection.currentLine > selection.endLine ||
      selection.rangeAnchorLine < 1 ||
      selection.rangeAnchorLine > sideContent.lineCount
    )
      continue;
    for (const hunk of entry.hunks) {
      const anchor =
        selection.side === "left" ? hunk.leftAnchor : hunk.rightAnchor;
      const minLine = selection.side === "left" ? hunk.oldStart : hunk.newStart;
      const lineCount =
        selection.side === "left" ? hunk.oldLines : hunk.newLines;
      const maxLine = minLine + lineCount - 1;
      if (
        anchor &&
        anchor.context !== "result" &&
        anchor.taskId === taskId &&
        anchor.path === selection.path &&
        anchor.contentSha256 === selection.contentSha256 &&
        anchor.repositoryId === selection.repositoryId &&
        anchor.context === selection.context &&
        anchor.side === selection.side &&
        minLine <= selection.startLine &&
        selection.endLine <= maxLine &&
        minLine <= selection.rangeAnchorLine &&
        selection.rangeAnchorLine <= maxLine
      )
        return {
          entry,
          index,
          anchor: anchor as SelectableAnchor,
          minLine,
          maxLine,
        };
    }
  }
  return null;
}

type SelectionFields = Pick<
  TaskChangeSelection,
  | "entryKey"
  | "currentLine"
  | "rangeAnchorLine"
  | "startLine"
  | "endLine"
  | "minLine"
  | "maxLine"
  | "pin"
>;

function changeSelection(
  anchor: SelectableAnchor,
  fields: SelectionFields,
): TaskChangeSelection {
  return {
    ...fields,
    path: anchor.path,
    repositoryId: anchor.repositoryId,
    context: anchor.context,
    comparisonId: anchor.comparisonId,
    side: anchor.side,
    contentSha256: anchor.contentSha256,
    ...(anchor.workId ? { workId: anchor.workId } : {}),
    ...(anchor.threadId ? { threadId: anchor.threadId } : {}),
    ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
  };
}

/** Entries are matched by repository, path and change set; a changed entry differs in content. */
function entrySignature(entry: Entry) {
  return [
    entry.change,
    entry.state,
    entry.previousPath ?? "",
    entry.left?.sha256 ?? "",
    entry.right?.sha256 ?? "",
  ].join("\u0000");
}

function refreshSummary(
  previous: Snapshot | undefined,
  next: Snapshot | undefined,
) {
  if (!previous || !next)
    return "Refresh found a different comparison; it could not be compared with the previous observation.";
  const identity = (entry: Entry) =>
    [entry.repositoryId ?? "", entry.path, entry.changeSet ?? ""].join(
      "\u0000",
    );
  const before = new Map(
    previous.entries.map((entry) => [identity(entry), entrySignature(entry)]),
  );
  const after = new Map(
    next.entries.map((entry) => [identity(entry), entrySignature(entry)]),
  );
  let added = 0;
  let changed = 0;
  for (const [key, signature] of after) {
    const old = before.get(key);
    if (old === undefined) added++;
    else if (old !== signature) changed++;
  }
  const removed = [...before.keys()].filter((key) => !after.has(key)).length;
  return `Refresh found a different comparison since the previous observation: ${added} added, ${removed} removed, ${changed} changed file entries.`;
}

function useTaskRepositories(
  client: OperatorClient,
  session: Session,
  taskId: string,
) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/tasks/${taskId}/files?scope=workspace&showIgnored=false`,
        workspaceDirectoryReadSchema,
        signal,
      ),
    [client, taskId],
  );
  return useOperatorResource(
    `${session.csrfToken}:${taskId}:changes-repositories`,
    loader,
  );
}

export function TaskWorkspaceChanges({
  client,
  session,
  taskId,
  assignments,
  state,
  changed,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  assignments: Array<{ assignmentId: string; name: string | null }>;
  state: TaskChangesState;
  changed: () => void;
}) {
  const repositoriesResource = useTaskRepositories(client, session, taskId);
  const directory = repositoriesResource.state.data?.data;
  const repositories = useMemo(
    () =>
      directory?.entries.flatMap((item) =>
        item.kind === "repository" ? [item.repositoryId] : [],
      ) ?? [],
    [directory],
  );
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const [reload, setReload] = useState<{
    key: string;
    id: number;
  } | null>(null);
  const reloads = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const [request, setRequest] = useState<{
    key: string;
    pending: boolean;
    error: string | null;
  }>({ key: "", pending: false, error: null });

  useEffect(() => {
    if (!directory) return;
    if (state.repositoryId && repositories.includes(state.repositoryId)) return;
    const next = repositories[0] ?? null;
    if (state.repositoryId === next) return;
    state.repositoryId = next;
    changedRef.current();
  }, [directory, repositories, state]);

  const repositoryId =
    state.repositoryId && repositories.includes(state.repositoryId)
      ? state.repositoryId
      : null;
  const baseBranch = repositoryId
    ? (state.baseBranchByRepository[repositoryId] ?? null)
    : null;
  const changeSet = repositoryId
    ? (state.changeSetByRepository[repositoryId] ?? "all")
    : "all";
  const expected: ExpectedWorkspaceComparisonRead = {
    target: state.target,
    repositoryId: state.target === "last-turn" ? null : repositoryId,
    baseBranch: state.target === "branch" ? baseBranch : null,
    changeSet: state.target === "uncommitted" ? changeSet : null,
  };
  const key = JSON.stringify({
    auth: session.csrfToken,
    taskId,
    ...expected,
  });
  const baseBranchOptionsScopeKey = JSON.stringify({
    auth: session.csrfToken,
    taskId,
    repositoryId,
  });
  const cached = state.comparisonReads[key];
  const reloadIsNew =
    reload?.key === key && reloads.current.get(key) !== reload.id;

  useEffect(() => {
    if (state.baseBranchOptionsScopeKey === baseBranchOptionsScopeKey) return;
    state.baseBranchOptionsScopeKey = baseBranchOptionsScopeKey;
    state.baseBranchOptions = [];
    changedRef.current();
  }, [baseBranchOptionsScopeKey, state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key encodes auth, task and exact comparison inputs; reload id requests an explicit Refresh.
  useEffect(() => {
    const controller = new AbortController();
    const requestSequence = ++sequence.current;
    if (cached && !reloadIsNew) {
      setRequest((current) =>
        current.key === key && current.pending
          ? { key, pending: false, error: current.error }
          : current,
      );
      return () => controller.abort();
    }
    if (state.target !== "last-turn" && !repositoryId) {
      setRequest({ key, pending: false, error: null });
      return () => controller.abort();
    }
    if (reloadIsNew && reload) reloads.current.set(key, reload.id);
    setRequest({ key, pending: true, error: null });
    const authIsCurrent = client.captureAuthenticationScope();
    const stale = () =>
      controller.signal.aborted ||
      requestSequence !== sequence.current ||
      !authIsCurrent();
    const invalid = () =>
      setRequest({ key, pending: false, error: "invalid-response" });
    const query = new URLSearchParams({ target: state.target });
    if (state.target !== "last-turn" && repositoryId)
      query.set("repositoryId", repositoryId);
    if (state.target === "branch" && baseBranch)
      query.set("baseBranch", baseBranch);
    if (state.target === "uncommitted") query.set("changeSet", changeSet);
    if (reloadIsNew && state.target !== "last-turn")
      query.set("refresh", "true");
    void client
      .read(
        `/api/operator/tasks/${taskId}/comparisons?${query}`,
        workspaceComparisonReadSchema,
        controller.signal,
      )
      .then(async (read) => {
        if (stale()) return;
        if (!matchesWorkspaceComparisonRead(read.data, expected, taskId))
          return invalid();
        const exactId = responseIdForExactRead(read.data);
        let finalRead = read;
        if (exactId) {
          const exactQuery = new URLSearchParams({
            target: state.target,
            comparisonId: exactId,
          });
          finalRead = await client.read(
            `/api/operator/tasks/${taskId}/comparisons?${exactQuery}`,
            workspaceComparisonReadSchema,
            controller.signal,
          );
          if (stale()) return;
          if (
            !matchesWorkspaceComparisonRead(finalRead.data, expected, taskId) ||
            !exactReadMatches(finalRead.data, exactId)
          )
            return invalid();
        }
        if (
          finalRead.data.state === "available" &&
          finalRead.data.comparisonId !== finalRead.data.comparison.comparisonId
        )
          return invalid();
        const snapshot = snapshotFor(finalRead.data);
        if (
          expected.target === "branch" &&
          expected.repositoryId &&
          snapshot?.target === "branch" &&
          snapshot.taskId === taskId &&
          snapshot.repositoryId === expected.repositoryId
        ) {
          state.baseBranchOptionsScopeKey = baseBranchOptionsScopeKey;
          state.baseBranchOptions = [...snapshot.availableBaseBranches];
        }
        const previousRead = state.comparisonReads[key];
        const oldId = responseId(previousRead);
        const newId = responseId(finalRead.data);
        state.refreshNotice =
          previousRead && oldId !== newId
            ? {
                key,
                text: refreshSummary(snapshotFor(previousRead), snapshot),
              }
            : null;
        if (state.selection && oldId !== newId) {
          const match =
            snapshot && selectionMatch(state.selection, snapshot, taskId);
          if (match) {
            const previousSelection = state.selection;
            state.selectedEntryKey = entryKey(match.entry, match.index);
            state.selection = changeSelection(match.anchor, {
              entryKey: state.selectedEntryKey,
              currentLine: previousSelection.currentLine,
              rangeAnchorLine: previousSelection.rangeAnchorLine,
              startLine: previousSelection.startLine,
              endLine: previousSelection.endLine,
              minLine: match.minLine,
              maxLine: match.maxLine,
              pin: previousSelection.pin,
            });
          } else {
            state.selection = null;
            state.selectedEntryKey = null;
            state.notice =
              "The selected lines are no longer present in this refreshed comparison.";
          }
        }
        state.comparisonReads[key] = finalRead.data;
        changedRef.current();
        setRequest({ key, pending: false, error: null });
      })
      .catch((error: unknown) => {
        if (stale()) return;
        setRequest({
          key,
          pending: false,
          error: error instanceof Error ? error.message : "unavailable",
        });
      });
    return () => controller.abort();
    // reloadIsNew is ref-derived and flips during this effect; including it
    // would abort the explicit refresh on its own pending-state rerender.
  }, [
    client,
    taskId,
    session.csrfToken,
    state,
    state.target,
    repositoryId,
    baseBranch,
    changeSet,
    key,
    Boolean(cached),
    reload?.key,
    reload?.id,
  ]);

  const current = cached;
  const snapshot = snapshotFor(current);
  const currentRequest = request.key === key ? request : null;
  const id = responseId(current);
  const selectedIndex =
    snapshot && state.selectedEntryKey
      ? snapshot.entries.findIndex(
          (entry, index) => entryKey(entry, index) === state.selectedEntryKey,
        )
      : -1;
  const selected =
    selectedIndex >= 0 ? snapshot?.entries[selectedIndex] : undefined;
  const availableBaseBranches =
    (current && "availableBaseBranches" in current
      ? current.availableBaseBranches
      : current &&
          "comparison" in current &&
          current.comparison &&
          "availableBaseBranches" in current.comparison
        ? current.comparison.availableBaseBranches
        : undefined) ??
    (state.baseBranchOptionsScopeKey === baseBranchOptionsScopeKey
      ? state.baseBranchOptions
      : []);

  const setTarget = (target: Target) => {
    state.target = target;
    state.selectedEntryKey = null;
    state.selection = null;
    state.notice = "";
    state.mobileView = "list";
    changed();
  };
  const selectEntry = (entry: Entry, index: number) => {
    state.selectedEntryKey = entryKey(entry, index);
    state.selection = null;
    state.mobileView = "preview";
    changed();
  };
  const selectLine = (
    anchor: Anchor,
    currentLine: number,
    minLine: number,
    maxLine: number,
    extend: boolean,
  ) => {
    if (anchor.context === "result" || !selected) return;
    const selectedKey = entryKey(selected, selectedIndex);
    state.selectedEntryKey = selectedKey;
    const previous = state.selection;
    const sameRange =
      previous?.entryKey === selectedKey &&
      previous.path === anchor.path &&
      previous.repositoryId === anchor.repositoryId &&
      previous.context === anchor.context &&
      previous.comparisonId === anchor.comparisonId &&
      previous.side === anchor.side &&
      previous.contentSha256 === anchor.contentSha256 &&
      previous.minLine === minLine &&
      previous.maxLine === maxLine;
    // Switching side or hunk starts a new selection; a fixed edge or Shift extends this one.
    const extending = sameRange && (extend || previous.pin !== null);
    const rangeAnchorLine = extending ? previous.rangeAnchorLine : currentLine;
    state.selection = changeSelection(anchor as SelectableAnchor, {
      entryKey: selectedKey,
      currentLine,
      rangeAnchorLine,
      startLine: Math.min(rangeAnchorLine, currentLine),
      endLine: Math.max(rangeAnchorLine, currentLine),
      minLine,
      maxLine,
      pin: extending ? previous.pin : null,
    });
    state.notice = "";
    state.mobileView = "preview";
    changed();
  };
  const setRangeEdge = (edge: "start" | "end") => {
    const selection = state.selection;
    if (!selection) return;
    if (selection.pin && selection.pin !== edge) selection.pin = null;
    else {
      selection.pin = edge;
      selection.rangeAnchorLine = selection.currentLine;
      selection.startLine = selection.endLine = selection.currentLine;
    }
    changed();
  };
  const refresh = () => {
    setReload({ key, id: (reload?.id ?? 0) + 1 });
  };
  const originKey = `changes:${snapshot?.comparisonId}`;

  return (
    <section
      className="workspace-changes"
      aria-labelledby="workspace-changes-heading"
    >
      <h4 id="workspace-changes-heading">Workspace comparisons</h4>
      <p>
        Current workspace snapshots stay fixed until Refresh. Last turn is a
        separate actual runtime capture; recorded result and delivery changes
        remain below.
      </p>
      <div className="task-actions changes-controls">
        <label htmlFor="changes-target">
          Comparison target
          <NativeSelect
            id="changes-target"
            aria-label="Comparison target"
            value={state.target}
            onChange={(event) => setTarget(event.target.value as Target)}
          >
            <option value="branch" disabled={repositories.length === 0}>
              Branch
            </option>
            <option value="last-turn">Last turn</option>
            <option value="uncommitted" disabled={repositories.length === 0}>
              Uncommitted
            </option>
          </NativeSelect>
        </label>
        <Button
          variant="secondary"
          onClick={() => void repositoriesResource.refresh()}
          disabled={repositoriesResource.state.pending}
        >
          Refresh repositories
        </Button>
      </div>
      {state.target !== "last-turn" && (
        <div className="changes-filters">
          <label htmlFor="changes-repository">
            Repository
            <NativeSelect
              id="changes-repository"
              aria-label="Repository"
              value={repositoryId ?? ""}
              onChange={(event) => {
                state.repositoryId = event.target.value || null;
                state.selectedEntryKey = null;
                state.selection = null;
                state.notice = "";
                state.mobileView = "list";
                changed();
              }}
            >
              <option value="">Select a repository</option>
              {repositories.map((repository) => (
                <option key={repository} value={repository}>
                  {repository}
                </option>
              ))}
            </NativeSelect>
          </label>
          {state.target === "branch" && repositoryId && (
            <label htmlFor="changes-base-branch">
              Local base branch
              <NativeSelect
                id="changes-base-branch"
                aria-label="Local base branch"
                value={baseBranch ?? ""}
                onChange={(event) => {
                  state.baseBranchByRepository[repositoryId] =
                    event.target.value || "";
                  state.selectedEntryKey = null;
                  state.selection = null;
                  state.notice = "";
                  changed();
                }}
              >
                <option value="">Choose a local base branch</option>
                {availableBaseBranches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {state.target === "uncommitted" && repositoryId && (
            <label htmlFor="changes-change-set">
              Change set
              <NativeSelect
                id="changes-change-set"
                aria-label="Change set"
                value={changeSet}
                onChange={(event) => {
                  state.changeSetByRepository[repositoryId] = event.target
                    .value as "all" | "staged" | "unstaged";
                  state.selectedEntryKey = null;
                  state.selection = null;
                  state.notice = "";
                  changed();
                }}
              >
                <option value="all">All</option>
                <option value="staged">Staged</option>
                <option value="unstaged">Unstaged</option>
              </NativeSelect>
            </label>
          )}
        </div>
      )}
      {repositoriesResource.state.error && (
        <p role="alert">
          Repository listing refresh failed. The last observation is retained.
        </p>
      )}
      {state.target !== "last-turn" && !repositoryId && (
        <p role="status">
          {directory?.state === "ready" && repositories.length === 0
            ? "No repository is bound to this task. Branch and Uncommitted are unavailable; Last turn remains available."
            : directory?.state
              ? `Repository listing is ${directory.state}; repository identity is unavailable.`
              : "Loading this task's bound repositories…"}
        </p>
      )}
      {current && (
        <div className="changes-observation">
          <StatusBadge
            tone={
              current.state === "available"
                ? "success"
                : current.state === "unsettled"
                  ? "warning"
                  : "neutral"
            }
          >
            {current.state === "unsettled"
              ? "Current turn unsettled"
              : current.state}
          </StatusBadge>
          {id && <span>Comparison {id}</span>}
          {snapshot && <span>Observed {dateLabel(snapshot.observedAt)}</span>}
          {snapshot && snapshot.target !== "turn" && (
            <span className="changes-baseline">
              Baseline: repository {snapshot.repositoryId} ·{" "}
              {snapshot.baseline
                ? `${snapshot.baseline.kind}${snapshot.baseline.branch ? ` of ${snapshot.baseline.branch}` : ""} @ ${snapshot.baseline.commit}`
                : "not established"}
            </span>
          )}
          {currentRequest?.pending && <span>Refreshing…</span>}
          {currentRequest?.error && (
            <span role="alert">
              Refresh failed ({currentRequest.error}); the last successful
              comparison remains shown.
            </span>
          )}
          {current.state === "unavailable" &&
            current.reason === "base-branch-required" && (
              <span>
                Select a local branch. No branch is inferred or checked out.
              </span>
            )}
          {current.state === "unavailable" &&
            current.reason === "no-merge-base" && (
              <span>The selected local branch has no usable merge base.</span>
            )}
          {"reason" in current && current.reason && (
            <span>Reason: {current.reason}</span>
          )}
          {snapshot?.truncated && (
            <span>Comparison output is bounded and truncated.</span>
          )}
          <Button
            variant="secondary"
            onClick={refresh}
            disabled={currentRequest?.pending}
          >
            Refresh comparison
          </Button>
        </div>
      )}
      {state.refreshNotice?.key === key && (
        <p role="status" className="changes-refresh-notice">
          {state.refreshNotice.text}
        </p>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      {snapshot?.target === "turn" && current?.state !== "unsettled" && (
        <FinishedTurn snapshot={snapshot} assignments={assignments} />
      )}
      {current?.state === "unsettled" && (
        <PendingTurn data={current} assignments={assignments} />
      )}
      {!current && !currentRequest?.pending && (
        <p role="status">Choose a repository or select Last turn.</p>
      )}
      {currentRequest?.pending && !current && (
        <p role="status">Reading the selected comparison…</p>
      )}
      {currentRequest?.error && !current && (
        <p role="alert">Comparison is unavailable ({currentRequest.error}).</p>
      )}
      {current?.state === "unavailable" && (
        <p role="status">
          No current comparison is available for this selection.
        </p>
      )}
      {current?.state === "gap" && (
        <p role="status">
          This observation contains gaps; unavailable or unsupported entries
          remain identified as such.
        </p>
      )}
      {current?.target === "last-turn" &&
        current.state === "unavailable" &&
        !snapshot && (
          <p role="status">
            No retained latest finished capture is available. Older uncaptured
            turns cannot be reconstructed from a result revision.
          </p>
        )}
      {snapshot && (
        <div className="changes-workbench" data-mobile-view={state.mobileView}>
          <aside
            className="changes-rail"
            data-mobile-hidden={state.mobileView === "preview"}
            aria-label="Changed files"
          >
            <h5>Changed files</h5>
            <ul
              className="changes-entry-list"
              aria-label="Workspace comparison files"
            >
              {snapshot.entries.map((entry, index) => {
                const selectedEntryKey = entryKey(entry, index);
                const label =
                  entry.change === "renamed" && entry.previousPath
                    ? `${entry.previousPath} → ${entry.path}`
                    : entry.path;
                const isSelected = state.selectedEntryKey === selectedEntryKey;
                return (
                  <li key={selectedEntryKey}>
                    <button
                      type="button"
                      className="changes-entry"
                      aria-label={`${entry.change} ${label}, ${entry.state}`}
                      aria-current={isSelected ? "true" : undefined}
                      title={`${entry.repositoryId ?? "Task workspace"}/${label}`}
                      onClick={() => selectEntry(entry, index)}
                    >
                      <StatusBadge>{entry.change.toUpperCase()}</StatusBadge>
                      <span className="changes-entry-path">{label}</span>
                      {entry.changeSet && (
                        <span className="changes-entry-set">
                          {entry.changeSet}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {snapshot.entries.length === 0 && (
              <p>No changed entries in this observation.</p>
            )}
          </aside>
          <div
            className="changes-reading-area"
            data-mobile-hidden={state.mobileView === "list"}
          >
            <Button
              className="changes-back"
              variant="secondary"
              onClick={() => {
                state.mobileView = "list";
                changed();
              }}
            >
              Back to changed files
            </Button>
            {selected ? (
              <>
                <div className="changes-file-heading">
                  <h5>{selected.path}</h5>
                  {selected.previousPath && (
                    <p>Before path: {selected.previousPath}</p>
                  )}
                  <p>
                    {selected.change.toUpperCase()} · {selected.state}
                    {selected.changeSet ? ` · ${selected.changeSet}` : ""}
                    {selected.reason ? ` · ${selected.reason}` : ""}
                  </p>
                </div>
                {selected.state === "binary" ||
                selected.state === "unsupported" ||
                selected.state === "gap" ? (
                  <p role="status">
                    Text diff is unavailable; the entry state and observation
                    identity are retained.
                  </p>
                ) : (
                  <>
                    <DiffLayoutControls
                      layout={state.layout}
                      onChange={(layout) => {
                        state.layout = layout;
                        changed();
                      }}
                    />
                    {selected.hunks.map((hunk, index) => (
                      <DiffHunk
                        // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
                        key={`${snapshot.comparisonId}:${index}`}
                        hunk={hunk}
                        hunkIndex={index}
                        layout={state.layout}
                        select={{
                          comparisonId: snapshot.comparisonId,
                          selection: state.selection,
                          originKey,
                          onSelect: selectLine,
                        }}
                      />
                    ))}
                  </>
                )}
                <p className="changes-provenance">
                  {snapshot.target === "turn"
                    ? `Last turn · work ${snapshot.workId} · assignment ${snapshot.assignmentId} · profile ${snapshot.profileId}`
                    : `Current workspace · repository ${snapshot.repositoryId} · ${snapshot.baseline?.kind ?? "baseline unavailable"} ${snapshot.baseline?.branch ?? ""} ${snapshot.baseline?.commit ?? ""}`}
                </p>
                {state.selection && (
                  <p role="status" className="changes-selection">
                    Selected{" "}
                    {state.selection.side === "left" ? "Before" : "After"} lines{" "}
                    {state.selection.startLine}–{state.selection.endLine} ·{" "}
                    {state.selection.path} · {state.selection.contentSha256} ·
                    comparison {state.selection.comparisonId}
                  </p>
                )}
                <RangeControls
                  line={state.selection?.currentLine ?? null}
                  anchor={state.selection?.rangeAnchorLine ?? null}
                  pin={state.selection?.pin ?? null}
                  onSet={setRangeEdge}
                />
                <CommentAction
                  originKey={originKey}
                  label={
                    snapshot.target === "turn"
                      ? "Last turn comparison"
                      : `${snapshot.target} comparison`
                  }
                  anchor={
                    state.selection
                      ? comparisonSideAnchor(taskId, state.selection)
                      : null
                  }
                />
                <ReviewComposer originKey={originKey} />
              </>
            ) : (
              <p className="changes-empty-selection">
                Select a changed file to inspect its exact Before and After.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
