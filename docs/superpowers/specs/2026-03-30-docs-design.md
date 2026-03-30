# Ensemble Documentation Design

Date: 2026-03-30

## Goal

Replace the empty README and organize documentation for users who want to install and use Ensemble, with some contributor context. Existing build artifacts (specs, plans, SPEC.md) move to an internal folder.

## Audience

- **Primary:** End users who want to install and run Ensemble to orchestrate agents against their issue tracker.
- **Secondary:** Contributors who want to understand the codebase and submit changes.

## Decisions

- **Docs live in-repo as markdown** (`docs/` folder). A generated site (mdBook or similar) comes later.
- **README-first with linked deep dives** — most users just read the README; deeper topics get their own files.
- **Document what's implemented today** with a roadmap section for what's coming.
- **Install story is Homebrew-first**, cargo build from source as secondary.
- **Build artifacts move to `docs/internal/`** — specs, plans, and SPEC.md are internal reference, not user-facing docs. The `docs/superpowers/` path is an implementation detail of the build tooling and gets cleaned up.

## File Structure

After reorganization:

```
ensemble/
├── README.md                          # Primary entry point
├── CLAUDE.md                          # AI agent conventions (keep)
├── AGENTS.md                          # AI agent conventions (keep)
├── TODO.md                            # Outstanding items (keep)
├── docs/
│   ├── configuration.md              # ensemble.yaml full reference
│   ├── pipelines.md                  # Pipeline concepts and execution model
│   ├── contributing.md               # Brief contributor guide
│   ├── roadmap.md                    # Built / coming / not planned
│   └── internal/                     # Build artifacts and reference specs
│       ├── SPEC.md                   # Full service specification (moved from root)
│       ├── specs/                    # Design specifications (3 files, moved from docs/superpowers/specs/)
│       └── plans/                    # Implementation plans (7 files, moved from docs/superpowers/plans/)
```

## README.md (~150 lines)

The primary entry point. Scannable, not exhaustive.

1. **Tagline** — one sentence: what Ensemble does.
2. **How it works** — 3-4 sentence overview: poll tracker, create workspace, run agents through pipeline, write results back.
3. **Install** — `brew install` (primary), cargo build from source (secondary).
4. **Quick start** — `ensemble init` to scaffold config, show a minimal ensemble.yaml, `ensemble run` to start.
5. **Core concepts** — brief definitions of key moving parts (trackers, agents, pipelines, workspaces, verdicts) with links to deep-dive docs.
6. **Links** — configuration reference, pipeline guide, contributing, roadmap.

No architecture diagrams or deep config details — those live in linked docs.

## docs/configuration.md (~200-250 lines)

The most important deep-dive. ensemble.yaml is how users control everything.

1. **Overview** — what ensemble.yaml does, where it lives, environment variable substitution (`$ENV_VAR`).
2. **Minimal example** — smallest working config.
3. **Full annotated example** — realistic config with comments on every section.
4. **Reference by section:**
   - `tracker` — kind, active/terminal states, backend-specific settings (github, todo_file).
   - `agents` — named agent definitions (executor, model, prompt vs prompt_template).
   - `steps` — pipeline DAG (name, agent, depends, tracker_state).
   - `on_success` / `on_failure` — terminal state transitions.
   - `concurrency` — max_concurrent_agents, max_step_parallelism.
   - `max_cycles` — retry limit.
   - `workspace` — root directory, hooks (after_create, before_run, after_run, before_remove).
5. **Prompt templates** — Liquid syntax, available variables (`issue.*`, `attempt`).

Each field gets: name, type, default (if any), description, and an example where it's not obvious.

## docs/pipelines.md (~120-150 lines)

Explains the mental model of how Ensemble runs work.

1. **Overview** — what a pipeline is (a DAG of steps that runs per-issue).
2. **Steps and agents** — each step invokes a named agent; steps run sequentially by default.
3. **Dependencies and parallelism** — using `depends` to create parallel branches, with a text-based diagram.
4. **Verdicts** — how agents report results (ACP protocol field or `.ensemble/verdict.json` fallback); what approve/reject/error mean.
5. **Retries and cycles** — what happens on reject/failure, max_cycles, exponential backoff.
6. **State transitions** — how Ensemble writes tracker state at step boundaries (dispatched -> in progress -> in review -> done/failed).
7. **Example** — a realistic multi-step pipeline: build agent -> review agent, walking through what happens at each stage.

## docs/contributing.md (~60-80 lines)

Brief — just enough to orient a contributor.

1. **Build and test** — the four commands (cargo build/test/clippy/fmt).
2. **Project structure** — quick map of crates and what they do.
3. **Code conventions** — highlights: thiserror for errors, tokio async, serde for serialization, tracing for logs.
4. **CI** — what runs on PRs, everything must pass.
5. **Where to learn more** — pointer to `docs/internal/SPEC.md` for the full service spec, and `docs/internal/plans/` for implementation history.

Not duplicating CLAUDE.md — translating it for humans.

## docs/roadmap.md (~40-60 lines)

Keeps users informed about what's built and what's next.

1. **What's working today** — bullet list of implemented capabilities (config loading, workspace management, pipeline DAG execution, verdict parsing, init wizard, dashboard, desktop app).
2. **What's coming** — grouped by theme:
   - GitHub Projects tracker integration (full read/write).
   - ACP agent client (stdio JSON-RPC).
   - Orchestrator loop (polling, dispatch, reconciliation).
   - Retry with exponential backoff.
   - Live dashboard streaming via WebSocket.
3. **Not planned** — things from the non-goals list (multi-tenant control plane, general-purpose workflow engine, etc.).

No dates or promises — just "built / coming / not planned."

## Implementation Steps

1. Create `docs/internal/` directory.
2. Move `SPEC.md` to `docs/internal/SPEC.md`.
3. Move `docs/superpowers/specs/` to `docs/internal/specs/`.
4. Move `docs/superpowers/plans/` to `docs/internal/plans/`.
5. Remove empty `docs/superpowers/` directory.
6. Update any references to moved files (CLAUDE.md mentions SPEC.md and docs/superpowers/plans/).
7. Write `README.md`.
8. Write `docs/configuration.md`.
9. Write `docs/pipelines.md`.
10. Write `docs/contributing.md`.
11. Write `docs/roadmap.md`.
