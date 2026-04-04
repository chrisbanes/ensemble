# Codebase Simplifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the practical simplification pass by removing the remaining duplicated API/config utilities, tightening local correctness around stop/conversation endpoints, and centralizing repeated path and git-command helpers without changing orchestrator or tracker behavior.

**Architecture:** Shared missing-config/bootstrap helpers and `opener` integration are already present on this branch, so this plan focuses only on the unfinished simplification work still visible in the code. The work is split into small TDD tasks around config/path helpers, API response shaping, setup/agent probing, and test helper consolidation so each commit leaves the codebase simpler and behaviorally verified.

**Tech Stack:** Rust 1.80, Tokio, Axum, Serde/Serde JSON/YAML, `thiserror`, `tracing`, `opener`, existing `cargo test` integration tests.

---

## File Map

- `crates/ensemble-core/src/config/ensemble.rs`
  Owns runtime config loading, dotenv reading, path/env resolution, and default workspace-root behavior.
- `crates/ensemble-core/src/config/location.rs`
  Owns config-directory resolution and path expansion for CLI/desktop entry points.
- `crates/ensemble-core/src/config/setup.rs`
  Owns setup-form YAML generation/merge, setup artifact writing, tracker output path resolution, and agent discovery helpers.
- `crates/ensemble-core/src/config/draft.rs`
  Owns editable config document state, parse/validation flow, and missing-config fallback behavior.
- `crates/ensemble-core/src/api/config_edit_handler.rs`
  Owns config editing endpoints, setup defaults, guided-form merging, and config-save response shaping.
- `crates/ensemble-core/src/api/controls.rs`
  Owns stop/retry endpoints and local issue lookup / SIGTERM behavior.
- `crates/ensemble-core/src/api/conversation.rs`
  Owns conversation file loading, JSONL parsing, pagination, and single-message lookup.
- `crates/ensemble-core/src/api/handlers.rs`
  Owns general state/detail/refresh error and success envelopes.
- `crates/ensemble-core/src/api/router.rs`
  Owns API router composition and JSON 404 fallback.
- `crates/ensemble-core/src/api/fs_handler.rs`
  Owns filesystem listing endpoint and JSON API errors for I/O/path failures.
- `crates/ensemble-core/src/api/history_handler.rs`
  Owns history endpoint error handling.
- `crates/ensemble-core/src/api/bootstrap.rs`
  Already contains shared bootstrap helpers; use as the shared source for new test helpers instead of duplicating app-state assembly.
- `crates/ensemble-core/src/api/test_helpers.rs` (new)
  Will centralize repeated `AppState` construction helpers used across API module tests.
- `crates/ensemble-core/src/workspace/worktree.rs`
  Owns git worktree subprocess execution and error mapping.
- `crates/ensemble-core/src/api/mod.rs`
  Re-exports API modules; add `test_helpers` here behind `#[cfg(test)]` if needed.
- `crates/ensemble-core/tests/api_endpoints.rs`
  Integration coverage for config/setup endpoints; extend it when endpoint behavior changes.
- `docs/superpowers/specs/2026-04-04-practical-simplification-design.md`
  Source spec for this plan; keep scope aligned to the four simplification buckets and deferred-work exclusions.

---

### Task 1: Centralize Shared Path Resolution Helpers

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/config/location.rs`
- Modify: `crates/ensemble-core/src/config/setup.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/config/location.rs`
- Test: `crates/ensemble-core/src/config/setup.rs`

- [ ] **Step 1: Write the failing tests for the shared path helper behavior**

Add/adjust unit tests to cover one shared contract from three call sites:

```rust
#[test]
fn resolve_relative_to_base_joins_relative_paths() {
    let resolved = resolve_relative_to_base(Path::new("tracker/issues.md"), Path::new("/tmp/config"));
    assert_eq!(resolved, PathBuf::from("/tmp/config/tracker/issues.md"));
}

