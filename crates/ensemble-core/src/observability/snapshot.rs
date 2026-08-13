use crate::acceptance::AcceptanceAttempt;
use crate::attention::AttentionItem;
use crate::history::artifacts::{RunArtifacts, StepTranscriptArtifact};
use crate::interaction::store::InteractionStore;
use crate::observability::capabilities::{IssueActionCapabilities, StepActionCapabilities};
use crate::orchestrator::state::{FinalizeStatus, OrchestratorState, RateLimitSnapshot};
use crate::pipeline::engine::{PipelineRun, StepState};
use crate::tracker::model::{RetryEntry, RunningEntry};
use crate::workspace::key::issue_workspace_key;
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
    pub attention_items: Vec<AttentionItem>,
    pub completed: Vec<CompletedRow>,
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
    pub completed: usize,
}

/// A single row in the completed issues list.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CompletedRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub status: String,
    pub completed_at: DateTime<Utc>,
    pub capabilities: IssueActionCapabilities,
}

/// A compact row for an issue currently waiting on human input.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct WaitingInteractionRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub interaction_request_id: String,
    pub step_name: String,
    pub requested_at: DateTime<Utc>,
    pub capabilities: IssueActionCapabilities,
}

/// Compact issue-detail summary for the current waiting interaction.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CurrentInteractionSummary {
    pub interaction_request_id: String,
    pub step_name: String,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PendingInputSummary {
    pub ask_id: String,
    pub question: String,
    pub why_blocked: String,
    pub suggested_answer: Option<String>,
    pub extra_context: Option<String>,
    pub step_name: String,
    pub agent_name: String,
    pub requested_at: DateTime<Utc>,
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
    pub capabilities: IssueActionCapabilities,
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
    pub capabilities: IssueActionCapabilities,
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
    pub attention_items: Vec<AttentionItem>,
    pub last_error: Option<String>,
    pub finalize: FinalizeSnapshot,
    pub workflow_steps: Vec<WorkflowStepInfo>,
    pub issue: IssueSummary,
    pub artifacts: Option<RunArtifacts>,
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    pub capabilities: IssueActionCapabilities,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<crate::orchestrator::delivery_observation::DeliveryObservation>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct WorkflowStepInfo {
    pub name: String,
    pub agent: String,
    pub kind: String,
    pub dependencies: Vec<String>,
    pub state: String,
    pub can_navigate: bool,
    pub capabilities: StepActionCapabilities,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct IssueSummary {
    pub title: String,
    pub description: Option<String>,
    pub labels: Vec<String>,
    pub priority: Option<i32>,
    pub url: Option<String>,
}

/// Step detail snapshot for GET /api/v1/{identifier}/step/{step_name}.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StepDetailSnapshot {
    pub issue_identifier: String,
    pub issue_id: String,
    pub step_name: String,
    pub status: String,
    pub agent: String,
    pub kind: String,
    pub dependencies: Vec<String>,
    pub can_navigate: bool,
    pub capabilities: StepActionCapabilities,
    pub verdict: Option<String>,
    pub run_id: Option<String>,
    pub transcript: Option<StepTranscriptArtifact>,
    pub recent_events: Vec<crate::timeline::model::TimelineEventRecord>,
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

    let mut completed_rows: Vec<CompletedRow> = state
        .completed
        .values()
        .map(|entry| CompletedRow {
            issue_id: entry.issue_id.clone(),
            issue_identifier: entry.identifier.clone(),
            status: entry.status.clone(),
            completed_at: entry.completed_at,
            capabilities: IssueActionCapabilities::for_issue(false, false, false, None),
        })
        .collect();
    completed_rows.sort_by_key(|row| std::cmp::Reverse(row.completed_at));

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
            completed: completed_rows.len(),
        },
        running: running_rows,
        retrying: retry_rows,
        waiting_on_human: waiting_rows,
        attention_items: vec![],
        completed: completed_rows,
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

/// Data extracted from state needed to build a step detail snapshot.
/// This allows releasing the state lock before doing I/O.
pub struct StepDetailState {
    pub issue_id: String,
    pub status: String,
    pub verdict: Option<String>,
    pub agent: String,
    pub kind: String,
    pub dependencies: Vec<String>,
    pub can_navigate: bool,
    pub run_id: Option<String>,
}

/// Extract step detail data from state without doing I/O.
/// Returns None if the identifier or step_name is not found.
pub fn extract_step_detail_state(
    state: &OrchestratorState,
    identifier: &str,
    step_name: &str,
) -> Option<StepDetailState> {
    let issue_entry = state.running.values().find(|e| e.identifier == identifier);

    let issue_id = if let Some(entry) = issue_entry {
        entry.issue_id.clone()
    } else if let Some(entry) = state
        .retry_attempts
        .values()
        .find(|e| e.identifier == identifier)
    {
        entry.issue_id.clone()
    } else if let Some(entry) = state
        .waiting_on_human
        .values()
        .find(|e| e.identifier == identifier)
    {
        entry.issue_id.clone()
    } else if let Some((issue_id, _)) = state
        .finalize
        .iter()
        .find(|(_, finalize)| finalize.issue_identifier == identifier)
    {
        issue_id.clone()
    } else {
        let entry = state
            .completed
            .values()
            .find(|e| e.identifier == identifier)?;
        entry.issue_id.clone()
    };

    // Try to get step info from pipeline config/run first
    let from_pipeline = state.pipeline_configs.get(&issue_id).and_then(|config| {
        config
            .steps
            .iter()
            .find(|s| s.name == step_name)
            .map(|step_config| {
                let pipeline_run = state.pipeline_runs.get(&issue_id);
                let step_state = pipeline_run.and_then(|run| run.step_states.get(step_name));

                let status = step_state
                    .map(|s| match s {
                        StepState::Pending => "pending",
                        StepState::Running { .. } => "running",
                        StepState::Passed => "passed",
                        StepState::Failed { .. } => "failed",
                        StepState::Errored { .. } => "failed",
                        StepState::BlockedOnHuman { .. } => "waiting",
                        StepState::AwaitingApproval { .. } => "waiting",
                    })
                    .unwrap_or("pending")
                    .to_string();

                let verdict = step_state.and_then(|s| match s {
                    StepState::Passed => Some("success".to_string()),
                    StepState::Failed { summary } => Some(summary.clone()),
                    StepState::Errored { error } => Some(error.clone()),
                    _ => None,
                });

                StepDetailState {
                    issue_id: issue_id.clone(),
                    status,
                    verdict,
                    agent: step_config.agent.clone(),
                    kind: step_config.kind.to_string(),
                    dependencies: step_config.depends.clone().unwrap_or_default(),
                    can_navigate: pipeline_run
                        .map(|r| r.step_states.contains_key(step_name))
                        .unwrap_or(false),
                    run_id: state
                        .issue_run_ids
                        .get(&issue_id)
                        .cloned()
                        .or_else(|| state.running.get(&issue_id).and_then(|e| e.run_id.clone()))
                        .or_else(|| {
                            state
                                .completed
                                .get(&issue_id)
                                .and_then(|e| e.run_id.clone())
                        }),
                }
            })
    });

    // Fall back to completed entry workflow_steps for completed issues
    from_pipeline.or_else(|| {
        state.completed.get(&issue_id).and_then(|completed| {
            completed
                .workflow_steps
                .iter()
                .find(|s| s.name == step_name)
                .map(|step| StepDetailState {
                    issue_id: issue_id.clone(),
                    status: step.state.clone(),
                    verdict: if step.state == "failed" || step.state == "rejected" {
                        Some("error".to_string())
                    } else if step.state == "passed" {
                        Some("success".to_string())
                    } else {
                        None
                    },
                    agent: step.agent.clone(),
                    kind: step.kind.clone(),
                    dependencies: step.dependencies.clone(),
                    can_navigate: step.can_navigate,
                    run_id: completed.run_id.clone(),
                })
        })
    })
}

/// Build a StepDetailSnapshot for a specific step within an issue.
///
/// Returns None if the identifier or step_name is not found.
/// NOTE: This function does synchronous I/O. Consider using extract_step_detail_state
/// to get data without I/O, then do I/O separately.
pub fn build_step_detail_snapshot(
    state: &OrchestratorState,
    identifier: &str,
    step_name: &str,
    workspace_root: &str,
    max_events: usize,
) -> Option<StepDetailSnapshot> {
    let detail_state = extract_step_detail_state(state, identifier, step_name)?;

    let recent_events = if let Some(ref run_id) = detail_state.run_id {
        crate::history_store::store::HistoryStore::new_blocking(
            std::path::PathBuf::from(workspace_root)
                .join(".ensemble")
                .join("history.db"),
        )
        .ok()
        .and_then(|store| {
            store
                .read_recent_step_events_blocking(run_id, identifier, step_name, max_events)
                .ok()
        })
        .unwrap_or_default()
    } else {
        vec![]
    };

    Some(StepDetailSnapshot {
        issue_identifier: identifier.to_string(),
        issue_id: detail_state.issue_id,
        step_name: step_name.to_string(),
        status: detail_state.status,
        agent: detail_state.agent,
        kind: detail_state.kind,
        dependencies: detail_state.dependencies,
        can_navigate: detail_state.can_navigate,
        capabilities: StepActionCapabilities::for_step(detail_state.can_navigate),
        verdict: detail_state.verdict,
        run_id: detail_state.run_id,
        transcript: None,
        recent_events,
    })
}

/// Build an IssueDetailSnapshot for a specific issue by identifier.
///
/// Returns None if the identifier is not found in running or retry maps.
/// If interaction_store is provided, pending_input will be populated with full interaction details.
pub async fn build_issue_snapshot(
    state: &OrchestratorState,
    identifier: &str,
    workspace_root: &str,
    interaction_store: Option<&InteractionStore>,
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

    let completed_entry = state
        .completed
        .values()
        .find(|e| e.identifier == identifier);

    if running_entry.is_none()
        && retry_entry.is_none()
        && waiting_entry.is_none()
        && finalize_entry.is_none()
        && completed_entry.is_none()
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
        let entry = completed_entry?;
        (entry.issue_id.clone(), entry.identifier.clone())
    };

    let workspace_key = issue_workspace_key(&issue_id);
    let workspace_path = format!("{}/{}", workspace_root, workspace_key);

    let status = if running_entry.is_some() {
        "running".to_string()
    } else if waiting_entry.is_some() {
        "waiting_on_human".to_string()
    } else if let Some((_, finalize)) = finalize_entry {
        format!("finalize_{}", finalize_status_str(&finalize.status))
    } else if let Some(entry) = completed_entry {
        entry.status.clone()
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

    let interaction = if let (Some(entry), Some(store)) = (waiting_entry, interaction_store) {
        store
            .get(&entry.interaction_request_id)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let pending_input = waiting_entry
        .zip(interaction.as_ref())
        .map(|(entry, interaction)| pending_input_summary(entry, interaction));
    // Note: store errors are intentionally ignored for best-effort snapshot generation
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
                    observation: repo.observation.clone(),
                })
                .collect(),
        }
    } else {
        FinalizeSnapshot {
            status: "not_required".to_string(),
            repos: vec![],
        }
    };

    let artifacts = state.artifacts.get(&issue_id).cloned();
    let pipeline_run = state.pipeline_runs.get(&issue_id);
    let config = state.pipeline_configs.get(&issue_id);

    // Try to get workflow_steps from running config first, then from completed entry
    let workflow_steps = if let Some(config) = config {
        config
            .steps
            .iter()
            .map(|step| {
                let state_str = pipeline_run
                    .and_then(|run| run.step_states.get(&step.name))
                    .map(|s| match s {
                        StepState::Pending => "pending",
                        StepState::Running { .. } => "running",
                        StepState::Passed => "passed",
                        StepState::Failed { .. } => "failed",
                        StepState::Errored { .. } => "failed",
                        StepState::BlockedOnHuman { .. } => "waiting",
                        StepState::AwaitingApproval { .. } => "waiting",
                    })
                    .unwrap_or("pending");
                WorkflowStepInfo {
                    name: step.name.clone(),
                    agent: step.agent.clone(),
                    kind: step.kind.to_string(),
                    dependencies: step.depends.clone().unwrap_or_default(),
                    state: state_str.to_string(),
                    can_navigate: pipeline_run
                        .map(|r| r.step_states.contains_key(&step.name))
                        .unwrap_or(false),
                    capabilities: StepActionCapabilities::for_step(
                        pipeline_run
                            .map(|r| r.step_states.contains_key(&step.name))
                            .unwrap_or(false),
                    ),
                }
            })
            .collect()
    } else if let Some(completed) = completed_entry {
        completed
            .workflow_steps
            .iter()
            .map(|step| WorkflowStepInfo {
                name: step.name.clone(),
                agent: step.agent.clone(),
                kind: step.kind.clone(),
                dependencies: step.dependencies.clone(),
                state: step.state.clone(),
                can_navigate: step.can_navigate,
                capabilities: StepActionCapabilities::for_step(step.can_navigate),
            })
            .collect()
    } else {
        vec![]
    };

    // Try to get issue info from running entry first, then from completed entry
    let issue_summary = running_entry
        .map(|e| IssueSummary {
            title: e.issue.title.clone(),
            description: e.issue.description.clone(),
            labels: e.issue.labels.clone(),
            priority: e.issue.priority,
            url: e.issue.url.clone(),
        })
        .or_else(|| {
            completed_entry.map(|e| IssueSummary {
                title: e.issue.title.clone(),
                description: e.issue.description.clone(),
                labels: e.issue.labels.clone(),
                priority: e.issue.priority,
                url: e.issue.url.clone(),
            })
        })
        .unwrap_or_else(|| IssueSummary {
            title: identifier.to_string(),
            description: None,
            labels: vec![],
            priority: None,
            url: None,
        });

    let mut capabilities = IssueActionCapabilities::for_issue(
        running_entry.is_some(),
        retry_entry.is_some(),
        waiting_entry.is_some(),
        finalize_entry.map(|(_, finalize)| &finalize.status),
    );
    if waiting_entry.is_some() && interaction_store.is_some() {
        capabilities.apply_interaction(interaction.as_ref());
    }

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
        attention_items: vec![],
        last_error,
        finalize,
        workflow_steps,
        issue: issue_summary,
        artifacts,
        acceptance_attempts: pipeline_run
            .map(|run| run.acceptance_attempts.clone())
            .unwrap_or_default(),
        capabilities,
    })
}

