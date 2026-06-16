pub mod pipeline_journal;
pub mod reconciler;
pub mod retry;
pub mod scheduler;
pub mod state;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tokio::time::{sleep, timeout};
use tracing::{debug, error, info, warn};

use crate::agent::cancellation::{
    cancel_all, clear_issue_cancellation, new_cancellation_registry, register_issue_cancellation,
    CancellationRegistry,
};
use crate::agent::events::{
    AgentEvent, InteractionRequestDraft, StepApprovalRequestDraft, WorkerEvent, WorkerFailureKind,
    WorkerResult,
};
use crate::agent::{AgentRunRequest, AgentRunner, InteractionResponseEnvelope};
use crate::config::ensemble::{EnsembleConfig, OnFailure, StepKind};
use crate::error::{AgentError, EnsembleError};
use crate::history::artifacts::{FinalizeActionOutput, RunArtifacts};
use crate::history::model::{HistoryRecord, TokenTotals};
use crate::history::writer::HistoryWriter;
use crate::history_store::store::HistoryStore;
use crate::interaction::model::{
    AcceptedInteractionCommand, IgnoredInteractionCommand, InteractionKind, InteractionResponse,
};
use crate::interaction::{
    parse_interaction_command, InteractionCommand, InteractionResumeStrategy, InteractionStatus,
    InteractionStore,
};
use crate::observability::events::{EventBus, PipelineEvent};
use crate::observability::events_contract::{
    elapsed_ms, ISSUE_DISPATCH_COMPLETED, ISSUE_DISPATCH_STARTED, ORCH_TICK_FINISHED,
    ORCH_TICK_STARTED, STEP_STARTED, TRACKER_TRANSITION_FAILED, TRACKER_TRANSITION_REQUESTED,
    TRACKER_TRANSITION_SUCCEEDED,
};
use crate::orchestrator::pipeline_journal::{
    PipelineRunJournal, PipelineTransitionInput, PipelineTransitionKind, PipelineTransitionRecord,
};
use crate::pipeline::dag::build_dag;
use crate::pipeline::engine::{
    DispatchRequest, PipelineAction, PipelineRun, PipelineRunSnapshot, StepOutputTemplateContext,
    StepState,
};
use crate::pipeline::verdict::StepResult;
use crate::timeline::persistence::TimelinePersistence;
use crate::tracker::model::{Issue, RetryEntry};
use crate::tracker::IssueTracker;
use crate::transcript::events::TranscriptEventBus;
use crate::transcript::model::TranscriptRecordKind;
use crate::transcript::persistence::{TranscriptPersistRequest, TranscriptPersistence};
use crate::workspace::finalize::FinalizeMode;
use crate::workspace::manager::WorkspaceManager;

use futures_util::FutureExt;
use reconciler::{reconcile_stalled_runs, reconcile_tracker_states, startup_terminal_cleanup};
use retry::{
    current_time_ms, get_due_retries, next_attempt, schedule_failure_retry, FailureRetryRequest,
};
use scheduler::{
    has_available_slots, is_dispatch_eligible, is_resume_dispatch_eligible, sort_for_dispatch,
};
use state::{
    FinalizeStatus, IssueFinalizeState, OrchestratorState, RepoFinalizeState, WaitingOnHumanEntry,
};

struct StepDispatchContext<'a> {
    step_name: &'a str,
    agent_name: &'a str,
    step_kind: StepKind,
    tracker_state: Option<&'a str>,
    attempt: Option<u32>,
    timeout_ms: u64,
    interaction_response: Option<InteractionResponseEnvelope>,
    workspace_path: std::path::PathBuf,
    step_outputs: StepOutputTemplateContext,
}

struct InteractionRequestContext {
    step_name: String,
    agent_name: String,
    pipeline_cycle: u32,
    completed_steps: Vec<String>,
    step_depends: Vec<String>,
    step_tracker_state: Option<String>,
}

const HISTORY_OUTCOME_SUCCEEDED: &str = "succeeded";
const HISTORY_OUTCOME_FAILED: &str = "failed";
const HISTORY_OUTCOME_STOPPED: &str = "stopped";
const HISTORY_VERDICT_APPROVED: &str = "approved";
const HISTORY_VERDICT_REJECTED: &str = "rejected";
const HISTORY_VERDICT_FAILED: &str = "failed";
const REJECTION_COMMENT_PREFIX: &str = "Ensemble pipeline rejected";

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
    history_write_lock: Arc<tokio::sync::Mutex<()>>,
    history_store: Option<HistoryStore>,
    pipeline_journal: PipelineRunJournal,
    event_bus: EventBus,
    timeline_persistence: Option<TimelinePersistence>,
    transcript_persistence: Option<TranscriptPersistence>,
    worker_tx: mpsc::Sender<WorkerEvent>,
    worker_rx: mpsc::Receiver<WorkerEvent>,
    shutdown_rx: mpsc::Receiver<()>,
}

static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(1);
const FINALIZE_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

pub struct OrchestratorRuntimeParts {
    pub state: Arc<RwLock<OrchestratorState>>,
    pub config: Arc<RwLock<EnsembleConfig>>,
    pub tracker: Arc<dyn IssueTracker>,
    pub agent_runner: Arc<dyn AgentRunner>,
    pub workspace_mgr: WorkspaceManager,
    pub refresh_requested: Arc<tokio::sync::Notify>,
    pub cancellation_registry: CancellationRegistry,
    pub event_bus: EventBus,
    pub transcript_event_bus: TranscriptEventBus,
    pub workspace_root: std::path::PathBuf,
}

impl Orchestrator {
    fn effective_step_timeout_ms(timeout_ms: Option<u64>, config: &EnsembleConfig) -> u64 {
        timeout_ms.unwrap_or(config.agent.turn_timeout_ms)
    }

