# Desktop Setup And Config Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a shared desktop/web setup and config-editing experience that can create, repair, validate, save, and reload `ensemble.yaml` without requiring the CLI.

**Architecture:** Add shared config-draft and setup-artifact services in `ensemble-core`, expose them through config-management HTTP endpoints, and update both `ensemble web` and the Tauri desktop app to tolerate missing or invalid config on startup. Replace the read-only Config page with a stateful workspace that supports Setup Mode, YAML recovery/editing, and guided workflow editing while preserving unknown YAML fields.

**Tech Stack:** Rust (`serde_yaml`, `axum`, `utoipa`, `tokio`, `tempfile`), Tauri 2, React 19, TanStack Query, React Router, Vitest, React Testing Library, CodeMirror YAML editor

**Design Spec:** `docs/superpowers/specs/2026-04-01-desktop-setup-and-config-editing-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `crates/ensemble-core/src/error.rs` | Modify | Add config write / invalid draft error variants needed by draft persistence |
| `crates/ensemble-core/src/config/mod.rs` | Modify | Export new draft, setup, and form modules |
| `crates/ensemble-core/src/config/draft.rs` | Create | Load missing/invalid/valid config states, validate raw YAML, save atomically |
| `crates/ensemble-core/src/config/setup.rs` | Create | Build setup artifacts, discover setup agents/capabilities, seed reconfigure defaults, and preserve unsupported YAML fields during wizard saves |
| `crates/ensemble-core/src/config/form.rs` | Create | Extract guided-form data from YAML/config and merge guided edits back into YAML while preserving unknown fields |
| `crates/ensemble-core/src/api/mod.rs` | Modify | Export new config edit handler module |
| `crates/ensemble-core/src/api/config_handler.rs` | Modify | Return config lifecycle state instead of only a loaded config snapshot |
| `crates/ensemble-core/src/api/config_edit_handler.rs` | Create | YAML validate/save, setup validate/save, setup defaults/agent discovery, guided-form validate/save endpoints |
| `crates/ensemble-core/src/api/router.rs` | Modify | Replace `Arc<EnsembleConfig>` app state with config runtime store and register new routes |
| `crates/ensemble-core/src/api/openapi.rs` | Modify | Add new config-management paths and schemas |
| `crates/ensemble-core/tests/api_endpoints.rs` | Modify | Cover new config endpoints and missing/invalid-config states |
| `crates/ensemble-core/tests/openapi_spec.rs` | Modify indirectly via command | Regenerate `crates/ensemble-ui/src-ui/openapi.json` |
| `crates/ensemble-cli/src/commands/init/generate.rs` | Modify | Delegate setup artifact generation/writing to shared core services |
| `crates/ensemble-cli/src/commands/init/validate.rs` | Modify | Delegate setup validation checks to shared core services |
| `crates/ensemble-cli/src/commands/web.rs` | Modify | Serve UI even when config is missing or invalid; only start runtime pieces when config is runnable |
| `crates/ensemble-desktop/src/server.rs` | Create | Start local axum server for desktop with API + SPA routes |
| `crates/ensemble-desktop/src/main.rs` | Modify | Stop hard-failing on missing config, start local server, open Tauri window to localhost |
| `crates/ensemble-desktop/src/orchestrator.rs` | Modify | Manage config runtime/orchestrator lifecycle without Tauri-specific commands |
| `crates/ensemble-desktop/src/embedded_ui.rs` | Modify | Expose SPA fallback router for desktop server mode |
| `crates/ensemble-desktop/tauri.conf.json` | Modify | Stop depending on static `index.html` startup; allow runtime-created window URL |
| `crates/ensemble-desktop/tests/e2e.rs` | Modify | Smoke-test missing-config startup and valid-config startup under the new local-server model |
| `crates/ensemble-ui/src-ui/package.json` | Modify | Add testing and YAML editor dependencies |
| `crates/ensemble-ui/src-ui/vitest.config.ts` | Create | Configure `jsdom` + setup file for React tests |
| `crates/ensemble-ui/src-ui/src/test/setup.ts` | Create | Global RTL and fetch mocking helpers |
| `crates/ensemble-ui/src-ui/src/test/render.tsx` | Create | Shared `renderWithProviders()` helper |
| `crates/ensemble-ui/src-ui/src/App.tsx` | Modify | Route to new config workspace page |
| `crates/ensemble-ui/src-ui/src/components/Layout.tsx` | Modify | Gate dashboard/history navigation when config is missing or invalid |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Modify | Add hooks for config state, setup defaults/agent discovery, YAML validate/save, setup validate/save, guided-form validate/save |
| `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx` | Create | Top-level config workspace switching between Setup, Edit, YAML recovery, and validation states |
| `crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx` | Create | Config workspace state-flow tests |
| `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx` | Create | First-run and reconfigure wizard shell |
| `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx` | Create | Wizard progression / validation tests |
| `crates/ensemble-ui/src-ui/src/components/config/YamlEditor.tsx` | Create | CodeMirror-backed YAML editor with recovery mode |
| `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx` | Create | Structured editor for tracker/repos/agents/runtime/state transitions |
| `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.tsx` | Create | Guided workflow step editor with guardrails |
| `crates/ensemble-ui/src-ui/src/components/config/ValidationPanel.tsx` | Create | Reusable display for syntax/config/environment validation |
| `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.test.tsx` | Create | Workflow guardrail and validation tests |
| `crates/ensemble-ui/src-ui/openapi.json` | Generated | Frontend API schema generated from `ensemble-core` |
| `crates/ensemble-ui/src-ui/src/generated/api/**/*` | Generated | Orval output for new endpoints |
| `crates/ensemble-ui/src-ui/src/generated/models/**/*` | Generated | Orval models for new responses and requests |

---

### Task 1: Add Config Draft Lifecycle Support In `ensemble-core`

**Files:**
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Create: `crates/ensemble-core/src/config/draft.rs`

- [ ] **Step 1: Write the failing draft-state tests**

Add focused tests in `crates/ensemble-core/src/config/draft.rs` for missing files, syntax errors, parseable-but-invalid configs, and atomic save behavior.

```rust
#[test]
fn load_config_state_reports_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ensemble.yaml");

    let state = load_config_state(&path).unwrap();

    assert_eq!(state.kind, ConfigStateKind::Missing);
    assert!(state.raw_yaml.is_none());
    assert!(state.active_config.is_none());
}

