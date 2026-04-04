use crate::api::{
    config_edit_handler, config_handler, controls, conversation, fs_handler, handlers,
    history_handler, ws,
};
use crate::config::draft::ConfigDocumentState;
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use utoipa::OpenApi;

/// Runtime configuration store that holds the current config state.
#[derive(Clone)]
pub struct ConfigRuntime {
    pub config_path: PathBuf,
    pub document_state: Arc<RwLock<ConfigDocumentState>>,
}

/// Shared application state passed to all API handlers.
#[derive(Clone)]
pub struct AppState {
    /// The orchestrator state, shared with the orchestrator task via RwLock.
    pub orchestrator_state: Arc<RwLock<OrchestratorState>>,
    /// Flag that signals the orchestrator to run an immediate tick.
    /// The orchestrator polls this flag; setting it triggers a refresh.
    pub refresh_requested: Arc<tokio::sync::Notify>,
    /// The workspace root path, used for building issue detail paths.
    pub workspace_root: String,
    /// Path to the history JSONL file.
    pub history_path: PathBuf,
    /// Event bus for pipeline event broadcasting.
    pub event_bus: EventBus,
    /// Runtime configuration store with document state.
    pub config_runtime: ConfigRuntime,
}

/// Create the axum router for the Ensemble HTTP API.
///
/// Endpoints:
/// - `GET /api/v1/state` — runtime snapshot
/// - `POST /api/v1/refresh` — trigger immediate poll+reconcile
/// - `GET /api/v1/history` — query history records
/// - `GET /api/v1/{identifier}` — issue-specific detail
/// - `GET /api/v1/{identifier}/conversation` — paginated conversation
/// - `GET /api/v1/{identifier}/conversation/{index}` — single conversation message
/// - `POST /api/v1/{identifier}/stop` — stop a running agent
/// - `POST /api/v1/{identifier}/retry` — retry a failed issue
/// - `GET /ws/events/{identifier}` — WebSocket live event stream
///
/// **Security:** The API is unauthenticated. Bind to `127.0.0.1` by
/// default. Binding to a non-loopback address exposes this unauthenticated API to the
/// network — only do so in trusted environments or behind a reverse proxy.
///
/// Note: This router provides API routes only. UI/SPA serving is handled separately
/// by the CLI's embedded_ui module.
pub fn create_api_router(state: AppState) -> Router {
    // API routes get a JSON 404 fallback
    let api_routes = Router::new()
        .route("/state", get(handlers::get_state))
        .route(
            "/refresh",
            post(handlers::post_refresh)
                .get(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        )
        .route("/history", get(history_handler::get_history))
        .route("/fs/list", get(fs_handler::list_directory))
        .route("/config", get(config_handler::get_config))
        // Config YAML endpoints
        .route(
            "/config/yaml/validate",
            post(config_edit_handler::validate_yaml),
        )
        .route("/config/yaml/save", post(config_edit_handler::save_yaml))
        // Config setup endpoints
        .route(
            "/config/setup/defaults",
            get(config_edit_handler::get_setup_defaults),
        )
        .route(
            "/config/setup/agents",
            get(config_edit_handler::get_setup_agents),
        )
        .route(
            "/config/setup/agents/stream",
            get(config_edit_handler::get_setup_agents_stream),
        )
        .route(
            "/config/setup/validate",
            post(config_edit_handler::validate_setup),
        )
        .route("/config/setup/save", post(config_edit_handler::save_setup))
        // Config form endpoints
        .route(
            "/config/form/validate",
            post(config_edit_handler::validate_guided_form),
        )
        .route(
            "/config/form/save",
            post(config_edit_handler::save_guided_form),
        )
        .route(
            "/{identifier}/conversation",
            get(conversation::get_conversation),
        )
        .route(
            "/{identifier}/conversation/{index}",
            get(conversation::get_conversation_message),
        )
        .route("/{identifier}/stop", post(controls::post_stop))
        .route("/{identifier}/retry", post(controls::post_retry))
        .route(
            "/{identifier}",
            get(handlers::get_issue_detail)
                .post(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        )
        .fallback(api_not_found);

    // Generate OpenAPI spec once at startup.
    let openapi_json = crate::api::openapi::ApiDoc::openapi()
        .to_json()
        .expect("OpenAPI spec serialization should not fail");

    Router::new()
        .route(
            "/api/openapi.json",
            get(move || {
                let json = openapi_json.clone();
                async move { (StatusCode::OK, [("content-type", "application/json")], json) }
            }),
        )
        .nest("/api/v1", api_routes)
        .route("/ws/events/{identifier}", get(ws::ws_events))
        .with_state(state)
}

/// Fallback handler for unmatched API routes. Returns a JSON 404.
async fn api_not_found() -> impl IntoResponse {
    let error = handlers::ApiError::new("not_found", "API endpoint not found");
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::to_value(error).unwrap()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app_state() -> AppState {
        use crate::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};

        let state = OrchestratorState::new(30000, 10);
        let config_path = PathBuf::from("ensemble.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: Some("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed".to_string()),
            document: None,
            active_config: Some(crate::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
            validation: DraftValidationReport::default(),
        }));

        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
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

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }
}
