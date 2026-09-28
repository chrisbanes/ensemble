# S01 seven-row acceptance candidate — 28 September 2026

**Final acceptance candidate: seven rows qualify within the approved S01 bounds.**
This matrix applies the [seven bounded S01 rows](https://github.com/chrisbanes/ensemble/issues/688) and the
[approved runtime trust boundary](../design/standalone.md#runtime-trust-boundary).
It reports bounded integration feasibility, not an installed Ensemble service. No
dependency or held execution is released by this report.

## Source and test identity

The dedicated `cb/35-s01-proof` checkout was clean at
`77a383fd64144df83dcc65f7b1888286d1f39b55`. Merge
`6e9bd0419e12cba3507dd4ccd3157d69d2f47dea` has that evidence head and
approved source `f8b2305c04feafc4b3e8977ad3151938deac2219` (#702) as its
two parents. The merged minimum-contract baseline was
`f0eaabdb30d34aad745771592f175d097ec9678a`; the original runtime source
base was `8e3ab9387389f5040631cd06e2156186aaffbc6c`. Merge conflicts in
the then-current `docs/delivery.md` and `s01-existing-evidence-2026-09-28.md`
took the approved source versions. The five contract files and published earlier
matrix then matched `f8b2305` after resolution. All local historical S01 fixture scripts,
raw traces and failed stronger-contract reports were retained. The published
[qualification report](s01-qualification-report-2026-09-28.md) and
[earlier matrix](s01-existing-evidence-2026-09-28.md) are secondary indexes;
the linked local traces and contemporaneous reports below are primary evidence.
This fix-first publication branch starts at approved `f8b2305` and imports a
sanitized snapshot of the private evidence tree. The former reviewed head
`67cbeb47ce92c83afbbd4f2cb8603f40b76966ea` and its unsanitized blobs are
provenance, **not ancestors** of this branch. See the
[publication manifest](s01-publication-sanitization-2026-09-28.md) for public
trace hashes and the private-original preservation boundary.
The publication branch then merged approved source `4f410806405234f70a109e00263801f76f1a9968`
(#706) at `cfb9f4d69eb23fd3c0b1f983a3691c68b429a267`; #706 removed
`docs/delivery.md` and made #688 authoritative. The former plan is historical,
not a parallel acceptance checklist.

Observed real Codex probes used macOS 26.7 arm64, `/opt/homebrew/bin/codex`
`codex-cli 0.157.1` (SHA-256
`27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d`),
existing ChatGPT login and disposable fixtures. The selected shell-policy turns
reported `gpt-6-sol`; their [raw trace](s01-model-policy-trace-2026-09-28.jsonl)
SHA-256 is `bf5e115d06d367004a778d6230b0d57bf76ea7bbb08fdbd25685418d44f73265`.
SQLite fixtures used Python 3.9.6 and SQLite 3.51.0. Earlier probes at their
listed commits did not necessarily share one identical runtime configuration.
The installed generated App Server schema was pinned by SHA-256:
`ClientRequest.json` `0f8733c93b3609fa82337ae94f8a4971b93e3327b0b3e99dce2a86cf495d925b`,
`ServerRequest.json` `3d7bc481f84dc042984a74420e65c5a8d3c423f37a91b7d5df2365c903a12ac6`,
and `ServerNotification.json` `871046f308da617d6cbfb372ff0260a778d8b959ae7eca8757a2edcb4c5f3900`.
The `dynamicTools`/`item/tool/call` surface is experimental; S02–S05 must retain
an explicit version/schema compatibility check.

## Finite coverage matrix

“Qualified within bounds” is an S01 feasibility disposition, not a service
implementation pass. #688's S01-only amendment permits row 7 to qualify from
selected-policy readback and attributable write, command-network and
streamed/stored-history evidence while model-originated escalation rejection
remains unproved. A row's untested product path remains assigned to S02–S05.

| Required [#688](https://github.com/chrisbanes/ensemble/issues/688) row | Disposition and exact primary provenance | Limit / later owner |
| --- | --- | --- |
| Authenticated lifecycle — R01/A18 | **Qualified within bounds.** Existing-login real turn, event/result, `thread/read` and same-thread `thread/resume` at [`221f875`](s01-2026-09-27.md); native command/result matched live and stored history after isolated-server restart at [`b085bc9`](s01-native-history-trace-2026-09-28.jsonl). Two selected shell turns before/after another restart preserved thread history and policy selection at [`89f6f84`](s01-model-policy-trace-2026-09-28.jsonl). Operator-context login status and isolated unavailable-login detection at [`8c44381`](s01-revision4-2026-09-28.md). | Ephemeral turns were not resumable; stored resume is not live reattachment. Expired-login and installed-service startup/login hold belong to S02/S05. |
| Trusted caller — A25 | **Qualified within bounds.** Real `dynamicTools` callback at [`8c44381`](s01-r4-identity-trace-2026-09-28.jsonl) rejected payload assignment B despite trusted thread A binding and accepted A. [SQLite identity trace](s01-minimum-recovery-trace-2026-09-28.jsonl) rejected old generation, unbound thread and invalidated binding. | New stale/unbound cases are deterministic fixtures, not new real callbacks. Pin experimental callback API; S04/S05 test product action policy and approval invalidation. |
| Admission and durable state — A14/A16 | **Qualified within bounds.** WAL/FULL `BEGIN IMMEDIATE` fixture at [`c082030`](s01-r5-admission-trace-2026-09-28.jsonl) admitted one of two contenders and held eight negative gates. [State trace](s01-discovery-state-trace-2026-09-28.jsonl) adds storage rollback, initialization/policy failure, independent-project pause, Stop-before-delivery, service absence/capacity and SQLite reopen. Coordinator-crash [trace](s01-r5-coordinator-trace-2026-09-28.jsonl) kept a follow-up queued without dispatch. | A proposed durable coordination seam, not a product scheduler. S03/S05 test every real admission path and race. |
| Ambiguous submission — A08/A09 | **Qualified within bounds.** Real `turn/start` response loss before binding at [`c082030`](s01-r5-lost-response-trace-2026-09-28.jsonl) retained one operation, null turn ID and holds without resubmission. [Recovery trace](s01-minimum-recovery-trace-2026-09-28.jsonl) covers missing/multiple matches before binding, missing/conflicting matches after binding and stale revision; all remain uncertain, with one dispatch. [Result trace](s01-discovery-state-trace-2026-09-28.jsonl) preserves one event/operation across acknowledgement loss. | Match facts and result delivery are SQLite fixtures. Positive unique live reattachment is not a universal gate; actual send/inbox/recovery belong to S03–S05. |
| Cancellation and survival — A15 | **Qualified within bounds.** Real writer/escaped child survived App Server and coordinator death at [`c082030`](s01-r5-lost-response-trace-2026-09-28.jsonl) and [coordinator trace](s01-r5-coordinator-trace-2026-09-28.jsonl). Durable Stop preceded real `turn/interrupt`; a child wrote late while replacement remained denied throughout a predeclared three-second observation and holds survived SQLite reopen at [`8c44381`](s01-r4-hold-trace-2026-09-28.jsonl). | Best-effort cancellation, not descendant termination. Earlier failed [termination evidence](s01-revision3-crash-stop-2026-09-28.md) remains valid. No timer or acknowledgement releases unresolved holds; S03/S05 own integrated supervision/recovery. |
| Cooperative handoff — A16/A18 | **Qualified within bounds of the amended trust rule.** A bound real turn reported successful terminal status with its registered command ended; two SQLite contenders admitted exactly one successor at [`c082030`](s01-r5-handoff-trace-2026-09-28.jsonl). The [independent oracle](s01-r5-handoff-oracle-2026-09-28.jsonl) then proved an old detached child could write alongside it. A new [15-record fixture](s01-trust-boundary-trace-2026-09-28.jsonl) rejected missing/wrong bound thread or turn, missing/failed/interrupted status, active callback, known unfinished action, Stop/crash/uncertainty holds and late success after Stop/crash; holds survived SQLite reopen. Eligible success admitted exactly one of two racing claims, `PRAGMA integrity_check=ok`. | The new negatives are SQLite feasibility only; the earlier real turn had a command, not an Ensemble callback. Missing diagnostic tool items alone no longer block normal success. Overlapping writers and incomplete observation are expressly accepted; S03/S05 test integrated callbacks and handoff. |
| Effective policy and observations — A25/R01 | **Qualified within the #688 S01-only amendment.** The [direct command trace](s01-minimum-policy-trace-2026-09-28.jsonl) and two [model shell turns](s01-model-policy-trace-2026-09-28.jsonl) show explicit `workspaceWrite`/`never` selection/readback, attributable inside success, outside/temporary write denial, controlled loopback command-network denial, and matching streamed/stored command history before and after isolated-server restart. A [separate attempted escalation](s01-escalation-attempt-trace-2026-09-28.jsonl) produced no command or approval request and no outside effect: inconclusive, not a rejection. | **Model-originated escalation rejection remains unproved**, as expressly accepted for S01 only; no selected-policy breach was observed. S02 #689 owns deterministic rejection of unexpected approval callbacks in the adapter and S05 #695 owns integrated approval-flow testing before release. Broad reads, inherited environment, ambient tools and other tool classes remain disclosed limits. The older [unexplained inside effect](s01-minimum-turn-trace-2026-09-28.jsonl) remains diagnostic, without an attributable command item. |

The selected runtime evidence does not demonstrate an ineffective required
write/network/approval control. It also does not demonstrate rejection of a
model-originated broader-access request under `never`; that remains an accepted
**S01-only evidence limit**, not a product permission grant. This candidate
does not itself pass S01; it awaits pinned final-head verification, affected
review and coordinator acceptance. It does not prove exhaustive tool history,
physical writer exclusion, execution of all model tool classes or an installed
service. The approved trust boundary accepts incomplete diagnostics and possible
overlap on bound normal success, while crash/Stop/failure/ambiguous execution
continues to hold until independently resolved. Ensemble must never use the
unsandboxed `thread/shellCommand` client route for task execution. The
[operator recovery route](../design/standalone.md#operator-recovery-of-uncertain-execution)
is a later procedure, not a reboot authorization or a timer unlock.

## New bounded negative-case fixture and validation

Before running, the budget was one disposable real-SQLite fixture, no Codex
process/model call and no rerun. Command:

```text
python3 -m py_compile test/s01/trust_boundary_fixture.py
python3 test/s01/trust_boundary_fixture.py ../.s01-trust-boundary-20260928-a
```

The source SHA-256 is
`87d37ce161f5f1b251306f3d941a1be658982bfcd4b7a0c8b540fada559389ca`;
the 15-record [trace](s01-trust-boundary-trace-2026-09-28.jsonl) SHA-256 is
`ceffe17aad486cdd45a5d01d16cf7f9d0dcb9f42c150eb844455ca138ebaf9c2`.
Fourteen negative claims left holds `1/1` and no successor; the final concurrent
claims were `[false,true]` and left one successor, holds `0/0`, integrity `ok`.
The script used WAL/FULL SQLite and `BEGIN IMMEDIATE`; its synthetic terminal
facts are not a real Codex or product callback test. It created only its
disposable database/trace directory, closed its process, and left the directory
for audit. No prior trace or fixture was modified.

The original S01 probe scripts/traces, the published qualification report and
this matrix should be reviewed together. No new login/configuration, credential
copy, Haze/existing-session access, GitHub mutation, deployment, reboot or
downstream execution occurred in this reconciliation.

## Historical Watson fix-first: broader-access evidence

Review of head `67cbeb47ce92c83afbbd4f2cb8603f40b76966ea` found that row 7
had been promoted without an attributable rejected escalation. The accepted
shell-policy traces tested ordinary denied writes; they did not request broader
permission. Before this follow-up, the budget was **one real turn, zero reruns**
under the existing login, selected `workspaceWrite`/`never` policy and fresh
disposable inside/outside targets. Commands:

```text
python3 -m py_compile test/s01/escalation_probe.py
codex --version
codex login status
python3 test/s01/escalation_probe.py ../.s01-escalation-20260928-a
```

The 75-record [sanitized trace](s01-escalation-attempt-trace-2026-09-28.jsonl)
spans Unix 1790616121.663–1790616130.205 (8.543 seconds). App Server PID/PGID
11118 selected `approval_policy=never` and `sandbox_mode=workspace-write`;
the turn selected explicit `workspaceWrite`, the task root, temporary-root
exclusions, `networkAccess:false` and `approvalPolicy:never`. The prompt asked
for one elevated foreground shell request targeting only a synthetic sibling
file. The turn completed, but there were **zero** approval requests and **zero**
`commandExecution` items in the retained live events or stored turn. The target
file did not exist. The result is **inconclusive**: neither model refusal nor
ordinary no-effect proves that the runtime rejected a broader request. No
automatic retry followed. The isolated App Server exited -9 after exact-PGID
cleanup; the disposable fixture remains private for audit. Source SHA-256 is
`1aa82a22031df0d673935633eaf37c897a11660ed7346d07a4a87c4d86de7d42`;
the public trace hash is `d0fbc1c57c9eb0ec0f32c4b29e5c9dd31ca65a55d275cbaf9b48bcc419f5a4a7`.

**Then-required next evidence (superseded for S01 by #688):** a supported, bounded way to make a broader command
permission request reach the selected installed runtime and capture its denial
with command/turn identity and no forbidden effect. At that checkpoint row 7
remained missing required bounded evidence, and S01 and its dependent issues
stayed held. The later #688 amendment changed only this S01 evidence gate;
the inconclusive trace remains unchanged.
This is not a demonstrated policy failure or a request to weaken the approved
policy. Any new experiment needs its own bounded brief; do not repeat the same
model prompt unchanged.

## Row 7 supported-path preflight (no model call)

At publication head `53aa145eee3954a5700b1d4833b4bbdeefe15dc3`, a read-only
inspection of the installed `codex-cli 0.157.1` protocol schema, `codex
app-server --help`, and the inconclusive 75-record trace found no deterministic
selected `workspaceWrite`/`never` client path to submit a **model-originated**
broader-access command for rejection. `TurnStartParams` exposes input,
`approvalPolicy` and `sandboxPolicy`, but no command or tool-choice field.
`CommandExecParams` accepts a command and sandbox policy, but `command/exec` is
a standalone client RPC, not a model turn item. The command and permission
`requestApproval` methods occur only in `ServerRequest.json`; a client cannot
invoke them as an authentic model request. `thread/inject_items` and
`turn/start.toolOutput` would insert client-supplied history/output, not exercise
the selected command policy. The [official App Server approval flow](https://learn.chatgpt.com/docs/app-server#approvals)
describes server-initiated approval requests; the [official approval guidance](https://learn.chatgpt.com/docs/sandboxing/auto-review)
says `approval_policy = "never"` leaves nothing to review. These interface facts
do not establish a runtime rejection in the prior turn: its stored items were
only user message, reasoning and agent message, with no command or approval
request and no outside effect. A changed prompt would still rely on model tool
choice, so this preflight did not justify the authorized one-turn budget.
**Model calls: 0; reruns: 0; new fixtures/processes: 0.** At that checkpoint,
row 7 still lacked the then-required bounded rejection evidence; no policy
failure or waiver was inferred. Chris subsequently made the explicit S01-only
evidence decision in [#688](https://github.com/chrisbanes/ensemble/issues/688).
The other six rows, raw-private/public-sanitized trace split, and earlier
failed findings were unchanged by that preflight.

Preflight commands (read-only):

```text
git status --short --branch
git rev-parse HEAD
command -v codex
codex --version
codex app-server --help
rg -n 'requestApproval|approvalPolicy|sandboxPolicy|toolChoice|command/exec|thread/shellCommand' ../.s01-r5-access-schema
python3 - <<'PY'
import json
for p in ('../.s01-r5-access-schema/ClientRequest.json',
          '../.s01-r5-access-schema/ServerRequest.json'):
    d = json.load(open(p))
    print(p)
    for k in ('TurnStartParams', 'ThreadStartParams', 'CommandExecParams',
              'CommandExecutionRequestApprovalParams',
              'PermissionsRequestApprovalParams'):
        if k in d.get('definitions', {}):
            print(k, list(d['definitions'][k].get('properties', {})))
PY
python3 - <<'PY'
import json
p = 'docs/evidence/s01-escalation-attempt-trace-2026-09-28.jsonl'
rows = [json.loads(line) for line in open(p)]
print('records', len(rows))
print('methods', sorted({r['event']['method'] for r in rows
                         if isinstance(r.get('event'), dict)}))
for row in rows:
    if 'turn_status' in row:
        print({k: row.get(k) for k in ('turn_status', 'approval_requests',
              'command_events', 'outside_effect', 'stored_items')})
PY
```

The schema copy was generated during the prior bounded S01 work and remains
task-local at `../.s01-r5-access-schema/`. No new App Server was started.

## Integrated validation and limits

On this publication worktree, `npm ci --no-audit --no-fund` succeeded and
`npm run check` passed typecheck, Biome lint/format, TypeScript build and all
19 retained core tests. The installed
Node/npm were 24.19.0/11.17.0, while this repository pins 24.21.0/12.1.0;
the check is a local result under those installed versions, not a pinned-toolchain
result or a standalone-service test. Churchill separately recorded a pinned
Node/npm pass on prior head `67cbeb4`; this publication snapshot changes no
product TypeScript or lockfile, but that earlier result is not a check on this
new Git head. A prior task-local
`npm exec --package=node@24.21.0 --package=npm@12.1.0` attempt exited 1 when
the `node@24.21.0` preinstall exited 1; it ran no check and changed no global
toolchain. Its disposable npm cache was removed. `python3 -m py_compile` and
the trust-boundary SQLite fixture passed on the prior evidence head; the new
escalation script compiled and its one real turn is reported above. Public
JSONL copies parsed, local evidence links resolved, and published trace hashes
matched the [sanitization manifest](s01-publication-sanitization-2026-09-28.md).
The original approved contract files and published matrix came from `f8b2305`;
the current #688 amendment and repo contract updates came from merged `4f41080`.
No earlier failed observation was rewritten as a pass.

## Final #688 reconciliation and deterministic replay

This candidate applies the S01-only approval-evidence decision in #688. It
does not claim a model-originated escalation rejection: the 75-record attempted
turn had no command or approval request and no outside effect. The earlier
unexplained inside file effect without a command item remains diagnostic. The
selected foreground shell turns and direct command probe establish only the
bounded policy/history behavior shown in row 7. S02 #689 must deterministically
reject unexpected approval callbacks in its adapter; S05 #695 must test the
integrated approval flow before release. Any demonstrated selected-policy
failure would still block the affected capability.

The merged source commit is `4f410806405234f70a109e00263801f76f1a9968`,
the publication evidence parent is `e2145d69cb871645a97b56c617b1828c0c8ae976`,
and the integration merge is `cfb9f4d69eb23fd3c0b1f983a3691c68b429a267`.
The private reviewed raw head `67cbeb47ce92c83afbbd4f2cb8603f40b76966ea`
is not in this branch's ancestry. The final evidence head is the commit
containing this reconciliation. No new model or App Server call was made.

Affected deterministic checks were rerun once on this merged checkout with
fresh, private disposable directories; each command exited 0:

```text
mkdir -p ../.s01-final-fixtures-20260928
python3 test/s01/trust_boundary_fixture.py ../.s01-final-fixtures-20260928/trust
python3 test/s01/minimum_recovery_fixture.py ../.s01-final-fixtures-20260928/recovery
python3 test/s01/discovery_state_probe.py ../.s01-final-fixtures-20260928/state
python3 test/s01/revision5_admission_probe.py ../.s01-final-fixtures-20260928/admission
```

The trust, recovery, state and admission traces contained 15, 13, 17 and 16
records respectively; all four SQLite databases returned
`PRAGMA integrity_check=ok`. Trust admitted exactly one of two eligible
successors; recovery retained one dispatch and holds on stale revision; state
retained one result event; admission admitted one of two contenders. These are
coordination feasibility fixtures, not implemented-service tests. Their
processes exited and database connections closed. The four task-local
directories remain private for audit; no new trace was published.

| Fixture source | SHA-256 | Published historical trace | SHA-256 |
| --- | --- | --- | --- |
| `test/s01/trust_boundary_fixture.py` | `87d37ce161f5f1b251306f3d941a1be658982bfcd4b7a0c8b540fada559389ca` | [trust](s01-trust-boundary-trace-2026-09-28.jsonl) | `ceffe17aad486cdd45a5d01d16cf7f9d0dcb9f42c150eb844455ca138ebaf9c2` |
| `test/s01/minimum_recovery_fixture.py` | `905e6500f612e43a04ab5c4da5570cbf88699a4484f1dba9e1bf1d2ec5805b40` | [recovery](s01-minimum-recovery-trace-2026-09-28.jsonl) | `914dfcc8a04a241e988eefff57ee028b369b9e74d0a3b6194489bcd596aef957` |
| `test/s01/discovery_state_probe.py` | `e8bddee1ccc2048ba80ccced79300de4549e6b76e23b5a94f292ec98a4e287f1` | [state](s01-discovery-state-trace-2026-09-28.jsonl) | `da764af1611d47ab8b2f82399ab5f28e5651a904c1bd978e521bf71dd6ec6328` |
| `test/s01/revision5_admission_probe.py` | `2d6c8598fa14eb81e89f9c7ca4617a1332855fe28c2244c08229f716219f2227` | [admission](s01-r5-admission-trace-2026-09-28.jsonl) | `83ab1fcc2a1b9129cc45461f2587d115427188abc612571597f2cc163edbb929` |

Key policy/history public-trace SHA-256 values: [selected model shell](s01-model-policy-trace-2026-09-28.jsonl)
`bf5e115d06d367004a778d6230b0d57bf76ea7bbb08fdbd25685418d44f73265`,
[native history](s01-native-history-trace-2026-09-28.jsonl)
`95063e6a12d339cb521b59a324c36e201d77f6e60bf973864cb84983745739da`,
and [inconclusive escalation](s01-escalation-attempt-trace-2026-09-28.jsonl)
`d0fbc1c57c9eb0ec0f32c4b29e5c9dd31ca65a55d275cbaf9b48bcc419f5a4a7`.
Other path-redacted hashes are in the [publication manifest](s01-publication-sanitization-2026-09-28.md).

The installed environment at reconciliation is macOS 26.7 arm64,
`codex-cli 0.157.1`, Python 3.9.6/SQLite 3.51.0 and Node 24.19.0/npm 11.17.0.
Repository pins are Node 24.21.0/npm 12.1.0. The earlier `npm run check` result
under the available versions belongs to publication head `53aa145`; pinned
`npm ci`/`npm run check` on this final head remains Churchill's final-head gate.
