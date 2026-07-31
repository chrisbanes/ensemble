# Ensemble Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define CI for autonomous coding agents: a service that turns issue-tracker work into
repeatable, observable, config-driven agent pipelines.

## 1. Problem Statement

Ensemble runs agent workflows for tickets and provides a control room for supervising interactive
execution. External trackers may provide tickets, but Ensemble owns live execution state. The product
model is closer to CI than to a replacement project-management system: tracker issues are inputs,
pipeline steps are gates, isolated workspaces are build environments, and structured step outputs
drive deterministic transitions.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts or one-off
  agent sessions.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps workflow policy in a configuration directory (`config.yaml` plus prompt templates) so
  teams can version agent prompts, delivery gates, and runtime settings together.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations may target trusted environments with a high-trust configuration, while others may
require stricter approvals or sandboxing.

Important boundary:

- Ensemble is a scheduler/runner that both reads and writes issue tracker state for lifecycle
  transitions.
- The orchestrator writes tracker state at pipeline step boundaries: marking issues "In Progress"
  on dispatch, "In Review" during review steps, "Done" on success, and "Failed"/"Needs Rework" on
  failure. These transitions are driven by the declarative pipeline config, not by agent decisions.
- Rich ticket writes (comments, PR links, code review responses) remain the agent's responsibility
  using tools available in the workflow/runtime environment.
- A successful run may end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a configuration-directory `config.yaml` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support restart recovery without requiring a persistent database.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Config Loader`
   - Resolves the configuration directory and reads `<config_dir>/config.yaml`.
   - Parses tracker config, agent definitions, step DAG, and prompt references.
   - Returns `EnsembleConfig`.

2. `Config Layer`
   - Exposes typed getters for config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Writes issue state transitions at pipeline step boundaries.
   - Optionally adds comments to issues.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Pipeline Engine`
   - Builds a step DAG from `config.yaml` step definitions.
   - Executes pipeline steps per issue, dispatching agents and collecting validated `StepOutput`
     results.
   - Drives tracker state transitions at step boundaries.
   - Enforces concurrency limits (global and per-issue).

6. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Optionally creates git worktrees for configured repositories via `WorktreeCoordinator`.
   - All-or-nothing worktree creation with rollback on partial failure.
   - Worktrees stored under the per-issue workspace, one directory per configured repository, with
     branch naming `ensemble-YYYY-MM-DD-<sanitized-issue-id>`.
   - Reuses existing worktrees on retry cycles (pulls latest changes).
   - Runs workspace lifecycle hooks.
   - Cleans workspaces and worktrees for terminal issues.
   - Per-repo `finalize` settings control branch publication behavior after pipeline success.
     Finalization defaults to `none`; durable run artifacts are still recorded even when no branch
     is pushed and no pull request is opened.

7. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + agent-specific template.
   - Launches the coding agent via ACP over stdio from a structured command; implementations should
     avoid shell interpolation for agent command arguments.
   - Streams agent updates back to the orchestrator.
   - Runs a hidden extraction turn in the same runtime session and collects a validated `StepOutput`.

8. `Status Surface` (optional)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

9. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Ensemble is easiest to port when kept in these layers:

1. `Policy Layer` (configuration-directory-defined)
   - `config.yaml` agent definitions, step DAG, and prompt templates in the config directory.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses `config.yaml` into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, coding-agent protocol.

5. `Integration Layer` (GitHub adapter)
   - API calls and normalization for tracker data.

