---
status: accepted
---

# Own human interaction as durable runtime state

Questions, approvals, and handoffs are durable `InteractionRequest` records owned by Ensemble rather than ad hoc tracker comments or long-lived agent sessions. Trackers may mirror and transport commands, but resolution is committed by the orchestrator and resumes the blocked step, keeping human gates tracker-independent and recoverable.
