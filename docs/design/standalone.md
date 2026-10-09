# Standalone service design

**Product decisions reviewed and confirmed by Chris on 27 September 2026.**
The ownership decision is accepted in [ADR-1004](../adr/1004-standalone-service.md).
Runtime-specific contracts below require bounded evidence before dependent
implementation. The service now implements the S03b scheduler/supervisor slice:
durable request admission, shared writer/capacity limits, bounded Stop, exact
restart-recovery receipts, constrained retries and macOS power-event admission
quarantine. S04b adds durable task-scoped coordination, results/inboxes,
operator-attention interactions, follow-up revisions, lead-gated completion,
bounded routing provenance, and a typed task coordination view. Its deterministic
service contract does not establish the production operator UI. The separate
[disposable Codex probe](../evidence/s04b-live-runtime-2026-09-29.md) qualifies
resumed-thread coordination callbacks for its bounded tested journey only. The
#694 operator scheduling/capacity controls and recovery presentation remain
separate work. #703 implements the authenticated operator UI foundation;
production runtime, coordination, history and recovery views remain unavailable,
and private Tailscale access is unproved. Physical sleep/wake and operational
host-restart qualification also remain separate work. See the
[S04b coordination boundary](s04b-coordination-boundary.md).
[ADR-1005](../adr/1005-service-assignment-routing.md) adds the confirmed 28 September
assignment-routing and project-lead accountability decisions.

## Deferred integration amendment — 1 October 2026

[ADR-1006](../adr/1006-chatgpt-and-native-codex.md) retains optional ChatGPT daily
operations/events and native Codex visibility/handover as post-MVP requirements.
Chris paused X01–X05 on 1 October under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734); explicit reopening
is required before further planning, probes or implementation. The MVP uses the
private web UI and Codex App Server and does not wait for X01–X08. The future plugin
would add a narrow authenticated HTTPS MCP endpoint; runtime access, existing
holds and reviewed cutover remain unchanged. The
[integration design](chatgpt-and-native-codex.md) preserves the feasibility gaps.

## Confirmed review decisions

- Use Codex first, with the existing operator login; Claude and API-key billing
  for agent execution are deferred. Separately configured TypeSafe API access is
  permitted for projects that explicitly enable assignment routing. Qualify Codex App Server as the integration surface.
- Do not silently switch authentication or add API billing if unattended use fails.
- Deliver the first deployment on Chris's Mac; Linux qualification follows later.
- Serve a web operator interface with private remote access from Chris's own devices
  over Tailscale, with a separate authenticated Ensemble operator session.
- The 28 September amendment permits admitted execution to survive crashes and
  makes Stop best-effort. Uncertain ownership remains held until independently resolved.
- Normal successful final turns permit cooperative handoff under the specification;
  detached-child overlap is an accepted limit, not physical writer exclusion.
- Use the explicit default execution policy below. Strict outside-read denial and
  complete descendant containment are separate product/deployment decisions.
- Enforce both an installation-wide active-turn cap and per-project caps. Waiting
  assignments yield slots. Defaults are four active turns globally and two per
  project, editable by the operator.
- Hold a macOS sleep assertion only while execution is active. Release it when
  idle; forced sleep/wake requires reconciliation before more dispatch.
- Task discussion uses durable messages for the next eligible turn, with history
  visible in the web UI. Live steering is deferred; stop remains separate.
- Start with a fresh standalone database. Preserve the prototype separately;
  no historical import or automatic old-assignment resumption is required.

The S03b service applies global and per-project caps when admitting direct,
command-line and managed task turns through the same transaction. Capacity waits
do not retain writer ownership. A lower configured limit blocks new admission
without interrupting active work. Retry is narrower than ordinary failure
handling: only positively identified transient terminal failures with known
shared retry usage and settled effects can release an exact old generation and
queue a bounded, newly admitted turn. All unresolved or unsupported evidence
retains its holds.

## Components and ownership

Use ordinary TypeScript modules in one service, with SQLite as the durable source
of truth. Do not introduce a message broker, microservices or a generic runtime
plugin system without a concrete need.

