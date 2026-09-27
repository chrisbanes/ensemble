# Standalone acceptance plan

**Acceptance scope reviewed and confirmed by Chris on 27 September 2026.** Scenario IDs A01–A30 retain the product obligations of the
[historical BB plan](acceptance-bb.md), with execution/UI/workspace ownership moved
to Ensemble by [ADR-1004](adr/1004-standalone-service.md). These are requirements,
not passing results. No previous BB test qualifies the standalone service.

## Gates

1. **Runtime feasibility:** S01 proves admission, startup failure, stop and writer
   exclusion with the actual chosen runtime and disposable workspaces.
2. **Local-task milestone:** service, UI and real-runtime journeys cover A01–A18,
   A25, A27 and local A28/A30. GitHub-dependent portions wait for integration.
3. **Operational release:** all A01–A30, including both PR completion modes,
   real provider access and external-write recovery, with reviewed cutover.

Use real SQLite files and deterministic runtime doubles for fault coverage;
separately test the actual runtime and service/UI. Record exact source/runtime
versions, commands, observed effects, limitations and fixture cleanup. The agent
runs the complete journey; no incremental operator testing handoff. A harness
that successfully detects an unsafe effect still records a failed capability.

## Product scenarios

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| A01 | Install standalone service; restart with BB absent | Service, migrations, tools and UI operate without BB; failed initialization does not release pending work | Service + UI |
| A02 | Operator configures two projects and profiles | Shared profile can be selected by both projects with distinct project instructions; configuration is validated and retained; both initially paused | UI + runtime |
| A03 | Create/edit a local task in the UI; restart | Content and stable identity survive; unready by default; Create and start marks Ready without bypassing pause; no external issue is created | UI + SQLite |
| A04 | Enable a project with eligible tasks | Lead selects work and one owner starts without a chat setup ritual | Service + UI |
| A05 | Owner requests two bounded assignments | Independent conversations use selected profiles; one accountable task owner remains | Service + runtime |
| A06 | Worker reports while parent is idle | Result persists; one logical inbox event wakes parent; acknowledgement survives restart | Service + runtime |
| A07 | Repeat claim/delegate/report/response commands | Same operation returns same outcome; changed payload conflicts; no second worker/effect | SQLite + runtime |
| A08 | Lose spawn response after the runtime creates a worker | Restart reconnects the original; zero/multiple matches visibly hold; no blind retry | Runtime fault injection |
| A09 | Crash before/after result commit, send acceptance or acknowledgement | Durable result/inbox retained; accepted sends reconciled; no duplicate work | Runtime fault injection |
| A10 | Owner delegates implementation and review; review finds a defect | Owner chooses revision and follow-up from instructions; findings refer to artifact revision | Service scripted journey |
| A11 | Edit instructions/profile during existing work, then explicitly apply | Existing assignments retain recorded revisions until explicit apply for their next turn; new assignments use current revisions; process changes need no new stages or schema; permission revocations still apply | Service + UI |
| A12 | Agent asks a question; operator answers during restart | Question appears in Ensemble beside a link to the owner conversation; response is durable, correctly scoped, and resumes the right assignment | UI + runtime |
| A13 | Approval denied or reviewed material changes | Action cannot execute using denied/stale approval; reason visible | Service + access integration |
| A14 | Pause project A while B has work | Current turns in A may finish; no new turns or follow-ups in A; B continues; results retained; resume revalidates | Service + UI |
| A15 | Stop a task with an owner and workers; supervisor loses contact or reports a writer still active | All active task assignments receive stop requests; queued work held until explicit resume; files/history retained; UI shows stopping/uncertain until confirmed; replacement cannot write until reconciled | Runtime fault injection |
| A16 | Two writers target one task workspace | One admission succeeds; others wait; parallel independent tasks remain possible | Service + Git |
| A17 | Complete/archive work in each cleanup mode | Retain until archive by default; automatic cleanup waits for confirmed delivery and preservation checks; conversations cannot silently delete workspaces; missing workspace holds execution | Service + Git |
| A18 | Runtime cannot resume a conversation | Confirm old writer stopped; new generation reconstructs context; late result cannot override | Service + runtime |
| A19 | Repository and Project sources return same issue | One task with two memberships; deleting one membership preserves other and history | Adapter + SQLite |
| A20 | Pagination, missed observation, duplicate event or partial outage | Full selection converges; no false withdrawal from partial data; no duplicate owner | Adapter |
| A21 | Source includes PR, draft, or issue from disallowed repository | PR/draft excluded; discovered issue grants no repository execution access | Adapter + runtime |
| A22 | Same issue appears in two Ensemble projects | Operator chooses placement; existing owner retained; newly conflicted unowned work cannot dispatch; no transfer of already-owned tasks; no permission union | UI + SQLite |
| A23 | Lose all memberships/readiness, close issue, or edit scope during execution | Hold new delegation and notify owner to stop safely; operator resolves resumption except confirmed own-delivery closure; harmless clarification proceeds, material outcome/scope change holds affected work for input | Service + adapter |
| A24 | External edit or PR write times out after success | Confirm remote identity/state before retry; UI never reports unconfirmed success | Adapter fault injection |
| A25 | Configure permissions; attempt denied Ensemble action | Ensemble action is rejected; runtime/deployment controls are passed correctly and their shell/API limits are disclosed | Service + UI |
| A26 | Hand back PR, receive feedback, restart, then merge or explicitly accept/close | Owner resumes on CI/review feedback; task remains waiting until settled; only through-merge projects merge autonomously; history persists | UI + Service + adapter |
| A27 | Capacity exhausted or repeatedly failing worker | Ordinary dispatch honors Ensemble capacity; capacity one does not deadlock parent/child work; confirmed transient failures retry at most twice; uncertainty holds; prolonged inactivity flags attention without automatic termination/restart | Service + runtime |
| A28 | Ready local task depends on another local or imported task in its project | Blocked task stays Ready and visible but starts no owner or new turn through Ensemble; local blocker Done or confirmed imported issue closure releases it automatically; cancellation does not; only operator can edit edges, with retries/version conflicts handled; self/cyclic and cross-project authored edges are rejected | UI + SQLite + runtime |
| A29 | Ready imported issue has native GitHub blocker outside selection or project | Full native dependency read holds Ensemble dispatch while blocker is open; no task import or repository access is inferred; closure or edge removal releases it, and reopening re-applies the gate | Adapter + Service + UI |
| A30 | Initial or later native dependency read or an imported blocker of a local task is incomplete, or a blocker appears during active work | Unknown state holds dispatch even before the first successful read and after a previously clear read; current turn may finish, but queued/new turns and delegation wait; ownership/results persist across restart; complete confirmed refresh resumes only when other controls permit | Adapter fault injection + runtime |

