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

fn git_command_label(args: &[&str]) -> String {
    format!("git {}", args.join(" "))
}

async fn run_git(
    repo_path: &str,
    args: &[&str],
    command_label: impl Into<String>,
) -> Result<std::process::Output, WorktreeError> {
    let command = command_label.into();
    Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|error| {
            error!(error = %error, command = %command, "Failed to spawn git command");
            WorktreeError::GitCommandFailed {
                command,
                reason: error.to_string(),
            }
        })
}

fn ensure_git_success(
    output: std::process::Output,
    _command: &str,
    error: impl FnOnce(String) -> WorktreeError,
) -> Result<std::process::Output, WorktreeError> {
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(error(stderr))
    }
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

    let command_label = git_command_label(&args);
    ensure_git_success(run_git(repo_path, &args, command_label).await?, "git worktree add", |stderr| {
        error!(stderr = %stderr, "Git worktree add command failed");

        if stderr.contains("already exists") {
            WorktreeError::AlreadyExists {
                path: worktree_path.to_string(),
            }
        } else {
            WorktreeError::CreationFailed {
                repo: repo_path.to_string(),
                reason: stderr,
            }
        }
    })?;

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

    let args = ["worktree", "add", worktree_path, branch];
    ensure_git_success(run_git(repo_path, &args, git_command_label(&args)).await?, "git worktree add", |stderr| {
        error!(stderr = %stderr, "Git worktree attach failed");

        WorktreeError::CreationFailed {
            repo: repo_path.to_string(),
            reason: stderr,
        }
    })?;

    debug!(worktree_path = %worktree_path, "Worktree attached successfully");
    Ok(())
}

pub async fn worktree_exists(repo_path: &str, worktree_path: &str) -> Result<bool, WorktreeError> {
    debug!(
        repo_path = %repo_path,
        worktree_path = %worktree_path,
        "Checking if worktree exists"
    );

    let args = ["worktree", "list", "--porcelain"];
    let command = git_command_label(&args);
    let error_command = command.clone();
    let output = ensure_git_success(run_git(repo_path, &args, command.clone()).await?, &command, |stderr| {
        error!(stderr = %stderr, "Git worktree list command failed");

        WorktreeError::GitCommandFailed {
            command: error_command,
            reason: stderr,
        }
    })?;

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
    let branch_ref = format!("refs/heads/{branch}");
    let args = ["rev-parse", "--verify", branch_ref.as_str()];
    let output = run_git(repo_path, &args, git_command_label(&args)).await?;

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

    let args = ["worktree", "remove", "--force", worktree_path];
    let command = git_command_label(&args);
    let error_command = command.clone();
    ensure_git_success(run_git(repo_path, &args, command.clone()).await?, &command, |stderr| {
        error!(stderr = %stderr, "Git worktree remove command failed");

        WorktreeError::GitCommandFailed {
            command: error_command,
            reason: stderr,
        }
    })?;

    debug!(worktree_path = %worktree_path, "Worktree removed successfully");

    let branch_args = ["branch", "-D", branch];
    let branch_output = run_git(repo_path, &branch_args, git_command_label(&branch_args)).await;

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

    let args = ["pull", remote, branch];
    let command = git_command_label(&args);
    let error_command = command.clone();
    ensure_git_success(run_git(worktree_path, &args, command.clone()).await?, &command, |stderr| {
        error!(stderr = %stderr, "Git pull command failed");

        WorktreeError::GitCommandFailed {
            command: error_command,
            reason: stderr,
        }
    })?;

    debug!(worktree_path = %worktree_path, "Pull completed successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use tempfile::TempDir;
    use tokio::fs;

    fn assert_git_command_failed(error: WorktreeError, expected_command: &str) {
        match error {
            WorktreeError::GitCommandFailed { command, reason } => {
                assert_eq!(command, expected_command);
                assert!(!reason.is_empty());
            }
            other => panic!("expected GitCommandFailed, got {other:?}"),
        }
    }

    fn test_output(status: i32, stderr: &[u8]) -> std::process::Output {
        std::process::Output {
            status: std::process::ExitStatus::from_raw(status),
            stdout: Vec::new(),
            stderr: stderr.to_vec(),
        }
    }

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

    #[test]
    fn test_git_command_label_prefixes_git_and_joins_args() {
        assert_eq!(
            git_command_label(&["worktree", "list", "--porcelain"]),
            "git worktree list --porcelain"
        );
        assert_eq!(
            git_command_label(&["pull", "origin", "main"]),
            "git pull origin main"
        );
    }

    #[test]
    fn test_ensure_git_success_returns_output_when_command_succeeds() {
        let output = test_output(0, b"");
        let result = ensure_git_success(output, "git status", |reason| {
            WorktreeError::GitCommandFailed {
                command: "unexpected".to_string(),
                reason,
            }
        })
        .expect("successful status should pass through");

        assert!(result.status.success());
    }

    #[test]
    fn test_ensure_git_success_maps_stderr_to_git_command_failed() {
        let output = test_output(256, b"fatal: not a git repository\n");
        let error = ensure_git_success(output, "git worktree list --porcelain", |reason| {
            WorktreeError::GitCommandFailed {
                command: "git worktree list --porcelain".to_string(),
                reason,
            }
        })
        .expect_err("non-zero status should fail");

        assert_git_command_failed(error, "git worktree list --porcelain");
    }

    #[tokio::test]
    async fn test_run_git_maps_spawn_failures_to_git_command_failed() {
        let repo_path = "/definitely/missing/repo/path";
        let error = run_git(repo_path, &["status"], "git status")
            .await
            .expect_err("missing current_dir should fail");

        assert_git_command_failed(error, "git status");
    }

    #[tokio::test]
    async fn test_branch_exists_reports_full_git_command_on_spawn_failure() {
        let repo_path = "/definitely/missing/repo/path";
        let error = branch_exists(repo_path, "feature")
            .await
            .expect_err("missing repo should fail");

        assert_git_command_failed(error, "git rev-parse --verify refs/heads/feature");
    }

    #[tokio::test]
    async fn test_remove_worktree_reports_forced_remove_command_on_failure() {
        let repo = init_test_repo().await;
        let repo_path = repo.path().to_string_lossy().into_owned();
        let error = remove_worktree(&repo_path, &repo_path, "main")
            .await
            .expect_err("removing the main worktree should fail");

        assert_git_command_failed(error, &format!("git worktree remove --force {repo_path}"));
    }

    async fn init_test_repo() -> TempDir {
        let repo = TempDir::new().expect("temp dir");
        let repo_path = repo.path().to_string_lossy().into_owned();

        fs::write(repo.path().join("README.md"), "test\n")
            .await
            .expect("write readme");

        run_git(&repo_path, &["init", "-b", "main"], "git init")
            .await
            .expect("git init");
        run_git(
            &repo_path,
            &["config", "user.name", "Test User"],
            "git config user.name",
        )
        .await
        .expect("git config user.name");
        run_git(
            &repo_path,
            &["config", "user.email", "test@example.com"],
            "git config user.email",
        )
        .await
        .expect("git config user.email");
        run_git(&repo_path, &["add", "README.md"], "git add README.md")
            .await
            .expect("git add");
        run_git(&repo_path, &["commit", "-m", "init"], "git commit -m init")
            .await
            .expect("git commit");

        repo
    }
}
