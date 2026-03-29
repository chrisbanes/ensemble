pub mod github;
pub mod model;
pub mod todo_file;

use crate::config::typed::ServiceConfig;
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
    #[error("I/O error: {reason}")]
    IoError { reason: String },
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
    #[error("tracker does not support write operations")]
    WritesNotSupported,
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

    /// Whether this tracker supports write operations.
    fn supports_writes(&self) -> bool {
        false
    }

    /// Transition an issue to the given state in the tracker.
    async fn set_issue_state(&self, _id: &str, _state: &str) -> Result<(), TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }

    /// Add a comment to an issue in the tracker.
    async fn add_comment(&self, _id: &str, _body: &str) -> Result<(), TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }
}

/// Create an `IssueTracker` implementation based on the service config.
///
/// Matches on `tracker_kind` to return the right backend:
/// - `"todo_file"` -> `TodoFileTracker`
/// - `"github"` -> `GithubTracker`
///
/// Returns an error if the tracker kind is missing or unsupported, or
/// if required configuration is absent (e.g., missing API key for GitHub).
pub fn create_tracker(config: &ServiceConfig) -> Result<Box<dyn IssueTracker>, TrackerError> {
    let kind = config
        .tracker_kind
        .as_deref()
        .ok_or_else(|| TrackerError::UnsupportedKind {
            kind: "<none>".to_string(),
        })?;

    match kind {
        "todo_file" => {
            let tracker = todo_file::TodoFileTracker::new(
                config.tracker_path.clone(),
                config.tracker_active_states.clone(),
            );
            Ok(Box::new(tracker))
        }
        "github" => {
            let token = config
                .tracker_api_key
                .as_ref()
                .ok_or(TrackerError::MissingApiKey)?;
            let repository = config
                .tracker_repository
                .as_ref()
                .ok_or(TrackerError::MissingRepository)?;

            let tracker = github::GithubTracker::new(
                config.tracker_endpoint.clone(),
                token.clone(),
                repository.clone(),
                config.tracker_project_number,
                config.tracker_active_states.clone(),
                config.tracker_terminal_states.clone(),
                config.tracker_labels_filter.clone(),
            )?;
            Ok(Box::new(tracker))
        }
        other => Err(TrackerError::UnsupportedKind {
            kind: other.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::typed::ServiceConfig;
    use tempfile::TempDir;

    #[test]
    fn test_create_todo_file_tracker() {
        let dir = TempDir::new().unwrap();
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("todo_file".to_string());
        config.tracker_path = dir.path().join("TODO.md");

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_test_token".to_string());
        config.tracker_repository = Some("acme/repo".to_string());

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker_missing_api_key() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = None;
        config.tracker_repository = Some("acme/repo".to_string());

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingApiKey)));
    }

    #[test]
    fn test_create_github_tracker_missing_repository() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_test_token".to_string());
        config.tracker_repository = None;

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingRepository)));
    }

    #[test]
    fn test_create_unsupported_kind() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("linear".to_string());

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::UnsupportedKind { .. })));
    }

    #[test]
    fn test_create_no_kind() {
        let config = ServiceConfig::default();
        // tracker_kind is None by default
        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::UnsupportedKind { .. })));
    }

    #[tokio::test]
    async fn test_default_write_methods_return_not_supported() {
        struct ReadOnlyTracker;

        #[async_trait]
        impl IssueTracker for ReadOnlyTracker {
            async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
                Ok(vec![])
            }
            async fn fetch_issues_by_states(
                &self,
                _: &[String],
            ) -> Result<Vec<Issue>, TrackerError> {
                Ok(vec![])
            }
            async fn fetch_issue_states_by_ids(
                &self,
                _: &[String],
            ) -> Result<Vec<Issue>, TrackerError> {
                Ok(vec![])
            }
        }

        let tracker = ReadOnlyTracker;
        assert!(!tracker.supports_writes());
        assert!(matches!(
            tracker.set_issue_state("id", "Done").await,
            Err(TrackerError::WritesNotSupported)
        ));
        assert!(matches!(
            tracker.add_comment("id", "hello").await,
            Err(TrackerError::WritesNotSupported)
        ));
    }
}
