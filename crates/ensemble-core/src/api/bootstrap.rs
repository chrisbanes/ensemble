use crate::agent::cancellation::new_cancellation_registry;
use crate::agent::{AcpAgentRunner, AgentRunner};
use crate::api::router::{AppState, ConfigRuntime};
use crate::config::draft::ConfigDocumentState;
use crate::config::ensemble::{default_workspace_root, ConcurrencyConfig, PollingConfig};
use crate::error::{ConfigError, EnsembleError};
use crate::history_store::store::HistoryStore;
use crate::observability::events::EventBus;
use crate::orchestrator::retry::ManualStepRetryError;
use crate::orchestrator::state::OrchestratorState;
use crate::orchestrator::{
    FinalizeApprovalCommand, FinalizeApprovalError, FinalizeRetryCommand, FinalizeRetryError,
    ManualStepRetryCommand, ManualWholeIssueRetryCommand, Orchestrator, OrchestratorCommand,
    OrchestratorRuntimeParts, QuiescingLatch,
};
use crate::tracker::model::RetryEntry;
use crate::tracker::{create_tracker_for_runtime, IssueTracker};
use crate::transcript::events::TranscriptEventBus;
use crate::workspace::manager::WorkspaceManager;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::MutexGuard;
use std::time::{Duration, SystemTime};
use tokio::sync::{mpsc, oneshot, watch, RwLock};
use tokio::task::JoinHandle;
use tracing::warn;

/// Maximum time the orchestrator restart path will wait for the previous runtime
/// to quiesce before returning a retryable busy error.
const ORCHESTRATOR_RESTART_TIMEOUT: Duration = Duration::from_secs(10);
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

pub struct PreparedApp {
    pub app_state: AppState,
    pub has_runnable_config: bool,
}

pub struct OrchestratorRuntime {
    id: u64,
    shutdown_tx: mpsc::Sender<()>,
    completion: watch::Receiver<bool>,
    quiescing: QuiescingLatch,
    command_tx: mpsc::Sender<OrchestratorCommand>,
    _worker_event_receiver:
        Arc<tokio::sync::Mutex<mpsc::Receiver<crate::agent::events::OrchestratorWorkerEvent>>>,
    task: JoinHandle<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimePhase {
    Running,
    QuiescingForReplacement,
    QuiescingForShutdown,
}

struct RegisteredRuntime {
    phase: RuntimePhase,
    runtime: OrchestratorRuntime,
}

/// `std::sync::Mutex` is sufficient here because runtime registration only swaps an `Option`
/// and never holds the mutex guard across `.await`. A tokio mutex would add async overhead
/// without improving correctness for these tiny critical sections.
#[derive(Clone, Default)]
pub struct RegisteredOrchestrator {
    inner: Arc<std::sync::Mutex<Option<RegisteredRuntime>>>,
    #[cfg(test)]
    test_command_tx: Arc<std::sync::Mutex<Option<mpsc::Sender<OrchestratorCommand>>>>,
}

impl RegisteredOrchestrator {
    #[cfg(test)]
    pub(crate) fn is_registered(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    pub(crate) async fn queue_manual_step_retry(
        &self,
        command: ManualStepRetryCommand,
    ) -> Result<RetryEntry, ManualStepRetryError> {
        let Some(command_tx) = self.command_sender() else {
            return Err(ManualStepRetryError::RuntimeUnavailable);
        };
        let (response, result) = tokio::sync::oneshot::channel();
        command_tx
            .send(OrchestratorCommand::QueueManualStepRetry { command, response })
            .await
            .map_err(|_| ManualStepRetryError::RuntimeUnavailable)?;
        result
            .await
            .map_err(|_| ManualStepRetryError::RuntimeUnavailable)?
    }

    pub(crate) async fn queue_manual_whole_issue_retry(
        &self,
        command: ManualWholeIssueRetryCommand,
    ) -> Result<(), ManualStepRetryError> {
        let Some(command_tx) = self.command_sender() else {
            return Err(ManualStepRetryError::RuntimeUnavailable);
        };
        let (response, result) = tokio::sync::oneshot::channel();
        command_tx
            .send(OrchestratorCommand::QueueManualWholeIssueRetry { command, response })
            .await
            .map_err(|_| ManualStepRetryError::RuntimeUnavailable)?;
        result
            .await
            .map_err(|_| ManualStepRetryError::RuntimeUnavailable)?
    }

    pub(crate) async fn approve_finalize(
        &self,
        command: FinalizeApprovalCommand,
    ) -> Result<bool, FinalizeApprovalError> {
        let Some(command_tx) = self.command_sender() else {
            return Err(FinalizeApprovalError::RuntimeUnavailable);
        };
        let (response, result) = tokio::sync::oneshot::channel();
        command_tx
            .send(OrchestratorCommand::ApproveFinalize { command, response })
            .await
            .map_err(|_| FinalizeApprovalError::RuntimeUnavailable)?;
        result
            .await
            .map_err(|_| FinalizeApprovalError::RuntimeUnavailable)?
    }

    pub(crate) async fn retry_finalize(
        &self,
        command: FinalizeRetryCommand,
    ) -> Result<(), FinalizeRetryError> {
        let Some(command_tx) = self.command_sender() else {
            return Err(FinalizeRetryError::RuntimeUnavailable);
        };
        let (response, result) = tokio::sync::oneshot::channel();
        command_tx
            .send(OrchestratorCommand::RetryFinalize { command, response })
            .await
            .map_err(|_| FinalizeRetryError::RuntimeUnavailable)?;
        result
            .await
            .map_err(|_| FinalizeRetryError::RuntimeUnavailable)?
    }

    fn command_sender(&self) -> Option<mpsc::Sender<OrchestratorCommand>> {
        let command_tx = {
            let registered = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            registered
                .as_ref()
                .filter(|registered| registered.phase == RuntimePhase::Running)
                .map(|registered| registered.runtime.command_tx.clone())
        };
        #[cfg(test)]
        let command_tx = command_tx.or_else(|| {
            self.test_command_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        });
        command_tx
    }

    #[cfg(test)]
    pub(crate) fn install_test_command_sender(
        &self,
        command_tx: mpsc::Sender<OrchestratorCommand>,
    ) {
        *self
            .test_command_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(command_tx);
    }
}

pub(crate) struct PreparedOrchestratorRuntime {
    orchestrator: Orchestrator,
    shutdown_tx: mpsc::Sender<()>,
}

impl OrchestratorRuntime {
    pub fn request_shutdown(&self) {
        self.quiescing.request();
        // Capacity is 1; if a shutdown request is already queued, nothing else is needed.
        let _ = self.shutdown_tx.try_send(());
    }

