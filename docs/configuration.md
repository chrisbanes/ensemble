# Configuration Reference

## First-release configuration boundary

Operator-attention reporting is a runtime primitive backed by the shared workspace history
database. This release adds no `config.yaml` routing, kind, or development-method vocabulary for
attention; configured branch adapters may use the generic reporter in a later change.

Configuration serves one trusted local operator. ACPX-backed agents and sequential pipelines are
the supported first-release path. `agent.max_turns` is not a supported field and is rejected.
Changes to `workspace.root` or the ordered `repos` list persist but require an Ensemble restart
before activation; they do not live-replace process-scoped resources. `hooks.before_remove` runs
best-effort in the existing workspace before removal, and its failure or timeout does not block
cleanup.

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

## Web listener security

HTTP listener settings are command-line runtime settings, not `config.yaml` fields. The web and
desktop dashboards expose unauthenticated control and configuration APIs for one trusted local
operator. `ensemble web` defaults to `127.0.0.1` and rejects a resolved non-loopback `--host`
before loading configuration, starting watchers, or starting the orchestrator. The desktop host is
always loopback-only.

Remote binding is available only as this conspicuous opt-in:

```sh
ensemble web --host 192.168.1.20 --port 3000 --unsafe-allow-remote
```

`--unsafe-allow-remote` does not enable authentication, authorization, TLS, reverse-proxy trust, or
multi-user operation. It is unsupported and should only be used when the network boundary is fully
trusted. WebSocket upgrades require a syntactically valid HTTP(S) `Origin` whose authority exactly
matches `Host`; trusted-local listeners additionally accept only `localhost` or loopback IP hosts.

## Auto-loading .env

If a `.env` file exists in the configuration directory, Ensemble automatically loads it before expanding `$VAR` references in the configuration. This means you don't need to manually source `.env` files—environment variables defined there are automatically available for config expansion.

## Config-relative paths

All relative paths in `config.yaml` are resolved relative to the configuration directory:

- `workspace.root` — resolved from config directory
- `repos[*].path` — resolved from config directory  
- `agents.*.prompt_template` — resolved from config directory

This makes configurations portable and self-contained.

## Live reload boundary

The file watcher and all web/desktop save paths share one serialized config
transaction. Ensemble parses and prepares a candidate without publishing it,
quiesces the exact active orchestrator runtime, waits for its workers and
timeline/transcript persistence to drain, and then commits the config document,
observed file mtime, config-derived orchestrator values, and prepared runtime as
one generation. The replacement runtime cannot start until that commit is
complete.

`workspace.root` and the ordered `repos` list are the exception: they are
process-scoped resources, so saves persist their candidate configuration but do
not prepare or commit a replacement runtime. Restart Ensemble to activate them.

Invalid candidates, preparation failures, and a busy runtime leave the complete
last-known-good generation active. Their file mtime is not consumed, so the same
on-disk candidate is retried by a later watcher event or save without requiring
another edit. A runtime that timed out while quiescing is not relaunched; it
remains the registered owner until it finishes, after which a retry may replace
it.

When an API save persists a candidate but cannot activate it, the error response
describes the exact evaluated candidate in redacted form. A later external file
replacement is treated as a separate generation. A subsequent raw YAML,
guided-form, or setup retry resolves `[REDACTED]` and explicit preserve actions
against the latest persisted generation, while the running configuration stays
on the last-known-good generation until activation succeeds.

Setup-generated companion files such as prompt templates, TODO data, and `.env`
are published only after the prior runtime has quiesced and immediately before
the candidate config/runtime generation commits. Failed or deferred activation
before publication leaves the last-known-good companion files unchanged. An
interrupted partial publication leaves the runtime stopped and is recovered
before any retry or restart can dispatch work. Ensemble records setup payloads
and before-images in a private, versioned journal under
`.ensemble-state/pending-setup`, keyed to the SHA-256 digest of the exact raw
`config.yaml` bytes. Journal directories use owner-only access and secret-bearing
files use mode `0600` on Unix. The journal is internal recovery state, not a
public configuration file or setup workflow.

