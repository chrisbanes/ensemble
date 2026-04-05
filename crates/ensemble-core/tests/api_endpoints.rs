//! Integration test: start an axum server with pre-populated state,
//! hit endpoints with reqwest, verify JSON shapes match SPEC.md Section 13.7.2.

use chrono::Utc;
use ensemble_core::api::router::{create_api_router, AppState, ConfigRuntime};
use ensemble_core::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
use ensemble_core::interaction::model::{
    InteractionKind, InteractionRequest, InteractionResponse, InteractionStatus,
};
use ensemble_core::interaction::store::InteractionStore;
use ensemble_core::observability::events::EventBus;
use ensemble_core::orchestrator::state::{OrchestratorState, WaitingOnHumanEntry};
use ensemble_core::tracker::model::{Issue, RetryEntry, RunningEntry};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

const MINIMAL_CONFIG: &str = "tracker:\n  kind: todo_file\nagents:\n  build:\n    executor: test\n    model: test\n    prompt: test\nsteps:\n  - name: build\n    agent: build\non_success: Done\non_failure: Failed";

fn parsed_document_state(config_path: PathBuf) -> ConfigDocumentState {
    ConfigDocumentState {
        path: config_path,
        kind: ConfigStateKind::Parsed,
        raw_yaml: Some(MINIMAL_CONFIG.to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config(MINIMAL_CONFIG).unwrap()),
        validation: DraftValidationReport::default(),
    }
}

