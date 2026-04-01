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
        eprintln!("error: config directory does not exist: {}", resolved.config_dir.display());
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

/// Open a path in the system file manager
#[cfg(target_os = "macos")]
fn open_in_system_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    
    let status = Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("failed to execute open command: {}", e))?;
    
    if status.success() {
        Ok(())
    } else {
        Err(format!("open command failed with status: {:?}", status.code()))
    }
}

/// Open a path in the system file manager
#[cfg(target_os = "windows")]
fn open_in_system_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    
    let status = Command::new("explorer")
        .arg(path)
        .status()
        .map_err(|e| format!("failed to execute explorer command: {}", e))?;
    
    if status.success() {
        Ok(())
    } else {
        Err(format!("explorer command failed with status: {:?}", status.code()))
    }
}

/// Open a path in the system file manager
#[cfg(target_os = "linux")]
fn open_in_system_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    
    // Try xdg-open first, then fallback to common file managers
    let result = Command::new("xdg-open")
        .arg(path)
        .status();
    
    match result {
        Ok(status) if status.success() => return Ok(()),
        _ => {}
    }
    
    // Fallback to nautilus (GNOME) or dolphin (KDE)
    for cmd in ["nautilus", "dolphin", "thunar", "nemo"] {
        if let Ok(status) = Command::new(cmd).arg(path).status() {
            if status.success() {
                return Ok(());
            }
        }
    }
    
    Err("failed to open file manager. Please install xdg-open or a file manager (nautilus, dolphin, thunar, or nemo)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
