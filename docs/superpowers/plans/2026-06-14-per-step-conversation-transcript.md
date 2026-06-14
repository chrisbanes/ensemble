# Per-Step Conversation Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and serve one typed JSONL conversation transcript per pipeline step, replacing the old issue-level conversation route with run/step-scoped transcript data.

**Architecture:** Add a focused `transcript` module for record models, writing, persistence, coalescing, truncation, and reading. Extend ACP parsing and runtime events so transcript-worthy protocol blocks reach the orchestrator before data is lost, then expose those files through run/step-scoped API routes and update the UI transcript model to consume the new record shape.

**Tech Stack:** Rust 2021, Tokio, Serde/serde_json, Chrono, Axum, Utoipa, existing ACP runtime/parser code, React/TypeScript/Vitest frontend, Orval-generated API client.

---

## Scope Check

This plan implements one cohesive feature from the approved spec:

- backend transcript persistence
- ACP runtime transcript extraction
- run/step-scoped conversation API
- frontend consumption of transcript records
- documentation and product E2E coverage

Although it crosses backend and frontend, the UI depends directly on the new API contract, so it should stay in one implementation plan.

## File Structure

- Create `crates/ensemble-core/src/transcript/mod.rs`  
  Re-export transcript model, writer, persistence, and reader APIs.
- Create `crates/ensemble-core/src/transcript/model.rs`  
  Define `TranscriptRecord`, `TranscriptRecordKind`, payload structs, truncation metadata, and request/path-safe identifiers.
- Create `crates/ensemble-core/src/transcript/writer.rs`  
  Own filesystem paths and append-only JSONL writes.
- Create `crates/ensemble-core/src/transcript/persistence.rs`  
  Own async channel, sequencing, coalescing, truncation, and flush behavior.
- Create `crates/ensemble-core/src/transcript/reader.rs`  
  Read, parse, paginate, and lookup transcript records.
- Modify `crates/ensemble-core/src/lib.rs`  
  Add `pub mod transcript;`.
- Modify `crates/ensemble-core/src/agent/protocol.rs`  
  Extract transcript blocks from ACP `session/update` payloads without changing existing verdict/token parsing.
- Modify `crates/ensemble-core/src/agent/events.rs`  
  Add transcript event payloads to `AgentEvent`.
- Modify `crates/ensemble-core/src/agent/acpx_cli.rs`  
  Emit transcript blocks from the acpx JSON-RPC path.
- Modify `crates/ensemble-core/src/agent/acp_client.rs`  
  Emit transcript blocks from the direct ACP SDK path.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`  
  Add `TranscriptPersistence`, persist transcript blocks with run context, and flush on shutdown.
- Rewrite `crates/ensemble-core/src/api/conversation.rs`  
  Replace old issue-level conversation shape with run/step-scoped transcript endpoints.
- Modify `crates/ensemble-core/src/api/router.rs`  
  Mount new route paths and remove old route paths.
- Modify `crates/ensemble-core/src/api/openapi.rs`  
  Replace old conversation schemas with transcript response schemas.
- Modify `crates/ensemble-core/tests/api_endpoints.rs` and `crates/ensemble-cli/tests/product_e2e.rs`  
  Cover route behavior and end-to-end transcript persistence.
- Modify `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts` and tests  
  Map generated transcript records into existing UI transcript entries.
- Modify `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` and tests  
  Fetch step-scoped transcript records instead of the old issue-level conversation messages.
- Update `docs/SPEC.md` and `docs/pipelines.md`  
  Document the new transcript persistence and debugging contract.

---

### Task 1: Transcript Model, Writer, And Reader

**Files:**
- Create: `crates/ensemble-core/src/transcript/mod.rs`
- Create: `crates/ensemble-core/src/transcript/model.rs`
- Create: `crates/ensemble-core/src/transcript/writer.rs`
- Create: `crates/ensemble-core/src/transcript/reader.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Write failing model, writer, and reader tests**

Add tests in the new files as shown below.

In `crates/ensemble-core/src/transcript/model.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_step_path_segment_accepts_pipeline_names() {
        assert_eq!(sanitize_step_path_segment("build").unwrap(), "build");
        assert_eq!(sanitize_step_path_segment("review-step").unwrap(), "review-step");
        assert_eq!(sanitize_step_path_segment("review_step.2").unwrap(), "review_step.2");
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
```

In `crates/ensemble-core/src/transcript/writer.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION};
    use chrono::Utc;
    use tempfile::TempDir;

    fn sample_record(sequence: u64) -> TranscriptRecord {
        TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": "hello"}),
            truncated: None,
        }
    }

    #[tokio::test]
    async fn append_writes_step_transcript_jsonl() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());

        writer.append(&sample_record(1)).await.unwrap();

        let path = writer.transcript_path("run-1", "build").unwrap();
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        let parsed: TranscriptRecord = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(parsed.sequence, 1);
        assert_eq!(parsed.step_name, "build");
    }

    #[test]
    fn transcript_path_rejects_unsafe_segments() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());

        assert!(writer.transcript_path("../run", "build").is_err());
        assert!(writer.transcript_path("run-1", "../build").is_err());
    }
}
```

