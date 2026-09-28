# Ensemble behavioural specification

**Product scope reviewed and confirmed by Chris on 27 September 2026.**
Chris approved the minimum S01 integration contract on 28 September 2026.
Assignment routing and project-lead accountability were confirmed on 28 September
2026; see [ADR-1005](adr/1005-service-assignment-routing.md). Runtime-specific
implementation contracts remain subject to S01 evidence.
[ADR-1004](adr/1004-standalone-service.md) removes BB from the target architecture.
This specification preserves the product policies from ADR-1001, ADR-1002 and
ADR-1003 with that ownership change. The [BB specification](SPEC-bb.md) is history.
No standalone service, scheduler or UI is implemented yet.

## Purpose and scope

Ensemble is one standalone service coordinating multiple projects for a trusted
single operator. It owns tasks, scheduling, assignments, execution supervision,
workspaces, durable conversations and an operator interface. Keep TypeScript,
Node.js and SQLite. The first deployment runs on Chris's Mac and serves a web
operator interface, using Codex with the existing operator login. Codex App Server qualification, web
stack and authentication implementation require technical review; no BB installation is required
by the target product. Private remote access uses Tailscale plus a separate
Ensemble operator login. The standalone installation starts with a fresh database;
historical BB record import is outside the first release.

Agent instructions determine how to plan, implement, review and revise work.
Those activities are not required stages or assignment types. Projects contain
optional linked repositories, reusable profiles, instructions and permissions.
The project lead is accountable for every task outcome, using a separate
conversation per task with the same lead profile. There is no separate task-owner
role. Assignees execute work and may delegate concurrent assignments. Agents may
select permitted profiles but cannot create profiles or expand project authority.

Local tasks are built in. GitHub.com repository issues and GitHub Projects are the
first external sources. Import the selected backlog, excluding PRs and draft
items; readiness is separate. Jira, Linear, GitHub Enterprise, a plugin marketplace,
multiple execution machines, team/RBAC administration and migration of old live
runs are outside the first release. Source interfaces follow concrete integrations.

## First local-task journey

The operator opens Ensemble, creates a project, links optional repositories,
configures profiles and permissions, and creates a task with an expected outcome.
New projects start paused; new tasks start unready. Create and start may mark a
task Ready, but cannot bypass project pause. Enablement admits eligible work.

With routing enabled, the service uses the eligible task's requested outcome as
the initial assignment brief and invokes TypeSafe to select an assignee without
a preliminary lead turn. With routing disabled, the lead allocates work explicitly.
Assignees may investigate, delegate, yield writer access, receive results and
continue. Initial results wake the lead for assessment and a completion decision.
Questions appear in the attention inbox and task detail; answers resume the correct assignment. Outcomes,
evidence, conversations and artifacts remain available after restart. The operator
need not enter conversation IDs, poll workers or manually nudge each activity.

Test this entire journey with a disposable repository and a summary artifact,
plus separate repository-free, question, pause, stop and restart scenarios.
Artifact completion is not proof of GitHub delivery. The implementation agent runs
automated service/UI integration and bounded real-runtime validation before handback.

## Assignment routing and accountability

Routing is optional per project and part of the first standalone release. It
requires explicit project opt-in and configured TypeSafe credentials. The service
calls TypeSafe directly, with no PA agent turn. Supply the assignment brief,
relevant supplied findings, candidate descriptions and operator-written project
routing guidance; exclude credentials and full transcripts. Profile capabilities
and project guidance define suitability, not required development stages.

The service filters candidates by explicit eligibility and permissions. Route a
new assignment when no assignee was specified; honor an explicit permitted profile
selection without invoking TypeSafe. Routing does not authorize execution or grant
readiness. Recheck all admission controls before starting work. Select for fit,
then queue for capacity; do not substitute another profile merely because the
selected profile is busy. An in-scope repair retains its assignee and profile;
reassignment is explicit, rather than automatic routing on every follow-up.

Missing routing context, uncertain recommendations, no suitable candidate or
TypeSafe unavailability wake the project lead with the brief and available routing
evidence. The lead can allocate explicitly without another TypeSafe call. Material
ambiguity discovered during execution goes to the lead; the existing requirement
for operator input on unresolved material scope or authority still applies.

Initial assignment results return to the task-scoped lead conversation. Nested
assignment results return to their requester; the lead can inspect all work without
being woken for every child result. These destinations survive restart. All lead
turns use normal admission and capacity accounting, including task pause/stop and
writer controls. Project-wide coordination uses project context, separate from
individual task histories. The lead assesses initial results and requests further
work or task completion; the service enforces completion conditions and permissions.

See the [routing design](design/assignment-routing.md) for revision and failure
boundaries. Typed judgments and confidence are not proof of correctness or authority.

