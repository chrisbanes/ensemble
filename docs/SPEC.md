# Ensemble behavioural specification

**Product scope reviewed and confirmed by Chris on 27 September 2026.**
Chris approved the minimum S01 integration contract on 28 September 2026.
Assignment routing and project-lead accountability were confirmed on 28 September
2026; see [ADR-1005](adr/1005-service-assignment-routing.md). Runtime-specific
implementation contracts remain subject to S01 evidence.
[ADR-1004](adr/1004-standalone-service.md) removes BB from the target architecture.
This specification preserves the product policies from ADR-1001, ADR-1002 and
ADR-1003 with that ownership change. The [BB specification](SPEC-bb.md) is history.
The standalone service has durable scheduling, capacity admission, supervision,
conservative recovery, and the S04b task-coordination foundations: durable results
and recipient inboxes, human-request attention/interactions, retained-assignee
follow-up, revision-bound lead completion and bounded assignment-routing
provenance. Issue #694 mounts authenticated runtime and coordination routes in
the production operator command, including task/assignment history, capacity,
dependency and instruction controls, interaction decisions, and recovery
presentation. Approval decisions retain and compare exact canonical material;
legacy records without retained material are deny-only. See the
[S04d integration boundary](design/s04d-operator-integration.md).
A [bounded real Codex journey](evidence/s04b-live-runtime-2026-09-29.md) observed
registered dynamic tools on resumed lead and worker threads after service/App
Server restart. This qualifies that tested journey only, not universal
reattachment. A bounded real-runtime operator journey observed a live question,
best-effort Stop, persistent holds and retained history after restart; its
evidence is [S04d](evidence/s04d-operator-2026-09-30.md). Same-host private
HTTPS access through an approved disposable Tailscale route has passed, proving
the private route and browser boundary from the fixture host only;
independent-device reachability and S05 acceptance are not established. The
full assignment router is also outstanding. The
[S04c boundary](design/s04c-operator-ui.md) describes the earlier #703
foundation; requirements below remain product obligations rather than passing
acceptance claims.
S08a provides a separate offline operations CLI for generic standalone SQLite
snapshot/verification/restore and a generated per-user LaunchAgent. These
preserve database state and use ordinary service-start reconciliation; they do
not include workspace contents, settle external effects, or qualify a final
operational cutover. The [macOS operations procedure](operations/standalone-macos.md)
and [bounded evidence](evidence/s08a-operations-2026-09-30.md) distinguish the
deterministic exact-receipt admission journey from the live launchd proof's
paused/unready fixture.

Delivery [UI01 #739](https://github.com/chrisbanes/ensemble/issues/739) adds the
bounded native Codex input adapter, durable recorded-versus-delivered lifecycle,
exact eligible callback reply, conservative restart handling and curated service
answer seam for UI05. Its bounded protocol T1 and separately granted actual T6
service journey have passed; deterministic fixtures qualify the remaining bounded
hold, restart and unsupported-shape contracts.
Production structured forms and complete native UI acceptance remain outstanding.
See the [native input evidence](evidence/ui01-runtime-input.md).

## Purpose and scope

Ensemble is one standalone service coordinating multiple projects for a trusted
single operator. It owns tasks, scheduling, assignments, execution supervision,
workspaces, durable conversations and an operator interface. Keep TypeScript,
Node.js and SQLite. The first deployment runs on Chris's Mac and serves a web
operator interface, using Codex with the existing operator login. Codex App
Server qualification remains a runtime gate; the initial web/authentication
foundation is documented in S04c. No BB installation is required by the target
product. Private remote access uses Tailscale plus a separate
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

## Deferred ChatGPT and native Codex integration — 1 October 2026

Chris deferred X01–X05 after the standalone MVP, superseding the 30 September
first-release amendment and earlier native release-gate retention. Planning,
feasibility probes and implementation are paused under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734) until explicit
reopening and revalidation. X01–X08 do not gate MVP release or cutover; Codex App
Server execution and the independently usable web UI remain in scope. The
following paragraphs retain future integration requirements for individual
macOS self-hosters.
Both operator interfaces support daily creation/tracking, durable messages, answers
and approvals; setup and recovery may remain in the web UI. ChatGPT receives only
explicitly enabled projects' task data, results and interaction material, excluding
credentials, private instructions and raw runtime logs. Subscribed completion,
question and approval events explain outcomes or request input; they grant no write
authority. Self-hosters supply a narrow authenticated HTTPS MCP endpoint using guided
setup; the operator UI and runtime remain private.

New tasks should appear as a main native Codex task with linked worker conversations.
Saved host project placement/linkage is optional; tasks belong to Ensemble projects.
Repository tasks use retained Ensemble worktrees. Inspection
is allowed without handover; native continuation requires explicit human control,
holding further Ensemble task dispatch. Explicit return checks settled execution,
workspace changes and existing admission/ownership holds. Idleness or acknowledgement
cannot release those holds. Native API, visibility and handover feasibility must be
proved before future dependent implementation; failed proof returns evidence and integration
scope for review instead of silently substituting managed threads.

