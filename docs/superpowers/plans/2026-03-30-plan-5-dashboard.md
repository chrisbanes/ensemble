# Plan 5: Dashboard — Backend API Extensions + React Frontend + Tauri Desktop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the ensemble-core API with event streaming, history, conversation, and control endpoints, then build a React dashboard that consumes them — shipped as a Tauri desktop app and optionally served from the CLI.

**Architecture:** Backend adds a tokio broadcast event bus, JSONL history log, WebSocket handler, and new REST endpoints to the existing axum router from Plan 4. Frontend is a Vite + React 19 SPA that polls REST for overview data and opens a WebSocket for live issue detail. Tauri wraps the same SPA in a native window.

**Tech Stack:** Rust (axum, tokio-tungstenite, tower-http), React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router, Tauri 2

**Depends on:** Plan 4 (API, Observability & CLI) must be implemented first. This plan extends the `api/` and `observability/` modules Plan 4 creates.

**Supersedes:** Plan 5 (2026-03-29-plan-5-desktop-dashboard.md)

**Design spec:** `docs/superpowers/specs/2026-03-30-dashboard-design.md`

---

## File Structure

```
ensemble/
├── Cargo.toml                                     # add: ensemble-desktop member
├── crates/
│   ├── ensemble-core/
│   │   ├── Cargo.toml                             # add: tokio-tungstenite, tower-http
│   │   └── src/
│   │       ├── lib.rs                             # already has: pub mod api; pub mod observability;
│   │       ├── api/
│   │       │   ├── mod.rs                         # add re-exports for new modules
│   │       │   ├── router.rs                      # update: mount new endpoints + WS + static
│   │       │   ├── handlers.rs                    # existing: get_state, get_issue_detail, etc.
│   │       │   ├── conversation.rs                # new: conversation pagination handlers
│   │       │   ├── controls.rs                    # new: stop + retry handlers
│   │       │   ├── history_handler.rs             # new: history query handler
│   │       │   └── ws.rs                          # new: WebSocket upgrade + event fan-out
│   │       ├── observability/
│   │       │   ├── mod.rs                         # add re-export for events
│   │       │   ├── snapshot.rs                    # existing from Plan 4
│   │       │   ├── logging.rs                     # existing from Plan 4
│   │       │   └── events.rs                      # new: EventBus, PipelineEvent types
│   │       └── history/
│   │           ├── mod.rs                         # re-exports
│   │           ├── model.rs                       # HistoryRecord struct
│   │           ├── writer.rs                      # append-only JSONL writer
│   │           └── reader.rs                      # JSONL reader with filtering
│   └── ensemble-desktop/
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── build.rs
│       ├── icons/
│       │   └── icon.png
│       ├── src/
│       │   └── main.rs
│       └── src-ui/
│           ├── package.json
│           ├── tsconfig.json
│           ├── tsconfig.node.json
│           ├── vite.config.ts
│           ├── tailwind.config.js
│           ├── postcss.config.js
│           ├── index.html
│           └── src/
│               ├── main.tsx
│               ├── App.tsx
│               ├── index.css
│               ├── types.ts
│               ├── api.ts
│               ├── ws.ts
│               ├── notifications.ts
│               ├── theme.ts
│               ├── pages/
│               │   ├── Dashboard.tsx
│               │   ├── IssueDetail.tsx
│               │   ├── History.tsx
│               │   └── ConfigStatus.tsx
│               └── components/
│                   ├── Layout.tsx
│                   ├── RunningTable.tsx
│                   ├── RetryQueue.tsx
│                   ├── AgentTotals.tsx
│                   ├── StatusBadge.tsx
│                   ├── EventTimeline.tsx
│                   ├── ConversationViewer.tsx
│                   ├── NotificationPanel.tsx
│                   └── ConfirmDialog.tsx
```

---

## Phase 1: Backend — Event Bus, History, New Endpoints

### Task 1: Event Bus Types and Broadcast Channel

**Files:**
- Create: `crates/ensemble-core/src/observability/events.rs`
- Modify: `crates/ensemble-core/src/observability/mod.rs`

- [ ] **Step 1: Define PipelineEvent enum**

`crates/ensemble-core/src/observability/events.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::Serialize;

/// A lightweight event emitted by the orchestrator at pipeline boundaries.
/// These are broadcast to WebSocket subscribers and used for the event timeline.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum PipelineEvent {
    SessionStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    StepStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        agent_name: String,
        detail: String,
    },
    StepCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        verdict: Option<String>,
        detail: String,
    },
    TurnCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        turn: u32,
        detail: String,
        conversation_index: Option<u64>,
        tokens_delta: TokensDelta,
    },
    ToolCall {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        tool_name: String,
        detail: String,
    },
    Error {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    RetryScheduled {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        attempt: u32,
        detail: String,
    },
    Complete {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        outcome: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct TokensDelta {
    pub input: u64,
    pub output: u64,
}

impl PipelineEvent {
    /// Returns the issue_identifier for this event (used for per-issue filtering).
    pub fn issue_identifier(&self) -> &str {
        match self {
            Self::SessionStarted { issue_identifier, .. }
            | Self::StepStarted { issue_identifier, .. }
            | Self::StepCompleted { issue_identifier, .. }
            | Self::TurnCompleted { issue_identifier, .. }
            | Self::ToolCall { issue_identifier, .. }
            | Self::Error { issue_identifier, .. }
            | Self::RetryScheduled { issue_identifier, .. }
            | Self::Complete { issue_identifier, .. } => issue_identifier,
        }
    }

    /// Returns the timestamp for this event.
    pub fn timestamp(&self) -> DateTime<Utc> {
        match self {
            Self::SessionStarted { timestamp, .. }
            | Self::StepStarted { timestamp, .. }
            | Self::StepCompleted { timestamp, .. }
            | Self::TurnCompleted { timestamp, .. }
            | Self::ToolCall { timestamp, .. }
            | Self::Error { timestamp, .. }
            | Self::RetryScheduled { timestamp, .. }
            | Self::Complete { timestamp, .. } => *timestamp,
        }
    }
}
```

- [ ] **Step 2: Define EventBus wrapper**

