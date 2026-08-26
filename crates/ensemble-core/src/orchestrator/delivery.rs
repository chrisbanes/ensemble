use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use tracing::warn;

use super::pipeline_journal::{PipelineTransitionInput, PipelineTransitionKind, TerminalOutcome};
use super::retry::calculate_backoff;
use super::state::{FinalizeStatus, IssueFinalizeState, RepoFinalizeState};
use super::{
    FinalizeApprovalError, FinalizeRetryError, Orchestrator, HISTORY_OUTCOME_FAILED,
    HISTORY_OUTCOME_STOPPED, HISTORY_OUTCOME_SUCCEEDED,
};
use crate::agent::cancellation::{
    try_reserve_scheduler_worker_with_workspace_exclusivity, WorkerCapacity, WorkerReservationError,
};
use crate::agent::events::{WorkerIdentity, WorkerResult};
use crate::config::ensemble::{DeliveryRepairConfig, DeliveryStates};
use crate::config::template::{DeliveryRepairPromptContext, DeliveryRepairThread};
use crate::history::model::HistoryRecord;
use crate::interaction::{
    InteractionKind, InteractionRequest, InteractionResponse, InteractionResumeStrategy,
    InteractionStatus,
};
use crate::observability::events::PipelineEvent;
use crate::orchestrator::delivery_observation::{
    AutomaticMergeEvidence, BaseFreshness, CheckConclusion, CheckStatus, CheckSummary,
    DeliveryCheck, DeliveryObservation, DeliveryObservationFacts, DeliveryObservationFailure,
    DeliveryObservationFailureKind, DeliveryObservationRead, DeliveryObservationRetry,
    DeliveryRepairFeedback, Mergeability, ObservationFreshness, PullRequestTerminalState,
    ReviewDecision,
};
use crate::pipeline::engine::{PipelineRun, PipelineRunSnapshot};
use crate::tracker::{model::Issue, OwnershipConflict};
use crate::workspace::finalize::{DeliveryMergeConfig, DeliveryMergeMethod, FinalizeMode};
use crate::workspace::key::issue_workspace_key;

const DELIVERY_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const PULL_REQUEST_DISCOVERY_LIMIT: usize = 1_000;
const DELIVERY_OBSERVATION_QUERY: &str = "query DeliveryObservation($owner: String!, $name: String!, $number: Int!, $base: String!) { repository(owner: $owner, name: $name) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed mergeQueue(branch: $base) { id } pullRequest(number: $number) { id number url state merged isDraft isInMergeQueue headRefOid headRefName baseRefOid baseRefName mergeable reviewDecision statusCheckRollup { contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { name status conclusion app { databaseId } } ... on StatusContext { context state } } } } reviews: latestReviews(first: 100) { totalCount nodes { state body } } reviewThreads(first: 100) { totalCount nodes { isResolved isOutdated comments(first: 100) { totalCount nodes { body path line } } } } } } }";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryMode {
    Push,
    PushAndPr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryPhase {
    AwaitingApproval,
    Prepared,
    PushInFlight,
    ReconcilingPush,
    PrCreateInFlight,
    ReconcilingPr,
    Waiting,
    Published,
    Blocked,
}

/// One automatic GitHub operation that is owned by the retained delivery repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryMergeMutation {
    pub operation: DeliveryMergeOperation,
    pub pull_request_node_id: String,
    pub expected_head_sha: String,
    pub phase: DeliveryMergePhase,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub(crate) enum DeliveryMergeOperation {
    Direct { method: DeliveryMergeMethod },
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryMergePhase {
    InFlight,
    Reconciling,
    Queued,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeliveryMergeRemoteOutcome {
    Submitted,
    Rejected(String),
    Ambiguous(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryRepository {
    pub mode: DeliveryMode,
    pub phase: DeliveryPhase,
    #[serde(default)]
    pub approval_required: bool,
    /// Repository policy frozen when this delivery begins.
    #[serde(default)]
    pub merge: DeliveryMergeConfig,
    pub remote: String,
    pub base_branch: String,
    pub head_branch: String,
    pub local_sha: String,
    pub observed_remote_sha: Option<String>,
    pub marker: String,
    pub pr_number: Option<u64>,
    pub pr_url: Option<String>,
    #[serde(default)]
    pub observation: Option<crate::orchestrator::delivery_observation::DeliveryObservation>,
    /// Durable automatic merge or queue-admission intent, when configured.
    #[serde(default)]
    pub merge_mutation: Option<DeliveryMergeMutation>,
    #[serde(default)]
    pub ownership_conflict: Option<OwnershipConflict>,
    pub last_error: Option<String>,
    pub retry_from: Option<DeliveryPhase>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DeliveryRecord {
    pub issue_id: String,
    pub identifier: String,
    pub run_id: String,
    pub repositories: BTreeMap<String, DeliveryRepository>,
    #[serde(default)]
    pub terminal_history: Option<Box<HistoryRecord>>,
    #[serde(default)]
    pub review_projection: Option<ReviewProjection>,
    /// Policy copied from the selected pipeline before any delivery I/O.
    #[serde(default)]
    pub delivery_states: DeliveryStates,
    /// Repair policy copied with the selected delivery policy before any delivery I/O.
    #[serde(default)]
    pub delivery_repair: Option<DeliveryRepairConfig>,
    /// Durable, immutable repair intent for one retained delivery owner.
    #[serde(default)]
    pub repair: Option<DeliveryRepairState>,
    /// Cumulative repair launches admitted for this delivery owner. This survives a completed
    /// repair so later feedback cannot reset the configured delivery repair budget.
    #[serde(default)]
    pub delivery_repair_attempts_used: u32,
    /// Scheduler ownership frozen when delivery starts; old records without it must not launch a
    /// repair worker under an unrelated capacity bucket after restart.
    #[serde(default)]
    pub delivery_repair_capacity: Option<DeliveryRepairCapacity>,
    /// Delivery identities explicitly handed to a human are not automatically frozen again.
    #[serde(default)]
    pub delivery_repair_suppressions: BTreeSet<DeliveryRepairIdentity>,
    /// Success target copied from the selected pipeline with the delivery policy.
    #[serde(default)]
    pub success_state: Option<String>,
    /// Failure target copied from the selected pipeline with the delivery policy.
    #[serde(default)]
    pub failure_state: Option<String>,
    /// Closure without merge is retained for explicit operator recovery.
    #[serde(default)]
    pub closed_without_merge_parked: bool,
    /// The exact fact and target selected from the frozen delivery policy before tracker I/O.
    #[serde(default)]
    pub selected_delivery_state: Option<DeliveryStateProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub(crate) enum DeliveryRepairCapacity {
    State { state: String },
    Lane { lane: String },
}

/// Repair state owned by a delivery record rather than a new issue pipeline run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryRepairState {
    pub attempts_used: u32,
    pub phase: DeliveryRepairPhase,
    pub attempt: DeliveryRepairAttempt,
    /// A terminal runtime error retained with an operator-owned repair handoff.
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub post_worker_local_head: Option<String>,
    /// Stable durable identity for the interaction raised by this frozen feedback snapshot.
    #[serde(default)]
    pub interaction_id: Option<String>,
}

/// The durable boundary before a repair agent may cause an external effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryRepairPhase {
    PendingDispatch,
    DispatchInFlight,
    AwaitingHuman,
    PushPending,
    PushInFlight,
    ReconcilingPush,
}

/// The next journal-owned action for a frozen repair attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepairDispatch {
    Dispatch,
    AlreadyInFlight,
    Exhausted,
    NotPending,
}

/// The exact head and feedback frozen before a repair agent may be dispatched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryRepairAttempt {
    pub repository_key: String,
    pub pull_request_number: u64,
    pub pull_request_url: String,
    pub starting_sha: String,
    pub feedback: crate::orchestrator::delivery_observation::ActionableDeliveryFeedback,
}

/// Exact retained delivery identity that a human has chosen to handle manually.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(crate) struct DeliveryRepairIdentity {
    pub repository_key: String,
    pub pull_request_number: u64,
    pub head_sha: String,
}

impl DeliveryRepairIdentity {
    fn observed(repository_key: &str, facts: &DeliveryObservationFacts) -> Self {
        Self {
            repository_key: repository_key.to_string(),
            pull_request_number: facts.pull_request_number,
            head_sha: facts.head_sha.clone(),
        }
    }

    fn attempted(attempt: &DeliveryRepairAttempt) -> Self {
        Self {
            repository_key: attempt.repository_key.clone(),
            pull_request_number: attempt.pull_request_number,
            head_sha: attempt.starting_sha.clone(),
        }
    }
}

/// A versioned durable selection made from delivery evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryStateProjection {
    pub schema_version: u8,
    pub fact: DeliveryStateFact,
    pub target: String,
}

/// The durable issue-level tracker projection owned by finalization delivery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ReviewProjection {
    pub target: String,
    /// Every configured pull-request repository that must have durable delivery identity.
    #[serde(default)]
    pub repositories: Vec<String>,
    pub phase: ReviewProjectionPhase,
    pub diagnostic: Option<String>,
    pub last_observed_state: Option<String>,
    /// The exact history record prepared before the tracker state is changed.
    #[serde(default)]
    pub history_record: Option<HistoryRecord>,
    /// Whether the prepared record has been persisted to the history stores.
    #[serde(default)]
    pub history_persisted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewProjectionPhase {
    Pending,
    InFlight,
    Applied,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryAggregate {
    Active,
    Waiting,
    Published,
    Blocked,
}

/// The single, precedence-ordered fact projected from retained delivery evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryStateFact {
    Waiting,
    ChecksFailed,
    ChangesRequested,
    Approved,
    Merged,
    ClosedWithoutMerge,
}

impl DeliveryStates {
    fn target_for(&self, fact: DeliveryStateFact) -> Option<&str> {
        match fact {
            DeliveryStateFact::Waiting => self.waiting.as_deref(),
            DeliveryStateFact::ChecksFailed => self.checks_failed.as_deref(),
            DeliveryStateFact::ChangesRequested => self.changes_requested.as_deref(),
            DeliveryStateFact::Approved => self.approved.as_deref(),
            DeliveryStateFact::Merged => None,
            DeliveryStateFact::ClosedWithoutMerge => self.closed_without_merge.as_deref(),
        }
    }
}

impl DeliveryRecord {
    /// A manually handled head may be followed only by actionable feedback on a distinct head for
    /// the same retained pull request. The repository's durable delivery SHA remains unchanged;
    /// the replacement head is scoped to the next repair attempt and its guarded push lease.
    fn allows_suppressed_head_successor(
        has_repair_policy: bool,
        suppressions: &BTreeSet<DeliveryRepairIdentity>,
        repository_key: &str,
        retained_head: &str,
        facts: &DeliveryObservationFacts,
    ) -> bool {
        has_repair_policy
            && facts.terminal_state == PullRequestTerminalState::Open
            && facts.head_sha != retained_head
            && suppressions.contains(&DeliveryRepairIdentity {
                repository_key: repository_key.to_string(),
                pull_request_number: facts.pull_request_number,
                head_sha: retained_head.to_string(),
            })
            && facts
                .clone()
                .for_delivery(&facts.head_sha)
                .repair_feedback()
                .is_some()
    }

    fn repair_interaction_id(
        &self,
        repository_key: &str,
        pull_request_number: u64,
        head_sha: &str,
        cycle: u32,
    ) -> String {
        format!(
            "delivery-repair-{}-{}-{}-{}-{}",
            self.issue_id,
            repository_key.replace(|character: char| !character.is_ascii_alphanumeric(), "-"),
            pull_request_number,
            head_sha.replace(|character: char| !character.is_ascii_alphanumeric(), "-"),
            cycle,
        )
    }

    fn freeze_actionable_repair(&mut self, repository_key: &str, facts: &DeliveryObservationFacts) {
        let Some(policy) = self.delivery_repair.as_ref() else {
            return;
        };
        if self.repair.is_some() {
            return;
        }
        let identity = DeliveryRepairIdentity::observed(repository_key, facts);
        if self.delivery_repair_suppressions.contains(&identity) {
            return;
        }
        let classification = match facts.actionable_feedback() {
            Some(feedback) => DeliveryRepairFeedback::Actionable(feedback),
            None => match facts.repair_feedback() {
                Some(classification) => classification,
                None => return,
            },
        };
        if policy.max_attempts == 0 {
            return;
        }
        let (feedback, last_error) = match classification {
            DeliveryRepairFeedback::Actionable(feedback) => (feedback, None),
            DeliveryRepairFeedback::RequiresOperator {
                feedback,
                mergeability,
            } => (
                feedback,
                Some(format!(
                    "pull request mergeability is {}; resolve it before retrying delivery repair",
                    match mergeability {
                        Mergeability::Conflicting => "conflicting",
                        Mergeability::Unknown => "unknown",
                        Mergeability::Mergeable => "mergeable",
                    }
                )),
            ),
        };
        self.repair = Some(DeliveryRepairState {
            attempts_used: self.delivery_repair_attempts_used,
            phase: if last_error.is_some()
                || self.delivery_repair_attempts_used >= policy.max_attempts
            {
                DeliveryRepairPhase::AwaitingHuman
            } else {
                DeliveryRepairPhase::PendingDispatch
            },
            attempt: DeliveryRepairAttempt {
                repository_key: repository_key.to_string(),
                pull_request_number: facts.pull_request_number,
                pull_request_url: facts.pull_request_url.clone(),
                starting_sha: facts.head_sha.clone(),
                feedback,
            },
            last_error,
            post_worker_local_head: None,
            interaction_id: Some(self.repair_interaction_id(
                repository_key,
                facts.pull_request_number,
                &facts.head_sha,
                self.delivery_repair_attempts_used.saturating_add(1),
            )),
        });
    }

    /// Transitions only a frozen, budgeted repair to its durable launch intent. The caller must
    /// persist this record before reserving capacity or starting the agent.
    fn begin_repair_dispatch(&mut self) -> RepairDispatch {
        let Some(policy) = self.delivery_repair.as_ref() else {
            return RepairDispatch::NotPending;
        };
        let Some(repair) = self.repair.as_ref() else {
            return RepairDispatch::NotPending;
        };
        match repair.phase {
            DeliveryRepairPhase::DispatchInFlight => RepairDispatch::AlreadyInFlight,
            DeliveryRepairPhase::AwaitingHuman => RepairDispatch::NotPending,
            DeliveryRepairPhase::PushPending
            | DeliveryRepairPhase::PushInFlight
            | DeliveryRepairPhase::ReconcilingPush => RepairDispatch::NotPending,
            DeliveryRepairPhase::PendingDispatch
                if self.delivery_repair_attempts_used >= policy.max_attempts =>
            {
                self.repair.as_mut().expect("checked").phase = DeliveryRepairPhase::AwaitingHuman;
                RepairDispatch::Exhausted
            }
            DeliveryRepairPhase::PendingDispatch => {
                self.delivery_repair_attempts_used =
                    self.delivery_repair_attempts_used.saturating_add(1);
                let repair = self.repair.as_mut().expect("checked");
                repair.attempts_used = self.delivery_repair_attempts_used;
                repair.phase = DeliveryRepairPhase::DispatchInFlight;
                RepairDispatch::Dispatch
            }
        }
    }

    #[cfg(test)]
    fn complete_repair_dispatch_without_commit(&mut self) {
        let Some(repair) = self.repair.as_mut() else {
            return;
        };
        self.delivery_repair_attempts_used = self.delivery_repair_attempts_used.saturating_add(1);
        repair.attempts_used = self.delivery_repair_attempts_used;
        repair.phase = DeliveryRepairPhase::PendingDispatch;
    }

    fn complete_repair_dispatch(&mut self, result: &WorkerResult) {
        let Some(repair) = self.repair.as_mut() else {
            return;
        };
        repair.phase = DeliveryRepairPhase::AwaitingHuman;
        repair.last_error = match result {
            WorkerResult::Success {
                output,
                approval_request,
            } => match &output.result {
                crate::pipeline::verdict::StepResult::Succeeded => approval_request
                    .as_ref()
                    .map(|request| request.body.clone()),
                crate::pipeline::verdict::StepResult::Failed { summary }
                | crate::pipeline::verdict::StepResult::Concern { summary } => {
                    Some(summary.clone())
                }
            },
            WorkerResult::BlockedOnHuman { request } => Some(request.body.clone()),
            WorkerResult::Failed { error, .. } => Some(error.clone()),
        };
    }
    fn is_frozen_delivery_state(&self, observed_state: &str) -> bool {
        [
            self.delivery_states.waiting.as_deref(),
            self.delivery_states.checks_failed.as_deref(),
            self.delivery_states.changes_requested.as_deref(),
            self.delivery_states.approved.as_deref(),
            self.delivery_states.closed_without_merge.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|state| state.eq_ignore_ascii_case(observed_state))
    }

    pub(crate) fn delivery_state_fact(&self) -> Option<DeliveryStateFact> {
        if !self.review_ready() {
            return None;
        }
        let repositories = self.repositories.values().collect::<Vec<_>>();
        let observations = repositories
            .iter()
            .filter(|repository| repository.mode == DeliveryMode::PushAndPr)
            .map(|repository| repository.observation.as_ref())
            .collect::<Option<Vec<_>>>();
        let Some(observations) = observations else {
            return Some(DeliveryStateFact::Waiting);
        };
        if observations.iter().any(|observation| {
            observation.freshness != ObservationFreshness::Fresh
                || observation
                    .facts
                    .as_ref()
                    .is_none_or(|facts| !facts.matches_delivery || facts.head_diverged)
        }) {
            return Some(DeliveryStateFact::Waiting);
        }
        let facts = observations
            .iter()
            .filter_map(|observation| observation.facts.as_ref())
            .collect::<Vec<_>>();
        if facts
            .iter()
            .any(|facts| facts.terminal_state == PullRequestTerminalState::ClosedWithoutMerge)
        {
            return Some(DeliveryStateFact::ClosedWithoutMerge);
        }
        let open_facts = facts
            .iter()
            .copied()
            .filter(|facts| facts.terminal_state == PullRequestTerminalState::Open)
            .collect::<Vec<_>>();
        if open_facts
            .iter()
            .any(|facts| facts.review_decision == ReviewDecision::ChangesRequested)
        {
            return Some(DeliveryStateFact::ChangesRequested);
        }
        if open_facts
            .iter()
            .any(|facts| facts.check_summary == CheckSummary::Failing)
        {
            return Some(DeliveryStateFact::ChecksFailed);
        }
        if repositories.iter().all(|repository| match repository.mode {
            DeliveryMode::Push => repository.phase == DeliveryPhase::Published,
            DeliveryMode::PushAndPr => repository
                .observation
                .as_ref()
                .and_then(|observation| observation.facts.as_ref())
                .is_some_and(|facts| facts.terminal_state == PullRequestTerminalState::Merged),
        }) {
            return Some(DeliveryStateFact::Merged);
        }
        if repositories.iter().all(|repository| match repository.mode {
            DeliveryMode::Push => repository.phase == DeliveryPhase::Published,
            DeliveryMode::PushAndPr => repository
                .observation
                .as_ref()
                .and_then(|observation| observation.facts.as_ref())
                .is_some_and(|facts| {
                    facts.terminal_state == PullRequestTerminalState::Merged
                        || (facts.terminal_state == PullRequestTerminalState::Open
                            && facts.review_decision == ReviewDecision::Approved
                            && facts.check_summary == CheckSummary::Passing)
                }),
        }) {
            return Some(DeliveryStateFact::Approved);
        }
        Some(DeliveryStateFact::Waiting)
    }
    pub(crate) fn aggregate(&self) -> DeliveryAggregate {
        if self
            .review_projection
            .as_ref()
            .is_some_and(|projection| projection.phase == ReviewProjectionPhase::Blocked)
        {
            return DeliveryAggregate::Blocked;
        }
        if self
            .repositories
            .values()
            .any(|repo| repo.phase == DeliveryPhase::Blocked)
        {
            DeliveryAggregate::Blocked
        } else if self
            .repositories
            .values()
            .all(|repo| repo.phase == DeliveryPhase::Published)
        {
            DeliveryAggregate::Published
        } else if self.repositories.values().all(|repo| {
            matches!(
                repo.phase,
                DeliveryPhase::Waiting | DeliveryPhase::Published
            )
        }) {
            DeliveryAggregate::Waiting
        } else {
            DeliveryAggregate::Active
        }
    }

    fn review_ready(&self) -> bool {
        let repositories = self
            .review_projection
            .as_ref()
            .map(|projection| &projection.repositories);
        let repository_keys = repositories
            .filter(|keys| !keys.is_empty())
            .cloned()
            .unwrap_or_else(|| self.repositories.keys().cloned().collect());
        !repository_keys.is_empty()
            && repository_keys.iter().all(|repository_key| {
                match self.repositories.get(repository_key) {
                    Some(repository) => match repository.mode {
                        DeliveryMode::Push => repository.phase == DeliveryPhase::Published,
                        DeliveryMode::PushAndPr => {
                            repository.phase == DeliveryPhase::Waiting
                                && repository.observed_remote_sha.as_deref()
                                    == Some(repository.local_sha.as_str())
                                && repository.pr_number.is_some()
                                && repository.pr_url.is_some()
                        }
                    },
                    None => false,
                }
            })
    }

    fn is_parked_for_approval(&self) -> bool {
        self.repositories
            .values()
            .any(|repository| repository.phase == DeliveryPhase::AwaitingApproval)
            && self.repositories.values().all(|repository| {
                matches!(
                    repository.phase,
                    DeliveryPhase::AwaitingApproval
                        | DeliveryPhase::Waiting
                        | DeliveryPhase::Published
                )
            })
    }

    fn has_in_flight_review_projection(&self) -> bool {
        self.review_projection
            .as_ref()
            .is_some_and(|projection| projection.phase == ReviewProjectionPhase::InFlight)
    }

    fn has_fresh_nonclosed_delivery_evidence(&self) -> bool {
        self.review_ready()
            && self
                .repositories
                .values()
                .filter(|repository| repository.mode == DeliveryMode::PushAndPr)
                .all(|repository| {
                    repository.observation.as_ref().is_some_and(|observation| {
                        observation.freshness == ObservationFreshness::Fresh
                            && observation.facts.as_ref().is_some_and(|facts| {
                                facts.matches_delivery
                                    && !facts.head_diverged
                                    && facts.terminal_state
                                        != PullRequestTerminalState::ClosedWithoutMerge
                            })
                    })
                })
    }
}

fn terminal_delivery_outcome(
    delivery: &DeliveryRecord,
    observed_state: &str,
    legacy_success_state: Option<&str>,
    legacy_failure_state: Option<&str>,
) -> (TerminalOutcome, &'static str) {
    let success_state = delivery
        .success_state
        .as_deref()
        .or(legacy_success_state)
        .expect("terminal delivery has a frozen or legacy success state");
    let failure_state = delivery.failure_state.as_deref().or(legacy_failure_state);
    if observed_state.eq_ignore_ascii_case(success_state) {
        (TerminalOutcome::Succeeded, HISTORY_OUTCOME_SUCCEEDED)
    } else if failure_state.is_some_and(|state| observed_state.eq_ignore_ascii_case(state)) {
        (TerminalOutcome::Failed, HISTORY_OUTCOME_FAILED)
    } else {
        (TerminalOutcome::Failed, HISTORY_OUTCOME_STOPPED)
    }
}

fn automatic_merge_candidate(repository: &DeliveryRepository) -> bool {
    repository.mode == DeliveryMode::PushAndPr
        && repository.phase == DeliveryPhase::Waiting
        && repository.merge.is_automatic()
        && repository.pr_number.is_some()
        && repository.pr_url.is_some()
        && !repository
            .observation
            .as_ref()
            .and_then(|observation| observation.facts.as_ref())
            .is_some_and(|facts| facts.terminal_state == PullRequestTerminalState::Merged)
}

fn automatic_merge_candidate_key(
    repositories: &BTreeMap<String, DeliveryRepository>,
) -> Option<String> {
    repositories
        .iter()
        .find_map(|(key, repository)| {
            (automatic_merge_candidate(repository)
                && repository.merge_mutation.as_ref().is_some_and(|mutation| {
                    matches!(
                        mutation.phase,
                        DeliveryMergePhase::InFlight | DeliveryMergePhase::Reconciling
                    )
                }))
            .then(|| key.clone())
        })
        .or_else(|| {
            repositories.iter().find_map(|(key, repository)| {
                (automatic_merge_candidate(repository) && repository.merge_mutation.is_none())
                    .then(|| key.clone())
            })
        })
        .or_else(|| {
            repositories.iter().find_map(|(key, repository)| {
                automatic_merge_candidate(repository).then(|| key.clone())
            })
        })
}

pub(crate) fn canonical_marker(run_id: &str, issue_id: &str, repository_key: &str) -> String {
    fn hex(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    format!(
        "<!-- ensemble:delivery:v1 run={} issue={} repository={} -->",
        hex(run_id),
        hex(issue_id),
        hex(repository_key)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemotePullRequest {
    pub repository_key: String,
    pub repository: Option<String>,
    pub head_repository: Option<String>,
    pub author: Option<String>,
    pub authored_by_authenticated_viewer: bool,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: String,
    pub body: String,
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PullRequestAdoptionPolicy {
    pub repository: String,
    pub base_branch: String,
    pub head_branch: String,
    pub require_authenticated_author: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalRepositoryIdentity {
    pub head_branch: String,
    pub local_sha: String,
}

/// Result of the single repair-specific publication attempt. `Ambiguous` is
/// intentionally reconciled through the retained PR and is never retried blind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuardedRepairPushOutcome {
    Confirmed,
    Ambiguous,
    Rejected,
}

#[async_trait]
pub(crate) trait DeliveryRemote: Send + Sync {
    fn supports_delivery_observation(&self) -> bool {
        false
    }

    fn pull_request_adoption_policy(
        &self,
        _config: &crate::config::ensemble::EnsembleConfig,
        _issue_id: &str,
    ) -> Option<PullRequestAdoptionPolicy> {
        None
    }

    async fn local_identity(
        &self,
        repository_path: &Path,
    ) -> Result<LocalRepositoryIdentity, String>;

    async fn remote_head(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
    ) -> Result<Option<String>, String>;

    async fn push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        local_sha: &str,
    ) -> Result<(), String>;

    async fn guarded_repair_push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        observed_head: &str,
        local_head: &str,
    ) -> GuardedRepairPushOutcome {
        let _ = (
            repository_path,
            remote,
            head_branch,
            observed_head,
            local_head,
        );
        GuardedRepairPushOutcome::Rejected
    }

    async fn list_pull_requests(
        &self,
        repository_path: &Path,
        repository_key: &str,
        adoption_policy: Option<&PullRequestAdoptionPolicy>,
    ) -> Result<Vec<RemotePullRequest>, String>;

    async fn create_pull_request(
        &self,
        repository_path: &Path,
        base_branch: &str,
        head_branch: &str,
        marker: &str,
    ) -> Result<(), String>;

    async fn observe_pull_request(
        &self,
        _request: PullRequestObservationRequest<'_>,
    ) -> DeliveryObservationRead {
        DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::UnsupportedResponse,
            "delivery remote does not support pull request observation",
        ))
    }

    async fn merge_pull_request(
        &self,
        _repository_path: &Path,
        _pull_request_node_id: &str,
        _expected_head_sha: &str,
        _method: DeliveryMergeMethod,
    ) -> DeliveryMergeRemoteOutcome {
        DeliveryMergeRemoteOutcome::Rejected(
            "delivery remote does not support automatic merge".to_string(),
        )
    }

    async fn enqueue_pull_request(
        &self,
        _repository_path: &Path,
        _pull_request_node_id: &str,
        _expected_head_sha: &str,
    ) -> DeliveryMergeRemoteOutcome {
        DeliveryMergeRemoteOutcome::Rejected(
            "delivery remote does not support merge queue admission".to_string(),
        )
    }
}

pub(crate) struct PullRequestObservationRequest<'a> {
    pub repository_path: &'a Path,
    pub pull_request_number: u64,
    pub pull_request_url: &'a str,
    pub base_branch: &'a str,
    pub head_branch: &'a str,
    pub remote: &'a str,
    pub collect_automatic_merge_policy: bool,
    pub direct_merge_method: Option<DeliveryMergeMethod>,
}

