use crate::api::router::AppState;
use crate::config::draft::ConfigDocumentState;
use crate::config::ensemble::{EnsembleConfig, StepKind};
use crate::history::artifacts::StepTranscriptArtifact;
use crate::history::model::HistoryRecord;
use crate::interaction::store::InteractionStore;
use crate::observability::snapshot::{
    build_issue_snapshot, build_state_snapshot, enrich_issue_snapshot_pending_input,
    extract_step_detail_state, AttemptInfo, FinalizeSnapshot, IssueDetailSnapshot, IssueSummary,
    RepoFinalizeSnapshot, RetryRow, RunningDetail, RuntimeSnapshot, StepDetailSnapshot,
    WorkflowStepInfo, WorkspaceInfo,
};
use crate::workspace::key::issue_workspace_key;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path as FsPath;
use std::sync::Arc;
use tokio::sync::RwLock;

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
    let config_dir = state
        .config_runtime
        .config_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let interaction_store = InteractionStore::new(config_dir);

    let mut live_detail = {
        let lock = state.orchestrator_state.read().await;
        build_issue_snapshot(&lock, &identifier, &state.workspace_root, None).await
    };

    if let Some(detail) = live_detail.as_mut() {
        enrich_issue_snapshot_pending_input(detail, &interaction_store).await;
    }

    if let Some(detail) = live_detail {
        return (StatusCode::OK, Json(detail)).into_response();
    }

    let detail = match build_issue_snapshot_from_history(
        &state.history_path,
        &state.workspace_root,
        &identifier,
        step_kind_lookup(&state.config_runtime.document_state).await,
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

/// Build a name → step kind map from the active config so that
/// history-recovered snapshots can show the right step kind even though
/// `HistoryRecord.steps_traversed` only carries step names. Missing steps
/// default to `StepKind::Agent` at the call site.
async fn step_kind_lookup(
    document_state: &Arc<RwLock<ConfigDocumentState>>,
) -> HashMap<String, StepKind> {
    let guard = document_state.read().await;
    step_kinds_from_config(guard.active_config.as_ref())
}

fn step_kinds_from_config(config: Option<&EnsembleConfig>) -> HashMap<String, StepKind> {
    let mut map = HashMap::new();
    if let Some(config) = config {
        for step in &config.steps {
            map.insert(step.name.clone(), step.kind);
        }
    }
    map
}

async fn build_issue_snapshot_from_history(
    history_path: &FsPath,
    workspace_root: &str,
    identifier: &str,
    step_kinds: HashMap<String, StepKind>,
) -> Result<Option<IssueDetailSnapshot>, std::io::Error> {
    let Some(record) = latest_history_record(history_path, identifier).await? else {
        return Ok(None);
    };

    Ok(issue_snapshot_from_history_record(
        &record,
        workspace_root,
        step_kinds,
    ))
}

async fn latest_history_record(
    history_path: &FsPath,
    identifier: &str,
) -> Result<Option<HistoryRecord>, std::io::Error> {
    let contents = match tokio::fs::read_to_string(history_path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    Ok(contents.lines().rev().find_map(|line| {
        serde_json::from_str::<HistoryRecord>(line)
            .ok()
            .filter(|entry| entry.issue_identifier == identifier)
    }))
}

fn issue_snapshot_from_history_record(
    record: &HistoryRecord,
    workspace_root: &str,
    step_kinds: HashMap<String, StepKind>,
) -> Option<IssueDetailSnapshot> {
    let status = match record.outcome.as_str() {
        "succeeded" => "completed_succeeded".to_string(),
        "failed" => "completed_failed".to_string(),
        "stopped" => "completed_stopped".to_string(),
        other => format!("completed_{other}"),
    };

    let workspace_path = if record.workspace_path.is_empty() {
        let key = issue_workspace_key(&record.issue_id);
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
                kind: step_kinds
                    .get(name)
                    .copied()
                    .unwrap_or(StepKind::Agent)
                    .to_string(),
                dependencies: vec![],
                state: if record.outcome == "failed" && idx == last_idx {
                    "failed".to_string()
                } else {
                    "passed".to_string()
                },
                can_navigate: true,
            })
            .collect()
    };
    let artifacts = record.artifacts.clone();

    Some(IssueDetailSnapshot {
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
        artifacts,
        acceptance_attempts: record.acceptance_attempts.clone(),
    })
}

