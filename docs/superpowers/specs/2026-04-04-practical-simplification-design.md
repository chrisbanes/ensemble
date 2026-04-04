# Practical Simplification Pass Design

## Summary

Implement the broad, low-risk simplification pass identified during review without changing the higher-risk runtime behavior of the orchestrator, ACP transport, or tracker integrations. The goal is to remove duplicated bootstrap and config plumbing, centralize repeated path and response helpers, and replace one obvious piece of custom platform code with a small public library.

## Scope

This pass includes four practical simplification buckets:

1. Shared config bootstrap and fallback state helpers
2. Shared CLI and desktop app bootstrap helpers
3. API response and config-save flow deduplication
4. Utility cleanup in worktree command execution and config-directory opening

This pass explicitly does not include the larger deferred refactors tracked in issues `#41` through `#44`.

## Design

### 1. Centralize config document and runtime defaults

The current code constructs fallback `ConfigDocumentState`, workspace-root defaults, and orchestrator-state defaults in multiple places. That duplication already diverges between CLI web mode and desktop mode.

Add shared helpers in the core config layer so both entry points use the same behavior:

- `missing_config_state(path: PathBuf) -> ConfigDocumentState`
- `default_workspace_root() -> String`
- `orchestrator_state_from_document(document_state: &ConfigDocumentState) -> Arc<RwLock<OrchestratorState>>`
- `load_config_document_or_missing(path: &Path) -> ConfigDocumentState`

While doing this cleanup, align the surrounding config-loading behavior with the same safety model:

- draft validation should read sibling `.env` files without mutating the process environment
- `load_config()` should preserve non-`NotFound` file-read failures instead of reporting every read error as “missing config file”

These helpers should live close to the existing draft config model so all callers use the same defaults and error fallback behavior.

### 2. Extract shared app bootstrap from CLI web and desktop server

`crates/ensemble-cli/src/commands/web.rs` and `crates/ensemble-desktop/src/server.rs` both:

- load config document state
- decide whether a runnable config exists
- build orchestrator state
- compute workspace root and history path
- build `AppState`
- merge API and SPA routers

Move that shared logic into a small `ensemble_core::api::bootstrap` module that exposes one or two helpers returning a prepared `AppState` and merged router inputs. Platform-specific code should remain responsible only for:

- resolving config directory paths
- providing the `EventBus`
- binding sockets
- choosing shutdown behavior
- choosing SPA asset provider/router

This keeps desktop and CLI behavior aligned without over-abstracting the actual server startup.

### 3. Deduplicate config edit and API response plumbing

The config editing endpoints repeat the same patterns for:

- save/validate/update document state
- build error responses from the current doc state
- wrap JSON payloads with `serde_json::to_value(...).unwrap()`

Simplify this by:

- adding small helper functions in `config_edit_handler.rs` for success and error response shaping
- returning typed `Json<T>` directly where the response type is static
- reusing one helper for the “save merged YAML and replace current document state” path shared by raw YAML save and guided-form save

This should reduce repetition without broad API churn.

As part of this same handler cleanup, fix two local response-hardening issues that are already in the touched code:

- apply secret redaction consistently to both `raw_yaml` and guided-form data returned by config endpoints
- normalize `get_setup_defaults` so `has_existing_config` is exposed in one consistent place instead of sometimes being duplicated inside `defaults`

For the API handlers simplified in this pass, also fix local correctness issues revealed by the cleanup:

- stop/retry controls should not report a running agent as stopped when no valid stop signal could be sent
- conversation endpoints should surface malformed JSONL as an error instead of silently dropping invalid lines and returning partial or misleading results

### 4. Centralize path and command utilities

There are several small repeated infrastructure patterns that should be unified now:

- path expansion and fallback path building should share one implementation instead of duplicating logic across config modules
- worktree git subprocess calls should go through a shared helper that runs git, captures stderr, and maps common failures consistently
- opening the config directory should use a small library rather than custom per-OS command branching

For the file-manager opening path, use a mature crate such as `opener` to replace the current hand-written `open` / `explorer` / `xdg-open` branching.

## Files

### Core config/bootstrap

- `crates/ensemble-core/src/config/draft.rs`
  Add shared fallback/loading helpers for missing config state.
- `crates/ensemble-core/src/config/ensemble.rs`
  Extract or reuse shared path-resolution utilities.
- `crates/ensemble-core/src/api/bootstrap.rs` (new)
  Add shared app bootstrap helpers for CLI web and desktop server.
- `crates/ensemble-core/src/api/mod.rs`
  Export bootstrap helpers.

### CLI and desktop integration

- `crates/ensemble-cli/src/commands/web.rs`
  Replace duplicated bootstrap logic with shared core helpers.
- `crates/ensemble-desktop/src/server.rs`
  Replace duplicated bootstrap logic with shared core helpers.
- `crates/ensemble-cli/src/embedded_ui.rs`
  Align with shared SPA helper shape; reduce duplication if practical.
- `crates/ensemble-desktop/src/embedded_ui.rs`
  Align with shared SPA helper shape; reduce duplication if practical.
- `crates/ensemble-desktop/src/orchestrator.rs`
  Reuse shared config validation/load helper if it falls out naturally.

### API simplification

- `crates/ensemble-core/src/api/config_edit_handler.rs`
  Extract shared save/response helpers.
- `crates/ensemble-core/src/api/controls.rs`
  Extract shared identifier lookup helpers for running/retrying issue actions.
- `crates/ensemble-core/src/api/conversation.rs`
  Reduce duplicated conversation file read/error handling if feasible in the same pass.

### Utility simplification

- `crates/ensemble-core/src/workspace/worktree.rs`
  Add shared `run_git` helper and simplify repeated subprocess/error mapping.
- `crates/ensemble-cli/Cargo.toml`
  Reference the shared `opener` dependency.
- `crates/ensemble-cli/src/commands/open_config_dir.rs`
  Replace custom OS branching with `opener`.
- `Cargo.toml`
  Add the new dependency in `[workspace.dependencies]` if introduced.

## Testing Strategy

- Update or add unit tests for shared config fallback helpers to verify missing-config behavior stays unchanged.
- Keep CLI web and desktop server startup tests green to prove bootstrap extraction preserves behavior.
- Add focused tests for any new config-save helper paths if existing tests do not already cover them.
- Run targeted `ensemble-core`, `ensemble-cli`, and `ensemble-desktop` test suites after each task cluster.
- Run workspace-wide `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, and `cargo fmt --all` before claiming completion.

## Deferred Work

The following items remain out of scope for this pass and are tracked separately:

- `#41` Replace custom TODO tracker parsing and file rewrite plumbing
- `#42` Refactor orchestrator lifecycle and side-effect handling
- `#43` Simplify ACP agent startup and transport handling
- `#44` Adopt typed GitHub GraphQL handling in tracker