## Mandatory execution proofs

- **Unavailable coordinator:** persist eligible and held intents, crash/restart the
  service with policy/storage initialization failing. No queued intent reaches
  the runtime. Abrupt service death must terminate active execution and relevant
  tool descendants; unconfirmed termination retains writer ownership and blocks
  a replacement.
- **Admission race:** pause, stop, revoke authority or change a dependency while
  dispatch is pending. Prove a defined effective-admission boundary: either an
  already-admitted active turn is accounted for, or the pending turn stays held.
- **Uncertain launch:** inject lost response and crash before/after submission and
  binding. Reconcile one execution or hold uncertainty; zero observations must
  not trigger a duplicate. Repeat with superseded work revisions.
- **Stop and writer replacement:** stop before start, during launch and during a
  writing tool/process. Confirm termination including relevant descendants before
  another writer starts. Acknowledgement, timeout or lease expiry alone cannot pass.
- **Capacity and results:** at capacity one, owner delegation yields and worker
  results resume the owner. Duplicate/reordered results and restart produce one
  logical continuation; paused/stopped recipients remain held.
- **Workspace preservation:** crash during creation, retention and cleanup; verify
  task binding, uncommitted files, independent conversation lifecycle and safe
  handling of missing workspaces. Include repository-free and multiple-repository work.
- **Dependency completeness:** initial or later incomplete GitHub reads hold dispatch;
  native blocker closure/removal releases it, reopening reapplies the gate, and
  local cancellation does not clear a local blocker. Existing holds remain.
- **Access:** spoofed tool identity and stale approvals fail; effective runtime
  controls and their shell/credential limits are tested and accurately displayed.

A failure blocks the dependent feature rather than weakening its acceptance text.
The BB #665/#676 observations are regression examples, not dependencies on future
BB releases. Exact transactions and runtime-specific test seams belong to S01/S02.

## State and recovery boundary cases

These retain the earlier product failure cases with standalone ownership. They
are required observable outcomes, not prescribed database tables or an implementation
claim. Define exact receipt formats and transactions in the dependent contract.

