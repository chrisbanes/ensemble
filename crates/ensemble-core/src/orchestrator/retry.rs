use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::interaction::{InteractionError, InteractionRequest, InteractionStore};
use crate::observability::events_contract::{ISSUE_RETRY_CANCELLED, ISSUE_RETRY_SCHEDULED};
use crate::tracker::model::RetryEntry;

use super::pipeline_journal::{
    PipelineRunJournal, PipelineTransitionInput, PipelineTransitionKind,
};
use super::state::OrchestratorState;

/// Continuation retry delay in milliseconds (after clean worker exit).
pub const CONTINUATION_RETRY_DELAY_MS: u64 = 1000;

/// Base delay for failure-driven exponential backoff.
pub const FAILURE_BASE_DELAY_MS: u64 = 10000;

pub struct FailureRetryRequest<'a> {
    pub issue_id: &'a str,
    pub identifier: &'a str,
    pub attempt: u32,
    pub max_backoff_ms: u64,
    pub max_cycles: u32,
    pub error: &'a str,
    pub retry_from_step: Option<String>,
    pub with_fixup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use]
pub enum FailureRetryDisposition {
    Scheduled(RetryEntry),
    Exhausted,
}

#[derive(Debug)]
pub(crate) enum ManualStepRetryError {
    RuntimeUnavailable,
    NoPipelineRun,
    StepNotFound,
    GateRetryForbidden,
    SkippedRetryForbidden {
        route_step: String,
        source_step: String,
    },
    FailedRouteRetryForbidden {
        route_step: String,
        source_step: String,
    },
    MaxCyclesExhausted,
    OwnerChanged,
    Interaction(InteractionError),
    Persistence(std::io::Error),
}

pub(crate) struct ManualStepRetryRequest<'a> {
    pub issue_id: &'a str,
    pub identifier: &'a str,
    pub step_name: &'a str,
    pub max_backoff_ms: u64,
    pub max_cycles: u32,
}

/// Queue a manual step retry under the same per-issue ordering reservation as
/// its durable transition. The global orchestrator state lock is never held
/// during journal I/O. A demonstrably absent transition restores the exact
/// previous owner; an ambiguous read failure retains the new owner so recovery
/// can never conflict with a visible new record.
pub(crate) async fn queue_manual_step_retry(
    state: &Arc<RwLock<OrchestratorState>>,
    journal: &PipelineRunJournal,
    interaction_store: &InteractionStore,
    request: ManualStepRetryRequest<'_>,
) -> Result<RetryEntry, ManualStepRetryError> {
    let transaction = journal.begin_issue_transition(request.issue_id).await;
    let (previous_retry, previous_waiting, previous_run, was_claimed, mut resume_was_requested) = {
        let state = state.read().await;
        let Some(run) = state.get_pipeline_run(request.issue_id) else {
            return Err(ManualStepRetryError::NoPipelineRun);
        };
        if !run.step_states.contains_key(request.step_name) {
            return Err(ManualStepRetryError::StepNotFound);
        }
        if run
            .step(request.step_name)
            .is_some_and(|step| step.kind == crate::config::ensemble::StepKind::Gate)
        {
            return Err(ManualStepRetryError::GateRetryForbidden);
        }
        if let Some((route_step, source_step)) = skipped_route_source(run, request.step_name) {
            return Err(ManualStepRetryError::SkippedRetryForbidden {
                route_step,
                source_step,
            });
        }
        if let Some((route_step, source_step)) = failed_route_source(run, request.step_name) {
            return Err(ManualStepRetryError::FailedRouteRetryForbidden {
                route_step,
                source_step,
            });
        }

        let previous_retry = state.retry_attempts.get(request.issue_id).cloned();
        let previous_waiting = state.waiting_on_human.get(request.issue_id).cloned();
        if previous_retry.is_none() && previous_waiting.is_none() {
            return Err(ManualStepRetryError::OwnerChanged);
        }
        (
            previous_retry,
            previous_waiting,
            run.clone(),
            state.is_claimed(request.issue_id),
            state.is_resume_requested(request.issue_id),
        )
    };
    let requested_attempt = previous_retry
        .as_ref()
        .map(|entry| entry.attempt + 1)
        .or_else(|| {
            previous_waiting
                .as_ref()
                .map(|entry| entry.retry_attempt.map(|attempt| attempt + 1).unwrap_or(1))
        })
        .unwrap_or(1);
    if requested_attempt >= request.max_cycles {
        return Err(ManualStepRetryError::MaxCyclesExhausted);
    }
    let retired_interaction =
        retire_waiting_interaction(interaction_store, previous_waiting.as_ref()).await?;

    let mutation = {
        let mut state = state.write().await;
        let owner_is_current = state.retry_attempts.get(request.issue_id)
            == previous_retry.as_ref()
            && waiting_owner_matches(
                state.waiting_on_human.get(request.issue_id),
                previous_waiting.as_ref(),
            )
            && state
                .get_pipeline_run(request.issue_id)
                .is_some_and(|run| run.to_snapshot() == previous_run.to_snapshot())
            && state.is_claimed(request.issue_id) == was_claimed;
        if !owner_is_current {
            None
        } else {
            resume_was_requested |= state.is_resume_requested(request.issue_id);
            let identifier = previous_retry
                .as_ref()
                .map(|entry| entry.identifier.clone())
                .or_else(|| {
                    previous_waiting
                        .as_ref()
                        .map(|entry| entry.identifier.clone())
                })
                .unwrap_or_else(|| request.identifier.to_string());
            let run_id = previous_waiting
                .as_ref()
                .and_then(|entry| entry.run_id.clone())
                .or_else(|| state.issue_run_ids.get(request.issue_id).cloned());

            let disposition = schedule_manual_failure_retry(
                &mut state,
                FailureRetryRequest {
                    issue_id: request.issue_id,
                    identifier: &identifier,
                    attempt: requested_attempt,
                    max_backoff_ms: request.max_backoff_ms,
                    max_cycles: request.max_cycles,
                    error: "manual step-level retry",
                    retry_from_step: Some(request.step_name.to_string()),
                    with_fixup: false,
                },
            );
            let FailureRetryDisposition::Scheduled(retry_entry) = disposition else {
                return Err(ManualStepRetryError::MaxCyclesExhausted);
            };

            state
                .get_pipeline_run_mut(request.issue_id)
                .expect("pipeline run was validated before retry scheduling")
                .retry_from_step(request.step_name);
            state.remove_waiting_on_human(request.issue_id);
            state.clear_resume_request(request.issue_id);
            let run = state
                .get_pipeline_run(request.issue_id)
                .expect("pipeline run remains present while retry is scheduled");
            let mutated_run = run.to_snapshot();
            let transition = PipelineTransitionInput {
                kind: PipelineTransitionKind::StepRetryScheduled,
                issue_id: request.issue_id.to_string(),
                identifier,
                run_id,
                cycle: run.cycle,
                step: Some(request.step_name.to_string()),
                reason: retry_entry.error.clone(),
                retry: Some(retry_entry.clone()),
                snapshot: Some(mutated_run.clone()),
                terminal_transition: None,
                delivery: None,
            };
            Some((retry_entry, transition, mutated_run))
        }
    };
    let Some((retry_entry, transition, mutated_run)) = mutation else {
        restore_retired_after_owner_change(
            state,
            interaction_store,
            request.issue_id,
            retired_interaction.as_ref(),
            previous_waiting.as_ref(),
        )
        .await?;
        return Err(ManualStepRetryError::OwnerChanged);
    };

    let transition_for_reconciliation = transition.clone();
    if let Err(error) = transaction.append(transition).await {
        match transaction
            .latest_record_matches(&transition_for_reconciliation)
            .await
        {
            Ok(true) => return Ok(retry_entry),
            Err(reconciliation_error) => {
                warn!(
                    issue_id = request.issue_id,
                    append_error = %error,
                    reconciliation_error = %reconciliation_error,
                    "manual retry append outcome is ambiguous; retaining the new owner"
                );
                return Err(ManualStepRetryError::Persistence(error));
            }
            Ok(false) => {}
        }

        let owner_can_restore = {
            let state = state.read().await;
            step_retry_owner_is_current(&state, request.issue_id, &retry_entry, &mutated_run)
        };
        if !owner_can_restore {
            return Err(ManualStepRetryError::Persistence(error));
        }

        restore_retired_interaction(interaction_store, retired_interaction.as_ref()).await?;
        let owner_restored = {
            let mut state = state.write().await;
            if step_retry_owner_is_current(&state, request.issue_id, &retry_entry, &mutated_run) {
                match previous_retry.clone() {
                    Some(entry) => {
                        state
                            .retry_attempts
                            .insert(request.issue_id.to_string(), entry);
                    }
                    None => {
                        state.retry_attempts.remove(request.issue_id);
                    }
                }
                match previous_waiting.clone() {
                    Some(entry) => {
                        state
                            .waiting_on_human
                            .insert(request.issue_id.to_string(), entry);
                    }
                    None => {
                        state.waiting_on_human.remove(request.issue_id);
                    }
                }
                state
                    .pipeline_runs
                    .insert(request.issue_id.to_string(), previous_run);
                if was_claimed {
                    state.claimed.insert(request.issue_id.to_string());
                } else {
                    state.claimed.remove(request.issue_id);
                }
                if resume_was_requested {
                    state.queue_resume(request.issue_id);
                }
                true
            } else {
                false
            }
        };
        if !owner_restored {
            reapply_retired_interaction(interaction_store, retired_interaction.as_ref()).await?;
        }
        return Err(ManualStepRetryError::Persistence(error));
    }

    Ok(retry_entry)
}