API retries, filesystem watcher retries, offline CLI setup, and process startup
all consume that same pending generation. Startup recovery completes before
workspace, history, timeline, transcript, or orchestrator resources are opened.
A matching partial publication resumes forward; an externally replaced config
causes destinations that still match the published generation to be restored
from their before-images. If a destination changed independently after
publication, recovery preserves it and blocks startup rather than overwriting
the newer contents. A malformed journal, unsafe permissions, or incomplete
rollback likewise blocks startup rather than launching against mixed config and
companion generations. Prepared runtimes retain the final configured template
and TODO paths and remain start-gated until publication and the active-state
commit finish.

`workspace.root` and the complete ordered `repos` configuration define process-scoped
filesystem resources. Changing either while Ensemble is running is saved to
disk but not activated: API saves return `409 Conflict`, and watcher reloads
emit a restart-required diagnostic. Restart Ensemble to apply the candidate.
The web and desktop configuration editors treat this response as a persisted
save and display the restart-required diagnostic instead of reporting a failed
save.
Diagnostics identify only the safe failure category and never include candidate
values or resolved secrets.

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
  github:
    status_field: Delivery state
    priority:
      field: Customer impact
      options: [Critical, Elevated, Normal]
    # Optional: adapter-owned exclusive claims and exact orphan-PR adoption.
    ownership:
      claim:
        claimed_state: Agent-owned
        resume_states: [Agent-owned, Recovering]
      delivery_adoption:
        repository: acme/my-project
        base_branch: main
        branch_template: ensemble/{issue_workspace_key}
        require_authenticated_author: true
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
      review_state: In review

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

acceptance:
  commands:
    - name: test
      run: cargo test --workspace
      timeout_ms: 900000

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
  max_concurrent_agents_by_state:
    todo: 2
    in review: 1
  turn_timeout_ms: 3600000
  inject_interaction_policy_instructions: true
  interaction_policy_overrides:
    agents:
      reviewer:
        mode: custom
        text: "Ask one clarifying question at a time for this review step."
```

## Reference

### GitHub Project field normalization

When `tracker.kind` is `github` and `project_number` is set, `tracker.github.status_field`
is required and names the Project single-select field used as the normalized issue state.
`tracker.github.priority` is optional; when present, its `field` and ordered `options` name the
single-select values that become generic priority ranks (first is rank 1). Omit `priority` to
disable priority normalization. Missing or unlisted selected values normalize to no priority,
and the Project item position is exposed as an optional numeric `tracker_position`: its zero-based
ordinal in a freshly fetched, complete `POSITION`-ordered Project-items snapshot. This ordinal is
not a durable identity; pagination cursors stay inside the GraphQL traversal and are never exposed
as `tracker_position`.

Each runtime preparation resolves these readable names uniquely to live GitHub IDs. A missing or
ambiguous field or option prevents the new configuration generation from replacing the
last-known-good runtime.

### acceptance

`acceptance` is optional. All four lists default to empty, which preserves the direct
pipeline-success-to-finalization behavior.

```yaml
acceptance:
  commands:
    - name: unit-tests
      run: cargo test --workspace
      timeout_ms: 900000
  required_files:
    - name: release-notes
      repo: ensemble
      path: docs/release-notes.md
  required_handoff_sections:
    - name: implementation-handoff
      step: implement
      sections: [summary, testing]
  required_pull_requests:
    - name: ensemble-pr
      repo: ensemble
