use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

#[derive(Debug, Clone)]
pub struct RunArgs {
    pub config_path: PathBuf,
}

/// Run the orchestrator in headless mode (terminal output only)
pub async fn execute(args: RunArgs) -> ExitCode {
    init_logging();
    
    info!(
        config_path = %args.config_path.display(),
        "starting ensemble in headless mode"
    );

    // Load and validate ensemble.yaml
    let config = match load_config(&args.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %args.config_path.display(), "failed to load config");
            eprintln!("error: failed to load {}: {}", args.config_path.display(), e);
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
    let _orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let _refresh_notify = Arc::new(tokio::sync::Notify::new());

    // TODO: Start orchestrator poll loop (Plan 3 wires this up).
    info!("ensemble is running in headless mode (orchestrator loop placeholder, press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}
