use crate::orchestrator::state::{FinalizeStatus, OrchestratorState, RateLimitSnapshot};
use crate::pipeline::engine::{PipelineRun, StepState};
use crate::tracker::model::{RetryEntry, RunningEntry};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;

/// Top-level runtime snapshot matching SPEC.md Section 13.7.2 GET /api/v1/state shape.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RuntimeSnapshot {
    pub generated_at: DateTime<Utc>,
    pub counts: SnapshotCounts,
    pub running: Vec<RunningSessionRow>,
    pub retrying: Vec<RetryRow>,
    pub waiting_on_human: Vec<WaitingInteractionRow>,
    pub agent_totals: AgentTotalsSnapshot,
    pub rate_limits: Option<RateLimitSnapshot>,
    pub poll_interval_ms: u64,
    pub last_tick_at: Option<DateTime<Utc>>,
}

/// Summary counts of running and retrying sessions.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SnapshotCounts {
    pub running: usize,
    pub retrying: usize,
    pub waiting_on_human: usize,
}

/// A compact row for an issue currently waiting on human input.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct WaitingInteractionRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub interaction_request_id: String,
    pub step_name: String,
    pub requested_at: DateTime<Utc>,
}

/// Compact issue-detail summary for the current waiting interaction.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CurrentInteractionSummary {
    pub interaction_request_id: String,
    pub step_name: String,
    pub requested_at: DateTime<Utc>,
}

/// Preferred issue-detail pending input summary for UI resume flow.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PendingInputSummary {
    pub kind: String,
    pub prompt: String,
    pub requested_at: DateTime<Utc>,
    pub context: PendingInputContext,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PendingInputContext {
    pub interaction_request_id: String,
    pub step_name: String,
    pub agent_name: String,
}

/// A single row in the running sessions list.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RunningSessionRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub state: String,
    pub step_name: Option<String>,
    pub session_id: Option<String>,
    pub turn_count: u32,
    pub last_event: Option<String>,
    pub last_message: Option<String>,
    pub started_at: DateTime<Utc>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub tokens: TokenSnapshot,
}

/// Token counts for a single session.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TokenSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

/// A single row in the retry queue list.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RetryRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub attempt: u32,
    pub due_at_ms: u64,
    pub error: Option<String>,
}

/// Aggregate token and runtime totals for the snapshot.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct AgentTotalsSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub seconds_running: f64,
}

/// Per-issue detail snapshot for GET /api/v1/{identifier}.
///
/// NOTE: Plan 5 (Dashboard) expects additional fields `logs` and `recent_events`
/// in the API response. When implementing the dashboard integration, extend this
/// struct with `logs` and `recent_events` fields.
/// These are omitted here because Plan 4 does not yet have the event/log collection
/// infrastructure, but the JSON shape should be forward-compatible.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct IssueDetailSnapshot {
    pub issue_identifier: String,
    pub issue_id: String,
    pub status: String,
    pub workspace: WorkspaceInfo,
    pub attempts: AttemptInfo,
    pub running: Option<RunningDetail>,
    pub retry: Option<RetryRow>,
    pub pending_input: Option<PendingInputSummary>,
    /// Deprecated compatibility field. Prefer `pending_input`.
    pub current_interaction: Option<CurrentInteractionSummary>,
    pub last_error: Option<String>,
    pub finalize: FinalizeSnapshot,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct FinalizeSnapshot {
    pub status: String,
    pub repos: Vec<RepoFinalizeSnapshot>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RepoFinalizeSnapshot {
    pub repo: String,
    pub mode: String,
    pub approval_required: bool,
    pub status: String,
    pub last_error: Option<String>,
}

fn finalize_status_str(status: &FinalizeStatus) -> &'static str {
    match status {
        FinalizeStatus::NotRequired => "not_required",
        FinalizeStatus::PendingApproval => "pending_approval",
        FinalizeStatus::InProgress => "in_progress",
        FinalizeStatus::Succeeded => "succeeded",
        FinalizeStatus::Failed => "failed",
        FinalizeStatus::SkippedHeadless => "skipped_headless",
    }
}

/// Workspace path info for issue detail.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct WorkspaceInfo {
    pub path: String,
}

