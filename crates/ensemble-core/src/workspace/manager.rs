use crate::config::ensemble::RepoConfig;
use crate::error::WorkspaceError;
use crate::observability::events_contract::{
    elapsed_ms, WORKSPACE_PREPARE_FAILED, WORKSPACE_PREPARE_FINISHED, WORKSPACE_PREPARE_STARTED,
};
use crate::tracker::model::sanitize_workspace_key;
use crate::workspace::coordinator::{WorktreeCoordinator, WorktreeInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;
use tracing::{info, warn};

const WORKSPACE_METADATA_FILE: &str = ".ensemble-workspace.json";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct WorkspaceMetadata {
    branch_date: String,
}

/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
    repos: HashMap<String, RepoConfig>,
}

/// Result of preparing a workspace for an issue.
pub struct WorkspaceResult {
    /// Absolute path to the base workspace directory (logs, artifacts).
    pub base_path: PathBuf,
    /// Map of repo name to worktree info (if repos configured).
    pub worktrees: HashMap<String, WorktreeInfo>,
    /// The sanitized workspace key used as the directory name.
    pub workspace_key: String,
    /// True if the directory was newly created (not reused).
    pub created_now: bool,
}

impl WorkspaceManager {
    /// Create a new WorkspaceManager with the given workspace root.
    /// The root is normalized to an absolute path.
    /// Pass `repos` to enable worktree-based workspace isolation.
    /// Repo names are derived from path basenames.
    pub fn new(root: &Path, repos: Option<Vec<RepoConfig>>) -> Result<Self, WorkspaceError> {
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("cannot resolve relative root: {e}"),
                })?
                .join(root)
        };

        let repos_map = repos
            .filter(|r| !r.is_empty())
            .map(|repo_list| {
                let mut repos_map = HashMap::new();
                for (index, repo) in repo_list.into_iter().enumerate() {
                    let name = Path::new(&repo.path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("repo-{index}"));
                    repos_map.insert(name, repo);
                }
                repos_map
            })
            .unwrap_or_default();

        Ok(Self {
            root,
            repos: repos_map,
        })
    }

    /// Get the absolute workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Get the workspace path for a given identifier without creating it.
    /// Returns None if the identifier cannot be sanitized.
    pub fn workspace_path(&self, identifier: &str) -> Option<PathBuf> {
        sanitize_workspace_key(identifier).map(|key| self.root.join(key))
    }

    fn metadata_path(base_path: &Path) -> PathBuf {
        base_path.join(WORKSPACE_METADATA_FILE)
    }

    async fn load_branch_date(&self, base_path: &Path) -> Option<String> {
        let metadata_path = Self::metadata_path(base_path);
        if !metadata_path.exists() {
            return None;
        }

        let content = match fs::read_to_string(&metadata_path).await {
            Ok(content) => content,
            Err(error) => {
                warn!(
                    path = %metadata_path.display(),
                    error = %error,
                    "failed to read workspace metadata; ignoring persisted branch date"
                );
                return None;
            }
        };

        let metadata: WorkspaceMetadata = match serde_json::from_str(&content) {
            Ok(metadata) => metadata,
            Err(error) => {
                warn!(
                    path = %metadata_path.display(),
                    error = %error,
                    "failed to parse workspace metadata; ignoring persisted branch date"
                );
                return None;
            }
        };

        Some(metadata.branch_date)
    }

    async fn save_branch_date(&self, base_path: &Path, date: &str) -> Result<(), WorkspaceError> {
        let metadata = WorkspaceMetadata {
            branch_date: date.to_string(),
        };
        let content =
            serde_json::to_string(&metadata).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("failed to serialize workspace metadata: {e}"),
            })?;
        let metadata_path = Self::metadata_path(base_path);
        fs::write(&metadata_path, content)
            .await
            .map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("failed to write workspace metadata: {e}"),
            })
    }

    /// Prepare (create or reuse) a workspace for the given issue identifier.
    pub async fn prepare_workspace(
        &self,
        identifier: &str,
    ) -> Result<WorkspaceResult, WorkspaceError> {
        let prepare_started_at = std::time::Instant::now();
        info!(
            event = WORKSPACE_PREPARE_STARTED,
            issue_identifier = identifier,
            "preparing workspace"
        );
        let workspace_key =
            sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
                reason: format!("unsafe workspace key from identifier: {identifier:?}"),
            })?;
        let base_path = self.root.join(&workspace_key);

        // Safety: ensure workspace path is inside root
        self.validate_path_inside_root(&base_path)?;

        let base_created = if base_path.exists() {
            if !base_path.is_dir() {
                return Err(WorkspaceError::CreationFailed {
                    reason: format!(
                        "path exists but is not a directory: {}",
                        base_path.display()
                    ),
                });
            }
            false
        } else {
            std::fs::create_dir_all(&base_path).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("mkdir failed: {e}"),
            })?;
            true
        };

        // Prepare worktrees if repos configured
        let worktrees = if !self.repos.is_empty() {
            let branch_date = if base_created {
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                self.save_branch_date(&base_path, &today).await?;
                today
            } else {
                match self.load_branch_date(&base_path).await {
                    Some(date) => date,
                    None => {
                        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                        self.save_branch_date(&base_path, &today).await?;
                        today
                    }
                }
            };
            let coordinator =
                WorktreeCoordinator::new(self.repos.clone(), branch_date, base_path.clone());
            info!(workspace = %base_path.display(), "preparing worktrees inside workspace");
            match coordinator.prepare_worktrees(identifier).await {
                Ok(worktrees) => worktrees,
                Err(e) => {
                    warn!(
                        event = WORKSPACE_PREPARE_FAILED,
                        issue_identifier = identifier,
                        duration_ms = elapsed_ms(prepare_started_at),
                        error = %e,
                        "workspace preparation failed"
                    );
                    return Err(WorkspaceError::CreationFailed {
                        reason: format!("worktree preparation failed: {e}"),
                    });
                }
            }
        } else {
            HashMap::new()
        };

        let created_now = base_created || worktrees.values().any(|w| w.created_now);

        let result = WorkspaceResult {
            base_path,
            worktrees,
            workspace_key,
            created_now,
        };

        info!(
            event = WORKSPACE_PREPARE_FINISHED,
            issue_identifier = identifier,
            duration_ms = elapsed_ms(prepare_started_at),
            created_now = result.created_now,
            "workspace prepared"
        );

        Ok(result)
    }

    /// Remove a workspace directory and its worktrees for the given issue identifier.
    pub async fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
        let workspace_key =
            sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
                reason: format!("unsafe workspace key from identifier: {identifier:?}"),
            })?;
        let base_path = self.root.join(&workspace_key);

        self.validate_path_inside_root(&base_path)?;

        // Clean up worktrees first - use persisted branch date to avoid date drift
        if !self.repos.is_empty() {
            let branch_date = match self.load_branch_date(&base_path).await {
                Some(date) => date,
                None => {
                    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                    if base_path.exists() {
                        self.save_branch_date(&base_path, &today).await?;
                    }
                    today
                }
            };
            let coordinator =
                WorktreeCoordinator::new(self.repos.clone(), branch_date, base_path.clone());
            warn!(workspace = %base_path.display(), "cleaning up worktrees");
            coordinator
                .cleanup_worktrees(identifier)
                .await
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("worktree cleanup failed: {e}"),
                })?;
        }

        // Remove base workspace
        if base_path.exists() {
            std::fs::remove_dir_all(&base_path).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("remove failed: {e}"),
            })?;
        }
        Ok(())
    }

    /// Validate that a workspace path is inside the workspace root.
    ///
    /// Both the root and the candidate path are canonicalized (symlinks resolved)
    /// so that the `starts_with` check is reliable on platforms such as macOS where
    /// `/var/folders/...` is a symlink to `/private/var/folders/...`.
    ///
    /// When `path` does not yet exist (pre-creation), its parent is canonicalized
    /// and the final component is re-appended, preserving the intended semantics.
    fn validate_path_inside_root(&self, path: &Path) -> Result<(), WorkspaceError> {
        let canonical_root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());

        let canonical_path = if path.exists() {
            path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
        } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
            parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf())
                .join(file_name)
        } else {
            path.to_path_buf()
        };

        if !canonical_path.starts_with(&canonical_root) {
            return Err(WorkspaceError::PathOutsideRoot {
                path: canonical_path.display().to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::RepoConfig;
    use std::path::Path;
    use tempfile::TempDir;

    fn git_binary_for_tests() -> &'static str {
        for candidate in [
            "/usr/bin/git",
            "/usr/local/bin/git",
            "/opt/homebrew/bin/git",
        ] {
            if Path::new(candidate).is_file() {
                return candidate;
            }
        }
        "git"
    }

    fn setup_repo(name: &str) -> (TempDir, RepoConfig) {
        let dir = TempDir::new().unwrap();

        std::process::Command::new(git_binary_for_tests())
            .args(["init", "-b", "main"])
            .current_dir(&dir)
            .output()
            .unwrap();

        std::fs::write(dir.path().join("README.md"), format!("# {name}")).unwrap();
        std::process::Command::new(git_binary_for_tests())
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::process::Command::new(git_binary_for_tests())
            .args(["commit", "-m", "initial"])
            .current_dir(&dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();

        let config = RepoConfig {
            path: dir.path().to_string_lossy().to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
        };

        (dir, config)
    }

    fn setup() -> (TempDir, WorkspaceManager) {
        let dir = TempDir::new().unwrap();
        let mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        (dir, mgr)
    }

    #[tokio::test]
    async fn test_prepare_creates_new_workspace() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("my-repo#42").await.unwrap();
        assert!(result.created_now);
        assert_eq!(result.workspace_key, "my-repo_42");
        assert!(result.base_path.is_dir());
    }

    #[tokio::test]
    async fn test_prepare_reuses_existing_workspace() {
        let (_dir, mgr) = setup();
        let first = mgr.prepare_workspace("my-repo#42").await.unwrap();
        assert!(first.created_now);

        let second = mgr.prepare_workspace("my-repo#42").await.unwrap();
        assert!(!second.created_now);
        assert_eq!(first.base_path, second.base_path);
    }

    #[tokio::test]
    async fn test_prepare_sanitizes_identifier() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("acme/repo 123!@#").await.unwrap();
        assert_eq!(result.workspace_key, "acme_repo_123___");
        assert!(result.base_path.is_dir());
    }

    #[tokio::test]
    async fn test_prepare_deterministic_path() {
        let (_dir, mgr) = setup();
        let r1 = mgr.prepare_workspace("test-issue").await.unwrap();
        let r2 = mgr.prepare_workspace("test-issue").await.unwrap();
        assert_eq!(r1.base_path, r2.base_path);
    }

    #[tokio::test]
    async fn test_remove_workspace() {
        let (_dir, mgr) = setup();
        mgr.prepare_workspace("my-repo#42").await.unwrap();

        let ws_path = mgr.root().join("my-repo_42");
        assert!(ws_path.exists());

        mgr.remove_workspace("my-repo#42").await.unwrap();
        assert!(!ws_path.exists());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_is_ok() {
        let (_dir, mgr) = setup();
        assert!(mgr.remove_workspace("nonexistent").await.is_ok());
    }

    #[tokio::test]
    async fn test_path_inside_root_validation() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("normal-issue").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_file_at_workspace_path_errors() {
        let (dir, mgr) = setup();
        let file_path = dir.path().join("my-repo_42");
        std::fs::write(&file_path, "not a directory").unwrap();

        let result = mgr.prepare_workspace("my-repo#42").await;
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[tokio::test]
    async fn test_dot_identifier_rejected() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace(".").await;
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[tokio::test]
    async fn test_dotdot_identifier_rejected() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("..").await;
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[tokio::test]
    async fn test_workspace_root_accessor() {
        let (dir, mgr) = setup();
        assert_eq!(mgr.root(), dir.path());
    }

    #[tokio::test]
    async fn test_branch_date_persisted_and_loaded() {
        let dir = TempDir::new().unwrap();
        let mgr = WorkspaceManager::new(dir.path(), None).unwrap();

        let test_path = dir.path().join("test-workspace");
        std::fs::create_dir_all(&test_path).unwrap();

        mgr.save_branch_date(&test_path, "2024-06-15")
            .await
            .unwrap();

        let loaded = mgr.load_branch_date(&test_path).await;
        assert_eq!(loaded, Some("2024-06-15".to_string()));
    }

    #[tokio::test]
    async fn test_remove_workspace_uses_persisted_branch_date() {
        let dir = TempDir::new().unwrap();

        let identifier = "test-issue";
        let workspace_key = sanitize_workspace_key(identifier).unwrap();
        let test_path = dir.path().join(&workspace_key);
        std::fs::create_dir_all(&test_path).unwrap();

        let metadata_path = test_path.join(".ensemble-workspace.json");
        std::fs::write(&metadata_path, r#"{"branch_date":"2020-01-01"}"#).unwrap();

        let repos = vec![RepoConfig {
            path: "/nonexistent/path".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
        }];
        let mgr = WorkspaceManager::new(dir.path(), Some(repos)).unwrap();

        let result = mgr.remove_workspace(identifier).await;
        assert!(result.is_err());
        assert!(test_path.exists());
    }

    #[tokio::test]
    async fn test_remove_workspace_blocks_on_cleanup_failure() {
        let dir = TempDir::new().unwrap();
        let repos = vec![RepoConfig {
            path: "/nonexistent/path".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
        }];
        let mgr = WorkspaceManager::new(dir.path(), Some(repos)).unwrap();

        let ws_path = dir.path().join("cleanup-test");
        std::fs::create_dir_all(&ws_path).unwrap();
        let metadata_path = ws_path.join(".ensemble-workspace.json");
        std::fs::write(&metadata_path, r#"{"branch_date":"2020-01-01"}"#).unwrap();

        let remove_result = mgr.remove_workspace("cleanup-test").await;
        assert!(remove_result.is_err());

        assert!(
            ws_path.exists(),
            "workspace should not be deleted when cleanup fails"
        );
    }

    #[tokio::test]
    async fn test_prepare_persists_branch_date_for_legacy_workspace() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let identifier = "legacy#42";
        let workspace_key = sanitize_workspace_key(identifier).unwrap();
        let base_path = root.path().join(workspace_key);
        std::fs::create_dir_all(&base_path).unwrap();

        assert!(!WorkspaceManager::metadata_path(&base_path).exists());

        let result = mgr.prepare_workspace(identifier).await;
        assert!(result.is_ok());
        assert!(WorkspaceManager::metadata_path(&base_path).exists());
    }
}
