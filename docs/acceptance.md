# Acceptance and validation plan

Status: proposal for review. This is the release evidence contract, not a list of
manual steps for the user. Every delivery ticket names the scenarios it proves.

## First journey to prove

Automate the [first local-task journey](SPEC.md#first-local-task-journey) through
real BB UI/RPC and storage. Use shared profiles as configuration, with no bot
creation prerequisite, external source or manual thread-ID entry. Exercise direct
owner work, bounded delegation and a structured question as separate scripted
paths. Assert the artifact and completion evidence, one accountable owner,
retained history and default conversation retention. A green BB status alone
must not complete the task.

Then apply the existing restart, pause/stop, uncertain launch, message replay and
writer-exclusion scenarios to that same fixture. T10 assembles the journey;
feature tickets establish their portions as they land. No user-run integration
loop or additional model evaluation campaign is required.

## Environments

1. Fast tests: domain services with the actual migration schema in SQLite files;
   no model calls. Close/reopen files for persistence boundaries.
2. BB integration: pinned BB binary and SDK, actual plugin loader/SQLite driver,
   dedicated data directory and ports, temporary Git repositories, controlled
   clock where supported, and a scripted provider speaking BB's public bridge API.
3. UI: automated browser tests against that same isolated BB instance. Exercise
   real RPC and storage, not mocked task screens.
4. GitHub adapter: deterministic paginated/error fixtures plus a bounded live
   exercise against a designated test repository/Project. Never use Haze's live
   queue as a fixture. If live access is unavailable, report the release gate open.
5. Provider smoke: one bounded task on an authenticated provider in a disposable
   repository. The implementation agent runs it, inspects traces and records costs
   if available. No repeated model evaluation campaigns or manual user test loop.

The scripted provider must issue tools, yield, receive an inbox event, resume,
fail, and simulate a lost response. Stub model behaviour, not the BB persistence
or lifecycle boundary. Credential-free suites run in CI; live checks are explicit
release evidence. CI must fail on timeout, leaked owned processes, unacknowledged
required events, or duplicate operation effects.

## Acceptance matrix

| ID | Given / when | Required observable result | Layer |
| --- | --- | --- | --- |
| A01 | Install with compatible BB; restart and reload plugin | Manifest, settings, tools and UI load; migrations repeat safely | BB |
| A02 | Operator configures two projects and profiles | Shared profile can be selected by both projects with distinct project instructions; configuration is validated and retained; both initially paused | UI + BB |
| A03 | Create/edit a local task in the UI; restart | Content and stable identity survive; unready by default; Create and start marks Ready without bypassing pause; no external issue is created | UI + SQLite |
| A04 | Enable a project with eligible tasks (subject to D2) | Lead selects work and one owner starts without a chat setup ritual | BB + UI |
| A05 | Owner requests two bounded assignments | Independent threads use selected profiles; one accountable task owner remains | BB |
| A06 | Worker reports while parent is idle | Result persists; one logical inbox event wakes parent; acknowledgement survives restart | BB |
| A07 | Repeat claim/delegate/report/response commands | Same operation returns same outcome; changed payload conflicts; no second worker/effect | SQLite + BB |
| A08 | Lose spawn response after BB creates a worker | Restart reconnects the original; zero/multiple matches visibly hold; no blind retry | BB fault injection |
| A09 | Crash before/after result commit, send acceptance or acknowledgement | Durable result/inbox retained; accepted sends reconciled; no duplicate work | BB fault injection |
| A10 | Owner delegates implementation and review; review finds a defect | Owner chooses revision and follow-up from instructions; findings refer to artifact revision | BB scripted journey |
| A11 | Edit instructions/profile during existing work, then explicitly apply | Existing assignments retain recorded revisions until explicit apply for their next turn; new assignments use current revisions; process changes need no new stages or schema; permission revocations still apply | BB + UI |
| A12 | Agent asks a question; operator answers during restart | Question appears in Ensemble beside a link to the owner conversation; response is durable, correctly scoped, and resumes the right assignment | UI + BB |
| A13 | Approval denied or reviewed material changes | Action cannot execute using denied/stale approval; reason visible | BB + access integration |
| A14 | Pause project A while B has work | Current turns in A may finish; no new turns or follow-ups in A; B continues; results retained; resume revalidates | BB + UI |
| A15 | Stop a task with an owner and workers; BB loses contact or reports a writer still active | All active task assignments receive stop requests; queued work held until explicit resume; files/history retained; UI shows stopping/uncertain until confirmed; replacement cannot write until reconciled | BB fault injection |
| A16 | Two writers target one task workspace | One admission succeeds; others wait; parallel independent tasks remain possible | BB + Git |
| A17 | Complete a task in each cleanup mode; archive/delete conversations through BB | Default retains until archive; automatic mode waits for confirmed delivery and preservation checks; shared worktree remains while live conversations retain it; Ensemble archival applies cleanup policy and preservation checks; direct BB archival consequences are visible; missing workspace blocks dispatch without false completion | BB + Git |
| A18 | Runtime cannot resume a conversation | Confirm old writer stopped; new generation reconstructs context; late result cannot override | BB |
| A19 | Repository and Project sources return same issue | One task with two memberships; deleting one membership preserves other and history | Adapter + SQLite |
| A20 | Pagination, missed observation, duplicate event or partial outage | Full selection converges; no false withdrawal from partial data; no duplicate owner | Adapter |
| A21 | Source includes PR, draft, or issue from disallowed repository | PR/draft excluded; discovered issue grants no repository execution access | Adapter + BB |
| A22 | Same issue appears in two Ensemble projects | Operator chooses placement; existing owner retained; newly conflicted unowned work cannot dispatch; no transfer of already-owned tasks; no permission union | UI + SQLite |
| A23 | Lose all memberships/readiness, close issue, or edit scope during execution | Hold new delegation and notify owner to stop safely; operator resolves resumption except confirmed own-delivery closure; harmless clarification proceeds, material outcome/scope change holds affected work for input | BB + adapter |
| A24 | External edit or PR write times out after success | Confirm remote identity/state before retry; UI never reports unconfirmed success | Adapter fault injection |
| A25 | Configure permissions; attempt denied Ensemble action | Ensemble action is rejected; BB/provider controls are passed correctly and their shell/API limits are disclosed | BB + UI |
| A26 | Hand back PR, receive feedback, restart, then merge or explicitly accept/close | Owner resumes on CI/review feedback; task remains waiting until settled; only through-merge projects merge autonomously; history persists | UI + BB + adapter |
| A27 | Capacity exhausted or repeatedly failing worker | Ordinary dispatch honors BB limiter; capacity one does not deadlock parent/child work; confirmed transient failures retry at most twice; uncertainty holds; prolonged inactivity flags attention without automatic termination/restart | BB |
| A28 | Ready local task depends on another local or imported task in its project | Blocked task stays Ready and visible but starts no owner or new turn through Ensemble; local blocker Done or confirmed imported issue closure releases it automatically; cancellation does not; only operator can edit edges, with retries/version conflicts handled; self/cyclic and cross-project authored edges are rejected | UI + SQLite + BB |
| A29 | Ready imported issue has native GitHub blocker outside selection or project | Full native dependency read holds Ensemble dispatch while blocker is open; no task import or repository access is inferred; closure or edge removal releases it, and reopening re-applies the gate | Adapter + BB + UI |
| A30 | Initial or later native dependency read or an imported blocker of a local task is incomplete, or a blocker appears during active work | Unknown state holds dispatch even before the first successful read and after a previously clear read; current turn may finish, but queued/new turns and delegation wait; ownership/results persist across restart; complete confirmed refresh resumes only when other controls permit | Adapter fault injection + BB |

## State and recovery boundary cases

These extend existing scenario IDs; they are required evidence for the proposed
state/recovery contract, not claims that the prototype implements it.

| Scenario | Additional boundary to prove |
| --- | --- |
| A07 | Matching command retry replays the receipt despite an old expected version; changed payload conflicts; in-flight duplicate returns the original pending operation |
| A09 | Wake-up acknowledgement precedes a delayed send response; no state regression. Crash after a recorded action but before inbox acknowledgement; redelivery returns the recorded event disposition and caused-operation identities, rather than creating fresh commands |
| A14 | Pause after BB accepts a queued message but before it starts; restart; queued first turns and follow-ups remain held until resume |
| A15 | Stop races with delegation, result reporting and a delayed spawn response; hold survives restart, late conversations are reconciled/stopped, and resume clears only the operator stop |
| A16 | A writer queued behind BB concurrency does not retain a reservation; owner yields writing to child and later resumes; an early result does not release a still-active writer. Unknown execution or surviving background writer keeps workspace held |
| A18 | Replacement conversation receives pending events; stale destination messages/results cannot mutate current work; assignment instruction revision remains unchanged without explicit apply |
| A26 | PR handback keeps owner assignment open for feedback; task completion cannot silently leave active children or unresolved effects; child follow-up reopens the same assignment with a new work revision, preserving prior results and rejecting stale revision reports |
| A27 | Retry counter survives restart; BB and Ensemble retries cannot multiply the two-retry allowance; unknown effects and permanent failures do not retry automatically |
| A28 | A scoped agent task edit cannot add/remove an edge. Matching operator command retry creates one edge and receipt; changed payload or stale dependent-task version conflicts. Adding a local edge while its dependent has an active or BB-queued turn advances the control revision, lets an admitted turn stop safely, and holds queued/new turns and delegation across restart; removal re-evaluates other gates. |
| A30 | A newly discovered Ready issue's first dependency-list read fails or returns a partial page: no owner starts. A complete refresh with no blockers releases it; one with an open blocker keeps it held. Repeat after a previously confirmed clear read and for an unreadable imported blocker of a local task. |

A06/A09 cover several results arriving while the owner is active: no automatic
steer, one eligible continuation for pending events, individual acknowledgements,
and no lost wake-up when another event arrives while the batch is processed.

A06/A09 also cover a completed turn without a result or wait: send one durable
reporting prompt, hold if its reply also omits a report, and do not duplicate the
prompt across restart or bypass project pause/task stop.

A08/A09/A24 verify automatic resumption of reconciled, previously enabled work
without clearing prior pause/stop holds. Uncertain effects block dependent work;
established independent work can proceed, while unknown writers prevent further
writes to their workspace.

A27 also verifies that exhausted worker retries hold that assignment and notify
the owner. The owner may diagnose and arrange a revised approach, but reopening
or renaming the same work cannot silently replenish automatic retries.

## Operator experience coverage

Extend A02/A03 to exercise shared profiles, separate project instructions, default
unready local creation and explicit Ready creation while a project is paused.
Extend A12/A13 to exercise the shared attention inbox, task links, linked owner
conversation, and BB notifications where supported, without repeated alerts for
unchanged items. Include failures and placement conflicts in the inbox journeys.
A19–A23 must cover query validation/preview and readiness all/any rules separately
from source membership. Non-code A26 journeys complete on the owner's recorded
outcome and evidence unless project instructions or permissions require approval.
A25 must disclose that BB's direct Send-now override is outside Ensemble's task
dependency gate.

## Complete local-task journey

The mandatory end-to-end test creates a project/profile through the UI, creates a
local task, enables dispatch, observes a lead and owner, delegates a worker, records
its result, wakes the owner, handles one human question, and displays the accepted
outcome. Restart between result persistence and continuation, then repeat the
operation identifiers. Assert assignment/thread counts and the repository diff,
not only success text. A second project proves scoping and concurrency.

Run this without an operator supplying UUIDs, thread IDs, SQL edits, CLI settings,
or manual continuation messages. The implementation agent supplies and maintains
the harness. Local fixtures are disposable; shared BB/Haze is not mutated by CI.

## Fault evidence and release report

Inject failures immediately before and after each SQLite commit and BB/provider
request acceptance. Assert persisted records, current thread/environment identity,
UI state, and number of actual writes. Missing remote evidence is an uncertainty,
not permission to retry. A fake host unit test alone does not satisfy A08/A09.

Every release report records commit, BB/SDK/Node versions, test commands, passed
scenario IDs, failures/waivers, sanitized traces, and live-provider outcome. No
check is marked passed because it has a test name or because an agent said done.
Avoid blanket coverage percentages as a substitute for scenario evidence.

The credential-free T1–T5 live harness runs as `npm run test:bb-integration` after
`npm ci` and the pinned Playwright Chromium install. It writes a deterministic
machine-readable report with one row per required public API, seven proof gates,
and six T5 scenario records, including the tested revision, source digest,
artifact/SDK/Node identities, observed IDs/effects, verdicts and evidence limits.
The raw T4 test intentionally exits nonzero for the known #665 startup violation;
the aggregate accepts only its exact queue/provider/tool evidence and verified
cleanup, records the gate as failed capability, and keeps dependent T06/T08
blocked. Unrelated test failures, missing evidence/events, timeouts or leaks fail
the aggregate. This report does not stand in for the authenticated-provider smoke
required for the later operational release gate.

## Gates

- Design gate: consequential decisions and BB gaps resolved before dependent code.
- Local milestone: A01–A18, A25–A27 as applicable to local tasks, automated UI journey,
  A28 for local-to-local dependencies, and one successful bounded real-provider
  smoke. No GitHub discovery required.
- Operational release: all applicable A01–A30 plus repository issue and GitHub
  Project live integration. PR/merge acceptance follows the confirmed D1 choice.
- Handback: user reviews the finished flow and evidence, rather than performing
  incremental integration tests. Any manual-only boundary must be disclosed and
  accepted before calling the milestone complete.
