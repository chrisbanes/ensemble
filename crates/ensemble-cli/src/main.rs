mod commands;
mod embedded_ui;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

use ensemble_core::observability::logging::init_logging;

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(name = "ensemble", about = "Orchestrate coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Path to ensemble.yaml (used when no subcommand is given)
    #[arg(default_value = "ensemble.yaml")]
    config_path: PathBuf,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Interactively create an ensemble.yaml configuration file.
    Init,
    /// Start the ensemble orchestrator in headless mode.
    Run {
        /// Path to ensemble.yaml
        #[arg(default_value = "ensemble.yaml")]
        config_path: PathBuf,
    },
    /// Start the ensemble orchestrator with web UI.
    Web {
        /// Path to ensemble.yaml
        #[arg(default_value = "ensemble.yaml")]
        config_path: PathBuf,

        /// HTTP server bind address.
        #[arg(long, env = "HOST", default_value = "127.0.0.1")]
        host: String,

        /// HTTP server port.
        #[arg(long, env = "PORT")]
        port: Option<u16>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    init_logging();

    match cli.command {
        Some(Command::Init) => commands::init::execute(commands::init::InitArgs).await,
        Some(Command::Run { config_path }) => {
            commands::run::execute(commands::run::RunArgs { config_path }).await
        }
        Some(Command::Web {
            config_path,
            host,
            port,
        }) => {
            commands::web::execute(commands::web::WebArgs {
                config_path,
                host,
                port,
            })
            .await
        }
        None => {
            // No subcommand: default to headless run
            commands::run::execute(commands::run::RunArgs {
                config_path: cli.config_path,
            })
            .await
        }
    }
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
            Some(Command::Run { config_path }) => {
                assert_eq!(config_path, PathBuf::from("ensemble.yaml"));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_run_custom_config() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run", "custom/ensemble.yaml"]);
        match cli.command {
            Some(Command::Run { config_path }) => {
                assert_eq!(config_path, PathBuf::from("custom/ensemble.yaml"));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- `ensemble web` subcommand ----

    #[test]
    fn test_cli_parse_web_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Some(Command::Web {
                config_path,
                host: h,
                port: p,
            }) => {
                assert_eq!(config_path, PathBuf::from("ensemble.yaml"));
                assert_eq!(h, "127.0.0.1");
                assert_eq!(p, None);
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_custom_args() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from([
            "ensemble",
            "web",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "custom/ensemble.yaml",
        ]);
        match cli.command {
            Some(Command::Web {
                config_path,
                host: h,
                port: p,
            }) => {
                assert_eq!(config_path, PathBuf::from("custom/ensemble.yaml"));
                assert_eq!(h, "0.0.0.0");
                assert_eq!(p, Some(8080));
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_web_env_host() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Some(Command::Web { host: h, .. }) => assert_eq!(h, "10.0.0.1"),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_web_env_port() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Some(Command::Web { port: p, .. }) => assert_eq!(p, Some(9090)),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_web_flag_overrides_env() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "web", "--host", "0.0.0.0", "--port", "3000"]);
        match cli.command {
            Some(Command::Web {
                host: h, port: p, ..
            }) => {
                assert_eq!(h, "0.0.0.0");
                assert_eq!(p, Some(3000));
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_web_ephemeral_port() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "web", "--port", "0"]);
        match cli.command {
            Some(Command::Web { port: p, .. }) => assert_eq!(p, Some(0)),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- no subcommand (default to headless run) ----

    #[test]
    fn test_cli_no_subcommand_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble"]);
        assert!(cli.command.is_none());
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        restore_env(host, port);
    }
}
