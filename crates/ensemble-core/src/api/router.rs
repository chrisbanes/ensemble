use crate::api::{config_handler, controls, conversation, handlers, history_handler, ws};
use crate::config::ensemble::EnsembleConfig;
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
    /// The loaded ensemble configuration.
    pub config: Arc<EnsembleConfig>,
    /// Path to the config.yaml file.
    pub config_path: String,
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
        .route("/config", get(config_handler::get_config))
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
        let state = OrchestratorState::new(30000, 10);
        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config: Arc::new(crate::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
            config_path: "ensemble.yaml".to_string(),
        }
    }

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }
}