6. `Observability Layer` (logs + optional status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (GitHub and/or Notion depending on `tracker.kind`).
- Local filesystem for workspaces and logs.
- Optional workspace population tooling (for example Git CLI, if used).
- Coding-agent executable that speaks the Agent Client Protocol (ACP) over stdio (JSON-RPC 2.0,
  line-delimited).
- Host environment authentication for the issue tracker and coding agent.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Ensemble Config

Parsed `config.yaml` payload:

- `tracker` (TrackerConfig)
  - Tracker kind, active/terminal states, and backend-specific settings.
- `agents` (map of string to AgentConfig)
  - Named agent definitions with executor, model, and prompt (inline or file reference).
- `steps` (list of StepConfig)
  - Pipeline step DAG. Each step references an agent and optionally declares dependencies.
- `on_success` (string)
  - Terminal tracker state when all pipeline steps pass.
- `on_failure` (string)
  - Terminal tracker state when any pipeline step fails.
- `concurrency` (ConcurrencyConfig)
  - `max_concurrent_agents` (global cap) and `max_step_parallelism` (per-issue cap).
- `max_cycles` (integer, default 3)
  - Maximum pipeline cycle number an issue can enter. Scheduler deferrals do not consume cycles.

#### 4.1.3 Agent Config

Per-agent configuration within `config.yaml`:

- `runtime` (string or null) — optional runtime override (`acpx` or `direct`).
- `acpx_agent` (string or null) — acpx agent name used for launch-time agent selection.
- `executor` (string) — ACP-compatible agent executable identifier.
- `model` (string) — model to use for the agent.
- `permission_mode` (string or null) — optional acpx launch-time permission mode for `acpx_agent`
  (`approve_all`, `approve_reads`, `deny_all`).
- `reasoning_level` (string or null) — optional reasoning/thinking level for agents that support it.
- `prompt` (string or null) — inline prompt text.
- `prompt_template` (path or null) — file reference to a Markdown prompt template.
- Exactly one of `prompt` or `prompt_template` must be set.

#### 4.1.4 Step Config

Pipeline step definition:

- `name` (string) — unique step identifier.
- `agent` (string) — references a named agent from `agents`.
- `kind` (string, optional, default `"agent"`)
  - `"agent"` — normal agent-backed step.
  - `"synthesis"` — agent-backed step intended to merge or adjudicate direct dependency outputs.
  Synthesis steps must declare `depends` explicitly.
- `depends` (list of strings, optional) — step names this step depends on. If omitted, the step
  implicitly depends on the step directly before it in the list. The first step has no implicit
  dependency. Explicit `depends` overrides the implicit rule.
- `tracker_state` (string, optional) — tracker state to write on step entry.
- `timeout_ms` (integer, optional)
  - Maximum time in milliseconds for each runtime prompt or turn associated with this step.
  - Defaults to `agent.turn_timeout_ms` when omitted.
  - Must be greater than `0` when present.
- `approval` (StepApprovalConfig, optional) — post-step approval gate:

  - `mode` (string) — `always` or `when_requested_by_agent`. The latter waits for the agent to
    request approval via `.ensemble/approval-request.json`.
  - `state` (string, optional) — tracker state to mirror while waiting for approval. If set, the
    issue's tracker state is updated to this value during the approval hold.

#### 4.1.5 Workspace

Filesystem workspace assigned to one immutable issue identity.

Fields (logical):

- `path` (workspace path; current runtime typically uses absolute paths, but relative roots are
  possible if configured without path separators)
- `workspace_key` (bounded readable issue-ID prefix plus a stable identity digest)
- `issue_id` (persisted ownership authority) and `issue_identifier` (persisted display metadata)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.6 Pipeline Run

Per-issue pipeline execution state:

- `issue_id` (string)
- `cycle` (integer, 1-based) — which pipeline cycle this is (bounded by `max_cycles`)
- `step_states` (map of step name to StepState)

Step states:

- `Pending` — not yet started
- `Running` — agent dispatched, session active
- `AwaitingApproval` — step completed but blocked on an approval gate. The orchestrator
  holds the pipeline here until a `approve_gate` or `reject_gate` signal is received.
- `Passed` — agent exited successfully with a `succeeded` or `concern` result, or was approved at
  an approval gate
- `Rejected` — agent exited successfully with a `failed` result, or was rejected at an approval gate
- `Failed` — agent crashed, timed out, or errored

**Post-step approval checkpoints:** When a step succeeds and has `approval` configured, the
orchestrator may enter `AwaitingApproval` instead of immediately dispatching downstream work. The
orchestrator updates the issue tracker state to `approval.state` (if set) and waits. On
`approve_gate`: the step transitions to `Passed` and downstream steps are dispatched. On
`reject_gate`: the step transitions to `Rejected` and the pipeline falls back to `on_failure`. The
`Rejected` transition does not write a separate rejection state — it is treated as a failure in the
`on_failure` sense.

Pipeline run recovery:

- Ensemble appends pipeline transition records to
  `<config_dir>/state/pipeline-runs/<encoded_issue_id>.jsonl`.
- Each recoverable transition includes a full `PipelineRun` snapshot.
- On orchestrator startup, Ensemble restores the latest non-released snapshot for each issue before
  the first poll tick.
- During normal tick dispatch, before starting a candidate as a fresh pipeline, Ensemble checks that
  issue's latest journal record. If it is live and contains a snapshot, Ensemble restores that run
  instead of appending a new `run_started` record.
- Dispatch-time restore never creates new candidates; it only applies to issues already returned by
  the tracker as dispatch-eligible candidates.
- Restored retry and waiting records stay parked until their normal resume or retry path.
- A retry entry's `attempt` is the next pipeline cycle to dispatch. Tracker polling failures,
  capacity pressure, and shutdown quiescence defer the exact same retry entry while preserving its
  claim, attempt, step/fixup scope, and failure context.
- Automated failures that exhaust `max_cycles` transfer ownership to the same durable pending
  terminal transition used by normal terminal outcomes; they are never represented by an absent
  retry alone.
- Reconciliation keeps the exact cancelled worker drain-owned until it has fully drained and the
  post-drain retry disposition is committed. A scheduled disposition transfers ownership to its
  retry entry; an exhausted disposition persists the pending terminal transition before clearing
  the superseded running worker and drain handle.
- Once pipeline execution and required finalization produce a terminal outcome, Ensemble appends a
  pending terminal transition containing the configured target tracker state, outcome, retry
  metadata, completion history, and pipeline snapshot before finalization returns control to the
  caller and before attempting the tracker write.
- A pending terminal transition remains claimed but does not occupy an agent slot or become
  dispatch-eligible. Its pipeline snapshot, workspace, artifacts, and completion data remain
  available while tracker reconciliation is pending.
- Every tracker error is treated as potentially ambiguous. Startup and poll ticks replay the same
  configured state transition idempotently without rerunning pipeline steps or finalization, and
  persist updated attempt/error metadata after failures.
- After the tracker write is confirmed, Ensemble records that applied state as a still-live journal
  phase, clears any terminal interaction wait, and persists completion history idempotently. A
  restart in this phase finishes those local effects without repeating tracker or agent work.
- Stale `Running` steps from a previous process are normalized to `Pending`; agent processes are not
  recovered across orchestrator restarts or in-process journal rehydration.
- Ensemble appends `released` only after the terminal tracker transition is confirmed (or no
  tracker write is supported) and completion history is durable. That boundary prevents older
  snapshots for the issue from being restored after completion, stop, terminal reconciliation, or
  whole-issue retry.

#### 4.1.7 StepOutput

Structured result returned after a pipeline step completes:

- `result` (string: `"succeeded"`, `"failed"`, or `"concern"`)
  - `"succeeded"` — step passed.
  - `"failed"` — step failed quality/review checks or could not complete the requested work.
  - `"concern"` — step passed with a non-blocking concern that downstream steps can inspect.
- `summary` (string or null) — human-readable explanation of the result. Required and non-empty for
  `failed` and `concern`; optional for `succeeded`.
- `output` (JSON value or null) — optional structured data produced by a step for downstream
  prompt templates.

Result extraction:

1. The agent performs its visible working turn.
2. Ensemble runs a hidden extraction turn in the same runtime session to produce `StepOutput`.
3. If extraction produces invalid JSON or violates the result contract, Ensemble runs one hidden
   repair turn.
4. If repair also fails, the worker fails and the orchestrator applies the configured retry or
   failure behavior.

There is no default-success result. A step must produce valid `StepOutput` through extraction.

Prompt templates for downstream steps receive:

- `steps` — map of completed step name to `{ step, result, summary, output }`.
- `dependency_outputs` — ordered list of direct dependency outputs for the step being dispatched.

#### 4.1.8 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)

#### 4.1.9 Live Session (Agent Session Metadata)

State tracked while a coding-agent subprocess is running.

Fields:

- `session_id` (string, the ACP `sessionId` returned by `session/new`)
- `agent_pid` (string or null)
- `last_agent_event` (string/enum or null)
- `last_agent_timestamp` (timestamp or null)
- `last_agent_message` (summarized payload)
- `agent_input_tokens` (integer)
- `agent_output_tokens` (integer)
- `agent_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of coding-agent turns started within the current worker lifetime.

#### 4.1.10 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based next pipeline cycle to dispatch)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.11 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `agent_totals` (aggregate tokens + runtime seconds)
- `agent_rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `lowercase`.
- `Session ID`
  - Use the `sessionId` returned by the ACP `session/new` response.

## 5. Configuration Specification (Config-Directory Contract)

### 5.1 Config Directory Discovery and Resolution

Config directory path precedence:

1. `--config-dir` CLI flag (highest priority).
2. `ENSEMBLE_CONFIG_DIR` environment variable.
3. Default: platform-specific config directory:
   - Linux: `~/.config/ensemble/`
   - macOS: `~/Library/Application Support/ensemble/`
   - Windows: `%APPDATA%\ensemble\`

Loader behavior:

- The configuration file is always named `config.yaml` and lives in the resolved config directory.
- If the directory or `config.yaml` cannot be read, return `missing_config_file` error.
- Relative paths in `config.yaml` are resolved relative to the config directory.
- A `.env` file in the config directory is auto-loaded before `$VAR` expansion.

**Legacy note:** The old `ENSEMBLE_CONFIG` environment variable is no longer supported. Use `ENSEMBLE_CONFIG_DIR` instead.

### 5.2 File Format

`config.yaml` is a YAML file containing all pipeline configuration: tracker settings, agent
definitions, step DAG, concurrency limits, and prompt references.

Design note:

- `config.yaml` should be self-contained enough to describe and run different workflows (agent
  definitions, step pipeline, runtime settings, hooks, and tracker selection/config) without
  requiring out-of-band service-specific configuration.
- Prompt templates are referenced by file path relative to the config directory or defined inline within agent definitions.

Parsing rules:

- Parse the file as YAML. The root must be a map/object.
- Non-map YAML is an error.

### 5.3 Top-Level Schema

Top-level keys:

- `tracker`
- `repos`
- `agents`
- `steps`
- `on_success`
- `on_failure`
- `concurrency`
- `max_cycles`
- `polling`
- `workspace`
- `hooks`

Unknown keys should be ignored for forward compatibility.

Note:

- The config schema is extensible. Optional extensions may define additional top-level keys
  (for example `server`) without changing the core schema above.
- Extensions should document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.
- The current CLI enables the optional HTTP server through the `ensemble web` subcommand, not through
  a top-level config key.

#### 5.3.1 `tracker` (object)

The tracker configuration is pluggable. Each `kind` defines its own required and optional fields.
Implementations must support at least one tracker kind; additional kinds may be added without
changing the core orchestration logic.

Common fields (all tracker kinds):

- `kind` (string)
  - Required for dispatch.
  - Supported values: `todo_file`, `github`, `notion`
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Done`, `Closed`

##### `tracker.kind == "todo_file"`

A file-based tracker that reads issues from a local Markdown file. Each issue is a list item under
a heading that represents its state. This is the simplest tracker — no API credentials needed.

Fields:

- `path` (string, optional)
  - Path to the todo file.
  - Default: `~/ensemble/TODO.md` (in the `ensemble` directory in the user's home folder).
  - Supports `~` and `$VAR` expansion.
- `active_states` / `terminal_states`
  - Headings in the todo file are matched against these state lists (case-insensitive).

File format:

```markdown
## Todo

- [PROJ-1] Add login page
  Description of the task goes here.

- [PROJ-2] Fix checkout bug

## In Progress

- [PROJ-3] Refactor auth module
  Some description.

## Done

- [PROJ-4] Set up CI
```

Parsing rules:

- Level-2 headings (`## <State>`) define state sections.
- List items under a heading are issues. The first line is the title.
- Nested list items under an issue are description content, not additional issues.
- If the title starts with `[<identifier>]`, that bracketed value is the issue identifier.
- Otherwise, the implementation generates a stable identifier from state + position
  (for example `todo-0`).
- Items without bracketed IDs are supported for dispatch and state transitions. When moved to a
  new state, implementations may normalize the list line to bracket form
  (`- [generated-id] Title`) so future transitions remain stable.
- State-transition writes must reject empty target states and target states containing newlines.
  Writes should be atomic: write a temporary file in the same directory, then rename/persist it over
  the todo file.
- Indented lines after the title line (before the next list item) are the description.
- The file is re-read on each poll tick. Implementations may also watch for file changes.
- Issues are returned in document order within each state section.
- `priority`: derived from document order (first item = highest priority within its state).
- `labels`, `blocked_by`, `branch_name`, `url`: not supported; always empty/null.

##### `tracker.kind == "github"`

A GitHub Projects v2 tracker that reads issues from the GitHub GraphQL API.

Fields:

- `endpoint` (string)
  - Default: `https://api.github.com/graphql`
- `api_key` (string)
  - May be a literal token or `$VAR_NAME`.
  - Canonical environment variable: `GITHUB_TOKEN`.
  - The token must have `repo` and `project` scopes (or fine-grained equivalents).
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
  - If missing after config/env resolution, fallback to `gh auth token --hostname <host>`.
- `gh_hostname` (string, optional)
  - Explicit hostname override for `gh auth token --hostname`.
  - Useful when API endpoint host and auth host differ.
- `repository` (string)
  - Required for dispatch.
  - Format: `owner/repo` (for example `acme/my-project`).
- `project_number` (integer, optional)
  - GitHub Projects v2 board number.
  - When set, the service uses the project board's Status single-select field for state filtering.
  - When omitted, the service fetches issues from the repository directly using label or milestone
    filtering.
- `labels_filter` (list of strings, optional)
  - When set, only issues with at least one of these labels are considered candidates.
  - Useful when not using a project board for state management.
- `active_states` / `terminal_states`
  - When `project_number` is set, these match the project board's Status field values.
  - When `project_number` is omitted, these are matched against issue labels.

GitHub auth host resolution (for `gh auth token` fallback):
1. `tracker.gh_hostname` (if set)
2. host parsed from `tracker.endpoint` (`api.github.com` maps to `github.com`)
3. `ENSEMBLE_GH_HOST`
4. `GH_HOST`
5. `github.com`

##### `tracker.kind == "notion"`

A Notion database tracker that reads pages as issues and writes workflow updates back to Notion.

Fields:

- `notion.api_key` (string)
  - Required. Notion integration token.
  - May be a literal token or `$VAR_NAME`.
- `notion.database_id` (string)
  - Required. Notion database ID.
- `notion.version` (string, optional)
  - Default: `2022-06-28`.
  - Sent as `Notion-Version` request header.
- `notion.title_property` (string, optional)
  - Default: `Name`.
- `notion.status_property` (string, optional)
  - Default: `Status`.
- `notion.enabled_property` (string, optional)
  - Default: `Ready to Implement`.
- `notion.enabled_value_bool` (bool, optional)
  - Default: `true`.
  - Candidate pages must match this value for `enabled_property`.

Selection behavior:
- Candidates: `status_property` in `active_states` AND `enabled_property == enabled_value_bool`.
- Terminal lookup: by requested states from `status_property`.

Write behavior:
- `set_issue_state` updates `status_property`.
- `add_comment` writes a page comment.

#### 5.3.2 `repos` (list of objects, optional)

Repository definitions for multi-repo orchestration. Each entry defines a repository that agents
can work in. When omitted, defaults to an empty list.

Fields:

- `path` (string)
  - Required. Local filesystem path for the repository.
  - Supports `~` and `$VAR` expansion.
  - Relative paths are resolved from the configuration directory.
- `branch` (string)
  - Required. Target branch for pull requests and upstream merges.

Example:

```yaml
repos:
  - path: repos/frontend     # Relative to config directory
    branch: main
  - path: /home/dev/api       # Absolute path
    branch: develop
```

#### 5.3.3 `agents` (map of string to object)

Named agent definitions. Each key is the agent role name, each value is an object:

- `runtime` (string, optional)
  - Optional runtime override: `acpx` or `direct`.
  - When omitted, Ensemble infers `acpx` if `acpx_agent` is set; otherwise `direct`.
- `acpx_agent` (string, optional)
  - acpx agent identifier (for example `claude`, `codex`, `gemini`).
  - When set, Ensemble delegates agent communication to acpx unless `runtime: direct` overrides it.
  - acpx runtime parsing is JSON-RPC-only: stdout protocol lines must be valid JSON-RPC messages.
    Non-JSON-RPC stdout lines are treated as runtime protocol errors.
- `executor` (string, optional)
  - ACP-compatible agent executable identifier (for example `claude-code`, `amp`).
  - Required for `direct` runtime.
- `model` (string, optional)
  - Model identifier for the agent (for example `sonnet-4`, `opus-4`).
  - Required for `direct` runtime.
  - For `acpx_agent` entries, Ensemble applies the model through the adapter's supported startup
    path. Generic acpx agents use acpx model selection; `acpx_agent: opencode` inserts
    `--model <model>` into opencode's ACP startup command before `acp` because opencode does not
    advertise ACP generic model selection. Runtime launches preserve acpx opencode adapter command
    overrides from `.acpxrc.json` or `~/.acpx/config.json`.
  - When omitted for other runtimes, the agent uses its default model.
- `permission_mode` (string, optional)
  - Optional acpx launch-time permission mode for `acpx_agent`.
  - Supported values: `approve_all`, `approve_reads`, `deny_all`.
  - When omitted, Ensemble does not pass a permission-mode flag and acpx uses its own default.
- `reasoning_level` (string, optional)
  - Reasoning/thinking level for agents that support it (for example `high`, `low`).
  - When omitted, the agent uses its default reasoning level.
  - Currently set manually in `config.yaml`; reserved for future tooling that may auto-detect supported reasoning levels.
- `prompt` (string, optional)
  - Inline prompt text. Mutually exclusive with `prompt_template`.
- `prompt_template` (path string, optional)
  - Path to a Markdown prompt template file, relative to the configuration directory.
  - Supports `~` and `$VAR` expansion.
  - Mutually exclusive with `prompt`.
- Exactly one of `prompt` or `prompt_template` must be set.

Prompt templates support Liquid variables: `issue.*` and `attempt`.

#### 5.3.4 `steps` (list of objects)

Pipeline step definitions forming a DAG. Each step is an object:

- `name` (string)
  - Required. Unique step identifier.
- `agent` (string)
  - Required. References a named agent from `agents`.
- `kind` (string, optional)
  - Default: `"agent"`.
  - Step kind: `"agent"` for normal steps or `"synthesis"` for steps that merge/adjudicate direct
    dependency outputs. Synthesis steps must declare `depends` explicitly.
- `depends` (list of strings, optional)
  - Step names this step depends on. Steps with the same dependencies run in parallel.
  - If omitted: the first step in the list has no implicit dependency (it is a root). Each
    subsequent step that omits `depends` implicitly depends on the step directly before it in the
    list. A step that explicitly sets `depends` overrides this.
- `tracker_state` (string, optional)
  - Tracker state to write when entering this step. If multiple parallel steps share the same
    `tracker_state`, it is written once.

#### 5.3.5 `on_success` (string)

Terminal tracker state to write when all pipeline steps pass. Required.

#### 5.3.6 `on_failure` (string)

Terminal tracker state to write when any pipeline step fails or returns a failed result. Required.

#### 5.3.7 `concurrency` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `4`
  - Global cap on total agent processes across all issues.
- `max_step_parallelism` (integer)
  - Default: `2`
  - Per-issue cap on concurrent agents within a single pipeline run.

#### 5.3.8 `max_cycles` (integer)

- Default: `3`
- Maximum number of times an issue can re-enter the pipeline. Re-entry happens when a tracker poll
  finds an issue back in an active state after a previous pipeline run completed (for example a
  human moved it from "Needs Rework" back to "Todo"). The orchestrator tracks cycle count per issue
  identifier.

#### 5.3.9 `polling` (object)

Fields:

- `interval_ms` (integer or string integer)
  - Default: `30000`
  - Changes should be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.10 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/ensemble_workspaces`
  - `~` and strings containing path separators are expanded.
  - Bare strings without path separators are preserved as-is (relative roots are allowed but
    discouraged).

#### 5.3.11 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, optional)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, optional)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, optional)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, optional)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, optional)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Non-positive values should be treated as invalid and fall back to the default.
  - Changes should be re-applied at runtime for future hook executions.

#### 5.3.12 `agent` (object)

Global agent runtime defaults. Per-agent launch settings such as `acpx_agent`, `model`, and
`permission_mode` are defined in `agents` (5.3.3).

Fields:

- `max_retry_backoff_ms` (integer or string integer)
  - Default: `300000` (5 minutes)
  - Changes should be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.
- `command` (string command)
  - Default: implementation-defined.
  - Used by the direct ACP runtime when a step agent does not provide `executor`.
  - The command string is tokenized into program + args using shell-style quoting rules; empty or
    malformed command strings are invalid.
  - The runtime launches the command in the workspace directory via the ACP transport without shell
    interpolation of program arguments.
  - The launched process must speak the Agent Client Protocol (ACP) over stdio.
- `session_mode` (string, optional)
  - ACP session mode sent via `session/set_mode` after session creation.
  - Possible values: `code`, `architect`, `ask`.
  - Default: `code`.
- `permission_request_policy` (object, optional)
  - Defines how the orchestrator handles ACP `session/request_permission` callbacks after the agent
    is launched on direct ACP runtime paths.
  - This does not control acpx launch-time permission mode; use `agents.*.permission_mode` for
    that.
  - Fields:
    - `mode`: `approve_all`, `reject_all`, or `select_option`.
    - `option_id`: required when `mode: select_option`; must match an offered ACP
      `PermissionOption.option_id`.
  - Default: implementation-defined.
  - If all configured agents resolve to `acpx`, non-default values are invalid.
  - In mixed runtime configurations, this still applies only to agents using the direct runtime.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `read_timeout_ms` (integer)
  - Default: `5000`
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

### 5.4 Prompt Template Contract

Each agent's prompt is either an inline string (`prompt`) or a file reference (`prompt_template`).
File-referenced templates are Markdown files.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.
- `steps` (map of string to object, optional)
  - Present when upstream steps have completed. Each entry contains `step`, `result`, `summary`,
    and `output` fields.
- `dependency_outputs` (list of objects, optional)
  - Ordered list of outputs from the step's direct dependencies. Each entry has the same shape as
    `steps` entries: `{ step, result, summary, output }`.

Synthesis steps receive the same `steps` and `dependency_outputs` variables as normal steps. The
runtime appends synthesis-specific guidance to the first turn prompt, instructing the agent to
merge or adjudicate the outputs collected from its direct dependencies.

Fallback prompt behavior:

- Each agent must have exactly one of `prompt` or `prompt_template`. If neither is set, fail
  validation with a clear error.
- Config file read/parse failures are configuration/validation errors and should not silently fall
  back to a prompt.

### 5.5 Config Validation and Error Surface

Error classes:

- `missing_config_file`
- `config_parse_error`
- `unknown_agent_reference` (step references non-existent agent)
- `unknown_step_dependency` (step depends on non-existent step)
- `cycle_detected` (step DAG contains a cycle)
- `no_root_steps` (all steps have dependencies)
- `duplicate_step_name` (two steps share the same name)
- `invalid_prompt_config` (agent has neither or both prompt sources)
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)
- `writes_required` (pipeline requires tracker writes but tracker does not support them)

Dispatch gating behavior:

- Config file read/YAML errors block new dispatches until fixed.
- DAG validation errors block dispatch at startup.
- Template errors fail only the affected run attempt.

## 6. Configuration Loading and Resolution Semantics

### 6.1 Source Precedence and Resolution Semantics

Config directory precedence:

1. `--config-dir <path>` CLI flag (highest priority).
2. `ENSEMBLE_CONFIG_DIR` environment variable.
3. Platform-specific default config directory (lowest priority).

The configuration file is always `<config_dir>/config.yaml`.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Relative paths are resolved from the config directory
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.

**Legacy migration:** The old `ENSEMBLE_CONFIG` environment variable and `--config` flag are no longer supported. Use `ENSEMBLE_CONFIG_DIR` and `--config-dir` instead.

### 6.2 Environment Variable Loading

Before expanding `$VAR` references in the configuration, Ensemble loads environment variables from:

1. The process environment (highest priority)
2. A `.env` file in the config directory (if present)

This means variables in the process environment take precedence over those in `.env`. The `.env` file is loaded automatically—no manual `source .env` is required.

### 6.3 Dynamic Reload Semantics

Dynamic reload is required:

- The software should watch `config.yaml` for changes.
- On change, it should re-read and re-apply config and prompt templates without restart.
- The software should attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, agent settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not required to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) may
  require restart unless the implementation explicitly supports live rebind.
- Implementations should also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads should not crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.
- If an API save persists a candidate that cannot yet activate, return that persisted generation in
  redacted form and resolve later secret-preserve retries against it; do not roll secret placeholders
  back to the last-known-good runtime generation.
- Build a failed save response from the same candidate snapshot used to determine its activation
  outcome. Setup companion artifacts must publish inside the successful commit boundary, after the
  prior runtime quiesces. Failures before publication leave last-known-good companions in place;
  an interrupted partial publication leaves no dispatchable runtime and must recover before retry.
- Setup saves stage a private versioned journal under the config directory before replacing
  `config.yaml`. The journal is keyed by the SHA-256 digest of the exact raw config bytes and stores
  owner-only companion payloads and before-images, never the public setup request. Preparation may
  resolve dotenv values from the matching staged payload, but runtime template and tracker paths
  remain their final durable paths.
- Journal recovery runs before startup opens root-scoped runtime resources. A matching generation
  resumes publication idempotently; a mismatched partially published generation restores every
  before-image or fails startup closed. API retry and watcher reload consume the same journal.

### 6.4 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the config needed to poll and launch workers, not a full audit of all possible runtime behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Config directory and `config.yaml` can be resolved and read.
- YAML can be parsed.
- `tracker.kind` is present and supported.
- For `tracker.kind=github`, token resolution succeeds via: `tracker.api_key` (after `$` resolution), then `GITHUB_TOKEN`, then `gh auth token`.
- `tracker.repository` is present when required by the selected tracker kind.
- `agents` map is non-empty and each agent has exactly one prompt source.
- `steps` list is non-empty, all agent references resolve, all dependencies resolve, no cycles.
- If any step has `tracker_state` or `on_success`/`on_failure` are set, the tracker must support
  writes (`supports_writes()` returns true).
- `on_success` and `on_failure` are present.

### 6.5 Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.

- Config directory resolution: `--config-dir` > `ENSEMBLE_CONFIG_DIR` > platform default
- Config file: `<config_dir>/config.yaml`
- `tracker.kind`: string, required; supported values: `todo_file`, `github`, `notion`
- `tracker.path`: string, default `~/ensemble/TODO.md`; path to todo file when `tracker.kind=todo_file`
- `tracker.endpoint`: string; defaults to `https://api.github.com/graphql` when `tracker.kind=github`, and `https://api.notion.com` when `tracker.kind=notion`
- `tracker.api_key`: string or `$VAR`, canonical env `GITHUB_TOKEN` when `tracker.kind=github`
- `tracker.gh_hostname`: string, optional; explicit host for `gh auth token --hostname` fallback
- `tracker.repository`: string (`owner/repo`), required when `tracker.kind=github`
- `tracker.project_number`: integer, optional; GitHub Projects v2 board number
- `tracker.labels_filter`: list of strings, optional; restrict candidates to issues with these labels
- `tracker.notion.api_key`: string or `$VAR`, required when `tracker.kind=notion`
- `tracker.notion.database_id`: string, required when `tracker.kind=notion`
- `tracker.notion.version`: string, default `2022-06-28` when `tracker.kind=notion`
- `tracker.notion.title_property`: string, default `Name` when `tracker.kind=notion`
- `tracker.notion.status_property`: string, default `Status` when `tracker.kind=notion`
- `tracker.notion.enabled_property`: string, default `Ready to Implement` when `tracker.kind=notion`
- `tracker.notion.enabled_value_bool`: bool, default `true` when `tracker.kind=notion`
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default `["Done", "Closed"]`
- `agents.<name>.acpx_agent`: string, optional; acpx agent identifier (alternative to executor)
- `agents.<name>.runtime`: string, optional; `acpx` or `direct` runtime override
- `agents.<name>.executor`: string, required for direct runtime; ACP-compatible agent executable identifier
- `agents.<name>.model`: string, optional; model identifier, including for `acpx_agent` entries.
  Opencode acpx agents apply this by inserting `--model <model>` into the opencode ACP startup
  command before `acp`.
- `agents.<name>.prompt`: string, optional; inline prompt (mutually exclusive with prompt_template)
- `agents.<name>.prompt_template`: path, optional; file reference to prompt template (config-relative)
- `steps[].name`: string, required; unique step identifier
- `steps[].agent`: string, required; references a key in `agents`
- `steps[].kind`: string, optional, default `"agent"`; `"agent"` or `"synthesis"`
- `steps[].depends`: list of strings, optional; step dependencies for DAG
- `steps[].tracker_state`: string, optional; tracker state to write on step entry
- `on_success`: string, required; terminal tracker state on pipeline success
- `on_failure`: string, required; terminal tracker state on pipeline failure/rejection
- `concurrency.max_concurrent_agents`: integer, default `4`; global cap
- `concurrency.max_step_parallelism`: integer, default `2`; per-issue cap
- `max_cycles`: integer, default `3`; max pipeline re-entries per issue
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/ensemble_workspaces` (config-relative if not absolute)
- `worker.ssh_hosts` (extension): list of SSH host strings, optional; when omitted, work runs
  locally
- `worker.max_concurrent_agents_per_host` (extension): positive integer, optional; shared per-host
  cap applied across configured SSH hosts
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.command`: command string (tokenized into program + args, no shell interpolation), default implementation-defined
- `agent.session_mode`: string (`code`, `architect`, `ask`), default `code`
- `agent.permission_request_policy`: object, default implementation-defined; only applies to direct runtime paths
- `agent.turn_timeout_ms`: integer, default `3600000`
- `agent.read_timeout_ms`: integer, default `5000`
- `agent.stall_timeout_ms`: integer, default `300000`
- HTTP serving is a CLI mode. Use `ensemble web --port <port>` or the `PORT` environment variable
  when the web UI feature is available.

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `TerminalReconciliation`
   - Pipeline execution and required finalization are complete, but the configured terminal tracker
     state is not yet confirmed.
   - The claim and recoverable run data remain owned by the orchestrator while tracker I/O retries
     independently of agent capacity.

6. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Every live worker is also registered by an exact in-memory identity:
`issue_id`, stable pipeline `run_id`, pipeline `cycle`, `step_name`, and the owning
`RunningEntry.started_at`. The registry retains that identity's cancellation and completion handles
until the worker's local event channel has closed and every event has been forwarded. More than one
identity-distinct handle may temporarily exist for an issue, and issue-wide cancellation signals all
of them. Worker event channels remain bounded; while reconciliation or shutdown awaits bridge
completion, the lifecycle authority continues consuming the orchestrator-facing queue so forwarding
can quiesce without bypassing that memory bound. Reconciliation discards events for the issue whose
disposition it owns and applies normal identity checks to unrelated events; shutdown discards all
worker events after marking every live handle as drain-owned.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker may continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker should start another turn on the same live
  coding-agent thread in the same workspace, up to `agent.max_turns`.
- The first turn should use the full rendered task prompt.
- Continuation turns should send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Agent Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Mark every registered worker for the issue as reconciliation-owned.
  - Cancel and drain those workers, then revalidate the exact running attempt and pipeline cycle.
  - Only after successful revalidation, stop runs whose issue states are terminal or no longer
    active.

- `Stall Timeout`
  - Mark, cancel, and drain every worker for the issue.
  - Revalidate the exact owner before removing the running entry and scheduling its retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are required before launching any worker.
- Worker updates and exits are accepted only when their full worker identity still owns the running
  entry, pipeline cycle, and running step. Events from superseded identities are ignored, and a
  reconciliation-owned exit never enters normal success, failure, or retry handling.
- Graceful shutdown enters a quiescing runtime state: it stops polling and dispatch, marks and
  cancels every registered worker, retains the sole orchestrator event receiver, and pumps while
  discarding events until every bridge completes. Persistence flush and runtime completion happen
  only after this proof, and only successfully drained handles are removed.
- Runtime replacement publishes the old runtime as quiescing before it waits. A bounded replacement
  wait that times out or is cancelled leaves that exact runtime, receiver, and task registered and
  returns a typed busy error; no replacement launches until a later caller observes both semantic
  quiescence and completion of the exact registered runtime task.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (no durable orchestrator DB required).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval should be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

Reconciliation uses a broader active-state set than candidate dispatch. In addition to
`tracker.active_states`, any non-terminal `steps[].tracker_state` and approval `state` written by
the workflow are considered active for already-running or waiting issues. This prevents the
orchestrator from abandoning a run just because it moved the tracker item into a workflow-owned
intermediate state such as `Review` or `Plan Review`.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

Optional SSH host limit:

- When `worker.max_concurrent_agents_per_host` is set, each configured SSH host may run at most
  that many concurrent agents at once.
- Hosts at that cap are skipped for new dispatch until capacity frees up.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).
- Deterministic configuration/runtime capability failures may be treated as terminal immediately
  instead of retrying, because another attempt cannot change the configured agent capabilities.

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running issues).
- Retry handling mainly operates on active candidates and releases claims when the issue is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_agent_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > agent.stall_timeout_ms`, mark every registered worker for the issue as
  reconciliation-owned, signal cancellation, and await all captured completion handles.
- Completion means each local worker event channel has closed and every event, including the final
  exit, has been forwarded to the orchestrator.
- Recheck each candidate against its current activity timestamp immediately before cancellation,
  because draining an earlier issue may apply a newer event for a later candidate.
- Refresh each terminal or non-active tracker candidate immediately before cancellation, because
  draining an earlier issue may apply an event that changes a later candidate's tracker state.
- After draining, revalidate the same running attempt and pipeline cycle before removing the running
  entry and queueing the existing failure retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: drain and revalidate the worker, then release state and clean the
    workspace using the immutable issue ID. Cleanup fails closed if persisted workspace ownership
    does not match.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: drain and revalidate the worker, then release
    state without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

The drain wait never holds the worker-registry mutex or an orchestrator-state guard. If draining
times out or ownership changes before commit, reconciliation leaves the running entry, claim,
pipeline snapshot, workspace, and marked worker handles intact; a later tick may retry. This
pending drain is revisited before fresh stall and tracker scans even if its original trigger has
cleared. After quiescence, reconciliation refreshes tracker state and stall activity again. It
commits the current terminal, inactive, or stalled disposition; if the issue is active after its
worker was already cancelled, it uses the existing failure-retry path rather than leaving a
workerless running claim. Each successful disposition removes its exact handles and appends history,
schedules retry, or starts cleanup once. This live-worker boundary is separate from persisted
pending-terminal reconciliation: configured
completion has already ended agent work and follows the journaled terminal-transition path through
confirmed `Released` without waiting for an in-memory worker.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identity, resolve the workspace from its immutable ID, verify its
   manager-owned sidecar metadata, and remove the corresponding directory and sidecar.
3. If the terminal-issues fetch fails, log a warning and continue startup.

An absent canonical workspace with no sidecar is already clean. When the workspace is absent but a
valid matching sidecar remains from interrupted cleanup, cleanup removes the sidecar and succeeds.
A present workspace with missing, malformed, ownerless, or mismatched sidecar metadata is left
untouched and reported as a cleanup failure; startup continues. Corrupt or mismatched leftover
sidecars also fail closed.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized path; the current config layer expands path-like values and preserves
  bare relative names)

Per-issue workspace path:

- `<workspace.root>/<readable_issue_id_prefix>--<identity_sha256>`

The readable prefix contains only `[A-Za-z0-9._-]`, is capped at 80 bytes, and falls back to
`issue` when the sanitized result would be empty, `.` or `..`. The lowercase SHA-256 suffix hashes
the length-framed UTF-8 bytes of `issue.id`, so display-identifier changes preserve the path while
distinct immutable IDs remain distinct even when their readable prefixes collide. The resulting
path component is at most 146 bytes.

Workspace persistence:

- Workspaces are reused across runs for the same immutable issue ID, including when the display
  identifier changes.
- Successful runs do not auto-delete workspaces.
- `<workspace.root>/.ensemble-workspace-metadata/<workspace_key>.json` stores `issue_id`,
  `issue_identifier`, and the branch date used for repository worktrees. This manager-owned
  sidecar, outside the agent workspace, is the ownership authority. Files inside an agent
  workspace, including a forged `.ensemble-workspace.json`, have no lifecycle authority.
- Built-in coordinated repository worktrees derive their branch identity from the same
  collision-resistant immutable-ID key. Display-identifier changes therefore reuse the same branch,
  while distinct issue IDs remain isolated even when lossy branch sanitization would otherwise
  collide.

### 9.2 Workspace Creation and Reuse

Input: `issue.id` and `issue.identifier`

Algorithm summary:

1. Derive the bounded readable-plus-digest `workspace_key` from `issue.id` and acquire the
   process-wide lifecycle transaction for that workspace root and key. Preparation and removal
   hold the same per-issue transaction through metadata checks, repository worktree operations,
   and workspace and sidecar mutation.
2. Compute the workspace path under the workspace root.
3. For a new directory, atomically create manager-owned owner metadata without replacing an
   existing sidecar, before hooks or repository worktree preparation. If metadata creation fails,
   remove the newly created empty directory.
4. For an existing directory, load sidecar metadata and require `issue_id` to match before reuse,
   hooks, repository worktree preparation, or any metadata write. `issue_identifier` is
   informational display metadata and may be refreshed after immutable-ID verification using an
   atomic replacement, so a failed refresh leaves the previous valid sidecar intact.
5. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
6. If `created_now=true`, run `after_create` hook if configured.

Missing, malformed, ownerless legacy, or mismatched sidecar metadata is not repaired or adopted.
Reuse and removal fail before any workspace side effect. Removing an absent canonical workspace
with no sidecar remains idempotent; removing one with a valid matching leftover sidecar completes
the interrupted cleanup. Cleanup removes repository worktrees exhaustively, then the agent
workspace, then the sidecar. A sidecar-removal failure is retryable because the valid sidecar
remains authoritative. Implementations do not scan, migrate, rename, or remove legacy
identifier-only directories, and do not migrate or adopt in-workspace metadata.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 Optional Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations may populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations may remove the partially
  prepared directory.
- Reused workspaces should not be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path must stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is safe and collision-resistant.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Bound the readable prefix and append the full stable identity digest.

Invariant 4: Existing workspace ownership is proven from manager-owned state before reuse or
deletion.

- Require a readable, valid sidecar under `.ensemble-workspace-metadata` containing both `issue.id`
  and `issue.identifier`.
- Require persisted `issue.id` to exactly equal the requested immutable ID; do not treat a changed
  display identifier as a different owner.
- Treat missing, malformed, ownerless, or mismatched sidecar metadata as a fail-closed error before
  hooks, repository worktree operations, metadata repair, or recursive deletion.
- Do not use metadata inside the agent-writable workspace as ownership authority.

## 10. Agent Runner Protocol (ACP Integration)

This section defines the language-neutral contract for integrating a coding agent that speaks the
Agent Client Protocol (ACP). ACP is a JSON-RPC 2.0 protocol over stdio that provides a standard
interface for client-agent communication.

Reference: https://agentclientprotocol.com

Compatibility profile:

- The normative contract is message ordering, required behaviors, and the logical fields that must
  be extracted (for example session IDs, completion state, permission handling, and usage/rate-limit
  telemetry).
- Implementations should tolerate equivalent payload shapes when they carry the same logical
  meaning, especially for nested IDs, permission requests, and token/rate-limit metadata.

### 10.1 Launch Contract

Subprocess launch parameters:

- Command: `agent.command`
- Invocation: the command string is tokenized into program + args using shell-style quoting rules;
  the runtime launches the resulting program directly (without shell interpolation) in the workspace
  directory via the ACP transport.
- Working directory: workspace path
- Stdout/stderr: separate streams
- Framing: line-delimited JSON-RPC 2.0 messages on stdout

Notes:

- The default command is implementation-defined. Any ACP-compatible agent executable may be used.
- Session mode, cwd, and prompt are expressed in the protocol messages in Section 10.2.

Recommended additional process settings:

- Max line size: 10 MB (for safe buffering)

### 10.2 Session Startup Handshake

The client must send these ACP protocol messages in order:

Illustrative startup transcript:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-07-09","clientCapabilities":{"terminal":true},"clientInfo":{"name":"ensemble","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/abs/workspace","mcpServers":{}}}
{"jsonrpc":"2.0","method":"session/set_mode","params":{"sessionId":"<session-id>","mode":"code"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<session-id>","content":[{"type":"text","text":"<rendered prompt>"}]}}
```

