# Runtime retention and indexed evidence

This report records the deterministic longevity run and independent-review
repairs for #790. It measures the production `CodexRuntime.receive()` path,
`StandaloneService` callback and coordination wiring, and the real SQLite
stores. The fixture injects a synthetic child and transport; it does not launch
Codex or qualify a live native protocol. Existing UI01/S05 protocol and
bounded-conversation evidence remains the protocol qualification evidence.

## Workload and method

The terminal workload delivered 10,000 settled `turn/completed` events through
`CodexRuntime.receive()` into a service-owned SQLite database. After the
cohort, it replayed turn 0 with the same status and then the opposite status.
The duplicate stayed non-conflicting; the opposite status persisted a sticky
conflict, held the exact writer and same-workspace successor, and left an
unrelated completed execution unchanged. The test then exercised the exact
indexed lookup for 1,000 turns.

The native workload drove 2,000 requests through the adapter, service waiter
and callback path, real coordination view, and SQLite-backed reply-intent
transaction. Each synthetic stdin reply checked that the matching durable
question already held a `replyIntentId` in `sending` state before the fixture
emitted its resolution. All 2,000 observations met that ordering; there were
zero violations. The test retired each request in cohorts of 250, checked
runtime collection counts and UTF-8 payload bytes after every cohort, and
reopened the same service database under a different runtime generation. The
confirmed answers stayed confirmed and prior terminal evidence remained
readable after reopen.

Two independent-review gaps were repaired and measured on this source. A
cohort of 1,024 unbound failed terminal notifications retained 110,592 UTF-8
bytes of compact first-failure facts in the existing terminal rows while the
adapter retained zero failure-cache entries. A valid early failed receipt had
no retry authority while unbound, became classifiable only after its exact
SQLite turn binding, retained its first classification across a duplicate,
and lost retry authority after an opposite-status conflict. Unknown failure
codes remained non-retryable.

The thread-snapshot cohort used the real service and SQLite with a test-only
global admission limit of 256 and distinct workspaces so each held writer
could reach its intended production stage. Counters confirmed 142 thread-start
responses and 141 turn-start requests (one initial failed startup plus 140
held failed-start cases); none of those 141 turn starts succeeded. A held
binding's created snapshot was no longer an active pin. The cache remained at
128 entries / 20,010 bytes after count churn, then 4 entries / 241,204 bytes
after byte churn. During a later active turn it reported that separate
157-byte snapshot as one actual pin; the pin retired on terminal observation.

The follow-up pin-release cohort exercised four concurrent production
`turn/start` requests with four distinct 100 KB tool snapshots. While those
requests were pending, all four snapshots remained present as active pins:
401,212 UTF-8 bytes, above the settled-cache byte limit. The test then failed
all four requests without another cache insertion or cache lookup. All four
service submissions remained held with no turn ID or native qualification;
the cache immediately settled at two entries / 200,606 bytes, with zero pins.
This covers the point where the last RPC owner releases, rather than relying on
a later insertion to trigger eviction.

Settled-budget trimming now runs after RPC timeout or response handling and
after native endpoint or turn retirement. A failed/stopped runtime clears the
snapshot cache before clearing its pending RPC map. Resume response handling
validates the returned thread, installs any refreshed exact snapshot, and
captures native qualification synchronously before the RPC-release trim, so
the prior facts remain available for that check.

A separate 140-thread cohort completed `thread/start` and `thread/resume`
through the production adapter and service-owned SQLite qualification store.
All 140 exact first-facts rows remained durable, while the settled snapshot
cache stopped at 128 entries / 40,440 bytes with no active pins. No turn was
started and no native endpoint or readback was exposed. Native qualification
is now returned directly to the immediate callback qualification path; general
resumes retain only the durable first facts and bounded thread snapshot, not a
per-thread qualification object.

For both workloads, the test enumerated the settled terminal and native
payload caches, active endpoints and both indexes, the single joint
thread-snapshot cache, native turns, invalid turns, readbacks,
failure-evidence cache, conversation turns, pending RPCs, service
waiters/callbacks/active/background work/captures, and state prebindings.
Every settled collection had count 0 and UTF-8 payload bytes 0. At one active
native request, the test observed one endpoint, turn and RPC index, readback,
turn, thread snapshot, service waiter and callback. The qualification is
embedded in that endpoint's callback payload. The raw request was 304 bytes;
enumerated active payloads were: endpoint 1,034 bytes, turn index 170, RPC
index 180, thread snapshot 111, turn 48, readback 370, waiter 193, and
callback key 23.
Active child/stream/timer/function handles are not converted into payload
bytes; their ownership and lifecycle are tested separately.