#[test]
fn load_config_state_preserves_raw_yaml_for_syntax_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ensemble.yaml");
    std::fs::write(&path, "tracker:\n  kind: todo_file\nagents: [\n").unwrap();

    let state = load_config_state(&path).unwrap();

    assert_eq!(state.kind, ConfigStateKind::SyntaxError);
    assert!(state.raw_yaml.as_deref().unwrap().contains("agents: ["));
    assert!(state
        .validation
        .issues
        .iter()
        .any(|issue| issue.kind == ValidationIssueKind::Syntax));
}
```

- [ ] **Step 2: Run the targeted test file and watch it fail**

Run: `cargo test -p ensemble-core draft::tests -- --nocapture`

Expected: compile failures because `draft.rs` and its state types do not exist yet.

- [ ] **Step 3: Add config draft state types and loaders**

Create `crates/ensemble-core/src/config/draft.rs` with a small, explicit state model.

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigStateKind {
    Missing,
    SyntaxError,
    Parsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ValidationIssue {
    pub kind: ValidationIssueKind,
    pub message: String,
    pub section: String,
    pub field: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DraftValidationReport {
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone)]
pub struct ConfigDocumentState {
    pub path: PathBuf,
    pub kind: ConfigStateKind,
    pub raw_yaml: Option<String>,
    pub document: Option<serde_yaml::Value>,
    pub active_config: Option<EnsembleConfig>,
    pub validation: DraftValidationReport,
}
```

Implement:

- `load_config_state(path: &Path) -> Result<ConfigDocumentState, ConfigError>`
- `parse_raw_yaml(path: PathBuf, raw_yaml: String) -> ConfigDocumentState`
- `validate_document(document: &serde_yaml::Value) -> DraftValidationReport`
- `save_raw_yaml_atomically(path: &Path, raw_yaml: &str) -> Result<ConfigDocumentState, ConfigError>`

`validate_document()` must emit structured issues that the UI can map back to sections or fields. Use stable `section` values like `yaml`, `tracker`, `repos`, `agents`, `workflow`, `runtime`, and `environment`, and populate `field`/`path` whenever the source location is known.

Behavior requirements:

- missing file -> `Missing`
- YAML syntax failure -> `SyntaxError`, raw YAML preserved
- YAML parse success -> `Parsed`, `document` populated
- typed config + `validate_config()` + `build_dag()` results copied into `issues` with `kind = ValidationIssueKind::Config`
- save writes to a temp file in the same directory and renames into place only after config-valid draft checks pass

- [ ] **Step 4: Add explicit error variants for invalid draft/save failures**

In `crates/ensemble-core/src/error.rs`, add variants that let callers distinguish invalid drafts from I/O failures.

```rust
#[error("config write rejected: {reason}")]
ConfigWriteRejected { reason: String },

#[error("config write failed: {reason}")]
ConfigWriteFailed { reason: String },
```

Use these from `save_raw_yaml_atomically()` instead of returning generic stringly errors.

- [ ] **Step 5: Re-run the targeted tests and make them pass**

Run: `cargo test -p ensemble-core draft::tests -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Run the full `ensemble-core` test suite**

Run: `cargo test -p ensemble-core`

Expected: all `ensemble-core` tests pass, including existing config parsing tests.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/error.rs crates/ensemble-core/src/config/mod.rs crates/ensemble-core/src/config/draft.rs
git commit -m "Add config draft lifecycle support"
```

---

### Task 2: Extract Shared Setup Artifact Generation And Validation

