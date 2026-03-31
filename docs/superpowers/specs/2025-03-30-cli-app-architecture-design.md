# Ensemble CLI & App Architecture Redesign

**Date:** 2025-03-30  
**Status:** Approved for implementation  
**Scope:** CLI commands, web mode, desktop app integration

## Overview

Restructure Ensemble's application architecture to follow the OpenCode pattern:
- CLI supports both headless (`run`) and web (`web`) modes explicitly
- Web mode bundles the React SPA directly into the binary
- Desktop app embeds the backend and serves the SPA
- Backend web server never runs without a UI (either web or desktop)

## Goals

1. **Clear separation of concerns**: Headless vs web modes are distinct commands
2. **Self-contained distribution**: Web CLI and Desktop include bundled SPA
3. **Consistent UX**: Web and Desktop share the same UI code
4. **Maintain automation support**: Headless mode for CI/CD and servers
5. **Simplified deployment**: Single binary for web mode, single app for desktop

## Non-Goals

- Multi-tenant web hosting (each instance is single-user)
- Dynamic SPA updates without binary rebuild
- Desktop-specific UI features (keep SPA shared)

## Current State Analysis

### Existing Architecture

```
ensemble-cli/src/main.rs
├── ensemble (no subcommand) - runs orchestrator, --port is optional
├── ensemble init            - interactive wizard
└── ensemble run             - same as no subcommand

ensemble-desktop/src/main.rs
└── Empty Tauri shell (no backend integration)

ensemble-ui/src-ui/
└── React SPA (not bundled anywhere)
```

### Problems

1. Ambiguous default behavior: Does `ensemble` with `--port` start a web UI or just API?
2. SPA is not bundled - requires separate build and `--static_dir` flag
3. Desktop app has no backend functionality
4. No clear distinction between headless automation and interactive use

## Proposed Architecture

### CLI Commands

```
ensemble init              # Interactive wizard (unchanged)
ensemble run               # Headless orchestrator - terminal output only
  --config, -c             # Path to ensemble.yaml
ensemble web               # Web mode - HTTP server + bundled SPA
  --config, -c             # Path to ensemble.yaml
  --port, -p               # Server port (default: find available)
  --host, -h               # Bind address (default: 127.0.0.1)
ensemble --help, -V        # Top-level flags
```

### Crate Responsibilities

```
ensemble-core/
├── src/
│   ├── lib.rs             # Re-exports
│   ├── api/router.rs      # API routes (no SPA fallback logic)
│   ├── orchestrator/      # Orchestrator engine
│   └── ...                # Config, workspace, etc.

ensemble-cli/
├── Cargo.toml
├── build.rs               # Builds SPA from ensemble-ui during compile
├── src/
│   ├── main.rs            # CLI entry, command dispatch
│   ├── commands/
│   │   ├── init.rs        # Wizard implementation
│   │   ├── run.rs         # Headless orchestrator
│   │   └── web.rs         # Web server with embedded SPA
│   └── embedded_ui.rs     # Embedded file serving utilities
└── assets/
    └── spa/               # SPA dist/ embedded at compile time

ensemble-desktop/
├── Cargo.toml
├── build.rs               # Builds SPA from ensemble-ui during compile
├── src/
│   ├── main.rs            # Tauri entry
│   ├── commands/          # Tauri IPC commands calling ensemble-core
│   └── embedded_ui.rs     # Same embedding as CLI
└── assets/
    └── spa/               # SPA dist/ embedded at compile time

ensemble-ui/
└── src-ui/                # React SPA (unchanged)
    ├── package.json
    ├── vite.config.ts
    └── src/
```

## Detailed Design

### 1. SPA Embedding Strategy

Both `ensemble-cli` (web mode) and `ensemble-desktop` will embed the SPA at compile time.

**Build-time process:**
1. `ensemble-cli/build.rs` and `ensemble-desktop/build.rs` execute:
   ```bash
   cd ../ensemble-ui/src-ui
   npm ci
   npm run build
   cp -r dist ../../ensemble-cli/assets/spa/
   cp -r dist ../../ensemble-desktop/assets/spa/
   ```

2. Rust embeds the files using `include_dir!` macro or `rust-embed` crate

3. At runtime, axum serves files from the embedded bytes

**Implementation:**
```rust
// embedded_ui.rs
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "assets/spa"]
struct SpaAssets;

pub fn serve_embedded_file(path: &str) -> impl IntoResponse {
    // Serve from SpaAssets, fallback to index.html for SPA routes
}
```

### 2. CLI Command Restructure

**main.rs structure:**
```rust
#[derive(Parser)]
#[command(name = "ensemble")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Init,
    Run(RunArgs),
    Web(WebArgs),
}

struct RunArgs {
    #[arg(default_value = "ensemble.yaml")]
    config_path: PathBuf,
}

struct WebArgs {
    #[arg(default_value = "ensemble.yaml")]
    config_path: PathBuf,
    #[arg(short, long, default_value = "127.0.0.1")]
    host: String,
    #[arg(short, long)]
    port: Option<u16>,
}
```

**Command behavior:**

