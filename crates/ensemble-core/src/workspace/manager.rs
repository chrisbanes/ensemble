use crate::config::ensemble::{repository_key, HooksConfig, RepoConfig};
use crate::error::WorkspaceError;
use crate::observability::events_contract::{
    elapsed_ms, WORKSPACE_PREPARE_FAILED, WORKSPACE_PREPARE_FINISHED, WORKSPACE_PREPARE_STARTED,
};
use crate::workspace::coordinator::{WorktreeCoordinator, WorktreeInfo};
use crate::workspace::hooks::run_hook_best_effort;
use crate::workspace::key::issue_workspace_key;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tracing::{info, warn};

const WORKSPACE_METADATA_DIR: &str = ".ensemble-workspace-metadata";
type WorkspaceLifecycleLock = tokio::sync::Mutex<()>;
type WorkspaceLifecycleLockRegistry = Mutex<HashMap<PathBuf, Weak<WorkspaceLifecycleLock>>>;
static WORKSPACE_LIFECYCLE_LOCKS: OnceLock<WorkspaceLifecycleLockRegistry> = OnceLock::new();

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct WorkspaceMetadata {
    issue_id: String,
    issue_identifier: String,
    branch_date: String,
}

/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
    repos: HashMap<String, RepoConfig>,
    hooks: HooksConfig,
    #[cfg(test)]
    preparation_test_barriers: Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
    #[cfg(test)]
    removal_test_barriers: Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
}

/// Result of preparing a workspace for an issue.
#[derive(Debug)]
pub struct WorkspaceResult {
    /// Absolute path to the base workspace directory (logs, artifacts).
    pub base_path: PathBuf,
    /// Map of repo name to worktree info (if repos configured).
    pub worktrees: HashMap<String, WorktreeInfo>,
    /// The collision-resistant workspace key used as the directory name.
    pub workspace_key: String,
    /// True if the directory was newly created (not reused).
    pub created_now: bool,
}

pub(crate) fn resolve_workspace_root(root: &Path) -> Result<PathBuf, WorkspaceError> {
    if root.is_absolute() {
        Ok(root.to_path_buf())
    } else {
        let current_dir =
            std::env::current_dir().map_err(|error| WorkspaceError::CreationFailed {
                reason: format!("cannot resolve relative root: {error}"),
            })?;
        Ok(current_dir.join(root))
    }
}

impl WorkspaceManager {
    /// Create a new WorkspaceManager with the given workspace root.
    /// The root is normalized to an absolute path.
    /// Pass `repos` to enable worktree-based workspace isolation.
    /// Repo names are derived from path basenames.
    pub fn new(root: &Path, repos: Option<Vec<RepoConfig>>) -> Result<Self, WorkspaceError> {
        Self::new_with_hooks(root, repos, HooksConfig::default())
    }

    /// Create a workspace manager with lifecycle hook configuration.
    pub fn new_with_hooks(
        root: &Path,
        repos: Option<Vec<RepoConfig>>,
        hooks: HooksConfig,
    ) -> Result<Self, WorkspaceError> {
        let root = resolve_workspace_root(root)?;

        let repos_map = repos
            .filter(|r| !r.is_empty())
            .map(|repo_list| {
                let mut repos_map = HashMap::new();
                for (index, repo) in repo_list.into_iter().enumerate() {
                    let name = repository_key(&repo, index);
                    repos_map.insert(name, repo);
                }
                repos_map
            })
            .unwrap_or_default();

        Ok(Self {
            root,
            repos: repos_map,
            hooks,
            #[cfg(test)]
            preparation_test_barriers: None,
            #[cfg(test)]
            removal_test_barriers: None,
        })
    }

    /// Get the absolute workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Get configured repositories keyed by derived repo name.
    pub fn repos(&self) -> &HashMap<String, RepoConfig> {
        &self.repos
    }

    /// Get the workspace path for an immutable issue identity without creating it.
    pub fn workspace_path(&self, issue_id: &str) -> PathBuf {
        self.root.join(issue_workspace_key(issue_id))
    }

    /// Resolve paths for an existing issue-owned workspace without preparing or pulling it.
    pub(crate) fn owned_worktree_paths(
        &self,
        issue_id: &str,
    ) -> Result<HashMap<String, PathBuf>, WorkspaceError> {
        let metadata = self.load_metadata(issue_id)?;
        Self::verify_ownership(&self.metadata_path(issue_id), &metadata, issue_id)?;
        let coordinator = WorktreeCoordinator::new(
            self.repos.clone(),
            metadata.branch_date,
            self.workspace_path(issue_id),
        );
        Ok(coordinator.worktree_paths(issue_id))
    }

    fn metadata_dir(&self) -> PathBuf {
        self.root.join(WORKSPACE_METADATA_DIR)
    }

    fn metadata_path(&self, issue_id: &str) -> PathBuf {
        self.metadata_dir()
            .join(format!("{}.json", issue_workspace_key(issue_id)))
    }