pub(crate) struct CliDeliveryRemote;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    url: String,
    body: String,
    head_ref_name: String,
    base_ref_name: String,
    head_ref_oid: String,
    author: Option<GhActor>,
    head_repository: Option<GhRepository>,
}

#[derive(Deserialize)]
struct GhActor {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepository {
    name_with_owner: String,
}

#[async_trait]
impl DeliveryRemote for CliDeliveryRemote {
    fn supports_delivery_observation(&self) -> bool {
        true
    }
    fn pull_request_adoption_policy(
        &self,
        config: &crate::config::ensemble::EnsembleConfig,
        issue_id: &str,
    ) -> Option<PullRequestAdoptionPolicy> {
        if config.tracker.kind != "github" {
            return None;
        }
        let configured = config
            .tracker
            .github
            .as_ref()?
            .ownership
            .as_ref()?
            .delivery_adoption
            .as_ref()?;
        Some(PullRequestAdoptionPolicy {
            repository: configured.repository.clone(),
            base_branch: configured.base_branch.clone(),
            head_branch: configured.render_branch(&issue_workspace_key(issue_id)),
            require_authenticated_author: configured.require_authenticated_author,
        })
    }

    async fn local_identity(
        &self,
        repository_path: &Path,
    ) -> Result<LocalRepositoryIdentity, String> {
        Ok(LocalRepositoryIdentity {
            head_branch: command_stdout(
                repository_path,
                "git",
                &["rev-parse", "--abbrev-ref", "HEAD"],
            )
            .await?,
            local_sha: command_stdout(repository_path, "git", &["rev-parse", "HEAD"]).await?,
        })
    }

    async fn remote_head(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
    ) -> Result<Option<String>, String> {
        let reference = format!("refs/heads/{head_branch}");
        let stdout = command_stdout(
            repository_path,
            "git",
            &["ls-remote", "--heads", remote, &reference],
        )
        .await?;
        if stdout.is_empty() {
            return Ok(None);
        }
        let mut lines = stdout.lines();
        let line = lines.next().expect("non-empty output has one line");
        if lines.next().is_some() {
            return Err(format!(
                "remote '{remote}' returned multiple heads for '{reference}'"
            ));
        }
        let (sha, observed_reference) = line
            .split_once(char::is_whitespace)
            .ok_or_else(|| "git ls-remote returned malformed output".to_string())?;
        if observed_reference.trim() != reference {
            return Err(format!(
                "git ls-remote returned unexpected reference '{}'",
                observed_reference.trim()
            ));
        }
        Ok(Some(sha.to_string()))
    }

    async fn push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        local_sha: &str,
    ) -> Result<(), String> {
        let refspec = format!("{local_sha}:refs/heads/{head_branch}");
        command_stdout(repository_path, "git", &["push", remote, &refspec])
            .await
            .map(|_| ())
    }

    async fn guarded_repair_push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        observed_head: &str,
        local_head: &str,
    ) -> GuardedRepairPushOutcome {
        let Ok(identity) = self.local_identity(repository_path).await else {
            return GuardedRepairPushOutcome::Rejected;
        };
        if identity.head_branch != head_branch || identity.local_sha != local_head {
            return GuardedRepairPushOutcome::Rejected;
        }
        let Ok(Some(remote_head)) = self.remote_head(repository_path, remote, head_branch).await
        else {
            return GuardedRepairPushOutcome::Rejected;
        };
        if remote_head != observed_head {
            return GuardedRepairPushOutcome::Rejected;
        }
        if command_stdout(
            repository_path,
            "git",
            &["merge-base", "--is-ancestor", observed_head, local_head],
        )
        .await
        .is_err()
        {
            return GuardedRepairPushOutcome::Rejected;
        }
        let arguments =
            guarded_repair_push_arguments(remote, head_branch, observed_head, local_head);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        match command_stdout(repository_path, "git", &arguments).await {
            Ok(_) => GuardedRepairPushOutcome::Confirmed,
            Err(_) => GuardedRepairPushOutcome::Ambiguous,
        }
    }

    async fn list_pull_requests(
        &self,
        repository_path: &Path,
        repository_key: &str,
        adoption_policy: Option<&PullRequestAdoptionPolicy>,
    ) -> Result<Vec<RemotePullRequest>, String> {
        let (repository, authenticated_viewer) = if let Some(policy) = adoption_policy {
            let repository_json = command_stdout(
                repository_path,
                "gh",
                &["repo", "view", "--json", "nameWithOwner"],
            )
            .await?;
            let repository: GhRepository = serde_json::from_str(&repository_json)
                .map_err(|error| format!("invalid gh repo view output: {error}"))?;
            let viewer = if policy.require_authenticated_author {
                let viewer_json = command_stdout(repository_path, "gh", &["api", "user"]).await?;
                Some(
                    serde_json::from_str::<GhActor>(&viewer_json)
                        .map_err(|error| format!("invalid authenticated GitHub user: {error}"))?
                        .login,
                )
            } else {
                None
            };
            (Some(repository.name_with_owner), viewer)
        } else {
            (None, None)
        };
        let stdout = command_stdout(
            repository_path,
            "gh",
            &[
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                "1000",
                "--json",
                "number,url,body,headRefName,baseRefName,headRefOid,author,headRepository",
            ],
        )
        .await?;
        let pull_requests: Vec<GhPullRequest> = serde_json::from_str(&stdout)
            .map_err(|error| format!("invalid gh pr list output: {error}"))?;
        if pull_requests.len() == PULL_REQUEST_DISCOVERY_LIMIT {
            return Err(format!(
                "pull request discovery reached its {PULL_REQUEST_DISCOVERY_LIMIT}-item limit"
            ));
        }
        Ok(pull_requests
            .into_iter()
            .map(|pull_request| RemotePullRequest {
                repository_key: repository_key.to_string(),
                repository: repository.clone(),
                head_repository: pull_request
                    .head_repository
                    .map(|repository| repository.name_with_owner),
                authored_by_authenticated_viewer: authenticated_viewer.as_deref().is_some_and(
                    |viewer| {
                        pull_request
                            .author
                            .as_ref()
                            .is_some_and(|author| author.login.eq_ignore_ascii_case(viewer))
                    },
                ),
                author: pull_request.author.map(|author| author.login),
                head_branch: pull_request.head_ref_name,
                base_branch: pull_request.base_ref_name,
                head_sha: pull_request.head_ref_oid,
                body: pull_request.body,
                number: pull_request.number,
                url: pull_request.url,
            })
            .collect())
    }

    async fn create_pull_request(
        &self,
        repository_path: &Path,
        base_branch: &str,
        head_branch: &str,
        marker: &str,
    ) -> Result<(), String> {
        command_stdout(
            repository_path,
            "gh",
            &[
                "pr",
                "create",
                "--fill",
                "--head",
                head_branch,
                "--base",
                base_branch,
                "--body",
                marker,
            ],
        )
        .await
        .map(|_| ())
    }

    async fn observe_pull_request(
        &self,
        request: PullRequestObservationRequest<'_>,
    ) -> DeliveryObservationRead {
        let PullRequestObservationRequest {
            repository_path,
            pull_request_number,
            pull_request_url,
            base_branch,
            head_branch,
            remote,
            collect_automatic_merge_policy,
            direct_merge_method,
        } = request;
        let (owner, name) = match github_repository_identity(repository_path, remote).await {
            Ok(repository) => repository,
            Err(read) => return read,
        };
        let arguments =
            delivery_observation_arguments(&owner, &name, pull_request_number, base_branch);
        let argument_refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        let stdout = match observation_command_stdout(repository_path, &argument_refs).await {
            Ok(stdout) => stdout,
            Err(read) => return read,
        };
        let response: serde_json::Value = match serde_json::from_str(&stdout) {
            Ok(value) => value,
            Err(_) => {
                return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned an invalid pull request observation",
                ));
            }
        };
        let Some(repository) = response.pointer("/data/repository") else {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an incomplete repository observation",
            ));
        };
        let Some(value) = repository.get("pullRequest") else {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an incomplete pull request observation",
            ));
        };
        let node_id = value.get("id").and_then(serde_json::Value::as_str);
        let number = value.get("number").and_then(serde_json::Value::as_u64);
        let url = value.get("url").and_then(serde_json::Value::as_str);
        let state = value.get("state").and_then(serde_json::Value::as_str);
        let head_sha = value.get("headRefOid").and_then(serde_json::Value::as_str);
        let observed_head = value.get("headRefName").and_then(serde_json::Value::as_str);
        let base_sha = value.get("baseRefOid").and_then(serde_json::Value::as_str);
        let observed_base = value.get("baseRefName").and_then(serde_json::Value::as_str);
        let Some((node_id, number, url, state, head_sha, observed_head, base_sha, observed_base)) =
            node_id
                .zip(number)
                .zip(url)
                .zip(state)
                .zip(head_sha)
                .zip(observed_head)
                .zip(base_sha)
                .zip(observed_base)
                .map(
                    |(
                        ((((((node_id, number), url), state), head_sha), observed_head), base_sha),
                        observed_base,
                    )| {
                        (
                            node_id,
                            number,
                            url,
                            state,
                            head_sha,
                            observed_head,
                            base_sha,
                            observed_base,
                        )
                    },
                )
        else {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an incomplete pull request observation",
            ));
        };
        if number != pull_request_number
            || url != pull_request_url
            || observed_head != head_branch
            || observed_base != base_branch
        {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::InvalidIdentity,
                "GitHub returned a pull request other than the durable delivery identity",
            ));
        }
        let terminal_state = match (
            state,
            value
                .get("merged")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        ) {
            ("OPEN", _) => PullRequestTerminalState::Open,
            ("MERGED", _) | ("CLOSED", true) => PullRequestTerminalState::Merged,
            ("CLOSED", false) => PullRequestTerminalState::ClosedWithoutMerge,
            _ => {
                return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::UnsupportedResponse,
                    "GitHub returned an unsupported pull request state",
                ))
            }
        };
        let mergeability = match value.get("mergeable").and_then(serde_json::Value::as_str) {
            Some("MERGEABLE") => Mergeability::Mergeable,
            Some("CONFLICTING") => Mergeability::Conflicting,
            Some("UNKNOWN") | None => Mergeability::Unknown,
            _ => {
                return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::UnsupportedResponse,
                    "GitHub returned an unsupported mergeability state",
                ))
            }
        };
        let review_decision = match value
            .get("reviewDecision")
            .and_then(serde_json::Value::as_str)
        {
            Some("APPROVED") => ReviewDecision::Approved,
            Some("CHANGES_REQUESTED") => ReviewDecision::ChangesRequested,
            Some("REVIEW_REQUIRED") => ReviewDecision::ReviewRequired,
            None => ReviewDecision::Unknown,
            _ => {
                return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::UnsupportedResponse,
                    "GitHub returned an unsupported review decision",
                ))
            }
        };
        let checks = match complete_checks(value) {
            Ok(checks) => checks,
            Err(failure) => return DeliveryObservationRead::Terminal(failure),
        };
        let (feedback, has_unresolved_review_threads) = match complete_feedback(value) {
            Ok(feedback) => feedback,
            Err(failure) => return DeliveryObservationRead::Terminal(failure),
        };
        let has_requested_changes = value
            .pointer("/reviews/nodes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|reviews| {
                reviews.iter().any(|review| {
                    review.get("state").and_then(serde_json::Value::as_str)
                        == Some("CHANGES_REQUESTED")
                })
            });
        let queued = value
            .get("isInMergeQueue")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let Some(is_draft) = value.get("isDraft").and_then(serde_json::Value::as_bool) else {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an incomplete pull request readiness observation",
            ));
        };
        let queue_supported = response
            .pointer("/data/repository/mergeQueue")
            .is_some_and(serde_json::Value::is_object);
        let comparison_endpoint = format!("repos/{owner}/{name}/compare/{base_sha}...{head_sha}");
        let comparison_arguments = ["api", comparison_endpoint.as_str()];
        let comparison_stdout =
            match observation_command_stdout(repository_path, &comparison_arguments).await {
                Ok(stdout) => stdout,
                Err(read) => return read,
            };
        let comparison: serde_json::Value = match serde_json::from_str(&comparison_stdout) {
            Ok(value) => value,
            Err(_) => {
                return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned an invalid base comparison",
                ));
            }
        };
        let Some(behind_by) = comparison
            .get("behind_by")
            .and_then(serde_json::Value::as_u64)
        else {
            return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an incomplete base comparison",
            ));
        };
        let base_freshness = match behind_by {
            0 => BaseFreshness::UpToDate,
            _ => BaseFreshness::Behind,
        };
        let automatic_merge =
            if automatic_merge_policy_needed(collect_automatic_merge_policy, is_draft) {
                let repository_merge_method_supported =
                    repository_merge_method_supported(repository, direct_merge_method);
                let encoded_base_branch = github_path_segment(base_branch);
                let rules_endpoint =
                    format!("repos/{owner}/{name}/rules/branches/{encoded_base_branch}");
                let rules_arguments = repository_rules_arguments(&rules_endpoint);
                let rules_stdout =
                    match observation_command_stdout(repository_path, &rules_arguments).await {
                        Ok(stdout) => stdout,
                        Err(read) => return read,
                    };
                let rules = match serde_json::from_str::<serde_json::Value>(&rules_stdout) {
                    Ok(value) => value,
                    Err(_) => {
                        return DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                            DeliveryObservationFailureKind::MalformedResponse,
                            "GitHub returned invalid repository rules",
                        ));
                    }
                };
                let protection_endpoint =
                    format!("repos/{owner}/{name}/branches/{encoded_base_branch}/protection");
                let protection_arguments = ["api", protection_endpoint.as_str()];
                let protection_stdout = match optional_observation_command_stdout(
                    repository_path,
                    &protection_arguments,
                )
                .await
                {
                    Ok(stdout) => stdout,
                    Err(read) => return read,
                };
                let protection = match protection_stdout {
                    Some(stdout) => match serde_json::from_str::<serde_json::Value>(&stdout) {
                        Ok(value) => Some(value),
                        Err(_) => {
                            return DeliveryObservationRead::Terminal(
                                DeliveryObservationFailure::new(
                                    DeliveryObservationFailureKind::MalformedResponse,
                                    "GitHub returned invalid classic branch protection",
                                ),
                            );
                        }
                    },
                    None => None,
                };
                automatic_merge_evidence_from_policy(
                    &rules,
                    protection.as_ref(),
                    AutomaticMergeStatus {
                        checks: &checks,
                        review_decision,
                        has_requested_changes,
                        has_unresolved_review_threads,
                        base_freshness,
                        direct_merge_method,
                        repository_merge_method_supported,
                        queue_supported,
                        queued,
                    },
                )
            } else {
                None
            };
        DeliveryObservationRead::Observed(DeliveryObservationFacts {
            pull_request_node_id: Some(node_id.to_string()),
            pull_request_number: number,
            pull_request_url: url.to_string(),
            head_sha: head_sha.to_string(),
            matches_delivery: false,
            head_diverged: false,
            terminal_state,
            mergeability,
            base_freshness,
            checks,
            check_summary: crate::orchestrator::delivery_observation::CheckSummary::Pending,
            review_decision,
            in_merge_queue: queued,
            automatic_merge,
            feedback,
        })
    }

    async fn merge_pull_request(
        &self,
        repository_path: &Path,
        pull_request_node_id: &str,
        expected_head_sha: &str,
        method: DeliveryMergeMethod,
    ) -> DeliveryMergeRemoteOutcome {
        let method = match method {
            DeliveryMergeMethod::Merge => "MERGE",
            DeliveryMergeMethod::Squash => "SQUASH",
            DeliveryMergeMethod::Rebase => "REBASE",
        };
        run_graphql_delivery_mutation(
            repository_path,
            "mutation($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}){pullRequest{id}}}",
            pull_request_node_id,
            expected_head_sha,
            Some(method),
            "/data/mergePullRequest/pullRequest/id",
        )
        .await
    }

    async fn enqueue_pull_request(
        &self,
        repository_path: &Path,
        pull_request_node_id: &str,
        expected_head_sha: &str,
    ) -> DeliveryMergeRemoteOutcome {
        run_graphql_delivery_mutation(
            repository_path,
            "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}}",
            pull_request_node_id,
            expected_head_sha,
            None,
            "/data/enqueuePullRequest/mergeQueueEntry/id",
        )
        .await
    }
}

async fn run_graphql_delivery_mutation(
    repository_path: &Path,
    query: &str,
    pull_request_node_id: &str,
    expected_head_sha: &str,
    method: Option<&str>,
    success_pointer: &str,
) -> DeliveryMergeRemoteOutcome {
    let mut owned = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
        "-F".to_string(),
        format!("id={pull_request_node_id}"),
        "-F".to_string(),
        format!("head={expected_head_sha}"),
    ];
    if let Some(method) = method {
        owned.extend(["-F".to_string(), format!("method={method}")]);
    }
    let arguments = owned.iter().map(String::as_str).collect::<Vec<_>>();
    let output = match run_delivery_command(repository_path, "gh", &arguments).await {
        Ok(output) => output,
        Err(_) => {
            return DeliveryMergeRemoteOutcome::Ambiguous(
                "GitHub delivery mutation did not return a confirmed response".to_string(),
            )
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        let message = if stderr.contains("graphql")
            || stderr.contains("unprocessable")
            || stderr.contains("conflict")
            || stderr.contains("forbidden")
        {
            "GitHub rejected the delivery mutation"
        } else {
            "GitHub delivery mutation outcome is ambiguous"
        };
        return if message.contains("rejected") {
            DeliveryMergeRemoteOutcome::Rejected(message.to_string())
        } else {
            DeliveryMergeRemoteOutcome::Ambiguous(message.to_string())
        };
    }
    let response = match serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        Ok(response) => response,
        Err(_) => {
            return DeliveryMergeRemoteOutcome::Ambiguous(
                "GitHub delivery mutation returned malformed confirmation".to_string(),
            )
        }
    };
    if response
        .pointer(success_pointer)
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        DeliveryMergeRemoteOutcome::Submitted
    } else if response.get("errors").is_some() {
        DeliveryMergeRemoteOutcome::Rejected("GitHub rejected the delivery mutation".to_string())
    } else {
        DeliveryMergeRemoteOutcome::Ambiguous(
            "GitHub delivery mutation returned incomplete confirmation".to_string(),
        )
    }
}

fn parse_check(value: &serde_json::Value) -> Option<DeliveryCheck> {
    let name = value
        .get("name")
        .or_else(|| value.get("context"))
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let raw_status = value
        .get("status")
        .or_else(|| value.get("state"))
        .and_then(serde_json::Value::as_str)?;
    let status = match raw_status {
        "PENDING" | "EXPECTED" => CheckStatus::Pending,
        "QUEUED" => CheckStatus::Queued,
        "IN_PROGRESS" => CheckStatus::InProgress,
        "COMPLETED" | "SUCCESS" | "FAILURE" | "ERROR" => CheckStatus::Completed,
        _ => return None,
    };
    let conclusion = match value.get("conclusion").and_then(serde_json::Value::as_str) {
        Some("SUCCESS") => Some(CheckConclusion::Success),
        Some("NEUTRAL") => Some(CheckConclusion::Neutral),
        Some("SKIPPED") => Some(CheckConclusion::Skipped),
        Some("FAILURE") | Some("ERROR") => Some(CheckConclusion::Failure),
        Some("TIMED_OUT") => Some(CheckConclusion::TimedOut),
        Some("CANCELLED") => Some(CheckConclusion::Cancelled),
        Some("ACTION_REQUIRED") => Some(CheckConclusion::ActionRequired),
        Some("STARTUP_FAILURE") => Some(CheckConclusion::StartupFailure),
        None => match raw_status {
            "SUCCESS" => Some(CheckConclusion::Success),
            "FAILURE" | "ERROR" => Some(CheckConclusion::Failure),
            _ => None,
        },
        Some(_) => return None,
    };
    Some(DeliveryCheck {
        name,
        integration_id: value
            .pointer("/app/databaseId")
            .and_then(serde_json::Value::as_u64),
        status,
        conclusion,
    })
}

fn repository_merge_method_supported(
    repository: &serde_json::Value,
    method: Option<DeliveryMergeMethod>,
) -> Option<bool> {
    let field = match method {
        Some(DeliveryMergeMethod::Merge) => "mergeCommitAllowed",
        Some(DeliveryMergeMethod::Squash) => "squashMergeAllowed",
        Some(DeliveryMergeMethod::Rebase) => "rebaseMergeAllowed",
        None => return Some(true),
    };
    repository.get(field)?.as_bool()
}

fn automatic_merge_policy_needed(requested: bool, is_draft: bool) -> bool {
    requested && !is_draft
}

fn delivery_observation_arguments(
    owner: &str,
    name: &str,
    pull_request_number: u64,
    base_branch: &str,
) -> Vec<String> {
    vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={DELIVERY_OBSERVATION_QUERY}"),
        "-f".to_string(),
        format!("owner={owner}"),
        "-f".to_string(),
        format!("name={name}"),
        "-F".to_string(),
        format!("number={pull_request_number}"),
        "-f".to_string(),
        format!("base={base_branch}"),
    ]
}

fn repository_rules_arguments(endpoint: &str) -> [&str; 4] {
    ["api", "--paginate", "--slurp", endpoint]
}

fn github_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

#[derive(Default)]
struct AutomaticMergeRequirements {
    required_checks: Vec<(String, Option<u64>)>,
    required_approvals: u64,
    requires_approval_review: bool,
    requires_resolved_review_threads: bool,
    requires_current_base: bool,
    requires_merge_queue: bool,
    direct_merge_method_unsupported: bool,
}

struct AutomaticMergeStatus<'a> {
    checks: &'a [DeliveryCheck],
    review_decision: ReviewDecision,
    has_requested_changes: bool,
    has_unresolved_review_threads: bool,
    base_freshness: BaseFreshness,
    direct_merge_method: Option<DeliveryMergeMethod>,
    repository_merge_method_supported: Option<bool>,
    queue_supported: bool,
    queued: bool,
}