- `ensemble init`: Interactive wizard (existing implementation)
- `ensemble run`: 
  - Load config, validate
  - Start orchestrator poll loop
  - Output to terminal/logs only
  - No HTTP server
- `ensemble web`:
  - Load config, validate
  - Start orchestrator poll loop (background)
  - Start HTTP server with API routes
  - Serve SPA from embedded assets
  - SPA fallback: all non-API routes → index.html

### 3. Desktop App Integration

**main.rs structure:**
```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            cmd_get_state,
            cmd_refresh,
            cmd_get_history,
            // ... other commands
        ])
        .setup(|app| {
            // Start ensemble-core orchestrator in background
            let orchestrator = start_orchestrator()?;
            app.manage(orchestrator);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Tauri commands:**
- Each command calls into `ensemble-core` library
- Reuse same API handlers as web mode
- Serve SPA from embedded assets via Tauri's custom protocol

### 4. API Router Changes

Current `create_api_router_with_static()` takes `Option<PathBuf>` for static files.

**New design:**
```rust
// ensemble-core/src/api/router.rs
pub fn create_api_router(state: AppState) -> Router {
    // API routes only - no SPA handling
}

// ensemble-cli/src/commands/web.rs
pub fn create_web_router(core_state: AppState) -> Router {
    let api_router = create_api_router(core_state);
    
    Router::new()
        .nest("/api/v1", api_router)
        .route("/api/openapi.json", get(openapi_handler))
        .fallback(serve_embedded_spa) // SPA catch-all
}
```

### 5. Configuration & Environment

**Web mode defaults:**
- Host: `127.0.0.1` (configurable via `--host`)
- Port: Random available (configurable via `--port`)
- Config: `ensemble.yaml` in current directory (configurable via `--config`)

**Headless mode:**
- Config: `ensemble.yaml` in current directory
- No network exposure
- Logs to stdout/stderr or configured log sink

**Desktop app:**
- Config discovery same as CLI
- Port: Internal (no external exposure)
- Logs: Written to OS-appropriate location

### 6. Build Process

**Dependencies:**
- `ensemble-cli` and `ensemble-desktop` have build dependencies on `ensemble-ui`
- Cargo build order:
  1. Build `ensemble-core`
  2. Run `ensemble-ui` npm build (via `build.rs`)
  3. Build `ensemble-cli` and `ensemble-desktop` (embedding SPA)

**CI considerations:**
- Requires Node.js for SPA build
- Cache `node_modules` and `dist/` for faster builds
- Consider feature flag to skip SPA build for pure backend testing

## Error Handling

**Build-time errors:**
- SPA build fails → Compile error with clear message
- Missing npm/node → Helpful error message

**Runtime errors:**
- `ensemble web` with port conflict → Error with suggestion to use `--port`
- Missing SPA assets (dev mode?) → Warning, suggest building SPA
- Desktop backend fails → Show error dialog, exit gracefully

## Testing Strategy

**Unit tests:**
- Each crate maintains existing test structure
- CLI command parsing tests for new command structure

**Integration tests:**
- `ensemble run`: Mock orchestrator, verify startup/shutdown
- `ensemble web`: Start server, verify API responds, verify SPA loads
- Desktop: UI tests via Tauri's testing framework

**Build tests:**
- CI verifies SPA builds and embeds correctly
- Verify all expected assets present in binary

## Migration Path

**Breaking changes:**
- `ensemble` (no args) no longer defaults to running orchestrator
- `ensemble run` no longer accepts `--port` or `--static_dir`
- Users previously using `ensemble --port 8080` must switch to `ensemble web --port 8080`

**Migration guide:**
```bash
# Before:
ensemble --port 8080 --static_dir ./dist

# After:
ensemble web --port 8080
# (SPA is now embedded, no --static_dir needed)
```

## Future Considerations

1. **Standalone web server**: Could add `ensemble server` later for multi-user deployments
2. **SPA live reload**: Development mode could watch and reload SPA without rebuild
3. **Custom themes**: Desktop could support native menus/chrome while keeping SPA content

## Implementation Checklist

- [ ] Add `rust-embed` dependency to workspace
- [ ] Create `ensemble-cli/build.rs` for SPA compilation
- [ ] Create `ensemble-cli/src/embedded_ui.rs` module
- [ ] Restructure `ensemble-cli/src/main.rs` with new command enum
- [ ] Implement `commands/init.rs` (move from main)
- [ ] Implement `commands/run.rs` (headless mode)
- [ ] Implement `commands/web.rs` (web mode with SPA)
- [ ] Update `ensemble-desktop` with backend integration
- [ ] Create `ensemble-desktop/build.rs` for SPA compilation
- [ ] Remove `static_dir` parameter from API router
- [ ] Update documentation and examples
- [ ] Add migration guide to CHANGELOG

## References

- OpenCode CLI pattern: https://opencode.ai/docs/cli/
- OpenCode Web pattern: https://opencode.ai/docs/web/
- Tauri embedding guide: https://tauri.app/v1/guides/features/splashscreen
- rust-embed crate: https://github.com/pyros2097/rust-embed
