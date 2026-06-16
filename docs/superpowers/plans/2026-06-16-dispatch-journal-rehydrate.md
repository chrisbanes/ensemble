# Dispatch Journal Rehydrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before starting a fresh pipeline for an eligible issue, restore any latest live journal snapshot for that issue and resume from that state.

**Architecture:** Keep startup restore as the broad multi-issue path. Add a single-issue live journal lookup and call it from the normal tick dispatch path only after an issue is already candidate-eligible and only when no in-memory pipeline exists. Reuse `restore_pipeline_run_record()` so dispatch-time restore gets the same config validation, stale-running normalization, run-id preservation, retry restoration, and halted-pipeline handling as startup restore.

**Tech Stack:** Rust 2021, Tokio async tests, existing `PipelineRunJournal`, `Orchestrator`, `PipelineRunSnapshot`, and in-file orchestrator test doubles.

---

## File Structure

- Modify `crates/ensemble-core/src/orchestrator/pipeline_journal.rs`
  - Add a single-issue live record lookup.
  - Share live-record filtering with `latest_live_records()`.
  - Add unit coverage for the targeted lookup.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`
  - Add `restore_pipeline_run_for_candidate()`.
  - Call it from `handle_tick()` immediately before `dispatch_issue()` would create a fresh run.
  - Add a regression test that does not call startup restore.
- Modify `docs/SPEC.md`
  - Update pipeline run recovery and partial state recovery wording to include dispatch-time restore.

## Task 1: Add Targeted Live Journal Lookup

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/pipeline_journal.rs`

- [ ] **Step 1: Add the failing journal unit test**

Add this test in the existing `#[cfg(test)] mod tests` in `pipeline_journal.rs`, near the other live-record tests:

```rust
#[tokio::test]
async fn latest_live_record_for_issue_returns_latest_non_terminal_snapshot() {
    let dir = tempdir().unwrap();
    let journal = PipelineRunJournal::new(dir.path());

    journal
        .append(PipelineTransitionInput {
            kind: PipelineTransitionKind::RunStarted,
            issue_id: "issue/1".to_string(),
            identifier: "repo#1".to_string(),
            run_id: Some("run-1".to_string()),
            cycle: 1,
            step: None,
            reason: None,
            retry: None,
            snapshot: Some(snapshot()),
        })
        .await
        .unwrap();
    journal
        .append(PipelineTransitionInput {
            kind: PipelineTransitionKind::StepRunning,
            issue_id: "issue/1".to_string(),
            identifier: "repo#1".to_string(),
            run_id: Some("run-1".to_string()),
            cycle: 1,
            step: Some("build".to_string()),
            reason: None,
            retry: None,
            snapshot: Some(snapshot()),
        })
        .await
        .unwrap();

    let live = journal
        .latest_live_record_for_issue("issue/1")
        .await
        .unwrap()
        .unwrap();

    assert_eq!(live.seq, 2);
    assert_eq!(live.kind, PipelineTransitionKind::StepRunning);
    assert_eq!(live.run_id.as_deref(), Some("run-1"));
}

#[tokio::test]
async fn latest_live_record_for_issue_returns_none_for_terminal_record() {
    let dir = tempdir().unwrap();
    let journal = PipelineRunJournal::new(dir.path());

    journal
        .append(PipelineTransitionInput {
            kind: PipelineTransitionKind::RunStarted,
            issue_id: "issue/1".to_string(),
            identifier: "repo#1".to_string(),
            run_id: Some("run-1".to_string()),
            cycle: 1,
            step: None,
            reason: None,
            retry: None,
            snapshot: Some(snapshot()),
        })
        .await
        .unwrap();
    journal
        .append_released("issue/1", "repo#1", Some("run-1".to_string()), "completed")
        .await
        .unwrap();

    let live = journal
        .latest_live_record_for_issue("issue/1")
        .await
        .unwrap();

    assert!(live.is_none());
}
```

