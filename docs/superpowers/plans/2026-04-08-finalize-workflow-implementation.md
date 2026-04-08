# Finalize Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `push_strategy` with first-class per-repo `finalize` behavior, including approval gating, headless warnings, and explicit finalize status in runtime/API.

**Architecture:** Extend config schema with `RepoFinalizeConfig`, add explicit finalize state in `OrchestratorState`, and run finalize actions after pipeline success. Surface finalize state and actions through existing API snapshot + controls endpoints so UI/app can approve/retry finalize without rerunning pipeline DAG.

**Tech Stack:** Rust, serde/serde_yaml, tokio, axum, utoipa, tracing, existing orchestrator state machine.

---

## File Structure (planned)

- **Create:** `crates/ensemble-core/src/workspace/finalize.rs`  
  Finalize enums/config (`FinalizeMode`, `RepoFinalizeConfig`) and helper methods.
- **Delete:** `crates/ensemble-core/src/workspace/push_strategy.rs`  
  Remove legacy push strategy model.
- **Modify:** `crates/ensemble-core/src/workspace/mod.rs`  
  Re-export finalize module.
- **Modify:** `crates/ensemble-core/src/config/ensemble.rs`  
  Add `repos[].finalize`, remove top-level `push_strategy`, defaults + parser tests.
- **Modify:** `crates/ensemble-core/src/config/mod.rs`  
  Export new finalize types.
- **Modify:** `crates/ensemble-core/src/config/draft.rs`  
  Validation error for legacy `push_strategy` + migration hint.
- **Modify:** `crates/ensemble-core/src/error.rs`  
  Add finalize-specific errors where needed.
- **Modify:** `crates/ensemble-core/src/orchestrator/state.rs`  
  Add issue/repo finalize status tracking and helper transitions.
- **Modify:** `crates/ensemble-core/src/orchestrator/mod.rs`  
  Run finalize phase after pipeline success, handle approval/headless/failure states.
- **Modify:** `crates/ensemble-core/src/observability/snapshot.rs`  
  Include finalize summary and per-repo rows in runtime and issue detail snapshots.
- **Modify:** `crates/ensemble-core/src/api/handlers.rs`  
  Ensure issue detail endpoint returns finalize state.
- **Modify:** `crates/ensemble-core/src/api/controls.rs`  
  Add `POST /api/v1/{identifier}/finalize/approve` and `POST /api/v1/{identifier}/finalize/retry`.
- **Modify:** `crates/ensemble-core/src/api/router.rs`  
  Route new finalize control endpoints.
- **Modify:** `crates/ensemble-core/src/api/openapi.rs`  
  Register new schemas/endpoints.
- **Modify:** `crates/ensemble-core/src/api/bootstrap.rs` (or startup path currently computing runtime warnings)  
  Add headless startup warning for approval-required finalize.
- **Modify:** `docs/SPEC.md` and `docs/configuration.md`  
  Replace `push_strategy` docs with per-repo `finalize`.
- **Modify:** `docs/superpowers/specs/2026-04-08-finalize-workflow-design.md` (if needed for small clarifications only)

---

### Task 1: Replace config model (`push_strategy` -> `repos[].finalize`)

**Files:**
- Create: `crates/ensemble-core/src/workspace/finalize.rs`
- Delete: `crates/ensemble-core/src/workspace/push_strategy.rs`
- Modify: `crates/ensemble-core/src/workspace/mod.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs` (existing test module)

- [ ] **Step 1: Write failing config parse tests for finalize defaults + explicit values**

```rust
#[test]
fn parses_repo_finalize_defaults() {
    let yaml = r#"
tracker:
  kind: github
agents: {}
steps: []
on_success: Done
on_failure: Failed
repos:
  - path: /tmp/repo
    branch: main
"#;
    let config = EnsembleConfig::from_yaml_str(yaml).expect("config should parse");
    let finalize = &config.repos[0].finalize;
    assert!(finalize.enabled);
    assert_eq!(finalize.mode, FinalizeMode::None);
    assert!(!finalize.approval_required);
}

#[test]
fn parses_repo_finalize_explicit_values() {
    let yaml = r#"
tracker:
  kind: github
agents: {}
steps: []
on_success: Done
on_failure: Failed
repos:
  - path: /tmp/repo
    branch: main
    finalize:
      enabled: true
      mode: push_and_pr
      approval_required: true
"#;
    let config = EnsembleConfig::from_yaml_str(yaml).expect("config should parse");
    let finalize = &config.repos[0].finalize;
    assert_eq!(finalize.mode, FinalizeMode::PushAndPr);
    assert!(finalize.approval_required);
}
```

