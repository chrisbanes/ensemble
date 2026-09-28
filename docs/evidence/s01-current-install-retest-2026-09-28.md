# S01 current-install abrupt-death retest

Status: **same failed termination gate**. This is one bounded retest after the
operator reported a Homebrew dependency repair. It repeats only the real
Codex writing-tool/App Server death probe from
[`s01-termination-followup-2026-09-27.md`](s01-termination-followup-2026-09-27.md).
No other S01 acceptance probe or guest investigation was run.

## Candidate and exact commands

- Clean `cb/35-s01-proof` checkout at
  `1ed45c01dd3762dedf7db132e12ecd276aa07837`; underlying runtime base
  `8e3ab9387389f5040631cd06e2156186aaffbc6c`; reviewed scope
  `40b045d6033184fb570e09a45ba5b04e1d8e8241`.
- `command -v codex` → `/opt/homebrew/bin/codex`; `codex --version` →
  `codex-cli 0.157.1`; `codex login status` → `Logged in using ChatGPT`.
  Only status was captured; no credential material was accessed. The current
  path and reported version match the previous failing run. This does not
  establish whether Homebrew changed anything behind the same version.
- macOS 26.7 build 25G229, arm64; Python 3.14.4 at
  `<user-home>/.pyenv/versions/3.14.4/bin/python3`. The probe code was the
  unchanged `test/s01/tree.py` (SHA-256
  `768f20cfc5d2fa48abeaf149ab1ca776827b93905c5d05cab2a481d6d4a0c42c`)
  and `test/s01/writer.py` (SHA-256
  `e0f328fe53580234d4bc9dcff9510ae1432b1e9b8eb1e60a657483abcf2597c8`).

These commands ran from the workspace work directory, with a fresh disposable
Git repository outside Ensemble:

```sh
command -v codex && codex --version && codex login status && sw_vers
python3 -c 'import sys; print(sys.executable); print(sys.version.split()[0])'
mkdir -p .s01-retest-20260928 && git -C .s01-retest-20260928 init -q
cp ensemble/test/s01/writer.py .s01-retest-20260928/writer.py
set -o pipefail && python3 ensemble/test/s01/tree.py .s01-retest-20260928 | tee .s01-retest-20260928.jsonl
wc -lc .s01-retest-20260928/effects.log .s01-retest-20260928.jsonl
ps -p 48235,48629,48643 -o pid,ppid,pgid,stat,command
```

The exact trace is
[`s01-current-install-retest-2026-09-28.jsonl`](s01-current-install-retest-2026-09-28.jsonl)
(nine JSONL records, 3,578 bytes). Timestamps in it include UTC Unix wall time
and monotonic nanoseconds. The test thread and turn were new, ephemeral IDs:
`01a0e761-8a6a-70c2-9880-7667c87a5ac3` and
`01a0e761-8aed-7831-88c6-b8737e4b1c04`.

## Observation and cleanup

At 2026-09-28T09:38:52.035769Z, immediately before the kill:

| Process | PID | PPID | PGID | SID | Birth (`ps lstart`, local time) |
| --- | ---: | ---: | ---: | ---: | --- |
| App Server | 48235 | 48158 | 48235 | 48235 | Mon Sep 28 10:38:44 2026 |
| Codex writer | 48629 | 48235 | 48629 | 48629 | Mon Sep 28 10:38:51 2026 |
| Writer child | 48643 | 48629 | 48629 | 48629 | Mon Sep 28 10:38:51 2026 |

The complete captured ancestry was writer child → writer → App Server →
probe Python → probe shell → current Codex agent → Multica → launchd. The
writer was a direct App Server child yet already in a separate group and
session. At 09:38:52.035868Z, the harness sent `SIGKILL` only to App Server
group 48235. At 09:38:53.049834Z, App Server had exited `-9`; the writer had
reparented to PID 1, its child was still attached, and the effect file had
grown from 34 to 102 bytes (two to six lines). The tool continued writing
after App Server death, reproducing the same 34→102-byte change observed in
the 27 September ancestry probe.

At 09:38:53.082161Z and 09:38:53.089813Z the harness targeted only the
recorded fixture writer PIDs 48629 and 48643 after matching their captured
birth/executable identity. The subsequent `ps -p` returned no rows for the
App Server or either writer. The temporary fixture and log were removed after
copying the trace into this evidence file. No Haze data or existing session
was targeted; login configuration was unchanged.

The operator's repair did not remove the observed failure on the current
reported install. It may have affected the earlier initialization timeouts,
whose cause remains unproved. A successful login and real turn do not pass
the termination gate. The existing direct-group approach and parent/group
scanner remain insufficient; complete, race-safe writer termination is still
unproved. At that checkpoint CB-35, descendants, and the other
[S01 #688](https://github.com/chrisbanes/ensemble/issues/688) probes remained
held pending a separate design decision.
