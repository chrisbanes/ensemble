import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { useRefreshMutation, useStateQuery } from "@/hooks";
import { AttentionQueue } from "./AttentionQueue";
import { IssueCommandPanel, type IssueCommandPanelTab } from "./IssueCommandPanel";
import {
  isEditableTarget,
  isShortcutAvailable,
  keyboardShortcuts,
  matchesShortcut,
} from "./keyboardShortcuts";
import { MissionControlToolbar, type MissionControlViewMode } from "./MissionControlToolbar";
import { OperationsBoard } from "./OperationsBoard";
import { OperationsList } from "./OperationsList";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  issuesInGroupOrder,
  regroupMissionControlIssues,
  type MissionControlFilters,
  type MissionIssueStatus,
} from "./model";

const VIEW_MODE_KEY = "ensemble.mission-control.view-mode";
const ACTIVE_TAB_KEY = "ensemble.mission-control.active-tab";
const ATTENTION_ONLY_KEY = "ensemble.mission-control.attention-only";
const QUERY_KEY = "ensemble.mission-control.query";
const STATUS_KEY = "ensemble.mission-control.status";
const DETAIL_PANEL_WIDTH_KEY = "ensemble.mission-control.detail-panel-width-rem";
const DETAIL_PANEL_WIDTH_MIN_REM = 28;
const DETAIL_PANEL_WIDTH_MAX_REM = 48;
const DEFAULT_DETAIL_PANEL_WIDTH_REM = 34;
const FILTER_STATUSES: Array<MissionIssueStatus | "all"> = [
  "all",
  "running",
  "retrying",
  "waiting_on_human",
  "failed_or_blocked",
  "completed_recently",
];

const PANEL_TABS: IssueCommandPanelTab[] = [
  "overview",
  "respond",
  "steps",
  "transcript",
  "logs",
  "acceptance",
  "artifacts",
];

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are optional when storage is blocked or unavailable.
  }
}

function readViewMode(): MissionControlViewMode {
  return readPreference(VIEW_MODE_KEY) === "list" ? "list" : "board";
}

function readActiveTab(): IssueCommandPanelTab {
  const value = readPreference(ACTIVE_TAB_KEY);
  return PANEL_TABS.includes(value as IssueCommandPanelTab)
    ? (value as IssueCommandPanelTab)
    : "overview";
}

function readAttentionOnly(): boolean {
  return readPreference(ATTENTION_ONLY_KEY) === "true";
}

function readQuery(): string {
  return readPreference(QUERY_KEY) ?? "";
}

function readStatus(): MissionIssueStatus | "all" {
  const value = readPreference(STATUS_KEY);
  return FILTER_STATUSES.includes(value as MissionIssueStatus | "all")
    ? (value as MissionIssueStatus | "all")
    : "all";
}

function readDetailPanelWidthRem(): number {
  const value = Number(readPreference(DETAIL_PANEL_WIDTH_KEY));
  return Number.isInteger(value) &&
    value >= DETAIL_PANEL_WIDTH_MIN_REM &&
    value <= DETAIL_PANEL_WIDTH_MAX_REM
    ? value
    : DEFAULT_DETAIL_PANEL_WIDTH_REM;
}

