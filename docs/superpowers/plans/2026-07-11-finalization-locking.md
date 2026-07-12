# Finalization Locking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure initial finalization after pipeline success never performs workspace, git, artifact-helper, tracker, journal, or history awaits while retaining the orchestrator state write guard.

**Architecture:** Refactor the existing `PipelineAction::Succeeded` branch into an external-I/O phase and a short state-commit phase, following the already-correct restored-pipeline and finalize-retry patterns. Add a timeout regression test using an approval-required local repository so it deterministically reaches the reentrant artifact update without network access.

**Tech Stack:** Rust 2021, Tokio `RwLock` and `time::timeout`, existing `WorkspaceManager`, `PipelineRun`, and in-module orchestrator test infrastructure.

---

## File Structure

- Modify `crates/ensemble-core/src/orchestrator/mod.rs`: add the regression fixture/test and refactor successful worker-exit finalization. Keep the change in this existing module because both the private method under test and its established test infrastructure live there.
- No production files are created. No config, API, or documented behavior changes.

### Task 1: Reproduce the Reentrant Finalization Deadlock

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:5346-5780`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` in the existing `#[cfg(test)] mod tests`

- [ ] **Step 1: Add a local git repository helper to the orchestrator tests**

Add this helper near `make_config` so the regression test can create a valid source repository without network access:

```rust
fn setup_finalize_repo(root: &std::path::Path) -> RepoConfig {
    let repo_path = root.join("source-repo");
    std::fs::create_dir_all(&repo_path).unwrap();

    for args in [
        &["init", "-b", "main"][..],
        &["config", "user.email", "test@example.com"][..],
        &["config", "user.name", "Test User"][..],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo_path)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
    }

    std::fs::write(repo_path.join("README.md"), "# source-repo\n").unwrap();
    for args in [&["add", "."][..], &["commit", "-m", "initial"][..]] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo_path)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
    }

    RepoConfig {
        path: repo_path.display().to_string(),
        branch: "main".to_string(),
        git_remote: "origin".to_string(),
        finalize: crate::workspace::finalize::RepoFinalizeConfig {
            enabled: true,
            mode: FinalizeMode::Push,
            approval_required: true,
        },
    }
}
```

Extend the existing config import in the test module from:

```rust
use crate::config::ensemble::{parse_config, ConcurrencyConfig, StepConfig};
```

to:

```rust
use crate::config::ensemble::{parse_config, ConcurrencyConfig, RepoConfig, StepConfig};
```

- [ ] **Step 2: Add the timeout regression test**

Place the test near the existing `handle_worker_exit` tests. It must seed an active one-step pipeline and a matching repository artifact, then invoke final-step completion through the same private method used in production:

```rust
#[tokio::test]
async fn enabled_finalization_returns_without_reentrant_state_locking() {
    let temp = tempfile::tempdir().unwrap();
    let repo_config = setup_finalize_repo(temp.path());
    let workspace_root = temp.path().join("workspaces");
    let workspace_mgr =
        WorkspaceManager::new(&workspace_root, Some(vec![repo_config])).unwrap();
    let config = Arc::new(RwLock::new(make_config()));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
        issues: Arc::new(RwLock::new(Vec::new())),
    });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        observed_timeouts: None,
        cancellation_probe: None,
    });
    let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let orchestrator = Orchestrator::new(
        config.clone(),
        tracker,
        runner,
        workspace_mgr,
        temp.path(),
        shutdown_rx,
    );

    let mut issue = test_issue("1", "Todo");
    issue.identifier = "repo#1".to_string();
    {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "session-1".to_string());

        let mut state = orchestrator.state.write().await;
        state.add_claimed(&issue.id);
        state.add_running(&issue, None);
        state.insert_pipeline_run(&issue.id, run, Arc::new(cfg.clone()));
        state.artifacts.insert(
            issue.id.clone(),
            RunArtifacts {
                run_id: "run-1".to_string(),
                workspace_path: workspace_root.display().to_string(),
                repos: vec![crate::history::artifacts::RepoArtifact {
                    repo: "source-repo".to_string(),
                    finalize_mode: "push".to_string(),
                    finalize_status: "pending".to_string(),
                    ..Default::default()
                }],
                transcripts: Vec::new(),
            },
        );
    }

    tokio::time::timeout(
        Duration::from_secs(5),
        orchestrator.handle_worker_exit(
            &issue.id,
            "build",
            WorkerResult::Success {
                output: succeeded_step_output(),
                approval_request: None,
            },
        ),
    )
    .await
    .expect("enabled finalization must not deadlock");

    let state = orchestrator.state.read().await;
    let finalize = state.get_finalize_state(&issue.id).unwrap();
    assert_eq!(finalize.status, FinalizeStatus::PendingApproval);
    assert_eq!(finalize.repos[0].status, FinalizeStatus::PendingApproval);
    assert_eq!(
        state.artifacts[&issue.id].repos[0].finalize_status,
        "pending_approval"
    );
}
```

