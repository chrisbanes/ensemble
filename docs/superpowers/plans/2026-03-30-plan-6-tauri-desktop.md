# Plan 6: Tauri Desktop App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the React dashboard (Plan 5) in a Tauri 2 native desktop app that starts the ensemble-core backend and opens a WebView to the local server.

**Architecture:** The Tauri binary (`ensemble-desktop`) lives in its own crate. It starts the ensemble-core orchestrator and axum HTTP server, then opens a WebView pointed at the local server URL. The React SPA built by Plan 5 is served as static assets. During development, the Tauri dev server proxies to Vite.

**Tech Stack:** Tauri 2, Rust, ensemble-core

**Depends on:** Plan 4 (backend API) and Plan 5 (React frontend) must be implemented first.

**Design spec:** `docs/superpowers/specs/2026-03-30-dashboard-design.md`

---

## File Structure

```
ensemble/
├── Cargo.toml                                     # workspace root (crates/* glob covers new crate)
├── crates/
│   └── ensemble-desktop/
│       ├── Cargo.toml                             # Tauri + ensemble-core deps
│       ├── tauri.conf.json                        # Tauri window config
│       ├── build.rs                               # Tauri build script
│       ├── icons/
│       │   └── icon.png                           # placeholder app icon
│       ├── src/
│       │   └── main.rs                            # Tauri entry: start core + server + webview
│       └── src-ui/                                # (already exists from Plan 5)
│           └── dist/                              # built SPA assets
```

---

### Task 1: Tauri Desktop App

**Files:**
- Create: `crates/ensemble-desktop/Cargo.toml`
- Create: `crates/ensemble-desktop/tauri.conf.json`
- Create: `crates/ensemble-desktop/build.rs`
- Create: `crates/ensemble-desktop/src/main.rs`
- Create: `crates/ensemble-desktop/icons/icon.png`

- [ ] **Step 1: Verify workspace glob covers new crate**

The root `Cargo.toml` has `members = ["crates/*"]` which already covers `crates/ensemble-desktop`. No change needed.

Run: `grep 'members' Cargo.toml`
Expected: `members = ["crates/*"]`

- [ ] **Step 2: Create Cargo.toml**

`crates/ensemble-desktop/Cargo.toml`:
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

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

- [ ] **Step 3: Create build.rs**

`crates/ensemble-desktop/build.rs`:
```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 4: Create tauri.conf.json**

`crates/ensemble-desktop/tauri.conf.json`:
```json
{
  "productName": "Ensemble",
  "version": "0.1.0",
  "identifier": "com.ensemble.dashboard",
  "build": {
    "frontendDist": "src-ui/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm --prefix src-ui run dev",
    "beforeBuildCommand": "npm --prefix src-ui run build"
  },
  "app": {
    "windows": [
      {
        "title": "Ensemble Dashboard",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ]
  }
}
```

- [ ] **Step 5: Create main.rs**

`crates/ensemble-desktop/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Note: In a production setup, `main.rs` would start the ensemble-core orchestrator and axum server before opening the WebView, so the dashboard has a backend to talk to. For now, the Tauri app points at the dev server (Vite proxy → ensemble backend) during development and serves the built assets in production.

- [ ] **Step 6: Create placeholder icon**

Create a placeholder `crates/ensemble-desktop/icons/icon.png` (can be any valid 512x512 PNG — the implementing agent should generate or copy a placeholder).

- [ ] **Step 7: Verify Tauri builds**

Run: `cd crates/ensemble-desktop && cargo tauri build --debug`
Expected: Builds successfully (may require Tauri system dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-desktop/Cargo.toml crates/ensemble-desktop/build.rs crates/ensemble-desktop/tauri.conf.json crates/ensemble-desktop/src/main.rs crates/ensemble-desktop/icons/
git commit -m "feat: Tauri desktop app wrapper for dashboard"
```

---

### Task 2: Full Build and Lint Check

- [ ] **Step 1: Run Rust checks**

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```
Expected: All pass.

- [ ] **Step 2: Run frontend build**

```bash
npm --prefix crates/ensemble-desktop/src-ui run build
```
Expected: Build succeeds.

- [ ] **Step 3: Verify Tauri dev mode**

```bash
cd crates/ensemble-desktop && cargo tauri dev
```
Expected: Tauri window opens showing the dashboard (connected to the ensemble backend if running, or showing connection error otherwise).

- [ ] **Step 4: Verify git status is clean**

```bash
git status
```
Expected: Clean working tree.
