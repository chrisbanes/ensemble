# Practical Simplification Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the highest-value low-risk duplication and utility complexity across config loading, CLI/desktop bootstrap, API config editing, worktree git plumbing, and config-directory opening.

**Architecture:** Keep behavior stable while extracting shared helpers into `ensemble-core`, then simplify callers to use those helpers. Avoid the larger deferred refactors in orchestrator control flow, ACP transport, and tracker redesigns.

**Tech Stack:** Rust, tokio, axum, serde, thiserror, tracing, opener

---

### Task 1: Centralize config fallback and runtime-default helpers

**Files:**
- Modify: `crates/ensemble-core/src/config/draft.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/config/draft.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write failing tests for shared missing-config fallback behavior**

Add unit tests covering these exact behaviors:

```rust
#[test]
fn missing_config_state_has_missing_kind_and_no_active_config() {
    let path = PathBuf::from("/tmp/config.yaml");
    let state = missing_config_state(path.clone());
    assert_eq!(state.path, path);
    assert_eq!(state.kind, ConfigStateKind::Missing);
    assert!(state.active_config.is_none());
    assert!(state.raw_yaml.is_none());
}

#[test]
fn default_workspace_root_uses_temp_dir_ensemble_workspaces() {
    let expected = std::env::temp_dir()
        .join("ensemble_workspaces")
        .display()
        .to_string();
    assert_eq!(default_workspace_root(), expected);
}
```

- [ ] **Step 2: Run the targeted tests to confirm they fail**

Run:

```bash
cargo test -p ensemble-core missing_config_state_has_missing_kind_and_no_active_config
cargo test -p ensemble-core default_workspace_root_uses_temp_dir_ensemble_workspaces
```

Expected: FAIL because the new shared helpers do not exist yet.

- [ ] **Step 3: Implement `missing_config_state`, `load_config_document_or_missing`, and shared default workspace-root helper**

In `config/draft.rs`, add:

```rust
pub fn missing_config_state(path: PathBuf) -> ConfigDocumentState {
    ConfigDocumentState {
        path,
        kind: ConfigStateKind::Missing,
        raw_yaml: None,
        document: None,
        active_config: None,
        validation: DraftValidationReport::default(),
    }
}

pub fn load_config_document_or_missing(path: &Path) -> ConfigDocumentState {
    match load_config_state(path) {
        Ok(state) => state,
        Err(error) => {
            tracing::error!(error = %error, path = %path.display(), "failed to load config state");
            missing_config_state(path.to_path_buf())
        }
    }
}
```

In `config/ensemble.rs`, extract the repeated temp-dir workspace-root fallback into a shared helper:

```rust
pub fn default_workspace_root() -> String {
    std::env::temp_dir()
        .join("ensemble_workspaces")
        .display()
        .to_string()
}
```

Also make the adjacent config-loading behavior consistent with the simplification goal:

- change draft validation to use non-mutating `.env` reads instead of mutating process env during `parse_raw_yaml`
- keep `load_config()` returning `MissingConfigFile` only for `NotFound`, and preserve other read failures accurately

- [ ] **Step 4: Run the targeted tests to confirm they pass**

Run:

```bash
cargo test -p ensemble-core missing_config_state_has_missing_kind_and_no_active_config
cargo test -p ensemble-core default_workspace_root_uses_temp_dir_ensemble_workspaces
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint if requested**

Do not commit unless the user explicitly asks.

---

### Task 2: Extract shared API app bootstrap for CLI web and desktop server

**Files:**
- Create: `crates/ensemble-core/src/api/bootstrap.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-cli/src/commands/web.rs`
- Modify: `crates/ensemble-desktop/src/server.rs`
- Test: `crates/ensemble-core/src/api/bootstrap.rs`
- Test: `crates/ensemble-cli/src/commands/web.rs`
- Test: `crates/ensemble-desktop/src/server.rs`

- [ ] **Step 1: Write failing tests for shared bootstrap helper outputs**

Add focused unit tests in `crates/ensemble-core/src/api/bootstrap.rs` that verify the shared bootstrap helper:

- uses config-derived poll/concurrency values when a runnable config exists
- uses shared fallback defaults when no active config exists
- computes `history_path` under the chosen workspace root

Use a helper shape like:

```rust
let built = build_app_state(config_path.clone(), document_state, EventBus::new());
assert_eq!(built.history_path, PathBuf::from(&built.workspace_root).join("ensemble_history.jsonl"));
```

- [ ] **Step 2: Run the targeted bootstrap tests to confirm they fail**

Run: `cargo test -p ensemble-core build_app_state`

Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Implement `api/bootstrap.rs` with shared bootstrap helpers**

Create helpers with responsibilities split like this:

```rust
pub struct PreparedApp {
    pub app_state: AppState,
    pub has_runnable_config: bool,
}

pub fn orchestrator_state_from_document(
    document_state: &ConfigDocumentState,
) -> Arc<RwLock<OrchestratorState>> { ... }

pub fn workspace_root_from_document(document_state: &ConfigDocumentState) -> String { ... }

pub fn build_app_state(
    config_path: PathBuf,
    document_state: ConfigDocumentState,
    event_bus: EventBus,
) -> PreparedApp { ... }
```

Use `default_workspace_root()` and `missing_config_state()` from Task 1 instead of recreating defaults locally.

- [ ] **Step 4: Update CLI web mode to use the shared bootstrap helper**

In `crates/ensemble-cli/src/commands/web.rs`:

- replace direct `load_config_state` fallback construction with `load_config_document_or_missing`
- replace local orchestrator-state creation and workspace-root logic with `build_app_state`
- keep only CLI-specific path resolution, socket binding, loopback warning, and shutdown handling in this file

- [ ] **Step 5: Update desktop server startup to use the shared bootstrap helper**

In `crates/ensemble-desktop/src/server.rs`:

- remove local `create_orchestrator_state`, `determine_workspace_root`, and `default_workspace_path`
- use `load_config_document_or_missing` plus `build_app_state`
- keep only desktop-specific port binding, URL creation, and graceful shutdown handling in this file

- [ ] **Step 6: Run crate tests covering web and desktop startup**

Run:

```bash
cargo test -p ensemble-core build_app_state
cargo test -p ensemble-cli
cargo test -p ensemble-desktop start_desktop_server -- --test-threads=1
```

Expected: PASS.

---

### Task 3: Reduce config edit handler duplication

**Files:**
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Test: `crates/ensemble-core/src/api/config_edit_handler.rs`

- [ ] **Step 1: Add failing tests for shared config-save response paths**

Add tests that cover both raw YAML save and guided-form save producing the same success/error state-shaping behavior.

Example assertions:

```rust
assert_eq!(status, StatusCode::BAD_REQUEST);
assert!(!response.issues.is_empty());
assert_eq!(response.state, "parsed");
```

The purpose is to pin down the shared response shape before refactoring.

- [ ] **Step 2: Run the targeted config edit tests to confirm current coverage gaps**

Run: `cargo test -p ensemble-core config_edit_handler -- --test-threads=1`

Expected: at least one new test fails until the helper path is extracted.

- [ ] **Step 3: Extract shared helpers for save success and save failure**

In `config_edit_handler.rs`, add small helpers such as:

```rust
fn config_state_json(state: &ConfigDocumentState) -> Json<ConfigStateResponse> { ... }

fn config_error_json(
    current: &ConfigDocumentState,
    error: &ConfigError,
) -> Json<ConfigStateResponse> { ... }

async fn replace_document_state_from_yaml(
    doc_state: &mut ConfigDocumentState,
    config_path: &Path,
    raw_yaml: &str,
) -> Result<ConfigStateResponse, ConfigError> { ... }
```

Reuse these helpers from `save_yaml` and `save_guided_form`.

- [ ] **Step 4: Remove unnecessary `serde_json::to_value(...).unwrap()` wrapping where responses are already typed**

Prefer:

```rust
(StatusCode::OK, Json(response))
```

for handlers with stable response types instead of serializing to an intermediate `Value`.

- [ ] **Step 5: Apply local response hardening in the same handler**

While touching `config_edit_handler.rs`, also fix the two concrete response issues found during review:

- redact literal secrets consistently in both `raw_yaml` and guided-form response data, including inline YAML shapes handled by the redaction helper
- normalize `get_setup_defaults` so `has_existing_config` is exposed only at the top level instead of being duplicated inside `defaults`

- [ ] **Step 6: Run the targeted config edit tests again**

Run: `cargo test -p ensemble-core config_edit_handler -- --test-threads=1`

Expected: PASS.

---

### Task 4: Simplify controls and conversation handlers with shared helpers

**Files:**
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/conversation.rs`
- Test: `crates/ensemble-core/src/api/controls.rs`
- Test: `crates/ensemble-core/src/api/conversation.rs`

- [ ] **Step 1: Write failing tests for shared running/retrying lookup behavior**

Add tests for:

- stop returns `409` when identifier is retrying
- retry returns `409` when identifier is running
- both return `404` when identifier is absent

These likely exist partially already; add the missing edge cases first.

- [ ] **Step 2: Run the targeted API tests to verify the new cases fail if needed**

Run:

```bash
cargo test -p ensemble-core post_stop -- --test-threads=1
cargo test -p ensemble-core post_retry -- --test-threads=1
```

Expected: New edge-case test fails until the helper extraction is complete, or existing tests confirm coverage.

- [ ] **Step 3: Extract identifier-state lookup helpers in `controls.rs`**

Introduce a local enum and helper to avoid repeating the same branching logic:

```rust
enum IssuePresence {
    Running(String),
    Retrying(String),
    Missing,
}

