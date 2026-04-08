use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct TimelineEventRecord {
    pub run_id: String,
    pub issue_identifier: String,
    pub sequence: u64,
    pub timestamp: DateTime<Utc>,
    pub event_type: String,
    pub step_name: Option<String>,
    pub attempt: u32,
    pub detail: String,
    pub verdict: Option<String>,
    pub tool_name: Option<String>,
}
