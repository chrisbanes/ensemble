use crate::api::config_edit_handler::ConfigStateResponse;
use crate::api::router::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

/// Response for GET /api/v1/config (legacy - kept for backwards compatibility).
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ConfigResponse {
    pub valid: bool,
    pub errors: Vec<String>,
    pub config_path: String,
    pub config: Option<crate::config::ensemble::EnsembleConfig>,
}

/// GET /api/v1/config
///
/// Returns the effective ensemble configuration and validation state.
#[utoipa::path(
    get,
    path = "/api/v1/config",
    operation_id = "getConfig",
    responses(
        (status = 200, description = "Effective configuration", body = ConfigStateResponse)
    ),
    tag = "config"
)]
pub async fn get_config(State(state): State<AppState>) -> (StatusCode, Json<ConfigStateResponse>) {
    let doc_state = state.config_runtime.document_state.read().await;
    let response = ConfigStateResponse::from_state(&doc_state);
    (StatusCode::OK, Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::{AppState, ConfigRuntime};
    use crate::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
    use crate::config::ensemble::parse_config;
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use axum::extract::State;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_config() -> crate::config::ensemble::EnsembleConfig {
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

    fn build_app_state(config: crate::config::ensemble::EnsembleConfig) -> AppState {
        let config_path = PathBuf::from("config.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(config),
            validation: DraftValidationReport::default(),
        }));

        AppState {
            orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(30000, 10))),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config_runtime: ConfigRuntime {
                config_path,
                document_state,
            },
        }
    }

    #[tokio::test]
    async fn test_get_config_valid() {
        let state = build_app_state(test_config());
        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");
        assert!(response.issues.is_empty());
        assert_eq!(response.config_path, "config.yaml");
        assert!(response.active_config.is_some());
        assert_eq!(
            response.active_config.as_ref().unwrap().tracker.kind,
            "todo_file"
        );
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
    async fn test_get_config_missing_state() {
        let config_path = PathBuf::from("/tmp/nonexistent.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Missing,
            raw_yaml: None,
            document: None,
            active_config: None,
            validation: DraftValidationReport::default(),
        }));

        let state = AppState {
            orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(30000, 10))),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config_runtime: ConfigRuntime {
                config_path,
                document_state,
            },
        };

        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "missing");
        assert!(response.active_config.is_none());
    }
}