    pub fn abort(self) {
        self.request_shutdown();
        self.task.abort();
    }

    pub async fn shutdown(self) {
        self.request_shutdown();
        let _ = self.task.await;
    }

    fn is_complete(&self) -> bool {
        *self.completion.borrow() && self.task.is_finished()
    }
}

pub fn orchestrator_state_from_document(
    document_state: &ConfigDocumentState,
) -> Arc<RwLock<OrchestratorState>> {
    let (poll_interval_ms, concurrency) = document_state
        .active_config
        .as_ref()
        .map(|config| (config.polling.interval_ms, config.concurrency.clone()))
        .unwrap_or_else(|| {
            (
                PollingConfig::default().interval_ms,
                ConcurrencyConfig::default(),
            )
        });

    Arc::new(RwLock::new(OrchestratorState::new(
        poll_interval_ms,
        &concurrency,
    )))
}

pub fn workspace_root_from_document(document_state: &ConfigDocumentState) -> String {
    document_state
        .active_config
        .as_ref()
        .and_then(|config| config.workspace.root.as_ref().cloned())
        .unwrap_or_else(default_workspace_root)
}

pub fn build_app_state(
    config_path: PathBuf,
    document_state: ConfigDocumentState,
    event_bus: EventBus,
) -> PreparedApp {
    let has_runnable_config = document_state.active_config.is_some();
    let workspace_root = workspace_root_from_document(&document_state);
    let history_path = PathBuf::from(&workspace_root).join("ensemble_history.jsonl");
    let history_db_path = PathBuf::from(&workspace_root)
        .join(".ensemble")
        .join("history.db");
    let history_store = match HistoryStore::new_blocking(history_db_path.clone()) {
        Ok(store) => Some(store),
        Err(error) => {
            warn!(
                path = %history_db_path.display(),
                error = %error,
                "failed to initialize sqlite history store; api will fall back to JSONL history"
            );
            None
        }
    };
    let transcript_event_bus = TranscriptEventBus::new();

    let app_state = AppState {
        orchestrator_state: orchestrator_state_from_document(&document_state),
        orchestrator_runtime: RegisteredOrchestrator::default(),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root,
        history_path,
        history_db_path,
        history_store,
        event_bus,
        transcript_event_bus,
        config_runtime: ConfigRuntime {
            config_path,
            document_state: Arc::new(RwLock::new(document_state)),
            reload_coordinator: Arc::new(tokio::sync::Mutex::new(())),
            last_loaded_mtime: Arc::new(RwLock::new(None)),
        },
        cancellation_registry: new_cancellation_registry(),
    };

    PreparedApp {
        app_state,
        has_runnable_config,
    }
}

fn config_dir_for_path(config_path: &Path) -> Result<PathBuf, ConfigError> {
    match config_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_path_buf()),
        Some(_) if config_path.is_relative() => Ok(PathBuf::from(".")),
        _ => Err(ConfigError::ConfigDirUnavailable),
    }
}

fn registered_orchestrator_guard(
    app_state: &AppState,
) -> MutexGuard<'_, Option<RegisteredRuntime>> {
    app_state
        .orchestrator_runtime
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) async fn prepare_orchestrator_runtime(
    app_state: &AppState,
    candidate: &ConfigDocumentState,
) -> Result<Option<PreparedOrchestratorRuntime>, EnsembleError> {
    let Some(config) = candidate.active_config.clone() else {
        return Ok(None);
    };

    let tracker: Arc<dyn IssueTracker> = Arc::from(create_tracker_for_runtime(&config)?);
    let config = Arc::new(RwLock::new(config));
    tracker.validate_configuration().await?;
    // `AcpAgentRunner` is the shared runtime dispatcher: `acpx_agent` steps run through the
    // acpx CLI/session runtime, while explicit direct configs keep the ACP stdio path.
    let agent_runner: Arc<dyn AgentRunner> = Arc::new(AcpAgentRunner::new_with_document_state(
        Arc::clone(&config),
        Arc::clone(&app_state.config_runtime.document_state),
    ));
    let workspace_mgr = {
        let config = config.read().await;
        WorkspaceManager::new_with_hooks(
            Path::new(&app_state.workspace_root),
            Some(config.repos.clone()),
            config.hooks.clone(),
        )?
    };
    let config_dir = config_dir_for_path(&app_state.config_runtime.config_path)?;
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let orchestrator = Orchestrator::new_with_state_and_history(
        OrchestratorRuntimeParts {
            state: Arc::clone(&app_state.orchestrator_state),
            config,
            tracker,
            agent_runner,
            acceptance_runner: Arc::new(crate::acceptance::ShellAcceptanceCommandRunner),
            workspace_mgr,
            refresh_requested: Arc::clone(&app_state.refresh_requested),
            cancellation_registry: app_state.cancellation_registry.clone(),
            event_bus: app_state.event_bus.clone(),
            transcript_event_bus: app_state.transcript_event_bus.clone(),
            workspace_root: PathBuf::from(&app_state.workspace_root),
        },
        &config_dir,
        shutdown_rx,
        app_state.history_store.clone(),
    );

    Ok(Some(PreparedOrchestratorRuntime {
        orchestrator,
        shutdown_tx,
    }))
}