| Component | Responsibility |
| --- | --- |
| Core | Projects, tasks, assignments, instructions, permissions, command receipts, results and human requests |
| Scheduler | Durable pending turns, eligibility, capacity, retry allowances and wakeups |
| Assignment routing | Direct TypeSafe calls for unspecified assignees, eligible profile candidates, revision-bound recommendations and lead fallback |
| Execution supervisor | Runtime process/session identity, launch admission, observation, cancellation and restart reconciliation |
| Workspace manager | Task worktrees, provisioning recovery, writer ownership, preservation and cleanup |
| Runtime integration | Validated execution settings, agent tool calls, transcripts, provider events and conversation resume where supported |
| Operator API/UI | Trusted operator commands, project/task views, conversations, attention inbox and persisted control outcomes |
| GitHub integration | Discovery, source identity, complete dependency reads, authorized writes and reconciliation |

The runtime integration supplies agent execution, not project scheduling or an
independently draining queue. “Build ourselves” covers the coordination product;
model interaction and agent tools use Codex. Qualify its App Server protocol in
S01 rather than assuming documented operations satisfy Ensemble's guarantees.

## Accountability and assignment routing

The project lead is accountable for task outcomes, with separate per-task
conversations using the same lead profile. Assignees perform assignments; there
is no separate task-owner role. Lead task conversations need durable, task-scoped
execution identities, recipients and control bindings without an operator-managed
owner record. Establish the concrete schema after S01, including lead turns in
normal capacity, stop, recovery and writer protocols.

The service may create the initial assignment from an eligible task's requested
outcome and route it without waking the lead. Explicit permitted assignees bypass
routing. Disabled routing and unavailable/uncertain routing use lead allocation;
worker results do not bypass the lead's task-completion decision. Nested results
return to the delegator, initial results to the task-scoped lead conversation.
The [assignment-routing design](assignment-routing.md) owns the detailed routing
boundary. Keep this an ordinary service module, not another execution runtime or
an agent-driven PA workflow.

## Dispatch and failure boundary

Persist an execution intent with a stable operation identity, assignment/work
revision and instruction/profile revision before any launch. Recheck readiness,
dependencies, all holds and current permissions at effective admission. Reserve
capacity and writer ownership consistently with that admission. A launch refusal
known to occur before submission can remain pending; ambiguous submission stays
uncertain until reconciled. Do not copy the prototype's two-method `WorkerHost`
interface into a broader API before the first runtime establishes the needed contract.

A queued intent cannot execute independently of a healthy Ensemble admission path.
The supervisor must serialize admission with pause/stop and reject obsolete work
revisions. Define the exact point that separates an active turn from queued work,
and prove pause/stop races on either side. Checking an enabled flag and then
asynchronously spawning is not sufficient proof.

Already-admitted execution may survive coordinator or App Server death. Persist
runtime/thread/turn and generation identities; preserve writer/capacity holds when
observations or submission acceptance are uncertain. Reattach only when the same
live execution is uniquely identified. Stored history and conversation resume do
not prove that capability. Unsupported live reattachment leads to visible uncertainty
and operator recovery, not a universal S01 failure or blind replay. No queued work
may gain admission while Ensemble is unavailable.

On startup, restore holds and reconcile execution/writer ownership before enabling
dispatch. Automatically resume previously enabled, now-eligible standalone work
after successful reconciliation; no extra enable action is required. Existing
project pauses and task stops remain in force, and old BB assignments are excluded. Failure of policy/storage initialization keeps pending work held. Lost
responses and missing observations never authorize blind replay. Stale reports
remain historical and cannot complete a newer assignment revision.

## Workspace, results and operator boundary

Persist workspace provisioning intent before creating worktrees; reconcile partial
creation and concurrent requests to one task binding. Keep writer ownership across
uncertain execution. A database lease coordinates admissions, not an old process's
filesystem writes. Normal success uses the specification's cooperative handoff;
all other holds require independent resolution. Retention is independent of
conversation lifetime.

Commit a result and its recipient's inbox event together. Deliver one logical
continuation for pending events, preserving individual acknowledgement and work
revision checks. Recipients include task-scoped lead conversations and delegating assignments;
record the destination explicitly rather than inferring it from transcript text.
Human answers use the same durable mechanism; approval additionally
binds exact reviewed action/material. Recheck permissions when executing an action.

The UI calls validated core commands. Runtime tool callers receive a binding created
by Ensemble, not authority inferred from their payload. Define operator access,
secret handling and the selected runtime's filesystem/network controls before remote
exposure or execution-access claims. Single-operator does not mean unauthenticated
network access. No new project security sandbox is implied by service ownership.

