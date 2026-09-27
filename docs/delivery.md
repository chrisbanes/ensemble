# Standalone delivery plan

**Direction and delivery sequence reviewed and confirmed by Chris on 27 September 2026.**
S01 runtime qualification is the next gate; detailed dependent contracts remain open.
[ADR-1004](adr/1004-standalone-service.md) replaces the BB delivery path. S01–S08
below are local plan identifiers, not published issues or an authorized work queue.
The [previous T01–T12 briefs and decision register](delivery-bb.md) remain historical.
Linked GitHub and Multica issues have not been changed by this planning update.

## Delivery sequence

| Slice | Outcome and acceptance | Dependencies |
| --- | --- | --- |
| S01 — Prove runtime control | Qualify Codex App Server on macOS with the existing operator login; prove initialization failure holds queued work, effective admission, lost-response reconciliation, cancellation and writer termination. Document tool caller identity, transcripts, resume and access limits. No product scheduler/UI claim; R01. | Confirmed product scope; bounded proof below |
| S02 — Replace BB bootstrap | Standalone service/bootstrap, fresh-database schema/migrations and runtime integration; preserve reusable core behavior. Remove BB manifest, adapter, dependencies and mandatory BB CI. Test with BB absent, SQLite reopen, runtime failure and preserved uncertain state; R01 and R06 fresh-database separation. | S01 and reviewed runtime/schema contracts |
| S03 — Own dispatch and workspaces | Durable eligible-turn queue, global/project caps (defaults 4/2), active-work sleep assertion, holds, worktree provisioning, one writer, restart reconciliation and bounded retries. Capacity-one delegation cannot deadlock; pause/stop races and orphan writers remain safe. | S02; A07–A09, A14–A18, A27, R02/R03 |
| S04 — Deliver local work and operator UI | Web UI with separate operator login over Tailscale, project/profile setup, tasks, conversations/history, owner/worker tools, transactional results/inbox, durable operator messages (no live steering), questions/approvals, instruction revisions and task dependencies. Integrate UI with each command as it lands. | S03; A02–A13, A25, local A28/A30, R04/R05 |
| S05 — Qualify complete local journey | Automated UI/service/runtime journey with a disposable repo and repository-free work; stop/restart/recovery variants, preservation and exact evidence. No GitHub integration required. | S04; local-task acceptance gate |
| S06 — Add GitHub discovery | Explicit credential access, native search/Project queries, source deduplication, readiness, full dependency reads, overlap placement and outage recovery. | S05; A19–A23, imported A28–A30 |
| S07 — Qualify external delivery | Authorized writes, uncertain-effect reconciliation, feedback wakeups and both PR completion modes, with project-specific merge requirements. | S06; A24–A26 and complete A01–A30 |
| S08 — Cut over deliberately | Verify backup/restore and service operations; preserve the prototype separately and explicitly settle or retire old active work. Review one bounded project cutover with no competing scheduler or writer. | S07 release candidate; R06 restore/cutover; explicit cutover review |

S01 is a bounded capability investigation, not permission to invent a full harness
platform. It must establish what can be enforced before S02/S03 commit to interfaces.
Do not add multiple runtime implementations merely to demonstrate abstraction.

## S01 — Bounded Codex/macOS proof

**Outcome:** determine whether the selected runtime and supervision design can
satisfy the reviewed execution contract. Produce the narrow proposed integration
contract, reproducible evidence and any failed capability; do not build the full
scheduler, UI, multi-runtime layer or operational deployment in this slice.

Use a disposable directory/database/repository and an isolated Codex App Server
process with the existing login. Do not log credentials, change account configuration,
operate on the installed Haze prototype or target existing agent sessions. Identify
the installed runtime and supported protocol before choosing integration details.
Use deterministic process/tool fixtures for fault injection and a bounded real
Codex turn to establish actual runtime behavior; doubles cannot qualify Codex.

| Probe | Required evidence |
| --- | --- |
| Login and conversation lifecycle | Existing login works in the intended service-user context; start, observe, resume and unavailable-login handling are recorded without exposing credentials. |
| Coordination tool identity | A callback is bound to the admitted assignment/session by Ensemble-controlled context; payload-supplied IDs cannot impersonate another assignment. |
| Admission and unavailable service | Define the effective-admission point; pause/stop races hold pending work. Initialization failure or service absence cannot cause queued turns to start. |
| Lost response and recovery | Crash/drop responses around submission and binding. Recover the unique execution or retain uncertainty without blind duplicate submission; include stale work revisions. |
| Stop and abrupt death | Stop before launch, during admission and during a writing tool. Abruptly kill the supervising service and test relevant tool descendants; prove termination and preservation of partial work. |
| Writer replacement | No replacement writes until old execution is confirmed unable to write. Missing observations, PID reuse and acknowledged-but-unconfirmed stop cannot release ownership. |
| Access and transcripts | Workspace restrictions, broader-access requests, history and event delivery behave as required; document actual access limits and experimental protocol dependencies. |

