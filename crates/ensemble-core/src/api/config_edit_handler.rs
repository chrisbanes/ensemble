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
            .and_then(|yaml| crate::config::form::extract_guided_form(yaml).ok());

        Self {
            state: state_str.to_string(),
            config_path: state.path.display().to_string(),
            raw_yaml: state.raw_yaml.clone(),
            issues: state.validation.issues.clone(),
            active_config: state.active_config.clone(),
            guided_form,
        }
    }
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
    let response = ConfigStateResponse::from_state(&draft);
    (StatusCode::OK, Json(response))
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
    match save_raw_yaml_atomically(&state.config_runtime.config_path, &request.raw_yaml) {
        Ok(new_state) => {
            // Update the runtime state
            *state.config_runtime.document_state.write().await = new_state.clone();
            let response = ConfigStateResponse::from_state(&new_state);
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let current = state.config_runtime.document_state.read().await.clone();
            (
                StatusCode::BAD_REQUEST,
                Json(build_error_response(&current, &e)),
            )
        }
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
        // Return empty defaults
        let defaults = serde_json::json!({
            "tracker": { "kind": "todo_file" },
            "has_existing_config": false,
        });

        (defaults, false)
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
    match crate::config::setup::discover_available_agents() {
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
    let checks = crate::config::setup::run_setup_checks(&request.setup);
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
    let current = state.config_runtime.document_state.read().await.clone();

    // First validate the setup
    let checks = crate::config::setup::run_setup_checks(&request.setup);
    if !crate::config::setup::setup_can_save(&checks) {
        let mut response = ConfigStateResponse::from_state(&current);
        response.issues.push(ValidationIssue {
            kind: crate::config::draft::ValidationIssueKind::Config,
            message: "Setup validation failed".to_string(),
            section: "setup".to_string(),
            field: None,
            path: None,
        });
        return (StatusCode::BAD_REQUEST, Json(response));
    }

    let artifacts = match crate::config::setup::merge_setup_request(
        current.raw_yaml.as_deref(),
        &request.setup,
    ) {
        Ok(artifacts) => artifacts,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(build_error_response(&current, &e)),
            )
        }
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
                    *state.config_runtime.document_state.write().await = new_state.clone();
                    let response = ConfigStateResponse::from_state(&new_state);
                    (StatusCode::OK, Json(response))
                }
                Err(e) => (
                    StatusCode::BAD_REQUEST,
                    Json(build_error_response(&current, &e)),
                ),
            }
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(build_error_response(&current, &e)),
        ),
    }
}

fn default_setup_defaults() -> serde_json::Value {
    serde_json::json!({
        "tracker": { "kind": "todo_file" },
        "has_existing_config": false,
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
    Json(request): Json<ValidateGuidedFormRequest>,
) -> (StatusCode, Json<ValidateGuidedFormResponse>) {
    match crate::config::form::apply_guided_form(&request.base_raw_yaml, &request.form) {
        Ok(merged_yaml) => {
            // Parse and validate the merged YAML
            let draft = crate::config::draft::parse_raw_yaml(
                std::path::PathBuf::from("config.yaml"),
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

/// Response containing the result of saving guided form content.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SaveGuidedFormResponse {
    pub merged_yaml: String,
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
        (status = 200, description = "Save result", body = SaveGuidedFormResponse),
        (status = 400, description = "Merge or save failed")
    ),
    tag = "config"
)]
pub async fn save_guided_form(
    State(state): State<AppState>,
    Json(request): Json<SaveGuidedFormRequest>,
) -> (StatusCode, Json<ConfigStateResponse>) {
    // First, merge the guided form with the base YAML
    let merged_yaml =
        match crate::config::form::apply_guided_form(&request.base_raw_yaml, &request.form) {
            Ok(yaml) => yaml,
            Err(e) => {
                let current = state.config_runtime.document_state.read().await.clone();
                let mut response = ConfigStateResponse::from_state(&current);
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
    match crate::config::draft::save_raw_yaml_atomically(
        &state.config_runtime.config_path,
        &merged_yaml,
    ) {
        Ok(new_state) => {
            // Update the runtime state
            *state.config_runtime.document_state.write().await = new_state.clone();
            let response = ConfigStateResponse::from_state(&new_state);
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let current = state.config_runtime.document_state.read().await.clone();
            (
                StatusCode::BAD_REQUEST,
                Json(build_error_response(&current, &e)),
            )
        }
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
}
