pub mod model;

use async_trait::async_trait;
use model::Issue;

/// Error type for tracker operations.
#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("unsupported tracker kind: {kind}")]
    UnsupportedKind { kind: String },
    #[error("missing tracker API key")]
    MissingApiKey,
    #[error("missing tracker repository")]
    MissingRepository,
    #[error("GitHub API request failed: {reason}")]
    ApiRequestFailed { reason: String },
    #[error("GitHub API returned status {status}: {body}")]
    ApiStatus { status: u16, body: String },
    #[error("GitHub GraphQL errors: {errors}")]
    GraphqlErrors { errors: String },
    #[error("unexpected payload: {reason}")]
    UnexpectedPayload { reason: String },
    #[error("pagination error: missing end cursor")]
    MissingEndCursor,
}

/// Trait for issue tracker adapters.
/// The orchestrator uses this to fetch issues without knowing the tracker backend.
#[async_trait]
pub trait IssueTracker: Send + Sync {
    /// Fetch candidate issues in active states for dispatch.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError>;

    /// Fetch issues in the given states (used for startup terminal cleanup).
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError>;

    /// Fetch current states for specific issue IDs (used for reconciliation).
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError>;
}
