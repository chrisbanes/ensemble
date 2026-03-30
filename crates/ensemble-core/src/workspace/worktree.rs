use crate::error::WorktreeError;
use std::path::Path;
use tokio::process::Command;
use tracing::{debug, error, info, warn};

/// Sanitize an issue identifier for use in git branch names.
///
/// Rules (per spec): all non-alphanumeric chars → `-`, collapse consecutive
/// dashes, strip leading/trailing dashes, lowercase everything.
pub fn sanitize_branch_name(identifier: &str) -> String {
    let mut result = String::with_capacity(identifier.len());
    let mut last_was_dash = true; // true to strip leading dashes

    for c in identifier.chars() {
        if c.is_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            result.push('-');
            last_was_dash = true;
        }
    }

    if result.ends_with('-') {
        result.pop();
    }

    result
}

/// Create a worktree with a new branch, optionally based on a start point.
///
/// If `start_point` is provided (e.g. "main"), the new branch is created from
/// that ref instead of HEAD.
pub async fn create_worktree(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
    start_point: Option<&str>,
) -> Result<(), WorktreeError> {
    let repo = Path::new(repo_path);
    if !repo.join(".git").exists() {
        error!(repo_path = %repo_path, "Invalid repo path - no .git directory");
        return Err(WorktreeError::InvalidRepoPath {
            path: repo_path.to_string(),
        });
    }

    if worktree_exists(repo_path, worktree_path).await? {
        warn!(worktree_path = %worktree_path, "Worktree already exists");
        return Err(WorktreeError::AlreadyExists {
            path: worktree_path.to_string(),
        });
    }

    info!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        branch = %branch,
        start_point = ?start_point,
        "Creating worktree with new branch"
    );

    let mut args = vec!["worktree", "add", "-b", branch, worktree_path];
    if let Some(sp) = start_point {
        args.push(sp);
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| {
            error!(error = %e, "Failed to spawn git worktree add command");
            WorktreeError::GitCommandFailed {
                command: format!("git worktree add -b {} {}", branch, worktree_path),
                reason: e.to_string(),
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(stderr = %stderr, "Git worktree add command failed");

        if stderr.contains("already exists") {
            return Err(WorktreeError::AlreadyExists {
                path: worktree_path.to_string(),
            });
        }

        return Err(WorktreeError::CreationFailed {
            repo: repo_path.to_string(),
            reason: stderr.to_string(),
        });
    }

    debug!(worktree_path = %worktree_path, "Worktree created successfully");
    Ok(())
}

/// Attach a worktree to an existing branch (no `-b`).
///
/// Use this when the branch already exists but the worktree directory is missing.
pub async fn attach_worktree(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
) -> Result<(), WorktreeError> {
    info!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        branch = %branch,
        "Attaching worktree to existing branch"
    );

    let output = Command::new("git")
        .args(["worktree", "add", worktree_path, branch])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: format!("git worktree add {} {}", worktree_path, branch),
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(stderr = %stderr, "Git worktree attach failed");
        return Err(WorktreeError::CreationFailed {
            repo: repo_path.to_string(),
            reason: stderr.to_string(),
        });
    }

    debug!(worktree_path = %worktree_path, "Worktree attached successfully");
    Ok(())
}

pub async fn worktree_exists(repo_path: &str, worktree_path: &str) -> Result<bool, WorktreeError> {
    debug!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        "Checking if worktree exists"
    );

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| {
            error!(error = %e, "Failed to spawn git worktree list command");
            WorktreeError::GitCommandFailed {
                command: "git worktree list --porcelain".to_string(),
                reason: e.to_string(),
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(stderr = %stderr, "Git worktree list command failed");
        return Err(WorktreeError::GitCommandFailed {
            command: "git worktree list --porcelain".to_string(),
            reason: stderr.to_string(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktree_path_normalized = Path::new(worktree_path)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(worktree_path).to_path_buf());

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            let listed_path = line.strip_prefix("worktree ").unwrap_or(line);
            let listed_path_normalized = Path::new(listed_path)
                .canonicalize()
                .unwrap_or_else(|_| Path::new(listed_path).to_path_buf());

            if listed_path_normalized == worktree_path_normalized {
                debug!(worktree_path = %worktree_path, "Worktree found in list");
                return Ok(true);
            }
        }
    }

    debug!(worktree_path = %worktree_path, "Worktree not found in list");
    Ok(false)
}

/// Check if a local branch exists in the repo.
pub async fn branch_exists(repo_path: &str, branch: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git rev-parse".to_string(),
            reason: e.to_string(),
        })?;

    Ok(output.status.success())
}

