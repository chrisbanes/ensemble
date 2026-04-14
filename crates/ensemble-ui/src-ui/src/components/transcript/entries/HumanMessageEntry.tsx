import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface HumanMessageEntryProps {
  entry: Extract<TranscriptEntry, { kind: "human_message" }>;
  isActive: boolean;
}

export function HumanMessageEntry({ entry, isActive }: HumanMessageEntryProps) {
  return (
    <Card className={cn("border-emerald-300/60 bg-emerald-50/40 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-emerald-700">Human message</div>
      <div className="mt-1 text-sm whitespace-pre-wrap">{entry.message}</div>
    </Card>
  );
}
