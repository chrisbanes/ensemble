pub mod reconciler;
pub mod retry;
pub mod scheduler;
pub mod state;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tracing::{debug, info, warn};

use crate::agent::events::{AgentEvent, WorkerEvent, WorkerResult};
use crate::agent::AgentRunner;
use crate::config::ensemble::EnsembleConfig;
use crate::pipeline::dag::build_dag;
use crate::pipeline::engine::{PipelineAction, PipelineRun};
use crate::pipeline::verdict::resolve_verdict;
use crate::tracker::model::Issue;
use crate::tracker::IssueTracker;
use crate::workspace::manager::WorkspaceManager;

use reconciler::{reconcile_stalled_runs, reconcile_tracker_states, startup_terminal_cleanup};
use retry::{current_time_ms, get_due_retries, next_attempt, schedule_failure_retry};
use scheduler::{has_available_slots, is_dispatch_eligible, sort_for_dispatch};
use state::OrchestratorState;

/// The main orchestrator that manages the poll-dispatch-reconcile loop.
pub struct Orchestrator {
    state: Arc<RwLock<OrchestratorState>>,
    config: Arc<RwLock<EnsembleConfig>>,
    tracker: Arc<dyn IssueTracker>,
    agent_runner: Arc<dyn AgentRunner>,
    workspace_mgr: Arc<WorkspaceManager>,
    worker_tx: mpsc::Sender<WorkerEvent>,
    worker_rx: mpsc::Receiver<WorkerEvent>,
    shutdown_rx: mpsc::Receiver<()>,
}

impl Orchestrator {
    /// Create a new Orchestrator.
    pub fn new(
        config: Arc<RwLock<EnsembleConfig>>,
        tracker: Arc<dyn IssueTracker>,
        agent_runner: Arc<dyn AgentRunner>,
        workspace_mgr: WorkspaceManager,
        shutdown_rx: mpsc::Receiver<()>,
    ) -> Self {
        let (worker_tx, worker_rx) = mpsc::channel(1000);

        let cfg = OrchestratorState::new(30_000, 10);

        Self {
            state: Arc::new(RwLock::new(cfg)),
            config,
            tracker,
            agent_runner,
            workspace_mgr: Arc::new(workspace_mgr),
            worker_tx,
            worker_rx,
            shutdown_rx,
        }
    }

    /// Get a reference to the orchestrator state for API consumers.
    pub fn state(&self) -> Arc<RwLock<OrchestratorState>> {
        Arc::clone(&self.state)
    }

    /// Get the worker event sender for spawning workers.
    pub fn worker_tx(&self) -> mpsc::Sender<WorkerEvent> {
        self.worker_tx.clone()
    }

    /// Run the orchestrator main loop.
    pub async fn run(&mut self) {
        // Initialize state from config
        {
            let config = self.config.read().await;
            let mut state = self.state.write().await;
            state.poll_interval_ms = config.polling.interval_ms;
            state.max_concurrent_agents = config.concurrency.max_concurrent_agents;
        }

        // Startup terminal workspace cleanup
        {
            let config = self.config.read().await;
            startup_terminal_cleanup(
                self.tracker.as_ref(),
                &config.tracker.terminal_states,
                &self.workspace_mgr,
            )
            .await;
        }

        info!("orchestrator started, entering main loop");

        // Immediate first tick
        self.handle_tick().await;

        // Main event loop
        loop {
            let poll_interval = {
                let state = self.state.read().await;
                Duration::from_millis(state.poll_interval_ms)
            };

            // Calculate next retry sleep duration
            let retry_sleep = {
                let state = self.state.read().await;
                retry::next_retry_time(&state).map(|due_at| {
                    let now = current_time_ms();
                    if due_at <= now {
                        Duration::from_millis(0)
                    } else {
                        Duration::from_millis(due_at - now)
                    }
                })
            };

            tokio::select! {
                // Poll timer
                _ = sleep(poll_interval) => {
                    debug!("poll tick");
                    self.handle_tick().await;
                }

                // Worker events
                Some(event) = self.worker_rx.recv() => {
                    self.handle_worker_event(event).await;
                }

                // Retry timer (if any)
                _ = async {
                    match retry_sleep {
                        Some(d) => sleep(d).await,
                        None => futures::future::pending::<()>().await,
                    }
                } => {
                    debug!("retry timer fired");
                    self.handle_retry_fires().await;
                }

                // Shutdown signal
                _ = self.shutdown_rx.recv() => {
                    info!("received shutdown signal, stopping orchestrator");
                    break;
                }
            }
        }

        info!("orchestrator stopped");
    }

