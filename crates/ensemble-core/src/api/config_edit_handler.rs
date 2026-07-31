use crate::api::router::AppState;
use crate::config::draft::{
    parse_raw_yaml, save_raw_yaml_atomically, ConfigDocumentState, ConfigStateKind, ValidationIssue,
};
use crate::config::ensemble::EnsembleConfig;
use crate::config::secrets::{merge_redacted_yaml, redact_yaml_secrets, SecretDisplay};
use crate::config_watcher::{apply_config_from_disk_locked, ReloadOutcome};
use crate::error::ConfigError;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::time::Duration;
use tracing::warn;

/// Request to validate YAML content.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ValidateYamlRequest {
    pub raw_yaml: String,
}

/// Response containing the current configuration state.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ConfigStateResponse {
    pub state: String,
    pub config_path: String,
    pub raw_yaml: Option<String>,
    pub issues: Vec<ValidationIssue>,
    pub guided_form: Option<crate::config::form::GuidedConfigForm>,
}

impl ConfigStateResponse {
    /// Create a ConfigStateResponse from a ConfigDocumentState.
    pub fn from_state(state: &ConfigDocumentState) -> Self {
        let state_str = match state.kind {
            ConfigStateKind::Missing => "missing",
            ConfigStateKind::SyntaxError => "syntax_error",
            ConfigStateKind::Parsed => "parsed",
        };

        // Prefer the in-memory `active_config` snapshot when available so the
        // guided form reflects runtime-discovered state (e.g. ACP
        // `available_models`/`available_modes`) that the user has not yet
        // written back to YAML. Fall back to the parsed YAML view when no
        // active snapshot exists.
        let mut guided_form = state
            .raw_yaml
            .as_ref()
            .and_then(|yaml| crate::config::form::extract_guided_form(yaml).ok())
            .or_else(|| {
                state
                    .active_config
                    .as_ref()
                    .map(crate::config::form::guided_form_from_config)
            });

        if let (Some(form), Some(active_config)) = (&mut guided_form, &state.active_config) {
            for form_agent in &mut form.agents {
                if let Some(active_agent) = active_config.agents.get(&form_agent.name) {
                    form_agent.available_models = (!active_agent.available_models.is_empty())
                        .then(|| active_agent.available_models.clone());
                    form_agent.available_modes = (!active_agent.available_modes.is_empty())
                        .then(|| active_agent.available_modes.clone());
                }
            }
        }

        Self {
            state: state_str.to_string(),
            config_path: state.path.display().to_string(),
            raw_yaml: state.raw_yaml.as_deref().and_then(redact_yaml_secrets),
            issues: state.validation.issues.clone(),
            guided_form,
        }
    }
}

fn config_state_json(state: &ConfigDocumentState) -> Json<ConfigStateResponse> {
    Json(ConfigStateResponse::from_state(state))
}

fn push_config_issue(response: &mut ConfigStateResponse, section: &str, message: String) {
    response.issues.push(ValidationIssue {
        kind: crate::config::draft::ValidationIssueKind::Config,
        message,
        section: section.to_string(),
        field: None,
        path: None,
    });
}

fn current_error_json(
    current: &ConfigDocumentState,
    section: &str,
    message: String,
) -> Json<ConfigStateResponse> {
    let mut response = ConfigStateResponse::from_state(current);
    push_config_issue(&mut response, section, message);
    Json(response)
}

/// Build an error response from a config error.
fn build_error_response(current: &ConfigDocumentState, error: &ConfigError) -> ConfigStateResponse {
    let mut response = ConfigStateResponse::from_state(current);
    push_config_issue(&mut response, "save", format!("Save failed: {}", error));
    response
}

fn config_error_json(
    current: &ConfigDocumentState,
    error: &ConfigError,
) -> Json<ConfigStateResponse> {
    Json(build_error_response(current, error))
}

async fn finish_saved_config_transaction(
    state: &AppState,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let outcome = apply_config_from_disk_locked(state, false).await;
    let current = state.config_runtime.document_state.read().await;
    match outcome {
        Ok(ReloadOutcome::Applied | ReloadOutcome::Unchanged) => {
            (StatusCode::OK, config_state_json(&current))
        }
        Ok(ReloadOutcome::RestartRequired) => (
            StatusCode::CONFLICT,
            current_error_json(
                &current,
                "runtime",
                "Saved config changes workspace or repository resources; restart Ensemble to apply it"
                    .to_string(),
            ),
        ),
        Ok(ReloadOutcome::Rejected) => (
            StatusCode::BAD_REQUEST,
            current_error_json(
                &current,
                "save",
                "Saved config could not be activated; the last known good config is still running"
                    .to_string(),
            ),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            current_error_json(
                &current,
                "runtime",
                "Saved config could not replace the active runtime; retry the save".to_string(),
            ),
        ),
    }
}

async fn save_config_yaml_and_finish_transaction(
    state: &AppState,
    raw_yaml: &str,
) -> (StatusCode, Json<ConfigStateResponse>) {
    match save_raw_yaml_atomically(&state.config_runtime.config_path, raw_yaml) {
        Ok(_) => finish_saved_config_transaction(state).await,
        Err(error) => {
            let current = state.config_runtime.document_state.read().await;
            (StatusCode::BAD_REQUEST, config_error_json(&current, &error))
        }
    }
}

fn apply_guided_form_to_current(
    current: &ConfigDocumentState,
    base_raw_yaml: &str,
    form: &crate::config::form::GuidedConfigForm,
) -> Result<String, ConfigError> {
    let base_yaml = merge_redacted_yaml(current.raw_yaml.as_deref(), base_raw_yaml)?;
    crate::config::form::apply_guided_form(&base_yaml, form)
}

/// POST /api/v1/config/yaml/validate
///
/// Validates raw YAML content without saving it.
#[utoipa::path(
    post,
    path = "/api/v1/config/yaml/validate",
    operation_id = "validateYaml",
    request_body = ValidateYamlRequest,
    responses(
        (status = 200, description = "Validation result", body = ConfigStateResponse)
    ),
    tag = "config"
)]
pub async fn validate_yaml(
    State(state): State<AppState>,
    Json(request): Json<ValidateYamlRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let current = state.config_runtime.document_state.read().await;
    match merge_redacted_yaml(current.raw_yaml.as_deref(), &request.raw_yaml) {
        Ok(merged_yaml) => {
            let draft = parse_raw_yaml(state.config_runtime.config_path.clone(), merged_yaml);
            (StatusCode::OK, config_state_json(&draft))
        }
        Err(error) => {
            let draft = parse_raw_yaml(state.config_runtime.config_path.clone(), request.raw_yaml);
            let mut response = ConfigStateResponse::from_state(&draft);
            push_config_issue(&mut response, "yaml", error.to_string());
            (StatusCode::OK, Json(response))
        }
    }
}

/// Request to save YAML content.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SaveYamlRequest {
    pub raw_yaml: String,
}

