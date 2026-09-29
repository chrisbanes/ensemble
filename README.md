# Ensemble

Ensemble is being built as a standalone service for agents working on project-scoped
tasks. **BB is no longer part of the target architecture.** Ensemble will own
scheduling, execution supervision, task workspaces and its operator interface,
alongside durable tasks, assignments, results and recovery.

Project leads are accountable for task outcomes, with separate conversations per
task. Optional service-driven TypeSafe routing selects assignment assignees using
profile capabilities and project guidance; uncertainty returns to the lead.
Agents decide how work proceeds through instructions and coordination tools;
Ensemble enforces ownership, admission and permissions. Projects have reusable
profiles, local tasks and optional GitHub sources. There is no configured process
graph or separate persistent-bot model.

## Current status

The repository contains a TypeScript/SQLite coordination core in `src/core` and
a standalone service with a durable turn scheduler and execution supervisor in
`src/standalone`. The S03b service slice implements shared writer/capacity
admission, capacity-waiting, bounded Stop observation, conservative restart
reconciliation, exact recovery receipts, narrow retry accounting and a macOS
sleep/wake admission gate. The BB plugin, packaging and integration harness have
been removed. The full assignment router, #694 operator scheduling/capacity
controls and recovery presentation, and S05 physical sleep/wake qualification
remain pending. #703 adds an authenticated operator UI
foundation with a separate password/session boundary and initial project,
profile, routing and local-task forms. Runtime, coordination, history and
recovery UI remain unavailable, and the bounded private Tailscale proof remains
unproved. The [S04c boundary](docs/design/s04c-operator-ui.md) records its scope
and limits. The installed Haze
prototype stays in place until the reviewed operational cutover.

## Planning checkpoint

Chris reviewed and confirmed the standalone product scope, design choices,
acceptance plan and delivery sequence on 27 September 2026.
First prove a real execution runtime's admission, cancellation and recovery boundary;
then build the complete local-task journey, followed by GitHub integration.
The reviewed choices are Codex with the existing login, macOS first, and a web
interface over Tailscale with a separate Ensemble login. Start with a fresh database.
Chris approved the minimum S01 Codex App Server contract on 28 September: qualify
authenticated execution and durable coordination feasibility, with best-effort
cancellation, cooperative successful handoff and conservative uncertainty holds.
Strict outside-read denial and complete descendant containment are separate choices;
the [default policy](docs/design/standalone.md#default-execution-policy) discloses broad
reads and runtime limits. S01 was accepted with recorded limits; the service reuses Codex for execution.
The same-day routing amendment adds optional TypeSafe assignment routing to the
first release and defers a separate task-owner role. TypeSafe uses separately
configured API credentials and explicit project opt-in.

## Development

Use Node **24.21.0** (`.node-version`) and npm **12.1.0** (`package.json`):

```sh
npm ci
npm run check
```

`check` runs strict type checking, lint, formatting, compilation and tests,
including deterministic S03b scheduler, supervision, recovery, power and
service-integration fixtures, plus the operator auth, HTTP and Chromium browser
tests. CI installs the pinned Chromium engine used by those browser tests. Real
App Server qualification is separate and must be run explicitly with
`npm run s03b:live`; the harness refuses to run without its `--live` opt-in.
These checks do not prove physical sleep/wake behavior, operational host-restart
recovery or private remote Tailscale access.

The command surface is `npm run service -- <serve|operator|run|list> ABSOLUTE_DATA_DIR`.
`run` also takes `workId`, `prompt`, an existing absolute workspace directory,
and optionally `previousWorkId` for a follow-up in a completed conversation.
`serve` initializes the database and App Server, then waits for SIGINT or SIGTERM.
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
Sessions are in-memory and reset on restart. The [S04a boundary](docs/design/s04a-command-boundary.md)
describes domain commands and admission records; [S04c](docs/design/s04c-operator-ui.md)
describes the authenticated web boundary and current UI limits.

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

## Design documents

The specification owns product behaviour, the design owns component boundaries,
and the acceptance plan owns product evidence requirements. GitHub issues own
delivery scope, sequencing, native dependencies, status and slice completion
criteria; ADRs explain decisions. Current confirmed choices take precedence
over historical documents. A reviewed requirement is not an implemented capability.

- [ADR-1004](docs/adr/1004-standalone-service.md): accepted standalone direction and tradeoff.
- [ADR-1005](docs/adr/1005-service-assignment-routing.md): service routing and project-lead accountability.
- [Assignment-routing design](docs/design/assignment-routing.md): selection, fallback and durable result destinations.
- [Behavioural specification](docs/SPEC.md): retained product semantics and local-task journey.
- [Standalone design](docs/design/standalone.md): proposed ownership and execution boundaries.
- [Acceptance plan](docs/acceptance.md): runtime proof and product release gates.
- [Delivery backlog](https://github.com/chrisbanes/ensemble/issues/649): authoritative issues and native dependencies; [S01](https://github.com/chrisbanes/ensemble/issues/688) owns its bounded proof checklist.
- [Glossary](CONTEXT.md): canonical language.
- [Agent workflows](docs/agents/): contribution conventions.

Historical references: [BB specification](docs/SPEC-bb.md), [BB design](docs/design/bb-plugin.md),
[BB acceptance](docs/acceptance-bb.md), [BB delivery](docs/delivery-bb.md),
[capability evidence](docs/bb-capabilities.md), and [prototype guide](docs/bb-prototype.md).
These do not authorize new BB feature development. Earlier ADRs retain product
policy except where explicitly superseded by ADR-1004.

## Previous implementation and license

The Rust pipeline implementation remains on `cb/pipeline-implementation` at `272adb7`.
Its configuration and persisted runs are not compatibility requirements. Finish or
explicitly retire existing work before operational cutover; retained records do not
prove safe resumption on another runtime.

Apache-2.0. See [LICENSE](LICENSE). Taskboard informs the UI design. Dependencies
retain their own licenses.
