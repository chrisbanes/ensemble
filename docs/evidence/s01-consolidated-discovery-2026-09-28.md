## S01 consolidated capability and decision report

**Disposition:** S01 is unpassed; dependent work stays held. This report
continues clean `cb/35-s01-proof` head
`e71f3546ef92ef2d2c83e807279b8de6b5ced525`. The five-document revision
5 contract is `56976c0cea82d4dadfac73ab60979e0cfed69c30`; underlying
runtime source base is `8e3ab9387389f5040631cd06e2156186aaffbc6c`.
Approved crash survival, best-effort Stop and cooperative successful handoff
are settled; no read waiver or operational product acceptance is inferred.

### Status key and capability matrix

**Passed with limits** means the stated fixture or direct protocol behavior
was observed, not that a standalone Ensemble service implements it.
**Failed** means the tested candidate did not meet the required boundary.
**Unproved** means no qualifying evidence exists. **Blocked** names a specific
dependency or permission preventing the next safe probe. The rows cover every
`docs/delivery.md` S01 probe and R01/A08/A09/A14–A16/A18/A25.

| Capability / acceptance | Status and exact evidence | Remaining gate / consequence |
| --- | --- | --- |
| Login and conversation lifecycle — R01, A18 | **Passed with limits:** current UID's `codex-cli 0.157.1` ChatGPT login, real turn, stored `thread/read` and same-thread `thread/resume` at [`221f875`](s01-2026-09-27.md); `launchctl asuser` login status and isolated no-login detection at [`8c44381`](s01-revision4-2026-09-28.md). Ephemeral turns were not resumable. | **Unproved:** service-user startup/restart, expired-login hold and restart-policy persistence. **Blocked:** restricted profile plus authenticated isolated home. No API billing fallback. |
| Coordination tool caller identity — A25 | **Passed with limits:** real `dynamicTools` callback used trusted App Server thread ID to reject spoofed `assignment-B` and accept bound `assignment-A` at [`8c44381`](s01-revision4-2026-09-28.md), [`trace`](s01-r4-identity-trace-2026-09-28.jsonl). | **Unproved:** product binding to admitted generation, stale callback and approval invalidation end to end. Experimental dynamic tool protocol must be pinned. |
| Effective admission, startup/storage/policy failure, service absence, pause/Stop races and capacity — A14/A16 | **Passed with limits:** WAL/FULL SQLite `BEGIN IMMEDIATE` fixture at [`c082030`](s01-revision5-2026-09-28.md) denied eight negative gates and admitted one of two contenders. New [`state trace`](s01-discovery-state-trace-2026-09-28.jsonl) adds rollback on an injected storage abort, initialization/policy hold, paused A while B proceeds across reopen, capacity denial and Stop-before-delivery hold. | **Unproved:** real service startup, policy loading, all assignment admission paths and automatic resumption. Fixture transactions are a proposed seam, not an implemented scheduler. |
| Lost submission/binding response and recovery — A08/A18 | **Passed with limits:** real turn-start response discarded before binding; SQLite retained thread, null turn ID, writer/capacity holds and stale-revision rejection; two recovery attempts did not resubmit at [`c082030`](s01-revision5-2026-09-28.md), [`trace`](s01-r5-lost-response-trace-2026-09-28.jsonl). | **Unproved:** unique live reattachment, after-binding and other crash timings, missing/multiple-match reconciliation, replacement-conversation pending events. Model-dependent positive cases wait for restricted profile/auth; fallback remains indefinite hold. |
| Durable result/inbox and lost acknowledgement — A09 | **Passed with limits:** new SQLite fixture committed one result disposition and caused-operation identity before simulated lost acknowledgement; redelivery reused the original operation, one event survived reopen, stale revision changed zero rows; [`trace`](s01-discovery-state-trace-2026-09-28.jsonl). | **Unproved:** actual send acceptance, wake-up timing, several concurrent results and product inbox/service restart. The fixture is not an App Server or service proof. |
| Crash-survivor recovery — A08/A15/A16 | **Passed with limits:** real writing turn and escaped child continued effects after App Server and separately coordinator death; SQLite reopened with writer/capacity holds and queued follow-up at [`c082030`](s01-revision5-2026-09-28.md), [`lost-response`](s01-r5-lost-response-trace-2026-09-28.jsonl) and [`coordinator`](s01-r5-coordinator-trace-2026-09-28.jsonl) traces. | **Unproved:** product supervisor detection and all future admissions closed during absence. Old process-group termination failures remain evidence against physical exclusion, not against approved crash-survival holds. |
| Explicit best-effort Stop — A15 | **Passed with limits:** real turn interrupt after durable Stop; late child effect, three-second observation and no replacement, with holds retained at [`8c44381`](s01-revision4-2026-09-28.md), [`trace`](s01-r4-hold-trace-2026-09-28.jsonl). New SQLite fixture preserves Stop/holds across crash before cancellation delivery. | **Unproved:** product cancellation request for every active task assignment and independent positive termination verification. Unresolved Stop remains held indefinitely; acknowledgement or timeout never unlocks it. |
| Cooperative success and uncertain release — A16 | **Passed with limits:** positively identified successful final real turn with ended registered tool; two SQLite contenders admitted one successor; independent oracle then demonstrated accepted detached-child overlap at [`c082030`](s01-revision5-2026-09-28.md), [`handoff`](s01-r5-handoff-trace-2026-09-28.jsonl) and [`oracle`](s01-r5-handoff-oracle-2026-09-28.jsonl). Nine negative states retained holds. | **Unproved:** integrated service behavior. This is cooperative serialization with the explicitly accepted physical overlap, not exclusive filesystem writing. |
| Access, broader approval, network, streamed/persisted transcripts — A25/R01 | **Failed:** legacy `workspaceWrite` denied sibling write but allowed sibling read in attributable `command/exec` at [`d7c27db`](s01-revision5-command-access-2026-09-28.md). **Blocked:** probe-local `s01_probe` was configured but `allowed:false` at [`900e83c`](s01-named-profile-2026-09-28.md); App Server lacked an ignore-user-config flag and empty `CODEX_HOME` lacked login at [`e71f354`](s01-profile-launch-2026-09-28.md). | **Unproved:** named-profile inside/sibling/home-like/symlink denial; approval escalation/stale denial; effective network boundary; model-tool streamed and persisted denial; restricted-profile resume/restart. Outside-read denial remains required. |

