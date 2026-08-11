use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

const OBSERVATION_SCHEMA_VERSION: u8 = 1;
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
        if wire.schema_version != OBSERVATION_SCHEMA_VERSION {
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DeliveryCheck {
    pub name: String,
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
    fn unsupported_explicit_schema_versions_fail_closed() {
        let observation = serde_json::json!({
            "schema_version": 2,
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
