# Contributing

## Build and test

Ensemble is a Rust workspace. You need Rust 1.80+ installed.

```sh
cargo build --workspace          # compile
cargo test --workspace           # run all tests
cargo clippy --workspace -- -D warnings   # lint
cargo fmt --all -- --check       # check formatting
```

Run all four before pushing — CI enforces them.

## Project structure

```
ensemble/
├── crates/
│   ├── ensemble-core/     # Core library — domain model, config, tracker, pipeline,
│   │                      # orchestrator, workspace, agent, API
│   ├── ensemble-cli/      # CLI binary — `ensemble init` and `ensemble run`
│   ├── ensemble-ui/       # React dashboard (Vite + TypeScript + Tailwind)
│   └── ensemble-desktop/  # Tauri desktop wrapper
```

**ensemble-core** contains most of the logic:

| Module | Purpose |
|--------|---------|
| `config/` | `ensemble.yaml` parsing, prompt template rendering |
| `tracker/` | `IssueTracker` trait + GitHub and todo_file backends |
| `pipeline/` | DAG construction, step execution, verdict parsing |
| `orchestrator/` | Poll loop, dispatch, retry, reconciliation |
| `workspace/` | Directory management, lifecycle hooks |
| `agent/` | ACP client for stdio agent communication |
| `api/` | REST endpoints (axum) + WebSocket streaming |

## Code conventions

- **Error handling:** `thiserror` enums with `?` propagation. No `.unwrap()` in library code.
- **Async:** `tokio` runtime. Async tests use `#[tokio::test]`.
- **Serialization:** `serde` + `serde_yaml` for config, `serde_json` for domain types.
- **Logging:** `tracing` crate with structured fields.
- **Tests:** Unit tests in `#[cfg(test)] mod tests` within each file. Integration tests in `crates/*/tests/`. Use `tempfile` for filesystem tests.

## CI

GitHub Actions runs on push to `main` and all PRs. Four parallel jobs: check, test, clippy, fmt. All must pass. `RUSTFLAGS=-Dwarnings` is set globally.

## Further reading

- [SPEC.md](SPEC.md) — full service specification (language-agnostic)
- [superpowers/plans/](superpowers/plans/) — implementation plans used to build the codebase
