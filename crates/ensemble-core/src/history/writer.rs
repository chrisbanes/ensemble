use std::path::{Path, PathBuf};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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

    pub async fn append_if_absent(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        let file = match File::open(&self.path).await {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Some(file) = file {
            let mut lines = BufReader::new(file).lines();
            while let Some(line) = lines.next_line().await? {
                if serde_json::from_str::<HistoryRecord>(&line)
                    .is_ok_and(|existing| existing == *record)
                {
                    return Ok(());
                }
            }
        }

        self.append(record).await
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
            acceptance_attempts: vec![],
            artifacts: None,
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

    #[tokio::test]
    async fn append_if_absent_does_not_duplicate_the_same_record() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        let writer = HistoryWriter::new(path.clone());
        let record = sample_record();

        writer.append_if_absent(&record).await.unwrap();
        writer.append_if_absent(&record).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(contents.lines().count(), 1);
    }

    #[tokio::test]
    async fn append_round_trips_optional_artifacts() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        let writer = HistoryWriter::new(path.clone());
        let mut record = sample_record();
        record.artifacts = Some(crate::history::artifacts::RunArtifacts {
            run_id: "run-1".into(),
            workspace_path: "/tmp/workspace/repo-1".into(),
            repos: vec![crate::history::artifacts::RepoArtifact {
                repo: "repo".into(),
                worktree_path: "/tmp/workspace/repo-1/repo".into(),
                base_branch: "main".into(),
                branch: "ensemble/repo-1".into(),
                head_sha: Some("abc123".into()),
                changed_files: vec!["src/lib.rs".into()],
                finalize_mode: "none".into(),
                finalize_status: "not_required".into(),
                pushed_ref: None,
                pr_url: None,
                last_error: None,
            }],
            transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                step_name: "build".into(),
                run_id: "run-1".into(),
                record_count: 3,
            }],
        });

        writer.append(&record).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let parsed: HistoryRecord = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        let artifacts = parsed.artifacts.unwrap();
        assert_eq!(artifacts.run_id, "run-1");
        assert_eq!(artifacts.repos[0].finalize_mode, "none");
        assert_eq!(artifacts.transcripts[0].record_count, 3);
    }
}
