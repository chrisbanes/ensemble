# Config Dir and Todo State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Ensemble from cwd-relative `ensemble.yaml` to config-dir-based `config.yaml`, move the default TODO tracker state to `~/ensemble/TODO.md`, add `ensemble open-config-dir`, and update the living docs to match.

**Architecture:** Put config-directory resolution in a shared `ensemble-core::config::location` module so CLI and desktop both derive `<config_dir>/config.yaml` the same way. Make `load_config()` source-aware so config-relative paths rebase from the resolved config directory and a sibling `.env` is loaded before `$VAR` expansion. Then rework CLI, init, desktop startup, API strings, tests, and user-facing docs around the new config-dir-only model.

**Tech Stack:** Rust 2021, clap, dirs, dotenvy, serde_yaml, inquire, tauri, axum

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `Cargo.toml` | Modify | Add shared `dotenvy` dependency for config-dir `.env` loading |
| `crates/ensemble-core/Cargo.toml` | Modify | Add `dirs` and `dotenvy` to core |
| `crates/ensemble-core/src/error.rs` | Modify | Add config-dir/home-dir specific error variants |
| `crates/ensemble-core/src/config/mod.rs` | Modify | Export new config-location module |
| `crates/ensemble-core/src/config/location.rs` | Create | Shared config-dir resolution, `config.yaml` derivation, default TODO state path |
| `crates/ensemble-core/src/config/ensemble.rs` | Modify | Rebase relative paths from config dir, auto-load `.env`, default TODO path, rename docs/comments/tests to `config.yaml` |
| `crates/ensemble-core/src/tracker/mod.rs` | Modify | Stop hardcoding `TODO.md`; use resolved/default TODO path behavior |
| `crates/ensemble-core/src/api/router.rs` | Modify | Update `config_path` docs/tests to `config.yaml` semantics |
| `crates/ensemble-core/src/api/config_handler.rs` | Modify | Update config path expectations in API tests |
| `crates/ensemble-core/src/api/history_handler.rs` | Modify | Update hardcoded config path fixtures |
| `crates/ensemble-core/src/api/controls.rs` | Modify | Update hardcoded config path fixtures |
| `crates/ensemble-core/src/api/handlers.rs` | Modify | Update hardcoded config path fixtures |
| `crates/ensemble-core/tests/api_endpoints.rs` | Modify | Update API fixture expectations for `config.yaml` |
| `crates/ensemble-core/tests/workflow_to_workspace.rs` | Modify | Update config filename comments/fixtures if needed |
| `crates/ensemble-cli/src/main.rs` | Modify | Replace positional/`--config` flow with `--config-dir` and add `open-config-dir` subcommand |
| `crates/ensemble-cli/src/commands/mod.rs` | Modify | Export new `open_config_dir` command |
| `crates/ensemble-cli/src/commands/run.rs` | Modify | Resolve config dir into `<config_dir>/config.yaml` before loading |
| `crates/ensemble-cli/src/commands/web.rs` | Modify | Resolve config dir into `<config_dir>/config.yaml` before loading |
| `crates/ensemble-cli/src/commands/open_config_dir.rs` | Create | Open existing config dir in Finder/Explorer/etc or fail with init guidance |
| `crates/ensemble-cli/src/commands/init.rs` | Modify | Resolve config dir, load existing `config.yaml`, pass target dir into generation |
| `crates/ensemble-cli/src/commands/init/tracker.rs` | Modify | Default TODO prompt to `~/ensemble/TODO.md` and preserve existing `tracker.path` |
| `crates/ensemble-cli/src/commands/init/generate.rs` | Modify | Write `config.yaml` into config dir, write TODO state at resolved tracker path, write `.env` beside config |
| `crates/ensemble-desktop/src/main.rs` | Modify | Resolve config dir via shared resolver, reject legacy env usage, remove cwd mutation |
| `crates/ensemble-desktop/src/orchestrator.rs` | Modify | Keep logging/messages aligned with resolved `config.yaml` path |
| `crates/ensemble-desktop/tests/e2e.rs` | Modify | Use `ENSEMBLE_CONFIG_DIR` and `config.yaml` in smoke tests |
| `README.md` | Modify | Update quick start, config location, TODO default, and `open-config-dir` docs |
| `docs/configuration.md` | Modify | Document `config.yaml`, `--config-dir`, `ENSEMBLE_CONFIG_DIR`, default TODO state path, and config-relative asset behavior |
| `docs/pipelines.md` | Modify | Update examples to reference `config.yaml`-backed config dir layout |
| `docs/contributing.md` | Modify | Update module descriptions and config terminology |
| `docs/SPEC.md` | Modify | Replace living spec references to `ensemble.yaml` / repo-root config with `config.yaml` / config-dir model |
| `AGENTS.md` | Modify | Update contributor instructions to the new config-dir model |
| `CLAUDE.md` | Modify | Update contributor instructions to the new config-dir model |