- [ ] **Step 2: Run the targeted journal tests and verify the failure**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::pipeline_journal::tests::latest_live_record_for_issue -- --nocapture
```

Expected: compilation fails because `PipelineRunJournal::latest_live_record_for_issue` does not exist.

- [ ] **Step 3: Add the targeted lookup and shared live filter**

In `impl PipelineRunJournal`, change `latest_live_records()` to use a helper and add the new method:

```rust
    pub async fn latest_live_records(
        &self,
    ) -> Result<Vec<PipelineTransitionRecord>, std::io::Error> {
        let mut records = Vec::new();
        let mut entries = match tokio::fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(record) = self.read_last_valid_record(&path).await? {
                if is_live_restore_record(&record) {
                    records.push(record);
                }
            }
        }

        records.sort_by(|left, right| left.issue_id.cmp(&right.issue_id));
        Ok(records)
    }

    pub async fn latest_live_record_for_issue(
        &self,
        issue_id: &str,
    ) -> Result<Option<PipelineTransitionRecord>, std::io::Error> {
        let record = self.read_last_valid_record(&self.path_for_issue(issue_id)).await?;
        Ok(record.filter(is_live_restore_record))
    }
```

Add this helper near `invalid_data()`:

```rust
fn is_live_restore_record(record: &PipelineTransitionRecord) -> bool {
    record.schema_version == SCHEMA_VERSION && !record.kind.is_terminal() && record.snapshot.is_some()
}
```

If `cargo fmt` wraps the boolean expression, keep the formatted version.

- [ ] **Step 4: Run the targeted journal tests and verify they pass**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::pipeline_journal::tests::latest_live_record_for_issue -- --nocapture
```

