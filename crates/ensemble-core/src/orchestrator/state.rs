use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::pipeline::engine::PipelineRun;
use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};

/// Rate limit snapshot from agent events.
#[derive(Debug, Clone, Default, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RateLimitSnapshot {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset_at: Option<String>,
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
    /// Completed issue IDs (bookkeeping only).
    pub completed: HashSet<String>,
    /// Aggregate token counts and runtime seconds.
    pub agent_totals: AgentTotals,
    /// Latest rate limit snapshot from agent events.
    pub agent_rate_limits: Option<RateLimitSnapshot>,
    /// Active pipeline runs: issue_id -> PipelineRun.
    pub pipeline_runs: HashMap<String, PipelineRun>,
    /// Timestamp of the last orchestrator poll tick.
    pub last_tick_at: Option<DateTime<Utc>>,
}

impl OrchestratorState {
    /// Create a new OrchestratorState with the given config values.
    pub fn new(poll_interval_ms: u64, max_concurrent_agents: u32) -> Self {
        Self {
            poll_interval_ms,
            max_concurrent_agents,
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            completed: HashSet::new(),
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
            pipeline_runs: HashMap::new(),
            last_tick_at: None,
        }
    }

    /// Add a running entry for a dispatched issue.
    pub fn add_running(&mut self, issue: &Issue, attempt: Option<u32>) {
        let entry = RunningEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
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

    /// Add a retry entry.
    pub fn add_retry(&mut self, entry: RetryEntry) {
        self.claimed.insert(entry.issue_id.clone());
        self.retry_attempts.insert(entry.issue_id.clone(), entry);
    }

    /// Remove a retry entry and return it.
    pub fn remove_retry(&mut self, issue_id: &str) -> Option<RetryEntry> {
        self.retry_attempts.remove(issue_id)
    }

    /// Release a claim entirely (remove from claimed, running, and retry).
    pub fn release_claim(&mut self, issue_id: &str) {
        self.claimed.remove(issue_id);
        self.running.remove(issue_id);
        self.retry_attempts.remove(issue_id);
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
    pub fn running_issue_ids(&self) -> Vec<String> {
        self.running.keys().cloned().collect()
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
    pub fn insert_pipeline_run(&mut self, issue_id: &str, run: PipelineRun) {
        self.pipeline_runs.insert(issue_id.to_string(), run);
    }

    /// Remove and return a pipeline run.
    pub fn remove_pipeline_run(&mut self, issue_id: &str) -> Option<PipelineRun> {
        self.pipeline_runs.remove(issue_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_issue(id: &str, state: &str) -> Issue {
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
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_new_state() {
        let state = OrchestratorState::new(30000, 10);
        assert_eq!(state.poll_interval_ms, 30000);
        assert_eq!(state.max_concurrent_agents, 10);
        assert!(state.running.is_empty());
        assert!(state.claimed.is_empty());
        assert!(state.retry_attempts.is_empty());
        assert!(state.completed.is_empty());
        assert_eq!(state.agent_totals.total_tokens, 0);
        assert!(state.pipeline_runs.is_empty());
        assert!(state.last_tick_at.is_none());
    }

    #[test]
    fn test_add_running() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);

        assert!(state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert_eq!(state.running_count(), 1);
    }

    #[test]
    fn test_remove_running() {
        let mut state = OrchestratorState::new(30000, 10);
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
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);
        state.release_claim("1");

        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
    }

    #[test]
    fn test_add_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
        };

        state.add_retry(retry);

        assert!(state.is_claimed("1"));
        assert!(state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_remove_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
        };

        state.add_retry(retry);
        let removed = state.remove_retry("1");

        assert!(removed.is_some());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_update_session_info() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.update_session_info("1", "session-abc", Some("12345"));

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.session_id.as_deref(), Some("session-abc"));
        assert_eq!(entry.agent_pid.as_deref(), Some("12345"));
    }

    #[test]
    fn test_update_agent_event() {
        let mut state = OrchestratorState::new(30000, 10);
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
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.increment_turn_count("1");
        state.increment_turn_count("1");

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.turn_count, 2);
    }

    #[test]
    fn test_update_token_usage_with_deltas() {
        let mut state = OrchestratorState::new(30000, 10);
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
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("1", "Todo"), None);
        state.add_running(&test_issue("2", "Todo"), None);
        state.add_running(&test_issue("3", "In Progress"), None);

        assert_eq!(state.running_count_in_state("todo"), 2);
        assert_eq!(state.running_count_in_state("in progress"), 1);
        assert_eq!(state.running_count_in_state("Done"), 0);
    }

    #[test]
    fn test_running_issue_ids() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("a", "Todo"), None);
        state.add_running(&test_issue("b", "Todo"), None);

        let mut ids = state.running_issue_ids();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn test_add_running_clears_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 5000,
            error: Some("previous error".to_string()),
        };
        state.add_retry(retry);
        assert!(state.retry_attempts.contains_key("1"));

        state.add_running(&test_issue("1", "Todo"), Some(2));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(state.is_running("1"));
    }
}