1. `initialize` request
   - Params include:
     - `protocolVersion` (string, for example `"2025-07-09"`)
     - `clientCapabilities` object (advertise supported capabilities such as `terminal: true` for
       shell execution)
     - `clientInfo` object (for example `{name: "ensemble", version: "1.0"}`)
   - Wait for response containing `agentCapabilities` and `agentInfo` (`read_timeout_ms`)
2. `session/new` request
   - Params include:
     - `cwd` = absolute workspace path
     - `mcpServers` = map of MCP server configurations to expose to the agent (may be empty)
     - If optional client-side tools are implemented (for example `github_graphql`), expose them as
       MCP servers via this parameter.
   - Response contains `sessionId` (string).
3. `session/set_mode` notification (optional)
   - Sent only if `agent.session_mode` is configured and differs from the agent's default.
   - Params: `sessionId`, `mode` (one of `code`, `architect`, `ask`).
4. `session/prompt` request
   - Params include:
     - `sessionId`
     - `content` = array of content blocks; first turn uses a single text block containing the
       rendered prompt; continuation turns use continuation guidance
   - The agent streams `session/update` notifications in response.

Session identifiers:

- Read `sessionId` from `session/new` result.
- Emit `session_id = sessionId`.
- Reuse the same `sessionId` for all continuation prompts within one worker run.
- Track a `turn_count` integer in the orchestrator, incremented on each `session/prompt` call.

