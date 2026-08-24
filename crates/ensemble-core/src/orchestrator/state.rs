use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use tracing::trace;

use crate::interaction::model::InteractionKind;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::config::ensemble::{ConcurrencyConfig, EnsembleConfig};
use crate::history::artifacts::RunArtifacts;
use crate::orchestrator::delivery::DeliveryRecord;
use crate::orchestrator::pipeline_journal::PendingTerminalTransition;
use crate::pipeline::engine::{PipelineRun, RouteSkipProvenance, StepState};
use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};

/// Runtime state of an individual step within a pipeline run.
/// Tracks the step's progress through its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepRunState {
    Pending,
    Running,
    WaitingOnDependency,
    WaitingForHuman { ask_id: String },
    Paused,
    Completed,
    Failed,
}

/// Issue currently blocked waiting for a human response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitingOnHumanEntry {
    pub issue_id: String,
    pub identifier: String,
    pub interaction_request_id: String,
    pub step_name: String,
    #[serde(default)]
    pub kind: InteractionKind,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub agent_name: String,
    pub retry_attempt: Option<u32>,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub agent_input_tokens: u64,
    #[serde(default)]
    pub agent_output_tokens: u64,
    #[serde(default)]
    pub agent_total_tokens: u64,
    pub requested_at: DateTime<Utc>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub issue: Option<Issue>,
}

