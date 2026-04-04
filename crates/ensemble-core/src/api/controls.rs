use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use crate::interaction::{InteractionStatus, InteractionStore};
use crate::orchestrator::state::OrchestratorState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::Json;
use serde::Serialize;

#[derive(Debug, PartialEq, Eq)]
enum IssuePresence {
    Running(String),
    Retrying(String),
    Missing,
}

enum StopSignalStatus {
    Sent,
    MissingPid,
    InvalidPid,
    SignalFailed,
}

fn find_issue_presence(state: &OrchestratorState, identifier: &str) -> IssuePresence {
    if let Some(issue_id) = state
        .running
        .values()
        .find(|entry| entry.identifier == identifier)
        .map(|entry| entry.issue_id.clone())
    {
        return IssuePresence::Running(issue_id);
    }

    if let Some(issue_id) = state
        .retry_attempts
        .values()
        .find(|entry| entry.identifier == identifier)
        .map(|entry| entry.issue_id.clone())
    {
        return IssuePresence::Retrying(issue_id);
    }

    IssuePresence::Missing
}

fn try_signal_stop(state: &OrchestratorState, issue_id: &str) -> StopSignalStatus {
    let Some(entry) = state.running.get(issue_id) else {
        return StopSignalStatus::SignalFailed;
    };

    let Some(pid_str) = entry.agent_pid.as_deref() else {
        return StopSignalStatus::MissingPid;
    };

    let Ok(pid) = pid_str.parse::<i32>() else {
        return StopSignalStatus::InvalidPid;
    };

    if pid <= 0 {
        return StopSignalStatus::InvalidPid;
    }

    signal_stop(pid, issue_id)
}

#[cfg(unix)]
fn signal_stop(pid: i32, issue_id: &str) -> StopSignalStatus {
    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
    if rc == -1 {
        tracing::warn!(pid, issue_id = %issue_id, "failed to send SIGTERM");
        return StopSignalStatus::SignalFailed;
    }

    StopSignalStatus::Sent
}

#[cfg(not(unix))]
fn signal_stop(_pid: i32, _issue_id: &str) -> StopSignalStatus {
    StopSignalStatus::SignalFailed
}

fn issue_error_response(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (status, api_error(code, message)).into_response()
}

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

/// Response for a successful resume operation.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ResumeResponse {
    pub resumed: bool,
    pub issue_identifier: String,
    pub message: String,
}

