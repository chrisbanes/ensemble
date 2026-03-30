use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use super::model::HistoryRecord;

#[derive(Debug, Clone)]
pub struct HistoryWriter {
    path: PathBuf,
}

impl HistoryWriter {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

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
        assert_eq!(contents.lines().count(), 2);
    }
}
