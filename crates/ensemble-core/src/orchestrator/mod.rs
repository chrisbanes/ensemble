pub mod reconciler;
pub mod retry;
pub mod scheduler;
pub mod state;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tracing::{debug, info, warn};

use crate::agent::cancellation::{
    cancel_all, clear_issue_cancellation, new_cancellation_registry, register_issue_cancellation,
    CancellationRegistry,
};
use crate::agent::events::{AgentEvent, InteractionRequestDraft, WorkerEvent, WorkerResult};
use crate::agent::{AgentRunRequest, AgentRunner, InteractionResponseEnvelope};
use crate::config::ensemble::EnsembleConfig;
use crate::error::{AgentError, EnsembleError};
use crate::interaction::{InteractionStatus, InteractionStore};
use crate::pipeline::dag::build_dag;
use crate::pipeline::engine::{PipelineAction, PipelineRun};
use crate::pipeline::verdict::resolve_verdict;
use crate::tracker::model::Issue;
use crate::tracker::IssueTracker;
use crate::workspace::manager::WorkspaceManager;

use futures_util::FutureExt;
use reconciler::{reconcile_stalled_runs, reconcile_tracker_states, startup_terminal_cleanup};
use retry::{current_time_ms, get_due_retries, next_attempt, schedule_failure_retry};
use scheduler::{
    has_available_slots, is_dispatch_eligible, is_resume_dispatch_eligible, sort_for_dispatch,
};
use state::{OrchestratorState, WaitingOnHumanEntry};

struct StepDispatchContext<'a> {
    step_name: &'a str,
    agent_name: &'a str,
    tracker_state: Option<&'a str>,
    attempt: Option<u32>,
    interaction_response: Option<InteractionResponseEnvelope>,
    workspace_path: std::path::PathBuf,
}

struct InteractionRequestContext {
    step_name: String,
    agent_name: String,
    pipeline_cycle: u32,
    completed_steps: Vec<String>,
    step_depends: Vec<String>,
    step_tracker_state: Option<String>,
}

/// The main orchestrator that manages the poll-dispatch-reconcile loop.
pub struct Orchestrator {
    state: Arc<RwLock<OrchestratorState>>,
    config: Arc<RwLock<EnsembleConfig>>,
    tracker: Arc<dyn IssueTracker>,
    agent_runner: Arc<dyn AgentRunner>,
    workspace_mgr: Arc<WorkspaceManager>,
    interaction_store: InteractionStore,
    refresh_requested: Arc<tokio::sync::Notify>,
    cancellation_registry: CancellationRegistry,
    worker_tx: mpsc::Sender<WorkerEvent>,
    worker_rx: mpsc::Receiver<WorkerEvent>,
    shutdown_rx: mpsc::Receiver<()>,
}

pub struct OrchestratorRuntimeParts {
    pub state: Arc<RwLock<OrchestratorState>>,
    pub config: Arc<RwLock<EnsembleConfig>>,
    pub tracker: Arc<dyn IssueTracker>,
    pub agent_runner: Arc<dyn AgentRunner>,
    pub workspace_mgr: WorkspaceManager,
    pub refresh_requested: Arc<tokio::sync::Notify>,
    pub cancellation_registry: CancellationRegistry,
}

impl Orchestrator {
    /// Create a new Orchestrator.
    pub fn new(
        config: Arc<RwLock<EnsembleConfig>>,
        tracker: Arc<dyn IssueTracker>,
        agent_runner: Arc<dyn AgentRunner>,
        workspace_mgr: WorkspaceManager,
        config_dir: &Path,
        shutdown_rx: mpsc::Receiver<()>,
    ) -> Self {
        let state = Arc::new(RwLock::new(OrchestratorState::new(30_000, 10)));
        let refresh_requested = Arc::new(tokio::sync::Notify::new());
        Self::new_with_state(
            OrchestratorRuntimeParts {
                state,
                config,
                tracker,
                agent_runner,
                workspace_mgr,
                refresh_requested,
                cancellation_registry: new_cancellation_registry(),
            },
            config_dir,
            shutdown_rx,
        )
    }

    /// Create a new Orchestrator using externally managed state and refresh signaling.
    pub fn new_with_state(
        parts: OrchestratorRuntimeParts,
        config_dir: &Path,
        shutdown_rx: mpsc::Receiver<()>,
    ) -> Self {
        let (worker_tx, worker_rx) = mpsc::channel(1000);

        Self {
            state: parts.state,
            config: parts.config,
            tracker: parts.tracker,
            agent_runner: parts.agent_runner,
            interaction_store: InteractionStore::new(config_dir.to_path_buf()),
            workspace_mgr: Arc::new(parts.workspace_mgr),
            refresh_requested: parts.refresh_requested,
            cancellation_registry: parts.cancellation_registry,
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
            state.init_state_lists(&config);
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

                // Manual refresh signal
                _ = self.refresh_requested.notified() => {
                    debug!("manual refresh tick");
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
                    self.cancel_active_runs().await;
                    info!("received shutdown signal, stopping orchestrator");
                    break;
                }
            }
        }

