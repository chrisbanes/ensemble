pub mod pipeline_journal;
pub mod reconciler;
pub mod retry;
pub mod scheduler;
pub mod state;

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::RwLock;
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, timeout};
use tracing::{debug, error, info, warn};

use crate::acceptance::{AcceptanceCommandRunner, AcceptanceStatus, ShellAcceptanceCommandRunner};
use crate::agent::cancellation::{
    await_worker_drain, await_worker_quiescence, is_reconciliation_owned, mark_all_for_drain,
    mark_issue_for_drain, new_cancellation_registry, pending_reconciliation_issue_ids,
    register_worker, remove_completed_worker, remove_drained_workers, CancellationRegistry,
    WorkerDrainHandle,
};
use crate::agent::events::{
    AgentEvent, InteractionRequestDraft, OrchestratorWorkerEvent, StepApprovalRequestDraft,
    WorkerEvent, WorkerFailureKind, WorkerIdentity, WorkerResult,
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
    parse_scoped_interaction_command, InteractionAcceptance, InteractionCommand,
    InteractionResumeStrategy, InteractionStatus, InteractionStore,
    ParseScopedInteractionCommandError,
};
use crate::observability::events::{EventBus, PipelineEvent};
use crate::observability::events_contract::{
    elapsed_ms, ISSUE_DISPATCH_COMPLETED, ISSUE_DISPATCH_STARTED, ORCH_TICK_FINISHED,
    ORCH_TICK_STARTED, STEP_STARTED, TRACKER_TRANSITION_FAILED, TRACKER_TRANSITION_REQUESTED,
    TRACKER_TRANSITION_SUCCEEDED,
};
use crate::orchestrator::pipeline_journal::{
    PendingTerminalTransition, PipelineRunJournal, PipelineTransitionInput, PipelineTransitionKind,
    PipelineTransitionRecord, TerminalOutcome,
};
use crate::pipeline::dag::build_dag;
use crate::pipeline::engine::{
    DispatchRequest, PipelineAction, PipelineRun, PipelineRunSnapshot, StepOutputTemplateContext,
    StepState,
};
use crate::pipeline::verdict::StepResult;
use crate::timeline::persistence::TimelinePersistence;
use crate::tracker::model::{Issue, RetryEntry, RunningEntry};
use crate::tracker::IssueTracker;
use crate::transcript::events::TranscriptEventBus;
use crate::transcript::model::TranscriptRecordKind;
use crate::transcript::persistence::{TranscriptPersistRequest, TranscriptPersistence};
use crate::workspace::finalize::FinalizeMode;
use crate::workspace::manager::WorkspaceManager;

use futures_util::FutureExt;
use reconciler::{
    determine_reconcile_action, reconcile_stalled_runs, reconcile_tracker_states,
    startup_terminal_cleanup, ReconcileAction,
};
use retry::{
    current_time_ms, defer_retry, get_due_retries, next_attempt, queue_manual_step_retry,
    queue_manual_whole_issue_retry, schedule_failure_retry, FailureRetryDisposition,
    FailureRetryRequest, ManualStepRetryError, ManualStepRetryRequest,
    ManualWholeIssueRetryRequest,
};
use scheduler::{
    has_available_slots, is_dispatch_eligible, is_resume_dispatch_eligible, sort_for_dispatch,
};
use state::{
    FinalizeStatus, IssueFinalizeState, OrchestratorState, PendingTerminalEntry, RepoFinalizeState,
    WaitingOnHumanEntry,
};

struct StepDispatchContext<'a> {
    step_name: &'a str,
    agent_name: &'a str,
    step_kind: StepKind,
    tracker_state: Option<&'a str>,
    attempt: Option<u32>,
    timeout_ms: u64,
    interaction_response: Option<InteractionResponseEnvelope>,
    interaction_resume_id: Option<&'a str>,
    interaction_to_retire: Option<&'a str>,
    interaction_retirement_rollback: Option<PipelineTransitionInput>,
    workspace_path: std::path::PathBuf,
    step_outputs: StepOutputTemplateContext,
}

const INTERACTION_RESUME_REASON_PREFIX: &str = "interaction_resume:";

fn interaction_id_from_resume_reason(reason: Option<&str>) -> Option<&str> {
    reason?.strip_prefix(INTERACTION_RESUME_REASON_PREFIX)
}

struct ExhaustedRetryTerminal {
    issue: Issue,
    target_state: String,
    history_record: Option<HistoryRecord>,
}

enum WholeIssueFailureRetry {
    Scheduled(Option<Box<PipelineTransitionInput>>),
    Exhausted(Box<ExhaustedRetryTerminal>),
}

enum AcceptancePhaseOutcome {
    Passed,
    Failed {
        reason: String,
        owner: AcceptanceOwnerIdentity,
    },
    RetainedForRecovery,
}

#[derive(Clone)]
struct PendingAcceptanceTransition {
    expected: PipelineTransitionInput,
    candidate: PipelineRunSnapshot,
    owner: AcceptanceOwnerIdentity,
    baseline: PipelineRunSnapshot,
}

#[derive(Debug, Clone)]
pub(crate) struct ManualStepRetryCommand {
    pub issue_id: String,
    pub identifier: String,
    pub step_name: String,
}

pub(crate) struct ManualWholeIssueRetryCommand {
    pub issue_id: String,
    pub identifier: String,
}

pub(crate) enum OrchestratorCommand {
    QueueManualStepRetry {
        command: ManualStepRetryCommand,
        response: tokio::sync::oneshot::Sender<Result<RetryEntry, ManualStepRetryError>>,
    },
    QueueManualWholeIssueRetry {
        command: ManualWholeIssueRetryCommand,
        response: tokio::sync::oneshot::Sender<Result<(), ManualStepRetryError>>,
    },
}

#[derive(Clone, Copy)]
enum ScheduledRetryPipeline {
    Preserve,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateRestoreOutcome {
    NotRestored,
    ReadyForDispatch,
    Parked,
}

struct InteractionRequestContext {
    step_name: String,
    agent_name: String,
    pipeline_cycle: u32,
    completed_steps: Vec<String>,
    step_depends: Vec<String>,
    step_tracker_state: Option<String>,
}

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
        state
            .get_running(issue_id)
            .is_some_and(|entry| entry.run_id == self.run_id && entry.started_at == self.started_at)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AcceptanceOwnerIdentity {
    Running(RunningAttemptIdentity),
    Waiting {
        interaction_request_id: String,
        run_id: Option<String>,
        requested_at: chrono::DateTime<Utc>,
    },
}

impl AcceptanceOwnerIdentity {
    fn capture(state: &OrchestratorState, issue_id: &str) -> Option<Self> {
        RunningAttemptIdentity::capture(state, issue_id)
            .map(Self::Running)
            .or_else(|| {
                state
                    .waiting_on_human
                    .get(issue_id)
                    .map(|entry| Self::Waiting {
                        interaction_request_id: entry.interaction_request_id.clone(),
                        run_id: entry.run_id.clone(),
                        requested_at: entry.requested_at,
                    })
            })
    }

