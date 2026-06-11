use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::warn;

use crate::pipeline::engine::PipelineRunSnapshot;
use crate::tracker::model::RetryEntry;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineTransitionKind {
    RunStarted,
    StepRunning,
    StepCompleted,
    StepFailed,
    StepBlockedOnHuman,
    StepAwaitingApproval,
    ApprovalResolved,
    StepRetryScheduled,
    FixupRetryScheduled,
    PipelineHalted,
    PipelineSucceeded,
    PipelineFailed,
    Released,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineTransitionRecord {
    pub schema_version: u32,
    pub seq: u64,
    pub kind: PipelineTransitionKind,
    pub issue_id: String,
    pub identifier: String,
    pub run_id: Option<String>,
    pub cycle: u32,
    pub step: Option<String>,
    pub reason: Option<String>,
    pub retry: Option<RetryEntry>,
    pub snapshot: Option<PipelineRunSnapshot>,
    pub written_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct PipelineTransitionInput {
    pub kind: PipelineTransitionKind,
    pub issue_id: String,
    pub identifier: String,
    pub run_id: Option<String>,
    pub cycle: u32,
    pub step: Option<String>,
    pub reason: Option<String>,
    pub retry: Option<RetryEntry>,
    pub snapshot: Option<PipelineRunSnapshot>,
}

#[derive(Debug, Clone)]
pub struct PipelineRunJournal {
    root: PathBuf,
}

impl PipelineRunJournal {
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: config_dir.into().join("state").join("pipeline-runs"),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path_for_issue(&self, issue_id: &str) -> PathBuf {
        self.root
            .join(format!("{}.jsonl", encode_issue_id(issue_id)))
    }

    pub async fn append(
        &self,
        input: PipelineTransitionInput,
    ) -> Result<PipelineTransitionRecord, std::io::Error> {
        tokio::fs::create_dir_all(&self.root).await?;
        let path = self.path_for_issue(&input.issue_id);
        let seq = self
            .read_last_valid_record(&path)
            .await?
            .map(|record| record.seq + 1)
            .unwrap_or(1);

        let record = PipelineTransitionRecord {
            schema_version: SCHEMA_VERSION,
            seq,
            kind: input.kind,
            issue_id: input.issue_id,
            identifier: input.identifier,
            run_id: input.run_id,
            cycle: input.cycle,
            step: input.step,
            reason: input.reason,
            retry: input.retry,
            snapshot: input.snapshot,
            written_at: Utc::now(),
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        let line =
            serde_json::to_string(&record).map_err(|error| invalid_data(error.to_string()))?;
        file.write_all(line.as_bytes()).await?;
        file.write_all(b"\n").await?;
        file.flush().await?;
        Ok(record)
    }

    pub async fn append_released(
        &self,
        issue_id: &str,
        identifier: &str,
        run_id: Option<String>,
        reason: &str,
    ) -> Result<PipelineTransitionRecord, std::io::Error> {
        self.append(PipelineTransitionInput {
            kind: PipelineTransitionKind::Released,
            issue_id: issue_id.to_string(),
            identifier: identifier.to_string(),
            run_id,
            cycle: 0,
            step: None,
            reason: Some(reason.to_string()),
            retry: None,
            snapshot: None,
        })
        .await
    }

    pub async fn read_records_for_issue(
        &self,
        issue_id: &str,
    ) -> Result<Vec<PipelineTransitionRecord>, std::io::Error> {
        self.read_records_from_path(&self.path_for_issue(issue_id))
            .await
    }

    pub async fn latest_live_records(
        &self,
    ) -> Result<Vec<PipelineTransitionRecord>, std::io::Error> {
        let mut records = Vec::new();
        let mut entries = match tokio::fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(record) = self.read_last_valid_record(&path).await? {
                if record.schema_version == SCHEMA_VERSION
                    && record.kind != PipelineTransitionKind::Released
                    && record.snapshot.is_some()
                {
                    records.push(record);
                }
            }
        }

        records.sort_by(|left, right| left.issue_id.cmp(&right.issue_id));
        Ok(records)
    }

    async fn read_last_valid_record(
        &self,
        path: &Path,
    ) -> Result<Option<PipelineTransitionRecord>, std::io::Error> {
        let records = self.read_records_from_path(path).await?;
        Ok(records.into_iter().last())
    }

    async fn read_records_from_path(
        &self,
        path: &Path,
    ) -> Result<Vec<PipelineTransitionRecord>, std::io::Error> {
        let file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };

        let mut records = Vec::new();
        let mut lines = BufReader::new(file).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<PipelineTransitionRecord>(&line) {
                Ok(record) if record.schema_version == SCHEMA_VERSION => records.push(record),
                Ok(record) => {
                    warn!(
                        schema_version = record.schema_version,
                        path = %path.display(),
                        "skipping unsupported pipeline journal record"
                    );
                }
                Err(error) => {
                    warn!(
                        path = %path.display(),
                        error = %error,
                        "skipping malformed pipeline journal line"
                    );
                }
            }
        }
        Ok(records)
    }
}

