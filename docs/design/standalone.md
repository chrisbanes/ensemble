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
  and private Tailscale transport. The current UI and CSRF/origin boundary are
  documented in [S04c](s04c-operator-ui.md); private Serve proof remains bounded
  evidence, not deployment authorization.
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
server. Backup uses Node 24's SQLite backup API to reserve a new private
snapshot directory, verify the whole database, and write a strict manifest as
the final commit marker. The manifest binds the supported schema version and
fingerprint, SQLite file digest, deterministic typed logical-content digest,
and source marker. Restore reserves a distinct nonexistent data directory,
creates `.ensemble-restore-incomplete` immediately, verifies the copied
database, and atomically promotes the sentinel to `.ensemble-standalone` last.
Restore does not copy owner/WAL files, workspace trees or credentials, and it
does not migrate or clear persisted domain, execution, Stop, writer, capacity
or recovery holds. Ordinary service startup performs migrations, workspace
recovery and execution reconciliation before scheduler admission.

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
