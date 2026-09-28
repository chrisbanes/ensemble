# Ensemble

Ensemble is being built as a standalone service for agents working on project-scoped
tasks. **BB is no longer part of the target architecture.** Ensemble will own
scheduling, execution supervision, task workspaces and its operator interface,
alongside durable tasks, assignments, results and recovery.

Agents decide how work proceeds through instructions and coordination tools;
Ensemble enforces ownership, admission and permissions. Projects have reusable
profiles, local tasks and optional GitHub sources. There is no configured process
graph or separate persistent-bot model.

## Current status

The repository still contains the bounded BB prototype: a reusable TypeScript/
SQLite core in `src/core`, a BB adapter in `src/adapters/bb`, and its packaging and
integration suites. It supports local task creation, one worker assignment per task,
instruction snapshots, results and conservative uncertain-launch reconciliation.
It is not a standalone service or autonomous coordinator. The standalone scheduler,
workspace manager and operator UI are not implemented.

The [accepted direction](docs/adr/1004-standalone-service.md) removes BB rather than
retaining it as an optional backend. The [delivery plan](docs/delivery.md) retires
its packages, adapter and CI during replacement bootstrap. Existing core behavior
and historical failure evidence remain useful. The installed Haze prototype is
preserved until a reviewed operational cutover.

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

## Development

Use Node **24.21.0** (`.node-version`) and npm **12.1.0** (`package.json`):

```sh
npm ci
npm run check
```

`check` runs strict type checking, lint, formatting, compilation and tests. Current
package metadata and BB suites describe the transitional prototype; they do not
establish standalone compatibility. This direction change makes no runtime/package
changes and has no effect on an installed instance.

## Design documents


The specification owns product behaviour, the design owns component boundaries,
and the acceptance plan owns required evidence. The delivery plan maps that work
into slices; ADRs explain decisions. Current confirmed choices take precedence
over historical BB documents. A reviewed requirement is not an implemented capability.


- [ADR-1004](docs/adr/1004-standalone-service.md): accepted standalone direction and tradeoff.
- [Behavioural specification](docs/SPEC.md): retained product semantics and local-task journey.
- [Standalone design](docs/design/standalone.md): proposed ownership and execution boundaries.
- [Acceptance plan](docs/acceptance.md): runtime proof and product release gates.
- [Delivery plan](docs/delivery.md): reviewed sequence, S01 proof scope and BB ticket reconciliation.
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

Apache-2.0. See [LICENSE](LICENSE). Taskboard informs the UI design; no Taskboard or
BB implementation source has been copied into this repository. Dependencies retain
their own licenses.
