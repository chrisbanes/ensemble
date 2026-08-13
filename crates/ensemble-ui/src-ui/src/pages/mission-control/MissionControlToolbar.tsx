import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useEffect, useState, type Ref } from "react";

import {
  getSystemFreshness,
  isRateLimitLow,
  type MissionControlFilters,
  type MissionIssueStatus,
  type MissionSystemStats,
} from "./model";
import { keyboardShortcuts, shortcutAvailabilityLabel } from "./keyboardShortcuts";

export type MissionControlViewMode = "board" | "list";

interface MissionControlToolbarProps extends MissionControlFilters {
  stats: MissionSystemStats;
  viewMode: MissionControlViewMode;
  isRefreshing: boolean;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: MissionIssueStatus | "all") => void;
  onAttentionOnlyChange: (value: boolean) => void;
  onViewModeChange: (value: MissionControlViewMode) => void;
  onRefresh: () => void;
  searchInputRef?: Ref<HTMLInputElement>;
  shortcutReferenceOpen?: boolean;
  onShortcutReferenceOpenChange?: (open: boolean) => void;
}

const STATUS_OPTIONS: Array<{ value: MissionIssueStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "retrying", label: "Retrying" },
  { value: "waiting_on_human", label: "Waiting" },
  { value: "failed_or_blocked", label: "Failed or Blocked" },
  { value: "completed_recently", label: "Completed" },
];

const FRESHNESS_CLOCK_INTERVAL_MS = 1_000;

function formatTick(value: string | null): string {
  if (!value) return "No tick yet";

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function MissionControlToolbar({
  stats,
  query,
  status,
  attentionOnly,
  viewMode,
  isRefreshing,
  onQueryChange,
  onStatusChange,
  onAttentionOnlyChange,
  onViewModeChange,
  onRefresh,
  searchInputRef,
  shortcutReferenceOpen,
  onShortcutReferenceOpenChange,
}: MissionControlToolbarProps) {
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setClockMs(Date.now()),
      FRESHNESS_CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  const freshness = getSystemFreshness(stats, clockMs);
  const lowRateCapacity = isRateLimitLow(stats.rateLimitRemaining, stats.rateLimitLimit);

  return (
    <header className="rounded-xl border bg-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Mission Control</h1>
            <span
              role="status"
              aria-label={freshness === "fresh" ? "System live and fresh" : "System stale"}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                freshness === "fresh"
                  ? "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                  : "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
              )}
            >
              {freshness === "fresh" ? "Live / Fresh" : "Stale"}
            </span>
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              Last tick {formatTick(stats.lastTickAt)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{stats.running} running</span>
            <span>{stats.retrying} retrying</span>
            <span>{stats.waitingOnHuman} waiting</span>
            <span>{stats.completed} completed</span>
            <span>{stats.failed} failed</span>
            {stats.rateLimitLimit != null && stats.rateLimitRemaining != null ? (
              lowRateCapacity ? (
                <span
                  role="alert"
                  className="font-medium text-amber-700 dark:text-amber-300"
                >
                  Rate low: {stats.rateLimitRemaining}/{stats.rateLimitLimit}
                  {stats.rateLimitResetAt ? `, resets ${formatTick(stats.rateLimitResetAt)}` : ""}
                </span>
              ) : (
                <span>Rate {stats.rateLimitRemaining}/{stats.rateLimitLimit}</span>
              )
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <Input
            ref={searchInputRef}
            aria-label="Search issues"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search issues, steps, activity"
            className="min-w-64"
          />
          <select
            aria-label="Status"
            value={status}
            onChange={(event) => onStatusChange(event.target.value as MissionIssueStatus | "all")}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant={attentionOnly ? "default" : "outline"}
            size="sm"
            aria-pressed={attentionOnly}
            onClick={() => onAttentionOnlyChange(!attentionOnly)}
          >
            Attention only
          </Button>
          <div className="grid grid-cols-2 rounded-lg border bg-muted p-1">
            {(["board", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => onViewModeChange(mode)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground capitalize transition-colors",
                  viewMode === mode && "bg-background text-foreground shadow-sm",
                )}
              >
                {mode === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
          <Popover open={shortcutReferenceOpen} onOpenChange={onShortcutReferenceOpenChange}>
            <PopoverTrigger
              render={<Button variant="outline" size="sm" aria-label="Keyboard shortcuts" />}
            >
              Keyboard shortcuts
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 gap-3 p-4">
              <PopoverHeader>
                <PopoverTitle>Keyboard shortcuts</PopoverTitle>
              </PopoverHeader>
              <ul className="space-y-2">
                {keyboardShortcuts.map((shortcut) => (
                  <li key={shortcut.id} className="flex items-center justify-between gap-4">
                    <span>
                      <span className="block text-muted-foreground">{shortcut.description}</span>
                      <span className="block text-xs text-muted-foreground">
                        {shortcutAvailabilityLabel(shortcut)}
                      </span>
                    </span>
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs font-medium">
                      {shortcut.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  );
}