fn build_app_state(
    temp_dir: &TempDir,
    orchestrator_state: OrchestratorState,
    document_state: ConfigDocumentState,
) -> AppState {
    AppState {
        orchestrator_state: Arc::new(RwLock::new(orchestrator_state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: temp_dir
            .path()
            .join("ensemble_workspaces")
            .display()
            .to_string(),
        history_path: temp_dir.path().join("ensemble_test_history.jsonl"),
        event_bus: EventBus::new(),
        config_runtime: ConfigRuntime {
            config_path: document_state.path.clone(),
            document_state: Arc::new(RwLock::new(document_state)),
        },
    }
}

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
    let app_state = build_app_state(&temp_dir, state, parsed_document_state(config_path));
    (app_state, temp_dir)
}

fn test_interaction(id: &str, issue_id: &str, issue_identifier: &str) -> InteractionRequest {
    InteractionRequest {
        id: id.to_string(),
        schema_version: 1,
        issue_id: issue_id.to_string(),
        issue_identifier: issue_identifier.to_string(),
        pipeline_cycle: 1,
        completed_steps: vec!["build".to_string()],
        step_name: "review".to_string(),
        agent_name: "reviewer".to_string(),
        step_depends: vec!["build".to_string()],
        step_tracker_state: Some("In Review".to_string()),
        kind: InteractionKind::Question,
        status: InteractionStatus::Open,
        blocking: true,
        awaiting_resume: true,
        title: "Need clarification".to_string(),
        body: "Pick a deployment target".to_string(),
        options: vec!["staging".to_string(), "production".to_string()],
        artifacts: vec!["docs/spec.md".to_string()],
        response: None,
        requested_at: Utc::now(),
        resolved_at: None,
    }
}

async fn create_interaction(app_state: &AppState, interaction: InteractionRequest) {
    let config_dir = app_state
        .config_runtime
        .config_path
        .parent()
        .unwrap()
        .to_path_buf();
    InteractionStore::new(config_dir)
        .create(interaction)
        .await
        .unwrap();
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
    let mut app_state = build_app_state(&temp_dir, state, parsed_document_state(config_path));
    app_state.workspace_root = temp_dir.path().join("workspaces").display().to_string();

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
    let mut app_state = build_app_state(&temp_dir, state, parsed_document_state(config_path));
    app_state.workspace_root = temp_dir.path().join("workspaces").display().to_string();
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
    let document_state = ConfigDocumentState {
        path: config_path.clone(),
        kind: ConfigStateKind::Missing,
        raw_yaml: None,
        document: None,
        active_config: None,
        validation: DraftValidationReport::default(),
    };
    let mut app_state = build_app_state(&temp_dir, state, document_state);
    app_state.workspace_root = temp_dir.path().join("workspaces").display().to_string();
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

#[tokio::test]
async fn test_get_config_uses_canonical_permission_request_policy_in_guided_form() {
    let (state, _temp_dir) = build_app_state_without_config();
    let raw_yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: Build it.
steps:
  - name: build
    agent: builder
agent:
  command: claude-code
  permission_request_policy: manual
on_success: Done
on_failure: Failed
"#;
    *state.config_runtime.document_state.write().await = ConfigDocumentState {
        path: state.config_runtime.config_path.clone(),
        kind: ConfigStateKind::Parsed,
        raw_yaml: Some(raw_yaml.to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config(raw_yaml).unwrap()),
        validation: DraftValidationReport::default(),
    };

    let base_url = start_test_server(state).await;
    let response = reqwest::get(format!("{}/api/v1/config", base_url))
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(
        json["guided_form"]["agents"][0]["permission_mode"],
        "approve_reads"
    );
    assert_eq!(
        json["guided_form"]["runtime"]["agent"]["permission_request_policy"],
        "manual"
    );
    assert!(json["guided_form"]["agents"][0]
        .get("permission_request_policy")
        .is_none());
    assert!(json["guided_form"]["runtime"]["agent"]
        .get("permission_mode")
        .is_none());
    assert!(json["guided_form"]["runtime"]["agent"]
        .get("permission_policy")
        .is_none());
}

#[tokio::test]
async fn test_guided_form_save_round_trips_legacy_permission_policy_to_canonical_key() {
    let (state, _temp_dir) = build_app_state_without_config();
    let raw_yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: Build it.
steps:
  - name: build
    agent: builder
agent:
  command: claude-code
  permission_policy: manual
on_success: Done
on_failure: Failed
"#;
    std::fs::write(&state.config_runtime.config_path, raw_yaml).unwrap();
    *state.config_runtime.document_state.write().await = ConfigDocumentState {
        path: state.config_runtime.config_path.clone(),
        kind: ConfigStateKind::Parsed,
        raw_yaml: Some(raw_yaml.to_string()),
        document: None,
        active_config: Some(ensemble_core::config::ensemble::parse_config(raw_yaml).unwrap()),
        validation: DraftValidationReport::default(),
    };

    let base_url = start_test_server(state.clone()).await;
    let client = reqwest::Client::new();

    let get_response = client
        .get(format!("{}/api/v1/config", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(get_response.status(), 200);
    let get_json: serde_json::Value = get_response.json().await.unwrap();

    let save_response = client
        .post(format!("{}/api/v1/config/form/save", base_url))
        .json(&serde_json::json!({
            "base_raw_yaml": get_json["raw_yaml"],
            "form": get_json["guided_form"],
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(save_response.status(), 200);

    let saved_yaml = std::fs::read_to_string(&state.config_runtime.config_path).unwrap();
    assert!(saved_yaml.contains("permission_mode: approve_reads"));
    assert!(saved_yaml.contains("permission_request_policy: manual"));
    assert!(!saved_yaml.contains("permission_policy:"));
}

#[tokio::test]
async fn test_setup_defaults_extract_from_parseable_raw_yaml() {
    let (state, _temp_dir) = build_app_state_without_config();
    *state.config_runtime.document_state.write().await = ConfigDocumentState {
        path: state.config_runtime.config_path.clone(),
        kind: ConfigStateKind::Parsed,
        raw_yaml: Some(
            r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 11
  api_key: $GITHUB_TOKEN
  active_states:
    - Todo
  terminal_states:
    - Done
repos:
  - path: /tmp/repo-a
    branch: main
agents:
  builder:
    acpx_agent: claude
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#
            .to_string(),
        ),
        document: None,
        active_config: None,
        validation: DraftValidationReport::default(),
    };

    let base_url = start_test_server(state).await;
    let response = reqwest::get(format!("{}/api/v1/config/setup/defaults", base_url))
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["has_existing_config"], true);
    assert_eq!(json["defaults"]["tracker"]["kind"], "github");
    assert_eq!(json["defaults"]["repos"][0]["branch"], "main");
    assert_eq!(json["defaults"]["agents"][0]["role"], "builder");
}

#[tokio::test]
async fn list_open_interactions() {
    let (app_state, _temp_dir) = build_populated_app_state();
    create_interaction(
        &app_state,
        test_interaction("interaction-open", "NODE_789", "my-repo#77"),
    )
    .await;

    let resolved = test_interaction("interaction-resolved", "NODE_790", "my-repo#78");
    create_interaction(&app_state, resolved).await;
    let config_dir = app_state
        .config_runtime
        .config_path
        .parent()
        .unwrap()
        .to_path_buf();
    InteractionStore::new(config_dir)
        .resolve(
            "interaction-resolved",
            InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
        )
        .await
        .unwrap();

    let base_url = start_test_server(app_state).await;
    let response = reqwest::get(format!("{}/api/v1/interactions", base_url))
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    let interactions = json.as_array().unwrap();
    assert_eq!(interactions.len(), 1);
    assert_eq!(interactions[0]["id"], "interaction-open");
    assert_eq!(interactions[0]["status"], "open");
}

#[tokio::test]
async fn get_interaction_by_id() {
    let (app_state, _temp_dir) = build_populated_app_state();
    create_interaction(
        &app_state,
        test_interaction("interaction-detail", "NODE_789", "my-repo#77"),
    )
    .await;

    let base_url = start_test_server(app_state).await;
    let response = reqwest::get(format!(
        "{}/api/v1/interactions/interaction-detail",
        base_url
    ))
    .await
    .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["id"], "interaction-detail");
    assert_eq!(json["issue_identifier"], "my-repo#77");
    assert_eq!(json["kind"], "question");
}

#[tokio::test]
async fn respond_to_question_marks_interaction_resolved() {
    let (app_state, _temp_dir) = build_populated_app_state();
    create_interaction(
        &app_state,
        test_interaction("interaction-respond", "NODE_789", "my-repo#77"),
    )
    .await;

    let base_url = start_test_server(app_state.clone()).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/api/v1/interactions/interaction-respond/respond",
            base_url
        ))
        .json(&serde_json::json!({
            "kind": "question",
            "response_schema_version": 1,
            "text": "Use staging",
            "selected_option": "staging"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let config_dir = app_state
        .config_runtime
        .config_path
        .parent()
        .unwrap()
        .to_path_buf();
    let stored = InteractionStore::new(config_dir)
        .get("interaction-respond")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, InteractionStatus::Resolved);
    assert!(stored.response.is_some());
}

#[tokio::test]
async fn cancel_interaction_returns_conflict_when_already_resolved() {
    let (app_state, _temp_dir) = build_populated_app_state();
    create_interaction(
        &app_state,
        test_interaction("interaction-cancel", "NODE_789", "my-repo#77"),
    )
    .await;

    let config_dir = app_state
        .config_runtime
        .config_path
        .parent()
        .unwrap()
        .to_path_buf();
    InteractionStore::new(config_dir)
        .resolve(
            "interaction-cancel",
            InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
        )
        .await
        .unwrap();

    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/api/v1/interactions/interaction-cancel/cancel",
            base_url
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 409);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["error"]["code"], "already_resolved");
}

#[tokio::test]
async fn resume_blocked_issue_requeues_issue() {
    let (app_state, _temp_dir) = build_populated_app_state();
    let notify = app_state.refresh_requested.clone();
    create_interaction(
        &app_state,
        test_interaction("interaction-resume", "NODE_789", "my-repo#77"),
    )
    .await;

    let config_dir = app_state
        .config_runtime
        .config_path
        .parent()
        .unwrap()
        .to_path_buf();
    InteractionStore::new(config_dir)
        .resolve(
            "interaction-resume",
            InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
        )
        .await
        .unwrap();

    {
        let mut state = app_state.orchestrator_state.write().await;
        state.add_waiting_on_human(WaitingOnHumanEntry {
            issue_id: "NODE_789".to_string(),
            identifier: "my-repo#77".to_string(),
            interaction_request_id: "interaction-resume".to_string(),
            step_name: "review".to_string(),
            retry_attempt: Some(1),
            requested_at: Utc::now(),
        });
    }

    let notified = notify.notified();
    let base_url = start_test_server(app_state.clone()).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/v1/issues/my-repo%2377/resume", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    timeout(Duration::from_secs(1), notified).await.unwrap();

    let state = app_state.orchestrator_state.read().await;
    assert!(state.is_waiting_on_human("NODE_789"));
    assert!(state.is_claimed("NODE_789"));
    assert!(state.is_resume_requested("NODE_789"));
}