Retain exact commands, source/runtime versions, identifiers, provider/tool effects,
crash timing and fixture cleanup. State what the supervisor owns and how it outlives
or detects service failure. A disconnected client or an interrupt acknowledgement
alone is insufficient evidence. If termination or admission cannot be enforced,
record the failed gate and return the concrete tradeoff for decision; do not switch
platforms, harnesses or safety semantics silently. Successful S01 informs S02/S03
contracts; it does not claim the operational product scenarios already pass.

## Feature integration and operational ownership

S02 owns service bootstrap and repeatable startup/shutdown with a fresh database;
S03 adds the scheduler, supervision integration, workspace lifecycle and sleep
assertion. These must work together before UI or autonomous release claims.
S04 owns the web authentication/session boundary as well as coordination tools,
operator messages and views. Deliver it in coherent increments with their automated
UI/service tests, rather than treating its single plan ID as one oversized patch.
S05 exercises the assembled local journey. S08 owns backup/restore qualification,
operator service procedures and the separately reviewed cutover. Every slice
records implementation evidence and explicitly retains unresolved capabilities.

## BB retirement and queue reconciliation

Before publishing replacement tickets, read current main and live issue/PR state.
This checkout predates concurrent Multica work; incorporate useful core repairs
without reviving the BB backend. Review CB-19's local-refusal fix on its merits.
It does not resolve accepted-row safety or qualify a standalone runtime.

Reconcile epic #649 and T01–T12 with this plan: preserve reusable core and product
requirements, supersede BB-specific delivery work, and retain #665/#676 as historical
capability findings with links to the standalone replacement proofs. Do not mark
either safety gate passed because BB is being retired. No issue status, comment,
agent assignment or active run is changed by this document.

The following is a scope mapping, not a claim about live ticket status. Re-read
remote issues, dependencies and PRs before editing or publishing them.

| Historical work | Standalone disposition |
| --- | --- |
| Epic #649, BB-based MVP | Replace its BB delivery framing with S01–S08 while retaining the product outcome; link preserved history. |
| T01 #650, BB harness | Retain completed BB evidence; S01 supplies new Codex/macOS proof, never a renamed BB pass. |
| T02 #651, access/workspaces | Carry requirements into S01/S03 and A15–A18/A25; qualify independently. |
| T03 #652, domain records | Reuse applicable core work in S02/S04; fresh DB removes legacy-import requirements. |
| T04 #653, BB configuration | Replace with standalone project/profile configuration in S04. |
| T05 #654, task UI | Retain product scope; implement in standalone web UI in S04. |
| T06 #655, assignment threads | Replace BB execution with S01–S03 Codex integration and S04 assignment tools. |
| T07 #656, results | Retain durable inbox/continuation semantics in S04, qualify in S05. |
| T08 #657, BB dispatch/limits | Replace with Ensemble-owned scheduler, caps and retry accounting in S03. |
| T09 #658, human controls | Retain questions/approvals/holds in S04 with independent web authentication. |
| T10 #659, local milestone | S05 replaces BB qualification with complete standalone service/UI/runtime evidence. |
| T11 #660, GitHub discovery | S06 retains source/admission/dependency semantics with independent integration access. |
| T12 #661, writes/release | S07 retains write and delivery guarantees; S08 adds standalone operational qualification. |
| #665 / CB-19 and #676 | Preserve BB failures and useful isolated core repairs. Re-express admission/termination obligations in S01/S03, without claiming the BB defects were fixed. |

S02 removes production/build dependency on BB as one coherent change: package
identity/engines/manifest, SDK/runtime lockfile entries, adapter/server entry,
BB-only scripts, fixtures and CI jobs. Retain or translate meaningful core tests;
replace removed runtime assertions with the S01 standalone proofs. Preserve
historical evidence in docs/Git instead of leaving a hidden production BB path.

Do not alter the installed Haze prototype, its data, conversations or live work
as part of a source-code cleanup. S08 establishes the reviewed operational boundary.
No automatic migration or resumption of unfinished BB assignments is promised.

## Review checkpoint

The user has accepted removing BB and building Ensemble's own service. The detailed
[specification](SPEC.md), [design](design/standalone.md), and [acceptance plan](acceptance.md)
form the reviewed replacement plan. Codex protocol, macOS supervision, operator access
and admission/termination contracts remain explicit technical decisions, not silently
selected dependencies. The product-scope review checkpoint is satisfied; capability proofs still gate
dependent implementation. This confirmation does not claim any proof has passed.
