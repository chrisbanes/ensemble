## S01 named-profile qualification stopped before execution

Status: **unproved/blocked at profile availability.** From clean branch head
`d7c27dba9bc914f5129e07db5e70e8a06fe88c25` (revision 5 contract
`56976c0cea82d4dadfac73ab60979e0cfed69c30`), a probe-local named
profile appeared in effective configuration but `permissionProfile/list`
reported `allowed:false`. No `command/exec` request or model turn was sent.
The [legacy `workspaceWrite` outside-read failure](s01-revision5-command-access-2026-09-28.md)
remains valid and was not waived.

Installed `/opt/homebrew/bin/codex` was `codex-cli 0.157.1` on macOS 26.7
arm64; `codex login status` said “Logged in using ChatGPT” without exposing
credentials. The installed generated schema supports `permissionProfile`
instead of `sandboxPolicy` on `command/exec`, and `permissions` instead of
legacy `sandbox`/`sandboxPolicy` on thread/turn. It also exposes
`permissionProfile/list` with `id` and `allowed`.

Predeclared limit: one fresh fixture containing only synthetic inside,
sibling, home-like and symlink targets; at most eight direct command cases,
one real model turn if direct cases passed, and zero reruns. The fixture and
profile were created only for this probe. The profile extended `:workspace`,
denied `:root`, permitted `:minimal` read, denied `:tmpdir` and `:slash_tmp`,
and disabled command network. The App Server received those settings as
process-local `-c` overrides with `approval_policy=never`; no operator config,
login files or credentials were changed or copied. Exact argv, IDs and
timestamps are in the [nine-row sanitized trace](s01-named-profile-list-trace-2026-09-28.jsonl).

Commands from the clean checkout:

```text
codex --version
codex login status
python3 -m py_compile test/s01/named_profile_access_probe.py
python3 test/s01/named_profile_access_probe.py ../.s01-named-profile-2026-09-28
ps -p 85202 -o pid=,ppid=,pgid=,comm=
```

The Python invocation returned exit 1 with `AssertionError: named profile
absent or disallowed`. `initialize` succeeded at Unix 1790594231.772548.
`config/read` at 1790594231.869573 confirmed `approval_policy=never`,
`profile_configured=true`, and an inherited effective legacy
`sandbox_mode=danger-full-access`. At 1790594231.894107,
`permissionProfile/list` returned built-ins `:read-only`, `:workspace` and
`:danger-full-access` as allowed, but `s01_probe` as **not allowed**. The probe
stopped before `account/read`, direct access, toolchain, login-in-profile,
real-turn, transcript, resume/restart and remaining S01 checks. Its owned App
Server PID/PGID 85202 was killed and reaped (exit -9 at 1790594231.898086);
exact-PID `ps` returned no row. The disposable fixture is retained locally
with the trace; no fixture command or model process ran.

The [official Permissions guide](https://learn.chatgpt.com/docs/permissions)
says permission profiles and legacy `sandbox_mode` do not compose: when a
loaded config contains legacy sandbox settings, Codex uses them instead of
`default_permissions`, absent managed `allowed_permission_profiles`.
The inherited legacy mode is therefore a plausible cause of the disallowed
named profile, but this trace does not establish the precise requirement or
config-layer reason. The exact `allowed:false` result is decisive: selecting
this profile would not be a valid access qualification. A next bounded plan
must establish a supported probe-local way to make the named profile allowed
with the existing login and without changing operator globals; then repeat
the synthetic denial, toolchain/login, real-turn/transcript and resume gates.
No Haze, guest, product supervisor or GitHub state was changed.

Probe source SHA-256:
`f1193c7a4f6fd96358586857557637211a35671874cef232833da659246662b9`.
Committed trace SHA-256:
`f6d9e2642b953da07497bde94939bb0d17e9da0cf342bcd987ac014f999c085b`.
