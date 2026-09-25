# Ensemble behavioural specification

**Status: draft for review.** [ADR-1001](adr/1001-agent-coordination-architecture.md)
records the accepted architecture, including the project and task-source model.
This document elaborates its observable behaviour. Accepted product, GitHub and
operational decisions are recorded in the ADR and [decision register](delivery.md#decisions-before-publication);
remaining technical contracts and release evidence still require review. A bounded local-task prototype exists; see [prototype scope](bb-prototype.md).
The scenarios below remain target behaviour unless explicitly verified there.
Open product and implementation choices are listed at the end.

## Purpose and scope

An operator creates Ensemble projects, links optional Git repositories, configures
agent profiles and instructions, and grants permissions. Each project contains its
own tasks. Project leads select work from that task list; task owners organise its
delivery. Ensemble coordinates concurrent agents, human responses, interrupted
conversations, and service restarts.

The initial deployment is BB hosting Ensemble and its agent processes on one dedicated
always-on host. Multiple projects share it. TypeScript and Node.js are the chosen
implementation stack, with SQLite for initial task and coordination storage. The
Ensemble panel inside BB is the target primary operator interface.

Local tasks are built in. A GitHub task-source integration will provide external task discovery
from linked repository issues and GitHub Projects. Initial GitHub discovery imports
issues only, excluding PRs and draft items. Jira and Linear plugins are deferred.
BB supplies the agent runtime. The first experiment covers local tasks and one worker;
the proposed delivery milestones below extend that experiment into the product.

Planning, implementation, review, and verification are examples of work described
in instructions. They are not required assignment types or stages. Changing their
order, adding a specialist, or skipping an unnecessary review must not require a
new runtime feature, process graph, or result schema.

### Product model

| Part | Operator sees | Responsibility |
| --- | --- | --- |
| Projects and tasks | Project task list, task detail, results and attention inbox | Keep work, accountable ownership and decisions together |
| Agent profiles | Reusable instructions and provider/model settings in configuration | Configure project leads and assignment conversations |
| Optional GitHub sync | Sources, readiness, last successful sync and confirmed updates | Connect external work to the same task model |

Profiles are reusable configuration. Conversations belong to project leadership
or task assignments. There is no persistent bot identity, personal bot state or
separate bot management UI. Agent instructions decide the process; the task
records retain ownership, outcomes and pending work.

## Delivery scope and user journeys

**Release proposal; review required.** Feasibility is established; the current
plugin is an experiment, not the product's baseline architecture or acceptance
suite. Product implementation pauses until this specification, the
[technical design](design/bb-plugin.md), [acceptance plan](acceptance.md), and
[ticket breakdown](delivery.md) have been reviewed.

### Local-task milestone

An operator opens Ensemble inside BB, selects a BB project, configures a lead
profile and allowed worker profiles, and creates a task with an expected outcome.
Projects start paused. On enable, the lead selects explicitly Ready work
and assigns an owner. The owner does the work or delegates bounded assignments.
Results automatically wake the responsible owner; questions appear in the task
panel. The operator responds there, and execution continues. The accepted outcome,
artifacts, execution history and linked BB conversations are visible in task detail.

The user does not supply thread IDs or UUIDs, configure the plugin with CLI
commands, poll conversations for results, or manually nudge each stage. A restart
preserves ownership and pending work without duplicate dispatch. The complete flow
is tested automatically before handback, including the operator-facing UI.

### First local-task journey

Use a disposable linked repository and a local, non-code task requesting a
repository summary artifact for the first automated journey. No external task
source is configured. This
walkthrough joins the existing acceptance scenarios; it adds no mandatory work
stages. Separate scenarios prove repository-free work and other delivery modes.

| Step | Operator and agent experience | Tickets / evidence |
| --- | --- | --- |
| Configure | Select a BB project, its repository, a lead profile and allowed assignment profiles. Save instructions and permissions. Project remains paused. | T04 / A02, A25 |
| Add work | Create a local task describing the requested artifact. It starts unready; marking it Ready does not enable the project. | T05 / A03 |
| Enable | Enable the project. The lead selects Ready work and assigns one accountable owner using an allowed profile. Conversation links appear automatically. | T06, T08 / A04, A05 |
| Work | The owner works directly or delegates a bounded assignment according to instructions. In the delegation fixture, the owner yields the workspace before the worker writes. | T06 / A05, A16, A27 |
| Receive a result | A worker records its result and evidence. The owner receives it on an eligible next turn and decides what to do next. The operator sees both result and conversation links. | T07 / A06, A09, A10 |
| Resolve a question | In the question fixture, a structured request appears in the attention inbox and task detail. The operator answers; the correct assignment resumes within that answer's scope. | T09 / A12, A13 |
| Finish | The owner records the requested artifact and evidence once obligations are settled. Task detail retains outcome, assignment history and conversations. Default cleanup retains conversations until archival. | T10 / A17 and local completion assertions |

The result and question fixtures exercise alternative paths; every task need not
delegate or ask a question. Coding tasks that require PR delivery still follow
the configured PR/merge completion conditions. An artifact-only fixture does not
establish GitHub delivery readiness.

At each step the UI distinguishes waiting for capacity, waiting for an answer,
paused, stopping and uncertain execution. Pause/resume, task stop and restart are
variations on this journey, verified by the implementation agent in isolated BB.
They are not additional setup steps for the operator.

### First operational release

Add selected GitHub repository issues and GitHub Projects to the same task list,
with multiple source memberships and confirmed provider updates. Multiple projects
can make progress concurrently. Accepted completion boundary D1: each project chooses reviewable PR or through
merge from the first operational release. Both require verification evidence and
the configured completion conditions; through-merge additionally requires the
applicable permission. Other tasks end with the requested artifact or answer.
Task completion alone does not authorize merging.
For non-code tasks, the owner records the outcome and supporting evidence against
the request. No universal operator acceptance step is required; project
instructions and action permissions may require approval.

Ready authorizes work within the admitted scope, subject to task dependency and
execution controls; no universal plan-approval stage is required. Material
ambiguity, scope expansion and ungranted actions require
operator input. In reviewable-PR projects, handback puts the task into a waiting
state. Relevant CI failures and review feedback resume its owner. Merge remains
human-owned; completion follows merge or explicit acceptance/closure. Through-merge
projects may also perform the authorized merge once their conditions are met.
Those conditions come from project instructions and actual GitHub merge
requirements. Ensemble records evidence and checks authority without introducing
a universal review-count policy or process schema.

### Initial operator experience

- Project view: enabled/paused state, eligible and waiting work, capacity and source health.
- Task list: local/external origin, title, work status, owner and attention indicator.
- Task detail: description, provenance, assignments, accepted results, questions,
  history and links to conversations/artifacts.
- Configuration: profiles, instructions, repository access, sources and cleanup mode;
  show the effective BB execution controls.
- Controls: create/edit task, enable/pause project, respond to requests, stop/resume
  work, and resolve uncertain outcomes using explicit evidence.

Start with a list view. A Kanban view is optional after the core journey passes.
Use BB's UI slots and task-context patterns from Taskboard; build Ensemble's own
screens. Loading, empty, stale, failed and uncertain states must be distinguishable.
Task completion never follows merely from a green conversation indicator.

### Exclusions from these milestones

Persistent bot identities, personal bot state, a bot management UI, Jira/Linear,
autonomous creation of profiles, plugin marketplaces, a configurable
process DAG, multiple execution hosts, team/RBAC administration, mobile-specific
screens, transfers of already-owned tasks between projects, a separate workspace
cleanup engine, and migration of Rust pipeline
runs are excluded. Rich task UI extensions can follow the tested list/detail flow.
External-source plugin interfaces are extracted from working integrations rather
than designed as a general platform in advance.

### Decisions and release evidence

D1 is per-project completion choice (reviewable PR or through merge). D2 is
automatic selection from an explicitly Ready queue. The operator admits tasks directly or through an explicit source rule; the lead
may triage other work but cannot mark it Ready independently.
D3 uses BB/provider execution controls in a trusted single-operator installation;
Ensemble does not add an independent project security sandbox. D4 covers operational decisions O1–O11 in the delivery plan and their technical contracts.
These are tracked in the [ticket package](delivery.md#decisions-before-publication).
Accepted high-level direction does not imply acceptance of every proposed default.

Acceptance IDs A01–A30 in [the test plan](acceptance.md) are the traceable release
criteria. Feature tickets include automated verification against an isolated BB
instance. The implementation agent runs integration tests and the bounded live
smoke; the operator reviews a finished flow and evidence rather than acting as the
integration harness.

## Projects, tasks, and sources

An Ensemble project uses a BB project identity and is distinct from a GitHub Project.
BB provides repository and workspace configuration; Ensemble adds
profiles, instructions, permissions, cleanup policy, and tasks regardless of where tasks
originate. A project may have no linked repository and no external sources. Linking
a repository provides context; it does not automatically enable issue discovery
or grant every action against that repository.

A task belongs to exactly one Ensemble project. It has a durable local identity,
title, description, work status, and coordination history. It is either native to
Ensemble or a local representation of an external item with a stable external
reference. Agent execution and assignment state are recorded separately from the
task's work status.

Local creation is always available within the operator's project access.
New local tasks are unready by default. Provide an explicit Create and start
action that marks the task Ready; project enablement and execution controls still
apply, so this action does not bypass a paused project. A quick
one-off can be created, edited, delegated, and completed without an external
tracker or a plugin installation. Its content and status are authoritative in
Ensemble, and it survives restarts. SQLite stores both native tasks and the local
representations and coordination records of external tasks.

An external task source is a project-scoped configuration of a plugin's discovery
capability. A project can have multiple sources, each with an explicit selection:
repository issues may be filtered by labels or state, while a GitHub Project source
selects issues through that external project's membership and supported fields.
Source configuration is query-first, with validation and a preview of matching
issues. Initially support GitHub.com using native issue-search syntax for
repository sources and native Project-filter syntax for Project sources.
Enterprise Server support is deferred. Validate source scope and supported
queries without inventing a shared Ensemble query language. Sources supply
work; they do not own separate agents, permissions, or execution policies.

Accepted GitHub import scope: show the selected backlog, not only Ready issues.
Source selection controls visibility; the readiness rule controls admission.
Unready issues can be inspected and triaged without starting implementation.

Accepted GitHub writeback scope: within project permissions, agents post meaningful
progress/results and update configured labels or Project fields. Issue title/body
edits require separate operator approval. Exact workflow field mapping remains part of integration design.

Each Ensemble project defines one explicit readiness rule for GitHub tasks,
using selected labels, a specified Project field, or an explicit combination.
Expose a simple rule builder with all/any combinations of label and field-value
conditions; nested expressions are outside the initial scope.
Membership in another source cannot independently grant readiness. Agents cannot
change admission inputs to admit work themselves; their workflow-write authority
excludes granting readiness. Issue closure is a separate per-project permission:
close only after completion criteria are met and authority is checked. Observe
GitHub's PR-linked automatic closure without assuming it proves all task work is
complete; a completed agent turn alone never authorizes closing an issue.

For example, the Ensemble project **Haze** may link its Git repository and combine:

- A local task: investigate a rendering regression.
- Issues discovered from the linked GitHub repository.
- Issues selected from a configured GitHub Project.

The project lead sees one task list. Review assignments under a task need not
become additional tracker issues. A task's source does not change its delegation
or recovery mechanism.

## Task dependencies

The authority boundary is recorded in [ADR-1002](adr/1002-task-dependency-authority.md).

A task may be blocked by another task or external issue independently of source
membership and readiness. A Ready task with an unresolved dependency remains
visible for triage, but Ensemble cannot start an owner or another execution turn
for it. Clearing the last blocker automatically re-evaluates the task under
current readiness, pause, permission and capacity controls. Dependency state
and its source are visible in task detail and
the task list; they are not folded into the Ready state.

Ensemble owns dependencies whose dependent task is local. The operator may link
that task to another local or imported task in the same Ensemble project. Local
task completion (`Done`) resolves its blocker; cancellation does not. An obsolete
local edge must be removed rather than bypassed. Reject self-dependencies and
cycles when creating local edges.

For an imported GitHub issue, native GitHub issue dependencies are authoritative.
Ensemble observes them, including a blocking issue outside the selected source or
Ensemble project, without importing that issue as a task or granting repository
access. An open GitHub blocking issue holds work; closure or removal of its native
edge releases that blocker. Ensemble does not add a separate local edge to an
imported issue or provide a bypass while the GitHub edge remains. Change an
obsolete native edge in GitHub, then reconcile its confirmed state. BB's direct
manual Send-now override sits outside Ensemble-managed dispatch and must be
disclosed as an execution-control limitation, not offered as a dependency bypass.

If a dependency appears while work is active, the current turn may reach a safe
stop; hold new Ensemble turns and delegation, retain ownership and results, and
show the reason. A reopened blocker applies the same rule. If dependency or
blocker state cannot be read completely, hold affected dispatch, keep the last
confirmed view for explanation, and retry reconciliation. Neither stale clearance nor a lead's
judgment can substitute for a confirmed unblocked state.

## Data ownership and external writes

| Data | Authority |
| --- | --- |
| Project identities, repository links, conversations, and workspaces | BB. |
| Ensemble profiles, coordination instructions, and project policy | Ensemble; effective access must also be enforced by the execution environment. |
| Local task title, description, and work status | Ensemble. |
| External task title, description, and provider status | External provider; Ensemble retains a local representation. |
| Source-specific metadata, such as GitHub Project fields and membership | The corresponding external source; retain provenance. |
| Task dependencies | Ensemble for local dependent tasks; GitHub native issue relationships for imported GitHub dependent tasks. |
| Assignments, execution, handoffs, human requests, and action records | Ensemble. |

External content changes go through the plugin and use confirmed remote outcomes
to update the local representation. Failed or uncertain writes remain visible;
a locally edited field must not masquerade as a successful remote update.
Imported provider status and runtime execution state must remain distinguishable.
An agent's claim of completion does not prove that a PR was merged.

GitHub issue state and GitHub Project status fields are distinct provider data.
Their mapping into the task view must preserve source identity rather than letting
whichever source was fetched last overwrite a shared status. Exact field mapping,
conflict presentation, and provider capability handling remain integration choices.

Local task updates are durable local operations. They do not require a simulated
remote plugin, and creating a local task does not create a GitHub issue. Promoting
local tasks into external systems is outside the initial source scope.

## BB hosting boundary

BB provides conversations, providers, workspaces, transcripts, and plugin hosting.
Ensemble stores tasks, source memberships, assignments, results, and pending work.
Each assignment normally executes in one BB thread, reused for follow-ups; its
identity survives replacement conversations. Threads and worktrees have separate
lifecycles. Taskboard informs the UI design but is not a runtime dependency.

The plugin must reconcile the gap between its SQLite transaction and a BB API
request. Persist launch intent first, attach assignment metadata at creation, and
recover by inspecting BB. Never blindly retry an ambiguous creation. BB dispatch
hooks and provider permission modes alone do not establish project isolation.

## Who decides what

| Concern | Decision owner | Ensemble's responsibility |
| --- | --- | --- |
| Projects, repository links, sources, and available profiles | Operator | Validate configuration and expose selected work and capabilities. |
| Work selection and priority within a project | Project lead, following instructions | Enforce task membership, ownership, permissions, and capacity. |
| Delegation, review strategy, and handling findings | Task owner, following instructions | Persist assignments and deliver their results to the responsible agent. |
| Task updates and external comments | Agents, within project permissions | Persist native edits, authorise external writes, and reconcile their outcomes. |
| Runtime state and recovery | Ensemble | Track actual processes, pending work, requests, and external effects. |
| Permission grants and exceptions | Operator | Enforce the current grant and record scoped approval decisions. |

## Configuring and operating a project

A project's configuration identifies:

- Its optional linked repositories and explicit repository access.
- Its external task sources; local tasks are built in.
- Its lead profile, available agent profiles, and project instructions.
- Allowed actions and the resources to which those permissions apply.
- BB execution controls and the project’s workspace cleanup mode.

Reuse BB's existing GitHub integration and the GitHub CLI login available to the
BB server. Show the detected identity and missing access during setup; do not
add an Ensemble token store. Credentials are supplied separately from agent
instructions. The operator can
inspect selected tasks, source provenance, and effective permissions before
enabling dispatch. An unavailable BB/provider capability is visible and prevents launches that
require it. Display execution permissions separately from Ensemble action policy.

Profiles are shared across Ensemble projects; each project selects its allowed
profiles and supplies project-specific context through project instructions.
Profiles supply reusable instructions, model settings, and available tools. An
assignment chooses an available profile but cannot expand its access beyond the
project's grants. Agents can create assignments; creating or changing profiles is
an operator action.

Existing assignments retain their recorded profile and instruction revision.
Configuration edits apply to new assignments; the operator may explicitly apply
updates to an existing assignment for its next turn. Permission revocations still
apply to subsequent Ensemble actions; instruction snapshots do not preserve
revoked authority.

**Accepted activation and pause semantics:** new projects start paused and require
explicit operator enablement. Pausing a project stops new agent turns, including
queued continuations, while allowing currently active turns to finish.
Observations, results, and operator responses are retained during the pause.
Stopping a task is a separate action: request termination of its owner and all
active delegated assignments, hold queued work, and require explicit operator
resume. Stop does not cancel or complete the task. Workspaces and records survive;
a process is shown as stopped only when termination is confirmed.
Resume revalidates pending work and permissions before dispatch.

Pausing one project does not pause others. Honor BB's Concurrency limit plugin;
the first release adds no separate global default or per-project execution cap.
Agents waiting for human input or another assignment yield their active turn so
BB can admit other work. Retain Ensemble ownership and task writer checks.
Confirmed transient execution failures receive at most two retries with backoff,
then hold the failed assignment and notify its owner. The owner diagnoses and
may perform the work or choose a revised approach within scope; blind relaunches
must not reset the retry allowance. Reconcile uncertain launches/effects before retrying;
ordinary task problems remain agent-directed.

## Task identity, discovery, and ownership

Local creation, external changes, and reconciliation observations make tasks
available to the project lead. The lead can inspect current tasks and existing
work, explain its selection, and delegate a task to an owner. Selecting a task is
a request to Ensemble; permission and ownership checks still apply.

Within a project, external discovery is deduplicated by the item's stable identity
in its source system, including the provider instance. Identity is independent of
source configuration, credentials, query, and board position. Discovering one
GitHub issue through both repository issues and a GitHub Project creates one task
with both source memberships. Removing one membership does not remove the other.

If sources in different Ensemble projects select the same external item, they must
not create competing execution owners or combine permissions. The conflict must be
visible and the operator chooses the owning project. Retain any existing owner
and its work; a newly conflicted, unowned issue cannot dispatch before placement
is resolved. Transfers of already-owned tasks between projects are deferred beyond the first release. Each task still belongs to one project and has at most one
accountable task owner at a time.

Source discovery cannot add repository access. An issue found through a GitHub
Project may refer to a repository the Ensemble project is not allowed to modify;
that observation cannot authorise repository-changing execution.

External changes are observations, not implicit permission grants. Losing source
membership does not delete task history or release active execution ownership.
If an external task leaves all selections, loses readiness, or is closed while
work is active, hold new delegation, retain records and ownership, and notify the
owner to reach a safe stopping point. Resuming requires operator resolution,
except when closure is confirmed as the result of this task's own delivery;
that closure is reconciled against the completion criteria.

Incorporate harmless external clarifications. If an edit changes the admitted
outcome or materially expands scope, hold affected work and ask the operator
before proceeding with the changed scope.

## Delegation and handoffs

The project lead gives a task owner a durable assignment containing the task,
requested outcome, relevant context, selected profile, and permission scope. The
task owner may delegate bounded work to other configured profiles and later
continue with their results. One task can have concurrent assignments while
retaining one accountable owner.

Follow-up on the same piece of work reopens its assignment with a new request
and result revision, retaining prior results and reusing the conversation when
available. Results from earlier work revisions cannot complete the new revision.

If a confirmed completed turn records neither a result nor a waiting reason,
Ensemble sends one reporting prompt. If that repair turn still fails to report,
hold for attention. Persist the allowance across restart and respect execution
controls; do not treat an idle conversation as successful work.

Each assignment needs enough durable information to answer:

- Who requested this work, who is responsible, and which project and task own it?
- What outcome was requested, with which instructions and context?
- What workspace and material is the agent acting on?
- Has execution started, is it waiting, or has an outcome been recorded?
- What result, question, or interruption needs to reach the requesting agent?

These are information requirements, not a database schema or a configured graph.
Assignments and results are recorded through coordination tools. Free-form prose
in a transcript does not silently schedule work or change ownership. The process
exit status describes execution, while the recorded result describes the work;
one cannot substitute for the other.

For example, an owner may ask a reviewer to inspect a particular commit. The
reviewer returns findings referring to that commit, and the owner decides whether
to revise, seek another opinion, or ask the operator. Ensemble preserves the
request and material references. It does not impose a review verdict taxonomy,
adjudication stage, or universal review requirement.

Results arriving while their owner is active are queued for its next turn rather
than automatically steering the current conversation. The owner may check its
inbox voluntarily. Multiple pending events cause one continuation, with individual
results and acknowledgements retained.

A result that arrives while its recipient is stopped or the project is paused stays
available. Repeated delivery of the same result must not create duplicate pending
continuations. A result from superseded work remains in history and must not
overwrite the outcome of newer work.

Prolonged inactivity is flagged for operator attention. Silence alone does not
trigger automatic termination or restart.

## Workspace and execution

Repository-changing work uses an isolated task workspace within the project's
explicit repository access. A local task can produce a PR without first becoming
an external issue; a task needing no repository does not require a Git worktree.
Task workspaces retain their identity and work across agent conversation changes
and service restarts. Agents receive explicit
working directories, context, and available capabilities. Concurrent assignments
share one task worktree with one writer at a time. Parallel reviews use a fixed
revision. Multi-repository work requires a worktree for each participating repository.

Execution admission respects BB's configured concurrency controls. Waiting on another
assignment, a human, or external feedback must not require a permanently running
agent process. A fresh execution can reconstruct context when its runtime cannot
resume the earlier conversation.

The service records enough launch and process information to reconcile uncertain
execution after a crash. It must confirm that an earlier execution is stopped or
otherwise unable to mutate the workspace before starting a replacement writer.
If this cannot be established, the work is held with an actionable explanation.

Use BB workspace cleanup with a configurable project mode: retain conversations
until operator archival or archive after confirmed delivery and preservation
checks. Default to retain-until-archive. Ensemble-initiated cleanup must preserve
uncommitted work, pending handoffs and evidence needed for reconciliation. Direct
BB archival follows BB's lifecycle, which can remove dirty worktrees once no live
threads retain them; make that consequence visible.

## Permissions and operator requests

Project permissions grant actions on particular resources. A profile's tools,
delegated instructions, external task content, or another project's permissions
cannot expand that grant. Ensemble enforces checks on its own actions. Agent shell, credentials and runtime
access use BB/provider controls; these do not establish a separate Ensemble
security boundary. The product must disclose that limitation.

When an action needs approval, the operator sees the action, its target and scope,
the requester, and the relevant current material. An approval is durable and
bound to the reviewed action. A material change must not reuse stale approval.
Denial is also durable and reaches the requesting agent. Repeated submission of
the same request or response does not authorise duplicate effects.

Questions use the same durable delivery expectations without implicitly granting
permission. The agent receives the response after resume or recovery. Human waits
do not consume an execution slot and remain visible in the dashboard.

Permissions are checked when an action executes, including resumed and retried
actions. Broader permissions granted later do not automatically approve unrelated
pending requests. Changes affecting already-running processes require a defined
revocation mechanism before access enforcement can be claimed.

## Events, external actions, and recovery

GitHub sources use polling initially, with a manual Refresh action and visible
last-success time. Recheck relevant remote state before consequential actions;
a cached polling result alone does not establish current authority. Webhooks are
deferred; polling intervals and rate-limit handling remain technical design work.

Relevant events include local task creation, external task changes, assignment
results, operator responses, and delivery feedback. Integrations may receive events or
poll. Local task changes produce durable notifications directly; periodic
reconciliation also recovers pending local work and catches missed external
observations. Duplicate observations must not start duplicate work, and the system
must not depend on arrival order to
determine the current remote state.

External writes have three observable outcomes: confirmed success, confirmed
failure, and uncertainty. Before a protected write, retain enough intent and
identity to recognise its result. If a timeout or restart makes success uncertain,
inspect the external system before retrying. A matching PR or comment can resolve
the uncertainty; insufficient evidence holds that action for operator attention.
Ensemble does not promise exactly-once external execution through arbitrary APIs.

Recovery restores task ownership, assignments, human requests, workspaces, and
pending effects before new work can compete for them. It reconciles live processes
and remote effects where present, then resumes eligible work under current
permissions and limits. Previously enabled work resumes automatically after successful reconciliation,
while all existing pause/stop controls remain in force. Uncertainty holds the
operation and dependent work. Reconciliation and established independent work
may continue; uncertain writer status blocks further workspace writes. If
independence cannot be established, keep affected work held. Unrelated projects
continue.

Agent instructions determine when the requested work is complete. Recording an
assignment outcome does not automatically complete its task, close an external
issue, merge a PR, or delete its workspace. Those actions require their own authorisation and observed
outcomes; their ordering is driven by the agent's instructions and tools.

## Dashboard

Provide a shared attention inbox across projects for unresolved questions,
approvals, failures and placement conflicts. Each item links to its task and
available resolution actions; the same item is also visible in task detail.
Use BB's existing notification facilities where supported, linking to the
attention item and suppressing repeated alerts for unchanged items. Verify BB
notification capabilities before promising a particular delivery surface.
Inspected BB supports plugin in-app toasts and navigation, while its built-in
push delivery handles supported thread events. Arbitrary Ensemble alerts have
no verified public OS/push send API; the durable Ensemble inbox remains the
source of truth, not BB's transient notification history.

The initial dashboard must make these questions answerable:

- Which projects are enabled, paused, or unable to operate, and why?
- Which tasks are local or external, who owns them, and which assignments are running or waiting?
- What decisions or responses does the operator need to provide?
- What happened, what result was recorded, and which external artefacts exist?
- What can be paused, resumed, or stopped under the current state?

Task detail opens the owner's linked BB conversation for discussion. Structured
questions and approvals also appear in Ensemble; the initial release does not
require an embedded chat implementation.

Operators can inspect a task's coordination history and available transcripts,
answer requests, and control execution. Controls acknowledge persisted outcomes;
issuing a stop request must not immediately display a still-running process as
stopped. Credentials must not appear in dashboard payloads or transcripts exposed
by Ensemble. The initial deployment uses the trusted single-operator BB access
boundary; integration with its operator surface still requires verification.

## Acceptance scenarios

These are proposed observable checks for implementation, not a prescribed agent
method. They should become integration tests as the corresponding behaviour exists.

| Scenario | Expected evidence |
| --- | --- |
| A local task is created in a project with no external sources. | It persists across restart and can be delegated with the same assignment tools as external tasks. |
| Repository discovery and a GitHub Project source discover the same issue in one project. | One task and external reference exist with both source memberships; no duplicate task owner starts. |
| Sources in two projects discover the same external issue concurrently. | The cross-project conflict is visible and no competing execution owner starts; the operator selects placement, existing ownership is retained, and newly conflicted unowned work cannot dispatch. |
| A GitHub Project contains an issue from an unlinked repository. | Discovery does not grant access; repository-changing execution cannot proceed without explicit project access. |
| A GitHub Project contains a PR and a draft item. | Neither is imported as a task in the initial integration. |
| A Ready local task depends on another task in its project. | The dependent remains Ready and visible but cannot run until the blocker is Done or its local edge is removed. Cancellation does not clear it. |
| A Ready GitHub issue has an open native blocker outside its selected source. | The blocker is shown and prevents execution without importing it or granting access to its repository; confirmed closure or edge removal re-evaluates the task. |
| An active task gains a blocker, or blocker status becomes unreadable. | The current turn may finish safely; new execution waits, with ownership and evidence retained, until complete confirmed state permits resumption. |
| An issue leaves one of two sources in a project. | Its other membership remains; its task history and running assignments are not discarded. |
| An external title or status is edited in the dashboard. | The write goes through the plugin and is confirmed remotely; a local-only edit is not presented as a successful provider update. |
| One owner requests implementation and a review. | Both assignments and their results remain attached to the task; instructions decide the next work without a process graph. |
| Instructions change from one reviewer to two. | The change is possible through instructions and existing delegation tools, without adding review stages or result schemas to the runtime. |
| An agent reports success after its permission to publish was denied. | Its report is retained, publication remains unconfirmed, and no forbidden write is authorised. |
| Project A is paused while project B continues. | A starts no new executions; active A executions may finish; B continues within shared limits. |
| A review finishes while its owner is not running. | Its durable result causes one eligible continuation, including after a service restart. |
| A question is answered during a restart. | The answer remains bound to its request and is delivered when work resumes; it is not lost or treated as broader approval. |
| A PR is created just before the service crashes. | Recovery checks whether the intended PR exists before issuing another creation request. |
| The service restarts while an old worker may still be writing. | Ownership and workspace are retained; a replacement writer waits until the prior execution is reconciled. |
| The runtime cannot resume the original conversation. | A new conversation receives the durable assignment and relevant records, preserving work ownership and permissions. |
| An operator configures execution access. | The UI reflects BB/provider controls and clearly distinguishes Ensemble action policy from host-level access; no independent sandbox is claimed. |
| A tracker event is missed or delivered twice. | Reconciliation discovers current work; duplicates do not duplicate ownership, requests, or external effects. |

## Decisions needed before implementation

The following proposals and open choices require review before the affected
behaviour is implemented. They do not reopen the accepted architecture.

| Decision | Why it matters | Current position |
| --- | --- | --- |
| Instruction and permission changes | Determines which context resumed work uses and how access is revoked. | Keep existing assignment revisions until explicit apply; specify revision propagation and recheck permissions at action time. Revocation of Ensemble actions is checked at execution; stopping agent access uses BB/provider controls. |
| Execution and workspace isolation | Determines how enforced access and concurrent repository work are achieved. | Use BB/provider controls and one task worktree with one writer; prove workspace reuse, cleanup and termination behaviour. |
| Persistence and integration contracts | Determines crash recovery, identity, and uncertain-write reconciliation. | SQLite is selected; settle schemas, transactions, and GitHub identity and field handling before extracting a plugin interface. |
| Limits and operational controls | Determines predictable cost, queue fairness, and stopping behaviour. | Activation, pause/stop, BB concurrency and bounded retries are accepted; retain-until-archive is the cleanup default and inactivity is flagged for attention; detailed retry classification, activity signals and thresholds still need technical design. |

## How this document becomes implementation

Review these behaviours against concrete scenarios first. The technical design,
acceptance matrix and ticket drafts linked above are the implementation-planning
package. Publish approved tickets to GitHub after review; do not treat local draft
IDs as existing issues. Record newly accepted
terms in [CONTEXT.md](../CONTEXT.md), and amend the ADR only when an architectural
decision changes. Keep this specification as the behavioural contract.

For a selected delivery slice, write a focused technical design that settles its
storage, interfaces, permissions, and failure handling, referencing the relevant
scenarios above. Track delivery work in GitHub Issues using the repository's
[issue tracker conventions](agents/issue-tracker.md). Update this document as
decisions are accepted; passing checks, rather than documentation status, establish
which capabilities actually work.
