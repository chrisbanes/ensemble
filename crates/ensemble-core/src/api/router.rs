use crate::api::{controls, conversation, handlers, history_handler, ws};
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::services::{ServeDir, ServeFile};

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
/// **Security:** The API is unauthenticated. The CLI binds to `127.0.0.1` by
/// default, but callers can override the listen address via `--host` / `HOST`.
/// Binding to a non-loopback address exposes this unauthenticated API to the
/// network — only do so in trusted environments or behind a reverse proxy.
///
/// If `static_dir` is provided, unmatched non-API, non-WS routes serve static
/// files from that directory with SPA fallback to `index.html`. API and WS
/// routes have their own 404 fallbacks so they never leak `index.html`.
pub fn create_api_router(state: AppState) -> Router {
    create_api_router_with_static(state, None)
}

/// Create the API router with optional static file serving for the dashboard SPA.
pub fn create_api_router_with_static(state: AppState, static_dir: Option<PathBuf>) -> Router {
    // API routes get a JSON 404 fallback so unmatched /api/v1/* paths never
    // fall through to the static file handler.
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

    let mut router = Router::new()
        .nest("/api/v1", api_routes)
        .route("/ws/events/{identifier}", get(ws::ws_events))
        .with_state(state);

    if let Some(dir) = static_dir {
        let serve = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
        router = router.fallback_service(serve);
    }

    router
}

/// Fallback handler for unmatched API routes. Returns a JSON 404 instead of
/// falling through to the static file handler.
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
        }
    }

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }

    #[test]
    fn test_router_with_static_dir_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router_with_static(state, Some(PathBuf::from("/tmp/dashboard")));
    }
}
