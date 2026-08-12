use crate::attention::{
    AttentionError, AttentionEvent, AttentionEvidence, AttentionIdentity, AttentionItem,
    AttentionLifecycleState, AttentionPresentation,
};
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

pub(crate) fn row_to_attention_event(row: &Row<'_>) -> rusqlite::Result<AttentionEvent> {
    let state: String = row.get("state")?;
    let timestamp: String = row.get("timestamp")?;
    let superseding_identity_json: Option<String> = row.get("superseding_identity_json")?;
    let superseding_identity = superseding_identity_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(sql_conversion_error)?;
    let evidence = AttentionEvidence {
        fingerprint: row.get("fingerprint")?,
    };
    AttentionEvidence::new(&evidence.fingerprint).map_err(attention_conversion_error)?;
    let sequence: i64 = row.get("sequence")?;
    Ok(AttentionEvent {
        sequence: u64::try_from(sequence).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        identity: AttentionIdentity {
            producer_key: row.get("producer_key")?,
            subject_ref: row.get("subject_ref")?,
            kind: row.get("kind")?,
        },
        state: AttentionLifecycleState::parse(&state).map_err(attention_conversion_error)?,
        evidence,
        timestamp: parse_utc(&timestamp)?,
        superseding_identity,
    })
}

pub(crate) fn row_to_history_record(row: &Row<'_>) -> rusqlite::Result<HistoryRecord> {
    let steps_json: String = row.get("steps_traversed")?;
    let steps_traversed: Vec<String> = serde_json::from_str(&steps_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;

    let started_at_raw: String = row.get("started_at")?;
    let completed_at_raw: String = row.get("completed_at")?;
    let artifacts_json: Option<String> = row.get("artifacts")?;
    let artifacts = artifacts_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    let acceptance_attempts_json: Option<String> = row.get("acceptance_attempts")?;
    let acceptance_attempts = acceptance_attempts_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?
        .unwrap_or_default();

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
        acceptance_attempts,
        artifacts,
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

pub(crate) fn row_to_attention_item(row: &Row<'_>) -> rusqlite::Result<AttentionItem> {
    let references_json: String = row.get("references_json")?;
    let references = serde_json::from_str(&references_json).map_err(sql_conversion_error)?;
    let superseding_identity_json: Option<String> = row.get("superseding_identity_json")?;
    let superseding_identity = superseding_identity_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(sql_conversion_error)?;
    let identity = AttentionIdentity {
        producer_key: row.get("producer_key")?,
        subject_ref: row.get("subject_ref")?,
        kind: row.get("kind")?,
    };
    identity.validate().map_err(attention_conversion_error)?;
    let presentation = AttentionPresentation {
        summary: row.get("summary")?,
        remedy: row.get("remedy")?,
        references,
    };
    presentation
        .validate()
        .map_err(attention_conversion_error)?;
    let evidence = AttentionEvidence {
        fingerprint: row.get("fingerprint")?,
    };
    AttentionEvidence::new(&evidence.fingerprint).map_err(attention_conversion_error)?;
    let state: String = row.get("state")?;
    let opened_at: String = row.get("opened_at")?;
    let updated_at: String = row.get("updated_at")?;
    let closed_at: Option<String> = row.get("closed_at")?;

    Ok(AttentionItem {
        identity,
        presentation,
        evidence,
        state: AttentionLifecycleState::parse(&state).map_err(attention_conversion_error)?,
        opened_at: parse_utc(&opened_at)?,
        updated_at: parse_utc(&updated_at)?,
        closed_at: closed_at.as_deref().map(parse_utc).transpose()?,
        superseding_identity,
    })
}

fn sql_conversion_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn attention_conversion_error(error: AttentionError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
