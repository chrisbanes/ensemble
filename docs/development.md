# Development reference

For the product overview, see the [README](../README.md). For macOS service
operations and backup/restore, see the [operations procedure](operations/standalone-macos.md).

Use the Node version in [`.node-version`](../.node-version) and the npm version in
`packageManager` (`package.json`).
Node 26 is tested for compatibility (CI job `check-node-26` runs the latest 26.x;
26.9.0 has [local evidence](evidence/node-26-compatibility-2026-10-09.md)) but is not the
default baseline. `engines.node` is `>=24` as permissive metadata; Node 25, 27
and later majors are not qualified.

```sh
npm ci
npm run check
```

`check` runs strict type checking, lint, formatting, compilation and tests,
including deterministic scheduler, supervision, recovery, power and
service-integration fixtures, coordination, routing, inbox, interaction and
completion tests, and the operator auth, HTTP and Chromium browser tests. CI
installs the pinned Chromium engine used by those browser tests. Real App Server
qualification is separate and runs only when requested explicitly, for example
`npm run s03b:live` and `npm run s04b:live`, which require their `--live` opt-in
(see the other `*:live` scripts in `package.json`). These checks do not prove
physical sleep/wake behavior, operational host-restart recovery or private remote
Tailscale access.

The command surface is `npm run service -- <serve|operator|run|list> ABSOLUTE_DATA_DIR`.
`run` also takes `workId`, `prompt`, an existing absolute workspace directory,
and optionally `previousWorkId` for a follow-up in a completed conversation.
`serve` initializes the database and App Server, then waits for SIGINT or SIGTERM.
Both `serve` and `operator` also stop with an unsuccessful exit status after an
unexpected service-owned background failure. Provider failures already recorded
as incomplete source observations or power-admission holds remain visible through
those existing states; they do not trigger this fatal exit. Normal signal-driven
shutdown remains successful.
Reusing a work ID never resubmits it. A held result requires independent
reconciliation; there is no force unlock. Automatic retry is limited to an exact
terminal `serverOverloaded` or `rateLimitExceeded` failure with known retry
telemetry, settled effects, ended callbacks, and no Stop or known survivor. Codex
and Ensemble retries share a two-retry limit; uncertain or other failures remain
held.
On first use, the directory must be empty or carry Ensemble's standalone marker.
Startup can also recover an interrupted first start when the only files are an
empty `.ensemble-owner.sqlite`, its SQLite journal if present, and an absent or
partial marker whose contents match the beginning of the expected marker.
Unrelated unmarked contents, including prototype data, remain refused.
The service database is `standalone.sqlite`; `.ensemble-owner.sqlite` provides
cross-process ownership of the marked directory.
Initialize a separate operator password with
`npm run operator-auth -- init ABSOLUTE_AUTH_FILE`, then set
`ENSEMBLE_OPERATOR_AUTH_FILE` and `ENSEMBLE_OPERATOR_ORIGIN` before starting the
`operator` command. Use the exact loopback origin (including port) for local
access or an HTTPS origin for a separately managed private transport. Use a
canonical origin without a trailing slash. The server still binds only to
`127.0.0.1`; it does not configure Tailscale Serve.
Sessions are in-memory and reset on restart. The [command boundary](design/s04a-command-boundary.md)
describes domain commands and admission records; the [operator UI design](design/s04c-operator-ui.md)
describes the authenticated web boundary and its UI limits.

`StandaloneService.provisionTask` durably binds a domain task to one retained
workspace, including repository-free and multiple-repository tasks.
`submitTask` resolves that binding and captured assignment revisions before
writer admission. Capacity-waiting turns own neither a writer nor a reservation.
A bound successful terminal report admits a successor only after registered
Ensemble callbacks finish and no hold or known survivor remains. `stopTask`
synchronously persists the Stop hold and returns a bounded observation; only
`resumeTask` clears the independent Stop hold. Startup reconciliation observes
exact execution identities and never replays an ambiguous generation. A validated
recovery receipt releases only the exact generation's writer and capacity holds.
`replaceConversation` keeps assignment snapshots while advancing its conversation
revision, and `recordTaskResult` rejects early or stale results. `archiveTask`
requires delivery and preservation evidence and refuses unresolved task work.
These service contracts do not provide physical process containment. An untracked
detached child may overlap a later writer after qualified normal success.

## Previous implementation

The previous Rust pipeline implementation is preserved on the
`cb/pipeline-implementation` branch, and the BB prototype's documents remain in git
history. The pipeline implementation's configuration and persisted runs are not
compatibility requirements, and the BB prototype receives no new feature
development. Finish or explicitly retire existing work before operational cutover;
retained records do not prove safe resumption on another runtime. Earlier ADRs
retain product policy except where superseded by
[ADR-1004](adr/1004-standalone-service.md).
