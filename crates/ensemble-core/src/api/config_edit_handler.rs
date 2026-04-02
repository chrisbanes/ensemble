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
}

impl ConfigStateResponse {
    /// Create a ConfigStateResponse from a ConfigDocumentState.
    pub fn from_state(state: &ConfigDocumentState) -> Self {
        let state_str = match state.kind {
            ConfigStateKind::Missing => "missing",
            ConfigStateKind::SyntaxError => "syntax_error",
            ConfigStateKind::Parsed => "parsed",
        };

        Self {
            state: state_str.to_string(),
            config_path: state.path.display().to_string(),
            raw_yaml: state.raw_yaml.clone(),
            issues: state.validation.issues.clone(),
            active_config: state.active_config.clone(),
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
            (StatusCode::BAD_REQUEST, Json(build_error_response(&current, &e)))
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

    let (defaults, has_existing) = if let Some(ref config) = doc_state.active_config {
        // Extract defaults from existing config
        let tracker_default = serde_json::json!({
            "kind": config.tracker.kind,
        });

        let defaults = serde_json::json!({
            "tracker": tracker_default,
            "has_existing_config": true,
        });

        (defaults, true)
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
    let can_save = checks.iter().all(|c| c.passed);

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
    // First validate the setup
    let checks = crate::config::setup::run_setup_checks(&request.setup);
    if !checks.iter().all(|c| c.passed) {
        let current = state.config_runtime.document_state.read().await.clone();
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

    // Build artifacts from setup request
    let artifacts = crate::config::setup::build_setup_artifacts(&request.setup);

    // Save the YAML
    match save_raw_yaml_atomically(&state.config_runtime.config_path, &artifacts.raw_yaml) {
        Ok(new_state) => {
            // Update the runtime state
            *state.config_runtime.document_state.write().await = new_state.clone();
            let response = ConfigStateResponse::from_state(&new_state);
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let current = state.config_runtime.document_state.read().await.clone();
            (StatusCode::BAD_REQUEST, Json(build_error_response(&current, &e)))
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
        let config_path = temp_dir.path().join("test_config.yaml");
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
}
