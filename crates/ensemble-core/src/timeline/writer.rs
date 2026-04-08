use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use super::model::TimelineEventRecord;

#[derive(Debug, Clone)]
pub struct TimelineWriter {
    workspace_root: PathBuf,
}

impl TimelineWriter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }

    pub fn events_path(&self, run_id: &str) -> PathBuf {
        self.workspace_root
            .join(".ensemble")
            .join("runs")
            .join(run_id)
            .join("events.jsonl")
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub async fn append(
        &self,
        run_id: &str,
        record: &TimelineEventRecord,
    ) -> Result<(), std::io::Error> {
        let path = self.events_path(run_id);
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
    use chrono::Utc;
    use tempfile::TempDir;

    fn sample_event(run_id: &str, sequence: u64) -> TimelineEventRecord {
        TimelineEventRecord {
            run_id: run_id.to_string(),
            issue_identifier: "repo#1".to_string(),
            sequence,
            timestamp: Utc::now(),
            event_type: "step_started".to_string(),
            step_name: Some("build".to_string()),
            attempt: 1,
            detail: "started build".to_string(),
            verdict: None,
            tool_name: None,
        }
    }

    #[tokio::test]
    async fn append_creates_run_events_file_and_writes_jsonl_line() {
        let temp_dir = TempDir::new().unwrap();
        let writer = TimelineWriter::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        writer.append("run-1", &record).await.unwrap();

        let contents = tokio::fs::read_to_string(writer.events_path("run-1"))
            .await
            .unwrap();
        assert_eq!(contents.lines().count(), 1);
    }
}
