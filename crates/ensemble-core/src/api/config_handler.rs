use crate::api::config_edit_handler::ConfigStateResponse;
use crate::api::router::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

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
    use crate::api::test_helpers::{
        app_state_with_document_state, app_state_with_missing_config, parsed_document_state,
    };
    use crate::config::draft::ConfigDocumentState;
    use crate::config::ensemble::parse_config;
    use axum::extract::State;
    use std::path::PathBuf;

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
        let document_state = ConfigDocumentState {
            path: PathBuf::from("config.yaml"),
            active_config: Some(config),
            ..parsed_document_state()
        };
        app_state_with_document_state(document_state)
    }

    #[tokio::test]
    async fn test_get_config_valid() {
        let state = build_app_state(test_config());
        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "parsed");
        assert!(response.issues.is_empty());
        assert_eq!(response.config_path, "config.yaml");
        assert!(response.guided_form.is_some());
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
        // The literal secret must never appear in the JSON output. The guided
        // form exposes only the fact that a secret is configured.
        let json = serde_json::to_string(&response).unwrap();
        assert!(
            !json.contains("ghp_secret_token_12345"),
            "secret token leaked into JSON: {json}"
        );
        assert_eq!(
            response
                .guided_form
                .as_ref()
                .map(|form| &form.tracker.api_key),
            Some(&crate::config::secrets::SecretDisplay::Redacted)
        );
    }

    #[tokio::test]
    async fn test_get_config_missing_state() {
        let state = app_state_with_missing_config(
            PathBuf::from("/tmp/nonexistent.yaml"),
            "/tmp/workspaces",
        );

        let (status, Json(response)) = get_config(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response.state, "missing");
        assert!(response.guided_form.is_none());
    }
}