```

Each command requires a unique, non-blank `name`, a non-blank `run` string, and a positive
`timeout_ms`. Ensemble preserves `run` exactly and executes it as `/bin/sh -lc <run>`; there is no
interpolation, command-specific environment, working-directory override, output-limit setting,
parallelism, or acceptance-specific retry option. Commands inherit the orchestrator environment,
run sequentially in declaration order in the issue workspace, and all commands run even after an
earlier command does not pass.

`required_files` runs next, in declaration order. Each entry needs a unique non-blank `name`, a
`repo` that resolves exactly one configured repository basename, and an exact non-empty
repository-relative `path` without `..`. The target must resolve inside Ensemble's owned worktree
and be a regular file; symlinks that escape the repository fail.

`required_handoff_sections` then checks the persisted `StepOutput.output` for a configured `step`.
It must be an object containing every configured non-blank, unique top-level section. Missing,
`null`, blank strings, empty arrays, and empty objects fail; `false` and `0` are present values.

`required_pull_requests` runs after repository finalization. Its `repo` must resolve exactly one
repository with `finalize.enabled: true` and `finalize.mode: push_and_pr`. It passes only when the
retained delivery record has a pull-request number and URL in `waiting` or `published`; it does not
search for or create a pull request.

Names must be unique across commands, files, handoffs, and pull requests. Config validation rejects
ambiguous repository basenames and invalid references before the service starts.

Commands, files, and handoffs start only after every pipeline step and approval gate has passed and
before repository finalization. Any non-passing pre-final check uses the existing whole-issue
`max_cycles` retry path and, on exhaustion, writes `on_failure`; per-step `on_failure` settings do
not apply. Pull-request requirements instead block the affected retained delivery and are retried by
the finalize-retry control. See [Pipeline Guide](pipelines.md#acceptance-requirements) for evidence,
recovery, and retry semantics.

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
Within a sequence, entries are matched one-to-one by a unique scalar `id`, then `name`; unnamed
entries fall back to their complete non-secret structure. Their numeric position is never an
identity. Reordering, inserting, or editing non-identity fields therefore cannot transfer a
credential to a different logical entry. After direct matches are claimed, one unmatched
`[REDACTED]` marker may map to one remaining stored entry by elimination, allowing an unambiguous
identity rename. Multiple unmatched or duplicate identities are rejected. Replacing the placeholder
with a literal or `$VAR` reference replaces the stored value, and removing the field removes the
value. Malformed YAML is never returned as raw configuration because it cannot be safely redacted.
If a persisted candidate has not activated yet, preservation uses that latest on-disk candidate,
not the older last-known-good runtime generation.

Guided and setup editors use explicit secret actions: keep the current value, replace it with a
literal, use an environment variable, or remove it. Literal replacement inputs are write-only:
after save, the UI only reports that a secret is configured. Blank literal and environment
replacements are rejected before configuration persistence, and environment names must match
`[A-Za-z_][A-Za-z0-9_]*`. New `config.yaml` files created by the editors use owner-only permissions
(`0600`) on Unix; existing file permissions are retained. Configuration writes replace the file
atomically from a temporary file in the same directory. Setup-generated secret companions and
private journal payloads use owner-only permissions; permission or rollback failures are reported
without including resolved values.

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
| `finalize.review_state` | string | none | Optional non-terminal tracker state projected after exact `push_and_pr` delivery |

`finalize.mode` defaults to `none`, so Ensemble does not push branches or open pull requests unless
you opt in per repo. Ensemble still records durable run artifacts for each completed issue,
including workspace paths, repo branch/HEAD/change metadata, per-step transcript metadata, and any
finalize output such as pushed refs or PR URLs when finalization runs.

For `push` and `push_and_pr`, Ensemble durably records the exact repository, branch, commit, and
remote identity before mutation. Restart recovery reconciles that stored identity with the remote
before retrying, so an ambiguous push or pull request response cannot silently duplicate
publication. A `push_and_pr` repository remains claimed in a non-capacity-consuming waiting state
after its uniquely matching pull request is found; merging or closing that pull request does not by
itself project the issue to `on_success`.

`finalize.review_state` is valid only with `push_and_pr`. It must be non-blank, must not be
`on_success` or a configured terminal state, and every opt-in pull-request repository for one
delivery must select the same target. Ensemble persists the issue-level projection as `pending`,
`in_flight`, `applied`, or `blocked`. It persists `in_flight` before writing to the tracker and
reconciles the exact target after every write. An unreadable, terminal, or unexpected observed
state blocks the retained delivery; a confirmed active-state absence may retry on a later poll.
The branch, SHA, pull-request identity, workspace, and claim remain retained throughout; this
state consumes no agent capacity and never uses `on_success` or cleanup.

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

### Pipeline configuration modes

Ensemble accepts exactly one of two pipeline modes:

- **Legacy mode** uses the top-level `steps`, `on_success`, and `on_failure` fields documented
  below. Existing single-pipeline configurations continue to use this mode.
- **Selected mode** defines named `pipelines`, capacity-limited `scheduler.lanes`, and an ordered
  `workflow_selection` rule list. Do not combine these fields with the legacy pipeline fields.

Selected mode keeps issue vocabulary in configuration rather than assigning semantic roles to
states or labels inside Ensemble:

```yaml
pipelines:
  delivery:
    steps:
      - name: build
        agent: builder
    on_success: Done
    on_failure: Failed
  planning:
    steps:
      - name: plan
        agent: planner
    on_success: Plan Review
    on_failure: Failed