- [ ] **Step 2: Run targeted test to confirm failure**

Run: `rtk cargo test -p ensemble-core parses_repo_finalize_defaults -- --nocapture`  
Expected: FAIL (unknown `finalize` field / missing `FinalizeMode` types)

- [ ] **Step 3: Implement finalize model and wire into config structs**

```rust
// crates/ensemble-core/src/workspace/finalize.rs
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeMode {
    #[default]
    None,
    Push,
    PushAndPr,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RepoFinalizeConfig {
    #[serde(default = "default_finalize_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub mode: FinalizeMode,
    #[serde(default)]
    pub approval_required: bool,
}

impl Default for RepoFinalizeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: FinalizeMode::None,
            approval_required: false,
        }
    }
}
```

```rust
// crates/ensemble-core/src/config/ensemble.rs (RepoConfig)
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct RepoConfig {
    pub path: String,
    pub branch: String,
    #[serde(default = "default_git_remote")]
    pub git_remote: String,
    #[serde(default)]
    pub finalize: RepoFinalizeConfig,
}
```

- [ ] **Step 4: Remove legacy `push_strategy` references**

```rust
// Remove from EnsembleConfig
// #[serde(default)]
// pub push_strategy: PushStrategy,

// remove use crate::workspace::push_strategy::PushStrategy;
```

Also remove module export from `workspace/mod.rs` and `config/mod.rs`.

- [ ] **Step 5: Run tests for config + removed type references**

Run: `rtk cargo test -p ensemble-core config::ensemble -- --nocapture`  
Expected: PASS with new finalize tests, no `push_strategy` compile references.

- [ ] **Step 6: Commit**

```bash
rtk git add crates/ensemble-core/src/workspace/finalize.rs \
  crates/ensemble-core/src/workspace/mod.rs \
  crates/ensemble-core/src/config/ensemble.rs \
  crates/ensemble-core/src/config/mod.rs \
  crates/ensemble-core/src/workspace/push_strategy.rs
rtk git commit -m "Replace push_strategy with per-repo finalize config"
```

---

### Task 2: Add validation/migration guidance for removed `push_strategy`

**Files:**
- Modify: `crates/ensemble-core/src/config/draft.rs`
- Test: `crates/ensemble-core/src/config/draft.rs` (existing tests)

- [ ] **Step 1: Write failing validation test for legacy `push_strategy`**

```rust
#[test]
fn reports_push_strategy_removed_migration_hint() {
    let yaml = r#"
tracker:
  kind: github
agents: {}
steps: []
on_success: Done
on_failure: Failed
push_strategy: auto_push
"#;
    let draft = ConfigDraft::from_yaml_str(yaml).expect("draft parse");
    let report = draft.validate();
    assert!(report.issues.iter().any(|issue|
        issue.message.contains("push_strategy has been removed")
            && issue.message.contains("repos[].finalize")
    ));
}
```

- [ ] **Step 2: Run targeted test to verify failure**

Run: `rtk cargo test -p ensemble-core reports_push_strategy_removed_migration_hint -- --nocapture`  
Expected: FAIL (no migration issue yet).

- [ ] **Step 3: Add validation rule and migration mapping text**

```rust
if root.get("push_strategy").is_some() {
    issues.push(ValidationIssue {
        section: "workflow".to_string(),
        message: "push_strategy has been removed; configure repos[].finalize instead (manual->mode:none, auto_push->mode:push, pr_only->mode:push_and_pr, ask->approval_required:true + explicit mode)".to_string(),
        severity: ValidationSeverity::Error,
    });
}
```

- [ ] **Step 4: Re-run draft validation tests**

