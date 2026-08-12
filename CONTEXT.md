# Ensemble

Ensemble orchestrates issue-driven, multi-agent software delivery while keeping runtime authority separate from trackers and agent sessions.

## Language

**Issue**:
A tracker-sourced unit of work normalized into Ensemble's tracker-independent model.
_Avoid_: Ticket or task when referring to the normalized runtime model

**Tracker**:
An external source and projection surface for issues; it does not own Ensemble's runtime state.
_Avoid_: Board, runtime

**Pipeline**:
The configured directed graph that defines which steps run and how their results control delivery.
_Avoid_: Workflow when referring to the executable graph

**Scheduler lane**:
A named, configuration-defined live-worker capacity bucket shared by runs selected into that lane.
_Avoid_: Tracker state, workflow role

**Step**:
A named unit of agent or synthesis work within a pipeline.
_Avoid_: Stage, phase

**Run**:
One issue's execution through a resolved pipeline.
_Avoid_: Session when referring to issue-level execution

**Attempt**:
One execution of a step within a run; retrying creates another attempt without creating another issue.
_Avoid_: Run, session

**Step output**:
The structured result by which a step reports success, failure, concern, summary, and downstream data.
_Avoid_: Verdict

**Artifact snapshot**:
An immutable identity for material exposed by one step to downstream evaluation, ensuring sibling evaluators assess the same subject.
_Avoid_: Current workspace, live files

**Assessment**:
A structured judgment about whether an artifact snapshot satisfies declared criteria, distinct from whether the evaluating step completed successfully.
_Avoid_: Step result, execution result

**Interaction request**:
A durable question, approval, or handoff that blocks a run until a human resolves it.
_Avoid_: Prompt, comment

**Operator-attention item**:
A durable, non-authoritative report from a producer that fresh evidence says a subject needs an operator.
_Avoid_: Interaction request, action, command

**Finalization**:
The recoverable post-pipeline phase that performs configured repository publication, if any, before an issue is considered complete.
_Avoid_: Completion, cleanup

**Delivery**:
The durable owner of configured repository publication after pipeline work and approval are complete. It preserves exact local and remote identity until publication is confirmed, waiting on a pull request, or blocked for operator recovery.
_Avoid_: Worker, tracker state

**Claim**:
Adapter-issued remote ownership evidence for one issue. It may supply an opaque workspace branch
identity, but the orchestrator records it durably and remains the lifecycle authority.
_Avoid_: Assignment, scheduler policy

**Ownership conflict**:
Bounded adapter evidence that an owner is foreign or ambiguous. It blocks admission or recovery
without creating a competing run, workspace, or pull request.
_Avoid_: Workflow branch, implicit adoption

**Workspace**:
The issue-owned filesystem area in which repository worktrees and run artifacts persist across steps and retries.
_Avoid_: Checkout, repository