#[test]
fn resolve_relative_to_base_preserves_absolute_paths() {
    let resolved = resolve_relative_to_base(Path::new("/tmp/already-absolute"), Path::new("/tmp/config"));
    assert_eq!(resolved, PathBuf::from("/tmp/already-absolute"));
}
```

- [ ] **Step 2: Run the targeted config tests to verify baseline behavior**

Run: `cargo test -p ensemble-core config::`
Expected: PASS

- [ ] **Step 3: Write the minimal shared helper and switch the three duplicate call sites**

In `crates/ensemble-core/src/config/ensemble.rs`, add a small shared helper and reuse it everywhere a resolved path is either preserved as absolute or joined to a base directory:

```rust
pub(crate) fn resolve_relative_to_base(path: &Path, base_dir: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}
```

Then update:

- `EnsembleConfig::resolve_env_from(...)` in `ensemble.rs`
- `resolve_config_dir_for_cli(...)` in `location.rs`
- `resolve_tracker_output_path(...)` in `setup.rs`

Do not introduce a new module unless the compiler forces it; keep the change minimal.

- [ ] **Step 4: Run the targeted tests to verify the helper preserves behavior**

Run: `cargo test -p ensemble-core config::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/config/location.rs crates/ensemble-core/src/config/setup.rs
git commit -m "refactor: share config path resolution helpers"
```

### Task 2: Replace Manual DAG Validation and Duplicate Agent Probing in Setup

**Files:**
- Modify: `crates/ensemble-core/src/config/setup.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Test: `crates/ensemble-core/src/config/setup.rs`

- [ ] **Step 1: Write the failing tests that lock in the simplified setup behavior**

Add/adjust tests for:

```rust
#[tokio::test]
async fn discover_available_agents_uses_single_probe_result_for_version() {
    // exercise the probe/version path through one shared helper
}

#[test]
fn validate_dag_reports_unknown_dependency_via_pipeline_builder() {
    let steps = vec![SetupStep {
        name: "build".into(),
        agent_role: "builder".into(),
        depends: vec!["missing".into()],
        tracker_state: None,
    }];
    let error = validate_dag(&steps).unwrap_err();
    assert!(error.to_string().contains("unknown step"));
}
```

Use existing test patterns in `setup.rs`; do not add mocking frameworks.

- [ ] **Step 2: Run the targeted setup tests to capture the baseline**

Run: `cargo test -p ensemble-core config::setup::`
Expected: PASS

- [ ] **Step 3: Replace the duplicate implementations with minimal shared helpers**

Make two focused changes in `crates/ensemble-core/src/config/setup.rs`:

1. Replace the manual Kahn-style `validate_dag(...)` implementation with a conversion into `crate::config::ensemble::StepConfig` plus `crate::pipeline::dag::build_dag(&steps)`.
2. Collapse `probe_agent(...)` and `get_agent_version(...)` into one helper that runs `acpx --agent <name> --version` once and returns `Option<String>`.

Use this shape for the probe helper:

```rust
async fn probe_agent(name: &str) -> Option<String> {
    let output = tokio::time::timeout(timeout, async {
        tokio::process::Command::new("acpx")
            .args(["--agent", name, "--version"])
            .kill_on_drop(true)
            .output()
            .await
    })
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

Then update both `discover_available_agents(...)` and `get_setup_agents_stream(...)` in `config_edit_handler.rs`'s call path to consume the single result.

- [ ] **Step 4: Run the targeted tests to verify the simplified setup helpers pass**

Run: `cargo test -p ensemble-core setup`
Expected: PASS

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/setup.rs crates/ensemble-core/src/api/config_edit_handler.rs
git commit -m "refactor: simplify setup dag validation and agent probing"
```

### Task 3: Deduplicate Config Edit Save and Response Plumbing

**Files:**
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Test: `crates/ensemble-core/src/api/config_edit_handler.rs`

- [ ] **Step 1: Write the failing tests for shared config-save response behavior**

Extend the existing `config_edit_handler.rs` tests with cases that prove one helper shapes both save paths consistently:

