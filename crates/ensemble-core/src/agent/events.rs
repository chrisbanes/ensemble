use std::borrow::Cow;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::interaction::InteractionKind;

/// Token usage reported by the ACP agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStream {
    Stdout,
    Stderr,
}

/// ACP stop reasons mapped from session/update notifications.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    Cancelled,
    Refusal,
    MaxTurnRequests,
}

impl StopReason {
    /// Parse a stop reason string from ACP protocol.
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s {
            "end_turn" => Some(StopReason::EndTurn),
            "max_tokens" => Some(StopReason::MaxTokens),
            "cancelled" => Some(StopReason::Cancelled),
            "refusal" => Some(StopReason::Refusal),
            "max_turn_requests" => Some(StopReason::MaxTurnRequests),
            _ => None,
        }
    }

    /// Whether this stop reason indicates a successful turn completion.
    pub fn is_success(&self) -> bool {
        matches!(self, StopReason::EndTurn)
    }

    /// Whether this stop reason indicates a failure.
    pub fn is_failure(&self) -> bool {
        matches!(
            self,
            StopReason::Cancelled | StopReason::Refusal | StopReason::MaxTurnRequests
        )
    }
}

/// Internal event types emitted by the ACP client to the orchestrator.
#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    SessionStarted {
        session_id: String,
        agent_pid: Option<String>,
    },
    PromptStarted,
    OutputChunk {
        stream: RuntimeStream,
        content: String,
    },
    RunCompleted {
        usage: Option<TokenUsage>,
    },
    RunFailed {
        reason: String,
        usage: Option<TokenUsage>,
    },
    Cancelled {
        reason: Option<String>,
    },
    Warning {
        message: String,
    },
    TurnStarted,
    TurnUpdate {
        content: String,
    },
    TurnCompleted {
        usage: Option<TokenUsage>,
    },
    TurnFailed {
        reason: String,
        usage: Option<TokenUsage>,
    },
    PermissionRequested {
        permission_id: String,
        description: String,
    },
    PermissionResolved {
        permission_id: String,
        allowed: bool,
    },
    Notification {
        message: String,
    },
    OtherMessage {
        raw: String,
    },
    Malformed {
        line: String,
    },
}

impl AgentEvent {
    /// Returns the event name for logging/state tracking.
    pub fn event_name(&self) -> &'static str {
        match self {
            AgentEvent::SessionStarted { .. } => "session_started",
            AgentEvent::PromptStarted => "prompt_started",
            AgentEvent::OutputChunk { .. } => "output_chunk",
            AgentEvent::RunCompleted { .. } => "run_completed",
            AgentEvent::RunFailed { .. } => "run_failed",
            AgentEvent::Cancelled { .. } => "cancelled",
            AgentEvent::Warning { .. } => "warning",
            AgentEvent::TurnStarted => "turn_started",
            AgentEvent::TurnUpdate { .. } => "turn_update",
            AgentEvent::TurnCompleted { .. } => "turn_completed",
            AgentEvent::TurnFailed { .. } => "turn_failed",
            AgentEvent::PermissionRequested { .. } => "permission_requested",
            AgentEvent::PermissionResolved { .. } => "permission_resolved",
            AgentEvent::Notification { .. } => "notification",
            AgentEvent::OtherMessage { .. } => "other_message",
            AgentEvent::Malformed { .. } => "malformed",
        }
    }

    /// Returns the message content for state tracking, truncated to 200 chars.
    pub fn message_for_state(&self) -> Option<Cow<'_, str>> {
        match self {
            AgentEvent::Warning { message } => Some(truncate_for_state(message)),
            AgentEvent::RunFailed { reason, .. } => Some(truncate_for_state(reason)),
            AgentEvent::Cancelled { reason } => reason.as_deref().map(truncate_for_state),
            AgentEvent::OutputChunk { content, .. } => Some(truncate_for_state(content)),
            AgentEvent::TurnUpdate { content } => Some(truncate_for_state(content)),
            AgentEvent::TurnFailed { reason, .. } => Some(truncate_for_state(reason)),
            AgentEvent::PermissionRequested { description, .. } => {
                Some(truncate_for_state(description))
            }
            AgentEvent::Notification { message } => Some(truncate_for_state(message)),
            AgentEvent::OtherMessage { raw } => Some(truncate_for_state(raw)),
            AgentEvent::Malformed { line } => Some(truncate_for_state(line)),
            _ => None,
        }
    }
}

fn truncate_for_state(value: &str) -> Cow<'_, str> {
    const STATE_MESSAGE_LIMIT: usize = 200;

    if value.chars().count() > STATE_MESSAGE_LIMIT {
        Cow::Owned(value.chars().take(STATE_MESSAGE_LIMIT).collect())
    } else {
        Cow::Borrowed(value)
    }
}

/// Events sent from worker tasks to the orchestrator.
#[derive(Debug)]
pub enum WorkerEvent {
    AgentUpdate {
        issue_id: String,
        step_name: String,
        event: AgentEvent,
        timestamp: DateTime<Utc>,
    },
    WorkerExited {
        issue_id: String,
        step_name: String,
        result: WorkerResult,
        timestamp: DateTime<Utc>,
    },
}

