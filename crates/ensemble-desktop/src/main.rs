#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::Manager;
use tracing::{error, info};

mod embedded_ui;
mod orchestrator;

use embedded_ui::{resolve_path, spa_available};
use ensemble_core::config::location::resolve_config_dir_for_desktop;
use orchestrator::{get_state, trigger_refresh, DesktopOrchestrator};

fn main() {
    ensemble_core::observability::logging::init_logging();
    info!("Starting Ensemble Desktop");

    if !spa_available() {
        eprintln!("Warning: SPA assets not found. UI may not display correctly.");
        eprintln!("Build with: cd ../ensemble-ui/src-ui && pnpm run build");
    }

    // Reject legacy ENSEMBLE_CONFIG env var
    if std::env::var_os("ENSEMBLE_CONFIG").is_some() {
        eprintln!(
            "Error: ENSEMBLE_CONFIG is no longer supported. Use ENSEMBLE_CONFIG_DIR instead."
        );
        eprintln!("example: ENSEMBLE_CONFIG_DIR=/path/to/config ensemble-desktop");
        std::process::exit(1);
    }

    let resolved = match resolve_config_dir_for_desktop(std::env::var_os("ENSEMBLE_CONFIG_DIR")) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Error: Failed to resolve config directory: {}", e);
            std::process::exit(1);
        }
    };

    if !resolved.config_path.exists() {
        let message = format_missing_config_message(&resolved.config_path);
        eprintln!("Error: {}", message);

        if should_show_config_missing_dialog() {
            #[cfg(not(test))]
            show_config_missing_dialog(&message);
        }

        std::process::exit(1);
    }

    info!(
        config_dir = %resolved.config_dir.display(),
        config_path = %resolved.config_path.display(),
        "Resolved configuration paths"
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            trigger_refresh,
            serve_ui_file,
        ])
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let orchestrator =
                rt.block_on(async { DesktopOrchestrator::new(resolved.config_path).await })?;

            app.manage(orchestrator);

            let orchestrator_ref = app.state::<DesktopOrchestrator>().inner().clone();
            rt.spawn(async move {
                if let Err(e) = orchestrator_ref.start().await {
                    error!("Orchestrator failed: {}", e);
                }
            });

            app.manage(rt);
            info!("Ensemble Desktop initialized successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn format_missing_config_message(config_path: &std::path::Path) -> String {
    format!(
        "Configuration file not found: {}. Please run `ensemble init` to create a configuration directory, or set ENSEMBLE_CONFIG_DIR to an existing directory containing config.yaml.",
        config_path.display()
    )
}

fn should_show_config_missing_dialog() -> bool {
    !matches!(
        std::env::var("ENSEMBLE_SUPPRESS_CONFIG_DIALOG").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

#[cfg(not(test))]
fn show_config_missing_dialog(message: &str) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "display dialog \"{}\" buttons {{\"OK\"}} with icon stop",
                    message
                ),
            ])
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let _ = Command::new("zenity")
            .args([
                "--error",
                "--title=Ensemble",
                &format!("--text={}", message),
            ])
            .output()
            .or_else(|_| {
                Command::new("kdialog")
                    .args(["--error", message, "--title=Ensemble"])
                    .output()
            })
            .or_else(|_| Command::new("xmessage").args(["-center", message]).output());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let _ = Command::new("msg").args(["*", message]).output();
    }
}

#[tauri::command]
fn serve_ui_file(path: String) -> Result<serde_json::Value, String> {
    let file = resolve_path(&path).ok_or_else(|| format!("File not found: {}", path))?;
    let data_b64 = STANDARD.encode(&file.data);
    Ok(serde_json::json!({
        "data": data_b64,
        "content_type": file.content_type,
    }))
}

#[cfg(test)]
mod tests {
    use crate::{format_missing_config_message, should_show_config_missing_dialog};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn tauri_config_is_valid() {
        let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config_str =
            std::fs::read_to_string(&config_path).expect("tauri.conf.json should exist");
        let config: serde_json::Value =
            serde_json::from_str(&config_str).expect("tauri.conf.json should be valid JSON");

        assert!(
            config.get("productName").is_some(),
            "productName is required"
        );
        assert!(config.get("version").is_some(), "version is required");
        assert!(config.get("identifier").is_some(), "identifier is required");
        assert!(config.get("build").is_some(), "build section is required");
        assert!(config.get("app").is_some(), "app section is required");

        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows should be an array");
        assert!(!windows.is_empty(), "at least one window should be defined");

        for (i, window) in windows.iter().enumerate() {
            assert!(
                window.get("url").is_some(),
                "window {} should have a url field",
                i
            );
        }
    }

    #[test]
    fn spa_assets_directory_exists() {
        let assets_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/spa");
        let parent = assets_dir
            .parent()
            .expect("assets directory should have parent");
        assert!(parent.exists(), "assets/ directory should exist");
    }

    #[test]
    fn embedded_ui_module_loads() {
        use crate::embedded_ui::spa_available;
        let _ = spa_available;
    }

    #[test]
    fn missing_config_message_mentions_resolved_config_yaml_path() {
        let config_path = PathBuf::from("/tmp/ensemble/config.yaml");
        let message = format_missing_config_message(&config_path);
        assert!(message.contains("/tmp/ensemble/config.yaml"));
        assert!(message.contains("ensemble init"));
        assert!(message.contains("ENSEMBLE_CONFIG_DIR"));
    }

    #[test]
    fn suppresses_config_missing_dialog_for_automation() {
        let _guard = env_lock().lock().unwrap();
        let previous = std::env::var_os("ENSEMBLE_SUPPRESS_CONFIG_DIALOG");
        std::env::set_var("ENSEMBLE_SUPPRESS_CONFIG_DIALOG", "1");

        let should_show = should_show_config_missing_dialog();

        restore_env("ENSEMBLE_SUPPRESS_CONFIG_DIALOG", previous);
        assert!(!should_show);
    }

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }
}
