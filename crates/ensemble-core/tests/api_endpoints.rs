//! Integration test: start an axum server with pre-populated state,
//! hit endpoints with reqwest, verify JSON shapes match SPEC.md Section 13.7.2.

use chrono::Utc;
use ensemble_core::api::router::{create_api_router, AppState, ConfigRuntime};
use ensemble_core::config::draft::ConfigDocumentState;
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::tracker::model::{Issue, RetryEntry, RunningEntry};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::RwLock;

fn test_issue(id: &str, identifier: &str, state: &str) -> Issue {
    Issue {
        id: id.to_string(),
        identifier: identifier.to_string(),
        title: format!("Issue {}", identifier),
        description: Some(format!("Description for {}", identifier)),
        priority: Some(1),
        state: state.to_string(),
        branch_name: None,
        url: Some(format!(
            "https://github.com/acme/repo/issues/{}",
            identifier
        )),
        labels: vec!["bug".to_string()],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

fn build_populated_app_state() -> (AppState, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let issue1 = test_issue("NODE_123", "my-repo#42", "In Progress");
    let running_entry = RunningEntry {
        issue_id: "NODE_123".to_string(),
        identifier: "my-repo#42".to_string(),
        issue: issue1,
        session_id: Some("session-abc".to_string()),
        agent_pid: Some("12345".to_string()),
        last_agent_event: Some("turn_completed".to_string()),
        last_agent_timestamp: Some(Utc::now()),
        last_agent_message: Some("Working on tests".to_string()),
        agent_input_tokens: 1200,
        agent_output_tokens: 800,
        agent_total_tokens: 2000,
        last_reported_input_tokens: 1200,
        last_reported_output_tokens: 800,
        last_reported_total_tokens: 2000,
        turn_count: 7,
        retry_attempt: None,
        started_at: Utc::now(),
    };

    let retry_entry = RetryEntry {
        issue_id: "NODE_456".to_string(),
        identifier: "my-repo#99".to_string(),
        attempt: 3,
        due_at_ms: 1711641600000,
        error: Some("no available orchestrator slots".to_string()),
    };

    let mut state = OrchestratorState::new(30000, 10);
    state.running.insert("NODE_123".to_string(), running_entry);
    state
        .retry_attempts
        .insert("NODE_456".to_string(), retry_entry);
    state.claimed.insert("NODE_123".to_string());
    state.claimed.insert("NODE_456".to_string());
    state.agent_totals.input_tokens = 5000;
    state.agent_totals.output_tokens = 2400;
    state.agent_totals.total_tokens = 7400;
    state.agent_totals.seconds_running = 120.5;

    let config_path = temp_dir.path().join("ensemble_test_config.yaml");
    let document_state = Arc::new(RwLock::new(ConfigDocumentState {
        path: config_path.clone(),
        kind: ensemble_core::config::draft::ConfigStateKind::Parsed,
        raw_yaml: Some("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed".to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
        validation: ensemble_core::config::draft::DraftValidationReport::default(),
    }));

    let app_state = AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: temp_dir.path().join("ensemble_workspaces").display().to_string(),
        history_path: temp_dir.path().join("ensemble_test_history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path,
            document_state,
        },
    };
    (app_state, temp_dir)
}

/// Start an axum test server and return the base URL.
async fn start_test_server(app_state: AppState) -> String {
    let router = create_api_router(app_state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}", addr);

    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    base_url
}

#[tokio::test]
async fn test_get_state_endpoint() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/state", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();

    // Verify top-level keys from SPEC.md Section 13.7.2
    assert!(json.get("generated_at").is_some(), "missing generated_at");
    assert!(json.get("counts").is_some(), "missing counts");
    assert!(json.get("running").is_some(), "missing running");
    assert!(json.get("retrying").is_some(), "missing retrying");
    assert!(json.get("agent_totals").is_some(), "missing agent_totals");
    assert!(json.get("rate_limits").is_some(), "missing rate_limits");

    // Verify counts
    let counts = json.get("counts").unwrap();
    assert_eq!(counts["running"], 1);
    assert_eq!(counts["retrying"], 1);

    // Verify running array shape
    let running = json.get("running").unwrap().as_array().unwrap();
    assert_eq!(running.len(), 1);
    let row = &running[0];
    assert_eq!(row["issue_id"], "NODE_123");
    assert_eq!(row["issue_identifier"], "my-repo#42");
    assert_eq!(row["state"], "In Progress");
    assert_eq!(row["session_id"], "session-abc");
    assert_eq!(row["turn_count"], 7);
    assert_eq!(row["last_event"], "turn_completed");
    assert_eq!(row["last_message"], "Working on tests");
    assert!(row.get("started_at").is_some());
    assert!(row.get("last_event_at").is_some());

    // Verify tokens sub-object
    let tokens = row.get("tokens").unwrap();
    assert_eq!(tokens["input_tokens"], 1200);
    assert_eq!(tokens["output_tokens"], 800);
    assert_eq!(tokens["total_tokens"], 2000);

    // Verify retrying array shape
    let retrying = json.get("retrying").unwrap().as_array().unwrap();
    assert_eq!(retrying.len(), 1);
    let retry = &retrying[0];
    assert_eq!(retry["issue_id"], "NODE_456");
    assert_eq!(retry["issue_identifier"], "my-repo#99");
    assert_eq!(retry["attempt"], 3);
    assert!(retry.get("due_at_ms").is_some());
    assert_eq!(retry["error"], "no available orchestrator slots");

    // Verify agent_totals shape
    let totals = json.get("agent_totals").unwrap();
    assert_eq!(totals["input_tokens"], 5000);
    assert_eq!(totals["output_tokens"], 2400);
    assert_eq!(totals["total_tokens"], 7400);
    assert!(totals.get("seconds_running").is_some());
    let secs = totals["seconds_running"].as_f64().unwrap();
    assert!(
        secs >= 120.5,
        "seconds_running should be >= 120.5, got {}",
        secs
    );
}

#[tokio::test]
async fn test_get_issue_detail_running() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/my-repo%2342", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["issue_identifier"], "my-repo#42");
    assert_eq!(json["issue_id"], "NODE_123");
    assert_eq!(json["status"], "running");

    // Verify workspace info
    let workspace = json.get("workspace").unwrap();
    assert!(workspace.get("path").is_some());
    assert!(workspace["path"].as_str().unwrap().contains("my-repo_42"));

    // Verify attempts info
    let attempts = json.get("attempts").unwrap();
    assert!(attempts.get("restart_count").is_some());
    assert!(attempts.get("current_retry_attempt").is_some());

    // Verify running detail is present
    assert!(json.get("running").unwrap().is_object());

    // Verify retry is null for a running issue
    assert!(json.get("retry").unwrap().is_null());
}