/// Attempt tracking for issue detail.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct AttemptInfo {
    pub restart_count: u32,
    pub current_retry_attempt: Option<u32>,
}

/// Running session detail for issue detail.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RunningDetail {
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub step_name: Option<String>,
    pub turn_count: u32,
    pub state: String,
    pub started_at: DateTime<Utc>,
    pub last_event: Option<String>,
    pub last_message: Option<String>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub tokens: TokenSnapshot,
}

/// Build a RuntimeSnapshot from the current OrchestratorState.
///
/// This computes `seconds_running` as the sum of cumulative ended-session runtime
/// plus elapsed time for all currently active sessions (from their `started_at`).
pub fn build_state_snapshot(state: &OrchestratorState) -> RuntimeSnapshot {
    let now = Utc::now();

    let running_rows: Vec<RunningSessionRow> = state
        .running
        .values()
        .map(|entry| running_entry_to_row(entry, &state.pipeline_runs))
        .collect();

    let retry_rows: Vec<RetryRow> = state
        .retry_attempts
        .values()
        .map(retry_entry_to_row)
        .collect();

    let waiting_rows: Vec<WaitingInteractionRow> = state
        .waiting_on_human
        .values()
        .map(waiting_entry_to_row)
        .collect();

    // Compute live seconds_running: cumulative from ended sessions + active elapsed
    let active_elapsed: f64 = state
        .running
        .values()
        .map(|entry| {
            let elapsed = now.signed_duration_since(entry.started_at);
            elapsed.num_milliseconds().max(0) as f64 / 1000.0
        })
        .sum();

    let total_seconds = state.agent_totals.seconds_running + active_elapsed;

    RuntimeSnapshot {
        generated_at: now,
        counts: SnapshotCounts {
            running: running_rows.len(),
            retrying: retry_rows.len(),
            waiting_on_human: waiting_rows.len(),
        },
        running: running_rows,
        retrying: retry_rows,
        waiting_on_human: waiting_rows,
        agent_totals: AgentTotalsSnapshot {
            input_tokens: state.agent_totals.input_tokens,
            output_tokens: state.agent_totals.output_tokens,
            total_tokens: state.agent_totals.total_tokens,
            seconds_running: total_seconds,
        },
        rate_limits: state.agent_rate_limits.clone(),
        poll_interval_ms: state.poll_interval_ms,
        last_tick_at: state.last_tick_at,
    }
}

