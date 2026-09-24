---
status: proposed
---

# Let agent instructions direct the work process

The selected direction is to replace configured step pipelines with agents that
organise planning, implementation, and review through instructions and runtime
tools. This lets agents adapt the work to each issue without requiring operators
to encode every path as a graph, at the cost of giving up a predetermined sequence
of steps. Ensemble retains support for multiple tracker kinds, preserving the
tracker-independent direction of ADR-0003.

Each board is a configured work queue from one tracker and has a lead that selects
work and delegates to issue owners. Each issue owner coordinates its
implementation and review, allowing multiple issues to
progress concurrently. Persistent board permissions define which actions agents
may take autonomously; Ensemble enforces those limits, and actions outside the
granted permissions require explicit approval.

Permission enforcement must cover agents' actual access, including direct tool
and shell use. Protected actions therefore require controlled access rather than
relying solely on agents following instructions; the precise enforcement mechanism
remains to be designed.

Plugins provide integrations with trackers, agent runtimes, and tools. Ensemble
retains a single durable coordination model for assignments, handoffs, and pending
work, and posts useful progress, decisions, and results back to the tracker. Agent
session history supplies context but is not the sole record of outstanding work.

An issue has one owning board at a time across Ensemble, even if several boards
select it. That board's instructions and permissions govern active work; other
boards may display the issue without starting duplicate execution. Relevant events
wake board leads and issue owners, with periodic reconciliation to catch missed
changes. A shared Ensemble dashboard is the primary surface for supervision,
questions, approvals, pause/resume, and run history across boards.

The initial deployment places the service and agents on one dedicated always-on
host. Recovery resumes the original conversation when supported, or reconstructs
context from the durable assignment, handoff records, and current workspace.
External effects must be reconciled before continuing; conversation continuity is
not a prerequisite for recovering the work. Agents delegate using operator-defined
profiles within enforced board and capacity limits; they do not create new profiles
autonomously.

## Consequences for existing decisions

This direction would supersede ADR-0005's configured DAG and strict step-output
model, and the pipeline composition mechanisms in ADR-0017, ADR-0018, and ADR-0019.
It preserves ADR-0003's tracker independence and ADR-0008's durable human
interactions, while replacing their dependence on pipeline execution where present.
ADR-0011's pipeline snapshots and ADR-0013's post-pipeline publication phase require
replacement designs that preserve recoverable work and authorised external effects.
Runtime integration plugins do not yet settle whether ACP remains their shared
execution protocol under ADR-0006.

Plugin packaging, persistence schemas, credential isolation, overlap resolution,
and migration of existing runs require a subsequent implementation design. These
details must support the selected coordination model without reintroducing a
configured process graph. A dedicated host alone does not enforce agent permissions.

This ADR records the proposed target architecture, not current implementation
behaviour. Acceptance awaits confirmation of the completed design interview.
