# Desktop Setup And Config Editing — Design Spec

## Overview

Ensemble's current desktop out-of-the-box experience breaks down at the first-run moment: if the resolved `config.yaml` is missing from the config directory, the app exits and tells the user to run the CLI wizard. The web and desktop clients also treat configuration as read-only, even though setup and workflow changes are a core part of operating Ensemble.

This design adds an in-app setup experience equivalent to `ensemble init`, shared across desktop and web, and evolves the existing Config page into a hybrid config editor with first-class workflow editing.

## Decisions

| Topic | Decision |
|---|---|
| First-run behavior | If the resolved `config.yaml` is missing, desktop opens an in-app setup wizard instead of exiting |
| Web parity | The same setup/editor UI is available in `ensemble web`, not desktop-only |
| Editing model | Hybrid: guided forms for common configuration + raw YAML editor for advanced edits |
| Existing Config page | Replace read-only status view with an editable config workspace |
| Workflow editing | Guided workflow editor with step cards, dependency editing, and live validation |
| Validation model | Draft-based validation before save, using the same backend config and DAG validation as runtime |
| Save behavior | Explicit save with atomic write and reload of active config after success |

## Goals

- Make desktop usable on first launch without requiring the CLI
- Give the web client an equivalent to `ensemble init`
- Turn the current Config page into a real editor for existing configs
- Make workflow editing first-class instead of YAML-only
- Keep CLI, desktop, and web setup rules consistent by sharing backend logic

## Non-Goals

- Full round-trip preservation of all YAML formatting details
- Browser-native local file system integration beyond what the host platform already supports
- Editing prompt template file contents inside the first version of the workflow editor
- Replacing the CLI wizard; CLI init remains supported

## Product Shape

The app has one configuration surface with two top-level states:

1. **Setup Mode** - shown when no usable config exists yet
2. **Edit Mode** - shown when a config exists and can be loaded

This keeps the product easy to understand: the user always goes to the Config area for setup, reconfiguration, validation, and advanced edits.

## App Flow

### Desktop startup

Today, desktop exits early when the config file is missing. Instead, startup should branch into one of three paths:

1. **Config exists and loads cleanly** - start the app normally and open the standard shell
2. **Config file missing** - start the shell in Setup Mode
3. **Config file parses but is invalid** - start the shell in Edit Mode with the invalid config loaded as a draft and show validation errors immediately
4. **Config file has YAML syntax errors** - start the shell in a YAML-first recovery mode with the raw file contents loaded and syntax errors shown immediately; Guided mode stays disabled until parsing succeeds

This changes missing config from a fatal error into a recoverable application state.

### Web startup

`ensemble web` should support the same states as desktop:

1. Load existing config when present
2. Show Setup Mode when config is missing
3. Show Edit Mode with validation errors when config parses but is invalid
4. Show YAML-first recovery when the config cannot be parsed

This gives the web client a true equivalent of `ensemble init` instead of assuming setup happened elsewhere.

### Navigation

The existing Config route becomes the home for setup and editing:

- `Setup` subview when no config exists
- `Edit` subview when a config exists
- `YAML` subview for raw editing
- `Validation` subview or panel for current draft health

The rest of the dashboard remains read-focused and depends on a valid active config.

## Setup Wizard

The first-run wizard mirrors the current CLI flow but uses GUI controls instead of terminal prompts.

### Wizard steps

1. **Tracker** - choose GitHub Projects or `TODO.md`
2. **Tracker Details** - credentials, repo/project details, state mappings
3. **Repos** - add repo paths and target branches
4. **Agents** - discover available acpx agents, select which to use
5. **Agent Roles And Models** - assign role names and optional model selections
6. **Workflow** - choose default workflow or customize steps
7. **Validation** - run dry-run checks and show fixable failures
8. **Write Config** - save `config.yaml` into the resolved config directory and write generated companion files

### Desktop-specific behavior

- Repo selection can use native file pickers for local paths
- Missing-config launch lands directly in step 1 of the wizard
- After save, the app reloads config and transitions into the normal shell

### Web-specific behavior

- Repo entry is manual text input in the first version
- The same wizard layout and validation model are reused
- After save, the current web session reloads around the new active config

### Reconfigure flow

Users with an existing config can launch the wizard again via `Reconfigure`, which pre-populates fields from the current config and writes the updated result back through the same save pipeline.

## Config Editor

The existing Config page becomes a hybrid editor with two synchronized surfaces.

### Guided mode

Guided mode is the default editing surface for common configuration sections:

- tracker
- repos
- agents
- workflow steps
- runtime settings
- state transitions

It should feel like an editor, not just a status page: users can change values, add/remove entries, validate drafts, and save.

### YAML mode

YAML mode is a full raw text editor for advanced edits, unsupported fields, and direct config control.

It should provide:

- syntax-highlighted text editing
- parse and validation feedback
- save/reset actions
- visibility into file path and last-saved state

### Synchronization model

Both modes edit the same in-memory draft:

- Guided edits update the shared draft model
- YAML reflects the current draft when the document is valid enough to serialize
- YAML edits parse back into the same draft model
- If YAML cannot be parsed, Guided mode becomes temporarily read-only until parsing succeeds again

When startup begins from a YAML syntax error, the app starts directly in this recovery state rather than trying to construct a structured draft from invalid text.

### Preservation rule