/// Outcome of a worker task.
#[derive(Debug, Clone)]
pub enum WorkerResult {
    Success,
    BlockedOnHuman { request: InteractionRequestDraft },
    Failed { error: String },
}

impl WorkerResult {
    pub fn is_success(&self) -> bool {
        matches!(self, WorkerResult::Success)
    }
}

/// Draft interaction request emitted by an agent in `.ensemble/interaction-request.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InteractionRequestDraft {
    pub schema_version: u32,
    pub kind: InteractionKind,
    pub blocking: bool,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

/// JSON-RPC 2.0 message types for ACP protocol parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcMessage {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<serde_json::Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcMessage {
    /// Check if this is a response (has id and result or error).
    pub fn is_response(&self) -> bool {
        self.id.is_some() && (self.result.is_some() || self.error.is_some())
    }

    /// Check if this is a request (has id and method).
    pub fn is_request(&self) -> bool {
        self.id.is_some() && self.method.is_some()
    }

    /// Check if this is a notification (has method but no id).
    pub fn is_notification(&self) -> bool {
        self.id.is_none() && self.method.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stop_reason_parse() {
        assert_eq!(
            StopReason::from_str_loose("end_turn"),
            Some(StopReason::EndTurn)
        );
        assert_eq!(
            StopReason::from_str_loose("cancelled"),
            Some(StopReason::Cancelled)
        );
        assert_eq!(
            StopReason::from_str_loose("refusal"),
            Some(StopReason::Refusal)
        );
        assert_eq!(
            StopReason::from_str_loose("max_turn_requests"),
            Some(StopReason::MaxTurnRequests)
        );
        assert_eq!(
            StopReason::from_str_loose("max_tokens"),
            Some(StopReason::MaxTokens)
        );
        assert_eq!(StopReason::from_str_loose("unknown"), None);
    }

    #[test]
    fn test_stop_reason_success_failure() {
        assert!(StopReason::EndTurn.is_success());
        assert!(!StopReason::EndTurn.is_failure());
        assert!(!StopReason::Cancelled.is_success());
        assert!(StopReason::Cancelled.is_failure());
        assert!(StopReason::Refusal.is_failure());
        assert!(StopReason::MaxTurnRequests.is_failure());
        assert!(!StopReason::MaxTokens.is_success());
        assert!(!StopReason::MaxTokens.is_failure());
    }

    #[test]
    fn test_worker_result_is_success() {
        assert!(WorkerResult::Success.is_success());
        assert!(!WorkerResult::BlockedOnHuman {
            request: InteractionRequestDraft {
                schema_version: 1,
                kind: InteractionKind::Question,
                blocking: true,
                title: "Need input".to_string(),
                body: "Pick an environment".to_string(),
                options: vec!["staging".to_string()],
                artifacts: vec![],
            }
        }
        .is_success());
        assert!(!WorkerResult::Failed {
            error: "boom".to_string()
        }
        .is_success());
    }

    #[test]
    fn test_interaction_request_draft_deserialization_defaults_collections() {
        let draft: InteractionRequestDraft = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "kind": "question",
            "blocking": true,
            "title": "Need input",
            "body": "Which environment?"
        }))
        .unwrap();

        assert_eq!(draft.options, Vec::<String>::new());
        assert_eq!(draft.artifacts, Vec::<String>::new());
    }

    #[test]
    fn test_json_rpc_message_classification() {
        // Response
        let resp = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(1)),
            method: None,
            params: None,
            result: Some(serde_json::json!({"ok": true})),
            error: None,
        };
        assert!(resp.is_response());
        assert!(!resp.is_request());
        assert!(!resp.is_notification());

        // Request
        let req = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(2)),
            method: Some("session/request_permission".to_string()),
            params: Some(serde_json::json!({})),
            result: None,
            error: None,
        };
        assert!(!req.is_response());
        assert!(req.is_request());
        assert!(!req.is_notification());

        // Notification
        let notif = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: Some("session/update".to_string()),
            params: Some(serde_json::json!({})),
            result: None,
            error: None,
        };
        assert!(!notif.is_response());
        assert!(!notif.is_request());
        assert!(notif.is_notification());
    }

    #[test]
    fn test_json_rpc_message_parse_from_json() {
        let json_str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-07-09","agentCapabilities":{}}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(json_str).unwrap();
        assert!(msg.is_response());
        assert_eq!(msg.id, Some(serde_json::json!(1)));
        assert!(msg.result.is_some());
    }

    #[test]
    fn test_json_rpc_error_response_parse() {
        let json_str =
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request"}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(json_str).unwrap();
        assert!(msg.is_response());
        let err = msg.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Invalid Request");
    }

    #[test]
    fn test_token_usage_default() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn test_token_usage_serialization_roundtrip() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
        };
        let json = serde_json::to_string(&usage).unwrap();
        let parsed: TokenUsage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.input_tokens, 1000);
        assert_eq!(parsed.output_tokens, 500);
        assert_eq!(parsed.total_tokens, 1500);
    }

    #[test]
    fn test_message_for_state_truncates_long_turn_updates() {
        let event = AgentEvent::TurnUpdate {
            content: "x".repeat(250),
        };

        let message = event.message_for_state().unwrap();

        assert_eq!(message.len(), 200);
    }
}