/// Remove an orphaned worktree directory that is not registered in git.
///
/// This handles the case where the directory exists but `git worktree list`
/// doesn't know about it (e.g. branch was deleted, or previous cleanup was
/// interrupted).
pub async fn remove_orphaned_worktree(
    repo_path: &str,
    worktree_path: &str,
) -> Result<(), WorktreeError> {
    warn!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        "Removing orphaned worktree directory"
    );

    // Try git worktree prune first to clean stale entries
    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repo_path)
        .output()
        .await;

    // Remove the directory
    let path = Path::new(worktree_path);
    if path.exists() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|e| WorktreeError::GitCommandFailed {
                command: format!("remove orphaned dir {}", worktree_path),
                reason: e.to_string(),
            })?;
    }

    Ok(())
}

pub async fn remove_worktree(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
) -> Result<(), WorktreeError> {
    info!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        branch = %branch,
        "Removing worktree"
    );

    if !worktree_exists(repo_path, worktree_path).await? {
        warn!(worktree_path = %worktree_path, "Worktree does not exist");
        return Err(WorktreeError::NotFound {
            path: worktree_path.to_string(),
        });
    }

    let output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| {
            error!(error = %e, "Failed to spawn git worktree remove command");
            WorktreeError::GitCommandFailed {
                command: format!("git worktree remove {}", worktree_path),
                reason: e.to_string(),
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(stderr = %stderr, "Git worktree remove command failed");
        return Err(WorktreeError::GitCommandFailed {
            command: format!("git worktree remove {}", worktree_path),
            reason: stderr.to_string(),
        });
    }

    debug!(worktree_path = %worktree_path, "Worktree removed successfully");

    let branch_output = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_path)
        .output()
        .await;

    match branch_output {
        Ok(output) => {
            if output.status.success() {
                debug!(branch = %branch, "Branch deleted successfully");
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                warn!(stderr = %stderr, branch = %branch, "Failed to delete branch");
            }
        }
        Err(e) => {
            warn!(error = %e, branch = %branch, "Failed to spawn branch delete command");
        }
    }

    Ok(())
}

pub async fn pull_worktree(
    worktree_path: &str,
    branch: &str,
    remote: &str,
) -> Result<(), WorktreeError> {
    info!(
        worktree_path = %worktree_path,
        branch = %branch,
        remote = %remote,
        "Pulling latest changes"
    );

    let worktree = Path::new(worktree_path);
    if !worktree.join(".git").exists() {
        error!(worktree_path = %worktree_path, "Invalid worktree path - no .git file");
        return Err(WorktreeError::NotFound {
            path: worktree_path.to_string(),
        });
    }

    let output = Command::new("git")
        .args(["pull", remote, branch])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| {
            error!(error = %e, "Failed to spawn git pull command");
            WorktreeError::GitCommandFailed {
                command: format!("git pull {} {}", remote, branch),
                reason: e.to_string(),
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(stderr = %stderr, "Git pull command failed");
        return Err(WorktreeError::GitCommandFailed {
            command: format!("git pull {} {}", remote, branch),
            reason: stderr.to_string(),
        });
    }

    debug!(worktree_path = %worktree_path, "Pull completed successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_branch_name_basic() {
        assert_eq!(sanitize_branch_name("issue-123"), "issue-123");
        assert_eq!(sanitize_branch_name("feature/test"), "feature-test");
        assert_eq!(sanitize_branch_name("bug: fix"), "bug-fix");
        assert_eq!(sanitize_branch_name("with space"), "with-space");
        assert_eq!(sanitize_branch_name("with\ttab"), "with-tab");
    }

    #[test]
    fn test_sanitize_branch_name_multiple_special() {
        assert_eq!(
            sanitize_branch_name("feat/JIRA-123: add feature"),
            "feat-jira-123-add-feature"
        );
    }

    #[test]
    fn test_sanitize_branch_name_no_change() {
        assert_eq!(
            sanitize_branch_name("valid-branch-name"),
            "valid-branch-name"
        );
        // underscores are non-alphanumeric, so they become dashes
        assert_eq!(sanitize_branch_name("issue_123"), "issue-123");
    }

    #[test]
    fn test_sanitize_branch_name_spec_examples() {
        assert_eq!(sanitize_branch_name("my-repo#42"), "my-repo-42");
        assert_eq!(sanitize_branch_name("acme/api#123"), "acme-api-123");
        assert_eq!(
            sanitize_branch_name("FEATURE_Add Dark Mode!!!"),
            "feature-add-dark-mode"
        );
        assert_eq!(sanitize_branch_name("--test--"), "test");
    }
}
