use crate::config::ensemble::RepoConfig;
use crate::error::WorktreeError;
use crate::workspace::worktree::{
    create_worktree, pull_worktree, remove_worktree, sanitize_branch_name, worktree_exists,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

/// Information about a created/found worktree.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    /// Absolute path to the worktree directory.
    pub path: PathBuf,
    /// The branch name used for this worktree.
    pub branch: String,
    /// Whether this worktree was created in this call (false = reused existing).
    pub created_now: bool,
}

/// Coordinates worktree lifecycle across multiple repositories.
pub struct WorktreeCoordinator {
    repos: HashMap<String, RepoConfig>,
    base_date: String,
}

impl WorktreeCoordinator {
    pub fn new(repos: HashMap<String, RepoConfig>, base_date: String) -> Self {
        Self { repos, base_date }
    }

    /// Prepare worktrees for all configured repos for the given issue.
    ///
    /// All-or-nothing: if any creation fails, already-created worktrees are rolled back.
    pub async fn prepare_worktrees(
        &self,
        issue_id: &str,
    ) -> Result<HashMap<String, WorktreeInfo>, WorktreeError> {
        let branch = self.format_branch_name(issue_id);
        let mut created = HashMap::new();
        let mut newly_created = Vec::new();

        info!(issue_id, branch, "preparing worktrees for issue");

        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);

            if !repo_path.exists() {
                error!(repo = %repo_path.display(), "repo path does not exist");
                self.rollback(&created, &newly_created).await;
                return Err(WorktreeError::InvalidRepoPath {
                    path: repo_config.path.clone(),
                });
            }

            let worktree_path = repo_path.join(".worktrees").join(&branch);
            let worktree_path_str = worktree_path.to_string_lossy().to_string();
            let repo_path_str = &repo_config.path;

            match worktree_exists(repo_path_str, &worktree_path_str).await? {
                true => {
                    info!(repo = repo_name, "reusing existing worktree");

                    if let Err(e) = pull_worktree(
                        &worktree_path_str,
                        &repo_config.branch,
                        &repo_config.git_remote,
                    )
                    .await
                    {
                        warn!(repo = repo_name, error = %e, "failed to pull, continuing");
                    }

                    created.insert(
                        repo_name.clone(),
                        WorktreeInfo {
                            path: worktree_path,
                            branch: branch.clone(),
                            created_now: false,
                        },
                    );
                }
                false => {
                    info!(repo = repo_name, path = %worktree_path.display(), "creating new worktree");

                    if let Err(e) =
                        create_worktree(repo_path_str, &worktree_path_str, &branch).await
                    {
                        error!(repo = repo_name, error = %e, "failed to create worktree");
                        self.rollback(&created, &newly_created).await;
                        return Err(e);
                    }

                    newly_created.push(repo_name.clone());
                    created.insert(
                        repo_name.clone(),
                        WorktreeInfo {
                            path: worktree_path,
                            branch: branch.clone(),
                            created_now: true,
                        },
                    );
                }
            }
        }

        info!(count = created.len(), "worktrees prepared successfully");
        Ok(created)
    }

    /// Clean up worktrees and delete branches for the given issue.
    pub async fn cleanup_worktrees(&self, issue_id: &str) -> Result<(), WorktreeError> {
        let branch = self.format_branch_name(issue_id);

        info!(issue_id, branch, "cleaning up worktrees");

        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);
            let worktree_path = repo_path.join(".worktrees").join(&branch);
            let worktree_path_str = worktree_path.to_string_lossy().to_string();

            if let Err(e) = remove_worktree(&repo_config.path, &worktree_path_str, &branch).await {
                warn!(repo = repo_name, error = %e, "failed to cleanup worktree (continuing)");
            }
        }

        Ok(())
    }

    /// List expected worktree paths for an issue without creating them.
    pub fn list_worktree_paths(&self, issue_id: &str) -> HashMap<String, PathBuf> {
        let branch = self.format_branch_name(issue_id);
        let mut paths = HashMap::new();

        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);
            let worktree_path = repo_path.join(".worktrees").join(&branch);
            paths.insert(repo_name.clone(), worktree_path);
        }

        paths
    }

    fn format_branch_name(&self, issue_id: &str) -> String {
        let sanitized = sanitize_branch_name(issue_id);
        format!("ensemble-{}-{}", self.base_date, sanitized)
    }

    async fn rollback(
        &self,
        all_worktrees: &HashMap<String, WorktreeInfo>,
        newly_created: &[String],
    ) {
        info!("rolling back partially created worktrees");

        for repo_name in newly_created {
            if let Some(info) = all_worktrees.get(repo_name) {
                if let Some(repo_config) = self.repos.get(repo_name) {
                    let worktree_path_str = info.path.to_string_lossy().to_string();
                    if let Err(e) =
                        remove_worktree(&repo_config.path, &worktree_path_str, &info.branch).await
                    {
                        error!(repo = %repo_name, error = %e, "rollback cleanup failed");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_branch_name() {
        let repos = HashMap::new();
        let coordinator = WorktreeCoordinator::new(repos, "2026-03-30".to_string());

        let branch = coordinator.format_branch_name("my-repo#42");
        assert_eq!(branch, "ensemble-2026-03-30-my-repo#42");
    }
}
