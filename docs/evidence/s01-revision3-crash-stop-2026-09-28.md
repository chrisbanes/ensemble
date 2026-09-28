# S01 revision 3: bounded crash hold and failed explicit Stop

Status: **critical explicit-Stop capability failed; S01 remains blocked.**
Chris approved the [28 September crash-policy amendment](../adr/1004-standalone-service.md)
recorded at `5cad6813a0dd2018057966d177c2c4d415f76677`. This investigation
stopped after a real Codex turn reported interruption while its writing tool
and escaped child continued. The original failed crash-termination evidence
remains unchanged and is not relabelled a pass.

## Candidate and scope

- Branch `cb/35-s01-proof`; tested contract head
  `5cad6813a0dd2018057966d177c2c4d415f76677`; underlying runtime source
  base `8e3ab9387389f5040631cd06e2156186aaffbc6c`; original reviewed
  contract `40b045d6033184fb570e09a45ba5b04e1d8e8241`.
- macOS 26.7 build 25G229, arm64; `codex-cli 0.157.1` with existing ChatGPT
  login status. No credential contents or settings were accessed. The Python
  tool process executable observed in the trace was
  `<user-home>/.pyenv/versions/3.14.4/bin/python3`; the tests ran via the
  shell's `python3` command. Real SQLite 3.51.0 files used WAL mode and
  `synchronous=FULL`; both later returned `PRAGMA integrity_check = ok`.
- Probe sources: `test/s01/revision3_probe.py` SHA-256
  `d804fba7f51574ec1e70eb7f1ee32284ddaf41306158cde378c200d00d66d1c3`;
  `test/s01/escaped_writer.py` SHA-256
  `5c4c9890132507db98163f9d7838cd776dd4e6d18b865ca93bacc24fc6a664a2`.
  The latter launches a child into a separate macOS session/group; both parent
  and child are disposable, bounded process fixtures. The SQLite row is a
  minimal hold/reopen fixture, **not** the product scheduler or a production
  descendant-discovery mechanism.

The exact commands below ran from the workspace work directory with two fresh
disposable Git repositories outside the Ensemble checkout. The stdout traces
are [`s01-r3-crash-2026-09-28.jsonl`](s01-r3-crash-2026-09-28.jsonl) and
[`s01-r3-stop-2026-09-28.jsonl`](s01-r3-stop-2026-09-28.jsonl), containing
12 and 23 records respectively, with UTC Unix and monotonic timestamps.

```sh
mkdir -p .s01-r3-crash && git -C .s01-r3-crash init -q
cp ensemble/test/s01/escaped_writer.py .s01-r3-crash/escaped_writer.py
set -o pipefail && python3 ensemble/test/s01/revision3_probe.py crash .s01-r3-crash | tee .s01-r3-crash.jsonl
mkdir -p .s01-r3-stop && git -C .s01-r3-stop init -q
cp ensemble/test/s01/escaped_writer.py .s01-r3-stop/escaped_writer.py
set -o pipefail && python3 ensemble/test/s01/revision3_probe.py stop .s01-r3-stop | tee .s01-r3-stop.jsonl
python3 -c 'import sqlite3; print(sqlite3.sqlite_version); [(lambda c: print(p, c.execute("pragma integrity_check").fetchone(), c.execute("select * from execution").fetchone()))(sqlite3.connect(p)) for p in (".s01-r3-crash/probe.sqlite", ".s01-r3-stop/probe.sqlite")]'
ps -p 55815,56201,56215,56317,56711,56726 -o pid,ppid,pgid,stat,command
```

## Crash-survivor hold fixture

The fixture committed a generation, work revision 1, writer hold and capacity
hold in SQLite **before** sending `turn/start`. It then bound new ephemeral
thread `01a0e774-c788-78e0-8415-af287e1e4e6a` and turn
`01a0e774-c80e-7a33-b1ac-e55cebbca64a` to the same row. A real Codex
writing tool produced 40 bytes. At 2026-09-28T09:59:51.989927Z, the harness
sent `SIGKILL` only to App Server group 55815. The writer parent PID 56201
(PPID 55815, PGID/SID 56201) and escaped child PID 56215 (PPID 56201,
PGID/SID 56215) had matching captured birth identities at launch. At
09:59:53.029211Z, App Server had exited `-9`, parent 56201 had reparented
to PID 1, both writers remained alive, and the effect file had grown 40→120
bytes (two to six lines).

Reopening the real database returned the original generation with state
`bound`, writer hold 1, capacity hold 1, Stop hold 0 and the original thread/
turn IDs. The fixture's replacement-admission check returned `false`.
`PRAGMA integrity_check` returned `ok`. This proves only that the **fixture**
persisted and re-read its holds while an old tool could write. It does not
prove coordinator-crash recovery, unique live reattachment, no new turn from
a product scheduler, lost-response reconciliation or safe writer release.

## Explicit-Stop failure

A second fresh SQLite file committed generation
`s01-stop-1790589604616398000`, writer/capacity holds and work revision 1
before turn submission. It bound new ephemeral thread
`01a0e775-13e3-7582-8d03-886bc8a1c793` and turn
`01a0e775-1464-70e3-8267-e45e1f523ccd`. A real Codex command was
writing: parent PID 56711 (PPID 56317, PGID/SID 56711) and escaped child
PID 56726 (PPID 56711, PGID/SID 56726). At
2026-09-28T10:00:12.091397Z, with 40 bytes of effects, the fixture committed
state `stopping` and Stop hold 1 to SQLite **before** sending
`turn/interrupt` at 10:00:12.091455Z.

App Server returned `{}` at 10:00:12.095904Z and emitted
`turn/completed: interrupted` at 10:00:12.096002Z. At
10:00:13.126660Z, App Server remained alive, **both writing processes were
still alive**, and the effect file had grown 40→120 bytes (two to six lines).
Reopened SQLite retained writer hold 1, capacity hold 1, Stop hold 1, state
`stopping` and original thread/turn IDs; replacement admission returned
`false`. Integrity check returned `ok`.

Thus `turn/interrupt` acknowledgement and an interrupted turn event do not
prove termination of the running writing tool or escaped descendant on this
installation. The fixture's retained hold prevented its own replacement; it
does not satisfy the approved explicit-Stop requirement or demonstrate a
positive safe-release path. The parent process also remained alive in this
observation, so the failure is broader than a single escaped child.

## Cleanup and decision boundary

The harness sent `SIGKILL` only to the recorded fixture PIDs after checking
their captured PID, `ps lstart` birth and executable identity. App Server was
terminated through its own isolated group in the Stop fixture; the crash
fixture App Server had already exited. The final `ps` command returned no
rows for any of the six probe PIDs. Each effect file contained six lines,
120 bytes. The disposable repositories and temporary logs were removed after
the raw traces were copied into this evidence directory. Haze and existing
sessions were untouched.

This is a failed critical capability under revision 3. A durable Stop hold
and indefinite uncertainty are necessary safeguards, but do not fulfil the
explicit termination and termination-before-replacement requirements. There
is no proven positive safe-release mechanism for escaped writers in this
candidate. We stopped before further crash timing, coordinator death,
lost-response/binding, admission, identity, access, transcript or release
probes. S01 and dependent work remain blocked pending a concrete design
decision; no guest or product supervisor was built.
