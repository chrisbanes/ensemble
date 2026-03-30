# Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create user-facing documentation for Ensemble — README, configuration reference, pipeline guide, contributing guide, and roadmap — and reorganize existing docs.

**Architecture:** README-first approach with linked deep-dive docs. README covers install, quick start, and core concepts. Separate files for configuration reference (the most detailed doc), pipeline concepts, contributing, and roadmap. SPEC.md moves from repo root to `docs/`.

**Tech Stack:** Markdown files in `docs/` directory. No build tooling — plain markdown for now.

**Spec:** `docs/superpowers/specs/2026-03-30-docs-design.md`

---

### Task 1: Move SPEC.md and Update References

**Files:**
- Move: `SPEC.md` → `docs/SPEC.md`
- Modify: `CLAUDE.md:5`
- Modify: `AGENTS.md:5`

- [ ] **Step 1: Move SPEC.md to docs/**

```bash
git mv SPEC.md docs/SPEC.md
```

- [ ] **Step 2: Update CLAUDE.md reference**

In `CLAUDE.md`, line 5, change:

```
See `SPEC.md` for the full specification. See `docs/superpowers/plans/` for implementation plans.
```

to:

```
See `docs/SPEC.md` for the full specification. See `docs/superpowers/plans/` for implementation plans.
```

- [ ] **Step 3: Update AGENTS.md reference**

In `AGENTS.md`, line 5, make the same change:

```
See `docs/SPEC.md` for the full specification. See `docs/superpowers/plans/` for implementation plans.
```

- [ ] **Step 4: Verify no other files reference `SPEC.md` at root**

```bash
grep -r '"SPEC.md"\|`SPEC.md`\| SPEC\.md' --include='*.md' . | grep -v docs/SPEC.md | grep -v docs/superpowers/
```

Expected: No results (or only the files we already updated).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/SPEC.md
git commit -m "docs: move SPEC.md to docs/ and update references"
```

---

### Task 2: Write README.md

**Files:**
- Create: `README.md` (replaces the existing empty one)

- [ ] **Step 1: Write README.md**

```markdown
# Ensemble

Ensemble is a service that orchestrates coding agents against your issue tracker. It polls for work, creates isolated workspaces, runs agents through a configurable pipeline, and writes results back to the tracker.

## How it works

Ensemble reads issues from a tracker (GitHub Projects or a local TODO file), creates a workspace directory for each one, and runs a pipeline of named agents against it. Each agent gets a prompt rendered from the issue context. Agents report verdicts (approve/reject), and Ensemble transitions the issue state accordingly. Failed issues retry with exponential backoff.

All behavior is configured in a single `ensemble.yaml` file that lives in your repository.

## Install

```sh
brew install ensemble
```

Or build from source:

```sh
git clone https://github.com/anthropics/ensemble.git
cd ensemble
cargo install --path crates/ensemble-cli
```

## Quick start

**1. Create a config file:**

```sh
ensemble init
```

This walks you through setting up your tracker, agents, and pipeline. It generates an `ensemble.yaml` and any prompt templates you need.

**2. Or write one by hand:**

```yaml
tracker:
  kind: todo_file
  path: TODO.md

agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid

steps:
  - name: build
    agent: builder

on_success: Done
on_failure: Failed
```

**3. Run:**

```sh
ensemble run
```

Ensemble polls the tracker, picks up eligible issues, and runs them through the pipeline.

To also start the dashboard:

```sh
ensemble run --port 3000
```

Then open `http://localhost:3000` in your browser.

## Core concepts

**Trackers** connect Ensemble to your issue source. Supported: GitHub Projects (`github`) and local TODO files (`todo_file`). The tracker defines which states are active (pollable) and terminal (done).

**Agents** are named definitions that pair an executor (like `claude-code`) with a prompt. Prompts can be inline strings or [Liquid](https://shopify.github.io/liquid/) template files with access to issue context.

**Pipelines** are a DAG of steps, each referencing an agent. Steps run sequentially by default. Use `depends` to create parallel branches. See [Pipeline Guide](docs/pipelines.md).

**Workspaces** are isolated directories created per-issue. They persist across retries and get cleaned up when the issue reaches a terminal state. Shell hooks run at lifecycle points (create, before/after run, remove).

**Verdicts** are how agents report results. An agent can approve (step passes) or reject with a summary (step fails). Ensemble reads verdicts from the ACP protocol or a `.ensemble/verdict.json` file in the workspace.

## Documentation

- [Configuration Reference](docs/configuration.md) — every `ensemble.yaml` field
- [Pipeline Guide](docs/pipelines.md) — steps, DAGs, verdicts, retries
- [Contributing](docs/contributing.md) — building, testing, project structure
- [Roadmap](docs/roadmap.md) — what's built, what's coming
```

- [ ] **Step 2: Review the README for accuracy**

Read through it once. Verify:
- The `ensemble init` and `ensemble run` commands match the CLI (`crates/ensemble-cli/src/main.rs`)
- The minimal YAML example uses valid fields per `EnsembleConfig`
- The concept definitions match the actual implementation

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: write user-facing README with install, quick start, and concepts"
```

---

### Task 3: Write docs/configuration.md

**Files:**
- Create: `docs/configuration.md`

This is the longest doc. It references every field from `EnsembleConfig` in `crates/ensemble-core/src/config/ensemble.rs`.

- [ ] **Step 1: Write docs/configuration.md**

```markdown
# Configuration Reference

Ensemble is configured through a single `ensemble.yaml` file, typically at the root of your repository.

## Environment variables

Any string value can reference an environment variable with `$VAR_NAME` syntax. Ensemble resolves these at load time. Path values (`~`, `$HOME`) are also expanded.

```yaml
tracker:
  api_key: $GITHUB_TOKEN
workspace:
  root: ~/ensemble-workspaces
```

## Minimal example

The smallest working config uses a local TODO file and a single agent:

```yaml
tracker:
  kind: todo_file
  path: TODO.md

agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Fix the issue described above."

steps:
  - name: build
    agent: build

on_success: Done
on_failure: Failed
```

## Full example

A realistic config with GitHub Projects, multiple agents, hooks, and tuned concurrency:

```yaml
tracker:
  kind: github
  repository: acme/my-repo
  api_key: $GITHUB_TOKEN
  project_number: 42
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  labels_filter:
    - ensemble

repos:
  - path: /home/dev/my-repo
    branch: main

agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
  reviewer:
    executor: claude-code
    model: claude-opus-4-6
    prompt_template: templates/review.liquid

steps:
  - name: build
    agent: builder
    tracker_state: Building
  - name: review
    agent: reviewer
    depends:
      - build
    tracker_state: In Review

on_success: Done
on_failure: Failed

concurrency:
  max_concurrent_agents: 8
  max_step_parallelism: 4

max_cycles: 3

workspace:
  root: ~/ensemble-workspaces

hooks:
  after_create: "git checkout -b ensemble/$ISSUE_ID"
  before_run: "npm install"
  timeout_ms: 120000

polling:
  interval_ms: 30000

agent:
  max_turns: 20
  turn_timeout_ms: 3600000
```

## Reference

### tracker

Defines where Ensemble reads and writes issues.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kind` | string | *required* | Tracker backend: `"github"` or `"todo_file"` |
| `active_states` | list of strings | `["Todo", "In Progress"]` | States that make issues eligible for dispatch |
| `terminal_states` | list of strings | `["Done", "Closed"]` | States that mean an issue is finished |

**GitHub-specific fields** (when `kind: github`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `repository` | string | — | GitHub repo in `owner/name` format |
| `api_key` | string | — | GitHub token (use `$GITHUB_TOKEN`) |
| `project_number` | integer | — | GitHub Projects v2 project number |
| `endpoint` | string | — | Custom GitHub API endpoint (for GitHub Enterprise) |
| `labels_filter` | list of strings | `[]` | Only process issues with these labels |

**Todo file fields** (when `kind: todo_file`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | — | Path to the TODO markdown file |

### repos

List of repositories for workspace setup.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | *required* | Path to repository (supports `$VAR` and `~`) |
| `branch` | string | *required* | Branch name to work on |

### agents

Named agent definitions. Each key is the agent name referenced by steps.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `executor` | string | — | Agent executable (e.g., `"claude-code"`) |
| `model` | string | — | Model identifier (e.g., `"claude-opus-4-6"`) |
| `acpx_agent` | string | — | ACPX agent name (alternative to executor+model) |
| `prompt` | string | — | Inline prompt text |
| `prompt_template` | string | — | Path to a Liquid template file |

**Validation rules:**
- Provide either `acpx_agent` alone, or both `executor` and `model`.
- Provide either `prompt` (inline) or `prompt_template` (file), not both.

### steps

Pipeline step definitions. Each step invokes one agent.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | *required* | Unique step identifier |
| `agent` | string | *required* | Name of an agent defined in `agents` |
| `depends` | list of strings | — | Steps this depends on. Omit for sequential order. Use `[]` for no dependencies (root step). |
| `tracker_state` | string | — | Tracker state to write when this step starts |

See [Pipeline Guide](pipelines.md) for details on DAG construction and execution.

### on_success / on_failure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `on_success` | string | *required* | Tracker state when all pipeline steps pass |
| `on_failure` | string | *required* | Tracker state when any step fails or rejects |

### concurrency

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_concurrent_agents` | integer | `4` | Maximum parallel agent runs across all issues |
| `max_step_parallelism` | integer | `2` | Maximum parallel steps within a single issue's pipeline |

### max_cycles

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_cycles` | integer | `3` | Maximum times an issue re-enters the pipeline after failure |

### workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `root` | string | system temp dir | Root directory for per-issue workspace directories (supports `$VAR` and `~`) |

### hooks

Shell scripts that run at workspace lifecycle points. Each runs via `sh -lc` with the workspace directory as CWD.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `after_create` | string | — | Runs after a workspace directory is created for the first time |
| `before_run` | string | — | Runs before each agent session starts |
| `after_run` | string | — | Runs after each agent session completes |
| `before_remove` | string | — | Runs before a workspace is cleaned up |
| `timeout_ms` | integer | `60000` | Maximum time for any hook to run (milliseconds) |

### polling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `interval_ms` | integer | `30000` | How often to poll the tracker for new issues (milliseconds) |

### agent

Runtime settings for agent execution.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_turns` | integer | `20` | Maximum agent conversation turns per session |
| `max_retry_backoff_ms` | integer | `300000` | Cap on exponential backoff delay between retries |
| `command` | string | `"claude-code"` | Agent binary command |
| `session_mode` | string | `"code"` | Agent session mode |
| `permission_policy` | string | `"auto_approve_all"` | Agent permission policy |
| `turn_timeout_ms` | integer | `3600000` | Maximum time for a single agent turn (1 hour) |
| `read_timeout_ms` | integer | `5000` | Timeout for reading agent output |
| `stall_timeout_ms` | integer | `300000` | Timeout for detecting a stalled agent |

## Prompt templates

Prompt templates use [Liquid](https://shopify.github.io/liquid/) syntax. Available variables:

| Variable | Type | Description |
|----------|------|-------------|
| `issue.id` | string | Tracker-internal issue ID |
| `issue.identifier` | string | Human-readable key (e.g., `repo#42`) |
| `issue.title` | string | Issue title |
| `issue.description` | string or nil | Issue body text |
| `issue.priority` | integer or nil | Priority level |
| `issue.state` | string | Current tracker state |
| `issue.labels` | array of strings | Issue labels |
| `issue.branch_name` | string or nil | Associated branch |
| `issue.url` | string or nil | Issue URL |
| `attempt` | integer or nil | Retry attempt number (nil on first run) |

**Example template** (`templates/implement.liquid`):

```liquid
You are working on issue {{ issue.identifier }}: {{ issue.title }}

{% if issue.description %}
## Issue Description

{{ issue.description }}
{% endif %}

{% if attempt %}
This is retry attempt {{ attempt }}. Review previous work in the workspace and fix any issues.
{% endif %}

## Instructions

Implement the changes described above. Run tests before finishing.
```
```

- [ ] **Step 2: Verify field accuracy**

Spot-check the field tables against `EnsembleConfig` in `crates/ensemble-core/src/config/ensemble.rs`:
- Every struct field should appear in the reference
- Default values should match `serde(default)` annotations
- Types should match the Rust types

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: add ensemble.yaml configuration reference"
```

---

### Task 4: Write docs/pipelines.md

**Files:**
- Create: `docs/pipelines.md`

- [ ] **Step 1: Write docs/pipelines.md**

```markdown
# Pipeline Guide

A pipeline is a directed acyclic graph (DAG) of steps that Ensemble runs for each issue. Each step invokes a named agent, collects a verdict, and decides what happens next.

## Steps and agents

Each step references an agent defined in `ensemble.yaml`:

```yaml
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid

steps:
  - name: build
    agent: builder
```

When a step runs, Ensemble:
1. Renders the agent's prompt template with the issue context
2. Launches the agent in the issue's workspace directory
3. Waits for the agent to finish
4. Collects a verdict (approve or reject)

## Sequential and parallel steps

**Sequential (default):** Steps run one after another in list order. Each step implicitly depends on the one before it.

```yaml
steps:
  - name: build      # runs first
    agent: builder
  - name: test       # runs after build
    agent: tester
  - name: review     # runs after test
    agent: reviewer
```

**Parallel:** Use `depends` to create branches. Steps with the same dependencies run in parallel.

```yaml
steps:
  - name: build
    agent: builder
    depends: []           # root step — no dependencies
  - name: lint
    agent: linter
    depends: []           # also a root step — runs parallel to build
  - name: review
    agent: reviewer
    depends:
      - build             # waits for both build and lint
      - lint
```

This creates:

```
build ──┐
        ├──> review
lint  ──┘
```

The `depends` field overrides the default sequential behavior:
- Omit `depends` → depends on the previous step in the list
- `depends: []` → no dependencies (root step, starts immediately)
- `depends: [step1, step2]` → waits for the named steps

## Tracker state transitions

Steps can optionally write a tracker state when they start:

```yaml
steps:
  - name: build
    agent: builder
    tracker_state: Building
  - name: review
    agent: reviewer
    tracker_state: In Review
```

When the full pipeline completes, Ensemble writes `on_success` or `on_failure` to the tracker.

A typical lifecycle looks like:

```
Todo → Building → In Review → Done
                            → Failed
```

## Verdicts

After an agent finishes, Ensemble checks for a verdict:

1. **ACP protocol** — the agent reports a verdict in its session response (preferred)
2. **File fallback** — the agent writes `.ensemble/verdict.json` in the workspace:

```json
{
  "verdict": "approve"
}
```

or:

```json
{
  "verdict": "reject",
  "summary": "Tests are failing — 3 test cases need fixes"
}
```

3. **Default** — if no verdict is found, the step is treated as approved

**Approve** means the step passed. The pipeline moves to the next step (or completes).

**Reject** means the step failed. The `summary` field explains why. Ensemble transitions the issue to `on_failure` state, or retries if cycles remain.

## Retries and cycles

When a step rejects or an agent errors out, Ensemble can retry the entire pipeline. The `max_cycles` setting controls how many times:

```yaml
max_cycles: 3  # default
```

- Cycle 1: Initial run
- Cycle 2: First retry (if cycle 1 failed)
- Cycle 3: Second retry (if cycle 2 failed)
- After cycle 3: Issue moves to `on_failure` state

Retries use exponential backoff: 10s, 20s, 40s, ... capped at `agent.max_retry_backoff_ms` (default 5 minutes).

The workspace persists across retries, so agents can see previous work and build on it. The `attempt` variable is available in prompt templates for retry-aware prompts.

## Example: build + review pipeline

A common pattern: one agent implements, another reviews.

```yaml
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
  reviewer:
    executor: claude-code
    model: claude-opus-4-6
    prompt_template: templates/review.liquid

steps:
  - name: implement
    agent: builder
    tracker_state: In Progress
  - name: review
    agent: reviewer
    tracker_state: In Review

on_success: Done
on_failure: Needs Rework
max_cycles: 3
```

What happens:

1. Ensemble polls the tracker and finds an issue in "Todo" state
2. Creates a workspace directory for the issue
3. Runs the `implement` step — builder agent gets the issue context, writes code
4. Builder approves → runs the `review` step — reviewer agent checks the work
5. Reviewer approves → issue moves to "Done"
6. If reviewer rejects → issue moves to "Needs Rework", retries from step 1 on next cycle
```

- [ ] **Step 2: Commit**

```bash
git add docs/pipelines.md
git commit -m "docs: add pipeline guide with steps, DAGs, verdicts, and retries"
```

---

### Task 5: Write docs/contributing.md

**Files:**
- Create: `docs/contributing.md`

- [ ] **Step 1: Write docs/contributing.md**

```markdown
# Contributing

## Build and test

Ensemble is a Rust workspace. You need Rust 1.80+ installed.

```sh
cargo build --workspace          # compile
cargo test --workspace           # run all tests
cargo clippy --workspace -- -D warnings   # lint
cargo fmt --all -- --check       # check formatting
```

Run all four before pushing — CI enforces them.

## Project structure

```
ensemble/
├── crates/
│   ├── ensemble-core/     # Core library — domain model, config, tracker, pipeline,
│   │                      # orchestrator, workspace, agent, API
│   ├── ensemble-cli/      # CLI binary — `ensemble init` and `ensemble run`
│   ├── ensemble-ui/       # React dashboard (Vite + TypeScript + Tailwind)
│   └── ensemble-desktop/  # Tauri desktop wrapper
```

**ensemble-core** contains most of the logic:

| Module | Purpose |
|--------|---------|
| `config/` | `ensemble.yaml` parsing, prompt template rendering |
| `tracker/` | `IssueTracker` trait + GitHub and todo_file backends |
| `pipeline/` | DAG construction, step execution, verdict parsing |
| `orchestrator/` | Poll loop, dispatch, retry, reconciliation |
| `workspace/` | Directory management, lifecycle hooks |
| `agent/` | ACP client for stdio agent communication |
| `api/` | REST endpoints (axum) + WebSocket streaming |

## Code conventions

- **Error handling:** `thiserror` enums with `?` propagation. No `.unwrap()` in library code.
- **Async:** `tokio` runtime. Async tests use `#[tokio::test]`.
- **Serialization:** `serde` + `serde_yaml` for config, `serde_json` for domain types.
- **Logging:** `tracing` crate with structured fields.
- **Tests:** Unit tests in `#[cfg(test)] mod tests` within each file. Integration tests in `crates/*/tests/`. Use `tempfile` for filesystem tests.

## CI

GitHub Actions runs on push to `main` and all PRs. Four parallel jobs: check, test, clippy, fmt. All must pass. `RUSTFLAGS=-Dwarnings` is set globally.

## Further reading

- [docs/SPEC.md](SPEC.md) — full service specification (language-agnostic)
- [docs/superpowers/plans/](superpowers/plans/) — implementation plans used to build the codebase
```

