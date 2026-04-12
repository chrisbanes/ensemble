use crate::agent::cancellation::new_cancellation_registry;
use crate::api::router::{AppState, ConfigRuntime};
use crate::config::draft::{
    missing_config_state, ConfigDocumentState, ConfigStateKind, DraftValidationReport,
};
use crate::config::ensemble::ConcurrencyConfig;
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

const MINIMAL_CONFIG: &str = "tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed";

pub(crate) fn parsed_document_state() -> ConfigDocumentState {
    ConfigDocumentState {
        path: PathBuf::from("ensemble.yaml"),
        kind: ConfigStateKind::Parsed,
        raw_yaml: None,
        document: None,
        active_config: Some(crate::config::ensemble::parse_config(MINIMAL_CONFIG).unwrap()),
        validation: DraftValidationReport::default(),
    }
}

pub(crate) fn app_state_with_document_state(document_state: ConfigDocumentState) -> AppState {
    AppState {
        orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(
            30000,
            &ConcurrencyConfig::default(),
        ))),
        orchestrator_runtime: Arc::new(std::sync::Mutex::new(None)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: "/tmp/workspaces".to_string(),
        history_path: PathBuf::from("/tmp/history.jsonl"),
        history_db_path: PathBuf::from("/tmp/.ensemble/history.db"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path: document_state.path.clone(),
            document_state: Arc::new(RwLock::new(document_state)),
        },
        cancellation_registry: new_cancellation_registry(),
    }
}

pub(crate) fn app_state_with_missing_config(
    config_path: PathBuf,
    workspace_root: &str,
) -> AppState {
    AppState {
        orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(
            30000,
            &ConcurrencyConfig::default(),
        ))),
        orchestrator_runtime: Arc::new(std::sync::Mutex::new(None)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: workspace_root.to_string(),
        history_path: PathBuf::from("/tmp/history.jsonl"),
        history_db_path: PathBuf::from("/tmp/.ensemble/history.db"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path: config_path.clone(),
            document_state: Arc::new(RwLock::new(missing_config_state(config_path))),
        },
        cancellation_registry: new_cancellation_registry(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_app_state_uses_requested_paths() {
        let app =
            app_state_with_missing_config(PathBuf::from("/tmp/config.yaml"), "/tmp/workspaces");
        assert_eq!(app.workspace_root, "/tmp/workspaces");
        assert_eq!(
            app.config_runtime.config_path,
            PathBuf::from("/tmp/config.yaml")
        );
    }
}
