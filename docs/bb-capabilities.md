# BB capability evidence

Date: 2026-09-24. Live harness runtime: installed **BB 0.43.4** with host SDK
**0.5.9**, plugin SDK package **0.5.24**, Node **24.21.0**, macOS arm64. The
plugin SDK package version is pinned independently of BB's declared host SDK
compatibility version. The loaded plugin exercised SDK 0.5.24 successfully on
this host. The installed BB package exposes version 0.43.4 but no source commit;
the separate pinned source checkout below supplies the scripted provider only,
and is not claimed as the build source for the installed app. These isolated
observations do not prove the Ensemble product is ready.

## Failed approach: startup guard releases queued work

The accepted design requires persisted pause/stop holds to prevent dispatch after
restart, including when Ensemble cannot load. A hook-only implementation failed:

1. A separate guard plugin returned `wait` from `message.dispatch`.
2. BB persisted the message with that plugin as its wait holder.
3. BB was stopped; the guard was made to throw during its next initialization.
4. BB restarted and reported the guard plugin in `error`.
5. BB removed the wait and delivered the held message to the scripted provider.

The full T01 harness reproduced the failure in a fresh instance: counter
**3 → 4**, guard status **error**, queue **empty**, process exit **2**. Its
`threads.send({ mode: "start" })` call returned `delivery: "queued"` under the
guard's public `message.dispatch` wait. Evidence directory:
`/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-bb-t01-bqtRb3`.
The launcher stopped in `finally`; this run used `--keep` for its evidence.

The first run confirmed the provider's recorded `turn/start` request and an empty
queue. The server log explicitly reported that it was clearing the wait because
its holding plugin was not going to run. The reproducible probe below uses a
plugin SQLite counter incremented by a real provider tool call to detect execution.

**Consequence:** a plugin dispatch hook that stores an accepted send as a BB
queue wait cannot implement the accepted startup-failure guarantee on this
runtime. Do not mark T01, T06 or T08 ready based on the healthy-restart check.
This disproves that approach, not every possible Ensemble implementation. No
weaker product guarantee has been accepted.

Candidate BB capability requirement: preserve a queued dispatch wait durably
when its owning plugin is unavailable, with explicit recovery or operator
resolution; alternatively, expose an atomic public send/admission operation that
rejects without persisting whenever dispatch would wait. This is a concrete
candidate based on the tested boundary, not a claim that no other Ensemble
architecture exists. No upstream issue has been filed.

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
it does not establish A14's accepted-queue guarantee. Avoiding this boundary
without changing the contract still needs design review. The harness has not
proved pause/stop racing with submission, another plugin's wait combined with a
pause change, or every failure point before queue receipt/cleanup. Do not add a
second scheduler merely to imitate BB concurrency or treat instruction
compliance as a dispatch interlock.

## Reproduce the T01 harness

From the repository after `npm ci`, using Node 24.21.0:

```sh
node scripts/check-bb-integration.mjs \
  /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app \
  /private/tmp/ensemble-bb-review-20260924
```

The script checks installed BB package **0.43.4**, plugin SDK package **0.5.24**,
and Node **24.21.0**. The actual host declares plugin SDK **0.5.9** compatibility;
this fixture has been loaded and exercised with SDK package 0.5.24 on that host.
The second path is a BB source checkout at
`fdd3de3b19b97e6cd1ef7300cbb54711431249d3`; that revision pins only the source
of BB's MIT-licensed scripted provider bridge, which the harness copies into a
temporary fixture with its license. The installed app does not expose a source
commit, so the harness does not infer that the app binary was built from this
checkout. It imports no BB private SDK path, integration harness or server
internals. A test-only recorder added to the copied provider captures the tool
result delivered back to it.

The harness starts a fresh `BB_DATA_DIR`, temporary Git repository and managed
worktree, separate loopback ports and an offline scripted provider. It uses BB's
actual plugin loader and SQLite storage, then stops its launcher in `finally`.
Pass `--keep` to retain the emitted evidence directory, provider JSONL and
launcher log; by default the harness removes its own data and fixtures. It never
targets the default BB server or Haze. BB may run its normal provider catalog
probes; the harness does not request an authenticated model turn.

Exit code **2** means the required startup/queued-dispatch guarantee failed; it is
not a successful gate. Exit code **1** means fixture/setup/assertion failure.
Exit code **0** requires every mandatory gate in this harness to pass. The
`check:bb` npm script is available for repeatable invocation with the two paths.

The earlier, narrow diagnostic remains available:

```sh
node scripts/check-bb-startup-guard.mjs \
  /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app \
  /private/tmp/ensemble-bb-review-20260924
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
| Lost send response | **Partial** | Harness dropped an accepted `threads.send` response, persisted `uncertain`, restarted, found exactly one matching public timeline row with the same message id, and observed no extra tool effect. Recovery used a unique message marker because the send receipt has no stable caller operation id; this is not general idempotency proof. |
| Startup with BB-accepted queued work | **Failed** | `mode: "start"` returned queued while a public dispatch hook waited. When that hook's plugin failed startup, BB cleared its persisted wait and the provider executed the message. The local unsubmitted intent stayed pending. This is the mandatory open contract, not a harness setup failure. |

The retained run directory was
`/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-bb-t01-483Mbd`.
The JSON emitted by the command is the run's capability matrix; `--keep` also
retains the disposable BB database, provider request log and launcher log for
inspection.

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

Exploratory evidence is retained at
`/private/tmp/ensemble-bb-capability-esiygkgq`, including bridge requests and
phase result files. It is temporary evidence, not a committed runtime dependency.

## Seven proof gates

| Gate | Current disposition |
| --- | --- |
| Startup and queued dispatch | **Failed on tested runtime**: accepted `mode: "start"` send queued behind the hook; after its owner failed startup BB released and executed it. Ensemble-local unsent work did survive; this did not cover the already accepted message. |
| Message acceptance and replay | **Partial**: dropped successful response, persisted uncertainty, recovered one timeline identity after restart and observed no second tool effect. No stable operation id, general idempotency or stale-generation invalidation was proved. |
| Composed writer admission | **Open**: no proof yet that writer reservations compose with another plugin's wait without stranding ownership |
| Stop and writer release | **Partial**: scripted stop/resume observed; arbitrary surviving writers and delayed starts unproven |
| Initial workspace identity | **Partial**: reuse observed; uncertain provisioning and competing launches unproven |
| Retry ownership | **Partial**: retry API observed; global two-retry allowance across mechanisms unproven |
| Revision application | **Partial**: instruction contribution requires session reconstruction in this fixture; product apply flow unproven |

The startup contract remains unproven and blocks dependent execution work;
unrelated design and harness work can continue. Remaining checks must not be
labelled passed from source inspection or these narrower observations. No product
implementation, installed Haze plugin reload, shared-instance configuration
change, or remote mutation was performed.
