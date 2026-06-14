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

    pub fn transcript_path(
        &self,
        run_id: &str,
        step_name: &str,
    ) -> Result<PathBuf, std::io::Error> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{
        TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION,
    };
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
        let parsed: TranscriptRecord =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
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