| Scenario | Additional boundary to prove |
| --- | --- |
| A07 | Matching command retry replays the receipt despite an old expected version; changed payload conflicts; in-flight duplicate returns the original pending operation |
| A09 | Wake-up acknowledgement precedes a delayed send response; no state regression. Crash after a recorded action but before inbox acknowledgement; redelivery returns the recorded event disposition and caused-operation identities, rather than creating fresh commands |
| A14 | Pause after Ensemble records a pending turn but before it starts; restart; queued first turns and follow-ups remain held until resume |
| A15 | Stop races with delegation, result reporting and a delayed spawn response; hold survives restart, late conversations are reconciled/stopped, and resume clears only the operator stop |
| A16 | A writer queued behind Ensemble capacity does not retain a reservation; owner yields writing to child and later resumes; an early result does not release a still-active writer. Unknown execution or surviving background writer keeps workspace held |
| A18 | Replacement conversation receives pending events; stale destination messages/results cannot mutate current work; assignment instruction revision remains unchanged without explicit apply |
| A26 | PR handback keeps owner assignment open for feedback; task completion cannot silently leave active children or unresolved effects; child follow-up reopens the same assignment with a new work revision, preserving prior results and rejecting stale revision reports |
| A27 | Retry counter survives restart; Codex and Ensemble retries cannot multiply the two-retry allowance; unknown effects and permanent failures do not retry automatically |
| A28 | A scoped agent task edit cannot add/remove an edge. Matching operator command retry creates one edge and receipt; changed payload or stale dependent-task version conflicts. Adding a local edge while its dependent has an active or queued turn advances the control revision, lets an admitted turn stop safely, and holds queued/new turns and delegation across restart; removal re-evaluates other gates. |
| A30 | A newly discovered Ready issue's first dependency-list read fails or returns a partial page: no owner starts. A complete refresh with no blockers releases it; one with an open blocker keeps it held. Repeat after a previously confirmed clear read and for an unreadable imported blocker of a local task. |

A06/A09 cover several results arriving while the owner is active: no automatic
steer, one eligible continuation for pending events, individual acknowledgements,
and no lost wake-up when another event arrives while the batch is processed.

After a service restart, A08/A09/A14/A15 also prove automatic resumption of
previously enabled standalone work once reconciliation succeeds and every gate
permits it. Paused/stopped tasks remain held, unknown execution cannot gain a
replacement writer, and the prototype database is neither read nor resumed.

## Standalone-specific acceptance

These extend A01–A30; they are required alongside the product scenarios.

| ID | Required observable result | Delivery owner |
| --- | --- | --- |
| R01 | Codex App Server uses the existing operator login on macOS, including restart. Expired/unavailable login visibly holds affected work; no silent switch to API credentials or billing. | S01 proof; S02 integration |
| R02 | Defaults are four active turns globally and two per project; concurrent admission respects both. Waiting assignments yield slots. Lowering a limit holds new admissions until usage fits without silently killing active work. | S03 |
| R03 | Sleep assertion exists only during active execution and releases when idle or supervision ends. Forced sleep/wake reconciles execution before more dispatch, without duplicates. | S03 |
| R04 | Web UI is privately reachable over Tailscale and independently requires an Ensemble login. Unauthenticated requests cannot read private data or mutate controls; authenticated browser actions have session and origin/CSRF protection. | S04; verified in S05 |
| R05 | Conversation history and durable operator messages survive restart. Duplicate submission does not duplicate delivery; the next eligible turn receives the message without bypassing holds. No live steering is exposed. | S04; verified in S05 |
| R06 | Fresh standalone startup never reads or mutates the prototype database. Backup/restore preserves standalone records. Cutover records old active-work disposition before enabling competing work. | S02 fresh DB; S08 restore/cutover |

## Evidence ownership

S01 is a disposable runtime feasibility proof of A08/A09/A14–A16/A18/A25 and
R01 boundaries, not full product acceptance of those scenarios. S02–S04 implement
the contracts and their tests; S05 qualifies A01–A18, A25, A27, local A28/A30 and
R01–R05 plus R06 fresh-database separation. S06–S07 complete GitHub portions and
all A01–A30. S08 verifies R06 backup/restore and operational cutover. The operational
release gate requires both the S07 release candidate and S08 operational evidence;
a cutover is not a prerequisite for building or testing the release candidate.

Record every proof as passed, failed or unproved with its runtime/source identity,
observed effects and limits. Missing evidence is never a pass. The active execution
and descendant termination requirement remains mandatory; blocking a replacement
writer is the fallback when uncertain, not a substitute for proving termination.
