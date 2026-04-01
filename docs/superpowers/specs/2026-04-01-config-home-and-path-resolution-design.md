# Config Home and Path Resolution

## Overview

Ensemble currently assumes a cwd-relative `ensemble.yaml` in several entrypoints. That breaks down for the Tauri desktop app, where there is no stable working directory, and it also makes config-relative assets such as prompt templates and local TODO files depend on how the process was launched.

This design moves Ensemble to a per-user config home, renames the main file to `config.yaml`, and makes path resolution deterministic by resolving path-like config fields relative to the loaded config file instead of the process cwd.

## Goals

- Make desktop startup independent of cwd.
- Keep CLI usage friendly while allowing explicit overrides.
- Give Ensemble one canonical per-user config location.
- Rename `ensemble.yaml` to `config.yaml`.
- Make config-relative paths deterministic for templates, TODO files, repos, and workspace paths.

## Non-Goals

- Backward-compatibility search for repo-local `./ensemble.yaml`.
- Multi-profile or named-config support.
- Automatic migration tooling from old config filenames.

## Canonical Config Home

The default config directory is:

```text
dirs::config_dir()/ensemble
```

The canonical main config file is:

```text
<config_dir>/config.yaml
```

Examples:

- Linux: `~/.config/ensemble/config.yaml`
- macOS: `~/Library/Application Support/ensemble/config.yaml`
- Windows: `%AppData%\ensemble\config.yaml`

Supporting files live next to it by default:

- `templates/`
- `TODO.md` when using the `todo_file` tracker
- `.env` if the init flow writes one

## Resolution Precedence

Both CLI and desktop use the same shared resolution rules:

1. Explicit `--config <path>` resolves an exact config file path.
2. Explicit `--config-dir <dir>` resolves to `<dir>/config.yaml`.
3. `ENSEMBLE_CONFIG` resolves an exact config file path.
4. `ENSEMBLE_CONFIG_DIR` resolves to `<dir>/config.yaml`.
5. Default to `dirs::config_dir()/ensemble/config.yaml`.

Runtime CLI commands expose both `--config` and `--config-dir`.

Desktop has no CLI flag surface, but it honors both environment variables and otherwise falls back to the default config home.

### Conflict Handling

- `--config` and `--config-dir` are mutually exclusive in clap.
- If both `ENSEMBLE_CONFIG` and `ENSEMBLE_CONFIG_DIR` are set, treat it as a configuration error with a clear message instead of silently picking one.
- CLI flags always win over environment variables.

### Override Path Semantics

Override values may include `$ENV_VAR` and `~`.

After expansion:

- CLI resolves relative `--config`, `--config-dir`, `ENSEMBLE_CONFIG`, and `ENSEMBLE_CONFIG_DIR` values against the invocation cwd.
- Desktop rejects relative `ENSEMBLE_CONFIG` and `ENSEMBLE_CONFIG_DIR` values with a clear error and requires them to resolve to absolute paths.

This keeps the CLI shell-friendly while preserving the desktop guarantee that default startup and override handling do not depend on an implicit cwd.

## Relative Path Semantics

Once `config.yaml` is resolved, Ensemble treats the config file's parent directory as the base directory for path-like fields.

This applies to:

- `tracker.path`
- `agents.*.prompt_template`
- `repos[*].path`
- `workspace.root`

Resolution order for each path-like field:

1. Resolve `$ENV_VAR` if present.
2. Expand `~` if present.
3. If the resulting path is relative, join it against the directory containing `config.yaml`.
4. Preserve absolute paths unchanged.

This removes cwd sensitivity and lets users move the whole config directory without breaking adjacent files.

## Todo File Location

The config already has `tracker.path`; this remains the way users set the location of the local TODO tracker file.

For `tracker.kind: todo_file`:

- If `tracker.path` is set, use it after normal path resolution.
- If `tracker.path` is omitted, default it to `TODO.md` relative to the config directory.

That means the default todo tracker file becomes:

```text
<config_dir>/TODO.md
```

`ensemble init` should make this visible by prompting for the TODO file path and defaulting it to `TODO.md`.

## Entrypoint Behavior

### CLI

- Replace positional default config arguments with explicit shared config options.
- `ensemble run` and `ensemble web` resolve config through the shared resolver.
- Bare `ensemble` continues to default to `run`, using the same resolver.
- `ensemble init` supports `--config-dir` but not `--config`, and always writes the canonical `config.yaml` filename inside the resolved directory.
- If `<config_dir>/config.yaml` already exists, `init` prompts before overwrite. If the user accepts, it loads the existing config and uses it as the source of prompt defaults where possible.
- If the existing `config.yaml` cannot be parsed, `init` warns and continues with fresh defaults after the overwrite confirmation.
- `ensemble init` writes into the resolved config directory by default.
- If the config directory does not exist, create it before writing files.

### Desktop

- Resolve config before startup using the shared resolver.
- Do not call `set_current_dir()` as part of config discovery.
- Missing-config errors and dialogs should point to the resolved `config.yaml` path.
- Honor `ENSEMBLE_CONFIG` and `ENSEMBLE_CONFIG_DIR` for automation and debugging.

## Init Output

The init wizard should stop writing files into the process cwd. Instead it writes into the resolved config directory:

