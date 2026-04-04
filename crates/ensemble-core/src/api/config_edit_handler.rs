use crate::api::router::AppState;
use crate::config::draft::{
    parse_raw_yaml, save_raw_yaml_atomically, ConfigDocumentState, ConfigStateKind, ValidationIssue,
};
use crate::config::ensemble::EnsembleConfig;
use crate::error::ConfigError;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::Path;
use tracing::warn;

/// Redact literal secret values from YAML text.
/// Preserves `$ENV_VAR` references (they're not actual secrets in the file).
/// Patterns matched (case-insensitive, as YAML keys): api_key, token, password, secret.
fn redact_secrets(yaml: &str) -> String {
    let secret_keys = ["api_key", "token", "password", "secret"];
    yaml.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let indent = &line[..line.len() - trimmed.len()];
            format!("{indent}{}", redact_secret_in_line(trimmed, &secret_keys))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_secret_in_line(line: &str, keys: &[&str]) -> String {
    let mut redacted = line.to_string();

    for &key in keys {
        for delimiter in [":", "="] {
            let pattern = format!("{key}{delimiter}");
            let mut search_from = 0;

            while let Some(relative_start) = redacted[search_from..].to_lowercase().find(&pattern) {
                let start = search_from + relative_start;
                let prefix_start = redacted[..start]
                    .char_indices()
                    .last()
                    .filter(|(_, ch)| !matches!(ch, ' ' | '{' | ',' | '-'));

                if prefix_start.is_some() {
                    search_from = start + pattern.len();
                    continue;
                }

                let value_start = start + pattern.len();
                let value = &redacted[value_start..];
                let value_trimmed = value.trim_start();
                let leading_ws = value.len() - value_trimmed.len();
                let suffix_offset = value_trimmed
                    .find([',', '}'])
                    .unwrap_or(value_trimmed.len());
                let candidate_value = &value_trimmed[..suffix_offset].trim_end();
                if is_env_var_reference(candidate_value) {
                    search_from = value_start + leading_ws + 1;
                    continue;
                }

                let replace_start = value_start + leading_ws;
                let replace_end = replace_start + suffix_offset;
                redacted.replace_range(replace_start..replace_end, "\"[REDACTED]\"");
                search_from = replace_start + "\"[REDACTED]\"".len();
            }
        }
    }

    redacted
}

fn is_env_var_reference(value: &str) -> bool {
    value.starts_with('$')
        || value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .is_some_and(|value| value.starts_with('$'))
}

fn redact_guided_form_secrets(
    mut guided_form: crate::config::form::GuidedConfigForm,
) -> crate::config::form::GuidedConfigForm {
    if guided_form
        .tracker
        .api_key
        .as_deref()
        .is_some_and(|value| !value.starts_with('$'))
    {
        guided_form.tracker.api_key = Some("[REDACTED]".to_string());
    }

    guided_form
}

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
    pub active_config: Option<EnsembleConfig>,
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

        // Extract guided form if we have valid YAML
        let guided_form = state
            .raw_yaml
            .as_ref()
            .and_then(|yaml| crate::config::form::extract_guided_form(yaml).ok())
            .map(redact_guided_form_secrets);

        Self {
            state: state_str.to_string(),
            config_path: state.path.display().to_string(),
            raw_yaml: state.raw_yaml.as_ref().map(|y| redact_secrets(y)),
            issues: state.validation.issues.clone(),
            active_config: state.active_config.clone(),
            guided_form,
        }
    }
}

fn config_state_json(state: &ConfigDocumentState) -> Json<ConfigStateResponse> {
    Json(ConfigStateResponse::from_state(state))
}

/// Build an error response from a config error.
fn build_error_response(current: &ConfigDocumentState, error: &ConfigError) -> ConfigStateResponse {
    let mut response = ConfigStateResponse::from_state(current);
    response.issues.push(ValidationIssue {
        kind: crate::config::draft::ValidationIssueKind::Config,
        message: format!("Save failed: {}", error),
        section: "save".to_string(),
        field: None,
        path: None,
    });
    response
}