fn find_issue_presence(state: &OrchestratorState, identifier: &str) -> IssuePresence { ... }
```

Use this in both `post_stop` and `post_retry`.

- [ ] **Step 4: Extract shared conversation file read helper in `conversation.rs`**

Add a local helper that preserves the existing distinction between the list and single-message endpoints. Prefer splitting path construction from file loading instead of forcing both handlers through one identical missing-file contract.

Use helpers shaped more like:

```rust
fn conversation_path(workspace_root: &str, workspace_key: &str) -> PathBuf { ... }

async fn read_conversation_file(path: &Path) -> Result<Option<String>, std::io::Error> { ... }
```

Use these helpers so both handlers share path creation and file reading, while each endpoint keeps its existing response behavior:

- list endpoint: missing file => `200` with empty result
- single-message endpoint: missing file => `404`

- [ ] **Step 5: Apply local correctness hardening in the touched handlers**

While simplifying these handlers, also fix the two concrete correctness issues found during review:

- `post_stop` should not report success if no valid agent PID exists or if sending `SIGTERM` fails
- conversation endpoints should return an error on malformed JSONL instead of silently dropping invalid lines

- [ ] **Step 6: Run the targeted API tests again**

Run:

```bash
cargo test -p ensemble-core post_stop -- --test-threads=1
cargo test -p ensemble-core post_retry -- --test-threads=1
cargo test -p ensemble-core conversation -- --test-threads=1
```

Expected: PASS.

---

### Task 5: Consolidate git worktree command execution

**Files:**
- Modify: `crates/ensemble-core/src/workspace/worktree.rs`
- Test: `crates/ensemble-core/src/workspace/worktree.rs`

- [ ] **Step 1: Add failing tests for shared git-command error mapping where practical**

If direct subprocess failure tests are awkward, add unit tests for the helper-level formatting and keep behavioral coverage in the existing worktree tests.

At minimum, add a unit test for the helper-generated command label so repeated call sites do not drift.

- [ ] **Step 2: Implement a shared async `run_git` helper**

In `worktree.rs`, add:

```rust
async fn run_git(
    repo_path: &str,
    args: &[&str],
    command_label: impl Into<String>,
) -> Result<std::process::Output, WorktreeError> { ... }
```

Responsibilities:

- spawn `git`
- set `current_dir`
- map spawn failures into `WorktreeError::GitCommandFailed`
- return raw output to the caller

- [ ] **Step 3: Refactor all worktree commands to use `run_git`**

Replace the repeated subprocess blocks in:

- `create_worktree`
- `attach_worktree`
- `worktree_exists`
- `branch_exists`
- `remove_worktree`
- `pull_worktree`

Keep each function’s semantic error mapping intact.

- [ ] **Step 4: Run worktree tests**

Run: `cargo test -p ensemble-core workspace::worktree -- --test-threads=1`

Expected: PASS.

---

### Task 6: Replace custom config-directory opener with a library

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/ensemble-cli/Cargo.toml`
- Modify: `crates/ensemble-cli/src/commands/open_config_dir.rs`
- Test: `crates/ensemble-cli/src/commands/open_config_dir.rs`

- [ ] **Step 1: Add the `opener` crate to workspace dependencies**

In the workspace dependencies section of `Cargo.toml`, add:

```toml
opener = "0.7"
```

Then reference it from `crates/ensemble-cli/Cargo.toml` using:

```toml
opener = { workspace = true }
```

- [ ] **Step 2: Write a failing test around the new open helper wrapper**

Because the external open call should not run in unit tests, introduce a tiny wrapper function that can be tested independently for error mapping.

Example shape:

```rust
fn map_open_result(result: Result<(), opener::OpenError>) -> Result<(), String> { ... }
```

Add tests for both success and error string formatting.

- [ ] **Step 3: Replace the per-OS command branches with `opener::open`**

Refactor `open_config_dir.rs` to:

- remove the three `#[cfg(target_os = ...)]` implementations
- call `opener::open(path)`
- convert the error to the existing `String`-based failure surface so CLI behavior stays stable

- [ ] **Step 4: Run CLI tests**

Run: `cargo test -p ensemble-cli open_config_dir -- --test-threads=1`

Expected: PASS.

---

### Task 7: Full verification

**Files:**
- Modify: only files changed by Tasks 1-6

- [ ] **Step 1: Run formatting**

Run: `cargo fmt --all`

Expected: no diff from formatting after this step.

- [ ] **Step 2: Run workspace tests**

Run: `cargo test --workspace`

Expected: PASS.

- [ ] **Step 3: Run clippy with warnings denied**

Run: `cargo clippy --workspace -- -D warnings`

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status
git diff --stat
```

Confirm the changes are limited to the simplification pass and do not touch the deferred refactor areas beyond necessary call-site updates.

- [ ] **Step 5: Commit checkpoint if requested**

Do not commit unless the user explicitly asks.
