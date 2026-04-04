use crate::api::router::AppState;
use crate::history::reader::{read_history, HistoryQuery, HistoryResponse};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

/// GET /api/v1/history
///
/// Returns paginated history records with optional filtering by outcome or step.
#[utoipa::path(
    get,
    path = "/api/v1/history",
    operation_id = "getHistory",
    params(HistoryQuery),
    responses(
        (status = 200, description = "History records", body = HistoryResponse),
        (status = 500, description = "Read error", body = crate::api::handlers::ApiError)
    ),
    tag = "history"
)]
pub async fn get_history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> impl IntoResponse {
    match read_history(&state.history_path, &query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            crate::api::handlers::api_error(
                "history_read_error",
                format!("failed to read history: {}", e),
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::history::model::{HistoryRecord, TokenTotals};
    use crate::history::writer::HistoryWriter;
    use chrono::Utc;
    use std::path::PathBuf;

    fn build_app_state(history_path: PathBuf) -> AppState {
        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.history_path = history_path;
        app_state
    }

    fn sample_record(identifier: &str) -> HistoryRecord {
        HistoryRecord {
            issue_identifier: identifier.into(),
            issue_id: format!("id-{}", identifier),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 1000,
                output_tokens: 500,
                total_tokens: 1500,
            },
            duration_seconds: 60,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: None,
            workspace_path: format!("/tmp/{}", identifier),
        }
    }

    #[tokio::test]
    async fn test_get_history_empty() {
        let state = build_app_state(PathBuf::from("/tmp/nonexistent_test_history.jsonl"));
        let response = get_history(State(state), Query(HistoryQuery::default())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_get_history_with_records() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();

        let writer = HistoryWriter::new(path.clone());
        writer.append(&sample_record("MT-1")).await.unwrap();
        writer.append(&sample_record("MT-2")).await.unwrap();

        let state = build_app_state(path);
        let response = get_history(State(state), Query(HistoryQuery::default())).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