Expected: both new tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/pipeline_journal.rs
git commit -m "Add targeted pipeline journal restore lookup"
```

## Task 2: Add Dispatch-Time Rehydrate Before Fresh Runs

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add the failing regression test**

Add this test near `restored_live_pipeline_run_dispatches_on_next_tick()` in the existing orchestrator tests:

```rust
#[tokio::test]
async fn handle_tick_rehydrates_live_journal_before_fresh_dispatch() {
    let temp = tempfile::tempdir().unwrap();
    let yaml = r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Closed"]
agents:
  builder:
    executor: claude
    model: opus
    prompt: "Work on {{ issue.identifier }}."
steps:
  - name: implement
    agent: builder
  - name: review
    agent: builder
    depends: ["implement"]
max_cycles: 10
on_success: Done
on_failure: Todo
concurrency:
  max_concurrent_agents: 5
polling:
  interval_ms: 100
workspace:
  root: /tmp/ensemble-test
agent:
  max_turns: 3
  command: "echo test"
  session_mode: code
"#;
    let cfg = parse_config(yaml).unwrap();
    let issue = test_issue("1", "In Progress");
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
        issues: Arc::new(RwLock::new(vec![issue.clone()])),
    });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        observed_timeouts: None,
        cancellation_probe: None,
    });
    let config = Arc::new(RwLock::new(cfg.clone()));
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    drop(shutdown_tx);
    let state = Arc::new(RwLock::new(OrchestratorState::new(
        cfg.polling.interval_ms,
        &cfg.concurrency,
    )));
    let orchestrator = Orchestrator::new_with_state(
        OrchestratorRuntimeParts {
            state: Arc::clone(&state),
            config,
            tracker,
            agent_runner: runner,
            workspace_mgr: WorkspaceManager::new(&temp.path().join("workspaces"), None)
                .unwrap(),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            cancellation_registry: new_cancellation_registry(),
            event_bus: EventBus::new(),
            transcript_event_bus: TranscriptEventBus::new(),
            workspace_root: temp.path().join("workspaces"),
        },
        temp.path(),
        shutdown_rx,
    );

    let dag = build_dag(&cfg.steps).unwrap();
    let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
    run.step_completed("implement", succeeded_step_output(), false);
    run.mark_running("review", "stale-review-session".to_string());
    orchestrator
        .pipeline_journal
        .append(PipelineTransitionInput {
            kind: PipelineTransitionKind::StepRunning,
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            run_id: Some("run-existing".to_string()),
            cycle: 1,
            step: Some("review".to_string()),
            reason: None,
            retry: None,
            snapshot: Some(run.to_snapshot()),
        })
        .await
        .unwrap();

    orchestrator.handle_tick().await;

    let lock = state.read().await;
    assert!(lock.is_running(&issue.id));
    assert_eq!(
        lock.issue_run_ids.get(&issue.id).map(String::as_str),
        Some("run-existing")
    );
    let restored_run = lock.get_pipeline_run(&issue.id).unwrap();
    assert_eq!(
        restored_run.step_states.get("implement"),
        Some(&StepState::Passed)
    );
    assert!(matches!(
        restored_run.step_states.get("review"),
        Some(StepState::Running { session_id }) if session_id != "stale-review-session"
    ));

    let records = orchestrator
        .pipeline_journal
        .read_records_for_issue(&issue.id)
        .await
        .unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|record| record.kind == PipelineTransitionKind::RunStarted)
            .count(),
        0
    );
    assert!(records
        .iter()
        .any(|record| record.kind == PipelineTransitionKind::StepRunning && record.seq == 2));
}
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::handle_tick_rehydrates_live_journal_before_fresh_dispatch -- --nocapture
```

Expected: the assertion for `run-existing`, preserved `implement`, or zero fresh `RunStarted` records fails because `handle_tick()` creates a new run.

- [ ] **Step 3: Add the candidate restore helper**

In `impl Orchestrator`, immediately before `dispatch_issue()`, add:

```rust
    async fn restore_pipeline_run_for_candidate(
        &self,
        issue: &Issue,
    ) -> Result<bool, EnsembleError> {
        {
            let state = self.state.read().await;
            if state.get_pipeline_run(&issue.id).is_some()
                || state.is_running(&issue.id)
                || state.is_claimed(&issue.id)
            {
                return Ok(false);
            }
        }

        let record = self
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .map_err(|error| AgentError::IoError {
                reason: format!(
                    "failed to read pipeline transition journal for issue '{}': {error}",
                    issue.id
                ),
            })?;

        let Some(record) = record else {
            return Ok(false);
        };

        let config_snapshot = {
            let config = self.config.read().await;
            Arc::new(config.clone())
        };
        let issues_by_id = HashMap::from([(issue.id.clone(), issue.clone())]);
        self.restore_pipeline_run_record(&record, config_snapshot, &issues_by_id)
            .await?;

        let state = self.state.read().await;
        Ok(state.get_pipeline_run(&issue.id).is_some() && state.is_claimed(&issue.id))
    }
```

This helper deliberately does not fetch or create candidates. It only acts on the already eligible candidate passed by `handle_tick()`.

- [ ] **Step 4: Call the helper before fresh dispatch**

In `handle_tick()`, replace this block:

```rust
            if eligible.is_none() || restored_pipeline_ready {
                self.dispatch_issue(issue, None).await;
            }
```

with:

```rust
            if eligible.is_none() || restored_pipeline_ready {
                if eligible.is_none() && !restored_pipeline_ready {
                    match self.restore_pipeline_run_for_candidate(issue).await {
                        Ok(true) => {}
                        Ok(false) => {}
                        Err(error) => {
                            warn!(
                                issue_id = %issue.id,
                                identifier = %issue.identifier,
                                error = %error,
                                "failed to restore live pipeline journal before dispatch"
                            );
                        }
                    }
                }

                self.dispatch_issue(issue, None).await;
            }
```

This keeps dispatch control centralized in `dispatch_issue()`. When restore succeeds, `dispatch_issue()` takes its existing "resuming with existing pipeline" branch. When there is no live journal record or restore validation fails, dispatch proceeds as it does today.

- [ ] **Step 5: Run the regression test and verify it passes**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::handle_tick_rehydrates_live_journal_before_fresh_dispatch -- --nocapture
```