#[tokio::test]
async fn test_get_issue_detail_retrying() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/my-repo%2399", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["issue_identifier"], "my-repo#99");
    assert_eq!(json["status"], "retrying");

    // Verify retry detail is present
    assert!(json.get("retry").unwrap().is_object());

    // Verify running is null for a retrying issue
    assert!(json.get("running").unwrap().is_null());
}

#[tokio::test]
async fn test_get_issue_detail_not_found() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/nonexistent%23999", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let json: serde_json::Value = response.json().await.unwrap();

    // Verify error envelope
    assert!(json.get("error").is_some(), "missing error envelope");
    let error = json.get("error").unwrap();
    assert_eq!(error["code"], "issue_not_found");
    assert!(error.get("message").is_some());
}

#[tokio::test]
async fn test_post_refresh_endpoint() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/v1/refresh", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 202);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["queued"], true);
    assert_eq!(json["coalesced"], false);
    assert!(json.get("requested_at").is_some());
    let ops = json["operations"].as_array().unwrap();
    assert!(ops.contains(&serde_json::Value::String("poll".to_string())));
    assert!(ops.contains(&serde_json::Value::String("reconcile".to_string())));
}

#[tokio::test]
async fn test_get_refresh_returns_405() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/refresh", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 405);

    let json: serde_json::Value = response.json().await.unwrap();
    assert!(json.get("error").is_some());
    assert_eq!(json["error"]["code"], "method_not_allowed");
}