fn launch_orchestrator_runtime_gated(
    prepared: PreparedOrchestratorRuntime,
) -> (OrchestratorRuntime, oneshot::Sender<()>) {
    let PreparedOrchestratorRuntime {
        mut orchestrator,
        shutdown_tx,
    } = prepared;
    let worker_event_receiver = orchestrator.worker_event_receiver_owner();
    let quiescing = orchestrator.quiescing_latch_owner();
    let command_tx = orchestrator.command_sender_owner();
    let (completion_tx, completion) = watch::channel(false);
    let (start_tx, start_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        let quiesced = orchestrator.run().await;
        if quiesced {
            let _ = completion_tx.send(true);
        }
    });

    (
        OrchestratorRuntime {
            id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
            shutdown_tx,
            completion,
            quiescing,
            command_tx,
            _worker_event_receiver: worker_event_receiver,
            task,
        },
        start_tx,
    )
}

fn launch_orchestrator_runtime(prepared: PreparedOrchestratorRuntime) -> OrchestratorRuntime {
    let (runtime, start_tx) = launch_orchestrator_runtime_gated(prepared);
    let _ = start_tx.send(());
    runtime
}

pub async fn start_orchestrator_for_app(
    app_state: &AppState,
) -> Result<Option<OrchestratorRuntime>, EnsembleError> {
    let candidate = app_state.config_runtime.document_state.read().await.clone();
    Ok(prepare_orchestrator_runtime(app_state, &candidate)
        .await?
        .map(launch_orchestrator_runtime))
}

pub fn take_registered_orchestrator(app_state: &AppState) -> Option<OrchestratorRuntime> {
    registered_orchestrator_guard(app_state)
        .take()
        .map(|registered| registered.runtime)
}

pub async fn clear_registered_orchestrator(app_state: &AppState) {
    let (runtime_id, completion) = {
        let mut registered = registered_orchestrator_guard(app_state);
        let Some(existing) = registered.as_mut() else {
            return;
        };
        existing.phase = RuntimePhase::QuiescingForShutdown;
        existing.runtime.request_shutdown();
        (existing.runtime.id, existing.runtime.completion.clone())
    };

    await_registered_runtime_completion(app_state, runtime_id, completion).await;

    let retired = {
        let mut registered = registered_orchestrator_guard(app_state);
        let removable = registered.as_ref().is_some_and(|existing| {
            existing.phase == RuntimePhase::QuiescingForShutdown
                && existing.runtime.id == runtime_id
                && existing.runtime.is_complete()
        });
        removable.then(|| registered.take()).flatten()
    };
    if let Some(retired) = retired {
        retired.runtime.shutdown().await;
    }
}

pub async fn start_or_replace_registered_orchestrator(
    app_state: &AppState,
) -> Result<bool, EnsembleError> {
    let _reload = app_state.config_runtime.reload_coordinator.lock().await;
    let candidate = app_state.config_runtime.document_state.read().await.clone();
    let file_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
        .and_then(|metadata| metadata.modified())
        .ok();
    apply_prepared_config_candidate_with_timeout(
        app_state,
        candidate,
        file_mtime,
        ORCHESTRATOR_RESTART_TIMEOUT,
        || Ok(()),
    )
    .await
}

pub(crate) async fn apply_prepared_config_candidate_with_hooks<Commit, AfterCommit>(
    app_state: &AppState,
    candidate: ConfigDocumentState,
    file_mtime: Option<SystemTime>,
    before_commit: Commit,
    after_commit: AfterCommit,
) -> Result<bool, EnsembleError>
where
    Commit: FnOnce() -> Result<(), EnsembleError>,
    AfterCommit: FnOnce(),
{
    apply_prepared_config_candidate_with_timeout_and_hooks(
        app_state,
        candidate,
        file_mtime,
        ORCHESTRATOR_RESTART_TIMEOUT,
        before_commit,
        after_commit,
    )
    .await
}

async fn apply_prepared_config_candidate_with_timeout<Commit>(
    app_state: &AppState,
    candidate: ConfigDocumentState,
    file_mtime: Option<SystemTime>,
    restart_timeout: Duration,
    before_commit: Commit,
) -> Result<bool, EnsembleError>
where
    Commit: FnOnce() -> Result<(), EnsembleError>,
{
    apply_prepared_config_candidate_with_timeout_and_hooks(
        app_state,
        candidate,
        file_mtime,
        restart_timeout,
        before_commit,
        || {},
    )
    .await
}

