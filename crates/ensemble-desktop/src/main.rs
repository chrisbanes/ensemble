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
        eprintln!("Build with: cd ../ensemble-ui/src-ui && npm run build");
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