fn automatic_merge_evidence_from_policy(
    rules: &serde_json::Value,
    classic_protection: Option<&serde_json::Value>,
    status: AutomaticMergeStatus<'_>,
) -> Option<AutomaticMergeEvidence> {
    let repository_merge_method_supported = status.repository_merge_method_supported?;
    let mut requirements = AutomaticMergeRequirements::default();
    let pages = rules.as_array()?;
    let rules = if pages.iter().all(serde_json::Value::is_array) {
        let mut rules = Vec::new();
        for page in pages {
            rules.extend(page.as_array()?);
        }
        rules
    } else if pages.iter().any(serde_json::Value::is_array) {
        return None;
    } else {
        pages.iter().collect::<Vec<_>>()
    };
    for rule in rules {
        match rule.get("type").and_then(serde_json::Value::as_str)? {
            "required_status_checks" => {
                requirements.requires_current_base |= rule
                    .pointer("/parameters/strict_required_status_checks_policy")?
                    .as_bool()?;
                let configured = rule
                    .pointer("/parameters/required_status_checks")?
                    .as_array()?;
                for check in configured {
                    requirements.required_checks.push((
                        check.get("context")?.as_str()?.to_string(),
                        check
                            .get("integration_id")
                            .and_then(serde_json::Value::as_u64),
                    ));
                }
            }
            "pull_request" => {
                requirements.required_approvals = requirements.required_approvals.max(
                    rule.pointer("/parameters/required_approving_review_count")?
                        .as_u64()?,
                );
                requirements.requires_approval_review |= rule
                    .pointer("/parameters/require_code_owner_review")?
                    .as_bool()?
                    || rule
                        .pointer("/parameters/require_last_push_approval")?
                        .as_bool()?;
                requirements.requires_resolved_review_threads |= rule
                    .pointer("/parameters/required_review_thread_resolution")?
                    .as_bool()?;
                let allowed_merge_methods = rule
                    .pointer("/parameters/allowed_merge_methods")?
                    .as_array()?;
                let mut configured_method_allowed = status.direct_merge_method.is_none();
                for allowed_method in allowed_merge_methods {
                    let allowed_method = match allowed_method.as_str()? {
                        "merge" => DeliveryMergeMethod::Merge,
                        "squash" => DeliveryMergeMethod::Squash,
                        "rebase" => DeliveryMergeMethod::Rebase,
                        _ => return None,
                    };
                    configured_method_allowed |= Some(allowed_method) == status.direct_merge_method;
                }
                requirements.direct_merge_method_unsupported |= !configured_method_allowed;
            }
            "merge_queue" => {
                rule.get("parameters")?.as_object()?;
                requirements.requires_merge_queue = true;
            }
            "deletion" | "non_fast_forward" => {}
            _ => return None,
        }
    }
    if let Some(protection) = classic_protection {
        protection.as_object()?;
        let required_status_checks = protection.get("required_status_checks")?;
        if !required_status_checks.is_null() {
            requirements.requires_current_base |=
                required_status_checks.get("strict")?.as_bool()?;
            for context in required_status_checks.get("contexts")?.as_array()? {
                requirements
                    .required_checks
                    .push((context.as_str()?.to_string(), None));
            }
            for check in required_status_checks.get("checks")?.as_array()? {
                let app_id = match check.get("app_id")? {
                    value if value.is_null() => None,
                    value => match value.as_i64()? {
                        -1 => None,
                        id if id >= 0 => Some(id as u64),
                        _ => return None,
                    },
                };
                requirements
                    .required_checks
                    .push((check.get("context")?.as_str()?.to_string(), app_id));
            }
        }
        let reviews = protection.get("required_pull_request_reviews")?;
        if !reviews.is_null() {
            requirements.required_approvals = requirements
                .required_approvals
                .max(reviews.get("required_approving_review_count")?.as_u64()?);
            requirements.requires_approval_review |=
                reviews.get("require_code_owner_reviews")?.as_bool()?
                    || reviews.get("require_last_push_approval")?.as_bool()?;
        }
        let conversation_resolution = protection.get("required_conversation_resolution")?;
        if !conversation_resolution.is_null() {
            requirements.requires_resolved_review_threads |=
                conversation_resolution.get("enabled")?.as_bool()?;
        }
    }
    let required_checks_passing =
        requirements
            .required_checks
            .iter()
            .all(|(name, integration_id)| {
                status.checks.iter().any(|check| {
                    check.name == *name
                        && integration_id
                            .is_none_or(|required| check.integration_id == Some(required))
                        && check.status == CheckStatus::Completed
                        && matches!(
                            check.conclusion,
                            Some(
                                CheckConclusion::Success
                                    | CheckConclusion::Neutral
                                    | CheckConclusion::Skipped
                            )
                        )
                })
            });
    Some(AutomaticMergeEvidence {
        required_checks_passing,
        required_reviews_satisfied: (requirements.required_approvals == 0
            && !requirements.requires_approval_review)
            || status.review_decision == ReviewDecision::Approved,
        required_review_threads_resolved: !requirements.requires_resolved_review_threads
            || !status.has_unresolved_review_threads,
        strict_base_satisfied: !requirements.requires_current_base
            || status.base_freshness == BaseFreshness::UpToDate,
        direct_merge_supported: !requirements.requires_merge_queue
            && !requirements.direct_merge_method_unsupported
            && repository_merge_method_supported,
        // `latestReviews` was completeness-checked with the rest of feedback. This is explicit
        // current-review evidence and does not reinterpret a nullable reviewDecision as safe.
        no_requested_changes: !status.has_requested_changes,
        queue_supported: status.queue_supported,
        queued: status.queued,
    })
}

fn complete_checks(
    value: &serde_json::Value,
) -> Result<Vec<DeliveryCheck>, DeliveryObservationFailure> {
    let Some(rollup) = value.get("statusCheckRollup") else {
        return Ok(Vec::new());
    };
    if rollup.is_null() {
        return Ok(Vec::new());
    }
    let Some(contexts) = rollup.get("contexts") else {
        return Err(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::MalformedResponse,
            "GitHub returned an incomplete check rollup",
        ));
    };
    let Some(total) = contexts
        .get("totalCount")
        .and_then(serde_json::Value::as_u64)
    else {
        return Err(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::MalformedResponse,
            "GitHub returned a check rollup without a total count",
        ));
    };
    let Some(nodes) = contexts.get("nodes").and_then(serde_json::Value::as_array) else {
        return Err(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::MalformedResponse,
            "GitHub returned a check rollup without contexts",
        ));
    };
    if total != nodes.len() as u64 {
        return Err(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::UnsupportedResponse,
            "GitHub check rollup exceeds the complete observation limit",
        ));
    }
    nodes
        .iter()
        .map(parse_check)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::UnsupportedResponse,
                "GitHub returned an unsupported check context",
            )
        })
}

fn complete_feedback(
    value: &serde_json::Value,
) -> Result<
    (
        crate::orchestrator::delivery_observation::DeliveryFeedback,
        bool,
    ),
    DeliveryObservationFailure,
> {
    use crate::orchestrator::delivery_observation::{DeliveryFeedback, DeliveryFeedbackThread};

    let reviews = value.get("reviews").ok_or_else(|| {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::MalformedResponse,
            "GitHub returned an incomplete pull request review observation",
        )
    })?;
    let change_request_bodies = complete_connection_nodes(reviews, "pull request reviews")?
        .iter()
        .filter(|review| {
            review.get("state").and_then(serde_json::Value::as_str) == Some("CHANGES_REQUESTED")
        })
        .filter_map(|review| {
            review
                .get("body")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|body| !body.is_empty())
                .map(str::to_string)
        })
        .collect();

    let threads = value.get("reviewThreads").ok_or_else(|| {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::MalformedResponse,
            "GitHub returned an incomplete pull request thread observation",
        )
    })?;
    let mut unresolved_threads = Vec::new();
    let mut has_unresolved_review_threads = false;
    for thread in complete_connection_nodes(threads, "pull request review threads")? {
        let resolved = thread
            .get("isResolved")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| {
                DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned a review thread without resolution state",
                )
            })?;
        let outdated = thread
            .get("isOutdated")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| {
                DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned a review thread without outdated state",
                )
            })?;
        let comments = thread.get("comments").ok_or_else(|| {
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned a review thread without comments",
            )
        })?;
        let comments = complete_connection_nodes(comments, "review thread comments")?;
        has_unresolved_review_threads |= !resolved;
        if resolved || outdated {
            continue;
        }
        let Some(comment) = comments.last() else {
            return Err(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                "GitHub returned an unresolved review thread without a comment",
            ));
        };
        let body = comment
            .get("body")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|body| !body.is_empty())
            .ok_or_else(|| {
                DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned an unresolved review comment without a body",
                )
            })?;
        let path = match comment.get("path") {
            Some(path) => Some(path.as_str().map(str::to_string).ok_or_else(|| {
                DeliveryObservationFailure::new(
                    DeliveryObservationFailureKind::MalformedResponse,
                    "GitHub returned an invalid review comment path",
                )
            })?),
            None => None,
        };
        let line = comment.get("line").and_then(serde_json::Value::as_u64);
        unresolved_threads.push(DeliveryFeedbackThread {
            path,
            line,
            body: body.to_string(),
        });
    }
    Ok((
        DeliveryFeedback {
            change_request_bodies,
            unresolved_threads,
        },
        has_unresolved_review_threads,
    ))
}

fn complete_connection_nodes<'a>(
    connection: &'a serde_json::Value,
    label: &str,
) -> Result<&'a Vec<serde_json::Value>, DeliveryObservationFailure> {
    let total = connection
        .get("totalCount")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                &format!("GitHub returned {label} without a total count"),
            )
        })?;
    let nodes = connection
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::MalformedResponse,
                &format!("GitHub returned {label} without nodes"),
            )
        })?;
    if total != nodes.len() as u64 {
        return Err(DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::UnsupportedResponse,
            &format!("GitHub {label} exceed the complete observation limit"),
        ));
    }
    Ok(nodes)
}

async fn github_repository_identity(
    repository_path: &Path,
    remote: &str,
) -> Result<(String, String), DeliveryObservationRead> {
    let url = command_stdout(repository_path, "git", &["remote", "get-url", remote])
        .await
        .map_err(|_| {
            DeliveryObservationRead::Terminal(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::InvalidIdentity,
                "delivery remote cannot identify its GitHub repository",
            ))
        })?;
    let repository_path = url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit_once(':')
        .map_or(url.as_str(), |(_, path)| path);
    match repository_path
        .rsplit_once('/')
        .and_then(|(owner_path, name)| owner_path.rsplit('/').next().zip(Some(name)))
    {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() => {
            Ok((owner.to_string(), name.to_string()))
        }
        _ => Err(DeliveryObservationRead::Terminal(
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::InvalidIdentity,
                "delivery remote has no GitHub owner and repository name",
            ),
        )),
    }
}

async fn observation_command_stdout(
    repository_path: &Path,
    arguments: &[&str],
) -> Result<String, DeliveryObservationRead> {
    let output = run_delivery_command(repository_path, "gh", arguments)
        .await
        .map_err(observation_command_error)?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let failure = if stderr.contains("authentication") || stderr.contains("401") {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::Authentication,
            "GitHub authentication failed while observing delivery",
        )
    } else if stderr.contains("forbidden")
        || stderr.contains("403")
        || stderr.contains("resource not accessible")
    {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::Authorization,
            "GitHub authorization failed while observing delivery",
        )
    } else {
        return Err(DeliveryObservationRead::Retryable(
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::Transport,
                "GitHub observation request failed",
            ),
        ));
    };
    Err(DeliveryObservationRead::Terminal(failure))
}

async fn optional_observation_command_stdout(
    repository_path: &Path,
    arguments: &[&str],
) -> Result<Option<String>, DeliveryObservationRead> {
    let output = run_delivery_command(repository_path, "gh", arguments)
        .await
        .map_err(observation_command_error)?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stderr.contains("http 404") && is_unprotected_branch_response(&stdout) {
        return Ok(None);
    }
    let failure = if stderr.contains("authentication") || stderr.contains("401") {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::Authentication,
            "GitHub authentication failed while observing delivery",
        )
    } else if stderr.contains("forbidden")
        || stderr.contains("403")
        || stderr.contains("resource not accessible")
        || stderr.contains("404")
    {
        DeliveryObservationFailure::new(
            DeliveryObservationFailureKind::Authorization,
            "GitHub authorization failed while observing delivery",
        )
    } else {
        return Err(DeliveryObservationRead::Retryable(
            DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::Transport,
                "GitHub observation request failed",
            ),
        ));
    };
    Err(DeliveryObservationRead::Terminal(failure))
}

fn is_unprotected_branch_response(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout)
        .ok()
        .is_some_and(|response| {
            response.get("message").and_then(serde_json::Value::as_str)
                == Some("Branch not protected")
                && response.get("status").is_some_and(|status| {
                    status.as_str() == Some("404") || status.as_u64() == Some(404)
                })
        })
}

enum DeliveryCommandError {
    TimedOut,
    Spawn(std::io::Error),
}

async fn run_delivery_command(
    repository_path: &Path,
    program: &str,
    arguments: &[&str],
) -> Result<std::process::Output, DeliveryCommandError> {
    timeout(
        DELIVERY_COMMAND_TIMEOUT,
        tokio::process::Command::new(program)
            .args(arguments)
            .current_dir(repository_path)
            .output(),
    )
    .await
    .map_err(|_| DeliveryCommandError::TimedOut)?
    .map_err(DeliveryCommandError::Spawn)
}

fn observation_command_error(error: DeliveryCommandError) -> DeliveryObservationRead {
    match error {
        DeliveryCommandError::TimedOut => {
            DeliveryObservationRead::Retryable(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::Transport,
                "GitHub observation timed out",
            ))
        }
        DeliveryCommandError::Spawn(_) => {
            DeliveryObservationRead::Retryable(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::Transport,
                "GitHub observation could not start",
            ))
        }
    }
}

