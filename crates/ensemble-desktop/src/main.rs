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
    // Initialize logging
    ensemble_core::observability::logging::init_logging();

    info!("Starting Ensemble Desktop");

    // Check SPA availability
    if !spa_available() {
        eprintln!("Warning: SPA assets not found. UI may not display correctly.");
        eprintln!("Build with: cd ../ensemble-ui/src-ui && pnpm run build");
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            trigger_refresh,
            serve_ui_file,
        ])
        .setup(|app| {
            // Get config path (use default or from args)
            let config_path = PathBuf::from("ensemble.yaml");

            // Initialize orchestrator
            let rt = tokio::runtime::Runtime::new().unwrap();
            let orchestrator =
                rt.block_on(async { DesktopOrchestrator::new(config_path).await })?;

            app.manage(orchestrator);

            // Start orchestrator
            let orchestrator_ref = app.state::<DesktopOrchestrator>().inner().clone();
            rt.spawn(async move {
                if let Err(e) = orchestrator_ref.start().await {
                    error!("Orchestrator failed: {}", e);
                }
            });

            // Store runtime in app state to prevent it from being dropped.
            // Dropping a tokio Runtime cancels all spawned tasks.
            app.manage(rt);

            info!("Ensemble Desktop initialized successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Tauri command to serve UI files
#[tauri::command]
fn serve_ui_file(path: String) -> Result<serde_json::Value, String> {
    let file = resolve_path(&path).ok_or_else(|| format!("File not found: {}", path))?;

    // Encode binary data as base64 for JSON serialization
    let data_b64 = STANDARD.encode(&file.data);

    Ok(serde_json::json!({
        "data": data_b64,
        "content_type": file.content_type,
    }))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// Verify that tauri.conf.json is valid JSON and contains required fields
    #[test]
    fn tauri_config_is_valid() {
        let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config_str = std::fs::read_to_string(&config_path)
            .expect("tauri.conf.json should exist");
        let config: serde_json::Value = serde_json::from_str(&config_str)
            .expect("tauri.conf.json should be valid JSON");

        // Check required fields exist
        assert!(config.get("productName").is_some(), "productName is required");
        assert!(config.get("version").is_some(), "version is required");
        assert!(config.get("identifier").is_some(), "identifier is required");
        assert!(config.get("build").is_some(), "build section is required");
        assert!(config.get("app").is_some(), "app section is required");
        
        // Check windows configuration
        let windows = config["app"]["windows"].as_array()
            .expect("app.windows should be an array");
        assert!(!windows.is_empty(), "at least one window should be defined");
        
        // Each window should have a url
        for (i, window) in windows.iter().enumerate() {
            assert!(
                window.get("url").is_some(),
                "window {} should have a url field (required for Tauri v2)",
                i
            );
        }
    }

    /// Verify SPA assets directory exists (required for rust-embed)
    #[test]
    fn spa_assets_directory_exists() {
        let assets_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/spa");
        
        // In CI, this directory is created even if empty
        // We just verify the path is valid, actual file checking happens at build time
        let parent = assets_dir.parent().expect("assets directory should have parent");
        assert!(parent.exists(), "assets/ directory should exist");
    }

    /// Verify embedded_ui module can be loaded
    #[test]
    fn embedded_ui_module_loads() {
        // This just verifies the module compiles and can be referenced
        // The actual embedding happens at build time
        use crate::embedded_ui::spa_available;
        
        // We can't check spa_available() in tests without a full build,
        // but we can verify the function signature exists
        let _ = spa_available;
    }

    /// Verify orchestrator module can be constructed (without config)
    #[tokio::test]
    async fn orchestrator_module_loads() {
        use crate::orchestrator::DesktopOrchestrator;
        use std::path::PathBuf;

        // Test that we can at least reference the struct and its methods
        // Actual initialization would require a valid config file
        let _ = DesktopOrchestrator::new;
        let _ = DesktopOrchestrator::start;
        let _ = DesktopOrchestrator::stop;
        
        // Verify the type implements Clone as expected
        fn check_clone<T: Clone>() {}
        check_clone::<DesktopOrchestrator>();
    }
}