/// POST /api/v1/config/yaml/save
///
/// Saves and validates YAML content to the config file.
#[utoipa::path(
    post,
    path = "/api/v1/config/yaml/save",
    operation_id = "saveYaml",
    request_body = SaveYamlRequest,
    responses(
        (status = 200, description = "Save result", body = ConfigStateResponse),
        (status = 400, description = "Invalid YAML or validation failed"),
        (status = 409, description = "Saved config requires a process restart", body = ConfigStateResponse),
        (status = 500, description = "Config saved but orchestrator restart failed", body = ConfigStateResponse)
    ),
    tag = "config"
)]
pub async fn save_yaml(
    State(state): State<AppState>,
    Json(request): Json<SaveYamlRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let _reload = state.config_runtime.reload_coordinator.lock().await;
    let doc_state = state.config_runtime.document_state.read().await;
    let merged_yaml = match merge_redacted_yaml(doc_state.raw_yaml.as_deref(), &request.raw_yaml) {
        Ok(merged_yaml) => merged_yaml,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                current_error_json(&doc_state, "yaml", error.to_string()),
            )
        }
    };

    drop(doc_state);
    save_config_yaml_and_finish_transaction(&state, &merged_yaml).await
}

/// Response containing setup defaults.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SetupDefaultsResponse {
    pub defaults: serde_json::Value,
    pub has_existing_config: bool,
}

/// GET /api/v1/config/setup/defaults
///
/// Returns wizard defaults seeded from the current config when parseable.
#[utoipa::path(
    get,
    path = "/api/v1/config/setup/defaults",
    operation_id = "getSetupDefaults",
    responses(
        (status = 200, description = "Setup defaults", body = SetupDefaultsResponse)
    ),
    tag = "config"
)]
pub async fn get_setup_defaults(
    State(state): State<AppState>,
) -> (StatusCode, Json<SetupDefaultsResponse>) {
    let doc_state = state.config_runtime.document_state.read().await;

    let extracted_setup = doc_state
        .raw_yaml
        .as_deref()
        .and_then(|yaml| crate::config::setup::extract_setup_defaults(yaml).ok());

    let (defaults, has_existing) = if let Some(setup) = extracted_setup {
        (
            serde_json::to_value(&setup).unwrap_or_else(|_| default_setup_defaults()),
            true,
        )
    } else if let Some(ref config) = doc_state.active_config {
        (setup_defaults_from_active_config(config), true)
    } else {
        (default_setup_defaults(), false)
    };

    let response = SetupDefaultsResponse {
        defaults,
        has_existing_config: has_existing,
    };

    (StatusCode::OK, Json(response))
}

/// Response containing discovered agents.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SetupAgentsResponse {
    pub agents: Vec<DiscoveredAgentInfo>,
}

/// Information about a discovered agent.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct DiscoveredAgentInfo {
    pub name: String,
    pub label: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_models: Vec<crate::config::ensemble::ModelDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_modes: Vec<crate::config::ensemble::ModeDefinition>,
}

fn discovered_agent_info_from_parts(
    name: String,
    label: String,
    version: String,
    capabilities: crate::config::setup::AgentCapabilities,
) -> DiscoveredAgentInfo {
    let available_models = if capabilities.typed_models.is_empty() {
        capabilities
            .available_models
            .into_iter()
            .map(|id| crate::config::ensemble::ModelDefinition {
                name: id.clone(),
                id,
                description: None,
            })
            .collect()
    } else {
        capabilities.typed_models
    };

    DiscoveredAgentInfo {
        name,
        label,
        version,
        available_models,
        available_modes: capabilities.available_modes,
    }
}

async fn discover_setup_agent_capabilities(
    agent_name: &str,
) -> crate::config::setup::AgentCapabilities {
    tokio::time::timeout(
        Duration::from_secs(12),
        crate::config::setup::discover_agent_capabilities(agent_name),
    )
    .await
    .unwrap_or_default()
}

/// GET /api/v1/config/setup/agents
///
/// Returns discovered agents.
#[utoipa::path(
    get,
    path = "/api/v1/config/setup/agents",
    operation_id = "getSetupAgents",
    responses(
        (status = 200, description = "Discovered agents", body = SetupAgentsResponse)
    ),
    tag = "config"
)]
pub async fn get_setup_agents(
    State(_state): State<AppState>,
) -> (StatusCode, Json<SetupAgentsResponse>) {
    // Discover available agents
    match crate::config::setup::discover_available_agents().await {
        Ok(agents) => {
            let mut probe_tasks = tokio::task::JoinSet::new();
            for agent in agents {
                probe_tasks.spawn(async move {
                    let capabilities = discover_setup_agent_capabilities(&agent.name).await;
                    discovered_agent_info_from_parts(
                        agent.name,
                        agent.label,
                        agent.version,
                        capabilities,
                    )
                });
            }

            let mut agent_infos = Vec::new();
            while let Some(join_result) = probe_tasks.join_next().await {
                if let Ok(agent) = join_result {
                    agent_infos.push(agent);
                }
            }

            let response = SetupAgentsResponse {
                agents: agent_infos,
            };
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            warn!(error = %e, "agent discovery failed, returning empty list");
            let response = SetupAgentsResponse { agents: vec![] };
            (StatusCode::OK, Json(response))
        }
    }
}

/// GET /api/v1/config/setup/agents/stream
///
/// Returns discovered agents as a Server-Sent Events stream.
/// Each agent is sent as it's discovered, allowing progressive UI updates.
#[utoipa::path(
    get,
    path = "/api/v1/config/setup/agents/stream",
    operation_id = "getSetupAgentsStream",
    responses(
        (status = 200, description = "Stream of discovered agents", body = String)
    ),
    tag = "config"
)]
pub async fn get_setup_agents_stream() -> impl axum::response::IntoResponse {
    use axum::response::sse::{Event, Sse};

    let stream = async_stream::stream! {
        let mut probe_tasks = tokio::task::JoinSet::new();

        // Spawn concurrent probe tasks for all known agents
        for (name, label) in crate::config::setup::KNOWN_AGENTS {
            let name = name.to_string();
            let label = label.to_string();
            probe_tasks.spawn(async move {
                let version = crate::config::setup::probe_agent(&name).await?;
                let capabilities = discover_setup_agent_capabilities(&name).await;
                Some(discovered_agent_info_from_parts(
                    name,
                    label,
                    version,
                    capabilities,
                ))
            });
        }

        // Stream results as they complete (order depends on which probes finish first)
        while let Some(join_result) = probe_tasks.join_next().await {
            if let Ok(Some(agent)) = join_result {
                if let Ok(json) = serde_json::to_string(&agent) {
                    yield Ok::<_, std::convert::Infallible>(Event::default().data(json));
                }
            }
        }
    };

    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(1))
            .text("keep-alive"),
    )
}

/// Request to validate a setup configuration.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ValidateSetupRequest {
    pub setup: crate::config::setup::SetupRequest,
}

/// Response containing setup validation results.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ValidateSetupResponse {
    pub checks: Vec<crate::config::setup::SetupCheck>,
    pub can_save: bool,
}

/// POST /api/v1/config/setup/validate
///
/// Validates a setup configuration without saving.
#[utoipa::path(
    post,
    path = "/api/v1/config/setup/validate",
    operation_id = "validateSetup",
    request_body = ValidateSetupRequest,
    responses(
        (status = 200, description = "Validation results", body = ValidateSetupResponse)
    ),
    tag = "config"
)]
pub async fn validate_setup(
    State(_state): State<AppState>,
    Json(request): Json<ValidateSetupRequest>,
) -> (StatusCode, Json<ValidateSetupResponse>) {
    let checks = crate::config::setup::run_setup_checks(&request.setup).await;
    let can_save = crate::config::setup::setup_can_save(&checks);

    let response = ValidateSetupResponse { checks, can_save };

    (StatusCode::OK, Json(response))
}

/// Request to save a setup configuration.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SaveSetupRequest {
    pub setup: crate::config::setup::SetupRequest,
}