- [ ] **Step 2: Commit**

```bash
git add docs/contributing.md
git commit -m "docs: add contributing guide"
```

---

### Task 6: Write docs/roadmap.md

**Files:**
- Create: `docs/roadmap.md`

- [ ] **Step 1: Write docs/roadmap.md**

```markdown
# Roadmap

## What's working today

- **Configuration** — `ensemble.yaml` loader with typed config, environment variable resolution, and validation
- **Trackers** — GitHub Projects v2 (full GraphQL read/write) and local TODO file backends
- **Pipelines** — DAG-based step execution with sequential and parallel steps
- **Verdicts** — ACP protocol and `.ensemble/verdict.json` file fallback
- **Agents** — ACP client over stdio (JSON-RPC 2.0) for agent communication
- **Orchestrator** — Poll-dispatch-reconcile loop with state management and retry logic
- **Workspaces** — Per-issue directory isolation with lifecycle hooks
- **API** — REST endpoints (axum) with OpenAPI spec generation
- **Live streaming** — WebSocket endpoint for real-time pipeline events
- **Dashboard** — React SPA with issue overview, detail views, and history
- **Init wizard** — `ensemble init` interactive setup with agent discovery
- **Desktop app** — Tauri 2 scaffold

## What's coming

- **CLI orchestrator wiring** — the orchestrator loop is implemented but not yet spawned by `ensemble run` (it's the last integration step)
- **Desktop integration** — connecting the Tauri shell to ensemble-core so the desktop app starts the orchestrator and serves the dashboard
- **Homebrew distribution** — `brew install ensemble`

## Not planned

These are explicitly out of scope:

- Multi-tenant control plane or SaaS hosting
- General-purpose workflow engine or distributed job scheduler
- Built-in business logic for editing tickets, PRs, or comments (that's the agent's job)
- Mandating a single sandbox or approval policy (left to the deployment environment)
```

- [ ] **Step 2: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: add roadmap — what's built, coming, and not planned"
```

---

### Task 7: Final Review

- [ ] **Step 1: Verify all docs are in place**

```bash
ls -la README.md docs/SPEC.md docs/configuration.md docs/pipelines.md docs/contributing.md docs/roadmap.md
```

Expected: All six files exist.

- [ ] **Step 2: Verify links work**

Check that cross-references between docs use correct relative paths:
- README.md links to `docs/configuration.md`, `docs/pipelines.md`, `docs/contributing.md`, `docs/roadmap.md`
- contributing.md links to `SPEC.md` and `superpowers/plans/` (relative to `docs/`)
- configuration.md links to `pipelines.md` (relative to `docs/`)

- [ ] **Step 3: Verify SPEC.md is no longer at repo root**

```bash
test ! -f SPEC.md && echo "OK: SPEC.md removed from root" || echo "FAIL: SPEC.md still at root"
```

Expected: `OK: SPEC.md removed from root`

- [ ] **Step 4: Verify CLAUDE.md and AGENTS.md reference docs/SPEC.md**

```bash
grep 'docs/SPEC.md' CLAUDE.md AGENTS.md
```

Expected: Both files match.