#[tokio::test]
async fn test_get_state_empty_system() {
    let temp_dir = TempDir::new().unwrap();
    let state = OrchestratorState::new(30000, 10);

    let config_path = temp_dir.path().join("ensemble_test_config.yaml");
    let document_state = Arc::new(RwLock::new(ConfigDocumentState {
        path: config_path.clone(),
        kind: ensemble_core::config::draft::ConfigStateKind::Parsed,
        raw_yaml: Some("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed".to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
        validation: ensemble_core::config::draft::DraftValidationReport::default(),
    }));

    let app_state = AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: temp_dir.path().join("workspaces").display().to_string(),
        history_path: temp_dir.path().join("ensemble_test_history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path,
            document_state,
        },
    };

    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/state", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["counts"]["running"], 0);
    assert_eq!(json["counts"]["retrying"], 0);
    assert!(json["running"].as_array().unwrap().is_empty());
    assert!(json["retrying"].as_array().unwrap().is_empty());
    assert_eq!(json["agent_totals"]["input_tokens"], 0);
    assert_eq!(json["agent_totals"]["output_tokens"], 0);
    assert_eq!(json["agent_totals"]["total_tokens"], 0);
    assert_eq!(json["agent_totals"]["seconds_running"], 0.0);
    assert!(json["rate_limits"].is_null());
}

// --- Static serving and API 404 fallback tests ---

fn build_empty_app_state() -> (AppState, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let state = OrchestratorState::new(30000, 10);
    let config_path = temp_dir.path().join("ensemble_test_config.yaml");
    let document_state = Arc::new(RwLock::new(ConfigDocumentState {
        path: config_path.clone(),
        kind: ensemble_core::config::draft::ConfigStateKind::Parsed,
        raw_yaml: Some("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed".to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config("tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed").unwrap()),
        validation: ensemble_core::config::draft::DraftValidationReport::default(),
    }));

    let app_state = AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: temp_dir.path().join("workspaces").display().to_string(),
        history_path: temp_dir.path().join("ensemble_test_history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path,
            document_state,
        },
    };
    (app_state, temp_dir)
}

#[tokio::test]
async fn test_api_unknown_route_returns_json_404() {
    let (app_state, _temp_dir) = build_empty_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/nonexistent/route", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let json: serde_json::Value = response.json().await.unwrap();
    assert!(json.get("error").is_some(), "expected JSON error envelope");
    assert_eq!(json["error"]["code"], "not_found");
}

// --- Config management tests ---

fn build_app_state_without_config() -> (AppState, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let state = OrchestratorState::new(30000, 10);
    let config_path = temp_dir.path().join("nonexistent_config.yaml");
    let document_state = Arc::new(RwLock::new(ConfigDocumentState {
        path: config_path.clone(),
        kind: ensemble_core::config::draft::ConfigStateKind::Missing,
        raw_yaml: None,
        document: None,
        active_config: None,
        validation: ensemble_core::config::draft::DraftValidationReport::default(),
    }));

    let app_state = AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: temp_dir.path().join("workspaces").display().to_string(),
        history_path: temp_dir.path().join("ensemble_test_history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path,
            document_state,
        },
    };
    (app_state, temp_dir)
}

#[tokio::test]
async fn test_get_config_reports_missing_state() {
    let (state, _temp_dir) = build_app_state_without_config();
    let base_url = start_test_server(state).await;
    let response = reqwest::get(format!("{}/api/v1/config", base_url))
        .await
        .unwrap();
    let status = response.status();
    let json: serde_json::Value = response.json().await.unwrap();

    assert_eq!(status, 200);
    assert_eq!(json["state"], "missing");
    assert!(json["active_config"].is_null());
}

#[tokio::test]
async fn test_post_yaml_validate_returns_syntax_errors() {
    let (state, _temp_dir) = build_app_state_without_config();
    let base_url = start_test_server(state).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/v1/config/yaml/validate", base_url))
        .json(&serde_json::json!({ "raw_yaml": "tracker:\n  kind: todo_file\nagents: [" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["state"], "syntax_error");
}
