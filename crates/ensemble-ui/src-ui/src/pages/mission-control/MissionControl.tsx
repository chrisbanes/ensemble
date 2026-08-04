import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useRefreshMutation, useStateQuery } from "@/hooks";
import { AttentionQueue } from "./AttentionQueue";
import { IssueCommandPanel, type IssueCommandPanelTab } from "./IssueCommandPanel";
import { MissionControlToolbar, type MissionControlViewMode } from "./MissionControlToolbar";
import { OperationsBoard } from "./OperationsBoard";
import { OperationsList } from "./OperationsList";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  regroupMissionControlIssues,
  type MissionControlFilters,
  type MissionIssueStatus,
} from "./model";

const VIEW_MODE_KEY = "ensemble.mission-control.view-mode";
const ACTIVE_TAB_KEY = "ensemble.mission-control.active-tab";
const ATTENTION_ONLY_KEY = "ensemble.mission-control.attention-only";

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

export default function MissionControl() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();
  const operationsRegionRef = useRef<HTMLElement>(null);
  const panelRegionRef = useRef<HTMLElement>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const restoreSelectionFocusRef = useRef(false);
  const [selectedIssueIdentifier, setSelectedIssueIdentifier] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MissionControlViewMode>(readViewMode);
  const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>(readActiveTab);
  const [filters, setFilters] = useState<MissionControlFilters>(() => ({
    query: "",
    status: "all",
    attentionOnly: readAttentionOnly(),
  }));

  useEffect(() => writePreference(VIEW_MODE_KEY, viewMode), [viewMode]);
  useEffect(() => writePreference(ACTIVE_TAB_KEY, activeTab), [activeTab]);
  useEffect(
    () => writePreference(ATTENTION_ONLY_KEY, String(filters.attentionOnly)),
    [filters.attentionOnly],
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

  function selectIssue(identifier: string) {
    selectionTriggerRef.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setSelectedIssueIdentifier(identifier);
    const attentionItem = missionState?.attentionItems.find(
      (item) => item.issueIdentifier === identifier,
    );
    if (attentionItem?.kind === "human_input") {
      setActiveTab("respond");
    } else if (
      attentionItem?.kind === "failure" &&
      (attentionItem.primaryAction === "Inspect" || attentionItem.primaryAction === "Open")
    ) {
      setActiveTab("overview");
    }
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

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_34rem]">
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
