use crate::agent::events::{JsonRpcMessage, StopReason, TokenUsage};

/// Permission request details surfaced in session updates.
#[derive(Debug, Clone)]
pub struct PermissionRequest {
    pub permission_id: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum TranscriptBlockKind {
    AssistantMessage,
    Reasoning,
    ToolCall,
    ToolResult,
    PermissionRequest,
    TurnComplete,
    Raw,
}

#[derive(Debug, Clone)]
pub struct TranscriptBlock {
    pub kind: TranscriptBlockKind,
    pub payload: serde_json::Value,
}

/// Normalized data extracted from ACP `session/update` payloads.
///
/// `permission_request` is currently consumed by the acpx runtime path when
/// mapping runtime warnings, but the shared parser keeps this field available
/// for any runtime that needs it.
#[derive(Debug, Clone)]
pub struct ParsedSessionUpdate {
    pub output_text: Option<String>,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<StopReason>,
    pub permission_request: Option<PermissionRequest>,
    pub verdict: Option<serde_json::Value>,
    pub transcript_blocks: Vec<TranscriptBlock>,
}

/// Parse one stdout line as a JSON-RPC message.
///
/// Returns `None` when the line is not valid JSON-RPC JSON.
pub fn parse_jsonrpc(line: &str) -> Option<JsonRpcMessage> {
    let message = serde_json::from_str::<JsonRpcMessage>(line).ok()?;
    let is_jsonrpc_2 = message.jsonrpc == "2.0";
    if !is_jsonrpc_2 {
        return None;
    }

    let has_method = message.method.is_some();
    let has_id = message.id.is_some();
    let has_result = message.result.is_some();
    let has_error = message.error.is_some();

    if has_method {
        if has_result || has_error {
            return None;
        }
        return Some(message);
    }

    if has_id && (has_result ^ has_error) {
        return Some(message);
    }

    None
}

/// Parse a `session/update` payload into normalized fields.
///
/// Accepts either:
/// - a full JSON-RPC notification object (`method = session/update`), or
/// - a direct `params` object from that notification.
pub fn parse_session_update(value: &serde_json::Value) -> Option<ParsedSessionUpdate> {
    let params = if let Some(method) = value.get("method").and_then(|v| v.as_str()) {
        if method != "session/update" {
            return None;
        }
        value.get("params")?
    } else {
        value
    };

    let update = params.get("update");
    let output_text = extract_output_text(params, update);
    let usage = extract_usage(params, update);
    let stop_reason = extract_stop_reason(params, update);
    let permission_request = extract_permission_request(params, update);
    let verdict = extract_verdict(params, update);
    let transcript_blocks = extract_transcript_blocks(params, update, output_text.as_deref());

    let parsed = ParsedSessionUpdate {
        output_text,
        usage,
        stop_reason,
        permission_request,
        verdict,
        transcript_blocks,
    };

    if parsed.output_text.is_none()
        && parsed.usage.is_none()
        && parsed.stop_reason.is_none()
        && parsed.permission_request.is_none()
        && parsed.verdict.is_none()
        && parsed.transcript_blocks.is_empty()
    {
        return None;
    }

    Some(parsed)
}

pub fn parse_stop_reason_from_result(value: &serde_json::Value) -> Option<StopReason> {
    let result = value.get("result").unwrap_or(value);
    let raw = result.get("stopReason").and_then(|v| v.as_str())?;
    StopReason::from_str_loose(raw)
}

fn extract_output_text(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
) -> Option<String> {
    if let Some(text) = update.and_then(|u| u.get("content")).and_then(content_text) {
        return Some(text).filter(|s| !s.is_empty());
    }

    if let Some(text) = params.get("content").and_then(content_text) {
        return Some(text).filter(|s| !s.is_empty());
    }

    None
}

fn content_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    value
        .get("text")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
}