```rust
#[tokio::test]
async fn save_yaml_and_save_guided_form_return_same_error_issue_shape() {
    // call both endpoints with invalid data
    // assert same status, issue.section, and redacted response shape
}

#[tokio::test]
async fn save_setup_reloads_document_state_after_writing_artifacts() {
    // assert document_state is replaced from disk, not manually reconstructed
}
```

Keep the assertions on observable API behavior, not internal helper names.

- [ ] **Step 2: Run the config edit tests to verify the baseline**

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

- [ ] **Step 3: Extract the minimal shared save/response helpers**

In `crates/ensemble-core/src/api/config_edit_handler.rs`, keep the existing response structs but factor the repeated logic into small helpers reused by `save_yaml`, `save_setup_with_checks`, and `save_guided_form`:

```rust
fn push_config_issue(
    response: &mut ConfigStateResponse,
    section: &str,
    message: String,
) {
    response.issues.push(ValidationIssue {
        kind: crate::config::draft::ValidationIssueKind::Config,
        message,
        section: section.to_string(),
        field: None,
        path: None,
    });
}

fn save_response_from_current_error(
    current: &ConfigDocumentState,
    section: &str,
    message: String,
) -> Json<ConfigStateResponse> {
    let mut response = ConfigStateResponse::from_state(current);
    push_config_issue(&mut response, section, message);
    Json(response)
}
```

Also reuse one document-reload helper for:

- raw YAML save
- guided-form save
- setup artifact write + reload

Do not broaden the endpoint contracts.

- [ ] **Step 4: Run the config edit tests to verify the helpers preserve behavior**

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "refactor: share config edit save and response helpers"
```

### Task 4: Remove Remaining JSON Envelope Boilerplate in API Handlers

**Files:**
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/fs_handler.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/conversation.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Test: `crates/ensemble-core/src/api/handlers.rs`
- Test: `crates/ensemble-core/src/api/conversation.rs`
- Test: `crates/ensemble-core/src/api/fs_handler.rs`

- [ ] **Step 1: Write the failing tests for typed JSON responses and error helpers**

Add or adjust unit tests around the existing response helpers so the refactor has a safety net:

```rust
#[tokio::test]
async fn method_not_allowed_returns_json_api_error() {
    let (status, Json(body)) = method_not_allowed().await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body.error.code, "method_not_allowed");
}

#[test]
fn conversation_response_serializes_total_and_next_cursor() {
    let response = ConversationResponse { messages: vec![], total: 0, next_cursor: None };
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["total"], 0);
}
```

- [ ] **Step 2: Run the targeted API tests to verify baseline behavior**

Run: `cargo test -p ensemble-core handlers`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

Run: `cargo test -p ensemble-core fs_handler`
Expected: PASS

Run: `cargo test -p ensemble-core history_handler`
Expected: PASS

Run: `cargo test -p ensemble-core router`
Expected: PASS

- [ ] **Step 3: Replace `serde_json::to_value(...).unwrap()` response wrapping with typed `Json<T>` helpers**

Use the smallest possible shared helper in `handlers.rs`, then reuse it in other API modules:

```rust
pub(crate) fn api_error(code: &str, message: impl Into<String>) -> Json<ApiError> {
    Json(ApiError::new(code, &message.into()))
}
```

Then convert patterns like these:

```rust
Json(serde_json::to_value(error).unwrap())
Json(serde_json::to_value(detail).unwrap())
Json(serde_json::to_value(response).unwrap())
```

into direct typed responses:

```rust
Json(error)
Json(detail)
Json(response)
```

Update return signatures where needed, but do not introduce a generic response abstraction.

- [ ] **Step 4: Run the targeted API tests to verify the response simplification passes**

Run: `cargo test -p ensemble-core handlers`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

Run: `cargo test -p ensemble-core fs_handler`
Expected: PASS

Run: `cargo test -p ensemble-core history_handler`
Expected: PASS

Run: `cargo test -p ensemble-core router`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/handlers.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/fs_handler.rs crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/conversation.rs crates/ensemble-core/src/api/controls.rs
git commit -m "refactor: simplify API JSON response handling"
```