### 10.3 Streaming Turn Processing

The client reads line-delimited JSON-RPC 2.0 messages until the turn terminates.

Completion conditions (derived from ACP `stopReason` in `session/update` notifications):

- `end_turn` -> success (agent completed its work for this turn)
- `max_tokens` -> potential continuation (agent ran out of output tokens)
- `cancelled` -> failure
- `refusal` -> failure (agent declined the request)
- `max_turn_requests` -> failure (agent hit its internal tool-call limit)
- turn timeout (`agent.turn_timeout_ms`) -> failure
- subprocess exit -> failure

Continuation processing:

- If the worker decides to continue after a successful turn (`end_turn`), it should issue another
  `session/prompt` on the same `sessionId`.
- The agent subprocess should remain alive across continuation prompts and be stopped only when the
  worker run is ending.
- Use `session/cancel` notification to abort an in-progress turn if needed.

Line handling requirements:

- Read protocol messages from stdout only.
- Buffer partial stdout lines until newline arrives.
- Attempt JSON parse on complete stdout lines.
- For `acpx` runtime, accept JSON-RPC 2.0 protocol envelopes only. Reject non-JSON-RPC stdout
  lines as protocol errors.
- Stderr is not part of the protocol stream:
  - ignore it or log it as diagnostics
  - do not attempt protocol JSON parsing on stderr

