use crate::agent::runtime::RuntimeKind;
use crate::config::location::default_todo_state_path;
use crate::error::PipelineError;
use crate::workspace::finalize::RepoFinalizeConfig;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Top-level configuration parsed from `ensemble.yaml`.
///
/// `config.yaml` is a policy layer: it defines agents, pipeline steps, concurrency limits,
/// and tracker integration settings. It is not a runtime collaboration log — runtime state
/// (running issues, retry timers, session metadata) lives in Ensemble's orchestrator, not in
/// the config file.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct EnsembleConfig {
    pub tracker: TrackerConfig,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    pub agents: HashMap<String, AgentConfig>,
    #[serde(default)]
    pub steps: Vec<StepConfig>,
    #[serde(default)]
    pub on_success: String,
    #[serde(default)]
    pub on_failure: String,
    /// Neutral named pipelines used only when `workflow_selection` is non-empty.
    #[serde(default)]
    pub pipelines: BTreeMap<String, PipelineConfig>,
    /// Capacity lanes referenced by workflow-selection rules.
    #[serde(default)]
    pub scheduler: SchedulerConfig,
    /// Fixed-vocabulary rules that select a named pipeline and scheduler lane.
    #[serde(default)]
    pub workflow_selection: Vec<WorkflowSelectionRuleConfig>,
    #[serde(default)]
    pub concurrency: ConcurrencyConfig,
    #[serde(default = "default_max_cycles")]
    pub max_cycles: u32,
    #[serde(default)]
    pub polling: PollingConfig,
    #[serde(default)]
    pub workspace: WorkspaceConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub agent: AgentRuntimeConfig,
    #[serde(default)]
    pub human_interaction: HumanInteractionConfig,
    #[serde(default)]
    pub acceptance: AcceptanceConfig,
}

/// One complete named pipeline selected by a workflow rule.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PipelineConfig {
    pub steps: Vec<StepConfig>,
    pub on_success: String,
    pub on_failure: String,
}

/// Scheduler configuration for selected workflows.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SchedulerConfig {
    #[serde(default)]
    pub lanes: BTreeMap<String, SchedulerLaneConfig>,
}

/// A positive-capacity worker bucket shared by selected runs in one lane.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SchedulerLaneConfig {
    pub capacity: u32,
}

/// A precedence-ordered rule over normalized tracker fields.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkflowSelectionRuleConfig {
    pub name: String,
    pub precedence: u32,
    pub pipeline: String,
    pub lane: String,
    #[serde(default)]
    pub states: Option<Vec<String>>,
    #[serde(default)]
    pub labels_all: Option<Vec<String>>,
    #[serde(default)]
    pub labels_any: Option<Vec<String>>,
    #[serde(default)]
    pub labels_none: Option<Vec<String>>,
    #[serde(default)]
    pub require_unblocked: bool,
    pub order_by: Vec<WorkflowOrderKey>,
}

/// Stable ascending sort keys available to workflow-selection rules.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowOrderKey {
    Priority,
    TrackerPosition,
    CreatedAt,
    Identifier,
}

/// Commands that must pass after the pipeline and its approval gates succeed.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct AcceptanceConfig {
    #[serde(default)]
    pub commands: Vec<AcceptanceCommandConfig>,
    #[serde(default)]
    pub required_files: Vec<AcceptanceFileConfig>,
    #[serde(default)]
    pub required_handoff_sections: Vec<AcceptanceHandoffConfig>,
    #[serde(default)]
    pub required_pull_requests: Vec<AcceptancePullRequestConfig>,
}

/// One named acceptance command executed by `/bin/sh -lc`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct AcceptanceCommandConfig {
    pub name: String,
    pub run: String,
    pub timeout_ms: u64,
}

/// One exact repository-relative file required before finalization.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct AcceptanceFileConfig {
    pub name: String,
    pub repo: String,
    #[schema(value_type = String)]
    pub path: PathBuf,
}

/// Named top-level sections required in one persisted step output.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct AcceptanceHandoffConfig {
    pub name: String,
    pub step: String,
    pub sections: Vec<String>,
}

/// One durable pull-request identity required after finalization.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct AcceptancePullRequestConfig {
    pub name: String,
    pub repo: String,
}

pub(crate) fn repository_key(repo: &RepoConfig, index: usize) -> String {
    Path::new(&repo.path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("repo-{index}"))
}

/// Runtime configuration for blocked-on-human interaction handling.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
pub struct HumanInteractionConfig {
    #[serde(default = "default_human_interaction_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub default_resume_mode: HumanResumeMode,
}

fn default_human_interaction_enabled() -> bool {
    true
}

impl Default for HumanInteractionConfig {
    fn default() -> Self {
        Self {
            enabled: default_human_interaction_enabled(),
            default_resume_mode: HumanResumeMode::Manual,
        }
    }
}

/// Default resume behavior for resolved human interactions.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HumanResumeMode {
    #[default]
    Manual,
}

/// A repository to be managed by the workspace (path + branch).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RepoConfig {
    pub path: String,
    pub branch: String,
    #[serde(default = "default_git_remote")]
    pub git_remote: String,
    #[serde(default)]
    pub finalize: RepoFinalizeConfig,
}

fn default_git_remote() -> String {
    "origin".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionMode {
    ApproveAll,
    ApproveReads,
    DenyAll,
}

impl PermissionMode {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "approve_all" => Some(Self::ApproveAll),
            "approve_reads" => Some(Self::ApproveReads),
            "deny_all" => Some(Self::DenyAll),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn acpx_flag(self) -> &'static str {
        match self {
            Self::ApproveAll => "--approve-all",
            Self::ApproveReads => "--approve-reads",
            Self::DenyAll => "--deny-all",
        }
    }
}

fn default_max_cycles() -> u32 {
    3
}

/// Tracker configuration: which issue tracker to use and how to connect to it.
///
/// The tracker is an optional integration adapter. When configured, it provides candidate
/// tickets as work sources and receives state transitions as sinks. Without a tracker,
/// Ensemble can still run with a static or manually-populated work queue (future extension).
/// Runtime authority always stays with the Ensemble orchestrator, not the tracker.
#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct TrackerConfig {
    pub kind: String,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    #[schema(value_type = Option<String>)]
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub gh_hostname: Option<String>,
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    pub repository: Option<String>,
    pub project_number: Option<i64>,
    #[serde(default)]
    pub labels_filter: Vec<String>,
    #[serde(default)]
    pub notion: Option<NotionTrackerConfig>,
    #[serde(default)]
    pub github: Option<GithubTrackerConfig>,
}

/// GitHub Projects v2 field names used to normalize project items.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GithubTrackerConfig {
    pub status_field: String,
    #[serde(default)]
    pub priority: Option<GithubPriorityConfig>,
    /// Optional adapter-owned policy for exclusive GitHub claims and delivery recovery.
    #[serde(default)]
    pub ownership: Option<GithubOwnershipConfig>,
}

/// The ordered single-select options that form GitHub Project priority ranks.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GithubPriorityConfig {
    pub field: String,
    pub options: Vec<String>,
}

/// GitHub-specific ownership rules. Their values remain adapter data; the runtime
/// receives only opaque leases and conflict outcomes.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GithubOwnershipConfig {
    #[serde(default)]
    pub claim: Option<GithubClaimConfig>,
    #[serde(default)]
    pub delivery_adoption: Option<GithubDeliveryAdoptionConfig>,
}

/// An exclusive authenticated-assignee claim policy.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GithubClaimConfig {
    pub claimed_state: String,
    pub resume_states: Vec<String>,
}

/// The exact identity required before an unpersisted pull request can be adopted.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GithubDeliveryAdoptionConfig {
    pub repository: String,
    pub base_branch: String,
    pub branch_template: String,
    #[serde(default)]
    pub require_authenticated_author: bool,
}

impl GithubDeliveryAdoptionConfig {
    /// Render the sole supported immutable branch input. Callers pass the
    /// workspace key rather than any tracker-specific identifier.
    pub fn render_branch(&self, issue_workspace_key: &str) -> String {
        self.branch_template
            .replace("{issue_workspace_key}", issue_workspace_key)
    }
}

#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct NotionTrackerConfig {
    #[serde(skip_serializing)]
    #[schema(write_only)]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_id: Option<String>,
    #[serde(default = "default_notion_version")]
    pub version: String,
    #[serde(default = "default_notion_title_property")]
    pub title_property: String,
    #[serde(default = "default_notion_status_property")]
    pub status_property: String,
    #[serde(default = "default_notion_enabled_property")]
    pub enabled_property: String,
    #[serde(default = "default_notion_enabled_value_bool")]
    pub enabled_value_bool: bool,
}

impl std::fmt::Debug for NotionTrackerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotionTrackerConfig")
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("database_id", &self.database_id)
            .field("version", &self.version)
            .field("title_property", &self.title_property)
            .field("status_property", &self.status_property)
            .field("enabled_property", &self.enabled_property)
            .field("enabled_value_bool", &self.enabled_value_bool)
            .finish()
    }
}

fn default_active_states() -> Vec<String> {
    vec!["Todo".to_string(), "In Progress".to_string()]
}

fn default_terminal_states() -> Vec<String> {
    vec!["Done".to_string(), "Closed".to_string()]
}

const DEFAULT_NOTION_VERSION: &str = "2022-06-28";
const DEFAULT_NOTION_TITLE_PROPERTY: &str = "Name";
const DEFAULT_NOTION_STATUS_PROPERTY: &str = "Status";
const DEFAULT_NOTION_ENABLED_PROPERTY: &str = "Ready to Implement";

fn default_notion_version() -> String {
    DEFAULT_NOTION_VERSION.to_string()
}

fn default_notion_title_property() -> String {
    DEFAULT_NOTION_TITLE_PROPERTY.to_string()
}

fn default_notion_status_property() -> String {
    DEFAULT_NOTION_STATUS_PROPERTY.to_string()
}

fn default_notion_enabled_property() -> String {
    DEFAULT_NOTION_ENABLED_PROPERTY.to_string()
}

fn default_notion_enabled_value_bool() -> bool {
    true
}

impl std::fmt::Debug for TrackerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrackerConfig")
            .field("kind", &self.kind)
            .field("active_states", &self.active_states)
            .field("terminal_states", &self.terminal_states)
            .field("path", &self.path)
            .field("endpoint", &self.endpoint)
            .field("gh_hostname", &self.gh_hostname)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("repository", &self.repository)
            .field("project_number", &self.project_number)
            .field("labels_filter", &self.labels_filter)
            .field("notion", &self.notion)
            .field("github", &self.github)
            .finish()
    }
}

impl TrackerConfig {
    pub fn notion_api_key(&self) -> Option<&str> {
        self.notion
            .as_ref()
            .and_then(|config| config.api_key.as_deref())
    }

    pub fn notion_database_id(&self) -> Option<&str> {
        self.notion
            .as_ref()
            .and_then(|config| config.database_id.as_deref())
    }

    pub fn notion_version(&self) -> &str {
        self.notion
            .as_ref()
            .map(|config| config.version.as_str())
            .unwrap_or(DEFAULT_NOTION_VERSION)
    }

    pub fn notion_title_property(&self) -> &str {
        self.notion
            .as_ref()
            .map(|config| config.title_property.as_str())
            .unwrap_or(DEFAULT_NOTION_TITLE_PROPERTY)
    }

    pub fn notion_status_property(&self) -> &str {
        self.notion
            .as_ref()
            .map(|config| config.status_property.as_str())
            .unwrap_or(DEFAULT_NOTION_STATUS_PROPERTY)
    }

    pub fn notion_enabled_property(&self) -> &str {
        self.notion
            .as_ref()
            .map(|config| config.enabled_property.as_str())
            .unwrap_or(DEFAULT_NOTION_ENABLED_PROPERTY)
    }

