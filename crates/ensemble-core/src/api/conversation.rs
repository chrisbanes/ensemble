use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use crate::transcript::model::TranscriptRecord;
use crate::transcript::reader::{read_transcript_page, read_transcript_record, TranscriptResponse};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::path::Path as FsPath;

#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub struct ConversationQuery {
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation",
    operation_id = "getStepConversation",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("run_id" = String, Path, description = "Run id"),
        ("step_name" = String, Path, description = "Step name"),
        ConversationQuery,
    ),
    responses(
        (status = 200, description = "Step transcript records", body = TranscriptResponse),
        (status = 400, description = "Invalid path", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation(
    State(state): State<AppState>,
    Path((_identifier, run_id, step_name)): Path<(String, String, String)>,
    Query(query): Query<ConversationQuery>,
) -> impl IntoResponse {
    match read_transcript_page(
        FsPath::new(&state.workspace_root),
        &run_id,
        &step_name,
        query.cursor,
        query.limit,
    )
    .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::InvalidInput) =>
        {
            (
                StatusCode::BAD_REQUEST,
                api_error("invalid_path", "run id or step name is invalid"),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            api_error(
                "conversation_read_error",
                format!("failed to read transcript: {error}"),
            ),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}",
    operation_id = "getStepConversationRecord",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("run_id" = String, Path, description = "Run id"),
        ("step_name" = String, Path, description = "Step name"),
        ("sequence" = u64, Path, description = "Transcript sequence"),
    ),
    responses(
        (status = 200, description = "Transcript record", body = TranscriptRecord),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Record not found", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation_message(
    State(state): State<AppState>,
    Path((_identifier, run_id, step_name, sequence)): Path<(String, String, String, u64)>,
) -> impl IntoResponse {
    match read_transcript_record(
        FsPath::new(&state.workspace_root),
        &run_id,
        &step_name,
        sequence,
    )
    .await
    {
        Ok(Some(record)) => (StatusCode::OK, Json(record)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            api_error(
                "transcript_record_not_found",
                format!("no transcript record at sequence {sequence}"),
            ),
        )
            .into_response(),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::InvalidInput) =>
        {
            (
                StatusCode::BAD_REQUEST,
                api_error("invalid_path", "run id or step name is invalid"),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            api_error(
                "conversation_read_error",
                format!("failed to read transcript: {error}"),
            ),
        )
            .into_response(),
    }
}