**Files:**
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Create: `crates/ensemble-core/src/config/setup.rs`
- Modify: `crates/ensemble-cli/src/commands/init/generate.rs`
- Modify: `crates/ensemble-cli/src/commands/init/validate.rs`

- [ ] **Step 1: Write the failing shared-setup tests**

Create tests in `crates/ensemble-core/src/config/setup.rs` that verify setup artifact generation and setup checks.

```rust
#[test]
fn build_setup_artifacts_creates_yaml_and_templates() {
    let request = SetupRequest {
        tracker: SetupTracker::TodoFile { path: PathBuf::from("TODO.md") },
        repos: vec![],
        agents: vec![SetupAgent {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
            model: None,
        }],
        steps: vec![SetupStep {
            name: "implement".to_string(),
            agent_role: "builder".to_string(),
            depends: vec![],
            tracker_state: Some("In Progress".to_string()),
        }],
        on_success: "Done".to_string(),
        on_failure: "Failed".to_string(),
    };

    let artifacts = build_setup_artifacts(&request).unwrap();

    assert!(artifacts.raw_yaml.contains("acpx_agent: claude"));
    assert!(artifacts.templates.contains_key("templates/implement.liquid"));
    assert!(artifacts.todo_md.is_some());
}
```

- [ ] **Step 2: Run the targeted setup tests and confirm they fail**

Run: `cargo test -p ensemble-core setup::tests -- --nocapture`

Expected: compile failures because `SetupRequest`, `SetupTracker`, and `build_setup_artifacts()` do not exist yet.

- [ ] **Step 3: Implement the shared setup request and artifact types**

Create `crates/ensemble-core/src/config/setup.rs` with the typed setup boundary the CLI and GUI can both use.

```rust
pub struct SetupRequest {
    pub tracker: SetupTracker,
    pub repos: Vec<SetupRepo>,
    pub agents: Vec<SetupAgent>,
    pub steps: Vec<SetupStep>,
    pub on_success: String,
    pub on_failure: String,
}

pub struct SetupArtifacts {
    pub raw_yaml: String,
    pub templates: BTreeMap<String, String>,
    pub todo_md: Option<String>,
    pub env_file: Option<String>,
}
```

Implement:

- `build_setup_artifacts(&SetupRequest) -> Result<SetupArtifacts, ConfigError>`
- `write_setup_artifacts(root: &Path, artifacts: &SetupArtifacts) -> Result<(), ConfigError>`
- `run_setup_checks(&SetupRequest) -> Vec<SetupCheck>`
- `extract_setup_defaults(raw_yaml: &str) -> Result<SetupRequest, ConfigError>`
- `merge_setup_request(base_raw_yaml: Option<&str>, request: &SetupRequest) -> Result<SetupArtifacts, ConfigError>`
- `discover_available_agents() -> Result<Vec<DiscoveredAgent>, ConfigError>`
- `discover_agent_capabilities(agent: &str) -> AgentCapabilities`

Keep the existing CLI file formats exactly the same unless the spec explicitly changes them.

`merge_setup_request()` is the key reconfigure path: when `base_raw_yaml` is present and parseable, update only the known setup-managed sections inside the YAML tree so unsupported fields survive wizard saves.

- [ ] **Step 4: Move CLI `generate.rs` onto the shared core builder**

Replace direct string assembly in `crates/ensemble-cli/src/commands/init/generate.rs` with a thin adapter that maps `TrackerChoice`, `RepoEntry`, `AgentEntry`, and `PipelineStep` into `SetupRequest`, then calls `build_setup_artifacts()` and `write_setup_artifacts()`.

```rust
let request = SetupRequest::from_cli(tracker, repos, agents, steps, on_success, on_failure);
let artifacts = merge_setup_request(existing_raw_yaml.as_deref(), &request)?;
write_setup_artifacts(Path::new("."), &artifacts)?;
```

For fresh CLI init, `existing_raw_yaml` is `None`. For re-running init over an existing parseable config, pass the original file contents so unsupported fields are preserved.

- [ ] **Step 4a: Move CLI agent discovery onto the shared core service**

Refactor `crates/ensemble-cli/src/commands/init/agents.rs` so the prompt layer still lives in the CLI crate, but agent listing and model-capability probing delegate to `discover_available_agents()` and `discover_agent_capabilities()` in `setup.rs`.

This is required so the GUI wizard can expose the same acpx discovery behavior.

- [ ] **Step 5: Move CLI validation onto the shared setup checker**

Replace `crates/ensemble-cli/src/commands/init/validate.rs`'s ad hoc checks with a call into `run_setup_checks()`. Preserve current UX semantics:

- print all checks
- count failures
- still ask `Write config anyway?` when environment checks fail

- [ ] **Step 6: Run CLI and core tests**

Run: `cargo test -p ensemble-core setup::tests -- --nocapture && cargo test -p ensemble-cli`