    pub fn notion_enabled_value_bool(&self) -> bool {
        self.notion
            .as_ref()
            .map(|config| config.enabled_value_bool)
            .unwrap_or(default_notion_enabled_value_bool())
    }
}

/// A selectable model discovered from an ACP session configuration option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ModelDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A selectable session mode discovered from an ACP session configuration option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ModeDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Runtime-discovered ACP capabilities for an agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DiscoveredCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<ModeDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
}

/// Per-agent definition: which executor to use and what prompt to send.
#[derive(Debug, Clone, Default, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acpx_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub prompt_template: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_models: Vec<ModelDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_modes: Vec<ModeDefinition>,
}

/// Approval gate metadata for a pipeline step.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepApprovalConfig {
    pub mode: StepApprovalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// Approval mode for a pipeline step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepApprovalMode {
    Always,
    WhenRequestedByAgent,
}

/// Kind of pipeline step.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    #[default]
    Agent,
    Synthesis,
}

impl StepKind {
    pub fn is_agent(&self) -> bool {
        matches!(self, Self::Agent)
    }
}

impl std::fmt::Display for StepKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Agent => write!(f, "agent"),
            Self::Synthesis => write!(f, "synthesis"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OnFailure {
    #[default]
    RetryIssue,
    RetryStep,
    Fixup,
    Halt,
}

impl OnFailure {
    pub fn is_default(&self) -> bool {
        matches!(self, Self::RetryIssue)
    }
}

/// A single step in the pipeline DAG.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "StepKind::is_agent")]
    pub kind: StepKind,
    pub agent: String,
    /// Explicit dependencies. `None` means "use implicit sequential rule" (depend on
    /// previous step). `Some(vec![])` means "no dependencies" (explicit root).
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<StepApprovalConfig>,
    #[serde(default, skip_serializing_if = "OnFailure::is_default")]
    pub on_failure: OnFailure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixup_agent: Option<String>,
}

/// Concurrency limits for the pipeline orchestrator.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ConcurrencyConfig {
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: u32,
    #[serde(default = "default_max_step_parallelism")]
    pub max_step_parallelism: u32,
    #[serde(default = "default_completed_expiry_secs")]
    pub completed_expiry_secs: u64,
}

fn default_max_concurrent_agents() -> u32 {
    4
}

fn default_max_step_parallelism() -> u32 {
    2
}

fn default_completed_expiry_secs() -> u64 {
    259200
}

pub fn default_workspace_root() -> String {
    std::env::temp_dir()
        .join("ensemble_workspaces")
        .display()
        .to_string()
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: default_max_concurrent_agents(),
            max_step_parallelism: default_max_step_parallelism(),
            completed_expiry_secs: default_completed_expiry_secs(),
        }
    }
}

/// How often to poll the tracker for new issues.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct PollingConfig {
    #[serde(default = "default_polling_interval_ms")]
    pub interval_ms: u64,
}

fn default_polling_interval_ms() -> u64 {
    30_000
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            interval_ms: default_polling_interval_ms(),
        }
    }
}

/// Workspace directory configuration.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema, Default)]
pub struct WorkspaceConfig {
    pub root: Option<String>,
}

/// Shell hooks run at lifecycle events in each workspace.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct HooksConfig {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_hook_timeout_ms() -> u64 {
    60_000
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            after_create: None,
            before_run: None,
            after_run: None,
            before_remove: None,
            timeout_ms: default_hook_timeout_ms(),
        }
    }
}

/// Runtime configuration for the agent executor.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AgentRuntimeConfig {
    #[serde(default, deserialize_with = "deserialize_state_worker_caps")]
    #[schema(schema_with = state_worker_caps_schema)]
    pub max_concurrent_agents_by_state: BTreeMap<String, u32>,
    #[serde(default = "default_max_retry_backoff_ms")]
    pub max_retry_backoff_ms: u64,
    #[serde(default = "default_agent_command")]
    pub command: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default = "default_permission_request_policy")]
    pub permission_request_policy: PermissionRequestPolicy,
    #[serde(default = "default_turn_timeout_ms")]
    pub turn_timeout_ms: u64,
    #[serde(default = "default_read_timeout_ms")]
    pub read_timeout_ms: u64,
    #[serde(default = "default_stall_timeout_ms")]
    pub stall_timeout_ms: i64,
    #[serde(default = "default_inject_interaction_policy_instructions")]
    pub inject_interaction_policy_instructions: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_policy_text: Option<String>,
    #[serde(default)]
    pub interaction_policy_overrides: InteractionPolicyOverridesConfig,
}

fn deserialize_state_worker_caps<'de, D>(deserializer: D) -> Result<BTreeMap<String, u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let entries = serde_yaml::Mapping::deserialize(deserializer)?;
    let mut parsed = Vec::with_capacity(entries.len());
    for (raw_key, raw_limit) in entries {
        let Some(state) = raw_key.as_str() else {
            return Err(serde::de::Error::custom(format!(
                "agent.max_concurrent_agents_by_state entry {raw_key:?} must use a state name"
            )));
        };
        let Some(limit) = raw_limit
            .as_u64()
            .and_then(|limit| u32::try_from(limit).ok())
        else {
            return Err(serde::de::Error::custom(format!(
                "agent.max_concurrent_agents_by_state entry {state:?} must be a positive integer"
            )));
        };
        parsed.push((state.to_string(), limit));
    }
    normalize_state_worker_caps(parsed).map_err(serde::de::Error::custom)
}

pub(crate) fn normalize_state_worker_caps(
    entries: impl IntoIterator<Item = (String, u32)>,
) -> Result<BTreeMap<String, u32>, String> {
    let mut normalized = BTreeMap::new();
    let mut original_keys = BTreeMap::new();
    for (state, limit) in entries {
        let normalized_state = normalize_state_worker_cap_key(&state);
        if normalized_state.is_empty() {
            return Err(
                "agent.max_concurrent_agents_by_state contains a blank state key".to_string(),
            );
        }
        if limit == 0 {
            return Err(format!(
                "agent.max_concurrent_agents_by_state entry {state:?} must be a positive integer"
            ));
        }
        if let Some(previous) = original_keys.insert(normalized_state.clone(), state.clone()) {
            return Err(format!(
                "agent.max_concurrent_agents_by_state entry {state:?} collides with {previous:?} after normalization"
            ));
        }
        normalized.insert(normalized_state, limit);
    }
    Ok(normalized)
}

pub(crate) fn normalize_state_worker_cap_key(state: &str) -> String {
    state.trim().to_lowercase()
}

