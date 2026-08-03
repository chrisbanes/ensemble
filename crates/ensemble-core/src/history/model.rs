use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acceptance::AcceptanceAttempt;
use crate::history::artifacts::RunArtifacts;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct HistoryRecord {
    pub issue_identifier: String,
    pub issue_id: String,
    pub outcome: String,
    pub steps_traversed: Vec<String>,
    pub attempts: u32,
    pub tokens: TokenTotals,
    pub duration_seconds: u64,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub verdict: Option<String>,
    pub workspace_path: String,
    #[serde(default)]
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<RunArtifacts>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_record_defaults_acceptance_attempts_to_empty() {
        let value = serde_json::json!({
            "issue_identifier": "repo#1",
            "issue_id": "node-1",
            "outcome": "succeeded",
            "steps_traversed": ["build"],
            "attempts": 1,
            "tokens": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
            "duration_seconds": 4,
            "started_at": "2026-08-03T00:00:00Z",
            "completed_at": "2026-08-03T00:00:01Z",
            "last_error": null,
            "verdict": "approved",
            "workspace_path": "/tmp/workspace"
        });

        let record: HistoryRecord = serde_json::from_value(value).unwrap();

        assert!(record.acceptance_attempts.is_empty());
    }
}