## Admission, project placement and task dependencies

The operator admits local work or defines an authoritative source readiness rule.
The lead may inspect and triage unready tasks but cannot grant readiness. For
GitHub, allow simple all/any label and Project-field conditions; nested expressions
are deferred. Membership in another source cannot grant admission. Ready authorizes
work within scope, without a universal per-task plan approval. Material ambiguity,
scope expansion or ungranted actions require operator input.

Dependencies gate execution separately from Ready. A blocked task remains visible
and Ready but starts no task execution, new turn or delegation. Only the operator edits
local task edges, within the same project; reject cycles and self-dependencies.
Local Done clears a blocker; cancellation does not. Imported GitHub tasks follow
native dependency edges, including blockers outside the selection, without importing
those blockers or granting repository access. No duplicate local edge or bypass is
provided for an extant native edge. Closure or edge removal releases that blocker;
reopening reapplies it. Unknown or incomplete state holds dispatch even on first
observation or after prior clearance. Current turns may finish when a new blocker
appears; results and ownership remain. Clearance rechecks every other control.

External identity includes provider instance and is independent of source query.
Multiple sources in one project produce one task with multiple memberships.
Cross-project overlap requires operator placement: preserve existing project
placement and assignments; hold newly conflicted work without established assignments
and never combine permissions. Transfers of tasks with established assignments
between projects are deferred. Discovery grants no additional repository access.

Losing readiness, leaving all selections or external closure holds new delegation
and notifies the lead and active assignees to reach a safe stopping point. Operator resolution is needed
to resume, except confirmed closure from this task's own delivery. Harmless edits
can be incorporated; materially changed scope holds work for clarification.

## Execution and recovery

Pause allows active turns to finish but holds queued and new turns, including
result continuations. Results, observations and answers persist. Other projects
continue. Stop durably holds pending work and requests best-effort cancellation of
every active execution in the task, including its lead turn and delegated
assignments. Observe for a predeclared bounded interval;
effects may continue afterwards. Stop is not task cancellation or completion.
Unverified termination retains Stop, writer and capacity holds and remains visibly
stopping/uncertain. Explicit resume clears only the operator Stop, never unresolved
execution ownership. Preserve files/history; time and acknowledgements cannot unlock.
Resume revalidates readiness, dependencies, permissions and execution ownership.
Hold a macOS sleep assertion while execution is active, releasing it when idle.
Forced sleep or wake requires execution reconciliation before admitting more work.

Ensemble owns capacity admission with both a global active-turn cap and a cap for
each project. Waiting for workers, people or external feedback
releases an execution slot; capacity one must not deadlock delegation. Default
to four active turns globally and two per project, editable in configuration.
Lowering a cap holds new admissions until active usage fits; it does not silently
terminate active turns. Fairness remains a technical contract to specify.
Retry confirmed transient
execution failures at most twice with backoff, persisting the allowance across
restart. Blind relaunches cannot reset it. Uncertain acceptance/effects must be
reconciled before retry. Silence flags attention, not automatic restart or termination.

Each assignment has durable identity independent of its conversation. Follow-up
retains history with a new work revision; stale results cannot complete newer work.
Existing assignments retain captured instructions/profile revisions until explicit
apply for their next turn. New assignments use current revisions. Permission
revocations apply to subsequent actions regardless of snapshots.

Record results and handoffs through coordination commands, not transcript inference.
A successful process exit is not a task outcome. One reporting prompt may repair a
completed turn with neither result nor waiting reason; then hold for attention.
Persist that allowance and apply normal admission controls. Results arriving while
their recipient is active wait for its next turn; coalesce continuation wakeups while
retaining individual acknowledgements. Paused/stopped recipients retain their inbox.