export default function MissionControl() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();
  const operationsRegionRef = useRef<HTMLElement>(null);
  const panelRegionRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const restoreSelectionFocusRef = useRef(false);
  const [selectedIssueIdentifier, setSelectedIssueIdentifier] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MissionControlViewMode>(readViewMode);
  const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>(readActiveTab);
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false);
  const [detailPanelWidthRem, setDetailPanelWidthRem] = useState(readDetailPanelWidthRem);
  const [filters, setFilters] = useState<MissionControlFilters>(() => ({
    query: readQuery(),
    status: readStatus(),
    attentionOnly: readAttentionOnly(),
  }));

  useEffect(() => writePreference(VIEW_MODE_KEY, viewMode), [viewMode]);
  useEffect(() => writePreference(ACTIVE_TAB_KEY, activeTab), [activeTab]);
  useEffect(
    () => writePreference(ATTENTION_ONLY_KEY, String(filters.attentionOnly)),
    [filters.attentionOnly],
  );
  useEffect(() => writePreference(QUERY_KEY, filters.query), [filters.query]);
  useEffect(() => writePreference(STATUS_KEY, filters.status), [filters.status]);
  useEffect(
    () => writePreference(DETAIL_PANEL_WIDTH_KEY, String(detailPanelWidthRem)),
    [detailPanelWidthRem],
  );

  const missionState = useMemo(() => (data ? deriveMissionControlState(data) : null), [data]);
  const filteredIssues = useMemo(
    () => (missionState ? filterMissionControlIssues(missionState.issues, filters) : []),
    [filters, missionState],
  );
  const filteredGroups = useMemo(
    () => regroupMissionControlIssues(filteredIssues),
    [filteredIssues],
  );
  const navigationIssues = useMemo(
    () => (viewMode === "board" ? issuesInGroupOrder(filteredGroups) : filteredIssues),
    [filteredGroups, filteredIssues, viewMode],
  );

  useEffect(() => {
    if (
      missionState &&
      selectedIssueIdentifier &&
      !missionState.issues.some((issue) => issue.identifier === selectedIssueIdentifier)
    ) {
      restoreSelectionFocusRef.current = true;
      setSelectedIssueIdentifier(null);
    }
  }, [missionState, selectedIssueIdentifier]);

  useEffect(() => {
    if (selectedIssueIdentifier || !restoreSelectionFocusRef.current) return;

    restoreSelectionFocusRef.current = false;
    const trigger = selectionTriggerRef.current;
    selectionTriggerRef.current = null;
    const focusTarget = trigger?.isConnected ? trigger : operationsRegionRef.current;
    focusTarget?.focus();
  }, [selectedIssueIdentifier]);

  useEffect(() => {
    if (!selectedIssueIdentifier) return;

    const isDesktop =
      typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches;
    if (isDesktop) return;

    panelRegionRef.current?.focus({ preventScroll: true });
    panelRegionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [selectedIssueIdentifier]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      const shortcut = keyboardShortcuts.find((candidate) => matchesShortcut(event, candidate));
      if (!shortcut) return;
      if (isEditableTarget(event.target) && shortcut.id !== "close-panel") return;

      const replySurface = document.getElementById("issue-composer");
      const hasReplySurface = replySurface instanceof HTMLTextAreaElement;
      if (
        !isShortcutAvailable(shortcut, {
          hasSelectedIssue: selectedIssueIdentifier !== null,
          hasReplySurface,
        })
      ) {
        return;
      }

      let handled = false;
      switch (shortcut.id) {
        case "focus-search":
          searchInputRef.current?.focus({ preventScroll: true });
          handled = searchInputRef.current !== null;
          break;
        case "next-issue":
        case "previous-issue": {
          if (navigationIssues.length === 0) break;
          const selectedIndex = navigationIssues.findIndex(
            (issue) => issue.identifier === selectedIssueIdentifier,
          );
          const offset = shortcut.id === "next-issue" ? 1 : -1;
          const index =
            selectedIndex === -1
              ? (offset === 1 ? 0 : navigationIssues.length - 1)
              : (selectedIndex + offset + navigationIssues.length) % navigationIssues.length;
          selectIssue(navigationIssues[index]!.identifier);
          handled = true;
          break;
        }
        case "close-panel":
          closePanel();
          handled = true;
          break;
        case "focus-reply":
          if (replySurface instanceof HTMLTextAreaElement) {
            replySurface.focus({ preventScroll: true });
            handled = true;
          }
          break;
        case "board":
          setViewMode("board");
          handled = true;
          break;
        case "list":
          setViewMode("list");
          handled = true;
          break;
        case "toggle-attention":
          setFilters((current) => ({ ...current, attentionOnly: !current.attentionOnly }));
          handled = true;
          break;
        case "refresh":
          if (!refreshMutation.isPending) {
            refreshMutation.mutate();
            handled = true;
          }
          break;
        case "show-shortcuts":
          setShortcutReferenceOpen(true);
          handled = true;
          break;
      }

      if (handled) event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigationIssues, refreshMutation, selectedIssueIdentifier]);

  function selectIssue(identifier: string) {
    selectionTriggerRef.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setSelectedIssueIdentifier(identifier);
  }

  function closePanel() {
    restoreSelectionFocusRef.current = true;
    setSelectedIssueIdentifier(null);
  }

  if (!missionState) {
    if (isLoading) {
      return <div className="py-12 text-center text-muted-foreground">Loading Mission Control...</div>;
    }

    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <div className="font-semibold text-destructive">Failed to load Mission Control</div>
        <p className="mt-2 text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button
          className="mt-4"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? "Retrying..." : "Retry"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <MissionControlToolbar
        stats={missionState.stats}
        query={filters.query}
        status={filters.status}
        attentionOnly={filters.attentionOnly}
        viewMode={viewMode}
        isRefreshing={refreshMutation.isPending}
        onQueryChange={(query) => setFilters((current) => ({ ...current, query }))}
        onStatusChange={(status: MissionIssueStatus | "all") =>
          setFilters((current) => ({ ...current, status }))
        }
        onAttentionOnlyChange={(attentionOnly) =>
          setFilters((current) => ({ ...current, attentionOnly }))
        }
        onViewModeChange={setViewMode}
        onRefresh={() => refreshMutation.mutate()}
        searchInputRef={searchInputRef}
        shortcutReferenceOpen={shortcutReferenceOpen}
        onShortcutReferenceOpenChange={setShortcutReferenceOpen}
      />

      {isError ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-amber-300/70 bg-amber-50/60 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-100"
        >
          <span>
            Showing the last known state. Refresh failed: {error instanceof Error ? error.message : "Unknown error"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? "Retrying refresh..." : "Retry refresh"}
          </Button>
        </div>
      ) : null}

      {refreshMutation.isError ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            Manual refresh failed: {refreshMutation.error instanceof Error ? refreshMutation.error.message : "Request failed"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? "Retrying manual refresh..." : "Retry manual refresh"}
          </Button>
        </div>
      ) : null}

      <AttentionQueue
        items={missionState.attentionItems}
        selectedIssueIdentifier={selectedIssueIdentifier}
        onSelectIssue={selectIssue}
      />

      <div
        className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_var(--mission-control-panel-width)]"
        style={{ "--mission-control-panel-width": `${detailPanelWidthRem}rem` } as CSSProperties}
      >
        <section
          ref={operationsRegionRef}
          aria-label="Operations"
          tabIndex={-1}
          className="min-w-0 outline-none"
        >
          {missionState.issues.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
              No operational issues are currently tracked.
            </div>
          ) : filteredIssues.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
              No issues match the current filters.
            </div>
          ) : viewMode === "board" ? (
            <OperationsBoard
              groups={filteredGroups}
              selectedIssueIdentifier={selectedIssueIdentifier}
              onSelectIssue={selectIssue}
            />
          ) : (
            <OperationsList
              issues={filteredIssues}
              selectedIssueIdentifier={selectedIssueIdentifier}
              onSelectIssue={selectIssue}
            />
          )}
        </section>
        <section
          ref={panelRegionRef}
          aria-label="Issue command panel"
          tabIndex={-1}
          className="min-w-0 scroll-mt-4 outline-none [&>aside]:!w-full"
        >
          <div className="mb-2 hidden items-center gap-2 xl:flex">
            <label htmlFor="detail-panel-width" className="text-sm text-muted-foreground">
              Detail panel width
            </label>
            <input
              id="detail-panel-width"
              type="range"
              min={DETAIL_PANEL_WIDTH_MIN_REM}
              max={DETAIL_PANEL_WIDTH_MAX_REM}
              step="1"
              value={detailPanelWidthRem}
              onChange={(event) => setDetailPanelWidthRem(Number(event.target.value))}
            />
            <output className="text-sm tabular-nums text-muted-foreground">
              {detailPanelWidthRem} rem
            </output>
          </div>
          <IssueCommandPanel
            identifier={selectedIssueIdentifier}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            onClose={closePanel}
          />
        </section>
      </div>
    </div>
  );
}