## Runtime trust boundary

Chris approved this boundary on 28 September 2026 after the S01 investigation
expanded from bounded integration into exhaustive execution-observation proof.

Ensemble trusts Codex's successful terminal turn status for its bound thread/turn
as the runtime's normal-completion report. Ensemble persists that report, waits
for its own registered callbacks to end, checks other holds and known unfinished
execution, and serializes writer/capacity release with successor admission.
An existing crash, Stop or uncertainty hold cannot be cleared by a late terminal
report; the separate recovery procedure still applies.

Ensemble owns durable admission, identity/generation checks, callback authorization,
results, cancellation requests and uncertainty holds. Codex owns its built-in
tool execution and reports its lifecycle. Runtime/deployment controls provide
execution restrictions; Ensemble must select the approved policy and enforce
permissions on its own tools and integrations. It must not call the unsandboxed
`thread/shellCommand` route for task execution.

Detailed tool items and stored history are diagnostic evidence, not an exhaustive
ledger of all effects or an independent termination proof. Missing diagnostic
items alone do not block normal handoff; a known unfinished action, conflicting
terminal report, missing terminal identity/status or unfinished Ensemble callback
does. This explicitly accepts incomplete observation, possible unobserved effects
and overlapping writers after normal success, including detached children. It
does not establish the policy or audit trail of an unobserved action.

S01 does not require a general model-tool allowlist or qualification of every
tool class. An untested surface is a recorded coverage gap; a demonstrated breach
of the selected policy blocks the affected capability. Ordinary file-edit and
broader enabled-tool policy checks belong to S02–S05 integration. Keep the earlier
unexplained file effect as a diagnostic finding, without relabelling it a pass or
making its explanation a prerequisite for all implementation.

## Runtime retention and durable safety evidence

The Codex adapter separates operational object lifetime from safety-evidence
lifetime. Bounded memory may retire settled payloads; it never makes an old turn
successful, a replay fresh, an unresolved execution safe, or a retained hold
releasable. SQLite is authoritative for decisions that must survive cache eviction
or service restart. These rules govern the current Codex adapter and do not add a
second reply authority or a disk-history deletion policy.

Before a terminal can resolve `waitForTurn()` or permit the service's normal
completion path, persist its exact `(threadId, turnId)` decision in
`runtime_terminal_evidence`. The key is independent of runtime generation so a
current child reporting the same bound identity can still conflict with an earlier
report; generation remains diagnostic and old-child messages are rejected before
they reach this evidence path. Retain the first observed `completed` or `failed`
status, a sticky conflict flag, the exact associated `workId` when known, and the
first/last generation and observation time. A same-status duplicate preserves the
first observation. An opposite status atomically marks the identity conflicted and
uses the existing anomaly/retraction path; no later status can overwrite that
conflict with success. The execution binding must be exact and unambiguous before
a terminal can authorize completion or retraction of work and successors.

Older execution rows without a terminal receipt migrate to an explicit unknown
receipt; their execution state does not prove which terminal status was observed.
A missing, unknown, corrupt, ambiguous or unreadable receipt, or a failed write,
does not authorize completion. Preserve the existing hold and report a bounded
failure. A valid current-child terminal that arrives before its `turn/start`
response may be stored without a work binding, but it has no completion authority
until the exact binding is established. Reconcile that same identity when binding
arrives. Do not treat an absent row or an evicted cache entry as evidence that an
identity is new.

Native request and reply facts extend the existing
`coordination_runtime_questions` record. Its exact endpoint identity, request
digest, qualification snapshot, answer, reply intent and ordered final/uncertain
outcome remain the sole durable reply history. Backfilled identity fields retain
runtime generation, thread, turn, item and the RPC identifier's JSON type and
value, so numeric and string IDs remain distinct. Exact endpoint lookups use the
existing endpoint key; ambiguity among reused typed IDs is held rather than guessed.
Pending-answer and per-work queries are indexed for background dispatch and
cancellation. `CoordinationStore.beginRuntimeReply()` remains the only transaction
that records reply intent before stdin write; no parallel native-reply ledger is
introduced. A missing or inconsistent expected row, failed before-write intent,
or uncertain post-write outcome does not create another answer opportunity or
permit a retry.

