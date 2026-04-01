use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::config::location::resolve_config_dir_for_cli;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

#[derive(Debug, Clone)]
pub struct RunArgs {
    pub config_dir: Option<PathBuf>,
}

/// Run the orchestrator in headless mode (terminal output only)
pub async fn execute(args: RunArgs) -> ExitCode {
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
        "starting ensemble in headless mode"
    );

    // Load and validate config.yaml
    let config = match load_config(&resolved.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %resolved.config_path.display(), "failed to load config");
            eprintln!(
                "error: failed to load {}: {}",
                resolved.config_path.display(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_args() {
        let args = RunArgs {
            config_dir: Some(PathBuf::from("/tmp/test")),
        };
        assert_eq!(args.config_dir, Some(PathBuf::from("/tmp/test")));
    }

    #[test]
    fn test_run_args_none() {
        let args = RunArgs { config_dir: None };
        assert!(args.config_dir.is_none());
    }
}
