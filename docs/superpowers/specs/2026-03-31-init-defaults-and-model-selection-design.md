# Init: Existing Config Defaults & Model Selection

## Overview

Two improvements to `ensemble init`:
1. Load an existing `ensemble.yaml` and use its values as defaults throughout the wizard
2. After selecting acpx agents, probe each for available models and reasoning levels, then ask the user to configure them

## Change 1: Existing Config as Defaults

### Behavior

When `ensemble.yaml` exists:
- Load it with `EnsembleConfig::load_config()` (which also resolves env vars)
- If parsing fails, warn the user and proceed with a fresh wizard (no defaults)
- If parsing succeeds, thread `Option<&EnsembleConfig>` through each wizard step

The "overwrite?" confirmation remains. If the user says yes, the wizard starts but every prompt uses the existing value as its default.

### Per-section defaults

**Tracker (`ask_tracker`)**:
- Default tracker kind selection to existing `tracker.kind`
- TodoFile: default path to existing `tracker.path`
- GitHub: default `repository`, `project_number`, `api_key` env var name
- State mappings: default `active_states`, `terminal_states`, `on_success`, `on_failure`

**Repos (`ask_repos`)**:
- Pre-populate the repo list from existing `repos[]`
- Show each existing repo as a default entry; user can accept, modify, or remove
- After showing existing repos, continue the "add more" loop as today

**Agents (`discover_agents`)**:
- In the multi-select, pre-select agents that appear in the existing config (match by `acpx_agent` value)
- Default role names to existing role names (matched by `acpx_agent`)
- Default model to existing `model` value
- Default reasoning level to existing config options if present

**Pipeline (`ask_pipeline`)**:
- If existing steps match available agents, offer them as the default pipeline
- Default step names, depends, and tracker_state from existing config

### Implementation approach

Add an `existing: Option<&EnsembleConfig>` parameter to each `ask_*` function. Each function extracts relevant defaults from the config. `inquire` prompts use `.with_default()` for single-value inputs and pre-selected indices for multi-selects.

## Change 2: Model & Reasoning Discovery via acpx Probe

### Mechanism

acpx exposes agent capabilities through the ACP session protocol. When a session is created, the agent reports:
- `available_models` — list of model IDs the agent supports (e.g., `["default", "sonnet", "sonnet[1m]", "haiku"]`)
- `config_options` — typed configuration options, which may include a `thought_level` category with selectable values

This data is stored in the session record at `~/.acpx/sessions/<id>.json` under the `acpx` field.

### Probe flow

After the user multi-selects agents, for each selected agent:

1. Run `acpx <agent> sessions ensure --name ensemble-probe` to create a session
2. Read `~/.acpx/sessions/<id>.json` and extract:
   - `acpx.available_models` (array of strings)
   - `acpx.config_options` (array of `SessionConfigOption` — look for entries with `category: "thought_level"` and `type: "select"`)
3. Run `acpx <agent> sessions close ensemble-probe` to clean up

Probes run sequentially (each needs its own session lifecycle). If a probe fails (auth required, agent won't start, timeout), we skip model/reasoning questions for that agent silently.

### User prompts

During the role-naming loop, after naming each agent's role:

1. **Model selection** (if `available_models` has >1 entry):
   - `Select` prompt: "Model for <agent>?"
   - Options: the `available_models` list
   - Default: existing config value, or `"default"` if no existing config
   - If user picks `"default"`, store `None` (omit from YAML)

2. **Reasoning level** (if `config_options` includes a `thought_level` select):
   - `Select` prompt: "Reasoning level for <agent>?"
   - Options: extracted from the config option's selectable values, plus a "default" option
   - Default: existing config value, or `"default"`
   - If user picks `"default"`, store `None` (omit from YAML)

### Data model changes

```rust
// agents.rs
pub struct AgentEntry {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,           // None = agent default
    pub reasoning_level: Option<String>,  // None = agent default
}

// Probe result for a single agent
struct AgentCapabilities {
    available_models: Vec<String>,
    thought_levels: Vec<String>,  // extracted from config_options
}
```

### YAML generation changes

In `generate.rs`, when writing agent entries:

```yaml
agents:
  builder:
    acpx_agent: claude
    model: sonnet                    # only written if not None
    prompt_template: templates/implement.liquid
```

`model` is only emitted when `agent.model.is_some()`. Reasoning level is emitted as a separate field (e.g., `reasoning_level: high`) only when set.

### Session file discovery

To find the session JSON path, we parse the session ID from the `sessions ensure` stdout output (format: `<uuid>\t(created)` or just `<uuid>`), then construct the path as `~/.acpx/sessions/<uuid>.json`.

The `~/.acpx` path can be resolved via `$HOME/.acpx` or `dirs::home_dir()`.

### Error handling

- Probe timeout: wait up to 10 seconds for the session file to appear with model data
- Auth failure: `sessions ensure` exits with code 1 and message "Authentication required" — catch and skip
- Spawn failure: `sessions ensure` exits with code 1 — catch and skip
- Missing session file: skip
- Session file missing `acpx` field: skip (no models/config available)

All probe failures are non-fatal. The agent is still usable; it just won't have model/reasoning configured in the YAML (uses agent defaults).

## Files changed

- `crates/ensemble-core/src/config/ensemble.rs` — add `reasoning_level: Option<String>` to `AgentConfig`
- `crates/ensemble-cli/src/commands/init.rs` — load existing config, pass to wizard steps
- `crates/ensemble-cli/src/commands/init/agents.rs` — add model/reasoning fields, probe logic, prompts
- `crates/ensemble-cli/src/commands/init/tracker.rs` — accept existing config defaults
- `crates/ensemble-cli/src/commands/init/repos.rs` — accept existing config defaults
- `crates/ensemble-cli/src/commands/init/pipeline.rs` — accept existing config defaults
- `crates/ensemble-cli/src/commands/init/generate.rs` — emit model/reasoning_level fields
- `crates/ensemble-cli/src/commands/init/validate.rs` — no changes expected (validates same structure)

## Core config change

`AgentConfig` in `ensemble-core/src/config/ensemble.rs` already has `model: Option<String>`. We need to add `reasoning_level: Option<String>` so the generated YAML round-trips through `load_config()` without unknown-field errors. This is a simple additive change — add the field with `#[serde(default)]` and skip serialization when `None`.

## Out of scope

- Per-agent `--model` passthrough at runtime (separate concern for the pipeline engine)
- Runtime use of `reasoning_level` in the pipeline engine (future work)
