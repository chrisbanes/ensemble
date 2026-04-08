use ensemble_core::config::ensemble::RepoConfig;
use ensemble_core::workspace::coordinator::WorktreeCoordinator;
use std::collections::HashMap;
use tempfile::TempDir;

fn setup_repo(name: &str) -> (TempDir, RepoConfig) {
    let dir = TempDir::new().unwrap();

    std::process::Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&dir)
        .output()
        .unwrap();

    std::fs::write(dir.path().join("README.md"), format!("# {}", name)).unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
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

#[tokio::test]
async fn test_prepare_worktrees_creates_all() {
    let worktree_root = TempDir::new().unwrap();
    let (_repo1_dir, repo1_config) = setup_repo("repo1");
    let (_repo2_dir, repo2_config) = setup_repo("repo2");

    let repos = HashMap::from([
        ("frontend".to_string(), repo1_config),
        ("api".to_string(), repo2_config),
    ]);

    let coordinator = WorktreeCoordinator::new(
        repos,
        "2026-03-30".to_string(),
        worktree_root.path().to_path_buf(),
    );

    let result = coordinator.prepare_worktrees("my-issue-42").await;

    assert!(result.is_ok());
    let worktrees = result.unwrap();

    assert_eq!(worktrees.len(), 2);
    assert!(worktrees.contains_key("frontend"));
    assert!(worktrees.contains_key("api"));

    let frontend_path = &worktrees["frontend"].path;
    let api_path = &worktrees["api"].path;

    assert!(frontend_path.exists());
    assert!(api_path.exists());
    assert!(worktrees["frontend"].created_now);
    assert!(worktrees["api"].created_now);
}

#[tokio::test]
async fn test_prepare_worktrees_reuses_existing() {
    let worktree_root = TempDir::new().unwrap();
    let (_repo1_dir, repo1_config) = setup_repo("repo1");

    let repos = HashMap::from([("frontend".to_string(), repo1_config)]);

    let coordinator = WorktreeCoordinator::new(
        repos,
        "2026-03-30".to_string(),
        worktree_root.path().to_path_buf(),
    );

    let result1 = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    assert!(result1["frontend"].created_now);

    let result2 = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    assert!(!result2["frontend"].created_now);
    assert_eq!(result1["frontend"].path, result2["frontend"].path);
}

#[tokio::test]
async fn test_cleanup_worktrees() {
    let worktree_root = TempDir::new().unwrap();
    let (_repo1_dir, repo1_config) = setup_repo("repo1");

    let repos = HashMap::from([("frontend".to_string(), repo1_config)]);

    let coordinator = WorktreeCoordinator::new(
        repos,
        "2026-03-30".to_string(),
        worktree_root.path().to_path_buf(),
    );

    let worktrees = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    let path = worktrees["frontend"].path.clone();
    assert!(path.exists());

    coordinator.cleanup_worktrees("my-issue-42").await.unwrap();

    assert!(!path.exists());
}

#[tokio::test]
async fn test_cleanup_worktrees_is_idempotent_when_missing() {
    let worktree_root = TempDir::new().unwrap();
    let (_repo1_dir, repo1_config) = setup_repo("repo1");

    let repos = HashMap::from([("frontend".to_string(), repo1_config)]);

    let coordinator = WorktreeCoordinator::new(
        repos,
        "2026-03-30".to_string(),
        worktree_root.path().to_path_buf(),
    );

    let result = coordinator.cleanup_worktrees("my-issue-42").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_cleanup_worktrees_propagates_failure() {
    let worktree_root = TempDir::new().unwrap();
    let repos = HashMap::from([(
        "frontend".to_string(),
        RepoConfig {
            path: "/nonexistent/path/to/repo".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
            finalize: Default::default(),
        },
    )]);

    let coordinator = WorktreeCoordinator::new(
        repos,
        "2026-03-30".to_string(),
        worktree_root.path().to_path_buf(),
    );

    let result = coordinator.cleanup_worktrees("my-issue-42").await;
    assert!(result.is_err());
}
