# S01 minimum-contract qualification — 28 September 2026

Historical source report from the earlier evidence branch. Its proposal to
require exhaustive model-tool observations or another runtime was superseded by
the approved [runtime trust boundary](../design/standalone.md#runtime-trust-boundary).
The failed termination and unexplained file-effect observations below remain
unchanged findings. Published trace copies have path placeholders and updated
SHA-256 values; private originals were retained outside the publication branch.
The current seven-row disposition is in the
[fix-first coverage report](s01-acceptance-candidate-2026-09-28.md).

## Reconciliation checkpoint before new probes

The local evidence branch `cb/35-s01-proof` was clean at
`e87ed326182b602c412606d1e88d6ae481188eb2`. The merged `main` source and
minimum-contract baseline was `f0eaabdb30d34aad745771592f175d097ec9678a`
(#699/#700), descended independently from runtime base
`8e3ab9387389f5040631cd06e2156186aaffbc6c`. Merge commit
`ad2d0476adf0eb8530c3d192ec329e43adeeab09` has both parents. Its five
conflicting contract files (`docs/SPEC.md`, `docs/acceptance.md`,
`docs/adr/1004-standalone-service.md`, `docs/delivery.md`, and
`docs/design/standalone.md`) take the reviewed `main` version; the old revision
3–5 contract survives in the first-parent history, not as current acceptance.
All 33 original S01 evidence files and 22 `test/s01` fixture files survived the
merge; the published `docs/evidence/s01-existing-evidence-2026-09-28.md` was
added alongside them. No new probe was run before this checkpoint.

The published existing-evidence summary is a secondary index. The local raw
traces, fixtures, and contemporaneous reports remain primary for bounded
observations. The old outside-read denial and named-profile/new-login gates are
superseded, not passed. S01 remains unpassed pending the minimum-contract gaps in
`docs/delivery.md`; service implementation evidence belongs to S02–S05.

## New qualification and decision

**Decision: S01 remains unpassed.** The tested source/evidence head before new
probes was `7cbb437c85758c97587338894f1360ca8eccd3e0`; the probe scripts and
traces are preserved at `3092fcc1ce29a1687ae0cb07324a895f18d1e07d`.
The selected standalone command policy worked in a bounded fixture, but the
first real turn produced no `commandExecution` item in either streamed events
or persisted `thread/read` history. Its file effects could not be attributed
to a captured command execution. A later, separately commissioned single
native-history follow-up below passed under the same selected policy. It does
not explain the first turn's missing item or prove model-tool policy
enforcement. No product service or downstream work ran.

### Reproducible commands and budget

Ran in the clean `ensemble` checkout, using only fresh disposable directories
beside it; the paths below are local fixture handles, not deliverables. Before
model calls, the budget was **at most two bounded real turns, zero reruns**.
One turn ran. Two protocol preflights failed before a model call because
`runtimeWorkspaceRoots` and then `environments` required the experimental API;
their traces are preserved. The final script removed those fields. The second
turn was withheld when the first lacked attributable command evidence.

```text
multica repo checkout https://github.com/chrisbanes/ensemble.git --ref cb/35-s01-proof
git merge --no-commit --no-ff f0eaabdb30d34aad745771592f175d097ec9678a
git commit -m 'Reconcile S01 evidence branch with merged minimum contract'
python3 -m py_compile test/s01/minimum_policy_probe.py test/s01/minimum_turn_probe.py test/s01/minimum_recovery_fixture.py test/s01/minimum_restart_read.py
python3 test/s01/minimum_policy_probe.py ../.s01-minimum-policy-20260928-a
python3 test/s01/minimum_policy_probe.py ../.s01-minimum-policy-20260928-b
python3 test/s01/minimum_turn_probe.py ../.s01-minimum-turn-20260928-a
python3 test/s01/minimum_turn_probe.py ../.s01-minimum-turn-20260928-b
python3 test/s01/minimum_turn_probe.py ../.s01-minimum-turn-20260928-c
python3 test/s01/minimum_recovery_fixture.py ../.s01-minimum-recovery-20260928-a
python3 test/s01/minimum_restart_read.py ../.s01-minimum-turn-20260928-c 01a0e8ac-9d45-73b1-942c-fa1ff6f7402e
codex --version
codex login status
node --version
npm --version
sqlite3 --version
python3 --version
```

Installed `/opt/homebrew/bin/codex` was `codex-cli 0.157.1`; login status
reported ChatGPT without exposing credentials. macOS was 26.7 arm64. Python
was 3.9.6, SQLite 3.51.0, Node 24.19.0 and npm 11.17.0; the latter two do
not match the repository pins 24.21.0/12.1.0. No TypeScript product code
changed, so `npm ci`/`npm run check` were not run. The installed generated App
Server schema already in `../.s01-r5-access-schema` was inspected before the
turn: `command/exec.sandboxPolicy` accepts `workspaceWrite` with writable roots,
`networkAccess`, `excludeSlashTmp` and `excludeTmpdirEnvVar`; thread start/resume
accept `sandbox`/`approvalPolicy`, and `turn/start` accepts `sandboxPolicy` and
`approvalPolicy`. A direct command is not a persisted model-turn item.

### New bounded observations

| Boundary | Status and exact evidence | Limit |
| --- | --- | --- |
| Selected command write and temporary roots — A25 | **Passed with limits:** final [command trace](s01-minimum-policy-trace-2026-09-28.jsonl) at Unix 1790610139.041–.200 selected `approval_policy=never`, `sandbox_mode=workspace-write` via per-process `-c` overrides, then applied explicit `workspaceWrite` with only the fixture work root writable, `networkAccess:false`, `excludeSlashTmp:true`, `excludeTmpdirEnvVar:true` on each `command/exec`. Inside write exited 0. Sibling, symlink, synthetic `TMPDIR` and `/tmp` writes exited 1 with “Operation not permitted”; no outside target existed. | This is standalone `command/exec`, not a model-tool or installed-service test. A synthetic sibling stands in for a protected/home-like path; no real protected or private data was touched. |
| Command network — A25 | **Passed with limits:** host socket control reached the probe listener once at 1790610139.059. A sandboxed `/usr/bin/curl` to that same loopback port exited 7 at .200; the listener recorded no second connection. | Local loopback denial under this selected command policy; other network paths and model-tool execution remain unproved. |
| Broad reads and environment — A25 | **Observed limit:** the same selected command read a synthetic outside marker and exited 0. The `command/exec.env` schema says overrides merge into the server-computed environment. | Broad reads are accepted by the minimum contract but expose host-readable files; inherited environment and ambient installed tools are not isolated by this proof. Do not claim a sandbox against all host data or processes. |
| Real turn stream/persistence — R01/A25 | **Failed candidate / gate unproved:** [turn trace](s01-minimum-turn-trace-2026-09-28.jsonl) shows ChatGPT account, selected `never`/`workspace-write`, persistent thread `01a0e8ac-9d45-73b1-942c-fa1ff6f7402e` and explicit `workspaceWrite` on `turn/start`. The turn completed at Unix 1790610031.330; `inside` contained `REAL_INSIDE` and the sibling attempt did not exist. Streamed items were user, reasoning and agent messages, with no `commandExecution`; stored `thread/read` also had zero command items. | The effects and agent's narrative are not an attributable recorded command. No effective model-tool write/network/approval conclusion or complete persisted command transcript follows. The tool may have executed outside the exposed item surface; this was not established. |
| Operator-context restart/history — R01/A18 | **Passed with limits:** after exact-PID App Server death, [restart trace](s01-minimum-restart-trace-2026-09-28.jsonl) launched a fresh App Server with the same per-process overrides. `account/read` again returned `chatgpt`; `config/read` selected `never`/`workspace-write`; explicit `thread/resume` found the same persistent thread and `thread/read` found its one completed turn. | No post-restart model turn was run, so execution-policy persistence on follow-up is unproved. Earlier [no-login fixture](s01-revision4-2026-09-28.md) detected a missing login; expired-login behavior and installed-service startup belong to later qualification. |
| Trusted stale/unbound identity — A25 | **Fixture pass:** [SQLite trace](s01-minimum-recovery-trace-2026-09-28.jsonl) accepted only trusted thread `thread-A`, generation 2, assignment A; rejected payload B, old generation 1, unbound thread and invalidated binding. This extends the earlier real dynamic-tool spoof result in [revision 4](s01-revision4-2026-09-28.md). | The stale/unbound cases are deterministic policy fixtures, not fresh real callbacks or product authorization. The dynamic-tool API remains experimental. |
| Ambiguous submission/binding — A08/A18 | **Fixture pass:** the same SQLite trace retains one durable operation/dispatch and writer/capacity holds across missing and multiple live matches before binding, missing/conflicting matches after binding, and stale revision. A unique trusted live match binds the same turn ID in the fixture without releasing the holds. `PRAGMA integrity_check=ok`. Earlier [real lost-response probe](s01-revision5-2026-09-28.md) discarded a turn-start response before binding and kept uncertainty. | The fixture receives synthetic live-match facts; installed App Server unique live reattachment remains unproved and is not a universal minimum gate. Without trusted positive identity, operator recovery keeps the hold. No resubmission was attempted. |

The first direct policy trace lacked a host connectivity control; it remains
[preserved](s01-minimum-policy-initial-trace-2026-09-28.jsonl) and is superseded
by the controlled result above. The two pre-model protocol errors are preserved
as [preflight A](s01-minimum-turn-preflight-a-2026-09-28.jsonl) and
[preflight B](s01-minimum-turn-preflight-b-2026-09-28.jsonl). No model call ran
in either preflight. The single real turn used 10.30 seconds from first server
start to stop; the post-restart read took 0.91 seconds. The command probe took
0.43 seconds. The SQLite recovery fixture took 0.04 seconds.

### Integrated minimum-contract matrix

| `docs/delivery.md` row / acceptance | Current S01 status | Service-owned remainder |
| --- | --- | --- |
| Authenticated lifecycle — R01/A18 | **Passed with limits:** existing login, native command result in live and stored history after a later restart (follow-up below), prior stored resume and unavailable-login detection. **Unproved:** post-restart execution-policy effectiveness and expired-login response. | S02/S05 installed-service launch, login hold and UI-visible recovery. |
| Trusted caller — A25 | **Passed with limits:** prior real spoofed payload denial; new stale/unbound/invalidation fixture. | S04/S05 full generation, action-policy and approval binding. |
| Admission/durable state — A14/A16 | **Passed with limits:** prior real SQLite WAL/FULL serialization, startup/storage/policy failure, pause versus independent project, Stop/service-absence/capacity holds and single successor fixtures, all at the recorded earlier revisions. No new probe repeated these. | S03/S05 every product admission path and automatic resumption. |
| Ambiguous submission/result — A08/A09/A18 | **Passed with limits:** prior real lost response before binding, prior result/acknowledgement fixture; new before/after-binding ambiguity, stale callback and no duplicate dispatch fixture. **Unproved:** App Server live-match query, real send acceptance/wakeup and product recovery. | S03–S05 product binding, inbox and recovery. |
| Survival/Stop — A15 | **Passed with limits:** prior real writer survived App Server death and interrupt; durable Stop/writer/capacity holds denied replacement. Stronger descendant termination **failed** historically. | S03/S05 live supervisor and operator hold resolution. |
| Cooperative handoff — A16/A18 | **Fixture pass, feasibility held:** prior successful final turn/end of registered tools admitted exactly one successor in SQLite; detached-child overlap remains an accepted risk. The installed-interface reconciliation below cannot establish complete expected observations for general model execution, so positive release is not qualified. | S03/S05 integrated handoff and negative cases only after the S01 method boundary is resolved. |
| Effective policy/observations — A25/R01 | **Passed with limits** for direct `command/exec` selected write/local network/temp paths, native command history, and two later model-originated shell turns under explicit `workspaceWrite`/`never`: inside writes succeeded; synthetic sibling, symlink, temp, `/tmp` and loopback effects were denied before and after App Server restart (follow-up below). **Unproved:** complete enforcement across alternate tool/client surfaces and broader approval flows. Broad reads and inherited environment remain disclosed limits. | S02/S04/S05 must allowlist client methods, bind dynamic tools and approvals, and test installed-service policy and UI evidence. |

The independent probes do not implement an Ensemble scheduler, supervisor,
inbox, policy service, UI or runtime queue. A fixture pass never becomes an
installed-service pass. Stop/crash/unknown writer holds cannot be timer-unlocked.
The documented [operator recovery route](../design/standalone.md#operator-recovery-of-uncertain-execution)
requires independent ownership resolution; it was not executed here.

**Next decision for Churchill/Chris:** native command history and the selected
model shell policy now have bounded positive evidence. No replacement journal or
policy weakening is justified by these probes. Decide how the product will
exclude or separately control alternate client/tool execution surfaces, then
qualify complete observations and installed-service enforcement in S02–S05.
Keep S01 and CB-36–CB-45 held until remaining S01 coverage is accepted. No new login,
credential/config change, TypeSafe call, Haze access, reboot, deployment or
GitHub mutation occurred.

### Cleanup and integrity

Only probe App Server groups were killed, by exact group leaders, after each
bounded call: PIDs 75801/77200 for command probes, 75901/75934 for preflights,
75990 for the real turn and 77972 for restart read; all returned exit -9. The
read-only inspection servers were also started and stopped in the foreground.
Exact-PID checks found no survivors. The loopback listener was closed. No
outside write target or `/tmp` target remained. Local disposable fixture
directories, including the inside marker and SQLite database, remain for
auditing; the sanitized traces and sources are committed. No existing session
or Haze process was touched.

## Native-history follow-up — one additional real turn

Churchill commissioned one changed observation test after Merlin identified a
prior native `commandExecution` item in
`s01-r5-access-trace-final-2026-09-28.jsonl`. The checkout was clean at
`50c8fea4575012cf5ecc51effbd8e7587bfe4e7e`; it still contained merged
baseline `f0eaabdb30d34aad745771592f175d097ec9678a`. The tested new
source and sanitized 130-row [trace](s01-native-history-trace-2026-09-28.jsonl)
are committed together at `b085bc992bbaf4cc47a4cf79c9aa38d36f595f8a`.
Source SHA-256 was
`86244c89074748938d5eb2dbfecc361e05b916dbfb75f1b4c32d2a71cc4e4506`;
trace SHA-256 was
`95063e6a12d339cb521b59a324c36e201d77f6e60bf973864cb84983745739da`.
The old no-item trace remains unchanged and unexplained. Budget was **one real
turn, zero automatic retries**; exactly one ran, followed only by no-model
`thread/read` and `thread/resume` calls.

```text
python3 -m py_compile test/s01/native_history_probe.py
codex --version
codex login status
python3 test/s01/native_history_probe.py ../.s01-native-history-20260928-a
```

The installed CLI remained `/opt/homebrew/bin/codex`, version 0.157.1, with
the existing ChatGPT login, on macOS 26.7 arm64. The selected model reported
`gpt-6-sol`. The isolated App Server used only per-process
`-c approval_policy=never -c sandbox_mode=workspace-write` overrides; the
persistent thread used `sandbox:"workspace-write"`/`approvalPolicy:"never"`,
and `turn/start` explicitly selected `workspaceWrite`, the fixture work root,
`networkAccess:false`, `excludeSlashTmp:true`, `excludeTmpdirEnvVar:true` and
`approvalPolicy:"never"`. No operator global config or login changed.

The model chose the foreground shell command
`/bin/zsh -lc "printf 'S01_NATIVE_4F3E093CA0FB4970' | tee native-marker.txt"`
in the disposable work directory. At Unix 1790611063.5053, streamed
`item/started` identified thread `01a0e8bc-653d-7153-a156-1ecfafc3060a`,
turn `01a0e8bc-65ed-7712-99ce-fd5c959ba4ad`, and item
`exec-06c03b04-f413-40a0-abf1-410d98090c12` with that command/cwd.
Streamed `item/completed` at .5057 reported exit 0 and aggregated output
`S01_NATIVE_4F3E093CA0FB4970`; the file contained the same marker.
`turn/completed` at 1790611066.0134 reported `completed`. `thread/read` at
.0193 contained the same item ID, command, cwd, output and exit. The probe's
separate `turn_completed_status` convenience field was null due to reading
the notification at the wrong nesting level; the sanitized `turn/completed`
envelope retained the actual `completed` status. App Server PID/PGID 83029
then exited -9; a new isolated App Server PID/PGID 83316
selected the same login and config, resumed that exact thread and read the
same persisted item at 1790611066.8820. PID 83316 exited -9. The probe's
correlation check and an independent trace validator passed; exact-PID checks
found neither server alive. The fixture marker and local trace remain for audit.

The recorder retained every notification method with sanitized envelope IDs,
thread/turn/item IDs, parameter keys, lifecycle and selected command fields.
It included startup/status, hook, warning, deprecation and token-usage methods
that the earlier probe discarded. It redacted non-marker message deltas and
never wrote full config, credentials or agent reasoning. Native history is
therefore **passed with limits for this one model-originated command and
restart**. This did not attempt an outside write, network request or approval,
so it proves no model-tool policy enforcement. It does not establish that every
model action uses a native command item or that missing observations can be
treated as completed registered tools. The previous file effect without an
item remains an unproved case, not a generalized protocol defect.

## Selected model-tool policy follow-up — two-turn maximum

Churchill accepted the narrow native-history result and commissioned this
separate policy probe. The dedicated checkout was clean at
`66998a8e1fcc41f70d8054de0048bdf3b63bfb52` before editing; merged source
baseline was `f0eaabdb30d34aad745771592f175d097ec9678a`, runtime base
`8e3ab9387389f5040631cd06e2156186aaffbc6c`. Probe source and the
sanitized 227-row [trace](s01-model-policy-trace-2026-09-28.jsonl) were
committed together at `89f6f8408fbe2bb4a02cb755378d7b24ff9914de`.
Their SHA-256 values were respectively
`37c6462a3787e391ed3aef479daec91d67e519be305bafcb1a2eafd79128aefb`
and `bf5e115d06d367004a778d6230b0d57bf76ea7bbb08fdbd25685418d44f73265`.
All earlier traces and matrix rows remain preserved.

The installed 0.157.1 schema and selected config were inspected before calls;
the fixture shell template passed `/bin/sh -n`. Budget was **at most two real
turns, zero automatic reruns**. Both turns ran because the first met the
predeclared inside, denial, attribution and stored-history criteria. Exact
operator commands were:

```text
python3 -m py_compile test/s01/model_policy_probe.py
codex --version
codex login status
python3 test/s01/model_policy_probe.py ../.s01-model-policy-20260928-a
```

The no-model shell-template check extracted the literal `script` assignment
from `test/s01/model_policy_probe.py` with Python `ast.literal_eval`, replaced
its five fixture placeholders with synthetic values, and passed that text to
`/bin/sh -n`; it did not execute the script or make a model call. The exact
fixture and actual case commands are preserved in the committed source.

The script created fresh `work`, sibling `outside`, synthetic `temp`, and a
symlink from `work/escape` to `outside`, all under its disposable fixture root.
It also targeted its own unique `/tmp` name. A host-owned listener on
`127.0.0.1:58269` accepted one positive host control before the turn. The
fixture script's SHA-256 was recorded and remained unchanged after both
turns. No outside target or `/tmp` target existed after either turn, and the
listener accepted no model-tool connection. Fixture inside markers and the
SQLite-independent trace remain locally for audit; the listener was closed.

Both isolated App Servers used the existing ChatGPT login and only per-process
`-c approval_policy=never -c sandbox_mode=workspace-write` overrides.
`config/read` selected exactly `never`/`workspace-write` before each turn;
`thread/start` and `thread/resume` selected the same policy. Each `turn/start`
explicitly supplied `workspaceWrite`, only the fixture work root writable,
`networkAccess:false`, `excludeSlashTmp:true`, `excludeTmpdirEnvVar:true`,
`cwd=work` and `approvalPolicy:"never"`. No credential contents or full config
were captured. The model reported `gpt-6-sol` in thread
`01a0e8c6-3393-7633-8a6b-068f8de08c45`.

| Turn | Native model-tool observation and independent effects |
| --- | --- |
| First | Turn `01a0e8c6-3459-7a93-b6e0-5f09a59108c8` emitted a completed `commandExecution` item `exec-8b02cf7d-feb9-4a77-89cb-a8d3241b9697` for `/bin/zsh -lc 'sh ./policy_case.sh first'` at Unix 1790611708.695. Its output recorded inside 0, sibling/symlink/temp/`/tmp` each 1 (“Operation not permitted”), and `curl` 7. The inside marker existed; all forbidden targets and extra listener connections were absent. `thread/read` stored the same command, cwd, output, exit 0 and item ID. |
| After restart | App Server PID/PGID 85769 exited -9. Fresh isolated PID/PGID 86060 selected the same login/config; `thread/resume` and `thread/read` preserved the first item. Second turn `01a0e8c6-7125-7e21-9ba2-73861da23aef` emitted item `exec-35b55db6-acec-4828-b544-7d55acc85e87` for `/bin/zsh -lc 'sh ./policy_case.sh second'` at Unix 1790611721.175 with the same case codes 0/1/1/1/1/7 and independent denied effects. Stored history contained both turns and their matching items. PID 86060 exited -9; exact-PID checks found no probe App Server alive. |

The trace retains every notification method, including unknown/status/hook
methods, with sanitized thread/turn/item identity, command, cwd, lifecycle,
output and exit. It retains no full config, credentials or agent reasoning.
An independent validator matched both live command items to stored history,
their output and fixture effects, and verified the second turn occurred only
after restart. The record shows no approval request, but that absence alone is
not used as proof: the effective `never` selection and actual denied effects
under the selected policy are the bounded evidence. No escalation or other
approval path was exercised.

**Disposition:** model-originated foreground shell write and local-network
controls **passed with limits** for two turns in one disposable conversation,
including an App Server restart. This is still a selected path, not a blanket
App Server or host sandbox guarantee. The native item identifies the invocation
of the unchanged fixture script; its inner shell operations are correlated by
the recorded script hash, per-case output and independent effects, not separate
native items. Outside reads were permitted in earlier
tests; inherited environment and ambient tools remain exposure limits. The
installed client schema separately exposes `command/exec` (standalone),
experimental dynamic-tool callbacks and `thread/shellCommand`, whose request
description says it runs unsandboxed with full access instead of inheriting the
thread sandbox. None was used as the model's command in this probe. File-change
and alternate tool paths also remain unqualified. The S01 integration contract
must constrain those surfaces or hold missing observations; S02–S05 must test
the implemented service's method allowlist, dynamic-tool authorization and
approval handling. No ineffective required control was observed on the tested
shell path, so this probe asks for no policy weakening or replacement-journal
amendment. S01 and CB-36–CB-45 remain held pending the remaining coverage and
integration decision.

## Read-only supported-interface reconciliation

At clean starting head `b3ea8475435e899b1a97569442ad2338475b91ce`, a
zero-model-call read of the installed `codex-cli 0.157.1` generated App Server
schemas and preserved traces found the following boundary. The installed
binary was `/opt/homebrew/bin/codex`, SHA-256
`27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d`.
The inspected schema digests were `ClientRequest.json`
`0f8733c93b3609fa82337ae94f8a4971b93e3327b0b3e99dce2a86cf495d925b`,
`ServerNotification.json`
`871046f308da617d6cbfb372ff0260a778d8b959ae7eca8757a2edcb4c5f3900`,
and `ServerRequest.json`
`3d7bc481f84dc042984a74420e65c5a8d3c423f37a91b7d5df2365c903a12ac6`.
These are installed-interface observations, not claims about every possible
internal model action.

Read-only commands: `git status --short --branch`, `git rev-parse HEAD`,
`git merge-base HEAD f0eaabdb30d34aad745771592f175d097ec9678a`,
`codex --version`, `shasum -a 256 /opt/homebrew/bin/codex
../.s01-r5-access-schema/{ClientRequest,ServerNotification,ServerRequest}.json`,
`rg` over the generated schemas, contract and evidence documents, and
`python3` JSON reads of schema definitions. No App Server, command probe,
model turn or new fixture was started; cleanup was unnecessary. Existing
traces were read without alteration.

| Surface | S01 need and selectable boundary | Policy and attributable observation |
| --- | --- | --- |
| Model `commandExecution` item | Needed for the selected shell path. A client RPC allowlist does **not** select which built-in tool the model uses. Inspected `thread/start`, `turn/start` and `thread/resume` parameters expose no model-tool choice or allowlist. | Explicit `workspaceWrite`/`never` was selected on the tested turns. [Two-turn trace](s01-model-policy-trace-2026-09-28.jsonl) has live `item/started`, output and `item/completed`, command/cwd/exit and matching stored items before and after restart; write and loopback effects were independently checked. This passes only that path. |
| Standalone client `command/exec` | Not required for a model turn; Ensemble can omit this RPC or apply its own allowlist. | Its request accepts a separate `sandboxPolicy`; [direct trace](s01-minimum-policy-trace-2026-09-28.jsonl) qualifies selected write/network behavior but creates no thread/turn item or persisted model history. If used for product work, it needs its own durable registration and terminal result. |
| Client `thread/shellCommand` | Not required; Ensemble can omit the RPC. The installed request explicitly says it runs unsandboxed with full access rather than inheriting the thread policy. | No `sandboxPolicy`/approval field is present in its request. No S01 probe qualifies its effects or durable model-turn history. It cannot be an allowed task execution route under the selected contract. |
| Model `fileChange` item | Potentially necessary for coding work; it cannot be excluded merely by withholding a client RPC. No built-in-tool exclusion was found in the inspected start/turn/resume schemas. | Thread-item schema supplies ID, changes and `inProgress`/`completed`/`failed`/`declined` status; `item/started`, `item/completed`, output/patch notifications and an approval request type exist. Turn-level `sandboxPolicy`/`approvalPolicy` are selectable, but their effectiveness and complete persisted file-change observations were **not tested**. |
| `dynamicTools` callback | Coordination may need it; Ensemble can omit registration at `thread/start` or register only its own tool and enforce callback policy. | The server request carries trusted thread/turn/call IDs outside untrusted arguments. [Revision 4 trace](s01-r4-identity-trace-2026-09-28.jsonl) rejected spoofed payload identity; a `dynamicToolCall` item has ID/status/content fields. Stale/unbound checks are SQLite fixtures; execution effects and full terminal/history coverage remain a product obligation. The callback's actions do not inherit the command sandbox. |
| MCP/app, web and other model items | Not required by the minimum foreground-shell proof, but the installed `ThreadItem` union exposes `mcpToolCall`, `webSearch`, subagent/collaboration, image and other item types. The inspected start/turn/resume fields do not give a general model-tool allowlist; `disabledPluginIds` is only a turn field, not proof that all alternate methods are excluded. | Command `networkAccess:false` does not govern these integrations. Item lifecycle fields exist for some types, but policy, effect attribution and complete terminal/history coverage were not qualified here. An observed unknown type/method must hold; an unobserved effect cannot be certified from a successful turn alone. |

**Conservative observation rule:** A positive final `turn/completed` with status
`completed` is necessary but insufficient. Cooperatively release only when the
thread/turn identity matches the durable assignment, each registered tool and
each observed execution item in the supported method set has a correlated
terminal event/result, persisted `thread/read` agrees with live item IDs and
statuses, and no known survivor or unexplained effect remains. Any unknown
execution method, unmatched item, missing terminal observation, failed or
interrupted turn, Stop/crash, or known survivor retains the Stop/writer/capacity
holds until independently resolved. A bounded observation interval never
releases a hold. This rule is compatible with the approved cooperative handoff
and its accepted detached-child overlap risk; it cannot establish physical
writer exclusion.

**Feasibility decision:** The installed schema can describe and correlate
observed native command/file-change/tool items, but the inspected client
surface does not establish a model-tool boundary limited to the qualified
command path. Moreover, the preserved [no-item turn](s01-minimum-turn-trace-2026-09-28.jsonl)
changed an inside file while live and stored history had no command item; its
cause remains unknown. Therefore neither `turn/completed` nor a client RPC
allowlist proves the expected method set complete. S01 cannot freeze a positive
normal-handoff claim for general coding turns on this evidence. The concrete
runtime choice for Chris is to select a supported Codex interface/version that
can constrain the model to separately qualified execution methods and expose
complete lifecycle/history for them, or explicitly revise the handoff contract
to accept this observation gap and its possible overlapping writers. The latter
would change the approved safety contract and needs a decision before dependent
work. No policy waiver, replacement journal or new model call is proposed by
this read-only finding. S02–S05 remain responsible for implementing and testing
the actual method allowlist, callback authorization, holds and operator recovery;
their future tests cannot retroactively pass this S01 feasibility gate.