fn interaction_store(state: &AppState) -> InteractionStore {
    let config_dir = state
        .config_runtime
        .config_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    InteractionStore::new(config_dir)
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

    let issue_id = match find_issue_presence(&lock, &identifier) {
        IssuePresence::Running(id) => id,
        IssuePresence::Retrying(_) => {
            return issue_error_response(
                StatusCode::CONFLICT,
                "not_running",
                format!(
                    "issue '{}' is retrying, not running — use retry endpoint instead",
                    identifier
                ),
            );
        }
        IssuePresence::Missing => {
            return issue_error_response(
                StatusCode::NOT_FOUND,
                "issue_not_found",
                format!(
                    "no running or retrying issue with identifier '{}'",
                    identifier
                ),
            );
        }
    };

    match try_signal_stop(&lock, &issue_id) {
        StopSignalStatus::Sent => {}
        StopSignalStatus::MissingPid => {
            return issue_error_response(
                StatusCode::CONFLICT,
                "stop_unavailable",
                format!("issue '{}' has no active agent PID to stop", identifier),
            );
        }
        StopSignalStatus::InvalidPid => {
            return issue_error_response(
                StatusCode::CONFLICT,
                "stop_unavailable",
                format!(
                    "issue '{}' has an invalid agent PID and could not be stopped",
                    identifier
                ),
            );
        }
        StopSignalStatus::SignalFailed => {
            return issue_error_response(
                StatusCode::CONFLICT,
                "stop_failed",
                format!("failed to stop running issue '{}'", identifier),
            );
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
        Json(StopResponse {
            stopped: true,
            issue_identifier: identifier,
            message: "agent stopped and issue released".to_string(),
        }),
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

    let issue_id = match find_issue_presence(&lock, &identifier) {
        IssuePresence::Retrying(id) => id,
        IssuePresence::Running(_) => {
            return issue_error_response(
                StatusCode::CONFLICT,
                "not_retrying",
                format!(
                    "issue '{}' is currently running — use stop endpoint to interrupt",
                    identifier
                ),
            );
        }
        IssuePresence::Missing => {
            return issue_error_response(
                StatusCode::NOT_FOUND,
                "issue_not_found",
                format!(
                    "no running or retrying issue with identifier '{}'",
                    identifier
                ),
            );
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
        Json(RetryResponse {
            retried: true,
            issue_identifier: identifier,
            message: "removed from retry queue, will be re-dispatched on next poll".to_string(),
        }),
    )
        .into_response()
}

/// POST /api/v1/issues/{identifier}/resume
///
/// Releases a blocked issue after a human interaction has been resolved so the next poll can
/// requeue it. Returns 404 if the issue is unknown, 409 if the issue is not resumable.
#[utoipa::path(
    post,
    path = "/api/v1/issues/{identifier}/resume",
    operation_id = "postResumeIssue",
    params(("identifier" = String, Path, description = "Issue identifier")),
    responses(
        (status = 200, description = "Issue resume queued", body = ResumeResponse),
        (status = 404, description = "Issue not found", body = ApiError),
        (status = 409, description = "Issue cannot be resumed", body = ApiError)
    ),
    tag = "controls"
)]
pub async fn post_resume(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    let (waiting_entry, issue_exists) = {
        let lock = state.orchestrator_state.read().await;
        let waiting_entry = lock
            .waiting_on_human
            .values()
            .find(|entry| entry.identifier == identifier)
            .cloned();
        let issue_exists = waiting_entry.is_some()
            || lock
                .running
                .values()
                .any(|entry| entry.identifier == identifier)
            || lock
                .retry_attempts
                .values()
                .any(|entry| entry.identifier == identifier);
        (waiting_entry, issue_exists)
    };

    let waiting_entry = match waiting_entry {
        Some(entry) => entry,
        None => {
            let (status, code, message) = if issue_exists {
                (
                    StatusCode::CONFLICT,
                    "invalid_resume_state",
                    format!("issue '{identifier}' is not waiting on human input"),
                )
            } else {
                (
                    StatusCode::NOT_FOUND,
                    "issue_not_found",
                    format!("no issue with identifier '{identifier}'"),
                )
            };
            return (
                status,
                Json(serde_json::to_value(ApiError::new(code, &message)).unwrap()),
            )
                .into_response();
        }
    };

    let store = interaction_store(&state);
    let interaction = match store.get(&waiting_entry.interaction_request_id).await {
        Ok(Some(interaction)) => interaction,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(
                    serde_json::to_value(ApiError::new(
                        "interaction_not_found",
                        &format!(
                            "interaction not found: {}",
                            waiting_entry.interaction_request_id
                        ),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ApiError::new(
                        "interaction_store_error",
                        &error.to_string(),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    if interaction.status != InteractionStatus::Resolved {
        return (
            StatusCode::CONFLICT,
            Json(
                serde_json::to_value(ApiError::new(
                    "invalid_resume_state",
                    &format!(
                        "issue '{}' cannot be resumed until interaction '{}' is resolved",
                        identifier, interaction.id
                    ),
                ))
                .unwrap(),
            ),
        )
            .into_response();
    }

    if !interaction.awaiting_resume {
        return (
            StatusCode::CONFLICT,
            Json(
                serde_json::to_value(ApiError::new(
                    "already_resumed",
                    &format!("issue '{identifier}' has already been resumed"),
                ))
                .unwrap(),
            ),
        )
            .into_response();
    }

    {
        let mut lock = state.orchestrator_state.write().await;
        lock.queue_resume(&waiting_entry.issue_id);
    }

    state.refresh_requested.notify_one();

    (
        StatusCode::OK,
        Json(
            serde_json::to_value(ResumeResponse {
                resumed: true,
                issue_identifier: identifier,
                message: "issue queued for resume on next refresh".to_string(),
            })
            .unwrap(),
        ),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::AppState;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::config::ensemble::StepConfig;
    use crate::orchestrator::state::OrchestratorState;
    use crate::pipeline::dag::build_dag;
    use crate::pipeline::engine::PipelineRun;
    use crate::tracker::model::{Issue, RetryEntry};
    use axum::body::to_bytes;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[test]
    fn find_issue_presence_reports_running_retrying_and_missing() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue(), None);
        state.add_retry(RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 2,
            due_at_ms: 999999,
            error: Some("timeout".to_string()),
        });

        match find_issue_presence(&state, "my-repo#42") {
            IssuePresence::Running(issue_id) => assert_eq!(issue_id, "NODE_123"),
            other => panic!("expected running issue, got {other:?}"),
        }

        match find_issue_presence(&state, "my-repo#99") {
            IssuePresence::Retrying(issue_id) => assert_eq!(issue_id, "NODE_456"),
            other => panic!("expected retrying issue, got {other:?}"),
        }

        assert!(matches!(
            find_issue_presence(&state, "missing#1"),
            IssuePresence::Missing
        ));
    }

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
        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.orchestrator_state = Arc::new(RwLock::new(state));
        app_state
    }

    #[cfg(unix)]
    fn spawn_sleep_process() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap()
    }

    fn test_pipeline_run() -> PipelineRun {
        let dag = build_dag(&[StepConfig {
            name: "build".to_string(),
            agent: "build".to_string(),
            depends: None,
            tracker_state: None,
        }])
        .unwrap();

        PipelineRun::new("NODE_123".to_string(), 1, dag)
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn build_app_state_with_running_pid(agent_pid: Option<&str>) -> AppState {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue(), None);
        state.update_session_info("NODE_123", "session-123", agent_pid);

        let document_state = parsed_document_state();
        let active_config = document_state.active_config.clone().unwrap();

        state.insert_pipeline_run("NODE_123", test_pipeline_run(), Arc::new(active_config));

        let mut app_state = app_state_with_document_state(document_state);
        app_state.orchestrator_state = Arc::new(RwLock::new(state));
        app_state
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

        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.orchestrator_state = Arc::new(RwLock::new(state));
        app_state
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_stop_running_issue() {
        use std::time::Duration;

        let mut child = spawn_sleep_process();
        let state = build_app_state_with_running();
        {
            let mut lock = state.orchestrator_state.write().await;
            lock.update_session_info("NODE_123", "session-123", Some(&child.id().to_string()));
        }

        let response = post_stop(State(state.clone()), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        // Verify issue is no longer running
        let lock = state.orchestrator_state.read().await;
        assert!(lock.running.is_empty());
        assert!(!lock.is_claimed("NODE_123"));

        for _ in 0..20 {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let _ = child.kill();
        panic!("child process did not exit after SIGTERM");
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
    async fn test_stop_running_issue_without_pid_returns_conflict_and_keeps_state() {
        let state = build_app_state_with_running_pid(None);
        let response = post_stop(State(state.clone()), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let lock = state.orchestrator_state.read().await;
        assert!(lock.running.contains_key("NODE_123"));
        assert!(lock.is_claimed("NODE_123"));
    }

    #[tokio::test]
    async fn test_stop_running_issue_with_invalid_pid_returns_conflict_and_keeps_state() {
        let state = build_app_state_with_running_pid(Some("not-a-pid"));
        let response = post_stop(State(state.clone()), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "stop_unavailable");
        assert_eq!(
            body["error"]["message"],
            "issue 'my-repo#42' has an invalid agent PID and could not be stopped"
        );

        let lock = state.orchestrator_state.read().await;
        assert!(lock.running.contains_key("NODE_123"));
        assert!(lock.is_claimed("NODE_123"));
        assert!(lock.get_pipeline_run("NODE_123").is_some());
    }

    #[tokio::test]
    async fn test_stop_running_issue_when_sigterm_fails_returns_conflict_and_keeps_state() {
        let state = build_app_state_with_running_pid(Some("999999"));
        let response = post_stop(State(state.clone()), Path("my-repo#42".to_string())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let lock = state.orchestrator_state.read().await;
        assert!(lock.running.contains_key("NODE_123"));
        assert!(lock.is_claimed("NODE_123"));
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
