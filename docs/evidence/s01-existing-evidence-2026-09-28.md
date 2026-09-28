# S01 existing evidence matrix — 28 September 2026

**S01 remains unpassed.** This durable matrix preserves the observations and gaps
from the local S01 investigation so a fresh checkout can inspect their scope.
It is a reviewed summary of existing reports, not a new probe run, a substitute
for underlying traces, or acceptance of the implemented service.

## Later qualification and trust-boundary amendment

This matrix is a historical snapshot of the evidence available at the minimum
integration reset. Later qualification on local `cb/35-s01-proof` at
`77a383fd64144df83dcc65f7b1888286d1f39b55`, in
`docs/evidence/s01-minimum-contract-qualification-2026-09-28.md`, reports matching
live/stored command items and effective selected shell write/loopback policy before
and after restart, plus stale-generation and ambiguous-binding fixtures. That
checkout and its underlying traces remain the evidence source; they are not
published by this amendment.

Chris subsequently approved the [runtime trust boundary](../design/standalone.md#runtime-trust-boundary).
The later report's requirement for exhaustive method observations is superseded;
its unexplained file effect remains a diagnostic finding. Reconcile evidence using
the [finite S01 completion rule](../delivery.md#s01-completion-rule). The older
"unproved" rows below describe this snapshot, not an instruction to rerun evidence
qualified later. Neither this note nor the contract amendment accepts S01.

## Provenance and limits

Source: `docs/evidence/s01-consolidated-discovery-2026-09-28.md` in the separate
`cb/35-s01-proof` checkout at `e87ed326182b602c412606d1e88d6ae481188eb2`, inspected
read-only, alongside its `s01-revision5-command-access-2026-09-28.md` report
for the attributable access results. The consolidated report covers the revision 3–5 contract at
`56976c0cea82d4dadfac73ab60979e0cfed69c30` and source base
`8e3ab9387389f5040631cd06e2156186aaffbc6c`. The investigation commits, scripts and
raw traces are not part of this published branch. Commit prefixes below identify
that local provenance; they are not navigable evidence links. Independent replay
requires the original sanitized fixtures/traces or separately authorized probes.
Do not mark an uncovered case passed from this summary alone.

The source report identifies Codex CLI 0.157.1 on macOS 26.7 arm64, with the
existing ChatGPT login. Its additional state fixture used Python 3.9.6 and SQLite
3.51.0. Earlier observations retain their own source revision; the matrix does
not assert that every probe ran against one identical configuration.

“Observed” below means reported bounded runtime/fixture evidence. “Failed” retains
the original tested requirement. “Unproved” means missing qualifying evidence.
The [28 September contract reset](../adr/1004-standalone-service.md#amendments--28-september-2026)
changes required guarantees, not historical outcomes. The source report's demand
for outside-read denial and its proposed new login were not adopted by the reset.

## Capability coverage

| Boundary | Existing observation and provenance | Limit and remaining qualification |
| --- | --- | --- |
| Login, history, follow-up/resume — R01/A18 | **Observed:** current-user login, real turn, stored `thread/read` and same-thread `thread/resume` (`221f875`); `launchctl asuser` login status and isolated no-login detection (`8c44381`). | Ephemeral turns were not resumable. Historical resume does not prove live reattachment. **Unproved:** expired-login hold, process-restart policy persistence and installed-service startup/restart. S01 covers the selected operator-context protocol; S02/S05 cover installed-service behavior. |
| Trusted caller — A25 | **Observed:** a real `dynamicTools` callback used trusted App Server thread identity to reject spoofed `assignment-B` and accept bound `assignment-A` (`8c44381`). | Experimental API requires pinning. **Unproved:** stale/unbound generation fixture coverage and full product binding/approval invalidation. S01 closes fixture gaps; S04/S05 qualify product authorization. |
| Admission and durable holds — A14/A16 | **Observed:** WAL/FULL SQLite `BEGIN IMMEDIATE` fixture denied eight negative gates and admitted one of two contenders (`c082030`). Consolidated state fixture added storage-abort rollback, initialization/policy holds, paused A while B proceeds across reopen, capacity denial and Stop-before-delivery hold (`e87ed32`). | Fixture transactions establish a proposed coordination seam. **Unproved:** real service initialization, all admission paths/races and automatic resumption; S03/S05 must qualify these. |
| Ambiguous submission — A08/A18 | **Observed:** real turn-start response discarded before binding; SQLite retained thread identity, null turn ID and writer/capacity holds. Stale revision was rejected and two recovery attempts did not resubmit (`c082030`). | **Unproved:** after-binding/other crash timings and missing/multiple-match reconciliation. Map those to bounded S01 cases. Unique live reattachment is unproved; the declared uncertainty/recovery route is acceptable without it. Replacement-conversation event delivery belongs to service integration. |
| Durable result and lost acknowledgement — A09 | **Observed:** state fixture committed one result disposition and caused-operation identity before simulated acknowledgement loss; redelivery reused that operation, one event survived reopen and a stale revision changed zero rows (`e87ed32`). | This is SQLite evidence, not runtime send/inbox proof. **Unproved:** real send acceptance, wake-up timing, concurrent results and service restart; qualify in S04/S05. |
| Crash survival — A08/A15/A16 | **Observed:** real writing turn and escaped child continued effects after App Server death and separately coordinator death; reopened SQLite retained writer/capacity holds and queued follow-up (`c082030`). | Earlier process-group termination probes **failed** physical containment. Crash survival is now an accepted limitation. **Unproved:** integrated survivor detection and admission closure during absence, required in S03/S05. |
| Best-effort Stop — A15 | **Observed:** durable Stop preceded real turn interrupt; a child wrote afterwards. During a three-second observation, no replacement started and holds persisted (`8c44381`). The consolidated fixture retained Stop/holds after a crash before cancellation delivery. | Timeout was observation only. An earlier cleanup acknowledgement/empty terminal list was followed by a child write: **failed** termination evidence. **Unproved:** cancellation of every product assignment and independent positive recovery; unresolved holds remain indefinite. |
| Cooperative normal-success handoff — A16 | **Observed:** identified successful final real turn and ended registered tool; two SQLite contenders admitted exactly one successor, then the old detached child wrote alongside it. Nine negative cases retained holds (`c082030`). | The overlap is the explicitly accepted residual risk, not physical exclusion. **Unproved:** integrated service handoff/negative cases; qualify in S03/S05. |
| Effective access and transcripts — A25/R01 | **Observed:** explicit `workspaceWrite` standalone `command/exec` inside write succeeded, sibling write was denied with attributable process output, sibling read succeeded (`d7c27db`). `approval_policy=never` was verified. The installed command schema had no `readOnlyAccess` field; broad reads were the measured default. | The read result **failed** the former outside-read requirement and now documents broad reads. It does not prove the revised authenticated policy or persisted model-turn history. **Unproved:** selected write/network/approval controls across lifecycle and attributable streamed/stored model-tool evidence; these remain S01 work. |
| Named-profile/configuration limit | **Observed:** configured `s01_probe` returned `allowed:false` (`900e83c`); App Server rejected `--ignore-user-config`, and empty `CODEX_HOME` lacked login (`e71f354`). No named-profile command/model turn ran. | Cause of `allowed:false` remains unknown; legacy full-access configuration did not establish causation. Restricted profiles are optional under the reset. No shared config/login edit, fresh login or credential copy is authorized. |

The consolidated state fixture reported 17 trace records, four synthetic submission
rows, one result event and `PRAGMA integrity_check=ok`. Its source hash was
`e8bddee1ccc2048ba80ccced79300de4549e6b76e23b5a94f292ec98a4e287f1`; trace hash was
`da764af1611d47ab8b2f82399ab5f28e5651a904c1bd978e521bf71dd6ec6328`. These identifiers
preserve provenance, not reproducibility without the local files.

## Published corroboration and disposition

The contemporaneous GitHub comments preserve the reported
[Stop hold result](https://github.com/chrisbanes/ensemble/issues/688#issuecomment-5868240394),
[cooperative handoff and transcript gap](https://github.com/chrisbanes/ensemble/issues/688#issuecomment-5868631558),
[attributable outside-read failure](https://github.com/chrisbanes/ensemble/issues/688#issuecomment-5868746412)
and [profile finding with unknown cause](https://github.com/chrisbanes/ensemble/issues/688#issuecomment-5869575953).
Their older requirements are superseded by the
[approved reset](https://github.com/chrisbanes/ensemble/issues/688#issuecomment-5871919157);
the observations remain historical evidence.

Use the [required S01 probes](../delivery.md#s01--bounded-codexmacos-proof) for current
scope. Record uncovered cases explicitly before claiming qualification. This matrix
makes prior coverage inspectable; it does not release S01, dependent work or any
uncertain ownership hold.
