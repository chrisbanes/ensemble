# Ensemble

Ensemble is a long-running Rust service that orchestrates coding agents against an issue tracker. It reads work from trackers (GitHub Projects, todo files), creates isolated per-issue workspaces, runs coding agent sessions, and provides observability.

See `SPEC.md` for the full specification. See `docs/superpowers/plans/` for implementation plans.

## Project structure

```
ensemble/
├── Cargo.toml                    # workspace root
├── crates/
│   └── ensemble-core/            # core library (domain model, config, workspace)
│       ├── src/
│       │   ├── lib.rs
│       │   ├── error.rs          # EnsembleError, ConfigError, WorkspaceError
│       │   ├── tracker/
│       │   │   ├── mod.rs        # IssueTracker trait, TrackerError
│       │   │   └── model.rs      # Issue, RunningEntry, RetryEntry, AgentTotals
│       │   ├── config/
│       │   │   ├── workflow.rs   # WORKFLOW.md loader (YAML front matter + prompt body)
│       │   │   ├── typed.rs      # ServiceConfig with defaults, env var resolution
│       │   │   └── template.rs   # Liquid prompt template renderer
│       │   └── workspace/
│       │       ├── manager.rs    # WorkspaceManager (create/reuse/cleanup directories)
│       │       └── hooks.rs      # Async hook runner with timeouts
│       └── tests/
│           └── workflow_to_workspace.rs  # integration test
└── .github/workflows/ci.yml     # CI: check, test, clippy, fmt
```

Future crates (not yet implemented): `ensemble-trackers`, `ensemble-agent`, `ensemble-server`, `ensemble-cli`, `ensemble-desktop`.

## Build and test

```sh
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

## CI

GitHub Actions runs on push to `main` and all PRs. Four parallel jobs: check, test, clippy, fmt. All must pass. `RUSTFLAGS=-Dwarnings` is set globally — treat warnings as errors.

## Code conventions

- **Rust 2021 edition**, minimum rust-version 1.80
- **Error handling**: `thiserror` enums (`EnsembleError`, `ConfigError`, `WorkspaceError`, `TrackerError`). Use `?` propagation, not `.unwrap()` in library code. Tests may unwrap.
- **Async runtime**: `tokio` with `features = ["full"]`. Async tests use `#[tokio::test]`.
- **Serialization**: `serde` + `serde_json` for domain types, `serde_yaml` for WORKFLOW.md front matter.
- **Templates**: `liquid` crate for prompt rendering. Variables available: `issue.*` and optionally `attempt`.
- **Logging**: `tracing` crate. Use `info!`/`warn!`/`error!` with structured fields.
- **Tests**: Unit tests in `#[cfg(test)] mod tests` within each file. Integration tests in `crates/*/tests/`. Use `tempfile` for filesystem tests.
- **Formatting**: `cargo fmt` enforced in CI. Run before committing.
- **Clippy**: All warnings denied in CI. Fix clippy suggestions, don't suppress them.
- **Dependencies**: Declare in `[workspace.dependencies]`, reference with `{ workspace = true }` in crate Cargo.toml.
- **Module organization**: One responsibility per file. `mod.rs` files re-export submodules.

## Git policy

- **No agent attribution**: Do not add `Co-Authored-By`, `Signed-off-by`, or any other trailer attributing work to an AI agent in commits or PRs. Do not modify git config (user.name, user.email) to reference an agent. Commits should look like they came from the human developer.

## Key design decisions

- **Pluggable trackers**: `IssueTracker` is an async trait. Implementations (GitHub, todo_file) will live in a separate `ensemble-trackers` crate.
- **Config from WORKFLOW.md**: All runtime config lives in YAML front matter of a `WORKFLOW.md` file. The markdown body is the prompt template. `ServiceConfig` provides typed access with defaults and `$ENV_VAR` resolution.
- **Workspace isolation**: Each issue gets a directory under a configurable root, keyed by sanitized identifier. Workspaces are reused across retries and cleaned up on completion.
- **Hook lifecycle**: Shell hooks (after_create, before_run, after_run, before_remove) run in workspace directories with configurable timeouts. Non-fatal hooks use best-effort mode.
