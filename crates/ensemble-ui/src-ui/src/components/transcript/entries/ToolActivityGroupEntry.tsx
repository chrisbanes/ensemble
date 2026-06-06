import { useState } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { GroupedTranscriptEntry } from "../transcript-model";

interface ToolActivityGroupEntryProps {
  entry: Extract<GroupedTranscriptEntry, { kind: "tool_activity_group" }>;
  isActive: boolean;
}

export function ToolActivityGroupEntry({ entry, isActive }: ToolActivityGroupEntryProps) {
  const [expanded, setExpanded] = useState<boolean>(entry.defaultExpanded);

  return (
    <Card
      className={cn("border-dashed border-slate-300 bg-slate-100/40 p-4", isActive && "ring-2 ring-primary")}
      data-active={isActive ? "true" : "false"}
    >
      <div className="text-xs font-medium uppercase text-slate-700">Tool activity</div>
      <p className="mt-1 text-sm">{entry.count} low-level activities</p>
      <button
        type="button"
        className="mt-2 text-xs text-primary hover:underline"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>
      {expanded && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {entry.entries.map((toolEntry) => (
            <li key={toolEntry.id} className="font-mono whitespace-pre-wrap">
              {toolEntry.event.detail}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
