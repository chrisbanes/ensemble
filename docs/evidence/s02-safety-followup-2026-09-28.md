# S02 safety follow-up — 28 September 2026

This supplements the [S02 bootstrap evidence](s02-bootstrap-2026-09-28.md)
after merge commit `8eae34c6366358492ec093dbfb6035d192962c11`.
The repaired runtime source and deterministic fixtures are commit
`f3fdb9b98c2926f5d9142c9bbf6c7cb1dc283b88` on
`cb/cb-52-s02-safety`. This report changes no runtime source. Verification
used Node 24.21.0 and npm 12.1.0 on macOS arm64.

## Ownership and recovery

`StandaloneService.start()` canonicalizes the real data directory and takes a
SQLite `BEGIN IMMEDIATE` write transaction on `.ensemble-owner.sqlite` before
opening or migrating `standalone.sqlite`, normalizing workspace keys, or holding
unfinished rows. A concurrent `list` or `run` fails at ownership acquisition.
The transaction remains open until service stop; closing its SQLite connection
releases the OS lock on normal stop, failed startup, or process exit/crash. It
needs no PID or time based stale-lock break. A symlink ownership file is refused.
Directory path aliases through a parent symlink resolve to the same lock file;
the data directory itself remains required to be a real directory.

The real-filesystem/SQLite fixture holds a `running` row in one separate
service process. Concurrent `list` and alias-path `run` CLI processes fail,
and the row stays `running`. A forced owner `SIGKILL` permits reacquisition;
the new service holds that unfinished row and never resubmits its work ID.
An injected login startup failure then releases ownership, allowing another
start. This proves coordination between processes that use this service and
the same canonical directory on the tested local filesystem. It does not
claim protection from an external process that deliberately deletes or
rewrites the ownership file or bypasses the service.

## Child stdin failure

The App Server stdin stream has `error` and `close` listeners. All writes,
including `initialized`, JSON-RPC requests, and approval denials, use one
failure-aware send path. Its error path rejects pending RPCs, wakes terminal
waiters, records runtime failure for later waiters, and terminates the child.
The service's existing uncertain-submission handler durably holds affected
intents; no automatic retry or approval grant is introduced.

An executable fake App Server closes stdin during initialization and startup
rejects promptly. An injected `EPIPE` at `turn/start` settles the submission
with a held row retaining its thread ID and no turn ID; the row and workspace
hold survive reopen. A modern approval callback during a turn, with `EPIPE`
injected before the denial write, holds the work across reopen and blocks
another work ID. Existing callback fixtures still check cancel/abort/error
mapping, pending and bound turn identity, and no grant. These are injected
pipe and fake App Server fixtures, not new model turns or a claim about Codex
internals. The earlier existing-login and selected-policy live evidence is
unchanged; no new model call was made.

## Verification

Focused build and `node --test dist/test/standalone.test.js
dist/test/codex-runtime.test.js`: 16/16 passed. Pinned `npm ci` and
`npm run check` on the integrated candidate passed typecheck, lint, format,
build and 36/36 tests. The retained S02 fixtures cover fresh database and
migration, login/policy, callback denial, uncertain submission, and prototype
separation. The core tests retain the #686 distinction: only an explicit
pre-submission refusal restores pending work; an ambiguous launch stays held.
No Haze, prototype database, shared Codex login/config, TypeSafe credential,
deployment or cutover state was changed.
