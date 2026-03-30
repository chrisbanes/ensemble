use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::api::router::{create_api_router_with_static, AppState};
use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

mod init;

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(name = "ensemble", about = "Orchestrate coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Path to ensemble.yaml (used when no subcommand is given)
    #[arg(default_value = "ensemble.yaml", global = true)]
    config_path: PathBuf,

    /// HTTP server bind address.
    #[arg(long, env = "HOST", default_value = "127.0.0.1", global = true)]
    host: String,

    /// HTTP server port (enables API + dashboard).
    #[arg(long, env = "PORT", global = true)]
    port: Option<u16>,

    /// Directory containing built dashboard assets to serve.
    #[arg(long, global = true)]
    static_dir: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Interactively create an ensemble.yaml configuration file.
    Init,
    /// Start the ensemble orchestrator (default when no subcommand is given).
    Run {
        /// Path to ensemble.yaml
        #[arg(default_value = "ensemble.yaml")]
        config_path: PathBuf,

        /// HTTP server bind address.
        #[arg(long, env = "HOST", default_value = "127.0.0.1")]
        host: String,

        /// HTTP server port (enables API + dashboard).
        #[arg(long, env = "PORT")]
        port: Option<u16>,

        /// Directory containing built dashboard assets to serve.
        #[arg(long)]
        static_dir: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    init_logging();

    match cli.command {
        Some(Command::Init) => init::run_wizard().await,
        Some(Command::Run {
            config_path,
            host,
            port,
            static_dir,
        }) => run_orchestrator(config_path, host, port, static_dir).await,
        None => {
            // No subcommand: default to running the orchestrator with top-level args.
            run_orchestrator(cli.config_path, cli.host, cli.port, cli.static_dir).await
        }
    }
}

async fn run_orchestrator(
    config_path: PathBuf,
    host: String,
    port: Option<u16>,
    static_dir: Option<PathBuf>,
) -> ExitCode {
    info!(
        config_path = %config_path.display(),
        "starting ensemble"
    );

    // Load and validate ensemble.yaml
    let config = match load_config(&config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %config_path.display(), "failed to load config");
            eprintln!("error: failed to load {}: {}", config_path.display(), e);
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

    // Optionally start HTTP server
    let server_handle = if let Some(port) = port {
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
            config_path: config_path.display().to_string(),
        };
        let router = create_api_router_with_static(app_state, static_dir);

        let bind_addr = format!("{}:{}", host, port);
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

    // TODO: Start orchestrator poll loop (Plan 3 wires this up).
    info!("ensemble is running (orchestrator loop placeholder, press Ctrl+C to stop)");

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

    use std::sync::Mutex;

    // Mutex to serialize tests that manipulate HOST/PORT env vars.
    // Env vars are process-global, so parallel tests would race.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Helper: lock env, clear HOST/PORT, return saved values + guard.
    fn lock_and_clear_env() -> (
        std::sync::MutexGuard<'static, ()>,
        Option<String>,
        Option<String>,
    ) {
        let guard = ENV_LOCK.lock().unwrap();
        let host = std::env::var("HOST").ok();
        let port = std::env::var("PORT").ok();
        std::env::remove_var("HOST");
        std::env::remove_var("PORT");
        (guard, host, port)
    }

    /// Helper: restore previously saved HOST/PORT env vars.
    fn restore_env(host: Option<String>, port: Option<String>) {
        match host {
            Some(v) => std::env::set_var("HOST", v),
            None => std::env::remove_var("HOST"),
        }
        match port {
            Some(v) => std::env::set_var("PORT", v),
            None => std::env::remove_var("PORT"),
        }
    }

    // ---- `ensemble init` subcommand ----

    #[test]
    fn test_cli_parse_init_subcommand() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "init"]);
        assert!(matches!(cli.command, Some(Command::Init)));
        restore_env(host, port);
    }

    // ---- `ensemble run` subcommand ----

    #[test]
    fn test_cli_parse_run_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run"]);
        match cli.command {
            Some(Command::Run {
                config_path,
                host,
                port,
                static_dir,
            }) => {
                assert_eq!(config_path, PathBuf::from("ensemble.yaml"));
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, None);
                assert_eq!(static_dir, None);
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_run_custom_args() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from([
            "ensemble",
            "run",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "custom/ensemble.yaml",
        ]);
        match cli.command {
            Some(Command::Run {
                config_path,
                host,
                port,
                ..
            }) => {
                assert_eq!(config_path, PathBuf::from("custom/ensemble.yaml"));
                assert_eq!(host, "0.0.0.0");
                assert_eq!(port, Some(8080));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- no subcommand (default to orchestrator) ----

    #[test]
    fn test_cli_no_subcommand_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble"]);
        assert!(cli.command.is_none());
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        assert_eq!(cli.host, "127.0.0.1");
        assert_eq!(cli.port, None);
        restore_env(host, port);
    }

    #[test]
    fn test_cli_no_subcommand_with_flags() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "--host", "0.0.0.0", "--port", "3000"]);
        assert!(cli.command.is_none());
        assert_eq!(cli.host, "0.0.0.0");
        assert_eq!(cli.port, Some(3000));
        restore_env(host, port);
    }

    // ---- env var tests (run subcommand) ----

    #[test]
    fn test_cli_run_env_host() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        let cli = Cli::parse_from(["ensemble", "run"]);
        match cli.command {
            Some(Command::Run { host, .. }) => assert_eq!(host, "10.0.0.1"),
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_run_env_port() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "run"]);
        match cli.command {
            Some(Command::Run { port, .. }) => assert_eq!(port, Some(9090)),
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_run_flag_overrides_env() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "run", "--host", "0.0.0.0", "--port", "3000"]);
        match cli.command {
            Some(Command::Run { host, port, .. }) => {
                assert_eq!(host, "0.0.0.0");
                assert_eq!(port, Some(3000));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_run_ephemeral_port() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run", "--port", "0"]);
        match cli.command {
            Some(Command::Run { port, .. }) => assert_eq!(port, Some(0)),
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }
}
