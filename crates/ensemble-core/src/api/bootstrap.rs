use crate::api::router::{AppState, ConfigRuntime};
use crate::config::draft::ConfigDocumentState;
use crate::config::ensemble::{default_workspace_root, ConcurrencyConfig, PollingConfig};
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct PreparedApp {
    pub app_state: AppState,
    pub has_runnable_config: bool,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::draft::{missing_config_state, parse_raw_yaml};
    use crate::observability::events::EventBus;

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
}
