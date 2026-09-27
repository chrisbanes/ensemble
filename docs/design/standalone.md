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
- Require active execution to stop when the service fails. Prove macOS supervision
  and relevant descendant termination before claiming this behavior.
- New projects default to Codex workspace-limited execution; broader execution
  requires operator approval and the actual controls must be qualified.
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

The chosen crash policy requires active execution to stop with service failure.
This is a runtime qualification requirement, not a property of ordinary child
processes. S01 must exercise abrupt service death and relevant tool descendants.
Until termination is confirmed, preserve writer ownership and display uncertainty;
do not admit a replacement. Persist enough identity to detect surviving processes,
including PID reuse. If execution can escape the chosen supervision boundary, hold
that capability for a new decision rather than silently allowing turns to finish.
Queued work must never start independently while Ensemble is unavailable.

On startup, restore holds and reconcile execution/writer ownership before enabling
dispatch. Automatically resume previously enabled, now-eligible standalone work
after successful reconciliation; no extra enable action is required. Existing
project pauses and task stops remain in force, and old BB assignments are excluded. Failure of policy/storage initialization keeps pending work held. Lost
responses and missing observations never authorize blind replay. Stale reports
remain historical and cannot complete a newer assignment revision.

## Workspace, results and operator boundary

Persist workspace provisioning intent before creating worktrees; reconcile partial
creation and concurrent requests to one task binding. Keep writer ownership across
uncertain termination. A database lease prevents cooperating dispatches, not an old
process's filesystem writes; release requires confirmed termination or demonstrated
execution isolation. Retention is independent of conversation lifetime.

Commit a result and its recipient's inbox event together. Deliver one logical
continuation for pending events, preserving individual acknowledgement and work
revision checks. Human answers use the same durable mechanism; approval additionally
binds exact reviewed action/material. Recheck permissions when executing an action.

The UI calls validated core commands. Runtime tool callers receive a binding created
by Ensemble, not authority inferred from their payload. Define operator access,
secret handling and the selected runtime's filesystem/network controls before remote
exposure or execution-access claims. Single-operator does not mean unauthenticated
network access. No new project security sandbox is implied by service ownership.

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
- macOS service lifecycle, process containment and execution access.
- Effective-admission transaction/supervisor protocol and restart reconciliation.
- Web API/UI technology and a separate authenticated operator session over the
  private Tailscale transport, including CSRF/origin checks for control requests.
- Fairness under the selected caps, retry classification and inactivity thresholds.
- Versioned fresh-database schemas, backup/restore and explicit old-work retirement.

Codex on macOS is the selected first combination. Additional platforms are separate
qualification work, not an assumed first-release matrix. Resolve these through
bounded proofs and review; no framework or dependency selection is implied here.
