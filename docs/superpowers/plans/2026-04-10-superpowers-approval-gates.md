# Superpowers Approval Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic per-step approval gates to Ensemble so a `plan -> implement -> review` pipeline can pause between steps, resume durably, and support both full-plan approval and lightweight continuation.

**Architecture:** Extend `StepConfig` with an optional approval policy, carry that policy through the pipeline DAG, and add a post-step approval checkpoint path that uses the existing interaction store instead of tracker-state hacks. Keep step-level blocked-on-human behavior for in-step questions, but add a distinct post-step approval checkpoint that resumes by advancing the DAG rather than rerunning the same step.

**Tech Stack:** Rust 2021, serde, utoipa/OpenAPI, tokio, existing Ensemble interaction store/orchestrator/pipeline engine.

---

### Task 1: Add step approval config to the typed config model

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/pipeline/dag.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs` (`#[cfg(test)]`)
- Test: `crates/ensemble-core/src/pipeline/dag.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing config parsing tests for step approval**

Add tests in `crates/ensemble-core/src/config/ensemble.rs` for:

```rust
#[test]
fn parses_step_approval_config_from_yaml() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  planner:
    acpx_agent: codex
    prompt: Plan it.
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
on_success: Done
on_failure: Failed
"#;

    let config = parse_config(yaml).expect("config should parse");
    let approval = config.steps[0].approval.as_ref().expect("approval config");
    assert_eq!(approval.mode, StepApprovalMode::WhenRequestedByAgent);
    assert_eq!(approval.state.as_deref(), Some("Plan Review"));
}

#[test]
fn defaults_step_approval_to_none() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  planner:
    acpx_agent: codex
    prompt: Plan it.
steps:
  - name: plan
    agent: planner