async fn apply_prepared_config_candidate_with_timeout_and_hooks<Commit, AfterCommit>(
    app_state: &AppState,
    candidate: ConfigDocumentState,
    file_mtime: Option<SystemTime>,
    restart_timeout: Duration,
    before_commit: Commit,
    after_commit: AfterCommit,
) -> Result<bool, EnsembleError>
where
    Commit: FnOnce() -> Result<(), EnsembleError>,
    AfterCommit: FnOnce(),
{
    let (active_raw_yaml, active_repos) = {
        let active = app_state.config_runtime.document_state.read().await;
        (
            active.raw_yaml.clone(),
            active
                .active_config
                .as_ref()
                .map(|config| config.repos.clone()),
        )
    };
    let prepared = prepare_orchestrator_runtime(app_state, &candidate).await?;
    let started = prepared.is_some();

    let prior_runtime = {
        let mut registered = registered_orchestrator_guard(app_state);
        if let Some(existing) = registered.as_mut() {
            match existing.phase {
                RuntimePhase::QuiescingForShutdown => return Err(EnsembleError::RuntimeBusy),
                RuntimePhase::QuiescingForReplacement if !existing.runtime.is_complete() => {
                    return Err(EnsembleError::RuntimeBusy);
                }
                RuntimePhase::Running | RuntimePhase::QuiescingForReplacement => {}
            }
            existing.phase = RuntimePhase::QuiescingForReplacement;
            existing.runtime.request_shutdown();
            Some((existing.runtime.id, existing.runtime.completion.clone()))
        } else {
            None
        }
    };

    if let Some((runtime_id, completion)) = prior_runtime.as_ref() {
        if !wait_for_registered_runtime_completion(
            app_state,
            *runtime_id,
            completion.clone(),
            restart_timeout,
        )
        .await
        {
            return Err(EnsembleError::RuntimeBusy);
        }
    }

    if let Some(expected_mtime) = file_mtime {
        let current_file_matches_candidate =
            std::fs::read_to_string(&app_state.config_runtime.config_path).ok()
                == candidate.raw_yaml;
        let current_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
            .and_then(|metadata| metadata.modified())
            .ok();
        if candidate.raw_yaml.is_some()
            && (!current_file_matches_candidate || current_mtime != Some(expected_mtime))
        {
            return Err(EnsembleError::RuntimeBusy);
        }
    }

    let mut document_state = app_state.config_runtime.document_state.write().await;
    let mut last_loaded_mtime = app_state.config_runtime.last_loaded_mtime.write().await;
    let mut orchestrator_state = app_state.orchestrator_state.write().await;
    let mut registered = registered_orchestrator_guard(app_state);

    let current_repos = document_state
        .active_config
        .as_ref()
        .map(|config| config.repos.clone());
    if document_state.raw_yaml != active_raw_yaml || current_repos != active_repos {
        return Err(EnsembleError::RuntimeBusy);
    }

    match (registered.as_ref(), prior_runtime.as_ref()) {
        (None, None) => {}
        (Some(existing), Some((runtime_id, _)))
            if existing.phase == RuntimePhase::QuiescingForReplacement
                && existing.runtime.id == *runtime_id
                && existing.runtime.is_complete() => {}
        _ => return Err(EnsembleError::RuntimeBusy),
    }

    before_commit()?;
    if let Some(expected_mtime) = file_mtime {
        let current_file_matches_candidate =
            std::fs::read_to_string(&app_state.config_runtime.config_path).ok()
                == candidate.raw_yaml;
        let current_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
            .and_then(|metadata| metadata.modified())
            .ok();
        if candidate.raw_yaml.is_some()
            && (!current_file_matches_candidate || current_mtime != Some(expected_mtime))
        {
            return Err(EnsembleError::RuntimeBusy);
        }
    }

    let retired = registered.take();
    let (replacement, start_tx) = match prepared {
        Some(prepared) => {
            let (runtime, start_tx) = launch_orchestrator_runtime_gated(prepared);
            (
                Some(RegisteredRuntime {
                    phase: RuntimePhase::Running,
                    runtime,
                }),
                Some(start_tx),
            )
        }
        None => (None, None),
    };
    *registered = replacement;

    if let Some(config) = candidate.active_config.as_ref() {
        orchestrator_state.poll_interval_ms = config.polling.interval_ms;
        orchestrator_state.max_concurrent_agents = config.concurrency.max_concurrent_agents;
        orchestrator_state.completed_expiry_secs = config.concurrency.completed_expiry_secs;
        orchestrator_state.init_state_lists(config);
    }
    *document_state = candidate;
    *last_loaded_mtime = file_mtime;

    drop(registered);
    drop(orchestrator_state);
    drop(last_loaded_mtime);
    drop(document_state);
    after_commit();
    if let Some(start_tx) = start_tx {
        let _ = start_tx.send(());
    }
    drop(retired);
    Ok(started)
}

#[cfg(test)]
pub(crate) async fn start_or_replace_registered_orchestrator_with_timeout(
    app_state: &AppState,
    restart_timeout: Duration,
) -> Result<bool, EnsembleError> {
    let candidate = app_state.config_runtime.document_state.read().await.clone();
    let file_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
        .and_then(|metadata| metadata.modified())
        .ok();
    apply_prepared_config_candidate_with_timeout(
        app_state,
        candidate,
        file_mtime,
        restart_timeout,
        || Ok(()),
    )
    .await
}

async fn wait_for_registered_runtime_completion(
    app_state: &AppState,
    runtime_id: u64,
    completion: watch::Receiver<bool>,
    wait: Duration,
) -> bool {
    tokio::time::timeout(
        wait,
        await_registered_runtime_completion(app_state, runtime_id, completion),
    )
    .await
    .is_ok()
}

