# ACP Model Mode Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover ACP model and mode capabilities for normal `acpx_agent` runs from SDK `session/new` handshake data and expose them through Ensemble's serializable agent config/API surface.

**Architecture:** Add small domain structs for discovered ACP capabilities, parse SDK `SessionConfigOption` values by semantic category, and add a handshake-only SDK helper that starts `acpx --agent <name>` just long enough to initialize and create a session. `AcpxRuntime` calls that helper before the existing `acpx sessions ensure/prompt` flow, stores discovered capabilities in the shared in-memory `AgentConfig`, and then continues to execute through the existing `AcpxCli` path. The direct ACP runtime reuses the same parser and can also return capabilities, but issue 93 is considered fixed only when the default `acpx_agent` path stores them.

**Snapshot model:** The orchestrator dispatches each step with a snapshot of the config (`Arc<EnsembleConfig>`) that is independent of the runner's `Arc<RwLock<EnsembleConfig>>`. When the runner mutates its shared config to persist discovered capabilities, the snapshot held by the in-flight `AcpxRuntime` (or direct session) does not see the new fields. This is intentional for this PR — capabilities are surfaced to subsequent reads (the API layer, the next step attempt), not to the step currently being executed. Re-execing the step (or reading after the step completes) sees the new fields.

**Tech Stack:** Rust 2021, `agent-client-protocol` v0.14.0, `serde`, `utoipa`, existing `tokio` tests

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `crates/ensemble-core/src/config/ensemble.rs` | Define `ModelDefinition`, `ModeDefinition`, `DiscoveredCapabilities`; add optional capability fields to `AgentConfig` |
| Modify | `crates/ensemble-core/src/config/form.rs` | Carry capabilities in guided config responses without requiring them in YAML input |
| Modify | `crates/ensemble-core/src/agent/acp_client.rs` | Parse `SessionConfigOption` values; add handshake-only capability discovery; return capabilities from direct `run_acp_session` |
| Modify | `crates/ensemble-core/src/agent/mod.rs` | Store shared config in `AcpAgentRunner` so runtimes can update in-memory agent capabilities |
| Modify | `crates/ensemble-core/src/agent/acpx_runtime.rs` | Discover and store capabilities before normal `acpx` session execution |
| Modify | `crates/ensemble-core/src/api/config_edit_handler.rs` | Include discovered capability fields in setup agent API models |

## Task 1: Add Capability Domain Types

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Add the serializable model/mode structs near `AgentConfig`**

Add these structs immediately above `pub struct AgentConfig`:

```rust
/// A selectable model discovered from an ACP session configuration option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ModelDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A selectable session mode discovered from an ACP session configuration option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ModeDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Runtime-discovered ACP capabilities for an agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DiscoveredCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ModeDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
}
```

- [ ] **Step 2: Add optional fields to `AgentConfig`**

Add these fields after `pub model: Option<String>`:

```rust
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_models: Vec<ModelDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_modes: Vec<ModeDefinition>,
```

- [ ] **Step 3: Verify existing YAML keeps parsing**

Run: `cargo test -p ensemble-core config::ensemble::tests::test_parse_minimal_config -- --exact`

Expected: PASS. Existing YAML without capability fields must deserialize because both new fields default.

## Task 2: Carry Capabilities Through Guided Config

**Files:**
- Modify: `crates/ensemble-core/src/config/form.rs`

- [ ] **Step 1: Import the capability types**

At the top of the file, add:

```rust
use crate::config::ensemble::{ModeDefinition, ModelDefinition};
```

- [ ] **Step 2: Extend `GuidedAgentForm`**

Add these fields after `pub model: Option<String>`:

```rust
    #[serde(default)]
    pub available_models: Vec<ModelDefinition>,
    #[serde(default)]
    pub available_modes: Vec<ModeDefinition>,
```

- [ ] **Step 3: Populate guided form extraction**

In `extract_guided_form`, update the `GuidedAgentForm` construction:

```rust
                available_models: agent.available_models.clone(),
                available_modes: agent.available_modes.clone(),
```

- [ ] **Step 4: Preserve capability fields during guided form merge**

In `apply_guided_form`, where each agent mapping is built, insert:

```rust
                if !a.available_models.is_empty() {
                    am.insert(
                        "available_models".into(),
                        serde_yaml::to_value(&a.available_models).map_err(|e| {
                            ConfigError::YamlParseError {
                                reason: e.to_string(),
                            }
                        })?,
                    );
                }
                if !a.available_modes.is_empty() {
                    am.insert(
                        "available_modes".into(),
                        serde_yaml::to_value(&a.available_modes).map_err(|e| {
                            ConfigError::YamlParseError {
                                reason: e.to_string(),
                            }
                        })?,
                    );
                }
```

