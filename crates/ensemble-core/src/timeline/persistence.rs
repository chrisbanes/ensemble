use std::path::PathBuf;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

use super::model::TimelineEventRecord;
use super::writer::TimelineWriter;

#[derive(Debug)]
struct PersistRequest {
    run_id: String,
    record: TimelineEventRecord,
}

pub struct TimelinePersistence {
    sender: mpsc::UnboundedSender<PersistRequest>,
    handle: Option<JoinHandle<()>>,
}

impl TimelinePersistence {
    pub fn new(workspace_root: PathBuf) -> Self {
        let writer = TimelineWriter::new(workspace_root);
        let (sender, mut receiver) = mpsc::unbounded_channel::<PersistRequest>();

        let handle = tokio::spawn(async move {
            while let Some(req) = receiver.recv().await {
                if let Err(error) = writer.append(&req.run_id, &req.record).await {
                    warn!(
                        event = "timeline_persist_failed",
                        run_id = %req.run_id,
                        error = %error,
                        "failed to persist timeline event"
                    );
                }
            }
        });

        Self {
            sender,
            handle: Some(handle),
        }
    }

    pub fn send(&self, run_id: String, record: TimelineEventRecord) {
        if self.sender.send(PersistRequest { run_id, record }).is_err() {
            warn!("timeline persist channel closed; event dropped");
        }
    }

    pub async fn flush(mut self) {
        drop(self.sender);
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::time::Duration;

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
    async fn send_creates_file_and_writes_event() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        persistence.send("run-1".to_string(), record.clone());
        persistence.flush().await;

        let path = temp_dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        assert!(path.exists());
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        assert_eq!(contents.lines().count(), 1);
        let parsed: TimelineEventRecord =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(parsed.run_id, "run-1");
        assert_eq!(parsed.sequence, 1);
    }

    #[tokio::test]
    async fn ordering_preserved_across_multiple_events() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());

        for i in 1..=10 {
            persistence.send("run-1".to_string(), sample_event("run-1", i));
        }
        persistence.flush().await;

        let path = temp_dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 10);
        for (i, line) in lines.iter().enumerate() {
            let parsed: TimelineEventRecord = serde_json::from_str(line).unwrap();
            assert_eq!(parsed.sequence, (i + 1) as u64);
        }
    }

    #[tokio::test]
    async fn send_returns_immediately() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        let start = std::time::Instant::now();
        persistence.send("run-1".to_string(), record);
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(1),
            "send() took too long: {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn flush_waits_for_pending_events() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        persistence.send("run-1".to_string(), record);
        persistence.flush().await;

        let path = temp_dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        assert!(path.exists());
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        assert_eq!(contents.lines().count(), 1);
    }

    #[tokio::test]
    async fn write_failure_is_logged_and_non_fatal() {
        let temp_dir = TempDir::new().unwrap();
        let ensemble_dir = temp_dir.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        tokio::fs::write(&ensemble_dir.join("runs"), "blocked")
            .await
            .unwrap();

        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        persistence.send("run-1".to_string(), record.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;

        tokio::fs::remove_file(&ensemble_dir.join("runs"))
            .await
            .unwrap();

        persistence.send("run-1".to_string(), record);
        persistence.flush().await;

        let path = temp_dir
            .path()
            .join(".ensemble")
            .join("runs")
            .join("run-1")
            .join("events.jsonl");
        assert!(
            path.exists(),
            "file should exist after blocking file removed"
        );
    }
}