/// A retained run whose configured automatic recovery bound was reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParkedRunEntry {
    pub issue_id: String,
    pub identifier: String,
    pub condition_key: String,
    pub attempt: u32,
    pub reason: String,
    pub parked_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CompletedEntry {
    pub issue_id: String,
    pub identifier: String,
    pub run_id: Option<String>,
    pub issue: Issue,
    pub status: String,
    pub workflow_steps: Vec<CompletedWorkflowStep>,
    pub completed_at: DateTime<Utc>,
    pub outcome_summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletedWorkflowStep {
    pub name: String,
    pub agent: String,
    pub kind: String,
    pub dependencies: Vec<String>,
    pub state: String,
    pub can_navigate: bool,
    pub route_provenance: Option<Vec<RouteSkipProvenance>>,
}

/// Rate limit snapshot from agent events.
#[derive(Debug, Clone, Default, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RateLimitSnapshot {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeStatus {
    NotRequired,
    PendingApproval,
    InProgress,
    Succeeded,
    Failed,
    SkippedHeadless,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RepoFinalizeState {
    pub repo: String,
    pub mode: String,
    pub approval_required: bool,
    pub status: FinalizeStatus,
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<crate::orchestrator::delivery_observation::DeliveryObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct IssueFinalizeState {
    pub issue_identifier: String,
    pub status: FinalizeStatus,
    pub repos: Vec<RepoFinalizeState>,
}

#[derive(Debug, Clone)]
pub struct PendingTerminalEntry {
    pub identifier: String,
    pub run_id: Option<String>,
    pub issue: Option<Issue>,
    pub transition: PendingTerminalTransition,
}

/// The single authoritative in-memory state owned by the orchestrator.
/// All state mutations are serialized through the orchestrator's event loop.
#[derive(Debug)]
pub struct OrchestratorState {
    /// Current effective poll interval.
    pub poll_interval_ms: u64,
    /// Current effective global concurrency limit.
    pub max_concurrent_agents: u32,
    /// Running sessions: issue_id -> RunningEntry.
    pub running: HashMap<String, RunningEntry>,
    /// Claimed issue IDs (reserved/running/retrying).
    pub claimed: HashSet<String>,
    /// Pending retries: issue_id -> RetryEntry.
    pub retry_attempts: HashMap<String, RetryEntry>,
    /// Issues blocked waiting for a human response: issue_id -> waiting entry.
    pub waiting_on_human: HashMap<String, WaitingOnHumanEntry>,
    /// Retained runs that need fresh external evidence before they are requeued.
    pub parked_runs: HashMap<String, ParkedRunEntry>,
    /// Explicit resume requests queued by the API/UI: issue IDs.
    pub resume_requested: HashSet<String>,
    /// Completed issues: issue_id -> CompletedEntry.
    pub completed: HashMap<String, CompletedEntry>,
    /// Seconds to keep completed entries before expiry.
    pub completed_expiry_secs: u64,
    /// Aggregate token counts and runtime seconds.
    pub agent_totals: AgentTotals,
    /// Latest rate limit snapshot from agent events.
    pub agent_rate_limits: Option<RateLimitSnapshot>,
    /// Active pipeline runs: issue_id -> PipelineRun.
    pub pipeline_runs: HashMap<String, PipelineRun>,
    /// Finalization state for issues that have finished pipeline execution.
    pub finalize: HashMap<String, IssueFinalizeState>,
    /// Completion history retained while an initial delivery owner is retried.
    pub(crate) finalize_terminal_history: HashMap<String, crate::history::model::HistoryRecord>,
    /// Durable remote-publication owners that no longer consume worker capacity.
    pub(crate) delivery: HashMap<String, DeliveryRecord>,
    /// Terminal tracker writes that must reconcile before local run release.
    pub pending_terminal_transitions: HashMap<String, PendingTerminalEntry>,
    /// Durable run artifacts collected before history is written.
    pub artifacts: HashMap<String, RunArtifacts>,
    /// Immutable config snapshot for each active pipeline run.
    pub pipeline_configs: HashMap<String, std::sync::Arc<EnsembleConfig>>,
    /// Timestamp of the last orchestrator poll tick.
    pub last_tick_at: Option<DateTime<Utc>>,
    /// Cached lowercase active states for efficient dispatch checking.
    pub active_states_lower: Vec<String>,
    /// Cached lowercase terminal states for efficient dispatch checking.
    pub terminal_states_lower: Vec<String>,
    /// Per-run sequence counters for persisted timeline events.
    pub timeline_sequences: HashMap<String, u64>,
    /// Stable run IDs per issue across retries within the same orchestration cycle.
    pub issue_run_ids: HashMap<String, String>,
    /// Per-step runtime states: issue_id -> (step_name -> StepRunState).
    pub step_states: HashMap<String, HashMap<String, StepRunState>>,
}

static ORCH_RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn new_issue_run_id() -> String {
    let issued_at_ms = Utc::now().timestamp_millis();
    let counter = ORCH_RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run-{issued_at_ms}-{counter}")
}

impl OrchestratorState {
    /// Create a new OrchestratorState with the given config values.
    pub fn new(poll_interval_ms: u64, config: &ConcurrencyConfig) -> Self {
        Self {
            poll_interval_ms,
            max_concurrent_agents: config.max_concurrent_agents,
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            waiting_on_human: HashMap::new(),
            parked_runs: HashMap::new(),
            resume_requested: HashSet::new(),
            completed: HashMap::new(),
            completed_expiry_secs: config.completed_expiry_secs,
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
            pipeline_runs: HashMap::new(),
            finalize: HashMap::new(),
            finalize_terminal_history: HashMap::new(),
            delivery: HashMap::new(),
            pending_terminal_transitions: HashMap::new(),
            artifacts: HashMap::new(),
            pipeline_configs: HashMap::new(),
            last_tick_at: None,
            active_states_lower: Vec::new(),
            terminal_states_lower: Vec::new(),
            timeline_sequences: HashMap::new(),
            issue_run_ids: HashMap::new(),
            step_states: HashMap::new(),
        }
    }

    /// Initialize the cached lowercase state lists from config.
    pub fn init_state_lists(&mut self, config: &EnsembleConfig) {
        self.active_states_lower = config
            .tracker
            .active_states
            .iter()
            .map(|s| s.to_lowercase())
            .collect();
        self.terminal_states_lower = config
            .tracker
            .terminal_states
            .iter()
            .map(|s| s.to_lowercase())
            .collect();
    }

    /// Add a running entry for a dispatched issue.
    pub fn add_running(&mut self, issue: &Issue, attempt: Option<u32>) {
        let run_id = self
            .issue_run_ids
            .entry(issue.id.clone())
            .or_insert_with(new_issue_run_id)
            .clone();
        let entry = RunningEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            run_id: Some(run_id),
            issue: issue.clone(),
            session_id: None,
            agent_pid: None,
            last_agent_event: None,
            last_agent_timestamp: None,
            last_agent_message: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            last_reported_input_tokens: 0,
            last_reported_output_tokens: 0,
            last_reported_total_tokens: 0,
            turn_count: 0,
            retry_attempt: attempt,
            started_at: Utc::now(),
        };
        self.running.insert(issue.id.clone(), entry);
        self.claimed.insert(issue.id.clone());
        // Remove from retry if present
        self.retry_attempts.remove(&issue.id);
    }

    /// Remove a running entry and return it. Returns None if not found.
    pub fn remove_running(&mut self, issue_id: &str) -> Option<RunningEntry> {
        self.running.remove(issue_id)
    }

    /// Get a reference to a running entry without removing it.
    pub fn get_running(&self, issue_id: &str) -> Option<&RunningEntry> {
        self.running.get(issue_id)
    }

    pub fn next_timeline_sequence(&mut self, run_id: &str) -> u64 {
        let entry = self
            .timeline_sequences
            .entry(run_id.to_string())
            .or_insert(0);
        *entry += 1;
        *entry
    }

    pub fn seed_timeline_sequence(&mut self, run_id: &str, maximum: u64) {
        let entry = self
            .timeline_sequences
            .entry(run_id.to_string())
            .or_insert(maximum);
        *entry = (*entry).max(maximum);
    }

    /// Add an issue ID to the claimed set.
    pub fn add_claimed(&mut self, issue_id: &str) {
        self.claimed.insert(issue_id.to_string());
    }

    /// Remove an issue ID from the claimed set.
    pub fn remove_claimed(&mut self, issue_id: &str) {
        self.claimed.remove(issue_id);
    }

    /// Check if an issue is claimed.
    pub fn is_claimed(&self, issue_id: &str) -> bool {
        self.claimed.contains(issue_id)
    }

    /// Check if an issue is running.
    pub fn is_running(&self, issue_id: &str) -> bool {
        self.running.contains_key(issue_id)
    }

    /// Find the issue ID for a tracker identifier across active control states.
    pub fn find_issue_id_by_identifier(&self, identifier: &str) -> Option<String> {
        for (id, entry) in &self.running {
            if entry.identifier == identifier {
                return Some(id.clone());
            }
        }
        for (id, entry) in &self.retry_attempts {
            if entry.identifier == identifier {
                return Some(id.clone());
            }
        }
        for (id, entry) in &self.waiting_on_human {
            if entry.identifier == identifier {
                return Some(id.clone());
            }
        }
        for (id, delivery) in &self.delivery {
            if delivery.identifier == identifier {
                return Some(id.clone());
            }
        }
        None
    }

    /// Add a retry entry.
    pub fn add_retry(&mut self, entry: RetryEntry) {
        self.claimed.insert(entry.issue_id.clone());
        self.retry_attempts.insert(entry.issue_id.clone(), entry);
    }

    /// Remove a retry entry and return it.
    pub fn remove_retry(&mut self, issue_id: &str) -> Option<RetryEntry> {
        self.retry_attempts.remove(issue_id)
    }

    /// Add or replace a waiting-on-human entry while keeping the issue claimed.
    pub fn add_waiting_on_human(&mut self, entry: WaitingOnHumanEntry) {
        self.claimed.insert(entry.issue_id.clone());
        self.waiting_on_human.insert(entry.issue_id.clone(), entry);
    }

    /// Remove and return a waiting-on-human entry.
    pub fn remove_waiting_on_human(&mut self, issue_id: &str) -> Option<WaitingOnHumanEntry> {
        self.waiting_on_human.remove(issue_id)
    }

    /// Check if an issue is currently waiting on a human response.
    pub fn is_waiting_on_human(&self, issue_id: &str) -> bool {
        self.waiting_on_human.contains_key(issue_id)
    }

    /// Queue an explicit resume request for an issue already waiting on human input.
    pub fn queue_resume(&mut self, issue_id: &str) {
        self.resume_requested.insert(issue_id.to_string());
    }

    /// Remove a queued explicit resume request.
    pub fn clear_resume_request(&mut self, issue_id: &str) {
        self.resume_requested.remove(issue_id);
    }

    /// Check whether an issue has an explicit resume request queued.
    pub fn is_resume_requested(&self, issue_id: &str) -> bool {
        self.resume_requested.contains(issue_id)
    }

    /// Release a claim entirely (remove from claimed, running, and retry).
    pub fn release_claim(&mut self, issue_id: &str) {
        self.claimed.remove(issue_id);
        self.running.remove(issue_id);
        self.retry_attempts.remove(issue_id);
        self.waiting_on_human.remove(issue_id);
        self.parked_runs.remove(issue_id);
        self.resume_requested.remove(issue_id);
        self.pipeline_configs.remove(issue_id);
        self.finalize.remove(issue_id);
        self.finalize_terminal_history.remove(issue_id);
        self.delivery.remove(issue_id);
        self.pending_terminal_transitions.remove(issue_id);
        self.artifacts.remove(issue_id);
        self.step_states.remove(issue_id);
        if let Some(run_id) = self.issue_run_ids.remove(issue_id) {
            self.timeline_sequences.remove(&run_id);
        }
    }

    pub fn set_finalize_state(&mut self, issue_id: &str, finalize: IssueFinalizeState) {
        self.finalize.insert(issue_id.to_string(), finalize);
    }

    pub fn get_finalize_state(&self, issue_id: &str) -> Option<&IssueFinalizeState> {
        self.finalize.get(issue_id)
    }

    pub fn get_finalize_state_mut(&mut self, issue_id: &str) -> Option<&mut IssueFinalizeState> {
        self.finalize.get_mut(issue_id)
    }

    pub fn clear_finalize_state(&mut self, issue_id: &str) {
        self.finalize.remove(issue_id);
        self.finalize_terminal_history.remove(issue_id);
    }

    /// Update session metadata on a running entry.
    pub fn update_session_info(
        &mut self,
        issue_id: &str,
        session_id: &str,
        agent_pid: Option<&str>,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.session_id = Some(session_id.to_string());
            entry.agent_pid = agent_pid.map(|s| s.to_string());
        }
    }

    /// Update the last agent event on a running entry.
    pub fn update_agent_event(
        &mut self,
        issue_id: &str,
        event_name: &str,
        message: Option<&str>,
        timestamp: DateTime<Utc>,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.last_agent_event = Some(event_name.to_string());
            entry.last_agent_timestamp = Some(timestamp);
            if let Some(msg) = message {
                entry.last_agent_message = Some(msg.chars().take(200).collect());
            }
        }
    }

    /// Increment turn count on a running entry.
    pub fn increment_turn_count(&mut self, issue_id: &str) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.turn_count += 1;
        }
    }

    /// Update token usage on a running entry using absolute totals.
    /// Computes deltas from last reported to update aggregate totals.
    pub fn update_token_usage(
        &mut self,
        issue_id: &str,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            // Compute deltas from last reported absolute totals
            let input_delta = input_tokens.saturating_sub(entry.last_reported_input_tokens);
            let output_delta = output_tokens.saturating_sub(entry.last_reported_output_tokens);
            let total_delta = total_tokens.saturating_sub(entry.last_reported_total_tokens);

            // Update entry absolute values
            entry.agent_input_tokens = input_tokens;
            entry.agent_output_tokens = output_tokens;
            entry.agent_total_tokens = total_tokens;

            // Update last reported
            entry.last_reported_input_tokens = input_tokens;
            entry.last_reported_output_tokens = output_tokens;
            entry.last_reported_total_tokens = total_tokens;

            // Add deltas to aggregate totals
            self.agent_totals.input_tokens += input_delta;
            self.agent_totals.output_tokens += output_delta;
            self.agent_totals.total_tokens += total_delta;
        }
    }

    /// Add runtime seconds from a completed running entry to the aggregate totals.
    pub fn add_runtime_seconds(&mut self, entry: &RunningEntry) {
        let elapsed = Utc::now()
            .signed_duration_since(entry.started_at)
            .num_milliseconds() as f64
            / 1000.0;
        self.agent_totals.seconds_running += elapsed;
    }

    /// Update the issue snapshot on a running entry.
    pub fn update_issue_snapshot(&mut self, issue_id: &str, issue: Issue) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.issue = issue;
        }
    }

    /// Get the count of currently running agents.
    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    /// Get the count of running agents in a specific state (lowercased).
    pub fn running_count_in_state(&self, state: &str) -> usize {
        let state_lower = state.to_lowercase();
        self.running
            .values()
            .filter(|e| e.issue.state.to_lowercase() == state_lower)
            .count()
    }

    /// Get all running issue IDs.
    pub fn running_issue_ids(&self) -> impl Iterator<Item = &str> {
        self.running.keys().map(|k| k.as_str())
    }

    /// Get an immutable reference to a pipeline run.
    pub fn get_pipeline_run(&self, issue_id: &str) -> Option<&PipelineRun> {
        self.pipeline_runs.get(issue_id)
    }

    /// Get a mutable reference to a pipeline run.
    pub fn get_pipeline_run_mut(&mut self, issue_id: &str) -> Option<&mut PipelineRun> {
        self.pipeline_runs.get_mut(issue_id)
    }

    /// Insert a pipeline run for an issue.
    pub fn insert_pipeline_run(
        &mut self,
        issue_id: &str,
        run: PipelineRun,
        config: std::sync::Arc<EnsembleConfig>,
    ) {
        self.pipeline_runs.insert(issue_id.to_string(), run);
        self.pipeline_configs.insert(issue_id.to_string(), config);
    }

    pub fn insert_terminal_pipeline_run(&mut self, issue_id: &str, run: PipelineRun) {
        self.pipeline_runs.insert(issue_id.to_string(), run);
        self.pipeline_configs.remove(issue_id);
    }

    /// Remove and return a pipeline run.
    pub fn remove_pipeline_run(&mut self, issue_id: &str) -> Option<PipelineRun> {
        self.pipeline_configs.remove(issue_id);
        self.pipeline_runs.remove(issue_id)
    }

    pub fn get_pipeline_config(&self, issue_id: &str) -> Option<&std::sync::Arc<EnsembleConfig>> {
        self.pipeline_configs.get(issue_id)
    }

    pub fn complete_issue(
        &mut self,
        issue_id: &str,
        status: Option<String>,
        outcome_summary: Option<String>,
    ) {
        let running = self.running.get(issue_id).cloned();
        let waiting = self.waiting_on_human.get(issue_id).cloned();
        let finalize = self.finalize.get(issue_id).cloned();
        let pending_terminal = self.pending_terminal_transitions.get(issue_id).cloned();
        let run = self.pipeline_runs.get(issue_id).cloned();
        let config = self.pipeline_configs.get(issue_id).cloned();

        trace!(
            "complete_issue: issue_id={}, running={}, waiting={}",
            issue_id,
            running.is_some(),
            waiting.is_some()
        );

        let Some(issue) = running
            .as_ref()
            .map(|entry| entry.issue.clone())
            .or_else(|| waiting.as_ref().and_then(|entry| entry.issue.clone()))
            .or_else(|| {
                pending_terminal
                    .as_ref()
                    .and_then(|entry| entry.issue.clone())
            })
            .or_else(|| {
                self.completed
                    .get(issue_id)
                    .map(|entry| entry.issue.clone())
            })
        else {
            return;
        };

        let identifier = running
            .as_ref()
            .map(|entry| entry.identifier.clone())
            .or_else(|| waiting.as_ref().map(|entry| entry.identifier.clone()))
            .or_else(|| {
                pending_terminal
                    .as_ref()
                    .map(|entry| entry.identifier.clone())
            })
            .or_else(|| {
                finalize
                    .as_ref()
                    .map(|entry| entry.issue_identifier.clone())
            })
            .or_else(|| {
                self.completed
                    .get(issue_id)
                    .map(|entry| entry.identifier.clone())
            })
            .unwrap_or_else(|| issue.identifier.clone());
        let run_id = running
            .as_ref()
            .and_then(|entry| entry.run_id.clone())
            .or_else(|| waiting.as_ref().and_then(|entry| entry.run_id.clone()))
            .or_else(|| {
                pending_terminal
                    .as_ref()
                    .and_then(|entry| entry.run_id.clone())
            })
            .or_else(|| {
                self.completed
                    .get(issue_id)
                    .and_then(|entry| entry.run_id.clone())
            });
        let completed_status = status.unwrap_or_else(|| {
            self.completed
                .get(issue_id)
                .map(|entry| entry.status.clone())
                .unwrap_or_else(|| "completed_succeeded".to_string())
        });
        let workflow_steps = run
            .as_ref()
            .map(completed_workflow_steps_from_run)
            .or_else(|| {
                config
                    .as_ref()
                    .map(|config| completed_workflow_steps_from_config(config))
            })
            .or_else(|| {
                self.completed
                    .get(issue_id)
                    .map(|entry| entry.workflow_steps.clone())
            })
            .unwrap_or_default();

        self.completed.insert(
            issue_id.to_string(),
            CompletedEntry {
                issue_id: issue_id.to_string(),
                identifier,
                run_id,
                issue,
                status: completed_status,
                workflow_steps,
                completed_at: Utc::now(),
                outcome_summary,
            },
        );
    }

    pub fn cleanup_expired_completed(&mut self) {
        let now = Utc::now();
        let expiry = Duration::seconds(self.completed_expiry_secs as i64);
        self.completed
            .retain(|_, entry| now.signed_duration_since(entry.completed_at) < expiry);
    }

    /// Add a completed entry with the given status.
    /// This is a convenience wrapper around `complete_issue` for simpler use cases.
    pub fn add_completed(&mut self, issue_id: String, _identifier: String, status: String) {
        self.complete_issue(&issue_id, Some(status), None);
    }

    /// Park a step, marking it as waiting for human input.
    pub fn park_step_waiting_for_human(&mut self, issue_id: &str, step_name: &str, ask_id: String) {
        let step_states = self.step_states.entry(issue_id.to_string()).or_default();
        step_states.insert(
            step_name.to_string(),
            StepRunState::WaitingForHuman { ask_id },
        );
    }

    /// Get the runtime state of a specific step for an issue.
    pub fn get_step_state(&self, issue_id: &str, step_name: &str) -> Option<StepRunState> {
        self.step_states
            .get(issue_id)
            .and_then(|steps| steps.get(step_name).cloned())
    }

    /// Set the runtime state of a specific step for an issue.
    pub fn set_step_state(&mut self, issue_id: &str, step_name: &str, state: StepRunState) {
        let step_states = self.step_states.entry(issue_id.to_string()).or_default();
        step_states.insert(step_name.to_string(), state);
    }

    /// Clear all step states for an issue.
    pub fn clear_step_states_for_issue(&mut self, issue_id: &str) {
        self.step_states.remove(issue_id);
    }

    /// Get the ask_id if a step is waiting for human input.
    pub fn get_step_waiting_ask_id(&self, issue_id: &str) -> Option<String> {
        self.step_states.get(issue_id).and_then(|steps| {
            steps.values().find_map(|s| {
                if let StepRunState::WaitingForHuman { ask_id } = s {
                    Some(ask_id.clone())
                } else {
                    None
                }
            })
        })
    }
}

