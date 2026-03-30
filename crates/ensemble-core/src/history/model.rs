use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}
