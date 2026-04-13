use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    Open,
    Resolved,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AgentAsk {
    pub id: String,
    pub issue_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub agent_name: String,
    pub question: String,
    pub why_blocked: String,
    pub suggested_answer: Option<String>,
    pub extra_context: Option<String>,
    pub status: InteractionStatus,
    pub awaiting_resume: bool,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    #[serde(alias = "question")]
    #[default]
    BrainstormPrompt,
    #[serde(alias = "approval")]
    ApprovalGate,
    #[serde(alias = "handoff")]
    ManualDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionResumeStrategy {
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
    #[serde(default = "default_resume_strategy")]
    pub resume_strategy: InteractionResumeStrategy,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub artifacts: Vec<String>,
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

impl From<AgentAsk> for InteractionRequest {
    fn from(ask: AgentAsk) -> Self {
        InteractionRequest {
            id: ask.id.clone(),
            schema_version: 1,
            issue_id: ask.issue_id.clone(),
            issue_identifier: ask.issue_identifier.clone(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: ask.step_name.clone(),
            agent_name: ask.agent_name.clone(),
            step_depends: vec![],
            step_tracker_state: None,
            kind: InteractionKind::BrainstormPrompt,
            status: ask.status.clone(),
            blocking: true,
            awaiting_resume: ask.awaiting_resume,
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: ask.question.clone(),
            body: ask.why_blocked.clone(),
            options: ask.suggested_answer.into_iter().collect(),
            artifacts: vec![],
            response: None,
            waiting_started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: ask.requested_at,
            resolved_at: ask.resolved_at,
        }
    }
}

impl From<InteractionRequest> for AgentAsk {
    fn from(req: InteractionRequest) -> Self {
        AgentAsk {
            id: req.id,
            issue_id: req.issue_id,
            issue_identifier: req.issue_identifier,
            step_name: req.step_name,
            agent_name: req.agent_name,
            question: req.title,
            why_blocked: req.body,
            suggested_answer: req.options.into_iter().next(),
            extra_context: None,
            status: req.status,
            awaiting_resume: req.awaiting_resume,
            requested_at: req.requested_at,
            resolved_at: req.resolved_at,
        }
    }
}

fn default_awaiting_resume() -> bool {
    true
}

fn default_resume_strategy() -> InteractionResumeStrategy {
    InteractionResumeStrategy::RerunStep
}
