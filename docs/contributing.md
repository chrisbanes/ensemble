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

### Ignored live dogfood tracer bullet

`live_bamboon_issue_publishes_pull_request` is a deliberately expensive, explicitly opted-in
tracer bullet. It is local-only, ignored by default, never part of CI, and creates a real synthetic
issue in the private, operator-provisioned **Ensemble Dogfood** Project. It launches a real ACPX
agent against an issue-owned Bamboon worktree, so expect a runtime of several minutes; it incurs
network and model cost. The harness does not automate interactive first-run setup.
It does not close the MVP release gate: passing this test alone is not sufficient to release
Ensemble.

Run it only when you have the dedicated fixture and a clean Bamboon clone. The project number and
clone path are private local setup values: do not put either in shell history, documentation,
issues, or logs.

```sh
# Default routine mode
ENSEMBLE_LIVE_DOGFOOD=1 \
  ENSEMBLE_DOGFOOD_PROJECT_NUMBER=<local-project-number> \
  ENSEMBLE_DOGFOOD_BAMBOON_PATH=<absolute-clean-bamboon-clone> \
  SKIP_UI_BUILD=1 \
  cargo test -p ensemble-cli --features web-ui --test product_e2e \
  live_bamboon_issue_publishes_pull_request -- --ignored --nocapture
```

For a certification run, use the same invocation with the explicit preservation input:

```sh
ENSEMBLE_LIVE_DOGFOOD=1 \
  ENSEMBLE_LIVE_DOGFOOD_PRESERVE=1 \
  ENSEMBLE_DOGFOOD_PROJECT_NUMBER=<local-project-number> \
  ENSEMBLE_DOGFOOD_BAMBOON_PATH=<absolute-clean-bamboon-clone> \
  SKIP_UI_BUILD=1 \
  cargo test -p ensemble-cli --features web-ui --test product_e2e \
  live_bamboon_issue_publishes_pull_request -- --ignored --nocapture
```

`ENSEMBLE_LIVE_DOGFOOD=1` is the exact mutation opt-in. The harness validates the linked Project,
its empty fixture state and status mapping, GitHub/ACPX access, Bamboon identity, `main`, origin,
and clone cleanliness before creating an issue; it never repairs fixture drift. ACPX defaults to
the `codex` named agent; set a non-empty `ENSEMBLE_DOGFOOD_AGENT` only for an explicit local
override. The GitHub credential comes from `gh auth token` only after the opt-in gate, is passed to
the child host in memory as `GITHUB_TOKEN`, and is not written into generated YAML or diagnostics.

The tracer bullet creates one marker-owned Markdown artifact and commit. The agent may not publish:
after capturing that local commit, Ensemble alone pushes the generated branch and creates exactly
one open pull request at the captured SHA. It projects the Project issue to `In review` only after
the delivery record persists its remote branch and pull-request identity. The test prints the
redacted, run-scoped evidence location on success or failure.

After the complete two-host restart proof, default routine mode performs one fixed, fail-closed
sequence. It must revalidate and close the exact pull request. It then revalidates the exact Project
item and moves it to `Done` while the second host remains running. It waits for public terminal state,
zero claimed agent capacity, and removal of the captured worktree before stopping and reaping the
host. Only then does it revalidate and close the exact issue, remove its exact Project item, and
delete the exact generated remote ref if it is still at the stored SHA. Final checks require no
open synthetic issue or pull request, no Project item, no generated ref, no registered worktree,
and no active child process. The run directory, generated config, host logs, and evidence remain
for inspection, so a succeeding routine run can be repeated without external residue.

Preserve mode performs no GitHub or Git cleanup mutation. After the restart proof it only stops
and reaps the second host, then records `preserved_certification`. The synthetic issue, Project
item, generated branch, pull request, generated config, workspace/worktree, logs, and evidence stay
available as the human-reviewable certification bundle.

Once dispatch begins, the run retains one cumulative `<run-root>/evidence-v1.json` inspection
document with format `ensemble.live-dogfood-evidence` and schema version 1. It records a
pre-publication snapshot after local artifact, branch, and SHA validation but before any generated
remote branch or pull request; a post-delivery snapshot is appended only after the first host,
Project, history, Git, and pull-request observations agree. Only then does the harness stop the
first host. It starts a second host from the unchanged config, run root, and workspace root, then
appends one `post_restart` snapshot. This post-restart proof requires two configured polling intervals
showing the same retained delivery. It is black-box: it compares public host detail, state, and history with
the marker-scoped GitHub pull request, Git ref, and persisted worktree/transcript artifacts; it
does not inspect private orchestrator state. Its preserved failure snapshot records a redacted last
phase and assertions not reached. The document refers only to stable run identities and
repository-relative artifacts: it excludes the private Project value, credentials, absolute paths,
generated YAML, and raw command output. It also records the selected routine or preserve mode,
each ordered cleanup or preservation transition, the final absent state, and resources retained
intentionally.

Each host lifetime has separate relative log names: `host-1.stdout.log`, `host-1.stderr.log`,
`host-2.stdout.log`, and `host-2.stderr.log`. On a restart mismatch, timeout, ambiguous observation,
or partial cleanup failure, the harness stops the child, makes every later destructive transition
unreachable, and preserves the evidence plus every resource not already changed. A failed setup
before dispatch rolls back only the freshly created issue and Project item after revalidating their
stored node IDs and ownership. Any ambiguity stops that rollback too.

For failure recovery, use the `run_directory` printed by the test as the scope for the
deliberate cleanup procedure:

1. Read `evidence-v1.json`, the retained generated config, and both host log pairs to find the last
   successful transition. Evidence supplies the issue number, pull request, ref/SHA, and worktree;
   the local config supplies the private Project number. Do not copy the config into diagnostics or
   infer a target from a title, marker search, or broad branch pattern.
2. Before any mutation, revalidate each stored identity against fresh GitHub and Git observations: issue and Project
   item node ownership, pull-request number/URL/head/base/head SHA, generated full ref and SHA, and
   the worktree path beneath that run's workspace root. Stop if any read is missing, duplicated, or
   different.
3. Continue only the uncompleted suffix of the routine order: close the exact pull request; set the
   exact item to `Done`; confirm no live Ensemble claim; remove only the captured registered
   worktree; close the exact issue; remove the exact Project item; then delete the exact ref only if
   it still resolves to the captured SHA.
4. Re-query every surface and retain the run directory, logs, and evidence as the cleanup record.

This procedure is deliberately manual: preservation is safer than unattended mutation after a
partial or ambiguous run.

The harness writes `evidence-v1.json` by flushing a same-directory temporary file and atomically
replacing the prior document. If a replacement fails, the prior document and temporary diagnostic
are retained and the harness stops without cleanup or another publication attempt.

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
- [Architecture decisions](adr/) — durable architectural choices and rationale
- [Domain glossary](../CONTEXT.md) — canonical Ensemble terminology