        info!("orchestrator stopped");
    }

    /// Handle a poll tick: reconcile, validate, fetch, dispatch.
    async fn handle_tick(&self) {
        // Initialize state lists lazily (for tests that don't call run())
        {
            let state = self.state.read().await;
            if state.active_states_lower.is_empty() {
                drop(state);
                let config = self.config.read().await;
                let mut state = self.state.write().await;
                state.init_state_lists(&config);
            }
        }

        // Record tick timestamp for poll countdown
        {
            let mut state = self.state.write().await;
            state.last_tick_at = Some(Utc::now());
        }

        self.hydrate_waiting_on_human_from_store().await;

        // Pre-compute lowercase state lists once per tick
        let (active_lower, terminal_lower) = {
            let state = self.state.read().await;
            (
                state.active_states_lower.clone(),
                state.terminal_states_lower.clone(),
            )
        };

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
            let state = self.state.read().await;
            let reconcile_result = reconcile_tracker_states(
                &state,
                self.tracker.as_ref(),
                &active_lower,
                &terminal_lower,
            )
            .await;

            drop(state);

            {
                let mut state = self.state.write().await;
                for issue in reconcile_result.updates {
                    let id = issue.id.clone();
                    state.update_issue_snapshot(&id, issue);
                }
            }

            // Terminal: terminate and clean workspace
            for issue in reconcile_result.terminate_cleanup {
                let (identifier, interaction_request_id) = {
                    let mut state = self.state.write().await;
                    if let Some(entry) = state.remove_running(&issue.id) {
                        state.add_runtime_seconds(&entry);
                    }
                    let waiting_entry = state.waiting_on_human.get(&issue.id).cloned();
                    let identifier = waiting_entry
                        .as_ref()
                        .map(|entry| entry.identifier.clone())
                        .unwrap_or_else(|| issue.identifier.clone());
                    let interaction_request_id =
                        waiting_entry.map(|entry| entry.interaction_request_id);
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    (identifier, interaction_request_id)
                };

                self.cancel_open_interaction(interaction_request_id).await;

                if let Err(e) = self.workspace_mgr.remove_workspace(&identifier).await {
                    warn!(
                        identifier = %identifier,
                        error = %e,
                        "failed to clean terminal workspace"
                    );
                }
            }

            // Non-active: terminate without cleanup
            for issue in reconcile_result.terminate_no_cleanup {
                let interaction_request_id = {
                    let mut state = self.state.write().await;
                    if let Some(entry) = state.remove_running(&issue.id) {
                        state.add_runtime_seconds(&entry);
                    }
                    let interaction_request_id = state
                        .waiting_on_human
                        .get(&issue.id)
                        .map(|entry| entry.interaction_request_id.clone());
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    interaction_request_id
                };

                self.cancel_open_interaction(interaction_request_id).await;
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

        let resume_candidates = {
            let state = self.state.read().await;
            candidates
                .iter()
                .filter(|issue| state.is_resume_requested(&issue.id))
                .cloned()
                .collect::<Vec<_>>()
        };

        for issue in resume_candidates {
            match self.resume_blocked_issue(&issue).await {
                Ok(()) => {
                    let mut state = self.state.write().await;
                    state.clear_resume_request(&issue.id);
                }
                Err(error) => {
                    warn!(
                        issue_id = %issue.id,
                        issue_identifier = %issue.identifier,
                        error = %error,
                        "failed to process explicit resume request"
                    );
                }
            }
        }

        // 5. Dispatch eligible issues while slots remain
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
                    &active_lower,
                    &terminal_lower,
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
        let (dag, config_snapshot) = {
            let config = self.config.read().await;
            match build_dag(&config.steps) {
                Ok(d) => (d, Arc::new(config.clone())),
                Err(e) => {
                    warn!(issue_id = %issue.id, error = %e, "failed to build step DAG, skipping dispatch");
                    return;
                }
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
            state.insert_pipeline_run(&issue.id, pipeline_run, Arc::clone(&config_snapshot));
        }

        // Process initial dispatch requests
        if let PipelineAction::Dispatch(requests) = action {
            for req in requests {
                let workspace_path =
                    match self.prepare_step_workspace(issue, &config_snapshot).await {
                        Ok(path) => path,
                        Err(error) => {
                            warn!(
                                issue_id = %issue.id,
                                step = %req.step_name,
                                error = %error,
                                "failed to prepare step workspace"
                            );
                            let mut state = self.state.write().await;
                            if let Some(run) = state.get_pipeline_run_mut(&issue.id) {
                                run.step_failed(&req.step_name, error.to_string());
                            }
                            if let Some(entry) = state.remove_running(&issue.id) {
                                state.add_runtime_seconds(&entry);
                                schedule_failure_retry(
                                    &mut state,
                                    &issue.id,
                                    &entry.identifier,
                                    next_attempt(entry.retry_attempt),
                                    config_snapshot.agent.max_retry_backoff_ms,
                                    config_snapshot.max_cycles,
                                    &error.to_string(),
                                );
                            }
                            state.remove_pipeline_run(&issue.id);
                            return;
                        }
                    };

                let _ = self
                    .dispatch_step(
                        issue,
                        Arc::clone(&config_snapshot),
                        StepDispatchContext {
                            step_name: &req.step_name,
                            agent_name: &req.agent_name,
                            tracker_state: req.tracker_state.as_deref(),
                            attempt,
                            interaction_response: None,
                            workspace_path,
                        },
                    )
                    .await;
            }
        }
    }

    async fn prepare_step_workspace(
        &self,
        issue: &Issue,
        config_snapshot: &Arc<EnsembleConfig>,
    ) -> Result<std::path::PathBuf, EnsembleError> {
        let workspace = self
            .workspace_mgr
            .prepare_workspace(&issue.identifier)
            .await?;

        if workspace.created_now {
            if let Some(ref script) = config_snapshot.hooks.after_create {
                crate::workspace::hooks::run_hook(
                    "after_create",
                    script,
                    &workspace.base_path,
                    config_snapshot.hooks.timeout_ms,
                )
                .await
                .map_err(|e| AgentError::PromptError {
                    reason: format!("after_create hook failed: {e}"),
                })?;
            }
        }

        Ok(workspace.base_path)
    }

    /// Dispatch a single pipeline step after its workspace is ready.
    async fn dispatch_step(
        &self,
        issue: &Issue,
        config_snapshot: Arc<EnsembleConfig>,
        dispatch: StepDispatchContext<'_>,
    ) -> Result<(), EnsembleError> {
        info!(
            issue_id = %issue.id,
            identifier = %issue.identifier,
            step = dispatch.step_name,
            agent = dispatch.agent_name,
            "dispatching pipeline step"
        );

        // Set tracker state if specified by the step
        if let Some(state_name) = dispatch.tracker_state {
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
                    dispatch.step_name,
                    format!(
                        "{}-{}-{}",
                        issue.id, dispatch.step_name, dispatch.agent_name
                    ),
                );
            }
        }

        // Spawn worker task
        let issue_clone = issue.clone();
        let step_name_owned = dispatch.step_name.to_string();
        let agent_name_owned = dispatch.agent_name.to_string();
        let interaction_response = dispatch.interaction_response.clone();
        let runner = Arc::clone(&self.agent_runner);
        let event_tx = self.worker_tx.clone();
        let workspace_path = dispatch.workspace_path.clone();
        let attempt = dispatch.attempt;
        let cancel_token = tokio_util::sync::CancellationToken::new();
        register_issue_cancellation(&self.cancellation_registry, &issue.id, cancel_token.clone());
        let cancellation_registry = Arc::clone(&self.cancellation_registry);
        tokio::spawn(async move {
            let worker_result = catch_worker_panic(
                runner.run(AgentRunRequest {
                    config: Arc::clone(&config_snapshot),
                    issue: &issue_clone,
                    agent_name: &agent_name_owned,
                    step_name: &step_name_owned,
                    attempt,
                    interaction_response: interaction_response.clone(),
                    workspace_path: &workspace_path,
                    event_tx: event_tx.clone(),
                    cancel_token,
                }),
                &issue_clone.id,
                &step_name_owned,
            )
            .await;

            clear_issue_cancellation(&cancellation_registry, &issue_clone.id);

            let _ = event_tx
                .send(WorkerEvent::WorkerExited {
                    issue_id: issue_clone.id.clone(),
                    step_name: step_name_owned,
                    result: worker_result,
                    timestamp: Utc::now(),
                })
                .await;
        });

        Ok(())
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

        // Handle special cases
        match &event {
            AgentEvent::SessionStarted {
                session_id,
                agent_pid,
            } => {
                state.update_session_info(issue_id, session_id, agent_pid.as_deref());
            }
            AgentEvent::PromptStarted => {
                state.increment_turn_count(issue_id);
            }
            AgentEvent::RunCompleted { usage } | AgentEvent::RunFailed { usage, .. } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
            }
            _ => {}
        }

        // Common path: update agent event
        state.update_agent_event(
            issue_id,
            event.event_name(),
            event.message_for_state().as_deref(),
            timestamp,
        );
    }

    /// Handle a worker exit. Integrates with PipelineRun to drive step DAG.
    async fn handle_worker_exit(&self, issue_id: &str, step_name: &str, result: WorkerResult) {
        clear_issue_cancellation(&self.cancellation_registry, issue_id);
        // Get the issue snapshot for potential re-dispatch
        let issue_snapshot = {
            let state = self.state.read().await;
            state.running.get(issue_id).map(|e| e.issue.clone())
        };

        match result {
            WorkerResult::Success => {
                let config = self.config.read().await;
                info!(
                    issue_id = %issue_id,
                    step = step_name,
                    "worker exited successfully, resolving verdict"
                );

                let mut state = self.state.write().await;

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
                    Some((
                        run.step_completed(step_name, verdict),
                        state.get_pipeline_config(issue_id).cloned(),
                    ))
                } else {
                    warn!(issue_id = %issue_id, "no pipeline run found for worker exit");
                    None
                };

                if let Some((action, config_snapshot)) = pipeline_action {
                    match action {
                        PipelineAction::Dispatch(requests) => {
                            // Need to drop state lock before dispatching
                            drop(state);
                            if let Some(ref issue) = issue_snapshot {
                                let Some(config_snapshot) = config_snapshot else {
                                    warn!(issue_id = %issue_id, "no config snapshot found for pipeline dispatch");
                                    return;
                                };
                                for req in requests {
                                    let workspace_path = match self
                                        .prepare_step_workspace(issue, &config_snapshot)
                                        .await
                                    {
                                        Ok(path) => path,
                                        Err(error) => {
                                            warn!(
                                                issue_id = %issue_id,
                                                step = %req.step_name,
                                                error = %error,
                                                "failed to prepare step workspace"
                                            );

                                            let mut state = self.state.write().await;
                                            if let Some(run) = state.get_pipeline_run_mut(issue_id)
                                            {
                                                run.step_failed(&req.step_name, error.to_string());
                                            }
                                            if let Some(entry) = state.remove_running(issue_id) {
                                                state.add_runtime_seconds(&entry);
                                                schedule_failure_retry(
                                                    &mut state,
                                                    issue_id,
                                                    &entry.identifier,
                                                    next_attempt(entry.retry_attempt),
                                                    config_snapshot.agent.max_retry_backoff_ms,
                                                    config_snapshot.max_cycles,
                                                    &error.to_string(),
                                                );
                                            }
                                            state.remove_pipeline_run(issue_id);
                                            return;
                                        }
                                    };

                                    let _ = self
                                        .dispatch_step(
                                            issue,
                                            Arc::clone(&config_snapshot),
                                            StepDispatchContext {
                                                step_name: &req.step_name,
                                                agent_name: &req.agent_name,
                                                tracker_state: req.tracker_state.as_deref(),
                                                attempt: None,
                                                interaction_response: None,
                                                workspace_path,
                                            },
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
                            if let Some(entry) = state.remove_running(issue_id) {
                                state.add_runtime_seconds(&entry);
                                let retry_scheduled = schedule_failure_retry(
                                    &mut state,
                                    issue_id,
                                    &entry.identifier,
                                    next_attempt(entry.retry_attempt),
                                    config.agent.max_retry_backoff_ms,
                                    config.max_cycles,
                                    &reason,
                                );
                                if retry_scheduled.is_none() && self.tracker.supports_writes() {
                                    if let Err(e) = self
                                        .tracker
                                        .set_issue_state(issue_id, &config.on_failure)
                                        .await
                                    {
                                        warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                                    }
                                }
                            }
                            state.remove_pipeline_run(issue_id);
                        }
                        PipelineAction::BlockedOnHuman { .. } => {}
                        PipelineAction::Waiting => {
                            let issue_waiting_on_human = state.is_waiting_on_human(issue_id);
                            let has_running_steps = state
                                .get_pipeline_run(issue_id)
                                .is_some_and(Self::pipeline_has_running_steps);

                            if issue_waiting_on_human && !has_running_steps {
                                if let Some(entry) = state.remove_running(issue_id) {
                                    state.add_runtime_seconds(&entry);
                                }
                            }

                            debug!(issue_id = %issue_id, "pipeline waiting for other steps");
                        }
                    }
                }
            }
            WorkerResult::BlockedOnHuman { request } => {
                if let Err(error) = self
                    .handle_blocked_on_human(issue_id, step_name, &request, issue_snapshot.as_ref())
                    .await
                {
                    warn!(
                        issue_id = %issue_id,
                        step = step_name,
                        error = %error,
                        "blocked-on-human handling failed"
                    );

                    let config = self.config.read().await;
                    let mut state = self.state.write().await;
                    if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                        run.step_failed(step_name, error.to_string());
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
                            &error.to_string(),
                        );
                    }
                    state.remove_pipeline_run(issue_id);
                }
            }
            WorkerResult::Failed { error } => {
                let config = self.config.read().await;
                let mut state = self.state.write().await;
                warn!(
                    issue_id = %issue_id,
                    step = step_name,
                    error = %error,
                    "worker exited with failure"
                );

                if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    run.step_failed(step_name, error.clone());
                }

                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    let retry_scheduled = schedule_failure_retry(
                        &mut state,
                        issue_id,
                        &entry.identifier,
                        next_attempt(entry.retry_attempt),
                        config.agent.max_retry_backoff_ms,
                        config.max_cycles,
                        &error,
                    );
                    if retry_scheduled.is_none() && self.tracker.supports_writes() {
                        if let Err(e) = self
                            .tracker
                            .set_issue_state(issue_id, &config.on_failure)
                            .await
                        {
                            warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                        }
                    }
                }
                state.remove_pipeline_run(issue_id);
            }
        }
    }

    async fn handle_blocked_on_human(
        &self,
        issue_id: &str,
        step_name: &str,
        request: &InteractionRequestDraft,
        issue_snapshot: Option<&Issue>,
    ) -> Result<(), EnsembleError> {
        let issue = issue_snapshot.ok_or_else(|| AgentError::PromptError {
            reason: format!("missing running issue snapshot for blocked issue {issue_id}"),
        })?;

        let interaction_context = {
            let state = self.state.read().await;
            let config =
                state
                    .get_pipeline_config(issue_id)
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!("missing pipeline config for blocked issue {issue_id}"),
                    })?;
            let step = config
                .steps
                .iter()
                .find(|step| step.name == step_name)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!("blocked step '{step_name}' no longer exists"),
                })?;
            let run = state
                .get_pipeline_run(issue_id)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!("missing pipeline run for blocked issue {issue_id}"),
                })?;
            let completed_steps = config
                .steps
                .iter()
                .filter(|candidate| {
                    matches!(
                        run.step_states.get(&candidate.name),
                        Some(crate::pipeline::engine::StepState::Passed)
                    )
                })
                .map(|candidate| candidate.name.clone())
                .collect();
            InteractionRequestContext {
                step_name: step_name.to_string(),
                agent_name: step.agent.clone(),
                pipeline_cycle: run.cycle,
                completed_steps,
                step_depends: step.depends.clone().unwrap_or_default(),
                step_tracker_state: step.tracker_state.clone(),
            }
        };

        let interaction = build_interaction_request(issue, interaction_context, request.clone());
        self.interaction_store.create(interaction.clone()).await?;

        let mut state = self.state.write().await;
        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.step_blocked_on_human(step_name, interaction.id.clone());
        }
        let has_running_steps = state
            .get_pipeline_run(issue_id)
            .is_some_and(Self::pipeline_has_running_steps);

        let retry_attempt = state
            .running
            .get(issue_id)
            .and_then(|entry| entry.retry_attempt);

        if !has_running_steps {
            if let Some(entry) = state.remove_running(issue_id) {
                state.add_runtime_seconds(&entry);
            }
        }
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: interaction.id,
            step_name: step_name.to_string(),
            retry_attempt,
            requested_at: interaction.requested_at,
        });

        Ok(())
    }

    async fn hydrate_waiting_on_human_from_store(&self) {
        let interactions = match self.interaction_store.list_awaiting_resume().await {
            Ok(interactions) => interactions,
            Err(error) => {
                warn!(error = %error, "failed to hydrate waiting interactions from store");
                return;
            }
        };

        let mut state = self.state.write().await;
        for interaction in interactions {
            if state.is_running(&interaction.issue_id) {
                continue;
            }

            state.add_waiting_on_human(WaitingOnHumanEntry {
                issue_id: interaction.issue_id.clone(),
                identifier: interaction.issue_identifier.clone(),
                interaction_request_id: interaction.id.clone(),
                step_name: interaction.step_name.clone(),
                retry_attempt: Some(interaction.pipeline_cycle.max(1)),
                requested_at: interaction.requested_at,
            });
        }
    }

    async fn cancel_open_interaction(&self, interaction_request_id: Option<String>) {
        let Some(interaction_request_id) = interaction_request_id else {
            return;
        };

        if let Err(error) = self
            .interaction_store
            .clear_waiting_state(&interaction_request_id)
            .await
        {
            warn!(
                interaction_request_id = %interaction_request_id,
                error = %error,
                "failed to clear interaction waiting state during waiting-issue cleanup"
            );
        }
    }

    fn pipeline_has_running_steps(run: &PipelineRun) -> bool {
        run.step_states.values().any(|step_state| {
            matches!(
                step_state,
                crate::pipeline::engine::StepState::Running { .. }
            )
        })
    }

    async fn restore_blocked_issue_state(
        &self,
        issue: &Issue,
        interaction: &crate::interaction::InteractionRequest,
        config_snapshot: Arc<EnsembleConfig>,
    ) -> Result<(), EnsembleError> {
        let dag = build_dag(&config_snapshot.steps)?;

        if interaction
            .completed_steps
            .iter()
            .any(|completed_step| !dag.steps.iter().any(|step| step.name == *completed_step))
        {
            return Err(AgentError::PromptError {
                reason: format!(
                    "blocked interaction '{}' references steps that no longer exist",
                    interaction.id
                ),
            }
            .into());
        }

        let mut pipeline_run =
            PipelineRun::new(issue.id.clone(), interaction.pipeline_cycle.max(1), dag);
        for completed_step in &interaction.completed_steps {
            pipeline_run.step_states.insert(
                completed_step.clone(),
                crate::pipeline::engine::StepState::Passed,
            );
        }
        pipeline_run.step_blocked_on_human(&interaction.step_name, interaction.id.clone());

        let mut state = self.state.write().await;
        state.insert_pipeline_run(&issue.id, pipeline_run, config_snapshot);
        if !state.is_waiting_on_human(&issue.id) {
            state.add_waiting_on_human(WaitingOnHumanEntry {
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                interaction_request_id: interaction.id.clone(),
                step_name: interaction.step_name.clone(),
                retry_attempt: Some(interaction.pipeline_cycle.max(1)),
                requested_at: interaction.requested_at,
            });
        }

        Ok(())
    }

    pub async fn resume_blocked_issue(&self, issue: &Issue) -> Result<(), EnsembleError> {
        let current_config = {
            let config = self.config.read().await;
            Arc::new(config.clone())
        };

        self.hydrate_waiting_on_human_from_store().await;

        let interaction = self
            .interaction_store
            .latest_blocking_for_issue(&issue.id)
            .await?
            .ok_or_else(|| AgentError::PromptError {
                reason: format!("issue '{}' is not waiting on human", issue.identifier),
            })?;

        if interaction.status != InteractionStatus::Resolved {
            return Err(AgentError::PromptError {
                reason: format!("interaction '{}' is not resolved", interaction.id),
            }
            .into());
        }

        let waiting = {
            let state = self.state.read().await;
            state
                .waiting_on_human
                .get(&issue.id)
                .cloned()
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!("issue '{}' is not waiting on human", issue.identifier),
                })?
        };

        if waiting.step_name != interaction.step_name {
            return Err(AgentError::PromptError {
                reason: format!(
                    "waiting entry step '{}' does not match resolved interaction step '{}'",
                    waiting.step_name, interaction.step_name
                ),
            }
            .into());
        }

        let current_dag = build_dag(&current_config.steps)?;
        let current_step = current_dag
            .steps
            .iter()
            .find(|candidate| candidate.name == waiting.step_name)
            .cloned()
            .ok_or_else(|| AgentError::PromptError {
                reason: format!("blocked step '{}' no longer exists", waiting.step_name),
            })?;

        if current_step.agent != interaction.agent_name {
            return Err(AgentError::PromptError {
                reason: format!(
                    "blocked step '{}' now references different agent '{}'",
                    waiting.step_name, current_step.agent
                ),
            }
            .into());
        }

        if current_step.depends != interaction.step_depends
            || current_step.tracker_state != interaction.step_tracker_state
        {
            return Err(AgentError::PromptError {
                reason: format!(
                    "blocked step '{}' changed while waiting and requires operator attention",
                    interaction.step_name
                ),
            }
            .into());
        }

        if !interaction
            .step_depends
            .iter()
            .all(|dependency| interaction.completed_steps.contains(dependency))
        {
            return Err(AgentError::PromptError {
                reason: format!(
                    "blocked interaction '{}' is missing completed dependencies for step '{}'",
                    interaction.id, interaction.step_name
                ),
            }
            .into());
        }

        if waiting.interaction_request_id != interaction.id {
            return Err(AgentError::PromptError {
                reason: format!(
                    "waiting entry interaction '{}' does not match resolved interaction '{}'",
                    waiting.interaction_request_id, interaction.id
                ),
            }
            .into());
        }

        {
            let state = self.state.read().await;
            if let Some(run) = state.get_pipeline_run(&issue.id) {
                let blocked_step = run
                    .step_states
                    .iter()
                    .find_map(|(step_name, step_state)| match step_state {
                        crate::pipeline::engine::StepState::BlockedOnHuman {
                            interaction_request_id,
                        } => Some((step_name.clone(), interaction_request_id.clone())),
                        _ => None,
                    })
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!(
                            "issue '{}' is not waiting on a blocked step",
                            issue.identifier
                        ),
                    })?;

                if blocked_step.0 != waiting.step_name {
                    return Err(AgentError::PromptError {
                        reason: format!(
                            "waiting entry step '{}' does not match blocked pipeline step '{}'",
                            waiting.step_name, blocked_step.0
                        ),
                    }
                    .into());
                }

                if blocked_step.1 != waiting.interaction_request_id {
                    return Err(AgentError::PromptError {
                        reason: format!(
                            "waiting entry interaction '{}' does not match blocked pipeline interaction '{}'",
                            waiting.interaction_request_id, blocked_step.1
                        ),
                    }
                    .into());
                }
            }
        }

        self.restore_blocked_issue_state(issue, &interaction, Arc::clone(&current_config))
            .await?;

        if !current_config.agents.contains_key(&current_step.agent) {
            return Err(AgentError::PromptError {
                reason: format!(
                    "blocked step agent '{}' no longer exists",
                    current_step.agent
                ),
            }
            .into());
        }

        {
            let state = self.state.read().await;
            if let Some(reason) = is_resume_dispatch_eligible(
                issue,
                &state,
                &current_config.tracker.active_states,
                &current_config.tracker.terminal_states,
                &HashMap::new(),
            ) {
                return Err(AgentError::PromptError {
                    reason: format!("issue '{}' cannot be resumed: {reason}", issue.identifier),
                }
                .into());
            }
        }

        let response = interaction
            .response
            .clone()
            .ok_or_else(|| AgentError::PromptError {
                reason: format!(
                    "resolved interaction '{}' is missing a response",
                    interaction.id
                ),
            })?;
        let resolved_at = interaction
            .resolved_at
            .ok_or_else(|| AgentError::PromptError {
                reason: format!(
                    "resolved interaction '{}' is missing resolved_at",
                    interaction.id
                ),
            })?;
        let interaction_response = InteractionResponseEnvelope::new(
            interaction.schema_version,
            interaction.id.clone(),
            interaction.kind.clone(),
            response,
            resolved_at,
        );

        let attempt = {
            let mut state = self.state.write().await;
            let attempt = state
                .get_pipeline_run(&issue.id)
                .map(|run| run.cycle)
                .unwrap_or(interaction.pipeline_cycle.max(1));
            state.add_running(issue, Some(attempt));
            attempt
        };

        let workspace_path = match self.prepare_step_workspace(issue, &current_config).await {
            Ok(path) => path,
            Err(error) => {
                let mut state = self.state.write().await;
                state.remove_running(&issue.id);
                return Err(AgentError::PromptError {
                    reason: format!("workspace error: {error}"),
                }
                .into());
            }
        };

        self.dispatch_step(
            issue,
            Arc::clone(&current_config),
            StepDispatchContext {
                step_name: &current_step.name,
                agent_name: &current_step.agent,
                tracker_state: current_step.tracker_state.as_deref(),
                attempt: Some(attempt),
                interaction_response: Some(interaction_response),
                workspace_path,
            },
        )
        .await?;

        self.interaction_store.mark_resumed(&interaction.id).await?;

        let mut state = self.state.write().await;
        state.remove_waiting_on_human(&issue.id);

        Ok(())
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

    async fn cancel_active_runs(&self) {
        let cancelled = cancel_all(&self.cancellation_registry);
        if cancelled > 0 {
            debug!(cancelled, "cancelled active worker tokens");
        }

        #[cfg(unix)]
        {
            let running = {
                let state = self.state.read().await;
                state
                    .running
                    .iter()
                    .filter_map(|(issue_id, entry)| {
                        entry.agent_pid.as_deref().and_then(|pid| {
                            pid.parse::<i32>()
                                .ok()
                                .filter(|parsed| *parsed > 0)
                                .map(|parsed| (issue_id.clone(), parsed))
                        })
                    })
                    .collect::<Vec<_>>()
            };

            for (issue_id, pid) in running {
                let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
                if rc == -1 {
                    warn!(
                        issue_id,
                        pid, "failed to send SIGTERM during orchestrator shutdown"
                    );
                }
            }
        }
    }
}

