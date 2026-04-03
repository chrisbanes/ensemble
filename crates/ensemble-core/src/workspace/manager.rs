use crate::config::ensemble::RepoConfig;
use crate::error::WorkspaceError;
use crate::tracker::model::sanitize_workspace_key;
use crate::workspace::coordinator::{WorktreeCoordinator, WorktreeInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::warn;

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

/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
    worktree_coordinator: Option<WorktreeCoordinator>,
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

        let worktree_coordinator = repos.filter(|r| !r.is_empty()).map(|repo_list| {
            let mut repos_map = HashMap::new();
            for (index, repo) in repo_list.into_iter().enumerate() {
                let name = Path::new(&repo.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("repo-{index}"));
                repos_map.insert(name, repo);
            }
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            WorktreeCoordinator::new(repos_map, today)
        });

        Ok(Self {
            root,
            worktree_coordinator,
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

    /// Prepare (create or reuse) a workspace for the given issue identifier.
    pub async fn prepare_workspace(
        &self,
        identifier: &str,
    ) -> Result<WorkspaceResult, WorkspaceError> {
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

        // Prepare worktrees if coordinator is configured
        let worktrees = if let Some(coordinator) = &self.worktree_coordinator {
            coordinator
                .prepare_worktrees(identifier)
                .await
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("worktree preparation failed: {e}"),
                })?
        } else {
            HashMap::new()
        };

        let created_now = base_created || worktrees.values().any(|w| w.created_now);

        Ok(WorkspaceResult {
            base_path,
            worktrees,
            workspace_key,
            created_now,
        })
    }

    /// Remove a workspace directory and its worktrees for the given issue identifier.
    pub async fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
        let workspace_key =
            sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
                reason: format!("unsafe workspace key from identifier: {identifier:?}"),
            })?;
        let base_path = self.root.join(&workspace_key);

        self.validate_path_inside_root(&base_path)?;

        // Clean up worktrees first
        if let Some(coordinator) = &self.worktree_coordinator {
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
        let canonical_root = self.root.canonicalize().unwrap_or_else(|e| {
            warn!(
                root = %self.root.display(),
                error = %e,
                "cannot canonicalize workspace root, falling back to non-canonical path check"
            );
            self.root.clone()
        });

        let canonical_path = if path.exists() {
            path.canonicalize().unwrap_or_else(|e| {
                warn!(
                    path = %path.display(),
                    error = %e,
                    "cannot canonicalize path, falling back to non-canonical check"
                );
                path.to_path_buf()
            })
        } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
            let canonical_parent = parent.canonicalize().unwrap_or_else(|e| {
                warn!(
                    parent = %parent.display(),
                    error = %e,
                    "cannot canonicalize parent path, falling back to non-canonical check"
                );
                parent.to_path_buf()
            });
            canonical_parent.join(file_name)
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
    use tempfile::TempDir;

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
}