async fn command_stdout(
    repository_path: &Path,
    program: &str,
    arguments: &[&str],
) -> Result<String, String> {
    let output = run_delivery_command(repository_path, program, arguments)
        .await
        .map_err(|error| match error {
            DeliveryCommandError::TimedOut => format!(
                "{program} command timed out after {}s",
                DELIVERY_COMMAND_TIMEOUT.as_secs()
            ),
            DeliveryCommandError::Spawn(error) => format!("failed to run {program}: {error}"),
        })?;
    if !output.status.success() {
        return Err(format!(
            "{program} command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn guarded_repair_push_arguments(
    remote: &str,
    head_branch: &str,
    observed_head: &str,
    local_head: &str,
) -> [String; 4] {
    let reference = format!("refs/heads/{head_branch}");
    [
        "push".to_string(),
        format!("--force-with-lease={reference}:{observed_head}"),
        remote.to_string(),
        format!("{local_head}:{reference}"),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PushReconciliation {
    Push,
    Advance,
    Blocked { error: String },
}

pub(crate) fn reconcile_push(
    repository: &DeliveryRepository,
    remote_sha: Option<String>,
) -> PushReconciliation {
    match remote_sha {
        None => PushReconciliation::Push,
        Some(remote_sha) if remote_sha == repository.local_sha => PushReconciliation::Advance,
        Some(remote_sha) => PushReconciliation::Blocked {
            error: format!(
                "remote head is {remote_sha}, expected {}",
                repository.local_sha
            ),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PullRequestReconciliation {
    Create,
    Adopted {
        number: u64,
        url: String,
    },
    Blocked {
        error: String,
    },
    Conflict {
        conflict: OwnershipConflict,
        error: String,
    },
}

pub(crate) fn reconcile_pull_requests(
    repository_key: &str,
    repository: &DeliveryRepository,
    pull_requests: &[RemotePullRequest],
    adoption_policy: Option<&PullRequestAdoptionPolicy>,
) -> PullRequestReconciliation {
    if repository.observed_remote_sha.as_deref() != Some(repository.local_sha.as_str()) {
        return PullRequestReconciliation::Blocked {
            error: "remote head was not confirmed at the intended SHA".to_string(),
        };
    }

    let same_delivery_identity = |pull_request: &&RemotePullRequest| {
        pull_request.repository_key == repository_key
            && pull_request.head_branch == repository.head_branch
            && pull_request.base_branch == repository.base_branch
    };
    let marker_matches =
        |pull_request: &&RemotePullRequest| pull_request.body.contains(repository.marker.as_str());

    let marked = pull_requests
        .iter()
        .filter(marker_matches)
        .collect::<Vec<_>>();
    if marked
        .iter()
        .any(|pull_request| !same_delivery_identity(pull_request))
    {
        return PullRequestReconciliation::Conflict {
            conflict: OwnershipConflict::Foreign,
            error: "delivery marker matched a different repository or branch identity".to_string(),
        };
    }
    match marked.as_slice() {
        [] => {}
        [pull_request] if pull_request.head_sha == repository.local_sha => {
            return PullRequestReconciliation::Adopted {
                number: pull_request.number,
                url: pull_request.url.clone(),
            };
        }
        [pull_request] => {
            return PullRequestReconciliation::Conflict {
                conflict: OwnershipConflict::Foreign,
                error: format!(
                    "pull request head is {}, expected {}",
                    pull_request.head_sha, repository.local_sha
                ),
            };
        }
        _ => {
            return PullRequestReconciliation::Conflict {
                conflict: OwnershipConflict::Ambiguous,
                error: "multiple pull requests match the delivery marker".to_string(),
            };
        }
    }

    let same_unpersisted_identity = pull_requests
        .iter()
        .filter(same_delivery_identity)
        .collect::<Vec<_>>();
    let Some(policy) = adoption_policy else {
        return if same_unpersisted_identity.is_empty() {
            PullRequestReconciliation::Create
        } else {
            PullRequestReconciliation::Conflict {
                conflict: if same_unpersisted_identity.len() == 1 {
                    OwnershipConflict::Foreign
                } else {
                    OwnershipConflict::Ambiguous
                },
                error: "pull request identity matched but its delivery marker did not".to_string(),
            }
        };
    };

    if repository.head_branch != policy.head_branch || repository.base_branch != policy.base_branch
    {
        return PullRequestReconciliation::Blocked {
            error: "delivery identity does not match the configured adoption policy".to_string(),
        };
    }

    let branch_candidates = pull_requests
        .iter()
        .filter(|pull_request| pull_request.head_branch == policy.head_branch)
        .collect::<Vec<_>>();
    if branch_candidates.is_empty() {
        return PullRequestReconciliation::Create;
    }
    let exact = branch_candidates
        .iter()
        .copied()
        .filter(|pull_request| {
            pull_request.repository_key == repository_key
                && pull_request
                    .repository
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&policy.repository))
                && pull_request
                    .head_repository
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&policy.repository))
                && pull_request.base_branch == policy.base_branch
                && pull_request.head_sha == repository.local_sha
                && (!policy.require_authenticated_author
                    || pull_request.authored_by_authenticated_viewer)
        })
        .collect::<Vec<_>>();
    match (branch_candidates.as_slice(), exact.as_slice()) {
        ([_], [pull_request]) => PullRequestReconciliation::Adopted {
            number: pull_request.number,
            url: pull_request.url.clone(),
        },
        ([candidate], []) => PullRequestReconciliation::Conflict {
            conflict: OwnershipConflict::Foreign,
            error: format!(
                "unpersisted pull request #{} by '{}' conflicts with the configured repository, author, head, base, or SHA",
                candidate.number,
                candidate.author.as_deref().unwrap_or("unknown")
            ),
        },
        _ => PullRequestReconciliation::Conflict {
            conflict: OwnershipConflict::Ambiguous,
            error: "multiple pull requests contend for the configured adoption identity".to_string(),
        },
    }
}

fn pull_request_delivery_phase(
    phase: DeliveryPhase,
) -> crate::acceptance::PullRequestDeliveryPhase {
    use crate::acceptance::PullRequestDeliveryPhase as EvidencePhase;
    match phase {
        DeliveryPhase::AwaitingApproval => EvidencePhase::Prepared,
        DeliveryPhase::Prepared => EvidencePhase::Prepared,
        DeliveryPhase::PushInFlight => EvidencePhase::PushInFlight,
        DeliveryPhase::ReconcilingPush => EvidencePhase::ReconcilingPush,
        DeliveryPhase::PrCreateInFlight => EvidencePhase::PrCreateInFlight,
        DeliveryPhase::ReconcilingPr => EvidencePhase::ReconcilingPr,
        DeliveryPhase::Waiting => EvidencePhase::Waiting,
        DeliveryPhase::Published => EvidencePhase::Published,
        DeliveryPhase::Blocked => EvidencePhase::Blocked,
    }
}

fn evaluate_pull_request_requirement(
    rule: &crate::config::ensemble::AcceptancePullRequestConfig,
    repository: &DeliveryRepository,
) -> crate::acceptance::AcceptanceResult {
    let timer = crate::acceptance::AcceptanceTimer::start();
    let mut failures = Vec::new();
    if !matches!(
        repository.phase,
        DeliveryPhase::Waiting | DeliveryPhase::Published
    ) {
        failures.push(format!(
            "delivery phase is {:?}, expected waiting or published",
            repository.phase
        ));
    }
    if repository.pr_number.is_none() {
        failures.push("durable pull request number is missing".to_string());
    }
    if repository.pr_url.is_none() {
        failures.push("durable pull request URL is missing".to_string());
    }
    let complete_identity = if failures.is_empty() {
        repository.pr_number.zip(repository.pr_url.as_deref())
    } else {
        None
    };
    let (status, summary) = if let Some((number, url)) = complete_identity {
        (
            crate::acceptance::AcceptanceStatus::Passed,
            format!(
                "required pull request '{}' has durable identity #{} at {}",
                rule.name, number, url
            ),
        )
    } else {
        (
            crate::acceptance::AcceptanceStatus::Failed,
            format!(
                "required pull request '{}' failed: {}",
                rule.name,
                failures.join(", ")
            ),
        )
    };
    timer.finish(crate::acceptance::AcceptanceResult::new(
        rule.name.clone(),
        status,
        summary,
        crate::acceptance::AcceptanceEvidence::PullRequest {
            repo: rule.repo.clone(),
            delivery_phase: pull_request_delivery_phase(repository.phase),
            base_branch: Some(repository.base_branch.clone()),
            head_branch: Some(repository.head_branch.clone()),
            head_sha: Some(repository.local_sha.clone()),
            pr_number: repository.pr_number,
            pr_url: repository.pr_url.clone(),
        },
    ))
}

impl Orchestrator {
    pub(super) async fn approve_finalize_delivery(
        &self,
        issue_id: &str,
        identifier: &str,
    ) -> Result<bool, FinalizeApprovalError> {
        let state = self.state.read().await;
        if state.pending_terminal_transitions.contains_key(issue_id) {
            return Err(FinalizeApprovalError::NotAwaitingApproval);
        }
        let current = state
            .delivery
            .get(issue_id)
            .filter(|delivery| delivery.identifier == identifier)
            .cloned()
            .ok_or(FinalizeApprovalError::NotAwaitingApproval)?;
        drop(state);
        if current.repositories.values().any(|repository| {
            repository.approval_required && repository.phase == DeliveryPhase::Blocked
        }) {
            return Err(FinalizeApprovalError::NotAwaitingApproval);
        }
        let mut candidate = current.clone();
        let mut approval_required = false;
        let mut changed = false;
        for repository in candidate.repositories.values_mut() {
            if !repository.approval_required {
                continue;
            }
            approval_required = true;
            if repository.phase == DeliveryPhase::AwaitingApproval {
                let retry_from = repository.retry_from.unwrap_or(DeliveryPhase::Prepared);
                repository.phase = retry_from;
                if retry_from != DeliveryPhase::Waiting {
                    repository.retry_from = None;
                }
                repository.ownership_conflict = None;
                repository.last_error = None;
                changed = true;
            }
        }
        if !approval_required {
            return Err(FinalizeApprovalError::NotAwaitingApproval);
        }
        let authoritative = if changed {
            self.persist_delivery_record(&candidate, None)
                .await
                .map_err(FinalizeApprovalError::Persistence)?;
            candidate
        } else {
            current
        };
        self.project_delivery_artifacts(issue_id, &authoritative)
            .await;
        self.state
            .write()
            .await
            .set_finalize_state(issue_id, Self::finalize_state_from_delivery(&authoritative));
        Ok(changed)
    }

    pub(super) async fn retry_finalize_delivery(
        &self,
        issue_id: &str,
        identifier: &str,
    ) -> Result<(), FinalizeRetryError> {
        let current = {
            let state = self.state.read().await;
            if state.pending_terminal_transitions.contains_key(issue_id) {
                return Err(FinalizeRetryError::NotFailed);
            }
            state
                .delivery
                .get(issue_id)
                .filter(|delivery| delivery.identifier == identifier)
                .cloned()
        };
        let Some(current) = current else {
            let mut state = self.state.write().await;
            let finalize = state
                .get_finalize_state_mut(issue_id)
                .ok_or(FinalizeRetryError::NotFailed)?;
            let mut changed = false;
            for repository in &mut finalize.repos {
                if repository.status == FinalizeStatus::Failed {
                    repository.last_error = None;
                    repository.status = FinalizeStatus::InProgress;
                    changed = true;
                }
            }
            if !changed {
                return Err(FinalizeRetryError::NotFailed);
            }
            finalize.status = FinalizeStatus::InProgress;
            return Ok(());
        };

        let mut candidate = current;
        let mut changed = false;
        if candidate.closed_without_merge_parked {
            // An operator retry does not replay publication. It only discards the retained
            // closed observation and projection so recovery must obtain fresh PR evidence.
            candidate.review_projection = None;
            candidate.selected_delivery_state = None;
            for repository in candidate.repositories.values_mut() {
                if repository.mode == DeliveryMode::PushAndPr
                    && repository.phase == DeliveryPhase::Waiting
                {
                    repository.observation = None;
                }
            }
            changed = true;
        }
        for repository in candidate.repositories.values_mut() {
            if repository.phase != DeliveryPhase::Blocked {
                continue;
            }
            if repository
                .merge_mutation
                .as_ref()
                .is_some_and(|mutation| mutation.phase == DeliveryMergePhase::Blocked)
            {
                repository.merge_mutation = None;
            }
            if repository.approval_required {
                repository.phase = DeliveryPhase::AwaitingApproval;
            } else {
                let retry_from = repository.retry_from.unwrap_or(DeliveryPhase::Prepared);
                repository.phase = retry_from;
                if retry_from != DeliveryPhase::Waiting {
                    repository.retry_from = None;
                }
            }
            repository.ownership_conflict = None;
            repository.last_error = None;
            changed = true;
        }
        if let Some(projection) = candidate
            .review_projection
            .as_mut()
            .filter(|projection| projection.phase == ReviewProjectionPhase::Blocked)
        {
            projection.phase = ReviewProjectionPhase::Pending;
            projection.diagnostic = None;
            changed = true;
        }
        if !changed {
            return Err(FinalizeRetryError::NotFailed);
        }
        self.persist_delivery_record(&candidate, None)
            .await
            .map_err(FinalizeRetryError::Persistence)?;
        self.project_delivery_artifacts(issue_id, &candidate).await;
        self.state
            .write()
            .await
            .set_finalize_state(issue_id, Self::finalize_state_from_delivery(&candidate));
        Ok(())
    }

    pub(super) async fn reconcile_and_recover_deliveries(&self) {
        let recoverable_issue_ids = self.reconcile_terminal_delivery_owners().await;
        if recoverable_issue_ids.is_empty() {
            return;
        }

        // Remote delivery recovery is another large state machine. Poll it only after terminal
        // ownership reconciliation has finished and released its future.
        Box::pin(self.process_delivery_recovery(Some(&recoverable_issue_ids))).await;
    }

    pub(super) async fn load_delivery_snapshot(
        &self,
        delivery: &DeliveryRecord,
    ) -> Result<Option<PipelineRunSnapshot>, String> {
        let record = self
            .pipeline_journal
            .latest_live_record_for_issue(&delivery.issue_id)
            .await
            .map_err(|error| format!("failed to read durable delivery owner: {error}"))?
            .ok_or_else(|| {
                format!(
                    "missing durable delivery owner for issue '{}'",
                    delivery.issue_id
                )
            })?;
        if record.run_id.as_deref() != Some(delivery.run_id.as_str()) {
            return Err(format!(
                "durable delivery owner for issue '{}' belongs to a different run",
                delivery.issue_id
            ));
        }
        Ok(record.snapshot)
    }

    pub(super) async fn reconcile_terminal_delivery_owners(&self) -> BTreeSet<String> {
        let deliveries = {
            let state = self.state.read().await;
            state
                .delivery
                .values()
                .filter(|delivery| {
                    !state
                        .pending_terminal_transitions
                        .contains_key(&delivery.issue_id)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        if deliveries.is_empty() {
            return BTreeSet::new();
        }

        let issue_ids = deliveries
            .iter()
            .map(|delivery| delivery.issue_id.clone())
            .collect::<Vec<_>>();
        let observed_issues = match self.tracker.fetch_issue_states_by_ids(&issue_ids).await {
            Ok(issues) => issues,
            Err(error) => {
                warn!(
                    error = %error,
                    "delivery recovery could not refresh tracker ownership"
                );
                let mut observed = Vec::new();
                if issue_ids.len() > 1 {
                    for issue_id in &issue_ids {
                        match self
                            .tracker
                            .fetch_issue_states_by_ids(std::slice::from_ref(issue_id))
                            .await
                        {
                            Ok(issues) => observed.extend(issues),
                            Err(error) => warn!(
                                issue_id = %issue_id,
                                error = %error,
                                "delivery recovery could not refresh one tracker owner"
                            ),
                        }
                    }
                }
                observed
            }
        }
        .into_iter()
        .map(|issue| (issue.id.clone(), issue))
        .collect::<BTreeMap<_, _>>();
        let terminal_states = {
            let config = self.config.read().await;
            config
                .tracker
                .terminal_states
                .iter()
                .map(|state| state.to_lowercase())
                .collect::<Vec<_>>()
        };

        let mut recoverable_issue_ids = BTreeSet::new();
        for delivery in deliveries {
            let Some(issue) = observed_issues.get(&delivery.issue_id) else {
                warn!(
                    issue_id = %delivery.issue_id,
                    "delivery recovery did not observe its tracker issue"
                );
                continue;
            };
            if terminal_states.contains(&issue.state.to_lowercase()) {
                let snapshot = match self.load_delivery_snapshot(&delivery).await {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        warn!(
                            issue_id = %delivery.issue_id,
                            error = %error,
                            "terminal delivery reconciliation could not load its durable snapshot"
                        );
                        continue;
                    }
                };
                let legacy_pipeline_config = if delivery.success_state.is_none()
                    || delivery.failure_state.is_none()
                {
                    match self.current_config_for_snapshot(snapshot.as_ref()).await {
                        Ok(config) => Some(config),
                        Err(error) => {
                            warn!(
                                issue_id = %delivery.issue_id,
                                error = %error,
                                "terminal delivery reconciliation could not resolve its legacy selected workflow"
                            );
                            continue;
                        }
                    }
                } else {
                    None
                };
                let legacy_success_state = legacy_pipeline_config
                    .as_ref()
                    .map(|config| config.on_success.as_str());
                let legacy_failure_state = legacy_pipeline_config
                    .as_ref()
                    .map(|config| config.on_failure.as_str());
                let (outcome, history_outcome) = terminal_delivery_outcome(
                    &delivery,
                    &issue.state,
                    legacy_success_state,
                    legacy_failure_state,
                );
                self.reconcile_terminal_delivery_owner(&delivery, issue, outcome, history_outcome)
                    .await;
            } else {
                recoverable_issue_ids.insert(delivery.issue_id);
            }
        }
        recoverable_issue_ids
    }

    fn reconcile_terminal_delivery_owner<'a>(
        &'a self,
        delivery: &'a DeliveryRecord,
        issue: &'a crate::tracker::model::Issue,
        outcome: TerminalOutcome,
        history_outcome: &'static str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Some(history_record) = self
                .projected_terminal_history(delivery, history_outcome)
                .await
            else {
                warn!(
                    issue_id = %delivery.issue_id,
                    "terminal delivery has no durable completion history"
                );
                return;
            };
            self.begin_confirmed_terminal_transition_for_identity(
                &delivery.issue_id,
                &delivery.identifier,
                Some(issue.clone()),
                outcome,
                issue.state.clone(),
                Some(history_record),
            )
            .await;
        })
    }

    pub(super) async fn projected_terminal_history(
        &self,
        delivery: &DeliveryRecord,
        outcome: &'static str,
    ) -> Option<HistoryRecord> {
        let mut record = delivery.terminal_history.as_deref().cloned().or_else(|| {
            delivery
                .review_projection
                .as_ref()
                .and_then(|projection| projection.history_record.clone())
        })?;
        let mut artifacts = self
            .state
            .read()
            .await
            .artifacts
            .get(&delivery.issue_id)
            .cloned()
            .or_else(|| record.artifacts.clone());
        if let Some(artifacts) = artifacts.as_mut() {
            Self::apply_delivery_artifacts(artifacts, delivery);
        }
        record.outcome = outcome.to_string();
        record.completed_at = Utc::now();
        record.duration_seconds = record
            .completed_at
            .signed_duration_since(record.started_at)
            .num_seconds()
            .max(0) as u64;
        if let Some(diagnostic) = delivery
            .repositories
            .values()
            .filter(|repository| repository.phase == DeliveryPhase::Blocked)
            .find_map(|repository| repository.last_error.clone())
            .or_else(|| {
                delivery
                    .review_projection
                    .as_ref()
                    .filter(|projection| projection.phase == ReviewProjectionPhase::Blocked)
                    .and_then(|projection| projection.diagnostic.clone())
            })
        {
            record.last_error = Some(diagnostic);
        }
        record.artifacts = artifacts;
        Some(record)
    }

    pub(super) async fn process_delivery_recovery(
        &self,
        observed_issue_ids: Option<&BTreeSet<String>>,
    ) {
        let deliveries = {
            let state = self.state.read().await;
            state
                .delivery
                .values()
                .filter(|delivery| {
                    observed_issue_ids
                        .is_none_or(|issue_ids| issue_ids.contains(&delivery.issue_id))
                        && matches!(
                            delivery.aggregate(),
                            DeliveryAggregate::Active
                                | DeliveryAggregate::Waiting
                                | DeliveryAggregate::Published
                        )
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        for delivery in deliveries {
            if delivery.is_parked_for_approval() {
                continue;
            }
            let snapshot = match self.load_delivery_snapshot(&delivery).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    warn!(
                        issue_id = %delivery.issue_id,
                        error = %error,
                        "delivery recovery could not load its durable snapshot"
                    );
                    continue;
                }
            };
            let delivery = self
                .evaluate_post_final_acceptance(delivery, snapshot.as_ref())
                .await;
            // Records created before delivery-state projection retain the original projection
            // without a selected fact. Reconcile that durable in-flight write before reading
            // newer delivery facts, so an upgrade cannot abandon an ambiguous tracker mutation.
            let delivery = if delivery.selected_delivery_state.is_none()
                && delivery.review_projection.is_some()
            {
                self.advance_review_projection(delivery).await
            } else {
                delivery
            };
            if delivery.aggregate() == DeliveryAggregate::Published {
                self.complete_published_delivery(&delivery, snapshot.as_ref())
                    .await;
                continue;
            }
            let delivery = self
                .reconcile_delivery_observations(delivery, snapshot.as_ref())
                .await;
            let delivery = self
                .persist_repair_dispatch_intent(delivery, snapshot.as_ref())
                .await;
            self.reconcile_delivery_repair_dispatch(&delivery).await;
            self.dispatch_delivery_repair_if_authorized(&delivery).await;
            self.ensure_delivery_repair_interaction(&delivery).await;
            self.reconcile_delivery_repair_push(&delivery).await;
            self.advance_delivery_repair_push(&delivery).await;
            let delivery = self
                .advance_delivery_merge(delivery, snapshot.as_ref())
                .await;
            let fact = delivery.delivery_state_fact();
            let delivery = if fact != Some(DeliveryStateFact::ClosedWithoutMerge)
                && delivery.has_fresh_nonclosed_delivery_evidence()
            {
                self.clear_closed_without_merge_park(delivery).await
            } else {
                delivery
            };
            if fact == Some(DeliveryStateFact::Merged)
                && delivery.delivery_states.merged.as_deref() == Some("on_success")
            {
                if delivery.has_in_flight_review_projection() {
                    // A previously persisted intermediate write remains ambiguous until its
                    // exact target has been reconciled. Never begin terminal cleanup first.
                    self.advance_review_projection(delivery).await;
                    continue;
                }
                let Some(target_state) = delivery.success_state.clone() else {
                    warn!(issue_id = %delivery.issue_id, "merged delivery has no frozen success target");
                    continue;
                };
                let selection = DeliveryStateProjection {
                    schema_version: 1,
                    fact: DeliveryStateFact::Merged,
                    target: target_state.clone(),
                };
                let delivery = if delivery.selected_delivery_state.as_ref() != Some(&selection) {
                    let mut updated = delivery;
                    updated.selected_delivery_state = Some(selection);
                    if self.persist_delivery_record(&updated, None).await.is_err() {
                        continue;
                    }
                    updated
                } else {
                    delivery
                };
                let Some(history) = self
                    .projected_terminal_history(&delivery, HISTORY_OUTCOME_SUCCEEDED)
                    .await
                else {
                    warn!(
                        issue_id = %delivery.issue_id,
                        "merged delivery has no durable completion history"
                    );
                    continue;
                };
                self.begin_terminal_transition_for_identity(
                    &delivery.issue_id,
                    &delivery.identifier,
                    None,
                    TerminalOutcome::Succeeded,
                    target_state,
                    Some(history),
                )
                .await;
                continue;
            }
            if fact == Some(DeliveryStateFact::ClosedWithoutMerge) {
                let delivery = self.park_closed_without_merge(delivery).await;
                let delivery = self.advance_delivery_state_projection(delivery).await;
                self.project_delivery_artifacts(&delivery.issue_id, &delivery)
                    .await;
                let finalize = Self::finalize_state_from_delivery(&delivery);
                self.state
                    .write()
                    .await
                    .set_finalize_state(&delivery.issue_id, finalize);
                continue;
            }
            let delivery = self.advance_delivery_state_projection(delivery).await;
            if matches!(
                delivery.aggregate(),
                DeliveryAggregate::Waiting | DeliveryAggregate::Blocked
            ) {
                self.project_delivery_artifacts(&delivery.issue_id, &delivery)
                    .await;
                let finalize = Self::finalize_state_from_delivery(&delivery);
                self.state
                    .write()
                    .await
                    .set_finalize_state(&delivery.issue_id, finalize);
                continue;
            }
            let workspace = match self
                .workspace_mgr
                .prepare_workspace(&delivery.issue_id, &delivery.identifier)
                .await
            {
                Ok(workspace) => workspace,
                Err(error) => {
                    let mut blocked = delivery.clone();
                    for repository in blocked.repositories.values_mut().filter(|repository| {
                        !matches!(
                            repository.phase,
                            DeliveryPhase::Waiting
                                | DeliveryPhase::Published
                                | DeliveryPhase::Blocked
                        )
                    }) {
                        repository.retry_from = Some(repository.phase);
                        repository.phase = DeliveryPhase::Blocked;
                        repository.last_error = Some(error.to_string());
                    }
                    let _ = self.persist_delivery_record(&blocked, None).await;
                    continue;
                }
            };
            let delivery = self
                .advance_delivery_record(delivery, &workspace, snapshot.as_ref())
                .await;
            self.project_delivery_artifacts(&delivery.issue_id, &delivery)
                .await;
            if delivery.aggregate() == DeliveryAggregate::Published {
                self.complete_published_delivery(&delivery, snapshot.as_ref())
                    .await;
                continue;
            }
            let finalize = Self::finalize_state_from_delivery(&delivery);
            self.state
                .write()
                .await
                .set_finalize_state(&delivery.issue_id, finalize);
        }
    }

    pub(super) async fn reconcile_delivery_observations(
        &self,
        delivery: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        if !self.delivery_remote.supports_delivery_observation() {
            return delivery;
        }
        let eligible = delivery.repositories.iter().any(|(_, repository)| {
            repository.mode == DeliveryMode::PushAndPr
                && repository.phase == DeliveryPhase::Waiting
                && repository.pr_number.is_some()
                && repository.pr_url.is_some()
                && repository
                    .observation
                    .as_ref()
                    .is_none_or(|observation| observation.is_due(Utc::now()))
        });
        if !eligible {
            return delivery;
        }
        let worktrees = match self.workspace_mgr.owned_worktree_paths(&delivery.issue_id) {
            Ok(worktrees) => worktrees,
            Err(error) => {
                warn!(issue_id = %delivery.issue_id, error = %error, "delivery observation could not resolve its owned worktrees");
                return delivery;
            }
        };

        let original = delivery.clone();
        let mut current = delivery;
        let mut updated_at = None;
        for (repository_key, repository) in current.repositories.clone() {
            let Some(pull_request_number) = repository.pr_number else {
                continue;
            };
            let Some(pull_request_url) = repository.pr_url.as_deref() else {
                continue;
            };
            if repository.mode != DeliveryMode::PushAndPr
                || repository.phase != DeliveryPhase::Waiting
                || repository
                    .observation
                    .as_ref()
                    .is_some_and(|observation| !observation.is_due(Utc::now()))
            {
                continue;
            }
            let Some(worktree) = worktrees.get(&repository_key) else {
                continue;
            };
            if !worktree.is_dir() {
                continue;
            };
            let now = Utc::now();
            let read = self
                .delivery_remote
                .observe_pull_request(PullRequestObservationRequest {
                    repository_path: worktree,
                    pull_request_number,
                    pull_request_url,
                    base_branch: &repository.base_branch,
                    head_branch: &repository.head_branch,
                    remote: &repository.remote,
                    collect_automatic_merge_policy: repository.merge.is_automatic()
                        && repository.merge_mutation.is_none(),
                    direct_merge_method: match &repository.merge {
                        DeliveryMergeConfig::Auto { method } => Some(*method),
                        DeliveryMergeConfig::Manual | DeliveryMergeConfig::MergeQueue => None,
                    },
                })
                .await;
            // A guarded repair push is reconciling one newer, already-durable local
            // head. Validate that exact head rather than marking the expected repair
            // publication as divergence from the pre-repair delivery SHA.
            let expected_delivery_sha = current
                .repair
                .as_ref()
                .filter(|repair| {
                    repair.phase == DeliveryRepairPhase::ReconcilingPush
                        && repair.attempt.repository_key == repository_key
                })
                .and_then(|repair| repair.post_worker_local_head.as_deref())
                .unwrap_or(&repository.local_sha);
            let has_repair_policy = current.delivery_repair.is_some();
            // The mutable repository update below must not borrow `current` through the repair
            // policy at the same time. Suppressions are a durable, small identity set.
            let repair_suppressions = current.delivery_repair_suppressions.clone();
            let mut repair_facts = None;
            let mut permits_suppressed_head_successor = false;
            let updated = current
                .repositories
                .get_mut(&repository_key)
                .expect("repository was cloned from the delivery record");
            match read {
                DeliveryObservationRead::Observed(facts) => {
                    let observation = match facts
                        .validate_identity(pull_request_number, pull_request_url)
                    {
                        Ok(()) => {
                            permits_suppressed_head_successor =
                                DeliveryRecord::allows_suppressed_head_successor(
                                    has_repair_policy,
                                    &repair_suppressions,
                                    &repository_key,
                                    &repository.local_sha,
                                    &facts,
                                );
                            let successor_repair_facts = permits_suppressed_head_successor
                                .then(|| facts.clone().for_delivery(&facts.head_sha));
                            let facts = facts.for_delivery(expected_delivery_sha);
                            repair_facts = successor_repair_facts.or_else(|| Some(facts.clone()));
                            DeliveryObservation::successful(facts, now)
                        }
                        Err(failure) => {
                            updated.phase = DeliveryPhase::Blocked;
                            updated.retry_from = Some(DeliveryPhase::Waiting);
                            updated.last_error = Some(failure.message.clone());
                            DeliveryObservation::failed(
                                updated.observation.as_ref(),
                                failure,
                                None,
                                now,
                            )
                        }
                    };
                    if observation
                        .facts
                        .as_ref()
                        .is_some_and(|facts| facts.head_diverged)
                        && !permits_suppressed_head_successor
                    {
                        updated.phase = DeliveryPhase::Blocked;
                        updated.retry_from = Some(DeliveryPhase::Waiting);
                        updated.last_error = Some(
                            "pull request head diverged from the durable delivery SHA".to_string(),
                        );
                    }
                    updated.observation = Some(observation);
                }
                DeliveryObservationRead::Retryable(failure) => {
                    let attempt = updated
                        .observation
                        .as_ref()
                        .and_then(|observation| observation.retry.as_ref())
                        .map_or(1, |retry| retry.attempt.saturating_add(1));
                    let delay = calculate_backoff(attempt, 300_000);
                    let retry = DeliveryObservationRetry {
                        attempt,
                        due_at: now
                            + chrono::Duration::milliseconds(
                                i64::try_from(delay).unwrap_or(i64::MAX),
                            ),
                    };
                    updated.observation = Some(DeliveryObservation::failed(
                        updated.observation.as_ref(),
                        failure,
                        Some(retry),
                        now,
                    ));
                }
                DeliveryObservationRead::Terminal(failure) => {
                    updated.phase = DeliveryPhase::Blocked;
                    updated.retry_from = Some(DeliveryPhase::Waiting);
                    updated.last_error = Some(failure.message.clone());
                    updated.observation = Some(DeliveryObservation::failed(
                        updated.observation.as_ref(),
                        failure,
                        None,
                        now,
                    ));
                }
            }
            if let Some(facts) = repair_facts {
                current.freeze_actionable_repair(&repository_key, &facts);
            }
            updated_at = Some(now);
        }
        if current == original {
            return original;
        }
        let Ok(current) = self
            .persist_delivery_candidate(&original, current, snapshot)
            .await
        else {
            return original;
        };
        self.project_delivery_artifacts(&current.issue_id, &current)
            .await;
        let observations = current
            .repositories
            .iter()
            .filter_map(|(key, repository)| {
                repository
                    .observation
                    .clone()
                    .map(|observation| (key.clone(), observation))
            })
            .collect();
        let (run_id, sequence, attempt) = {
            let mut state = self.state.write().await;
            Self::run_context_for_issue(&mut state, &current.issue_id)
        };
        self.publish_pipeline_event(
            run_id,
            sequence,
            attempt,
            PipelineEvent::DeliveryObservationUpdated {
                issue_identifier: current.identifier.clone(),
                timestamp: updated_at.expect("a changed observation has an attempt timestamp"),
                observations,
            },
        )
        .await;
        current
    }

    pub(super) async fn advance_delivery_merge(
        &self,
        delivery: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        if delivery.repair.is_some() {
            return delivery;
        }
        let Some(repository_key) = automatic_merge_candidate_key(&delivery.repositories) else {
            return delivery;
        };

        let _mutation_guard = self.delivery_merge_mutation_lock.lock().await;
        let current = self
            .state
            .read()
            .await
            .delivery
            .get(&delivery.issue_id)
            .cloned()
            .unwrap_or(delivery);
        if current.repair.is_some() {
            return current;
        }
        let Some(repository) = current.repositories.get(&repository_key).cloned() else {
            return current;
        };
        if repository.phase != DeliveryPhase::Waiting || !repository.merge.is_automatic() {
            return current;
        }
        let Some(pull_request_number) = repository.pr_number else {
            return current;
        };
        let Some(pull_request_url) = repository.pr_url.as_deref() else {
            return current;
        };
        let worktrees = match self.workspace_mgr.owned_worktree_paths(&current.issue_id) {
            Ok(worktrees) => worktrees,
            Err(_) => return current,
        };
        let Some(worktree) = worktrees.get(&repository_key).filter(|path| path.is_dir()) else {
            return current;
        };
        let read = self
            .delivery_remote
            .observe_pull_request(PullRequestObservationRequest {
                repository_path: worktree,
                pull_request_number,
                pull_request_url,
                base_branch: &repository.base_branch,
                head_branch: &repository.head_branch,
                remote: &repository.remote,
                collect_automatic_merge_policy: repository.merge_mutation.is_none(),
                direct_merge_method: match &repository.merge {
                    DeliveryMergeConfig::Auto { method } => Some(*method),
                    DeliveryMergeConfig::Manual | DeliveryMergeConfig::MergeQueue => None,
                },
            })
            .await;
        let DeliveryObservationRead::Observed(facts) = read else {
            return current;
        };
        if facts
            .validate_identity(pull_request_number, pull_request_url)
            .is_err()
        {
            return current;
        }
        let facts = facts.for_delivery(&repository.local_sha);
        let mut observed = current.clone();
        observed
            .repositories
            .get_mut(&repository_key)
            .expect("repository key was selected from this delivery")
            .observation = Some(DeliveryObservation::successful(facts.clone(), Utc::now()));
        let Ok(mut observed) = self
            .persist_delivery_candidate(&current, observed, snapshot)
            .await
        else {
            return current;
        };

        if facts.terminal_state == PullRequestTerminalState::Merged {
            observed
                .repositories
                .get_mut(&repository_key)
                .expect("repository key was selected from this delivery")
                .merge_mutation = None;
            return self
                .persist_delivery_candidate(&current, observed.clone(), snapshot)
                .await
                .unwrap_or(observed);
        }

        if let Some(mutation) = repository.merge_mutation {
            let updated = observed
                .repositories
                .get_mut(&repository_key)
                .expect("repository key was selected from this delivery");
            let same_head = facts.matches_delivery && !facts.head_diverged;
            let queued = facts.in_merge_queue;
            let (phase, diagnostic) = match mutation.operation {
                DeliveryMergeOperation::Queue if same_head && queued => {
                    (DeliveryMergePhase::Queued, None)
                }
                _ => (
                    DeliveryMergePhase::Blocked,
                    Some(
                        "automatic delivery mutation was not confirmed by authoritative observation"
                            .to_string(),
                    ),
                ),
            };
            updated.merge_mutation = Some(DeliveryMergeMutation {
                phase,
                last_error: diagnostic.clone(),
                ..mutation
            });
            if phase == DeliveryMergePhase::Blocked {
                updated.phase = DeliveryPhase::Blocked;
                updated.retry_from = Some(DeliveryPhase::Waiting);
                updated.last_error = diagnostic;
            }
            return self
                .persist_delivery_candidate(&current, observed.clone(), snapshot)
                .await
                .unwrap_or(observed);
        }

        let Some(evidence) = facts.automatic_merge_evidence() else {
            return observed;
        };
        let Some(pull_request_node_id) = facts.pull_request_node_id.clone() else {
            return observed;
        };
        let operation = match repository.merge {
            DeliveryMergeConfig::Manual => return observed,
            DeliveryMergeConfig::Auto { method } if evidence.is_eligible_for_direct_merge() => {
                DeliveryMergeOperation::Direct { method }
            }
            DeliveryMergeConfig::MergeQueue if evidence.is_eligible_for_queue() => {
                DeliveryMergeOperation::Queue
            }
            _ => return observed,
        };
        let intent = DeliveryMergeMutation {
            operation: operation.clone(),
            pull_request_node_id: pull_request_node_id.clone(),
            expected_head_sha: facts.head_sha.clone(),
            phase: DeliveryMergePhase::InFlight,
            last_error: None,
        };
        let before_intent = observed.clone();
        observed
            .repositories
            .get_mut(&repository_key)
            .expect("repository key was selected from this delivery")
            .merge_mutation = Some(intent);
        let Ok(mut in_flight) = self
            .persist_delivery_candidate(&before_intent, observed, snapshot)
            .await
        else {
            return before_intent;
        };
        let outcome = match operation {
            DeliveryMergeOperation::Direct { method } => {
                self.delivery_remote
                    .merge_pull_request(worktree, &pull_request_node_id, &facts.head_sha, method)
                    .await
            }
            DeliveryMergeOperation::Queue => {
                self.delivery_remote
                    .enqueue_pull_request(worktree, &pull_request_node_id, &facts.head_sha)
                    .await
            }
        };
        let repository = in_flight
            .repositories
            .get_mut(&repository_key)
            .expect("repository key was selected from this delivery");
        let mutation = repository
            .merge_mutation
            .as_mut()
            .expect("persisted automatic merge intent");
        match outcome {
            DeliveryMergeRemoteOutcome::Submitted => {
                mutation.phase = DeliveryMergePhase::Reconciling;
                mutation.last_error = None;
            }
            DeliveryMergeRemoteOutcome::Rejected(error) => {
                mutation.phase = DeliveryMergePhase::Blocked;
                mutation.last_error = Some(error.clone());
                repository.phase = DeliveryPhase::Blocked;
                repository.retry_from = Some(DeliveryPhase::Waiting);
                repository.last_error = Some(error);
            }
            DeliveryMergeRemoteOutcome::Ambiguous(error) => {
                mutation.phase = DeliveryMergePhase::Reconciling;
                mutation.last_error = Some(error);
            }
        }
        self.persist_delivery_candidate(&before_intent, in_flight.clone(), snapshot)
            .await
            .unwrap_or(in_flight)
    }

    /// Makes a repair launch durable before the recovery loop is allowed to reserve a worker or
    /// invoke an agent. On restart, `dispatch_in_flight` is retained and therefore cannot create a
    /// second launch merely because the process stopped between those effects.
    async fn persist_repair_dispatch_intent(
        &self,
        delivery: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        if delivery.repositories.values().any(|repository| {
            repository
                .merge_mutation
                .as_ref()
                .is_some_and(|mutation| mutation.phase != DeliveryMergePhase::Blocked)
        }) {
            return delivery;
        }
        let mut candidate = delivery.clone();
        match candidate.begin_repair_dispatch() {
            RepairDispatch::Dispatch => match self
                .persist_delivery_candidate(&delivery, candidate, snapshot)
                .await
            {
                Ok(persisted) => {
                    self.pending_delivery_repair_dispatches
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(persisted.issue_id.clone());
                    persisted
                }
                Err(_) => delivery,
            },
            RepairDispatch::Exhausted => self
                .persist_delivery_candidate(&delivery, candidate, snapshot)
                .await
                .unwrap_or(delivery),
            RepairDispatch::AlreadyInFlight | RepairDispatch::NotPending => delivery,
        }
    }

    /// A launch grant exists only in this process after its dispatch intent is journaled. A
    /// restored intent is deliberately converted into operator-owned recovery instead of being
    /// able to launch a second ambiguous ACP session.
    pub(super) async fn reconcile_delivery_repair_dispatch(&self, delivery: &DeliveryRecord) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        if repair.phase != DeliveryRepairPhase::DispatchInFlight
            || self
                .pending_delivery_repair_dispatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(&delivery.issue_id)
        {
            return;
        }
        let mut awaiting_human = delivery.clone();
        awaiting_human.repair.as_mut().expect("checked").phase = DeliveryRepairPhase::AwaitingHuman;
        if let Ok(persisted) = self
            .persist_delivery_candidate(delivery, awaiting_human, None)
            .await
        {
            self.ensure_delivery_repair_interaction(&persisted).await;
        }
    }

    /// Dispatches only an intent made durable by this runtime. A restored
    /// `dispatch_in_flight` record has no proof whether an earlier process got
    /// as far as starting the session, so it is deliberately not relaunched.
    pub(super) async fn dispatch_delivery_repair_if_authorized(&self, delivery: &DeliveryRecord) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        if repair.phase != DeliveryRepairPhase::DispatchInFlight
            || !self
                .pending_delivery_repair_dispatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(&delivery.issue_id)
        {
            return;
        }
        let Some(workspace_path) = self
            .workspace_mgr
            .owned_worktree_paths(&delivery.issue_id)
            .ok()
            .and_then(|paths| {
                paths
                    .get(&repair.attempt.repository_key)
                    .filter(|path| path.is_dir())
                    .cloned()
            })
        else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the retained delivery worktree is unavailable; inspect or restore it before retrying delivery repair".to_string(),
                ),
            )
            .await;
            return;
        };
        let frozen_config = {
            let state = self.state.read().await;
            state.get_pipeline_config(&delivery.issue_id).cloned()
        };
        let config = match frozen_config {
            Some(config) => config,
            None => Arc::new(self.config.read().await.clone()),
        };
        let live_config = self.config.read().await.clone();
        let capacity = match delivery.delivery_repair_capacity.as_ref() {
            Some(DeliveryRepairCapacity::Lane { lane }) => {
                let Some(capacity) = live_config
                    .scheduler
                    .lanes
                    .get(lane.as_str())
                    .map(|lane| lane.capacity)
                else {
                    self.await_delivery_repair_operator(delivery).await;
                    return;
                };
                WorkerCapacity::lane(lane.as_str(), capacity)
            }
            Some(DeliveryRepairCapacity::State { state }) => {
                WorkerCapacity::new(state.as_str(), &config.agent.max_concurrent_agents_by_state)
            }
            None => {
                self.await_delivery_repair_operator(delivery).await;
                return;
            }
        };
        let issue = Issue {
            id: delivery.issue_id.clone(),
            identifier: delivery.identifier.clone(),
            title: format!("Delivery repair for {}", delivery.identifier),
            description: None,
            priority: None,
            tracker_position: None,
            state: "Delivery".to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        };
        let identity = WorkerIdentity {
            issue_id: delivery.issue_id.clone(),
            run_id: delivery.run_id.clone(),
            cycle: 0,
            step_name: "delivery_repair".to_string(),
            started_at: Utc::now(),
        };
        let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);
        let resource_capacities = config
            .scheduler
            .resources
            .iter()
            .map(|(name, resource)| (name.clone(), resource.capacity))
            .collect();
        let cancel_token = tokio_util::sync::CancellationToken::new();
        match try_reserve_scheduler_worker_with_workspace_exclusivity(
            &self.cancellation_registry,
            identity.clone(),
            cancel_token.clone(),
            completion_rx,
            config.concurrency.max_concurrent_agents,
            config.concurrency.max_step_parallelism,
            capacity,
            &resource_capacities,
            Default::default(),
            true,
        ) {
            Ok(()) => {}
            Err(
                WorkerReservationError::GlobalCapacityExhausted
                | WorkerReservationError::IssueCapacityExhausted
                | WorkerReservationError::CapacityBucketExhausted
                | WorkerReservationError::ResourceExhausted
                | WorkerReservationError::PathConflict
                | WorkerReservationError::IssueWorkspaceExclusive,
            ) => return,
            Err(WorkerReservationError::DuplicateIdentity) => return,
        }
        if !self
            .pending_delivery_repair_dispatches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&delivery.issue_id)
        {
            crate::agent::cancellation::rollback_worker_reservation(
                &self.cancellation_registry,
                &identity,
            );
            return;
        }
        let completion_tx = match crate::agent::cancellation::mark_worker_launched(
            &self.cancellation_registry,
            &identity,
        ) {
            true => completion_tx,
            false => {
                crate::agent::cancellation::rollback_worker_reservation(
                    &self.cancellation_registry,
                    &identity,
                );
                return;
            }
        };
        let prompt = DeliveryRepairPromptContext {
            pull_request_number: repair.attempt.pull_request_number,
            pull_request_url: repair.attempt.pull_request_url.clone(),
            starting_sha: repair.attempt.starting_sha.clone(),
            terminal_failed_checks: repair.attempt.feedback.terminal_failed_checks.clone(),
            change_request_bodies: repair.attempt.feedback.change_request_bodies.clone(),
            unresolved_threads: repair
                .attempt
                .feedback
                .unresolved_threads
                .iter()
                .map(|thread| DeliveryRepairThread {
                    path: thread.path.clone(),
                    line: thread.line,
                    body: thread.body.clone(),
                })
                .collect(),
        };
        let timeout_ms = config.agent.turn_timeout_ms;
        let local = super::spawn_delivery_repair_worker(
            Arc::clone(&self.agent_runner),
            config,
            issue,
            delivery
                .delivery_repair
                .as_ref()
                .expect("repair state requires a frozen policy")
                .agent
                .clone(),
            prompt,
            repair.attempts_used,
            timeout_ms,
            workspace_path,
            cancel_token,
        );
        tokio::spawn(super::bridge_worker_events(
            local,
            self.worker_tx.clone(),
            self.cancellation_registry.clone(),
            identity,
            completion_tx,
        ));
    }

    pub(super) async fn handle_delivery_repair_exit(
        &self,
        identity: WorkerIdentity,
        result: WorkerResult,
    ) {
        let current = {
            let state = self.state.read().await;
            state.delivery.get(&identity.issue_id).cloned()
        };
        let Some(current) = current else {
            return;
        };
        if current
            .repair
            .as_ref()
            .is_none_or(|repair| repair.phase != DeliveryRepairPhase::DispatchInFlight)
        {
            return;
        }
        let mut completed = current.clone();
        completed.complete_repair_dispatch(&result);
        if delivery_repair_result_is_publishable(&result) {
            if let Some(repair) = completed.repair.as_mut() {
                if let Ok(paths) = self.workspace_mgr.owned_worktree_paths(&completed.issue_id) {
                    if let Some(path) = paths.get(&repair.attempt.repository_key) {
                        if let Ok(identity) = self.delivery_remote.local_identity(path).await {
                            if identity.local_sha != repair.attempt.starting_sha {
                                repair.post_worker_local_head = Some(identity.local_sha);
                                repair.phase = DeliveryRepairPhase::PushPending;
                            }
                        }
                    }
                }
            }
        }
        // The journal write is the completion boundary. Only the durable record
        // allows any later observation, interaction, or publication work.
        let Ok(completed) = self
            .persist_delivery_candidate(&current, completed, None)
            .await
        else {
            return;
        };
        self.ensure_delivery_repair_interaction(&completed).await;
    }

    async fn await_delivery_repair_operator(&self, delivery: &DeliveryRecord) {
        self.await_delivery_repair_operator_with_diagnostic(delivery, None)
            .await;
    }

    async fn await_delivery_repair_operator_with_diagnostic(
        &self,
        delivery: &DeliveryRecord,
        diagnostic: impl Into<Option<String>>,
    ) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        self.pending_delivery_repair_dispatches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&delivery.issue_id);
        let diagnostic = diagnostic.into();
        if repair.phase == DeliveryRepairPhase::AwaitingHuman
            && diagnostic.as_deref() == repair.last_error.as_deref()
        {
            self.ensure_delivery_repair_interaction(delivery).await;
            return;
        }
        let mut awaiting_human = delivery.clone();
        let repair = awaiting_human.repair.as_mut().expect("checked");
        repair.phase = DeliveryRepairPhase::AwaitingHuman;
        if let Some(diagnostic) = diagnostic {
            repair.last_error = Some(diagnostic);
        }
        if let Ok(persisted) = self
            .persist_delivery_candidate(delivery, awaiting_human, None)
            .await
        {
            self.ensure_delivery_repair_interaction(&persisted).await;
        }
    }

    pub(super) async fn advance_delivery_repair_push(&self, delivery: &DeliveryRecord) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        match repair.phase {
            DeliveryRepairPhase::PushPending => {}
            DeliveryRepairPhase::PushInFlight => {
                let mut reconciling = delivery.clone();
                reconciling.repair.as_mut().expect("checked").phase =
                    DeliveryRepairPhase::ReconcilingPush;
                let _ = self
                    .persist_delivery_candidate(delivery, reconciling, None)
                    .await;
                return;
            }
            _ => return,
        }
        let Some(local_head) = repair.post_worker_local_head.as_deref() else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the delivery repair has no retained post-worker local head; inspect it before retrying publication".to_string(),
                ),
            )
            .await;
            return;
        };
        let Some(path) = self
            .workspace_mgr
            .owned_worktree_paths(&delivery.issue_id)
            .ok()
            .and_then(|paths| {
                paths
                    .get(&repair.attempt.repository_key)
                    .filter(|path| path.is_dir())
                    .cloned()
            })
        else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the retained delivery worktree is unavailable; inspect or restore it before retrying delivery repair publication".to_string(),
                ),
            )
            .await;
            return;
        };
        let Some(repository) = delivery.repositories.get(&repair.attempt.repository_key) else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the retained delivery repository is unavailable; inspect or restore it before retrying delivery repair publication".to_string(),
                ),
            )
            .await;
            return;
        };
        let mut in_flight = delivery.clone();
        in_flight.repair.as_mut().expect("checked").phase = DeliveryRepairPhase::PushInFlight;
        let Ok(in_flight) = self
            .persist_delivery_candidate(delivery, in_flight, None)
            .await
        else {
            return;
        };
        let outcome = self
            .delivery_remote
            .guarded_repair_push(
                &path,
                &repository.remote,
                &repository.head_branch,
                &repair.attempt.starting_sha,
                local_head,
            )
            .await;
        let mut next = in_flight.clone();
        let phase = match outcome {
            GuardedRepairPushOutcome::Confirmed | GuardedRepairPushOutcome::Ambiguous => {
                DeliveryRepairPhase::ReconcilingPush
            }
            GuardedRepairPushOutcome::Rejected => DeliveryRepairPhase::AwaitingHuman,
        };
        next.repair.as_mut().expect("checked").phase = phase;
        if self
            .persist_delivery_candidate(&in_flight, next.clone(), None)
            .await
            .is_ok()
            && phase == DeliveryRepairPhase::AwaitingHuman
        {
            self.ensure_delivery_repair_interaction(&next).await;
        }
    }

    pub(super) async fn reconcile_delivery_repair_push(&self, delivery: &DeliveryRecord) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        if repair.phase != DeliveryRepairPhase::ReconcilingPush {
            return;
        }
        let Some(local_head) = repair.post_worker_local_head.as_deref() else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the delivery repair has no retained post-worker local head; inspect it before reconciling publication".to_string(),
                ),
            )
            .await;
            return;
        };
        let Some(repository) = delivery.repositories.get(&repair.attempt.repository_key) else {
            self.await_delivery_repair_operator_with_diagnostic(
                delivery,
                Some(
                    "the retained delivery repository is unavailable; inspect or restore it before reconciling publication".to_string(),
                ),
            )
            .await;
            return;
        };
        let observed = repository
            .observation
            .as_ref()
            .filter(|observation| observation.freshness == ObservationFreshness::Fresh)
            .and_then(|observation| observation.facts.as_ref())
            .filter(|facts| {
                facts.pull_request_number == repair.attempt.pull_request_number
                    && facts.pull_request_url == repair.attempt.pull_request_url
                    && facts.terminal_state == PullRequestTerminalState::Open
                    && facts.matches_delivery
                    && !facts.head_diverged
            });
        let mut next = delivery.clone();
        match observed {
            Some(facts) if facts.head_sha == local_head => {
                let entry = next
                    .repositories
                    .get_mut(&repair.attempt.repository_key)
                    .expect("checked");
                entry.local_sha = facts.head_sha.clone();
                entry.observed_remote_sha = Some(facts.head_sha.clone());
                next.repair = None;
                let _ = self
                    .persist_delivery_candidate(delivery, next.clone(), None)
                    .await;
                if let Ok(Some(interaction)) = self
                    .interaction_store
                    .latest_blocking_for_issue(&delivery.issue_id)
                    .await
                {
                    let _ = self.interaction_store.mark_resumed(&interaction.id).await;
                }
                self.state
                    .write()
                    .await
                    .remove_waiting_on_human(&delivery.issue_id);
            }
            _ => {
                next.repair.as_mut().expect("checked").phase = DeliveryRepairPhase::AwaitingHuman;
                if self
                    .persist_delivery_candidate(delivery, next.clone(), None)
                    .await
                    .is_ok()
                {
                    self.ensure_delivery_repair_interaction(&next).await;
                }
            }
        }
    }

    pub(super) async fn ensure_delivery_repair_interaction(&self, delivery: &DeliveryRecord) {
        let Some(repair) = delivery.repair.as_ref() else {
            return;
        };
        if repair.phase != DeliveryRepairPhase::AwaitingHuman {
            return;
        }
        let attempt = &repair.attempt;
        let id = repair.interaction_id.clone().unwrap_or_else(|| {
            format!(
                "delivery-repair-{}-{}-{}-{}-{}",
                delivery.issue_id,
                attempt
                    .repository_key
                    .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
                attempt.pull_request_number,
                repair.attempts_used,
                attempt
                    .starting_sha
                    .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
            )
        });
        if self
            .interaction_store
            .get(&id)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
        let feedback = &attempt.feedback;
        let outcome = repair
            .last_error
            .as_deref()
            .unwrap_or("No repair-worker failure was recorded.");
        let body = format!(
            "Delivery repair needs an operator decision.\n\nRepository: {}\nPull request: {} ({})\nObserved head: {}\nRepair attempts used: {}\nRepair outcome: {}\nFailed checks: {}\nChange requests: {}\nUnresolved threads: {}",
            attempt.repository_key,
            attempt.pull_request_number,
            attempt.pull_request_url,
            attempt.starting_sha,
            repair.attempts_used,
            outcome,
            feedback.terminal_failed_checks.join(", "),
            feedback.change_request_bodies.join("\n"),
            feedback.unresolved_threads.iter().map(|thread| format!("{}:{} {}", thread.path.as_deref().unwrap_or("<unknown>"), thread.line.map_or_else(|| "?".to_string(), |line| line.to_string()), thread.body)).collect::<Vec<_>>().join("\n"),
        );
        let interaction =
            InteractionRequest {
                id,
                schema_version: 1,
                issue_id: delivery.issue_id.clone(),
                issue_identifier: delivery.identifier.clone(),
                pipeline_cycle: 0,
                completed_steps: vec![],
                step_name: "delivery_repair".to_string(),
                agent_name: delivery
                    .delivery_repair
                    .as_ref()
                    .map(|policy| policy.agent.clone())
                    .unwrap_or_default(),
                step_depends: vec![],
                step_tracker_state: None,
                kind: InteractionKind::Question,
                status: InteractionStatus::Open,
                blocking: true,
                awaiting_resume: true,
                resume_strategy: InteractionResumeStrategy::RerunStep,
                title: format!("Resolve delivery repair for {}", delivery.identifier),
                body,
                options: if delivery.delivery_repair.as_ref().is_some_and(|policy| {
                    delivery.delivery_repair_attempts_used < policy.max_attempts
                }) {
                    vec![
                        "Retry delivery repair".to_string(),
                        "Handle manually".to_string(),
                    ]
                } else {
                    vec!["Handle manually".to_string()]
                },
                artifacts: vec![attempt.pull_request_url.clone()],
                thread_root_comment_id: None,
                thread_root_comment_url: None,
                last_processed_comment_id: None,
                accepted_command: None,
                ignored_commands: vec![],
                response: None,
                waiting_started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: Utc::now(),
                resolved_at: None,
            };
        if self
            .interaction_store
            .create(interaction.clone())
            .await
            .is_ok()
        {
            let mut state = self.state.write().await;
            state.add_waiting_on_human(super::state::WaitingOnHumanEntry {
                issue_id: interaction.issue_id.clone(),
                identifier: interaction.issue_identifier.clone(),
                interaction_request_id: interaction.id.clone(),
                step_name: interaction.step_name.clone(),
                kind: interaction.kind.clone(),
                prompt: interaction.title.clone(),
                agent_name: interaction.agent_name.clone(),
                retry_attempt: Some(repair.attempts_used),
                started_at: None,
                agent_input_tokens: 0,
                agent_output_tokens: 0,
                agent_total_tokens: 0,
                requested_at: interaction.requested_at,
                run_id: Some(delivery.run_id.clone()),
                issue: None,
            });
        }
    }

    pub(super) async fn resume_delivery_repair_interaction(
        &self,
        issue: &Issue,
        interaction: &InteractionRequest,
    ) -> Result<(), crate::error::EnsembleError> {
        let current = self
            .state
            .read()
            .await
            .delivery
            .get(&issue.id)
            .cloned()
            .ok_or_else(|| crate::error::AgentError::PromptError {
                reason: format!("issue '{}' has no delivery repair", issue.identifier),
            })?;
        let selected_option = match interaction.response.as_ref() {
            Some(InteractionResponse::Question {
                selected_option: Some(option),
                ..
            }) => option.as_str(),
            _ => {
                return Err(crate::error::AgentError::PromptError {
                    reason: "delivery repair requires an explicit valid option".to_string(),
                }
                .into())
            }
        };
        let Some(repair) = current.repair.as_ref() else {
            return Err(crate::error::AgentError::PromptError {
                reason: "delivery repair interaction has no retained repair".to_string(),
            }
            .into());
        };
        let mut retry = current.clone();
        match selected_option {
            "Retry delivery repair"
                if current.delivery_repair.as_ref().is_some_and(|policy| {
                    current.delivery_repair_attempts_used < policy.max_attempts
                }) =>
            {
                let next_cycle = retry.delivery_repair_attempts_used.saturating_add(1);
                let next_interaction_id = retry.repair_interaction_id(
                    &repair.attempt.repository_key,
                    repair.attempt.pull_request_number,
                    &repair.attempt.starting_sha,
                    next_cycle,
                );
                let repair = retry.repair.as_mut().expect("checked");
                repair.phase = DeliveryRepairPhase::PendingDispatch;
                repair.last_error = None;
                repair.post_worker_local_head = None;
                repair.interaction_id = Some(next_interaction_id);
            }
            "Handle manually" => {
                retry
                    .delivery_repair_suppressions
                    .insert(DeliveryRepairIdentity::attempted(&repair.attempt));
                retry.repair = None;
            }
            _ => {
                return Err(crate::error::AgentError::PromptError {
                    reason: "delivery repair option is unavailable for this retained delivery"
                        .to_string(),
                }
                .into())
            }
        }
        for repository in retry.repositories.values_mut() {
            if let Some(observation) = repository.observation.as_mut() {
                observation.retry = None;
            }
        }
        self.persist_delivery_candidate(&current, retry, None)
            .await
            .map_err(|_| crate::error::AgentError::PromptError {
                reason: "could not persist delivery repair retry".to_string(),
            })?;
        self.interaction_store.mark_resumed(&interaction.id).await?;
        self.state.write().await.remove_waiting_on_human(&issue.id);
        Ok(())
    }

    pub(super) async fn advance_review_projection(
        &self,
        delivery: DeliveryRecord,
    ) -> DeliveryRecord {
        let Some(projection) = delivery.review_projection.as_ref() else {
            return delivery;
        };
        if projection.phase == ReviewProjectionPhase::Blocked
            || (projection.phase == ReviewProjectionPhase::Applied && projection.history_persisted)
            || !delivery.review_ready()
        {
            return delivery;
        }

        let mut candidate = delivery;
        if candidate
            .review_projection
            .as_ref()
            .is_some_and(|projection| projection.phase == ReviewProjectionPhase::Applied)
        {
            return self.persist_applied_review_history(candidate).await;
        }
        if candidate
            .review_projection
            .as_ref()
            .is_some_and(|projection| projection.phase == ReviewProjectionPhase::Pending)
        {
            self.project_delivery_artifacts(&candidate.issue_id, &candidate)
                .await;
            self.refresh_review_history(&mut candidate, true).await;
            candidate
                .review_projection
                .as_mut()
                .expect("checked above")
                .phase = ReviewProjectionPhase::InFlight;
            if self
                .persist_delivery_record(&candidate, None)
                .await
                .is_err()
            {
                return candidate;
            }
        }

        let target = candidate
            .review_projection
            .as_ref()
            .expect("review projection is retained")
            .target
            .clone();
        let observed = self
            .tracker
            .fetch_issue_states_by_ids(std::slice::from_ref(&candidate.issue_id))
            .await;
        let observed = match observed {
            Ok(mut issues) if issues.len() == 1 => issues.pop().expect("one issue"),
            Ok(issues) => {
                return self
                    .block_review_projection(
                        candidate,
                        format!(
                            "tracker reconciliation returned {} issues for delivery identity",
                            issues.len()
                        ),
                    )
                    .await;
            }
            Err(error) => {
                return self
                    .block_review_projection(
                        candidate,
                        format!("tracker reconciliation read failed: {error}"),
                    )
                    .await;
            }
        };
        if observed.state.eq_ignore_ascii_case(&target) {
            let projection = candidate.review_projection.as_mut().expect("retained");
            projection.last_observed_state = Some(observed.state);
            return self.persist_applied_review_history(candidate).await;
        }

        let config = self.config.read().await;
        let terminal = config
            .tracker
            .terminal_states
            .iter()
            .any(|state| state.eq_ignore_ascii_case(&observed.state));
        let active = config
            .tracker
            .active_states
            .iter()
            .any(|state| state.eq_ignore_ascii_case(&observed.state));
        drop(config);
        if terminal || (!active && !candidate.is_frozen_delivery_state(&observed.state)) {
            return self
                .block_review_projection(
                    candidate,
                    format!(
                        "unexpected tracker state '{}' during review projection",
                        observed.state
                    ),
                )
                .await;
        }

        if let Err(error) = self
            .tracker
            .set_issue_state(&candidate.issue_id, &target)
            .await
        {
            let projection = candidate.review_projection.as_mut().expect("retained");
            projection.last_observed_state = Some(observed.state);
            projection.diagnostic =
                Some(format!("review-state write needs reconciliation: {error}"));
            let _ = self.persist_delivery_record(&candidate, None).await;
            return candidate;
        }

        let confirmed = self
            .tracker
            .fetch_issue_states_by_ids(std::slice::from_ref(&candidate.issue_id))
            .await;
        match confirmed {
            Ok(mut issues) if issues.len() == 1 => {
                let issue = issues.pop().expect("one issue");
                let projection = candidate.review_projection.as_mut().expect("retained");
                projection.last_observed_state = Some(issue.state.clone());
                if issue.state.eq_ignore_ascii_case(&target) {
                    self.persist_applied_review_history(candidate).await
                } else if issue.state.eq_ignore_ascii_case(&observed.state) {
                    projection.diagnostic = Some("review-state write not yet observed".to_string());
                    let _ = self.persist_delivery_record(&candidate, None).await;
                    candidate
                } else {
                    self.block_review_projection(
                        candidate,
                        format!(
                            "unexpected tracker state '{}' after review-state write",
                            issue.state
                        ),
                    )
                    .await
                }
            }
            Ok(issues) => {
                self.block_review_projection(
                    candidate,
                    format!(
                        "tracker reconciliation returned {} issues after review-state write",
                        issues.len()
                    ),
                )
                .await
            }
            Err(error) => {
                self.block_review_projection(
                    candidate,
                    format!("tracker reconciliation read failed after review-state write: {error}"),
                )
                .await
            }
        }
    }

    async fn advance_delivery_state_projection(
        &self,
        mut delivery: DeliveryRecord,
    ) -> DeliveryRecord {
        let Some(fact) = delivery.delivery_state_fact() else {
            return delivery;
        };
        let Some(target) = delivery.delivery_states.target_for(fact) else {
            return delivery;
        };
        let selection = DeliveryStateProjection {
            schema_version: 1,
            fact,
            target: target.to_string(),
        };
        let selection_changed = delivery.selected_delivery_state.as_ref() != Some(&selection);
        if selection_changed
            && delivery
                .review_projection
                .as_ref()
                .is_some_and(|projection| projection.phase == ReviewProjectionPhase::InFlight)
        {
            // An ambiguous tracker write must reconcile the durable in-flight target before
            // newer remote facts are allowed to select another projection.
            return self.advance_review_projection(delivery).await;
        }
        if delivery.review_projection.is_none() || selection_changed {
            let history_record = delivery
                .terminal_history
                .as_deref()
                .cloned()
                .map(|mut record| {
                    record.outcome = "delivery_projected".to_string();
                    record
                });
            delivery.review_projection = Some(ReviewProjection {
                target: target.to_string(),
                repositories: delivery.repositories.keys().cloned().collect(),
                phase: ReviewProjectionPhase::Pending,
                diagnostic: None,
                last_observed_state: None,
                history_record,
                history_persisted: false,
            });
            delivery.selected_delivery_state = Some(selection);
            if self.persist_delivery_record(&delivery, None).await.is_err() {
                return delivery;
            }
        }
        self.advance_review_projection(delivery).await
    }

    pub(super) async fn park_closed_without_merge(
        &self,
        mut delivery: DeliveryRecord,
    ) -> DeliveryRecord {
        if !delivery.closed_without_merge_parked {
            delivery.closed_without_merge_parked = true;
            if self.persist_delivery_record(&delivery, None).await.is_err() {
                return delivery;
            }
        }
        let Some(reporter) = self.attention_reporter.as_ref() else {
            return delivery;
        };
        let observation = closed_without_merge_attention(&delivery);
        match observation {
            Ok(observation) => {
                if let Err(error) = reporter.upsert_open(observation).await {
                    warn!(issue_id = %delivery.issue_id, error = %error, "failed to persist closed-without-merge operator attention");
                }
            }
            Err(error) => {
                warn!(issue_id = %delivery.issue_id, error = %error, "could not create closed-without-merge operator attention")
            }
        }
        delivery
    }

    pub(super) async fn clear_closed_without_merge_park(
        &self,
        mut delivery: DeliveryRecord,
    ) -> DeliveryRecord {
        if !delivery.closed_without_merge_parked {
            return delivery;
        }
        if let Some(reporter) = self.attention_reporter.as_ref() {
            let close = match closed_without_merge_attention_close(&delivery) {
                Ok(close) => close,
                Err(error) => {
                    warn!(issue_id = %delivery.issue_id, error = %error, "could not create closed-without-merge attention resolution");
                    return delivery;
                }
            };
            if let Err(error) = reporter.resolve(close).await {
                warn!(issue_id = %delivery.issue_id, error = %error, "failed to resolve closed-without-merge operator attention");
                return delivery;
            }
        }
        delivery.closed_without_merge_parked = false;
        if self.persist_delivery_record(&delivery, None).await.is_err() {
            return delivery;
        }
        delivery
    }

    async fn block_review_projection(
        &self,
        delivery: DeliveryRecord,
        diagnostic: String,
    ) -> DeliveryRecord {
        let mut candidate = delivery.clone();
        let projection = candidate
            .review_projection
            .as_mut()
            .expect("review projection is retained");
        projection.phase = ReviewProjectionPhase::Blocked;
        projection.diagnostic = Some(diagnostic);
        if self
            .persist_delivery_record(&candidate, None)
            .await
            .is_err()
        {
            return delivery;
        }
        candidate
    }

    async fn persist_applied_review_history(&self, mut delivery: DeliveryRecord) -> DeliveryRecord {
        {
            let projection = delivery.review_projection.as_mut().expect("retained");
            projection.phase = ReviewProjectionPhase::Applied;
            projection.diagnostic = None;
        }
        if self.persist_delivery_record(&delivery, None).await.is_err() {
            return delivery;
        }
        self.project_delivery_artifacts(&delivery.issue_id, &delivery)
            .await;
        if delivery
            .review_projection
            .as_ref()
            .expect("retained")
            .history_persisted
        {
            return delivery;
        }
        self.refresh_review_history(&mut delivery, false).await;
        if self.persist_delivery_record(&delivery, None).await.is_err() {
            return delivery;
        }
        let record = delivery
            .review_projection
            .as_ref()
            .expect("retained")
            .history_record
            .clone();
        let Some(record) = record else {
            return self
                .block_review_projection(
                    delivery,
                    "review projection is missing its prepared history record".to_string(),
                )
                .await;
        };
        if let Err(error) = self
            .persist_history_record(Some(&delivery.run_id), &record)
            .await
        {
            let projection = delivery.review_projection.as_mut().expect("retained");
            projection.diagnostic = Some(format!(
                "review state is confirmed but in-review history persistence needs reconciliation: {error}"
            ));
            let _ = self.persist_delivery_record(&delivery, None).await;
            return delivery;
        }
        delivery
            .review_projection
            .as_mut()
            .expect("retained")
            .history_persisted = true;
        if self.persist_delivery_record(&delivery, None).await.is_err() {
            return delivery;
        }
        delivery
    }

    async fn refresh_review_history(
        &self,
        delivery: &mut DeliveryRecord,
        refresh_completed_at: bool,
    ) {
        let artifacts = self
            .state
            .read()
            .await
            .artifacts
            .get(&delivery.issue_id)
            .cloned();
        let Some(record) = delivery
            .review_projection
            .as_mut()
            .and_then(|projection| projection.history_record.as_mut())
        else {
            return;
        };
        if refresh_completed_at {
            record.completed_at = Utc::now();
            record.duration_seconds = record
                .completed_at
                .signed_duration_since(record.started_at)
                .num_seconds()
                .max(0) as u64;
        }
        record.artifacts = artifacts;
    }

    async fn complete_published_delivery(
        &self,
        delivery: &DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) {
        let Some(history_record) = self
            .projected_terminal_history(delivery, HISTORY_OUTCOME_SUCCEEDED)
            .await
        else {
            warn!(
                issue_id = %delivery.issue_id,
                "published delivery has no durable completion history"
            );
            return;
        };
        let config = match self.current_config_for_snapshot(snapshot).await {
            Ok(config) => config,
            Err(error) => {
                warn!(
                    issue_id = %delivery.issue_id,
                    error = %error,
                    "published delivery could not resolve its selected workflow"
                );
                return;
            }
        };
        let finalize = Self::finalize_state_from_delivery(delivery);
        self.state
            .write()
            .await
            .set_finalize_state(&delivery.issue_id, finalize.clone());
        let issue = self
            .tracker
            .fetch_issue_states_by_ids(std::slice::from_ref(&delivery.issue_id))
            .await
            .ok()
            .and_then(|issues| issues.into_iter().next());
        self.begin_terminal_transition_for_identity(
            &delivery.issue_id,
            &delivery.identifier,
            issue,
            TerminalOutcome::Succeeded,
            config.on_success.clone(),
            Some(history_record),
        )
        .await;
    }
    pub(super) async fn project_delivery_artifacts(
        &self,
        issue_id: &str,
        delivery: &DeliveryRecord,
    ) {
        let mut state = self.state.write().await;
        let Some(artifacts) = state.artifacts.get_mut(issue_id) else {
            return;
        };
        Self::apply_delivery_artifacts(artifacts, delivery);
    }

    fn apply_delivery_artifacts(
        artifacts: &mut crate::history::artifacts::RunArtifacts,
        delivery: &DeliveryRecord,
    ) {
        for artifact in &mut artifacts.repos {
            let Some(repository) = delivery.repositories.get(&artifact.repo) else {
                continue;
            };
            artifact.finalize_status = if repository.phase == DeliveryPhase::Waiting {
                "waiting"
            } else {
                Self::finalize_status_name(&Self::finalize_status_from_delivery(repository))
            }
            .to_string();
            artifact.pushed_ref = repository
                .observed_remote_sha
                .as_ref()
                .map(|_| format!("{}/{}", repository.remote, repository.head_branch));
            artifact.pr_url = repository.pr_url.clone();
            artifact.pr_number = repository.pr_number;
            artifact.review_state = delivery
                .review_projection
                .as_ref()
                .map(|projection| projection.target.clone());
            artifact.review_projection = delivery.review_projection.as_ref().map(|projection| {
                match projection.phase {
                    ReviewProjectionPhase::Pending => "pending",
                    ReviewProjectionPhase::InFlight => "in_flight",
                    ReviewProjectionPhase::Applied => "applied",
                    ReviewProjectionPhase::Blocked => "blocked",
                }
                .to_string()
            });
            artifact.last_error = repository.last_error.clone();
            artifact.observation = repository.observation.clone();
        }
    }
    pub(super) fn finalize_state_from_delivery(delivery: &DeliveryRecord) -> IssueFinalizeState {
        let aggregate = delivery.aggregate();
        IssueFinalizeState {
            issue_identifier: delivery.identifier.clone(),
            status: match aggregate {
                DeliveryAggregate::Blocked => FinalizeStatus::Failed,
                DeliveryAggregate::Published => FinalizeStatus::Succeeded,
                DeliveryAggregate::Active | DeliveryAggregate::Waiting => {
                    if delivery
                        .repositories
                        .values()
                        .any(|repository| repository.phase == DeliveryPhase::AwaitingApproval)
                    {
                        FinalizeStatus::PendingApproval
                    } else {
                        FinalizeStatus::InProgress
                    }
                }
            },
            repos: Self::finalize_repositories_from_delivery(delivery),
        }
    }
    pub(super) fn finalize_repositories_from_delivery(
        delivery: &DeliveryRecord,
    ) -> Vec<RepoFinalizeState> {
        delivery
            .repositories
            .iter()
            .map(|(repository_key, repository)| RepoFinalizeState {
                repo: repository_key.clone(),
                mode: match repository.mode {
                    DeliveryMode::Push => "push",
                    DeliveryMode::PushAndPr => "push_and_pr",
                }
                .to_string(),
                approval_required: repository.approval_required,
                status: Self::finalize_status_from_delivery(repository),
                last_error: repository.last_error.clone(),
                observation: repository.observation.clone(),
            })
            .collect()
    }

    pub(super) fn finalize_status_from_delivery(repository: &DeliveryRepository) -> FinalizeStatus {
        match repository.phase {
            DeliveryPhase::AwaitingApproval => FinalizeStatus::PendingApproval,
            DeliveryPhase::Published => FinalizeStatus::Succeeded,
            DeliveryPhase::Blocked => FinalizeStatus::Failed,
            _ => FinalizeStatus::InProgress,
        }
    }
    pub(super) async fn advance_delivery_record(
        &self,
        mut delivery: DeliveryRecord,
        workspace: &crate::workspace::manager::WorkspaceResult,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let repository_keys = delivery.repositories.keys().cloned().collect::<Vec<_>>();
        for repository_key in repository_keys {
            let Some(repository_path) = workspace
                .worktrees
                .get(&repository_key)
                .map(|worktree| worktree.path.clone())
            else {
                delivery = self
                    .block_delivery_repository(
                        &delivery,
                        &repository_key,
                        DeliveryPhase::Prepared,
                        "delivery worktree is missing".to_string(),
                        None,
                        snapshot,
                    )
                    .await;
                continue;
            };
            let mut created_pull_request = false;
            for _ in 0..16 {
                let before = delivery.clone();
                let mut created_this_iteration = false;
                let phase = delivery.repositories[&repository_key].phase;
                delivery = match phase {
                    DeliveryPhase::AwaitingApproval => break,
                    DeliveryPhase::Prepared
                    | DeliveryPhase::PushInFlight
                    | DeliveryPhase::ReconcilingPush => {
                        self.advance_delivery_push(
                            delivery,
                            &repository_key,
                            &repository_path,
                            snapshot,
                        )
                        .await
                    }
                    DeliveryPhase::PrCreateInFlight | DeliveryPhase::ReconcilingPr => {
                        let (next, created) = self
                            .advance_delivery_pull_request(
                                delivery,
                                &repository_key,
                                &repository_path,
                                snapshot,
                                !created_pull_request,
                            )
                            .await;
                        created_this_iteration = created;
                        created_pull_request |= created;
                        next
                    }
                    DeliveryPhase::Waiting | DeliveryPhase::Published | DeliveryPhase::Blocked => {
                        break
                    }
                };
                let entry = &delivery.repositories[&repository_key];
                if (delivery == before && !created_this_iteration)
                    || (matches!(
                        entry.phase,
                        DeliveryPhase::PushInFlight | DeliveryPhase::PrCreateInFlight
                    ) && entry.last_error.is_some())
                {
                    break;
                }
            }
        }
        self.evaluate_post_final_acceptance(delivery, snapshot)
            .await
    }

    pub(super) async fn evaluate_post_final_acceptance(
        &self,
        delivery: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let Some(mut candidate_snapshot) = snapshot.cloned() else {
            return delivery;
        };
        let Some(plan) = candidate_snapshot.resolved_acceptance_plan.clone() else {
            return delivery;
        };
        let rules = &plan.required_pull_requests;
        if rules.is_empty()
            || rules.iter().any(|rule| {
                delivery
                    .repositories
                    .get(&rule.repo)
                    .is_none_or(|repository| {
                        !matches!(
                            repository.phase,
                            DeliveryPhase::Waiting | DeliveryPhase::Published
                        )
                    })
            })
        {
            return delivery;
        }
        let Some(attempt_index) = candidate_snapshot
            .acceptance_attempts
            .iter()
            .position(|attempt| attempt.cycle == candidate_snapshot.cycle)
        else {
            return delivery;
        };
        let pre_final_len = plan.pre_final_len();
        let result_len = candidate_snapshot.acceptance_attempts[attempt_index]
            .results
            .len();
        if result_len < pre_final_len {
            return delivery;
        }
        let suffix_len = result_len - pre_final_len;
        let retry_requested = rules.iter().any(|rule| {
            delivery
                .repositories
                .get(&rule.repo)
                .is_some_and(|repository| repository.retry_from == Some(DeliveryPhase::Waiting))
        });
        if suffix_len > 0 && suffix_len % rules.len() == 0 && !retry_requested {
            let latest = &candidate_snapshot.acceptance_attempts[attempt_index].results
                [result_len - rules.len()..result_len];
            if latest
                .iter()
                .all(|result| result.status == crate::acceptance::AcceptanceStatus::Passed)
            {
                return delivery;
            }
            return self
                .apply_post_final_acceptance_outcome(delivery, &candidate_snapshot, rules, latest)
                .await;
        }

        let resume_index = suffix_len % rules.len();
        let current = delivery;
        for rule in rules.iter().skip(resume_index) {
            let Some(repository) = current.repositories.get(&rule.repo) else {
                return current;
            };
            let result = evaluate_pull_request_requirement(rule, repository);
            candidate_snapshot.acceptance_attempts[attempt_index]
                .results
                .push(result);
            if let Err(error) = self
                .persist_delivery_record(&current, Some(&candidate_snapshot))
                .await
            {
                warn!(
                    issue_id = %current.issue_id,
                    error = %error,
                    "failed to persist post-final acceptance result"
                );
                return current;
            }
        }

        let results = &candidate_snapshot.acceptance_attempts[attempt_index].results;
        let latest = &results[results.len() - rules.len()..];
        self.apply_post_final_acceptance_outcome(current, &candidate_snapshot, rules, latest)
            .await
    }

    async fn apply_post_final_acceptance_outcome(
        &self,
        current: DeliveryRecord,
        snapshot: &PipelineRunSnapshot,
        rules: &[crate::config::ensemble::AcceptancePullRequestConfig],
        latest: &[crate::acceptance::AcceptanceResult],
    ) -> DeliveryRecord {
        let mut candidate = current.clone();
        for (rule, result) in rules.iter().zip(latest) {
            let Some(repository) = candidate.repositories.get_mut(&rule.repo) else {
                continue;
            };
            if result.status == crate::acceptance::AcceptanceStatus::Passed {
                if repository.retry_from == Some(DeliveryPhase::Waiting) {
                    repository.phase = DeliveryPhase::Waiting;
                    repository.retry_from = None;
                    repository.ownership_conflict = None;
                    repository.last_error = None;
                }
            } else {
                repository.phase = DeliveryPhase::Blocked;
                repository.retry_from = Some(DeliveryPhase::Waiting);
                repository.last_error = Some(result.summary.clone());
            }
        }
        if candidate == current {
            return current;
        }
        self.persist_delivery_candidate(&current, candidate, Some(snapshot))
            .await
            .unwrap_or_else(|authoritative| authoritative)
    }
    async fn advance_delivery_pull_request(
        &self,
        mut delivery: DeliveryRecord,
        repository_key: &str,
        repository_path: &Path,
        snapshot: Option<&PipelineRunSnapshot>,
        allow_create: bool,
    ) -> (DeliveryRecord, bool) {
        if delivery.repositories[repository_key].phase == DeliveryPhase::PrCreateInFlight {
            let mut reconciling = delivery.clone();
            let entry = reconciling.repositories.get_mut(repository_key).unwrap();
            entry.phase = DeliveryPhase::ReconcilingPr;
            entry.ownership_conflict = None;
            entry.last_error = None;
            delivery = match self
                .persist_delivery_candidate(&delivery, reconciling, snapshot)
                .await
            {
                Ok(persisted) => persisted,
                Err(authoritative) => return (authoritative, false),
            };
        }
        let repository = delivery.repositories[repository_key].clone();
        if repository.phase != DeliveryPhase::ReconcilingPr {
            return (delivery, false);
        }
        let adoption_policy = {
            let config = self.config.read().await;
            self.delivery_remote
                .pull_request_adoption_policy(&config, &delivery.issue_id)
        };
        let pull_requests = match self
            .delivery_remote
            .list_pull_requests(repository_path, repository_key, adoption_policy.as_ref())
            .await
        {
            Ok(pull_requests) => pull_requests,
            Err(error) => {
                return (
                    self.block_delivery_repository(
                        &delivery,
                        repository_key,
                        DeliveryPhase::ReconcilingPr,
                        error,
                        None,
                        snapshot,
                    )
                    .await,
                    false,
                )
            }
        };
        match reconcile_pull_requests(
            repository_key,
            &repository,
            &pull_requests,
            adoption_policy.as_ref(),
        ) {
            PullRequestReconciliation::Adopted { number, url } => {
                let mut waiting = delivery.clone();
                let entry = waiting.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::Waiting;
                entry.pr_number = Some(number);
                entry.pr_url = Some(url);
                entry.ownership_conflict = None;
                entry.last_error = None;
                entry.retry_from = None;
                (
                    self.persist_delivery_candidate(&delivery, waiting, snapshot)
                        .await
                        .unwrap_or_else(|authoritative| authoritative),
                    false,
                )
            }
            PullRequestReconciliation::Create if !allow_create => (delivery, false),
            PullRequestReconciliation::Create => {
                let mut in_flight = delivery.clone();
                let entry = in_flight.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::PrCreateInFlight;
                entry.ownership_conflict = None;
                entry.last_error = None;
                delivery = match self
                    .persist_delivery_candidate(&delivery, in_flight, snapshot)
                    .await
                {
                    Ok(persisted) => persisted,
                    Err(authoritative) => return (authoritative, false),
                };
                let result = self
                    .delivery_remote
                    .create_pull_request(
                        repository_path,
                        &repository.base_branch,
                        &repository.head_branch,
                        &repository.marker,
                    )
                    .await;
                let mut after_create = delivery.clone();
                let entry = after_create.repositories.get_mut(repository_key).unwrap();
                match result {
                    Ok(_) => {
                        entry.phase = DeliveryPhase::ReconcilingPr;
                        entry.ownership_conflict = None;
                        entry.last_error = None;
                    }
                    Err(error) => entry.last_error = Some(error),
                }
                let persisted = self
                    .persist_delivery_candidate(&delivery, after_create, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative);
                let created =
                    persisted.repositories[repository_key].phase == DeliveryPhase::ReconcilingPr;
                (persisted, created)
            }
            PullRequestReconciliation::Blocked { error } => (
                self.block_delivery_repository(
                    &delivery,
                    repository_key,
                    DeliveryPhase::ReconcilingPr,
                    error,
                    None,
                    snapshot,
                )
                .await,
                false,
            ),
            PullRequestReconciliation::Conflict { conflict, error } => (
                self.block_delivery_repository(
                    &delivery,
                    repository_key,
                    DeliveryPhase::ReconcilingPr,
                    error,
                    Some(conflict),
                    snapshot,
                )
                .await,
                false,
            ),
        }
    }

    async fn advance_delivery_push(
        &self,
        mut delivery: DeliveryRecord,
        repository_key: &str,
        repository_path: &Path,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let phase = delivery.repositories[repository_key].phase;
        if matches!(phase, DeliveryPhase::Prepared | DeliveryPhase::PushInFlight) {
            let mut reconciling = delivery.clone();
            let entry = reconciling.repositories.get_mut(repository_key).unwrap();
            entry.phase = DeliveryPhase::ReconcilingPush;
            entry.ownership_conflict = None;
            entry.last_error = None;
            entry.retry_from = None;
            delivery = match self
                .persist_delivery_candidate(&delivery, reconciling, snapshot)
                .await
            {
                Ok(persisted) => persisted,
                Err(authoritative) => return authoritative,
            };
        }
        let repository = delivery.repositories[repository_key].clone();
        if repository.phase != DeliveryPhase::ReconcilingPush {
            return delivery;
        }
        let observed = match self
            .delivery_remote
            .remote_head(repository_path, &repository.remote, &repository.head_branch)
            .await
        {
            Ok(observed) => observed,
            Err(error) => {
                return self
                    .block_delivery_repository(
                        &delivery,
                        repository_key,
                        DeliveryPhase::ReconcilingPush,
                        error,
                        None,
                        snapshot,
                    )
                    .await
            }
        };
        match reconcile_push(&repository, observed.clone()) {
            PushReconciliation::Push => {
                let mut in_flight = delivery.clone();
                let entry = in_flight.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::PushInFlight;
                entry.ownership_conflict = None;
                entry.last_error = None;
                delivery = match self
                    .persist_delivery_candidate(&delivery, in_flight, snapshot)
                    .await
                {
                    Ok(persisted) => persisted,
                    Err(authoritative) => return authoritative,
                };
                let result = self
                    .delivery_remote
                    .push(
                        repository_path,
                        &repository.remote,
                        &repository.head_branch,
                        &repository.local_sha,
                    )
                    .await;
                let mut after_push = delivery.clone();
                let entry = after_push.repositories.get_mut(repository_key).unwrap();
                match result {
                    Ok(_) => {
                        entry.phase = DeliveryPhase::ReconcilingPush;
                        entry.ownership_conflict = None;
                        entry.last_error = None;
                    }
                    Err(error) => entry.last_error = Some(error),
                }
                self.persist_delivery_candidate(&delivery, after_push, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative)
            }
            PushReconciliation::Advance => {
                let mut advanced = delivery.clone();
                let entry = advanced.repositories.get_mut(repository_key).unwrap();
                entry.observed_remote_sha = observed;
                entry.ownership_conflict = None;
                entry.last_error = None;
                entry.retry_from = None;
                entry.phase = match entry.mode {
                    DeliveryMode::Push => DeliveryPhase::Published,
                    DeliveryMode::PushAndPr => DeliveryPhase::ReconcilingPr,
                };
                self.persist_delivery_candidate(&delivery, advanced, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative)
            }
            PushReconciliation::Blocked { error } => {
                self.block_delivery_repository(
                    &delivery,
                    repository_key,
                    DeliveryPhase::ReconcilingPush,
                    error,
                    None,
                    snapshot,
                )
                .await
            }
        }
    }
    async fn block_delivery_repository(
        &self,
        current: &DeliveryRecord,
        repository_key: &str,
        retry_from: DeliveryPhase,
        error: String,
        ownership_conflict: Option<OwnershipConflict>,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let mut blocked = current.clone();
        if let Some(repository) = blocked.repositories.get_mut(repository_key) {
            repository.phase = DeliveryPhase::Blocked;
            repository.last_error = Some(error);
            repository.ownership_conflict = ownership_conflict;
            repository.retry_from = Some(retry_from);
        }
        self.persist_delivery_candidate(current, blocked, snapshot)
            .await
            .unwrap_or_else(|authoritative| authoritative)
    }
    async fn persist_delivery_candidate(
        &self,
        current: &DeliveryRecord,
        candidate: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> Result<DeliveryRecord, DeliveryRecord> {
        match self.persist_delivery_record(&candidate, snapshot).await {
            Ok(()) => Ok(candidate),
            Err(error) => {
                warn!(
                    issue_id = %candidate.issue_id,
                    error = %error,
                    "failed to persist delivery transition; retaining the prior durable owner"
                );
                Err(current.clone())
            }
        }
    }
    pub(super) async fn persist_delivery_record(
        &self,
        delivery: &DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> Result<(), String> {
        let snapshot = match snapshot {
            Some(snapshot) => Some(snapshot.clone()),
            None => self
                .pipeline_journal
                .latest_live_record_for_issue(&delivery.issue_id)
                .await
                .map_err(|error| {
                    format!("failed to carry the pipeline snapshot into delivery: {error}")
                })?
                .filter(|record| record.run_id.as_deref() == Some(delivery.run_id.as_str()))
                .and_then(|record| record.snapshot),
        };
        let persisted_snapshot = snapshot.clone();
        let input = PipelineTransitionInput {
            kind: PipelineTransitionKind::DeliveryOwned,
            issue_id: delivery.issue_id.clone(),
            identifier: delivery.identifier.clone(),
            run_id: Some(delivery.run_id.clone()),
            cycle: snapshot.as_ref().map_or(0, |snapshot| snapshot.cycle),
            step: None,
            reason: None,
            retry: None,
            snapshot,
            terminal_transition: None,
            delivery: Some(Box::new(delivery.clone())),
        };
        let transaction = self
            .pipeline_journal
            .begin_issue_transition(&delivery.issue_id)
            .await;
        if let Err(append_error) = transaction.append(input.clone()).await {
            match transaction.latest_record_matches(&input).await {
                Ok(true) => {}
                Ok(false) => {
                    return Err(format!(
                        "delivery transition was not persisted: {append_error}"
                    ));
                }
                Err(read_error) => {
                    return Err(format!(
                        "delivery transition append was ambiguous: {append_error}; reconciliation read failed: {read_error}"
                    ));
                }
            }
        }
        drop(transaction);

        let mut state = self.state.write().await;
        state.add_claimed(&delivery.issue_id);
        state
            .delivery
            .insert(delivery.issue_id.clone(), delivery.clone());
        state.finalize_terminal_history.remove(&delivery.issue_id);
        if let Some(snapshot) = persisted_snapshot
            .as_ref()
            .filter(|snapshot| snapshot.issue_id == delivery.issue_id)
        {
            if let Some(run) = state.get_pipeline_run_mut(&delivery.issue_id) {
                run.acceptance_attempts = snapshot.acceptance_attempts.clone();
                run.resolved_acceptance_plan = snapshot.resolved_acceptance_plan.clone();
            }
        }
        Ok(())
    }
    pub(super) async fn prepare_delivery_record(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        workspace: &crate::workspace::manager::WorkspaceResult,
        repository_keys: &[String],
    ) -> Result<(DeliveryRecord, Option<PipelineRunSnapshot>), String> {
        let (run_id, snapshot, terminal_history, delivery_repair_capacity) = {
            let state = self.state.read().await;
            let run_id = state
                .running
                .get(issue_id)
                .and_then(|entry| entry.run_id.clone())
                .or_else(|| state.issue_run_ids.get(issue_id).cloned())
                .ok_or_else(|| "delivery requires a stable run ID".to_string())?;
            let snapshot = state
                .get_pipeline_run(issue_id)
                .map(PipelineRun::to_snapshot);
            let terminal_history = self
                .build_owned_history_record(
                    &state,
                    issue_id,
                    HISTORY_OUTCOME_SUCCEEDED,
                    None,
                    Utc::now(),
                )
                .or_else(|| state.finalize_terminal_history.get(issue_id).cloned());
            let delivery_repair_capacity = snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.selected_workflow.as_ref())
                .map(|selected| DeliveryRepairCapacity::Lane {
                    lane: selected.lane.clone(),
                })
                .or_else(|| {
                    state
                        .running
                        .get(issue_id)
                        .map(|running| DeliveryRepairCapacity::State {
                            state: running.issue.state.clone(),
                        })
                });
            (run_id, snapshot, terminal_history, delivery_repair_capacity)
        };
        let configured_repositories = self.workspace_mgr.repos();
        let mut repositories = std::collections::BTreeMap::new();
        for repository_key in repository_keys {
            let config = configured_repositories
                .get(repository_key)
                .ok_or_else(|| format!("repository '{repository_key}' is no longer configured"))?;
            let worktree = workspace.worktrees.get(repository_key).ok_or_else(|| {
                format!("worktree for repository '{repository_key}' was not prepared")
            })?;
            let identity = self.delivery_remote.local_identity(&worktree.path).await?;
            let mode = match config.finalize.mode {
                FinalizeMode::Push => DeliveryMode::Push,
                FinalizeMode::PushAndPr => DeliveryMode::PushAndPr,
                FinalizeMode::None => continue,
            };
            repositories.insert(
                repository_key.clone(),
                DeliveryRepository {
                    mode,
                    phase: if config.finalize.approval_required {
                        DeliveryPhase::AwaitingApproval
                    } else {
                        DeliveryPhase::Prepared
                    },
                    approval_required: config.finalize.approval_required,
                    merge: config.finalize.merge.clone(),
                    remote: config.git_remote.clone(),
                    base_branch: config.branch.clone(),
                    head_branch: identity.head_branch,
                    local_sha: identity.local_sha,
                    observed_remote_sha: None,
                    marker: canonical_marker(&run_id, issue_id, repository_key),
                    pr_number: None,
                    pr_url: None,
                    observation: None,
                    merge_mutation: None,
                    ownership_conflict: None,
                    last_error: None,
                    retry_from: None,
                },
            );
        }
        let (delivery_states, delivery_repair, success_state, failure_state) = {
            let state = self.state.read().await;
            state
                .get_pipeline_config(issue_id)
                .map(|config| {
                    (
                        config.delivery_states.clone(),
                        config.delivery_repair.clone(),
                        config.on_success.clone(),
                        config.on_failure.clone(),
                    )
                })
                .unwrap_or_default()
        };
        Ok((
            DeliveryRecord {
                issue_id: issue_id.to_string(),
                identifier: issue_identifier.to_string(),
                run_id,
                repositories,
                terminal_history: terminal_history.map(Box::new),
                review_projection: None,
                delivery_states,
                delivery_repair,
                repair: None,
                delivery_repair_attempts_used: 0,
                delivery_repair_capacity,
                delivery_repair_suppressions: Default::default(),
                success_state: Some(success_state),
                failure_state: Some(failure_state),
                closed_without_merge_parked: false,
                selected_delivery_state: None,
            },
            snapshot,
        ))
    }
}