Use the existing `Duration` import available through `super::*`. If the compiler reports it is not in scope, add `use std::time::Duration;` to the test module rather than fully qualifying each use.

- [ ] **Step 3: Run the regression test and confirm the timeout proves the bug**

Run:

```bash
cargo test -p ensemble-core enabled_finalization_returns_without_reentrant_state_locking -- --nocapture
```

Expected: FAIL after approximately five seconds with `enabled finalization must not deadlock: Elapsed(())`. Do not weaken or remove the timeout.

### Task 2: Move Finalization I/O Outside the State Guard

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:1567-1667`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Release state before initial finalization**

At the start of the `PipelineAction::Succeeded` branch, clone the current config, release both guards, and only then call finalization:

```rust
let issue_identifier = issue_snapshot
    .as_ref()
    .map(|issue| issue.identifier.clone())
    .unwrap_or_else(|| issue_id.to_string());
let config_snapshot = config.clone();
drop(config);
drop(state);

let finalize_state = self
    .run_finalize_phase(issue_id, &issue_identifier, &config_snapshot)
    .await;
```

The cloned `EnsembleConfig` prevents configuration reloads from being blocked by workspace or git I/O. Do not call any state-dependent code until a new state guard is acquired.

- [ ] **Step 2: Commit finalization results under a fresh short guard**

Replace the remainder of the branch with a state-only block that builds owned post-commit work:

```rust
let (
    tracker_state,
    tracker_error_message,
    transition,
    release,
    history,
) = {
    let mut state = self.state.write().await;
    let completed_at = Utc::now();
    let history_record = state
        .running
        .get(issue_id)
        .zip(state.get_pipeline_run(issue_id))
        .map(|(entry, run)| {
            self.build_history_record(RunningHistoryRecordInput {
                issue_id,
                outcome: HISTORY_OUTCOME_SUCCEEDED,
                last_error: None,
                running_entry: entry,
                run,
                completed_at,
                artifacts: state.artifacts.get(issue_id).cloned(),
            })
        });
    let running_entry = state.get_running(issue_id).cloned();

    if matches!(
        finalize_state.status,
        FinalizeStatus::Succeeded | FinalizeStatus::NotRequired
    ) {
        if let Some(ref entry) = running_entry {
            state.add_completed(
                issue_id.to_string(),
                entry.identifier.clone(),
                "completed_succeeded".to_string(),
            );
        }
        state.release_claim(issue_id);
        state.remove_pipeline_run(issue_id);
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
        }
        state.clear_finalize_state(issue_id);

        let history_run_id = running_entry
            .as_ref()
            .and_then(|entry| entry.run_id.clone());
        let release_identifier = running_entry
            .as_ref()
            .map(|entry| entry.identifier.clone())
            .unwrap_or_else(|| issue_identifier.clone());
        (
            self.tracker
                .supports_writes()
                .then(|| config_snapshot.on_success.clone()),
            "failed to set tracker success state",
            step_transition,
            Some((release_identifier, history_run_id.clone())),
            history_record.map(|record| (history_run_id, record)),
        )
    } else {
        let tracker_state = (self.tracker.supports_writes()
            && matches!(
                finalize_state.status,
                FinalizeStatus::Failed | FinalizeStatus::SkippedHeadless
            ))
        .then(|| config_snapshot.on_failure.clone());
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
        }
        state.set_finalize_state(issue_id, finalize_state);
        state.remove_pipeline_run(issue_id);
        (
            tracker_state,
            "failed to set tracker failure state after finalize failure",
            None,
            None,
            None,
        )
    }
};
```

Once acquired, this guard only reads or mutates `state`; it performs no external I/O. Unresolved finalization removes the running entry and adds its runtime seconds before parking the finalize state, releasing the running slot while retaining the claim, workspace, and artifacts.

- [ ] **Step 3: Perform tracker and persistence I/O after the guard is gone**

Immediately after the state-only block, perform the owned work without a state guard:

```rust
if let Some(tracker_state) = tracker_state {
    if let Err(error) = self.tracker.set_issue_state(issue_id, &tracker_state).await {
        warn!(issue_id = %issue_id, error = %error, "{tracker_error_message}");
    }
}

