use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info, warn};

use ensemble_core::api::bootstrap::{
    build_app_state, clear_registered_orchestrator, start_or_replace_registered_orchestrator,
};
use ensemble_core::config::draft::recover_and_load_config_state;
use ensemble_core::config::location::resolve_config_dir_for_cli;
use ensemble_core::config_watcher::start_config_watcher;
use ensemble_core::observability::events::EventBus;
use ensemble_core::workspace::finalize::FinalizeMode;

#[derive(Debug, Clone)]
pub struct RunArgs {
    pub config_dir: Option<PathBuf>,
    pub once: bool,
    pub deadline_ms: Option<u64>,
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

    let document_state = match recover_and_load_config_state(&resolved.config_path) {
        Ok(state) => state,
        Err(error) => {
            error!(error = %error, "failed to recover or load config");
            eprintln!("error: failed to recover or load config: {error}");
            return ExitCode::FAILURE;
        }
    };
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

    let watcher = start_config_watcher(prepared.app_state.clone());

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
                if repo.finalize.enabled
                    && !matches!(repo.finalize.mode, FinalizeMode::None)
                    && repo.finalize.approval_required
                {
                    warn!(
                        repo_path = %repo.path,
                        "approval-required finalize configured in headless mode; finalize will be skipped"
                    );
                }
            }
        }
    }

    if args.once {
        watcher.abort();
        let config = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await
            .active_config
            .clone()
            .expect("runnable config has active config");
        let deadline_ms = args
            .deadline_ms
            .unwrap_or(config.scheduler.one_shot.deadline_ms);
        if deadline_ms == 0 {
            eprintln!("error: --deadline-ms must be positive");
            return ExitCode::FAILURE;
        }
        let result = match ensemble_core::api::bootstrap::run_orchestrator_once_for_app(
            &prepared.app_state,
            std::time::Duration::from_millis(deadline_ms),
        )
        .await
        {
            Ok(Some(result)) => result,
            Ok(None) | Err(_) => {
                eprintln!("error: runnable config did not produce an orchestrator runtime");
                return ExitCode::FAILURE;
            }
        };
        println!(
            "{}",
            serde_json::to_string(&result).expect("drain result serializes")
        );
        return if matches!(
            result.outcome,
            ensemble_core::orchestrator::DrainOutcome::Success
        ) {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
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

    watcher.abort();
    clear_registered_orchestrator(&prepared.app_state).await;
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
            once: false,
            deadline_ms: None,
        };
        assert_eq!(args.config_dir, Some(PathBuf::from("/tmp/test")));
    }

    #[test]
    fn test_run_args_none() {
        let args = RunArgs {
            config_dir: None,
            once: false,
            deadline_ms: None,
        };
        assert!(args.config_dir.is_none());
    }
}
