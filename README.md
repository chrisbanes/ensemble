# Ensemble

Ensemble is being built around a host-independent core for agents working on
project-scoped tasks, with BB as its first host and UI integration.
Agent instructions determine the process. Ensemble owns tasks, assignments, and
durable coordination; a host adapter supplies conversations, agent execution,
and workspaces. The bounded prototype now has a standalone core in `src/core` and a BB adapter
in `src/adapters/bb`; it still runs inside BB.
Taskboard informs the UI design; Ensemble is an independent implementation.

## Product model

- **Projects and tasks:** local or imported work, ownership, delegation, results
  and questions needing operator attention.
- **Agent profiles:** reusable instructions and execution settings, selected for
  leads and assignments; BB conversations carry out the work.
- **GitHub sync:** optional issue/Project discovery, readiness and permitted
  progress updates using the same task model.

The interface centers on projects and tasks. Persistent bot identities, personal
bot state and a separate bot management UI are outside scope. Instructions guide
how agents deliver work; Ensemble retains ownership and pending work.

## Planning checkpoint

The prototype has established feasibility. Further product implementation is paused
for review of the specification, technical design, automated acceptance plan, and
published delivery tickets. The next handback is a complete tested flow, not
a series of user-operated integration tests.

## Current status

This branch contains a bounded TypeScript prototype using SDK package 0.5.27
and declaring BB host SDK 0.5.9 compatibility:

- Local task creation in one configured BB project.
- One worker assignment per task, launched through the BB SDK.
- Core-owned project identity, launch intent, instruction snapshots, and results
  in SQLite, with explicit host project and conversation bindings.
- Reconciliation of uncertain launches without automatic duplicate dispatch.
- Agent tools for creation, delegation, reporting, and reading assignments.

This is not an operational autonomous coordinator. There is no task panel,
GitHub integration, automatic result delivery, project scheduler, or enforced
project sandbox. Local-path installation and tool registration were verified on
BB 0.43.4 with plugin SDK 0.5.9. The user reported successful live delegation
after configuring Haze. Standalone tests run the compiled core with BB absent and real SQLite files.
The isolated BB suites use a scripted provider; authenticated-provider release
evidence remains separate.

The accepted target adds local tasks plus multiple external sources per project,
project leads, task owners, concurrent delegation, durable handoffs, and a BB task
panel. GitHub repository issues and GitHub Projects are the first external sources;
Jira and Linear remain deferred.

## Development

Use Node **24.21.0** (`.node-version`) and npm **12.1.0** (`package.json`):

```sh
npm ci
npm run check
```

`check` runs strict type checking, lint, formatting checks, compilation, and tests.
`npm run format` applies formatting. `npm run build` emits JavaScript into `dist/`;
it does not package or install the plugin into BB. The BB manifest points to the
TypeScript server entry for BB's plugin tooling.

See [the prototype guide](docs/bb-prototype.md) for configuration, tools, failure
handling, migration, and validation boundaries.

## Design documents

- [ADR-1001](docs/adr/1001-agent-coordination-architecture.md): agent coordination architecture.
- [ADR-1003](docs/adr/1003-host-independent-core.md): accepted host-independent core and portability boundary.
- [Behavioural specification](docs/SPEC.md): target behaviour and the [first local-task journey](docs/SPEC.md#first-local-task-journey).
- [Technical design](docs/design/bb-plugin.md): boundaries, persistence and recovery.
- [Acceptance plan](docs/acceptance.md): automated journeys and release gates.
- [Delivery tickets](docs/delivery.md): published issues with dependencies and acceptance IDs.
- [Glossary](CONTEXT.md): canonical language.
- [Agent workflows](docs/agents/): contribution conventions.

## Previous implementation

The Rust pipeline implementation is preserved on `cb/pipeline-implementation` at
`272adb7`. Its old configuration and persisted
runs have no compatibility requirement; finish or explicitly retire existing runs
before operational cutover.

## License

Apache-2.0. See [LICENSE](LICENSE). No Taskboard or BB implementation source has
been copied into this repository; dependencies retain their own licenses.
