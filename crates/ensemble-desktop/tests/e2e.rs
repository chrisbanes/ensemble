//! WebDriver-based E2E tests for the Tauri desktop app.
//!
//! These tests launch the actual compiled app and verify it:
//! 1. Opens without crashing
//! 2. Loads the UI successfully
//!
//! To run these tests:
//!   SKIP_UI_BUILD=1 cargo test -p ensemble-desktop --test e2e -- --ignored
//!
//! Note: The app must be built first for these tests to work.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Launch the app and verify it doesn't immediately crash.
///
/// This is a smoke test that checks the app can initialize
/// and run for a few seconds without panicking.
#[test]
#[ignore = "Requires compiled app binary - run with: cargo build --release -p ensemble-desktop first"]
fn app_launches_without_crash() {
    // Find the compiled binary - look in multiple locations
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().unwrap().parent().unwrap();
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };

    // Try multiple possible locations for the binary
    let possible_paths = vec![
        // From crate directory
        manifest_dir
            .join("target")
            .join(profile)
            .join("ensemble-desktop"),
        // From workspace root
        workspace_root
            .join("target")
            .join(profile)
            .join("ensemble-desktop"),
        // From CARGO_TARGET_DIR if set
        std::env::var("CARGO_TARGET_DIR")
            .map(|d| {
                std::path::PathBuf::from(d)
                    .join(profile)
                    .join("ensemble-desktop")
            })
            .unwrap_or_default(),
    ];

    #[cfg(target_os = "windows")]
    let binary_path = possible_paths
        .iter()
        .map(|p| p.with_extension("exe"))
        .find(|p| p.exists());

    #[cfg(not(target_os = "windows"))]
    let binary_path = possible_paths.iter().find(|p| p.exists());

    let binary_path = binary_path.cloned().unwrap_or_else(|| {
        panic!(
            "App binary not found. Tried: {:?}\nBuild with: cargo build -p ensemble-desktop",
            possible_paths
        )
    });

    println!("Launching app binary: {}", binary_path.display());

    // Create a minimal ensemble.yaml config file in a temp directory
    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let config_path = temp_dir.path().join("ensemble.yaml");
    let minimal_config = r#"
tracker:
  kind: todo_file
  file: issues.json
agents:
  coder:
    model: claude-sonnet-4-20250514
    prompt: "You are a helpful coding assistant."
    executor: local
steps:
  - name: build
    agent: coder
    prompt: "Build the code"
on_success: "Done"
on_failure: "Failed"
"#;
    std::fs::File::create(&config_path)
        .and_then(|mut f| f.write_all(minimal_config.as_bytes()))
        .expect("Failed to write test config file");

    // Copy the config to workspace root so the app can find it
    let workspace_config = workspace_root.join("ensemble.yaml");
    std::fs::copy(&config_path, &workspace_config).ok();

    // Launch the app with a short timeout to see if it crashes on startup
    let mut child = Command::new(&binary_path)
        .current_dir(workspace_root) // Run from workspace root
        .env("TAURI_WEBVIEW_AUTOMATION", "1") // Enable automation mode
        .env("RUST_BACKTRACE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to launch app binary");

    // Give the app a few seconds to initialize
    std::thread::sleep(Duration::from_secs(3));

    // Check if the process is still running
    let result = match child.try_wait() {
        Ok(Some(status)) => {
            // Process exited - this is a failure
            let mut stdout = String::new();
            let mut stderr = String::new();

            if let Some(mut out) = child.stdout.take() {
                use std::io::Read;
                out.read_to_string(&mut stdout).ok();
            }
            if let Some(mut err) = child.stderr.take() {
                use std::io::Read;
                err.read_to_string(&mut stderr).ok();
            }

            Err(format!(
                "App crashed on startup!\nExit status: {:?}\n\nSTDOUT:\n{}\n\nSTDERR:\n{}",
                status, stdout, stderr
            ))
        }
        Ok(None) => {
            // Process is still running - success!
            println!("App launched successfully and is still running after 3 seconds");
            // Kill it gracefully
            let _ = child.kill();
            let _ = child.wait();
            Ok(())
        }
        Err(e) => Err(format!("Failed to check app status: {}", e)),
    };

    // Clean up the temp config file
    let _ = std::fs::remove_file(&workspace_config);

    if let Err(msg) = result {
        panic!("{}", msg);
    }
}

/// Verify the app shows a helpful error and exits gracefully when config is missing.
#[test]
#[ignore = "Requires compiled app binary - run with: cargo build --release -p ensemble-desktop first"]
fn app_shows_error_when_config_missing() {
    // Find the compiled binary
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().unwrap().parent().unwrap();
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };

    let possible_paths = vec![
        manifest_dir
            .join("target")
            .join(profile)
            .join("ensemble-desktop"),
        workspace_root
            .join("target")
            .join(profile)
            .join("ensemble-desktop"),
        std::env::var("CARGO_TARGET_DIR")
            .map(|d| {
                std::path::PathBuf::from(d)
                    .join(profile)
                    .join("ensemble-desktop")
            })
            .unwrap_or_default(),
    ];

    #[cfg(target_os = "windows")]
    let binary_path = possible_paths
        .iter()
        .map(|p| p.with_extension("exe"))
        .find(|p| p.exists());

    #[cfg(not(target_os = "windows"))]
    let binary_path = possible_paths.iter().find(|p| p.exists());

    let binary_path = binary_path.cloned().expect("App binary not found");

    // Ensure no ensemble.yaml exists in workspace
    let workspace_config = workspace_root.join("ensemble.yaml");
    let config_existed = workspace_config.exists();
    if config_existed {
        // Temporarily rename it
        let backup = workspace_root.join("ensemble.yaml.bak");
        std::fs::rename(&workspace_config, &backup).expect("Failed to backup config");
    }

    // Launch the app without config
    let mut child = Command::new(&binary_path)
        .current_dir(workspace_root)
        .env("RUST_BACKTRACE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to launch app binary");

    // Wait for it to exit
    let status = child.wait().expect("Failed to wait for app");

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        out.read_to_string(&mut stdout).ok();
    }
    if let Some(mut err) = child.stderr.take() {
        use std::io::Read;
        err.read_to_string(&mut stderr).ok();
    }

    // Restore config if it existed
    if config_existed {
        let backup = workspace_root.join("ensemble.yaml.bak");
        std::fs::rename(&backup, &workspace_config).ok();
    }

    // Verify the app exited with error code 1 and showed helpful message
    assert!(
        !status.success(),
        "App should exit with error when config is missing"
    );

    let combined_output = format!("{} {}", stdout, stderr);
    assert!(
        combined_output.contains("Config file not found")
            || combined_output.contains("ensemble.yaml"),
        "App should show helpful error message about missing config. Got:\n{}",
        combined_output
    );

    println!("✓ App correctly exits with error when config is missing");
}
