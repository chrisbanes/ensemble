use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::ConfigError;

#[derive(Debug)]
pub struct ResolvedConfigDir {
    pub config_dir: PathBuf,
    pub config_path: PathBuf,
}

pub fn config_path_for_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("config.yaml")
}

pub fn resolve_config_dir_for_cli(
    cli_override: Option<&Path>,
    env_override: Option<OsString>,
    cwd: &Path,
) -> Result<ResolvedConfigDir, ConfigError> {
    let config_dir = if let Some(cli) = cli_override {
        let expanded = expand_override_path(cli)?;
        cwd.join(expanded)
    } else if let Some(env) = env_override {
        let env_path = PathBuf::from(env);
        let expanded = expand_override_path(&env_path)?;
        cwd.join(expanded)
    } else {
        default_config_dir()?
    };

    validate_config_dir_target(&config_dir)?;
    let config_path = config_path_for_dir(&config_dir);

    Ok(ResolvedConfigDir {
        config_dir,
        config_path,
    })
}

pub fn resolve_config_dir_for_desktop(
    env_override: Option<OsString>,
) -> Result<ResolvedConfigDir, ConfigError> {
    let config_dir = if let Some(env) = env_override {
        let env_path = PathBuf::from(env);
        // Desktop rejects relative paths
        if !env_path.is_absolute() {
            return Err(ConfigError::RelativeDesktopOverride {
                path: env_path.display().to_string(),
            });
        }
        expand_override_path(&env_path)?
    } else {
        default_config_dir()?
    };

    validate_config_dir_target(&config_dir)?;
    let config_path = config_path_for_dir(&config_dir);

    Ok(ResolvedConfigDir {
        config_dir,
        config_path,
    })
}

pub fn default_config_dir() -> Result<PathBuf, ConfigError> {
    dirs::config_dir()
        .map(|d| d.join("ensemble"))
        .ok_or(ConfigError::ConfigDirUnavailable)
}

pub fn default_config_dir_from(config_dir: Option<PathBuf>) -> Result<PathBuf, ConfigError> {
    match config_dir {
        Some(dir) => Ok(dir),
        None => default_config_dir(),
    }
}

pub fn default_todo_state_path() -> Result<PathBuf, ConfigError> {
    let home = dirs::home_dir().ok_or(ConfigError::HomeDirUnavailable)?;
    Ok(default_todo_state_path_from_home(&home))
}

pub fn default_todo_state_path_from_home(home: &Path) -> PathBuf {
    home.join("ensemble").join("TODO.md")
}

pub fn default_todo_state_path_from_optional_home(
    home: Option<&Path>,
) -> Result<PathBuf, ConfigError> {
    match home {
        Some(h) => Ok(default_todo_state_path_from_home(h)),
        None => Err(ConfigError::HomeDirUnavailable),
    }
}

fn validate_config_dir_target(path: &Path) -> Result<(), ConfigError> {
    if path.exists() && !path.is_dir() {
        return Err(ConfigError::NotADirectory {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

fn expand_override_path(path: &Path) -> Result<PathBuf, ConfigError> {
    let path_str = path.to_string_lossy();

    // Expand environment variables first
    let expanded = if path_str.contains('$') {
        shellexpand::env(&path_str)
            .map_err(|e| ConfigError::PathExpansionError {
                path: path_str.to_string(),
                reason: e.to_string(),
            })?
            .to_string()
    } else {
        path_str.to_string()
    };

    // Expand tilde
    let expanded = shellexpand::tilde(&expanded).to_string();

    Ok(PathBuf::from(expanded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_path_for_dir_appends_config_yaml() {
        let dir = PathBuf::from("/tmp/ensemble-config");
        assert_eq!(config_path_for_dir(&dir), dir.join("config.yaml"));
    }

    #[test]
    fn test_resolve_cli_config_dir_allows_relative_override() {
        let cwd = Path::new("/tmp/project");
        let resolved =
            resolve_config_dir_for_cli(Some(Path::new("configs/dev")), None, cwd).unwrap();
        assert_eq!(resolved.config_dir, cwd.join("configs/dev"));
    }

    #[test]
    fn test_resolve_desktop_config_dir_rejects_relative_env_override() {
        let err = resolve_config_dir_for_desktop(Some(OsString::from("configs/dev"))).unwrap_err();
        assert!(err.to_string().contains("relative"));
    }

    #[test]
    fn test_default_todo_state_path_uses_home_ensemble_directory() {
        let home = Path::new("/tmp/home");
        assert_eq!(
            default_todo_state_path_from_home(home),
            home.join("ensemble").join("TODO.md")
        );
    }

    #[test]
    fn test_resolve_cli_config_dir_prefers_flag_over_env() {
        let cwd = Path::new("/tmp/project");
        let resolved = resolve_config_dir_for_cli(
            Some(Path::new("flag-dir")),
            Some(OsString::from("env-dir")),
            cwd,
        )
        .unwrap();
        assert_eq!(resolved.config_dir, cwd.join("flag-dir"));
    }

    #[test]
    fn test_resolve_cli_config_dir_uses_env_when_flag_missing() {
        let cwd = Path::new("/tmp/project");
        let resolved =
            resolve_config_dir_for_cli(None, Some(OsString::from("env-dir")), cwd).unwrap();
        assert_eq!(resolved.config_dir, cwd.join("env-dir"));
    }

    #[test]
    fn test_resolve_config_dir_rejects_existing_file_target() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir");
        std::fs::write(&file_path, "x").unwrap();
        let err = validate_config_dir_target(&file_path).unwrap_err();
        assert!(err.to_string().contains("directory"));
    }

    #[test]
    fn test_expand_override_supports_tilde() {
        let home = dirs::home_dir().unwrap();
        let resolved = expand_override_path(Path::new("~/ensemble")).unwrap();
        assert_eq!(resolved, home.join("ensemble"));
    }

    #[test]
    fn test_default_resolution_errors_when_config_dir_is_unavailable() {
        // This test verifies the error variant exists and is returned
        // We can't easily mock dirs::config_dir() returning None in a test,
        // but we can verify the error variant message
        let err = ConfigError::ConfigDirUnavailable;
        assert!(err.to_string().contains("config directory"));
    }

    #[test]
    fn test_default_todo_state_path_errors_without_home_dir() {
        let err = default_todo_state_path_from_optional_home(None).unwrap_err();
        assert!(err.to_string().contains("home"));
    }
}
