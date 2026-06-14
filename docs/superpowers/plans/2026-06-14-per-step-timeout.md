# Per-step Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional per-step timeout configuration, enforce it in both agent runtimes, and route timeout failures through existing step-level failure policy.

**Architecture:** `StepConfig.timeout_ms` is optional and copied into the resolved DAG. Dispatch computes a concrete effective timeout by inheriting from `agent.turn_timeout_ms`, then passes it through `AgentRunRequest` to the runtime. Runtime timeout errors are classified so the orchestrator can handle them through `PipelineRun::step_failed` and the existing `on_failure` policy branch.

**Tech Stack:** Rust 2021, serde/serde_yaml, utoipa, tokio, tokio-util cancellation tokens, existing ACP/acpx runtime adapters, existing orchestrator tests.

---

## File Structure

- Modify `crates/ensemble-core/src/config/ensemble.rs`: add `StepConfig.timeout_ms`, validate positive values, add parse tests.
- Modify `crates/ensemble-core/src/pipeline/dag.rs`: add `DagStep.timeout_ms`, propagate from config, add DAG tests.
- Modify `crates/ensemble-core/src/pipeline/engine.rs`: add `DispatchRequest.timeout_ms`, propagate from `DagStep`, add dispatch tests.
- Modify `crates/ensemble-core/src/agent/events.rs`: add a worker failure classification that can preserve timeout identity.
- Modify `crates/ensemble-core/src/agent/mod.rs`: add `AgentRunRequest.timeout_ms`, pass it into direct ACP session config, update test request literals.
- Modify `crates/ensemble-core/src/agent/acpx_runtime.rs`: enforce prompt timeout with graceful `acpx cancel`, add timeout test.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`: compute effective timeout at dispatch, pass it to workers, classify timeout failures into the step-policy path.
- Modify test helper files containing `StepConfig` or `AgentRunRequest` literals:
  - `crates/ensemble-core/tests/step_output_templates.rs`
  - `crates/ensemble-core/src/orchestrator/pipeline_journal.rs`
  - `crates/ensemble-core/src/api/controls.rs`
  - `crates/ensemble-core/src/observability/snapshot.rs`
  - `crates/ensemble-core/src/pipeline/dag.rs`
  - `crates/ensemble-core/src/pipeline/engine.rs`
  - `crates/ensemble-core/src/agent/acpx_runtime.rs`
- Modify `docs/SPEC.md` and `docs/configuration.md`: document `steps[].timeout_ms`.

---

### Task 1: Add Config Field And Validation

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write parsing and validation tests**

Add these tests inside `#[cfg(test)] mod tests` in `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[test]
fn test_parse_step_timeout_ms() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    prompt: Build it
steps:
  - name: build
    agent: builder
    timeout_ms: 120000
on_success: Done
on_failure: Failed
"#;

    let config = parse_config(yaml).unwrap();

    assert_eq!(config.steps[0].timeout_ms, Some(120_000));
}

#[test]
fn test_parse_step_timeout_ms_defaults_to_none() {
    let config = parse_config(&minimal_yaml()).unwrap();

    assert_eq!(config.steps[0].timeout_ms, None);
}

#[test]
fn test_step_timeout_ms_zero_is_invalid() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    prompt: Build it
steps:
  - name: build
    agent: builder
    timeout_ms: 0
on_success: Done
on_failure: Failed
"#;

    let error = parse_config(yaml).unwrap_err();

    assert!(matches!(
        error,
        PipelineError::InvalidStepConfig { ref step, ref reason }
            if step == "build" && reason == "timeout_ms must be greater than 0"
    ));
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core config::ensemble::tests::test_parse_step_timeout_ms config::ensemble::tests::test_parse_step_timeout_ms_defaults_to_none config::ensemble::tests::test_step_timeout_ms_zero_is_invalid
```

Expected: compile failure mentioning `no field timeout_ms on type StepConfig`.

- [ ] **Step 3: Add the config field**

In `StepConfig`, add `timeout_ms` after `tracker_state`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
```

- [ ] **Step 4: Add validation**

Inside the `for step in &config.steps` loop that validates agents and fixup configuration, add:

```rust
        if step.timeout_ms == Some(0) {
            return Err(PipelineError::InvalidStepConfig {
                step: step.name.clone(),
                reason: "timeout_ms must be greater than 0".to_string(),
            });
        }
```