fn extract_transcript_blocks(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
    output_text: Option<&str>,
) -> Vec<TranscriptBlock> {
    let source = update.unwrap_or(params);
    let session_update = source
        .get("sessionUpdate")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let content = source.get("content").or_else(|| params.get("content"));

    if session_update.contains("reasoning") {
        if let Some(text) = content.and_then(content_text) {
            return vec![TranscriptBlock {
                kind: TranscriptBlockKind::Reasoning,
                payload: serde_json::json!({"text": text}),
            }];
        }
    }

    if session_update == "tool_call_update" {
        let tool_call_id = source
            .get("toolCallId")
            .or_else(|| source.get("tool_call_id"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let name = content
            .and_then(|value| value.get("name"))
            .cloned()
            .or_else(|| source.get("name").cloned())
            .unwrap_or(serde_json::Value::Null);
        let arguments = content
            .and_then(|value| value.get("arguments"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        return vec![TranscriptBlock {
            kind: TranscriptBlockKind::ToolCall,
            payload: serde_json::json!({
                "tool_call_id": tool_call_id,
                "name": name,
                "arguments": arguments,
                "status": source.get("status").cloned().unwrap_or(serde_json::Value::Null),
                "title": source.get("title").cloned().unwrap_or(serde_json::Value::Null)
            }),
        }];
    }

    if session_update.contains("tool_result") || session_update.contains("tool_output") {
        return vec![TranscriptBlock {
            kind: TranscriptBlockKind::ToolResult,
            payload: serde_json::json!({
                "tool_call_id": source.get("toolCallId").or_else(|| source.get("tool_call_id")).cloned(),
                "content": content.cloned().unwrap_or(serde_json::Value::Null)
            }),
        }];
    }

    if let Some(text) = output_text {
        return vec![TranscriptBlock {
            kind: TranscriptBlockKind::AssistantMessage,
            payload: serde_json::json!({"text": text}),
        }];
    }

    vec![]
}

fn extract_usage(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
) -> Option<TokenUsage> {
    if let Some(usage) = update
        .and_then(|u| u.get("usage"))
        .cloned()
        .and_then(|v| serde_json::from_value::<TokenUsage>(v).ok())
    {
        return Some(usage);
    }

    params
        .get("usage")
        .cloned()
        .and_then(|v| serde_json::from_value::<TokenUsage>(v).ok())
}

fn extract_stop_reason(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
) -> Option<StopReason> {
    if let Some(raw) = update
        .and_then(|u| u.get("stopReason"))
        .and_then(|v| v.as_str())
    {
        return StopReason::from_str_loose(raw);
    }

    params
        .get("stopReason")
        .and_then(|v| v.as_str())
        .and_then(StopReason::from_str_loose)
}

fn extract_permission_request(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
) -> Option<PermissionRequest> {
    let source = update.unwrap_or(params);
    let permission_id = source
        .get("permissionId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("permissionId").and_then(|v| v.as_str()))?;
    let description = source
        .get("description")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("description").and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();

    Some(PermissionRequest {
        permission_id: permission_id.to_string(),
        description,
    })
}

fn extract_verdict(
    params: &serde_json::Value,
    update: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    update
        .and_then(|u| u.get("result"))
        .cloned()
        .or_else(|| update.and_then(|u| u.get("verdict")).cloned())
        .or_else(|| params.get("result").cloned())
        .or_else(|| params.get("verdict").cloned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parse_agent_message_chunk_from_nested_update() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello"}
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.output_text.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_session_update_extracts_transcript_tool_call() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1",
                    "title": "Read file",
                    "kind": "read",
                    "status": "pending",
                    "content": {
                        "type": "tool_call",
                        "name": "read_file",
                        "arguments": {"path": "Cargo.toml"}
                    }
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.transcript_blocks.len(), 1);
        assert_eq!(
            parsed.transcript_blocks[0].kind,
            TranscriptBlockKind::ToolCall
        );
        assert_eq!(
            parsed.transcript_blocks[0].payload["tool_call_id"],
            "call-1"
        );
        assert_eq!(parsed.transcript_blocks[0].payload["name"], "read_file");
    }

    #[test]
    fn parse_session_update_extracts_tool_result_block() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_result",
                    "toolCallId": "call-1",
                    "content": {"type": "text", "text": "Cargo.toml contents"}
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.output_text.as_deref(), Some("Cargo.toml contents"));
        assert_eq!(parsed.transcript_blocks.len(), 1);
        assert_eq!(
            parsed.transcript_blocks[0].kind,
            TranscriptBlockKind::ToolResult
        );
        assert_eq!(
            parsed.transcript_blocks[0].payload["tool_call_id"],
            "call-1"
        );
        assert_eq!(
            parsed.transcript_blocks[0].payload["content"],
            json!({"type": "text", "text": "Cargo.toml contents"})
        );
    }

    #[test]
    fn parse_session_update_extracts_reasoning_block() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "reasoning_chunk",
                    "content": {"type": "reasoning", "text": "thinking"}
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.transcript_blocks.len(), 1);
        assert_eq!(
            parsed.transcript_blocks[0].kind,
            TranscriptBlockKind::Reasoning
        );
        assert_eq!(parsed.transcript_blocks[0].payload["text"], "thinking");
    }

    #[test]
    fn parse_session_update_preserves_output_text_for_reasoning_block() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "reasoning_chunk",
                    "content": {"type": "reasoning", "text": "thinking"}
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.output_text.as_deref(), Some("thinking"));
        assert_eq!(parsed.transcript_blocks.len(), 1);
        assert_eq!(
            parsed.transcript_blocks[0].kind,
            TranscriptBlockKind::Reasoning
        );
        assert_eq!(parsed.transcript_blocks[0].payload["text"], "thinking");
    }

    #[test]
    fn parse_session_update_keeps_assistant_text_as_transcript_block() {
        let line = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello"}
                }
            }
        });

        let parsed = parse_session_update(&line).unwrap();
        assert_eq!(parsed.output_text.as_deref(), Some("hello"));
        assert_eq!(
            parsed.transcript_blocks[0].kind,
            TranscriptBlockKind::AssistantMessage
        );
        assert_eq!(parsed.transcript_blocks[0].payload["text"], "hello");
    }

    #[test]
    fn parse_stop_reason_from_prompt_response_result() {
        let line = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": {"stopReason": "end_turn"}
        });

        let stop = parse_stop_reason_from_result(&line).unwrap();
        assert_eq!(stop, StopReason::EndTurn);
    }

    #[test]
    fn parse_jsonrpc_invalid_input_returns_none() {
        assert!(parse_jsonrpc("not-json").is_none());
    }

    #[test]
    fn parse_jsonrpc_invalid_envelope_returns_none() {
        let invalid = r#"{"jsonrpc":"2.0","params":{"foo":"bar"}}"#;
        assert!(parse_jsonrpc(invalid).is_none());
    }

    #[test]
    fn parse_session_update_supports_flat_content() {
        let params = json!({
            "sessionId": "s1",
            "content": "flat text",
            "stopReason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
        });

        let parsed = parse_session_update(&params).unwrap();
        assert_eq!(parsed.output_text.as_deref(), Some("flat text"));
        assert_eq!(parsed.stop_reason, Some(StopReason::EndTurn));
        let usage = parsed.usage.expect("usage should be parsed");
        assert_eq!(usage.input_tokens, 1);
        assert_eq!(usage.output_tokens, 2);
        assert_eq!(usage.total_tokens, 3);
    }

    #[test]
    fn parse_session_update_prefers_nested_usage_over_flat_usage() {
        let params = json!({
            "sessionId": "s1",
            "usage": {"input_tokens": 9, "output_tokens": 9, "total_tokens": 18},
            "update": {
                "sessionUpdate": "usage_update",
                "usage": {"input_tokens": 4, "output_tokens": 5, "total_tokens": 9}
            }
        });

        let parsed = parse_session_update(&params).unwrap();
        let usage = parsed.usage.expect("usage should be parsed");
        assert_eq!(usage.input_tokens, 4);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.total_tokens, 9);
    }

    #[test]
    fn parse_session_update_extracts_permission_request() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "permission_request",
                "permissionId": "perm-1",
                "description": "write file"
            }
        });

        let parsed = parse_session_update(&params).unwrap();
        let permission = parsed
            .permission_request
            .expect("permission request should be parsed");
        assert_eq!(permission.permission_id, "perm-1");
        assert_eq!(permission.description, "write file");
    }

    #[test]
    fn parse_session_update_extracts_verdict_from_params() {
        let params = json!({
            "sessionId": "s1",
            "verdict": {"verdict": "approve"}
        });

        let parsed = parse_session_update(&params).unwrap();
        assert_eq!(parsed.verdict, Some(json!({"verdict":"approve"})));
    }

    #[test]
    fn parse_session_update_extracts_result_from_params() {
        let params = json!({
            "sessionId": "s1",
            "result": {"result": "concern", "summary": "needs review"}
        });

        let parsed = parse_session_update(&params).unwrap();
        assert_eq!(
            parsed.verdict,
            Some(json!({"result":"concern","summary":"needs review"}))
        );
    }

    #[test]
    fn parse_session_update_prefers_result_over_legacy_verdict() {
        let params = json!({
            "sessionId": "s1",
            "result": {"result": "concern", "summary": "new"},
            "verdict": {"verdict": "approve"}
        });

        let parsed = parse_session_update(&params).unwrap();
        assert_eq!(
            parsed.verdict,
            Some(json!({"result":"concern","summary":"new"}))
        );
    }

    #[test]
    fn parse_session_update_extracts_verdict_from_nested_update() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "turn_complete",
                "verdict": {"verdict": "reject", "summary": "tests failed"}
            }
        });

        let parsed = parse_session_update(&params).unwrap();
        assert_eq!(
            parsed.verdict,
            Some(json!({"verdict":"reject","summary":"tests failed"}))
        );
    }

    #[test]
    fn parse_session_update_ignores_empty_content() {
        let params = json!({
            "sessionId": "s1",
            "content": ""
        });

        assert!(parse_session_update(&params).is_none());
    }

    #[test]
    fn parse_session_update_returns_none_for_unrecognized_update() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "noop"
            }
        });

        assert!(parse_session_update(&params).is_none());
    }

    #[test]
    fn parse_session_update_supports_content_object_and_string() {
        let object_params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "obj text"}
            }
        });
        let string_params = json!({
            "sessionId": "s1",
            "content": "str text"
        });

        let object_parsed = parse_session_update(&object_params).unwrap();
        let string_parsed = parse_session_update(&string_params).unwrap();
        assert_eq!(object_parsed.output_text.as_deref(), Some("obj text"));
        assert_eq!(string_parsed.output_text.as_deref(), Some("str text"));
    }
}