fn delivery_repair_result_is_publishable(result: &WorkerResult) -> bool {
    matches!(
        result,
        WorkerResult::Success {
            output,
            approval_request: None,
        } if matches!(
            &output.result,
            crate::pipeline::verdict::StepResult::Succeeded
        )
    )
}

fn closed_without_merge_attention(
    delivery: &DeliveryRecord,
) -> Result<crate::attention::AttentionUpsert, crate::attention::AttentionError> {
    Ok(crate::attention::AttentionUpsert::new(
        crate::attention::AttentionIdentity::new(
            "runtime.delivery",
            &delivery.issue_id,
            "runtime.delivery.closed_without_merge",
        )?,
        crate::attention::AttentionPresentation::new(
            format!("{} has a pull request closed without merge", delivery.identifier),
            "Resolve the pull request externally, then explicitly retry finalization to obtain fresh delivery evidence.",
            vec![],
        )?,
        crate::attention::AttentionEvidence::new(format!(
            "run:{}:closed_without_merge",
            delivery.run_id
        ))?,
    ))
}

fn closed_without_merge_attention_close(
    delivery: &DeliveryRecord,
) -> Result<crate::attention::AttentionClose, crate::attention::AttentionError> {
    crate::attention::AttentionClose::new(
        crate::attention::AttentionIdentity::new(
            "runtime.delivery",
            &delivery.issue_id,
            "runtime.delivery.closed_without_merge",
        )?,
        format!("run:{}:closed_without_merge", delivery.run_id),
        crate::attention::AttentionEvidence::new(format!(
            "run:{}:closed_without_merge:recovered",
            delivery.run_id
        ))?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_stdout(repository_path: &Path, arguments: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(repository_path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repository(phase: DeliveryPhase) -> DeliveryRepository {
        DeliveryRepository {
            mode: DeliveryMode::PushAndPr,
            phase,
            approval_required: false,
            merge: DeliveryMergeConfig::Manual,
            remote: "origin".to_string(),
            base_branch: "main".to_string(),
            head_branch: "ensemble/issue-420".to_string(),
            local_sha: "0123456789abcdef".to_string(),
            observed_remote_sha: None,
            marker: "<!-- ensemble:delivery:v1 -->".to_string(),
            pr_number: None,
            pr_url: None,
            observation: None,
            merge_mutation: None,
            ownership_conflict: None,
            last_error: None,
            retry_from: None,
        }
    }

    #[test]
    fn guarded_repair_push_uses_an_exact_ref_lease() {
        assert_eq!(
            guarded_repair_push_arguments("origin", "ensemble/issue-420", "observed", "local"),
            [
                "push".to_string(),
                "--force-with-lease=refs/heads/ensemble/issue-420:observed".to_string(),
                "origin".to_string(),
                "local:refs/heads/ensemble/issue-420".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn guarded_repair_push_rejects_a_branch_advanced_after_observation_without_overwriting_it(
    ) {
        let root = tempfile::TempDir::new().unwrap();
        let remote = root.path().join("remote.git");
        let repair = root.path().join("repair");
        let racer = root.path().join("racer");
        std::fs::create_dir_all(&repair).unwrap();
        git_stdout(
            root.path(),
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        );
        git_stdout(&repair, &["init", "--initial-branch=main"]);
        git_stdout(&repair, &["config", "user.email", "test@example.com"]);
        git_stdout(&repair, &["config", "user.name", "Test"]);
        std::fs::write(repair.join("README.md"), "base\n").unwrap();
        git_stdout(&repair, &["add", "README.md"]);
        git_stdout(&repair, &["commit", "-m", "base"]);
        git_stdout(
            &repair,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git_stdout(&repair, &["push", "-u", "origin", "main"]);
        let observed_head = git_stdout(&repair, &["rev-parse", "HEAD"]);

        std::fs::write(repair.join("README.md"), "repair\n").unwrap();
        git_stdout(&repair, &["commit", "-am", "repair"]);
        let repair_head = git_stdout(&repair, &["rev-parse", "HEAD"]);

        git_stdout(
            root.path(),
            &["clone", remote.to_str().unwrap(), racer.to_str().unwrap()],
        );
        git_stdout(&racer, &["config", "user.email", "racer@example.com"]);
        git_stdout(&racer, &["config", "user.name", "Racer"]);
        std::fs::write(racer.join("README.md"), "racer\n").unwrap();
        git_stdout(&racer, &["commit", "-am", "racer"]);
        let racer_head = git_stdout(&racer, &["rev-parse", "HEAD"]);
        git_stdout(&racer, &["push", "origin", "main"]);

        let arguments =
            guarded_repair_push_arguments("origin", "main", &observed_head, &repair_head);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();

        assert!(command_stdout(&repair, "git", &arguments).await.is_err());
        assert_eq!(
            git_stdout(
                root.path(),
                &["--git-dir", remote.to_str().unwrap(), "rev-parse", "main",],
            ),
            racer_head
        );
    }

    fn pull_request(marker: &str, head_sha: &str) -> RemotePullRequest {
        RemotePullRequest {
            repository_key: "primary".to_string(),
            repository: Some("example/project".to_string()),
            head_repository: Some("example/project".to_string()),
            author: Some("octocat".to_string()),
            authored_by_authenticated_viewer: true,
            head_branch: "ensemble/issue-420".to_string(),
            base_branch: "main".to_string(),
            head_sha: head_sha.to_string(),
            body: marker.to_string(),
            number: 420,
            url: "https://github.com/example/project/pull/420".to_string(),
        }
    }

    fn observed_repository(facts: DeliveryObservationFacts) -> DeliveryRepository {
        let mut repository = repository(DeliveryPhase::Waiting);
        repository.observed_remote_sha = Some(repository.local_sha.clone());
        repository.pr_number = Some(facts.pull_request_number);
        repository.pr_url = Some(facts.pull_request_url.clone());
        repository.observation = Some(DeliveryObservation::successful(facts, Utc::now()));
        repository
    }

    fn observation_facts() -> DeliveryObservationFacts {
        DeliveryObservationFacts {
            pull_request_node_id: None,
            pull_request_number: 420,
            pull_request_url: "https://github.com/example/project/pull/420".to_string(),
            head_sha: "0123456789abcdef".to_string(),
            matches_delivery: true,
            head_diverged: false,
            terminal_state: PullRequestTerminalState::Open,
            mergeability: Mergeability::Mergeable,
            base_freshness: BaseFreshness::UpToDate,
            checks: vec![],
            check_summary: CheckSummary::Passing,
            review_decision: ReviewDecision::ReviewRequired,
            in_merge_queue: false,
            automatic_merge: None,
            feedback: Default::default(),
        }
    }

    fn delivery_with_observations(observations: Vec<DeliveryObservationFacts>) -> DeliveryRecord {
        let repositories = observations
            .into_iter()
            .enumerate()
            .map(|(index, facts)| (format!("repo-{index}"), observed_repository(facts)))
            .collect();
        DeliveryRecord {
            issue_id: "issue-420".to_string(),
            identifier: "ensemble#420".to_string(),
            run_id: "run-420".to_string(),
            repositories,
            terminal_history: None,
            review_projection: None,
            delivery_states: Default::default(),
            delivery_repair: None,
            repair: None,
            delivery_repair_attempts_used: 0,
            delivery_repair_capacity: None,
            delivery_repair_suppressions: Default::default(),
            success_state: None,
            failure_state: None,
            closed_without_merge_parked: false,
            selected_delivery_state: None,
        }
    }

    #[test]
    fn delivery_state_facts_use_documented_precedence() {
        let mut closed = observation_facts();
        closed.terminal_state = PullRequestTerminalState::ClosedWithoutMerge;
        let mut changes_requested = observation_facts();
        changes_requested.review_decision = ReviewDecision::ChangesRequested;
        let mut failed = observation_facts();
        failed.check_summary = CheckSummary::Failing;
        let mut merged = observation_facts();
        merged.terminal_state = PullRequestTerminalState::Merged;
        let mut approved = observation_facts();
        approved.review_decision = ReviewDecision::Approved;

        assert_eq!(
            delivery_with_observations(vec![closed, changes_requested.clone(), failed.clone()])
                .delivery_state_fact(),
            Some(DeliveryStateFact::ClosedWithoutMerge)
        );
        assert_eq!(
            delivery_with_observations(vec![changes_requested, failed.clone()])
                .delivery_state_fact(),
            Some(DeliveryStateFact::ChangesRequested)
        );
        assert_eq!(
            delivery_with_observations(vec![failed]).delivery_state_fact(),
            Some(DeliveryStateFact::ChecksFailed)
        );
        assert_eq!(
            delivery_with_observations(vec![merged]).delivery_state_fact(),
            Some(DeliveryStateFact::Merged)
        );
        assert_eq!(
            delivery_with_observations(vec![approved]).delivery_state_fact(),
            Some(DeliveryStateFact::Approved)
        );
        let mut merged_with_stale_blocker = observation_facts();
        merged_with_stale_blocker.terminal_state = PullRequestTerminalState::Merged;
        merged_with_stale_blocker.review_decision = ReviewDecision::ChangesRequested;
        let mut still_open_and_approved = observation_facts();
        still_open_and_approved.review_decision = ReviewDecision::Approved;
        assert_eq!(
            delivery_with_observations(vec![merged_with_stale_blocker.clone()])
                .delivery_state_fact(),
            Some(DeliveryStateFact::Merged)
        );
        assert_eq!(
            delivery_with_observations(vec![merged_with_stale_blocker, still_open_and_approved])
                .delivery_state_fact(),
            Some(DeliveryStateFact::Approved)
        );
        assert_eq!(
            delivery_with_observations(vec![observation_facts()]).delivery_state_fact(),
            Some(DeliveryStateFact::Waiting)
        );
    }

    #[test]
    fn delivery_repair_freezes_the_first_matching_head_feedback() {
        let mut facts = observation_facts();
        facts.checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];
        facts = facts.for_delivery("0123456789abcdef");
        let mut delivery = delivery_with_observations(vec![]);
        delivery.delivery_repair = Some(DeliveryRepairConfig {
            agent: "repair".to_string(),
            max_attempts: 2,
        });

        delivery.freeze_actionable_repair("source-repo", &facts);
        let first = delivery.repair.clone().unwrap();

        let mut later = facts.clone();
        later.feedback.change_request_bodies = vec!["later feedback".to_string()];
        delivery.freeze_actionable_repair("source-repo", &later);

        assert_eq!(delivery.repair, Some(first));
    }

    #[test]
    fn delivery_repair_interaction_identity_is_stable_for_one_feedback_head() {
        let mut facts = observation_facts();
        facts.checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];
        let facts = facts.for_delivery("0123456789abcdef");
        let mut delivery = delivery_with_observations(vec![]);
        delivery.delivery_repair = Some(DeliveryRepairConfig {
            agent: "repair".to_string(),
            max_attempts: 2,
        });

        delivery.freeze_actionable_repair("source/repo", &facts);
        let first_id = delivery
            .repair
            .as_ref()
            .and_then(|repair| repair.interaction_id.as_deref());

        let mut restored = delivery_with_observations(vec![]);
        restored.delivery_repair = delivery.delivery_repair.clone();
        restored.freeze_actionable_repair("source/repo", &facts);
        let restored_id = restored
            .repair
            .as_ref()
            .and_then(|repair| repair.interaction_id.as_deref());

        assert_eq!(
            first_id,
            Some("delivery-repair-issue-420-source-repo-420-0123456789abcdef-1")
        );
        assert_eq!(first_id, restored_id);
    }

    #[test]
    fn manual_repair_suppression_is_scoped_to_one_delivery_identity() {
        let mut first_repository = observation_facts();
        first_repository.pull_request_number = 1;
        first_repository.pull_request_url = "https://github.com/example/project/pull/1".to_string();
        first_repository.head_sha = "shared-head".to_string();
        first_repository.checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];
        let first_head = first_repository.clone().for_delivery("shared-head");
        let mut second_repository = first_repository.clone();
        second_repository.pull_request_number = 2;
        second_repository.pull_request_url =
            "https://github.com/example/project/pull/2".to_string();
        second_repository.head_sha = "second-head".to_string();
        let second_head = second_repository.for_delivery("second-head");
        let mut delivery = delivery_with_observations(vec![]);
        delivery.delivery_repair = Some(DeliveryRepairConfig {
            agent: "repair".to_string(),
            max_attempts: 2,
        });
        delivery
            .delivery_repair_suppressions
            .insert(DeliveryRepairIdentity::observed(
                "repository-a",
                &first_head,
            ));

        delivery.freeze_actionable_repair("repository-b", &second_head);
        assert_eq!(
            delivery
                .repair
                .as_ref()
                .map(|repair| repair.attempt.repository_key.as_str()),
            Some("repository-b")
        );
        delivery.repair = None;

        delivery.freeze_actionable_repair("repository-a", &first_head);
        assert!(delivery.repair.is_none());

        first_repository.head_sha = "changed-head".to_string();
        let changed_first_head = first_repository.for_delivery("changed-head");
        delivery.freeze_actionable_repair("repository-a", &changed_first_head);

        assert_eq!(
            delivery
                .repair
                .as_ref()
                .map(|repair| repair.attempt.starting_sha.as_str()),
            Some("changed-head")
        );
    }

    #[test]
    fn legacy_delivery_record_without_capacity_identity_deserializes_as_unavailable() {
        let mut record = delivery_with_observations(vec![]);
        record.delivery_repair_capacity = Some(DeliveryRepairCapacity::State {
            state: "In Progress".to_string(),
        });
        let mut json = serde_json::to_value(record).unwrap();
        json.as_object_mut()
            .unwrap()
            .remove("delivery_repair_capacity");

        let restored = serde_json::from_value::<DeliveryRecord>(json).unwrap();

        assert_eq!(restored.delivery_repair_capacity, None);
    }

    #[test]
    fn manual_repair_suppression_serializes_its_exact_delivery_identity() {
        let mut record = delivery_with_observations(vec![]);
        let suppression = DeliveryRepairIdentity {
            repository_key: "repository-a".to_string(),
            pull_request_number: 42,
            head_sha: "abc123".to_string(),
        };
        record
            .delivery_repair_suppressions
            .insert(suppression.clone());

        let restored =
            serde_json::from_value::<DeliveryRecord>(serde_json::to_value(record).unwrap())
                .unwrap();

        assert!(restored.delivery_repair_suppressions.contains(&suppression));
    }

    #[test]
    fn repair_dispatch_intent_is_idempotent_and_respects_its_cumulative_budget() {
        let mut delivery = delivery_with_observations(vec![]);
        delivery.delivery_repair = Some(DeliveryRepairConfig {
            agent: "repair".to_string(),
            max_attempts: 1,
        });
        let mut facts = observation_facts();
        facts.checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];
        let facts = facts.for_delivery("0123456789abcdef");
        delivery.freeze_actionable_repair("source-repo", &facts);

        assert_eq!(delivery.begin_repair_dispatch(), RepairDispatch::Dispatch);
        assert_eq!(
            delivery.begin_repair_dispatch(),
            RepairDispatch::AlreadyInFlight
        );

        delivery.complete_repair_dispatch_without_commit();
        assert_eq!(delivery.begin_repair_dispatch(), RepairDispatch::Exhausted);
    }

    #[test]
    fn complete_feedback_rejects_incomplete_review_pages_and_excludes_resolved_threads() {
        let incomplete = serde_json::json!({
            "reviews": { "totalCount": 101, "nodes": [] },
            "reviewThreads": { "totalCount": 0, "nodes": [] },
        });
        assert!(complete_feedback(&incomplete).is_err());

        let complete = serde_json::json!({
            "reviews": { "totalCount": 1, "nodes": [{ "state": "CHANGES_REQUESTED", "body": "Please fix" }] },
            "reviewThreads": { "totalCount": 2, "nodes": [
                { "isResolved": true, "isOutdated": false, "comments": { "totalCount": 1, "nodes": [{ "body": "done", "path": "src/lib.rs", "line": 1 }] } },
                { "isResolved": false, "isOutdated": false, "comments": { "totalCount": 1, "nodes": [{ "body": "rename", "path": "src/lib.rs", "line": 7 }] } }
            ] },
        });

        let (feedback, has_unresolved_review_threads) = complete_feedback(&complete).unwrap();

        assert_eq!(feedback.change_request_bodies, vec!["Please fix"]);
        assert_eq!(feedback.unresolved_threads.len(), 1);
        assert_eq!(feedback.unresolved_threads[0].body, "rename");
        assert!(has_unresolved_review_threads);
    }

    #[test]
    fn delivery_observation_query_uses_current_reviews_and_exact_ref_identity() {
        assert!(DELIVERY_OBSERVATION_QUERY.contains("reviews: latestReviews(first: 100)"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("baseRefOid"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("headRefName"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("mergeCommitAllowed"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("squashMergeAllowed"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("rebaseMergeAllowed"));
        assert!(DELIVERY_OBSERVATION_QUERY.contains("isDraft"));
        assert!(!DELIVERY_OBSERVATION_QUERY.contains("comparison("));
    }

    #[test]
    fn repository_merge_method_capability_matches_the_configured_method() {
        let repository = serde_json::json!({
            "mergeCommitAllowed": true,
            "squashMergeAllowed": false,
            "rebaseMergeAllowed": true
        });

        assert_eq!(
            repository_merge_method_supported(&repository, Some(DeliveryMergeMethod::Merge)),
            Some(true)
        );
        assert_eq!(
            repository_merge_method_supported(&repository, Some(DeliveryMergeMethod::Squash)),
            Some(false)
        );
        assert_eq!(
            repository_merge_method_supported(&repository, Some(DeliveryMergeMethod::Rebase)),
            Some(true)
        );
        assert_eq!(
            repository_merge_method_supported(&repository, None),
            Some(true)
        );
        assert_eq!(
            repository_merge_method_supported(
                &serde_json::json!({}),
                Some(DeliveryMergeMethod::Squash)
            ),
            None
        );
    }

    #[test]
    fn draft_pull_requests_cannot_collect_automatic_merge_evidence() {
        assert!(!automatic_merge_policy_needed(true, true));
        assert!(automatic_merge_policy_needed(true, false));
        assert!(!automatic_merge_policy_needed(false, false));
    }

    #[test]
    fn complete_feedback_ignores_empty_change_request_summaries() {
        let observation = serde_json::json!({
            "reviews": { "totalCount": 1, "nodes": [{ "state": "CHANGES_REQUESTED", "body": "  " }] },
            "reviewThreads": { "totalCount": 1, "nodes": [
                { "isResolved": false, "isOutdated": false, "comments": { "totalCount": 1, "nodes": [{ "body": "inline feedback", "path": "src/lib.rs", "line": 7 }] } }
            ] },
        });

        let (feedback, has_unresolved_review_threads) = complete_feedback(&observation).unwrap();

        assert!(feedback.change_request_bodies.is_empty());
        assert_eq!(feedback.unresolved_threads.len(), 1);
        assert_eq!(feedback.unresolved_threads[0].body, "inline feedback");
        assert!(has_unresolved_review_threads);
    }

    #[test]
    fn complete_feedback_keeps_outdated_unresolved_threads_in_merge_authority() {
        let observation = serde_json::json!({
            "reviews": { "totalCount": 0, "nodes": [] },
            "reviewThreads": { "totalCount": 1, "nodes": [
                { "isResolved": false, "isOutdated": true, "comments": { "totalCount": 1, "nodes": [{ "body": "old feedback", "path": "src/lib.rs", "line": 7 }] } }
            ] },
        });

        let (feedback, has_unresolved_review_threads) = complete_feedback(&observation).unwrap();

        assert!(feedback.unresolved_threads.is_empty());
        assert!(has_unresolved_review_threads);
    }

    #[test]
    fn github_rest_paths_percent_encode_branch_segments() {
        assert_eq!(github_path_segment("release/2026"), "release%2F2026");
        assert_eq!(github_path_segment("feature #1"), "feature%20%231");
        assert_eq!(github_path_segment("main"), "main");
    }

    #[test]
    fn stale_or_incomplete_observations_select_waiting() {
        let mut record = delivery_with_observations(vec![observation_facts()]);
        record.repositories.get_mut("repo-0").unwrap().observation = None;

        assert_eq!(
            record.delivery_state_fact(),
            Some(DeliveryStateFact::Waiting)
        );
    }

    #[test]
    fn selected_delivery_fact_and_target_round_trip_durably() {
        let mut record = delivery_with_observations(vec![observation_facts()]);
        record.selected_delivery_state = Some(DeliveryStateProjection {
            schema_version: 1,
            fact: DeliveryStateFact::Waiting,
            target: "In review".to_string(),
        });

        let restored =
            serde_json::from_str::<DeliveryRecord>(&serde_json::to_string(&record).unwrap())
                .unwrap();
        assert_eq!(
            restored.selected_delivery_state,
            record.selected_delivery_state
        );
    }

    #[test]
    fn terminal_recovery_uses_frozen_success_state_after_config_drift() {
        let mut record = delivery_with_observations(vec![observation_facts()]);
        record.success_state = Some("Frozen done".to_string());

        assert_eq!(
            terminal_delivery_outcome(
                &record,
                "Frozen done",
                Some("Reloaded done"),
                Some("Reloaded failed"),
            ),
            (TerminalOutcome::Succeeded, HISTORY_OUTCOME_SUCCEEDED)
        );
    }

    #[test]
    fn terminal_recovery_uses_frozen_failure_state_after_config_drift() {
        let mut record = delivery_with_observations(vec![observation_facts()]);
        record.success_state = Some("Frozen done".to_string());
        record.failure_state = Some("Frozen failed".to_string());

        assert_eq!(
            terminal_delivery_outcome(
                &record,
                "Frozen failed",
                Some("Reloaded done"),
                Some("Reloaded failed"),
            ),
            (TerminalOutcome::Failed, HISTORY_OUTCOME_FAILED)
        );
    }

    #[test]
    fn merged_terminal_handoff_waits_for_an_in_flight_projection() {
        let mut record = delivery_with_observations(vec![observation_facts()]);
        record.review_projection = Some(ReviewProjection {
            target: "In review".to_string(),
            repositories: vec!["repo-0".to_string()],
            phase: ReviewProjectionPhase::InFlight,
            diagnostic: None,
            last_observed_state: None,
            history_record: None,
            history_persisted: false,
        });

        assert!(record.has_in_flight_review_projection());
    }

    #[test]
    fn closed_without_merge_attention_is_idempotent_across_restart() {
        let record = delivery_with_observations(vec![observation_facts()]);

        let first = closed_without_merge_attention(&record).unwrap();
        let restored =
            serde_json::from_str::<DeliveryRecord>(&serde_json::to_string(&record).unwrap())
                .unwrap();
        let second = closed_without_merge_attention(&restored).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.identity.kind, "runtime.delivery.closed_without_merge");
    }

    #[test]
    fn closed_without_merge_attention_can_be_resolved_after_recovery() {
        let record = delivery_with_observations(vec![observation_facts()]);
        let open = closed_without_merge_attention(&record).unwrap();
        let close = closed_without_merge_attention_close(&record).unwrap();

        assert_eq!(close.identity, open.identity);
        assert_eq!(close.expected_fingerprint, open.evidence.fingerprint);
    }

    #[test]
    fn legacy_status_contexts_contribute_to_the_complete_check_summary() {
        let success = serde_json::json!({"context": "ci", "state": "SUCCESS"});
        let failure = serde_json::json!({"context": "lint", "state": "FAILURE"});

        let checks = vec![
            parse_check(&success).unwrap(),
            parse_check(&failure).unwrap(),
        ];

        assert_eq!(
            crate::orchestrator::delivery_observation::CheckSummary::from_checks(&checks),
            crate::orchestrator::delivery_observation::CheckSummary::Failing
        );
    }

    #[test]
    fn expected_legacy_status_context_stays_pending() {
        let expected = parse_check(&serde_json::json!({
            "context": "ci",
            "state": "EXPECTED"
        }))
        .unwrap();

        assert_eq!(expected.status, CheckStatus::Pending);
        assert_eq!(expected.conclusion, None);
    }

    #[test]
    fn incomplete_check_rollups_are_rejected_instead_of_published_as_passing() {
        let rollup = serde_json::json!({
            "statusCheckRollup": {"contexts": {"totalCount": 101, "nodes": []}}
        });

        assert!(complete_checks(&rollup).is_err());
    }

    #[test]
    fn delivery_record_derives_aggregate_without_serializing_it() {
        let mut repositories = BTreeMap::new();
        repositories.insert("zeta".to_string(), repository(DeliveryPhase::Published));
        repositories.insert("alpha".to_string(), repository(DeliveryPhase::Waiting));
        let record = DeliveryRecord {
            issue_id: "issue-420".to_string(),
            identifier: "ensemble#420".to_string(),
            run_id: "run-420".to_string(),
            repositories,
            terminal_history: None,
            review_projection: None,
            delivery_states: Default::default(),
            delivery_repair: None,
            repair: None,
            delivery_repair_attempts_used: 0,
            delivery_repair_capacity: None,
            delivery_repair_suppressions: Default::default(),
            success_state: None,
            failure_state: None,
            closed_without_merge_parked: false,
            selected_delivery_state: None,
        };

        assert_eq!(record.aggregate(), DeliveryAggregate::Waiting);
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.find("alpha").unwrap() < json.find("zeta").unwrap());
        assert!(!json.contains("aggregate"));
    }

    #[test]
    fn review_projection_requires_durable_waiting_pr_identity() {
        let mut repository = repository(DeliveryPhase::Waiting);
        repository.observed_remote_sha = Some(repository.local_sha.clone());
        repository.pr_number = Some(420);
        repository.pr_url = Some("https://github.com/example/project/pull/420".into());
        let record = DeliveryRecord {
            issue_id: "issue-420".into(),
            identifier: "ensemble#420".into(),
            run_id: "run-420".into(),
            repositories: BTreeMap::from([("primary".into(), repository)]),
            terminal_history: None,
            review_projection: Some(ReviewProjection {
                target: "In review".into(),
                repositories: vec!["primary".into()],
                phase: ReviewProjectionPhase::Pending,
                diagnostic: None,
                last_observed_state: None,
                history_record: None,
                history_persisted: false,
            }),
            delivery_states: Default::default(),
            delivery_repair: None,
            repair: None,
            delivery_repair_attempts_used: 0,
            delivery_repair_capacity: None,
            delivery_repair_suppressions: Default::default(),
            success_state: None,
            failure_state: None,
            closed_without_merge_parked: false,
            selected_delivery_state: None,
        };

        assert!(record.review_ready());
    }

    #[test]
    fn review_projection_waits_for_every_configured_pr_repository() {
        let mut repository = repository(DeliveryPhase::Waiting);
        repository.observed_remote_sha = Some(repository.local_sha.clone());
        repository.pr_number = Some(420);
        repository.pr_url = Some("https://github.com/example/project/pull/420".into());
        let record = DeliveryRecord {
            issue_id: "issue-420".into(),
            identifier: "ensemble#420".into(),
            run_id: "run-420".into(),
            repositories: BTreeMap::from([("primary".into(), repository)]),
            terminal_history: None,
            review_projection: Some(ReviewProjection {
                target: "In review".into(),
                repositories: vec!["primary".into(), "approval-gated".into()],
                phase: ReviewProjectionPhase::Pending,
                diagnostic: None,
                last_observed_state: None,
                history_record: None,
                history_persisted: false,
            }),
            delivery_states: Default::default(),
            delivery_repair: None,
            repair: None,
            delivery_repair_attempts_used: 0,
            delivery_repair_capacity: None,
            delivery_repair_suppressions: Default::default(),
            success_state: None,
            failure_state: None,
            closed_without_merge_parked: false,
            selected_delivery_state: None,
        };

        assert!(!record.review_ready());
    }

    #[test]
    fn review_projection_waits_for_configured_push_repositories() {
        let mut pull_request = repository(DeliveryPhase::Waiting);
        pull_request.observed_remote_sha = Some(pull_request.local_sha.clone());
        pull_request.pr_number = Some(420);
        pull_request.pr_url = Some("https://github.com/example/project/pull/420".into());
        let push = DeliveryRepository {
            mode: DeliveryMode::Push,
            phase: DeliveryPhase::Prepared,
            ..pull_request.clone()
        };
        let record = DeliveryRecord {
            issue_id: "issue-420".into(),
            identifier: "ensemble#420".into(),
            run_id: "run-420".into(),
            repositories: BTreeMap::from([
                ("pull-request".into(), pull_request),
                ("push".into(), push),
            ]),
            terminal_history: None,
            review_projection: Some(ReviewProjection {
                target: "In review".into(),
                repositories: vec!["pull-request".into(), "push".into()],
                phase: ReviewProjectionPhase::Pending,
                diagnostic: None,
                last_observed_state: None,
                history_record: None,
                history_persisted: false,
            }),
            delivery_states: Default::default(),
            delivery_repair: None,
            repair: None,
            delivery_repair_attempts_used: 0,
            delivery_repair_capacity: None,
            delivery_repair_suppressions: Default::default(),
            success_state: None,
            failure_state: None,
            closed_without_merge_parked: false,
            selected_delivery_state: None,
        };

        assert!(!record.review_ready());
    }

    #[test]
    fn push_reconciliation_blocks_a_divergent_remote() {
        let repo = repository(DeliveryPhase::ReconcilingPush);

        assert_eq!(
            reconcile_push(&repo, Some("fedcba9876543210".to_string())),
            PushReconciliation::Blocked {
                error: "remote head is fedcba9876543210, expected 0123456789abcdef".to_string(),
            }
        );
    }

    #[test]
    fn pr_reconciliation_requires_one_exact_identity_at_the_intended_sha() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());
        let exact = pull_request(&repo.marker, &repo.local_sha);

        assert_eq!(
            reconcile_pull_requests("primary", &repo, std::slice::from_ref(&exact), None),
            PullRequestReconciliation::Adopted {
                number: exact.number,
                url: exact.url.clone(),
            }
        );

        let wrong_head = pull_request(&repo.marker, "aaaaaaaaaaaaaaaa");
        assert!(matches!(
            reconcile_pull_requests("primary", &repo, &[wrong_head], None),
            PullRequestReconciliation::Conflict {
                conflict: OwnershipConflict::Foreign,
                ..
            }
        ));
        assert!(matches!(
            reconcile_pull_requests("primary", &repo, &[exact.clone(), exact], None),
            PullRequestReconciliation::Conflict {
                conflict: OwnershipConflict::Ambiguous,
                ..
            }
        ));
    }

    #[test]
    fn zero_pr_matches_after_confirmed_push_allows_one_create_retry() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());

        assert_eq!(
            reconcile_pull_requests("primary", &repo, &[], None),
            PullRequestReconciliation::Create
        );
    }

    fn adoption_policy() -> PullRequestAdoptionPolicy {
        PullRequestAdoptionPolicy {
            repository: "example/project".to_string(),
            base_branch: "main".to_string(),
            head_branch: "ensemble/issue-420".to_string(),
            require_authenticated_author: true,
        }
    }

    #[test]
    fn marker_identity_precedes_an_exact_unpersisted_fallback() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());
        let marked = pull_request(&repo.marker, &repo.local_sha);
        let mut unmarked = pull_request("", &repo.local_sha);
        unmarked.number = 421;
        unmarked.url = "https://github.com/example/project/pull/421".to_string();

        assert_eq!(
            reconcile_pull_requests(
                "primary",
                &repo,
                &[unmarked, marked.clone()],
                Some(&adoption_policy()),
            ),
            PullRequestReconciliation::Adopted {
                number: marked.number,
                url: marked.url,
            }
        );
    }

    #[test]
    fn one_exact_configured_unpersisted_pull_request_is_adopted() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());
        let exact = pull_request("", &repo.local_sha);

        assert_eq!(
            reconcile_pull_requests(
                "primary",
                &repo,
                std::slice::from_ref(&exact),
                Some(&adoption_policy()),
            ),
            PullRequestReconciliation::Adopted {
                number: exact.number,
                url: exact.url.clone(),
            }
        );
    }

    #[test]
    fn configured_fallback_blocks_foreign_or_ambiguous_pull_requests() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());
        let exact = pull_request("", &repo.local_sha);
        let mut foreign_author = exact.clone();
        foreign_author.authored_by_authenticated_viewer = false;
        let mut fork = exact.clone();
        fork.head_repository = Some("contributor/fork".to_string());

        for candidates in [vec![foreign_author], vec![fork]] {
            assert!(matches!(
                reconcile_pull_requests("primary", &repo, &candidates, Some(&adoption_policy()),),
                PullRequestReconciliation::Conflict {
                    conflict: OwnershipConflict::Foreign,
                    ..
                }
            ));
        }
        assert!(matches!(
            reconcile_pull_requests(
                "primary",
                &repo,
                &[exact.clone(), exact],
                Some(&adoption_policy()),
            ),
            PullRequestReconciliation::Conflict {
                conflict: OwnershipConflict::Ambiguous,
                ..
            }
        ));
    }

    #[test]
    fn post_finalize_acceptance_projects_only_retained_delivery_identity() {
        let rule = crate::config::ensemble::AcceptancePullRequestConfig {
            name: "primary-pr".into(),
            repo: "primary".into(),
        };
        let mut repo = repository(DeliveryPhase::Waiting);
        repo.pr_number = Some(420);
        repo.pr_url = Some("https://github.com/example/project/pull/420".into());

        let passed = evaluate_pull_request_requirement(&rule, &repo);
        repo.pr_url = None;
        let failed = evaluate_pull_request_requirement(&rule, &repo);

        assert_eq!(passed.status, crate::acceptance::AcceptanceStatus::Passed);
        assert_eq!(failed.status, crate::acceptance::AcceptanceStatus::Failed);
        assert!(matches!(
            passed.evidence,
            crate::acceptance::AcceptanceEvidence::PullRequest {
                pr_number: Some(420),
                ref pr_url,
                ..
            } if pr_url.as_deref() == Some("https://github.com/example/project/pull/420")
        ));
        assert!(failed.summary.contains("URL"));
    }

    #[test]
    fn automatic_merge_policy_matches_required_check_integration_and_reviews() {
        let rules = serde_json::json!([
            {
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": false,
                    "required_status_checks": [
                        {"context": "test", "integration_id": 15368}
                    ]
                }
            },
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 1,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": false,
                    "require_last_push_approval": false,
                    "allowed_merge_methods": ["merge", "squash", "rebase"]
                }
            }
        ]);
        let checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: Some(15368),
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Success),
        }];
        let evidence = automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .unwrap();
        assert!(evidence.is_eligible_for_direct_merge());
        assert!(evidence.is_eligible_for_queue());

        let wrong_integration = [DeliveryCheck {
            integration_id: Some(1),
            ..checks[0].clone()
        }];
        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &wrong_integration,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::ChangesRequested,
                has_requested_changes: true,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .unwrap()
        .is_eligible_for_direct_merge());

        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Unknown,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        let unsupported = serde_json::json!([{"type": "required_deployments"}]);
        assert!(automatic_merge_evidence_from_policy(
            &unsupported,
            None,
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .is_none());
    }

    #[test]
    fn automatic_merge_policy_needs_a_review_decision_only_when_reviews_are_required() {
        let evidence = automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            None,
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Unknown,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(evidence.is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_requires_approval_for_independent_review_rules() {
        let rules = [
            serde_json::json!([{
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": true,
                    "require_last_push_approval": false,
                    "allowed_merge_methods": ["merge", "squash", "rebase"]
                }
            }]),
            serde_json::json!([{
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": false,
                    "require_last_push_approval": true,
                    "allowed_merge_methods": ["merge", "squash", "rebase"]
                }
            }]),
        ];
        for rules in rules {
            let evidence = automatic_merge_evidence_from_policy(
                &rules,
                None,
                AutomaticMergeStatus {
                    checks: &[],
                    review_decision: ReviewDecision::Unknown,
                    has_requested_changes: false,
                    has_unresolved_review_threads: false,
                    base_freshness: BaseFreshness::UpToDate,
                    direct_merge_method: Some(DeliveryMergeMethod::Squash),
                    repository_merge_method_supported: Some(true),
                    queue_supported: false,
                    queued: false,
                },
            )
            .unwrap();

            assert!(!evidence.is_eligible_for_direct_merge());
        }

        let classic = serde_json::json!({
            "required_status_checks": null,
            "required_pull_request_reviews": {
                "required_approving_review_count": 0,
                "require_code_owner_reviews": true,
                "require_last_push_approval": false
            },
            "required_conversation_resolution": null
        });
        let evidence = automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&classic),
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Unknown,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(!evidence.is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_requires_configured_method_to_be_allowed() {
        let rules = serde_json::json!([{
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 0,
                "required_review_thread_resolution": false,
                "require_code_owner_review": false,
                "require_last_push_approval": false,
                "allowed_merge_methods": ["rebase"]
            }
        }]);
        let status = |method, repository_merge_method_supported| AutomaticMergeStatus {
            checks: &[],
            review_decision: ReviewDecision::Unknown,
            has_requested_changes: false,
            has_unresolved_review_threads: false,
            base_freshness: BaseFreshness::UpToDate,
            direct_merge_method: Some(method),
            repository_merge_method_supported,
            queue_supported: false,
            queued: false,
        };

        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            None,
            status(DeliveryMergeMethod::Squash, Some(true)),
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        assert!(automatic_merge_evidence_from_policy(
            &rules,
            None,
            status(DeliveryMergeMethod::Rebase, Some(true)),
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            None,
            status(DeliveryMergeMethod::Rebase, Some(false)),
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        assert!(automatic_merge_evidence_from_policy(
            &rules,
            None,
            status(DeliveryMergeMethod::Rebase, None),
        )
        .is_none());

        for malformed in [
            serde_json::json!([{
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": false,
                    "require_last_push_approval": false
                }
            }]),
            serde_json::json!([{
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": false,
                    "require_last_push_approval": false,
                    "allowed_merge_methods": ["unknown"]
                }
            }]),
        ] {
            assert!(automatic_merge_evidence_from_policy(
                &malformed,
                None,
                status(DeliveryMergeMethod::Squash, Some(true)),
            )
            .is_none());
        }
    }

    #[test]
    fn automatic_merge_policy_accepts_successful_required_check_conclusions() {
        let rules = serde_json::json!([{
            "type": "required_status_checks",
            "parameters": {
                "strict_required_status_checks_policy": false,
                "required_status_checks": [{"context": "test"}]
            }
        }]);

        for conclusion in [CheckConclusion::Neutral, CheckConclusion::Skipped] {
            let checks = [DeliveryCheck {
                name: "test".to_string(),
                integration_id: None,
                status: CheckStatus::Completed,
                conclusion: Some(conclusion),
            }];
            let evidence = automatic_merge_evidence_from_policy(
                &rules,
                None,
                AutomaticMergeStatus {
                    checks: &checks,
                    review_decision: ReviewDecision::Unknown,
                    has_requested_changes: false,
                    has_unresolved_review_threads: false,
                    base_freshness: BaseFreshness::UpToDate,
                    direct_merge_method: Some(DeliveryMergeMethod::Squash),
                    repository_merge_method_supported: Some(true),
                    queue_supported: false,
                    queued: false,
                },
            )
            .unwrap();

            assert!(evidence.is_eligible_for_direct_merge(), "{conclusion:?}");
        }
    }

    #[test]
    fn automatic_merge_policy_fails_closed_when_strict_freshness_is_not_proven() {
        let rules = serde_json::json!([{
            "type": "required_status_checks",
            "parameters": {
                "strict_required_status_checks_policy": true,
                "required_status_checks": []
            }
        }]);

        let evidence = automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::Behind,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(!evidence.is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_fails_closed_when_thread_resolution_is_not_proven() {
        let rules = serde_json::json!([{
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 0,
                "required_review_thread_resolution": true,
                "require_code_owner_review": false,
                "require_last_push_approval": false,
                "allowed_merge_methods": ["merge", "squash", "rebase"]
            }
        }]);

        let evidence = automatic_merge_evidence_from_policy(
            &rules,
            None,
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: true,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(!evidence.is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_combines_paginated_rules_and_classic_protection() {
        let rules = serde_json::json!([
            [{
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": false,
                    "required_status_checks": [
                        {"context": "ruleset", "integration_id": 1}
                    ]
                }
            }],
            [{
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 1,
                    "required_review_thread_resolution": false,
                    "require_code_owner_review": false,
                    "require_last_push_approval": false,
                    "allowed_merge_methods": ["merge", "squash", "rebase"]
                }
            }]
        ]);
        let protection = serde_json::json!({
            "required_status_checks": {
                "strict": true,
                "contexts": ["classic"],
                "checks": [{"context": "classic", "app_id": 2}]
            },
            "required_pull_request_reviews": {
                "required_approving_review_count": 2,
                "require_code_owner_reviews": false,
                "require_last_push_approval": false
            },
            "required_conversation_resolution": {"enabled": true}
        });
        let checks = vec![
            DeliveryCheck {
                name: "ruleset".to_string(),
                integration_id: Some(1),
                status: CheckStatus::Completed,
                conclusion: Some(CheckConclusion::Success),
            },
            DeliveryCheck {
                name: "classic".to_string(),
                integration_id: Some(2),
                status: CheckStatus::Completed,
                conclusion: Some(CheckConclusion::Success),
            },
        ];

        let evidence = automatic_merge_evidence_from_policy(
            &rules,
            Some(&protection),
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(evidence.is_eligible_for_direct_merge());
        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            Some(&protection),
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::Behind,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap()
        .is_eligible_for_direct_merge());
        assert!(!automatic_merge_evidence_from_policy(
            &rules,
            Some(&protection),
            AutomaticMergeStatus {
                checks: &checks,
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: true,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap()
        .is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_rejects_malformed_classic_check_identity() {
        let malformed_checks = serde_json::json!({
            "required_status_checks": {
                "strict": false,
                "contexts": ["test"],
                "checks": "not-an-array"
            },
            "required_pull_request_reviews": null,
            "required_conversation_resolution": null
        });
        let missing_app_identity = serde_json::json!({
            "required_status_checks": {
                "strict": false,
                "contexts": ["test"],
                "checks": [{"context": "test"}]
            },
            "required_pull_request_reviews": null,
            "required_conversation_resolution": null
        });
        let status = || AutomaticMergeStatus {
            checks: &[],
            review_decision: ReviewDecision::Approved,
            has_requested_changes: false,
            has_unresolved_review_threads: false,
            base_freshness: BaseFreshness::UpToDate,
            direct_merge_method: Some(DeliveryMergeMethod::Squash),
            repository_merge_method_supported: Some(true),
            queue_supported: false,
            queued: false,
        };

        assert!(automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&malformed_checks),
            status(),
        )
        .is_none());
        assert!(automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&missing_app_identity),
            status(),
        )
        .is_none());
        assert!(automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&serde_json::json!([])),
            status(),
        )
        .is_none());
        assert!(automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&serde_json::json!({})),
            status(),
        )
        .is_none());
    }

    #[test]
    fn automatic_merge_policy_requires_every_classic_check_representation() {
        let protection = serde_json::json!({
            "required_status_checks": {
                "strict": false,
                "contexts": ["legacy"],
                "checks": []
            },
            "required_pull_request_reviews": null,
            "required_conversation_resolution": null
        });

        let evidence = automatic_merge_evidence_from_policy(
            &serde_json::json!([]),
            Some(&protection),
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::UpToDate,
                direct_merge_method: Some(DeliveryMergeMethod::Squash),
                repository_merge_method_supported: Some(true),
                queue_supported: false,
                queued: false,
            },
        )
        .unwrap();

        assert!(!evidence.is_eligible_for_direct_merge());
    }

    #[test]
    fn automatic_merge_policy_routes_merge_queue_rules_to_queue_admission() {
        let evidence = automatic_merge_evidence_from_policy(
            &serde_json::json!([[
                {
                    "type": "required_status_checks",
                    "parameters": {
                        "strict_required_status_checks_policy": true,
                        "required_status_checks": []
                    }
                },
                {"type": "merge_queue", "parameters": {}}
            ]]),
            None,
            AutomaticMergeStatus {
                checks: &[],
                review_decision: ReviewDecision::Approved,
                has_requested_changes: false,
                has_unresolved_review_threads: false,
                base_freshness: BaseFreshness::Behind,
                direct_merge_method: None,
                repository_merge_method_supported: Some(true),
                queue_supported: true,
                queued: false,
            },
        )
        .unwrap();

        assert!(!evidence.is_eligible_for_direct_merge());
        assert!(evidence.is_eligible_for_queue());
    }

    #[test]
    fn absent_classic_protection_requires_the_exact_github_response() {
        assert!(is_unprotected_branch_response(
            r#"{"message":"Branch not protected","status":"404"}"#
        ));
        assert!(!is_unprotected_branch_response(
            r#"{"message":"Not Found","status":"404"}"#
        ));
        assert!(!is_unprotected_branch_response("not-json"));
    }

    #[test]
    fn delivery_observation_sends_string_variables_without_type_coercion() {
        let arguments = delivery_observation_arguments("owner", "repo", 42, "123");

        assert!(arguments.windows(2).any(|pair| pair == ["-f", "base=123"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-f", "owner=owner"]));
        assert!(arguments.windows(2).any(|pair| pair == ["-f", "name=repo"]));
        assert!(arguments.windows(2).any(|pair| pair == ["-F", "number=42"]));
    }

    #[test]
    fn repository_rules_request_all_pages_as_one_json_value() {
        assert_eq!(
            repository_rules_arguments("repos/owner/repo/rules/branches/main"),
            [
                "api",
                "--paginate",
                "--slurp",
                "repos/owner/repo/rules/branches/main"
            ]
        );
    }

    #[test]
    fn automatic_merge_selection_does_not_starve_the_next_repository() {
        let mut merged = repository(DeliveryPhase::Waiting);
        merged.merge = DeliveryMergeConfig::Auto {
            method: DeliveryMergeMethod::Squash,
        };
        merged.pr_number = Some(1);
        merged.pr_url = Some("https://example.test/pr/1".to_string());
        let mut merged_facts = observation_facts().for_delivery(&merged.local_sha);
        merged_facts.terminal_state = PullRequestTerminalState::Merged;
        merged.observation = Some(DeliveryObservation::successful(merged_facts, Utc::now()));

        let mut waiting = repository(DeliveryPhase::Waiting);
        waiting.merge = DeliveryMergeConfig::Auto {
            method: DeliveryMergeMethod::Squash,
        };
        waiting.pr_number = Some(2);
        waiting.pr_url = Some("https://example.test/pr/2".to_string());

        let repositories = BTreeMap::from([
            ("a-completed".to_string(), merged),
            ("b-waiting".to_string(), waiting.clone()),
        ]);
        assert_eq!(
            automatic_merge_candidate_key(&repositories).as_deref(),
            Some("b-waiting")
        );

        for phase in [DeliveryMergePhase::Queued, DeliveryMergePhase::Blocked] {
            let mut completed = repository(DeliveryPhase::Waiting);
            completed.merge = DeliveryMergeConfig::Auto {
                method: DeliveryMergeMethod::Squash,
            };
            completed.pr_number = Some(1);
            completed.pr_url = Some("https://example.test/pr/1".to_string());
            let operation = match phase {
                DeliveryMergePhase::Queued => DeliveryMergeOperation::Queue,
                DeliveryMergePhase::Blocked => DeliveryMergeOperation::Direct {
                    method: DeliveryMergeMethod::Squash,
                },
                _ => unreachable!(),
            };
            completed.merge_mutation = Some(DeliveryMergeMutation {
                pull_request_node_id: "PR_node".to_string(),
                expected_head_sha: completed.local_sha.clone(),
                operation,
                phase,
                last_error: None,
            });

            let repositories = BTreeMap::from([
                ("a-completed".to_string(), completed),
                ("b-waiting".to_string(), waiting.clone()),
            ]);
            assert_eq!(
                automatic_merge_candidate_key(&repositories).as_deref(),
                Some("b-waiting")
            );
        }

        for phase in [
            DeliveryMergePhase::InFlight,
            DeliveryMergePhase::Reconciling,
        ] {
            let mut active = repository(DeliveryPhase::Waiting);
            active.merge = DeliveryMergeConfig::Auto {
                method: DeliveryMergeMethod::Squash,
            };
            active.pr_number = Some(1);
            active.pr_url = Some("https://example.test/pr/1".to_string());
            active.merge_mutation = Some(DeliveryMergeMutation {
                pull_request_node_id: "PR_node".to_string(),
                expected_head_sha: active.local_sha.clone(),
                operation: DeliveryMergeOperation::Direct {
                    method: DeliveryMergeMethod::Squash,
                },
                phase,
                last_error: None,
            });

            let repositories = BTreeMap::from([
                ("a-active".to_string(), active),
                ("b-waiting".to_string(), waiting.clone()),
            ]);
            assert_eq!(
                automatic_merge_candidate_key(&repositories).as_deref(),
                Some("a-active")
            );
        }
    }
}
