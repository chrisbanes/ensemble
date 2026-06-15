use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

use super::events::TranscriptEventBus;
use super::model::{
    TranscriptRecord, TranscriptRecordKind, TranscriptTruncation, TRANSCRIPT_SCHEMA_VERSION,
};
use super::writer::TranscriptWriter;

pub const COALESCE_MAX_BYTES: usize = 16 * 1024;
pub const TOOL_RESULT_MAX_BYTES: usize = 128 * 1024;
pub const TOOL_RESULT_HEAD_BYTES: usize = 96 * 1024;
pub const TOOL_RESULT_TAIL_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone)]
pub struct TranscriptPersistRequest {
    pub run_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub attempt: u32,
    pub timestamp: DateTime<Utc>,
    pub kind: TranscriptRecordKind,
    pub payload: serde_json::Value,
    pub truncated: Option<TranscriptTruncation>,
}

pub struct TranscriptPersistence {
    sender: Option<mpsc::Sender<TranscriptPersistCommand>>,
    handle: Option<JoinHandle<()>>,
}

impl TranscriptPersistence {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self::new_internal(workspace_root, None)
    }

    pub fn new_with_event_bus(workspace_root: PathBuf, event_bus: TranscriptEventBus) -> Self {
        Self::new_internal(workspace_root, Some(event_bus))
    }

    fn new_internal(workspace_root: PathBuf, event_bus: Option<TranscriptEventBus>) -> Self {
        let writer = TranscriptWriter::new(workspace_root);
        let (sender, mut receiver) = mpsc::channel::<TranscriptPersistCommand>(10_000);

        let handle = tokio::spawn(async move {
            let mut state = PersistState::default();
            while let Some(command) = receiver.recv().await {
                match command {
                    TranscriptPersistCommand::Record(req) => {
                        state.write_request(&writer, req, event_bus.as_ref()).await;
                    }
                    TranscriptPersistCommand::FlushStep { run_id, step_name } => {
                        state
                            .flush_step(&writer, &run_id, &step_name, event_bus.as_ref())
                            .await;
                    }
                }
            }
            state.flush_all(&writer, event_bus.as_ref()).await;
        });

        Self {
            sender: Some(sender),
            handle: Some(handle),
        }
    }

    pub fn send(&self, request: TranscriptPersistRequest) {
        self.send_command(TranscriptPersistCommand::Record(request));
    }

    pub fn flush_step(&self, run_id: String, step_name: String) {
        self.send_command(TranscriptPersistCommand::FlushStep { run_id, step_name });
    }

    fn send_command(&self, command: TranscriptPersistCommand) {
        if let Some(sender) = &self.sender {
            match sender.try_send(command) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    warn!("transcript persist channel full; transcript record dropped");
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    warn!("transcript persist channel closed; transcript record dropped");
                }
            }
        }
    }

    pub async fn flush(&mut self) {
        if let Some(sender) = self.sender.take() {
            drop(sender);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

enum TranscriptPersistCommand {
    Record(TranscriptPersistRequest),
    FlushStep { run_id: String, step_name: String },
}

impl Drop for TranscriptPersistence {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            drop(sender);
        }
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

#[derive(Default)]
struct PersistState {
    sequences: HashMap<(String, String), u64>,
    coalesced: HashMap<(String, String), TranscriptPersistRequest>,
}

impl PersistState {
    async fn write_request(
        &mut self,
        writer: &TranscriptWriter,
        mut req: TranscriptPersistRequest,
        event_bus: Option<&TranscriptEventBus>,
    ) {
        if should_coalesce(req.kind) {
            let key = (req.run_id.clone(), req.step_name.clone());
            if let Some(existing) = self.coalesced.get_mut(&key) {
                if can_merge_coalesced(existing, &req)
                    && merge_text_payload(&mut existing.payload, &req.payload)
                {
                    return;
                }
            }
            self.flush_key(writer, key.clone(), event_bus).await;
            self.coalesced.insert(key, req);
            return;
        }

        self.flush_step(writer, &req.run_id, &req.step_name, event_bus)
            .await;
        if req.kind == TranscriptRecordKind::ToolResult {
            let (payload, truncation) = truncate_tool_result_payload(req.payload);
            req.payload = payload;
            req.truncated = req.truncated.or(truncation);
        }
        self.append(writer, req, event_bus).await;
    }

    async fn flush_key(
        &mut self,
        writer: &TranscriptWriter,
        key: (String, String),
        event_bus: Option<&TranscriptEventBus>,
    ) {
        if let Some(req) = self.coalesced.remove(&key) {
            self.append(writer, req, event_bus).await;
        }
    }

    async fn flush_step(
        &mut self,
        writer: &TranscriptWriter,
        run_id: &str,
        step_name: &str,
        event_bus: Option<&TranscriptEventBus>,
    ) {
        let keys: Vec<_> = self
            .coalesced
            .keys()
            .filter(|(run, step)| run == run_id && step == step_name)
            .cloned()
            .collect();
        for key in keys {
            self.flush_key(writer, key, event_bus).await;
        }
    }

    async fn flush_all(
        &mut self,
        writer: &TranscriptWriter,
        event_bus: Option<&TranscriptEventBus>,
    ) {
        let keys: Vec<_> = self.coalesced.keys().cloned().collect();
        for key in keys {
            self.flush_key(writer, key, event_bus).await;
        }
    }

    async fn append(
        &mut self,
        writer: &TranscriptWriter,
        req: TranscriptPersistRequest,
        event_bus: Option<&TranscriptEventBus>,
    ) {
        let sequence_key = (req.run_id.clone(), req.step_name.clone());
        let sequence = self.sequences.entry(sequence_key).or_insert(0);
        *sequence += 1;

        let record = TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: req.run_id,
            issue_identifier: req.issue_identifier,
            step_name: req.step_name,
            attempt: req.attempt,
            sequence: *sequence,
            timestamp: req.timestamp,
            kind: req.kind,
            payload: req.payload,
            truncated: req.truncated,
        };

        match writer.append(&record).await {
            Ok(()) => {
                if let Some(event_bus) = event_bus {
                    event_bus.publish(record);
                }
            }
            Err(error) => {
                warn!(
                    event = "transcript_persist_failed",
                    run_id = %record.run_id,
                    step_name = %record.step_name,
                    error = %error,
                    "failed to persist transcript record"
                );
            }
        }
    }
}

fn should_coalesce(kind: TranscriptRecordKind) -> bool {
    matches!(
        kind,
        TranscriptRecordKind::AssistantMessage | TranscriptRecordKind::Reasoning
    )
}

fn can_merge_coalesced(
    existing: &TranscriptPersistRequest,
    next: &TranscriptPersistRequest,
) -> bool {
    existing.run_id == next.run_id
        && existing.step_name == next.step_name
        && existing.kind == next.kind
        && existing.attempt == next.attempt
        && existing.issue_identifier == next.issue_identifier
}

fn merge_text_payload(existing: &mut serde_json::Value, next: &serde_json::Value) -> bool {
    if !is_text_only_payload(existing) || !is_text_only_payload(next) {
        return false;
    }

    let existing_text = existing["text"].as_str().unwrap().to_string();
    let Some(next_text) = next.get("text").and_then(|value| value.as_str()) else {
        return false;
    };
    if existing_text.len() + next_text.len() > COALESCE_MAX_BYTES {
        return false;
    }

    existing["text"] = serde_json::Value::String(format!("{existing_text}{next_text}"));
    true
}

fn is_text_only_payload(payload: &serde_json::Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };

    object.len() == 1 && object.get("text").is_some_and(|value| value.is_string())
}

