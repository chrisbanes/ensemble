use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use ensemble_core::api::router::{create_api_router, AppState, ConfigRuntime};
use ensemble_core::config::draft::load_config_state;
use ensemble_core::config::location::resolve_config_dir_for_cli;
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;

use crate::embedded_ui::spa_router;

/// Default poll interval in milliseconds (30 seconds).
const DEFAULT_POLL_INTERVAL_MS: u64 = 30000;

/// Default maximum number of concurrent agents.
const DEFAULT_MAX_CONCURRENT_AGENTS: u32 = 10;

#[derive(Debug, Clone)]
pub struct WebArgs {
    pub config_dir: Option<PathBuf>,
    pub host: String,
    pub port: Option<u16>,
}

/// Run the orchestrator with web UI (SPA + API server)
///
/// This now serves the UI and API regardless of config state.
/// If config is missing or invalid, the UI will show the setup wizard.
pub async fn execute(args: WebArgs) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            error!(error = %e, "failed to get current directory");
            eprintln!("error: failed to get current directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let resolved = match resolve_config_dir_for_cli(
        args.config_dir.as_deref(),
        std::env::var_os("ENSEMBLE_CONFIG_DIR"),
        &cwd,
    ) {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "failed to resolve config directory");
            eprintln!("error: failed to resolve config directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    info!(
        config_dir = %resolved.config_dir.display(),
        config_path = %resolved.config_path.display(),
        host = %args.host,
        port = ?args.port,
        "starting ensemble in web mode"
    );

    // Load config state - may be missing, syntax error, or parsed
    let document_state = match load_config_state(&resolved.config_path) {
        Ok(state) => state,
        Err(e) => {
            error!(error = %e, path = %resolved.config_path.display(), "failed to load config state");
            // Create a default missing state
            ensemble_core::config::draft::ConfigDocumentState {
                path: resolved.config_path.clone(),
                kind: ensemble_core::config::draft::ConfigStateKind::Missing,
                raw_yaml: None,
                document: None,
                active_config: None,
                validation: ensemble_core::config::draft::DraftValidationReport::default(),
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
            "config loaded successfully - orchestrator can run"
        );
    } else {
        warn!(
            config_state = ?document_state.kind,
            "no valid config found - serving UI in setup mode"
        );
        eprintln!(
            "warning: no valid config found at {}",
            resolved.config_path.display()
        );
        eprintln!(
            "  The UI will show the setup wizard. Configure ensemble to start the orchestrator."
        );
    }

    // Create orchestrator state (only if we have runnable config)
    let orchestrator_state = if has_runnable_config {
        let config = document_state.active_config.as_ref().unwrap();
        Arc::new(RwLock::new(OrchestratorState::new(
            config.polling.interval_ms,
            config.concurrency.max_concurrent_agents,
        )))
    } else {
        // Default orchestrator state when no config available
        Arc::new(RwLock::new(OrchestratorState::new(
            DEFAULT_POLL_INTERVAL_MS,
            DEFAULT_MAX_CONCURRENT_AGENTS,
        )))
    };

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // Build app state for API
    let workspace_root = if let Some(ref config) = document_state.active_config {
        config
            .workspace
            .root
            .as_deref()
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join("ensemble_workspaces")
                    .display()
                    .to_string()
            })
    } else {
        std::env::temp_dir()
            .join("ensemble_workspaces")
            .display()
            .to_string()
    };

    let history_path = std::path::PathBuf::from(&workspace_root).join("ensemble_history.jsonl");

    let app_state = AppState {
        orchestrator_state: orchestrator_state.clone(),
        refresh_requested: refresh_notify.clone(),
        workspace_root,
        history_path,
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path: resolved.config_path,
            document_state: Arc::new(RwLock::new(document_state)),
        },
    };

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state);
    let spa_router = spa_router();

    let router = api_router.merge(spa_router);

    // Warn if binding to a non-loopback address (exposes unauthenticated API)
    let is_loopback = args.host == "127.0.0.1" || args.host == "::1" || args.host == "localhost";
    if !is_loopback {
        warn!(
            host = %args.host,
            "binding to a non-loopback address exposes the API without authentication"
        );
        eprintln!(
            "warning: binding to {} exposes the ensemble API to the network without authentication",
            args.host
        );
    }

    // Determine port
    let port = args.port.unwrap_or(0); // 0 = let OS assign available port
    let bind_addr = format!("{}:{}", args.host, port);

    info!(addr = %bind_addr, "starting HTTP server");

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            error!(error = %e, addr = %bind_addr, "failed to bind HTTP server");
            eprintln!("error: failed to bind HTTP server on {}: {}", bind_addr, e);
            return ExitCode::FAILURE;
        }
    };

    let actual_addr = match listener.local_addr() {
        Ok(addr) => addr,
        Err(e) => {
            error!(error = %e, "failed to get local address");
            eprintln!("error: failed to get local address: {}", e);
            return ExitCode::FAILURE;
        }
    };
    info!(
        addr = %actual_addr,
        "HTTP server listening. Open http://{} in your browser",
        actual_addr
    );

    // Start server in background
    let server_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            error!(error = %e, "HTTP server error");
        }
    });

    // Only start orchestrator if we have a valid config
    if has_runnable_config {
        info!("orchestrator can start (loop placeholder)");
    } else {
        info!("orchestrator disabled - waiting for valid config via setup wizard");
    }

    info!("ensemble web mode is running (press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    // Clean shutdown
    server_handle.abort();
    info!("HTTP server stopped");

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_web_args() {
        let args = WebArgs {
            config_dir: Some(PathBuf::from("/tmp/test")),
            host: "0.0.0.0".to_string(),
            port: Some(8080),
        };
        assert_eq!(args.config_dir, Some(PathBuf::from("/tmp/test")));
        assert_eq!(args.host, "0.0.0.0");
        assert_eq!(args.port, Some(8080));
    }

    #[test]
    fn test_web_args_defaults() {
        let args = WebArgs {
            config_dir: None,
            host: "127.0.0.1".to_string(),
            port: None,
        };
        assert!(args.config_dir.is_none());
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.port, None);
    }
}