scheduler:
  lanes:
    delivery:
      precedence: 10
      capacity: 3
    planning:
      precedence: 20
      capacity: 1
      idle_only: true
  resources:
    shared-sandbox:
      capacity: 1
  recovery:
    max_attempts: 3
    max_backoff_ms: 300000
  one_shot:
    deadline_ms: 300000

workflow_selection:
  - name: ready-delivery
    precedence: 10
    pipeline: delivery
    lane: delivery
    states: [Ready]
    labels_all: [ready-for-agent]
    labels_none: [hold]
    require_unblocked: true
    order_by: [priority, tracker_position, created_at]
  - name: requested-planning
    precedence: 20
    pipeline: planning
    lane: planning
    states: [Planning]
    labels_any: [needs-plan, revise-plan]
    order_by: [created_at]
  - name: alternate-vocabulary
    precedence: 30
    pipeline: delivery
    lane: delivery
    states: [Ausstehend]
    labels_all: [bereit]
    order_by: [tracker_position]
  - name: tail
    precedence: 100
    pipeline: delivery
    lane: delivery
    order_by: [created_at]
```

Each rule may constrain `states`, `labels_all`, `labels_any`, `labels_none`, and
`require_unblocked`. Omitted predicates are unconstrained, so a final catch-all rule is allowed.
State and label comparisons trim whitespace and ignore case. A supplied predicate list must be
non-empty and contain no blank or normalized-duplicate values.

Rules are evaluated by ascending positive `precedence`; the first matching rule selects one named
pipeline and one scheduler lane. Rule names and precedence values must be unique, and every
pipeline and lane reference must exist. Lanes have unique positive `precedence`; `capacity`, when
set, is a positive live-worker cap, while `idle_only` admits the lane only when no worker is live.
Named resources are positive-capacity unit pools. `scheduler.recovery.max_attempts` bounds all
automatic recovery paths; exhaustion retains the claimed run and asks an operator to provide fresh
evidence before resuming it. `scheduler.one_shot.deadline_ms` supplies the default deadline for
`ensemble run --once`. Every named pipeline is validated as a complete DAG with non-blank terminal
transitions.

`order_by` accepts `priority`, `tracker_position`, `created_at`, and `identifier`. Keys are applied
in their listed order, ascending, with null values last. Keys cannot repeat, and `identifier`, when
specified, must be final. Ensemble always adds `identifier` as the final deterministic tie-breaker
when it is omitted.

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
| `resource_requests` | map of string to integer | `{}` | Named scheduler resource units required atomically before the step starts |
| `affected_paths` | object | — | Output path source with `step` (direct dependency) and JSON `pointer`; normalized repository-relative paths are leased while the worker is live |

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
| `max_concurrent_agents` | integer | `4` | Worker-capacity cap; concurrent dispatch is not a first-release guarantee |
| `max_step_parallelism` | integer | `2` | Per-issue worker cap reserved for deferred multi-branch execution |

These limits count live agent workers, not claimed or running issues. Ensemble reserves global,
per-issue, and either the selected scheduler-lane slot or a configured legacy
`agent.max_concurrent_agents_by_state` slot atomically for each exact step worker before publishing
the step as running or launching its agent. This describes the
implemented capacity accounting, not a supported guarantee of parallel execution in the sequential
MVP. If any limit is full, the ready step remains pending without consuming a retry cycle. Pending
ready steps in claimed pipelines are reconsidered when worker capacity is released and before new
candidate issues are admitted on the next tick.

A worker keeps its reservation until its event bridge has closed and quiescence is proven.
Pre-launch errors roll back only the rejected worker's reservation; success, failure,
cancellation, and reconciliation likewise release only their exact worker identities. If one
step fails in deferred multi-branch execution, Ensemble cancels and drains its live sibling steps
before applying the configured retry or failure behavior.

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
| `before_remove` | string | — | Runs once in an existing issue workspace before worktree and directory removal; failures and timeouts are logged without blocking cleanup |
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

`agent.max_turns` is unsupported and rejected during configuration parsing. Remove it from
existing configurations: Ensemble cannot enforce provider-internal model turns.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_concurrent_agents_by_state` | map of positive integers | `{}` | Optional live-worker caps keyed by normalized tracker state |
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

