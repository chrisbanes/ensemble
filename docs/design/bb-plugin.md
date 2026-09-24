# BB plugin technical design

Status: proposal for review. ADR-1001 records the accepted product direction;
this document proposes implementation contracts. No additional implementation is
authorized by this document. Read with [SPEC](../SPEC.md),
[acceptance plan](../acceptance.md), and [delivery tickets](../delivery.md).

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
| Task | ID, project ID, title/body, work status, version, current owner assignment; local or external origin |
| External item | Provider instance and stable item ID, canonical task ID, authoritative content/version; unique across the installation |
| Source membership | Source configuration ID, external item ID, current membership and observed time; unique pair |
| Assignment | ID, task ID, parent assignment or project-lead reference, requested outcome, profile revision, instruction/policy snapshot, result revision, state/version |
| Conversation binding | Assignment or project lead, generation, BB thread ID, observed status; at most one current generation |
| Workspace binding | Task/assignment, BB environment ID, repository scope, writer reservation and retention reason |
| Launch intent | Assignment/generation, selected execution settings, stable operation ID, pending/uncertain/confirmed outcome, BB reference |
| Result | Assignment/generation, operation ID, summary, artifact references, outcome; immutable accepted revision |
| Delivery | Recipient, event ID, payload reference, sequence, pending/submitted/acknowledged/uncertain state; unique recipient/event |
| Human request | Request ID, assignment, question or approval, action/material digest, state, response and responder |
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

Proposed task work statuses: queued, active, waiting, done, canceled. External
provider status is displayed separately, including GitHub Project fields by source.
These are product statuses, not mandatory development stages.

Assignment states describe execution coordination:

- queued: persisted and eligible for admission;
- starting: intent recorded, launch not yet confirmed;
- active: current conversation is doing work;
- waiting: a durable dependency, human request, or external event is outstanding;
- completed: accepted result recorded;
- failed: confirmed execution failure with no accepted result;
- canceled: cancellation confirmed.

Uncertainty is an explicit hold reason attached to the affected operation. It is
not a successful failure/retry signal. Execution status remains separately visible.
A process exiting or a thread disappearing must not mark an assignment completed.

A project lead receives a compact task snapshot and pending events, chooses work,
and requests an owner assignment. A task owner may implement directly or delegate
to configured profiles. Ready admission authorizes that work without a mandatory
plan approval; changed scope or missing authority requires operator input. No built-in planner/reviewer/adjudicator pipeline. Review
references an immutable commit or artifact revision, and its findings are prose.

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
| Claim task | Project lead | Atomic owner assignment; conflicting claim returns conflict; claiming alone does not reserve a writer |
| Delegate | Current owner/authorized parent assignment | Child assignment plus launch intent; same operation ID and payload returns same assignment |
| Report result | Bound current assignment conversation | Immutable result plus recipient delivery in one transaction; conflicting retry is rejected |
| Read/acknowledge inbox | Bound recipient | Ordered durable events; acknowledgement by event ID is idempotent |
| Ask/respond | Agent asks; operator answers | Persist request/response and queue recipient continuation; approval scope is explicit |
| Pause/resume/stop | Operator | Persist requested state; stop succeeds only after BB confirms termination |
| Reconcile | Runtime/operator | Read external truth, update observed outcomes; never manufacture success |

Input conflict, stale version, unavailable capability, denied action, uncertain
outcome, and missing record have distinct typed errors with actionable messages.
Do not expose raw stack traces, credentials, or full provider payloads in the UI.

## 5. Launch and continuation protocol

1. Validate caller, task ownership, current policy, profile and workspace choice.
2. In a transaction, persist assignment and launch intent; reserve a writer only for execution
   that needs to mutate the task workspace, not for waiting ownership.
3. Spawn via `bb.sdk.threads.spawn`, supplying provider/model/reasoning/tier,
   permissions, environment and a readable title. Tag with assignment/generation.
4. Store confirmed thread identity. Query current state immediately to catch an
   event that arrived before attachment; then subscribe to lifecycle events.
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
and acknowledges event IDs; commands caused by them retain stable operation IDs.

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
hold for attention. Uncertain launches and external effects require reconciliation,
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

Installed evidence: BB 0.43.4 with SDK 0.5.9 loads the prototype; source-only type
checks against newer SDKs did not establish installed compatibility. User reported
successful live delegation. Real restart, result wakeups, permissions and task UI
are not yet proven. Pin the tested BB artifact and SDK in integration CI.

T01 must exercise the actual plugin loader and BB database driver, a scripted
provider, environment provisioning, restart and message recovery. Use public APIs;
any necessary BB change gets a separate dependency ticket. Do not import internal
modules or accumulate runtime-version branches to get a green test.

The existing Haze prototype remains an experiment. Production code is built and
tested in an isolated BB instance/data directory. Upgrade the installed plugin
only after acceptance and operator review; account for the local-path installation
before changing entry points or triggering reloads.