### 10.4 Per-Step Conversation Transcripts

Ensemble persists coarse run timeline events in the `run_events` table of:

```text
{workspace}/.ensemble/history.db
```

The runtime must publish each event to live subscribers before offering its compact timeline record
to a bounded, non-blocking persistence queue. The queue writes to SQLite off the orchestrator hot
path; queue saturation or a database failure is warned and must not suppress live delivery.
Accepted records are keyed idempotently by `(run_id, sequence)` and read in sequence order. This
table is the sole durable timeline source for new events: there is no per-run timeline JSONL
dual-write, fallback read, or historical migration.

When the pipeline journal restores a live run, Ensemble initializes that run's in-memory timeline
sequence counter from the maximum sequence already stored in `run_events` before the run can emit
another timeline event. The first post-restart event therefore uses a greater sequence, including
across repeated restarts. Failure to read the durable maximum prevents that journal record from
being restored under a potentially reused sequence; the issue remains undispatched rather than
falling back to a fresh run.

For each pipeline step, Ensemble persists a typed JSONL transcript at:

```text
{workspace}/.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl
```

Transcript records are distinct from timeline events. Timeline events summarize run progress;
transcript records preserve step-level agent activity such as assistant messages, exposed reasoning
chunks, tool calls, tool results, permission activity, turn completion, prompts, and errors.

Large tool results are truncated with head and tail retention. Adjacent assistant and reasoning
deltas may be coalesced before persistence. Transcript persistence failures are logged and do not
fail the agent step.

Before the first post-start append for a `(run_id, step_name)` stream, transcript persistence scans
the existing JSONL bytes and resumes from the greatest valid durable sequence. A malformed or
truncated final record is ignored by readers and truncated before the next append; a valid final
record without a newline is normalized to a JSONL boundary. Malformed UTF-8 or JSON before a later
record remains an explicit error, leaves the file unchanged, and prevents that append.
Transcript reads hold a shared advisory file lock while taking their snapshot, while append and
tail repair hold an exclusive lock, so a reader cannot mistake an in-progress append for durable
tail corruption.

When a run is recorded in durable history, the history record should include per-step transcript
metadata so clients can link to completed step logs from issue detail and step detail views after the
run is no longer active.

The issue WebSocket at `/ws/events/{identifier}` emits three message kinds:

- `snapshot`: current issue detail snapshot sent when the socket connects.
- `event`: coarse pipeline event used by the run timeline.
- `transcript_record`: a persisted per-step transcript record, emitted after the same record has
  been appended to `.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl`.

Clients should treat transcript files and the step conversation API as the replay source. On
reconnect, clients should refetch the active step conversation and then merge subsequent
`transcript_record` messages by `(run_id, step_name, sequence)`.

### 10.5 Emitted Runtime Events (Upstream to Orchestrator)

The active runtime emits structured events to the orchestrator callback. Each event should
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `agent_pid` (if available)
- optional `usage` map (token counts)
- payload fields as needed

Important emitted events may include:

- `session_started` — after `session/new` succeeds
- `startup_failed` — if `initialize` or `session/new` fails
- `prompt_started` — after a prompt/turn is submitted to the runtime
- `output_chunk` — streamed stdout/stderr or textual progress output
- `run_completed` — when the runtime reports terminal success
- `run_failed` — when the runtime reports terminal failure
- `cancelled` — when the runtime reports explicit cancellation
- `warning` — warning surfaced by the runtime, including direct-runtime permission prompts
- `notification` — generic informational runtime update
- `other_message` — unrecognized JSON-RPC message
- `malformed` — unparseable line

### 10.6 Permission, Tool Calls, and User Input Policy

Permission and user-input behavior on direct ACP paths is governed by `agent.permission_request_policy`.

Policy requirements:

- Each implementation should document its chosen permission and operator-confirmation posture.
- Permission requests and user-input scenarios must not leave the orchestrator globally stalled.
  User-input waits should be issue-scoped, with other issues continuing to make progress.

Direct ACP permission handling:

- The agent sends `session/request_permission` (agent-to-client JSON-RPC request) when it needs
  approval for an action (for example executing a command or writing a file).
- The request includes a typed tool-call update and available `PermissionOption[]` response options.
- The orchestrator responds based on `agent.permission_request_policy`:
  - `approve_all`: select `allow_always` when offered, otherwise `allow_once`.
  - `reject_all`: select `reject_once` when offered, otherwise `reject_always`.
  - `select_option`: select the configured `PermissionOption.option_id` exactly.
- If no matching option is offered, the orchestrator responds with `cancelled`.
- Ensemble does not infer read/write permission semantics from tool-call display text or raw payloads.
- Available response option kinds include: `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- Known option IDs for ACP clients may be documented as verified examples, but they are not protocol guarantees.

Example high-trust behavior:

```yaml
agent:
  permission_request_policy:
    mode: approve_all
