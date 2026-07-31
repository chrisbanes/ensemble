use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::history_store::store::HistoryStore;

use super::model::TimelineEventRecord;

pub struct TimelinePersistence {
    sender: Option<mpsc::Sender<TimelineEventRecord>>,
    handle: Option<JoinHandle<()>>,
}

impl TimelinePersistence {
    pub fn new(history_store: HistoryStore) -> Self {
        let (sender, mut receiver) = mpsc::channel::<TimelineEventRecord>(10_000);

        let handle = tokio::spawn(async move {
            while let Some(record) = receiver.recv().await {
                if let Err(error) = history_store.append_timeline_event(&record).await {
                    warn!(
                        event = "timeline_persist_failed",
                        run_id = %record.run_id,
                        error = %error,
                        "failed to persist timeline event"
                    );
                }
            }
        });

        Self {
            sender: Some(sender),
            handle: Some(handle),
        }
    }

    pub fn send(&self, record: TimelineEventRecord) {
        if let Some(ref sender) = self.sender {
            match sender.try_send(record) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    warn!("timeline persist channel full; event dropped");
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    warn!("timeline persist channel closed; event dropped");
                }
            }
        }
    }

    pub async fn flush(&mut self) {
        if let Some(sender) = self.sender.take() {
            drop(sender);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for TimelinePersistence {
    fn drop(&mut self) {
        if self.handle.is_some() {
            if let Some(sender) = self.sender.take() {
                drop(sender);
            }
            if let Some(handle) = self.handle.take() {
                handle.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::TimelineQuery;
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

    fn history_store(temp_dir: &TempDir) -> HistoryStore {
        HistoryStore::new_blocking(temp_dir.path().join(".ensemble").join("history.db")).unwrap()
    }

    #[tokio::test]
    async fn timeline_persistence_history_store_survives_reopen() {
        let temp_dir = TempDir::new().unwrap();
        let mut persistence = TimelinePersistence::new(history_store(&temp_dir));

        persistence.send(sample_event("run-1", 1));
        persistence.flush().await;

        let reopened = HistoryStore::new(temp_dir.path().join(".ensemble").join("history.db"))
            .await
            .unwrap();
        let timeline = reopened
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();

        assert_eq!(timeline.total, 1);
        assert_eq!(timeline.events[0].sequence, 1);
        assert!(
            !temp_dir
                .path()
                .join(".ensemble")
                .join("runs")
                .join("run-1")
                .join("events.jsonl")
                .exists(),
            "SQLite persistence must not create per-run timeline JSONL"
        );
    }

    #[tokio::test]
    async fn timeline_persistence_history_store_preserves_order() {
        let temp_dir = TempDir::new().unwrap();
        let store = history_store(&temp_dir);
        let mut persistence = TimelinePersistence::new(store.clone());

        for sequence in [3, 1, 2] {
            persistence.send(sample_event("run-1", sequence));
        }
        persistence.flush().await;

        let timeline = store
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();
        let sequences = timeline
            .events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>();

        assert_eq!(sequences, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn timeline_persistence_history_store_ignores_duplicate_sequence() {
        let temp_dir = TempDir::new().unwrap();
        let store = history_store(&temp_dir);
        let mut persistence = TimelinePersistence::new(store.clone());
        let event = sample_event("run-1", 1);

        persistence.send(event.clone());
        persistence.send(event);
        persistence.flush().await;

        let timeline = store
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();

        assert_eq!(timeline.total, 1);
        assert_eq!(timeline.events[0].sequence, 1);
    }

    #[tokio::test]
    async fn send_returns_immediately() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(history_store(&temp_dir));
        let record = sample_event("run-1", 1);

        let start = std::time::Instant::now();
        persistence.send(record);
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(1),
            "send() took too long: {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn timeline_persistence_write_failure_is_non_fatal() {
        let temp_dir = TempDir::new().unwrap();
        let store = history_store(&temp_dir);
        let db_path = store.db_path().clone();
        let backup_path = temp_dir.path().join(".ensemble").join("history.db.backup");
        std::fs::rename(&db_path, &backup_path).unwrap();
        std::fs::create_dir(&db_path).unwrap();
        let mut persistence = TimelinePersistence::new(store.clone());

        persistence.send(sample_event("run-1", 1));
        // Briefly wait for the background task to attempt the first (failing) write
        tokio::time::sleep(Duration::from_millis(10)).await;

        std::fs::remove_dir(&db_path).unwrap();
        std::fs::rename(&backup_path, &db_path).unwrap();
        persistence.send(sample_event("run-1", 2));
        persistence.flush().await;

        let timeline = store
            .read_timeline(
                &TimelineQuery {
                    run_id: "run-1".to_string(),
                    cursor: None,
                    limit: None,
                },
                Some("repo#1"),
            )
            .await
            .unwrap();
        assert_eq!(timeline.total, 1);
        assert_eq!(timeline.events[0].sequence, 2);
    }
}
