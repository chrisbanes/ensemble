use crate::error::WorktreeError;
use crate::observability::events_contract::{
    WORKSPACE_GIT_COMMAND_FINISHED, WORKSPACE_GIT_COMMAND_STARTED,
};
use crate::observability::redaction::truncate_for_log;
use std::path::Path;
use std::sync::OnceLock;
use tokio::process::Command;
use tracing::{debug, error, info, trace, warn};

static GIT_BINARY: OnceLock<&'static str> = OnceLock::new();

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
    trace!(
        event = WORKSPACE_GIT_COMMAND_STARTED,
        repo_path = repo_path,
        command = %command,
        "starting git command"
    );

    let output = Command::new(git_binary())
        .args(args)
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|error| {
            error!(error = %error, command = %command, "Failed to spawn git command");
            WorktreeError::GitCommandFailed {
                command: command.clone(),
                reason: error.to_string(),
            }
        })?;

    trace!(
        event = WORKSPACE_GIT_COMMAND_FINISHED,
        repo_path = repo_path,
        command = %command,
        success = output.status.success(),
        exit_code = output.status.code(),
        stderr_preview = %truncate_for_log(&String::from_utf8_lossy(&output.stderr), 200),
        "finished git command"
    );

    Ok(output)
}

fn git_binary() -> &'static str {
    GIT_BINARY.get_or_init(|| {
        for git in [
            "/usr/bin/git",
            "/usr/local/bin/git",
            "/opt/homebrew/bin/git",
        ] {
            if Path::new(git).is_file() {
                return git;
            }
        }

        "git"
    })
}

