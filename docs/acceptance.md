# Standalone acceptance plan

**Acceptance scope reviewed and confirmed by Chris on 27 September 2026.** Scenario IDs A01–A30 retain the product obligations of the
[historical BB plan](acceptance-bb.md), with execution/UI/workspace ownership moved
to Ensemble by [ADR-1004](adr/1004-standalone-service.md). These are requirements,
not passing results. No previous BB test qualifies the standalone service.

Routing and accountability were amended on 28 September 2026 under
[ADR-1005](adr/1005-service-assignment-routing.md); R07–R10 cover the added scope.

On 1 October 2026 Chris added structured user questions and a required Kanban
view to the operator UI scope. A12 and UI01–UI03 below define their required
evidence; they do not claim implementation or runtime qualification.

## Gates

1. **Runtime feasibility:** S01 proves the minimum Codex integration and bounded
   coordination contract in [S01 #688](https://github.com/chrisbanes/ensemble/issues/688),
   as amended on 28 September. It does not require a complete service or OS sandbox.
2. **Local-task milestone:** service, UI and real-runtime journeys cover A01–A18,
   A25, A27, local A28/A30 and R07–R10. GitHub-dependent portions wait for integration.
3. **Operational release:** all A01–A30 and R01–R10, including both PR completion modes,
   real provider access and external-write recovery, plus UI01–UI03 below, with reviewed cutover.
   Chris deferred X01–X08 after the MVP on 1 October 2026; they do not gate this
   release or cutover. Native desktop visibility/handover is separate from the
   retained Codex App Server execution requirements.

Use real SQLite files and deterministic runtime doubles for fault coverage;
separately test the actual runtime and service/UI. Record exact source/runtime
versions, commands, observed effects, limitations and fixture cleanup. The agent
runs the complete journey; no incremental operator testing handoff. A harness
that successfully detects an unsafe effect still records a failed capability.

## Product scenarios

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| A01 | Install standalone service; restart | Service, migrations, tools and UI operate; failed initialization does not release pending work | Service + UI |
| A02 | Operator configures two projects and profiles | Shared profile can be selected by both projects with distinct project instructions; configuration is validated and retained; both initially paused | UI + runtime |
| A03 | Create/edit a local task in the UI; restart | Content and stable identity survive; unready by default; Create and start marks Ready without bypassing pause; no external issue is created | UI + SQLite |
| A04 | Enable a project with eligible tasks | Routing-enabled project starts a selected assignee without a preliminary lead turn; disabled routing uses explicit lead allocation; no chat setup ritual | Service + UI |
| A05 | Lead requests two bounded assignments | Independent conversations use selected profiles; project lead retains accountability with separate task conversation histories | Service + runtime |
| A06 | Worker reports while parent is idle | Result persists; one logical inbox event wakes parent; acknowledgement survives restart | Service + runtime |
| A07 | Repeat claim/delegate/report/response commands | Same operation returns same outcome; changed payload conflicts; no second worker/effect | SQLite + runtime |
| A08 | Lose spawn response after the runtime creates a worker | Restart reattaches only if the same live execution is uniquely identified; otherwise visible uncertainty and operator recovery retain holds; no blind retry or inference from historical resume | Runtime fault injection |
| A09 | Crash before/after result commit, send acceptance or acknowledgement | Durable result/inbox retained; accepted sends reconciled; no duplicate work | Runtime fault injection |
| A10 | Lead delegates implementation and review; review finds a defect | Lead chooses revision and follow-up from instructions; findings refer to artifact revision | Service scripted journey |
| A11 | Edit instructions/profile during existing work, then explicitly apply | Existing assignments retain recorded revisions until explicit apply for their next turn; new assignments use current revisions; process changes need no new stages or schema; permission revocations still apply | Service + UI |
| A12 | Agent asks a plain-text or structured question; operator answers during restart | Question appears in inbox and task detail beside a link to the requesting conversation; response is durable and bound to the originating task, assignment and runtime request; one eligible continuation receives it, respecting pause, Stop, dependency and ownership holds; see UI01–UI02 | UI + runtime |
| A13 | Approval denied or reviewed material changes | Action cannot execute using denied/stale approval; reason visible | Service + access integration |
| A14 | Pause project A while B has work | Current turns in A may finish; no new turns or follow-ups in A; B continues; results retained; resume revalidates | Service + UI |
| A15 | Stop a task with active lead and worker turns; supervisor loses contact or reports a writer still active | All active task execution, including its lead turn, receives best-effort cancellation requests; bounded observation never releases holds; effects may continue; Stop/writer/capacity holds survive restart until independently resolved; explicit resume alone cannot release ownership; files/history retained and uncertainty visible | Runtime fault injection |
| A16 | Two writers target one task workspace | One admission succeeds; others wait. Bound successful terminal status, ended Ensemble callbacks and no other hold/known unfinished execution permit one successor. Incomplete tool observation and unobserved-writer overlap are accepted. Crash, Stop, failure, missing/conflicting terminal identity/status and known survivors retain holds; independent tasks may proceed | Service + Git |
| A17 | Complete/archive work in each cleanup mode | Retain until archive by default; automatic cleanup waits for confirmed delivery and preservation checks; conversations cannot silently delete workspaces; missing workspace holds execution | Service + Git |
| A18 | Runtime cannot resume a conversation | Resolve old ownership independently or use qualified normal-success handoff before replacement; reconstruct context in a new generation; late result cannot override; historical resume is not live reattachment | Service + runtime |
| A19 | Repository and Project sources return same issue | One task with two memberships; deleting one membership preserves other and history | Adapter + SQLite |
| A20 | Pagination, missed observation, duplicate event or partial outage | Full selection converges; no false withdrawal from partial data; no duplicate task execution | Adapter |
| A21 | Source includes PR, draft, or issue from disallowed repository | PR/draft excluded; discovered issue grants no repository execution access | Adapter + runtime |
| A22 | Same issue appears in two Ensemble projects | Operator chooses placement; existing project placement and execution retained; newly conflicted work cannot start; no transfer of tasks with established assignments; no permission union | UI + SQLite |
| A23 | Lose all memberships/readiness, close issue, or edit scope during execution | Hold new delegation and notify lead and active assignees to stop safely; operator resolves resumption except confirmed own-delivery closure; harmless clarification proceeds, material outcome/scope change holds affected work for input | Service + adapter |
| A24 | External edit or PR write times out after success | Confirm remote identity/state before retry; UI never reports unconfirmed success | Adapter fault injection |
| A25 | Configure permissions; attempt denied Ensemble action | Ensemble action is rejected; runtime/deployment controls are passed correctly and their shell/API limits are disclosed | Service + UI |
| A26 | Hand back PR, receive feedback, restart, then merge or explicitly accept/close | Task-scoped lead resumes on CI/review feedback; task remains waiting until settled; only through-merge projects merge autonomously; history persists | UI + Service + adapter |
| A27 | Capacity exhausted or repeatedly failing worker | Ordinary dispatch honors Ensemble capacity; capacity one does not deadlock parent/child work; confirmed transient failures retry at most twice; uncertainty holds; prolonged inactivity flags attention without automatic termination/restart | Service + runtime |
| A28 | Ready local task depends on another local or imported task in its project | Blocked task stays Ready and visible but starts no task execution or new turn through Ensemble; local blocker Done or confirmed imported issue closure releases it automatically; cancellation does not; only operator can edit edges, with retries/version conflicts handled; self/cyclic and cross-project authored edges are rejected | UI + SQLite + runtime |
| A29 | Ready imported issue has native GitHub blocker outside selection or project | Full native dependency read holds Ensemble dispatch while blocker is open; no task import or repository access is inferred; closure or edge removal releases it, and reopening re-applies the gate | Adapter + Service + UI |
| A30 | Initial or later native dependency read or an imported blocker of a local task is incomplete, or a blocker appears during active work | Unknown state holds dispatch even before the first successful read and after a previously clear read; current turn may finish, but queued/new turns and delegation wait; ownership/results persist across restart; complete confirmed refresh resumes only when other controls permit | Adapter fault injection + runtime |

## Operator UI additions

These scenarios qualify the corresponding contracts in [SPEC.md](SPEC.md).
Use deterministic integration/browser coverage for fault cases and a bounded
actual-runtime journey for structured request/answer transport. Existing plain-text
question evidence cannot qualify structured runtime interactions. Keep delivery
sequencing in [#736](https://github.com/chrisbanes/ensemble/issues/736); these additions
do not reopen the completed bounded S01 feasibility gate.

Delivery UI01 #739 owns the bounded actual protocol and integrated service runtime
journeys in [native input evidence](evidence/ui01-runtime-input.md), plus deterministic
SQLite/hold/restart tests. T1 protocol and the separately granted actual T6 service
journey have passed for the bounded native adapter and curated service seam. These
results do not complete UI01/UI02 frontend acceptance; UI05 and parent #736 own the
forms and assembled UI.

Chris approved a bounded native-input and evidence-reuse amendment on 3 October
2026. UI01 below retains the full Ensemble form model, qualified by deterministic
service/SQLite/browser tests or Ensemble question tools. UI02 requires the native
shapes qualified by #739: its observed single-choice/custom-text round trip and
deterministic grouped-shape coverage. Native standalone free text, multiple
selection and recommendation fields are not additional MVP runtime-proof gates.
Unsupported native requests stay visibly unresolved; this does not claim support,
permit fabricated answers or waive identity, persistence, duplicate-prevention or
hold requirements.

UI07 #745 and S07b #697 share one attributable evidence inventory and may reuse
the same still-valid bounded assembled UI/service/runtime journey. Reuse #739/#743
evidence with its source/runtime identity and scope; add missing delivery/provider
integration checks in S07b. Test pause, Stop, restart, replay, failure and session
expiry combinations deterministically unless a changed integration boundary or a
demonstrated failure requires a bounded live check. A later gate alone is not a
reason to repeat a live journey. Chris's final integrated visual/usability
acceptance remains required on #736.

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| UI01 | Agent issues individual and grouped questions using free text, single choice and multiple choice; operator answers from inbox or task detail on desktop and phone | Question/option text, descriptions, explicit recommendations and selection constraints are preserved; custom text is available when permitted; recommended/preselected choices do not submit themselves; validation identifies the affected question; failed submission retains input and unresolved status; confirmed submission shows a recorded answer, distinct from approval or ordinary messaging | Service + UI + SQLite |
| UI02 | Selected runtime issues its supported AskUserQuestion-style equivalent; restart around answer persistence/delivery, replay submissions, or answer a stale/cancelled/already answered request | The durable question maps to the exact requesting assignment/runtime request; persisted answers survive restart and produce no duplicate answer or continuation; stale/cancelled requests reject new answers and conflicting repeats cannot replace accepted answers; pause, Stop, dependency and ownership holds remain effective; unsupported/unavailable interactions are explicit, with no fabricated answer or silent chat fallback; record the actual runtime API/version and observed round trip | Runtime + service fault injection + UI |
| UI03 | Switch List/Board in cross-project and project views with shared filters and a mix of local/imported tasks, including Ready-but-blocked, waiting, paused, stopping and uncertain work | Same filtered task set in both views; switching changes no task state; cards show title, project, lead, imported source identity and relevant wait/intervention reasons, and open the same detail; all states remain reachable on desktop and narrow screens with keyboard-accessible controls; readiness remains distinct from execution holds; GitHub state/Project fields remain source-owned; any offered card transition uses a permitted command and cannot bypass holds or silently write to GitHub; drag-and-drop is not required | UI + service + adapter |

### Task overview and evidence design review — 3 October 2026

Review the [task overview specification](SPEC.md#task-overview-and-evidence--design-direction-3-october-2026)
in Pen before implementation. These observable outcomes guide design review and
subsequent UI validation; a mockup does not prove persistence, permissions, runtime
behaviour or delivery. GitHub issues retain delivery scope and sequencing under
[#736](https://github.com/chrisbanes/ensemble/issues/736), with task detail in
[#742](https://github.com/chrisbanes/ensemble/issues/742) and assembled UI acceptance
in [#745](https://github.com/chrisbanes/ensemble/issues/745).

The [Pen source](../design/design.pen) and
[interaction/state handoff](../design/DESIGN.md) record the reviewed design.
Chris agreed the extended requirements and issue ownership on 3 October 2026:
**design reviewed; implementation deferred**. Final integrated visual/usability
acceptance remains open. The handoff also records unverified comparison-image
loading after source-asset relocation; resolve that before claiming those images
have passed saved-design visual review.

- **Brief provenance:** local and imported examples show the desired outcome,
  supplied criteria and recorded decisions without inventing missing content.
  GitHub requirements stay source-owned; agent plans and decisions are distinct.
- **Delegation:** parallel assignments, including two using the same profile,
  have distinguishable responsibilities, requesters and result destinations.
  The project lead remains identifiable; known waits and unknown state are clear.
- **Results and evidence:** show current and earlier results with reporting
  assignment and relevant revision. Recorded evidence-to-criterion relationships
  are visible. Agent claims, recorded verification and missing, stale, unavailable
  or redacted evidence remain distinguishable; absence is never a pass.
- **Navigation and attention:** List, Board, overview and attention entry points
  preserve task/project/source context. Ordinary progress and dependency waiting
  stay outside the attention inbox. Questions, approvals and uncertain execution
  remain visible and their existing controls reachable.
- **Reading and responsive states:** laptop and phone designs cover empty tasks,
  long briefs, parallel work, pending requests, failed refresh and unavailable
  evidence. Expanded detail, reading position and unfinished replies survive
  updates; routine progress does not interrupt the operator's reading.

Qualify the reviewed extension against the real UI/service with attributable
records. Use deterministic browser/service/persistence coverage for these cases;
static Pen fixtures do not pass them:

- **Criteria and comparison:** supplied criteria with supported, failed,
  unverified and stale evidence keep their result/assignment/revision attribution
  and imply no overall pass. Correctly paired before/after captures, missing sides,
  unavailable/redacted material and revision mismatch remain distinguishable on
  desktop and phone; earlier evidence stays reachable.
- **Feedback:** opening from a result, criterion or artifact preserves its exact
  context. The editable draft names the local lead destination. Confirmed sends
  show a receipt; confirmed failures retain input for retry; uncertain outcomes
  reconcile before resending without duplicate messages. No feedback action
  grants approval, changes task state or posts to GitHub.
- **Viewing reference:** new results, superseded evidence and changed source
  requirements are distinguishable from the viewed revision. No baseline,
  unknown comparison and failed refresh are explicit. Viewing alone never
  records approval or clears an independent hold.
- **Assignment context:** captured supplier/brief/instruction/profile/source
  references are distinct from current requirements, with omissions visible.
  Available references are not labelled read without evidence; secrets and
  unavailable runtime history are not exposed.
- **Changes and delivery:** recorded diff/commit/PR/check/finding relationships
  identify the checked revision and known repair owner. No PR, changed head,
  stale provider data and merged-but-incomplete task states remain truthful.
  Refresh performs no write, and exact approvals and independent holds persist.
- **Search and return:** search is reachable through shared desktop and phone
  navigation. Similar cross-project matches each retain project/task/type
  attribution; opening a historical match reaches its exact section/revision.
  Query, filters, selection and reading position survive opening and returning,
  including the originating workspace view. Empty results, partial retained
  coverage, failure and inaccessible material never imply complete capture.
  Review-only state specimens are absent from product navigation. Verify keyboard
  access and preservation of disclosures/drafts on the connected journeys.

#742 owns these task/review/search behaviours and required shared navigation.
#745 checks their integration with Overview, Inbox, project/cross-project
List/Board and task detail wherever exposed, using the shared #745/#697 evidence
inventory. Reuse unaffected evidence and limit live checks to changed integration
boundaries or demonstrated gaps under the existing finite acceptance amendment.
#736 retains Chris's final integrated UI acceptance; #741 is not reopened.

Link the reviewed Pen design from the specification and relevant delivery issues
before implementation, including its interaction and state handoff. No routes,
API schema, artifact-storage mechanism or new runtime capability is prescribed
by these checks. Existing evidence remains historical; these additions do not
claim completed UI04, release qualification or reopened native integrations.

### Operator UX refinements — 3 October 2026

These approved requirements await implementation and qualification. UX identifiers
are acceptance scenarios, not delivery issues or claims that existing evidence
passes them. Exercise the same fixtures through Overview, Inbox, cross-project and
project List/Board, and task detail wherever applicable. Check desktop and phone
layouts, keyboard access, readable text and distinguishable task titles.

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| UX01 | A failed check has a recorded agent-owned repair; a different running task has no evidence identifying the repair owner | The first shows the repair responsibility without creating operator attention solely for the check; the second does not infer repair from running activity and shows responsibility as unknown. Independent questions, approvals and recovery problems remain visible; all applicable entry points agree on state and next actor | UI + service |
| UX02 | Open a specific operator question or approval from Overview, Inbox or task detail, inspect its evidence, respond and return | The request explains what is needed, its requester when known, why the operator is needed and the permitted response. Evidence stays within task context. Exact approval material remains available. Confirmation reflects the recorded outcome; returning preserves filters and position. Failed submission retains input; stale evidence is labelled; answering does not clear an independent dependency hold | UI + service + SQLite |
| UX03 | Inspect actionable readiness, completion with evidence and no decision, cancellation, provider closure without delivery, capacity waiting and uncertain execution | These situations remain distinguishable; provider closure does not imply task completion, normal capacity waiting creates no attention, and uncertainty retains its recovery explanation. Attention does not replace work state. The existing board mapping is preserved | UI + service + adapter |
| UX04 | Open a task containing several assignments and conversations, then inspect its history as updates arrive | The initial view explains the outcome, current situation, next actor or unknown responsibility, unresolved decisions and relevant evidence. Lead accountability and assignment/conversation identities remain distinct. Recorded facts and attributed excerpts suffice without reading runtime output; omissions/staleness remain visible. Updates preserve reading position, disclosure and unfinished replies | UI + service |
| UX05 | Create a task with optional context, references, assignee and dependencies, collapse/reopen those controls, then submit with a validation error or capacity wait | Project, title and outcome remain prominent; supplied optional settings have a visible summary and retain values through disclosure. Errors remain discoverable. Create and start / Save draft retain their semantics; confirmed creation and execution waiting are distinct. Existing draft and unknown-outcome reconciliation guarantees remain effective | UI + service + SQLite |

## Implemented service and integration proofs

These are later S02–S07 integration obligations (GitHub coverage starts in S06).
S01 uses bounded fixtures for the corresponding feasibility boundaries, as mapped
in delivery; it does not implement
or pass these complete product scenarios.

- **Unavailable coordinator:** persist eligible and held intents, crash/restart the
  service with policy/storage initialization failing. No queued intent reaches
  the runtime. Admitted turns/tools may survive abrupt service or App Server death;
  preserve writer/capacity holds, expose uncertainty and block replacement until
  independently resolved. Verify the documented operator recovery path.
- **Admission race:** pause, stop, revoke authority or change a dependency while
  dispatch is pending. Prove a defined effective-admission boundary: either an
  already-admitted active turn is accounted for, or the pending turn stays held.
- **Uncertain launch:** inject lost response and crash before/after submission and
  binding. Reconcile one execution or hold uncertainty; zero observations must
  not trigger a duplicate. Repeat with superseded work revisions.
- **Stop and writer replacement:** stop before start, during launch and during a
  writing tool/process. Persist Stop, request cancellation and observe for a bounded
  interval. Unresolved Stop/writer/capacity holds survive late effects and restart.
  Normal successful bound terminal turns may hand off after all Ensemble callbacks
  end and no other hold or known unfinished execution remains; serialize exactly one
  successor. A missing diagnostic tool item alone does not hold normal completion;
  missing/conflicting terminal identity/status does. Test both and the other negative
  hold cases, and disclose accepted unobserved-effect/detached-child overlap. Never
  infer physical
  exclusion from acknowledgement, timeout, lease expiry or normal handoff.
- **Capacity and results:** at capacity one, lead or parent delegation yields and worker
  results resume the recorded recipient. Duplicate/reordered results and restart produce one
  logical continuation; paused/stopped recipients remain held.
- **Workspace preservation:** crash during creation, retention and cleanup; verify
  task binding, uncommitted files, independent conversation lifecycle and safe
  handling of missing workspaces. Include repository-free and multiple-repository work.
- **Dependency completeness:** initial or later incomplete GitHub reads hold dispatch;
  native blocker closure/removal releases it, reopening reapplies the gate, and
  local cancellation does not clear a local blocker. Existing holds remain.
- **Access:** spoofed tool identity and stale approvals fail; qualify the design's
  explicit write/network/approval policy with attributable command evidence and
  disclose broad reads, temporary roots and ambient-access limits. A standalone
  command result cannot prove persisted model-turn history; test that separately.
  Strict outside-read denial is not part of default acceptance. S02–S05 also test
  ordinary file edits and the broader enabled tool policy. S01 does not certify
  every tool class or require a general model-tool allowlist. Under the approved
  [S01-only evidence amendment](https://github.com/chrisbanes/ensemble/issues/688),
  S01 records model-originated escalation rejection as unproved and uses the existing
  effective-policy and attributable write/network/history evidence. The product's
  denial requirement remains: S02 implements and deterministically tests rejection
  of unexpected approval callbacks in the runtime adapter without granting access;
  S05 tests the integrated approval flow before release. A fixture does not prove
  Codex rejected a model-originated escalation. Demonstrated policy breaches still
  block the affected capability.

A failure blocks the dependent claim. Only an explicit product decision changes a
requirement; the 28 September reset is such a decision, not a retroactive probe pass.
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
| A16 | A writer queued behind Ensemble capacity does not retain a reservation; lead or parent yields writing to child and later resumes; an early result does not release a still-active writer. Unknown execution or a known surviving background writer keeps workspace held; untracked-child overlap after qualified normal success remains accepted |
| A18 | Replacement conversation receives pending events; stale destination messages/results cannot mutate current work; assignment instruction revision remains unchanged without explicit apply |
| A26 | PR handback preserves the task-scoped lead continuation for feedback; task completion cannot silently leave active children or unresolved effects; child follow-up reopens the same assignment with a new work revision, preserving prior results and rejecting stale revision reports |
| A27 | Retry counter survives restart; Codex and Ensemble retries cannot multiply the two-retry allowance; unknown effects and permanent failures do not retry automatically |
| A28 | A scoped agent task edit cannot add/remove an edge. Matching operator command retry creates one edge and receipt; changed payload or stale dependent-task version conflicts. Adding a local edge while its dependent has an active or queued turn advances the control revision, lets an admitted turn stop safely, and holds queued/new turns and delegation across restart; removal re-evaluates other gates. |
| A30 | A newly discovered Ready issue's first dependency-list read fails or returns a partial page: no task execution starts. A complete refresh with no blockers releases it; one with an open blocker keeps it held. Repeat after a previously confirmed clear read and for an unreadable imported blocker of a local task. |

A06/A09 cover several results arriving while the recorded recipient is active: no automatic
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
| R01 | Codex App Server uses the existing operator login on macOS, including restart. Expired/unavailable login visibly holds affected work; no silent switch of agent execution to API credentials or billing. TypeSafe routing credentials are a separate opt-in integration. | S01 proof; S02 integration |
| R02 | Defaults are four active turns globally and two per project; concurrent admission respects both. Waiting assignments yield slots. Lowering a limit holds new admissions until usage fits without silently killing active work. | S03 |
| R03 | Sleep assertion exists only during active execution and releases when idle or supervision ends. Forced sleep/wake reconciles execution before more dispatch, without duplicates. | S03 |
| R04 | Web UI is privately reachable over Tailscale and independently requires an Ensemble login. Unauthenticated requests cannot read private data or mutate controls; authenticated browser actions have session and origin/CSRF protection. | S04; verified in S05 |
| R05 | Conversation history and durable operator messages survive restart. Duplicate submission does not duplicate delivery; the next eligible turn receives the message without bypassing holds. No live steering is exposed. | S04; verified in S05 |
| R06 | Fresh standalone startup never reads or mutates the prototype database. Backup/restore preserves standalone records. Cutover records old active-work disposition before enabling competing work. | S02 fresh DB; S08a backup/restore preparation; S08b final recovery/proposal; S08c actual cutover |
| R07 | Routing-enabled eligible task supplies its initial brief without a lead turn. Explicit permitted assignee bypasses TypeSafe; disabled projects allocate through the lead without API calls. Profile capabilities and project routing guidance are used; ineligible profiles cannot be selected and full transcripts/credentials are excluded. | S04; verified in S05 |
| R08 | Uncertain/no-fit/missing-context/API-failure outcomes wake the lead once with the brief and evidence. Lead can allocate without TypeSafe. Busy selected profile waits for capacity; repairs retain assignee. All dispatch rechecks current permissions and holds. | S03/S04; verified in S05 |
| R09 | Nested results resume their delegator, initial results resume the task-scoped lead, including restart and capacity-one cases. Two tasks using the lead profile keep separate histories. Worker success alone cannot complete a task; lead completion requests satisfy service gates. | S04; verified in S05 |
| R10 | Duplicate requests, delayed responses, timeout, restart, task/brief/profile changes, opt-out and permission revocation cannot cause duplicate or stale dispatch. Persist routing provenance and disposition; rejected stale recommendations do not grant authority. Representative routing evidence records mistakes, fallback, latency and cost without assuming calibrated thresholds or savings. | S04; verified in S05 |

## ChatGPT and native Codex acceptance

Chris deferred this integration after the MVP on 1 October 2026, superseding the
30 September first-release extension under
[ADR-1006](adr/1006-chatgpt-and-native-codex.md). X01–X08 retain future acceptance
without reopening completed standalone slices or gating MVP release/cutover.
Neither integration has passed. X01–X05 delivery slices are paused under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734) until Chris explicitly
reopens the work and current APIs, scope and dependencies are revalidated.

| ID | Required observable result |
| --- | --- |
| X01 | In a disposable local repository/worktree, supported integration creates a main native task with linked, inspectable worker conversations, opens its task/change view and uses the retained Ensemble worktree. Record Ensemble project, native host/thread and workspace identities; saved host project placement/linkage is optional. Unsupported or failed native visibility or handover returns evidence and scope for review; App Server thread creation alone is not a pass. |
| X02 | Human inspection starts no turn. Explicit handover holds all further Ensemble dispatch for the task before human continuation; explicit return reconciles settled execution and workspace changes and rechecks permissions, revisions and other holds. Restart, stale/replayed actions, idle status and known active execution neither duplicate launch nor implicitly return ownership. Existing recovery holds remain; no physical containment claim is added. |
| X03 | With the plugin disabled, Ensemble remains fully usable. With it enabled, both web UI and ChatGPT exercise daily task creation/tracking, durable messages, answers and exact-material approvals through the same service rules. Replay/stale inputs, pause, Stop, dependencies and capacity preserve their existing semantics. Setup and recovery may use the web UI. |
| X04 | Only explicitly enabled projects are available to the connected operator. Tools, components, context, errors and events exclude credentials, private instructions and raw runtime logs. Unauthorised/cross-project requests, project opt-out and access revocation fail closed, including retained UI state and later delivery. |
| X05 | Guided installation links an authenticated HTTPS MCP endpoint; authorised tools work, invalid/expired/wrong-audience credentials fail and revocation takes effect. Only the plugin and required authentication/discovery surfaces are public; the operator UI and runtime remain private. No automatic endpoint provisioning or hosted relay is required. |
| X06 | Explicit filtered subscriptions deliver completion, question and approval events. Callback verification/signatures, stable identity across bounded retries, duplicate/out-of-order events, restart, expiry, unsubscribe, opt-out and revocation behave correctly. Inbox/read state survives missing deliveries; webhook receipt is not acknowledgement. Events explain or request input and cannot authorise writes. |
| X07 | Against the chosen real ChatGPT host, connect the packaged plugin, open project/task navigation and task detail beside a conversation, create a task, send a durable message, answer a question, approve/deny exact material and receive a subscribed event. Verify committed provider/service state and fixture cleanup; host feature gaps are recorded rather than inferred from screenshots or protocol doubles. |
| X08 | Qualify the assembled native Codex and optional ChatGPT journeys against the release candidate, including identity/ownership after service restart, workspace preservation and plugin subscription/auth state. Reuse still-valid evidence; record source/runtime/host versions, limitations and cleanup. Self-hosted setup and operational restore preserve the new durable records and require relinking/reconciliation when applicable. |

When this work resumes, use real SQLite and deterministic protocol/transport faults
for negative coverage, then bounded disposable native Codex and ChatGPT journeys. Existing operational
backup/restore and reviewed cutover remain required. The implementation agent owns
validation; do not hand incremental testing to the operator. Composer mentions,
full admin/recovery parity, historical task import and stronger runtime containment
are not additional gates. A failed native proof pauses its dependent implementation
for the approved scope review; it does not silently remove X01/X02.

## Evidence ownership

The [S05 local qualification report](evidence/s05-local-qualification.md) records
the current partial evidence and unproved rows; it does not qualify the
operational release. Chris deferred the physical R03 sleep/wake proof from
immediate #695 completion to [follow-up #732](https://github.com/chrisbanes/ensemble/issues/732).
R03 remains unproved and required for later release qualification; the deferral
does not waive that gate or cutover evidence.

S01 is a disposable runtime feasibility proof of A08/A09/A14–A16/A18/A25 and
R01 boundaries, not full product acceptance of those scenarios. S02–S04 implement
the contracts and their tests; S05 assembles evidence for A01–A18, A25, A27, local
A28/A30 and R01–R05, R07–R10 plus R06 fresh-database separation. Physical R03
sleep/wake proof is deferred to follow-up #732; it remains unproved and does not
pass the operational release gate. S06–S07 complete GitHub portions and all
A01–A30. S08a prepares R06 backup/restore after S04b, concurrently with UI/local/external
qualification. S08b verifies final-schema and external-effect recovery against the
S07 release candidate, reusing valid S08a evidence, and delivers a reviewed,
executable cutover proposal. Under the approved 3 October split, #698 may complete
after that technical evidence and proposal review; actual separately authorised
cutover is tracked by S08c #761. Technical readiness does not establish deployed
operation or completed cutover. The operational release gate retains the S07
candidate, required S08 evidence, physical R03 proof before operational use on the
Mac, and verified authorised cutover;
X01–X08 are deferred and do not block the MVP. The #698 prerequisite on #728 is removed;
a cutover is not a prerequisite for building or testing the release candidate.
S08a evidence is composed deliberately: deterministic T4 tests prove exact
restored-execution receipt reconciliation, independent Stop/Resume and one
post-recovery admission; the disposable launchd proof backs up/restores
populated paused/unready public records and confirms start/restart/stop without
admission. The latter does not inject a live exact recovery receipt because
#704 does not own a recovery-control surface. Neither result passes S08b's
final-schema/external-effect checks or S08c's actual old-work disposition/cutover.

Record every proof as passed, failed or unproved with its runtime/source identity,
observed effects and limits. Missing evidence is never a pass. Earlier termination,
cleanup and outside-read failures remain failures against their tested stronger
contracts. The revised S01 gate requires integration and conservative coordination,
not guaranteed descendant termination, strict outside-read denial or universal live
reattachment. Unresolved crash/Stop/failure holds still require independent recovery;
changing this contract neither passes S01 nor releases dependent work.

## S04d operator integration evidence

Issue #694 mounts the Runtime and Coordination route slots in the production
operator command. The exact-material approval boundary, real-SQLite adapter
coverage, shared HTTP guards and Chromium journey are described in the
[S04d design](design/s04d-operator-integration.md). Its bounded real-runtime
operator journey is recorded in
[S04d evidence](evidence/s04d-operator-2026-09-30.md); it is evidence for the
observed journey only, not universal termination or reattachment.

The private-access script extends the existing S04c proof to the new private
views and capacity write. The bounded proof through an approved disposable
Tailscale HTTPS route passed from the fixture host, confirming private HTTPS
and the browser boundary from that host. It does not prove independent-device
reachability or constitute S05 acceptance. Missing fixture configuration is a
blocker, not a waived gate. This work does not authorize persistent Serve
changes, deployment or cutover.

## React foundation implementation status

Delivery [UI02 #740](https://github.com/chrisbanes/ensemble/issues/740) adds the
staged React `/app` shell, same-origin validated APIs, existing session/security
boundary, durable command receipts and retained-control navigation. Its scope
and evidence are recorded in the [foundation contract](design/ui02-foundation.md)
and [foundation evidence](evidence/ui02-foundation.md).

This delivery name is distinct from the existing **UI02 native-question runtime
acceptance scenario**. That scenario remains unproved; no native availability is
claimed. Delivery [UI03 #741](https://github.com/chrisbanes/ensemble/issues/741)
adds attention overview, shared List/Board and atomic local composer, with
[contract](design/ui03-tasks.md) and [service/browser evidence](evidence/ui03-tasks.md).
UI01/UI04–UI07 screens, runtime-question integration and parent #736
final acceptance remain separate. Existing controls stay available. This
foundation does not authorize deployment or cutover.

UI06 presentation evidence is recorded in [configuration and recovery evidence](evidence/ui06-configuration.md). Fixture browser/API evidence qualifies the changed same-origin presentation; real-runtime/provider, final visual/usability UI07 and release/cutover gates remain separate.

Delivery [UI08 #765](https://github.com/chrisbanes/ensemble/issues/765)
reconciles the shared React/production-HTML presentation foundation. Its
[contract](design/ui08-foundation.md) and [evidence](evidence/ui08-foundation.md)
record owned components, responsive browser checks, preserved retained forms,
font/CSP verification and visual gaps. This does not complete the human UI
acceptance or release/cutover gates owned by #736.
