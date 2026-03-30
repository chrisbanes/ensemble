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
}