async fn build_step_detail_from_history(
    history_path: &FsPath,
    history_store: Option<&crate::history_store::store::HistoryStore>,
    workspace_root: &str,
    identifier: &str,
    step_name: &str,
    step_kinds: HashMap<String, StepKind>,
) -> Result<Option<StepDetailSnapshot>, std::io::Error> {
    let Some(record) = latest_history_record(history_path, identifier).await? else {
        return Ok(None);
    };

    let step_idx = record
        .steps_traversed
        .iter()
        .position(|name| name == step_name);
    let transcript = record
        .artifacts
        .as_ref()
        .and_then(|artifacts| {
            artifacts
                .transcripts
                .iter()
                .find(|artifact| artifact.step_name == step_name)
        })
        .cloned();

    if step_idx.is_none() && transcript.is_none() {
        return Ok(None);
    }

    let run_id = transcript
        .as_ref()
        .map(|artifact| artifact.run_id.clone())
        .or_else(|| {
            record
                .artifacts
                .as_ref()
                .map(|artifacts| artifacts.run_id.clone())
        });
    let recent_events = if let Some(run_id) = run_id.as_deref() {
        read_recent_step_events(history_store, run_id, identifier, step_name).await
    } else {
        Vec::new()
    };
    let transcript = if let Some(transcript) = transcript {
        Some(transcript)
    } else if let Some(run_id) = run_id.as_deref() {
        read_transcript_metadata(workspace_root, run_id, step_name).await
    } else {
        None
    };

    let last_idx = record.steps_traversed.len().saturating_sub(1);
    let status = match record.outcome.as_str() {
        "failed" if step_idx == Some(last_idx) => "failed",
        "stopped" if step_idx == Some(last_idx) => "stopped",
        _ => "passed",
    }
    .to_string();

    Ok(Some(StepDetailSnapshot {
        issue_identifier: record.issue_identifier,
        issue_id: record.issue_id,
        step_name: step_name.to_string(),
        status,
        agent: "unknown".to_string(),
        kind: step_kinds
            .get(step_name)
            .copied()
            .unwrap_or(StepKind::Agent)
            .to_string(),
        dependencies: Vec::new(),
        can_navigate: true,
        verdict: if step_idx == Some(last_idx) {
            record.verdict
        } else {
            None
        },
        run_id,
        transcript,
        recent_events,
    }))
}

async fn read_recent_step_events(
    history_store: Option<&crate::history_store::store::HistoryStore>,
    run_id: &str,
    identifier: &str,
    step_name: &str,
) -> Vec<crate::timeline::model::TimelineEventRecord> {
    let Some(history_store) = history_store else {
        return Vec::new();
    };
    history_store
        .read_recent_step_events(run_id, identifier, step_name, 50)
        .await
        .unwrap_or_default()
}

