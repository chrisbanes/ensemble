use std::path::{Path, PathBuf};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};

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

    async fn sync_parent(&self) -> Result<(), std::io::Error> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            File::open(parent).await?.sync_all().await?;
        }
        Ok(())
    }

    async fn repair_trailing_record(&self) -> Result<(), std::io::Error> {
        let mut file = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let len = file.metadata().await?.len();
        if len == 0 {
            return Ok(());
        }

        const TAIL_SCAN_CHUNK_BYTES: u64 = 8 * 1024;
        let mut cursor = len;
        let mut tail_start = 0;
        while cursor > 0 {
            let chunk_start = cursor.saturating_sub(TAIL_SCAN_CHUNK_BYTES);
            let mut chunk = vec![0; (cursor - chunk_start) as usize];
            file.seek(std::io::SeekFrom::Start(chunk_start)).await?;
            file.read_exact(&mut chunk).await?;
            if let Some(position) = chunk.iter().rposition(|byte| *byte == b'\n') {
                tail_start = chunk_start + position as u64 + 1;
                break;
            }
            cursor = chunk_start;
        }
        if tail_start == len {
            return Ok(());
        }

        let mut tail = vec![0; (len - tail_start) as usize];
        file.seek(std::io::SeekFrom::Start(tail_start)).await?;
        file.read_exact(&mut tail).await?;
        if serde_json::from_slice::<HistoryRecord>(&tail).is_ok() {
            file.seek(std::io::SeekFrom::End(0)).await?;
            file.write_all(b"\n").await?;
        } else {
            file.set_len(tail_start).await?;
        }
        file.flush().await?;
        file.sync_data().await
    }

    pub async fn append(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        self.repair_trailing_record().await?;
        self.append_repaired(record).await
    }

    async fn append_repaired(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        let mut line = serde_json::to_string(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');

        let (mut file, created) = match OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&self.path)
            .await
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
                OpenOptions::new().append(true).open(&self.path).await?,
                false,
            ),
            Err(error) => return Err(error),
        };

        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        file.sync_data().await?;
        if created {
            self.sync_parent().await?;
        }
        Ok(())
    }

    pub async fn append_if_absent(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        self.repair_trailing_record().await?;
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
                    OpenOptions::new()
                        .read(true)
                        .open(&self.path)
                        .await?
                        .sync_data()
                        .await?;
                    self.sync_parent().await?;
                    return Ok(());
                }
            }
        }

        self.append_repaired(record).await
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
    async fn append_if_absent_repairs_a_torn_trailing_record() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let first = sample_record();
        let mut second = sample_record();
        second.issue_identifier = "MT-649".into();
        let contents = format!(
            "{}\n{{\"issue_identifier\":",
            serde_json::to_string(&first).unwrap()
        );
        tokio::fs::write(&path, contents).await.unwrap();
        let writer = HistoryWriter::new(path.clone());

        writer.append_if_absent(&second).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let records = contents
            .lines()
            .map(|line| serde_json::from_str::<HistoryRecord>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records, [first, second]);
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
                pr_number: None,
                pr_url: None,
                review_state: None,
                review_projection: None,
                last_error: None,
                observation: None,
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