if let Some(input) = transition {
    self.append_pipeline_transition(input).await;
}
if let Some((release_identifier, release_run_id)) = release {
    self.append_pipeline_release(
        issue_id,
        &release_identifier,
        release_run_id,
        "completed",
    )
    .await;
}
if let Some((history_run_id, record)) = history {
    self.append_history_record(history_run_id.as_deref(), record)
        .await;
}
```

This deliberately preserves the current behavior of writing completion journal/history records only when finalization reaches `succeeded` or `not_required`. Do not broaden issue #324 into transition-journal behavior changes.

- [ ] **Step 4: Run the focused regression test**

Run:

```bash
cargo test -p ensemble-core enabled_finalization_returns_without_reentrant_state_locking -- --nocapture
```

Expected: PASS. The finalize state and artifact status assertions must also pass, proving the method returned because the artifact helper acquired and released its own state guard.

- [ ] **Step 5: Run nearby successful-exit and finalization control tests**

Run:

```bash
cargo test -p ensemble-core handle_worker_exit -- --nocapture
cargo test -p ensemble-core finalize -- --nocapture
```

Expected: all selected tests PASS. Confirm approval and retry API tests still transition repository state to `in_progress`.

- [ ] **Step 6: Commit the focused fix**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "Prevent reentrant finalization locking"
```

### Task 3: Verify the Complete Change

**Files:**
- Verify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Verify: `docs/superpowers/specs/2026-07-11-finalization-locking-design.md`

- [ ] **Step 1: Format and inspect the final diff**

Run:

```bash
cargo fmt --all
git diff --check
git diff HEAD^ -- crates/ensemble-core/src/orchestrator/mod.rs
```

Expected: formatting completes, `git diff --check` prints nothing, and the diff contains only the regression fixture/test and two-phase success-branch change.

- [ ] **Step 2: Run the core test suite**

Run:

```bash
cargo test -p ensemble-core
```

Expected: all `ensemble-core` unit and integration tests PASS.

- [ ] **Step 3: Run workspace clippy**

Run:

```bash
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
```

Expected: command exits successfully with no warnings.

- [ ] **Step 4: Verify formatting**

Run:

```bash
cargo fmt --all -- --check
```

Expected: command exits successfully with no formatting differences.

- [ ] **Step 5: Confirm documentation scope**

Compare the final diff against `docs/superpowers/specs/2026-07-11-finalization-locking-design.md`. Confirm no configuration schema, API contract, tracker semantics, or user-visible lifecycle behavior changed. No updates to `docs/SPEC.md`, `docs/configuration.md`, or `docs/pipelines.md` are required.

- [ ] **Step 6: Commit formatting changes only if formatting modified the source after Task 2**

First run:

```bash
git status --short
```

If `cargo fmt` changed `crates/ensemble-core/src/orchestrator/mod.rs`, commit only that file:

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "Format finalization locking fix"
```

If the worktree is clean, do not create an empty commit.

### Task 4: Reject Stale Finalization Results

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:78-105`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:773-910`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:1567-1685`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` in the existing `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the running-attempt identity regression test**

Add this test near `enabled_finalization_returns_without_reentrant_state_locking`. It proves that an issue-level run ID is not sufficient to identify the attempt that entered finalization:

```rust
#[test]
fn finalization_attempt_rejects_missing_or_replaced_running_entry() {
    let config = make_config();
    let mut state = OrchestratorState::new(config.polling.interval_ms, &config.concurrency);
    let issue = test_issue("1", "Todo");
    state.add_running(&issue, None);

    let identity = RunningAttemptIdentity::capture(&state, &issue.id).unwrap();
    assert!(identity.is_current(&state, &issue.id));

    let mut replacement = state.remove_running(&issue.id).unwrap();
    assert!(!identity.is_current(&state, &issue.id));

    replacement.started_at += chrono::Duration::seconds(1);
    state.running.insert(issue.id.clone(), replacement);
    assert_eq!(
        identity.run_id.as_deref(),
        state
            .get_running(&issue.id)
            .unwrap()
            .run_id
            .as_deref()
    );
    assert!(!identity.is_current(&state, &issue.id));
}
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cargo test -p ensemble-core finalization_attempt_rejects_missing_or_replaced_running_entry -- --nocapture
```

