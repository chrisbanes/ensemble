# Config Home and Path Resolution

## Overview

Ensemble currently assumes a cwd-relative `ensemble.yaml` in several entrypoints. That breaks down for the Tauri desktop app, where there is no stable working directory, and it also makes config-relative assets such as prompt templates depend on how the process was launched.

This design moves Ensemble to a per-user config home, renames the main file to `config.yaml`, makes config-relative paths deterministic by resolving them relative to the loaded config directory, keeps TODO tracker state outside the config directory by default, and adds a CLI command to open the config directory in the system file manager.

## Goals

- Make desktop startup independent of cwd.
- Give Ensemble one canonical per-user config directory.
- Rename `ensemble.yaml` to `config.yaml`.
- Expose a single config-directory override model instead of separate file and directory concepts.
- Keep config assets relative to the config directory.
- Treat local TODO tracker data as state, not config.
- Add an ergonomic way to open the config directory from the CLI.

## Non-Goals

- Backward-compatibility search for repo-local `./ensemble.yaml`.
- Multi-profile or named-config support.
- Automatic migration tooling from old config filenames.
- A CLI mode for pointing at an arbitrary config filename.

## Canonical Config Home

The default config directory is:

```text
dirs::config_dir()/ensemble
```

The canonical config file is always:

```text
<config_dir>/config.yaml
```

Examples:

- Linux: `~/.config/ensemble/config.yaml`
- macOS: `~/Library/Application Support/ensemble/config.yaml`
- Windows: `%AppData%\ensemble\config.yaml`

Supporting config-adjacent files live there by default:

- `templates/`
- `.env` if the init flow writes one

Local TODO tracker state does not live in the config directory by default.

## Config Directory Resolution

Both CLI and desktop use the same shared config-directory resolution rules:

1. Explicit `--config-dir <dir>` for CLI runtime commands.
2. `ENSEMBLE_CONFIG_DIR` for CLI and desktop.
3. Default to `dirs::config_dir()/ensemble`.

After the config directory is resolved, the config file path is always derived as:

```text
<config_dir>/config.yaml
```

There is no separate `--config` or `ENSEMBLE_CONFIG` behavior.

### Conflict and Path Semantics

- There is only one override mechanism: config directory.
- Override values may include `$ENV_VAR` and `~`.
- CLI resolves relative `--config-dir` and `ENSEMBLE_CONFIG_DIR` values against the invocation cwd.
- Desktop rejects relative `ENSEMBLE_CONFIG_DIR` values with a clear error and requires an absolute path after expansion.
- The resolved config-dir target must either not exist yet or exist as a directory. If it exists as a file, fail with a clear error.
- If `dirs::config_dir()` returns `None`, fail with a clear error explaining that the config directory could not be determined and that `--config-dir` or `ENSEMBLE_CONFIG_DIR` can be used instead.
- If `~` expansion is required but the home directory cannot be determined, fail with a clear error instead of guessing.

This keeps the CLI shell-friendly while preserving the desktop guarantee that startup does not depend on an implicit cwd.

## Relative Path Semantics

Once `config.yaml` is resolved, Ensemble treats the config file's parent directory as the base directory for config-relative fields.

This applies to:

- `agents.*.prompt_template`
- `repos[*].path`
- `workspace.root`
- `tracker.path` when the user explicitly sets it to a relative path

Resolution order for each path-like config field:

1. Resolve `$ENV_VAR` if present.
2. Expand `~` if present.
3. If the resulting path is relative, join it against the directory containing `config.yaml`.
4. Preserve absolute paths unchanged.

This removes cwd sensitivity and lets users move the whole config directory without breaking config-adjacent assets.

## Todo File Location

The config still uses `tracker.path` to specify the TODO tracker file location.

For `tracker.kind: todo_file`:

- If `tracker.path` is set, use it after normal path resolution.
- If `tracker.path` is omitted, default it to `~/ensemble/TODO.md`.

Parent-directory behavior:

- `ensemble init` creates the parent directory for the resolved TODO file path before writing the file.
- Runtime commands do not create missing parent directories for the TODO file; they fail with a clear error naming the missing path.

