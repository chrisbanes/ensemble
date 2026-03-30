use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Run tauri-build
    tauri_build::build();

    // Only rebuild if UI source changes
    println!("cargo:rerun-if-changed=../../ensemble-ui/src-ui/src");
    println!("cargo:rerun-if-changed=../../ensemble-ui/src-ui/package.json");

    // Check if we're in CI or should skip UI build
    if std::env::var("SKIP_UI_BUILD").is_ok() {
        println!("cargo:warning=Skipping UI build (SKIP_UI_BUILD set)");
        let assets_dir = PathBuf::from("assets/spa");
        std::fs::create_dir_all(&assets_dir).ok();
        return;
    }

    // Get paths
    let ui_dir = PathBuf::from("../../ensemble-ui/src-ui");
    let dist_dir = ui_dir.join("dist");
    let assets_dir = PathBuf::from("assets/spa");

    // Check if npm/node is available
    if !command_exists("npm") {
        println!("cargo:warning=npm not found in PATH. UI will not be built.");
        println!("cargo:warning=Install Node.js or set SKIP_UI_BUILD=1 to skip.");
        std::fs::create_dir_all(&assets_dir).ok();
        return;
    }

    // Build the SPA
    println!("cargo:warning=Building Ensemble UI for Desktop...");

    let npm_ci = Command::new("npm")
        .args(["ci"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm ci");

    if !npm_ci.status.success() {
        println!(
            "cargo:warning=npm ci failed: {}",
            String::from_utf8_lossy(&npm_ci.stderr)
        );
        std::process::exit(1);
    }

    let npm_build = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm build");

    if !npm_build.status.success() {
        println!(
            "cargo:warning=npm run build failed: {}",
            String::from_utf8_lossy(&npm_build.stderr)
        );
        std::process::exit(1);
    }

    // Copy dist to assets
    std::fs::remove_dir_all(&assets_dir).ok();
    std::fs::create_dir_all(&assets_dir).unwrap();

    copy_dir_all(&dist_dir, &assets_dir).expect("Failed to copy dist to assets");

    println!("cargo:warning=Ensemble Desktop UI built and embedded successfully");
}

fn command_exists(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn copy_dir_all(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());

        if path.is_dir() {
            copy_dir_all(&path, &dest_path)?;
        } else {
            std::fs::copy(&path, &dest_path)?;
        }
    }

    Ok(())
}
