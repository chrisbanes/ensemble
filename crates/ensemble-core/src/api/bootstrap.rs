use crate::agent::{AcpAgentRunner, AgentRunner};
use crate::api::router::{AppState, ConfigRuntime};
use crate::config::draft::ConfigDocumentState;
use crate::config::ensemble::{default_workspace_root, ConcurrencyConfig, PollingConfig};
use crate::error::{ConfigError, EnsembleError};
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use crate::orchestrator::{Orchestrator, OrchestratorRuntimeParts};
use crate::tracker::{create_tracker, IssueTracker};
use crate::workspace::manager::WorkspaceManager;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::MutexGuard;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

pub struct PreparedApp {
    pub app_state: AppState,
    pub has_runnable_config: bool,
}

pub struct OrchestratorRuntime {
    shutdown_tx: mpsc::Sender<()>,
    task: JoinHandle<()>,
}

/// `std::sync::Mutex` is sufficient here because runtime registration only swaps an `Option`
/// and never holds the mutex guard across `.await`. A tokio mutex would add async overhead
/// without improving correctness for these tiny critical sections.
pub type RegisteredOrchestrator = Arc<std::sync::Mutex<Option<OrchestratorRuntime>>>;

struct PreparedOrchestratorRuntime {
    orchestrator: Orchestrator,
    shutdown_tx: mpsc::Sender<()>,
}

impl OrchestratorRuntime {
    pub fn request_shutdown(&self) {
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
}

pub fn orchestrator_state_from_document(
    document_state: &ConfigDocumentState,
) -> Arc<RwLock<OrchestratorState>> {
    let (poll_interval_ms, max_concurrent_agents) = document_state
        .active_config
        .as_ref()
        .map(|config| {
            (
                config.polling.interval_ms,
                config.concurrency.max_concurrent_agents,
            )
        })
        .unwrap_or_else(|| {
            (
                PollingConfig::default().interval_ms,
                ConcurrencyConfig::default().max_concurrent_agents,
            )
        });

    Arc::new(RwLock::new(OrchestratorState::new(
        poll_interval_ms,
        max_concurrent_agents,
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

    let app_state = AppState {
        orchestrator_state: orchestrator_state_from_document(&document_state),
        orchestrator_runtime: Arc::new(std::sync::Mutex::new(None)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root,
        history_path,
        event_bus,
        config_runtime: ConfigRuntime {
            config_path,
            document_state: Arc::new(RwLock::new(document_state)),
        },
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
) -> MutexGuard<'_, Option<OrchestratorRuntime>> {
    app_state
        .orchestrator_runtime
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
    let agent_runner: Arc<dyn AgentRunner> = Arc::new(AcpAgentRunner::new(Arc::clone(&config)));
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
    let task = tokio::spawn(async move {
        orchestrator.run().await;
    });

    OrchestratorRuntime { shutdown_tx, task }
}

pub async fn start_orchestrator_for_app(
    app_state: &AppState,
) -> Result<Option<OrchestratorRuntime>, EnsembleError> {
    Ok(prepare_orchestrator_runtime(app_state)
        .await?
        .map(launch_orchestrator_runtime))
}

pub fn take_registered_orchestrator(app_state: &AppState) -> Option<OrchestratorRuntime> {
    registered_orchestrator_guard(app_state).take()
}

pub async fn clear_registered_orchestrator(app_state: &AppState) {
    if let Some(runtime) = take_registered_orchestrator(app_state) {
        runtime.shutdown().await;
    }
}

pub async fn start_or_replace_registered_orchestrator(
    app_state: &AppState,
) -> Result<bool, EnsembleError> {
    let prepared = prepare_orchestrator_runtime(app_state).await?;
    let started = prepared.is_some();

    if let Some(runtime) = take_registered_orchestrator(app_state) {
        runtime.shutdown().await;
    }

    *registered_orchestrator_guard(app_state) = prepared.map(launch_orchestrator_runtime);
    Ok(started)
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
        *built.app_state.orchestrator_runtime.lock().unwrap() = Some(runtime);

        clear_registered_orchestrator(&built.app_state).await;

        assert!(built
            .app_state
            .orchestrator_runtime
            .lock()
            .unwrap()
            .is_none());
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
        *built.app_state.orchestrator_runtime.lock().unwrap() = Some(runtime);

        let bad_yaml = "tracker:\n  kind: todo_file\n  path: /definitely/missing/dir/TODO.md\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n";
        let next_state = parse_raw_yaml(config_path, bad_yaml.to_string());
        *built.app_state.config_runtime.document_state.write().await = next_state;

        let result = start_or_replace_registered_orchestrator(&built.app_state).await;

        assert!(result.is_err(), "expected restart to fail");
        assert!(
            built
                .app_state
                .orchestrator_runtime
                .lock()
                .unwrap()
                .is_some(),
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

    #[test]
    fn take_registered_orchestrator_recovers_from_poisoned_mutex() {
        let config_path = PathBuf::from("/tmp/missing-config.yaml");
        let built = build_app_state(
            config_path.clone(),
            missing_config_state(config_path),
            EventBus::new(),
        );
        let runtime_registry = Arc::clone(&built.app_state.orchestrator_runtime);

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = runtime_registry.lock().unwrap();
            panic!("poison orchestrator runtime mutex");
        }));

        let runtime = take_registered_orchestrator(&built.app_state);

        assert!(
            runtime.is_none(),
            "poisoned mutex should still be recoverable"
        );
    }
}
