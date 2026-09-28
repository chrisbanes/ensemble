# S01 seven-row acceptance candidate — 28 September 2026

**Fix-first coverage report: six rows qualify; row 7 is missing required evidence.** This matrix applies
the [seven bounded S01 rows](../delivery.md#s01-completion-rule) and the
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
`docs/delivery.md` and `s01-existing-evidence-2026-09-28.md` took the approved
source versions. The five current contract files and published earlier matrix
matched `f8b2305` after resolution. All local historical S01 fixture scripts,
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
implementation pass. Row 7 is held for an attributable broader-access rejection;
its selected shell results remain valid within their stated bounds. A row's untested
product path remains assigned to S02–S05.

| Required `docs/delivery.md` row | Disposition and exact primary provenance | Limit / later owner |
| --- | --- | --- |
| Authenticated lifecycle — R01/A18 | **Qualified within bounds.** Existing-login real turn, event/result, `thread/read` and same-thread `thread/resume` at [`221f875`](s01-2026-09-27.md); native command/result matched live and stored history after isolated-server restart at [`b085bc9`](s01-native-history-trace-2026-09-28.jsonl). Two selected shell turns before/after another restart preserved thread history and policy selection at [`89f6f84`](s01-model-policy-trace-2026-09-28.jsonl). Operator-context login status and isolated unavailable-login detection at [`8c44381`](s01-revision4-2026-09-28.md). | Ephemeral turns were not resumable; stored resume is not live reattachment. Expired-login and installed-service startup/login hold belong to S02/S05. |
| Trusted caller — A25 | **Qualified within bounds.** Real `dynamicTools` callback at [`8c44381`](s01-r4-identity-trace-2026-09-28.jsonl) rejected payload assignment B despite trusted thread A binding and accepted A. [SQLite identity trace](s01-minimum-recovery-trace-2026-09-28.jsonl) rejected old generation, unbound thread and invalidated binding. | New stale/unbound cases are deterministic fixtures, not new real callbacks. Pin experimental callback API; S04/S05 test product action policy and approval invalidation. |
| Admission and durable state — A14/A16 | **Qualified within bounds.** WAL/FULL `BEGIN IMMEDIATE` fixture at [`c082030`](s01-r5-admission-trace-2026-09-28.jsonl) admitted one of two contenders and held eight negative gates. [State trace](s01-discovery-state-trace-2026-09-28.jsonl) adds storage rollback, initialization/policy failure, independent-project pause, Stop-before-delivery, service absence/capacity and SQLite reopen. Coordinator-crash [trace](s01-r5-coordinator-trace-2026-09-28.jsonl) kept a follow-up queued without dispatch. | A proposed durable coordination seam, not a product scheduler. S03/S05 test every real admission path and race. |
| Ambiguous submission — A08/A09 | **Qualified within bounds.** Real `turn/start` response loss before binding at [`c082030`](s01-r5-lost-response-trace-2026-09-28.jsonl) retained one operation, null turn ID and holds without resubmission. [Recovery trace](s01-minimum-recovery-trace-2026-09-28.jsonl) covers missing/multiple matches before binding, missing/conflicting matches after binding and stale revision; all remain uncertain, with one dispatch. [Result trace](s01-discovery-state-trace-2026-09-28.jsonl) preserves one event/operation across acknowledgement loss. | Match facts and result delivery are SQLite fixtures. Positive unique live reattachment is not a universal gate; actual send/inbox/recovery belong to S03–S05. |
| Cancellation and survival — A15 | **Qualified within bounds.** Real writer/escaped child survived App Server and coordinator death at [`c082030`](s01-r5-lost-response-trace-2026-09-28.jsonl) and [coordinator trace](s01-r5-coordinator-trace-2026-09-28.jsonl). Durable Stop preceded real `turn/interrupt`; a child wrote late while replacement remained denied throughout a predeclared three-second observation and holds survived SQLite reopen at [`8c44381`](s01-r4-hold-trace-2026-09-28.jsonl). | Best-effort cancellation, not descendant termination. Earlier failed [termination evidence](s01-revision3-crash-stop-2026-09-28.md) remains valid. No timer or acknowledgement releases unresolved holds; S03/S05 own integrated supervision/recovery. |
| Cooperative handoff — A16/A18 | **Qualified within bounds of the amended trust rule.** A bound real turn reported successful terminal status with its registered command ended; two SQLite contenders admitted exactly one successor at [`c082030`](s01-r5-handoff-trace-2026-09-28.jsonl). The [independent oracle](s01-r5-handoff-oracle-2026-09-28.jsonl) then proved an old detached child could write alongside it. A new [15-record fixture](s01-trust-boundary-trace-2026-09-28.jsonl) rejected missing/wrong bound thread or turn, missing/failed/interrupted status, active callback, known unfinished action, Stop/crash/uncertainty holds and late success after Stop/crash; holds survived SQLite reopen. Eligible success admitted exactly one of two racing claims, `PRAGMA integrity_check=ok`. | The new negatives are SQLite feasibility only; the earlier real turn had a command, not an Ensemble callback. Missing diagnostic tool items alone no longer block normal success. Overlapping writers and incomplete observation are expressly accepted; S03/S05 test integrated callbacks and handoff. |
| Effective policy and observations — A25/R01 | **Missing required bounded evidence.** The [direct command trace](s01-minimum-policy-trace-2026-09-28.jsonl) and two [model shell turns](s01-model-policy-trace-2026-09-28.jsonl) qualify selected inside/outside write, loopback, live/stored command history and policy readback before/after restart. A [single new real turn](s01-escalation-attempt-trace-2026-09-28.jsonl) asked for an elevated shell permission under `workspaceWrite`/`never`, but produced no approval request or command item; the synthetic outside target remained absent. That outcome is inconclusive, not a rejected escalation. | Watson’s required broader-access rejection remains unproved. Ordinary denied writes and `never` readback cannot substitute for an attributable rejection. This is a missing-evidence gate, not a demonstrated control breach. Broad reads, inherited environment, ambient tools and other tool classes remain disclosed limits; S02–S05 own broader integrated policy tests. The older [unexplained inside effect](s01-minimum-turn-trace-2026-09-28.jsonl) remains diagnostic. |

The selected runtime evidence does not demonstrate an ineffective required
write/network/approval control. It also does not demonstrate rejection of a
broader-access request under `never`, so row 7 and S01 remain unpassed. It also does not prove exhaustive tool history,
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

## Watson fix-first: broader-access evidence

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

**Required next evidence:** a supported, bounded way to make a broader command
permission request reach the selected installed runtime and capture its denial
with command/turn identity and no forbidden effect. Until then row 7 remains
missing required bounded evidence, and S01 and its dependent issues stay held.
This is not a demonstrated policy failure or a request to weaken the approved
policy. Any new experiment needs its own bounded brief; do not repeat the same
model prompt unchanged.

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
The approved contract files and published matrix come from `f8b2305`; no
earlier failed observation was rewritten as a pass.