- [ ] **Step 5: Test guided extraction**

Add a unit test in `crates/ensemble-core/src/config/form.rs`:

```rust
#[test]
fn extract_guided_form_includes_agent_capabilities() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: Build it.
    available_models:
      - id: gpt-5
        name: GPT-5
    available_modes:
      - id: code
        name: Code
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

    let form = extract_guided_form(yaml).unwrap();
    let agent = form.agents.iter().find(|a| a.name == "builder").unwrap();

    assert_eq!(agent.available_models[0].id, "gpt-5");
    assert_eq!(agent.available_modes[0].id, "code");
}
```

- [ ] **Step 6: Run the form test**

Run: `cargo test -p ensemble-core config::form::tests::extract_guided_form_includes_agent_capabilities -- --exact`

Expected: PASS.

## Task 3: Parse ACP Session Config Options

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`

- [ ] **Step 1: Add SDK and config imports**

Extend the `agent_client_protocol::schema` import with:

```rust
    NewSessionRequest, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelectOptions,
```

Add:

```rust
use crate::config::ensemble::{DiscoveredCapabilities, ModeDefinition, ModelDefinition};
```

- [ ] **Step 2: Add parser helpers before `run_acp_session`**

```rust
fn option_description(option: &SessionConfigOption) -> Option<String> {
    option.description.clone().filter(|value| !value.is_empty())
}

fn model_definitions_from_option(option: &SessionConfigOption) -> Vec<ModelDefinition> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options
                .iter()
                .map(|value| ModelDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: option_description(option),
                })
                .collect(),
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .map(|value| ModelDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: option_description(option),
                })
                .collect(),
        },
        _ => Vec::new(),
    }
}

fn mode_definitions_from_option(option: &SessionConfigOption) -> Vec<ModeDefinition> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options
                .iter()
                .map(|value| ModeDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: option_description(option),
                })
                .collect(),
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .map(|value| ModeDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: option_description(option),
                })
                .collect(),
        },
        _ => Vec::new(),
    }
}

pub fn discover_capabilities_from_options(
    options: Option<&[SessionConfigOption]>,
) -> DiscoveredCapabilities {
    let mut capabilities = DiscoveredCapabilities::default();

    for option in options.unwrap_or(&[]) {
        match option.category.as_ref() {
            Some(SessionConfigOptionCategory::Model) => {
                if let SessionConfigKind::Select(select) = &option.kind {
                    capabilities.current_model = Some(select.current_value.to_string());
                }
                capabilities
                    .models
                    .extend(model_definitions_from_option(option));
            }
            Some(SessionConfigOptionCategory::Mode) => {
                if let SessionConfigKind::Select(select) = &option.kind {
                    capabilities.current_mode = Some(select.current_value.to_string());
                }
                capabilities.modes.extend(mode_definitions_from_option(option));
            }
            _ => {}
        }
    }

    capabilities
}
```

- [ ] **Step 3: Add parser tests**

Add a test in the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn discover_capabilities_from_options_extracts_models_and_modes() {
    use agent_client_protocol::schema::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

    let options = vec![
        SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![
                SessionConfigSelectOption::new("gpt-5", "GPT-5"),
                SessionConfigSelectOption::new("sonnet", "Sonnet"),
            ],
        )
        .category(SessionConfigOptionCategory::Model),
        SessionConfigOption::select(
            "mode",
            "Mode",
            "code",
            vec![
                SessionConfigSelectOption::new("code", "Code"),
                SessionConfigSelectOption::new("review", "Review"),
            ],
        )
        .category(SessionConfigOptionCategory::Mode),
    ];

    let capabilities = discover_capabilities_from_options(Some(&options));

    assert_eq!(capabilities.current_model.as_deref(), Some("gpt-5"));
    assert_eq!(capabilities.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-5", "sonnet"]);
    assert_eq!(capabilities.current_mode.as_deref(), Some("code"));
    assert_eq!(capabilities.modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["code", "review"]);
}
```

- [ ] **Step 4: Run the parser test**

Run: `cargo test -p ensemble-core agent::acp_client::tests::discover_capabilities_from_options_extracts_models_and_modes -- --exact`

Expected: PASS.