Keep a callable native endpoint and raw readback only while the current turn,
callback, reply write or other operational owner needs them. Pending, writing,
sent-unconfirmed and uncertain replies stay pinned until matching resolution and
callback processing end, or a durable unavailable/uncertain outcome records the
limitation. The existing single identical replay remains available only for its
active same-child request. After retirement, an unchanged, changed, reused-ID or
old-generation request is checked against durable identity and digest; it cannot
become a fresh prompt or a second reply. Direct active indexes by exact endpoint,
generation/thread/typed RPC ID and thread/turn serve cancellation and replay
matching without scans over settled endpoint payloads.

Persist each resumable thread's exact registered tool-definition digest and its
first successfully qualified runtime version/hash, provider, model, effort, tier
and developer-instruction digest. Never replace that baseline with current values.
On resume, missing legacy facts or changed tool/settings readback withholds native
qualification and retains the existing hold; current settings do not prove what a
prior thread used. Other per-thread and per-turn maps are retired only after their
last consumer has recorded its required durable disposition.

The initial settled-cache budgets are 256 terminal entries/64 KiB, up to 16
retired native entries/512 KiB if a payload cache is needed, and 128 thread
qualification/tool entries/256 KiB. Account for count and actual UTF-8 key/value
payload bytes together; zero settled native payload cache is acceptable when
indexed lookups meet measured bounds. Report active pins separately and tie each
to its actual callback, reply, turn or held-work owner. Eviction affects only
settled memory. Do not prune durable evidence by age, add a force-unlock path, or
claim that retained execution holds are resolved by cache retirement.

Use exact indexed lookups or bounded cursor reads for durable evidence. Do not
populate runtime caches from a full history load at service start. Existing
execution-state reconciliation may still traverse the records it needs to restore
workspace normalization and holds; any such traversal remains distinct from a
terminal/native cache fill and must preserve its current hold checks. Prove the
retention budgets, cold indexed lookup, direct cancellation and memory deltas with
deterministic real-SQLite fixtures. These workload measurements establish the
tested bounds only, not a universal latency or heap guarantee.

## Default execution policy

Select supported App Server `workspaceWrite` controls with task working directory
and explicit task writable roots, `networkAccess: false`, and `approvalPolicy: never`.
Retain full read access: use `readOnlyAccess: { type: "fullAccess" }` where supported,
or the verified broad-read default on versions without that field. Do not send an
unsupported field or require a named profile for equivalent default read behavior.
Verify installed field names and effective settings on start, follow-up and resume;
pin any experimental surface used. Deny
broader command access rather than auto-approving escalation. A policy change needs
separate operator approval and fresh admission. Do not inherit `dangerFullAccess`
as a fallback or change shared configuration/login to make a probe pass.

