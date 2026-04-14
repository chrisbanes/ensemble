import { AgentMessageEntry } from "./entries/AgentMessageEntry";
import { AgentQuestionEntry } from "./entries/AgentQuestionEntry";
import { StepEventEntry } from "./entries/StepEventEntry";
import { ToolActivityGroupEntry } from "./entries/ToolActivityGroupEntry";
import { VerdictEntry } from "./entries/VerdictEntry";
import type { GroupedTranscriptEntry } from "./transcript-model";

interface TranscriptEntryRendererProps {
  entry: GroupedTranscriptEntry;
  isActive: boolean;
  onJumpToEntry: (entryId: string) => void;
}

export function TranscriptEntryRenderer({
  entry,
  isActive,
  onJumpToEntry,
}: TranscriptEntryRendererProps) {
  switch (entry.kind) {
    case "agent_message":
      return <AgentMessageEntry entry={entry} isActive={isActive} />;
    case "agent_question":
      return <AgentQuestionEntry entry={entry} isActive={isActive} onJumpToEntry={onJumpToEntry} />;
    case "step_event":
    case "tool_activity":
      return <StepEventEntry entry={entry} isActive={isActive} />;
    case "verdict":
      return <VerdictEntry entry={entry} isActive={isActive} />;
    case "tool_activity_group":
      return <ToolActivityGroupEntry entry={entry} isActive={isActive} />;
  }
}
