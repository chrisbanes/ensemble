use crate::api::handlers::ApiError;
use crate::api::router::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Serialize;

/// Response for a successful stop operation.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StopResponse {
    pub stopped: bool,
    pub issue_identifier: String,
    pub message: String,
}

/// Response for a successful retry operation.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RetryResponse {
    pub retried: bool,
    pub issue_identifier: String,
    pub message: String,
}

/// POST /api/v1/{identifier}/stop
///
/// Stops a running agent for the specified issue. Sends SIGTERM to the agent process
/// and removes it from the running state. Returns 404 if not found, 409 if not running.
#[utoipa::path(
    post,
    path = "/api/v1/{identifier}/stop",
    operation_id = "postStop",
    params(("identifier" = String, Path, description = "Issue identifier")),
    responses(
        (status = 200, description = "Agent stopped", body = StopResponse),
        (status = 404, description = "Not found", body = ApiError),
        (status = 409, description = "Not running", body = ApiError)
    ),
    tag = "controls"
)]
pub async fn post_stop(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    let mut lock = state.orchestrator_state.write().await;

    // Find the running entry by identifier
    let issue_id = lock
        .running
        .values()
        .find(|e| e.identifier == identifier)
        .map(|e| e.issue_id.clone());

    let issue_id = match issue_id {
        Some(id) => id,
        None => {
            // Check if it's retrying instead
            let is_retrying = lock
                .retry_attempts
                .values()
                .any(|e| e.identifier == identifier);

            if is_retrying {
                return (
                    StatusCode::CONFLICT,
                    Json(
                        serde_json::to_value(ApiError::new(
                            "not_running",
                            &format!(
                                "issue '{}' is retrying, not running — use retry endpoint instead",
                                identifier
                            ),
                        ))
                        .unwrap(),
                    ),
                )
                    .into_response();
            }

            return (
                StatusCode::NOT_FOUND,
                Json(
                    serde_json::to_value(ApiError::new(
                        "issue_not_found",
                        &format!(
                            "no running or retrying issue with identifier '{}'",
                            identifier
                        ),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    // Attempt to send SIGTERM to the agent process
    if let Some(entry) = lock.running.get(&issue_id) {
        if let Some(ref pid_str) = entry.agent_pid {
            if let Ok(pid) = pid_str.parse::<i32>() {
                if pid > 0 {
                    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
                    if rc == -1 {
                        tracing::warn!(pid, issue_id = %issue_id, "failed to send SIGTERM");
                    }
                } else {
                    tracing::warn!(pid, issue_id = %issue_id, "skipping SIGTERM for non-positive PID");
                }
            }
        }
    }

    // TODO: Once the orchestrator event loop exists (Plan 3), stop requests
    // should be routed through a command channel instead of mutating state
    // directly. This avoids a race where the orchestrator's WorkerExited
    // handler processes a stale entry. For now, direct mutation is correct
    // because the orchestrator loop is a placeholder.
    if let Some(entry) = lock.remove_running(&issue_id) {
        lock.add_runtime_seconds(&entry);
    }
    lock.remove_claimed(&issue_id);
    lock.remove_pipeline_run(&issue_id);
    drop(lock);

    (
        StatusCode::OK,
        Json(
            serde_json::to_value(StopResponse {
                stopped: true,
                issue_identifier: identifier,
                message: "agent stopped and issue released".to_string(),
            })
            .unwrap(),
        ),
    )
        .into_response()
}

/// POST /api/v1/{identifier}/retry
///
/// Removes an issue from the retry queue, making it available for immediate re-dispatch.
/// Returns 404 if not found, 409 if the issue is currently running (not retrying).
#[utoipa::path(
    post,
    path = "/api/v1/{identifier}/retry",
    operation_id = "postRetry",
    params(("identifier" = String, Path, description = "Issue identifier")),
    responses(
        (status = 200, description = "Retry queued", body = RetryResponse),
        (status = 404, description = "Not found", body = ApiError),
        (status = 409, description = "Not retrying", body = ApiError)
    ),
    tag = "controls"
)]
pub async fn post_retry(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    let mut lock = state.orchestrator_state.write().await;

    // Find the retry entry by identifier
    let issue_id = lock
        .retry_attempts
        .values()
        .find(|e| e.identifier == identifier)
        .map(|e| e.issue_id.clone());

    let issue_id = match issue_id {
        Some(id) => id,
        None => {
            // Check if it's running instead
            let is_running = lock.running.values().any(|e| e.identifier == identifier);

            if is_running {
                return (
                    StatusCode::CONFLICT,
                    Json(
                        serde_json::to_value(ApiError::new(
                            "not_retrying",
                            &format!(
                                "issue '{}' is currently running — use stop endpoint to interrupt",
                                identifier
                            ),
                        ))
                        .unwrap(),
                    ),
                )
                    .into_response();
            }

            return (
                StatusCode::NOT_FOUND,
                Json(
                    serde_json::to_value(ApiError::new(
                        "issue_not_found",
                        &format!(
                            "no running or retrying issue with identifier '{}'",
                            identifier
                        ),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    // Remove from retry queue and release claim (allows next poll to re-pick it up)
    lock.remove_retry(&issue_id);
    lock.remove_claimed(&issue_id);
    drop(lock);

    // Signal the orchestrator to poll immediately so it picks up the now-unclaimed issue
    state.refresh_requested.notify_one();

    (
        StatusCode::OK,
        Json(
            serde_json::to_value(RetryResponse {
                retried: true,
                issue_identifier: identifier,
                message: "removed from retry queue, will be re-dispatched on next poll".to_string(),
            })
            .unwrap(),
        ),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{Issue, RetryEntry};
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: None,
            priority: Some(2),
            state: "In Progress".to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    fn build_app_state_with_running() -> AppState {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue(), None);
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

    fn build_app_state_with_retry() -> AppState {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_retry(RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 2,
            due_at_ms: 999999,
            error: Some("timeout".to_string()),
        });
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
    async fn test_stop_running_issue() {
        let state = build_app_state_with_running();
        let response = post_stop(State(state.clone()), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        // Verify issue is no longer running
        let lock = state.orchestrator_state.read().await;
        assert!(lock.running.is_empty());
        assert!(!lock.is_claimed("NODE_123"));
    }

    #[tokio::test]
    async fn test_stop_not_found() {
        let state = build_app_state_with_running();
        let response = post_stop(State(state), Path("nonexistent#999".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_stop_retrying_issue_returns_conflict() {
        let state = build_app_state_with_retry();
        let response = post_stop(State(state), Path("my-repo#99".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_retry_retrying_issue() {
        let state = build_app_state_with_retry();
        let response = post_retry(State(state.clone()), Path("my-repo#99".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        // Verify issue is no longer in retry queue
        let lock = state.orchestrator_state.read().await;
        assert!(lock.retry_attempts.is_empty());
        assert!(!lock.is_claimed("NODE_456"));
    }

    #[tokio::test]
    async fn test_retry_not_found() {
        let state = build_app_state_with_retry();
        let response = post_retry(State(state), Path("nonexistent#999".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_retry_running_issue_returns_conflict() {
        let state = build_app_state_with_running();
        let response = post_retry(State(state), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
}
