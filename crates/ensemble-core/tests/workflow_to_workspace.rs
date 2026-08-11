//! Integration test: load ensemble.yaml -> parse config -> create workspace -> run hooks

use ensemble_core::config::ensemble::{parse_config, EnsembleConfig, RepoConfig};
use ensemble_core::config::template::render_prompt;
use ensemble_core::tracker::model::Issue;
use ensemble_core::workspace::hooks::run_hook;
use ensemble_core::workspace::key::issue_workspace_key;
use ensemble_core::workspace::manager::WorkspaceManager;
use tempfile::TempDir;

fn sample_issue() -> Issue {
    Issue {
        id: "NODE_ABC".to_string(),
        identifier: "test-repo#7".to_string(),
        title: "Add dark mode".to_string(),
        description: Some("Users want dark mode".to_string()),
        priority: Some(2),
        tracker_position: None,
        state: "Todo".to_string(),
        branch_name: None,
        url: Some("https://github.com/acme/test-repo/issues/7".to_string()),
        labels: vec!["enhancement".to_string()],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

fn make_config(ws_root: &std::path::Path) -> EnsembleConfig {
    let yaml = format!(
        r#"
tracker:
  kind: github
  repository: acme/test-repo
  api_key: fake-token
workspace:
  root: {}
agent:
  command: echo hello
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "You are working on {{{{ issue.identifier }}}}: {{{{ issue.title }}}}"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
concurrency:
  max_concurrent_agents: 3
hooks:
  after_create: 'echo "workspace created"'
"#,
        ws_root.display()
    );
    parse_config(&yaml).unwrap()
}

#[tokio::test]
async fn test_full_config_flow() {
    let dir = TempDir::new().unwrap();
    let ws_root = dir.path().join("workspaces");

    // 1. Parse config
    let config = make_config(&ws_root);
    assert_eq!(config.tracker.kind, "github");
    assert_eq!(config.tracker.repository.as_deref(), Some("acme/test-repo"));
    assert_eq!(config.concurrency.max_concurrent_agents, 3);
    assert_eq!(
        config.workspace.root.as_deref(),
        Some(ws_root.to_str().unwrap())
    );

    // 2. Render prompt from an agent's inline prompt
    let issue = sample_issue();
    let prompt_template = config
        .agents
        .get("build")
        .unwrap()
        .prompt
        .as_deref()
        .unwrap();
    let prompt = render_prompt(prompt_template, &issue, None).unwrap();
    assert!(prompt.contains("test-repo#7"));
    assert!(prompt.contains("Add dark mode"));

    // 3. Create workspace
    let mgr = WorkspaceManager::new(&ws_root, None).unwrap();
    let ws = mgr
        .prepare_workspace(&issue.id, &issue.identifier)
        .await
        .unwrap();
    assert!(ws.created_now);
    assert!(ws.base_path.is_dir());
    assert_eq!(ws.workspace_key, issue_workspace_key(&issue.id));

    // 4. Reuse workspace
    let ws2 = mgr
        .prepare_workspace(&issue.id, &issue.identifier)
        .await
        .unwrap();
    assert!(!ws2.created_now);
    assert_eq!(ws.base_path, ws2.base_path);

    // 5. Cleanup
    mgr.remove_workspace(&issue.id).await.unwrap();
    assert!(!ws.base_path.exists());
}

#[tokio::test]
async fn test_hook_in_workspace() {
    let dir = TempDir::new().unwrap();
    let mgr = WorkspaceManager::new(dir.path(), None).unwrap();
    let ws = mgr
        .prepare_workspace("NODE_HOOK", "hook-test#1")
        .await
        .unwrap();

    // Run a hook that creates a file
    run_hook(
        "after_create",
        "echo 'initialized' > .ensemble-init",
        &ws.base_path,
        5000,
    )
    .await
    .unwrap();

    let marker = ws.base_path.join(".ensemble-init");
    assert!(marker.exists());
    let content = std::fs::read_to_string(&marker).unwrap();
    assert_eq!(content.trim(), "initialized");
}

fn setup_git_repo(name: &str) -> TempDir {
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
    dir
}

#[tokio::test]
async fn test_workflow_with_worktrees() {
    let ws_dir = TempDir::new().unwrap();
    let repo_dir = setup_git_repo("test-repo");

    let repos = vec![RepoConfig {
        path: repo_dir.path().to_string_lossy().to_string(),
        branch: "main".to_string(),
        git_remote: "origin".to_string(),
        finalize: Default::default(),
    }];

    let mgr = WorkspaceManager::new(ws_dir.path(), Some(repos)).unwrap();
    let issue = sample_issue();

    // Create workspace with worktrees
    let ws = mgr
        .prepare_workspace(&issue.id, &issue.identifier)
        .await
        .unwrap();
    assert!(ws.created_now);
    assert!(ws.base_path.is_dir());
    assert!(!ws.worktrees.is_empty());

    assert_eq!(ws.worktrees.len(), 1);
    let (repo_key, worktree_info) = ws.worktrees.iter().next().unwrap();
    assert!(worktree_info.path.exists());
    assert!(worktree_info.created_now);
    assert!(worktree_info.path.join("README.md").exists());

    // Reuse workspace
    let ws2 = mgr
        .prepare_workspace(&issue.id, &issue.identifier)
        .await
        .unwrap();
    assert!(!ws2.created_now);
    let worktree_info2 = ws2.worktrees.get(repo_key).unwrap();
    assert!(!worktree_info2.created_now);
    assert_eq!(worktree_info.path, worktree_info2.path);

    // Cleanup
    let wt_path = worktree_info.path.clone();
    mgr.remove_workspace(&issue.id).await.unwrap();
    assert!(!ws.base_path.exists());
    assert!(!wt_path.exists());
}

#[tokio::test]
async fn collision_resistant_issue_workspace_lifecycle() {
    let root = TempDir::new().unwrap();
    let manager = WorkspaceManager::new(root.path(), None).unwrap();
    let first = Issue {
        id: "NODE_A".to_string(),
        identifier: "a#b".to_string(),
        ..sample_issue()
    };
    let second = Issue {
        id: "NODE_B".to_string(),
        identifier: "a_b".to_string(),
        ..sample_issue()
    };

    let first_workspace = manager
        .prepare_workspace(&first.id, &first.identifier)
        .await
        .unwrap();
    let second_workspace = manager
        .prepare_workspace(&second.id, &second.identifier)
        .await
        .unwrap();
    assert_ne!(first_workspace.base_path, second_workspace.base_path);

    let reused = manager
        .prepare_workspace(&first.id, &first.identifier)
        .await
        .unwrap();
    assert_eq!(reused.base_path, first_workspace.base_path);
    assert!(!reused.created_now);

    manager.remove_workspace(&first.id).await.unwrap();
    assert!(!first_workspace.base_path.exists());
    assert!(second_workspace.base_path.exists());
}