---

### Task 1: Add Shared Config-Directory Resolution in `ensemble-core`

**Files:**
- Modify: `crates/ensemble-core/Cargo.toml`
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Create: `crates/ensemble-core/src/config/location.rs`
- Test: `crates/ensemble-core/src/config/location.rs`

- [ ] **Step 1: Write failing config-location tests**

Add inline tests in `crates/ensemble-core/src/config/location.rs` for:

```rust
#[test]
fn test_config_path_for_dir_appends_config_yaml() {
    let dir = PathBuf::from("/tmp/ensemble-config");
    assert_eq!(config_path_for_dir(&dir), dir.join("config.yaml"));
}

#[test]
fn test_resolve_cli_config_dir_allows_relative_override() {
    let cwd = Path::new("/tmp/project");
    let resolved = resolve_config_dir_for_cli(Some(Path::new("configs/dev")), None, cwd).unwrap();
    assert_eq!(resolved.config_dir, cwd.join("configs/dev"));
}

#[test]
fn test_resolve_desktop_config_dir_rejects_relative_env_override() {
    let err = resolve_config_dir_for_desktop(Some(OsString::from("configs/dev"))).unwrap_err();
    assert!(err.to_string().contains("relative"));
}

#[test]
fn test_default_todo_state_path_uses_home_ensemble_directory() {
    let home = Path::new("/tmp/home");
    assert_eq!(default_todo_state_path_from_home(home), home.join("ensemble").join("TODO.md"));
}

#[test]
fn test_resolve_cli_config_dir_prefers_flag_over_env() {
    let cwd = Path::new("/tmp/project");
    let resolved = resolve_config_dir_for_cli(
        Some(Path::new("flag-dir")),
        Some(OsString::from("env-dir")),
        cwd,
    )
    .unwrap();
    assert_eq!(resolved.config_dir, cwd.join("flag-dir"));
}

#[test]
fn test_resolve_cli_config_dir_uses_env_when_flag_missing() {
    let cwd = Path::new("/tmp/project");
    let resolved = resolve_config_dir_for_cli(None, Some(OsString::from("env-dir")), cwd).unwrap();
    assert_eq!(resolved.config_dir, cwd.join("env-dir"));
}

#[test]
fn test_resolve_config_dir_rejects_existing_file_target() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("not-a-dir");
    std::fs::write(&file_path, "x").unwrap();
    let err = validate_config_dir_target(&file_path).unwrap_err();
    assert!(err.to_string().contains("directory"));
}

#[test]
fn test_expand_override_supports_env_and_tilde() {
    std::env::set_var("ENSEMBLE_TEST_CONFIG_DIR", "/tmp/from-env");
    let resolved = expand_override_path("$ENSEMBLE_TEST_CONFIG_DIR").unwrap();
    assert_eq!(resolved, PathBuf::from("/tmp/from-env"));
}

#[test]
fn test_default_resolution_errors_when_config_dir_is_unavailable() {
    let err = default_config_dir_from(None).unwrap_err();
    assert!(err.to_string().contains("config directory"));
}

#[test]
fn test_default_todo_state_path_errors_without_home_dir() {
    let err = default_todo_state_path_from_optional_home(None).unwrap_err();
    assert!(err.to_string().contains("home"));
}
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run: `cargo test -p ensemble-core test_config_path_for_dir_appends_config_yaml -- --exact`
Expected: FAIL because `crates/ensemble-core/src/config/location.rs` and the helpers do not exist yet.

- [ ] **Step 3: Add the new module and error variants**

Create `crates/ensemble-core/src/config/location.rs` with a focused API like:

```rust
pub struct ResolvedConfigDir {
    pub config_dir: PathBuf,
    pub config_path: PathBuf,
}