- [ ] **Step 5: Update existing `StepConfig` literals**

For every `StepConfig { ... }` compile error, add this field near `tracker_state`:

```rust
            timeout_ms: None,
```

Use this search command to check the known literal sites:

```bash
rtk rg -n "StepConfig \\{" crates/ensemble-core/src crates/ensemble-core/tests crates/ensemble-cli/src crates/ensemble-cli/tests
```

- [ ] **Step 6: Run config tests**

Run:

```bash
rtk cargo test -p ensemble-core config::ensemble::tests::test_parse_step_timeout_ms config::ensemble::tests::test_parse_step_timeout_ms_defaults_to_none config::ensemble::tests::test_step_timeout_ms_zero_is_invalid
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/pipeline/dag.rs crates/ensemble-core/src/pipeline/engine.rs crates/ensemble-core/src/orchestrator/pipeline_journal.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/tests/step_output_templates.rs
rtk git commit -m "feat: add per-step timeout config"
```

---

### Task 2: Propagate Timeout Through DAG And Dispatch Requests

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/dag.rs`
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Write DAG propagation test**

Add this test to `crates/ensemble-core/src/pipeline/dag.rs` tests:

```rust
#[test]
fn build_dag_preserves_step_timeout_ms() {
    let steps = vec![StepConfig {
        name: "build".to_string(),
        kind: StepKind::Agent,
        agent: "builder".to_string(),
        depends: Some(vec![]),
        tracker_state: None,
        timeout_ms: Some(120_000),
        approval: None,
        on_failure: OnFailure::RetryIssue,
        fixup_agent: None,
    }];

    let dag = build_dag(&steps).unwrap();

    assert_eq!(dag.steps[0].timeout_ms, Some(120_000));
}
```

- [ ] **Step 2: Write dispatch propagation test**

Add this test to `crates/ensemble-core/src/pipeline/engine.rs` tests:

```rust
#[test]
fn dispatch_request_carries_step_timeout_ms() {
    let steps = vec![StepConfig {
        name: "build".to_string(),
        kind: StepKind::Agent,
        agent: "builder".to_string(),
        depends: Some(vec![]),
        tracker_state: None,
        timeout_ms: Some(90_000),
        approval: None,
        on_failure: OnFailure::RetryIssue,
        fixup_agent: None,
    }];
    let run = make_run(&steps);

    let PipelineAction::Dispatch(requests) = run.start() else {
        panic!("expected dispatch action");
    };

    assert_eq!(requests[0].timeout_ms, Some(90_000));
}
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::dag::tests::build_dag_preserves_step_timeout_ms pipeline::engine::tests::dispatch_request_carries_step_timeout_ms
```

Expected: compile failure mentioning `timeout_ms`.

- [ ] **Step 4: Add fields and propagation**

In `DagStep`, add:

```rust
    pub timeout_ms: Option<u64>,
```

In `build_dag`, add this field to `DagStep` construction:

```rust
            timeout_ms: step.timeout_ms,
```

In `DispatchRequest`, add:

```rust
    /// Optional per-step turn timeout in milliseconds.
    pub timeout_ms: Option<u64>,
```

In `PipelineRun::find_dispatchable`, add this field to `DispatchRequest` construction:

```rust
                timeout_ms: s.timeout_ms,
```

Run `rtk rg -n "DagStep \\{" crates/ensemble-core/src crates/ensemble-core/tests` and add
`timeout_ms: None` to each direct `DagStep` literal reported by that command. The current codebase
constructs `DagStep` in `build_dag`, so this command is expected to report that constructor only.

- [ ] **Step 5: Run tests**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::dag::tests::build_dag_preserves_step_timeout_ms pipeline::engine::tests::dispatch_request_carries_step_timeout_ms
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/pipeline/dag.rs crates/ensemble-core/src/pipeline/engine.rs
rtk git commit -m "feat: propagate step timeout through pipeline dispatch"
```

---

### Task 3: Pass Effective Timeout Into AgentRunRequest

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs`

- [ ] **Step 1: Write orchestrator request test**

In `crates/ensemble-core/src/orchestrator/mod.rs`, extend `MockRunner`:

```rust
    observed_timeouts: Option<Arc<RwLock<Vec<u64>>>>,