## Task 4: Add Handshake-Only ACP Capability Discovery

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`

- [ ] **Step 1: Add discovery config**

Add this public config struct after `AcpSessionConfig`:

```rust
#[derive(Debug)]
pub struct AcpCapabilityDiscoveryConfig {
    pub command: String,
    pub workspace_path: PathBuf,
    pub read_timeout_ms: u64,
}
```

- [ ] **Step 2: Add `discover_capabilities` helper**

Add this function before `run_acp_session`:

```rust
pub async fn discover_capabilities(
    config: AcpCapabilityDiscoveryConfig,
) -> Result<DiscoveredCapabilities, AgentError> {
    let transport_command = sdk_transport_command(&config.command, &config.workspace_path);
    let agent = AcpAgent::from_str(&transport_command).map_err(|e| AgentError::AgentNotFound {
        command: format!("{}: {}", config.command, e),
    })?;
    let read_timeout_ms = config.read_timeout_ms;
    let workspace_path = config.workspace_path.clone();
    let discovered = Arc::new(Mutex::new(DiscoveredCapabilities::default()));
    let discovered_inner = discovered.clone();
    let session_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let session_error_inner = session_error.clone();

    Client
        .builder()
        .name("ensemble-capability-discovery")
        .connect_with(agent, async move |cx| {
            match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    *session_error_inner.lock().await = Some(format!("initialize failed: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    *session_error_inner.lock().await =
                        Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            }

            let session_response = match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(NewSessionRequest::new(&workspace_path))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(e)) => {
                    *session_error_inner.lock().await = Some(format!("session error: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    *session_error_inner.lock().await =
                        Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            };

            *discovered_inner.lock().await =
                discover_capabilities_from_options(session_response.config_options.as_deref());
            Ok(())
        })
        .await
        .map_err(|e| AgentError::IoError {
            reason: e.to_string(),
        })?;

    if let Some(error_msg) = session_error.lock().await.clone() {
        if error_msg.contains("response timeout") {
            return Err(AgentError::ResponseTimeout {
                timeout_ms: read_timeout_ms,
            });
        }
        return Err(AgentError::SessionStartupFailed { reason: error_msg });
    }

    Ok(discovered.lock().await.clone())
}
```

- [ ] **Step 3: Add an empty-capability discovery test**

Add this test to `crates/ensemble-core/src/agent/acp_client.rs`:

```rust
#[tokio::test]
async fn discover_capabilities_times_out_when_agent_does_not_initialize() {
    let workspace = TempDir::new().unwrap();
    let config = AcpCapabilityDiscoveryConfig {
        command: "bash -lc 'while IFS= read -r _line; do sleep 60; done'".to_string(),
        workspace_path: workspace.path().to_path_buf(),
        read_timeout_ms: 50,
    };

    let result = tokio::time::timeout(
        Duration::from_millis(500),
        discover_capabilities(config),
    )
    .await;

    assert!(
        matches!(
            result,
            Ok(Err(AgentError::ResponseTimeout { timeout_ms: 50 }))
        ),
        "discovery should return the configured response timeout, got {result:?}"
    );
}
```

- [ ] **Step 4: Run discovery tests**

Run: `cargo test -p ensemble-core agent::acp_client::tests::discover_capabilities -- --nocapture`

Expected: PASS.

## Task 5: Capture Capabilities During Direct Session Startup

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Change `run_acp_session` return type**

Change:

```rust
) -> Result<(Option<serde_json::Value>, Vec<TurnResult>), AgentError> {
```

to:

```rust
) -> Result<(Option<serde_json::Value>, Vec<TurnResult>, DiscoveredCapabilities), AgentError> {
```

- [ ] **Step 2: Store discovered capabilities in `run_acp_session`**

Add next to `final_verdict`:

```rust
    let discovered_capabilities: Arc<Mutex<DiscoveredCapabilities>> =
        Arc::new(Mutex::new(DiscoveredCapabilities::default()));
```

Clone it for the connection closure:

```rust
    let discovered_capabilities_inner = discovered_capabilities.clone();
```

Replace the current `let session_builder = cx.build_session(&workspace_path);` and `let mut session = match ... start_session()` block with a direct `session/new` request that captures the typed response before attaching the active session:

```rust
            let session_response = match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(NewSessionRequest::new(&workspace_path))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(e)) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("session error: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            };

            let capabilities =
                discover_capabilities_from_options(session_response.config_options.as_deref());
            *discovered_capabilities_inner.lock().await = capabilities;

            let mut session = match cx.attach_session(session_response, Vec::new()) {
                Ok(session) => session,
                Err(e) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("session attach failed: {e}"));
                    return Ok(());
                }
            };
