---
status: accepted
---

# Build Ensemble around agent coordination

The host ownership and identity choices below are partially superseded by
[ADR-1003](1003-host-independent-core.md). BB remains the initial host of a
host-independent Ensemble core; the other product policies remain in force.

Ensemble is a BB plugin where agents organise work through instructions
and runtime tools. Agents decide how to plan, implement, review, and revise work;
Ensemble owns durable coordination and its recovery; BB provides agent execution. This
allows the process to adapt to each task, at the cost of a predetermined sequence
of steps.

## Product shape

Center the product on projects and tasks, with reusable agent profiles and
optional GitHub sync. Profiles supply instructions and execution settings;
project leads and task assignments have conversations for their work. Ensemble
does not require persistent bot identities, personal bot state or a bot management
surface. This keeps configuration reusable while work history belongs to its
project or task. Bots Sidebar informs conversation binding and navigation only;
its broader bot model is not part of Ensemble.

## Coordination

Ensemble attaches its project configuration to BB projects, each containing tasks,
optional linked Git repositories, agent profiles, instructions, and permissions. A project is
independent of any external tracker or GitHub Project. Project leads select work
and delegate to concurrent task owners, which coordinate each task's implementation
and review. Agents use operator-defined profiles and may create assignments within
BB's configured concurrency limits; they cannot create new profiles autonomously.

Enabled projects select work automatically from an explicitly Ready queue,
defined by explicit task readiness or the configured authoritative readiness rule. The operator admits tasks directly or through an explicitly configured source
rule; the lead may triage and propose readiness but cannot admit arbitrary work.
Each project chooses whether coding delivery ends at a reviewable PR or continues
through merge. Both choices are supported in the first operational release;
merging still requires the applicable permission and completion conditions.

Ready admission authorizes planning, implementation and delegation within the
task's scope. There is no mandatory per-task plan approval. Agents ask about
material ambiguity, scope expansion or actions outside their granted authority.
A reviewable-PR project retains responsibility after handback: CI failures and
review feedback wake the task owner, while merge remains an operator action.
The task waits for review and completes on merge or explicit acceptance/closure.
For through-merge projects, the owner follows project-specific instructions and
GitHub's actual merge requirements. Ensemble checks merge authority and records
evidence; it does not impose universal reviewer counts or a review process schema.

Each task belongs to one project, whose instructions and permissions govern its
work. Ensemble stores assignments, handoffs, pending work, and human interactions
durably. Local tasks are built in and support quick one-offs without an external
integration. Use SQLite for initial task and coordination storage.

A project may configure multiple external task sources through plugins. Store a
local representation of each external task with its stable external reference;
the provider remains authoritative for imported title, description, and status,
while Ensemble owns coordination. External edits, progress updates,
and results are written through the plugin. Deduplicate an item discovered through
several sources within a project, retaining its source memberships. Overlapping
projects must not create competing execution owners or combine permissions.

Provide a GitHub task-source integration supporting repository issues from linked
repositories and issues selected through GitHub Projects. Initially exclude pull requests and
draft items from task discovery. Task discovery does not grant access to additional
repositories. Jira and Linear integrations are deferred. Relevant events wake
agents, with periodic reconciliation to catch missed changes.

GitHub discovery imports the selected backlog, with readiness evaluated separately
from source membership. The lead can inspect and triage unready issues without
admitting them. When project permissions allow, agents post substantive progress
and results and update configured labels or GitHub Project fields. Editing an
external issue's title or description requires separate operator approval; source
membership and workflow permissions do not grant that authority.

Each Ensemble project defines one explicit readiness rule for GitHub tasks,
using selected labels, a specified Project field, or an explicit combination.
Membership in another source cannot independently grant readiness. Agents cannot
change admission inputs to admit work themselves; their workflow-write authority
excludes granting readiness. Issue closure is a separate per-project permission:
close only after completion criteria are met and authority is checked. Observe
GitHub's PR-linked automatic closure without assuming it proves all task work is
complete; a completed agent turn alone never authorizes closing an issue.

When selections overlap across projects, the operator chooses placement. Preserve
existing ownership and work; do not dispatch newly conflicted unowned issues.
Transfers of already-owned tasks between projects are deferred beyond the first release.
Removing readiness, leaving all selections, or external closure holds new
delegation and asks the owner to reach a safe stopping point. Operator resolution
is required to resume, except closure confirmed as this task's own delivery.
Harmless clarifications can be incorporated; changes to the admitted outcome or
material scope expansion hold affected work for operator clarification.