```

Inside `MockRunner::run`, after the existing `observed_commands` block, add:

```rust
            if let Some(observed_timeouts) = &self.observed_timeouts {
                observed_timeouts.write().await.push(request.timeout_ms);
            }
```

Update existing `MockRunner` initializers with:

```rust
            observed_timeouts: None,
```

Add this test near other dispatch tests:

```rust
#[tokio::test]
async fn dispatch_passes_effective_step_timeout_to_agent_runner() {
    let observed_timeouts = Arc::new(RwLock::new(Vec::new()));
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        observed_timeouts: Some(Arc::clone(&observed_timeouts)),
        cancellation_probe: None,
    });
    let mut raw_config = make_config();
    raw_config.steps[0].timeout_ms = Some(1234);
    let config = Arc::new(RwLock::new(raw_config));
    let issue = test_issue("issue-timeout", "Todo");
    let issues = Arc::new(RwLock::new(vec![issue.clone()]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let dir = tempfile::TempDir::new().unwrap();
    let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
    let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let orchestrator = Orchestrator::new(
        config,
        tracker,
        runner,
        workspace_mgr,
        dir.path(),
        shutdown_rx,
    );

    orchestrator.dispatch_issue(&issue, 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(*observed_timeouts.read().await, vec![1234]);
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::dispatch_passes_effective_step_timeout_to_agent_runner
```

Expected: compile failure mentioning `AgentRunRequest` has no field `timeout_ms`.

- [ ] **Step 3: Add timeout to request types**

In `AgentRunRequest`, add:

```rust
    /// Effective per-step turn timeout in milliseconds.
    pub timeout_ms: u64,
```

In `StepDispatchContext`, add:

```rust
    timeout_ms: u64,
```

Add this helper near other orchestrator helper methods:

```rust
    fn effective_step_timeout_ms(
        timeout_ms: Option<u64>,
        config: &EnsembleConfig,
    ) -> u64 {
        timeout_ms.unwrap_or(config.agent.turn_timeout_ms)
    }
```

Whenever constructing `StepDispatchContext` from a `DispatchRequest`, add:

```rust
                                        timeout_ms: Self::effective_step_timeout_ms(
                                            req.timeout_ms,
                                            &config_snapshot,
                                        ),
```

For resume paths that dispatch a `DagStep`, add:

```rust
                        timeout_ms: Self::effective_step_timeout_ms(
                            current_step.timeout_ms,
                            &current_config,
                        ),
```

In `dispatch_step`, pass the field into `AgentRunRequest`:

```rust
                    timeout_ms: dispatch.timeout_ms,
```

Update all direct `AgentRunRequest` literals in tests with:

```rust
            timeout_ms: config.agent.turn_timeout_ms,
```

or a concrete small value where the test needs one:

```rust
            timeout_ms: 100,
```

- [ ] **Step 4: Run the test**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::dispatch_passes_effective_step_timeout_to_agent_runner
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/agent/acpx_runtime.rs
rtk git commit -m "feat: pass step timeout to agent runners"
```

---

### Task 4: Use Step Timeout In Direct ACP Runtime

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write a focused helper test**

Add this private helper near `run_direct_step`:

```rust
fn effective_request_timeout_ms(request: &AgentRunRequest<'_>) -> u64 {
    request.timeout_ms
}
```

Add this test in `crates/ensemble-core/src/agent/mod.rs` tests:

```rust
#[test]
fn direct_runtime_uses_agent_run_request_timeout() {
    let config = Arc::new(parse_config(minimal_config()).unwrap());
    let issue = test_issue();
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let request = AgentRunRequest {
        config,
        issue: &issue,
        agent_name: "builder",
        step_name: "build",
        step_kind: StepKind::Agent,
        attempt: None,
        interaction_response: None,
        workspace_path: Path::new("."),
        event_tx: tx,
        cancel_token: CancellationToken::new(),
        timeout_ms: 3210,
        step_outputs: StepOutputTemplateContext::default(),
    };

    assert_eq!(effective_request_timeout_ms(&request), 3210);
}
```

- [ ] **Step 2: Run test and verify it passes after Task 3**

Run:

```bash
rtk cargo test -p ensemble-core agent::tests::direct_runtime_uses_agent_run_request_timeout
```

Expected: PASS.

- [ ] **Step 3: Wire direct ACP session config**

In `run_direct_step`, replace:

```rust
            turn_timeout_ms: config.agent.turn_timeout_ms,
```

with:

```rust
            turn_timeout_ms: request.timeout_ms,
```

- [ ] **Step 4: Run agent tests for the direct path**

Run:

```bash
rtk cargo test -p ensemble-core agent::tests::direct_runtime_uses_agent_run_request_timeout agent::acp_client::tests::startup_initialize_uses_configured_read_timeout
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/mod.rs
rtk git commit -m "feat: use step timeout for direct ACP turns"
```

---

### Task 5: Enforce Step Timeout In `acpx` Runtime

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs`

- [ ] **Step 1: Write timeout test**

Add this test to `crates/ensemble-core/src/agent/acpx_runtime.rs` tests:

```rust
#[tokio::test]
async fn acpx_runtime_times_out_prompt_with_graceful_cancel() {
    let workspace = tempfile::TempDir::new().unwrap();
    let args_path = workspace.path().join("args.txt");
    let script_path = write_mock_acpx_script(
        workspace.path(),
        &format!(
            r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    while [ ! -f "{}/cancelled.flag" ]; do
      /bin/sleep 0.05
    done
    printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"cancelled"}}}}'
    exit 0
    ;;
  *" cancel --session "*)
    : > "{}/cancelled.flag"
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
            args_path.display(),
            workspace.path().display(),
            workspace.path().display()
        ),
    );

    let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let issue = test_issue("issue-1", "Todo");
    let config = test_config();
    let request = AgentRunRequest {
        config,
        issue: &issue,
        agent_name: "builder",
        step_name: "build",
        step_kind: StepKind::Agent,
        attempt: None,
        interaction_response: None,
        workspace_path: workspace.path(),
        event_tx: tx,
        cancel_token: CancellationToken::new(),
        timeout_ms: 100,
        step_outputs: StepOutputTemplateContext::default(),
    };

    let result = runner.run_step(&request, "finish the task").await;

    assert!(matches!(
        result,
        Err(AgentError::TurnTimeout { timeout_ms: 100 })
    ));
    let args = std::fs::read_to_string(args_path).unwrap();
    assert!(args.contains("cancel --session"));
    assert!(args.contains("sessions close"));
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_runtime::tests::acpx_runtime_times_out_prompt_with_graceful_cancel
```

Expected: test hangs until the outer harness times out or fails because `AgentError::TurnTimeout` is not returned.

- [ ] **Step 3: Add timeout around prompt execution**

In `run_prompt_with_cancellation`, wrap the prompt future in a timeout branch. Replace the current `tokio::select!` with this structure:

```rust
        tokio::select! {
            result = tokio::time::timeout(
                std::time::Duration::from_millis(request.timeout_ms),
                &mut run_prompt,
            ) => {
                match result {
                    Ok(result) => result,
                    Err(_) => {
                        debug!(
                            issue_id = %request.issue.id,
                            step = request.step_name,
                            prompt_request.session_name,
                            timeout_ms = request.timeout_ms,
                            "timing out acpx prompt"
                        );
                        self.cli
                            .cancel(
                                prompt_request.acpx_agent,
                                prompt_request.session_name,
                                request.workspace_path,
                                prompt_request.command_options,
                            )
                            .await?;

                        if prompt_request.visibility == PromptVisibility::Visible {
                            emit_event(
                                &request.event_tx,
                                &request.issue.id,
                                request.step_name,
                                AgentEvent::RunFailed {
                                    reason: format!(
                                        "turn timeout after {}ms",
                                        request.timeout_ms
                                    ),
                                    usage: None,
                                },
                            )
                            .await;
                        }

                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            run_prompt,
                        )
                        .await;

                        Err(AgentError::TurnTimeout {
                            timeout_ms: request.timeout_ms,
                        })
                    }
                }
            }
            _ = request.cancel_token.cancelled() => {
                debug!(
                    issue_id = %request.issue.id,
                    step = request.step_name,
                    prompt_request.session_name,
                    "cancelling acpx prompt"
                );
                self.cli
                    .cancel(
                        prompt_request.acpx_agent,
                        prompt_request.session_name,
                        request.workspace_path,
                        prompt_request.command_options,
                    )
                    .await?;

                if prompt_request.visibility == PromptVisibility::Visible {
                    emit_event(
                        &request.event_tx,
                        &request.issue.id,
                        request.step_name,
                        AgentEvent::Cancelled {
                            reason: Some("cancel requested".to_string()),
                        },
                    )
                    .await;
                }

                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run_prompt).await;

                Err(AgentError::TurnCancelled)
            }
        }