/// Build an IssueDetailSnapshot for a specific issue by identifier.
///
/// Returns None if the identifier is not found in running or retry maps.
pub fn build_issue_snapshot(
    state: &OrchestratorState,
    identifier: &str,
    workspace_root: &str,
) -> Option<IssueDetailSnapshot> {
    // Check running entries first
    let running_entry = state.running.values().find(|e| e.identifier == identifier);

    // Check retry entries
    let retry_entry = state
        .retry_attempts
        .values()
        .find(|e| e.identifier == identifier);

    let waiting_entry = state
        .waiting_on_human
        .values()
        .find(|e| e.identifier == identifier);
    let finalize_entry = state
        .finalize
        .iter()
        .find(|(_, finalize)| finalize.issue_identifier == identifier);

    if running_entry.is_none()
        && retry_entry.is_none()
        && waiting_entry.is_none()
        && finalize_entry.is_none()
    {
        return None;
    }

    let (issue_id, issue_identifier) = if let Some(entry) = running_entry {
        (entry.issue_id.clone(), entry.identifier.clone())
    } else if let Some(entry) = retry_entry {
        (entry.issue_id.clone(), entry.identifier.clone())
    } else if let Some(entry) = waiting_entry {
        (entry.issue_id.clone(), entry.identifier.clone())
    } else if let Some((issue_id, finalize)) = finalize_entry {
        (issue_id.clone(), finalize.issue_identifier.clone())
    } else {
        return None;
    };

    let workspace_key = crate::tracker::model::sanitize_workspace_key(identifier)?;
    let workspace_path = format!("{}/{}", workspace_root, workspace_key);

    let status = if running_entry.is_some() {
        "running".to_string()
    } else if waiting_entry.is_some() {
        "waiting_on_human".to_string()
    } else if let Some((_, finalize)) = finalize_entry {
        format!("finalize_{}", finalize_status_str(&finalize.status))
    } else {
        "retrying".to_string()
    };

    let current_retry_attempt = if let Some(entry) = running_entry {
        entry.retry_attempt
    } else if let Some(entry) = waiting_entry {
        entry.retry_attempt
    } else if let Some(entry) = state.running.get(&issue_id) {
        entry.retry_attempt
    } else {
        retry_entry.map(|entry| entry.attempt)
    };

    let restart_count = current_retry_attempt.unwrap_or(0);

    let running_detail = running_entry.map(|entry| {
        let step_name = state.pipeline_runs.get(&entry.issue_id).and_then(|run| {
            run.step_states.iter().find_map(|(name, step_state)| {
                if matches!(step_state, StepState::Running { .. }) {
                    Some(name.clone())
                } else {
                    None
                }
            })
        });
        RunningDetail {
            run_id: entry.run_id.clone(),
            session_id: entry.session_id.clone(),
            step_name,
            turn_count: entry.turn_count,
            state: entry.issue.state.clone(),
            started_at: entry.started_at,
            last_event: entry.last_agent_event.clone(),
            last_message: entry.last_agent_message.clone(),
            last_event_at: entry.last_agent_timestamp,
            tokens: TokenSnapshot {
                input_tokens: entry.agent_input_tokens,
                output_tokens: entry.agent_output_tokens,
                total_tokens: entry.agent_total_tokens,
            },
        }
    });

    let retry_detail = retry_entry.map(retry_entry_to_row);
    let pending_input = waiting_entry.map(pending_input_summary);
    let current_interaction = waiting_entry.map(current_interaction_summary);

    let last_error = retry_entry.and_then(|e| e.error.clone());
    let finalize = if let Some((_, finalize_state)) = finalize_entry {
        FinalizeSnapshot {
            status: finalize_status_str(&finalize_state.status).to_string(),
            repos: finalize_state
                .repos
                .iter()
                .map(|repo| RepoFinalizeSnapshot {
                    repo: repo.repo.clone(),
                    mode: repo.mode.clone(),
                    approval_required: repo.approval_required,
                    status: finalize_status_str(&repo.status).to_string(),
                    last_error: repo.last_error.clone(),
                })
                .collect(),
        }
    } else {
        FinalizeSnapshot {
            status: "not_required".to_string(),
            repos: vec![],
        }
    };

    Some(IssueDetailSnapshot {
        issue_identifier,
        issue_id,
        status,
        workspace: WorkspaceInfo {
            path: workspace_path,
        },
        attempts: AttemptInfo {
            restart_count,
            current_retry_attempt,
        },
        running: running_detail,
        retry: retry_detail,
        pending_input,
        current_interaction,
        last_error,
        finalize,
    })
}

/// Convert a RunningEntry to a RunningSessionRow for the snapshot.
fn running_entry_to_row(
    entry: &RunningEntry,
    pipeline_runs: &HashMap<String, PipelineRun>,
) -> RunningSessionRow {
    let step_name = pipeline_runs.get(&entry.issue_id).and_then(|run| {
        run.step_states.iter().find_map(|(name, state)| {
            if matches!(state, StepState::Running { .. }) {
                Some(name.clone())
            } else {
                None
            }
        })
    });
    RunningSessionRow {
        issue_id: entry.issue_id.clone(),
        issue_identifier: entry.identifier.clone(),
        state: entry.issue.state.clone(),
        step_name,
        session_id: entry.session_id.clone(),
        turn_count: entry.turn_count,
        last_event: entry.last_agent_event.clone(),
        last_message: entry.last_agent_message.clone(),
        started_at: entry.started_at,
        last_event_at: entry.last_agent_timestamp,
        tokens: TokenSnapshot {
            input_tokens: entry.agent_input_tokens,
            output_tokens: entry.agent_output_tokens,
            total_tokens: entry.agent_total_tokens,
        },
    }
}

