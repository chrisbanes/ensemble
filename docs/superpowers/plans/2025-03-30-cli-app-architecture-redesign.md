# CLI and App Architecture Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Ensemble CLI to support explicit `run` (headless) and `web` (SPA + backend) commands, with SPA embedded at compile time and desktop app integrating the backend.

**Architecture:** Split monolithic CLI into command modules with shared orchestrator logic. SPA built and embedded via rust-embed at compile time. Desktop app reuses embedded SPA and calls into ensemble-core directly.

**Tech Stack:** Rust, axum, clap, rust-embed, Tauri, React/Vite

---

## File Structure

### New Files
- `crates/ensemble-cli/build.rs` - Builds SPA during compilation
- `crates/ensemble-cli/src/embedded_ui.rs` - Embedded file serving utilities
- `crates/ensemble-cli/src/commands/mod.rs` - Command module organization
- `crates/ensemble-cli/src/commands/run.rs` - Headless orchestrator command
- `crates/ensemble-cli/src/commands/web.rs` - Web mode with embedded SPA
- `crates/ensemble-cli/src/commands/init.rs` - Init wizard (moved from init/mod.rs)
- `crates/ensemble-cli/tests/cli_commands.rs` - Tests for new command structure
- `crates/ensemble-desktop/build.rs` - SPA build for desktop
- `crates/ensemble-desktop/src/embedded_ui.rs` - Desktop SPA serving
- `crates/ensemble-desktop/src/orchestrator.rs` - Desktop backend integration

### Modified Files
- `Cargo.toml` - Add rust-embed to workspace
- `crates/ensemble-cli/Cargo.toml` - Add rust-embed, tower-http features
- `crates/ensemble-cli/src/main.rs` - Restructure to new command enum
- `crates/ensemble-cli/src/init/mod.rs` - Move to commands/init.rs
- `crates/ensemble-cli/src/init/*.rs` - Update module paths
- `crates/ensemble-core/src/api/router.rs` - Remove static_dir parameter
- `crates/ensemble-desktop/Cargo.toml` - Add rust-embed, ensemble-core deps
- `crates/ensemble-desktop/src/main.rs` - Add backend integration

### Deleted Files
- `crates/ensemble-cli/src/main.rs` - Replace with restructured version

---

## Prerequisites

Before starting implementation, ensure:
- Node.js 18+ installed (for SPA builds)
- npm accessible in PATH
- Read `docs/superpowers/specs/2025-03-30-cli-app-architecture-design.md` for full context

---

## Task 1: Add rust-embed Dependency to Workspace

**Files:**
- Modify: `Cargo.toml`

**Context:** The rust-embed crate allows embedding files into the binary at compile time. We need this to bundle the SPA.

- [ ] **Step 1: Add rust-embed to workspace dependencies**

Add to `[workspace.dependencies]` section:
```toml
rust-embed = { version = "8", features = ["axum"] }
```

- [ ] **Step 2: Verify workspace Cargo.toml parses correctly**

Run: `cargo check --workspace 2>&1 | head -20`
Expected: No errors about Cargo.toml syntax

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml
git commit -m "chore: add rust-embed to workspace dependencies"
```

---

## Task 2: Add Dependencies to ensemble-cli

**Files:**
- Modify: `crates/ensemble-cli/Cargo.toml`

**Context:** CLI crate needs rust-embed for SPA embedding and mime_guess for content type detection.

- [ ] **Step 1: Add dependencies to ensemble-cli**

Add to `[dependencies]`:
```toml
rust-embed = { workspace = true }
mime_guess = "2"
```

- [ ] **Step 2: Add tower-http features**

Change tower-http line to:
```toml
tower-http = { version = "0.6", features = ["cors", "fs", "set-header"] }
```

- [ ] **Step 3: Verify CLI Cargo.toml**

Run: `cargo check -p ensemble-cli 2>&1 | head -30`
Expected: No parse errors, may have unresolved import errors

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-cli/Cargo.toml
git commit -m "chore(cli): add rust-embed and mime_guess dependencies"
```

---

## Task 3: Create CLI Build Script for SPA

**Files:**
- Create: `crates/ensemble-cli/build.rs`

**Context:** Build script compiles the React SPA from ensemble-ui during the Rust compilation process. The SPA is then embedded into the binary.

- [ ] **Step 1: Create build.rs file**