```

Example client-specific option selection:

```yaml
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
```
- When the agent emits an interaction request (`.ensemble/interaction-request.json`), persist it as
  a blocking interaction (`brainstorm_prompt`, `approval_gate`, or `manual_decision`) and wait for
  operator response.

Unsupported tool calls:

- ACP reports tool calls via `session/update` notifications with `tool_call_update` content blocks.
- The orchestrator does not need to intercept tool calls unless it provides client-side tools.
- If the agent requests a tool call that cannot be fulfilled, the implementation should return a
  failure result and continue the session.
- This prevents the session from stalling on unsupported tool execution paths.

Optional client-side tool extension:

- An implementation may expose a limited set of client-side tools to the ACP agent session.
- In ACP, client-side tools are exposed as MCP servers via the `mcpServers` parameter of
  `session/new`.
- Current optional standardized tool: `github_graphql`.
- Unsupported tool names should still return a failure result and continue the session.

`github_graphql` extension contract:

- Purpose: execute a raw GraphQL query or mutation against GitHub using Ensemble's configured
  tracker auth for the current session.
- Availability: only meaningful when `tracker.kind == "github"` and valid GitHub auth is configured.
- Preferred input shape:

  ```json
  {
    "query": "single GraphQL query or mutation document",
    "variables": {
      "optional": "graphql variables object"
    }
  }
  ```

- `query` must be a non-empty string.
- `query` must contain exactly one GraphQL operation.
- `variables` is optional and, when present, must be a JSON object.
- Implementations may additionally accept a raw GraphQL query string as shorthand input.
- Execute one GraphQL operation per tool call.
- If the provided document contains multiple operations, reject the tool call as invalid input.
- `operationName` selection is intentionally out of scope for this extension.
- Reuse the configured GitHub endpoint and auth from the active Ensemble workflow/runtime config; do
  not require the coding agent to read raw tokens from disk.
- Tool result semantics:
  - transport success + no top-level GraphQL `errors` -> `success=true`
  - top-level GraphQL `errors` present -> `success=false`, but preserve the GraphQL response body
    for debugging
  - invalid input, missing auth, or transport failure -> `success=false` with an error payload
- Return the GraphQL response or error payload as structured tool output that the model can inspect
  in-session.

Human interaction requirement:

- If an agent run blocks for human input, Ensemble persists an interaction request in its own state.
- Ensemble mirrors that request to the tracker as a dedicated root comment thread.
- Only thread replies are eligible for command intake. A GitHub command consists of one strict slash
  command, one blank line, and the interaction marker on its own final line:

  ```text
  /approve

  <!-- ensemble:interaction:interaction-123 -->
  ```

  The supported slash commands remain `/approve`, `/reject <reason>`, and `/answer <text>`.
  The root interaction comment provides kind-appropriate, copyable blocks containing the real
  interaction ID. Missing, duplicate, mismatched, prose-wrapped, or non-final markers are invalid.
- Command parsing uses original posted body text only; edited comment content is ignored.
- The first valid response across tracker comments and the local HTTP API wins one atomic
  compare-and-set against the durable interaction record. Every store instance in the process shares
  the same lock for that interaction file, while unrelated interactions use independent locks and do
  not wait for one another's file I/O.
- The winning command, typed response, resolved status, and resolution timestamp are written
  together. A later valid attempt is written as an attributed ignored audit before its caller
  observes the loss, including when cancellation closed the interaction first. Invalid comments are
  also audited and never transition the interaction.
- Persisted interaction threads remain eligible for cursor-driven command intake after the issue
  resumes. The cursor advances only through comments whose acceptance or ignored audit is durable,
  so transient persistence failures leave the first unaudited comment available for retry.

### 10.7 Timeouts and Error Mapping

Timeouts:

- `agent.read_timeout_ms`: request/response timeout during startup and sync requests
- `agent.turn_timeout_ms`: total turn stream timeout
- `agent.stall_timeout_ms`: enforced by orchestrator based on event inactivity
- `steps[].timeout_ms`: optional per-step override for `agent.turn_timeout_ms`; enforced per
  runtime prompt or turn, including hidden extraction and repair turns for that step.

Error mapping (recommended normalized categories):

- `agent_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `agent_exit` (subprocess exited unexpectedly)
- `response_error`
- `turn_failed`
- `turn_cancelled`

### 10.8 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + ACP session client.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Start ACP session (`initialize` + `session/new`).
4. Forward ACP `session/update` events to orchestrator.
5. On any error, fail the worker attempt. The orchestrator decides whether the failure is
   retryable or terminal.

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract (GitHub-Compatible)

### 11.1 Required Operations

An implementation must support these tracker adapter operations:

Read operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured repository/project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

Write operations:

4. `supports_writes()`
   - Returns whether this tracker backend supports write operations.
   - Required for pipeline execution with `tracker_state`, `on_success`, or `on_failure`.
   - Backends that do not support writes should return false; the pipeline engine will fail fast
     at startup.

5. `set_issue_state(issue_id, state)`
   - Transition an issue to the given state in the tracker.
   - Used by the pipeline engine at step boundaries (`tracker_state`), on pipeline success
     (`on_success`), and on pipeline failure/rejection (`on_failure`).
   - Default implementation returns `WritesNotSupported` error.

6. `add_comment(issue_id, body)`
   - Add a comment to an issue in the tracker.
   - Used to surface pipeline results (for example failure summaries, rejection reasons).
   - Default implementation returns `WritesNotSupported` error.
   - Trackers without a comment concept (for example `todo_file`) may leave this unimplemented.

Optional interaction-thread operations (recommended for trackers with comment threads):

7. `create_interaction_thread_root(issue_id, body)`
   - Creates the root comment used as the interaction thread anchor.
   - Returns tracker metadata (comment ID + URL) for later polling.
   - Backends that do not support this should return `WritesNotSupported`.

8. `list_comments_after(issue_id, after_comment_id)`
   - Lists comments newer than a given anchor comment.
   - Used by orchestrator ticks to ingest slash commands for open interactions.
   - Backends that do not support this should return `WritesNotSupported`.

### 11.2 Query Semantics (GitHub)

GitHub-specific requirements for `tracker.kind == "github"`:

- `tracker.kind == "github"`
- GraphQL endpoint (default `https://api.github.com/graphql`)
- Auth token sent in `Authorization: bearer <token>` header
- `tracker.repository` maps to the GitHub repository `owner/name`

When `tracker.project_number` is set (GitHub Projects v2 mode):

- Query the project's items using the GitHub Projects v2 GraphQL API.
- Filter project items by the Status single-select field matching `active_states`.
- The implementation must discover the Status field ID at startup or cache it.
- Project items are linked to GitHub Issues; extract the issue content from each item.
- GraphQL query pattern:
  `query { node(id: "<project-node-id>") { ... on ProjectV2 { items(first: $pageSize, after: $cursor) { ... } } } }`

When `tracker.project_number` is NOT set (repository issues mode):

- Query issues on the repository filtered by state `open`.
- If `tracker.labels_filter` is configured, filter by those labels.
- Map `active_states` to issue labels for state classification.

Common requirements:

- Issue-state refresh query uses GitHub Issue node IDs (GraphQL global IDs)
- Pagination: cursor-based using `pageInfo { hasNextPage endCursor }`
- Page size default: `50`
- Network timeout: `30000 ms`

Important:

- GitHub GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types required by this specification.

A non-GitHub implementation may change transport details, but the normalized outputs must match the
domain model in Section 4.

### 11.3 Normalization Rules

Candidate issue normalization should produce fields listed in Section 4.1.1.

Additional normalization details:

- `id` -> GitHub Issue node ID (GraphQL global ID)
- `identifier` -> `<repo-short-name>#<issue-number>` (for example `my-project#42`)
- `state` -> For project-board mode: the project Status field value (for example `Todo`,
  `In Progress`). For repository mode: classify from labels or use `open`/`closed`.
- `priority` -> Derived from GitHub Projects "Priority" single-select field if present, mapped to
  integers (for example Urgent=1, High=2, Medium=3, Low=4). Otherwise `null`.
- `labels` -> lowercase strings from GitHub Issue labels
- `blocked_by` -> GitHub Issues have no native blocking relations. Implementations may populate this
  by scanning issue body/comments for `blocked by #N` patterns, using a label convention, or leave
  it as an empty list.
- `branch_name` -> GitHub Issues do not provide branch metadata natively. Implementations may derive
  from issue number (for example `issue-42`), check for linked branches via the GitHub API, or
  leave it `null`.
- `url` -> GitHub Issue HTML URL
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.4 Error Handling Contract

Recommended error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_repository`
- `github_api_request` (transport failures)
- `github_api_status` (non-200 HTTP)
- `github_graphql_errors`
- `github_unknown_payload`
- `github_missing_end_cursor` (pagination integrity error)
- `writes_not_supported` (tracker does not support write operations)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes (Hybrid Model)

The orchestrator writes lifecycle state transitions at pipeline step boundaries. Rich ticket writes
(comments, PR links, code review feedback) remain the agent's responsibility.

Orchestrator-driven writes:

- **Step entry**: When a pipeline step begins, the orchestrator writes the step's `tracker_state`
  to the tracker (for example "In Progress", "In Review").
  Non-terminal step-entry and approval states are treated as active for reconciliation of existing
  runs, but they do not automatically make new issues dispatch-eligible.
- **Pipeline success**: When all steps pass, the orchestrator writes `on_success` (for example
  "Done").
- **Pipeline failure/rejection**: When any step fails or returns a failed result, the orchestrator
  writes `on_failure` (for example "Needs Rework"). This is a terminal state from the pipeline's
  perspective — a human must intervene.

Agent-driven writes:

- The coding agent may still write to the tracker using tools defined by the workflow prompt (for
  example adding comments, linking PRs, or making fine-grained state transitions within a step).
- If the optional `github_graphql` client-side tool extension is implemented, it is still part of
  the agent toolchain.

Write method contract:

- `set_issue_state` and `add_comment` have default stub implementations that return
  `WritesNotSupported`.
- Tracker backends opt into writes by overriding these methods and returning `true` from
  `supports_writes()`.
- The pipeline engine validates write support at startup and fails fast if required writes are
  not supported by the configured tracker.

Backend-specific write implementations:

- **todo_file**: `set_issue_state` rewrites the markdown file, moving the issue line from its
  current `## Section` to the target `## State` heading (creating the heading if needed).
  `add_comment` is not supported (returns `WritesNotSupported`).
- **github (project board mode)**: `set_issue_state` uses a GraphQL mutation to update the Status
  single-select field on the project item. `add_comment` uses the `addComment` GraphQL mutation.
