use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::api::router::{create_api_router, AppState};
use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

use crate::embedded_ui::spa_router;

#[derive(Debug, Clone)]
pub struct WebArgs {
    pub config_path: PathBuf,
    pub host: String,
    pub port: Option<u16>,
}

/// Run the orchestrator with web UI (SPA + API server)
pub async fn execute(args: WebArgs) -> ExitCode {
    init_logging();

    info!(
        config_path = %args.config_path.display(),
        host = %args.host,
        port = ?args.port,
        "starting ensemble in web mode"
    );

    // Load and validate ensemble.yaml
    let config = match load_config(&args.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %args.config_path.display(), "failed to load config");
            eprintln!(
                "error: failed to load {}: {}",
                args.config_path.display(),
                e
            );
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = validate_config(&config) {
        error!(error = %e, "config validation failed");
        eprintln!("error: config validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    if let Err(e) = build_dag(&config.steps) {
        error!(error = %e, "step DAG validation failed");
        eprintln!("error: step DAG validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    info!(
        tracker_kind = %config.tracker.kind,
        poll_interval_ms = config.polling.interval_ms,
        max_concurrent = config.concurrency.max_concurrent_agents,
        "config loaded successfully"
    );

    // Create orchestrator state
    let orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // Build app state for API
    let workspace_root = config
        .workspace
        .root
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("ensemble_workspaces")
                .display()
                .to_string()
        });
    let history_path = std::path::PathBuf::from(&workspace_root).join("ensemble_history.jsonl");
    let app_state = AppState {
        orchestrator_state: orchestrator_state.clone(),
        refresh_requested: refresh_notify.clone(),
        workspace_root,
        history_path,
        event_bus: EventBus::new(),
        config: Arc::new(config.clone()),
        config_path: args.config_path.display().to_string(),
    };

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state);
    let spa_router = spa_router();

    let router = api_router.merge(spa_router);

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

    let actual_addr = listener.local_addr().unwrap();
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

    // TODO: Start orchestrator poll loop (Plan 3 wires this up).
    info!("ensemble web mode is running (orchestrator loop placeholder, press Ctrl+C to stop)");

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