The [approved S01 evidence amendment](https://github.com/chrisbanes/ensemble/issues/688)
accepts unproved model-originated escalation rejection for feasibility only. S02
must implement and deterministically test the runtime adapter's rejection of any
unexpected approval callback without granting permissions or broadening policy.
S05 qualifies the integrated approval flow before release. These checks preserve
the denial requirement; an adapter fixture cannot prove Codex's internal rejection.

This limits command writes, not reads outside the workspace. Inventory effective
temporary write roots and protected paths; do not advertise task-root-only writes
without checking them. Host-readable files, inherited environment and credentials
may remain accessible. Command network controls do not establish a boundary for
Ensemble integrations, MCP/app tools, model transport or web tools; inventory those
surfaces and their permissions separately. Ensemble enforces policy in its own
tools, without claiming to sandbox all ambient shell/API access.

The [App Server protocol](https://learn.chatgpt.com/docs/app-server) documents these
controls, events, stored-thread resume and cancellation requests. The
[security guide](https://learn.chatgpt.com/docs/agent-approvals-security) distinguishes
sandbox, approval and network controls. [Named permission profiles](https://learn.chatgpt.com/docs/permissions)
are an optional beta surface, not required by S01. Restricted reads or stronger OS
containment require a separate decision and qualification. Documentation support is
not evidence that the installed authenticated configuration applied a policy.

## Operator recovery of uncertain execution

1. Keep affected dispatch held. Show the assignment/generation, submission receipt,
   last known thread/turn and process identities, last observations, pending effects
   and the reason for uncertainty. Preserve files and evidence; independent work can
   proceed only after independence is established.
2. Attempt read-only reconciliation of the uniquely identified execution and its
   effects. If live reattachment is unsupported or inconclusive, retain the hold.
   A historical successful turn cannot erase a crash or Stop hold.
3. Request cancellation of identified owned execution, observe for a recorded bounded
   interval and have the operator terminate identified survivors using host controls.
   Release requires independent evidence that the old execution and relevant
   descendants can no longer write, not a missing PID or empty terminal list. When
   process cleanup cannot establish that boundary, the fallback is an operator host
   restart with dispatch held: verify a new host boot and that old execution is not
   restarted before reconciliation. This is a recovery procedure to qualify, not
   authorization to reboot during S01 or this documentation change.
4. Reconcile partial workspace changes and uncertain external effects separately;
   host restart does not undo or settle remote actions. Persist the resolution
   evidence and reconcile writer/capacity ownership atomically. Explicit resume
   clears an operator Stop only; every other admission check still applies.

If resolution cannot be established, ownership and capacity remain held indefinitely.
There is no force unlock, timer-only release or operator-acknowledgement waiver.
S01 records this route and probes durable holds; S03/S05 qualify the implemented
recovery controls. Any different release guarantee requires a concrete new decision.

## Reuse and transition

Reuse `src/core` behavior and real-SQLite tests where it fits. The current service
still authorizes through external host project/conversation bindings, and the
coordinator models only spawn/find. Those seams require deliberate replacement;
compiling without BB is not standalone product delivery. Preserve task/assignment
identity, captured instructions, results and conservative uncertainty handling.

The BB adapter, manifest, dependencies, scripts and CI jobs have been removed.
S02 still needs the standalone bootstrap and runtime integration. Retain historical
documentation and Git history rather than relabeling BB tests as standalone proof. Reconcile against the
latest main, including CB-19's local-refusal repair if it lands; do not overwrite
concurrent work from this planning checkout.

Use a fresh standalone database; historical import is outside the first release.
Do not attach its scheduler to the prototype database. Preserve the installed Haze
prototype separately and explicitly settle or retire old active work before the
reviewed cutover; never run competing writers against the same task workspace.

## Decisions needed before dependent implementation

- Codex App Server launch/tool identity, transcript, resume and stop contracts;
  existing-login behavior under the macOS service account and restart.
- macOS service lifecycle, effective execution policy and operator recovery controls;
  stronger process/read isolation only if separately selected.
- Effective-admission transaction/supervisor protocol and restart reconciliation.
- Runtime/release qualification of the separate authenticated operator session
  and private Tailscale transport. S04d adds the production runtime and
  coordination operator routes on top of the [S04c](s04c-operator-ui.md)
  login/CSRF/Origin boundary. The bounded operator journey is recorded in
  [S04d evidence](../evidence/s04d-operator-2026-09-30.md); private Serve proof
  remains unproved and is not deployment or cutover authorization.
- Fairness under the selected caps, retry classification and inactivity thresholds.
- Routing persistence, task-scoped lead execution identities, candidate validation,
  confidence criteria and separate API timeout/retry budgets; see the routing design.
- Final schema qualification and old-work retirement/cutover; S08a backup/restore
  is bounded to the currently supported standalone database schema.

Codex on macOS is the selected first combination. Additional platforms are separate
qualification work, not an assumed first-release matrix. Resolve these through
bounded proofs and review; no framework or dependency selection is implied here.

## S08a operations and backup/restore boundary

`StandaloneDataDirectory` owns the shared marker and exclusive SQLite owner
lock used by both `StandaloneService` and offline operations. The separate
`npm run operations` CLI never starts Codex, the scheduler or the operator HTTP
server. Backup uses Node's SQLite backup API (qualified on Node 24.21.0 and
26.9.0) to reserve a new private snapshot directory, verify the whole database, and write a strict manifest as
the final commit marker. The manifest binds the supported schema version and
fingerprint, SQLite file digest, deterministic typed logical-content digest,
and source marker, and records the creating Node version as provenance. Restore reserves a distinct nonexistent data directory,
creates `.ensemble-restore-incomplete` immediately, verifies the copied
database, writes a new empty `.ensemble-owner.sqlite`, and atomically promotes
the sentinel to `.ensemble-standalone` last. The destination owner file is
fresh installation metadata, not a copy of the source owner or any WAL/journal
file. Offline backup requires the existing owner file to be a regular,
non-symlink file and acquires its SQLite lock; it never creates source metadata.
A successfully restored directory can therefore be backed up before its first
service start, while an older or incomplete marked directory without the owner
file is refused without changing the source tree. Restore does not copy
workspace trees or credentials, and it does not migrate or clear persisted
domain, execution, Stop, writer, capacity or recovery holds. Ordinary service
startup performs migrations, workspace recovery and execution reconciliation
before scheduler admission.

The operations procedure generates a private per-user LaunchAgent with
caller-supplied absolute runtime/data/auth/log paths and an explicit loopback or
HTTPS origin. The renderer sets `KeepAlive=false`; launchctl owns start,
restart and stop. Its environment is limited to the separate auth-file path,
operator origin and the reviewed fixed PATH needed to resolve the installed
Codex CLI and native host commands. Passwords and shell wrappers are absent
from the plist.

S08a's deterministic restored-service fixture proves wrong/exact recovery
receipt handling, independent Stop/Resume behavior and exactly one admitted
turn after reconciliation. Its bounded macOS launchd evidence proves the
per-user service lifecycle and backup/restore of populated paused/unready
public records; that live fixture admits no work and does not inject an exact
recovery receipt because #704 owns no recovery-control surface. Neither proof
qualifies final-schema/external-effect recovery, managed workspace relocation,
host reboot, production deployment, old-work disposition or Haze cutover;
those remain explicit later operational gates.


## S07a scoped GitHub delivery boundary

`DeliveryStore` owns additive SQLite policy, immutable action material, attempts,
confirmed receipts, approval consumption, PR observations and head-bound local
settlement. It composes transaction-internal helpers with the existing coordination
stores. `DeliveryCoordinator` serializes task/target operations and awaits provider
reads outside transactions; use-time policy, bound caller, approval and completion
checks commit atomically with attempting intent. Runtime tool caller identity comes
from the bound thread/turn. Async tool outcomes also retain exact call receipts.

`GitHubHttpDeliveryProvider` supports the concrete comment, incremental label,
reviewed title/body, single-select field, PR create/edit/ready/merge and issue-close
operations. PR creation requires existing identity-verified remote refs and SHA.
Repository merge settings intersect effective pull-request rule methods. Effective
update restrictions, unsupported rules, incomplete proof, merge queues, required
checks/app identity, strict behind heads and unproved deployments hold direct merge.
Conversation resolution is enforced where actual rules require it. The synchronous
merge request binds `sha`; independent merged-state readback settles its effect.

Provider snapshots retain check-run/status and paginated comment/review identities,
updated evidence and bounded feedback summaries. Each changed observation revision
has one durable lead inbox event, including a return to an earlier head or status.
A successful waiting lead retains its assignment/history and releases execution
capacity. A current explicit handback settlement or confirmed merge opens only a
new completion opportunity; fresh provider observation and successful terminal
still gate Done. Provider-only changes and post-await local revisions reject stale
settlement or completion. GitHub is not atomically locked by a local transaction.

Own closure uses fresh identity-checked issue metadata and exact merge ClosedEvent
attribution through `GitHubSourceStore`, preserving source text review and other
admission holds. Repository selection and current label predicates can prove
closure-derived withdrawal. Unproved field/search cases stay held. An explicit
close must have observed open before its write; simultaneous independent closure
within that remote read/write interval remains an accepted attribution limit.

The service passes a filtered spawn snapshot into default, CLI and injected Codex
factories. Delivery reference keys and nonempty exact-value aliases are omitted;
ordinary environment, login and host execution limits remain. A newly configured
reference already inherited by the runtime cannot activate until a safe restart.
No credential value is placed in policy, provider receipts or operator projections.

The existing coordination operator slot shows separate issue/Project, PR and task
facts and guarded policy/refresh/settlement controls. The strict S07a harness guard
requires a frozen resource manifest and matching named grant before provider or
runtime activity. Required live journeys are pending, as recorded in
[the evidence inventory](../evidence/s07a-github-delivery.md); deterministic coverage
and harness preparation do not complete S07a or qualify S07b/cutover.