    #[cfg(test)]
    pub(crate) fn metadata_path_for_test(&self, issue_id: &str) -> PathBuf {
        self.metadata_path(issue_id)
    }

    fn lifecycle_lock(&self, workspace_key: &str) -> Arc<WorkspaceLifecycleLock> {
        let canonical_root = Self::canonicalize_allow_missing(&self.root);
        let path = canonical_root.join(workspace_key);
        let mut locks = WORKSPACE_LIFECYCLE_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(WorkspaceLifecycleLock::new(()));
        locks.insert(path, Arc::downgrade(&lock));
        lock
    }

    #[cfg(test)]
    fn set_preparation_test_barriers(
        &mut self,
        after_lock: Arc<tokio::sync::Barrier>,
        resume_preparation: Arc<tokio::sync::Barrier>,
    ) {
        self.preparation_test_barriers = Some((after_lock, resume_preparation));
    }

    #[cfg(test)]
    fn set_removal_test_barriers(
        &mut self,
        after_verification: Arc<tokio::sync::Barrier>,
        resume_removal: Arc<tokio::sync::Barrier>,
    ) {
        self.removal_test_barriers = Some((after_verification, resume_removal));
    }

    fn load_metadata(&self, issue_id: &str) -> Result<WorkspaceMetadata, WorkspaceError> {
        let metadata_path = self.metadata_path(issue_id);
        self.validate_path_inside_root(&self.metadata_dir())?;
        let content = std::fs::read_to_string(&metadata_path).map_err(|error| {
            WorkspaceError::MetadataUnavailable {
                path: metadata_path.display().to_string(),
                reason: error.to_string(),
            }
        })?;
        serde_json::from_str(&content).map_err(|error| WorkspaceError::MetadataUnavailable {
            path: metadata_path.display().to_string(),
            reason: error.to_string(),
        })
    }

    fn serialize_metadata(
        issue_id: &str,
        identifier: &str,
        date: &str,
    ) -> Result<Vec<u8>, WorkspaceError> {
        serde_json::to_vec(&WorkspaceMetadata {
            issue_id: issue_id.to_string(),
            issue_identifier: identifier.to_string(),
            branch_date: date.to_string(),
        })
        .map_err(|error| WorkspaceError::CreationFailed {
            reason: format!("failed to serialize workspace metadata: {error}"),
        })
    }

    fn write_metadata_temp(
        &self,
        content: &[u8],
    ) -> Result<tempfile::NamedTempFile, WorkspaceError> {
        let metadata_dir = self.metadata_dir();
        let mut file = tempfile::NamedTempFile::new_in(&metadata_dir).map_err(|error| {
            WorkspaceError::CreationFailed {
                reason: format!("failed to create temporary workspace metadata: {error}"),
            }
        })?;
        file.write_all(content)
            .and_then(|()| file.as_file().sync_all())
            .map_err(|error| WorkspaceError::CreationFailed {
                reason: format!("failed to persist temporary workspace metadata: {error}"),
            })?;
        Ok(file)
    }

    fn create_metadata(
        &self,
        issue_id: &str,
        identifier: &str,
        date: &str,
    ) -> Result<(), WorkspaceError> {
        let metadata_dir = self.metadata_dir();
        std::fs::create_dir_all(&metadata_dir).map_err(|error| WorkspaceError::CreationFailed {
            reason: format!("failed to create workspace metadata directory: {error}"),
        })?;
        self.validate_path_inside_root(&metadata_dir)?;

        let content = Self::serialize_metadata(issue_id, identifier, date)?;
        self.write_metadata_temp(&content)?
            .persist_noclobber(self.metadata_path(issue_id))
            .map_err(|error| WorkspaceError::CreationFailed {
                reason: format!("failed to create workspace metadata: {}", error.error),
            })?;
        Ok(())
    }

    fn refresh_metadata(
        &self,
        issue_id: &str,
        identifier: &str,
        date: &str,
    ) -> Result<(), WorkspaceError> {
        let content = Self::serialize_metadata(issue_id, identifier, date)?;
        self.write_metadata_temp(&content)?
            .persist(self.metadata_path(issue_id))
            .map_err(|error| WorkspaceError::CreationFailed {
                reason: format!("failed to refresh workspace metadata: {}", error.error),
            })?;
        Ok(())
    }

    fn verify_ownership(
        metadata_path: &Path,
        metadata: &WorkspaceMetadata,
        issue_id: &str,
    ) -> Result<(), WorkspaceError> {
        if metadata.issue_id == issue_id {
            return Ok(());
        }
        Err(WorkspaceError::OwnershipMismatch {
            path: metadata_path.display().to_string(),
            expected_issue_id: issue_id.to_string(),
            actual_issue_id: metadata.issue_id.clone(),
        })
    }