Recovery resumes an agent conversation when supported, or reconstructs context
from the assignment, handoff records, and current workspace. External effects
must be reconciled before work continues. A shared dashboard is the primary
surface for supervision, questions, approvals, pause/resume, and run history.

## Operating policy

New projects start paused and require explicit enablement. Project pause allows
current turns to finish but holds new turns and follow-ups, retaining incoming
results and observations. Task stop requests termination of the owner and all
active delegated assignments and holds queued work until explicit resume. It
preserves files and history; termination is shown only after confirmation.

Use one task worktree shared across assignments, with one writer at a time.
Multi-repository tasks require a worktree for each participating repository;
parallel reviews refer to a fixed revision. Use BB's existing cleanup lifecycle,
configurable per project: retain conversations until operator archival (default),
or archive after confirmed delivery and preservation checks. Direct BB archival
can cause workspace removal; Ensemble does not supply an independent retention
engine.

Honor BB's Concurrency limit plugin without adding an Ensemble global default or
per-project cap. Waiting owners yield so their workers can run. Retry confirmed
transient execution failures at most twice with backoff, then hold for attention;
reconcile uncertain effects before retrying. Flag inactivity for attention without
automatically terminating or restarting an agent based on silence.

Existing assignments keep their recorded instructions and profile revision.
New assignments use current configuration; the operator explicitly applies
changes to existing assignments for their next turn. Permission revocations
still apply to subsequent Ensemble actions.

## Implementation and access

Implement Ensemble as its own TypeScript BB plugin on Node.js. BB supplies
agent providers, conversations, workspaces, transcripts, and the plugin host.
Ensemble owns local tasks, external source memberships, assignments, handoffs,
and project coordination settings in its plugin-owned SQLite database. Use BB
project identities; verify repository-free and multi-repository behaviour before
claiming those product scenarios work.

An agent profile is reusable configuration. Each independently executing assignment
normally gets one BB thread, reused for follow-ups. A replacement conversation
retains the assignment identity. Project leads have project-level conversations;
a task owner may do work itself or delegate according to instructions. A thread
is not itself an assignment, a task, or a worktree.

Use Taskboard as inspiration for project-scoped boards, task details, and task
context beside conversations. Build Ensemble independently rather than forking
Taskboard. Keep local tasks and multiple external sources in Ensemble's model.
Prefer BB's public SDK and extension points over importing its internal packages.
This saves execution and UI infrastructure, while accepting dependency on BB's
plugin contracts and lifecycle. Some relevant hooks remain experimental.

The first implementation is a bounded local-task delegation experiment. Record
launch intent before calling BB, tag worker threads with assignment identity,
and reconcile uncertain launches before any retry. An absent search result does
not prove a timed-out launch cannot complete. BB metadata is mutable and is not
an authorization boundary. BB's dispatch override is not a security gate. Ensemble relies on BB/provider
execution controls and documents their limits.

The initial product targets a trusted, single-operator BB installation. Ensemble
authorizes its own coordination and integration actions using project policy;
agent execution uses BB/provider permissions and environment controls. Ensemble
does not promise an independent sandbox against shell, ambient credentials, or
direct BB API access. Display effective settings and their limits, and never
present an instruction as enforced isolation. Improving execution isolation is a
BB/deployment concern rather than a prerequisite for a new Ensemble security layer.
The initial deployment is one BB host; additional hosts are deferred.

## Fresh implementation

Build from a minimal scaffold in the existing repository, retaining Git history
and the Apache-2.0 license. Pipeline assumptions span the previous execution,
recovery, approvals, and publication code; an incremental replacement would carry
those assumptions forward or require maintaining two execution models. The
previous implementation is preserved on `cb/pipeline-implementation` at `272adb7`;
new work is on `cb/agent-coordination`. Reuse code only when concrete needs justify it.

Existing configuration and persisted runs have no compatibility requirement.
Finish or explicitly retire existing runs before operational cutover. Select
Node.js and tooling versions, persistence schemas, plugin packaging and protocols,
and credential handling during implementation design, without recreating a configured process graph.

This is the accepted target architecture. See the README and
[BB prototype](../bb-prototype.md) for implemented scope and validation limits.
