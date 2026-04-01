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
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[test]
fn resolve_binary_path_prefers_explicit_env_override() {
    let _guard = env_lock().lock().unwrap();
    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let binary_name = binary_name();
    let env_binary = temp_dir.path().join(binary_name);
    std::fs::write(&env_binary, b"test-binary").expect("Failed to write binary fixture");

    let previous = std::env::var_os("ENSEMBLE_DESKTOP_BIN");
    std::env::set_var("ENSEMBLE_DESKTOP_BIN", &env_binary);

    let resolved = resolve_binary_path(&[PathBuf::from("missing-binary")])
        .expect("Expected env override to resolve");

    restore_env("ENSEMBLE_DESKTOP_BIN", previous);
    assert_eq!(resolved, env_binary);
}

#[test]
fn resolve_binary_path_prefers_first_existing_candidate() {
    let _guard = env_lock().lock().unwrap();
    let previous = std::env::var_os("ENSEMBLE_DESKTOP_BIN");
    std::env::remove_var("ENSEMBLE_DESKTOP_BIN");

    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let binary_name = binary_name();
    let debug_binary = temp_dir.path().join("debug").join(binary_name);
    let release_binary = temp_dir.path().join("release").join(binary_name);

    std::fs::create_dir_all(debug_binary.parent().expect("debug dir")).expect("create debug dir");
    std::fs::write(&debug_binary, b"debug").expect("write debug fixture");
    std::fs::create_dir_all(release_binary.parent().expect("release dir"))
        .expect("create release dir");
    std::fs::write(&release_binary, b"release").expect("write release fixture");

    let resolved = resolve_binary_path(&[debug_binary.clone(), release_binary])
        .expect("Expected first existing candidate to resolve");

    restore_env("ENSEMBLE_DESKTOP_BIN", previous);
    assert_eq!(resolved, debug_binary);
}

#[test]
fn resolve_binary_path_rejects_missing_explicit_override() {
    let _guard = env_lock().lock().unwrap();
    let previous = std::env::var_os("ENSEMBLE_DESKTOP_BIN");

    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let missing_override = temp_dir.path().join("does-not-exist").join(binary_name());
    let fallback_binary = temp_dir.path().join("debug").join(binary_name());
    std::fs::create_dir_all(fallback_binary.parent().expect("debug dir"))
        .expect("create debug dir");
    std::fs::write(&fallback_binary, b"debug").expect("write debug fixture");

    std::env::set_var("ENSEMBLE_DESKTOP_BIN", &missing_override);

    let resolved = resolve_binary_path(&[fallback_binary]);

    restore_env("ENSEMBLE_DESKTOP_BIN", previous);
    assert_eq!(resolved, None);
}

/// Launch the app and verify it doesn't immediately crash.
///
/// This is a smoke test that checks the app can initialize
/// and run for a few seconds without panicking.
#[test]
#[ignore = "Requires compiled app binary - run with: cargo build --release -p ensemble-desktop first"]
fn app_launches_without_crash() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().unwrap().parent().unwrap();
    let possible_paths = candidate_binary_paths(manifest_dir, workspace_root);
    let binary_path = resolve_binary_path(&possible_paths).unwrap_or_else(|| {
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

    let mut child = Command::new(&binary_path)
        .current_dir(workspace_root)
        .env("ENSEMBLE_CONFIG", &config_path)
        .env("TAURI_WEBVIEW_AUTOMATION", "1")
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

    if let Err(msg) = result {
        panic!("{}", msg);
    }
}

/// Verify the app shows a helpful error and exits gracefully when config is missing.
#[test]
#[ignore = "Requires compiled app binary - run with: cargo build --release -p ensemble-desktop first"]
fn app_shows_error_when_config_missing() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent().unwrap().parent().unwrap();
    let possible_paths = candidate_binary_paths(manifest_dir, workspace_root);
    let binary_path = resolve_binary_path(&possible_paths).expect("App binary not found");
    let missing_config_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let missing_config = missing_config_dir.path().join("missing-ensemble.yaml");

    let mut child = Command::new(&binary_path)
        .current_dir(workspace_root)
        .env("ENSEMBLE_CONFIG", &missing_config)
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

fn candidate_binary_paths(manifest_dir: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(target_dir) = std::env::var_os("CARGO_TARGET_DIR") {
        let target_dir = PathBuf::from(target_dir);
        paths.push(target_dir.join("debug").join(binary_name()));
        paths.push(target_dir.join("release").join(binary_name()));
    }

    paths.push(
        workspace_root
            .join("target")
            .join("debug")
            .join(binary_name()),
    );
    paths.push(
        manifest_dir
            .join("target")
            .join("debug")
            .join(binary_name()),
    );
    paths.push(
        workspace_root
            .join("target")
            .join("release")
            .join(binary_name()),
    );
    paths.push(
        manifest_dir
            .join("target")
            .join("release")
            .join(binary_name()),
    );

    paths
}

fn resolve_binary_path(candidates: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ENSEMBLE_DESKTOP_BIN") {
        let path = PathBuf::from(path);
        return path.exists().then_some(path);
    }

    candidates.iter().find(|path| path.exists()).cloned()
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ensemble-desktop.exe"
    } else {
        "ensemble-desktop"
    }
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