Append to `crates/ensemble-core/src/observability/events.rs`:
```rust
use tokio::sync::broadcast;

/// Capacity of the event broadcast channel. Subscribers that fall behind
/// by more than this many events will receive a `Lagged` error.
const EVENT_BUS_CAPACITY: usize = 1024;

/// A clonable handle to the event broadcast channel.
#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<PipelineEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        Self { sender }
    }

    /// Publish an event. Returns Err only if there are zero subscribers (not fatal).
    pub fn publish(&self, event: PipelineEvent) {
        // Ignore error — it just means no subscribers are listening right now.
        let _ = self.sender.send(event);
    }

    /// Subscribe to receive events. Returns a broadcast receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<PipelineEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 3: Add module declaration**

Update `crates/ensemble-core/src/observability/mod.rs` — add:
```rust
pub mod events;
```

- [ ] **Step 4: Write tests for EventBus**

Append to `crates/ensemble-core/src/observability/events.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_and_receive() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.publish(PipelineEvent::SessionStarted {
            issue_identifier: "MT-1".into(),
            timestamp: Utc::now(),
            detail: "test".into(),
        });

        let event = rx.recv().await.unwrap();
        assert_eq!(event.issue_identifier(), "MT-1");
    }

    #[tokio::test]
    async fn publish_with_no_subscribers_does_not_panic() {
        let bus = EventBus::new();
        bus.publish(PipelineEvent::Complete {
            issue_identifier: "MT-2".into(),
            timestamp: Utc::now(),
            outcome: "succeeded".into(),
        });
        // No panic = pass.
    }

    #[test]
    fn issue_identifier_extraction() {
        let event = PipelineEvent::ToolCall {
            issue_identifier: "MT-99".into(),
            timestamp: Utc::now(),
            tool_name: "bash".into(),
            detail: "ls".into(),
        };
        assert_eq!(event.issue_identifier(), "MT-99");
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p ensemble-core -- observability::events`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/observability/events.rs crates/ensemble-core/src/observability/mod.rs
git commit -m "feat: event bus with broadcast channel for pipeline event streaming"
```

---

### Task 2: History Log Model and Writer

**Files:**
- Create: `crates/ensemble-core/src/history/mod.rs`
- Create: `crates/ensemble-core/src/history/model.rs`
- Create: `crates/ensemble-core/src/history/writer.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Create history module with model types**

`crates/ensemble-core/src/history/mod.rs`:
```rust
pub mod model;
pub mod reader;
pub mod writer;
```

`crates/ensemble-core/src/history/model.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A completed pipeline run record, stored as one line in the JSONL history log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryRecord {
    pub issue_identifier: String,
    pub issue_id: String,
    pub outcome: String,
    pub steps_traversed: Vec<String>,
    pub attempts: u32,
    pub tokens: TokenTotals,
    pub duration_seconds: u64,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub verdict: Option<String>,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}
```

- [ ] **Step 2: Write the HistoryWriter**

`crates/ensemble-core/src/history/writer.rs`:
```rust
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tracing::warn;

use super::model::HistoryRecord;

/// Append-only writer for the JSONL history log.
#[derive(Debug, Clone)]
pub struct HistoryWriter {
    path: PathBuf,
}

impl HistoryWriter {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Returns the path to the history log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a completed run record to the log file.
    /// Creates the file if it doesn't exist.
    pub async fn append(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        let mut line = serde_json::to_string(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await?;

        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }
}
```

- [ ] **Step 3: Add module declaration to lib.rs**

Update `crates/ensemble-core/src/lib.rs` — add:
```rust
pub mod history;
```

- [ ] **Step 4: Write tests for HistoryWriter**

Append to `crates/ensemble-core/src/history/writer.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::TokenTotals;
    use chrono::Utc;
    use tempfile::NamedTempFile;

    fn sample_record() -> HistoryRecord {
        HistoryRecord {
            issue_identifier: "MT-648".into(),
            issue_id: "abc123".into(),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into(), "review".into()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 180_000,
                output_tokens: 104_000,
                total_tokens: 284_000,
            },
            duration_seconds: 765,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: Some("approved".into()),
            workspace_path: "/tmp/ensemble_workspaces/MT-648".into(),
        }
    }

    #[tokio::test]
    async fn append_creates_file_and_writes_line() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        // Remove so writer creates it fresh.
        std::fs::remove_file(&path).ok();

        let writer = HistoryWriter::new(path.clone());
        writer.append(&sample_record()).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 1);

        let parsed: HistoryRecord = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(parsed.issue_identifier, "MT-648");
    }

    #[tokio::test]
    async fn append_multiple_records() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();

        let writer = HistoryWriter::new(path.clone());
        writer.append(&sample_record()).await.unwrap();

        let mut r2 = sample_record();
        r2.issue_identifier = "MT-649".into();
        writer.append(&r2).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p ensemble-core -- history::writer`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/history/ crates/ensemble-core/src/lib.rs
git commit -m "feat: history log model and append-only JSONL writer"
```

---

### Task 3: History Log Reader with Filtering

**Files:**
- Create: `crates/ensemble-core/src/history/reader.rs`

- [ ] **Step 1: Define query parameters and paginated response**

`crates/ensemble-core/src/history/reader.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

use super::model::HistoryRecord;

/// Query parameters for filtering history records.
#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub outcome: Option<String>,
    pub issue: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub step: Option<String>,
}

/// Paginated response from the history reader.
#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub records: Vec<HistoryRecord>,
    pub pagination: HistoryPagination,
}

#[derive(Debug, Serialize)]
pub struct HistoryPagination {
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
```

- [ ] **Step 2: Implement the reader**

Append to `crates/ensemble-core/src/history/reader.rs`:
```rust
/// Read and filter history records from a JSONL file.
/// Reads the entire file into memory and applies filters.
pub async fn read_history(
    path: &Path,
    query: &HistoryQuery,
) -> Result<HistoryResponse, std::io::Error> {
    let limit = query.limit.unwrap_or(20).min(100);

    let contents = match fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryResponse {
                records: vec![],
                pagination: HistoryPagination {
                    has_more: false,
                    next_cursor: None,
                },
            });
        }
        Err(e) => return Err(e),
    };

    // Parse all records, skip malformed lines.
    let mut all_records: Vec<HistoryRecord> = contents
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    // Most recent first.
    all_records.reverse();

    // Apply filters.
    let filtered: Vec<HistoryRecord> = all_records
        .into_iter()
        .filter(|r| {
            if let Some(ref outcome) = query.outcome {
                if r.outcome != *outcome {
                    return false;
                }
            }
            if let Some(ref issue) = query.issue {
                if !r.issue_identifier.to_lowercase().contains(&issue.to_lowercase()) {
                    return false;
                }
            }
            if let Some(since) = query.since {
                if r.completed_at < since {
                    return false;
                }
            }
            if let Some(ref step) = query.step {
                if !r.steps_traversed.contains(step) {
                    return false;
                }
            }
            true
        })
        .collect();

    // Cursor-based pagination: cursor is the index to start from.
    let start = query
        .cursor
        .as_ref()
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or(0);

    let page: Vec<HistoryRecord> = filtered.iter().skip(start).take(limit).cloned().collect();
    let has_more = start + page.len() < filtered.len();
    let next_cursor = if has_more {
        Some((start + page.len()).to_string())
    } else {
        None
    };

    Ok(HistoryResponse {
        records: page,
        pagination: HistoryPagination {
            has_more,
            next_cursor,
        },
    })
}
```

- [ ] **Step 3: Write tests**