pub fn truncate_tool_result_payload(
    payload: serde_json::Value,
) -> (serde_json::Value, Option<TranscriptTruncation>) {
    let text_path = match tool_result_text_path(&payload) {
        Some(path) => path,
        None => return (payload, None),
    };
    let text = match text_path.get(&payload) {
        Some(text) => text,
        None => return (payload, None),
    };
    if text.len() <= TOOL_RESULT_MAX_BYTES {
        return (payload, None);
    }

    let head_end = floor_char_boundary(text, TOOL_RESULT_HEAD_BYTES.min(text.len()));
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(TOOL_RESULT_TAIL_BYTES));
    let head = &text[..head_end];
    let tail = &text[tail_start..];
    let retained = format!("{head}\n\n[truncated]\n\n{tail}");
    let truncation = TranscriptTruncation {
        original_bytes: text.len(),
        retained_head_bytes: head.len(),
        retained_tail_bytes: tail.len(),
    };

    let mut wrapper = payload;
    text_path.set(&mut wrapper, retained);
    (wrapper, Some(truncation))
}

#[derive(Clone, Copy)]
enum ToolResultTextPath {
    TopLevel,
    Content,
}

impl ToolResultTextPath {
    fn get<'a>(&self, payload: &'a serde_json::Value) -> Option<&'a str> {
        match self {
            Self::TopLevel => payload.get("text").and_then(|value| value.as_str()),
            Self::Content => payload
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(|value| value.as_str()),
        }
    }

    fn set(&self, payload: &mut serde_json::Value, text: String) {
        match self {
            Self::TopLevel => payload["text"] = serde_json::Value::String(text),
            Self::Content => payload["content"]["text"] = serde_json::Value::String(text),
        }
    }
}