The measurements use pinned Node.js 24.21.0 and npm 12.2.0 on macOS arm64,
MacBook Pro 18,2 with Apple M1 Max (10 cores). Heap samples call explicit GC
before reading `process.memoryUsage().heapUsed`; heap values are workload
observations, not a universal memory bound. Lookup and cancellation timings
use `process.hrtime.bigint()` for fixed sets of 1,000 synchronous iterations.
The timing harness retains at most 1,000 samples per operation. To report
durable question payload bytes, it also materializes 2,000 question rows
(2,119,123 bytes) in the test harness; that measurement allocation is not
production runtime retention.

## Results

| Workload | Durable rows and payload | Post-GC heap samples | Indexed lookup / cancellation | Settled in-memory payloads |
| --- | --- | --- | --- | --- |
| 10,000 terminal turns | 10,000 rows; 1,027,780 UTF-8 bytes | 5,000: 16,589,904 bytes; 10,000: 16,606,624 bytes; delta 16,720 | Terminal lookup, 1,000 iterations: median 0.050000 ms, p95 0.087917 ms, max 0.597000 ms | Every enumerated collection: 0 entries / 0 bytes |
| 2,000 native questions | 2,000 question rows; 2,119,123 UTF-8 bytes; qualification rows: 2,000 / 530,890 bytes | 1,000: 19,863,760 bytes; 2,000: 19,988,400 bytes; delta 124,640 | Terminal lookup: 0.049083 / 0.070625 / 0.265833 ms; native endpoint lookup: 0.045250 / 0.063042 / 0.296667 ms; settled direct cancellation lookup: 0.000666 / 0.000959 / 0.068208 ms (median / p95 / max, each 1,000 iterations) | Every enumerated collection: 0 entries / 0 bytes |

SQLite used the `runtime_terminal_evidence` composite primary-key index for
terminal lookups and the `coordination_runtime_questions` unique endpoint
index for native lookups. The 2,000 native callbacks observed durable
write-intent state before resolution (`observations: 2000`, `violations: 0`).
After reopening with a new runtime generation, each checked question remained
confirmed and old terminal evidence remained readable.

The focused matrix also verified changed settings, missing legacy settings,
and changed tools remain unqualified; missing expected evidence, corrupt
evidence, and a rejected evidence write cannot authorize completion; and
legacy bound turns migrate to unknown evidence rather than inferred
completion. The existing adapter tests continue to cover unchanged, changed,
typed-ID reuse, old-generation replay, callback/write/ack ordering, and
uncertain delivery. Cache retirement does not clear the durable receipt or
turn a replay into a new reply. Exact empty-tool definitions can be recovered
after cache eviction only when the durable first tool digest equals
SHA256(`[]`); changed, missing, or corrupt facts remain unqualified. Current
resume settings are never used to fill a missing historical settings snapshot.

An intermediate focused run exposed an ordering regression in the first cache
replacement: the fixture emits a dynamic tool callback immediately after its
`thread/start` response, before the awaited call resumes. Registering the
snapshot after that await dropped the callback. The final code now validates
the exact start response and synchronously writes the existing tool digest and
joint bounded snapshot from the response-validation callback, before the next
notification is received. The targeted callback test and the full adapter
suite pass with this ordering. A separate early-terminal test initially reused
the same synthetic workspace after intentionally retaining a conflict hold;
the production writer correctly prevented its later synthetic intent from
starting. Giving those direct setup records unique workspaces isolated the
fixture without changing hold behavior.

## Validation and limits

The measured focused command was:

```sh
PATH=/private/tmp/node-v24.21.0-darwin-arm64/bin:$PATH \
  node --expose-gc --unhandled-rejections=strict --test dist/test/runtime-retention.test.js
```

On the qualification-map repair source it passed 9/9 tests with 0 failures
and 0 skips. It covers the 10,000-turn and 2,000-question measurements, the
four-owner pin-release cohort, 140 successful resume responses with durable
facts and no retained qualification map, failed and unbound terminal
classification, joint snapshot budgets, changed or missing qualification
facts, corrupt/missing/write-failed terminal evidence, and legacy migration.
Its raw output is
`/private/tmp/ensemble-790-qualification-map-retention-expose-gc.log`.

The renewed adapter and retention matrix passed 68/68, including all old-turn
ownership, typed-ID reuse, replay, native callback qualification carried by
the exact callback, nonempty dynamic tools, immediate callback ordering,
changed/missing settings, and the new successful-resume retention cohort. Its
output is `/private/tmp/ensemble-790-qualification-map-focused.log`. The
earlier adapter suite passed 59/59 in
`/private/tmp/ensemble-790-codex-runtime-repair-final.log`. The smaller renewed
review-boundary run passed 12/12 in
`/private/tmp/ensemble-790-repair-boundaries-1.log`. It records two diagnosed
intermediate failures: `/private/tmp/ensemble-790-repair-focused-1.log`
contains the unbound-test and shared-workspace fixture assumptions, and
`/private/tmp/ensemble-790-repair-focused-2.log` contains the immediate
`thread/start` callback ordering regression. Exact-binding tests, distinct
workspaces, test-stage counters, durable empty-tool digest recovery, and
synchronous response validation repaired those cases; the final suites above
pass without changing production hold or retry policy.