pub(crate) fn state_worker_caps_schema() -> utoipa::openapi::schema::Object {
    use utoipa::openapi::schema::{ObjectBuilder, Type};

    ObjectBuilder::new()
        .schema_type(Type::Object)
        .property_names(Some(ObjectBuilder::new().schema_type(Type::String)))
        .additional_properties(Some(
            ObjectBuilder::new()
                .schema_type(Type::Integer)
                .minimum(Some(1))
                .maximum(Some(u32::MAX)),
        ))
        .build()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRequestPolicyMode {
    ApproveAll,
    RejectAll,
    SelectOption,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct PermissionRequestPolicy {
    pub mode: PermissionRequestPolicyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
}

impl PermissionRequestPolicy {
    pub fn approve_all() -> Self {
        Self {
            mode: PermissionRequestPolicyMode::ApproveAll,
            option_id: None,
        }
    }

    pub fn reject_all() -> Self {
        Self {
            mode: PermissionRequestPolicyMode::RejectAll,
            option_id: None,
        }
    }

    pub fn select_option(option_id: impl Into<String>) -> Self {
        Self {
            mode: PermissionRequestPolicyMode::SelectOption,
            option_id: Some(option_id.into()),
        }
    }

    pub fn is_default(&self) -> bool {
        self == &Self::approve_all()
    }

    pub fn legacy_policy_id(&self) -> String {
        match self.mode {
            PermissionRequestPolicyMode::ApproveAll => "auto_approve_all".to_string(),
            PermissionRequestPolicyMode::RejectAll => "reject_all".to_string(),
            PermissionRequestPolicyMode::SelectOption => self.option_id.clone().unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct InteractionPolicyOverridesConfig {
    #[serde(default)]
    pub agents: HashMap<String, InteractionPolicyOverrideConfig>,
    #[serde(default)]
    pub steps: HashMap<String, InteractionPolicyOverrideConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct InteractionPolicyOverrideConfig {
    #[serde(default)]
    pub mode: InteractionPolicyOverrideMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionPolicyOverrideMode {
    #[default]
    Inherit,
    Custom,
    Off,
}

fn default_max_retry_backoff_ms() -> u64 {
    300_000
}

fn default_agent_command() -> String {
    "claude-code".to_string()
}

fn default_session_mode() -> String {
    "code".to_string()
}

fn default_permission_request_policy() -> PermissionRequestPolicy {
    PermissionRequestPolicy::approve_all()
}

fn default_turn_timeout_ms() -> u64 {
    3_600_000
}

fn default_read_timeout_ms() -> u64 {
    5_000
}

fn default_stall_timeout_ms() -> i64 {
    300_000
}

fn default_inject_interaction_policy_instructions() -> bool {
    true
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents_by_state: BTreeMap::new(),
            max_retry_backoff_ms: default_max_retry_backoff_ms(),
            command: default_agent_command(),
            session_mode: default_session_mode(),
            permission_request_policy: default_permission_request_policy(),
            turn_timeout_ms: default_turn_timeout_ms(),
            read_timeout_ms: default_read_timeout_ms(),
            stall_timeout_ms: default_stall_timeout_ms(),
            inject_interaction_policy_instructions: default_inject_interaction_policy_instructions(
            ),
            interaction_policy_text: None,
            interaction_policy_overrides: InteractionPolicyOverridesConfig::default(),
        }
    }
}

/// Resolve `$VAR_NAME` in a string value to its environment variable.
/// Returns the literal string if it doesn't start with `$`.
/// Returns None if the env var is empty or unset.
/// Falls back to `dotenv_map` when the env var is not in the process environment.
fn resolve_env_var(value: &str, dotenv_map: &HashMap<String, String>) -> Option<String> {
    if let Some(var_name) = value.strip_prefix('$') {
        match std::env::var(var_name) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => dotenv_map.get(var_name).filter(|v| !v.is_empty()).cloned(),
        }
    } else {
        Some(value.to_string())
    }
}

/// Resolve a path string: expand `$VAR` then `~`.
/// Returns `None` if the path references an unset/empty env var.
fn resolve_path(path_str: &str, dotenv_map: &HashMap<String, String>) -> Option<PathBuf> {
    resolve_env_var(path_str, dotenv_map)
        .map(|resolved| PathBuf::from(shellexpand::tilde(&resolved).as_ref()))
}

pub(crate) fn resolve_relative_to_base(path: &Path, base_dir: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

/// Read a `.env` file into a local map without mutating the process environment.
/// Best-effort: returns an empty map on any error.
pub(crate) fn read_dotenv(path: &Path) -> HashMap<String, String> {
    dotenvy::from_path_iter(path)
        .ok()
        .map(|iter| {
            iter.filter_map(Result::ok)
                .filter(|(_, value)| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

impl EnsembleConfig {
    pub fn uses_workflow_selection(&self) -> bool {
        !self.workflow_selection.is_empty()
    }

    /// Resolve a durable selected-workflow identity into the whole immutable
    /// configuration snapshot used by the existing pipeline runtime.
    pub fn resolve_selected_workflow(
        &self,
        rule_name: &str,
        pipeline_name: &str,
        lane_name: &str,
    ) -> Result<Self, PipelineError> {
        let rule = self
            .workflow_selection
            .iter()
            .find(|rule| rule.name == rule_name)
            .ok_or_else(|| PipelineError::InvalidSnapshot {
                reason: format!("selected workflow rule '{rule_name}' no longer exists"),
            })?;
        if rule.pipeline != pipeline_name || rule.lane != lane_name {
            return Err(PipelineError::InvalidSnapshot {
                reason: format!(
                    "selected workflow rule '{rule_name}' no longer resolves to pipeline '{pipeline_name}' and lane '{lane_name}'"
                ),
            });
        }
        let pipeline =
            self.pipelines
                .get(pipeline_name)
                .ok_or_else(|| PipelineError::InvalidSnapshot {
                    reason: format!("selected pipeline '{pipeline_name}' no longer exists"),
                })?;
        self.scheduler
            .lanes
            .get(lane_name)
            .ok_or_else(|| PipelineError::InvalidSnapshot {
                reason: format!("selected scheduler lane '{lane_name}' no longer exists"),
            })?;

        let mut effective = self.clone();
        effective.steps = pipeline.steps.clone();
        effective.on_success.clone_from(&pipeline.on_success);
        effective.on_failure.clone_from(&pipeline.on_failure);
        Ok(effective)
    }

    /// Resolve environment variables and path expansions in config values.
    ///
    /// Call this after `parse_config()` to process `$VAR` and `~` in:
    /// - `tracker.api_key`
    /// - `tracker.path`
    /// - `workspace.root`
    /// - `agents.*.prompt_template`
    /// - `repos[*].path`
    pub fn resolve_env(&mut self) -> Result<(), crate::error::ConfigError> {
        self.resolve_env_from(Path::new("."), &HashMap::new())
    }

    /// Resolve environment variables and rebase relative paths from the config directory.
    ///
    /// This method:
    /// 1. Resolves `$VAR` and `~` in all path fields
    /// 2. Rebase relative paths to be relative to the config directory
    /// 3. Sets default TODO path for todo_file tracker if not specified
    pub fn resolve_env_from(
        &mut self,
        config_dir: &Path,
        dotenv_map: &HashMap<String, String>,
    ) -> Result<(), crate::error::ConfigError> {
        // tracker.api_key: $VAR resolution
        if let Some(ref raw) = self.tracker.api_key {
            self.tracker.api_key = resolve_env_var(raw, dotenv_map);
        } else if self.tracker.kind == "github" {
            // Only auto-resolve $GITHUB_TOKEN for github tracker
            self.tracker.api_key = resolve_env_var("$GITHUB_TOKEN", dotenv_map);
        }

        if let Some(notion) = self.tracker.notion.as_mut() {
            if let Some(ref raw) = notion.api_key {
                notion.api_key = resolve_env_var(raw, dotenv_map);
            }
            if let Some(ref raw) = notion.database_id {
                notion.database_id = resolve_env_var(raw, dotenv_map);
            }
        }

        // tracker.path: $VAR + ~ expansion, with default for todo_file
        if self.tracker.kind == "todo_file" && self.tracker.path.is_none() {
            self.tracker.path = Some(default_todo_state_path()?);
        }

        if let Some(ref path) = self.tracker.path {
            let path_str = path.to_string_lossy();
            let resolved = resolve_path(&path_str, dotenv_map);
            self.tracker.path = resolved.map(|p| resolve_relative_to_base(&p, config_dir));
        }

        // workspace.root: $VAR + ~ expansion + rebase
        if let Some(ref root) = self.workspace.root {
            let resolved = resolve_path(root, dotenv_map);
            self.workspace.root = resolved.map(|p| {
                let final_path = resolve_relative_to_base(&p, config_dir);
                final_path.to_string_lossy().into_owned()
            });
        }

        // repos[*].path: $VAR + ~ expansion + rebase
        for repo in &mut self.repos {
            let path_str = &repo.path;
            if let Some(resolved) = resolve_path(path_str, dotenv_map) {
                let final_path = resolve_relative_to_base(&resolved, config_dir);
                repo.path = final_path.to_string_lossy().into_owned();
            }
        }

        // agents.*.prompt_template: $VAR + ~ expansion + rebase
        for agent in self.agents.values_mut() {
            if let Some(ref path) = agent.prompt_template {
                let path_str = path.to_string_lossy();
                let resolved = resolve_path(&path_str, dotenv_map);
                agent.prompt_template = resolved.map(|p| resolve_relative_to_base(&p, config_dir));
            }
        }

        Ok(())
    }
}

/// Load and parse a `config.yaml` file from the given path.
///
/// This function:
/// 1. Loads `.env` from the config directory (if present) before expanding variables
/// 2. Reads and parses the YAML file
/// 3. Resolves environment variables and rebases relative paths from the config directory
pub fn load_config(path: &std::path::Path) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let dotenv_map = read_dotenv(&config_dir.join(".env"));

    let content = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => crate::error::ConfigError::MissingConfigFile {
            path: path.display().to_string(),
        },
        _ => crate::error::ConfigError::ConfigReadError {
            path: path.display().to_string(),
            reason: error.to_string(),
        },
    })?;
    let mut config = parse_config(&content)?;
    config.resolve_env_from(config_dir, &dotenv_map)?;
    Ok(config)
}

/// Parse an `ensemble.yaml` YAML string into an `EnsembleConfig`.
/// Note: Does NOT resolve `$VAR` or `~`. Call `config.resolve_env()` after
/// parsing, or use `load_config()` which does both.
pub fn parse_config(yaml: &str) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|e| crate::error::ConfigError::ConfigParseError {
            reason: e.to_string(),
        })?;
    reject_unsupported_agent_max_turns(&value)?;
    reject_legacy_agent_permission_policy(&value)?;
    reject_legacy_notion_tracker_keys(&value)?;
    let config: EnsembleConfig =
        serde_yaml::from_value(value).map_err(|e| crate::error::ConfigError::ConfigParseError {
            reason: e.to_string(),
        })?;
    validate_github_project_config(&config)?;
    Ok(config)
}

fn validate_github_project_config(
    config: &EnsembleConfig,
) -> Result<(), crate::error::ConfigError> {
    if config.tracker.kind != "github" {
        return Ok(());
    }

    let github = config.tracker.github.as_ref();
    if config.tracker.project_number.is_some() {
        let github = github.ok_or_else(|| crate::error::ConfigError::ConfigParseError {
            reason: "tracker.github.status_field is required when tracker.project_number is set"
                .to_string(),
        })?;
        if github.status_field.trim().is_empty() {
            return Err(crate::error::ConfigError::ConfigParseError {
                reason: "tracker.github.status_field must not be empty".to_string(),
            });
        }
    }
    let Some(github) = github else {
        return Ok(());
    };
    if let Some(priority) = &github.priority {
        if priority.field.trim().is_empty() {
            return Err(crate::error::ConfigError::ConfigParseError {
                reason: "tracker.github.priority.field must not be empty".to_string(),
            });
        }
        if priority
            .options
            .iter()
            .any(|option| option.trim().is_empty())
        {
            return Err(crate::error::ConfigError::ConfigParseError {
                reason: "tracker.github.priority.options must not contain empty names".to_string(),
            });
        }
    }
    if let Some(ownership) = &github.ownership {
        if let Some(claim) = &ownership.claim {
            if claim.claimed_state.trim().is_empty() || claim.resume_states.is_empty() {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason: "tracker.github.ownership.claim requires a non-blank claimed_state and non-empty resume_states".to_string(),
                });
            }
            if claim
                .resume_states
                .iter()
                .any(|state| state.trim().is_empty())
            {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason:
                        "tracker.github.ownership.claim.resume_states must not contain blank names"
                            .to_string(),
                });
            }
            if !claim
                .resume_states
                .iter()
                .any(|state| state.eq_ignore_ascii_case(&claim.claimed_state))
            {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason: "tracker.github.ownership.claim.resume_states must include claimed_state so pre-journal claims remain recoverable".to_string(),
                });
            }
        }
        if let Some(adoption) = &ownership.delivery_adoption {
            if adoption.repository.trim().is_empty()
                || adoption.base_branch.trim().is_empty()
                || adoption.branch_template.trim().is_empty()
            {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason: "tracker.github.ownership.delivery_adoption fields must not be blank"
                        .to_string(),
                });
            }
            if adoption
                .branch_template
                .matches("{issue_workspace_key}")
                .count()
                != 1
                || !valid_rendered_branch(&adoption.render_branch("issue-key-0123456789abcdef"))
            {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason: "tracker.github.ownership.delivery_adoption.branch_template must contain exactly one {issue_workspace_key} and render a valid Git branch".to_string(),
                });
            }
        }
    }
    Ok(())
}