async fn catch_worker_panic<F>(fut: F, issue_id: &str, step_name: &str) -> WorkerResult
where
    F: std::future::Future<Output = Result<WorkerResult, AgentError>>,
{
    match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => WorkerResult::Failed {
            error: e.to_string(),
        },
        Err(_) => {
            warn!(issue_id, step = step_name, "worker task panicked");
            WorkerResult::Failed {
                error: "worker task panicked".to_string(),
            }
        }
    }
}

fn build_interaction_request(
    issue: &Issue,
    context: InteractionRequestContext,
    request: InteractionRequestDraft,
) -> crate::interaction::InteractionRequest {
    let requested_at = Utc::now();
    crate::interaction::InteractionRequest {
        id: format!(
            "interaction-{}-{}-{}",
            sanitize_interaction_fragment(&issue.id),
            sanitize_interaction_fragment(&context.step_name),
            requested_at.timestamp_millis()
        ),
        schema_version: request.schema_version,
        issue_id: issue.id.clone(),
        issue_identifier: issue.identifier.clone(),
        pipeline_cycle: context.pipeline_cycle,
        completed_steps: context.completed_steps,
        step_name: context.step_name,
        agent_name: context.agent_name,
        step_depends: context.step_depends,
        step_tracker_state: context.step_tracker_state,
        kind: request.kind,
        status: InteractionStatus::Open,
        blocking: request.blocking,
        awaiting_resume: request.blocking,
        title: request.title,
        body: request.body,
        options: request.options,
        artifacts: request.artifacts,
        response: None,
        requested_at,
        resolved_at: None,
    }
}

