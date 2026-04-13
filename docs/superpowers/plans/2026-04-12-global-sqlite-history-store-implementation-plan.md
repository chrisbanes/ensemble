# Global SQLite Task History Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSONL history/timeline persistence with a single global SQLite store while keeping existing API response shapes unchanged.

**Architecture:** Add a global `history.db` under `<workspace_root>/.ensemble/` and route all orchestrator persistence through a new async SQLite-backed store abstraction. Keep `HistoryRecord` and `TimelineEventRecord` response models stable, but switch readers/writers to SQL queries and transactional writes with WAL + FULL sync durability.

**Tech Stack:** Rust 2021, tokio, rusqlite (+ bundled SQLite), chrono, serde, axum.

---

## File Structure

- Create: `crates/ensemble-core/src/history_store/mod.rs` — public module exports and shared constants.
- Create: `crates/ensemble-core/src/history_store/schema.rs` — schema bootstrap SQL and pragmas.
- Create: `crates/ensemble-core/src/history_store/store.rs` — async store API (`append_history_record`, `append_timeline_event`, reads).
- Create: `crates/ensemble-core/src/history_store/model.rs` — query DTOs/internal row mapping helpers.
- Modify: `Cargo.toml` — add workspace dependency for `rusqlite`.
- Modify: `crates/ensemble-core/Cargo.toml` — consume workspace `rusqlite`.
- Modify: `crates/ensemble-core/src/lib.rs` — expose `history_store` module.
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs` — replace JSONL history/timeline writes with store calls.
- Modify: `crates/ensemble-core/src/api/router.rs` — swap `history_path` state for global `history_db_path`.
- Modify: `crates/ensemble-core/src/api/bootstrap.rs` — initialize db path under `.ensemble/history.db`.
- Modify: `crates/ensemble-core/src/api/history_handler.rs` — SQL-backed history reads.
- Modify: `crates/ensemble-core/src/api/timeline_handler.rs` — SQL-backed timeline reads.
- Modify: `crates/ensemble-core/src/history/reader.rs` and `crates/ensemble-core/src/timeline/reader.rs` — deprecate/remove file-read implementations once handlers are switched.

---

### Task 1: Add SQLite dependency and schema bootstrap module

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/ensemble-core/Cargo.toml`
- Modify: `crates/ensemble-core/src/lib.rs`
- Create: `crates/ensemble-core/src/history_store/mod.rs`
- Create: `crates/ensemble-core/src/history_store/schema.rs`
- Test: `crates/ensemble-core/src/history_store/schema.rs`

- [ ] **Step 1: Write failing schema bootstrap tests**

```rust
// crates/ensemble-core/src/history_store/schema.rs
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn bootstrap_creates_runs_and_run_events_tables() {
        let conn = Connection::open_in_memory().unwrap();
        apply_pragmas(&conn).unwrap();
        bootstrap_schema(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert!(names.contains(&"runs".to_string()));
        assert!(names.contains(&"run_events".to_string()));
    }

    #[test]
    fn bootstrap_creates_run_events_sequence_index() {
        let conn = Connection::open_in_memory().unwrap();
        apply_pragmas(&conn).unwrap();
        bootstrap_schema(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_run_events_run_sequence'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(count, 1);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core history_store::schema::tests::bootstrap_creates_runs_and_run_events_tables -- --exact`
Expected: FAIL because `history_store` module/functions do not exist.

- [ ] **Step 3: Add dependency wiring**

```toml
# Cargo.toml
[workspace.dependencies]
rusqlite = { version = "0.33", features = ["bundled"] }
```

```toml
# crates/ensemble-core/Cargo.toml
[dependencies]
rusqlite = { workspace = true }
```

```rust
// crates/ensemble-core/src/lib.rs
pub mod history_store;
```

- [ ] **Step 4: Implement schema bootstrap**

```rust
// crates/ensemble-core/src/history_store/schema.rs
use rusqlite::Connection;

pub fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "busy_timeout", 5000i64)?;
    Ok(())
}

pub fn bootstrap_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            issue_id TEXT NOT NULL,
            issue_identifier TEXT NOT NULL,
            outcome TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            last_error TEXT,
            verdict TEXT,
            workspace_path TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            issue_identifier TEXT NOT NULL,
            event_type TEXT NOT NULL,
            step_name TEXT,
            attempt INTEGER NOT NULL,
            detail TEXT NOT NULL,
            verdict TEXT,
            tool_name TEXT,
            PRIMARY KEY (run_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence ON run_events(run_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_runs_identifier_completed_at ON runs(issue_identifier, completed_at);
        CREATE INDEX IF NOT EXISTS idx_runs_outcome_completed_at ON runs(outcome, completed_at);
        "#,
    )
}
```

