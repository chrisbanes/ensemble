//! Integration test: load WORKFLOW.md -> parse config -> create workspace -> run hooks

use ensemble_core::config::template::render_prompt;
use ensemble_core::config::typed::ServiceConfig;
use ensemble_core::config::workflow::load_workflow;
use ensemble_core::tracker::model::{sanitize_workspace_key, Issue};
use ensemble_core::workspace::hooks::run_hook;
use ensemble_core::workspace::manager::WorkspaceManager;
use tempfile::TempDir;

fn sample_issue() -> Issue {
    Issue {
        id: "NODE_ABC".to_string(),
        identifier: "test-repo#7".to_string(),
        title: "Add dark mode".to_string(),
        description: Some("Users want dark mode".to_string()),
        priority: Some(2),
        state: "Todo".to_string(),
        branch_name: None,
        url: Some("https://github.com/acme/test-repo/issues/7".to_string()),
        labels: vec!["enhancement".to_string()],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

#[test]
fn test_full_config_flow() {
    let dir = TempDir::new().unwrap();
    let workflow_path = dir.path().join("WORKFLOW.md");
    let ws_root = dir.path().join("workspaces");

    std::fs::write(
        &workflow_path,
        format!(
            r#"---
tracker:
  kind: github
  repository: acme/test-repo
  api_key: fake-token
workspace:
  root: {}
agent:
  command: echo hello
  max_concurrent_agents: 3
hooks:
  after_create: echo "workspace created"
---
You are working on {{{{ issue.identifier }}}}: {{{{ issue.title }}}}

Description: {{{{ issue.description }}}}

{{%- if attempt %}}This is retry attempt {{{{ attempt }}}}.{{%- endif %}}
"#,
            ws_root.display()
        ),
    )
    .unwrap();

    // 1. Load workflow
    let workflow = load_workflow(&workflow_path).unwrap();
    assert!(!workflow.prompt_template.is_empty());

    // 2. Parse config
    let config = ServiceConfig::from_workflow(&workflow).unwrap();
    assert_eq!(config.tracker_kind.as_deref(), Some("github"));
    assert_eq!(config.tracker_repository.as_deref(), Some("acme/test-repo"));
    assert_eq!(config.agent_max_concurrent, 3);
    assert_eq!(config.workspace_root, ws_root);

    // 3. Validate for dispatch
    assert!(config.validate_for_dispatch().is_ok());

    // 4. Render prompt
    let issue = sample_issue();
    let prompt = render_prompt(&workflow.prompt_template, &issue, None).unwrap();
    assert!(prompt.contains("test-repo#7"));
    assert!(prompt.contains("Add dark mode"));
    assert!(prompt.contains("Users want dark mode"));
    assert!(!prompt.contains("retry attempt"));

    // Render with retry
    let retry_prompt = render_prompt(&workflow.prompt_template, &issue, Some(2)).unwrap();
    assert!(retry_prompt.contains("retry attempt 2"));

    // 5. Create workspace
    let mgr = WorkspaceManager::new(&config.workspace_root).unwrap();
    let ws = mgr.prepare_workspace(&issue.identifier).unwrap();
    assert!(ws.created_now);
    assert!(ws.path.is_dir());
    assert_eq!(
        ws.workspace_key,
        sanitize_workspace_key(&issue.identifier).unwrap()
    );

    // 6. Reuse workspace
    let ws2 = mgr.prepare_workspace(&issue.identifier).unwrap();
    assert!(!ws2.created_now);
    assert_eq!(ws.path, ws2.path);

    // 7. Cleanup
    mgr.remove_workspace(&issue.identifier).unwrap();
    assert!(!ws.path.exists());
}

#[tokio::test]
async fn test_hook_in_workspace() {
    let dir = TempDir::new().unwrap();
    let mgr = WorkspaceManager::new(dir.path()).unwrap();
    let ws = mgr.prepare_workspace("hook-test#1").unwrap();

    // Run a hook that creates a file
    run_hook(
        "after_create",
        "echo 'initialized' > .ensemble-init",
        &ws.path,
        5000,
    )
    .await
    .unwrap();

    let marker = ws.path.join(".ensemble-init");
    assert!(marker.exists());
    let content = std::fs::read_to_string(&marker).unwrap();
    assert_eq!(content.trim(), "initialized");
}
