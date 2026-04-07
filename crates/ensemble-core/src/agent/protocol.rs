use crate::agent::events::{JsonRpcMessage, StopReason, TokenUsage};

#[derive(Debug, Clone)]
pub struct PermissionRequest {
    pub permission_id: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct ParsedSessionUpdate {
    pub output_text: Option<String>,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<StopReason>,
    pub permission_request: Option<PermissionRequest>,
}

pub fn parse_jsonrpc(line: &str) -> Option<JsonRpcMessage> {
    serde_json::from_str::<JsonRpcMessage>(line).ok()
}

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

    Some(ParsedSessionUpdate {
        output_text,
        usage,
        stop_reason,
        permission_request,
    })
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
        return Some(text);
    }

    if let Some(text) = params.get("content").and_then(content_text) {
        return Some(text);
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
    fn parse_stop_reason_from_prompt_response_result() {
        let line = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": {"stopReason": "end_turn"}
        });

        let stop = parse_stop_reason_from_result(&line).unwrap();
        assert_eq!(stop, StopReason::EndTurn);
    }
}