pub(crate) struct ManualWholeIssueRetryRequest<'a> {
    pub issue_id: &'a str,
    pub identifier: &'a str,
}

pub(crate) async fn queue_manual_whole_issue_retry(
    state: &Arc<RwLock<OrchestratorState>>,
    journal: &PipelineRunJournal,
    interaction_store: &InteractionStore,
    request: ManualWholeIssueRetryRequest<'_>,
) -> Result<(), ManualStepRetryError> {
    let transaction = journal.begin_issue_transition(request.issue_id).await;
    let (
        previous_retry,
        previous_waiting,
        previous_run,
        previous_config,
        was_claimed,
        mut resume_was_requested,
        run_id,
        identifier,
    ) = {
        let state = state.read().await;
        if state.delivery.contains_key(request.issue_id) {
            return Err(ManualStepRetryError::OwnerChanged);
        }
        if let Some((route_step, source_step)) = state
            .get_pipeline_run(request.issue_id)
            .and_then(first_failed_route_source)
        {
            return Err(ManualStepRetryError::FailedRouteRetryForbidden {
                route_step,
                source_step,
            });
        }
        let previous_retry = state.retry_attempts.get(request.issue_id).cloned();
        let previous_waiting = state.waiting_on_human.get(request.issue_id).cloned();
        if previous_retry.is_none() && previous_waiting.is_none() {
            return Err(ManualStepRetryError::OwnerChanged);
        }
        let identifier = previous_retry
            .as_ref()
            .map(|entry| entry.identifier.clone())
            .or_else(|| {
                previous_waiting
                    .as_ref()
                    .map(|entry| entry.identifier.clone())
            })
            .unwrap_or_else(|| request.identifier.to_string());
        let run_id = previous_waiting
            .as_ref()
            .and_then(|entry| entry.run_id.clone())
            .or_else(|| state.issue_run_ids.get(request.issue_id).cloned());
        (
            previous_retry,
            previous_waiting,
            state.get_pipeline_run(request.issue_id).cloned(),
            state.pipeline_configs.get(request.issue_id).cloned(),
            state.is_claimed(request.issue_id),
            state.is_resume_requested(request.issue_id),
            run_id,
            identifier,
        )
    };
    let retired_interaction =
        retire_waiting_interaction(interaction_store, previous_waiting.as_ref()).await?;

    let owner_mutated = {
        let mut state = state.write().await;
        let config_is_current = match (
            state.pipeline_configs.get(request.issue_id),
            previous_config.as_ref(),
        ) {
            (Some(current), Some(previous)) => Arc::ptr_eq(current, previous),
            (None, None) => true,
            _ => false,
        };
        let owner_is_current = state.retry_attempts.get(request.issue_id)
            == previous_retry.as_ref()
            && waiting_owner_matches(
                state.waiting_on_human.get(request.issue_id),
                previous_waiting.as_ref(),
            )
            && state
                .get_pipeline_run(request.issue_id)
                .map(|run| run.to_snapshot())
                == previous_run.as_ref().map(|run| run.to_snapshot())
            && config_is_current
            && !state.delivery.contains_key(request.issue_id)
            && state.is_claimed(request.issue_id) == was_claimed;
        if !owner_is_current {
            false
        } else {
            resume_was_requested |= state.is_resume_requested(request.issue_id);
            state.remove_retry(request.issue_id);
            state.remove_waiting_on_human(request.issue_id);
            state.remove_claimed(request.issue_id);
            state.clear_resume_request(request.issue_id);
            state.remove_pipeline_run(request.issue_id);
            true
        }
    };
    if !owner_mutated {
        restore_retired_after_owner_change(
            state,
            interaction_store,
            request.issue_id,
            retired_interaction.as_ref(),
            previous_waiting.as_ref(),
        )
        .await?;
        return Err(ManualStepRetryError::OwnerChanged);
    }

    let transition = PipelineTransitionInput {
        kind: PipelineTransitionKind::Released,
        issue_id: request.issue_id.to_string(),
        identifier,
        run_id,
        cycle: 0,
        step: None,
        reason: Some("whole_issue_retry".to_string()),
        retry: None,
        snapshot: None,
        terminal_transition: None,
        delivery: None,
    };
    let transition_for_reconciliation = transition.clone();
    if let Err(error) = transaction.append(transition).await {
        match transaction
            .latest_record_matches(&transition_for_reconciliation)
            .await
        {
            Ok(true) => return Ok(()),
            Err(reconciliation_error) => {
                warn!(
                    issue_id = request.issue_id,
                    append_error = %error,
                    reconciliation_error = %reconciliation_error,
                    "whole-issue retry append outcome is ambiguous; retaining the released owner"
                );
                return Err(ManualStepRetryError::Persistence(error));
            }
            Ok(false) => {}
        }

        let owner_can_restore = {
            let state = state.read().await;
            whole_issue_released_owner_is_current(&state, request.issue_id)
        };
        if !owner_can_restore {
            return Err(ManualStepRetryError::Persistence(error));
        }

        restore_retired_interaction(interaction_store, retired_interaction.as_ref()).await?;
        let owner_restored = {
            let mut state = state.write().await;
            if whole_issue_released_owner_is_current(&state, request.issue_id) {
                if let Some(entry) = previous_retry {
                    state
                        .retry_attempts
                        .insert(request.issue_id.to_string(), entry);
                }
                if let Some(entry) = previous_waiting {
                    state
                        .waiting_on_human
                        .insert(request.issue_id.to_string(), entry);
                }
                if let Some(run) = previous_run {
                    state
                        .pipeline_runs
                        .insert(request.issue_id.to_string(), run);
                }
                if let Some(config) = previous_config {
                    state
                        .pipeline_configs
                        .insert(request.issue_id.to_string(), config);
                }
                if was_claimed {
                    state.claimed.insert(request.issue_id.to_string());
                }
                if resume_was_requested {
                    state.queue_resume(request.issue_id);
                }
                true
            } else {
                false
            }
        };
        if !owner_restored {
            reapply_retired_interaction(interaction_store, retired_interaction.as_ref()).await?;
        }
        return Err(ManualStepRetryError::Persistence(error));
    }

    Ok(())
}

