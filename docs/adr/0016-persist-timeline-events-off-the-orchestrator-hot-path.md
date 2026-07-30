---
status: accepted
---

# Persist timeline events off the orchestrator hot path

Pipeline events publish to the in-memory event bus before compact timeline records enter a bounded non-blocking FIFO consumed by a background JSONL writer. A full or closed queue drops events with a warning, while orderly shutdown flushes accepted records, trading guaranteed persistence under overload for orchestrator progress and ordered best-effort diagnostics.