    /// Create a new Orchestrator.
    pub fn new(
        config: Arc<RwLock<EnsembleConfig>>,
        tracker: Arc<dyn IssueTracker>,
        agent_runner: Arc<dyn AgentRunner>,
        workspace_mgr: WorkspaceManager,
        config_dir: &Path,
        shutdown_rx: mpsc::Receiver<()>,
    ) -> Self {
        let (concurrency, poll_interval_ms) = {
            let config_guard = futures::executor::block_on(config.read());
            let concurrency = config_guard.concurrency.clone();
            let poll_interval_ms = config_guard.polling.interval_ms;
            (concurrency, poll_interval_ms)
        };
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            poll_interval_ms,
            &concurrency,
        )));
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
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root: config_dir.to_path_buf(),
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
            history_write_lock: Arc::new(tokio::sync::Mutex::new(())),
            history_store: futures::executor::block_on(HistoryStore::new(
                parts.workspace_root.join(".ensemble").join("history.db"),
            ))
            .map_err(|error| {
                warn!(
                    error = %error,
                    "failed to initialize sqlite history store; continuing with file persistence only"
                );
                error
            })
            .ok(),
            pipeline_journal: PipelineRunJournal::new(config_dir.to_path_buf()),
            event_bus: parts.event_bus,
            timeline_persistence: Some(TimelinePersistence::new(parts.workspace_root.clone())),
            transcript_persistence: Some(TranscriptPersistence::new_with_event_bus(
                parts.workspace_root,
                parts.transcript_event_bus,
            )),
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
        let run_id = new_run_id();
        let run_span = tracing::info_span!("ensemble_run", run_id = %run_id, mode = "orchestrator");
        let _run_guard = run_span.enter();

        // Initialize state from config
        {
            let (poll_interval_ms, max_concurrent_agents, config_clone) = {
                let config = self.config.read().await;
                (
                    config.polling.interval_ms,
                    config.concurrency.max_concurrent_agents,
                    config.clone(),
                )
            };
            let mut state = self.state.write().await;
            state.poll_interval_ms = poll_interval_ms;
            state.max_concurrent_agents = max_concurrent_agents;
            state.init_state_lists(&config_clone);
        }

        self.restore_pipeline_runs_from_journal().await;

        // Startup terminal workspace cleanup
        {
            let terminal_states = {
                let config = self.config.read().await;
                config.tracker.terminal_states.clone()
            };
            startup_terminal_cleanup(self.tracker.as_ref(), &terminal_states, &self.workspace_mgr)
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

        info!("orchestrator stopped, flushing timeline persistence");
        if let Some(mut persistence) = self.timeline_persistence.take() {
            persistence.flush().await;
        }
        info!("timeline persistence flushed");
        info!("orchestrator stopped, flushing transcript persistence");
        if let Some(mut persistence) = self.transcript_persistence.take() {
            persistence.flush().await;
        }
        info!("transcript persistence flushed");

        info!("orchestrator stopped");
    }

    /// Handle a poll tick: reconcile, validate, fetch, dispatch.
    async fn handle_tick(&self) {
        let tick_started_at = std::time::Instant::now();
        info!(event = ORCH_TICK_STARTED, "orchestrator tick started");

        // Cleanup expired completed entries
        {
            let mut state = self.state.write().await;
            state.cleanup_expired_completed();
        }

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
        self.process_waiting_interaction_commands().await;
        self.process_finalize_retries().await;

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
                            FailureRetryRequest {
                                issue_id,
                                identifier: &entry.identifier,
                                attempt: next_attempt(entry.retry_attempt),
                                max_backoff_ms: config.agent.max_retry_backoff_ms,
                                max_cycles: config.max_cycles,
                                error: "stall timeout",
                                retry_from_step: None,
                                with_fixup: false,
                            },
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
                let history_record = {
                    let mut state = self.state.write().await;
                    let running_entry = state.remove_running(&issue.id);
                    if let Some(entry) = running_entry.as_ref() {
                        state.add_runtime_seconds(entry);
                    }
                    let history_record = running_entry.as_ref().and_then(|entry| {
                        state.get_pipeline_run(&issue.id).map(|run| {
                            self.build_history_record(
                                &issue.id,
                                HISTORY_OUTCOME_STOPPED,
                                None,
                                entry,
                                run,
                                Utc::now(),
                                state.artifacts.get(&issue.id).cloned(),
                            )
                        })
                    });
                    let waiting_entry = state.waiting_on_human.get(&issue.id).cloned();
                    let identifier = waiting_entry
                        .as_ref()
                        .map(|entry| entry.identifier.clone())
                        .unwrap_or_else(|| issue.identifier.clone());
                    let interaction_request_id =
                        waiting_entry.map(|entry| entry.interaction_request_id);
                    let history_run_id = running_entry.as_ref().and_then(|e| e.run_id.clone());
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    (
                        identifier,
                        interaction_request_id,
                        history_record,
                        history_run_id,
                    )
                };
                let (identifier, interaction_request_id, history_record, history_run_id) =
                    history_record;

                self.cancel_open_interaction(interaction_request_id).await;

                if let Err(e) = self.workspace_mgr.remove_workspace(&identifier).await {
                    warn!(
                        identifier = %identifier,
                        error = %e,
                        "failed to clean terminal workspace"
                    );
                }

                if let Some(record) = history_record {
                    self.append_history_record(history_run_id.as_deref(), record)
                        .await;
                }
            }

            // Non-active: terminate without cleanup
            for issue in reconcile_result.terminate_no_cleanup {
                let result = {
                    let mut state = self.state.write().await;
                    let running_entry = state.remove_running(&issue.id);
                    if let Some(entry) = running_entry.as_ref() {
                        state.add_runtime_seconds(entry);
                    }
                    let history_record = running_entry.as_ref().and_then(|entry| {
                        state.get_pipeline_run(&issue.id).map(|run| {
                            self.build_history_record(
                                &issue.id,
                                HISTORY_OUTCOME_STOPPED,
                                None,
                                entry,
                                run,
                                Utc::now(),
                                state.artifacts.get(&issue.id).cloned(),
                            )
                        })
                    });
                    let interaction_request_id = state
                        .waiting_on_human
                        .get(&issue.id)
                        .map(|entry| entry.interaction_request_id.clone());
                    let history_run_id = running_entry.as_ref().and_then(|e| e.run_id.clone());
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    (interaction_request_id, history_record, history_run_id)
                };
                let (interaction_request_id, history_record, history_run_id) = result;

                self.cancel_open_interaction(interaction_request_id).await;

                if let Some(record) = history_record {
                    self.append_history_record(history_run_id.as_deref(), record)
                        .await;
                }
            }
        }

        // 3. Fetch candidate issues
        let mut candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(error = %e, "failed to fetch candidate issues, skipping dispatch");
                info!(
                    event = ORCH_TICK_FINISHED,
                    duration_ms = elapsed_ms(tick_started_at),
                    "orchestrator tick finished with fetch error"
                );
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

            let restored_pipeline_ready = {
                let state = self.state.read().await;
                state.get_pipeline_run(&issue.id).is_some()
                    && state.is_claimed(&issue.id)
                    && !state.is_running(&issue.id)
                    && !state.is_waiting_on_human(&issue.id)
                    && !state.retry_attempts.contains_key(&issue.id)
            };

            if eligible.is_none() || restored_pipeline_ready {
                self.dispatch_issue(issue, None).await;
            }
        }

        info!(
            event = ORCH_TICK_FINISHED,
            duration_ms = elapsed_ms(tick_started_at),
            "orchestrator tick finished"
        );
    }

    /// Dispatch a single issue: build DAG, create PipelineRun, dispatch initial steps.
    async fn dispatch_issue(&self, issue: &Issue, attempt: Option<u32>) {
        let cycle = attempt.unwrap_or(1);

        {
            let state = self.state.read().await;
            if state.get_pipeline_run(&issue.id).is_some() {
                drop(state);

                let (config_snapshot, action) = {
                    let mut state = self.state.write().await;
                    state.add_running(issue, attempt);
                    let config = state.get_pipeline_config(&issue.id).cloned();
                    let action = state
                        .get_pipeline_run_mut(&issue.id)
                        .map(|run| {
                            run.cycle = cycle;
                            run.start()
                        })
                        .unwrap_or(PipelineAction::Waiting);
                    (config, action)
                };

                let Some(config_snapshot) = config_snapshot else {
                    warn!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        "existing pipeline run has no config snapshot, skipping dispatch"
                    );
                    return;
                };

                info!(
                    event = ISSUE_DISPATCH_STARTED,
                    issue_id = %issue.id,
                    identifier = %issue.identifier,
                    cycle = cycle,
                    "resuming with existing pipeline"
                );

                match action {
                    PipelineAction::Succeeded => {
                        info!(
                            issue_id = %issue.id,
                            "restored pipeline already succeeded"
                        );
                        let finalize_state = self
                            .run_finalize_phase(&issue.id, &issue.identifier, &config_snapshot)
                            .await;
                        let completed_at = Utc::now();
                        let (history_record, history_run_id, release_run_id, should_release) = {
                            let mut state = self.state.write().await;
                            let history_record = state
                                .running
                                .get(&issue.id)
                                .zip(state.get_pipeline_run(&issue.id))
                                .map(|(entry, run)| {
                                    self.build_history_record(
                                        &issue.id,
                                        HISTORY_OUTCOME_SUCCEEDED,
                                        None,
                                        entry,
                                        run,
                                        completed_at,
                                        state.artifacts.get(&issue.id).cloned(),
                                    )
                                });
                            let running_entry = state.get_running(&issue.id).cloned();
                            let history_run_id = running_entry
                                .as_ref()
                                .and_then(|entry| entry.run_id.clone());
                            let release_run_id = history_run_id.clone();

                            if finalize_state.status == FinalizeStatus::Succeeded
                                || finalize_state.status == FinalizeStatus::NotRequired
                            {
                                state.add_completed(
                                    issue.id.clone(),
                                    issue.identifier.clone(),
                                    "completed_succeeded".to_string(),
                                );
                                if let Some(entry) = state.remove_running(&issue.id) {
                                    state.add_runtime_seconds(&entry);
                                }
                                state.release_claim(&issue.id);
                                state.remove_pipeline_run(&issue.id);
                                state.clear_finalize_state(&issue.id);
                                (history_record, history_run_id, release_run_id, true)
                            } else {
                                state.set_finalize_state(&issue.id, finalize_state);
                                state.remove_pipeline_run(&issue.id);
                                (history_record, history_run_id, release_run_id, false)
                            }
                        };

                        if should_release && self.tracker.supports_writes() {
                            if let Err(error) = self
                                .tracker
                                .set_issue_state(&issue.id, &config_snapshot.on_success)
                                .await
                            {
                                warn!(
                                    issue_id = %issue.id,
                                    error = %error,
                                    "failed to set tracker success state for restored pipeline"
                                );
                            }
                        }

                        if should_release {
                            self.append_pipeline_release(
                                &issue.id,
                                &issue.identifier,
                                release_run_id,
                                "completed",
                            )
                            .await;
                        }

                        if let Some(record) = history_record {
                            self.append_history_record(history_run_id.as_deref(), record)
                                .await;
                        }
                    }
                    PipelineAction::Dispatch(requests) => {
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
                                                FailureRetryRequest {
                                                    issue_id: &issue.id,
                                                    identifier: &entry.identifier,
                                                    attempt: next_attempt(entry.retry_attempt),
                                                    max_backoff_ms: config_snapshot
                                                        .agent
                                                        .max_retry_backoff_ms,
                                                    max_cycles: config_snapshot.max_cycles,
                                                    error: &error.to_string(),
                                                    retry_from_step: None,
                                                    with_fixup: false,
                                                },
                                            );
                                        }
                                        state.remove_pipeline_run(&issue.id);
                                        return;
                                    }
                                };

                            let step_outputs = {
                                let state = self.state.read().await;
                                state
                                    .get_pipeline_run(&issue.id)
                                    .and_then(|run| run.output_context_for(&req.step_name))
                                    .unwrap_or_default()
                            };

                            let _ = self
                                .dispatch_step(
                                    issue,
                                    Arc::clone(&config_snapshot),
                                    StepDispatchContext {
                                        step_name: &req.step_name,
                                        agent_name: &req.agent_name,
                                        step_kind: req.step_kind,
                                        tracker_state: req.tracker_state.as_deref(),
                                        attempt,
                                        timeout_ms: Self::effective_step_timeout_ms(
                                            req.timeout_ms,
                                            &config_snapshot,
                                        ),
                                        interaction_response: None,
                                        workspace_path,
                                        step_outputs,
                                    },
                                )
                                .await;
                        }
                    }
                    PipelineAction::Waiting
                    | PipelineAction::Failed { .. }
                    | PipelineAction::BlockedOnHuman { .. }
                    | PipelineAction::AwaitingApproval { .. } => {}
                }

                info!(
                    event = ISSUE_DISPATCH_COMPLETED,
                    issue_id = %issue.id,
                    identifier = %issue.identifier,
                    cycle = cycle,
                    "existing pipeline dispatch setup completed"
                );
                return;
            }
        }

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

        let pipeline_run = PipelineRun::new(issue.id.clone(), cycle, dag);
        let action = pipeline_run.start();

        info!(
            event = ISSUE_DISPATCH_STARTED,
            issue_id = %issue.id,
            identifier = %issue.identifier,
            cycle = cycle,
            "dispatching issue with pipeline"
        );

        let run_started_transition = {
            let mut state = self.state.write().await;
            state.add_running(issue, attempt);
            state.insert_pipeline_run(&issue.id, pipeline_run, Arc::clone(&config_snapshot));
            Self::transition_input_for_run(
                &state,
                &issue.id,
                &issue.identifier,
                PipelineTransitionKind::RunStarted,
                None,
                None,
                None,
            )
        };
        if let Some(input) = run_started_transition {
            self.append_pipeline_transition(input).await;
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
                                    FailureRetryRequest {
                                        issue_id: &issue.id,
                                        identifier: &entry.identifier,
                                        attempt: next_attempt(entry.retry_attempt),
                                        max_backoff_ms: config_snapshot.agent.max_retry_backoff_ms,
                                        max_cycles: config_snapshot.max_cycles,
                                        error: &error.to_string(),
                                        retry_from_step: None,
                                        with_fixup: false,
                                    },
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
                            step_kind: req.step_kind,
                            tracker_state: req.tracker_state.as_deref(),
                            attempt,
                            timeout_ms: Self::effective_step_timeout_ms(
                                req.timeout_ms,
                                &config_snapshot,
                            ),
                            interaction_response: None,
                            workspace_path,
                            step_outputs: StepOutputTemplateContext::default(),
                        },
                    )
                    .await;
            }
        }

        info!(
            event = ISSUE_DISPATCH_COMPLETED,
            issue_id = %issue.id,
            identifier = %issue.identifier,
            cycle = cycle,
            "issue dispatch setup completed"
        );
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
            event = STEP_STARTED,
            issue_id = %issue.id,
            identifier = %issue.identifier,
            step = dispatch.step_name,
            agent = dispatch.agent_name,
            "dispatching pipeline step"
        );

        // Set tracker state if specified by the step
        if let Some(state_name) = dispatch.tracker_state {
            if self.tracker.supports_writes() {
                info!(
                    event = TRACKER_TRANSITION_REQUESTED,
                    issue_id = %issue.id,
                    step = dispatch.step_name,
                    tracker_state_to = state_name,
                    "requesting tracker state transition"
                );
                match self.tracker.set_issue_state(&issue.id, state_name).await {
                    Ok(()) => {
                        info!(
                            event = TRACKER_TRANSITION_SUCCEEDED,
                            issue_id = %issue.id,
                            step = dispatch.step_name,
                            tracker_state_to = state_name,
                            "tracker state transition succeeded"
                        );
                    }
                    Err(e) => {
                        warn!(
                            event = TRACKER_TRANSITION_FAILED,
                            issue_id = %issue.id,
                            step = dispatch.step_name,
                            tracker_state_to = state_name,
                            error = %e,
                            "failed to set tracker state for step dispatch"
                        );
                    }
                }
            }
        }

        // Mark step as running in pipeline
        let (run_id, sequence, attempt_num, step_running_transition) = {
            let mut state = self.state.write().await;
            let run_context = Self::run_context_for_issue(&mut state, &issue.id);
            {
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
            let transition = Self::transition_input_for_run(
                &state,
                &issue.id,
                &issue.identifier,
                PipelineTransitionKind::StepRunning,
                Some(dispatch.step_name.to_string()),
                None,
                None,
            );
            (run_context.0, run_context.1, run_context.2, transition)
        };

        if let Some(input) = step_running_transition {
            self.append_pipeline_transition(input).await;
        }

        self.publish_pipeline_event(
            run_id,
            sequence,
            attempt_num,
            PipelineEvent::StepStarted {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: dispatch.step_name.to_string(),
                agent_name: dispatch.agent_name.to_string(),
                detail: format!("step started (attempt {})", attempt_num),
            },
        )
        .await;

        // Spawn worker task
        let issue_clone = issue.clone();
        let step_name_owned = dispatch.step_name.to_string();
        let agent_name_owned = dispatch.agent_name.to_string();
        let interaction_response = dispatch.interaction_response.clone();
        let runner = Arc::clone(&self.agent_runner);
        let event_tx = self.worker_tx.clone();
        let workspace_path = dispatch.workspace_path.clone();
        let attempt = dispatch.attempt;
        let timeout_ms = dispatch.timeout_ms;
        let step_outputs = dispatch.step_outputs.clone();
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
                    step_kind: dispatch.step_kind,
                    attempt,
                    timeout_ms,
                    interaction_response: interaction_response.clone(),
                    workspace_path: &workspace_path,
                    event_tx: event_tx.clone(),
                    cancel_token,
                    step_outputs,
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
        step_name: &str,
        event: AgentEvent,
        timestamp: chrono::DateTime<Utc>,
    ) {
        let mut state = self.state.write().await;
        let issue_identifier = state
            .running
            .get(issue_id)
            .map(|entry| entry.identifier.clone())
            .unwrap_or_else(|| issue_id.to_string());
        let (run_id, attempt_num) = Self::run_metadata_for_issue(&state, issue_id);
        let transcript_request = match &event {
            AgentEvent::TranscriptBlock { kind, payload } => {
                run_id.as_ref().map(|run_id| TranscriptPersistRequest {
                    run_id: run_id.clone(),
                    issue_identifier: issue_identifier.clone(),
                    step_name: step_name.to_string(),
                    attempt: attempt_num,
                    timestamp,
                    kind: transcript_kind_from_agent_kind(*kind),
                    payload: payload.clone(),
                    truncated: None,
                })
            }
            _ => None,
        };
        let flush_transcript_step = matches!(
            &event,
            AgentEvent::RunCompleted { .. }
                | AgentEvent::RunFailed { .. }
                | AgentEvent::TurnCompleted { .. }
                | AgentEvent::TurnFailed { .. }
                | AgentEvent::Cancelled { .. }
        )
        .then(|| {
            run_id
                .as_ref()
                .map(|run_id| (run_id.clone(), step_name.to_string()))
        })
        .flatten();
        let mut pipeline_event: Option<PipelineEvent> = None;

        // Handle special cases
        match &event {
            AgentEvent::SessionStarted {
                session_id,
                agent_pid,
            } => {
                state.update_session_info(issue_id, session_id, agent_pid.as_deref());
                pipeline_event = Some(PipelineEvent::SessionStarted {
                    issue_identifier: issue_identifier.clone(),
                    timestamp,
                    detail: format!("session started: {}", session_id),
                });
            }
            AgentEvent::PromptStarted => {
                state.increment_turn_count(issue_id);
            }
            AgentEvent::RunCompleted { usage: Some(u) } => {
                state.update_token_usage(issue_id, u.input_tokens, u.output_tokens, u.total_tokens);
            }
            AgentEvent::RunCompleted { usage: None } => {}
            AgentEvent::TurnCompleted { usage } => {
                pipeline_event = Some(PipelineEvent::TurnCompleted {
                    issue_identifier: issue_identifier.clone(),
                    timestamp,
                    turn: state
                        .running
                        .get(issue_id)
                        .map(|e| e.turn_count)
                        .unwrap_or(0),
                    detail: format!("turn completed (attempt {})", attempt_num),
                    conversation_index: None,
                    tokens_delta: crate::observability::events::TokensDelta {
                        input: usage.as_ref().map(|u| u.input_tokens).unwrap_or(0),
                        output: usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                    },
                });
            }
            AgentEvent::RunFailed { reason, usage, .. } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
                pipeline_event = Some(PipelineEvent::Error {
                    issue_identifier: issue_identifier.clone(),
                    timestamp,
                    detail: reason.clone(),
                });
            }
            AgentEvent::OutputChunk { content, .. } => {
                pipeline_event = Some(PipelineEvent::Output {
                    issue_identifier: issue_identifier.clone(),
                    timestamp,
                    step_name: step_name.to_string(),
                    detail: content.chars().take(120).collect(),
                });
            }
            _ => {}
        }

        let sequence = pipeline_event
            .as_ref()
            .and(run_id.as_ref())
            .map(|run_id| state.next_timeline_sequence(run_id));

        // Common path: update agent event
        state.update_agent_event(
            issue_id,
            event.event_name(),
            event.message_for_state().as_deref(),
            timestamp,
        );
        drop(state);

        if let Some(request) = transcript_request {
            if let Some(ref persistence) = self.transcript_persistence {
                persistence.send(request);
            }
        }
        if let Some((run_id, step_name)) = flush_transcript_step {
            if let Some(ref persistence) = self.transcript_persistence {
                persistence.flush_step(run_id, step_name);
            }
        }

        if let Some(event) = pipeline_event {
            self.publish_pipeline_event(run_id, sequence, attempt_num, event)
                .await;
        }
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
            WorkerResult::Success {
                output,
                approval_request,
            } => {
                let config = self.config.read().await;
                info!(
                    issue_id = %issue_id,
                    step = step_name,
                    "worker exited successfully"
                );

                let mut state = self.state.write().await;

                let resolved_output = output;
                let verdict_value = match &resolved_output.result {
                    StepResult::Succeeded => "succeeded",
                    StepResult::Failed { .. } => "failed",
                    StepResult::Concern { .. } => "concern",
                };
                info!(
                    issue_id = %issue_id,
                    step = step_name,
                    verdict_value,
                    "received validated step result"
                );

                // Drive the pipeline
                let pipeline_action = if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    Some((
                        run.step_completed(step_name, resolved_output, approval_request.is_some()),
                        state.get_pipeline_config(issue_id).cloned(),
                    ))
                } else {
                    warn!(issue_id = %issue_id, "no pipeline run found for worker exit");
                    None
                };

                if let Some((action, config_snapshot)) = pipeline_action {
                    let step_transition = Self::transition_input_for_run(
                        &state,
                        issue_id,
                        issue_snapshot
                            .as_ref()
                            .map(|issue| issue.identifier.as_str())
                            .unwrap_or(issue_id),
                        Self::transition_kind_for_action(&action),
                        Some(step_name.to_string()),
                        Some(verdict_value.to_string()),
                        None,
                    );
                    match action {
                        PipelineAction::Dispatch(requests) => {
                            // Collect output contexts while state lock is still held
                            let dispatch_contexts: Vec<(
                                DispatchRequest,
                                StepOutputTemplateContext,
                            )> = {
                                let run = state.get_pipeline_run(issue_id);
                                requests
                                    .into_iter()
                                    .map(|req| {
                                        let step_outputs = run
                                            .and_then(|r| r.output_context_for(&req.step_name))
                                            .unwrap_or_default();
                                        (req, step_outputs)
                                    })
                                    .collect()
                            };
                            // Need to drop state lock before dispatching
                            drop(state);
                            if let Some(input) = step_transition {
                                self.append_pipeline_transition(input).await;
                            }
                            if let Some(ref issue) = issue_snapshot {
                                let Some(config_snapshot) = config_snapshot else {
                                    warn!(issue_id = %issue_id, "no config snapshot found for pipeline dispatch");
                                    return;
                                };
                                for (req, step_outputs) in dispatch_contexts {
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
                                                    FailureRetryRequest {
                                                        issue_id,
                                                        identifier: &entry.identifier,
                                                        attempt: next_attempt(entry.retry_attempt),
                                                        max_backoff_ms: config_snapshot
                                                            .agent
                                                            .max_retry_backoff_ms,
                                                        max_cycles: config_snapshot.max_cycles,
                                                        error: &error.to_string(),
                                                        retry_from_step: None,
                                                        with_fixup: false,
                                                    },
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
                                                step_kind: req.step_kind,
                                                tracker_state: req.tracker_state.as_deref(),
                                                attempt: None,
                                                timeout_ms: Self::effective_step_timeout_ms(
                                                    req.timeout_ms,
                                                    &config_snapshot,
                                                ),
                                                interaction_response: None,
                                                workspace_path,
                                                step_outputs,
                                            },
                                        )
                                        .await;
                                }
                            }
                        }
                        PipelineAction::Succeeded => {
                            info!(issue_id = %issue_id, "pipeline succeeded");
                            let issue_identifier = issue_snapshot
                                .as_ref()
                                .map(|issue| issue.identifier.clone())
                                .unwrap_or_else(|| issue_id.to_string());
                            let finalize_state = self
                                .run_finalize_phase(issue_id, &issue_identifier, &config)
                                .await;

                            let completed_at = Utc::now();
                            let history_record = state
                                .running
                                .get(issue_id)
                                .zip(state.get_pipeline_run(issue_id))
                                .map(|(entry, run)| {
                                    self.build_history_record(
                                        issue_id,
                                        HISTORY_OUTCOME_SUCCEEDED,
                                        None,
                                        entry,
                                        run,
                                        completed_at,
                                        state.artifacts.get(issue_id).cloned(),
                                    )
                                });

                            // Get running entry data before removing
                            let running_entry = state.get_running(issue_id).cloned();

                            if finalize_state.status == FinalizeStatus::Succeeded
                                || finalize_state.status == FinalizeStatus::NotRequired
                            {
                                // Add to completed BEFORE removing from running
                                if let Some(ref entry) = running_entry {
                                    state.add_completed(
                                        issue_id.to_string(),
                                        entry.identifier.clone(),
                                        "completed_succeeded".to_string(),
                                    );
                                }

                                if self.tracker.supports_writes() {
                                    if let Err(e) = self
                                        .tracker
                                        .set_issue_state(issue_id, &config.on_success)
                                        .await
                                    {
                                        warn!(issue_id = %issue_id, error = %e, "failed to set tracker success state");
                                    }
                                }
                                state.release_claim(issue_id);
                                state.remove_pipeline_run(issue_id);

                                // Now remove from running and add runtime seconds
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
                                let release_run_id = history_run_id.clone();
                                drop(state);
                                if let Some(input) = step_transition {
                                    self.append_pipeline_transition(input).await;
                                }
                                self.append_pipeline_release(
                                    issue_id,
                                    &release_identifier,
                                    release_run_id,
                                    "completed",
                                )
                                .await;
                                if let Some(record) = history_record {
                                    self.append_history_record(history_run_id.as_deref(), record)
                                        .await;
                                }
                            } else {
                                if self.tracker.supports_writes()
                                    && matches!(
                                        finalize_state.status,
                                        FinalizeStatus::Failed | FinalizeStatus::SkippedHeadless
                                    )
                                {
                                    if let Err(e) = self
                                        .tracker
                                        .set_issue_state(issue_id, &config.on_failure)
                                        .await
                                    {
                                        warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state after finalize failure");
                                    }
                                }
                                state.set_finalize_state(issue_id, finalize_state);
                                state.remove_pipeline_run(issue_id);
                            }
                        }
                        PipelineAction::Failed { step, reason } => {
                            warn!(
                                issue_id = %issue_id,
                                step = %step,
                                reason = %reason,
                                "pipeline failed"
                            );
                            let completed_at = Utc::now();
                            let mut final_failure = false;
                            let mut history_record = None;
                            let mut completed_identifier = None;
                            let mut rejection_comment = None;
                            let mut history_run_id = None;
                            let mut post_failure_transitions = Vec::new();
                            if let Some(input) = step_transition {
                                post_failure_transitions.push(input);
                            }
                            let runtime_step = state
                                .get_pipeline_run(issue_id)
                                .and_then(|run| run.step(&step))
                                .cloned();
                            let step_config = config.steps.iter().find(|s| s.name == step);
                            let on_failure = runtime_step
                                .as_ref()
                                .map(|s| s.on_failure)
                                .or_else(|| step_config.map(|s| s.on_failure))
                                .unwrap_or_default();
                            match on_failure {
                                OnFailure::RetryStep => {
                                    if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                                        run.retry_from_step(&step);
                                    }
                                    if let Some(entry) = state.remove_running(issue_id) {
                                        state.add_runtime_seconds(&entry);
                                        completed_identifier = Some(entry.identifier.clone());
                                        history_run_id = entry.run_id.clone();
                                        let attempt = next_attempt(entry.retry_attempt);
                                        let retry_scheduled = schedule_failure_retry(
                                            &mut state,
                                            FailureRetryRequest {
                                                issue_id,
                                                identifier: &entry.identifier,
                                                attempt,
                                                max_backoff_ms: config.agent.max_retry_backoff_ms,
                                                max_cycles: config.max_cycles,
                                                error: &reason,
                                                retry_from_step: Some(step.clone()),
                                                with_fixup: false,
                                            },
                                        );
                                        final_failure = retry_scheduled.is_none();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        issue_id,
                                                        HISTORY_OUTCOME_FAILED,
                                                        Some(reason.clone()),
                                                        &entry,
                                                        run,
                                                        completed_at,
                                                        state.artifacts.get(issue_id).cloned(),
                                                    )
                                                });
                                        }
                                        if retry_scheduled.is_none()
                                            && self.tracker.supports_writes()
                                        {
                                            if let Err(e) = self
                                                .tracker
                                                .set_issue_state(issue_id, &config.on_failure)
                                                .await
                                            {
                                                warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                                            }
                                        }
                                        if let Some(due_at_ms) = retry_scheduled {
                                            if let Some(input) = Self::transition_input_for_run(
                                                &state,
                                                issue_id,
                                                &entry.identifier,
                                                PipelineTransitionKind::StepRetryScheduled,
                                                Some(step.clone()),
                                                Some(reason.clone()),
                                                Some(RetryEntry {
                                                    issue_id: issue_id.to_string(),
                                                    identifier: entry.identifier.clone(),
                                                    attempt,
                                                    due_at_ms,
                                                    error: Some(reason.clone()),
                                                    retry_from_step: Some(step.clone()),
                                                    with_fixup: false,
                                                }),
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        } else if let Some(input) = Self::transition_input_for_run(
                                            &state,
                                            issue_id,
                                            &entry.identifier,
                                            PipelineTransitionKind::PipelineFailed,
                                            Some(step.clone()),
                                            Some(reason.clone()),
                                            None,
                                        ) {
                                            post_failure_transitions.push(input);
                                        }
                                    }
                                }
                                OnFailure::Fixup => {
                                    let fixup_agent = runtime_step
                                        .as_ref()
                                        .and_then(|s| s.fixup_agent.as_deref())
                                        .or_else(|| {
                                            step_config.and_then(|s| s.fixup_agent.as_deref())
                                        });
                                    let Some(fixup_agent) = fixup_agent else {
                                        error!(
                                            issue_id = %issue_id,
                                            step = %step,
                                            "fixup step missing fixup_agent after config validation"
                                        );
                                        if let Some(entry) = state.remove_running(issue_id) {
                                            state.add_runtime_seconds(&entry);
                                        }
                                        state.remove_pipeline_run(issue_id);
                                        return;
                                    };

                                    if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                                        run.retry_from_step_with_fixup(&step, fixup_agent);
                                    }
                                    if let Some(entry) = state.remove_running(issue_id) {
                                        state.add_runtime_seconds(&entry);
                                        completed_identifier = Some(entry.identifier.clone());
                                        history_run_id = entry.run_id.clone();
                                        let attempt = next_attempt(entry.retry_attempt);
                                        let retry_scheduled = schedule_failure_retry(
                                            &mut state,
                                            FailureRetryRequest {
                                                issue_id,
                                                identifier: &entry.identifier,
                                                attempt,
                                                max_backoff_ms: config.agent.max_retry_backoff_ms,
                                                max_cycles: config.max_cycles,
                                                error: &reason,
                                                retry_from_step: Some(step.clone()),
                                                with_fixup: true,
                                            },
                                        );
                                        final_failure = retry_scheduled.is_none();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        issue_id,
                                                        HISTORY_OUTCOME_FAILED,
                                                        Some(reason.clone()),
                                                        &entry,
                                                        run,
                                                        completed_at,
                                                        state.artifacts.get(issue_id).cloned(),
                                                    )
                                                });
                                        }
                                        if retry_scheduled.is_none()
                                            && self.tracker.supports_writes()
                                        {
                                            if let Err(e) = self
                                                .tracker
                                                .set_issue_state(issue_id, &config.on_failure)
                                                .await
                                            {
                                                warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                                            }
                                        }
                                        if let Some(due_at_ms) = retry_scheduled {
                                            if let Some(input) = Self::transition_input_for_run(
                                                &state,
                                                issue_id,
                                                &entry.identifier,
                                                PipelineTransitionKind::FixupRetryScheduled,
                                                Some(step.clone()),
                                                Some(reason.clone()),
                                                Some(RetryEntry {
                                                    issue_id: issue_id.to_string(),
                                                    identifier: entry.identifier.clone(),
                                                    attempt,
                                                    due_at_ms,
                                                    error: Some(reason.clone()),
                                                    retry_from_step: Some(step.clone()),
                                                    with_fixup: true,
                                                }),
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        } else if let Some(input) = Self::transition_input_for_run(
                                            &state,
                                            issue_id,
                                            &entry.identifier,
                                            PipelineTransitionKind::PipelineFailed,
                                            Some(step.clone()),
                                            Some(reason.clone()),
                                            None,
                                        ) {
                                            post_failure_transitions.push(input);
                                        }
                                    }
                                }
                                OnFailure::Halt => {
                                    warn!(
                                        issue_id = %issue_id,
                                        step = %step,
                                        reason = %reason,
                                        "pipeline halted, waiting for manual intervention"
                                    );
                                    if let Some(entry) = state.remove_running(issue_id) {
                                        state.add_runtime_seconds(&entry);
                                        let agent_name = runtime_step
                                            .as_ref()
                                            .map(|s| s.agent.clone())
                                            .or_else(|| step_config.map(|s| s.agent.clone()))
                                            .unwrap_or_default();
                                        state.add_waiting_on_human(WaitingOnHumanEntry {
                                            issue_id: issue_id.to_string(),
                                            identifier: entry.identifier.clone(),
                                            interaction_request_id: format!(
                                                "halted:{issue_id}:{step}"
                                            ),
                                            step_name: step.clone(),
                                            kind: InteractionKind::Handoff,
                                            prompt: reason.clone(),
                                            agent_name,
                                            retry_attempt: entry.retry_attempt,
                                            started_at: Some(entry.started_at),
                                            agent_input_tokens: entry.agent_input_tokens,
                                            agent_output_tokens: entry.agent_output_tokens,
                                            agent_total_tokens: entry.agent_total_tokens,
                                            requested_at: Utc::now(),
                                            run_id: entry.run_id.clone(),
                                            issue: Some(entry.issue.clone()),
                                        });
                                        if let Some(input) = Self::transition_input_for_run(
                                            &state,
                                            issue_id,
                                            &entry.identifier,
                                            PipelineTransitionKind::PipelineHalted,
                                            Some(step.clone()),
                                            Some(reason.clone()),
                                            None,
                                        ) {
                                            post_failure_transitions.push(input);
                                        }
                                    }
                                }
                                OnFailure::RetryIssue => {
                                    if let Some(entry) = state.remove_running(issue_id) {
                                        state.add_runtime_seconds(&entry);
                                        completed_identifier = Some(entry.identifier.clone());
                                        history_run_id = entry.run_id.clone();
                                        let attempt = next_attempt(entry.retry_attempt);
                                        let retry_scheduled = schedule_failure_retry(
                                            &mut state,
                                            FailureRetryRequest {
                                                issue_id,
                                                identifier: &entry.identifier,
                                                attempt,
                                                max_backoff_ms: config.agent.max_retry_backoff_ms,
                                                max_cycles: config.max_cycles,
                                                error: &reason,
                                                retry_from_step: None,
                                                with_fixup: false,
                                            },
                                        );
                                        final_failure = retry_scheduled.is_none();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        issue_id,
                                                        HISTORY_OUTCOME_FAILED,
                                                        Some(reason.clone()),
                                                        &entry,
                                                        run,
                                                        completed_at,
                                                        state.artifacts.get(issue_id).cloned(),
                                                    )
                                                });
                                        }
                                        if retry_scheduled.is_none()
                                            && self.tracker.supports_writes()
                                        {
                                            if let Err(e) = self
                                                .tracker
                                                .set_issue_state(issue_id, &config.on_failure)
                                                .await
                                            {
                                                warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                                            }
                                        }
                                        if final_failure {
                                            if let Some(input) = Self::transition_input_for_run(
                                                &state,
                                                issue_id,
                                                &entry.identifier,
                                                PipelineTransitionKind::PipelineFailed,
                                                Some(step.clone()),
                                                Some(reason.clone()),
                                                None,
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        }
                                    }
                                    state.remove_pipeline_run(issue_id);
                                }
                            }
                            if final_failure {
                                if let Some(identifier) = completed_identifier {
                                    state.add_completed(
                                        issue_id.to_string(),
                                        identifier,
                                        "completed_failed".to_string(),
                                    );
                                }
                            }

                            drop(state);
                            for input in post_failure_transitions {
                                self.append_pipeline_transition(input).await;
                            }
                            if final_failure {
                                if let Some((step_name, summary)) = rejection_comment {
                                    self.post_rejection_summary_comment(
                                        issue_id, &step_name, &summary,
                                    )
                                    .await;
                                }
                                if let Some(record) = history_record {
                                    self.append_history_record(history_run_id.as_deref(), record)
                                        .await;
                                }
                            }
                        }
                        PipelineAction::BlockedOnHuman { .. } => {}
                        PipelineAction::AwaitingApproval {
                            step,
                            approval_state,
                        } => {
                            drop(state);
                            if let Some(input) = step_transition {
                                self.append_pipeline_transition(input).await;
                            }
                            if let Err(error) = self
                                .handle_post_step_approval(
                                    issue_id,
                                    &step,
                                    approval_state,
                                    approval_request.as_ref(),
                                    issue_snapshot.as_ref(),
                                )
                                .await
                            {
                                warn!(
                                    issue_id = %issue_id,
                                    step = %step,
                                    error = %error,
                                    "failed to create post-step approval checkpoint"
                                );

                                let mut state = self.state.write().await;
                                if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                                    run.step_failed(&step, error.to_string());
                                }
                                if let Some(entry) = state.remove_running(issue_id) {
                                    state.add_runtime_seconds(&entry);
                                    schedule_failure_retry(
                                        &mut state,
                                        FailureRetryRequest {
                                            issue_id,
                                            identifier: &entry.identifier,
                                            attempt: next_attempt(entry.retry_attempt),
                                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                                            max_cycles: config.max_cycles,
                                            error: &error.to_string(),
                                            retry_from_step: None,
                                            with_fixup: false,
                                        },
                                    );
                                }
                                state.remove_pipeline_run(issue_id);
                            }
                        }
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
                            drop(state);
                            if let Some(input) = step_transition {
                                self.append_pipeline_transition(input).await;
                            }
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
                            FailureRetryRequest {
                                issue_id,
                                identifier: &entry.identifier,
                                attempt: next_attempt(entry.retry_attempt),
                                max_backoff_ms: config.agent.max_retry_backoff_ms,
                                max_cycles: config.max_cycles,
                                error: &error.to_string(),
                                retry_from_step: None,
                                with_fixup: false,
                            },
                        );
                    }
                    state.remove_pipeline_run(issue_id);
                }
            }
            WorkerResult::Failed { error, kind } => {
                if kind == WorkerFailureKind::Timeout {
                    warn!(
                        issue_id = %issue_id,
                        step = step_name,
                        error = %error,
                        "worker exited with timeout"
                    );
                    self.handle_pipeline_step_failure(issue_id, step_name, error)
                        .await;
                    return;
                }

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

                let completed_at = Utc::now();
                let mut final_failure = false;
                let mut history_record = None;
                let mut completed_identifier = None;
                let mut history_run_id = None;

                if let Some(entry) = state.remove_running(issue_id) {
                    completed_identifier = Some(entry.identifier.clone());
                    history_run_id = entry.run_id.clone();
                    state.add_runtime_seconds(&entry);
                    let retry_scheduled = schedule_failure_retry(
                        &mut state,
                        FailureRetryRequest {
                            issue_id,
                            identifier: &entry.identifier,
                            attempt: next_attempt(entry.retry_attempt),
                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                            max_cycles: config.max_cycles,
                            error: &error,
                            retry_from_step: None,
                            with_fixup: false,
                        },
                    );
                    final_failure = retry_scheduled.is_none();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            self.build_history_record(
                                issue_id,
                                HISTORY_OUTCOME_FAILED,
                                Some(error.clone()),
                                &entry,
                                run,
                                completed_at,
                                state.artifacts.get(issue_id).cloned(),
                            )
                        });
                    }
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
                if final_failure {
                    if let Some(identifier) = completed_identifier {
                        state.add_completed(
                            issue_id.to_string(),
                            identifier,
                            "completed_failed".to_string(),
                        );
                    }
                }

                drop(state);
                if final_failure {
                    if let Some(record) = history_record {
                        self.append_history_record(history_run_id.as_deref(), record)
                            .await;
                    }
                }
            }
        }
    }

    async fn handle_pipeline_step_failure(&self, issue_id: &str, step: &str, reason: String) {
        let config = self.config.read().await;
        let mut state = self.state.write().await;

        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.step_failed(step, reason.clone());
        }

        let step_failed_transition = Self::transition_input_for_run(
            &state,
            issue_id,
            state
                .running
                .get(issue_id)
                .map(|entry| entry.identifier.as_str())
                .unwrap_or(issue_id),
            PipelineTransitionKind::StepFailed,
            Some(step.to_string()),
            Some(reason.clone()),
            None,
        );
        let completed_at = Utc::now();
        let mut final_failure = false;
        let mut history_record = None;
        let mut completed_identifier = None;
        let mut rejection_comment = None;
        let mut history_run_id = None;
        let mut post_failure_transitions = Vec::new();
        if let Some(input) = step_failed_transition {
            post_failure_transitions.push(input);
        }
        let step_name = step.to_string();
        let runtime_step = state
            .get_pipeline_run(issue_id)
            .and_then(|run| run.step(step))
            .cloned();
        let step_config = config.steps.iter().find(|s| s.name == step);
        let on_failure = runtime_step
            .as_ref()
            .map(|s| s.on_failure)
            .or_else(|| step_config.map(|s| s.on_failure))
            .unwrap_or_default();

        match on_failure {
            OnFailure::RetryStep => {
                if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    run.retry_from_step(step);
                }
                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    completed_identifier = Some(entry.identifier.clone());
                    history_run_id = entry.run_id.clone();
                    let attempt = next_attempt(entry.retry_attempt);
                    let retry_scheduled = schedule_failure_retry(
                        &mut state,
                        FailureRetryRequest {
                            issue_id,
                            identifier: &entry.identifier,
                            attempt,
                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                            max_cycles: config.max_cycles,
                            error: &reason,
                            retry_from_step: Some(step_name.clone()),
                            with_fixup: false,
                        },
                    );
                    final_failure = retry_scheduled.is_none();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(
                                issue_id,
                                HISTORY_OUTCOME_FAILED,
                                Some(reason.clone()),
                                &entry,
                                run,
                                completed_at,
                                state.artifacts.get(issue_id).cloned(),
                            )
                        });
                    }
                    if retry_scheduled.is_none() && self.tracker.supports_writes() {
                        if let Err(e) = self
                            .tracker
                            .set_issue_state(issue_id, &config.on_failure)
                            .await
                        {
                            warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                        }
                    }
                    if let Some(due_at_ms) = retry_scheduled {
                        if let Some(input) = Self::transition_input_for_run(
                            &state,
                            issue_id,
                            &entry.identifier,
                            PipelineTransitionKind::StepRetryScheduled,
                            Some(step_name.clone()),
                            Some(reason.clone()),
                            Some(RetryEntry {
                                issue_id: issue_id.to_string(),
                                identifier: entry.identifier.clone(),
                                attempt,
                                due_at_ms,
                                error: Some(reason.clone()),
                                retry_from_step: Some(step_name.clone()),
                                with_fixup: false,
                            }),
                        ) {
                            post_failure_transitions.push(input);
                        }
                    } else if let Some(input) = Self::transition_input_for_run(
                        &state,
                        issue_id,
                        &entry.identifier,
                        PipelineTransitionKind::PipelineFailed,
                        Some(step_name.clone()),
                        Some(reason.clone()),
                        None,
                    ) {
                        post_failure_transitions.push(input);
                    }
                }
            }
            OnFailure::Fixup => {
                let fixup_agent = runtime_step
                    .as_ref()
                    .and_then(|s| s.fixup_agent.as_deref())
                    .or_else(|| step_config.and_then(|s| s.fixup_agent.as_deref()));
                let Some(fixup_agent) = fixup_agent else {
                    error!(
                        issue_id = %issue_id,
                        step = %step,
                        "fixup step missing fixup_agent after config validation"
                    );
                    if let Some(entry) = state.remove_running(issue_id) {
                        state.add_runtime_seconds(&entry);
                    }
                    state.remove_pipeline_run(issue_id);
                    return;
                };

                if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    run.retry_from_step_with_fixup(step, fixup_agent);
                }
                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    completed_identifier = Some(entry.identifier.clone());
                    history_run_id = entry.run_id.clone();
                    let attempt = next_attempt(entry.retry_attempt);
                    let retry_scheduled = schedule_failure_retry(
                        &mut state,
                        FailureRetryRequest {
                            issue_id,
                            identifier: &entry.identifier,
                            attempt,
                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                            max_cycles: config.max_cycles,
                            error: &reason,
                            retry_from_step: Some(step_name.clone()),
                            with_fixup: true,
                        },
                    );
                    final_failure = retry_scheduled.is_none();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(
                                issue_id,
                                HISTORY_OUTCOME_FAILED,
                                Some(reason.clone()),
                                &entry,
                                run,
                                completed_at,
                                state.artifacts.get(issue_id).cloned(),
                            )
                        });
                    }
                    if retry_scheduled.is_none() && self.tracker.supports_writes() {
                        if let Err(e) = self
                            .tracker
                            .set_issue_state(issue_id, &config.on_failure)
                            .await
                        {
                            warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                        }
                    }
                    if let Some(due_at_ms) = retry_scheduled {
                        if let Some(input) = Self::transition_input_for_run(
                            &state,
                            issue_id,
                            &entry.identifier,
                            PipelineTransitionKind::FixupRetryScheduled,
                            Some(step_name.clone()),
                            Some(reason.clone()),
                            Some(RetryEntry {
                                issue_id: issue_id.to_string(),
                                identifier: entry.identifier.clone(),
                                attempt,
                                due_at_ms,
                                error: Some(reason.clone()),
                                retry_from_step: Some(step_name.clone()),
                                with_fixup: true,
                            }),
                        ) {
                            post_failure_transitions.push(input);
                        }
                    } else if let Some(input) = Self::transition_input_for_run(
                        &state,
                        issue_id,
                        &entry.identifier,
                        PipelineTransitionKind::PipelineFailed,
                        Some(step_name.clone()),
                        Some(reason.clone()),
                        None,
                    ) {
                        post_failure_transitions.push(input);
                    }
                }
            }
            OnFailure::Halt => {
                warn!(
                    issue_id = %issue_id,
                    step = %step,
                    reason = %reason,
                    "pipeline halted, waiting for manual intervention"
                );
                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    let agent_name = runtime_step
                        .as_ref()
                        .map(|s| s.agent.clone())
                        .or_else(|| step_config.map(|s| s.agent.clone()))
                        .unwrap_or_default();
                    state.add_waiting_on_human(WaitingOnHumanEntry {
                        issue_id: issue_id.to_string(),
                        identifier: entry.identifier.clone(),
                        interaction_request_id: format!("halted:{issue_id}:{step}"),
                        step_name: step_name.clone(),
                        kind: InteractionKind::Handoff,
                        prompt: reason.clone(),
                        agent_name,
                        retry_attempt: entry.retry_attempt,
                        started_at: Some(entry.started_at),
                        agent_input_tokens: entry.agent_input_tokens,
                        agent_output_tokens: entry.agent_output_tokens,
                        agent_total_tokens: entry.agent_total_tokens,
                        requested_at: Utc::now(),
                        run_id: entry.run_id.clone(),
                        issue: Some(entry.issue.clone()),
                    });
                    if let Some(input) = Self::transition_input_for_run(
                        &state,
                        issue_id,
                        &entry.identifier,
                        PipelineTransitionKind::PipelineHalted,
                        Some(step_name.clone()),
                        Some(reason.clone()),
                        None,
                    ) {
                        post_failure_transitions.push(input);
                    }
                }
            }
            OnFailure::RetryIssue => {
                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    completed_identifier = Some(entry.identifier.clone());
                    history_run_id = entry.run_id.clone();
                    let attempt = next_attempt(entry.retry_attempt);
                    let retry_scheduled = schedule_failure_retry(
                        &mut state,
                        FailureRetryRequest {
                            issue_id,
                            identifier: &entry.identifier,
                            attempt,
                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                            max_cycles: config.max_cycles,
                            error: &reason,
                            retry_from_step: None,
                            with_fixup: false,
                        },
                    );
                    final_failure = retry_scheduled.is_none();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(
                                issue_id,
                                HISTORY_OUTCOME_FAILED,
                                Some(reason.clone()),
                                &entry,
                                run,
                                completed_at,
                                state.artifacts.get(issue_id).cloned(),
                            )
                        });
                    }
                    if retry_scheduled.is_none() && self.tracker.supports_writes() {
                        if let Err(e) = self
                            .tracker
                            .set_issue_state(issue_id, &config.on_failure)
                            .await
                        {
                            warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                        }
                    }
                    if final_failure {
                        if let Some(input) = Self::transition_input_for_run(
                            &state,
                            issue_id,
                            &entry.identifier,
                            PipelineTransitionKind::PipelineFailed,
                            Some(step_name.clone()),
                            Some(reason.clone()),
                            None,
                        ) {
                            post_failure_transitions.push(input);
                        }
                    }
                }
                state.remove_pipeline_run(issue_id);
            }
        }

        if final_failure {
            if let Some(identifier) = completed_identifier {
                state.add_completed(
                    issue_id.to_string(),
                    identifier,
                    "completed_failed".to_string(),
                );
            }
        }

        drop(state);
        for input in post_failure_transitions {
            self.append_pipeline_transition(input).await;
        }
        if final_failure {
            if let Some((step_name, summary)) = rejection_comment {
                self.post_rejection_summary_comment(issue_id, &step_name, &summary)
                    .await;
            }
            if let Some(record) = history_record {
                self.append_history_record(history_run_id.as_deref(), record)
                    .await;
            }
        }
    }

    fn rejection_comment_for_step(run: &PipelineRun, step_name: &str) -> Option<(String, String)> {
        match run.step_states.get(step_name) {
            Some(StepState::Failed { summary }) if !summary.trim().is_empty() => {
                Some((step_name.to_string(), summary.trim().to_string()))
            }
            _ => None,
        }
    }

    async fn post_rejection_summary_comment(&self, issue_id: &str, step_name: &str, summary: &str) {
        let body = format!("{REJECTION_COMMENT_PREFIX} at step `{step_name}`:\n\n{summary}");
        match self.tracker.add_comment(issue_id, &body).await {
            Ok(()) => {
                info!(
                    issue_id = %issue_id,
                    step = %step_name,
                    "posted rejection summary to tracker"
                );
            }
            Err(crate::tracker::TrackerError::WritesNotSupported) => {
                debug!(
                    issue_id = %issue_id,
                    step = %step_name,
                    "tracker does not support rejection summary comments"
                );
            }
            Err(error) => {
                warn!(
                    issue_id = %issue_id,
                    step = %step_name,
                    error = %error,
                    "failed to post rejection summary to tracker"
                );
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
        let missing_blocked_issue_value = |value: &str| AgentError::PromptError {
            reason: format!("missing {value} for blocked issue {issue_id}"),
        };

        let issue =
            issue_snapshot.ok_or_else(|| missing_blocked_issue_value("running issue snapshot"))?;

        let interaction_context = {
            let state = self.state.read().await;
            let config = state
                .get_pipeline_config(issue_id)
                .ok_or_else(|| missing_blocked_issue_value("pipeline config"))?;
            let step = config
                .steps
                .iter()
                .find(|step| step.name == step_name)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!("blocked step '{step_name}' no longer exists"),
                })?;
            let run = state
                .get_pipeline_run(issue_id)
                .ok_or_else(|| missing_blocked_issue_value("pipeline run"))?;
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

        let (waiting_started_at, waiting_input_tokens, waiting_output_tokens, waiting_total_tokens) = {
            let state = self.state.read().await;
            let running_entry = state.running.get(issue_id);
            (
                running_entry.map(|entry| entry.started_at),
                running_entry
                    .map(|entry| entry.agent_input_tokens)
                    .unwrap_or(0),
                running_entry
                    .map(|entry| entry.agent_output_tokens)
                    .unwrap_or(0),
                running_entry
                    .map(|entry| entry.agent_total_tokens)
                    .unwrap_or(0),
            )
        };

        let mut interaction = build_interaction_request(
            issue,
            interaction_context,
            request.clone(),
            InteractionResumeStrategy::RerunStep,
        );
        interaction.waiting_started_at = waiting_started_at;
        interaction.agent_input_tokens = waiting_input_tokens;
        interaction.agent_output_tokens = waiting_output_tokens;
        interaction.agent_total_tokens = waiting_total_tokens;
        self.interaction_store.create(interaction.clone()).await?;
        let root_body = format_interaction_thread_root_comment(&interaction);
        match self
            .tracker
            .create_interaction_thread_root(&interaction.issue_id, &root_body)
            .await
        {
            Ok(root) => {
                if let Err(error) = self
                    .interaction_store
                    .attach_thread_metadata(
                        &interaction.id,
                        root.comment_id.clone(),
                        root.comment_url.clone(),
                    )
                    .await
                {
                    warn!(
                        interaction_id = %interaction.id,
                        error = %error,
                        "failed to persist interaction thread metadata"
                    );
                }
            }
            Err(error) => {
                warn!(
                    interaction_id = %interaction.id,
                    issue_id = %interaction.issue_id,
                    error = %error,
                    "failed to create interaction thread root comment"
                );
            }
        }

        let mut state = self.state.write().await;
        let (run_id, sequence, attempt) = Self::run_context_for_issue(&mut state, issue_id);
        let follow_up_sequence = run_id
            .as_ref()
            .map(|current_run_id| state.next_timeline_sequence(current_run_id));
        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.step_blocked_on_human(step_name, interaction.id.clone());
        }
        state.park_step_waiting_for_human(issue_id, step_name, interaction.id.clone());
        let has_running_steps = state
            .get_pipeline_run(issue_id)
            .is_some_and(Self::pipeline_has_running_steps);

        let (retry_attempt, waiting_issue, waiting_run_id) = {
            let entry = state.running.get(issue_id);
            (
                entry.and_then(|e| e.retry_attempt),
                entry.map(|e| e.issue.clone()),
                entry.and_then(|e| e.run_id.clone()),
            )
        };
        if !has_running_steps {
            if let Some(entry) = state.remove_running(issue_id) {
                state.add_runtime_seconds(&entry);
            }
        }
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: interaction.id.clone(),
            step_name: step_name.to_string(),
            kind: interaction.kind.clone(),
            prompt: interaction.title.clone(),
            agent_name: interaction.agent_name.clone(),
            retry_attempt,
            started_at: waiting_started_at,
            agent_input_tokens: waiting_input_tokens,
            agent_output_tokens: waiting_output_tokens,
            agent_total_tokens: waiting_total_tokens,
            requested_at: interaction.requested_at,
            run_id: waiting_run_id,
            issue: waiting_issue,
        });
        drop(state);

        self.publish_pipeline_event(
            run_id.clone(),
            sequence,
            attempt,
            PipelineEvent::QuestionAsked {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: step_name.to_string(),
                agent_name: interaction.agent_name.clone(),
                ask_id: interaction.id.clone(),
                detail: interaction.title.clone(),
            },
        )
        .await;

        self.publish_pipeline_event(
            run_id,
            follow_up_sequence,
            attempt,
            PipelineEvent::InputRequested {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: step_name.to_string(),
                kind: interaction_kind_name(&interaction.kind).to_string(),
                detail: interaction.title.clone(),
            },
        )
        .await;

        Ok(())
    }

    async fn handle_post_step_approval(
        &self,
        issue_id: &str,
        step_name: &str,
        approval_state: Option<String>,
        approval_request: Option<&StepApprovalRequestDraft>,
        issue_snapshot: Option<&Issue>,
    ) -> Result<(), EnsembleError> {
        let issue = issue_snapshot.ok_or_else(|| AgentError::PromptError {
            reason: format!("missing running issue snapshot for approval-gated issue {issue_id}"),
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
                    reason: format!("approval-gated step '{step_name}' no longer exists"),
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

        let request = approval_request
            .cloned()
            .unwrap_or_else(|| StepApprovalRequestDraft {
                schema_version: 1,
                title: format!("Approve step '{step_name}'"),
                body: format!(
                    "Step '{step_name}' completed successfully. Approve it to continue the pipeline."
                ),
                state: None,
            });
        let mirror_state = request.state.clone().or(approval_state);
        let (waiting_started_at, waiting_input_tokens, waiting_output_tokens, waiting_total_tokens) = {
            let state = self.state.read().await;
            let running_entry = state.running.get(issue_id);
            (
                running_entry.map(|entry| entry.started_at),
                running_entry
                    .map(|entry| entry.agent_input_tokens)
                    .unwrap_or(0),
                running_entry
                    .map(|entry| entry.agent_output_tokens)
                    .unwrap_or(0),
                running_entry
                    .map(|entry| entry.agent_total_tokens)
                    .unwrap_or(0),
            )
        };

        let mut interaction = build_interaction_request(
            issue,
            interaction_context,
            InteractionRequestDraft {
                schema_version: request.schema_version,
                kind: InteractionKind::ApprovalGate,
                blocking: true,
                title: request.title,
                body: request.body,
                options: vec!["approve".to_string(), "reject".to_string()],
                artifacts: vec![],
            },
            InteractionResumeStrategy::AdvanceAfterStep,
        );
        interaction.waiting_started_at = waiting_started_at;
        interaction.agent_input_tokens = waiting_input_tokens;
        interaction.agent_output_tokens = waiting_output_tokens;
        interaction.agent_total_tokens = waiting_total_tokens;
        self.interaction_store.create(interaction.clone()).await?;

        let root_body = format_interaction_thread_root_comment(&interaction);
        match self
            .tracker
            .create_interaction_thread_root(&interaction.issue_id, &root_body)
            .await
        {
            Ok(root) => {
                if let Err(error) = self
                    .interaction_store
                    .attach_thread_metadata(
                        &interaction.id,
                        root.comment_id.clone(),
                        root.comment_url.clone(),
                    )
                    .await
                {
                    warn!(
                        interaction_id = %interaction.id,
                        error = %error,
                        "failed to persist interaction thread metadata for approval gate"
                    );
                }
            }
            Err(error) => {
                warn!(
                    interaction_id = %interaction.id,
                    issue_id = %interaction.issue_id,
                    error = %error,
                    "failed to create interaction thread root for approval gate"
                );
            }
        }

        if let Some(state_name) = mirror_state {
            if self.tracker.supports_writes() {
                if let Err(error) = self.tracker.set_issue_state(issue_id, &state_name).await {
                    warn!(
                        issue_id = %issue_id,
                        step = %step_name,
                        tracker_state_to = %state_name,
                        error = %error,
                        "failed to set tracker state for approval checkpoint"
                    );
                }
            }
        }

        let mut state = self.state.write().await;
        let (run_id, sequence, attempt) = Self::run_context_for_issue(&mut state, issue_id);
        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.bind_approval_interaction(step_name, interaction.id.clone());
        }
        let has_running_steps = state
            .get_pipeline_run(issue_id)
            .is_some_and(Self::pipeline_has_running_steps);

        let (retry_attempt, waiting_issue, waiting_run_id) = {
            let entry = state.running.get(issue_id);
            (
                entry.and_then(|e| e.retry_attempt),
                entry.map(|e| e.issue.clone()),
                entry.and_then(|e| e.run_id.clone()),
            )
        };
        if !has_running_steps {
            if let Some(entry) = state.remove_running(issue_id) {
                state.add_runtime_seconds(&entry);
            }
        }

        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: interaction.id.clone(),
            step_name: step_name.to_string(),
            kind: interaction.kind.clone(),
            prompt: interaction.title.clone(),
            agent_name: interaction.agent_name.clone(),
            retry_attempt,
            started_at: waiting_started_at,
            agent_input_tokens: waiting_input_tokens,
            agent_output_tokens: waiting_output_tokens,
            agent_total_tokens: waiting_total_tokens,
            requested_at: interaction.requested_at,
            run_id: waiting_run_id,
            issue: waiting_issue,
        });
        drop(state);

        self.publish_pipeline_event(
            run_id,
            sequence,
            attempt,
            PipelineEvent::InputRequested {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: step_name.to_string(),
                kind: interaction_kind_name(&interaction.kind).to_string(),
                detail: interaction.title.clone(),
            },
        )
        .await;

        Ok(())
    }

    async fn process_waiting_interaction_commands(&self) {
        let waiting_entries = {
            let state = self.state.read().await;
            state
                .waiting_on_human
                .values()
                .cloned()
                .collect::<Vec<WaitingOnHumanEntry>>()
        };

        for waiting in waiting_entries {
            let mut interaction = match self
                .interaction_store
                .get(&waiting.interaction_request_id)
                .await
            {
                Ok(Some(interaction)) => interaction,
                Ok(None) => continue,
                Err(error) => {
                    warn!(
                        interaction_id = %waiting.interaction_request_id,
                        error = %error,
                        "failed to load interaction while processing thread commands"
                    );
                    continue;
                }
            };

            let Some(root_comment_id) = interaction.thread_root_comment_id.clone() else {
                continue;
            };

            let anchor_id = interaction
                .last_processed_comment_id
                .as_deref()
                .unwrap_or(&root_comment_id);

            let comments = match self
                .tracker
                .list_comments_after(&interaction.issue_id, anchor_id)
                .await
            {
                Ok(comments) => comments,
                Err(error) => {
                    warn!(
                        interaction_id = %interaction.id,
                        issue_id = %interaction.issue_id,
                        error = %error,
                        "failed to list interaction thread comments"
                    );
                    continue;
                }
            };
            // v1 currently asks the tracker adapter for comments after the root anchor.
            // If this becomes expensive on very long-lived issues, add a persisted
            // per-interaction checkpoint to avoid repeated full-history scans.

            let last_comment_id = comments.last().map(|c| c.comment_id.clone());

            for comment in comments {
                if interaction
                    .accepted_command
                    .as_ref()
                    .is_some_and(|accepted| accepted.comment_id == comment.comment_id)
                    || interaction
                        .ignored_commands
                        .iter()
                        .any(|ignored| ignored.comment_id == comment.comment_id)
                {
                    continue;
                }

                let marker_prefix = "<!-- ensemble:interaction:";
                let interaction_marker = format!("{marker_prefix}{} -->", interaction.id);
                if comment.body.contains(marker_prefix)
                    && !comment.body.contains(&interaction_marker)
                {
                    interaction = self
                        .append_ignored_command(
                            &interaction,
                            None,
                            &comment,
                            "interaction_marker_mismatch",
                        )
                        .await;
                    continue;
                }

                if !comment.body.contains(marker_prefix) && !comment.body.contains(&interaction.id)
                {
                    interaction = self
                        .append_ignored_command(
                            &interaction,
                            None,
                            &comment,
                            "comment_not_scoped_to_interaction",
                        )
                        .await;
                    continue;
                }

                if comment
                    .updated_at
                    .zip(comment.created_at)
                    .is_some_and(|(updated, created)| updated > created)
                {
                    interaction = self
                        .append_ignored_command(
                            &interaction,
                            None,
                            &comment,
                            "edited_comments_not_supported",
                        )
                        .await;
                    continue;
                }

                let parsed = match parse_interaction_command(&comment.body) {
                    Ok(parsed) => parsed,
                    Err(_) => {
                        interaction = self
                            .append_ignored_command(
                                &interaction,
                                None,
                                &comment,
                                "not_a_supported_command",
                            )
                            .await;
                        continue;
                    }
                };

                let response = match response_from_command(&interaction.kind, &parsed) {
                    Some(response) => response,
                    None => {
                        interaction = self
                            .append_ignored_command(
                                &interaction,
                                Some(parsed.command_name()),
                                &comment,
                                "command_invalid_for_interaction_kind",
                            )
                            .await;
                        continue;
                    }
                };

                if interaction.accepted_command.is_some() {
                    interaction = self
                        .append_ignored_command(
                            &interaction,
                            Some(parsed.command_name()),
                            &comment,
                            "interaction_already_locked",
                        )
                        .await;
                    continue;
                }

                let accepted_result = self
                    .interaction_store
                    .accept_first_command(
                        &interaction.id,
                        AcceptedInteractionCommand {
                            command: parsed.command_name().to_string(),
                            raw_body: comment.body.clone(),
                            author: comment.author.clone(),
                            comment_id: comment.comment_id.clone(),
                            received_at: comment.created_at.unwrap_or_else(Utc::now),
                        },
                    )
                    .await;

                match accepted_result {
                    Ok(updated) => interaction = updated,
                    Err(error) => {
                        warn!(
                            interaction_id = %interaction.id,
                            error = %error,
                            "failed to accept interaction command"
                        );
                        interaction = self
                            .append_ignored_command(
                                &interaction,
                                Some(parsed.command_name()),
                                &comment,
                                "interaction_already_locked",
                            )
                            .await;
                        continue;
                    }
                }

                match self
                    .interaction_store
                    .resolve(&interaction.id, response)
                    .await
                {
                    Ok(updated) => interaction = updated,
                    Err(error) => {
                        warn!(
                            interaction_id = %interaction.id,
                            error = %error,
                            "failed to resolve interaction from thread command"
                        );
                        continue;
                    }
                }

                let mut state = self.state.write().await;
                state.queue_resume(&interaction.issue_id);
            }

            if let Some(last_id) = last_comment_id {
                if interaction.last_processed_comment_id.as_deref() != Some(&last_id) {
                    if let Err(error) = self
                        .interaction_store
                        .update_last_processed_comment(&interaction.id, last_id)
                        .await
                    {
                        warn!(
                            interaction_id = %interaction.id,
                            error = %error,
                            "failed to update last processed comment cursor"
                        );
                    }
                }
            }
        }
    }

    async fn append_ignored_command(
        &self,
        interaction: &crate::interaction::model::InteractionRequest,
        command: Option<&str>,
        comment: &crate::tracker::model::TrackerComment,
        reason: &str,
    ) -> crate::interaction::model::InteractionRequest {
        match self
            .interaction_store
            .append_ignored_command(
                &interaction.id,
                IgnoredInteractionCommand {
                    command: command.map(ToString::to_string),
                    raw_body: comment.body.clone(),
                    author: comment.author.clone(),
                    comment_id: comment.comment_id.clone(),
                    received_at: comment.created_at.unwrap_or_else(Utc::now),
                    reason: reason.to_string(),
                },
            )
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                warn!(
                    interaction_id = %interaction.id,
                    error = %error,
                    "failed to append ignored interaction command"
                );
                interaction.clone()
            }
        }
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
            if state.is_running(&interaction.issue_id)
                || state.is_waiting_on_human(&interaction.issue_id)
            {
                continue;
            }

            // Try to get the issue from the tracker
            let issue = self
                .tracker
                .fetch_issue_states_by_ids(std::slice::from_ref(&interaction.issue_id))
                .await
                .ok()
                .and_then(|issues| issues.into_iter().next());

            state.add_waiting_on_human(WaitingOnHumanEntry {
                issue_id: interaction.issue_id.clone(),
                identifier: interaction.issue_identifier.clone(),
                interaction_request_id: interaction.id.clone(),
                step_name: interaction.step_name.clone(),
                kind: interaction.kind.clone(),
                prompt: interaction.title.clone(),
                agent_name: interaction.agent_name.clone(),
                retry_attempt: Some(interaction.pipeline_cycle.max(1)),
                started_at: interaction.waiting_started_at,
                agent_input_tokens: interaction.agent_input_tokens,
                agent_output_tokens: interaction.agent_output_tokens,
                agent_total_tokens: interaction.agent_total_tokens,
                requested_at: interaction.requested_at,
                run_id: None,
                issue,
            });
        }
    }

    async fn restore_pipeline_runs_from_journal(&self) {
        let records = match self.pipeline_journal.latest_live_records().await {
            Ok(records) => records,
            Err(error) => {
                warn!(
                    error = %error,
                    "failed to read pipeline transition journal during startup"
                );
                return;
            }
        };

        if records.is_empty() {
            return;
        }

        let config_snapshot = {
            let config = self.config.read().await;
            Arc::new(config.clone())
        };

        let issue_ids = records
            .iter()
            .map(|record| record.issue_id.clone())
            .collect::<Vec<_>>();
        let issues = self
            .tracker
            .fetch_issue_states_by_ids(&issue_ids)
            .await
            .unwrap_or_default();
        let issues_by_id: HashMap<String, Issue> = issues
            .into_iter()
            .map(|issue| (issue.id.clone(), issue))
            .collect();

        for record in records {
            if let Err(error) = self
                .restore_pipeline_run_record(&record, Arc::clone(&config_snapshot), &issues_by_id)
                .await
            {
                warn!(
                    issue_id = %record.issue_id,
                    error = %error,
                    "failed to restore pipeline run from transition journal"
                );
            }
        }
    }

    async fn restore_pipeline_run_record(
        &self,
        record: &PipelineTransitionRecord,
        config_snapshot: Arc<EnsembleConfig>,
        issues_by_id: &HashMap<String, Issue>,
    ) -> Result<(), EnsembleError> {
        let snapshot = record
            .snapshot
            .clone()
            .ok_or_else(|| AgentError::PromptError {
                reason: format!(
                    "pipeline journal record {} for issue '{}' has no snapshot",
                    record.seq, record.issue_id
                ),
            })?;

        validate_restored_snapshot_against_config(&snapshot, &config_snapshot)?;
        let mut run = PipelineRun::from_snapshot(snapshot)?;
        run.normalize_stale_running_steps();

        let mut state = self.state.write().await;
        if state.get_pipeline_run(&record.issue_id).is_some() || state.is_running(&record.issue_id)
        {
            return Ok(());
        }

        state.insert_pipeline_run(&record.issue_id, run, Arc::clone(&config_snapshot));
        state.add_claimed(&record.issue_id);
        if let Some(run_id) = record.run_id.clone() {
            state.issue_run_ids.insert(record.issue_id.clone(), run_id);
        }

        if let Some(retry) = record.retry.clone() {
            state.add_retry(retry);
        }

        if record.kind == PipelineTransitionKind::PipelineHalted {
            let step_name = record.step.clone().unwrap_or_default();
            let agent_name = state
                .get_pipeline_run(&record.issue_id)
                .and_then(|run| run.step(&step_name))
                .map(|step| step.agent.clone())
                .unwrap_or_default();
            state.add_waiting_on_human(WaitingOnHumanEntry {
                issue_id: record.issue_id.clone(),
                identifier: record.identifier.clone(),
                interaction_request_id: format!("halted:{}:{step_name}", record.issue_id),
                step_name,
                kind: InteractionKind::Handoff,
                prompt: record
                    .reason
                    .clone()
                    .unwrap_or_else(|| "pipeline halted".to_string()),
                agent_name,
                retry_attempt: Some(record.cycle.max(1)),
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: record.written_at,
                run_id: record.run_id.clone(),
                issue: issues_by_id.get(&record.issue_id).cloned(),
            });
        }

        Ok(())
    }

    async fn append_pipeline_transition(&self, input: PipelineTransitionInput) {
        if let Err(error) = self.pipeline_journal.append(input).await {
            warn!(
                error = %error,
                "failed to append pipeline transition journal record"
            );
        }
    }

    async fn append_pipeline_release(
        &self,
        issue_id: &str,
        identifier: &str,
        run_id: Option<String>,
        reason: &str,
    ) {
        if let Err(error) = self
            .pipeline_journal
            .append_released(issue_id, identifier, run_id, reason)
            .await
        {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to append pipeline release journal record"
            );
        }
    }

    fn transition_input_for_run(
        state: &OrchestratorState,
        issue_id: &str,
        identifier: &str,
        kind: PipelineTransitionKind,
        step: Option<String>,
        reason: Option<String>,
        retry: Option<RetryEntry>,
    ) -> Option<PipelineTransitionInput> {
        let run = state.get_pipeline_run(issue_id)?;
        let run_id = state
            .running
            .get(issue_id)
            .and_then(|entry| entry.run_id.clone())
            .or_else(|| {
                state
                    .waiting_on_human
                    .get(issue_id)
                    .and_then(|entry| entry.run_id.clone())
            })
            .or_else(|| state.issue_run_ids.get(issue_id).cloned());

        Some(PipelineTransitionInput {
            kind,
            issue_id: issue_id.to_string(),
            identifier: identifier.to_string(),
            run_id,
            cycle: run.cycle,
            step,
            reason,
            retry,
            snapshot: Some(run.to_snapshot()),
        })
    }

    fn transition_kind_for_action(action: &PipelineAction) -> PipelineTransitionKind {
        match action {
            PipelineAction::Dispatch(_) | PipelineAction::Succeeded => {
                PipelineTransitionKind::StepCompleted
            }
            PipelineAction::Failed { .. } => PipelineTransitionKind::StepFailed,
            PipelineAction::BlockedOnHuman { .. } => PipelineTransitionKind::StepBlockedOnHuman,
            PipelineAction::AwaitingApproval { .. } => PipelineTransitionKind::StepAwaitingApproval,
            PipelineAction::Waiting => PipelineTransitionKind::StepCompleted,
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

    fn is_headless_runtime() -> bool {
        std::env::var("ENSEMBLE_HEADLESS")
            .map(|value| value == "1")
            .unwrap_or(false)
    }

    async fn run_finalize_phase(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        _config: &EnsembleConfig,
    ) -> IssueFinalizeState {
        let mut repos = Vec::new();
        let headless = Self::is_headless_runtime();

        let configured_repos = self.workspace_mgr.repos();
        let requires_workspace = configured_repos
            .values()
            .any(|repo| repo.finalize.enabled && !matches!(repo.finalize.mode, FinalizeMode::None));

        let prepared_workspace = if requires_workspace {
            match self.workspace_mgr.prepare_workspace(issue_identifier).await {
                Ok(workspace) => Some(workspace),
                Err(error) => {
                    return IssueFinalizeState {
                        issue_identifier: issue_identifier.to_string(),
                        status: FinalizeStatus::Failed,
                        repos: vec![RepoFinalizeState {
                            repo: "workspace".to_string(),
                            mode: "prepare".to_string(),
                            approval_required: false,
                            status: FinalizeStatus::Failed,
                            last_error: Some(error.to_string()),
                        }],
                    };
                }
            }
        } else {
            None
        };

        for (repo_name, repo_config) in configured_repos {
            if !repo_config.finalize.enabled
                || matches!(repo_config.finalize.mode, FinalizeMode::None)
            {
                continue;
            }

            let mode_name = match repo_config.finalize.mode {
                FinalizeMode::None => "none",
                FinalizeMode::Push => "push",
                FinalizeMode::PushAndPr => "push_and_pr",
            }
            .to_string();

            if repo_config.finalize.approval_required {
                let status = if headless {
                    FinalizeStatus::SkippedHeadless
                } else {
                    FinalizeStatus::PendingApproval
                };
                repos.push(RepoFinalizeState {
                    repo: repo_name.clone(),
                    mode: mode_name,
                    approval_required: true,
                    status: status.clone(),
                    last_error: None,
                });
                self.update_repo_artifact_finalize_status(issue_id, repo_name, status, None)
                    .await;
                continue;
            }

            let worktree_path = prepared_workspace
                .as_ref()
                .and_then(|workspace| workspace.worktrees.get(repo_name))
                .map(|wt| wt.path.clone());

            let Some(worktree_path) = worktree_path else {
                repos.push(RepoFinalizeState {
                    repo: repo_name.clone(),
                    mode: mode_name,
                    approval_required: false,
                    status: FinalizeStatus::Failed,
                    last_error: Some("worktree not found for repo".to_string()),
                });
                self.update_repo_artifact_finalize_status(
                    issue_id,
                    repo_name,
                    FinalizeStatus::Failed,
                    Some("worktree not found for repo".to_string()),
                )
                .await;
                continue;
            };

            let finalize_result = self
                .execute_finalize_action(
                    &worktree_path,
                    &repo_config.git_remote,
                    &repo_config.branch,
                    &repo_config.finalize.mode,
                )
                .await;

            match finalize_result {
                Ok(output) => {
                    repos.push(RepoFinalizeState {
                        repo: repo_name.clone(),
                        mode: mode_name,
                        approval_required: false,
                        status: FinalizeStatus::Succeeded,
                        last_error: None,
                    });
                    self.update_repo_artifact_finalize_output(issue_id, repo_name, output)
                        .await;
                }
                Err(error) => {
                    repos.push(RepoFinalizeState {
                        repo: repo_name.clone(),
                        mode: mode_name,
                        approval_required: false,
                        status: FinalizeStatus::Failed,
                        last_error: Some(error.clone()),
                    });
                    self.update_repo_artifact_finalize_status(
                        issue_id,
                        repo_name,
                        FinalizeStatus::Failed,
                        Some(error),
                    )
                    .await;
                }
            }
        }

        let status = if repos.is_empty() {
            FinalizeStatus::NotRequired
        } else if repos
            .iter()
            .any(|repo| repo.status == FinalizeStatus::Failed)
        {
            FinalizeStatus::Failed
        } else if repos
            .iter()
            .any(|repo| repo.status == FinalizeStatus::PendingApproval)
        {
            FinalizeStatus::PendingApproval
        } else if repos
            .iter()
            .any(|repo| repo.status == FinalizeStatus::SkippedHeadless)
        {
            FinalizeStatus::SkippedHeadless
        } else {
            // Initial finalize execution in this method is synchronous per repo,
            // so issue-level `InProgress` is not expected here. `InProgress`
            // is used later for operator-approved/retry flows.
            FinalizeStatus::Succeeded
        };

        IssueFinalizeState {
            issue_identifier: issue_identifier.to_string(),
            status,
            repos,
        }
    }

    async fn process_finalize_retries(&self) {
        let pending_retries: Vec<(String, String)> = {
            let state = self.state.read().await;
            state
                .finalize
                .iter()
                .filter(|(_, finalize)| {
                    finalize.status == FinalizeStatus::InProgress
                        || finalize
                            .repos
                            .iter()
                            .any(|repo| repo.status == FinalizeStatus::InProgress)
                })
                .map(|(issue_id, finalize)| (issue_id.clone(), finalize.issue_identifier.clone()))
                .collect()
        };

        for (issue_id, issue_identifier) in pending_retries {
            self.retry_finalize_for_issue(&issue_id, &issue_identifier)
                .await;
        }
    }

    async fn retry_finalize_for_issue(&self, issue_id: &str, issue_identifier: &str) {
        let retry_repo_names: Vec<String> = {
            let state = self.state.read().await;
            state
                .get_finalize_state(issue_id)
                .map(|finalize| {
                    finalize
                        .repos
                        .iter()
                        .filter(|repo| repo.status == FinalizeStatus::InProgress)
                        .map(|repo| repo.repo.clone())
                        .collect()
                })
                .unwrap_or_default()
        };

        if retry_repo_names.is_empty() {
            return;
        }

        let workspace = match self.workspace_mgr.prepare_workspace(issue_identifier).await {
            Ok(workspace) => workspace,
            Err(error) => {
                let mut state = self.state.write().await;
                if let Some(finalize) = state.get_finalize_state_mut(issue_id) {
                    finalize.status = FinalizeStatus::Failed;
                    for repo in &mut finalize.repos {
                        if repo.status == FinalizeStatus::InProgress {
                            repo.status = FinalizeStatus::Failed;
                            repo.last_error = Some(error.to_string());
                        }
                    }
                }
                return;
            }
        };

        let repo_configs = self.workspace_mgr.repos().clone();
        let mut outcomes: HashMap<String, Result<FinalizeActionOutput, String>> = HashMap::new();

        for repo_name in &retry_repo_names {
            let Some(repo_config) = repo_configs.get(repo_name) else {
                outcomes.insert(
                    repo_name.clone(),
                    Err("repo config missing for finalize retry".to_string()),
                );
                continue;
            };
            let Some(worktree) = workspace.worktrees.get(repo_name) else {
                outcomes.insert(
                    repo_name.clone(),
                    Err("worktree missing for finalize retry".to_string()),
                );
                continue;
            };

            let result = self
                .execute_finalize_action(
                    &worktree.path,
                    &repo_config.git_remote,
                    &repo_config.branch,
                    &repo_config.finalize.mode,
                )
                .await;
            outcomes.insert(repo_name.clone(), result);
        }

        let (final_status, should_complete, last_error) = {
            let mut state = self.state.write().await;
            let mut final_status = FinalizeStatus::NotRequired;
            let mut should_complete = false;
            let mut last_error: Option<String> = None;

            if let Some(finalize) = state.get_finalize_state_mut(issue_id) {
                for repo in &mut finalize.repos {
                    if let Some(result) = outcomes.get(&repo.repo) {
                        match result {
                            Ok(_) => {
                                repo.status = FinalizeStatus::Succeeded;
                                repo.last_error = None;
                            }
                            Err(error) => {
                                repo.status = FinalizeStatus::Failed;
                                repo.last_error = Some(error.clone());
                                last_error = Some(error.clone());
                            }
                        }
                    }
                }

                final_status = if finalize.repos.is_empty() {
                    FinalizeStatus::NotRequired
                } else if finalize
                    .repos
                    .iter()
                    .any(|repo| repo.status == FinalizeStatus::Failed)
                {
                    FinalizeStatus::Failed
                } else if finalize
                    .repos
                    .iter()
                    .any(|repo| repo.status == FinalizeStatus::PendingApproval)
                {
                    FinalizeStatus::PendingApproval
                } else if finalize
                    .repos
                    .iter()
                    .any(|repo| repo.status == FinalizeStatus::InProgress)
                {
                    FinalizeStatus::InProgress
                } else if finalize
                    .repos
                    .iter()
                    .any(|repo| repo.status == FinalizeStatus::SkippedHeadless)
                {
                    FinalizeStatus::SkippedHeadless
                } else {
                    FinalizeStatus::Succeeded
                };

                finalize.status = final_status.clone();
                should_complete = matches!(
                    final_status,
                    FinalizeStatus::Succeeded | FinalizeStatus::NotRequired
                );

                if should_complete {
                    let identifier = state
                        .get_finalize_state(issue_id)
                        .map(|f| f.issue_identifier.clone())
                        .unwrap_or_else(|| issue_id.to_string());
                    state.add_completed(
                        issue_id.to_string(),
                        identifier,
                        "completed_succeeded".to_string(),
                    );
                    state.release_claim(issue_id);
                    state.remove_pipeline_run(issue_id);
                    state.clear_finalize_state(issue_id);
                }
            }

            if let Some(artifacts) = state.artifacts.get_mut(issue_id) {
                for repo_artifact in &mut artifacts.repos {
                    if let Some(result) = outcomes.get(&repo_artifact.repo) {
                        match result {
                            Ok(output) => {
                                repo_artifact.finalize_status = "succeeded".to_string();
                                repo_artifact.pushed_ref = output.pushed_ref.clone();
                                repo_artifact.pr_url = output.pr_url.clone();
                                repo_artifact.last_error = None;
                            }
                            Err(error) => {
                                repo_artifact.finalize_status = "failed".to_string();
                                repo_artifact.last_error = Some(error.clone());
                            }
                        }
                    }
                }
            }

            (final_status, should_complete, last_error)
        };

        if self.tracker.supports_writes() {
            let config = self.config.read().await;
            if should_complete {
                if let Err(error) = self
                    .tracker
                    .set_issue_state(issue_id, &config.on_success)
                    .await
                {
                    warn!(issue_id = %issue_id, error = %error, "failed to set tracker success state after finalize retry");
                }
            } else if final_status == FinalizeStatus::Failed {
                if let Err(error) = self
                    .tracker
                    .set_issue_state(issue_id, &config.on_failure)
                    .await
                {
                    warn!(issue_id = %issue_id, error = %error, "failed to set tracker failure state after finalize retry");
                }
                if let Some(error) = last_error {
                    warn!(issue_id = %issue_id, error = %error, "finalize retry failed");
                }
            }
        }
    }

    async fn execute_finalize_action(
        &self,
        repo_path: &std::path::Path,
        remote: &str,
        base_branch: &str,
        mode: &FinalizeMode,
    ) -> Result<FinalizeActionOutput, String> {
        let push_output = tokio::process::Command::new("git")
            .arg("push")
            .arg(remote)
            .arg("HEAD")
            .current_dir(repo_path)
            .output();
        let push_output = timeout(FINALIZE_COMMAND_TIMEOUT, push_output)
            .await
            .map_err(|_| {
                format!(
                    "git push timed out after {}s",
                    FINALIZE_COMMAND_TIMEOUT.as_secs()
                )
            })?
            .map_err(|error| format!("failed to run git push: {error}"))?;
        if !push_output.status.success() {
            return Err(format!(
                "git push failed: {}",
                String::from_utf8_lossy(&push_output.stderr)
            ));
        }

        let current_branch = Self::current_branch(repo_path).await?;
        let mut output = FinalizeActionOutput {
            pushed_ref: Some(format!("{remote}/{current_branch}")),
            pr_url: None,
        };

        if matches!(mode, FinalizeMode::PushAndPr) {
            let pr_output = tokio::process::Command::new("gh")
                .args([
                    "pr",
                    "create",
                    "--fill",
                    "--head",
                    &current_branch,
                    "--base",
                    base_branch,
                ])
                .current_dir(repo_path)
                .output();
            let pr_output = timeout(FINALIZE_COMMAND_TIMEOUT, pr_output)
                .await
                .map_err(|_| {
                    format!(
                        "gh pr create timed out after {}s",
                        FINALIZE_COMMAND_TIMEOUT.as_secs()
                    )
                })?
                .map_err(|error| format!("failed to run gh pr create: {error}"))?;
            if !pr_output.status.success() {
                let pr_create_stderr = String::from_utf8_lossy(&pr_output.stderr).to_string();
                if pr_create_stderr.contains("already exists") {
                    let pr_lookup_output = tokio::process::Command::new("gh")
                        .args([
                            "pr",
                            "list",
                            "--head",
                            &current_branch,
                            "--base",
                            base_branch,
                            "--state",
                            "all",
                            "--json",
                            "url",
                            "--limit",
                            "1",
                        ])
                        .current_dir(repo_path)
                        .output();
                    let pr_lookup_output = timeout(FINALIZE_COMMAND_TIMEOUT, pr_lookup_output)
                        .await
                        .map_err(|_| {
                            format!(
                                "gh pr list timed out after {}s",
                                FINALIZE_COMMAND_TIMEOUT.as_secs()
                            )
                        })?
                        .map_err(|error| format!("failed to run gh pr list: {error}"))?;

                    if pr_lookup_output.status.success() {
                        let pr_lookup_stdout = String::from_utf8_lossy(&pr_lookup_output.stdout);
                        if let Some(pr_url) = Self::parse_first_pr_url(&pr_lookup_stdout) {
                            output.pr_url = Some(pr_url);
                            return Ok(output);
                        }
                    }
                }

                return Err(format!("gh pr create failed: {pr_create_stderr}"));
            }

            output.pr_url = Self::parse_first_pr_url(&String::from_utf8_lossy(&pr_output.stdout));
        }

        Ok(output)
    }

    async fn current_branch(repo_path: &std::path::Path) -> Result<String, String> {
        let branch_output = tokio::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path)
            .output()
            .await
            .map_err(|error| format!("failed to resolve branch: {error}"))?;
        if !branch_output.status.success() {
            return Err(format!(
                "failed to resolve current branch: {}",
                String::from_utf8_lossy(&branch_output.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string())
    }

    fn parse_first_pr_url(stdout: &str) -> Option<String> {
        let trimmed = stdout.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Some(trimmed.lines().next().unwrap_or(trimmed).trim().to_string());
        }
        serde_json::from_str::<Vec<serde_json::Value>>(trimmed)
            .ok()
            .and_then(|values| {
                values
                    .first()
                    .and_then(|value| value.get("url"))
                    .and_then(|url| url.as_str())
                    .map(ToString::to_string)
            })
    }

    async fn update_repo_artifact_finalize_output(
        &self,
        issue_id: &str,
        repo_name: &str,
        output: FinalizeActionOutput,
    ) {
        let mut state = self.state.write().await;
        if let Some(artifacts) = state.artifacts.get_mut(issue_id) {
            if let Some(repo_artifact) = artifacts
                .repos
                .iter_mut()
                .find(|artifact| artifact.repo == repo_name)
            {
                repo_artifact.finalize_status = "succeeded".to_string();
                repo_artifact.pushed_ref = output.pushed_ref;
                repo_artifact.pr_url = output.pr_url;
                repo_artifact.last_error = None;
            }
        }
    }

    async fn update_repo_artifact_finalize_status(
        &self,
        issue_id: &str,
        repo_name: &str,
        status: FinalizeStatus,
        last_error: Option<String>,
    ) {
        let mut state = self.state.write().await;
        if let Some(artifacts) = state.artifacts.get_mut(issue_id) {
            if let Some(repo_artifact) = artifacts
                .repos
                .iter_mut()
                .find(|artifact| artifact.repo == repo_name)
            {
                repo_artifact.finalize_status = Self::finalize_status_name(&status).to_string();
                repo_artifact.last_error = last_error;
            }
        }
    }

    fn finalize_status_name(status: &FinalizeStatus) -> &'static str {
        match status {
            FinalizeStatus::NotRequired => "not_required",
            FinalizeStatus::PendingApproval => "pending_approval",
            FinalizeStatus::InProgress => "in_progress",
            FinalizeStatus::Succeeded => "succeeded",
            FinalizeStatus::Failed => "failed",
            FinalizeStatus::SkippedHeadless => "skipped_headless",
        }
    }

    fn pipeline_has_running_steps(run: &PipelineRun) -> bool {
        run.step_states
            .values()
            .any(|step_state| matches!(step_state, StepState::Running { .. }))
    }

    fn build_history_record(
        &self,
        issue_id: &str,
        outcome: &str,
        last_error: Option<String>,
        running_entry: &crate::tracker::model::RunningEntry,
        run: &PipelineRun,
        completed_at: chrono::DateTime<Utc>,
        artifacts: Option<RunArtifacts>,
    ) -> HistoryRecord {
        let steps_traversed = run.traversed_steps_in_order();

        let duration_seconds = completed_at
            .signed_duration_since(running_entry.started_at)
            .num_seconds()
            .max(0) as u64;

        let workspace_path = self
            .workspace_mgr
            .workspace_path(&running_entry.identifier)
            .map(|path| path.display().to_string())
            .unwrap_or_default();

        HistoryRecord {
            issue_identifier: running_entry.identifier.clone(),
            issue_id: issue_id.to_string(),
            outcome: outcome.to_string(),
            steps_traversed,
            attempts: running_entry.retry_attempt.unwrap_or(1),
            tokens: TokenTotals {
                input_tokens: running_entry.agent_input_tokens,
                output_tokens: running_entry.agent_output_tokens,
                total_tokens: running_entry.agent_total_tokens,
            },
            duration_seconds,
            started_at: running_entry.started_at,
            completed_at,
            last_error,
            verdict: Self::history_verdict(run),
            workspace_path,
            artifacts,
        }
    }

    fn build_history_record_from_waiting(
        &self,
        issue_id: &str,
        outcome: &str,
        last_error: Option<String>,
        waiting_entry: &WaitingOnHumanEntry,
        run: &PipelineRun,
        completed_at: chrono::DateTime<Utc>,
        artifacts: Option<RunArtifacts>,
    ) -> HistoryRecord {
        let steps_traversed = run.traversed_steps_in_order();
        let started_at = waiting_entry
            .started_at
            .unwrap_or(waiting_entry.requested_at);
        let duration_seconds = completed_at
            .signed_duration_since(started_at)
            .num_seconds()
            .max(0) as u64;
        let workspace_path = self
            .workspace_mgr
            .workspace_path(&waiting_entry.identifier)
            .map(|path| path.display().to_string())
            .unwrap_or_default();

        HistoryRecord {
            issue_identifier: waiting_entry.identifier.clone(),
            issue_id: issue_id.to_string(),
            outcome: outcome.to_string(),
            steps_traversed,
            attempts: waiting_entry.retry_attempt.unwrap_or(1),
            tokens: TokenTotals {
                input_tokens: waiting_entry.agent_input_tokens,
                output_tokens: waiting_entry.agent_output_tokens,
                total_tokens: waiting_entry.agent_total_tokens,
            },
            duration_seconds,
            started_at,
            completed_at,
            last_error,
            verdict: Self::history_verdict(run),
            workspace_path,
            artifacts,
        }
    }

    fn history_verdict(run: &PipelineRun) -> Option<String> {
        if run
            .step_states
            .values()
            .any(|state| matches!(state, StepState::Failed { .. }))
        {
            return Some(HISTORY_VERDICT_REJECTED.to_string());
        }

        if run
            .step_states
            .values()
            .any(|state| matches!(state, StepState::Errored { .. }))
        {
            return Some(HISTORY_VERDICT_FAILED.to_string());
        }

        if run
            .step_states
            .values()
            .all(|state| matches!(state, StepState::Passed))
        {
            return Some(HISTORY_VERDICT_APPROVED.to_string());
        }

        None
    }

    async fn append_history_record(&self, run_id: Option<&str>, record: HistoryRecord) {
        if let (Some(run_id), Some(store)) = (run_id, &self.history_store) {
            if let Err(error) = store.append_history_record(run_id, &record).await {
                warn!(
                    run_id = %run_id,
                    issue_id = %record.issue_id,
                    error = %error,
                    "failed to append history record to sqlite"
                );
            }
        }

        let history_path = self.workspace_mgr.root().join("ensemble_history.jsonl");
        let _guard = self.history_write_lock.lock().await;
        let writer = HistoryWriter::new(history_path);
        if let Err(error) = writer.append(&record).await {
            warn!(
                issue_id = %record.issue_id,
                error = %error,
                "failed to append history record"
            );
        }
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
        match interaction.resume_strategy {
            InteractionResumeStrategy::RerunStep => {
                pipeline_run.step_blocked_on_human(&interaction.step_name, interaction.id.clone());
            }
            InteractionResumeStrategy::AdvanceAfterStep => {
                pipeline_run.step_states.insert(
                    interaction.step_name.clone(),
                    crate::pipeline::engine::StepState::AwaitingApproval {
                        interaction_request_id: Some(interaction.id.clone()),
                    },
                );
            }
        }

        let mut state = self.state.write().await;
        let run_id_for_waiting = state.issue_run_ids.get(&issue.id).cloned();
        state.insert_pipeline_run(&issue.id, pipeline_run, config_snapshot);
        // Always update/add the waiting entry with the issue data to ensure it's available
        // for completion tracking
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: interaction.id.clone(),
            step_name: interaction.step_name.clone(),
            kind: interaction.kind.clone(),
            prompt: interaction.title.clone(),
            agent_name: interaction.agent_name.clone(),
            retry_attempt: Some(interaction.pipeline_cycle.max(1)),
            started_at: interaction.waiting_started_at,
            agent_input_tokens: interaction.agent_input_tokens,
            agent_output_tokens: interaction.agent_output_tokens,
            agent_total_tokens: interaction.agent_total_tokens,
            requested_at: interaction.requested_at,
            run_id: run_id_for_waiting,
            issue: Some(issue.clone()),
        });

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
                        } if interaction.resume_strategy
                            == InteractionResumeStrategy::RerunStep =>
                        {
                            Some((step_name.clone(), interaction_request_id.clone()))
                        }
                        crate::pipeline::engine::StepState::AwaitingApproval {
                            interaction_request_id: Some(interaction_request_id),
                        } if interaction.resume_strategy
                            == InteractionResumeStrategy::AdvanceAfterStep =>
                        {
                            Some((step_name.clone(), interaction_request_id.clone()))
                        }
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

        match interaction.resume_strategy {
            InteractionResumeStrategy::RerunStep => {
                let response =
                    interaction
                        .response
                        .clone()
                        .ok_or_else(|| AgentError::PromptError {
                            reason: format!(
                                "resolved interaction '{}' is missing a response",
                                interaction.id
                            ),
                        })?;
                let resolved_at =
                    interaction
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

                let (attempt, step_outputs) = {
                    let mut state = self.state.write().await;
                    let attempt = state
                        .get_pipeline_run(&issue.id)
                        .map(|run| run.cycle)
                        .unwrap_or(interaction.pipeline_cycle.max(1));
                    let step_outputs = state
                        .get_pipeline_run(&issue.id)
                        .and_then(|run| run.output_context_for(&current_step.name))
                        .unwrap_or_default();
                    state.add_running(issue, Some(attempt));
                    (attempt, step_outputs)
                };

                let workspace_path = match self.prepare_step_workspace(issue, &current_config).await
                {
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
                        step_kind: current_step.kind,
                        tracker_state: current_step.tracker_state.as_deref(),
                        attempt: Some(attempt),
                        timeout_ms: Self::effective_step_timeout_ms(
                            current_step.timeout_ms,
                            &current_config,
                        ),
                        interaction_response: Some(interaction_response),
                        workspace_path,
                        step_outputs,
                    },
                )
                .await?;
            }
            InteractionResumeStrategy::AdvanceAfterStep => {
                let response =
                    interaction
                        .response
                        .clone()
                        .ok_or_else(|| AgentError::PromptError {
                            reason: format!(
                                "resolved interaction '{}' is missing a response",
                                interaction.id
                            ),
                        })?;

                let (action, dispatch_contexts) = {
                    let mut state = self.state.write().await;
                    let run = state.get_pipeline_run_mut(&issue.id).ok_or_else(|| {
                        AgentError::PromptError {
                            reason: format!(
                                "issue '{}' is missing a pipeline run during approval resume",
                                issue.identifier
                            ),
                        }
                    })?;

                    let action = match response {
                        InteractionResponse::Approval {
                            approved, reason, ..
                        } => {
                            if approved {
                                run.approve_gate(&current_step.name)
                            } else {
                                run.reject_gate(
                                    &current_step.name,
                                    reason.unwrap_or_else(|| {
                                        format!(
                                            "approval rejected for step '{}'",
                                            current_step.name
                                        )
                                    }),
                                )
                            }
                        }
                        _ => {
                            return Err(AgentError::PromptError {
                                reason: format!(
                                    "approval gate '{}' resolved with a non-approval response",
                                    interaction.id
                                ),
                            }
                            .into())
                        }
                    };

                    // Collect output contexts while the run is still accessible
                    let dispatch_contexts: Vec<(DispatchRequest, StepOutputTemplateContext)> =
                        if let PipelineAction::Dispatch(ref requests) = action {
                            let run = state.get_pipeline_run(&issue.id).unwrap();
                            requests
                                .iter()
                                .map(|req| {
                                    let step_outputs =
                                        run.output_context_for(&req.step_name).unwrap_or_default();
                                    (req.clone(), step_outputs)
                                })
                                .collect()
                        } else {
                            vec![]
                        };

                    (action, dispatch_contexts)
                };

                match action {
                    PipelineAction::Dispatch(_requests) => {
                        let attempt = {
                            let mut state = self.state.write().await;
                            let attempt = state
                                .get_pipeline_run(&issue.id)
                                .map(|run| run.cycle)
                                .unwrap_or(interaction.pipeline_cycle.max(1));
                            state.add_running(issue, Some(attempt));
                            attempt
                        };

                        for (req, step_outputs) in dispatch_contexts {
                            let workspace_path =
                                match self.prepare_step_workspace(issue, &current_config).await {
                                    Ok(path) => path,
                                    Err(error) => {
                                        let mut state = self.state.write().await;
                                        state.remove_running(&issue.id);
                                        state.release_claim(&issue.id);
                                        state.remove_pipeline_run(&issue.id);
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
                                    step_name: &req.step_name,
                                    agent_name: &req.agent_name,
                                    step_kind: req.step_kind,
                                    tracker_state: req.tracker_state.as_deref(),
                                    attempt: Some(attempt),
                                    timeout_ms: Self::effective_step_timeout_ms(
                                        req.timeout_ms,
                                        &current_config,
                                    ),
                                    interaction_response: None,
                                    workspace_path,
                                    step_outputs,
                                },
                            )
                            .await?;
                        }
                    }
                    PipelineAction::Succeeded => {
                        let finalize_state = self
                            .run_finalize_phase(&issue.id, &issue.identifier, &current_config)
                            .await;
                        let completed_at = Utc::now();
                        let (tracker_state, history_record, tracker_error_message) = {
                            let mut state = self.state.write().await;
                            let history_record =
                                state.waiting_on_human.get(&issue.id).and_then(|entry| {
                                    state.get_pipeline_run(&issue.id).map(|run| {
                                        self.build_history_record_from_waiting(
                                            &issue.id,
                                            HISTORY_OUTCOME_SUCCEEDED,
                                            None,
                                            entry,
                                            run,
                                            completed_at,
                                            state.artifacts.get(&issue.id).cloned(),
                                        )
                                    })
                                });

                            if matches!(
                                finalize_state.status,
                                FinalizeStatus::Succeeded | FinalizeStatus::NotRequired
                            ) {
                                // Add to completed BEFORE releasing claim (which removes waiting_on_human)
                                state.add_completed(
                                    issue.id.clone(),
                                    issue.identifier.clone(),
                                    "completed_succeeded".to_string(),
                                );
                                state.release_claim(&issue.id);
                                state.remove_pipeline_run(&issue.id);
                                state.clear_finalize_state(&issue.id);

                                (
                                    self.tracker
                                        .supports_writes()
                                        .then(|| current_config.on_success.clone()),
                                    history_record,
                                    "failed to set tracker success state after approval resume",
                                )
                            } else {
                                let tracker_state = (self.tracker.supports_writes()
                                    && matches!(
                                        finalize_state.status,
                                        FinalizeStatus::Failed | FinalizeStatus::SkippedHeadless
                                    ))
                                .then(|| current_config.on_failure.clone());

                                state.set_finalize_state(&issue.id, finalize_state);
                                state.remove_pipeline_run(&issue.id);

                                (
                                    tracker_state,
                                    None,
                                    "failed to set tracker failure state after approval finalize failure",
                                )
                            }
                        };

                        if let Some(tracker_state) = tracker_state {
                            if let Err(error) = self
                                .tracker
                                .set_issue_state(&issue.id, &tracker_state)
                                .await
                            {
                                warn!(
                                    issue_id = %issue.id,
                                    error = %error,
                                    "{tracker_error_message}"
                                );
                            }
                        }

                        if let Some(record) = history_record {
                            self.append_history_record(None, record).await;
                        }
                    }
                    PipelineAction::Failed { reason, .. } => {
                        let completed_at = Utc::now();
                        let history_record = {
                            let mut state = self.state.write().await;
                            let history_record =
                                state.waiting_on_human.get(&issue.id).and_then(|entry| {
                                    state.get_pipeline_run(&issue.id).map(|run| {
                                        self.build_history_record_from_waiting(
                                            &issue.id,
                                            HISTORY_OUTCOME_FAILED,
                                            Some(reason.clone()),
                                            entry,
                                            run,
                                            completed_at,
                                            state.artifacts.get(&issue.id).cloned(),
                                        )
                                    })
                                });

                            // Add to completed BEFORE releasing claim (which removes waiting_on_human)
                            state.add_completed(
                                issue.id.clone(),
                                issue.identifier.clone(),
                                "completed_failed".to_string(),
                            );
                            state.release_claim(&issue.id);
                            state.remove_pipeline_run(&issue.id);
                            state.clear_finalize_state(&issue.id);

                            history_record
                        };

                        if self.tracker.supports_writes() {
                            if let Err(error) = self
                                .tracker
                                .set_issue_state(&issue.id, &current_config.on_failure)
                                .await
                            {
                                warn!(
                                    issue_id = %issue.id,
                                    error = %error,
                                    "failed to set tracker failure state after approval rejection"
                                );
                            }
                        }

                        if let Some(record) = history_record {
                            self.append_history_record(None, record).await;
                        }
                    }
                    PipelineAction::Waiting
                    | PipelineAction::BlockedOnHuman { .. }
                    | PipelineAction::AwaitingApproval { .. } => {}
                }
            }
        }

        self.interaction_store.mark_resumed(&interaction.id).await?;

        let mut state = self.state.write().await;
        state.remove_waiting_on_human(&issue.id);
        let (run_id, sequence, attempt) = Self::run_context_for_issue(&mut state, &issue.id);
        let follow_up_sequence = run_id
            .as_ref()
            .map(|current_run_id| state.next_timeline_sequence(current_run_id));
        drop(state);

        self.publish_pipeline_event(
            run_id.clone(),
            sequence,
            attempt,
            PipelineEvent::InputResumed {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: current_step.name.clone(),
                detail: format!("resumed from interaction {}", interaction.id),
            },
        )
        .await;

        self.publish_pipeline_event(
            run_id,
            follow_up_sequence,
            attempt,
            PipelineEvent::StepResumedFromHumanReply {
                issue_identifier: issue.identifier.clone(),
                timestamp: Utc::now(),
                step_name: current_step.name.clone(),
                ask_id: interaction.id.clone(),
                detail: "step resumed after human reply".to_string(),
            },
        )
        .await;

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
                    FailureRetryRequest {
                        issue_id,
                        identifier: &retry_entry.identifier,
                        attempt: retry_entry.attempt + 1,
                        max_backoff_ms: config.agent.max_retry_backoff_ms,
                        max_cycles: config.max_cycles,
                        error: "retry poll failed",
                        retry_from_step: retry_entry.retry_from_step.clone(),
                        with_fixup: retry_entry.with_fixup,
                    },
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
                        FailureRetryRequest {
                            issue_id,
                            identifier: &retry_entry.identifier,
                            attempt: retry_entry.attempt + 1,
                            max_backoff_ms: config.agent.max_retry_backoff_ms,
                            max_cycles: config.max_cycles,
                            error: "no available orchestrator slots",
                            retry_from_step: retry_entry.retry_from_step.clone(),
                            with_fixup: retry_entry.with_fixup,
                        },
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

    async fn publish_pipeline_event(
        &self,
        run_id: Option<String>,
        sequence: Option<u64>,
        attempt: u32,
        event: PipelineEvent,
    ) {
        let timeline_entry = if let (Some(run_id), Some(sequence)) = (run_id, sequence) {
            Some((
                run_id.clone(),
                event.to_timeline_record(&run_id, sequence, attempt),
            ))
        } else {
            None
        };

        self.event_bus.publish(event);

        if let Some((run_id, record)) = timeline_entry {
            if let Some(ref persistence) = self.timeline_persistence {
                persistence.send(run_id, record);
            }
        }
    }

    fn run_context_for_issue(
        state: &mut OrchestratorState,
        issue_id: &str,
    ) -> (Option<String>, Option<u64>, u32) {
        let (run_id, attempt) = Self::run_metadata_for_issue(state, issue_id);
        let sequence = run_id
            .as_ref()
            .map(|run_id| state.next_timeline_sequence(run_id));
        (run_id, sequence, attempt)
    }

    fn run_metadata_for_issue(state: &OrchestratorState, issue_id: &str) -> (Option<String>, u32) {
        let run_id = state
            .running
            .get(issue_id)
            .and_then(|entry| entry.run_id.clone());
        let attempt = state
            .running
            .get(issue_id)
            .and_then(|entry| entry.retry_attempt)
            .unwrap_or(1);
        (run_id, attempt)
    }
}

