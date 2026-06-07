import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface ErrorEntryProps {
  entry: Extract<TranscriptEntry, { kind: "error" }>;
  isActive: boolean;
}

export function ErrorEntry({ entry, isActive }: ErrorEntryProps) {
  return (
    <Card className={cn("border-red-300/70 bg-red-50/50 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-red-700">Error</div>
      <div className="mt-1 text-sm whitespace-pre-wrap text-red-900">{entry.message}</div>
    </Card>
  );
}
