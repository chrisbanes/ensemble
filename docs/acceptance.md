# Standalone acceptance plan

This plan states the evidence the standalone service needs before release: the
gates, the product scenarios, the evidence required for each area and its current
state, the boundary cases and who owns the evidence. The scope is reviewed and
confirmed; a change to scope or guarantees returns for review.

Scenario IDs A01–A30 retain the product obligations of the BB plan (kept in git
history), with execution, UI and workspace ownership moved to Ensemble by
[ADR-1004](adr/1004-standalone-service.md). Scenarios are requirements, not passing
results, and no BB test qualifies the standalone service.
[ADR-1005](adr/1005-service-assignment-routing.md) adds routing and accountability
(R07–R10).

Each area records one of three states:

- **Passed:** the named evidence meets the criteria within the scope its record states.
- **Bounded:** the evidence is a finite journey, a fixture or partial coverage; the
  claim stops at the limits its record states.
- **Unproved:** no qualifying evidence exists, so the requirement stands.

## Gates

1. **Runtime feasibility:** prove the minimum Codex integration and bounded
   coordination contract in [S01 #688](https://github.com/chrisbanes/ensemble/issues/688).
   It does not require a complete service or OS sandbox.
2. **Local-task milestone:** service, UI and real-runtime journeys cover A01–A18,
   A25, A27, local A28/A30 and R07–R10. GitHub-dependent portions are qualified
   with the GitHub integration.
3. **Operational release:** all A01–A30 and R01–R10, including both PR completion
   modes, real provider access and external-write recovery, plus UI01–UI03, with a
   reviewed cutover. X01–X08 are deferred after the MVP
   ([ADR-1006](adr/1006-chatgpt-and-native-codex.md)); they do not gate this release
   or cutover. Native desktop visibility/handover is separate from the retained
   Codex App Server execution requirements.

Use real SQLite files and deterministic runtime doubles for fault coverage;
separately test the actual runtime and service/UI. Record exact source/runtime
versions, commands, observed effects, limitations and fixture cleanup. The agent
runs the complete journey; there is no incremental operator testing handoff. A
harness that successfully detects an unsafe effect still records a failed
capability.

## Product scenarios

### Service and runtime scenarios

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

### Standalone-specific scenarios

These extend A01–A30 and are required alongside them. R07–R10 cover assignment
routing and accountability.

| ID | Required observable result |
| --- | --- |
| R01 | Codex App Server uses the existing operator login on macOS, including restart. Expired/unavailable login visibly holds affected work; no silent switch of agent execution to API credentials or billing. TypeSafe routing credentials are a separate opt-in integration. |
| R02 | Defaults are four active turns globally and two per project; concurrent admission respects both. Waiting assignments yield slots. Lowering a limit holds new admissions until usage fits without silently killing active work. |
| R03 | Sleep assertion exists only during active execution and releases when idle or supervision ends. Forced sleep/wake reconciles execution before more dispatch, without duplicates. |
| R04 | Web UI is privately reachable over Tailscale and independently requires an Ensemble login. Unauthenticated requests cannot read private data or mutate controls; authenticated browser actions have session and origin/CSRF protection. |
| R05 | Conversation history and durable operator messages survive restart. Duplicate submission does not duplicate delivery; the next eligible turn receives the message without bypassing holds. No live steering is exposed. |
| R06 | Fresh standalone startup never reads or mutates the prototype database. Backup/restore preserves standalone records. Cutover records old active-work disposition before enabling competing work. |
| R07 | Routing-enabled eligible task supplies its initial brief without a lead turn. Explicit permitted assignee bypasses TypeSafe; disabled projects allocate through the lead without API calls. Profile capabilities and project routing guidance are used; ineligible profiles cannot be selected and full transcripts/credentials are excluded. |
| R08 | Uncertain/no-fit/missing-context/API-failure outcomes wake the lead once with the brief and evidence. Lead can allocate without TypeSafe. Busy selected profile waits for capacity; repairs retain assignee. All dispatch rechecks current permissions and holds. |
| R09 | Nested results resume their delegator, initial results resume the task-scoped lead, including restart and capacity-one cases. Two tasks using the lead profile keep separate histories. Worker success alone cannot complete a task; lead completion requests satisfy service gates. |
| R10 | Duplicate requests, delayed responses, timeout, restart, task/brief/profile changes, opt-out and permission revocation cannot cause duplicate or stale dispatch. Persist routing provenance and disposition; rejected stale recommendations do not grant authority. Representative routing evidence records mistakes, fallback, latency and cost without assuming calibrated thresholds or savings. |

### Operator UI scenarios

These scenarios qualify the corresponding contracts in
[SPEC.md](SPEC.md#operator-interface-and-human-requests). A12 and UI01–UI03 cover
structured user questions and the required Kanban view. Use deterministic
integration/browser coverage for fault cases and a bounded actual-runtime journey
for structured request/answer transport. Existing plain-text question evidence
cannot qualify structured runtime interactions.

UI01 requires the full Ensemble form model, qualified by deterministic
service/SQLite/browser tests or Ensemble question tools. UI02 requires the native
shapes qualified by the [native input evidence](evidence/ui01-runtime-input.md):
its observed single-choice/custom-text round trip and deterministic grouped-shape
coverage. Native standalone free text, multiple selection and recommendation
fields are not additional MVP runtime-proof gates. Unsupported native requests stay
visibly unresolved; this does not claim support, permit fabricated answers or waive
identity, persistence, duplicate-prevention or hold requirements.

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| UI01 | Agent issues individual and grouped questions using free text, single choice and multiple choice; operator answers from inbox or task detail on desktop and phone | Question/option text, descriptions, explicit recommendations and selection constraints are preserved; custom text is available when permitted; recommended/preselected choices do not submit themselves; validation identifies the affected question; failed submission retains input and unresolved status; confirmed submission shows a recorded answer, distinct from approval or ordinary messaging | Service + UI + SQLite |
| UI02 | Selected runtime issues its supported AskUserQuestion-style equivalent; restart around answer persistence/delivery, replay submissions, or answer a stale/cancelled/already answered request | The durable question maps to the exact requesting assignment/runtime request; persisted answers survive restart and produce no duplicate answer or continuation; stale/cancelled requests reject new answers and conflicting repeats cannot replace accepted answers; pause, Stop, dependency and ownership holds remain effective; unsupported/unavailable interactions are explicit, with no fabricated answer or silent chat fallback; record the actual runtime API/version and observed round trip | Runtime + service fault injection + UI |
| UI03 | Switch List/Board in cross-project and project views with shared filters and a mix of local/imported tasks, including Ready-but-blocked, waiting, paused, stopping and uncertain work | Same filtered task set in both views; switching changes no task state; cards show title, project, lead, imported source identity and relevant wait/intervention reasons, and open the same detail; all states remain reachable on desktop and narrow screens with keyboard-accessible controls; readiness remains distinct from execution holds; GitHub state/Project fields remain source-owned; any offered card transition uses a permitted command and cannot bypass holds or silently write to GitHub; drag-and-drop is not required | UI + service + adapter |

### Operator UX scenarios

Exercise the same fixtures through Overview, Inbox, cross-project and project
List/Board, and task detail wherever applicable. Check desktop and phone layouts,
keyboard access, readable text and distinguishable task titles.

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| UX01 | A failed check has a recorded agent-owned repair; a different running task has no evidence identifying the repair owner | The first shows the repair responsibility without creating operator attention solely for the check; the second does not infer repair from running activity and shows responsibility as unknown. Independent questions, approvals and recovery problems remain visible; all applicable entry points agree on state and next actor | UI + service |
| UX02 | Open a specific operator question or approval from Overview, Inbox or task detail, inspect its evidence, respond and return | The request explains what is needed, its requester when known, why the operator is needed and the permitted response. Evidence stays within task context. Exact approval material remains available. Confirmation reflects the recorded outcome; returning preserves filters and position. Failed submission retains input; stale evidence is labelled; answering does not clear an independent dependency hold | UI + service + SQLite |
| UX03 | Inspect actionable readiness, completion with evidence and no decision, cancellation, provider closure without delivery, capacity waiting and uncertain execution | These situations remain distinguishable; provider closure does not imply task completion, normal capacity waiting creates no attention, and uncertainty retains its recovery explanation. Attention does not replace work state. The existing board mapping is preserved | UI + service + adapter |
| UX04 | Open a task containing several assignments and conversations, then inspect its history as updates arrive | The initial view explains the outcome, current situation, next actor or unknown responsibility, unresolved decisions and relevant evidence. Lead accountability and assignment/conversation identities remain distinct. Recorded facts and attributed excerpts suffice without reading runtime output; omissions/staleness remain visible. Updates preserve reading position, disclosure and unfinished replies | UI + service |
| UX05 | Create a task with optional context, references, assignee and dependencies, collapse/reopen those controls, then submit with a validation error or capacity wait | Project, title and outcome remain prominent; supplied optional settings have a visible summary and retain values through disclosure. Errors remain discoverable. Create and start / Save draft retain their semantics; confirmed creation and execution waiting are distinct. Existing draft and unknown-outcome reconciliation guarantees remain effective | UI + service + SQLite |

### Post-MVP task workspace inspection

WI01–WI13 are requirements for post-MVP workspace inspection, tracked in
[#776](https://github.com/chrisbanes/ensemble/issues/776). They add nothing to the
release or cutover gates. Preserve the task workspace behaviour and the pause on
X01–X08. Recorded evidence is under
[Task workspace inspection evidence](#task-workspace-inspection-evidence).

| ID | Scenario | Required outcome |
| --- | --- | --- |
| WI01 | Browse repository-free and multiple-repository task workspaces | Files and generated outputs are inspectable with explicit task/repository identity. Ignored clutter is hidden initially and can be revealed; excluded sensitive content remains inaccessible. Missing/removed workspaces are explicit. |
| WI02 | Open text/code, Markdown, raster images, PDF, binary and oversized files | Supported previews are bounded and usable; unsupported, excluded and oversized states give truthful limits. No download/export action is provided. Inspected active content cannot execute with application authority. |
| WI03 | Attempt traversal, absolute-path injection, symlink escape, cross-task access and file replacement during reads/capture | Service-side validation prevents access outside the authorised task scope and applies the same exclusions to listings, previews, captures and retained evidence. Inconsistent reads fail with an explicit gap rather than false exactness. |
| WI04 | Select Branch and Uncommitted in a workspace with committed, staged, unstaged, untracked, deleted and renamed changes | Branch compares against the merge base with the identified task base branch; Uncommitted offers staged/unstaged filters. Display the exact baseline and observation time; binary and unsupported entries remain visible. Each repository has its own baseline. Git targets are unavailable for repository-free workspaces. |
| WI05 | Base branch is unknown or a selected local branch has no usable baseline | Explain the missing baseline and allow local base selection. No implicit guessed baseline, fetch or checkout occurs. An unusable comparison stays unavailable. |
| WI06 | Complete successive real agent turns, then observe a failed/interrupted/uncertain turn | Last turn is bound to the actual turn/agent and bounded before/after observation, not a result revision. Only the latest turn capture is retained as turn history; result evidence survives replacement. Partial/unknown observations disclose identity, outcome, time and uncertainty without clearing holds or asserting writes have ended. Older tasks with no capture remain unavailable. |
| WI07 | Report a result, change its files, replace the latest turn capture, restart, then remove the workspace | Successfully retained result-linked file bytes and diffs remain attributable and inspectable as the original evidence. No whole-workspace snapshot is implied. Capture exclusions, size limits and failures are recorded without rejecting the result or replacing historical bytes with later contents. |
| WI08 | Work continues while an operator reads a file/diff and later refreshes | Keep the displayed read stable until explicit refresh, show observation time and known changes, preserve selection/reading position where still valid and represent deletion/unavailability honestly. Inspection neither pauses work nor changes execution, approval or ownership state. |
| WI09 | Reach inspection from task, result/evidence and applicable direct links on desktop and phone | Preserve exact current/result/turn context, return navigation, disclosures and unfinished replies. Keyboard navigation and long files/diffs remain usable. Review applicable List/Board, Overview, Inbox and existing advanced routes for consistent task navigation; document absent entry points rather than adding unrelated ones. |
| WI10 | Select single lines and ranges in text previews and both diff sides, including deleted lines; collect comments across files | Draft comments can be added, edited and removed, with an optional review summary. Exact task/repository/content/range/side and comparison/result/turn context remain attached. Cross-task, invalid-range and excluded-content anchors are rejected. |
| WI11 | Change, rename or delete reviewed files, replace the latest turn capture, restart or remove the workspace | Bounded retained review context remains tied to original content. Affected comments show outdated status; missing or unknown comparison remains explicit. No automatic retargeting, newer-byte substitution or implied whole-workspace history occurs. |
| WI12 | Inspect a draft and send, retry a confirmed failure, or reconcile an uncertain submission | One logical review containing the exact comments and summary reaches the named accountable lead with a receipt. Confirmed failures preserve editable drafts; unknown outcomes retain the original operation for reconciliation without duplicate delivery. No GitHub call, approval, readiness/completion change, merge authority or hold release occurs. |
| WI13 | Navigate among files, diffs and exact result evidence while drafting on desktop, phone and keyboard | Draft content and anchors survive navigation/refresh under session privacy rules. Sent feedback remains inspectable with its original context. Existing contextual feedback is preserved; no unrelated thread-resolution or retraction workflow is introduced. |

### ChatGPT and native Codex acceptance

These integrations are deferred until after the standalone MVP
([ADR-1006](adr/1006-chatgpt-and-native-codex.md)). X01–X08 retain future
acceptance without reopening completed standalone work or gating MVP release or
cutover. Neither integration has passed. X01–X05 delivery is paused under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734) until the work is
explicitly reopened and current APIs, scope and dependencies are revalidated.

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
for negative coverage, then bounded disposable native Codex and ChatGPT journeys.
Operational backup/restore and reviewed cutover remain required. The implementation
agent owns validation; do not hand incremental testing to the operator. Composer
mentions, full admin/recovery parity, historical task import and stronger runtime
containment are not additional gates. A failed native proof pauses its dependent
implementation for scope review; it does not silently remove X01/X02.

## Required evidence by area

Each entry names the scenarios it covers, its state and the record that holds the
evidence. Per-scenario dispositions for A01–A30 and R01–R10 are in the
[local qualification report](evidence/s05-local-qualification.md) and the
[release-candidate inventory](evidence/release-candidate-inventory.json).

- **Runtime feasibility** (R01 and the A08, A09, A14–A16, A18, A25 boundaries) —
  **Bounded.** The seven feasibility rows qualify within the approved bounds, which
  accept incomplete tool history and possible overlap by an untracked detached child
  after qualified normal success. Model-originated escalation rejection is unproved.
  Stored resume is not live reattachment, and neither descendant termination nor
  strict outside-read denial is claimed: the failed termination and outside-read
  observations stand against the stronger contracts they tested. Evidence:
  [seven-row candidate](evidence/s01-acceptance-candidate-2026-09-28.md),
  [qualification report](evidence/s01-qualification-report-2026-09-28.md).
- **Bootstrap, ownership and recovery** (R01 integration, R06 fresh database) —
  **Bounded.** Fresh start, restart and migration, data-directory ownership with
  interrupted first-start recovery, failed login and storage holds, lost `turn/start`
  responses, unexpected approval callbacks and App Server stderr backpressure pass in
  deterministic fixtures. Live checks cover only the existing login and selected
  policy; no model-tool policy or escalation claim follows. Evidence:
  [bootstrap](evidence/s02-bootstrap-2026-09-28.md),
  [safety](evidence/s02-safety-followup-2026-09-28.md).
- **Workspace and writer admission** (A16, A17 contracts) — **Passed** with real
  SQLite and Git and a deterministic runtime. One qualified successor, waiting and
  early-result behaviour, restart, crash, Stop, failure, missing or conflicting
  terminal reports, unfinished callbacks, known survivors, conversation replacement
  and stale results are covered. Normal handoff trusts a bound successful terminal
  report after Ensemble callbacks end; no physical containment is claimed. Evidence:
  [workspace and writer](evidence/s03a-workspace-writer-2026-09-29.md).
- **Scheduler, supervision and capacity** (R02, R03, R08) — **Bounded.** A direct
  turn, a normal follow-up in the same Codex conversation and a task Stop pass against
  the existing operator login, with limits. Physical sleep/wake is not qualified (R03
  stays unproved), nor is exact execution recovery after a host or service restart.
  Evidence: [live runtime](evidence/s03b-live-runtime-2026-09-29.md).
- **Domain commands and coordination** (R05, R07–R10) — **Bounded.** Deterministic
  domain, coordination, routing, inbox, interaction and completion tests pass with
  real SQLite and local HTTP fixtures, and one bounded live runtime journey passed.
  Evidence: [domain commands](evidence/s04a-domain-2026-09-28.md),
  [live runtime](evidence/s04b-live-runtime-2026-09-29.md); designs:
  [command boundary](design/s04a-command-boundary.md),
  [coordination boundary](design/s04b-coordination-boundary.md).
- **Operator web boundary and private access** (R04, R05) — **Bounded.**
  Authenticated HTTP and Chromium tests cover the web boundary. A bounded real-runtime
  operator journey and a same-host proof over a disposable Tailscale HTTPS route
  passed; they confirm private HTTPS and the browser boundary from the fixture host
  only. Independent-device reachability is unproved, missing fixture configuration is
  a blocker rather than a waived gate, and the proof authorises no persistent Serve
  change, deployment or cutover. Evidence:
  [operator UI](evidence/s04c-operator-ui-2026-09-29.md),
  [operator integration](evidence/s04d-operator-2026-09-30.md); designs:
  [operator UI](design/s04c-operator-ui.md),
  [operator integration](design/s04d-operator-integration.md).
- **Assembled local-task journeys** (A01–A18, A25, A27, local A28 and A30, R01–R05,
  R07–R10, R06 fresh-database separation) — **Bounded.** Repository and
  repository-free journeys passed their bounded assertions. A08, A18, A25 and R10 are
  partial and R03 is unproved. The report does not qualify the operational release.
  Evidence: [local qualification](evidence/s05-local-qualification.md).
- **GitHub discovery** (A19–A23, A29 and the GitHub portion of A30) — **Bounded.**
  Discovery of selected repository issues, searches and Projects is read-only and
  grants no repository access. Complete and incomplete selection and native dependency
  reads are retained separately, and incomplete reads hold new admission.
  Deterministic tests and a bounded live fixture pass. Evidence:
  [GitHub discovery](evidence/s06-github-discovery.md).
- **GitHub delivery and release candidate** (A24, A26 and the A01–A30/R01–R10
  inventory) — **Bounded.** The real handback and through-merge journeys (nine of
  twelve approved turns, one fixture squash merge) and the deterministic assembled
  delivery integration pass. The inventory records a disposition for every scenario,
  marks the candidate not release-ready and records no independent integrated review
  of it. Evidence: [GitHub delivery](evidence/s07a-github-delivery.md),
  [release candidate](evidence/s07b-release-candidate.md),
  [inventory](evidence/release-candidate-inventory.json).
- **Operations, recovery and cutover** (R06) — **Bounded.** A disposable launchd
  service lifecycle with database backup/restore passed, and current-schema backup,
  verify and restore with exact owned-process recovery passed locally. Deterministic
  tests prove restored-execution receipt reconciliation, independent Stop/Resume and
  one post-recovery admission; the launchd proof restores populated paused/unready
  records and confirms start, restart and stop without admission, and injects no live
  recovery receipt. Actual old-work disposition and cutover are unproved. Evidence:
  [operations](evidence/s08a-operations-2026-09-30.md),
  [final recovery](evidence/s08b-final-recovery.md),
  [cutover proposal](operations/standalone-cutover-proposal.md),
  [macOS operations](operations/standalone-macos.md).
- **React operator foundation, task views and configuration** (UI03; setup,
  configuration and recovery) — **Passed** for the changed presentation and behaviour
  with the production Vite bundle, the same-origin authenticated service, disposable
  SQLite and Chromium, using deterministic runtime and provider fixtures. No real model
  or provider execution, deployment or human visual acceptance is claimed. Evidence:
  [React foundation](evidence/ui02-foundation.md),
  [task views](evidence/ui03-tasks.md),
  [configuration and recovery](evidence/ui06-configuration.md),
  [shared presentation](evidence/ui08-foundation.md),
  [command lifecycle](evidence/ui-command-lifecycle.md); contracts:
  [foundation](design/ui02-foundation.md), [task views](design/ui03-tasks.md),
  [configuration](design/ui06-configuration.md),
  [presentation](design/ui08-foundation.md).
- **Structured questions and Inbox** (A12, UI01, UI02) — **Bounded.** The full
  Ensemble form (grouped text, single and multiple choice, constraints, custom text),
  durable validation and replay, shared task and Inbox entry points and desktop/phone
  viewport journeys pass in deterministic service, SQLite and browser tests. Native
  evidence is the bounded protocol and one actual service journey for a synchronous
  single-choice request with custom text; grouped native shapes are deterministic
  only. No additional live model attempt or physical-device qualification is claimed.
  Evidence: [native input](evidence/ui01-runtime-input.md),
  [Inbox and questions](evidence/ui05-inbox-questions.md).
- **Task overview, evidence and search** (criteria in
  [Task overview and evidence](#task-overview-and-evidence)) — **Passed** by
  deterministic browser, service and persistence coverage plus one bounded live
  callback transport. Criterion extraction covers supported literal checklists only,
  and captured references do not establish that an agent read them. Pen
  comparison-image loading is only partly verified, so no saved-design
  visual-acceptance claim is made for those images. Evidence:
  [task workspace](evidence/ui04-task-workspace.md).
- **Assembled operator journey** (UI01–UI03 end to end) — **Bounded.** The production
  UI, authenticated service and SQLite create a local task, record its native answer
  and inspect the bound result. Offline qualification uses a fake App Server, and the
  one finite live journey passed with verified cleanup. The display of answered native
  requests after their endpoint closes was verified deterministically, not live.
  Physical-device acceptance is not claimed. Human visual/usability acceptance is
  tracked on [#736](https://github.com/chrisbanes/ensemble/issues/736), which is closed
  as completed; the evidence records no separate acceptance statement. Evidence:
  [integrated operator](evidence/ui07-integrated-operator.md),
  [inventory](evidence/release-candidate-inventory.json).
- **Operator UX refinements** (UX01–UX05) — **Unproved.** No evidence record maps
  these scenarios.
- **Task workspace inspection** (WI01–WI13) — **Passed** by the deterministic suites
  below; live evidence is **bounded** to one repository-free actual-turn journey for
  the actual-turn portion of WI06 and one reduced journey (three starts, no local
  review) in which the Stop hold was retained. Review delivery is qualified offline
  only, as are native successive-turn, restart, failed, interrupted and
  uncertain-capture cases. Evidence: [turn capture](evidence/wi03-turn-capture.md),
  [inspection and review](evidence/wi01-wi13-workspace-review.md).
- **Operator follow-up to a completed lead** — **Passed** by the deterministic suites
  below, with a **bounded** real-runtime journey: the lead recorded a result, a paused
  local review resumed it, and the resumed turn on the same thread received the
  review's anchors and reported a result. Evidence:
  [live follow-up](evidence/issue-828-operator-follow-up-live-2026-10-09.md).
- **ChatGPT and native Codex** (X01–X08) — **Unproved**, deferred. X01 and X02 stay
  unproved: the inspected App Server and SDK surfaces expose standalone thread
  creation but not saved-project placement, linked native workers, project/task
  navigation or an Ensemble handover and return operation. The finding does not show
  that such an API can never exist. Evidence:
  [native feasibility](evidence/x01-native-feasibility.md).

### Execution control, recovery and access

These are required of the integrated service. The feasibility gate exercises the
corresponding boundaries with bounded fixtures only and does not pass the complete
scenarios.

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
  infer physical exclusion from acknowledgement, timeout, lease expiry or normal
  handoff.
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
  Strict outside-read denial is not part of default acceptance, and the feasibility
  gate does not certify every tool class or require a general model-tool allowlist;
  ordinary file edits and the broader enabled tool policy are tested in the
  integrated service. The feasibility gate records model-originated escalation
  rejection as unproved and relies on the effective-policy and attributable
  write/network/history evidence. The product's denial requirement remains: the
  runtime adapter rejects unexpected approval callbacks without granting access
  (deterministic test), and the integrated approval flow is tested before release. A
  fixture does not prove Codex rejected a model-originated escalation. Demonstrated
  policy breaches still block the affected capability.

A failure blocks the dependent claim. Only an explicit product decision changes a
requirement, and a changed contract is not a retroactive pass of an earlier probe.
Observations from the BB prototype are regression examples, not dependencies on
future BB releases. Exact transactions and runtime-specific test seams belong to the
[standalone design](design/standalone.md) and the runtime contracts.

### Task overview and evidence

The reviewed design is the [Pen source](../design/design.pen) with its
[interaction/state handoff](../design/DESIGN.md); a mockup does not prove
persistence, permissions, runtime behaviour or delivery. The behavioural contract is
in [SPEC.md](SPEC.md#operator-interface-and-human-requests). These outcomes apply
wherever Overview, Inbox, project and cross-project List/Board, and task detail
expose the behaviour:

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

Qualify these against the real UI/service with attributable records. Use
deterministic browser/service/persistence coverage; static Pen fixtures do not pass
them:

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

No routes, API schema, artifact-storage mechanism or new runtime capability is
prescribed by these checks.

### Task workspace inspection evidence

Comparison reads use `GET /api/operator/tasks/{taskId}/comparisons`. The 5-second
observation budget is not a strict wall-clock response guarantee: awaited binding
validation and bounded child cleanup can extend response time. Use production service
APIs, real filesystem/Git and SQLite fixtures for the deterministic cases, including
bounded sizes, process restart and cleanup, and verify the integrated production UI
on desktop and phone. Record source/runtime identity, observed captures, limits and
exact resource cleanup, and reuse unaffected runtime evidence.

| Criteria | Deterministic evidence |
| --- | --- |
| WI01–WI02 Files across repository-free and multiple-repository workspaces, safe previews, PDF canvas and no download | `operator-files-browser.test.ts`, `operator-pdf-render-browser.test.ts` |
| WI03 path, binding, exclusion, race and current-session privacy on comparison reads, capture and retained evidence; current policy rechecked after awaited filesystem and stored-projection work; exact binding, safe capture/read and rename-path filtering | `workspace-inspection.test.ts`, `workspace-comparison.test.ts`, `operator-comparisons.test.ts`, `turn-capture-service.test.ts`, `retained-evidence-store.test.ts`, `retained-result-service.test.ts`, `operator-retained-evidence.test.ts`, `operator-task-review.test.ts`, `operator-workspace-inspection.test.ts`; real SQLite/filesystem fixtures and authenticated HTTP |
| WI04–WI05, WI08 Branch/Uncommitted selection, per-repository exact baselines, honest unavailable states, stable reads and Refresh | `workspace-comparison.test.ts`, `operator-comparisons.test.ts` (real Git repositories; no ref/index mutation), `operator-changes-browser.test.ts`, `workspaces.test.ts` (inspection identity reuse) |
| WI06 actual-turn identity, bounded before/after capture, pending and latest-finished Last turn, latest replacement, restart, held failure and the three-start lifecycle | `turn-capture-service.test.ts`, `turn-capture-harness.test.ts` (SQLite, production service admission, fake runtime, authenticated read and restart), `operator-changes-browser.test.ts`, `inspection-review-lifecycle.test.ts` |
| WI07 original linked file/image bytes, callback receipt replay, truthful empty/gap states, no older-turn substitution or later-file backfill; exact bytes and identity read after edit, restart and workspace cleanup; explicit current-file action | `retained-evidence-store.test.ts`, `retained-result-service.test.ts`, `operator-retained-evidence.test.ts`, `operator-retained-inspection-browser.test.ts` |
| WI09 Board and Search origins, section links and exact direct links | `operator-inspection-navigation-browser.test.ts` |
| WI10–WI11 immutable comparison-side/range/hash anchors with optional result association; durable draft/sealed/discarded context; original context after edits, rename/delete, latest-capture replacement, restart and workspace cleanup; missing comparison stays unknown and retained bytes are not retargeted; the copied export is independent of latest-turn replacement | `workspace-comparison.test.ts`, `turn-capture-service.test.ts`, `operator-comparisons.test.ts`, `review-anchor-retention.test.ts`, `retained-evidence-integration.test.ts`, `operator-retained-evidence.test.ts` |
| WI10–WI13 multi-origin anchors, draft edits, reload continuity, lost-response reconciliation, sent inspection, next review and sign-out privacy | `operator-local-review-browser.test.ts`, `local-review.test.ts` |
| SQLite persistence and offline backup/verify/restore of evidence BLOBs (integrity, foreign-key and exact-byte readback) | `retained-evidence-integration.test.ts`, `workspaces.test.ts`, `operator-web-http.test.ts` |

`turn-capture-harness.test.ts` also proves the offline harness's one-dispatch
guard, finite deadlines/read count, delayed start and terminal handling,
uncertain Stop/reopen hold preservation, and checkpoint privacy. Fake-runtime
tests qualify this control boundary only; they do not prove native Codex
behaviour. The guarded `test/wi03/live-turn-capture.mjs` entry ran one
repository-free actual journey for the actual-turn portion of WI06; the
[turn-capture evidence](evidence/wi03-turn-capture.md) records its runtime
identity, exact capture assertions, SQLite readback, shutdown proof and limits.
The guarded `test/wi782/live-inspection-journey.mjs` entry ran a reduced actual
journey (three starts, no local review) in which the Stop hold was retained; see the
[inspection and review evidence](evidence/wi01-wi13-workspace-review.md). Neither
covers native successive-turn, restart, failed, interrupted or uncertain-capture
cases, and review delivery is qualified offline only.

The integrated callback fixture demonstrates a pending comparison gap at result
time, then a finished exact comparison used for separately retained review
anchors. The original result manifest remains pending with its diff gap; the
anchor keeps the completed comparison's own observation time and bytes. This
does not imply that the result callback stopped later writes or that a review
was delivered or received. Direct result-recording paths without a retention
candidate and results recorded before retention preserve their earlier behaviour.

### Operator follow-up to a completed lead

A message, contextual feedback or review sent to a completed lead of an open task
resumes it. Service, read model and operator UI are covered by these deterministic
suites; the real-runtime journey (`test/wi828/live-operator-follow-up.mjs`) is
recorded in the
[live follow-up evidence](evidence/issue-828-operator-follow-up-live-2026-10-09.md).

| Criteria | Deterministic evidence |
| --- | --- |
| Message, contextual feedback or review to a completed lead on an open task resumes it once, linked to its latest result, with exact anchors and a `resumedLead` receipt | `coordination.test.ts`, `local-review.test.ts`, `task-feedback.test.ts`, `operator-follow-up.test.ts` |
| Send composed while the lead ran becomes a follow-up after it completes | `coordination.test.ts`, `local-review.test.ts` |
| Definitive refusals with the draft kept: done or cancelled task, held lead, non-lead, newer or ambiguous lead work, stale version | `coordination.test.ts`, `local-review.test.ts`, `operator-follow-up.test.ts` |
| Replay returns the original receipt without a second resume; reconciliation fences on the lead's version | `coordination.test.ts`, `local-review.test.ts`, `operator-follow-up.test.ts` |
| Holds, approval, readiness and merge authority unchanged; a paused project does not dispatch until unpaused; the resumed turn continues the lead's thread at the next work revision | `operator-follow-up.test.ts` |
| `leadFeedback` read model and recovery-continuation flag; a review never records a continuation | `operator-follow-up.test.ts`, `recovery-continuation.test.ts` |
| One identical status line before sending in the Reply composer, contextual drafts and Local review (1366 px, 390 px, keyboard); Send label unchanged; resumed receipts; refusals keep the draft | `operator-local-review-browser.test.ts`, `operator-review-browser.test.ts` |
| Local review shows the recovery-continuation copy only while the flag is set (panel rendering; the flag itself is proved in `recovery-continuation.test.ts`) | `operator-local-review-browser.test.ts` |

## State and recovery boundary cases

These state the product failure cases with standalone ownership. They are required
observable outcomes, not prescribed database tables or an implementation claim.
Define exact receipt formats and transactions in the dependent contract.

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

A06/A09 cover several results arriving while the recorded recipient is active: no
automatic steer, one eligible continuation for pending events, individual
acknowledgements, and no lost wake-up when another event arrives while the batch is
processed.

After a service restart, A08/A09/A14/A15 also prove automatic resumption of
previously enabled standalone work once reconciliation succeeds and every gate
permits it. Paused/stopped tasks remain held, unknown execution cannot gain a
replacement writer, and the prototype database is neither read nor resumed.

## Evidence ownership

Evidence records live in [`docs/evidence/`](evidence/) as dated run records; a later
run adds a record rather than rewriting an earlier one. The
[local qualification report](evidence/s05-local-qualification.md) and the
[release-candidate inventory](evidence/release-candidate-inventory.json) hold the
per-scenario dispositions for A01–A30 and R01–R10. GitHub issues under
[epic #649](https://github.com/chrisbanes/ensemble/issues/649) own delivery scope,
sequencing and status; this plan owns the required evidence.

Record every proof as passed, failed or unproved with its runtime/source identity,
observed effects and limits. Missing evidence is never a pass. Termination,
cleanup and outside-read failures remain failures against the stronger contracts
they tested. The feasibility gate requires integration and conservative
coordination, not guaranteed descendant termination, strict outside-read denial or
universal live reattachment. Unresolved crash/Stop/failure holds still require
independent recovery, and changing this contract neither passes the gate nor
releases dependent work.

Reuse still-valid evidence with its source/runtime identity and scope, and add only
the missing integration checks. The assembled operator UI and the release candidate
share one attributable inventory and may reuse the same bounded UI/service/runtime
journey. Test pause, Stop, restart, replay, failure and session-expiry combinations
deterministically unless a changed integration boundary or a demonstrated failure
requires a bounded live check. A later gate alone is not a reason to repeat a live
journey. Final integrated visual/usability acceptance is a human decision tracked on
[#736](https://github.com/chrisbanes/ensemble/issues/736).

The operational release gate retains the release candidate's required evidence,
physical R03 sleep/wake proof before operational use on the Mac
([#732](https://github.com/chrisbanes/ensemble/issues/732)) and a verified,
separately authorised cutover
([#761](https://github.com/chrisbanes/ensemble/issues/761)). R03 stays unproved until
then; deferring it from local qualification does not waive that gate or the cutover
evidence. Technical readiness does not establish deployed operation or a completed
cutover, and a cutover is not a prerequisite for building or testing the release
candidate. X01–X08 are deferred and do not block the MVP.
