use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

const OBSERVATION_SCHEMA_VERSION: u8 = 2;
const MAX_DIAGNOSTIC_LENGTH: usize = 256;

/// A versioned, read-only observation of a durable pull-request delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct DeliveryObservation {
    pub schema_version: u8,
    pub freshness: ObservationFreshness,
    pub observed_at: Option<DateTime<Utc>>,
    pub last_attempt_at: DateTime<Utc>,
    pub retry: Option<DeliveryObservationRetry>,
    pub failure: Option<DeliveryObservationFailure>,
    pub facts: Option<DeliveryObservationFacts>,
}

#[derive(Deserialize)]
struct DeliveryObservationWire {
    schema_version: u8,
    freshness: ObservationFreshness,
    observed_at: Option<DateTime<Utc>>,
    last_attempt_at: DateTime<Utc>,
    retry: Option<DeliveryObservationRetry>,
    failure: Option<DeliveryObservationFailure>,
    facts: Option<DeliveryObservationFacts>,
}

impl<'de> Deserialize<'de> for DeliveryObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DeliveryObservationWire::deserialize(deserializer)?;
        if wire.schema_version != 1 && wire.schema_version != OBSERVATION_SCHEMA_VERSION {
            return Err(serde::de::Error::custom(format!(
                "unsupported delivery observation schema version {}",
                wire.schema_version
            )));
        }
        Ok(Self {
            schema_version: wire.schema_version,
            freshness: wire.freshness,
            observed_at: wire.observed_at,
            last_attempt_at: wire.last_attempt_at,
            retry: wire.retry,
            failure: wire.failure,
            facts: wire.facts,
        })
    }
}

impl DeliveryObservation {
    pub(crate) fn successful(facts: DeliveryObservationFacts, now: DateTime<Utc>) -> Self {
        Self {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            freshness: ObservationFreshness::Fresh,
            observed_at: Some(now),
            last_attempt_at: now,
            retry: None,
            failure: None,
            facts: Some(facts),
        }
    }

