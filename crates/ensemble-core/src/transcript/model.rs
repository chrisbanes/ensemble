use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRecordKind {
    Prompt,
    AssistantMessage,
    Reasoning,
    ToolCall,
    ToolResult,
    PermissionRequest,
    PermissionResolution,
    TurnComplete,
    Error,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct TranscriptTruncation {
    pub original_bytes: usize,
    pub retained_head_bytes: usize,
    pub retained_tail_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct TranscriptRecord {
    pub schema_version: u32,
    pub run_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub attempt: u32,
    pub sequence: u64,
    pub timestamp: DateTime<Utc>,
    pub kind: TranscriptRecordKind,
    pub payload: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<TranscriptTruncation>,
}

pub fn sanitize_step_path_segment(value: &str) -> Option<String> {
    if value.is_empty() || value == "." || value == ".." {
        return None;
    }

    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        Some(value.to_string())
    } else {
        None
    }
}

pub fn sanitize_run_path_segment(value: &str) -> Option<String> {
    sanitize_step_path_segment(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_step_path_segment_accepts_pipeline_names() {
        assert_eq!(sanitize_step_path_segment("build").unwrap(), "build");
        assert_eq!(
            sanitize_step_path_segment("review-step").unwrap(),
            "review-step"
        );
        assert_eq!(
            sanitize_step_path_segment("review_step.2").unwrap(),
            "review_step.2"
        );
    }

    #[test]
    fn sanitize_step_path_segment_rejects_traversal() {
        assert!(sanitize_step_path_segment("../build").is_none());
        assert!(sanitize_step_path_segment("build/review").is_none());
        assert!(sanitize_step_path_segment("").is_none());
    }

    #[test]
    fn transcript_record_round_trips() {
        let record = TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence: 7,
            timestamp: chrono::Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": "hello"}),
            truncated: None,
        };

        let encoded = serde_json::to_string(&record).unwrap();
        let decoded: TranscriptRecord = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded.schema_version, TRANSCRIPT_SCHEMA_VERSION);
        assert_eq!(decoded.kind, TranscriptRecordKind::AssistantMessage);
        assert_eq!(decoded.payload["text"], "hello");
    }
}