Already-admitted execution and tools may survive coordinator or App Server failure
and continue effects. A crash releases neither writer ownership nor capacity. No
queued turn, follow-up, delegation or replacement may gain admission while Ensemble
is unavailable. Retain unresolved holds rather than relaunching work. Historical
conversation resume does not prove reattachment to a live execution. If unique live
reattachment is unavailable, retain uncertainty and use the operator recovery path
in the [standalone design](design/standalone.md#operator-recovery-of-uncertain-execution).

Persist launch and external-action intent before effects. Reconcile uncertain
acceptance, surviving executions and external writes after restart before competing
work can start. Zero search matches alone do not prove a request was never accepted.
Previously enabled standalone work resumes automatically after successful
reconciliation, subject to every current admission check. Preserve previous
pause/stop holds; a service restart never clears an operator stop. This applies
to the standalone database, not old BB assignments.
Uncertain effects hold dependent work; independent
work may proceed only when independence is established. No arbitrary external API
is promised exactly-once effects.

## Workspaces and execution access

Ensemble owns task workspace creation, identity, retention and cleanup. Use one
worktree per participating repository per task, shared by assignments with one
admitted writer generation at a time under the cooperative rule below. Independent
tasks can proceed concurrently; parallel reviews
reference a fixed revision. Repository-free tasks need no Git worktree.

Normal successful completion permits cooperative handoff only when the identified
final turn succeeds, every registered tool has ended, observations are complete and
no survivor is known. Serialize release with admission of exactly one successor.
This accepts that an untracked detached child may still write alongside its
successor; it is not physical writer exclusion. Crash, Stop, failure/interruption,
missing observations and known survivors retain holds until independently resolved.
A timer, expired lease, quiet interval, empty terminal list, acknowledged Stop or
operator acknowledgement cannot release them. Conversation replacement and archival
do not automatically delete
workspaces. Retain until operator archival by default; automatic cleanup requires
confirmed delivery and preservation checks for uncommitted work, handoffs and
reconciliation evidence. Missing workspaces hold affected execution visibly.

New projects default to Codex `workspaceWrite` with explicit task writable roots,
command network access disabled and approval policy `never`. Broader command
sandbox escalation is denied; expanding that policy requires separate operator
approval and fresh admission.
Reads retain Codex full read access subject to host permissions; outside-read
denial is not implied. Runtime temporary write roots and protected paths must be
disclosed with the effective policy. See the [default execution policy](design/standalone.md#default-execution-policy)
for supported controls, qualification and ambient-access limits.
Ensemble enforces project policy on its own tools and integrations. Runtime and
OS/deployment controls govern shell, filesystem, network and ambient credentials;
disclose their actual limits and do not claim an independent sandbox. External
content is data, never authority. Runtime choice must establish caller identity
without trusting agent-supplied project or assignment IDs.

## Operator interface and human requests

Provide project/task lists, task detail, conversations and execution history,
configuration and a shared attention inbox. Show capacity, source health, the lead, assignees,
results and artifacts. Distinguish empty, loading, stale, failed, paused, waiting,
stopping and uncertain states. Start with a list; Kanban is optional.

Questions and approvals are durable and scoped. Approval includes the action,
target, requester and reviewed material; changed material invalidates approval.
Answers do not grant unrelated permission. Denial persists. Replayed requests or
responses cannot duplicate effects. Controls acknowledge persisted outcomes.

Ensemble displays conversation history and accepts durable messages to the task-scoped lead conversation
for the next eligible turn. They cannot bypass pause, stop or other admission
controls. Live steering is deferred; stop is a separate control. Exact transcript
and message transport is part of Codex App Server qualification.
The durable attention inbox is the notification source of truth; suppress unchanged
alerts. OS/push delivery is optional, not a release dependency. Credentials must not
appear in UI payloads or exposed transcripts. Remote UI exposure requires a reviewed
operator authentication and transport boundary.

## GitHub and completion

Ensemble owns integration access independently of BB; reuse an explicitly configured
credential facility, keep secrets out of instructions and expose identity/access
failures. Initial discovery uses native issue search and Project-filter syntax,
validated with a preview. Poll and allow manual refresh; show last-success time.
Webhooks are deferred. Partial reads cannot imply task withdrawal or dependency
clearance. Recheck current remote state before consequential actions.

Imported content/status remain provider-authoritative. GitHub issue status and
Project fields retain distinct provenance. Permitted progress comments, labels
and field updates do not authorize granting readiness. Title/body edits require
separate approval. Issue closure is a separate project permission after completion
conditions; observed PR auto-closure is reconciled, not assumed to complete all work.
Writes record confirmed success, confirmed failure or uncertainty; local edits
cannot masquerade as confirmed remote updates.

Each project chooses reviewable PR or through-merge delivery in the operational
release. Reviewable-PR handback waits for settlement; feedback/CI failures wake the
task-scoped project lead, while merge remains operator-owned. Through-merge requires granted authority,
project instructions and actual GitHub requirements. No universal review count is
imposed. Non-code tasks record the requested outcome and evidence; no universal
human acceptance is required beyond configured instructions and permissions.
Assignment completion alone cannot merge, close an issue, complete its task or
remove a workspace.

## Review checkpoint

The [standalone design](design/standalone.md), [acceptance plan](acceptance.md)
and [delivery plan](delivery.md) were reviewed with Chris on 27 September 2026.
The shared product understanding, including the 28 September S01 reset and
routing/accountability amendment, is confirmed.
Codex protocol qualification, service lifecycle, authentication, scheduling
fairness and concrete schema/lifecycle contracts still need design and evidence. Historical
BB failures motivate the new proof cases; they do not establish that standalone
execution already satisfies them.