### New independent check and installed surface

No model calls or profile reruns were made in this pass. One fresh disposable
SQLite fixture was predeclared and run once from the clean checkout:

```text
python3 -m py_compile test/s01/discovery_state_probe.py
python3 test/s01/discovery_state_probe.py ../.s01-discovery-state-2026-09-28
python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'
node --version
npm --version
codex --version
codex login status
```

The Python command exited 0. The 17-record
[`trace`](s01-discovery-state-trace-2026-09-28.jsonl) spans Unix
1790597554.64–1790597554.69, records the injected rollback and reopen
effects, and ends with `PRAGMA integrity_check=ok`, four synthetic submission
rows and one result event. The fixture made no Codex call or filesystem write
outside its disposable SQLite directory. Its source SHA-256 is
`e8bddee1ccc2048ba80ccced79300de4549e6b76e23b5a94f292ec98a4e287f1`;
the trace SHA-256 is
`da764af1611d47ab8b2f82399ab5f28e5651a904c1bd978e521bf71dd6ec6328`.
The fixture directory/database remain local for inspection; the script closed
all connections and left no process running.

The installed generated App Server schema was inspected without a model call.
It exposes mutually exclusive `permissions` versus `sandbox` on
`thread/start`/`thread/resume`, `permissions` versus `sandboxPolicy` on
`turn/start`, and `permissionProfile` versus `sandboxPolicy` on `command/exec`.
`ThreadStartResponse` and `ThreadResumeResponse` expose
`activePermissionProfile`; `permissionProfile/list` reports `allowed`.
`item/commandExecution/outputDelta`, approval requests, `thread/read` and
`thread/resume` exist in the installed schema. Their presence is not proof of
effective enforcement or event delivery in the blocked profile. This beta
profile and experimental App Server/dynamic-tools surface must be version-pinned
for an integration contract. The present CLI is `codex-cli 0.157.1` on macOS
26.7 arm64, with ChatGPT login status available; Python 3.9.6 and SQLite
3.51.0 ran the fixture. Installed Node 24.19.0/npm 11.17.0 do not match the
repo's `.node-version` 24.21.0 and npm 12.1.0 pins; `npm ci` and `npm run check` were not run because no
product TypeScript implementation changed and the pinned toolchain was not
available. They remain required before an integrated candidate is accepted.

### Coupled blockers and decision

1. **Immediate access/configuration boundary.** A named restricted profile has
   not been shown `allowed:true`; the precise reason for `allowed:false` is
   unknown. The current home has an inherited legacy `sandbox_mode` and a
   file-based ChatGPT login. The installed App Server rejects
   `--ignore-user-config`; a fresh home is unauthenticated. The failed legacy
   read result cannot be generalized to every named profile, but S01 cannot
   pass without an effective outside-read denial. This blocks safe model
   access, approval/network and persisted-transcript probes under the intended
   policy, plus service-user/restart qualification.
2. **Recovery and transcript consequences.** The accepted indefinite-hold
   fallback is established in fixtures; positive unique live reattachment,
   after-binding loss, restricted-profile real-turn history and restart remain
   unproved. A fixture or standalone `command/exec` result cannot fill those
   real-runtime gaps. If the profile needs broad reads or remains disallowed,
   stop those probes and return a runtime/access decision; do not silently
   weaken A25 or count the legacy write denial as a read pass.
3. **Implementation boundary.** Existing evidence qualifies parts of a proposed
   design, not an implemented Ensemble scheduler, inbox, supervisor or UI.
   S02–S05 product acceptance and Node/npm checks remain dependent work, not
   authorization to start them now. No release or downstream ticket follows
   from this matrix.

**Recommended route for Chris:** authorize an owner-only isolated Codex home
and a fresh supported ChatGPT login by Chris for the same intended account.
Authorize Dinesh to create that probe home with mode 0700, record only
account/workspace match metadata, run one bounded restricted-profile
qualification after `allowed:true`, and stop/remove only the new login/cache
and auth-bearing probe artifacts after owned processes exit; retain sanitized
evidence. This is an additional local authentication, not reuse or copying of
the existing cache. It must not log out, alter or revoke the original login,
copy/link tokens, change operator globals or switch to API billing. A later
dedicated service-user deployment still needs its own qualification.

An alternate temporary edit of the existing `CODEX_HOME/config.toml` requires
separate explicit authorization for the exact one-key diff, an exclusive
configuration window, byte-exact private backup, crash recovery handle and
conditional restore/verification. It risks changing other clients' defaults
and would not prove a deployable isolated configuration after restoration.
No such edit was performed. Chris has not authorized either route or any read
waiver. Crash survival, best-effort Stop and cooperative handoff require no new
decision. Once the recommended login route is approved, first verify the
profile is actually allowed/effective, then run the predeclared synthetic
inside/outside/symlink/toolchain/login cases and at most one real turn without
rerun; proceed through the remaining dependent S01 probes only while each gate
passes. If no such route is authorized, retain S01 and descendants held.
