import { cn } from "@/lib/utils";

import { formatTokenCount, formatUpdatedAt } from "./format";
import type { MissionIssueSummary } from "./model";

interface OperationsListProps {
  issues: MissionIssueSummary[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

function signalTexts(issue: MissionIssueSummary): string[] {
  const signals: string[] = [];
  if (issue.attention) signals.push("Needs attention");
  if (issue.retryAttempt != null) signals.push(`retry ${issue.retryAttempt}`);
  if (issue.turnCount != null) signals.push(`${issue.turnCount} turns`);
  if (issue.completedAt) signals.push("complete");
  if (issue.tokenTotal != null) signals.push(formatTokenCount(issue.tokenTotal));
  return signals.length > 0 ? signals : ["--"];
}

export function OperationsList({ issues, selectedIssueIdentifier, onSelectIssue }: OperationsListProps) {
  if (issues.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No issues match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-[minmax(10rem,1.1fr)_8rem_minmax(10rem,1fr)_8rem] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <span>Issue</span>
            <span>Status</span>
            <span>Activity</span>
            <span className="text-right">Signals</span>
          </div>
          <div className="divide-y">
            {issues.map((issue) => {
              const selected = selectedIssueIdentifier === issue.identifier;
              const updatedText = formatUpdatedAt(issue.updatedAt);
              const inspect = issue.capabilities.inspect;
              const disabled = !inspect.enabled;
              const disabledReason = inspect.disabled_reason ?? "Inspection is unavailable; refresh and try again.";

              return (
                <button
                  key={`${issue.status}:${issue.id}`}
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectIssue(issue.identifier)}
                  disabled={disabled}
                  aria-label={disabled ? `${issue.identifier}: ${disabledReason}` : undefined}
                  title={disabled ? disabledReason : undefined}
                  className={cn(
                    "grid w-full grid-cols-[minmax(10rem,1.1fr)_8rem_minmax(10rem,1fr)_8rem] items-center gap-3 px-4 py-3 text-left text-sm transition hover:bg-muted/30",
                    selected && "bg-primary/5 ring-1 ring-primary/30 ring-inset",
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                        Open
                      </span>
                      <span className="truncate font-semibold">{issue.identifier}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {issue.stepName ?? "No active step"}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{issue.statusLabel}</span>
                  <span className="min-w-0 text-xs text-muted-foreground">
                    <span className="block truncate">{issue.activity ?? "No recent activity"}</span>
                    {updatedText ? (
                      <time dateTime={issue.updatedAt ?? undefined} className="mt-0.5 block truncate text-[11px]">
                        {updatedText}
                      </time>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap justify-end gap-x-2 gap-y-0.5 text-right text-xs text-muted-foreground">
                    {signalTexts(issue).map((signal) => (
                      <span key={signal} className="whitespace-nowrap">
                        {signal}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