The first expanded pin-release boundary run exposed a resume ordering regression
in the initial trim placement: qualification ran before the refreshed snapshot
was installed. The raw result is preserved in
`/private/tmp/ensemble-790-pin-release-boundaries-1.log` (70 passed, 1 failed).
Resume now validates the response, installs its refreshed snapshot, and checks
qualification in the synchronous response callback before trimming. The
focused follow-up passed both the 140-startup cohort and four-owner pin-release
cohort in `/private/tmp/ensemble-790-pin-release-focused-3.log`. The renewed
three-file runtime, retention, and native matrix passed 71/71 in
`/private/tmp/ensemble-790-pin-release-boundaries-final.log`, including the
10,000-terminal and 2,000-native workloads.

The latest 10,000-turn heap delta was 16,720 bytes and the 2,000-question heap
delta was 124,640 bytes under this synthetic workload; these are observations,
not a memory guarantee.

The final pinned full check ran with Node.js v24.21.0 and npm 12.2.0. It
completed type checking, lint, formatting, build, and 1,030 tests with 1,030
passes and no failures or skips (91,818 ms for the test suite). The captured
full output is
`/private/tmp/ensemble-790-qualification-map-full-check-escalated.log`; its
first two lines record Node.js and npm versions. The first check found one
formatting issue in the test's diagnostic field, which was corrected. The
subsequent sandbox attempt is preserved at
`/private/tmp/ensemble-790-qualification-map-full-check-final.log`; after
typecheck, lint, and format passed, TypeScript was denied writes to ignored
`dist/` outputs. The exact pinned check passed with the necessary filesystem
access.

The renewed UI04/UI07 cleanup matrix passed 9/9 focused cases, including
successful qualification, delayed browser creation, late cleanup failure,
active-callback failure, delayed HTTP setup, and delayed runtime startup. Its
captured output is `/private/tmp/ensemble-790-ui-cleanup-focused-final-retry.log`.
The harness records per-stage start/end times, elapsed time and remaining
budget, plus late resource creation and closure. Independent browser and probe
closure now start alongside pending setup settlement and exact runtime stop;
the existing task hold still follows runtime stop, and HTTP, auth, and service
closure remain ordered afterward. If `service.start()` is still pending, its
tracked late `service.stop()` remains the sole shutdown owner and cleanup does
not issue competing runtime, task, or service stops.

The UI04 delayed-start case deliberately remains unresolved at the original
5-second total / 1-second cleanup cutoff. The test asserts that unresolved
status and that direct shutdown stages are absent, then observes the retained
late stop owner settle and the exact fixture child's exit under a separate
bounded test observation. The cutoff `cleanup.verified` value remains false.
UI07's delayed-start case settles the same owner within its original
4.5-second total / 2-second cleanup budget. Neither case changes the
qualification budgets or treats late settlement as an in-budget success.

The full-suite output-overflow failure was traced to the controlled-Git
fixture's SIGTERM handler logging and suppressing the default exit for the
normal overflow operation. The fixture now removes that handler and signals
its own process only for the exact overflow behavior, so the production
graceful-then-force path observes SIGTERM. The stall and inherited-pipe
descendant behaviors remain unchanged. Focused output-overflow and sticky
cancellation checks passed 3/3 in
`/private/tmp/ensemble-790-output-overflow-repair-focused.log`; the separate
inherited-pipe check is in
`/private/tmp/ensemble-790-output-overflow-inherited-pipe-focused.log`.
The final full run records the bounded worktree-add case at 974 ms against its
1,000 ms timeout, with a 20 ms TERM grace and 40 ms observation window; its
observed child exit signal was SIGKILL. The inherited-pipe descendant was still
alive at parent settlement and was cleaned by the fixture's exact-identity
cleanup.

The initial conversation-capture timeout did not recur in the final suite: the
bounded capture test passed in 1,358 ms. A focused run and a concurrent run
alongside the 2,000-waiter service workload also passed; the diagnostic logs
are `/private/tmp/ensemble-790-conversation-diagnostic-focused.log` and
`/private/tmp/ensemble-790-conversation-concurrent-retention-diagnostic.log`.

These synthetic results prove the exercised adapter/service/SQLite lifecycle
and deterministic retention assertions. They do not establish a production
latency or heap SLA, live Codex behavior, complete process/OS memory
accounting, or a universal bound for collections outside the enumerated
runtime/service/state ownership. No database history is pruned, and an absent,
corrupt, unreadable, or legacy-unknown safety row remains fail-closed.