- **github (repository mode)**: `set_issue_state` uses GraphQL mutations to update labels (add
  target state label, remove old state labels). `add_comment` uses the `addComment` GraphQL
  mutation.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `agent.prompt` or contents of `agent.prompt_template` (per the active pipeline step's agent)
- normalized `issue` object
- optional `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` should be passed to the template because the workflow prompt may provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Runtime Policy Injection

Implementations may append runtime-owned instruction blocks after template rendering.

At minimum, Ensemble v1 appends:

- result extraction instructions for the hidden extraction turn
- interaction-policy guidance (enabled by default), including:
  - prefer batched clarification requests instead of one-by-one ping-pong
  - this is a soft preference, not a strict prohibition
  - each question should include question/why/default

Interaction-policy config behavior:

- global enable/disable toggle
- optional global replacement text
- per-agent and per-step overrides with modes: `inherit`, `custom`, `off`
- precedence: step override > agent override > global default

### 12.5 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

Required context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

Required context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs must go (stderr, file, remote sink, etc.).

Requirements:

- Operators must be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations may write to one or more sinks.
- If a configured log sink fails, the service should continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (Optional but Recommended)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
should return:

- `running` (list of running session rows)
- each running row should include `turn_count`
- `retrying` (list of retry queue rows)
- `agent_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest coding-agent rate limit payload, if available)

Recommended snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 Optional Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is optional and
implementation-defined.

If present, it should draw from orchestrator state/metrics only and must not be required for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Agent events may include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime should be reported as a live aggregate at snapshot/render time.
- Implementations may maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not required.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (Optional)

Humanized summaries of raw agent protocol events are optional.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 Optional HTTP Server Extension

This section defines an optional HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not required for conformance.
- The implementation may serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API must be observability/control surfaces only and must not become required for
  orchestrator correctness.
- CLI builds may compile this extension behind an optional feature. When the feature is disabled,
  the HTTP server subcommand is not part of the CLI command surface.

Enablement (extension):

- Start the HTTP server when the `ensemble web` subcommand is used. The `--port` flag or `PORT`
  environment variable controls the bind port; if omitted, an ephemeral port is assigned.
- HTTP listener settings are CLI/runtime settings, not `config.yaml` workflow policy. The config
  directory still controls tracker, agent, pipeline, workspace, and hook behavior.
- Positive port values bind that port. `0` may be used to request an ephemeral port for local
  development and tests.
- Implementations should bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings do not need to hot-rebind; restart-required behavior is
  conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document should depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "agent_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Workflow steps should remain navigable from the issue detail response whenever the server can
    resolve the issue from active state or durable history. Completed runs should include durable
    artifacts such as workspace path, repo branch/HEAD/change metadata, transcript metadata, and
    finalize output. These artifacts are independent of finalize mode; `finalize.mode: none` still
    records the workspace, repo, and transcript metadata.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/ensemble_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "agent_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/ensemble/agent/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    may coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

- `GET /api/v1/<issue_identifier>/timeline?run_id=<run_id>`
  - Returns timeline events from the SQLite `run_events` table for exactly the requested issue and
    run, ordered by sequence.
  - Repeated persistence of the same `(run_id, sequence)` is idempotent.
  - The endpoint and runtime persistence must use the same canonical
    `{workspace}/.ensemble/history.db`; per-run timeline JSONL is not a fallback source.

- `POST /api/v1/interactions/{id}/respond`
  - Attempts to resolve a specific open human interaction. The body is typed by interaction kind and
    participates in the same first-valid-response compare-and-set as tracker commands.
  - Question response body:

    ```json
    {
      "kind": "question",
      "response_schema_version": 1,
      "text": "Human response text",
      "selected_option": null
    }
    ```

  - Approval response body:

    ```json
    {
      "kind": "approval",
      "response_schema_version": 1,
      "approved": true,
      "reason": "Looks good"
    }
    ```

  - Handoff response body:

    ```json
    {
      "kind": "handoff",
      "response_schema_version": 1,
      "completed": true,
      "notes": "Ready for the next poll"
    }
    ```

  - Suggested response (`200 OK`) shape: the resolved interaction request.
  - Trusted-local API attempts are audited with author `local-api`, a unique server-generated input
    ID in `comment_id`, and the serialized typed request in `raw_body`.
  - If the interaction is missing, return a JSON error with `404`.
  - If another valid response wins first, durably append the losing API attempt to
    `ignored_commands` and only then return `409 Conflict`.
  - If cancellation wins first, durably append the API attempt with an
    `interaction_already_cancelled` reason before returning the existing `already_cancelled` `409`
    error.

- `POST /api/v1/issues/{identifier}/resume`
  - Releases a blocked issue after its human interaction has been resolved so the next orchestrator
    tick can requeue it.
  - Suggested response (`200 OK`) shape:

    ```json
    {
      "resumed": true,
      "issue_identifier": "MT-649",
      "message": "issue resume queued"
    }
    ```

  - If the issue is not resumable, return `409 Conflict` with an error response.

API design notes:

- The JSON shapes above are the recommended baseline for interoperability and debugging ergonomics.
- Implementations may add fields, but should avoid breaking existing fields within a version.
- Endpoints should be read-only except for operational control endpoints such as `/refresh`,
  `/interactions/{id}/respond`, and `/issues/{identifier}/resume`.
- Unsupported methods on defined routes should return `405 Method Not Allowed`.
- API errors should use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it should consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `config.yaml` in the resolved config directory
   - Invalid YAML config
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing coding-agent executable

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; may come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested (hard fail)
   - Subprocess exit
   - Stalled session (no activity)

4. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Reconciliation worker-drain timeout or ownership mismatch:
  - Retain the running entry, claim, pipeline snapshot, workspace, and reconciliation-owned worker
    handles.
  - Do not append stopped history, schedule a replacement, release state, or remove files.
  - Retry reconciliation on a later tick.

- Runtime replacement timeout or cancelled wait:
  - Keep the exact old runtime registered as quiescing with its event receiver and task.
  - Return a typed runtime-busy error.
  - Do not abort the old runtime, clear active-worker handles, or launch a replacement.
  - A later replacement attempt may proceed only after old-runtime completion is observed.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Current design is intentionally in-memory for scheduler state.

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Active-worker identities, cancellation tokens, and completion handles are intentionally
  in-memory; stale `Running` steps are normalized rather than restored as live workers.
- Service recovers by:
  - startup restoration of live pipeline journal snapshots
  - retrying pending terminal tracker transitions before candidate dispatch, without rerunning
    pipeline or finalization work
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - dispatch-time restoration of live journal snapshots for already eligible candidates
  - re-dispatching eligible work

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `config.yaml` (pipeline config and most runtime settings).
- `config.yaml` changes should be detected and re-applied automatically without restart.
- If applying a configuration change requires replacing a runtime that is still quiescing, surface
  the typed busy error and keep the old runtime registered. Transactional configuration-document
  rollback is a separate concern.
- Changing issue states in the tracker:
  - terminal state -> running session is cancelled and drained before release and workspace cleanup
  - non-active state -> running session is cancelled and drained before release without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations should state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations should state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path must remain under configured workspace root.
- Coding-agent cwd must be the per-issue workspace path for the current run.
- Workspace directory names must use sanitized identifiers.

Recommended additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.
- Configuration APIs must not serialize resolved runtime configuration or literal secret values.
- In configuration YAML exposed through an API, mapping keys named exactly `api_key`, `token`,
  `password`, or `secret` (case-insensitive) are secret fields at any nesting depth. Literal secret
  values are represented as `[REDACTED]`; `$VAR` references may remain visible as non-secret
  metadata. Lookalike keys are not secret fields.
- Raw YAML saves interpret `[REDACTED]` as "preserve the authoritative value at this YAML path".
  Sequence entries are matched one-to-one by a unique scalar `id`, then `name`; unnamed entries
  fall back to their complete non-secret structure. Position is never an identity, so reordering,
  inserting, or editing non-identity fields cannot move credentials between logical entries.
  After direct matches are claimed, one unmatched preserve marker may map to one remaining stored
  entry by elimination, allowing an unambiguous identity rename. Multiple unmatched or duplicate
  identities are rejected. An explicit replacement replaces the value and an omitted field removes
  it.
- Structured editors represent secret changes explicitly as preserve, replace with a write-only
  literal, replace with an environment reference, or remove. Existing secrets default to preserve,
  and blank literal replacements are rejected before configuration persistence. Environment names
  must match `[A-Za-z_][A-Za-z0-9_]*`.
- If malformed YAML cannot be structurally redacted, omit it from API responses.
- Configuration file replacement must be atomic. On Unix, preserve an existing file's permissions
  and create new configuration files with mode `0600`.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `config.yaml`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output should be truncated in logs.
- Hook timeouts are required to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running coding agents against repositories, issue trackers, and other inputs that may contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations should explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
ports should not assume that tracker data, repository contents, prompt inputs, or tool arguments are
fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening agent permission policy and session mode settings described elsewhere in this
  specification instead of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in agent policy controls.
- Filtering which GitHub issues, projects, labels, or other tracker sources are eligible for
  dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing the optional `github_graphql` tool so it can only read or mutate data inside the
  intended project scope, rather than exposing general workspace-wide tracker access.
- Reducing the set of client-side tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations should document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    agent_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    agent_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  for issue_id in registry.pending_reconciliation_issue_ids():
    owner = capture_running_attempt_and_pipeline_cycle(state, issue_id)
    handles = registry.mark_and_cancel_all(issue_id)
    if not await_all_completion(handles, timeout=worker_drain_timeout):
      continue
    disposition = refresh_tracker_and_stall_disposition(issue_id)
    if not owner_still_matches(state, issue_id, owner):
      continue
    state = commit_current_disposition_once(state, issue_id, disposition)
    registry.remove_exact(handles)

  for issue_id in find_stalled_runs(state):
    if not issue_is_still_stalled(state, issue_id):
      continue
    owner = capture_running_attempt_and_pipeline_cycle(state, issue_id)
    handles = registry.mark_and_cancel_all(issue_id)
    if not await_all_completion(handles, timeout=worker_drain_timeout):
      continue
    disposition = refresh_tracker_and_stall_disposition(issue_id)
    if not owner_still_matches(state, issue_id, owner):
      continue
    state = commit_current_disposition_once(state, issue_id, disposition)
    registry.remove_exact(handles)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = drain_revalidate_and_terminate(state, issue.id, cleanup_workspace=true)
    else if issue.state in reconciliation_active_states:
      state.running[issue.id].issue = issue
    else:
      state = drain_revalidate_and_terminate(state, issue.id, cleanup_workspace=false)

  return state
```

`drain_revalidate_and_terminate` captures the running attempt and pipeline cycle, marks and cancels
every issue worker, waits outside all locks while pumping the bounded event receiver, refreshes the
current tracker/stall disposition, and mutates state only if the captured owner still matches.
Timeout or mismatch retains all state and handles. Workspace removal, if requested, begins only
after the successful drain and ownership commit.

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  attempt_started_at = now_utc()
  state.running[issue.id] = {
    identifier: issue.identifier,
    issue,
    session_id: null,
    agent_pid: null,
    last_agent_message: null,
    last_agent_event: null,
    last_agent_timestamp: null,
    agent_input_tokens: 0,
    agent_output_tokens: 0,
    agent_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: attempt_started_at
  }
  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)

  identity = {
    issue_id: issue.id,
    run_id: state.pipeline_runs[issue.id].run_id,
    cycle: state.pipeline_runs[issue.id].cycle,
    step_name: selected_step.name,
    started_at: attempt_started_at
  }
  local_events = create_worker_event_channel()
  completion = create_completion_signal()
  registry.register(identity, cancellation_token, completion)
  bridge(local_events, fn:
    for event in local_events:
      if not send(orchestrator_channel, {identity, event}):
        return_without_signalling_completion
    signal(completion)
  )

  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, local_events) end
  )

  if worker spawn failed:
    registry.remove_exact(identity)
    state.running.remove(issue.id)
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, attempt, local_events):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = acp_client.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      acp_client.cancel_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = acp_client.send_prompt(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(local_events, {agent_update, issue.id, msg})
    )

    if turn_result failed:
      acp_client.cancel_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
    if refreshed_issue failed:
      acp_client.cancel_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  acp_client.cancel_session(session)
  run_hook_best_effort("after_run", workspace.path)

  send(local_events, {worker_exit, issue.id, normal})
  close(local_events)