fn sanitize_interaction_fragment(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{AgentEvent, InteractionRequestDraft, WorkerEvent, WorkerResult};
    use crate::config::ensemble::parse_config;
    use crate::error::AgentError;
    use crate::interaction::{
        InteractionKind, InteractionResponse, InteractionStatus, InteractionStore,
    };
    use crate::pipeline::verdict::Verdict;
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
        observed_commands: Option<Arc<RwLock<Vec<String>>>>,
        cancellation_probe: Option<Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>>,
    }

    #[async_trait]
    impl AgentRunner for MockRunner {
        async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            let AgentRunRequest {
                config,
                issue,
                step_name,
                event_tx,
                cancel_token,
                ..
            } = request;
            if let Some(observed_commands) = &self.observed_commands {
                observed_commands
                    .write()
                    .await
                    .push(config.agent.command.clone());
            }
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
            if let Some(probe) = &self.cancellation_probe {
                cancel_token.cancelled().await;
                if let Some(sender) = probe.lock().unwrap().take() {
                    let _ = sender.send(());
                }
                return Err(AgentError::TurnCancelled);
            }
            Ok(WorkerResult::Success)
        }
    }

    struct PanicRunner;

    #[async_trait]
    impl AgentRunner for PanicRunner {
        async fn run(&self, _request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            panic!("boom");
        }
    }

    fn test_issue(id: &str, state: &str) -> Issue {
        crate::tracker::model::test_helpers::test_issue(id, state)
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
  permission_request_policy: auto_approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    fn make_parallel_resume_config() -> EnsembleConfig {
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
    depends: []
  - name: docs
    agent: builder
    depends: []
  - name: review
    agent: builder
    depends: ["build"]
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
        parse_config(yaml).unwrap()
    }

    #[tokio::test]
    async fn test_orchestrator_dispatches_on_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 10,
            observed_commands: None,
            cancellation_probe: None,
        });
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
            state.insert_pipeline_run("1", pipeline_run2, Arc::new(cfg.clone()));
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

        // Manually add a running entry with attempt 2 and a pipeline run
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 2, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), Some(2));
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
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
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
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

        orchestrator
            .handle_agent_update("1", "build", AgentEvent::PromptStarted, Utc::now())
            .await;
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::OutputChunk {
                    stream: crate::agent::events::RuntimeStream::Stdout,
                    content: "hello".to_string(),
                },
                Utc::now(),
            )
            .await;

        // Send run completed with usage
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::RunCompleted {
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
        assert_eq!(entry.turn_count, 1);
        assert_eq!(entry.last_agent_event.as_deref(), Some("run_completed"));
        assert_eq!(entry.last_agent_message.as_deref(), Some("hello"));
        assert_eq!(state.agent_totals.input_tokens, 500);
        assert_eq!(state.agent_totals.total_tokens, 700);
    }

    #[tokio::test]
    async fn handle_agent_update_accepts_prompt_started_and_output_chunk() {
        let config = Arc::new(RwLock::new(make_config()));
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
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::PromptStarted,
                timestamp: Utc::now(),
            })
            .await;
        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::OutputChunk {
                    stream: crate::agent::events::RuntimeStream::Stdout,
                    content: "hi".to_string(),
                },
                timestamp: Utc::now(),
            })
            .await;

        let state = orchestrator.state.read().await;
        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.turn_count, 1);
        assert_eq!(entry.last_agent_event.as_deref(), Some("output_chunk"));
        assert_eq!(entry.last_agent_message.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn test_orchestrator_retry_release_missing_issue() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![])); // empty — issue not found
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
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

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
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 10,
            observed_commands: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

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

    #[tokio::test]
    async fn refresh_signal_triggers_an_immediate_tick() {
        let mut config_value = make_config();
        config_value.polling.interval_ms = 60_000;
        let config = Arc::new(RwLock::new(config_value));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let refresh_requested = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(RwLock::new(OrchestratorState::new(60_000, 10)));
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                workspace_mgr,
                refresh_requested: Arc::clone(&refresh_requested),
                cancellation_registry: new_cancellation_registry(),
            },
            dir.path(),
            shutdown_rx,
        );

        let run_handle = tokio::spawn(async move {
            orchestrator.run().await;
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if state.read().await.last_tick_at.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let first_tick_at = state.read().await.last_tick_at.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        refresh_requested.notify_one();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let current_tick_at = state.read().await.last_tick_at.unwrap();
                if current_tick_at > first_tick_at {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        shutdown_tx.send(()).await.unwrap();
        run_handle.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_signal_cancels_running_issue_tokens() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
        });
        let (probe_tx, probe_rx) = tokio::sync::oneshot::channel();
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: Some(Arc::new(std::sync::Mutex::new(Some(probe_tx)))),
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let refresh_requested = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(RwLock::new(OrchestratorState::new(100, 10)));
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                workspace_mgr,
                refresh_requested,
                cancellation_registry: new_cancellation_registry(),
            },
            dir.path(),
            shutdown_rx,
        );

        let run_handle = tokio::spawn(async move {
            orchestrator.run().await;
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if state.read().await.is_running("1") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        shutdown_tx.send(()).await.unwrap();

        tokio::time::timeout(Duration::from_secs(2), probe_rx)
            .await
            .unwrap()
            .unwrap();
        run_handle.await.unwrap();
    }

    #[tokio::test]
    async fn worker_panic_clears_cancellation_registry() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(PanicRunner);
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
        let issue = test_issue("1", "Todo");

        orchestrator.dispatch_issue(&issue, None).await;

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let is_empty = orchestrator
                    .cancellation_registry
                    .lock()
                    .unwrap()
                    .is_empty();
                if is_empty {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn test_dispatch_uses_config_snapshot_for_runner() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let observed_commands = Arc::new(RwLock::new(Vec::new()));
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: Some(Arc::clone(&observed_commands)),
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
        let issue = test_issue("1", "Todo");

        orchestrator.dispatch_issue(&issue, None).await;

        {
            let mut cfg = config.write().await;
            cfg.agent.command = "echo changed".to_string();
        }

        tokio::time::sleep(Duration::from_millis(50)).await;

        let commands = observed_commands.read().await;
        assert_eq!(commands.as_slice(), &["echo test".to_string()]);
    }

    #[tokio::test]
    async fn blocked_issue_releases_running_slot_and_stays_claimed() {
        let config = Arc::new(RwLock::new(make_config()));
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
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::BlockedOnHuman {
                    request: InteractionRequestDraft {
                        schema_version: 1,
                        kind: InteractionKind::Question,
                        blocking: true,
                        title: "Need input".to_string(),
                        body: "Choose environment".to_string(),
                        options: vec!["staging".to_string()],
                        artifacts: vec![],
                    },
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert!(state.is_waiting_on_human("1"));
        assert!(state.agent_totals.seconds_running >= 0.0);
    }

    #[tokio::test]
    async fn blocked_issue_persists_interaction_and_does_not_schedule_retry() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
        let workspace_dir = tempfile::TempDir::new().unwrap();
        let config_dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(workspace_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            config.clone(),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::BlockedOnHuman {
                    request: InteractionRequestDraft {
                        schema_version: 1,
                        kind: InteractionKind::Question,
                        blocking: true,
                        title: "Need input".to_string(),
                        body: "Choose environment".to_string(),
                        options: vec!["staging".to_string(), "production".to_string()],
                        artifacts: vec!["docs/spec.md".to_string()],
                    },
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(state.retry_attempts.is_empty());
        let waiting = state.waiting_on_human.get("1").unwrap();
        let store = InteractionStore::new(config_dir.path().to_path_buf());
        let interaction = store
            .get(&waiting.interaction_request_id)
            .await
            .unwrap()
            .expect("interaction should be persisted");
        assert_eq!(interaction.issue_id, "1");
        assert_eq!(interaction.issue_identifier, "repo#1");
        assert_eq!(interaction.step_name, "build");
        assert_eq!(interaction.status, InteractionStatus::Open);

        let workspace_store = InteractionStore::new(workspace_dir.path().to_path_buf());
        assert!(
            workspace_store
                .get(&waiting.interaction_request_id)
                .await
                .unwrap()
                .is_none(),
            "interaction should not be persisted under the workspace root"
        );
    }

    #[tokio::test]
    async fn blocked_step_keeps_running_state_while_parallel_sibling_is_still_running() {
        let config = Arc::new(RwLock::new(make_parallel_resume_config()));
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
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-build".to_string());
            pipeline_run.mark_running("docs", "session-docs".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::BlockedOnHuman {
                    request: InteractionRequestDraft {
                        schema_version: 1,
                        kind: InteractionKind::Question,
                        blocking: true,
                        title: "Need input".to_string(),
                        body: "Choose environment".to_string(),
                        options: vec!["staging".to_string()],
                        artifacts: vec![],
                    },
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
        let run = state.get_pipeline_run("1").unwrap();
        assert!(matches!(
            run.step_states.get("build"),
            Some(crate::pipeline::engine::StepState::BlockedOnHuman { .. })
        ));
        assert!(matches!(
            run.step_states.get("docs"),
            Some(crate::pipeline::engine::StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn final_parallel_sibling_exit_releases_running_state_when_issue_is_waiting_on_human() {
        let config = Arc::new(RwLock::new(make_parallel_resume_config()));
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
            pipeline_run.start();
            pipeline_run.step_completed("build", Verdict::Approve);
            pipeline_run.step_blocked_on_human("review", "interaction-1".to_string());
            pipeline_run.mark_running("docs", "session-docs".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "review".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit("1", "docs", WorkerResult::Success)
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn resume_requeues_resolved_blocked_issue() {
        let config = Arc::new(RwLock::new(make_config()));
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

        let interaction_id = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
            "interaction-1".to_string()
        };

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: interaction_id.clone(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                &interaction_id,
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("resume should succeed");

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn explicit_resume_request_requeues_resolved_blocked_issue_on_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
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

        let interaction_id = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
            state.queue_resume("1");
            "interaction-1".to_string()
        };

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: interaction_id.clone(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: Some(InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                }),
                requested_at: Utc::now(),
                resolved_at: Some(Utc::now()),
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_resume_requested("1"));
    }

    #[tokio::test]
    async fn resume_requeues_resolved_blocked_issue_without_waiting_entry() {
        let config = Arc::new(RwLock::new(make_config()));
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

        let interaction_id = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            "interaction-1".to_string()
        };

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: interaction_id.clone(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                &interaction_id,
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("resume should succeed from persisted interaction");

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn resume_requeues_resolved_blocked_issue_after_restart_without_pipeline_state() {
        let config = Arc::new(RwLock::new(make_config()));
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

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("resume should succeed from durable interaction state alone");

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        let run = state
            .get_pipeline_run("1")
            .expect("pipeline run should be reconstructed for resumed issue");
        assert!(matches!(
            run.step_states.get("build"),
            Some(crate::pipeline::engine::StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn resume_after_restart_keeps_unrelated_parallel_steps_pending() {
        let config = Arc::new(RwLock::new(make_parallel_resume_config()));
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

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec!["build".to_string()],
                step_name: "review".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec!["build".to_string()],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("resume should reconstruct state");

        let state = orchestrator.state.read().await;
        let run = state
            .get_pipeline_run("1")
            .expect("pipeline run should be present");
        assert_eq!(
            run.step_states.get("build"),
            Some(&crate::pipeline::engine::StepState::Passed)
        );
        assert_eq!(
            run.step_states.get("docs"),
            Some(&crate::pipeline::engine::StepState::Pending)
        );
        assert!(matches!(
            run.step_states.get("review"),
            Some(crate::pipeline::engine::StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn resume_fails_when_pipeline_run_has_no_matching_blocked_step() {
        let config = Arc::new(RwLock::new(make_config()));
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
            let pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("resume should require a blocked pipeline step");

        assert!(error.to_string().contains("blocked"));

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn resume_fails_when_waiting_entry_disagrees_with_blocked_step() {
        let config = Arc::new(RwLock::new(make_config()));
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-2".to_string(),
                step_name: "build".to_string(),
                retry_attempt: Some(1),
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-2".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-2",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("resume should reject mismatched waiting metadata");

        assert!(error.to_string().contains("interaction"));

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn resume_keeps_waiting_when_redispatch_workspace_prep_fails() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_root_file = dir.path().join("workspace-root-file");
        std::fs::write(&workspace_root_file, "not a directory").unwrap();
        let workspace_mgr = WorkspaceManager::new(&workspace_root_file, None).unwrap();
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("resume should fail when workspace preparation fails");

        assert!(error.to_string().contains("workspace error"));

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn resume_fails_when_current_config_no_longer_contains_blocked_step() {
        let config = Arc::new(RwLock::new(make_config()));
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        {
            let mut cfg = config.write().await;
            cfg.steps[0].name = "renamed-build".to_string();
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err(
                "resume should fail when current config no longer contains the blocked step",
            );

        assert!(error.to_string().contains("build"));

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[tokio::test]
    async fn handle_tick_releases_waiting_issue_when_tracker_moves_to_terminal() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Done")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        workspace_mgr.prepare_workspace("repo#1").await.unwrap();
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_claimed("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(state.get_pipeline_run("1").is_none());
        assert!(!dir.path().join("repo_1").exists());
    }

    #[tokio::test]
    async fn handle_tick_cancels_open_interaction_when_waiting_issue_is_released() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Done")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let interaction = store
            .get("interaction-1")
            .await
            .unwrap()
            .expect("interaction should still exist");
        assert_eq!(interaction.status, InteractionStatus::Cancelled);
    }

    #[tokio::test]
    async fn handle_tick_hydrates_persisted_open_interaction_after_restart() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Done")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
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

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_claimed("1"));

        let interaction = store
            .get("interaction-1")
            .await
            .unwrap()
            .expect("interaction should still exist");
        assert_eq!(interaction.status, InteractionStatus::Cancelled);
    }

    #[tokio::test]
    async fn handle_tick_clears_waiting_issue_when_tracker_no_longer_returns_it() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: Some(1),
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());

        let interaction = store
            .get("interaction-1")
            .await
            .unwrap()
            .expect("interaction should still exist");
        assert_eq!(interaction.status, InteractionStatus::Cancelled);
    }

    #[tokio::test]
    async fn handle_tick_releases_waiting_issue_when_tracker_moves_to_non_active() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Backlog")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        workspace_mgr.prepare_workspace("repo#1").await.unwrap();
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                retry_attempt: Some(1),
                requested_at: Utc::now(),
            });
        }

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_claimed("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(state.get_pipeline_run("1").is_none());
        assert!(dir.path().join("repo_1").exists());
    }

    #[tokio::test]
    async fn resume_fails_when_step_name_no_longer_exists() {
        let config = Arc::new(RwLock::new(make_config()));
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
            pipeline_run.start();
            pipeline_run.step_blocked_on_human("build", "interaction-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.add_claimed("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "missing-step".to_string(),
                retry_attempt: None,
                requested_at: Utc::now(),
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: vec![],
                step_name: "missing-step".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                requested_at: Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .resolve(
                "interaction-1",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("resume should fail for missing step");

        assert!(error.to_string().contains("missing-step"));
    }
}
