![Colourful abstract shapes coming together as an ensemble.](docs/assets/ensemble-hero.png)

# Ensemble

**Delegate the task. Keep the bigger picture.**

Ensemble is being built to coordinate a team of agents across your projects.
Give a task to a project lead, let it organise the work, and keep track of the
results and decisions that need you. Your instructions shape how the agents
work; Ensemble keeps track of who's responsible and what happens next.

> **In development.** The service and operator UI exist, but the complete
> task-to-delivery journey is still being built and qualified. This isn't a
> ready-to-install release yet.

[Follow the roadmap](https://github.com/chrisbanes/ensemble/issues/649) ·
[Current status](#where-it-stands) · [Development](#development)

## Give it an outcome

The intended experience starts with a task, such as:

> “Add keyboard navigation to the settings screen. Follow the project's
> accessibility conventions and have the changes reviewed.”

The project lead would organise the work, delegate assignments and bring the
results together. Independent assignments could run concurrently. A reviewer
could ask for revisions. A decision needing your input would appear in the
operator interface, alongside the work it belongs to.

The lead stays accountable for the outcome. Planning, implementation and review
come from the agents' instructions, so each project can have its own way of
working.

## A team with a shared memory of the work

Ensemble's design centres on a few things that become important once several
agents are working at once:

- **Projects with their own context.** Keep tasks, repositories, agent profiles,
  instructions and permissions together. Coordinate multiple projects through
  one service.
- **Assignments that outlast a chat.** Retain ownership, follow-ups and results
  when an agent needs a new conversation. Keep the task's working files with
  the task.
- **Room for parallel work.** Let agents delegate independent assignments while
  Ensemble manages shared execution capacity and access to task workspaces.
- **A place for your attention.** See questions, approval requests, results and
  recovery state in the operator UI, with the context needed to respond.

## Why I'm building this

Ensemble grew out of my `run-github-project` workflow. I'm building a standalone
service to coordinate work across multiple projects, with project leads
responsible for outcomes and a durable record of the work between agents.

The development method belongs in the instructions I give those agents.
Ensemble's job is to support their coordination and give me somewhere to see
what's happening and step in when needed.

## Where it stands

Ensemble is a **TypeScript, Node.js and SQLite** service with **Codex App Server**
executing agent turns. The first release targets macOS and a private web interface,
using a separate Ensemble login. [Epic #649](https://github.com/chrisbanes/ensemble/issues/649)
owns delivery scope and status.

**Implemented**

- **Coordination.** Durable scheduling with shared writer and capacity limits,
  supervised turns, best-effort Stop and conservative restart recovery. Task
  coordination covers assignments, results, inboxes, questions, approvals,
  lead-gated completion and assignment routing.
- **Operator UI.** An authenticated React interface at `/app` with an attention
  overview, cross-project and per-project List and Board views, a local task
  composer, the Inbox, retained search and Settings. The original HTML forms remain
  reachable at `/`.
- **Inbox and questions.** The action Inbox lists cross-project questions, approvals
  and recorded interventions by urgency and age. Exact own-tool forms support grouped
  text, single-choice and multiple-choice answers, with preserved drafts and durable
  submission receipts shared with task detail. Qualified native single-choice and
  custom requests use their existing runtime delivery path.
- **Task workspace.** Exact source and result revisions, scoped supplied evidence,
  captured context and separate local and GitHub replies. Search covers permitted
  retained tasks, decisions and results, with historical navigation and preserved
  return state.
- **Assignment history.** Assignment pages show captured assistant messages for the
  exact task, assignment and runtime turn. Only completed, sanitized text is
  retained; unfinished messages show progress metadata and omitted text is labelled.
  Known private instructions, credential values and control paths are redacted before
  storage, with current exclusions reapplied when history is read. This is a bounded
  diagnostic view, not a complete transcript or ownership-release proof, and missing
  history does not change admission or completion gates.
- **Settings.** Paused project and profile setup, explicit private replacements,
  source observations, installation capacity and curated recovery.
- **GitHub.** Local discovery of selected repository issues, searches and Projects,
  with provider-owned readiness and dependency holds; operators can inspect and
  refresh source state. Scoped delivery records durable intents, confirmed readback,
  retained PR feedback and operator settlement controls.
- **Operations.** Offline database backup, verification and restore commands, and a
  generated per-user macOS LaunchAgent.

Automated tests with real SQLite and Chromium, plus bounded live Codex and browser
journeys, exercise these surfaces. Dated run records and their limits are in
[`docs/evidence`](docs/evidence/); the
[release-candidate inventory](docs/evidence/release-candidate-inventory.json) maps
each acceptance scenario to its evidence and disposition.

**Not yet qualified**

- **Release and cutover.** Operational release is not qualified. Physical
  sleep/wake behaviour ([#732](https://github.com/chrisbanes/ensemble/issues/732))
  and access from an independent device are unproved. The Haze cutover
  ([#761](https://github.com/chrisbanes/ensemble/issues/761)) is a separate, reviewed
  step ([proposal](docs/operations/standalone-cutover-proposal.md)); the installed
  Haze prototype stays in place until then.
- **Isolation.** Ensemble relies on the execution runtime and host for isolation.
  Broad host-permitted reads remain enabled, and Stop is best-effort: unresolved work
  can remain held for reconciliation. See the
  [execution policy](docs/design/standalone.md#default-execution-policy) and
  [acceptance plan](docs/acceptance.md) for the boundaries and required evidence.
- **Deferred integrations.** Optional ChatGPT daily operations/events and native Codex
  task visibility/handover are deferred until after the standalone MVP. Planning,
  probes and implementation are paused under
  [epic #734](https://github.com/chrisbanes/ensemble/issues/734) until Chris explicitly
  reopens the work; they do not gate release. Their requirements and unproved
  feasibility evidence are retained in
  [ADR-1006](docs/adr/1006-chatgpt-and-native-codex.md) and the
  [integration design](docs/design/chatgpt-and-native-codex.md).

## Development

Use the Node and npm versions pinned in [`.node-version`](.node-version) and
`packageManager` in [`package.json`](package.json). Node 26 is tested for
compatibility (CI job `check-node-26` runs the latest 26.x; 26.9.0 has
[local evidence](docs/evidence/node-26-compatibility-2026-10-09.md)) but is not the
deployment baseline. `engines.node` is `>=24` as permissive metadata; later majors
are not qualified.

```sh
npm ci
npm run check
```

The checks cover types, lint, formatting, compilation and tests, including the
operator's browser tests. `npm run test:fixture-preflight` checks writable temporary
storage, real listeners, browser cleanup and evidence from an expected assertion
failure. Set `ENSEMBLE_TEST_EVIDENCE_DIR` to an absolute, dedicated directory to
retain bounded synthetic screenshots, phase manifests and allowlisted diagnostic
logs. Test deadlines end waiting; they do not prove execution termination or
complete cleanup. Live runtime qualification is a separate, explicit step.

`npm run build` compiles the service and the self-contained React operator assets
into `dist/operator`. The production `operator` command serves `/app` and the
same-origin `/api/operator` JSON from its existing listener; no frontend server is
needed. The interface uses locally owned shadcn/ui components, Dark / Neutral /
Default tokens and self-hosted Geist and Geist Mono. The
[foundation contract](docs/design/ui02-foundation.md) records its projection and
receipt boundary.

See the [development reference](docs/development.md) for commands and service
contracts, or the [macOS operations guide](docs/operations/standalone-macos.md) for
authentication, service management and backups.

## Read further

- [Behavioural specification](docs/SPEC.md): the intended product experience.
- [Standalone design](docs/design/standalone.md): how the service fits together.
- [Architecture decisions](docs/adr/): the choices behind the design.
- [Operator integration](docs/design/s04d-operator-integration.md): runtime and
  coordination controls in the operator interface, and how they are tested.
- [Acceptance plan](docs/acceptance.md): the evidence required for release.
- [Glossary](CONTEXT.md): projects, tasks, assignments and conversations.
- [Agent workflows](docs/agents/): repository contribution conventions.

## License

[Apache-2.0](LICENSE). Taskboard informs the UI design. Dependencies retain their
own licences.