fn valid_rendered_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch != "@"
        && !branch.starts_with(['-', '/'])
        && !branch.ends_with(['/', '.'])
        && !branch.chars().any(|character| {
            character.is_ascii_control()
                || matches!(character, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
        && !branch.contains("..")
        && !branch.contains("@{")
        && branch.split('/').all(|component| {
            !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
        })
}

pub(crate) fn reject_unsupported_agent_max_turns(
    value: &serde_yaml::Value,
) -> Result<(), crate::error::ConfigError> {
    let Some(agent) = value
        .as_mapping()
        .and_then(|root| root.get(serde_yaml::Value::String("agent".to_string())))
        .and_then(serde_yaml::Value::as_mapping)
    else {
        return Ok(());
    };

    if agent.contains_key(serde_yaml::Value::String("max_turns".to_string())) {
        return Err(crate::error::ConfigError::ConfigParseError {
            reason: "agent.max_turns is no longer supported because Ensemble cannot enforce provider-internal model turns".to_string(),
        });
    }

    Ok(())
}

fn reject_legacy_notion_tracker_keys(
    value: &serde_yaml::Value,
) -> Result<(), crate::error::ConfigError> {
    let Some(tracker) = value
        .as_mapping()
        .and_then(|root| root.get(serde_yaml::Value::String("tracker".to_string())))
        .and_then(serde_yaml::Value::as_mapping)
    else {
        return Ok(());
    };

    let is_notion = tracker
        .get(serde_yaml::Value::String("kind".to_string()))
        .and_then(serde_yaml::Value::as_str)
        == Some("notion");
    if !is_notion {
        return Ok(());
    }

    let legacy_keys = [
        "api_key",
        "database_id",
        "notion_version",
        "title_property",
        "status_property",
        "enabled_property",
        "enabled_value_bool",
    ];

    let found: Vec<&str> = legacy_keys
        .iter()
        .copied()
        .filter(|key| tracker.contains_key(serde_yaml::Value::String((*key).to_string())))
        .collect();

    if found.is_empty() {
        return Ok(());
    }

    Err(crate::error::ConfigError::ConfigParseError {
        reason: format!(
            "legacy Notion tracker keys are no longer supported at tracker root: {}. Use tracker.notion.* instead",
            found.join(", ")
        ),
    })
}

fn reject_legacy_agent_permission_policy(
    value: &serde_yaml::Value,
) -> Result<(), crate::error::ConfigError> {
    let Some(agent) = value
        .as_mapping()
        .and_then(|root| root.get(serde_yaml::Value::String("agent".to_string())))
        .and_then(serde_yaml::Value::as_mapping)
    else {
        return Ok(());
    };

    let legacy_key = serde_yaml::Value::String("permission_policy".to_string());
    if agent.contains_key(&legacy_key) {
        return Err(crate::error::ConfigError::ConfigParseError {
            reason: "agent.permission_policy is no longer supported; use agent.permission_request_policy.mode instead".to_string(),
        });
    }

    let canonical_key = serde_yaml::Value::String("permission_request_policy".to_string());
    if agent
        .get(&canonical_key)
        .is_some_and(serde_yaml::Value::is_string)
    {
        return Err(crate::error::ConfigError::ConfigParseError {
            reason: "agent.permission_request_policy string values are no longer supported; use agent.permission_request_policy.mode instead".to_string(),
        });
    }

    Ok(())
}

/// Validate the config for consistency: prompt config, agent references, step name uniqueness, etc.
pub fn validate_config(config: &EnsembleConfig) -> Result<(), PipelineError> {
    let selected_mode = !config.workflow_selection.is_empty();
    if selected_mode {
        if !config.steps.is_empty()
            || !config.on_success.trim().is_empty()
            || !config.on_failure.trim().is_empty()
        {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: "<mode>".to_string(),
                reason:
                    "selected mode cannot be mixed with top-level steps, on_success, or on_failure"
                        .to_string(),
            });
        }
        if config.pipelines.is_empty() {
            return Err(PipelineError::InvalidNamedPipeline {
                pipeline: "<missing>".to_string(),
                reason: "selected mode requires at least one named pipeline".to_string(),
            });
        }
        if config.scheduler.lanes.is_empty() {
            return Err(PipelineError::InvalidSchedulerLane {
                lane: "<missing>".to_string(),
                reason: "selected mode requires at least one scheduler lane".to_string(),
            });
        }
    } else if !config.pipelines.is_empty() || !config.scheduler.lanes.is_empty() {
        return Err(PipelineError::InvalidWorkflowSelection {
            rule: "<mode>".to_string(),
            reason: "named pipelines and scheduler lanes require non-empty workflow_selection"
                .to_string(),
        });
    }

    for (name, lane) in &config.scheduler.lanes {
        if name.trim().is_empty() {
            return Err(PipelineError::InvalidSchedulerLane {
                lane: "<unnamed>".to_string(),
                reason: "name must not be blank".to_string(),
            });
        }
        if lane.capacity == 0 {
            return Err(PipelineError::InvalidSchedulerLane {
                lane: name.clone(),
                reason: "capacity must be greater than 0".to_string(),
            });
        }
    }

    let mut rule_names = std::collections::HashSet::new();
    let mut precedences = std::collections::HashSet::new();
    for rule in &config.workflow_selection {
        let normalized_name = rule.name.trim().to_lowercase();
        let display_name = if normalized_name.is_empty() {
            "<unnamed>"
        } else {
            rule.name.as_str()
        };
        if normalized_name.is_empty() || !rule_names.insert(normalized_name) {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: "name must be non-blank and unique after normalization".to_string(),
            });
        }
        if rule.precedence == 0 || !precedences.insert(rule.precedence) {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: "precedence must be positive and globally unique".to_string(),
            });
        }
        if !config.pipelines.contains_key(&rule.pipeline) {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: format!("unknown pipeline '{}'", rule.pipeline),
            });
        }
        if !config.scheduler.lanes.contains_key(&rule.lane) {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: format!("unknown scheduler lane '{}'", rule.lane),
            });
        }
        for (predicate, values) in [
            ("states", rule.states.as_ref()),
            ("labels_all", rule.labels_all.as_ref()),
            ("labels_any", rule.labels_any.as_ref()),
            ("labels_none", rule.labels_none.as_ref()),
        ] {
            if let Some(values) = values {
                if values.is_empty() {
                    return Err(PipelineError::InvalidWorkflowSelection {
                        rule: display_name.to_string(),
                        reason: format!("{predicate} must not be empty when supplied"),
                    });
                }
                let mut normalized = std::collections::HashSet::new();
                if values.iter().any(|value| {
                    let value = value.trim().to_lowercase();
                    value.is_empty() || !normalized.insert(value)
                }) {
                    return Err(PipelineError::InvalidWorkflowSelection {
                        rule: display_name.to_string(),
                        reason: format!(
                            "{predicate} values must be non-blank and unique after normalization"
                        ),
                    });
                }
            }
        }
        if rule.order_by.is_empty() {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: "order_by must not be empty".to_string(),
            });
        }
        let mut order_keys = std::collections::HashSet::new();
        if rule.order_by.iter().any(|key| !order_keys.insert(*key)) {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: "order_by keys must be unique".to_string(),
            });
        }
        if rule
            .order_by
            .iter()
            .position(|key| *key == WorkflowOrderKey::Identifier)
            .is_some_and(|index| index + 1 != rule.order_by.len())
        {
            return Err(PipelineError::InvalidWorkflowSelection {
                rule: display_name.to_string(),
                reason: "identifier may appear only as the final order_by key".to_string(),
            });
        }
    }

    let effective_pipelines: Vec<(&str, &[StepConfig], &str, &str)> = if selected_mode {
        config
            .pipelines
            .iter()
            .map(|(name, pipeline)| {
                (
                    name.as_str(),
                    pipeline.steps.as_slice(),
                    pipeline.on_success.as_str(),
                    pipeline.on_failure.as_str(),
                )
            })
            .collect()
    } else {
        vec![(
            "<legacy>",
            config.steps.as_slice(),
            config.on_success.as_str(),
            config.on_failure.as_str(),
        )]
    };

    for (name, _, on_success, on_failure) in &effective_pipelines {
        if name.trim().is_empty() || on_success.trim().is_empty() || on_failure.trim().is_empty() {
            return Err(PipelineError::InvalidNamedPipeline {
                pipeline: (*name).to_string(),
                reason: "name, on_success, and on_failure must be non-blank".to_string(),
            });
        }
    }

    let mut review_state: Option<&str> = None;
    for (index, repo) in config.repos.iter().enumerate() {
        let Some(target) = repo.finalize.review_state.as_deref() else {
            continue;
        };
        let repo_key = repository_key(repo, index);
        if target.trim().is_empty() {
            return Err(PipelineError::InvalidFinalizeConfig {
                repo: repo_key,
                reason: "review_state must not be empty".to_string(),
            });
        }
        if repo.finalize.mode != crate::workspace::finalize::FinalizeMode::PushAndPr {
            return Err(PipelineError::InvalidFinalizeConfig {
                repo: repo_key,
                reason: "review_state is valid only with push_and_pr finalization".to_string(),
            });
        }
        if effective_pipelines
            .iter()
            .any(|(_, _, on_success, _)| target.eq_ignore_ascii_case(on_success))
        {
            return Err(PipelineError::InvalidFinalizeConfig {
                repo: repo_key,
                reason: "review_state must not equal on_success".to_string(),
            });
        }
        if config
            .tracker
            .terminal_states
            .iter()
            .any(|state| target.eq_ignore_ascii_case(state))
        {
            return Err(PipelineError::InvalidFinalizeConfig {
                repo: repo_key,
                reason: "review_state must not be a configured terminal state".to_string(),
            });
        }
        if let Some(existing) = review_state {
            if !target.eq_ignore_ascii_case(existing) {
                return Err(PipelineError::InvalidFinalizeConfig {
                    repo: repo_key,
                    reason: "all review_state values must use the same value".to_string(),
                });
            }
        } else {
            review_state = Some(target);
        }
    }
    if review_state.is_some() {
        for (index, repo) in config.repos.iter().enumerate() {
            if repo.finalize.mode == crate::workspace::finalize::FinalizeMode::PushAndPr
                && repo.finalize.review_state.is_none()
            {
                return Err(PipelineError::InvalidFinalizeConfig {
                    repo: repository_key(repo, index),
                    reason: "all push_and_pr repositories must opt in to the review_state"
                        .to_string(),
                });
            }
        }
    }

    let mut acceptance_names = std::collections::HashSet::new();
    for command in &config.acceptance.commands {
        let display_name = if command.name.trim().is_empty() {
            "<unnamed>"
        } else {
            command.name.as_str()
        };
        let reason = if command.name.trim().is_empty() {
            Some("name must not be empty")
        } else if !acceptance_names.insert(command.name.clone()) {
            Some("name must be unique")
        } else if command.run.trim().is_empty() {
            Some("run must not be empty")
        } else if command.timeout_ms == 0 {
            Some("timeout_ms must be greater than 0")
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(PipelineError::InvalidAcceptanceCommand {
                name: display_name.to_string(),
                reason: reason.to_string(),
            });
        }
    }

    let repository_matches = |key: &str| {
        config
            .repos
            .iter()
            .enumerate()
            .filter(|(index, repo)| repository_key(repo, *index) == key)
            .map(|(_, repo)| repo)
            .collect::<Vec<_>>()
    };
    let validate_name = |names: &mut std::collections::HashSet<String>,
                         kind: &str,
                         name: &str|
     -> Result<(), PipelineError> {
        let display_name = if name.trim().is_empty() {
            "<unnamed>"
        } else {
            name
        };
        let reason = if name.trim().is_empty() {
            Some("name must not be empty")
        } else if !names.insert(name.to_string()) {
            Some("name must be unique across all acceptance checks")
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: kind.to_string(),
                name: display_name.to_string(),
                reason: reason.to_string(),
            });
        }
        Ok(())
    };

    for rule in &config.acceptance.required_files {
        validate_name(&mut acceptance_names, "file", &rule.name)?;
        let matches = repository_matches(&rule.repo);
        if matches.len() != 1 {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "file".to_string(),
                name: rule.name.clone(),
                reason: format!(
                    "repository key '{}' must resolve to exactly one configured repository (found {})",
                    rule.repo,
                    matches.len()
                ),
            });
        }
        if rule.path.as_os_str().is_empty()
            || rule.path.is_absolute()
            || rule.path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "file".to_string(),
                name: rule.name.clone(),
                reason:
                    "path must be a non-empty repository-relative path without parent traversal"
                        .to_string(),
            });
        }
    }

    for rule in &config.acceptance.required_handoff_sections {
        validate_name(&mut acceptance_names, "handoff", &rule.name)?;
        if effective_pipelines
            .iter()
            .any(|(_, steps, _, _)| !steps.iter().any(|step| step.name == rule.step))
        {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "handoff".to_string(),
                name: rule.name.clone(),
                reason: format!("unknown step '{}'", rule.step),
            });
        }
        if rule.sections.is_empty() {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "handoff".to_string(),
                name: rule.name.clone(),
                reason: "sections must not be empty".to_string(),
            });
        }
        let mut sections = std::collections::HashSet::new();
        if let Some(section) = rule
            .sections
            .iter()
            .find(|section| section.trim().is_empty() || !sections.insert(section.as_str()))
        {
            let reason = if section.trim().is_empty() {
                "section names must not be empty".to_string()
            } else {
                format!("duplicate section '{section}'")
            };
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "handoff".to_string(),
                name: rule.name.clone(),
                reason,
            });
        }
    }

    for rule in &config.acceptance.required_pull_requests {
        validate_name(&mut acceptance_names, "pull_request", &rule.name)?;
        let matches = repository_matches(&rule.repo);
        if matches.len() != 1 {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "pull_request".to_string(),
                name: rule.name.clone(),
                reason: format!(
                    "repository key '{}' must resolve to exactly one configured repository (found {})",
                    rule.repo,
                    matches.len()
                ),
            });
        }
        let repo = matches[0];
        if !repo.finalize.enabled
            || !matches!(
                repo.finalize.mode,
                crate::workspace::finalize::FinalizeMode::PushAndPr
            )
        {
            return Err(PipelineError::InvalidAcceptanceRequirement {
                kind: "pull_request".to_string(),
                name: rule.name.clone(),
                reason: format!(
                    "repository '{}' must use enabled finalize.mode: push_and_pr",
                    rule.repo
                ),
            });
        }
    }

    for (name, agent) in &config.agents {
        match (&agent.prompt, &agent.prompt_template) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(PipelineError::InvalidPromptConfig {
                    agent: name.clone(),
                });
            }
            _ => {}
        }

        let has_acpx = agent.acpx_agent.is_some();
        let has_executor = agent.executor.is_some();
        let has_model = agent.model.is_some();
        let runtime_kind = RuntimeKind::for_agent(agent);

        if let Some(runtime) = agent.runtime.as_deref() {
            match runtime {
                "acpx" => {
                    if !has_acpx {
                        return Err(PipelineError::InvalidRuntimeConfig {
                            agent: name.clone(),
                            reason: "runtime 'acpx' requires acpx_agent".to_string(),
                        });
                    }
                }
                "direct" => {}
                _ => {
                    return Err(PipelineError::InvalidRuntimeConfig {
                        agent: name.clone(),
                        reason: format!("unsupported runtime '{runtime}'"),
                    });
                }
            }
        }

        if let Some(permission_mode) = agent.permission_mode.as_deref() {
            if runtime_kind != RuntimeKind::Acpx {
                let reason = if !has_acpx {
                    "permission_mode requires acpx_agent".to_string()
                } else {
                    "permission_mode requires acpx runtime".to_string()
                };
                return Err(PipelineError::InvalidPermissionMode {
                    agent: name.clone(),
                    reason,
                });
            }

            if PermissionMode::parse(permission_mode).is_none() {
                return Err(PipelineError::InvalidPermissionMode {
                    agent: name.clone(),
                    reason: format!(
                        "unsupported value '{}' (expected one of: approve_all, approve_reads, deny_all)",
                        permission_mode
                    ),
                });
            }
        }

        if runtime_kind == RuntimeKind::Direct && (!has_executor || !has_model) {
            return Err(PipelineError::InvalidAgentConfig {
                agent: name.clone(),
            });
        }
    }

    let any_acpx = config
        .agents
        .values()
        .any(|agent| RuntimeKind::for_agent(agent) == RuntimeKind::Acpx);
    let any_direct = config
        .agents
        .values()
        .any(|agent| RuntimeKind::for_agent(agent) == RuntimeKind::Direct);
    if matches!(
        config.agent.permission_request_policy.mode,
        PermissionRequestPolicyMode::SelectOption
    ) && config
        .agent
        .permission_request_policy
        .option_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err(PipelineError::InvalidRuntimeConfig {
            agent: "agent".to_string(),
            reason: "permission_request_policy.mode select_option requires a non-empty option_id"
                .to_string(),
        });
    }
    if any_acpx && !any_direct && !config.agent.permission_request_policy.is_default() {
        return Err(PipelineError::InvalidRuntimeConfig {
            agent: "agent".to_string(),
            reason: "permission_request_policy is ignored for acpx runtime; remove it or use direct runtime".to_string(),
        });
    }

    for (pipeline_name, steps, _, _) in effective_pipelines {
        let mut seen_names = std::collections::HashSet::new();
        for step in steps {
            if !seen_names.insert(&step.name) {
                return Err(PipelineError::DuplicateStepName {
                    name: step.name.clone(),
                });
            }
            if !config.agents.contains_key(&step.agent) {
                return Err(PipelineError::UnknownAgent {
                    name: step.agent.clone(),
                });
            }
            if step.timeout_ms == Some(0) {
                return Err(PipelineError::InvalidStepConfig {
                    step: step.name.clone(),
                    reason: "timeout_ms must be greater than 0".to_string(),
                });
            }
            if step.on_failure == OnFailure::Fixup {
                let Some(fixup_agent) = step.fixup_agent.as_deref() else {
                    return Err(PipelineError::InvalidStepConfig {
                        step: step.name.clone(),
                        reason: "on_failure: fixup requires fixup_agent".to_string(),
                    });
                };
                if !config.agents.contains_key(fixup_agent) {
                    return Err(PipelineError::UnknownAgent {
                        name: fixup_agent.to_string(),
                    });
                }
            }
            if step.kind == StepKind::Synthesis && step.depends.as_ref().is_none_or(Vec::is_empty) {
                return Err(PipelineError::InvalidSynthesisStep {
                    step: step.name.clone(),
                    reason: "synthesis steps require explicit non-empty depends".to_string(),
                });
            }
        }
        if selected_mode {
            crate::pipeline::dag::build_dag(steps).map_err(|error| {
                PipelineError::InvalidNamedPipeline {
                    pipeline: pipeline_name.to_string(),
                    reason: error.to_string(),
                }
            })?;
        } else {
            crate::pipeline::dag::build_dag(steps)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env::ENV_LOCK;

    const ENV_VARS: &[&str] = &[
        "GITHUB_TOKEN",
        "ENSEMBLE_TEST_KEY_2B",
        "ENSEMBLE_EMPTY_2B",
        "ENSEMBLE_TEST_REPO",
    ];

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                std::env::remove_var(key);
            }

            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn minimal_yaml() -> &'static str {
        r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#
    }

    #[test]
    fn test_parse_minimal_config() {
        let config = parse_config(minimal_yaml()).unwrap();
        assert_eq!(config.tracker.kind, "todo_file");
        assert_eq!(config.agents.len(), 1);
        assert!(config.agents.contains_key("build"));
        assert_eq!(config.steps.len(), 1);
        assert_eq!(config.steps[0].name, "build");
        assert_eq!(config.steps[0].agent, "build");
        assert_eq!(config.on_success, "Done");
        assert_eq!(config.on_failure, "Failed");
        assert!(config.acceptance.commands.is_empty());
        assert!(config.acceptance.required_files.is_empty());
        assert!(config.acceptance.required_handoff_sections.is_empty());
        assert!(config.acceptance.required_pull_requests.is_empty());
    }

    #[test]
    fn selected_mode_parses_named_pipeline_lane_and_rule() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
