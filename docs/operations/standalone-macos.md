# Standalone macOS operations

This procedure applies to the standalone Ensemble service only. It does not
read or migrate the installed Haze prototype, install a persistent service on
its own, or authorize production deployment or cutover. Keep all data, auth,
snapshot, restore, plist and log paths separate, absolute, real (not symlinks),
and private to the operator.

## Runtime and authentication

Use Node.js `24.21.0` and npm `12.1.0`. Build from a reviewed checkout and keep
the Node executable and compiled CLI at stable absolute paths that remain
available to the logged-in user:

```sh
node --version
npm --version
npm ci
npm run check
npm run build
```

Create the auth parent directory with mode `0700`, then initialize an
independent Ensemble operator password. The command reads the password from a
hidden terminal prompt; do not put it in shell history, argv, a plist or logs.
The auth file contains a password verifier, not the password, and is mode
`0600`:

```sh
npm run operator-auth -- init /absolute/private/auth/operator-auth.json
```

Create an empty private standalone data directory and a private log directory.
The first service start creates `.ensemble-standalone` and acquires
`.ensemble-owner.sqlite`. Do not point the service at a prototype, an
unmarked non-empty directory, a symlink, or an existing unrelated install.

## Generate and review a per-user LaunchAgent

Choose a unique reverse-DNS label, an available loopback port, and private
stdout/stderr paths whose parent directories already exist. Render the plist
using the built CLI; the renderer validates its absolute paths and writes only
the exact `${label}.plist` destination, exclusively, with mode `0600`:

```sh
npm run operations -- render-launch-agent \
  com.example.ensemble \
  /absolute/path/to/node \
  /absolute/path/to/ensemble/dist/src/standalone/cli.js \
  /absolute/private/ensemble-data \
  /absolute/private/auth/operator-auth.json \
  http://127.0.0.1:8787 8787 \
  /absolute/private/logs/operator.stdout.log \
  /absolute/private/logs/operator.stderr.log \
  /absolute/private/launch-agents/com.example.ensemble.plist
```

The current renderer sets `RunAtLoad=true` and `KeepAlive=false`; launchctl,
not automatic crash relaunch, owns restart. The plist contains the Node/CLI,
operator command, data directory, port, separate auth-file path, canonical
origin, fixed non-secret PATH, and private log paths. It contains no password
or shell wrapper. Before bootstrap, inspect and lint the exact plist:

```sh
/usr/bin/plutil -lint /absolute/private/launch-agents/com.example.ensemble.plist
/usr/bin/plutil -p /absolute/private/launch-agents/com.example.ensemble.plist
```

The `PATH` is deliberately fixed to
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`; launchctl's observed GUI
domain does not provide the interactive shell's PATH, while `CodexRuntime`
starts the installed `codex` executable by name and the runtime may use `git`
or `caffeinate`. This avoids inheriting arbitrary interactive environment
variables. Confirm `codex`, Node, the compiled CLI, `git`, and `caffeinate`
resolve to the intended installed executables before loading the job. A host
whose Codex installation is outside this fixed PATH needs a reviewed renderer
change; do not patch launchctl's shared environment or add arbitrary plist
variables locally.

The service uses the logged-in user's existing Codex login; it does not copy,
read, or alter Codex credentials. The separate Ensemble auth file is not that
login. The launchd proof starts App Server and verifies authentication/config
initialization without requesting a model turn.

## Start, inspect, restart and stop

Run these commands in the logged-in user's GUI launchd domain, using the exact
label and plist you just reviewed:

```sh
launchctl bootstrap "gui/$(id -u)" /absolute/private/launch-agents/com.example.ensemble.plist
launchctl print "gui/$(id -u)/com.example.ensemble"
launchctl kickstart -k "gui/$(id -u)/com.example.ensemble"
launchctl print "gui/$(id -u)/com.example.ensemble"
launchctl bootout "gui/$(id -u)/com.example.ensemble"
launchctl print "gui/$(id -u)/com.example.ensemble"  # must fail after bootout
```

After bootstrap, request the configured loopback `/login` page and authenticate
with the separate Ensemble password. Do not expose this local HTTP listener
through a tunnel or network proxy as part of this procedure. After
`kickstart -k`, expect in-memory operator sessions to reset and log in again.
Before deleting a plist or fixture, wait for the exact service process to exit
and verify that the label is absent. An active service holds the data-directory
owner lock, so offline backup refuses rather than racing it.

After a host restart, the per-user LaunchAgent is available when that user logs
into the GUI session. Inspect the exact label; if it is absent, review the same
plist and manually bootstrap it, then verify the loopback operator page and
service state. This is the documented fallback only: this procedure did not
reboot the host and does not claim unattended pre-login service startup.

## Offline snapshot and restore

Stop the exact per-user job with `launchctl bootout`, wait for its process to
exit, and confirm the exact label is absent. Then back up to a new snapshot
directory and verify it before relying on it:

```sh
npm run operations -- backup \
  /absolute/private/ensemble-data \
  /absolute/private/snapshots/ensemble-2026-09-30