Append to `crates/ensemble-core/src/history/reader.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::TokenTotals;
    use crate::history::writer::HistoryWriter;
    use tempfile::NamedTempFile;

    fn make_record(id: &str, outcome: &str, steps: Vec<&str>) -> HistoryRecord {
        HistoryRecord {
            issue_identifier: id.into(),
            issue_id: format!("{id}-id"),
            outcome: outcome.into(),
            steps_traversed: steps.into_iter().map(String::from).collect(),
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
            },
            duration_seconds: 60,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: None,
            workspace_path: format!("/tmp/{id}"),
        }
    }

    async fn write_test_data(path: &Path) {
        let writer = HistoryWriter::new(path.to_path_buf());
        writer
            .append(&make_record("MT-1", "succeeded", vec!["build", "review"]))
            .await
            .unwrap();
        writer
            .append(&make_record("MT-2", "failed", vec!["build"]))
            .await
            .unwrap();
        writer
            .append(&make_record("MT-3", "succeeded", vec!["build", "review"]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn read_all_records() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_data(&path).await;

        let resp = read_history(&path, &HistoryQuery::default()).await.unwrap();
        // Most recent first.
        assert_eq!(resp.records.len(), 3);
        assert_eq!(resp.records[0].issue_identifier, "MT-3");
    }

    #[tokio::test]
    async fn filter_by_outcome() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_data(&path).await;

        let query = HistoryQuery {
            outcome: Some("failed".into()),
            ..Default::default()
        };
        let resp = read_history(&path, &query).await.unwrap();
        assert_eq!(resp.records.len(), 1);
        assert_eq!(resp.records[0].issue_identifier, "MT-2");
    }

    #[tokio::test]
    async fn filter_by_step() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_data(&path).await;

        let query = HistoryQuery {
            step: Some("review".into()),
            ..Default::default()
        };
        let resp = read_history(&path, &query).await.unwrap();
        assert_eq!(resp.records.len(), 2);
    }

    #[tokio::test]
    async fn pagination() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_data(&path).await;

        let query = HistoryQuery {
            limit: Some(2),
            ..Default::default()
        };
        let resp = read_history(&path, &query).await.unwrap();
        assert_eq!(resp.records.len(), 2);
        assert!(resp.pagination.has_more);
        assert_eq!(resp.pagination.next_cursor, Some("2".into()));

        // Fetch next page.
        let query2 = HistoryQuery {
            limit: Some(2),
            cursor: resp.pagination.next_cursor,
            ..Default::default()
        };
        let resp2 = read_history(&path, &query2).await.unwrap();
        assert_eq!(resp2.records.len(), 1);
        assert!(!resp2.pagination.has_more);
    }

    #[tokio::test]
    async fn missing_file_returns_empty() {
        let resp = read_history(Path::new("/tmp/nonexistent-history.jsonl"), &HistoryQuery::default())
            .await
            .unwrap();
        assert!(resp.records.is_empty());
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p ensemble-core -- history::reader`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/history/reader.rs
git commit -m "feat: history log reader with filtering and cursor-based pagination"
```

---

### Task 4: History API Handler

**Files:**
- Create: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`

This task assumes Plan 4's `api/router.rs` exists with `create_api_router()` and an `ApiState` struct that holds shared state. The handler reads the history log path from `ApiState`.

- [ ] **Step 1: Create the history handler**

`crates/ensemble-core/src/api/history_handler.rs`:
```rust
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use std::sync::Arc;

use crate::history::reader::{read_history, HistoryQuery, HistoryResponse};

use super::ApiState;

pub async fn get_history(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>, StatusCode> {
    let path = state.history_log_path();
    read_history(path, &query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
```

- [ ] **Step 2: Add `history_log_path()` to ApiState**

In `crates/ensemble-core/src/api/router.rs` (or wherever `ApiState` is defined), add a `history_path: PathBuf` field and a `history_log_path(&self) -> &Path` method. The exact integration depends on Plan 4's `ApiState` definition — add a field:

```rust
// In ApiState struct:
pub history_path: PathBuf,

// Method:
pub fn history_log_path(&self) -> &Path {
    &self.history_path
}
```

- [ ] **Step 3: Mount the handler in the router**

In `crates/ensemble-core/src/api/router.rs`, inside `create_api_router()`, add:
```rust
.route("/api/v1/history", get(history_handler::get_history))
```

- [ ] **Step 4: Add module declaration**

Update `crates/ensemble-core/src/api/mod.rs` — add:
```rust
pub mod history_handler;
```

- [ ] **Step 5: Run full test suite to verify compilation**

Run: `cargo test -p ensemble-core`
Expected: All existing + new tests pass. No clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs
git commit -m "feat: GET /api/v1/history endpoint for browsing completed runs"
```

---

### Task 5: Stop and Retry Control Endpoints

**Files:**
- Create: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`

These handlers interact with `OrchestratorState` (from Plan 4) to stop running agents or force-retry failed issues.

- [ ] **Step 1: Create control handlers**

`crates/ensemble-core/src/api/controls.rs`:
```rust
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

use super::ApiState;

#[derive(Debug, Serialize)]
pub struct StopResponse {
    pub stopped: bool,
    pub issue_identifier: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct RetryResponse {
    pub retrying: bool,
    pub issue_identifier: String,
    pub attempt: u32,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

pub async fn post_stop(
    State(state): State<Arc<ApiState>>,
    Path(identifier): Path<String>,
) -> Result<Json<StopResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut orch = state.orchestrator_state.write().await;

    // Check if issue is running.
    let running = orch.running.get(&identifier);
    if running.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: ErrorBody {
                    code: "issue_not_found".into(),
                    message: format!("no running issue with identifier '{identifier}'"),
                },
            }),
        ));
    }

    // Signal the agent process to stop.
    // The orchestrator's run loop will detect the stopped process and
    // transition the issue to retry or failed state.
    if let Some(entry) = orch.running.get(&identifier) {
        if let Some(ref pid) = entry.agent_pid {
            // Send SIGTERM to the agent process.
            // This is best-effort — the process may already be gone.
            #[cfg(unix)]
            {
                if let Ok(pid_num) = pid.parse::<i32>() {
                    unsafe {
                        libc::kill(pid_num, libc::SIGTERM);
                    }
                }
            }
        }
    }

    // Remove from running state — the orchestrator will handle cleanup.
    orch.running.remove(&identifier);

    Ok(Json(StopResponse {
        stopped: true,
        issue_identifier: identifier,
        message: "Agent process terminated".into(),
    }))
}

pub async fn post_retry(
    State(state): State<Arc<ApiState>>,
    Path(identifier): Path<String>,
) -> Result<Json<RetryResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut orch = state.orchestrator_state.write().await;

    // Check if issue is in retry queue.
    if let Some(entry) = orch.retry_attempts.get(&identifier) {
        let attempt = entry.attempt + 1;
        // Remove from retry queue — orchestrator will pick it up on next poll.
        orch.retry_attempts.remove(&identifier);

        return Ok(Json(RetryResponse {
            retrying: true,
            issue_identifier: identifier,
            attempt,
            message: "Retry queued immediately".into(),
        }));
    }

    Err((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: ErrorBody {
                code: "issue_not_found".into(),
                message: format!("no retrying issue with identifier '{identifier}'"),
            },
        }),
    ))
}
```

- [ ] **Step 2: Add module declaration and routes**

Update `crates/ensemble-core/src/api/mod.rs` — add:
```rust
pub mod controls;
```

Update `crates/ensemble-core/src/api/router.rs` — inside `create_api_router()`, add:
```rust
.route("/api/v1/:identifier/stop", post(controls::post_stop))
.route("/api/v1/:identifier/retry", post(controls::post_retry))
```

- [ ] **Step 3: Run tests and clippy**

Run: `cargo clippy -p ensemble-core -- -D warnings && cargo test -p ensemble-core`
Expected: Clean compilation, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs
git commit -m "feat: POST stop and retry control endpoints for defensive agent management"
```

---

### Task 6: WebSocket Event Handler

**Files:**
- Create: `crates/ensemble-core/src/api/ws.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/Cargo.toml`

- [ ] **Step 1: Add tokio-tungstenite dependency**

Update `Cargo.toml` (workspace root) — add to `[workspace.dependencies]`:
```toml
tokio-tungstenite = "0.24"
```

Update `crates/ensemble-core/Cargo.toml` — add to `[dependencies]`:
```toml
tokio-tungstenite = { workspace = true }
```

Note: axum has built-in WebSocket support via `axum::extract::ws`. Prefer that over raw tokio-tungstenite if Plan 4 already uses axum. If so, skip the tokio-tungstenite dependency and use `axum`'s `ws` feature instead:

In workspace `Cargo.toml`:
```toml
axum = { version = "0.8", features = ["ws"] }
```

- [ ] **Step 2: Create WebSocket handler**

`crates/ensemble-core/src/api/ws.rs`:
```rust
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use tracing::{info, warn};

