use crate::api::router::AppState;
use crate::history::model::HistoryRecord;
use crate::observability::snapshot::{
    build_issue_snapshot, build_state_snapshot, extract_step_detail_state, AttemptInfo,
    FinalizeSnapshot, IssueDetailSnapshot, IssueSummary, RepoFinalizeSnapshot, RetryRow,
    RunningDetail, RuntimeSnapshot, StepDetailSnapshot, WorkflowStepInfo, WorkspaceInfo,
};
use crate::tracker::model::sanitize_workspace_key;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::Path as FsPath;

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

pub(crate) fn api_error(code: &str, message: impl Into<String>) -> Json<ApiError> {
    let message = message.into();
    Json(ApiError::new(code, &message))
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
    let live_detail = {
        let lock = state.orchestrator_state.read().await;
        build_issue_snapshot(&lock, &identifier, &state.workspace_root)
    };

    if let Some(detail) = live_detail {
        return (StatusCode::OK, Json(detail)).into_response();
    }

    let detail = match build_issue_snapshot_from_history(
        &state.history_path,
        &state.workspace_root,
        &identifier,
    )
    .await
    {
        Ok(detail) => detail,
        Err(error) => {
            let error = ApiError::new(
                "history_read_error",
                &format!("failed to read history: {}", error),
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(error)).into_response();
        }
    };

    match detail {
        Some(detail) => (StatusCode::OK, Json(detail)).into_response(),
        None => {
            let error = ApiError::new(
                "issue_not_found",
                &format!(
                    "no running, waiting, or retrying issue with identifier '{}'",
                    identifier
                ),
            );
            (StatusCode::NOT_FOUND, Json(error)).into_response()
        }
    }
}

