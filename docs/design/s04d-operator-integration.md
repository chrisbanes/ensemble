# S04d operator integration

Issue [#694](https://github.com/chrisbanes/ensemble/issues/694) completes the
runtime and coordination operator routes on top of the authenticated local UI
foundation in [S04c](s04c-operator-ui.md). The production `operator` command
registers both named route slots with the same `LocalOperatorHttp` instance;
they therefore inherit its login, exact-Origin, CSRF, input parsing, safe
redirect and response-header behavior. The adapters receive service/domain
interfaces, not raw HTTP request or response objects.

## Runtime operator view

The Runtime overview reports configured global/default/effective project
capacity and current reservations. Its forms configure the global and optional
project limit. Task and assignment views show selected, queued, admitted,
running, stopping, held and completed evidence, local task dependencies,
captured profile/instruction revisions and the explicit apply-for-next-turn
action. Task controls add/remove local dependency edges, request current
instructions for a later turn, request bounded best-effort Stop, and Resume.
Stop may be acknowledged without proving that effects ended; the view retains
writer/capacity/uncertainty holds and does not offer a force-unlock operation.

The page distinguishes configuration eligibility from runtime admission and
observed execution. It discloses the actual default policy (workspace writes,
broad host-permitted reads, command network disabled, approval policy never)
and states that strict isolation, exhaustive ambient access containment and
universal descendant containment have not been proved. Existing Codex login
and host/deployment controls remain the execution trust boundary; Ensemble does
not claim an independent sandbox.
Runtime and Coordination assignment status follow the latest persisted request
sequence for the current assignment revision, so an older completed turn cannot
mask a queued continuation.

## Coordination and approval evidence

The Coordination overview, task and assignment pages present task-scoped
assignments, runtime history, durable messages, questions, exact approval
materials, results/destinations, routing provenance and completion/fallback
attention. Controls answer open questions, decide an approval, queue a durable
message for the next eligible turn, and reconcile an unresolved result only to
an allowed same-task requester or lead. No live steering is exposed. Operator
content remains task-scoped and does not display runtime prompts, private
instructions, workspace paths or credential references.

Approval callbacks now retain canonical JSON material, bounded to 8 KiB, beside
its digest. A decision must match the exact stored material and revision before
it is recorded. The additive nullable SQLite column preserves legacy open
approvals; missing legacy material cannot be approved and may only be denied.
The operator view renders escaped canonical material and omits approval actions
for malformed retained data.

The task Coordination routing section shows that project's guidance and
configured candidates with their capabilities and current routing eligibility;
revoked configured profiles remain visible as unavailable. It distinguishes a
stored credential reference from an available routing client and gives only
bounded effective-availability reasons (disabled, missing client credentials,
or no eligible candidates). It exposes neither references nor environment names
or secret values and makes no provider request. Routing availability does not
describe capacity, busy state or execution admission; candidate selection still
does not authorize a runtime turn. The project configuration page calls this a
credential reference, not a configured credential.

## Verification boundary

Deterministic adapter tests use real SQLite and fake only the runtime boundary.
The HTTP integration test registers the production adapter routes on a real
loopback server and checks pre-login confidentiality, unauthenticated writes,
exact Origin and CSRF refusals, malformed and duplicate field rejection, safe
shared response headers, and idempotent capacity submission. Chromium exercises
the production route registry with actual message, answer, approval and denial,
result-recipient reconciliation, dependency, instruction-apply, and Stop/Resume
form submissions. It reads the committed coordination state after service
restart, including an unresolved writer hold, and follows the Coordination link
to task-scoped Runtime controls.

The opt-in [`test/s04d/live-operator.mjs`](../../test/s04d/live-operator.mjs)
uses a disposable service with the real Codex App Server, generated local
operator credentials, and Chromium. It observes a real task-scoped question,
requests Stop through the UI, checks the bounded Stop/known-writer hold, restarts
the service and App Server, and verifies retained question/history/holds and
process cleanup. It does not use TypeSafe, alter shared Codex configuration,
delete provider thread records, deploy, or authorize cutover. Evidence is
recorded in [`s04d-operator-2026-09-30.md`](../evidence/s04d-operator-2026-09-30.md).

The extended [`test/s04c/private-access.mjs`](../../test/s04c/private-access.mjs)
also checks the new private Runtime/Coordination reads and a same-origin,
replayed capacity write, restoring the disposable project's original effective
limit afterward. It requires an explicitly provisioned disposable HTTPS/Tailscale
fixture and a passing run from the fixture host through its canonical Tailscale
HTTPS URL. This proves the private route and browser boundary from that host; it
does not establish reachability from a separate device. If the fixture or route
is absent, the proof is unproved and #694 remains incomplete. The test does not
create, replace or remove persistent Tailscale Serve configuration; neither this
proof nor the loopback proof authorizes deployment or cutover.
