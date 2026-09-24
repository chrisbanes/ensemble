# BB capability evidence

Date: 2026-09-24. Runtime tested: installed **BB 0.43.4**, SDK **0.5.9**,
Node **24.21.0**, macOS arm64. These are isolated integration observations, not
proof that the Ensemble product or the complete T01 harness is ready.

## Failed approach: startup guard releases queued work

The accepted design requires persisted pause/stop holds to prevent dispatch after
restart, including when Ensemble cannot load. A hook-only implementation failed:

1. A separate guard plugin returned `wait` from `message.dispatch`.
2. BB persisted the message with that plugin as its wait holder.
3. BB was stopped; the guard was made to throw during its next initialization.
4. BB restarted and reported the guard plugin in `error`.
5. BB removed the wait and delivered the held message to the scripted provider.

The saved probe reproduced the failure in a fresh instance: counter **1 → 2**,
guard status **error**, queue **empty**, process exit **2**. Evidence directory:
`/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-bb-startup-probe-L8H5I0`.
The test launcher shut down afterward.

The first run confirmed the provider's recorded `turn/start` request and an empty
queue. The server log explicitly reported that it was clearing the wait because
its holding plugin was not going to run. The reproducible probe below uses a
plugin SQLite counter incremented by a real provider tool call to detect execution.

**Consequence:** a plugin dispatch hook alone cannot implement the accepted
startup-failure guarantee on this runtime. Do not mark T01, T06 or T08 ready based
on the happy-path restart check. This disproves that approach, not every possible
Ensemble implementation. Evaluate the dispatch boundary below before declaring a
BB change necessary. No weaker product guarantee has been accepted.

Potential upstream requirement: a way to declare that persisted waits must remain
held when their owning plugin is unavailable, with explicit operator resolution.
This is a proposed requirement, not a claim about an existing API. No upstream
issue has been filed.

## Alternative under investigation: retain pending work in Ensemble

Keep pending assignment starts and continuations in Ensemble's SQLite database
until eligible for dispatch. If Ensemble fails to load, it cannot submit that
pending work. This removes the need to store its own pause/stop backlog as BB
plugin waits. It is a candidate design, not a tested replacement for the guard.

The unresolved boundary is work already submitted to BB. Source inspection at the
pinned revision shows:

- `apps/server/src/services/threads/thread-send-request.ts` routes sends through
  `attemptDispatch` and returns either sent or queued.
- `dispatch-attempt.ts` evaluates plugin policy and then core waits. Another
  plugin can request a wait; stopping, provisioning, busy threads and other core
  conditions can also queue work. A pre-send idle check is not an atomic admission.
- SDK 0.5.9's `SendMessageRequest` has no explicit “execute now or reject without
  persisting” option. The `start` mode is not such a guarantee: plugin waits are
  evaluated before its active-thread check.
- Deleting a returned queue row afterward leaves a crash/lost-response window.
  It must not be treated as atomic cancellation or proof of no later execution.

Next proof: establish whether public APIs can avoid or durably protect this
handoff window while retaining BB concurrency controls. Cover pause/stop racing
with submission, another plugin's wait, and failure before queued-send response
or cleanup. If they cannot, identify the precise BB capability required or bring
a concrete limitation back for review. Do not add a second scheduler merely to
imitate BB's concurrency limit, or treat instruction compliance as a dispatch
interlock. This investigation does not change the accepted product contract.

## Reproduce

From the repository after `npm ci`, using Node 24.21.0:

```sh
node scripts/check-bb-startup-guard.mjs \
  /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app \
  /private/tmp/ensemble-bb-review-20260924
```

The second argument must be a BB source checkout at
`fdd3de3b19b97e6cd1ef7300cbb54711431249d3`. The script checks both the source
revision and installed package version. It copies BB's MIT-licensed scripted
bridge and license into a temporary fixture and registers it through the public
plugin API. It does not import BB's private integration harness or server internals.

The probe starts a new data directory, temporary Git repository/worktree and
separate loopback ports, runs an offline provider, then stops its own launcher
in `finally`. It retains `result.json`, launcher logs and isolated runtime data in
the printed directory. It never targets the default BB server or Haze. The BB
server may run its normal provider catalog probes; no authenticated model turn is
requested by this test.

Exit code **2** means the unsafe dispatch was reproduced, not that the gate passed.
Exit code **3** means it was not reproduced in the observation window; this alone
is not a passing proof. Other failures indicate fixture/setup/assertion errors.
This is a diagnostic probe, not an always-green CI test.

## Other observed behaviour

The initial exploratory fixture used the same installed launcher, actual plugin
loader, SQLite driver, public CLI/RPC and scripted provider:

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
| Startup and queued dispatch | **Open design boundary**: hook-only approach failed when the guard cannot initialize; healthy restart observed |
| Message acceptance and replay | **Open**: lost-response correlation, stale-generation invalidation and no duplicate effect still need end-to-end evidence |
| Composed writer admission | **Open**: no proof yet that writer reservations compose with another plugin's wait without stranding ownership |
| Stop and writer release | **Partial**: scripted stop/resume observed; arbitrary surviving writers and delayed starts unproven |
| Initial workspace identity | **Partial**: reuse observed; uncertain provisioning and competing launches unproven |
| Retry ownership | **Partial**: retry API observed; global two-retry allowance across mechanisms unproven |
| Revision application | **Partial**: instruction contribution requires session reconstruction in this fixture; product apply flow unproven |

The startup contract remains unproven; unrelated design and harness work can
continue. Remaining checks must not be labelled passed from source inspection or
these narrower observations.
No product implementation, installed Haze plugin reload, or shared-instance
configuration change was performed.