/// Best-effort enrichment for pending-input details using the interaction store.
/// Intended to run outside orchestrator-state lock scopes.
pub async fn enrich_issue_snapshot_pending_input(
    detail: &mut IssueDetailSnapshot,
    interaction_store: &InteractionStore,
) {
    let Some(current) = detail.current_interaction.as_ref() else {
        return;
    };

    let interaction = interaction_store
        .get(&current.interaction_request_id)
        .await
        .ok()
        .flatten();

    detail.capabilities.apply_interaction(interaction.as_ref());
    if detail.pending_input.is_none() {
        if let Some(interaction) = interaction {
            detail.pending_input = Some(pending_input_from_current(current, &interaction));
        }
    }
}

/// Enrich waiting runtime rows from their durable interaction records after the state lock is released.
pub async fn enrich_runtime_snapshot_interactions(
    snapshot: &mut RuntimeSnapshot,
    interaction_store: &InteractionStore,
) {
    for row in &mut snapshot.waiting_on_human {
        let interaction = interaction_store
            .get(&row.interaction_request_id)
            .await
            .ok()
            .flatten();
        row.capabilities.apply_interaction(interaction.as_ref());
    }
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
        capabilities: IssueActionCapabilities::for_issue(true, false, false, None),
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
        capabilities: IssueActionCapabilities::for_issue(false, true, false, None),
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
        capabilities: IssueActionCapabilities::for_issue(false, false, true, None),
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
    interaction: &crate::interaction::model::InteractionRequest,
) -> PendingInputSummary {
    let suggested_answer = match interaction.options.len() {
        0 => None,
        1 => interaction.options.first().cloned(),
        _ => Some(interaction.options.join(", ")),
    };
    PendingInputSummary {
        ask_id: entry.interaction_request_id.clone(),
        question: interaction.title.clone(),
        why_blocked: interaction.body.clone(),
        suggested_answer,
        extra_context: interaction.step_tracker_state.clone(),
        step_name: entry.step_name.clone(),
        agent_name: interaction.agent_name.clone(),
        requested_at: entry.requested_at,
    }
}

