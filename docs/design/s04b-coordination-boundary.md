# S04b coordination boundary

S04b connects the standalone domain, scheduler, execution state, Codex dynamic
tools, and a task-scoped operator-facing facade. The service owns durable
coordination effects; runtime history is not used to infer results, recipients,
approvals, or completion. The deterministic contract is covered by SQLite-backed
tests. A separate bounded live probe is required to establish that registered
tools remain callable after service/App Server restart and thread resume; until
its report is recorded, that runtime capability is unproved.

## Trusted caller and durable effects

The runtime callback identity comes from the outer App Server `threadId`,
`turnId`, and `callId`, plus the registered tool and validated arguments. The
service resolves that identity against its current work binding. Assignment IDs,
requester claims, recipient identities, and work revisions supplied in arguments
do not grant authority. A stored exact receipt is replayed before current-turn
checks, so a lost response can be returned without treating the replay as a late
callback; changed content for that identity conflicts.

`CoordinationStore` commits each result and its known-recipient inbox event in
one transaction. Initial assignment results target the task's lead assignment;
nested results target the bound requester. If the recipient cannot be resolved,
the result is retained with a durable unresolved-recipient hold and no guessed
event. Operator reconciliation is task-scoped, revision-bound, and keyed through
the existing operator receipt table; exact replay returns the prior disposition
and changed payload conflicts.

Inbox delivery uses one high-water batch per recipient at a time. The batch
acknowledges the events captured at its high-water mark; later events remain
pending for a subsequent continuation. Paused or stopped work keeps its events
durable without bypassing normal admission.

Questions and approval requests create durable interactions and separate
operator-attention records. They do not create assignment-recipient inbox events
or wake an agent. An operator answer or approval/denial decision creates one
event for the original requesting assignment. Approval is bound to the exact
interaction revision, action, target, and material digest; denial or stale or
changed material never authorizes the action. Durable operator messages are
assignment inbox events and use the same admission path.

Follow-up retains the existing assignment and profile, advances its revision,
and binds the request to the exact prior result. It does not create a replacement
assignment or accept a stale result as current.

## Lead completion and assignment-result effects

Only the current task lead can create a revision-bound completion request listing
the reviewed current results. A successful bound terminal triggers a second
transactional qualification while the lead assignment remains `running`. The
service rechecks the exact lead work/task revision, every other assignment,
current results and their destinations, open interactions, pending inbox work,
execution effects, and task/project/writer holds. On success, checked updates
settle the exact lead work's pending result effect, complete that lead assignment,
mark the task done, and finalize the request in one `BEGIN IMMEDIATE`
transaction.

If a successfully completed lead generation fails a gate, its request becomes
terminally `rejected` with bounded reasons, its exact work effect is settled with
a bounded diagnostic reason, and the assignment remains running while the task
stays open. Clearing a blocker cannot finalize that old generation: the lead must
receive a new admitted continuation and make a new completion request. Failed or
interrupted terminal outcomes do not settle the effect. Exact request replays
retain the original final or rejected disposition.

The completion-request/terminal gap is reconciled after restart only when the
exact request is still pending and its exact bound intent is already completed.
The finalizer rechecks all normal gates before changing assignment/task/request
state. A request from a stale or different generation is not replayed as a new
completion attempt.

An assignment-result effect belongs to one work generation. A successful
generation with a durable result or waiting action settles only that generation's
effect, except while an exact completion request remains pending; that request's
finalizer owns its effect so restart reconciliation can require it pending.
Settling a lead generation's effect does not complete the lead assignment.
Worker assignments become completed only when their exact `ensemble_report_result`
is recorded; a result-free worker turn follows the bounded reporting-repair and
hold path instead.

## Routing and admission boundary

Routing inference and routing disposition are separate durable records. The
`routing_attempt_operations` table records recommendation lifecycle and bounded
provenance; `routing_operations` remains the atomic domain disposition for an
actual route or fallback. A stale recommendation does not create a domain
operation, inbox event, or assignment. The final routing transaction evaluates
the caller-supplied service hold validator under the same SQLite write lock as
revision checks and writes. If Stop wins first, the attempt becomes stale with no
dispatch; if routing commits first, the scheduler's ordinary admission recheck
still prevents a held turn from starting.

TypeSafe is called only through an injected narrow client and explicit project
opt-in. Routing remains disabled when credentials/client are unavailable; this
slice requires neither credentials nor a paid provider call. The deterministic
fake proves routing contracts, not provider quality, calibration, or cost.

## Operator-facing boundary and evidence

`CoordinationView` returns task-scoped DTOs and validates operator commands. It
does not own HTTP, authentication, sessions, or shared navigation. The
`test/s04b/local-view.mjs` probe starts a read-only ephemeral loopback server with
a disposable database and fake runtime; it is test-only and does not add a
production route. `src/standalone/operator.ts` remains outside S04b ownership;
#703 owns shared authentication and UI, and #694 owns final runtime/UI assembly.

The opt-in `npm run s04b:live` probe uses the real Codex App Server, a temporary
service database/workspace, disabled routing, and no TypeSafe client. It records
outer callback identity and outcome, scheduler/work state, durable result/event
identities, dynamic-tool registration on resumed threads, process-exit
verification, and fixture cleanup without logging callback arguments. It must be
run with the exact pinned Node/npm toolchain, and only a recorded run establishes
the tested runtime boundary. It does not establish Tailscale/authentication,
physical sleep/wake, detached-child containment, or paid routing behavior.
