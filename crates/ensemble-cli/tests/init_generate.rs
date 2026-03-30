#[test]
fn test_generated_config_parses_successfully() {
    let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
  active_states:
    - Todo
  terminal_states:
    - Done

repos:
  - path: /tmp/test-repo
    branch: main

agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid

steps:
  - name: implement
    agent: builder
    tracker_state: In Progress

on_success: Done
on_failure: Failed
"#;

    let config = ensemble_core::config::ensemble::parse_config(yaml).unwrap();
    assert_eq!(config.tracker.kind, "todo_file");
    assert_eq!(config.repos.len(), 1);
    assert_eq!(config.repos[0].branch, "main");
    assert_eq!(config.agents.len(), 1);
    assert_eq!(
        config.agents["builder"].acpx_agent.as_deref(),
        Some("claude")
    );
    assert!(config.agents["builder"].executor.is_none());
    assert!(config.agents["builder"].model.is_none());
    assert_eq!(config.steps.len(), 1);
    assert_eq!(config.on_success, "Done");

    ensemble_core::config::ensemble::validate_config(&config).unwrap();
    ensemble_core::pipeline::dag::build_dag(&config.steps).unwrap();
}

#[test]
fn test_generated_github_config_parses() {
    let yaml = r#"
tracker:
  kind: github
  repository: acme/frontend
  api_key: $GITHUB_TOKEN
  project_number: 42
  active_states:
    - Todo
  terminal_states:
    - Done

repos:
  - path: /tmp/frontend
    branch: main
  - path: /tmp/api
    branch: develop

agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
  reviewer:
    acpx_agent: codex
    prompt_template: templates/review.liquid

steps:
  - name: implement
    agent: builder
    tracker_state: In Progress
  - name: review
    agent: reviewer
    depends:
      - implement
    tracker_state: Review

on_success: Done
on_failure: Failed
"#;

    let config = ensemble_core::config::ensemble::parse_config(yaml).unwrap();
    assert_eq!(config.tracker.kind, "github");
    assert_eq!(config.repos.len(), 2);
    assert_eq!(config.agents.len(), 2);
    assert_eq!(config.steps.len(), 2);

    ensemble_core::config::ensemble::validate_config(&config).unwrap();
    ensemble_core::pipeline::dag::build_dag(&config.steps).unwrap();
}

#[test]
fn test_backwards_compat_executor_model_still_works() {
    let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

    let config = ensemble_core::config::ensemble::parse_config(yaml).unwrap();
    assert_eq!(
        config.agents["build"].executor.as_deref(),
        Some("claude-code")
    );
    assert_eq!(
        config.agents["build"].model.as_deref(),
        Some("claude-opus-4-6")
    );
    assert!(config.agents["build"].acpx_agent.is_none());

    ensemble_core::config::ensemble::validate_config(&config).unwrap();
}
