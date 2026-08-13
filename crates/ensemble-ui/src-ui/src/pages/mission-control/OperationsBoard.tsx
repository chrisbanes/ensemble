import { cn } from "@/lib/utils";

import { formatTokenCount, formatUpdatedAt } from "./format";
import type { MissionGroup, MissionIssueSummary } from "./model";

interface OperationsBoardProps {
  groups: MissionGroup[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

function signalText(issue: MissionIssueSummary): string {
  if (issue.retryAttempt != null) return `retry ${issue.retryAttempt}`;
  if (issue.turnCount != null) return `${issue.turnCount} turns`;
  if (issue.completedAt) return "complete";
  return "active";
}

function tokenText(issue: MissionIssueSummary): string | null {
  if (issue.tokenTotal == null) return null;
  return formatTokenCount(issue.tokenTotal);
}

function IssueTile({
  issue,
  selected,
  onSelect,
}: {
  issue: MissionIssueSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const updatedText = formatUpdatedAt(issue.updatedAt);
  const inspect = issue.capabilities.inspect;
  const disabled = !inspect.enabled;
  const disabledReason = inspect.disabled_reason ?? "Inspection is unavailable; refresh and try again.";

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      disabled={disabled}
      aria-label={disabled ? `${issue.identifier}: ${disabledReason}` : undefined}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "w-full rounded-lg border bg-background p-3 text-left shadow-sm transition hover:border-primary/50 hover:bg-muted/30",
        issue.attention && "border-amber-400/70 bg-amber-50/50 dark:bg-amber-950/15",
        selected && "border-primary bg-primary/5 ring-1 ring-primary/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Open
            </span>
            <span className="truncate text-sm font-semibold">{issue.identifier}</span>
          </div>
          <div className="mt-1 truncate text-xs font-medium text-muted-foreground">
            {issue.stepName ?? issue.statusLabel}
          </div>
        </div>
        {issue.attention ? (
          <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase">
            Attention
          </span>
        ) : null}
      </div>

      <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {issue.activity ?? "No recent activity"}
      </div>

      {updatedText ? (
        <time dateTime={issue.updatedAt ?? undefined} className="mt-1 block text-[11px] text-muted-foreground">
          {updatedText}
        </time>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-0.5">{issue.statusLabel}</span>
        <span className="rounded-full bg-muted px-2 py-0.5">{signalText(issue)}</span>
        {tokenText(issue) ? <span className="rounded-full bg-muted px-2 py-0.5">{tokenText(issue)}</span> : null}
      </div>
    </button>
  );
}

export function OperationsBoard({ groups, selectedIssueIdentifier, onSelectIssue }: OperationsBoardProps) {
  return (
    <div className="flex min-h-[28rem] gap-3 overflow-x-auto pb-2">
      {groups.map((group) => (
        <section key={group.id} className="flex w-72 shrink-0 flex-col rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <h2 className="truncate text-sm font-semibold">{group.title}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {group.issues.length}
            </span>
          </div>
          <div className="flex-1 space-y-2 p-3">
            {group.issues.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No issues
              </div>
            ) : (
              group.issues.map((issue) => (
                <IssueTile
                  key={`${group.id}:${issue.id}`}
                  issue={issue}
                  selected={selectedIssueIdentifier === issue.identifier}
                  onSelect={() => onSelectIssue(issue.identifier)}
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