    /// Prepare (create or reuse) a workspace for the given immutable issue identity.
    pub async fn prepare_workspace(
        &self,
        issue_id: &str,
        identifier: &str,
    ) -> Result<WorkspaceResult, WorkspaceError> {
        let prepare_started_at = std::time::Instant::now();
        info!(
            event = WORKSPACE_PREPARE_STARTED,
            issue_identifier = identifier,
            "preparing workspace"
        );
        let workspace_key = issue_workspace_key(issue_id);
        let _lifecycle_guard = self.lifecycle_lock(&workspace_key).lock_owned().await;
        #[cfg(test)]
        if let Some((after_lock, resume_preparation)) = &self.preparation_test_barriers {
            after_lock.wait().await;
            resume_preparation.wait().await;
        }
        let base_path = self.root.join(&workspace_key);

        // Safety: ensure workspace path is inside root
        self.validate_path_inside_root(&base_path)?;

        let (base_created, metadata) = if base_path.exists() {
            if !base_path.is_dir() {
                return Err(WorkspaceError::CreationFailed {
                    reason: format!(
                        "path exists but is not a directory: {}",
                        base_path.display()
                    ),
                });
            }
            let mut metadata = self.load_metadata(issue_id)?;
            Self::verify_ownership(&self.metadata_path(issue_id), &metadata, issue_id)?;
            if metadata.issue_identifier != identifier {
                self.refresh_metadata(issue_id, identifier, &metadata.branch_date)?;
                metadata.issue_identifier = identifier.to_string();
            }
            (false, metadata)
        } else {
            std::fs::create_dir_all(&self.root).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("workspace root mkdir failed: {e}"),
            })?;
            std::fs::create_dir(&base_path).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("mkdir failed: {e}"),
            })?;
            let branch_date = chrono::Local::now().format("%Y-%m-%d").to_string();
            let metadata = match self.create_metadata(issue_id, identifier, &branch_date) {
                Ok(()) => WorkspaceMetadata {
                    issue_id: issue_id.to_string(),
                    issue_identifier: identifier.to_string(),
                    branch_date,
                },
                Err(create_error) => match self.load_metadata(issue_id) {
                    Ok(mut existing) => {
                        if let Err(error) = Self::verify_ownership(
                            &self.metadata_path(issue_id),
                            &existing,
                            issue_id,
                        ) {
                            let _ = std::fs::remove_dir(&base_path);
                            return Err(error);
                        }
                        if existing.issue_identifier != identifier {
                            if let Err(error) =
                                self.refresh_metadata(issue_id, identifier, &existing.branch_date)
                            {
                                let _ = std::fs::remove_dir(&base_path);
                                return Err(error);
                            }
                            existing.issue_identifier = identifier.to_string();
                        }
                        existing
                    }
                    Err(load_error) => {
                        let metadata_exists = self.metadata_path(issue_id).exists();
                        let _ = std::fs::remove_dir(&base_path);
                        return Err(if metadata_exists {
                            load_error
                        } else {
                            create_error
                        });
                    }
                },
            };
            if !base_path.is_dir() {
                if let Err(cleanup_error) = std::fs::remove_dir_all(&base_path) {
                    warn!(
                        workspace = %base_path.display(),
                        error = %cleanup_error,
                        "failed to remove workspace after metadata persistence failed"
                    );
                }
                return Err(WorkspaceError::CreationFailed {
                    reason: format!("workspace path is not a directory: {}", base_path.display()),
                });
            }
            (true, metadata)
        };

        // Prepare worktrees if repos configured
        let worktrees = if !self.repos.is_empty() {
            let coordinator = WorktreeCoordinator::new(
                self.repos.clone(),
                metadata.branch_date,
                base_path.clone(),
            );
            info!(workspace = %base_path.display(), "preparing worktrees inside workspace");
            match coordinator.prepare_worktrees(issue_id).await {
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

    /// Remove a workspace directory and its worktrees for the given immutable issue identity.
    pub async fn remove_workspace(&self, issue_id: &str) -> Result<(), WorkspaceError> {
        let workspace_key = issue_workspace_key(issue_id);
        let _lifecycle_guard = self.lifecycle_lock(&workspace_key).lock_owned().await;
        let base_path = self.root.join(&workspace_key);

        self.validate_path_inside_root(&base_path)?;
        if !base_path.exists() {
            let metadata_path = self.metadata_path(issue_id);
            if !metadata_path.exists() {
                return Ok(());
            }
            let metadata = self.load_metadata(issue_id)?;
            Self::verify_ownership(&metadata_path, &metadata, issue_id)?;
            std::fs::remove_file(&metadata_path).map_err(|error| {
                WorkspaceError::CreationFailed {
                    reason: format!("failed to remove workspace metadata: {error}"),
                }
            })?;
            return Ok(());
        }
        let metadata_path = self.metadata_path(issue_id);
        let metadata = self.load_metadata(issue_id)?;
        Self::verify_ownership(&metadata_path, &metadata, issue_id)?;
        #[cfg(test)]
        if let Some((after_verification, resume_removal)) = &self.removal_test_barriers {
            after_verification.wait().await;
            resume_removal.wait().await;
        }

        if let Some(script) = &self.hooks.before_remove {
            run_hook_best_effort("before_remove", script, &base_path, self.hooks.timeout_ms).await;
        }

        // Clean up worktrees first - use persisted branch date to avoid date drift
        if !self.repos.is_empty() {
            let coordinator = WorktreeCoordinator::new(
                self.repos.clone(),
                metadata.branch_date,
                base_path.clone(),
            );
            warn!(workspace = %base_path.display(), "cleaning up worktrees");
            coordinator.cleanup_worktrees(issue_id).await.map_err(|e| {
                WorkspaceError::CreationFailed {
                    reason: format!("worktree cleanup failed: {e}"),
                }
            })?;
        }

        // Remove base workspace
        if base_path.exists() {
            std::fs::remove_dir_all(&base_path).map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("remove failed: {e}"),
            })?;
        }
        std::fs::remove_file(&metadata_path).map_err(|error| WorkspaceError::CreationFailed {
            reason: format!("failed to remove workspace metadata: {error}"),
        })?;
        Ok(())
    }

    /// Validate that a workspace path is inside the workspace root.
    ///
    /// Both the root and the candidate path are canonicalized (symlinks resolved)
    /// so that the `starts_with` check is reliable on platforms such as macOS where
    /// `/var/folders/...` is a symlink to `/private/var/folders/...`.
    ///
    /// When `path` does not yet exist (pre-creation), its nearest existing ancestor
    /// is canonicalized and the missing components are re-appended.
    fn validate_path_inside_root(&self, path: &Path) -> Result<(), WorkspaceError> {
        let canonical_root = Self::canonicalize_allow_missing(&self.root);
        let canonical_path = Self::canonicalize_allow_missing(path);

        if !canonical_path.starts_with(&canonical_root) {
            return Err(WorkspaceError::PathOutsideRoot {
                path: canonical_path.display().to_string(),
            });
        }
        Ok(())
    }

    fn canonicalize_allow_missing(path: &Path) -> PathBuf {
        let mut existing = path;
        let mut missing = Vec::new();
        while !existing.exists() {
            let (Some(parent), Some(file_name)) = (existing.parent(), existing.file_name()) else {
                return path.to_path_buf();
            };
            missing.push(file_name.to_os_string());
            existing = parent;
        }

        let mut canonical = existing
            .canonicalize()
            .unwrap_or_else(|_| existing.to_path_buf());
        for component in missing.into_iter().rev() {
            canonical.push(component);
        }
        canonical
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
            finalize: Default::default(),
        };

        (dir, config)
    }

    fn setup() -> (TempDir, WorkspaceManager) {
        let dir = TempDir::new().unwrap();
        let mgr = WorkspaceManager::new(dir.path(), None).unwrap();
        (dir, mgr)
    }

    #[tokio::test]
    async fn workspace_ownership_new_workspace_persists_identity_without_repositories() {
        let (_dir, mgr) = setup();

        let result = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata: WorkspaceMetadata =
            serde_json::from_str(&std::fs::read_to_string(mgr.metadata_path("NODE_42")).unwrap())
                .unwrap();

        assert_eq!(metadata.issue_id, "NODE_42");
        assert_eq!(metadata.issue_identifier, "my-repo#42");
        assert!(!result.base_path.join(".ensemble-workspace.json").exists());
    }

    #[tokio::test]
    async fn owned_worktree_paths_resolves_existing_paths_without_preparation() {
        let root = TempDir::new().unwrap();
        let (_repo, config) = setup_repo("owned");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![config])).unwrap();
        let prepared = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();

        let resolved = mgr.owned_worktree_paths("NODE_42").unwrap();

        assert_eq!(
            resolved,
            prepared
                .worktrees
                .into_iter()
                .map(|(name, worktree)| (name, worktree.path))
                .collect()
        );
    }

    #[tokio::test]
    async fn workspace_ownership_mismatch_blocks_reuse_without_modifying_workspace() {
        let (_dir, mgr) = setup();
        let base_path = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap()
            .base_path;
        std::fs::write(
            mgr.metadata_path("NODE_42"),
            r#"{"issue_id":"NODE_OTHER","issue_identifier":"other#7","branch_date":"2024-01-01"}"#,
        )
        .unwrap();
        let sentinel = base_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();

        let error = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap_err();

        assert!(matches!(error, WorkspaceError::OwnershipMismatch { .. }));
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn workspace_ownership_mismatch_blocks_removal_without_modifying_workspace() {
        let (_dir, mgr) = setup();
        let base_path = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap()
            .base_path;
        std::fs::write(
            mgr.metadata_path("NODE_42"),
            r#"{"issue_id":"NODE_OTHER","issue_identifier":"other#7","branch_date":"2024-01-01"}"#,
        )
        .unwrap();
        let sentinel = base_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();

        let error = mgr.remove_workspace("NODE_42").await.unwrap_err();

        assert!(matches!(error, WorkspaceError::OwnershipMismatch { .. }));
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn workspace_ownership_malformed_metadata_blocks_reuse_and_removal() {
        let (_dir, mgr) = setup();
        let base_path = mgr.workspace_path("NODE_42");
        std::fs::create_dir_all(&base_path).unwrap();
        std::fs::create_dir_all(mgr.metadata_dir()).unwrap();
        std::fs::write(mgr.metadata_path("NODE_42"), "{not-json").unwrap();
        let sentinel = base_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();

        assert!(matches!(
            mgr.prepare_workspace("NODE_42", "my-repo#42").await,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert!(matches!(
            mgr.remove_workspace("NODE_42").await,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn test_prepare_creates_new_workspace() {
        let (_dir, mgr) = setup();
        let result = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        assert!(result.created_now);
        assert_eq!(result.workspace_key, issue_workspace_key("NODE_42"));
        assert!(result.base_path.is_dir());
    }

    #[tokio::test]
    async fn workspace_ownership_reuses_existing_workspace_for_exact_owner() {
        let (_dir, mgr) = setup();
        let first = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        assert!(first.created_now);

        let second = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        assert!(!second.created_now);
        assert_eq!(first.base_path, second.base_path);
    }

    #[tokio::test]
    async fn workspace_ownership_reuses_and_removes_workspace_after_identifier_changes() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let first = mgr
            .prepare_workspace("NODE_42", "old-repo#42")
            .await
            .unwrap();
        let second = mgr
            .prepare_workspace("NODE_42", "renamed-repo#42")
            .await
            .unwrap();

        assert_eq!(first.base_path, second.base_path);
        assert!(!second.created_now);
        let first_worktree = first.worktrees.values().next().unwrap();
        let second_worktree = second.worktrees.values().next().unwrap();
        assert_eq!(first_worktree.path, second_worktree.path);
        assert_eq!(first_worktree.branch, second_worktree.branch);
        let metadata = mgr.load_metadata("NODE_42").unwrap();
        assert_eq!(metadata.issue_id, "NODE_42");
        assert_eq!(metadata.issue_identifier, "renamed-repo#42");

        mgr.remove_workspace("NODE_42").await.unwrap();
        assert!(!first.base_path.exists());
    }

    #[tokio::test]
    async fn workspace_ownership_distinct_ids_with_colliding_readable_forms_isolate_worktrees() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let first = mgr.prepare_workspace("a#b", "repo#1").await.unwrap();
        let second = mgr.prepare_workspace("a_b", "repo#2").await.unwrap();
        let first_worktree = first.worktrees.values().next().unwrap();
        let second_worktree = second.worktrees.values().next().unwrap();

        assert_ne!(first.base_path, second.base_path);
        assert_ne!(first_worktree.path, second_worktree.path);
        assert_ne!(first_worktree.branch, second_worktree.branch);
        assert!(first_worktree.path.exists());
        assert!(second_worktree.path.exists());

        mgr.remove_workspace("a#b").await.unwrap();
        mgr.remove_workspace("a_b").await.unwrap();
        assert!(!first.base_path.exists());
        assert!(!second.base_path.exists());
    }

    #[tokio::test]
    async fn workspace_ownership_agent_workspace_metadata_tampering_cannot_change_authority() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let first = mgr
            .prepare_workspace("NODE_42", "old-repo#42")
            .await
            .unwrap();
        let workspace_metadata = first.base_path.join(".ensemble-workspace.json");
        std::fs::write(
            &workspace_metadata,
            r#"{"issue_id":"NODE_OTHER","issue_identifier":"other#7","branch_date":"2024-01-01"}"#,
        )
        .unwrap();

        let reused = mgr
            .prepare_workspace("NODE_42", "renamed-repo#42")
            .await
            .unwrap();
        assert_eq!(first.base_path, reused.base_path);
        assert!(!reused.created_now);

        std::fs::write(&workspace_metadata, "{not-json").unwrap();
        mgr.prepare_workspace("NODE_42", "renamed-again#42")
            .await
            .unwrap();
        std::fs::remove_file(workspace_metadata).unwrap();

        mgr.remove_workspace("NODE_42").await.unwrap();
        assert!(!first.base_path.exists());
    }

    #[tokio::test]
    async fn workspace_ownership_sidecar_create_never_clobbers_an_existing_owner() {
        let (_dir, mgr) = setup();
        let metadata_path = mgr.metadata_path("NODE_42");
        std::fs::create_dir_all(mgr.metadata_dir()).unwrap();
        let original =
            r#"{"issue_id":"NODE_OTHER","issue_identifier":"other#7","branch_date":"2024-01-01"}"#;
        std::fs::write(&metadata_path, original).unwrap();

        let error = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap_err();

        assert!(matches!(error, WorkspaceError::OwnershipMismatch { .. }));
        assert_eq!(std::fs::read_to_string(metadata_path).unwrap(), original);
        assert!(!mgr.workspace_path("NODE_42").exists());
    }

    #[tokio::test]
    async fn workspace_ownership_corrupt_leftover_sidecar_fails_closed() {
        let (_dir, mgr) = setup();
        let metadata_path = mgr.metadata_path("NODE_42");
        std::fs::create_dir_all(mgr.metadata_dir()).unwrap();
        std::fs::write(&metadata_path, "{not-json").unwrap();

        let error = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap_err();

        assert!(matches!(error, WorkspaceError::MetadataUnavailable { .. }));
        assert_eq!(std::fs::read_to_string(metadata_path).unwrap(), "{not-json");
        assert!(!mgr.workspace_path("NODE_42").exists());
    }

    #[tokio::test]
    async fn workspace_ownership_removal_cleans_the_authoritative_sidecar() {
        let (_dir, mgr) = setup();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");
        assert!(metadata_path.exists());

        mgr.remove_workspace("NODE_42").await.unwrap();

        assert!(!workspace.base_path.exists());
        assert!(!metadata_path.exists());
    }

    #[tokio::test]
    async fn workspace_ownership_absent_workspace_finishes_valid_sidecar_cleanup() {
        let (_dir, mgr) = setup();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");
        std::fs::remove_dir_all(workspace.base_path).unwrap();

        mgr.remove_workspace("NODE_42").await.unwrap();

        assert!(!metadata_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_ownership_identifier_refresh_failure_preserves_valid_sidecar() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, mgr) = setup();
        let workspace = mgr
            .prepare_workspace("NODE_42", "old-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");
        let original = std::fs::read_to_string(&metadata_path).unwrap();
        let metadata_dir = mgr.metadata_dir();
        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = mgr.prepare_workspace("NODE_42", "renamed-repo#42").await;

        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
        assert_eq!(std::fs::read_to_string(metadata_path).unwrap(), original);
        assert!(workspace.base_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_ownership_sidecar_create_failure_removes_new_workspace() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, mgr) = setup();
        let metadata_dir = mgr.metadata_dir();
        std::fs::create_dir(&metadata_dir).unwrap();
        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = mgr.prepare_workspace("NODE_42", "my-repo#42").await;

        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
        assert!(!mgr.workspace_path("NODE_42").exists());
        assert!(!mgr.metadata_path("NODE_42").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_ownership_interrupted_sidecar_cleanup_is_retryable() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, mgr) = setup();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");
        let metadata_dir = mgr.metadata_dir();
        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let first_removal = mgr.remove_workspace("NODE_42").await;

        std::fs::set_permissions(&metadata_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            first_removal,
            Err(WorkspaceError::CreationFailed { .. })
        ));
        assert!(!workspace.base_path.exists());
        assert!(metadata_path.exists());

        mgr.remove_workspace("NODE_42").await.unwrap();
        assert!(!metadata_path.exists());
    }

    #[tokio::test]
    async fn workspace_ownership_prepare_waits_for_same_issue_removal_transaction() {
        let root = TempDir::new().unwrap();
        let mut removing_mgr = WorkspaceManager::new(root.path(), None).unwrap();
        removing_mgr
            .prepare_workspace("NODE_42", "old-repo#42")
            .await
            .unwrap();
        let after_verification = Arc::new(tokio::sync::Barrier::new(2));
        let resume_removal = Arc::new(tokio::sync::Barrier::new(2));
        removing_mgr.set_removal_test_barriers(
            Arc::clone(&after_verification),
            Arc::clone(&resume_removal),
        );
        let removing_mgr = Arc::new(removing_mgr);
        let preparing_mgr = Arc::new(WorkspaceManager::new(root.path(), None).unwrap());

        let removal = {
            let mgr = Arc::clone(&removing_mgr);
            tokio::spawn(async move { mgr.remove_workspace("NODE_42").await })
        };
        after_verification.wait().await;
        let mut preparation = {
            let mgr = Arc::clone(&preparing_mgr);
            tokio::spawn(async move { mgr.prepare_workspace("NODE_42", "renamed-repo#42").await })
        };

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut preparation)
                .await
                .is_err(),
            "prepare must wait while removal owns the issue lifecycle transaction"
        );

        resume_removal.wait().await;
        removal.await.unwrap().unwrap();
        let prepared = preparation.await.unwrap().unwrap();
        let metadata = preparing_mgr.load_metadata("NODE_42").unwrap();
        assert!(prepared.base_path.exists());
        assert_eq!(metadata.issue_id, "NODE_42");
        assert_eq!(metadata.issue_identifier, "renamed-repo#42");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_ownership_missing_root_aliases_share_one_lifecycle_transaction() {
        use std::os::unix::fs::symlink;

        let physical_parent = TempDir::new().unwrap();
        let alias_parent = TempDir::new().unwrap();
        let alias = alias_parent.path().join("workspace-parent");
        symlink(physical_parent.path(), &alias).unwrap();
        let physical_root = physical_parent.path().join("missing-root");
        let alias_root = alias.join("missing-root");
        let after_lock = Arc::new(tokio::sync::Barrier::new(2));
        let resume_preparation = Arc::new(tokio::sync::Barrier::new(2));

        let mut first_mgr = WorkspaceManager::new(&alias_root, None).unwrap();
        first_mgr.set_preparation_test_barriers(
            Arc::clone(&after_lock),
            Arc::clone(&resume_preparation),
        );
        let first_mgr = Arc::new(first_mgr);
        let second_mgr = Arc::new(WorkspaceManager::new(&physical_root, None).unwrap());

        let first_preparation = {
            let mgr = Arc::clone(&first_mgr);
            tokio::spawn(async move { mgr.prepare_workspace("NODE_42", "my-repo#42").await })
        };
        after_lock.wait().await;
        let mut second_preparation = {
            let mgr = Arc::clone(&second_mgr);
            tokio::spawn(async move { mgr.prepare_workspace("NODE_42", "my-repo#42").await })
        };

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                &mut second_preparation
            )
            .await
            .is_err(),
            "canonical and symlinked missing roots must share one lifecycle lock"
        );

        resume_preparation.wait().await;
        let first = first_preparation.await.unwrap().unwrap();
        let second = second_preparation.await.unwrap().unwrap();
        assert_eq!(
            first.base_path.canonicalize().unwrap(),
            second.base_path.canonicalize().unwrap()
        );
        assert!(second.base_path.exists());
        assert_eq!(
            second_mgr.load_metadata("NODE_42").unwrap().issue_id,
            "NODE_42"
        );
    }

    #[tokio::test]
    async fn test_prepare_sanitizes_issue_id() {
        let (_dir, mgr) = setup();
        let result = mgr
            .prepare_workspace("acme/NODE 123!@#", "acme/repo#123")
            .await
            .unwrap();
        assert_eq!(
            result.workspace_key,
            issue_workspace_key("acme/NODE 123!@#")
        );
        assert!(result.base_path.is_dir());
    }

    #[tokio::test]
    async fn test_prepare_deterministic_path() {
        let (_dir, mgr) = setup();
        let r1 = mgr
            .prepare_workspace("NODE_TEST", "test-issue")
            .await
            .unwrap();
        let r2 = mgr
            .prepare_workspace("NODE_TEST", "test-issue")
            .await
            .unwrap();
        assert_eq!(r1.base_path, r2.base_path);
    }

    #[tokio::test]
    async fn test_remove_workspace() {
        let (_dir, mgr) = setup();
        mgr.prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();

        let ws_path = mgr.workspace_path("NODE_42");
        assert!(ws_path.exists());

        mgr.remove_workspace("NODE_42").await.unwrap();
        assert!(!ws_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn before_remove_hook_runs_in_base_workspace_before_worktree_cleanup() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let repo_name = Path::new(&repo.path).file_name().unwrap().to_str().unwrap();
        let hooks = crate::config::ensemble::HooksConfig {
            before_remove: Some(format!("test -d {repo_name} && pwd > ../before-remove-cwd")),
            ..Default::default()
        };
        let mgr = WorkspaceManager::new_with_hooks(root.path(), Some(vec![repo]), hooks).unwrap();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let marker = root.path().join("before-remove-cwd");

        mgr.remove_workspace("NODE_42").await.unwrap();

        let expected_cwd = mgr
            .root()
            .canonicalize()
            .unwrap()
            .join(&workspace.workspace_key);
        assert_eq!(
            std::fs::read_to_string(marker).unwrap().trim(),
            expected_cwd.display().to_string()
        );
        assert!(!workspace.base_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn before_remove_hook_failure_does_not_block_cleanup() {
        let root = TempDir::new().unwrap();
        let hooks = HooksConfig {
            before_remove: Some("false".to_string()),
            ..Default::default()
        };
        let mgr = WorkspaceManager::new_with_hooks(root.path(), None, hooks).unwrap();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");

        mgr.remove_workspace("NODE_42").await.unwrap();

        assert!(!workspace.base_path.exists());
        assert!(!metadata_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn before_remove_hook_timeout_does_not_block_cleanup() {
        let root = TempDir::new().unwrap();
        let hooks = HooksConfig {
            before_remove: Some("while :; do :; done".to_string()),
            timeout_ms: 25,
            ..Default::default()
        };
        let mgr = WorkspaceManager::new_with_hooks(root.path(), None, hooks).unwrap();
        let workspace = mgr
            .prepare_workspace("NODE_42", "my-repo#42")
            .await
            .unwrap();
        let metadata_path = mgr.metadata_path("NODE_42");

        mgr.remove_workspace("NODE_42").await.unwrap();

        assert!(!workspace.base_path.exists());
        assert!(!metadata_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn before_remove_hook_is_not_run_for_an_absent_workspace() {
        let root = TempDir::new().unwrap();
        let marker = root.path().join("before-remove-ran");
        let hooks = HooksConfig {
            before_remove: Some("touch ../before-remove-ran".to_string()),
            ..Default::default()
        };
        let mgr = WorkspaceManager::new_with_hooks(root.path(), None, hooks).unwrap();

        mgr.remove_workspace("NODE_MISSING").await.unwrap();
        mgr.remove_workspace("NODE_MISSING").await.unwrap();

        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_is_ok() {
        let (_dir, mgr) = setup();
        assert!(mgr.remove_workspace("NODE_MISSING").await.is_ok());
    }

    #[tokio::test]
    async fn test_path_inside_root_validation() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("NODE_NORMAL", "normal-issue").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_file_at_workspace_path_errors() {
        let (_dir, mgr) = setup();
        let file_path = mgr.workspace_path("NODE_42");
        std::fs::write(&file_path, "not a directory").unwrap();

        let result = mgr.prepare_workspace("NODE_42", "my-repo#42").await;
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[tokio::test]
    async fn test_dot_issue_id_uses_safe_workspace_key() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace(".", "repo#dot").await.unwrap();
        assert!(result.base_path.is_dir());
    }

    #[tokio::test]
    async fn test_dotdot_issue_id_uses_safe_workspace_key() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("..", "repo#dotdot").await.unwrap();
        assert!(result.base_path.is_dir());
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

        mgr.create_metadata("NODE_TEST", "test-workspace", "2024-06-15")
            .unwrap();

        let loaded = mgr.load_metadata("NODE_TEST").unwrap();
        assert_eq!(loaded.branch_date, "2024-06-15");
    }

    #[tokio::test]
    async fn test_remove_workspace_uses_persisted_branch_date() {
        let dir = TempDir::new().unwrap();

        let issue_id = "NODE_TEST";
        let workspace_key = issue_workspace_key(issue_id);
        let test_path = dir.path().join(&workspace_key);
        std::fs::create_dir_all(&test_path).unwrap();

        let repos = vec![RepoConfig {
            path: "/nonexistent/path".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
            finalize: Default::default(),
        }];
        let mgr = WorkspaceManager::new(dir.path(), Some(repos)).unwrap();
        mgr.create_metadata(issue_id, "test-issue", "2020-01-01")
            .unwrap();

        let result = mgr.remove_workspace(issue_id).await;
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
            finalize: Default::default(),
        }];
        let mgr = WorkspaceManager::new(dir.path(), Some(repos)).unwrap();

        let ws_path = mgr.workspace_path("NODE_CLEANUP");
        std::fs::create_dir_all(&ws_path).unwrap();
        mgr.create_metadata("NODE_CLEANUP", "cleanup-test", "2020-01-01")
            .unwrap();

        let remove_result = mgr.remove_workspace("NODE_CLEANUP").await;
        assert!(remove_result.is_err());

        assert!(
            ws_path.exists(),
            "workspace should not be deleted when cleanup fails"
        );
    }

    #[tokio::test]
    async fn workspace_ownership_missing_metadata_workspace_fails_closed() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let identifier = "legacy#42";
        let issue_id = "NODE_LEGACY";
        let workspace_key = issue_workspace_key(issue_id);
        let base_path = root.path().join(workspace_key);
        std::fs::create_dir_all(&base_path).unwrap();

        assert!(!mgr.metadata_path(issue_id).exists());

        let sentinel = base_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();
        let result = mgr.prepare_workspace(issue_id, identifier).await;
        assert!(matches!(
            result,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert!(matches!(
            mgr.remove_workspace(issue_id).await,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn workspace_ownership_ownerless_legacy_metadata_fails_closed() {
        let root = TempDir::new().unwrap();
        let (_repo_dir, repo) = setup_repo("repo1");
        let mgr = WorkspaceManager::new(root.path(), Some(vec![repo])).unwrap();

        let identifier = "legacy#43";
        let issue_id = "NODE_LEGACY_METADATA";
        let workspace_key = issue_workspace_key(issue_id);
        let base_path = root.path().join(workspace_key);
        std::fs::create_dir_all(&base_path).unwrap();
        std::fs::write(
            base_path.join(".ensemble-workspace.json"),
            r#"{"branch_date":"2020-01-01"}"#,
        )
        .unwrap();

        let sentinel = base_path.join("sentinel");
        std::fs::write(&sentinel, "untouched").unwrap();
        assert!(matches!(
            mgr.prepare_workspace(issue_id, identifier).await,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert!(matches!(
            mgr.remove_workspace(issue_id).await,
            Err(WorkspaceError::MetadataUnavailable { .. })
        ));
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "untouched");
    }
}