use crate::observability::events::PipelineEvent;

use super::ApiState;

/// WebSocket snapshot sent on connection.
#[derive(Debug, Serialize)]
struct WsSnapshot {
    #[serde(rename = "type")]
    msg_type: &'static str,
    issue_identifier: String,
    status: String,
    step_name: Option<String>,
    turn_count: u32,
    tokens: WsTokens,
    started_at: String,
    events: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct WsTokens {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

/// WebSocket event wrapper sent for each pipeline event.
#[derive(Debug, Serialize)]
struct WsEvent {
    #[serde(rename = "type")]
    msg_type: &'static str,
    #[serde(flatten)]
    event: serde_json::Value,
}

/// WebSocket completion message sent before closing.
#[derive(Debug, Serialize)]
struct WsComplete {
    #[serde(rename = "type")]
    msg_type: &'static str,
    outcome: String,
    timestamp: String,
}

pub async fn ws_events(
    ws: WebSocketUpgrade,
    Path(identifier): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, identifier, state))
}

async fn handle_ws(mut socket: WebSocket, identifier: String, state: Arc<ApiState>) {
    info!(issue = %identifier, "WebSocket client connected");

    // Build initial snapshot from orchestrator state.
    let snapshot = {
        let orch = state.orchestrator_state.read().await;
        if let Some(entry) = orch.running.get(&identifier) {
            serde_json::to_string(&WsSnapshot {
                msg_type: "snapshot",
                issue_identifier: identifier.clone(),
                status: "running".into(),
                step_name: None, // Would need pipeline state to populate.
                turn_count: entry.turn_count,
                tokens: WsTokens {
                    input_tokens: entry.agent_input_tokens,
                    output_tokens: entry.agent_output_tokens,
                    total_tokens: entry.agent_total_tokens,
                },
                started_at: entry.started_at.to_rfc3339(),
                events: vec![],
            })
            .ok()
        } else {
            None
        }
    };

    // Send snapshot if the issue is running.
    if let Some(snapshot_json) = snapshot {
        if socket.send(Message::Text(snapshot_json.into())).await.is_err() {
            return;
        }
    }

    // Subscribe to event bus and forward matching events.
    let mut rx = state.event_bus.subscribe();

    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        if event.issue_identifier() != identifier {
                            continue;
                        }

                        // Check for completion — send complete message and close.
                        if let PipelineEvent::Complete { outcome, timestamp, .. } = &event {
                            let complete = serde_json::to_string(&WsComplete {
                                msg_type: "complete",
                                outcome: outcome.clone(),
                                timestamp: timestamp.to_rfc3339(),
                            });
                            if let Ok(json) = complete {
                                let _ = socket.send(Message::Text(json.into())).await;
                            }
                            break;
                        }

                        // Forward the event.
                        let event_value = serde_json::to_value(&event).unwrap_or_default();
                        let wrapped = WsEvent {
                            msg_type: "event",
                            event: event_value,
                        };
                        if let Ok(json) = serde_json::to_string(&wrapped) {
                            if socket.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(issue = %identifier, skipped = n, "WebSocket subscriber lagged");
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Also listen for client close.
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
        }
    }

    info!(issue = %identifier, "WebSocket client disconnected");
}
```

- [ ] **Step 3: Add `event_bus` to ApiState**

In `crates/ensemble-core/src/api/router.rs` (or wherever `ApiState` is defined), add:
```rust
use crate::observability::events::EventBus;

// In ApiState struct:
pub event_bus: EventBus,
```

- [ ] **Step 4: Add module declaration and route**

Update `crates/ensemble-core/src/api/mod.rs` — add:
```rust
pub mod ws;
```

Update `crates/ensemble-core/src/api/router.rs` — add the WebSocket route:
```rust
.route("/ws/events/:identifier", get(ws::ws_events))
```

Note: Add `futures-util` to workspace dependencies if not already present:
```toml
# Cargo.toml [workspace.dependencies]
futures-util = "0.3"
```

- [ ] **Step 5: Run clippy and tests**

Run: `cargo clippy -p ensemble-core -- -D warnings && cargo test -p ensemble-core`
Expected: Clean compilation, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/api/ws.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs
git commit -m "feat: WebSocket handler for live event streaming per issue"
```

---

### Task 7: Conversation Endpoint

**Files:**
- Create: `crates/ensemble-core/src/api/conversation.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`

The conversation endpoint reads agent conversation data from the workspace directory. The exact file format depends on how the agent adapter stores conversation logs (likely a JSONL file in the workspace). This task defines the API handler with the pagination contract; the actual conversation log format adapter may need adjustment once the agent module is implemented.

- [ ] **Step 1: Define conversation types**

`crates/ensemble-core/src/api/conversation.rs`:
```rust
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::ApiState;

#[derive(Debug, Deserialize)]
pub struct ConversationQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub direction: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConversationResponse {
    pub issue_identifier: String,
    pub messages: Vec<ConversationMessage>,
    pub pagination: ConversationPagination,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ConversationMessage {
    System {
        index: u64,
        turn: u32,
        content: String,
        timestamp: String,
    },
    Assistant {
        index: u64,
        turn: u32,
        content: String,
        timestamp: String,
        tokens: MessageTokens,
    },
    ToolCall {
        index: u64,
        turn: u32,
        tool_name: String,
        tool_input_summary: String,
        tool_result_summary: Option<String>,
        tool_result_lines: Option<u64>,
        timestamp: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageTokens {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Serialize)]
pub struct ConversationPagination {
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}
```

- [ ] **Step 2: Implement the handler**