    pub(crate) fn failed(
        previous: Option<&Self>,
        failure: DeliveryObservationFailure,
        retry: Option<DeliveryObservationRetry>,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            freshness: ObservationFreshness::Stale,
            observed_at: previous.and_then(|observation| observation.observed_at),
            last_attempt_at: now,
            retry,
            failure: Some(failure),
            facts: previous.and_then(|observation| observation.facts.clone()),
        }
    }

    pub(crate) fn is_due(&self, now: DateTime<Utc>) -> bool {
        self.retry.as_ref().is_none_or(|retry| retry.due_at <= now)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationFreshness {
    Fresh,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryObservationRetry {
    pub attempt: u32,
    pub due_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryObservationFailure {
    pub kind: DeliveryObservationFailureKind,
    pub message: String,
}

impl DeliveryObservationFailure {
    pub(crate) fn new(kind: DeliveryObservationFailureKind, message: &str) -> Self {
        let mut message = message
            .chars()
            .filter(|character| !character.is_control())
            .take(MAX_DIAGNOSTIC_LENGTH)
            .collect::<String>();
        if message.is_empty() {
            message = "delivery observation failed".to_string();
        }
        Self { kind, message }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryObservationFailureKind {
    Transport,
    Authentication,
    Authorization,
    MalformedResponse,
    UnsupportedResponse,
    InvalidIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryObservationFacts {
    /// Stable GraphQL identity required by GitHub merge mutations. Legacy observations omit it.
    #[serde(default)]
    pub pull_request_node_id: Option<String>,
    pub pull_request_number: u64,
    pub pull_request_url: String,
    pub head_sha: String,
    pub matches_delivery: bool,
    pub head_diverged: bool,
    pub terminal_state: PullRequestTerminalState,
    pub mergeability: Mergeability,
    pub base_freshness: BaseFreshness,
    pub checks: Vec<DeliveryCheck>,
    pub check_summary: CheckSummary,
    pub review_decision: ReviewDecision,
    /// Authoritative queue membership, independent of branch-policy eligibility evidence.
    #[serde(default)]
    pub in_merge_queue: bool,
    /// Complete GitHub policy evidence required only for automatic merge modes.
    #[serde(default)]
    pub automatic_merge: Option<AutomaticMergeEvidence>,
    /// Complete head-associated feedback retained for a possible delivery repair.
    #[serde(default)]
    pub feedback: DeliveryFeedback,
}

/// Fresh, effective branch-policy evidence for an automatic delivery mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AutomaticMergeEvidence {
    pub required_checks_passing: bool,
    pub required_reviews_satisfied: bool,
    /// Missing legacy evidence fails closed.
    #[serde(default)]
    pub required_review_threads_resolved: bool,
    /// Missing legacy evidence fails closed.
    #[serde(default)]
    pub strict_base_satisfied: bool,
    pub no_requested_changes: bool,
    pub queue_supported: bool,
    pub queued: bool,
}

impl AutomaticMergeEvidence {
    pub(crate) fn is_eligible_for_direct_merge(&self) -> bool {
        self.required_checks_passing
            && self.required_reviews_satisfied
            && self.required_review_threads_resolved
            && self.strict_base_satisfied
            && self.no_requested_changes
    }

    pub(crate) fn is_eligible_for_queue(&self) -> bool {
        self.is_eligible_for_direct_merge() && self.queue_supported && !self.queued
    }
}

/// Bounded review evidence read with a pull-request observation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryFeedback {
    /// Bodies of submitted change requests for this pull request.
    pub change_request_bodies: Vec<String>,
    /// Unresolved, non-outdated inline review threads.
    pub unresolved_threads: Vec<DeliveryFeedbackThread>,
}

/// A single actionable inline discussion, represented by its latest visible comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryFeedbackThread {
    pub path: Option<String>,
    pub line: Option<u64>,
    pub body: String,
}

/// Frozen evidence that may safely be given to a delivery-repair agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ActionableDeliveryFeedback {
    pub terminal_failed_checks: Vec<String>,
    pub change_request_bodies: Vec<String>,
    pub unresolved_threads: Vec<DeliveryFeedbackThread>,
}

/// Classifies fresh feedback for delivery repair without silently treating an
/// unmergeable pull request as ordinary waiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeliveryRepairFeedback {
    Actionable(ActionableDeliveryFeedback),
    RequiresOperator {
        feedback: ActionableDeliveryFeedback,
        mergeability: Mergeability,
    },
}

impl DeliveryObservationFacts {
    pub(crate) fn validate_identity(
        &self,
        pull_request_number: u64,
        pull_request_url: &str,
    ) -> Result<(), DeliveryObservationFailure> {
        if self.pull_request_number != pull_request_number
            || self.pull_request_url != pull_request_url
        {
            return Err(DeliveryObservationFailure::new(
                DeliveryObservationFailureKind::InvalidIdentity,
                "GitHub returned a pull request other than the durable delivery identity",
            ));
        }
        Ok(())
    }

    pub(crate) fn for_delivery(mut self, local_sha: &str) -> Self {
        self.matches_delivery = self.head_sha == local_sha;
        self.head_diverged = !self.matches_delivery;
        self.check_summary = CheckSummary::from_checks(&self.checks);
        self
    }

    pub(crate) fn automatic_merge_evidence(&self) -> Option<&AutomaticMergeEvidence> {
        (self.matches_delivery
            && !self.head_diverged
            && self.terminal_state == PullRequestTerminalState::Open
            && self.mergeability == Mergeability::Mergeable)
            .then_some(self.automatic_merge.as_ref())
            .flatten()
    }

    /// Returns only feedback that is safe to act on for the observed delivery head.
    /// Pending checks and general pull-request conversation are deliberately absent here.
    pub(crate) fn actionable_feedback(&self) -> Option<ActionableDeliveryFeedback> {
        match self.repair_feedback()? {
            DeliveryRepairFeedback::Actionable(feedback) => Some(feedback),
            DeliveryRepairFeedback::RequiresOperator { .. } => None,
        }
    }

    /// Classifies otherwise actionable feedback that cannot safely start an automated repair.
    pub(crate) fn repair_feedback(&self) -> Option<DeliveryRepairFeedback> {
        if self.terminal_state != PullRequestTerminalState::Open
            || !self.matches_delivery
            || self.head_diverged
        {
            return None;
        }
        let terminal_failed_checks = self
            .checks
            .iter()
            .filter(|check| {
                check.status == CheckStatus::Completed
                    && matches!(
                        check.conclusion,
                        Some(
                            CheckConclusion::Failure
                                | CheckConclusion::TimedOut
                                | CheckConclusion::Cancelled
                                | CheckConclusion::ActionRequired
                                | CheckConclusion::StartupFailure
                        )
                    )
            })
            .map(|check| check.name.clone())
            .collect::<Vec<_>>();
        let feedback = ActionableDeliveryFeedback {
            terminal_failed_checks,
            change_request_bodies: self.feedback.change_request_bodies.clone(),
            unresolved_threads: self.feedback.unresolved_threads.clone(),
        };
        let has_feedback = !feedback.terminal_failed_checks.is_empty()
            || !feedback.change_request_bodies.is_empty()
            || !feedback.unresolved_threads.is_empty();
        if !has_feedback {
            return None;
        }
        Some(match self.mergeability {
            Mergeability::Mergeable => DeliveryRepairFeedback::Actionable(feedback),
            Mergeability::Conflicting | Mergeability::Unknown => {
                DeliveryRepairFeedback::RequiresOperator {
                    feedback,
                    mergeability: self.mergeability,
                }
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryCheck {
    pub name: String,
    /// GitHub App integration identity when supplied for a check run.
    #[serde(default)]
    pub integration_id: Option<u64>,
    pub status: CheckStatus,
    pub conclusion: Option<CheckConclusion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pending,
    Queued,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckConclusion {
    Success,
    Neutral,
    Skipped,
    Failure,
    TimedOut,
    Cancelled,
    ActionRequired,
    StartupFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckSummary {
    Pending,
    Passing,
    Failing,
}

impl CheckSummary {
    pub(crate) fn from_checks(checks: &[DeliveryCheck]) -> Self {
        if checks.iter().any(|check| {
            matches!(
                check.conclusion,
                Some(
                    CheckConclusion::Failure
                        | CheckConclusion::TimedOut
                        | CheckConclusion::Cancelled
                        | CheckConclusion::ActionRequired
                        | CheckConclusion::StartupFailure
                )
            )
        }) {
            Self::Failing
        } else if checks
            .iter()
            .all(|check| check.status == CheckStatus::Completed && check.conclusion.is_some())
        {
            Self::Passing
        } else {
            Self::Pending
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestTerminalState {
    Open,
    Merged,
    ClosedWithoutMerge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Mergeability {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseFreshness {
    UpToDate,
    Behind,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeliveryObservationRead {
    Observed(DeliveryObservationFacts),
    Retryable(DeliveryObservationFailure),
    Terminal(DeliveryObservationFailure),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> DeliveryObservationFacts {
        DeliveryObservationFacts {
            pull_request_node_id: None,
            pull_request_number: 42,
            pull_request_url: "https://github.com/example/repo/pull/42".to_string(),
            head_sha: "expected".to_string(),
            matches_delivery: false,
            head_diverged: false,
            terminal_state: PullRequestTerminalState::Open,
            mergeability: Mergeability::Mergeable,
            base_freshness: BaseFreshness::UpToDate,
            checks: vec![],
            check_summary: CheckSummary::Pending,
            review_decision: ReviewDecision::ReviewRequired,
            in_merge_queue: false,
            automatic_merge: None,
            feedback: DeliveryFeedback::default(),
        }
    }

    #[test]
    fn complete_facts_rejects_a_mismatched_pull_request_identity() {
        let mut facts = facts();
        facts.pull_request_number = 7;

        assert!(facts
            .validate_identity(42, "https://github.com/example/repo/pull/42")
            .is_err());
    }

    #[test]
    fn facts_mark_a_changed_head_as_diverged_without_adopting_it() {
        let facts = facts().for_delivery("different");

        assert!(!facts.matches_delivery);
        assert!(facts.head_diverged);
    }

    #[test]
    fn checks_are_failing_when_any_completed_check_has_a_failure_conclusion() {
        let checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];

        assert_eq!(CheckSummary::from_checks(&checks), CheckSummary::Failing);
    }

    #[test]
    fn a_complete_empty_check_rollup_is_passing() {
        assert_eq!(CheckSummary::from_checks(&[]), CheckSummary::Passing);
    }

    #[test]
    fn actionable_feedback_accepts_terminal_failure_even_when_other_checks_are_pending() {
        let mut facts = facts().for_delivery("expected");
        facts.checks = vec![
            DeliveryCheck {
                name: "test".to_string(),
                integration_id: None,
                status: CheckStatus::Completed,
                conclusion: Some(CheckConclusion::Failure),
            },
            DeliveryCheck {
                name: "deploy".to_string(),
                integration_id: None,
                status: CheckStatus::InProgress,
                conclusion: None,
            },
        ];

        let feedback = facts.actionable_feedback().unwrap();

        assert_eq!(feedback.terminal_failed_checks, vec!["test"]);
    }

    #[test]
    fn actionable_feedback_requires_a_mergeable_pull_request() {
        let mut facts = facts().for_delivery("expected");
        facts.checks = vec![DeliveryCheck {
            name: "test".to_string(),
            integration_id: None,
            status: CheckStatus::Completed,
            conclusion: Some(CheckConclusion::Failure),
        }];

        facts.mergeability = Mergeability::Conflicting;
        assert!(facts.actionable_feedback().is_none());

        facts.mergeability = Mergeability::Unknown;
        assert!(facts.actionable_feedback().is_none());
    }

    #[test]
    fn repair_feedback_routes_nonmergeable_actionable_evidence_to_an_operator() {
        let mut facts = facts().for_delivery("expected");
        facts.feedback.change_request_bodies = vec!["please fix this".to_string()];
        facts.mergeability = Mergeability::Conflicting;

        assert!(matches!(
            facts.repair_feedback(),
            Some(DeliveryRepairFeedback::RequiresOperator {
                mergeability: Mergeability::Conflicting,
                ..
            })
        ));

        facts.mergeability = Mergeability::Unknown;
        assert!(matches!(
            facts.repair_feedback(),
            Some(DeliveryRepairFeedback::RequiresOperator {
                mergeability: Mergeability::Unknown,
                ..
            })
        ));
    }

    #[test]
    fn automatic_merge_evidence_requires_a_fresh_matching_mergeable_delivery() {
        let mut facts = facts().for_delivery("expected");
        facts.pull_request_node_id = Some("PR_node".to_string());
        facts.automatic_merge = Some(AutomaticMergeEvidence {
            required_checks_passing: true,
            required_reviews_satisfied: true,
            required_review_threads_resolved: true,
            strict_base_satisfied: true,
            no_requested_changes: true,
            queue_supported: true,
            queued: false,
        });
        assert!(facts
            .automatic_merge_evidence()
            .is_some_and(AutomaticMergeEvidence::is_eligible_for_direct_merge));

        facts.mergeability = Mergeability::Unknown;
        assert!(facts.automatic_merge_evidence().is_none());
    }

    #[test]
    fn actionable_feedback_excludes_diverged_heads_and_resolved_or_outdated_threads() {
        let mut facts = facts().for_delivery("expected");
        facts.feedback.unresolved_threads = vec![DeliveryFeedbackThread {
            path: Some("src/lib.rs".to_string()),
            line: Some(7),
            body: "fix this".to_string(),
        }];
        assert!(facts.actionable_feedback().is_some());

        facts.head_diverged = true;
        assert!(facts.actionable_feedback().is_none());

        facts.head_diverged = false;
        facts.feedback.unresolved_threads.clear();
        assert!(facts.actionable_feedback().is_none());
    }

    #[test]
    fn unsupported_explicit_schema_versions_fail_closed() {
        let observation = serde_json::json!({
            "schema_version": 3,
            "freshness": "fresh",
            "observed_at": null,
            "last_attempt_at": "2026-08-11T17:00:00Z",
            "retry": null,
            "failure": null,
            "facts": null
        });

        assert!(serde_json::from_value::<DeliveryObservation>(observation).is_err());
    }
}
