use std::io;
use std::path::PathBuf;

use rusqlite::{params, Connection};

use crate::history::model::HistoryRecord;
use crate::history::reader::{HistoryQuery, HistoryResponse};
use crate::timeline::model::TimelineEventRecord;
use crate::timeline::reader::{TimelineQuery, TimelineResponse};

#[derive(Debug, Clone)]
pub struct HistoryStore {
    db_path: PathBuf,
}

impl HistoryStore {
    pub async fn new(db_path: PathBuf) -> Result<Self, io::Error> {
        let path = db_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), io::Error> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let conn = Connection::open(&path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            crate::history_store::schema::bootstrap_schema(&conn).map_err(io::Error::other)?;
            Ok(())
        })
        .await
        .map_err(io::Error::other)??;

        Ok(Self { db_path })
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
            let tx = conn.transaction().map_err(io::Error::other)?;
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
            let tx = conn.transaction().map_err(io::Error::other)?;
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

            let mut sql = String::from(
                "SELECT issue_id, issue_identifier, outcome, steps_traversed, attempts, duration_seconds, started_at, completed_at, last_error, verdict, workspace_path, input_tokens, output_tokens, total_tokens FROM runs",
            );
            if outcome.is_some() {
                sql.push_str(" WHERE outcome = ?1");
            }
            sql.push_str(" ORDER BY completed_at DESC");

            let mut stmt = conn.prepare(&sql).map_err(io::Error::other)?;
            let rows = if let Some(outcome) = outcome {
                stmt.query_map([outcome], crate::history_store::model::row_to_history_record)
            } else {
                stmt.query_map([], crate::history_store::model::row_to_history_record)
            }
            .map_err(io::Error::other)?;

            let mut records: Vec<HistoryRecord> = rows
                .map(|r| r.map_err(io::Error::other))
                .collect::<Result<_, _>>()?;

            if let Some(step) = step {
                records.retain(|r| r.steps_traversed.contains(&step));
            }

            let total = records.len();
            let page = records.into_iter().skip(cursor).take(limit).collect::<Vec<_>>();
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
            let mut sql = String::from(
                "SELECT run_id, issue_identifier, sequence, timestamp, event_type, step_name, attempt, detail, verdict, tool_name FROM run_events WHERE run_id = ?1",
            );
            if issue_identifier.is_some() {
                sql.push_str(" AND issue_identifier = ?2");
            }
            sql.push_str(" ORDER BY sequence ASC");

            let mut stmt = conn.prepare(&sql).map_err(io::Error::other)?;
            let rows = if let Some(identifier) = issue_identifier {
                stmt.query_map(params![run_id, identifier], crate::history_store::model::row_to_timeline_record)
            } else {
                stmt.query_map([run_id], crate::history_store::model::row_to_timeline_record)
            }
            .map_err(io::Error::other)?;

            let events: Vec<TimelineEventRecord> = rows
                .map(|r| r.map_err(io::Error::other))
                .collect::<Result<_, _>>()?;

            let total = events.len();
            let page = events.into_iter().skip(cursor).take(limit).collect::<Vec<_>>();
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
