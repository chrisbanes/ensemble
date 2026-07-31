use std::io::{Read, Seek, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};

use super::model::{sanitize_run_path_segment, sanitize_step_path_segment, TranscriptRecord};

struct AdvisoryFileLock(RawFd);

impl Drop for AdvisoryFileLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor remains open until after this guard is dropped.
        unsafe {
            libc::flock(self.0, libc::LOCK_UN);
        }
    }
}

fn lock_file(
    file: &std::fs::File,
    operation: libc::c_int,
) -> Result<AdvisoryFileLock, std::io::Error> {
    loop {
        // SAFETY: `file` owns a valid descriptor for the duration of this call.
        if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
            return Ok(AdvisoryFileLock(file.as_raw_fd()));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

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

        tokio::task::spawn_blocking(move || {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            let _lock = lock_file(&file, libc::LOCK_EX)?;
            file.write_all(line.as_bytes())?;
            file.flush()
        })
        .await
        .map_err(std::io::Error::other)?
    }

    pub(crate) async fn read_snapshot(
        &self,
        run_id: &str,
        step_name: &str,
    ) -> Result<Option<Vec<u8>>, std::io::Error> {
        let path = self.transcript_path(run_id, step_name)?;
        tokio::task::spawn_blocking(move || {
            let mut file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            let _lock = lock_file(&file, libc::LOCK_SH)?;
            let mut contents = Vec::new();
            file.read_to_end(&mut contents)?;
            Ok(Some(contents))
        })
        .await
        .map_err(std::io::Error::other)?
    }

    pub(crate) async fn prepare_append(
        &self,
        run_id: &str,
        step_name: &str,
        valid_bytes: usize,
        needs_separator: bool,
    ) -> Result<(), std::io::Error> {
        let path = self.transcript_path(run_id, step_name)?;
        let valid_bytes = u64::try_from(valid_bytes).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "transcript length does not fit in u64",
            )
        })?;
        tokio::task::spawn_blocking(move || {
            let mut file = std::fs::OpenOptions::new().write(true).open(path)?;
            let _lock = lock_file(&file, libc::LOCK_EX)?;
            file.set_len(valid_bytes)?;
            if needs_separator {
                file.seek(std::io::SeekFrom::End(0))?;
                file.write_all(b"\n")?;
            }
            file.flush()
        })
        .await
        .map_err(std::io::Error::other)?
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
