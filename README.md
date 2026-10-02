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

The current implementation uses **TypeScript, Node.js and SQLite**, with
**Codex App Server** executing agent turns. The first release targets macOS and
a private web interface, using a separate Ensemble login.

The repository already has durable scheduling, task coordination, results and
inboxes, plus authenticated operator pages for inspecting work and responding
to questions and approvals. It also includes offline database backup/restore
commands and macOS service tooling. Automated tests and bounded live Codex and
browser journeys exercise these foundations.

Assignment pages now show captured assistant messages for the exact task,
assignment and runtime turn. Only completed, sanitized text is retained;
unfinished messages show progress metadata, and omitted text is labelled.
Known private instructions, credential values and control paths are redacted
before storage, with current exclusions reapplied when reading history. This is
a bounded diagnostic view, not a complete transcript or ownership-release proof.
Missing history does not change admission or completion gates.

The service now includes local GitHub discovery for selected repository issues,
searches and Projects, with provider-owned readiness and dependency holds.
Operators can inspect source state and refresh it in the authenticated UI.
External GitHub delivery and release cutover remain ahead.
In particular, physical sleep/wake behaviour and
access from an independent device still need qualification. Follow the
[delivery backlog](https://github.com/chrisbanes/ensemble/issues/649) for progress.
The [S05 report](docs/evidence/s05-local-qualification.md) distinguishes completed
bounded routing and journey checks from remaining milestone evidence.
The [S06 report](docs/evidence/s06-github-discovery.md) records passing
deterministic discovery tests and the bounded live fixture qualification.

Ensemble relies on the execution runtime and host for isolation. Broad
host-permitted reads remain enabled, and Stop is best-effort: unresolved work
can remain held for reconciliation. See the
[execution policy](docs/design/standalone.md#default-execution-policy) and
[acceptance plan](docs/acceptance.md) for the boundaries and required evidence.
The existing Haze prototype stays in place until a reviewed cutover.

On 1 October Chris deferred optional ChatGPT daily operations/events and native
Codex task visibility/handover until after the standalone MVP. Planning, probes and
implementation are paused under [epic #734](https://github.com/chrisbanes/ensemble/issues/734)
until Chris explicitly reopens the work. Ensemble's web UI and Codex App Server
execution remain the MVP path; these deferred integrations do not gate release.
Their requirements and unproved feasibility evidence are retained. See
[ADR-1006](docs/adr/1006-chatgpt-and-native-codex.md) and the
[integration design](docs/design/chatgpt-and-native-codex.md).

## Development

Use Node **24.21.0** and npm **12.1.0**, pinned in
[`.node-version`](.node-version) and [`package.json`](package.json):

```sh
npm ci
npm run check
```

The checks cover types, lint, formatting, compilation and tests, including the
operator's browser tests. Live runtime qualification is a separate, explicit
step. See the [development reference](docs/development.md) for commands and
service contracts, or the [macOS operations guide](docs/operations/standalone-macos.md)
for authentication, service management and backups.

## Read further

- [Behavioural specification](docs/SPEC.md): the intended product experience.
- [Standalone design](docs/design/standalone.md): how the service fits together.
- [Architecture decisions](docs/adr/): the choices behind the design.
- [Operator UI and evidence](docs/design/s04d-operator-integration.md): what the current interface supports and what's been tested.
- [Glossary](CONTEXT.md): projects, tasks, assignments and conversations.
- [Agent workflows](docs/agents/): repository contribution conventions.

## License

[Apache-2.0](LICENSE). Taskboard informs the UI design. Dependencies retain their
own licences.

## React operator foundation

`npm run build` compiles the service and self-contained React assets into
`dist/operator`. The production `operator` command serves `/app` and same-origin
`/api/operator` JSON from its existing listener; no frontend server is needed.
The shell implements sign-in/out, project navigation and truthful loading,
stale, error and session states. [UI03](docs/design/ui03-tasks.md) delivers attention
overview, cross-project/project List/Board and a substantial local task composer.
Cards retain existing task detail; Inbox and settings link existing controls.
All existing form routes remain available at `/`.

The [foundation contract](docs/design/ui02-foundation.md) records the strict
projection/receipt boundary and retained-control owners. UI01 native structured
input and UI04–UI07 screen/acceptance work remain separate. This foundation does
not establish release or cutover readiness.