/// Convert a RetryEntry to a RetryRow for the snapshot.
fn retry_entry_to_row(entry: &RetryEntry) -> RetryRow {
    RetryRow {
        issue_id: entry.issue_id.clone(),
        issue_identifier: entry.identifier.clone(),
        attempt: entry.attempt,
        due_at_ms: entry.due_at_ms,
        error: entry.error.clone(),
    }
}

fn waiting_entry_to_row(
    entry: &crate::orchestrator::state::WaitingOnHumanEntry,
) -> WaitingInteractionRow {
    WaitingInteractionRow {
        issue_id: entry.issue_id.clone(),
        issue_identifier: entry.identifier.clone(),
        interaction_request_id: entry.interaction_request_id.clone(),
        step_name: entry.step_name.clone(),
        requested_at: entry.requested_at,
    }
}

fn current_interaction_summary(
    entry: &crate::orchestrator::state::WaitingOnHumanEntry,
) -> CurrentInteractionSummary {
    CurrentInteractionSummary {
        interaction_request_id: entry.interaction_request_id.clone(),
        step_name: entry.step_name.clone(),
        requested_at: entry.requested_at,
    }
}

fn pending_input_summary(
    entry: &crate::orchestrator::state::WaitingOnHumanEntry,
) -> PendingInputSummary {
    PendingInputSummary {
        kind: match &entry.kind {
            crate::interaction::InteractionKind::BrainstormPrompt => "brainstorm_prompt",
            crate::interaction::InteractionKind::ApprovalGate => "approval_gate",
            crate::interaction::InteractionKind::ManualDecision => "manual_decision",
        }
        .to_string(),
        prompt: entry.prompt.clone(),
        requested_at: entry.requested_at,
        context: PendingInputContext {
            interaction_request_id: entry.interaction_request_id.clone(),
            step_name: entry.step_name.clone(),
            agent_name: entry.agent_name.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::state::{OrchestratorState, WaitingOnHumanEntry};
    use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};
    use chrono::Utc;
    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            state: "In Progress".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    fn test_running_entry() -> RunningEntry {
        RunningEntry {
            issue_id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            run_id: Some("run-1".to_string()),
            issue: test_issue(),
            session_id: Some("session-abc".to_string()),
            agent_pid: Some("12345".to_string()),
            last_agent_event: Some("turn_completed".to_string()),
            last_agent_timestamp: Some(Utc::now()),
            last_agent_message: Some("Working on tests".to_string()),
            agent_input_tokens: 1200,
            agent_output_tokens: 800,
            agent_total_tokens: 2000,
            last_reported_input_tokens: 1200,
            last_reported_output_tokens: 800,
            last_reported_total_tokens: 2000,
            turn_count: 7,
            retry_attempt: None,
            started_at: Utc::now(),
        }
    }

    fn test_retry_entry() -> RetryEntry {
        RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 3,
            due_at_ms: 1711641600000,
            error: Some("no available orchestrator slots".to_string()),
        }
    }

    fn build_test_state() -> OrchestratorState {
        let mut state = OrchestratorState::new(30000, 10);
        state
            .running
            .insert("NODE_123".to_string(), test_running_entry());
        state
            .retry_attempts
            .insert("NODE_456".to_string(), test_retry_entry());
        state.claimed.insert("NODE_123".to_string());
        state.claimed.insert("NODE_456".to_string());
        state.agent_totals = AgentTotals {
            input_tokens: 5000,
            output_tokens: 2400,
            total_tokens: 7400,
            seconds_running: 120.5,
        };
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: "NODE_789".to_string(),
            identifier: "my-repo#77".to_string(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "review".to_string(),
            kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: None,
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
        });
        state
    }

    #[test]
    fn test_build_snapshot_counts() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.counts.running, 1);
        assert_eq!(snapshot.counts.retrying, 1);
        assert_eq!(snapshot.counts.waiting_on_human, 1);
    }

    #[test]
    fn runtime_snapshot_includes_waiting_interaction_count() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.counts.waiting_on_human, 1);
        assert_eq!(snapshot.waiting_on_human.len(), 1);

        let row = &snapshot.waiting_on_human[0];
        assert_eq!(row.issue_id, "NODE_789");
        assert_eq!(row.issue_identifier, "my-repo#77");
        assert_eq!(row.interaction_request_id, "interaction-1");
        assert_eq!(row.step_name, "review");
    }

    #[test]
    fn test_build_snapshot_running_row() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.running.len(), 1);
        let row = &snapshot.running[0];
        assert_eq!(row.issue_id, "NODE_123");
        assert_eq!(row.issue_identifier, "my-repo#42");
        assert_eq!(row.state, "In Progress");
        assert_eq!(row.session_id, Some("session-abc".to_string()));
        assert_eq!(row.turn_count, 7);
        assert_eq!(row.last_event, Some("turn_completed".to_string()));
        assert_eq!(row.last_message, Some("Working on tests".to_string()));
        assert_eq!(row.tokens.input_tokens, 1200);
        assert_eq!(row.tokens.output_tokens, 800);
        assert_eq!(row.tokens.total_tokens, 2000);
    }

    #[test]
    fn test_build_snapshot_retry_row() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.retrying.len(), 1);
        let row = &snapshot.retrying[0];
        assert_eq!(row.issue_id, "NODE_456");
        assert_eq!(row.issue_identifier, "my-repo#99");
        assert_eq!(row.attempt, 3);
        assert_eq!(
            row.error,
            Some("no available orchestrator slots".to_string())
        );
    }

    #[test]
    fn test_build_snapshot_agent_totals() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.agent_totals.input_tokens, 5000);
        assert_eq!(snapshot.agent_totals.output_tokens, 2400);
        assert_eq!(snapshot.agent_totals.total_tokens, 7400);
        // seconds_running should be >= cumulative (120.5) because active sessions add elapsed
        assert!(snapshot.agent_totals.seconds_running >= 120.5);
    }

    #[test]
    fn test_build_snapshot_rate_limits_null() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);
        assert!(snapshot.rate_limits.is_none());
    }

    #[test]
    fn test_build_snapshot_json_shape() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);
        let json = serde_json::to_value(&snapshot).unwrap();

        // Verify top-level keys match SPEC.md Section 13.7.2
        assert!(json.get("generated_at").is_some());
        assert!(json.get("counts").is_some());
        assert!(json.get("running").is_some());
        assert!(json.get("retrying").is_some());
        assert!(json.get("waiting_on_human").is_some());
        assert!(json.get("agent_totals").is_some());
        assert!(json.get("rate_limits").is_some());
        assert!(json.get("poll_interval_ms").is_some());
        assert!(json.get("last_tick_at").is_some());

        // Verify counts sub-keys
        let counts = json.get("counts").unwrap();
        assert!(counts.get("running").is_some());
        assert!(counts.get("retrying").is_some());
        assert!(counts.get("waiting_on_human").is_some());

        // Verify running row sub-keys
        let running = json.get("running").unwrap().as_array().unwrap();
        assert_eq!(running.len(), 1);
        let row = &running[0];
        assert!(row.get("issue_id").is_some());
        assert!(row.get("issue_identifier").is_some());
        assert!(row.get("state").is_some());
        assert!(row.get("session_id").is_some());
        assert!(row.get("turn_count").is_some());
        assert!(row.get("last_event").is_some());
        assert!(row.get("last_message").is_some());
        assert!(row.get("started_at").is_some());
        assert!(row.get("last_event_at").is_some());
        assert!(row.get("tokens").is_some());

        // Verify tokens sub-keys
        let tokens = row.get("tokens").unwrap();
        assert!(tokens.get("input_tokens").is_some());
        assert!(tokens.get("output_tokens").is_some());
        assert!(tokens.get("total_tokens").is_some());

        // Verify agent_totals sub-keys
        let totals = json.get("agent_totals").unwrap();
        assert!(totals.get("input_tokens").is_some());
        assert!(totals.get("output_tokens").is_some());
        assert!(totals.get("total_tokens").is_some());
        assert!(totals.get("seconds_running").is_some());
    }

    #[test]
    fn test_build_snapshot_empty_state() {
        let state = OrchestratorState::new(30000, 10);

        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.counts.running, 0);
        assert_eq!(snapshot.counts.retrying, 0);
        assert_eq!(snapshot.counts.waiting_on_human, 0);
        assert!(snapshot.running.is_empty());
        assert!(snapshot.retrying.is_empty());
        assert!(snapshot.waiting_on_human.is_empty());
        assert_eq!(snapshot.agent_totals.seconds_running, 0.0);
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert!(snapshot.last_tick_at.is_none());
    }

    #[test]
    fn test_build_issue_snapshot_found_running() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces");

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#42");
        assert_eq!(detail.issue_id, "NODE_123");
        assert_eq!(detail.status, "running");
        assert_eq!(detail.workspace.path, "/tmp/workspaces/my-repo_42");
        assert!(detail.running.is_some());
        assert!(detail.retry.is_none());

        let running = detail.running.unwrap();
        assert_eq!(running.turn_count, 7);
        assert_eq!(running.session_id, Some("session-abc".to_string()));
    }

    #[test]
    fn test_build_issue_snapshot_found_retrying() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#99", "/tmp/workspaces");

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#99");
        assert_eq!(detail.issue_id, "NODE_456");
        assert_eq!(detail.status, "retrying");
        assert!(detail.running.is_none());
        assert!(detail.retry.is_some());
        assert_eq!(
            detail.last_error,
            Some("no available orchestrator slots".to_string())
        );
    }

    #[test]
    fn test_build_issue_snapshot_not_found() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "nonexistent#999", "/tmp/workspaces");
        assert!(detail.is_none());
    }

    #[test]
    fn issue_detail_snapshot_includes_current_interaction_summary() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#77", "/tmp/workspaces").unwrap();

        assert_eq!(detail.status, "waiting_on_human");
        let interaction = detail.current_interaction.unwrap();
        assert_eq!(interaction.interaction_request_id, "interaction-1");
        assert_eq!(interaction.step_name, "review");
    }

    #[test]
    fn issue_detail_snapshot_preserves_retry_attempt_for_waiting_issue() {
        let mut state = build_test_state();
        state.add_running(
            &Issue {
                id: "NODE_789".to_string(),
                identifier: "my-repo#77".to_string(),
                title: "Waiting issue".to_string(),
                description: None,
                priority: None,
                state: "In Progress".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: None,
                updated_at: None,
            },
            Some(3),
        );
        let entry = state.remove_running("NODE_789").unwrap();
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: entry.issue_id,
            identifier: entry.identifier,
            interaction_request_id: "interaction-1".to_string(),
            step_name: "review".to_string(),
            kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: Some(3),
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
        });

        let detail = build_issue_snapshot(&state, "my-repo#77", "/tmp/workspaces").unwrap();

        assert_eq!(detail.attempts.current_retry_attempt, Some(3));
        assert_eq!(detail.attempts.restart_count, 3);
    }

    #[test]
    fn test_issue_snapshot_json_shape() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces").unwrap();
        let json = serde_json::to_value(&detail).unwrap();

        assert!(json.get("issue_identifier").is_some());
        assert!(json.get("issue_id").is_some());
        assert!(json.get("status").is_some());
        assert!(json.get("workspace").is_some());
        assert!(json.get("attempts").is_some());
        assert!(json.get("running").is_some());
        assert!(json.get("retry").is_some());
        assert!(json.get("current_interaction").is_some());
        assert!(json.get("last_error").is_some());

        let workspace = json.get("workspace").unwrap();
        assert!(workspace.get("path").is_some());

        let attempts = json.get("attempts").unwrap();
        assert!(attempts.get("restart_count").is_some());
        assert!(attempts.get("current_retry_attempt").is_some());
    }

    #[test]
    fn test_build_snapshot_poll_fields() {
        let mut state = OrchestratorState::new(30000, 10);
        // No tick yet
        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert!(snapshot.last_tick_at.is_none());

        // After a tick
        let tick_time = Utc::now();
        state.last_tick_at = Some(tick_time);
        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert_eq!(snapshot.last_tick_at, Some(tick_time));
    }

    #[test]
    fn test_retry_row_due_at_ms_passthrough() {
        let entry = RetryEntry {
            issue_id: "NODE_789".to_string(),
            identifier: "test#1".to_string(),
            attempt: 1,
            due_at_ms: 1711641600000,
            error: None,
        };

        let row = retry_entry_to_row(&entry);
        assert_eq!(row.due_at_ms, 1711641600000);
    }
}