on_success: Done
on_failure: Failed
"#;

    let config = parse_config(yaml).expect("config should parse");
    assert!(config.steps[0].approval.is_none());
}
```

- [ ] **Step 2: Run the config parsing tests and confirm they fail**

Run:

```bash
rtk cargo test -p ensemble-core config::ensemble::tests::parses_step_approval_config_from_yaml -- --exact
rtk cargo test -p ensemble-core config::ensemble::tests::defaults_step_approval_to_none -- --exact
```

Expected: compile or assertion failure because `StepConfig` does not yet expose `approval`.

- [ ] **Step 3: Add `StepApprovalConfig` and `StepApprovalMode` to the config model**

Update `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct StepApprovalConfig {
    pub mode: StepApprovalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepApprovalMode {
    Always,
    WhenRequestedByAgent,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepConfig {
    pub name: String,
    pub agent: String,
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<StepApprovalConfig>,
}
```

Also carry the new field through `DagStep` in `crates/ensemble-core/src/pipeline/dag.rs`:

```rust
pub struct DagStep {
    pub name: String,
    pub agent: String,
    pub tracker_state: Option<String>,
    pub approval: Option<StepApprovalConfig>,
    pub depends: Vec<String>,
}
```

- [ ] **Step 4: Add a DAG test proving approval metadata survives graph construction**

Add a test in `crates/ensemble-core/src/pipeline/dag.rs`:

```rust
#[test]
fn preserves_step_approval_metadata() {
    let steps = vec![StepConfig {
        name: "plan".to_string(),
        agent: "planner".to_string(),
        depends: Some(vec![]),
        tracker_state: Some("Planning".to_string()),
        approval: Some(StepApprovalConfig {
            mode: StepApprovalMode::Always,
            state: Some("Plan Review".to_string()),
        }),
    }];

    let dag = build_dag(&steps).expect("dag");
    assert_eq!(dag.steps[0].approval.as_ref().unwrap().mode, StepApprovalMode::Always);
    assert_eq!(dag.steps[0].approval.as_ref().unwrap().state.as_deref(), Some("Plan Review"));
}
```

- [ ] **Step 5: Run the focused tests and then commit**

Run:

```bash
rtk cargo test -p ensemble-core config::ensemble::tests -- --nocapture
rtk cargo test -p ensemble-core pipeline::dag::tests -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/pipeline/dag.rs
git commit -m "Add step approval config model"
```

### Task 2: Teach the agent runner to emit post-step approval requests

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing tests for approval-request file detection**

Add tests in `crates/ensemble-core/src/agent/mod.rs` for:

```rust
#[tokio::test]
async fn detect_worker_result_reads_post_step_approval_request() {
    let temp = tempfile::tempdir().unwrap();
    let ensemble_dir = temp.path().join(".ensemble");
    tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
    tokio::fs::write(
        ensemble_dir.join("approval-request.json"),
        serde_json::to_vec_pretty(&StepApprovalRequestDraft {
            schema_version: 1,
            title: "Review plan".to_string(),
            body: "Please approve the generated SPEC and PLAN.".to_string(),
            state: Some("Plan Review".to_string()),
        })
        .unwrap(),
    )
    .await
    .unwrap();

    let result = detect_worker_result(temp.path()).await;
    assert!(matches!(
        result,
        WorkerResult::Success {
            approval_request: Some(_),
            ..
        }
    ));
}

#[tokio::test]
async fn detect_worker_result_rejects_both_interaction_and_post_step_approval() {
    let temp = tempfile::tempdir().unwrap();
    let ensemble_dir = temp.path().join(".ensemble");
    tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
    tokio::fs::write(
        ensemble_dir.join("interaction-request.json"),
        br#"{"schema_version":1,"kind":"brainstorm_prompt","blocking":true,"title":"Q","body":"Q","options":[],"artifacts":[]}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        ensemble_dir.join("approval-request.json"),
        br#"{"schema_version":1,"title":"Review","body":"Review","state":"Plan Review"}"#,
    )
    .await
    .unwrap();

    let result = detect_worker_result(temp.path()).await;
    assert!(matches!(result, WorkerResult::Failed { .. }));
}
```

- [ ] **Step 2: Run the focused agent tests and confirm they fail**

Run:

```bash
rtk cargo test -p ensemble-core detect_worker_result_reads_post_step_approval_request -- --exact
rtk cargo test -p ensemble-core detect_worker_result_rejects_both_interaction_and_post_step_approval -- --exact
```

Expected: compile failure because `StepApprovalRequestDraft` and `approval_request` do not exist yet.

- [ ] **Step 3: Add a dedicated `StepApprovalRequestDraft` and extend `WorkerResult::Success`**

Update `crates/ensemble-core/src/agent/events.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepApprovalRequestDraft {
    pub schema_version: u32,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub state: Option<String>,
}

pub enum WorkerResult {
    Success {
        runtime_verdict: Option<serde_json::Value>,
        approval_request: Option<StepApprovalRequestDraft>,
    },
    BlockedOnHuman {
        request: InteractionRequestDraft,
    },
    Failed {
        error: String,
    },
}
```

Update `crates/ensemble-core/src/agent/mod.rs` so `detect_worker_result_with_runtime_verdict()` reads `.ensemble/approval-request.json` and enforces these conflict rules:

```rust
let approval_request_path = workspace_path
    .join(".ensemble")
    .join("approval-request.json");

let approval_request = match tokio::fs::read_to_string(&approval_request_path).await {
    Ok(contents) => Some(
        serde_json::from_str::<StepApprovalRequestDraft>(&contents).map_err(|error| {
            AgentError::PromptError {
                reason: format!(
                    "failed to parse .ensemble/approval-request.json: {error}"
                ),
            }
        })?,
    ),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
    Err(error) => {
        return WorkerResult::Failed {
            error: format!("failed to read .ensemble/approval-request.json: {error}"),
        };
    }
};

match (interaction_request, approval_request, verdict_exists) {
    (Some(_), Some(_), _) => WorkerResult::Failed {
        error: "agent produced both .ensemble/interaction-request.json and .ensemble/approval-request.json".to_string(),
    },
    (Some(_), None, true) => WorkerResult::Failed {
        error: "agent produced both .ensemble/interaction-request.json and .ensemble/verdict.json".to_string(),
    },
    (Some(request), None, false) => WorkerResult::BlockedOnHuman { request },
    (None, approval_request, _) => WorkerResult::Success {
        runtime_verdict,
        approval_request,
    },
}
```

- [ ] **Step 4: Add one test proving invalid JSON fails loudly**

Add:

```rust
#[tokio::test]
async fn detect_worker_result_fails_on_invalid_post_step_approval_json() {
    let temp = tempfile::tempdir().unwrap();
    let ensemble_dir = temp.path().join(".ensemble");
    tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
    tokio::fs::write(
        ensemble_dir.join("approval-request.json"),
        b"{ not valid json",
    )
    .await
    .unwrap();

    let result = detect_worker_result(temp.path()).await;
    assert!(matches!(result, WorkerResult::Failed { .. }));
}
```

- [ ] **Step 5: Run the focused tests and then commit**

Run:

```bash
rtk cargo test -p ensemble-core detect_worker_result -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "Capture post-step approval requests from workers"
```

### Task 3: Extend the pipeline engine with approval checkpoints

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`
- Test: `crates/ensemble-core/src/pipeline/engine.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing state-machine tests for approval checkpoints**

Add tests in `crates/ensemble-core/src/pipeline/engine.rs`:

```rust
#[test]
fn approved_step_with_always_gate_waits_for_approval() {
    let steps = vec![
        StepConfig {
            name: "plan".to_string(),
            agent: "planner".to_string(),
            depends: Some(vec![]),
            tracker_state: Some("Planning".to_string()),
            approval: Some(StepApprovalConfig {
                mode: StepApprovalMode::Always,
                state: Some("Plan Review".to_string()),
            }),
        },
        StepConfig {
            name: "implement".to_string(),
            agent: "builder".to_string(),
            depends: Some(vec!["plan".to_string()]),
            tracker_state: Some("In Progress".to_string()),
            approval: None,
        },
    ];

    let mut run = make_run(&steps);
    run.mark_running("plan", "session-1".to_string());

    let action = run.step_completed("plan", Verdict::Approve, false);
    assert!(matches!(action, PipelineAction::AwaitingApproval { .. }));
}

#[test]
fn approve_gate_dispatches_downstream_steps() {
    let steps = vec![
        StepConfig {
            name: "plan".to_string(),
            agent: "planner".to_string(),
            depends: Some(vec![]),
            tracker_state: Some("Planning".to_string()),
            approval: Some(StepApprovalConfig {
                mode: StepApprovalMode::Always,
                state: Some("Plan Review".to_string()),
            }),
        },
        StepConfig {
            name: "implement".to_string(),
            agent: "builder".to_string(),
            depends: Some(vec!["plan".to_string()]),
            tracker_state: Some("In Progress".to_string()),
            approval: None,
        },
    ];
    let mut run = make_run(&steps);
    run.mark_running("plan", "session-1".to_string());
    let _ = run.step_completed("plan", Verdict::Approve, false);

    let action = run.approve_gate("plan");
    assert!(matches!(&action, PipelineAction::Dispatch(reqs) if reqs[0].step_name == "implement"));
}

#[test]
fn conditional_gate_only_triggers_when_worker_requested_it() {
    let steps = vec![
        StepConfig {
            name: "plan".to_string(),
            agent: "planner".to_string(),
            depends: Some(vec![]),
            tracker_state: Some("Planning".to_string()),
            approval: Some(StepApprovalConfig {
                mode: StepApprovalMode::WhenRequestedByAgent,
                state: Some("Plan Review".to_string()),
            }),
        },
        StepConfig {
            name: "implement".to_string(),
            agent: "builder".to_string(),
            depends: Some(vec!["plan".to_string()]),
            tracker_state: Some("In Progress".to_string()),
            approval: None,
        },
    ];
    let mut run = make_run(&steps);
    run.mark_running("plan", "session-1".to_string());

    let no_gate = run.step_completed("plan", Verdict::Approve, false);
    assert!(matches!(&no_gate, PipelineAction::Dispatch(reqs) if reqs[0].step_name == "implement"));
}
```

- [ ] **Step 2: Run the pipeline engine tests and confirm they fail**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::engine::tests::approved_step_with_always_gate_waits_for_approval -- --exact
rtk cargo test -p ensemble-core pipeline::engine::tests::approve_gate_dispatches_downstream_steps -- --exact
rtk cargo test -p ensemble-core pipeline::engine::tests::conditional_gate_only_triggers_when_worker_requested_it -- --exact
```

Expected: compile failure because `PipelineAction::AwaitingApproval`, `approve_gate`, and the extra `step_completed()` argument do not exist yet.

- [ ] **Step 3: Add approval-aware step state and actions**

Update `crates/ensemble-core/src/pipeline/engine.rs`:

```rust
pub enum StepState {
    Pending,
    Running { session_id: String },
    BlockedOnHuman { interaction_request_id: String },
    AwaitingApproval { interaction_request_id: String },
    Passed,
    Rejected { summary: String },
    Failed { error: String },
}

pub enum PipelineAction {
    Dispatch(Vec<DispatchRequest>),
    BlockedOnHuman { step: String, interaction_request_id: String },
    AwaitingApproval { step: String, approval_state: Option<String> },
    Succeeded,
    Failed { step: String, reason: String },
    Waiting,
}
```

Then update `PipelineRun::step_completed()`:

```rust
pub fn step_completed(
    &mut self,
    step_name: &str,
    verdict: Verdict,
    approval_requested: bool,
) -> PipelineAction {
    match verdict {
        Verdict::Approve => {
            let step = self
                .dag
                .steps
                .iter()
                .find(|candidate| candidate.name == step_name)
                .expect("step should exist");
            if let Some(approval) = &step.approval {
                let should_gate = match approval.mode {
                    StepApprovalMode::Always => true,
                    StepApprovalMode::WhenRequestedByAgent => approval_requested,
                };
                if should_gate {
                    self.step_states.insert(
                        step_name.to_string(),
                        StepState::AwaitingApproval {
                            interaction_request_id: String::new(),
                        },
                    );
                    return PipelineAction::AwaitingApproval {
                        step: step_name.to_string(),
                        approval_state: approval.state.clone(),
                    };
                }
            }

            self.step_states.insert(step_name.to_string(), StepState::Passed);
            if self.all_passed() {
                PipelineAction::Succeeded
            } else {
                self.find_dispatchable()
            }
        }
        Verdict::Reject { summary } => { /* existing failure path */ }
    }
}
```

Add:

```rust
pub fn bind_approval_interaction(&mut self, step_name: &str, interaction_request_id: String) {
    self.step_states.insert(
        step_name.to_string(),
        StepState::AwaitingApproval { interaction_request_id },
    );
}

pub fn approve_gate(&mut self, step_name: &str) -> PipelineAction {
    self.step_states.insert(step_name.to_string(), StepState::Passed);
    if self.all_passed() {
        PipelineAction::Succeeded
    } else {
        self.find_dispatchable()
    }
}

pub fn reject_gate(&mut self, step_name: &str, reason: String) -> PipelineAction {
    self.step_states.insert(
        step_name.to_string(),
        StepState::Rejected {
            summary: reason.clone(),
        },
    );
    PipelineAction::Failed {
        step: step_name.to_string(),
        reason,
    }
}
```

- [ ] **Step 4: Add one regression test proving the gate does not rerun the completed step**

Add:

```rust
#[test]
fn approve_gate_marks_completed_step_passed_without_rerunning_it() {
    let steps = vec![
        StepConfig {
            name: "plan".to_string(),
            agent: "planner".to_string(),
            depends: Some(vec![]),
            tracker_state: Some("Planning".to_string()),
            approval: Some(StepApprovalConfig {
                mode: StepApprovalMode::Always,
                state: Some("Plan Review".to_string()),
            }),
        },
        StepConfig {
            name: "implement".to_string(),
            agent: "builder".to_string(),
            depends: Some(vec!["plan".to_string()]),
            tracker_state: Some("In Progress".to_string()),
            approval: None,
        },
    ];
    let mut run = make_run(&steps);
    run.mark_running("plan", "session-1".to_string());
    let _ = run.step_completed("plan", Verdict::Approve, true);
    let action = run.approve_gate("plan");

    assert_eq!(run.step_states["plan"], StepState::Passed);
    assert!(matches!(&action, PipelineAction::Dispatch(reqs) if reqs[0].step_name == "implement"));
}
```

- [ ] **Step 5: Run the pipeline tests and then commit**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::engine::tests -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add crates/ensemble-core/src/pipeline/engine.rs
git commit -m "Add pipeline step approval checkpoints"
```

### Task 4: Integrate orchestrator resume semantics with approval checkpoints

**Files:**
- Modify: `crates/ensemble-core/src/interaction/model.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` (`#[cfg(test)]`)
- Test: `crates/ensemble-core/src/api/controls.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing orchestrator tests for approval-gate creation and resume**

Add tests in `crates/ensemble-core/src/orchestrator/mod.rs`:

```rust
#[tokio::test]
async fn worker_success_with_approval_request_creates_approval_gate_interaction() {
    let config = Arc::new(RwLock::new(parse_config(r#"
tracker:
  kind: todo_file
  active_states: [Todo, Ready]
  terminal_states: [Done]
agents:
  planner:
    acpx_agent: codex
    prompt: Plan {{ issue.identifier }}
  builder:
    acpx_agent: codex
    prompt: Implement {{ issue.identifier }}
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
  - name: implement
    agent: builder
    depends: [plan]
    tracker_state: In Progress
on_success: Done
on_failure: Failed
"#).unwrap()));
    let issues = Arc::new(RwLock::new(vec![]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
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

    {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
        pipeline_run.mark_running("plan", "session-1".to_string());

        let mut state = orchestrator.state.write().await;
        state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        state.add_running(&test_issue("1", "Todo"), Some(1));
    }

    orchestrator
        .handle_worker_event(WorkerEvent::WorkerExited {
            issue_id: "1".to_string(),
            step_name: "plan".to_string(),
            result: WorkerResult::Success {
                runtime_verdict: None,
                approval_request: Some(StepApprovalRequestDraft {
                    schema_version: 1,
                    title: "Review plan".to_string(),
                    body: "Please review SPEC and PLAN.".to_string(),
                    state: Some("Plan Review".to_string()),
                }),
            },
            timestamp: Utc::now(),
        })
        .await;

    let state = orchestrator.state.read().await;
    assert!(state.is_waiting_on_human("1"));
    assert!(matches!(
        state.get_pipeline_run("1").unwrap().step_states["plan"],
        StepState::AwaitingApproval { .. }
    ));
}

#[tokio::test]
async fn resolved_approval_gate_resumes_into_next_step_without_rerunning_current_step() {
    let config = Arc::new(RwLock::new(parse_config(r#"
tracker:
  kind: todo_file
  active_states: [Todo, Ready]
  terminal_states: [Done]
agents:
  planner:
    acpx_agent: codex
    prompt: Plan {{ issue.identifier }}
  builder:
    acpx_agent: codex
    prompt: Implement {{ issue.identifier }}
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: always
      state: Plan Review
  - name: implement
    agent: builder
    depends: [plan]
    tracker_state: In Progress
on_success: Done
on_failure: Failed
"#).unwrap()));
    let issues = Arc::new(RwLock::new(vec![]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
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

    {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
        pipeline_run.bind_approval_interaction("plan", "interaction-1".to_string());

        let mut state = orchestrator.state.write().await;
        state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "plan".to_string(),
            kind: InteractionKind::ApprovalGate,
            prompt: "Approve plan".to_string(),
            agent_name: "planner".to_string(),
            retry_attempt: None,
            requested_at: Utc::now(),
        });
    }

    InteractionStore::new(dir.path().to_path_buf())
        .create(crate::interaction::InteractionRequest {
            id: "interaction-1".to_string(),
            schema_version: 1,
            issue_id: "1".to_string(),
            issue_identifier: "repo#1".to_string(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: "plan".to_string(),
            agent_name: "planner".to_string(),
            step_depends: vec![],
            step_tracker_state: Some("Planning".to_string()),
            kind: InteractionKind::ApprovalGate,
            status: InteractionStatus::Resolved,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::AdvanceAfterStep,
            title: "Approve plan".to_string(),
            body: "Approve plan".to_string(),
            options: vec!["approve".to_string(), "reject".to_string()],
            artifacts: vec![],
            response: Some(InteractionResponse::Approval {
                response_schema_version: 1,
                approved: true,
                reason: Some("Looks good".to_string()),
            }),
            requested_at: Utc::now(),
            resolved_at: Some(Utc::now()),
        })
        .await
        .unwrap();

    orchestrator
        .resume_blocked_issue(&test_issue("1", "Ready"))
        .await
        .expect("resume should succeed");

    let state = orchestrator.state.read().await;
    let run = state.get_pipeline_run("1").unwrap();
    assert_eq!(run.step_states["plan"], StepState::Passed);
    assert!(matches!(
        run.step_states["implement"],
        StepState::Running { .. }
    ));
}

#[tokio::test]
async fn rejected_approval_gate_marks_issue_failed() {
    let config = Arc::new(RwLock::new(parse_config(r#"
tracker:
  kind: todo_file
  active_states: [Todo, Ready]
  terminal_states: [Done]
agents:
  planner:
    acpx_agent: codex
    prompt: Plan {{ issue.identifier }}
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: always
      state: Plan Review
on_success: Done
on_failure: Failed
"#).unwrap()));
    let issues = Arc::new(RwLock::new(vec![]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
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

    {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
        pipeline_run.bind_approval_interaction("plan", "interaction-1".to_string());

        let mut state = orchestrator.state.write().await;
        state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "plan".to_string(),
            kind: InteractionKind::ApprovalGate,
            prompt: "Approve plan".to_string(),
            agent_name: "planner".to_string(),
            retry_attempt: None,
            requested_at: Utc::now(),
        });
    }

    InteractionStore::new(dir.path().to_path_buf())
        .create(crate::interaction::InteractionRequest {
            id: "interaction-1".to_string(),
            schema_version: 1,
            issue_id: "1".to_string(),
            issue_identifier: "repo#1".to_string(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: "plan".to_string(),
            agent_name: "planner".to_string(),
            step_depends: vec![],
            step_tracker_state: Some("Planning".to_string()),
            kind: InteractionKind::ApprovalGate,
            status: InteractionStatus::Resolved,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::AdvanceAfterStep,
            title: "Approve plan".to_string(),
            body: "Approve plan".to_string(),
            options: vec!["approve".to_string(), "reject".to_string()],
            artifacts: vec![],
            response: Some(InteractionResponse::Approval {
                response_schema_version: 1,
                approved: false,
                reason: Some("Need more detail".to_string()),
            }),
            requested_at: Utc::now(),
            resolved_at: Some(Utc::now()),
        })
        .await
        .unwrap();

    orchestrator
        .resume_blocked_issue(&test_issue("1", "Ready"))
        .await
        .expect("resume should complete rejection path");

    let state = orchestrator.state.read().await;
    assert!(!state.is_waiting_on_human("1"));
    assert!(state.get_pipeline_run("1").is_none());
}
```

- [ ] **Step 2: Run the focused orchestrator tests and confirm they fail**

Run:

```bash
rtk cargo test -p ensemble-core worker_success_with_approval_request_creates_approval_gate_interaction -- --exact
rtk cargo test -p ensemble-core resolved_approval_gate_resumes_into_next_step_without_rerunning_current_step -- --exact
rtk cargo test -p ensemble-core rejected_approval_gate_marks_issue_failed -- --exact
```

Expected: compile or assertion failure because the orchestrator still treats all resolved interactions as rerun-the-same-step interactions.

- [ ] **Step 3: Add a resume strategy to persisted interactions**

Update `crates/ensemble-core/src/interaction/model.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionResumeStrategy {
    RerunStep,
    AdvanceAfterStep,
}

fn default_resume_strategy() -> InteractionResumeStrategy {
    InteractionResumeStrategy::RerunStep
}

pub struct InteractionRequest {
    pub id: String,
    pub schema_version: u32,
    pub issue_id: String,
    pub issue_identifier: String,
    pub pipeline_cycle: u32,
    pub completed_steps: Vec<String>,
    pub step_name: String,
    pub agent_name: String,
    pub step_depends: Vec<String>,
    pub step_tracker_state: Option<String>,
    pub kind: InteractionKind,
    pub status: InteractionStatus,
    pub blocking: bool,
    pub awaiting_resume: bool,
    #[serde(default = "default_resume_strategy")]
    pub resume_strategy: InteractionResumeStrategy,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub artifacts: Vec<String>,
    pub response: Option<InteractionResponse>,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}
```

This preserves backward compatibility for existing interaction JSON by defaulting to `rerun_step`.

- [ ] **Step 4: Create post-step approval interactions on worker success**

In `crates/ensemble-core/src/orchestrator/mod.rs`, update the `WorkerResult::Success` branch so it passes the worker's `approval_request.is_some()` flag into `PipelineRun::step_completed()` and handles the new `PipelineAction::AwaitingApproval` branch:

```rust
WorkerResult::Success {
    runtime_verdict,
    approval_request,
} => {
    let workspace_path = self.workspace_mgr.workspace_path(
        issue_snapshot
            .as_ref()
            .map(|issue| issue.identifier.as_str())
            .unwrap_or(issue_id),
    );
    let resolved = match workspace_path {
        Some(workspace_path) => {
            resolve_verdict_with_source(runtime_verdict.as_ref(), &workspace_path).await
        }
        None => crate::pipeline::verdict::ResolvedVerdict {
            verdict: Verdict::Approve,
            source: VerdictSource::Default,
        },
    };
    let action = run.step_completed(step_name, resolved.verdict, approval_request.is_some());
    match action {
        PipelineAction::AwaitingApproval { step, approval_state } => {
            let draft = approval_request.unwrap_or_else(|| StepApprovalRequestDraft {
                schema_version: 1,
                title: format!("Approve step '{step}'"),
                body: format!("Approve pipeline continuation after step '{step}'."),
                state: approval_state.clone(),
            });
            self.create_post_step_approval_checkpoint(issue_id, &step, draft, approval_state).await?;
        }
        other => {
            // Reuse the current Dispatch / Succeeded / Failed / Waiting handling unchanged.
            pipeline_action = Some((other, state.get_pipeline_config(issue_id).cloned()));
        }
    }
}
```

Implement `create_post_step_approval_checkpoint()` to:

- write the optional mirror state from the draft or config
- persist `InteractionKind::ApprovalGate`
- set `resume_strategy: InteractionResumeStrategy::AdvanceAfterStep`
- bind the interaction id onto `StepState::AwaitingApproval`
- add/update `waiting_on_human`

Add two private helpers so the success and resume paths stay readable:

```rust
async fn create_post_step_approval_checkpoint(
    &self,
    issue: &Issue,
    step_name: &str,
    agent_name: &str,
    draft: StepApprovalRequestDraft,
    approval_state: Option<String>,
) -> Result<(), EnsembleError>

async fn handle_pipeline_action_after_resume(
    &self,
    issue: &Issue,
    action: PipelineAction,
    config_snapshot: Arc<EnsembleConfig>,
) -> Result<(), EnsembleError>

async fn fail_issue_from_rejected_gate(
    &self,
    issue: &Issue,
    step_name: &str,
    reason: String,
    config_snapshot: Arc<EnsembleConfig>,
) -> Result<(), EnsembleError>
```

- [ ] **Step 5: Branch resume handling on approval outcome and resume strategy**

Still in `crates/ensemble-core/src/orchestrator/mod.rs`, update `resume_blocked_issue()` so:

```rust
match (&interaction.kind, &interaction.resume_strategy, &interaction.response) {
    (
        InteractionKind::ApprovalGate,
        InteractionResumeStrategy::AdvanceAfterStep,
        Some(InteractionResponse::Approval { approved: true, .. }),
    ) => {
        let action = {
            let mut state = self.state.write().await;
            let run = state.get_pipeline_run_mut(&issue.id).expect("pipeline run");
            run.approve_gate(&interaction.step_name)
        };
        self.interaction_store.mark_resumed(&interaction.id).await?;
        self.state.write().await.remove_waiting_on_human(&issue.id);
        self.handle_pipeline_action_after_resume(issue, action, Arc::clone(&current_config)).await?;
        return Ok(());
    }
    (
        InteractionKind::ApprovalGate,
        InteractionResumeStrategy::AdvanceAfterStep,
        Some(InteractionResponse::Approval { approved: false, reason, .. }),
    ) => {
        let failure_reason = reason.clone().unwrap_or_else(|| "approval rejected".to_string());
        self.fail_issue_from_rejected_gate(issue, &interaction.step_name, failure_reason, Arc::clone(&current_config)).await?;
        self.interaction_store.mark_resumed(&interaction.id).await?;
        self.state.write().await.remove_waiting_on_human(&issue.id);
        return Ok(());
    }
    _ => {
        // existing rerun-step path
    }
}
```

Use `config.on_failure` for the initial rejection state rather than inventing a second rejection-state surface in the same change.

- [ ] **Step 6: Add an API regression test proving `/api/v1/issues/{identifier}/input` accepts approval outcomes for post-step gates**

Add a focused test in `crates/ensemble-core/src/api/controls.rs` that resolves an `InteractionKind::ApprovalGate` with `resume_strategy: AdvanceAfterStep` using outcome `"approve"` and confirms the response is still:

```rust
assert_eq!(status, StatusCode::OK);
assert!(body["submitted"].as_bool().unwrap());
```

This guards against unintentionally breaking the existing approval input endpoint while adding the new pipeline behavior behind it.

- [ ] **Step 7: Run the focused integration tests and then commit**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator:: -- --nocapture
rtk cargo test -p ensemble-core api::controls:: -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add crates/ensemble-core/src/interaction/model.rs crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/orchestrator/state.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/observability/snapshot.rs
git commit -m "Resume pipelines from post-step approval gates"
```

### Task 5: Update config editing, docs, and end-to-end examples

**Files:**
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `docs/configuration.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/sdd-workflow.md`
- Test: `crates/ensemble-core/src/api/config_edit_handler.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write a failing config-edit handler test for step approval serialization**

Add a test in `crates/ensemble-core/src/api/config_edit_handler.rs` that expects:

```rust
assert_eq!(
    body["steps"][0]["approval"],
    serde_json::json!({
        "mode": "when_requested_by_agent",
        "state": "Plan Review"
    })
);
```

using an `EnsembleConfig` with:

```rust
StepConfig {
    name: "plan".to_string(),
    agent: "planner".to_string(),
    depends: Some(vec![]),
    tracker_state: Some("Planning".to_string()),
    approval: Some(StepApprovalConfig {
        mode: StepApprovalMode::WhenRequestedByAgent,
        state: Some("Plan Review".to_string()),
    }),
}
```

- [ ] **Step 2: Run the config-edit test and confirm it fails**

Run:

```bash
rtk cargo test -p ensemble-core config_edit_handler -- --nocapture
```

Expected: assertion failure because the handler currently drops the `approval` field from step JSON.

- [ ] **Step 3: Add approval serialization to config-edit responses**

Update the step JSON builder in `crates/ensemble-core/src/api/config_edit_handler.rs`:

```rust
serde_json::json!({
    "name": step.name,
    "agent": step.agent,
    "depends": step.depends,
    "tracker_state": step.tracker_state,
    "approval": step.approval.as_ref().map(|approval| serde_json::json!({
        "mode": approval.mode,
        "state": approval.state,
    })),
})
```

- [ ] **Step 4: Update user-facing docs and examples**

Update `docs/configuration.md` with:

```yaml
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
```

and a table row:

```markdown
| `approval.mode` | string | — | Optional post-step approval policy: `always` or `when_requested_by_agent` |
| `approval.state` | string | — | Optional tracker state to mirror while waiting for approval |
```

Update `docs/SPEC.md` so the step schema and reconciliation sections explicitly describe:

- post-step approval checkpoints
- `AdvanceAfterStep` resume semantics
- rejection falling back to `on_failure`

Update `docs/sdd-workflow.md` so the recommended Superpowers flow says:

- `plan -> implement -> review`
- planning may request a manual approval gate
- lightweight tasks may skip the gate

- [ ] **Step 5: Run docs-adjacent verification and then commit**

Run:

```bash
rtk cargo test -p ensemble-core config_edit_handler -- --nocapture
rtk cargo test -p ensemble-core config::ensemble::tests -- --nocapture
rtk cargo test -p ensemble-core pipeline::engine::tests -- --nocapture
rtk cargo test -p ensemble-core orchestrator:: -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add crates/ensemble-core/src/api/config_edit_handler.rs docs/configuration.md docs/SPEC.md docs/sdd-workflow.md
git commit -m "Document step approval gates"
```

### Task 6: Run full verification and prepare the local config follow-up

**Files:**
- Modify: `docs/superpowers/specs/2026-04-10-superpowers-config-approval-gates-design.md` (only if the final implementation diverges)
- Create later outside repo: `/Users/chris/Library/Application Support/ensemble/config.yaml`
- Create later outside repo: `/Users/chris/Library/Application Support/ensemble/templates/plan.liquid`
- Update later outside repo: `/Users/chris/Library/Application Support/ensemble/templates/implement.liquid`
- Update later outside repo: `/Users/chris/Library/Application Support/ensemble/templates/review.liquid`

- [ ] **Step 1: Run the full Rust verification suite**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: all PASS with no warnings.

- [ ] **Step 2: Smoke-test the new config shape through the config API fixtures**

Use a representative config snippet:

```yaml
tracker:
  kind: todo_file
  path: /Users/chris/ensemble/TODO.md
  active_states: [Todo, Ready]
  terminal_states: [Done, Failed]
agents:
  planner:
    acpx_agent: codex
    model: gpt-5.4/high
    prompt_template: templates/plan.liquid
  builder:
    acpx_agent: codex
    model: gpt-5.4/medium
    prompt_template: templates/implement.liquid
  reviewer:
    acpx_agent: opencode
    model: github-copilot/gpt-5.4/xhigh
    prompt_template: templates/review.liquid
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
  - name: implement
    agent: builder
    depends: [plan]
    tracker_state: In Progress
  - name: review
    agent: reviewer
    depends: [implement]
    tracker_state: Review
on_success: Done
on_failure: Failed
```

Confirm:

- it parses
- config edit endpoints preserve `approval`
- the orchestrator accepts `Todo` and `Ready` as the active entry states

- [ ] **Step 3: If the implementation matched the spec, leave the spec untouched; otherwise record the delta**

If the final code changes any user-visible behavior from the approved spec, update:

```markdown
docs/superpowers/specs/2026-04-10-superpowers-config-approval-gates-design.md
```

with the exact behavior change before merging.

- [ ] **Step 4: Document the local config rollout in the final PR description or handoff note**

Record this exact follow-up for the operator:

```markdown
After merge, update `/Users/chris/Library/Application Support/ensemble/config.yaml` to add:
- `planner` agent
- `plan -> implement -> review` steps
- `Todo`, `Planning`, `Plan Review`, `Ready`, `In Progress`, `Review`, `Done`, `Failed` tracker states

Add `/Users/chris/Library/Application Support/ensemble/templates/plan.liquid` and update the existing
`implement.liquid` / `review.liquid` prompts to align with the Superpowers process.
```

- [ ] **Step 5: Create the final integration commit**

```bash
git add -A
git commit -m "Implement generic step approval gates"
```

## Self-Review Notes

- **Spec coverage:** The tasks cover config surface, worker signaling, pipeline state machine, orchestrator persistence/resume, API/config serialization, docs, and the final local config rollout.
- **Placeholder scan:** There are no `TODO`/`TBD` placeholders; each task lists concrete files, commands, and target structs/methods.
- **Type consistency:** The plan consistently uses `StepApprovalConfig`, `StepApprovalMode`, `StepApprovalRequestDraft`, `InteractionResumeStrategy`, `PipelineAction::AwaitingApproval`, `PipelineRun::approve_gate()`, and `PipelineRun::reject_gate()`.