```text
<config_dir>/config.yaml
<config_dir>/templates/*.liquid
<config_dir>/TODO.md
<config_dir>/.env
```

Generated config examples and prompts should use `config.yaml`, not `ensemble.yaml`.

If the target config directory already contains a legacy `ensemble.yaml` but not `config.yaml`, `init` should show a targeted upgrade hint before writing a new config.

When `init` writes sibling files in an existing config directory:

- overwrite of `config.yaml` is controlled by the initial config overwrite confirmation
- existing `templates/*.liquid` files prompt individually before overwrite
- existing `TODO.md` prompts before overwrite when `todo_file` is selected
- existing `.env` prompts before overwrite

This keeps `init` non-destructive for adjacent user-managed files while still allowing the canonical config file to be refreshed intentionally.

## `.env` Loading

After resolving the final config file path, but before config parsing and `$VAR` substitution, Ensemble should attempt to load a sibling `.env` file from the config directory.

Rules:

- `.env` loading is optional; missing files are ignored.
- Values from `.env` do not override environment variables that are already set in the parent process.
- The `.env` file is always looked up relative to the resolved config file directory, not cwd.

This allows desktop and CLI launches to resolve values like `tracker.api_key: $GITHUB_TOKEN` consistently from `<config_dir>/.env`.

## Config Loader Changes

The current loader in `crates/ensemble-core/src/config/ensemble.rs` resolves `$VAR` and `~`, but it does not know the source config directory. That is the root cause of cwd-sensitive behavior.

The loader should be updated so that loading a config file includes source-aware path rebasing. A small shared module should own:

- default config home calculation
- precedence resolution for file vs directory overrides
- deriving `<dir>/config.yaml`
- rebasing relative config fields against the config file directory

`load_config()` should accept the resolved config file path, load a sibling `.env` file if present, and use the config file parent directory during path resolution.

## Error Handling

- When the resolved config file is missing, error messages must include the exact expected `config.yaml` path.
- Desktop missing-config dialogs must reference that resolved path, not a cwd-relative filename.
- `init` should print the full paths it created.
- If `dirs::config_dir()` returns `None`, fail with a clear error explaining that the config directory could not be determined and that `--config` or `--config-dir` can be used instead.
- If a resolved directory contains a legacy `ensemble.yaml` sibling but no `config.yaml`, include an upgrade hint such as "found legacy ensemble.yaml; rename it to config.yaml or pass --config <path>".
- If desktop receives a relative env-var override path, fail with a clear error instead of attempting cwd-based resolution.
- If both override env vars are set, fail with a clear configuration error.
- If `init` targets an existing `config.yaml`, the overwrite prompt must happen before any files are changed.

## Migration and Documentation

- Switch docs, tests, examples, and API status payloads from `ensemble.yaml` to `config.yaml`.
- Remove references to repo-root config discovery as the default model.
- Do not search for `./ensemble.yaml` automatically.
- Keep `ENSEMBLE_CONFIG` as the file override env var name and add `ENSEMBLE_CONFIG_DIR` as the directory override env var.
- Document that runtime commands accept both `--config` and `--config-dir`, while `init` accepts only `--config-dir`.
- Update init messaging so `.env` is described as auto-loaded from the config directory instead of telling users to `source` it manually.

## Testing

Add or update tests for:

- config resolution precedence across flags, env vars, and defaults
- deriving `config.yaml` from `--config-dir` and `ENSEMBLE_CONFIG_DIR`
- conflict errors for `--config` plus `--config-dir`, and for `ENSEMBLE_CONFIG` plus `ENSEMBLE_CONFIG_DIR`
- CLI relative override resolution against cwd
- desktop rejection of relative env-var overrides
- missing `dirs::config_dir()` handling
- sibling `.env` loading without overriding existing process env
- relative path rebasing for `tracker.path`, `prompt_template`, `repos[*].path`, and `workspace.root`
- default `TODO.md` placement under the config directory when `tracker.path` is omitted
- `init` writing files into the resolved config directory
- `init` loading an existing `config.yaml` for defaults after overwrite confirmation
- `init` refusing to overwrite an existing `config.yaml` when the user declines
- `init` behavior when a legacy `ensemble.yaml` exists in the target directory
- desktop missing-config behavior using resolved paths

## Files Likely Affected

- `crates/ensemble-core/src/config/ensemble.rs`
- `crates/ensemble-core/src/config/` (new shared config-location module)
- `crates/ensemble-core/src/tracker/mod.rs`
- `crates/ensemble-cli/src/main.rs`
- `crates/ensemble-cli/src/commands/init.rs`
- `crates/ensemble-cli/src/commands/init/generate.rs`
- `crates/ensemble-cli/src/commands/run.rs`
- `crates/ensemble-cli/src/commands/web.rs`
- `crates/ensemble-desktop/src/main.rs`
- docs and tests that currently reference `ensemble.yaml`

## Recommendation

Adopt a single per-user config home based on `dirs::config_dir()/ensemble`, keep CLI-friendly overrides via `--config` and `--config-dir`, and make all relative config paths resolve from the loaded `config.yaml` location. This fixes the Tauri cwd issue and makes configuration behavior consistent and portable across entrypoints.
