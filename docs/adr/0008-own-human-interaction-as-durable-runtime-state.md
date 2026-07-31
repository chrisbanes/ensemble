---
status: accepted
---

# Own human interaction as durable runtime state

Questions, approvals, and handoffs are durable `InteractionRequest` records owned by Ensemble rather than ad hoc tracker comments or long-lived agent sessions. Trackers may mirror and transport commands, but resolution is committed by the orchestrator and resumes the blocked step, keeping human gates tracker-independent and recoverable.

After restart, the orchestrator restores the journaled pipeline before hydrating its durable
interaction owner. Resolved waits are refreshed by stable issue ID and may resume from configured
non-terminal step or approval tracker states even when those states are intentionally excluded
from normal candidate dispatch. A continuation persists `StepRunning`, clears `awaiting_resume`,
and only then starts its worker;
refresh, validation, quiescing, workspace, or first confirmed-absent dispatch failures retain the
claim, waiting entry, pipeline snapshot, queued request, and durable marker. A resumed worker starts
only after its `StepRunning` journal snapshot is durable; confirmed absence restores the exact
blocked step and starts no worker. After approval fan-out transfers ownership to one continuation,
a later sibling dispatch failure cannot resurrect the superseded interaction owner. Startup
reconciles a crash between `StepRunning` persistence and interaction retirement before hydrating
waiting owners. In the opposite crash interval, where the awaiting sidecar is durable but its bound
blocked or approval checkpoint is not, startup reconstructs and persists that checkpoint before
exposing the waiting owner.

Manual retry retires the exact superseded interaction inside the orchestrator-owned per-issue
transition. An open request becomes cancelled and a resolved request keeps its response while
clearing `awaiting_resume`, before retry or release ownership changes. Durable failure preserves or
restores one recoverable owner rather than splitting lifecycle authority with API controls. When a
later journal append is confirmed absent, the durable interaction is restored before the exact
prior in-memory waiting owner; a failed durable restoration leaves the new owner intact.
