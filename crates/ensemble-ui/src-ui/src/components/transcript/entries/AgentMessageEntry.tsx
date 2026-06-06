import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "../transcript-model";

interface AgentMessageEntryProps {
  entry: Extract<TranscriptEntry, { kind: "agent_message" }>;
  isActive: boolean;
}

export function AgentMessageEntry({ entry, isActive }: AgentMessageEntryProps) {
  return (
    <Card className={cn("border-sky-300/60 bg-sky-50/40 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-sky-700">Agent message</div>
      <div className="mt-1 text-sm whitespace-pre-wrap">{entry.message.content}</div>
    </Card>
  );
}