In `crates/ensemble-core/src/transcript/reader.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION};
    use crate::transcript::writer::TranscriptWriter;
    use chrono::Utc;
    use tempfile::TempDir;

    fn sample_record(sequence: u64) -> TranscriptRecord {
        TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": format!("message-{sequence}")}),
            truncated: None,
        }
    }

    #[tokio::test]
    async fn read_transcript_paginates_records() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        writer.append(&sample_record(2)).await.unwrap();
        writer.append(&sample_record(3)).await.unwrap();

        let response = read_transcript_page(temp_dir.path(), "run-1", "build", Some(1), Some(1))
            .await
            .unwrap();

        assert_eq!(response.records.len(), 1);
        assert_eq!(response.records[0].sequence, 2);
        assert_eq!(response.total, 3);
        assert_eq!(response.next_cursor, Some(2));
    }

    #[tokio::test]
    async fn read_transcript_returns_empty_for_missing_file() {
        let temp_dir = TempDir::new().unwrap();
        let response = read_transcript_page(temp_dir.path(), "run-1", "build", None, None)
            .await
            .unwrap();

        assert!(response.records.is_empty());
        assert_eq!(response.total, 0);
        assert_eq!(response.next_cursor, None);
    }

    #[tokio::test]
    async fn read_transcript_record_finds_sequence() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(9)).await.unwrap();

        let record = read_transcript_record(temp_dir.path(), "run-1", "build", 9)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(record.sequence, 9);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core transcript::
```

Expected: compile failure because the `transcript` module and types do not exist.

- [ ] **Step 3: Add model, writer, and reader implementation**

Create `crates/ensemble-core/src/transcript/mod.rs`:

```rust
pub mod model;
pub mod reader;
pub mod writer;
```

Create `crates/ensemble-core/src/transcript/model.rs`:

```rust
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
```

Create `crates/ensemble-core/src/transcript/writer.rs`:

```rust
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use super::model::{sanitize_run_path_segment, sanitize_step_path_segment, TranscriptRecord};

#[derive(Debug, Clone)]
pub struct TranscriptWriter {
    workspace_root: PathBuf,
}

impl TranscriptWriter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn transcript_path(&self, run_id: &str, step_name: &str) -> Result<PathBuf, std::io::Error> {
        let run_id = sanitize_run_path_segment(run_id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid run id")
        })?;
        let step_name = sanitize_step_path_segment(step_name).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid step name")
        })?;

        Ok(self
            .workspace_root
            .join(".ensemble")
            .join("runs")
            .join(run_id)
            .join("steps")
            .join(step_name)
            .join("transcript.jsonl"))
    }

    pub async fn append(&self, record: &TranscriptRecord) -> Result<(), std::io::Error> {
        let path = self.transcript_path(&record.run_id, &record.step_name)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut line = serde_json::to_string(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }
}
```

Create `crates/ensemble-core/src/transcript/reader.rs`:

```rust
use std::path::Path;

use serde::Serialize;

use super::model::TranscriptRecord;
use super::writer::TranscriptWriter;

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TranscriptResponse {
    pub records: Vec<TranscriptRecord>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

async fn read_transcript_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_transcript_records(contents: &str) -> Result<Vec<TranscriptRecord>, serde_json::Error> {
    contents.lines().map(serde_json::from_str).collect()
}

pub async fn read_transcript_page(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptResponse, Box<dyn std::error::Error + Send + Sync>> {
    let writer = TranscriptWriter::new(workspace_root.to_path_buf());
    let path = writer.transcript_path(run_id, step_name)?;
    let Some(contents) = read_transcript_file(&path).await? else {
        return Ok(TranscriptResponse {
            records: vec![],
            total: 0,
            next_cursor: None,
        });
    };

    let records = parse_transcript_records(&contents)?;
    let total = records.len();
    let cursor = cursor.unwrap_or(0);
    let limit = limit.unwrap_or(50).min(200);
    let page: Vec<TranscriptRecord> = records.into_iter().skip(cursor).take(limit).collect();
    let next_cursor = if cursor + page.len() < total {
        Some(cursor + page.len())
    } else {
        None
    };

    Ok(TranscriptResponse {
        records: page,
        total,
        next_cursor,
    })
}

pub async fn read_transcript_record(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
    sequence: u64,
) -> Result<Option<TranscriptRecord>, Box<dyn std::error::Error + Send + Sync>> {
    let response = read_transcript_page(workspace_root, run_id, step_name, None, Some(usize::MAX))
        .await?;
    Ok(response.records.into_iter().find(|record| record.sequence == sequence))
}
```

Modify `crates/ensemble-core/src/lib.rs`:

```rust
pub mod transcript;
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cargo test -p ensemble-core transcript::
```