fn failed_route_source(
    run: &crate::pipeline::engine::PipelineRun,
    step_name: &str,
) -> Option<(String, String)> {
    run.step(step_name)
        .filter(|step| step.kind == crate::config::ensemble::StepKind::Route)
        .filter(|_| {
            matches!(
                run.step_states.get(step_name),
                Some(
                    crate::pipeline::engine::StepState::Failed { .. }
                        | crate::pipeline::engine::StepState::Errored { .. }
                )
            )
        })?
        .route
        .as_ref()
        .map(|route| (step_name.to_string(), route.source.step.clone()))
}

fn first_failed_route_source(
    run: &crate::pipeline::engine::PipelineRun,
) -> Option<(String, String)> {
    run.step_states
        .keys()
        .find_map(|step_name| failed_route_source(run, step_name))
}

fn skipped_route_source(
    run: &crate::pipeline::engine::PipelineRun,
    step_name: &str,
) -> Option<(String, String)> {
    match run.step_states.get(step_name)? {
        crate::pipeline::engine::StepState::Skipped { provenance } => provenance
            .first()
            .map(|cause| (cause.route_step.clone(), cause.source_step.clone())),
        _ => None,
    }
}

struct RetiredInteraction {
    previous: InteractionRequest,
    cleared: InteractionRequest,
}

fn step_retry_owner_is_current(
    state: &OrchestratorState,
    issue_id: &str,
    retry_entry: &RetryEntry,
    mutated_run: &crate::pipeline::engine::PipelineRunSnapshot,
) -> bool {
    state.retry_attempts.get(issue_id) == Some(retry_entry)
        && state
            .get_pipeline_run(issue_id)
            .is_some_and(|run| run.to_snapshot() == *mutated_run)
        && !state.waiting_on_human.contains_key(issue_id)
        && state.is_claimed(issue_id)
}

fn whole_issue_released_owner_is_current(state: &OrchestratorState, issue_id: &str) -> bool {
    !state.retry_attempts.contains_key(issue_id)
        && !state.waiting_on_human.contains_key(issue_id)
        && state.get_pipeline_run(issue_id).is_none()
        && !state.pipeline_configs.contains_key(issue_id)
        && !state.is_claimed(issue_id)
}

fn waiting_owner_matches(
    current: Option<&super::state::WaitingOnHumanEntry>,
    expected: Option<&super::state::WaitingOnHumanEntry>,
) -> bool {
    match (current, expected) {
        (Some(current), Some(expected)) => {
            let mut expected = expected.clone();
            expected.issue.clone_from(&current.issue);
            current == &expected
        }
        (None, None) => true,
        _ => false,
    }
}

async fn retire_waiting_interaction(
    interaction_store: &InteractionStore,
    waiting: Option<&super::state::WaitingOnHumanEntry>,
) -> Result<Option<RetiredInteraction>, ManualStepRetryError> {
    let Some(waiting) = waiting else {
        return Ok(None);
    };
    let (previous, cleared) = match interaction_store
        .retire_waiting_state(&waiting.interaction_request_id)
        .await
    {
        Ok(retired) => retired,
        Err(InteractionError::NotFound { .. }) if is_synthetic_halted_waiter(waiting) => {
            return Ok(None);
        }
        Err(error) => return Err(ManualStepRetryError::Interaction(error)),
    };
    Ok(Some(RetiredInteraction { previous, cleared }))
}

fn is_synthetic_halted_waiter(waiting: &super::state::WaitingOnHumanEntry) -> bool {
    waiting.kind == crate::interaction::InteractionKind::Handoff
        && waiting.interaction_request_id
            == format!("halted:{}:{}", waiting.issue_id, waiting.step_name)
}

async fn restore_retired_after_owner_change(
    state: &Arc<RwLock<OrchestratorState>>,
    interaction_store: &InteractionStore,
    issue_id: &str,
    retired: Option<&RetiredInteraction>,
    previous_waiting: Option<&super::state::WaitingOnHumanEntry>,
) -> Result<(), ManualStepRetryError> {
    let previous_wait_owned_before_restore = {
        let state = state.read().await;
        waiting_owner_matches(state.waiting_on_human.get(issue_id), previous_waiting)
    };
    if !previous_wait_owned_before_restore {
        return Ok(());
    }
    restore_retired_interaction(interaction_store, retired).await?;
    let previous_wait_owned_after_restore = {
        let state = state.read().await;
        waiting_owner_matches(state.waiting_on_human.get(issue_id), previous_waiting)
    };
    if !previous_wait_owned_after_restore {
        reapply_retired_interaction(interaction_store, retired).await?;
    }
    Ok(())
}

async fn restore_retired_interaction(
    interaction_store: &InteractionStore,
    retired: Option<&RetiredInteraction>,
) -> Result<(), ManualStepRetryError> {
    let Some(retired) = retired else {
        return Ok(());
    };
    interaction_store
        .restore_waiting_state_after_failed_transition(&retired.cleared, &retired.previous)
        .await
        .map_err(ManualStepRetryError::Interaction)
}

