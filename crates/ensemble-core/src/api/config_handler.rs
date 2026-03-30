use crate::api::router::AppState;
use crate::config::ensemble::EnsembleConfig;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

/// Response for GET /api/v1/config.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ConfigResponse {
    pub valid: bool,
    pub errors: Vec<String>,
    pub config_path: String,
    pub config: EnsembleConfig,
}

/// GET /api/v1/config
///
/// Returns the effective ensemble configuration and validation state.
#[utoipa::path(
    get,
    path = "/api/v1/config",
    operation_id = "getConfig",
    responses(
        (status = 200, description = "Effective configuration", body = ConfigResponse)
    ),
    tag = "config"
)]
pub async fn get_config(State(state): State<AppState>) -> (StatusCode, Json<ConfigResponse>) {
    let config = state.config.as_ref().clone();
    let errors = collect_validation_errors(&config);
    let valid = errors.is_empty();

    // api_key is excluded from JSON by #[serde(skip_serializing)] on TrackerConfig.

    let response = ConfigResponse {
        valid,
        errors,
        config_path: state.config_path.clone(),
        config,
    };

    (StatusCode::OK, Json(response))
}

/// Collect validation errors using canonical validation + DAG check.
fn collect_validation_errors(config: &EnsembleConfig) -> Vec<String> {
    let mut errors = Vec::new();

    if let Err(e) = crate::config::ensemble::validate_config(config) {
        errors.push(e.to_string());
    }

    if let Err(e) = crate::pipeline::dag::build_dag(&config.steps) {
        errors.push(e.to_string());
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::parse_config;
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use axum::extract::State;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_config() -> EnsembleConfig {
        parse_config(
            r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap()
    }

    fn build_app_state(config: EnsembleConfig) -> AppState {
        AppState {
            orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(30000, 10))),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config: Arc::new(config),
            config_path: "ensemble.yaml".to_string(),
        }
    }

    #[tokio::test]
    async fn test_get_config_valid() {
        let state = build_app_state(test_config());
        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(response.valid);
        assert!(response.errors.is_empty());
        assert_eq!(response.config_path, "ensemble.yaml");
        assert_eq!(response.config.tracker.kind, "todo_file");
    }

    #[tokio::test]
    async fn test_get_config_strips_api_key_from_json() {
        let config = parse_config(
            r#"
tracker:
  kind: github
  api_key: ghp_secret_token_12345
  repository: acme/repo
agents:
  build:
    executor: claude-code
    model: test
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();
        let state = build_app_state(config);
        let (_status, Json(response)) = get_config(State(state)).await;
        // api_key has skip_serializing, so it must not appear in JSON output.
        let json = serde_json::to_string(&response).unwrap();
        assert!(!json.contains("ghp_secret_token_12345"));
        assert!(!json.contains("api_key"));
    }

    #[tokio::test]
    async fn test_get_config_with_errors() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: test
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();
        let state = build_app_state(config);
        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!response.valid);
        assert!(!response.errors.is_empty());
    }
}
