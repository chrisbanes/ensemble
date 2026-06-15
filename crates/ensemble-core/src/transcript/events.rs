use tokio::sync::broadcast;

use super::model::TranscriptRecord;

const TRANSCRIPT_EVENT_BUS_CAPACITY: usize = 4096;

#[derive(Debug, Clone)]
pub struct TranscriptEventBus {
    sender: broadcast::Sender<TranscriptRecord>,
}

impl TranscriptEventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(TRANSCRIPT_EVENT_BUS_CAPACITY);
        Self { sender }
    }

    pub fn publish(&self, record: TranscriptRecord) {
        let _ = self.sender.send(record);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TranscriptRecord> {
        self.sender.subscribe()
    }
}

impl Default for TranscriptEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{
        TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION,
    };
    use chrono::Utc;

    fn record() -> TranscriptRecord {
        TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence: 1,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": "hello"}),
            truncated: None,
        }
    }

    #[tokio::test]
    async fn publish_and_receive_transcript_record() {
        let bus = TranscriptEventBus::new();
        let mut rx = bus.subscribe();

        bus.publish(record());

        let received = rx.recv().await.unwrap();
        assert_eq!(received.issue_identifier, "repo#1");
        assert_eq!(received.run_id, "run-1");
        assert_eq!(received.step_name, "build");
        assert_eq!(received.sequence, 1);
    }
}