Expected: compilation fails because `RunningAttemptIdentity` is not defined. This confirms the test names the missing ownership contract before production code is added.

- [ ] **Step 3: Add the minimal attempt identity type**

Add this private type near the other orchestrator input/context types:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunningAttemptIdentity {
    run_id: Option<String>,
    started_at: chrono::DateTime<Utc>,
}

impl RunningAttemptIdentity {
    fn capture(state: &OrchestratorState, issue_id: &str) -> Option<Self> {
        state.get_running(issue_id).map(|entry| Self {
            run_id: entry.run_id.clone(),
            started_at: entry.started_at,
        })
    }

    fn is_current(&self, state: &OrchestratorState, issue_id: &str) -> bool {
        state.get_running(issue_id).is_some_and(|entry| {
            entry.run_id == self.run_id && entry.started_at == self.started_at
        })
    }
}
```

The timestamp intentionally participates in equality because `issue_run_ids` may preserve and reuse the same run ID after a stop.

- [ ] **Step 4: Capture identity before releasing state in both success paths**

In both the initial worker-exit and restored-pipeline `PipelineAction::Succeeded` branches, capture the identity while the original state write guard still proves ownership. The worker-exit path captures before cloning and dropping its guards; the restored path captures before leaving the state-write block that calls `add_running`:

```rust
let finalize_attempt = RunningAttemptIdentity::capture(&state, issue_id);
let config_snapshot = config.clone();
drop(config);
drop(state);
```

```rust
state.add_running(issue, effective_attempt);
let finalize_attempt = RunningAttemptIdentity::capture(&state, &issue.id);
```

Keep the existing call to `run_finalize_phase` immediately after the guards are dropped.

- [ ] **Step 5: Reject stale results before either path commits state**

At the beginning of the post-finalization state block, immediately after acquiring the fresh write guard, validate the captured identity:

```rust
let mut state = self.state.write().await;
if !Self::finalization_attempt_is_current(finalize_attempt.as_ref(), &state, issue_id) {
    warn!(
        issue_id = %issue_id,
        "discarding stale finalization result because the running attempt changed"
    );
    return;
}
```

Use the same private validation gate in both paths. The early return must occur before building history, applying completion/finalize state, or collecting tracker/journal/history work. Do not change `run_finalize_phase`, artifact helper APIs, API lookup precedence, or unrelated failure paths.

- [ ] **Step 6: Add restored-pipeline lifecycle coverage**

Add a deterministic test seam immediately after `run_finalize_phase` returns, then pause the restored-pipeline path, replace its running entry with the same run ID and a later `started_at`, and resume the commit. Assert the restored pipeline remains running and retained, completion/finalize state is unchanged, and tracker, pipeline-release journal, and history writes are absent. This must invoke `dispatch_issue` so removing the restored-path guard makes the test fail; do not rely only on `RunningAttemptIdentity::is_current`.

Add a separate restored pending-approval lifecycle test with a matching artifact fixture. In the non-stale unresolved branch, assert `PendingApproval`, no running entry, a retained claim, a removed pipeline run, and artifact status `pending_approval`. The branch must remove the running entry and add its runtime before persisting finalize state; it must retain the claim, workspace, and artifacts for existing finalize controls.

- [ ] **Step 7: Run focused tests to verify GREEN**

Run:

```bash
cargo test -p ensemble-core finalization_attempt_rejects_missing_or_replaced_running_entry -- --nocapture
cargo test -p ensemble-core restored_finalization_discards_stale_attempt_before_owned_writes -- --nocapture
cargo test -p ensemble-core enabled_finalization_returns_without_reentrant_state_locking -- --nocapture
cargo test -p ensemble-core finalize -- --nocapture
```

Expected: all selected tests PASS. The original deadlock/parking regression must continue to assert pending approval, updated artifacts, no running slot, and a retained claim.

- [ ] **Step 8: Run complete verification**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
git diff --check
```

Expected: 0 test failures, no clippy warnings, no formatting changes, and no whitespace errors.

- [ ] **Step 9: Commit the stale-result fix**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs docs/superpowers/plans/2026-07-11-finalization-locking.md
git commit -m "Discard stale finalization results"
```