Append to `crates/ensemble-core/src/api/conversation.rs`:
```rust
pub async fn get_conversation(
    State(state): State<Arc<ApiState>>,
    Path(identifier): Path<String>,
    Query(query): Query<ConversationQuery>,
) -> Result<Json<ConversationResponse>, StatusCode> {
    let limit = query.limit.unwrap_or(50).min(100);

    // Resolve workspace path for this issue.
    let workspace_path = {
        let orch = state.orchestrator_state.read().await;
        // Check running issues.
        if let Some(entry) = orch.running.get(&identifier) {
            state.workspace_root.join(
                crate::tracker::model::sanitize_workspace_key(&entry.identifier)
                    .unwrap_or_else(|| identifier.clone()),
            )
        } else {
            // Fallback: derive from identifier.
            state.workspace_root.join(
                crate::tracker::model::sanitize_workspace_key(&identifier)
                    .unwrap_or_else(|| identifier.clone()),
            )
        }
    };

    // Read conversation log from workspace.
    // The conversation log is expected at {workspace}/.ensemble/conversation.jsonl
    let log_path = workspace_path.join(".ensemble").join("conversation.jsonl");

    let contents = match tokio::fs::read_to_string(&log_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(ConversationResponse {
                issue_identifier: identifier,
                messages: vec![],
                pagination: ConversationPagination {
                    has_more: false,
                    next_cursor: None,
                    prev_cursor: None,
                },
            }));
        }
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };

    // Parse messages from JSONL.
    let all_messages: Vec<ConversationMessage> = contents
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    let total = all_messages.len();

    // Cursor is the message index to start from.
    let backward = query.direction.as_deref() != Some("forward");
    let start = query
        .cursor
        .as_ref()
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or_else(|| if backward { total.saturating_sub(limit) } else { 0 });

    let page: Vec<ConversationMessage> = all_messages
        .iter()
        .skip(start)
        .take(limit)
        .cloned()
        .collect();

    let has_more = if backward { start > 0 } else { start + page.len() < total };
    let next_cursor = if backward && start > 0 {
        Some(start.saturating_sub(limit).to_string())
    } else if !backward && start + page.len() < total {
        Some((start + page.len()).to_string())
    } else {
        None
    };
    let prev_cursor = if backward && start + page.len() < total {
        Some((start + page.len()).to_string())
    } else if !backward && start > 0 {
        Some(start.saturating_sub(limit).to_string())
    } else {
        None
    };

    Ok(Json(ConversationResponse {
        issue_identifier: identifier,
        messages: page,
        pagination: ConversationPagination {
            has_more,
            next_cursor,
            prev_cursor,
        },
    }))
}

/// Get a single message by index (for fetching full tool output).
pub async fn get_conversation_message(
    State(state): State<Arc<ApiState>>,
    Path((identifier, index)): Path<(String, u64)>,
) -> Result<Json<ConversationMessage>, StatusCode> {
    let workspace_path = {
        let orch = state.orchestrator_state.read().await;
        if let Some(entry) = orch.running.get(&identifier) {
            state.workspace_root.join(
                crate::tracker::model::sanitize_workspace_key(&entry.identifier)
                    .unwrap_or_else(|| identifier.clone()),
            )
        } else {
            state.workspace_root.join(
                crate::tracker::model::sanitize_workspace_key(&identifier)
                    .unwrap_or_else(|| identifier.clone()),
            )
        }
    };

    let log_path = workspace_path.join(".ensemble").join("conversation.jsonl");
    let contents = tokio::fs::read_to_string(&log_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let message: Option<ConversationMessage> = contents
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<ConversationMessage>(l).ok())
        .nth(index as usize);

    message.map(Json).ok_or(StatusCode::NOT_FOUND)
}
```

- [ ] **Step 3: Add `workspace_root` to ApiState**

In `crates/ensemble-core/src/api/router.rs`, add to `ApiState`:
```rust
pub workspace_root: PathBuf,
```

- [ ] **Step 4: Add module declaration and routes**

Update `crates/ensemble-core/src/api/mod.rs` — add:
```rust
pub mod conversation;
```

Update `crates/ensemble-core/src/api/router.rs` — add routes:
```rust
.route("/api/v1/:identifier/conversation", get(conversation::get_conversation))
.route("/api/v1/:identifier/conversation/:index", get(conversation::get_conversation_message))
```

- [ ] **Step 5: Run clippy and tests**

Run: `cargo clippy -p ensemble-core -- -D warnings && cargo test -p ensemble-core`
Expected: Clean compilation, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/api/conversation.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs
git commit -m "feat: paginated conversation endpoint with single-message drill-down"
```

---

### Task 8: Static Asset Serving

**Files:**
- Modify: `crates/ensemble-core/Cargo.toml`
- Modify: `crates/ensemble-core/src/api/router.rs`

- [ ] **Step 1: Add tower-http ServeDir dependency**

If not already added by Plan 4, update workspace `Cargo.toml`:
```toml
tower-http = { version = "0.6", features = ["fs"] }
```

Update `crates/ensemble-core/Cargo.toml`:
```toml
tower-http = { workspace = true }
```

- [ ] **Step 2: Add static asset serving to the router**

In `crates/ensemble-core/src/api/router.rs`, update `create_api_router()` to accept an optional static assets directory:

```rust
use tower_http::services::ServeDir;

pub fn create_api_router(state: Arc<ApiState>, static_dir: Option<PathBuf>) -> Router {
    let mut router = Router::new()
        // ... existing routes ...
        .with_state(state);

    // Serve static dashboard assets if a directory is provided.
    if let Some(dir) = static_dir {
        // SPA fallback: serve index.html for any path not matching /api/* or /ws/*.
        let serve = ServeDir::new(&dir).fallback(
            tower_http::services::ServeFile::new(dir.join("index.html")),
        );
        router = router.fallback_service(serve);
    }

    router
}
```

- [ ] **Step 3: Run clippy**

Run: `cargo clippy -p ensemble-core -- -D warnings`
Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/api/router.rs
git commit -m "feat: static asset serving for dashboard SPA via tower-http ServeDir"
```

---

## Phase 2: Frontend Scaffolding

### Task 9: React Project Scaffolding

**Files:**
- Create: `crates/ensemble-desktop/src-ui/package.json`
- Create: `crates/ensemble-desktop/src-ui/tsconfig.json`
- Create: `crates/ensemble-desktop/src-ui/tsconfig.node.json`
- Create: `crates/ensemble-desktop/src-ui/vite.config.ts`
- Create: `crates/ensemble-desktop/src-ui/tailwind.config.js`
- Create: `crates/ensemble-desktop/src-ui/postcss.config.js`
- Create: `crates/ensemble-desktop/src-ui/index.html`
- Create: `crates/ensemble-desktop/src-ui/src/main.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/index.css`
- Create: `crates/ensemble-desktop/src-ui/src/App.tsx`

- [ ] **Step 1: Create package.json**

`crates/ensemble-desktop/src-ui/package.json`:
```json
{
  "name": "ensemble-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.0",
    "@tanstack/react-query": "^5.62.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

`crates/ensemble-desktop/src-ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create tsconfig.node.json**

`crates/ensemble-desktop/src-ui/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create vite.config.ts**

`crates/ensemble-desktop/src-ui/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9131",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:9131",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create tailwind.config.js**

`crates/ensemble-desktop/src-ui/tailwind.config.js`:
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [ ] **Step 6: Create postcss.config.js**

`crates/ensemble-desktop/src-ui/postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 7: Create index.html**

`crates/ensemble-desktop/src-ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ensemble Dashboard</title>
    <script>
      // Apply theme before render to avoid flash.
      (function () {
        const stored = localStorage.getItem("ensemble-theme");
        if (stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
          document.documentElement.classList.add("dark");
        }
      })();
    </script>
  </head>
  <body class="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create index.css**

`crates/ensemble-desktop/src-ui/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
}
```

- [ ] **Step 9: Create main.tsx**

