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
    let limit = limit.unwrap_or(50).clamp(1, 200);
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
    let writer = TranscriptWriter::new(workspace_root.to_path_buf());
    let path = writer.transcript_path(run_id, step_name)?;
    let Some(contents) = read_transcript_file(&path).await? else {
        return Ok(None);
    };

    let records = parse_transcript_records(&contents)?;
    Ok(records
        .into_iter()
        .find(|record| record.sequence == sequence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{
        TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION,
    };
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
    async fn read_transcript_page_clamps_zero_limit_to_one() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        writer.append(&sample_record(2)).await.unwrap();

        let response = read_transcript_page(temp_dir.path(), "run-1", "build", Some(0), Some(0))
            .await
            .unwrap();

        assert_eq!(response.records.len(), 1);
        assert_eq!(response.records[0].sequence, 1);
        assert_eq!(response.total, 2);
        assert_eq!(response.next_cursor, Some(1));
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

    #[tokio::test]
    async fn read_transcript_record_finds_sequence_beyond_page_limit() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        for sequence in 1..=201 {
            writer.append(&sample_record(sequence)).await.unwrap();
        }

        let record = read_transcript_record(temp_dir.path(), "run-1", "build", 201)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(record.sequence, 201);
    }
}