fn completed_workflow_steps_from_config(config: &EnsembleConfig) -> Vec<CompletedWorkflowStep> {
    config
        .steps
        .iter()
        .map(|step| CompletedWorkflowStep {
            name: step.name.clone(),
            agent: step.agent.clone(),
            kind: step.kind.to_string(),
            dependencies: step.depends.clone().unwrap_or_default(),
            state: "unknown".to_string(),
            can_navigate: false,
            route_provenance: None,
        })
        .collect()
}

fn completed_workflow_steps_from_run(run: &PipelineRun) -> Vec<CompletedWorkflowStep> {
    run.workflow_steps()
        .map(|step| CompletedWorkflowStep {
            name: step.name.clone(),
            agent: step.agent.clone(),
            kind: step.kind.to_string(),
            dependencies: step.depends.clone(),
            state: completed_step_state_for_name(&step.name, run),
            can_navigate: !matches!(
                run.step_states.get(&step.name),
                Some(StepState::Skipped { .. })
            ) && run.step_states.contains_key(&step.name),
            route_provenance: match run.step_states.get(&step.name) {
                Some(StepState::Skipped { provenance }) => Some(provenance.clone()),
                _ => None,
            },
        })
        .collect()
}

fn completed_step_state_for_name(step_name: &str, run: &PipelineRun) -> String {
    run.step_states
        .get(step_name)
        .map(|state| match state {
            crate::pipeline::engine::StepState::Pending => "pending",
            crate::pipeline::engine::StepState::Running { .. } => "running",
            crate::pipeline::engine::StepState::Passed => "passed",
            crate::pipeline::engine::StepState::Skipped { .. } => "skipped",
            crate::pipeline::engine::StepState::Failed { .. } => "failed",
            crate::pipeline::engine::StepState::BlockedOnHuman { .. } => "waiting",
            crate::pipeline::engine::StepState::AwaitingApproval { .. } => "waiting",
            crate::pipeline::engine::StepState::Errored { .. } => "failed",
        })
        .unwrap_or("pending")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::ConcurrencyConfig;

    fn test_issue(id: &str, state: &str) -> Issue {
        crate::tracker::model::test_helpers::test_issue(id, state)
    }

    #[test]
    fn test_new_state() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        assert_eq!(state.poll_interval_ms, 30000);
        assert_eq!(state.max_concurrent_agents, 4);
        assert!(state.running.is_empty());
        assert!(state.claimed.is_empty());
        assert!(state.retry_attempts.is_empty());
        assert!(state.waiting_on_human.is_empty());
        assert!(state.completed.is_empty());
        assert_eq!(state.agent_totals.total_tokens, 0);
        assert!(state.pipeline_runs.is_empty());
        assert!(state.last_tick_at.is_none());
    }

    #[test]
    fn test_add_running() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);

        assert!(state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert_eq!(state.running_count(), 1);
    }

    #[test]
    fn test_remove_running() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);
        let entry = state.remove_running("1");

        assert!(entry.is_some());
        assert!(!state.is_running("1"));
        // claimed is NOT removed by remove_running
        assert!(state.is_claimed("1"));
    }

    #[test]
    fn test_release_claim() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);
        state.release_claim("1");

        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
    }

    #[test]
    fn test_add_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };

        state.add_retry(retry);

        assert!(state.is_claimed("1"));
        assert!(state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_remove_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };

        state.add_retry(retry);
        let removed = state.remove_retry("1");

        assert!(removed.is_some());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_add_waiting_on_human_keeps_claimed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "build".to_string(),
            kind: InteractionKind::Question,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: None,
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            run_id: None,
            issue: None,
        });

        assert!(state.is_claimed("1"));
        assert!(state.is_waiting_on_human("1"));
    }

    #[test]
    fn test_find_issue_id_by_identifier_checks_active_control_states() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_running(&test_issue("running", "Todo"), None);
        state.add_retry(RetryEntry {
            issue_id: "retrying".to_string(),
            identifier: "repo#retrying".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: "waiting".to_string(),
            identifier: "repo#waiting".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "build".to_string(),
            kind: InteractionKind::Question,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: None,
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            run_id: None,
            issue: None,
        });

        assert_eq!(
            state.find_issue_id_by_identifier("repo#running"),
            Some("running".to_string())
        );
        assert_eq!(
            state.find_issue_id_by_identifier("repo#retrying"),
            Some("retrying".to_string())
        );
        assert_eq!(
            state.find_issue_id_by_identifier("repo#waiting"),
            Some("waiting".to_string())
        );
        assert_eq!(state.find_issue_id_by_identifier("repo#missing"), None);
    }

    #[test]
    fn test_queue_and_clear_resume_request() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        state.queue_resume("1");
        assert!(state.is_resume_requested("1"));

        state.clear_resume_request("1");
        assert!(!state.is_resume_requested("1"));
    }

    #[test]
    fn test_release_claim_clears_waiting_on_human() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "build".to_string(),
            kind: InteractionKind::Question,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: None,
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            run_id: None,
            issue: None,
        });
        state.queue_resume("1");

        state.release_claim("1");

        assert!(!state.is_claimed("1"));
        assert!(!state.is_waiting_on_human("1"));
        assert!(!state.is_resume_requested("1"));
    }

    #[test]
    fn test_update_session_info() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.update_session_info("1", "session-abc", Some("12345"));

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.session_id.as_deref(), Some("session-abc"));
        assert_eq!(entry.agent_pid.as_deref(), Some("12345"));
    }

    #[test]
    fn test_update_agent_event() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        let ts = Utc::now();
        state.update_agent_event("1", "turn_completed", Some("done with tests"), ts);

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.last_agent_event.as_deref(), Some("turn_completed"));
        assert_eq!(entry.last_agent_message.as_deref(), Some("done with tests"));
        assert!(entry.last_agent_timestamp.is_some());
    }

    #[test]
    fn test_increment_turn_count() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.increment_turn_count("1");
        state.increment_turn_count("1");

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.turn_count, 2);
    }

    #[test]
    fn test_update_token_usage_with_deltas() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // First update: absolute = 100/50/150
        state.update_token_usage("1", 100, 50, 150);
        assert_eq!(state.agent_totals.input_tokens, 100);
        assert_eq!(state.agent_totals.output_tokens, 50);
        assert_eq!(state.agent_totals.total_tokens, 150);

        // Second update: absolute = 200/100/300 (delta = 100/50/150)
        state.update_token_usage("1", 200, 100, 300);
        assert_eq!(state.agent_totals.input_tokens, 200);
        assert_eq!(state.agent_totals.output_tokens, 100);
        assert_eq!(state.agent_totals.total_tokens, 300);

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.agent_input_tokens, 200);
        assert_eq!(entry.agent_output_tokens, 100);
        assert_eq!(entry.agent_total_tokens, 300);
    }

    #[test]
    fn test_running_count_in_state() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_running(&test_issue("1", "Todo"), None);
        state.add_running(&test_issue("2", "Todo"), None);
        state.add_running(&test_issue("3", "In Progress"), None);

        assert_eq!(state.running_count_in_state("todo"), 2);
        assert_eq!(state.running_count_in_state("in progress"), 1);
        assert_eq!(state.running_count_in_state("Done"), 0);
    }

    #[test]
    fn test_running_issue_ids() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_running(&test_issue("a", "Todo"), None);
        state.add_running(&test_issue("b", "Todo"), None);

        let mut ids: Vec<&str> = state.running_issue_ids().collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn test_add_running_clears_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 5000,
            error: Some("previous error".to_string()),
            retry_from_step: None,
            with_fixup: false,
        };
        state.add_retry(retry);
        assert!(state.retry_attempts.contains_key("1"));

        state.add_running(&test_issue("1", "Todo"), Some(2));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(state.is_running("1"));
    }

    #[test]
    fn test_run_id_and_sequence_are_stable_across_retries_until_release() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, Some(1));
        let first_run_id = state
            .running
            .get("1")
            .and_then(|entry| entry.run_id.clone())
            .expect("run_id should be assigned");
        assert_eq!(state.next_timeline_sequence(&first_run_id), 1);

        let _ = state.remove_running("1");
        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 5000,
            error: Some("retry".to_string()),
            retry_from_step: None,
            with_fixup: false,
        });
        state.add_running(&issue, Some(2));

        let second_run_id = state
            .running
            .get("1")
            .and_then(|entry| entry.run_id.clone())
            .expect("run_id should be reused");
        assert_eq!(second_run_id, first_run_id);
        assert_eq!(state.next_timeline_sequence(&second_run_id), 2);

        state.release_claim("1");
        assert!(state.issue_run_ids.get("1").is_none());
        assert!(state.timeline_sequences.get(&second_run_id).is_none());
    }

    #[test]
    fn test_add_completed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("issue-1", "Todo");
        state.add_running(&issue, None);
        state.complete_issue("issue-1", Some("completed_succeeded".to_string()), None);

        assert!(state.completed.contains_key("issue-1"));
        let entry = state.completed.get("issue-1").unwrap();
        assert_eq!(entry.issue_id, "issue-1");
        assert_eq!(entry.identifier, "repo#issue-1");
        assert_eq!(entry.status, "completed_succeeded");
        assert_eq!(entry.issue.title, issue.title);
        assert!(entry.outcome_summary.is_none());
    }

    #[test]
    fn test_cleanup_expired_completed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.completed_expiry_secs = 1;

        state.add_running(&test_issue("issue-1", "Todo"), None);
        state.complete_issue("issue-1", Some("completed_succeeded".to_string()), None);

        assert!(state.completed.contains_key("issue-1"));

        std::thread::sleep(std::time::Duration::from_millis(1100));

        state.cleanup_expired_completed();

        assert!(state.completed.is_empty());
    }

    #[test]
    fn test_cleanup_expired_completed_keeps_valid() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.completed_expiry_secs = 10;

        state.add_running(&test_issue("issue-1", "Todo"), None);
        state.add_running(&test_issue("issue-2", "Todo"), None);
        state.complete_issue("issue-1", Some("completed_succeeded".to_string()), None);
        state.complete_issue("issue-2", Some("completed_failed".to_string()), None);

        std::thread::sleep(std::time::Duration::from_millis(100));

        state.cleanup_expired_completed();

        assert_eq!(state.completed.len(), 2);
        assert!(state.completed.contains_key("issue-1"));
        assert!(state.completed.contains_key("issue-2"));
    }

    #[test]
    fn release_claim_removes_parked_recovery_without_touching_other_owners() {
        let mut state = OrchestratorState::new(30_000, &ConcurrencyConfig::default());
        state.parked_runs.insert(
            "issue-1".to_string(),
            ParkedRunEntry {
                issue_id: "issue-1".to_string(),
                identifier: "repo#issue-1".to_string(),
                condition_key: "runtime.scheduler.recovery_exhausted".to_string(),
                attempt: 2,
                reason: "network".to_string(),
                parked_at: Utc::now(),
            },
        );
        state.parked_runs.insert(
            "issue-2".to_string(),
            ParkedRunEntry {
                issue_id: "issue-2".to_string(),
                identifier: "repo#issue-2".to_string(),
                condition_key: "runtime.scheduler.recovery_exhausted".to_string(),
                attempt: 2,
                reason: "network".to_string(),
                parked_at: Utc::now(),
            },
        );

        state.release_claim("issue-1");

        assert!(!state.parked_runs.contains_key("issue-1"));
        assert!(state.parked_runs.contains_key("issue-2"));
    }
}