async fn reapply_retired_interaction(
    interaction_store: &InteractionStore,
    retired: Option<&RetiredInteraction>,
) -> Result<(), ManualStepRetryError> {
    let Some(retired) = retired else {
        return Ok(());
    };
    interaction_store
        .reapply_retired_state_after_failed_owner_restore(&retired.previous, &retired.cleared)
        .await
        .map_err(ManualStepRetryError::Interaction)
}

#[derive(Clone, Copy)]
enum FailureRetrySemantics {
    PipelineCycle,
    LegacyManual,
}

impl FailureRetryDisposition {
    pub fn is_exhausted(&self) -> bool {
        matches!(self, Self::Exhausted)
    }

    pub fn scheduled(&self) -> Option<&RetryEntry> {
        match self {
            Self::Scheduled(entry) => Some(entry),
            Self::Exhausted => None,
        }
    }
}

/// Calculate exponential backoff delay for a failure retry.
/// Formula: min(10000 * 2^(attempt - 1), max_backoff_ms)
pub fn calculate_backoff(attempt: u32, max_backoff_ms: u64) -> u64 {
    if attempt == 0 {
        return FAILURE_BASE_DELAY_MS;
    }
    let exponent = (attempt - 1).min(31); // prevent overflow
    let delay = FAILURE_BASE_DELAY_MS.saturating_mul(1u64 << exponent);
    delay.min(max_backoff_ms)
}

/// Schedule a continuation retry (after normal worker exit).
/// Uses a short fixed delay of 1 second.
pub fn schedule_continuation_retry(
    state: &mut OrchestratorState,
    issue_id: &str,
    identifier: &str,
) -> u64 {
    let due_at_ms = current_time_ms() + CONTINUATION_RETRY_DELAY_MS;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt: 1,
        due_at_ms,
        error: None,
        retry_from_step: None,
        with_fixup: false,
    };

    info!(
        event = ISSUE_RETRY_SCHEDULED,
        issue_id = issue_id,
        identifier = identifier,
        reason = "continuation",
        delay_ms = CONTINUATION_RETRY_DELAY_MS,
        "scheduling continuation retry"
    );

    state.add_retry(entry);
    due_at_ms
}

/// Schedule a failure retry with exponential backoff.
/// Returns the exact scheduled entry or an explicit exhausted disposition.
pub fn schedule_failure_retry(
    state: &mut OrchestratorState,
    request: FailureRetryRequest<'_>,
) -> FailureRetryDisposition {
    schedule_failure_retry_with_semantics(state, request, FailureRetrySemantics::PipelineCycle)
}

/// Schedule a manual step retry using the endpoint's established attempt,
/// exhaustion, and backoff semantics.
fn schedule_manual_failure_retry(
    state: &mut OrchestratorState,
    request: FailureRetryRequest<'_>,
) -> FailureRetryDisposition {
    schedule_failure_retry_with_semantics(state, request, FailureRetrySemantics::LegacyManual)
}

fn schedule_failure_retry_with_semantics(
    state: &mut OrchestratorState,
    request: FailureRetryRequest<'_>,
    semantics: FailureRetrySemantics,
) -> FailureRetryDisposition {
    let FailureRetryRequest {
        issue_id,
        identifier,
        attempt,
        max_backoff_ms,
        max_cycles,
        error,
        retry_from_step,
        with_fixup,
    } = request;

    let exhausted = match semantics {
        FailureRetrySemantics::PipelineCycle => attempt > max_cycles,
        FailureRetrySemantics::LegacyManual => attempt >= max_cycles,
    };
    if exhausted {
        warn!(
            event = ISSUE_RETRY_CANCELLED,
            issue_id = issue_id,
            identifier = identifier,
            attempt = attempt,
            max_cycles = max_cycles,
            reason = normalize_reason(error),
            "max retry cycles reached, not scheduling further retries"
        );
        return FailureRetryDisposition::Exhausted;
    }

    let backoff_attempt = match semantics {
        FailureRetrySemantics::PipelineCycle => attempt.saturating_sub(1),
        FailureRetrySemantics::LegacyManual => attempt,
    };
    let delay = calculate_backoff(backoff_attempt, max_backoff_ms);
    let due_at_ms = current_time_ms() + delay;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt,
        due_at_ms,
        error: Some(error.to_string()),
        retry_from_step,
        with_fixup,
    };

    info!(
        event = ISSUE_RETRY_SCHEDULED,
        issue_id = issue_id,
        identifier = identifier,
        attempt = attempt,
        delay_ms = delay,
        reason = normalize_reason(error),
        "scheduling failure retry"
    );

    state.add_retry(entry.clone());
    FailureRetryDisposition::Scheduled(entry)
}

/// Defer scheduler work for a retry without consuming another pipeline cycle.
pub fn defer_retry(
    state: &mut OrchestratorState,
    retry_entry: &RetryEntry,
    max_backoff_ms: u64,
    reason: &str,
) -> RetryEntry {
    let delay = calculate_backoff(retry_entry.attempt.saturating_sub(1), max_backoff_ms);
    let mut deferred = retry_entry.clone();
    deferred.due_at_ms = current_time_ms() + delay;
    deferred.error = Some(reason.to_string());

    info!(
        event = ISSUE_RETRY_SCHEDULED,
        issue_id = %deferred.issue_id,
        identifier = %deferred.identifier,
        attempt = deferred.attempt,
        delay_ms = delay,
        reason = normalize_reason(reason),
        "deferring retry scheduler work"
    );

    state.add_retry(deferred.clone());
    deferred
}

/// Identify deterministic agent/runtime configuration failures that another
/// retry cannot fix.
pub fn is_non_retryable_failure(reason: &str) -> bool {
    let reason = reason.to_ascii_lowercase();
    reason.contains("cannot apply --model") && reason.contains("did not advertise model support")
}

/// Determine the next attempt number from a running entry.
/// If the entry had a retry attempt, increment it; otherwise advance from the
/// initial pipeline cycle to cycle 2.
pub fn next_attempt(current: Option<u32>) -> u32 {
    current.unwrap_or(1) + 1
}

fn normalize_reason(reason: &str) -> &str {
    // Returns "unknown" for empty input, otherwise the input unchanged.
    if reason.trim().is_empty() {
        "unknown"
    } else {
        reason
    }
}

/// Get the current time in milliseconds (monotonic-ish for retry scheduling).
pub fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check if a retry entry is due (its due time has passed).
pub fn is_retry_due(entry: &RetryEntry) -> bool {
    current_time_ms() >= entry.due_at_ms
}

/// Get all due retries from the state, sorted by due time.
pub fn get_due_retries(state: &OrchestratorState) -> Vec<RetryEntry> {
    let now = current_time_ms();
    let mut due: Vec<RetryEntry> = state
        .retry_attempts
        .values()
        .filter(|e| now >= e.due_at_ms)
        .cloned()
        .collect();
    due.sort_by_key(|e| e.due_at_ms);
    due
}

