//! Local HTTP server for the desktop app.
//!
//! This module starts a loopback TCP server that serves:
//! - The Ensemble API at `/api/v1/*`
//! - WebSocket events at `/ws/*`
//! - The SPA UI for all other routes (fallback to index.html)
//!
//! This approach unifies the desktop and web frontends to use the same
//! API surface and UI assets.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use ensemble_core::api::router::{create_api_router, AppState, ConfigRuntime};
use ensemble_core::config::draft::load_config_state;
use ensemble_core::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
use ensemble_core::config::ensemble::{ConcurrencyConfig, PollingConfig};
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;

use crate::embedded_ui::spa_router;
use crate::error::DesktopError;

/// Desktop server handle containing the URL and shutdown handle.
pub struct DesktopServer {
    pub url: url::Url,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// Start the local HTTP server for the desktop app.
///
/// This server:
/// 1. Loads config state (which may be missing/invalid)
/// 2. Creates the API router with the appropriate state
/// 3. Binds to 127.0.0.1:0 (random available port)
/// 4. Serves both API and SPA routes
///
/// The server continues running regardless of config state.
/// If config is missing, the UI will show the setup wizard.
pub async fn start_desktop_server(
    config_dir: PathBuf,
    config_path: PathBuf,
    event_bus: EventBus,
) -> Result<DesktopServer, DesktopError> {
    info!(
        config_dir = %config_dir.display(),
        config_path = %config_path.display(),
        "Starting desktop HTTP server"
    );

    // Load config state - may be missing, syntax error, or parsed
    let document_state = match load_config_state(&config_path) {
        Ok(state) => state,
        Err(e) => {
            error!(error = %e, path = %config_path.display(), "Failed to load config state");
            ConfigDocumentState {
                path: config_path.clone(),
                kind: ConfigStateKind::Missing,
                raw_yaml: None,
                document: None,
                active_config: None,
                validation: DraftValidationReport::default(),
            }
        }
    };

    // Determine if we have a runnable config
    let has_runnable_config = document_state.active_config.is_some();

    if has_runnable_config {
        let config = document_state.active_config.as_ref().unwrap();
        info!(
            tracker_kind = %config.tracker.kind,
            poll_interval_ms = config.polling.interval_ms,
            max_concurrent = config.concurrency.max_concurrent_agents,
            "Config loaded successfully - orchestrator can run"
        );
    } else {
        warn!(
            config_state = ?document_state.kind,
            "No valid config found - serving UI in setup mode"
        );
    }

    // Create orchestrator state (only if we have runnable config)
    let orchestrator_state = create_orchestrator_state(&document_state);
    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // Build app state for API
    let workspace_root = determine_workspace_root(&document_state);
    let history_path = std::path::PathBuf::from(&workspace_root).join("ensemble_history.jsonl");

    let app_state = AppState {
        orchestrator_state: orchestrator_state.clone(),
        refresh_requested: refresh_notify.clone(),
        workspace_root,
        history_path,
        event_bus,
        config_runtime: ConfigRuntime {
            config_path,
            document_state: Arc::new(RwLock::new(document_state)),
        },
    };

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state);
    let spa_router = spa_router();

    let router = api_router.merge(spa_router);

    // Bind to loopback with random port
    let bind_addr = "127.0.0.1:0";
    info!(addr = %bind_addr, "Binding desktop HTTP server");

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| DesktopError::BindFailed {
            addr: bind_addr.to_string(),
            source: e,
        })?;

    let actual_addr = listener.local_addr()?;
    let server_url = url::Url::parse(&format!("http://{}", actual_addr))?;

    info!(
        url = %server_url,
        "Desktop HTTP server listening"
    );

    // Start server in background
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });

        if let Err(e) = server.await {
            error!(error = %e, "HTTP server error");
        }
    });

    Ok(DesktopServer {
        url: server_url,
        shutdown: Some(shutdown_tx),
    })
}

/// Create orchestrator state from config, using defaults if no config available.
fn create_orchestrator_state(
    document_state: &ConfigDocumentState,
) -> Arc<RwLock<OrchestratorState>> {
    if let Some(ref config) = document_state.active_config {
        Arc::new(RwLock::new(OrchestratorState::new(
            config.polling.interval_ms,
            config.concurrency.max_concurrent_agents,
        )))
    } else {
        let polling = PollingConfig::default();
        let concurrency = ConcurrencyConfig::default();
        Arc::new(RwLock::new(OrchestratorState::new(
            polling.interval_ms,
            concurrency.max_concurrent_agents,
        )))
    }
}

/// Determine workspace root from config, using default temp directory if unavailable.
fn determine_workspace_root(document_state: &ConfigDocumentState) -> String {
    if let Some(ref config) = document_state.active_config {
        config
            .workspace
            .root
            .as_deref()
            .map(|s| s.to_string())
            .unwrap_or_else(default_workspace_path)
    } else {
        default_workspace_path()
    }
}

/// Get the default workspace path in temp directory.
fn default_workspace_path() -> String {
    std::env::temp_dir()
        .join("ensemble_workspaces")
        .display()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_start_desktop_server_with_missing_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.yaml");

        // Server should start even without config
        let server =
            start_desktop_server(temp_dir.path().to_path_buf(), config_path, EventBus::new())
                .await
                .expect("Server should start with missing config");

        // URL should be valid
        assert_eq!(server.url.scheme(), "http");
        assert!(server.url.host().is_some());
    }

    #[tokio::test]
    async fn test_start_desktop_server_with_valid_config() {
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

        std::fs::write(&config_path, valid_config).unwrap();

        // Server should start with valid config
        let server =
            start_desktop_server(temp_dir.path().to_path_buf(), config_path, EventBus::new())
                .await
                .expect("Server should start with valid config");

        // URL should be valid
        assert_eq!(server.url.scheme(), "http");
        assert!(server.url.host().is_some());
    }
}
