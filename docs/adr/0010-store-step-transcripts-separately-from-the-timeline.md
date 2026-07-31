---
status: accepted
---

# Store step transcripts separately from the timeline

Detailed per-step conversation records are append-only JSONL streams distinct from the compact run
timeline. Transcript persistence runs behind a bounded asynchronous channel with message
coalescing and tool-result truncation because conversational detail has different volume and
debugging needs and must not block the orchestrator hot path.

Each persistence worker lazily initializes a `(run_id, step_name)` stream from the greatest
sequence in its durable file. Transcript reads scan bytes so a malformed JSON or UTF-8 final record
does not hide the valid prefix. Before the next append, that malformed tail is truncated, while a
valid final record without a newline is normalized to a JSONL boundary. Corruption before a later
record remains an error and leaves the file unchanged. Readers take snapshots under a shared
advisory file lock; append and repair operations hold an exclusive lock so an in-progress append
cannot be classified as a malformed durable tail.