That default is intentionally outside the config directory because the TODO file is treated as mutable state rather than configuration.

This means:

- config lives under `dirs::config_dir()/ensemble/`
- default TODO state lives under `~/ensemble/TODO.md`

`ensemble init` should make this visible by prompting for the TODO file path and defaulting it to `~/ensemble/TODO.md`.

## Entrypoint Behavior

### CLI Runtime Commands

- `ensemble run` and `ensemble web` resolve the config directory through the shared resolver.
- Bare `ensemble` continues to default to `run`, using the same resolver.
- Runtime commands accept `--config-dir` and do not accept `--config`.
- Old positional config-path invocation and `--config` should fail with clear help directing the user to `--config-dir`.

### CLI Init

- `ensemble init` supports `--config-dir` and always writes the canonical `config.yaml` filename inside the resolved directory.
- If `<config_dir>/config.yaml` already exists, `init` prompts before overwrite. If the user accepts, it loads the existing config and uses it as the source of prompt defaults where possible.
- If the existing `config.yaml` cannot be parsed, `init` warns and continues with fresh defaults after the overwrite confirmation.
- `ensemble init` writes into the resolved config directory by default.
- If the config directory does not exist, create it before writing files.

### Desktop

- Resolve config before startup using the shared config-directory resolver.
- Do not call `set_current_dir()` as part of config discovery.
- Missing-config errors and dialogs should point to the resolved `<config_dir>/config.yaml` path.
- Honor `ENSEMBLE_CONFIG_DIR` for automation and debugging.
- Ignore legacy `ENSEMBLE_CONFIG`; if set, report that only `ENSEMBLE_CONFIG_DIR` is supported.

## Init Output

The init wizard should stop writing files into the process cwd. Instead it writes config assets into the resolved config directory:

```text
<config_dir>/config.yaml
<config_dir>/templates/*.liquid
<config_dir>/.env
```

If `todo_file` is selected and the user accepts the default TODO path, `init` should also write:

```text
~/ensemble/TODO.md
```

If the user overrides `tracker.path`, `init` writes the TODO file at that resolved location instead.

Generated config examples and prompts should use `config.yaml`, not `ensemble.yaml`.

If the target config directory already contains a legacy `ensemble.yaml` but not `config.yaml`, `init` should show a targeted upgrade hint before writing a new config.

When `init` writes sibling files in an existing config directory:

- overwrite of `config.yaml` is controlled by the initial config overwrite confirmation
- existing `templates/*.liquid` files prompt individually before overwrite
- existing `.env` prompts before overwrite
- existing TODO files prompt before overwrite at their resolved target path

This keeps `init` non-destructive for adjacent user-managed files while still allowing the canonical config file to be refreshed intentionally.

## `.env` Loading

After resolving the final config directory, but before config parsing and `$VAR` substitution, Ensemble should attempt to load a sibling `.env` file from the config directory.

Rules:

- `.env` loading is optional; missing files are ignored.
- Values from `.env` do not override environment variables that are already set in the parent process.
- The `.env` file is always looked up relative to the resolved config directory, not cwd.

This allows desktop and CLI launches to resolve values like `tracker.api_key: $GITHUB_TOKEN` consistently from `<config_dir>/.env`.

## Open Config Directory Command

Add a CLI command:

```text
ensemble open-config-dir
```

Behavior:

- Resolve the config directory using the same `--config-dir` / `ENSEMBLE_CONFIG_DIR` / default rules.
- If the directory exists, open it in the platform file manager.
  - macOS: Finder via `open`
  - Linux: desktop opener such as `xdg-open`
  - Windows: Explorer via `explorer`
- If the directory does not exist, fail with a clear message showing the resolved path and direct the user to run `ensemble init`.
- The command does not create directories.

This command is for directory discovery and debugging, not initialization.

## Config Loader Changes

The current loader in `crates/ensemble-core/src/config/ensemble.rs` resolves `$VAR` and `~`, but it does not know the source config directory. That is the root cause of cwd-sensitive behavior.

The loader should be updated so that loading a config directory includes source-aware path rebasing. A small shared module should own:

- default config home calculation
- config-directory override resolution
- deriving `<config_dir>/config.yaml`
- rebasing relative config fields against the config directory
- default TODO state path derivation (`~/ensemble/TODO.md`)

`load_config()` should accept the resolved config file path, load a sibling `.env` file if present, and use the config file parent directory during path resolution.

## Error Handling

- When the resolved config file is missing, error messages must include the exact expected `<config_dir>/config.yaml` path.
- Desktop missing-config dialogs must reference that resolved path, not a cwd-relative filename.
- `init` should print the full paths it created.
- If a resolved directory contains a legacy `ensemble.yaml` sibling but no `config.yaml`, include an upgrade hint such as "found legacy ensemble.yaml; rename it to config.yaml".
- If desktop receives a relative `ENSEMBLE_CONFIG_DIR`, fail with a clear error instead of attempting cwd-based resolution.
- If `init` targets an existing `config.yaml`, the overwrite prompt must happen before any files are changed.
- If `open-config-dir` targets a missing directory, fail and direct the user to `ensemble init`.
- If legacy CLI or env override forms are used (`ensemble [PATH]`, `--config`, `ENSEMBLE_CONFIG`), fail with a migration hint to use config-directory-based resolution.
- If the default TODO path or a configured TODO path requires `~` expansion but the home directory cannot be determined, fail with a clear error.
- If the resolved config-dir target exists as a file rather than a directory, fail with a clear error.

## Migration and Documentation

- Switch docs, tests, examples, and API status payloads from `ensemble.yaml` to `config.yaml`.
- Remove references to repo-root config discovery as the default model.
- Do not search for `./ensemble.yaml` automatically.
- Keep only `ENSEMBLE_CONFIG_DIR` as the override env var.
- Document that runtime commands and `init` accept `--config-dir` only.
- Document migration away from legacy positional config arguments, `--config`, and `ENSEMBLE_CONFIG`.
- Document the new default separation between config (`dirs::config_dir()/ensemble`) and TODO state (`~/ensemble/TODO.md`).
- Update init messaging so `.env` is described as auto-loaded from the config directory instead of telling users to `source` it manually.
- Document `ensemble open-config-dir` and its failure behavior for missing directories.

## Testing

Add or update tests for:

- config-directory resolution precedence across flags, env vars, and defaults
- derivation of `<config_dir>/config.yaml`
- CLI relative `--config-dir` and `ENSEMBLE_CONFIG_DIR` resolution against cwd
- desktop rejection of relative `ENSEMBLE_CONFIG_DIR`
- failure behavior for legacy positional config path usage, `--config`, and `ENSEMBLE_CONFIG`
- failure when the resolved config-dir path is an existing file
- missing `dirs::config_dir()` handling
- missing home-directory expansion for `~` and the default TODO path
- sibling `.env` loading without overriding existing process env
- relative path rebasing for `tracker.path`, `prompt_template`, `repos[*].path`, and `workspace.root`
- default `~/ensemble/TODO.md` placement when `tracker.path` is omitted
- `init` writing config files into the resolved config directory
- `init` writing TODO state to the resolved tracker path
- `init` creating missing parent directories for TODO state output
- runtime failure when the resolved TODO parent directory is missing
- `init` loading an existing `config.yaml` for defaults after overwrite confirmation
- `init` refusing to overwrite an existing `config.yaml` when the user declines
- `init` behavior when a legacy `ensemble.yaml` exists in the target directory
- `open-config-dir` opening an existing directory
- `open-config-dir` failing with a helpful message when the directory is missing
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
- `crates/ensemble-cli/src/commands/` (new `open_config_dir.rs` or equivalent)
- `crates/ensemble-desktop/src/main.rs`
- docs and tests that currently reference `ensemble.yaml`

## Recommendation

Adopt a single per-user config directory based on `dirs::config_dir()/ensemble`, derive the config file as `<config_dir>/config.yaml`, expose only `config-dir` overrides, keep config-relative paths rooted in the config directory, default TODO tracker state to `~/ensemble/TODO.md`, and add `ensemble open-config-dir` for discoverability. This fixes the Tauri cwd issue while drawing a clean boundary between config and mutable local state.