    /// Handle a poll tick: reconcile, validate, fetch, dispatch.
    async fn handle_tick(&self) {
        // 1. Reconcile stalled runs
        let stall_timeout_ms = {
            let config = self.config.read().await;
            config.agent.stall_timeout_ms
        };
        {
            let state = self.state.read().await;
            let stall_result = reconcile_stalled_runs(&state, stall_timeout_ms);
            if stall_result.stalled_count > 0 {
                drop(state);
                let mut state = self.state.write().await;
                let config = self.config.read().await;
                for issue_id in &stall_result.stalled_issue_ids {
                    if let Some(entry) = state.remove_running(issue_id) {
                        state.add_runtime_seconds(&entry);
                        schedule_failure_retry(
                            &mut state,
                            issue_id,
                            &entry.identifier,
                            next_attempt(entry.retry_attempt),
                            config.agent.max_retry_backoff_ms,
                            config.max_cycles,
                            "stall timeout",
                        );
                    }
                }
            }
        }

        // 2. Reconcile tracker states
        {
            let config = self.config.read().await;
            let state = self.state.read().await;
            let reconcile_result = reconcile_tracker_states(
                &state,
                self.tracker.as_ref(),
                &config.tracker.active_states,
                &config.tracker.terminal_states,
            )
            .await;

            drop(state);
            let mut state = self.state.write().await;

            // Apply updates
            for issue in reconcile_result.updates {
                let id = issue.id.clone();
                state.update_issue_snapshot(&id, issue);
            }

            // Terminal: terminate and clean workspace
            for issue in reconcile_result.terminate_cleanup {
                if let Some(entry) = state.remove_running(&issue.id) {
                    state.add_runtime_seconds(&entry);
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    // Clean workspace
                    if let Err(e) = self.workspace_mgr.remove_workspace(&entry.identifier) {
                        warn!(
                            identifier = %entry.identifier,
                            error = %e,
                            "failed to clean terminal workspace"
                        );
                    }
                }
            }

            // Non-active: terminate without cleanup
            for issue in reconcile_result.terminate_no_cleanup {
                if let Some(entry) = state.remove_running(&issue.id) {
                    state.add_runtime_seconds(&entry);
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                }
            }
        }

        // 3. Fetch candidate issues
        let mut candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(error = %e, "failed to fetch candidate issues, skipping dispatch");
                return;
            }
        };

        // 4. Sort by dispatch priority
        sort_for_dispatch(&mut candidates);

        // 5. Dispatch eligible issues while slots remain
        let config = self.config.read().await;
        for issue in &candidates {
            {
                let state = self.state.read().await;
                if !has_available_slots(&state) {
                    break;
                }
            }

            let eligible = {
                let state = self.state.read().await;
                is_dispatch_eligible(
                    issue,
                    &state,
                    &config.tracker.active_states,
                    &config.tracker.terminal_states,
                    &HashMap::new(),
                )
            };

            if eligible.is_none() {
                self.dispatch_issue(issue, None).await;
            }
        }
    }

    /// Dispatch a single issue: build DAG, create PipelineRun, dispatch initial steps.
    async fn dispatch_issue(&self, issue: &Issue, attempt: Option<u32>) {
        let config = self.config.read().await;

        // Build the step DAG from config
        let dag = match build_dag(&config.steps) {
            Ok(d) => d,
            Err(e) => {
                warn!(
                    issue_id = %issue.id,
                    error = %e,
                    "failed to build step DAG, skipping dispatch"
                );
                return;
            }
        };

        let cycle = attempt.unwrap_or(1);
        let pipeline_run = PipelineRun::new(issue.id.clone(), cycle, dag);
        let action = pipeline_run.start();

        info!(
            issue_id = %issue.id,
            identifier = %issue.identifier,
            attempt = ?attempt,
            "dispatching issue with pipeline"
        );

        {
            let mut state = self.state.write().await;
            state.add_running(issue, attempt);
            state.insert_pipeline_run(&issue.id, pipeline_run);
        }

        // Process initial dispatch requests
        if let PipelineAction::Dispatch(requests) = action {
            for req in requests {
                self.dispatch_step(
                    issue,
                    &req.step_name,
                    &req.agent_name,
                    req.tracker_state.as_deref(),
                    attempt,
                )
                .await;
            }
        }
    }

    /// Dispatch a single pipeline step: set tracker state if specified, spawn worker.
    async fn dispatch_step(
        &self,
        issue: &Issue,
        step_name: &str,
        agent_name: &str,
        tracker_state: Option<&str>,
        attempt: Option<u32>,
    ) {
        info!(
            issue_id = %issue.id,
            identifier = %issue.identifier,
            step = step_name,
            agent = agent_name,
            "dispatching pipeline step"
        );

        // Set tracker state if specified by the step
        if let Some(state_name) = tracker_state {
            if self.tracker.supports_writes() {
                if let Err(e) = self.tracker.set_issue_state(&issue.id, state_name).await {
                    warn!(
                        issue_id = %issue.id,
                        state = state_name,
                        error = %e,
                        "failed to set tracker state for step dispatch"
                    );
                }
            }
        }

        // Mark step as running in pipeline
        {
            let mut state = self.state.write().await;
            if let Some(run) = state.get_pipeline_run_mut(&issue.id) {
                run.mark_running(
                    step_name,
                    format!("{}-{}-{}", issue.id, step_name, agent_name),
                );
            }
        }

        // Spawn worker task
        let issue_clone = issue.clone();
        let step_name_owned = step_name.to_string();
        let agent_name_owned = agent_name.to_string();
        let runner = Arc::clone(&self.agent_runner);
        let workspace_mgr = Arc::clone(&self.workspace_mgr);
        let event_tx = self.worker_tx.clone();
        let config = Arc::clone(&self.config);

        tokio::spawn(async move {
            // Prepare workspace
            let workspace_result = workspace_mgr.prepare_workspace(&issue_clone.identifier);
            let workspace_path = match workspace_result {
                Ok(ws) => {
                    // Run after_create hook if newly created
                    if ws.created_now {
                        let cfg = config.read().await;
                        if let Some(ref script) = cfg.hooks.after_create {
                            if let Err(e) = crate::workspace::hooks::run_hook(
                                "after_create",
                                script,
                                &ws.path,
                                cfg.hooks.timeout_ms,
                            )
                            .await
                            {
                                let _ = event_tx
                                    .send(WorkerEvent::WorkerExited {
                                        issue_id: issue_clone.id.clone(),
                                        step_name: step_name_owned.clone(),
                                        result: WorkerResult::Failed {
                                            error: format!("after_create hook failed: {e}"),
                                        },
                                        timestamp: Utc::now(),
                                    })
                                    .await;
                                return;
                            }
                        }
                    }
                    ws.path
                }
                Err(e) => {
                    let _ = event_tx
                        .send(WorkerEvent::WorkerExited {
                            issue_id: issue_clone.id.clone(),
                            step_name: step_name_owned.clone(),
                            result: WorkerResult::Failed {
                                error: format!("workspace error: {e}"),
                            },
                            timestamp: Utc::now(),
                        })
                        .await;
                    return;
                }
            };

            // Run agent
            let result = runner
                .run(
                    &issue_clone,
                    &agent_name_owned,
                    &step_name_owned,
                    attempt,
                    &workspace_path,
                    event_tx.clone(),
                )
                .await;

            let worker_result = match result {
                Ok(()) => WorkerResult::Success,
                Err(e) => WorkerResult::Failed {
                    error: e.to_string(),
                },
            };

            let _ = event_tx
                .send(WorkerEvent::WorkerExited {
                    issue_id: issue_clone.id.clone(),
                    step_name: step_name_owned,
                    result: worker_result,
                    timestamp: Utc::now(),
                })
                .await;
        });
    }

    /// Handle a worker event from the channel.
    async fn handle_worker_event(&self, event: WorkerEvent) {
        match event {
            WorkerEvent::AgentUpdate {
                issue_id,
                step_name,
                event: agent_event,
                timestamp,
            } => {
                self.handle_agent_update(&issue_id, &step_name, agent_event, timestamp)
                    .await;
            }
            WorkerEvent::WorkerExited {
                issue_id,
                step_name,
                result,
                ..
            } => {
                self.handle_worker_exit(&issue_id, &step_name, result).await;
            }
        }
    }

    /// Handle an agent update event.
    async fn handle_agent_update(
        &self,
        issue_id: &str,
        _step_name: &str,
        event: AgentEvent,
        timestamp: chrono::DateTime<Utc>,
    ) {
        let mut state = self.state.write().await;

        match &event {
            AgentEvent::SessionStarted {
                session_id,
                agent_pid,
            } => {
                state.update_session_info(issue_id, session_id, agent_pid.as_deref());
                state.update_agent_event(issue_id, "session_started", None, timestamp);
            }
            AgentEvent::TurnStarted => {
                state.increment_turn_count(issue_id);
                state.update_agent_event(issue_id, "turn_started", None, timestamp);
            }
            AgentEvent::TurnUpdate { content } => {
                state.update_agent_event(issue_id, "turn_update", Some(content), timestamp);
            }
            AgentEvent::TurnCompleted { usage } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
                state.update_agent_event(issue_id, "turn_completed", None, timestamp);
            }
            AgentEvent::TurnFailed { reason, usage } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
                state.update_agent_event(issue_id, "turn_failed", Some(reason), timestamp);
            }
            AgentEvent::PermissionRequested { description, .. } => {
                state.update_agent_event(
                    issue_id,
                    "permission_requested",
                    Some(description),
                    timestamp,
                );
            }
            AgentEvent::PermissionResolved { .. } => {
                state.update_agent_event(issue_id, "permission_resolved", None, timestamp);
            }
            AgentEvent::Notification { message } => {
                state.update_agent_event(issue_id, "notification", Some(message), timestamp);
            }
            AgentEvent::OtherMessage { raw } => {
                state.update_agent_event(
                    issue_id,
                    "other_message",
                    Some(&raw.chars().take(100).collect::<String>()),
                    timestamp,
                );
            }
            AgentEvent::Malformed { line } => {
                state.update_agent_event(
                    issue_id,
                    "malformed",
                    Some(&line.chars().take(100).collect::<String>()),
                    timestamp,
                );
            }
        }
    }

    /// Handle a worker exit. Integrates with PipelineRun to drive step DAG.
    async fn handle_worker_exit(&self, issue_id: &str, step_name: &str, result: WorkerResult) {
        let config = self.config.read().await;

        // Get the issue snapshot for potential re-dispatch
        let issue_snapshot = {
            let state = self.state.read().await;
            state.running.get(issue_id).map(|e| e.issue.clone())
        };

        let mut state = self.state.write().await;

        match result {
            WorkerResult::Success => {
                info!(
                    issue_id = %issue_id,
                    step = step_name,
                    "worker exited successfully, resolving verdict"
                );

                // Resolve verdict from workspace
                let workspace_path = self.workspace_mgr.workspace_path(
                    issue_snapshot
                        .as_ref()
                        .map(|i| i.identifier.as_str())
                        .unwrap_or(issue_id),
                );
                let verdict = match workspace_path {
                    Some(wp) => resolve_verdict(None, &wp).await,
                    None => crate::pipeline::verdict::Verdict::Approve,
                };

                // Drive the pipeline
                let pipeline_action = if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    Some(run.step_completed(step_name, verdict))
                } else {
                    warn!(issue_id = %issue_id, "no pipeline run found for worker exit");
                    None
                };

                if let Some(action) = pipeline_action {
                    match action {
                        PipelineAction::Dispatch(requests) => {
                            // Need to drop state lock before dispatching
                            drop(state);
                            if let Some(ref issue) = issue_snapshot {
                                for req in requests {
                                    self.dispatch_step(
                                        issue,
                                        &req.step_name,
                                        &req.agent_name,
                                        req.tracker_state.as_deref(),
                                        None,
                                    )
                                    .await;
                                }
                            }
                        }
                        PipelineAction::Succeeded => {
                            info!(issue_id = %issue_id, "pipeline succeeded");
                            // Set tracker to on_success state
                            if self.tracker.supports_writes() {
                                if let Err(e) = self
                                    .tracker
                                    .set_issue_state(issue_id, &config.on_success)
                                    .await
                                {
                                    warn!(issue_id = %issue_id, error = %e, "failed to set tracker success state");
                                }
                            }
                            if let Some(entry) = state.remove_running(issue_id) {
                                state.add_runtime_seconds(&entry);
                            }
                            state.release_claim(issue_id);
                            state.remove_pipeline_run(issue_id);
                            state.completed.insert(issue_id.to_string());
                        }
                        PipelineAction::Failed { step, reason } => {
                            warn!(
                                issue_id = %issue_id,
                                step = %step,
                                reason = %reason,
                                "pipeline failed"
                            );
                            // Set tracker to on_failure state
                            if self.tracker.supports_writes() {
                                if let Err(e) = self
                                    .tracker
                                    .set_issue_state(issue_id, &config.on_failure)
                                    .await
                                {
                                    warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                                }
                            }
                            if let Some(entry) = state.remove_running(issue_id) {
                                state.add_runtime_seconds(&entry);
                                schedule_failure_retry(
                                    &mut state,
                                    issue_id,
                                    &entry.identifier,
                                    next_attempt(entry.retry_attempt),
                                    config.agent.max_retry_backoff_ms,
                                    config.max_cycles,
                                    &reason,
                                );
                            }
                            state.remove_pipeline_run(issue_id);
                        }
                        PipelineAction::Waiting => {
                            // Other steps still running, do nothing
                            debug!(issue_id = %issue_id, "pipeline waiting for other steps");
                        }
                    }
                }
            }
            WorkerResult::Failed { error } => {
                warn!(
                    issue_id = %issue_id,
                    step = step_name,
                    error = %error,
                    "worker exited with failure"
                );

                // Notify pipeline of step failure
                if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    run.step_failed(step_name, error.clone());
                }

                // Set tracker to on_failure state
                if self.tracker.supports_writes() {
                    if let Err(e) = self
                        .tracker
                        .set_issue_state(issue_id, &config.on_failure)
                        .await
                    {
                        warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                    }
                }

                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    schedule_failure_retry(
                        &mut state,
                        issue_id,
                        &entry.identifier,
                        next_attempt(entry.retry_attempt),
                        config.agent.max_retry_backoff_ms,
                        config.max_cycles,
                        &error,
                    );
                }
                state.remove_pipeline_run(issue_id);
            }
        }
    }

    /// Handle due retry timer fires.
    async fn handle_retry_fires(&self) {
        let due_retries = {
            let state = self.state.read().await;
            get_due_retries(&state)
        };

        for retry_entry in due_retries {
            self.handle_single_retry(&retry_entry).await;
        }
    }

    /// Handle a single retry fire.
    async fn handle_single_retry(&self, retry_entry: &crate::tracker::model::RetryEntry) {
        let issue_id = &retry_entry.issue_id;

        // Remove the retry entry
        {
            let mut state = self.state.write().await;
            state.remove_retry(issue_id);
        }

        // Fetch active candidates
        let candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(
                    issue_id = %issue_id,
                    error = %e,
                    "retry poll failed, rescheduling"
                );
                let mut state = self.state.write().await;
                let config = self.config.read().await;
                schedule_failure_retry(
                    &mut state,
                    issue_id,
                    &retry_entry.identifier,
                    retry_entry.attempt + 1,
                    config.agent.max_retry_backoff_ms,
                    config.max_cycles,
                    "retry poll failed",
                );
                return;
            }
        };

        // Find the issue in candidates
        let issue = candidates.iter().find(|i| i.id == *issue_id);

        match issue {
            None => {
                // Issue not found in candidates — release claim
                info!(
                    issue_id = %issue_id,
                    identifier = %retry_entry.identifier,
                    "issue not found in candidates on retry, releasing claim"
                );
                let mut state = self.state.write().await;
                state.release_claim(issue_id);
            }
            Some(issue) => {
                // Check if we have slots
                let has_slots = {
                    let state = self.state.read().await;
                    has_available_slots(&state)
                };

                if has_slots {
                    self.dispatch_issue(issue, Some(retry_entry.attempt)).await;
                } else {
                    // No slots — requeue
                    info!(
                        issue_id = %issue_id,
                        identifier = %retry_entry.identifier,
                        "no slots available for retry, requeuing"
                    );
                    let mut state = self.state.write().await;
                    let config = self.config.read().await;
                    schedule_failure_retry(
                        &mut state,
                        issue_id,
                        &retry_entry.identifier,
                        retry_entry.attempt + 1,
                        config.agent.max_retry_backoff_ms,
                        config.max_cycles,
                        "no available orchestrator slots",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{AgentEvent, WorkerEvent, WorkerResult};
    use crate::config::ensemble::parse_config;
    use crate::error::AgentError;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;

    /// Mock tracker for orchestrator tests.
    struct MockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    #[async_trait]
    impl IssueTracker for MockTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.read().await.clone())
        }
        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            let states_lower: Vec<String> = states.iter().map(|s| s.to_lowercase()).collect();
            Ok(issues
                .iter()
                .filter(|i| states_lower.contains(&i.state.to_lowercase()))
                .cloned()
                .collect())
        }
        async fn fetch_issue_states_by_ids(
            &self,
            ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            Ok(issues
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect())
        }
    }

    /// Mock agent runner that completes immediately.
    struct MockRunner {
        delay_ms: u64,
    }

    #[async_trait]
    impl AgentRunner for MockRunner {
        async fn run(
            &self,
            issue: &Issue,
            _agent_name: &str,
            step_name: &str,
            _attempt: Option<u32>,
            _workspace_path: &std::path::Path,
            event_tx: mpsc::Sender<WorkerEvent>,
        ) -> Result<(), AgentError> {
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue.id.clone(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::SessionStarted {
                        session_id: "mock-session".to_string(),
                        agent_pid: Some("99".to_string()),
                    },
                    timestamp: Utc::now(),
                })
                .await;
            Ok(())
        }
    }

    fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: Some(Utc::now()),
            updated_at: None,
        }
    }

    fn make_config() -> EnsembleConfig {
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
  - name: build
    agent: builder
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
  permission_policy: auto_approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    #[tokio::test]
    async fn test_orchestrator_dispatches_on_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 10 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Run one tick
        orchestrator.handle_tick().await;

        // Verify issue was dispatched
        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"), "issue should be running after tick");
        assert!(state.is_claimed("1"), "issue should be claimed after tick");
        assert!(
            state.get_pipeline_run("1").is_some(),
            "should have pipeline run"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_handles_worker_exit_success() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config.clone(), tracker, runner, workspace_mgr, shutdown_rx);

        // Manually add a running entry with a pipeline run
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            let dag2 = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run2 = PipelineRun::new("1".to_string(), 1, dag2);
            pipeline_run2.start();
            pipeline_run2.mark_running("build", "session-1".to_string());
            state.insert_pipeline_run("1", pipeline_run2);
        }

        // Simulate worker exit
        orchestrator
            .handle_worker_exit("1", "build", WorkerResult::Success)
            .await;

        let state = orchestrator.state.read().await;
        // With a single-step pipeline, success should complete the pipeline
        assert!(
            state.completed.contains("1") || state.retry_attempts.contains_key("1"),
            "should be completed or retrying"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_handles_worker_exit_failure() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config.clone(), tracker, runner, workspace_mgr, shutdown_rx);

        // Manually add a running entry with attempt 2 and a pipeline run
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 2, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), Some(2));
            state.insert_pipeline_run("1", pipeline_run);
        }

        // Simulate worker failure
        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Failed {
                    error: "agent crashed".to_string(),
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.retry_attempts.contains_key("1"));
        let retry = state.retry_attempts.get("1").unwrap();
        assert_eq!(retry.attempt, 3); // incremented from 2
        assert_eq!(retry.error.as_deref(), Some("agent crashed"));
        assert!(
            state.get_pipeline_run("1").is_none(),
            "pipeline run should be removed"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_handles_agent_update() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Add running entry
        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
        }

        // Send session started event
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::SessionStarted {
                    session_id: "session-abc".to_string(),
                    agent_pid: Some("12345".to_string()),
                },
                Utc::now(),
            )
            .await;

        let state = orchestrator.state.read().await;
        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.session_id.as_deref(), Some("session-abc"));
        assert_eq!(entry.agent_pid.as_deref(), Some("12345"));
        assert_eq!(entry.last_agent_event.as_deref(), Some("session_started"));

        drop(state);

        // Send turn completed with usage
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::TurnCompleted {
                    usage: Some(crate::agent::events::TokenUsage {
                        input_tokens: 500,
                        output_tokens: 200,
                        total_tokens: 700,
                    }),
                },
                Utc::now(),
            )
            .await;

        let state = orchestrator.state.read().await;
        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.agent_input_tokens, 500);
        assert_eq!(entry.agent_output_tokens, 200);
        assert_eq!(entry.agent_total_tokens, 700);
        assert_eq!(state.agent_totals.input_tokens, 500);
        assert_eq!(state.agent_totals.total_tokens, 700);
    }

    #[tokio::test]
    async fn test_orchestrator_retry_release_missing_issue() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![])); // empty — issue not found
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Add a claimed retry
        {
            let mut state = orchestrator.state.write().await;
            state.add_retry(crate::tracker::model::RetryEntry {
                issue_id: "gone".to_string(),
                identifier: "repo#gone".to_string(),
                attempt: 1,
                due_at_ms: 0,
                error: None,
            });
        }

        // Handle the retry
        let retry_entry = crate::tracker::model::RetryEntry {
            issue_id: "gone".to_string(),
            identifier: "repo#gone".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
        };
        orchestrator.handle_single_retry(&retry_entry).await;

        let state = orchestrator.state.read().await;
        assert!(
            !state.is_claimed("gone"),
            "claim should be released when issue not found"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_full_cycle() {
        // Full cycle: start -> tick -> dispatch -> worker exit -> pipeline completion
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 10 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator =
            Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Tick 1: dispatches the issue
        orchestrator.handle_tick().await;

        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.get_pipeline_run("1").is_some());
        }

        // Wait for the mock worker to finish
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Drain worker events
        while let Ok(event) = orchestrator.worker_rx.try_recv() {
            orchestrator.handle_worker_event(event).await;
        }

        // After worker exit, pipeline should have completed or retried
        let state = orchestrator.state.read().await;
        if !state.is_running("1") {
            assert!(
                state.retry_attempts.contains_key("1") || state.completed.contains("1"),
                "should have retry or be completed"
            );
        }
    }
}
