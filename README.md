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
`src/core` and its tests. The BB plugin, packaging and integration harness have
been removed. There is no standalone service, runtime adapter, scheduler, workspace
manager, assignment router or operator UI yet. The installed Haze prototype stays
in place until the reviewed operational cutover.

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
reads and runtime limits. S01 remains unpassed; the service reuses Codex for execution.
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
checks cover the retained core. They do not qualify the planned standalone service
or its runtime and UI.

## Design documents

The specification owns product behaviour, the design owns component boundaries,
and the acceptance plan owns required evidence. The delivery plan maps that work
into slices; ADRs explain decisions. Current confirmed choices take precedence
over historical documents. A reviewed requirement is not an implemented capability.

- [ADR-1004](docs/adr/1004-standalone-service.md): accepted standalone direction and tradeoff.
- [ADR-1005](docs/adr/1005-service-assignment-routing.md): service routing and project-lead accountability.
- [Assignment-routing design](docs/design/assignment-routing.md): selection, fallback and durable result destinations.
- [Behavioural specification](docs/SPEC.md): retained product semantics and local-task journey.
- [Standalone design](docs/design/standalone.md): proposed ownership and execution boundaries.
- [Acceptance plan](docs/acceptance.md): runtime proof and product release gates.
- [Delivery plan](docs/delivery.md): reviewed sequence and S01 proof scope.
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
