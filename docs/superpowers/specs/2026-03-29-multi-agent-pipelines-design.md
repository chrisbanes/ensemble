# Multi-Agent Pipelines and Tracker Write Support

## Problem

The orchestrator is read-only against issue trackers. All state transitions (moving issues to "In Progress", "Done", "Failed") are delegated to the coding agent. This is fragile: if an agent crashes, the issue state never updates. There is also no support for multi-agent workflows — every issue gets a single agent run with no review step.

## Solution

Three interrelated changes:

1. **Tracker write support** — extend `IssueTracker` trait with write methods so the orchestrator can drive lifecycle state transitions.
2. **Multi-agent pipelines** — new config format (`ensemble.yaml`) defines named agents and a step DAG. The orchestrator executes the pipeline deterministically per issue.
3. **Verdict contract** — review agents signal pass/fail via ACP protocol or a file-based fallback, enabling the orchestrator to branch on agent judgment.

## Design Decisions

- **Flow control is declarative.** The step DAG is defined in YAML, not decided by agents. Agents do the work; the config defines the routing.
- **GitHub Actions-style DAG.** Steps are sequential by default. Explicit `depends` creates parallelism (steps with the same dependencies run concurrently).
- **Orchestrator owns lifecycle transitions.** The orchestrator writes `tracker_state` on step entry, `on_success` when all steps pass, and `on_failure` when any step fails or rejects.
- **Review rejection is terminal.** When a review agent rejects work, the orchestrator moves the issue to a human-attention state and stops. No automatic rework loops.
- **Max cycles bound re-entry.** An issue can re-enter the pipeline at most `max_cycles` times (default 3) before the orchestrator gives up. Re-entry happens when a tracker poll finds an issue back in an active state after a previous pipeline run completed (e.g., a human moved it from "Needs Rework" back to "Todo"). The orchestrator tracks cycle count per issue identifier.
- **Clean break from WORKFLOW.md.** `ensemble.yaml` replaces `WORKFLOW.md` and `ServiceConfig` entirely. No backwards compatibility, no migration tooling.

---

## 1. Config Format: `ensemble.yaml`

Replaces `WORKFLOW.md`. Lives at the repository root (or a configured path).

```yaml
tracker:
  kind: github                          # or "todo_file"
  active_states: ["Todo", "In Progress", "In Review"]
  terminal_states: ["Done", "Closed", "Needs Rework", "Failed"]
  # github-specific
  repository: acme/my-app
  api_key: $GITHUB_TOKEN
  project_number: 7
  # todo_file-specific
  # path: TODO.md

agents:
  builder:
    executor: claude-code
    model: sonnet-4
    prompt_template: prompts/build.md

  reviewer-correctness:
    executor: claude-code
    model: opus-4
    prompt_template: prompts/review-correctness.md

  reviewer-style:
    executor: amp
    model: sonnet-4
    prompt: |
      Review the changes for style and naming conventions.

steps:
  - name: build
    agent: builder
    tracker_state: "In Progress"

  - name: review-correctness
    agent: reviewer-correctness
    depends: [build]
    tracker_state: "In Review"

  - name: review-style
    agent: reviewer-style
    depends: [build]
    tracker_state: "In Review"

on_success: "Done"
on_failure: "Needs Rework"

concurrency:
  max_concurrent_agents: 8       # global cap across all issues
  max_step_parallelism: 3        # per-issue cap on parallel step agents

max_cycles: 3                    # max times an issue re-enters the pipeline
```

### Config Types

```rust
struct EnsembleConfig {
    tracker: TrackerConfig,
    agents: HashMap<String, AgentConfig>,
    steps: Vec<StepConfig>,
    on_success: String,
    on_failure: String,
    concurrency: ConcurrencyConfig,
    max_cycles: u32,  // default: 3
}

struct TrackerConfig {
    kind: String,                         // "github" or "todo_file"
    active_states: Vec<String>,           // default: ["Todo", "In Progress"]
    terminal_states: Vec<String>,         // default: ["Done", "Closed"]
    // todo_file-specific
    path: Option<PathBuf>,                // default: TODO.md
    // github-specific
    endpoint: Option<String>,            // default: https://api.github.com/graphql
    api_key: Option<String>,             // supports $ENV_VAR resolution
    repository: Option<String>,          // owner/repo format
    project_number: Option<i64>,         // enables project board mode
    labels_filter: Vec<String>,          // optional label filtering
}

struct AgentConfig {
    executor: String,
    model: String,
    prompt: Option<String>,           // inline prompt
    prompt_template: Option<PathBuf>, // file reference
}

struct StepConfig {
    name: String,
    agent: String,
    depends: Vec<String>,             // empty = depends on previous step
    tracker_state: Option<String>,
}

struct ConcurrencyConfig {
    max_concurrent_agents: u32,       // default: 4
    max_step_parallelism: u32,        // default: 2
}
```

