use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

/// Desktop orchestrator state.
///
/// This is initialized when a valid config is available.
/// The orchestrator runs in the background and manages pipeline execution.
#[derive(Clone)]
pub struct DesktopOrchestrator {
    #[allow(dead_code)]
    pub state: Arc<RwLock<OrchestratorState>>,
    #[allow(dead_code)]
    pub event_bus: EventBus,
    #[allow(dead_code)]
    pub config_path: String,
}

impl DesktopOrchestrator {
    /// Initialize the orchestrator from config.
    ///
    /// This validates the config and builds the DAG, returning an error
    /// if the config is invalid.
    pub async fn new(config_path: PathBuf) -> Result<Self, String> {
        info!(config_path = %config_path.display(), "Initializing desktop orchestrator from config.yaml");

        // Load config
        let config =
            load_config(&config_path).map_err(|e| format!("Failed to load config: {}", e))?;

        validate_config(&config).map_err(|e| format!("Config validation failed: {}", e))?;

        build_dag(&config.steps).map_err(|e| format!("DAG validation failed: {}", e))?;

        info!(
            tracker_kind = %config.tracker.kind,
            "Orchestrator config loaded from config.yaml"
        );

        let state = Arc::new(RwLock::new(OrchestratorState::new(
            config.polling.interval_ms,
            config.concurrency.max_concurrent_agents,
        )));

        Ok(Self {
            state,
            event_bus: EventBus::new(),
            config_path: config_path.display().to_string(),
        })
    }

    /// Start the orchestrator loop.
    #[allow(dead_code)]
    pub async fn start(&self) -> Result<(), String> {
        info!("Desktop orchestrator started");
        // TODO: Implement actual orchestrator loop
        Ok(())
    }

    /// Stop the orchestrator.
    #[allow(dead_code)]
    pub async fn stop(&self) {
        info!("Desktop orchestrator stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn test_orchestrator_init_with_valid_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");

        let valid_config = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let mut file = std::fs::File::create(&config_path).unwrap();
        file.write_all(valid_config.as_bytes()).unwrap();

        let orchestrator = DesktopOrchestrator::new(config_path).await;
        assert!(orchestrator.is_ok());
    }

    #[tokio::test]
    async fn test_orchestrator_init_fails_with_invalid_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");

        let invalid_config = r#"
tracker:
  kind: todo_file
agents: {}
steps: []
"#;

        let mut file = std::fs::File::create(&config_path).unwrap();
        file.write_all(invalid_config.as_bytes()).unwrap();

        let orchestrator = DesktopOrchestrator::new(config_path).await;
        assert!(orchestrator.is_err());
    }
}
