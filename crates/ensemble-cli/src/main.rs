mod commands;
#[cfg(feature = "web-ui")]
mod embedded_ui;

use clap::{Args, Parser, Subcommand};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use ensemble_core::observability::logging::init_logging;

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(name = "ensemble", about = "Orchestrate coding agents")]
struct Cli {
    #[command(flatten)]
    config: ConfigDirArgs,

    /// Subcommand is optional: bare `ensemble` defaults to headless `run`.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Args, Debug, Clone)]
struct ConfigDirArgs {
    /// Path to the ensemble configuration directory (contains config.yaml)
    #[arg(long, env = "ENSEMBLE_CONFIG_DIR", global = true)]
    config_dir: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Interactively create an ensemble configuration directory.
    Init,
    /// Start the ensemble orchestrator in headless mode.
    Run,
    /// Start the ensemble orchestrator with web UI.
    #[cfg(feature = "web-ui")]
    Web {
        /// HTTP server bind address.
        #[arg(long, env = "HOST", default_value = "127.0.0.1")]
        host: String,

        /// HTTP server port.
        #[arg(long, env = "PORT")]
        port: Option<u16>,
    },
    /// Open the ensemble configuration directory in the system file manager.
    OpenConfigDir,
}

/// Check for legacy config override arguments and print migration error.
fn reject_legacy_config_overrides(args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let args_vec: Vec<_> = args.collect();

    // Check for deprecated --config flag
    if args_vec.iter().any(|a| a == "--config" || a == "-c") {
        return Err(
            "error: --config is no longer supported. Use --config-dir or ENSEMBLE_CONFIG_DIR instead.\n\
             example: ensemble run --config-dir /path/to/config\n\
             example: ENSEMBLE_CONFIG_DIR=/path/to/config ensemble run".to_string()
        );
    }

    // Check for ENSEMBLE_CONFIG (old env var)
    if std::env::var_os("ENSEMBLE_CONFIG").is_some() {
        return Err(
            "error: ENSEMBLE_CONFIG is no longer supported. Use ENSEMBLE_CONFIG_DIR instead.\n\
             example: ENSEMBLE_CONFIG_DIR=/path/to/config ensemble run"
                .to_string(),
        );
    }

    let mut expect_value_for_flag = false;
    let mut saw_subcommand = false;

    for arg in args_vec.iter().skip(1) {
        let arg = arg.to_string_lossy();

        if expect_value_for_flag {
            expect_value_for_flag = false;
            continue;
        }

        if arg == "--" {
            break;
        }

        if arg == "--config-dir" || arg == "--host" || arg == "--port" {
            expect_value_for_flag = true;
            continue;
        }

        if arg.starts_with("--config-dir=")
            || arg.starts_with("--host=")
            || arg.starts_with("--port=")
        {
            continue;
        }

        if arg.starts_with('-') {
            continue;
        }

        if !saw_subcommand && matches!(arg.as_ref(), "init" | "run" | "web" | "open-config-dir") {
            saw_subcommand = true;
            continue;
        }

        return Err(
            "error: positional config paths are no longer supported. Use --config-dir or ENSEMBLE_CONFIG_DIR instead.\n\
             example: ensemble run --config-dir /path/to/config\n\
             example: ensemble --config-dir /path/to/config"
                .to_string(),
        );
    }

    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    // Check for legacy arguments before parsing
    if let Err(msg) = reject_legacy_config_overrides(std::env::args_os()) {
        eprintln!("{}", msg);
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();
    init_logging();

    let config_dir = cli.config.config_dir;

    match cli.command {
        Some(Command::Init) => {
            commands::init::execute(commands::init::InitArgs { config_dir }).await
        }
        Some(Command::Run) => commands::run::execute(commands::run::RunArgs { config_dir }).await,
        #[cfg(feature = "web-ui")]
        Some(Command::Web { host, port }) => {
            commands::web::execute(commands::web::WebArgs {
                config_dir,
                host,
                port,
            })
            .await
        }
        Some(Command::OpenConfigDir) => {
            commands::open_config_dir::execute(commands::open_config_dir::OpenConfigDirArgs {
                config_dir,
            })
            .await
        }
        None => commands::run::execute(commands::run::RunArgs { config_dir }).await,
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
        std::env::remove_var("ENSEMBLE_CONFIG");
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
    fn test_cli_parse_run_with_config_dir() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run", "--config-dir", "/tmp/ensemble"]);
        match cli.command {
            Some(Command::Run) => {
                assert_eq!(cli.config.config_dir, Some(PathBuf::from("/tmp/ensemble")))
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_run_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run"]);
        match cli.command {
            Some(Command::Run) => assert_eq!(cli.config.config_dir, None),
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- `ensemble web` subcommand ----

    #[cfg(not(feature = "web-ui"))]
    #[test]
    fn test_cli_rejects_web_when_web_ui_disabled() {
        let (_guard, host, port) = lock_and_clear_env();
        let result = Cli::try_parse_from(["ensemble", "web"]);
        assert!(result.is_err());
        restore_env(host, port);
    }

    #[cfg(feature = "web-ui")]
    #[test]
    fn test_cli_parse_web_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Some(Command::Web { host: h, port: p }) => {
                assert_eq!(cli.config.config_dir, None);
                assert_eq!(h, "127.0.0.1");
                assert_eq!(p, None);
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[cfg(feature = "web-ui")]
    #[test]
    fn test_cli_parse_web_custom_args() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from([
            "ensemble",
            "web",
            "--config-dir",
            "/tmp/ensemble",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
        ]);
        match cli.command {
            Some(Command::Web { host: h, port: p }) => {
                assert_eq!(cli.config.config_dir, Some(PathBuf::from("/tmp/ensemble")));
                assert_eq!(h, "0.0.0.0");
                assert_eq!(p, Some(8080));
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[cfg(feature = "web-ui")]
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

    #[cfg(feature = "web-ui")]
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

    #[cfg(feature = "web-ui")]
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

    #[cfg(feature = "web-ui")]
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

    // ---- `ensemble open-config-dir` subcommand ----

    #[test]
    fn test_cli_parse_open_config_dir_subcommand() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "open-config-dir"]);
        assert!(matches!(cli.command, Some(Command::OpenConfigDir)));
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_open_config_dir_with_config_dir() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from([
            "ensemble",
            "open-config-dir",
            "--config-dir",
            "/tmp/ensemble",
        ]);
        match cli.command {
            Some(Command::OpenConfigDir) => {
                assert_eq!(cli.config.config_dir, Some(PathBuf::from("/tmp/ensemble")))
            }
            other => panic!("expected OpenConfigDir subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- legacy argument rejection ----

    #[test]
    fn test_cli_rejects_legacy_config_flag() {
        let result = reject_legacy_config_overrides(
            [
                OsString::from("ensemble"),
                OsString::from("run"),
                OsString::from("--config"),
                OsString::from("old.yaml"),
            ]
            .into_iter(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("--config-dir"));
    }

    #[test]
    fn test_cli_rejects_legacy_short_config_flag() {
        let result = reject_legacy_config_overrides(
            [
                OsString::from("ensemble"),
                OsString::from("run"),
                OsString::from("-c"),
                OsString::from("old.yaml"),
            ]
            .into_iter(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("--config-dir"));
    }

    // ---- no subcommand (default to headless run) ----

    #[test]
    fn test_cli_no_subcommand_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble"]);
        assert!(cli.command.is_none());
        restore_env(host, port);
    }

    #[test]
    fn test_cli_no_subcommand_accepts_config_dir() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::try_parse_from(["ensemble", "--config-dir", "/tmp/ensemble"])
            .expect("bare ensemble should accept --config-dir");
        assert!(cli.command.is_none());
        restore_env(host, port);
    }

    #[test]
    fn test_cli_rejects_legacy_bare_config_path() {
        let result = reject_legacy_config_overrides(
            [
                OsString::from("ensemble"),
                OsString::from("custom/ensemble.yaml"),
            ]
            .into_iter(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("--config-dir"));
    }
}
