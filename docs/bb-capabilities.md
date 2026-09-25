# BB capability evidence

Date: 2026-09-24. Live harness runtime: installed **BB 0.43.4** with host SDK
**0.5.9**, plugin SDK package **0.5.24**, Node **24.21.0**, macOS arm64. The
harness verifies SHA-256 digests of the installed BB runtime tree and plugin SDK
package before launch, and requires the scripted-provider source checkout to be
clean at its pinned commit. The loaded plugin exercised SDK 0.5.24 successfully
on this host. The installed BB package exposes no source commit; the separate
source checkout supplies the scripted provider only and is not claimed as the
build source for the installed app. These isolated observations do not prove the
Ensemble product is ready.

## Failed approach: startup guard releases queued work

The accepted design requires persisted pause/stop holds to prevent dispatch after
restart, including when Ensemble cannot load. A hook-only implementation failed:

1. A separate guard plugin returned `wait` from `message.dispatch`.
2. BB persisted the message with that plugin as its wait holder.
3. BB was stopped; the guard was made to throw during its next initialization.
4. BB restarted and reported the guard plugin in `error`.
5. BB removed the wait and delivered the held message to the scripted provider.

The full T01 harness reproduced the unsafe boundary in a fresh instance: guard
and Ensemble plugin status **error**, queue **empty**, provider-observed
`turn/start`, and process exit **2**. Its `threads.send({ mode: "start" })` call
returned `delivery: "queued"` under the guard's public `message.dispatch` wait.
This run did not establish a completed turn or tool effect. The run used `--keep`
to retain its isolated database, provider log and launcher log for inspection;
the launcher stopped in `finally`.

An earlier narrow guard-only diagnostic separately observed the plugin SQLite
tool-call counter advance **1 → 2** after the guard failed startup. Its server log
reported that BB cleared the wait because the holding plugin would not run. That
diagnostic proves a completed tool effect in its own setup; it is not the full
T01 harness.

The integrated T4 follow-up records the stronger consequence for the accepted
queue scenario: when both hook owners fail initialization, BB removes the wait,
empties its public queue, and delivers the prompt to the scripted provider. The
provider made one turn and the fixture tool counter advanced **3 → 4**. The raw
T4 test deliberately exits nonzero on this observed safety violation. T6's
runner recognizes only that exact marker after checking queue identity,
provider/tool counts, failed plugin statuses, dependency fields and process
cleanup; it records a **failed capability**, never a successful safety gate.

**Consequence:** a plugin dispatch hook that stores an accepted send as a BB
queue wait cannot implement the accepted startup-failure guarantee on this
runtime. Do not mark T01, T06 or T08 ready based on the healthy-restart check.
This disproves that approach, not every possible Ensemble implementation. No
weaker product guarantee has been accepted.