```

- [ ] **Step 4: Run acpx timeout and cancellation tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_runtime::tests::acpx_runtime_times_out_prompt_with_graceful_cancel agent::acpx_runtime::tests::acpx_runtime_cancels_prompt_when_token_is_cancelled
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/acpx_runtime.rs
rtk git commit -m "feat: enforce step timeout in acpx runtime"
```

---

### Task 6: Route Timeout Failures Through Step Policy

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add failure classification**

In `crates/ensemble-core/src/agent/events.rs`, add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerFailureKind {
    Timeout,
    Runtime,
}
```

Change `WorkerResult::Failed` to:

```rust
    Failed {
        error: String,
        kind: WorkerFailureKind,
    },
```

Update direct `WorkerResult::Failed` constructors that are not timeout-specific to include:

```rust
        kind: WorkerFailureKind::Runtime,
```

- [ ] **Step 2: Classify `AgentError::TurnTimeout` in `catch_worker_panic`**

In `crates/ensemble-core/src/orchestrator/mod.rs`, change the `Ok(Err(e))` branch to:

```rust
        Ok(Err(e)) => {
            let kind = if matches!(e, AgentError::TurnTimeout { .. }) {
                WorkerFailureKind::Timeout
            } else {
                WorkerFailureKind::Runtime
            };
            WorkerResult::Failed {
                error: e.to_string(),
                kind,
            }
        }
