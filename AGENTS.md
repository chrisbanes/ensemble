# Ensemble

Ensemble is a long-running Rust service that orchestrates multi-agent pipelines against an issue tracker. It reads work from trackers (GitHub Projects, todo files), creates isolated per-issue workspaces, runs named agents through a step DAG (build, review, etc.), collects strict `StepOutput` results, and drives tracker state transitions. Configuration lives in a configuration directory containing `config.yaml`.

See `docs/SPEC.md` for the full specification. See `docs/superpowers/plans/` for implementation plans.

## Project structure

```
ensemble/
├── Cargo.toml                    # workspace root
├── crates/
│   ├── ensemble-core/            # core library (domain model, config, workspace)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── error.rs          # EnsembleError, ConfigError, WorkspaceError, WorktreeError, PipelineError
│   │   │   ├── tracker/
│   │   │   │   ├── mod.rs        # IssueTracker trait (read + write), TrackerError
│   │   │   │   └── model.rs      # Issue, RunningEntry, RetryEntry, AgentTotals
│   │   │   ├── config/
│   │   │   │   ├── ensemble.rs   # config.yaml loader (EnsembleConfig)
│   │   │   │   ├── location.rs   # config directory resolution
│   │   │   │   └── template.rs   # Liquid prompt template renderer
│   │   │   ├── pipeline/
│   │   │   │   ├── mod.rs        # re-exports
│   │   │   │   ├── dag.rs        # DAG construction + validation
│   │   │   │   ├── engine.rs     # PipelineRun per-issue execution
│   │   │   │   └── verdict.rs    # StepOutput parsing and validation
│   │   │   └── workspace/
│   │   │       ├── manager.rs    # WorkspaceManager (create/reuse/cleanup directories + worktrees)
│   │   │       ├── coordinator.rs # WorktreeCoordinator (multi-repo worktree lifecycle)
│   │   │       ├── worktree.rs   # Core git worktree operations (create/remove/exists/pull)
│   │   │       ├── push_strategy.rs # PushStrategy enum (ask/auto_push/manual/pr_only)
│   │   │       └── hooks.rs      # Async hook runner with timeouts
│   │   └── tests/
│   │       └── workflow_to_workspace.rs  # integration test
│   ├── ensemble-cli/             # CLI binary
│   │   ├── build.rs              # optional SPA build + embed script (`web-ui` feature)
│   │   ├── src/
│   │   │   ├── main.rs           # CLI entry point, subcommand dispatch
│   │   │   ├── embedded_ui.rs    # rust-embed SPA serving (`web-ui` feature)
│   │   │   └── commands/
│   │   │       ├── mod.rs        # re-exports
│   │   │       ├── init.rs       # `ensemble init` interactive config wizard
│   │   │       ├── run.rs        # `ensemble run` headless orchestrator
│   │   │       └── web.rs        # `ensemble web` orchestrator + SPA + API (`web-ui` feature)
│   │   └── tests/
│   └── ensemble-desktop/         # Tauri desktop app
│       ├── build.rs              # tauri-build + SPA embed script
│       └── src/
│           ├── main.rs           # Tauri entry point, runtime management
│           ├── embedded_ui.rs    # rust-embed SPA serving for Tauri
│           └── orchestrator.rs   # Legacy desktop orchestrator wrapper (prefer shared bootstrap in server.rs)
└── .github/workflows/ci.yml     # CI: check, test, clippy, fmt
```

Future crates (not yet implemented): `ensemble-agent`, `ensemble-server`.

## Build and test

```sh
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

Default `ensemble-cli` builds are headless. Compile the web dashboard command with
`--features web-ui`; for Rust-only checks of that feature, use `SKIP_UI_BUILD=1`.

## Pre-push checklist

Before pushing commits, ensure all checks pass locally:

```sh
# Rust code
cargo test --workspace --exclude ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check

# Frontend code (if you modified UI files)
cd crates/ensemble-ui/src-ui
pnpm test
pnpm run build
```

CI will run these checks on your PR; failures block merge.

## CI

GitHub Actions runs on push to `main` and all PRs. The main CI job runs format, clippy,
default non-desktop Rust tests, the feature-enabled product E2E test, and a CLI
`web-ui` feature check. Frontend and desktop jobs run separately. All must pass.
`RUSTFLAGS=-Dwarnings` is set globally — treat warnings as errors.

## Release

**One-time setup:**
```sh
cargo install cargo-release
```

**Cutting a release:**
```sh
cargo release <version> --execute   # e.g. cargo release 0.2.0 --execute
```

This bumps versions in `Cargo.toml` + `tauri.conf.json`, commits, tags, and pushes. The tag push triggers release jobs in `.github/workflows/ci.yml` which:
1. Builds CLI binaries (macOS aarch64, Linux x86_64, Linux aarch64)
2. Builds macOS desktop `.dmg` (aarch64, signed + notarized) via Tauri Action
3. Creates a GitHub Release with all artifacts
4. Updates `chrisbanes/homebrew-tap` (formula for CLI, cask for desktop)

**Required GitHub secrets:** `HOMEBREW_TAP_TOKEN`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_PASSWORD`

