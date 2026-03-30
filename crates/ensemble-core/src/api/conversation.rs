use crate::api::handlers::ApiError;
use crate::api::router::AppState;
use crate::tracker::model::sanitize_workspace_key;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

/// Query parameters for conversation pagination.
#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub struct ConversationQuery {
    /// Cursor-based pagination: skip messages before this 0-based index.
    pub cursor: Option<usize>,
    /// Maximum number of messages to return (default: 50).
    pub limit: Option<usize>,
}

/// A single conversation message.
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ConversationMessage {
    pub index: u64,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_output: Option<serde_json::Value>,
}

/// Response envelope for conversation queries.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ConversationResponse {
    pub messages: Vec<ConversationMessage>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

/// GET /api/v1/{identifier}/conversation
///
/// Returns paginated conversation messages from the workspace's conversation.jsonl file.
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/conversation",
    operation_id = "getConversation",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ConversationQuery,
    ),
    responses(
        (status = 200, description = "Conversation messages", body = ConversationResponse),
        (status = 400, description = "Invalid identifier", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Query(query): Query<ConversationQuery>,
) -> impl IntoResponse {
    let workspace_key = match sanitize_workspace_key(&identifier) {
        Some(key) => key,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::to_value(ApiError::new(
                        "invalid_identifier",
                        "identifier cannot be sanitized to a workspace key",
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    let conversation_path = std::path::PathBuf::from(&state.workspace_root)
        .join(&workspace_key)
        .join(".ensemble")
        .join("conversation.jsonl");

    let contents = match tokio::fs::read_to_string(&conversation_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::OK,
                Json(
                    serde_json::to_value(ConversationResponse {
                        messages: vec![],
                        total: 0,
                        next_cursor: None,
                    })
                    .unwrap(),
                ),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ApiError::new(
                        "conversation_read_error",
                        &format!("failed to read conversation: {}", e),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    let all_messages: Vec<ConversationMessage> = contents
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    let total = all_messages.len();
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(50).min(200);

    let page: Vec<ConversationMessage> =
        all_messages.into_iter().skip(cursor).take(limit).collect();

    let next_cursor = if cursor + page.len() < total {
        Some(cursor + page.len())
    } else {
        None
    };

    (
        StatusCode::OK,
        Json(
            serde_json::to_value(ConversationResponse {
                messages: page,
                total,
                next_cursor,
            })
            .unwrap(),
        ),
    )
        .into_response()
}

/// GET /api/v1/{identifier}/conversation/{index}
///
/// Returns a single conversation message by its index.
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/conversation/{index}",
    operation_id = "getConversationMessage",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("index" = u64, Path, description = "Message index"),
    ),
    responses(
        (status = 200, description = "Single message", body = ConversationMessage),
        (status = 404, description = "Message not found", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation_message(
    State(state): State<AppState>,
    Path((identifier, index)): Path<(String, u64)>,
) -> impl IntoResponse {
    let workspace_key = match sanitize_workspace_key(&identifier) {
        Some(key) => key,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::to_value(ApiError::new(
                        "invalid_identifier",
                        "identifier cannot be sanitized to a workspace key",
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    let conversation_path = std::path::PathBuf::from(&state.workspace_root)
        .join(&workspace_key)
        .join(".ensemble")
        .join("conversation.jsonl");

    let contents = match tokio::fs::read_to_string(&conversation_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::NOT_FOUND,
                Json(
                    serde_json::to_value(ApiError::new(
                        "conversation_not_found",
                        "no conversation file found for this issue",
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ApiError::new(
                        "conversation_read_error",
                        &format!("failed to read conversation: {}", e),
                    ))
                    .unwrap(),
                ),
            )
                .into_response();
        }
    };

    let message = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<ConversationMessage>(line).ok())
        .find(|m| m.index == index);

    match message {
        Some(msg) => (StatusCode::OK, Json(serde_json::to_value(msg).unwrap())).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(
                serde_json::to_value(ApiError::new(
                    "message_not_found",
                    &format!("no message at index {}", index),
                ))
                .unwrap(),
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_message_deserialize() {
        let json = r#"{"index":0,"role":"user","content":"hello"}"#;
        let msg: ConversationMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.index, 0);
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "hello");
    }

    #[test]
    fn test_conversation_response_serialize() {
        let response = ConversationResponse {
            messages: vec![],
            total: 0,
            next_cursor: None,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["total"], 0);
        assert!(json["next_cursor"].is_null());
    }
}
