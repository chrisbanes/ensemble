use crate::api::handlers::ApiError;
use crate::api::router::AppState;
use crate::interaction::error::InteractionError;
use crate::interaction::model::{InteractionRequest, InteractionResponse};
use crate::interaction::store::InteractionStore;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
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
        Json(serde_json::to_value(ApiError::new(code, &error.to_string())).unwrap()),
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
        (status = 200, description = "Interaction detail", body = InteractionRequest),
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
            Json(serde_json::to_value(interaction).unwrap()),
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

    match interaction_store(&state).resolve(&id, body.into()).await {
        Ok(interaction) => (
            StatusCode::OK,
            Json(serde_json::to_value(interaction).unwrap()),
        )
            .into_response(),
        Err(error) => interaction_error_response(error).into_response(),
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
