import { AgentMessageEntry } from "./entries/AgentMessageEntry";
import { AgentQuestionEntry } from "./entries/AgentQuestionEntry";
import { ErrorEntry } from "./entries/ErrorEntry";
import { HumanMessageEntry } from "./entries/HumanMessageEntry";
import { HumanReplyEntry } from "./entries/HumanReplyEntry";
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
    case "human_message":
      return <HumanMessageEntry entry={entry} isActive={isActive} />;
    case "agent_question":
      return <AgentQuestionEntry entry={entry} isActive={isActive} onJumpToEntry={onJumpToEntry} />;
    case "human_reply":
      return <HumanReplyEntry entry={entry} isActive={isActive} />;
    case "step_event":
    case "workflow_event":
    case "tool_activity":
      return <StepEventEntry entry={entry} isActive={isActive} />;
    case "verdict":
      return <VerdictEntry entry={entry} isActive={isActive} />;
    case "tool_activity_group":
      return <ToolActivityGroupEntry entry={entry} isActive={isActive} />;
    case "error":
      return <ErrorEntry entry={entry} isActive={isActive} />;
  }
}