Expected: transcript model, writer, and reader tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/lib.rs crates/ensemble-core/src/transcript/
git commit -m "feat: add step transcript storage model"
```

---

### Task 2: Transcript Persistence, Sequencing, Coalescing, And Truncation

**Files:**
- Modify: `crates/ensemble-core/src/transcript/mod.rs`
- Create: `crates/ensemble-core/src/transcript/persistence.rs`
- Modify: `crates/ensemble-core/src/transcript/model.rs`

- [ ] **Step 1: Write failing persistence tests**

Create `crates/ensemble-core/src/transcript/persistence.rs` with tests first:

```rust
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

    #[tokio::test]
    async fn persistence_assigns_sequence_numbers() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TranscriptPersistence::new(temp_dir.path().to_path_buf());

        persistence.send(request(TranscriptRecordKind::AssistantMessage, "one"));
        persistence.send(request(TranscriptRecordKind::ToolCall, "tool"));
        persistence.flush().await;

        let contents = tokio::fs::read_to_string(
            temp_dir.path().join(".ensemble/runs/run-1/steps/build/transcript.jsonl"),
        )
        .await
        .unwrap();
        let records: Vec<crate::transcript::model::TranscriptRecord> =
            contents.lines().map(|line| serde_json::from_str(line).unwrap()).collect();

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

        let contents = tokio::fs::read_to_string(
            temp_dir.path().join(".ensemble/runs/run-1/steps/build/transcript.jsonl"),
        )
        .await
        .unwrap();
        let records: Vec<crate::transcript::model::TranscriptRecord> =
            contents.lines().map(|line| serde_json::from_str(line).unwrap()).collect();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload["text"], "hello");
    }

    #[test]
    fn truncate_large_payload_keeps_head_and_tail() {
        let input = "a".repeat(96 * 1024) + &"b".repeat(64 * 1024);
        let (payload, truncation) = truncate_tool_result_payload(serde_json::json!({"text": input}));

        let truncation = truncation.expect("large payload should be truncated");
        assert!(payload["text"].as_str().unwrap().starts_with("aaaa"));
        assert!(payload["text"].as_str().unwrap().ends_with("bbbb"));
        assert!(truncation.original_bytes > truncation.retained_head_bytes);
        assert_eq!(truncation.retained_tail_bytes, TOOL_RESULT_TAIL_BYTES);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core transcript::persistence
```

Expected: compile failure because persistence types and truncation helpers do not exist.

- [ ] **Step 3: Implement persistence**

Add to `crates/ensemble-core/src/transcript/mod.rs`:

```rust
pub mod persistence;
```

Add to `crates/ensemble-core/src/transcript/persistence.rs`:

```rust
use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

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
    sender: Option<mpsc::Sender<TranscriptPersistRequest>>,
    handle: Option<JoinHandle<()>>,
}

impl TranscriptPersistence {
    pub fn new(workspace_root: PathBuf) -> Self {
        let writer = TranscriptWriter::new(workspace_root);
        let (sender, mut receiver) = mpsc::channel::<TranscriptPersistRequest>(10_000);

        let handle = tokio::spawn(async move {
            let mut state = PersistState::default();
            while let Some(req) = receiver.recv().await {
                state.write_request(&writer, req).await;
            }
            state.flush_all(&writer).await;
        });

        Self {
            sender: Some(sender),
            handle: Some(handle),
        }
    }