If the YAML contains fields that Guided mode does not explicitly support yet, the system should preserve them on save rather than silently dropping them. If exact round-tripping is not practical in the first version, Guided mode must warn that formatting and unsupported field ordering may be normalized.

This preservation rule applies to Guided edits, raw YAML edits, and wizard-based reconfigure flows that start from an existing parseable config.

## Workflow Editing

Workflow editing is a first-class part of Guided mode, not just raw YAML.

### Workflow UI

Represent each step as an editable card or row with:

- step name
- assigned agent
- dependency list
- tracker state

Also show a compact visual summary of the current pipeline for quick scanning.

### Defaults

Provide the same quick-start defaults as CLI init:

- one selected agent -> single implement step
- two selected agents -> implement then review

### Guardrails

The workflow editor should prevent invalid structures where possible:

- default new steps to depend on the immediately previous step
- constrain dependency selection to existing steps
- warn before deleting a step that other steps depend on
- prevent duplicate step names
- surface cycle and missing-agent errors inline

### Scope boundary

The workflow editor configures steps and agent assignments, but does not edit prompt template file contents in the first version. Agent-level prompt/template configuration remains in agent editing or raw YAML.

## Backend Architecture

The setup/editor experience should not reimplement config rules in the UI. Instead, it should introduce shared backend services that both CLI and GUI can use.

### Shared responsibilities

Add a configuration management layer responsible for:

- loading config files, including invalid-or-missing states
- building draft configs from wizard inputs
- validating config schema and pipeline DAG
- writing config and template files atomically
- reloading active config after a successful save

This logic belongs in shared Rust code, with the CLI and API as separate adapters.

### API additions

Add config-management endpoints and commands for:

- get current config state, including missing/invalid cases
- validate a draft config without saving
- save a draft config
- start a setup session from default or existing values
- reload the active config after save

Validation responses should be structured enough for the UI to map issues to sections or fields, not only return a flat string list.

### Runtime state model

The backend needs to distinguish:

- no config loaded yet
- config loaded and valid
- config present but invalid

Today the app state assumes a loaded `EnsembleConfig`. This design requires a higher-level config lifecycle model so desktop and web can render setup or repair flows before the orchestrator is ready.

## Save And Reload Behavior

Config editing uses an explicit draft workflow:

1. Load existing config or start from an empty setup draft
2. User edits draft in Guided or YAML mode
3. User runs validation
4. User saves explicitly
5. Backend writes the updated files atomically
6. Backend reloads active config and notifies the UI

Save should fail safely:

- never partially overwrite `config.yaml`
- do not activate an invalid config
- keep the unsaved draft in memory when save fails
- clearly separate validation failures from environment failures like missing `acpx` or bad repo paths

### Validation tiers

The product should distinguish between two validation tiers:

1. **Config validity** - YAML parses, schema validation passes, and the pipeline DAG is valid
2. **Environment readiness** - external checks like `acpx` availability, tracker credentials, repo paths, and branch existence

Saving requires config validity, but does not require environment readiness. Environment failures should be shown as warnings or blockers for "ready to run" status, not as reasons to prevent writing a structurally valid config.

The setup wizard still runs both tiers before the final save step so the user can see likely runtime problems early, but it should preserve the CLI's ability to write the config anyway after acknowledging failed environment checks.

## Error Handling

The UI should separate three classes of problems:

1. **Config syntax errors** - YAML parse problems
2. **Config validation errors** - schema, missing fields, invalid DAG, unknown agent references
3. **Environment validation failures** - missing acpx, auth failures, repo/path issues, tracker access failures

This distinction matters because the recovery action is different in each case.

- syntax errors -> YAML-first recovery until parsing succeeds
- validation errors -> full Edit Mode with field-level guidance where possible
- environment failures -> allow save, but mark the config as not ready to run until fixed

## Testing

### Shared backend tests

- draft creation from wizard inputs
- validation for valid and invalid configs
- workflow validation and DAG failures
- atomic write behavior
- reload behavior after save

### UI tests

- first-run setup flow
- existing-config edit flow
- invalid-config recovery flow
- workflow editor validation feedback
- Guided <-> YAML synchronization states

### Desktop and web smoke tests

- launch with missing config
- launch with valid config
- launch with invalid config
- complete setup and transition into the normal app

## Files Likely Affected

- `crates/ensemble-desktop/src/main.rs` - replace fatal missing-config handling with setup-capable startup
- `crates/ensemble-desktop/src/orchestrator.rs` - support config lifecycle beyond "valid config already loaded"
- `crates/ensemble-core/src/api/config_handler.rs` - extend from read-only config response to config-management operations
- `crates/ensemble-core/src/api/router.rs` - register draft validation/save/setup routes
- `crates/ensemble-cli/src/commands/init.rs` and submodules - reuse shared setup/config assembly logic rather than duplicating rules
- `crates/ensemble-ui/src-ui/src/pages/ConfigStatus.tsx` - evolve from viewer to setup/editor workspace
- `crates/ensemble-ui/src-ui/src/hooks.ts` and generated API bindings - add save/validate/setup hooks

## Rollout Shape

This work should land in slices:

1. Backend support for missing/invalid config states plus draft validation/save APIs
2. Desktop startup no longer exits on missing config
3. Shared Setup Mode UI for desktop and web
4. Existing Config page upgraded into Guided + YAML editor
5. Guided workflow editor and reconfigure flow

This order improves the first-run experience early while keeping the editor grounded on shared backend primitives.
