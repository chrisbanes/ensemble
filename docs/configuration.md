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
  # Optional override for `gh auth token --hostname ...` fallback:
  # gh_hostname: github.com
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
    finalize:
      mode: push_and_pr
      approval_required: true

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
    timeout_ms: 600000
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
  inject_interaction_policy_instructions: true
  interaction_policy_overrides:
    agents:
      reviewer:
        mode: custom
        text: "Ask one clarifying question at a time for this review step."
```

## Reference

### tracker

Defines where Ensemble reads and writes issues.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kind` | string | *required* | Tracker backend: `"github"`, `"todo_file"`, or `"notion"` |
| `active_states` | list of strings | `["Todo", "In Progress"]` | States that make issues eligible for dispatch |
| `terminal_states` | list of strings | `["Done", "Closed"]` | States that mean an issue is finished |

**GitHub-specific fields** (when `kind: github`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `repository` | string | — | GitHub repo in `owner/name` format |
| `api_key` | string | — | GitHub token (use `$GITHUB_TOKEN`). If missing, Ensemble falls back to `gh auth token`. |
| `project_number` | integer | — | GitHub Projects v2 project number. If omitted, Ensemble uses repository labels whose names match configured tracker states for state reads/writes. |
| `endpoint` | string | `https://api.github.com/graphql` | Custom tracker API endpoint. For GitHub, this is the GraphQL endpoint (for GitHub Enterprise). For Notion, this overrides the Notion API base URL (`https://api.notion.com` by default). |
| `gh_hostname` | string | — | Hostname passed to `gh auth token --hostname` (overrides endpoint-derived host) |
| `labels_filter` | list of strings | `[]` | Only process issues with these labels |

**GitHub auth resolution order** (`kind: github`):

1. `tracker.api_key` (including `$VAR` expansion)
2. `GITHUB_TOKEN`
3. `gh auth token --hostname <resolved host>`

Hostname resolution for step 3:
1. `tracker.gh_hostname` (if set)
2. host derived from `tracker.endpoint` (`api.github.com` maps to `github.com`)
3. `ENSEMBLE_GH_HOST`
4. `GH_HOST`
5. `github.com`

### Editing secrets in the web and desktop configuration UI

Configuration responses never include resolved secret values. YAML mapping keys named exactly
`api_key`, `token`, `password`, or `secret` (case-insensitive) are treated as secret fields at any
nesting depth, including inside sequences. Literal values are displayed as `[REDACTED]`; `$VAR`
references remain visible so operators can see which environment variable is configured. Similar
names such as `tokenizer` and `secret_name` are not secret fields.

When saving raw YAML, `[REDACTED]` preserves the value currently stored at the same YAML path.
Replacing it with a literal or `$VAR` reference replaces the stored value, and removing the field
removes the value. A `[REDACTED]` placeholder without a corresponding stored secret is rejected.
Malformed YAML is never returned as raw configuration because it cannot be safely redacted.

Guided and setup editors use explicit secret actions: keep the current value, replace it with a
literal, use an environment variable, or remove it. Literal replacement inputs are write-only:
after save, the UI only reports that a secret is configured. New `config.yaml` files created by the
editors use owner-only permissions (`0600`) on Unix; existing file permissions are retained.
Configuration writes replace the file atomically from a temporary file in the same directory.

**Todo file fields** (when `kind: todo_file`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `~/ensemble/TODO.md` | Path to the TODO markdown file |

For todo_file trackers, if `path` is not specified, it defaults to `~/ensemble/TODO.md` (the `ensemble` directory in your home folder).

Todo file issue format:

- `- [ID] Title` (explicit ID) or `- Title` (ID auto-generated) are both valid.
- Indented lines under an item are treated as description text.
- Nested bullets under an item are kept in that issue's description, not parsed as separate issues.
- Auto-generated IDs follow a stable `state-position` format (for example `todo-0`).
- When a no-ID item is moved between states, Ensemble may rewrite it to bracket form
  (`- [generated-id] Title`) to stabilize future state transitions.
- Target states written by the tracker must be non-empty and must not contain newlines.

**Notion fields** (when `kind: notion`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notion.api_key` | string | — | Notion integration token (recommend `$NOTION_API_KEY`) |
| `notion.database_id` | string | — | Notion database ID to read/write |
| `notion.version` | string | `2022-06-28` | Notion API version header |
| `notion.title_property` | string | `Name` | Title property name in the database |
| `notion.status_property` | string | `Status` | Select/status property used for tracker state transitions |
| `notion.enabled_property` | string | `Ready to Implement` | Opt-in property required for candidate selection |
| `notion.enabled_value_bool` | bool | `true` | Required value for `enabled_property` when selecting candidates |

When `kind: notion`, `tracker.endpoint` may be used to override the Notion API base URL (default `https://api.notion.com`).

Example:

```yaml
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
    version: "2022-06-28"
    title_property: Name
    status_property: Status
    enabled_property: Ready to Implement
    enabled_value_bool: true
```

Notion candidate selection is based on:
- `status_property` in `active_states`
- `enabled_property == enabled_value_bool`

Notion writes:
- `set_issue_state` updates `status_property`
- `add_comment` posts a page comment

### repos

List of repositories for workspace setup. Paths can be absolute or relative to the config directory.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | *required* | Path to repository (supports `$VAR`, `~`, and config-relative paths) |
| `branch` | string | *required* | Branch name to work on |
| `finalize.enabled` | bool | `true` | Whether post-pipeline finalization is enabled for this repo |
| `finalize.mode` | string | `none` | Finalization action: `none`, `push`, or `push_and_pr` |
| `finalize.approval_required` | bool | `false` | Requires explicit approval from web/desktop UI before finalize runs |

`finalize.mode` defaults to `none`, so Ensemble does not push branches or open pull requests unless
you opt in per repo. Ensemble still records durable run artifacts for each completed issue,
including workspace paths, repo branch/HEAD/change metadata, per-step transcript metadata, and any
finalize output such as pushed refs or PR URLs when finalization runs.

**Headless behavior:** if `finalize.approval_required: true` and Ensemble is running headless, startup emits a warning and finalize is skipped for that repo.

**Migration note:** top-level `push_strategy` has been removed. Configure `repos[].finalize` instead.

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
| `reasoning_level` | string | — | Optional ACPX reasoning level passed as `--reasoning-level <value>` for `acpx_agent` agents. Common values are `"low"`, `"medium"`, and `"high"`; unsupported values are left to the selected agent/runtime to reject. |
| `prompt` | string | — | Inline prompt text |
| `prompt_template` | string | — | Path to a Liquid template file (config-relative) |

For `acpx_agent` entries, `model` is passed through the adapter's supported startup path. Most
agents use acpx's generic model flag. `acpx_agent: opencode` inserts `--model <model>` into
opencode's ACP startup command before `acp` because opencode does not advertise ACP generic model
selection. Runtime launches use acpx's configured opencode adapter command, including supported
overrides from `.acpxrc.json` or `~/.acpx/config.json`; capability discovery uses acpx's default
opencode adapter command.

**Validation rules:**
- Omit `runtime` to infer it automatically: `acpx_agent` => `acpx`, otherwise `direct`.
- `runtime: acpx` requires `acpx_agent`.
- `runtime: acpx` expects JSON-RPC protocol output on stdout; non-JSON-RPC stdout lines are treated as runtime errors.
- `runtime: direct` requires `executor` and `model`.
- Direct runtime command strings are parsed with shell-style quoting into program arguments, then launched without shell interpolation.
- Provide either `prompt` (inline) or `prompt_template` (file), not both.

### steps

Pipeline step definitions. Each step invokes one agent.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | *required* | Unique step identifier |
| `agent` | string | *required* | Name of an agent defined in `agents` |
| `kind` | string | `agent` | Step kind. Use `agent` for normal steps and `synthesis` for steps that merge direct dependency outputs. |
| `depends` | list of strings | — | Steps this depends on. Omit for sequential order. Use `[]` for no dependencies (root step). |
| `tracker_state` | string | — | Tracker state to write when this step starts |
| `timeout_ms` | integer | inherits `agent.turn_timeout_ms` | Optional maximum time for each runtime prompt or turn in this step |
| `approval.mode` | string | — | Optional post-step approval policy: `always` or `when_requested_by_agent` |
| `approval.state` | string | — | Optional tracker state to mirror while waiting for approval |

See [Pipeline Guide](pipelines.md) for details on DAG construction and execution.

Approval behavior:

- `approval.mode: always` pauses after the step succeeds and waits for explicit approval before any downstream step can start.
- `approval.mode: when_requested_by_agent` pauses only when the agent requests approval by writing `.ensemble/approval-request.json`.
- `approval.state` is only a tracker mirror for operators. The approval checkpoint inside Ensemble is the source of truth.
- Approving the gate resumes the pipeline from the next step. Rejecting the gate ends the pipeline through `on_failure`.

**Example with approval gate:**

```yaml
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
```

**Example with synthesis:**

```yaml
steps:
  - name: implement
    agent: builder
  - name: review-a
    agent: reviewer
    depends: [implement]
  - name: review-b
    agent: reviewer
    depends: [implement]
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
```

### on_success / on_failure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `on_success` | string | *required* | Tracker state when all pipeline steps pass |
| `on_failure` | string | *required* | Tracker state when any step fails |

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

Agent step results are extracted by Ensemble through a hidden second turn in the same runtime
session. There is no config switch for this behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_turns` | integer | `20` | Maximum agent conversation turns per session |
| `max_retry_backoff_ms` | integer | `300000` | Cap on exponential backoff delay between retries |
| `command` | string | `"claude-code"` | Agent binary command |
| `session_mode` | string | `"code"` | Agent session mode |
| `permission_request_policy.mode` | string | `"approve_all"` | Direct ACP permission policy: `approve_all`, `reject_all`, or `select_option` |
| `permission_request_policy.option_id` | string | — | Required when `mode: select_option`; must match an offered ACP `PermissionOption.option_id` |
| `turn_timeout_ms` | integer | `3600000` | Maximum time for a single agent turn (1 hour) |
| `read_timeout_ms` | integer | `5000` | Timeout for reading agent output |
| `stall_timeout_ms` | integer | `300000` | Timeout for detecting a stalled agent |
| `inject_interaction_policy_instructions` | boolean | `true` | Automatically appends Ensemble interaction policy guidance to prompts (batched clarifications as a soft preference) |
| `interaction_policy_text` | string | built-in default | Optional global replacement text for the injected interaction policy block |
| `interaction_policy_overrides.agents.<agent>.mode` | string | `inherit` | Per-agent override mode: `inherit`, `custom`, or `off` |
| `interaction_policy_overrides.agents.<agent>.text` | string | — | Required for useful `custom` overrides; policy text appended for that agent |
| `interaction_policy_overrides.steps.<step>.mode` | string | `inherit` | Per-step override mode. Step override wins over agent override |
| `interaction_policy_overrides.steps.<step>.text` | string | — | Required for useful `custom` per-step overrides |

Interaction policy override precedence is: `step override` → `agent override` → global `agent.*` defaults.

Use `mode: off` to suppress auto-injection for a specific agent or step.

`agent.permission_request_policy` only applies to direct ACP runtime paths. If all configured agents resolve to the `acpx` runtime, leave this at its default. In mixed configurations, it still applies only to agents using the direct runtime.

`select_option` is client-specific. It selects an offered ACP `PermissionOption.option_id` exactly and cancels the permission request if that option is not offered. Known option IDs for ACP clients should be documented as verified examples, not protocol guarantees.

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
