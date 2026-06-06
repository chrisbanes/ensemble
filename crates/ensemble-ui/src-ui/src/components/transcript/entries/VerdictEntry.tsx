import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface VerdictEntryProps {
  entry: Extract<TranscriptEntry, { kind: "verdict" }>;
  isActive: boolean;
}

export function VerdictEntry({ entry, isActive }: VerdictEntryProps) {
  return (
    <Card className={cn("border-amber-300/70 bg-amber-50/50 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-amber-800">Verdict</div>
      <div className="mt-1 text-sm font-semibold">{entry.event.detail}</div>
    </Card>
  );
}