fn ensure_git_success(
    output: std::process::Output,
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
    ensure_git_success(run_git(repo_path, &args, command_label).await?, |stderr| {
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
    ensure_git_success(
        run_git(repo_path, &args, git_command_label(&args)).await?,
        |stderr| {
            error!(stderr = %stderr, "Git worktree attach failed");

            WorktreeError::CreationFailed {
                repo: repo_path.to_string(),
                reason: stderr,
            }
        },
    )?;

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
    let output = ensure_git_success(
        run_git(repo_path, &args, command.clone()).await?,
        |stderr| {
            error!(stderr = %stderr, "Git worktree list command failed");

            WorktreeError::GitCommandFailed {
                command: error_command,
                reason: stderr,
            }
        },
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktree_path_normalized = super::canonicalize_allow_missing(Path::new(worktree_path));

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            let listed_path = line.strip_prefix("worktree ").unwrap_or(line);
            let listed_path_normalized = super::canonicalize_allow_missing(Path::new(listed_path));

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

/// Delete a local branch if it exists.
pub async fn delete_branch_if_exists(repo_path: &str, branch: &str) -> Result<(), WorktreeError> {
    if !branch_exists(repo_path, branch).await? {
        return Ok(());
    }

    let branch_args = ["branch", "-D", branch];
    let command = git_command_label(&branch_args);
    let error_command = command.clone();
    ensure_git_success(run_git(repo_path, &branch_args, command).await?, |stderr| {
        WorktreeError::GitCommandFailed {
            command: error_command,
            reason: stderr,
        }
    })?;

    Ok(())
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
    let _ = Command::new(git_binary())
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
    let normalized_worktree_path = super::canonicalize_allow_missing(Path::new(worktree_path));
    let normalized_worktree_path = normalized_worktree_path.to_string_lossy();
    info!(
        repo_path = %repo_path,
        worktree_path = %normalized_worktree_path,
        branch = %branch,
        "Removing worktree"
    );

    if !worktree_exists(repo_path, &normalized_worktree_path).await? {
        warn!(worktree_path = %worktree_path, "Worktree does not exist");
        return Err(WorktreeError::NotFound {
            path: worktree_path.to_string(),
        });
    }

    let args = [
        "worktree",
        "remove",
        "--force",
        normalized_worktree_path.as_ref(),
    ];
    let command = git_command_label(&args);
    let error_command = command.clone();
    ensure_git_success(
        run_git(repo_path, &args, command.clone()).await?,
        |stderr| {
            error!(stderr = %stderr, "Git worktree remove command failed");

            WorktreeError::GitCommandFailed {
                command: error_command,
                reason: stderr,
            }
        },
    )?;

    debug!(worktree_path = %worktree_path, "Worktree removed successfully");

    delete_branch_if_exists(repo_path, branch).await?;

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
    ensure_git_success(
        run_git(worktree_path, &args, command.clone()).await?,
        |stderr| {
            error!(stderr = %stderr, "Git pull command failed");

            WorktreeError::GitCommandFailed {
                command: error_command,
                reason: stderr,
            }
        },
    )?;

    debug!(worktree_path = %worktree_path, "Pull completed successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use tokio::fs;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                std::env::remove_var(key);
            }

            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[cfg(unix)]
    fn assert_git_command_failed(error: WorktreeError, expected_command: &str) {
        match error {
            WorktreeError::GitCommandFailed { command, reason } => {
                assert_eq!(command, expected_command);
                assert!(!reason.is_empty());
            }
            other => panic!("expected GitCommandFailed, got {other:?}"),
        }
    }

    #[cfg(unix)]
    fn test_output(status: i32, stderr: &[u8]) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
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

    #[cfg(unix)]
    #[test]
    fn test_ensure_git_success_returns_output_when_command_succeeds() {
        let output = test_output(0, b"");
        let result = ensure_git_success(output, |reason| WorktreeError::GitCommandFailed {
            command: "unexpected".to_string(),
            reason,
        })
        .expect("successful status should pass through");

        assert!(result.status.success());
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_git_success_maps_stderr_to_git_command_failed() {
        let output = test_output(256, b"fatal: not a git repository\n");
        let error = ensure_git_success(output, |reason| WorktreeError::GitCommandFailed {
            command: "git worktree list --porcelain".to_string(),
            reason,
        })
        .expect_err("non-zero status should fail");

        assert_git_command_failed(error, "git worktree list --porcelain");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_run_git_maps_spawn_failures_to_git_command_failed() {
        let repo_path = "/definitely/missing/repo/path";
        let error = run_git(repo_path, &["status"], "git status")
            .await
            .expect_err("missing current_dir should fail");

        assert_git_command_failed(error, "git status");
    }

    #[test]
    fn test_git_binary_works_with_missing_path() {
        let _env = EnvGuard::lock(&["PATH"]);
        std::env::set_var("PATH", "/definitely/missing");

        assert!(std::path::Path::new(git_binary()).is_file() || git_binary() == "git");
    }

    #[tokio::test]
    async fn test_run_git_uses_resolved_binary_when_path_is_missing() {
        let _env = EnvGuard::lock(&["PATH"]);
        std::env::set_var("PATH", "/definitely/missing");

        let repo = TempDir::new().unwrap();
        let output = run_git(
            repo.path().to_string_lossy().as_ref(),
            &["--version"],
            "git --version",
        )
        .await
        .expect("resolved git binary should still run");

        assert!(output.status.success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_branch_exists_reports_full_git_command_on_spawn_failure() {
        let repo_path = "/definitely/missing/repo/path";
        let error = branch_exists(repo_path, "feature")
            .await
            .expect_err("missing repo should fail");

        assert_git_command_failed(error, "git rev-parse --verify refs/heads/feature");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_remove_worktree_reports_forced_remove_command_on_failure() {
        let repo = init_test_repo().await;
        let repo_path = repo.path().to_string_lossy().into_owned();
        let error = remove_worktree(&repo_path, &repo_path, "main")
            .await
            .expect_err("removing the main worktree should fail");

        let repo_path = crate::workspace::canonicalize_allow_missing(Path::new(&repo_path));
        assert_git_command_failed(
            error,
            &format!("git worktree remove --force {}", repo_path.display()),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_remove_worktree_propagates_branch_deletion_failure() {
        let repo = init_test_repo().await;
        let repo_path = repo.path().to_string_lossy().into_owned();
        let worktree_parent = TempDir::new().expect("worktree parent");
        let worktree_path = worktree_parent.path().join("feature");
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        create_worktree(&repo_path, &worktree_path, "feature", Some("main"))
            .await
            .expect("create feature worktree");
        run_git(
            &repo_path,
            &["checkout", "--ignore-other-worktrees", "feature"],
            "git checkout --ignore-other-worktrees feature",
        )
        .await
        .expect("check out feature in the main worktree");

        let error = remove_worktree(&repo_path, &worktree_path, "feature")
            .await
            .expect_err("deleting a branch checked out elsewhere should fail");

        assert_git_command_failed(error, "git branch -D feature");
        assert!(!Path::new(&worktree_path).exists());
        assert!(branch_exists(&repo_path, "feature").await.unwrap());
    }

    #[cfg(unix)]
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