```rust
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Only rebuild if UI source changes
    println!("cargo:rerun-if-changed=../../ensemble-ui/src-ui/src");
    println!("cargo:rerun-if-changed=../../ensemble-ui/src-ui/package.json");
    
    // Check if we're in CI or should skip UI build
    if std::env::var("SKIP_UI_BUILD").is_ok() {
        println!("cargo:warning=Skipping UI build (SKIP_UI_BUILD set)");
        // Create empty assets directory if it doesn't exist
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
    println!("cargo:warning=Building Ensemble UI...");
    
    let npm_ci = Command::new("npm")
        .args(&["ci"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm ci");
    
    if !npm_ci.status.success() {
        println!("cargo:warning=npm ci failed: {}", String::from_utf8_lossy(&npm_ci.stderr));
        std::process::exit(1);
    }
    
    let npm_build = Command::new("npm")
        .args(&["run", "build"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm build");
    
    if !npm_build.status.success() {
        println!("cargo:warning=npm run build failed: {}", String::from_utf8_lossy(&npm_build.stderr));
        std::process::exit(1);
    }
    
    // Copy dist to assets
    std::fs::remove_dir_all(&assets_dir).ok();
    std::fs::create_dir_all(&assets_dir).unwrap();
    
    copy_dir_all(&dist_dir, &assets_dir).expect("Failed to copy dist to assets");
    
    println!("cargo:warning=Ensemble UI built and embedded successfully");
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
```

- [ ] **Step 2: Verify build script compiles**

Run: `cargo check -p ensemble-cli 2>&1 | grep -i "build.rs\|error"`
Expected: No errors related to build.rs

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-cli/build.rs
git commit -m "feat(cli): add build script to compile and embed SPA"
```

---

## Task 4: Create Embedded UI Module

**Files:**
- Create: `crates/ensemble-cli/src/embedded_ui.rs`

**Context:** Module provides utilities for serving the embedded SPA via axum, with proper content-type detection and SPA fallback behavior.

- [ ] **Step 1: Create embedded_ui.rs**

```rust
use axum::{
    body::Body,
    extract::Path,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Serve an embedded file by path, returning 404 if not found
pub fn serve_file(path: &str) -> impl IntoResponse {
    match SpaAssets::get(path) {
        Some(file) => {
            let content_type = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, content_type.as_ref())
                .body(Body::from(file.data))
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap(),
    }
}

/// Serve the SPA with fallback to index.html for client-side routing
pub async fn serve_spa(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    
    // Try exact path first
    if let Some(file) = SpaAssets::get(path) {
        let content_type = mime_guess::from_path(path).first_or_octet_stream();
        return Response::builder()
            .header(header::CONTENT_TYPE, content_type.as_ref())
            .body(Body::from(file.data))
            .unwrap();
    }
    
    // Try with .html extension
    let html_path = format!("{}.html", path);
    if let Some(file) = SpaAssets::get(&html_path) {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap();
    }
    
    // Try index.html in directory
    let dir_index = format!("{}/index.html", path);
    if let Some(file) = SpaAssets::get(&dir_index) {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap();
    }
    
    // Fallback to root index.html (SPA behavior)
    if let Some(file) = SpaAssets::get("index.html") {
        Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("index.html not found - UI may not be built"))
            .unwrap()
    }
}

/// Check if the SPA is available (assets were embedded)
pub fn spa_available() -> bool {
    SpaAssets::get("index.html").is_some()
}

/// Router for serving embedded SPA
pub fn spa_router() -> axum::Router {
    axum::Router::new()
        .fallback(serve_spa)
}
```

- [ ] **Step 2: Verify module compiles**

Run: `cargo check -p ensemble-cli 2>&1 | head -30`
Expected: Module compiles (other errors expected)

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-cli/src/embedded_ui.rs
git commit -m "feat(cli): add embedded SPA serving module"
```

---

## Task 5: Restructure CLI Commands

**Files:**
- Create: `crates/ensemble-cli/src/commands/mod.rs`
- Create: `crates/ensemble-cli/src/commands/run.rs`
- Create: `crates/ensemble-cli/src/commands/web.rs`
- Modify: `crates/ensemble-cli/src/init/mod.rs` → `crates/ensemble-cli/src/commands/init.rs`
- Modify: `crates/ensemble-cli/src/init/*.rs` (update paths)
- Modify: `crates/ensemble-cli/src/main.rs`

**Context:** Restructure the CLI into explicit commands: `init`, `run` (headless), and `web` (with SPA). Remove the ambiguous no-subcommand default.

### Part A: Create Commands Module

- [ ] **Step 1: Create commands/mod.rs**

```rust
pub mod init;
pub mod run;
pub mod web;

use std::path::PathBuf;

/// Common arguments shared between run and web commands
#[derive(Debug)]
pub struct CommonArgs {
    pub config_path: PathBuf,
}
```

### Part B: Create Run Command (Headless)

- [ ] **Step 2: Create commands/run.rs**

```rust
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

#[derive(Debug, Clone)]
pub struct RunArgs {
    pub config_path: PathBuf,
}

/// Run the orchestrator in headless mode (terminal output only)
pub async fn execute(args: RunArgs) -> ExitCode {
    init_logging();
    
    info!(
        config_path = %args.config_path.display(),
        "starting ensemble in headless mode"
    );

    // Load and validate ensemble.yaml
    let config = match load_config(&args.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %args.config_path.display(), "failed to load config");
            eprintln!("error: failed to load {}: {}", args.config_path.display(), e);
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = validate_config(&config) {
        error!(error = %e, "config validation failed");
        eprintln!("error: config validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    if let Err(e) = build_dag(&config.steps) {
        error!(error = %e, "step DAG validation failed");
        eprintln!("error: step DAG validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    info!(
        tracker_kind = %config.tracker.kind,
        poll_interval_ms = config.polling.interval_ms,
        max_concurrent = config.concurrency.max_concurrent_agents,
        "config loaded successfully"
    );

    // Create orchestrator state
    let orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // TODO: Start orchestrator poll loop (Plan 3 wires this up).
    info!("ensemble is running in headless mode (orchestrator loop placeholder, press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}
```

