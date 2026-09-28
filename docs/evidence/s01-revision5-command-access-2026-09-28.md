## S01 revision 5 access follow-up: attributable command, failed read boundary

Status: **S01 remains unpassed.** This continuation from evidence head
`c082030e84511e52451730522904cac41505d1d9` found an attributable
App Server `command/exec` path for a workspace write denial, but the same
`workspaceWrite` sandbox allowed a disposable sibling-file read. No model turn
or remaining S01 probe ran after that first required access failure. The prior
[revision 5 evidence](s01-revision5-2026-09-28.md) and its failed transcript
claim are unchanged.

Runtime: `/opt/homebrew/bin/codex` resolves to
`/opt/homebrew/Caskroom/codex/0.157.1/bin/codex`; `codex-cli 0.157.1`, binary
SHA-256 `27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d`,
macOS 26.7 arm64, Python 3.9.6. `codex login status` said “Logged in using
ChatGPT”; no credential material was read or recorded. The installed generated
`CommandExecParams` schema SHA-256 was
`fd034b4c85d7b6f466e30a3cbb73db86be1263aca3f81b89b547f14817dfb62e`.
It supports `sandboxPolicy`, `processId` and `streamStdoutStderr`; it has no
`approvalPolicy` parameter. The installed `SandboxPolicy.workspaceWrite`
variant has `writableRoots` and `networkAccess`, but no restricted-read field.
The [current App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes `command/exec` as a standalone sandboxed command and describes a
`readOnlyAccess` option for `workspaceWrite`; that option is not present in
this installed schema. Version-specific behavior was measured rather than
inferred from the newer documentation.

Commands from the clean `cb/35-s01-proof` checkout:

```text
codex app-server generate-json-schema --experimental --out ../.s01-r5-access-schema
codex --version
codex login status
python3 -m py_compile test/s01/revision5_command_access_probe.py
python3 test/s01/revision5_command_access_probe.py ../.s01-r5-command-access-sanitized
ps -p 81928,82034,82178,82276 -o pid=,ppid=,pgid=,comm=
```

The probe launched only its own App Server as
`codex app-server -c approval_policy=never --stdio`; `config/read` confirmed
effective `approval_policy=never`. Each command explicitly supplied
`sandboxPolicy={type:workspaceWrite,writableRoots:[fixture],networkAccess:false}`,
`cwd=fixture`, `streamStdoutStderr=true`, a distinct client `processId` and a
5-second timeout. The user's global `sandbox_mode` was `danger-full-access`,
so the explicit per-command policy, not that default, is the tested boundary.
The [sanitized trace](s01-r5-command-access-trace-2026-09-28.jsonl) contains
request argv, server responses, decoded output notifications, wall and monotonic
times. Probe source SHA-256 is
`9d872d2c6730a2c5b19edc231a7236c754e68b30eae5c317cd2d5839a420b298`.

| UTC-equivalent Unix time | Command/effect |
| --- | --- |
| 1790593798.791–.792 | Inside `printf INSIDE_OK > inside.txt` emitted `inside exit=0`, returned exit 0, and the file contained `INSIDE_OK`. |
| 1790593798.810–.811 | Sibling `printf OUTSIDE_ATTEMPT > "$1"` emitted `operation not permitted` for the target on `outside-write` stderr, returned exit 1, and the target did not exist. |
| 1790593798.827–.828 | Sibling `/bin/cat marker.txt` emitted `SYNTHETIC_OUTSIDE_MARKER` on `outside-read` stdout and returned exit 0. **Outside read was allowed.** |

The final fixture's App Server PID/PGID was 82276; the probe killed that owned
group and waited for exit -9 at Unix 1790593798.832. The earlier disposable
attempts' App Server PIDs were 81928, 82034 and 82178; all exited. A final
`ps -p` for those four exact PIDs returned no rows. Fixture directories remain
local to preserve traces; no target processes or writes outside the disposable
fixtures remain. One intermediate local trace captured the full `config/read`
response before the probe was corrected to record only policy fields. It was
excluded from committed evidence. Automatic approval review rejected deletion
of that raw trace because it would discard generated evidence; it remains only
in the disposable fixture, and this document/committed trace contain no full
config response.

`command/exec` is standalone and does not persist a turn item. It proves an
attributable streamed **write** denial, not a persisted model-turn denial or
an outside-read denial. The access/transcript gate remains unproved. The next
decision is whether to accept outside reads and amend the access contract, or
qualify a runtime/policy with supported restricted reads; then rerun an
attributable real turn and the remaining S01 probes in order. No product
supervisor, guest, Haze, existing session or GitHub state was changed.