pipelines:
  delivery:
    steps:
      - name: build
        agent: build
    on_success: Done
    on_failure: Failed
scheduler:
  lanes:
    delivery:
      capacity: 2
workflow_selection:
  - name: ready
    precedence: 10
    pipeline: delivery
    lane: delivery
    states: [Ready]
    labels_all: [ready-for-agent]
    labels_any: [backend, frontend]
    labels_none: [hold]
    require_unblocked: true
    order_by: [priority, tracker_position, created_at]
"#,
        )
        .unwrap();

        assert!(config.steps.is_empty());
        assert_eq!(config.pipelines["delivery"].steps[0].name, "build");
        assert_eq!(config.scheduler.lanes["delivery"].capacity, 2);
        assert_eq!(config.workflow_selection[0].name, "ready");
        assert_eq!(
            config.workflow_selection[0].order_by,
            vec![
                WorkflowOrderKey::Priority,
                WorkflowOrderKey::TrackerPosition,
                WorkflowOrderKey::CreatedAt,
            ]
        );
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn selected_mode_rejects_ambiguous_or_nondeterministic_rules() {
        let selected = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: build
pipelines:
  main:
    steps: [{ name: build, agent: build }]
    on_success: Done
    on_failure: Failed
scheduler:
  lanes:
    main: { capacity: 1 }
workflow_selection:
  - name: first
    precedence: 1
    pipeline: main
    lane: main
    states: [Ready]
    order_by: [priority]
"#;

        let mut config = parse_config(selected).unwrap();
        config.steps = vec![config.pipelines["main"].steps[0].clone()];
        config.on_success = "Done".to_string();
        config.on_failure = "Failed".to_string();
        assert!(matches!(
            validate_config(&config),
            Err(PipelineError::InvalidWorkflowSelection { .. })
        ));

        let mut config = parse_config(selected).unwrap();
        config
            .workflow_selection
            .push(config.workflow_selection[0].clone());
        assert!(matches!(
            validate_config(&config),
            Err(PipelineError::InvalidWorkflowSelection { .. })
        ));

        let mut config = parse_config(selected).unwrap();
        config.workflow_selection[0].states = Some(Vec::new());
        assert!(matches!(
            validate_config(&config),
            Err(PipelineError::InvalidWorkflowSelection { .. })
        ));

        let mut config = parse_config(selected).unwrap();
        config.workflow_selection[0].order_by =
            vec![WorkflowOrderKey::Identifier, WorkflowOrderKey::CreatedAt];
        assert!(matches!(
            validate_config(&config),
            Err(PipelineError::InvalidWorkflowSelection { .. })
        ));

        let mut config = parse_config(selected).unwrap();
        config.scheduler.lanes.get_mut("main").unwrap().capacity = 0;
        assert!(matches!(
            validate_config(&config),
            Err(PipelineError::InvalidSchedulerLane { .. })
        ));
    }

    #[test]
    fn acceptance_parses_requirements() {
        let yaml = format!(
            "{}\nrepos:\n  - path: /tmp/ensemble\n    branch: main\n    finalize:\n      mode: push_and_pr\nacceptance:\n  required_files:\n    - name: release-notes\n      repo: ensemble\n      path: docs/release.md\n  required_handoff_sections:\n    - name: implementation-handoff\n      step: build\n      sections: [summary, testing]\n  required_pull_requests:\n    - name: ensemble-pr\n      repo: ensemble\n",
            minimal_yaml()
        );

        let config = parse_config(&yaml).unwrap();

        assert_eq!(
            config.acceptance.required_files,
            vec![AcceptanceFileConfig {
                name: "release-notes".to_string(),
                repo: "ensemble".to_string(),
                path: PathBuf::from("docs/release.md"),
            }]
        );
        assert_eq!(
            config.acceptance.required_handoff_sections,
            vec![AcceptanceHandoffConfig {
                name: "implementation-handoff".to_string(),
                step: "build".to_string(),
                sections: vec!["summary".to_string(), "testing".to_string()],
            }]
        );
        assert_eq!(
            config.acceptance.required_pull_requests,
            vec![AcceptancePullRequestConfig {
                name: "ensemble-pr".to_string(),
                repo: "ensemble".to_string(),
            }]
        );
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn review_state_requires_one_non_terminal_push_and_pr_target() {
        let valid = format!(
            "{}\nrepos:\n  - path: /tmp/ensemble\n    branch: main\n    finalize:\n      mode: push_and_pr\n      review_state: In review\n",
            minimal_yaml()
        );
        let config = parse_config(&valid).unwrap();
        assert_eq!(
            config.repos[0].finalize.review_state.as_deref(),
            Some("In review")
        );
        assert!(validate_config(&config).is_ok());

        let cases = [
            ("blank", "mode: push_and_pr\n      review_state: '  '", "must not be empty"),
            ("push", "mode: push\n      review_state: In review", "push_and_pr"),
            ("success", "mode: push_and_pr\n      review_state: Done", "on_success"),
            ("partial", "mode: push_and_pr\n      review_state: In review\n  - path: /tmp/other\n    branch: main\n    finalize:\n      mode: push_and_pr", "must opt in"),
            ("conflict", "mode: push_and_pr\n      review_state: In review\n  - path: /tmp/other\n    branch: main\n    finalize:\n      mode: push_and_pr\n      review_state: Needs review", "same value"),
        ];
        for (label, finalize, expected) in cases {
            let yaml = format!(
                "{}\nrepos:\n  - path: /tmp/ensemble\n    branch: main\n    finalize:\n      {finalize}\n",
                minimal_yaml()
            );
            let config = parse_config(&yaml).unwrap();
            let error = validate_config(&config).expect_err(label);
            assert!(error.to_string().contains(expected), "{label}: {error}");
        }

        let terminal = format!(
            "{}\nrepos:\n  - path: /tmp/ensemble\n    branch: main\n    finalize:\n      mode: push_and_pr\n      review_state: Failed\n",
            minimal_yaml()
        );
        let mut config = parse_config(&terminal).unwrap();
        config.tracker.terminal_states.push("Failed".to_string());
        let error = validate_config(&config).unwrap_err();
        assert!(error.to_string().contains("terminal"));
    }

    #[test]
    fn acceptance_rejects_invalid_requirements() {
        let cases = [
            (
                "blank name",
                "required_files:\n    - name: '  '\n      repo: ensemble\n      path: docs/release.md",
                "name must not be empty",
            ),
            (
                "cross-kind duplicate",
                "commands:\n    - name: duplicate\n      run: echo ok\n      timeout_ms: 1\n  required_files:\n    - name: duplicate\n      repo: ensemble\n      path: docs/release.md",
                "unique across all acceptance checks",
            ),
            (
                "unknown repository",
                "required_files:\n    - name: file\n      repo: missing\n      path: docs/release.md",
                "found 0",
            ),
            (
                "unknown step",
                "required_handoff_sections:\n    - name: handoff\n      step: missing\n      sections: [summary]",
                "unknown step 'missing'",
            ),
            (
                "empty sections",
                "required_handoff_sections:\n    - name: handoff\n      step: build\n      sections: []",
                "sections must not be empty",
            ),
            (
                "duplicate sections",
                "required_handoff_sections:\n    - name: handoff\n      step: build\n      sections: [summary, summary]",
                "duplicate section 'summary'",
            ),
            (
                "absolute path",
                "required_files:\n    - name: file\n      repo: ensemble\n      path: /tmp/release.md",
                "repository-relative path",
            ),
            (
                "parent path",
                "required_files:\n    - name: file\n      repo: ensemble\n      path: ../release.md",
                "repository-relative path",
            ),
            (
                "wrong delivery mode",
                "required_pull_requests:\n    - name: pr\n      repo: other",
                "push_and_pr",
            ),
        ];

        for (label, acceptance, expected) in cases {
            let yaml = format!(
                "{}\nrepos:\n  - path: /tmp/ensemble\n    branch: main\n    finalize:\n      mode: push_and_pr\n  - path: /tmp/other\n    branch: main\n    finalize:\n      mode: push\nacceptance:\n  {acceptance}\n",
                minimal_yaml()
            );
            let config = parse_config(&yaml).unwrap();
            let error = validate_config(&config).expect_err(label);
            assert!(
                error.to_string().contains(expected),
                "{label}: expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn acceptance_rejects_ambiguous_repository_keys() {
        let yaml = format!(
            "{}\nrepos:\n  - path: /tmp/one/ensemble\n    branch: main\n  - path: /tmp/two/ensemble\n    branch: main\nacceptance:\n  required_files:\n    - name: file\n      repo: ensemble\n      path: docs/release.md\n",
            minimal_yaml()
        );

        let config = parse_config(&yaml).unwrap();
        let error = validate_config(&config).unwrap_err();

        assert!(error.to_string().contains("found 2"));
    }

    #[test]
    fn parses_acceptance_commands() {
        let yaml = format!(
            "{}\nacceptance:\n  commands:\n    - name: test\n      run: \"  cargo test --workspace  \"\n      timeout_ms: 120000\n",
            minimal_yaml()
        );

        let config = parse_config(&yaml).unwrap();

        assert_eq!(
            config.acceptance.commands,
            vec![AcceptanceCommandConfig {
                name: "test".to_string(),
                run: "  cargo test --workspace  ".to_string(),
                timeout_ms: 120_000,
            }]
        );
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn empty_acceptance_defaults_to_no_commands() {
        let yaml = format!("{}\nacceptance: {{}}\n", minimal_yaml());

        let config = parse_config(&yaml).unwrap();

        assert!(config.acceptance.commands.is_empty());
    }

    #[test]
    fn validates_acceptance_commands() {
        let invalid_cases = [
            ("", "echo ok", 1, "name must not be empty"),
            ("check", "", 1, "run must not be empty"),
            ("check", "echo ok", 0, "timeout_ms must be greater than 0"),
        ];

        for (name, run, timeout_ms, expected_reason) in invalid_cases {
            let expected_name = if name.trim().is_empty() {
                "<unnamed>"
            } else {
                name
            };
            let yaml = format!(
                "{}\nacceptance:\n  commands:\n    - name: {:?}\n      run: {:?}\n      timeout_ms: {}\n",
                minimal_yaml(),
                name,
                run,
                timeout_ms
            );
            let config = parse_config(&yaml).unwrap();
            let error = validate_config(&config).unwrap_err();

            assert!(
                matches!(
                    error,
                    PipelineError::InvalidAcceptanceCommand { ref name, ref reason }
                        if name == expected_name && reason == expected_reason
                ),
                "unexpected error: {error:?}"
            );
        }
    }

    #[test]
    fn duplicate_acceptance_command_names_are_invalid() {
        let yaml = format!(
            "{}\nacceptance:\n  commands:\n    - name: test\n      run: cargo test\n      timeout_ms: 1000\n    - name: test\n      run: cargo test --doc\n      timeout_ms: 1000\n",
            minimal_yaml()
        );
        let config = parse_config(&yaml).unwrap();

        let error = validate_config(&config).unwrap_err();

        assert!(matches!(
            error,
            PipelineError::InvalidAcceptanceCommand { ref name, ref reason }
                if name == "test" && reason == "name must be unique"
        ));
    }

    #[test]
    fn parses_step_approval_config_from_yaml() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  plan:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Plan the work."
steps:
  - name: plan
    agent: plan
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let approval = config.steps[0].approval.as_ref().unwrap();
        assert_eq!(approval.mode, StepApprovalMode::WhenRequestedByAgent);
        assert_eq!(approval.state.as_deref(), Some("Plan Review"));
    }

    #[test]
    fn defaults_step_approval_to_none() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  plan:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Plan the work."
steps:
  - name: plan
    agent: plan
    tracker_state: Planning
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert!(config.steps[0].approval.is_none());
    }

    #[test]
    fn test_parse_full_config() {
        let yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: $GITHUB_TOKEN
  project_number: 42
  github:
    status_field: Status
  active_states:
    - In Progress
    - Review
  terminal_states:
    - Done
    - Cancelled
  labels_filter:
    - agent-ready
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
  review:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Review the build output."
steps:
  - name: build
    agent: build
    tracker_state: Building
  - name: review
    agent: review
    depends:
      - build
    tracker_state: Review
concurrency:
  max_concurrent_agents: 8
  max_step_parallelism: 4
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.tracker.kind, "github");
        assert_eq!(config.tracker.repository.as_deref(), Some("acme/repo"));
        assert_eq!(config.tracker.project_number, Some(42));
        assert_eq!(config.tracker.labels_filter, vec!["agent-ready"]);
        assert_eq!(config.tracker.active_states, vec!["In Progress", "Review"]);
        assert_eq!(config.tracker.terminal_states, vec!["Done", "Cancelled"]);
        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.contains_key("build"));
        assert!(config.agents.contains_key("review"));
        assert_eq!(config.steps.len(), 2);
        assert_eq!(config.steps[1].depends, Some(vec!["build".to_string()]));
        assert_eq!(config.steps[1].tracker_state.as_deref(), Some("Review"));
        assert_eq!(config.concurrency.max_concurrent_agents, 8);
        assert_eq!(config.concurrency.max_step_parallelism, 4);
    }

    #[test]
    fn parses_github_project_field_configuration_without_priority() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  project_number: 7\n  github:\n    status_field: Delivery state",
            1,
        );

        let config = parse_config(&yaml).unwrap();
        let github = config.tracker.github.as_ref().unwrap();
        assert_eq!(github.status_field, "Delivery state");
        assert!(github.priority.is_none());
    }

    #[test]
    fn parses_github_project_field_configuration_with_ordered_priority_options() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  project_number: 7\n  github:\n    status_field: Delivery state\n    priority:\n      field: Customer impact\n      options: [Critical, Elevated, Normal]",
            1,
        );

        let config = parse_config(&yaml).unwrap();
        let priority = config.tracker.github.unwrap().priority.unwrap();
        assert_eq!(priority.field, "Customer impact");
        assert_eq!(priority.options, ["Critical", "Elevated", "Normal"]);
    }

    #[test]
    fn parses_opt_in_github_ownership_with_arbitrary_vocabulary() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  project_number: 7\n  github:\n    status_field: Delivery state\n    ownership:\n      claim:\n        claimed_state: Agent-owned\n        resume_states: [Agent-owned, Resuming]\n      delivery_adoption:\n        repository: acme/repo\n        base_branch: release/2026\n        branch_template: agent/{issue_workspace_key}\n        require_authenticated_author: true",
            1,
        );

        let config = parse_config(&yaml).unwrap();
        let ownership = config.tracker.github.unwrap().ownership.unwrap();
        assert_eq!(ownership.claim.unwrap().claimed_state, "Agent-owned");
        assert_eq!(
            ownership.delivery_adoption.unwrap().branch_template,
            "agent/{issue_workspace_key}"
        );
    }

    #[test]
    fn rejects_invalid_github_ownership_policy_before_activation() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  project_number: 7\n  github:\n    status_field: Delivery state\n    ownership:\n      claim:\n        claimed_state: ' '\n        resume_states: []\n      delivery_adoption:\n        repository: acme/repo\n        base_branch: main\n        branch_template: agent/no-key",
            1,
        );

        let error = parse_config(&yaml).unwrap_err();
        assert!(error.to_string().contains("tracker.github.ownership.claim"));
    }

    #[test]
    fn claimed_state_must_be_recoverable_before_the_first_journal_append() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  github:\n    status_field: Status\n    ownership:\n      claim:\n        claimed_state: Agent-owned\n        resume_states: [Recovering]",
            1,
        );

        let error = parse_config(&yaml).unwrap_err();
        assert!(error.to_string().contains("must include claimed_state"));
    }

    #[test]
    fn rejects_blank_or_invalid_github_delivery_adoption_fields() {
        for policy in [
            "repository: ' '\n        base_branch: main\n        branch_template: agent/{issue_workspace_key}",
            "repository: acme/repo\n        base_branch: ' '\n        branch_template: agent/{issue_workspace_key}",
            "repository: acme/repo\n        base_branch: main\n        branch_template: agent/no-key",
            "repository: acme/repo\n        base_branch: main\n        branch_template: agent/{issue_workspace_key}..lock",
        ] {
            let yaml = minimal_yaml().replacen(
                "kind: todo_file\n  path: TODO.md",
                &format!(
                    "kind: github\n  repository: acme/repo\n  github:\n    status_field: Delivery state\n    ownership:\n      delivery_adoption:\n        {policy}"
                ),
                1,
            );

            let error = parse_config(&yaml).unwrap_err();
            assert!(error
                .to_string()
                .contains("tracker.github.ownership.delivery_adoption"));
        }
    }

    #[test]
    fn git_branch_validation_rejects_invalid_components_and_controls() {
        for invalid in [
            "@",
            "agent//issue",
            "agent/.hidden",
            "agent/topic.lock/child",
            "agent/issue\u{7f}",
        ] {
            assert!(!valid_rendered_branch(invalid), "accepted {invalid:?}");
        }
        assert!(valid_rendered_branch("agent/release-2026.08/issue_1"));
    }

    #[test]
    fn rejects_github_project_configuration_without_status_field() {
        let yaml = minimal_yaml().replacen(
            "kind: todo_file\n  path: TODO.md",
            "kind: github\n  repository: acme/repo\n  project_number: 7",
            1,
        );

        let error = parse_config(&yaml).unwrap_err();
        assert!(error.to_string().contains("tracker.github.status_field"));
    }

    #[test]
    fn test_parse_notion_tracker_config_with_defaults_and_overrides() {
        let yaml = r#"
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
    enabled_property: Ready to Implement
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();
        assert_eq!(config.tracker.kind, "notion");
        let notion = config.tracker.notion.as_ref().unwrap();
        assert_eq!(
            notion.database_id.as_deref(),
            Some("deadbeefdeadbeefdeadbeefdeadbeef")
        );
        assert_eq!(notion.status_property, "Status");
        assert_eq!(notion.title_property, "Name");
        assert_eq!(notion.enabled_property, "Ready to Implement");
        assert!(notion.enabled_value_bool);
    }

    #[test]
    fn test_parse_notion_tracker_config_namespaced_values() {
        let yaml = r#"
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    database_id: cafebabecafebabecafebabecafebabe
    version: "2022-06-28"
    title_property: "Task Name"
    status_property: "Workflow"
    enabled_property: "Ready"
    enabled_value_bool: true
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();
        let notion = config.tracker.notion.as_ref().unwrap();
        assert_eq!(
            notion.database_id.as_deref(),
            Some("cafebabecafebabecafebabecafebabe")
        );
        assert_eq!(notion.version, "2022-06-28");
        assert_eq!(notion.title_property, "Task Name");
        assert_eq!(notion.status_property, "Workflow");
        assert_eq!(notion.enabled_property, "Ready");
        assert!(notion.enabled_value_bool);
    }

    #[test]
    fn test_parse_rejects_legacy_flat_notion_keys() {
        let yaml = r#"
tracker:
  kind: notion
  api_key: legacy-api-key
  database_id: legacy-db
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let result = parse_config(yaml);
        assert!(result.is_err());
        let error = result.unwrap_err().to_string();
        assert!(error.contains("legacy Notion tracker keys"));
    }

    #[test]
    fn test_parse_rejects_legacy_flat_notion_api_key_for_notion_kind() {
        let yaml = r#"
tracker:
  kind: notion
  api_key: legacy-api-key
  notion:
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let result = parse_config(yaml);
        assert!(result.is_err());
        let error = result.unwrap_err().to_string();
        assert!(error.contains("legacy Notion tracker keys"));
        assert!(error.contains("api_key"));
    }

    #[test]
    fn test_notion_api_key_not_serialized() {
        let yaml = r#"
tracker:
  kind: notion
  notion:
    api_key: secret-notion-token
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("secret-notion-token"));
        assert!(!serialized.contains("\"api_key\""));
    }

    #[test]
    fn test_tracker_debug_redacts_notion_api_key() {
        let yaml = r#"
tracker:
  kind: notion
  notion:
    api_key: secret-notion-token
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();
        let debug = format!("{:?}", config.tracker);
        assert!(!debug.contains("secret-notion-token"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn test_parse_step_timeout_ms() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: claude-opus-4-6
    prompt: Build it
steps:
  - name: build
    agent: builder
    timeout_ms: 120000
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();

        assert_eq!(config.steps[0].timeout_ms, Some(120_000));
    }

    #[test]
    fn test_parse_step_timeout_ms_defaults_to_none() {
        let config = parse_config(&minimal_yaml()).unwrap();

        assert_eq!(config.steps[0].timeout_ms, None);
    }

    #[test]
    fn test_step_timeout_ms_zero_is_invalid() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: claude-opus-4-6
    prompt: Build it
steps:
  - name: build
    agent: builder
    timeout_ms: 0
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).unwrap();
        let error = validate_config(&config).unwrap_err();

        assert!(matches!(
            error,
            PipelineError::InvalidStepConfig { ref step, ref reason }
                if step == "build" && reason == "timeout_ms must be greater than 0"
        ));
    }

    #[test]
    fn test_validate_invalid_prompt_config() {
        // Agent with neither prompt nor prompt_template
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPromptConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_invalid_prompt_config_both() {
        // Agent with both prompt and prompt_template
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
    prompt_template: build.md
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPromptConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_unknown_agent_reference() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: review
    agent: review_agent
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::UnknownAgent { name } => {
                assert_eq!(name, "review_agent");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn validate_fixup_on_failure_requires_fixup_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: build
    agent: build
    on_failure: fixup
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);

        assert!(
            matches!(
                result,
                Err(PipelineError::InvalidStepConfig { ref step, ref reason })
                    if step == "build" && reason == "on_failure: fixup requires fixup_agent"
            ),
            "expected InvalidStepConfig, got {result:?}"
        );
    }

    #[test]
    fn validate_fixup_on_failure_rejects_unknown_fixup_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: build
    agent: build
    on_failure: fixup
    fixup_agent: fixer
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);

        assert!(
            matches!(result, Err(PipelineError::UnknownAgent { ref name }) if name == "fixer"),
            "expected UnknownAgent, got {result:?}"
        );
    }

    #[test]
    fn test_defaults_applied() {
        let config = parse_config(minimal_yaml()).unwrap();

        // ConcurrencyConfig defaults
        assert_eq!(config.concurrency.max_concurrent_agents, 4);
        assert_eq!(config.concurrency.max_step_parallelism, 2);

        // max_cycles default
        assert_eq!(config.max_cycles, 3);

        // PollingConfig defaults
        assert_eq!(config.polling.interval_ms, 30_000);

        // WorkspaceConfig defaults
        assert!(config.workspace.root.is_none());

        // HooksConfig defaults
        assert!(config.hooks.after_create.is_none());
        assert!(config.hooks.before_run.is_none());
        assert!(config.hooks.after_run.is_none());
        assert!(config.hooks.before_remove.is_none());
        assert_eq!(config.hooks.timeout_ms, 60_000);

        // AgentRuntimeConfig defaults
        assert_eq!(config.agent.max_retry_backoff_ms, 300_000);
        assert_eq!(config.agent.command, "claude-code");
        assert_eq!(config.agent.session_mode, "code");
        assert_eq!(
            config.agent.permission_request_policy,
            PermissionRequestPolicy::approve_all()
        );
        assert_eq!(config.agent.turn_timeout_ms, 3_600_000);
        assert_eq!(config.agent.read_timeout_ms, 5_000);
        assert_eq!(config.agent.stall_timeout_ms, 300_000);
        assert!(config.agent.inject_interaction_policy_instructions);
        assert!(config.agent.interaction_policy_text.is_none());
        assert!(config.agent.interaction_policy_overrides.agents.is_empty());
        assert!(config.agent.interaction_policy_overrides.steps.is_empty());
        assert!(config.agent.max_concurrent_agents_by_state.is_empty());

        // TrackerConfig defaults
        assert_eq!(config.tracker.active_states, vec!["Todo", "In Progress"]);
        assert_eq!(config.tracker.terminal_states, vec!["Done", "Closed"]);
        assert!(config.tracker.labels_filter.is_empty());

        // HumanInteractionConfig defaults
        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn max_concurrent_agents_by_state_normalizes_configured_states() {
        let yaml = format!(
            "{}\nagent:\n  max_concurrent_agents_by_state:\n    ' Todo ': 2\n    IN PROGRESS: 3\n",
            minimal_yaml()
        );

        let config = parse_config(&yaml).unwrap();

        assert_eq!(config.agent.max_concurrent_agents_by_state["todo"], 2);
        assert_eq!(
            config.agent.max_concurrent_agents_by_state["in progress"],
            3
        );
    }

    #[test]
    fn max_concurrent_agents_by_state_rejects_invalid_entries_precisely() {
        for (entries, offending) in [
            ("    '   ': 1\n", "blank"),
            ("    Todo: 0\n", "Todo"),
            ("    Todo: -1\n", "Todo"),
            ("    Todo: many\n", "Todo"),
            ("    Todo: 1\n    ' todo ': 2\n", "todo"),
        ] {
            let yaml = format!(
                "{}\nagent:\n  max_concurrent_agents_by_state:\n{entries}",
                minimal_yaml()
            );

            let error = parse_config(&yaml).expect_err("invalid state cap must be rejected");
            let message = error.to_string();

            assert!(
                message.contains("agent.max_concurrent_agents_by_state"),
                "missing field path in {message:?}"
            );
            assert!(
                message.to_lowercase().contains(&offending.to_lowercase()),
                "missing offending entry {offending:?} in {message:?}"
            );
        }
    }

    #[test]
    fn rejects_unsupported_agent_max_turns() {
        let yaml = format!("{}\nagent:\n  max_turns: 20\n", minimal_yaml());

        let error = parse_config(&yaml).unwrap_err();

        assert!(matches!(
            error,
            crate::error::ConfigError::ConfigParseError { reason }
                if reason.contains("agent.max_turns") && reason.contains("no longer supported")
        ));
    }

    #[test]
    fn parses_human_interaction_defaults() {
        let config = parse_config(minimal_yaml()).unwrap();

        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn step_config_defaults_on_failure_to_retry_issue() {
        let config = parse_config(minimal_yaml()).unwrap();
        let step = config.steps.first().unwrap();

        assert_eq!(step.on_failure, OnFailure::RetryIssue);
        assert_eq!(step.fixup_agent, None);
    }

    #[test]
    fn parses_on_failure_values_from_snake_case_yaml() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
  fix:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Fix the thing."
steps:
  - name: retry-issue
    agent: build
    on_failure: retry_issue
  - name: retry-step
    agent: build
    on_failure: retry_step
  - name: fixup
    agent: build
    on_failure: fixup
    fixup_agent: fix
  - name: halt
    agent: build
    on_failure: halt
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let values: Vec<OnFailure> = config.steps.iter().map(|step| step.on_failure).collect();

        assert_eq!(
            values,
            vec![
                OnFailure::RetryIssue,
                OnFailure::RetryStep,
                OnFailure::Fixup,
                OnFailure::Halt
            ]
        );
    }

    #[test]
    fn parses_manual_resume_mode_from_yaml() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
human_interaction:
  enabled: true
  default_resume_mode: manual
"#;

        let config = parse_config(yaml).unwrap();

        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn parses_interaction_policy_overrides() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
agent:
  inject_interaction_policy_instructions: true
  interaction_policy_text: "Global policy"
  interaction_policy_overrides:
    agents:
      build:
        mode: custom
        text: "Agent policy"
    steps:
      build:
        mode: off
"#;

        let config = parse_config(yaml).unwrap();
        assert!(config.agent.inject_interaction_policy_instructions);
        assert_eq!(
            config.agent.interaction_policy_text.as_deref(),
            Some("Global policy")
        );

        let agent_override = config
            .agent
            .interaction_policy_overrides
            .agents
            .get("build")
            .expect("agent override should exist");
        assert_eq!(agent_override.mode, InteractionPolicyOverrideMode::Custom);
        assert_eq!(agent_override.text.as_deref(), Some("Agent policy"));

        let step_override = config
            .agent
            .interaction_policy_overrides
            .steps
            .get("build")
            .expect("step override should exist");
        assert_eq!(step_override.mode, InteractionPolicyOverrideMode::Off);
        assert_eq!(step_override.text, None);
    }

    #[test]
    fn default_workspace_root_uses_temp_dir_ensemble_workspaces() {
        let expected = std::env::temp_dir()
            .join("ensemble_workspaces")
            .display()
            .to_string();

        assert_eq!(default_workspace_root(), expected);
    }

    #[test]
    fn env_guard_restores_tracked_vars() {
        let guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("GITHUB_TOKEN", "before");
        let saved = vec![("GITHUB_TOKEN", std::env::var("GITHUB_TOKEN").ok())];

        {
            let _env = EnvGuard {
                _guard: guard,
                saved,
            };
            std::env::remove_var("GITHUB_TOKEN");
            assert!(std::env::var("GITHUB_TOKEN").is_err());
            std::env::set_var("GITHUB_TOKEN", "during");
        }

        assert_eq!(std::env::var("GITHUB_TOKEN").as_deref(), Ok("before"));
        std::env::remove_var("GITHUB_TOKEN");
    }

    #[test]
    fn test_load_config_missing_file() {
        let result = load_config(std::path::Path::new("/nonexistent/ensemble.yaml"));
        assert!(result.is_err());
        match result.unwrap_err() {
            crate::error::ConfigError::MissingConfigFile { path } => {
                assert!(path.contains("ensemble.yaml"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn resolve_relative_to_base_joins_relative_paths() {
        let resolved =
            resolve_relative_to_base(Path::new("tracker/issues.md"), Path::new("/tmp/config"));

        assert_eq!(resolved, PathBuf::from("/tmp/config/tracker/issues.md"));
    }

    #[test]
    fn resolve_relative_to_base_preserves_absolute_paths() {
        let resolved =
            resolve_relative_to_base(Path::new("/tmp/already-absolute"), Path::new("/tmp/config"));

        assert_eq!(resolved, PathBuf::from("/tmp/already-absolute"));
    }

    #[test]
    fn test_load_config_preserves_non_not_found_read_errors() {
        let dir = tempfile::tempdir().unwrap();

        let result = load_config(dir.path());

        assert!(result.is_err());
        match result.unwrap_err() {
            crate::error::ConfigError::ConfigReadError { path, reason } => {
                assert_eq!(path, dir.path().display().to_string());
                assert!(!reason.is_empty());
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_load_config_from_file() {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "{}", minimal_yaml()).unwrap();
        let config = load_config(tmp.path()).unwrap();
        assert_eq!(config.tracker.kind, "todo_file");
    }

    #[test]
    fn test_validate_duplicate_step_names() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: build
    agent: build
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(matches!(
            result,
            Err(PipelineError::DuplicateStepName { .. })
        ));
    }

    #[test]
    fn test_resolve_env_api_key() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_TEST_KEY_2B", "secret123");
        let yaml = r#"
tracker:
  kind: github
  api_key: $ENSEMBLE_TEST_KEY_2B
  repository: acme/repo
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.tracker.api_key.as_deref(), Some("secret123"));
        std::env::remove_var("ENSEMBLE_TEST_KEY_2B");
    }

    #[test]
    fn test_resolve_env_empty_var_is_none() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_EMPTY_2B", "");
        let yaml = r#"
tracker:
  kind: github
  api_key: $ENSEMBLE_EMPTY_2B
  repository: acme/repo
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.tracker.api_key, None);
        std::env::remove_var("ENSEMBLE_EMPTY_2B");
    }

    #[test]
    fn test_resolve_tilde_in_path() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: ~/my_todos.md
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            config.tracker.path.unwrap(),
            PathBuf::from(home).join("my_todos.md")
        );
    }

    #[test]
    fn test_parse_config_with_repos() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