Expected: test passes. The restored run keeps `implement` as `Passed`, resumes `review`, preserves `run-existing`, and does not append a fresh `RunStarted`.

- [ ] **Step 6: Run adjacent orchestrator journal tests**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::restored_live_pipeline_run_dispatches_on_next_tick orchestrator::tests::dispatch_issue_writes_run_started_and_step_running_transitions -- --nocapture
```

Expected: both tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "Restore live journal snapshots before dispatch"
```

## Task 3: Update Recovery Documentation

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Update pipeline recovery wording**

In `docs/SPEC.md`, in section `4.1.6 Pipeline Run`, replace the startup-only recovery bullets:

```markdown
- On orchestrator startup, Ensemble restores the latest non-released snapshot for each issue before
  the first poll tick.
- Stale `Running` steps from a previous process are normalized to `Pending`; agent processes are not
  recovered across orchestrator restarts.
```

with:

```markdown
- On orchestrator startup, Ensemble restores the latest non-released snapshot for each issue before
  the first poll tick.
- During normal tick dispatch, before starting a candidate as a fresh pipeline, Ensemble checks that
  issue's latest journal record. If it is live and contains a snapshot, Ensemble restores that run
  instead of appending a new `run_started` record.
- Dispatch-time restore never creates new candidates; it only applies to issues already returned by
  the tracker as dispatch-eligible candidates.
- Stale `Running` steps from a previous process are normalized to `Pending`; agent processes are not
  recovered across orchestrator restarts or in-process journal rehydration.
```

- [ ] **Step 2: Update partial recovery wording**

In `docs/SPEC.md`, in section `14.3 Partial State Recovery (Restart)`, replace:

```markdown
- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work
```

with:

```markdown
- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - startup restoration of live pipeline journal snapshots
  - fresh polling of active issues
  - dispatch-time restoration of live journal snapshots for already eligible candidates
  - re-dispatching eligible work
```

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "Document dispatch-time journal restore"
```

## Task 4: Final Verification

**Files:**
- Test: `crates/ensemble-core/src/orchestrator/pipeline_journal.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: workspace formatting and clippy surface

- [ ] **Step 1: Run focused tests**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::pipeline_journal::tests::latest_live_record_for_issue -- --nocapture
rtk cargo test -p ensemble-core orchestrator::tests::handle_tick_rehydrates_live_journal_before_fresh_dispatch -- --nocapture
rtk cargo test -p ensemble-core orchestrator::tests::restored_live_pipeline_run_dispatches_on_next_tick orchestrator::tests::dispatch_issue_writes_run_started_and_step_running_transitions -- --nocapture
```

Expected: all focused tests pass.

- [ ] **Step 2: Run package tests**

Run:

```bash
rtk cargo test -p ensemble-core
```

Expected: all `ensemble-core` tests pass.

- [ ] **Step 3: Run formatting**

Run:

```bash
rtk cargo fmt --all -- --check
```

Expected: no formatting diff.

- [ ] **Step 4: Run clippy for the affected workspace subset**

Run:

```bash
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
```

Expected: clippy exits successfully with no warnings.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
rtk git diff -- crates/ensemble-core/src/orchestrator/pipeline_journal.rs crates/ensemble-core/src/orchestrator/mod.rs docs/SPEC.md
```

Expected: diff contains only the targeted journal lookup, dispatch-time restore, regression tests, and documentation updates.

---

## Self-Review Notes

- Spec coverage: The plan covers candidate-only dispatch restore, latest live snapshot lookup, startup validation reuse, stale `Running` normalization through `restore_pipeline_run_record()`, run-id preservation, and regression coverage for no fresh `RunStarted`.
- Placeholder scan: No task relies on unspecified code; all new functions and tests are shown with concrete code.
- Type consistency: The plan uses existing `PipelineRunJournal`, `PipelineTransitionRecord`, `PipelineTransitionKind`, `PipelineRun`, `StepState`, `OrchestratorState`, `AgentError`, and `EnsembleError` names exactly as they exist in the current code.
