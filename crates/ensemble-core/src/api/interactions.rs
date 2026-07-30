use crate::api::handlers::ApiError;
use crate::api::router::AppState;
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

    match interaction_store(&state)
        .accept_response(&id, command, response)
        .await
    {
        Ok(InteractionAcceptance::Accepted(interaction)) => (
            StatusCode::OK,
            Json(serde_json::to_value(interaction).unwrap()),
        )
            .into_response(),
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
    match interaction_store(&state).cancel(&id).await {
        Ok(interaction) => (
            StatusCode::OK,
            Json(serde_json::to_value(interaction).unwrap()),
        )
            .into_response(),
        Err(error) => interaction_error_response(error).into_response(),
    }
}
