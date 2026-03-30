use clap::Parser;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::api::router::{create_api_router, AppState};
use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(name = "ensemble", about = "Orchestrate coding agents")]
struct Cli {
    /// Path to ensemble.yaml
    #[arg(default_value = "ensemble.yaml")]
    config_path: PathBuf,

    /// HTTP server port (enables API + dashboard).
    /// CLI-only flag; not part of ensemble.yaml.
    #[arg(long)]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> ExitCode {
    // 1. Parse CLI args
    let cli = Cli::parse();

    // 2. Init logging
    init_logging();

    info!(
        config_path = %cli.config_path.display(),
        "starting ensemble"
    );

    // 3. Load and validate ensemble.yaml
    let config = match load_config(&cli.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %cli.config_path.display(), "failed to load config");
            eprintln!(
                "error: failed to load {}: {}",
                cli.config_path.display(),
                e
            );
            return ExitCode::FAILURE;
        }
    };

    // 4. Validate config and build step DAG
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

    // 5. Create orchestrator state
    let orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // 6. Optionally start HTTP server
    let server_handle = if let Some(port) = cli.port {
        let app_state = AppState {
            orchestrator_state: orchestrator_state.clone(),
            refresh_requested: refresh_notify.clone(),
            workspace_root: config
                .workspace
                .root
                .as_deref()
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    std::env::temp_dir()
                        .join("ensemble_workspaces")
                        .display()
                        .to_string()
                }),
        };
        let router = create_api_router(app_state);

        let bind_addr = format!("127.0.0.1:{}", port);
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
        info!(addr = %actual_addr, "HTTP server listening");

        Some(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                error!(error = %e, "HTTP server error");
            }
        }))
    } else {
        info!("no HTTP port configured, skipping API server");
        None
    };

    // 7. TODO: Start orchestrator poll loop (Plan 3 wires this up).
    //    For now the CLI starts, optionally serves the API, and waits for shutdown.
    info!("ensemble is running (orchestrator loop placeholder, press Ctrl+C to stop)");

    // 8. Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    // 9. Clean shutdown
    if let Some(handle) = server_handle {
        handle.abort();
        info!("HTTP server stopped");
    }

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parse_defaults() {
        let cli = Cli::parse_from(["ensemble"]);
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        assert_eq!(cli.port, None);
    }

    #[test]
    fn test_cli_parse_custom_path() {
        let cli = Cli::parse_from(["ensemble", "custom/ensemble.yaml"]);
        assert_eq!(cli.config_path, PathBuf::from("custom/ensemble.yaml"));
        assert_eq!(cli.port, None);
    }

    #[test]
    fn test_cli_parse_with_port() {
        let cli = Cli::parse_from(["ensemble", "--port", "8080"]);
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        assert_eq!(cli.port, Some(8080));
    }

    #[test]
    fn test_cli_parse_all_options() {
        let cli = Cli::parse_from(["ensemble", "--port", "3000", "my/ensemble.yaml"]);
        assert_eq!(cli.config_path, PathBuf::from("my/ensemble.yaml"));
        assert_eq!(cli.port, Some(3000));
    }

    #[test]
    fn test_cli_parse_ephemeral_port() {
        let cli = Cli::parse_from(["ensemble", "--port", "0"]);
        assert_eq!(cli.port, Some(0));
    }
}