pub fn config_path_for_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("config.yaml")
}

pub fn resolve_config_dir_for_cli(
    cli_override: Option<&Path>,
    env_override: Option<OsString>,
    cwd: &Path,
) -> Result<ResolvedConfigDir, ConfigError> { /* ... */ }

pub fn resolve_config_dir_for_desktop(
    env_override: Option<OsString>,
) -> Result<ResolvedConfigDir, ConfigError> { /* ... */ }

pub fn default_todo_state_path() -> Result<PathBuf, ConfigError> { /* ... */ }
```

Add matching `ConfigError` variants in `crates/ensemble-core/src/error.rs` for missing config-dir discovery, missing home directory, relative desktop overrides, and config-dir paths that point to files.

- [ ] **Step 4: Implement the full spec semantics in the resolver**

Make the resolver explicitly handle all spec rules:

```rust
// precedence: CLI flag > ENSEMBLE_CONFIG_DIR > dirs::config_dir()/ensemble
// expansion: first $ENV_VAR, then ~
// validation: target must not be an existing file
// desktop: relative ENSEMBLE_CONFIG_DIR is an error
// defaults: missing dirs::config_dir() / home directory are explicit errors
```

- [ ] **Step 5: Export the module and wire dependencies**

Update `crates/ensemble-core/src/config/mod.rs`:

```rust
pub mod ensemble;
pub mod location;
pub mod template;
```

Update `crates/ensemble-core/Cargo.toml` to include:

```toml
dirs = { workspace = true }
```

- [ ] **Step 6: Run the focused config-location test set**

Run: `cargo test -p ensemble-core config::location`
Expected: PASS — new config-location tests all pass.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/Cargo.toml crates/ensemble-core/src/error.rs crates/ensemble-core/src/config/mod.rs crates/ensemble-core/src/config/location.rs
git commit -m "Add shared config directory resolution helpers"
```

---

### Task 2: Make `load_config()` Config-Dir Aware and Auto-Load `.env`

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/ensemble-core/Cargo.toml`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/tracker/mod.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/tracker/mod.rs`

- [ ] **Step 1: Write failing loader tests for rebasing, `.env`, and TODO defaults**

Add tests in `crates/ensemble-core/src/config/ensemble.rs` like:

```rust
#[test]
fn test_load_config_rebases_relative_paths_from_config_dir() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("templates")).unwrap();
    std::fs::write(
        dir.path().join("config.yaml"),
        r#"
tracker:
  kind: todo_file
repos:
  - path: repos/app
    branch: main
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
workspace:
  root: workspaces
"#,
    ).unwrap();

    let config = load_config(&dir.path().join("config.yaml")).unwrap();
    assert_eq!(config.agents["builder"].prompt_template.as_deref(), Some(dir.path().join("templates/implement.liquid").as_path()));
    assert_eq!(config.repos[0].path, dir.path().join("repos/app").display().to_string());
    assert_eq!(config.workspace.root.as_deref(), Some(dir.path().join("workspaces").display().to_string().as_str()));
}

#[test]
fn test_load_config_defaults_todo_tracker_path_to_home_state_path() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config.yaml"), minimal_yaml_without_tracker_path()).unwrap();
    let config = load_config(&dir.path().join("config.yaml")).unwrap();
    assert!(config.tracker.path.unwrap().ends_with("ensemble/TODO.md"));
}

#[test]
fn test_load_config_loads_sibling_dotenv_without_overriding_existing_env() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".env"), "GITHUB_TOKEN=from-dotenv\n").unwrap();
    std::env::set_var("GITHUB_TOKEN", "from-process");
    std::fs::write(dir.path().join("config.yaml"), github_yaml_using_env()).unwrap();
    let config = load_config(&dir.path().join("config.yaml")).unwrap();
    assert_eq!(config.tracker.api_key.as_deref(), Some("from-process"));
}
```

Add a runtime validation test in `crates/ensemble-core/src/tracker/mod.rs` for the missing TODO parent directory case:

```rust
#[test]
fn test_create_todo_file_tracker_fails_when_parent_directory_is_missing() {
    let missing_parent = PathBuf::from("/definitely/missing/dir/TODO.md");
    let result = create_tracker(&todo_file_config(missing_parent));
    assert!(result.is_err());
}
```

