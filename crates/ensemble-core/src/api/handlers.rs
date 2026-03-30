use crate::api::router::AppState;
use crate::observability::snapshot::{
    build_issue_snapshot, build_state_snapshot, IssueDetailSnapshot, RuntimeSnapshot,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::Serialize;

/// Standard JSON error envelope matching SPEC.md Section 13.7.2 error format.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ApiError {
    pub error: ApiErrorDetail,
}

/// Inner detail of the error envelope.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            error: ApiErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
            },
        }
    }
}

/// GET /api/v1/state
///
/// Acquires a read lock on the orchestrator state, builds a RuntimeSnapshot,
/// and returns it as JSON.
#[utoipa::path(
    get,
    path = "/api/v1/state",
    operation_id = "getState",
    responses(
        (status = 200, description = "Runtime snapshot", body = RuntimeSnapshot)
    ),
    tag = "state"
)]
pub async fn get_state(State(state): State<AppState>) -> (StatusCode, Json<RuntimeSnapshot>) {
    let lock = state.orchestrator_state.read().await;
    let snapshot = build_state_snapshot(&lock);
    drop(lock);

    (StatusCode::OK, Json(snapshot))
}

/// GET /api/v1/{identifier}
///
/// Looks up an issue by its identifier (e.g. "my-repo#42") in running and retry maps.
/// Returns the issue detail or 404 with a JSON error envelope.
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}",
    operation_id = "getIssueDetail",
    params(
        ("identifier" = String, Path, description = "Issue identifier")
    ),
    responses(
        (status = 200, description = "Issue detail", body = IssueDetailSnapshot),
        (status = 404, description = "Issue not found", body = ApiError)
    ),
    tag = "issues"
)]
pub async fn get_issue_detail(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    let lock = state.orchestrator_state.read().await;
    let detail = build_issue_snapshot(&lock, &identifier, &state.workspace_root);
    drop(lock);

    match detail {
        Some(detail) => {
            (StatusCode::OK, Json(serde_json::to_value(detail).unwrap())).into_response()
        }
        None => {
            let error = ApiError::new(
                "issue_not_found",
                &format!(
                    "no running or retrying issue with identifier '{}'",
                    identifier
                ),
            );
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::to_value(error).unwrap()),
            )
                .into_response()
        }
    }
}

/// Response body for POST /api/v1/refresh.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RefreshResponse {
    pub queued: bool,
    pub coalesced: bool,
    pub requested_at: String,
    pub operations: Vec<String>,
}

/// POST /api/v1/refresh
///
/// Signals the orchestrator to run an immediate tick (poll + reconcile).
/// Returns 202 Accepted with a confirmation body.
#[utoipa::path(
    post,
    path = "/api/v1/refresh",
    operation_id = "postRefresh",
    responses(
        (status = 202, description = "Refresh queued", body = RefreshResponse)
    ),
    tag = "controls"
)]
pub async fn post_refresh(State(state): State<AppState>) -> (StatusCode, Json<RefreshResponse>) {
    state.refresh_requested.notify_one();

    let response = RefreshResponse {
        queued: true,
        coalesced: false,
        requested_at: Utc::now().to_rfc3339(),
        operations: vec!["poll".to_string(), "reconcile".to_string()],
    };

    (StatusCode::ACCEPTED, Json(response))
}

/// Handler for unsupported HTTP methods on defined routes.
/// Returns 405 Method Not Allowed with a JSON error envelope.
pub async fn method_not_allowed() -> (StatusCode, Json<serde_json::Value>) {
    let error = ApiError::new(
        "method_not_allowed",
        "this HTTP method is not supported on this endpoint",
    );
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(serde_json::to_value(error).unwrap()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::AppState;
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{Issue, RetryEntry, RunningEntry};
    use chrono::Utc;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            state: "In Progress".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    fn test_running_entry() -> RunningEntry {
        RunningEntry {
            issue_id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            issue: test_issue(),
            session_id: Some("session-abc".to_string()),
            agent_pid: Some("12345".to_string()),
            last_agent_event: Some("turn_completed".to_string()),
            last_agent_timestamp: Some(Utc::now()),
            last_agent_message: Some("Working on tests".to_string()),
            agent_input_tokens: 1200,
            agent_output_tokens: 800,
            agent_total_tokens: 2000,
            last_reported_input_tokens: 1200,
            last_reported_output_tokens: 800,
            last_reported_total_tokens: 2000,
            turn_count: 7,
            retry_attempt: None,
            started_at: Utc::now(),
        }
    }

    fn test_retry_entry() -> RetryEntry {
        RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 3,
            due_at_ms: 1711641600000,
            error: Some("no available orchestrator slots".to_string()),
        }
    }

    fn build_populated_state() -> AppState {
        let mut state = OrchestratorState::new(30000, 10);
        state
            .running
            .insert("NODE_123".to_string(), test_running_entry());
        state
            .retry_attempts
            .insert("NODE_456".to_string(), test_retry_entry());
        state.claimed.insert("NODE_123".to_string());
        state.claimed.insert("NODE_456".to_string());
        state.agent_totals.input_tokens = 5000;
        state.agent_totals.output_tokens = 2400;
        state.agent_totals.total_tokens = 7400;
        state.agent_totals.seconds_running = 120.5;

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

    fn build_empty_state() -> AppState {
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

    #[tokio::test]
    async fn test_get_state_returns_json() {
        let app_state = build_populated_state();
        let (status, Json(snapshot)) = get_state(State(app_state)).await;

        assert_eq!(status, StatusCode::OK);

        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["counts"]["running"], 1);
        assert_eq!(json["counts"]["retrying"], 1);
        assert_eq!(json["agent_totals"]["input_tokens"], 5000);
        assert_eq!(json["agent_totals"]["output_tokens"], 2400);
        assert_eq!(json["agent_totals"]["total_tokens"], 7400);
    }

    #[tokio::test]
    async fn test_get_state_empty() {
        let app_state = build_empty_state();
        let (status, Json(snapshot)) = get_state(State(app_state)).await;

        assert_eq!(status, StatusCode::OK);

        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["counts"]["running"], 0);
        assert_eq!(json["counts"]["retrying"], 0);
    }

    #[tokio::test]
    async fn test_get_issue_detail_found() {
        let app_state = build_populated_state();
        let response = get_issue_detail(State(app_state), Path("my-repo#42".to_string())).await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_get_issue_detail_not_found() {
        let app_state = build_populated_state();
        let response =
            get_issue_detail(State(app_state), Path("nonexistent#999".to_string())).await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_post_refresh_returns_202() {
        let app_state = build_populated_state();
        let (status, Json(body)) = post_refresh(State(app_state)).await;

        assert_eq!(status, StatusCode::ACCEPTED);
        assert!(body.queued);
        assert!(!body.coalesced);
        assert_eq!(body.operations, vec!["poll", "reconcile"]);
    }

    #[tokio::test]
    async fn test_method_not_allowed_response() {
        let (status, _) = method_not_allowed().await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn test_error_envelope_json_shape() {
        let error = ApiError::new("issue_not_found", "no such issue");
        let json = serde_json::to_value(&error).unwrap();

        assert!(json.get("error").is_some());
        let err = json.get("error").unwrap();
        assert_eq!(
            err.get("code").unwrap().as_str().unwrap(),
            "issue_not_found"
        );
        assert_eq!(
            err.get("message").unwrap().as_str().unwrap(),
            "no such issue"
        );
    }

    #[tokio::test]
    async fn test_get_issue_detail_retrying_issue() {
        let app_state = build_populated_state();
        let response = get_issue_detail(State(app_state), Path("my-repo#99".to_string())).await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
