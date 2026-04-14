import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface StepEventEntryProps {
  entry: Extract<TranscriptEntry, { kind: "step_event" | "tool_activity" }>;
  isActive: boolean;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function StepEventEntry({ entry, isActive }: StepEventEntryProps) {
  const label = entry.kind === "tool_activity" ? "Tool activity" : "Step event";

  return (
    <Card className={cn("border-slate-300/60 bg-slate-50/40 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-slate-700">{label}</div>
      <div className="mt-1 text-sm font-medium">{entry.event.type}</div>
      <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">{entry.event.detail}</p>
      <div className="mt-2 text-xs text-muted-foreground">
        {entry.event.stepName ? `Step: ${entry.event.stepName} • ` : null}
        {formatTime(entry.event.timestamp)}
      </div>
    </Card>
  );
}