repos:
  - path: /tmp/repo-a
    branch: main
  - path: /tmp/repo-b
    branch: develop
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.repos.len(), 2);
        assert_eq!(config.repos[0].path, "/tmp/repo-a");
        assert_eq!(config.repos[0].branch, "main");
        assert_eq!(config.repos[1].path, "/tmp/repo-b");
        assert_eq!(config.repos[1].branch, "develop");
    }

    #[test]
    fn test_parse_config_with_reasoning_level() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    model: sonnet
    reasoning_level: high
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.reasoning_level.as_deref(), Some("high"));
    }

    #[test]
    fn test_parse_config_with_permission_mode() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.permission_mode.as_deref(), Some("approve_reads"));
        assert_eq!(
            config.agent.permission_request_policy,
            PermissionRequestPolicy::approve_all()
        );
    }

    #[test]
    fn test_parse_config_with_permission_request_policy() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: reject_all
"#;
        let config = parse_config(yaml).unwrap();
        assert!(config.agents["builder"].permission_mode.is_none());
        assert_eq!(
            config.agent.permission_request_policy,
            PermissionRequestPolicy::reject_all()
        );
    }

    #[test]
    fn test_parse_config_with_approve_all_permission_request_policy() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: "Review it."
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: approve_all
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(
            config.agent.permission_request_policy,
            PermissionRequestPolicy::approve_all()
        );
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_parse_config_with_select_option_permission_request_policy() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: "Review it."
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(
            config.agent.permission_request_policy,
            PermissionRequestPolicy::select_option("allow_always")
        );
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn select_option_permission_request_policy_requires_option_id() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_request_policy:
    mode: select_option
    option_id: ""
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let err = validate_config(&config).unwrap_err();
        assert!(err.to_string().contains("option_id"));
    }

    #[test]
    fn legacy_string_permission_request_policy_is_rejected() {
        let error = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_request_policy: auto_approve_all
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("permission_request_policy"));
    }

    #[test]
    fn legacy_permission_policy_key_is_rejected() {
        let error = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_policy:
    mode: approve_all
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("permission_policy"));
    }

    #[test]
    fn acpx_agent_defaults_runtime_to_acpx() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        assert_eq!(config.agents["builder"].runtime.as_deref(), None);
        assert_eq!(
            RuntimeKind::for_agent(&config.agents["builder"]),
            RuntimeKind::Acpx
        );
    }

    #[test]
    fn permission_request_policy_is_rejected_for_acpx_runtime_override() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    runtime: acpx
    prompt: hi