fn encode_issue_id(issue_id: &str) -> String {
    if issue_id.is_empty() {
        return "%EMPTY".to_string();
    }

    let mut encoded = String::new();
    for byte in issue_id.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                encoded.push(*byte as char);
            }
            other => {
                encoded.push('%');
                encoded.push_str(&format!("{other:02X}"));
            }
        }
    }
    encoded
}

#[cfg(test)]
fn decode_issue_id(encoded: &str) -> Result<String, std::io::Error> {
    if encoded == "%EMPTY" {
        return Ok(String::new());
    }

    let mut bytes = Vec::new();
    let mut chars = encoded.as_bytes().iter().copied().peekable();
    while let Some(byte) = chars.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }
        let high = chars
            .next()
            .ok_or_else(|| invalid_data("truncated percent escape"))?;
        let low = chars
            .next()
            .ok_or_else(|| invalid_data("truncated percent escape"))?;
        let value = hex_value(high)? * 16 + hex_value(low)?;
        bytes.push(value);
    }
    String::from_utf8(bytes).map_err(|error| invalid_data(error.to_string()))
}

#[cfg(test)]
fn hex_value(byte: u8) -> Result<u8, std::io::Error> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(invalid_data("invalid percent escape")),
    }
}

fn invalid_data(reason: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, reason.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{OnFailure, StepConfig, StepKind};
    use crate::pipeline::dag::build_dag;
    use crate::pipeline::engine::{PipelineRun, StepState};
    use tempfile::tempdir;
    use tokio::io::AsyncWriteExt;

    fn step(name: &str, depends: Option<Vec<String>>) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends,
            tracker_state: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }
    }

    fn snapshot() -> PipelineRunSnapshot {
        let dag = build_dag(&[step("build", Some(vec![]))]).unwrap();
        let mut run = PipelineRun::new("issue/1".to_string(), 1, dag);
        run.step_states
            .insert("build".to_string(), StepState::Passed);
        run.to_snapshot()
    }

    #[tokio::test]
    async fn journal_appends_records_with_incrementing_seq() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::RunStarted,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
            })
            .await
            .unwrap();
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepCompleted,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("passed".to_string()),
                retry: None,
                snapshot: Some(snapshot()),
            })
            .await
            .unwrap();

        let records = journal.read_records_for_issue("issue/1").await.unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].seq, 1);
        assert_eq!(records[1].seq, 2);
        assert_eq!(records[1].kind, PipelineTransitionKind::StepCompleted);
    }

    #[tokio::test]
    async fn latest_live_records_skip_released_issues() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::RunStarted,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: None,
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
            })
            .await
            .unwrap();
        journal
            .append_released("issue/1", "repo#1", None, "completed")
            .await
            .unwrap();

        let live = journal.latest_live_records().await.unwrap();
        assert!(live.is_empty());
    }

    #[tokio::test]
    async fn malformed_trailing_line_does_not_hide_last_valid_record() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::RunStarted,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: None,
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
            })
            .await
            .unwrap();

        let path = journal.path_for_issue("issue/1");
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap()
            .write_all(b"{not json}\n")
            .await
            .unwrap();

        let live = journal.latest_live_records().await.unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].issue_id, "issue/1");
    }

    #[test]
    fn issue_id_encoding_is_reversible_and_filename_safe() {
        let issue_id = "repo/name#42 with spaces";
        let encoded = encode_issue_id(issue_id);
        assert!(!encoded.contains('/'));
        assert!(!encoded.contains(' '));
        assert_eq!(decode_issue_id(&encoded).unwrap(), issue_id);
    }

    #[test]
    fn issue_id_encoding_round_trips_empty_issue_id() {
        let encoded = encode_issue_id("");
        assert_eq!(decode_issue_id(&encoded).unwrap(), "");
    }
}