### Task 5: Finish Local Correctness Fixes in Stop and Conversation Endpoints

**Files:**
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/conversation.rs`
- Test: `crates/ensemble-core/src/api/controls.rs`
- Test: `crates/ensemble-core/src/api/conversation.rs`

- [ ] **Step 1: Write the failing tests for the correctness constraints from the spec**

Lock in the two behavior requirements explicitly:

```rust
#[tokio::test]
async fn stop_running_issue_with_invalid_pid_returns_conflict_and_keeps_state() {
    // existing test should remain and clearly assert the state is untouched
}

#[tokio::test]
async fn get_conversation_returns_internal_error_for_malformed_jsonl() {
    // existing malformed JSONL test should remain and assert 500 instead of partial success
}
```

If the tests already exist, tighten assertions instead of adding duplicates.

- [ ] **Step 2: Run the targeted controls and conversation tests**

Run: `cargo test -p ensemble-core controls`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

- [ ] **Step 3: Factor the minimal local helpers and remove any remaining duplicate branches**

In `crates/ensemble-core/src/api/controls.rs`, keep the current `IssuePresence` and `StopSignalStatus`, but extract one helper for repeated conflict/not-found API errors so stop/retry branches do not hand-build the same envelope repeatedly.

In `crates/ensemble-core/src/api/conversation.rs`, extract one helper for loading + parsing the JSONL file so both endpoints share the same `conversation_read_error` / `conversation_parse_error` behavior.

Use this shape:

```rust
async fn load_conversation_messages(path: &FsPath) -> Result<Option<Vec<ConversationMessage>>, ApiError> {
    let Some(contents) = read_conversation_file(path).await.map_err(|e| {
        ApiError::new("conversation_read_error", &format!("failed to read conversation: {e}"))
    })? else {
        return Ok(None);
    };

    let messages = parse_conversation_messages(&contents).map_err(|e| {
        ApiError::new("conversation_parse_error", &format!("failed to parse conversation: {e}"))
    })?;

    Ok(Some(messages))
}
```

- [ ] **Step 4: Run the targeted tests again to verify the shared behavior stays correct**

Run: `cargo test -p ensemble-core controls`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/conversation.rs
git commit -m "fix: share stop and conversation error handling"
```

### Task 6: Consolidate Repeated API Test AppState Builders

