use std::process::Command;
use tempfile::TempDir;

fn setup_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    Command::new("git")
        .args(["init"])
        .current_dir(&dir)
        .output()
        .unwrap();
    std::fs::write(dir.path().join("README.md"), "# Test").unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(&dir)
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(&dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    dir
}

#[tokio::test]
async fn test_sanitize_branch_name_basic() {
    use ensemble_core::workspace::worktree::sanitize_branch_name;

    assert_eq!(sanitize_branch_name("issue-123"), "issue-123");
    assert_eq!(sanitize_branch_name("feature/test"), "feature-test");
    assert_eq!(sanitize_branch_name("bug: fix"), "bug-fix");
}

#[tokio::test]
async fn test_create_worktree_creates_directory() {
    use ensemble_core::workspace::worktree::create_worktree;

    let repo = setup_repo();
    let worktree_path = repo.path().join("worktrees/test-branch");

    create_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        "test-branch",
        None,
    )
    .await
    .unwrap();

    assert!(worktree_path.exists());
    assert!(worktree_path.join(".git").exists());
}

#[tokio::test]
async fn test_worktree_exists_returns_true_for_existing() {
    use ensemble_core::workspace::worktree::{create_worktree, worktree_exists};

    let repo = setup_repo();
    let worktree_path = repo.path().join("worktrees/existing");

    create_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        "existing-branch",
        None,
    )
    .await
    .unwrap();

    let exists = worktree_exists(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
    )
    .await
    .unwrap();

    assert!(exists);
}

#[tokio::test]
async fn test_worktree_exists_returns_false_for_nonexistent() {
    use ensemble_core::workspace::worktree::worktree_exists;

    let repo = setup_repo();
    let worktree_path = repo.path().join("worktrees/nonexistent");

    let exists = worktree_exists(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
    )
    .await
    .unwrap();

    assert!(!exists);
}

#[tokio::test]
async fn test_remove_worktree_deletes_directory() {
    use ensemble_core::workspace::worktree::{create_worktree, remove_worktree, worktree_exists};

    let repo = setup_repo();
    let worktree_path = repo.path().join("worktrees/to-remove");
    let branch = "to-remove-branch";

    create_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        branch,
        None,
    )
    .await
    .unwrap();

    remove_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        branch,
    )
    .await
    .unwrap();

    assert!(!worktree_path.exists());
    let exists = worktree_exists(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
    )
    .await
    .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn test_create_worktree_fails_if_already_exists() {
    use ensemble_core::error::WorktreeError;
    use ensemble_core::workspace::worktree::create_worktree;

    let repo = setup_repo();
    let worktree_path = repo.path().join("worktrees/duplicate");
    let branch = "duplicate-branch";

    create_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        branch,
        None,
    )
    .await
    .unwrap();

    let result = create_worktree(
        repo.path().to_str().unwrap(),
        worktree_path.to_str().unwrap(),
        branch,
        None,
    )
    .await;

    assert!(matches!(result, Err(WorktreeError::AlreadyExists { .. })));
}
