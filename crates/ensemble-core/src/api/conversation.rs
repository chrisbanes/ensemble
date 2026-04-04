use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use crate::tracker::model::sanitize_workspace_key;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};

fn conversation_path(workspace_root: &str, workspace_key: &str) -> PathBuf {
    PathBuf::from(workspace_root)
        .join(workspace_key)
        .join(".ensemble")
        .join("conversation.jsonl")
}

async fn read_conversation_file(path: &FsPath) -> Result<Option<String>, std::io::Error> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_conversation_messages(
    contents: &str,
) -> Result<Vec<ConversationMessage>, serde_json::Error> {
    contents.lines().map(serde_json::from_str).collect()
}

async fn load_conversation_messages(
    path: &FsPath,
) -> Result<Option<Vec<ConversationMessage>>, ApiError> {
    let Some(contents) = read_conversation_file(path).await.map_err(|e| {
        ApiError::new(
            "conversation_read_error",
            &format!("failed to read conversation: {e}"),
        )
    })?
    else {
        return Ok(None);
    };

    let messages = parse_conversation_messages(&contents).map_err(|e| {
        ApiError::new(
            "conversation_parse_error",
            &format!("failed to parse conversation: {e}"),
        )
    })?;

    Ok(Some(messages))
}

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
                api_error(
                    "invalid_identifier",
                    "identifier cannot be sanitized to a workspace key",
                ),
            )
                .into_response();
        }
    };

    let conversation_path = conversation_path(&state.workspace_root, &workspace_key);

    let all_messages = match load_conversation_messages(&conversation_path).await {
        Ok(Some(messages)) => messages,
        Ok(None) => {
            return (
                StatusCode::OK,
                Json(ConversationResponse {
                    messages: vec![],
                    total: 0,
                    next_cursor: None,
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(error)).into_response();
        }
    };

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
        Json(ConversationResponse {
            messages: page,
            total,
            next_cursor,
        }),
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
                api_error(
                    "invalid_identifier",
                    "identifier cannot be sanitized to a workspace key",
                ),
            )
                .into_response();
        }
    };

    let conversation_path = conversation_path(&state.workspace_root, &workspace_key);

    let messages = match load_conversation_messages(&conversation_path).await {
        Ok(Some(messages)) => messages,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                api_error(
                    "conversation_not_found",
                    "no conversation file found for this issue",
                ),
            )
                .into_response();
        }
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(error)).into_response();
        }
    };

    let message = messages.into_iter().find(|m| m.index == index);

    match message {
        Some(msg) => (StatusCode::OK, Json(msg)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            api_error(
                "message_not_found",
                format!("no message at index {}", index),
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::tracker::model::sanitize_workspace_key;
    use axum::body::to_bytes;
    use tempfile::TempDir;

    fn test_app_state(workspace_root: String) -> AppState {
        let mut app_state = app_state_with_document_state(parsed_document_state());
        app_state.workspace_root = workspace_root;
        app_state
    }

    async fn write_conversation_file(root: &std::path::Path, contents: &str) {
        let workspace_key = sanitize_workspace_key("my-repo#42").unwrap();
        let path = conversation_path(root.to_str().unwrap(), &workspace_key);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, contents).await.unwrap();
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn conversation_path_uses_workspace_root_and_key() {
        let path = conversation_path("/tmp/workspaces", "my-repo-42");
        assert_eq!(
            path,
            std::path::PathBuf::from("/tmp/workspaces")
                .join("my-repo-42")
                .join(".ensemble")
                .join("conversation.jsonl")
        );
    }

    #[tokio::test]
    async fn read_conversation_file_returns_none_for_missing_file() {
        let tempdir = TempDir::new().unwrap();
        let path = tempdir.path().join("missing.jsonl");

        let contents = read_conversation_file(&path).await.unwrap();

        assert!(contents.is_none());
    }

    #[tokio::test]
    async fn get_conversation_returns_empty_result_when_file_is_missing() {
        let tempdir = TempDir::new().unwrap();
        let state = test_app_state(tempdir.path().display().to_string());

        let response = get_conversation(
            State(state),
            Path("my-repo#42".to_string()),
            Query(ConversationQuery::default()),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_conversation_message_returns_not_found_when_file_is_missing() {
        let tempdir = TempDir::new().unwrap();
        let state = test_app_state(tempdir.path().display().to_string());

        let response = get_conversation_message(State(state), Path(("my-repo#42".to_string(), 0)))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_conversation_returns_internal_error_for_malformed_jsonl() {
        let tempdir = TempDir::new().unwrap();
        write_conversation_file(tempdir.path(), "{invalid json}\n").await;
        let state = test_app_state(tempdir.path().display().to_string());

        let response = get_conversation(
            State(state),
            Path("my-repo#42".to_string()),
            Query(ConversationQuery::default()),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "conversation_parse_error");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("failed to parse conversation:"));
    }

    #[tokio::test]
    async fn get_conversation_message_returns_error_for_malformed_jsonl() {
        let tempdir = TempDir::new().unwrap();
        write_conversation_file(tempdir.path(), "{invalid json}\n").await;
        let state = test_app_state(tempdir.path().display().to_string());

        let response = get_conversation_message(State(state), Path(("my-repo#42".to_string(), 0)))
            .await
            .into_response();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "conversation_parse_error");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("failed to parse conversation:"));
    }

    #[test]
    fn test_conversation_message_deserialize() {
        let json = r#"{"index":0,"role":"user","content":"hello"}"#;
        let msg: ConversationMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.index, 0);
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "hello");
    }

    #[test]
    fn conversation_response_serializes_total_and_next_cursor() {
        let response = ConversationResponse {
            messages: vec![],
            total: 0,
            next_cursor: None,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["total"], 0);
        assert!(json["next_cursor"].is_null());
    }

    #[test]
    fn parse_conversation_messages_returns_error_for_malformed_jsonl() {
        let error = parse_conversation_messages("{invalid json}\n").unwrap_err();
        assert!(error.is_syntax());
    }
}
