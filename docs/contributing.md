# Contributing

## Build and test

Ensemble is a Rust workspace. The minimum supported Rust version (MSRV) is Rust 1.95.
Normal development and primary CI use the exact Rust 1.97.0 toolchain pinned in
[`rust-toolchain.toml`](../rust-toolchain.toml); Rustup selects it automatically. The dedicated
MSRV compatibility job uses Rust 1.95.0.

With Rustup installed, these commands use the pinned normal toolchain:

```sh
cargo build --workspace          # compile default targets
cargo test --workspace           # run default Rust tests
cargo clippy --workspace -- -D warnings   # lint
cargo fmt --all -- --check       # check formatting
```

The CLI's embedded dashboard is optional. Default `ensemble-cli` builds are headless and do not
require Node, pnpm, OpenAPI generation, or frontend assets. To compile the web UI command from
source, generate the frontend inputs and enable the feature:

```sh
cd crates/ensemble-ui/src-ui
pnpm install --frozen-lockfile
pnpm run codegen
cd ../../..
cargo build -p ensemble-cli --features web-ui
```

For Rust-only checks that intentionally compile the `web-ui` feature without rebuilding frontend
assets, set `SKIP_UI_BUILD=1`.

To check MSRV compile compatibility locally, install and use Rust 1.95.0:

```sh
rustup toolchain install 1.95.0 --profile minimal
RUSTFLAGS= SKIP_UI_BUILD=1 cargo +1.95.0 check --workspace --all-targets
```

Run all four normal commands as a recommended local pre-push checklist. CI runs a subset in its
primary jobs and runs the MSRV check separately.
Exact Renovate updates to the primary Rust toolchain are review-only; changing the MSRV is a
separate, intentional compatibility decision.

## Product E2E

Run the local product E2E test with:

```sh
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
```

The test exercises the real `ensemble web` command, so it must compile the optional
`web-ui` feature. `SKIP_UI_BUILD=1` keeps the Rust E2E focused on backend product
behavior without rebuilding frontend assets; omit it when you specifically want to
verify frontend embedding as part of the build.

The test starts a real `ensemble web` server on localhost with a temporary
config directory, a todo-file tracker fixture, and mock `acpx`. It does not
require GitHub, Notion, real ACP credentials, or non-localhost network access.

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
| `config/` | `config.yaml` parsing, prompt template rendering, config directory resolution |
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

GitHub Actions runs on push to `main` and all PRs. A dedicated MSRV job uses Rust 1.95.0 to
check all workspace targets. Main, normal, frontend, and desktop jobs use the pinned Rust 1.97.0
toolchain from `rust-toolchain.toml`. The main CI job runs format, clippy, default non-desktop
Rust tests, the feature-enabled product E2E test, and a CLI `web-ui` feature check. Frontend and
desktop jobs run separately. All must pass. Primary jobs use `RUSTFLAGS=-Dwarnings`; the MSRV job
is a compile-compatibility check.

## Further reading

- [SPEC.md](SPEC.md) — full service specification (language-agnostic)
- [superpowers/plans/](superpowers/plans/) — implementation plans used to build the codebase
