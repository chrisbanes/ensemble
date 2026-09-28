# Standalone delivery plan

**Direction and delivery sequence reviewed and confirmed by Chris on 27 September 2026.**
Routing and accountability were amended on 28 September under
[ADR-1005](adr/1005-service-assignment-routing.md).
S01 runtime qualification is the next gate; detailed dependent contracts remain open.
[ADR-1004](adr/1004-standalone-service.md) replaces the BB delivery path. Chris
approved the minimum S01 integration contract on 28 September 2026; the current
S01 issue is [#688](https://github.com/chrisbanes/ensemble/issues/688).
The [previous T01–T12 briefs and decision register](delivery-bb.md) remain historical.
The subsequent approved runtime trust boundary is recorded below. Neither contract
amendment alone passes S01 or releases dependent work.

## Delivery sequence

| Slice | Outcome and acceptance | Dependencies |
| --- | --- | --- |
| S01 — Prove minimum Codex integration | Existing-login execution, events/results, follow-up or supported resume and cancellation requests; bounded admission, trusted identity, durable-state and ambiguous-submission probes. Record access/runtime limits and operator recovery. No product scheduler/UI claim; R01. | Confirmed product scope; bounded proof below |
| S02 — Build standalone bootstrap | Standalone service/bootstrap, fresh-database schema/migrations and runtime integration; preserve reusable core behavior. BB source cleanup is complete. Test SQLite reopen, runtime failure and preserved uncertain state; R01 and R06 fresh-database separation. | S01 and reviewed runtime/schema contracts |
| S03 — Own dispatch and workspaces | Durable eligible-turn queue, global/project caps (defaults 4/2), active-work sleep assertion, holds, worktree provisioning, cooperative writer admission, restart reconciliation and bounded retries. Capacity-one delegation cannot deadlock; pause/stop races and uncertain/orphan executions retain holds. | S02; A07–A09, A14–A18, A27, R02/R03 |
| S04 — Deliver local work and operator UI | Web UI with separate operator login over Tailscale, project/profile setup, tasks, conversations/history, lead/assignee tools, direct TypeSafe routing with project opt-in and lead fallback, transactional results/inbox, durable operator messages (no live steering), questions/approvals, instruction revisions and task dependencies. Integrate UI with each command as it lands. | S03; A02–A13, A25, local A28/A30, R04/R05/R07–R10 |
| S05 — Qualify complete local journey | Automated UI/service/runtime journey with a disposable repo and repository-free work; routing-enabled and disabled paths, nested returns, lead completion, routing failures, stop/restart/recovery variants, preservation and exact evidence. No GitHub integration required. | S04; local-task acceptance gate |
| S06 — Add GitHub discovery | Explicit credential access, native search/Project queries, source deduplication, readiness, full dependency reads, overlap placement and outage recovery. | S05; A19–A23, imported A28–A30 |
| S07 — Qualify external delivery | Authorized writes, uncertain-effect reconciliation, feedback wakeups and both PR completion modes, with project-specific merge requirements. | S06; A24–A26 and complete A01–A30 |
| S08 — Cut over deliberately | Verify backup/restore and service operations; preserve the prototype separately and explicitly settle or retire old active work. Review one bounded project cutover with no competing scheduler or writer. | S07 release candidate; R06 restore/cutover; explicit cutover review |

S01 is a bounded capability investigation, not permission to invent a full harness
platform. It must establish what can be enforced before S02/S03 commit to interfaces.
Do not add multiple runtime implementations merely to demonstrate abstraction.

## S01 — Bounded Codex/macOS proof

**Outcome:** qualify the minimum Codex App Server orchestration contract and the
feasibility of Ensemble-owned coordination. Use supported protocol operations;
record their limits rather than demanding an independent Ensemble sandbox. Produce
one concise integration contract/evidence matrix, not a scheduler, UI or deployment.

Use disposable fixtures and an isolated App Server process with the existing
operator login. Identify installed version/schema and effective policy first; do
not change shared config/login, copy/link credentials, switch to `dangerFullAccess`,
add a runtime or touch Haze/existing sessions. Reuse valid evidence before proposing
bounded calls; do not repeat unchanged failed probes. This documentation reset runs
no new model experiments and does not authorize a new login or deployment.

| Required S01 probe | Bounded evidence and limit |
| --- | --- |
| Authenticated lifecycle — R01/A18 | Existing login in the intended operator context supports a real turn, events/result, stored history and follow-up or supported conversation resume. Record unavailable-login behavior, process restart behavior and authentication limits. A future installed-service launch/login test belongs to S02/S05. |
| Trusted caller — A25 | Bind a real coordination callback to Ensemble-controlled session context; reject payload identity spoofing. Probe stale/unbound generations in the fixture and pin any experimental dynamic-tool API. Full product authorization/approval tests belong to S04/S05. |
| Admission and durable state — A14/A16 | Define admission relative to submission; SQLite fixtures serialize contenders, preserve intent/holds across reopen and fail closed on initialization/storage/policy failure, pause/Stop races and service absence. No independent runtime queue of unadmitted turns. Full scheduler races/caps belong to S03/S05. |
| Ambiguous submission — A08/A09 | Drop response/crash around submission/binding, include stale revisions, and retain one durable operation with no accidental duplicate dispatch. Reattach only if the same live execution is uniquely identified; otherwise retain uncertainty with the recovery path. Historical resume is not live reattachment; a positive reattachment result is not a universal gate. |
| Cancellation and survival — A15 | Persist Stop before a supported cancellation request, observe for a predeclared bounded interval, record any continued effects and retain unresolved Stop/writer/capacity holds across restart. Crash survival is a documented limit, not a demand to kill every descendant. |
| Cooperative handoff — A16/A18 | Trust successful terminal status for the bound thread/turn, require ended Ensemble callbacks and no other hold/known unfinished execution, then serialize one successor. Missing diagnostic tool items alone do not block handoff. Preserve negative crash/Stop/failure/missing-or-conflicting-terminal/callback/survivor cases and accepted unobserved-effect overlap. Other holds need independent resolution. |
| Effective policy and observations — A25/R01 | Apply the design's explicit `workspaceWrite`/`never` policy through supported App Server controls. Record attributable inside-write and outside-write behavior, effective command-network controls, rejected broader access, broad reads and ambient limits. Preserve real streamed/stored turn evidence; standalone `command/exec` cannot prove model-turn history. Named restricted profiles and outside-read denial are not required. |

Retain exact versions, commands, identities, effects and fixture cleanup. Separate
protocol/runtime observations from deterministic coordination fixtures and from
unrun service tests. An unsupported or ineffective selected write/network/approval
policy still blocks that capability: raise the concrete configuration decision,
never silently broaden access. Document the
[operator recovery route](design/standalone.md#operator-recovery-of-uncertain-execution)
and limitations, including indefinite holds if evidence cannot settle ownership.

### S01 completion rule

The seven rows above are the finite S01 checklist under the approved
[runtime trust boundary](design/standalone.md#runtime-trust-boundary). Reuse
existing evidence and record one disposition per row with exact provenance:
qualified within its stated bounds, demonstrated blocker, or missing required
bounded evidence. Once each row is qualified, the evidence owner returns one
candidate and the coordinator records acceptance; that completes S01 and releases
its native dependency gate. This documentation change alone does neither.

Do not add exhaustive tool-history coverage, a general model-tool allowlist,
physical writer exclusion or installed-service tests to this checklist. Missing
diagnostic items and untested tool classes are not themselves demonstrated policy
breaches. Preserve the unexplained earlier file effect as a diagnostic finding;
its explanation does not gate S01. S02–S05 own ordinary file-edit, enabled-tool,
scheduler, recovery and UI integration checks. A demonstrated policy breach or
contradiction of the trusted terminal outcome still blocks the affected capability.

Existing execution authorization covers reconciliation and any genuinely missing
bounded checklist evidence. Do not repeat qualified probes or open an alternative
runtime/version investigation merely to obtain exhaustive observations. Escalate
only a concrete required capability failure or a material change to this boundary.

### Evidence and remaining-work mapping

The [durable existing-evidence matrix](evidence/s01-existing-evidence-2026-09-28.md)
records the earlier bounded observations, provenance and gaps in this repository.
The [later qualification report](evidence/s01-qualification-report-2026-09-28.md)
publishes the bounded observations from local evidence head
`77a383fd64144df83dcc65f7b1888286d1f39b55`. Reconcile these two published reports
against the finite checklist; access to the author's local checkout is not required
for that assessment. Selected shell-policy/history probes before and after restart
report positive evidence. The exhaustive-observation blocker is superseded by the
trust amendment; the earlier unexplained file effect remains a diagnostic finding.
Original fixtures/raw traces are not included, so independent replay requires those
artifacts or separately bounded probes. Neither report qualifies uncovered cases.

The S01 checkout `cb/35-s01-proof` was inspected read-only at
`e87ed326182b602c412606d1e88d6ae481188eb2`. Its
`docs/evidence/s01-consolidated-discovery-2026-09-28.md` indexes the traces; approved
revisions 3–5 are integrated at `56976c0cea82d4dadfac73ab60979e0cfed69c30` there.
These are local evidence references, not published links or implemented-service
results. Preserve that checkout and the [issue history](https://github.com/chrisbanes/ensemble/issues/688).
Do not import raw traces/configuration or change prior findings to passes.

| Disposition | Evidence and remaining work |
| --- | --- |
| Reuse within S01 | Real existing-login turn/stored resume, trusted callback, crash survival, best-effort Stop holds and cooperative handoff have bounded evidence. SQLite probes cover admission, state reopen and negative holds. Reconcile their exact coverage against the required rows above; none proves the service. |
| Still required for S01 | Reconcile the published qualification reports against the seven checklist rows and return one acceptance candidate. Preserve any genuinely missing bounded evidence as unproved and the recovery route as a contract to implement. Do not repeat qualified shell/history/restart probes or gate on exhaustive observations. No new pass is asserted here. |
| Documented runtime limits | Admitted work can survive failure/Stop; untracked children can overlap a normal-success successor; stored resume is not live reattachment. Existing sibling-read success is still a failure of the former read-denial contract and now documents an accepted broad-read limit. Process/cleanup failures remain failures of stronger containment. |
| Later service/integration | S02–S05 implement and qualify service startup/login, all admission races, durable results/inbox, policy and approval enforcement, operator visibility and recovery, full UI/runtime journeys and relevant A/R scenarios. S08 owns operational restart/restore/cutover procedures. |
| Optional product/deployment hardening | Restricted reads, named permission profiles, complete descendant containment and stronger host isolation require a separate explicit decision and evidence; they do not block minimum orchestration. |

The prior named-profile `allowed:false` result remains valid with unknown cause;
the presence of legacy full-access configuration did not establish causation.
Removing the strict-read requirement neither proves the revised effective policy
nor authorizes configuration/login changes. S01 stays unpassed and #688 stays open;
only actual qualification evidence can release dependent work.

## Feature integration and operational ownership

S02 owns service bootstrap and repeatable startup/shutdown with a fresh database;
S03 adds the scheduler, supervision integration, workspace lifecycle and sleep
assertion. These must work together before UI or autonomous release claims.
S04 owns the web authentication/session boundary as well as coordination tools,
operator messages and views. Deliver it in coherent increments with their automated
UI/service tests, rather than treating its single plan ID as one oversized patch.
S04 also owns routing settings and the direct TypeSafe integration, durable
routing decisions, explicit-assignee bypass, task-scoped lead conversations and
result destinations. S03 supplies admission/capacity boundaries; S04 must not
route around them. S05 exercises the assembled local journey including R07–R10,
using deterministic routing failures and representative, bounded live routing
validation with explicitly enabled credentials and project access. Model calls
are not authorized by this documentation change. Measure errors, fallback,
latency and cost; do not assume savings or select thresholds without evidence. S08 owns backup/restore qualification,
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
| #665 / CB-19 and #676 | Preserve BB failures and useful isolated core repairs. Re-express admission/recovery obligations in S01/S03, without claiming the BB defects were fixed. |

The BB package, adapter, scripts, fixtures and CI jobs were removed before S02.
S02 still needs a standalone bootstrap and runtime integration qualified by S01.
The retained core tests do not provide standalone service or UI evidence.

Do not alter the installed Haze prototype, its data, conversations or live work
as part of a source-code cleanup. S08 establishes the reviewed operational boundary.
No automatic migration or resumption of unfinished BB assignments is promised.

## Review checkpoint

The user has accepted removing BB and building Ensemble's own service. The detailed
[specification](SPEC.md), [design](design/standalone.md), and [acceptance plan](acceptance.md)
form the reviewed replacement plan, including the confirmed 28 September
assignment-routing and accountability amendment. Codex protocol, macOS supervision, operator access
and admission/recovery contracts remain explicit technical decisions, not silently
selected dependencies. The product-scope review checkpoint is satisfied; capability proofs still gate
dependent implementation. This confirmation does not claim any proof has passed.
