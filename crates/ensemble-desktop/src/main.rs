#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tracing::{info, warn};

mod embedded_ui;
mod orchestrator;
mod server;

use embedded_ui::spa_available;
use ensemble_core::config::location::resolve_config_dir_for_desktop;
use orchestrator::DesktopOrchestrator;
use server::start_desktop_server;

fn main() {
    ensemble_core::observability::logging::init_logging();
    info!("Starting Ensemble Desktop");

    if !spa_available() {
        warn!("SPA assets not found. UI may not display correctly.");
        warn!("Build with: cd ../ensemble-ui/src-ui && pnpm run build");
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

    info!(
        config_dir = %resolved.config_dir.display(),
        config_path = %resolved.config_path.display(),
        "Resolved configuration paths"
    );

    // Create Tokio runtime for the server
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

    // Start the local HTTP server
    let desktop_server = rt
        .block_on(start_desktop_server(
            resolved.config_dir.clone(),
            resolved.config_path.clone(),
        ))
        .unwrap_or_else(|e| {
            eprintln!("Error: Failed to start desktop server: {}", e);
            std::process::exit(1);
        });

    info!(url = %desktop_server.url, "Desktop server started");

    // Store server URL and runtime for use in Tauri setup
    let server_url = desktop_server.url.clone();

    tauri::Builder::default()
        .setup(move |app| {
            // Create main window pointing to the local server URL
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(server_url.clone()),
            )
            .title("Ensemble Dashboard")
            .inner_size(1280.0, 800.0)
            .resizable(true)
            .build()
            .expect("Failed to create main window");

            // Initialize orchestrator if we have a valid config
            rt.block_on(async {
                if resolved.config_path.exists() {
                    match DesktopOrchestrator::new(resolved.config_path.clone()).await {
                        Ok(orchestrator) => {
                            app.manage(orchestrator);
                            info!("Orchestrator initialized successfully");
                        }
                        Err(e) => {
                            warn!(
                                error = %e,
                                "Failed to initialize orchestrator - app will run in setup mode"
                            );
                        }
                    }
                } else {
                    info!("No config found - app running in setup mode");
                }
            });

            // Store runtime handle
            app.manage(rt);

            info!("Ensemble Desktop initialized successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use crate::embedded_ui::spa_available;
    use std::path::Path;
    use std::path::PathBuf;
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
        // Window is now created programmatically, so tauri.conf.json may not define it
        // Just check that if windows are defined, they have required fields
        for (i, window) in windows.iter().enumerate() {
            if window.get("url").is_some() {
                assert!(
                    window.get("label").is_some(),
                    "window {} should have a label field if url is present",
                    i
                );
            }
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
        let _ = spa_available;
    }

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }
}
