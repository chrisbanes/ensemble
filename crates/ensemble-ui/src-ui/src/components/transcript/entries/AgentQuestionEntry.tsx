import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface AgentQuestionEntryProps {
  entry: Extract<TranscriptEntry, { kind: "agent_question" }>;
  isActive: boolean;
  onJumpToEntry: (entryId: string) => void;
}

export function AgentQuestionEntry({
  entry,
  isActive,
  onJumpToEntry,
}: AgentQuestionEntryProps) {
  return (
    <Card className={cn("border-blue-300/60 bg-blue-50/50 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-blue-700">Agent question</div>
      <div className="mt-1 text-sm font-semibold">{entry.interaction.question}</div>
      {entry.interaction.why_blocked && (
        <p className="mt-2 text-sm text-muted-foreground">{entry.interaction.why_blocked}</p>
      )}
      {entry.interaction.suggested_answer && (
        <p className="mt-2 text-sm">Suggested: {entry.interaction.suggested_answer}</p>
      )}
      <button
        type="button"
        className="mt-3 text-xs text-primary hover:underline"
        onClick={() => onJumpToEntry(entry.id)}
      >
        Jump to this item
      </button>
    </Card>
  );
}
