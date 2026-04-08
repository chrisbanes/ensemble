# Configuration Reference

Ensemble is configured through a `config.yaml` file located in a configuration directory. The default config directory is determined by your platform:

- **Linux:** `~/.config/ensemble/`
- **macOS:** `~/Library/Application Support/ensemble/`
- **Windows:** `%APPDATA%\ensemble\`

## Config directory resolution

Ensemble resolves the configuration directory using this precedence:

1. `--config-dir <path>` CLI flag (highest priority)
2. `ENSEMBLE_CONFIG_DIR` environment variable
3. Platform-specific default config directory (lowest priority)

Both the CLI flag and environment variable support shell expansion (`~` for home directory, `$ENV_VAR` for environment variables).

**Example:**
```sh
# Using the --config-dir flag
ensemble run --config-dir ~/my-ensemble-config

# Using environment variable
ENSEMBLE_CONFIG_DIR=~/my-ensemble-config ensemble run

# With environment variable expansion
ENSEMBLE_CONFIG_DIR=$HOME/projects/ensemble ensemble run
```

**Open the config directory:**

```sh
ensemble open-config-dir
```

This opens the resolved configuration directory in your system's file manager. If the directory doesn't exist, it will prompt you to run `ensemble init` to create it.

**Legacy note:** The old `ENSEMBLE_CONFIG` environment variable and `--config` flag are no longer supported. Use `ENSEMBLE_CONFIG_DIR` and `--config-dir` instead.

## Auto-loading .env

If a `.env` file exists in the configuration directory, Ensemble automatically loads it before expanding `$VAR` references in the configuration. This means you don't need to manually source `.env` files—environment variables defined there are automatically available for config expansion.

## Config-relative paths

All relative paths in `config.yaml` are resolved relative to the configuration directory:

- `workspace.root` — resolved from config directory
- `repos[*].path` — resolved from config directory  
- `agents.*.prompt_template` — resolved from config directory

This makes configurations portable and self-contained.

## Minimal example

The smallest working config uses a local TODO file and a single agent:

```yaml
tracker:
  kind: todo_file
  # path defaults to ~/ensemble/TODO.md if not specified

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
  - path: repos/my-repo    # Relative to config directory
    branch: main

agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt_template: templates/implement.liquid  # Relative to config directory
  reviewer:
    runtime: direct
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
  root: workspaces  # Relative to config directory

hooks:
  after_create: "git checkout -b ensemble/$ISSUE_ID"
  before_run: "pnpm install"
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
| `path` | string | `~/ensemble/TODO.md` | Path to the TODO markdown file |

For todo_file trackers, if `path` is not specified, it defaults to `~/ensemble/TODO.md` (the `ensemble` directory in your home folder).

Todo file issue format:

- `- [ID] Title` (explicit ID) or `- Title` (ID auto-generated) are both valid.
- Indented lines under an item are treated as description text.
- Auto-generated IDs follow a stable `state-position` format (for example `todo-0`).
- When a no-ID item is moved between states, Ensemble may rewrite it to bracket form
  (`- [generated-id] Title`) to stabilize future state transitions.

### repos

List of repositories for workspace setup. Paths can be absolute or relative to the config directory.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | *required* | Path to repository (supports `$VAR`, `~`, and config-relative paths) |
| `branch` | string | *required* | Branch name to work on |

### agents

Named agent definitions. Each key is the agent name referenced by steps.

This section configures per-agent launch settings. Runtime ACP callback handling lives under the top-level `agent.*` section.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runtime` | string | inferred | Optional runtime override: `"acpx"` or `"direct"` |
| `executor` | string | — | Agent executable (e.g., `"claude-code"`) |
| `model` | string | — | Model identifier (e.g., `"claude-opus-4-6"`) |
| `acpx_agent` | string | — | ACPX agent name (alternative to executor+model) |
| `permission_mode` | string | — | ACPX launch-time permission mode for `acpx_agent`; supported values: `"approve_all"`, `"approve_reads"`, `"deny_all"`. Omit to preserve ACPX defaults. |
| `prompt` | string | — | Inline prompt text |
| `prompt_template` | string | — | Path to a Liquid template file (config-relative) |

**Validation rules:**
- Omit `runtime` to infer it automatically: `acpx_agent` => `acpx`, otherwise `direct`.
- `runtime: acpx` requires `acpx_agent`.
- `runtime: acpx` expects JSON-RPC protocol output on stdout; non-JSON-RPC stdout lines are treated as runtime errors.
- `runtime: direct` requires `executor` and `model`.
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
| `root` | string | system temp dir | Root directory for per-issue workspace directories (supports `$VAR`, `~`, and config-relative paths) |

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

This section configures Ensemble's runtime behavior after the agent is launched. It does not set per-agent ACPX launch flags; those belong in `agents.*`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_turns` | integer | `20` | Maximum agent conversation turns per session |
| `max_retry_backoff_ms` | integer | `300000` | Cap on exponential backoff delay between retries |
| `command` | string | `"claude-code"` | Agent binary command |
| `session_mode` | string | `"code"` | Agent session mode |
| `permission_request_policy` | string | `"auto_approve_all"` | Ensemble policy for handling ACP `session/request_permission` callbacks on direct runtime paths |
| `turn_timeout_ms` | integer | `3600000` | Maximum time for a single agent turn (1 hour) |
| `read_timeout_ms` | integer | `5000` | Timeout for reading agent output |
| `stall_timeout_ms` | integer | `300000` | Timeout for detecting a stalled agent |
| `inject_verdict_fallback_instructions` | boolean | `true` | Appends Ensemble-owned fallback instructions so agents can write `.ensemble/verdict.json` when no structured runtime verdict is emitted |

`agent.inject_verdict_instructions` is accepted as a shorter alias for `agent.inject_verdict_fallback_instructions`.

`agent.permission_request_policy` only applies to direct ACP runtime paths. If all configured agents resolve to the `acpx` runtime, leave this at its default. In mixed configurations, it still applies only to agents using the direct runtime; to customize permission handling for an `acpx`-resolved agent, switch that agent to `runtime: direct`.

Legacy note: `agent.permission_policy` is still accepted as a deprecated alias for `agent.permission_request_policy` during config parsing.

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