    pub fn send(&self, request: TranscriptPersistRequest) {
        if let Some(sender) = &self.sender {
            match sender.try_send(request) {
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
    coalesced: HashMap<(String, String, TranscriptRecordKind), TranscriptPersistRequest>,
}

impl PersistState {
    async fn write_request(&mut self, writer: &TranscriptWriter, mut req: TranscriptPersistRequest) {
        if should_coalesce(req.kind) {
            let key = (req.run_id.clone(), req.step_name.clone(), req.kind);
            if let Some(existing) = self.coalesced.get_mut(&key) {
                if merge_text_payload(&mut existing.payload, &req.payload) {
                    return;
                }
            }
            self.flush_key(writer, key.clone()).await;
            self.coalesced.insert(key, req);
            return;
        }

        self.flush_step(writer, &req.run_id, &req.step_name).await;
        if req.kind == TranscriptRecordKind::ToolResult {
            let (payload, truncation) = truncate_tool_result_payload(req.payload);
            req.payload = payload;
            req.truncated = req.truncated.or(truncation);
        }
        self.append(writer, req).await;
    }

    async fn flush_key(&mut self, writer: &TranscriptWriter, key: (String, String, TranscriptRecordKind)) {
        if let Some(req) = self.coalesced.remove(&key) {
            self.append(writer, req).await;
        }
    }

    async fn flush_step(&mut self, writer: &TranscriptWriter, run_id: &str, step_name: &str) {
        let keys: Vec<_> = self
            .coalesced
            .keys()
            .filter(|(run, step, _)| run == run_id && step == step_name)
            .cloned()
            .collect();
        for key in keys {
            self.flush_key(writer, key).await;
        }
    }

    async fn flush_all(&mut self, writer: &TranscriptWriter) {
        let keys: Vec<_> = self.coalesced.keys().cloned().collect();
        for key in keys {
            self.flush_key(writer, key).await;
        }
    }

    async fn append(&mut self, writer: &TranscriptWriter, req: TranscriptPersistRequest) {
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

        if let Err(error) = writer.append(&record).await {
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

fn should_coalesce(kind: TranscriptRecordKind) -> bool {
    matches!(kind, TranscriptRecordKind::AssistantMessage | TranscriptRecordKind::Reasoning)
}

fn merge_text_payload(existing: &mut serde_json::Value, next: &serde_json::Value) -> bool {
    let Some(existing_text) = existing.get_mut("text").and_then(|value| value.as_str().map(str::to_string)) else {
        return false;
    };
    let Some(next_text) = next.get("text").and_then(|value| value.as_str()) else {
        return false;
    };
    if existing_text.len() + next_text.len() > COALESCE_MAX_BYTES {
        return false;
    }

    existing["text"] = serde_json::Value::String(format!("{existing_text}{next_text}"));
    true
}

pub fn truncate_tool_result_payload(
    payload: serde_json::Value,
) -> (serde_json::Value, Option<TranscriptTruncation>) {
    let text = match payload.get("text").and_then(|value| value.as_str()) {
        Some(text) => text,
        None => return (payload, None),
    };
    if text.len() <= TOOL_RESULT_MAX_BYTES {
        return (payload, None);
    }

    let head = &text[..TOOL_RESULT_HEAD_BYTES.min(text.len())];
    let tail_start = text.len().saturating_sub(TOOL_RESULT_TAIL_BYTES);
    let tail = &text[tail_start..];
    let retained = format!("{head}\n\n[truncated]\n\n{tail}");
    let truncation = TranscriptTruncation {
        original_bytes: text.len(),
        retained_head_bytes: head.len(),
        retained_tail_bytes: tail.len(),
    };

    let mut wrapper = payload;
    wrapper["text"] = serde_json::Value::String(retained);
    (wrapper, Some(truncation))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cargo test -p ensemble-core transcript::persistence
```

Expected: persistence tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/transcript/
git commit -m "feat: persist step transcript records"
```

---

### Task 3: ACP Parser Transcript Blocks

**Files:**
- Modify: `crates/ensemble-core/src/agent/protocol.rs`
- Modify: `crates/ensemble-core/src/agent/events.rs`

- [ ] **Step 1: Write failing parser tests**

Add to `crates/ensemble-core/src/agent/protocol.rs` tests:

```rust
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
    assert_eq!(parsed.transcript_blocks[0].kind, TranscriptBlockKind::ToolCall);
    assert_eq!(parsed.transcript_blocks[0].payload["tool_call_id"], "call-1");
    assert_eq!(parsed.transcript_blocks[0].payload["name"], "read_file");
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
    assert_eq!(parsed.transcript_blocks[0].kind, TranscriptBlockKind::Reasoning);
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
    assert_eq!(parsed.transcript_blocks[0].kind, TranscriptBlockKind::AssistantMessage);
    assert_eq!(parsed.transcript_blocks[0].payload["text"], "hello");
}
```

Add to `crates/ensemble-core/src/agent/events.rs` tests:

```rust
#[test]
fn transcript_block_event_has_stable_name() {
    let event = AgentEvent::TranscriptBlock {
        kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
        payload: serde_json::json!({"text": "hello"}),
    };

    assert_eq!(event.event_name(), "transcript_block");
    assert_eq!(event.message_for_state().as_deref(), Some("hello"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core agent::protocol agent::events
```

Expected: compile failure because `TranscriptBlockKind`, `TranscriptBlock`, and `AgentEvent::TranscriptBlock` do not exist.

- [ ] **Step 3: Implement parser transcript block extraction**

In `crates/ensemble-core/src/agent/protocol.rs`, add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
```

Extend `ParsedSessionUpdate`:

```rust
pub struct ParsedSessionUpdate {
    pub output_text: Option<String>,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<StopReason>,
    pub permission_request: Option<PermissionRequest>,
    pub verdict: Option<serde_json::Value>,
    pub transcript_blocks: Vec<TranscriptBlock>,
}
```

In `parse_session_update`, compute and include blocks:

```rust
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
```

Add helpers:

```rust
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

    if let Some(text) = output_text {
        return vec![TranscriptBlock {
            kind: TranscriptBlockKind::AssistantMessage,
            payload: serde_json::json!({"text": text}),
        }];
    }

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

    vec![]
}
```

In `crates/ensemble-core/src/agent/events.rs`, import `TranscriptBlockKind` and add:

```rust
TranscriptBlock {
    kind: TranscriptBlockKind,
    payload: serde_json::Value,
},
```

Add `event_name` branch:

```rust
AgentEvent::TranscriptBlock { .. } => "transcript_block",
```

Add `message_for_state` branch:

```rust
AgentEvent::TranscriptBlock { payload, .. } => payload
    .get("text")
    .and_then(|value| value.as_str())
    .map(truncate_for_state),
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cargo test -p ensemble-core agent::protocol agent::events
```

Expected: parser and event tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/protocol.rs crates/ensemble-core/src/agent/events.rs
git commit -m "feat: parse ACP transcript blocks"
```

---

### Task 4: Runtime Emission And Orchestrator Persistence

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Write failing runtime/orchestrator tests**

In `crates/ensemble-core/src/agent/acpx_cli.rs`, add a test near existing session update tests:

```rust
#[tokio::test]
async fn prompt_emits_transcript_blocks_for_visible_updates() {
    let script = make_acpx_script(
        r#"
if [ "$1" = "sessions" ] && [ "$2" = "ensure" ]; then
  echo "session"
  exit 0
fi
if [ "$1" = "prompt" ]; then
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"turn_complete","stopReason":"end_turn"}}}'
  exit 0
fi
"#,
    );

    let mut events = Vec::new();
    run_prompt_command_for_test(script.path(), |event| {
        events.push(event);
        async {}
    })
    .await
    .unwrap();

    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::TranscriptBlock {
            kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
            ..
        }
    )));
}
```

Use the existing test helpers in `acpx_cli.rs`; if helper names differ, adapt the test to the local helpers without changing the assertion.

In `crates/ensemble-core/src/orchestrator/mod.rs`, add an orchestrator unit test near timeline persistence tests:

```rust
#[tokio::test]
async fn handle_agent_update_persists_transcript_block() {
    let dir = tempfile::TempDir::new().unwrap();
    let orchestrator = make_test_orchestrator_with_workspace_root(dir.path()).await;
    seed_running_issue_with_run_id(&orchestrator, "issue-1", "repo#1", "run-1").await;

    orchestrator
        .handle_worker_event(WorkerEvent::AgentUpdate {
            issue_id: "issue-1".to_string(),
            step_name: "build".to_string(),
            event: AgentEvent::TranscriptBlock {
                kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                payload: serde_json::json!({"text": "hello"}),
            },
            timestamp: chrono::Utc::now(),
        })
        .await;

    orchestrator.flush_transcript_persistence_for_tests().await;

    let contents = tokio::fs::read_to_string(
        dir.path().join(".ensemble/runs/run-1/steps/build/transcript.jsonl"),
    )
    .await
    .unwrap();
    assert!(contents.contains("\"assistant_message\""));
    assert!(contents.contains("\"hello\""));
}
```

If the local test harness does not expose those helper names, create private test helpers in the orchestrator test module that construct the existing test orchestrator and insert a running entry with `run_id: Some("run-1".to_string())`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core prompt_emits_transcript_blocks_for_visible_updates handle_agent_update_persists_transcript_block
```

Expected: compile failure because runtime emission and orchestrator persistence are not wired.

- [ ] **Step 3: Emit transcript blocks from runtimes**

In `crates/ensemble-core/src/agent/acpx_cli.rs`, after parsing an update and before consuming fields, emit blocks:

```rust
for block in update.transcript_blocks.clone() {
    if visible {
        on_event(AgentEvent::TranscriptBlock {
            kind: block.kind,
            payload: block.payload,
        })
        .await;
    }
}
```

In `crates/ensemble-core/src/agent/acp_client.rs`, in the `SessionMessage::SessionMessage(dispatch)` branch after `parse_sdk_dispatch`, emit blocks:

```rust
for block in parsed.transcript_blocks.clone() {
    if visible {
        emit_event(
            event_tx,
            issue_id,
            step_name,
            AgentEvent::TranscriptBlock {
                kind: block.kind,
                payload: block.payload,
            },
        )
        .await;
    }
}
```

- [ ] **Step 4: Wire orchestrator transcript persistence**

In `crates/ensemble-core/src/orchestrator/mod.rs`, import:

```rust
use crate::transcript::model::TranscriptRecordKind;
use crate::transcript::persistence::{TranscriptPersistRequest, TranscriptPersistence};
```

Add a field to `Orchestrator`:

```rust
transcript_persistence: Option<TranscriptPersistence>,
```

Initialize beside timeline persistence:

```rust
transcript_persistence: Some(TranscriptPersistence::new(parts.workspace_root.clone())),
```

Flush on shutdown after timeline flush:

```rust
if let Some(ref mut persistence) = self.transcript_persistence {
    persistence.flush().await;
}
```

In `handle_agent_update`, before dropping state, convert transcript blocks:

```rust
let transcript_request = match &event {
    AgentEvent::TranscriptBlock { kind, payload } => run_id.as_ref().map(|run_id| {
        TranscriptPersistRequest {
            run_id: run_id.clone(),
            issue_identifier: issue_identifier.clone(),
            step_name: step_name.to_string(),
            attempt: attempt_num,
            timestamp,
            kind: transcript_kind_from_agent_kind(*kind),
            payload: payload.clone(),
            truncated: None,
        }
    }),
    _ => None,
};
```

After `drop(state);`, send the request:

```rust
if let Some(request) = transcript_request {
    if let Some(ref persistence) = self.transcript_persistence {
        persistence.send(request);
    }
}
```

Add mapper:

```rust
fn transcript_kind_from_agent_kind(
    kind: crate::agent::protocol::TranscriptBlockKind,
) -> TranscriptRecordKind {
    match kind {
        crate::agent::protocol::TranscriptBlockKind::AssistantMessage => {
            TranscriptRecordKind::AssistantMessage
        }
        crate::agent::protocol::TranscriptBlockKind::Reasoning => TranscriptRecordKind::Reasoning,
        crate::agent::protocol::TranscriptBlockKind::ToolCall => TranscriptRecordKind::ToolCall,
        crate::agent::protocol::TranscriptBlockKind::ToolResult => TranscriptRecordKind::ToolResult,
        crate::agent::protocol::TranscriptBlockKind::PermissionRequest => {
            TranscriptRecordKind::PermissionRequest
        }
        crate::agent::protocol::TranscriptBlockKind::TurnComplete => TranscriptRecordKind::TurnComplete,
        crate::agent::protocol::TranscriptBlockKind::Raw => TranscriptRecordKind::Raw,
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cargo test -p ensemble-core prompt_emits_transcript_blocks_for_visible_updates handle_agent_update_persists_transcript_block
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: persist runtime transcript blocks"
```

---

### Task 5: Run/Step-Scoped Conversation API

**Files:**
- Rewrite: `crates/ensemble-core/src/api/conversation.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Modify: `crates/ensemble-core/tests/openapi_spec.rs`

- [ ] **Step 1: Write failing API tests**

In `crates/ensemble-core/tests/api_endpoints.rs`, add:

```rust
#[tokio::test]
async fn get_step_conversation_returns_transcript_records() {
    let temp = tempfile::TempDir::new().unwrap();
    let app = test_app_with_workspace_root(temp.path()).await;
    let workspace_key = ensemble_core::tracker::model::sanitize_workspace_key("repo#1").unwrap();
    let transcript_dir = temp
        .path()
        .join(workspace_key)
        .join(".ensemble/runs/run-1/steps/build");
    tokio::fs::create_dir_all(&transcript_dir).await.unwrap();
    tokio::fs::write(
        transcript_dir.join("transcript.jsonl"),
        r#"{"schema_version":1,"run_id":"run-1","issue_identifier":"repo#1","step_name":"build","attempt":1,"sequence":1,"timestamp":"2026-06-14T00:00:00Z","kind":"assistant_message","payload":{"text":"hello"}}"#,
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/v1/repo%231/runs/run-1/steps/build/conversation")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["records"][0]["kind"], "assistant_message");
    assert_eq!(body["records"][0]["payload"]["text"], "hello");
}

#[tokio::test]
async fn old_issue_conversation_route_is_removed() {
    let temp = tempfile::TempDir::new().unwrap();
    let app = test_app_with_workspace_root(temp.path()).await;

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/v1/repo%231/conversation")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
}
```

Use the existing `api_endpoints.rs` app-state helper names. If `test_app_with_workspace_root` does not exist, add a small helper in that file that creates the existing test app state and assigns `workspace_root`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints get_step_conversation_returns_transcript_records old_issue_conversation_route_is_removed
```

Expected: first test returns 404 and second may still return 200 because routes are not rewritten.

- [ ] **Step 3: Rewrite conversation API**

Replace `ConversationMessage` and `ConversationResponse` with transcript response usage in `crates/ensemble-core/src/api/conversation.rs`:

```rust
use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use crate::tracker::model::sanitize_workspace_key;
use crate::transcript::reader::{read_transcript_page, read_transcript_record, TranscriptResponse};
use crate::transcript::model::TranscriptRecord;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub struct ConversationQuery {
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

fn workspace_path(workspace_root: &str, identifier: &str) -> Result<PathBuf, ApiError> {
    let workspace_key = sanitize_workspace_key(identifier).ok_or_else(|| {
        ApiError::new(
            "invalid_identifier",
            "identifier cannot be sanitized to a workspace key",
        )
    })?;
    Ok(PathBuf::from(workspace_root).join(workspace_key))
}
```

Define list endpoint:

```rust
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation",
    operation_id = "getStepConversation",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("run_id" = String, Path, description = "Run id"),
        ("step_name" = String, Path, description = "Step name"),
        ConversationQuery,
    ),
    responses(
        (status = 200, description = "Step transcript records", body = TranscriptResponse),
        (status = 400, description = "Invalid path", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation(
    State(state): State<AppState>,
    Path((identifier, run_id, step_name)): Path<(String, String, String)>,
    Query(query): Query<ConversationQuery>,
) -> impl IntoResponse {
    let workspace_path = match workspace_path(&state.workspace_root, &identifier) {
        Ok(path) => path,
        Err(error) => return (StatusCode::BAD_REQUEST, Json(error)).into_response(),
    };

    match read_transcript_page(&workspace_path, &run_id, &step_name, query.cursor, query.limit).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::InvalidInput) => {
            (StatusCode::BAD_REQUEST, api_error("invalid_path", "run id or step name is invalid")).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            api_error("conversation_read_error", format!("failed to read transcript: {error}")),
        )
            .into_response(),
    }
}
```

Define single-record endpoint:

```rust
#[utoipa::path(
    get,
    path = "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}",
    operation_id = "getStepConversationRecord",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("run_id" = String, Path, description = "Run id"),
        ("step_name" = String, Path, description = "Step name"),
        ("sequence" = u64, Path, description = "Transcript sequence"),
    ),
    responses(
        (status = 200, description = "Transcript record", body = TranscriptRecord),
        (status = 404, description = "Record not found", body = ApiError)
    ),
    tag = "conversation"
)]
pub async fn get_conversation_message(
    State(state): State<AppState>,
    Path((identifier, run_id, step_name, sequence)): Path<(String, String, String, u64)>,
) -> impl IntoResponse {
    let workspace_path = match workspace_path(&state.workspace_root, &identifier) {
        Ok(path) => path,
        Err(error) => return (StatusCode::BAD_REQUEST, Json(error)).into_response(),
    };

    match read_transcript_record(&workspace_path, &run_id, &step_name, sequence).await {
        Ok(Some(record)) => (StatusCode::OK, Json(record)).into_response(),
        Ok(None) => api_error("message_not_found", format!("no transcript record at sequence {sequence}")).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            api_error("conversation_read_error", format!("failed to read transcript: {error}")),
        )
            .into_response(),
    }
}
```

- [ ] **Step 4: Update router and OpenAPI**

In `crates/ensemble-core/src/api/router.rs`, replace old routes:

```rust
.route(
    "/{identifier}/runs/{run_id}/steps/{step_name}/conversation",
    get(conversation::get_conversation),
)
.route(
    "/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}",
    get(conversation::get_conversation_message),
)
```

Update endpoint comments in the router doc comment to describe the new routes.

In `crates/ensemble-core/src/api/openapi.rs`, replace components:

```rust
crate::transcript::reader::TranscriptResponse,
crate::transcript::model::TranscriptRecord,
crate::transcript::model::TranscriptRecordKind,
crate::transcript::model::TranscriptTruncation,
```

Remove:

```rust
crate::api::conversation::ConversationResponse,
crate::api::conversation::ConversationMessage,
```

- [ ] **Step 5: Run API and OpenAPI tests**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints get_step_conversation_returns_transcript_records old_issue_conversation_route_is_removed
cargo test -p ensemble-core --test openapi_spec
```

Expected: targeted API tests pass and OpenAPI spec generation passes.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/api/conversation.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/tests/api_endpoints.rs crates/ensemble-core/tests/openapi_spec.rs
git commit -m "feat: expose step transcript conversation API"
```

---

### Task 6: Frontend Transcript Consumption

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Regenerate if needed: `crates/ensemble-ui/src-ui/src/generated/`

- [ ] **Step 1: Regenerate API client after backend OpenAPI changes**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm run generate
```

Expected: generated models include `TranscriptRecord`, `TranscriptRecordKind`, `TranscriptResponse`, and no code depends on the old `ConversationMessage` response contract.

- [ ] **Step 2: Write failing transcript model tests**

In `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`, add:

```ts
it("maps transcript records into agent and tool activity entries", () => {
  const entries = buildTranscriptEntries({
    conversation: [],
    transcriptRecords: [
      {
        schema_version: 1,
        run_id: "run-1",
        issue_identifier: "repo#1",
        step_name: "build",
        attempt: 1,
        sequence: 1,
        timestamp: "2026-06-14T00:00:00Z",
        kind: "assistant_message",
        payload: { text: "hello" },
      },
      {
        schema_version: 1,
        run_id: "run-1",
        issue_identifier: "repo#1",
        step_name: "build",
        attempt: 1,
        sequence: 2,
        timestamp: "2026-06-14T00:00:01Z",
        kind: "tool_call",
        payload: { name: "read_file", arguments: { path: "Cargo.toml" } },
      },
    ],
    interactions: [],
    timelineEvents: [],
    issue: null,
    sourceStatus: {},
  });

  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent_message" }),
      expect.objectContaining({ kind: "tool_activity" }),
    ]),
  );
});
```

- [ ] **Step 3: Run frontend test to verify it fails**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test transcript-model.test.ts
```

Expected: TypeScript/test failure because `transcriptRecords` is not part of the transcript model source.

- [ ] **Step 4: Update transcript model**

In `transcript-model.ts`, update the source type:

```ts
import type { TranscriptRecord } from "@/generated/models";

export interface TranscriptSource {
  conversation: ConversationMessage[];
  transcriptRecords?: TranscriptRecord[];
  interactions: InteractionDetail[];
  timelineEvents: TimelineEventRecord[];
  issue: IssueDetailSnapshot | null;
  sourceStatus?: TranscriptSourceStatus;
}
```

Add a mapping helper:

```ts
function entryFromTranscriptRecord(record: TranscriptRecord): TranscriptEntry | null {
  const timestamp = record.timestamp;
  const id = `transcript:${record.run_id}:${record.step_name}:${record.sequence}`;
  const text =
    typeof record.payload === "object" && record.payload != null && "text" in record.payload
      ? String((record.payload as { text?: unknown }).text ?? "")
      : JSON.stringify(record.payload);

  if (record.kind === "assistant_message") {
    return {
      kind: "agent_message",
      id,
      message: {
        index: record.sequence,
        role: "assistant",
        content: text,
        tool_calls: null,
        tool_output: null,
      },
      timestamp,
      stepName: record.step_name,
    };
  }

  if (
    record.kind === "reasoning" ||
    record.kind === "tool_call" ||
    record.kind === "tool_result" ||
    record.kind === "raw"
  ) {
    return {
      kind: "tool_activity",
      id,
      event: {
        run_id: record.run_id,
        issue_identifier: record.issue_identifier,
        sequence: record.sequence,
        timestamp: record.timestamp,
        event_type: record.kind,
        step_name: record.step_name,
        attempt: record.attempt,
        detail: text,
        verdict: null,
        tool_name:
          typeof record.payload === "object" && record.payload != null && "name" in record.payload
            ? String((record.payload as { name?: unknown }).name ?? "")
            : null,
      },
      timestamp,
      stepName: record.step_name,
    };
  }

  return null;
}
```

In `buildTranscriptEntries`, add before old `source.conversation` processing:

```ts
for (const record of source.transcriptRecords ?? []) {
  const entry = entryFromTranscriptRecord(record);
  if (entry == null) continue;
  sortable.push({
    entry,
    sortTimestamp: toMs(record.timestamp),
    sortSequence: record.sequence,
    sortPriority: TRANSCRIPT_SORT_PRIORITY.agentOrTool,
  });
}
```

Keep the old `conversation` field temporarily as an empty-compatible source while the page migration lands in the same task.

- [ ] **Step 5: Update IssueDetail data fetching**

In `IssueDetail.tsx`, replace old conversation query usage with the new step-scoped query once generated hooks are available. Use the selected/current step and run id from issue detail:

```ts
const activeRunId = issue?.running?.run_id ?? issue?.attempt?.run_id ?? null;
const activeStepName = selectedStepName ?? issue?.running?.current_step ?? null;

const transcriptQuery = useGetStepConversation(
  identifier ?? "",
  activeRunId ?? "",
  activeStepName ?? "",
  { limit: 200 },
  {
    query: {
      enabled: Boolean(identifier && activeRunId && activeStepName),
    },
  },
);
```

Pass records into transcript source:

```ts
const transcriptEntries = buildTranscriptEntries({
  conversation: [],
  transcriptRecords: transcriptQuery.data?.records ?? [],
  interactions: interactionData,
  timelineEvents,
  issue,
  sourceStatus,
});
```

Use the actual generated hook/function name from Orval if it differs from `useGetStepConversation`.

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test transcript-model.test.ts IssueDetail.test.tsx
```

Expected: targeted frontend tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/generated crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
git commit -m "feat: render step transcript records in UI"
```

---

### Task 7: Product E2E, Docs, And Full Verification

**Files:**
- Modify: `crates/ensemble-cli/tests/product_e2e.rs`
- Modify: `docs/SPEC.md`
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Add product E2E assertion**

In `crates/ensemble-cli/tests/product_e2e.rs`, extend the mock ACP stream with a tool-call update and assert the transcript file exists. Add the ACP line near existing `session/update` fixture output:

```rust
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":{"type":"tool_call","name":"read_file","arguments":{"path":"Cargo.toml"}}}}}'
```

After the run completes, add:

```rust
let transcript_path = workspace_root
    .join(workspace_key)
    .join(".ensemble")
    .join("runs")
    .join(run_id)
    .join("steps")
    .join("implement")
    .join("transcript.jsonl");
assert!(transcript_path.exists(), "step transcript should be written");
let transcript = tokio::fs::read_to_string(&transcript_path).await.unwrap();
assert!(transcript.contains("\"assistant_message\""));
assert!(transcript.contains("\"tool_call\""));
assert!(transcript.contains("\"read_file\""));
```

Use the existing local variable names for workspace root, workspace key, run id, and step name in that test.

- [ ] **Step 2: Run product E2E to verify it fails or exposes missing wiring**

Run:

```bash
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
```

Expected: passes if prior tasks are complete; if it fails, fix only transcript-related path or fixture mismatches.

- [ ] **Step 3: Update `docs/SPEC.md`**

Add a subsection under ACP streaming or observability:

````markdown
### Per-step conversation transcripts

For each pipeline step, Ensemble persists a typed JSONL transcript at:

```text
{workspace}/.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl
```

Transcript records are distinct from timeline events. Timeline events summarize run progress;
transcript records preserve step-level agent activity such as assistant messages, exposed reasoning
chunks, tool calls, tool results, permission activity, turn completion, and errors.

Large tool results are truncated with head and tail retention. Adjacent assistant and reasoning
deltas may be coalesced before persistence. Transcript persistence failures are logged and do not
fail the agent step.
````

- [ ] **Step 4: Update `docs/pipelines.md`**

Add a debugging note:

````markdown
## Step transcripts

Each run step writes a drill-down transcript to:

```text
.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl
```

Use the timeline to understand step state transitions. Use the step transcript when you need the
agent conversation details: assistant output, exposed reasoning, tool activity, permission events,
and turn completion records.
````

- [ ] **Step 5: Run backend verification**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

Expected: all commands pass.

- [ ] **Step 6: Run frontend verification**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test
pnpm run build
```

Expected: frontend tests and build pass.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-cli/tests/product_e2e.rs docs/SPEC.md docs/pipelines.md
git commit -m "test: cover per-step conversation transcripts"
```

---

## Self-Review

Spec coverage:

- Per-step transcript files are implemented in Tasks 1, 2, and 4.
- Assistant, reasoning, tool, permission, turn, error, and raw record kinds are modeled in Task 1 and extracted in Task 3.
- Coalescing and truncation are implemented in Task 2.
- The old route is intentionally replaced in Task 5.
- Frontend consumption is handled in Task 6.
- Product E2E and docs are handled in Task 7.

Placeholder scan:

- The plan contains no red-flag marker strings or empty steps.
- Steps that require code include concrete snippets or exact local adaptation instructions tied to existing helper names.

Type consistency:

- Backend record types use `TranscriptRecord`, `TranscriptRecordKind`, `TranscriptTruncation`, and `TranscriptResponse` consistently.
- Parser-level blocks use `TranscriptBlock` and `TranscriptBlockKind`, then map to persisted `TranscriptRecordKind` in the orchestrator.
- API routes keep the existing Rust function names `get_conversation` and `get_conversation_message` while changing the path and response contract, which limits router/OpenAPI churn.
