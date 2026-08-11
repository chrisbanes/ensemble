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
            let artifacts_json = record
                .artifacts
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(io::Error::other)?;
            let acceptance_attempts_json =
                serde_json::to_string(&record.acceptance_attempts).map_err(io::Error::other)?;
            tx.execute(
                r#"
                INSERT INTO runs (
                    run_id, issue_id, issue_identifier, outcome, steps_traversed, attempts,
                    duration_seconds, started_at, completed_at, last_error, verdict,
                    workspace_path, input_tokens, output_tokens, total_tokens, artifacts,
                    acceptance_attempts
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
                    total_tokens = excluded.total_tokens,
                    artifacts = excluded.artifacts,
                    acceptance_attempts = excluded.acceptance_attempts
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
                    artifacts_json,
                    acceptance_attempts_json,
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

    pub(crate) async fn max_timeline_sequence(
        &self,
        run_id: &str,
    ) -> Result<Option<u64>, io::Error> {
        let path = self.db_path.clone();
        let run_id = run_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<u64>, io::Error> {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let maximum = conn
                .query_row(
                    "SELECT MAX(sequence) FROM run_events WHERE run_id = ?1",
                    params![run_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(io::Error::other)?;
            maximum
                .map(u64::try_from)
                .transpose()
                .map_err(io::Error::other)
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
                "SELECT issue_id, issue_identifier, outcome, steps_traversed, attempts, duration_seconds, started_at, completed_at, last_error, verdict, workspace_path, input_tokens, output_tokens, total_tokens, artifacts, acceptance_attempts FROM runs{where_sql} ORDER BY completed_at DESC LIMIT ? OFFSET ?"
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
                .map(|row| row.map_err(io::Error::other))
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

    pub(crate) async fn read_recent_step_events(
        &self,
        run_id: &str,
        issue_identifier: &str,
        step_name: &str,
        limit: usize,
    ) -> Result<Vec<TimelineEventRecord>, io::Error> {
        let store = self.clone();
        let run_id = run_id.to_string();
        let issue_identifier = issue_identifier.to_string();
        let step_name = step_name.to_string();
        tokio::task::spawn_blocking(move || {
            store.read_recent_step_events_blocking(&run_id, &issue_identifier, &step_name, limit)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(crate) fn read_recent_step_events_blocking(
        &self,
        run_id: &str,
        issue_identifier: &str,
        step_name: &str,
        limit: usize,
    ) -> Result<Vec<TimelineEventRecord>, io::Error> {
        let conn = Connection::open(&self.db_path).map_err(io::Error::other)?;
        crate::history_store::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
        let limit = i64::try_from(limit).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "limit does not fit in i64")
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT run_id, issue_identifier, sequence, timestamp, event_type, step_name, \
                 attempt, detail, verdict, tool_name FROM run_events \
                 WHERE run_id = ?1 AND issue_identifier = ?2 AND step_name = ?3 \
                 ORDER BY sequence DESC LIMIT ?4",
            )
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map(
                params![run_id, issue_identifier, step_name, limit],
                crate::history_store::model::row_to_timeline_record,
            )
            .map_err(io::Error::other)?;
        let mut events = rows
            .map(|row| row.map_err(io::Error::other))
            .collect::<Result<Vec<_>, _>>()?;
        events.reverse();
        Ok(events)
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
            acceptance_attempts: vec![],
            artifacts: None,
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
    async fn append_history_record_round_trips_artifacts() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();
        let mut record = sample_history("repo#1");
        record.artifacts = Some(crate::history::artifacts::RunArtifacts {
            run_id: "run-1".into(),
            workspace_path: "/tmp/repo-1".into(),
            repos: vec![crate::history::artifacts::RepoArtifact {
                repo: "repo".into(),
                worktree_path: "/tmp/repo-1/repo".into(),
                base_branch: "main".into(),
                branch: "ensemble/repo-1".into(),
                head_sha: Some("abc123".into()),
                changed_files: vec!["Cargo.toml".into()],
                finalize_mode: "push_and_pr".into(),
                finalize_status: "succeeded".into(),
                pushed_ref: Some("origin/ensemble/repo-1".into()),
                pr_number: Some(12),
                pr_url: Some("https://github.com/acme/repo/pull/12".into()),
                review_state: None,
                review_projection: None,
                last_error: None,
                observation: None,
            }],
            transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                step_name: "build".into(),
                run_id: "run-1".into(),
                record_count: 2,
            }],
        });

        store.append_history_record("run-1", &record).await.unwrap();

        let response = store.read_history(&HistoryQuery::default()).await.unwrap();
        let artifacts = response.records[0].artifacts.as_ref().unwrap();
        assert_eq!(
            artifacts.repos[0].pr_url.as_deref(),
            Some("https://github.com/acme/repo/pull/12")
        );
        assert_eq!(artifacts.transcripts[0].step_name, "build");
    }

    #[tokio::test]
    async fn append_history_record_round_trips_acceptance_attempts() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();
        let mut record = sample_history("repo#1");
        let mut command_result = crate::acceptance::AcceptanceResult::command(
            "test".into(),
            crate::acceptance::AcceptanceStatus::Passed,
            "passed".into(),
            Some(0),
            crate::acceptance::AcceptanceOutput {
                tail: "ok".into(),
                total_bytes: 2,
                truncated: false,
            },
            crate::acceptance::AcceptanceOutput {
                tail: String::new(),
                total_bytes: 0,
                truncated: false,
            },
        );
        command_result.timing = crate::acceptance::AcceptanceTiming::Observed {
            started_at: "2026-08-04T09:00:00Z".parse().unwrap(),
            completed_at: "2026-08-04T09:00:01Z".parse().unwrap(),
            duration_ms: 1_234,
        };
        record.acceptance_attempts = vec![crate::acceptance::AcceptanceAttempt {
            cycle: 1,
            results: vec![
                command_result,
                crate::acceptance::AcceptanceResult::new(
                    "artifact".into(),
                    crate::acceptance::AcceptanceStatus::Passed,
                    "present".into(),
                    crate::acceptance::AcceptanceEvidence::File {
                        repo: "repo".into(),
                        path: "artifact.txt".into(),
                        observation: crate::acceptance::FileObservation::Present,
                    },
                ),
                crate::acceptance::AcceptanceResult::new(
                    "handoff".into(),
                    crate::acceptance::AcceptanceStatus::Passed,
                    "complete".into(),
                    crate::acceptance::AcceptanceEvidence::Handoff {
                        step: "build".into(),
                        output: crate::acceptance::HandoffOutputObservation::Object,
                        sections: vec![crate::acceptance::HandoffSectionEvidence {
                            name: "summary".into(),
                            observation: crate::acceptance::HandoffSectionObservation::Present,
                        }],
                    },
                ),
                crate::acceptance::AcceptanceResult::new(
                    "pull-request".into(),
                    crate::acceptance::AcceptanceStatus::Passed,
                    "published".into(),
                    crate::acceptance::AcceptanceEvidence::PullRequest {
                        repo: "repo".into(),
                        delivery_phase: crate::acceptance::PullRequestDeliveryPhase::Published,
                        base_branch: Some("main".into()),
                        head_branch: Some("issue-1".into()),
                        head_sha: Some("abc123".into()),
                        pr_number: Some(12),
                        pr_url: Some("https://github.com/acme/repo/pull/12".into()),
                    },
                ),
            ],
        }];

        store.append_history_record("run-1", &record).await.unwrap();

        let response = store.read_history(&HistoryQuery::default()).await.unwrap();
        assert_eq!(
            response.records[0].acceptance_attempts,
            record.acceptance_attempts
        );
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
    async fn max_timeline_sequence_is_scoped_to_run() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();

        for (run_id, sequence) in [("run-1", 8), ("run-1", 3), ("run-2", 21)] {
            store
                .append_timeline_event(&sample_event(run_id, "repo#1", sequence))
                .await
                .unwrap();
        }

        assert_eq!(store.max_timeline_sequence("run-1").await.unwrap(), Some(8));
        assert_eq!(
            store.max_timeline_sequence("run-2").await.unwrap(),
            Some(21)
        );
        assert_eq!(store.max_timeline_sequence("unknown").await.unwrap(), None);
    }

    #[tokio::test]
    async fn recent_step_events_are_filtered_limited_and_chronological() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = HistoryStore::new(dir.path().join("history.db"))
            .await
            .unwrap();

        for sequence in 1..=4 {
            let mut event = sample_event("run-1", "repo#1", sequence);
            if sequence == 3 {
                event.step_name = Some("review".into());
            }
            store.append_timeline_event(&event).await.unwrap();
        }
        store
            .append_timeline_event(&sample_event("run-1", "repo#other", 5))
            .await
            .unwrap();

        let events = store
            .read_recent_step_events("run-1", "repo#1", "build", 2)
            .await
            .unwrap();

        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 4]
        );
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
