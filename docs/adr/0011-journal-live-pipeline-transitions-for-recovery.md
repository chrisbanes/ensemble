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

Waiting-interaction recovery composes with that ordering: the journaled blocked or approval step is
restored before the interaction store hydrates its waiting owner, and explicit resume validates
both durable records before continuing once. Manual retry uses the journal's per-issue transition
reservation, retires the superseded interaction before appending retry or release ownership, and
never holds the global orchestrator state lock over durable I/O. Confirmed absence restores the
prior durable interaction before the exact prior in-memory owner; a failed restoration or
ambiguous append retains the new in-memory owner until journal recovery can reconcile whether the
transition became visible.

Worker dispatch uses the same reconciliation rule for `StepRunning`: an exact record visible after
a late append error is authoritative, confirmed absence rolls back without launching work, and an
unreadable result retains the speculative running owner without launching a worker. Ordinary
confirmed-absent dispatch schedules recovery when no sibling worker can continue the pipeline.
Interaction continuation retires its sidecar after `StepRunning` is durable and before worker
launch; startup retires a stale awaiting sidecar if it observes a crash in that narrow interval.
If the sidecar is durable but its bound waiting snapshot is not, startup instead reconstructs and
persists the blocked or approval checkpoint before exposing the wait.
An awaiting sidecar from an older pipeline cycle is retired in favor of the newer live journal
owner, while a same-cycle parallel-step record remains compatible when its snapshot still binds
the interaction.