### Agent Prompt Resolution

Each agent must have exactly one of `prompt` (inline string) or `prompt_template` (path to a markdown file). Prompt templates support Liquid variables: `issue.*` and `attempt`.

---

## 2. Tracker Write Methods

Added to the `IssueTracker` trait with default no-op implementations. Existing read methods are unchanged.

```rust
#[async_trait]
pub trait IssueTracker: Send + Sync {
    // --- existing reads (unchanged) ---
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError>;

    // --- new writes ---
    fn supports_writes(&self) -> bool { false }

    async fn set_issue_state(&self, _id: &str, _state: &str) -> Result<(), TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }

    async fn add_comment(&self, _id: &str, _body: &str) -> Result<(), TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }
}
```

A new `TrackerError::WritesNotSupported` variant is added.

### Backend Implementations

**TodoFileTracker:**
- `supports_writes()` → `true`
- `set_issue_state(id, state)` — parse the file, remove the issue line from its current `## Section`, insert it under the target `## State` heading (creating the heading if it doesn't exist), rewrite the file atomically.
- `add_comment(id, body)` → returns `TrackerError::WritesNotSupported` (no comment concept in a markdown file).

**GithubTracker (project board mode):**
- `supports_writes()` → `true`
- `set_issue_state(id, state)` — GraphQL mutation to update the Status single-select field on the project item.
- `add_comment(id, body)` — GraphQL `addComment` mutation on the issue node.

**GithubTracker (repository mode):**
- `supports_writes()` → `true`
- `set_issue_state(id, state)` — GraphQL mutation to update labels: add the target state label, remove labels matching other active/terminal state names.
- `add_comment(id, body)` — GraphQL `addComment` mutation on the issue node.

### Startup Validation

The pipeline engine calls `supports_writes()` at startup. If the flow has any `tracker_state` entries or `on_success`/`on_failure` transitions, writes are required. Fail fast with a clear error if the tracker cannot support them.

---

## 3. Verdict Contract

Review agents signal pass/fail through two mechanisms, checked in priority order.

### A) ACP Protocol Verdict (preferred)

The agent reports its verdict in the final ACP status event:

```json
{
  "type": "agent_status",
  "status": "completed",
  "verdict": "approve",
  "summary": "All changes follow existing patterns. Test coverage adequate."
}
```

`verdict` field values:
- `"approve"` — step passed.
- `"reject"` — step failed. `summary` explains why.
- Absent or `null` — treated as `"approve"` (backwards compatible; a build agent that exits cleanly is a pass).

### B) File-based Verdict (fallback)

If no verdict in the ACP stream, the orchestrator checks for `.ensemble/verdict.json` in the workspace:

```json
{
  "verdict": "reject",
  "summary": "Function processOrder has no error handling for payment failures."
}
```

Same schema, same field values. The file is optional — if neither ACP nor file provides a verdict, the step is treated as passed.

### Failure vs Rejection

- **Rejection**: agent ran successfully but judged the work insufficient. Represents a quality/review judgment.
- **Failure**: agent crashed, timed out, or errored. Represents an infrastructure or runtime problem.

Both result in the orchestrator writing `on_failure` to the tracker, but they are distinguished in `StepState` for observability.

---

## 4. Pipeline Engine

New `pipeline` module that owns DAG execution for each issue.

### DAG Construction

At startup, parse `steps` into a directed acyclic graph. Validation:
- All `agent` references exist in the `agents` map.
- All `depends` references point to valid step names.
- No cycles in the graph.
- At least one root step (no dependencies).

Implicit sequential rule: the first step in the list has no implicit dependency (it is a root). Each subsequent step that omits `depends` implicitly depends on the step directly before it in the list. A step that explicitly sets `depends` overrides this — its dependencies are exactly what it declares.

### Per-Issue Execution State

```rust
struct PipelineRun {
    issue_id: String,
    cycle: u32,                              // current cycle (1..max_cycles)
    step_states: HashMap<String, StepState>,  // step name → state
}

enum StepState {
    Pending,
    Running { session_id: String },
    Passed,
    Rejected { summary: String },
    Failed { error: String },
}
```

### Execution Flow (per issue)

1. Orchestrator picks up issue from tracker, creates `PipelineRun` at cycle 1.
2. Find all root steps (no unmet dependencies) → dispatch agents, respecting `max_step_parallelism`.
3. Write `tracker_state` to the tracker on step entry. If multiple parallel steps share the same `tracker_state`, write it once.
4. When an agent exits, collect verdict: check ACP first, fall back to `.ensemble/verdict.json`.
5. If step passed → mark `Passed`, find newly unblocked steps (all dependencies met), dispatch them.
6. If step rejected or failed → mark accordingly, halt the pipeline, write `on_failure` state to tracker.
7. When all steps are `Passed` → write `on_success` state to tracker.

### Concurrency Enforcement

Two levels:
- **Global**: `max_concurrent_agents` bounds total agent processes across all issues. Enforced via a global semaphore.
- **Per-issue**: `max_step_parallelism` bounds concurrent agents within a single issue's pipeline. Enforced via a per-issue counter.

Before dispatching any agent, both limits are checked. If either is hit, the step stays `Pending` and is retried when a slot frees up.

---

## 5. Module Structure

```
crates/ensemble-core/src/
├── lib.rs
├── error.rs                      # + PipelineError variants
├── tracker/
│   ├── mod.rs                    # IssueTracker trait (+ write methods, WritesNotSupported)
│   ├── model.rs                  # Issue, etc. (unchanged)
│   ├── todo_file.rs              # + set_issue_state implementation
│   └── github.rs                 # + set_issue_state, add_comment implementations
├── config/
│   ├── ensemble.rs               # NEW: EnsembleConfig parsing from ensemble.yaml
│   └── template.rs               # Liquid prompt renderer (reused)
├── pipeline/
│   ├── mod.rs                    # NEW: re-exports
│   ├── dag.rs                    # NEW: DAG construction + cycle detection + validation
│   ├── engine.rs                 # NEW: PipelineRun execution loop
│   └── verdict.rs                # NEW: verdict parsing (ACP field + file fallback)
└── workspace/
    ├── manager.rs                # unchanged
    └── hooks.rs                  # unchanged
```

### Removed

- `config/workflow.rs` — WORKFLOW.md loader (replaced by `ensemble.yaml`)
- `config/typed.rs` — ServiceConfig (replaced by `EnsembleConfig`)

### Added

- `config/ensemble.rs` — parses `ensemble.yaml` into `EnsembleConfig`
- `pipeline/dag.rs` — builds and validates the step DAG
- `pipeline/engine.rs` — drives `PipelineRun` execution per issue
- `pipeline/verdict.rs` — reads verdicts from ACP events or `.ensemble/verdict.json`

### Modified

- `tracker/mod.rs` — add default write methods, `WritesNotSupported` error variant, update `create_tracker` signature
- `tracker/todo_file.rs` — implement `set_issue_state` (file rewrite)
- `tracker/github.rs` — implement `set_issue_state` (GraphQL mutation), `add_comment`
- `error.rs` — add `PipelineError` enum

---

## 6. Error Handling

New error types:

```rust
#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error("unknown agent reference: {name}")]
    UnknownAgent { name: String },

    #[error("unknown step dependency: {step} depends on {dependency}")]
    UnknownDependency { step: String, dependency: String },

    #[error("cycle detected in step graph")]
    CycleDetected,

    #[error("no root steps found (all steps have dependencies)")]
    NoRootSteps,

    #[error("step {step} requires tracker writes but tracker does not support them")]
    WritesRequired { step: String },

    #[error("max cycles ({max}) exceeded for issue {issue_id}")]
    MaxCyclesExceeded { issue_id: String, max: u32 },

    #[error("agent must have exactly one of 'prompt' or 'prompt_template', got neither or both: {agent}")]
    InvalidPromptConfig { agent: String },
}
```

New tracker error variant:

```rust
#[error("tracker does not support write operations")]
WritesNotSupported,
```