async fn catch_worker_panic<F>(fut: F, issue_id: &str, step_name: &str) -> WorkerResult
where
    F: std::future::Future<Output = Result<WorkerResult, AgentError>>,
{
    match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(Ok(result)) => result,
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
        Err(_) => {
            warn!(issue_id, step = step_name, "worker task panicked");
            WorkerResult::Failed {
                error: "worker task panicked".to_string(),
                kind: WorkerFailureKind::Runtime,
            }
        }
    }
}

fn transcript_kind_from_agent_kind(
    kind: crate::agent::protocol::TranscriptBlockKind,
) -> TranscriptRecordKind {
    match kind {
        crate::agent::protocol::TranscriptBlockKind::AssistantMessage => {
            TranscriptRecordKind::AssistantMessage
        }
        crate::agent::protocol::TranscriptBlockKind::Reasoning => TranscriptRecordKind::Reasoning,
        crate::agent::protocol::TranscriptBlockKind::ToolCall => TranscriptRecordKind::ToolCall,
        crate::agent::protocol::TranscriptBlockKind::ToolResult => TranscriptRecordKind::ToolResult,
        crate::agent::protocol::TranscriptBlockKind::PermissionRequest => {
            TranscriptRecordKind::PermissionRequest
        }
        crate::agent::protocol::TranscriptBlockKind::TurnComplete => {
            TranscriptRecordKind::TurnComplete
        }
        crate::agent::protocol::TranscriptBlockKind::Raw => TranscriptRecordKind::Raw,
    }
}

