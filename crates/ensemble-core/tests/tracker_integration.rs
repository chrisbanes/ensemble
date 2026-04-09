//! Integration test: create a todo_file tracker from config, write a TODO.md, fetch candidates.

use ensemble_core::config::ensemble::TrackerConfig;
use ensemble_core::tracker::create_tracker;
use tempfile::TempDir;

fn todo_file_tracker_config(path: std::path::PathBuf) -> TrackerConfig {
    TrackerConfig {
        kind: "todo_file".to_string(),
        active_states: vec!["Todo".to_string(), "In Progress".to_string()],
        terminal_states: vec!["Done".to_string(), "Closed".to_string()],
        path: Some(path),
        endpoint: None,
        gh_hostname: None,
        api_key: None,
        repository: None,
        project_number: None,
        labels_filter: vec![],
        notion: None,
        database_id: None,
        notion_version: "2022-06-28".to_string(),
        title_property: "Name".to_string(),
        status_property: "Status".to_string(),
        enabled_property: "Ready to Implement".to_string(),
        enabled_value_bool: true,
    }
}

#[tokio::test]
async fn test_todo_file_tracker_via_factory() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    // Write a TODO.md
    std::fs::write(
        &todo_path,
        r#"## Todo
- [PROJ-1] Add login page
  The login page needs a form.
- [PROJ-2] Fix checkout bug

## In Progress
- [PROJ-3] Refactor auth module
  Breaking out the auth logic.

## Done
- [PROJ-4] Set up CI pipeline
"#,
    )
    .unwrap();

    let config = todo_file_tracker_config(todo_path);

    // Create tracker via factory
    let tracker = create_tracker(&config).unwrap();

    // Fetch candidates (active states: Todo, In Progress)
    let candidates = tracker.fetch_candidate_issues().await.unwrap();
    assert_eq!(candidates.len(), 3);

    // Verify ordering: document order
    assert_eq!(candidates[0].identifier, "PROJ-1");
    assert_eq!(candidates[0].title, "Add login page");
    assert_eq!(
        candidates[0].description.as_deref(),
        Some("The login page needs a form.")
    );
    assert_eq!(candidates[0].state, "Todo");
    assert_eq!(candidates[0].priority, Some(0));

    assert_eq!(candidates[1].identifier, "PROJ-2");
    assert_eq!(candidates[1].title, "Fix checkout bug");
    assert_eq!(candidates[1].description, None);
    assert_eq!(candidates[1].state, "Todo");
    assert_eq!(candidates[1].priority, Some(1));

    assert_eq!(candidates[2].identifier, "PROJ-3");
    assert_eq!(candidates[2].title, "Refactor auth module");
    assert_eq!(
        candidates[2].description.as_deref(),
        Some("Breaking out the auth logic.")
    );
    assert_eq!(candidates[2].state, "In Progress");
    assert_eq!(candidates[2].priority, Some(0));

    // Verify normalization: labels, blocked_by, branch_name, url are empty/null
    for issue in &candidates {
        assert!(issue.labels.is_empty());
        assert!(issue.blocked_by.is_empty());
        assert!(issue.branch_name.is_none());
        assert!(issue.url.is_none());
        assert!(issue.created_at.is_none());
        assert!(issue.updated_at.is_none());
    }
}

#[tokio::test]
async fn test_todo_file_tracker_fetch_by_states() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    std::fs::write(
        &todo_path,
        r#"## Todo
- [A] Alpha

## Done
- [B] Beta

## Blocked
- [C] Charlie
"#,
    )
    .unwrap();

    let config = todo_file_tracker_config(todo_path);
    let tracker = create_tracker(&config).unwrap();

    // Fetch terminal states
    let done = tracker
        .fetch_issues_by_states(&["Done".to_string()])
        .await
        .unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].identifier, "B");
    assert_eq!(done[0].state, "Done");

    // Fetch multiple states
    let multi = tracker
        .fetch_issues_by_states(&["Todo".to_string(), "Blocked".to_string()])
        .await
        .unwrap();
    assert_eq!(multi.len(), 2);
    assert_eq!(multi[0].identifier, "A");
    assert_eq!(multi[1].identifier, "C");
}

#[tokio::test]
async fn test_todo_file_tracker_fetch_states_by_ids() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    std::fs::write(
        &todo_path,
        r#"## Todo
- [X-1] First

## In Progress
- [X-2] Second

## Done
- [X-3] Third
"#,
    )
    .unwrap();

    let config = todo_file_tracker_config(todo_path);
    let tracker = create_tracker(&config).unwrap();

    let issues = tracker
        .fetch_issue_states_by_ids(&["X-1".to_string(), "X-3".to_string()])
        .await
        .unwrap();

    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0].identifier, "X-1");
    assert_eq!(issues[0].state, "Todo");
    assert_eq!(issues[1].identifier, "X-3");
    assert_eq!(issues[1].state, "Done");
}

#[tokio::test]
async fn test_factory_rejects_unsupported_kind() {
    let config = TrackerConfig {
        kind: "jira".to_string(),
        active_states: vec!["Todo".to_string()],
        terminal_states: vec!["Done".to_string()],
        path: None,
        endpoint: None,
        gh_hostname: None,
        api_key: None,
        repository: None,
        project_number: None,
        labels_filter: vec![],
        notion: None,
        database_id: None,
        notion_version: "2022-06-28".to_string(),
        title_property: "Name".to_string(),
        status_property: "Status".to_string(),
        enabled_property: "Ready to Implement".to_string(),
        enabled_value_bool: true,
    };

    let result = create_tracker(&config);
    assert!(result.is_err());
}
