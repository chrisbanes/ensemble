import { useMemo, useState } from "react";
import { TranscriptEntryRenderer } from "./TranscriptEntryRenderer";
import type { GroupedTranscriptEntry } from "./transcript-model";

const INITIAL_VISIBLE_ENTRY_COUNT = 50;

interface RunTranscriptProps {
  entries: GroupedTranscriptEntry[];
  activeEntryId: string | null;
  onJumpToEntry: (entryId: string) => void;
}

export function RunTranscript({ entries, activeEntryId, onJumpToEntry }: RunTranscriptProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ENTRY_COUNT);
  const visibleEntryCount = Math.min(entries.length, visibleCount);
  const hiddenCount = entries.length - visibleEntryCount;
  const visibleEntries = useMemo(
    () => entries.slice(entries.length - visibleEntryCount),
    [entries, visibleEntryCount],
  );

  if (entries.length === 0) {
    return <div className="py-8 text-center text-muted-foreground">No transcript activity yet.</div>;
  }

  return (
    <div className="space-y-3">
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setVisibleCount((current) => Math.min(entries.length, current + INITIAL_VISIBLE_ENTRY_COUNT));
          }}
        >
          Load older activity
        </button>
      ) : null}
      {visibleEntries.map((entry) => (
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
