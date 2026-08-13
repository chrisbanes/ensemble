use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tracing::warn;

use crate::history::model::HistoryRecord;
use crate::orchestrator::delivery::DeliveryRecord;
use crate::pipeline::engine::PipelineRunSnapshot;
use crate::tracker::model::RetryEntry;

const SCHEMA_VERSION: u32 = 1;
type IssueAppendLock = tokio::sync::Mutex<()>;
type IssueAppendLockRegistry = Mutex<HashMap<PathBuf, Weak<IssueAppendLock>>>;
static ISSUE_APPEND_LOCKS: OnceLock<IssueAppendLockRegistry> = OnceLock::new();

fn requires_durable_sync(kind: PipelineTransitionKind, created: bool) -> bool {
    created
        || matches!(
            kind,
            PipelineTransitionKind::DeliveryOwned
                | PipelineTransitionKind::PendingTerminalTransition
                | PipelineTransitionKind::TerminalTransitionApplied
        )
}

pub(crate) struct PipelineIssueJournalTransaction<'a> {
    journal: &'a PipelineRunJournal,
    issue_id: String,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl PipelineIssueJournalTransaction<'_> {
    pub(crate) async fn latest_record(
        &self,
    ) -> Result<Option<PipelineTransitionRecord>, std::io::Error> {
        self.journal
            .read_last_valid_record(&self.journal.path_for_issue(&self.issue_id))
            .await
    }

    pub(crate) async fn append(
        &self,
        input: PipelineTransitionInput,
    ) -> Result<PipelineTransitionRecord, std::io::Error> {
        if input.issue_id != self.issue_id {
            return Err(invalid_data(format!(
                "issue transaction for '{}' cannot append record for '{}'",
                self.issue_id, input.issue_id
            )));
        }
        #[cfg(test)]
        if let Some((ready, release)) = &self.journal.transaction_append_test_barriers {
            ready.wait().await;
            release.wait().await;
        }
        #[cfg(test)]
        if let Some((calls, fail_on_call)) = &self.journal.transaction_append_error_on_call {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == *fail_on_call {
                return Err(std::io::Error::other(format!(
                    "injected error before journal append call {call}"
                )));
            }
        }
        #[cfg(test)]
        let kind = input.kind;
        let record = self.journal.append_unlocked(input).await?;
        #[cfg(test)]
        if self.journal.transaction_append_late_error
            || self.journal.transaction_append_late_error_kind == Some(kind)
        {
            return Err(std::io::Error::other(
                "injected error after a valid record became visible",
            ));
        }
        Ok(record)
    }

    pub(crate) async fn latest_record_matches(
        &self,
        input: &PipelineTransitionInput,
    ) -> Result<bool, std::io::Error> {
        #[cfg(test)]
        if self.journal.transaction_latest_record_match_error {
            return Err(std::io::Error::other(
                "injected latest-record reconciliation read error",
            ));
        }
        let latest = self
            .journal
            .read_last_valid_record(&self.journal.path_for_issue(&self.issue_id))
            .await?;
        Ok(latest
            .as_ref()
            .is_some_and(|record| record.matches_input(input)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineTransitionKind {
    RunStarted,
    StepRunning,
    /// A worker launch was durably committed; this authorizes gate delivery.
    StepLaunched,
    StepCompleted,
    StepFailed,
    StepBlockedOnHuman,
    StepAwaitingApproval,
    ApprovalResolved,
    AcceptanceStarted,
    AcceptanceCommandCompleted,
    AcceptanceCheckCompleted,
    StepRetryScheduled,
    FixupRetryScheduled,
    RunParked,
    PipelineHalted,
    PipelineSucceeded,
    PipelineFailed,
    PendingTerminalTransition,
    DeliveryOwned,
    TerminalTransitionApplied,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutcome {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingTerminalTransition {
    pub target_state: String,
    pub outcome: TerminalOutcome,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub last_attempted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub tracker_write_confirmed: bool,
    #[serde(default)]
    pub history_record: Option<HistoryRecord>,
}

impl PendingTerminalTransition {
    pub(crate) fn confirm_tracker_write(&mut self) {
        self.tracker_write_confirmed = true;
        self.attempt = 0;
        self.last_error = None;
        self.last_attempted_at = None;
    }
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
    #[serde(default)]
    pub terminal_transition: Option<PendingTerminalTransition>,
    #[serde(default)]
    pub(crate) delivery: Option<DeliveryRecord>,
    pub written_at: DateTime<Utc>,
}

impl PipelineTransitionRecord {
    fn matches_input(&self, input: &PipelineTransitionInput) -> bool {
        self.kind == input.kind
            && self.issue_id == input.issue_id
            && self.identifier == input.identifier
            && self.run_id == input.run_id
            && self.cycle == input.cycle
            && self.step == input.step
            && self.reason == input.reason
            && self.retry == input.retry
            && self.snapshot == input.snapshot
            && self.terminal_transition == input.terminal_transition
            && self.delivery == input.delivery
    }
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
    pub terminal_transition: Option<PendingTerminalTransition>,
    pub(crate) delivery: Option<DeliveryRecord>,
}

#[derive(Debug, Clone)]
pub struct PipelineRunJournal {
    root: PathBuf,
    #[cfg(test)]
    conditional_release_test_barriers:
        Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
    #[cfg(test)]
    pub(super) transaction_append_test_barriers:
        Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
    #[cfg(test)]
    pub(super) transaction_append_late_error: bool,
    #[cfg(test)]
    pub(super) transaction_append_late_error_kind: Option<PipelineTransitionKind>,
    #[cfg(test)]
    pub(super) transaction_latest_record_match_error: bool,
    #[cfg(test)]
    pub(super) transaction_append_error_on_call: Option<(Arc<AtomicUsize>, usize)>,
}

impl PipelineRunJournal {
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: config_dir.into().join("state").join("pipeline-runs"),
            #[cfg(test)]
            conditional_release_test_barriers: None,
            #[cfg(test)]
            transaction_append_test_barriers: None,
            #[cfg(test)]
            transaction_append_late_error: false,
            #[cfg(test)]
            transaction_append_late_error_kind: None,
            #[cfg(test)]
            transaction_latest_record_match_error: false,
            #[cfg(test)]
            transaction_append_error_on_call: None,
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
        self.begin_issue_transition(&input.issue_id)
            .await
            .append(input)
            .await
    }

    pub(crate) async fn begin_issue_transition(
        &self,
        issue_id: &str,
    ) -> PipelineIssueJournalTransaction<'_> {
        PipelineIssueJournalTransaction {
            journal: self,
            issue_id: issue_id.to_string(),
            _guard: self.issue_append_lock(issue_id).lock_owned().await,
        }
    }

    async fn append_unlocked(
        &self,
        input: PipelineTransitionInput,
    ) -> Result<PipelineTransitionRecord, std::io::Error> {
        tokio::fs::create_dir_all(&self.root).await?;
        let path = self.path_for_issue(&input.issue_id);
        self.repair_trailing_record(&path).await?;
        let created = match tokio::fs::metadata(&path).await {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(error),
        };
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
            terminal_transition: input.terminal_transition,
            delivery: input.delivery,
            written_at: Utc::now(),
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .write(true)
            .open(path)
            .await?;
        let original_len = file.metadata().await?.len();
        let mut line =
            serde_json::to_vec(&record).map_err(|error| invalid_data(error.to_string()))?;
        line.push(b'\n');
        if let Err(write_error) = file.write_all(&line).await {
            if let Err(truncate_error) = file.set_len(original_len).await {
                return Err(std::io::Error::other(format!(
                    "journal append failed: {write_error}; failed to truncate partial record: {truncate_error}"
                )));
            }
            return Err(write_error);
        }
        file.flush().await?;
        if requires_durable_sync(record.kind, created) {
            file.sync_data().await?;
        }
        if created {
            tokio::fs::File::open(&self.root).await?.sync_all().await?;
        }
        Ok(record)
    }

    async fn repair_trailing_record(&self, path: &Path) -> Result<(), std::io::Error> {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if bytes.is_empty() || bytes.ends_with(b"\n") {
            return Ok(());
        }

        let tail_start = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |position| position + 1);
        let tail = &bytes[tail_start..];
        let valid_complete_record = serde_json::from_slice::<PipelineTransitionRecord>(tail)
            .is_ok_and(|record| record.schema_version == SCHEMA_VERSION);
        let mut file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
        if valid_complete_record {
            file.seek(std::io::SeekFrom::End(0)).await?;
            file.write_all(b"\n").await?;
        } else {
            file.set_len(tail_start as u64).await?;
        }
        file.flush().await
    }

    fn issue_append_lock(&self, issue_id: &str) -> Arc<IssueAppendLock> {
        let path = self.path_for_issue(issue_id);
        let mut locks = ISSUE_APPEND_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(IssueAppendLock::new(()));
        locks.insert(path, Arc::downgrade(&lock));
        lock
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
            terminal_transition: None,
            delivery: None,
        })
        .await
    }

    pub async fn append_released_if_latest_retry_matches(
        &self,
        expected_retry: &RetryEntry,
        run_id: Option<String>,
        reason: &str,
    ) -> Result<Option<PipelineTransitionRecord>, std::io::Error> {
        let issue_lock = self.issue_append_lock(&expected_retry.issue_id);
        let _guard = issue_lock.lock().await;
        let path = self.path_for_issue(&expected_retry.issue_id);
        let latest_retry = self
            .read_last_valid_record(&path)
            .await?
            .and_then(|record| record.retry);
        if latest_retry.as_ref() != Some(expected_retry) {
            return Ok(None);
        }
        #[cfg(test)]
        if let Some((ready, release)) = &self.conditional_release_test_barriers {
            ready.wait().await;
            release.wait().await;
        }

        self.append_unlocked(PipelineTransitionInput {
            kind: PipelineTransitionKind::Released,
            issue_id: expected_retry.issue_id.clone(),
            identifier: expected_retry.identifier.clone(),
            run_id,
            cycle: 0,
            step: None,
            reason: Some(reason.to_string()),
            retry: None,
            snapshot: None,
            terminal_transition: None,
            delivery: None,
        })
        .await
        .map(Some)
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
                if is_live_restore_record(&record) {
                    records.push(record);
                }
            }
        }

        records.sort_by(|left, right| left.issue_id.cmp(&right.issue_id));
        Ok(records)
    }

    pub async fn latest_live_record_for_issue(
        &self,
        issue_id: &str,
    ) -> Result<Option<PipelineTransitionRecord>, std::io::Error> {
        let record = self
            .read_last_valid_record(&self.path_for_issue(issue_id))
            .await?;
        Ok(record.filter(is_live_restore_record))
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

impl PipelineTransitionKind {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            PipelineTransitionKind::PipelineFailed | PipelineTransitionKind::Released
        )
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

fn is_live_restore_record(record: &PipelineTransitionRecord) -> bool {
    record.schema_version == SCHEMA_VERSION
        && !record.kind.is_terminal()
        && (record.snapshot.is_some() || record.delivery.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{OnFailure, StepConfig, StepKind};
    use crate::orchestrator::delivery::{
        DeliveryMode, DeliveryPhase, DeliveryRecord, DeliveryRepository,
    };
    use crate::pipeline::dag::build_dag;
    use crate::pipeline::engine::{PipelineRun, StepState};
    use tempfile::tempdir;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn pending_terminal_intent_requires_durable_sync() {
        assert!(requires_durable_sync(
            PipelineTransitionKind::PendingTerminalTransition,
            false,
        ));
    }

    #[test]
    fn newly_created_journal_requires_durable_sync() {
        assert!(requires_durable_sync(
            PipelineTransitionKind::RunStarted,
            true,
        ));
    }

    fn step(name: &str, depends: Option<Vec<String>>) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
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
    async fn delivery_transition_round_trips_as_latest_live_owner() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());
        let delivery = DeliveryRecord {
            issue_id: "issue/1".to_string(),
            identifier: "repo#1".to_string(),
            run_id: "run-1".to_string(),
            repositories: [(
                "primary".to_string(),
                DeliveryRepository {
                    mode: DeliveryMode::PushAndPr,
                    phase: DeliveryPhase::Prepared,
                    approval_required: false,
                    remote: "origin".to_string(),
                    base_branch: "main".to_string(),
                    head_branch: "ensemble/repo-1".to_string(),
                    local_sha: "0123456789abcdef".to_string(),
                    observed_remote_sha: None,
                    marker: "<!-- ensemble:delivery:v1 -->".to_string(),
                    pr_number: None,
                    pr_url: None,
                    observation: None,
                    ownership_conflict: None,
                    last_error: None,
                    retry_from: None,
                },
            )]
            .into_iter()
            .collect(),
            terminal_history: None,
            review_projection: None,
        };

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::DeliveryOwned,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: None,
                terminal_transition: None,
                delivery: Some(delivery.clone()),
            })
            .await
            .unwrap();

        let latest = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .expect("delivery remains a live owner");
        assert_eq!(latest.delivery, Some(delivery));
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
                terminal_transition: None,
                delivery: None,
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
                terminal_transition: None,
                delivery: None,
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
    async fn conditional_release_cannot_erase_a_concurrent_newer_retry() {
        let dir = tempdir().unwrap();
        let ready = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        let mut journal = PipelineRunJournal::new(dir.path());
        journal.conditional_release_test_barriers =
            Some((Arc::clone(&ready), Arc::clone(&release)));
        let old_retry = RetryEntry {
            issue_id: "issue/1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 1,
            error: Some("old failure".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        let newer_retry = RetryEntry {
            attempt: 3,
            due_at_ms: 2,
            error: Some("new failure".to_string()),
            ..old_retry.clone()
        };
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: old_retry.issue_id.clone(),
                identifier: old_retry.identifier.clone(),
                run_id: Some("run-1".to_string()),
                cycle: old_retry.attempt,
                step: None,
                reason: old_retry.error.clone(),
                retry: Some(old_retry.clone()),
                snapshot: Some(snapshot()),
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();

        let release_task = tokio::spawn({
            let journal = journal.clone();
            let old_retry = old_retry.clone();
            async move {
                journal
                    .append_released_if_latest_retry_matches(
                        &old_retry,
                        Some("run-1".to_string()),
                        "retry_candidate_missing",
                    )
                    .await
            }
        });
        ready.wait().await;

        let mut newer_retry_task = tokio::spawn({
            let journal = PipelineRunJournal::new(dir.path());
            let newer_retry = newer_retry.clone();
            async move {
                journal
                    .append(PipelineTransitionInput {
                        kind: PipelineTransitionKind::StepRetryScheduled,
                        issue_id: newer_retry.issue_id.clone(),
                        identifier: newer_retry.identifier.clone(),
                        run_id: Some("run-1".to_string()),
                        cycle: newer_retry.attempt,
                        step: None,
                        reason: newer_retry.error.clone(),
                        retry: Some(newer_retry),
                        snapshot: Some(snapshot()),
                        terminal_transition: None,
                        delivery: None,
                    })
                    .await
            }
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut newer_retry_task)
                .await
                .is_err(),
            "newer retry append must wait for the same issue's conditional release"
        );

        release.wait().await;
        assert!(release_task.await.unwrap().unwrap().is_some());
        newer_retry_task.await.unwrap().unwrap();

        let latest = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .expect("newer retry remains live for restart");
        assert_eq!(latest.kind, PipelineTransitionKind::StepRetryScheduled);
        assert_eq!(latest.retry, Some(newer_retry));
    }

    #[tokio::test]
    async fn append_repairs_a_malformed_partial_tail_before_the_next_owner() {
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
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(journal.path_for_issue("issue/1"))
            .await
            .unwrap();
        file.write_all(br#"{"schema_version":1,"seq":"#)
            .await
            .unwrap();
        file.flush().await.unwrap();
        drop(file);

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 2,
                step: Some("build".to_string()),
                reason: Some("retry".to_string()),
                retry: Some(RetryEntry {
                    issue_id: "issue/1".to_string(),
                    identifier: "repo#1".to_string(),
                    attempt: 2,
                    due_at_ms: 1,
                    error: Some("retry".to_string()),
                    retry_from_step: Some("build".to_string()),
                    with_fixup: false,
                }),
                snapshot: Some(snapshot()),
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();

        let records = journal.read_records_for_issue("issue/1").await.unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].seq, 1);
        assert_eq!(records[1].seq, 2);
        assert_eq!(records[1].kind, PipelineTransitionKind::StepRetryScheduled);
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
                terminal_transition: None,
                delivery: None,
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
    async fn latest_live_records_skip_terminal_failed_issues() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineFailed,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("failed".to_string()),
                retry: None,
                snapshot: Some(snapshot()),
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();

        let live = journal.latest_live_records().await.unwrap();
        assert!(live.is_empty());
    }

    #[tokio::test]
    async fn latest_live_record_for_issue_returns_latest_non_terminal_snapshot() {
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
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRunning,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();

        let live = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(live.seq, 2);
        assert_eq!(live.kind, PipelineTransitionKind::StepRunning);
        assert_eq!(live.run_id.as_deref(), Some("run-1"));
    }

    #[tokio::test]
    async fn latest_live_record_for_issue_returns_none_for_terminal_record() {
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
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();
        journal
            .append_released("issue/1", "repo#1", Some("run-1".to_string()), "completed")
            .await
            .unwrap();

        let live = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap();

        assert!(live.is_none());
    }

    #[tokio::test]
    async fn pending_success_transition_round_trips_as_live_until_released() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());
        let pending = PendingTerminalTransition {
            target_state: "Done".to_string(),
            outcome: TerminalOutcome::Succeeded,
            attempt: 2,
            last_error: Some("ambiguous tracker response".to_string()),
            last_attempted_at: Some(Utc::now()),
            tracker_write_confirmed: false,
            history_record: None,
        };

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PendingTerminalTransition,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
                terminal_transition: Some(pending.clone()),
                delivery: None,
            })
            .await
            .unwrap();

        let live = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(live.terminal_transition, Some(pending.clone()));

        let mut confirmed = pending.clone();
        confirmed.tracker_write_confirmed = true;
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::TerminalTransitionApplied,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: None,
                reason: None,
                retry: None,
                snapshot: Some(snapshot()),
                terminal_transition: Some(confirmed.clone()),
                delivery: None,
            })
            .await
            .unwrap();
        assert_eq!(
            journal
                .latest_live_record_for_issue("issue/1")
                .await
                .unwrap()
                .unwrap()
                .terminal_transition,
            Some(confirmed)
        );

        journal
            .append_released("issue/1", "repo#1", Some("run-1".to_string()), "completed")
            .await
            .unwrap();
        assert!(journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn pending_failure_transition_round_trips_retry_metadata_as_live() {
        let dir = tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());
        let pending = PendingTerminalTransition {
            target_state: "Failed".to_string(),
            outcome: TerminalOutcome::Failed,
            attempt: 3,
            last_error: Some("transport timeout".to_string()),
            last_attempted_at: Some(Utc::now()),
            tracker_write_confirmed: false,
            history_record: None,
        };

        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PendingTerminalTransition,
                issue_id: "issue/1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: pending.last_error.clone(),
                retry: None,
                snapshot: Some(snapshot()),
                terminal_transition: Some(pending.clone()),
                delivery: None,
            })
            .await
            .unwrap();

        let live = journal
            .latest_live_record_for_issue("issue/1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(live.terminal_transition, Some(pending));
    }

    #[test]
    fn schema_v1_record_without_terminal_payload_remains_readable() {
        let legacy = serde_json::json!({
            "schema_version": 1,
            "seq": 1,
            "kind": "run_started",
            "issue_id": "issue/1",
            "identifier": "repo#1",
            "run_id": "run-1",
            "cycle": 1,
            "step": null,
            "reason": null,
            "retry": null,
            "snapshot": null,
            "written_at": Utc::now(),
        });

        let record: PipelineTransitionRecord = serde_json::from_value(legacy).unwrap();
        assert!(record.terminal_transition.is_none());
    }

    #[test]
    fn acceptance_transition_kinds_round_trip() {
        for kind in [
            PipelineTransitionKind::AcceptanceStarted,
            PipelineTransitionKind::AcceptanceCommandCompleted,
            PipelineTransitionKind::AcceptanceCheckCompleted,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(
                serde_json::from_str::<PipelineTransitionKind>(&json).unwrap(),
                kind
            );
        }
        assert_eq!(
            serde_json::from_str::<PipelineTransitionKind>("\"acceptance_command_completed\"")
                .unwrap(),
            PipelineTransitionKind::AcceptanceCommandCompleted
        );
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
                terminal_transition: None,
                delivery: None,
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