/// POST /api/v1/config/setup/save
///
/// Saves a setup configuration and returns the new state.
#[utoipa::path(
    post,
    path = "/api/v1/config/setup/save",
    operation_id = "saveSetup",
    request_body = SaveSetupRequest,
    responses(
        (status = 200, description = "Save result", body = ConfigStateResponse),
        (status = 400, description = "Setup validation failed"),
        (status = 409, description = "Saved config requires a process restart", body = ConfigStateResponse),
        (status = 500, description = "Config saved but orchestrator restart failed", body = ConfigStateResponse)
    ),
    tag = "config"
)]
pub async fn save_setup(
    State(state): State<AppState>,
    Json(request): Json<SaveSetupRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    save_setup_with_checks(state, request, |setup| async move {
        crate::config::setup::run_setup_checks(&setup).await
    })
    .await
}

async fn save_setup_with_checks<CheckFn, CheckFuture>(
    state: AppState,
    request: SaveSetupRequest,
    run_checks: CheckFn,
) -> (StatusCode, Json<ConfigStateResponse>)
where
    CheckFn: FnOnce(crate::config::setup::SetupRequest) -> CheckFuture,
    CheckFuture: Future<Output = Vec<crate::config::setup::SetupCheck>>,
{
    let checks = run_checks(request.setup.clone()).await;
    if !crate::config::setup::setup_can_save(&checks) {
        let doc_state = state.config_runtime.document_state.read().await;
        return (
            StatusCode::BAD_REQUEST,
            current_error_json(&doc_state, "setup", "Setup validation failed".to_string()),
        );
    }

    let _reload = state.config_runtime.reload_coordinator.lock().await;
    let doc_state = state.config_runtime.document_state.read().await;
    let artifacts = match crate::config::setup::merge_setup_request(
        doc_state.raw_yaml.as_deref(),
        &request.setup,
    ) {
        Ok(artifacts) => artifacts,
        Err(e) => return (StatusCode::BAD_REQUEST, config_error_json(&doc_state, &e)),
    };

    let root = state
        .config_runtime
        .config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));

    match crate::config::setup::write_setup_artifacts(root, &request.setup, &artifacts) {
        Ok(()) => {
            drop(doc_state);
            finish_saved_config_transaction(&state).await
        }
        Err(e) => (StatusCode::BAD_REQUEST, config_error_json(&doc_state, &e)),
    }
}

fn default_setup_defaults() -> serde_json::Value {
    serde_json::json!({
        "tracker": { "kind": "todo_file" },
    })
}

fn setup_defaults_from_active_config(config: &EnsembleConfig) -> serde_json::Value {
    let tracker = match config.tracker.kind.as_str() {
        "github" => serde_json::json!({
            "kind": "github",
            "repository": config.tracker.repository,
            "project_number": config.tracker.project_number,
            "api_key": SecretDisplay::from_config_value(config.tracker.api_key.as_deref()),
            "active_states": config.tracker.active_states,
            "terminal_states": config.tracker.terminal_states,
        }),
        _ => serde_json::json!({
            "kind": "todo_file",
            "path": config
                .tracker
                .path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "TODO.md".to_string()),
        }),
    };

    let repos: Vec<_> = config
        .repos
        .iter()
        .map(|repo| {
            serde_json::json!({
                "path": repo.path,
                "branch": repo.branch,
            })
        })
        .collect();

    let agents: Vec<_> = config
        .agents
        .iter()
        .map(|(role, agent)| {
            serde_json::json!({
                "role": role,
                "acpx_agent": agent
                    .acpx_agent
                    .as_ref()
                    .or(agent.executor.as_ref())
                    .cloned()
                    .unwrap_or_default(),
                "model": agent.model,
            })
        })
        .collect();

    let steps: Vec<_> = config
        .steps
        .iter()
        .map(|step| {
            serde_json::json!({
                "name": step.name,
                "agent_role": step.agent,
                "kind": match step.kind {
                    crate::config::ensemble::StepKind::Agent => "agent",
                    crate::config::ensemble::StepKind::Synthesis => "synthesis",
                },
                "depends": step.depends.clone().unwrap_or_default(),
                "tracker_state": step.tracker_state,
                "approval": step.approval.as_ref().map(|approval| serde_json::json!({
                    "mode": approval.mode,
                    "state": approval.state,
                })),
            })
        })
        .collect();

    serde_json::json!({
        "tracker": tracker,
        "repos": repos,
        "agents": agents,
        "steps": steps,
        "on_success": config.on_success,
        "on_failure": config.on_failure,
    })
}

/// Request to validate guided form content.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ValidateGuidedFormRequest {
    pub base_raw_yaml: String,
    pub form: crate::config::form::GuidedConfigForm,
}

/// Response containing guided form validation results.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ValidateGuidedFormResponse {
    pub merged_yaml: String,
    pub issues: Vec<crate::config::draft::ValidationIssue>,
    pub valid: bool,
}

/// POST /api/v1/config/form/validate
///
/// Validates guided form content by merging with base YAML and validating.
#[utoipa::path(
    post,
    path = "/api/v1/config/form/validate",
    operation_id = "validateGuidedForm",
    request_body = ValidateGuidedFormRequest,
    responses(
        (status = 200, description = "Validation result", body = ValidateGuidedFormResponse)
    ),
    tag = "config"
)]
pub async fn validate_guided_form(
    State(state): State<AppState>,
    Json(request): Json<ValidateGuidedFormRequest>,
) -> (StatusCode, Json<ValidateGuidedFormResponse>) {
    let current = state.config_runtime.document_state.read().await;
    match apply_guided_form_to_current(&current, &request.base_raw_yaml, &request.form) {
        Ok(merged_yaml) => {
            // Parse and validate the merged YAML
            let draft = crate::config::draft::parse_raw_yaml(
                state.config_runtime.config_path.clone(),
                merged_yaml.clone(),
            );

            let valid = draft.kind == crate::config::draft::ConfigStateKind::Parsed
                && draft.validation.issues.is_empty();

            let response = ValidateGuidedFormResponse {
                merged_yaml: redact_yaml_secrets(&merged_yaml).unwrap_or_default(),
                issues: draft.validation.issues,
                valid,
            };
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let response = ValidateGuidedFormResponse {
                merged_yaml: redact_yaml_secrets(&request.base_raw_yaml).unwrap_or_default(),
                issues: vec![crate::config::draft::ValidationIssue {
                    kind: crate::config::draft::ValidationIssueKind::Config,
                    message: format!("Form merge failed: {}", e),
                    section: "form".to_string(),
                    field: None,
                    path: None,
                }],
                valid: false,
            };
            (StatusCode::BAD_REQUEST, Json(response))
        }
    }
}

/// Request to save guided form content.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SaveGuidedFormRequest {
    pub base_raw_yaml: String,
    pub form: crate::config::form::GuidedConfigForm,
}