Expected: all targeted and existing CLI tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/config/mod.rs crates/ensemble-core/src/config/setup.rs crates/ensemble-cli/src/commands/init/agents.rs crates/ensemble-cli/src/commands/init/generate.rs crates/ensemble-cli/src/commands/init/validate.rs
git commit -m "Share setup artifact generation across CLI and UI"
```

---

### Task 3: Add Config Management API And Make `ensemble web` Recoverable

**Files:**
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/config_handler.rs`
- Create: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Modify: `crates/ensemble-cli/src/commands/web.rs`

- [ ] **Step 1: Write the failing API tests for missing/invalid/save flows**

Extend `crates/ensemble-core/tests/api_endpoints.rs` to cover the new config lifecycle responses.

```rust
#[tokio::test]
async fn test_get_config_reports_missing_state() {
    let state = build_app_state_without_config();
    let base_url = start_test_server(state).await;
    let response = reqwest::get(format!("{}/api/v1/config", base_url)).await.unwrap();
    let json: serde_json::Value = response.json().await.unwrap();

    assert_eq!(response.status(), 200);
    assert_eq!(json["state"], "missing");
    assert!(json["active_config"].is_null());
}

#[tokio::test]
async fn test_post_yaml_validate_returns_syntax_errors() {
    let state = build_app_state_without_config();
    let base_url = start_test_server(state).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/v1/config/yaml/validate", base_url))
        .json(&serde_json::json!({ "raw_yaml": "tracker:\n  kind: todo_file\nagents: [" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["state"], "syntax_error");
}
```

- [ ] **Step 2: Run the targeted API tests and confirm they fail**

Run: `cargo test -p ensemble-core --test api_endpoints test_get_config_reports_missing_state -- --nocapture`

Expected: fail because the current app state requires a loaded `EnsembleConfig` and the new route paths do not exist.

- [ ] **Step 3: Replace `AppState`'s config payload with a runtime store**

In `crates/ensemble-core/src/api/router.rs`, replace the current `config: Arc<EnsembleConfig>` + `config_path: String` pairing with a single runtime config store.

```rust
#[derive(Clone)]
pub struct ConfigRuntime {
    pub config_path: PathBuf,
    pub document_state: Arc<RwLock<ConfigDocumentState>>,
}

#[derive(Clone)]
pub struct AppState {
    pub orchestrator_state: Arc<RwLock<OrchestratorState>>,
    pub refresh_requested: Arc<tokio::sync::Notify>,
    pub workspace_root: String,
    pub history_path: PathBuf,
    pub event_bus: EventBus,
    pub config_runtime: ConfigRuntime,
}
```

All config handlers should read from `config_runtime.document_state`, not assume a valid active config is present.

- [ ] **Step 4: Implement config lifecycle and YAML/setup endpoints**

Create `crates/ensemble-core/src/api/config_edit_handler.rs` with focused config-management endpoints:

- `POST /api/v1/config/yaml/validate`
- `POST /api/v1/config/yaml/save`
- `GET /api/v1/config/setup/defaults`
- `GET /api/v1/config/setup/agents`
- `POST /api/v1/config/setup/validate`
- `POST /api/v1/config/setup/save`

Use explicit request/response types.

```rust
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ValidateYamlRequest {
    pub raw_yaml: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ConfigStateResponse {
    pub state: String,
    pub config_path: String,
    pub raw_yaml: Option<String>,
    pub issues: Vec<ValidationIssue>,
    pub active_config: Option<EnsembleConfig>,
}
```

`GET /api/v1/config` should be updated in `config_handler.rs` to reuse the same `ConfigStateResponse` shape.

Also add explicit setup request/response schemas for:

- wizard defaults seeded from the current config when parseable
- discovered agents and per-agent available models
- save responses that return the reloaded post-save `ConfigStateResponse`
- guided form payloads in the form-specific endpoints introduced by Task 7

Do not return three separate flat string lists; the UI needs a single structured issue list for field-level mapping.

- [ ] **Step 4a: Reload the runtime config store after every successful save**

Add a helper in `config_edit_handler.rs` (or a small private support module) that re-reads the on-disk config after save, updates `state.config_runtime.document_state`, and returns the refreshed `ConfigStateResponse`.

```rust
async fn reload_config_runtime(state: &AppState) -> Result<ConfigStateResponse, ConfigError> {
    let refreshed = load_config_state(&state.config_runtime.config_path)?;
    *state.config_runtime.document_state.write().await = refreshed.clone();
    Ok(ConfigStateResponse::from_state(&refreshed))
}
```

Every save endpoint must call this helper and respond with the reloaded state, not the pre-save draft.

- [ ] **Step 5: Update router and OpenAPI registration**

Register the new endpoints in `crates/ensemble-core/src/api/router.rs` and add them to `crates/ensemble-core/src/api/openapi.rs`.

Do not hand-edit frontend generated clients. Instead, make sure the OpenAPI spec includes every new request and response type cleanly.

- [ ] **Step 6: Make `ensemble web` serve the UI even when config is missing or invalid**

In `crates/ensemble-cli/src/commands/web.rs`:

