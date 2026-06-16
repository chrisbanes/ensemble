use crate::history::model::{HistoryRecord, TokenTotals};
use crate::timeline::model::TimelineEventRecord;
use chrono::{DateTime, Utc};
use rusqlite::Row;

fn parse_utc(ts: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
}

pub(crate) fn row_to_history_record(row: &Row<'_>) -> rusqlite::Result<HistoryRecord> {
    let steps_json: String = row.get("steps_traversed")?;
    let steps_traversed: Vec<String> = serde_json::from_str(&steps_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;

    let started_at_raw: String = row.get("started_at")?;
    let completed_at_raw: String = row.get("completed_at")?;

    Ok(HistoryRecord {
        issue_identifier: row.get("issue_identifier")?,
        issue_id: row.get("issue_id")?,
        outcome: row.get("outcome")?,
        steps_traversed,
        attempts: row.get("attempts")?,
        tokens: TokenTotals {
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            total_tokens: row.get("total_tokens")?,
        },
        duration_seconds: row.get("duration_seconds")?,
        started_at: parse_utc(&started_at_raw)?,
        completed_at: parse_utc(&completed_at_raw)?,
        last_error: row.get("last_error")?,
        verdict: row.get("verdict")?,
        workspace_path: row.get("workspace_path")?,
        artifacts: None,
    })
}

pub(crate) fn row_to_timeline_record(row: &Row<'_>) -> rusqlite::Result<TimelineEventRecord> {
    let timestamp_raw: String = row.get("timestamp")?;
    Ok(TimelineEventRecord {
        run_id: row.get("run_id")?,
        issue_identifier: row.get("issue_identifier")?,
        sequence: row.get("sequence")?,
        timestamp: parse_utc(&timestamp_raw)?,
        event_type: row.get("event_type")?,
        step_name: row.get("step_name")?,
        attempt: row.get("attempt")?,
        detail: row.get("detail")?,
        verdict: row.get("verdict")?,
        tool_name: row.get("tool_name")?,
    })
}