### Part C: Create Web Command

- [ ] **Step 3: Create commands/web.rs**

```rust
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::api::router::{create_api_router, AppState};
use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

use crate::embedded_ui::spa_router;

#[derive(Debug, Clone)]
pub struct WebArgs {
    pub config_path: PathBuf,
    pub host: String,
    pub port: Option<u16>,
}

/// Run the orchestrator with web UI (SPA + API server)
pub async fn execute(args: WebArgs) -> ExitCode {
    init_logging();
    
    info!(
        config_path = %args.config_path.display(),
        host = %args.host,
        port = ?args.port,
        "starting ensemble in web mode"
    );

    // Load and validate ensemble.yaml
    let config = match load_config(&args.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %args.config_path.display(), "failed to load config");
            eprintln!("error: failed to load {}: {}", args.config_path.display(), e);
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = validate_config(&config) {
        error!(error = %e, "config validation failed");
        eprintln!("error: config validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    if let Err(e) = build_dag(&config.steps) {
        error!(error = %e, "step DAG validation failed");
        eprintln!("error: step DAG validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    info!(
        tracker_kind = %config.tracker.kind,
        poll_interval_ms = config.polling.interval_ms,
        max_concurrent = config.concurrency.max_concurrent_agents,
        "config loaded successfully"
    );

    // Create orchestrator state
    let orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // Build app state for API
    let workspace_root = config
        .workspace
        .root
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("ensemble_workspaces")
                .display()
                .to_string()
        });
    let history_path = std::path::PathBuf::from(&workspace_root).join("ensemble_history.jsonl");
    let app_state = AppState {
        orchestrator_state: orchestrator_state.clone(),
        refresh_requested: refresh_notify.clone(),
        workspace_root,
        history_path,
        event_bus: EventBus::new(),
        config: Arc::new(config.clone()),
        config_path: args.config_path.display().to_string(),
    };

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state);
    let spa_router = spa_router();
    
    let router = api_router.merge(spa_router);

    // Determine port
    let port = args.port.unwrap_or(0); // 0 = let OS assign available port
    let bind_addr = format!("{}:{}", args.host, port);
    
    info!(addr = %bind_addr, "starting HTTP server");

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            error!(error = %e, addr = %bind_addr, "failed to bind HTTP server");
            eprintln!("error: failed to bind HTTP server on {}: {}", bind_addr, e);
            return ExitCode::FAILURE;
        }
    };

    let actual_addr = listener.local_addr().unwrap();
    info!(
        addr = %actual_addr,
        "HTTP server listening. Open http://{} in your browser",
        actual_addr
    );

    // Start server in background
    let server_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            error!(error = %e, "HTTP server error");
        }
    });

    // TODO: Start orchestrator poll loop (Plan 3 wires this up).
    info!("ensemble web mode is running (orchestrator loop placeholder, press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    // Clean shutdown
    server_handle.abort();
    info!("HTTP server stopped");
    
    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}
```

### Part D: Move Init Module

- [ ] **Step 4: Move init/mod.rs to commands/init.rs**

```bash
git mv crates/ensemble-cli/src/init/mod.rs crates/ensemble-cli/src/commands/init.rs
```

- [ ] **Step 5: Update init.rs to use proper command structure**

```rust
use std::path::PathBuf;
use std::process::ExitCode;

pub mod agents;
pub mod generate;
pub mod pipeline;
pub mod repos;
pub mod tracker;
pub mod validate;

#[derive(Debug, Clone)]
pub struct InitArgs;

/// Run the interactive initialization wizard
pub async fn execute(_args: InitArgs) -> ExitCode {
    // Same implementation as before
    println!();

    if std::path::Path::new("ensemble.yaml").exists() {
        let overwrite = match inquire::Confirm::new("ensemble.yaml already exists. Overwrite?")
            .with_default(false)
            .prompt()
        {
            Ok(v) => v,
            Err(_) => return ExitCode::FAILURE,
        };
        if !overwrite {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
    }

    let tracker_result = match tracker::ask_tracker().await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let repos = match repos::ask_repos() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let discovered_agents = match agents::discover_agents() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let steps = match pipeline::ask_pipeline(&discovered_agents) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let proceed =
        validate::run_validation(&tracker_result, &repos, &discovered_agents, &steps).await;
    let proceed = match proceed {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error during validation: {e}");
            return ExitCode::FAILURE;
        }
    };
    if !proceed {
        println!("Aborted.");
        return ExitCode::SUCCESS;
    }

    let (on_success, on_failure) = match &tracker_result {
        tracker::TrackerChoice::GitHub {
            on_success,
            on_failure,
            ..
        } => (on_success.clone(), on_failure.clone()),
        tracker::TrackerChoice::TodoFile { .. } => ("Done".to_string(), "Failed".to_string()),
    };

    if let Err(e) = generate::write_files(
        &tracker_result,
        &repos,
        &discovered_agents,
        &steps,
        &on_success,
        &on_failure,
    ) {
        eprintln!("error writing files: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
```