npm run operations -- verify \
  /absolute/private/snapshots/ensemble-2026-09-30
```

The snapshot is a private directory containing only `standalone.sqlite` and a
strict `manifest.json` commit marker. Node 24's SQLite backup API captures the
whole database without table-specific export. Verification checks SQLite
integrity, schema version/fingerprint, database bytes, and a deterministic
typed logical-content digest. A database owner lock is required; no process ID
or timestamp is treated as ownership evidence.

Restore only to a distinct, nonexistent data-directory path whose parent is
already private:

```sh
npm run operations -- restore \
  /absolute/private/snapshots/ensemble-2026-09-30 \
  /absolute/private/ensemble-data-restored
npm run operations -- verify \
  /absolute/private/snapshots/ensemble-2026-09-30
```

The restore command verifies the snapshot and restored database, then promotes
its incomplete sentinel to `.ensemble-standalone` as its final commit. The
second `verify` checks the snapshot, not the restored directory. Do not start a
restore destination unless `restore` exits successfully; successful restore
returns the matching manifest identity. Generate a new reviewed LaunchAgent
for that destination, then start it normally. Service startup performs normal
migrations and workspace/execution reconciliation before scheduler admission;
restore itself neither clears holds nor upgrades domain state.

The database snapshot excludes managed worktree contents, repository state,
operator auth files, Codex/provider records, logs and external effects. Stored
workspace paths remain evidence. A managed workspace restored under a different
installation root is rejected by identity before access to the old path and
remains held for operator recovery; external workspace contents are not copied.
Recovery receipts still need to match the persisted execution generation and
independent Stop, writer and capacity holds. The deterministic S08a fixture
proves exact receipt reconciliation and one post-restore admission. The
disposable launchd proof instead preserves a paused project and unready task
across restore/restart and admits no work; it does not claim to inject a live
recovery receipt because #704 does not own the later operator recovery surface.

If backup fails, the source is not changed; an operation-created snapshot path
may remain incomplete and is never a valid backup. If restore fails after its
sentinel is created, the destination retains
`.ensemble-restore-incomplete`, and both verification and service startup refuse
it. Inspect and remove only the exact private path created by that failed
operation, after confirming no process owns or uses it. Restore atomically
reserves the exact destination name with `mkdir`; there is an unavoidable
interval after that reservation and before sentinel creation when a killed
restore can leave an empty directory indistinguishable from a deliberately
created fresh installation. Track the intended path out-of-band and never
start it until restore succeeds and the snapshot is verified.

S08a is backup/restore preparation, not release-candidate recovery or cutover.
S08b (#698) retains final-schema and external-effect reconciliation, safe
disposition of old work, host-restart qualification, production deployment and
the reviewed Haze cutover gate. Do not migrate old work or enable competing
production work based only on this snapshot.
