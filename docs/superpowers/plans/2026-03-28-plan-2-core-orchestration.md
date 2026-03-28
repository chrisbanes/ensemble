# Plan 2: Core Orchestration — GitHub Tracker, ACP Agent, Orchestrator, API, CLI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the runtime engine — GitHub Projects v2 tracker, ACP stdio agent client, orchestrator state machine with poll/dispatch/retry/reconciliation, REST API for observability, and a headless CLI binary that ties everything together.

**Architecture:** Builds on Plan 1's foundation (domain model, config, workspace manager). The orchestrator runs as a single tokio task with `select!` on poll timer, worker channel, retry timers, and config reload. Workers communicate back via `mpsc` channel. `OrchestratorState` lives behind `Arc<RwLock>` — the orchestrator writes, the API reads, workers never touch it. The CLI binary is the thin entry point that loads config, starts the orchestrator, and optionally binds the HTTP server.

**Tech Stack:** Rust (2021 edition), tokio, reqwest, axum, serde/serde_json, tracing, thiserror, chrono, clap, wiremock (tests), async-trait

---

## File Structure

```
ensemble/
├── Cargo.toml                                  # workspace root (modified: add reqwest, axum, wiremock, clap)
├── crates/
│   ├── ensemble-core/
│   │   ├── Cargo.toml                          # modified: add reqwest, axum, wiremock deps
│   │   └── src/
│   │       ├── lib.rs                          # modified: add new module declarations
│   │       ├── error.rs                        # modified: add AgentError variant
│   │       ├── tracker/
│   │       │   ├── mod.rs                      # existing (IssueTracker trait)
│   │       │   ├── model.rs                    # existing (domain types)
│   │       │   └── github.rs                   # NEW: GitHub Projects v2 GraphQL client
│   │       ├── agent/
│   │       │   ├── mod.rs                      # NEW: re-exports + AgentRunner trait
│   │       │   ├── acp_client.rs               # NEW: ACP stdio JSON-RPC 2.0 client
│   │       │   └── events.rs                   # NEW: ACP message → internal event mapping
│   │       ├── orchestrator/
│   │       │   ├── mod.rs                      # NEW: re-exports + Orchestrator struct
│   │       │   ├── state.rs                    # NEW: OrchestratorState
│   │       │   ├── scheduler.rs                # NEW: poll loop, candidate selection, dispatch
│   │       │   ├── reconciler.rs               # NEW: stall detection, tracker state refresh
│   │       │   └── retry.rs                    # NEW: exponential backoff, continuation retries
│   │       ├── api/
│   │       │   ├── mod.rs                      # NEW: re-exports
│   │       │   ├── router.rs                   # NEW: axum router
│   │       │   └── handlers.rs                 # NEW: GET /state, GET /:identifier, POST /refresh
│   │       ├── observability/
│   │       │   ├── mod.rs                      # NEW: re-exports
│   │       │   ├── logging.rs                  # NEW: tracing setup
│   │       │   └── snapshot.rs                 # NEW: RuntimeSnapshot struct
│   │       ├── config/                         # existing
│   │       └── workspace/                      # existing
│   │   └── tests/
│   │       ├── workflow_to_workspace.rs         # existing
│   │       ├── github_tracker.rs               # NEW: wiremock integration tests
│   │       └── api_endpoints.rs                # NEW: API JSON shape tests
│   └── ensemble-cli/
│       ├── Cargo.toml                          # NEW: CLI binary crate
│       └── src/
│           └── main.rs                         # NEW: CLI entry point
```

---

### Task 1: Add New Dependencies to Workspace

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Modify: `crates/ensemble-core/Cargo.toml`

- [ ] **Step 1: Add workspace dependencies**

Add `reqwest`, `axum`, `wiremock`, `clap`, `tower`, `tower-http`, `futures`, and `uuid` to the workspace root `Cargo.toml` `[workspace.dependencies]` section. Append these lines after the existing entries:

```toml
reqwest = { version = "0.12", features = ["json"] }
axum = "0.8"
tower = "0.5"
tower-http = { version = "0.6", features = ["cors"] }
clap = { version = "4", features = ["derive"] }
wiremock = "0.6"
futures = "0.3"
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: Add dependencies to ensemble-core Cargo.toml**

Add to `[dependencies]` in `crates/ensemble-core/Cargo.toml`:

```toml
reqwest = { workspace = true }
axum = { workspace = true }
tower = { workspace = true }
tower-http = { workspace = true }
futures = { workspace = true }
uuid = { workspace = true }
```

Add to `[dev-dependencies]`:

```toml
wiremock = { workspace = true }
```

- [ ] **Step 3: Add new module declarations to lib.rs**

Update `crates/ensemble-core/src/lib.rs`:

```rust
pub mod error;
pub mod tracker;
pub mod config;
pub mod workspace;
pub mod agent;
pub mod orchestrator;
pub mod api;
pub mod observability;
```

- [ ] **Step 4: Create stub modules so it compiles**

`crates/ensemble-core/src/agent/mod.rs`:
```rust
pub mod acp_client;
pub mod events;
```

`crates/ensemble-core/src/agent/acp_client.rs`:
```rust
// ACP client — fleshed out in Task 4
```

`crates/ensemble-core/src/agent/events.rs`:
```rust
// Agent events — fleshed out in Task 3
```

`crates/ensemble-core/src/orchestrator/mod.rs`:
```rust
pub mod state;
pub mod scheduler;
pub mod reconciler;
pub mod retry;
```

`crates/ensemble-core/src/orchestrator/state.rs`:
```rust
// Orchestrator state — fleshed out in Task 5
```

`crates/ensemble-core/src/orchestrator/scheduler.rs`:
```rust
// Scheduler — fleshed out in Task 6
```

`crates/ensemble-core/src/orchestrator/reconciler.rs`:
```rust
// Reconciler — fleshed out in Task 7
```

`crates/ensemble-core/src/orchestrator/retry.rs`:
```rust
// Retry — fleshed out in Task 8
```

`crates/ensemble-core/src/api/mod.rs`:
```rust
pub mod router;
pub mod handlers;
```

`crates/ensemble-core/src/api/router.rs`:
```rust
// Router — fleshed out in Task 10
```

`crates/ensemble-core/src/api/handlers.rs`:
```rust
// Handlers — fleshed out in Task 10
```

`crates/ensemble-core/src/observability/mod.rs`:
```rust
pub mod logging;
pub mod snapshot;
```

`crates/ensemble-core/src/observability/logging.rs`:
```rust
// Logging — fleshed out in Task 9
```

`crates/ensemble-core/src/observability/snapshot.rs`:
```rust
// Snapshot — fleshed out in Task 9
```

- [ ] **Step 5: Update error.rs to add AgentError**

Update `crates/ensemble-core/src/error.rs`:

```rust
use thiserror::Error;
use crate::tracker::TrackerError;

#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Tracker(#[from] TrackerError),
    #[error(transparent)]
    Agent(#[from] AgentError),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing workflow file: {path}")]
    MissingWorkflowFile { path: String },
    #[error("workflow parse error: {reason}")]
    WorkflowParseError { reason: String },
    #[error("front matter is not a map")]
    FrontMatterNotAMap,
    #[error("template parse error: {reason}")]
    TemplateParseError { reason: String },
    #[error("template render error: {reason}")]
    TemplateRenderError { reason: String },
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace creation failed: {reason}")]
    CreationFailed { reason: String },
    #[error("hook failed: {hook} — {reason}")]
    HookFailed { hook: String, reason: String },
    #[error("hook timed out: {hook} after {timeout_ms}ms")]
    HookTimedOut { hook: String, timeout_ms: u64 },
    #[error("workspace path outside root: {path}")]
    PathOutsideRoot { path: String },
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent not found: {command}")]
    AgentNotFound { command: String },
    #[error("invalid workspace cwd: {path}")]
    InvalidWorkspaceCwd { path: String },
    #[error("response timeout after {timeout_ms}ms")]
    ResponseTimeout { timeout_ms: u64 },
    #[error("turn timeout after {timeout_ms}ms")]
    TurnTimeout { timeout_ms: u64 },
    #[error("agent process exited unexpectedly: {reason}")]
    AgentExit { reason: String },
    #[error("response error: {reason}")]
    ResponseError { reason: String },
    #[error("turn failed: {reason}")]
    TurnFailed { reason: String },
    #[error("turn cancelled")]
    TurnCancelled,
    #[error("turn requires user input")]
    TurnInputRequired,
    #[error("handshake failed: {reason}")]
    HandshakeFailed { reason: String },
    #[error("protocol error: {reason}")]
    ProtocolError { reason: String },
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cargo build -p ensemble-core`
Expected: Compiles with no errors (warnings about unused code are fine)

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml crates/
git commit -m "scaffold: add Plan 2 dependencies, module stubs, and AgentError type"
```

---