async fn build_issue_snapshot_from_history(
    history_path: &FsPath,
    workspace_root: &str,
    identifier: &str,
) -> Result<Option<IssueDetailSnapshot>, std::io::Error> {
    let contents = match tokio::fs::read_to_string(history_path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    let record = contents.lines().rev().find_map(|line| {
        serde_json::from_str::<HistoryRecord>(line)
            .ok()
            .filter(|entry| entry.issue_identifier == identifier)
    });
    let Some(record) = record else {
        return Ok(None);
    };

    let status = match record.outcome.as_str() {
        "succeeded" => "completed_succeeded".to_string(),
        "failed" => "completed_failed".to_string(),
        "stopped" => "completed_stopped".to_string(),
        other => format!("completed_{other}"),
    };

    let workspace_path = if record.workspace_path.is_empty() {
        let key = sanitize_workspace_key(identifier);
        let Some(key) = key else {
            return Ok(None);
        };
        format!("{}/{}", workspace_root, key)
    } else {
        record.workspace_path.clone()
    };

    let workflow_steps: Vec<WorkflowStepInfo> = if record.steps_traversed.is_empty() {
        Vec::new()
    } else {
        let last_idx = record.steps_traversed.len().saturating_sub(1);
        record
            .steps_traversed
            .iter()
            .enumerate()
            .map(|(idx, name)| WorkflowStepInfo {
                name: name.clone(),
                agent: "unknown".to_string(),
                dependencies: vec![],
                state: if record.outcome == "failed" && idx == last_idx {
                    "failed".to_string()
                } else {
                    "passed".to_string()
                },
                can_navigate: false,
            })
            .collect()
    };

    Ok(Some(IssueDetailSnapshot {
        issue_identifier: record.issue_identifier.clone(),
        issue_id: record.issue_id.clone(),
        status,
        workspace: WorkspaceInfo {
            path: workspace_path,
        },
        attempts: AttemptInfo {
            restart_count: record.attempts.saturating_sub(1),
            current_retry_attempt: None,
        },
        running: Option::<RunningDetail>::None,
        retry: Option::<RetryRow>::None,
        pending_input: None,
        current_interaction: None,
        last_error: record.last_error.clone(),
        finalize: FinalizeSnapshot {
            status: "not_required".to_string(),
            repos: Vec::<RepoFinalizeSnapshot>::new(),
        },
        workflow_steps,
        issue: IssueSummary {
            title: record.issue_identifier.clone(),
            description: None,
            labels: vec![],
            priority: None,
            url: None,
        },
    }))
}

/// GET /api/v1/{identifier}/step/{step_name}
///
/// Returns step detail including recent events filtered to that step.
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/step/{step_name}",
    operation_id = "getStepDetail",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("step_name" = String, Path, description = "Step name")
    ),
    responses(
        (status = 200, description = "Step detail", body = StepDetailSnapshot),
        (status = 404, description = "Issue or step not found", body = ApiError)
    ),
    tag = "issues"
)]
pub async fn get_step_detail(
    State(state): State<AppState>,
    Path((identifier, step_name)): Path<(String, String)>,
) -> impl IntoResponse {
    // Extract data from state without doing I/O
    let detail_state = {
        let lock = state.orchestrator_state.read().await;
        extract_step_detail_state(&lock, &identifier, &step_name)
    };

    let Some(detail_state) = detail_state else {
        let error = ApiError::new(
            "step_not_found",
            &format!("no issue '{}' or step '{}' found", identifier, step_name),
        );
        return (StatusCode::NOT_FOUND, Json(error)).into_response();
    };

    // Do I/O outside the state lock using tokio::fs
    let recent_events = if let Some(ref run_id) = detail_state.run_id {
        let timeline_path = std::path::PathBuf::from(&state.workspace_root)
            .join(".ensemble")
            .join("runs")
            .join(run_id)
            .join("events.jsonl");
        tokio::fs::read_to_string(&timeline_path)
            .await
            .ok()
            .map(|contents| {
                contents
                    .lines()
                    .rev()
                    .filter_map(|line| {
                        serde_json::from_str::<crate::timeline::model::TimelineEventRecord>(line)
                            .ok()
                    })
                    .filter(|event| event.issue_identifier == identifier)
                    .filter(|event| event.step_name.as_deref() == Some(&step_name))
                    .take(50)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    let detail = StepDetailSnapshot {
        issue_identifier: identifier,
        issue_id: detail_state.issue_id,
        step_name,
        status: detail_state.status,
        agent: detail_state.agent,
        dependencies: detail_state.dependencies,
        can_navigate: detail_state.can_navigate,
        verdict: detail_state.verdict,
        recent_events,
    };

    (StatusCode::OK, Json(detail)).into_response()
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
pub async fn method_not_allowed() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        api_error(
            "method_not_allowed",
            "this HTTP method is not supported on this endpoint",
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::config::ensemble::ConcurrencyConfig;
    use crate::history::model::{HistoryRecord, TokenTotals};
    use crate::history::writer::HistoryWriter;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{Issue, RetryEntry, RunningEntry};
    use chrono::Utc;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

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
            run_id: Some("run-1".to_string()),
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
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
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

        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.orchestrator_state = Arc::new(tokio::sync::RwLock::new(state));
        app_state
    }

    fn build_empty_state() -> AppState {
        app_state_with_document_state(parsed_document_state())
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
    async fn test_get_issue_detail_not_found_message_mentions_waiting_issues() {
        let app_state = build_empty_state();
        let response = get_issue_detail(State(app_state), Path("nonexistent#999".to_string()))
            .await
            .into_response();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("running, waiting, or retrying"));
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
    async fn method_not_allowed_returns_json_api_error() {
        let (status, Json(body)) = method_not_allowed().await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body.error.code, "method_not_allowed");
    }

    #[test]
    fn api_error_helper_returns_json_api_error() {
        let Json(body) = api_error("issue_not_found", "no such issue");
        assert_eq!(body.error.code, "issue_not_found");
        assert_eq!(body.error.message, "no such issue");
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

    #[tokio::test]
    async fn test_get_issue_detail_falls_back_to_history_for_terminal_issue() {
        let mut app_state = build_empty_state();
        let tmp = NamedTempFile::new().unwrap();
        let history_path = tmp.path().to_path_buf();
        std::fs::remove_file(&history_path).ok();
        app_state.history_path = history_path.clone();

        let writer = HistoryWriter::new(history_path);
        writer
            .append(&HistoryRecord {
                issue_identifier: "todo-0".to_string(),
                issue_id: "todo-0".to_string(),
                outcome: "failed".to_string(),
                steps_traversed: vec!["build".to_string()],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                duration_seconds: 42,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: Some("agent crashed".to_string()),
                verdict: Some("failed".to_string()),
                workspace_path: "/tmp/workspaces/todo-0".to_string(),
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path("todo-0".to_string()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_get_issue_detail_history_read_error_returns_500() {
        let mut app_state = build_empty_state();
        let temp_dir = tempfile::tempdir().unwrap();
        app_state.history_path = temp_dir.path().to_path_buf();

        let response = get_issue_detail(State(app_state), Path("todo-0".to_string()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_get_issue_detail_history_fallback_rejects_unsafe_workspace_key() {
        let mut app_state = build_empty_state();
        let tmp = NamedTempFile::new().unwrap();
        let history_path = tmp.path().to_path_buf();
        std::fs::remove_file(&history_path).ok();
        app_state.history_path = history_path.clone();

        let writer = HistoryWriter::new(history_path);
        writer
            .append(&HistoryRecord {
                issue_identifier: ".".to_string(),
                issue_id: "dot".to_string(),
                outcome: "failed".to_string(),
                steps_traversed: vec!["build".to_string()],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                duration_seconds: 42,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: Some("agent crashed".to_string()),
                verdict: Some("failed".to_string()),
                workspace_path: String::new(),
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path(".".to_string()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_step_detail_not_found_no_issue() {
        let app_state = build_empty_state();
        let response = get_step_detail(
            State(app_state),
            Path(("nonexistent#999".to_string(), "build".to_string())),
        )
        .await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_step_detail_not_found_no_step() {
        let app_state = build_populated_state();
        let response = get_step_detail(
            State(app_state),
            Path(("my-repo#42".to_string(), "nonexistent-step".to_string())),
        )
        .await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
