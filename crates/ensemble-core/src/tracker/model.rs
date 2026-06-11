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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Sanitize an issue identifier for use as a workspace directory name.
/// Only [A-Za-z0-9._-] are allowed; all other characters become '_'.
/// Returns None if the result would be unsafe (empty, ".", or "..").
pub fn sanitize_workspace_key(identifier: &str) -> Option<String> {
    let key: String = identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    if key.is_empty() || key == "." || key == ".." {
        None
    } else {
        Some(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_simple_identifier() {
        assert_eq!(
            sanitize_workspace_key("my-repo_42"),
            Some("my-repo_42".to_string())
        );
    }

    #[test]
    fn test_sanitize_hash_in_identifier() {
        assert_eq!(
            sanitize_workspace_key("my-repo#42"),
            Some("my-repo_42".to_string())
        );
    }

    #[test]
    fn test_sanitize_slashes_and_spaces() {
        assert_eq!(
            sanitize_workspace_key("acme/repo 123"),
            Some("acme_repo_123".to_string())
        );
    }

    #[test]
    fn test_sanitize_preserves_dots() {
        assert_eq!(
            sanitize_workspace_key("v1.2.3-rc1"),
            Some("v1.2.3-rc1".to_string())
        );
    }

    #[test]
    fn test_sanitize_all_special_chars() {
        assert_eq!(
            sanitize_workspace_key("a@b!c$d%e"),
            Some("a_b_c_d_e".to_string())
        );
    }

    #[test]
    fn test_sanitize_rejects_dot() {
        assert_eq!(sanitize_workspace_key("."), None);
    }

    #[test]
    fn test_sanitize_rejects_dotdot() {
        assert_eq!(sanitize_workspace_key(".."), None);
    }

    #[test]
    fn test_sanitize_rejects_empty() {
        assert_eq!(sanitize_workspace_key(""), None);
    }

    #[test]
    fn test_issue_serialization_roundtrip() {
        let issue = Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It's broken".to_string()),
            priority: Some(2),
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
    }

    #[test]
    fn test_agent_totals_default() {
        let totals = AgentTotals::default();
        assert_eq!(totals.input_tokens, 0);
        assert_eq!(totals.output_tokens, 0);
        assert_eq!(totals.total_tokens, 0);
        assert_eq!(totals.seconds_running, 0.0);
    }
}