- stop returning `ExitCode::FAILURE` for missing/invalid config at startup
- load `ConfigDocumentState` via `load_config_state()`
- initialize `AppState` with `config_runtime`
- only treat `document_state.active_config.is_some()` as runnable for orchestrator-related startup
- keep serving the SPA and API regardless of config state

Also make `ensemble web` react correctly after a save-driven reload:

- if a previously missing/invalid config becomes runnable, update any cached runtime settings from the refreshed `ConfigDocumentState`
- if a save produces a parseable-but-invalid config, keep serving the UI while exposing the new issues immediately

The current orchestrator loop is still a placeholder, so this task is mainly about startup state and API availability.

- [ ] **Step 7: Regenerate OpenAPI and frontend clients**

Run:

```bash
cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored
pnpm --prefix crates/ensemble-ui/src-ui run codegen:client
```

Expected: `crates/ensemble-ui/src-ui/openapi.json` and `src/generated/**` update without errors.

- [ ] **Step 8: Run API and web-mode verification**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints
cargo test -p ensemble-core
cargo test -p ensemble-cli
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/config_handler.rs crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/tests/api_endpoints.rs crates/ensemble-cli/src/commands/web.rs crates/ensemble-ui/src-ui/openapi.json crates/ensemble-ui/src-ui/src/generated
git commit -m "Add config management API and web recovery states"
```

---

### Task 4: Make Desktop Use The Same Local HTTP API As Web

**Files:**
- Create: `crates/ensemble-desktop/src/server.rs`
- Modify: `crates/ensemble-desktop/src/main.rs`
- Modify: `crates/ensemble-desktop/src/orchestrator.rs`
- Modify: `crates/ensemble-desktop/src/embedded_ui.rs`
- Modify: `crates/ensemble-desktop/tauri.conf.json`
- Modify: `crates/ensemble-desktop/tests/e2e.rs`

- [ ] **Step 1: Write or update the failing desktop smoke tests**

Update `crates/ensemble-desktop/tests/e2e.rs` so missing config is no longer treated as an expected crash.

```rust
#[test]
#[ignore = "Requires compiled app binary"]
fn app_stays_running_when_config_missing() {
    // same binary bootstrap as current test
    // assert the process is still alive after 3 seconds
}
```

Also keep a valid-config smoke test so both entry paths remain covered.

- [ ] **Step 2: Run the existing desktop unit tests first**

Run: `cargo test -p ensemble-desktop`

Expected: current tests pass before the startup rewrite, giving a clean baseline.

- [ ] **Step 3: Add a dedicated local-server module**

Create `crates/ensemble-desktop/src/server.rs` that starts a loopback `TcpListener`, builds an axum router from `create_api_router()` plus desktop SPA fallback routes, and returns the chosen URL.

```rust
pub struct DesktopServer {
    pub url: url::Url,
    pub shutdown: tokio::task::JoinHandle<()>,
}