```

Change the panic branch to:

```rust
            WorkerResult::Failed {
                error: "worker task panicked".to_string(),
                kind: WorkerFailureKind::Runtime,
            }
```

- [ ] **Step 3: Write timeout policy test**

Add this test in `crates/ensemble-core/src/orchestrator/mod.rs` tests:

```rust
#[tokio::test]
async fn timeout_failure_uses_step_retry_policy() {
    let config = Arc::new(RwLock::new(make_retry_step_config()));
    let issues = Arc::new(RwLock::new(vec![]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        observed_timeouts: None,
        cancellation_probe: None,
    });
    let dir = tempfile::TempDir::new().unwrap();
    let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
    let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let orchestrator = Orchestrator::new(
        config.clone(),
        tracker,
        runner,
        workspace_mgr,
        dir.path(),
        shutdown_rx,
    );
    let issue = test_issue("issue-timeout-retry", "Todo");

    {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut pipeline_run = PipelineRun::new(issue.id.clone(), 1, dag);
        pipeline_run.start();
        pipeline_run.mark_running("build", "session-1".to_string());

        let mut state = orchestrator.state.write().await;
        state.add_running(&issue, Some(1));
        state.insert_pipeline_run(&issue.id, pipeline_run, Arc::new(cfg.clone()));
    }

    orchestrator
        .handle_worker_exit(
            &issue.id,
            "build",
            WorkerResult::Failed {
                error: "turn timeout after 100ms".to_string(),
                kind: WorkerFailureKind::Timeout,
            },
        )
        .await;

    let state = orchestrator.state.read().await;
    let retry = state
        .retry_attempts
        .get(&issue.id)
        .expect("retry should be scheduled");
    assert_eq!(retry.retry_from_step.as_deref(), Some("build"));
    assert_eq!(retry.error.as_deref(), Some("turn timeout after 100ms"));
}
```

- [ ] **Step 4: Run test and verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::timeout_failure_uses_step_retry_policy
```

Expected: failure showing `retry_from_step` is `None` because the worker failure path scheduled an issue-level retry.

- [ ] **Step 5: Route timeout worker failures to pipeline policy**

Change the worker exit match arm to include `kind`:

```rust
            WorkerResult::Failed { error, kind } => {
```

At the top of that arm, before the existing generic failure scheduling logic, add:

```rust
                if kind == WorkerFailureKind::Timeout {
                    let config = self.config.read().await;
                    let mut state = self.state.write().await;
                    let action_and_config = state.get_pipeline_run_mut(issue_id).map(|run| {
                        (
                            run.step_failed(step_name, error.clone()),
                            state.get_pipeline_config(issue_id).cloned(),
                        )
                    });
                    drop(state);
                    drop(config);

                    if let Some((PipelineAction::Failed { step, reason }, Some(_config_snapshot))) =
                        action_and_config
                    {
                        self.handle_pipeline_step_failure(issue_id, &step, reason).await;
                        return;
                    }
                }
```

Extract the existing `PipelineAction::Failed { step, reason }` handling block from the success path into this helper signature:

```rust
    async fn handle_pipeline_step_failure(
        &self,
        issue_id: &str,
        step: &str,
        reason: String,
    )
```

Move the full current `PipelineAction::Failed` branch body into that helper, preserving its
`OnFailure::RetryStep`, `OnFailure::Fixup`, `OnFailure::Halt`, and `OnFailure::RetryIssue`
branches. The original success-path match arm becomes:

```rust
                        PipelineAction::Failed { step, reason } => {
                            self.handle_pipeline_step_failure(issue_id, &step, reason)
                                .await;
                        }
```

The timeout path calls the same helper after `PipelineRun::step_failed` returns
`PipelineAction::Failed`.

- [ ] **Step 6: Run policy tests**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests::timeout_failure_uses_step_retry_policy orchestrator::tests::step_failure_retry_step_schedules_retry_from_failed_step orchestrator::tests::step_failure_fixup_schedules_fixup_retry
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/agent/mod.rs
rtk git commit -m "feat: apply step failure policy to timeouts"
```

---

### Task 7: Update Documentation And API Schema

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: OpenAPI snapshot file when `cargo test -p ensemble-core --test openapi_spec` reports the expected `StepConfig.timeout_ms` schema diff.

- [ ] **Step 1: Update configuration docs**

In `docs/configuration.md`, add `timeout_ms` to the pipeline step example:

```yaml
steps:
  - name: build
    agent: builder
    tracker_state: Building
    timeout_ms: 600000
```

In the step field reference table, add:

```markdown
| `timeout_ms` | integer | inherits `agent.turn_timeout_ms` | Optional maximum time for each runtime prompt or turn in this step |
```

- [ ] **Step 2: Update SPEC**

In `docs/SPEC.md`, update `StepConfig` to include:

```markdown
- `timeout_ms` (integer, optional)
  - Maximum time in milliseconds for each runtime prompt or turn associated with this step.
  - Defaults to `agent.turn_timeout_ms` when omitted.
  - Must be greater than `0` when present.
```

In the timeout section, add:

```markdown
- `steps[].timeout_ms`: optional per-step override for `agent.turn_timeout_ms`; enforced per runtime prompt or turn, including hidden extraction and repair turns for that step.
```

- [ ] **Step 3: Run OpenAPI test**

Run:

```bash
rtk cargo test -p ensemble-core --test openapi_spec
```

Expected: PASS, or a deliberate schema snapshot diff that only adds `timeout_ms` to `StepConfig`.

- [ ] **Step 4: Commit**

Run:

```bash
rtk git add docs/SPEC.md docs/configuration.md crates/ensemble-core/tests
rtk git commit -m "docs: document per-step timeout configuration"
```

---

### Task 8: Final Verification

**Files:**
- Verify entire touched surface.

- [ ] **Step 1: Run focused Rust tests**

Run:

```bash
rtk cargo test -p ensemble-core config::ensemble::tests::test_parse_step_timeout_ms config::ensemble::tests::test_parse_step_timeout_ms_defaults_to_none config::ensemble::tests::test_step_timeout_ms_zero_is_invalid pipeline::dag::tests::build_dag_preserves_step_timeout_ms pipeline::engine::tests::dispatch_request_carries_step_timeout_ms agent::acpx_runtime::tests::acpx_runtime_times_out_prompt_with_graceful_cancel orchestrator::tests::timeout_failure_uses_step_retry_policy
```

Expected: PASS.

- [ ] **Step 2: Run core crate tests**

Run:

```bash
rtk cargo test -p ensemble-core
```

Expected: PASS.

- [ ] **Step 3: Run workspace checks excluding desktop**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
rtk git status --short
rtk git log --oneline -8
```

Expected: working tree clean and commits from Tasks 1-7 present.
