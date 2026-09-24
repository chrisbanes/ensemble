# Acceptance and validation plan

Status: proposal for review. This is the release evidence contract, not a list of
manual steps for the user. Every delivery ticket names the scenarios it proves.

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

## Operator experience coverage

Extend A02/A03 to exercise shared profiles, separate project instructions, default
unready local creation and explicit Ready creation while a project is paused.
Extend A12/A13 to exercise the shared attention inbox, task links, linked owner
conversation, and BB notifications where supported, without repeated alerts for
unchanged items. Include failures and placement conflicts in the inbox journeys.
A19–A23 must cover query validation/preview and readiness all/any rules separately
from source membership. Non-code A26 journeys complete on the owner's recorded
outcome and evidence unless project instructions or permissions require approval.

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

## Gates

- Design gate: consequential decisions and BB gaps resolved before dependent code.
- Local milestone: A01–A18, A25–A27 as applicable to local tasks, automated UI journey,
  and one successful bounded real-provider smoke. No GitHub discovery required.
- Operational release: all applicable A01–A27 plus repository issue and GitHub
  Project live integration. PR/merge acceptance follows the confirmed D1 choice.
- Handback: user reviews the finished flow and evidence, rather than performing
  incremental integration tests. Any manual-only boundary must be disclosed and
  accepted before calling the milestone complete.
