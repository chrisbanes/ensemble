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
        Err(e) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                crate::api::handlers::api_error(
                    "history_read_error",
                    format!("failed to read history: {}", e),
                ),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::{AppState, ConfigRuntime};
    use crate::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
    use crate::history::model::{HistoryRecord, TokenTotals};
    use crate::history::writer::HistoryWriter;
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use chrono::Utc;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn build_app_state(history_path: PathBuf) -> AppState {
        let config_path = PathBuf::from("ensemble.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: Some(crate::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
            validation: DraftValidationReport::default(),
        }));

        AppState {
            orchestrator_state: Arc::new(RwLock::new(OrchestratorState::new(30000, 10))),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path,
            event_bus: EventBus::new(),
            config_runtime: ConfigRuntime {
                config_path,
                document_state,
            },
        }
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
