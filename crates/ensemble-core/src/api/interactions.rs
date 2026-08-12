use crate::api::handlers::ApiError;
use crate::api::router::AppState;
use crate::attention::interaction::interaction_attention_close;
use crate::attention::AttentionReporter;
use crate::interaction::error::InteractionError;
use crate::interaction::model::{
    AcceptedInteractionCommand, InteractionKind, InteractionRequest, InteractionResponse,
    InteractionStatus,
};
use crate::interaction::store::{InteractionAcceptance, InteractionStore};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::warn;

static LOCAL_API_INPUT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct InteractionDetail {
    pub id: String,
    pub issue_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub agent_name: String,
    pub kind: InteractionKind,
    pub question: String,
    pub why_blocked: String,
    pub suggested_answer: Option<String>,
    pub extra_context: Option<String>,
    pub status: InteractionStatus,
    pub awaiting_resume: bool,
    pub requested_at: DateTime<Utc>,
}

impl From<&InteractionRequest> for InteractionDetail {
    fn from(req: &InteractionRequest) -> Self {
        InteractionDetail {
            id: req.id.clone(),
            issue_id: req.issue_id.clone(),
            issue_identifier: req.issue_identifier.clone(),
            step_name: req.step_name.clone(),
            agent_name: req.agent_name.clone(),
            kind: req.kind.clone(),
            question: req.title.clone(),
            why_blocked: req.body.clone(),
            suggested_answer: req.options.first().cloned(),
            extra_context: req.step_tracker_state.clone(),
            status: req.status.clone(),
            awaiting_resume: req.awaiting_resume,
            requested_at: req.requested_at,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractionResponseBody {
    Question {
        response_schema_version: u32,
        text: String,
        selected_option: Option<String>,
    },
    Approval {
        response_schema_version: u32,
        approved: bool,
        reason: Option<String>,
    },
    Handoff {
        response_schema_version: u32,
        completed: bool,
        notes: Option<String>,
    },
}

impl From<InteractionResponseBody> for InteractionResponse {
    fn from(value: InteractionResponseBody) -> Self {
        match value {
            InteractionResponseBody::Question {
                response_schema_version,
                text,
                selected_option,
            } => InteractionResponse::Question {
                response_schema_version,
                text,
                selected_option,
            },
            InteractionResponseBody::Approval {
                response_schema_version,
                approved,
                reason,
            } => InteractionResponse::Approval {
                response_schema_version,
                approved,
                reason,
            },
            InteractionResponseBody::Handoff {
                response_schema_version,
                completed,
                notes,
            } => InteractionResponse::Handoff {
                response_schema_version,
                completed,
                notes,
            },
        }
    }
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

fn interaction_error_response(error: InteractionError) -> (StatusCode, Json<serde_json::Value>) {
    let (status, code) = match error {
        InteractionError::NotFound { .. } => (StatusCode::NOT_FOUND, "interaction_not_found"),
        InteractionError::AlreadyResolved { .. } => (StatusCode::CONFLICT, "already_resolved"),
        InteractionError::AlreadyCancelled { .. } => (StatusCode::CONFLICT, "already_cancelled"),
        InteractionError::InvalidResponse { .. } => (StatusCode::BAD_REQUEST, "invalid_response"),
        InteractionError::OpenBlockingInteractionExists { .. }
        | InteractionError::ConcurrentModification { .. }
        | InteractionError::Io { .. }
        | InteractionError::Serialization { .. } => {
            (StatusCode::INTERNAL_SERVER_ERROR, "interaction_store_error")
        }
    };

    (
        status,
        Json(
            serde_json::to_value(ApiError::new(code, &error.to_string())).unwrap_or_else(|_| {
                serde_json::json!({
                    "error": {
                        "code": code,
                        "message": "failed to serialize error"
                    }
                })
            }),
        ),
    )
}

#[utoipa::path(
    get,
    path = "/api/v1/interactions",
    operation_id = "listOpenInteractions",
    responses(
        (status = 200, description = "Open interactions", body = [InteractionRequest])
    ),
    tag = "interactions"
)]
pub async fn list_open_interactions(State(state): State<AppState>) -> impl IntoResponse {
    match interaction_store(&state).list_open().await {
        Ok(interactions) => (
            StatusCode::OK,
            Json(serde_json::to_value(interactions).unwrap()),
        )
            .into_response(),
        Err(error) => interaction_error_response(error).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/interactions/{id}",
    operation_id = "getInteractionById",
    params(("id" = String, Path, description = "Interaction identifier")),
    responses(
        (status = 200, description = "Interaction detail", body = InteractionDetail),
        (status = 404, description = "Interaction not found", body = ApiError)
    ),
    tag = "interactions"
)]
pub async fn get_interaction_by_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match interaction_store(&state).get(&id).await {
        Ok(Some(interaction)) => (
            StatusCode::OK,
            Json(serde_json::to_value(InteractionDetail::from(&interaction)).unwrap()),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(
                serde_json::to_value(ApiError::new(
                    "interaction_not_found",
                    &format!("interaction not found: {id}"),
                ))
                .unwrap(),
            ),
        )
            .into_response(),
        Err(error) => interaction_error_response(error).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/interactions/{id}/respond",
    operation_id = "respondToInteraction",
    params(("id" = String, Path, description = "Interaction identifier")),
    request_body = InteractionResponseBody,
    responses(
        (status = 200, description = "Interaction resolved", body = InteractionRequest),
        (status = 400, description = "Invalid response body", body = ApiError),
        (status = 404, description = "Interaction not found", body = ApiError),
        (status = 409, description = "Interaction already resolved or cancelled", body = ApiError)
    ),
    tag = "interactions"
)]
pub async fn respond_to_interaction(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<InteractionResponseBody>, JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(body)) => body,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::to_value(ApiError::new(
                        "invalid_response",
                        &format!("invalid interaction response body: {error}"),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    let raw_body = serde_json::to_string(&body).unwrap_or_default();
    let response: InteractionResponse = body.into();
    let received_at = Utc::now();
    let input_id = format!(
        "local-api-{}-{}",
        received_at.timestamp_nanos_opt().unwrap_or_default(),
        LOCAL_API_INPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let command = AcceptedInteractionCommand {
        command: api_command_name(&response).to_string(),
        raw_body,
        author: "local-api".to_string(),
        comment_id: input_id,
        received_at,
    };

    let store = interaction_store(&state);
    let before = match store.get(&id).await {
        Ok(Some(interaction)) => interaction,
        Ok(None) => {
            return interaction_error_response(InteractionError::NotFound { id }).into_response();
        }
        Err(error) => return interaction_error_response(error).into_response(),
    };

    match store.accept_response(&id, command, response).await {
        Ok(InteractionAcceptance::Accepted(interaction)) => {
            if let Err(error) = retire_attention(&state, &before, &interaction).await {
                warn!(interaction_id = %interaction.id, error, "interaction attention retirement will reconcile on a later tick");
            }
            (
                StatusCode::OK,
                Json(serde_json::to_value(interaction).unwrap()),
            )
                .into_response()
        }
        Ok(InteractionAcceptance::Ignored(interaction)) => {
            let error = if interaction.status == InteractionStatus::Cancelled {
                InteractionError::AlreadyCancelled { id }
            } else {
                InteractionError::AlreadyResolved { id }
            };
            interaction_error_response(error).into_response()
        }
        Err(error) => interaction_error_response(error).into_response(),
    }
}

fn api_command_name(response: &InteractionResponse) -> &'static str {
    match response {
        InteractionResponse::Question { .. } => "/answer",
        InteractionResponse::Approval { approved: true, .. }
        | InteractionResponse::Handoff {
            completed: true, ..
        } => "/approve",
        InteractionResponse::Approval {
            approved: false, ..
        }
        | InteractionResponse::Handoff {
            completed: false, ..
        } => "/reject",
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/interactions/{id}/cancel",
    operation_id = "cancelInteraction",
    params(("id" = String, Path, description = "Interaction identifier")),
    responses(
        (status = 200, description = "Interaction cancelled", body = InteractionRequest),
        (status = 404, description = "Interaction not found", body = ApiError),
        (status = 409, description = "Interaction already resolved or cancelled", body = ApiError)
    ),
    tag = "interactions"
)]
pub async fn cancel_interaction(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let store = interaction_store(&state);
    let before = match store.get(&id).await {
        Ok(Some(interaction)) => interaction,
        Ok(None) => {
            return interaction_error_response(InteractionError::NotFound { id }).into_response();
        }
        Err(error) => return interaction_error_response(error).into_response(),
    };
    match store.cancel(&id).await {
        Ok(interaction) => {
            if let Err(error) = retire_attention(&state, &before, &interaction).await {
                warn!(interaction_id = %interaction.id, error, "interaction attention retirement will reconcile on a later tick");
            }
            (
                StatusCode::OK,
                Json(serde_json::to_value(interaction).unwrap()),
            )
                .into_response()
        }
        Err(error) => interaction_error_response(error).into_response(),
    }
}

async fn retire_attention(
    state: &AppState,
    before: &InteractionRequest,
    after: &InteractionRequest,
) -> Result<(), String> {
    let Some(history_store) = state.history_store.clone() else {
        return Err("attention history store is unavailable".into());
    };
    let close = interaction_attention_close(before, after)
        .map_err(|error| format!("failed to derive attention close evidence: {error}"))?;
    AttentionReporter::new(history_store)
        .resolve(close)
        .await
        .map_err(|error| format!("failed to retire interaction attention: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::interaction::InteractionResumeStrategy;

    fn request(id: &str) -> InteractionRequest {
        InteractionRequest {
            id: id.into(),
            schema_version: 1,
            issue_id: "issue-514".into(),
            issue_identifier: "repo#514".into(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: "build".into(),
            agent_name: "solver".into(),
            step_depends: vec![],
            step_tracker_state: None,
            kind: InteractionKind::Question,
            status: InteractionStatus::Open,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: "Need input".into(),
            body: "Choose an option".into(),
            options: vec![],
            artifacts: vec![],
            thread_root_comment_id: None,
            thread_root_comment_url: None,
            last_processed_comment_id: None,
            accepted_command: None,
            ignored_commands: vec![],
            response: None,
            waiting_started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            resolved_at: None,
        }
    }

    fn state_without_attention_history(config_path: std::path::PathBuf) -> AppState {
        let mut state = app_state_with_document_state(parsed_document_state());
        state.config_runtime.config_path = config_path;
        state.history_store = None;
        state
    }

    #[tokio::test]
    async fn response_keeps_committed_resolution_when_attention_retirement_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("config.yaml");
        let state = state_without_attention_history(config_path);
        let store = interaction_store(&state);
        store.create(request("response-1")).await.unwrap();

        let response = respond_to_interaction(
            State(state),
            Path("response-1".into()),
            Ok(Json(InteractionResponseBody::Question {
                response_schema_version: 1,
                text: "Proceed".into(),
                selected_option: None,
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            store.get("response-1").await.unwrap().unwrap().status,
            InteractionStatus::Resolved
        );
    }

    #[tokio::test]
    async fn cancel_keeps_committed_cancellation_when_attention_retirement_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("config.yaml");
        let state = state_without_attention_history(config_path);
        let store = interaction_store(&state);
        store.create(request("cancel-1")).await.unwrap();

        let response = cancel_interaction(State(state), Path("cancel-1".into()))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            store.get("cancel-1").await.unwrap().unwrap().status,
            InteractionStatus::Cancelled
        );
    }
}
