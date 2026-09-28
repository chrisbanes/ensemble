# Standalone service design

**Product decisions reviewed and confirmed by Chris on 27 September 2026.**
The ownership decision is accepted in [ADR-1004](../adr/1004-standalone-service.md).
Runtime-specific contracts below require the bounded S01 proof before dependent implementation.
The existing implementation remains the BB prototype with a reusable SQLite core.

## Confirmed review decisions

- Use Codex first, with the existing operator login; Claude and API-key billing
  support are deferred. Qualify Codex App Server as the integration surface.
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

## Components and ownership

Use ordinary TypeScript modules in one service, with SQLite as the durable source
of truth. Do not introduce a message broker, microservices or a generic runtime
plugin system without a concrete need.

| Component | Responsibility |
| --- | --- |
| Core | Projects, tasks, assignments, instructions, permissions, command receipts, results and human requests |
| Scheduler | Durable pending turns, eligibility, capacity, retry allowances and wakeups |
| Execution supervisor | Runtime process/session identity, launch admission, observation, cancellation and restart reconciliation |
| Workspace manager | Task worktrees, provisioning recovery, writer ownership, preservation and cleanup |
| Runtime integration | Validated execution settings, agent tool calls, transcripts, provider events and conversation resume where supported |
| Operator API/UI | Trusted operator commands, project/task views, conversations, attention inbox and persisted control outcomes |
| GitHub integration | Discovery, source identity, complete dependency reads, authorized writes and reconciliation |

The runtime integration supplies agent execution, not project scheduling or an
independently draining queue. “Build ourselves” covers the coordination product;
model interaction and agent tools use Codex. Qualify its App Server protocol in
S01 rather than assuming documented operations satisfy Ensemble's guarantees.

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
revision checks. Human answers use the same durable mechanism; approval additionally
binds exact reviewed action/material. Recheck permissions when executing an action.

The UI calls validated core commands. Runtime tool callers receive a binding created
by Ensemble, not authority inferred from their payload. Define operator access,
secret handling and the selected runtime's filesystem/network controls before remote
exposure or execution-access claims. Single-operator does not mean unauthenticated
network access. No new project security sandbox is implied by service ownership.

## Default execution policy

Select supported App Server `workspaceWrite` controls with task working directory
and explicit task writable roots, `networkAccess: false`, `readOnlyAccess` set to
`fullAccess`, and `approvalPolicy: never`. Verify installed field names and effective
settings on start, follow-up and resume; pin any experimental surface used. Deny
broader command access rather than auto-approving escalation. A policy change needs
separate operator approval and fresh admission. Do not inherit `dangerFullAccess`
as a fallback or change shared configuration/login to make a probe pass.

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

S02 removes the BB adapter/entry, manifest fields, package dependencies, BB-only
scripts and mandatory BB CI together. Retain historical documentation and Git
history rather than relabeling BB tests as standalone proof. Reconcile against the
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
- Web API/UI technology and a separate authenticated operator session over the
  private Tailscale transport, including CSRF/origin checks for control requests.
- Fairness under the selected caps, retry classification and inactivity thresholds.
- Versioned fresh-database schemas, backup/restore and explicit old-work retirement.

Codex on macOS is the selected first combination. Additional platforms are separate
qualification work, not an assumed first-release matrix. Resolve these through
bounded proofs and review; no framework or dependency selection is implied here.