fn new_run_id() -> String {
    let millis = Utc::now().timestamp_millis();
    let seq = RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run-{millis}-{seq}")
}

fn build_interaction_request(
    issue: &Issue,
    context: InteractionRequestContext,
    request: InteractionRequestDraft,
    resume_strategy: InteractionResumeStrategy,
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
        resume_strategy,
        title: request.title,
        body: request.body,
        options: request.options,
        artifacts: request.artifacts,
        response: None,
        waiting_started_at: None,
        agent_input_tokens: 0,
        agent_output_tokens: 0,
        agent_total_tokens: 0,
        requested_at,
        resolved_at: None,
        thread_root_comment_id: None,
        thread_root_comment_url: None,
        last_processed_comment_id: None,
        accepted_command: None,
        ignored_commands: vec![],
    }
}

fn format_interaction_thread_root_comment(
    interaction: &crate::interaction::InteractionRequest,
) -> String {
    format!(
        concat!(
            "Ensemble requires input to continue.\n\n",
            "**Interaction ID:** `{}`\n",
            "**Kind:** `{}`\n\n",
            "{}\n\n",
            "Valid commands:\n",
            "- `/approve`\n",
            "- `/reject <reason>`\n",
            "- `/answer <text>`\n\n",
            "<!-- ensemble:interaction:{} -->"
        ),
        interaction.id,
        match interaction.kind {
            InteractionKind::Question => "question",
            InteractionKind::Approval => "approval",
            InteractionKind::Handoff => "handoff",
        },
        interaction.body,
        interaction.id
    )
}

