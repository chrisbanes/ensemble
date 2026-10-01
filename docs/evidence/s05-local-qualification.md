# S05 local qualification

**In progress; the local milestone is not qualified.** Repository and
repository-free assembled journeys have passed their bounded assertions. The
local-dependency probe and affected repository-free rerun have also passed.
The final full check passed 288 tests, and the repaired routing helper passed
its provider-free live check. Independent bounded source/evidence applicability
review is complete; required CI and the physical sleep/wake check remain pending.
A safe host-sleep
window has not been authorised. This report records completed evidence without
releasing #695's dependent capabilities.

Scope is [#695](https://github.com/chrisbanes/ensemble/issues/695), against
merged baseline `31e800a68fe45dd50d1d16f442a818dbcad8cfc3`, following the
[published plan](https://github.com/chrisbanes/ensemble/issues/695#issuecomment-5917049479).
The candidate subsequently fast-forwarded to
`3ea92d43323b01330f155185cedf7ac29db32357`. Incoming changes were only the
new README/artwork, development reference and X01 native-feasibility report;
no production, test or dependency overlap was found. The new README layout and
content were preserved with only the scoped history/report additions.
The [repair checkpoint](https://github.com/chrisbanes/ensemble/issues/695#issuecomment-5921186368)
records the later instruction-delivery/restart repair and bounded rerun.
The [history-repair checkpoint](https://github.com/chrisbanes/ensemble/issues/695#issuecomment-5923179562)
records the subsequently repaired overflow and escaped-credential defects and
their scoped independent review.
The evidence was collected on the pre-publication candidate. Node `v24.21.0`, pinned npm `12.1.0`
and `codex-cli 0.159.0` were used on the existing Mac. The checks below used
fresh disposable service data, not the installed prototype's data or history.
Installed dependency readback confirmed Playwright `1.63.0`, TypeSafe SDK
`0.6.0`, TypeScript `7.0.2` and Biome `2.5.14`.

## Completed integration checks

### Conversation capture, persistence and operator history

A real App Server turn returned the exact capture marker on thread
`01a0f3a7-3ab7-7432-bdd6-0047b93e2937`, turn
`01a0f3a7-3bec-71f2-b24e-7136fc337556`. The observer recorded one started
assistant item, four deltas totalling 14 bytes and one completed item; there
were no omissions or other-turn events. The terminal was completed, the exact
App Server process exited, and the disposable fixture was removed. Earlier
sandbox and pre-binding observer failures are not protocol passes.

Production capture retains complete bounded assistant messages. Delta text is
memory-only until the complete item can be sanitised as a whole. Real SQLite
tests cover exact task/assignment/work/revision/thread/turn bindings, reopen,
early-event overflow, orphan events, write failure isolation and changed
redaction values. Chromium/HTTP tests exercise the escaped, bounded assignment
history, authentication, Host/CSRF denial, cache policy, task isolation and
credential/private instruction/path exclusion. Missing history is diagnostic;
it cannot release ownership or establish execution completion. These tests do
not establish immunity to unknown or transformed secrets.

Independent source review found two additional diagnostic-history defects:
capture stayed saturated after a bounded active-turn overflow drained, and a
conventional quoted credential containing an escaped quote could leave its
suffix visible. The original implementation owner reproduced both failures
and repaired them. Capture now retains a bounded set of omitted turn identities,
ignores their late items through valid terminal events, and resumes only after
tracked and omitted turns drain. Exceeding the identity bound remains fail-closed
until runtime cleanup. Credential masking now handles escaped single and double
quotes before persistence; SQLite, history reads and authenticated UI after
restart exclude both prefix and suffix canaries.

Focused validation passed pinned type checking and Biome, 15 runtime tests,
six history tests and one real Chromium UI test. Independent review returned
ship for these five repaired files across correctness/security, reuse/efficiency
and overengineering. This is a scoped source verdict, not final S05 acceptance.
The repaired runtime SHA256 is
`e0b3d9dab58e4a4e2205e3fa2c551c401b6e233f53c6e990d72c1281a02961a9`;
the history-store SHA256 is
`4b89c351ecfbd23111a2565390b5038e41a11000212fdbd40e2abe993aca299e`.
Earlier live journeys predate these repairs. The final full check and affected
repository-free and provider-free routing checks below subsequently passed;
the bounded delta applicability assessment was independently reviewed below.

### Approval bridge and instruction delivery

The actual S05 runtime validates configuration readback as
`approval_policy: never` / `sandbox_mode: workspace-write`, and thread
start/resume readback as `approvalPolicy: never` / `sandbox.type: workspaceWrite`.
Every turn selects `workspaceWrite`, the exact assignment workspace as its sole
writable root, `networkAccess: false`, `excludeSlashTmp: true` and
`excludeTmpdirEnvVar: true`. The unchanged policy construction and readback
validation are in `src/standalone/codex.ts`; successful S05 startup/thread
admission exercised those validations, not independent host containment.

The selected command-network denial and inside-write/outside-write witnesses are
reused from the [S01 direct command trace](s01-minimum-policy-trace-2026-09-28.jsonl)
and [model shell trace](s01-model-policy-trace-2026-09-28.jsonl), with the same
bounded policy values. Those historical observations cover the command-execution
class, not every ambient tool. S05 records actual ordinary artifact effects but
did not retain ordinary edit/shell tool-class names, so their precise class
attribution is unproved; file effects alone are not a tool transcript. Actual
registered Ensemble callback names include `ensemble_delegate`,
`ensemble_report_result`, `ensemble_request_follow_up`,
`ensemble_request_completion`, `ensemble_ask_question` and
`ensemble_request_approval`. These are service callbacks, not evidence that
unobserved ordinary tool classes were exercised or generally enforced.
The accepted handoff boundary does not require complete diagnostic tool history.

The production service and Codex runtime, connected to a controlled executable
stdio fixture, reject all five installed unexpected-approval methods and
unknown/malformed/unregistered callbacks. The tests include delayed binding,
restart holds, no successor admission and exact runtime exit. Closing the
fixture's stdin file descriptor demonstrated `EPIPE`, rather than assuming
stream destruction proved a response-pipe fault. S01's unproved
model-originated escalation rejection remains an unproved limitation.

The first real routing attempts exposed two assembled-service defects:
captured project/profile instructions were absent from execution prompts, and
an initially routed result did not materialise its task lead. The repairs
compose immutable captured instructions immediately before execution, derive
lead role from the exact assignment binding rather than profile identity, and
materialise a lead only for its verified pending result. Deterministic tests
cover a shared lead/assignee profile, explicit revision application and
capacity-one candidate-to-lead completion. No instructions are duplicated into
queued request storage, and history remains outside admission/control decisions.

### Bounded live routing

Chris [authorised four jev-1.13.0 calls](https://github.com/chrisbanes/ensemble/issues/695#issuecomment-5916722689).
One retained SQLite ledger reserved all four calls before the provider boundary;
failed downstream probes consumed their reservations. SDK retries were zero.
The call allowance is exhausted. Monetary cost was not returned by the adapter;
no cost or savings estimate is claimed.

| Probe | Observed result |
| --- | --- |
| First paid attempt | Provider response and selected Codex candidate observed; downstream assertion failed before useful telemetry was appended. No overall pass. |
| Second paid attempt | Provider success: 465 ms, 740 input / 127 output tokens. Exact candidate marker and completed turn observed, but task remained open with no completion request. This exposed the missing instruction/lead handoff integration, not a provider routing failure. |
| Final clear brief | One eligible candidate selected; confidence 1, 294 ms, 744 input / 133 output tokens. Exact marker, two captured items, no omissions, completed Codex turn and durable task completion. |
| Final ambiguous brief | Lead review and durable task completion, with a finalised completion request and no reviewed results. Its detailed usage/latency was omitted by truncated controller output; none is invented. |

These are representative integration observations, not statistical routing
quality or optimisation evidence. The final paid process later failed on the
separate disabled-routing setup, so its overall exit was nonzero even though
both enabled cases completed.

Provider-free retries used a refusing client, no credential-file read and no
provider calls. They diagnosed a fixture ordering problem: the UI's unpause
submission included unchanged instructions after assignment capture, advancing
the immutable revision and correctly refusing the stale assignment. Completing
project configuration before readiness/assignment capture resolved that setup.
The corrected real Codex/Chromium run passed disabled routing with the project
lead and explicit-assignee bypass with routing enabled. Both reached durable
task completion with zero routing operations. The separate UI pause/resume
normalisation repair is still being validated; these probes do not claim that
repair already passed.

The authenticated browser regression subsequently confirmed unchanged-text
resume and keyed changed-instruction replay. Its first later failure came from
the fake runtime ending without a result or durable wait, correctly triggering
a reporting-repair turn. After the fixture recorded a real question callback,
pause and stale-revision refusal assertions passed, but delivery still stalled
after explicit apply. Independent read-only investigation identified a service
defect: the queued answer/message batch and held, unadmitted request retain the
old assignment version, leaving the events bound with no eligible new request.
This is a failed A11/R05 path pending repair, not a new guarantee or permission
to clear independent execution/Stop/ownership holds.

A new deterministic service regression reproduced the same boundary: it timed
out waiting for a current-version request while the project remained paused.
The fixture reached the recorded pre-admission revision refusal before this
failure. This red test is repair evidence, not a qualification pass.

The first narrow withdrawal repair passed the original authenticated browser
regression, including continuation after explicit apply. The restart regression
still failed: startup migration synthesised a pending `assignment-result`
effect for the refused, never-admitted inbox request. Independent investigation
confirmed that the strict no-pending-effect proof correctly rejected it. The
follow-on repair must prevent that synthetic insertion only for proven
never-admitted work; existing effects and unknown/admitted holds remain intact.
Final-source and restart verification are still pending.

The narrowed migration repair then passed the refused-before-apply restart,
ordered one-time event delivery and lead-completion assertions. Fifty-eight of
59 selected coordination/scheduler/writer/supervisor/S03b/assignment checks
passed. The remaining regression assertions needed fixture-only corrections:
select the exact new inbox request rather than a completed initial request,
and compare delivered message states by event identity instead of incidental
same-timestamp view ordering. The ordered batch/prompt assertions remain.
The authenticated browser regression passed again on this migration build.

After those fixture-only corrections, all 59 selected interaction checks
passed. The delivery regression covers refusal-before-apply with restart,
apply-before-refusal with one bounded follow-on wake, keyed apply replay,
ordered one-time delivery and lead completion. Negative witnesses preserve
the exact batch under Stop, unknown recovery identity and admission/capacity
evidence. Existing initial-refusal replacement, writer, uncertainty, archive,
supervisor and S03b semantics also passed. Production source was unchanged
between this green run and the provider-free live rerun below.

The enabled probes used harness SHA-256
`120ab1a17e22752fe2d1d4ff13550f87ab42738036f72fd29ca6304cfe237a37`;
the corrected provider-free run used
`dc023bad1921855bbc9502f30c2540294452027a8eb1c157627aa42ad9b27c2f`.
Both used the same production service source
`fdd17533fbefb8aeba8bafc23a675bae1ebaaa7dc31ad3d3572f4b8c7edc24c3`
and compiled service
`5c2d1670d4f7c4a6df0e61ecc8d4c64fd7ff27c21e077ee9f3a88eb27be34224`.
Runtime source was
`e7eee6b7724f97c3412c426d414024f470ad88c0287c7c96b46a653cffcc97c0`;
compiled runtime was
`4c97b8d84fdf8e7e28d0f826d6daf2c05029c9a2296f5e845ed497e88762e671`.
The final candidate must explain any subsequent affected change rather than
silently treating earlier hashes as final-source evidence.

A subsequent provider-free real Codex/Chromium rerun passed on the narrowed
repair. Disabled routing and explicit-assignee bypass both completed with zero
routing operations; authentication, durable settlement and logout passed. The
ledger stayed at 4/4. Its harness was
`1a5a17e0c8cad94b3c8951418c29ee10d75d1030f7fd26e60d0a0ff0fe6cb3cc`;
service source was
`a42d0ce386f1ae2145846366ea212ea209edf14e8993f994481b9eea04ada253`,
coordination source
`7353872ce5b804ea6accb23d6755efc44224e8146db53683f576f64e72f8f897`,
and state source
`2edf1d5b72d6c1056661688f6eaf6420359333028fc5b922de8b2f47115c1866`.
Runtime and routing adapter source remained unchanged. Final applicability
review must cover the new delivery/completion interaction before reusing the
earlier paid enabled-routing results.

### Assembled journey attempts

The first repository-mode sandbox attempt stopped at loopback setup with
`EPERM`, before any App Server started, and removed its fixture. The exact
outside-sandbox retry authenticated Chromium and configured the repository
fixture, but stopped before model execution on the harness assertion
`power-trigger-disabled`. The harness had tested a nonexistent `enabled`
status field; the service returns `null` when power handling is disabled.
This fixture-only assertion was corrected after inspecting the production
service/status code, then only repository mode was retried. The failed attempt
used UI harness `be1c65adf230955ab122394a94768c8a7fbafec93234a70451a71f7bfef6f725`.
Its exact App Server PID 26694, started `Thu Oct 1 00:45:48 2026` on the same
observed boot, was verified exited by the harness and absent on independent
readback; browser, HTTP, auth and disposable fixture cleanup passed.

The next attempt also authenticated but stopped before any model turn at
candidate readback: the harness compared insertion order, while the domain
stores candidate IDs as a canonical sorted set. The comparison was corrected
to the same deduplicated sorted-set form; production routing code was unchanged.
That failed attempt used UI harness
`e0748b7803b036a691535fb70d02f17bbe4b2f0b9617732a0ebe07c2e212c345`.
PID 26938, started `Thu Oct 1 00:46:54 2026` on the same boot, was verified
exited and independently absent. All owned resources and the fixture were
removed before the repository-only retry.

The third repository attempt reached real execution: read-only SQLite counts
showed one completed intent, one running intent and one capacity-waiting
successor, with an open task and no recorded results. It then failed at the
production runtime's 180-second terminal timeout (`model-turn-failed-within-bound`).
The failed turn was `01a0f4ba-a90b-71a2-8151-dd62df6dc237` on thread
`01a0f4ba-a745-7e32-96c9-447fda4ee6c3`. The helper's success-only diagnostic
copy omitted callbacks on this failure, so those counts do not prove the
complete planned sequence or its precise model-side cause. This remains a
failed journey, not a pass. UI harness was
`a0fdb81ac950aba4921a2c084334cf115286355f76723309de12e2566c7b539c`.
PID 27547, started `Thu Oct 1 00:48:21 2026` on the same boot, was verified
exited; every owned resource and the fixture were removed.

The fourth repository attempt completed ten real turns with no failed terminal.
It proved the nested reviewer returned to the implementer while the file was
41, the exact-result follow-up reused the implementer thread and changed it to
42, and a new reviewer returned to the lead. Four distinct assignment threads,
exact callback bindings, artifact diff, private-history filtering and capacity
one (maximum observed usage one across 7,292 samples) passed. Completion was
rejected: the fixture requested only the revision-two implementation and second
review result IDs. The precise rejection reasons were not copied into this
attempt's report; investigation of the complete-current-result contract remains
pending. This is a failed journey, not qualified completion. UI harness was
`d7998289e0663b03f940f93ea724e6acc4eaf1689b1e690d6a686bd2c511f9ac`.
PID 42693, started `Thu Oct 1 01:08:33 2026` on the same boot, was verified
exited and independently absent; all owned resources and the fixture were removed.

Source/tests established that the completion contract includes every current
assignment result, not only results returned directly to the lead. The initial
nested review remains current. The repository fixture was corrected to relay
its exact ID in the implementer's initial result and require the lead to review
it alongside both revision-two results. The helper now verifies that relay and
the complete exact result set, and records bounded rejection codes rather than
summaries. No completion gate was changed.

That repository-only retry used helper
`f4723c4c809ebb408c914e027f523d3376b52a9994afb8b324218ed0602ffc49`.
It reached seven completed turns, three results and a running second review,
then the upstream stream reported HTTP 403 during reconnect. Generic forwarding
of a provider notification named `error` invoked Node's reserved EventEmitter
error behavior and crashed the coordinator (`ERR_UNHANDLED_ERROR`) before its
cleanup report. This is a demonstrated runtime defect and failed journey, not a
provider-login diagnosis or completion proof. The official
[App Server error contract](https://learn.chatgpt.com/docs/app-server#errors)
distinguishes error notifications from the subsequent failed terminal.
No login/configuration change or alternate billing was attempted.

The exact persisted App Server identity was PID 62221, started
`Thu Oct 1 01:26:49 2026` on the same observed boot. It was absent on independent
readback after the crash; filtered process inventory found no test headless
browser or newly created assertion helper. The fixture remains retained under
opaque recovery token `ensemble-s05-repository-Jip5Fr`; graceful resource cleanup
was not proved. No retained database/holds were cleared, no task was resumed and
no fixture was deleted. The original worker reproduced the reserved-event crash
with a deterministic red test, then guarded only the generic `error` fanout.
The regression verifies retry notifications cannot settle a turn; exact
completed/failed terminals and the existing failure-classification allowlist
remain authoritative. All 13 focused runtime tests, type checking and targeted
Biome checks passed. Root then rebuilt and ran the complete pinned check:
276/276 tests passed, with the same four non-fatal lint warnings. Runtime source
is `3b561dc25a447d621634cf9881baf234b2cf10c88c015e84e7cbebf725c36fb9`.
The repository-only retry then passed: nine real turns, four assignment threads,
two implementation results, two separate reviewer results and a finalized lead
completion referencing exactly all three current results. The initial summary
relayed the exact nested review ID; the first reviewer observed file value 41
before the initial implementer report, the follow-up reused that implementer's
thread and changed the file to 42, and the lead's new reviewer referenced the
exact revision-two result. All callback identity/order, artifact bytes/Git diff,
private-history and stream assertions passed. Capacity was configured to one;
maximum observed usage stayed one across 6,131 samples. No turn failed.

The passing run used UI helper
`f4723c4c809ebb408c914e027f523d3376b52a9994afb8b324218ed0602ffc49`
and compiled runtime
`19f7d3d3d3e44c777be5f71f9b8a6cf08f17db45bc25ec1d11a71ea33d9b83e9`.
App Server PID 83861, started `Thu Oct 1 01:41:57 2026` on the same boot, was
verified exited and independently absent. Services, HTTP, auth and browser
cleanup passed; this run's disposable fixture was removed. The earlier failed
fixture `ensemble-s05-repository-Jip5Fr` remains untouched. The passing sequence
does not erase prior failures or qualify the separate missing dependency probe.

The repository-free mode then passed on that same frozen helper and compiled
source, with TypeSafe disabled. Two projects shared the lead profile but used
separate task-bound conversations. Alpha delegated one worker, whose question
and harmless no-op approval were opened in one turn; Beta's lead opened its own
interactions. At successful idle terminal, the service/App Server restarted and
the old authenticated UI session was invalidated. Each answer and denial was
recorded once and delivered to its exact requester. Beta completed while Alpha
remained paused; Alpha's queued message and changed instruction revision stayed
held until explicit apply. Its worker result reached the exact lead and that
lead's completion finalized with the exact result ID. Captured histories and
authenticated pages excluded the known private values and other task's marker.
This mode does not exercise the local dependency gate/release journey; that
remaining check is separate. App Server PIDs 50116 and 51243,
started `Thu Oct 1 01:17:40 2026` and `Thu Oct 1 01:18:08 2026`, were verified
exited and independently absent. Browser, HTTP, auth, services and disposable
fixture cleanup passed. The preceding sandbox attempt stopped at loopback EPERM
before runtime startup and removed its fixture; only that failed command was
retried outside the sandbox. This proves the named repository-free journey,
not the failed repository completion or the unperformed physical sleep check.

The helper uses the production runtime's 180-second terminal timeout and
surfaces failed/error terminals to its stage waits. Browser launch is bounded
at 30 seconds; page actions at 20 seconds and form responses at 10 seconds.
The revised helper bounds service startup plus process-identity capture, and
operator authentication plus HTTP listener startup, at 30 seconds each. Owners
are registered before startup. A timed-out operation is not stopped concurrently
or counted as exited: its fixture is retained, and one late disposer closes
owned handles when the operation settles. Even a late HTTP-stop rejection still
closes the authentication handle; failure remains recorded without claiming
successful shutdown or asynchronously deleting the retained root. These bounds
are stage deadlines, not a guarantee that the whole command exits in 30 seconds.
The new thread/file witness subsequently passed in the affected repository-free
journey described below.

### Physical sleep preparation, not physical proof

The prepared harness has 18 passing deterministic safety tests and an
independent code-readiness review. It requires an exact approved host/time
record, a 60-second absolute wake interval, a uniquely owned wake event and
verified readback before sleep. Uncertain scheduling or cleanup retains the
fixture and uncertainty; it never cancels unrelated events. Its narrow timing
guards bound dispatch, not an atomic OS-transition guarantee.

No wake was scheduled, no privileged sleep command was run and no physical
sleep/wake was performed. The missing prerequisite is one directly approved
safe host-wide test window. R03 remains **unproved**, not passed by fake events.

## Finite acceptance coverage

The dispositions below are bounded observations and reused evidence, not local
milestone qualification. Partial/unproved rows remain so; R03 is not a pass.

| Scenario | Current disposition and remaining check |
| --- | --- |
| A01 | Repository-free service/runtime restart and old-session invalidation passed. |
| A02 | Two-project/shared-profile/instruction setup passed in repository-free journey. |
| A03 | Authenticated creation/edit/readiness/restart journey passed. |
| A04 | Historical bounded enabled allocation, final-source disabled/explicit paths and repaired UI revision tests passed. |
| A05 | Nested review, distinct assignment threads and accountable repository completion passed; separate repository-free task conversations passed. |
| A06 | Exact nested requester return and capacity-one yield/resume/completion passed. |
| A07 | Exact-key authenticated answer/denial replay after verified restart retained one unchanged receipt/event/revision per interaction. |
| A08 | Partial: bounded S02/S03b lost-launch/recovery and current negative-hold coverage. |
| A09 | Assembled repository-free restart and one-time delivery passed. |
| A10 | Actual artifacts 41 then 42, nested review, retained-worker follow-up, new review and exact-current-result lead completion passed. |
| A11 | Explicit apply after actual restart, ordered one-time response delivery and lead completion passed. |
| A12 | Actual questions, operator answers and exact requester continuation passed. |
| A13 | Actual UI denial, production authorizationFor rejection for exact current task-bound file material, absent file and exact requester continuation passed. The disclosed fixture action adapter is not a universal action/tool enforcement bus. |
| A14 | Two live projects retained independent pause state across restart; Beta completed while Alpha paused. |
| A15 | Prior real Running/Stop/restart proof reused with current Stop/ownership/recovery regressions. |
| A16 | Full capacity-one delegated/review/follow-up successor journey passed. |
| A17 | Actual bound workspace artifact/Git diff and retained follow-up identity passed. |
| A18 | Partial: bounded history generations and stale-report tests. |
| A25 | Partial: actual ordinary artifact effects, stream, selected policy and unexpected callback denial passed. Ordinary edit/shell class attribution is unproved; accepted broad-read/ambient-access and S01 escalation limits remain. |
| A27 | Actual capacity-one journey passed alongside deterministic default caps/retry/inactivity. |
| Local A28 | Actual authenticated edge/replay, open/cancelled blocker gates, real Done release, retained independent Stop and UI Resume/completion passed. |
| Local A30 | Deterministic dependency completeness coverage passed; real GitHub is S06. |
| R01 | Existing runtime login and assembled repository-free restart passed. |
| R02 | Full actual capacity-one journey and deterministic default/lowered limits passed. |
| R03 | Unproved: required physical sleep/wake lacks an approved safe window. |
| R04 | Prior same-host private HTTPS proof plus current history HTTP/browser guards apply. No separate-device reachability claim. |
| R05 | Actual repository-free restart, captured histories, private UI and explicit revision continuation passed. |
| R06 fresh separation | Fresh disposable fixtures used; no prototype data imported. Backup/cutover excluded. |
| R07 | Historical bounded enabled routing and final-source disabled/explicit live paths passed; current deterministic tests cover the changed interaction. |
| R08 | Retained implementer repair and actual lead completion passed; deterministic fallback/busy/admission checks passed. |
| R09 | Exact nested requester, capacity-one scheduling, both reviews and lead completion passed; repository-free restart and simultaneous histories passed. |
| R10 | Partial: current deterministic routing races/failures plus bounded historical live telemetry. |

A19–A24/A26/A29, GitHub-dependent work and R06 backup/cutover are later slices,
not passes or S05 gaps. Existing evidence reused here includes
[S02](s02-bootstrap-2026-09-28.md),
[S03a](s03a-workspace-writer-2026-09-29.md),
[S03b](s03b-live-runtime-2026-09-29.md),
[S04a](s04a-domain-2026-09-28.md),
[S04b](s04b-live-runtime-2026-09-29.md) and
[S04d](s04d-operator-2026-09-30.md). Reuse requires an explicit final delta
applicability check, not just a historical green result.

The final 288-test check includes these existing deterministic suites:

- `routing.test.ts`: bounded retry and persisted budgets, concurrent inference,
  abandoned/late responses, captured-context conflicts and stale dispositions.
- `scheduler.test.ts`: atomic direct/managed reservations, rollback, default and
  lowered capacity, capacity-one child yield and retained request identity.
- `coordination.test.ts`: same-task lead/requester destinations, exact receipts,
  high-water batches and reopen, question/approval responses, denial, messages,
  stale results and all durable lead-completion gates.
- `task-writer.test.ts`, `supervisor.test.ts` and `s03b-integration.test.ts`:
  admission drift, unfinished callback/survivor holds, predecessor ordering,
  Stop, restart and exact recovery without replay.

These suites are not substitutes for physical sleep. The actual local-dependency
probe subsequently passed, as recorded below. Historical pending statements
describe the evidence state at those earlier points, not outstanding reruns of
those now-completed probes.

### Final-source delta applicability assessment

The repository journey is reused for its exact delegation, nested reviewer,
workspace, retained follow-up, capacity and lead-completion witnesses. Its core,
service, state, workspace, operator and routing control sources are unchanged.
The later runtime/history changes are bounded diagnostic overflow recovery and
escaped-credential masking, not admission or completion changes. Deterministic
red/green regressions and the final-source repository-free history/restart/UI
journey exercise those affected surfaces. Startup/cleanup helper changes have
separate fake failure tests and successful affected live cleanup observations.

Earlier paid routing observations remain historical, not final-source reruns.
The SDK, adapter and bounded selection snapshots are unchanged; current routing
race/hold/admission tests and final-source provider-free disabled/explicit paths
cover the subsequently changed coordination interaction. No new paid call,
statistical quality claim or monetary-cost estimate is inferred from that reuse.

S02–S04 component evidence is retained only for the named unchanged contracts,
with the final full regression suite covering their interaction with instruction
composition, strict never-admitted withdrawal and history capture. The prior
Running/Stop/restart witness remains bounded to its recorded behavior; current
Stop, ownership, survivor and recovery tests retain the negative gates. Same-host
private HTTPS evidence is reused with current authenticated HTTP/history tests,
not as a separate-device reachability claim. A08/A18/R10 remain bounded component
coverage, not universal recovery, stale-generation or routing-quality guarantees.
R03 remains unproved. Later-slice exclusions and accepted S01/runtime limits are
unchanged. This bounded delta applicability was independently reviewed; it does
not turn missing physical evidence into qualification.

## Verification and cleanup

On the updated base, after the history and startup/cleanup repairs, pinned
`npm run check` passed type checking, lint (four non-fatal warnings), format,
build and all **284/284** tests. After the final helper repairs, a fresh full
check passed all **288/288** tests with the same four non-fatal lint warnings.
The exact sandbox-denied build command was
retried outside the sandbox. Dependencies and pins were unchanged from the
successful pinned `npm ci` recorded below. The subsequent fixture-brief wording
repairs passed their affected live checks as identified below.

The first actual local-dependency attempt passed authenticated setup, exact-key
UI edge replay (one edge, one version increment and one unchanged receipt),
open/unready and cancelled-blocker admission holds with zero dependent turns,
and setting the independent dependent Stop hold. A real blocker lead then
successfully requested completion with an empty reviewed-result set and reached
durable Done. The helper nevertheless failed its exact assistant-marker
assertion: two assistant items completed without omissions, but neither printed
the expected marker. The brief contained the marker but instructed only the
completion call and turn end, so this was a concrete fixture instruction/assertion
mismatch, not a qualified dependency-release journey or demonstrated service
defect. The original owner is correcting both briefs to request marker emission
explicitly; all other assertions remain. App Server PID 69615, started
`Thu Oct 1 03:44:12 2026`, was verified exited and independently absent. Browser,
HTTP, auth, service and exact fixture cleanup passed. The preceding sandbox
attempt failed at service-start EPERM before a runtime process and removed its
fixture; only that exact command was retried. No TypeSafe call or host sleep
was performed.

After the brief repair, the second local-dependency run verified the blocker
lead's exact marker, one completion callback and durable Done; the dependency
gate cleared while its edge and independent dependent Stop hold remained.
The stopped dependent had no bound/active turn. UI Resume cleared only that
Stop hold, and its real lead also completed with the expected marker. The run
recorded two streamed turns, two successful completion callbacks and no omitted
assistant items. Its final aggregate assertion still failed because it used
`current.runtime.turns`, a property absent from the observed runtime, instead
of the actual stream map count. This is a second concrete helper defect, not
an overall pass or demonstrated duplicate execution. The original owner is
correcting the counter and recording the bounded component observables before
the aggregate assertion. App Server PID 71484, started
`Thu Oct 1 03:48:37 2026`, was verified exited and independently absent; all
owned browser/HTTP/auth/service/fixture cleanup passed.

The third local-dependency run passed on the same production/compiled source
and UI-helper hash
`8ef3845a1482544768dc7651f240da877b623bd6603ebe83e5089ba96792cbb5`.
Authenticated UI edge submission and exact-key replay retained one edge, one
version increment and one stable receipt. Open/unready, cancelled and reopened
blocker states prevented a dependent turn. The actual blocker lead then
completed once; its Done state cleared the dependency gate without removing
the dependency edge or independent Stop hold. The stopped dependent remained
without an active/bound turn. UI Resume cleared that Stop hold and its lead
completed once, with exactly two total observed turns, one completion callback
and exact marker per task, no omissions, and capacity one (peak one across 712
samples). Cancel/reopen used the explicitly disclosed fixture Domain API because
the task configuration UI has no state control; no synthetic completion was
substituted for either real lead. The command exited zero and the fixture was
removed. App Server PID 74529, started `Thu Oct 1 03:53:33 2026`, was independently
absent after cleanup. Controller output was partially truncated, so this report
retains the observed bounded results rather than reconstructing missing JSON.
No TypeSafe call, host sleep or shared prototype access occurred.

The affected repository-free rerun on that helper stopped before restart at
`task-specific-interaction-binding`. It observed three actual streamed turns,
five successful coordination callbacks (Alpha delegation and worker
question/approval, Beta lead question/approval), three marker-bearing turns and
no omissions. The aggregate binding check requires the exact action string
`Write fixture-only relative file`, the fixed relative target and task-bound
material/requester; the fixture instructions described the write but did not
specify that literal action field. The failed output did not retain individual
predicate values, so the exact failing component is not claimed. The owner is
making the expected fields explicit and recording bounded component booleans
before the aggregate check, without weakening it. This run is failed, not an
approval/replay/restart pass. App Server PID 75318, started
`Thu Oct 1 03:54:41 2026`, was verified exited and independently absent; browser,
HTTP, auth, service and exact fixture cleanup all passed. No TypeSafe call or
host sleep occurred.

The corrected repository-free rerun passed on final production/compiled source
with UI-helper hash
`e83469a296912f3dfba990c8864e7dbb4d53991f7c07bec4d6943e82de6109ac`.
Both tasks' question/approval counts and marker/action/target/material/requester
bindings passed. Real service/App Server restart occurred at a successful idle
terminal with ended callbacks; the previous authenticated session was invalid.
Answers and denials were submitted through the authenticated post-restart UI,
then their exact captured keys and semantic fields were replayed. Each replay
returned 303, retained one unchanged receipt/payload hash/committed result, one
event and interaction revision two, and delivered once to the exact requester.
Both original response writes and replays occurred after that restart; this is
not a claim of receipt commit followed by a second restart.

For each actual model-requested relative file write, the disclosed fixture-only
adapter consulted production `CoordinationStore.authorizationFor` using exact
current interaction/material/revision/requester bindings after UI denial.
Authorization was false and the workspace-relative file remained absent before
and after the decision. This proves that selected action-decision boundary, not
a universal registered action bus, arbitrary filesystem enforcement or model
compliance as a security mechanism.

Beta completed while Alpha remained paused. Alpha's queued message and changed
instruction revision stayed held until explicit apply; its worker reported one
exact result to its lead, and that lead finalized completion with that exact ID.
The run observed nine streamed turns and nine callbacks. One lead attempted
`ensemble_report_result` and was rejected; subsequent bounded reporting repair
and actual lead completion succeeded. That rejection is retained, not relabeled
as a successful callback. Exact scoped persisted histories and authenticated UI
excluded known private values and the other task marker. Both App Server PIDs
78769 and 79686, started `Thu Oct 1 03:59:39 2026` and
`Thu Oct 1 04:00:10 2026`, were verified exited and independently absent.
All browser/HTTP/auth/service cleanup and exact fixture removal passed, with
no pending startup owner or startup timeout. No TypeSafe call or host sleep
occurred. The preceding sandbox attempt stopped at startup EPERM before a
runtime process and removed its fixture; only that exact command was retried.

Full independent review additionally found that the separate routing harness
could swallow browser/HTTP cleanup errors, or let an authentication-close error
skip later service/ledger cleanup. These source defects were subsequently repaired;
prior successful cleanup observations remain specific to those runs, not proof
of the faulty failure paths. The paid call ledger remains 4/4; repair and tests
must not make additional TypeSafe calls.

The revised non-live harness suite passes 15 tests, including four routing
cleanup tests and a mid-stage
registered-owner cleanup failure, valid exact-fixture removal and retention of
foreign, wrong-parent, symlink and unclaimed roots. Deletion requires matching
created-fixture evidence, canonical temporary parent, fixed mode/prefix/suffix
and recovery token. Fake late service resolution/rejection/disposal failure and
late operator authentication/listener disposal exercise the pending-startup
boundary without live processes. Failures retain the fixture and serialize only
safe stage/owner metadata. They do not prove termination of an arbitrary real
pending process. Pinned isolated TypeScript compilation, scoped Biome checks and
helper syntax checks pass. Actual affected live cleanup subsequently passed;
independent full-source review returned fix-first for routing cleanup; review of
the repaired range then returned ship across correctness/security,
reuse/efficiency and overengineering, with unchanged prior coverage reusable.
Documentation and bounded evidence applicability were independently reviewed.
The earlier reserved-event crash retained its fixture and is not
relabeled as graceful cleanup.

The final provider-free routing run passed on current source after the 288-test
build. `TYPESAFE_API_KEY` was removed, no credential file was read, and the client
refused provider calls. Disabled routing and explicit-assignee bypass each
completed through real Codex with zero routing operations. The same retained
ledger read 4 before and 4 after; a separate pinned Node `DatabaseSync` read-only
query independently confirmed ceiling 4 / reserved 4. An earlier read-only
SQLite CLI query failed to open the file; no reset, checkpoint or permission
change was used to obtain the independent readback.

Routing helper SHA256 was
`57e9e9806b2810386a1a9e9a0caadaccace830a5fb4a88a85d3c53e5f0278bae`;
its pure cleanup module was
`a53509b7a2e714bea79bbddf0d6d260b0da29ac9ffd08cb14b0f854123ffeb72`.
All nine owned cleanup statuses passed, including exact App Server exit and
ledger read/close, with no cleanup errors. PID 89876, started
`Thu Oct 1 04:15:42 2026`, was independently absent and the exact disposable
fixture was removed. Cleanup attempts each resource independently after any
failure; uncertain identities or failed cleanup retain the fixture and safe
fixed-stage/type errors. Fake multi-failure tests cover that branch; the live
success does not prove termination of arbitrary pending processes.

Before subsequent UI/harness work, pinned typecheck, lint, format, build and
271/271 tests passed. Sandbox write/listener denials were retried only for the
affected commands. On 1 October, pinned `npm ci` passed (10 packages, zero
reported vulnerabilities) after the exact sandbox-denied unlink was retried.
The subsequent `npm run check` passed type checking and lint, then stopped at
eight formatting errors. Six TypeScript files were mechanically formatted;
the two journey helper files are being corrected and formatted by their owner.
The fresh pinned build and all 59 selected interaction tests passed on the
formatted source. The full 274-test deterministic suite then passed after the
exact sandbox-denied loopback-listener command was retried. This includes
browser authentication, changed-instruction continuation and history UI tests;
it does not complete the pending actual journeys.
The next pinned `npm run check` passed type checking, lint (four non-fatal
warnings), formatting, build and all 275 tests. The exact command was retried
outside the sandbox only after compilation writes to the existing `dist`
directory were denied. This includes the added no-live/invalid-mode CLI guard
test. A subsequent repository-only harness correction still requires its own
syntax/format checks and actual journey; production TypeScript is unchanged.
Independent review and applicable required CI remain delivery gates on the
final candidate. Earlier source hashes identify their specific runs, not this
later formatting-only source state.

The paid runs' exact App Server identities (PIDs 64364, 70447 and 10651) and
provider-free runs (15470, 16944, 18271 and 83953) were verified exited before fixture
removal. All shared the observed boot identity
`F899F669-079B-4A1A-AE7B-D0FBDF33047C`; the final enabled process started at
`Wed Sep 30 22:37:13 2026`, and the passing provider-free process at
`Wed Sep 30 22:42:23 2026`. The post-repair provider-free process started at
`Wed Sep 30 23:53:54 2026`; its exact PID was absent on independent readback
after the harness verified exit and fixture removal. The call ledger remains
retained at 4/4. Credentials
were removed from the launch environment before Codex/fixture subprocesses;
no credentials, private prompt bodies or control paths are published here.
Provider-side thread records may remain; their deletion was not requested.

The normal handoff boundary is bound successful terminal status, ended Ensemble
callbacks and no other hold or known unfinished execution. This report does
not claim strict outside-read denial, universal descendant containment, an
independent Ensemble sandbox or universal live reattachment. The launchd
`/usr/sbin` PATH issue already recorded for S08 and the S01 approval limitation
remain visible; deployment/cutover is not authorised by this qualification work.
