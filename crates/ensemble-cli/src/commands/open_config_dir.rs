use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info};

use ensemble_core::config::location::resolve_config_dir_for_cli;

#[derive(Debug, Clone)]
pub struct OpenConfigDirArgs {
    pub config_dir: Option<PathBuf>,
}

/// Open the configuration directory in the system file manager
pub async fn execute(args: OpenConfigDirArgs) -> ExitCode {
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

    if !resolved.config_dir.exists() {
        eprintln!(
            "error: config directory does not exist: {}",
            resolved.config_dir.display()
        );
        eprintln!("run `ensemble init` to create it");
        return ExitCode::FAILURE;
    }

    info!(config_dir = %resolved.config_dir.display(), "opening config directory");

    match open_in_system_file_manager(&resolved.config_dir) {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            error!(error = %e, "failed to open config directory");
            eprintln!("error: failed to open config directory: {}", e);
            ExitCode::FAILURE
        }
    }
}

#[cfg(feature = "open-config-dir")]
fn open_in_system_file_manager(path: &std::path::Path) -> Result<(), String> {
    opener::open(path).map_err(|e| e.to_string())
}

#[cfg(not(feature = "open-config-dir"))]
fn open_in_system_file_manager(path: &std::path::Path) -> Result<(), String> {
    eprintln!("config directory: {}", path.display());
    eprintln!("open this path manually (opener feature not enabled)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeOpenError(&'static str);

    impl std::fmt::Display for FakeOpenError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    #[test]
    fn test_open_config_dir_args() {
        let args = OpenConfigDirArgs {
            config_dir: Some(PathBuf::from("/tmp/test")),
        };
        assert_eq!(args.config_dir, Some(PathBuf::from("/tmp/test")));
    }

    #[test]
    fn test_open_config_dir_args_none() {
        let args = OpenConfigDirArgs { config_dir: None };
        assert!(args.config_dir.is_none());
    }

    #[test]
    #[cfg(feature = "open-config-dir")]
    fn open_in_system_file_manager_with_fallback() {
        fn open_in_system_file_manager_with<E>(
            path: &std::path::Path,
            open: impl FnOnce(&std::path::Path) -> Result<(), E>,
        ) -> Result<(), String>
        where
            E: std::fmt::Display,
        {
            open(path).map_err(|error| error.to_string())
        }

        let result = open_in_system_file_manager_with(PathBuf::from("/tmp/test").as_path(), |_| {
            Err(FakeOpenError("launcher missing"))
        });
        assert_eq!(result, Err("launcher missing".to_string()));
    }
}
