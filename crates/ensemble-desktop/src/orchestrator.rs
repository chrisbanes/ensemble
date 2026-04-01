use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

/// Desktop orchestrator state
#[derive(Clone)]
pub struct DesktopOrchestrator {
    pub state: Arc<RwLock<OrchestratorState>>,
    #[allow(dead_code)]
    pub event_bus: EventBus,
    pub config_path: String,
}

impl DesktopOrchestrator {
    /// Initialize the orchestrator from config
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

    /// Start the orchestrator loop (placeholder for now)
    pub async fn start(&self) -> Result<(), String> {
        info!("Desktop orchestrator started (placeholder)");
        // TODO: Implement actual orchestrator loop
        Ok(())
    }

    /// Stop the orchestrator
    #[allow(dead_code)]
    pub async fn stop(&self) {
        info!("Desktop orchestrator stopped");
    }
}

/// Tauri command to get orchestrator state snapshot
#[tauri::command]
pub async fn get_state(
    orchestrator: tauri::State<'_, DesktopOrchestrator>,
) -> Result<serde_json::Value, String> {
    let _state = orchestrator.state.read().await;

    // Build state snapshot (simplified for now)
    let snapshot = serde_json::json!({
        "status": "running",
        "running_count": 0,
        "claimed_count": 0,
        "config_path": orchestrator.config_path,
    });

    Ok(snapshot)
}

/// Tauri command to trigger refresh
#[tauri::command]
pub async fn trigger_refresh(
    _orchestrator: tauri::State<'_, DesktopOrchestrator>,
) -> Result<(), String> {
    info!("Refresh requested via desktop UI");
    // TODO: Implement actual refresh
    Ok(())
}
