import { cn } from "@/lib/utils";

import type { MissionAttentionItem } from "./model";

interface AttentionQueueProps {
  items: MissionAttentionItem[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

export function AttentionQueue({ items, selectedIssueIdentifier, onSelectIssue }: AttentionQueueProps) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Needs Attention
          </h2>
          <p className="text-sm text-muted-foreground">Reported operator interventions.</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{items.length}</span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Nothing needs intervention right now.
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const selected = selectedIssueIdentifier === item.issueIdentifier;
            const content = <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{item.issueIdentifier}</div>
                  <div className="mt-1 text-sm text-foreground">{item.title}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                  {item.kind}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="truncate">
                  {item.references.length} {item.references.length === 1 ? "reference" : "references"}
                </span>
                <span className="shrink-0">{formatAge(item.requestedAt)}</span>
              </div>
            </>;

            return item.canNavigate ? (
              <button
                key={item.id}
                type="button"
                aria-current={selected ? "true" : undefined}
                aria-label={`Open ${item.issueIdentifier}`}
                onClick={() => onSelectIssue(item.issueIdentifier)}
                className={cn(
                  "rounded-lg border p-3 text-left transition hover:border-primary/50 hover:bg-muted/40",
                  selected && "border-primary bg-primary/5 ring-1 ring-primary/30",
                )}
              >
                {content}
              </button>
            ) : (
              <div key={item.id} className="rounded-lg border border-dashed p-3 text-left">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