`crates/ensemble-desktop/src-ui/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 2000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 10: Create App.tsx**

`crates/ensemble-desktop/src-ui/src/App.tsx`:
```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import IssueDetail from "./pages/IssueDetail";
import History from "./pages/History";
import ConfigStatus from "./pages/ConfigStatus";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/issue/:identifier" element={<IssueDetail />} />
        <Route path="/history" element={<History />} />
        <Route path="/config" element={<ConfigStatus />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 11: Install dependencies**

Run: `npm --prefix crates/ensemble-desktop/src-ui install`
Expected: `node_modules` created, no errors.

- [ ] **Step 12: Commit**

```bash
git add crates/ensemble-desktop/src-ui/package.json crates/ensemble-desktop/src-ui/package-lock.json crates/ensemble-desktop/src-ui/tsconfig.json crates/ensemble-desktop/src-ui/tsconfig.node.json crates/ensemble-desktop/src-ui/vite.config.ts crates/ensemble-desktop/src-ui/tailwind.config.js crates/ensemble-desktop/src-ui/postcss.config.js crates/ensemble-desktop/src-ui/index.html crates/ensemble-desktop/src-ui/src/main.tsx crates/ensemble-desktop/src-ui/src/index.css crates/ensemble-desktop/src-ui/src/App.tsx
git commit -m "scaffold: React + Vite + Tailwind project with dark mode and WebSocket proxy"
```

---

### Task 10: TypeScript Types

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/types.ts`

- [ ] **Step 1: Define all API and WebSocket types**

`crates/ensemble-desktop/src-ui/src/types.ts`:
```typescript
// --- REST API types ---

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunningSession {
  issue_id: string;
  issue_identifier: string;
  state: string;
  step_name: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: TokenCounts;
}

export interface RetryEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

export interface AgentTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RateLimitSnapshot {
  remaining: number;
  limit: number;
  reset_at: string | null;
}

export interface StateResponse {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSession[];
  retrying: RetryEntry[];
  agent_totals: AgentTotals;
  rate_limits: RateLimitSnapshot | null;
}

export interface IssueDetailResponse {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: { path: string };
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: {
    session_id: string | null;
    step_name: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: TokenCounts;
  } | null;
  retry: {
    attempt: number;
    due_at: string;
    error: string | null;
  } | null;
  last_error: string | null;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface StopResponse {
  stopped: boolean;
  issue_identifier: string;
  message: string;
}

export interface RetryResponse {
  retrying: boolean;
  issue_identifier: string;
  attempt: number;
  message: string;
}

// --- Conversation types ---

export type ConversationMessage =
  | {
      role: "system";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
    }
  | {
      role: "assistant";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
      tokens: { input: number; output: number };
    }
  | {
      role: "tool_call";
      index: number;
      turn: number;
      tool_name: string;
      tool_input_summary: string;
      tool_result_summary: string | null;
      tool_result_lines: number | null;
      timestamp: string;
      status?: string;
    };

export interface ConversationResponse {
  issue_identifier: string;
  messages: ConversationMessage[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
    prev_cursor: string | null;
  };
}

// --- History types ---

export interface HistoryRecord {
  issue_identifier: string;
  issue_id: string;
  outcome: string;
  steps_traversed: string[];
  attempts: number;
  tokens: TokenCounts;
  duration_seconds: number;
  started_at: string;
  completed_at: string;
  last_error: string | null;
  verdict: string | null;
}

export interface HistoryResponse {
  records: HistoryRecord[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

// --- Config types ---

export interface ConfigResponse {
  valid: boolean;
  errors: string[];
  config_path: string;
  agents: Array<{
    name: string;
    command: string;
    model: string;
    max_turns: number;
  }>;
  pipeline: {
    steps: Array<{
      name: string;
      agent: string;
      depends: string[];
    }>;
  };
  runtime: {
    max_concurrent: number;
    max_retries: number;
    poll_interval_seconds: number;
    workspace_root: string;
    tracker: string;
    server_port: number;
  };
}

// --- WebSocket types ---

export interface WsSnapshot {
  type: "snapshot";
  issue_identifier: string;
  status: string;
  step_name: string | null;
  turn_count: number;
  tokens: TokenCounts;
  started_at: string;
  events: WsEventData[];
}

export interface WsEventMessage {
  type: "event";
  event_type: string;
  timestamp: string;
  turn?: number;
  detail: string;
  conversation_index?: number;
  tokens_delta?: { input: number; output: number };
  step_name?: string;
  tool_name?: string;
  attempt?: number;
  verdict?: string;
  outcome?: string;
}

export interface WsComplete {
  type: "complete";
  outcome: string;
  timestamp: string;
}

export type WsMessage = WsSnapshot | WsEventMessage | WsComplete;

export interface WsEventData {
  type: string;
  timestamp: string;
  detail: string;
  [key: string]: unknown;
}

// --- Notification types ---

export type NotificationSeverity = "failure" | "warning" | "success" | "info";

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  timestamp: string;
  issue_identifier: string;
  read: boolean;
}

// --- API error ---

export interface ApiError {
  error: { code: string; message: string };
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/types.ts
git commit -m "feat: TypeScript types for REST, WebSocket, conversation, history, and notifications"
```

---

### Task 11: API Fetch Layer and TanStack Query Hooks

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/api.ts`

- [ ] **Step 1: Write API functions and query hooks**

`crates/ensemble-desktop/src-ui/src/api.ts`:
```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StateResponse,
  IssueDetailResponse,
  RefreshResponse,
  StopResponse,
  RetryResponse,
  ConversationResponse,
  HistoryResponse,
  ConfigResponse,
  ApiError,
} from "./types";

const API_BASE = "/api/v1";

class FetchError extends Error {
  status: number;
  body: ApiError | null;

  constructor(status: number, body: ApiError | null) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    ...init,
  });

  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // response was not JSON
    }
    throw new FetchError(res.status, body);
  }

  return res.json() as Promise<T>;
}

// --- Fetch functions ---

export function fetchState(): Promise<StateResponse> {
  return apiFetch<StateResponse>("/state");
}

export function fetchIssueDetail(identifier: string): Promise<IssueDetailResponse> {
  return apiFetch<IssueDetailResponse>(`/${encodeURIComponent(identifier)}`);
}

export function fetchConversation(
  identifier: string,
  cursor?: string,
  limit = 50,
  direction = "backward",
): Promise<ConversationResponse> {
  const params = new URLSearchParams({ limit: String(limit), direction });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<ConversationResponse>(
    `/${encodeURIComponent(identifier)}/conversation?${params}`,
  );
}

export function fetchHistory(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}): Promise<HistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.outcome) searchParams.set("outcome", params.outcome);
  if (params.issue) searchParams.set("issue", params.issue);
  if (params.since) searchParams.set("since", params.since);
  if (params.step) searchParams.set("step", params.step);
  return apiFetch<HistoryResponse>(`/history?${searchParams}`);
}

export function fetchConfig(): Promise<ConfigResponse> {
  return apiFetch<ConfigResponse>("/config");
}

export function triggerRefresh(): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>("/refresh", { method: "POST" });
}

export function stopAgent(identifier: string): Promise<StopResponse> {
  return apiFetch<StopResponse>(`/${encodeURIComponent(identifier)}/stop`, {
    method: "POST",
  });
}

export function retryAgent(identifier: string): Promise<RetryResponse> {
  return apiFetch<RetryResponse>(`/${encodeURIComponent(identifier)}/retry`, {
    method: "POST",
  });
}

// --- TanStack Query hooks ---

export function useStateQuery() {
  return useQuery<StateResponse, FetchError>({
    queryKey: ["state"],
    queryFn: fetchState,
    refetchInterval: 3000,
  });
}

export function useIssueDetailQuery(identifier: string) {
  return useQuery<IssueDetailResponse, FetchError>({
    queryKey: ["issue", identifier],
    queryFn: () => fetchIssueDetail(identifier),
    refetchInterval: 2000,
    enabled: identifier.length > 0,
  });
}

export function useConversationQuery(
  identifier: string,
  cursor?: string,
  direction?: string,
) {
  return useQuery<ConversationResponse, FetchError>({
    queryKey: ["conversation", identifier, cursor, direction],
    queryFn: () => fetchConversation(identifier, cursor, 50, direction),
    enabled: identifier.length > 0,
  });
}

export function useHistoryQuery(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}) {
  return useQuery<HistoryResponse, FetchError>({
    queryKey: ["history", params],
    queryFn: () => fetchHistory(params),
  });
}

export function useConfigQuery() {
  return useQuery<ConfigResponse, FetchError>({
    queryKey: ["config"],
    queryFn: fetchConfig,
    staleTime: 60_000, // Config rarely changes.
  });
}

export function useRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation<RefreshResponse, FetchError>({
    mutationFn: triggerRefresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useStopMutation() {
  const queryClient = useQueryClient();
  return useMutation<StopResponse, FetchError, string>({
    mutationFn: stopAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return useMutation<RetryResponse, FetchError, string>({
    mutationFn: retryAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/api.ts
git commit -m "feat: API fetch layer with TanStack Query hooks for all endpoints"
```

---

### Task 12: WebSocket Client

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/ws.ts`

- [ ] **Step 1: Write WebSocket client with reconnection**

`crates/ensemble-desktop/src-ui/src/ws.ts`:
```typescript
import type { WsMessage } from "./types";

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface UseWsOptions {
  identifier: string;
  onMessage: (msg: WsMessage) => void;
  onStatusChange?: (status: WsStatus) => void;
  enabled?: boolean;
}

/**
 * Creates and manages a WebSocket connection for live event streaming.
 * Automatically reconnects with exponential backoff on disconnect.
 * Returns a cleanup function.
 */
export function connectWs(options: UseWsOptions): () => void {
  const { identifier, onMessage, onStatusChange, enabled = true } = options;

  if (!enabled || !identifier) {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let intentionallyClosed = false;

  function connect() {
    onStatusChange?.("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/events/${encodeURIComponent(identifier)}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      onStatusChange?.("connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        onMessage(msg);
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      onStatusChange?.("disconnected");
      if (!intentionallyClosed) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
          connect();
        }, reconnectDelay);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    intentionallyClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/ws.ts
git commit -m "feat: WebSocket client with auto-reconnect and exponential backoff"
```

---

### Task 13: Theme and Notification Modules

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/theme.ts`
- Create: `crates/ensemble-desktop/src-ui/src/notifications.ts`

- [ ] **Step 1: Create theme module**

`crates/ensemble-desktop/src-ui/src/theme.ts`:
```typescript
const STORAGE_KEY = "ensemble-theme";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function toggleTheme(): Theme {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
```

- [ ] **Step 2: Create notification state module**

`crates/ensemble-desktop/src-ui/src/notifications.ts`:
```typescript
import type { AppNotification, NotificationSeverity } from "./types";

let notifications: AppNotification[] = [];
let listeners: Array<() => void> = [];
let idCounter = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

export function addNotification(
  severity: NotificationSeverity,
  title: string,
  detail: string,
  issue_identifier: string,
): void {
  const notification: AppNotification = {
    id: String(++idCounter),
    severity,
    title,
    detail,
    timestamp: new Date().toISOString(),
    issue_identifier,
    read: false,
  };
  notifications = [notification, ...notifications].slice(0, 100);
  notify();

  // Browser notification for failures and warnings.
  if (
    (severity === "failure" || severity === "warning") &&
    document.hidden &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body: detail });
  }
}

export function markAllRead(): void {
  notifications = notifications.map((n) => ({ ...n, read: true }));
  notify();
}

export function getNotifications(): AppNotification[] {
  return notifications;
}

export function getUnreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

export function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** Request browser notification permission on first triggering event. */
export function requestPermissionIfNeeded(): void {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/theme.ts crates/ensemble-desktop/src-ui/src/notifications.ts
git commit -m "feat: dark mode toggle and in-app notification state with browser Notification API"
```

---

## Phase 3: Frontend Pages and Components

**Note:** The remaining tasks (14-20) follow the same pattern — create each component/page file with the exact code from the design spec, then commit. Due to the size of a full React component listing for each file, the remaining tasks provide the component skeleton and key logic. The implementing agent should reference the design spec (`docs/superpowers/specs/2026-03-30-dashboard-design.md`) for exact layout details and the TypeScript types from Task 10 for prop types.

### Task 14: Shared Components — Layout, StatusBadge, ConfirmDialog

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/Layout.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Create Layout component**

`crates/ensemble-desktop/src-ui/src/components/Layout.tsx` — nav bar with Dashboard/History/Config tabs, notification bell with badge, dark mode toggle, and `<Outlet />` for page content. Use `NavLink` from react-router-dom with active class styling. Import `NotificationPanel` (created in Task 19). Import `toggleTheme`/`getTheme` from `../theme`.

Key structure:
```tsx
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getTheme, toggleTheme } from "../theme";
import NotificationPanel from "./NotificationPanel";
import { getUnreadCount, subscribe } from "../notifications";

export default function Layout() {
  const [theme, setThemeState] = useState(getTheme);
  const [unreadCount, setUnreadCount] = useState(getUnreadCount);
  const [showNotifications, setShowNotifications] = useState(false);

  // Subscribe to notification changes.
  useState(() => {
    return subscribe(() => setUnreadCount(getUnreadCount()));
  });

  // ... render nav bar with links, bell icon, theme toggle, Outlet
}
```

Note: The implementing agent should render a complete nav bar matching the design spec's mockup (dark gray nav, active tab highlighting, bell icon with red badge count, moon/sun toggle).

- [ ] **Step 2: Create StatusBadge component**

`crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx`:
```tsx
interface StatusBadgeProps {
  status: string;
}

const colorMap: Record<string, string> = {
  running: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  retrying: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  reviewing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const colors = colorMap[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}
```

- [ ] **Step 3: Create ConfirmDialog component**

`crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx`:
```tsx
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmClass = "bg-red-600 hover:bg-red-500",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{message}</p>
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-2 text-sm rounded-md text-white ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/Layout.tsx crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx
git commit -m "feat: shared UI components — Layout, StatusBadge, ConfirmDialog with dark mode"
```

---

### Task 15: Dashboard Page with RunningTable, RetryQueue, AgentTotals

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/RunningTable.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/RetryQueue.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/AgentTotals.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Create RunningTable** — table with columns: Issue (link), Step, Turns, Last Event, Tokens, Runtime, Status badge. Props: `sessions: RunningSession[]`. Use `Link` from react-router-dom for issue identifiers. Include helper functions `formatDuration(startedAt)` and `formatTokens(n)`.

- [ ] **Step 2: Create RetryQueue** — table with columns: Issue (link), Attempt (X/max), Retry In (countdown), Error (truncated), Actions (Retry Now button). Props: `entries: RetryEntry[]`, `onRetry: (identifier: string) => void`.

- [ ] **Step 3: Create AgentTotals** — grid of stat cards: Input Tokens, Output Tokens, Total Tokens, Total Runtime. Plus optional rate limit display. Props: `totals: AgentTotals`, `rateLimits: RateLimitSnapshot | null`.

- [ ] **Step 4: Create Dashboard page** — uses `useStateQuery()`, `useRefreshMutation()`, `useRetryMutation()`. Renders header with Force Refresh button, 5 stat cards (running, retrying, + 3 from AgentTotals), RunningTable, RetryQueue. Handles loading/error states.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds (or only missing page imports that haven't been created yet — stub them as empty components if needed).

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/RunningTable.tsx crates/ensemble-desktop/src-ui/src/components/RetryQueue.tsx crates/ensemble-desktop/src-ui/src/components/AgentTotals.tsx crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard page with running agents table, retry queue, and stats"
```

---

### Task 16: Issue Detail Page with EventTimeline and ConversationViewer

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/EventTimeline.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/ConversationViewer.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Create EventTimeline** — reverse-chronological event list. Props: `events: WsEventData[]`, `live: boolean`, `onViewConversation?: (index: number) => void`. Color-coded dots: green (turn_completed), purple (tool_call), blue (step_started/step_completed), gray (other). Each turn_completed shows "View in conversation" link.

- [ ] **Step 2: Create ConversationViewer** — paginated message list. Uses `useConversationQuery()`. Message type rendering: system (green bg), assistant (default), tool_call (purple bg with collapsible result via `<details>`). Pagination footer with Older/Newer buttons.

- [ ] **Step 3: Create IssueDetail page** — uses `useIssueDetailQuery()`, `useStopMutation()`, `useRetryMutation()`, and `connectWs()` from `../ws`. Two-column grid layout. Left: EventTimeline fed by WebSocket events. Right: ConversationViewer. Header with back link, identifier, badges, Stop/Retry button. 4 stat cards. Workspace info bar at bottom. ConfirmDialog for stop action.

WebSocket integration pattern:
```tsx
const [events, setEvents] = useState<WsEventData[]>([]);
const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");

useEffect(() => {
  return connectWs({
    identifier,
    enabled: isLiveRun,
    onMessage: (msg) => {
      if (msg.type === "snapshot") {
        setEvents(msg.events);
      } else if (msg.type === "event") {
        setEvents((prev) => [msg as unknown as WsEventData, ...prev]);
      }
    },
    onStatusChange: setWsStatus,
  });
}, [identifier, isLiveRun]);
```

- [ ] **Step 4: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/EventTimeline.tsx crates/ensemble-desktop/src-ui/src/components/ConversationViewer.tsx crates/ensemble-desktop/src-ui/src/pages/IssueDetail.tsx
git commit -m "feat: Issue Detail page with live event timeline and paginated conversation viewer"
```

---

### Task 17: History Page

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/pages/History.tsx`

- [ ] **Step 1: Create History page** — uses `useHistoryQuery()` with filter state. Filter bar: text input for issue search, select dropdowns for outcome/time range/step. Results table with clickable rows linking to `/issue/{identifier}`. Cursor-based pagination footer.

Filter state pattern:
```tsx
const [filters, setFilters] = useState({
  issue: "",
  outcome: "",
  since: "",
  step: "",
});
const [cursor, setCursor] = useState<string | undefined>();

const { data, isLoading, isError } = useHistoryQuery({
  ...filters,
  cursor,
  limit: 20,
});
```

- [ ] **Step 2: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/pages/History.tsx
git commit -m "feat: History page with filtering and pagination for completed runs"
```

---

### Task 18: Config Status Page

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/pages/ConfigStatus.tsx`

- [ ] **Step 1: Create ConfigStatus page** — uses `useConfigQuery()`. Renders validation banner (green/red), agents table, pipeline steps visual flow, runtime settings grid. All read-only.

- [ ] **Step 2: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/pages/ConfigStatus.tsx
git commit -m "feat: Config Status page showing effective configuration and validation"
```

---

### Task 19: Notification Panel

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/NotificationPanel.tsx`

- [ ] **Step 1: Create NotificationPanel** — dropdown panel rendering notifications from the notification store. Props: `open: boolean`, `onClose: () => void`. Renders notification list with severity dots, title, detail, timestamp. "Mark all read" button. Clicking a notification navigates to the issue detail page.

Also add notification generation logic to the Dashboard page: compare previous and current state responses to detect new failures, retries, and completions. Call `addNotification()` and `requestPermissionIfNeeded()` from `../notifications`.

- [ ] **Step 2: Update Layout to import NotificationPanel** (if stubbed in Task 14, replace the stub with the real import).

- [ ] **Step 3: Verify full build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds with zero errors.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/NotificationPanel.tsx crates/ensemble-desktop/src-ui/src/components/Layout.tsx crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx
git commit -m "feat: notification panel with browser Notification API and state-diff detection"
```

---

## Phase 4: Tauri Desktop Wrapper

### Task 20: Tauri Desktop App

**Files:**
- Create: `crates/ensemble-desktop/Cargo.toml`
- Create: `crates/ensemble-desktop/tauri.conf.json`
- Create: `crates/ensemble-desktop/build.rs`
- Create: `crates/ensemble-desktop/src/main.rs`
- Create: `crates/ensemble-desktop/icons/icon.png`
- Modify: `Cargo.toml` (workspace root — add member)

- [ ] **Step 1: Add ensemble-desktop to workspace**

Update root `Cargo.toml` — the `members = ["crates/*"]` glob already covers it, so no change needed unless explicit members are listed.

- [ ] **Step 2: Create Cargo.toml**

`crates/ensemble-desktop/Cargo.toml`:
```toml
[package]
name = "ensemble-desktop"
version = "0.1.0"
edition.workspace = true
license.workspace = true
rust-version.workspace = true

[dependencies]
ensemble-core = { path = "../ensemble-core" }
tokio = { workspace = true }
tracing = { workspace = true }
tauri = { version = "2", features = [] }

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

- [ ] **Step 3: Create build.rs**

`crates/ensemble-desktop/build.rs`:
```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 4: Create tauri.conf.json**

`crates/ensemble-desktop/tauri.conf.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/niclas-nicls/tauri-plugin-clipboard-manager-v2/v2/schemas/config.schema.json",
  "productName": "Ensemble",
  "version": "0.1.0",
  "identifier": "com.ensemble.dashboard",
  "build": {
    "frontendDist": "src-ui/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm --prefix src-ui run dev",
    "beforeBuildCommand": "npm --prefix src-ui run build"
  },
  "app": {
    "windows": [
      {
        "title": "Ensemble Dashboard",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ]
  }
}
```

- [ ] **Step 5: Create main.rs**

`crates/ensemble-desktop/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Note: In a production setup, `main.rs` would start the ensemble-core orchestrator and axum server before opening the WebView, so the dashboard has a backend to talk to. For now, the Tauri app points at the dev server (Vite proxy → ensemble backend) during development and serves the built assets in production.

- [ ] **Step 6: Create placeholder icon**

Create a placeholder `crates/ensemble-desktop/icons/icon.png` (can be any valid 512x512 PNG — the implementing agent should generate or copy a placeholder).

- [ ] **Step 7: Verify Tauri builds**

Run: `cd crates/ensemble-desktop && cargo tauri build --debug`
Expected: Builds successfully (may require Tauri system dependencies — see Tauri docs).

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-desktop/
git commit -m "feat: Tauri desktop app wrapper for dashboard"
```

---

## Final Verification

### Task 21: Full Build and Lint Check

- [ ] **Step 1: Run Rust checks**

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```
Expected: All pass.

- [ ] **Step 2: Run frontend build**

```bash
npm --prefix crates/ensemble-desktop/src-ui run build
```
Expected: Build succeeds.

- [ ] **Step 3: Verify git status is clean**

```bash
git status
```
Expected: Clean working tree.