```

The worker sends its final exit through the same local channel. The bridge signals completion only
after that channel closes and all prior events have been forwarded. The orchestrator validates the
envelope's full identity before applying an update or exit; it ignores stale events and acknowledges
a reconciliation-owned exit without normal exit or retry transitions.

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

### 16.7 Runtime Quiescence and Replacement

```text
function replace_registered_runtime(prepared_runtime, timeout):
  lock registered_runtime:
    if current is quiescing_for_shutdown:
      return runtime_busy
    if current is quiescing_for_replacement and not complete:
      return runtime_busy
    if current is running:
      current.phase = quiescing_for_replacement
      current.request_shutdown()
    old_identity = current.identity
    old_completion = current.completion_observer
  unlock registered_runtime

  if not await_completion(old_completion, timeout):
    return runtime_busy

  lock registered_runtime:
    if current is not the same completed quiescing_for_replacement runtime:
      return runtime_busy
    retire current
    register prepared_runtime as running
  unlock registered_runtime
```

The shutdown request synchronously closes a shared dispatch gate before it is queued, so an
in-progress tick cannot begin another candidate or retry dispatch after quiescence is published.
The quiescing runtime performs no further polling, retry dispatch, or candidate dispatch. It retains
the sole worker-event receiver, cancels every exact worker handle, and pumps/discards bounded events
until every bridge proves completion. Semantic completion is necessary but insufficient for
retirement: the exact registered runtime task must also be observed finished. Timeout or
cancellation of the replacement wait never removes the registered runtime. Graceful host shutdown
uses a distinct quiescing-for-shutdown phase, retains the slot until exact completion, and rejects
concurrent replacement. A closed-but-false completion signal cannot prove quiescence, so the runtime
remains fail-closed and busy until host-level hard process termination.

## 17. Test and Validation Matrix

A conforming implementation should include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests required for all conforming implementations.
- `Extension Conformance`: required only for optional features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks recommended before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Config file path precedence:
  - config directory is resolved via `--config-dir`, `ENSEMBLE_CONFIG_DIR`, then platform default
  - config file path is derived as `<config_dir>/config.yaml`
- Config file changes are detected and trigger re-read/re-apply without restart
- Invalid config reload keeps last known good effective configuration and emits an
  operator-visible error
- Watcher reloads and API saves serialize candidate acquisition, secret-safe file writes,
preparation, exact-runtime quiescence, and commit so config generations cannot interleave
- A valid reload is prepared without publishing candidate values, drains the exact active runtime
including workers and timeline/transcript persistence, and atomically commits the document,
observed mtime, config-derived orchestrator state, and an unlaunched replacement before allowing
the replacement to execute
- Invalid candidates, preparation failures, and `RuntimeBusy` retain the complete last-known-good
generation and do not consume the candidate mtime; the same on-disk candidate remains retryable
- A timed-out replacement leaves its exact one-way-quiescing runtime registered until positive
completion is proven; it is never relaunched, detached, or replaced concurrently
- Effective `workspace.root` or ordered `repos` configuration changes are restart-required and must not
change live workspace, SQLite history/timeline, transcript, journal, or other root-scoped
resources; API saves return `409 Conflict` and watcher diagnostics expose no candidate values
- Missing `<config_dir>/config.yaml` returns typed error
- Invalid YAML returns typed error
- Root non-map returns typed error
- Agent definitions validate: each agent has exactly one of `prompt` or `prompt_template`
- Step DAG validates: all agent references resolve, all dependencies resolve, no cycles, at least
  one root step
- Pipeline write validation: if steps use `tracker_state` or `on_success`/`on_failure`, tracker
  must support writes
- Config defaults apply when optional values are missing
- `tracker.kind` validation enforces currently supported kind (`github`)
- `tracker.api_key` works (including `$VAR` indirection)
- `$VAR` resolution works for tracker API key and path values
- `~` path expansion works
- `agent.command` is preserved as a command string (tokenized, not shell-interpolated)
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- Optional workspace population/synchronization errors are surfaced
- Temporary artifacts (`tmp`, `.elixir_ls`) are removed during prep
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization and root containment invariants are enforced before agent launch
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and repository
- GitHub query uses the specified repository and optionally `project_number`
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are derived from issue body/comment references or labels (implementation-defined)
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GitHub node IDs as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state cancels and drains every issue worker before releasing state without workspace
  cleanup
- Terminal state cancels and drains every issue worker before releasing state and beginning
  workspace cleanup
- Stalled state cancels and drains every issue worker before scheduling a replacement
- Drain timeout retains the current running/claimed/pipeline/workspace owner and schedules no retry
- Pending drain ownership is retried even when the original trigger clears; an active issue whose
  worker was already cancelled follows the existing failure-retry path
- Exact attempt and pipeline-cycle revalidation rejects a superseded reconciliation owner
- Late updates and exits from drained or superseded identities cannot mutate a replacement attempt
- Reconciliation-owned exits do not enter normal worker-exit or retry handling
- Shutdown stops polling and dispatch, retains and pumps the bounded receiver, and completes only
  after every exact worker bridge quiesces
- Runtime replacement timeout or wait cancellation retains the same quiescing runtime and returns
  typed busy; one later retry launches a replacement only after observed completion
- Reconciliation with no running issues is a no-op
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Stall detection cancels and drains stalled sessions, revalidates their exact owner, then schedules
  retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

### 17.5 ACP Agent Client

- Launch command uses workspace cwd; the command string is tokenized into program + args and
  launched directly without shell interpolation
- Startup handshake sends `initialize`, `session/new`, `session/prompt`
- `initialize` includes `protocolVersion`, `clientCapabilities`, and `clientInfo` per ACP spec
- `session/new` returns `sessionId` and implementation emits `session_started`
- `session/set_mode` is sent when `agent.session_mode` is configured
- Request/response read timeout is enforced
- Turn timeout is enforced
- Partial JSON lines are buffered until newline
- Stdout and stderr are handled separately; protocol JSON is parsed from stdout only
- Non-JSON stderr lines are logged but do not crash parsing
- direct-runtime `session/request_permission` callbacks are handled according to `agent.permission_request_policy`
- Permission requests do not stall indefinitely
- Unsupported tool calls are rejected without stalling the session
- User input requests are handled according to the implementation's documented policy and do not
  stall indefinitely
- ACP `stopReason` values correctly map to success/failure outcomes
- Usage and rate-limit payloads are extracted from `session/update` notifications
- If optional client-side tools are implemented, they are exposed as MCP servers via `session/new`
  `mcpServers` parameter
- If the optional `github_graphql` client-side tool extension is implemented:
  - the tool is exposed as an MCP server to the session
  - valid `query` / `variables` inputs execute against configured GitHub auth
  - top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior

### 17.7 CLI and Host Lifecycle

The `ensemble` binary supports the following subcommands:

- `ensemble init` — Interactive setup wizard that scaffolds a ready-to-run Ensemble configuration
  directory. Discovers available agents via acpx, collects tracker credentials, validates the
  setup, and writes `config.yaml` with prompt templates.
- `ensemble run [--config-dir <path>]` — Run the orchestrator using the resolved config directory.
- `ensemble` (no subcommand) — Equivalent to `ensemble run` using the same config-dir resolution.

`ensemble init` Requirements:

- **acpx** must be installed and on PATH. If missing, the command prints install instructions and
  exits.
- At least one agent must be discoverable via acpx.
- When model choices are not discoverable, the wizard does not write a new `model` value. During
  reconfiguration it may preserve an existing `opencode` model because opencode supports startup
  model selection outside ACP generic model discovery.
- The wizard produces:
  - `config.yaml` — generated configuration
  - `templates/*.liquid` — prompt templates for each pipeline step
  - `TODO.md` — sample issues (only if `todo_file` tracker selected)

CLI defaults:

- CLI resolves the configuration directory using `--config-dir`, `ENSEMBLE_CONFIG_DIR`, then the
  platform default
- CLI derives the config file path as `<config_dir>/config.yaml`
- CLI errors when the resolved config directory is missing `config.yaml`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (Recommended)

These checks are recommended for production readiness and may be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied by `GITHUB_TOKEN` or a
  documented local bootstrap mechanism (for example `~/.github_token`).
- Real integration tests should use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test should be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures should
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 Required for Conformance

- Config directory selection supports `--config-dir`, `ENSEMBLE_CONFIG_DIR`, and platform defaults
- `<config_dir>/config.yaml` loader with agent definitions, step DAG, and prompt references
- Typed config layer with defaults and `$` resolution
- Dynamic `config.yaml` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker client with candidate fetch + state refresh + terminal fetch + write operations
- Pipeline engine with step DAG construction, validation, and per-issue execution
- Validated `StepOutput` extraction from the hidden extraction turn, with one repair attempt if
  extraction is invalid
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- ACP agent subprocess client with JSON-RPC 2.0 line protocol
- Agent launch command config (`agent.command`, default implementation-defined)
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; optional snapshot/status surface)

### 18.2 Recommended Extensions (Not Required for Conformance)

- Optional HTTP server uses `ensemble web`, honors CLI `--port`/`PORT`, uses a safe default bind
  host, and exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
- Optional `github_graphql` client-side tool extension exposes raw GitHub GraphQL access through the
  ACP session using configured Ensemble auth.
- TODO: Persist retry queue and session metadata across process restarts.
- TODO: Make observability settings configurable in config without prescribing UI implementation
  details.
- TODO: Add pluggable issue tracker adapters beyond GitHub.

### 18.3 Operational Validation Before Production (Recommended)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the optional HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (Optional)

This appendix describes a common extension profile in which Ensemble keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
- The ACP agent is launched over SSH stdio instead of as a local subprocess, so the orchestrator
  still owns the session lifecycle even though commands execute remotely.
- Continuation turns inside one worker lifetime should stay on the same host and workspace.
- A remote host should satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, coding-agent executable, and any required auth or repository
  prerequisites.

### A.2 Scheduling Notes

- SSH hosts may be treated as a pool for dispatch.
- Implementations may prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an optional shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch should wait rather than silently falling back to a
  different execution mode.
- Implementations may fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host should be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

- Remote environment drift:
  - Each host needs the expected shell environment, coding-agent executable, auth, and repository
    prerequisites.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists.
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations should distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host should reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.