- [ ] **Step 2: Run the first new loader test and verify it fails**

Run: `cargo test -p ensemble-core test_load_config_rebases_relative_paths_from_config_dir -- --exact`
Expected: FAIL because relative paths are still interpreted from process cwd, not the config directory.

- [ ] **Step 3: Add `dotenvy` and rework config loading**

Update dependencies:

```toml
# Cargo.toml
dotenvy = "0.15"

# crates/ensemble-core/Cargo.toml
dotenvy = { workspace = true }
```

Then update `crates/ensemble-core/src/config/ensemble.rs` so `load_config()`:

```rust
pub fn load_config(path: &Path) -> Result<EnsembleConfig, ConfigError> {
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));
    load_sibling_dotenv(config_dir)?;
    let content = std::fs::read_to_string(path).map_err(|_| ConfigError::MissingConfigFile {
        path: path.display().to_string(),
    })?;
    let mut config = parse_config(&content)?;
    config.resolve_env_from(config_dir)?;
    Ok(config)
}
```

And replace the old cwd-sensitive resolver with a base-dir-aware method:

```rust
pub fn resolve_env_from(&mut self, config_dir: &Path) -> Result<(), ConfigError> {
    // resolve tracker.api_key
    // resolve tracker.path; if missing for todo_file, inject default_todo_state_path()
    // resolve workspace.root, repos[*].path, agents.*.prompt_template relative to config_dir
}
```

- [ ] **Step 4: Make tracker fallback match the new default**

Update `crates/ensemble-core/src/tracker/mod.rs` so the fallback is no longer `PathBuf::from("TODO.md")`; use the shared default TODO state helper instead:

```rust
let tracker = todo_file::TodoFileTracker::new(
    config.path.clone().unwrap_or_else(|| default_todo_state_path().expect("todo path")),
    config.active_states.clone(),
);
```

Do not use `unwrap()` in final code; propagate a `TrackerError` or make the config loader populate `tracker.path` before tracker creation so the fallback is unreachable in normal runtime.

- [ ] **Step 5: Add explicit runtime validation for missing TODO parent directories**

Before constructing `TodoFileTracker`, validate that the resolved TODO parent directory exists for runtime commands. Return a clear error naming the missing parent path instead of silently creating directories during runtime.

- [ ] **Step 6: Run the focused core tests**

Run: `cargo test -p ensemble-core load_config`
Expected: PASS — the new load-config tests and existing load-config tests pass with `config.yaml` semantics.

- [ ] **Step 7: Run the full `ensemble-core` test suite**

Run: `cargo test -p ensemble-core`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/tracker/mod.rs
git commit -m "Make config loading relative to config directories"
```

---

### Task 3: Switch CLI Runtime Parsing to `--config-dir` and Add `open-config-dir`

**Files:**
- Modify: `crates/ensemble-cli/src/main.rs`
- Modify: `crates/ensemble-cli/src/commands/mod.rs`
- Modify: `crates/ensemble-cli/src/commands/run.rs`
- Modify: `crates/ensemble-cli/src/commands/web.rs`
- Create: `crates/ensemble-cli/src/commands/open_config_dir.rs`
- Test: `crates/ensemble-cli/src/main.rs`
- Test: `crates/ensemble-cli/src/commands/open_config_dir.rs`

- [ ] **Step 1: Write failing CLI parsing tests**

Add/update tests in `crates/ensemble-cli/src/main.rs` like:

```rust
#[test]
fn test_cli_parse_run_with_config_dir() {
    let cli = Cli::parse_from(["ensemble", "run", "--config-dir", "/tmp/ensemble"]);
    match cli.command {
        Some(Command::Run { config_dir }) => assert_eq!(config_dir, Some(PathBuf::from("/tmp/ensemble"))),
        other => panic!("expected Run, got {:?}", other),
    }
}

#[test]
fn test_cli_parse_open_config_dir_subcommand() {
    let cli = Cli::parse_from(["ensemble", "open-config-dir"]);
    assert!(matches!(cli.command, Some(Command::OpenConfigDir { .. })));
}

