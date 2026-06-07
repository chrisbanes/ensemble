use std::io;
use std::path::PathBuf;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, TransactionBehavior};

use crate::history::model::HistoryRecord;
use crate::history::reader::{HistoryQuery, HistoryResponse};
use crate::timeline::model::TimelineEventRecord;
use crate::timeline::{TimelineQuery, TimelineResponse};

#[derive(Debug, Clone)]
pub struct HistoryStore {
    db_path: PathBuf,
}

impl HistoryStore {
    pub fn new_blocking(db_path: PathBuf) -> Result<Self, io::Error> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&db_path).map_err(io::Error::other)?;
        crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
        crate::history_store::schema::bootstrap_schema(&conn).map_err(io::Error::other)?;
        Ok(Self { db_path })
    }

    pub async fn new(db_path: PathBuf) -> Result<Self, io::Error> {
        tokio::task::spawn_blocking(move || Self::new_blocking(db_path))
            .await
            .map_err(io::Error::other)?
    }

    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }

    pub async fn append_history_record(
        &self,
        run_id: &str,
        record: &HistoryRecord,
    ) -> Result<(), io::Error> {
        let path = self.db_path.clone();
        let run_id = run_id.to_string();
        let record = record.clone();
        tokio::task::spawn_blocking(move || -> Result<(), io::Error> {
            let mut conn = Connection::open(path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(io::Error::other)?;
            tx.execute(
                r#"
                INSERT INTO runs (
                    run_id, issue_id, issue_identifier, outcome, steps_traversed, attempts,
                    duration_seconds, started_at, completed_at, last_error, verdict,
                    workspace_path, input_tokens, output_tokens, total_tokens
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(run_id) DO UPDATE SET
                    issue_id = excluded.issue_id,
                    issue_identifier = excluded.issue_identifier,
                    outcome = excluded.outcome,
                    steps_traversed = excluded.steps_traversed,
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
                params![
                    run_id,
                    record.issue_id,
                    record.issue_identifier,
                    record.outcome,
                    serde_json::to_string(&record.steps_traversed).map_err(io::Error::other)?,
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
            .map_err(io::Error::other)?;
            tx.commit().map_err(io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn append_timeline_event(
        &self,
        record: &TimelineEventRecord,
    ) -> Result<(), io::Error> {
        let path = self.db_path.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || -> Result<(), io::Error> {
            let mut conn = Connection::open(path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(io::Error::other)?;
            tx.execute(
                r#"
                INSERT OR IGNORE INTO run_events (
                    run_id, sequence, timestamp, issue_identifier,
                    event_type, step_name, attempt, detail, verdict, tool_name
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
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
            .map_err(io::Error::other)?;
            tx.commit().map_err(io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn read_history(&self, query: &HistoryQuery) -> Result<HistoryResponse, io::Error> {
        let path = self.db_path.clone();
        let outcome = query.outcome.clone();
        let step = query.step.clone();
        let cursor = query.cursor.unwrap_or(0);
        let limit = query.limit.unwrap_or(50).min(200);
        tokio::task::spawn_blocking(move || -> Result<HistoryResponse, io::Error> {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;

            let mut where_clauses: Vec<&str> = Vec::new();
            let mut base_params: Vec<Value> = Vec::new();
            if let Some(ref out) = outcome {
                where_clauses.push("outcome = ?");
                base_params.push(Value::from(out.clone()));
            }
            if let Some(ref step_name) = step {
                where_clauses.push("EXISTS (SELECT 1 FROM json_each(runs.steps_traversed) WHERE json_each.value = ?)");
                base_params.push(Value::from(step_name.clone()));
            }

            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let count_sql = format!("SELECT COUNT(*) FROM runs{where_sql}");
            let total: usize = conn
                .query_row(
                    &count_sql,
                    params_from_iter(base_params.clone()),
                    |row| row.get(0),
                )
                .map_err(io::Error::other)?;

            let limit_i64 = i64::try_from(limit).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "limit does not fit in i64")
            })?;
            let cursor_i64 = i64::try_from(cursor).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "cursor does not fit in i64")
            })?;

            let page_sql = format!(
                "SELECT issue_id, issue_identifier, outcome, steps_traversed, attempts, duration_seconds, started_at, completed_at, last_error, verdict, workspace_path, input_tokens, output_tokens, total_tokens FROM runs{where_sql} ORDER BY completed_at DESC LIMIT ? OFFSET ?"
            );
            let mut page_params = base_params;
            page_params.push(Value::from(limit_i64));
            page_params.push(Value::from(cursor_i64));

            let mut stmt = conn.prepare(&page_sql).map_err(io::Error::other)?;
            let rows = stmt
                .query_map(
                    params_from_iter(page_params),
                    crate::history_store::model::row_to_history_record,
                )
                .map_err(io::Error::other)?;

            let page: Vec<HistoryRecord> = rows
                .map(|r| r.map_err(io::Error::other))
                .collect::<Result<_, _>>()?;
            let next_cursor = if cursor + page.len() < total {
                Some(cursor + page.len())
            } else {
                None
            };

            Ok(HistoryResponse {
                records: page,
                total,
                next_cursor,
            })
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn read_timeline(
        &self,
        query: &TimelineQuery,
        issue_identifier: Option<&str>,
    ) -> Result<TimelineResponse, io::Error> {
        let path = self.db_path.clone();
        let run_id = query.run_id.clone();
        let issue_identifier = issue_identifier.map(ToString::to_string);
        let cursor = query.cursor.unwrap_or(0);
        let limit = query.limit.unwrap_or(50).min(200);
        tokio::task::spawn_blocking(move || -> Result<TimelineResponse, io::Error> {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let mut where_clauses = vec!["run_id = ?".to_string()];
            let mut base_params = vec![Value::from(run_id)];
            if let Some(identifier) = issue_identifier {
                where_clauses.push("issue_identifier = ?".to_string());
                base_params.push(Value::from(identifier));
            }
            let where_sql = format!(" WHERE {}", where_clauses.join(" AND "));

            let count_sql = format!("SELECT COUNT(*) FROM run_events{where_sql}");
            let total: usize = conn
                .query_row(
                    &count_sql,
                    params_from_iter(base_params.clone()),
                    |row| row.get(0),
                )
                .map_err(io::Error::other)?;

            let limit_i64 = i64::try_from(limit).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "limit does not fit in i64")
            })?;
            let cursor_i64 = i64::try_from(cursor).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "cursor does not fit in i64")
            })?;

            let query_sql = format!(
                "SELECT run_id, issue_identifier, sequence, timestamp, event_type, step_name, attempt, detail, verdict, tool_name FROM run_events{where_sql} ORDER BY sequence ASC LIMIT ? OFFSET ?"
            );
            let mut query_params = base_params;
            query_params.push(Value::from(limit_i64));
            query_params.push(Value::from(cursor_i64));

            let mut stmt = conn.prepare(&query_sql).map_err(io::Error::other)?;
            let rows = stmt
                .query_map(
                    params_from_iter(query_params),
                    crate::history_store::model::row_to_timeline_record,
                )
                .map_err(io::Error::other)?;

            let page: Vec<TimelineEventRecord> = rows
                .map(|r| r.map_err(io::Error::other))
                .collect::<Result<_, _>>()?;
            let next_cursor = if cursor + page.len() < total {
                Some(cursor + page.len())
            } else {
                None
            };

            Ok(TimelineResponse {
                events: page,
                total,
                next_cursor,
            })
        })
        .await
        .map_err(io::Error::other)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::TokenTotals;
    use chrono::Utc;

    fn sample_history(identifier: &str) -> HistoryRecord {
        HistoryRecord {
            issue_identifier: identifier.into(),
            issue_id: format!("id-{identifier}"),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into(), "review".into()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 1,
                output_tokens: 2,
                total_tokens: 3,
            },
            duration_seconds: 15,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: Some("approved".into()),
            workspace_path: format!("/tmp/{identifier}"),
        }
    }

    fn sample_event(run_id: &str, issue_identifier: &str, sequence: u64) -> TimelineEventRecord {
        TimelineEventRecord {
            run_id: run_id.into(),
            issue_identifier: issue_identifier.into(),
            sequence,
            timestamp: Utc::now(),
            event_type: "step_started".into(),
            step_name: Some("build".into()),
            attempt: 1,
            detail: format!("event-{sequence}"),
            verdict: None,
            tool_name: None,
        }
    }

    #[tokio::test]
    async fn append_history_record_is_queryable() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();

        store
            .append_history_record("run-1", &sample_history("repo#1"))
            .await
            .unwrap();

        let response = store.read_history(&HistoryQuery::default()).await.unwrap();
        assert_eq!(response.total, 1);
        assert_eq!(response.records[0].issue_identifier, "repo#1");
    }

    #[tokio::test]
    async fn append_timeline_event_is_queryable_in_sequence_order() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();

        store
            .append_timeline_event(&sample_event("run-1", "repo#1", 2))
            .await
            .unwrap();
        store
            .append_timeline_event(&sample_event("run-1", "repo#1", 1))
            .await
            .unwrap();

        let response = store
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();

        assert_eq!(response.total, 2);
        assert_eq!(response.events[0].sequence, 1);
        assert_eq!(response.events[1].sequence, 2);
    }

    #[tokio::test]
    async fn append_timeline_event_is_idempotent_for_duplicate_sequence() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();
        let event = sample_event("run-1", "repo#1", 1);

        store.append_timeline_event(&event).await.unwrap();
        store.append_timeline_event(&event).await.unwrap();

        let response = store
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();

        assert_eq!(response.total, 1);
    }
}