fn config_error_json(
    current: &ConfigDocumentState,
    error: &ConfigError,
) -> Json<ConfigStateResponse> {
    Json(build_error_response(current, error))
}

fn replace_document_state_from_yaml(
    doc_state: &mut ConfigDocumentState,
    config_path: &Path,
    raw_yaml: &str,
) -> Result<ConfigStateResponse, ConfigError> {
    let new_state = save_raw_yaml_atomically(config_path, raw_yaml)?;
    *doc_state = new_state.clone();
    Ok(ConfigStateResponse::from_state(&new_state))
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
    let draft = parse_raw_yaml(state.config_runtime.config_path.clone(), request.raw_yaml);
    (StatusCode::OK, config_state_json(&draft))
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
        (status = 400, description = "Invalid YAML or validation failed")
    ),
    tag = "config"
)]
pub async fn save_yaml(
    State(state): State<AppState>,
    Json(request): Json<SaveYamlRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let mut doc_state = state.config_runtime.document_state.write().await;

    match replace_document_state_from_yaml(
        &mut doc_state,
        &state.config_runtime.config_path,
        &request.raw_yaml,
    ) {
        Ok(response) => (StatusCode::OK, Json(response)),
        Err(e) => (StatusCode::BAD_REQUEST, config_error_json(&doc_state, &e)),
    }
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
            let agent_infos: Vec<DiscoveredAgentInfo> = agents
                .into_iter()
                .map(|a| DiscoveredAgentInfo {
                    name: a.name.clone(),
                    label: a.label,
                    version: a.version,
                })
                .collect();

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
pub async fn get_setup_agents_stream(
    State(_state): State<AppState>,
) -> impl axum::response::IntoResponse {
    use axum::response::sse::{Event, Sse};

    let stream = async_stream::stream! {
        let mut probe_tasks = tokio::task::JoinSet::new();

        // Spawn concurrent probe tasks for all known agents
        for (name, label) in crate::config::setup::KNOWN_AGENTS {
            let name = name.to_string();
            let label = label.to_string();
            probe_tasks.spawn(async move {
                if crate::config::setup::probe_agent(&name).await {
                    let version = crate::config::setup::get_agent_version(&name).await;
                    Some(DiscoveredAgentInfo {
                        name,
                        label,
                        version,
                    })
                } else {
                    None
                }
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
        (status = 400, description = "Setup validation failed")
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
        let mut response = ConfigStateResponse::from_state(&doc_state);
        response.issues.push(ValidationIssue {
            kind: crate::config::draft::ValidationIssueKind::Config,
            message: "Setup validation failed".to_string(),
            section: "setup".to_string(),
            field: None,
            path: None,
        });
        return (StatusCode::BAD_REQUEST, Json(response));
    }

    let mut doc_state = state.config_runtime.document_state.write().await;
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
            match crate::config::draft::load_config_state(&state.config_runtime.config_path) {
                Ok(new_state) => {
                    *doc_state = new_state.clone();
                    (StatusCode::OK, config_state_json(&new_state))
                }
                Err(e) => (StatusCode::BAD_REQUEST, config_error_json(&doc_state, &e)),
            }
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
            "api_key_env": config
                .tracker
                .api_key
                .as_deref()
                .and_then(|key| key.strip_prefix('$'))
                .unwrap_or("GITHUB_TOKEN"),
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
                "depends": step.depends.clone().unwrap_or_default(),
                "tracker_state": step.tracker_state,
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
    match crate::config::form::apply_guided_form(&request.base_raw_yaml, &request.form) {
        Ok(merged_yaml) => {
            // Parse and validate the merged YAML
            let draft = crate::config::draft::parse_raw_yaml(
                state.config_runtime.config_path.clone(),
                merged_yaml.clone(),
            );

            let valid = draft.kind == crate::config::draft::ConfigStateKind::Parsed
                && draft.validation.issues.is_empty();

            let response = ValidateGuidedFormResponse {
                merged_yaml,
                issues: draft.validation.issues,
                valid,
            };
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let response = ValidateGuidedFormResponse {
                merged_yaml: request.base_raw_yaml,
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
        (status = 400, description = "Merge or save failed")
    ),
    tag = "config"
)]
pub async fn save_guided_form(
    State(state): State<AppState>,
    Json(request): Json<SaveGuidedFormRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    let mut doc_state = state.config_runtime.document_state.write().await;

    // First, merge the guided form with the base YAML
    let merged_yaml =
        match crate::config::form::apply_guided_form(&request.base_raw_yaml, &request.form) {
            Ok(yaml) => yaml,
            Err(e) => {
                let mut response = ConfigStateResponse::from_state(&doc_state);
                response.issues.push(crate::config::draft::ValidationIssue {
                    kind: crate::config::draft::ValidationIssueKind::Config,
                    message: format!("Form merge failed: {}", e),
                    section: "form".to_string(),
                    field: None,
                    path: None,
                });
                return (StatusCode::BAD_REQUEST, Json(response));
            }
        };

    // Now save the merged YAML using the same path as save_yaml
    match replace_document_state_from_yaml(
        &mut doc_state,
        &state.config_runtime.config_path,
        &merged_yaml,
    ) {
        Ok(response) => (StatusCode::OK, Json(response)),
        Err(e) => (StatusCode::BAD_REQUEST, config_error_json(&doc_state, &e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::ConfigRuntime;
    use crate::config::draft::{ConfigStateKind, DraftValidationReport};
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::RwLock;

    fn test_app_state() -> (AppState, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let state = OrchestratorState::new(30000, 10);
        let config_path = temp_dir.path().join("config.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Missing,
            raw_yaml: None,
            document: None,
            active_config: None,
            validation: DraftValidationReport::default(),
        }));

        let app_state = AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: temp_dir.path().join("workspaces").display().to_string(),
            history_path: temp_dir.path().join("history.jsonl"),
            event_bus: EventBus::new(),
            config_runtime: ConfigRuntime {
                config_path,
                document_state,
            },
        };
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
    acpx_agent: claude
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
        assert!(response.active_config.is_some());
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

        let guided_form = response.guided_form.unwrap();
        assert_eq!(guided_form.tracker.repository.as_deref(), Some("acme/repo"));
        assert_eq!(guided_form.tracker.project_number, Some(9));
        assert_eq!(guided_form.tracker.api_key.as_deref(), Some("[REDACTED]"));
        assert!(response.raw_yaml.unwrap().contains("[REDACTED]"));
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
                    prompt: None,
                    prompt_file: None,
                }],
                steps: vec![crate::config::setup::SetupStep {
                    name: "build".to_string(),
                    agent_role: "builder".to_string(),
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
    async fn test_get_setup_defaults_without_existing_config_keeps_flag_only_at_top_level() {
        let (state, _temp_dir) = test_app_state();

        let (status, Json(response)) = get_setup_defaults(axum::extract::State(state)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(!response.has_existing_config);
        assert_eq!(response.defaults["tracker"]["kind"], "todo_file");
        assert!(response.defaults.get("has_existing_config").is_none());
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
                    prompt: None,
                    prompt_file: None,
                }],
                steps: vec![crate::config::setup::SetupStep {
                    name: "build".to_string(),
                    agent_role: "builder".to_string(),
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
    async fn test_replace_document_state_from_yaml_updates_doc_state_for_valid_yaml() {
        let (state, _temp_dir) = test_app_state();
        let mut doc_state = state.config_runtime.document_state.write().await;
        let raw_yaml = r#"
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
on_success: Done
on_failure: Failed
"#;

        let response = replace_document_state_from_yaml(
            &mut doc_state,
            &state.config_runtime.config_path,
            raw_yaml,
        )
        .unwrap();

        assert_eq!(response.state, "parsed");
        assert_eq!(doc_state.kind, ConfigStateKind::Parsed);
        assert_eq!(doc_state.raw_yaml.as_deref(), Some(raw_yaml));
    }

    #[tokio::test]
    async fn test_save_yaml_and_save_guided_form_share_invalid_save_response_shape() {
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
on_success: Done
on_failure: Failed
"#;
        let invalid_yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
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
            base_yaml.to_string(),
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
                kind: "todo_file".to_string(),
                path: None,
                repository: None,
                project_number: None,
                api_key: None,
                endpoint: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
            repos: vec![],
            agents: vec![crate::config::form::GuidedAgentForm {
                name: "builder".to_string(),
                executor: None,
                model: None,
                acpx_agent: Some("claude".to_string()),
                prompt: Some("Build it.".to_string()),
                prompt_template: None,
                reasoning_level: None,
            }],
            steps: vec![crate::config::form::GuidedStepForm {
                name: "build".to_string(),
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
                    permission_policy: "auto_approve_all".to_string(),
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
                base_raw_yaml: base_yaml.to_string(),
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
        assert_eq!(yaml_response.issues.last().unwrap().section, "save");
        assert_eq!(form_response.issues.last().unwrap().section, "save");
    }

    #[test]
    fn redact_secrets_redacts_literal_api_key() {
        let yaml = "tracker:\n  kind: github\n  api_key: ghp_secret123";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("ghp_secret123"));
    }

    #[test]
    fn redact_secrets_preserves_env_var_reference() {
        let yaml = "tracker:\n  api_key: $GITHUB_TOKEN";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("$GITHUB_TOKEN"));
        assert!(!redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_preserves_quoted_env_var_reference() {
        let yaml = "tracker:\n  api_key: \"$GITHUB_TOKEN\"";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("\"$GITHUB_TOKEN\""));
        assert!(!redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_does_not_panic_on_unterminated_quoted_value() {
        let yaml = "tracker:\n  api_key: \"";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_redacts_token_and_password() {
        let yaml = "auth:\n  token: abc123\n  password: hunter2";
        let redacted = redact_secrets(yaml);
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("hunter2"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_redacts_literal_secret() {
        let yaml = "secret: mysecretvalue";
        let redacted = redact_secrets(yaml);
        assert!(!redacted.contains("mysecretvalue"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_handles_equals_separator() {
        let yaml = "secret=mysecretvalue";
        let redacted = redact_secrets(yaml);
        assert!(!redacted.contains("mysecretvalue"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn redact_secrets_preserves_indentation() {
        let yaml = "tracker:\n  api_key: ghp_secret";
        let redacted = redact_secrets(yaml);
        assert!(redacted.starts_with("tracker:\n  api_key:"));
    }

    #[test]
    fn redact_secrets_redacts_inline_yaml_mapping_values() {
        let yaml = "tracker: { api_key: ghp_secret123, kind: github }";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("api_key: \"[REDACTED]\""));
        assert!(!redacted.contains("ghp_secret123"));
        assert!(redacted.contains("kind: github"));
    }

    #[test]
    fn redact_secrets_preserves_quoted_env_var_reference_in_inline_mapping() {
        let yaml = "tracker: { api_key: \"$GITHUB_TOKEN\", kind: github }";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("api_key: \"$GITHUB_TOKEN\""));
        assert!(!redacted.contains("[REDACTED]"));
        assert!(redacted.contains("kind: github"));
    }

    #[test]
    fn redact_secrets_redacts_multiple_inline_secrets_on_same_line() {
        let yaml = "tracker: { api_key: ghp_x, token: abc, kind: github }";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("api_key: \"[REDACTED]\""));
        assert!(redacted.contains("token: \"[REDACTED]\""));
        assert!(!redacted.contains("ghp_x"));
        assert!(!redacted.contains("abc"));
        assert!(redacted.contains("kind: github"));
    }

    #[test]
    fn redact_secrets_redacts_sequence_item_key_values() {
        let yaml = "secrets:\n  - token: abc123\n  - password: hunter2";
        let redacted = redact_secrets(yaml);
        assert!(redacted.contains("- token: \"[REDACTED]\""));
        assert!(redacted.contains("- password: \"[REDACTED]\""));
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("hunter2"));
    }
}