fn response_from_command(
    kind: &InteractionKind,
    command: &InteractionCommand,
) -> Option<InteractionResponse> {
    match (kind, command) {
        (InteractionKind::Question, InteractionCommand::Answer { text }) => {
            Some(InteractionResponse::Question {
                response_schema_version: 1,
                text: text.clone(),
                selected_option: None,
            })
        }
        (InteractionKind::Approval, InteractionCommand::Approve) => {
            Some(InteractionResponse::Approval {
                response_schema_version: 1,
                approved: true,
                reason: None,
            })
        }
        (InteractionKind::Approval, InteractionCommand::Reject { reason }) => {
            Some(InteractionResponse::Approval {
                response_schema_version: 1,
                approved: false,
                reason: Some(reason.clone()),
            })
        }
        (InteractionKind::Handoff, InteractionCommand::Approve) => {
            Some(InteractionResponse::Handoff {
                response_schema_version: 1,
                completed: true,
                notes: None,
            })
        }
        (InteractionKind::Handoff, InteractionCommand::Reject { reason }) => {
            Some(InteractionResponse::Handoff {
                response_schema_version: 1,
                completed: false,
                notes: Some(reason.clone()),
            })
        }
        (InteractionKind::Handoff, InteractionCommand::Answer { text }) => {
            Some(InteractionResponse::Handoff {
                response_schema_version: 1,
                completed: true,
                notes: Some(text.clone()),
            })
        }
        _ => None,
    }
}