    fn is_current(&self, state: &OrchestratorState, issue_id: &str) -> bool {
        match self {
            Self::Running(identity) => identity.is_current(state, issue_id),
            Self::Waiting {
                interaction_request_id,
                run_id,
                requested_at,
            } => state.waiting_on_human.get(issue_id).is_some_and(|entry| {
                entry.interaction_request_id == *interaction_request_id
                    && entry.run_id == *run_id
                    && entry.requested_at == *requested_at
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReconciliationOwner {
    attempt: Option<RunningAttemptIdentity>,
    pipeline_cycle: Option<u32>,
}

impl ReconciliationOwner {
    fn capture(state: &OrchestratorState, issue_id: &str) -> Self {
        Self {
            attempt: RunningAttemptIdentity::capture(state, issue_id),
            pipeline_cycle: state.get_pipeline_run(issue_id).map(|run| run.cycle),
        }
    }

    fn is_current(&self, state: &OrchestratorState, issue_id: &str) -> bool {
        let attempt_is_current = match &self.attempt {
            Some(attempt) => attempt.is_current(state, issue_id),
            None => state.get_running(issue_id).is_none(),
        };
        attempt_is_current
            && state.get_pipeline_run(issue_id).map(|run| run.cycle) == self.pipeline_cycle
    }
}

struct DrainedWorkers {
    owner: ReconciliationOwner,
    handles: Vec<WorkerDrainHandle>,
}

#[derive(Clone, Copy)]
enum DrainEventMode<'a> {
    ApplyExceptIssue(&'a str),
    Discard,
}

#[derive(Clone, Copy)]
enum TrackerReconcileDisposition {
    Terminal,
    Inactive,
}

enum CurrentReconcileDisposition {
    Terminal { identifier: String },
    Inactive,
    Stalled,
    Active,
}

const HISTORY_OUTCOME_SUCCEEDED: &str = "succeeded";
const HISTORY_OUTCOME_FAILED: &str = "failed";
const HISTORY_OUTCOME_STOPPED: &str = "stopped";
const HISTORY_VERDICT_APPROVED: &str = "approved";
const HISTORY_VERDICT_REJECTED: &str = "rejected";
const HISTORY_VERDICT_FAILED: &str = "failed";
const REJECTION_COMMENT_PREFIX: &str = "Ensemble pipeline rejected";
#[cfg(not(test))]
const WORKER_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const WORKER_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// The main orchestrator that manages the poll-dispatch-reconcile loop.
pub struct Orchestrator {
    state: Arc<RwLock<OrchestratorState>>,
    config: Arc<RwLock<EnsembleConfig>>,
    tracker: Arc<dyn IssueTracker>,
    agent_runner: Arc<dyn AgentRunner>,
    acceptance_runner: Arc<dyn AcceptanceCommandRunner>,
    workspace_mgr: Arc<WorkspaceManager>,
    interaction_store: InteractionStore,
    refresh_requested: Arc<tokio::sync::Notify>,
    cancellation_registry: CancellationRegistry,
    history_write_lock: Arc<tokio::sync::Mutex<()>>,
    history_store: Option<HistoryStore>,
    pipeline_journal: PipelineRunJournal,
    pipeline_journal_restored: AtomicBool,
    pending_acceptance_transitions: std::sync::Mutex<HashMap<String, PendingAcceptanceTransition>>,
    event_bus: EventBus,
    timeline_persistence: Option<TimelinePersistence>,
    transcript_persistence: Option<TranscriptPersistence>,
    worker_tx: mpsc::Sender<OrchestratorWorkerEvent>,
    worker_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<OrchestratorWorkerEvent>>>,
    command_tx: mpsc::Sender<OrchestratorCommand>,
    command_rx: mpsc::Receiver<OrchestratorCommand>,
    shutdown_rx: mpsc::Receiver<()>,
    quiescing: QuiescingLatch,
    #[cfg(test)]
    finalization_commit_test_barriers:
        Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
    #[cfg(test)]
    finalization_run_count: AtomicUsize,
}

static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(1);
const FINALIZE_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Default)]
pub(crate) struct QuiescingLatch(Arc<std::sync::Mutex<bool>>);

struct DispatchPermit;

impl QuiescingLatch {
    pub(crate) fn request(&self) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    }

    fn is_requested(&self) -> bool {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Linearizes candidate and retry dispatch against a concurrent quiescence request.
    fn begin_dispatch(&self) -> Option<DispatchPermit> {
        (!*self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
        .then_some(DispatchPermit)
    }
}

pub struct OrchestratorRuntimeParts {
    pub state: Arc<RwLock<OrchestratorState>>,
    pub config: Arc<RwLock<EnsembleConfig>>,
    pub tracker: Arc<dyn IssueTracker>,
    pub agent_runner: Arc<dyn AgentRunner>,
    pub acceptance_runner: Arc<dyn AcceptanceCommandRunner>,
    pub workspace_mgr: WorkspaceManager,
    pub refresh_requested: Arc<tokio::sync::Notify>,
    pub cancellation_registry: CancellationRegistry,
    pub event_bus: EventBus,
    pub transcript_event_bus: TranscriptEventBus,
    pub workspace_root: std::path::PathBuf,
}

struct RunningHistoryRecordInput<'a> {
    outcome: &'a str,
    last_error: Option<String>,
    running_entry: &'a crate::tracker::model::RunningEntry,
    run: &'a PipelineRun,
    completed_at: chrono::DateTime<Utc>,
    artifacts: Option<RunArtifacts>,
}

struct WaitingHistoryRecordInput<'a> {
    outcome: &'a str,
    last_error: Option<String>,
    waiting_entry: &'a WaitingOnHumanEntry,
    run: &'a PipelineRun,
    completed_at: chrono::DateTime<Utc>,
    artifacts: Option<RunArtifacts>,
}

impl Orchestrator {
    fn effective_step_timeout_ms(timeout_ms: Option<u64>, config: &EnsembleConfig) -> u64 {
        timeout_ms.unwrap_or(config.agent.turn_timeout_ms)
    }

    fn finalization_attempt_is_current(
        attempt: Option<&RunningAttemptIdentity>,
        state: &OrchestratorState,
        issue_id: &str,
    ) -> bool {
        attempt.is_some_and(|attempt| attempt.is_current(state, issue_id))
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
        let history_store = futures::executor::block_on(HistoryStore::new(
            parts.workspace_root.join(".ensemble").join("history.db"),
        ))
        .map_err(|error| {
            warn!(
                error = %error,
                "failed to initialize sqlite history store; continuing without durable history or timeline persistence"
            );
            error
        })
        .ok();
        Self::new_with_state_and_history(parts, config_dir, shutdown_rx, history_store)
    }

    pub(crate) fn new_with_state_and_history(
        parts: OrchestratorRuntimeParts,
        config_dir: &Path,
        shutdown_rx: mpsc::Receiver<()>,
        history_store: Option<HistoryStore>,
    ) -> Self {
        let (worker_tx, worker_rx) = mpsc::channel(1000);
        let (command_tx, command_rx) = mpsc::channel(100);
        let timeline_persistence = history_store.clone().map(TimelinePersistence::new);

        Self {
            state: parts.state,
            config: parts.config,
            tracker: parts.tracker,
            agent_runner: parts.agent_runner,
            acceptance_runner: parts.acceptance_runner,
            interaction_store: InteractionStore::new(config_dir.to_path_buf()),
            workspace_mgr: Arc::new(parts.workspace_mgr),
            refresh_requested: parts.refresh_requested,
            cancellation_registry: parts.cancellation_registry,
            history_write_lock: Arc::new(tokio::sync::Mutex::new(())),
            history_store,
            pipeline_journal: PipelineRunJournal::new(config_dir.to_path_buf()),
            pipeline_journal_restored: AtomicBool::new(false),
            pending_acceptance_transitions: std::sync::Mutex::new(HashMap::new()),
            event_bus: parts.event_bus,
            timeline_persistence,
            transcript_persistence: Some(TranscriptPersistence::new_with_event_bus(
                parts.workspace_root,
                parts.transcript_event_bus,
            )),
            worker_tx,
            worker_rx: Arc::new(tokio::sync::Mutex::new(worker_rx)),
            command_tx,
            command_rx,
            shutdown_rx,
            quiescing: QuiescingLatch::default(),
            #[cfg(test)]
            finalization_commit_test_barriers: None,
            #[cfg(test)]
            finalization_run_count: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    fn set_finalization_commit_test_barriers(
        &mut self,
        before_commit: Arc<tokio::sync::Barrier>,
        resume_commit: Arc<tokio::sync::Barrier>,
    ) {
        self.finalization_commit_test_barriers = Some((before_commit, resume_commit));
    }

    #[cfg(test)]
    async fn wait_for_finalization_commit_test_barriers(&self) {
        if let Some((before_commit, resume_commit)) = &self.finalization_commit_test_barriers {
            before_commit.wait().await;
            resume_commit.wait().await;
        }
    }

    /// Get a reference to the orchestrator state for API consumers.
    pub fn state(&self) -> Arc<RwLock<OrchestratorState>> {
        Arc::clone(&self.state)
    }

    pub(crate) fn worker_event_receiver_owner(
        &self,
    ) -> Arc<tokio::sync::Mutex<mpsc::Receiver<OrchestratorWorkerEvent>>> {
        Arc::clone(&self.worker_rx)
    }

    pub(crate) fn quiescing_latch_owner(&self) -> QuiescingLatch {
        self.quiescing.clone()
    }

    pub(crate) fn command_sender_owner(&self) -> mpsc::Sender<OrchestratorCommand> {
        self.command_tx.clone()
    }

    #[cfg(test)]
    pub(crate) fn persist_timeline_for_test(
        &self,
        record: crate::timeline::model::TimelineEventRecord,
    ) {
        self.timeline_persistence
            .as_ref()
            .expect("test orchestrator should have timeline persistence")
            .send(record);
    }

    #[cfg(test)]
    pub(crate) fn persist_transcript_for_test(&self, request: TranscriptPersistRequest) {
        self.transcript_persistence
            .as_ref()
            .expect("test orchestrator should have transcript persistence")
            .send(request);
    }

    async fn handle_command(&self, command: OrchestratorCommand) {
        match command {
            OrchestratorCommand::QueueManualStepRetry { command, response } => {
                if self.quiescing.is_requested() {
                    let _ = response.send(Err(ManualStepRetryError::RuntimeUnavailable));
                    return;
                }
                let (max_backoff_ms, max_cycles) = {
                    let config = self.config.read().await;
                    (config.agent.max_retry_backoff_ms, config.max_cycles)
                };
                let result = queue_manual_step_retry(
                    &self.state,
                    &self.pipeline_journal,
                    &self.interaction_store,
                    ManualStepRetryRequest {
                        issue_id: &command.issue_id,
                        identifier: &command.identifier,
                        step_name: &command.step_name,
                        max_backoff_ms,
                        max_cycles,
                    },
                )
                .await;
                let _ = response.send(result);
            }
            OrchestratorCommand::QueueManualWholeIssueRetry { command, response } => {
                if self.quiescing.is_requested() {
                    let _ = response.send(Err(ManualStepRetryError::RuntimeUnavailable));
                    return;
                }
                let result = queue_manual_whole_issue_retry(
                    &self.state,
                    &self.pipeline_journal,
                    &self.interaction_store,
                    ManualWholeIssueRetryRequest {
                        issue_id: &command.issue_id,
                        identifier: &command.identifier,
                    },
                )
                .await;
                let _ = response.send(result);
            }
        }
    }

    /// Run the orchestrator main loop.
    pub async fn run(&mut self) -> bool {
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
        self.reconcile_pending_terminal_transitions().await;

        // Startup terminal workspace cleanup
        {
            let (terminal_states, pending_terminal_issue_ids) = {
                let config = self.config.read().await;
                let state = self.state.read().await;
                (
                    config.tracker.terminal_states.clone(),
                    state
                        .pending_terminal_transitions
                        .keys()
                        .cloned()
                        .collect::<HashSet<_>>(),
                )
            };
            startup_terminal_cleanup(
                self.tracker.as_ref(),
                &terminal_states,
                &self.workspace_mgr,
                &pending_terminal_issue_ids,
            )
            .await;
        }

        info!("orchestrator started, entering main loop");

        // Immediate first tick
        if !self.quiescing.is_requested() {
            self.handle_tick().await;
        }

        // Main event loop
        let shutdown_quiesced = loop {
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
                biased;

                // Shutdown signal
                _ = self.shutdown_rx.recv() => {
                    let quiesced = self.cancel_active_runs().await;
                    info!("received shutdown signal, stopping orchestrator");
                    break quiesced;
                }

                Some(command) = self.command_rx.recv() => {
                    self.handle_command(command).await;
                }

                // Poll timer
                _ = sleep(poll_interval) => {
                    if !self.quiescing.is_requested() {
                        debug!("poll tick");
                        self.handle_tick().await;
                    }
                }

                // Manual refresh signal
                _ = self.refresh_requested.notified() => {
                    if !self.quiescing.is_requested() {
                        debug!("manual refresh tick");
                        self.handle_tick().await;
                    }
                }

                // Worker events
                Some(event) = recv_worker_event(&self.worker_rx) => {
                    self.handle_worker_event(event).await;
                }

                // Retry timer (if any)
                _ = async {
                    match retry_sleep {
                        Some(d) => sleep(d).await,
                        None => futures::future::pending::<()>().await,
                    }
                } => {
                    if !self.quiescing.is_requested() {
                        debug!("retry timer fired");
                        self.handle_retry_fires().await;
                    }
                }
            }
        };

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
        shutdown_quiesced
    }

    /// Handle a poll tick: reconcile, validate, fetch, dispatch.
    async fn handle_tick(&self) {
        if self.quiescing.is_requested() {
            return;
        }

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

        self.reconcile_pending_acceptance_transitions().await;
        self.restore_pipeline_runs_from_journal().await;
        self.reconcile_pending_terminal_transitions().await;
        self.hydrate_waiting_on_human_from_store().await;
        self.process_interaction_thread_commands().await;
        self.process_finalize_retries().await;

        // Pre-compute lowercase state lists once per tick
        let (active_lower, reconcile_active_lower, terminal_lower) = {
            let state = self.state.read().await;
            let config = self.config.read().await;
            (
                state.active_states_lower.clone(),
                build_reconcile_active_states_lower(&config),
                state.terminal_states_lower.clone(),
            )
        };

        let resume_issue_ids = {
            let state = self.state.read().await;
            state.resume_requested.iter().cloned().collect::<Vec<_>>()
        };
        if !resume_issue_ids.is_empty() {
            match self
                .tracker
                .fetch_issue_states_by_ids(&resume_issue_ids)
                .await
            {
                Ok(issues) => {
                    for issue in issues {
                        let still_requested = {
                            let state = self.state.read().await;
                            state.is_resume_requested(&issue.id)
                        };
                        if !still_requested {
                            continue;
                        }

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
                }
                Err(error) => {
                    warn!(
                        issue_ids = ?resume_issue_ids,
                        error = %error,
                        "failed to refresh explicit resume requests"
                    );
                }
            }
        }

        for issue_id in pending_reconciliation_issue_ids(&self.cancellation_registry) {
            self.resume_pending_reconciliation(&issue_id, &reconcile_active_lower, &terminal_lower)
                .await;
        }

        // 1. Reconcile stalled runs
        let stall_timeout_ms = {
            let config = self.config.read().await;
            config.agent.stall_timeout_ms
        };
        let stalled_issue_ids = {
            let state = self.state.read().await;
            reconcile_stalled_runs(&state, stall_timeout_ms).stalled_issue_ids
        };
        for issue_id in stalled_issue_ids {
            self.reconcile_stalled_issue(&issue_id, stall_timeout_ms)
                .await;
        }

        // 2. Reconcile tracker states
        {
            let state = self.state.read().await;
            let reconcile_result = reconcile_tracker_states(
                &state,
                self.tracker.as_ref(),
                &reconcile_active_lower,
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
                self.reconcile_tracker_candidate(
                    &issue.id,
                    &reconcile_active_lower,
                    &terminal_lower,
                    TrackerReconcileDisposition::Terminal,
                )
                .await;
            }

            // Non-active: terminate without cleanup
            for issue in reconcile_result.terminate_no_cleanup {
                self.reconcile_tracker_candidate(
                    &issue.id,
                    &reconcile_active_lower,
                    &terminal_lower,
                    TrackerReconcileDisposition::Inactive,
                )
                .await;
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

        // 5. Dispatch eligible issues while slots remain
        for issue in &candidates {
            if self.quiescing.is_requested() {
                break;
            }

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
                Self::restored_pipeline_ready_for_dispatch(&state, &issue.id)
            };

            if restored_pipeline_ready {
                self.dispatch_issue(issue, None).await;
                continue;
            }

            if eligible.is_some() {
                continue;
            }

            match self.restore_pipeline_run_for_candidate(issue).await {
                Ok(
                    CandidateRestoreOutcome::NotRestored
                    | CandidateRestoreOutcome::ReadyForDispatch,
                ) => {
                    self.dispatch_issue(issue, None).await;
                }
                Ok(CandidateRestoreOutcome::Parked) => {}
                Err(
                    error @ EnsembleError::Agent(AgentError::DurableSequenceUnavailable { .. }),
                ) => {
                    warn!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        error = %error,
                        "failed to restore live pipeline journal before dispatch, leaving issue undispatched"
                    );
                }
                Err(error) => {
                    warn!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        error = %error,
                        "failed to restore live pipeline journal before dispatch, falling back to fresh dispatch"
                    );
                    self.dispatch_issue(issue, None).await;
                }
            }
        }

        info!(
            event = ORCH_TICK_FINISHED,
            duration_ms = elapsed_ms(tick_started_at),
            "orchestrator tick finished"
        );
    }

    async fn restore_pipeline_run_for_candidate(
        &self,
        issue: &Issue,
    ) -> Result<CandidateRestoreOutcome, EnsembleError> {
        {
            let state = self.state.read().await;
            if Self::restored_pipeline_ready_for_dispatch(&state, &issue.id) {
                return Ok(CandidateRestoreOutcome::ReadyForDispatch);
            }
            if state.get_pipeline_run(&issue.id).is_some()
                || state.is_running(&issue.id)
                || state.is_claimed(&issue.id)
            {
                return Ok(CandidateRestoreOutcome::Parked);
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
            return Ok(CandidateRestoreOutcome::NotRestored);
        };

        let config_snapshot = {
            let config = self.config.read().await;
            Arc::new(config.clone())
        };
        let issues_by_id = HashMap::from([(issue.id.clone(), issue.clone())]);
        self.restore_pipeline_run_record(&record, config_snapshot, &issues_by_id)
            .await?;

        let state = self.state.read().await;
        if Self::restored_pipeline_ready_for_dispatch(&state, &issue.id) {
            Ok(CandidateRestoreOutcome::ReadyForDispatch)
        } else if state.get_pipeline_run(&issue.id).is_some()
            || state.is_claimed(&issue.id)
            || state.is_waiting_on_human(&issue.id)
            || state.retry_attempts.contains_key(&issue.id)
        {
            Ok(CandidateRestoreOutcome::Parked)
        } else {
            Ok(CandidateRestoreOutcome::NotRestored)
        }
    }

    fn restored_pipeline_ready_for_dispatch(state: &OrchestratorState, issue_id: &str) -> bool {
        if state.pending_terminal_transitions.contains_key(issue_id)
            || state.finalize.contains_key(issue_id)
        {
            return false;
        }
        let Some(run) = state.get_pipeline_run(issue_id) else {
            return false;
        };

        state.is_claimed(issue_id)
            && !state.is_running(issue_id)
            && !state.is_waiting_on_human(issue_id)
            && !state.retry_attempts.contains_key(issue_id)
            && !Self::pipeline_has_waiting_step(run)
    }

    fn pipeline_has_waiting_step(run: &PipelineRun) -> bool {
        run.step_states.values().any(|state| {
            matches!(
                state,
                StepState::BlockedOnHuman { .. } | StepState::AwaitingApproval { .. }
            )
        })
    }

    /// Dispatch a single issue: build DAG, create PipelineRun, dispatch initial steps.
    async fn dispatch_issue(&self, issue: &Issue, attempt: Option<u32>) {
        let Some(permit) = self.quiescing.begin_dispatch() else {
            return;
        };
        self.dispatch_issue_with_permit(issue, attempt, &permit)
            .await;
    }

    async fn dispatch_issue_with_permit(
        &self,
        issue: &Issue,
        attempt: Option<u32>,
        permit: &DispatchPermit,
    ) {
        self.dispatch_issue_with_owned_retry(issue, attempt, None, permit)
            .await;
    }

    async fn dispatch_retry_issue_with_permit(
        &self,
        issue: &Issue,
        retry_entry: &RetryEntry,
        permit: &DispatchPermit,
    ) {
        self.dispatch_issue_with_owned_retry(
            issue,
            Some(retry_entry.attempt),
            Some(retry_entry),
            permit,
        )
        .await;
    }

    async fn dispatch_issue_with_owned_retry(
        &self,
        issue: &Issue,
        attempt: Option<u32>,
        expected_retry: Option<&RetryEntry>,
        permit: &DispatchPermit,
    ) {
        let cycle = attempt.unwrap_or(1);

        {
            let state = self.state.read().await;
            if state.get_pipeline_run(&issue.id).is_some() {
                drop(state);

                let (config_snapshot, action, effective_cycle, effective_attempt, finalize_attempt) = {
                    let mut state = self.state.write().await;
                    if expected_retry.is_some_and(|expected| {
                        state.retry_attempts.get(&issue.id) != Some(expected)
                    }) {
                        return;
                    }
                    let existing_cycle = state
                        .get_pipeline_run(&issue.id)
                        .map(|run| run.cycle)
                        .unwrap_or(cycle);
                    let effective_cycle = attempt.unwrap_or(existing_cycle);
                    let effective_attempt =
                        attempt.or_else(|| (effective_cycle > 1).then_some(effective_cycle));
                    state.add_running(issue, effective_attempt);
                    let config = state.get_pipeline_config(&issue.id).cloned();
                    let action = state
                        .get_pipeline_run_mut(&issue.id)
                        .map(|run| {
                            run.cycle = effective_cycle;
                            run.start()
                        })
                        .unwrap_or(PipelineAction::Waiting);
                    let finalize_attempt = RunningAttemptIdentity::capture(&state, &issue.id);
                    (
                        config,
                        action,
                        effective_cycle,
                        effective_attempt,
                        finalize_attempt,
                    )
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
                    cycle = effective_cycle,
                    "resuming with existing pipeline"
                );

                match action {
                    PipelineAction::Succeeded => {
                        info!(
                            issue_id = %issue.id,
                            "restored pipeline already succeeded"
                        );
                        match self.run_acceptance_phase(issue, &config_snapshot).await {
                            AcceptancePhaseOutcome::Passed => {}
                            AcceptancePhaseOutcome::Failed { reason, owner } => {
                                self.schedule_acceptance_failure(
                                    issue,
                                    &config_snapshot,
                                    &reason,
                                    &owner,
                                )
                                .await;
                                return;
                            }
                            AcceptancePhaseOutcome::RetainedForRecovery => return,
                        }
                        let finalize_state = self
                            .finalize_and_stage_terminal_transition(
                                &issue.id,
                                &issue.identifier,
                                &config_snapshot,
                            )
                            .await;
                        let completed_at = Utc::now();
                        let (terminal_issue, terminal_outcome, target_state, history_record) = {
                            let mut state = self.state.write().await;
                            if !Self::finalization_attempt_is_current(
                                finalize_attempt.as_ref(),
                                &state,
                                &issue.id,
                            ) {
                                warn!(
                                    issue_id = %issue.id,
                                    "discarding stale finalization result because the running attempt changed"
                                );
                                return;
                            }
                            let history_record = state
                                .running
                                .get(&issue.id)
                                .zip(state.get_pipeline_run(&issue.id))
                                .map(|(entry, run)| {
                                    self.build_history_record(RunningHistoryRecordInput {
                                        outcome: HISTORY_OUTCOME_SUCCEEDED,
                                        last_error: None,
                                        running_entry: entry,
                                        run,
                                        completed_at,
                                        artifacts: state.artifacts.get(&issue.id).cloned(),
                                    })
                                });
                            let running_entry = state.get_running(&issue.id).cloned();
                            let terminal_issue = running_entry
                                .as_ref()
                                .map(|entry| entry.issue.clone())
                                .unwrap_or_else(|| issue.clone());

                            if finalize_state.status == FinalizeStatus::Succeeded
                                || finalize_state.status == FinalizeStatus::NotRequired
                            {
                                (
                                    Some(terminal_issue),
                                    Some(TerminalOutcome::Succeeded),
                                    Some(config_snapshot.on_success.clone()),
                                    history_record,
                                )
                            } else {
                                let is_terminal_failure =
                                    finalize_state.status == FinalizeStatus::SkippedHeadless;
                                if let Some(entry) = state.remove_running(&issue.id) {
                                    state.add_runtime_seconds(&entry);
                                }
                                state.set_finalize_state(&issue.id, finalize_state);
                                if !is_terminal_failure {
                                    state.remove_pipeline_run(&issue.id);
                                }
                                (
                                    is_terminal_failure.then_some(terminal_issue),
                                    is_terminal_failure.then_some(TerminalOutcome::Failed),
                                    is_terminal_failure.then(|| config_snapshot.on_failure.clone()),
                                    None,
                                )
                            }
                        };

                        if let (Some(issue), Some(outcome), Some(target_state)) =
                            (terminal_issue, terminal_outcome, target_state)
                        {
                            self.begin_terminal_transition(
                                &issue,
                                outcome,
                                target_state,
                                history_record,
                            )
                            .await;
                        }
                    }
                    PipelineAction::Dispatch(requests) => {
                        let recovered_interaction = match self
                            .recovered_interaction_response(&issue.id)
                            .await
                        {
                            Ok(interaction) => interaction,
                            Err(error) => {
                                warn!(
                                    issue_id = %issue.id,
                                    error = %error,
                                    "failed to recover durable interaction response; retaining pipeline owner"
                                );
                                return;
                            }
                        };
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
                                        let terminal =
                                            state.remove_running(&issue.id).map(|entry| {
                                                self.schedule_whole_issue_failure_retry(
                                                    &mut state,
                                                    &config_snapshot,
                                                    entry,
                                                    &error.to_string(),
                                                    ScheduledRetryPipeline::Release,
                                                )
                                            });
                                        drop(state);
                                        self.commit_whole_issue_failure_retry(terminal).await;
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

                            if let Err(error) = self
                                .dispatch_step(
                                    issue,
                                    Arc::clone(&config_snapshot),
                                    StepDispatchContext {
                                        step_name: &req.step_name,
                                        agent_name: &req.agent_name,
                                        step_kind: req.step_kind,
                                        tracker_state: req.tracker_state.as_deref(),
                                        attempt: effective_attempt,
                                        timeout_ms: Self::effective_step_timeout_ms(
                                            req.timeout_ms,
                                            &config_snapshot,
                                        ),
                                        interaction_response: recovered_interaction
                                            .as_ref()
                                            .filter(|(_, step_name, _, _)| {
                                                step_name == &req.step_name
                                            })
                                            .and_then(|(_, _, response, _)| response.clone()),
                                        interaction_resume_id: recovered_interaction
                                            .as_ref()
                                            .filter(|(_, step_name, _, _)| {
                                                step_name == &req.step_name
                                            })
                                            .map(|(interaction_id, _, _, _)| {
                                                interaction_id.as_str()
                                            }),
                                        interaction_to_retire: recovered_interaction
                                            .as_ref()
                                            .filter(|(_, step_name, _, awaiting_resume)| {
                                                step_name == &req.step_name && *awaiting_resume
                                            })
                                            .map(|(interaction_id, _, _, _)| {
                                                interaction_id.as_str()
                                            }),
                                        interaction_retirement_rollback: None,
                                        workspace_path,
                                        step_outputs,
                                    },
                                    permit,
                                )
                                .await
                            {
                                self.handle_step_dispatch_error(
                                    issue,
                                    &req.step_name,
                                    &config_snapshot,
                                    &error,
                                )
                                .await;
                                return;
                            }
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
                    cycle = effective_cycle,
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
            if expected_retry
                .is_some_and(|expected| state.retry_attempts.get(&issue.id) != Some(expected))
            {
                return;
            }
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
                            let terminal = state.remove_running(&issue.id).map(|entry| {
                                self.schedule_whole_issue_failure_retry(
                                    &mut state,
                                    &config_snapshot,
                                    entry,
                                    &error.to_string(),
                                    ScheduledRetryPipeline::Release,
                                )
                            });
                            drop(state);
                            self.commit_whole_issue_failure_retry(terminal).await;
                            return;
                        }
                    };

                if let Err(error) = self
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
                            interaction_resume_id: None,
                            interaction_to_retire: None,
                            interaction_retirement_rollback: None,
                            workspace_path,
                            step_outputs: StepOutputTemplateContext::default(),
                        },
                        permit,
                    )
                    .await
                {
                    self.handle_step_dispatch_error(
                        issue,
                        &req.step_name,
                        &config_snapshot,
                        &error,
                    )
                    .await;
                    return;
                }
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

    async fn recovered_interaction_response(
        &self,
        issue_id: &str,
    ) -> Result<Option<(String, String, Option<InteractionResponseEnvelope>, bool)>, EnsembleError>
    {
        let record = self
            .pipeline_journal
            .latest_live_record_for_issue(issue_id)
            .await
            .map_err(|error| AgentError::IoError {
                reason: format!(
                    "failed to read the durable pipeline owner for issue {issue_id}: {error}"
                ),
            })?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.kind != PipelineTransitionKind::StepRunning {
            return Ok(None);
        }
        let Some(interaction_id) = interaction_id_from_resume_reason(record.reason.as_deref())
        else {
            return Ok(None);
        };
        let interaction = self
            .interaction_store
            .get(interaction_id)
            .await?
            .ok_or_else(|| AgentError::PromptError {
                reason: format!(
                    "durable pipeline owner for issue {issue_id} references missing interaction '{interaction_id}'"
                ),
            })?;
        if interaction.status != InteractionStatus::Resolved {
            return Err(AgentError::PromptError {
                reason: format!(
                    "durable pipeline owner for issue {issue_id} references interaction '{interaction_id}' that is not resolved"
                ),
            }
            .into());
        }
        let response = match interaction.resume_strategy {
            InteractionResumeStrategy::RerunStep => {
                let response =
                    interaction
                        .response
                        .clone()
                        .ok_or_else(|| AgentError::PromptError {
                            reason: format!(
                                "resolved interaction '{interaction_id}' for issue {issue_id} has no response"
                            ),
                        })?;
                let resolved_at =
                    interaction
                        .resolved_at
                        .ok_or_else(|| AgentError::PromptError {
                            reason: format!(
                                "resolved interaction '{interaction_id}' for issue {issue_id} has no resolution timestamp"
                            ),
                        })?;
                Some(InteractionResponseEnvelope::new(
                    interaction.schema_version,
                    interaction.id.clone(),
                    interaction.kind.clone(),
                    response,
                    resolved_at,
                ))
            }
            InteractionResumeStrategy::AdvanceAfterStep => None,
        };
        Ok(Some((
            interaction.id.clone(),
            interaction.step_name,
            response,
            interaction.awaiting_resume,
        )))
    }

    async fn handle_step_dispatch_error(
        &self,
        issue: &Issue,
        step_name: &str,
        config_snapshot: &Arc<EnsembleConfig>,
        error: &EnsembleError,
    ) {
        warn!(
            issue_id = %issue.id,
            step = step_name,
            error = %error,
            "failed to persist step dispatch"
        );
        let terminal = {
            let mut state = self.state.write().await;
            let Some(run) = state.get_pipeline_run_mut(&issue.id) else {
                return;
            };
            if matches!(
                run.step_states.get(step_name),
                Some(StepState::Running { .. })
            ) {
                warn!(
                    issue_id = %issue.id,
                    step = step_name,
                    "retaining ambiguous running owner for restart reconciliation"
                );
                return;
            }
            if run.step_states.iter().any(|(name, step_state)| {
                name != step_name && matches!(step_state, StepState::Running { .. })
            }) {
                return;
            }

            run.step_failed(step_name, error.to_string());
            state.remove_running(&issue.id).map(|entry| {
                self.schedule_whole_issue_failure_retry(
                    &mut state,
                    config_snapshot,
                    entry,
                    &error.to_string(),
                    ScheduledRetryPipeline::Release,
                )
            })
        };
        self.commit_whole_issue_failure_retry(terminal).await;
    }

    async fn prepare_step_workspace(
        &self,
        issue: &Issue,
        config_snapshot: &Arc<EnsembleConfig>,
    ) -> Result<std::path::PathBuf, EnsembleError> {
        let workspace = self
            .workspace_mgr
            .prepare_workspace(&issue.id, &issue.identifier)
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

    async fn run_acceptance_phase(
        &self,
        issue: &Issue,
        config: &EnsembleConfig,
    ) -> AcceptancePhaseOutcome {
        loop {
            let (baseline, mut candidate, run_id, owner) = {
                let state = self.state.read().await;
                let Some(run) = state.get_pipeline_run(&issue.id).cloned() else {
                    warn!(issue_id = %issue.id, "acceptance phase has no pipeline run");
                    return AcceptancePhaseOutcome::RetainedForRecovery;
                };
                let run_id = state
                    .running
                    .get(&issue.id)
                    .and_then(|entry| entry.run_id.clone())
                    .or_else(|| {
                        state
                            .waiting_on_human
                            .get(&issue.id)
                            .and_then(|entry| entry.run_id.clone())
                    })
                    .or_else(|| state.issue_run_ids.get(&issue.id).cloned());
                let Some(owner) = AcceptanceOwnerIdentity::capture(&state, &issue.id) else {
                    warn!(issue_id = %issue.id, "acceptance phase has no current owner");
                    return AcceptancePhaseOutcome::RetainedForRecovery;
                };
                (run.to_snapshot(), run, run_id, owner)
            };

            if let Err(error) = validate_acceptance_attempts(&candidate.to_snapshot(), config) {
                warn!(issue_id = %issue.id, error = %error, "acceptance evidence does not match config");
                return AcceptancePhaseOutcome::RetainedForRecovery;
            }
            if config.acceptance.commands.is_empty() {
                return AcceptancePhaseOutcome::Passed;
            }

            let current_attempt = candidate
                .acceptance_attempts
                .iter()
                .position(|attempt| attempt.cycle == candidate.cycle);
            let command_to_run = if let Some(attempt_index) = current_attempt {
                let results = &candidate.acceptance_attempts[attempt_index].results;
                if results.len() == config.acceptance.commands.len() {
                    if results
                        .iter()
                        .all(|result| result.status == AcceptanceStatus::Passed)
                    {
                        return AcceptancePhaseOutcome::Passed;
                    }
                    let summary = results
                        .iter()
                        .find(|result| result.status != AcceptanceStatus::Passed)
                        .map(|result| result.summary.clone())
                        .unwrap_or_else(|| "acceptance failed".to_string());
                    return AcceptancePhaseOutcome::Failed {
                        reason: summary,
                        owner,
                    };
                }
                config.acceptance.commands.get(results.len()).cloned()
            } else {
                candidate
                    .acceptance_attempts
                    .push(crate::acceptance::AcceptanceAttempt {
                        cycle: candidate.cycle,
                        results: Vec::new(),
                    });
                None
            };
            let transition_kind = if command_to_run.is_some() {
                PipelineTransitionKind::AcceptanceCommandCompleted
            } else {
                PipelineTransitionKind::AcceptanceStarted
            };

            let result = if let Some(command) = command_to_run.as_ref() {
                let workspace_path = self.workspace_mgr.workspace_path(&issue.id);
                Some(self.acceptance_runner.run(command, &workspace_path).await)
            } else {
                None
            };
            {
                let state = self.state.read().await;
                if !Self::acceptance_owner_matches_run(&state, &issue.id, &owner, &baseline) {
                    warn!(issue_id = %issue.id, "acceptance execution belongs to a stale running attempt");
                    return AcceptancePhaseOutcome::RetainedForRecovery;
                }
            }
            let reason = if let Some(result) = result {
                let Some(attempt) = candidate
                    .acceptance_attempts
                    .iter_mut()
                    .find(|attempt| attempt.cycle == candidate.cycle)
                else {
                    return AcceptancePhaseOutcome::RetainedForRecovery;
                };
                let summary = result.summary.clone();
                attempt.results.push(result);
                Some(summary)
            } else {
                None
            };
            let candidate_snapshot = candidate.to_snapshot();
            let transition = PipelineTransitionInput {
                kind: transition_kind,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id,
                cycle: candidate.cycle,
                step: None,
                reason,
                retry: None,
                snapshot: Some(candidate_snapshot.clone()),
                terminal_transition: None,
            };
            let journal_transaction = self
                .pipeline_journal
                .begin_issue_transition(&issue.id)
                .await;
            if let Err(error) = journal_transaction.append(transition.clone()).await {
                match journal_transaction.latest_record_matches(&transition).await {
                    Ok(true) => {}
                    Ok(false) => {
                        drop(journal_transaction);
                        warn!(issue_id = %issue.id, error = %error, "acceptance transition was not journaled; scheduling in-process recovery");
                        self.release_acceptance_owner_for_recovery(
                            &issue.id, &owner, &baseline, None,
                        )
                        .await;
                        return AcceptancePhaseOutcome::RetainedForRecovery;
                    }
                    Err(reconciliation_error) => {
                        warn!(issue_id = %issue.id, append_error = %error, reconciliation_error = %reconciliation_error, "acceptance transition outcome is ambiguous; retaining the active owner for recovery");
                        self.pending_acceptance_transitions
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .insert(
                                issue.id.clone(),
                                PendingAcceptanceTransition {
                                    expected: transition,
                                    candidate: candidate_snapshot,
                                    owner,
                                    baseline,
                                },
                            );
                        self.refresh_requested.notify_one();
                        return AcceptancePhaseOutcome::RetainedForRecovery;
                    }
                }
            }
            drop(journal_transaction);

            let mut state = self.state.write().await;
            let owner_is_current =
                Self::acceptance_owner_matches_run(&state, &issue.id, &owner, &baseline);
            let Some(current) = state.get_pipeline_run_mut(&issue.id) else {
                return AcceptancePhaseOutcome::RetainedForRecovery;
            };
            if !owner_is_current {
                warn!(issue_id = %issue.id, "acceptance result belongs to a stale running attempt");
                return AcceptancePhaseOutcome::RetainedForRecovery;
            }
            current.acceptance_attempts = candidate.acceptance_attempts;
        }
    }

    async fn reconcile_pending_acceptance_transitions(&self) {
        let pending = self
            .pending_acceptance_transitions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for pending in pending {
            let issue_id = pending.expected.issue_id.clone();
            let journal_transaction = self
                .pipeline_journal
                .begin_issue_transition(&issue_id)
                .await;
            let visibility = journal_transaction
                .latest_record_matches(&pending.expected)
                .await;
            drop(journal_transaction);
            match visibility {
                Ok(is_exact) => {
                    let released = self
                        .release_acceptance_owner_for_recovery(
                            &issue_id,
                            &pending.owner,
                            &pending.baseline,
                            is_exact.then_some(&pending.candidate),
                        )
                        .await;
                    let owner_is_still_current = if released {
                        false
                    } else {
                        let state = self.state.read().await;
                        Self::acceptance_owner_matches_run(
                            &state,
                            &issue_id,
                            &pending.owner,
                            &pending.baseline,
                        )
                    };
                    if released || !owner_is_still_current {
                        self.pending_acceptance_transitions
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&issue_id);
                    }
                }
                Err(error) => warn!(
                    issue_id,
                    error = %error,
                    "acceptance transition remains ambiguous; retaining the active owner"
                ),
            }
        }
    }

    fn acceptance_owner_matches_run(
        state: &OrchestratorState,
        issue_id: &str,
        owner: &AcceptanceOwnerIdentity,
        baseline: &PipelineRunSnapshot,
    ) -> bool {
        owner.is_current(state, issue_id)
            && state
                .get_pipeline_run(issue_id)
                .is_some_and(|run| run.to_snapshot() == *baseline)
    }

    async fn release_acceptance_owner_for_recovery(
        &self,
        issue_id: &str,
        owner: &AcceptanceOwnerIdentity,
        baseline: &PipelineRunSnapshot,
        replacement: Option<&PipelineRunSnapshot>,
    ) -> bool {
        if let AcceptanceOwnerIdentity::Waiting {
            interaction_request_id,
            ..
        } = owner
        {
            let is_current = {
                let state = self.state.read().await;
                Self::acceptance_owner_matches_run(&state, issue_id, owner, baseline)
            };
            if !is_current {
                return false;
            }
            let (previous, cleared) = match self
                .interaction_store
                .retire_waiting_state(interaction_request_id)
                .await
            {
                Ok(retired) => retired,
                Err(error) => {
                    warn!(issue_id, interaction_id = interaction_request_id, error = %error, "failed to retire acceptance recovery interaction owner");
                    return false;
                }
            };
            let released = {
                let mut state = self.state.write().await;
                let is_current =
                    Self::acceptance_owner_matches_run(&state, issue_id, owner, baseline);
                if is_current {
                    if let (Some(current), Some(replacement)) =
                        (state.get_pipeline_run_mut(issue_id), replacement)
                    {
                        current.acceptance_attempts = replacement.acceptance_attempts.clone();
                    }
                    state.remove_waiting_on_human(issue_id);
                }
                is_current
            };
            if released {
                self.refresh_requested.notify_one();
            } else if let Err(error) = self
                .interaction_store
                .restore_waiting_state_after_failed_transition(&cleared, &previous)
                .await
            {
                warn!(issue_id, interaction_id = interaction_request_id, error = %error, "failed to restore stale acceptance interaction owner");
            }
            return released;
        }

        let released = {
            let mut state = self.state.write().await;
            let is_current = Self::acceptance_owner_matches_run(&state, issue_id, owner, baseline);
            if !is_current {
                false
            } else {
                if let (Some(current), Some(replacement)) =
                    (state.get_pipeline_run_mut(issue_id), replacement)
                {
                    current.acceptance_attempts = replacement.acceptance_attempts.clone();
                }
                state.remove_running(issue_id);
                true
            }
        };
        if released {
            self.refresh_requested.notify_one();
        }
        released
    }

    async fn schedule_acceptance_failure(
        &self,
        issue: &Issue,
        config: &EnsembleConfig,
        reason: &str,
        owner: &AcceptanceOwnerIdentity,
    ) {
        let outcome = {
            let mut state = self.state.write().await;
            if !owner.is_current(&state, &issue.id) {
                warn!(issue_id = %issue.id, "acceptance failure belongs to a stale owner");
                return;
            }
            let entry = state.remove_running(&issue.id).or_else(|| {
                state
                    .remove_waiting_on_human(&issue.id)
                    .map(|waiting| RunningEntry {
                        issue_id: issue.id.clone(),
                        identifier: issue.identifier.clone(),
                        run_id: waiting
                            .run_id
                            .or_else(|| state.issue_run_ids.get(&issue.id).cloned()),
                        issue: issue.clone(),
                        session_id: None,
                        agent_pid: None,
                        last_agent_event: None,
                        last_agent_timestamp: None,
                        last_agent_message: None,
                        agent_input_tokens: waiting.agent_input_tokens,
                        agent_output_tokens: waiting.agent_output_tokens,
                        agent_total_tokens: waiting.agent_total_tokens,
                        last_reported_input_tokens: waiting.agent_input_tokens,
                        last_reported_output_tokens: waiting.agent_output_tokens,
                        last_reported_total_tokens: waiting.agent_total_tokens,
                        turn_count: 0,
                        retry_attempt: waiting.retry_attempt,
                        started_at: waiting.started_at.unwrap_or(waiting.requested_at),
                    })
            });
            entry.map(|entry| {
                self.schedule_whole_issue_failure_retry(
                    &mut state,
                    config,
                    entry,
                    reason,
                    ScheduledRetryPipeline::Release,
                )
            })
        };
        self.commit_whole_issue_failure_retry(outcome).await;
    }

    /// Dispatch a single pipeline step after its workspace is ready.
    async fn dispatch_step(
        &self,
        issue: &Issue,
        config_snapshot: Arc<EnsembleConfig>,
        dispatch: StepDispatchContext<'_>,
        _permit: &DispatchPermit,
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

        // Reserve this issue's journal ordering before publishing the speculative
        // in-memory owner. The global state lock is not held during journal I/O.
        let journal_transaction = self
            .pipeline_journal
            .begin_issue_transition(&issue.id)
            .await;

        // Mark step as running in pipeline
        let (
            run_id,
            sequence,
            attempt_num,
            step_running_transition,
            worker_identity,
            previous_step_state,
            running_session_id,
        ) = {
            let mut state = self.state.write().await;
            let running_entry =
                state
                    .get_running(&issue.id)
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!(
                            "cannot dispatch step '{}' without a running issue",
                            dispatch.step_name
                        ),
                    })?;
            let identity_run_id =
                running_entry
                    .run_id
                    .clone()
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!(
                            "cannot dispatch step '{}' without a stable run id",
                            dispatch.step_name
                        ),
                    })?;
            let started_at = running_entry.started_at;
            let cycle = state
                .get_pipeline_run(&issue.id)
                .map(|run| run.cycle)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!(
                        "cannot dispatch step '{}' without a pipeline run",
                        dispatch.step_name
                    ),
                })?;
            let run_context = Self::run_context_for_issue(&mut state, &issue.id);
            let run =
                state
                    .get_pipeline_run_mut(&issue.id)
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!(
                            "cannot dispatch step '{}' without a pipeline run",
                            dispatch.step_name
                        ),
                    })?;
            let previous_step_state = run.step_states.get(dispatch.step_name).cloned();
            let running_session_id = format!(
                "{}-{}-{}",
                issue.id, dispatch.step_name, dispatch.agent_name
            );
            run.mark_running(dispatch.step_name, running_session_id.clone());
            let transition = Self::transition_input_for_run(
                &state,
                &issue.id,
                &issue.identifier,
                PipelineTransitionKind::StepRunning,
                Some(dispatch.step_name.to_string()),
                dispatch.interaction_resume_id.map(|interaction_id| {
                    format!("{INTERACTION_RESUME_REASON_PREFIX}{interaction_id}")
                }),
                None,
            );
            let worker_identity = WorkerIdentity {
                issue_id: issue.id.clone(),
                run_id: identity_run_id,
                cycle,
                step_name: dispatch.step_name.to_string(),
                started_at,
            };
            (
                run_context.0,
                run_context.1,
                run_context.2,
                transition,
                worker_identity,
                previous_step_state,
                running_session_id,
            )
        };

        if let Some(input) = step_running_transition {
            let input_for_reconciliation = input.clone();
            if let Err(error) = journal_transaction.append(input).await {
                match journal_transaction
                    .latest_record_matches(&input_for_reconciliation)
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        let mut state = self.state.write().await;
                        if state
                            .get_pipeline_run(&issue.id)
                            .and_then(|run| run.step_states.get(dispatch.step_name))
                            == Some(&StepState::Running {
                                session_id: running_session_id,
                            })
                        {
                            if let Some(previous_step_state) = previous_step_state {
                                state
                                    .get_pipeline_run_mut(&issue.id)
                                    .expect(
                                        "pipeline run was present while validating dispatch rollback",
                                    )
                                    .step_states
                                    .insert(dispatch.step_name.to_string(), previous_step_state);
                            }
                        }
                        return Err(AgentError::PromptError {
                            reason: format!(
                                "failed to persist step '{}' dispatch: {error}",
                                dispatch.step_name
                            ),
                        }
                        .into());
                    }
                    Err(reconciliation_error) => {
                        warn!(
                            issue_id = %issue.id,
                            step = dispatch.step_name,
                            append_error = %error,
                            reconciliation_error = %reconciliation_error,
                            "step dispatch append outcome is ambiguous; retaining the speculative owner"
                        );
                        return Err(AgentError::PromptError {
                            reason: format!(
                                "failed to confirm step '{}' dispatch persistence after append error: {error}; reconciliation failed: {reconciliation_error}",
                                dispatch.step_name
                            ),
                        }
                        .into());
                    }
                }
            }
        }

        if let Some(interaction_id) = dispatch.interaction_to_retire {
            if let Err(interaction_error) = self
                .interaction_store
                .retire_waiting_state(interaction_id)
                .await
            {
                let derived_rollback_transition = {
                    let mut state = self.state.write().await;
                    let run = state.get_pipeline_run_mut(&issue.id);
                    if let Some(run) = run {
                        if run.step_states.get(dispatch.step_name)
                            == Some(&StepState::Running {
                                session_id: running_session_id.clone(),
                            })
                        {
                            if let Some(previous_step_state) = previous_step_state.clone() {
                                run.step_states
                                    .insert(dispatch.step_name.to_string(), previous_step_state);
                            }
                        }
                    }
                    let rollback_kind = match previous_step_state {
                        Some(StepState::BlockedOnHuman { .. }) => {
                            Some(PipelineTransitionKind::StepBlockedOnHuman)
                        }
                        Some(StepState::AwaitingApproval { .. }) => {
                            Some(PipelineTransitionKind::StepAwaitingApproval)
                        }
                        _ => None,
                    };
                    rollback_kind.and_then(|kind| {
                        Self::transition_input_for_run(
                            &state,
                            &issue.id,
                            &issue.identifier,
                            kind,
                            Some(dispatch.step_name.to_string()),
                            Some(format!(
                                "interaction '{}' retirement failed: {interaction_error}",
                                interaction_id
                            )),
                            None,
                        )
                    })
                };
                let rollback_transition = dispatch
                    .interaction_retirement_rollback
                    .clone()
                    .or(derived_rollback_transition);
                if let Some(rollback_transition) = rollback_transition {
                    if let Err(rollback_error) =
                        journal_transaction.append(rollback_transition).await
                    {
                        warn!(
                            issue_id = %issue.id,
                            step = dispatch.step_name,
                            interaction_id,
                            error = %rollback_error,
                            "failed to persist blocked owner after interaction retirement failure"
                        );
                    }
                }
                return Err(interaction_error.into());
            }
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
        let orchestrator_event_tx = self.worker_tx.clone();
        let workspace_path = dispatch.workspace_path.clone();
        let attempt = dispatch.attempt;
        let timeout_ms = dispatch.timeout_ms;
        let step_outputs = dispatch.step_outputs.clone();
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let (local_event_tx, local_event_rx) = mpsc::channel(100);
        let (completion_tx, completion_rx) = watch::channel(false);
        register_worker(
            &self.cancellation_registry,
            worker_identity.clone(),
            cancel_token.clone(),
            completion_rx,
        );
        let bridge_registry = self.cancellation_registry.clone();
        let bridge_identity = worker_identity.clone();
        tokio::spawn(bridge_worker_events(
            local_event_rx,
            orchestrator_event_tx,
            bridge_registry,
            bridge_identity,
            completion_tx,
        ));
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
                    event_tx: local_event_tx.clone(),
                    cancel_token,
                    step_outputs,
                }),
                &issue_clone.id,
                &step_name_owned,
            )
            .await;

            let _ = local_event_tx
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
    async fn handle_worker_event(&self, owned_event: OrchestratorWorkerEvent) {
        let worker_exit_permit = if matches!(&owned_event.event, WorkerEvent::WorkerExited { .. }) {
            let Some(permit) = self.quiescing.begin_dispatch() else {
                return;
            };
            Some(permit)
        } else {
            None
        };
        let identity = owned_event.identity;
        let event_matches_identity = match &owned_event.event {
            WorkerEvent::AgentUpdate {
                issue_id,
                step_name,
                ..
            }
            | WorkerEvent::WorkerExited {
                issue_id,
                step_name,
                ..
            } => issue_id == &identity.issue_id && step_name == &identity.step_name,
        };
        if !event_matches_identity || !self.worker_identity_is_current(&identity).await {
            return;
        }

        let reconciliation_owned = is_reconciliation_owned(&self.cancellation_registry, &identity);
        match owned_event.event {
            WorkerEvent::AgentUpdate {
                issue_id,
                step_name,
                event: agent_event,
                timestamp,
            } => {
                if reconciliation_owned {
                    return;
                }
                self.handle_agent_update(&issue_id, &step_name, agent_event, timestamp)
                    .await;
            }
            WorkerEvent::WorkerExited {
                issue_id,
                step_name,
                result,
                ..
            } => {
                if !reconciliation_owned {
                    self.handle_worker_exit_with_permit(
                        &issue_id,
                        &step_name,
                        result,
                        worker_exit_permit
                            .as_ref()
                            .expect("worker exit has a dispatch permit"),
                    )
                    .await;
                }
            }
        }
    }

    #[cfg(test)]
    async fn handle_unowned_test_event(&self, event: WorkerEvent) {
        match event {
            WorkerEvent::AgentUpdate {
                issue_id,
                step_name,
                event,
                timestamp,
            } => {
                self.handle_agent_update(&issue_id, &step_name, event, timestamp)
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

    async fn worker_identity_is_current(&self, identity: &WorkerIdentity) -> bool {
        let state = self.state.read().await;
        let Some(entry) = state.get_running(&identity.issue_id) else {
            return false;
        };
        let Some(run) = state.get_pipeline_run(&identity.issue_id) else {
            return false;
        };
        entry.run_id.as_deref() == Some(identity.run_id.as_str())
            && entry.started_at == identity.started_at
            && run.cycle == identity.cycle
            && matches!(
                run.step_states.get(&identity.step_name),
                Some(StepState::Running { .. })
            )
    }

    async fn cancel_and_drain_for_reconciliation(&self, issue_id: &str) -> Option<DrainedWorkers> {
        let owner = {
            let state = self.state.read().await;
            ReconciliationOwner::capture(&state, issue_id)
        };
        let mut handles = mark_issue_for_drain(&self.cancellation_registry, issue_id);
        if !self
            .await_worker_drain_with_event_pump(
                &mut handles,
                WORKER_DRAIN_TIMEOUT,
                DrainEventMode::ApplyExceptIssue(issue_id),
            )
            .await
        {
            warn!(
                issue_id = %issue_id,
                workers = handles.len(),
                "worker drain timed out; retaining reconciliation ownership"
            );
            return None;
        }
        Some(DrainedWorkers { owner, handles })
    }

    async fn issue_is_stalled(&self, issue_id: &str, stall_timeout_ms: i64) -> bool {
        let state = self.state.read().await;
        reconcile_stalled_runs(&state, stall_timeout_ms)
            .stalled_issue_ids
            .iter()
            .any(|stalled_issue_id| stalled_issue_id == issue_id)
    }

    async fn current_reconcile_disposition(
        &self,
        issue_id: &str,
        active_states_lower: &[String],
        terminal_states_lower: &[String],
        stall_timeout_ms: i64,
    ) -> Option<CurrentReconcileDisposition> {
        let refreshed = match self
            .tracker
            .fetch_issue_states_by_ids(&[issue_id.to_string()])
            .await
        {
            Ok(issues) => issues,
            Err(error) => {
                warn!(
                    issue_id = %issue_id,
                    error = %error,
                    "tracker candidate refresh failed, retaining runtime ownership"
                );
                return None;
            }
        };
        let Some(issue) = refreshed.into_iter().find(|issue| issue.id == issue_id) else {
            return Some(CurrentReconcileDisposition::Inactive);
        };
        self.state
            .write()
            .await
            .update_issue_snapshot(issue_id, issue.clone());
        match determine_reconcile_action(&issue, active_states_lower, terminal_states_lower) {
            ReconcileAction::TerminateAndCleanup(issue) => {
                Some(CurrentReconcileDisposition::Terminal {
                    identifier: issue.identifier,
                })
            }
            ReconcileAction::TerminateNoCleanup(_) => Some(CurrentReconcileDisposition::Inactive),
            ReconcileAction::UpdateSnapshot(_) => {
                if self.issue_is_stalled(issue_id, stall_timeout_ms).await {
                    Some(CurrentReconcileDisposition::Stalled)
                } else {
                    Some(CurrentReconcileDisposition::Active)
                }
            }
        }
    }

    async fn resume_pending_reconciliation(
        &self,
        issue_id: &str,
        active_states_lower: &[String],
        terminal_states_lower: &[String],
    ) {
        let stall_timeout_ms = self.config.read().await.agent.stall_timeout_ms;
        let Some(drained) = self.cancel_and_drain_for_reconciliation(issue_id).await else {
            return;
        };
        let Some(disposition) = self
            .current_reconcile_disposition(
                issue_id,
                active_states_lower,
                terminal_states_lower,
                stall_timeout_ms,
            )
            .await
        else {
            return;
        };
        self.commit_drained_reconciliation(issue_id, drained, disposition)
            .await;
    }

    async fn reconcile_tracker_candidate(
        &self,
        issue_id: &str,
        active_states_lower: &[String],
        terminal_states_lower: &[String],
        expected: TrackerReconcileDisposition,
    ) {
        let stall_timeout_ms = self.config.read().await.agent.stall_timeout_ms;
        let Some(disposition) = self
            .current_reconcile_disposition(
                issue_id,
                active_states_lower,
                terminal_states_lower,
                stall_timeout_ms,
            )
            .await
        else {
            return;
        };
        let expected_matches = matches!(
            (expected, disposition),
            (
                TrackerReconcileDisposition::Terminal,
                CurrentReconcileDisposition::Terminal { .. },
            ) | (
                TrackerReconcileDisposition::Inactive,
                CurrentReconcileDisposition::Inactive,
            )
        );
        if !expected_matches {
            return;
        }
        let Some(drained) = self.cancel_and_drain_for_reconciliation(issue_id).await else {
            return;
        };
        let Some(disposition) = self
            .current_reconcile_disposition(
                issue_id,
                active_states_lower,
                terminal_states_lower,
                stall_timeout_ms,
            )
            .await
        else {
            return;
        };
        self.commit_drained_reconciliation(issue_id, drained, disposition)
            .await;
    }

    async fn reconcile_stalled_issue(&self, issue_id: &str, stall_timeout_ms: i64) {
        if !self.issue_is_stalled(issue_id, stall_timeout_ms).await {
            return;
        }
        let Some(drained) = self.cancel_and_drain_for_reconciliation(issue_id).await else {
            return;
        };
        let (active_states_lower, terminal_states_lower) = {
            let config = self.config.read().await;
            (
                build_reconcile_active_states_lower(&config),
                config
                    .tracker
                    .terminal_states
                    .iter()
                    .map(|state| state.to_lowercase())
                    .collect::<Vec<_>>(),
            )
        };
        let Some(disposition) = self
            .current_reconcile_disposition(
                issue_id,
                &active_states_lower,
                &terminal_states_lower,
                stall_timeout_ms,
            )
            .await
        else {
            return;
        };
        self.commit_drained_reconciliation(issue_id, drained, disposition)
            .await;
    }

    async fn commit_drained_reconciliation(
        &self,
        issue_id: &str,
        drained: DrainedWorkers,
        disposition: CurrentReconcileDisposition,
    ) {
        match disposition {
            CurrentReconcileDisposition::Terminal { identifier } => {
                let result = {
                    let mut state = self.state.write().await;
                    if !drained.owner.is_current(&state, issue_id) {
                        warn!(
                            issue_id = %issue_id,
                            "terminal reconciliation owner changed before commit"
                        );
                        return;
                    }
                    let running_entry = state.remove_running(issue_id);
                    if let Some(entry) = running_entry.as_ref() {
                        state.add_runtime_seconds(entry);
                    }
                    let history_record = running_entry.as_ref().and_then(|entry| {
                        state.get_pipeline_run(issue_id).map(|run| {
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_STOPPED,
                                last_error: None,
                                running_entry: entry,
                                run,
                                completed_at: Utc::now(),
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        })
                    });
                    let waiting_entry = state.waiting_on_human.get(issue_id).cloned();
                    let identifier = waiting_entry
                        .as_ref()
                        .map(|entry| entry.identifier.clone())
                        .unwrap_or(identifier);
                    let interaction_request_id =
                        waiting_entry.map(|entry| entry.interaction_request_id);
                    let history_run_id = running_entry
                        .as_ref()
                        .and_then(|entry| entry.run_id.clone());
                    state.release_claim(issue_id);
                    state.remove_pipeline_run(issue_id);
                    (
                        identifier,
                        interaction_request_id,
                        history_record,
                        history_run_id,
                    )
                };
                remove_drained_workers(&self.cancellation_registry, &drained.handles);
                self.cancel_open_interaction(result.1).await;
                if let Err(error) = self.workspace_mgr.remove_workspace(issue_id).await {
                    warn!(
                        identifier = %result.0,
                        error = %error,
                        "failed to clean terminal workspace"
                    );
                }
                if let Some(record) = result.2 {
                    self.append_history_record(result.3.as_deref(), record)
                        .await;
                }
            }
            CurrentReconcileDisposition::Inactive => {
                let result = {
                    let mut state = self.state.write().await;
                    if !drained.owner.is_current(&state, issue_id) {
                        warn!(
                            issue_id = %issue_id,
                            "inactive reconciliation owner changed before commit"
                        );
                        return;
                    }
                    let running_entry = state.remove_running(issue_id);
                    if let Some(entry) = running_entry.as_ref() {
                        state.add_runtime_seconds(entry);
                    }
                    let history_record = running_entry.as_ref().and_then(|entry| {
                        state.get_pipeline_run(issue_id).map(|run| {
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_STOPPED,
                                last_error: None,
                                running_entry: entry,
                                run,
                                completed_at: Utc::now(),
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        })
                    });
                    let interaction_request_id = state
                        .waiting_on_human
                        .get(issue_id)
                        .map(|entry| entry.interaction_request_id.clone());
                    let history_run_id = running_entry
                        .as_ref()
                        .and_then(|entry| entry.run_id.clone());
                    state.release_claim(issue_id);
                    state.remove_pipeline_run(issue_id);
                    (interaction_request_id, history_record, history_run_id)
                };
                remove_drained_workers(&self.cancellation_registry, &drained.handles);
                self.cancel_open_interaction(result.0).await;
                if let Some(record) = result.1 {
                    self.append_history_record(result.2.as_deref(), record)
                        .await;
                }
            }
            retry_disposition @ (CurrentReconcileDisposition::Stalled
            | CurrentReconcileDisposition::Active) => {
                let error = if matches!(retry_disposition, CurrentReconcileDisposition::Stalled) {
                    "stall timeout"
                } else {
                    "worker cancelled during reconciliation"
                };
                let retry_config = {
                    let config = self.config.read().await;
                    config.clone()
                };
                let mut state = self.state.write().await;
                if !drained.owner.is_current(&state, issue_id) {
                    warn!(
                        issue_id = %issue_id,
                        "retry reconciliation owner changed before commit"
                    );
                    return;
                }
                let terminal = state.remove_running(issue_id).map(|entry| {
                    self.schedule_whole_issue_failure_retry(
                        &mut state,
                        &retry_config,
                        entry,
                        error,
                        ScheduledRetryPipeline::Preserve,
                    )
                });
                drop(state);
                self.commit_whole_issue_failure_retry(terminal).await;
                remove_drained_workers(&self.cancellation_registry, &drained.handles);
            }
        }
    }

    async fn await_worker_drain_with_event_pump(
        &self,
        handles: &mut [WorkerDrainHandle],
        drain_timeout: Duration,
        event_mode: DrainEventMode<'_>,
    ) -> bool {
        let drain = await_worker_drain(handles, drain_timeout);
        tokio::pin!(drain);

        loop {
            tokio::select! {
                drained = &mut drain => return drained,
                Some(event) = recv_worker_event(&self.worker_rx) => {
                    if matches!(
                        event_mode,
                        DrainEventMode::ApplyExceptIssue(issue_id)
                            if event.identity.issue_id != issue_id
                    ) {
                        self.handle_worker_event(event).await;
                    }
                }
            }
        }
    }

    async fn await_worker_quiescence_with_event_pump(
        &self,
        handles: &mut [WorkerDrainHandle],
        event_mode: DrainEventMode<'_>,
    ) -> bool {
        let drain = await_worker_quiescence(handles);
        tokio::pin!(drain);

        loop {
            tokio::select! {
                drained = &mut drain => return drained,
                Some(event) = recv_worker_event(&self.worker_rx) => {
                    if matches!(
                        event_mode,
                        DrainEventMode::ApplyExceptIssue(issue_id)
                            if event.identity.issue_id != issue_id
                    ) {
                        self.handle_worker_event(event).await;
                    }
                }
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
    #[cfg(test)]
    async fn handle_worker_exit(&self, issue_id: &str, step_name: &str, result: WorkerResult) {
        let Some(permit) = self.quiescing.begin_dispatch() else {
            return;
        };
        self.handle_worker_exit_with_permit(issue_id, step_name, result, &permit)
            .await;
    }

    async fn handle_worker_exit_with_permit(
        &self,
        issue_id: &str,
        step_name: &str,
        result: WorkerResult,
        worker_exit_permit: &DispatchPermit,
    ) {
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
                                            let terminal =
                                                state.remove_running(issue_id).map(|entry| {
                                                    self.schedule_whole_issue_failure_retry(
                                                        &mut state,
                                                        &config_snapshot,
                                                        entry,
                                                        &error.to_string(),
                                                        ScheduledRetryPipeline::Release,
                                                    )
                                                });
                                            drop(state);
                                            self.commit_whole_issue_failure_retry(terminal).await;
                                            return;
                                        }
                                    };

                                    if let Err(error) = self
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
                                                interaction_resume_id: None,
                                                interaction_to_retire: None,
                                                interaction_retirement_rollback: None,
                                                workspace_path,
                                                step_outputs,
                                            },
                                            worker_exit_permit,
                                        )
                                        .await
                                    {
                                        self.handle_step_dispatch_error(
                                            issue,
                                            &req.step_name,
                                            &config_snapshot,
                                            &error,
                                        )
                                        .await;
                                        return;
                                    }
                                }
                            }
                        }
                        PipelineAction::Succeeded => {
                            info!(issue_id = %issue_id, "pipeline succeeded");
                            let issue_identifier = issue_snapshot
                                .as_ref()
                                .map(|issue| issue.identifier.clone())
                                .unwrap_or_else(|| issue_id.to_string());
                            let finalize_attempt =
                                RunningAttemptIdentity::capture(&state, issue_id);
                            let acceptance_issue = issue_snapshot.clone().or_else(|| {
                                state.running.get(issue_id).map(|entry| entry.issue.clone())
                            });
                            let config_snapshot = config.clone();
                            drop(config);
                            drop(state);
                            if let Some(input) = step_transition {
                                self.append_pipeline_transition(input).await;
                            }
                            let Some(acceptance_issue) = acceptance_issue else {
                                warn!(issue_id = %issue_id, "pipeline success has no issue identity for acceptance");
                                return;
                            };
                            match self
                                .run_acceptance_phase(&acceptance_issue, &config_snapshot)
                                .await
                            {
                                AcceptancePhaseOutcome::Passed => {}
                                AcceptancePhaseOutcome::Failed { reason, owner } => {
                                    self.schedule_acceptance_failure(
                                        &acceptance_issue,
                                        &config_snapshot,
                                        &reason,
                                        &owner,
                                    )
                                    .await;
                                    return;
                                }
                                AcceptancePhaseOutcome::RetainedForRecovery => return,
                            }
                            let finalize_state = self
                                .finalize_and_stage_terminal_transition(
                                    issue_id,
                                    &issue_identifier,
                                    &config_snapshot,
                                )
                                .await;

                            let (tracker_state, terminal_outcome, terminal_issue, history) = {
                                let mut state = self.state.write().await;
                                if !Self::finalization_attempt_is_current(
                                    finalize_attempt.as_ref(),
                                    &state,
                                    issue_id,
                                ) {
                                    warn!(
                                        issue_id = %issue_id,
                                        "discarding stale finalization result because the running attempt changed"
                                    );
                                    return;
                                }
                                let completed_at = Utc::now();
                                let history_record = state
                                    .running
                                    .get(issue_id)
                                    .zip(state.get_pipeline_run(issue_id))
                                    .map(|(entry, run)| {
                                        self.build_history_record(RunningHistoryRecordInput {
                                            outcome: HISTORY_OUTCOME_SUCCEEDED,
                                            last_error: None,
                                            running_entry: entry,
                                            run,
                                            completed_at,
                                            artifacts: state.artifacts.get(issue_id).cloned(),
                                        })
                                    });
                                let running_entry = state.get_running(issue_id).cloned();
                                let terminal_issue = running_entry
                                    .as_ref()
                                    .map(|entry| entry.issue.clone())
                                    .or(issue_snapshot.clone());

                                if matches!(
                                    finalize_state.status,
                                    FinalizeStatus::Succeeded | FinalizeStatus::NotRequired
                                ) {
                                    (
                                        Some(config_snapshot.on_success.clone()),
                                        Some(TerminalOutcome::Succeeded),
                                        terminal_issue,
                                        history_record,
                                    )
                                } else {
                                    let is_terminal_failure =
                                        finalize_state.status == FinalizeStatus::SkippedHeadless;
                                    if let Some(entry) = state.remove_running(issue_id) {
                                        state.add_runtime_seconds(&entry);
                                    }
                                    state.set_finalize_state(issue_id, finalize_state);
                                    if !is_terminal_failure {
                                        state.remove_pipeline_run(issue_id);
                                    }
                                    (
                                        is_terminal_failure
                                            .then(|| config_snapshot.on_failure.clone()),
                                        is_terminal_failure.then_some(TerminalOutcome::Failed),
                                        terminal_issue,
                                        None,
                                    )
                                }
                            };

                            if let (Some(target_state), Some(outcome), Some(issue)) =
                                (tracker_state, terminal_outcome, terminal_issue)
                            {
                                self.begin_terminal_transition(
                                    &issue,
                                    outcome,
                                    target_state,
                                    history,
                                )
                                .await;
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
                            let mut terminal_issue = None;
                            let mut rejection_comment = None;
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
                                        terminal_issue = Some(entry.issue.clone());
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
                                        final_failure = retry_scheduled.is_exhausted();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        RunningHistoryRecordInput {
                                                            outcome: HISTORY_OUTCOME_FAILED,
                                                            last_error: Some(reason.clone()),
                                                            running_entry: &entry,
                                                            run,
                                                            completed_at,
                                                            artifacts: state
                                                                .artifacts
                                                                .get(issue_id)
                                                                .cloned(),
                                                        },
                                                    )
                                                });
                                        }
                                        if let Some(retry_entry) = retry_scheduled.scheduled() {
                                            if let Some(input) = Self::transition_input_for_run(
                                                &state,
                                                issue_id,
                                                &entry.identifier,
                                                PipelineTransitionKind::StepRetryScheduled,
                                                Some(step.clone()),
                                                Some(reason.clone()),
                                                Some(retry_entry.clone()),
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        }
                                        if final_failure {
                                            state.running.insert(issue_id.to_string(), entry);
                                        } else {
                                            state.add_runtime_seconds(&entry);
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
                                        terminal_issue = Some(entry.issue.clone());
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
                                        final_failure = retry_scheduled.is_exhausted();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        RunningHistoryRecordInput {
                                                            outcome: HISTORY_OUTCOME_FAILED,
                                                            last_error: Some(reason.clone()),
                                                            running_entry: &entry,
                                                            run,
                                                            completed_at,
                                                            artifacts: state
                                                                .artifacts
                                                                .get(issue_id)
                                                                .cloned(),
                                                        },
                                                    )
                                                });
                                        }
                                        if let Some(retry_entry) = retry_scheduled.scheduled() {
                                            if let Some(input) = Self::transition_input_for_run(
                                                &state,
                                                issue_id,
                                                &entry.identifier,
                                                PipelineTransitionKind::FixupRetryScheduled,
                                                Some(step.clone()),
                                                Some(reason.clone()),
                                                Some(retry_entry.clone()),
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        }
                                        if final_failure {
                                            state.running.insert(issue_id.to_string(), entry);
                                        } else {
                                            state.add_runtime_seconds(&entry);
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
                                        terminal_issue = Some(entry.issue.clone());
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
                                        final_failure = retry_scheduled.is_exhausted();
                                        if final_failure {
                                            history_record =
                                                state.get_pipeline_run(issue_id).map(|run| {
                                                    rejection_comment =
                                                        Self::rejection_comment_for_step(
                                                            run, &step,
                                                        );
                                                    self.build_history_record(
                                                        RunningHistoryRecordInput {
                                                            outcome: HISTORY_OUTCOME_FAILED,
                                                            last_error: Some(reason.clone()),
                                                            running_entry: &entry,
                                                            run,
                                                            completed_at,
                                                            artifacts: state
                                                                .artifacts
                                                                .get(issue_id)
                                                                .cloned(),
                                                        },
                                                    )
                                                });
                                        }
                                        if let Some(retry_entry) = retry_scheduled.scheduled() {
                                            if let Some(input) = Self::prepare_whole_issue_retry(
                                                &mut state,
                                                &config,
                                                issue_id,
                                                &entry.identifier,
                                                &reason,
                                                retry_entry.clone(),
                                            ) {
                                                post_failure_transitions.push(input);
                                            }
                                        }
                                        if final_failure {
                                            state.running.insert(issue_id.to_string(), entry);
                                        } else {
                                            state.add_runtime_seconds(&entry);
                                        }
                                    }
                                }
                            }

                            let target_state = config.on_failure.clone();
                            drop(state);
                            drop(config);
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
                                if let Some(issue) = terminal_issue {
                                    self.begin_terminal_transition(
                                        &issue,
                                        TerminalOutcome::Failed,
                                        target_state,
                                        history_record,
                                    )
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
                                let terminal = state.remove_running(issue_id).map(|entry| {
                                    self.schedule_whole_issue_failure_retry(
                                        &mut state,
                                        &config,
                                        entry,
                                        &error.to_string(),
                                        ScheduledRetryPipeline::Release,
                                    )
                                });
                                drop(state);
                                self.commit_whole_issue_failure_retry(terminal).await;
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
                    let terminal = state.remove_running(issue_id).map(|entry| {
                        self.schedule_whole_issue_failure_retry(
                            &mut state,
                            &config,
                            entry,
                            &error.to_string(),
                            ScheduledRetryPipeline::Release,
                        )
                    });
                    drop(state);
                    self.commit_whole_issue_failure_retry(terminal).await;
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
                let mut terminal_issue = None;
                let mut retry_transition = None;

                if let Some(entry) = state.running.get(issue_id).cloned() {
                    terminal_issue = Some(entry.issue.clone());
                    let retry_scheduled = if retry::is_non_retryable_failure(&error) {
                        None
                    } else {
                        Some(schedule_failure_retry(
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
                        ))
                    };
                    final_failure = retry_scheduled
                        .as_ref()
                        .is_none_or(FailureRetryDisposition::is_exhausted);
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_FAILED,
                                last_error: Some(error.clone()),
                                running_entry: &entry,
                                run,
                                completed_at,
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        });
                    } else if let Some(retry_entry) =
                        retry_scheduled.as_ref().and_then(|retry| retry.scheduled())
                    {
                        if let Some(entry) = state.remove_running(issue_id) {
                            state.add_runtime_seconds(&entry);
                        }
                        retry_transition = Self::prepare_whole_issue_retry(
                            &mut state,
                            &config,
                            issue_id,
                            &entry.identifier,
                            &error,
                            retry_entry.clone(),
                        );
                    }
                }

                let target_state = config.on_failure.clone();
                drop(state);
                drop(config);
                if let Some(input) = retry_transition {
                    self.append_pipeline_transition(input).await;
                }
                if final_failure {
                    if let Some(issue) = terminal_issue {
                        self.begin_terminal_transition(
                            &issue,
                            TerminalOutcome::Failed,
                            target_state,
                            history_record,
                        )
                        .await;
                    }
                }
            }
        }
    }

    fn schedule_whole_issue_failure_retry(
        &self,
        state: &mut OrchestratorState,
        config: &EnsembleConfig,
        entry: crate::tracker::model::RunningEntry,
        error: &str,
        scheduled_pipeline: ScheduledRetryPipeline,
    ) -> WholeIssueFailureRetry {
        let issue_id = entry.issue.id.clone();
        let disposition = schedule_failure_retry(
            state,
            FailureRetryRequest {
                issue_id: &issue_id,
                identifier: &entry.identifier,
                attempt: next_attempt(entry.retry_attempt),
                max_backoff_ms: config.agent.max_retry_backoff_ms,
                max_cycles: config.max_cycles,
                error,
                retry_from_step: None,
                with_fixup: false,
            },
        );

        match disposition {
            FailureRetryDisposition::Scheduled(retry_entry) => {
                state.add_runtime_seconds(&entry);
                let transition = if matches!(scheduled_pipeline, ScheduledRetryPipeline::Release) {
                    Self::prepare_whole_issue_retry(
                        state,
                        config,
                        &issue_id,
                        &entry.identifier,
                        error,
                        retry_entry,
                    )
                } else {
                    Self::transition_input_for_run(
                        state,
                        &issue_id,
                        &entry.identifier,
                        PipelineTransitionKind::StepRetryScheduled,
                        None,
                        Some(error.to_string()),
                        Some(retry_entry),
                    )
                };
                WholeIssueFailureRetry::Scheduled(transition.map(Box::new))
            }
            FailureRetryDisposition::Exhausted => {
                state.running.insert(issue_id.clone(), entry.clone());
                let history_record = state.get_pipeline_run(&issue_id).map(|run| {
                    self.build_history_record(RunningHistoryRecordInput {
                        outcome: HISTORY_OUTCOME_FAILED,
                        last_error: Some(error.to_string()),
                        running_entry: &entry,
                        run,
                        completed_at: Utc::now(),
                        artifacts: state.artifacts.get(&issue_id).cloned(),
                    })
                });
                WholeIssueFailureRetry::Exhausted(Box::new(ExhaustedRetryTerminal {
                    issue: entry.issue.clone(),
                    target_state: config.on_failure.clone(),
                    history_record,
                }))
            }
        }
    }

    fn prepare_whole_issue_retry(
        state: &mut OrchestratorState,
        config: &EnsembleConfig,
        issue_id: &str,
        identifier: &str,
        error: &str,
        retry_entry: RetryEntry,
    ) -> Option<PipelineTransitionInput> {
        let dag = build_dag(&config.steps).ok()?;
        let acceptance_attempts = state
            .get_pipeline_run(issue_id)
            .map(|run| run.acceptance_attempts.clone())
            .unwrap_or_default();
        let mut next_run = PipelineRun::new(issue_id.to_string(), retry_entry.attempt, dag);
        next_run.acceptance_attempts = acceptance_attempts;
        state.insert_pipeline_run(issue_id, next_run, Arc::new(config.clone()));
        Self::transition_input_for_run(
            state,
            issue_id,
            identifier,
            PipelineTransitionKind::StepRetryScheduled,
            None,
            Some(error.to_string()),
            Some(retry_entry),
        )
    }

    async fn commit_whole_issue_failure_retry(&self, outcome: Option<WholeIssueFailureRetry>) {
        match outcome {
            Some(WholeIssueFailureRetry::Scheduled(Some(input))) => {
                self.append_pipeline_transition(*input).await;
            }
            Some(WholeIssueFailureRetry::Exhausted(terminal)) => {
                let terminal = *terminal;
                self.begin_terminal_transition(
                    &terminal.issue,
                    TerminalOutcome::Failed,
                    terminal.target_state,
                    terminal.history_record,
                )
                .await;
            }
            Some(WholeIssueFailureRetry::Scheduled(None)) | None => {}
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
        let mut terminal_issue = None;
        let mut rejection_comment = None;
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
                    terminal_issue = Some(entry.issue.clone());
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
                    final_failure = retry_scheduled.is_exhausted();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_FAILED,
                                last_error: Some(reason.clone()),
                                running_entry: &entry,
                                run,
                                completed_at,
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        });
                    }
                    if let Some(retry_entry) = retry_scheduled.scheduled() {
                        if let Some(input) = Self::transition_input_for_run(
                            &state,
                            issue_id,
                            &entry.identifier,
                            PipelineTransitionKind::StepRetryScheduled,
                            Some(step_name.clone()),
                            Some(reason.clone()),
                            Some(retry_entry.clone()),
                        ) {
                            post_failure_transitions.push(input);
                        }
                    }
                    if final_failure {
                        state.running.insert(issue_id.to_string(), entry);
                    } else {
                        state.add_runtime_seconds(&entry);
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
                    terminal_issue = Some(entry.issue.clone());
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
                    final_failure = retry_scheduled.is_exhausted();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_FAILED,
                                last_error: Some(reason.clone()),
                                running_entry: &entry,
                                run,
                                completed_at,
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        });
                    }
                    if let Some(retry_entry) = retry_scheduled.scheduled() {
                        if let Some(input) = Self::transition_input_for_run(
                            &state,
                            issue_id,
                            &entry.identifier,
                            PipelineTransitionKind::FixupRetryScheduled,
                            Some(step_name.clone()),
                            Some(reason.clone()),
                            Some(retry_entry.clone()),
                        ) {
                            post_failure_transitions.push(input);
                        }
                    }
                    if final_failure {
                        state.running.insert(issue_id.to_string(), entry);
                    } else {
                        state.add_runtime_seconds(&entry);
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
                    terminal_issue = Some(entry.issue.clone());
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
                    final_failure = retry_scheduled.is_exhausted();
                    if final_failure {
                        history_record = state.get_pipeline_run(issue_id).map(|run| {
                            rejection_comment = Self::rejection_comment_for_step(run, step);
                            self.build_history_record(RunningHistoryRecordInput {
                                outcome: HISTORY_OUTCOME_FAILED,
                                last_error: Some(reason.clone()),
                                running_entry: &entry,
                                run,
                                completed_at,
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        });
                    }
                    if let Some(retry_entry) = retry_scheduled.scheduled() {
                        if let Some(input) = Self::prepare_whole_issue_retry(
                            &mut state,
                            &config,
                            issue_id,
                            &entry.identifier,
                            &reason,
                            retry_entry.clone(),
                        ) {
                            post_failure_transitions.push(input);
                        }
                    }
                    if final_failure {
                        state.running.insert(issue_id.to_string(), entry);
                    } else {
                        state.add_runtime_seconds(&entry);
                    }
                }
            }
        }

        let target_state = config.on_failure.clone();
        drop(state);
        drop(config);
        for input in post_failure_transitions {
            self.append_pipeline_transition(input).await;
        }
        if final_failure {
            if let Some((step_name, summary)) = rejection_comment {
                self.post_rejection_summary_comment(issue_id, &step_name, &summary)
                    .await;
            }
            if let Some(issue) = terminal_issue {
                self.begin_terminal_transition(
                    &issue,
                    TerminalOutcome::Failed,
                    target_state,
                    history_record,
                )
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

        let journal_transaction = self.pipeline_journal.begin_issue_transition(issue_id).await;
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
        let blocked_transition = Self::transition_input_for_run(
            &state,
            issue_id,
            &issue.identifier,
            PipelineTransitionKind::StepBlockedOnHuman,
            Some(step_name.to_string()),
            Some(interaction.id.clone()),
            None,
        );
        drop(state);
        if let Some(blocked_transition) = blocked_transition {
            let expected = blocked_transition.clone();
            if let Err(error) = journal_transaction.append(blocked_transition).await {
                match journal_transaction.latest_record_matches(&expected).await {
                    Ok(true) => {}
                    Ok(false) => warn!(
                        issue_id,
                        interaction_id = %interaction.id,
                        error = %error,
                        "blocked interaction checkpoint was not persisted; retaining the durable sidecar owner for reconciliation"
                    ),
                    Err(reconciliation_error) => warn!(
                        issue_id,
                        interaction_id = %interaction.id,
                        append_error = %error,
                        reconciliation_error = %reconciliation_error,
                        "blocked interaction checkpoint outcome is ambiguous; retaining the durable sidecar owner for reconciliation"
                    ),
                }
            }
        }

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

        let journal_transaction = self.pipeline_journal.begin_issue_transition(issue_id).await;
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
        let approval_transition = Self::transition_input_for_run(
            &state,
            issue_id,
            &issue.identifier,
            PipelineTransitionKind::StepAwaitingApproval,
            Some(step_name.to_string()),
            Some(interaction.id.clone()),
            None,
        );
        drop(state);
        if let Some(approval_transition) = approval_transition {
            let expected = approval_transition.clone();
            if let Err(error) = journal_transaction.append(approval_transition).await {
                match journal_transaction.latest_record_matches(&expected).await {
                    Ok(true) => {}
                    Ok(false) => warn!(
                        issue_id,
                        interaction_id = %interaction.id,
                        error = %error,
                        "approval checkpoint was not persisted; retaining the durable sidecar owner for reconciliation"
                    ),
                    Err(reconciliation_error) => warn!(
                        issue_id,
                        interaction_id = %interaction.id,
                        append_error = %error,
                        reconciliation_error = %reconciliation_error,
                        "approval checkpoint outcome is ambiguous; retaining the durable sidecar owner for reconciliation"
                    ),
                }
            }
        }

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

    async fn process_interaction_thread_commands(&self) {
        let interactions = match self.interaction_store.list_with_thread_roots().await {
            Ok(interactions) => interactions,
            Err(error) => {
                warn!(
                    error = %error,
                    "failed to list interaction threads while processing commands"
                );
                return;
            }
        };

        for mut interaction in interactions {
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
            // Each persisted thread retains its own cursor, so completed interactions
            // request only comments after the last durably processed input.

            let mut last_persisted_comment_id = None;

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
                    last_persisted_comment_id = Some(comment.comment_id.clone());
                    continue;
                }

                if comment
                    .updated_at
                    .zip(comment.created_at)
                    .is_some_and(|(updated, created)| updated > created)
                {
                    let Some(updated) = self
                        .append_ignored_command(
                            &interaction,
                            None,
                            &comment,
                            "edited_comments_not_supported",
                        )
                        .await
                    else {
                        break;
                    };
                    interaction = updated;
                    last_persisted_comment_id = Some(comment.comment_id.clone());
                    continue;
                }

                let parsed = match parse_scoped_interaction_command(&comment.body) {
                    Ok(parsed) if parsed.interaction_id == interaction.id => parsed.command,
                    Ok(_) => {
                        let Some(updated) = self
                            .append_ignored_command(
                                &interaction,
                                None,
                                &comment,
                                "interaction_marker_mismatch",
                            )
                            .await
                        else {
                            break;
                        };
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                        continue;
                    }
                    Err(ParseScopedInteractionCommandError::MissingMarker) => {
                        let Some(updated) = self
                            .append_ignored_command(
                                &interaction,
                                None,
                                &comment,
                                "comment_not_scoped_to_interaction",
                            )
                            .await
                        else {
                            break;
                        };
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                        continue;
                    }
                    Err(_) => {
                        let Some(updated) = self
                            .append_ignored_command(
                                &interaction,
                                None,
                                &comment,
                                "not_a_supported_command",
                            )
                            .await
                        else {
                            break;
                        };
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                        continue;
                    }
                };

                let response = match response_from_command(&interaction.kind, &parsed) {
                    Some(response) => response,
                    None => {
                        let Some(updated) = self
                            .append_ignored_command(
                                &interaction,
                                Some(parsed.command_name()),
                                &comment,
                                "command_invalid_for_interaction_kind",
                            )
                            .await
                        else {
                            break;
                        };
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                        continue;
                    }
                };

                let accepted_result = self
                    .interaction_store
                    .accept_response(
                        &interaction.id,
                        AcceptedInteractionCommand {
                            command: parsed.command_name().to_string(),
                            raw_body: comment.body.clone(),
                            author: comment.author.clone(),
                            comment_id: comment.comment_id.clone(),
                            received_at: comment.created_at.unwrap_or_else(Utc::now),
                        },
                        response,
                    )
                    .await;

                match accepted_result {
                    Ok(InteractionAcceptance::Accepted(updated)) => {
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                        let mut state = self.state.write().await;
                        state.queue_resume(&interaction.issue_id);
                    }
                    Ok(InteractionAcceptance::Ignored(updated)) => {
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                    }
                    Err(error) => {
                        warn!(
                            interaction_id = %interaction.id,
                            error = %error,
                            "failed to accept interaction command"
                        );
                        let Some(updated) = self
                            .append_ignored_command(
                                &interaction,
                                Some(parsed.command_name()),
                                &comment,
                                "interaction_acceptance_failed",
                            )
                            .await
                        else {
                            break;
                        };
                        interaction = updated;
                        last_persisted_comment_id = Some(comment.comment_id.clone());
                    }
                }
            }

            if let Some(last_id) = last_persisted_comment_id {
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
    ) -> Option<crate::interaction::model::InteractionRequest> {
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
            Ok(updated) => Some(updated),
            Err(error) => {
                warn!(
                    interaction_id = %interaction.id,
                    error = %error,
                    "failed to append ignored interaction command"
                );
                None
            }
        }
    }

    async fn repair_interaction_checkpoint(
        &self,
        interaction: &crate::interaction::model::InteractionRequest,
    ) -> bool {
        let journal_transaction = self
            .pipeline_journal
            .begin_issue_transition(&interaction.issue_id)
            .await;
        let latest_record = match journal_transaction.latest_record().await {
            Ok(Some(record)) => record,
            Ok(None) => return true,
            Err(error) => {
                warn!(
                    issue_id = %interaction.issue_id,
                    interaction_id = %interaction.id,
                    error = %error,
                    "cannot inspect the durable owner while repairing interaction checkpoint"
                );
                return false;
            }
        };
        if latest_record.cycle > interaction.pipeline_cycle {
            match self
                .interaction_store
                .retire_waiting_state(&interaction.id)
                .await
            {
                Ok(_) => {
                    warn!(
                        issue_id = %interaction.issue_id,
                        interaction_id = %interaction.id,
                        interaction_cycle = interaction.pipeline_cycle,
                        durable_cycle = latest_record.cycle,
                        "retired stale interaction superseded by a newer pipeline cycle"
                    );
                }
                Err(error) => warn!(
                    issue_id = %interaction.issue_id,
                    interaction_id = %interaction.id,
                    interaction_cycle = interaction.pipeline_cycle,
                    durable_cycle = latest_record.cycle,
                    error = %error,
                    "failed to retire stale interaction superseded by a newer pipeline cycle"
                ),
            }
            return false;
        }
        let repair_matches_durable_predecessor = match interaction.resume_strategy {
            InteractionResumeStrategy::RerunStep => {
                latest_record.kind == PipelineTransitionKind::StepRunning
                    && latest_record.cycle == interaction.pipeline_cycle
                    && latest_record.step.as_deref() == Some(interaction.step_name.as_str())
                    && interaction_id_from_resume_reason(latest_record.reason.as_deref()).is_none()
            }
            InteractionResumeStrategy::AdvanceAfterStep => {
                latest_record.kind == PipelineTransitionKind::StepAwaitingApproval
                    && latest_record.cycle == interaction.pipeline_cycle
                    && latest_record.step.as_deref() == Some(interaction.step_name.as_str())
                    && matches!(
                        latest_record
                            .snapshot
                            .as_ref()
                            .and_then(|snapshot| snapshot.step_states.get(&interaction.step_name)),
                        Some(StepState::AwaitingApproval {
                            interaction_request_id: None
                        })
                    )
            }
        };
        if !repair_matches_durable_predecessor {
            return true;
        }
        let transition = {
            let mut state = self.state.write().await;
            let Some(run) = state.get_pipeline_run_mut(&interaction.issue_id) else {
                return true;
            };
            let already_bound = match (
                &interaction.resume_strategy,
                run.step_states.get(&interaction.step_name),
            ) {
                (
                    InteractionResumeStrategy::RerunStep,
                    Some(StepState::BlockedOnHuman {
                        interaction_request_id,
                    }),
                ) => interaction_request_id == &interaction.id,
                (
                    InteractionResumeStrategy::AdvanceAfterStep,
                    Some(StepState::AwaitingApproval {
                        interaction_request_id,
                    }),
                ) => interaction_request_id.as_deref() == Some(interaction.id.as_str()),
                _ => false,
            };
            let kind = match interaction.resume_strategy {
                InteractionResumeStrategy::RerunStep => {
                    if !already_bound {
                        run.step_blocked_on_human(&interaction.step_name, interaction.id.clone());
                    }
                    PipelineTransitionKind::StepBlockedOnHuman
                }
                InteractionResumeStrategy::AdvanceAfterStep => {
                    if !matches!(
                        run.step_states.get(&interaction.step_name),
                        Some(StepState::AwaitingApproval { .. })
                    ) {
                        warn!(
                            issue_id = %interaction.issue_id,
                            interaction_id = %interaction.id,
                            step = %interaction.step_name,
                            "cannot reconstruct approval checkpoint from the durable pipeline state"
                        );
                        return false;
                    }
                    if !already_bound {
                        run.bind_approval_interaction(
                            &interaction.step_name,
                            interaction.id.clone(),
                        );
                    }
                    PipelineTransitionKind::StepAwaitingApproval
                }
            };
            Self::transition_input_for_run(
                &state,
                &interaction.issue_id,
                &interaction.issue_identifier,
                kind,
                Some(interaction.step_name.clone()),
                Some(interaction.id.clone()),
                None,
            )
        };

        let Some(transition) = transition else {
            return false;
        };
        let expected = transition.clone();
        if let Err(error) = journal_transaction.append(transition).await {
            match journal_transaction.latest_record_matches(&expected).await {
                Ok(true) => return true,
                Ok(false) => warn!(
                    issue_id = %interaction.issue_id,
                    interaction_id = %interaction.id,
                    error = %error,
                    "failed to persist reconstructed interaction checkpoint"
                ),
                Err(reconciliation_error) => warn!(
                    issue_id = %interaction.issue_id,
                    interaction_id = %interaction.id,
                    append_error = %error,
                    reconciliation_error = %reconciliation_error,
                    "reconstructed interaction checkpoint outcome is ambiguous"
                ),
            }

            return false;
        }
        true
    }

    async fn hydrate_waiting_on_human_from_store(&self) {
        let mut interactions = match self.interaction_store.list_awaiting_resume().await {
            Ok(interactions) => interactions,
            Err(error) => {
                warn!(error = %error, "failed to hydrate waiting interactions from store");
                return;
            }
        };
        if !interactions.is_empty() {
            let live_records = match self.pipeline_journal.latest_live_records().await {
                Ok(records) => records
                    .into_iter()
                    .map(|record| (record.issue_id.clone(), record))
                    .collect::<HashMap<_, _>>(),
                Err(error) => {
                    warn!(
                        error = %error,
                        "failed to reconcile waiting interactions with pipeline journal"
                    );
                    HashMap::new()
                }
            };
            let mut retained = Vec::with_capacity(interactions.len());
            for interaction in interactions {
                let step_dispatch_was_reserved = live_records
                    .get(&interaction.issue_id)
                    .is_some_and(|record| {
                        record.kind == PipelineTransitionKind::StepRunning
                            && interaction.status == InteractionStatus::Resolved
                            && interaction_id_from_resume_reason(record.reason.as_deref())
                                == Some(interaction.id.as_str())
                    });
                if step_dispatch_was_reserved {
                    match self
                        .interaction_store
                        .retire_waiting_state(&interaction.id)
                        .await
                    {
                        Ok(_) => {
                            let mut state = self.state.write().await;
                            state.remove_waiting_on_human(&interaction.issue_id);
                            state.clear_resume_request(&interaction.issue_id);
                            continue;
                        }
                        Err(error) => {
                            warn!(
                                issue_id = %interaction.issue_id,
                                interaction_id = %interaction.id,
                                error = %error,
                                "failed to reconcile interaction after durable step dispatch"
                            );
                            continue;
                        }
                    }
                }
                if !self.repair_interaction_checkpoint(&interaction).await {
                    continue;
                }
                retained.push(interaction);
            }
            interactions = retained;
        }
        {
            let state = self.state.read().await;
            interactions.retain(|interaction| {
                !state.is_running(&interaction.issue_id)
                    && !state.is_waiting_on_human(&interaction.issue_id)
                    && !state
                        .pending_terminal_transitions
                        .contains_key(&interaction.issue_id)
            });
        }

        let issue_ids = interactions
            .iter()
            .map(|interaction| interaction.issue_id.clone())
            .collect::<Vec<_>>();
        let issues_by_id = if issue_ids.is_empty() {
            HashMap::new()
        } else {
            self.tracker
                .fetch_issue_states_by_ids(&issue_ids)
                .await
                .map(|issues| {
                    issues
                        .into_iter()
                        .map(|issue| (issue.id.clone(), issue))
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default()
        };

        let mut state = self.state.write().await;
        for interaction in interactions {
            if state.is_running(&interaction.issue_id)
                || state.is_waiting_on_human(&interaction.issue_id)
                || state
                    .pending_terminal_transitions
                    .contains_key(&interaction.issue_id)
            {
                continue;
            }

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
                issue: issues_by_id.get(&interaction.issue_id).cloned(),
            });
        }
    }

    async fn restore_pipeline_runs_from_journal(&self) {
        if self.pipeline_journal_restored.load(Ordering::Acquire) {
            return;
        }

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
            self.pipeline_journal_restored
                .store(true, Ordering::Release);
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

        let mut restored_all = true;
        for record in records {
            if let Err(error) = self
                .restore_pipeline_run_record(&record, Arc::clone(&config_snapshot), &issues_by_id)
                .await
            {
                restored_all = false;
                warn!(
                    issue_id = %record.issue_id,
                    error = %error,
                    "failed to restore pipeline run from transition journal"
                );
            }
        }
        if restored_all {
            self.pipeline_journal_restored
                .store(true, Ordering::Release);
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

        let is_pending_terminal = record.terminal_transition.is_some();
        if !is_pending_terminal {
            validate_restored_snapshot_against_config(&snapshot, &config_snapshot)?;
        }
        let mut run = PipelineRun::from_snapshot(snapshot)?;
        if !is_pending_terminal {
            run.normalize_stale_running_steps();
        }
        {
            let state = self.state.read().await;
            if state.get_pipeline_run(&record.issue_id).is_some()
                || state.is_running(&record.issue_id)
            {
                return Ok(());
            }
        }
        let restored_timeline_sequence = if is_pending_terminal {
            None
        } else if let Some(run_id) = &record.run_id {
            let history_store = self.history_store.as_ref().ok_or_else(|| {
                AgentError::DurableSequenceUnavailable {
                    run_id: run_id.clone(),
                    reason: "history store is unavailable".to_string(),
                }
            })?;
            Some(
                history_store
                    .max_timeline_sequence(run_id)
                    .await
                    .map_err(|error| AgentError::DurableSequenceUnavailable {
                        run_id: run_id.clone(),
                        reason: error.to_string(),
                    })?
                    .unwrap_or(0),
            )
        } else {
            None
        };

        let mut state = self.state.write().await;
        if state.get_pipeline_run(&record.issue_id).is_some() || state.is_running(&record.issue_id)
        {
            return Ok(());
        }

        if is_pending_terminal {
            state.insert_terminal_pipeline_run(&record.issue_id, run);
        } else {
            state.insert_pipeline_run(&record.issue_id, run, Arc::clone(&config_snapshot));
        }
        state.add_claimed(&record.issue_id);
        if let Some(run_id) = record.run_id.clone() {
            if let Some(maximum) = restored_timeline_sequence {
                state.seed_timeline_sequence(&run_id, maximum);
            }
            state.issue_run_ids.insert(record.issue_id.clone(), run_id);
        }

        if let Some(transition) = record.terminal_transition.clone() {
            state.pending_terminal_transitions.insert(
                record.issue_id.clone(),
                PendingTerminalEntry {
                    identifier: record.identifier.clone(),
                    run_id: record.run_id.clone(),
                    issue: Some(
                        issues_by_id
                            .get(&record.issue_id)
                            .cloned()
                            .unwrap_or_else(|| {
                                Self::terminal_issue_placeholder(
                                    &record.issue_id,
                                    &record.identifier,
                                    &transition.target_state,
                                )
                            }),
                    ),
                    transition,
                },
            );
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

    async fn begin_terminal_transition(
        &self,
        issue: &Issue,
        outcome: TerminalOutcome,
        target_state: String,
        history_record: Option<HistoryRecord>,
    ) {
        self.begin_terminal_transition_for_identity(
            &issue.id,
            &issue.identifier,
            Some(issue.clone()),
            outcome,
            target_state,
            history_record,
        )
        .await;
    }

    async fn persist_terminal_transition_intent(
        &self,
        issue_id: &str,
        identifier: &str,
        outcome: TerminalOutcome,
        target_state: String,
        history_record: Option<HistoryRecord>,
    ) -> Option<PendingTerminalTransition> {
        let existing_record = self
            .pipeline_journal
            .latest_live_record_for_issue(issue_id)
            .await
            .ok()
            .flatten();
        let current = {
            let state = self.state.read().await;
            state.get_pipeline_run(issue_id).map(|run| {
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
                (run.to_snapshot(), run.cycle, run_id)
            })
        };
        let current = match current {
            Some(current) => Some(current),
            None => existing_record.as_ref().and_then(|record| {
                record
                    .snapshot
                    .clone()
                    .map(|snapshot| (snapshot, record.cycle, record.run_id.clone()))
            }),
        };
        let Some((snapshot, cycle, run_id)) = current else {
            warn!(
                issue_id = %issue_id,
                "cannot persist terminal transition intent without pipeline snapshot"
            );
            return None;
        };
        let existing_transition = existing_record
            .filter(|record| record.run_id == run_id)
            .and_then(|record| record.terminal_transition)
            .filter(|transition| {
                transition.target_state == target_state && transition.outcome == outcome
            });
        let mut transition = existing_transition
            .clone()
            .unwrap_or(PendingTerminalTransition {
                target_state,
                outcome,
                attempt: 0,
                last_error: None,
                last_attempted_at: None,
                tracker_write_confirmed: false,
                history_record: None,
            });
        if history_record.is_some() {
            transition.history_record = history_record;
        }
        let input = PipelineTransitionInput {
            kind: PipelineTransitionKind::PendingTerminalTransition,
            issue_id: issue_id.to_string(),
            identifier: identifier.to_string(),
            run_id,
            cycle,
            step: None,
            reason: None,
            retry: None,
            snapshot: Some(snapshot),
            terminal_transition: Some(transition.clone()),
        };

        if let Err(error) = self.pipeline_journal.append(input).await {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to persist terminal transition intent"
            );
            return Some(transition);
        }
        Some(transition)
    }

    async fn begin_terminal_transition_for_identity(
        &self,
        issue_id: &str,
        identifier: &str,
        issue: Option<Issue>,
        outcome: TerminalOutcome,
        target_state: String,
        history_record: Option<HistoryRecord>,
    ) {
        let Some(transition) = self
            .persist_terminal_transition_intent(
                issue_id,
                identifier,
                outcome,
                target_state,
                history_record,
            )
            .await
        else {
            return;
        };

        let issue = Some(issue.unwrap_or_else(|| {
            Self::terminal_issue_placeholder(issue_id, identifier, &transition.target_state)
        }));
        let restored_run = {
            let state = self.state.read().await;
            if state.get_pipeline_run(issue_id).is_some() {
                None
            } else {
                drop(state);
                self.pipeline_journal
                    .latest_live_record_for_issue(issue_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|record| {
                        let run_id = record.run_id;
                        record
                            .snapshot
                            .and_then(|snapshot| PipelineRun::from_snapshot(snapshot).ok())
                            .map(|run| (run, run_id))
                    })
            }
        };
        {
            let mut state = self.state.write().await;
            if state.get_pipeline_run(issue_id).is_none() {
                if let Some((run, run_id)) = restored_run {
                    if let Some(run_id) = run_id {
                        state.issue_run_ids.insert(issue_id.to_string(), run_id);
                    }
                    state.insert_terminal_pipeline_run(issue_id, run);
                }
            }
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

            if let Some(entry) = state.remove_running(issue_id) {
                state.add_runtime_seconds(&entry);
            }
            state.add_claimed(issue_id);
            state.pending_terminal_transitions.insert(
                issue_id.to_string(),
                PendingTerminalEntry {
                    identifier: identifier.to_string(),
                    run_id: run_id.clone(),
                    issue,
                    transition,
                },
            );
        }

        self.reconcile_pending_terminal_transition(issue_id).await;
    }

    async fn reconcile_pending_terminal_transitions(&self) {
        let issue_ids = {
            let state = self.state.read().await;
            state
                .pending_terminal_transitions
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };

        for issue_id in issue_ids {
            self.reconcile_pending_terminal_transition(&issue_id).await;
        }
    }

    async fn reconcile_pending_terminal_transition(&self, issue_id: &str) {
        let (pending, input) = {
            let state = self.state.read().await;
            let Some(pending) = state.pending_terminal_transitions.get(issue_id).cloned() else {
                return;
            };
            let Some(input) = Self::pending_terminal_transition_input(
                &state,
                issue_id,
                &pending,
                PipelineTransitionKind::PendingTerminalTransition,
            ) else {
                warn!(
                    issue_id = %issue_id,
                    "pending terminal transition has no recoverable pipeline snapshot"
                );
                return;
            };
            (pending, input)
        };

        if pending.transition.tracker_write_confirmed {
            self.complete_pending_terminal_transition(issue_id, pending.run_id)
                .await;
            return;
        }

        if let Err(error) = self.pipeline_journal.append(input).await {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to persist pending terminal transition before tracker write"
            );
            return;
        }

        if !self.tracker.supports_writes() {
            self.confirm_pending_terminal_transition(issue_id, &pending)
                .await;
            return;
        }

        match self
            .tracker
            .set_issue_state(issue_id, &pending.transition.target_state)
            .await
        {
            Ok(()) => {
                self.confirm_pending_terminal_transition(issue_id, &pending)
                    .await;
            }
            Err(error) => {
                let refreshed_input = {
                    let mut state = self.state.write().await;
                    let Some(current) = state.pending_terminal_transitions.get_mut(issue_id) else {
                        return;
                    };
                    if current.run_id != pending.run_id
                        || current.transition.target_state != pending.transition.target_state
                        || current.transition.outcome != pending.transition.outcome
                    {
                        return;
                    }
                    current.transition.attempt = current.transition.attempt.saturating_add(1);
                    current.transition.last_error = Some(error.to_string());
                    current.transition.last_attempted_at = Some(Utc::now());
                    let current = current.clone();
                    Self::pending_terminal_transition_input(
                        &state,
                        issue_id,
                        &current,
                        PipelineTransitionKind::PendingTerminalTransition,
                    )
                };

                if let Some(input) = refreshed_input {
                    if let Err(journal_error) = self.pipeline_journal.append(input).await {
                        warn!(
                            issue_id = %issue_id,
                            error = %journal_error,
                            "failed to refresh pending terminal transition retry metadata"
                        );
                    }
                }
                warn!(
                    issue_id = %issue_id,
                    target_state = %pending.transition.target_state,
                    error = %error,
                    "terminal tracker transition remains pending"
                );
            }
        }
    }

    async fn confirm_pending_terminal_transition(
        &self,
        issue_id: &str,
        expected: &PendingTerminalEntry,
    ) {
        let input = {
            let state = self.state.read().await;
            let Some(current) = state.pending_terminal_transitions.get(issue_id) else {
                return;
            };
            if current.run_id != expected.run_id
                || current.transition.target_state != expected.transition.target_state
                || current.transition.outcome != expected.transition.outcome
            {
                return;
            }

            let mut confirmed = current.clone();
            confirmed.transition.tracker_write_confirmed = true;
            let Some(input) = Self::pending_terminal_transition_input(
                &state,
                issue_id,
                &confirmed,
                PipelineTransitionKind::TerminalTransitionApplied,
            ) else {
                return;
            };
            input
        };

        if let Err(error) = self.pipeline_journal.append(input).await {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to persist confirmed terminal tracker transition"
            );
            return;
        }

        {
            let mut state = self.state.write().await;
            let Some(current) = state.pending_terminal_transitions.get_mut(issue_id) else {
                return;
            };
            if current.run_id != expected.run_id
                || current.transition.target_state != expected.transition.target_state
                || current.transition.outcome != expected.transition.outcome
            {
                return;
            }
            current.transition.tracker_write_confirmed = true;
        }

        self.complete_pending_terminal_transition(issue_id, expected.run_id.clone())
            .await;
    }

    async fn complete_pending_terminal_transition(
        &self,
        issue_id: &str,
        expected_run_id: Option<String>,
    ) {
        let pending = {
            let state = self.state.read().await;
            let Some(pending) = state.pending_terminal_transitions.get(issue_id).cloned() else {
                return;
            };
            if pending.run_id != expected_run_id {
                return;
            }
            if !pending.transition.tracker_write_confirmed {
                return;
            }
            pending
        };

        if let Err(error) = self
            .clear_terminal_interaction_waiting_state(issue_id)
            .await
        {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to clear terminal interaction waiting state"
            );
            return;
        }

        if let Some(record) = pending.transition.history_record.as_ref() {
            if let Err(error) = self
                .persist_history_record(pending.run_id.as_deref(), record)
                .await
            {
                warn!(
                    issue_id = %issue_id,
                    error = %error,
                    "failed to persist terminal run history before release"
                );
                return;
            }
        }

        if let Err(error) = self
            .pipeline_journal
            .append_released(
                issue_id,
                &pending.identifier,
                pending.run_id.clone(),
                "terminal tracker transition reconciled",
            )
            .await
        {
            warn!(
                issue_id = %issue_id,
                error = %error,
                "failed to persist pipeline release after terminal tracker transition"
            );
            return;
        }

        {
            let mut state = self.state.write().await;
            let Some(current) = state.pending_terminal_transitions.get(issue_id) else {
                return;
            };
            if current.run_id != pending.run_id
                || current.transition.target_state != pending.transition.target_state
                || current.transition.outcome != pending.transition.outcome
            {
                return;
            }

            let status = match pending.transition.outcome {
                TerminalOutcome::Succeeded => "completed_succeeded",
                TerminalOutcome::Failed => "completed_failed",
            };
            state.add_completed(
                issue_id.to_string(),
                pending.identifier.clone(),
                status.to_string(),
            );
            state.release_claim(issue_id);
            state.remove_pipeline_run(issue_id);
            state.clear_finalize_state(issue_id);
        }
    }

    async fn clear_terminal_interaction_waiting_state(
        &self,
        issue_id: &str,
    ) -> Result<(), EnsembleError> {
        if let Some(interaction) = self
            .interaction_store
            .latest_blocking_for_issue(issue_id)
            .await?
        {
            if interaction.awaiting_resume {
                self.interaction_store
                    .clear_waiting_state(&interaction.id)
                    .await?;
            }
        }
        Ok(())
    }

    fn pending_terminal_transition_input(
        state: &OrchestratorState,
        issue_id: &str,
        pending: &PendingTerminalEntry,
        kind: PipelineTransitionKind,
    ) -> Option<PipelineTransitionInput> {
        let run = state.get_pipeline_run(issue_id)?;
        Some(PipelineTransitionInput {
            kind,
            issue_id: issue_id.to_string(),
            identifier: pending.identifier.clone(),
            run_id: pending.run_id.clone(),
            cycle: run.cycle,
            step: None,
            reason: pending.transition.last_error.clone(),
            retry: None,
            snapshot: Some(run.to_snapshot()),
            terminal_transition: Some(pending.transition.clone()),
        })
    }

    fn terminal_issue_placeholder(issue_id: &str, identifier: &str, state: &str) -> Issue {
        Issue {
            id: issue_id.to_string(),
            identifier: identifier.to_string(),
            title: identifier.to_string(),
            description: None,
            priority: None,
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
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
            terminal_transition: None,
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

    async fn finalize_and_stage_terminal_transition(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        config: &EnsembleConfig,
    ) -> IssueFinalizeState {
        let attempt = {
            let state = self.state.read().await;
            RunningAttemptIdentity::capture(&state, issue_id)
        };
        let finalize_state = self
            .run_finalize_phase(issue_id, issue_identifier, config)
            .await;
        #[cfg(test)]
        self.wait_for_finalization_commit_test_barriers().await;
        if attempt.is_some() {
            let state = self.state.read().await;
            if !Self::finalization_attempt_is_current(attempt.as_ref(), &state, issue_id) {
                return finalize_state;
            }
        }
        self.stage_finalization_terminal_transition(
            issue_id,
            issue_identifier,
            config,
            &finalize_state,
        )
        .await;
        finalize_state
    }

    async fn stage_finalization_terminal_transition(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        config: &EnsembleConfig,
        finalize_state: &IssueFinalizeState,
    ) {
        let outcome = match finalize_state.status {
            FinalizeStatus::Succeeded | FinalizeStatus::NotRequired => TerminalOutcome::Succeeded,
            FinalizeStatus::SkippedHeadless => TerminalOutcome::Failed,
            FinalizeStatus::PendingApproval
            | FinalizeStatus::InProgress
            | FinalizeStatus::Failed => return,
        };
        let target_state = match outcome {
            TerminalOutcome::Succeeded => config.on_success.clone(),
            TerminalOutcome::Failed => config.on_failure.clone(),
        };
        let last_error = finalize_state
            .repos
            .iter()
            .find_map(|repo| repo.last_error.clone());
        let completed_at = Utc::now();

        let history_record = {
            let state = self.state.read().await;
            state.get_pipeline_run(issue_id).and_then(|run| {
                state
                    .running
                    .get(issue_id)
                    .map(|entry| {
                        self.build_history_record(RunningHistoryRecordInput {
                            outcome: match outcome {
                                TerminalOutcome::Succeeded => HISTORY_OUTCOME_SUCCEEDED,
                                TerminalOutcome::Failed => HISTORY_OUTCOME_FAILED,
                            },
                            last_error: last_error.clone(),
                            running_entry: entry,
                            run,
                            completed_at,
                            artifacts: state.artifacts.get(issue_id).cloned(),
                        })
                    })
                    .or_else(|| {
                        state.waiting_on_human.get(issue_id).map(|entry| {
                            self.build_history_record_from_waiting(WaitingHistoryRecordInput {
                                outcome: match outcome {
                                    TerminalOutcome::Succeeded => HISTORY_OUTCOME_SUCCEEDED,
                                    TerminalOutcome::Failed => HISTORY_OUTCOME_FAILED,
                                },
                                last_error: last_error.clone(),
                                waiting_entry: entry,
                                run,
                                completed_at,
                                artifacts: state.artifacts.get(issue_id).cloned(),
                            })
                        })
                    })
            })
        };

        let _ = self
            .persist_terminal_transition_intent(
                issue_id,
                issue_identifier,
                outcome,
                target_state,
                history_record,
            )
            .await;
    }

    async fn run_finalize_phase(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        _config: &EnsembleConfig,
    ) -> IssueFinalizeState {
        #[cfg(test)]
        self.finalization_run_count.fetch_add(1, Ordering::SeqCst);

        let mut repos = Vec::new();
        let headless = Self::is_headless_runtime();

        let configured_repos = self.workspace_mgr.repos();
        let requires_workspace = configured_repos
            .values()
            .any(|repo| repo.finalize.enabled && !matches!(repo.finalize.mode, FinalizeMode::None));

        let prepared_workspace = if requires_workspace {
            match self
                .workspace_mgr
                .prepare_workspace(issue_id, issue_identifier)
                .await
            {
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

        let workspace = match self
            .workspace_mgr
            .prepare_workspace(issue_id, issue_identifier)
            .await
        {
            Ok(workspace) => workspace,
            Err(error) => {
                {
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
                }
                warn!(
                    issue_id = %issue_id,
                    error = %error,
                    "finalize retry workspace preparation failed"
                );
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

        if should_complete {
            let outcome = TerminalOutcome::Succeeded;
            let config_snapshot = {
                let config = self.config.read().await;
                config.clone()
            };
            let target_state = config_snapshot.on_success.clone();
            if let Some(finalize_state) = self
                .state
                .read()
                .await
                .get_finalize_state(issue_id)
                .cloned()
            {
                self.stage_finalization_terminal_transition(
                    issue_id,
                    issue_identifier,
                    &config_snapshot,
                    &finalize_state,
                )
                .await;
            };
            let issue = self
                .tracker
                .fetch_issue_states_by_ids(&[issue_id.to_string()])
                .await
                .ok()
                .and_then(|issues| issues.into_iter().next());
            self.begin_terminal_transition_for_identity(
                issue_id,
                issue_identifier,
                issue,
                outcome,
                target_state,
                None,
            )
            .await;
        } else if let Some(error) = last_error {
            warn!(
                issue_id = %issue_id,
                status = ?final_status,
                error = %error,
                "finalize retry failed"
            );
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

    fn build_history_record(&self, input: RunningHistoryRecordInput<'_>) -> HistoryRecord {
        let steps_traversed = input.run.traversed_steps_in_order();

        let duration_seconds = input
            .completed_at
            .signed_duration_since(input.running_entry.started_at)
            .num_seconds()
            .max(0) as u64;

        let workspace_path = self
            .workspace_mgr
            .workspace_path(&input.running_entry.issue_id)
            .display()
            .to_string();

        HistoryRecord {
            issue_identifier: input.running_entry.identifier.clone(),
            issue_id: input.running_entry.issue_id.clone(),
            outcome: input.outcome.to_string(),
            steps_traversed,
            attempts: input.running_entry.retry_attempt.unwrap_or(1),
            tokens: TokenTotals {
                input_tokens: input.running_entry.agent_input_tokens,
                output_tokens: input.running_entry.agent_output_tokens,
                total_tokens: input.running_entry.agent_total_tokens,
            },
            duration_seconds,
            started_at: input.running_entry.started_at,
            completed_at: input.completed_at,
            last_error: input.last_error,
            verdict: Self::history_verdict(input.run),
            workspace_path,
            acceptance_attempts: input.run.acceptance_attempts.clone(),
            artifacts: input.artifacts,
        }
    }

    fn build_history_record_from_waiting(
        &self,
        input: WaitingHistoryRecordInput<'_>,
    ) -> HistoryRecord {
        let steps_traversed = input.run.traversed_steps_in_order();
        let started_at = input
            .waiting_entry
            .started_at
            .unwrap_or(input.waiting_entry.requested_at);
        let duration_seconds = input
            .completed_at
            .signed_duration_since(started_at)
            .num_seconds()
            .max(0) as u64;
        let workspace_path = self
            .workspace_mgr
            .workspace_path(&input.waiting_entry.issue_id)
            .display()
            .to_string();

        HistoryRecord {
            issue_identifier: input.waiting_entry.identifier.clone(),
            issue_id: input.waiting_entry.issue_id.clone(),
            outcome: input.outcome.to_string(),
            steps_traversed,
            attempts: input.waiting_entry.retry_attempt.unwrap_or(1),
            tokens: TokenTotals {
                input_tokens: input.waiting_entry.agent_input_tokens,
                output_tokens: input.waiting_entry.agent_output_tokens,
                total_tokens: input.waiting_entry.agent_total_tokens,
            },
            duration_seconds,
            started_at,
            completed_at: input.completed_at,
            last_error: input.last_error,
            verdict: Self::history_verdict(input.run),
            workspace_path,
            acceptance_attempts: input.run.acceptance_attempts.clone(),
            artifacts: input.artifacts,
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

    async fn persist_history_record(
        &self,
        run_id: Option<&str>,
        record: &HistoryRecord,
    ) -> Result<(), std::io::Error> {
        if let (Some(run_id), Some(store)) = (run_id, &self.history_store) {
            if let Err(error) = store.append_history_record(run_id, record).await {
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
        writer.append_if_absent(record).await
    }

    async fn append_history_record(&self, run_id: Option<&str>, record: HistoryRecord) {
        if let Err(error) = self.persist_history_record(run_id, &record).await {
            warn!(
                issue_id = %record.issue_id,
                error = %error,
                "failed to append history record"
            );
        }
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
            let run = state
                .get_pipeline_run(&issue.id)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!(
                        "issue '{}' is missing its restored blocked pipeline run",
                        issue.identifier
                    ),
                })?;
            let blocked_step = run
                .step_states
                .iter()
                .find_map(|(step_name, step_state)| match step_state {
                    crate::pipeline::engine::StepState::BlockedOnHuman {
                        interaction_request_id,
                    } if interaction.resume_strategy == InteractionResumeStrategy::RerunStep => {
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
            let workflow_states = build_reconcile_active_states_lower(&current_config);
            if let Some(reason) = is_resume_dispatch_eligible(
                issue,
                &state,
                &workflow_states,
                &current_config.tracker.terminal_states,
                &HashMap::new(),
            ) {
                return Err(AgentError::PromptError {
                    reason: format!("issue '{}' cannot be resumed: {reason}", issue.identifier),
                }
                .into());
            }
        }

        let Some(resume_permit) = self.quiescing.begin_dispatch() else {
            return Err(EnsembleError::RuntimeBusy);
        };

        let mut interaction_was_retired = false;
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

                let (attempt, step_outputs, previous_running) = {
                    let mut state = self.state.write().await;
                    let previous_running = state.get_running(&issue.id).cloned();
                    let attempt = state
                        .get_pipeline_run(&issue.id)
                        .map(|run| run.cycle)
                        .unwrap_or(interaction.pipeline_cycle.max(1));
                    let step_outputs = state
                        .get_pipeline_run(&issue.id)
                        .and_then(|run| run.output_context_for(&current_step.name))
                        .unwrap_or_default();
                    state.add_running(issue, Some(attempt));
                    (attempt, step_outputs, previous_running)
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

                if let Err(error) = self
                    .dispatch_step(
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
                            interaction_resume_id: Some(&interaction.id),
                            interaction_to_retire: Some(&interaction.id),
                            interaction_retirement_rollback: None,
                            workspace_path,
                            step_outputs,
                        },
                        &resume_permit,
                    )
                    .await
                {
                    let dispatch_retains_owner = {
                        let state = self.state.read().await;
                        matches!(
                            state
                                .get_pipeline_run(&issue.id)
                                .and_then(|run| run.step_states.get(&current_step.name)),
                            Some(StepState::Running { .. })
                        )
                    };
                    if !dispatch_retains_owner {
                        let mut state = self.state.write().await;
                        match previous_running {
                            Some(running) => {
                                state.running.insert(issue.id.clone(), running);
                            }
                            None => {
                                state.remove_running(&issue.id);
                            }
                        }
                    }
                    return Err(error);
                }
                interaction_was_retired = true;
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

                let (action, dispatch_contexts, previous_run) = {
                    let mut state = self.state.write().await;
                    let run = state.get_pipeline_run_mut(&issue.id).ok_or_else(|| {
                        AgentError::PromptError {
                            reason: format!(
                                "issue '{}' is missing a pipeline run during approval resume",
                                issue.identifier
                            ),
                        }
                    })?;
                    let previous_run = run.clone();

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

                    (action, dispatch_contexts, previous_run)
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

                        let workspace_path =
                            match self.prepare_step_workspace(issue, &current_config).await {
                                Ok(path) => path,
                                Err(error) => {
                                    let mut state = self.state.write().await;
                                    state.remove_running(&issue.id);
                                    state
                                        .pipeline_runs
                                        .insert(issue.id.clone(), previous_run.clone());
                                    return Err(AgentError::PromptError {
                                        reason: format!("workspace error: {error}"),
                                    }
                                    .into());
                                }
                            };

                        let mut dispatched_any = false;
                        for (req, step_outputs) in dispatch_contexts {
                            if let Err(error) = self
                                .dispatch_step(
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
                                        interaction_resume_id: Some(&interaction.id),
                                        interaction_to_retire: (!interaction_was_retired)
                                            .then_some(interaction.id.as_str()),
                                        interaction_retirement_rollback: (!interaction_was_retired)
                                            .then(|| PipelineTransitionInput {
                                                kind: PipelineTransitionKind::StepAwaitingApproval,
                                                issue_id: issue.id.clone(),
                                                identifier: issue.identifier.clone(),
                                                run_id: waiting.run_id.clone(),
                                                cycle: previous_run.cycle,
                                                step: Some(current_step.name.clone()),
                                                reason: Some(format!(
                                                    "interaction '{}' retirement failed",
                                                    interaction.id
                                                )),
                                                retry: None,
                                                snapshot: Some(previous_run.to_snapshot()),
                                                terminal_transition: None,
                                            }),
                                        workspace_path: workspace_path.clone(),
                                        step_outputs,
                                    },
                                    &resume_permit,
                                )
                                .await
                            {
                                let failed_dispatch_retains_owner = {
                                    let state = self.state.read().await;
                                    matches!(
                                        state
                                            .get_pipeline_run(&issue.id)
                                            .and_then(|run| run.step_states.get(&req.step_name)),
                                        Some(StepState::Running { .. })
                                    )
                                };
                                if !dispatched_any && !failed_dispatch_retains_owner {
                                    let mut state = self.state.write().await;
                                    state.remove_running(&issue.id);
                                    state
                                        .pipeline_runs
                                        .insert(issue.id.clone(), previous_run.clone());
                                } else if interaction_was_retired {
                                    let mut state = self.state.write().await;
                                    state.remove_waiting_on_human(&issue.id);
                                    state.clear_resume_request(&issue.id);
                                }
                                return Err(error);
                            }
                            if !interaction_was_retired {
                                interaction_was_retired = true;
                            }
                            dispatched_any = true;
                        }
                    }
                    PipelineAction::Succeeded => {
                        match self.run_acceptance_phase(issue, &current_config).await {
                            AcceptancePhaseOutcome::Passed => {}
                            AcceptancePhaseOutcome::Failed { reason, owner } => {
                                if !interaction_was_retired {
                                    self.interaction_store.mark_resumed(&interaction.id).await?;
                                }
                                self.schedule_acceptance_failure(
                                    issue,
                                    &current_config,
                                    &reason,
                                    &owner,
                                )
                                .await;
                                return Ok(());
                            }
                            AcceptancePhaseOutcome::RetainedForRecovery => return Ok(()),
                        }
                        let finalize_state = self
                            .finalize_and_stage_terminal_transition(
                                &issue.id,
                                &issue.identifier,
                                &current_config,
                            )
                            .await;
                        let completed_at = Utc::now();
                        let (terminal_outcome, target_state, history_record) = {
                            let mut state = self.state.write().await;
                            let history_record =
                                state.waiting_on_human.get(&issue.id).and_then(|entry| {
                                    state.get_pipeline_run(&issue.id).map(|run| {
                                        self.build_history_record_from_waiting(
                                            WaitingHistoryRecordInput {
                                                outcome: HISTORY_OUTCOME_SUCCEEDED,
                                                last_error: None,
                                                waiting_entry: entry,
                                                run,
                                                completed_at,
                                                artifacts: state.artifacts.get(&issue.id).cloned(),
                                            },
                                        )
                                    })
                                });

                            if matches!(
                                finalize_state.status,
                                FinalizeStatus::Succeeded | FinalizeStatus::NotRequired
                            ) {
                                (
                                    Some(TerminalOutcome::Succeeded),
                                    Some(current_config.on_success.clone()),
                                    history_record,
                                )
                            } else {
                                let is_terminal_failure = matches!(
                                    finalize_state.status,
                                    FinalizeStatus::Failed | FinalizeStatus::SkippedHeadless
                                );

                                state.set_finalize_state(&issue.id, finalize_state);
                                if !is_terminal_failure {
                                    state.remove_pipeline_run(&issue.id);
                                }
                                (
                                    is_terminal_failure.then_some(TerminalOutcome::Failed),
                                    is_terminal_failure.then(|| current_config.on_failure.clone()),
                                    None,
                                )
                            }
                        };

                        if let (Some(outcome), Some(target_state)) =
                            (terminal_outcome, target_state)
                        {
                            self.begin_terminal_transition(
                                issue,
                                outcome,
                                target_state,
                                history_record,
                            )
                            .await;
                        }
                    }
                    PipelineAction::Failed { reason, .. } => {
                        let completed_at = Utc::now();
                        let history_record = {
                            let state = self.state.read().await;
                            state.waiting_on_human.get(&issue.id).and_then(|entry| {
                                state.get_pipeline_run(&issue.id).map(|run| {
                                    self.build_history_record_from_waiting(
                                        WaitingHistoryRecordInput {
                                            outcome: HISTORY_OUTCOME_FAILED,
                                            last_error: Some(reason.clone()),
                                            waiting_entry: entry,
                                            run,
                                            completed_at,
                                            artifacts: state.artifacts.get(&issue.id).cloned(),
                                        },
                                    )
                                })
                            })
                        };

                        self.begin_terminal_transition(
                            issue,
                            TerminalOutcome::Failed,
                            current_config.on_failure.clone(),
                            history_record,
                        )
                        .await;
                    }
                    PipelineAction::Waiting
                    | PipelineAction::BlockedOnHuman { .. }
                    | PipelineAction::AwaitingApproval { .. } => {}
                }
            }
        }

        if !interaction_was_retired {
            self.interaction_store.mark_resumed(&interaction.id).await?;
        }

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
        if self.quiescing.is_requested() {
            return;
        }

        let due_retries = {
            let state = self.state.read().await;
            get_due_retries(&state)
        };

        for retry_entry in due_retries {
            if self.quiescing.is_requested() {
                break;
            }
            self.handle_single_retry(&retry_entry).await;
        }
    }

    /// Handle a single retry fire.
    async fn handle_single_retry(&self, retry_entry: &crate::tracker::model::RetryEntry) {
        if self.quiescing.is_requested() {
            self.defer_single_retry(retry_entry, "orchestrator quiescing")
                .await;
            return;
        }

        let issue_id = &retry_entry.issue_id;

        // Fetch active candidates
        let candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(
                    issue_id = %issue_id,
                    error = %e,
                    "retry poll failed, rescheduling"
                );
                self.defer_single_retry(retry_entry, "retry poll failed")
                    .await;
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
                let release_run_id = {
                    let state = self.state.read().await;
                    (state.retry_attempts.get(issue_id) == Some(retry_entry))
                        .then(|| state.issue_run_ids.get(issue_id).cloned())
                };
                if let Some(run_id) = release_run_id {
                    let release_appended = match self
                        .pipeline_journal
                        .append_released_if_latest_retry_matches(
                            retry_entry,
                            run_id,
                            "retry_candidate_missing",
                        )
                        .await
                    {
                        Ok(Some(_)) => true,
                        Ok(None) => {
                            warn!(
                                issue_id = %issue_id,
                                "durable retry owner changed before release; retaining current ownership"
                            );
                            false
                        }
                        Err(error) => {
                            warn!(
                                issue_id = %issue_id,
                                error = %error,
                                "failed to durably release missing retry candidate; retaining ownership"
                            );
                            false
                        }
                    };

                    if release_appended {
                        let mut state = self.state.write().await;
                        if state.retry_attempts.get(issue_id) == Some(retry_entry) {
                            state.release_claim(issue_id);
                            state.remove_pipeline_run(issue_id);
                        } else {
                            warn!(
                                issue_id = %issue_id,
                                "retry owner changed during durable release; retaining current ownership"
                            );
                        }
                    }
                }
            }
            Some(issue) => {
                let max_backoff_ms = self.config.read().await.agent.max_retry_backoff_ms;
                let (ready_for_dispatch, transition) = {
                    let mut state = self.state.write().await;
                    if state.retry_attempts.get(issue_id) != Some(retry_entry) {
                        return;
                    }
                    if has_available_slots(&state) {
                        (true, None)
                    } else {
                        info!(
                            issue_id = %issue_id,
                            identifier = %retry_entry.identifier,
                            "no slots available for retry, requeuing"
                        );
                        let transition = Self::defer_owned_retry(
                            &mut state,
                            retry_entry,
                            max_backoff_ms,
                            "no available orchestrator slots",
                        );
                        (false, transition)
                    }
                };
                if let Some(input) = transition {
                    self.append_pipeline_transition(input).await;
                }

                if ready_for_dispatch {
                    let Some(permit) = self.quiescing.begin_dispatch() else {
                        self.defer_single_retry(retry_entry, "orchestrator quiescing")
                            .await;
                        return;
                    };
                    self.dispatch_retry_issue_with_permit(issue, retry_entry, &permit)
                        .await;
                }
            }
        }
    }

    fn defer_owned_retry(
        state: &mut OrchestratorState,
        retry_entry: &RetryEntry,
        max_backoff_ms: u64,
        reason: &str,
    ) -> Option<PipelineTransitionInput> {
        if state.retry_attempts.get(&retry_entry.issue_id) != Some(retry_entry) {
            return None;
        }
        let deferred = defer_retry(state, retry_entry, max_backoff_ms, reason);
        let issue_id = deferred.issue_id.clone();
        let identifier = deferred.identifier.clone();
        let retry_from_step = deferred.retry_from_step.clone();
        let transition_reason = deferred.error.clone();
        Self::transition_input_for_run(
            state,
            &issue_id,
            &identifier,
            if deferred.with_fixup {
                PipelineTransitionKind::FixupRetryScheduled
            } else {
                PipelineTransitionKind::StepRetryScheduled
            },
            retry_from_step,
            transition_reason,
            Some(deferred),
        )
    }

    async fn defer_single_retry(&self, retry_entry: &RetryEntry, reason: &str) {
        let max_backoff_ms = self.config.read().await.agent.max_retry_backoff_ms;
        let transition = {
            let mut state = self.state.write().await;
            Self::defer_owned_retry(&mut state, retry_entry, max_backoff_ms, reason)
        };
        if let Some(input) = transition {
            self.append_pipeline_transition(input).await;
        }
    }

    async fn cancel_active_runs(&self) -> bool {
        let mut handles = mark_all_for_drain(&self.cancellation_registry);
        let cancelled = handles.len();
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

        let quiesced = self
            .await_worker_quiescence_with_event_pump(&mut handles, DrainEventMode::Discard)
            .await;
        if quiesced {
            remove_drained_workers(&self.cancellation_registry, &handles);
        } else {
            warn!(
                workers = handles.len(),
                "worker completion closed before quiescence during shutdown; retaining worker ownership"
            );
        }
        quiesced
    }

    async fn publish_pipeline_event(
        &self,
        run_id: Option<String>,
        sequence: Option<u64>,
        attempt: u32,
        event: PipelineEvent,
    ) {
        let timeline_entry = if let (Some(run_id), Some(sequence)) = (run_id, sequence) {
            Some(event.to_timeline_record(&run_id, sequence, attempt))
        } else {
            None
        };

        self.event_bus.publish(event);

        if let Some(record) = timeline_entry {
            if let Some(ref persistence) = self.timeline_persistence {
                persistence.send(record);
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

async fn recv_worker_event(
    worker_rx: &Arc<tokio::sync::Mutex<mpsc::Receiver<OrchestratorWorkerEvent>>>,
) -> Option<OrchestratorWorkerEvent> {
    worker_rx.lock().await.recv().await
}

async fn bridge_worker_events(
    mut local_event_rx: mpsc::Receiver<WorkerEvent>,
    orchestrator_event_tx: mpsc::Sender<OrchestratorWorkerEvent>,
    cancellation_registry: CancellationRegistry,
    identity: WorkerIdentity,
    completion_tx: watch::Sender<bool>,
) {
    while let Some(event) = local_event_rx.recv().await {
        if orchestrator_event_tx
            .send(OrchestratorWorkerEvent {
                identity: identity.clone(),
                event,
            })
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = completion_tx.send(true);
    remove_completed_worker(&cancellation_registry, &identity);
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

fn build_reconcile_active_states_lower(config: &EnsembleConfig) -> Vec<String> {
    let terminal: HashSet<String> = config
        .tracker
        .terminal_states
        .iter()
        .map(|state| state.to_lowercase())
        .collect();
    let mut states = HashSet::new();

    for state in &config.tracker.active_states {
        let state = state.to_lowercase();
        if !terminal.contains(&state) {
            states.insert(state);
        }
    }

    for step in &config.steps {
        if let Some(state) = step.tracker_state.as_deref() {
            let state = state.to_lowercase();
            if !terminal.contains(&state) {
                states.insert(state);
            }
        }

        if let Some(state) = step
            .approval
            .as_ref()
            .and_then(|approval| approval.state.as_deref())
        {
            let state = state.to_lowercase();
            if !terminal.contains(&state) {
                states.insert(state);
            }
        }
    }

    states.into_iter().collect()
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
    let commands = match interaction.kind {
        InteractionKind::Question => &["/answer <text>"][..],
        InteractionKind::Approval => &["/approve", "/reject <reason>"][..],
        InteractionKind::Handoff => &["/approve", "/reject <reason>", "/answer <text>"][..],
    };
    let snippets = commands
        .iter()
        .map(|command| {
            format!(
                "```text\n{command}\n\n<!-- ensemble:interaction:{} -->\n```",
                interaction.id
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        concat!(
            "Ensemble requires input to continue.\n\n",
            "**Interaction ID:** `{}`\n",
            "**Kind:** `{}`\n\n",
            "{}\n\n",
            "Valid commands (copy one complete block):\n\n",
            "{}"
        ),
        interaction.id,
        match interaction.kind {
            InteractionKind::Question => "question",
            InteractionKind::Approval => "approval",
            InteractionKind::Handoff => "handoff",
        },
        interaction.body,
        snippets
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
    validate_acceptance_attempts(snapshot, config)?;
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

fn validate_acceptance_attempts(
    snapshot: &PipelineRunSnapshot,
    config: &EnsembleConfig,
) -> Result<(), EnsembleError> {
    let mut previous_cycle = 0;
    for attempt in &snapshot.acceptance_attempts {
        if attempt.cycle == 0 || attempt.cycle > snapshot.cycle || attempt.cycle <= previous_cycle {
            return Err(AgentError::PromptError {
                reason: "persisted acceptance attempts have invalid cycle ordering".to_string(),
            }
            .into());
        }
        previous_cycle = attempt.cycle;
        if attempt.cycle != snapshot.cycle {
            continue;
        }
        if attempt.results.len() > config.acceptance.commands.len() {
            return Err(AgentError::PromptError {
                reason: format!(
                    "persisted acceptance attempt {} has more results than configured commands",
                    attempt.cycle
                ),
            }
            .into());
        }
        for (result, command) in attempt.results.iter().zip(&config.acceptance.commands) {
            if result.name != command.name {
                return Err(AgentError::PromptError {
                    reason: format!(
                        "persisted acceptance result '{}' no longer matches configured command '{}'",
                        result.name, command.name
                    ),
                }
                .into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{
        AgentEvent, InteractionRequestDraft, OrchestratorWorkerEvent, StepApprovalRequestDraft,
        WorkerEvent, WorkerIdentity, WorkerResult,
    };
    use crate::config::ensemble::{parse_config, ConcurrencyConfig, StepConfig};
    use crate::error::AgentError;
    use crate::interaction::{
        InteractionKind, InteractionRequest, InteractionResponse, InteractionResumeStrategy,
        InteractionStatus, InteractionStore,
    };
    use crate::orchestrator::pipeline_journal::{PipelineTransitionInput, PipelineTransitionKind};
    use crate::orchestrator::retry::current_time_ms;
    use crate::pipeline::verdict::{StepOutput, StepResult};
    use crate::tracker::model::RetryEntry;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tokio::sync::watch;
    use tower::ServiceExt;

    /// Mock tracker for orchestrator tests.
    struct MockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    struct WorkflowStateTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    struct FailingWorkflowStateTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        id_fetch_failures_remaining: AtomicUsize,
    }

    #[async_trait]
    impl IssueTracker for WorkflowStateTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
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
    }

    #[async_trait]
    impl IssueTracker for FailingWorkflowStateTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
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
            if self
                .id_fetch_failures_remaining
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(TrackerError::ApiRequestFailed {
                    reason: "simulated ID refresh failure".to_string(),
                });
            }
            let issues = self.issues.read().await;
            Ok(issues
                .iter()
                .filter(|issue| ids.contains(&issue.id))
                .cloned()
                .collect())
        }
    }

    struct BlockingCandidateTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        fetch_started: Arc<tokio::sync::Notify>,
        release_fetch: Arc<tokio::sync::Notify>,
    }

    struct FailingCandidateTracker;

    struct CommandMockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        comments: Arc<RwLock<Vec<crate::tracker::model::TrackerComment>>>,
        list_barrier: Option<Arc<tokio::sync::Barrier>>,
    }

    async fn worker_identity_test_orchestrator() -> (Orchestrator, tempfile::TempDir, WorkerIdentity)
    {
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        let identity = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut run = PipelineRun::new("1".to_string(), 1, dag);
            run.start();
            run.mark_running("build", "session-1".to_string());
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), Some(1));
            state.insert_pipeline_run("1", run, Arc::new(cfg.clone()));
            let entry = state.get_running("1").unwrap();
            WorkerIdentity {
                issue_id: "1".to_string(),
                run_id: entry.run_id.clone().unwrap(),
                cycle: 1,
                step_name: "build".to_string(),
                started_at: entry.started_at,
            }
        };

        (orchestrator, dir, identity)
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
    impl IssueTracker for BlockingCandidateTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            self.fetch_started.notify_one();
            self.release_fetch.notified().await;
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
    }

    #[async_trait]
    impl IssueTracker for FailingCandidateTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Err(TrackerError::ApiRequestFailed {
                reason: "candidate fetch failed".to_string(),
            })
        }

        async fn fetch_issues_by_states(
            &self,
            _states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_issue_states_by_ids(
            &self,
            _ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
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
            if let Some(barrier) = &self.list_barrier {
                barrier.wait().await;
            }
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

    struct BlockingDrainRunner {
        started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        cancellation_observed: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Arc<tokio::sync::Semaphore>,
    }

    #[async_trait]
    impl AgentRunner for BlockingDrainRunner {
        async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            if let Some(started) = self.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            request.cancel_token.cancelled().await;
            if let Some(observed) = self.cancellation_observed.lock().unwrap().take() {
                let _ = observed.send(());
            }
            self.release.acquire().await.unwrap().forget();
            Err(AgentError::TurnCancelled)
        }
    }

    async fn blocking_drain_test_orchestrator() -> (
        Arc<Orchestrator>,
        tempfile::TempDir,
        Arc<RwLock<Vec<Issue>>>,
        tokio::sync::oneshot::Receiver<()>,
        Arc<tokio::sync::Semaphore>,
    ) {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::clone(&issues),
        });
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(BlockingDrainRunner {
            started: std::sync::Mutex::new(Some(started_tx)),
            cancellation_observed: std::sync::Mutex::new(Some(cancelled_tx)),
            release: Arc::clone(&release),
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Arc::new(Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        ));

        orchestrator.handle_tick().await;
        started_rx.await.unwrap();

        (orchestrator, dir, issues, cancelled_rx, release)
    }

    async fn handle_queued_worker_event_if_any(orchestrator: Arc<Orchestrator>) -> Orchestrator {
        let orchestrator = Arc::try_unwrap(orchestrator)
            .ok()
            .expect("test owns the only orchestrator reference");
        let queued_event = orchestrator.worker_rx.lock().await.try_recv().ok();
        if let Some(queued_event) = queued_event {
            orchestrator.handle_worker_event(queued_event).await;
        }
        orchestrator
    }

    async fn assert_single_stopped_history(dir: &tempfile::TempDir, issue_id: &str) {
        let history_path = dir.path().join("ensemble_history.jsonl");
        let contents = tokio::fs::read_to_string(history_path).await.unwrap();
        let stopped_count = contents
            .lines()
            .map(|line| serde_json::from_str::<HistoryRecord>(line).unwrap())
            .filter(|record| record.issue_id == issue_id && record.outcome == "stopped")
            .count();
        assert_eq!(
            stopped_count, 1,
            "reconciliation must append stopped history exactly once"
        );
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

    struct CountingRunner {
        runs: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl AgentRunner for CountingRunner {
        async fn run(&self, _request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            self.runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(WorkerResult::Success {
                output: succeeded_step_output(),
                approval_request: None,
            })
        }
    }

    struct InteractionCaptureRunner {
        responses: Arc<RwLock<Vec<Option<InteractionResponseEnvelope>>>>,
    }

    struct RecordingAcceptanceRunner {
        statuses: std::sync::Mutex<std::collections::VecDeque<AcceptanceStatus>>,
        calls: Arc<std::sync::Mutex<Vec<String>>>,
    }

    struct BlockingAcceptanceRunner {
        started: Arc<tokio::sync::Barrier>,
        release: Arc<tokio::sync::Barrier>,
    }

    #[async_trait]
    impl AcceptanceCommandRunner for BlockingAcceptanceRunner {
        async fn run(
            &self,
            command: &crate::config::ensemble::AcceptanceCommandConfig,
            _issue_workspace: &Path,
        ) -> crate::acceptance::AcceptanceResult {
            self.started.wait().await;
            self.release.wait().await;
            crate::acceptance::AcceptanceResult {
                name: command.name.clone(),
                status: AcceptanceStatus::Passed,
                exit_code: Some(0),
                stdout: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                stderr: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                summary: "passed".into(),
            }
        }
    }

    #[async_trait]
    impl AcceptanceCommandRunner for RecordingAcceptanceRunner {
        async fn run(
            &self,
            command: &crate::config::ensemble::AcceptanceCommandConfig,
            _issue_workspace: &Path,
        ) -> crate::acceptance::AcceptanceResult {
            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(command.name.clone());
            let status = self
                .statuses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
                .unwrap_or(AcceptanceStatus::Passed);
            crate::acceptance::AcceptanceResult {
                name: command.name.clone(),
                exit_code: (status == AcceptanceStatus::Passed).then_some(0),
                summary: format!("{}: {status:?}", command.name),
                status,
                stdout: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                stderr: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
            }
        }
    }

    #[async_trait]
    impl AgentRunner for InteractionCaptureRunner {
        async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
            self.responses
                .write()
                .await
                .push(request.interaction_response.clone());
            Ok(WorkerResult::Success {
                output: succeeded_step_output(),
                approval_request: None,
            })
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

    struct ControllableWriteTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
        failures_remaining: Arc<RwLock<u32>>,
        state_writes: Arc<RwLock<Vec<(String, String)>>>,
    }

    #[async_trait]
    impl IssueTracker for ControllableWriteTracker {
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
            let mut failures_remaining = self.failures_remaining.write().await;
            if *failures_remaining > 0 {
                *failures_remaining -= 1;
                return Err(TrackerError::ApiRequestFailed {
                    reason: "simulated ambiguous tracker response".to_string(),
                });
            }
            Ok(())
        }
    }

    fn test_issue(id: &str, state: &str) -> Issue {
        crate::tracker::model::test_helpers::test_issue(id, state)
    }

    async fn install_approval_waiting_run(
        orchestrator: &Orchestrator,
        config: &Arc<RwLock<EnsembleConfig>>,
        interaction_id: &str,
    ) {
        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new("1".to_string(), 1, dag);
        run.start();
        run.step_states.insert(
            "build".to_string(),
            StepState::AwaitingApproval {
                interaction_request_id: Some(interaction_id.to_string()),
            },
        );
        let mut state = orchestrator.state.write().await;
        state.insert_pipeline_run("1", run, Arc::new(cfg.clone()));
        state.add_claimed("1");
    }

    #[tokio::test]
    async fn worker_identity_quiescing_latch_blocks_dispatch_from_in_progress_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let fetch_started = Arc::new(tokio::sync::Notify::new());
        let release_fetch = Arc::new(tokio::sync::Notify::new());
        let tracker: Arc<dyn IssueTracker> = Arc::new(BlockingCandidateTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
            fetch_started: Arc::clone(&fetch_started),
            release_fetch: Arc::clone(&release_fetch),
        });
        let runs = Arc::new(AtomicUsize::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::clone(&runs),
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
        let quiescing = orchestrator.quiescing_latch_owner();

        let tick = tokio::spawn(async move {
            orchestrator.handle_tick().await;
            orchestrator
        });
        fetch_started.notified().await;
        quiescing.request();
        release_fetch.notify_one();

        let orchestrator = tick.await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        assert!(!orchestrator.state.read().await.is_running("1"));
    }

    #[tokio::test]
    async fn worker_identity_quiescing_latch_rejects_new_dispatch_permit() {
        let (orchestrator, _dir, _identity) = worker_identity_test_orchestrator().await;
        orchestrator.quiescing_latch_owner().request();

        assert!(orchestrator.quiescing.begin_dispatch().is_none());
        assert!(mark_all_for_drain(&orchestrator.cancellation_registry).is_empty());
    }

    #[tokio::test]
    async fn worker_identity_quiescing_latch_retains_retry_during_candidate_fetch() {
        let config = Arc::new(RwLock::new(make_config()));
        let fetch_started = Arc::new(tokio::sync::Notify::new());
        let release_fetch = Arc::new(tokio::sync::Notify::new());
        let tracker: Arc<dyn IssueTracker> = Arc::new(BlockingCandidateTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
            fetch_started: Arc::clone(&fetch_started),
            release_fetch: Arc::clone(&release_fetch),
        });
        let runs = Arc::new(AtomicUsize::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::clone(&runs),
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
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: current_time_ms(),
            error: Some("retry".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        let original_due_at_ms = retry.due_at_ms;
        orchestrator.state.write().await.add_retry(retry.clone());
        let quiescing = orchestrator.quiescing_latch_owner();

        let retry_task = tokio::spawn(async move {
            orchestrator.handle_single_retry(&retry).await;
            orchestrator
        });
        fetch_started.notified().await;
        quiescing.request();
        release_fetch.notify_one();

        let orchestrator = retry_task.await.unwrap();
        let state = orchestrator.state.read().await;
        let retained = state.retry_attempts.get("1").unwrap();
        assert_eq!(retained.attempt, 2);
        assert_eq!(retained.error.as_deref(), Some("orchestrator quiescing"));
        assert!(retained.due_at_ms > original_due_at_ms);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }

    async fn create_finalize_repo() -> (tempfile::TempDir, crate::config::ensemble::RepoConfig) {
        let temp = tempfile::TempDir::new().unwrap();
        let repo_path = temp.path().join("source-repo");
        tokio::fs::create_dir_all(&repo_path).await.unwrap();

        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test User"],
        ] {
            let output = tokio::process::Command::new("git")
                .args(args)
                .current_dir(&repo_path)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "git command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        tokio::fs::write(repo_path.join("README.md"), "# source repo\n")
            .await
            .unwrap();
        for args in [vec!["add", "README.md"], vec!["commit", "-m", "initial"]] {
            let output = tokio::process::Command::new("git")
                .args(args)
                .current_dir(&repo_path)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "git command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        (
            temp,
            crate::config::ensemble::RepoConfig {
                path: repo_path.display().to_string(),
                branch: "main".to_string(),
                git_remote: "origin".to_string(),
                finalize: crate::workspace::finalize::RepoFinalizeConfig {
                    enabled: true,
                    mode: FinalizeMode::Push,
                    approval_required: true,
                },
            },
        )
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

    fn test_question_interaction(
        issue: &Issue,
        pipeline_cycle: u32,
        interaction_id: &str,
    ) -> InteractionRequest {
        InteractionRequest {
            id: interaction_id.to_string(),
            schema_version: 1,
            issue_id: issue.id.clone(),
            issue_identifier: issue.identifier.clone(),
            pipeline_cycle,
            completed_steps: Vec::new(),
            step_name: "build".to_string(),
            agent_name: "builder".to_string(),
            step_depends: Vec::new(),
            step_tracker_state: None,
            kind: InteractionKind::Question,
            status: InteractionStatus::Open,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: "Need input".to_string(),
            body: "Choose environment".to_string(),
            options: Vec::new(),
            artifacts: Vec::new(),
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
            ignored_commands: Vec::new(),
        }
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

    fn make_restart_test_orchestrator(
        temp: &tempfile::TempDir,
        cfg: &EnsembleConfig,
        issue: &Issue,
    ) -> (Orchestrator, Arc<RwLock<OrchestratorState>>) {
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        make_restart_test_orchestrator_with_runner(temp, cfg, issue, runner)
    }

    fn make_restart_test_orchestrator_with_runner(
        temp: &tempfile::TempDir,
        cfg: &EnsembleConfig,
        issue: &Issue,
        runner: Arc<dyn AgentRunner>,
    ) -> (Orchestrator, Arc<RwLock<OrchestratorState>>) {
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let workspace_root = temp.path().join("workspaces");
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config: Arc::new(RwLock::new(cfg.clone())),
                tracker,
                agent_runner: runner,
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            temp.path(),
            shutdown_rx,
        );
        (orchestrator, state)
    }

    fn make_acceptance_test_orchestrator(
        temp: &tempfile::TempDir,
        cfg: &EnsembleConfig,
        issue: &Issue,
        acceptance_runner: Arc<dyn AcceptanceCommandRunner>,
    ) -> (Orchestrator, Arc<RwLock<OrchestratorState>>) {
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let workspace_root = temp.path().join("workspaces");
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config: Arc::new(RwLock::new(cfg.clone())),
                tracker,
                agent_runner: Arc::new(MockRunner {
                    delay_ms: 0,
                    observed_commands: None,
                    observed_timeouts: None,
                    cancellation_probe: None,
                }),
                acceptance_runner,
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            temp.path(),
            shutdown_rx,
        );
        (orchestrator, state)
    }

    fn acceptance_config(names: &[&str]) -> EnsembleConfig {
        let mut config = make_config();
        config.acceptance.commands = names
            .iter()
            .map(|name| crate::config::ensemble::AcceptanceCommandConfig {
                name: (*name).to_string(),
                run: format!("run-{name}"),
                timeout_ms: 1_000,
            })
            .collect();
        config
    }

    async fn install_succeeded_run(
        state: &Arc<RwLock<OrchestratorState>>,
        issue: &Issue,
        config: &EnsembleConfig,
    ) {
        let dag = build_dag(&config.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        for step in run.step_states.values_mut() {
            *step = StepState::Passed;
        }
        let mut state = state.write().await;
        state.insert_pipeline_run(&issue.id, run, Arc::new(config.clone()));
        state.add_running(issue, None);
    }

    async fn install_acceptance_started(
        orchestrator: &Orchestrator,
        state: &Arc<RwLock<OrchestratorState>>,
        issue: &Issue,
    ) {
        let transition = {
            let mut state = state.write().await;
            let run = state.get_pipeline_run_mut(&issue.id).unwrap();
            run.acceptance_attempts
                .push(crate::acceptance::AcceptanceAttempt {
                    cycle: run.cycle,
                    results: Vec::new(),
                });
            Orchestrator::transition_input_for_run(
                &state,
                &issue.id,
                &issue.identifier,
                PipelineTransitionKind::AcceptanceStarted,
                None,
                None,
                None,
            )
            .unwrap()
        };
        orchestrator
            .pipeline_journal
            .append(transition)
            .await
            .unwrap();
    }

    async fn install_acceptance_waiting_owner(
        orchestrator: &Orchestrator,
        state: &Arc<RwLock<OrchestratorState>>,
        issue: &Issue,
        interaction_id: &str,
    ) {
        let mut interaction = test_question_interaction(issue, 1, interaction_id);
        interaction.status = InteractionStatus::Resolved;
        interaction.awaiting_resume = true;
        interaction.response = Some(InteractionResponse::Question {
            response_schema_version: 1,
            text: "continue".to_string(),
            selected_option: None,
        });
        interaction.resolved_at = Some(Utc::now());
        orchestrator
            .interaction_store
            .create(interaction.clone())
            .await
            .unwrap();
        let mut state = state.write().await;
        let running = state.remove_running(&issue.id).unwrap();
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: interaction_id.to_string(),
            step_name: "build".to_string(),
            kind: InteractionKind::Question,
            prompt: "continue".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: Some(1),
            started_at: Some(running.started_at),
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: interaction.requested_at,
            run_id: running.run_id,
            issue: Some(issue.clone()),
        });
    }

    #[tokio::test]
    async fn acceptance_runs_all_commands_in_order_and_journals_before_advancing() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-order", "In Progress");
        let config = acceptance_config(&["first", "second", "third"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new(
                [
                    AcceptanceStatus::Failed,
                    AcceptanceStatus::Passed,
                    AcceptanceStatus::TimedOut,
                ]
                .into(),
            ),
            calls: Arc::clone(&calls),
        });
        let (orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;

        let outcome = orchestrator.run_acceptance_phase(&issue, &config).await;

        assert!(matches!(outcome, AcceptancePhaseOutcome::Failed { .. }));
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["first", "second", "third"]
        );
        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert_eq!(records[0].kind, PipelineTransitionKind::AcceptanceStarted);
        assert!(records[1..]
            .iter()
            .all(|record| record.kind == PipelineTransitionKind::AcceptanceCommandCompleted));
        for pair in records.windows(2) {
            assert!(pair[0].seq < pair[1].seq);
            assert!(
                pair[0].snapshot.as_ref().unwrap().acceptance_attempts[0]
                    .results
                    .len()
                    < pair[1].snapshot.as_ref().unwrap().acceptance_attempts[0]
                        .results
                        .len()
            );
        }
    }

    #[tokio::test]
    async fn acceptance_recovery_resumes_after_durable_prefix() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-resume", "In Progress");
        let config = acceptance_config(&["first", "second"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Passed].into()),
            calls: Arc::clone(&calls),
        });
        let (orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        {
            let mut state = state.write().await;
            state
                .get_pipeline_run_mut(&issue.id)
                .unwrap()
                .acceptance_attempts
                .push(crate::acceptance::AcceptanceAttempt {
                    cycle: 1,
                    results: vec![crate::acceptance::AcceptanceResult {
                        name: "first".into(),
                        status: AcceptanceStatus::Passed,
                        exit_code: Some(0),
                        stdout: crate::acceptance::AcceptanceOutput {
                            tail: String::new(),
                            total_bytes: 0,
                            truncated: false,
                        },
                        stderr: crate::acceptance::AcceptanceOutput {
                            tail: String::new(),
                            total_bytes: 0,
                            truncated: false,
                        },
                        summary: "first passed".into(),
                    }],
                });
        }

        let outcome = orchestrator.run_acceptance_phase(&issue, &config).await;

        assert!(matches!(outcome, AcceptancePhaseOutcome::Passed));
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["second"]
        );
    }

    #[tokio::test]
    async fn acceptance_journal_failures_do_not_advance_execution_or_evidence() {
        for fail_on_call in [1, 2] {
            let temp = tempfile::TempDir::new().unwrap();
            let issue = test_issue(&format!("acceptance-journal-{fail_on_call}"), "In Progress");
            let config = acceptance_config(&["first", "second"]);
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let runner = Arc::new(RecordingAcceptanceRunner {
                statuses: std::sync::Mutex::new([AcceptanceStatus::Passed].into()),
                calls: Arc::clone(&calls),
            });
            let (mut orchestrator, state) =
                make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
            orchestrator
                .pipeline_journal
                .transaction_append_error_on_call =
                Some((Arc::new(AtomicUsize::new(0)), fail_on_call));
            install_succeeded_run(&state, &issue, &config).await;

            let outcome = orchestrator.run_acceptance_phase(&issue, &config).await;

            assert!(matches!(
                outcome,
                AcceptancePhaseOutcome::RetainedForRecovery
            ));
            let calls = calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if fail_on_call == 1 {
                assert!(calls.is_empty());
                assert!(state
                    .read()
                    .await
                    .get_pipeline_run(&issue.id)
                    .unwrap()
                    .acceptance_attempts
                    .is_empty());
            } else {
                assert_eq!(calls, vec!["first"]);
                let state = state.read().await;
                let attempt = &state
                    .get_pipeline_run(&issue.id)
                    .unwrap()
                    .acceptance_attempts[0];
                assert!(attempt.results.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn acceptance_journal_failure_is_redispatched_on_the_next_tick() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-journal-recovery", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new(
                [AcceptanceStatus::Passed, AcceptanceStatus::Passed].into(),
            ),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 2));
        install_succeeded_run(&state, &issue, &config).await;

        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        orchestrator.handle_tick().await;

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test", "test"]
        );
    }

    #[tokio::test]
    async fn acceptance_journal_failure_retires_a_waiting_owner_before_redispatch() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-waiting-recovery", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new(
                [AcceptanceStatus::Passed, AcceptanceStatus::Passed].into(),
            ),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 2));
        install_succeeded_run(&state, &issue, &config).await;
        let interaction_id = "acceptance-waiting-interaction";
        install_acceptance_waiting_owner(&orchestrator, &state, &issue, interaction_id).await;

        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        orchestrator.handle_tick().await;

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test", "test"]
        );
        assert!(
            !orchestrator
                .interaction_store
                .get(interaction_id)
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn acceptance_late_append_error_uses_the_exact_durable_transition() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-late-append", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Passed].into()),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        orchestrator.pipeline_journal.transaction_append_late_error = true;
        install_succeeded_run(&state, &issue, &config).await;

        let outcome = orchestrator.run_acceptance_phase(&issue, &config).await;

        assert!(matches!(outcome, AcceptancePhaseOutcome::Passed));
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"]
        );
    }

    #[tokio::test]
    async fn acceptance_ambiguous_append_reconciles_exact_visibility_on_a_later_tick() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-ambiguous-exact", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Passed].into()),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        install_acceptance_started(&orchestrator, &state, &issue).await;
        orchestrator.pipeline_journal.transaction_append_late_error = true;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = true;

        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"]
        );
        assert!(state
            .read()
            .await
            .get_pipeline_run(&issue.id)
            .unwrap()
            .acceptance_attempts[0]
            .results
            .is_empty());

        orchestrator.handle_tick().await;
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"],
            "an unreadable acceptance transition must remain fail-closed"
        );
        assert!(state.read().await.is_running(&issue.id));

        orchestrator.pipeline_journal.transaction_append_late_error = false;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = false;
        orchestrator.handle_tick().await;

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"],
            "an exactly visible acceptance result must not execute again"
        );
        assert!(
            !state.read().await.is_running(&issue.id),
            "the retained owner must advance after journal visibility recovers"
        );
    }

    #[tokio::test]
    async fn acceptance_ambiguous_append_redispatches_after_confirmed_absence() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-ambiguous-absent", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new(
                [AcceptanceStatus::Passed, AcceptanceStatus::Passed].into(),
            ),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        install_acceptance_started(&orchestrator, &state, &issue).await;
        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 1));
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = true;

        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"]
        );
        assert!(state.read().await.is_running(&issue.id));

        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = false;
        orchestrator.handle_tick().await;

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test", "test"],
            "only the command whose result was confirmed absent may execute again"
        );
        assert!(
            !state.read().await.is_running(&issue.id),
            "confirmed absence must release the retained owner for redispatch"
        );
    }

    #[tokio::test]
    async fn acceptance_ambiguous_reconciliation_retries_waiting_owner_retirement() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-ambiguous-waiting", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Passed].into()),
            calls: Arc::clone(&calls),
        });
        let (mut orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        install_acceptance_started(&orchestrator, &state, &issue).await;
        let interaction_id = "acceptance-ambiguous-waiting-interaction";
        install_acceptance_waiting_owner(&orchestrator, &state, &issue, interaction_id).await;
        orchestrator.pipeline_journal.transaction_append_late_error = true;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = true;

        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        orchestrator.pipeline_journal.transaction_append_late_error = false;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = false;
        orchestrator.interaction_store.fail_next_writes(1);

        orchestrator
            .reconcile_pending_acceptance_transitions()
            .await;
        assert!(state.read().await.is_waiting_on_human(&issue.id));
        assert!(
            orchestrator
                .interaction_store
                .get(interaction_id)
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );

        orchestrator
            .reconcile_pending_acceptance_transitions()
            .await;

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"]
        );
        let state = state.read().await;
        assert!(!state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .acceptance_attempts[0]
                .results
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn acceptance_does_not_commit_a_result_for_a_replaced_running_attempt() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-stale", "In Progress");
        let config = acceptance_config(&["test"]);
        let started = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        let runner = Arc::new(BlockingAcceptanceRunner {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        });
        let (orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        let orchestrator = Arc::new(orchestrator);
        let execution = {
            let orchestrator = Arc::clone(&orchestrator);
            let issue = issue.clone();
            let config = config.clone();
            tokio::spawn(async move { orchestrator.run_acceptance_phase(&issue, &config).await })
        };
        started.wait().await;
        {
            let mut state = state.write().await;
            state.running.get_mut(&issue.id).unwrap().started_at += chrono::Duration::seconds(1);
        }
        release.wait().await;

        assert!(matches!(
            execution.await.unwrap(),
            AcceptancePhaseOutcome::RetainedForRecovery
        ));
        let state = state.read().await;
        assert!(state
            .get_pipeline_run(&issue.id)
            .unwrap()
            .acceptance_attempts[0]
            .results
            .is_empty());
        drop(state);
        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, PipelineTransitionKind::AcceptanceStarted);
    }

    #[test]
    fn acceptance_recovery_rejects_a_name_mismatch() {
        let config = acceptance_config(&["configured"]);
        let dag = build_dag(&config.steps).unwrap();
        let mut run = PipelineRun::new("issue".into(), 1, dag);
        run.acceptance_attempts = vec![crate::acceptance::AcceptanceAttempt {
            cycle: 1,
            results: vec![crate::acceptance::AcceptanceResult {
                name: "old-name".into(),
                status: AcceptanceStatus::Passed,
                exit_code: Some(0),
                stdout: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                stderr: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                summary: "passed".into(),
            }],
        }];

        let error =
            validate_restored_snapshot_against_config(&run.to_snapshot(), &config).unwrap_err();

        assert!(error
            .to_string()
            .contains("no longer matches configured command"));
    }

    #[test]
    fn acceptance_recovery_allows_historical_attempts_from_an_older_config() {
        let config = acceptance_config(&["configured"]);
        let dag = build_dag(&config.steps).unwrap();
        let mut run = PipelineRun::new("issue".into(), 2, dag);
        run.acceptance_attempts = vec![crate::acceptance::AcceptanceAttempt {
            cycle: 1,
            results: vec![crate::acceptance::AcceptanceResult {
                name: "old-name".into(),
                status: AcceptanceStatus::Passed,
                exit_code: Some(0),
                stdout: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                stderr: crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
                summary: "passed".into(),
            }],
        }];

        validate_restored_snapshot_against_config(&run.to_snapshot(), &config).unwrap();
    }

    #[tokio::test]
    async fn acceptance_retry_preserves_completed_attempts_in_the_next_cycle() {
        let temp = tempfile::TempDir::new().unwrap();
        let issue = test_issue("acceptance-retry", "In Progress");
        let config = acceptance_config(&["test"]);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Failed].into()),
            calls,
        });
        let (orchestrator, state) =
            make_acceptance_test_orchestrator(&temp, &config, &issue, runner);
        install_succeeded_run(&state, &issue, &config).await;
        assert!(matches!(
            orchestrator.run_acceptance_phase(&issue, &config).await,
            AcceptancePhaseOutcome::Failed { .. }
        ));

        let transition = {
            let mut state = state.write().await;
            Orchestrator::prepare_whole_issue_retry(
                &mut state,
                &config,
                &issue.id,
                &issue.identifier,
                "acceptance failed",
                RetryEntry {
                    issue_id: issue.id.clone(),
                    identifier: issue.identifier.clone(),
                    attempt: 2,
                    due_at_ms: 0,
                    error: Some("acceptance failed".into()),
                    retry_from_step: None,
                    with_fixup: false,
                },
            )
            .unwrap()
        };

        let snapshot = transition.snapshot.unwrap();
        assert_eq!(snapshot.cycle, 2);
        assert_eq!(snapshot.acceptance_attempts.len(), 1);
        assert_eq!(snapshot.acceptance_attempts[0].cycle, 1);
        assert_eq!(
            snapshot.acceptance_attempts[0].results[0].status,
            AcceptanceStatus::Failed
        );
    }

    #[tokio::test]
    async fn restore_pipeline_run_continues_timeline_sequence_across_restarts() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_retry_step_config();
        let issue = test_issue("1", "Todo");
        let (setup, _) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        setup
            .history_store
            .as_ref()
            .unwrap()
            .append_timeline_event(&crate::timeline::model::TimelineEventRecord {
                run_id: "run-1".to_string(),
                issue_identifier: issue.identifier.clone(),
                sequence: 7,
                timestamp: Utc::now(),
                event_type: "output".to_string(),
                step_name: Some("build".to_string()),
                attempt: 1,
                detail: "before restart".to_string(),
                verdict: None,
                tool_name: None,
            })
            .await
            .unwrap();
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.step_failed("build", "manual halt".to_string());
        setup
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
                terminal_transition: None,
            })
            .await
            .unwrap();
        drop(setup);

        let (mut first_restart, first_state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        first_restart.restore_pipeline_runs_from_journal().await;
        let first_sequence = first_state.write().await.next_timeline_sequence("run-1");
        assert_eq!(first_sequence, 8);
        first_restart
            .publish_pipeline_event(
                Some("run-1".to_string()),
                Some(first_sequence),
                1,
                PipelineEvent::Output {
                    issue_identifier: issue.identifier.clone(),
                    timestamp: Utc::now(),
                    step_name: "build".to_string(),
                    detail: "after first restart".to_string(),
                },
            )
            .await;
        first_restart
            .timeline_persistence
            .as_mut()
            .unwrap()
            .flush()
            .await;
        drop(first_restart);

        let (second_restart, second_state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        second_restart.restore_pipeline_runs_from_journal().await;
        let second_sequence = second_state.write().await.next_timeline_sequence("run-1");
        assert_eq!(second_sequence, 9);
    }

    #[tokio::test]
    async fn handle_tick_does_not_fresh_dispatch_when_timeline_restore_fails() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_retry_step_config();
        let issue = test_issue("1", "Todo");
        let (mut orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.step_failed("build", "manual halt".to_string());
        let halted_record = orchestrator
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
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator.history_store = None;

        orchestrator.handle_tick().await;

        let state = state.read().await;
        assert!(state.get_pipeline_run(&issue.id).is_none());
        assert!(!state.is_claimed(&issue.id));
        assert!(!state.is_running(&issue.id));
        drop(state);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert!(!records.iter().any(|record| {
            record.seq > halted_record.seq && record.kind == PipelineTransitionKind::StepRunning
        }));
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                terminal_transition: None,
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
    async fn workspace_identity_lifecycle_retry_journal_restoration_uses_same_path() {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                terminal_transition: None,
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
        let restored_retry = lock.retry_attempts.get(&issue.id).unwrap();
        assert_eq!(
            orchestrator
                .workspace_mgr
                .workspace_path(&restored_retry.issue_id),
            temp.path()
                .join("workspaces")
                .join(crate::workspace::key::issue_workspace_key(&issue.id))
        );
    }

    #[tokio::test]
    async fn handle_tick_restores_step_retry_journal_without_dispatching() {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
            due_at_ms: current_time_ms().saturating_add(60_000),
            error: Some("retry later".to_string()),
            retry_from_step: Some("build".to_string()),
            with_fixup: false,
        };
        let retry_record = orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("retry later".to_string()),
                retry: Some(retry),
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let lock = state.read().await;
        assert!(lock.retry_attempts.contains_key(&issue.id));
        assert!(!lock.is_running(&issue.id));
        drop(lock);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert!(!records.iter().any(|record| {
            record.seq > retry_record.seq && record.kind == PipelineTransitionKind::StepRunning
        }));
    }

    #[tokio::test]
    async fn handle_tick_restores_blocked_live_journal_without_dispatching() {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
        run.step_states.insert(
            "build".to_string(),
            StepState::BlockedOnHuman {
                interaction_request_id: "ask-1".to_string(),
            },
        );
        let blocked_record = orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepBlockedOnHuman,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("need input".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let lock = state.read().await;
        assert!(lock.get_pipeline_run(&issue.id).is_some());
        assert!(!lock.is_running(&issue.id));
        drop(lock);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue(&issue.id)
            .await
            .unwrap();
        assert!(!records.iter().any(|record| {
            record.seq > blocked_record.seq && record.kind == PipelineTransitionKind::StepRunning
        }));
    }

    #[tokio::test]
    async fn restart_reconciles_reserved_step_before_hydrating_stale_interaction() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
        let responses = Arc::new(RwLock::new(Vec::new()));
        let runner: Arc<dyn AgentRunner> = Arc::new(InteractionCaptureRunner {
            responses: Arc::clone(&responses),
        });
        let (orchestrator, state) =
            make_restart_test_orchestrator_with_runner(&temp, &cfg, &issue, runner);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "reserved-session".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some(format!("{INTERACTION_RESUME_REASON_PREFIX}interaction-1")),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
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
                ignored_commands: Vec::new(),
            })
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        assert!(state.is_claimed(&issue.id));
        assert!(!state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .step_states
                .get("build"),
            Some(&StepState::Pending)
        );
        drop(state);
        assert!(
            !orchestrator
                .interaction_store
                .get("interaction-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );

        orchestrator.dispatch_issue(&issue, None).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        let captured = responses.read().await;
        assert_eq!(captured.len(), 1);
        assert_eq!(
            captured[0]
                .as_ref()
                .map(|response| serde_json::to_value(response).unwrap()["interaction_id"].clone()),
            Some(serde_json::json!("interaction-1"))
        );
        drop(captured);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            interaction_id_from_resume_reason(latest.reason.as_deref()),
            Some("interaction-1")
        );
        drop(orchestrator);

        let runner: Arc<dyn AgentRunner> = Arc::new(InteractionCaptureRunner {
            responses: Arc::clone(&responses),
        });
        let (second_restart, _) =
            make_restart_test_orchestrator_with_runner(&temp, &cfg, &issue, runner);
        second_restart.restore_pipeline_runs_from_journal().await;
        second_restart.hydrate_waiting_on_human_from_store().await;
        second_restart.dispatch_issue(&issue, None).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        let captured = responses.read().await;
        assert_eq!(captured.len(), 2);
        assert_eq!(
            captured[1]
                .as_ref()
                .map(|response| serde_json::to_value(response).unwrap()["interaction_id"].clone()),
            Some(serde_json::json!("interaction-1"))
        );
    }

    #[tokio::test]
    async fn restart_reconstructs_untagged_question_checkpoint_from_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
        let (mut orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "crashed-session".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
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
                ignored_commands: Vec::new(),
            })
            .await
            .unwrap();

        orchestrator.pipeline_journal.transaction_append_late_error = true;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = true;
        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        {
            let state = state.read().await;
            assert!(!state.is_waiting_on_human(&issue.id));
            assert_eq!(
                state
                    .get_pipeline_run(&issue.id)
                    .unwrap()
                    .step_states
                    .get("build"),
                Some(&StepState::BlockedOnHuman {
                    interaction_request_id: "interaction-1".to_string(),
                })
            );
        }
        orchestrator.pipeline_journal.transaction_append_late_error = false;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = false;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        assert!(state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .step_states
                .get("build"),
            Some(&StepState::BlockedOnHuman {
                interaction_request_id: "interaction-1".to_string(),
            })
        );
        drop(state);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.kind, PipelineTransitionKind::StepBlockedOnHuman);
        assert_eq!(latest.reason.as_deref(), Some("interaction-1"));
    }

    #[tokio::test]
    async fn restart_retires_stale_interaction_from_older_pipeline_cycle() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_parallel_resume_config();
        let issue = test_issue("1", "Todo");
        let (orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 2, dag);
        run.start();
        run.mark_running("docs", "newer-session".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-2".to_string()),
                cycle: 2,
                step: Some("docs".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator
            .interaction_store
            .create(test_question_interaction(&issue, 1, "interaction-1"))
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        assert!(!state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .step_states
                .get("build"),
            Some(&StepState::Pending)
        );
        drop(state);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.kind, PipelineTransitionKind::StepRunning);
        assert_eq!(latest.seq, 1);
        assert_eq!(latest.run_id.as_deref(), Some("run-2"));
        assert_eq!(latest.cycle, 2);
        assert_eq!(latest.step.as_deref(), Some("docs"));
        assert_eq!(latest.reason, None);
        let retired = orchestrator
            .interaction_store
            .get("interaction-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retired.status, InteractionStatus::Cancelled);
        assert!(!retired.awaiting_resume);
    }

    #[tokio::test]
    async fn restart_hydrates_same_cycle_interaction_from_parallel_step_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_parallel_resume_config();
        let issue = test_issue("1", "Todo");
        let (orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.step_blocked_on_human("build", "interaction-1".to_string());
        run.mark_running("docs", "docs-session".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("docs".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator
            .interaction_store
            .create(test_question_interaction(&issue, 1, "interaction-1"))
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        assert!(state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .step_states
                .get("build"),
            Some(&StepState::BlockedOnHuman {
                interaction_request_id: "interaction-1".to_string(),
            })
        );
        drop(state);
        let retained = orchestrator
            .interaction_store
            .get("interaction-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retained.status, InteractionStatus::Open);
        assert!(retained.awaiting_resume);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.seq, 1);
        assert_eq!(latest.cycle, 1);
        assert_eq!(latest.step.as_deref(), Some("docs"));
    }

    #[tokio::test]
    async fn stale_sidecar_retirement_preserves_newer_halted_owner_with_same_id() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
        let (orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 2, dag);
        run.step_failed("build", "newer halt".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineHalted,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-2".to_string()),
                cycle: 2,
                step: Some("build".to_string()),
                reason: Some("newer halt".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        let interaction_id = format!("halted:{}:build", issue.id);
        let mut stale_interaction = test_question_interaction(&issue, 1, &interaction_id);
        stale_interaction.kind = InteractionKind::Handoff;
        orchestrator
            .interaction_store
            .create(stale_interaction)
            .await
            .unwrap();

        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        let waiting = state.waiting_on_human.get(&issue.id).unwrap();
        assert_eq!(waiting.interaction_request_id, interaction_id);
        assert_eq!(waiting.retry_attempt, Some(2));
        assert_eq!(waiting.run_id.as_deref(), Some("run-2"));
        assert_eq!(waiting.prompt, "newer halt");
        drop(state);
        let retired = orchestrator
            .interaction_store
            .get(&interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retired.status, InteractionStatus::Cancelled);
        assert!(!retired.awaiting_resume);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.seq, 1);
        assert_eq!(latest.kind, PipelineTransitionKind::PipelineHalted);
        assert_eq!(latest.cycle, 2);
    }

    #[tokio::test]
    async fn restart_binds_unbound_approval_checkpoint_from_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = make_config();
        let issue = test_issue("1", "Todo");
        let (mut orchestrator, state) = make_restart_test_orchestrator(&temp, &cfg, &issue);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.step_states.insert(
            "build".to_string(),
            StepState::AwaitingApproval {
                interaction_request_id: None,
            },
        );
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepAwaitingApproval,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("succeeded".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "approval-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::ApprovalGate,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::AdvanceAfterStep,
                title: "Approve build".to_string(),
                body: "Continue?".to_string(),
                options: vec!["approve".to_string(), "reject".to_string()],
                artifacts: Vec::new(),
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
                ignored_commands: Vec::new(),
            })
            .await
            .unwrap();

        orchestrator.pipeline_journal.transaction_append_late_error = true;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = true;
        orchestrator.restore_pipeline_runs_from_journal().await;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        {
            let state = state.read().await;
            assert!(!state.is_waiting_on_human(&issue.id));
            assert_eq!(
                state
                    .get_pipeline_run(&issue.id)
                    .unwrap()
                    .step_states
                    .get("build"),
                Some(&StepState::AwaitingApproval {
                    interaction_request_id: Some("approval-1".to_string()),
                })
            );
        }
        orchestrator.pipeline_journal.transaction_append_late_error = false;
        orchestrator
            .pipeline_journal
            .transaction_latest_record_match_error = false;
        orchestrator.hydrate_waiting_on_human_from_store().await;

        let state = state.read().await;
        assert!(state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state
                .get_pipeline_run(&issue.id)
                .unwrap()
                .step_states
                .get("build"),
            Some(&StepState::AwaitingApproval {
                interaction_request_id: Some("approval-1".to_string()),
            })
        );
        drop(state);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.kind, PipelineTransitionKind::StepAwaitingApproval);
        assert_eq!(latest.reason.as_deref(), Some("approval-1"));
        let repaired_seq = latest.seq;
        orchestrator.hydrate_waiting_on_human_from_store().await;
        assert_eq!(
            orchestrator
                .pipeline_journal
                .latest_live_record_for_issue(&issue.id)
                .await
                .unwrap()
                .unwrap()
                .seq,
            repaired_seq
        );
    }

    #[tokio::test]
    async fn handle_tick_restores_question_from_step_tracker_state_once() {
        let temp = tempfile::tempdir().unwrap();
        let mut cfg = make_retry_step_config();
        cfg.steps[0].tracker_state = Some("Agent Review".to_string());
        let issue = test_issue("1", "Agent Review");
        let tracker: Arc<dyn IssueTracker> = Arc::new(WorkflowStateTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let observed_commands = Arc::new(RwLock::new(Vec::new()));
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 100,
            observed_commands: Some(Arc::clone(&observed_commands)),
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config = Arc::new(RwLock::new(cfg.clone()));
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let workspace_root = temp.path().join("workspaces");
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            temp.path(),
            shutdown_rx,
        );

        let interaction = InteractionRequest {
            id: "question-1".to_string(),
            schema_version: 1,
            issue_id: issue.id.clone(),
            issue_identifier: issue.identifier.clone(),
            pipeline_cycle: 1,
            completed_steps: Vec::new(),
            step_name: "build".to_string(),
            agent_name: "builder".to_string(),
            step_depends: Vec::new(),
            step_tracker_state: Some("Agent Review".to_string()),
            kind: InteractionKind::Question,
            status: InteractionStatus::Resolved,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: "Need input".to_string(),
            body: "Choose a direction".to_string(),
            options: Vec::new(),
            artifacts: Vec::new(),
            thread_root_comment_id: None,
            thread_root_comment_url: None,
            last_processed_comment_id: None,
            accepted_command: None,
            ignored_commands: Vec::new(),
            response: Some(InteractionResponse::Question {
                response_schema_version: 1,
                text: "Proceed".to_string(),
                selected_option: None,
            }),
            waiting_started_at: Some(Utc::now()),
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            resolved_at: Some(Utc::now()),
        };
        orchestrator
            .interaction_store
            .create(interaction)
            .await
            .unwrap();

        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.step_blocked_on_human("build", "question-1".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepBlockedOnHuman,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("need input".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        {
            let mut state = state.write().await;
            state.queue_resume(&issue.id);
        }

        orchestrator.handle_tick().await;
        orchestrator.handle_tick().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert_eq!(observed_commands.read().await.len(), 1);
        assert!(
            !orchestrator
                .interaction_store
                .get("question-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        let state = state.read().await;
        assert!(!state.is_resume_requested(&issue.id));
        assert!(!state.is_waiting_on_human(&issue.id));
    }

    #[tokio::test]
    async fn handle_tick_restores_approval_from_approval_tracker_state_once() {
        let temp = tempfile::tempdir().unwrap();
        let mut cfg = make_always_approval_config(10);
        cfg.tracker.active_states = vec!["Todo".to_string(), "In Progress".to_string()];
        let issue = test_issue("1", "Plan Review");
        let tracker: Arc<dyn IssueTracker> = Arc::new(WorkflowStateTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let observed_commands = Arc::new(RwLock::new(Vec::new()));
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 100,
            observed_commands: Some(Arc::clone(&observed_commands)),
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config = Arc::new(RwLock::new(cfg.clone()));
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let workspace_root = temp.path().join("workspaces");
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            temp.path(),
            shutdown_rx,
        );

        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "approval-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::Approval,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::AdvanceAfterStep,
                title: "Approve build".to_string(),
                body: "Approve the completed build".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: Vec::new(),
                response: Some(InteractionResponse::Approval {
                    response_schema_version: 1,
                    approved: true,
                    reason: Some("looks good".to_string()),
                }),
                waiting_started_at: Some(Utc::now()),
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: Some(Utc::now()),
            })
            .await
            .unwrap();

        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.step_states.insert(
            "build".to_string(),
            StepState::AwaitingApproval {
                interaction_request_id: Some("approval-1".to_string()),
            },
        );
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepAwaitingApproval,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-approval".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("approval required".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        {
            let mut state = state.write().await;
            state.queue_resume(&issue.id);
        }

        orchestrator.handle_tick().await;
        orchestrator.handle_tick().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert_eq!(observed_commands.read().await.len(), 1);
        assert!(
            !orchestrator
                .interaction_store
                .get("approval-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        let state = state.read().await;
        assert!(!state.is_resume_requested(&issue.id));
        assert!(!state.is_waiting_on_human(&issue.id));
        let run = state.get_pipeline_run(&issue.id).unwrap();
        assert_eq!(run.step_states.get("build"), Some(&StepState::Passed));
        assert!(matches!(
            run.step_states.get("review"),
            Some(StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn journal_restored_wait_transfers_through_manual_retry_command() {
        let temp = tempfile::tempdir().unwrap();
        let mut cfg = make_retry_step_config();
        cfg.steps[0].tracker_state = Some("Agent Review".to_string());
        let issue = test_issue("1", "Agent Review");
        let tracker: Arc<dyn IssueTracker> = Arc::new(WorkflowStateTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config = Arc::new(RwLock::new(cfg.clone()));
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            cfg.polling.interval_ms,
            &cfg.concurrency,
        )));
        let workspace_root = temp.path().join("workspaces");
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state: Arc::clone(&state),
                config,
                tracker,
                agent_runner: runner,
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            temp.path(),
            shutdown_rx,
        );

        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: Some("Agent Review".to_string()),
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
                response: None,
                waiting_started_at: Some(Utc::now()),
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: Vec::new(),
            })
            .await
            .unwrap();
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.step_blocked_on_human("build", "interaction-1".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepBlockedOnHuman,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("waiting for input".to_string()),
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;
        {
            let state = state.read().await;
            assert!(state.is_waiting_on_human(&issue.id));
            assert!(state.get_pipeline_run(&issue.id).is_some());
        }

        let (response, result) = tokio::sync::oneshot::channel();
        orchestrator
            .handle_command(OrchestratorCommand::QueueManualStepRetry {
                command: ManualStepRetryCommand {
                    issue_id: issue.id.clone(),
                    identifier: issue.identifier.clone(),
                    step_name: "build".to_string(),
                },
                response,
            })
            .await;
        let retry = result.await.unwrap().unwrap();
        assert_eq!(retry.retry_from_step.as_deref(), Some("build"));

        let state = state.read().await;
        assert!(!state.is_waiting_on_human(&issue.id));
        assert!(state.retry_attempts.contains_key(&issue.id));
        assert!(state.is_claimed(&issue.id));
        drop(state);
        let interaction = orchestrator
            .interaction_store
            .get("interaction-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.status, InteractionStatus::Cancelled);
        assert!(!interaction.awaiting_resume);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.kind, PipelineTransitionKind::StepRetryScheduled);
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                terminal_transition: None,
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
        let mut run = PipelineRun::new(issue.id.clone(), 2, dag);
        run.step_completed("implement", succeeded_step_output(), false);
        run.mark_running("review", "stale-review-session".to_string());
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-existing".to_string()),
                cycle: 2,
                step: Some("review".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
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
        assert_eq!(restored_run.cycle, 2);
        assert_eq!(
            restored_run.step_states.get("implement"),
            Some(&StepState::Passed)
        );
        assert!(matches!(
            restored_run.step_states.get("review"),
            Some(StepState::Running { session_id }) if session_id != "stale-review-session"
        ));
        assert_eq!(
            lock.get_running(&issue.id)
                .and_then(|entry| entry.retry_attempt),
            Some(2)
        );

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

    #[tokio::test]
    async fn handle_tick_falls_back_to_fresh_dispatch_when_live_journal_restore_fails() {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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

        let stale_dag = build_dag(&[StepConfig {
            name: "removed".to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends: Some(vec![]),
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }])
        .unwrap();
        let stale_run = PipelineRun::new(issue.id.clone(), 1, stale_dag);
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-stale".to_string()),
                cycle: 1,
                step: Some("removed".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(stale_run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        let lock = state.read().await;
        assert!(lock.is_running(&issue.id));
        let restored_run = lock.get_pipeline_run(&issue.id).unwrap();
        assert!(!restored_run.step_states.contains_key("removed"));
        assert!(matches!(
            restored_run.step_states.get("build"),
            Some(StepState::Running { .. })
        ));
        drop(lock);

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
            1
        );
        assert!(records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::StepRunning
                && record.step.as_deref() == Some("build")));
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                terminal_transition: None,
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

    #[test]
    fn reconciliation_active_states_include_workflow_managed_tracker_states() {
        let yaml = r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Paused"]
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
    tracker_state: Review
  - name: plan
    agent: builder
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
on_success: Done
on_failure: Paused
"#;
        let config = parse_config(yaml).unwrap();

        let states = build_reconcile_active_states_lower(&config);

        assert!(states.contains(&"todo".to_string()));
        assert!(states.contains(&"in progress".to_string()));
        assert!(states.contains(&"review".to_string()));
        assert!(states.contains(&"planning".to_string()));
        assert!(states.contains(&"plan review".to_string()));
        assert!(!states.contains(&"done".to_string()));
        assert!(!states.contains(&"paused".to_string()));
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
    async fn enabled_finalization_returns_without_reentrant_state_locking() {
        let (repo_temp, repo_config) = create_finalize_repo().await;
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
        let workspace_temp = tempfile::TempDir::new().unwrap();
        let workspace_mgr =
            WorkspaceManager::new(workspace_temp.path(), Some(vec![repo_config])).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            workspace_temp.path(),
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
            state.artifacts.insert(
                "1".to_string(),
                RunArtifacts {
                    run_id: "run-1".to_string(),
                    workspace_path: workspace_temp.path().display().to_string(),
                    repos: vec![crate::history::artifacts::RepoArtifact {
                        repo: "source-repo".to_string(),
                        finalize_status: "pending".to_string(),
                        ..Default::default()
                    }],
                    transcripts: vec![],
                },
            );
        }

        tokio::time::timeout(
            Duration::from_secs(5),
            orchestrator.handle_worker_exit(
                "1",
                "build",
                WorkerResult::Success {
                    output: succeeded_step_output(),
                    approval_request: None,
                },
            ),
        )
        .await
        .expect("finalization should not deadlock on the state lock");

        let state = orchestrator.state.read().await;
        let finalize = state
            .get_finalize_state("1")
            .expect("finalize state should be retained while awaiting approval");
        assert_eq!(finalize.status, FinalizeStatus::PendingApproval);
        assert_eq!(finalize.repos[0].status, FinalizeStatus::PendingApproval);
        assert_eq!(
            state.artifacts["1"].repos[0].finalize_status,
            "pending_approval"
        );
        assert!(!state.is_running("1"));
        assert!(state.is_claimed("1"));

        drop(repo_temp);
    }

    #[tokio::test]
    async fn terminal_intent_persistence_retries_in_memory_without_holding_a_slot() {
        let config = Arc::new(RwLock::new(make_config()));
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
            state_writes: Arc::clone(&state_writes),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_temp = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(workspace_temp.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            workspace_temp.path(),
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

        tokio::fs::create_dir_all(workspace_temp.path().join("state"))
            .await
            .unwrap();
        tokio::fs::write(
            workspace_temp.path().join("state").join("pipeline-runs"),
            b"not a directory",
        )
        .await
        .unwrap();

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

        {
            let state = orchestrator.state.read().await;
            assert!(!state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert!(state.pending_terminal_transitions.contains_key("1"));
            assert!(!state.completed.contains_key("1"));
        }
        assert!(state_writes.read().await.is_empty());

        tokio::fs::remove_file(workspace_temp.path().join("state").join("pipeline-runs"))
            .await
            .unwrap();
        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_claimed("1"));
        assert!(state.pending_terminal_transitions.get("1").is_none());
        assert!(state.completed.contains_key("1"));
        drop(state);
        assert_eq!(
            state_writes.read().await.as_slice(),
            &[("1".to_string(), "Done".to_string())]
        );
    }

    #[tokio::test]
    async fn finalize_failure_remains_parked_for_operator_retry() {
        let (repo_temp, repo_config) = create_finalize_repo().await;
        let config = Arc::new(RwLock::new(make_config()));
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
            state_writes: Arc::clone(&state_writes),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_temp = tempfile::TempDir::new().unwrap();
        let workspace_mgr =
            WorkspaceManager::new(workspace_temp.path(), Some(vec![repo_config])).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            workspace_temp.path(),
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
        drop(repo_temp);

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
        let finalize = state.get_finalize_state("1").unwrap();
        assert_eq!(finalize.status, FinalizeStatus::Failed);
        assert!(finalize
            .repos
            .iter()
            .any(|repo| repo.status == FinalizeStatus::Failed));
        assert!(!state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        assert!(state.pending_terminal_transitions.get("1").is_none());
        assert!(!state.completed.contains_key("1"));
        drop(state);
        assert!(state_writes.read().await.is_empty());
    }

    #[test]
    fn finalization_attempt_rejects_missing_or_replaced_running_entry() {
        let config = make_config();
        let mut state = OrchestratorState::new(1_000, &config.concurrency);
        state.add_running(&test_issue("1", "Todo"), None);

        let attempt = RunningAttemptIdentity::capture(&state, "1").unwrap();
        assert!(attempt.is_current(&state, "1"));

        let mut replacement = state.remove_running("1").unwrap();
        assert!(!attempt.is_current(&state, "1"));

        let original_run_id = replacement.run_id.clone();
        replacement.started_at += chrono::Duration::seconds(1);
        state.running.insert("1".to_string(), replacement);
        assert_eq!(state.get_running("1").unwrap().run_id, original_run_id);
        assert!(!attempt.is_current(&state, "1"));
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

        let workspace = orchestrator.workspace_mgr.workspace_path("1");
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
    async fn retry_exhaustion_posts_one_terminal_rejection_comment() {
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

        for attempt in [None, Some(2)] {
            {
                let cfg = config.read().await;
                let mut state = orchestrator.state.write().await;
                state.add_running(&test_issue("1", "Todo"), attempt);
                let dag = build_dag(&cfg.steps).unwrap();
                let mut pipeline_run = PipelineRun::new("1".to_string(), attempt.unwrap_or(1), dag);
                pipeline_run.start();
                pipeline_run.mark_running("build", "session-1".to_string());
                state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            }

            let workspace = orchestrator.workspace_mgr.workspace_path("1");
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
        drop(comments);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert!(!records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::PipelineFailed));
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
    async fn test_orchestrator_does_not_retry_acpx_unsupported_model_failure() {
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

        let unsupported_model_error = "acpx command failed: sessions ensure — exit status: 1; stderr: ; stdout: {\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"Cannot apply --model \\\"opencode-go/kimi-k2.5\\\": the ACP agent did not advertise model support. Generic model selection requires ACP models plus session/set_model support, or an adapter-specific startup model flag.\",\"data\":{\"acpxCode\":\"RUNTIME\",\"origin\":\"cli\",\"sessionId\":\"unknown\"}}}".to_string();

        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Failed {
                    error: unsupported_model_error.clone(),
                    kind: WorkerFailureKind::Runtime,
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(state.completed.contains_key("1"));
        drop(state);

        let history_path = dir.path().join("ensemble_history.jsonl");
        let contents = tokio::fs::read_to_string(&history_path).await.unwrap();
        let record = contents
            .lines()
            .map(|line| serde_json::from_str::<crate::history::model::HistoryRecord>(line).unwrap())
            .next()
            .unwrap();
        assert_eq!(
            record.last_error.as_deref(),
            Some(unsupported_model_error.as_str())
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
        assert_eq!(
            state.get_pipeline_run("1").map(|run| run.cycle),
            Some(3),
            "whole-issue retry should install the fresh pipeline cycle"
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
                issue_id: "1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::PromptStarted,
                timestamp: Utc::now(),
            })
            .await;
        orchestrator
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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

        let retry_entry = crate::tracker::model::RetryEntry {
            issue_id: "gone".to_string(),
            identifier: "repo#gone".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };

        // Add a claimed retry with its durable owner record.
        {
            let mut state = orchestrator.state.write().await;
            state.add_retry(retry_entry.clone());
        }
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: retry_entry.issue_id.clone(),
                identifier: retry_entry.identifier.clone(),
                run_id: None,
                cycle: retry_entry.attempt,
                step: None,
                reason: retry_entry.error.clone(),
                retry: Some(retry_entry.clone()),
                snapshot: None,
                terminal_transition: None,
            })
            .await
            .unwrap();

        // Handle the retry
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

        let orchestrator = Orchestrator::new(
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
        while let Ok(event) = orchestrator.worker_rx.lock().await.try_recv() {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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

        let event = tokio::time::timeout(
            Duration::from_secs(2),
            recv_worker_event(&orchestrator.worker_rx),
        )
        .await
        .unwrap()
        .unwrap();
        orchestrator.handle_worker_event(event).await;
        assert!(crate::agent::cancellation::registry_is_empty(
            &orchestrator.cancellation_registry
        ));
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
    async fn restored_finalization_discards_stale_attempt_before_owned_writes() {
        let config = Arc::new(RwLock::new(make_config()));
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues: Arc::new(RwLock::new(vec![])),
            state_writes: Arc::clone(&state_writes),
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
            pipeline_run.step_completed("build", succeeded_step_output(), false);

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
        }

        let before_commit = Arc::new(tokio::sync::Barrier::new(2));
        let resume_commit = Arc::new(tokio::sync::Barrier::new(2));
        orchestrator.set_finalization_commit_test_barriers(
            Arc::clone(&before_commit),
            Arc::clone(&resume_commit),
        );
        let state = Arc::clone(&orchestrator.state);
        let journal_path = orchestrator.pipeline_journal.path_for_issue("1");
        let history_store = orchestrator.history_store.clone().unwrap();

        let dispatch = tokio::spawn(async move {
            orchestrator.dispatch_issue(&issue, None).await;
        });
        before_commit.wait().await;

        {
            let mut state = state.write().await;
            let mut replacement = state.remove_running("1").unwrap();
            replacement.started_at += chrono::Duration::seconds(1);
            state.running.insert("1".to_string(), replacement);
        }
        resume_commit.wait().await;
        dispatch.await.unwrap();

        let state = state.read().await;
        assert!(state.is_running("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.completed.contains_key("1"));
        assert!(state.get_finalize_state("1").is_none());
        assert!(state_writes.read().await.is_empty());
        assert!(!journal_path.exists());
        assert_eq!(
            history_store
                .read_history(&crate::history::reader::HistoryQuery::default())
                .await
                .unwrap()
                .total,
            0
        );
    }

    #[tokio::test]
    async fn restored_pending_approval_finalization_releases_running_slot() {
        let (repo_temp, repo_config) = create_finalize_repo().await;
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
        let workspace_temp = tempfile::TempDir::new().unwrap();
        let workspace_mgr =
            WorkspaceManager::new(workspace_temp.path(), Some(vec![repo_config])).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            workspace_temp.path(),
            shutdown_rx,
        );
        let issue = test_issue("1", "Todo");

        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());
            pipeline_run.step_completed("build", succeeded_step_output(), false);

            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
            state.artifacts.insert(
                "1".to_string(),
                RunArtifacts {
                    run_id: "run-1".to_string(),
                    workspace_path: workspace_temp.path().display().to_string(),
                    repos: vec![crate::history::artifacts::RepoArtifact {
                        repo: "source-repo".to_string(),
                        finalize_status: "pending".to_string(),
                        ..Default::default()
                    }],
                    transcripts: vec![],
                },
            );
        }

        orchestrator.dispatch_issue(&issue, None).await;

        let state = orchestrator.state.read().await;
        let finalize = state.get_finalize_state("1").unwrap();
        assert_eq!(finalize.status, FinalizeStatus::PendingApproval);
        assert!(!state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        assert_eq!(
            state.artifacts["1"].repos[0].finalize_status,
            "pending_approval"
        );

        drop(repo_temp);
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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
    async fn exhausted_acceptance_failure_retires_the_resolved_approval_interaction() {
        let config_dir = tempfile::TempDir::new().unwrap();
        let issue = test_issue("1", "Todo");
        let mut config = make_single_step_always_approval_config(1);
        config.acceptance.commands = vec![crate::config::ensemble::AcceptanceCommandConfig {
            name: "test".to_string(),
            run: "run-test".to_string(),
            timeout_ms: 1_000,
        }];
        let config = Arc::new(RwLock::new(config));
        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWriteTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
        });
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let acceptance_runner = Arc::new(RecordingAcceptanceRunner {
            statuses: std::sync::Mutex::new([AcceptanceStatus::Failed].into()),
            calls: Arc::clone(&calls),
        });
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            config.read().await.polling.interval_ms,
            &config.read().await.concurrency,
        )));
        let workspace_root = config_dir.path().join("workspaces");
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new_with_state(
            OrchestratorRuntimeParts {
                state,
                config: Arc::clone(&config),
                tracker,
                agent_runner: Arc::new(MockRunner {
                    delay_ms: 0,
                    observed_commands: None,
                    observed_timeouts: None,
                    cancellation_probe: None,
                }),
                acceptance_runner,
                workspace_mgr: WorkspaceManager::new(&workspace_root, None).unwrap(),
                refresh_requested: Arc::new(tokio::sync::Notify::new()),
                cancellation_registry: new_cancellation_registry(),
                event_bus: EventBus::new(),
                transcript_event_bus: TranscriptEventBus::new(),
                workspace_root,
            },
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;
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

        orchestrator.resume_blocked_issue(&issue).await.unwrap();

        assert_eq!(
            *calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["test"]
        );
        assert!(
            !orchestrator
                .interaction_store
                .get("approval-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn approval_fanout_failure_retires_wait_after_first_continuation_starts() {
        let config = Arc::new(RwLock::new(
            parse_config(
                r#"
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
      mode: always
      state: Plan Review
  - name: review
    agent: builder
    depends: ["build"]
  - name: docs
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
  command: "echo test"
  session_mode: code
"#,
            )
            .unwrap(),
        ));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
        let observed_commands = Arc::new(RwLock::new(Vec::new()));
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 1_000,
            observed_commands: Some(Arc::clone(&observed_commands)),
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let config_dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let mut orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;
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
        orchestrator.interaction_store.fail_next_writes(1);
        let retirement_error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("approval interaction retirement must precede worker launch");
        assert!(
            retirement_error
                .to_string()
                .contains("injected interaction write failure"),
            "{retirement_error}"
        );
        assert!(observed_commands.read().await.is_empty());
        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
        assert!(matches!(
            state
                .get_pipeline_run("1")
                .unwrap()
                .step_states
                .get("build"),
            Some(StepState::AwaitingApproval { .. })
        ));
        drop(state);
        assert!(
            orchestrator
                .interaction_store
                .get("approval-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        assert_eq!(
            orchestrator
                .pipeline_journal
                .latest_live_record_for_issue("1")
                .await
                .unwrap()
                .unwrap()
                .kind,
            PipelineTransitionKind::StepAwaitingApproval
        );

        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 2));

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("the second fan-out dispatch should fail before journal append");
        assert!(
            error.to_string().contains("failed to persist step"),
            "{error}"
        );
        tokio::task::yield_now().await;

        assert_eq!(observed_commands.read().await.len(), 1);
        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_resume_requested("1"));
        let run = state.get_pipeline_run("1").unwrap();
        assert_eq!(run.step_states.get("build"), Some(&StepState::Passed));
        assert!(matches!(
            run.step_states.get("review"),
            Some(StepState::Running { .. })
        ));
        assert_eq!(run.step_states.get("docs"), Some(&StepState::Pending));
        drop(state);
        assert!(
            !orchestrator
                .interaction_store
                .get("approval-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        let rollback_seq = records
            .iter()
            .rev()
            .find(|record| record.kind == PipelineTransitionKind::StepAwaitingApproval)
            .unwrap()
            .seq;
        assert_eq!(
            records
                .iter()
                .filter(|record| {
                    record.seq > rollback_seq && record.kind == PipelineTransitionKind::StepRunning
                })
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn approval_resume_workspace_failure_restores_the_waiting_owner() {
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
        let workspace_root = config_dir.path().join("workspaces");
        let workspace_mgr = WorkspaceManager::new(&workspace_root, None).unwrap();
        let blocked_workspace = workspace_mgr.workspace_path("1");
        tokio::fs::create_dir_all(&workspace_root).await.unwrap();
        tokio::fs::write(&blocked_workspace, b"not a directory")
            .await
            .unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;
        let previous_run = orchestrator
            .state
            .read()
            .await
            .get_pipeline_run("1")
            .unwrap()
            .to_snapshot();

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

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("workspace failure must retain the approval owner");
        assert!(error.to_string().contains("workspace error"), "{error}");

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
        assert!(state.is_claimed("1"));
        assert_eq!(
            state.get_pipeline_run("1").unwrap().to_snapshot(),
            previous_run
        );
        drop(state);
        assert!(
            orchestrator
                .interaction_store
                .get("approval-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn terminal_tracker_transition_success_releases_failed_run_once() {
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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
        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        let kinds = records.iter().map(|record| record.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == PipelineTransitionKind::Released)
                .count(),
            1
        );
        assert!(
            kinds
                .iter()
                .position(|kind| *kind == PipelineTransitionKind::PendingTerminalTransition)
                < kinds
                    .iter()
                    .position(|kind| *kind == PipelineTransitionKind::Released)
        );
    }

    #[tokio::test]
    async fn terminal_tracker_transition_failure_retains_recoverable_failed_run() {
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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

        orchestrator.state.write().await.artifacts.insert(
            "1".to_string(),
            RunArtifacts {
                run_id: "run-1".to_string(),
                workspace_path: config_dir.path().display().to_string(),
                repos: vec![],
                transcripts: vec![],
            },
        );

        orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect("rejected approval gate should become pending reconciliation");

        let state = orchestrator.state.read().await;
        assert!(!state.completed.contains_key("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(state.artifacts.contains_key("1"));
        let pending = state.pending_terminal_transitions.get("1").unwrap();
        assert_eq!(pending.transition.target_state, "Failed");
        assert_eq!(pending.transition.outcome, TerminalOutcome::Failed);
        assert_eq!(pending.transition.attempt, 1);
        assert!(pending.transition.last_error.is_some());
        assert!(pending
            .transition
            .history_record
            .as_ref()
            .and_then(|record| record.artifacts.as_ref())
            .is_some());
        drop(state);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert_eq!(
            records.last().map(|record| record.kind),
            Some(PipelineTransitionKind::PendingTerminalTransition)
        );
        assert!(!records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::PipelineFailed));
        assert!(!records
            .iter()
            .any(|record| record.kind == PipelineTransitionKind::Released));
    }

    #[tokio::test]
    async fn pending_terminal_transition_retries_after_restart_without_rerunning_work() {
        let config_dir = tempfile::TempDir::new().unwrap();
        let original_config = make_config();
        let original_agent = original_config.steps[0].agent.clone();
        let mut current_config = original_config.clone();
        current_config.steps[0].agent = "replacement-agent".to_string();
        let config = Arc::new(RwLock::new(current_config));
        let issue = test_issue("1", "Todo");
        let failures_remaining = Arc::new(RwLock::new(1));
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(ControllableWriteTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
            failures_remaining: Arc::clone(&failures_remaining),
            state_writes: Arc::clone(&state_writes),
        });
        let agent_runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::clone(&agent_runs),
        });
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        let dag = build_dag(&original_config.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "finished-session".to_string());
        assert_eq!(
            run.step_completed("build", succeeded_step_output(), false),
            PipelineAction::Succeeded
        );
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PendingTerminalTransition,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: Some(PendingTerminalTransition {
                    target_state: "Done".to_string(),
                    outcome: TerminalOutcome::Succeeded,
                    attempt: 0,
                    last_error: None,
                    last_attempted_at: None,
                    tracker_write_confirmed: false,
                    history_record: None,
                }),
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        {
            let state = orchestrator.state.read().await;
            assert!(state.is_claimed("1"));
            assert!(!state.is_running("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert_eq!(
                state
                    .pending_terminal_transitions
                    .get("1")
                    .map(|pending| pending.transition.attempt),
                Some(1)
            );
            assert!(!state.completed.contains_key("1"));
        }
        assert_eq!(agent_runs.load(std::sync::atomic::Ordering::SeqCst), 0);

        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_claimed("1"));
        assert!(state.pending_terminal_transitions.get("1").is_none());
        assert!(state.get_pipeline_run("1").is_none());
        let completed = state.completed.get("1").unwrap();
        assert_eq!(completed.workflow_steps.len(), 1);
        assert_eq!(completed.workflow_steps[0].agent, original_agent);
        drop(state);
        assert_eq!(
            state_writes.read().await.as_slice(),
            &[
                ("1".to_string(), "Done".to_string()),
                ("1".to_string(), "Done".to_string()),
            ]
        );
        assert_eq!(agent_runs.load(std::sync::atomic::Ordering::SeqCst), 0);

        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| record.kind == PipelineTransitionKind::Released)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn reconstructed_terminal_transition_preserves_run_id_for_history_upsert() {
        let config_dir = tempfile::TempDir::new().unwrap();
        let config = Arc::new(RwLock::new(make_config()));
        let issue = test_issue("1", "Todo");
        let tracker: Arc<dyn IssueTracker> = Arc::new(RecordingTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
            state_writes: Arc::new(RwLock::new(Vec::new())),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        });
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "finished-session".to_string());
        assert_eq!(
            run.step_completed("build", succeeded_step_output(), false),
            PipelineAction::Succeeded
        );
        drop(cfg);
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineSucceeded,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: None,
            })
            .await
            .unwrap();

        let now = Utc::now();
        let history_record = HistoryRecord {
            issue_identifier: issue.identifier.clone(),
            issue_id: issue.id.clone(),
            outcome: HISTORY_OUTCOME_SUCCEEDED.to_string(),
            steps_traversed: vec!["build".to_string()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
            duration_seconds: 0,
            started_at: now,
            completed_at: now,
            last_error: None,
            verdict: Some(HISTORY_VERDICT_APPROVED.to_string()),
            workspace_path: config_dir.path().display().to_string(),
            acceptance_attempts: vec![],
            artifacts: None,
        };
        let history_store = orchestrator.history_store.as_ref().unwrap();
        let mut stale_record = history_record.clone();
        stale_record.outcome = HISTORY_OUTCOME_FAILED.to_string();
        history_store
            .append_history_record("run-1", &stale_record)
            .await
            .unwrap();

        orchestrator
            .begin_terminal_transition_for_identity(
                &issue.id,
                &issue.identifier,
                Some(issue.clone()),
                TerminalOutcome::Succeeded,
                "Done".to_string(),
                Some(history_record),
            )
            .await;

        let response = history_store
            .read_history(&crate::history::reader::HistoryQuery::default())
            .await
            .unwrap();
        assert_eq!(response.total, 1);
        assert_eq!(response.records[0].outcome, HISTORY_OUTCOME_SUCCEEDED);
    }

    #[tokio::test]
    async fn confirmed_terminal_transition_recovers_history_before_release_without_duplicates() {
        let config_dir = tempfile::TempDir::new().unwrap();
        let config = Arc::new(RwLock::new(make_config()));
        let issue = test_issue("1", "Done");
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(ControllableWriteTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
            failures_remaining: Arc::new(RwLock::new(0)),
            state_writes: Arc::clone(&state_writes),
        });
        let agent_runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::clone(&agent_runs),
        });
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
        run.start();
        run.mark_running("build", "finished-session".to_string());
        assert_eq!(
            run.step_completed("build", succeeded_step_output(), false),
            PipelineAction::Succeeded
        );
        drop(cfg);

        let now = Utc::now();
        let history_record = HistoryRecord {
            issue_identifier: issue.identifier.clone(),
            issue_id: issue.id.clone(),
            outcome: HISTORY_OUTCOME_SUCCEEDED.to_string(),
            steps_traversed: vec!["build".to_string()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
            duration_seconds: 0,
            started_at: now,
            completed_at: now,
            last_error: None,
            verdict: Some(HISTORY_VERDICT_APPROVED.to_string()),
            workspace_path: config_dir.path().display().to_string(),
            acceptance_attempts: vec![],
            artifacts: None,
        };
        HistoryWriter::new(config_dir.path().join("ensemble_history.jsonl"))
            .append(&history_record)
            .await
            .unwrap();

        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::TerminalTransitionApplied,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(run.to_snapshot()),
                terminal_transition: Some(PendingTerminalTransition {
                    target_state: "Done".to_string(),
                    outcome: TerminalOutcome::Succeeded,
                    attempt: 0,
                    last_error: None,
                    last_attempted_at: None,
                    tracker_write_confirmed: true,
                    history_record: Some(history_record),
                }),
            })
            .await
            .unwrap();

        orchestrator.handle_tick().await;

        assert!(orchestrator.state.read().await.completed.contains_key("1"));
        assert!(state_writes.read().await.is_empty());
        assert_eq!(agent_runs.load(std::sync::atomic::Ordering::SeqCst), 0);
        let contents = tokio::fs::read_to_string(config_dir.path().join("ensemble_history.jsonl"))
            .await
            .unwrap();
        assert_eq!(contents.lines().count(), 1);
        let records = orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| record.kind == PipelineTransitionKind::Released)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn staged_finalization_outcome_recovers_without_rerunning_finalization() {
        let config_dir = tempfile::TempDir::new().unwrap();
        let config = Arc::new(RwLock::new(make_config()));
        let issue = test_issue("1", "Todo");
        let state_writes = Arc::new(RwLock::new(Vec::new()));
        let failures_remaining = Arc::new(RwLock::new(1));
        let tracker: Arc<dyn IssueTracker> = Arc::new(ControllableWriteTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
            failures_remaining,
            state_writes: Arc::clone(&state_writes),
        });
        let runner_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        {
            let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
                runs: Arc::clone(&runner_calls),
            });
            let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
            let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
            let orchestrator = Orchestrator::new(
                Arc::clone(&config),
                Arc::clone(&tracker),
                runner,
                workspace_mgr,
                config_dir.path(),
                shutdown_rx,
            );

            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
            run.start();
            run.mark_running("build", "finished-session".to_string());
            assert_eq!(
                run.step_completed("build", succeeded_step_output(), false),
                PipelineAction::Succeeded
            );
            {
                let mut state = orchestrator.state.write().await;
                state.add_running(&issue, None);
                state.insert_pipeline_run(&issue.id, run, Arc::new(cfg.clone()));
            }
            let finalize_state = orchestrator
                .finalize_and_stage_terminal_transition(&issue.id, &issue.identifier, &cfg)
                .await;
            assert_eq!(finalize_state.status, FinalizeStatus::NotRequired);
            assert_eq!(
                orchestrator
                    .finalization_run_count
                    .load(std::sync::atomic::Ordering::SeqCst),
                1
            );
            orchestrator
                .begin_terminal_transition(
                    &issue,
                    TerminalOutcome::Succeeded,
                    cfg.on_success.clone(),
                    None,
                )
                .await;
            assert!(orchestrator
                .state
                .read()
                .await
                .pending_terminal_transitions
                .get(&issue.id)
                .and_then(|pending| pending.transition.history_record.as_ref())
                .is_some());
        }

        let runner: Arc<dyn AgentRunner> = Arc::new(CountingRunner {
            runs: Arc::clone(&runner_calls),
        });
        let workspace_mgr = WorkspaceManager::new(config_dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let recovered = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            config_dir.path(),
            shutdown_rx,
        );

        recovered.handle_tick().await;

        assert_eq!(
            recovered
                .finalization_run_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(runner_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            state_writes.read().await.as_slice(),
            &[
                ("1".to_string(), "Done".to_string()),
                ("1".to_string(), "Done".to_string()),
            ]
        );
        assert!(recovered.state.read().await.completed.contains_key("1"));
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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        install_approval_waiting_run(&orchestrator, &config, "approval-1").await;

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
    async fn restored_interaction_does_not_resume_when_quiescing() {
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

        orchestrator.quiescing.request();
        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("quiescing runtime must reject interaction continuation");
        assert!(matches!(error, EnsembleError::RuntimeBusy));

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        drop(state);
        assert!(
            store
                .get(&interaction_id)
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restored_interaction_does_not_dispatch_when_running_journal_write_fails() {
        use std::os::unix::fs::PermissionsExt;

        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
        let mut orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        let issue = test_issue("1", "Todo");

        let snapshot = {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut run = PipelineRun::new(issue.id.clone(), 1, dag);
            run.start();
            run.step_blocked_on_human("build", "interaction-1".to_string());
            let snapshot = run.to_snapshot();
            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run(&issue.id, run, Arc::new(cfg.clone()));
            state.add_claimed(&issue.id);
            state.add_waiting_on_human(WaitingOnHumanEntry {
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
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
                run_id: Some("run-1".to_string()),
                issue: Some(issue.clone()),
            });
            snapshot
        };

        orchestrator
            .interaction_store
            .create(InteractionRequest {
                id: "interaction-1".to_string(),
                schema_version: 1,
                issue_id: issue.id.clone(),
                issue_identifier: issue.identifier.clone(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Resolved,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "Need input".to_string(),
                body: "Choose environment".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
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
                ignored_commands: Vec::new(),
            })
            .await
            .unwrap();
        orchestrator
            .pipeline_journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineHalted,
                issue_id: issue.id.clone(),
                identifier: issue.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("waiting for input".to_string()),
                retry: None,
                snapshot: Some(snapshot.clone()),
                terminal_transition: None,
            })
            .await
            .unwrap();
        let journal_path = orchestrator.pipeline_journal.path_for_issue(&issue.id);
        std::fs::set_permissions(&journal_path, std::fs::Permissions::from_mode(0o444)).unwrap();

        let error = orchestrator
            .resume_blocked_issue(&issue)
            .await
            .expect_err("a missing running transition must prevent worker dispatch");

        std::fs::set_permissions(&journal_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            error.to_string().contains("failed to persist step"),
            "{error}"
        );
        assert!(observed_commands.read().await.is_empty());
        let state = orchestrator.state.read().await;
        assert!(!state.is_running(&issue.id));
        assert!(state.is_waiting_on_human(&issue.id));
        assert!(state.is_claimed(&issue.id));
        assert_eq!(
            state.get_pipeline_run(&issue.id).unwrap().to_snapshot(),
            snapshot
        );
        drop(state);
        assert!(
            orchestrator
                .interaction_store
                .get("interaction-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );

        orchestrator.interaction_store.fail_next_writes(1);
        let retirement_error = orchestrator
            .resume_blocked_issue(&issue)
            .await
            .expect_err("interaction retirement failure must prevent worker launch");
        assert!(
            retirement_error
                .to_string()
                .contains("injected interaction write failure"),
            "{retirement_error}"
        );
        assert!(observed_commands.read().await.is_empty());
        let state = orchestrator.state.read().await;
        assert!(!state.is_running(&issue.id));
        assert!(state.is_waiting_on_human(&issue.id));
        assert_eq!(
            state.get_pipeline_run(&issue.id).unwrap().to_snapshot(),
            snapshot
        );
        drop(state);
        assert!(
            orchestrator
                .interaction_store
                .get("interaction-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        assert_eq!(
            orchestrator
                .pipeline_journal
                .latest_live_record_for_issue(&issue.id)
                .await
                .unwrap()
                .unwrap()
                .kind,
            PipelineTransitionKind::StepBlockedOnHuman
        );

        orchestrator.pipeline_journal.transaction_append_late_error = true;
        orchestrator
            .resume_blocked_issue(&issue)
            .await
            .expect("an exact visible running record makes a late append error successful");
        tokio::task::yield_now().await;

        assert_eq!(observed_commands.read().await.len(), 1);
        let state = orchestrator.state.read().await;
        assert!(state.is_running(&issue.id));
        assert!(!state.is_waiting_on_human(&issue.id));
        assert!(!state.is_resume_requested(&issue.id));
        drop(state);
        assert!(
            !orchestrator
                .interaction_store
                .get("interaction-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn initial_dispatch_persistence_failure_schedules_recoverable_retry() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
        let mut orchestrator = Orchestrator::new(
            Arc::clone(&config),
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );
        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 2));
        let issue = test_issue("1", "Todo");

        orchestrator.dispatch_issue(&issue, None).await;

        assert!(observed_commands.read().await.is_empty());
        let state = orchestrator.state.read().await;
        assert!(!state.is_running(&issue.id));
        assert!(state.retry_attempts.contains_key(&issue.id));
        drop(state);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .expect("the retry must remain restart-visible");
        assert_eq!(latest.kind, PipelineTransitionKind::StepRetryScheduled);
    }

    #[tokio::test]
    async fn restored_pipeline_dispatch_persistence_failure_schedules_recoverable_retry() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![])),
        });
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
        let mut orchestrator = Orchestrator::new(
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
            let run = PipelineRun::new(issue.id.clone(), 1, dag);
            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run(&issue.id, run, Arc::new(cfg.clone()));
            state.add_claimed(&issue.id);
        }
        orchestrator
            .pipeline_journal
            .transaction_append_error_on_call = Some((Arc::new(AtomicUsize::new(0)), 1));

        orchestrator.dispatch_issue(&issue, None).await;

        assert!(observed_commands.read().await.is_empty());
        let state = orchestrator.state.read().await;
        assert!(!state.is_running(&issue.id));
        assert!(state.retry_attempts.contains_key(&issue.id));
        drop(state);
        let latest = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue(&issue.id)
            .await
            .unwrap()
            .expect("the retry must remain restart-visible");
        assert_eq!(latest.kind, PipelineTransitionKind::StepRetryScheduled);
    }

    #[tokio::test]
    async fn restored_interaction_refresh_failure_and_missing_result_retain_owner() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(Vec::new()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWorkflowStateTracker {
            issues: Arc::clone(&issues),
            id_fetch_failures_remaining: AtomicUsize::new(1),
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

        {
            let state = orchestrator.state.read().await;
            assert!(!state.is_running("1"));
            assert!(state.is_waiting_on_human("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert!(state.is_resume_requested("1"));
        }
        assert!(
            store
                .get(&interaction_id)
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );

        orchestrator.handle_tick().await;
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_waiting_on_human("1"));
            assert!(state.is_claimed("1"));
            assert!(state.is_resume_requested("1"));
        }

        issues.write().await.push(test_issue("1", "Todo"));
        orchestrator.handle_tick().await;

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_resume_requested("1"));
    }

    #[tokio::test]
    async fn interaction_thread_command_audits_valid_reply_after_resume() {
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
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker {
            issues,
            comments: Arc::clone(&comments),
            list_barrier: None,
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
        let interaction = crate::interaction::InteractionRequest {
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
        };
        let root_comment = format_interaction_thread_root_comment(&interaction);
        assert!(root_comment.contains(
            "```text\n/answer <text>\n\n<!-- ensemble:interaction:interaction-1 -->\n```"
        ));
        assert!(!root_comment.contains("```text\n/approve"));
        let mut approval = interaction.clone();
        approval.kind = InteractionKind::Approval;
        let approval_root = format_interaction_thread_root_comment(&approval);
        assert!(approval_root.contains("```text\n/approve\n\n"));
        assert!(approval_root.contains("```text\n/reject <reason>\n\n"));
        assert!(!approval_root.contains("```text\n/answer <text>\n\n"));
        let mut handoff = interaction.clone();
        handoff.kind = InteractionKind::Handoff;
        let handoff_root = format_interaction_thread_root_comment(&handoff);
        assert!(handoff_root.contains("```text\n/approve\n\n"));
        assert!(handoff_root.contains("```text\n/reject <reason>\n\n"));
        assert!(handoff_root.contains("```text\n/answer <text>\n\n"));
        store.create(interaction).await.unwrap();

        orchestrator.handle_tick().await;

        let interaction = store.get("interaction-1").await.unwrap().unwrap();
        assert_eq!(interaction.status, InteractionStatus::Resolved);
        assert!(interaction.accepted_command.is_some());
        assert!(matches!(
            interaction.response,
            Some(InteractionResponse::Question { .. })
        ));

        orchestrator.process_interaction_thread_commands().await;
        let replayed = store.get("interaction-1").await.unwrap().unwrap();
        assert!(replayed.ignored_commands.is_empty());
        assert_eq!(
            replayed.accepted_command.as_ref().unwrap().comment_id,
            "c-1"
        );

        {
            let mut state = orchestrator.state.write().await;
            state.remove_waiting_on_human("1");
            state.clear_resume_request("1");
            assert!(!state.is_resume_requested("1"));
        }
        let resumed = store.mark_resumed("interaction-1").await.unwrap();
        assert!(!resumed.awaiting_resume);
        comments
            .write()
            .await
            .push(crate::tracker::model::TrackerComment {
                comment_id: "c-2".to_string(),
                body: "/answer use production\n\n<!-- ensemble:interaction:interaction-1 -->"
                    .to_string(),
                author: "bob".to_string(),
                created_at: Some(comment_ts),
                updated_at: Some(comment_ts),
            });

        orchestrator.process_interaction_thread_commands().await;

        let audited = store.get("interaction-1").await.unwrap().unwrap();
        assert_eq!(audited.ignored_commands.len(), 1);
        assert_eq!(audited.ignored_commands[0].comment_id, "c-2");
        assert_eq!(
            audited.ignored_commands[0].reason,
            "interaction_already_resolved"
        );
        assert_eq!(audited.last_processed_comment_id.as_deref(), Some("c-2"));
        assert!(!orchestrator.state.read().await.is_resume_requested("1"));
    }

    #[tokio::test]
    async fn interaction_thread_command_retries_when_acceptance_and_audit_writes_fail() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let comment_ts = Utc::now();
        let comments = Arc::new(RwLock::new(vec![crate::tracker::model::TrackerComment {
            comment_id: "c-retry".to_string(),
            body: "/answer use staging\n\n<!-- ensemble:interaction:interaction-retry -->"
                .to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker {
            issues,
            comments,
            list_barrier: None,
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
            let mut state = orchestrator.state.write().await;
            let cfg = config.read().await;
            state.init_state_lists(&cfg);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-retry".to_string(),
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

        let store = orchestrator.interaction_store.clone();
        store
            .create(crate::interaction::InteractionRequest {
                id: "interaction-retry".to_string(),
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
                thread_root_comment_id: Some("root-retry".to_string()),
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
            })
            .await
            .unwrap();

        store.fail_next_writes(2);
        orchestrator.process_interaction_thread_commands().await;

        let failed = store.get("interaction-retry").await.unwrap().unwrap();
        assert_eq!(failed.status, InteractionStatus::Open);
        assert!(failed.accepted_command.is_none());
        assert!(failed.ignored_commands.is_empty());
        assert_eq!(failed.last_processed_comment_id, None);

        orchestrator.process_interaction_thread_commands().await;

        let retried = store.get("interaction-retry").await.unwrap().unwrap();
        assert_eq!(retried.status, InteractionStatus::Resolved);
        assert_eq!(
            retried.accepted_command.as_ref().unwrap().comment_id,
            "c-retry"
        );
        assert_eq!(
            retried.last_processed_comment_id.as_deref(),
            Some("c-retry")
        );
    }

    #[tokio::test]
    async fn interaction_thread_command_races_api_atomically_across_stores() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let comment_ts = Utc::now();
        let comments = Arc::new(RwLock::new(vec![crate::tracker::model::TrackerComment {
            comment_id: "tracker-c1".to_string(),
            body: "/answer use staging\n\n<!-- ensemble:interaction:interaction-race -->"
                .to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }]));
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker {
            issues,
            comments: Arc::clone(&comments),
            list_barrier: Some(Arc::clone(&barrier)),
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
            let mut state = orchestrator.state.write().await;
            let cfg = config.read().await;
            state.init_state_lists(&cfg);
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "1".to_string(),
                identifier: "repo#1".to_string(),
                interaction_request_id: "interaction-race".to_string(),
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
                id: "interaction-race".to_string(),
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

        let api_store = InteractionStore::new(dir.path().to_path_buf());
        let api_attempt = async {
            barrier.wait().await;
            api_store
                .accept_response(
                    "interaction-race",
                    AcceptedInteractionCommand {
                        command: "/answer".to_string(),
                        raw_body: r#"{"kind":"question","text":"production"}"#.to_string(),
                        author: "local-api".to_string(),
                        comment_id: "local-api-1".to_string(),
                        received_at: Utc::now(),
                    },
                    InteractionResponse::Question {
                        response_schema_version: 1,
                        text: "production".to_string(),
                        selected_option: None,
                    },
                )
                .await
                .unwrap()
        };
        let (_, api_outcome) = tokio::join!(
            orchestrator.process_interaction_thread_commands(),
            api_attempt
        );

        let interaction = store.get("interaction-race").await.unwrap().unwrap();
        assert_eq!(interaction.status, InteractionStatus::Resolved);
        assert_eq!(interaction.ignored_commands.len(), 1);
        assert_eq!(
            interaction.ignored_commands[0].reason,
            "interaction_already_resolved"
        );
        let tracker_won = interaction.accepted_command.as_ref().unwrap().author == "alice";
        assert_eq!(
            tracker_won,
            matches!(api_outcome, InteractionAcceptance::Ignored(_))
        );
        assert_eq!(
            orchestrator.state.read().await.is_resume_requested("1"),
            tracker_won
        );

        let mut cancelled_interaction = interaction.clone();
        cancelled_interaction.id = "interaction-cancel-race".to_string();
        cancelled_interaction.issue_id = "2".to_string();
        cancelled_interaction.issue_identifier = "repo#2".to_string();
        cancelled_interaction.status = InteractionStatus::Open;
        cancelled_interaction.awaiting_resume = true;
        cancelled_interaction.thread_root_comment_id = Some("root-2".to_string());
        cancelled_interaction.last_processed_comment_id = None;
        cancelled_interaction.accepted_command = None;
        cancelled_interaction.ignored_commands.clear();
        cancelled_interaction.response = None;
        cancelled_interaction.resolved_at = None;
        tokio::fs::remove_file(store.interactions_dir().join("interaction-race.json"))
            .await
            .unwrap();
        store.create(cancelled_interaction).await.unwrap();
        {
            let mut state = orchestrator.state.write().await;
            state.remove_waiting_on_human("1");
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: "2".to_string(),
                identifier: "repo#2".to_string(),
                interaction_request_id: "interaction-cancel-race".to_string(),
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
        *comments.write().await = vec![crate::tracker::model::TrackerComment {
            comment_id: "tracker-cancel-c1".to_string(),
            body: "/answer use staging\n\n<!-- ensemble:interaction:interaction-cancel-race -->"
                .to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }];

        let cancel_store = InteractionStore::new(dir.path().to_path_buf());
        let cancel_attempt = async {
            let cancelled = cancel_store.cancel("interaction-cancel-race").await;
            barrier.wait().await;
            cancelled
        };
        let (cancelled, _) = tokio::join!(
            cancel_attempt,
            orchestrator.process_interaction_thread_commands()
        );
        assert_eq!(cancelled.unwrap().status, InteractionStatus::Cancelled);

        let cancelled = store.get("interaction-cancel-race").await.unwrap().unwrap();
        assert_eq!(cancelled.status, InteractionStatus::Cancelled);
        assert!(cancelled.accepted_command.is_none());
        assert_eq!(cancelled.ignored_commands.len(), 1);
        assert_eq!(
            cancelled.ignored_commands[0].reason,
            "interaction_already_cancelled"
        );
        assert!(!orchestrator.state.read().await.is_resume_requested("2"));
    }

    #[tokio::test]
    async fn interaction_thread_command_with_mismatched_marker_is_ignored() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let comment_ts = Utc::now();
        let comments = Arc::new(RwLock::new(vec![crate::tracker::model::TrackerComment {
            comment_id: "c-2".to_string(),
            body: "/answer use staging\n\n<!-- ensemble:interaction:other-id -->".to_string(),
            author: "alice".to_string(),
            created_at: Some(comment_ts),
            updated_at: Some(comment_ts),
        }]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(CommandMockTracker {
            issues,
            comments,
            list_barrier: None,
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
    async fn resume_without_restored_pipeline_state_retains_the_durable_owner() {
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

        let error = orchestrator
            .resume_blocked_issue(&test_issue("1", "Todo"))
            .await
            .expect_err("resume must fail closed without a journal-restored run");
        assert!(
            error
                .to_string()
                .contains("missing its restored blocked pipeline run"),
            "{error}"
        );

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_waiting_on_human("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);
        let interaction = store.get("interaction-1").await.unwrap().unwrap();
        assert!(interaction.awaiting_resume);
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
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut run = PipelineRun::new("1".to_string(), 1, dag);
            run.start();
            run.step_states
                .insert("build".to_string(), StepState::Passed);
            run.step_blocked_on_human("review", "interaction-1".to_string());
            let mut state = orchestrator.state.write().await;
            state.insert_pipeline_run("1", run, Arc::new(cfg.clone()));
            state.add_claimed("1");
        }

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
    async fn restored_interaction_context_failure_retains_owner() {
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
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        drop(state);
        assert!(
            store
                .get("interaction-1")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
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
        workspace_mgr
            .prepare_workspace("1", "repo#1")
            .await
            .unwrap();
        let workspace_path = workspace_mgr.workspace_path("1");
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
        assert!(!workspace_path.exists());
    }

    #[tokio::test]
    async fn workspace_identity_lifecycle_active_cleanup_refuses_mismatched_owner() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Done")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let workspace_path = workspace_mgr.workspace_path("1");
        std::fs::create_dir_all(&workspace_path).unwrap();
        std::fs::write(
            workspace_path.join(".ensemble-workspace.json"),
            r#"{"issue_id":"other","issue_identifier":"other#7","branch_date":"2024-01-01"}"#,
        )
        .unwrap();
        let sentinel = workspace_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();
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
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
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

        let record = orchestrator.build_history_record(RunningHistoryRecordInput {
            outcome: "succeeded",
            last_error: None,
            running_entry: &entry,
            run: &run,
            completed_at: Utc::now(),
            artifacts: None,
        });

        assert_eq!(
            record.steps_traversed,
            vec!["z-build".to_string(), "a-review".to_string()]
        );
    }

    #[tokio::test]
    async fn workspace_identity_path_history_and_artifacts_use_canonical_owner() {
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
        let workspace_path = orchestrator
            .workspace_mgr
            .workspace_path("1")
            .display()
            .to_string();

        let cfg = config.read().await;
        let dag = build_dag(&cfg.steps).unwrap();
        let mut run = PipelineRun::new("1".to_string(), 1, dag);
        run.step_states.insert(
            "build".to_string(),
            crate::pipeline::engine::StepState::Passed,
        );
        let artifacts = RunArtifacts {
            run_id: "run-1".to_string(),
            workspace_path: workspace_path.clone(),
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

        let record = orchestrator.build_history_record(RunningHistoryRecordInput {
            outcome: "succeeded",
            last_error: None,
            running_entry: &entry,
            run: &run,
            completed_at: Utc::now(),
            artifacts: Some(artifacts.clone()),
        });

        assert_eq!(record.workspace_path, workspace_path);
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
        workspace_mgr
            .prepare_workspace("1", "repo#1")
            .await
            .unwrap();
        let workspace_path = workspace_mgr.workspace_path("1");
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
        assert!(workspace_path.exists());
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
        assert!(orchestrator.history_store.is_none());
        assert!(orchestrator.timeline_persistence.is_none());
    }

    #[tokio::test]
    async fn published_timeline_event_is_visible_through_timeline_api() {
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

        for (sequence, issue_identifier, detail) in [
            (2, "repo#1", "second"),
            (1, "repo#1", "first"),
            (1, "repo#1", "duplicate"),
            (3, "repo#other", "other issue"),
        ] {
            orchestrator
                .publish_pipeline_event(
                    Some("run-1".into()),
                    Some(sequence),
                    3,
                    PipelineEvent::Output {
                        issue_identifier: issue_identifier.into(),
                        timestamp: Utc::now(),
                        step_name: "build".into(),
                        detail: detail.into(),
                    },
                )
                .await;
        }

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");

        if let Some(ref mut persistence) = orchestrator.timeline_persistence {
            persistence.flush().await;
        }
        drop(orchestrator);

        let mut api_config = make_config();
        api_config.workspace.root = Some(dir.path().to_string_lossy().into_owned());
        let config_path = dir.path().join("config.yaml");
        let document_state = crate::config::draft::ConfigDocumentState {
            path: config_path.clone(),
            kind: crate::config::draft::ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(api_config),
            validation: crate::config::draft::DraftValidationReport::default(),
        };
        let prepared =
            crate::api::bootstrap::build_app_state(config_path, document_state, EventBus::new());
        assert_eq!(
            prepared.app_state.history_db_path,
            dir.path().join(".ensemble").join("history.db")
        );
        let app = crate::api::router::create_api_router(
            prepared.app_state,
            crate::api::security::ApiExposure::TrustedLocal,
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/repo%231/timeline?run_id=run-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let timeline: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(timeline["total"], 2);
        assert_eq!(
            timeline["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["sequence"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(timeline["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["issue_identifier"] == "repo#1"));
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
                acceptance_runner: Arc::new(ShellAcceptanceCommandRunner),
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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
            .handle_unowned_test_event(WorkerEvent::AgentUpdate {
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

        let timeline = orchestrator
            .history_store
            .as_ref()
            .unwrap()
            .read_timeline(
                &crate::timeline::TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();
        let record = &timeline.events[0];
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
            let timeline = orchestrator
                .history_store
                .as_ref()
                .unwrap()
                .read_timeline(
                    &crate::timeline::TimelineQuery {
                        run_id,
                        cursor: None,
                        limit: None,
                    },
                    Some("repo#1"),
                )
                .await
                .unwrap();
            let mut question_asked_sequence: Option<u64> = None;
            let mut input_requested_sequence: Option<u64> = None;

            for event in timeline.events {
                match event.event_type.as_str() {
                    "question_asked" => question_asked_sequence = Some(event.sequence),
                    "input_requested" => input_requested_sequence = Some(event.sequence),
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

    #[tokio::test]
    async fn worker_identity_stale_update_cannot_mutate_replacement_attempt() {
        let (orchestrator, dir, stale_identity) = worker_identity_test_orchestrator().await;
        let (_stale_complete_tx, stale_complete_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            stale_identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            stale_complete_rx,
        );

        let replacement_identity = {
            let mut state = orchestrator.state.write().await;
            let entry = state.running.get_mut("1").unwrap();
            entry.started_at += chrono::Duration::seconds(1);
            WorkerIdentity {
                started_at: entry.started_at,
                ..stale_identity.clone()
            }
        };
        let (_replacement_complete_tx, replacement_complete_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            replacement_identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            replacement_complete_rx,
        );

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity: stale_identity.clone(),
                event: WorkerEvent::AgentUpdate {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    event: AgentEvent::SessionStarted {
                        session_id: "stale-session".to_string(),
                        agent_pid: None,
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity: stale_identity.clone(),
                event: WorkerEvent::AgentUpdate {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    event: AgentEvent::RunCompleted {
                        usage: Some(crate::agent::events::TokenUsage {
                            input_tokens: 10,
                            output_tokens: 20,
                            total_tokens: 30,
                        }),
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity: stale_identity.clone(),
                event: WorkerEvent::WorkerExited {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    result: WorkerResult::Failed {
                        error: "stale failure".to_string(),
                        kind: WorkerFailureKind::Runtime,
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity: stale_identity,
                event: WorkerEvent::WorkerExited {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    result: WorkerResult::Success {
                        output: succeeded_step_output(),
                        approval_request: None,
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        let state = orchestrator.state.read().await;
        let replacement = state.get_running("1").unwrap();
        assert_eq!(replacement.session_id, None);
        assert_eq!(replacement.agent_input_tokens, 0);
        assert_eq!(replacement.agent_output_tokens, 0);
        assert_eq!(replacement.agent_total_tokens, 0);
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(matches!(
            state
                .get_pipeline_run("1")
                .unwrap()
                .step_states
                .get("build"),
            Some(StepState::Running { .. })
        ));
        drop(state);
        assert!(crate::agent::cancellation::contains_worker(
            &orchestrator.cancellation_registry,
            &replacement_identity
        ));
        assert!(orchestrator
            .pipeline_journal
            .read_records_for_issue("1")
            .await
            .unwrap()
            .is_empty());
        assert!(!dir.path().join("ensemble_history.jsonl").exists());
    }

    #[tokio::test]
    async fn worker_identity_current_envelope_drives_updates() {
        let (orchestrator, _dir, identity) = worker_identity_test_orchestrator().await;
        let (_complete_tx, complete_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            complete_rx,
        );

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity,
                event: WorkerEvent::AgentUpdate {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    event: AgentEvent::SessionStarted {
                        session_id: "current-session".to_string(),
                        agent_pid: None,
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        let state = orchestrator.state.read().await;
        assert_eq!(
            state.get_running("1").unwrap().session_id.as_deref(),
            Some("current-session")
        );
    }

    #[tokio::test]
    async fn worker_identity_bridge_failure_retains_incomplete_owner() {
        let registry = crate::agent::cancellation::new_cancellation_registry();
        let identity = WorkerIdentity {
            issue_id: "1".to_string(),
            run_id: "run-1".to_string(),
            cycle: 1,
            step_name: "build".to_string(),
            started_at: Utc::now(),
        };
        let (completion_tx, completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            completion_rx,
        );
        let (local_tx, local_rx) = mpsc::channel(1);
        let (orchestrator_tx, orchestrator_rx) = mpsc::channel(1);
        drop(orchestrator_rx);
        local_tx
            .send(WorkerEvent::AgentUpdate {
                issue_id: "1".to_string(),
                step_name: "build".to_string(),
                event: AgentEvent::PromptStarted,
                timestamp: Utc::now(),
            })
            .await
            .unwrap();
        drop(local_tx);

        bridge_worker_events(
            local_rx,
            orchestrator_tx,
            registry.clone(),
            identity.clone(),
            completion_tx,
        )
        .await;

        let mut handles =
            crate::agent::cancellation::mark_issue_for_drain(&registry, &identity.issue_id);
        assert!(
            !crate::agent::cancellation::await_worker_drain(
                &mut handles,
                Duration::from_millis(10)
            )
            .await
        );
        assert!(crate::agent::cancellation::contains_worker(
            &registry, &identity
        ));
    }

    #[tokio::test]
    async fn worker_identity_drain_pumps_events_while_waiting_for_bridge() {
        let (orchestrator, _dir, identity) = worker_identity_test_orchestrator().await;
        let (completion_tx, completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            completion_rx,
        );
        let (local_tx, local_rx) = mpsc::channel(100);
        let bridge = tokio::spawn(bridge_worker_events(
            local_rx,
            orchestrator.worker_tx.clone(),
            orchestrator.cancellation_registry.clone(),
            identity.clone(),
            completion_tx,
        ));
        let producer = tokio::spawn(async move {
            for _ in 0..1002 {
                local_tx
                    .send(WorkerEvent::AgentUpdate {
                        issue_id: "1".to_string(),
                        step_name: "build".to_string(),
                        event: AgentEvent::PromptStarted,
                        timestamp: Utc::now(),
                    })
                    .await
                    .unwrap();
            }
        });

        let mut handles = crate::agent::cancellation::mark_issue_for_drain(
            &orchestrator.cancellation_registry,
            &identity.issue_id,
        );
        assert!(
            orchestrator
                .await_worker_drain_with_event_pump(
                    &mut handles,
                    Duration::from_secs(1),
                    DrainEventMode::ApplyExceptIssue(&identity.issue_id),
                )
                .await,
            "drain should keep consuming the bounded orchestrator event queue"
        );
        producer.await.unwrap();
        bridge.await.unwrap();
        assert!(crate::agent::cancellation::contains_worker(
            &orchestrator.cancellation_registry,
            &identity
        ));
        remove_drained_workers(&orchestrator.cancellation_registry, &handles);
    }

    #[tokio::test]
    async fn worker_identity_reconciliation_pump_suppresses_retired_owner_exit() {
        let (orchestrator, _dir, identity) = worker_identity_test_orchestrator().await;
        let (completion_tx, completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            completion_rx,
        );
        let (local_tx, local_rx) = mpsc::channel(1);
        let bridge = tokio::spawn(bridge_worker_events(
            local_rx,
            orchestrator.worker_tx.clone(),
            orchestrator.cancellation_registry.clone(),
            identity.clone(),
            completion_tx,
        ));
        local_tx
            .send(WorkerEvent::WorkerExited {
                issue_id: identity.issue_id.clone(),
                step_name: identity.step_name.clone(),
                result: WorkerResult::Failed {
                    error: "queued before reconciliation".to_string(),
                    kind: WorkerFailureKind::Runtime,
                },
                timestamp: Utc::now(),
            })
            .await
            .unwrap();
        drop(local_tx);
        bridge.await.unwrap();
        assert!(!crate::agent::cancellation::contains_worker(
            &orchestrator.cancellation_registry,
            &identity
        ));

        let blocker_identity = WorkerIdentity {
            issue_id: "2".to_string(),
            run_id: "run-2".to_string(),
            cycle: 1,
            step_name: "build".to_string(),
            started_at: Utc::now(),
        };
        let (blocker_completion_tx, blocker_completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            blocker_identity,
            tokio_util::sync::CancellationToken::new(),
            blocker_completion_rx,
        );
        let mut handles = mark_issue_for_drain(&orchestrator.cancellation_registry, "2");
        let unblock = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            blocker_completion_tx.send(true).unwrap();
        });

        assert!(
            orchestrator
                .await_worker_drain_with_event_pump(
                    &mut handles,
                    Duration::from_secs(1),
                    DrainEventMode::ApplyExceptIssue(&identity.issue_id),
                )
                .await
        );
        unblock.await.unwrap();
        remove_drained_workers(&orchestrator.cancellation_registry, &handles);

        assert!(matches!(
            orchestrator.worker_rx.lock().await.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(matches!(
            state
                .get_pipeline_run("1")
                .unwrap()
                .step_states
                .get("build"),
            Some(StepState::Running { .. })
        ));
    }

    #[tokio::test]
    async fn stalled_batch_rechecks_issue_after_unrelated_pumped_update() {
        let (orchestrator, _dir, _issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        orchestrator.config.write().await.agent.stall_timeout_ms = 60_000;
        let issue = test_issue("2", "Todo");
        let config = orchestrator.config.read().await.clone();
        let identity = {
            let dag = build_dag(&config.steps).unwrap();
            let mut pipeline_run = PipelineRun::new(issue.id.clone(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-2".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&issue, None);
            state.insert_pipeline_run(&issue.id, pipeline_run, Arc::new(config));
            for issue_id in ["1", "2"] {
                state
                    .running
                    .get_mut(issue_id)
                    .unwrap()
                    .last_agent_timestamp = Some(Utc::now() - chrono::Duration::minutes(2));
            }
            let entry = state.get_running(&issue.id).unwrap();
            WorkerIdentity {
                issue_id: issue.id.clone(),
                run_id: entry.run_id.clone().unwrap(),
                cycle: state.get_pipeline_run(&issue.id).unwrap().cycle,
                step_name: "build".to_string(),
                started_at: entry.started_at,
            }
        };
        let issue_two_token = tokio_util::sync::CancellationToken::new();
        let (_issue_two_completion_tx, issue_two_completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            issue_two_token.clone(),
            issue_two_completion_rx,
        );
        assert!(orchestrator.issue_is_stalled("2", 60_000).await);

        orchestrator
            .worker_tx
            .send(OrchestratorWorkerEvent {
                identity,
                event: WorkerEvent::AgentUpdate {
                    issue_id: "2".to_string(),
                    step_name: "build".to_string(),
                    event: AgentEvent::PromptStarted,
                    timestamp: Utc::now(),
                },
            })
            .await
            .unwrap();

        let first_reconciliation = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.reconcile_stalled_issue("1", 60_000).await }
        });
        cancelled.await.unwrap();
        tokio::task::yield_now().await;
        assert!(!first_reconciliation.is_finished());
        release.add_permits(1);
        first_reconciliation.await.unwrap();

        orchestrator.reconcile_stalled_issue("2", 60_000).await;

        assert!(!issue_two_token.is_cancelled());
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("2"));
            assert!(!state.retry_attempts.contains_key("2"));
        }
    }

    #[tokio::test]
    async fn tracker_reconciliation_batch_rechecks_each_candidate() {
        for initial_state in ["Done", "Backlog"] {
            let (orchestrator, _dir, issues, cancelled, release) =
                blocking_drain_test_orchestrator().await;
            let issue = test_issue("2", initial_state);
            let config = orchestrator.config.read().await.clone();
            let identity = {
                let dag = build_dag(&config.steps).unwrap();
                let mut pipeline_run = PipelineRun::new(issue.id.clone(), 1, dag);
                pipeline_run.start();
                pipeline_run.mark_running("build", "session-2".to_string());

                let mut state = orchestrator.state.write().await;
                state.add_running(&issue, None);
                state.insert_pipeline_run(&issue.id, pipeline_run, Arc::new(config));
                let entry = state.get_running(&issue.id).unwrap();
                WorkerIdentity {
                    issue_id: issue.id.clone(),
                    run_id: entry.run_id.clone().unwrap(),
                    cycle: 1,
                    step_name: "build".to_string(),
                    started_at: entry.started_at,
                }
            };
            {
                let mut tracked_issues = issues.write().await;
                tracked_issues[0].state = "Done".to_string();
                tracked_issues.push(issue);
            }
            let issue_two_token = tokio_util::sync::CancellationToken::new();
            let (_issue_two_completion_tx, issue_two_completion_rx) = watch::channel(false);
            crate::agent::cancellation::register_worker(
                &orchestrator.cancellation_registry,
                identity,
                issue_two_token.clone(),
                issue_two_completion_rx,
            );

            let tick = tokio::spawn({
                let orchestrator = Arc::clone(&orchestrator);
                async move { orchestrator.handle_tick().await }
            });
            cancelled
                .await
                .expect("first candidate should begin draining");
            issues
                .write()
                .await
                .iter_mut()
                .find(|issue| issue.id == "2")
                .unwrap()
                .state = "Todo".to_string();
            release.add_permits(1);
            tick.await.unwrap();

            assert!(
                !issue_two_token.is_cancelled(),
                "{initial_state} candidate must be refreshed before cancellation"
            );
            let state = orchestrator.state.read().await;
            assert!(state.is_running("2"));
            assert!(state.is_claimed("2"));
            assert!(state.get_pipeline_run("2").is_some());
        }
    }

    #[tokio::test]
    async fn worker_identity_drain_owned_exit_is_suppressed() {
        let (orchestrator, _dir, identity) = worker_identity_test_orchestrator().await;
        let (_complete_tx, complete_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            complete_rx,
        );
        crate::agent::cancellation::mark_issue_for_drain(&orchestrator.cancellation_registry, "1");

        orchestrator
            .handle_worker_event(OrchestratorWorkerEvent {
                identity: identity.clone(),
                event: WorkerEvent::WorkerExited {
                    issue_id: "1".to_string(),
                    step_name: "build".to_string(),
                    result: WorkerResult::Failed {
                        error: "cancelled for reconciliation".to_string(),
                        kind: WorkerFailureKind::Runtime,
                    },
                    timestamp: Utc::now(),
                },
            })
            .await;

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(matches!(
            state
                .get_pipeline_run("1")
                .unwrap()
                .step_states
                .get("build"),
            Some(StepState::Running { .. })
        ));
        drop(state);
        assert!(crate::agent::cancellation::contains_worker(
            &orchestrator.cancellation_registry,
            &identity
        ));
    }

    #[tokio::test]
    async fn reconciliation_drain_terminal_waits_before_release_and_cleanup() {
        let (orchestrator, dir, issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        let workspace_path = orchestrator.workspace_mgr.workspace_path("1");
        assert!(workspace_path.exists());
        issues.write().await[0].state = "Done".to_string();

        let tick = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_tick().await }
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled)
            .await
            .expect("terminal reconciliation should cancel the active worker")
            .unwrap();
        tokio::task::yield_now().await;

        assert!(!tick.is_finished());
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
        }
        assert!(workspace_path.exists());

        release.add_permits(1);
        tick.await.unwrap();

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);
        assert!(!workspace_path.exists());

        let orchestrator = handle_queued_worker_event_if_any(orchestrator).await;
        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);
        assert!(!workspace_path.exists());
        assert_single_stopped_history(&dir, "1").await;
    }

    #[tokio::test]
    async fn reconciliation_drain_inactive_waits_before_release_without_cleanup() {
        let (orchestrator, dir, issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        let workspace_path = orchestrator.workspace_mgr.workspace_path("1");
        issues.write().await[0].state = "Backlog".to_string();

        let tick = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_tick().await }
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled)
            .await
            .expect("inactive reconciliation should cancel the active worker")
            .unwrap();
        tokio::task::yield_now().await;

        assert!(!tick.is_finished());
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
        }

        release.add_permits(1);
        tick.await.unwrap();

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);
        assert!(workspace_path.exists());

        let orchestrator = handle_queued_worker_event_if_any(orchestrator).await;
        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        drop(state);
        assert!(workspace_path.exists());
        assert_single_stopped_history(&dir, "1").await;
    }

    #[tokio::test]
    async fn reconciliation_drain_stalled_waits_before_scheduling_retry() {
        let (orchestrator, _dir, _issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        orchestrator.config.write().await.agent.stall_timeout_ms = 1;
        {
            let mut state = orchestrator.state.write().await;
            state.running.get_mut("1").unwrap().last_agent_timestamp =
                Some(Utc::now() - chrono::Duration::seconds(1));
        }

        let tick = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_tick().await }
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled)
            .await
            .expect("stall reconciliation should cancel the active worker")
            .unwrap();
        tokio::task::yield_now().await;

        assert!(!tick.is_finished());
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert!(!state.retry_attempts.contains_key("1"));
        }

        release.add_permits(1);
        tick.await.unwrap();

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn retry_exhaustion_waits_for_reconciliation_drain_before_terminal_transition() {
        let (orchestrator, _dir, _issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        {
            let mut config = orchestrator.config.write().await;
            config.agent.stall_timeout_ms = 1;
            config.max_cycles = 1;
        }
        {
            let mut state = orchestrator.state.write().await;
            state.running.get_mut("1").unwrap().last_agent_timestamp =
                Some(Utc::now() - chrono::Duration::seconds(1));
        }

        let tick = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_tick().await }
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled)
            .await
            .expect("stall reconciliation should cancel the active worker")
            .unwrap();
        tokio::task::yield_now().await;

        assert!(!tick.is_finished());
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert!(!state.retry_attempts.contains_key("1"));
            assert!(!state.pending_terminal_transitions.contains_key("1"));
        }

        release.add_permits(1);
        tick.await.unwrap();

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn reconciliation_drain_stalled_timeout_retains_owner_then_retries_once() {
        let (orchestrator, _dir, _issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        let workspace_path = orchestrator.workspace_mgr.workspace_path("1");
        orchestrator.config.write().await.agent.stall_timeout_ms = 1;
        let identity = {
            let mut state = orchestrator.state.write().await;
            let (run_id, started_at) = {
                let entry = state.running.get_mut("1").unwrap();
                entry.last_agent_timestamp = Some(Utc::now() - chrono::Duration::seconds(1));
                (entry.run_id.clone().unwrap(), entry.started_at)
            };
            WorkerIdentity {
                issue_id: "1".to_string(),
                run_id,
                cycle: state.get_pipeline_run("1").unwrap().cycle,
                step_name: "build".to_string(),
                started_at,
            }
        };

        orchestrator.handle_tick().await;
        cancelled.await.unwrap();
        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_some());
            assert!(!state.retry_attempts.contains_key("1"));
        }
        assert!(workspace_path.exists());
        assert!(crate::agent::cancellation::is_reconciliation_owned(
            &orchestrator.cancellation_registry,
            &identity
        ));

        orchestrator
            .state
            .write()
            .await
            .running
            .get_mut("1")
            .unwrap()
            .last_agent_timestamp = Some(Utc::now());
        release.add_permits(1);
        orchestrator.handle_tick().await;
        let retry_before_exit = {
            let state = orchestrator.state.read().await;
            assert!(!state.is_running("1"));
            state.retry_attempts.get("1").unwrap().clone()
        };

        let orchestrator = handle_queued_worker_event_if_any(orchestrator).await;

        let state = orchestrator.state.read().await;
        let retry_after_exit = state.retry_attempts.get("1").unwrap();
        assert_eq!(retry_after_exit.attempt, retry_before_exit.attempt);
        assert_eq!(retry_after_exit.due_at_ms, retry_before_exit.due_at_ms);
    }

    #[tokio::test]
    async fn reconciliation_drain_stalled_revalidates_exact_owner_before_retry() {
        let (orchestrator, _dir, _issues, cancelled, release) =
            blocking_drain_test_orchestrator().await;
        orchestrator.config.write().await.agent.stall_timeout_ms = 1;
        {
            let mut state = orchestrator.state.write().await;
            state.running.get_mut("1").unwrap().last_agent_timestamp =
                Some(Utc::now() - chrono::Duration::seconds(1));
        }

        let tick = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_tick().await }
        });
        cancelled.await.unwrap();
        {
            let mut state = orchestrator.state.write().await;
            state.running.get_mut("1").unwrap().started_at += chrono::Duration::seconds(1);
        }
        release.add_permits(1);
        tick.await.unwrap();

        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn worker_identity_shutdown_remains_quiescing_until_workers_drain() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let runner: Arc<dyn AgentRunner> = Arc::new(BlockingDrainRunner {
            started: std::sync::Mutex::new(Some(started_tx)),
            cancellation_observed: std::sync::Mutex::new(Some(cancelled_tx)),
            release: Arc::clone(&release),
        });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let mut orchestrator = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        let run = tokio::spawn(async move { orchestrator.run().await });
        started_rx.await.unwrap();
        shutdown_tx.send(()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancelled_rx)
            .await
            .expect("shutdown should cancel the active worker")
            .unwrap();
        tokio::time::sleep(WORKER_DRAIN_TIMEOUT + Duration::from_millis(50)).await;
        assert!(!run.is_finished());

        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), run)
            .await
            .expect("shutdown should finish after the worker drains")
            .unwrap();
    }

    #[tokio::test]
    async fn worker_identity_shutdown_pumps_saturated_events_until_bridge_quiesces() {
        let (orchestrator, _dir, identity) = worker_identity_test_orchestrator().await;
        let (completion_tx, completion_rx) = watch::channel(false);
        crate::agent::cancellation::register_worker(
            &orchestrator.cancellation_registry,
            identity.clone(),
            tokio_util::sync::CancellationToken::new(),
            completion_rx,
        );
        let (local_tx, local_rx) = mpsc::channel(100);
        let bridge = tokio::spawn(bridge_worker_events(
            local_rx,
            orchestrator.worker_tx.clone(),
            orchestrator.cancellation_registry.clone(),
            identity,
            completion_tx,
        ));
        let producer = tokio::spawn(async move {
            for _ in 0..1002 {
                local_tx
                    .send(WorkerEvent::AgentUpdate {
                        issue_id: "1".to_string(),
                        step_name: "build".to_string(),
                        event: AgentEvent::PromptStarted,
                        timestamp: Utc::now(),
                    })
                    .await
                    .unwrap();
            }
        });

        assert!(orchestrator.cancel_active_runs().await);
        producer.await.unwrap();
        bridge.await.unwrap();
        assert!(crate::agent::cancellation::registry_is_empty(
            &orchestrator.cancellation_registry
        ));
        assert_eq!(
            orchestrator
                .state
                .read()
                .await
                .get_running("1")
                .unwrap()
                .turn_count,
            0,
            "shutdown must discard queued events"
        );
    }

    #[tokio::test]
    async fn retry_fire_tracker_failure_defers_the_same_pipeline_cycle() {
        let config = Arc::new(RwLock::new(make_config()));
        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingCandidateTracker);
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
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: Some("review".to_string()),
            with_fixup: true,
        };
        orchestrator.state.write().await.add_retry(retry.clone());

        orchestrator.handle_single_retry(&retry).await;

        let state = orchestrator.state.read().await;
        let deferred = state.retry_attempts.get("1").unwrap();
        assert_eq!(deferred.attempt, retry.attempt);
        assert_eq!(deferred.error.as_deref(), Some("retry poll failed"));
        assert_eq!(deferred.retry_from_step, retry.retry_from_step);
        assert_eq!(deferred.with_fixup, retry.with_fixup);
        assert!(state.is_claimed("1"));
    }

    #[tokio::test]
    async fn retry_fire_stale_candidate_result_does_not_release_a_newer_retry() {
        let config = Arc::new(RwLock::new(make_config()));
        let fetch_started = Arc::new(tokio::sync::Notify::new());
        let release_fetch = Arc::new(tokio::sync::Notify::new());
        let tracker: Arc<dyn IssueTracker> = Arc::new(BlockingCandidateTracker {
            issues: Arc::new(RwLock::new(Vec::new())),
            fetch_started: Arc::clone(&fetch_started),
            release_fetch: Arc::clone(&release_fetch),
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
        let orchestrator = Arc::new(Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        ));
        let fired = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 0,
            error: Some("old failure".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        orchestrator.state.write().await.add_retry(fired.clone());

        let retry_fire = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            async move { orchestrator.handle_single_retry(&fired).await }
        });
        fetch_started.notified().await;
        let replacement = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 4,
            due_at_ms: current_time_ms() + 60_000,
            error: Some("new failure".to_string()),
            retry_from_step: Some("review".to_string()),
            with_fixup: true,
        };
        orchestrator
            .state
            .write()
            .await
            .add_retry(replacement.clone());
        release_fetch.notify_one();
        retry_fire.await.unwrap();

        let state = orchestrator.state.read().await;
        assert_eq!(state.retry_attempts.get("1"), Some(&replacement));
        assert!(state.is_claimed("1"));
    }

    #[tokio::test]
    async fn retry_fire_quiescing_defers_the_same_pipeline_cycle() {
        let config = Arc::new(RwLock::new(make_config()));
        let fetch_started = Arc::new(tokio::sync::Notify::new());
        let release_fetch = Arc::new(tokio::sync::Notify::new());
        let tracker: Arc<dyn IssueTracker> = Arc::new(BlockingCandidateTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
            fetch_started: Arc::clone(&fetch_started),
            release_fetch: Arc::clone(&release_fetch),
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
        let orchestrator = Arc::new(Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        ));
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: Some("review".to_string()),
            with_fixup: true,
        };
        orchestrator.state.write().await.add_retry(retry.clone());

        let retry_fire = tokio::spawn({
            let orchestrator = Arc::clone(&orchestrator);
            let retry = retry.clone();
            async move { orchestrator.handle_single_retry(&retry).await }
        });
        fetch_started.notified().await;
        orchestrator.quiescing.request();
        release_fetch.notify_one();
        retry_fire.await.unwrap();

        let state = orchestrator.state.read().await;
        let deferred = state.retry_attempts.get("1").unwrap();
        assert_eq!(deferred.issue_id, retry.issue_id);
        assert_eq!(deferred.identifier, retry.identifier);
        assert_eq!(deferred.attempt, retry.attempt);
        assert_eq!(deferred.error.as_deref(), Some("orchestrator quiescing"));
        assert_eq!(deferred.retry_from_step, retry.retry_from_step);
        assert_eq!(deferred.with_fixup, retry.with_fixup);
        assert!(deferred.due_at_ms > retry.due_at_ms);
        assert!(state.is_claimed("1"));
        assert!(!state.is_running("1"));
    }

    #[tokio::test]
    async fn retry_fire_capacity_deferral_does_not_consume_a_pipeline_cycle() {
        let mut raw_config = make_config();
        raw_config.concurrency.max_concurrent_agents = 1;
        let config = Arc::new(RwLock::new(raw_config));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
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
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("2", "Todo"), None);
            state.add_retry(retry.clone());
        }

        orchestrator.handle_single_retry(&retry).await;

        let state = orchestrator.state.read().await;
        assert_eq!(
            state.retry_attempts.get("1").map(|entry| entry.attempt),
            Some(retry.attempt)
        );
        assert!(state.is_claimed("1"));
    }

    #[tokio::test]
    async fn retry_fire_eventual_dispatch_uses_the_intended_attempt_once() {
        let config = Arc::new(RwLock::new(make_config()));
        let issue = test_issue("1", "Todo");
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![issue])),
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
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        orchestrator.state.write().await.add_retry(retry.clone());

        orchestrator.handle_single_retry(&retry).await;

        let state = orchestrator.state.read().await;
        assert_eq!(
            state.get_running("1").and_then(|entry| entry.retry_attempt),
            Some(retry.attempt)
        );
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn retry_exhaustion_during_workspace_setup_becomes_durable_terminal_state() {
        let mut raw_config = make_config();
        raw_config.max_cycles = 1;
        raw_config.hooks.after_create = Some("exit 1".to_string());
        let config = Arc::new(RwLock::new(raw_config));
        let issue = test_issue("1", "Todo");
        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWriteTracker {
            issues: Arc::new(RwLock::new(vec![issue.clone()])),
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

        orchestrator.dispatch_issue(&issue, Some(1)).await;

        let state = orchestrator.state.read().await;
        assert!(state.pending_terminal_transitions.contains_key("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.retry_attempts.contains_key("1"));
        drop(state);

        let record = orchestrator
            .pipeline_journal
            .latest_live_record_for_issue("1")
            .await
            .unwrap()
            .expect("durable pending terminal record");
        assert_eq!(
            record.kind,
            PipelineTransitionKind::PendingTerminalTransition
        );
        assert_eq!(
            record
                .terminal_transition
                .as_ref()
                .map(|transition| transition.outcome),
            Some(TerminalOutcome::Failed)
        );
    }

    #[tokio::test]
    async fn retry_recovery_restores_exhausted_terminal_intent_after_restart() {
        let mut raw_config = make_config();
        raw_config.max_cycles = 1;
        raw_config.hooks.after_create = Some("exit 1".to_string());
        let config = Arc::new(RwLock::new(raw_config));
        let issue = test_issue("1", "Todo");
        let issues = Arc::new(RwLock::new(vec![issue.clone()]));
        let dir = tempfile::TempDir::new().unwrap();

        {
            let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWriteTracker {
                issues: Arc::clone(&issues),
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
                Arc::clone(&config),
                tracker,
                runner,
                workspace_mgr,
                dir.path(),
                shutdown_rx,
            );
            orchestrator.dispatch_issue(&issue, Some(1)).await;
            assert!(orchestrator
                .state
                .read()
                .await
                .pending_terminal_transitions
                .contains_key("1"));
        }

        let tracker: Arc<dyn IssueTracker> = Arc::new(FailingWriteTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let restarted = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        restarted.restore_pipeline_runs_from_journal().await;
        restarted.reconcile_pending_terminal_transitions().await;

        let state = restarted.state.read().await;
        assert!(state.pending_terminal_transitions.contains_key("1"));
        assert!(state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_some());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[tokio::test]
    async fn retry_recovery_restores_same_cycle_deferred_retry_after_restart() {
        let config = Arc::new(RwLock::new(make_config()));
        let dir = tempfile::TempDir::new().unwrap();
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: Some("build".to_string()),
            with_fixup: true,
        };

        {
            let tracker: Arc<dyn IssueTracker> = Arc::new(FailingCandidateTracker);
            let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
                delay_ms: 0,
                observed_commands: None,
                observed_timeouts: None,
                cancellation_probe: None,
            });
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
                let mut run = PipelineRun::new("1".to_string(), 2, dag);
                run.start();
                run.retry_from_step_with_fixup("build", "builder");
                let mut state = orchestrator.state.write().await;
                state.insert_pipeline_run("1", run, Arc::new(cfg.clone()));
                state.add_retry(retry.clone());
            }
            orchestrator.handle_single_retry(&retry).await;
        }

        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: Arc::new(RwLock::new(vec![test_issue("1", "Todo")])),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let restarted = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        restarted.restore_pipeline_runs_from_journal().await;

        let state = restarted.state.read().await;
        let restored = state.retry_attempts.get("1").unwrap();
        assert_eq!(restored.attempt, retry.attempt);
        assert_eq!(restored.retry_from_step, retry.retry_from_step);
        assert_eq!(restored.with_fixup, retry.with_fixup);
        assert_eq!(restored.error.as_deref(), Some("retry poll failed"));
        assert!(state.is_claimed("1"));
    }

    #[tokio::test]
    async fn retry_recovery_does_not_restore_a_missing_candidate_release() {
        let config = Arc::new(RwLock::new(make_config()));
        let dir = tempfile::TempDir::new().unwrap();
        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };

        {
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
                Arc::clone(&config),
                tracker,
                runner,
                workspace_mgr,
                dir.path(),
                shutdown_rx,
            );
            let transition = {
                let cfg = config.read().await;
                let dag = build_dag(&cfg.steps).unwrap();
                let mut state = orchestrator.state.write().await;
                state.insert_pipeline_run(
                    "1",
                    PipelineRun::new("1".to_string(), retry.attempt, dag),
                    Arc::new(cfg.clone()),
                );
                state.add_retry(retry.clone());
                Orchestrator::transition_input_for_run(
                    &state,
                    "1",
                    "repo#1",
                    PipelineTransitionKind::StepRetryScheduled,
                    None,
                    retry.error.clone(),
                    Some(retry.clone()),
                )
                .unwrap()
            };
            orchestrator.append_pipeline_transition(transition).await;

            orchestrator.handle_single_retry(&retry).await;

            let state = orchestrator.state.read().await;
            assert!(!state.retry_attempts.contains_key("1"));
            assert!(!state.is_claimed("1"));
            assert!(state.get_pipeline_run("1").is_none());
            drop(state);

            let record = orchestrator
                .pipeline_journal
                .read_records_for_issue("1")
                .await
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(record.kind, PipelineTransitionKind::Released);
        }

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
        let restarted = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        restarted.restore_pipeline_runs_from_journal().await;

        let state = restarted.state.read().await;
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(!state.is_claimed("1"));
        assert!(state.get_pipeline_run("1").is_none());
    }

    #[tokio::test]
    async fn whole_issue_retry_recovery_restores_the_fresh_pipeline_cycle() {
        let config = Arc::new(RwLock::new(make_config()));
        let issue = test_issue("1", "Todo");
        let issues = Arc::new(RwLock::new(vec![issue.clone()]));
        let dir = tempfile::TempDir::new().unwrap();

        {
            let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
                issues: Arc::clone(&issues),
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
                let mut run = PipelineRun::new("1".to_string(), 1, dag);
                run.start();
                run.mark_running("build", "session-1".to_string());
                let mut state = orchestrator.state.write().await;
                state.add_running(&issue, None);
                state.insert_pipeline_run("1", run, Arc::new(cfg.clone()));
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

            let state = orchestrator.state.read().await;
            assert_eq!(
                state.retry_attempts.get("1").map(|entry| entry.attempt),
                Some(2)
            );
            assert_eq!(state.get_pipeline_run("1").map(|run| run.cycle), Some(2));
        }

        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
            delay_ms: 0,
            observed_commands: None,
            observed_timeouts: None,
            cancellation_probe: None,
        });
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
        let restarted = Orchestrator::new(
            config,
            tracker,
            runner,
            workspace_mgr,
            dir.path(),
            shutdown_rx,
        );

        restarted.restore_pipeline_runs_from_journal().await;

        let state = restarted.state.read().await;
        assert_eq!(
            state.retry_attempts.get("1").map(|entry| entry.attempt),
            Some(2)
        );
        assert_eq!(state.get_pipeline_run("1").map(|run| run.cycle), Some(2));
        assert!(state.is_claimed("1"));
    }
}
