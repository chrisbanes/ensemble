use chrono::Utc;
use std::collections::HashSet;
use tracing::{debug, info, warn};

use super::state::OrchestratorState;
use crate::tracker::model::Issue;
use crate::tracker::IssueTracker;
use crate::workspace::manager::WorkspaceManager;

/// Result of reconciling stalled runs.
pub struct StallReconcileResult {
    pub stalled_count: usize,
    pub stalled_issue_ids: Vec<String>,
}

/// Reconcile stalled runs: check elapsed time since last event and flag stalled workers.
/// Returns the list of stalled issue IDs (the caller is responsible for killing them).
pub fn reconcile_stalled_runs(
    state: &OrchestratorState,
    stall_timeout_ms: i64,
) -> StallReconcileResult {
    // If stall_timeout_ms <= 0, stall detection is disabled
    if stall_timeout_ms <= 0 {
        return StallReconcileResult {
            stalled_count: 0,
            stalled_issue_ids: vec![],
        };
    }

    let now = Utc::now();
    let mut stalled = Vec::new();

    for (issue_id, entry) in &state.running {
        let reference_time = entry.last_agent_timestamp.unwrap_or(entry.started_at);
        let elapsed_ms = now.signed_duration_since(reference_time).num_milliseconds();

        if elapsed_ms > stall_timeout_ms {
            info!(
                issue_id = %issue_id,
                identifier = %entry.identifier,
                elapsed_ms = elapsed_ms,
                stall_timeout_ms = stall_timeout_ms,
                "detected stalled run"
            );
            stalled.push(issue_id.clone());
        }
    }

    StallReconcileResult {
        stalled_count: stalled.len(),
        stalled_issue_ids: stalled,
    }
}

/// Action to take for a running issue based on its refreshed tracker state.
#[derive(Debug)]
pub enum ReconcileAction {
    /// Issue is still in active state — update the snapshot.
    UpdateSnapshot(Issue),
    /// Issue is in a terminal state — terminate worker and clean workspace.
    TerminateAndCleanup(Issue),
    /// Issue is in a non-active, non-terminal state — terminate worker without cleanup.
    TerminateNoCleanup(Issue),
}

/// Determine the reconcile action for a single refreshed issue.
pub fn determine_reconcile_action(
    issue: &Issue,
    active_states_lower: &[String],
    terminal_states_lower: &[String],
) -> ReconcileAction {
    let state_lower = issue.state.to_lowercase();

    if terminal_states_lower.contains(&state_lower) {
        ReconcileAction::TerminateAndCleanup(issue.clone())
    } else if active_states_lower.contains(&state_lower) {
        ReconcileAction::UpdateSnapshot(issue.clone())
    } else {
        ReconcileAction::TerminateNoCleanup(issue.clone())
    }
}

/// Perform tracker state refresh reconciliation.
/// Returns lists of actions categorized by type.
pub async fn reconcile_tracker_states(
    state: &OrchestratorState,
    tracker: &dyn IssueTracker,
    active_states_lower: &[String],
    terminal_states_lower: &[String],
) -> ReconcileTrackerResult {
    let mut tracked_ids: Vec<String> = state.running_issue_ids().map(|s| s.to_string()).collect();
    for issue_id in state.waiting_on_human.keys() {
        if !tracked_ids.contains(issue_id) {
            tracked_ids.push(issue_id.clone());
        }
    }
    if tracked_ids.is_empty() {
        return ReconcileTrackerResult {
            updates: vec![],
            terminate_cleanup: vec![],
            terminate_no_cleanup: vec![],
            refresh_failed: false,
        };
    }

    let refreshed = match tracker.fetch_issue_states_by_ids(&tracked_ids).await {
        Ok(issues) => issues,
        Err(e) => {
            warn!(
                error = %e,
                "tracker state refresh failed, keeping workers running"
            );
            return ReconcileTrackerResult {
                updates: vec![],
                terminate_cleanup: vec![],
                terminate_no_cleanup: vec![],
                refresh_failed: true,
            };
        }
    };

    let refreshed_ids: HashSet<String> = refreshed.iter().map(|issue| issue.id.clone()).collect();
    let mut updates = Vec::new();
    let mut terminate_cleanup = Vec::new();
    let mut terminate_no_cleanup = Vec::new();

    for issue in refreshed {
        if state.delivery.contains_key(&issue.id) {
            continue;
        }
        if !state.is_running(&issue.id) && !state.is_waiting_on_human(&issue.id) {
            continue;
        }

        match determine_reconcile_action(&issue, active_states_lower, terminal_states_lower) {
            ReconcileAction::UpdateSnapshot(i) => {
                debug!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue still active, updating snapshot"
                );
                updates.push(i);
            }
            ReconcileAction::TerminateAndCleanup(i) => {
                info!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue terminal, terminating and cleaning workspace"
                );
                terminate_cleanup.push(i);
            }
            ReconcileAction::TerminateNoCleanup(i) => {
                info!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue no longer active, terminating without cleanup"
                );
                terminate_no_cleanup.push(i);
            }
        }
    }

    for issue_id in tracked_ids {
        if refreshed_ids.contains(&issue_id)
            || !state.is_waiting_on_human(&issue_id)
            || state.is_resume_requested(&issue_id)
        {
            continue;
        }

        let identifier = state
            .waiting_on_human
            .get(&issue_id)
            .map(|entry| entry.identifier.clone())
            .unwrap_or_else(|| issue_id.clone());
        terminate_no_cleanup.push(Issue {
            id: issue_id.clone(),
            identifier,
            title: format!("Missing tracked issue {issue_id}"),
            description: None,
            priority: None,
            state: "missing".to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        });
    }

    ReconcileTrackerResult {
        updates,
        terminate_cleanup,
        terminate_no_cleanup,
        refresh_failed: false,
    }
}