Run: `rtk cargo test -p ensemble-core config::draft -- --nocapture`  
Expected: PASS with new migration guidance test.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/config/draft.rs
rtk git commit -m "Add push_strategy removal migration validation"
```

---

### Task 3: Implement finalize runtime state machine in orchestrator

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/state.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add failing state tests for finalize statuses**

```rust
#[test]
fn tracks_finalize_status_lifecycle() {
    let mut state = OrchestratorState::new(30_000, 4);
    state.set_finalize_status("ISSUE-1", FinalizeStatus::PendingApproval);
    assert_eq!(
        state.finalize_status("ISSUE-1"),
        Some(FinalizeStatus::PendingApproval)
    );
    state.set_finalize_status("ISSUE-1", FinalizeStatus::Succeeded);
    assert_eq!(
        state.finalize_status("ISSUE-1"),
        Some(FinalizeStatus::Succeeded)
    );
}
```

- [ ] **Step 2: Run targeted failing tests**

Run: `rtk cargo test -p ensemble-core tracks_finalize_status_lifecycle -- --nocapture`  
Expected: FAIL (missing fields/types/helpers).

- [ ] **Step 3: Add finalize status types + storage**

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeStatus {
    NotRequired,
    PendingApproval,
    InProgress,
    Succeeded,
    Failed,
    SkippedHeadless,
}

pub finalize: HashMap<String, IssueFinalizeState>, // issue_id -> state
```

Add helper APIs (`set_finalize_status`, `set_repo_finalize_status`, `finalize_status`, `clear_finalize`).

- [ ] **Step 4: Integrate finalize phase into pipeline success path**

```rust
match run.step_completed(step_name, verdict) {
    PipelineAction::Succeeded => {
        // existing success logic becomes:
        // 1) compute per-repo finalize requirements
        // 2) set pending/skipped statuses
        // 3) execute non-gated finalize actions
        // 4) only mark completed when finalize terminal success conditions met
    }
    // ...
}
```

Add retry path for finalize-only failures (without recreating DAG run).

- [ ] **Step 5: Add orchestrator tests for success/failure/headless behavior**

```rust
#[tokio::test]
async fn pipeline_success_with_finalize_pending_does_not_mark_completed() {}

#[tokio::test]
async fn headless_approval_required_marks_skipped_headless() {}

#[tokio::test]
async fn finalize_failure_keeps_issue_uncompleted_for_retry() {}
```

- [ ] **Step 6: Run orchestrator tests**

Run: `rtk cargo test -p ensemble-core orchestrator:: -- --nocapture`  
Expected: PASS, including new finalize lifecycle tests.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/ensemble-core/src/orchestrator/state.rs crates/ensemble-core/src/orchestrator/mod.rs
rtk git commit -m "Add finalize lifecycle state and orchestrator phase"
```

---

### Task 4: Add headless startup warning for approval-required finalize

**Files:**
- Modify: `crates/ensemble-core/src/api/bootstrap.rs` (or shared runtime startup checker)
- Modify: `crates/ensemble-cli/src/commands/run.rs`
- Test: `crates/ensemble-core/src/api/bootstrap.rs` (or owning module tests)

- [ ] **Step 1: Write failing test for startup warning generation**

```rust
#[test]
fn warns_when_headless_finalize_requires_approval() {
    let warnings = collect_startup_warnings(&config_with_approval_required_finalize(), RuntimeSurface::Headless);
    assert!(warnings.iter().any(|w| w.contains("approval-required finalize") && w.contains("will be skipped")));
}
```

- [ ] **Step 2: Run test to confirm failure**

Run: `rtk cargo test -p ensemble-core warns_when_headless_finalize_requires_approval -- --nocapture`  
Expected: FAIL (no warning rule).

- [ ] **Step 3: Implement warning rule**

```rust
if runtime_surface.is_headless() {
    for repo in &config.repos {
        if repo.finalize.enabled && repo.finalize.approval_required {
            warnings.push(format!(
                "repo '{}' has approval-required finalize in headless mode; finalize will be skipped",
                repo.path
            ));
        }
    }
}
```

- [ ] **Step 4: Re-run startup check tests**

Run: `rtk cargo test -p ensemble-core startup -- --nocapture`  
Expected: PASS with new warning test.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/api/bootstrap.rs crates/ensemble-cli/src/commands/run.rs
rtk git commit -m "Warn on headless approval-required finalize config"
```

---

### Task 5: Expose finalize state + control endpoints in API

**Files:**
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Test: `crates/ensemble-core/src/observability/snapshot.rs`
- Test: `crates/ensemble-core/src/api/controls.rs`

- [ ] **Step 1: Add failing snapshot test for finalize fields**

```rust
#[test]
fn issue_detail_includes_finalize_summary() {
    let state = seeded_state_with_finalize("NODE_1", FinalizeStatus::PendingApproval);
    let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces").unwrap();
    assert_eq!(detail.finalize.status, "pending_approval");
    assert_eq!(detail.finalize.repos.len(), 1);
}
```

- [ ] **Step 2: Run failing snapshot test**