```

- [ ] **Step 3: Validate configured session mode before setting it**

Before `SetSessionModeRequest::new(...)`, add:

```rust
                    let discovered = discovered_capabilities_inner.lock().await;
                    if !discovered.modes.is_empty()
                        && !discovered.modes.iter().any(|candidate| candidate.id == *mode)
                    {
                        let mut err = session_error_inner.lock().await;
                        *err = Some(format!(
                            "configured session_mode '{}' is not supported by agent; available modes: {}",
                            mode,
                            discovered
                                .modes
                                .iter()
                                .map(|m| m.id.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                        return Ok(());
                    }
```

- [ ] **Step 4: Return capabilities**

At the end of `run_acp_session`, change:

```rust
    Ok((verdict, results))
```

to:

```rust
    let capabilities = discovered_capabilities.lock().await.clone();
    Ok((verdict, results, capabilities))
```

- [ ] **Step 5: Store the shared config in `AcpAgentRunner`**

In `crates/ensemble-core/src/agent/mod.rs`, change:

```rust
pub struct AcpAgentRunner;
```

to:

```rust
pub struct AcpAgentRunner {
    config: Arc<RwLock<EnsembleConfig>>,
}
```

Change the constructor:

```rust
    pub fn new(_config: Arc<RwLock<EnsembleConfig>>) -> Self {
        Self
    }
```

to:

```rust
    pub fn new(config: Arc<RwLock<EnsembleConfig>>) -> Self {
        Self { config }
    }
```

- [ ] **Step 6: Update `run_direct_step` destructuring**

In `crates/ensemble-core/src/agent/mod.rs`, change:

```rust
        let (final_verdict, turn_results) = run_acp_session(
```

to:

```rust
        let (final_verdict, turn_results, capabilities) = run_acp_session(
```

- [ ] **Step 7: Update existing acp client tests**

In `startup_initialize_uses_configured_read_timeout`, no destructuring change is needed because it asserts an error. If any success tests destructure the old tuple, update them to bind `_capabilities`.

- [ ] **Step 8: Run the ACP client tests**

Run: `cargo test -p ensemble-core agent::acp_client -- --nocapture`

Expected: PASS.

## Task 6: Discover Capabilities For Acpx Runtime

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Import discovery types**

Change the existing `acp_client` import:

```rust
use acp_client::{run_acp_session, AcpSessionConfig, TurnResult};
```

to:

```rust
use acp_client::{
    discover_capabilities, run_acp_session, AcpCapabilityDiscoveryConfig, AcpSessionConfig,
    TurnResult,
};
```

- [ ] **Step 2: Add an `acpx` ACP command builder**

Add this helper near `resolve_agent_command`:

```rust
fn resolve_acpx_acp_command(
    agent_config: &crate::config::ensemble::AgentConfig,
) -> Option<String> {
    let acpx_name = agent_config.acpx_agent.as_ref()?;
    let mut cmd = String::from("acpx");
    cmd.push_str(&format!(" --agent {}", shell_escape(acpx_name)));
    if let Some(ref model) = agent_config.model {
        cmd.push_str(&format!(" --model {}", shell_escape(model)));
    }
    Some(cmd)
}
```

- [ ] **Step 3: Add capability storage helper**

Add this method inside `impl AcpAgentRunner`:

```rust
    async fn store_agent_capabilities(
        &self,
        agent_name: &str,
        capabilities: crate::config::ensemble::DiscoveredCapabilities,
    ) {
        if capabilities.models.is_empty() && capabilities.modes.is_empty() {
            return;
        }

        let mut shared_config = self.config.write().await;
        if let Some(agent) = shared_config.agents.get_mut(agent_name) {
            agent.available_models = capabilities.models;
            agent.available_modes = capabilities.modes;
        }
    }
```

- [ ] **Step 4: Add `acpx` capability discovery method**

Add this method inside `impl AcpAgentRunner`:

```rust
    async fn discover_acpx_capabilities_for_request(
        &self,
        request: &AgentRunRequest<'_>,
    ) -> Result<(), AgentError> {
        let Some(agent_config) = request.config.agents.get(request.agent_name) else {
            return Ok(());
        };
        let Some(command) = resolve_acpx_acp_command(agent_config) else {
            return Ok(());
        };

        let capabilities = discover_capabilities(AcpCapabilityDiscoveryConfig {
            command,
            workspace_path: request.workspace_path.to_path_buf(),
            read_timeout_ms: request.config.agent.read_timeout_ms,
        })
        .await?;

        self.store_agent_capabilities(request.agent_name, capabilities)
            .await;
        Ok(())
    }
```

- [ ] **Step 5: Call discovery before normal `acpx` execution**

In `AgentRunner::run`, in the `runtime::RuntimeKind::Acpx` branch, insert this before `AcpxRuntime::new().run_step(&request, &prompt).await`:

```rust
                if let Err(error) = self.discover_acpx_capabilities_for_request(&request).await {
                    tracing::debug!(
                        agent_name = request.agent_name,
                        error = %error,
                        "ACP capability discovery failed for acpx runtime; continuing without discovered capabilities"
                    );
                }
```

Discovery failure must not fail the actual worker run because some `acpx` versions or agents may not expose `configOptions`.

- [ ] **Step 6: Store direct runtime capabilities with shared helper**

In `run_direct_step`, immediately after the `run_acp_session(...).await?;` call, add:

```rust
        self.store_agent_capabilities(request.agent_name, capabilities)
            .await;
```

- [ ] **Step 7: Add a command builder test**

Add this test to `crates/ensemble-core/src/agent/mod.rs`:

```rust
#[test]
fn resolve_acpx_acp_command_includes_agent_and_model() {
    let command = resolve_acpx_acp_command(&crate::config::ensemble::AgentConfig {
        runtime: Some("acpx".to_string()),
        executor: None,
        model: Some("gpt-5".to_string()),
        available_models: Vec::new(),
        available_modes: Vec::new(),
        acpx_agent: Some("codex".to_string()),
        permission_mode: None,
        prompt: Some("Build it.".to_string()),
        prompt_template: None,
        reasoning_level: None,
    });

    assert_eq!(command.as_deref(), Some("acpx --agent 'codex' --model 'gpt-5'"));
}
```

- [ ] **Step 8: Run agent runner tests**

Run: `cargo test -p ensemble-core agent::tests::resolve_acpx_acp_command_includes_agent_and_model -- --exact`

Expected: PASS.

## Task 7: Expose Capabilities in Setup Agent API Shape

**Files:**
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/src/config/setup.rs`

- [ ] **Step 1: Extend setup discovery models**

In `crates/ensemble-core/src/config/setup.rs`, change `AgentCapabilities` to:

```rust
pub struct AgentCapabilities {
    pub available_models: Vec<crate::config::ensemble::ModelDefinition>,
    pub available_modes: Vec<crate::config::ensemble::ModeDefinition>,
}
```

Update `from_session_json` so existing JSON model strings become definitions:

```rust
            caps.available_models = models
                .iter()
                .filter_map(|v| {
                    v.as_str().map(|id| crate::config::ensemble::ModelDefinition {
                        id: id.to_string(),
                        name: id.to_string(),
                        description: None,
                    })
                })
                .collect();
```

- [ ] **Step 2: Extend API response DTO**

In `DiscoveredAgentInfo`, add:

```rust
    #[serde(default)]
    pub available_models: Vec<crate::config::ensemble::ModelDefinition>,
    #[serde(default)]
    pub available_modes: Vec<crate::config::ensemble::ModeDefinition>,
```

- [ ] **Step 3: Populate empty capability defaults in existing setup discovery**

In both `get_setup_agents` and `get_setup_agents_stream`, update `DiscoveredAgentInfo` construction:

```rust
                    available_models: Vec::new(),
                    available_modes: Vec::new(),
```

This keeps the endpoint schema ready for UI while avoiding a slow ACP handshake during the broad "which agents are installed?" probe.

- [ ] **Step 4: Run API/config tests**

Run: `cargo test -p ensemble-core api::config_edit_handler config::setup -- --nocapture`

Expected: PASS.

## Task 8: Validation and Final Checks

**Files:**
- No edits unless verification finds compile or formatting issues.

- [ ] **Step 1: Format**

Run: `cargo fmt --all -- --check`

Expected: PASS. If it fails, run `cargo fmt --all`, then rerun the check.

- [ ] **Step 2: Check core crate**

Run: `cargo check -p ensemble-core`

Expected: PASS.

- [ ] **Step 3: Run focused tests**

Run:

```bash
cargo test -p ensemble-core agent::acp_client agent::tests::resolve_acpx_acp_command_includes_agent_and_model config::form config::setup api::config_edit_handler -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: Run clippy on core**

Run: `cargo clippy -p ensemble-core -- -D warnings`

Expected: PASS.

---

## Self-Review

- Issue coverage: Models and modes are parsed from ACP session `config_options`; current selections are captured; the default `acpx_agent` runtime performs handshake-only discovery before normal `acpx` execution; serializable config/API structs can carry the data; tests verify mock SDK option parsing and `acpx --agent` discovery command construction.
- Scope decision: The plan does not write discovered runtime capabilities back to `config.yaml` during normal runs. It exposes them through serializable config shapes and return values so the UI can display them later without surprising file edits.
- Dependency check: This plan assumes the current SDK-backed `acp_client.rs` from #91 is present, which is true in this worktree.
