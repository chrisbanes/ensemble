# S08a operations evidence — 2026-09-30

## Outcome

Passed the bounded S08a macOS launchd and SQLite backup/restore journey. This
evidence qualifies one disposable per-user service lifecycle and one supported
schema-6 database fixture; it does not qualify a deployment, final recovery,
or cutover.

## Source and runtime identity

- Branch: `cb/issue-704-operations`.
- Tested source revision: `3543097763ca00245824b9fca8d5f5f615b56f2f`, with a
  clean working tree before the live run.
- Node.js: `v24.21.0`,
  `/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node`,
  SHA-256 `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`.
- npm: `12.1.0`,
  `/private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js`,
  SHA-256 `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`.
- Codex CLI: `codex-cli 0.159.0`, resolved executable
  `/opt/homebrew/Caskroom/codex/0.159.0/bin/codex`, SHA-256
  `e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a`.
  `codex login status` succeeded and reported the existing ChatGPT login as
  authenticated; no credential contents were read or recorded.
- LaunchAgent-resolved Git: `/usr/bin/git`, SHA-256
  `5b1ddb7e9c11b87a034fc88b212e8ac243cfe2b4db696d767aa44c79595fc09a`.
- LaunchAgent-resolved `caffeinate`: `/usr/bin/caffeinate`, SHA-256
  `da55daf97b80d30aa5de4e5aef8a5d4ffb165200eb16647a735834f5edda07d4`.
- The built service and operations CLIs were resolved from the tested checkout
  under `dist/src/standalone/`.

## Bounded live procedure

Command, using the approved pinned Node/npm pair:

```sh
PATH=/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  /private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node \
  /private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js \
  run s08a:live -- --live
```

The first sandboxed attempt stopped before creating a fixture because spawning
the `launchctl` preflight returned `EPERM`. The same command then ran with the
narrowly approved launchctl execution permission and exited zero. No fixture
existed from the sandboxed attempt.

The proof used one random disposable fixture root and LaunchAgent label
`com.chrisbanes.ensemble.s08a-c5f893f22457` in `gui/501`. Before creating that
job, the harness verified the exact rendered plist with `plutil -lint` and
parsed its arguments and environment. The plist's environment contained exactly
the separate auth-file path, canonical operator origin, and
`PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`; `RunAtLoad=true` and
`KeepAlive=false`. The service used the existing Codex login, and the journey
did not request a model turn.

The service started as PID `89825`; `kickstart -k` restarted it as PID `90027`
and the authenticated operator view retained the public fixture. After
`bootout`, offline backup and verification succeeded. The snapshot manifest
reported:

- Format: `ensemble-sqlite-snapshot-v1`.
- Supported schema version: `6`.
- Schema fingerprint: `bd7925d5fad799bfde920b43a7baf17ef8e53c05610e365b68601a5ea8bfaab2`.
- Logical-content SHA-256:
  `fb8afffc692717fc186f20759013a00c6ad670e13c1cad576cafc99cb9b9aaa7`.
- SQLite-file SHA-256:
  `64b1abd12dd074fb9ea6ff0fe526929ea8396790e8c31faac93edc220bae04b7`, equal
  to the manifest digest.

An attempted backup while the source service owned its data directory was
refused, did not create the requested snapshot path, and left the source data
tree byte-identical by the harness's tree digest. Restore into a pre-existing
directory was refused; its `keep.txt` file and the original snapshot database
remained byte-identical. Successful restore created a new marked destination
and a fresh empty mode-0600 `.ensemble-owner.sqlite` before promoting the
normal marker; the harness read back its file type, mode, and zero-byte size.
The restored LaunchAgent then started as PID `90144`, restarted as PID `90193`,
and both authenticated public views retained one profile, one paused project,
and one unready task. This fixture had no eligible assignment and admitted no
work.

Both per-user jobs were booted out. The harness confirmed the observed service
processes had exited, the random label was absent, the exact temporary fixture
root had been removed, and every tracked data/auth/log/snapshot/restore/plist
fixture path was absent. A separate post-run readback confirmed the label was
still absent and PIDs `89825`, `90027`, `90144`, and `90193` had all exited.
The harness did not print its temporary root, password, session cookie, private
logs, or raw login output.

## Plan variance and evidence composition

The published plan did not include a `PATH` LaunchAgent variable. A read-only
inspection of `gui/501` showed the GUI launchd domain had no `PATH` (it exposed
`SSH_AUTH_SOCK`); the installed Codex executable is resolved by the service as
`codex`, with `git` and `caffeinate` also invoked by name. Following the lead's
reviewed narrow repair, the renderer adds only the fixed, non-secret
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` value. The plist parser and
live preflight verified that exact value and the Node, Codex, Git, and
`caffeinate` executable identities. No interactive environment was inherited,
no caller-defined environment was added, and the shared launchd domain was not
changed.

Recovery evidence is intentionally split. The deterministic restored-service
test `restored public state reconciles exact execution evidence before one
eligible admission` proves wrong/exact receipt handling, independent Stop and
Resume, source-root identity rejection before access to the old managed path
even when the persisted binding already had an unrelated hold, and one
admission after reconciliation. Focused offline-operation tests also prove
that successful and injected-failure backups of a never-started restored tree
preserve every source entry and file byte, and that an older marked directory
without owner metadata is refused unchanged. The live launchd fixture proves
start/restart/stop and backup/verify/restore of paused/unready public data, but
it does not inject a live exact receipt: #704 owns no recovery-control surface.
This is not a live receipt-recovery claim.

## Verification commands

On the exact tested source revision, before the live proof, the following
required commands passed with the pinned runtime:

```sh
PATH=/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  /private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node \
  /private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js ci

PATH=/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  /private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node \
  /private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js run check
```

`npm ci` installed the locked dependencies with zero reported vulnerabilities.
`npm run check` passed typecheck, Biome lint, formatting, TypeScript build, and
all 210 tests. `git diff --check` passed. The tested source revision is
recorded above; this evidence file is a documentation-only follow-up.

## Limits

- Only the current schema-6 standalone SQLite content was verified; future
  schemas require requalification.
- Snapshot/restore does not include managed worktree files, external workspace
  contents, credentials, logs, provider records or external effects.
- A restored managed binding under a different installation root remains held;
  this proof did not relocate workspaces.
- Offline backup refuses a marked source missing its regular in-tree owner file;
  older ownerless restores need a separately reviewed recovery path before
  backup.
- Service and operations paths must be lexically canonical and cannot traverse
  symlinked ancestors; paths under a system temp alias such as macOS `/var`
  must use their canonical physical path.
- No host reboot, pre-login service guarantee, production deployment, old-work
  disposition, Haze prototype access, or cutover was performed.
- The live paused/unready fixture made no model turn and does not prove live
  recovery receipt injection, final-schema recovery, or S08b acceptance.