pub async fn start_desktop_server(config_path: PathBuf) -> Result<DesktopServer, String> {
    // load ConfigDocumentState
    // build AppState
    // bind 127.0.0.1:0
    // serve router in background
}
```

Use the same `/api/v1/*` and `/ws/*` behavior as web mode.

- [ ] **Step 4: Convert the desktop app to open a runtime URL instead of static `index.html`**

In `crates/ensemble-desktop/src/main.rs`:

- remove the fatal missing-config early exit
- start the local server before creating the main window
- create the main window programmatically with `tauri::WebviewUrl::External(server.url.clone())`
- remove unused Tauri command plumbing that existed only for embedded-file serving

Example shape:

```rust
let rt = tokio::runtime::Runtime::new().unwrap();
let desktop_server = rt.block_on(start_desktop_server(resolve_config_path()))?;

tauri::Builder::default()
    .setup(move |app| {
        tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::External(desktop_server.url.clone()),
        )
        .title("Ensemble Dashboard")
        .build()?;
        Ok(())
    })
```

- [ ] **Step 5: Update the desktop SPA helper and Tauri config**

Modify `crates/ensemble-desktop/src/embedded_ui.rs` to expose an axum-style SPA router/fallback, mirroring the CLI helper.

Update `crates/ensemble-desktop/tauri.conf.json` so the main window is created at runtime rather than hard-wired to `index.html`. Keep dev settings intact for Tauri development, but do not depend on the config file's static `url` field in production.

- [ ] **Step 6: Simplify `orchestrator.rs` away from Tauri command assumptions**

`crates/ensemble-desktop/src/orchestrator.rs` should stop exposing config-only `#[tauri::command]` helpers. Its responsibility becomes:

- build runtime/orchestrator state when the config is runnable
- expose non-UI helpers used by `server.rs`
- no duplicated API surface separate from axum

- [ ] **Step 7: Run desktop verification**

Run:

```bash
cargo test -p ensemble-desktop
cargo build -p ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-desktop --test e2e -- --ignored
```

Expected: unit tests pass, the binary builds, and the ignored smoke tests verify both valid-config and missing-config startup flows.

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-desktop/src/server.rs crates/ensemble-desktop/src/main.rs crates/ensemble-desktop/src/orchestrator.rs crates/ensemble-desktop/src/embedded_ui.rs crates/ensemble-desktop/tauri.conf.json crates/ensemble-desktop/tests/e2e.rs
git commit -m "Use local HTTP server for desktop config flows"
```

---

### Task 5: Add Frontend Test Infrastructure And Config Workspace Shell

**Files:**
- Modify: `crates/ensemble-ui/src-ui/package.json`
- Create: `crates/ensemble-ui/src-ui/vitest.config.ts`
- Create: `crates/ensemble-ui/src-ui/src/test/setup.ts`
- Create: `crates/ensemble-ui/src-ui/src/test/render.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/App.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/Layout.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Create: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx`

- [ ] **Step 1: Add the missing frontend test dependencies**

Update `crates/ensemble-ui/src-ui/package.json` to add the minimum React test stack and YAML editor dependencies.

```json
{
  "dependencies": {
    "@uiw/react-codemirror": "^4.23.0",
    "@codemirror/lang-yaml": "^6.1.2"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/user-event": "^14.6.1",
    "jsdom": "^26.1.0"
  }
}
```

- [ ] **Step 2: Add a failing config-page state test**

Create `crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx` with a missing-config case.

```tsx
it("shows setup mode when the config state is missing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
    state: "missing",
    config_path: "/tmp/ensemble.yaml",
    raw_yaml: null,
    issues: [],
    active_config: null,
  })));

  renderWithProviders(<ConfigPage />, { route: "/config" });

  expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run frontend tests and confirm the new test fails**

Run: `pnpm --prefix crates/ensemble-ui/src-ui test`

Expected: fail because React test infrastructure and `ConfigPage` do not exist yet.

- [ ] **Step 4: Add Vitest + RTL setup files**

Create `vitest.config.ts`, `src/test/setup.ts`, and `src/test/render.tsx`.

```ts
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`renderWithProviders()` should wrap components in `QueryClientProvider` + `MemoryRouter` so page tests stay compact.

- [ ] **Step 5: Add a new config workspace page shell**

Create `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx` and move `App.tsx` to load it instead of `ConfigStatus.tsx`.

Initial `ConfigPage` only needs the state shell:

- `missing` -> render Setup Mode placeholder
- `syntax_error` -> render YAML recovery placeholder
- `parsed` + config errors -> render Edit Mode placeholder with validation panel
- runnable config -> render Edit Mode placeholder with tabs for Guided / YAML / Validation

Do not build the full editor here yet; just make state routing and placeholders real.

- [ ] **Step 6: Gate navigation when config is not runnable**

Update `crates/ensemble-ui/src-ui/src/components/Layout.tsx` so Dashboard and History are visibly disabled or redirected when `active_config` is not available. The Config route must remain accessible in every state.

- [ ] **Step 7: Add hooks for the new config API shape**

Update `crates/ensemble-ui/src-ui/src/hooks.ts` to unwrap the new config state response and expose:

- `useConfigStateQuery()`
- `useValidateYamlDraftMutation()`
- `useSaveYamlDraftMutation()`
- `useValidateSetupMutation()`
- `useSaveSetupMutation()`

Use generated Orval hooks; do not hand-edit files under `src/generated/`.

- [ ] **Step 8: Regenerate the client, then run frontend verification**

Run:

```bash
pnpm --prefix crates/ensemble-ui/src-ui run codegen:client
pnpm --prefix crates/ensemble-ui/src-ui test
pnpm --prefix crates/ensemble-ui/src-ui run build
```

Expected: codegen succeeds, tests pass, and the SPA build remains green.

- [ ] **Step 9: Commit**

```bash
git add crates/ensemble-ui/src-ui/package.json crates/ensemble-ui/src-ui/vitest.config.ts crates/ensemble-ui/src-ui/src/test/setup.ts crates/ensemble-ui/src-ui/src/test/render.tsx crates/ensemble-ui/src-ui/src/App.tsx crates/ensemble-ui/src-ui/src/components/Layout.tsx crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx crates/ensemble-ui/src-ui/src/generated
git commit -m "Add config workspace shell for missing and invalid states"
```

---

### Task 6: Implement Setup Wizard, Reconfigure Flow, And YAML Recovery Editor

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/config/YamlEditor.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/config/ValidationPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`

- [ ] **Step 1: Add failing tests for YAML recovery and wizard progression**

Create two concrete tests:

```tsx
it("shows YAML recovery mode for syntax errors", async () => {
  // mocked config state => state: "syntax_error"
  // assert CodeMirror editor is visible and Guided tab is disabled
});

it("walks through setup steps and calls validate before save", async () => {
  // mocked state => missing
  // fill tracker + repo + agent fields
  // click Validate
  // assert validation summary appears before Save is enabled
});

it("loads reconfigure defaults from the existing config state", async () => {
  // mocked state => parsed + active_config
  // mocked setup defaults => existing repo / agent / workflow values
  // click Reconfigure
  // assert the wizard opens with those values pre-filled
});
```

- [ ] **Step 2: Run the targeted frontend tests and confirm they fail**

Run: `pnpm --prefix crates/ensemble-ui/src-ui test -- SetupWizard`

Expected: failures because the wizard/editor components do not exist.

- [ ] **Step 3: Build the YAML editor with explicit recovery mode**

Create `crates/ensemble-ui/src-ui/src/components/config/YamlEditor.tsx` using CodeMirror.

```tsx
<CodeMirror
  value={rawYaml}
  extensions={[yaml()]}
  onChange={setRawYaml}
  basicSetup={{ lineNumbers: true, foldGutter: true }}
/>
```

The component must support:

- raw YAML editing
- syntax/config/environment validation display via `ValidationPanel`
- explicit `Validate`, `Save`, and `Reset` actions
- read-only or warning modes driven by the parent page state

- [ ] **Step 4: Implement the setup wizard shell and local draft state**

Create `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx` with a simple local draft object and explicit steps.

```ts
type SetupDraft = {
  tracker: { kind: "github" | "todo_file"; repository?: string; projectNumber?: number | null; todoPath?: string };
  repos: Array<{ path: string; branch: string }>;
  agents: Array<{ role: string; acpxAgent: string; model?: string | null }>;
  steps: Array<{ name: string; agentRole: string; depends: string[]; trackerState?: string | null }>;
  onSuccess: string;
  onFailure: string;
};
```

Support `Back`, `Next`, `Validate`, and `Save`. The wizard should call the setup endpoints from Task 3; do not rebuild validation logic client-side.

Additional requirements for this step:

- fetch `GET /api/v1/config/setup/defaults` on mount for missing-config and reconfigure flows
- fetch `GET /api/v1/config/setup/agents` when the user reaches the Agents step
- preserve CLI parity for quick-start workflow defaults (`implement` only for one agent, `implement -> review` for two agents)
- expose a `Reconfigure` entry point from parsed configs that opens the wizard with pre-populated values

- [ ] **Step 5: Wire `ConfigPage` to switch between Setup Mode and YAML recovery**

Update `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx` so:

- `missing` -> render `SetupWizard`
- `syntax_error` -> render `YamlEditor` in recovery mode
- `parsed` -> continue to Edit Mode shell (Guided editor still placeholder until Task 7)

On successful setup save, invalidate the config query and keep the user on `/config` so the page rehydrates into Edit Mode.

When reconfigure saves against an existing parseable config, the UI should use the same save path; unsupported YAML fields must survive because the backend merge happens server-side.

- [ ] **Step 6: Run UI verification**

Run:

```bash
pnpm --prefix crates/ensemble-ui/src-ui test
pnpm --prefix crates/ensemble-ui/src-ui run build
```

Expected: new component tests pass and the build stays green.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx crates/ensemble-ui/src-ui/src/components/config/YamlEditor.tsx crates/ensemble-ui/src-ui/src/components/config/ValidationPanel.tsx crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx
git commit -m "Add setup wizard and YAML recovery editor"
```

---

### Task 7: Add Guided Config Editing And Workflow Editor

**Files:**
- Create: `crates/ensemble-core/src/config/form.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/src/api/config_handler.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Create: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.tsx`
- Create: `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`

- [ ] **Step 1: Write the failing form-merge and workflow-editor tests**

Add one backend preservation test and one frontend guardrail test.

```rust
#[test]
fn apply_guided_form_preserves_unknown_top_level_fields() {
    let raw = r#"
tracker:
  kind: todo_file
custom_section:
  keep_me: true
agents:
  builder:
    acpx_agent: claude
    prompt: hello
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#;

    let merged = apply_guided_form(raw, &guided_form_with_workspace_root("/tmp/ws")).unwrap();
    assert!(merged.contains("custom_section:"));
    assert!(merged.contains("keep_me: true"));
}
```

```tsx
it("prevents selecting a dependency on a step that does not exist", async () => {
  render(<WorkflowEditor value={draft} onChange={onChange} />);
  expect(screen.queryByText("nonexistent-step")).not.toBeInTheDocument();
});

it("keeps YAML and guided state synchronized after a successful guided validate", async () => {
  // render ConfigPage in parsed state
  // change a workflow field in Guided mode
  // validate
  // switch to YAML tab and assert the updated YAML is present
});
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run:

```bash
cargo test -p ensemble-core form::tests -- --nocapture
pnpm --prefix crates/ensemble-ui/src-ui test -- WorkflowEditor
```

Expected: failures because form extraction/merge and the workflow editor are not implemented yet.

- [ ] **Step 3: Add a guided-form extraction/merge layer in `ensemble-core`**

Create `crates/ensemble-core/src/config/form.rs` with a stable JSON shape for the frontend guided editor.

```rust
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedConfigForm {
    pub tracker: GuidedTrackerForm,
    pub repos: Vec<GuidedRepoForm>,
    pub agents: Vec<GuidedAgentForm>,
    pub steps: Vec<GuidedStepForm>,
    pub runtime: GuidedRuntimeForm,
    pub transitions: GuidedTransitionForm,
}
```

Implement:

- `extract_guided_form(raw_yaml: &str) -> Result<GuidedConfigForm, ConfigError>`
- `apply_guided_form(base_raw_yaml: &str, form: &GuidedConfigForm) -> Result<String, ConfigError>`

`apply_guided_form()` must preserve unknown keys by editing a parsed `serde_yaml::Value` tree instead of reserializing from only the typed config struct.

- [ ] **Step 4: Add guided-form validate/save endpoints**

Extend `crates/ensemble-core/src/api/config_edit_handler.rs` with:

- `POST /api/v1/config/form/validate`
- `POST /api/v1/config/form/save`

Both endpoints should accept the current `base_raw_yaml` plus `GuidedConfigForm`, merge server-side, then run the same validation/save path as the YAML editor.

Also extend `GET /api/v1/config` so parseable configs include a `guided_form` payload for the frontend.

- [ ] **Step 5: Implement the guided editor and workflow editor UI**

Create `GuidedEditor.tsx` and `WorkflowEditor.tsx`.

`GuidedEditor` responsibilities:

- tracker section
- repos section
- agents section
- runtime settings section
- state transitions section
- save/reset/validate actions

`WorkflowEditor` responsibilities:

- editable ordered step cards/rows
- add/remove/reorder steps
- agent selector
- dependency selector constrained to existing prior steps
- live mini-summary badges for the pipeline

Use the backend guided-form endpoints; do not attempt YAML preservation in the browser.

- [ ] **Step 6: Add the recovery and safety affordances from the spec**

Update `ConfigPage.tsx` and/or `GuidedEditor.tsx` to show:

- unsaved changes badge
- explicit `Reset draft` action
- last validation report panel
- compare saved vs current draft action (a lightweight side-by-side raw YAML diff is enough)

Keep this intentionally lightweight; do not add a heavy diffing library unless a simple comparison view proves inadequate.

- [ ] **Step 7: Regenerate the client and run full frontend/core checks**

Run:

```bash
cargo test -p ensemble-core
cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored
pnpm --prefix crates/ensemble-ui/src-ui run codegen:client
pnpm --prefix crates/ensemble-ui/src-ui test
pnpm --prefix crates/ensemble-ui/src-ui run build
```

Expected: core tests, client codegen, UI tests, and SPA build all pass.

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-core/src/config/form.rs crates/ensemble-core/src/config/mod.rs crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/src/api/config_handler.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.tsx crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.test.tsx crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx crates/ensemble-ui/src-ui/openapi.json crates/ensemble-ui/src-ui/src/generated
git commit -m "Add guided config and workflow editing"
```

---

### Task 8: Full Verification And Integration Cleanup

**Files:**
- Modify only as needed from previous tasks after verification

- [ ] **Step 1: Run Rust formatting**

Run: `cargo fmt --all`

Expected: formatting updates apply cleanly.

- [ ] **Step 2: Run Rust linting**

Run: `cargo clippy --workspace -- -D warnings`

Expected: zero warnings.

- [ ] **Step 3: Run the full Rust test suite**

Run: `cargo test --workspace`

Expected: all workspace tests pass.

- [ ] **Step 4: Regenerate and verify frontend artifacts one final time**

Run:

```bash
pnpm --prefix crates/ensemble-ui/src-ui run codegen
pnpm --prefix crates/ensemble-ui/src-ui test
pnpm --prefix crates/ensemble-ui/src-ui run build
```

Expected: OpenAPI generation, Orval client generation, Vitest, and Vite build all pass.

- [ ] **Step 5: Run desktop smoke verification with a built binary**

Run:

```bash
cargo build -p ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-desktop --test e2e -- --ignored
```

Expected:

- valid config -> desktop stays alive and serves the app
- missing config -> desktop stays alive and lands in setup-capable mode

- [ ] **Step 6: Manual browser and desktop spot checks**

Run these by hand before declaring success:

1. `ensemble web --port 9131` with no `ensemble.yaml` -> `/config` shows Setup Mode
2. `ensemble web --port 9131` with YAML syntax error -> `/config` shows YAML recovery
3. Save a valid setup from the web UI -> config reloads without restarting the process
4. Launch desktop with missing config -> app stays open instead of exiting
5. Edit workflow in Guided mode -> validation catches bad dependencies before save

- [ ] **Step 7: Verify the working tree is clean**

Run: `git status --short`

Expected: no unstaged or uncommitted changes remain.

- [ ] **Step 8: Final commit (only if verification changed files)**

```bash
git add -A
git commit -m "Polish desktop and web config setup flows"
```

Only create this commit if Task 8 changed tracked files after verification.
