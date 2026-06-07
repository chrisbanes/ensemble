use crate::agent::cancellation::CancellationRegistry;
use crate::api::interactions;
use crate::api::{
    config_edit_handler, config_handler, controls, conversation, fs_handler, handlers,
    history_handler, timeline_handler, ws,
};
use crate::config::draft::ConfigDocumentState;
use crate::history_store::store::HistoryStore;
use crate::observability::events::EventBus;
use crate::orchestrator::state::OrchestratorState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
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
    /// The currently registered orchestrator runtime for this app instance.
    ///
    /// Runtime registration only swaps ownership of the handle and never awaits while holding
    /// the lock, so a blocking mutex keeps this cheap and simple.
    pub orchestrator_runtime: crate::api::bootstrap::RegisteredOrchestrator,
    /// Flag that signals the orchestrator to run an immediate tick.
    /// The orchestrator polls this flag; setting it triggers a refresh.
    pub refresh_requested: Arc<tokio::sync::Notify>,
    /// The workspace root path, used for building issue detail paths.
    pub workspace_root: String,
    /// Path to the history JSONL file.
    pub history_path: PathBuf,
    /// Path to the global history sqlite database.
    pub history_db_path: PathBuf,
    /// Shared history store initialized at app bootstrap. Falls back to JSONL readers when absent.
    pub history_store: Option<HistoryStore>,
    /// Event bus for pipeline event broadcasting.
    pub event_bus: EventBus,
    /// Runtime configuration store with document state.
    pub config_runtime: ConfigRuntime,
    /// Per-issue cancellation handles for active worker runs.
    pub cancellation_registry: CancellationRegistry,
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
        .route("/interactions", get(interactions::list_open_interactions))
        .route(
            "/interactions/{id}",
            get(interactions::get_interaction_by_id),
        )
        .route(
            "/interactions/{id}/respond",
            post(interactions::respond_to_interaction),
        )
        .route(
            "/interactions/{id}/cancel",
            post(interactions::cancel_interaction),
        )
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
        .route(
            "/{identifier}/timeline",
            get(timeline_handler::get_timeline),
        )
        .route("/{identifier}/stop", post(controls::post_stop))
        .route("/{identifier}/retry", post(controls::post_retry))
        .route(
            "/{identifier}/step/{step_name}",
            get(handlers::get_step_detail),
        )
        .route(
            "/{identifier}/finalize/approve",
            post(controls::post_finalize_approve),
        )
        .route(
            "/{identifier}/finalize/retry",
            post(controls::post_finalize_retry),
        )
        .route("/issues/{identifier}/resume", post(controls::post_resume))
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
    (
        StatusCode::NOT_FOUND,
        handlers::api_error("not_found", "API endpoint not found"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};

    fn test_app_state() -> AppState {
        app_state_with_document_state(parsed_document_state())
    }

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }
}