Run: `rtk cargo test -p ensemble-core issue_detail_includes_finalize_summary -- --nocapture`  
Expected: FAIL (missing finalize fields).

- [ ] **Step 3: Extend snapshot structs and builders**

```rust
pub struct FinalizeSummary {
    pub status: String,
    pub repos: Vec<RepoFinalizeSnapshot>,
}

pub struct RepoFinalizeSnapshot {
    pub repo: String,
    pub mode: String,
    pub approval_required: bool,
    pub status: String,
    pub last_error: Option<String>,
}
```

Attach `finalize: FinalizeSummary` to `IssueDetailSnapshot` and include summary in `/api/v1/state` row if desired.

- [ ] **Step 4: Add finalize control endpoints tests (approve + retry)**

```rust
#[tokio::test]
async fn approve_finalize_moves_pending_to_in_progress() {}

#[tokio::test]
async fn retry_finalize_requeues_failed_finalize_only() {}
```

- [ ] **Step 5: Implement controls + routes + OpenAPI entries**

```rust
// POST /api/v1/{identifier}/finalize/approve
pub async fn post_finalize_approve(...) -> impl IntoResponse { /* ... */ }

// POST /api/v1/{identifier}/finalize/retry
pub async fn post_finalize_retry(...) -> impl IntoResponse { /* ... */ }
```

Update router wiring and utoipa path registration.

- [ ] **Step 6: Run API tests**

Run: `rtk cargo test -p ensemble-core api:: -- --nocapture`  
Expected: PASS including new finalize API tests.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/ensemble-core/src/observability/snapshot.rs \
  crates/ensemble-core/src/api/handlers.rs \
  crates/ensemble-core/src/api/controls.rs \
  crates/ensemble-core/src/api/router.rs \
  crates/ensemble-core/src/api/openapi.rs
rtk git commit -m "Expose finalize status and finalize control endpoints"
```

---

### Task 6: Update product documentation

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `README.md` (if `push_strategy` appears)

- [ ] **Step 1: Add failing doc grep check to ensure legacy term removed where needed**

Run: `rtk rg -n "push_strategy" docs/SPEC.md docs/configuration.md README.md`  
Expected: At least one match before edits.

- [ ] **Step 2: Replace docs with finalize model and examples**

```yaml
repos:
  - path: /repo
    branch: main
    finalize:
      mode: push_and_pr
      approval_required: true
```

Document headless warning behavior and completion semantics (pipeline success vs finalize success).

- [ ] **Step 3: Re-run grep check**

Run: `rtk rg -n "push_strategy" docs/SPEC.md docs/configuration.md README.md`  
Expected: no matches (or only explicit migration note section).

- [ ] **Step 4: Commit**

```bash
rtk git add docs/SPEC.md docs/configuration.md README.md
rtk git commit -m "Document repo-level finalize workflow and migration"
```

---

### Task 7: Full verification before completion

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Run focused package tests**

Run: `rtk cargo test -p ensemble-core -- --nocapture`  
Expected: PASS.

- [ ] **Step 2: Run workspace Rust checks from project checklist**

Run: `rtk cargo test --workspace --exclude ensemble-desktop`  
Expected: PASS.

Run: `rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings`  
Expected: PASS with zero warnings.

Run: `rtk cargo fmt --all -- --check`  
Expected: PASS (no formatting diffs).

- [ ] **Step 3: Final status snapshot for PR prep**

Run: `rtk git status --short`  
Expected: clean working tree.

- [ ] **Step 4: Final commit(s) if needed**

```bash
rtk git add -A
rtk git commit -m "Finalize workflow: per-repo publish lifecycle" 
```

---

## Spec-to-Plan Coverage Check

- Config replacement (`push_strategy` removal, `repos[].finalize`) -> **Task 1 + Task 2**
- Runtime finalize phase + status split -> **Task 3**
- Headless approval startup warning -> **Task 4**
- API/UI-visible finalize state + approve/retry controls -> **Task 5**
- Docs + migration communication -> **Task 6**
- Verification gates -> **Task 7**

## Placeholder Scan

- No `TODO`/`TBD` placeholders in tasks.
- All tasks include concrete files, commands, and expected outcomes.

## Type/Name Consistency Check

- Uses `FinalizeMode` + `RepoFinalizeConfig` consistently in config tasks.
- Uses `FinalizeStatus` consistently for runtime/API state.
- Uses `finalize` terminology consistently instead of `push_strategy`.