/// POST /api/v1/config/form/save
///
/// Saves guided form content by merging with base YAML and saving to config file.
#[utoipa::path(
    post,
    path = "/api/v1/config/form/save",
    operation_id = "saveGuidedForm",
    request_body = SaveGuidedFormRequest,
    responses(
        (status = 200, description = "Save result", body = ConfigStateResponse),
        (status = 400, description = "Merge or save failed"),
        (status = 409, description = "Saved config requires a process restart", body = ConfigStateResponse),
        (status = 500, description = "Config saved but orchestrator restart failed", body = ConfigStateResponse)
    ),
    tag = "config"
)]
pub async fn save_guided_form(
    State(state): State<AppState>,
    Json(request): Json<SaveGuidedFormRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let _reload = state.config_runtime.reload_coordinator.lock().await;
    let doc_state = state.config_runtime.document_state.read().await;

    // First, merge the guided form with the base YAML
    let merged_yaml =
        match apply_guided_form_to_current(&doc_state, &request.base_raw_yaml, &request.form) {
            Ok(yaml) => yaml,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    current_error_json(&doc_state, "form", format!("Form merge failed: {}", e)),
                )
            }
        };

    // Now save the merged YAML using the same path as save_yaml
    drop(doc_state);
    save_config_yaml_and_finish_transaction(&state, &merged_yaml).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::bootstrap::take_registered_orchestrator;
    use crate::api::test_helpers::app_state_with_missing_config;
    use crate::config::draft::{ConfigStateKind, DraftValidationReport};
    use crate::config::secrets::{SecretEdit, REDACTED_SECRET};
    use axum::body::Body;
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                std::env::remove_var(key);
            }

            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    struct AcpxBinGuard {
        _guard: EnvGuard,
    }

    impl AcpxBinGuard {
        fn with_fake_acpx(script_body: &str) -> (Self, tempfile::TempDir) {
            let guard = EnvGuard::lock(&["HOME", "ENSEMBLE_TEST_ACPX_BIN"]);
            let temp_dir = tempfile::tempdir().unwrap();
            let script_path = temp_dir.path().join("acpx");
            let mut script = std::fs::File::create(&script_path).unwrap();
            writeln!(script, "#!/bin/sh").unwrap();
            write!(script, "{script_body}").unwrap();

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                std::fs::set_permissions(&script_path, perms).unwrap();
            }

            std::env::set_var("ENSEMBLE_TEST_ACPX_BIN", &script_path);

            (Self { _guard: guard }, temp_dir)
        }
    }

    fn test_app_state() -> (AppState, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.yaml");
        let workspace_root = crate::config::ensemble::default_workspace_root();
        let mut app_state = app_state_with_missing_config(config_path, &workspace_root);
        app_state.history_path = temp_dir.path().join("history.jsonl");
        (app_state, temp_dir)
    }

    #[tokio::test]
    async fn test_validate_yaml_detects_syntax_errors() {
        let (state, _temp_dir) = test_app_state();
        let request = ValidateYamlRequest {
            raw_yaml: "tracker:\n  kind: todo_file\nagents: [".to_string(),
        };

        let (status, Json(response)) =
            validate_yaml(axum::extract::State(state), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "syntax_error");
        assert!(!response.issues.is_empty());
    }

    #[tokio::test]
    async fn test_validate_yaml_accepts_valid_config() {
        let (state, _temp_dir) = test_app_state();
        let request = ValidateYamlRequest {
            raw_yaml: r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    runtime: direct
    executor: claude-code
    model: sonnet
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#
            .to_string(),
        };

        let (status, Json(response)) =
            validate_yaml(axum::extract::State(state), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");
        assert!(response.guided_form.is_some());
    }

    #[test]
    fn test_config_state_response_redacts_guided_form_literal_api_key() {
        let config_path = PathBuf::from("/tmp/config.yaml");
        let state = parse_raw_yaml(
            config_path,
            r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 9
  api_key: ghp_secret123
  active_states:
    - Todo
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#
            .to_string(),
        );

        let response = ConfigStateResponse::from_state(&state);
        let serialized = serde_json::to_string(&response).unwrap();

        let guided_form = response.guided_form.unwrap();
        assert_eq!(guided_form.tracker.repository.as_deref(), Some("acme/repo"));
        assert_eq!(guided_form.tracker.project_number, Some(9));
        assert_eq!(guided_form.tracker.api_key, SecretDisplay::Redacted);
        assert!(response.raw_yaml.unwrap().contains("[REDACTED]"));
        assert!(!serialized.contains("active_config"));
        assert!(!serialized.contains("ghp_secret123"));
    }

    #[test]
    fn test_config_state_response_prefers_active_config_capabilities_over_yaml() {
        // The YAML has no `available_models`/`available_modes`, but the
        // in-memory active_config has been mutated by capability discovery.
        // The guided form response should surface the discovered capabilities
        // so the UI can show them before the user writes them back to YAML.
        let config_path = PathBuf::from("/tmp/config.yaml");
        let mut state = parse_raw_yaml(
            config_path,
            r#"
tracker:
  kind: todo_file
  active_states:
    - Todo
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: codex
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#
            .to_string(),
        );
        assert!(
            state.active_config.is_some(),
            "parse_raw_yaml should populate active_config"
        );

        // Simulate discovery mutating the in-memory config.
        {
            let active = state.active_config.as_mut().unwrap();
            let agent = active.agents.get_mut("builder").unwrap();
            agent.available_models = vec![crate::config::ensemble::ModelDefinition {
                id: "gpt-5".to_string(),
                name: "GPT-5".to_string(),
                description: Some("flagship".to_string()),
            }];
            agent.available_modes = vec![crate::config::ensemble::ModeDefinition {
                id: "code".to_string(),
                name: "Code".to_string(),
                description: None,
            }];
        }

        let response = ConfigStateResponse::from_state(&state);
        let guided_form = response.guided_form.expect("guided form should be built");
        let builder = guided_form
            .agents
            .iter()
            .find(|a| a.name == "builder")
            .expect("builder agent present");

        let models = builder
            .available_models
            .as_ref()
            .expect("discovered models should surface in guided form");
        assert_eq!(models[0].id, "gpt-5");
        let modes = builder
            .available_modes
            .as_ref()
            .expect("discovered modes should surface in guided form");
        assert_eq!(modes[0].id, "code");
    }

    #[tokio::test]
    async fn save_yaml_preserves_authoritative_secret_during_unrelated_edit() {
        let (state, _temp_dir) = test_app_state();
        let current_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: ghp_original
  active_states: [Todo]
  terminal_states: [Done]
agents:
  builder:
    acpx_agent: claude
    prompt: Build it.
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        std::fs::write(&state.config_runtime.config_path, current_yaml).unwrap();
        *state.config_runtime.document_state.write().await = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            current_yaml.to_string(),
        );

        let submitted_yaml = redact_yaml_secrets(current_yaml)
            .unwrap()
            .replace("on_failure: Failed", "on_failure: Needs Attention");
        let (status, Json(response)) = save_yaml(
            axum::extract::State(state.clone()),
            Json(SaveYamlRequest {
                raw_yaml: submitted_yaml,
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let saved = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
        assert!(saved.contains("ghp_original"));
        assert!(!saved.contains(REDACTED_SECRET));
        assert!(saved.contains("on_failure: Needs Attention"));
        let response_json = serde_json::to_string(&response).unwrap();
        assert!(!response_json.contains("ghp_original"));

        if let Some(runtime) = take_registered_orchestrator(&state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn save_guided_form_preserves_authoritative_secret_by_default() {
        let (state, _temp_dir) = test_app_state();
        let current_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: ghp_original
  active_states: [Todo]
  terminal_states: [Done]
agents:
  builder:
    acpx_agent: claude
    prompt: Build it.
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        std::fs::write(&state.config_runtime.config_path, current_yaml).unwrap();
        let current = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            current_yaml.to_string(),
        );
        let response = ConfigStateResponse::from_state(&current);
        *state.config_runtime.document_state.write().await = current;
        let mut form = response.guided_form.unwrap();
        form.transitions.on_failure = "Needs Attention".to_string();

        let (status, Json(_response)) = save_guided_form(
            axum::extract::State(state.clone()),
            Json(SaveGuidedFormRequest {
                base_raw_yaml: response.raw_yaml.unwrap(),
                form,
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let saved = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
        assert!(saved.contains("ghp_original"));
        assert!(!saved.contains(REDACTED_SECRET));
        assert!(saved.contains("Needs Attention"));

        if let Some(runtime) = take_registered_orchestrator(&state) {
            runtime.shutdown().await;
        }
    }

    #[test]
    fn discovered_agent_info_includes_typed_capabilities() {
        let info = discovered_agent_info_from_parts(
            "claude".to_string(),
            "Claude".to_string(),
            "1.0.0".to_string(),
            crate::config::setup::AgentCapabilities {
                available_models: vec![],
                typed_models: vec![crate::config::ensemble::ModelDefinition {
                    id: "sonnet".to_string(),
                    name: "Claude Sonnet".to_string(),
                    description: Some("Balanced".to_string()),
                }],
                available_modes: vec![crate::config::ensemble::ModeDefinition {
                    id: "plan".to_string(),
                    name: "Plan".to_string(),
                    description: Some("Plan first".to_string()),
                }],
            },
        );

        assert_eq!(info.available_models[0].id, "sonnet");
        assert_eq!(info.available_models[0].name, "Claude Sonnet");
        assert_eq!(info.available_modes[0].id, "plan");
    }

    #[tokio::test]
    async fn test_validate_setup_allows_save_when_only_environment_checks_fail() {
        let (state, _temp_dir) = test_app_state();
        let request = ValidateSetupRequest {
            setup: crate::config::setup::SetupRequest {
                tracker: crate::config::setup::SetupTracker::TodoFile {
                    path: PathBuf::from("TODO.md"),
                },
                repos: vec![crate::config::setup::SetupRepo {
                    path: PathBuf::from("/nonexistent/repo"),
                    branch: "main".to_string(),
                }],
                agents: vec![crate::config::setup::SetupAgent {
                    role: "builder".to_string(),
                    acpx_agent: "claude".to_string(),
                    model: None,
                    reasoning_level: None,
                    permission_mode: None,
                    prompt: None,
                    prompt_file: None,
                }],
                steps: vec![crate::config::setup::SetupStep {
                    name: "build".to_string(),
                    agent_role: "builder".to_string(),
                    kind: None,
                    depends: vec![],
                    tracker_state: None,
                }],
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (status, Json(response)) =
            validate_setup(axum::extract::State(state), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(response.checks.iter().any(|check| !check.passed));
        assert!(response.can_save);
    }

    #[tokio::test]
    async fn test_get_setup_defaults_extracts_from_parseable_raw_yaml_without_active_config() {
        let (state, _temp_dir) = test_app_state();
        *state.config_runtime.document_state.write().await = ConfigDocumentState {
            path: state.config_runtime.config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: Some(
                r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 9
  api_key: $GITHUB_TOKEN
  active_states:
    - Todo
    - Doing
  terminal_states:
    - Done
repos:
  - path: /tmp/repo
    branch: develop
agents:
  builder:
    acpx_agent: claude
    model: sonnet
steps:
  - name: build
    agent: builder
    tracker_state: Doing
on_success: Done
on_failure: Failed
"#
                .to_string(),
            ),
            document: None,
            active_config: None,
            validation: DraftValidationReport::default(),
        };

        let (status, Json(response)) = get_setup_defaults(axum::extract::State(state)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(response.has_existing_config);
        assert_eq!(response.defaults["tracker"]["kind"], "github");
        assert_eq!(response.defaults["tracker"]["repository"], "acme/repo");
        assert_eq!(response.defaults["repos"][0]["branch"], "develop");
        assert_eq!(response.defaults["agents"][0]["role"], "builder");
        assert_eq!(response.defaults["steps"][0]["name"], "build");
    }

    #[tokio::test]
    async fn test_get_setup_defaults_falls_back_to_full_active_config_shape() {
        let (state, _temp_dir) = test_app_state();
        *state.config_runtime.document_state.write().await = ConfigDocumentState {
            path: state.config_runtime.config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(
                crate::config::ensemble::parse_config(
                    r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 17
  api_key: $GITHUB_TOKEN
  active_states:
    - Todo
    - Doing
  terminal_states:
    - Done
repos:
  - path: /tmp/repo
    branch: develop
agents:
  builder:
    executor: codex
    model: sonnet
    prompt_template: templates/build.liquid
steps:
  - name: build
    agent: builder
    tracker_state: Doing
on_success: Done
on_failure: Failed
"#,
                )
                .unwrap(),
            ),
            validation: DraftValidationReport::default(),
        };

        let (status, Json(response)) = get_setup_defaults(axum::extract::State(state)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(response.has_existing_config);
        assert_eq!(response.defaults["tracker"]["kind"], "github");
        assert_eq!(response.defaults["tracker"]["repository"], "acme/repo");
        assert_eq!(response.defaults["repos"][0]["branch"], "develop");
        assert_eq!(response.defaults["agents"][0]["role"], "builder");
        assert_eq!(response.defaults["agents"][0]["acpx_agent"], "codex");
        assert_eq!(response.defaults["steps"][0]["name"], "build");
    }

    #[tokio::test]
    async fn test_get_setup_defaults_includes_step_approval_in_response() {
        let (state, _temp_dir) = test_app_state();
        *state.config_runtime.document_state.write().await = ConfigDocumentState {
            path: state.config_runtime.config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(
                crate::config::ensemble::parse_config(
                    r#"
tracker:
  kind: todo_file
  path: TODO.md
  active_states:
    - Todo
  terminal_states:
    - Done
agents:
  planner:
    acpx_agent: claude
    prompt: Plan.
steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
on_success: Done
on_failure: Failed
"#,
                )
                .unwrap(),
            ),
            validation: DraftValidationReport::default(),
        };

        let (status, Json(response)) = get_setup_defaults(axum::extract::State(state)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            response.defaults["steps"][0]["approval"],
            serde_json::json!({
                "mode": "when_requested_by_agent",
                "state": "Plan Review"
            })
        );
    }

    #[tokio::test]
    async fn test_get_setup_defaults_without_existing_config_keeps_flag_only_at_top_level() {
        let (state, _temp_dir) = test_app_state();

        let (status, Json(response)) = get_setup_defaults(axum::extract::State(state)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(!response.has_existing_config);
        assert_eq!(response.defaults["tracker"]["kind"], "todo_file");
        assert!(response.defaults.get("has_existing_config").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_setup_agents_stream_emits_discovered_agent_version() {
        let script = r#"
if [ "$1" = "--agent" ] && [ "$2" = "claude" ] && [ "$3" = "--version" ]; then
  printf 'claude 9.9.9\n'
  exit 0
fi

exit 1
"#;
        let (_path_guard, temp_dir) = AcpxBinGuard::with_fake_acpx(script);
        std::env::set_var("HOME", temp_dir.path());

        let response = get_setup_agents_stream().await.into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "text/event-stream"
        );

        let body = response.into_body();
        let mut stream = Body::into_data_stream(body);
        let mut event_text = String::new();
        while let Some(chunk) = stream.next().await {
            event_text.push_str(&String::from_utf8(chunk.unwrap().to_vec()).unwrap());
            if event_text.contains("claude 9.9.9") {
                break;
            }
        }

        assert!(event_text.contains("claude"));
        assert!(event_text.contains("claude 9.9.9"));
    }

    #[tokio::test]
    async fn test_save_setup_does_not_hold_document_lock_while_validating() {
        let (state, _temp_dir) = test_app_state();
        let request = SaveSetupRequest {
            setup: crate::config::setup::SetupRequest {
                tracker: crate::config::setup::SetupTracker::TodoFile {
                    path: PathBuf::from("TODO.md"),
                },
                repos: vec![],
                agents: vec![],
                steps: vec![],
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };
        let validation_started = Arc::new(tokio::sync::Notify::new());
        let release_validation = Arc::new(tokio::sync::Notify::new());

        let save_task = {
            let state = state.clone();
            let validation_started = validation_started.clone();
            let release_validation = release_validation.clone();
            tokio::spawn(async move {
                save_setup_with_checks(state, request, move |_| {
                    let validation_started = validation_started.clone();
                    let release_validation = release_validation.clone();
                    async move {
                        validation_started.notify_one();
                        release_validation.notified().await;
                        vec![crate::config::setup::SetupCheck {
                            kind: crate::config::setup::SetupCheckKind::Config,
                            label: "stub".to_string(),
                            passed: false,
                            detail: "blocked".to_string(),
                        }]
                    }
                })
                .await
            })
        };

        validation_started.notified().await;

        let lock_attempt = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            state.config_runtime.document_state.read(),
        )
        .await;

        release_validation.notify_one();
        let _ = save_task.await.unwrap();

        assert!(
            lock_attempt.is_ok(),
            "document_state lock should remain available during setup validation"
        );
    }

    #[tokio::test]
    async fn test_save_setup_uses_merge_and_writes_full_artifact_set() {
        let (state, temp_dir) = test_app_state();
        let existing_yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
  custom_tracker_flag: keep-me
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/build.liquid
    unsupported_agent_field: keep-agent
steps:
  - name: build
    agent: builder
    custom_step_field: keep-step
on_success: Done
on_failure: Failed
custom_root:
  keep: true
"#;
        std::fs::write(&state.config_runtime.config_path, existing_yaml).unwrap();
        *state.config_runtime.document_state.write().await = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            existing_yaml.to_string(),
        );

        let todo_path = temp_dir.path().join("nested/TODO.md");
        let request = SaveSetupRequest {
            setup: crate::config::setup::SetupRequest {
                tracker: crate::config::setup::SetupTracker::TodoFile {
                    path: todo_path.clone(),
                },
                repos: vec![],
                agents: vec![crate::config::setup::SetupAgent {
                    role: "builder".to_string(),
                    acpx_agent: "codex".to_string(),
                    model: Some("sonnet".to_string()),
                    reasoning_level: None,
                    permission_mode: None,
                    prompt: None,
                    prompt_file: None,
                }],
                steps: vec![crate::config::setup::SetupStep {
                    name: "build".to_string(),
                    agent_role: "builder".to_string(),
                    kind: None,
                    depends: vec![],
                    tracker_state: Some("In Progress".to_string()),
                }],
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (status, Json(response)) =
            save_setup(axum::extract::State(state.clone()), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");
        assert!(state.config_runtime.config_path.exists());
        assert!(temp_dir.path().join("templates/build.liquid").exists());
        assert!(todo_path.exists());

        let saved_yaml = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
        assert!(saved_yaml.contains("custom_root:"));
        assert!(saved_yaml.contains("custom_tracker_flag: keep-me"));
        assert!(saved_yaml.contains("unsupported_agent_field: keep-agent"));
        assert!(saved_yaml.contains("custom_step_field: keep-step"));
        assert!(saved_yaml.contains("acpx_agent: codex"));
    }

    #[tokio::test]
    async fn test_save_setup_blocks_when_config_is_invalid() {
        let (state, _temp_dir) = test_app_state();
        let request = SaveSetupRequest {
            setup: crate::config::setup::SetupRequest {
                tracker: crate::config::setup::SetupTracker::TodoFile {
                    path: PathBuf::from("TODO.md"),
                },
                repos: vec![],
                agents: vec![],
                steps: vec![],
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (status, Json(response)) = save_setup(axum::extract::State(state), Json(request)).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(response.issues.iter().any(|issue| issue.section == "setup"));
    }

    #[tokio::test]
    async fn save_guided_form_writes_permission_request_policy_to_saved_yaml() {
        let (state, _temp_dir) = test_app_state();
        let base_yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
agent:
  permission_policy: auto
on_success: Done
on_failure: Failed
"#;
        std::fs::write(&state.config_runtime.config_path, base_yaml).unwrap();
        *state.config_runtime.document_state.write().await = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            base_yaml.to_string(),
        );

        let form = crate::config::form::GuidedConfigForm {
            tracker: crate::config::form::GuidedTrackerForm {
                kind: "todo_file".to_string(),
                path: Some("TODO.md".to_string()),
                repository: None,
                project_number: None,
                api_key: SecretDisplay::Unset,
                api_key_edit: SecretEdit::Preserve,
                endpoint: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
            repos: vec![],
            agents: vec![crate::config::form::GuidedAgentForm {
                name: "builder".to_string(),
                runtime: Some("direct".to_string()),
                executor: Some("claude-code".to_string()),
                model: Some("sonnet".to_string()),
                acpx_agent: None,
                permission_mode: None,
                prompt: Some("Build it.".to_string()),
                prompt_template: None,
                reasoning_level: None,
                available_models: None,
                available_modes: None,
            }],
            steps: vec![crate::config::form::GuidedStepForm {
                name: "build".to_string(),
                kind: None,
                agent: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            runtime: crate::config::form::GuidedRuntimeForm {
                max_cycles: 3,
                concurrency: crate::config::form::GuidedConcurrencyForm {
                    max_concurrent_agents: 4,
                    max_step_parallelism: 2,
                },
                polling: crate::config::form::GuidedPollingForm { interval_ms: 30000 },
                workspace: crate::config::form::GuidedWorkspaceForm { root: None },
                hooks: crate::config::form::GuidedHooksForm {
                    after_create: None,
                    before_run: None,
                    after_run: None,
                    before_remove: None,
                    timeout_ms: 60000,
                },
                agent: crate::config::form::GuidedAgentRuntimeForm {
                    max_turns: 20,
                    max_retry_backoff_ms: 300000,
                    command: "claude-code".to_string(),
                    session_mode: "code".to_string(),
                    permission_request_policy:
                        crate::config::form::GuidedPermissionRequestPolicyForm {
                            mode: "select_option".to_string(),
                            option_id: Some("manual".to_string()),
                        },
                    turn_timeout_ms: 3600000,
                    read_timeout_ms: 5000,
                    stall_timeout_ms: 300000,
                },
            },
            transitions: crate::config::form::GuidedTransitionForm {
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (status, Json(response)) = save_guided_form(
            axum::extract::State(state.clone()),
            Json(SaveGuidedFormRequest {
                base_raw_yaml: base_yaml.to_string(),
                form,
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");

        let saved_yaml = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
        assert!(saved_yaml.contains("permission_request_policy:"));
        assert!(saved_yaml.contains("mode: select_option"));
        assert!(saved_yaml.contains("option_id: manual"));
        assert!(!saved_yaml.contains("permission_policy:"));
    }

    #[test]
    fn test_config_error_json_adds_save_issue_to_current_state_shape() {
        let config_path = PathBuf::from("/tmp/config.yaml");
        let current = parse_raw_yaml(
            config_path.clone(),
            "tracker:\n  kind: todo_file\nagents: [".to_string(),
        );
        let error = ConfigError::ConfigWriteFailed {
            reason: "disk full".to_string(),
        };

        let Json(response) = config_error_json(&current, &error);

        assert_eq!(response.state, "syntax_error");
        assert_eq!(response.config_path, config_path.display().to_string());
        assert!(!response.issues.is_empty());
        assert_eq!(response.issues.last().unwrap().section, "save");
        assert!(response
            .issues
            .last()
            .unwrap()
            .message
            .contains("Save failed: config write failed: disk full"));
    }

    #[tokio::test]
    async fn save_guided_form_preserves_form_section_for_merge_failures() {
        let (state, _temp_dir) = test_app_state();
        let current_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 9
  api_key: ghp_secret123
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let invalid_base_yaml = "tracker: [";
        *state.config_runtime.document_state.write().await = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            current_yaml.to_string(),
        );

        let form = crate::config::form::GuidedConfigForm {
            tracker: crate::config::form::GuidedTrackerForm {
                kind: "github".to_string(),
                path: None,
                repository: Some("acme/repo".to_string()),
                project_number: Some(9),
                api_key: SecretDisplay::Redacted,
                api_key_edit: SecretEdit::SetLiteral {
                    value: "ghp_secret123".to_string(),
                },
                endpoint: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
            repos: vec![],
            agents: vec![crate::config::form::GuidedAgentForm {
                name: "builder".to_string(),
                runtime: None,
                executor: None,
                model: None,
                acpx_agent: None,
                permission_mode: Some("approve_reads".to_string()),
                prompt: Some("Build it.".to_string()),
                prompt_template: None,
                reasoning_level: None,
                available_models: None,
                available_modes: None,
            }],
            steps: vec![crate::config::form::GuidedStepForm {
                name: "build".to_string(),
                kind: None,
                agent: "missing".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            runtime: crate::config::form::GuidedRuntimeForm {
                max_cycles: 3,
                concurrency: crate::config::form::GuidedConcurrencyForm {
                    max_concurrent_agents: 4,
                    max_step_parallelism: 2,
                },
                polling: crate::config::form::GuidedPollingForm { interval_ms: 30000 },
                workspace: crate::config::form::GuidedWorkspaceForm { root: None },
                hooks: crate::config::form::GuidedHooksForm {
                    after_create: None,
                    before_run: None,
                    after_run: None,
                    before_remove: None,
                    timeout_ms: 60000,
                },
                agent: crate::config::form::GuidedAgentRuntimeForm {
                    max_turns: 20,
                    max_retry_backoff_ms: 300000,
                    command: "claude-code".to_string(),
                    session_mode: "code".to_string(),
                    permission_request_policy:
                        crate::config::form::GuidedPermissionRequestPolicyForm {
                            mode: "approve_all".to_string(),
                            option_id: None,
                        },
                    turn_timeout_ms: 3600000,
                    read_timeout_ms: 5000,
                    stall_timeout_ms: 300000,
                },
            },
            transitions: crate::config::form::GuidedTransitionForm {
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (form_status, Json(form_response)) = save_guided_form(
            axum::extract::State(state),
            Json(SaveGuidedFormRequest {
                base_raw_yaml: invalid_base_yaml.to_string(),
                form,
            }),
        )
        .await;

        assert_eq!(form_status, StatusCode::BAD_REQUEST);
        assert_eq!(form_response.state, "parsed");
        assert!(!form_response.issues.is_empty());
        assert!(form_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("[REDACTED]"));
        assert!(!form_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("ghp_secret123"));
        let issue = form_response.issues.last().unwrap();
        assert_eq!(issue.section, "form");
        assert_eq!(
            issue.kind,
            crate::config::draft::ValidationIssueKind::Config
        );
        assert!(issue.message.contains("Form merge failed"));
    }

    #[tokio::test]
    async fn save_yaml_and_save_guided_form_return_same_error_issue_shape() {
        let (state, _temp_dir) = test_app_state();
        let current_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 9
  api_key: ghp_secret123
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let invalid_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 9
  api_key: ghp_secret123
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: missing
on_success: Done
on_failure: Failed
"#
        .to_string();
        *state.config_runtime.document_state.write().await = parse_raw_yaml(
            state.config_runtime.config_path.clone(),
            current_yaml.to_string(),
        );

        let (yaml_status, Json(yaml_response)) = save_yaml(
            axum::extract::State(state.clone()),
            Json(SaveYamlRequest {
                raw_yaml: invalid_yaml.clone(),
            }),
        )
        .await;

        let form = crate::config::form::GuidedConfigForm {
            tracker: crate::config::form::GuidedTrackerForm {
                kind: "github".to_string(),
                path: None,
                repository: Some("acme/repo".to_string()),
                project_number: Some(9),
                api_key: SecretDisplay::Redacted,
                api_key_edit: SecretEdit::SetLiteral {
                    value: "ghp_secret123".to_string(),
                },
                endpoint: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
            repos: vec![],
            agents: vec![crate::config::form::GuidedAgentForm {
                name: "builder".to_string(),
                runtime: None,
                executor: None,
                model: None,
                acpx_agent: Some("claude".to_string()),
                permission_mode: Some("approve_reads".to_string()),
                prompt: Some("Build it.".to_string()),
                prompt_template: None,
                reasoning_level: None,
                available_models: None,
                available_modes: None,
            }],
            steps: vec![crate::config::form::GuidedStepForm {
                name: "build".to_string(),
                kind: None,
                agent: "missing".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            runtime: crate::config::form::GuidedRuntimeForm {
                max_cycles: 3,
                concurrency: crate::config::form::GuidedConcurrencyForm {
                    max_concurrent_agents: 4,
                    max_step_parallelism: 2,
                },
                polling: crate::config::form::GuidedPollingForm { interval_ms: 30000 },
                workspace: crate::config::form::GuidedWorkspaceForm { root: None },
                hooks: crate::config::form::GuidedHooksForm {
                    after_create: None,
                    before_run: None,
                    after_run: None,
                    before_remove: None,
                    timeout_ms: 60000,
                },
                agent: crate::config::form::GuidedAgentRuntimeForm {
                    max_turns: 20,
                    max_retry_backoff_ms: 300000,
                    command: "claude-code".to_string(),
                    session_mode: "code".to_string(),
                    permission_request_policy:
                        crate::config::form::GuidedPermissionRequestPolicyForm {
                            mode: "approve_all".to_string(),
                            option_id: None,
                        },
                    turn_timeout_ms: 3600000,
                    read_timeout_ms: 5000,
                    stall_timeout_ms: 300000,
                },
            },
            transitions: crate::config::form::GuidedTransitionForm {
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (form_status, Json(form_response)) = save_guided_form(
            axum::extract::State(state),
            Json(SaveGuidedFormRequest {
                base_raw_yaml: current_yaml.to_string(),
                form,
            }),
        )
        .await;

        assert_eq!(yaml_status, StatusCode::BAD_REQUEST);
        assert_eq!(form_status, StatusCode::BAD_REQUEST);
        assert_eq!(yaml_response.state, "parsed");
        assert_eq!(form_response.state, "parsed");
        assert!(!yaml_response.issues.is_empty());
        assert!(!form_response.issues.is_empty());

        let yaml_issue = yaml_response.issues.last().unwrap();
        let form_issue = form_response.issues.last().unwrap();
        assert_eq!(yaml_issue.section, "save");
        assert_eq!(form_issue.section, "save");
        assert_eq!(yaml_issue.kind, form_issue.kind);
        assert_eq!(yaml_issue.message, form_issue.message);

        assert!(yaml_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("[REDACTED]"));
        assert!(form_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("[REDACTED]"));
        assert!(!yaml_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("ghp_secret123"));
        assert!(!form_response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("ghp_secret123"));
        assert_eq!(yaml_response.config_path, form_response.config_path);
    }

    #[tokio::test]
    async fn save_setup_reloads_document_state_after_writing_artifacts() {
        let (state, temp_dir) = test_app_state();
        let request = SaveSetupRequest {
            setup: crate::config::setup::SetupRequest {
                tracker: crate::config::setup::SetupTracker::GitHub {
                    repository: "acme/repo".to_string(),
                    project_number: Some(9),
                    api_key: SecretDisplay::Environment {
                        variable: "GITHUB_TOKEN".to_string(),
                    },
                    api_key_edit: SecretEdit::SetEnvironment {
                        variable: "GITHUB_TOKEN".to_string(),
                    },
                    api_token: Some(crate::config::secrets::SecretValue::new("ghp_secret123")),
                    active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                    terminal_states: vec!["Done".to_string()],
                },
                repos: vec![],
                agents: vec![crate::config::setup::SetupAgent {
                    role: "builder".to_string(),
                    acpx_agent: "claude".to_string(),
                    model: Some("sonnet".to_string()),
                    reasoning_level: None,
                    permission_mode: None,
                    prompt: None,
                    prompt_file: None,
                }],
                steps: vec![crate::config::setup::SetupStep {
                    name: "build".to_string(),
                    agent_role: "builder".to_string(),
                    kind: None,
                    depends: vec![],
                    tracker_state: Some("In Progress".to_string()),
                }],
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        };

        let (status, Json(response)) =
            save_setup(axum::extract::State(state.clone()), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");
        assert!(temp_dir.path().join(".env").exists());
        assert!(response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("$GITHUB_TOKEN"));
        assert!(!response
            .raw_yaml
            .as_ref()
            .unwrap()
            .contains("ghp_secret123"));
        let persisted_state = state.config_runtime.document_state.read().await;
        let tracker = &persisted_state.active_config.as_ref().unwrap().tracker;
        assert_eq!(tracker.repository.as_deref(), Some("acme/repo"));
        assert_eq!(tracker.project_number, Some(9));
        assert_eq!(tracker.api_key.as_deref(), Some("ghp_secret123"));

        let disk_yaml = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
        assert_eq!(
            persisted_state.raw_yaml.as_deref(),
            Some(disk_yaml.as_str())
        );
        assert_eq!(
            response.raw_yaml.as_deref().map(str::trim_end),
            persisted_state.raw_yaml.as_deref().map(str::trim_end)
        );
        assert_eq!(
            persisted_state
                .active_config
                .as_ref()
                .and_then(|config| config.tracker.api_key.clone()),
            Some("ghp_secret123".to_string())
        );
    }

    #[tokio::test]
    async fn save_yaml_records_file_mtime_for_watcher_self_write_suppression() {
        let (state, temp_dir) = test_app_state();
        let todo_path = temp_dir.path().join("TODO.md");
        std::fs::write(&todo_path, "## Todo\n").unwrap();

        let request = SaveYamlRequest {
            raw_yaml: format!(
                "tracker:\n  kind: todo_file\n  path: {}\npolling:\n  interval_ms: 1234\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
                todo_path.display()
            ),
        };

        let (status, _) = save_yaml(axum::extract::State(state.clone()), Json(request)).await;
        assert_eq!(status, StatusCode::OK);

        let last_mtime =
            state.config_runtime.last_loaded_mtime.read().await.expect(
                "save_yaml should record the file mtime so the watcher skips its own reload",
            );
        let actual_mtime = std::fs::metadata(&state.config_runtime.config_path)
            .and_then(|m| m.modified())
            .expect("config file should exist after save");
        assert_eq!(last_mtime, actual_mtime);

        if let Some(runtime) = take_registered_orchestrator(&state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn save_yaml_starts_orchestrator_after_valid_config_is_written() {
        let (state, temp_dir) = test_app_state();
        let todo_path = temp_dir.path().join("TODO.md");
        std::fs::write(&todo_path, "## Todo\n").unwrap();
        let request = SaveYamlRequest {
            raw_yaml: format!(
                "tracker:\n  kind: todo_file\n  path: {}\npolling:\n  interval_ms: 1234\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
                todo_path.display()
            ),
        };

        let (status, Json(response)) =
            save_yaml(axum::extract::State(state.clone()), Json(request)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(response.guided_form.is_some());

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if state.orchestrator_state.read().await.last_tick_at.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("orchestrator should start after saving a valid config");
    }

    #[tokio::test]
    async fn config_save_reload_transaction_restart_required_is_redacted_and_retryable() {
        let (state, temp_dir) = test_app_state();
        let todo_path = temp_dir.path().join("TODO.md");
        std::fs::write(&todo_path, "## Todo\n").unwrap();
        let config_yaml = |interval_ms: u64, workspace_root: Option<&str>| {
            let workspace = workspace_root
                .map(|root| format!("workspace:\n  root: {root}\n"))
                .unwrap_or_default();
            format!(
                "tracker:\n  kind: todo_file\n  path: {}\npolling:\n  interval_ms: {interval_ms}\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n{workspace}",
                todo_path.display()
            )
        };
        let (status, _) = save_yaml(
            axum::extract::State(state.clone()),
            Json(SaveYamlRequest {
                raw_yaml: config_yaml(1000, None),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let committed_mtime = *state.config_runtime.last_loaded_mtime.read().await;

        let restart_root = "/tmp/private-restart-root";
        let (status, Json(response)) = save_yaml(
            axum::extract::State(state.clone()),
            Json(SaveYamlRequest {
                raw_yaml: config_yaml(2000, Some(restart_root)),
            }),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            1000
        );
        assert_eq!(
            *state.config_runtime.last_loaded_mtime.read().await,
            committed_mtime,
            "restart-required save must leave the candidate mtime unconsumed"
        );
        assert!(
            !serde_json::to_string(&response)
                .unwrap()
                .contains(restart_root),
            "restart diagnostics must not echo candidate values"
        );

        if let Some(runtime) = take_registered_orchestrator(&state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn save_yaml_restarts_orchestrator_with_updated_poll_interval() {
        let (state, temp_dir) = test_app_state();
        let todo_path = temp_dir.path().join("TODO.md");
        std::fs::write(&todo_path, "## Todo\n").unwrap();

        for interval_ms in [1234_u64, 4321_u64] {
            let request = SaveYamlRequest {
                raw_yaml: format!(
                    "tracker:\n  kind: todo_file\n  path: {}\npolling:\n  interval_ms: {interval_ms}\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n",
                    todo_path.display()
                ),
            };

            let (status, Json(response)) =
                save_yaml(axum::extract::State(state.clone()), Json(request)).await;

            assert_eq!(status, StatusCode::OK);
            assert!(response.guided_form.is_some());

            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let poll_interval_ms = state.orchestrator_state.read().await.poll_interval_ms;
                    if poll_interval_ms == interval_ms {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("orchestrator should adopt the saved poll interval");
        }
    }
}
