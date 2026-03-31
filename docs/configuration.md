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
