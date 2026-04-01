#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::path::PathBuf;
use tauri::Manager;
use tracing::{error, info};

mod embedded_ui;
mod orchestrator;

use embedded_ui::{resolve_path, spa_available};
use orchestrator::{get_state, trigger_refresh, DesktopOrchestrator};

fn main() {
    ensemble_core::observability::logging::init_logging();
    info!("Starting Ensemble Desktop");

    if !spa_available() {
        eprintln!("Warning: SPA assets not found. UI may not display correctly.");
        eprintln!("Build with: cd ../ensemble-ui/src-ui && pnpm run build");
    }

    let config_path = PathBuf::from("ensemble.yaml");
    if !config_path.exists() {
        eprintln!("Error: Config file not found: {}", config_path.display());
        eprintln!("Please create an ensemble.yaml file or run ensemble init to generate one.");
        
        #[cfg(not(test))]
        show_config_missing_dialog(&config_path);
        
        std::process::exit(1);
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            trigger_refresh,
            serve_ui_file,
        ])
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let orchestrator =
                rt.block_on(async { DesktopOrchestrator::new(config_path).await })?;

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

#[cfg(not(test))]
fn show_config_missing_dialog(config_path: &std::path::Path) {
    let message = format!(
        "Configuration file not found: {}. Please create an ensemble.yaml file or run ensemble init to generate one.",
        config_path.display()
    );
    
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("osascript")
            .args(["-e", &format!("display dialog \"{}\" buttons {{\"OK\"}} with icon stop", message)])
            .output();
    }
    
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let _ = Command::new("zenity")
            .args(["--error", "--title=Ensemble", &format!("--text={}", message)])
            .output()
            .or_else(|_| {
                Command::new("kdialog").args(["--error", &message, "--title=Ensemble"]).output()
            })
            .or_else(|_| {
                Command::new("xmessage").args(["-center", &message]).output()
            });
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let _ = Command::new("msg").args(["*", &message]).output();
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
    use std::path::Path;

    #[test]
    fn tauri_config_is_valid() {
        let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config_str = std::fs::read_to_string(&config_path)
            .expect("tauri.conf.json should exist");
        let config: serde_json::Value = serde_json::from_str(&config_str)
            .expect("tauri.conf.json should be valid JSON");

        assert!(config.get("productName").is_some(), "productName is required");
        assert!(config.get("version").is_some(), "version is required");
        assert!(config.get("identifier").is_some(), "identifier is required");
        assert!(config.get("build").is_some(), "build section is required");
        assert!(config.get("app").is_some(), "app section is required");
        
        let windows = config["app"]["windows"].as_array()
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
        let parent = assets_dir.parent().expect("assets directory should have parent");
        assert!(parent.exists(), "assets/ directory should exist");
    }

    #[test]
    fn embedded_ui_module_loads() {
        use crate::embedded_ui::spa_available;
        let _ = spa_available;
    }

    #[tokio::test]
    async fn orchestrator_module_loads() {
        use crate::orchestrator::DesktopOrchestrator;
        let _ = DesktopOrchestrator::new;
        fn check_clone<T: Clone>() {}
        check_clone::<DesktopOrchestrator>();
    }
}