fn pending_input_from_current(
    current: &CurrentInteractionSummary,
    interaction: &crate::interaction::model::InteractionRequest,
) -> PendingInputSummary {
    let suggested_answer = match interaction.options.len() {
        0 => None,
        1 => interaction.options.first().cloned(),
        _ => Some(interaction.options.join(", ")),
    };
    PendingInputSummary {
        ask_id: current.interaction_request_id.clone(),
        question: interaction.title.clone(),
        why_blocked: interaction.body.clone(),
        suggested_answer,
        extra_context: interaction.step_tracker_state.clone(),
        step_name: current.step_name.clone(),
        agent_name: interaction.agent_name.clone(),
        requested_at: current.requested_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acceptance::{
        AcceptanceAttempt, AcceptanceEvidence, AcceptanceOutput, AcceptanceResult,
        AcceptanceStatus, AcceptanceTiming,
    };
    use crate::config::ensemble::{
        ConcurrencyConfig, EnsembleConfig, OnFailure, StepConfig, StepKind, TrackerConfig,
    };
    use crate::orchestrator::state::{OrchestratorState, WaitingOnHumanEntry};
    use crate::pipeline::engine::{PipelineRun, StepState};
    use crate::timeline::model::TimelineEventRecord;
    use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};
    use chrono::Utc;
    use tempfile::TempDir;
    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            tracker_position: None,
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
            retry_from_step: None,
            with_fixup: false,
        }
    }

    fn build_test_state() -> OrchestratorState {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
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
            run_id: None,
            issue: None,
        });
        state
    }

    fn test_config_with_steps() -> std::sync::Arc<EnsembleConfig> {
        std::sync::Arc::new(EnsembleConfig {
            pipelines: Default::default(),
            scheduler: Default::default(),
            workflow_selection: Default::default(),
            tracker: TrackerConfig {
                kind: "todo_file".to_string(),
                active_states: vec!["In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                path: Some("test.toml".into()),
                endpoint: None,
                gh_hostname: None,
                api_key: None,
                repository: None,
                project_number: None,
                labels_filter: vec![],
                notion: None,
                github: None,
            },
            repos: vec![],
            agents: HashMap::new(),
            steps: vec![
                StepConfig {
                    name: "build".to_string(),
                    kind: StepKind::Agent,
                    agent: "builder".to_string(),
                    depends: None,
                    tracker_state: None,
                    timeout_ms: None,
                    approval: None,
                    on_failure: OnFailure::RetryIssue,
                    fixup_agent: None,
                    resource_requests: Default::default(),
                    affected_paths: None,
                    output_schema: None,
                    artifact_snapshot: None,
                    artifact_inputs: Vec::new(),
                    artifact_access: Default::default(),
                },
                StepConfig {
                    name: "review".to_string(),
                    kind: StepKind::Agent,
                    agent: "reviewer".to_string(),
                    depends: Some(vec!["build".to_string()]),
                    tracker_state: None,
                    timeout_ms: None,
                    approval: None,
                    on_failure: OnFailure::RetryIssue,
                    fixup_agent: None,
                    resource_requests: Default::default(),
                    affected_paths: None,
                    output_schema: None,
                    artifact_snapshot: None,
                    artifact_inputs: Vec::new(),
                    artifact_access: Default::default(),
                },
            ],
            on_success: "finalize".to_string(),
            on_failure: "retry".to_string(),
            concurrency: ConcurrencyConfig::default(),
            max_cycles: 5,
            polling: Default::default(),
            workspace: Default::default(),
            hooks: Default::default(),
            agent: Default::default(),
            human_interaction: Default::default(),
            acceptance: Default::default(),
        })
    }

    fn attach_pipeline_state(state: &mut OrchestratorState, issue_id: &str) {
        use crate::pipeline::dag::build_dag;

        let config = test_config_with_steps();
        let dag = build_dag(&config.steps).expect("valid dag");
        let mut pipeline_run = PipelineRun::new(issue_id.to_string(), 1, dag);
        pipeline_run
            .step_states
            .insert("build".to_string(), StepState::Passed);
        pipeline_run.step_states.insert(
            "review".to_string(),
            StepState::Running {
                session_id: "session-abc".to_string(),
            },
        );

        state.insert_pipeline_run(issue_id, pipeline_run, config);
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
    fn running_rows_expose_only_stop_and_inspect_as_enabled_actions() {
        let snapshot = build_state_snapshot(&build_test_state());
        let capabilities = &snapshot.running[0].capabilities;

        assert!(capabilities.inspect().is_enabled());
        assert!(capabilities.stop().is_enabled());
        assert!(!capabilities.retry().is_enabled());
        assert_eq!(
            capabilities.retry().disabled_reason(),
            Some("This issue is not retrying.")
        );
        assert!(!capabilities.guide().is_enabled());
        assert_eq!(
            capabilities.guide().disabled_reason(),
            Some("Guidance is not supported in Mission Control."),
        );
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
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

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

    #[tokio::test]
    async fn workspace_identity_path_running_snapshot_uses_immutable_issue_id() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None).await;

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#42");
        assert_eq!(detail.issue_id, "NODE_123");
        assert_eq!(detail.status, "running");
        assert_eq!(
            detail.workspace.path,
            format!("/tmp/workspaces/{}", issue_workspace_key("NODE_123"))
        );
        assert!(detail.running.is_some());
        assert!(detail.retry.is_none());

        let running = detail.running.unwrap();
        assert_eq!(running.turn_count, 7);
        assert_eq!(running.session_id, Some("session-abc".to_string()));
    }

    #[tokio::test]
    async fn workspace_identity_path_retry_snapshot_uses_immutable_issue_id() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#99", "/tmp/workspaces", None).await;

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#99");
        assert_eq!(detail.issue_id, "NODE_456");
        assert_eq!(detail.status, "retrying");
        assert_eq!(
            detail.workspace.path,
            format!("/tmp/workspaces/{}", issue_workspace_key("NODE_456"))
        );
        assert!(detail.running.is_none());
        assert!(detail.retry.is_some());
        assert_eq!(
            detail.last_error,
            Some("no available orchestrator slots".to_string())
        );
    }

    #[tokio::test]
    async fn test_build_issue_snapshot_not_found() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "nonexistent#999", "/tmp/workspaces", None).await;
        assert!(detail.is_none());
    }

    #[tokio::test]
    async fn workspace_identity_path_waiting_snapshot_uses_immutable_issue_id() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#77", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert_eq!(detail.status, "waiting_on_human");
        assert_eq!(
            detail.workspace.path,
            format!("/tmp/workspaces/{}", issue_workspace_key("NODE_789"))
        );
        let interaction = detail.current_interaction.unwrap();
        assert_eq!(interaction.interaction_request_id, "interaction-1");
        assert_eq!(interaction.step_name, "review");
    }

    #[tokio::test]
    async fn workspace_identity_path_finalizing_snapshot_uses_immutable_issue_id() {
        let mut state = build_test_state();
        state.set_finalize_state(
            "NODE_FINAL",
            crate::orchestrator::state::IssueFinalizeState {
                issue_identifier: "my-repo#final".to_string(),
                status: FinalizeStatus::InProgress,
                repos: Vec::new(),
            },
        );

        let detail = build_issue_snapshot(&state, "my-repo#final", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert_eq!(
            detail.workspace.path,
            format!("/tmp/workspaces/{}", issue_workspace_key("NODE_FINAL"))
        );
    }

    #[tokio::test]
    async fn issue_detail_snapshot_preserves_retry_attempt_for_waiting_issue() {
        let mut state = build_test_state();
        state.add_running(
            &Issue {
                id: "NODE_789".to_string(),
                identifier: "my-repo#77".to_string(),
                title: "Waiting issue".to_string(),
                description: None,
                priority: None,
                tracker_position: None,
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
            run_id: None,
            issue: None,
        });

        let detail = build_issue_snapshot(&state, "my-repo#77", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert_eq!(detail.attempts.current_retry_attempt, Some(3));
        assert_eq!(detail.attempts.restart_count, 3);
    }

    #[tokio::test]
    async fn test_issue_snapshot_json_shape() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None)
            .await
            .unwrap();
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

        assert!(json.get("workflow_steps").is_some());
        assert!(json.get("issue").is_some());

        let issue = json.get("issue").unwrap();
        assert!(issue.get("title").is_some());
        assert!(issue.get("labels").is_some());
    }

    #[tokio::test]
    async fn test_issue_snapshot_with_workflow_steps() {
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");

        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None)
            .await
            .unwrap();
        let json = serde_json::to_value(&detail).unwrap();

        let workflow_steps = json.get("workflow_steps").unwrap().as_array().unwrap();
        assert_eq!(workflow_steps.len(), 2);

        let build_step = workflow_steps
            .iter()
            .find(|s| s.get("name").unwrap() == "build")
            .unwrap();
        assert_eq!(build_step.get("state").unwrap(), "passed");
        assert_eq!(build_step.get("agent").unwrap(), "builder");
        assert!(build_step.get("can_navigate").unwrap().as_bool().unwrap());

        let review_step = workflow_steps
            .iter()
            .find(|s| s.get("name").unwrap() == "review")
            .unwrap();
        assert_eq!(review_step.get("state").unwrap(), "running");
        assert_eq!(review_step.get("agent").unwrap(), "reviewer");
    }

    #[tokio::test]
    async fn issue_snapshot_projects_ordered_partial_acceptance_attempts_from_live_run() {
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");
        let mut release_notes = AcceptanceResult::new(
            "release notes".to_string(),
            AcceptanceStatus::Failed,
            "release notes are missing".to_string(),
            AcceptanceEvidence::File {
                repo: "ensemble".to_string(),
                path: "docs/release.md".to_string(),
                observation: crate::acceptance::FileObservation::Missing,
            },
        );
        release_notes.timing = AcceptanceTiming::Observed {
            started_at: chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 8, 4, 9, 0, 0)
                .single()
                .unwrap(),
            completed_at: chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 8, 4, 9, 0, 1)
                .single()
                .unwrap(),
            duration_ms: 1_000,
        };
        let attempts = vec![
            AcceptanceAttempt {
                cycle: 1,
                results: vec![AcceptanceResult::new(
                    "unit tests".to_string(),
                    AcceptanceStatus::Passed,
                    "tests passed".to_string(),
                    AcceptanceEvidence::Command {
                        exit_code: Some(0),
                        stdout: AcceptanceOutput {
                            tail: "ok".to_string(),
                            total_bytes: 2,
                            truncated: false,
                        },
                        stderr: AcceptanceOutput {
                            tail: String::new(),
                            total_bytes: 0,
                            truncated: false,
                        },
                    },
                )],
            },
            AcceptanceAttempt {
                cycle: 2,
                results: vec![release_notes],
            },
        ];
        state
            .pipeline_runs
            .get_mut("NODE_123")
            .unwrap()
            .acceptance_attempts = attempts.clone();

        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert_eq!(detail.acceptance_attempts, attempts);
    }

    #[tokio::test]
    async fn issue_snapshot_preserves_an_empty_acceptance_attempt_sequence() {
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");

        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert!(detail.acceptance_attempts.is_empty());
    }

    #[tokio::test]
    async fn workspace_identity_path_completed_snapshot_retains_identity_and_workflow() {
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");
        state.complete_issue("NODE_123", Some("completed_succeeded".to_string()), None);
        // Simulate what the orchestrator does: remove from running after completing
        state.running.remove("NODE_123");

        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces", None)
            .await
            .unwrap();

        assert_eq!(detail.status, "completed_succeeded");
        assert_eq!(detail.issue.title, "Fix the bug");
        assert_eq!(detail.issue.labels, vec!["bug".to_string()]);
        assert_eq!(detail.workflow_steps.len(), 2);
        assert_eq!(detail.workflow_steps[0].name, "build");
        assert_eq!(detail.workflow_steps[0].state, "passed");
        assert_eq!(detail.workflow_steps[1].name, "review");
        assert_eq!(detail.workflow_steps[1].state, "running");
        assert_eq!(
            detail.workspace.path,
            format!("/tmp/workspaces/{}", issue_workspace_key("NODE_123"))
        );
    }

    #[test]
    fn runtime_snapshot_includes_completed_entries() {
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");
        state.complete_issue("NODE_123", Some("completed_succeeded".to_string()), None);

        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.completed.len(), 1);
        assert_eq!(snapshot.completed[0].issue_identifier, "my-repo#42");
        assert_eq!(snapshot.completed[0].status, "completed_succeeded");
    }

    #[test]
    fn step_detail_reads_recent_events_from_run_id_storage() {
        let temp_dir = TempDir::new().unwrap();
        let mut state = build_test_state();
        attach_pipeline_state(&mut state, "NODE_123");

        let run_id = state
            .running
            .get("NODE_123")
            .and_then(|entry| entry.run_id.clone())
            .expect("run id should exist");
        let store = crate::history_store::store::HistoryStore::new_blocking(
            temp_dir.path().join(".ensemble").join("history.db"),
        )
        .unwrap();
        let record = TimelineEventRecord {
            run_id: run_id.clone(),
            issue_identifier: "my-repo#42".to_string(),
            sequence: 1,
            timestamp: Utc::now(),
            event_type: "step_started".to_string(),
            step_name: Some("review".to_string()),
            attempt: 1,
            detail: "started review".to_string(),
            verdict: None,
            tool_name: None,
        };
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(store.append_timeline_event(&record))
            .unwrap();

        let detail = build_step_detail_snapshot(
            &state,
            "my-repo#42",
            "review",
            temp_dir.path().to_str().unwrap(),
            50,
        )
        .unwrap();

        assert_eq!(detail.recent_events.len(), 1);
        assert_eq!(detail.recent_events[0].detail, "started review");
    }

    #[test]
    fn test_build_snapshot_poll_fields() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
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
            retry_from_step: None,
            with_fixup: false,
        };

        let row = retry_entry_to_row(&entry);
        assert_eq!(row.due_at_ms, 1711641600000);
    }
}