/// Get the next retry fire time (earliest due_at_ms) if any retries exist.
pub fn next_retry_time(state: &OrchestratorState) -> Option<u64> {
    state.retry_attempts.values().map(|e| e.due_at_ms).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{ConcurrencyConfig, OnFailure, StepConfig, StepKind};
    use crate::interaction::model::{
        InteractionKind, InteractionRequest, InteractionResumeStrategy, InteractionStatus,
    };
    use crate::interaction::InteractionResponse;
    use crate::orchestrator::delivery::{
        canonical_marker, DeliveryMode, DeliveryPhase, DeliveryRecord, DeliveryRepository,
    };
    use crate::orchestrator::state::WaitingOnHumanEntry;
    use crate::pipeline::dag::build_dag;
    use crate::pipeline::engine::{PipelineRun, StepState};
    use crate::tracker::model::Issue;

    fn manual_retry_state() -> Arc<RwLock<OrchestratorState>> {
        manual_retry_state_for_kind(StepKind::Agent)
    }

    async fn failed_route_retry_state() -> Arc<RwLock<OrchestratorState>> {
        let state = manual_retry_state_for_kind(StepKind::Route);
        state
            .write()
            .await
            .get_pipeline_run_mut("issue-1")
            .expect("fixture pipeline run")
            .step_states
            .insert(
                "build".to_string(),
                StepState::Failed {
                    summary: "bad route value".to_string(),
                },
            );
        state
    }

    fn manual_retry_state_for_kind(kind: StepKind) -> Arc<RwLock<OrchestratorState>> {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = Issue {
            id: "issue-1".to_string(),
            identifier: "repo#1".to_string(),
            title: "Retry me".to_string(),
            description: None,
            priority: None,
            tracker_position: None,
            state: "In Progress".to_string(),
            branch_name: None,
            url: None,
            labels: Vec::new(),
            blocked_by: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: "halted:issue-1:build".to_string(),
            step_name: "build".to_string(),
            kind: InteractionKind::Handoff,
            prompt: "manual repair needed".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: Some(1),
            started_at: Some(chrono::Utc::now()),
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: chrono::Utc::now(),
            run_id: Some("run-1".to_string()),
            issue: Some(issue),
        });
        let dag = build_dag(&[StepConfig {
            name: "build".to_string(),
            kind,
            agent: (kind == StepKind::Agent)
                .then(|| "builder".to_string())
                .unwrap_or_default(),
            depends: None,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: if kind == StepKind::Route {
                OnFailure::Halt
            } else {
                OnFailure::RetryIssue
            },
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: (kind == StepKind::Route).then(|| crate::config::ensemble::RouteConfig {
                source: crate::config::ensemble::RouteSource {
                    step: "source".to_string(),
                    pointer: "/decision".to_string(),
                },
                cases: std::collections::BTreeMap::new(),
            }),
            actions: Vec::new(),
        }])
        .unwrap();
        state.pipeline_runs.insert(
            "issue-1".to_string(),
            PipelineRun::new("issue-1".to_string(), 1, dag),
        );
        Arc::new(RwLock::new(state))
    }

    async fn manual_retry_store(config_dir: &std::path::Path) -> InteractionStore {
        let store = InteractionStore::new(config_dir.to_path_buf());
        store
            .create(InteractionRequest {
                id: "halted:issue-1:build".to_string(),
                schema_version: 1,
                issue_id: "issue-1".to_string(),
                issue_identifier: "repo#1".to_string(),
                pipeline_cycle: 1,
                completed_steps: Vec::new(),
                step_name: "build".to_string(),
                agent_name: "builder".to_string(),
                step_depends: Vec::new(),
                step_tracker_state: None,
                kind: InteractionKind::Handoff,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: "manual repair needed".to_string(),
                body: "manual repair needed".to_string(),
                options: Vec::new(),
                artifacts: Vec::new(),
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: Vec::new(),
                response: None,
                waiting_started_at: Some(chrono::Utc::now()),
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: chrono::Utc::now(),
                resolved_at: None,
            })
            .await
            .unwrap();
        store
    }

    #[tokio::test]
    async fn step_retry_owner_race_restores_original_waiting_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let ready = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        let state = manual_retry_state();
        let mut store = manual_retry_store(dir.path()).await;
        store.set_retire_waiting_state_test_barriers(Arc::clone(&ready), Arc::clone(&release));
        let store = Arc::new(store);
        let journal = PipelineRunJournal::new(dir.path());

        let retry = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move {
                queue_manual_step_retry(
                    &state,
                    &journal,
                    &store,
                    ManualStepRetryRequest {
                        issue_id: "issue-1",
                        identifier: "repo#1",
                        step_name: "build",
                        max_backoff_ms: 300_000,
                        max_cycles: 5,
                    },
                )
                .await
            }
        });

        ready.wait().await;
        state
            .write()
            .await
            .get_pipeline_run_mut("issue-1")
            .unwrap()
            .cycle = 2;
        release.wait().await;

        assert!(matches!(
            retry.await.unwrap(),
            Err(ManualStepRetryError::OwnerChanged)
        ));
        assert!(state.read().await.is_waiting_on_human("issue-1"));
        assert!(
            store
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn whole_issue_retry_owner_race_keeps_retirement_for_new_owner() {
        let dir = tempfile::tempdir().unwrap();
        let ready = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        let state = manual_retry_state();
        let mut store = manual_retry_store(dir.path()).await;
        store.set_retire_waiting_state_test_barriers(Arc::clone(&ready), Arc::clone(&release));
        let store = Arc::new(store);
        let journal = PipelineRunJournal::new(dir.path());

        let retry = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move {
                queue_manual_whole_issue_retry(
                    &state,
                    &journal,
                    &store,
                    ManualWholeIssueRetryRequest {
                        issue_id: "issue-1",
                        identifier: "repo#1",
                    },
                )
                .await
            }
        });

        ready.wait().await;
        state.write().await.remove_waiting_on_human("issue-1");
        store.fail_next_writes(1);
        release.wait().await;

        assert!(matches!(
            retry.await.unwrap(),
            Err(ManualStepRetryError::OwnerChanged)
        ));
        assert!(!state.read().await.is_waiting_on_human("issue-1"));
        assert!(
            !store
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn owner_change_during_restore_reapplies_retired_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let retire_ready = Arc::new(tokio::sync::Barrier::new(2));
        let retire_release = Arc::new(tokio::sync::Barrier::new(2));
        let restore_ready = Arc::new(tokio::sync::Barrier::new(2));
        let restore_release = Arc::new(tokio::sync::Barrier::new(2));
        let state = manual_retry_state();
        let mut store = manual_retry_store(dir.path()).await;
        store.set_retire_waiting_state_test_barriers(
            Arc::clone(&retire_ready),
            Arc::clone(&retire_release),
        );
        store.set_restore_waiting_state_test_barriers(
            Arc::clone(&restore_ready),
            Arc::clone(&restore_release),
        );
        let store = Arc::new(store);
        let journal = PipelineRunJournal::new(dir.path());

        let retry = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move {
                queue_manual_step_retry(
                    &state,
                    &journal,
                    &store,
                    ManualStepRetryRequest {
                        issue_id: "issue-1",
                        identifier: "repo#1",
                        step_name: "build",
                        max_backoff_ms: 300_000,
                        max_cycles: 5,
                    },
                )
                .await
            }
        });

        retire_ready.wait().await;
        state
            .write()
            .await
            .get_pipeline_run_mut("issue-1")
            .unwrap()
            .cycle = 2;
        retire_release.wait().await;
        restore_ready.wait().await;
        state.write().await.remove_waiting_on_human("issue-1");
        restore_release.wait().await;

        assert!(matches!(
            retry.await.unwrap(),
            Err(ManualStepRetryError::OwnerChanged)
        ));
        assert!(!state.read().await.is_waiting_on_human("issue-1"));
        assert!(
            !store
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn synthetic_halt_step_retry_does_not_require_sidecar_record() {
        let dir = tempfile::tempdir().unwrap();
        let state = manual_retry_state();
        let store = InteractionStore::new(dir.path().to_path_buf());
        let scheduled = queue_manual_step_retry(
            &state,
            &PipelineRunJournal::new(dir.path()),
            &store,
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect("synthetic halt retry should not require a sidecar");

        assert_eq!(scheduled.attempt, 2);
        assert!(!state.read().await.is_waiting_on_human("issue-1"));
    }

    #[tokio::test]
    async fn skipped_step_retry_is_rejected_until_its_route_source_is_reset() {
        let dir = tempfile::tempdir().unwrap();
        let state = manual_retry_state();
        state
            .write()
            .await
            .get_pipeline_run_mut("issue-1")
            .expect("fixture pipeline run")
            .step_states
            .insert(
                "build".to_string(),
                StepState::Skipped {
                    provenance: vec![crate::pipeline::engine::RouteSkipProvenance {
                        route_step: "choose".to_string(),
                        source_step: "compare".to_string(),
                        selected_case: "agreement".to_string(),
                    }],
                },
            );

        let error = queue_manual_step_retry(
            &state,
            &PipelineRunJournal::new(dir.path()),
            &InteractionStore::new(dir.path().to_path_buf()),
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect_err("a route-skipped step must be retried from its source");

        assert!(matches!(
            error,
            ManualStepRetryError::SkippedRetryForbidden { route_step, source_step }
                if route_step == "choose" && source_step == "compare"
        ));
    }

    #[tokio::test]
    async fn failed_route_step_retry_is_rejected_until_its_source_is_reset() {
        let dir = tempfile::tempdir().unwrap();
        let error = queue_manual_step_retry(
            &failed_route_retry_state().await,
            &PipelineRunJournal::new(dir.path()),
            &InteractionStore::new(dir.path().to_path_buf()),
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect_err("a failed route must restart from its source step");

        assert!(matches!(
            error,
            ManualStepRetryError::FailedRouteRetryForbidden { route_step, source_step }
                if route_step == "build" && source_step == "source"
        ));
    }

    #[tokio::test]
    async fn failed_route_whole_issue_retry_is_rejected_until_its_source_is_reset() {
        let dir = tempfile::tempdir().unwrap();
        let error = queue_manual_whole_issue_retry(
            &failed_route_retry_state().await,
            &PipelineRunJournal::new(dir.path()),
            &InteractionStore::new(dir.path().to_path_buf()),
            ManualWholeIssueRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
            },
        )
        .await
        .expect_err("a failed route must restart from its source step");

        assert!(matches!(
            error,
            ManualStepRetryError::FailedRouteRetryForbidden { route_step, source_step }
                if route_step == "build" && source_step == "source"
        ));
    }

    #[tokio::test]
    async fn synthetic_halt_whole_issue_retry_does_not_require_sidecar_record() {
        let dir = tempfile::tempdir().unwrap();
        let state = manual_retry_state();
        let store = InteractionStore::new(dir.path().to_path_buf());
        queue_manual_whole_issue_retry(
            &state,
            &PipelineRunJournal::new(dir.path()),
            &store,
            ManualWholeIssueRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
            },
        )
        .await
        .expect("synthetic whole-issue retry should not require a sidecar");

        let state = state.read().await;
        assert!(!state.is_waiting_on_human("issue-1"));
        assert!(!state.is_claimed("issue-1"));
        assert!(state.get_pipeline_run("issue-1").is_none());
    }

    #[tokio::test]
    async fn persisted_interaction_retry_still_fails_closed_when_sidecar_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let state = manual_retry_state();
        {
            let mut state = state.write().await;
            let waiting = state.waiting_on_human.get_mut("issue-1").unwrap();
            waiting.interaction_request_id = "question-1".to_string();
            waiting.kind = InteractionKind::Question;
        }
        let store = InteractionStore::new(dir.path().to_path_buf());

        let error = queue_manual_step_retry(
            &state,
            &PipelineRunJournal::new(dir.path()),
            &store,
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect_err("persisted interactions must remain fail-closed");

        assert!(matches!(
            error,
            ManualStepRetryError::Interaction(InteractionError::NotFound { .. })
        ));
        assert!(state.read().await.is_waiting_on_human("issue-1"));
    }

    #[tokio::test]
    async fn concurrent_manual_retries_commit_in_owner_order() {
        let dir = tempfile::tempdir().unwrap();
        let ready = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        let mut journal = PipelineRunJournal::new(dir.path());
        journal.transaction_append_test_barriers = Some((Arc::clone(&ready), Arc::clone(&release)));
        let state = manual_retry_state();
        let interactions = manual_retry_store(dir.path()).await;

        let first = tokio::spawn({
            let state = Arc::clone(&state);
            let journal = journal.clone();
            let interactions = interactions.clone();
            async move {
                queue_manual_step_retry(
                    &state,
                    &journal,
                    &interactions,
                    ManualStepRetryRequest {
                        issue_id: "issue-1",
                        identifier: "repo#1",
                        step_name: "build",
                        max_backoff_ms: 300_000,
                        max_cycles: 5,
                    },
                )
                .await
            }
        });
        ready.wait().await;

        let mut second = tokio::spawn({
            let state = Arc::clone(&state);
            let mut journal = PipelineRunJournal::new(dir.path());
            let interactions = interactions.clone();
            journal.transaction_append_test_barriers = None;
            async move {
                queue_manual_step_retry(
                    &state,
                    &journal,
                    &interactions,
                    ManualStepRetryRequest {
                        issue_id: "issue-1",
                        identifier: "repo#1",
                        step_name: "build",
                        max_backoff_ms: 300_000,
                        max_cycles: 5,
                    },
                )
                .await
            }
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut second)
                .await
                .is_err(),
            "the second retry must not mutate state before the first transition is durable"
        );
        assert_eq!(
            state
                .read()
                .await
                .retry_attempts
                .get("issue-1")
                .map(|entry| entry.attempt),
            Some(2)
        );

        release.wait().await;
        assert_eq!(first.await.unwrap().unwrap().attempt, 2);
        assert_eq!(second.await.unwrap().unwrap().attempt, 3);

        let records = journal.read_records_for_issue("issue-1").await.unwrap();
        let attempts: Vec<_> = records
            .iter()
            .filter_map(|record| record.retry.as_ref().map(|entry| entry.attempt))
            .collect();
        assert_eq!(attempts, vec![2, 3]);
        let latest = journal
            .latest_live_record_for_issue("issue-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.retry.map(|entry| entry.attempt), Some(3));
        assert_eq!(
            state
                .read()
                .await
                .retry_attempts
                .get("issue-1")
                .map(|entry| entry.attempt),
            Some(3)
        );
    }

    #[tokio::test]
    async fn late_append_error_keeps_the_exact_restart_visible_retry() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = PipelineRunJournal::new(dir.path());
        journal.transaction_append_late_error = true;
        let state = manual_retry_state();
        let interactions = manual_retry_store(dir.path()).await;
        interactions
            .resolve(
                "halted:issue-1:build",
                InteractionResponse::Handoff {
                    response_schema_version: 1,
                    completed: true,
                    notes: Some("fixed".to_string()),
                },
            )
            .await
            .unwrap();
        state.write().await.queue_resume("issue-1");

        let scheduled = queue_manual_step_retry(
            &state,
            &journal,
            &interactions,
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect("a visible exact record makes the semantic append successful");

        assert_eq!(scheduled.attempt, 2);
        assert_eq!(
            state
                .read()
                .await
                .retry_attempts
                .get("issue-1")
                .map(|entry| entry.attempt),
            Some(2)
        );
        assert!(!state.read().await.is_resume_requested("issue-1"));
        assert!(
            !interactions
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        let latest = journal
            .latest_live_record_for_issue("issue-1")
            .await
            .unwrap()
            .expect("the retry remains recoverable after restart");
        assert_eq!(latest.retry, Some(scheduled));
    }

    #[tokio::test]
    async fn absent_step_retry_append_restores_queued_resume_owner() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = PipelineRunJournal::new(dir.path());
        journal.transaction_append_error_on_call =
            Some((Arc::new(std::sync::atomic::AtomicUsize::new(0)), 1));
        let state = manual_retry_state();
        let interactions = manual_retry_store(dir.path()).await;
        interactions
            .resolve(
                "halted:issue-1:build",
                InteractionResponse::Handoff {
                    response_schema_version: 1,
                    completed: true,
                    notes: Some("fixed".to_string()),
                },
            )
            .await
            .unwrap();
        state.write().await.queue_resume("issue-1");

        let error = queue_manual_step_retry(
            &state,
            &journal,
            &interactions,
            ManualStepRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                step_name: "build",
                max_backoff_ms: 300_000,
                max_cycles: 5,
            },
        )
        .await
        .expect_err("a demonstrably absent append must fail");

        assert!(matches!(error, ManualStepRetryError::Persistence(_)));
        let state = state.read().await;
        assert!(state.is_resume_requested("issue-1"));
        assert!(state.is_waiting_on_human("issue-1"));
        assert!(state.is_claimed("issue-1"));
        assert!(!state.retry_attempts.contains_key("issue-1"));
        drop(state);
        assert!(
            interactions
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
    }

    #[tokio::test]
    async fn absent_whole_issue_retry_append_restores_restart_visible_owner() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = PipelineRunJournal::new(dir.path());
        let state = manual_retry_state();
        let interactions = manual_retry_store(dir.path()).await;
        let previous_snapshot = state
            .read()
            .await
            .get_pipeline_run("issue-1")
            .unwrap()
            .to_snapshot();
        journal
            .append(PipelineTransitionInput {
                kind: PipelineTransitionKind::PipelineHalted,
                issue_id: "issue-1".to_string(),
                identifier: "repo#1".to_string(),
                run_id: Some("run-1".to_string()),
                cycle: 1,
                step: Some("build".to_string()),
                reason: Some("manual repair needed".to_string()),
                retry: None,
                snapshot: Some(previous_snapshot.clone()),
                terminal_transition: None,
                delivery: None,
            })
            .await
            .unwrap();
        journal.transaction_append_error_on_call =
            Some((Arc::new(std::sync::atomic::AtomicUsize::new(0)), 1));

        let error = queue_manual_whole_issue_retry(
            &state,
            &journal,
            &interactions,
            ManualWholeIssueRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
            },
        )
        .await
        .expect_err("a demonstrably absent release must fail");

        assert!(matches!(error, ManualStepRetryError::Persistence(_)));
        let state = state.read().await;
        assert!(state.is_waiting_on_human("issue-1"));
        assert!(state.is_claimed("issue-1"));
        assert_eq!(
            state.get_pipeline_run("issue-1").unwrap().to_snapshot(),
            previous_snapshot
        );
        drop(state);
        assert!(
            interactions
                .get("halted:issue-1:build")
                .await
                .unwrap()
                .unwrap()
                .awaiting_resume
        );
        let latest = journal
            .latest_live_record_for_issue("issue-1")
            .await
            .unwrap()
            .expect("the previous owner must remain restart-visible");
        assert_eq!(latest.kind, PipelineTransitionKind::PipelineHalted);
        assert_eq!(latest.snapshot, Some(previous_snapshot));
    }

    #[tokio::test]
    async fn whole_issue_retry_rejects_delivery_owned_issue_without_releasing_it() {
        let dir = tempfile::tempdir().unwrap();
        let journal = PipelineRunJournal::new(dir.path());
        let state = manual_retry_state();
        let interactions = manual_retry_store(dir.path()).await;
        let delivery = DeliveryRecord {
            issue_id: "issue-1".to_string(),
            identifier: "repo#1".to_string(),
            run_id: "run-1".to_string(),
            repositories: [(
                "primary".to_string(),
                DeliveryRepository {
                    mode: DeliveryMode::PushAndPr,
                    phase: DeliveryPhase::Waiting,
                    approval_required: false,
                    remote: "origin".to_string(),
                    base_branch: "main".to_string(),
                    head_branch: "ensemble/repo-1".to_string(),
                    local_sha: "0123456789abcdef".to_string(),
                    observed_remote_sha: Some("0123456789abcdef".to_string()),
                    marker: canonical_marker("run-1", "issue-1", "primary"),
                    pr_number: Some(420),
                    pr_url: Some("https://github.com/example/project/pull/420".to_string()),
                    observation: None,
                    ownership_conflict: None,
                    last_error: None,
                    retry_from: None,
                },
            )]
            .into_iter()
            .collect(),
            terminal_history: None,
            review_projection: None,
        };
        state
            .write()
            .await
            .delivery
            .insert("issue-1".to_string(), delivery.clone());

        let error = queue_manual_whole_issue_retry(
            &state,
            &journal,
            &interactions,
            ManualWholeIssueRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
            },
        )
        .await
        .expect_err("delivery owns whole-issue recovery");

        assert!(matches!(error, ManualStepRetryError::OwnerChanged));
        let state = state.read().await;
        assert_eq!(state.delivery.get("issue-1"), Some(&delivery));
        assert!(state.is_waiting_on_human("issue-1"));
        assert!(state.is_claimed("issue-1"));
        assert!(state.get_pipeline_run("issue-1").is_some());
        drop(state);
        assert!(journal
            .read_records_for_issue("issue-1")
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn retry_reason_is_non_empty() {
        let reason = normalize_reason("");
        assert_eq!(reason, "unknown");
    }

    #[test]
    fn unsupported_acpx_model_capability_failure_is_not_retryable() {
        assert!(is_non_retryable_failure(
            "acpx command failed: sessions ensure — exit status: 1; stdout: {\"message\":\"Cannot apply --model \\\"opencode-go/kimi-k2.5\\\": the ACP agent did not advertise model support.\"}"
        ));
    }

    #[test]
    fn ordinary_agent_failure_is_retryable() {
        assert!(!is_non_retryable_failure("temporary agent crash"));
    }

    #[test]
    fn test_calculate_backoff_attempt_1() {
        let delay = calculate_backoff(1, 300_000);
        assert_eq!(delay, 10_000); // 10000 * 2^0 = 10000
    }

    #[test]
    fn test_calculate_backoff_attempt_2() {
        let delay = calculate_backoff(2, 300_000);
        assert_eq!(delay, 20_000); // 10000 * 2^1 = 20000
    }

    #[test]
    fn test_calculate_backoff_attempt_3() {
        let delay = calculate_backoff(3, 300_000);
        assert_eq!(delay, 40_000); // 10000 * 2^2 = 40000
    }

    #[test]
    fn test_calculate_backoff_attempt_4() {
        let delay = calculate_backoff(4, 300_000);
        assert_eq!(delay, 80_000); // 10000 * 2^3 = 80000
    }

    #[test]
    fn test_calculate_backoff_capped() {
        let delay = calculate_backoff(10, 300_000);
        assert_eq!(delay, 300_000); // capped at max
    }

    #[test]
    fn test_calculate_backoff_high_attempt_no_overflow() {
        let delay = calculate_backoff(100, 300_000);
        assert_eq!(delay, 300_000); // capped, no overflow
    }

    #[test]
    fn test_calculate_backoff_attempt_0() {
        let delay = calculate_backoff(0, 300_000);
        assert_eq!(delay, 10_000); // base delay
    }

    #[test]
    fn test_schedule_continuation_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let due = schedule_continuation_retry(&mut state, "issue-1", "repo#1");

        assert!(state.retry_attempts.contains_key("issue-1"));
        assert!(state.is_claimed("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(entry.attempt, 1);
        assert!(entry.error.is_none());
        assert!(due > 0);
    }

    #[test]
    fn test_schedule_failure_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let before = current_time_ms();

        let disposition = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                attempt: 2,
                max_backoff_ms: 300_000,
                max_cycles: 5,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );

        let FailureRetryDisposition::Scheduled(scheduled) = disposition else {
            panic!("retry should be scheduled");
        };
        assert!(state.retry_attempts.contains_key("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(scheduled.due_at_ms, entry.due_at_ms);
        assert_eq!(entry.attempt, 2);
        assert_eq!(entry.error.as_deref(), Some("agent crashed"));
        assert_eq!(entry.retry_from_step, None);
        assert!(!entry.with_fixup);
        assert!(entry.due_at_ms >= before + 10_000);
        assert!(entry.due_at_ms <= current_time_ms() + 10_000);
    }

    #[test]
    fn test_schedule_failure_retry_respects_max_cycles() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        // attempt 4, max_cycles 3 → should NOT schedule
        let disposition = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                attempt: 4,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );
        let FailureRetryDisposition::Exhausted = disposition else {
            panic!("retry should be exhausted");
        };
        assert!(!state.retry_attempts.contains_key("issue-1"));

        // attempt 3, max_cycles 3 → should schedule
        let disposition = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-2",
                identifier: "repo#2",
                attempt: 3,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );
        assert!(matches!(disposition, FailureRetryDisposition::Scheduled(_)));
        assert!(state.retry_attempts.contains_key("issue-2"));
    }

    #[test]
    fn manual_failure_retry_preserves_legacy_boundary_and_backoff() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let before = current_time_ms();

        let disposition = schedule_manual_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                attempt: 2,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "manual step-level retry",
                retry_from_step: Some("review".to_string()),
                with_fixup: false,
            },
        );

        let FailureRetryDisposition::Scheduled(entry) = disposition else {
            panic!("manual retry below max_cycles should be scheduled");
        };
        assert_eq!(entry.attempt, 2);
        assert!(entry.due_at_ms >= before + 20_000);
        assert!(entry.due_at_ms <= current_time_ms() + 20_000);

        let disposition = schedule_manual_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-2",
                identifier: "repo#2",
                attempt: 3,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "manual step-level retry",
                retry_from_step: Some("review".to_string()),
                with_fixup: false,
            },
        );
        assert_eq!(disposition, FailureRetryDisposition::Exhausted);
        assert!(!state.retry_attempts.contains_key("issue-2"));
    }

    #[test]
    fn retry_deferral_preserves_the_pipeline_cycle_and_payload() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let entry = RetryEntry {
            issue_id: "issue-1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 3,
            due_at_ms: 0,
            error: Some("agent crashed".to_string()),
            retry_from_step: Some("review".to_string()),
            with_fixup: true,
        };

        let deferred = defer_retry(
            &mut state,
            &entry,
            300_000,
            "no available orchestrator slots",
        );

        assert_eq!(deferred.issue_id, entry.issue_id);
        assert_eq!(deferred.identifier, entry.identifier);
        assert_eq!(deferred.attempt, entry.attempt);
        assert_eq!(
            deferred.error.as_deref(),
            Some("no available orchestrator slots")
        );
        assert_eq!(deferred.retry_from_step, entry.retry_from_step);
        assert_eq!(deferred.with_fixup, entry.with_fixup);
        assert!(deferred.due_at_ms > entry.due_at_ms);
        assert_eq!(
            state
                .retry_attempts
                .get(&entry.issue_id)
                .map(|scheduled| scheduled.due_at_ms),
            Some(deferred.due_at_ms)
        );
    }

    #[test]
    fn test_next_attempt() {
        assert_eq!(next_attempt(None), 2);
        assert_eq!(next_attempt(Some(1)), 2);
        assert_eq!(next_attempt(Some(5)), 6);
    }

    #[test]
    fn test_is_retry_due() {
        let past_entry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0, // in the past
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };
        assert!(is_retry_due(&past_entry));

        let future_entry = RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };
        assert!(!is_retry_due(&future_entry));
    }

    #[test]
    fn test_get_due_retries() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        // One due retry (in the past)
        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        // One future retry
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        let due = get_due_retries(&state);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].issue_id, "1");
    }

    #[test]
    fn test_next_retry_time() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        assert_eq!(next_retry_time(&state), None);

        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: 3000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        assert_eq!(next_retry_time(&state), Some(3000));
    }

    #[test]
    fn test_backoff_progression() {
        let max = 300_000u64;
        let delays: Vec<u64> = (1..=8).map(|a| calculate_backoff(a, max)).collect();
        assert_eq!(
            delays,
            vec![10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
        );
    }
}
