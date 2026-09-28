## S01 named-profile launch configuration follow-up

Status: **no supported probe-local App Server launch retaining the current
ChatGPT login was established.** S01 remains unpassed. This is a bounded
configuration finding from clean `cb/35-s01-proof` head
`900e83c8c1688707c3b2cd825bb5b519f5bf5405` (contract
`56976c0cea82d4dadfac73ab60979e0cfed69c30`, runtime base
`8e3ab9387389f5040631cd06e2156186aaffbc6c`). The prior
[named-profile `allowed:false` trace](s01-named-profile-2026-09-28.md) and
[legacy outside-read success](s01-revision5-command-access-2026-09-28.md)
remain unchanged.

At 2026-09-28T11:22:16Z, `/opt/homebrew/bin/codex` reported
`codex-cli 0.157.1`. The existing runtime `CODEX_HOME` has an `auth.json`
file and its `config.toml` line 7 has
`sandbox_mode = "danger-full-access"`; only the existence of the auth file
and this configuration key/value were inspected. No credential contents or
full configuration were read into evidence. `codex login status` with the
existing home reported “Logged in using ChatGPT.”

The [official Permissions guide](https://learn.chatgpt.com/docs/permissions)
says loaded legacy `sandbox_mode` settings take precedence over named
`default_permissions`, absent a managed profile allowlist, and instructs users
to remove older settings for named profiles. The
[official CLI reference](https://learn.chatgpt.com/docs/developer-commands)
documents `--ignore-user-config` for non-interactive `codex exec`, while
authentication still uses `CODEX_HOME`. In this installed binary,
`codex app-server --help` lists `-c` overrides and `--strict-config`, but no
`--ignore-user-config`. The parser confirmed it is unsupported on App Server:

```text
codex app-server --ignore-user-config --help
# exit 2: error: unexpected argument '--ignore-user-config' found
```

A fresh process-local home avoids the inherited user config without changing
the operator's files, but does not retain this file-based login:

```text
mkdir -p ../.s01-isolated-codex-home
CODEX_HOME="$PWD/../.s01-isolated-codex-home" codex login status
# exit 1: Not logged in
```

The isolated home has no `auth.json`; no credential was copied or linked.
The installed App Server schema exposes `config/read`, `config/value/write`
and `config/batchWrite`, but those write configuration files; no supported
App Server request or CLI flag was found that removes a lower-layer legacy
key only for this process while retaining the same file-based login. `-c`
overrides values but does not remove the key, and a selected profile file
layers over the existing base config. This is a conclusion about the
documented and installed surfaces inspected, not a proof that no future
runtime or separately reviewed auth integration could work.

No named profile was selected while `allowed:false`; no `command/exec`,
model call, real turn, credential migration, synthetic access case or
remaining S01 gate ran. No probe process remained (`ps -p 85202` returned no
row for the prior owned App Server); this follow-up launched no App Server.
The empty isolated home was left as a disposable local fixture. No Haze,
existing session, guest, operator global config or GitHub state was changed.

Next decision: qualify a runtime/App Server launch with a supported
configuration-isolation mechanism that reuses the existing login without
copying credentials, or separately review a safe credential handoff and
fresh isolated home. Once a named profile is actually `allowed:true`, repeat
the synthetic outside-read/write, symlink, toolchain/login and attributable
real-turn/transcript gates. Outside-read denial remains required; the legacy
read failure is not a waiver.
