use crate::error::WorkspaceError;
use crate::tracker::model::sanitize_workspace_key;
use std::path::{Path, PathBuf};

/// Result of preparing a workspace for an issue.
pub struct WorkspaceResult {
    /// Absolute path to the workspace directory.
    pub path: PathBuf,
    /// The sanitized workspace key used as the directory name.
    pub workspace_key: String,
    /// True if the directory was newly created (not reused).
    pub created_now: bool,
}

/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
}

impl WorkspaceManager {
    /// Create a new WorkspaceManager with the given workspace root.
    /// The root is normalized to an absolute path.
    pub fn new(root: &Path) -> Result<Self, WorkspaceError> {
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("cannot resolve relative root: {e}"),
                })?
                .join(root)
        };
        Ok(Self { root })
    }

    /// Get the absolute workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Prepare (create or reuse) a workspace for the given issue identifier.
    pub fn prepare_workspace(&self, identifier: &str) -> Result<WorkspaceResult, WorkspaceError> {
        let workspace_key = sanitize_workspace_key(identifier);
        let workspace_path = self.root.join(&workspace_key);

        // Safety: ensure workspace path is inside root
        self.validate_path_inside_root(&workspace_path)?;

        let created_now = if workspace_path.exists() {
            if !workspace_path.is_dir() {
                return Err(WorkspaceError::CreationFailed {
                    reason: format!(
                        "path exists but is not a directory: {}",
                        workspace_path.display()
                    ),
                });
            }
            false
        } else {
            std::fs::create_dir_all(&workspace_path).map_err(|e| {
                WorkspaceError::CreationFailed {
                    reason: format!("mkdir failed: {e}"),
                }
            })?;
            true
        };

        Ok(WorkspaceResult {
            path: workspace_path,
            workspace_key,
            created_now,
        })
    }

    /// Remove a workspace directory for the given issue identifier.
    pub fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
        let workspace_key = sanitize_workspace_key(identifier);
        let workspace_path = self.root.join(&workspace_key);

        self.validate_path_inside_root(&workspace_path)?;

        if workspace_path.exists() {
            std::fs::remove_dir_all(&workspace_path).map_err(|e| {
                WorkspaceError::CreationFailed {
                    reason: format!("remove failed: {e}"),
                }
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
        // Resolve the root to its canonical form.
        let canonical_root = if self.root.exists() {
            self.root
                .canonicalize()
                .unwrap_or_else(|_| self.root.clone())
        } else {
            self.root.clone()
        };

        // Resolve the candidate path. If it does not exist yet, resolve its parent
        // and append the final component so we still get a canonical form.
        let canonical_path = if path.exists() {
            path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
        } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
            let canonical_parent = if parent.exists() {
                parent
                    .canonicalize()
                    .unwrap_or_else(|_| parent.to_path_buf())
            } else {
                parent.to_path_buf()
            };
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
        let mgr = WorkspaceManager::new(dir.path()).unwrap();
        (dir, mgr)
    }

    #[test]
    fn test_prepare_creates_new_workspace() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(result.created_now);
        assert_eq!(result.workspace_key, "my-repo_42");
        assert!(result.path.is_dir());
    }

    #[test]
    fn test_prepare_reuses_existing_workspace() {
        let (_dir, mgr) = setup();
        let first = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(first.created_now);

        let second = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(!second.created_now);
        assert_eq!(first.path, second.path);
    }

    #[test]
    fn test_prepare_sanitizes_identifier() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("acme/repo 123!@#").unwrap();
        assert_eq!(result.workspace_key, "acme_repo_123___");
        assert!(result.path.is_dir());
    }

    #[test]
    fn test_prepare_deterministic_path() {
        let (_dir, mgr) = setup();
        let r1 = mgr.prepare_workspace("test-issue").unwrap();
        let r2 = mgr.prepare_workspace("test-issue").unwrap();
        assert_eq!(r1.path, r2.path);
    }

    #[test]
    fn test_remove_workspace() {
        let (_dir, mgr) = setup();
        mgr.prepare_workspace("my-repo#42").unwrap();

        let ws_path = mgr.root().join("my-repo_42");
        assert!(ws_path.exists());

        mgr.remove_workspace("my-repo#42").unwrap();
        assert!(!ws_path.exists());
    }

    #[test]
    fn test_remove_nonexistent_is_ok() {
        let (_dir, mgr) = setup();
        assert!(mgr.remove_workspace("nonexistent").is_ok());
    }

    #[test]
    fn test_path_inside_root_validation() {
        let (_dir, mgr) = setup();
        // Normal path should be fine
        let result = mgr.prepare_workspace("normal-issue");
        assert!(result.is_ok());
    }

    #[test]
    fn test_file_at_workspace_path_errors() {
        let (dir, mgr) = setup();
        // Create a file where the workspace dir would be
        let file_path = dir.path().join("my-repo_42");
        std::fs::write(&file_path, "not a directory").unwrap();

        let result = mgr.prepare_workspace("my-repo#42");
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[test]
    fn test_workspace_root_accessor() {
        let (dir, mgr) = setup();
        assert_eq!(mgr.root(), dir.path());
    }
}
