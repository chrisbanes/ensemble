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

The repository contains a reusable TypeScript/SQLite coordination core in
`src/core`, plus the S02 standalone bootstrap and Codex App Server adapter in
`src/standalone`. The bootstrap owns a marked fresh data directory, persists
execution intent and binding, and holds uncertain work across restart. The BB
plugin, packaging and integration harness have been removed. Scheduler, workspace
manager, assignment router and authenticated remote operator UI are still pending.
S04a adds versioned local domain commands and a minimal loopback operator interface;
it does not dispatch assignments. The installed Haze
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

`check` runs strict type checking, lint, formatting, compilation and tests. The
checks cover the retained core and S02 bootstrap fixtures. They do not qualify
the later scheduler or UI integration.

The command surface is `npm run service -- <serve|operator|run|list> ABSOLUTE_DATA_DIR`.
`run` also takes `workId`, `prompt`, an existing absolute workspace directory,
and optionally `previousWorkId` for a follow-up in a completed conversation.
`serve` initializes the database and App Server, then waits for SIGINT or SIGTERM;
it does not schedule work. Reusing a work ID never resubmits it. A held result
requires independent reconciliation; there is no automatic retry or force unlock.
On first use, the directory must be empty or carry Ensemble's standalone marker.
Startup can also recover an interrupted first start when the only files are an
empty `.ensemble-owner.sqlite`, its SQLite journal if present, and an absent or
partial marker whose contents match the beginning of the expected marker.
Unrelated unmarked contents, including prototype data, remain refused.
`standalone.sqlite` stores service data; `.ensemble-owner.sqlite` holds the
SQLite ownership transaction that excludes a second service process.
`operator` serves the local forms at `http://127.0.0.1:8787/` while the service
runs. It has no remote access or separate login; #703 owns that foundation.
The [S04a boundary](docs/design/s04a-command-boundary.md) describes the command,
read-view and admission records available to dependent slices.

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
