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
- **Browser notifications.** Opt-in Web Push, turned on per browser in Settings →
  Notifications: one minimal encrypted push per new Inbox alert (a question, an
  approval, an intervention or an exhausted runtime) with a link that opens the exact
  request after sign-in, a test notification, and revocation. It is qualified on the
  host's own browser only; phone delivery is not qualified
  ([#1150](https://github.com/chrisbanes/ensemble/issues/1150)).
- **Settings.** Guided paused-project setup (GitHub discovery of repositories, refs
  and Projects with a typed fallback, a service folder picker and checkout
  verification, one create command) and profile setup, explicit private
  replacements, source observations, installation capacity and curated recovery.
- **GitHub.** Local discovery of selected repository issues, searches and Projects,
  with provider-owned readiness and dependency holds; operators can inspect and
  refresh source state. Scoped delivery records durable intents, confirmed readback,
  retained PR feedback and operator settlement controls.
- **Operations.** `ensemble service install`, `upgrade` and `uninstall` manage a
  per-user macOS LaunchAgent bound to an unpacked release; upgrade stops the job,
  takes a verified snapshot and checks readiness, and a failure leaves the job
  stopped. `service install --mode daemon` is an opt-in LaunchDaemon that starts at
  boot and prints the `sudo` steps to install it; its real-host behavior is unproved. `ensemble snapshot create|verify|restore` provides offline database
  backup, verification and restore
  ([standalone operations](docs/operations/standalone-macos.md)).
- **Operator CLI (authentication, browsing, configuration, diagnostics, task operation, sources, delivery and recovery).** A packaged `ensemble`
  executable logs in to the running service with a revocable read-only or read/write
  credential issued from Settings, manages named connections and browses projects,
  profiles, tasks, assignments, instruction revisions, conversation history, results
  and retained evidence with paged, coverage-reporting reads. It prepares reviewable
  change documents for profile, project, routing and capacity configuration, applies
  their exact command once with a journalled request key, adopts current instructions
  for an assignment's next turn and reads receipts back. It lists task-bound
  executions, shows their captured supplied inputs, observed settings and bounded,
  redacted runtime, tool and service diagnostics, and follows them with resumable
  cursors. It creates and configures tasks and dependencies, sends addressed messages
  and lead follow-ups, lists the attention inbox, answers questions explicitly,
  decides approvals on exact material and requests receipted task Stop and Resume,
  reporting whether each write saved, queued or requested cancellation. It inspects
  and changes a project's GitHub sources through the same reviewed change documents,
  activates a selection after a complete provider read, places conflicting imported
  tasks, inspects and refreshes delivery, and stages issue comments through review,
  confirmation and one receipted send. It shows each held generation's exact identity,
  holds and recovery paths, and submits the existing evidence-bearing adoption,
  recovery and conversation-replacement operations from prepared documents whose
  evidence and attestations the operator states explicitly. A bounded live Codex
  journey through the packaged CLI on this host is recorded in the
  [CLI8 record](docs/evidence/issue-901-cli8-2026-10-12.md); use from a second
  privately connected machine is unproved because none was available. See
  [development](docs/development.md#operator-cli).
- **Claude runtime.** Profiles may select a Claude Code runtime
  ([ADR-1008](docs/adr/1008-claude-code-execution-harness.md)). The operator turns
  each runtime on or off live in Settings → Runtime or with `ensemble runtime`, and
  no runtime is required ([ADR-1012](docs/adr/1012-operator-controlled-runtime-enablement.md));
  new profiles default to the first enabled runtime, Codex first. Bounded live journeys qualified it with limits
  ([evidence](docs/evidence/issue-827-claude-journeys-2026-10-12.md)): a Claude-only
  task, a Codex lead with a Claude worker, Stop and a service crash with explicit
  recovery. Its execution policy and disclosed limits differ from Codex's (see the
  [specification](docs/SPEC.md)), and untested surfaces remain limits. It runs the
  `claude` on the service `PATH` without gating its version. It uses the
  operator's own Claude subscription, and Anthropic's
  [terms](https://code.claude.com/docs/en/legal-and-compliance) do not explicitly
  address a self-hosted single-operator service.
- **Runtime restarts.** An enabled runtime that exits or fails to start is restarted
  automatically after 30 s, 2 min and 10 min, then stops and raises one Inbox item for
  the operator. Held turns stay held; a restart never relaunches or resumes work.

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
- **Packaging.** `scripts/package-release.mjs` builds a self-contained `darwin-arm64`
  release tarball with bundled Node, and a tag-triggered workflow attaches it to a
  GitHub Release ([standalone operations](docs/operations/standalone-macos.md#release-build));
  no release has been published
  ([ADR-1011](docs/adr/1011-packaging-and-distribution.md)).
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
compatibility: `node26-service-*` jobs run service coverage on PRs and main pushes;
`node26-full-compatibility` runs the complete build and Chromium/WebKit suite on
nightlies requiring validation, manual runs and release tags. Both use the latest 26.x; 26.9.0 has
[local evidence](docs/evidence/node-26-compatibility-2026-10-09.md). Node 26 is not
the deployment baseline. `engines.node` is `>=24` as permissive metadata; later
majors are not qualified.

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
- [User flows](docs/user-flows/): first-run and daily operator journeys, each with
  the interaction budget the interface must meet.
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