async fn await_registered_runtime_completion(
    app_state: &AppState,
    runtime_id: u64,
    mut completion: watch::Receiver<bool>,
) {
    loop {
        let exact_runtime_finished = registered_orchestrator_guard(app_state)
            .as_ref()
            .is_some_and(|registered| {
                registered.runtime.id == runtime_id && registered.runtime.is_complete()
            });
        if exact_runtime_finished {
            return;
        }

        if *completion.borrow() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        } else if completion.changed().await.is_err() {
            // Closed without a positive quiescence proof is intentionally
            // fail-closed. Retain the registered owner forever.
            futures::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::draft::{missing_config_state, parse_raw_yaml};
    use crate::observability::events::EventBus;
    use crate::timeline::model::TimelineEventRecord;
    use crate::timeline::TimelineQuery;
    use crate::transcript::model::{
        TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION,
    };
    use crate::transcript::persistence::TranscriptPersistRequest;
    use crate::transcript::reader::read_transcript_page;
    use crate::transcript::writer::TranscriptWriter;
    use chrono::Utc;
    use rusqlite::TransactionBehavior;
    use std::os::fd::AsRawFd;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn valid_config_yaml(workspace_root: Option<&str>) -> String {
        let workspace = workspace_root
            .map(|root| format!("workspace:\n  root: {}\n", root))
            .unwrap_or_default();

        format!(
            "tracker:\n  kind: todo_file\n  path: TODO.md\npolling:\n  interval_ms: 1234\nconcurrency:\n  max_concurrent_agents: 7\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n{}",
            workspace
        )
    }

    #[tokio::test]
    async fn build_app_state_uses_config_values_when_document_is_runnable() {
        let config_path = PathBuf::from("/tmp/config.yaml");
        let document_state = parse_raw_yaml(
            config_path.clone(),
            valid_config_yaml(Some("/tmp/custom-workspaces")),
        );

        let built = build_app_state(config_path.clone(), document_state, EventBus::new());

        let orchestrator = built.app_state.orchestrator_state.read().await;
        assert_eq!(orchestrator.poll_interval_ms, 1234);
        assert_eq!(orchestrator.max_concurrent_agents, 7);
        assert!(built.has_runnable_config);
        assert_eq!(built.app_state.workspace_root, "/tmp/custom-workspaces");
    }

    #[tokio::test]
    async fn build_app_state_uses_shared_fallback_defaults_without_active_config() {
        let config_path = PathBuf::from("/tmp/missing-config.yaml");
        let document_state = missing_config_state(config_path.clone());

        let built = build_app_state(config_path.clone(), document_state, EventBus::new());

        let orchestrator = built.app_state.orchestrator_state.read().await;
        assert_eq!(
            orchestrator.poll_interval_ms,
            PollingConfig::default().interval_ms
        );
        assert_eq!(
            orchestrator.max_concurrent_agents,
            ConcurrencyConfig::default().max_concurrent_agents
        );
        assert!(!built.has_runnable_config);
    }

    #[test]
    fn build_app_state_sets_history_path_under_workspace_root() {
        let config_path = PathBuf::from("/tmp/config.yaml");
        let document_state = parse_raw_yaml(
            config_path.clone(),
            valid_config_yaml(Some("/tmp/history-workspaces")),
        );

        let built = build_app_state(config_path, document_state, EventBus::new());

        assert_eq!(
            built.app_state.history_path,
            PathBuf::from(&built.app_state.workspace_root).join("ensemble_history.jsonl")
        );
    }

    #[tokio::test]
    async fn start_orchestrator_for_app_returns_none_without_active_config() {
        let config_path = PathBuf::from("/tmp/missing-config.yaml");
        let built = build_app_state(
            config_path.clone(),
            missing_config_state(config_path),
            EventBus::new(),
        );

        let runtime = start_orchestrator_for_app(&built.app_state).await.unwrap();

        assert!(runtime.is_none());
    }

    #[tokio::test]
    async fn start_orchestrator_for_app_updates_shared_state_after_first_tick() {
        let temp_dir = tempfile::tempdir().unwrap();
        let todo_path = temp_dir.path().join("TODO.md");
        let config_path = temp_dir.path().join("config.yaml");
        let yaml = format!(
            "tracker:\n  kind: todo_file\n  path: {}\n  active_states: [Todo]\n  terminal_states: [Done]\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\npolling:\n  interval_ms: 60000\n",
            todo_path.display()
        );
        let document_state = parse_raw_yaml(config_path.clone(), yaml);
        let built = build_app_state(config_path, document_state, EventBus::new());

        let runtime = start_orchestrator_for_app(&built.app_state)
            .await
            .unwrap()
            .unwrap();

        let ticked = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let last_tick_at = built.app_state.orchestrator_state.read().await.last_tick_at;
                if last_tick_at.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;

        runtime.shutdown().await;

        assert!(
            ticked.is_ok(),
            "orchestrator did not record an initial tick"
        );
    }

    #[tokio::test]
    async fn orchestrator_runtime_processes_manual_retry_commands() {
        let temp_dir = tempfile::tempdir().unwrap();
        let todo_path = temp_dir.path().join("TODO.md");
        let config_path = temp_dir.path().join("config.yaml");
        let yaml = format!(
            "tracker:\n  kind: todo_file\n  path: {}\n  active_states: [Todo]\n  terminal_states: [Done]\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\npolling:\n  interval_ms: 60000\n",
            todo_path.display()
        );
        let document_state = parse_raw_yaml(config_path.clone(), yaml);
        let built = build_app_state(config_path, document_state, EventBus::new());
        let runtime = start_orchestrator_for_app(&built.app_state)
            .await
            .unwrap()
            .unwrap();
        let (response, result) = tokio::sync::oneshot::channel();

        runtime
            .command_tx
            .send(OrchestratorCommand::QueueManualStepRetry {
                command: ManualStepRetryCommand {
                    issue_id: "missing".to_string(),
                    identifier: "repo#404".to_string(),
                    step_name: "build".to_string(),
                },
                response,
            })
            .await
            .unwrap();
        let command_result = tokio::time::timeout(Duration::from_secs(2), result)
            .await
            .expect("orchestrator command should be handled")
            .expect("orchestrator should return a command result");

        runtime.shutdown().await;
        assert!(matches!(
            command_result,
            Err(ManualStepRetryError::NoPipelineRun)
        ));
    }

    #[tokio::test]
    async fn clear_registered_orchestrator_removes_stored_runtime() {
        let temp_dir = tempfile::tempdir().unwrap();
        let todo_path = temp_dir.path().join("TODO.md");
        let config_path = temp_dir.path().join("config.yaml");
        let yaml = format!(
            "tracker:\n  kind: todo_file\n  path: {}\n  active_states: [Todo]\n  terminal_states: [Done]\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
            todo_path.display()
        );
        let document_state = parse_raw_yaml(config_path.clone(), yaml);
        let built = build_app_state(config_path, document_state, EventBus::new());

        let runtime = start_orchestrator_for_app(&built.app_state)
            .await
            .unwrap()
            .unwrap();
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime,
        });

        clear_registered_orchestrator(&built.app_state).await;

        assert!(registered_orchestrator_guard(&built.app_state).is_none());
    }

    #[tokio::test]
    async fn start_or_replace_keeps_existing_runtime_when_rebuild_fails() {
        let temp_dir = tempfile::tempdir().unwrap();
        let todo_path = temp_dir.path().join("TODO.md");
        let config_path = temp_dir.path().join("config.yaml");
        let initial_yaml = format!(
            "tracker:\n  kind: todo_file\n  path: {}\n  active_states: [Todo]\n  terminal_states: [Done]\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
            todo_path.display()
        );
        let document_state = parse_raw_yaml(config_path.clone(), initial_yaml);
        let built = build_app_state(config_path.clone(), document_state, EventBus::new());

        let runtime = start_orchestrator_for_app(&built.app_state)
            .await
            .unwrap()
            .unwrap();
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime,
        });

        let bad_yaml = "tracker:\n  kind: todo_file\n  path: /definitely/missing/dir/TODO.md\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n";
        let next_state = parse_raw_yaml(config_path, bad_yaml.to_string());
        *built.app_state.config_runtime.document_state.write().await = next_state;

        let result = start_or_replace_registered_orchestrator(&built.app_state).await;

        assert!(result.is_err(), "expected restart to fail");
        assert!(
            registered_orchestrator_guard(&built.app_state).is_some(),
            "expected existing runtime to stay registered on restart failure"
        );

        if let Some(runtime) = take_registered_orchestrator(&built.app_state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn start_orchestrator_for_app_accepts_relative_config_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let todo_path = temp_dir.path().join("TODO.md");
        let config_path = PathBuf::from("config.yaml");
        let yaml = format!(
            "tracker:\n  kind: todo_file\n  path: {}\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
            todo_path.display()
        );
        let document_state = parse_raw_yaml(config_path.clone(), yaml);
        let built = build_app_state(config_path, document_state, EventBus::new());

        let runtime = start_orchestrator_for_app(&built.app_state).await;

        let runtime = runtime
            .expect("relative config path should not fail")
            .expect("relative config path should start an orchestrator");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn transactional_reload_durable_resources_flush_before_replacement_commit() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let initial_yaml = valid_config_yaml(Some(temp_dir.path().to_str().unwrap()));
        let document_state = parse_raw_yaml(config_path.clone(), initial_yaml);
        let built = build_app_state(config_path.clone(), document_state.clone(), EventBus::new());
        let candidate = parse_raw_yaml(
            config_path,
            valid_config_yaml(Some(temp_dir.path().to_str().unwrap()))
                .replace("interval_ms: 1234", "interval_ms: 4321"),
        );

        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer
            .append(&TranscriptRecord {
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
                run_id: "run-durable".to_string(),
                issue_identifier: "repo#durable".to_string(),
                step_name: "build".to_string(),
                attempt: 1,
                sequence: 1,
                timestamp: Utc::now(),
                kind: TranscriptRecordKind::ToolCall,
                payload: serde_json::json!({"name": "first"}),
                truncated: None,
            })
            .await
            .unwrap();
        let transcript_path = writer.transcript_path("run-durable", "build").unwrap();
        let transcript_lock = std::fs::OpenOptions::new()
            .append(true)
            .open(transcript_path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(transcript_lock.as_raw_fd(), libc::LOCK_EX) },
            0
        );

        let mut history_connection =
            rusqlite::Connection::open(&built.app_state.history_db_path).unwrap();
        let history_transaction = history_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();

        let prepared = prepare_orchestrator_runtime(&built.app_state, &document_state)
            .await
            .unwrap()
            .unwrap();
        prepared
            .orchestrator
            .persist_timeline_for_test(TimelineEventRecord {
                run_id: "run-durable".to_string(),
                issue_identifier: "repo#durable".to_string(),
                sequence: 7,
                timestamp: Utc::now(),
                event_type: "step_completed".to_string(),
                step_name: Some("build".to_string()),
                attempt: 1,
                detail: "old runtime completed persistence".to_string(),
                verdict: Some("succeeded".to_string()),
                tool_name: None,
            });
        prepared
            .orchestrator
            .persist_transcript_for_test(TranscriptPersistRequest {
                run_id: "run-durable".to_string(),
                issue_identifier: "repo#durable".to_string(),
                step_name: "build".to_string(),
                attempt: 1,
                timestamp: Utc::now(),
                kind: TranscriptRecordKind::ToolResult,
                payload: serde_json::json!({"text": "second"}),
                truncated: None,
            });
        built
            .app_state
            .orchestrator_state
            .write()
            .await
            .timeline_sequences
            .insert("run-durable".to_string(), 7);
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: launch_orchestrator_runtime(prepared),
        });

        let mut reload = tokio::spawn({
            let app_state = built.app_state.clone();
            async move {
                apply_prepared_config_candidate_with_timeout(
                    &app_state,
                    candidate,
                    None,
                    Duration::from_secs(2),
                    || Ok(()),
                )
                .await
            }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut reload)
                .await
                .is_err(),
            "SQLite persistence must finish before replacement commits"
        );

        drop(history_transaction);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if built
                    .app_state
                    .history_store
                    .as_ref()
                    .unwrap()
                    .max_timeline_sequence("run-durable")
                    .await
                    .unwrap()
                    == Some(7)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("old timeline persistence should flush after its lock is released");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !reload.is_finished(),
            "transcript persistence must finish before replacement commits"
        );
        assert_eq!(
            unsafe { libc::flock(transcript_lock.as_raw_fd(), libc::LOCK_UN) },
            0
        );

        assert!(reload.await.unwrap().unwrap());
        let timeline = built
            .app_state
            .history_store
            .as_ref()
            .unwrap()
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-durable".to_string(),
                    cursor: None,
                    limit: None,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            timeline
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![7]
        );
        let transcript = read_transcript_page(temp_dir.path(), "run-durable", "build", None, None)
            .await
            .unwrap();
        assert_eq!(
            transcript
                .records
                .iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            built
                .app_state
                .orchestrator_state
                .read()
                .await
                .timeline_sequences
                .get("run-durable"),
            Some(&7)
        );
        assert_eq!(
            built
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            4321
        );

        clear_registered_orchestrator(&built.app_state).await;
    }

    #[tokio::test]
    async fn transactional_reload_handover_runtime_replacement_timeout_retains_old_generation_until_retry(
    ) {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = parse_raw_yaml(config_path, valid_config_yaml(None));
        let built = build_app_state(
            temp_dir.path().join("config.yaml"),
            document_state,
            EventBus::new(),
        );
        let candidate = parse_raw_yaml(
            temp_dir.path().join("config.yaml"),
            valid_config_yaml(None).replace("interval_ms: 1234", "interval_ms: 4321"),
        );

        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (command_tx, _command_rx) = mpsc::channel(1);
        let (completion_tx, completion) = watch::channel(false);
        let (_worker_event_tx, worker_event_rx) = mpsc::channel(1);
        let (quiesce_tx, quiesce_rx) = tokio::sync::oneshot::channel();
        let (tail_release_tx, tail_release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = quiesce_rx.await;
            let _ = completion_tx.send(true);
            let _ = tail_release_rx.await;
        });
        let old_runtime = OrchestratorRuntime {
            id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
            shutdown_tx,
            completion,
            quiescing: QuiescingLatch::default(),
            command_tx,
            _worker_event_receiver: Arc::new(tokio::sync::Mutex::new(worker_event_rx)),
            task,
        };
        let old_id = old_runtime.id;
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: old_runtime,
        });
        {
            let mut state = built.app_state.orchestrator_state.write().await;
            state.timeline_sequences.insert("run-live".to_string(), 41);
            state.pending_terminal_transitions.insert(
                "issue-terminal".to_string(),
                crate::orchestrator::state::PendingTerminalEntry {
                    identifier: "repo#terminal".to_string(),
                    run_id: Some("run-terminal".to_string()),
                    issue: None,
                    transition: crate::orchestrator::pipeline_journal::PendingTerminalTransition {
                        target_state: "Failed".to_string(),
                        outcome: crate::orchestrator::pipeline_journal::TerminalOutcome::Failed,
                        attempt: 1,
                        last_error: Some("persist me".to_string()),
                        last_attempted_at: None,
                        tracker_write_confirmed: false,
                        history_record: None,
                    },
                },
            );
        }

        let first = apply_prepared_config_candidate_with_timeout(
            &built.app_state,
            candidate.clone(),
            None,
            Duration::from_millis(20),
            || Ok(()),
        )
        .await;
        assert!(matches!(first, Err(EnsembleError::RuntimeBusy)));
        {
            let registered = registered_orchestrator_guard(&built.app_state);
            let retained = registered.as_ref().unwrap();
            assert_eq!(retained.phase, RuntimePhase::QuiescingForReplacement);
            assert_eq!(retained.runtime.id, old_id);
            assert!(!retained.runtime.task.is_finished());
        }
        assert_eq!(
            built
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            1234,
            "a busy handover must keep the candidate invisible"
        );

        let concurrent = apply_prepared_config_candidate_with_timeout(
            &built.app_state,
            candidate.clone(),
            None,
            Duration::from_millis(20),
            || Ok(()),
        )
        .await;
        assert!(matches!(concurrent, Err(EnsembleError::RuntimeBusy)));

        quiesce_tx.send(()).unwrap();
        let old_completion = {
            registered_orchestrator_guard(&built.app_state)
                .as_ref()
                .unwrap()
                .runtime
                .completion
                .clone()
        };
        let mut completion_observer = old_completion.clone();
        completion_observer.changed().await.unwrap();
        assert!(*old_completion.borrow());
        assert!(
            matches!(
                apply_prepared_config_candidate_with_timeout(
                    &built.app_state,
                    candidate.clone(),
                    None,
                    Duration::from_millis(20),
                    || Ok(()),
                )
                .await,
                Err(EnsembleError::RuntimeBusy)
            ),
            "semantic quiescence alone must not retire a still-running task"
        );
        tail_release_tx.send(()).unwrap();
        assert!(
            wait_for_registered_runtime_completion(
                &built.app_state,
                old_id,
                old_completion,
                Duration::from_secs(1),
            )
            .await,
            "old runtime should become quiescent"
        );

        assert!(apply_prepared_config_candidate_with_timeout(
            &built.app_state,
            candidate,
            None,
            Duration::from_secs(1),
            || Ok(()),
        )
        .await
        .unwrap());
        {
            let registered = registered_orchestrator_guard(&built.app_state);
            let replacement = registered.as_ref().unwrap();
            assert_eq!(replacement.phase, RuntimePhase::Running);
            assert_ne!(replacement.runtime.id, old_id);
        }
        assert_eq!(
            built
                .app_state
                .orchestrator_state
                .read()
                .await
                .poll_interval_ms,
            4321
        );
        let state = built.app_state.orchestrator_state.read().await;
        assert_eq!(state.timeline_sequences.get("run-live"), Some(&41));
        assert!(
            state
                .pending_terminal_transitions
                .contains_key("issue-terminal"),
            "runtime replacement must preserve pending terminal ownership"
        );
        drop(state);
        assert_eq!(
            built
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            4321
        );

        if let Some(runtime) = take_registered_orchestrator(&built.app_state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn runtime_replacement_cancelled_wait_retains_quiescing_owner() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = parse_raw_yaml(config_path.clone(), valid_config_yaml(None));
        let built = build_app_state(config_path, document_state, EventBus::new());

        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (command_tx, _command_rx) = mpsc::channel(1);
        let (completion_tx, completion) = watch::channel(false);
        let (_worker_event_tx, worker_event_rx) = mpsc::channel(1);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = release_rx.await;
            let _ = completion_tx.send(true);
        });
        let old_runtime = OrchestratorRuntime {
            id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
            shutdown_tx,
            completion,
            quiescing: QuiescingLatch::default(),
            command_tx,
            _worker_event_receiver: Arc::new(tokio::sync::Mutex::new(worker_event_rx)),
            task,
        };
        let old_id = old_runtime.id;
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: old_runtime,
        });

        let replacement_wait = tokio::spawn({
            let app_state = built.app_state.clone();
            async move {
                start_or_replace_registered_orchestrator_with_timeout(
                    &app_state,
                    Duration::from_secs(5),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let quiescing = registered_orchestrator_guard(&built.app_state)
                    .as_ref()
                    .is_some_and(|registered| {
                        registered.phase == RuntimePhase::QuiescingForReplacement
                    });
                if quiescing {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("replacement should publish quiescing state before waiting");
        replacement_wait.abort();
        assert!(replacement_wait.await.unwrap_err().is_cancelled());

        {
            let registered = registered_orchestrator_guard(&built.app_state);
            let retained = registered.as_ref().unwrap();
            assert_eq!(retained.phase, RuntimePhase::QuiescingForReplacement);
            assert_eq!(retained.runtime.id, old_id);
            assert!(!retained.runtime.task.is_finished());
        }

        release_tx.send(()).unwrap();
        let old_completion = {
            registered_orchestrator_guard(&built.app_state)
                .as_ref()
                .unwrap()
                .runtime
                .completion
                .clone()
        };
        assert!(
            wait_for_registered_runtime_completion(
                &built.app_state,
                old_id,
                old_completion,
                Duration::from_secs(1),
            )
            .await
        );
        assert!(start_or_replace_registered_orchestrator_with_timeout(
            &built.app_state,
            Duration::from_secs(1),
        )
        .await
        .unwrap());

        if let Some(runtime) = take_registered_orchestrator(&built.app_state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn runtime_replacement_cannot_race_registered_shutdown() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = parse_raw_yaml(config_path.clone(), valid_config_yaml(None));
        let built = build_app_state(config_path, document_state, EventBus::new());

        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (command_tx, _command_rx) = mpsc::channel(1);
        let (completion_tx, completion) = watch::channel(false);
        let (_worker_event_tx, worker_event_rx) = mpsc::channel(1);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = release_rx.await;
            let _ = completion_tx.send(true);
        });
        let old_runtime = OrchestratorRuntime {
            id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
            shutdown_tx,
            completion,
            quiescing: QuiescingLatch::default(),
            command_tx,
            _worker_event_receiver: Arc::new(tokio::sync::Mutex::new(worker_event_rx)),
            task,
        };
        let old_id = old_runtime.id;
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: old_runtime,
        });

        let shutdown = tokio::spawn({
            let app_state = built.app_state.clone();
            async move { clear_registered_orchestrator(&app_state).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let shutdown_owner_retained = registered_orchestrator_guard(&built.app_state)
                    .as_ref()
                    .is_some_and(|registered| {
                        registered.phase == RuntimePhase::QuiescingForShutdown
                            && registered.runtime.id == old_id
                    });
                if shutdown_owner_retained {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("registered shutdown should retain and publish its exact owner");

        assert!(matches!(
            start_or_replace_registered_orchestrator_with_timeout(
                &built.app_state,
                Duration::from_millis(20),
            )
            .await,
            Err(EnsembleError::RuntimeBusy)
        ));

        release_tx.send(()).unwrap();
        shutdown.await.unwrap();
        assert!(registered_orchestrator_guard(&built.app_state).is_none());
    }

    #[tokio::test]
    async fn runtime_replacement_closed_incomplete_owner_remains_fail_closed() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = parse_raw_yaml(config_path.clone(), valid_config_yaml(None));
        let built = build_app_state(config_path, document_state, EventBus::new());

        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (command_tx, _command_rx) = mpsc::channel(1);
        let (completion_tx, completion) = watch::channel(false);
        drop(completion_tx);
        let (_worker_event_tx, worker_event_rx) = mpsc::channel(1);
        let task = tokio::spawn(async {});
        let old_runtime = OrchestratorRuntime {
            id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
            shutdown_tx,
            completion,
            quiescing: QuiescingLatch::default(),
            command_tx,
            _worker_event_receiver: Arc::new(tokio::sync::Mutex::new(worker_event_rx)),
            task,
        };
        let old_id = old_runtime.id;
        *registered_orchestrator_guard(&built.app_state) = Some(RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: old_runtime,
        });

        for _ in 0..2 {
            let result = start_or_replace_registered_orchestrator_with_timeout(
                &built.app_state,
                Duration::from_millis(20),
            )
            .await;
            assert!(matches!(result, Err(EnsembleError::RuntimeBusy)));
            let registered = registered_orchestrator_guard(&built.app_state);
            let retained = registered.as_ref().unwrap();
            assert_eq!(retained.phase, RuntimePhase::QuiescingForReplacement);
            assert_eq!(retained.runtime.id, old_id);
            assert!(!retained.runtime.is_complete());
        }

        take_registered_orchestrator(&built.app_state)
            .unwrap()
            .abort();
    }

    #[test]
    fn take_registered_orchestrator_recovers_from_poisoned_mutex() {
        let config_path = PathBuf::from("/tmp/missing-config.yaml");
        let built = build_app_state(
            config_path.clone(),
            missing_config_state(config_path),
            EventBus::new(),
        );
        let runtime_registry = built.app_state.orchestrator_runtime.clone();

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = runtime_registry.inner.lock().unwrap();
            panic!("poison orchestrator runtime mutex");
        }));

        let runtime = take_registered_orchestrator(&built.app_state);

        assert!(
            runtime.is_none(),
            "poisoned mutex should still be recoverable"
        );
    }
}
