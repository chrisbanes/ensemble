import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
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
import { useOperatorResource } from "./resource.js";
import type {
  TaskChangeSelection,
  TaskChangesState,
} from "./task-workspace-state.js";
import { NativeSelect } from "./ui/native-select.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type Snapshot = Extract<ComparisonData, { state: "available" }>["comparison"];
type Entry = Snapshot["entries"][number];
type Hunk = Entry["hunks"][number];
type Anchor = NonNullable<Hunk["leftAnchor"]>;
type SelectableAnchor = Omit<Anchor, "context"> & {
  context: Exclude<Anchor["context"], "result">;
};
type Target = TaskChangesState["target"];
type PatchLine = {
  kind: "context" | "deleted" | "added" | "note";
  oldLine?: number;
  newLine?: number;
  text: string;
};
type PairedLine = { oldLine?: PatchLine; newLine?: PatchLine };

function dateLabel(value: number | undefined) {
  return value === undefined
    ? "not retained"
    : new Date(value).toLocaleString();
}

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

function pairedLines(hunk: Hunk): PairedLine[] {
  const result: PairedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let removed: PatchLine[] = [];
  let added: PatchLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++)
      result.push({
        ...(removed[index] ? { oldLine: removed[index] } : {}),
        ...(added[index] ? { newLine: added[index] } : {}),
      });
    removed = [];
    added = [];
  };
  for (const source of hunk.patch.split("\n")) {
    if (source.startsWith("@@") || source.startsWith("\\ No newline")) continue;
    const marker = source[0];
    const text = source.slice(1);
    if (marker === " ") {
      flush();
      result.push({
        oldLine: { kind: "context", oldLine, newLine, text },
        newLine: { kind: "context", oldLine, newLine, text },
      });
      oldLine++;
      newLine++;
    } else if (marker === "-") {
      removed.push({ kind: "deleted", oldLine, text });
      oldLine++;
    } else if (marker === "+") {
      added.push({ kind: "added", newLine, text });
      newLine++;
    } else if (source) {
      flush();
      result.push({ oldLine: { kind: "note", text: source } });
    }
  }
  flush();
  return result;
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
  taskLeadName,
  state,
  changed,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  assignments: Array<{ assignmentId: string; name: string | null }>;
  taskLeadName: string | null;
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
        if (
          controller.signal.aborted ||
          requestSequence !== sequence.current ||
          !authIsCurrent()
        )
          return;
        if (!matchesWorkspaceComparisonRead(read.data, expected, taskId)) {
          setRequest({ key, pending: false, error: "invalid-response" });
          return;
        }
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
          if (
            controller.signal.aborted ||
            requestSequence !== sequence.current ||
            !authIsCurrent()
          )
            return;
          if (
            !matchesWorkspaceComparisonRead(finalRead.data, expected, taskId) ||
            !exactReadMatches(finalRead.data, exactId)
          ) {
            setRequest({ key, pending: false, error: "invalid-response" });
            return;
          }
        }
        if (
          finalRead.data.state === "available" &&
          finalRead.data.comparisonId !== finalRead.data.comparison.comparisonId
        ) {
          setRequest({ key, pending: false, error: "invalid-response" });
          return;
        }
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
        const oldId = responseId(state.comparisonReads[key]);
        if (state.selection && oldId !== responseId(finalRead.data)) {
          const match =
            snapshot && selectionMatch(state.selection, snapshot, taskId);
          if (match) {
            const previousSelection = state.selection;
            state.selectedEntryKey = entryKey(match.entry, match.index);
            state.selection = {
              entryKey: entryKey(match.entry, match.index),
              path: match.anchor.path,
              repositoryId: match.anchor.repositoryId,
              context: match.anchor.context,
              comparisonId: match.anchor.comparisonId,
              side: match.anchor.side,
              currentLine: previousSelection.currentLine,
              rangeAnchorLine: previousSelection.rangeAnchorLine,
              startLine: previousSelection.startLine,
              endLine: previousSelection.endLine,
              contentSha256: match.anchor.contentSha256,
              minLine: match.minLine,
              maxLine: match.maxLine,
              rangeStartSet: true,
              rangeEndSet: true,
              ...(match.anchor.workId ? { workId: match.anchor.workId } : {}),
              ...(match.anchor.threadId
                ? { threadId: match.anchor.threadId }
                : {}),
              ...(match.anchor.turnId ? { turnId: match.anchor.turnId } : {}),
            };
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
        if (
          controller.signal.aborted ||
          requestSequence !== sequence.current ||
          !authIsCurrent()
        )
          return;
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
  const selectAnchor = (
    entry: Entry,
    index: number,
    anchor: Anchor,
    currentLine: number,
    minLine: number,
    maxLine: number,
    extend = false,
  ) => {
    if (anchor.context === "result") return;
    state.selectedEntryKey = entryKey(entry, index);
    const previous = state.selection;
    const sameRange =
      extend &&
      previous?.entryKey === entryKey(entry, index) &&
      previous.path === anchor.path &&
      previous.repositoryId === anchor.repositoryId &&
      previous.context === anchor.context &&
      previous.comparisonId === anchor.comparisonId &&
      previous.side === anchor.side &&
      previous.contentSha256 === anchor.contentSha256 &&
      previous.minLine === minLine &&
      previous.maxLine === maxLine;
    const rangeAnchorLine = sameRange ? previous.rangeAnchorLine : currentLine;
    const startLine = Math.min(rangeAnchorLine, currentLine);
    const endLine = Math.max(rangeAnchorLine, currentLine);
    state.selection = {
      entryKey: entryKey(entry, index),
      path: anchor.path,
      repositoryId: anchor.repositoryId,
      context: anchor.context,
      comparisonId: anchor.comparisonId,
      side: anchor.side,
      currentLine,
      rangeAnchorLine,
      startLine,
      endLine,
      contentSha256: anchor.contentSha256,
      minLine,
      maxLine,
      rangeStartSet: true,
      rangeEndSet: true,
      ...(anchor.workId ? { workId: anchor.workId } : {}),
      ...(anchor.threadId ? { threadId: anchor.threadId } : {}),
      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
    };
    state.notice = "";
    state.mobileView = "preview";
    changed();
  };
  const refresh = () => {
    setReload({ key, id: (reload?.id ?? 0) + 1 });
  };

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
      {state.notice && <p role="status">{state.notice}</p>}
      {current?.state === "unsettled" && (
        <PendingTurn
          data={current}
          assignments={assignments}
          taskLeadName={taskLeadName}
        />
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
                    <div
                      className="task-actions changes-layout-controls"
                      role="toolbar"
                      aria-label="Diff layout"
                    >
                      <Button
                        variant={
                          state.layout === "split" ? "primary" : "secondary"
                        }
                        aria-pressed={state.layout === "split"}
                        onClick={() => {
                          state.layout = "split";
                          changed();
                        }}
                      >
                        Split
                      </Button>
                      <Button
                        variant={
                          state.layout === "unified" ? "primary" : "secondary"
                        }
                        aria-pressed={state.layout === "unified"}
                        onClick={() => {
                          state.layout = "unified";
                          changed();
                        }}
                      >
                        Unified
                      </Button>
                    </div>
                    {selected.hunks.map((hunk, index) => (
                      <DiffHunk
                        // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
                        key={`${snapshot.comparisonId}:${index}`}
                        entry={selected}
                        entryIndex={selectedIndex}
                        comparisonId={snapshot.comparisonId}
                        hunk={hunk}
                        hunkIndex={index}
                        layout={state.layout}
                        selection={state.selection}
                        onSelect={selectAnchor}
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

function PendingTurn({
  data,
  assignments,
  taskLeadName,
}: {
  data: Extract<ComparisonData, { state: "unsettled" }>;
  assignments: Array<{ assignmentId: string; name: string | null }>;
  taskLeadName: string | null;
}) {
  const pending = data.pending;
  const assignment = assignments.find(
    (item) => item.assignmentId === pending.identity.assignmentId,
  );
  const agent = assignment?.name ?? taskLeadName ?? "Agent name unavailable";
  const finishedAssignment = data.latestFinished
    ? assignments.find(
        (item) => item.assignmentId === data.latestFinished?.assignmentId,
      )
    : undefined;
  const finishedAgent =
    finishedAssignment?.name ?? taskLeadName ?? "Agent name unavailable";
  return (
    <section className="changes-pending-turn" aria-label="Current actual turn">
      <h5>Current actual turn</h5>
      <p>
        Agent {agent} · profile {pending.identity.profileId} · work{" "}
        {pending.identity.workId} · assignment {pending.identity.assignmentId}
      </p>
      <p>
        Turn {pending.turnId ?? "not yet bound"} · thread{" "}
        {pending.threadId ?? "not yet bound"} · outcome {pending.outcome} ·{" "}
        capture {pending.captureState}
      </p>
      <p>
        Capture started {dateLabel(pending.startedAt)} · before observation{" "}
        {pending.beforeObservedAt === undefined
          ? (pending.beforeState ?? "not retained")
          : dateLabel(pending.beforeObservedAt)}
        {" · "}after observation{" "}
        {pending.afterObservedAt === undefined
          ? (pending.afterState ?? "not observed")
          : dateLabel(pending.afterObservedAt)}
      </p>
      {pending.reason && <p>Capture limitation: {pending.reason}</p>}
      {data.latestFinished && (
        <p>
          Latest finished capture remains separate: agent {finishedAgent} · work{" "}
          {data.latestFinished.workId} · turn{" "}
          {data.latestFinished.turnId ?? "not retained"} · outcome{" "}
          {data.latestFinished.outcome} · capture started{" "}
          {dateLabel(data.latestFinished.startedAt)} · before observation{" "}
          {data.latestFinished.beforeObservedAt === undefined
            ? "not retained"
            : dateLabel(data.latestFinished.beforeObservedAt)}{" "}
          · after observation {dateLabel(data.latestFinished.observedAt)}.
        </p>
      )}
      <p>
        A partial or unsettled capture does not establish that runtime writes
        have ended or change a hold.
      </p>
    </section>
  );
}

function DiffHunk({
  entry,
  entryIndex,
  comparisonId,
  hunk,
  hunkIndex,
  layout,
  selection,
  onSelect,
}: {
  entry: Entry;
  entryIndex: number;
  comparisonId: string;
  hunk: Hunk;
  hunkIndex: number;
  layout: "split" | "unified";
  selection: TaskChangeSelection | null;
  onSelect: (
    entry: Entry,
    index: number,
    anchor: Anchor,
    line: number,
    minLine: number,
    maxLine: number,
    extend?: boolean,
  ) => void;
}) {
  const rows = useMemo(() => pairedLines(hunk), [hunk]);
  const root = useRef<HTMLDivElement>(null);
  const handleLineKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    side: "left" | "right",
    row: number,
    anchor: Anchor,
    minLine: number,
    maxLine: number,
  ) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const targetSide = event.key === "ArrowLeft" ? "left" : "right";
      const target = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>(
          `button[data-row="${row}"][data-side="${targetSide}"]`,
        ) ?? [],
      ).find((button) => button.getClientRects().length > 0);
      if (target) {
        event.preventDefault();
        target.focus();
      }
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const sideLines = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        `button[data-side="${side}"]`,
      ) ?? [],
    ).filter((button) => button.getClientRects().length > 0);
    const index = sideLines.indexOf(event.currentTarget);
    const target = sideLines[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    const line = Number(target.dataset.line);
    if (!Number.isSafeInteger(line)) return;
    event.preventDefault();
    target.focus();
    const origin = Number(event.currentTarget.dataset.line);
    // Shift extends from the focused line even when it was not yet selected.
    if (event.shiftKey && Number.isSafeInteger(origin))
      onSelect(entry, entryIndex, anchor, origin, minLine, maxLine, true);
    onSelect(entry, entryIndex, anchor, line, minLine, maxLine, event.shiftKey);
  };
  const panel = (side: "left" | "right") => (
    <div className="changes-diff-side">
      <h6>{side === "left" ? "Before" : "After"}</h6>
      {rows.map((pair, row) => {
        const line = side === "left" ? pair.oldLine : pair.newLine;
        const anchor = side === "left" ? hunk.leftAnchor : hunk.rightAnchor;
        if (!line)
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
              key={row}
              className="changes-line changes-line-empty"
            >
              <span aria-hidden="true"> </span>
            </div>
          );
        const number = side === "left" ? line.oldLine : line.newLine;
        const selectable =
          line.kind === "context" ||
          (side === "left" && line.kind === "deleted") ||
          (side === "right" && line.kind === "added");
        const minLine = side === "left" ? hunk.oldStart : hunk.newStart;
        const maxLine =
          minLine + (side === "left" ? hunk.oldLines : hunk.newLines) - 1;
        if (selectable && anchor && number !== undefined) {
          const matchingSelection =
            selection?.comparisonId === comparisonId &&
            selection.side === side &&
            selection.path === anchor.path &&
            selection.contentSha256 === anchor.contentSha256;
          const selected =
            matchingSelection &&
            selection.startLine <= number &&
            number <= selection.endLine;
          const current = matchingSelection && selection.currentLine === number;
          return (
            <button
              type="button"
              className={`changes-line changes-selectable-line ${selected ? "is-selected" : ""}`}
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
              key={row}
              aria-pressed={selected}
              aria-current={current ? "true" : undefined}
              aria-label={`${side === "left" ? "Before" : "After"} line ${number}, ${anchor.path}; hunk lines ${minLine}–${maxLine}`}
              data-row={row}
              data-side={side}
              data-line={number}
              onKeyDown={(event) =>
                handleLineKeyDown(event, side, row, anchor, minLine, maxLine)
              }
              onClick={(event) =>
                onSelect(
                  entry,
                  entryIndex,
                  anchor,
                  number,
                  minLine,
                  maxLine,
                  event.shiftKey,
                )
              }
            >
              <span className="changes-line-number">{number}</span>
              <code>{line.text}</code>
            </button>
          );
        }
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
            key={row}
            className={`changes-line changes-line-${line.kind}`}
          >
            <span className="changes-line-number">{number ?? ""}</span>
            <code>{line.text || " "}</code>
          </div>
        );
      })}
    </div>
  );
  return (
    <section
      ref={root}
      className="changes-hunk"
      aria-label={`Diff hunk ${hunkIndex + 1}`}
    >
      <h6 className="changes-hunk-heading">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </h6>
      <div
        className={`changes-diff-split ${layout === "split" ? "is-active" : ""}`}
      >
        {panel("left")}
        {panel("right")}
      </div>
      <div
        className={`changes-diff-unified ${layout === "unified" ? "is-active" : ""}`}
      >
        {rows.flatMap((pair, row) =>
          [pair.oldLine, pair.newLine]
            .filter((line): line is PatchLine => Boolean(line))
            .map((line, sideIndex) => {
              const side = line.kind === "deleted" ? "left" : "right";
              const anchor =
                side === "left" ? hunk.leftAnchor : hunk.rightAnchor;
              const number = side === "left" ? line.oldLine : line.newLine;
              const selectable =
                line.kind === "context" ||
                (side === "left" && line.kind === "deleted") ||
                (side === "right" && line.kind === "added");
              const minLine = side === "left" ? hunk.oldStart : hunk.newStart;
              const maxLine =
                minLine + (side === "left" ? hunk.oldLines : hunk.newLines) - 1;
              const matchingSelection =
                selection?.comparisonId === comparisonId &&
                selection.side === side &&
                selection.path === anchor?.path &&
                selection.contentSha256 === anchor?.contentSha256;
              const selected =
                matchingSelection &&
                number !== undefined &&
                selection.startLine <= number &&
                number <= selection.endLine;
              const current =
                matchingSelection && selection.currentLine === number;
              if (selectable && anchor && number !== undefined)
                return (
                  <button
                    type="button"
                    className={`changes-line changes-selectable-line ${selected ? "is-selected" : ""}`}
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
                    key={`${row}:${sideIndex}`}
                    aria-pressed={selected}
                    aria-current={current ? "true" : undefined}
                    aria-label={`${side === "left" ? "Before" : "After"} line ${number}, ${anchor.path}; hunk lines ${minLine}–${maxLine}`}
                    data-row={row}
                    data-side={side}
                    data-line={number}
                    onKeyDown={(event) =>
                      handleLineKeyDown(
                        event,
                        side,
                        row,
                        anchor,
                        minLine,
                        maxLine,
                      )
                    }
                    onClick={(event) =>
                      onSelect(
                        entry,
                        entryIndex,
                        anchor,
                        number,
                        minLine,
                        maxLine,
                        event.shiftKey,
                      )
                    }
                  >
                    <span className="changes-line-number">
                      {side === "left" ? `-${number}` : `+${number}`}
                    </span>
                    <code>{line.text}</code>
                  </button>
                );
              return (
                <div
                  className={`changes-line changes-line-${line.kind}`}
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable observed diff are identified by position.
                  key={`${row}:${sideIndex}`}
                >
                  <span className="changes-line-number">
                    {line.kind === "context"
                      ? (line.oldLine ?? "")
                      : side === "left"
                        ? `-${number ?? ""}`
                        : `+${number ?? ""}`}
                  </span>
                  <code>{line.text || " "}</code>
                </div>
              );
            }),
        )}
      </div>
    </section>
  );
}