**Files:**
- Create: `crates/ensemble-core/src/api/test_helpers.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/conversation.rs`
- Modify: `crates/ensemble-core/src/api/config_handler.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Test: `crates/ensemble-core/src/api/*`

- [ ] **Step 1: Add the initial helper smoke test**

Create the new test helper module with one small smoke test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_app_state_uses_requested_paths() {
        let app = app_state_with_missing_config(PathBuf::from("/tmp/config.yaml"), "/tmp/workspaces");
        assert_eq!(app.workspace_root, "/tmp/workspaces");
        assert_eq!(app.config_runtime.config_path, PathBuf::from("/tmp/config.yaml"));
    }
}
```

- [ ] **Step 2: Run the targeted API tests to capture the baseline**

Run: `cargo test -p ensemble-core handlers`
Expected: PASS

Run: `cargo test -p ensemble-core router`
Expected: PASS

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

Run: `cargo test -p ensemble-core controls`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

Run: `cargo test -p ensemble-core history_handler`
Expected: PASS

Run: `cargo test -p ensemble-core config_handler`
Expected: PASS

- [ ] **Step 3: Add the shared test helper module and switch the duplicated tests over**

Create `crates/ensemble-core/src/api/test_helpers.rs` with a few focused helpers, not a large fixture framework:

```rust
pub(crate) fn parsed_document_state() -> ConfigDocumentState {
    ConfigDocumentState {
        path: PathBuf::from("ensemble.yaml"),
        kind: ConfigStateKind::Parsed,
        raw_yaml: None,
        document: None,
        active_config: Some(crate::config::ensemble::parse_config(MINIMAL_CONFIG).unwrap()),
        validation: DraftValidationReport::default(),
    }
}

pub(crate) fn app_state_with_document_state(document_state: ConfigDocumentState) -> AppState {
    AppState {
        orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(30000, 10))),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: "/tmp/workspaces".to_string(),
        history_path: PathBuf::from("/tmp/history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path: document_state.path.clone(),
            document_state: Arc::new(RwLock::new(document_state)),
        },
    }
}
```

Then replace the repeated local builders in the listed test modules.

- [ ] **Step 4: Run the targeted API tests to verify the shared fixtures pass**

Run: `cargo test -p ensemble-core handlers`
Expected: PASS

Run: `cargo test -p ensemble-core router`
Expected: PASS

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

Run: `cargo test -p ensemble-core controls`
Expected: PASS

Run: `cargo test -p ensemble-core conversation`
Expected: PASS

Run: `cargo test -p ensemble-core history_handler`
Expected: PASS

Run: `cargo test -p ensemble-core config_handler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/test_helpers.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/conversation.rs crates/ensemble-core/src/api/config_handler.rs crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/handlers.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "test: share API app state builders"
```

### Task 7: Simplify Worktree Git Command Error Mapping

**Files:**
- Modify: `crates/ensemble-core/src/workspace/worktree.rs`
- Test: `crates/ensemble-core/src/workspace/worktree.rs`

- [ ] **Step 1: Write the failing tests for the shared git command helper behavior**

Keep the current tests but tighten them around command labeling and stderr mapping with one shared assertion helper:

```rust
fn assert_git_command_failed(error: WorktreeError, expected_command: &str) {
    match error {
        WorktreeError::GitCommandFailed { command, reason } => {
            assert_eq!(command, expected_command);
            assert!(!reason.is_empty());
        }
        other => panic!("expected GitCommandFailed, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run the targeted worktree tests to capture the baseline**

Run: `cargo test -p ensemble-core worktree`
Expected: PASS

- [ ] **Step 3: Extract the minimal shared stderr/status mapping helper**

In `crates/ensemble-core/src/workspace/worktree.rs`, keep `run_git(...)` but add a helper that turns a finished `Output` into either success or a `WorktreeError` so `create_worktree`, `attach_worktree`, `worktree_exists`, `remove_worktree`, and `pull_worktree` stop re-implementing `status.success()` + `stderr` conversion.

Use a small helper like:

```rust
fn ensure_git_success(
    output: std::process::Output,
    command: &str,
    error: impl FnOnce(String) -> WorktreeError,
) -> Result<std::process::Output, WorktreeError> {
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(error(stderr))
    }
}
```

Do not change public behavior like `AlreadyExists` special-casing.

- [ ] **Step 4: Run the targeted worktree tests to verify behavior is unchanged**

Run: `cargo test -p ensemble-core worktree`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/workspace/worktree.rs
git commit -m "refactor: share git worktree command error handling"
```

### Task 8: Final Verification and Documentation Check

**Files:**
- Review: `docs/superpowers/specs/2026-04-04-practical-simplification-design.md`
- Review: `docs/superpowers/plans/2026-04-04-codebase-simplifications.md`

- [ ] **Step 1: Run the focused suites touched by this plan**

Run: `cargo test -p ensemble-core`
Expected: PASS

- [ ] **Step 2: Run the workspace validation commands**

Run: `cargo test --workspace --exclude ensemble-desktop`
Expected: PASS

Run: `cargo clippy --workspace --exclude ensemble-desktop -- -D warnings`
Expected: PASS

Run: `cargo fmt --all -- --check`
Expected: PASS

- [ ] **Step 3: Review the changed plan/spec pair for scope drift**

Confirm the implementation still matches `docs/superpowers/specs/2026-04-04-practical-simplification-design.md`:

- no orchestrator lifecycle refactor
- no ACP transport rewrite
- no tracker architecture changes
- no work from deferred items `#41` through `#44`

- [ ] **Step 4: Commit the final cleanup if verification required any fixes**

Skip this step if the verification commands passed without requiring any file changes; do not create an empty commit.

```bash
git add -A
git commit -m "chore: finish practical simplification pass"
```
