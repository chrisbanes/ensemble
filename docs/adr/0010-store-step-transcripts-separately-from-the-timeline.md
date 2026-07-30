---
status: accepted
---

# Store step transcripts separately from the timeline

Detailed per-step conversation records are append-only JSONL streams distinct from the compact run timeline. Transcript persistence runs behind a bounded asynchronous channel with message coalescing and tool-result truncation because conversational detail has different volume and debugging needs and must not block the orchestrator hot path.