/// Result of tracker state reconciliation.
pub struct ReconcileTrackerResult {
    /// Issues still in active state — update their snapshots.
    pub updates: Vec<Issue>,
    /// Issues in terminal state — terminate and clean workspace.
    pub terminate_cleanup: Vec<Issue>,
    /// Issues in non-active/non-terminal state — terminate without cleanup.
    pub terminate_no_cleanup: Vec<Issue>,
    /// Whether the refresh call failed.
    pub refresh_failed: bool,
}

/// Perform startup terminal workspace cleanup.
pub async fn startup_terminal_cleanup(
    tracker: &dyn IssueTracker,
    terminal_states: &[String],
    workspace_mgr: &WorkspaceManager,
    excluded_issue_ids: &HashSet<String>,
) {
    info!("performing startup terminal workspace cleanup");

    match tracker.fetch_issues_by_states(terminal_states).await {
        Ok(terminal_issues) => {
            let cleanup_issues = terminal_issues
                .iter()
                .filter(|issue| !excluded_issue_ids.contains(&issue.id))
                .collect::<Vec<_>>();
            for issue in &cleanup_issues {
                match workspace_mgr.remove_workspace(&issue.id).await {
                    Ok(()) => {
                        debug!(
                            identifier = %issue.identifier,
                            "cleaned terminal workspace"
                        );
                    }
                    Err(e) => {
                        warn!(
                            identifier = %issue.identifier,
                            error = %e,
                            "failed to clean terminal workspace"
                        );
                    }
                }
            }
            info!(
                count = cleanup_issues.len(),
                "startup terminal cleanup complete"
            );
        }
        Err(e) => {
            warn!(
                error = %e,
                "startup terminal cleanup failed, continuing startup"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::ConcurrencyConfig;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;

    fn test_issue(id: &str, state: &str) -> Issue {
        crate::tracker::model::test_helpers::test_issue(id, state)
    }

    fn default_active() -> Vec<String> {
        vec!["todo".to_string(), "in progress".to_string()]
    }

    fn default_terminal() -> Vec<String> {
        vec!["done".to_string(), "closed".to_string()]
    }

    // --- Stall detection tests ---

    #[test]
    fn test_stall_detection_disabled() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let result = reconcile_stalled_runs(&state, 0);
        assert_eq!(result.stalled_count, 0);

        let result2 = reconcile_stalled_runs(&state, -1);
        assert_eq!(result2.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_no_running() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_not_stalled() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);
        // started_at is now, so it won't be stalled with a large timeout
        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_stalled() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // Override started_at to be in the distant past
        if let Some(entry) = state.running.get_mut("1") {
            entry.started_at = Utc::now() - chrono::Duration::seconds(600);
        }

        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 1);
        assert_eq!(result.stalled_issue_ids, vec!["1"]);
    }

    #[test]
    fn test_stall_uses_last_agent_timestamp() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // started_at is old, but last_agent_timestamp is recent
        if let Some(entry) = state.running.get_mut("1") {
            entry.started_at = Utc::now() - chrono::Duration::seconds(600);
            entry.last_agent_timestamp = Some(Utc::now());
        }

        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    // --- Reconcile action tests ---

    #[test]
    fn test_determine_action_active() {
        let issue = test_issue("1", "In Progress");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::UpdateSnapshot(_)));
    }

    #[test]
    fn test_determine_action_terminal() {
        let issue = test_issue("1", "Done");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateAndCleanup(_)));
    }

    #[test]
    fn test_determine_action_non_active_non_terminal() {
        let issue = test_issue("1", "Backlog");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateNoCleanup(_)));
    }

    #[test]
    fn test_determine_action_case_insensitive() {
        let issue = test_issue("1", "done");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateAndCleanup(_)));
    }

    // --- Tracker reconciliation tests ---

    struct MockTrackerForReconcile {
        issues: Vec<Issue>,
        should_fail: bool,
    }

    #[async_trait]
    impl IssueTracker for MockTrackerForReconcile {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.clone())
        }
        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            if self.should_fail {
                return Err(TrackerError::ApiRequestFailed {
                    reason: "mock failure".to_string(),
                });
            }
            let states_lower: Vec<String> = states.iter().map(|s| s.to_lowercase()).collect();
            Ok(self
                .issues
                .iter()
                .filter(|i| states_lower.contains(&i.state.to_lowercase()))
                .cloned()
                .collect())
        }
        async fn fetch_issue_states_by_ids(
            &self,
            ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            if self.should_fail {
                return Err(TrackerError::ApiRequestFailed {
                    reason: "mock failure".to_string(),
                });
            }
            Ok(self
                .issues
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect())
        }
    }

    #[tokio::test]
    async fn test_reconcile_tracker_no_running() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: false,
        };

        let result =
            reconcile_tracker_states(&state, &tracker, &default_active(), &default_terminal())
                .await;

        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
        assert!(!result.refresh_failed);
    }

    #[tokio::test]
    async fn test_reconcile_tracker_active_update() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "In Progress")],
            should_fail: false,
        };

        let result =
            reconcile_tracker_states(&state, &tracker, &default_active(), &default_terminal())
                .await;

        assert_eq!(result.updates.len(), 1);
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_reconcile_tracker_terminal_cleanup() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "Done")], // moved to terminal
            should_fail: false,
        };

        let result =
            reconcile_tracker_states(&state, &tracker, &default_active(), &default_terminal())
                .await;

        assert!(result.updates.is_empty());
        assert_eq!(result.terminate_cleanup.len(), 1);
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_reconcile_tracker_non_active_stop() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "Backlog")], // moved to non-active
            should_fail: false,
        };

        let result =
            reconcile_tracker_states(&state, &tracker, &default_active(), &default_terminal())
                .await;

        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert_eq!(result.terminate_no_cleanup.len(), 1);
    }

    #[tokio::test]
    async fn test_reconcile_tracker_refresh_failed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: true,
        };

        let result =
            reconcile_tracker_states(&state, &tracker, &default_active(), &default_terminal())
                .await;

        assert!(result.refresh_failed);
        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_startup_terminal_cleanup() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();

        // Create a workspace
        workspace_mgr
            .prepare_workspace("42", "repo#42")
            .await
            .unwrap();
        let workspace_path = workspace_mgr.workspace_path("42");
        assert!(workspace_path.exists());

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("42", "Done")],
            should_fail: false,
        };

        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
            &HashSet::new(),
        )
        .await;

        // Workspace should be cleaned up
        assert!(!workspace_path.exists());
    }

    #[tokio::test]
    async fn startup_terminal_cleanup_retains_pending_reconciliation_workspace() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        workspace_mgr
            .prepare_workspace("42", "repo#42")
            .await
            .unwrap();

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("42", "Done")],
            should_fail: false,
        };
        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
            &HashSet::from(["42".to_string()]),
        )
        .await;

        assert!(workspace_mgr.workspace_path("42").exists());
    }

    #[tokio::test]
    async fn workspace_identity_lifecycle_startup_cleanup_refuses_mismatched_owner() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        let workspace_path = workspace_mgr.workspace_path("42");
        std::fs::create_dir_all(&workspace_path).unwrap();
        std::fs::write(
            workspace_path.join(".ensemble-workspace.json"),
            r#"{"issue_id":"other","issue_identifier":"other#7","branch_date":"2024-01-01"}"#,
        )
        .unwrap();
        let sentinel = workspace_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("42", "Done")],
            should_fail: false,
        };
        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
            &HashSet::new(),
        )
        .await;

        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn test_startup_terminal_cleanup_failure_continues() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();

        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: true,
        };

        // Should not panic — just logs and continues
        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
            &HashSet::new(),
        )
        .await;
    }
}
