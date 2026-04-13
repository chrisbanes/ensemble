use crate::api::router::AppState;
use crate::history_store::store::HistoryStore;
use crate::timeline::reader::{TimelineQuery, TimelineResponse};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;

fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// GET /api/v1/{identifier}/timeline
///
/// Returns paginated timeline events for a run.
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/timeline",
    operation_id = "getTimeline",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        TimelineQuery,
    ),
    responses(
        (status = 200, description = "Timeline events", body = TimelineResponse),
        (status = 500, description = "Read error", body = crate::api::handlers::ApiError)
    ),
    tag = "history"
)]
pub async fn get_timeline(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Query(query): Query<TimelineQuery>,
) -> impl IntoResponse {
    if !is_safe_run_id(&query.run_id) {
        return (
            StatusCode::BAD_REQUEST,
            crate::api::handlers::api_error(
                "invalid_run_id",
                "run_id contains unsupported characters".to_string(),
            ),
        )
            .into_response();
    }

    let store = match HistoryStore::new(state.history_db_path.clone()).await {
        Ok(store) => store,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                crate::api::handlers::api_error(
                    "timeline_store_error",
                    format!("failed to open history store: {}", e),
                ),
            )
                .into_response();
        }
    };

    match store.read_timeline(&query, Some(&identifier)).await {
        Ok(response) => (StatusCode::OK, axum::Json(response)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            crate::api::handlers::api_error(
                "timeline_read_error",
                format!("failed to read timeline: {}", e),
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::timeline::model::TimelineEventRecord;
    use chrono::Utc;

    fn build_app_state(workspace_root: String) -> AppState {
        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.workspace_root = workspace_root;
        app_state.history_db_path = std::path::PathBuf::from(&app_state.workspace_root)
            .join(".ensemble")
            .join("history.db");
        app_state
    }

    fn sample_event(run_id: &str, sequence: u64) -> TimelineEventRecord {
        TimelineEventRecord {
            run_id: run_id.to_string(),
            issue_identifier: "repo#1".to_string(),
            sequence,
            timestamp: Utc::now(),
            event_type: "step_started".to_string(),
            step_name: Some("build".to_string()),
            attempt: 1,
            detail: "started build".to_string(),
            verdict: None,
            tool_name: None,
        }
    }

    #[tokio::test]
    async fn get_timeline_returns_empty_when_file_missing() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let state = build_app_state(temp_dir.path().to_string_lossy().to_string());
        let response = get_timeline(
            State(state),
            Path("repo#1".to_string()),
            Query(TimelineQuery {
                run_id: "run-missing".to_string(),
                cursor: None,
                limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_timeline_returns_paginated_events_for_run_id() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let state = build_app_state(temp_dir.path().to_string_lossy().to_string());
        let store = HistoryStore::new(state.history_db_path.clone())
            .await
            .unwrap();
        store
            .append_timeline_event(&sample_event("run-abc", 1))
            .await
            .unwrap();
        store
            .append_timeline_event(&sample_event("run-abc", 2))
            .await
            .unwrap();

        let response = get_timeline(
            State(state),
            Path("repo#1".to_string()),
            Query(TimelineQuery {
                run_id: "run-abc".to_string(),
                cursor: Some(0),
                limit: Some(1),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_timeline_rejects_unsafe_run_id() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let state = build_app_state(temp_dir.path().to_string_lossy().to_string());
        let response = get_timeline(
            State(state),
            Path("repo#1".to_string()),
            Query(TimelineQuery {
                run_id: "../etc/passwd".to_string(),
                cursor: None,
                limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn get_timeline_scopes_results_to_path_identifier() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let state = build_app_state(temp_dir.path().to_string_lossy().to_string());
        let store = HistoryStore::new(state.history_db_path.clone())
            .await
            .unwrap();
        let mut wrong_issue = sample_event("run-abc", 1);
        wrong_issue.issue_identifier = "repo#other".to_string();
        store.append_timeline_event(&wrong_issue).await.unwrap();

        let response = get_timeline(
            State(state),
            Path("repo#1".to_string()),
            Query(TimelineQuery {
                run_id: "run-abc".to_string(),
                cursor: Some(0),
                limit: Some(10),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
