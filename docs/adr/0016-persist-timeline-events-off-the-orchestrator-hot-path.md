---
status: accepted
---

# Persist timeline events off the orchestrator hot path

Pipeline events publish to the in-memory event bus before compact timeline records enter a bounded
non-blocking FIFO. Its background consumer appends accepted records to the shared SQLite
`HistoryStore`; SQLite work never runs on the orchestrator hot path. A full or closed queue drops
events with a warning, and a database write failure is logged without affecting live delivery.
Orderly shutdown flushes accepted records, trading guaranteed persistence under overload for
orchestrator progress and ordered best-effort diagnostics.

For a live run rehydrated from the pipeline journal, the orchestrator seeds the in-memory sequence
counter from that run's SQLite maximum before new events can enter the queue. Brand-new runs retain
their in-memory counter initialization. This recovery does not add SQLite work to the event
publication hot path.
