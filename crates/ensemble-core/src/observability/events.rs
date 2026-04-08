use crate::timeline::model::TimelineEventRecord;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::broadcast;

/// A lightweight event emitted by the orchestrator at pipeline boundaries.
/// These are broadcast to WebSocket subscribers and used for the event timeline.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum PipelineEvent {
    SessionStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    StepStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        agent_name: String,
        detail: String,
    },
    StepCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        verdict: Option<String>,
        detail: String,
    },
    TurnCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        turn: u32,
        detail: String,
        conversation_index: Option<u64>,
        tokens_delta: TokensDelta,
    },
    ToolCall {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        tool_name: String,
        detail: String,
    },
    Error {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    RetryScheduled {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        attempt: u32,
        detail: String,
    },
    Complete {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        outcome: String,
    },
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct TokensDelta {
    pub input: u64,
    pub output: u64,
}

impl PipelineEvent {
    pub fn issue_identifier(&self) -> &str {
        match self {
            Self::SessionStarted {
                issue_identifier, ..
            }
            | Self::StepStarted {
                issue_identifier, ..
            }
            | Self::StepCompleted {
                issue_identifier, ..
            }
            | Self::TurnCompleted {
                issue_identifier, ..
            }
            | Self::ToolCall {
                issue_identifier, ..
            }
            | Self::Error {
                issue_identifier, ..
            }
            | Self::RetryScheduled {
                issue_identifier, ..
            }
            | Self::Complete {
                issue_identifier, ..
            } => issue_identifier,
        }
    }

    pub fn timestamp(&self) -> DateTime<Utc> {
        match self {
            Self::SessionStarted { timestamp, .. }
            | Self::StepStarted { timestamp, .. }
            | Self::StepCompleted { timestamp, .. }
            | Self::TurnCompleted { timestamp, .. }
            | Self::ToolCall { timestamp, .. }
            | Self::Error { timestamp, .. }
            | Self::RetryScheduled { timestamp, .. }
            | Self::Complete { timestamp, .. } => *timestamp,
        }
    }

    pub fn to_timeline_record(&self, run_id: &str, sequence: u64) -> TimelineEventRecord {
        match self {
            Self::SessionStarted {
                issue_identifier,
                timestamp,
                detail,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "session_started".to_string(),
                step_name: None,
                attempt: 1,
                detail: detail.clone(),
                verdict: None,
                tool_name: None,
            },
            Self::StepStarted {
                issue_identifier,
                timestamp,
                step_name,
                detail,
                ..
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "step_started".to_string(),
                step_name: Some(step_name.clone()),
                attempt: 1,
                detail: detail.clone(),
                verdict: None,
                tool_name: None,
            },
            Self::StepCompleted {
                issue_identifier,
                timestamp,
                step_name,
                detail,
                verdict,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "step_completed".to_string(),
                step_name: Some(step_name.clone()),
                attempt: 1,
                detail: detail.clone(),
                verdict: verdict.clone(),
                tool_name: None,
            },
            Self::TurnCompleted {
                issue_identifier,
                timestamp,
                detail,
                ..
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "turn_completed".to_string(),
                step_name: None,
                attempt: 1,
                detail: detail.clone(),
                verdict: None,
                tool_name: None,
            },
            Self::ToolCall {
                issue_identifier,
                timestamp,
                tool_name,
                detail,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "tool_call".to_string(),
                step_name: None,
                attempt: 1,
                detail: detail.clone(),
                verdict: None,
                tool_name: Some(tool_name.clone()),
            },
            Self::Error {
                issue_identifier,
                timestamp,
                detail,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "error".to_string(),
                step_name: None,
                attempt: 1,
                detail: detail.clone(),
                verdict: None,
                tool_name: None,
            },
            Self::RetryScheduled {
                issue_identifier,
                timestamp,
                detail,
                attempt,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "retry_scheduled".to_string(),
                step_name: None,
                attempt: *attempt,
                detail: detail.clone(),
                verdict: None,
                tool_name: None,
            },
            Self::Complete {
                issue_identifier,
                timestamp,
                outcome,
            } => TimelineEventRecord {
                run_id: run_id.to_string(),
                issue_identifier: issue_identifier.clone(),
                sequence,
                timestamp: *timestamp,
                event_type: "complete".to_string(),
                step_name: None,
                attempt: 1,
                detail: outcome.clone(),
                verdict: Some(outcome.clone()),
                tool_name: None,
            },
        }
    }
}

const EVENT_BUS_CAPACITY: usize = 1024;

#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<PipelineEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        Self { sender }
    }

    pub fn publish(&self, event: PipelineEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PipelineEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_and_receive() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(PipelineEvent::SessionStarted {
            issue_identifier: "MT-1".into(),
            timestamp: Utc::now(),
            detail: "test".into(),
        });
        let event = rx.recv().await.unwrap();
        assert_eq!(event.issue_identifier(), "MT-1");
    }

    #[tokio::test]
    async fn publish_with_no_subscribers_does_not_panic() {
        let bus = EventBus::new();
        bus.publish(PipelineEvent::Complete {
            issue_identifier: "MT-2".into(),
            timestamp: Utc::now(),
            outcome: "succeeded".into(),
        });
    }

    #[test]
    fn issue_identifier_extraction() {
        let event = PipelineEvent::ToolCall {
            issue_identifier: "MT-99".into(),
            timestamp: Utc::now(),
            tool_name: "bash".into(),
            detail: "ls".into(),
        };
        assert_eq!(event.issue_identifier(), "MT-99");
    }

    #[test]
    fn pipeline_event_maps_to_timeline_record_with_run_and_sequence() {
        let event = PipelineEvent::RetryScheduled {
            issue_identifier: "repo#1".into(),
            timestamp: Utc::now(),
            attempt: 2,
            detail: "retry".into(),
        };

        let record = event.to_timeline_record("run-1", 7);
        assert_eq!(record.run_id, "run-1");
        assert_eq!(record.sequence, 7);
        assert_eq!(record.attempt, 2);
        assert_eq!(record.event_type, "retry_scheduled");
    }
}