Candidate capability requirement: preserve a queued dispatch wait durably when
its owning plugin is unavailable, with explicit recovery or operator resolution;
alternatively, expose an atomic public send/admission operation that rejects
without persisting whenever dispatch would wait. This remains a candidate
capability, not proof that no other BB/Ensemble design exists. Ensemble issue
[#665](https://github.com/chrisbanes/ensemble/issues/665) tracks the boundary and
blocks dependent execution work; it does not yet conclude that an upstream BB
change is necessary.

## Alternative under investigation: retain pending work in Ensemble

The harness staged an unsent intent in plugin SQLite, restarted BB, confirmed the
tool-call count did not change and the intent remained `pending`, then dispatched
it after the plugin loaded successfully. It repeated this setup alongside the
failed guard scenario; the unsent local intent still remained pending even as the
BB-accepted queued message ran. Thus an Ensemble-owned pending record protects
work before submission.

The alternative does not control work already accepted by BB. The live `start`
send under a plugin wait returned `queued`; after restart BB cleared the wait and
executed it. Source inspection at the pinned revision and SDK package 0.5.24 shows:

- `apps/server/src/services/threads/thread-send-request.ts` routes sends through
  `attemptDispatch` and returns either sent or queued.
- `dispatch-attempt.ts` evaluates plugin policy and then core waits. Another
  plugin can request a wait; stopping, provisioning, busy threads and other core
  conditions can also queue work. A pre-send idle check is not an atomic admission.
- `SendMessageRequest` offers `auto`, `start`, `steer`, `queue-if-active` and
  `steer-if-active`; none promises “execute now or reject without persisting.”
  The tested `start` mode is not such a guarantee: plugin waits are evaluated
  before the active-thread check.
- `threads.queuedMessages.delete` separately deletes a row by thread and queue
  id. It is not atomic with send admission. A crash or lost response between
  queue acceptance and cleanup remains possible; do not treat cleanup as an
  atomic cancellation guarantee.
- The send request has no caller-supplied operation id. On a lost response the
  harness recovered the single accepted message through a unique marker in the
  public timeline after restart and observed no second tool effect. This proves
  this marker-based recovery scenario, not general idempotency or stale-target
  invalidation.

The local pending alternative therefore protects only the pre-submission case;
it does not establish A14's accepted-queue guarantee. The 2026-09-24 live follow-up
in this harness narrows the alternatives further:

- With the external wait plugin installed before the Ensemble gate, a first
  `wait` was collected and a later `reject` refused `threads.send` before BB
  created a row. A persisted row waiting on the external plugin also stayed
  queued with `failureReason` after the external plugin failed startup while the
  Ensemble gate remained loaded and paused; rechecking after resume dispatched it
  once.
- A `queue-if-active` send was rejected without a queue row when the gate was
  paused or stopped. When the gate was ready, BB accepted a core `thread-busy`
  row; pausing before the source turn finished kept that row from reaching the
  provider, and resuming dispatched it once. This tests Ensemble's gate decision
  alongside BB core busy-queueing; it does not test every race with the public
  `threads.stop` operation.
- Public `threads.queuedMessages.create` on an idle conversation created a row
  waiting on `thread-busy` and then immediately dispatched it. It is not a durable
  operator-controlled hold.
- If both the external wait owner and Ensemble fail startup, BB clears the old
  plugin wait, empties the public queue and sends the accepted prompt to the
  separately loaded scripted provider. The public thread status read back as
  `idle`; the provider request was observed, but this run did not prove a
  completed turn or tool effect. Therefore the startup gate still fails even
  though `reject` composes correctly whenever Ensemble is available.

The probes do not justify a second scheduler. Do not treat a local pending row,
an independent plugin wait, or instruction compliance as a dispatch interlock
when the Ensemble hook is unavailable.

## 2026-09-25 delayed-stop capability gap

The isolated T5 fixture held a new thread's first message in a plugin dispatch
wait. BB's public `threads.stop` returned `ok`, but the thread stayed `pending`
through the bounded confirmation wait and the queued message remained held by the
plugin. No provider turn or tool effect occurred before release. The fixture did
not recheck the message because stop was not confirmed. The report records this
as `failed-capability`, with T02/T06 writer-release work blocked by
[#676](https://github.com/chrisbanes/ensemble/issues/676). This proves a
status-confirmation gap for this delayed-start setup; it does not show what BB
would do if the queued message were released after the unconfirmed stop.

The GitHub releases page still lists BB desktop **0.43.4** as the latest stable
release on 2026-09-24 ([BB releases](https://github.com/get-bb/bb/releases)). The
installed 0.43.4 runtime is therefore the latest stable available for this test;
no newer stable runtime was available to qualify.

## Reproduce the T01 harness

From the repository root after `npm ci`, with Node 24.21.0 active, set
`BB_APP_PACKAGE` to the installed `bb-app` package directory and
`BB_SOURCE_CHECKOUT` to a checkout at the pinned revision below:

```sh
node scripts/check-bb-integration.mjs "$BB_APP_PACKAGE" "$BB_SOURCE_CHECKOUT"
```

The script checks installed BB package **0.43.4**, plugin SDK package **0.5.24**,
Node **24.21.0**, and macOS arm64. It hashes sorted relative file paths and bytes
for the installed unpacked BB `node_modules` runtime tree (SHA-256
`950d603f24546984352d533a54946c2d900abcaef01b9516105d602494d3df34`)
and the plugin SDK package tree (SHA-256
`03c336f1fa462e1288f4aaebfbd413512dc65782a402eff590aa84a280288bdf`).
This pins the exact files used by this run; it does not establish their upstream
build provenance. The actual host declares plugin SDK **0.5.9** compatibility;
this fixture has been loaded and exercised with SDK package 0.5.24 on that host.
The second path is a BB source checkout at
`fdd3de3b19b97e6cd1ef7300cbb54711431249d3`; that revision pins only the source
of BB's MIT-licensed scripted provider bridge. The harness rejects a dirty checkout
before it copies the provider into a temporary fixture with its license. The
installed app does not expose a source commit, so the harness does not infer
that the app binary was built from this checkout. It imports no BB private SDK
path, integration harness or server
internals. Test-only instrumentation added to the copied provider captures the
tool result delivered back to it and holds one busy turn until the fixture writes
an explicit release file. The busy-queue probe therefore does not depend on a
fixed delay or machine speed.

The harness starts a fresh `BB_DATA_DIR`, temporary Git repository and managed
worktree, separate loopback ports and an offline scripted provider. It uses BB's
actual plugin loader and SQLite storage, then stops its launcher in `finally`.
Pass `--keep` to retain the emitted evidence directory, provider JSONL and
launcher log; by default the harness removes its own data and fixtures. It never
targets the default BB server or Haze. BB may run its normal provider catalog
probes; the harness does not request an authenticated model turn.

The earlier T01-only command exits **2** when the required startup/queued-
dispatch guarantee fails. The integrated T1–T5 command below preserves the known
T4 violation as a failed capability while it runs all other scenarios. Only that
exact T4 diagnostic is expected; fixture/setup/assertion failures, timeouts,
leaks, missing reports/events and unexpected effects make the aggregate command
fail.

The earlier, narrow diagnostic remains available with the same variables:

```sh
node scripts/check-bb-startup-guard.mjs "$BB_APP_PACKAGE" "$BB_SOURCE_CHECKOUT"
```

It checks only the fail-open guard scenario and is not a substitute for T01.

## Full T01 run matrix

Run `2026-09-24` on the runtime pair above, command exit **2**:

| Capability | Result | Live evidence and limit |
| --- | --- | --- |
| Isolated instance and public plugin loader | **Passed** | Fresh data directory and loopback ports; BB loaded the fixture and reported it running. |
| Spawn and rich execution configuration | **Passed** | Public `threads.spawn` created a project thread in a managed worktree. The provider recorded the selected model, reasoning level, service tier, permission mode and unique provider-thread option. |
| Plugin tool/result path | **Passed** | Scripted provider invoked the fixture's SQLite-backed tool. Test instrumentation recorded the exact tool result received by the provider bridge; the turn then completed idle. Counter was 1 afterward. |
| Lifecycle events | **Passed** | Fixture persisted and asserted public `thread.created`, `thread.active`, `thread.idle`, `interaction.pending`, `message.queued` and `message.dispatched` events. |
| Restart and environment retention | **Passed** | BB restart preserved the thread environment id, tool count and an unsubmitted local SQLite intent. |
| Ensemble-owned pending intent and healthy handoff | **Passed, bounded** | The local intent survived restart and public `threads.send({ mode: "auto" })` returned `sent` after healthy plugin load; exactly one tool effect followed. This proves the direct healthy handoff only, not a crash-safe transfer if BB accepts the send but its response is lost, or if the send becomes queued behind another plugin wait. |
| Human interaction | **Passed** | Provider raised a public native user question; the fixture resolved it through public interaction APIs and the thread returned idle. |
| Dispatch hook and core queue composition | **Passed, bounded** | A later Ensemble `reject` overrode an earlier plugin `wait` without persisting a new row. A paused/stopped gate rejected `queue-if-active` before core busy-queueing. A fixture-controlled release barrier held the source turn active until a `thread-busy` row was accepted and the gate paused. That row then stayed queued with a failure reason and dispatched once after recheck on resume. |
| Public queue creation as a hold | **Not supported** | `threads.queuedMessages.create` on an idle conversation created a `thread-busy` row and immediately scheduled its dispatch. It does not provide a durable operator-controlled hold. |
| Lost send response | **Partial** | The harness dropped a successful `threads.send` response for both an immediately sent message and a BB-accepted, plugin-waited queue row. After restart, a unique marker found exactly one public timeline row or queue row; queue recovery preserved its public queue id. The harness did not resend and observed exactly one tool effect after release. Zero or multiple matches stay `uncertain`; the SDK exposes no caller-supplied operation id or in-flight lookup, so this is safe bounded recovery, not general idempotency or an atomic generation fence. T3 separately deleted one stale-generation row before provider effect. |
| Startup with BB-accepted queued work | **Failed capability; harness passed** | When the external wait owner failed but the Ensemble gate loaded paused, its `reject` kept the orphaned accepted row queued with a failure reason and no tool effect; resume dispatched once. When both Ensemble and the wait owner failed, BB cleared the plugin wait, emptied its public queue, and delivered the accepted prompt to the separately loaded provider. Public thread status read `idle`; the provider observed `turn/start`, but this run did not establish a completed turn/tool effect. A guard-unavailable dispatch attempt still crosses the policy boundary. |

The JSON emitted by the command is the run's capability matrix. Pass `--keep`
to retain the disposable BB database, provider request log and launcher log for
inspection; without it, the harness cleans only its isolated resources.

## Other observed behaviour

The exploratory fixture used the same installed launcher, actual plugin loader,
SQLite driver, public CLI/RPC and scripted provider:

| Check | Observation | Evidence limit |
| --- | --- | --- |
| Plugin tool and storage | Scripted provider called a tool that incremented plugin SQLite; the counter survived restart | No model or product UI exercised |
| Normal held-queue restart | Same queued message and hold survived a healthy plugin restart, then drained on `recheck` | Does not cover failed startup; see failed approach |
| Shared environment | Two conversations reused the same managed worktree environment ID | Does not prove concurrent provisioning reconciliation or writer exclusion |
| Stop and resume | Held-open scripted turn stopped; resumed conversation called the tool successfully | Does not establish termination of arbitrary shell descendants |
| Instruction application | Warm follow-up retained its session; stop/resume reconstructed with the revised instruction contribution | Provider-specific context preservation and all profile settings still need coverage |
| Failed-turn retry | Scripted failure reached error; explicit retry returned attempt 2 and failed again as scripted | Does not prove combined BB/Ensemble automatic retry accounting |

The exploratory bridge requests and phase results were retained only as local
temporary evidence. They are not required to run the T01 harness.

## Seven proof gates

| Gate | Current disposition |
| --- | --- |
| Startup and queued dispatch | **Failed on tested runtime**: an accepted queued row stayed held if Ensemble loaded and rejected it, but when Ensemble and the original wait owner were both unavailable BB cleared the hold and sent the row to the provider. Ensemble-local unsent work survived; it cannot govern an accepted BB row while its plugin is absent. |
| Message acceptance and replay | **Partial**: lost spawn/sent/queued responses recovered through unique public markers after restart without blind resend. A bounded stale-generation row was deleted before provider effect; zero/multiple matches remain held, and general idempotency or an atomic generation fence is unproved. |
| Composed writer admission | **Open**: T5 observed another-plugin wait, public rejection, and later release; it has no Ensemble writer reservation to prove admission or ownership cannot be stranded. |
| Stop and writer release | **Failed capability for the delayed-start setup**: active-turn stop was confirmed, but BB returned `ok` for the plugin-held pending thread without changing its status. The fixture withheld recheck; [#676](https://github.com/chrisbanes/ensemble/issues/676) blocks T02/T06 writer release. |
| Initial workspace identity | **Open**: two attempts against one test-local SQLite intent reconciled to one task thread/environment after restart. Two raw parallel BB spawns created distinct environments; production binding and concurrency policy remain unproved. |
| Retry ownership | **Open**: BB per-turn retries and effects were observed across restart; no shared Ensemble/BB retry counter proves the two-retry limit. |
| Revision application | **Open**: T5 matched dynamic instruction revisions to provider requests on the next ordinary turn. It has no operator-authorized apply operation or immutable assignment snapshot. |

The harness/capability ticket can report this failed gate once the full command,
matrix and dependency tracking are reviewed; the failure is not a harness setup
failure. Issue [#665](https://github.com/chrisbanes/ensemble/issues/665) remains
open and blocks dependent execution work until a public-API design or tested BB
capability proves the accepted-queue guarantee. Do not label the startup gate
passed from these narrower observations. No product implementation, installed
Haze plugin reload or shared-instance configuration change was performed.

## Integrated T1–T5 command and report

After installing the pinned toolchain and dependencies, run the same isolated
suite used by CI:

```sh
npm install --global npm@11.20.0
npm ci
npx playwright install chromium
npm run test:bb-integration
```

The command runs the T1 runtime, T2 execution, T3 lost-response, T4 dispatch and
T5 recovery scenarios serially against disposable BB instances. It also runs
report-contract tests. Its deterministic report binds each row to the tested Git
revision and a SHA-256 digest of the integration source files, and is written to
`node_modules/.cache/ensemble-bb-integration/suite-report.json`; six T5 scenario
records are also retained under
`node_modules/.cache/ensemble-bb-integration/suite-run/t5-gates/`. Every API,
proof-gate and T5 scenario row carries tested BB/host-SDK/package-SDK/Node
versions, source revisions or artifact identities, scenario, observed IDs and
effects, verdict, and evidence limit. Required public API evidence and event names
are validated before the report is accepted. The report ends in
`completed-with-capability-gaps` when the harness ran successfully while #665
and #676 remain failed capabilities; this does not unblock T02, T06 or T08.

The host SDK version comes from BB's public `incompatible` install status for a
disposable fixture requiring `bbPluginSdk >=0.5.24`. BB reports the running SDK
as 0.5.9; a separate `>=0.5.9` fixture loads and answers `dispatch.run`.

For `bb-app` and `@get-bb/plugin-sdk`, the report distinguishes lockfile tarball
integrity from SHA-256 hashes of the installed package trees. The committed
tree pins were measured after clean `npm ci` with Node 24.21.0/npm 11.20.0 on
darwin-arm64; CI recomputes those package-scoped hashes on Ubuntu and fails if
either installed tree differs. The tree hash sorts relative paths and includes
entry type, path bytes, and file bytes; symlinks and unsupported entry types are
rejected.
