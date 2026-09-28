# S01 termination diagnosis: live tree and discovery race

Status: **termination gate still failed; S01 remains blocked.** This follow-up
to [the initial finding](s01-2026-09-27.md) diagnoses only the Codex tool tree
and a host-process discovery race. It does not implement a product supervisor,
guest, database, scheduler, or any other S01 probe.

## Candidate and method

- Existing checkout `cb/35-s01-proof`, prior evidence head
  `221f8759532cebc3c614815cada8e601d7cd93c9`; underlying runtime source
  head `8e3ab9387389f5040631cd06e2156186aaffbc6c`; reviewed plan
  `40b045d6033184fb570e09a45ba5b04e1d8e8241`.
- macOS 26.7 (25G229), arm64; Codex CLI/App Server 0.157.1; Python 3.14.4
  (`<user-home>/.pyenv/versions/3.14.4/bin/python3`) for these probes.
  App Server used the current user's existing ChatGPT login. No login settings
  or credentials were changed or recorded.
- `test/s01/tree.py` SHA-256
  `768f20cfc5d2fa48abeaf149ab1ca776827b93905c5d05cab2a481d6d4a0c42c`;
  `test/s01/race.py` SHA-256
  `b5dd82e8302a9e4baadfa800061ca5a3982044e4c2be71b1f81e946a999af70d`.
  The live writer was `test/s01/writer.py` from the preceding evidence commit.
- `ps -o lstart` supplied the captured birth identity, with only one-second
  precision. The probes compare this with PID and executable before targeted
  cleanup. This is test hygiene, **not** a race-safe production signaling proof.

These commands ran from the workspace work directory. The disposable Git
fixture was outside the Ensemble checkout. The exact stdout traces are
[`s01-tree-2026-09-27.jsonl`](s01-tree-2026-09-27.jsonl),
[`s01-race-1-2026-09-27.jsonl`](s01-race-1-2026-09-27.jsonl), and
[`s01-race-2-2026-09-27.jsonl`](s01-race-2-2026-09-27.jsonl).

```sh
mkdir -p .s01-tree-fixture && git -C .s01-tree-fixture init -q
cp ensemble/test/s01/writer.py .s01-tree-fixture/writer.py
set -o pipefail && python3 ensemble/test/s01/tree.py .s01-tree-fixture | tee .s01-tree-log.jsonl
set -o pipefail && python3 ensemble/test/s01/race.py oracle .s01-race-effects.log | tee .s01-race-log.jsonl
set -o pipefail && python3 ensemble/test/s01/race.py oracle .s01-race-effects-2.log | tee .s01-race-log-2.jsonl
ps -p 64177,64562,64576,64732,64734,64735,64826,64829,64830 -o pid,ppid,pgid,stat,command
```

## Real Codex writing-tool tree

The `tree.py` probe started a fresh ephemeral Codex thread
`01a0e4be-e92c-7ac0-9df7-fc7d59f7a8c1`, turn
`01a0e4be-e9b1-75c0-b14e-166fafdf084c`, and waited for `writer.py` to
write. Immediately before death at 2026-09-27T21:21:59.913Z:

| Process | PID | PPID | PGID | SID | Birth (`ps lstart`, local time) |
| --- | ---: | ---: | ---: | ---: | --- |
| App Server | 64177 | 64099 | 64177 | 64177 | Sun Sep 27 22:21:51 2026 |
| Codex writer | 64562 | 64177 | 64562 | 64562 | Sun Sep 27 22:21:59 2026 |
| Writer child | 64576 | 64562 | 64562 | 64562 | Sun Sep 27 22:21:59 2026 |

The complete ancestry capture showed writer → App Server → probe Python →
probe shell → current Codex agent → Multica → launchd. The writer was an
App Server **direct child** but already in a different process group and
session; its child shared the writer's group and session. The observation
locates the separation at Codex's tool launch boundary, without identifying
the internal call that created the new session.

At 21:21:59.913Z the harness sent `SIGKILL` to group 64177. The App Server
exited `-9`. At 21:22:00.934Z, writer 64562 had been reparented to PID 1,
writer child 64576 was still its child, both retained their birth identity,
and the effect file had grown from 34 to 102 bytes (two to six lines). The
harness then killed only those two recorded fixture PIDs after identity
checks. A later `ps` showed none of these probe processes running.

## Isolated double-fork discovery race

`race.py oracle` kept writer identity on a private socket. The scanner was a
separate process and received only the coordinator PID and process-group ID.
It scanned the full host process table for descendants or members of that
group; it received no oracle PID records or channel. A coordinator forked an
intermediate child, which called `setsid()`, forked a grandchild writer, then
exited. The coordinator also exited. The oracle waited until the writer was
reparented to PID 1 **before** allowing the scanner to run. The writer held
the effect file open but waited for an oracle signal before writing, so an
empty or quiet snapshot could not itself establish termination.

| Run | Coordinator PID/PGID/SID | Reparented writer PID/PPID/PGID/SID | Scanner time (UTC) | Scanner visible | Delayed effect |
| --- | --- | --- | --- | --- | --- |
| 1 | 64732/64732/64732 | 64735/1/64734/64734 | 21:23:08.301 | `[]` | 0 → 33 bytes at 21:23:08.307 |
| 2 | 64826/64826/64826 | 64830/1/64829/64829 | 21:23:15.082 | `[]` | 0 → 33 bytes at 21:23:15.086 |

Run 1 writer birth was `Sun Sep 27 22:23:08 2026`; run 2 writer birth was
`Sun Sep 27 22:23:15 2026`. The scanner saw 1,159 and 1,160 process-table
rows respectively, yet had no identity-safe relation that distinguished
either escaped writer from other same-user processes. Both writers were
stopped by the oracle; the cleanup observation returned no process. The final
`ps` command above reported no listed probe PIDs. Both runs completed in
under 0.4 seconds and reproduced the same missing-membership verdict.

## Boundary conclusion

The current direct App Server group is not a complete containment boundary:
Codex's real writing tool is outside it before service death. A host-native
scanner that learns writers only from periodic parent/group observations
cannot establish complete membership across the demonstrated double-fork
race; it may observe an empty tree while an old writer can still write. This
is a falsification of that **scanner design**, not proof that every macOS
primitive or whole-execution enclosure is impossible. We did not implement
or test a launchd job, external watchdog, Endpoint Security client, or guest.

No writer replacement is authorized by these observations. Missing members
must retain the writer hold, but a retained hold does not satisfy the required
termination proof. A candidate needs an execution boundary with complete
membership, a way to stop process creation and terminate all writers, and
identity-safe confirmation before releasing ownership. The existing-login
and deployment implications of any larger boundary remain decisions for
Churchill/Chris. The remaining `docs/delivery.md` probes remain unproved.

The probe created only isolated fixture files and new ephemeral Codex test
threads. Both writers and the App Server were stopped; the effect files and
temporary logs were removed from the workspace after copying these traces.
Haze and existing sessions were untouched.
