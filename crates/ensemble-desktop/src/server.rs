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
use tracing::{error, info, warn};

use ensemble_core::api::bootstrap::{
    build_app_state, replace_registered_orchestrator, take_registered_orchestrator,
};
use ensemble_core::api::router::create_api_router;
use ensemble_core::api::router::AppState;
use ensemble_core::config::draft::load_config_document_or_missing;
use ensemble_core::observability::events::EventBus;

use crate::embedded_ui::spa_router;
use crate::error::DesktopError;

/// Desktop server handle containing the URL and shutdown handle.
pub struct DesktopServer {
    pub url: url::Url,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    app_state: AppState,
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        // Desktop app shutdown is abrupt; abort avoids blocking Drop on async cleanup.
        if let Some(orchestrator) = take_registered_orchestrator(&self.app_state) {
            orchestrator.abort();
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

    let document_state = load_config_document_or_missing(&config_path);
    let prepared = build_app_state(config_path.clone(), document_state, event_bus);

    if prepared.has_runnable_config {
        let document_state = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        let config = document_state.active_config.as_ref().unwrap();
        info!(
            tracker_kind = %config.tracker.kind,
            poll_interval_ms = config.polling.interval_ms,
            max_concurrent = config.concurrency.max_concurrent_agents,
            "Config loaded successfully - orchestrator can run"
        );
    } else {
        let config_kind = {
            prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .kind
                .clone()
        };
        warn!(
            config_state = ?config_kind,
            "No valid config found - serving UI in setup mode"
        );
    }
    let app_state = prepared.app_state;
    if prepared.has_runnable_config {
        replace_registered_orchestrator(&app_state)
            .await
            .map_err(|error| DesktopError::ConfigLoadFailed(error.to_string()))?;
    }

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state.clone());
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
        app_state,
    })
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
