mod auth;
pub mod github;
pub mod model;
pub mod todo_file;

use crate::config::ensemble::TrackerConfig;
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
    #[error("missing tracker path for todo_file kind")]
    MissingPath,
    #[error("TODO file parent directory does not exist: {path}")]
    MissingParentDirectory { path: String },
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

    /// Whether this tracker supports state-transition writes (`set_issue_state`).
    ///
    /// The pipeline engine checks this at startup to fail fast if the flow requires
    /// tracker state transitions but the backend cannot perform them.
    /// Note: `add_comment` may still return `WritesNotSupported` even when this
    /// returns true (e.g., the todo_file tracker supports state writes but not comments).
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

/// Resolve a GitHub API token using the configured precedence:
/// explicit token, then `$GITHUB_TOKEN`, then `gh auth token`.
pub fn resolve_github_token(explicit: Option<&str>) -> Option<String> {
    resolve_github_token_for_endpoint(explicit, None, None)
}

/// Resolve a GitHub API token using the configured precedence and endpoint-aware host mapping.
pub fn resolve_github_token_for_endpoint(
    explicit: Option<&str>,
    endpoint: Option<&str>,
    configured_hostname: Option<&str>,
) -> Option<String> {
    auth::resolve_github_token(explicit, endpoint, configured_hostname)
}

/// Create an `IssueTracker` implementation based on the tracker config.
///
/// Matches on `kind` to return the right backend:
/// - `"todo_file"` -> `TodoFileTracker`
/// - `"github"` -> `GithubTracker`
///
/// Returns an error if the tracker kind is unsupported, or
/// if required configuration is absent (e.g., missing API key for GitHub).
pub fn create_tracker(config: &TrackerConfig) -> Result<Box<dyn IssueTracker>, TrackerError> {
    match config.kind.as_str() {
        "todo_file" => {
            let path = config
                .path
                .as_ref()
                .ok_or(TrackerError::MissingPath)?
                .clone();

            // Validate parent directory exists for runtime safety
            if let Some(parent) = path.parent() {
                if !parent.exists() {
                    return Err(TrackerError::MissingParentDirectory {
                        path: parent.display().to_string(),
                    });
                }
            }

            let tracker = todo_file::TodoFileTracker::new(path, config.active_states.clone());
            Ok(Box::new(tracker))
        }
        "github" => {
            let endpoint = config
                .endpoint
                .clone()
                .unwrap_or_else(|| "https://api.github.com/graphql".to_string());
            let token = resolve_github_token_for_endpoint(
                config.api_key.as_deref(),
                Some(endpoint.as_str()),
                config.gh_hostname.as_deref(),
            )
            .ok_or(TrackerError::MissingApiKey)?;
            let repository = config
                .repository
                .as_ref()
                .ok_or(TrackerError::MissingRepository)?;

            let tracker = github::GithubTracker::new(
                endpoint,
                token,
                repository.clone(),
                config.project_number,
                config.active_states.clone(),
                config.terminal_states.clone(),
                config.labels_filter.clone(),
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
    use crate::config::ensemble::TrackerConfig;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let original = std::env::var(key).ok();
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn todo_file_config(path: PathBuf) -> TrackerConfig {
        TrackerConfig {
            kind: "todo_file".to_string(),
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            path: Some(path),
            endpoint: None,
            gh_hostname: None,
            api_key: None,
            repository: None,
            project_number: None,
            labels_filter: vec![],
        }
    }

    fn github_config(api_key: Option<String>, repository: Option<String>) -> TrackerConfig {
        TrackerConfig {
            kind: "github".to_string(),
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            path: None,
            endpoint: None,
            gh_hostname: None,
            api_key,
            repository,
            project_number: None,
            labels_filter: vec![],
        }
    }

    #[test]
    fn test_create_todo_file_tracker() {
        let dir = TempDir::new().unwrap();
        let todo_path = dir.path().join("TODO.md");
        // Ensure parent exists
        let config = todo_file_config(todo_path.clone());

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_todo_file_tracker_missing_parent_directory() {
        let missing_parent = PathBuf::from("/definitely/missing/dir/TODO.md");
        let config = todo_file_config(missing_parent);
        let result = create_tracker(&config);
        assert!(matches!(
            result,
            Err(TrackerError::MissingParentDirectory { .. })
        ));
    }

    #[test]
    fn test_create_todo_file_tracker_missing_path() {
        let config = TrackerConfig {
            kind: "todo_file".to_string(),
            active_states: vec!["Todo".to_string()],
            terminal_states: vec!["Done".to_string()],
            path: None,
            endpoint: None,
            gh_hostname: None,
            api_key: None,
            repository: None,
            project_number: None,
            labels_filter: vec![],
        };
        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingPath)));
    }

    #[test]
    fn test_create_github_tracker() {
        let config = github_config(
            Some("ghp_test_token".to_string()),
            Some("acme/repo".to_string()),
        );

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker_missing_api_key() {
        let _env_lock = ENV_LOCK.lock().expect("env lock poisoned");
        let _token_guard = EnvVarGuard::set("GITHUB_TOKEN", None);
        let _gh_guard = EnvVarGuard::set("ENSEMBLE_GH_BIN", Some("__missing_gh_binary__"));
        let config = github_config(None, Some("acme/repo".to_string()));

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingApiKey)));
    }

    #[test]
    fn test_resolve_github_token_prefers_explicit_over_env() {
        let _env_lock = ENV_LOCK.lock().expect("env lock poisoned");
        let _token_guard = EnvVarGuard::set("GITHUB_TOKEN", Some("from-env"));
        assert_eq!(
            resolve_github_token(Some("from-config")).as_deref(),
            Some("from-config")
        );
    }

    #[test]
    fn test_create_github_tracker_uses_env_token_when_api_key_missing() {
        let _env_lock = ENV_LOCK.lock().expect("env lock poisoned");
        let _token_guard = EnvVarGuard::set("GITHUB_TOKEN", Some("from-env"));
        let _gh_guard = EnvVarGuard::set("ENSEMBLE_GH_BIN", Some("__missing_gh_binary__"));
        let config = github_config(None, Some("acme/repo".to_string()));

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker_missing_repository() {
        let config = github_config(Some("ghp_test_token".to_string()), None);

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingRepository)));
    }

    #[test]
    fn test_create_unsupported_kind() {
        let config = TrackerConfig {
            kind: "linear".to_string(),
            active_states: vec![],
            terminal_states: vec![],
            path: None,
            endpoint: None,
            gh_hostname: None,
            api_key: None,
            repository: None,
            project_number: None,
            labels_filter: vec![],
        };

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
