---
status: accepted
---

# Journal live pipeline transitions for recovery

Every recoverable pipeline transition appends a versioned per-issue record containing the resolved
pipeline snapshot under the configuration state directory. This journal is separate from completed
history because its purpose is to rehydrate halted, interacting, approving, or retrying runs after
restart and to mark released runs as no longer live.

When a live record restores its stable run ID, the orchestrator reads that run's greatest persisted
timeline sequence from the shared SQLite history store and seeds the in-memory counter before the
run becomes dispatchable. A maximum-sequence read failure fails that restore attempt instead of
allowing a colliding sequence to be published. A candidate whose live journal cannot be restored
because its durable timeline sequence is unavailable remains undispatched rather than falling back
to a fresh run that could repeat completed work.
