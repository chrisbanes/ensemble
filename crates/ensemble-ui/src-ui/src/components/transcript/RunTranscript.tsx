import { TranscriptEntryRenderer } from "./TranscriptEntryRenderer";
import type { GroupedTranscriptEntry } from "./transcript-model";

interface RunTranscriptProps {
  entries: GroupedTranscriptEntry[];
  activeEntryId: string | null;
  onJumpToEntry: (entryId: string) => void;
}

export function RunTranscript({ entries, activeEntryId, onJumpToEntry }: RunTranscriptProps) {
  if (entries.length === 0) {
    return <div className="py-8 text-center text-muted-foreground">No transcript activity yet.</div>;
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <TranscriptEntryRenderer
          key={entry.id}
          entry={entry}
          isActive={entry.id === activeEntryId}
          onJumpToEntry={onJumpToEntry}
        />
      ))}
    </div>
  );
}