```rust
// crates/ensemble-core/src/history_store/mod.rs
pub mod schema;
pub mod store;
```

- [ ] **Step 5: Run schema tests to verify pass**

Run: `rtk cargo test -p ensemble-core history_store::schema::tests`
Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
rtk git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/lib.rs crates/ensemble-core/src/history_store/mod.rs crates/ensemble-core/src/history_store/schema.rs
rtk git commit -m "Add SQLite schema bootstrap for history store"
```

---

### Task 2: Implement SQLite store write/read API with TDD

**Files:**
- Create: `crates/ensemble-core/src/history_store/store.rs`
- Create: `crates/ensemble-core/src/history_store/model.rs`
- Test: `crates/ensemble-core/src/history_store/store.rs`

- [ ] **Step 1: Write failing store tests for append + read**

```rust
// crates/ensemble-core/src/history_store/store.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::{HistoryRecord, TokenTotals};
    use crate::timeline::model::TimelineEventRecord;
    use chrono::Utc;
    use tempfile::TempDir;

    #[tokio::test]
    async fn append_history_record_is_queryable() {
        let dir = TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db")).await.unwrap();

        let record = HistoryRecord {
            issue_identifier: "repo#1".into(),
            issue_id: "issue-1".into(),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into()],
            attempts: 1,
            tokens: TokenTotals { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            duration_seconds: 10,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: Some("approved".into()),
            workspace_path: "/tmp/work".into(),
        };

        store.append_history_record("run-1", &record).await.unwrap();
        let response = store.read_history(&crate::history::reader::HistoryQuery::default()).await.unwrap();

        assert_eq!(response.total, 1);
        assert_eq!(response.records[0].issue_identifier, "repo#1");
    }

    #[tokio::test]
    async fn append_timeline_event_is_queryable_in_sequence_order() {
        let dir = TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db")).await.unwrap();

        store.append_timeline_event(&TimelineEventRecord {
            run_id: "run-1".into(),
            issue_identifier: "repo#1".into(),
            sequence: 2,
            timestamp: Utc::now(),
            event_type: "step_started".into(),
            step_name: Some("review".into()),
            attempt: 1,
            detail: "second".into(),
            verdict: None,
            tool_name: None,
        }).await.unwrap();

        store.append_timeline_event(&TimelineEventRecord {
            run_id: "run-1".into(),
            issue_identifier: "repo#1".into(),
            sequence: 1,
            timestamp: Utc::now(),
            event_type: "step_started".into(),
            step_name: Some("build".into()),
            attempt: 1,
            detail: "first".into(),
            verdict: None,
            tool_name: None,
        }).await.unwrap();

        let response = store
            .read_timeline(
                &crate::timeline::reader::TimelineQuery {
                    run_id: "run-1".into(),
                    cursor: Some(0),
                    limit: Some(50),
                },
                Some("repo#1"),
            )
            .await
            .unwrap();

        assert_eq!(response.events[0].sequence, 1);
        assert_eq!(response.events[1].sequence, 2);
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `rtk cargo test -p ensemble-core history_store::store::tests::append_history_record_is_queryable -- --exact`
Expected: FAIL because `HistoryStore` methods do not exist.

- [ ] **Step 3: Implement store with spawn_blocking + rusqlite**

```rust
// crates/ensemble-core/src/history_store/store.rs
#[derive(Clone)]
pub struct HistoryStore {
    db_path: std::path::PathBuf,
}

impl HistoryStore {
    pub async fn new(db_path: std::path::PathBuf) -> Result<Self, std::io::Error> {
        let path = db_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let conn = rusqlite::Connection::open(&path)
                .map_err(std::io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn)
                .map_err(std::io::Error::other)?;
            crate::history_store::schema::bootstrap_schema(&conn)
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(std::io::Error::other)??;

        Ok(Self { db_path })
    }

    pub async fn append_history_record(
        &self,
        run_id: &str,
        record: &crate::history::model::HistoryRecord,
    ) -> Result<(), std::io::Error> {
        let db_path = self.db_path.clone();
        let run_id = run_id.to_string();
        let record = record.clone();
        tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
            let mut conn = rusqlite::Connection::open(db_path).map_err(std::io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(std::io::Error::other)?;
            let tx = conn.transaction().map_err(std::io::Error::other)?;
            tx.execute(
                r#"
                INSERT INTO runs (
                    run_id, issue_id, issue_identifier, outcome, attempts, duration_seconds,
                    started_at, completed_at, last_error, verdict, workspace_path,
                    input_tokens, output_tokens, total_tokens
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(run_id) DO UPDATE SET
                    issue_id = excluded.issue_id,
                    issue_identifier = excluded.issue_identifier,
                    outcome = excluded.outcome,
                    attempts = excluded.attempts,
                    duration_seconds = excluded.duration_seconds,
                    started_at = excluded.started_at,
                    completed_at = excluded.completed_at,
                    last_error = excluded.last_error,
                    verdict = excluded.verdict,
                    workspace_path = excluded.workspace_path,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    total_tokens = excluded.total_tokens
                "#,
                rusqlite::params![
                    run_id,
                    record.issue_id,
                    record.issue_identifier,
                    record.outcome,
                    record.attempts,
                    record.duration_seconds,
                    record.started_at.to_rfc3339(),
                    record.completed_at.to_rfc3339(),
                    record.last_error,
                    record.verdict,
                    record.workspace_path,
                    record.tokens.input_tokens,
                    record.tokens.output_tokens,
                    record.tokens.total_tokens,
                ],
            )
            .map_err(std::io::Error::other)?;
            tx.commit().map_err(std::io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(std::io::Error::other)?
    }

    pub async fn append_timeline_event(
        &self,
        record: &crate::timeline::model::TimelineEventRecord,
    ) -> Result<(), std::io::Error> {
        let db_path = self.db_path.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
            let mut conn = rusqlite::Connection::open(db_path).map_err(std::io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(std::io::Error::other)?;
            let tx = conn.transaction().map_err(std::io::Error::other)?;
            tx.execute(
                r#"
                INSERT OR IGNORE INTO run_events (
                    run_id, sequence, timestamp, issue_identifier, event_type,
                    step_name, attempt, detail, verdict, tool_name
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                rusqlite::params![
                    record.run_id,
                    record.sequence,
                    record.timestamp.to_rfc3339(),
                    record.issue_identifier,
                    record.event_type,
                    record.step_name,
                    record.attempt,
                    record.detail,
                    record.verdict,
                    record.tool_name,
                ],
            )
            .map_err(std::io::Error::other)?;
            tx.commit().map_err(std::io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(std::io::Error::other)?
    }

    pub async fn read_history(
        &self,
        query: &crate::history::reader::HistoryQuery,
    ) -> Result<crate::history::reader::HistoryResponse, std::io::Error> {
        let db_path = self.db_path.clone();
        let outcome = query.outcome.clone();
        let step = query.step.clone();
        let cursor = query.cursor.unwrap_or(0);
        let limit = query.limit.unwrap_or(50).min(200);
        tokio::task::spawn_blocking(move || -> Result<crate::history::reader::HistoryResponse, std::io::Error> {
            let conn = rusqlite::Connection::open(db_path).map_err(std::io::Error::other)?;
            let mut sql = String::from(
                "SELECT run_id, issue_id, issue_identifier, outcome, attempts, duration_seconds, started_at, completed_at, last_error, verdict, workspace_path, input_tokens, output_tokens, total_tokens FROM runs",
            );
            if outcome.is_some() {
                sql.push_str(" WHERE outcome = ?1");
            }
            sql.push_str(" ORDER BY completed_at DESC");
            let mut stmt = conn.prepare(&sql).map_err(std::io::Error::other)?;
            let rows = if let Some(outcome) = outcome {
                stmt.query_map([outcome], |row| crate::history_store::model::row_to_history_record(row))
            } else {
                stmt.query_map([], |row| crate::history_store::model::row_to_history_record(row))
            }
            .map_err(std::io::Error::other)?;

            let mut records: Vec<crate::history::model::HistoryRecord> =
                rows.map(|row| row.map_err(std::io::Error::other)).collect::<Result<_, _>>()?;

            if let Some(step) = step {
                records.retain(|r| r.steps_traversed.contains(&step));
            }

            let total = records.len();
            let page = records.into_iter().skip(cursor).take(limit).collect::<Vec<_>>();
            let next_cursor = if cursor + page.len() < total { Some(cursor + page.len()) } else { None };

            Ok(crate::history::reader::HistoryResponse { records: page, total, next_cursor })
        })
        .await
        .map_err(std::io::Error::other)?
    }

    pub async fn read_timeline(
        &self,
        query: &crate::timeline::reader::TimelineQuery,
        issue_identifier: Option<&str>,
    ) -> Result<crate::timeline::reader::TimelineResponse, std::io::Error> {
        let db_path = self.db_path.clone();
        let run_id = query.run_id.clone();
        let cursor = query.cursor.unwrap_or(0);
        let limit = query.limit.unwrap_or(50).min(200);
        let issue_identifier = issue_identifier.map(ToString::to_string);
        tokio::task::spawn_blocking(move || -> Result<crate::timeline::reader::TimelineResponse, std::io::Error> {
            let conn = rusqlite::Connection::open(db_path).map_err(std::io::Error::other)?;
            let mut sql = String::from(
                "SELECT run_id, issue_identifier, sequence, timestamp, event_type, step_name, attempt, detail, verdict, tool_name FROM run_events WHERE run_id = ?1",
            );
            if issue_identifier.is_some() {
                sql.push_str(" AND issue_identifier = ?2");
            }
            sql.push_str(" ORDER BY sequence ASC");

            let mut stmt = conn.prepare(&sql).map_err(std::io::Error::other)?;
            let rows = if let Some(identifier) = issue_identifier {
                stmt.query_map(rusqlite::params![run_id, identifier], |row| {
                    crate::history_store::model::row_to_timeline_record(row)
                })
            } else {
                stmt.query_map([run_id], |row| crate::history_store::model::row_to_timeline_record(row))
            }
            .map_err(std::io::Error::other)?;

            let events: Vec<crate::timeline::model::TimelineEventRecord> =
                rows.map(|row| row.map_err(std::io::Error::other)).collect::<Result<_, _>>()?;

            let total = events.len();
            let page = events.into_iter().skip(cursor).take(limit).collect::<Vec<_>>();
            let next_cursor = if cursor + page.len() < total { Some(cursor + page.len()) } else { None };

            Ok(crate::timeline::reader::TimelineResponse { events: page, total, next_cursor })
        })
        .await
        .map_err(std::io::Error::other)?
    }
}
```

- [ ] **Step 4: Implement duplicate-protection test and behavior**

```rust
#[tokio::test]
async fn append_timeline_event_is_idempotent_for_duplicate_sequence() {
    let dir = TempDir::new().unwrap();
    let store = HistoryStore::new(dir.path().join("history.db")).await.unwrap();
    let event = TimelineEventRecord {
        run_id: "run-1".into(),
        issue_identifier: "repo#1".into(),
        sequence: 1,
        timestamp: Utc::now(),
        event_type: "step_started".into(),
        step_name: Some("build".into()),
        attempt: 1,
        detail: "first".into(),
        verdict: None,
        tool_name: None,
    };

    store.append_timeline_event(&event).await.unwrap();
    store.append_timeline_event(&event).await.unwrap();

    let response = store
        .read_timeline(&TimelineQuery { run_id: "run-1".into(), cursor: None, limit: None }, Some("repo#1"))
        .await
        .unwrap();

    assert_eq!(response.total, 1);
}
```

Use SQL insert form:

```sql
INSERT OR IGNORE INTO run_events (...)
VALUES (...);
```

- [ ] **Step 5: Run store test suite**

Run: `rtk cargo test -p ensemble-core history_store::store::tests`
Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
rtk git add crates/ensemble-core/src/history_store/store.rs crates/ensemble-core/src/history_store/model.rs
rtk git commit -m "Implement SQLite history store reads and writes"
```

---

### Task 3: Route orchestrator persistence through HistoryStore

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/api/bootstrap.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Write failing orchestrator tests for SQLite persistence**

```rust
#[tokio::test]
async fn orchestrator_writes_history_record_to_sqlite() {
    let dir = tempfile::TempDir::new().unwrap();
    let orchestrator = test_orchestrator_with_workspace(dir.path()).await;
    run_issue_to_completion(&orchestrator, "repo#1").await;

    let store = crate::history_store::store::HistoryStore::new(
        dir.path().join(".ensemble").join("history.db"),
    )
    .await
    .unwrap();
    let response = store
        .read_history(&crate::history::reader::HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(response.total, 1);
}

#[tokio::test]
async fn publish_pipeline_event_persists_timeline_in_sqlite() {
    let dir = tempfile::TempDir::new().unwrap();
    let orchestrator = test_orchestrator_with_workspace(dir.path()).await;
    publish_test_timeline_event(&orchestrator, "run-1", "repo#1").await;

    let store = crate::history_store::store::HistoryStore::new(
        dir.path().join(".ensemble").join("history.db"),
    )
    .await
    .unwrap();
    let response = store
        .read_timeline(
            &crate::timeline::reader::TimelineQuery {
                run_id: "run-1".into(),
                cursor: None,
                limit: None,
            },
            Some("repo#1"),
        )
        .await
        .unwrap();
    assert_eq!(response.total, 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core orchestrator_writes_history_record_to_sqlite -- --exact`
Expected: FAIL because orchestrator still writes JSONL.

- [ ] **Step 3: Replace writer fields with store field**

```rust
// struct Orchestrator
history_store: crate::history_store::store::HistoryStore,
```

```rust
// new_with_state
let db_path = parts.workspace_root.join(".ensemble").join("history.db");
let history_store = futures::executor::block_on(crate::history_store::store::HistoryStore::new(db_path))
    .expect("history store initialization must succeed");
```

- [ ] **Step 4: Swap persistence callsites**

```rust
async fn append_history_record(&self, run_id: &str, record: HistoryRecord) {
    if let Err(error) = self.history_store.append_history_record(run_id, &record).await {
        warn!(issue_id = %record.issue_id, error = %error, "failed to persist history record");
    }
}
```

```rust
async fn publish_pipeline_event(...) {
    self.event_bus.publish(event.clone());
    if let Some((run_id, record)) = timeline_entry {
        if let Err(error) = self.history_store.append_timeline_event(&record).await {
            warn!(event = "timeline_persist_failed", run_id = %run_id, error = %error, "failed to persist timeline event");
        }
    }
}
```

- [ ] **Step 5: Run orchestrator persistence tests**

Run: `rtk cargo test -p ensemble-core orchestrator_writes_history_record_to_sqlite publish_pipeline_event_persists_timeline_in_sqlite`
Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
rtk git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/api/bootstrap.rs
rtk git commit -m "Wire orchestrator persistence to global SQLite history store"
```

---

### Task 4: Switch history/timeline API handlers to SQL-backed reads

**Files:**
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/bootstrap.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/timeline_handler.rs`
- Test: `crates/ensemble-core/src/api/history_handler.rs`
- Test: `crates/ensemble-core/src/api/timeline_handler.rs`

- [ ] **Step 1: Write failing handler tests using DB-backed app state**

```rust
#[tokio::test]
async fn get_history_reads_from_sqlite_store() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let mut state = build_app_state(temp_dir.path().to_string_lossy().to_string());
    state.history_db_path = temp_dir.path().join(".ensemble").join("history.db");

    let store = crate::history_store::store::HistoryStore::new(state.history_db_path.clone())
        .await
        .unwrap();
    store.append_history_record("run-1", &sample_record("repo#1")).await.unwrap();

    let response = get_history(axum::extract::State(state), axum::extract::Query(crate::history::reader::HistoryQuery::default()))
        .await
        .into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn get_timeline_reads_from_sqlite_store() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let mut state = build_app_state(temp_dir.path().to_string_lossy().to_string());
    state.history_db_path = temp_dir.path().join(".ensemble").join("history.db");

    let store = crate::history_store::store::HistoryStore::new(state.history_db_path.clone())
        .await
        .unwrap();
    store.append_timeline_event(&sample_event("run-1", 1)).await.unwrap();

    let response = get_timeline(
        axum::extract::State(state),
        axum::extract::Path("repo#1".to_string()),
        axum::extract::Query(crate::timeline::reader::TimelineQuery {
            run_id: "run-1".to_string(),
            cursor: Some(0),
            limit: Some(50),
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `rtk cargo test -p ensemble-core get_history_reads_from_sqlite_store -- --exact`
Expected: FAIL because handlers still use file readers.

- [ ] **Step 3: Update AppState and bootstrap**

```rust
// api/router.rs
pub struct AppState {
    pub workspace_root: String,
    pub history_db_path: PathBuf,
    // ...
}
```

```rust
// api/bootstrap.rs
let history_db_path = PathBuf::from(&workspace_root)
    .join(".ensemble")
    .join("history.db");
```

- [ ] **Step 4: Query through HistoryStore in handlers**

```rust
// api/history_handler.rs
let store = crate::history_store::store::HistoryStore::new(state.history_db_path.clone()).await?;
match store.read_history(&query).await {
    Ok(response) => (StatusCode::OK, Json(response)).into_response(),
    Err(e) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        crate::api::handlers::api_error("history_read_error", format!("failed to read history: {}", e)),
    )
        .into_response(),
}
```

```rust
// api/timeline_handler.rs
let store = crate::history_store::store::HistoryStore::new(state.history_db_path.clone()).await?;
match store.read_timeline(&query, Some(&identifier)).await {
    Ok(response) => (StatusCode::OK, axum::Json(response)).into_response(),
    Err(e) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        crate::api::handlers::api_error("timeline_read_error", format!("failed to read timeline: {}", e)),
    )
        .into_response(),
}
```

- [ ] **Step 5: Run API handler tests**

Run: `rtk cargo test -p ensemble-core history_handler timeline_handler`
Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
rtk git add crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/bootstrap.rs crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/timeline_handler.rs
rtk git commit -m "Switch history and timeline APIs to SQLite-backed reads"
```

---

### Task 5: Remove JSONL reader/writer coupling and finalize docs/tests

**Files:**
- Modify: `crates/ensemble-core/src/history/mod.rs`
- Modify: `crates/ensemble-core/src/timeline/mod.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs` (if schema paths changed)
- Modify: `docs/superpowers/specs/2026-04-12-persistent-task-history-store-design.md` (implementation notes if needed)
- Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write failing compile/test checkpoint for removed JSONL coupling**

Run: `rtk cargo test -p ensemble-core`
Expected: FAIL on remaining imports of `history::reader` / `timeline::reader` file-based functions after previous refactors.

- [ ] **Step 2: Remove or isolate obsolete JSONL modules**

```rust
// history/mod.rs
pub mod model;
```

```rust
// timeline/mod.rs
pub mod model;
```

(If compatibility wrappers are needed, keep wrappers but implement them via `HistoryStore` instead of file IO.)

- [ ] **Step 3: Fix dependent tests and helpers**

Update `api/test_helpers.rs` and orchestrator tests to set `history_db_path` instead of `history_path` and seed data through `HistoryStore`.

- [ ] **Step 4: Run full verification for ensemble-core**

Run: `rtk cargo test -p ensemble-core`
Expected: PASS.

Run: `rtk cargo clippy -p ensemble-core -- -D warnings`
Expected: PASS.

Run: `rtk cargo fmt --all -- --check`
Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
rtk git add crates/ensemble-core/src/history/mod.rs crates/ensemble-core/src/timeline/mod.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/src/api/test_helpers.rs crates/ensemble-core/src
rtk git commit -m "Remove JSONL persistence paths after SQLite cutover"
```

---

## Final Verification Checklist

- [ ] `rtk cargo test --workspace --exclude ensemble-desktop`
- [ ] `rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings`
- [ ] `rtk cargo fmt --all -- --check`

## Spec Coverage Check

- Single global DB under `.ensemble/history.db` — covered by Task 1 and Task 4.
- Durable local writes (WAL + FULL sync + transactional commit semantics) — covered by Task 1 and Task 2.
- Replace JSONL persistence in orchestrator for history + timeline — covered by Task 3.
- Keep API response shapes unchanged while swapping backend — covered by Task 4.
- No migration/backfill from legacy JSONL — covered by Task 5 (cutover cleanup only).

## Placeholder Scan

No TBD/TODO placeholders remain. All tasks include explicit file paths, commands, and concrete code snippets.

## Type Consistency Check

- `HistoryRecord` and `TimelineEventRecord` remain API-facing models.
- New `HistoryStore` methods are consistently referenced across orchestrator and API handler tasks.
- `AppState` path field consistently renamed to `history_db_path` in plan tasks.