State-cap keys are trimmed and lowercased when configuration is parsed and when a worker reserves
capacity. Blank keys, zero or negative limits, non-numeric limits, and distinct keys that collide
after normalization reject the complete configuration with an error naming
`agent.max_concurrent_agents_by_state` and the offending entry. Omitting the field is identical to
an empty map. States not present in the map have no additional state limit; the global and per-issue
limits still apply.

The exact live-worker registry is the sole state-cap authority. A worker retains the normalized
state bucket captured from its owning issue when it reserves; later tracker reconciliation does not
migrate or evict it. The next initial, downstream, restored, resumed, or capacity-deferred dispatch
uses the owning issue snapshot's latest reconciled state. A full bucket harmlessly leaves the step
pending and consumes no retry. Config generations remain immutable for active pipelines, replacement
uses the serialized prepare-quiesce-commit boundary, and restart restores no agent process or
persisted capacity ledger, so restored pending work makes a fresh reservation.

These limits describe implemented capacity, not guaranteed parallel execution in the trusted-local
sequential first release.

Interaction policy override precedence is: `step override` → `agent override` → global `agent.*` defaults.

Use `mode: off` to suppress auto-injection for a specific agent or step.

`agent.permission_request_policy` only applies to direct ACP runtime paths. If all configured agents resolve to the `acpx` runtime, leave this at its default. In mixed configurations, it still applies only to agents using the direct runtime.

Agent subprocesses do not inherit the orchestrator host's `GITHUB_TOKEN`. GitHub tracker and
delivery credentials stay at the host boundary; configure an explicit future credential mechanism
instead of depending on ambient token inheritance.

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

### GitHub ownership policy

`tracker.github.ownership` is optional. When omitted, GitHub, Notion, and TODO trackers keep their
existing dispatch behavior. `claim` configures an adapter-owned exclusive authenticated-assignee
claim: `claimed_state` and every non-empty `resume_states` entry are arbitrary configured normalized
state names. `resume_states` must include `claimed_state`, so a claim remains discoverable if the
runtime stops before its first journal append. The adapter must re-read remote evidence before reporting a lease; the orchestrator
receives only opaque ownership outcomes and remains the lifecycle authority.

`delivery_adoption` permits recovery of an unpersisted pull-request identity only when one pull
request matches the configured repository, base branch, rendered `branch_template`, and the stored
commit identity. The template must contain exactly one `{issue_workspace_key}` token and render a
valid Git branch. `require_authenticated_author` additionally requires the GitHub viewer to be the
PR author. A persisted delivery marker always takes precedence; foreign or multiple candidates are
conflicts and never cause a replacement pull request.