## Code conventions

- **Compatibility policy**: Do not preserve backwards compatibility unless it is explicitly requested for the change. When choosing between compatibility and a better long-term design, prefer the option that is cleaner, more scalable, and easier to maintain, even if it requires more work upfront.
- **Rust 2021 edition**, minimum rust-version 1.80
- **Async traits**: The codebase currently uses the `async-trait` crate/macro. Follow the existing pattern in the surrounding module; prefer native `async fn` in traits only where it fits the existing interface and compatibility requirements.
- **Error handling**: `thiserror` enums (`EnsembleError`, `ConfigError`, `WorkspaceError`, `TrackerError`). Use `?` propagation, not `.unwrap()` in library code. Tests may unwrap. Return `anyhow::Result<()>` from executable `main` functions to avoid manual `process::exit` boilerplate.
- **Paths & Filesystem**: Prefer `dunce` for path canonicalization and `ignore` or `walkdir` for directory traversal to avoid complex custom filesystem logic. Prefer `camino::Utf8PathBuf` if string manipulation of paths is heavy.
- **Async runtime**: `tokio` with `features = ["full"]`. Async tests use `#[tokio::test]`.
- **Complex Algorithms**: Prefer established public libraries (e.g. `petgraph` for DAGs) over manual complex algorithms (like Kahn's algorithm or custom graph traversals).
- **Serialization**: `serde` + `serde_json` for domain types, `serde_yaml` for `config.yaml`.
- **Templates**: `liquid` crate for prompt rendering. Variables available: `issue.*` and optionally `attempt`.
- **Logging**: `tracing` crate. Use `info!`/`warn!`/`error!` with structured fields.
- **Tests**: Unit tests in `#[cfg(test)] mod tests` within each file. Integration tests in `crates/*/tests/`. Use `tempfile` for filesystem tests.
- **Formatting**: `cargo fmt` enforced in CI. Run before committing.
- **Clippy**: All warnings denied in CI. Fix clippy suggestions, don't suppress them.
- **Dependencies**: Declare in `[workspace.dependencies]`, reference with `{ workspace = true }` in crate Cargo.toml.
- **Module organization**: One responsibility per file. `mod.rs` files re-export submodules.

## Documentation maintenance

Before finishing any change, check whether it changes documented behavior. Update the relevant docs in the same branch when you change config schema/defaults, tracker semantics, pipeline behavior, runtime/agent launch behavior, CLI or API contracts, workspace lifecycle, release/build workflow, or user-visible UI behavior. Prefer `docs/SPEC.md` for canonical behavior, `docs/configuration.md` for config reference, `docs/pipelines.md` for pipeline/step-output behavior, and `docs/superpowers/specs/` or `docs/superpowers/plans/` for design/implementation history. If no docs need changes, call that out in the final summary.

## Git policy

- **No agent attribution**: Do not add `Co-Authored-By`, `Signed-off-by`, or any other trailer attributing work to an AI agent in commits, PR descriptions, or PR titles. Do not add "Generated by" or "Built with" lines to PR bodies. Do not modify git config (user.name, user.email) to reference an agent. Commits and PRs should look like they came from the human developer.

## Key design decisions

- **Pluggable trackers**: `IssueTracker` is an async trait in `ensemble-core` with read methods and optional write methods (default no-ops). Tracker implementations (GitHub, todo_file) live in `ensemble-core` as sub-modules of `tracker/`.
- **Config directory based**: All runtime config lives in a configuration directory containing `config.yaml`. `EnsembleConfig` provides typed access with defaults and `$ENV_VAR` resolution. The config directory is resolved via `--config-dir`, `ENSEMBLE_CONFIG_DIR`, or platform defaults. Agent definitions, step DAG, and prompt references are all defined in `config.yaml`. Relative paths are resolved from the config directory.
- **Agent model discovery**: During `ensemble init`, acpx agent sessions are probed to discover available models. The selected model is stored as `model` in `AgentConfig` and emitted in `config.yaml`.
- **Multi-agent pipelines**: Named agents run through a step DAG (GitHub Actions-style: sequential by default, `depends` for parallelism). The orchestrator drives state transitions at step boundaries and collects strict `StepOutput` results from hidden extraction turns.
- **Shared orchestrator startup**: `ensemble run`, `ensemble web` (when compiled with `web-ui`), and desktop/Tauri should all start the same real orchestrator runtime path. Do not add placeholder poll loops or separate per-frontend orchestrator implementations when the shared bootstrap can be reused.
- **Manual refresh behavior**: Refresh, retry, and resume controls should signal the orchestrator loop to run a tick; do not implement ad-hoc polling/state mutation in API or UI handlers that bypasses the orchestrator.
- **Workspace isolation**: Each issue gets a directory under a configurable root, keyed by sanitized identifier. Workspaces are reused across retries and cleaned up on completion.
- **Hook lifecycle**: Shell hooks (after_create, before_run, after_run, before_remove) run in workspace directories with configurable timeouts. Non-fatal hooks use best-effort mode.
