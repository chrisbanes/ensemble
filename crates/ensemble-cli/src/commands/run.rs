use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info, warn};

use ensemble_core::api::bootstrap::{
    build_app_state, start_or_replace_registered_orchestrator, take_registered_orchestrator,
};
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

    // Mark this runtime as headless so finalize policies can adapt.
    std::env::set_var("ENSEMBLE_HEADLESS", "1");

    {
        let document_state = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        if let Some(config_guard) = document_state.active_config.as_ref() {
            for repo in &config_guard.repos {
                if repo.finalize.enabled && repo.finalize.approval_required {
                    warn!(
                        repo_path = %repo.path,
                        "approval-required finalize configured in headless mode; finalize will be skipped"
                    );
                }
            }
        }
    }

    match start_or_replace_registered_orchestrator(&prepared.app_state).await {
        Ok(true) => {}
        Ok(false) => {
            error!("runnable config did not produce an orchestrator runtime");
            eprintln!("error: runnable config did not produce an orchestrator runtime");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            error!(error = %e, "failed to start orchestrator");
            eprintln!("error: failed to start orchestrator: {}", e);
            return ExitCode::FAILURE;
        }
    }

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

    if let Some(runtime) = take_registered_orchestrator(&prepared.app_state) {
        runtime.shutdown().await;
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
