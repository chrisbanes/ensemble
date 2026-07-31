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
    ManualStepRetryCommand, Orchestrator, OrchestratorCommand, OrchestratorRuntimeParts,
    QuiescingLatch,
};
use crate::tracker::model::RetryEntry;
use crate::tracker::{create_tracker, IssueTracker};
use crate::transcript::events::TranscriptEventBus;
use crate::workspace::manager::WorkspaceManager;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::MutexGuard;
use std::time::Duration;
use tokio::sync::{mpsc, watch, RwLock};
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
        let Some(command_tx) = command_tx else {
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

struct PreparedOrchestratorRuntime {
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

async fn prepare_orchestrator_runtime(
    app_state: &AppState,
) -> Result<Option<PreparedOrchestratorRuntime>, EnsembleError> {
    let active_config = {
        app_state
            .config_runtime
            .document_state
            .read()
            .await
            .active_config
            .clone()
    };

    let Some(config) = active_config else {
        return Ok(None);
    };

    let config = Arc::new(RwLock::new(config.clone()));
    let tracker: Arc<dyn IssueTracker> = Arc::from(create_tracker(&config.read().await.tracker)?);
    // `AcpAgentRunner` is the shared runtime dispatcher: `acpx_agent` steps run through the
    // acpx CLI/session runtime, while explicit direct configs keep the ACP stdio path.
    let agent_runner: Arc<dyn AgentRunner> = Arc::new(AcpAgentRunner::new_with_document_state(
        Arc::clone(&config),
        Arc::clone(&app_state.config_runtime.document_state),
    ));
    let workspace_mgr = WorkspaceManager::new(
        Path::new(&app_state.workspace_root),
        Some(config.read().await.repos.clone()),
    )?;
    let config_dir = config_dir_for_path(&app_state.config_runtime.config_path)?;
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let orchestrator = Orchestrator::new_with_state(
        OrchestratorRuntimeParts {
            state: Arc::clone(&app_state.orchestrator_state),
            config,
            tracker,
            agent_runner,
            workspace_mgr,
            refresh_requested: Arc::clone(&app_state.refresh_requested),
            cancellation_registry: app_state.cancellation_registry.clone(),
            event_bus: app_state.event_bus.clone(),
            transcript_event_bus: app_state.transcript_event_bus.clone(),
            workspace_root: PathBuf::from(&app_state.workspace_root),
        },
        &config_dir,
        shutdown_rx,
    );

    Ok(Some(PreparedOrchestratorRuntime {
        orchestrator,
        shutdown_tx,
    }))
}

fn launch_orchestrator_runtime(prepared: PreparedOrchestratorRuntime) -> OrchestratorRuntime {
    let PreparedOrchestratorRuntime {
        mut orchestrator,
        shutdown_tx,
    } = prepared;
    let worker_event_receiver = orchestrator.worker_event_receiver_owner();
    let quiescing = orchestrator.quiescing_latch_owner();
    let command_tx = orchestrator.command_sender_owner();
    let (completion_tx, completion) = watch::channel(false);
    let task = tokio::spawn(async move {
        let quiesced = orchestrator.run().await;
        if quiesced {
            let _ = completion_tx.send(true);
        }
    });

    OrchestratorRuntime {
        id: NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed),
        shutdown_tx,
        completion,
        quiescing,
        command_tx,
        _worker_event_receiver: worker_event_receiver,
        task,
    }
}

pub async fn start_orchestrator_for_app(
    app_state: &AppState,
) -> Result<Option<OrchestratorRuntime>, EnsembleError> {
    Ok(prepare_orchestrator_runtime(app_state)
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
    start_or_replace_registered_orchestrator_with_timeout(app_state, ORCHESTRATOR_RESTART_TIMEOUT)
        .await
}

async fn start_or_replace_registered_orchestrator_with_timeout(
    app_state: &AppState,
    restart_timeout: Duration,
) -> Result<bool, EnsembleError> {
    let prepared = prepare_orchestrator_runtime(app_state).await?;
    let started = prepared.is_some();

    let (runtime_id, completion) = {
        let mut registered = registered_orchestrator_guard(app_state);
        let Some(existing) = registered.as_mut() else {
            *registered = prepared.map(|prepared| RegisteredRuntime {
                phase: RuntimePhase::Running,
                runtime: launch_orchestrator_runtime(prepared),
            });
            return Ok(started);
        };

        match existing.phase {
            RuntimePhase::QuiescingForShutdown => return Err(EnsembleError::RuntimeBusy),
            RuntimePhase::QuiescingForReplacement if !existing.runtime.is_complete() => {
                return Err(EnsembleError::RuntimeBusy);
            }
            RuntimePhase::Running | RuntimePhase::QuiescingForReplacement => {}
        }
        existing.phase = RuntimePhase::QuiescingForReplacement;
        existing.runtime.request_shutdown();
        (existing.runtime.id, existing.runtime.completion.clone())
    };

    if !wait_for_registered_runtime_completion(app_state, runtime_id, completion, restart_timeout)
        .await
    {
        return Err(EnsembleError::RuntimeBusy);
    }

    let retired = {
        let mut registered = registered_orchestrator_guard(app_state);
        let replaceable = registered.as_ref().is_some_and(|existing| {
            existing.phase == RuntimePhase::QuiescingForReplacement
                && existing.runtime.id == runtime_id
                && existing.runtime.is_complete()
        });
        if !replaceable {
            return Err(EnsembleError::RuntimeBusy);
        }
        let retired = registered.take();
        *registered = prepared.map(|prepared| RegisteredRuntime {
            phase: RuntimePhase::Running,
            runtime: launch_orchestrator_runtime(prepared),
        });
        retired
    };
    drop(retired);
    Ok(started)
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
    async fn runtime_replacement_timeout_retains_quiescing_owner_until_later_retry() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = parse_raw_yaml(config_path, valid_config_yaml(None));
        let built = build_app_state(
            temp_dir.path().join("config.yaml"),
            document_state,
            EventBus::new(),
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

        let first = start_or_replace_registered_orchestrator_with_timeout(
            &built.app_state,
            Duration::from_millis(20),
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

        let concurrent = start_or_replace_registered_orchestrator_with_timeout(
            &built.app_state,
            Duration::from_millis(20),
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
                start_or_replace_registered_orchestrator_with_timeout(
                    &built.app_state,
                    Duration::from_millis(20),
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

        assert!(start_or_replace_registered_orchestrator_with_timeout(
            &built.app_state,
            Duration::from_secs(1),
        )
        .await
        .unwrap());
        {
            let registered = registered_orchestrator_guard(&built.app_state);
            let replacement = registered.as_ref().unwrap();
            assert_eq!(replacement.phase, RuntimePhase::Running);
            assert_ne!(replacement.runtime.id, old_id);
        }

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