fn tool_result_text_path(payload: &serde_json::Value) -> Option<ToolResultTextPath> {
    if payload
        .get("text")
        .and_then(|value| value.as_str())
        .is_some()
    {
        return Some(ToolResultTextPath::TopLevel);
    }
    if payload
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(|value| value.as_str())
        .is_some()
    {
        return Some(ToolResultTextPath::Content);
    }
    None
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::TranscriptRecordKind;
    use tempfile::TempDir;

    fn request(kind: TranscriptRecordKind, text: &str) -> TranscriptPersistRequest {
        TranscriptPersistRequest {
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            timestamp: chrono::Utc::now(),
            kind,
            payload: serde_json::json!({"text": text}),
            truncated: None,
        }
    }

    async fn read_records(temp_dir: &TempDir) -> Vec<crate::transcript::model::TranscriptRecord> {
        let contents = tokio::fs::read_to_string(
            temp_dir
                .path()
                .join(".ensemble/runs/run-1/steps/build/transcript.jsonl"),
        )
        .await
        .unwrap();
        contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn persistence_assigns_sequence_numbers() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "one"));
        persistence.send(request(TranscriptRecordKind::ToolCall, "tool"));
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records[0].sequence, 1);
        assert_eq!(records[1].sequence, 2);
    }

    #[tokio::test]
    async fn persistence_coalesces_adjacent_assistant_messages() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "hel"));
        persistence.send(request(TranscriptRecordKind::AssistantMessage, "lo"));
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload["text"], "hello");
    }

    #[tokio::test]
    async fn flush_step_persists_coalesced_message_without_closing_worker() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "hello"));
        persistence.flush_step("run-1".to_string(), "build".to_string());
        persistence.send(request(TranscriptRecordKind::ToolCall, "tool"));
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].kind, TranscriptRecordKind::AssistantMessage);
        assert_eq!(records[0].payload["text"], "hello");
        assert_eq!(records[1].kind, TranscriptRecordKind::ToolCall);
    }

    #[tokio::test]
    async fn persistence_publishes_after_successful_append() {
        let temp_dir = TempDir::new().unwrap();
        let bus = crate::transcript::events::TranscriptEventBus::new();
        let mut rx = bus.subscribe();
        let mut persistence =
            TranscriptPersistence::new_with_event_bus(temp_dir.path().to_path_buf(), bus);

        persistence.send(TranscriptPersistRequest {
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::ToolCall,
            payload: serde_json::json!({"name": "read_file"}),
            truncated: None,
        });

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        persistence.flush().await;

        assert_eq!(received.run_id, "run-1");
        assert_eq!(received.step_name, "build");
        assert_eq!(received.sequence, 1);
        assert_eq!(received.payload["name"], "read_file");
    }

    #[tokio::test]
    async fn persistence_publishes_coalesced_record_on_flush() {
        let temp_dir = TempDir::new().unwrap();
        let bus = crate::transcript::events::TranscriptEventBus::new();
        let mut rx = bus.subscribe();
        let mut persistence =
            TranscriptPersistence::new_with_event_bus(temp_dir.path().to_path_buf(), bus);

        for text in ["hel", "lo"] {
            persistence.send(TranscriptPersistRequest {
                run_id: "run-1".to_string(),
                issue_identifier: "repo#1".to_string(),
                step_name: "build".to_string(),
                attempt: 1,
                timestamp: Utc::now(),
                kind: TranscriptRecordKind::AssistantMessage,
                payload: serde_json::json!({"text": text}),
                truncated: None,
            });
        }
        persistence.flush_step("run-1".to_string(), "build".to_string());

        let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        persistence.flush().await;

        assert_eq!(received.sequence, 1);
        assert_eq!(received.payload["text"], "hello");
    }

    #[tokio::test]
    async fn persistence_does_not_coalesce_when_attempt_differs() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());
        let mut retry_request = request(TranscriptRecordKind::AssistantMessage, "two");
        retry_request.attempt = 2;

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "one"));
        persistence.send(retry_request);
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].attempt, 1);
        assert_eq!(records[0].payload["text"], "one");
        assert_eq!(records[1].attempt, 2);
        assert_eq!(records[1].payload["text"], "two");
    }

    #[tokio::test]
    async fn persistence_does_not_coalesce_when_issue_identifier_differs() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());
        let mut other_issue_request = request(TranscriptRecordKind::Reasoning, "second");
        other_issue_request.issue_identifier = "repo#2".to_string();

        persistence.send(request(TranscriptRecordKind::Reasoning, "first"));
        persistence.send(other_issue_request);
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].issue_identifier, "repo#1");
        assert_eq!(records[0].payload["text"], "first");
        assert_eq!(records[1].issue_identifier, "repo#2");
        assert_eq!(records[1].payload["text"], "second");
    }

    #[tokio::test]
    async fn persistence_does_not_coalesce_when_next_payload_has_extra_fields() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());
        let mut metadata_request = request(TranscriptRecordKind::AssistantMessage, "lo");
        metadata_request.payload = serde_json::json!({
            "text": "lo",
            "source": "tool"
        });

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "hel"));
        persistence.send(metadata_request);
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].payload, serde_json::json!({"text": "hel"}));
        assert_eq!(
            records[1].payload,
            serde_json::json!({"text": "lo", "source": "tool"})
        );
    }

    #[tokio::test]
    async fn persistence_does_not_coalesce_when_payload_metadata_values_differ() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());
        let mut first_request = request(TranscriptRecordKind::Reasoning, "first");
        first_request.payload = serde_json::json!({
            "text": "first",
            "source": "model"
        });
        let mut second_request = request(TranscriptRecordKind::Reasoning, "second");
        second_request.payload = serde_json::json!({
            "text": "second",
            "source": "tool"
        });

        persistence.send(first_request);
        persistence.send(second_request);
        persistence.flush().await;

        let records = read_records(&temp_dir).await;

        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].payload,
            serde_json::json!({"text": "first", "source": "model"})
        );
        assert_eq!(
            records[1].payload,
            serde_json::json!({"text": "second", "source": "tool"})
        );
    }

    #[test]
    fn truncate_large_payload_keeps_head_and_tail() {
        let input = "a".repeat(96 * 1024) + &"b".repeat(64 * 1024);
        let (payload, truncation) =
            truncate_tool_result_payload(serde_json::json!({"text": input}));

        let truncation = truncation.expect("large payload should be truncated");
        assert!(payload["text"].as_str().unwrap().starts_with("aaaa"));
        assert!(payload["text"].as_str().unwrap().ends_with("bbbb"));
        assert!(truncation.original_bytes > truncation.retained_head_bytes);
        assert_eq!(truncation.retained_tail_bytes, TOOL_RESULT_TAIL_BYTES);
    }

    #[test]
    fn truncate_large_nested_content_payload_keeps_shape() {
        let input = "a".repeat(96 * 1024) + &"b".repeat(64 * 1024);
        let (payload, truncation) = truncate_tool_result_payload(serde_json::json!({
            "tool_call_id": "call-1",
            "content": {
                "type": "text",
                "text": input
            }
        }));

        let truncation = truncation.expect("large nested payload should be truncated");
        let text = payload["content"]["text"].as_str().unwrap();
        assert!(text.starts_with("aaaa"));
        assert!(text.contains("[truncated]"));
        assert!(text.ends_with("bbbb"));
        assert_eq!(payload["content"]["type"], "text");
        assert_eq!(truncation.original_bytes, 160 * 1024);
    }
}
