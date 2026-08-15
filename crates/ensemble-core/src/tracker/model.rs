use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[cfg(test)]
pub mod test_helpers {
    use super::*;

    pub fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            tracker_position: None,
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: Some(chrono::Utc::now()),
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    /// Tracker-provided snapshot ordering data, when the adapter can supply it.
    pub tracker_position: Option<u64>,
    pub state: String,
    pub branch_name: Option<String>,
    pub url: Option<String>,
    pub labels: Vec<String>,
    pub blocked_by: Vec<BlockerRef>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockerRef {
    pub id: Option<String>,
    pub identifier: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningEntry {
    pub issue_id: String,
    pub identifier: String,
    pub run_id: Option<String>,
    pub issue: Issue,
    pub session_id: Option<String>,
    pub agent_pid: Option<String>,
    pub last_agent_event: Option<String>,
    pub last_agent_timestamp: Option<DateTime<Utc>>,
    pub last_agent_message: Option<String>,
    pub agent_input_tokens: u64,
    pub agent_output_tokens: u64,
    pub agent_total_tokens: u64,
    pub last_reported_input_tokens: u64,
    pub last_reported_output_tokens: u64,
    pub last_reported_total_tokens: u64,
    pub turn_count: u32,
    pub retry_attempt: Option<u32>,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryEntry {
    pub issue_id: String,
    pub identifier: String,
    pub attempt: u32,
    pub due_at_ms: u64,
    pub error: Option<String>,
    /// If set, retry from this step. None means retry the whole issue.
    #[serde(default)]
    pub retry_from_step: Option<String>,
    /// Whether to inject a fixup agent before retrying.
    #[serde(default)]
    pub with_fixup: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub seconds_running: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionThreadRoot {
    pub comment_id: String,
    pub comment_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrackerComment {
    pub comment_id: String,
    pub body: String,
    pub author: String,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// Immutable, adapter-normalized evidence for a configured tracker event.
/// The runtime intentionally gives field and value no tracker-specific meaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerEvent {
    pub item_id: String,
    pub field_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_value: Option<String>,
    pub value: String,
    pub actor_id: String,
    pub event_id: String,
    pub occurred_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_issue_serialization_roundtrip() {
        let issue = Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It's broken".to_string()),
            priority: Some(2),
            tracker_position: Some(7),
            state: "Todo".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string(), "p1".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        };
        let json = serde_json::to_string(&issue).unwrap();
        let deserialized: Issue = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "NODE_123");
        assert_eq!(deserialized.identifier, "my-repo#42");
        assert_eq!(deserialized.labels, vec!["bug", "p1"]);
        assert_eq!(deserialized.tracker_position, Some(7));
    }

    #[test]
    fn test_agent_totals_default() {
        let totals = AgentTotals::default();
        assert_eq!(totals.input_tokens, 0);
        assert_eq!(totals.output_tokens, 0);
        assert_eq!(totals.total_tokens, 0);
        assert_eq!(totals.seconds_running, 0.0);
    }

    #[test]
    fn tracker_event_serialization_roundtrip_preserves_immutable_identity() {
        let event = TrackerEvent {
            item_id: "item-1".to_string(),
            field_id: "field-1".to_string(),
            previous_value: Some("before".to_string()),
            value: "after".to_string(),
            actor_id: "actor-1".to_string(),
            event_id: "event-1".to_string(),
            occurred_at: "2026-08-15T10:00:00Z".parse().unwrap(),
        };

        assert_eq!(
            serde_json::from_str::<TrackerEvent>(&serde_json::to_string(&event).unwrap()).unwrap(),
            event
        );
    }
}