async fn read_transcript_metadata(
    workspace_root: &str,
    run_id: &str,
    step_name: &str,
) -> Option<StepTranscriptArtifact> {
    match crate::transcript::reader::read_transcript_page(
        FsPath::new(workspace_root),
        run_id,
        step_name,
        None,
        Some(1),
    )
    .await
    {
        Ok(response) if response.total > 0 => Some(StepTranscriptArtifact {
            step_name: step_name.to_string(),
            run_id: run_id.to_string(),
            record_count: response.total,
        }),
        _ => None,
    }
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
        return match build_step_detail_from_history(
            &state.history_path,
            state.history_store.as_ref(),
            &state.workspace_root,
            &identifier,
            &step_name,
            step_kind_lookup(&state.config_runtime.document_state).await,
        )
        .await
        {
            Ok(Some(detail)) => (StatusCode::OK, Json(detail)).into_response(),
            Ok(None) => {
                let error = ApiError::new(
                    "step_not_found",
                    &format!("no issue '{}' or step '{}' found", identifier, step_name),
                );
                (StatusCode::NOT_FOUND, Json(error)).into_response()
            }
            Err(error) => {
                let error = ApiError::new(
                    "history_read_error",
                    &format!("failed to read history: {}", error),
                );
                (StatusCode::INTERNAL_SERVER_ERROR, Json(error)).into_response()
            }
        };
    };

    // Do I/O outside the state lock.
    let recent_events = if let Some(ref run_id) = detail_state.run_id {
        read_recent_step_events(
            state.history_store.as_ref(),
            run_id,
            &identifier,
            &step_name,
        )
        .await
    } else {
        vec![]
    };

    let transcript = if let Some(ref run_id) = detail_state.run_id {
        read_transcript_metadata(&state.workspace_root, run_id, &step_name).await
    } else {
        None
    };

    let detail = StepDetailSnapshot {
        issue_identifier: identifier,
        issue_id: detail_state.issue_id,
        step_name,
        status: detail_state.status,
        agent: detail_state.agent,
        kind: detail_state.kind,
        dependencies: detail_state.dependencies,
        can_navigate: detail_state.can_navigate,
        verdict: detail_state.verdict,
        run_id: detail_state.run_id,
        transcript,
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
    use crate::acceptance::{
        AcceptanceAttempt, AcceptanceEvidence, AcceptanceOutput, AcceptanceResult,
        AcceptanceStatus, AcceptanceTiming, FileObservation, HandoffOutputObservation,
        HandoffSectionEvidence, HandoffSectionObservation, JsonValueKind, PullRequestDeliveryPhase,
    };
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::config::ensemble::ConcurrencyConfig;
    use crate::history::model::{HistoryRecord, TokenTotals};
    use crate::history::writer::HistoryWriter;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{Issue, RetryEntry, RunningEntry};
    use chrono::{TimeZone, Utc};
    use tempfile::NamedTempFile;

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            tracker_position: None,
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
            retry_from_step: None,
            with_fixup: false,
        }
    }

    fn persisted_acceptance_attempts() -> Vec<AcceptanceAttempt> {
        let timing = AcceptanceTiming::Observed {
            started_at: Utc.with_ymd_and_hms(2026, 8, 4, 9, 0, 0).single().unwrap(),
            completed_at: Utc.with_ymd_and_hms(2026, 8, 4, 9, 0, 1).single().unwrap(),
            duration_ms: 1_000,
        };
        let mut command = AcceptanceResult::new(
            "unit tests".to_string(),
            AcceptanceStatus::Passed,
            "tests passed".to_string(),
            AcceptanceEvidence::Command {
                exit_code: Some(0),
                stdout: AcceptanceOutput {
                    tail: "tests passed".to_string(),
                    total_bytes: 12,
                    truncated: false,
                },
                stderr: AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
            },
        );
        command.timing = timing.clone();
        let mut release_notes = AcceptanceResult::new(
            "release notes".to_string(),
            AcceptanceStatus::Failed,
            "release notes are missing".to_string(),
            AcceptanceEvidence::File {
                repo: "ensemble".to_string(),
                path: "docs/release.md".to_string(),
                observation: FileObservation::Missing,
            },
        );
        release_notes.timing = timing.clone();
        let mut handoff = AcceptanceResult::new(
            "handoff".to_string(),
            AcceptanceStatus::TimedOut,
            "handoff inspection timed out".to_string(),
            AcceptanceEvidence::Handoff {
                step: "review".to_string(),
                output: HandoffOutputObservation::NonObject {
                    value_kind: JsonValueKind::String,
                },
                sections: vec![HandoffSectionEvidence {
                    name: "summary".to_string(),
                    observation: HandoffSectionObservation::Missing,
                }],
            },
        );
        handoff.timing = timing.clone();
        let mut pull_request = AcceptanceResult::new(
            "pull request".to_string(),
            AcceptanceStatus::Unavailable,
            "pull request delivery is unavailable".to_string(),
            AcceptanceEvidence::PullRequest {
                repo: "chrisbanes/ensemble".to_string(),
                delivery_phase: PullRequestDeliveryPhase::Blocked,
                base_branch: Some("main".to_string()),
                head_branch: Some("feature/acceptance".to_string()),
                head_sha: Some("abc123".to_string()),
                pr_number: Some(419),
                pr_url: Some("https://github.com/chrisbanes/ensemble/pull/419".to_string()),
            },
        );
        pull_request.timing = timing;

        vec![
            AcceptanceAttempt {
                cycle: 1,
                results: vec![command, release_notes],
            },
            AcceptanceAttempt {
                cycle: 2,
                results: vec![handoff, pull_request],
            },
        ]
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
                acceptance_attempts: vec![],
                artifacts: None,
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path("todo-0".to_string()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn history_backed_issue_detail_projects_persisted_acceptance_attempts_verbatim() {
        let mut app_state = build_empty_state();
        let tmp = NamedTempFile::new().unwrap();
        let history_path = tmp.path().to_path_buf();
        std::fs::remove_file(&history_path).ok();
        app_state.history_path = history_path.clone();
        let acceptance_attempts = persisted_acceptance_attempts();

        HistoryWriter::new(history_path)
            .append(&HistoryRecord {
                issue_identifier: "history#419".to_string(),
                issue_id: "NODE_419".to_string(),
                outcome: "failed".to_string(),
                steps_traversed: vec!["build".to_string()],
                attempts: 2,
                tokens: TokenTotals {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                },
                duration_seconds: 42,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: None,
                verdict: Some("failed".to_string()),
                workspace_path: "/tmp/workspaces/history-419".to_string(),
                acceptance_attempts: acceptance_attempts.clone(),
                artifacts: None,
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path("history#419".to_string()))
            .await
            .into_response();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(
            detail["acceptance_attempts"],
            serde_json::to_value(acceptance_attempts).unwrap()
        );
    }

    #[tokio::test]
    async fn history_backed_issue_detail_preserves_an_empty_acceptance_attempt_sequence() {
        let mut app_state = build_empty_state();
        let tmp = NamedTempFile::new().unwrap();
        let history_path = tmp.path().to_path_buf();
        std::fs::remove_file(&history_path).ok();
        app_state.history_path = history_path.clone();

        HistoryWriter::new(history_path)
            .append(&HistoryRecord {
                issue_identifier: "history#empty".to_string(),
                issue_id: "NODE_EMPTY".to_string(),
                outcome: "succeeded".to_string(),
                steps_traversed: vec![],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                },
                duration_seconds: 0,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: None,
                verdict: None,
                workspace_path: String::new(),
                acceptance_attempts: vec![],
                artifacts: None,
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path("history#empty".to_string()))
            .await
            .into_response();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(detail["acceptance_attempts"], serde_json::json!([]));
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
    async fn workspace_identity_path_history_fallback_uses_record_identity() {
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
                acceptance_attempts: vec![],
                artifacts: None,
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path(".".to_string()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let path = json["workspace"]["path"].as_str().unwrap();
        assert!(path.ends_with(&issue_workspace_key("dot")));
    }

    #[tokio::test]
    async fn test_get_issue_detail_history_fallback_recovers_step_kind_from_active_config() {
        use crate::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
        use crate::config::ensemble::parse_config;
        use std::path::PathBuf;

        let config_yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: test
    model: test
    prompt: build
  synth:
    executor: test
    model: test
    prompt: merge
steps:
  - name: build
    agent: build
  - name: review-a
    agent: build
    depends: [build]
  - name: review-b
    agent: build
    depends: [build]
  - name: synthesize
    kind: synthesis
    agent: synth
    depends: [review-a, review-b]
on_success: Done
on_failure: Failed
"#;
        let document_state = ConfigDocumentState {
            path: PathBuf::from("ensemble.yaml"),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(parse_config(config_yaml).unwrap()),
            validation: DraftValidationReport::default(),
        };
        let mut app_state = app_state_with_document_state(document_state);

        let tmp = NamedTempFile::new().unwrap();
        let history_path = tmp.path().to_path_buf();
        std::fs::remove_file(&history_path).ok();
        app_state.history_path = history_path.clone();

        let writer = HistoryWriter::new(history_path);
        writer
            .append(&HistoryRecord {
                issue_identifier: "synth-1".to_string(),
                issue_id: "synth-1".to_string(),
                outcome: "succeeded".to_string(),
                steps_traversed: vec![
                    "build".to_string(),
                    "review-a".to_string(),
                    "review-b".to_string(),
                    "synthesize".to_string(),
                ],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                duration_seconds: 42,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: None,
                verdict: Some("approved".to_string()),
                workspace_path: "/tmp/workspaces/synth-1".to_string(),
                acceptance_attempts: vec![],
                artifacts: None,
            })
            .await
            .unwrap();

        let response = get_issue_detail(State(app_state), Path("synth-1".to_string()))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let steps = json["workflow_steps"].as_array().expect("workflow_steps");
        let kinds: HashMap<String, String> = steps
            .iter()
            .map(|step| {
                (
                    step["name"].as_str().unwrap().to_string(),
                    step["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(kinds.get("build").map(String::as_str), Some("agent"));
        assert_eq!(kinds.get("review-a").map(String::as_str), Some("agent"));
        assert_eq!(
            kinds.get("synthesize").map(String::as_str),
            Some("synthesis")
        );
    }

    #[tokio::test]
    async fn history_backed_issue_detail_includes_artifacts_and_navigable_steps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let history_path = tmp.path().join("ensemble_history.jsonl");
        let writer = HistoryWriter::new(history_path.clone());
        writer
            .append(&HistoryRecord {
                issue_identifier: "repo#77".into(),
                issue_id: "NODE_77".into(),
                outcome: "succeeded".into(),
                steps_traversed: vec!["build".into()],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 1,
                    output_tokens: 2,
                    total_tokens: 3,
                },
                duration_seconds: 10,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: None,
                verdict: Some("approved".into()),
                workspace_path: tmp.path().join("repo-77").display().to_string(),
                acceptance_attempts: vec![],
                artifacts: Some(crate::history::artifacts::RunArtifacts {
                    run_id: "run-77".into(),
                    workspace_path: tmp.path().join("repo-77").display().to_string(),
                    repos: Vec::new(),
                    transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                        step_name: "build".into(),
                        run_id: "run-77".into(),
                        record_count: 5,
                    }],
                }),
            })
            .await
            .unwrap();

        let mut app_state = build_empty_state();
        app_state.history_path = history_path;
        app_state.workspace_root = tmp.path().display().to_string();

        let response = get_issue_detail(State(app_state), Path("repo#77".to_string())).await;
        let body = axum::body::to_bytes(response.into_response().into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(detail["artifacts"]["run_id"].as_str(), Some("run-77"));
        assert_eq!(detail["workflow_steps"][0]["can_navigate"], true);
    }

    #[tokio::test]
    async fn history_backed_step_detail_resolves_transcript_metadata() {
        let tmp = tempfile::TempDir::new().unwrap();
        let history_path = tmp.path().join("ensemble_history.jsonl");
        let writer = HistoryWriter::new(history_path.clone());
        writer
            .append(&HistoryRecord {
                issue_identifier: "repo#77".into(),
                issue_id: "NODE_77".into(),
                outcome: "succeeded".into(),
                steps_traversed: vec!["build".into()],
                attempts: 1,
                tokens: TokenTotals {
                    input_tokens: 1,
                    output_tokens: 2,
                    total_tokens: 3,
                },
                duration_seconds: 10,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                last_error: None,
                verdict: Some("approved".into()),
                workspace_path: tmp.path().join("repo-77").display().to_string(),
                acceptance_attempts: vec![],
                artifacts: Some(crate::history::artifacts::RunArtifacts {
                    run_id: "run-77".into(),
                    workspace_path: tmp.path().join("repo-77").display().to_string(),
                    repos: Vec::new(),
                    transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                        step_name: "build".into(),
                        run_id: "run-77".into(),
                        record_count: 5,
                    }],
                }),
            })
            .await
            .unwrap();

        let mut app_state = build_empty_state();
        app_state.history_path = history_path;
        app_state.workspace_root = tmp.path().display().to_string();

        let response = get_step_detail(
            State(app_state),
            Path(("repo#77".to_string(), "build".to_string())),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(detail["run_id"].as_str(), Some("run-77"));
        assert_eq!(detail["transcript"]["record_count"].as_u64(), Some(5));
        assert_eq!(detail["can_navigate"], true);
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