#[test]
fn test_cli_rejects_legacy_config_flag() {
    let err = reject_legacy_config_overrides(["ensemble", "run", "--config", "old.yaml"]).unwrap_err();
    assert!(err.contains("--config-dir"));
}
```

- [ ] **Step 2: Run the new CLI test and verify it fails**

Run: `cargo test -p ensemble-cli test_cli_parse_run_with_config_dir -- --exact`
Expected: FAIL because `Run` still accepts a positional config file path instead of `--config-dir`.

- [ ] **Step 3: Rework CLI argument structs around config directories**

Update `crates/ensemble-cli/src/main.rs` to remove the old positional config path and introduce a shared arg struct:

```rust
#[derive(clap::Args, Debug, Clone)]
struct ConfigDirArgs {
    #[arg(long, env = "ENSEMBLE_CONFIG_DIR")]
    config_dir: Option<PathBuf>,
}

enum Command {
    Init { #[command(flatten)] config: ConfigDirArgs },
    Run { #[command(flatten)] config: ConfigDirArgs },
    Web { #[command(flatten)] config: ConfigDirArgs, /* host/port */ },
    OpenConfigDir { #[command(flatten)] config: ConfigDirArgs },
}
```

Add a small `reject_legacy_config_overrides(std::env::args_os())` preflight before `Cli::parse()` so `--config`, `-c`, positional config paths, and `ENSEMBLE_CONFIG` fail with a migration hint to use `--config-dir` / `ENSEMBLE_CONFIG_DIR`.

- [ ] **Step 4: Resolve config dirs in runtime commands**

Update `run.rs` and `web.rs` so they accept `config_dir: Option<PathBuf>` and derive `config_path` via the new core helper before calling `load_config()`:

```rust
let cwd = std::env::current_dir().map_err(|e| /* print + exit */)?;
let resolved = resolve_config_dir_for_cli(args.config_dir.as_deref(), std::env::var_os("ENSEMBLE_CONFIG_DIR"), &cwd)?;
let config = load_config(&resolved.config_path)?;
```

- [ ] **Step 5: Add the `open-config-dir` command**

Create `crates/ensemble-cli/src/commands/open_config_dir.rs` with:

```rust
pub async fn execute(args: OpenConfigDirArgs) -> ExitCode {
    let cwd = std::env::current_dir().unwrap();
    let resolved = resolve_config_dir_for_cli(args.config_dir.as_deref(), std::env::var_os("ENSEMBLE_CONFIG_DIR"), &cwd)?;
    if !resolved.config_dir.exists() {
        eprintln!("error: config directory does not exist: {}", resolved.config_dir.display());
        eprintln!("run `ensemble init` to create it");
        return ExitCode::FAILURE;
    }
    open_in_system_file_manager(&resolved.config_dir)
}
```

Also add unit tests for missing-directory failure and the platform-specific command builder instead of spawning Finder/Explorer in tests.

- [ ] **Step 6: Run the full CLI test suite**

Run: `cargo test -p ensemble-cli`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-cli/src/main.rs crates/ensemble-cli/src/commands/mod.rs crates/ensemble-cli/src/commands/run.rs crates/ensemble-cli/src/commands/web.rs crates/ensemble-cli/src/commands/open_config_dir.rs
git commit -m "Switch CLI to config-dir based configuration"
```

---

### Task 4: Rework `ensemble init` to Write `config.yaml` and External TODO State

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init.rs`
- Modify: `crates/ensemble-cli/src/commands/init/tracker.rs`
- Modify: `crates/ensemble-cli/src/commands/init/generate.rs`
- Test: `crates/ensemble-cli/src/commands/init/tracker.rs`
- Test: `crates/ensemble-cli/src/commands/init/generate.rs`

- [ ] **Step 1: Write failing tests for init output paths**

Add tests in `crates/ensemble-cli/src/commands/init/generate.rs` like:

```rust
#[test]
fn test_write_files_writes_config_yaml_inside_target_config_dir() {
    let config_dir = tempfile::tempdir().unwrap();
    let todo_dir = tempfile::tempdir().unwrap();
    write_files(
        config_dir.path(),
        &todo_tracker_choice(todo_dir.path().join("TODO.md")),
        &sample_repos(),
        &sample_agents(),
        &sample_steps(),
        "Done",
        "Failed",
    ).unwrap();
    assert!(config_dir.path().join("config.yaml").exists());
    assert!(config_dir.path().join("templates/implement.liquid").exists());
}

#[test]
fn test_write_files_writes_todo_state_at_tracker_path() {
    let config_dir = tempfile::tempdir().unwrap();
    let todo_dir = tempfile::tempdir().unwrap();
    let todo_path = todo_dir.path().join("state/TODO.md");
    write_files(/* ... */).unwrap();
    assert!(todo_path.exists());
}

#[test]
fn test_write_files_declining_existing_config_yaml_aborts_before_writing_templates() {
    let config_dir = tempfile::tempdir().unwrap();
    std::fs::write(config_dir.path().join("config.yaml"), "existing").unwrap();
    // stub confirm -> false
    // assert config file unchanged and templates dir absent
}
```

Add init-level tests in `crates/ensemble-cli/src/commands/init.rs` for:

```rust
#[test]
fn test_init_warns_and_uses_fresh_defaults_when_existing_config_is_invalid() { /* ... */ }

#[test]
fn test_init_shows_legacy_ensemble_yaml_upgrade_hint() { /* ... */ }
```

Add a small default-path helper test in `tracker.rs`:

```rust
#[test]
fn test_default_todo_prompt_path_uses_home_ensemble_dir() {
    assert_eq!(default_todo_prompt_path(None), "~/ensemble/TODO.md");
}
```

- [ ] **Step 2: Run the first init generation test and verify it fails**

Run: `cargo test -p ensemble-cli test_write_files_writes_config_yaml_inside_target_config_dir -- --exact`
Expected: FAIL because `write_files()` still writes `ensemble.yaml` and `TODO.md` into the process cwd.

- [ ] **Step 3: Resolve the init target config directory**

Update `crates/ensemble-cli/src/commands/init.rs` so `InitArgs` carries `config_dir: Option<PathBuf>`, resolve it with the shared core helper, and load existing defaults from `<config_dir>/config.yaml` instead of `./ensemble.yaml`.

Use a flow like:

```rust
let cwd = std::env::current_dir()?;
let resolved = resolve_config_dir_for_cli(args.config_dir.as_deref(), std::env::var_os("ENSEMBLE_CONFIG_DIR"), &cwd)?;
let existing_config_path = resolved.config_path.clone();
```

Before prompting for overwrite, add the legacy migration check from the spec:

```rust
let legacy_path = resolved.config_dir.join("ensemble.yaml");
if legacy_path.exists() && !resolved.config_path.exists() {
    eprintln!("found legacy ensemble.yaml at {}; rename it to config.yaml", legacy_path.display());
}
```

If `config.yaml` exists but fails to parse, keep the warning-and-fresh-defaults flow explicit and test-covered.

- [ ] **Step 4: Change the TODO prompt default and file writer**

Update `crates/ensemble-cli/src/commands/init/tracker.rs` so the todo prompt default is:

```rust
let default_path = existing
    .and_then(|c| c.tracker.path.as_ref())
    .map(|p| p.to_string_lossy().into_owned())
    .unwrap_or_else(|| "~/ensemble/TODO.md".to_string());
```

Then update `write_files()` in `generate.rs` to accept a `config_dir: &Path` parameter and write:

```rust
std::fs::create_dir_all(config_dir)?;
std::fs::write(config_dir.join("config.yaml"), &yaml)?;
std::fs::create_dir_all(config_dir.join("templates"))?;
std::fs::write(config_dir.join(".env"), ...)?;

if let TrackerChoice::TodoFile { path } = tracker {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, generate_todo_md())?;
}
```

Keep the overwrite prompts, but point them at the resolved `config.yaml`, `.env`, template paths, and TODO target path.

- [ ] **Step 5: Update success messaging**

Change the init completion message to mention `config.yaml`, the resolved config directory, and `.env` auto-loading from that directory. Remove the old instruction that users should `source .env` manually.

- [ ] **Step 6: Guarantee overwrite prompts happen before any writes**

Structure `execute()` / `write_files()` so the overwrite decision for existing `config.yaml` happens before creating `templates/`, `.env`, or TODO parent directories. Keep this covered by a test that proves no side effects occur when the user declines overwrite.

- [ ] **Step 7: Run the full init-related test suite**

Run: `cargo test -p ensemble-cli init`
Expected: PASS — init and generation tests now pass with config-dir output.

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-cli/src/commands/init.rs crates/ensemble-cli/src/commands/init/tracker.rs crates/ensemble-cli/src/commands/init/generate.rs
git commit -m "Write init output to config directories"
```

---

### Task 5: Update Desktop Startup, API Fixtures, and Remaining Path Strings

**Files:**
- Modify: `crates/ensemble-desktop/src/main.rs`
- Modify: `crates/ensemble-desktop/src/orchestrator.rs`
- Modify: `crates/ensemble-desktop/tests/e2e.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/config_handler.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Modify: `crates/ensemble-core/tests/workflow_to_workspace.rs`

- [ ] **Step 1: Write failing desktop/API tests around `config.yaml` and `ENSEMBLE_CONFIG_DIR`**

Update tests first so they assert the new behavior:

```rust
#[test]
fn resolve_config_dir_prefers_env_override() {
    std::env::set_var("ENSEMBLE_CONFIG_DIR", "/tmp/ensemble");
    let resolved = resolve_config_dir();
    assert_eq!(resolved.config_dir, PathBuf::from("/tmp/ensemble"));
    assert_eq!(resolved.config_path, PathBuf::from("/tmp/ensemble/config.yaml"));
}

#[tokio::test]
async fn test_get_config_valid() {
    let state = build_app_state(test_config());
    let (_status, Json(response)) = get_config(State(state)).await;
    assert_eq!(response.config_path, "config.yaml");
}

#[test]
fn missing_config_message_mentions_resolved_config_yaml_path() {
    let resolved = ResolvedConfigDir {
        config_dir: PathBuf::from("/tmp/ensemble"),
        config_path: PathBuf::from("/tmp/ensemble/config.yaml"),
    };
    let message = format_missing_config_message(&resolved.config_path);
    assert!(message.contains("/tmp/ensemble/config.yaml"));
}
```

Update the desktop smoke test to write `config.yaml` and export `ENSEMBLE_CONFIG_DIR` instead of `ENSEMBLE_CONFIG`.

- [ ] **Step 2: Run one desktop unit test and verify it fails**

Run: `cargo test -p ensemble-desktop resolve_config_dir_prefers_env_override -- --exact`
Expected: FAIL because desktop still reads `ENSEMBLE_CONFIG` and defaults to `ensemble.yaml`.

- [ ] **Step 3: Remove cwd mutation from desktop startup**

Refactor `crates/ensemble-desktop/src/main.rs` so it:

```rust
let resolved = resolve_config_dir_for_desktop(std::env::var_os("ENSEMBLE_CONFIG_DIR"))?;
let config_path = resolved.config_path;

if std::env::var_os("ENSEMBLE_CONFIG").is_some() {
    eprintln!("Error: ENSEMBLE_CONFIG is no longer supported. Use ENSEMBLE_CONFIG_DIR.");
    std::process::exit(1);
}
```

Delete `change_to_config_directory()` and stop calling `set_current_dir()` entirely.

- [ ] **Step 4: Make missing-config UX explicit and tested**

Extract the desktop missing-config string construction into a small helper (for example `format_missing_config_message`) so unit tests can assert that both stderr output and dialog text include the fully resolved `<config_dir>/config.yaml` path.

- [ ] **Step 5: Update API/config path fixtures and smoke tests**

Replace remaining hardcoded `ensemble.yaml` fixture strings in the API modules/tests and desktop e2e test setup with `config.yaml` or resolved `<config_dir>/config.yaml` values.

For the desktop e2e smoke test, switch the setup to:

```rust
let config_dir = tempfile::tempdir().unwrap();
let config_path = config_dir.path().join("config.yaml");
Command::new(&binary_path)
    .env("ENSEMBLE_CONFIG_DIR", config_dir.path())
```

- [ ] **Step 6: Run focused desktop and API tests**

Run: `cargo test -p ensemble-desktop`
Expected: PASS (ignored e2e tests remain ignored, unit tests pass)

Run: `cargo test -p ensemble-core api`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-desktop/src/main.rs crates/ensemble-desktop/src/orchestrator.rs crates/ensemble-desktop/tests/e2e.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/config_handler.rs crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/handlers.rs crates/ensemble-core/tests/api_endpoints.rs crates/ensemble-core/tests/workflow_to_workspace.rs
git commit -m "Align desktop and API paths with config directories"
```

---

### Task 6: Update Living Docs and Contributor Guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/pipelines.md`
- Modify: `docs/contributing.md`
- Modify: `docs/SPEC.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README quick start and command docs**

Change `README.md` so it explains:

```md
- configuration lives in `<config_dir>/config.yaml`
- `ensemble init` creates that config directory
- `ensemble run --config-dir <dir>` overrides the config directory
- `ensemble open-config-dir` opens the existing config directory
- `ensemble open-config-dir` fails with a pointer to `ensemble init` when the directory does not exist
- legacy positional config paths, `--config`, and `ENSEMBLE_CONFIG` are no longer supported; use `--config-dir` / `ENSEMBLE_CONFIG_DIR`
- the default todo tracker state file is `~/ensemble/TODO.md`
```

- [ ] **Step 2: Update `docs/configuration.md` with the new model**

Replace the current repo-root `ensemble.yaml` narrative with:

```md
Ensemble is configured through `<config_dir>/config.yaml`, where the default config directory is `dirs::config_dir()/ensemble`.

Runtime commands accept `--config-dir`, and both CLI and desktop honor `ENSEMBLE_CONFIG_DIR`.

For `tracker.kind: todo_file`, omitting `tracker.path` defaults to `~/ensemble/TODO.md`.

Legacy positional config arguments, `--config`, and `ENSEMBLE_CONFIG` are unsupported and should be migrated to config-directory-based resolution.

`ensemble open-config-dir` opens the resolved config directory when it exists and otherwise fails with guidance to run `ensemble init`.
```

Update all YAML examples and field descriptions accordingly.

- [ ] **Step 3: Update the remaining living docs and guidance files**

Touch `docs/pipelines.md`, `docs/contributing.md`, `docs/SPEC.md`, `AGENTS.md`, and `CLAUDE.md` so they consistently say `config.yaml` / config-dir instead of `ensemble.yaml` / repo-root config.

Do **not** rewrite historical design docs under `docs/superpowers/specs/` or `docs/superpowers/plans/`; those are historical records.

- [ ] **Step 4: Run a docs consistency sweep**

Run:

```bash
rg -n 'ensemble\.yaml|ENSEMBLE_CONFIG([^_A-Z]|$)|TODO\.md' README.md docs AGENTS.md CLAUDE.md -g '!docs/superpowers/specs/**' -g '!docs/superpowers/plans/**'
```

Expected: only intentional migration notes remain; living docs reference `config.yaml`, `--config-dir`, `ENSEMBLE_CONFIG_DIR`, `~/ensemble/TODO.md`, the unsupported legacy override forms, and `open-config-dir` missing-directory guidance correctly.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/configuration.md docs/pipelines.md docs/contributing.md docs/SPEC.md AGENTS.md CLAUDE.md
git commit -m "Update docs for config-dir based configuration"
```

---

### Task 7: Run Full Verification and Final Cleanup

**Files:**
- Verify: all touched code and docs from Tasks 1-6

- [ ] **Step 1: Run workspace build**

Run: `cargo build --workspace`
Expected: PASS

- [ ] **Step 2: Run workspace tests**

Run: `cargo test --workspace`
Expected: PASS

- [ ] **Step 3: Run clippy with warnings denied**

Run: `cargo clippy --workspace -- -D warnings`
Expected: PASS

- [ ] **Step 4: Run formatting check**

Run: `cargo fmt --all -- --check`
Expected: PASS

- [ ] **Step 5: Run one final string-sweep for live code/docs**

Run:

```bash
rg -n 'ensemble\.yaml|ENSEMBLE_CONFIG([^_A-Z]|$)' crates README.md docs AGENTS.md CLAUDE.md -g '!docs/superpowers/specs/**' -g '!docs/superpowers/plans/**'
```

Expected: no stale living-code references remain except intentional migration-error strings.

- [ ] **Step 6: Commit any verification fixes**

If verification required code or docs edits:

```bash
git add -A
git commit -m "Fix verification issues for config-dir migration"
```

If verification passes without further edits, skip this commit.
