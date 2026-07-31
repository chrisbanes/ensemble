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

pub(crate) struct TranscriptScan {
    pub maximum_sequence: u64,
    pub valid_bytes: usize,
    pub needs_separator: bool,
    pub needs_repair: bool,
}

fn parse_transcript_records(
    contents: &[u8],
    mut on_record: impl FnMut(TranscriptRecord),
) -> Result<TranscriptScan, serde_json::Error> {
    let mut lines = contents.split_inclusive(|byte| *byte == b'\n').peekable();
    let mut maximum_sequence = 0;
    let mut valid_bytes = 0;

    while let Some(line_with_separator) = lines.next() {
        let line = line_with_separator
            .strip_suffix(b"\n")
            .unwrap_or(line_with_separator);
        match serde_json::from_slice(line) {
            Ok(record) => {
                let record: TranscriptRecord = record;
                maximum_sequence = maximum_sequence.max(record.sequence);
                on_record(record);
                valid_bytes += line_with_separator.len();
            }
            Err(_) if lines.peek().is_none() => break,
            Err(error) => return Err(error),
        }
    }

    let needs_separator = valid_bytes > 0 && contents.get(valid_bytes - 1) != Some(&b'\n');
    Ok(TranscriptScan {
        maximum_sequence,
        valid_bytes,
        needs_separator,
        needs_repair: valid_bytes != contents.len() || needs_separator,
    })
}

async fn scan_transcript_with(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
    on_record: impl FnMut(TranscriptRecord),
) -> Result<TranscriptScan, Box<dyn std::error::Error + Send + Sync>> {
    let writer = TranscriptWriter::new(workspace_root.to_path_buf());
    let Some(contents) = writer.read_snapshot(run_id, step_name).await? else {
        return Ok(TranscriptScan {
            maximum_sequence: 0,
            valid_bytes: 0,
            needs_separator: false,
            needs_repair: false,
        });
    };

    Ok(parse_transcript_records(&contents, on_record)?)
}

pub(crate) async fn scan_transcript(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
) -> Result<TranscriptScan, Box<dyn std::error::Error + Send + Sync>> {
    scan_transcript_with(workspace_root, run_id, step_name, |_| {}).await
}

pub(crate) async fn read_transcript_records(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
) -> Result<Vec<TranscriptRecord>, Box<dyn std::error::Error + Send + Sync>> {
    let mut records = Vec::new();
    scan_transcript_with(workspace_root, run_id, step_name, |record| {
        records.push(record);
    })
    .await?;
    Ok(records)
}

pub async fn read_transcript_page(
    workspace_root: &Path,
    run_id: &str,
    step_name: &str,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptResponse, Box<dyn std::error::Error + Send + Sync>> {
    let records = read_transcript_records(workspace_root, run_id, step_name).await?;
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
    let records = read_transcript_records(workspace_root, run_id, step_name).await?;
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
    use std::io::Write;
    use std::os::fd::AsRawFd;
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

    fn append_bytes(path: &Path, bytes: &[u8]) {
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(bytes).unwrap();
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

    #[tokio::test]
    async fn read_transcript_page_preserves_records_before_malformed_tail() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        append_bytes(
            &writer.transcript_path("run-1", "build").unwrap(),
            br#"{"schema_version":1,"run_id":"run-1""#,
        );

        let response = read_transcript_page(temp_dir.path(), "run-1", "build", None, None)
            .await
            .unwrap();

        assert_eq!(response.total, 1);
        assert_eq!(response.records[0].sequence, 1);
    }

    #[tokio::test]
    async fn read_transcript_page_preserves_records_before_truncated_utf8_tail() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        append_bytes(
            &writer.transcript_path("run-1", "build").unwrap(),
            &[0xf0, 0x9f],
        );

        let response = read_transcript_page(temp_dir.path(), "run-1", "build", None, None)
            .await
            .unwrap();

        assert_eq!(response.total, 1);
        assert_eq!(response.records[0].sequence, 1);
    }

    #[tokio::test]
    async fn read_transcript_page_rejects_non_tail_corruption() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        append_bytes(
            &writer.transcript_path("run-1", "build").unwrap(),
            b"{broken}\n",
        );
        writer.append(&sample_record(2)).await.unwrap();

        let result = read_transcript_page(temp_dir.path(), "run-1", "build", None, None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn read_transcript_page_waits_for_an_in_progress_append() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TranscriptWriter::new(temp_dir.path().to_path_buf());
        writer.append(&sample_record(1)).await.unwrap();
        let path = writer.transcript_path("run-1", "build").unwrap();
        let mut second_line = serde_json::to_vec(&sample_record(2)).unwrap();
        second_line.push(b'\n');
        let split = second_line.len() / 2;
        let mut append = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        assert_eq!(unsafe { libc::flock(append.as_raw_fd(), libc::LOCK_EX) }, 0);
        append.write_all(&second_line[..split]).unwrap();
        append.flush().unwrap();

        let workspace_root = temp_dir.path().to_path_buf();
        let read = tokio::spawn(async move {
            read_transcript_page(&workspace_root, "run-1", "build", None, None).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!read.is_finished());

        append.write_all(&second_line[split..]).unwrap();
        append.flush().unwrap();
        assert_eq!(unsafe { libc::flock(append.as_raw_fd(), libc::LOCK_UN) }, 0);

        let response = read.await.unwrap().unwrap();
        assert_eq!(
            response
                .records
                .iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
