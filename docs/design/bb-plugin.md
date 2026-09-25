# BB plugin technical design

Status: proposal for review. ADR-1001 records the accepted product direction;
this document proposes implementation contracts. No additional implementation is
authorized by this document. Read with [SPEC](../SPEC.md),
[acceptance plan](../acceptance.md), and [delivery tickets](../delivery.md).

Related research: [Bots Sidebar patterns and reuse limits](../bb-bots-sidebar-research.md).
Conversation binding and navigation are candidate patterns. Persistent bot
identities, personal bot state and a bot management UI are outside the accepted
product scope.

## Design entry point

The [local-task journey](../SPEC.md#first-local-task-journey) is the first delivery
unit: configure a project and profiles, admit a local task, run its owner and any
delegates, surface results/questions, and preserve the outcome. The operator
navigates projects and tasks; reusable profiles live in configuration.

The implementation follows that model: project configuration selects profiles,
tasks retain ownership and assignments, and the execution adapter binds those
assignments to BB conversations. GitHub sync later supplies external references
and observations to the same tasks. Recovery records below support these actions;
they introduce no additional workflow stages or bot entities.

## 1. Architecture and ownership

One BB plugin with a server entry and a UI entry, using the published plugin SDK.
Ordinary modules inside one package; no independent daemon, workflow language,
message broker, runtime-provider framework, or Taskboard dependency.

| Module | Owns | Uses |
| --- | --- | --- |
| Project configuration | BB project reference, instructions, profile revisions, dispatch settings | BB project/provider/environment catalogs |
| Tasks | Local content, external references and source membership, accountable owner | Plugin SQLite |
| Coordination | Assignments, requests, results, continuations, writer reservations | Tasks, execution adapter |
| Execution adapter | Translation to BB threads/environments and observed lifecycle | Public BB SDK only |
| Sources | Discovery, normalized observations, confirmed provider writes | GitHub adapter initially |
| Operator interface | Project/task views, settings, questions, execution controls | Typed plugin RPC and invalidation events |

BB owns provider processes, transcripts, workspaces and provider interactions.
Ensemble stores references and observations, not a competing process scheduler.
BB status `idle` means no active turn; it does not establish assignment completion.
A recorded result does not establish task completion or external publication.

## 2. Persistent records and invariants

Use BB's plugin-owned SQLite database with ordered migrations. The prototype
schema is disposable; export any wanted experimental records before replacement.
No silent migration or reset of the installed Haze prototype.

| Record | Minimum fields and constraints |
| --- | --- |
| Project configuration | BB project ID, enabled/paused, instruction revision, allowed profile IDs, cleanup mode, policy revision |
| Profile revision | Stable profile ID, immutable revision, provider/model/reasoning/tier, instructions, allowed capability set, environment strategy |
| Task | ID, project ID, title/body, work status, readiness provenance, control revision, holds, version, current owner assignment; local or external origin |
| External item | Provider instance and stable item ID, canonical task ID, authoritative content/version; unique across the installation |
| Source membership | Source configuration ID, external item ID, current membership and observed time; unique pair |
| Task dependency | Dependent task ID, blocker task ID or external issue reference, owning authority, confirmed blocker state and observation time; unique dependent/blocker/authority |
| Assignment | ID, task ID, parent assignment or project-lead reference, requested outcome, profile revision, instruction/policy snapshot, lifecycle/version, work revision, dependencies and holds |
| Conversation binding | Assignment or project lead, generation, BB thread ID, observed status; at most one current generation |
| Workspace binding | Task/assignment, BB environment ID, repository scope, writer reservation and retention reason |
| Launch intent | Assignment/generation, selected execution settings, stable operation ID, pending/uncertain/confirmed outcome, BB reference |
| Result | Assignment/work revision/generation, operation ID, summary, artifact references, outcome; immutable accepted result per work revision |
| Delivery | Recipient assignment, event ID, payload reference, sequence, processing acknowledgement, recorded disposition and caused-operation references; unique recipient/event; transport attempt/BB message identity recorded separately |
| Human request | Request ID, assignment, question or approval, action/material digest, state, response and responder |
| Command receipt | Actor scope, operation ID, command kind, canonical payload digest, pending/confirmed/failed/uncertain outcome and result reference; unique scope/operation |
| External action | Operation ID, resource/action, approved scope, provider reference, pending/confirmed/failed/uncertain |

Use foreign keys and transactions for task ownership, result plus notification,
request plus response, and writer admission. Never hold a database transaction
open across a BB/provider call. Validate RPC/tool inputs and provider observations;
reject stale versions instead of last-write-wins coordination updates.

Profiles are shared installation-level configuration selected by each project;
project instructions provide project-specific context. Assignments are durable work, and threads are
conversations. Concurrent assignments can use the same profile. Store an immutable
profile snapshot per launch, so changing a profile cannot silently reinterpret
historical work. New assignments use current revisions; existing assignments
retain theirs across follow-ups and replacement conversations until the operator
explicitly applies an update for their next turn. Recheck current permissions.

## 3. States and agent-led process

The following is the proposed technical contract for the accepted product policy.
It describes coordination, not development stages.

### Separate durable work from observed execution

| Concern | Stored meaning |
| --- | --- |
| Task work status | `queued`, `active`, `waiting`, `done`, or `canceled`; an outcome decision, never inferred from a process exit |
| Readiness | Explicit admission decision with provenance, independent of source membership and work status; unready tasks can remain queued |
| Task dependency | Separate task-level execution gate; Ready remains true while any blocker is open or its state is unknown |
| Assignment lifecycle | `open`, `completed`, or `canceled`; open assignments can execute, wait, or be held |
| Conversation generation | Current BB conversation binding; increment only when replacing a conversation, not for ordinary follow-ups |
| Execution observation | BB thread/turn identity, observed running/idle/stopping/error state, and observation time; unavailable observations mean unknown, not stopped |
| Hold reasons | Durable blockers such as operator stop, withdrawn admission, material scope change, exhausted retries, or uncertain effect; multiple reasons can coexist |
| Pending continuation | Durable event addressed to an assignment, eligible only after all applicable holds and dependencies clear |

`completed` closes one assignment's requested work. A task owner remains open
while coordinating children or waiting for PR feedback; intermediate updates are
progress records, not a terminal result. Follow-up on the same piece of work reopens the assignment, increments its work
revision and records the new request while retaining previous immutable results.
Reuse its conversation when available; conversation generation changes only if
the conversation itself must be replaced. Distinct work may still use a new assignment. Neither conversation archival nor a completed
child automatically completes the task. Explicit task cancellation is separate
from stop; cancellation UI/command details remain outside this contract review.

### Transitions and invariants

| Trigger | Atomic local change | External consequence |
| --- | --- | --- |
| Claim admitted task | Compare current task version; create one open owner and bind task to it | Queue initial owner work; no writer reservation merely for ownership |
| Delegate | Validate current owner/parent and scope; persist child and initial continuation | Child runs when dependencies and dispatch admission permit |
| Wait for child or human | Persist dependency/request; retain owner identity | Owner yields its turn; no synchronous wait occupying BB capacity |
| Report terminal child result | Validate assignment/work revision/generation; persist immutable result, close current work revision, enqueue parent event | Eligible parent is notified; execution cessation must still be observed before releasing a writer |
| Reopen assignment | Authorized owner/operator records follow-up request and increments work revision under expected version; preserve earlier results | Reuse conversation when possible; apply normal dispatch and hold checks |
| Stop task | Persist stop hold and control revision before any stop call | Stop all active task conversations; reconcile uncertain launches and hold queued work |
| Resume task | Clear only operator stop hold after checking execution and current policy | Recheck eligible work; other holds remain; completed children are not rerun |
| Complete task | Record outcome/evidence and completion conditions under expected version | External closure, merge and cleanup retain separate checked operations |

A completion command cannot silently abandon active children, unresolved effects,
or pending human decisions. Reconcile or explicitly dispose of those obligations
before recording final delivery. Retain the outcome and all assignment history.

Project pause is a dispatch control, not an assignment result. It prevents new
turns while active turns finish; incoming results/responses remain durable.
Delegation from an active turn may record queued work but cannot start a new turn
while paused. A stopped task rejects new delegation until resumed. A result that
races with stop is retained, but cannot clear the hold or wake a stopped task.

On every dispatch, recheck project pause, task dependencies, task holds, current
generation, current permissions, and writer admission. Persist a control
revision so a prepared send cannot bypass a later pause, stop or dependency
change. A send already accepted by BB must still pass its dispatch hook when
drained; checking only before `threads.send` is insufficient.
A turn admitted before pause may finish. Stop instead requests its termination.
BB's explicit Send-now override remains outside this enforcement guarantee,
including the task dependency gate; disclose it in the operator UI.

Before claiming a Ready task, require a complete, confirmed dependency view and
no unresolved blocker. A dependency added or changed while a task is active
invalidates queued admission, holds later turns and delegation, and leaves the
current turn to finish safely. Retain owner, pending results and history. Once
the last blocker clears, re-evaluate all other gates and wake eligible work;
dependency resolution does not clear an unrelated pause or stop hold.

### Turn ends without a report

After confirmed turn completion, reconcile whether a result or explicit wait was
recorded for the assignment's current work revision. If neither exists, persist
one reporting-repair intent for that turn and ask the agent to record its outcome
or waiting reason. This follow-up respects pause, stop and BB dispatch controls.
Do not send the prompt while turn status or result acceptance is uncertain.
If the repair turn also ends without a report or wait, hold for attention; do not
start a chain of reporting reminders. The one-prompt allowance survives restart
and is distinct from retries of confirmed transient execution failures. Idle
state, silence and narrative success alone never establish assignment completion.

### Writer ownership

Reserve by task workspace, assignment and conversation generation before a
writing turn can execute. Reserve only when actually admitting writing work;
queued task ownership must not monopolize the worktree. Repeated admission for
the same operation is idempotent. Release only after BB and workspace evidence
establish that the previous writer can no longer mutate it. A result, timeout,
lease expiry or missing event is not that evidence. If a background process or
uncertain launch could still write, retain the reservation and surface the hold.
Read-only review runs against an immutable revision, not a checkout being edited.

An owner that delegates writing must yield and relinquish its confirmed writer
reservation before the child writes. Resuming the owner reacquires admission.
This is scheduling discipline within the accepted BB access boundary, not a
sandbox against arbitrary shell processes or manual BB overrides.

Agents choose planning, implementation, review and revision through instructions.
No lifecycle transition prescribes a reviewer count or development sequence.

## 4. Commands and authorization

Use one application service for UI RPC and agent tools. Tools derive caller thread,
project, and assignment from host context and trusted persisted bindings. Never
accept caller-supplied roles or mutable BB thread metadata as authorization.
Operator actions use the BB operator surface; agents cannot create profiles or
expand policy. Whether BB offers a trustworthy distinction at every entry point
must be proved in T01/T02; the plugin does not claim to secure the BB host API.

| Command | Caller | Effect and retry behaviour |
| --- | --- | --- |
| Create/edit task | Operator; scoped agent capability | Stable operation ID; retries return original result; edits require expected version |
| Add/remove local task dependency | Operator only | Expected dependent-task version; validate scope and cycles; atomically change edge and control revision with a command receipt; matching retries replay, conflicts reject |
| Claim task | Project lead | Atomic owner assignment; conflicting claim returns conflict; claiming alone does not reserve a writer |
| Delegate | Current owner/authorized parent assignment | Child assignment plus launch intent; same operation ID and payload returns same assignment |
| Report result | Bound current assignment conversation and work revision | Immutable result plus recipient delivery in one transaction; conflicting retry is rejected |
| Read/acknowledge inbox | Bound recipient | Ordered durable events; acknowledgement by event ID is idempotent |
| Ask/respond | Agent asks; operator answers | Persist request/response and queue recipient continuation; approval scope is explicit |
| Pause/resume/stop | Operator | Persist requested state; stop succeeds only after BB confirms termination |
| Reconcile | Runtime/operator | Read external truth, update observed outcomes; never manufacture success |

Input conflict, stale version, unavailable capability, denied action, uncertain
outcome, and missing record have distinct typed errors with actionable messages.
Do not expose raw stack traces, credentials, or full provider payloads in the UI.

### Command retry contract

Every mutation carries one stable operation ID for the user's or agent's logical
intent. Claim `(actor scope, operation ID)` atomically with the state change and
record command kind and canonical payload digest. A matching retry returns the
stored outcome; a changed payload returns conflict. An in-flight duplicate returns
pending plus the existing operation reference, never a second external call.
Authenticate every request; replay cannot bypass access checks or start a new
effect under a revoked permission. Keep receipts for the lifetime of retained
coordination history; no automatic TTL in the first release.

Expected versions protect edits from concurrent decisions. A known successful
retry is resolved from its receipt before treating its old expected version as
a new edit. Distinguish accepted intent from confirmed external success in both
UI and tool responses. Reconciliation updates an existing operation's outcome;
it does not mint a new operation ID to evade uncertainty.

## 5. Launch and continuation protocol

1. Validate caller, task ownership, current policy, profile and workspace choice.
2. In a transaction, persist assignment and launch intent without acquiring the
   writer reservation. Acquire writer ownership at effective execution admission,
   composing with BB's limiter. A message waiting behind another plugin must not
   retain a provisional writer reservation. The public admission/release mechanism
   is a proof gate; pre-spawn reservation is not an acceptable substitute.
3. Spawn via `bb.sdk.threads.spawn`, supplying provider/model/reasoning/tier,
   permissions, environment and a readable title. Tag with assignment/generation.
4. Store confirmed thread identity. Query current state immediately to catch an
   event that arrived before attachment. Subscribe before initial reconciliation
   where supported, and reconcile periodically so subscription gaps are recoverable.
5. A lost response leaves the intent uncertain. Reconcile before considering a
   replacement. One matching, validated thread reconnects; zero or multiple
   matches remain held until evidence or an operator decision resolves them.

BB's Tasks plugin provides useful patterns for profile resolution, rich seed
prompts, environment selection, initial state readback and lifecycle observation.
Keep Ensemble's pre-launch intent instead of relying on post-spawn attachment.
The seed includes task content, outcome, scoped workspace, applicable instructions,
relevant prior results, reporting tools and current generation. Treat external
content as quoted task data, never executable policy.

Result persistence and result delivery are separate. A transaction writes the
result and an inbox event for its parent (or lead). The dispatcher sends a compact
wake-up that tells the recipient to read its durable inbox. The recipient reads
events and acknowledges processing separately; reading or
sending a wake-up is not acknowledgement. Commands caused by an event retain
stable operation IDs across retries. Persist the event's processing disposition
and caused-operation references before
acknowledgement. For event-driven commands, persist a stable action identity under
that event before attempting the command; resume returns those same operation
references. Multiple deliberate actions have distinct recorded action identities;
a duplicate wake-up cannot create a fresh processing decision for the same event.
A disposition may explicitly record that no action is needed. Acknowledgement
requires that durable disposition and references, not proof that a still-pending
external effect has completed. The pending operation continues to be reconciled.
An interrupted consumer sees unacknowledged events again. Transport
attempt state is separate from event processing state: a late send response must
never regress an already acknowledged event.

Results arriving during an owner's active turn remain in its durable inbox; do
not steer that turn automatically. The owner may read the inbox voluntarily.
Coalesce pending events into one next-turn wake-up per recipient, retaining
individual event identities and processing acknowledgements. Before sending,
recheck whether any unacknowledged events still need a continuation. Events
arriving during processing remain pending unless explicitly processed; finishing
one batch cannot acknowledge later arrivals implicitly. Use a persisted wake-up
intent to prevent concurrent dispatchers from scheduling duplicate continuations.
An uncertain wake-up remains subject to reconciliation, not a second send merely
because more events arrived.

Do not assume the BB send API is idempotent because it exposes a request ID in a
related API. T01 must prove accepted-message lookup/retry semantics for the pinned
BB version. An ambiguous send is reconciled or held; it is not blindly resubmitted.
Duplicate physical wakeups, where unavoidable, cannot duplicate ownership or
side effects. Repeated wakeups and unacknowledged events are observable.

A waiting assignment yields its turn and execution slot. Results and human replies
wake it after admission. Conversation replacement requires confirmed loss/stop of
the previous writer, a new generation, and reconstructed durable context. Late
results from an old generation are retained as history and cannot advance current
work. Parent/child UI links must not introduce automatic archive/delete cascades
that would discard still-owned work.

### Scope of uncertainty

Hold the uncertain operation and work that depends on its outcome, rather than
freezing the whole task by default. Reconciliation and work established to be
independent may continue. If independence cannot be established, keep the affected
work held. Unknown writer status holds all further writes to that workspace.
Record the affected resource/operation on the hold so clearing it cannot clear
unrelated blockers. This is an execution dependency, not a configured process DAG.

### Restart reconciliation order

1. Load durable pause/stop controls and register dispatch guards before releasing
   Ensemble work. Prove queued BB work cannot bypass guards during plugin startup.
2. Reconcile existing BB conversations, generations, pending launches and writer
   reservations. Missing or ambiguous evidence holds the affected operation.
3. Reconcile pending external effects before resending commands or closing tasks.
4. Restore open human requests and unacknowledged events. Retarget delivery only
   to the validated current conversation; invalidate stale queued destinations.
5. Re-evaluate current permissions, readiness/holds and dependencies, then ask BB
   to recheck eligible queued work. A project resume never clears a task stop. Previously enabled work resumes
   automatically once its reconciliation and admission checks succeed; restart
   does not introduce an additional operator-resume requirement.

Retry counters belong to a logical failed execution, survive restart, and are
shared across automatic retry mechanisms. Limit to two automatic retries total;
do not let a BB retry facility multiply Ensemble retries. Retry only a confirmed
transient failure with a stopped prior execution and reconciled possible effects.
Authentication/configuration errors, task findings and uncertain outcomes are not
transient retries. Backoff timing and provider error classification need pinned
runtime evidence before implementation.

## 6. Workspaces, scheduling, and access

Accepted: one task worktree for repository-changing work in a single-repository
project, shared across its assignments. Only one writer holds it at a time.
A multi-repository task would require a worktree for each participating repository;
this does not imply a separate writing worktree per agent. Parallel read-only reviews use an immutable commit in
separate workspaces where needed; changing the reviewed commit invalidates any
approval tied to it. The first release serializes writing assignments in the task worktree.

Use BB's existing workspace cleanup, configurable per project: retain task
conversations until operator archival, or archive after confirmed delivery and
checking work is preserved. Default to retain-until-archive.
BB supports environment reuse across assignment threads. Its stock worktree
provider retires an environment after its last live thread leaves (normally five
minutes); removal can discard dirty files. Ensemble-initiated archival must check
preserved work and unresolved effects; direct BB archival follows BB's lifecycle.
No per-environment retention override was found in the inspected public SDK.
T01/T02 must verify this contract against the pinned runtime.

Honor BB's Concurrency limit plugin for execution admission. Do not introduce an
Ensemble global default or per-project execution cap in the first release. Use
ordinary BB dispatch so queued work respects the configured limiter. Owners and
leads must yield while waiting for children; prove progress with global capacity
one. Durable ownership and one-writer-per-task admission remain Ensemble concerns.
BB queue ordering is not a guarantee of project fairness; do not claim one.

Retry confirmed transient execution failures at most twice with backoff, then
hold the failed assignment and notify its owner for diagnosis. The owner may do
the work itself or choose a revised approach within scope; changing assignment
identity or reopening the same request must not reset exhausted automatic retries.
A fresh attempt requires a recorded diagnosis and changed approach, or operator
resolution, rather than a blind relaunch. This is not an automatic retry-budget
reset. Uncertain launches and external effects require reconciliation,
not blind retry. Ordinary task problems are handled through agent instructions.
Retry classification and backoff timings remain technical design details.
Flag prolonged inactivity for operator attention; silence alone does not trigger
automatic termination or restart. The inactivity threshold and observable activity
signals remain technical design details.
New projects require explicit enablement. Paused projects receive observations/results
but dispatch no new turns; current turns may finish. A task stop holds queued work
and requests termination of its owner and all active descendants. The hold survives
restart and requires explicit resume; task stop is not task cancellation.
User override through BB's Send-now bypasses its dispatch hook: surface it as a
manual override and do not claim an unbypassable project execution limit.

Accepted access model: one trusted operator on a private BB installation.
Ensemble enforces authorization for its own commands and integration actions.
Agent execution uses BB/provider permissions and environment controls. The UI
must distinguish these controls from project action policy and disclose shell,
ambient credential, and direct BB API access limitations. T02 verifies this
mapping and workspace lifecycle; it does not implement a new sandbox. Revocation
of Ensemble actions is immediate at command admission; stopping agent access
relies on BB/provider termination and observed confirmation.

## 7. GitHub sources and provider writes

Both linked-repository issue selection and GitHub Project membership yield the
same canonical issue identity, including provider instance. Target GitHub.com
initially; Enterprise Server compatibility is deferred. Use native issue-search
and Project-filter syntax for their respective sources, with validation and
preview. GitHub documents Project query support in the
[CLI contract](https://cli.github.com/manual/gh_project_item-list); pin and verify
the actual API/CLI versions used rather than assuming installed capability.
Polling is the accepted initial mechanism, with manual refresh and visible last
success; recheck relevant state before consequential actions. Webhooks are deferred. Periodic reconciliation is required either
way. Exclude PRs and draft items. Page complete selections and retain prior state
on partial failures; bounded recent-item caches are not complete discovery.

Task dependencies are distinct from assignment waits and source selection.
Ensemble owns edges from local dependent tasks to local or imported tasks in the
same project. Only the operator may create or remove these edges, through the
explicit dependency command. The generic task-edit command must not change them,
even for an agent with scoped task-edit permission. Validate the dependent task's
expected version, reject self-edges and cycles, and persist the edge change with
its control revision and operation receipt in one transaction. Matching retries
return the recorded result; stale versions or changed payloads conflict. Retain
the relationship and outcome across restart. A local blocker clears only when
its task is Done; cancellation leaves the dependent held until the operator
changes the edge. No authored edge crosses Ensemble projects.

For imported GitHub dependent issues, read native
[`blocked_by` relationships](https://docs.github.com/en/rest/issues/issue-dependencies) and
the current issue state of each blocker. Retain provider identity and provenance;
an external blocker need not be selected as an Ensemble task. Fetch complete
paginated dependency results and confirm blocker state before dispatch, including
for cross-repository issues; discovery never grants repository execution access.
GitHub issue closure or native edge removal clears that blocker. Reopening or
adding an open blocker re-applies the execution gate. Do not write a parallel
Ensemble edge or provide an override for an imported issue. On inaccessible,
partial or failed reads, including the first dependency-list or blocker-state
read for a newly discovered issue, leave dependency state unknown and hold
dispatch. Never initialize an unfetched issue as unblocked. Keep any last
confirmed view for explanation until a complete refresh succeeds. Polling and
manual refresh re-evaluate blocked Ready tasks, while local state changes
trigger immediate re-evaluation.

Accepted overlap policy: show the conflict and require explicit operator placement.
Retain an existing owner's work; a newly conflicted, unowned issue cannot dispatch.
Never combine project permissions. Transfers of already-owned tasks between
projects are deferred beyond the first release. Initial placement conflict
resolution remains in scope.

On loss of all source memberships, removal of readiness, or external closure,
hold new delegation, retain history and notify the owner to reach a safe stopping
point. Operator resolution is required before resuming, except closure confirmed
as this task's own delivery, which is reconciled against completion criteria.
Incorporate harmless clarification; hold affected work and ask the operator when
an external edit changes the admitted outcome or materially expands scope.

External title/body/issue state remain provider-owned. Project field values retain
source identity. UI edits call the owning integration and show pending/failed/
uncertain states until readback confirms the write. Record intent before comments,
PR creation, or status changes. A matching URL/ID resolves uncertainty only when
resource and operation evidence agree. PR versus through-merge completion is configured per project.
Local tasks never create issues implicitly. Reviewable-PR tasks stay waiting after
handback; CI/review observations produce durable owner wakeups. Merge or explicit
operator acceptance/closure settles them. Through-merge projects additionally
perform the authorized merge when project instructions and actual GitHub merge
requirements are satisfied. Record evidence and check authority; do not add
universal review stages or reviewer counts.

### Authentication and attention integration

Reuse the official BB GitHub plugin and server-side `gh` login. Taskboard provides
an inspected example of status checks through `sdk.plugins.callRpc` and reuse of
BB repository mappings. Verify the public RPCs actually cover each needed
operation; do not assume all Project operations are exposed. Missing scopes or
login block affected integration actions and appear in setup. No second token
store or credential material in task instructions.

Plugin UI toasts and public navigation can surface attention items in-app.
BB's inspected notification history is client-memory state, not durable delivery;
toast actions are not retained in that history. Built-in push handles thread
questions/errors/completion, but exposes no verified arbitrary plugin alert send
API. Keep attention records in Ensemble and reconcile the UI from them. Stable
toast IDs can suppress duplicates while connected; verify reconnect behaviour.
Do not create a custom push service or promise OS delivery for every inbox item.

Evidence inspected on 2026-09-24: BB source commit
`fdd3de3b19b97e6cd1ef7300cbb54711431249d3`, `plugins/github/server.ts`,
`plugins/push-notifications/contract.ts`, and
`apps/app/src/lib/notifications/plugin-toast-recording.ts`; installed BB bundle
corroborates the GitHub authentication path. This is source inspection, not a
live authentication or notification-delivery test.

## 8. BB compatibility and rollout

The isolated T1–T5 harness exercised BB 0.43.4, host plugin SDK 0.5.9, package
SDK 0.5.24, Node 24.21.0, the actual plugin loader and SQLite driver, public RPC,
temporary Git environments, scripted provider turns and automated Chromium. It
records tool-result round trips and persisted state across restart. This is
capability evidence for a disposable fixture, not an implemented Ensemble product
flow or authenticated-provider smoke. The suite checks lockfile tarball integrity
separately from SHA-256 hashes of the installed BB and SDK package trees, and
records the tested source revision and digest; it imports no BB private API.

The T4 diagnostic deliberately fails because BB dispatched an accepted queue row
after both hook owners failed initialization. The aggregate T1–T5 command accepts
only that exact observed #665 diagnosis after checking row identity, one provider
turn, one tool-effect delta, failed plugin status and clean process shutdown. The
report preserves startup as `failed-capability` and keeps T06/T08 blocked. Other
T5 recovery observations are bounded fixture tests; their product gates remain
open. Use public APIs; any necessary BB change gets a separate dependency ticket.

The existing Haze prototype remains an experiment. Production code is built and
tested in an isolated BB instance/data directory. Upgrade the installed plugin
only after acceptance and operator review; account for the local-path installation
before changing entry points or triggering reloads.


### Remaining proof gates for state and recovery

See [BB capability evidence](../bb-capabilities.md) for the pinned T1–T5 live
report. T3 recovered bounded lost spawn/send responses by unique public markers
after restart and observed no second provider effect; zero or multiple matches
remain held, and general idempotency is unproved. Its public stale-generation
delete scenario prevented one queued provider effect but did not prove an atomic
generation interlock. T4 reproduced the startup safety violation and keeps #665
open. T5 exercised wait composition, stop observations, competing intent attempts,
retry across restart, instruction contribution and shared-worktree retention. Each
Other T5 gates remain open because fixture tests do not implement the corresponding
Ensemble ownership, apply or cleanup policy. The delayed-stop probe now records
a failed BB capability: `threads.stop` returned `ok` while the plugin-held thread
remained pending, so the fixture withheld recheck and could not prove safe writer
release. [#676](https://github.com/chrisbanes/ensemble/issues/676) tracks the
unresolved confirmation path. The accepted guarantees remain unchanged.

Inspected SDK 0.5.9 declarations expose `threads.stop`, turn-specific
`threads.retry`, queued-message APIs, and the `message.dispatch` hook with
`recheck`. The stop contract explicitly requires status confirmation; dispatch
hooks cover queue drains and retries, with an explicit Send-now bypass. These
are source-level contracts, not integration test results.

| Gate | Evidence required before dependent feature work | T1–T5 observation | Ticket |
| --- | --- | --- | --- |
| Startup and queued dispatch | Paused/stopped tasks cannot start from BB's persisted queue before plugin guards are installed; startup failure cannot silently release protected work | **Failed capability**: both hook owners failed startup, BB dispatched the accepted row, and one provider turn/tool effect was observed; #665 remains open | T06/T08 blocked |
| Message acceptance and replay | Correlate accepted/queued sends after lost response; invalidate stale-generation queued messages; otherwise expose a recoverable hold instead of blind resend | **Partial**: marker reconciliation and one bounded stale-generation delete were observed; atomic fencing and general idempotency remain open | T01/T07 |
| Composed writer admission | Acquire writer only when BB will execute the turn; other plugin waits, dispatch failure and cancellation cannot strand a reservation; serialize competing writers without pre-spawn ownership | **Open**: T5 observed another-plugin wait and gate release, without an Ensemble writer reservation | T01/T02/T06 |
| Stop and writer release | Confirm termination including delayed starts and relevant workspace processes; safely yield owner writer to child; never infer release from a result alone | **Failed capability** for the plugin-held delayed start: BB returned `ok` to stop but the thread stayed pending; recheck was withheld. Active-turn stop was confirmed; no Ensemble writer release policy was exercised | [#676](https://github.com/chrisbanes/ensemble/issues/676); T02/T06 blocked |
| Initial workspace identity | Bind one task environment before parallel assignment launches; reconcile uncertain provisioning without creating competing task worktrees | **Open**: a test-local SQLite intent chose one thread/environment after restart; two raw parallel BB spawns created separate environments | T01/T02/T06 |
| Retry ownership | Confirm how BB automatic/manual retries interact with Ensemble counters and dispatch policy | **Open**: T5 observed per-turn retry identity/effects across restart; no shared retry ceiling was tested | T01/T08 |
| Revision application | Prove explicit updated instructions reach an existing conversation's next turn, with replacement only when safely required | **Open**: T5 matched dynamic instructions in ordinary next-turn provider requests; no operator apply operation or immutable assignment snapshot exists | T01/T04/T06 |

If a gate cannot be met using public BB APIs, record the precise dependency or
bring back a concrete product limitation for review. A metadata tag, mocked host
or successful typecheck alone does not close a gate.
