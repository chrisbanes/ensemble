use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info};

use ensemble_core::api::bootstrap::{build_app_state, start_orchestrator_for_app};
use ensemble_core::config::draft::load_config_document_or_missing;
use ensemble_core::config::location::resolve_config_dir_for_cli;
use ensemble_core::observability::events::EventBus;

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

    let document_state = load_config_document_or_missing(&resolved.config_path);
    let prepared = build_app_state(
        resolved.config_path.clone(),
        document_state,
        EventBus::new(),
    );

    if !prepared.has_runnable_config {
        error!(
            path = %resolved.config_path.display(),
            "failed to load a runnable config"
        );
        eprintln!(
            "error: failed to load a runnable config from {}",
            resolved.config_path.display()
        );
        return ExitCode::FAILURE;
    }

    {
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
            "config loaded successfully"
        );
    }

    let orchestrator_runtime = match start_orchestrator_for_app(&prepared.app_state).await {
        Ok(Some(runtime)) => runtime,
        Ok(None) => unreachable!("runnable config should start an orchestrator"),
        Err(e) => {
            error!(error = %e, "failed to start orchestrator");
            eprintln!("error: failed to start orchestrator: {}", e);
            return ExitCode::FAILURE;
        }
    };

    info!("ensemble is running in headless mode (press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    orchestrator_runtime.shutdown().await;
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
