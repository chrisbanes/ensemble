use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    #[serde(alias = "brainstorm_prompt")]
    #[default]
    Question,
    #[serde(alias = "approval_gate")]
    Approval,
    #[serde(alias = "manual_decision")]
    Handoff,
}

/// Backward-compatible aliases for code that still references old variant names.
#[allow(non_upper_case_globals)]
impl InteractionKind {
    pub const BrainstormPrompt: Self = Self::Question;
    pub const ApprovalGate: Self = Self::Approval;
    pub const ManualDecision: Self = Self::Handoff;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    Open,
    Resolved,
    Cancelled,
}

impl InteractionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            InteractionStatus::Open => "open",
            InteractionStatus::Resolved => "resolved",
            InteractionStatus::Cancelled => "cancelled",
        }
    }
}

/// Backward-compatible resume strategy. The orchestrator always uses RerunStep behavior;
/// this enum is retained only for deserialization compatibility with persisted interaction
/// requests that include a `resume_strategy` field.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionResumeStrategy {
    #[default]
    RerunStep,
    AdvanceAfterStep,
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
    #[serde(default)]
    pub resume_strategy: InteractionResumeStrategy,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub thread_root_comment_id: Option<String>,
    #[serde(default)]
    pub thread_root_comment_url: Option<String>,
    #[serde(default)]
    pub accepted_command: Option<AcceptedInteractionCommand>,
    #[serde(default)]
    pub ignored_commands: Vec<IgnoredInteractionCommand>,
    pub response: Option<InteractionResponse>,
    #[serde(default)]
    pub waiting_started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub agent_input_tokens: u64,
    #[serde(default)]
    pub agent_output_tokens: u64,
    #[serde(default)]
    pub agent_total_tokens: u64,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AcceptedInteractionCommand {
    pub command: String,
    pub raw_body: String,
    pub author: String,
    pub comment_id: String,
    pub received_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct IgnoredInteractionCommand {
    pub command: Option<String>,
    pub raw_body: String,
    pub author: String,
    pub comment_id: String,
    pub received_at: DateTime<Utc>,
    pub reason: String,
}

fn default_awaiting_resume() -> bool {
    true
}