These are deferred requirements, not implemented capabilities. See
[ADR-1006](adr/1006-chatgpt-and-native-codex.md), the
[integration design](design/chatgpt-and-native-codex.md) and
[acceptance additions](acceptance.md#chatgpt-and-native-codex-acceptance).

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
Operator messages may target pending or running assignments, and the task's current
lead when its assignment is completed and the task is open: that message is the
explicit operator follow-up described in the 9 October 2026 amendment below. Other
held or completed assignments are not implicitly revived; resolve the hold or create
explicit follow-up/recovery first. Legacy inbox events do not dispatch a completed
assignment.

A retained canonical initial assignment request positively refused for captured task or
assignment revision mismatch before runtime admission can be continued by posting a
fresh operator message through the existing task inbox. The original held request,
intent and refusal remain immutable history; no replacement initial request is created
automatically. The fresh inbox work captures the current task revision and includes its
current title/outcome alongside the preserved assignment brief and instruction/profile
snapshots. Current admission, permissions, dependency, Stop and execution/effect holds
still apply. Runtime identity, writer admission, capacity reservation, recovery
identity, pending effects or a Stop target disqualify the historical refusal exemption.
Any initial inbox batch stays bound unless the existing narrow stale-delivery withdrawal
proves it safe to withdraw; continuation never orphans or replays that batch.

After exact-generation operator recovery, the old intent remains `reconciled` and
its turn request remains held; the validated recovery receipt alone does not dispatch
work. A new operator message to the same task/assignment can explicitly authorize a
fresh inbox continuation. The message transaction retains an immutable audit linking
the recovered work, receipt, message key/event and old batch. It processes the old
batch without replaying its events; task and assignment message views identify this
as `operator-reconciled`, distinct from successful runtime delivery. Message replay,
provider feedback and settlement cannot create or retarget that authority. Every
admission, completion and external completion action rechecks the audit and exact
recovered-generation proof, while current project/profile/dependency/permission and
Stop gates remain in force. Late callbacks or known survivors after a recorded
continuation persist an uncertainty hold and retract admitted successors; ending the
callback or restarting does not clear that hold. The recovery receipt, old intent and
continuation audit remain historical evidence, not a successful result or a force
unlock. Existing callbacks before any recorded continuation retain their previous
recovery behaviour.

A positively rejected archived `thread/resume` before turn submission has a
separate pre-turn recovery proof. The Codex adapter retains the exact correlated
RPC request, predecessor thread, `-32600` archived-session response and runtime
process identity. The service persists that witness against the admitted request
sequence, work revision and assignment binding before losing submission context.
Missing thread/turn identities, a timeout, malformed response, another RPC error or
a lost turn-start response cannot qualify. The never-admitted refusal and bound-turn
recovery proofs remain distinct.

A historical generation lacking that typed witness requires explicit authenticated
operator adoption. Its immutable command receipt binds the exact held generation,
predecessor, process and persisted response to operator attestations and reviewed
source/harness/evidence/approval references. The host operator verifies those
artifacts and the independently reviewed no-turn evidence; valid metadata syntax or
an error string alone does not establish proof. Model tools cannot adopt evidence.
Command replay returns the same result and rejects altered material or retargeting.
Adoption and recovery are authenticated advanced operator routes; they grant no
new model tool authority or automatic recovery control.

A keyed pre-turn recovery receipt requires the persisted witness, truthful null
thread/turn identities, independent exact-process termination verification and
settled workspace/effects. Recovery reconciles only that generation's ownership;
it leaves the old request held and does not dispatch a successor. An explicit
conversation replacement and a NEW operator message are then both required. The
replacement command checks captured assignment/conversation revisions, persists
its result and prevents duplicate revision increments on replay. The new work starts
a fresh thread. Existing receipts and continuation audits retain their identities
and material unchanged; the old batch is processed as `operator-reconciled` without
replay. Admission, completion and external actions revalidate the pre-turn witness,
receipt and continuation audit at use time. Independent holds, current admission
gates and persistent late-callback/survivor holds remain enforced.

A distinct historical no-turn-submission proof covers an admitted generation
with a captured known-null predecessor and unbound thread/turn identities. It is
operator-only adoption of independently reviewed frozen source, harness and a
complete synchronous write-ahead invocation ledger establishing that `startTurn`
was never called for the exact generation. A generic stop error, missing identities,
process absence or metadata syntax alone cannot establish this proof. An initial
`thread/start` may have created an unobserved idle thread; this contract does not
claim thread noncreation, a positive archived-resume rejection or successful work.
The existing archived-resume predicate and bound-turn proofs remain unchanged.

The separate no-turn witness and receipt discriminator bind request/work,
conversation/writer revisions, assignment snapshots, process and immutable operator
command material. Recovery independently verifies exact-process termination and
requires settled current workspace/effects, preserving null identities and all
older receipt/audit material. It leaves the request held and produces no successful
assignment result or automatic dispatch. Existing keyed conversation replacement
and a NEW authenticated operator message are both required for continuation. The
old batch records `operator-reconciled` processing without replay. Admission,
completion and actions recheck the distinct witness/receipt/audit and current gates;
late callbacks or known survivors persist a hold and retract successors across
restart. The advanced authenticated host routes expose bounded acknowledgement,
with no new model tool authority or forms in the curated operator UI.

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

Normal successful completion trusts Codex's successful terminal status for the
bound thread/turn. After every Ensemble-owned callback has ended, with no known
unfinished execution or other hold, persist completion and serialize ownership
release with admission of one successor. Detailed tool history supports diagnosis;
an absent item alone does not veto an otherwise qualified normal completion.
This accepts incomplete runtime observation and possible unobserved effects or
detached-child writes overlapping a successor. It does not prove physical writer
exclusion or the policy of an unobserved action. See the
[runtime trust boundary](design/standalone.md#runtime-trust-boundary).
Crash, Stop, failure/interruption, missing or conflicting terminal identity/status,
unfinished Ensemble callbacks and known survivors retain holds until independently
resolved.
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

Make the next decision obvious, and keep its evidence close. The presentation
refinements below were approved on 3 October 2026; implementation and visual
qualification remain separate from this product contract.

Provide project/task lists, task detail, conversations and execution history,
configuration and a shared attention inbox. Show capacity, source health, the lead, assignees,
results and artifacts. Distinguish empty, loading, stale, failed, paused, waiting,
stopping, disconnected and uncertain states. Provide both list and Kanban board
views, with the list as the initial default.
Keep known state and uncertainty legible and retain unfinished drafts across
transient failures.

### Everyday navigation and attention

Open on an attention-first overview, with actionable items above a compact
cross-project work list and recent results shown separately. Keep projects in the
desktop sidebar. Present task activity, assignments, dependencies, results and
relevant controls together in task detail. Cover attention needed, normal work in
progress and first-project/first-task experiences.

The attention inbox contains unresolved questions, approvals and problems requiring
operator intervention. Routine progress, completions requiring no decision and
normal dependency waiting do not create attention items. Order attention by
urgency, then age: execution uncertainty and problems requiring intervention first,
then questions and approvals oldest first. Show project and task context on each
item. Unresolved questions, pending approvals and failures remain visible even
when related history is collapsed.

Each attention item explains the decision or intervention needed, its requester
when known, why the operator is needed, and the available response. Keep relevant
evidence beside the response or directly accessible within the task context.
Use the same meaning and action wording in Overview, Inbox, List/Board and task
detail. Returning from a request preserves the previous filters and position.

Distinguish work progress, the next actor and operator attention. Derive them from
recorded facts, showing unknown responsibility explicitly. Running activity alone
does not establish that an agent owns or is repairing a particular failure. A
failed check with an agent-owned repair does not itself create operator attention;
an independent question, approval or recovery problem remains visible. Capacity
waiting is normal progress unless a separate intervention is required.

### Task workspace inspection — approved post-MVP scope, 6 October 2026

Chris confirmed this product scope during triage of #776 on 6 October 2026.
It is not an implementation claim or dispatch authority. Design and review the
desktop/phone experience in Pen before UI implementation; GitHub owns delivery
decomposition and sequencing. This post-MVP scope adds no release/cutover gate
to #649 and does not reopen the paused integrations in #734.

- Give reviewing code changes and inspecting generated outputs equal weight,
  including repository-free task outputs.
- Preview text/code, Markdown, common raster images and PDFs. The initial
  experience is preview-only: unsupported files remain visible with metadata,
  without file downloads or workspace export.
- Preserve bounded copies of result-linked files and diffs so that exact result
  evidence remains inspectable after later workspace changes or removal. Do not
  promise a retained snapshot of the entire result workspace.
- Hide ignored clutter initially and allow the operator to reveal ignored files.
  Sensitive/private-path exclusions remain enforced in every inspection surface.
- Offer a comparison dropdown with Branch, Last turn and Uncommitted targets.
  Uncommitted supports staged and unstaged filters. Branch compares current
  contents against the merge base with the task's base branch, displaying that
  branch and exact baseline commit.
- Last turn means the actual most recent agent turn that could change the task
  workspace, not the latest reported result or completed assignment. It requires
  bounded before/after change capture, identifies the agent and discloses
  incomplete capture. Existing result/work revisions alone do not provide it.
- Keep only the latest finished turn's capture as turn history. Evidence retained
  with a result has its own lifetime and must not disappear when that turn
  capture is replaced.
- Keep the displayed inspection stable until explicit refresh, with observation
  time and known changes disclosed. Inspection does not pause agents or clear
  any execution, dependency or ownership hold.
- A capture that is excluded, oversized, unavailable or changing records a
  specific evidence gap rather than blocking the result. Never substitute later
  bytes for the missing historical capture.
- When the base branch cannot be established, show the missing baseline and let
  the operator select a locally available base branch for inspection. This does
  not fetch, check out a branch or silently substitute a guessed baseline.
- For a failed, interrupted or uncertain latest turn, show any available partial
  observation with its recorded outcome, time and unsettled state. Missing
  capture remains unavailable; observing a diff cannot establish that execution
  or further writes have ended.
- Identify each repository and its own comparison baseline. Repository-free
  workspaces support file inspection and turn capture; Git comparisons are
  unavailable there. Include untracked, deleted and renamed files where
  applicable, with truthful binary/unsupported states.
- Restrict every listing, preview and capture to authorised task contents.
  Reject unsafe paths and symlink escapes; enforce bounded reads and rendering
  without exposing excluded content or executing inspected content as the app.
  Exact storage, routes, renderers and documented numeric limits are engineering
  choices within these contracts. Existing historical results are not backfilled
  with later bytes. Editing, terminals, whole-workspace snapshots, arbitrary
  revision comparison and native desktop integration remain outside this scope.

The [post-MVP inspection acceptance scenarios](acceptance.md#post-mvp-task-workspace-inspection)
define the required evidence without claiming any scenario has passed.

#### #779 server inspection boundary

As of 8 October 2026, the standalone service implements authenticated JSON GETs
for a task workspace directory and one file preview. Each request names a
current task and either the repository-free workspace root or an exact bound
repository ID; clients cannot supply filesystem roots. The session is checked
again after the awaited read. The #779 directory and preview routes do not
provide a file download, terminal, edit action, comparison, capture, or preview
UI.

The server scans one directory level, with a maximum of 32 path segments and
2,048 UTF-8 path bytes, 4,096 entries scanned and 256 returned, a 2-second Git
ignore check with 1 MiB combined output cap, and a 2 MiB Git input cap. Text and
code are limited to 1 MiB; PNG, JPEG, GIF, WebP and PDF payloads are limited to
8 MiB. Raster dimensions are limited to 16 megapixels. PDF is returned only as
bounded base64 data with a 10-page display handoff; a later renderer must
enforce that limit and use an isolated rendering context before claiming a
visual PDF preview. Failed Git ignore classification returns an incomplete
availability result rather than revealing entries whose ignore state is
unknown.

Both workspace and repository scopes omit `.git`, `.ssh`, `.aws`, `.gnupg`,
`.netrc`, `.npmrc`, `.pypirc`, `.env`, `.env.*`, `*.pem` and `*.key` path
components, case-insensitively; direct requests return an empty excluded state.
`showIgnored` reveals Git-ignored repository files and the documented
repository-free clutter names (`.DS_Store`, `node_modules`, `.cache`,
`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache` and `coverage`),
but never overrides private-path exclusions. Previews require a regular
single-link file, a no-follow open and stable file, root and task-binding
identity around the read. Text, Markdown and HTML are inert UTF-8 in JSON;
raster and PDF bytes are typed base64 data, never navigable file responses.
These checks enforce path-based exclusions and bounded current-file reads;
they are not semantic secret scanning or host-wide read isolation. Result
snapshots, stable UI refresh behavior and the operator renderer remain later
work.

#### #780 server comparison and turn capture

The server adds authenticated JSON comparison reads at
`/api/operator/tasks/{taskId}/comparisons`. Branch reads use an explicit
operator-selected local base branch and its exact merge-base commit; they do
not guess a base or fetch or check out refs. Uncommitted reads support all,
staged and unstaged changes. Repository-free tasks can be observed around an
actual workspace-capable turn, while Git comparisons remain unavailable.
Comparison IDs stay stable until an explicit refresh; an old ID is never
silently redirected to newer workspace contents. Current exclusion, binding,
task-access and session checks apply again before stored comparison projections
are returned. Local Git reads clear inherited `GIT_*` environment overrides,
disable fsmonitor and replacement refs, and disallow transport so these reads do
not fetch. Before a working-tree diff, the service discovers only configured
clean/process filter names, applies empty command-line overrides with
`required=false`, and checks the names again afterward. Discovery accepts at
most 64 ASCII driver names of at most 64 bytes and 16 KiB of key-name output;
malformed, oversized or changed names produce a gap. This recheck reports
observed name changes but does not claim containment of concurrent Git-config
edits outside that observation. The reader does not execute those filters or
write Git configuration. The authenticated API does not add a file download or
UI.

The durable SQLite turn slots keep the latest finished capture and a separate
pending or unsettled capture. A capture records the admitted task/work revision,
request sequence, assignment and profile revisions/IDs, exact runtime thread
and turn IDs when bound, outcome, timestamps, before/after observations, and
immutable comparison sides. Capture or store failure remains an explicit gap;
it does not determine runtime completion, clear a hold, or replace the previous
finished capture. Exported side text is checked against its original byte hash,
size, line count, path, side and range before it is retained or returned. This
export is consumed by #781's server-side result and review-context retention.
The bounded copy remains distinct from the latest-turn slot and from the later
#782 review-delivery lifecycle.

Comparison and each before/after observation scan at most 4,096 entries and
return at most 256. A text file or side is limited to 1 MiB, source bytes to
8 MiB per comparison/observation, combined Git-child output to 2 MiB, and
rendered diff output to 1 MiB. Diffs are limited to 2,048 lines per side and
4,000,000 diff operations. Each local Git child has a 1.5-second timeout. The
comparison/observation clock is 5 seconds, below the published plan's 10-second
per-observation value; source-byte and rendered-diff limits are also lower than
the plan's 16 MiB and 2 MiB values. Durable serialized comparison, side and
capture payloads have a 20 MiB per-record limit.

The 5-second clock is an observation budget: when useful scan/read work exceeds
it, the comparison records a `time-limit` gap. Awaited workspace validation,
current-policy checks and bounded Git-child cleanup may extend beyond that
threshold, so it is not a strict wall-clock response guarantee. These limits
can produce incomplete comparisons and are engineering bounds, not a claim of a
whole-workspace snapshot. The actual Codex runtime hook still requires its
separate bounded qualification; fake-runtime evidence does not establish native
runtime behavior.

#### Retained result evidence and review context — #781

The service captures bounded evidence during the accepted
`ensemble_report_result` callback, before recording its result and callback
receipt. Eligible sources are linked artifact files, supplied change-file
references read through the existing safe workspace reader, and a compatible
exact turn-comparison export. A direct result-recording path that does not pass
through this callback keeps its prior behavior; pre-retention results remain
references and are never backfilled from current files. A callback with no
eligible file links records an empty manifest. Exact callback replay returns
the committed result and original manifest without rereading the workspace.

Each manifest binds its result, task, assignment and work revisions, request
sequence, profile/instructions revisions, runtime thread and turn, capture
time, and comparison observation identity. `taskVersion` is the exact revision
admitted by the turn request; `captureTaskVersion` is the current task revision
used for workspace and access-policy checks. A metadata edit after admission but
before the callback preserves the admitted request identity while capture uses
the current revision. If that current revision changes during capture, result,
receipt and evidence commit together only when the exact binding still matches;
otherwise the transaction is rejected without partial acceptance. Available
bytes live in SQLite BLOBs. Capture, policy, read, size and quota failures are
represented as explicit gaps while a valid result is recorded. A stale or
foreign result binding remains rejected; an unrecoverable SQLite result/receipt
commit failure rolls back the result and evidence together. Pending or unsettled
comparison exports produce a diff gap. The service does not substitute an older
turn or backfill that gap from a later comparison, and capture time does not
imply that the callback stopped later workspace writes.

Authenticated task-scoped reads resolve exact result and item IDs and recheck
the current task, project, session, repository and path exclusions. A retained
diff is withheld if any included path, including either rename path, is now
excluded. A new retained gap or unavailable item never falls through to a
matching live file. Legacy records without a retained manifest keep the
existing reference behavior. Text and image/PDF previews retain the original
captured bytes under the existing preview limits; original filesystem roots
remain internal.

Review anchors retain a bounded original excerpt, exact source hash, line and
byte range, side, source identity and observation time. Drafts may select a
current workspace file or an exact comparison side without a result. A supplied
result association is validated against the same task/work and exact source
comparison where applicable; a comparison-side anchor remains comparison
evidence even when associated with a result whose callback-time diff is a gap.
Sealing moves the exact anchor IDs into a durable submitted-context reference;
it is not a review delivery or receipt. Discarding a sealed draft preserves its
submitted context. Anchors continue to resolve their original excerpt after
file edits, latest-turn replacement, workspace archive/cleanup and service
restart; missing comparisons are reported as unknown or unavailable without
retargeting to newer bytes. Review delivery and operator UI remain #782 scope.

The logical payload limits are 1 MiB per retained text file, 8 MiB per image or
PDF, 1 MiB per serialized observed diff, 32 selected files and 32 MiB per
result, 128 MiB of result payload per task, and 512 MiB across retained result
and review payloads per installation. Review context is limited to 256 KiB per
anchor, 128 anchors and 16 MiB per task within the same installation pool.
Quota pressure records a gap for new material and never evicts referenced
bytes. These limits count logical BLOB payloads; SQLite pages, indexes, WAL and
filesystem overhead can increase disk use. Offline SQLite backup, verification
and restore include retained evidence BLOBs; managed workspace contents remain
outside the snapshot.

#### Local code review amendment — 6 October 2026

Chris approved adding line-level feedback and batched local code reviews to this
scope. File inspection remains read-only; review drafts and submission are
explicit local feedback actions.

- Select a single line or range in supported text previews or either diff side,
  including deleted lines. Collect comments across files within the same task;
  add, edit or remove draft comments and supply an optional overall summary.
- Bind each comment to exact task/repository/file content identity, line range,
  applicable diff side and source comparison/result/turn context. Retain bounded
  reviewed context independently of latest-turn replacement or workspace cleanup;
  this extends retention to review anchors, not whole workspace snapshots.
- Later changes mark affected comments outdated without silently moving them to
  newer contents. Unavailable or unknown comparisons remain explicit; file paths
  and line numbers alone cannot establish exact identity. Retention limits and
  access exclusions still apply, and missing original context is never replaced
  with newer bytes.
- Let the operator inspect the complete draft and named project-lead destination
  before Send review. Submit the comments and optional summary together as one
  logical review, with a receipt and exact anchors available to the lead.
- Preserve drafts through navigation and refresh under existing session/privacy
  rules. Confirmed failures retain editable content; uncertain submissions keep
  their original payload and identity for reconciliation without duplicate sends.
- A review delivers local feedback only. It does not publish to GitHub, approve
  or reject work, change readiness/completion, grant merge authority or clear
  holds. Submitted reviews remain recorded feedback; draft removal does not
  retract a submitted review. Retraction, threaded resolution and formal review
  verdicts are outside this initial scope.
- Design and qualify the draft, line selection, outdated-context and submission
  journeys on desktop, phone and keyboard across file/diff and result entry
  points. Preserve the existing single-message contextual feedback workflow.

#### #782 workspace inspection and local review — implemented behaviour

As of 8 October 2026, the production task workspace provides **Files**,
**Changes**, **Retained result evidence** and **Local review**. They are
sections of the existing authenticated task route, so every entry point that
opens a task reaches them. Section links scroll in place and keep the entry's
origin for "Back to originating view". Exact links accept `path` with optional
`repository`, comparison `target`/`repository`/`base`, `result` with `evidence`,
and a sent `review` operation; missing or unauthorised targets explain their
state and never substitute other bytes.

- Files reads only the #779 directory and preview routes. Markdown renders
  inertly with a Source view, rasters fit/zoom/pan, and PDFs render through a
  pinned `pdfjs-dist` worker onto app-owned canvas. There is no download, export
  or execute action. Opening current contents from retained evidence is a
  separate explicit action.
- Changes reads the #780 exact-ID comparisons. Each repository keeps its own
  local base and change set. Split and unified diffs share line selection, and
  phone shows only the unified diff.
- Retained result evidence shows the #781 capture provenance, item states and
  original bytes. Gaps are never backfilled from later bytes.
- Review comments stage exact anchors through `review.anchor.stage`. The
  sources are a current file (`workspace-file`), a comparison side
  (`comparison-side`) or a retained file item (`result-evidence`). Shift extends
  a line range. Anchors are allowed for the repository-free root and for
  repositories linked in the project's GitHub configuration, which is how
  production binds task repositories.
- `GET /api/operator/tasks/{taskId}/review-draft` returns the current
  session's draft. `review.draft.save` and `review.draft.discard` carry the
  expected draft version. Limits are 32 comments, 4,000 characters per comment
  or summary and 16,000 serialized bytes per draft; oversized drafts are
  rejected before any anchor seal or event. A sent draft stays frozen until
  discarded, which starts the next review and keeps submitted context.
- A draft belongs to its authenticated session and to an access fingerprint
  made of the task, project, workspace binding, exclusions, linked repositories
  and control paths. Sign-out, expiry and restart remove an editable draft.
  After an access change the draft's text and anchors are rechecked: it is
  kept and rebound when still permitted, and removed only when something is
  now excluded. A "removed unsent draft" notice appears only when the removed
  draft had text or anchors, and clears on the next draft save. Unrelated task,
  profile or configuration version changes do not remove a draft.
- `review.send` freezes one operation for the named project lead, who must be
  the task's current lead assignment: pending or running, or completed on an
  open task, which the review resumes as an operator follow-up (amendment
  below). Any outcome without a receipt
  is unknown. The draft read exposes the owning session's frozen operation, and
  the browser keeps only its identity, never comment text. Reconciliation uses
  `review.send.reconcile` with the same key and material. A rejected or
  not-recorded receipt returns to the editable draft.
- The lead's message gives each comment's exact source: repository or task
  workspace, path, lines, context, side, comparison or result item, turn,
  source hash and retained anchor ID, plus an original excerpt of up to 12
  lines or 800 characters. A shortened excerpt is marked as shortened. When
  excerpts would take the message past 16,000 bytes, all excerpts are omitted
  and the message says so. If identities alone still exceed the limit, the send
  is refused with `local-review-batch-too-large` before any operation is
  recorded, and the draft stays editable.
  `GET /api/operator/tasks/{taskId}/local-reviews/{operationId}` shows the sent
  review with original anchor context under current access policy, and a
  recorded one carries `recordedAt`, the time it was recorded. Text from a
  rejected or not-recorded operation is shown only to its own session.
  `GET /api/operator/tasks/{taskId}/local-reviews` (no query parameters) lists
  up to 50 recorded reviews newest first, each with `operationId`, `reviewId`,
  `recipientAssignmentId`, `eventId` and `recordedAt`. Unsent operations are
  never listed. Both reads apply the current session and access policy.
- Definitive no-delivery outcomes keep the draft editable. A frozen operation
  whose anchor is unavailable when sent is rejected with `anchor-unavailable`
  (an excluded anchor with `excluded-anchor`). When the named recipient is not
  the task's current lead, the lead is held, the task is not open, or a
  completed lead's latest result is not its newest unambiguous work, the send
  is refused with `local-review-recipient-unavailable` (409) before any
  operation exists.
- Review delivery queues one local operator message and receipt; to a
  completed lead it queues one operator follow-up instead. It never calls
  GitHub or changes approval, readiness, merge authority or holds, and it never
  reopens or completes a task.
- Read-only inspection rechecks may reuse a successful Git worktree identity
  read for up to 1 second while the worktree root and its `.git` entry keep the
  same filesystem identity. Execution admission always rereads Git.

#### Operator follow-up to a completed lead — approved amendment, 9 October 2026

Chris approved this amendment during triage of #828. It was implemented on
9 October 2026 for #828; the #782 rules above describe the shipped result. It
relaxes #782's rule that a review cannot change completion state, only as
described here.

- Addressing feedback to the lead is the request to resume it. An ordinary or
  contextual operator message, or a local review, sent to the task's current
  lead whose assignment is completed, while the task is open, records an
  operator **follow-up**: the same lead assignment returns to pending under a new
  assignment version and work revision, linked to the lead's latest result. The
  message or review is delivered as the follow-up's instructions with exact
  anchors, and its receipt records that the send resumed the lead.
- Before sending, every entry point that addresses the lead states that the lead
  has completed and will resume. Send keeps its label; messages and reviews use
  the same wording.
- If the lead completes after the operator began composing, the send is still
  delivered as a follow-up and the receipt records the resume.
- Feedback is refused, with the draft kept editable, when the task is done or
  cancelled, the lead is held, the addressee is not the current lead, or the
  lead's latest result is not its newest unambiguous work. Feedback never
  reopens a task; that remains a separate explicit action.
- Receipts, idempotent replay and unknown-outcome reconciliation are unchanged;
  replaying a send never resumes the lead twice. A delivered follow-up cannot be
  retracted; the existing pause and stop controls are the recovery path.
- Holds, approval, readiness, merge authority and delivery settlement are
  unchanged. On a paused project, admission still holds dispatch.
- A local review does not resume a lead whose recovery continuation is waiting
  on an operator message. While that continuation waits, the Local review panel
  says that sending the review will not resume the lead and that an ordinary
  message is needed.
- Task conversations with agent @mentions are a separate idea tracked in #842.

Implemented contract details:

- The follow-up reuses the agent follow-up mechanism: one
  `assignment-follow-up` inbox event whose `instructions` are the message or
  the rendered review (with any contextual `reference`), and one
  `coordination_follow_ups` row whose `requester` is `operator`. The resumed
  turn's new work revision is allocated at admission, as for agent follow-ups.
- The `message` command's `coordination` receipt, the `review.send` and
  `review.send.reconcile` `local-review-operation` receipts and the local review
  operation read carry `resumedLead: true` when the send resumed the lead.
  Replay returns the same receipt.
- Refusals for a completed lead are definitive 409s: `conflict` for messages
  (`Follow-up unavailable: task is not open`, `Follow-up unavailable: latest
  result is not the newest unambiguous work`, or the existing pending-or-running
  refusal for a held lead or non-lead) and `local-review-recipient-unavailable`
  for reviews.
- The operator task read adds optional `leadFeedback`: `mode` is `receives`,
  `resumes` or `unavailable`, computed by the same rule that accepts the send,
  and `awaitingRecoveryMessage` is true while an ordinary operator message to
  the lead would record a waiting recovery continuation. A follow-up never
  records a recovery continuation.
- The task Reply composer (including contextual "Ask lead about …" drafts) and
  the Local review panel show one status line from `web/src/lead-feedback.ts`:
  "<Lead> has completed its assignment and will resume to address this
  feedback." A resumed send reports "Receipt recorded. <Lead> resumed with this
  feedback." in the composer and "<Lead> was resumed with this review as a
  follow-up." in Local review. Local review shows the recovery-continuation
  copy while `awaitingRecoveryMessage` is true; Send stays enabled.
- Remaining gap: the legacy server-rendered `/coordination/...` task and
  assignment pages still offer message forms only for pending or running
  assignments. A direct `POST /coordination/control/message` follows the same
  rule as the API.

### Task overview and evidence — design direction, 3 October 2026

Chris approved bringing the task brief, delegation, latest result and supporting
evidence together, informed by Intent's shared-spec and verification experience.
This is a specification change. Design and review the experience in Pen before
implementing it; this amendment does not approve a screen layout.
The following describes desired behaviour, not implemented capability or a fixed
screen layout. Existing GitHub delivery issues remain authoritative for sequencing
and slice acceptance; this amendment does not complete UI04 or qualify release.

The [Pen source](../design/design.pen) and
[interaction and state handoff](../design/DESIGN.md) include the subsequent review
extensions below. Chris agreed to carry these into the specification and delivery
briefs on 3 October 2026. Status: **design reviewed; implementation deferred**.
Static canvas review does not establish implemented behaviour or final integrated
visual/usability acceptance. Comparison-image loading remains unverified after
relocating the source assets; retain that handoff gap until it is checked.

- **Shared task brief.** Make the desired outcome, supplied acceptance criteria,
  current approach, recorded decisions and unresolved questions easy to find.
  Preserve provenance: imported GitHub content remains authoritative and read-only
  locally, while agent plans and decisions are distinguishable from requirements.
  Do not create a competing editable specification or invent missing criteria.
- **Evidence beside results.** Present relevant screenshots, artifacts and
  validation alongside the result or acceptance criterion they support, when that
  relationship is recorded. Identify the reporting assignment and relevant work
  or artifact revision. Distinguish agent-reported claims from recorded verification;
  absent, unavailable, stale or redacted evidence cannot imply a passed criterion.
  Keep earlier results accessible without presenting them as the current outcome.
- **Readable delegation.** Show each assignment's responsibility, assignee,
  requester, known reason for waiting and result destination. Keep the accountable
  project lead identifiable and distinguish assignments sharing a profile. Use
  durable coordination and runtime observations rather than inferring ownership,
  waiting or completion from conversation text. Unknown state stays explicit.
- **Compact progress across tasks.** Summarize the current work state, known wait
  reason and latest available result using source-faithful text. Keep ordinary
  progress and dependency waiting separate from decisions needing the operator.
  List, Board, overview and attention entry points must lead to a consistent task
  experience without losing project or source context.

The reviewed extension adds these behaviours to the same task experience:

- **Criterion outcomes.** Summarise supplied criteria using their recorded
  evidence relationships. Distinguish supported, failed, unverified and stale
  evidence; expose the supporting result, assignment and revision. Do not infer
  an overall pass from agent claims, missing checks or a count of supported rows.
- **Before/after comparison.** Pair recorded captures with labels identifying
  their role, result and work/artifact revision. Keep the relevant criterion and
  evidence context reachable. Missing, unavailable, redacted or mismatched
  captures remain explicit; an image comparison does not itself verify a
  criterion. Comparison is also usable on phone.
- **Contextual feedback.** From a result, criterion or artifact, let the operator
  inspect the context and edit an “Ask lead for changes” draft before sending.
  Show the accountable lead destination and preserve the exact recorded anchors.
  This is an ordinary local message under existing permissions: it does not
  approve, reject, change task state or post to GitHub. A confirmed failure
  retains an editable draft for retry; an unknown send outcome requires existing
  reconciliation before another send, and confirmed delivery has a receipt.
- **Changes since viewed.** Identify newer results, superseded evidence and
  changed source requirements relative to the recorded viewing reference.
  Keep earlier revisions accessible. Viewing is not approval. Show no baseline
  or unknown source comparison explicitly; a failed refresh cannot establish
  that requirements are unchanged.
- **Captured assignment context.** Show who supplied the brief, its captured
  version, recorded instruction/profile revisions and source references, with
  unavailable or incomplete capture explicit. Distinguish that assignment's
  captured context from current requirements. A reference being available does
  not establish that an agent read it. Do not expose secrets or imply complete
  runtime visibility.
- **Recorded changes and delivery.** Keep recorded files, commits, result diff,
  PR identity, checks and findings close to the result. Attribute repair ownership
  only when recorded. Identify provider state, the checked head/revision and
  stale or changed-head evidence; retain a useful no-PR state. Provider refresh
  is a read. A merged PR does not complete the Ensemble task, and these views
  retain exact-material approvals and independent dependency/recovery holds.
- **Search recorded work.** Provide discoverable Search in shared desktop and
  phone navigation for retained tasks, decisions and results within permitted
  project access. Every match identifies its project, parent task and record type,
  including similar matches from different projects. Open the exact matching
  section and revision, with historical results labelled. Return preserves query,
  filters, selected match and reading position; returning to the originating
  workspace preserves its view state. Distinguish no matches, partial coverage
  and failed search. Search does not promise a complete runtime transcript or
  access to unavailable, redacted or unretained material. Canvas state specimens
  are review aids, not additional product navigation.

These behaviours belong to #742, including search and the shared navigation
changes needed to reach it. #736 retains the overall scope and final human
acceptance gate; #745 qualifies the assembled experience. This amendment does
not reopen completed #741 work or authorise implementation dispatch.

The Pen design should explore information hierarchy, concise previews and expanded
detail on laptop and phone. Include tasks with no assignments or results, parallel
delegation, long briefs, a pending question or approval, dependency waits, failed
refresh, uncertain execution and unavailable evidence. Preserve visible actionable
requests, reading position, disclosure choices and unfinished replies. Existing
execution, recovery and exact-material approval controls must remain reachable.
Do not freeze routes, API fields, attachment storage or rendering technology through
the design; settle those against the reviewed experience and existing boundaries.

Centralized, consolidated PR feedback is a separate technical idea to assess against
Ensemble's existing implementation, not a new requirement in this amendment.
Integrated editors, terminals, browsers, extra execution providers and remote
execution are outside this change. The deferred native integrations remain paused.

### Kanban board

Provide a List/Board switch for cross-project and project task views. Both views
show the same tasks and respect the current project and task filters. Switching
views preserves those filters and does not change task state.

Group board cards by Ensemble work state, showing the task title, project, lead,
source identity when imported, and the reason for waiting or intervention. Keep
readiness and dependency holds distinct: a Ready task can still be blocked. Keep
uncertain and stopping work visible rather than implying completion. Cards open
the same task detail as list rows; the attention inbox remains available in either
view. Provide readable narrow-screen navigation between columns.

Attention appears alongside work state rather than replacing it. Keep actionable
readiness, successful completion, cancellation and provider closure without
delivery visibly distinguishable. Provider closure alone does not establish task
completion. Prioritise the task's meaning, current situation and next actor;
supporting identifiers and timestamps must remain readable and accessible without
competing with that information. These refinements do not change the existing
board state mapping.

Board columns describe Ensemble work, not GitHub issue state or Project fields.
The board does not grant arbitrary status changes or require drag-and-drop for the
MVP. Any offered transition must use an existing permitted command and preserve
readiness, dependency, approval and source-ownership rules; moving a card cannot
bypass a hold or silently write to GitHub.

### Task creation and project setup

Provide a simple initial task composer that supports a substantial brief. Keep
project selection, title and desired outcome prominent. Progressively disclose
optional context, reference links, permitted explicit assignee selection and task
dependencies; show a summary of supplied optional settings when collapsed. Keep
entered values and field errors accessible through disclosure. Use Create and start
as the primary action and Save draft as the secondary action. Explain before submission that starting is subject to
project state, dependencies, capacity and execution holds. Show the persisted
state and reason for any wait after submission; creation does not imply running.
These controls must preserve existing readiness and admission rules.

Use a short guided project setup: project name, lead profile, instructions and
optional repository access. Choose each repository and ref from lists discovered
on GitHub, with the default branch preselected, and choose its local checkout with
a folder picker. The service verifies that the folder is a checkout of the chosen
repository and that the ref is available. Setup may link a GitHub Project
discovered from the chosen repositories or owner; linking adds an inactive
discovery source, and preview, readiness and activation follow in project
configuration. When discovery is unavailable, setup accepts typed values and says
so. Advanced routing and external source configuration can follow later.
Discovery, source selection and a linked GitHub Project do not grant repository
access; access is exactly the repositories the operator adds. See
[ADR-1009](adr/1009-project-setup-discovery.md).

Settings present each project's repository access and GitHub discovery sources
together, labelled separately, rather than as two unrelated lists.

An agent profile has a name, an optional short summary, private instructions and
capabilities. Settings and routing candidate lists show the name with its summary
(for example "Eli · Repairs"). Like capabilities, the summary describes
suitability; it grants no permission or repository access.

Configuration forms edit current values in place rather than requiring a complete
replacement. Private values (instructions, routing guidance, search queries and
local paths) are never loaded; they show as kept and change only through an
explicit replacement. Before saving, list every change, including access added or
removed and sources added inactive. Removing all repository access needs explicit
confirmation. A save is keyed against the loaded version: a conflict keeps the
input and shows the newer version, and an unknown outcome blocks further edits
until the original save is checked. Saving never resumes work, clears holds or
grants access by implication.

Phone layouts support checking progress, creating tasks, messaging, answering
questions and reviewing approvals. Complex configuration and recovery are
desktop-first; narrow screens must still explain the current state and next step.

### Imported issues and source ownership

Make the distinction between local tasks and imported issues visible. Imported task
detail shows the provider, repository and issue identifier, a source link, the last
successful sync, refresh and any sync failure or stale state. Present external
issue status and Project fields separately from Ensemble execution state; an open
GitHub issue can have work waiting for approval in Ensemble.

For the MVP, imported titles and descriptions are read-only in the operator UI,
with Edit on GitHub linking to the source. The local task composer does not edit
imported issue content or create a competing local brief. This UI restriction does
not replace the separate approval required for any integration title/body edit.

Label native GitHub dependencies as source-owned and link to the source; do not
offer local overrides. Distinguish Message lead from any permitted Post comment to
GitHub action, including the destination before submission. Local messages do not
implicitly publish comments or edit issues. Keep assignments, conversations,
execution controls and results distinct from provider-owned fields.

Show remote writes as pending until their outcome is known, then as confirmed
success, confirmed failure or uncertain. Do not present local or optimistic state
as a confirmed GitHub update. Refreshing or retrying must preserve the existing
remote-write reconciliation and permission rules.

### Task detail

The initial task view presents the outcome, current situation and next actor,
unresolved decisions, and relevant results or evidence before detailed history.
Keep delivery observations, artifacts, dependencies, assignments and captured
conversations accessible within task detail. Understanding current work
must not require reading raw runtime output.

Preserve the task, assignment and conversation hierarchy: the task retains the
outcome and accountable lead, assignments identify delegated responsibility, and
conversations supply supporting history. Use recorded facts and attributed,
source-faithful excerpts for the overview. Do not invent narrative summaries,
recommendations or ownership when the evidence is absent. Unavailable or stale
evidence remains explicit. This presentation adds no terminal, embedded browser
or complete-transcript capability.

### Readable task histories

Default to meaningful task activity and group conversation content by durable
assignment. Identify each group by assignment, assignee, latest status and time,
with a source-faithful excerpt rather than an invented summary. Older completed
groups can be collapsed. Opening a group initially shows a bounded recent preview
and its result, with Show earlier for the rest. The preview count is a presentation
choice, not a fixed acceptance requirement. Long messages have
expandable previews. Provide Expand all, Collapse all and a chronological view of
available captured conversation content, retaining omission and redaction notices.

Preserve expansion choices, unfinished replies and reading position as updates
arrive. Follow new messages only when the operator is already at the end of the
conversation; otherwise show a new-updates control without moving their position.
Updates must not reopen collapsed groups or replace unfinished replies.

### Human requests and execution controls

Support agent requests for user input as first-class durable questions, including
structured question interactions such as AskUserQuestion or the selected runtime's
equivalent. Adapt supported runtime requests into the same Ensemble question model
as `ensemble_ask_question`; tool names alone do not establish runtime support.
Preserve the originating task, assignment, conversation and request identity, and
surface the question in the attention inbox and task detail.

Support a single question or a related set, free-text answers, single-choice and
multiple-choice answers. Preserve question text, option labels and descriptions,
selection constraints, and an explicit recommended option when supplied. Allow
custom text when the request permits it. A recommended or preselected option is
not a submitted answer. Validate each answer against its question and keep
unfinished input on submission failure.

The full Ensemble question model is distinct from the selected runtime's supported
native inputs. The 3 October 2026 acceptance amendment retains the full form model
above, qualified through deterministic service/browser tests or Ensemble question
tools. Native MVP acceptance uses the bounded shapes qualified by #739: the
observed single-choice/custom-text round trip and deterministic grouped-shape
coverage. Native standalone free text, multiple selection and recommendation
fields are not additional MVP runtime-proof gates. Unsupported native requests
remain visibly unresolved, without fabricated answers or silent chat conversion.

Persist answers before confirming submission and route them to the requesting
assignment/runtime request, rather than treating them as an unrelated message to
the lead. Replayed submissions must not answer or resume work twice. Restart must
preserve unresolved questions and recorded answers; stale, cancelled or already
answered requests must not accept a new answer as current. Answer delivery and
continuation respect pause, stop, dependencies and ownership holds. Present an
unavailable or unsupported runtime interaction explicitly rather than fabricating
an answer or silently treating it as ordinary chat. Structured runtime bridging
requires qualification; the existing plain-text question tool alone is not evidence
of support for these interactions.

UI05 #743 implements the action Inbox and shared exact request view at
`/app/inbox` and `/app/tasks/:taskId?request=:interactionId`. Its summary queue
uses 100-row fingerprinted pages over the bounded 10,000-task catalog. Selected
forms are read independently of queue and history pages. Approval and recovery
items retain their exact existing material/control destinations. Unknown ownership
or age is labelled explicitly. Answers are durable decisions; correction requires
a new agent request. Transport failures reconcile the original frozen command and
key before editing can resume.

The version-1 Ensemble form retains up to 32 questions, 100 options per question,
512-character IDs/labels, 16,000-character text fields, and independent 256 KiB
UTF-8 form/answer limits. Only the operator command JSON route allows the answer
limit plus its mechanically derived strict command envelope; other commands retain
their 64 KiB raw limit. Unsafe exact forms are withheld in full. Persisted answers
retain original requester/work/version attribution, and fresh responses reject
replaced, cancelled, completed-assignment or ambiguous identity. A successful
requesting terminal or ordinary continuation alone does not supersede an own-tool
question. Receipts replay before fresh eligibility checks. See
[UI05 evidence](evidence/ui05-inbox-questions.md) for validation and retained limits.

Questions and approvals are durable and scoped. Approval includes the action,
target, requester and reviewed material; changed material invalidates approval.
Answers do not grant unrelated permission. Denial persists. Replayed requests or
responses cannot duplicate effects. Controls acknowledge persisted outcomes.

Ensemble displays conversation history and accepts durable messages to the task-scoped lead conversation
for the next eligible turn. They cannot bypass pause, stop or other admission
controls. Live steering is deferred; stop is a separate control. Exact transcript
and message transport is part of Codex App Server qualification.
Stop is best effort; the UI must distinguish stopping from stopped and explain
uncertain execution. Recovery must not imply that Resume can clear unresolved
ownership or force a capacity release.

The implemented assignment view retains sanitized completed assistant text bound
to the exact task, assignment, work and runtime turn, including its instruction
and conversation revisions. Partial text is not persisted. The view labels
unfinished or omitted items and limits the displayed item history; it is not a
complete model/tool transcript. Known private instructions, declared credential
references and values, and workspace/control paths are excluded before storage;
current exclusions are also applied when reading history. If safe redaction is
unavailable, text is omitted. Diagnostic capture failures and missing history
cannot establish completion, release ownership or bypass an execution hold.
The durable attention inbox is the notification source of truth; suppress unchanged
alerts. OS/push delivery is optional. Subscribed ChatGPT events belong to the
deferred post-MVP integration and are not an MVP release gate. Credentials must not
appear in UI payloads or exposed transcripts. The current #703 authentication
boundary is defined in [S04c](design/s04c-operator-ui.md); complete remote access
and release qualification remain separate acceptance work.

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

The service implements operator-owned, versioned project delivery policy. Absent
action grants deny writes; imported identity and repository access supply no write
authority. Configured delivery credentials stay in service memory and are excluded
from the Codex spawn environment, including nonempty exact-value aliases. Adding a
credential already inherited by a running runtime holds activation until restart.
Host-permitted reads and the existing login boundary remain accepted limitations.

Each project chooses reviewable PR (default) or through-merge delivery. Reviewable-PR handback waits for settlement; feedback/CI failures wake the
task-scoped project lead, while merge remains operator-owned. Through-merge requires granted authority,
project instructions and actual GitHub requirements. No universal review count is
imposed. Non-code tasks record the requested outcome and evidence; no universal
human acceptance is required beyond configured instructions and permissions.
Assignment completion alone cannot merge, close an issue, complete its task or
remove a workspace.

Stable operation IDs retain exact material and bound caller revisions, including
denied outcomes. Intent commits before an effect. Successful write responses alone
do not establish success: provider readback must prove the exact target. Ambiguous
creates retain uncertainty across restart; a missing marker cannot authorize replay.
Only positively confirmed transient no-effect failures receive up to two retries.

The lead explicitly submits merge or issue closure with its current reviewed result
set. Shared completion checks run with the current action intent transition, excluding
only that lead's current work/turn, its result effect and that callback. Confirmed
merge does not mark Done. A new eligible lead work revision must request completion,
end successfully and pass all existing gates. Operator settlement and final
PR-dependent completion inspect GitHub freshly and revalidate local revisions after
the await. Changed heads invalidate settlement and wake the retained lead. New
comment/review/check identities also wake it; unchanged polls are deduplicated.

Only proven own closure permits the retained lead's completion continuation. The
service obtains a fresh closed-issue snapshot before open-only source reconciliation;
merge attribution requires the exact PR in GitHub's latest ClosedEvent. Current
label readiness and repository-selection proof must still hold. Field/search cases
without that proof, independent holds and changed source text remain held. Explicit
issue closure requires observed open before the effect; a concurrent independent
closure between that read and write remains an attribution limit.

This implementation has deterministic service/provider/operator coverage. The bounded
real GitHub/Codex/browser handback and through-merge journeys and cleanup are
qualified in the [S07a evidence inventory](evidence/s07a-github-delivery.md);
its original limits and failed checkpoints remain visible. The native UI gate
#736 is closed/completed. [S07b](evidence/s07b-release-candidate.md) assembles
the candidate inventory and deterministic production-provider/UI integration;
physical sleep/wake, final operations and cutover remain separate gates.

On startup, after complete provider/source reconciliation and before scheduler
admission, a queued inbox request may receive one durable fresh generation when
only provider-derived task versions changed. The exact ready intent must never
have been admitted; captured source identity/digest, assignment/instruction/profile
revisions, immutable task-control command receipts and nonderived policy/repository snapshots must match. Independent
Stop/ownership, unfinished execution, effect or recovery evidence prevents this
supersession. The old captured request/context material remains immutable and historical, with an
explicit old-to-new receipt; retirement is not a successful terminal. Legacy
requests lacking the required anchor fail closed. Held or admitted work still
requires its existing recovery path.

## Review checkpoint

The [standalone design](design/standalone.md), [acceptance plan](acceptance.md)
and delivery sequence were reviewed with Chris on 27 September 2026.
[GitHub issues](https://github.com/chrisbanes/ensemble/issues/649) now own delivery scope,
sequencing, dependencies and slice completion criteria.
The shared product understanding, including the 28 September S01 reset and
routing/accountability amendment, is confirmed.
Codex protocol qualification, service lifecycle, authentication, scheduling
fairness and concrete schema/lifecycle contracts still need design and evidence. Historical
BB failures motivate the new proof cases; they do not establish that standalone
execution already satisfies them.

## React foundation implementation status

Delivery [UI02 #740](https://github.com/chrisbanes/ensemble/issues/740) adds the
staged React `/app` shell, same-origin validated APIs, existing session/security
boundary, durable command receipts and retained-control navigation. Its scope
and evidence are recorded in the [foundation contract](design/ui02-foundation.md)
and [foundation evidence](evidence/ui02-foundation.md).

This delivery name is distinct from the existing **UI02 native-question runtime
acceptance scenario**. That scenario remains unproved; no native availability is
claimed. Delivery [UI03 #741](https://github.com/chrisbanes/ensemble/issues/741)
adds attention overview, shared List/Board and atomic local composer, with
[contract](design/ui03-tasks.md) and [service/browser evidence](evidence/ui03-tasks.md).
UI01/UI04–UI07 screens and runtime-question integration retain their own
qualified evidence; parent #736 is closed/completed as of 4 October 2026. Existing controls stay available. This
foundation does not authorize deployment or cutover.

Delivery [UI06 #744](https://github.com/chrisbanes/ensemble/issues/744) implements the [configuration/recovery presentation contract](design/ui06-configuration.md), retaining exact private editors and operational destinations. Production-bundle integration is qualified with disposable SQLite and deterministic runtime/provider fixtures; this does not replace live-runtime, provider or release evidence.

Delivery [UI08 #765](https://github.com/chrisbanes/ensemble/issues/765) provides
the shared owned shadcn/ui source and semantic tokens across the React shell,
configuration/recovery screens and retained production HTML. See the [UI08
contract](design/ui08-foundation.md) and [fixture evidence](evidence/ui08-foundation.md).
It changes presentation only; it does not add task-detail, search, or Inbox
capabilities, and it does not qualify the web-disabled diagnostic fallback for
production visual parity.
