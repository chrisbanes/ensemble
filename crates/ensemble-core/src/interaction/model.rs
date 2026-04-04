use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Question,
    Approval,
    Handoff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    Open,
    Resolved,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractionResponse {
    Question {
        response_schema_version: u32,
        text: String,
        selected_option: Option<String>,
    },
    Approval {
        response_schema_version: u32,
        approved: bool,
        reason: Option<String>,
    },
    Handoff {
        response_schema_version: u32,
        completed: bool,
        notes: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct InteractionRequest {
    pub id: String,
    pub schema_version: u32,
    pub issue_id: String,
    pub issue_identifier: String,
    #[serde(default)]
    pub pipeline_cycle: u32,
    #[serde(default)]
    pub completed_steps: Vec<String>,
    pub step_name: String,
    pub agent_name: String,
    #[serde(default)]
    pub step_depends: Vec<String>,
    #[serde(default)]
    pub step_tracker_state: Option<String>,
    pub kind: InteractionKind,
    pub status: InteractionStatus,
    pub blocking: bool,
    #[serde(default = "default_awaiting_resume")]
    pub awaiting_resume: bool,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub artifacts: Vec<String>,
    pub response: Option<InteractionResponse>,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

fn default_awaiting_resume() -> bool {
    true
}