trait InteractionCommandExt {
    fn command_name(&self) -> &'static str;
}

impl InteractionCommandExt for InteractionCommand {
    fn command_name(&self) -> &'static str {
        match self {
            InteractionCommand::Approve => "/approve",
            InteractionCommand::Reject { .. } => "/reject",
            InteractionCommand::Answer { .. } => "/answer",
        }
    }
}

fn sanitize_interaction_fragment(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn interaction_kind_name(kind: &InteractionKind) -> &'static str {
    match kind {
        InteractionKind::Question => "question",
        InteractionKind::Approval => "approval",
        InteractionKind::Handoff => "handoff",
    }
}

fn validate_restored_snapshot_against_config(
    snapshot: &PipelineRunSnapshot,
    config: &EnsembleConfig,
) -> Result<(), EnsembleError> {
    for persisted_step in &snapshot.dag_steps {
        if snapshot
            .synthetic_fixup_steps
            .contains(&persisted_step.name)
        {
            continue;
        }

        let Some(config_step) = config
            .steps
            .iter()
            .find(|candidate| candidate.name == persisted_step.name)
        else {
            return Err(AgentError::PromptError {
                reason: format!(
                    "persisted pipeline step '{}' no longer exists in config",
                    persisted_step.name
                ),
            }
            .into());
        };

        if config_step.agent != persisted_step.agent || config_step.kind != persisted_step.kind {
            return Err(AgentError::PromptError {
                reason: format!(
                    "persisted pipeline step '{}' no longer matches config",
                    persisted_step.name
                ),
            }
            .into());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{
        AgentEvent, InteractionRequestDraft, StepApprovalRequestDraft, WorkerEvent, WorkerResult,
    };
    use crate::config::ensemble::{parse_config, ConcurrencyConfig};
    use crate::error::AgentError;
    use crate::interaction::{
        InteractionKind, InteractionResponse, InteractionResumeStrategy, InteractionStatus,
        InteractionStore,
    };
    use crate::orchestrator::pipeline_journal::{PipelineTransitionInput, PipelineTransitionKind};
    use crate::orchestrator::retry::current_time_ms;
    use crate::pipeline::verdict::{StepOutput, StepResult};
    use crate::tracker::model::RetryEntry;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;

    /// Mock tracker for orchestrator tests.
    struct MockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    struct CommandMockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        comments: Arc<RwLock<Vec<crate::tracker::model::TrackerComment>>>,
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

        async fn create_interaction_thread_root(
            &self,
            id: &str,
            _body: &str,
        ) -> Result<crate::tracker::model::InteractionThreadRoot, TrackerError> {
            Ok(crate::tracker::model::InteractionThreadRoot {
                comment_id: format!("root-{id}"),
                comment_url: None,
            })
        }

        async fn list_comments_after(
            &self,
            _id: &str,
            _after_comment_id: &str,
        ) -> Result<Vec<crate::tracker::model::TrackerComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl IssueTracker for CommandMockTracker {
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

        async fn create_interaction_thread_root(
            &self,
            id: &str,
            _body: &str,
        ) -> Result<crate::tracker::model::InteractionThreadRoot, TrackerError> {
            Ok(crate::tracker::model::InteractionThreadRoot {
                comment_id: format!("root-{id}"),
                comment_url: None,
            })
        }

        async fn list_comments_after(
            &self,
            _id: &str,
            _after_comment_id: &str,
        ) -> Result<Vec<crate::tracker::model::TrackerComment>, TrackerError> {
            Ok(self.comments.read().await.clone())
        }
    }

    struct CommentRecordingTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        comments: Arc<RwLock<Vec<(String, String)>>>,
    }

    #[async_trait]
    impl IssueTracker for CommentRecordingTracker {
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

        async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
            self.comments
                .write()
                .await
                .push((id.to_string(), body.to_string()));
            Ok(())
        }
    }

    /// Mock agent runner that completes immediately.
    struct MockRunner {
        delay_ms: u64,
        observed_commands: Option<Arc<RwLock<Vec<String>>>>,
        observed_timeouts: Option<Arc<RwLock<Vec<u64>>>>,
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
                timeout_ms,
                ..
            } = request;
            if let Some(observed_commands) = &self.observed_commands {
                observed_commands
                    .write()
                    .await
                    .push(config.agent.command.clone());
            }
            if let Some(observed_timeouts) = &self.observed_timeouts {
                observed_timeouts.write().await.push(timeout_ms);
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
            Ok(WorkerResult::Success {
                output: succeeded_step_output(),
                approval_request: None,
            })
        }
    }

    fn succeeded_step_output() -> crate::pipeline::verdict::StepOutput {
        crate::pipeline::verdict::StepOutput {
            result: crate::pipeline::verdict::StepResult::Succeeded,
            summary: None,
            output: None,
        }
    }

    fn failed_step_output(summary: &str) -> crate::pipeline::verdict::StepOutput {
        crate::pipeline::verdict::StepOutput {
            result: crate::pipeline::verdict::StepResult::Failed {
                summary: summary.to_string(),
            },
            summary: Some(summary.to_string()),
            output: None,
        }
    }

    struct PanicRunner;

    #[async_trait]
    impl AgentRunner for PanicRunner {
        async fn run(&self, _request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            panic!("boom");
        }
    }

    struct RecordingTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        state_writes: Arc<RwLock<Vec<(String, String)>>>,
    }

    #[async_trait]
    impl IssueTracker for RecordingTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.read().await.clone())
        }

        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            let states_lower: Vec<String> =
                states.iter().map(|state| state.to_lowercase()).collect();
            Ok(issues
                .iter()
                .filter(|issue| states_lower.contains(&issue.state.to_lowercase()))
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
                .filter(|issue| ids.contains(&issue.id))
                .cloned()
                .collect())
        }

        fn supports_writes(&self) -> bool {
            true
        }

        async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
            self.state_writes
                .write()
                .await
                .push((id.to_string(), state.to_string()));
            Ok(())
        }
    }

    struct FailingWriteTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    #[async_trait]
    impl IssueTracker for FailingWriteTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.read().await.clone())
        }

        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            let states_lower: Vec<String> =
                states.iter().map(|state| state.to_lowercase()).collect();
            Ok(issues
                .iter()
                .filter(|issue| states_lower.contains(&issue.state.to_lowercase()))
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
                .filter(|issue| ids.contains(&issue.id))
                .cloned()
                .collect())
        }

        fn supports_writes(&self) -> bool {
            true
        }

        async fn set_issue_state(&self, _id: &str, _state: &str) -> Result<(), TrackerError> {
            Err(TrackerError::ApiRequestFailed {
                reason: "simulated tracker write failure".to_string(),
            })
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
  permission_request_policy:
    mode: approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    fn make_retry_step_config() -> EnsembleConfig {
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
    on_failure: retry_step
  - name: test
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
  permission_request_policy:
    mode: approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    #[tokio::test]
    async fn restore_pipeline_runs_from_journal_restores_halted_pipeline() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_retry_step_config();
        let issue = test_issue("1", "Todo");
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
        let workspace_root = temp.path().join("workspaces");
        let workspace_mgr = WorkspaceManager::new(&workspace_root, None).unwrap();
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                workspace_mgr,
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
        run.step_failed("build", "manual halt".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineHalted,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("manual halt".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
            })
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;

        let lock = state.read().await;
        assert!(lock.get_pipeline_run(&issue.id).is_some());
        assert!(lock.is_claimed(&issue.id));
        assert!(lock.is_waiting_on_human(&issue.id));
    }

    #[tokio::test]
    async fn restore_pipeline_runs_from_journal_restores_step_retry_entry() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_retry_step_config();
        let issue = test_issue("1", "Todo");
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
        run.retry_from_step("build");
        let retry = RetryEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            attempt: 2,
            due_at_ms: current_time_ms().saturating_sub(1),
            error: Some("retry".to_string()),
            retry_from_step: Some("build".to_string()),
            with_fixup: false,
        };
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("retry".to_string()),
                retry: Some(retry),
                snapshot: Some(run.to_snapshot()),
            })
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;

        let lock = state.read().await;
        assert!(lock.get_pipeline_run(&issue.id).is_some());
        assert!(lock.retry_attempts.contains_key(&issue.id));
        assert_eq!(
            lock.retry_attempts
                .get(&issue.id)
                .and_then(|entry| entry.retry_from_step.as_deref()),
            Some("build")
        );
    }

    #[tokio::test]
    async fn restored_live_pipeline_run_dispatches_on_next_tick() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
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
        let run = PipelineRun::new(issue.id.clone(), 1, dag);
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::RunStarted,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
            })
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        assert!(state.read().await.is_claimed(&issue.id));

        orchestrator.handle_tick().await;

        let lock = state.read().await;
        assert!(lock.is_running(&issue.id));
        assert!(matches!(
            lock.get_pipeline_run(&issue.id)
                .and_then(|run| run.step_states.get("build")),
            Some(StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn hydrate_waiting_interaction_keeps_restored_pipeline_run() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
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

        let interaction = crate::interaction::model::InteractionRequest {
            id: "interaction-1".to_string(),
            schema_version: 1,
            issue_id: issue.id.clone(),
            issue_identifier: issue.identifier.clone(),
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
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: "Need input".to_string(),
            body: "Need input".to_string(),
            options: vec![],
            artifacts: vec![],
            thread_root_comment_id: None,
            thread_root_comment_url: None,
            last_processed_comment_id: None,
            accepted_command: None,
            ignored_commands: vec![],
            response: None,
            waiting_started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            resolved_at: None,
        };
        orchestrator
            .interaction_store
            .create(interaction)
            .await
            .unwrap();

        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.step_blocked_on_human("build", "interaction-1".to_string());
        {
            let mut lock = state.write().await;
            lock.insert_pipeline_run(&issue.id, run, Arc::new(cfg.clone()));
            lock.add_claimed(&issue.id);
        }

        orchestrator.hydrate_waiting_on_human_from_store().await;

        let lock = state.read().await;
        let run = lock.get_pipeline_run(&issue.id).unwrap();
        assert!(matches!(
            run.step_states.get("build"),
            Some(StepState::BlockedOnHuman { interaction_request_id })
                if interaction_request_id == "interaction-1"
        ));
        assert!(lock.is_waiting_on_human(&issue.id));
    }

    #[tokio::test]
    async fn dispatch_issue_writes_run_started_and_step_running_transitions() {
        let temp = tempfile::tempdir().unwrap();
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let cfg = make_config();
        let config = Arc::new(RwLock::new(cfg.clone()));
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        drop(shutdown_tx);
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state,
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

        orchestrator.handle_tick().await;

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert!(records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::RunStarted));
        assert!(records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::StepRunning));
    }

    #[tokio::test]
    async fn failed_step_retry_writes_retry_transition_as_latest_record() {
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
            Arc::clone(&config),
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
                WorkerResult::Success {
                    output: failed_step_output("tests failed"),
                    approval_request: None,
                },
            )
            .await;

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        let latest = records.last().expect("journal record");
        assert_eq!(latest.kind, PipelineTransitionKind::StepRetryScheduled);
        assert_eq!(
            latest
                .retry
                .as_ref()
                .and_then(|retry| retry.retry_from_step.as_deref()),
            Some("build")
        );
        assert!(matches!(
            latest
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.step_states.get("build")),
            Some(StepState::Pending)
        ));
    }

    #[tokio::test]
    async fn restored_all_passed_pipeline_completes_on_next_tick() {
        let temp = tempfile::tempdir().unwrap();
        let issue = test_issue("1", "Todo");
        let issues = Arc::new(RwLock::new(vec![issue.clone()]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let cfg = make_config();
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
        run.step_completed(
            "build",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: None,
            },
            false,
        );
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepCompleted,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("succeeded".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
            })
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.handle_tick().await;

        let lock = state.read().await;
        assert!(
            lock.completed.contains_key(&issue.id),
            "restored all-passed pipeline should complete"
        );
        assert!(
            lock.get_pipeline_run(&issue.id).is_none(),
            "completed restored pipeline should be released"
        );
        assert!(
            !lock.is_running(&issue.id),
            "completed restored pipeline should not remain running"
        );
    }

    fn make_fixup_config() -> EnsembleConfig {
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
  fixer:
    executor: claude
    model: opus
    prompt: "Fix {{ issue.identifier }}."
steps:
  - name: build
    agent: builder
  - name: review
    agent: builder
    on_failure: fixup
    fixup_agent: fixer
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
  permission_request_policy:
    mode: approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    fn make_halt_config() -> EnsembleConfig {
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
    on_failure: halt
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
  permission_request_policy:
    mode: approve_all
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

    fn make_when_requested_approval_config() -> EnsembleConfig {
        let yaml = r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress", "Plan Review"]
  terminal_states: ["Done", "Closed", "Failed"]
agents:
  builder:
    executor: claude
    model: opus
    prompt: "Work on {{ issue.identifier }}."
steps:
  - name: build
    agent: builder
    approval:
      mode: when_requested_by_agent
  - name: review
    agent: builder
    depends: ["build"]
max_cycles: 10
on_success: Done
on_failure: Failed
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

    fn make_always_approval_config(max_cycles: u32) -> EnsembleConfig {
        let yaml = format!(
            r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress", "Plan Review"]
  terminal_states: ["Done", "Closed", "Failed"]
agents:
  builder:
    executor: claude
    model: opus
    prompt: "Work on {{{{ issue.identifier }}}}."
steps:
  - name: build
    agent: builder
    approval:
      mode: always
      state: Plan Review
  - name: review
    agent: builder
    depends: ["build"]
max_cycles: {max_cycles}
on_success: Done
on_failure: Failed
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
"#
        );
        parse_config(&yaml).unwrap()
    }

    fn make_single_step_always_approval_config(max_cycles: u32) -> EnsembleConfig {
        let yaml = format!(
            r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress", "Plan Review"]
  terminal_states: ["Done", "Closed", "Failed"]
agents:
  builder:
    executor: claude
    model: opus
    prompt: "Work on {{{{ issue.identifier }}}}."
steps:
  - name: build
    agent: builder
    approval:
      mode: always
      state: Plan Review
max_cycles: {max_cycles}
on_success: Done
on_failure: Failed
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
"#
        );
        parse_config(&yaml).unwrap()
    }

    async fn write_raw_interaction(
        config_dir: &std::path::Path,
        interaction_id: &str,
        payload: serde_json::Value,
    ) {
        let store = InteractionStore::new(config_dir.to_path_buf());
        let path = store
            .interactions_dir()
            .join(format!("{interaction_id}.json"));
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, serde_json::to_vec_pretty(&payload).unwrap())
            .await
            .unwrap();
    }

    #[test]
    fn run_id_has_expected_prefix() {
        let run_id = new_run_id();
        assert!(run_id.starts_with("run-"));
        assert!(run_id.len() > 8);
    }

    fn make_non_alphabetical_two_step_config() -> EnsembleConfig {
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
  - name: z-build
    agent: builder
  - name: a-review
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
            observed_timeouts: None,
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

        orchestrator.dispatch_issue(&issue, Some(1)).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(*observed_timeouts.read().await, vec![1234]);
    }

    #[tokio::test]
    async fn test_orchestrator_handles_worker_exit_success() {
        let config = Arc::new(RwLock::new(make_config()));
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
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: None,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        // With a single-step pipeline, success should complete the pipeline
        assert!(
            state.completed.contains_key("1") || state.retry_attempts.contains_key("1"),
            "should be completed or retrying"
        );
    }

    #[tokio::test]
    async fn pipeline_failure_retry_step_preserves_run_and_schedules_step_retry() {
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
            Arc::clone(&config),
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
                WorkerResult::Success {
                    output: failed_step_output("tests failed"),
                    approval_request: None,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        let retry = state
            .retry_attempts
            .get("1")
            .expect("retry should be queued");
        assert_eq!(retry.retry_from_step.as_deref(), Some("build"));
        assert!(!retry.with_fixup);
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.running.contains_key("1"));
        assert!(!state.completed.contains_key("1"));

        let run = state.get_pipeline_run("1").unwrap();
        assert!(matches!(
            run.step_states.get("build"),
            Some(StepState::Pending)
        ));
        assert!(matches!(
            run.step_states.get("test"),
            Some(StepState::Pending)
        ));
    }

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
        drop(state);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert!(
            records
                .iter()
                .any(|record| record.kind == PipelineTransitionKind::StepFailed),
            "timeout should record the initial step failure transition"
        );
        assert!(
            records
                .iter()
                .any(|record| record.kind == PipelineTransitionKind::StepRetryScheduled),
            "timeout should record the follow-up step retry transition"
        );
    }

    #[tokio::test]
    async fn synthetic_fixup_failure_halts_for_manual_intervention() {
        let config = Arc::new(RwLock::new(make_fixup_config()));
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
            Arc::clone(&config),
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
            pipeline_run.step_completed(
                "build",
                StepOutput {
                    result: StepResult::Succeeded,
                    summary: None,
                    output: None,
                },
                false,
            );
            pipeline_run.retry_from_step_with_fixup("review", "fixer");
            pipeline_run.mark_running("fixup-review", "session-fixup".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), Some(2));
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "fixup-review",
                WorkerResult::Success {
                    output: failed_step_output("fixup could not repair"),
                    approval_request: None,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(!state.running.contains_key("1"));
        assert!(state.waiting_on_human.contains_key("1"));
        assert!(state.is_claimed("1"));

        let waiting = state.waiting_on_human.get("1").unwrap();
        assert_eq!(waiting.step_name, "fixup-review");
        assert_eq!(waiting.agent_name, "fixer");
        assert_eq!(waiting.prompt, "fixup could not repair");
        assert!(matches!(waiting.kind, InteractionKind::Handoff));
    }

    #[tokio::test]
    async fn pipeline_failure_halt_preserves_run_and_waits_on_human() {
        let config = Arc::new(RwLock::new(make_halt_config()));
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
            Arc::clone(&config),
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
                WorkerResult::Success {
                    output: failed_step_output("needs manual repair"),
                    approval_request: None,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(!state.running.contains_key("1"));
        assert!(state.waiting_on_human.contains_key("1"));
        assert!(state.is_claimed("1"));

        let waiting = state.waiting_on_human.get("1").unwrap();
        assert_eq!(waiting.step_name, "build");
        assert_eq!(waiting.prompt, "needs manual repair");
        assert!(matches!(waiting.kind, InteractionKind::Handoff));
        drop(state);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert_eq!(
            records.last().map(|record| record.kind),
            Some(PipelineTransitionKind::PipelineHalted)
        );
    }

    #[tokio::test]
    async fn test_worker_exit_uses_typed_step_output() {
        let config = Arc::new(RwLock::new(make_halt_config()));
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

        {
            let cfg = config.read().await;
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        let workspace = orchestrator
            .workspace_mgr
            .workspace_path("repo#1")
            .expect("workspace path");
        tokio::fs::create_dir_all(workspace.join(".ensemble"))
            .await
            .unwrap();
        tokio::fs::write(
            workspace.join(".ensemble").join("verdict-build.json"),
            r#"{"verdict":"reject","summary":"broken"}"#,
        )
        .await
        .unwrap();

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Success {
                    output: failed_step_output("tests failed"),
                    approval_request: None,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(matches!(
            state
                .get_pipeline_run("1")
                .and_then(|run| run.step_states.get("build")),
            Some(StepState::Failed { summary }) if summary == "tests failed"
        ));
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn terminal_rejection_posts_one_tracker_comment_after_retries_are_exhausted() {
        let mut raw_config = make_config();
        raw_config.max_cycles = 2;
        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![]));
        let comments = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommentRecordingTracker {
            issues,
            comments: Arc::clone(&comments),
        });
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        for attempt in [None, Some(1)] {
            {
                let cfg = config.read().await;
                let mut state = orchestrator.state.write().await;
                state.add_running(&test_issue("1", "Todo"), attempt);
                let dag = build_dag(&cfg.steps).unwrap();
                let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
                pipeline_run.start();
                pipeline_run.mark_running("build", "session-1".to_string());
                state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            }

            let workspace = orchestrator
                .workspace_mgr
                .workspace_path("repo#1")
                .expect("workspace path");
            tokio::fs::create_dir_all(workspace.join(".ensemble"))
                .await
                .unwrap();
            tokio::fs::write(
                workspace.join(".ensemble").join("verdict-build.json"),
                r#"{"verdict":"reject","summary":"tests failed"}"#,
            )
            .await
            .unwrap();

            orchestrator
                .handle_worker_exit(
                    "1",
                    "build",
                    WorkerResult::Success {
                        output: failed_step_output("tests failed"),
                        approval_request: None,
                    },
                )
                .await;
        }

        let comments = comments.read().await;
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].0, "1");
        assert!(comments[0].1.contains("Ensemble pipeline rejected"));
        assert!(comments[0].1.contains("tests failed"));
    }

    #[tokio::test]
    async fn test_orchestrator_writes_history_record_on_completion() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_config();
        raw_config.workspace.root = Some(dir.path().display().to_string());

        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: None,
                },
            )
            .await;

        let history_path = dir.path().join("ensemble_history.jsonl");
        let contents = tokio::fs::read_to_string(&history_path).await.unwrap();
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .unwrap();

        assert_eq!(record.issue_id, "1");
        assert_eq!(record.outcome, "succeeded");
        assert_eq!(record.verdict.as_deref(), Some("approved"));
    }

    #[tokio::test]
    async fn test_orchestrator_writes_history_record_on_terminal_failure() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_config();
        raw_config.workspace.root = Some(dir.path().display().to_string());
        raw_config.max_cycles = 1;

        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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
            state.add_running(&test_issue("1", "Todo"), Some(1));
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Failed {
                    error: "agent crashed".to_string(),
                    kind: WorkerFailureKind::Runtime,
                },
            )
            .await;

        let history_path = dir.path().join("ensemble_history.jsonl");
        let contents = tokio::fs::read_to_string(&history_path).await.unwrap();
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .unwrap();

        assert_eq!(record.issue_id, "1");
        assert_eq!(record.outcome, "failed");
        assert_eq!(record.attempts, 1);
        assert_eq!(record.last_error.as_deref(), Some("agent crashed"));
        assert_eq!(record.verdict.as_deref(), Some("failed"));
    }

    #[tokio::test]
    async fn test_orchestrator_does_not_write_history_record_on_retryable_failure() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_config();
        raw_config.workspace.root = Some(dir.path().display().to_string());
        raw_config.max_cycles = 3;

        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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
            state.add_running(&test_issue("1", "Todo"), Some(1));
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Failed {
                    error: "temporary agent crash".to_string(),
                    kind: WorkerFailureKind::Runtime,
                },
            )
            .await;

        let history_path = dir.path().join("ensemble_history.jsonl");
        assert!(
            tokio::fs::read_to_string(&history_path).await.is_err(),
            "retryable failure should not append history"
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
                    kind: WorkerFailureKind::Runtime,
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
            observed_timeouts: None,
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
            observed_timeouts: None,
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
            observed_timeouts: None,
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
                retry_from_step: None,
                with_fixup: false,
            });
        }

        // Handle the retry
        let retry_entry = crate::tracker::model::RetryEntry {
            issue_id: "gone".to_string(),
            identifier: "repo#gone".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
            retry_from_step: None,
            with_fixup: false,
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
            observed_timeouts: None,
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
                state.retry_attempts.contains_key("1") || state.completed.contains_key("1"),
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
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let refresh_requested = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            60_000,
            &ConcurrencyConfig::default(),
        )));
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
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root: dir.path().to_path_buf(),
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
            observed_timeouts: None,
            cancellation_probe: Some(Arc::new(std::sync::Mutex::new(Some(probe_tx)))),
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let refresh_requested = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            100,
            &ConcurrencyConfig::default(),
        )));
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
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root: dir.path().to_path_buf(),
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
    async fn dispatch_issue_reuses_existing_pipeline_run_for_step_retry() {
        let config = Arc::new(RwLock::new(make_retry_step_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 1000,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        let issue = test_issue("1", "Todo");

        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());
            pipeline_run.step_completed(
                "build",
                StepOutput {
                    result: StepResult::Succeeded,
                    summary: None,
                    output: None,
                },
                false,
            );
            pipeline_run.retry_from_step("test");

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator.dispatch_issue(&issue, Some(2)).await;

        let state = orchestrator.state.read().await;
        assert!(state.running.contains_key("1"));
        let run = state.get_pipeline_run("1").expect("pipeline run");
        assert_eq!(run.cycle, 2);
        assert!(matches!(
            run.step_states.get("build"),
            Some(StepState::Passed)
        ));
        assert!(matches!(
            run.step_states.get("test"),
            Some(StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn blocked_issue_releases_running_slot_and_stays_claimed() {
        let config = Arc::new(RwLock::new(make_config()));
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
                        kind: InteractionKind::BrainstormPrompt,
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
            observed_timeouts: None,
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
                        kind: InteractionKind::BrainstormPrompt,
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
    async fn worker_success_with_approval_request_creates_approval_gate_interaction() {
        let config = Arc::new(RwLock::new(make_when_requested_approval_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues,
            state_writes: tracker_writes.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
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
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: Some(StepApprovalRequestDraft {
                        schema_version: 1,
                        title: "Approve plan".to_string(),
                        body: "Please review the generated plan.".to_string(),
                        state: Some("Plan Review".to_string()),
                    }),
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        let waiting = state
            .waiting_on_human
            .get("1")
            .expect("approval gate should block the issue");
        let interaction_request_id = waiting.interaction_request_id.clone();
        assert_eq!(waiting.kind, InteractionKind::ApprovalGate);
        let run = state
            .get_pipeline_run("1")
            .expect("pipeline run should remain active while awaiting approval");
        assert!(matches!(
            run.step_states.get("build"),
            Some(crate::pipeline::engine::StepState::AwaitingApproval {
                interaction_request_id: Some(_),
            })
        ));
        assert_eq!(
            run.step_states.get("review"),
            Some(&crate::pipeline::engine::StepState::Pending)
        );
        drop(state);

        let store = InteractionStore::new(config_dir.path().to_path_buf());
        let interaction = store
            .get(&interaction_request_id)
            .await
            .unwrap()
            .expect("approval interaction should be persisted");
        assert_eq!(interaction.kind, InteractionKind::ApprovalGate);
        assert_eq!(interaction.title, "Approve plan");
        assert_eq!(interaction.body, "Please review the generated plan.");
        assert_eq!(
            tracker_writes.read().await.as_slice(),
            &[("1".to_string(), "Plan Review".to_string())]
        );
    }

    #[tokio::test]
    async fn resolved_approval_gate_resumes_into_next_step_without_rerunning_current_step() {
        let config = Arc::new(RwLock::new(make_always_approval_config(10)));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config_dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        write_raw_interaction(
            config_dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": true,
                    "reason": "looks good"
                },
                "requested_at": Utc::now(),
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("approval gate resume should succeed");

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        let run = state
            .get_pipeline_run("1")
            .expect("pipeline run should be reconstructed");
        assert_eq!(
            run.step_states.get("build"),
            Some(&crate::pipeline::engine::StepState::Passed)
        );
        assert!(matches!(
            run.step_states.get("review"),
            Some(crate::pipeline::engine::StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn rejected_approval_gate_marks_issue_failed() {
        let config = Arc::new(RwLock::new(make_always_approval_config(1)));
        let tracker_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues: Arc::new(RwLock::new(vec![])),
            state_writes: tracker_writes.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config_dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        write_raw_interaction(
            config_dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": false,
                    "reason": "needs more work"
                },
                "requested_at": Utc::now(),
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("rejected approval gate should resolve into failure");

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_claimed("1"));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);

        assert_eq!(
            tracker_writes.read().await.as_slice(),
            &[("1".to_string(), "Failed".to_string())]
        );
    }

    #[tokio::test]
    async fn rejected_approval_gate_is_marked_terminal_locally_when_tracker_failure_write_fails() {
        let config = Arc::new(RwLock::new(make_always_approval_config(1)));
        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWriteTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config_dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        write_raw_interaction(
            config_dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": false,
                    "reason": "needs more work"
                },
                "requested_at": Utc::now(),
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("rejected approval gate should still resolve locally");

        let state = orchestrator.state.read().await;
        assert!(state.completed.contains_key("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
    }

    #[tokio::test]
    async fn approved_final_step_gate_appends_history_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_single_step_always_approval_config(10);
        raw_config.workspace.root = Some(dir.path().display().to_string());
        let config = Arc::new(RwLock::new(raw_config));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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

        write_raw_interaction(
            dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": true,
                    "reason": "looks good"
                },
                "requested_at": Utc::now(),
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("approval gate resume should succeed");

        let contents = tokio::fs::read_to_string(dir.path().join("ensemble_history.jsonl"))
            .await
            .expect("history should be written");
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .expect("history record");

        assert_eq!(record.issue_id, "1");
        assert_eq!(record.outcome, "succeeded");
        assert_eq!(record.verdict.as_deref(), Some("approved"));
    }

    #[tokio::test]
    async fn rejected_final_step_gate_appends_history_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_single_step_always_approval_config(1);
        raw_config.workspace.root = Some(dir.path().display().to_string());
        let config = Arc::new(RwLock::new(raw_config));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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

        write_raw_interaction(
            dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": false,
                    "reason": "needs more work"
                },
                "requested_at": Utc::now(),
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("rejected approval gate should resolve into failure");

        let contents = tokio::fs::read_to_string(dir.path().join("ensemble_history.jsonl"))
            .await
            .expect("history should be written");
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .expect("history record");

        assert_eq!(record.issue_id, "1");
        assert_eq!(record.outcome, "failed");
        assert_eq!(record.last_error.as_deref(), Some("needs more work"));
        assert_eq!(record.verdict.as_deref(), Some("rejected"));
    }

    #[tokio::test]
    async fn approved_final_step_gate_after_restart_uses_persisted_waiting_metadata_for_history() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut raw_config = make_single_step_always_approval_config(10);
        raw_config.workspace.root = Some(dir.path().display().to_string());
        let config = Arc::new(RwLock::new(raw_config));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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

        let requested_at = Utc::now();
        let waiting_started_at = requested_at - chrono::Duration::minutes(3);
        write_raw_interaction(
            dir.path(),
            "approval-1",
            serde_json::json!({
                "id": "approval-1",
                "schema_version": 1,
                "issue_id": "1",
                "issue_identifier": "repo#1",
                "pipeline_cycle": 1,
                "completed_steps": [],
                "step_name": "build",
                "agent_name": "builder",
                "step_depends": [],
                "step_tracker_state": null,
                "kind": "approval_gate",
                "status": "resolved",
                "blocking": true,
                "awaiting_resume": true,
                "resume_strategy": "advance_after_step",
                "title": "Approve build",
                "body": "Please review the build output.",
                "options": [],
                "artifacts": [],
                "response": {
                    "kind": "approval",
                    "response_schema_version": 1,
                    "approved": true,
                    "reason": "looks good"
                },
                "waiting_started_at": waiting_started_at,
                "agent_input_tokens": 123,
                "agent_output_tokens": 45,
                "agent_total_tokens": 168,
                "requested_at": requested_at,
                "resolved_at": Utc::now(),
            }),
        )
        .await;

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("approval gate resume should succeed after restart");

        let contents = tokio::fs::read_to_string(dir.path().join("ensemble_history.jsonl"))
            .await
            .expect("history should be written");
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .expect("history record");

        assert_eq!(record.started_at, waiting_started_at);
        assert_eq!(record.tokens.input_tokens, 123);
        assert_eq!(record.tokens.output_tokens, 45);
        assert_eq!(record.tokens.total_tokens, 168);
    }

    #[tokio::test]
    async fn blocked_step_keeps_running_state_while_parallel_sibling_is_still_running() {
        let config = Arc::new(RwLock::new(make_parallel_resume_config()));
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
                        kind: InteractionKind::BrainstormPrompt,
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

        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.step_completed(
                "build",
                StepOutput {
                    result: StepResult::Succeeded,
                    summary: None,
                    output: None,
                },
                false,
            );
            pipeline_run.step_blocked_on_human("review", "interaction-1".to_string());
            pipeline_run.mark_running("docs", "session-docs".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "review".to_string(),
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
            });
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        orchestrator
            .handle_worker_exit(
                "1",
                "docs",
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: None,
                },
            )
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: Some(InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                }),
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: Some(Utc::now()),
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
    async fn thread_answer_command_resolves_open_interaction_on_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let comment_ts = Utc::now();
        let comments = Arc::new(RwLock::new(vec![crate::tracker::model::TrackerComment {
            comment_id: "c-1".to_string(),
            body: "/answer use staging\n\n<!-- ensemble:interaction:interaction-1 -->".to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker { issues, comments });
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

        {
            let mut state = orchestrator.state.write().await;
            let cfg = config.read().await;
            state.init_state_lists(&cfg);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                kind: InteractionKind::Question,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                resume_strategy: InteractionResumeStrategy::default(),
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: Some("root-1".to_string()),
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let interaction = store.get("interaction-1").await.unwrap().unwrap();
        assert_eq!(interaction.status, InteractionStatus::Resolved);
        assert!(interaction.accepted_command.is_some());
        assert!(matches!(
            interaction.response,
            Some(InteractionResponse::Question { .. })
        ));
    }

    #[tokio::test]
    async fn thread_command_with_mismatched_interaction_marker_is_ignored() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let comment_ts = Utc::now();
        let comments = Arc::new(RwLock::new(vec![crate::tracker::model::TrackerComment {
            comment_id: "c-2".to_string(),
            body: "/answer use staging\n<!-- ensemble:interaction:other-id -->".to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker { issues, comments });
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

        {
            let mut state = orchestrator.state.write().await;
            let cfg = config.read().await;
            state.init_state_lists(&cfg);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                kind: InteractionKind::Question,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                resume_strategy: InteractionResumeStrategy::default(),
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: Some("root-1".to_string()),
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let interaction = store.get("interaction-1").await.unwrap().unwrap();
        assert_eq!(interaction.status, InteractionStatus::Open);
        assert!(interaction.accepted_command.is_none());
        assert_eq!(interaction.ignored_commands.len(), 1);
        assert_eq!(
            interaction.ignored_commands[0].reason,
            "interaction_marker_mismatch"
        );
    }

    #[tokio::test]
    async fn resume_requeues_resolved_blocked_issue_without_waiting_entry() {
        let config = Arc::new(RwLock::new(make_config()));
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
    async fn hydrate_waiting_on_human_preserves_existing_metadata() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        let requested_at = Utc::now();
        let started_at = requested_at - chrono::Duration::minutes(5);
        {
            let mut state = orchestrator.state.write().await;
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-1".to_string(),
                step_name: "build".to_string(),
                kind: crate::interaction::model::InteractionKind::ApprovalGate,
                prompt: "Approve build".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: Some(2),
                started_at: Some(started_at),
                agent_input_tokens: 123,
                agent_output_tokens: 45,
                agent_total_tokens: 168,
                requested_at,
                run_id: None,
                issue: None,
            });
        }

        let store = InteractionStore::new(dir.path().to_path_buf());
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: "1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 2,
                completed_steps: vec![],
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::ApprovalGate,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::AdvanceAfterStep,
                title: "Approve build".to_string(),
                body: "Please review the build output.".to_string(),
                options: vec!["approve".to_string(), "reject".to_string()],
                artifacts: vec![],
                response: Some(InteractionResponse::Approval {
                    response_schema_version: 1,
                    approved: true,
                    reason: Some("looks good".to_string()),
                }),
                waiting_started_at: Some(started_at),
                agent_input_tokens: 123,
                agent_output_tokens: 45,
                agent_total_tokens: 168,
                requested_at,
                resolved_at: Some(Utc::now()),
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
            })
            .await
            .unwrap();

        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = orchestrator.state.read().await;
        let entry = state
            .waiting_on_human
            .get("1")
            .expect("waiting entry should still exist");
        assert_eq!(entry.started_at, Some(started_at));
        assert_eq!(entry.agent_input_tokens, 123);
        assert_eq!(entry.agent_output_tokens, 45);
        assert_eq!(entry.agent_total_tokens, 168);
        assert_eq!(entry.retry_attempt, Some(2));
    }

    #[tokio::test]
    async fn resume_requeues_resolved_blocked_issue_after_restart_without_pipeline_state() {
        let config = Arc::new(RwLock::new(make_config()));
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: Some(1),
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
            observed_timeouts: None,
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
            observed_timeouts: None,
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
    async fn handle_tick_writes_history_when_tracker_moves_running_issue_to_terminal() {
        let mut raw_config = make_config();
        let dir = tempfile::TempDir::new().unwrap();
        raw_config.workspace.root = Some(dir.path().display().to_string());
        let config = Arc::new(RwLock::new(raw_config));

        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Done")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
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

        orchestrator.handle_tick().await;

        let history_path = dir.path().join("ensemble_history.jsonl");
        let contents = tokio::fs::read_to_string(&history_path).await.unwrap();
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .unwrap();

        assert_eq!(record.issue_id, "1");
        assert_eq!(record.outcome, "stopped");
    }

    #[tokio::test]
    async fn build_history_record_preserves_step_dag_order() {
        let config = Arc::new(RwLock::new(make_non_alphabetical_two_step_config()));
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

        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new("1".to_string(), 1, dag);
        run.step_states.insert(
            "z-build".to_string(),
            crate::pipeline::engine::StepState::Passed,
        );
        run.step_states.insert(
            "a-review".to_string(),
            crate::pipeline::engine::StepState::Passed,
        );
        let mut state = orchestrator.state.write().await;
        state.add_running(&test_issue("1", "Todo"), None);
        let entry = state.running.get("1").unwrap().clone();
        drop(state);

        let record = orchestrator.build_history_record(
            "1",
            "succeeded",
            None,
            &entry,
            &run,
            Utc::now(),
            None,
        );

        assert_eq!(
            record.steps_traversed,
            vec!["z-build".to_string(), "a-review".to_string()]
        );
    }

    #[tokio::test]
    async fn build_history_record_preserves_run_artifacts() {
        let config = Arc::new(RwLock::new(make_config()));
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

        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new("1".to_string(), 1, dag);
        run.step_states.insert(
            "build".to_string(),
            crate::pipeline::engine::StepState::Passed,
        );
        let artifacts = RunArtifacts {
            run_id: "run-1".to_string(),
            workspace_path: dir.path().display().to_string(),
            repos: Vec::new(),
            transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                step_name: "build".to_string(),
                run_id: "run-1".to_string(),
                record_count: 3,
            }],
        };
        let mut state = orchestrator.state.write().await;
        state.add_running(&test_issue("1", "Todo"), None);
        let entry = state.running.get("1").unwrap().clone();
        drop(state);

        let record = orchestrator.build_history_record(
            "1",
            "succeeded",
            None,
            &entry,
            &run,
            Utc::now(),
            Some(artifacts.clone()),
        );

        assert_eq!(record.artifacts, Some(artifacts));
    }

    #[tokio::test]
    async fn history_path_uses_workspace_manager_root_not_config_root() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_root = dir.path().join("actual-root");
        let config_root = dir.path().join("config-root");
        std::fs::create_dir_all(&workspace_root).unwrap();

        let mut raw_config = make_config();
        raw_config.workspace.root = Some(config_root.display().to_string());

        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_mgr = WorkspaceManager::new(&workspace_root, None).unwrap();
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
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: None,
                },
            )
            .await;

        assert!(workspace_root.join("ensemble_history.jsonl").exists());
        assert!(!config_root.join("ensemble_history.jsonl").exists());
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: Some(1),
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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
            observed_timeouts: None,
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: Some(1),
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
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

    #[tokio::test]
    async fn publish_pipeline_event_broadcasts_without_run_context() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        let mut rx = orchestrator.event_bus.subscribe();

        orchestrator
            .publish_pipeline_event(
                None,
                None,
                1,
                PipelineEvent::SessionStarted {
                    issue_identifier: "repo#1".into(),
                    timestamp: Utc::now(),
                    detail: "started".into(),
                },
            )
            .await;

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");
    }

    #[tokio::test]
    async fn publish_pipeline_event_still_broadcasts_when_timeline_write_fails() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        std::fs::write(dir.path().join(".ensemble"), "blocked").unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        let mut rx = orchestrator.event_bus.subscribe();

        orchestrator
            .publish_pipeline_event(
                Some("run-1".into()),
                Some(1),
                2,
                PipelineEvent::TurnCompleted {
                    issue_identifier: "repo#1".into(),
                    timestamp: Utc::now(),
                    turn: 1,
                    detail: "turn completed".into(),
                    conversation_index: None,
                    tokens_delta: crate::observability::events::TokensDelta {
                        input: 10,
                        output: 20,
                    },
                },
            )
            .await;

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published despite persist failure")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");
        let path = dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn publish_pipeline_event_persists_and_broadcasts_with_run_context() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
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
        let mut rx = orchestrator.event_bus.subscribe();

        orchestrator
            .publish_pipeline_event(
                Some("run-1".into()),
                Some(11),
                3,
                PipelineEvent::Output {
                    issue_identifier: "repo#1".into(),
                    timestamp: Utc::now(),
                    step_name: "build".into(),
                    detail: "streamed output".into(),
                },
            )
            .await;

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");

        if let Some(ref mut persistence) = orchestrator.timeline_persistence {
            persistence.flush().await;
        }

        let path = dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        assert!(path.exists(), "file should exist after flush");
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        let record: crate::timeline::model::TimelineEventRecord =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(record.sequence, 11);
        assert_eq!(record.attempt, 3);
        assert_eq!(record.event_type, "output");
        assert_eq!(record.step_name.as_deref(), Some("build"));
    }

    #[tokio::test]
    async fn handle_agent_update_persists_transcript_block() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
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

        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("issue-1", "Todo"), None);
            let entry = state.running.get_mut("issue-1").unwrap();
            entry.identifier = "repo#1".to_string();
            entry.run_id = Some("run-1".to_string());
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::TranscriptBlock {
                    kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                    payload: serde_json::json!({"text": "hello"}),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;

        if let Some(ref mut persistence) = orchestrator.transcript_persistence {
            persistence.flush().await;
        }

        let contents = tokio::fs::read_to_string(
            dir.path()
                .join(".ensemble/runs/run-1/steps/build/transcript.jsonl"),
        )
        .await
        .unwrap();
        assert!(contents.contains("\"assistant_message\""));
        assert!(contents.contains("\"hello\""));
    }

    #[tokio::test]
    async fn handle_agent_update_broadcasts_persisted_transcript_record() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let transcript_event_bus = crate::transcript::events::TranscriptEventBus::new();
        let mut rx = transcript_event_bus.subscribe();

        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::new(RwLock::new(OrchestratorState::new(
                    30_000,
                    &ConcurrencyConfig::default(),
                ))),
                config,
                tracker,
                agent_runner: runner,
                workspace_mgr,
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus,
                workspace_root: dir.path().to_path_buf(),
            },
            dir.path(),
            shutdown_rx,
        );

        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("issue-1", "Todo"), None);
            let entry = state.running.get_mut("issue-1").unwrap();
            entry.identifier = "repo#1".to_string();
            entry.run_id = Some("run-1".to_string());
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::TranscriptBlock {
                    kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                    payload: serde_json::json!({"text": "hello"}),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;
        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::RunCompleted { usage: None },
                timestamp: chrono::Utc::now(),
            })
            .await;

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(received.issue_identifier, "repo#1");
        assert_eq!(received.run_id, "run-1");
        assert_eq!(received.step_name, "build");
        assert_eq!(received.payload["text"], "hello");
    }

    #[tokio::test]
    async fn run_completed_flushes_coalesced_transcript_block() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("issue-1", "Todo"), None);
            let entry = state.running.get_mut("issue-1").unwrap();
            entry.identifier = "repo#1".to_string();
            entry.run_id = Some("run-1".to_string());
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::TranscriptBlock {
                    kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                    payload: serde_json::json!({"text": "hello"}),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::RunCompleted { usage: None },
                timestamp: chrono::Utc::now(),
            })
            .await;

        let transcript_path = dir
            .path()
            .join(".ensemble/runs/run-1/steps/build/transcript.jsonl");
        for _ in 0..20 {
            if transcript_path.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let contents = tokio::fs::read_to_string(transcript_path).await.unwrap();
        assert!(contents.contains("\"assistant_message\""));
        assert!(contents.contains("\"hello\""));
    }

    #[tokio::test]
    async fn transcript_block_does_not_advance_timeline_sequence() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
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

        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("issue-1", "Todo"), None);
            let entry = state.running.get_mut("issue-1").unwrap();
            entry.identifier = "repo#1".to_string();
            entry.run_id = Some("run-1".to_string());
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::TranscriptBlock {
                    kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                    payload: serde_json::json!({"text": "hello"}),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;

        if let Some(ref mut persistence) = orchestrator.transcript_persistence {
            persistence.flush().await;
        }

        orchestrator
            .handle_worker_event(WorkerEvent::AgentUpdate {
                issue_id: "issue-1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::OutputChunk {
                    stream: crate::agent::events::RuntimeStream::Stdout,
                    content: "visible output".to_string(),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;

        if let Some(ref mut persistence) = orchestrator.timeline_persistence {
            persistence.flush().await;
        }

        let contents =
            tokio::fs::read_to_string(dir.path().join(".ensemble/runs/run-1/events.jsonl"))
                .await
                .unwrap();
        let record: crate::timeline::model::TimelineEventRecord =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(record.sequence, 1);
        assert_eq!(record.event_type, "output");
    }

    #[tokio::test]
    async fn step_moves_to_waiting_for_human_when_agent_asks_a_question() {
        use crate::orchestrator::state::StepRunState;

        let config = Arc::new(RwLock::new(make_config()));
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

        let _interaction_id = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            "interaction-1".to_string()
        };

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::BlockedOnHuman {
                    request: InteractionRequestDraft {
                        schema_version: 1,
                        kind: InteractionKind::BrainstormPrompt,
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
        let step_state = state.get_step_state("1", "build");
        assert!(
            matches!(step_state, Some(StepRunState::WaitingForHuman { .. })),
            "step should be in WaitingForHuman state, got {:?}",
            step_state
        );
    }

    #[tokio::test]
    async fn downstream_steps_do_not_start_while_waiting_for_human() {
        use crate::orchestrator::state::StepRunState;

        let config = Arc::new(RwLock::new(make_parallel_resume_config()));
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
                        kind: InteractionKind::BrainstormPrompt,
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
        let step_state = state.get_step_state("1", "build");
        assert!(
            matches!(step_state, Some(StepRunState::WaitingForHuman { .. })),
            "build step should be waiting for human, got {:?}",
            step_state
        );
        let review_state = state.get_step_state("1", "review");
        assert!(
            review_state.is_none(),
            "review step should not have an OrchestratorState entry (not yet started), got {:?}",
            review_state
        );
        let docs_state = state.get_step_state("1", "docs");
        assert!(
            docs_state.is_none(),
            "docs step should not have an OrchestratorState entry (not yet started), got {:?}",
            docs_state
        );
    }

    #[tokio::test]
    async fn step_resumes_on_next_tick_after_human_reply_is_persisted() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
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
                kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
                prompt: "Need input".to_string(),
                agent_name: "builder".to_string(),
                retry_attempt: None,
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                run_id: None,
                issue: None,
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
                kind: InteractionKind::BrainstormPrompt,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: vec![],
                artifacts: vec![],
                response: Some(InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                }),
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: Some(Utc::now()),
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(
            state.is_running("1"),
            "issue should be running after reply is persisted and tick fires"
        );
        assert!(
            !state.is_waiting_on_human("1"),
            "issue should no longer be waiting on human after resume"
        );
        let run = state.get_pipeline_run("1").expect("pipeline should exist");
        assert!(
            matches!(
                run.step_states.get("build"),
                Some(crate::pipeline::engine::StepState::Running { .. })
            ),
            "build step should be running after resume"
        );
    }

    #[tokio::test]
    async fn question_asked_timeline_event_is_emitted_when_step_blocks_on_human() {
        let config = Arc::new(RwLock::new(make_config()));
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

        let mut orchestrator = Orchestrator::new(
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
                        kind: InteractionKind::BrainstormPrompt,
                        blocking: true,
                        title: "Need input".to_string(),
                        body: "Choose environment".to_string(),
                        options: vec!["staging".to_string()],
                        artifacts: vec![],
                    },
                },
            )
            .await;

        if let Some(ref mut persistence) = orchestrator.timeline_persistence {
            persistence.flush().await;
        }

        let run_id = {
            let state = orchestrator.state.read().await;
            state
                .running
                .get("1")
                .and_then(|e| e.run_id.clone())
                .or_else(|| {
                    state
                        .waiting_on_human
                        .get("1")
                        .and_then(|e| e.run_id.clone())
                })
        };

        if let Some(run_id) = run_id {
            let events_path = dir
                .path()
                .join(".ensemble")
                .join("runs")
                .join(&run_id)
                .join("events.jsonl");
            assert!(
                events_path.exists(),
                "timeline events file should exist after flush"
            );
            let contents = tokio::fs::read_to_string(&events_path).await.unwrap();
            let mut question_asked_sequence: Option<u64> = None;
            let mut input_requested_sequence: Option<u64> = None;

            for line in contents.lines() {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let event_type = value
                    .get("event_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let sequence = value.get("sequence").and_then(|v| v.as_u64());

                match event_type {
                    "question_asked" => question_asked_sequence = sequence,
                    "input_requested" => input_requested_sequence = sequence,
                    _ => {}
                }
            }

            assert!(
                question_asked_sequence.is_some() && input_requested_sequence.is_some(),
                "timeline should contain both question_asked and input_requested events"
            );
            assert_ne!(
                question_asked_sequence, input_requested_sequence,
                "question_asked and input_requested must not reuse the same sequence number"
            );
        }
    }
}