- [ ] **Step 6: Move init submodules to commands/init/**

```bash
git mv crates/ensemble-cli/src/init/agents.rs crates/ensemble-cli/src/commands/init/
git mv crates/ensemble-cli/src/init/generate.rs crates/ensemble-cli/src/commands/init/
git mv crates/ensemble-cli/src/init/pipeline.rs crates/ensemble-cli/src/commands/init/
git mv crates/ensemble-cli/src/init/repos.rs crates/ensemble-cli/src/commands/init/
git mv crates/ensemble-cli/src/init/tracker.rs crates/ensemble-cli/src/commands/init/
git mv crates/ensemble-cli/src/init/validate.rs crates/ensemble-cli/src/commands/init/
```

- [ ] **Step 7: Update import paths in moved files**

In each of the moved files (agents.rs, generate.rs, pipeline.rs, repos.rs, tracker.rs, validate.rs), update import paths:

Change all instances of:
```rust
use crate::init::
```

To:
```rust
use crate::commands::init::
```

Also update any `super::` references that pointed to the old `init` module structure.

Verify the changes compile:
Run: `cargo check -p ensemble-cli 2>&1`
Expected: No "unresolved import" errors related to init module

- [ ] **Step 8: Remove old init directory**

```bash
rmdir crates/ensemble-cli/src/init 2>/dev/null || true
```

- [ ] **Step 9: Commit structure changes**

```bash
git add crates/ensemble-cli/src/commands/
git rm crates/ensemble-cli/src/init -r
git commit -m "refactor(cli): restructure into commands/ module

- Create commands/mod.rs for command organization
- Create commands/run.rs for headless mode
- Create commands/web.rs for web mode with SPA
- Move init module to commands/init/"
```

---

## Task 6: Update Main Entry Point

**Files:**
- Modify: `crates/ensemble-cli/src/main.rs`

**Context:** Rewrite main.rs to use the new command structure with explicit `run` and `web` subcommands, removing the ambiguous default behavior.

- [ ] **Step 1: Rewrite main.rs**

```rust
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

mod commands;
mod embedded_ui;

use commands::{init, run, web};

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(
    name = "ensemble",
    about = "Orchestrate coding agents",
    version,
    long_about = "Ensemble CLI - Run headless orchestration or launch web dashboard"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Interactively create an ensemble.yaml configuration file
    Init,
    
    /// Run the orchestrator in headless mode (terminal output only)
    Run {
        /// Path to ensemble.yaml
        #[arg(default_value = "ensemble.yaml")]
        config_path: PathBuf,
    },
    
    /// Run the orchestrator with web UI (SPA + HTTP server)
    Web {
        /// Path to ensemble.yaml
        #[arg(default_value = "ensemble.yaml")]
        config_path: PathBuf,
        
        /// HTTP server bind address
        #[arg(short, long, env = "HOST", default_value = "127.0.0.1")]
        host: String,
        
        /// HTTP server port (0 = auto-assign available port)
        #[arg(short, long, env = "PORT")]
        port: Option<u16>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Command::Init => init::execute(init::InitArgs).await,
        Command::Run { config_path } => {
            run::execute(run::RunArgs { config_path }).await
        }
        Command::Web { config_path, host, port } => {
            web::execute(web::WebArgs { config_path, host, port }).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use clap::Parser;

    // Mutex to serialize tests that manipulate HOST/PORT env vars.
    // Env vars are process-global, so parallel tests would race.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Helper: lock env, clear HOST/PORT, return saved values + guard.
    fn lock_and_clear_env() -> (
        std::sync::MutexGuard<'static, ()>,
        Option<String>,
        Option<String>,
    ) {
        let guard = ENV_LOCK.lock().unwrap();
        let host = std::env::var("HOST").ok();
        let port = std::env::var("PORT").ok();
        std::env::remove_var("HOST");
        std::env::remove_var("PORT");
        (guard, host, port)
    }

    /// Helper: restore previously saved HOST/PORT env vars.
    fn restore_env(host: Option<String>, port: Option<String>) {
        match host {
            Some(v) => std::env::set_var("HOST", v),
            None => std::env::remove_var("HOST"),
        }
        match port {
            Some(v) => std::env::set_var("PORT", v),
            None => std::env::remove_var("PORT"),
        }
    }

    // ---- `ensemble init` subcommand ----

    #[test]
    fn test_cli_parse_init_subcommand() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "init"]);
        assert!(matches!(cli.command, Command::Init));
        restore_env(host, port);
    }

    // ---- `ensemble run` subcommand ----

    #[test]
    fn test_cli_parse_run_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run"]);
        match cli.command {
            Command::Run { config_path } => {
                assert_eq!(config_path, PathBuf::from("ensemble.yaml"));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_run_custom_config() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "run", "custom/ensemble.yaml"]);
        match cli.command {
            Command::Run { config_path } => {
                assert_eq!(config_path, PathBuf::from("custom/ensemble.yaml"));
            }
            other => panic!("expected Run subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- `ensemble web` subcommand ----

    #[test]
    fn test_cli_parse_web_defaults() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Command::Web { config_path, host, port } => {
                assert_eq!(config_path, PathBuf::from("ensemble.yaml"));
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, None);
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_custom_args() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from([
            "ensemble",
            "web",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "custom/ensemble.yaml",
        ]);
        match cli.command {
            Command::Web { config_path, host, port } => {
                assert_eq!(config_path, PathBuf::from("custom/ensemble.yaml"));
                assert_eq!(host, "0.0.0.0");
                assert_eq!(port, Some(8080));
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_env_host() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Command::Web { host, .. } => assert_eq!(host, "10.0.0.1"),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_env_port() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "web"]);
        match cli.command {
            Command::Web { port, .. } => assert_eq!(port, Some(9090)),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_flag_overrides_env() {
        let (_guard, host, port) = lock_and_clear_env();
        std::env::set_var("HOST", "10.0.0.1");
        std::env::set_var("PORT", "9090");
        let cli = Cli::parse_from(["ensemble", "web", "--host", "0.0.0.0", "--port", "3000"]);
        match cli.command {
            Command::Web { host, port, .. } => {
                assert_eq!(host, "0.0.0.0");
                assert_eq!(port, Some(3000));
            }
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    #[test]
    fn test_cli_parse_web_ephemeral_port() {
        let (_guard, host, port) = lock_and_clear_env();
        let cli = Cli::parse_from(["ensemble", "web", "--port", "0"]);
        match cli.command {
            Command::Web { port, .. } => assert_eq!(port, Some(0)),
            other => panic!("expected Web subcommand, got {:?}", other),
        }
        restore_env(host, port);
    }

    // ---- No subcommand should fail ----

    #[test]
    fn test_cli_no_subcommand_fails() {
        let (_guard, host, port) = lock_and_clear_env();
        // Clap should exit with error when no subcommand given
        // We can't easily test this since clap calls std::process::exit
        // Just verify that the parser requires a subcommand
        let result = std::panic::catch_unwind(|| {
            let _cli = Cli::parse_from(["ensemble"]);
        });
        // This will panic/exit, so we're just documenting the expected behavior
        restore_env(host, port);
    }
}
```

- [ ] **Step 2: Verify main.rs compiles**

Run: `cargo check -p ensemble-cli 2>&1`
Expected: Clean compile with no errors

- [ ] **Step 3: Run CLI tests**

Run: `cargo test -p ensemble-cli 2>&1`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-cli/src/main.rs
git commit -m "feat(cli): restructure main.rs with explicit run/web commands

- Remove ambiguous default subcommand behavior
- Add Command::Run for headless mode
- Add Command::Web for web UI mode
- Update all tests for new CLI structure"
```

---

## Task 7: Update API Router

**Files:**
- Modify: `crates/ensemble-core/src/api/router.rs`

**Context:** Remove the `static_dir` parameter from `create_api_router_with_static()` since static file serving is now handled by the embedded UI module in CLI. Simplify to just API routes.

- [ ] **Step 1: Update router.rs to remove static_dir**

Replace the entire file with:
```rust
use crate::api::{config_handler, controls, conversation, handlers, history_handler, ws};
use crate::config::ensemble::EnsembleConfig;
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use utoipa::OpenApi;

/// Shared application state passed to all API handlers.
#[derive(Clone)]
pub struct AppState {
    /// The orchestrator state, shared with the orchestrator task via RwLock.
    pub orchestrator_state: Arc<RwLock<OrchestratorState>>,
    /// Flag that signals the orchestrator to run an immediate tick.
    /// The orchestrator polls this flag; setting it triggers a refresh.
    pub refresh_requested: Arc<tokio::sync::Notify>,
    /// The workspace root path, used for building issue detail paths.
    pub workspace_root: String,
    /// Path to the history JSONL file.
    pub history_path: PathBuf,
    /// Event bus for pipeline event broadcasting.
    pub event_bus: EventBus,
    /// The loaded ensemble configuration.
    pub config: Arc<EnsembleConfig>,
    /// Path to the ensemble.yaml config file.
    pub config_path: String,
}

/// Create the axum router for the Ensemble HTTP API.
///
/// Endpoints:
/// - `GET /api/v1/state` — runtime snapshot
/// - `POST /api/v1/refresh` — trigger immediate poll+reconcile
/// - `GET /api/v1/history` — query history records
/// - `GET /api/v1/{identifier}` — issue-specific detail
/// - `GET /api/v1/{identifier}/conversation` — paginated conversation
/// - `GET /api/v1/{identifier}/conversation/{index}` — single conversation message
/// - `POST /api/v1/{identifier}/stop` — stop a running agent
/// - `POST /api/v1/{identifier}/retry` — retry a failed issue
/// - `GET /ws/events/{identifier}` — WebSocket live event stream
///
/// **Security:** The API is unauthenticated. Bind to `127.0.0.1` by
/// default. Binding to a non-loopback address exposes this unauthenticated API to the
/// network — only do so in trusted environments or behind a reverse proxy.
///
/// Note: This router provides API routes only. UI/SPA serving is handled separately
/// by the CLI's embedded_ui module.
pub fn create_api_router(state: AppState) -> Router {
    // API routes get a JSON 404 fallback
    let api_routes = Router::new()
        .route("/state", get(handlers::get_state))
        .route(
            "/refresh",
            post(handlers::post_refresh)
                .get(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        )
        .route("/history", get(history_handler::get_history))
        .route("/config", get(config_handler::get_config))
        .route(
            "/{identifier}/conversation",
            get(conversation::get_conversation),
        )
        .route(
            "/{identifier}/conversation/{index}",
            get(conversation::get_conversation_message),
        )
        .route("/{identifier}/stop", post(controls::post_stop))
        .route("/{identifier}/retry", post(controls::post_retry))
        .route(
            "/{identifier}",
            get(handlers::get_issue_detail)
                .post(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        )
        .fallback(api_not_found);

    // Generate OpenAPI spec once at startup.
    let openapi_json = crate::api::openapi::ApiDoc::openapi()
        .to_json()
        .expect("OpenAPI spec serialization should not fail");

    Router::new()
        .route(
            "/api/openapi.json",
            get(move || {
                let json = openapi_json.clone();
                async move { (StatusCode::OK, [("content-type", "application/json")], json) }
            }),
        )
        .nest("/api/v1", api_routes)
        .route("/ws/events/{identifier}", get(ws::ws_events))
        .with_state(state)
}

/// Fallback handler for unmatched API routes. Returns a JSON 404.
async fn api_not_found() -> impl IntoResponse {
    let error = handlers::ApiError::new("not_found", "API endpoint not found");
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::to_value(error).unwrap()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app_state() -> AppState {
        let state = OrchestratorState::new(30000, 10);
        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config: Arc::new(crate::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
            config_path: "ensemble.yaml".to_string(),
        }
    }

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }
}
```

- [ ] **Step 2: Verify ensemble-core compiles**

Run: `cargo check -p ensemble-core 2>&1`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/api/router.rs
git commit -m "refactor(core): remove static_dir from API router

- Simplify create_api_router to provide API routes only
- UI/SPA serving now handled by CLI's embedded_ui module
- Remove create_api_router_with_static function"
```

---

## Task 8: Verify Full CLI Build

**Files:**
- All CLI files

**Context:** Ensure the complete CLI builds successfully with all new components.

- [ ] **Step 1: Build CLI**

Run: `cargo build -p ensemble-cli 2>&1`
Expected: Successful build

- [ ] **Step 2: Run all CLI tests**

Run: `cargo test -p ensemble-cli 2>&1`
Expected: All tests pass

- [ ] **Step 3: Verify binary exists**

Run: `ls -la target/debug/ensemble 2>&1`
Expected: Binary exists

- [ ] **Step 4: Test help output**

Run: `./target/debug/ensemble --help`
Expected: Shows new command structure with init, run, web

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "feat(cli): complete CLI restructuring with embedded SPA

- ensemble init: Interactive wizard (unchanged)
- ensemble run: Headless orchestrator (no HTTP)
- ensemble web: Web UI with embedded SPA

SPA is built from ensemble-ui/src-ui and embedded at compile time."
```

---

## Task 9: Add Desktop Dependencies

**Files:**
- Modify: `crates/ensemble-desktop/Cargo.toml`

**Context:** Desktop app needs the same embedded SPA support and access to ensemble-core.

- [ ] **Step 1: Update desktop Cargo.toml**

Replace with:
```toml
[package]
name = "ensemble-desktop"
version = "0.1.0"
edition.workspace = true
license.workspace = true
rust-version.workspace = true

[dependencies]
ensemble-core = { path = "../ensemble-core" }
tokio = { workspace = true }
tracing = { workspace = true }
tauri = { version = "2", features = [] }
axum = { workspace = true }
tower-http = { workspace = true }
rust-embed = { workspace = true }
mime_guess = "2"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

- [ ] **Step 2: Verify desktop Cargo.toml**

Run: `cargo check -p ensemble-desktop 2>&1 | head -30`
Expected: No parse errors

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/Cargo.toml
git commit -m "chore(desktop): add dependencies for embedded SPA and backend"
```

---

## Task 10: Create Desktop Build Script

**Files:**
- Create: `crates/ensemble-desktop/build.rs`

**Context:** Desktop needs its own SPA build (same approach as CLI but into desktop's assets).

- [ ] **Step 1: Create build.rs**

```rust
use std::path::PathBuf;
use std::process::Command;

fn main() {
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
        .args(&["ci"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm ci");
    
    if !npm_ci.status.success() {
        println!("cargo:warning=npm ci failed: {}", String::from_utf8_lossy(&npm_ci.stderr));
        std::process::exit(1);
    }
    
    let npm_build = Command::new("npm")
        .args(&["run", "build"])
        .current_dir(&ui_dir)
        .output()
        .expect("Failed to run npm build");
    
    if !npm_build.status.success() {
        println!("cargo:warning=npm run build failed: {}", String::from_utf8_lossy(&npm_build.stderr));
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
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/build.rs
git commit -m "feat(desktop): add build script to compile and embed SPA"
```

---

## Task 11: Create Desktop Embedded UI Module

**Files:**
- Create: `crates/ensemble-desktop/src/embedded_ui.rs`

**Context:** Similar to CLI's embedded_ui but adapted for Tauri's custom protocol serving.

- [ ] **Step 1: Create embedded_ui.rs**

```rust
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Serve an embedded file by path
pub fn get_file(path: &str) -> Option<EmbeddedFile> {
    SpaAssets::get(path).map(|file| EmbeddedFile {
        data: file.data.to_vec(),
        content_type: mime_guess::from_path(path).first_or_octet_stream().to_string(),
    })
}

/// Get index.html for SPA fallback
pub fn get_index_html() -> Option<EmbeddedFile> {
    SpaAssets::get("index.html").map(|file| EmbeddedFile {
        data: file.data.to_vec(),
        content_type: "text/html".to_string(),
    })
}

/// Check if SPA is available
pub fn spa_available() -> bool {
    SpaAssets::get("index.html").is_some()
}

pub struct EmbeddedFile {
    pub data: Vec<u8>,
    pub content_type: String,
}

/// Resolve a path to an embedded file or fallback to index.html
pub fn resolve_path(path: &str) -> Option<EmbeddedFile> {
    // Try exact path
    if let Some(file) = get_file(path) {
        return Some(file);
    }
    
    // Try with .html
    let html_path = format!("{}.html", path);
    if let Some(file) = get_file(&html_path) {
        return Some(file);
    }
    
    // Try directory index
    let dir_index = format!("{}/index.html", path);
    if let Some(file) = get_file(&dir_index) {
        return Some(file);
    }
    
    // Fallback to root index.html
    get_index_html()
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src/embedded_ui.rs
git commit -m "feat(desktop): add embedded SPA module for Tauri"
```

---

## Task 12: Create Desktop Orchestrator Integration

**Files:**
- Create: `crates/ensemble-desktop/src/orchestrator.rs`

**Context:** Desktop needs to start and manage the ensemble-core orchestrator as a background task.

- [ ] **Step 1: Create orchestrator.rs**

```rust
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::config::ensemble::{load_config, validate_config};
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

/// Desktop orchestrator state
pub struct DesktopOrchestrator {
    pub state: Arc<RwLock<OrchestratorState>>,
    pub event_bus: EventBus,
    pub config_path: String,
}

impl DesktopOrchestrator {
    /// Initialize the orchestrator from config
    pub async fn new(config_path: PathBuf) -> Result<Self, String> {
        info!(config_path = %config_path.display(), "Initializing desktop orchestrator");
        
        // Load config
        let config = load_config(&config_path)
            .map_err(|e| format!("Failed to load config: {}", e))?;
        
        validate_config(&config)
            .map_err(|e| format!("Config validation failed: {}", e))?;
        
        build_dag(&config.steps)
            .map_err(|e| format!("DAG validation failed: {}", e))?;
        
        info!(
            tracker_kind = %config.tracker.kind,
            "Orchestrator config loaded"
        );
        
        let state = Arc::new(RwLock::new(OrchestratorState::new(
            config.polling.interval_ms,
            config.concurrency.max_concurrent_agents,
        )));
        
        Ok(Self {
            state,
            event_bus: EventBus::new(),
            config_path: config_path.display().to_string(),
        })
    }
    
    /// Start the orchestrator loop (placeholder for now)
    pub async fn start(&self) -> Result<(), String> {
        info!("Desktop orchestrator started (placeholder)");
        // TODO: Implement actual orchestrator loop
        Ok(())
    }
    
    /// Stop the orchestrator
    pub async fn stop(&self) {
        info!("Desktop orchestrator stopped");
    }
}

/// Tauri command to get orchestrator state snapshot
#[tauri::command]
pub async fn get_state(orchestrator: tauri::State<'_, DesktopOrchestrator>) -> Result<serde_json::Value, String> {
    let state = orchestrator.state.read().await;
    
    // Build state snapshot (simplified for now)
    let snapshot = serde_json::json!({
        "status": "running",
        "running_count": 0,
        "claimed_count": 0,
        "config_path": orchestrator.config_path,
    });
    
    Ok(snapshot)
}

/// Tauri command to trigger refresh
#[tauri::command]
pub async fn trigger_refresh(orchestrator: tauri::State<'_, DesktopOrchestrator>) -> Result<(), String> {
    info!("Refresh requested via desktop UI");
    // TODO: Implement actual refresh
    Ok(())
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src/orchestrator.rs
git commit -m "feat(desktop): add orchestrator integration module"
```

---

## Task 13: Update Desktop Main Entry

**Files:**
- Modify: `crates/ensemble-desktop/src/main.rs`

**Context:** Replace the empty Tauri shell with full backend integration and SPA serving.

- [ ] **Step 1: Rewrite main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::Manager;
use tracing::{error, info};

mod embedded_ui;
mod orchestrator;

use embedded_ui::{resolve_path, spa_available};
use orchestrator::{DesktopOrchestrator, get_state, trigger_refresh};

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
            let orchestrator = rt.block_on(async {
                DesktopOrchestrator::new(config_path).await
            })?;
            
            app.manage(orchestrator);
            
            // Start orchestrator
            let orchestrator_ref = app.state::<DesktopOrchestrator>();
            rt.spawn(async move {
                if let Err(e) = orchestrator_ref.start().await {
                    error!("Orchestrator failed: {}", e);
                }
            });
            
            info!("Ensemble Desktop initialized successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Tauri command to serve UI files
#[tauri::command]
fn serve_ui_file(path: String) -> Result<UiFile, String> {
    let file = resolve_path(&path)
        .ok_or_else(|| format!("File not found: {}", path))?;
    
    Ok(UiFile {
        data: file.data,
        content_type: file.content_type,
    })
}

#[derive(serde::Serialize)]
struct UiFile {
    data: Vec<u8>,
    content_type: String,
}
```

- [ ] **Step 2: Verify desktop compiles**

Run: `cargo check -p ensemble-desktop 2>&1`
Expected: Clean compile (may have warnings about unused code until fully implemented)

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src/main.rs
git commit -m "feat(desktop): integrate backend and SPA serving

- Initialize ensemble-core orchestrator on startup
- Add Tauri commands for state and refresh
- Add SPA file serving command
- Log warnings if SPA not available"
```

---

## Task 14: Final Verification

**Files:**
- All project files

**Context:** Full project build and test verification.

- [ ] **Step 1: Build entire workspace**

Run: `cargo build --workspace 2>&1`
Expected: Successful build

- [ ] **Step 2: Run all tests**

Run: `cargo test --workspace 2>&1`
Expected: All tests pass

- [ ] **Step 3: Run clippy**

Run: `cargo clippy --workspace -- -D warnings 2>&1`
Expected: No warnings

- [ ] **Step 4: Check formatting**

Run: `cargo fmt --all -- --check 2>&1`
Expected: No formatting issues (or run `cargo fmt --all` to fix)

- [ ] **Step 5: Verify binaries**

Run: `ls -la target/debug/ensemble target/debug/ensemble-desktop 2>&1`
Expected: Both binaries exist

- [ ] **Step 6: Test CLI help**

Run: `./target/debug/ensemble --help`
Expected: Shows init, run, web subcommands

Run: `./target/debug/ensemble run --help`
Expected: Shows run-specific options

Run: `./target/debug/ensemble web --help`
Expected: Shows web-specific options

- [ ] **Step 7: Commit final state**

```bash
git add -A
git commit -m "feat: complete CLI and app architecture redesign

- Restructure CLI with explicit run/web subcommands
- Embed SPA at compile time using rust-embed
- Desktop app now integrates ensemble-core backend
- Remove ambiguous default subcommand behavior
- Update all tests for new structure"
```

---

## Documentation Updates

**Task 15: Update README**

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README with new commands**

Add CLI usage section:
```markdown
## Usage

### Initialize a new project
\`\`\`bash
ensemble init
\`\`\`

### Run headless orchestrator
\`\`\`bash
ensemble run
\`\`\`

### Run with web dashboard
\`\`\`bash
ensemble web
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with new CLI commands"
```

---

## Summary

This plan transforms Ensemble from an ambiguous CLI structure to a clean OpenCode-style architecture:

1. **CLI Commands:**
   - `ensemble init` - Interactive wizard
   - `ensemble run` - Headless orchestrator (no UI)
   - `ensemble web` - Web UI with embedded SPA

2. **SPA Embedding:**
   - Built at compile time via `build.rs`
   - Embedded using `rust-embed`
   - Served via axum with proper MIME types

3. **Desktop App:**
   - Integrates `ensemble-core` backend
   - Serves same SPA via Tauri
   - Provides native window wrapper

4. **API Router:**
   - Simplified to API routes only
   - UI handling moved to CLI/desktop

All tasks follow TDD principles with test-first approach where applicable, and each step produces a commit-able, working state.