agent:
  permission_request_policy:
    mode: reject_all
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let err = validate_config(&config).unwrap_err();
        assert!(err.to_string().contains("permission_request_policy"));
    }

    #[test]
    fn permission_request_policy_is_allowed_for_mixed_runtime_configs() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hello
agent:
  permission_request_policy:
    mode: reject_all
steps:
  - name: build
    agent: builder
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_parse_config_repos_defaults_to_empty() {
        let config = parse_config(minimal_yaml()).unwrap();
        assert!(config.repos.is_empty());
    }

    #[test]
    fn test_parse_config_with_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
  reviewer:
    executor: custom-agent
    model: gpt-4
    prompt: "Review it."
steps:
  - name: build
    agent: builder
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.acpx_agent.as_deref(), Some("claude"));
        assert!(builder.executor.is_none());
        assert!(builder.model.is_none());

        let reviewer = &config.agents["reviewer"];
        assert!(reviewer.acpx_agent.is_none());
        assert_eq!(reviewer.executor.as_deref(), Some("custom-agent"));
        assert_eq!(reviewer.model.as_deref(), Some("gpt-4"));
    }

    #[test]
    fn test_validate_acpx_agent_with_prompt_template() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_permission_mode_requires_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: sonnet-4
    permission_mode: approve_all
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("requires acpx_agent"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_permission_mode_rejects_unknown_value() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: maybe
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("unsupported value 'maybe'"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_permission_mode_accepts_valid_value_for_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_permission_mode_rejects_direct_runtime_override() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    runtime: direct
    acpx_agent: claude
    executor: claude-code
    model: sonnet-4
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("acpx runtime"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_permission_mode_exposes_acpx_flags() {
        assert_eq!(
            PermissionMode::parse("approve_all"),
            Some(PermissionMode::ApproveAll)
        );
        assert_eq!(
            PermissionMode::parse("approve_reads"),
            Some(PermissionMode::ApproveReads)
        );
        assert_eq!(
            PermissionMode::parse("deny_all"),
            Some(PermissionMode::DenyAll)
        );
        assert_eq!(PermissionMode::parse("nope"), None);

        assert_eq!(PermissionMode::ApproveAll.acpx_flag(), "--approve-all");
        assert_eq!(PermissionMode::ApproveReads.acpx_flag(), "--approve-reads");
        assert_eq!(PermissionMode::DenyAll.acpx_flag(), "--deny-all");
    }

    #[test]
    fn test_resolve_tilde_in_workspace_root() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
workspace:
  root: ~/workspaces
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        let expected = format!("{}/workspaces", home);
        assert_eq!(config.workspace.root.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn test_validate_agent_requires_acpx_or_executor_model() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidAgentConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_validate_agent_with_only_executor() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidAgentConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_resolve_env_repos_path() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_TEST_REPO", "/test/repo");
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: $ENSEMBLE_TEST_REPO
    branch: main
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.repos[0].path, "/test/repo");
        std::env::remove_var("ENSEMBLE_TEST_REPO");
    }

    #[test]
    fn test_resolve_tilde_in_repos_path() {
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: ~/projects/myrepo
    branch: main
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(config.repos[0].path, format!("{}/projects/myrepo", home));
    }

    #[test]
    fn test_load_config_rebases_relative_paths_from_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("templates")).unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: todo_file
repos:
  - path: repos/app
    branch: main
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
workspace:
  root: workspaces
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(
            config.agents["builder"].prompt_template.as_deref(),
            Some(dir.path().join("templates/implement.liquid").as_path())
        );
        assert_eq!(
            config.repos[0].path,
            dir.path().join("repos/app").display().to_string()
        );
        assert_eq!(
            config.workspace.root.as_deref(),
            Some(dir.path().join("workspaces").display().to_string().as_str())
        );
    }

    #[test]
    fn test_load_config_defaults_todo_tracker_path_to_home_state_path() {
        let dir = tempfile::tempdir().unwrap();
        // Write a minimal config without tracker.path
        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert!(config
            .tracker
            .path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .contains("ensemble/TODO.md"));
    }

    #[test]
    fn test_load_config_loads_sibling_dotenv_without_overriding_existing_env() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "GITHUB_TOKEN=from-dotenv\n").unwrap();
        std::env::set_var("GITHUB_TOKEN", "from-process");

        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: $GITHUB_TOKEN
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        // Process env var should take precedence over .env
        assert_eq!(config.tracker.api_key.as_deref(), Some("from-process"));

        std::env::remove_var("GITHUB_TOKEN");
    }

    #[test]
    fn test_load_config_uses_sibling_dotenv_without_mutating_process_env() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "GITHUB_TOKEN=from-dotenv\n").unwrap();
        std::env::remove_var("GITHUB_TOKEN");

        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: github
  repository: acme/repo
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(config.tracker.api_key.as_deref(), Some("from-dotenv"));
        assert!(std::env::var("GITHUB_TOKEN").is_err());
    }

    #[test]
    fn test_resolve_env_does_not_fallback_to_github_token_for_non_github_tracker() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("GITHUB_TOKEN", "from-process");
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();

        assert_eq!(config.tracker.api_key, None);
        std::env::remove_var("GITHUB_TOKEN");
    }

    #[test]
    fn parses_repo_finalize_defaults() {
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: /tmp/repo
    branch: main
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).expect("config should parse");
        let finalize = &config.repos[0].finalize;
        assert!(finalize.enabled);
        assert_eq!(
            finalize.mode,
            crate::workspace::finalize::FinalizeMode::None
        );
        assert!(!finalize.approval_required);
    }

    #[test]
    fn parses_repo_finalize_explicit_values() {
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: /tmp/repo
    branch: main
    finalize:
      enabled: true
      mode: push_and_pr
      approval_required: true
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

        let config = parse_config(yaml).expect("config should parse");
        let finalize = &config.repos[0].finalize;
        assert!(finalize.enabled);
        assert_eq!(
            finalize.mode,
            crate::workspace::finalize::FinalizeMode::PushAndPr
        );
        assert!(finalize.approval_required);
    }

    #[test]
    fn test_step_kind_defaults_to_agent() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        assert_eq!(config.steps[0].kind, StepKind::Agent);
    }

    #[test]
    fn test_parse_synthesis_step_kind() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
  synthesizer:
    acpx_agent: claude
    prompt: "Merge dependency outputs."
steps:
  - name: build
    agent: builder
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [build]
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        assert_eq!(config.steps[1].kind, StepKind::Synthesis);
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_synthesis_step_requires_explicit_dependencies() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  synth:
    acpx_agent: claude
    prompt: "Merge dependency outputs."
steps:
  - name: synthesize
    kind: synthesis
    agent: synth
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let err = validate_config(&config).unwrap_err();
        assert!(matches!(
            err,
            PipelineError::InvalidSynthesisStep { step, reason }
                if step == "synthesize" && reason.contains("explicit non-empty depends")
        ));
    }
}
