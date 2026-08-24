#![cfg(feature = "web-ui")]

use serde::Serialize;
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tempfile::TempDir;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const ISSUE_ID: &str = "E2E-1";
const ISSUE_TITLE: &str = "Exercise product workflow";
// Exercise acceptance-failure lifecycle boundaries below Tokio's 2 MiB worker default so future
// growth cannot silently reintroduce platform-dependent stack overflows.
const ACCEPTANCE_FAILURE_WORKER_STACK_BYTES: usize = 15 * 128 * 1024;

struct GithubTimelineResponder {
    visible: Arc<AtomicBool>,
}

impl Respond for GithubTimelineResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let nodes = self.visible.load(Ordering::SeqCst).then(|| {
            serde_json::json!({
                "id": "E_status_ready",
                // Deliberately after the test Artifact capture. The adapter must still
                // reject it until the fixture exposes it as tracker history.
                "createdAt": "2099-01-01T00:00:00Z",
                "previousStatus": "Todo",
                "status": "In Progress",
                "project": { "id": "P_configured" },
                "actor": { "id": "U_operator", "login": "operator" }
            })
        });
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "node": { "timelineItems": {
                "pageInfo": { "hasNextPage": false, "endCursor": null },
                "nodes": nodes.into_iter().collect::<Vec<_>>()
            }}}
        }))
    }
}

struct GithubMutationResponder {
    calls: Arc<AtomicUsize>,
}

struct GithubCommentResponder {
    calls: Arc<AtomicUsize>,
}

impl Respond for GithubCommentResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        self.calls.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "addComment": { "commentEdge": { "node": {
                "id": "comment-action", "url": "https://github.example/comment-action"
            }}}}
        }))
    }
}

impl Respond for GithubMutationResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        self.calls.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "updateProjectV2ItemFieldValue": {
                "projectV2Item": { "id": "PVT_item" }
            }}
        }))
    }
}

struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn web_cli_runs_todo_issue_to_completion_with_mock_acpx() {
    let fixture = TestFixture::new().expect("fixture setup");
    let port = reserve_local_port().expect("reserve local port");
    let base_url = format!("http://127.0.0.1:{port}");

    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_LOG", "info")
        .env("ENSEMBLE_LOG_FORMAT", "json")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = command.spawn().expect("spawn ensemble web");
    let _guard = ChildGuard::new(child);
    let client = reqwest::Client::new();

    wait_for_server(&client, &base_url)
        .await
        .expect("server should become reachable");

    let detail = wait_for_completed_issue(&client, &base_url)
        .await
        .expect("issue should complete successfully");
    assert_eq!(detail["issue_identifier"], ISSUE_ID);
    assert_eq!(detail["status"], "completed_succeeded");
    assert!(
        detail["workflow_steps"]
            .as_array()
            .expect("workflow_steps should be an array")
            .iter()
            .any(|step| step["name"] == "implement" && step["state"] == "passed"),
        "issue detail should show implement step passed: {detail:#?}"
    );

    let history = wait_for_history_record(&client, &base_url, &fixture.workspace_root)
        .await
        .expect("history should contain completed run");
    assert_eq!(history["issue_identifier"], ISSUE_ID);
    assert_eq!(history["outcome"], "succeeded");
    let acceptance = &history["acceptance_attempts"][0]["results"][0];
    assert_eq!(acceptance["version"], 2);
    assert_eq!(acceptance["name"], "verify");
    assert_eq!(acceptance["status"], "passed");
    assert_eq!(acceptance["timing"]["kind"], "observed");
    assert!(acceptance["timing"]["started_at"].is_string());
    assert!(acceptance["timing"]["completed_at"].is_string());
    assert!(acceptance["timing"]["duration_ms"].is_u64());
    assert_eq!(acceptance["evidence"]["kind"], "command");
    assert_eq!(acceptance["evidence"]["stdout"]["total_bytes"], 40_000);
    assert_eq!(acceptance["evidence"]["stdout"]["truncated"], true);
    assert_eq!(
        acceptance["evidence"]["stdout"]["tail"]
            .as_str()
            .unwrap()
            .len(),
        32 * 1024
    );
    let file = &history["acceptance_attempts"][0]["results"][1];
    assert_eq!(file["name"], "required-artifact");
    assert_eq!(file["status"], "passed");
    assert_eq!(file["evidence"]["kind"], "file");
    assert_eq!(file["evidence"]["observation"], "present");
    let handoff = &history["acceptance_attempts"][0]["results"][2];
    assert_eq!(handoff["name"], "implementation-handoff");
    assert_eq!(handoff["status"], "passed");
    assert_eq!(handoff["evidence"]["kind"], "handoff");
    assert_eq!(handoff["evidence"]["sections"][0]["observation"], "present");
    assert!(
        history["steps_traversed"]
            .as_array()
            .expect("steps_traversed should be an array")
            .iter()
            .any(|step| step == "implement"),
        "history record should include implement step: {history:#?}"
    );

    let run_id = wait_for_transcript_artifact(&fixture.workspace_root)
        .await
        .expect("step transcript artifact should be persisted");

    wait_for_timeline_event(&client, &base_url, &run_id)
        .await
        .expect("timeline event should be queryable");

    let todo = fs::read_to_string(&fixture.todo_path).expect("read TODO.md");
    assert!(
        section_contains_issue(&todo, "Done", ISSUE_ID),
        "completed issue should be under Done section:\n{todo}"
    );

    let acpx_log = fs::read_to_string(&fixture.acpx_log_path).expect("read mock acpx log");
    assert!(
        acpx_log.lines().any(|line| line.contains(" prompt ")),
        "mock acpx should have received a prompt command:\n{acpx_log}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acceptance_failure_dominates_successful_agent_and_exhausts_the_issue() {
    let fixture = TestFixture::new_with_acceptance("printf acceptance-failed >&2; exit 7")
        .expect("fixture setup");
    let port = reserve_local_port().expect("reserve local port");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env(
            "RUST_MIN_STACK",
            ACCEPTANCE_FAILURE_WORKER_STACK_BYTES.to_string(),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let child = command.spawn().expect("spawn ensemble web");
    let _guard = ChildGuard::new(child);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();

    let history = wait_for_failed_history_record(&client, &base_url, &fixture.workspace_root)
        .await
        .expect("acceptance failure should be durable");

    assert_eq!(history["outcome"], "failed");
    assert_eq!(history["steps_traversed"][0], "implement");
    assert_eq!(history["attempts"], 1);
    let acceptance = &history["acceptance_attempts"][0]["results"][0];
    assert_eq!(acceptance["version"], 2);
    assert_eq!(acceptance["name"], "verify");
    assert_eq!(acceptance["status"], "failed");
    assert_eq!(acceptance["timing"]["kind"], "observed");
    assert_eq!(acceptance["evidence"]["kind"], "command");
    assert_eq!(acceptance["evidence"]["exit_code"], 7);
    assert!(acceptance["evidence"]["stderr"]["tail"]
        .as_str()
        .unwrap()
        .ends_with("acceptance-failed"));

    let todo = fs::read_to_string(&fixture.todo_path).expect("read TODO.md");
    assert!(section_contains_issue(&todo, "Failed", ISSUE_ID));
    assert!(!section_contains_issue(&todo, "Done", ISSUE_ID));
    let acpx_log = fs::read_to_string(&fixture.acpx_log_path).expect("read mock acpx log");
    assert_eq!(
        acpx_log.lines().filter(|line| line.contains(" prompt ")).count(),
        2,
        "one agent cycle emits its visible prompt and hidden extraction prompt; exhaustion must not launch another cycle"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_file_and_handoff_are_durable_acceptance_failures() {
    let fixture = TestFixture::new_with_acceptance("true").expect("fixture setup");
    let port = reserve_local_port().expect("reserve local port");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env(
            "RUST_MIN_STACK",
            ACCEPTANCE_FAILURE_WORKER_STACK_BYTES.to_string(),
        )
        .env("ENSEMBLE_E2E_SKIP_REQUIRED_FILE", "1")
        .env("ENSEMBLE_E2E_MISSING_HANDOFF", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let child = command.spawn().expect("spawn ensemble web");
    let _guard = ChildGuard::new(child);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();

    let history = wait_for_failed_history_record(&client, &base_url, &fixture.workspace_root)
        .await
        .expect("missing requirements should be durable");
    let results = history["acceptance_attempts"][0]["results"]
        .as_array()
        .expect("acceptance results should be an array");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["status"], "passed");
    assert_eq!(results[1]["name"], "required-artifact");
    assert_eq!(results[1]["status"], "failed");
    assert_eq!(results[1]["evidence"]["observation"], "missing");
    assert_eq!(results[2]["name"], "implementation-handoff");
    assert_eq!(results[2]["status"], "failed");
    assert_eq!(
        results[2]["evidence"]["sections"][0]["observation"],
        "missing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immutable_artifact_postattempt_mutation_halts() {
    let fixture = TestFixture::new_with_immutable_consumer().expect("fixture setup");
    let port = reserve_local_port().expect("reserve local port");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_MUTATE_IMMUTABLE_INPUT", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let child = command.spawn().expect("spawn ensemble web");
    let _guard = ChildGuard::new(child);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();

    let detail = wait_for_halted_immutable_issue(&client, &base_url)
        .await
        .expect("post-attempt mutation should halt the pipeline");
    assert_eq!(detail["status"], "waiting_on_human");
    assert_eq!(detail["retry"], Value::Null);
    assert_eq!(detail["current_interaction"]["step_name"], "review");
    let steps = detail["workflow_steps"]
        .as_array()
        .expect("workflow steps should be public");
    assert!(steps
        .iter()
        .any(|step| step["name"] == "produce" && step["state"] == "passed"));
    assert!(steps
        .iter()
        .any(|step| step["name"] == "review" && step["state"] == "failed"));
    assert!(steps
        .iter()
        .any(|step| step["name"] == "publish" && step["state"] == "pending"));

    let workspace = PathBuf::from(detail["workspace"]["path"].as_str().unwrap());
    let source = fs::read_dir(workspace.join("source"))
        .expect("preserved source worktree directory")
        .next()
        .expect("one source worktree")
        .expect("source worktree entry")
        .path();
    assert_eq!(
        fs::read_to_string(source.join("README.md")).expect("mutated tracked file"),
        "mutated after capture\n"
    );

    let journal = wait_for_halted_pipeline_journal(fixture.config_dir.path())
        .await
        .expect("halted pipeline journal should be durable");
    let violation = &journal["snapshot"]["artifact_integrity_violations"][0];
    assert_eq!(violation["consumer_step"], "review");
    assert_eq!(violation["producer_step"], "produce");
    assert_eq!(violation["repository"], "source");
    assert!(violation["expected_digest"].as_str().is_some());
    assert!(violation["observed_digest"].as_str().is_some());
    assert_ne!(violation["expected_digest"], violation["observed_digest"]);
    assert!(
        violation["changed_paths"]
            .as_array()
            .is_some_and(|paths| paths.contains(&serde_json::json!("README.md"))),
        "the durable evidence must identify the consumer mutation: {violation:#?}"
    );
    assert_eq!(violation["omitted_changed_path_count"], 0);
    assert!(
        !journal.to_string().contains("mutated after capture"),
        "durable violation evidence must remain content-free: {journal:#?}"
    );

    let acpx_log = fs::read_to_string(&fixture.acpx_log_path).expect("read mock acpx log");
    assert!(acpx_log.contains("Immutable consumer"));
    assert!(
        !acpx_log.contains("Downstream publisher"),
        "the downstream step must not launch after an immutable input violation: {acpx_log}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_evaluation_evidence_reaches_live_api_and_completed_history() {
    let fixture = TestFixture::new_with_evaluation().expect("fixture setup");
    let port = reserve_local_port().expect("reserve local port");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let child = command.spawn().expect("spawn ensemble web");
    let _guard = ChildGuard::new(child);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();

    let detail = wait_for_completed_evaluation(&client, &base_url)
        .await
        .unwrap();
    let gate = &detail["artifacts"]["gate_evidence"]["gate"];
    assert_eq!(gate["outcome"], "passed");
    assert_eq!(
        gate["assessments"]["review_a"]["findings"][0]["id"],
        "finding-1"
    );
    assert_eq!(
        gate["adjudication"]["dispositions"][0]["disposition"],
        "upheld"
    );
    assert_eq!(
        detail["artifacts"]["artifact_snapshots"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let history = wait_for_evaluation_history_record(&client, &base_url, &fixture.workspace_root)
        .await
        .unwrap();
    assert_eq!(
        history["artifacts"]["gate_evidence"],
        detail["artifacts"]["gate_evidence"]
    );
    assert_eq!(
        history["artifacts"]["artifact_snapshots"],
        detail["artifacts"]["artifact_snapshots"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unresolved_gate_approval_retains_its_deterministic_outcome_and_human_decision() {
    let fixture = TestFixture::new_with_evaluation().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_UNRESOLVED_GATE", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    let waiting = wait_for_unresolved_evaluation(&client, &base_url)
        .await
        .unwrap();
    let prompts_before_restart = fs::read_to_string(&fixture.acpx_log_path).unwrap();
    drop(guard);
    let mut restarted = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    restarted
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_UNRESOLVED_GATE", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _restarted_guard = ChildGuard::new(restarted.spawn().unwrap());
    wait_for_server(&client, &base_url).await.unwrap();
    let prompts_after_restart = fs::read_to_string(&fixture.acpx_log_path).unwrap();
    assert_eq!(
        prompts_after_restart, prompts_before_restart,
        "restart must not replay completed steps"
    );
    let interaction_id = waiting["current_interaction"]["interaction_request_id"]
        .as_str()
        .unwrap();
    let response = client
        .post(format!(
            "{base_url}/api/v1/interactions/{interaction_id}/respond"
        ))
        .json(&serde_json::json!({
            "kind": "approval", "response_schema_version": 1, "approved": true,
            "reason": "accepted residual risk"
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let resume = client
        .post(format!("{base_url}/api/v1/issues/{ISSUE_ID}/resume"))
        .send()
        .await
        .unwrap();
    assert!(resume.status().is_success());
    let completed = wait_for_completed_evaluation(&client, &base_url)
        .await
        .unwrap();
    let gate = &completed["artifacts"]["gate_evidence"]["gate"];
    assert_eq!(gate["outcome"], "awaiting_human");
    assert_eq!(gate["human_resolution"]["decision"], "approved");
    assert_eq!(gate["human_resolution"]["reason"], "accepted residual risk");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unresolved_gate_rejection_retains_its_deterministic_outcome_and_human_decision() {
    let fixture = TestFixture::new_with_evaluation().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_UNRESOLVED_GATE", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    let waiting = wait_for_unresolved_evaluation(&client, &base_url)
        .await
        .unwrap();
    let interaction_id = waiting["current_interaction"]["interaction_request_id"]
        .as_str()
        .unwrap();
    let response = client
        .post(format!(
            "{base_url}/api/v1/interactions/{interaction_id}/respond"
        ))
        .json(&serde_json::json!({
            "kind": "approval", "response_schema_version": 1, "approved": false,
            "reason": "blocking risk remains"
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let resume = client
        .post(format!("{base_url}/api/v1/issues/{ISSUE_ID}/resume"))
        .send()
        .await
        .unwrap();
    assert!(resume.status().is_success());
    let failed = wait_for_completed_evaluation_with_status(&client, &base_url, "completed_failed")
        .await
        .unwrap();
    let gate = &failed["artifacts"]["gate_evidence"]["gate"];
    assert_eq!(gate["outcome"], "awaiting_human");
    assert_eq!(gate["human_resolution"]["decision"], "rejected");
    assert_eq!(gate["human_resolution"]["reason"], "blocking risk remains");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dismissed_and_non_blocking_upheld_findings_pass_the_gate() {
    for (disposition, severity) in [("dismissed", "blocking"), ("upheld", "non_blocking")] {
        let detail = run_evaluation_variant(disposition, severity, "completed_succeeded").await;
        assert_eq!(
            detail["artifacts"]["gate_evidence"]["gate"]["outcome"],
            "passed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upheld_blocking_finding_fails_the_gate() {
    let detail = run_evaluation_variant("upheld", "blocking", "completed_failed").await;
    assert_eq!(
        detail["artifacts"]["gate_evidence"]["gate"]["outcome"],
        "failed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concern_result_can_be_approved_through_the_public_interaction() {
    let fixture = TestFixture::new_with_concern_approval().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_CONCERN_PUBLISH", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    let waiting = wait_for_interaction_step(&client, &base_url, "publish")
        .await
        .unwrap();
    let id = waiting["current_interaction"]["interaction_request_id"]
        .as_str()
        .unwrap();
    assert!(client.post(format!("{base_url}/api/v1/interactions/{id}/respond"))
        .json(&serde_json::json!({"kind":"approval","response_schema_version":1,"approved":true,"reason":"approved concern"}))
        .send().await.unwrap().status().is_success());
    assert!(client
        .post(format!("{base_url}/api/v1/issues/{ISSUE_ID}/resume"))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let completed = wait_for_completed_evaluation(&client, &base_url)
        .await
        .unwrap();
    assert_eq!(
        completed["workflow_steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["name"] == "publish")
            .unwrap()["state"],
        "passed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hidden_extraction_repair_succeeds_once_and_exhaustion_fails() {
    let repaired = run_repair_variant("1", "completed_succeeded").await;
    assert_eq!(repaired["status"], "completed_succeeded");
    let exhausted = run_repair_variant("exhaust", "completed_failed").await;
    assert_eq!(exhausted["status"], "completed_failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn producer_approval_pause_exposes_prelaunch_immutable_drift() {
    let fixture = TestFixture::new_with_producer_approval().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    let waiting = wait_for_interaction_step(&client, &base_url, "produce")
        .await
        .unwrap();
    let workspace = PathBuf::from(waiting["workspace"]["path"].as_str().unwrap());
    let source = fs::read_dir(workspace.join("source"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(source.join("README.md"), "drift before evaluator launch\n").unwrap();
    let id = waiting["current_interaction"]["interaction_request_id"]
        .as_str()
        .unwrap();
    assert!(client.post(format!("{base_url}/api/v1/interactions/{id}/respond")).json(&serde_json::json!({"kind":"approval","response_schema_version":1,"approved":true,"reason":null})).send().await.unwrap().status().is_success());
    assert!(client
        .post(format!("{base_url}/api/v1/issues/{ISSUE_ID}/resume"))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let halted = wait_for_interaction_step(&client, &base_url, "review_a")
        .await
        .unwrap();
    assert_eq!(halted["current_interaction"]["step_name"], "review_a");
    assert!(!fs::read_to_string(&fixture.acpx_log_path)
        .unwrap()
        .contains("Evaluation reviewer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn github_wait_for_event_survives_restart_without_replaying_the_artifact_producer() {
    let fixture = GithubAuthorizationFixture::new(false).await.unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let first = spawn_web(&fixture.fixture, port);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    wait_for_acpx_text(&fixture.fixture.acpx_log_path, "GitHub producer").await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let prompts_before_restart = fs::read_to_string(&fixture.fixture.acpx_log_path).unwrap();
    assert!(
        !prompts_before_restart.contains("GitHub protected"),
        "protected step ran before external tracker evidence: {prompts_before_restart}"
    );
    assert_eq!(fixture.mutations.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.comments.load(Ordering::SeqCst), 1);

    drop(first);
    let restarted = spawn_web(&fixture.fixture, port);
    wait_for_server(&client, &base_url).await.unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(
        fs::read_to_string(&fixture.fixture.acpx_log_path).unwrap(),
        prompts_before_restart,
        "restart must retain the completed Artifact producer and pending handoff"
    );
    assert_eq!(fixture.mutations.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.comments.load(Ordering::SeqCst),
        1,
        "restart must not replay the marker-bound comment action"
    );

    fixture.event_visible.store(true, Ordering::SeqCst);
    let completed = wait_for_history_step(&client, &base_url, "protected").await;
    assert_eq!(completed["outcome"], "succeeded");
    wait_for_acpx_text(&fixture.fixture.acpx_log_path, "GitHub protected").await;
    let records = read_pipeline_journal_records(fixture.fixture.config_dir.path()).unwrap();
    assert_journal_evidence_precedes_step(&records, "protected");
    drop(restarted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn github_automatic_transition_waits_for_revalidated_event_before_dispatch() {
    let fixture = GithubAuthorizationFixture::new(true).await.unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let guard = spawn_web(&fixture.fixture, port);
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    wait_for_acpx_text(&fixture.fixture.acpx_log_path, "GitHub producer").await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let before = fs::read_to_string(&fixture.fixture.acpx_log_path).unwrap();
    assert!(
        !before.contains("GitHub protected"),
        "protected step ran before tracker evidence: {before}"
    );
    assert_eq!(
        fixture.mutations.load(Ordering::SeqCst),
        0,
        "automatic transition must not write its configured tracker state early"
    );

    fixture.event_visible.store(true, Ordering::SeqCst);
    let completed = wait_for_history_step(&client, &base_url, "protected").await;
    assert_eq!(completed["outcome"], "succeeded");
    wait_for_acpx_text(&fixture.fixture.acpx_log_path, "GitHub protected").await;
    assert!(
        fixture.mutations.load(Ordering::SeqCst) >= 1,
        "automatic transition should reuse the protected step's tracker state"
    );
    let records = read_pipeline_journal_records(fixture.fixture.config_dir.path()).unwrap();
    assert_journal_evidence_precedes_step(&records, "protected");
    drop(guard);

    let drift = GithubAuthorizationFixture::new(true).await.unwrap();
    let drift_port = reserve_local_port().unwrap();
    let drift_base_url = format!("http://127.0.0.1:{drift_port}");
    let drift_guard = spawn_web(&drift.fixture, drift_port);
    wait_for_server(&client, &drift_base_url).await.unwrap();
    wait_for_acpx_text(&drift.fixture.acpx_log_path, "GitHub producer").await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let readme = find_workspace_file(&drift.fixture.workspace_root, "README.md").unwrap();
    fs::write(readme, "drift after authorization Artifact capture\n").unwrap();
    drift.event_visible.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !fs::read_to_string(&drift.fixture.acpx_log_path)
            .unwrap()
            .contains("GitHub protected"),
        "Artifact drift must stop dispatch even when the event matches"
    );
    assert_eq!(drift.mutations.load(Ordering::SeqCst), 0);
    drop(drift_guard);
}

struct TestFixture {
    config_dir: TempDir,
    todo_path: PathBuf,
    workspace_root: PathBuf,
    acpx_log_path: PathBuf,
    mock_bin_dir: PathBuf,
}

struct GithubAuthorizationFixture {
    fixture: TestFixture,
    _server: MockServer,
    event_visible: Arc<AtomicBool>,
    mutations: Arc<AtomicUsize>,
    comments: Arc<AtomicUsize>,
}

impl GithubAuthorizationFixture {
    async fn new(automatic_transition: bool) -> io::Result<Self> {
        let server = MockServer::start().await;
        let event_visible = Arc::new(AtomicBool::new(false));
        let mutations = Arc::new(AtomicUsize::new(0));
        let comments = Arc::new(AtomicUsize::new(0));
        mount_github_authorization_api(
            &server,
            event_visible.clone(),
            mutations.clone(),
            comments.clone(),
        )
        .await;
        let fixture =
            TestFixture::new_with_github_authorization(&server.uri(), automatic_transition)?;
        Ok(Self {
            fixture,
            _server: server,
            event_visible,
            mutations,
            comments,
        })
    }
}

impl TestFixture {
    fn new() -> io::Result<Self> {
        Self::new_with_acceptance("yes x | head -c 40000")
    }

    fn new_with_acceptance(acceptance_run: &str) -> io::Result<Self> {
        let config_dir = TempDir::new()?;
        let root = config_dir.path();
        let todo_path = root.join("TODO.md");
        let workspace_root = root.join("workspaces");
        let repo_path = root.join("source");
        let mock_bin_dir = root.join("bin");
        let acpx_log_path = root.join("mock-acpx.log");

        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&mock_bin_dir)?;
        init_git_repo(&repo_path)?;
        fs::write(&todo_path, todo_fixture())?;
        fs::write(
            root.join("config.yaml"),
            config_yaml(&todo_path, &workspace_root, &repo_path, acceptance_run),
        )?;
        fs::write(
            root.join("outcome-schema.json"),
            r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["artifact", "comment", "summary", "remedy", "references"],
  "properties": {
    "artifact": {"type": "string"}, "comment": {"type": "string"},
    "summary": {"type": "string"}, "remedy": {"type": "string"},
    "references": {"type": "array", "items": {"type": "string"}}
  }
}"#,
        )?;
        fs::write(mock_bin_dir.join("acpx"), mock_acpx_script())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(mock_bin_dir.join("acpx"), fs::Permissions::from_mode(0o755))?;
        }

        Ok(Self {
            config_dir,
            todo_path,
            workspace_root,
            acpx_log_path,
            mock_bin_dir,
        })
    }

    fn new_with_immutable_consumer() -> io::Result<Self> {
        let config_dir = TempDir::new()?;
        let root = config_dir.path();
        let todo_path = root.join("TODO.md");
        let workspace_root = root.join("workspaces");
        let repo_path = root.join("source");
        let mock_bin_dir = root.join("bin");
        let acpx_log_path = root.join("mock-acpx.log");

        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&mock_bin_dir)?;
        init_git_repo(&repo_path)?;
        fs::write(&todo_path, todo_fixture())?;
        fs::write(
            root.join("config.yaml"),
            immutable_consumer_config_yaml(&todo_path, &workspace_root, &repo_path),
        )?;
        fs::write(mock_bin_dir.join("acpx"), mock_acpx_script())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(mock_bin_dir.join("acpx"), fs::Permissions::from_mode(0o755))?;
        }

        Ok(Self {
            config_dir,
            todo_path,
            workspace_root,
            acpx_log_path,
            mock_bin_dir,
        })
    }

    fn new_with_evaluation() -> io::Result<Self> {
        let config_dir = TempDir::new()?;
        let root = config_dir.path();
        let todo_path = root.join("TODO.md");
        let workspace_root = root.join("workspaces");
        let repo_path = root.join("source");
        let mock_bin_dir = root.join("bin");
        let acpx_log_path = root.join("mock-acpx.log");
        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&mock_bin_dir)?;
        init_git_repo(&repo_path)?;
        fs::write(&todo_path, todo_fixture())?;
        fs::write(
            root.join("config.yaml"),
            evaluation_config_yaml(&todo_path, &workspace_root, &repo_path),
        )?;
        fs::write(mock_bin_dir.join("acpx"), mock_acpx_script())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(mock_bin_dir.join("acpx"), fs::Permissions::from_mode(0o755))?;
        }
        Ok(Self {
            config_dir,
            todo_path,
            workspace_root,
            acpx_log_path,
            mock_bin_dir,
        })
    }

    fn new_with_github_authorization(
        endpoint: &str,
        automatic_transition: bool,
    ) -> io::Result<Self> {
        let config_dir = TempDir::new()?;
        let root = config_dir.path();
        let todo_path = root.join("unused-TODO.md");
        let workspace_root = root.join("workspaces");
        let repo_path = root.join("source");
        let mock_bin_dir = root.join("bin");
        let acpx_log_path = root.join("mock-acpx.log");
        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&mock_bin_dir)?;
        init_git_repo(&repo_path)?;
        fs::write(
            root.join("config.yaml"),
            github_authorization_config_yaml(
                endpoint,
                &workspace_root,
                &repo_path,
                automatic_transition,
            ),
        )?;
        fs::write(
            root.join("outcome-schema.json"),
            r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["artifact", "comment", "summary", "remedy", "references"],
  "properties": {
    "artifact": {"type": "string"}, "comment": {"type": "string"},
    "summary": {"type": "string"}, "remedy": {"type": "string"},
    "references": {"type": "array", "items": {"type": "string"}}
  }
}"#,
        )?;
        fs::write(mock_bin_dir.join("acpx"), mock_acpx_script())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(mock_bin_dir.join("acpx"), fs::Permissions::from_mode(0o755))?;
        }
        Ok(Self {
            config_dir,
            todo_path,
            workspace_root,
            acpx_log_path,
            mock_bin_dir,
        })
    }

    fn new_with_concern_approval() -> io::Result<Self> {
        let fixture = Self::new_with_evaluation()?;
        let config_path = fixture.config_dir.path().join("config.yaml");
        let config = fs::read_to_string(&config_path)?.replace(
            "  - name: publish\n    agent: publisher\n    depends: [gate]",
            "  - name: publish\n    agent: publisher\n    depends: [gate]\n    approval:\n      mode: always",
        );
        fs::write(config_path, config)?;
        Ok(fixture)
    }

    fn new_with_producer_approval() -> io::Result<Self> {
        let fixture = Self::new_with_evaluation()?;
        let config_path = fixture.config_dir.path().join("config.yaml");
        let config = fs::read_to_string(&config_path)?.replace(
            "  - name: produce\n    agent: producer\n    artifact_snapshot: { repositories: [source] }",
            "  - name: produce\n    agent: producer\n    artifact_snapshot: { repositories: [source] }\n    approval:\n      mode: always",
        );
        fs::write(config_path, config)?;
        Ok(fixture)
    }

    fn path_with_mock_bin(&self) -> OsString {
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let mut combined = OsString::from(&self.mock_bin_dir);
        combined.push(":");
        combined.push(old_path);
        combined
    }
}

fn reserve_local_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn todo_fixture() -> String {
    format!(
        "## Todo\n\n- [{ISSUE_ID}] {ISSUE_TITLE}\n  Verify that Ensemble can run a local black-box workflow.\n\n## In Progress\n\n## Done\n\n## Failed\n"
    )
}

fn config_yaml(
    todo_path: &Path,
    workspace_root: &Path,
    repo_path: &Path,
    acceptance_run: &str,
) -> String {
    format!(
        r#"
tracker:
  kind: todo_file
  path: {}
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
workspace:
  root: {}
repos:
  - path: {}
    branch: main
agents:
  builder:
    acpx_agent: builder
    prompt: "Implement {{{{ issue.identifier }}}}: {{{{ issue.title }}}}"
steps:
  - name: implement
    agent: builder
    tracker_state: In Progress
acceptance:
  commands:
    - name: verify
      run: {}
      timeout_ms: 5000
  required_files:
    - name: required-artifact
      repo: source
      path: acceptance.txt
  required_handoff_sections:
    - name: implementation-handoff
      step: implement
      sections:
        - artifact
on_success: Done
on_failure: Failed
max_cycles: 1
polling:
  interval_ms: 100
concurrency:
  max_concurrent_agents: 1
  max_step_parallelism: 1
agent:
  read_timeout_ms: 5000
  turn_timeout_ms: 10000
  max_retry_backoff_ms: 100
"#,
        yaml_quote(&todo_path.display().to_string()),
        yaml_quote(&workspace_root.display().to_string()),
        yaml_quote(&repo_path.display().to_string()),
        yaml_quote(acceptance_run)
    )
}

fn immutable_consumer_config_yaml(
    todo_path: &Path,
    workspace_root: &Path,
    repo_path: &Path,
) -> String {
    format!(
        r#"
tracker:
  kind: todo_file
  path: {}
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
workspace:
  root: {}
repos:
  - path: {}
    branch: main
agents:
  producer:
    acpx_agent: builder
    prompt: "Produce immutable artifact for {{{{ issue.identifier }}}}"
  consumer:
    acpx_agent: builder
    prompt: "Immutable consumer for {{{{ issue.identifier }}}}"
  publisher:
    acpx_agent: builder
    prompt: "Downstream publisher for {{{{ issue.identifier }}}}"
steps:
  - name: produce
    agent: producer
    tracker_state: In Progress
    artifact_snapshot:
      repositories:
        - source
  - name: review
    agent: consumer
    depends:
      - produce
    artifact_inputs:
      - produce
    artifact_access: immutable
    on_failure: retry_issue
  - name: publish
    agent: publisher
    depends:
      - review
on_success: Done
on_failure: Failed
max_cycles: 3
polling:
  interval_ms: 100
concurrency:
  max_concurrent_agents: 1
  max_step_parallelism: 1
agent:
  read_timeout_ms: 5000
  turn_timeout_ms: 10000
  max_retry_backoff_ms: 100
"#,
        yaml_quote(&todo_path.display().to_string()),
        yaml_quote(&workspace_root.display().to_string()),
        yaml_quote(&repo_path.display().to_string()),
    )
}

fn evaluation_config_yaml(todo_path: &Path, workspace_root: &Path, repo_path: &Path) -> String {
    format!(
        r#"
tracker:
  kind: todo_file
  path: {}
  active_states: [Todo, In Progress]
  terminal_states: [Done]
workspace:
  root: {}
repos:
  - path: {}
    branch: main
agents:
  producer: {{ acpx_agent: builder, prompt: "Evaluation producer" }}
  publisher: {{ acpx_agent: builder, prompt: "Evaluation publish" }}
  reviewer: {{ acpx_agent: builder, prompt: "Evaluation reviewer" }}
  synthesizer: {{ acpx_agent: builder, prompt: "Evaluation synthesis" }}
steps:
  - name: produce
    agent: producer
    output_schema: {{ path: outcome-schema.json }}
    artifact_snapshot: {{ repositories: [source] }}
    actions:
      - type: tracker_comment
        body: /comment
      - type: operator_attention
        kind: ensemble.outcome
        summary: /summary
        remedy: /remedy
        references: /references
  - name: review_a
    agent: reviewer
    depends: [produce]
    artifact_inputs: [produce]
    artifact_access: immutable
  - name: review_b
    agent: reviewer
    depends: [produce]
    artifact_inputs: [produce]
    artifact_access: immutable
  - name: adjudicate
    kind: synthesis
    agent: synthesizer
    depends: [review_a, review_b]
  - name: gate
    kind: gate
    depends: [adjudicate]
    gate:
      assessment_steps: [review_a, review_b]
      adjudication_step: adjudicate
  - name: publish
    agent: publisher
    depends: [gate]
on_success: Done
on_failure: Failed
max_cycles: 1
polling: {{ interval_ms: 100 }}
concurrency: {{ max_concurrent_agents: 2, max_step_parallelism: 2 }}
agent: {{ read_timeout_ms: 5000, turn_timeout_ms: 10000, max_retry_backoff_ms: 100 }}
"#,
        yaml_quote(&todo_path.display().to_string()),
        yaml_quote(&workspace_root.display().to_string()),
        yaml_quote(&repo_path.display().to_string()),
    )
}

fn github_authorization_config_yaml(
    endpoint: &str,
    workspace_root: &Path,
    repo_path: &Path,
    automatic_transition: bool,
) -> String {
    let handoff = if automatic_transition {
        "automatic_transition"
    } else {
        "wait_for_event"
    };
    let tracker_state = automatic_transition.then_some("    tracker_state: In Progress\n");
    format!(
        r#"
tracker:
  kind: github
  endpoint: {}
  api_key: fixture-token
  repository: acme/repo
  project_number: 1
  github:
    status_field: Status
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: {}
repos:
  - path: {}
    branch: main
agents:
  producer: {{ acpx_agent: builder, prompt: "GitHub producer" }}
  protected: {{ acpx_agent: builder, prompt: "GitHub protected" }}
steps:
  - name: produce
    agent: producer
    output_schema: {{ path: outcome-schema.json }}
    artifact_snapshot: {{ repositories: [source] }}
    actions:
      - type: tracker_comment
        body: /comment
      - type: operator_attention
        kind: ensemble.outcome
        summary: /summary
        remedy: /remedy
        references: /references
  - name: protected
    agent: protected
    depends: [produce]
{}    authorization:
      artifact_step: produce
      event:
        field: F_status
        value: In Progress
        actors: [U_operator]
      after_artifact: true
      handoff: {}
on_success: Done
on_failure: Done
max_cycles: 1
polling: {{ interval_ms: 100 }}
concurrency: {{ max_concurrent_agents: 1, max_step_parallelism: 1 }}
agent: {{ read_timeout_ms: 5000, turn_timeout_ms: 10000, max_retry_backoff_ms: 100 }}
"#,
        yaml_quote(endpoint),
        yaml_quote(&workspace_root.display().to_string()),
        yaml_quote(&repo_path.display().to_string()),
        tracker_state.unwrap_or_default(),
        handoff,
    )
}

async fn mount_github_authorization_api(
    server: &MockServer,
    event_visible: Arc<AtomicBool>,
    mutations: Arc<AtomicUsize>,
    comments: Arc<AtomicUsize>,
) {
    let discovery = serde_json::json!({ "data": { "repository": { "projectV2": {
        "id": "P_configured",
        "fields": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [{
            "id": "F_status", "name": "Status", "options": [
                { "id": "O_todo", "name": "Todo" },
                { "id": "O_progress", "name": "In Progress" },
                { "id": "O_done", "name": "Done" }
            ]
        }] }
    }}}});
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("projectNumber"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("comments(first: 100"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "node": { "comments": {
                "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": []
            }}}
        })))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("addComment"))
        .respond_with(GithubCommentResponder { calls: comments })
        .mount(server)
        .await;

    let project_items = serde_json::json!({ "data": { "node": { "items": {
        "pageInfo": { "hasNextPage": false, "endCursor": null },
        "edges": [{ "cursor": "item-1", "node": {
            "fieldValues": { "nodes": [{
                "name": "Todo", "optionId": "O_todo",
                "field": { "id": "F_status", "name": "Status" }
            }]},
            "content": {
                "id": ISSUE_ID, "number": 1, "title": ISSUE_TITLE, "body": "",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "url": "https://github.example/acme/repo/issues/1",
                "labels": { "nodes": [] }, "assignees": { "totalCount": 0, "nodes": [] }
            }
        }}]
    }}}});
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("orderBy: {field: POSITION"))
        .respond_with(ResponseTemplate::new(200).set_body_json(project_items))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("timelineItems(first:"))
        .respond_with(GithubTimelineResponder {
            visible: event_visible,
        })
        .mount(server)
        .await;

    let project_item = serde_json::json!({ "data": { "node": { "projectItems": {
        "nodes": [{ "id": "PVT_item", "project": { "id": "P_configured" } }]
    }}}});
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("projectItems(first: 100)"))
        .respond_with(ResponseTemplate::new(200).set_body_json(project_item))
        .mount(server)
        .await;

    let states = serde_json::json!({ "data": { "nodes": [{
        "id": ISSUE_ID, "number": 1, "title": ISSUE_TITLE, "state": "OPEN",
        "url": "https://github.example/acme/repo/issues/1",
        "labels": { "nodes": [{ "name": "Todo" }] },
        "assignees": { "totalCount": 0, "nodes": [] }
    }]}});
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("nodes(ids:"))
        .respond_with(ResponseTemplate::new(200).set_body_json(states))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("updateProjectV2ItemFieldValue"))
        .respond_with(GithubMutationResponder { calls: mutations })
        .mount(server)
        .await;
}

fn init_git_repo(repo_path: &Path) -> io::Result<()> {
    fs::create_dir_all(repo_path)?;
    let run = |args: &[&str]| -> io::Result<()> {
        let status = Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "git {} failed with {status}",
                args.join(" ")
            )))
        }
    };
    run(&["init", "-b", "main"])?;
    fs::write(repo_path.join("README.md"), "fixture\n")?;
    run(&["add", "README.md"])?;
    run(&[
        "-c",
        "user.name=Ensemble E2E",
        "-c",
        "user.email=ensemble-e2e@example.invalid",
        "commit",
        "-m",
        "fixture",
    ])
}

async fn wait_for_failed_history_record(
    client: &reqwest::Client,
    base_url: &str,
    workspace_root: &Path,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let url = format!("{base_url}/api/v1/history?outcome=failed&step=implement");
    loop {
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let json = response.json::<Value>().await.map_err(|e| e.to_string())?;
        if let Some(record) = json["records"]
            .as_array()
            .and_then(|records| records.iter().find(|r| r["issue_identifier"] == ISSUE_ID))
        {
            return Ok(record.clone());
        }
        if Instant::now() >= deadline {
            let history_path = workspace_root.join("ensemble_history.jsonl");
            let persisted = fs::read_to_string(&history_path).unwrap_or_default();
            return Err(format!(
                "failed history record not found: {json:#?}\npersisted history:\n{persisted}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_halted_immutable_issue(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let url = format!("{base_url}/api/v1/{ISSUE_ID}");
    loop {
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if response.status().is_success() {
            let detail = response.json::<Value>().await.map_err(|e| e.to_string())?;
            if detail["status"] == "waiting_on_human" {
                return Ok(detail);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "immutable consumer did not halt before timeout: {detail:#?}"
                ));
            }
        } else if Instant::now() >= deadline {
            return Err(format!(
                "issue detail endpoint returned {}",
                response.status()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn read_halted_pipeline_journal(config_dir: &Path) -> Result<Value, String> {
    let journal_dir = config_dir.join("state").join("pipeline-runs");
    let entries = fs::read_dir(&journal_dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let record = contents
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .last();
        if record
            .as_ref()
            .is_some_and(|record| record["kind"] == "pipeline_halted")
        {
            return Ok(record.expect("checked above"));
        }
    }
    Err(format!(
        "no durable pipeline_halted record under {}",
        journal_dir.display()
    ))
}

async fn wait_for_halted_pipeline_journal(config_dir: &Path) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match read_halted_pipeline_journal(config_dir) {
            Ok(record) => return Ok(record),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

fn yaml_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn mock_acpx_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail

log="${ENSEMBLE_E2E_ACPX_LOG:?ENSEMBLE_E2E_ACPX_LOG must be set}"
printf ' %s ' "$@" >> "$log"
printf '\n' >> "$log"

cwd=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--cwd" && $((i + 1)) -lt ${#args[@]} ]]; then
    cwd="${args[$((i + 1))]}"
  fi
done

if [[ " $* " == *" sessions ensure "* ]]; then
  exit 0
fi

if [[ " $* " == *" sessions close "* ]]; then
  exit 0
fi

if [[ " $* " == *" prompt "* ]]; then
  if [[ -z "$cwd" ]]; then
    echo "mock acpx missing --cwd" >&2
    exit 2
  fi

  prompt="$(cat)"
  printf ' prompt-input=%s\n' "$prompt" >> "$log"
  mkdir -p "$cwd/.ensemble"
  cat > "$cwd/.ensemble/mock-prompt.txt"
  verdict='{"result":"succeeded","summary":"mock agent completed","output":{"artifact":"mock"}}'
  if [[ "${ENSEMBLE_E2E_INVALID_EXTRACTION:-}" == "1" && "$prompt" == Extract* && "$prompt" == *"Evaluation publish"* ]]; then
    verdict='{"invalid":"extraction"}'
  elif [[ "${ENSEMBLE_E2E_INVALID_EXTRACTION:-}" == "1" && "$prompt" == "The previous Ensemble step result was invalid."* ]]; then
    verdict='{"result":"succeeded","summary":"repaired","output":{"artifact":"repaired"}}'
  elif [[ "${ENSEMBLE_E2E_INVALID_EXTRACTION:-}" == "exhaust" && "$prompt" == *"Extract the Ensemble step result"* && "$prompt" == *"Evaluation publish"* ]]; then
    verdict='{"invalid":"extraction"}'
  elif [[ "${ENSEMBLE_E2E_INVALID_EXTRACTION:-}" == "exhaust" && "$prompt" == "The previous Ensemble step result was invalid."* ]]; then
    verdict='{"invalid":"repair"}'
  elif [[ "${ENSEMBLE_E2E_CONCERN_PUBLISH:-}" == "1" && "$prompt" == *"Evaluation publish"* ]]; then
    verdict='{"result":"concern","summary":"operator should approve","output":{"artifact":"mock"}}'
  elif [[ "$prompt" == *"GitHub producer"* ]]; then
    verdict='{"result":"succeeded","summary":"GitHub producer completed","output":{"artifact":"mock","comment":"Artifact ready","summary":"Artifact ready","remedy":"Review it","references":["artifact:mock"]}}'
  elif [[ "$prompt" == *"Evaluation reviewer"* ]]; then
    severity="${ENSEMBLE_E2E_FINDING_SEVERITY:-non_blocking}"
    verdict="{\"result\":\"succeeded\",\"summary\":\"assessment\",\"output\":{\"assessment\":{\"findings\":[{\"id\":\"finding-1\",\"severity\":\"$severity\",\"summary\":\"Minor concern\",\"evidence\":{\"path\":\"README.md\"}}]}}}"
  elif [[ "$prompt" == *"Evaluation synthesis"* ]]; then
    disposition="${ENSEMBLE_E2E_DISPOSITION:-upheld}"
    if [[ "${ENSEMBLE_E2E_UNRESOLVED_GATE:-}" == "1" ]]; then disposition="unresolved"; fi
    verdict="{\"result\":\"succeeded\",\"summary\":\"adjudication\",\"output\":{\"adjudication\":{\"dispositions\":[{\"source_step\":\"review_a\",\"finding_id\":\"finding-1\",\"disposition\":\"$disposition\",\"rationale\":\"retained\",\"evidence\":{\"path\":\"README.md\"}},{\"source_step\":\"review_b\",\"finding_id\":\"finding-1\",\"disposition\":\"$disposition\",\"rationale\":\"retained\",\"evidence\":{\"path\":\"README.md\"}}]}}}"
  elif [[ "${ENSEMBLE_E2E_MISSING_HANDOFF:-}" == "1" ]]; then
    verdict='{"result":"succeeded","summary":"mock agent completed","output":{}}'
  fi
  printf '%s\n' "$verdict" > "$cwd/.ensemble/verdict-implement.json"
  if [[ "${ENSEMBLE_E2E_SKIP_REQUIRED_FILE:-}" != "1" ]]; then
    repo_worktree="$(find "$cwd/source" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    printf 'artifact\n' > "$repo_worktree/acceptance.txt"
  fi
  if [[ "${ENSEMBLE_E2E_MUTATE_IMMUTABLE_INPUT:-}" == "1" && "$prompt" == *"Immutable consumer"* ]]; then
    printf 'mutated after capture\n' > "$repo_worktree/README.md"
  fi

  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"mock agent completed"}}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":{"type":"tool_call","name":"read_file","arguments":{"path":"Cargo.toml"}}}}}'
  printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"turn_complete","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7},"verdict":%s,"stopReason":"end_turn"}}}\n' "$verdict"
  exit 0
fi

echo "unexpected mock acpx invocation: $*" >&2
exit 2
"#
}

fn spawn_web(fixture: &TestFixture, port: u16) -> ChildGuard {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    ChildGuard::new(command.spawn().expect("spawn ensemble web"))
}

async fn wait_for_acpx_text(path: &Path, text: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if fs::read_to_string(path).unwrap_or_default().contains(text) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for '{text}' in {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn find_workspace_file(root: &Path, name: &str) -> io::Result<PathBuf> {
    fn visit(directory: &Path, name: &str) -> io::Result<Option<PathBuf>> {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.file_name() == Some(OsStr::new(".git")) {
                continue;
            }
            if path.file_name() == Some(OsStr::new(name)) {
                return Ok(Some(path));
            }
            if path.is_dir() {
                if let Some(found) = visit(&path, name)? {
                    return Ok(Some(found));
                }
            }
        }
        Ok(None)
    }
    visit(root, name)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, name))
}

fn read_pipeline_journal_records(config_dir: &Path) -> Result<Vec<Value>, String> {
    let journal_dir = config_dir.join("state").join("pipeline-runs");
    let entries = fs::read_dir(journal_dir).map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for entry in entries {
        let contents = fs::read_to_string(entry.map_err(|error| error.to_string())?.path())
            .map_err(|error| error.to_string())?;
        records.extend(
            contents
                .lines()
                .map(serde_json::from_str)
                .collect::<Result<Vec<Value>, _>>()
                .map_err(|error| error.to_string())?,
        );
    }
    records.sort_by_key(|record| record["seq"].as_u64());
    Ok(records)
}

fn assert_journal_evidence_precedes_step(records: &[Value], step: &str) {
    let evidence = records
        .iter()
        .find(|record| {
            record["kind"] == "authorization_evidence_selected" && record["step"] == step
        })
        .expect("authorization evidence should be durable");
    let running = records
        .iter()
        .find(|record| record["kind"] == "step_running" && record["step"] == step)
        .expect("protected step should be durably running");
    assert!(
        evidence["seq"].as_u64() < running["seq"].as_u64(),
        "authorization evidence must be journaled before dispatch: {records:#?}"
    );
}

async fn wait_for_server(client: &reqwest::Client, base_url: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match client.get(format!("{base_url}/api/v1/state")).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                if Instant::now() >= deadline {
                    return Err(format!("state endpoint returned {}", response.status()));
                }
            }
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(format!("state endpoint did not become reachable: {error}"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_completed_issue(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let url = format!("{base_url}/api/v1/{ISSUE_ID}");
    loop {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                let json = response.json::<Value>().await.map_err(|e| e.to_string())?;
                if json["status"] == "completed_succeeded"
                    && json["workflow_steps"].as_array().is_some_and(|steps| {
                        steps
                            .iter()
                            .any(|step| step["name"] == "implement" && step["state"] == "passed")
                    })
                {
                    return Ok(json);
                }
                if Instant::now() >= deadline {
                    return Err(format!("issue did not complete before timeout: {json:#?}"));
                }
            }
            Ok(response) => {
                if Instant::now() >= deadline {
                    return Err(format!("issue detail returned {}", response.status()));
                }
            }
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(format!("issue detail request failed: {error}"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_completed_evaluation(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let url = format!("{base_url}/api/v1/{ISSUE_ID}");
    loop {
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            let detail = response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?;
            if detail["status"] == "completed_succeeded"
                && detail["artifacts"]["gate_evidence"]["gate"].is_object()
            {
                return Ok(detail);
            }
            if Instant::now() >= deadline {
                return Err(format!("evaluation evidence did not complete: {detail:#?}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_completed_evaluation_with_status(
    client: &reqwest::Client,
    base_url: &str,
    status: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let detail = client
            .get(format!("{base_url}/api/v1/{ISSUE_ID}"))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        if detail["status"] == status && detail["artifacts"]["gate_evidence"]["gate"].is_object() {
            return Ok(detail);
        }
        if Instant::now() >= deadline {
            return Err(format!("evaluation did not reach {status}: {detail:#?}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn run_evaluation_variant(disposition: &str, severity: &str, status: &str) -> Value {
    let fixture = TestFixture::new_with_evaluation().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_DISPOSITION", disposition)
        .env("ENSEMBLE_E2E_FINDING_SEVERITY", severity)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    wait_for_completed_evaluation_with_status(&client, &base_url, status)
        .await
        .unwrap()
}

async fn run_repair_variant(mode: &str, status: &str) -> Value {
    let fixture = TestFixture::new_with_evaluation().unwrap();
    let port = reserve_local_port().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_ensemble"));
    command
        .arg("web")
        .arg("--config-dir")
        .arg(fixture.config_dir.path())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", fixture.path_with_mock_bin())
        .env("ENSEMBLE_E2E_ACPX_LOG", &fixture.acpx_log_path)
        .env("ENSEMBLE_E2E_INVALID_EXTRACTION", mode)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let _guard = ChildGuard::new(command.spawn().unwrap());
    let client = reqwest::Client::new();
    wait_for_server(&client, &base_url).await.unwrap();
    wait_for_completed_evaluation_with_status(&client, &base_url, status)
        .await
        .unwrap()
}

async fn wait_for_unresolved_evaluation(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let detail = client
            .get(format!("{base_url}/api/v1/{ISSUE_ID}"))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        if detail["status"] == "waiting_on_human"
            && detail["current_interaction"]["step_name"] == "gate"
        {
            return Ok(detail);
        }
        if Instant::now() >= deadline {
            return Err(format!("unresolved gate did not wait: {detail:#?}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_interaction_step(
    client: &reqwest::Client,
    base_url: &str,
    step_name: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let detail = client
            .get(format!("{base_url}/api/v1/{ISSUE_ID}"))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        if detail["status"] == "waiting_on_human"
            && detail["current_interaction"]["step_name"] == step_name
        {
            return Ok(detail);
        }
        if Instant::now() >= deadline {
            return Err(format!("{step_name} did not await approval: {detail:#?}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_history_record(
    client: &reqwest::Client,
    base_url: &str,
    workspace_root: &Path,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let url = format!("{base_url}/api/v1/history?outcome=succeeded&step=implement");
    loop {
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let json = response.json::<Value>().await.map_err(|e| e.to_string())?;
        if let Some(record) = json["records"]
            .as_array()
            .and_then(|records| records.iter().find(|r| r["issue_identifier"] == ISSUE_ID))
        {
            return Ok(record.clone());
        }
        if Instant::now() >= deadline {
            let history_path = workspace_root.join("ensemble_history.jsonl");
            let persisted_history = fs::read_to_string(&history_path).unwrap_or_else(|error| {
                format!("could not read {}: {error}", history_path.display())
            });
            return Err(format!(
                "history record not found before timeout: {json:#?}\npersisted history:\n{persisted_history}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_history_step(client: &reqwest::Client, base_url: &str, step: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    let url = format!("{base_url}/api/v1/history?outcome=succeeded&step={step}");
    loop {
        if let Ok(response) = client.get(&url).send().await {
            if let Ok(json) = response.json::<Value>().await {
                if let Some(record) = json["records"]
                    .as_array()
                    .and_then(|records| records.first())
                {
                    return record.clone();
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for completed {step} history"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_evaluation_history_record(
    client: &reqwest::Client,
    base_url: &str,
    workspace_root: &Path,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let url = format!("{base_url}/api/v1/history?outcome=succeeded");
    loop {
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let json = response
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        if let Some(record) = json["records"].as_array().and_then(|records| {
            records
                .iter()
                .find(|record| record["issue_identifier"] == ISSUE_ID)
        }) {
            return Ok(record.clone());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "evaluation history record not found: {json:#?}\npersisted history:\n{}",
                fs::read_to_string(workspace_root.join("ensemble_history.jsonl"))
                    .unwrap_or_default()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_timeline_event(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let url = format!("{base_url}/api/v1/{ISSUE_ID}/timeline?run_id={run_id}");
    loop {
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let timeline = response.json::<Value>().await.map_err(|e| e.to_string())?;
        if timeline["events"].as_array().is_some_and(|events| {
            events.iter().any(|event| {
                event["issue_identifier"] == ISSUE_ID && event["event_type"] == "step_started"
            })
        }) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timeline event not found before timeout: {timeline:#?}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_transcript_artifact(workspace_root: &Path) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(10);

    loop {
        match read_first_transcript_file(workspace_root)? {
            Some((path, contents))
                if contents.contains("\"assistant_message\"")
                    && contents.contains("\"tool_call\"")
                    && contents.contains("\"read_file\"") =>
            {
                return path
                    .parent()
                    .and_then(Path::parent)
                    .and_then(Path::parent)
                    .and_then(Path::file_name)
                    .and_then(|run_id| run_id.to_str())
                    .map(ToString::to_string)
                    .ok_or_else(|| "transcript path did not contain a UTF-8 run id".to_string());
            }
            Some((path, contents)) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "transcript did not contain expected records at {}:\n{contents}",
                        path.display()
                    ));
                }
            }
            None => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "transcript artifact not found under {}",
                        workspace_root.display()
                    ));
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn read_first_transcript_file(workspace_root: &Path) -> Result<Option<(PathBuf, String)>, String> {
    let runs_dir = workspace_root.join(".ensemble").join("runs");
    let entries = match fs::read_dir(&runs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry
            .path()
            .join("steps")
            .join("implement")
            .join("transcript.jsonl");
        match fs::read_to_string(&path) {
            Ok(contents) => return Ok(Some((path, contents))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Ok(None)
}

fn section_contains_issue(markdown: &str, section: &str, issue_id: &str) -> bool {
    let target_heading = format!("## {section}");
    let mut in_target = false;

    for line in markdown.lines() {
        if line.starts_with("## ") {
            in_target = line.trim() == target_heading;
            continue;
        }
        if in_target && line.contains(&format!("[{issue_id}]")) {
            return true;
        }
    }

    false
}

const LIVE_DOGFOOD_OPT_IN: &str = "ENSEMBLE_LIVE_DOGFOOD";
const LIVE_DOGFOOD_PROJECT: &str = "ENSEMBLE_DOGFOOD_PROJECT_NUMBER";
const LIVE_DOGFOOD_BAMBOON_PATH: &str = "ENSEMBLE_DOGFOOD_BAMBOON_PATH";
const LIVE_DOGFOOD_AGENT: &str = "ENSEMBLE_DOGFOOD_AGENT";
const LIVE_DOGFOOD_PRESERVE: &str = "ENSEMBLE_LIVE_DOGFOOD_PRESERVE";
const LIVE_DOGFOOD_STATUSES: [&str; 4] = ["Ready to implement", "In progress", "In review", "Done"];
const LIVE_DOGFOOD_POLL_INTERVAL_MS: u64 = 1_000;
const LIVE_DOGFOOD_RESTART_STABLE_POLLS: usize = 2;
static LIVE_DOGFOOD_SEQUENCE: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum LiveDogfoodMode {
    Routine,
    Preserve,
}

impl LiveDogfoodMode {
    fn from_input(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("") => Ok(Self::Routine),
            Some("1") => Ok(Self::Preserve),
            Some(_) => Err(format!(
                "{LIVE_DOGFOOD_PRESERVE} must be exactly 1 when set"
            )),
        }
    }

    fn from_os_input(value: Option<&OsStr>) -> Result<Self, String> {
        let value = value
            .map(|value| {
                value
                    .to_str()
                    .ok_or_else(|| format!("{LIVE_DOGFOOD_PRESERVE} must contain valid UTF-8"))
            })
            .transpose()?;
        Self::from_input(value)
    }
}

#[derive(Debug)]
struct LiveDogfoodInputs {
    project_number: u64,
    bamboon_path: PathBuf,
    agent: String,
    mode: LiveDogfoodMode,
}

impl LiveDogfoodInputs {
    fn from_env() -> Result<Self, String> {
        let mode =
            LiveDogfoodMode::from_os_input(std::env::var_os(LIVE_DOGFOOD_PRESERVE).as_deref())?;
        Self::from_values_with_mode(
            std::env::var(LIVE_DOGFOOD_OPT_IN).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_PROJECT).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_BAMBOON_PATH).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_AGENT).ok().as_deref(),
            mode,
        )
    }

    fn from_values(
        opt_in: Option<&str>,
        project_number: Option<&str>,
        bamboon_path: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Self, String> {
        Self::from_values_with_preserve(opt_in, project_number, bamboon_path, agent, None)
    }

    fn from_values_with_preserve(
        opt_in: Option<&str>,
        project_number: Option<&str>,
        bamboon_path: Option<&str>,
        agent: Option<&str>,
        preserve: Option<&str>,
    ) -> Result<Self, String> {
        Self::from_values_with_mode(
            opt_in,
            project_number,
            bamboon_path,
            agent,
            LiveDogfoodMode::from_input(preserve)?,
        )
    }

    fn from_values_with_mode(
        opt_in: Option<&str>,
        project_number: Option<&str>,
        bamboon_path: Option<&str>,
        agent: Option<&str>,
        mode: LiveDogfoodMode,
    ) -> Result<Self, String> {
        if opt_in != Some("1") {
            return Err(format!("{LIVE_DOGFOOD_OPT_IN} must be exactly 1"));
        }
        let project_number = project_number
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .ok_or_else(|| format!("{LIVE_DOGFOOD_PROJECT} must be a positive decimal value"))?
            .parse::<u64>()
            .ok()
            .filter(|number| *number > 0)
            .ok_or_else(|| format!("{LIVE_DOGFOOD_PROJECT} must be a positive decimal value"))?;
        let bamboon_path = PathBuf::from(
            bamboon_path
                .ok_or_else(|| format!("{LIVE_DOGFOOD_BAMBOON_PATH} must be an absolute path"))?,
        );
        if !bamboon_path.is_absolute() {
            return Err(format!(
                "{LIVE_DOGFOOD_BAMBOON_PATH} must be an absolute path"
            ));
        }

        Ok(Self {
            project_number,
            bamboon_path,
            agent: agent
                .filter(|value| !value.is_empty())
                .unwrap_or("codex")
                .to_string(),
            mode,
        })
    }
}

#[derive(Clone, Debug)]
struct LiveDogfoodCleanupPlan {
    issue_id: String,
    issue_number: u64,
    project_id: String,
    project_item_id: String,
    status_field_id: String,
    done_option_id: String,
    pull_request: LiveDogfoodPullRequestIdentity,
    branch: String,
    expected_sha: String,
    worktree_identity: String,
}

impl LiveDogfoodCleanupPlan {
    fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("issue ID", &self.issue_id),
            ("Project ID", &self.project_id),
            ("Project item ID", &self.project_item_id),
            ("Status field ID", &self.status_field_id),
            ("Done option ID", &self.done_option_id),
            ("pull-request ID", &self.pull_request.id),
            ("pull-request URL", &self.pull_request.url),
            ("generated branch", &self.branch),
            ("expected SHA", &self.expected_sha),
            ("worktree identity", &self.worktree_identity),
        ] {
            if value.is_empty() {
                return Err(format!("cleanup plan: stored {name} was missing"));
            }
        }
        if self.issue_number == 0 || self.pull_request.number == 0 {
            return Err("cleanup plan: numeric identity was missing".to_string());
        }
        if self.pull_request.head != self.branch
            || self.pull_request.sha != self.expected_sha
            || self.pull_request.base != "main"
        {
            return Err(
                "cleanup plan: pull request did not match the stored ref identity".to_string(),
            );
        }
        if Path::new(&self.worktree_identity).is_absolute()
            || self.worktree_identity.starts_with("../")
        {
            return Err("cleanup plan: worktree was not run-owned".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    fn for_test() -> Self {
        Self {
            issue_id: "issue-node".to_string(),
            issue_number: 47,
            project_id: "project-node".to_string(),
            project_item_id: "item-node".to_string(),
            status_field_id: "status-node".to_string(),
            done_option_id: "done-option".to_string(),
            pull_request: LiveDogfoodPullRequestIdentity {
                id: "pr-node".to_string(),
                number: 48,
                url: "https://github.com/chrisbanes/bamboon/pull/48".to_string(),
                state: "OPEN".to_string(),
                head: "ensemble-live-dogfood".to_string(),
                sha: "expected-sha".to_string(),
                base: "main".to_string(),
            },
            branch: "ensemble-live-dogfood".to_string(),
            expected_sha: "expected-sha".to_string(),
            worktree_identity: "issue/bamboon/ensemble-live-dogfood".to_string(),
        }
    }

    #[cfg(test)]
    fn with_pull_request_sha(mut self, value: &str) -> Self {
        self.pull_request.sha = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_pull_request_base(mut self, value: &str) -> Self {
        self.pull_request.base = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_issue_id(mut self, value: &str) -> Self {
        self.issue_id = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_worktree(mut self, value: &str) -> Self {
        self.worktree_identity = value.to_string();
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveDogfoodCleanupStep {
    ClosePullRequest,
    ProjectDone,
    WaitForHostRelease,
    StopAndReapHost,
    CloseIssue,
    RemoveProjectItem,
    DeleteGeneratedRef,
    VerifyFinalAbsence,
}

const LIVE_DOGFOOD_CLEANUP_ORDER: [LiveDogfoodCleanupStep; 8] = [
    LiveDogfoodCleanupStep::ClosePullRequest,
    LiveDogfoodCleanupStep::ProjectDone,
    LiveDogfoodCleanupStep::WaitForHostRelease,
    LiveDogfoodCleanupStep::StopAndReapHost,
    LiveDogfoodCleanupStep::CloseIssue,
    LiveDogfoodCleanupStep::RemoveProjectItem,
    LiveDogfoodCleanupStep::DeleteGeneratedRef,
    LiveDogfoodCleanupStep::VerifyFinalAbsence,
];

impl LiveDogfoodCleanupStep {
    fn name(self) -> &'static str {
        match self {
            Self::ClosePullRequest => "close_pull_request",
            Self::ProjectDone => "project_done",
            Self::WaitForHostRelease => "wait_for_host_release",
            Self::StopAndReapHost => "stop_and_reap_host",
            Self::CloseIssue => "close_issue",
            Self::RemoveProjectItem => "remove_project_item",
            Self::DeleteGeneratedRef => "delete_generated_ref",
            Self::VerifyFinalAbsence => "verify_final_absence",
        }
    }

    fn ordinal(self) -> usize {
        LIVE_DOGFOOD_CLEANUP_ORDER
            .iter()
            .position(|candidate| *candidate == self)
            .expect("every cleanup step must appear in the cleanup order")
    }
}

struct LiveDogfoodCleanupRecorder {
    next_step: usize,
    failed: bool,
    transitions: Vec<(&'static str, &'static str)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LiveDogfoodPullRequestIdentity {
    id: String,
    number: u64,
    url: String,
    state: String,
    head: String,
    sha: String,
    base: String,
}

impl LiveDogfoodPullRequestIdentity {
    fn validate_against(
        &self,
        plan: &LiveDogfoodCleanupPlan,
        expected_state: &str,
    ) -> Result<(), String> {
        if self.id != plan.pull_request.id
            || self.number != plan.pull_request.number
            || self.url != plan.pull_request.url
            || self.state != expected_state
            || self.head != plan.branch
            || self.sha != plan.expected_sha
            || self.base != "main"
        {
            return Err(
                "cleanup pull request revalidation: stored identity no longer matched".to_string(),
            );
        }
        Ok(())
    }
}

impl LiveDogfoodCleanupPlan {
    fn from_live(
        resources: &LiveDogfoodResources,
        run: &LiveDogfoodRun,
        worktree: &Path,
        branch: &str,
        sha: &str,
        pull_request: &LiveDogfoodPullRequestIdentity,
    ) -> Result<Self, String> {
        let worktree_identity = worktree
            .strip_prefix(run.root.join("workspaces"))
            .map_err(|_| "cleanup plan: captured worktree was outside the run root".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let plan = Self {
            issue_id: resources.issue_id.clone(),
            issue_number: resources.issue_number,
            project_id: resources.project.id.clone(),
            project_item_id: resources.project_item_id.clone(),
            status_field_id: resources.project.status_field_id.clone(),
            done_option_id: resources.project.done_option_id.clone(),
            pull_request: pull_request.clone(),
            branch: branch.to_string(),
            expected_sha: sha.to_string(),
            worktree_identity,
        };
        plan.validate()?;
        Ok(plan)
    }
}

impl LiveDogfoodCleanupRecorder {
    fn new(plan: &LiveDogfoodCleanupPlan) -> Result<Self, String> {
        plan.validate()?;
        Ok(Self {
            next_step: 0,
            failed: false,
            transitions: Vec::new(),
        })
    }

    fn attempt(
        &mut self,
        step: LiveDogfoodCleanupStep,
        result: Result<(), &str>,
    ) -> Result<(), String> {
        if self.failed || step.ordinal() != self.next_step {
            return Err(
                "cleanup plan: later mutation was unreachable after a failed or out-of-order step"
                    .to_string(),
            );
        }
        let name = step.name();
        match result {
            Ok(()) => {
                self.transitions.push((name, "succeeded"));
                self.next_step += 1;
                Ok(())
            }
            Err(error) => {
                self.transitions.push((name, "preserved_failure"));
                self.failed = true;
                Err(format!("cleanup plan: {name} failed revalidation: {error}"))
            }
        }
    }

    fn transitions(&self) -> Vec<(&'static str, &'static str)> {
        self.transitions.clone()
    }
    fn is_complete(&self) -> bool {
        !self.failed && self.next_step == LIVE_DOGFOOD_CLEANUP_ORDER.len()
    }
}

#[derive(Debug)]
struct LiveDogfoodRun {
    marker: String,
    root: PathBuf,
}

impl LiveDogfoodRun {
    fn create() -> io::Result<Self> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let marker = live_dogfood_marker(
            timestamp,
            std::process::id(),
            LIVE_DOGFOOD_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        );
        let root = std::env::temp_dir()
            .join("ensemble-live-dogfood")
            .join(&marker);
        fs::create_dir_all(&root)?;
        Ok(Self { marker, root })
    }

    fn expected_artifact(&self) -> ExpectedDogfoodArtifact {
        ExpectedDogfoodArtifact {
            path: PathBuf::from("docs/ensemble-dogfood").join(format!("{}.md", self.marker)),
            content: format!("# Ensemble live dogfood\n\nMarker: `{}`\n", self.marker),
            commit_message: format!("Add live dogfood artifact {}", self.marker),
        }
    }
}

#[derive(Debug)]
struct ExpectedDogfoodArtifact {
    path: PathBuf,
    content: String,
    commit_message: String,
}

fn live_dogfood_marker(timestamp_nanos: u128, process_id: u32, sequence: u32) -> String {
    format!("live-dogfood-{timestamp_nanos:x}-{process_id:x}-{sequence:x}")
}

fn redact_live_dogfood(value: &str, inputs: &LiveDogfoodInputs, token: Option<&str>) -> String {
    let mut redacted = value
        .replace(&inputs.project_number.to_string(), "[REDACTED]")
        .replace(&inputs.bamboon_path.display().to_string(), "[REDACTED]");
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        redacted = redacted.replace(token, "[REDACTED]");
    }
    redacted
}

#[derive(Debug, Serialize)]
struct LiveDogfoodEvidenceV1 {
    format: &'static str,
    schema_version: u8,
    run: LiveDogfoodEvidenceRun,
    mode: LiveDogfoodMode,
    outcome: LiveDogfoodEvidenceOutcome,
    retained_logs: Vec<&'static str>,
    snapshots: Vec<LiveDogfoodEvidenceSnapshot>,
    transitions: Vec<LiveDogfoodEvidenceTransition>,
    final_state: LiveDogfoodEvidenceFinalState,
}

#[derive(Debug, Serialize)]
struct LiveDogfoodEvidenceRun {
    marker: String,
    issue_identifier: String,
    workspace_identifier: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum LiveDogfoodEvidenceOutcome {
    InReview,
    PreservedFailure,
    PreservedCertification,
    RoutineCleaned,
}

#[derive(Debug, Serialize)]
struct LiveDogfoodEvidenceTransition {
    phase: &'static str,
    result: &'static str,
}

#[derive(Debug, Default, Serialize)]
struct LiveDogfoodEvidenceFinalState {
    absent: Vec<&'static str>,
    retained: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LiveDogfoodEvidenceSnapshot {
    PrePublication {
        artifact: String,
        generated_branch: String,
        local_sha: String,
        assertions: Vec<LiveDogfoodEvidenceAssertion>,
    },
    PostDelivery {
        remote_branch: String,
        remote_sha: String,
        pull_request: LiveDogfoodEvidencePullRequest,
        tracker_state: String,
        review_target: String,
        review_projection: String,
        assertions: Vec<LiveDogfoodEvidenceAssertion>,
    },
    PostRestart {
        issue_identifier: String,
        workspace_identifier: String,
        generated_branch: String,
        local_sha: String,
        remote_sha: String,
        pull_request: LiveDogfoodEvidencePullRequest,
        review_target: String,
        review_projection: String,
        transcript_identity: String,
        transcript_count: usize,
        transcript_bytes: u64,
        worktree_identity: String,
        worktree_count: usize,
        assertions: Vec<LiveDogfoodEvidenceAssertion>,
    },
    PreservedFailure {
        last_observation: String,
        assertions_not_reached: Vec<String>,
    },
}

#[derive(Debug, Serialize)]
struct LiveDogfoodEvidenceAssertion {
    name: &'static str,
    satisfied: bool,
}

#[derive(Debug, Serialize)]
struct LiveDogfoodEvidencePullRequest {
    number: u64,
    url: String,
}

impl LiveDogfoodEvidenceV1 {
    fn new(
        run: &LiveDogfoodRun,
        issue_identifier: impl Into<String>,
        mode: LiveDogfoodMode,
    ) -> Self {
        Self {
            format: "ensemble.live-dogfood-evidence",
            schema_version: 1,
            run: LiveDogfoodEvidenceRun {
                marker: run.marker.clone(),
                issue_identifier: issue_identifier.into(),
                workspace_identifier: format!("run/{}", run.marker),
            },
            mode,
            outcome: LiveDogfoodEvidenceOutcome::InReview,
            retained_logs: LiveDogfoodHostLifetime::all_log_names().to_vec(),
            snapshots: Vec::new(),
            transitions: Vec::new(),
            final_state: LiveDogfoodEvidenceFinalState::default(),
        }
    }

    fn append_pre_publication(
        &mut self,
        artifact: impl Into<String>,
        generated_branch: impl Into<String>,
        local_sha: impl Into<String>,
    ) -> Result<(), String> {
        if !self.snapshots.is_empty() {
            return Err("evidence-v1: pre-publication snapshot must be first".to_string());
        }
        let artifact = artifact.into();
        if Path::new(&artifact).is_absolute() {
            return Err("evidence-v1: artifact must be relative to the repository".to_string());
        }
        self.snapshots
            .push(LiveDogfoodEvidenceSnapshot::PrePublication {
                artifact,
                generated_branch: generated_branch.into(),
                local_sha: local_sha.into(),
                assertions: vec![
                    evidence_assertion("local_artifact_valid"),
                    evidence_assertion("generated_branch_valid"),
                    evidence_assertion("local_sha_captured"),
                    evidence_assertion("agent_not_published"),
                ],
            });
        Ok(())
    }

    fn append_preserved_failure(
        &mut self,
        phase: &str,
        assertions_not_reached: impl IntoIterator<Item = impl Into<String>>,
        inputs: &LiveDogfoodInputs,
        token: Option<&str>,
    ) -> Result<(), String> {
        let assertions_not_reached = assertions_not_reached
            .into_iter()
            .map(Into::into)
            .collect::<Vec<String>>();
        if assertions_not_reached.is_empty() {
            return Err("evidence-v1: failure snapshot requires unreached assertions".to_string());
        }
        self.outcome = LiveDogfoodEvidenceOutcome::PreservedFailure;
        self.snapshots
            .push(LiveDogfoodEvidenceSnapshot::PreservedFailure {
                last_observation: format!("{}: failed", redact_live_dogfood(phase, inputs, token)),
                assertions_not_reached,
            });
        Ok(())
    }

    fn append_transition(&mut self, phase: &'static str, result: &'static str) {
        self.transitions
            .push(LiveDogfoodEvidenceTransition { phase, result });
    }

    fn preserve_certification(&mut self) {
        self.outcome = LiveDogfoodEvidenceOutcome::PreservedCertification;
        self.final_state.absent = vec!["active_child"];
        self.final_state.retained = vec![
            "synthetic_issue",
            "project_item",
            "generated_ref",
            "pull_request",
            "generated_config",
            "workspace_worktree",
            "host_logs",
            "evidence",
        ];
    }

    fn preserve_after_transitions(&mut self) {
        self.outcome = LiveDogfoodEvidenceOutcome::PreservedFailure;
        self.final_state.absent.clear();
        self.final_state.retained.clear();

        for (transition, absent, retained) in [
            ("close_pull_request", "open_pull_request", "pull_request"),
            ("close_issue", "open_synthetic_issue", "synthetic_issue"),
            ("remove_project_item", "project_item", "project_item"),
            ("delete_generated_ref", "generated_ref", "generated_ref"),
            (
                "wait_for_host_release",
                "workspace_worktree",
                "workspace_worktree",
            ),
        ] {
            if self.transition_succeeded(transition) {
                self.final_state.absent.push(absent);
            } else {
                self.final_state.retained.push(retained);
            }
        }
        if self.transition_succeeded("stop_and_reap_host")
            || self.transition_succeeded("failure_host_reap")
            || self.transition_succeeded("failure_child_absence")
        {
            self.final_state.absent.push("active_child");
        } else {
            self.final_state.retained.push("active_child");
        }
        self.final_state
            .retained
            .extend(["generated_config", "host_logs", "evidence"]);
    }

    fn preserve_discovered_artifacts(&mut self) {
        self.outcome = LiveDogfoodEvidenceOutcome::PreservedFailure;
        self.final_state.absent = vec!["active_child"];
        self.final_state.retained = vec![
            "synthetic_issue",
            "project_item",
            "generated_config",
            "host_logs",
            "evidence",
        ];
        if !self.snapshots.is_empty() {
            self.final_state.retained.extend([
                "workspace_worktree",
                "generated_ref",
                "pull_request",
            ]);
        }
    }

    fn transition_succeeded(&self, phase: &str) -> bool {
        self.transitions
            .iter()
            .any(|transition| transition.phase == phase && transition.result == "succeeded")
    }

    fn routine_cleaned(&mut self) {
        self.outcome = LiveDogfoodEvidenceOutcome::RoutineCleaned;
        self.final_state.absent = vec![
            "open_synthetic_issue",
            "project_item",
            "generated_ref",
            "open_pull_request",
            "workspace_worktree",
            "active_child",
        ];
        self.final_state.retained = vec!["generated_config", "host_logs", "evidence"];
    }

    fn append_post_delivery(
        &mut self,
        remote_branch: impl Into<String>,
        remote_sha: impl Into<String>,
        pull_request_number: u64,
        pull_request_url: impl Into<String>,
        tracker_state: impl Into<String>,
        review_target: impl Into<String>,
        review_projection: impl Into<String>,
    ) -> Result<(), String> {
        if !matches!(
            self.snapshots.as_slice(),
            [LiveDogfoodEvidenceSnapshot::PrePublication { .. }]
        ) {
            return Err(
                "evidence-v1: post-delivery snapshot requires one pre-publication snapshot"
                    .to_string(),
            );
        }
        self.outcome = LiveDogfoodEvidenceOutcome::InReview;
        self.snapshots
            .push(LiveDogfoodEvidenceSnapshot::PostDelivery {
                remote_branch: remote_branch.into(),
                remote_sha: remote_sha.into(),
                pull_request: LiveDogfoodEvidencePullRequest {
                    number: pull_request_number,
                    url: pull_request_url.into(),
                },
                tracker_state: tracker_state.into(),
                review_target: review_target.into(),
                review_projection: review_projection.into(),
                assertions: vec![
                    evidence_assertion("remote_branch_matches_local_sha"),
                    evidence_assertion("single_pull_request"),
                    evidence_assertion("tracker_state_in_review"),
                    evidence_assertion("review_projection_applied"),
                    evidence_assertion("cross_surface_agreement"),
                ],
            });
        Ok(())
    }

    fn append_post_restart(
        &mut self,
        observation: &LiveDogfoodRecoveryObservation,
    ) -> Result<(), String> {
        if !matches!(
            self.snapshots.as_slice(),
            [
                LiveDogfoodEvidenceSnapshot::PrePublication { .. },
                LiveDogfoodEvidenceSnapshot::PostDelivery { .. }
            ]
        ) {
            return Err(
                "evidence-v1: post-restart snapshot requires pre-publication and post-delivery snapshots"
                    .to_string(),
            );
        }
        if self.run.issue_identifier != observation.issue_identifier
            || self.run.workspace_identifier != observation.workspace_identifier
        {
            return Err(
                "evidence-v1: post-restart identity did not match retained run".to_string(),
            );
        }
        let [_, LiveDogfoodEvidenceSnapshot::PostDelivery {
            remote_branch,
            remote_sha,
            pull_request,
            review_target,
            review_projection,
            ..
        }] = self.snapshots.as_slice()
        else {
            unreachable!("validated post-delivery snapshot order");
        };
        if remote_branch != &observation.branch
            || remote_sha != &observation.remote_sha
            || remote_sha != &observation.local_sha
            || pull_request.number != observation.pull_request_number
            || pull_request.url != observation.pull_request_url
            || review_target != &observation.review_target
            || review_projection != &observation.review_projection
        {
            return Err(
                "evidence-v1: post-restart delivery did not match post-delivery".to_string(),
            );
        }
        self.snapshots
            .push(LiveDogfoodEvidenceSnapshot::PostRestart {
                issue_identifier: observation.issue_identifier.clone(),
                workspace_identifier: observation.workspace_identifier.clone(),
                generated_branch: observation.branch.clone(),
                local_sha: observation.local_sha.clone(),
                remote_sha: observation.remote_sha.clone(),
                pull_request: LiveDogfoodEvidencePullRequest {
                    number: observation.pull_request_number,
                    url: observation.pull_request_url.clone(),
                },
                review_target: observation.review_target.clone(),
                review_projection: observation.review_projection.clone(),
                transcript_identity: observation.transcript_identity.clone(),
                transcript_count: observation.transcript_count,
                transcript_bytes: observation.transcript_bytes,
                worktree_identity: observation.worktree_identity.clone(),
                worktree_count: observation.worktree_count,
                assertions: vec![
                    evidence_assertion("same_config_location"),
                    evidence_assertion("same_delivery_identity"),
                    evidence_assertion("no_redispatch_or_duplicate_delivery"),
                    evidence_assertion("released_agent_capacity"),
                    evidence_assertion("two_stable_polls"),
                ],
            });
        Ok(())
    }

    fn has_post_delivery(&self) -> bool {
        self.snapshots
            .iter()
            .any(|snapshot| matches!(snapshot, LiveDogfoodEvidenceSnapshot::PostDelivery { .. }))
    }

    fn has_post_restart(&self) -> bool {
        self.snapshots
            .iter()
            .any(|snapshot| matches!(snapshot, LiveDogfoodEvidenceSnapshot::PostRestart { .. }))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LiveDogfoodRecoveryObservation {
    issue_identifier: String,
    run_identifier: String,
    workspace_identifier: String,
    branch: String,
    local_sha: String,
    remote_sha: String,
    pull_request_number: u64,
    pull_request_url: String,
    review_target: String,
    review_projection: String,
    transcript_identity: String,
    transcript_count: usize,
    transcript_bytes: u64,
    worktree_identity: String,
    worktree_count: usize,
    active_agents: usize,
}

impl LiveDogfoodRecoveryObservation {
    #[cfg(test)]
    fn for_test() -> Self {
        Self {
            issue_identifier: "chrisbanes/bamboon#39".to_string(),
            run_identifier: "live-dogfood-restart-order".to_string(),
            workspace_identifier: "run/live-dogfood-restart-order".to_string(),
            branch: "ensemble-live-dogfood-restart-order".to_string(),
            local_sha: "local-sha".to_string(),
            remote_sha: "local-sha".to_string(),
            pull_request_number: 39,
            pull_request_url: "https://github.com/chrisbanes/bamboon/pull/39".to_string(),
            review_target: "In review".to_string(),
            review_projection: "applied".to_string(),
            transcript_identity: "run/transcript-39".to_string(),
            transcript_count: 1,
            transcript_bytes: 999,
            worktree_identity: "workspace/live-dogfood".to_string(),
            worktree_count: 1,
            active_agents: 0,
        }
    }

    fn matches_recovery(&self, recovered: &Self) -> Result<(), String> {
        for (name, expected, actual) in [
            ("issue", &self.issue_identifier, &recovered.issue_identifier),
            ("run", &self.run_identifier, &recovered.run_identifier),
            (
                "workspace",
                &self.workspace_identifier,
                &recovered.workspace_identifier,
            ),
            ("branch", &self.branch, &recovered.branch),
            ("local SHA", &self.local_sha, &recovered.local_sha),
            ("remote SHA", &self.remote_sha, &recovered.remote_sha),
            (
                "pull-request URL",
                &self.pull_request_url,
                &recovered.pull_request_url,
            ),
            (
                "review target",
                &self.review_target,
                &recovered.review_target,
            ),
            (
                "review projection",
                &self.review_projection,
                &recovered.review_projection,
            ),
            (
                "transcript identity",
                &self.transcript_identity,
                &recovered.transcript_identity,
            ),
            (
                "worktree identity",
                &self.worktree_identity,
                &recovered.worktree_identity,
            ),
        ] {
            if expected != actual {
                return Err(format!("verify restart recovery: {name} changed"));
            }
        }
        if self.pull_request_number != recovered.pull_request_number {
            return Err("verify restart recovery: pull-request number changed".to_string());
        }
        for (name, expected, actual) in [
            (
                "transcript count",
                self.transcript_count,
                recovered.transcript_count,
            ),
            (
                "worktree count",
                self.worktree_count,
                recovered.worktree_count,
            ),
        ] {
            if expected != actual {
                return Err(format!("verify restart recovery: {name} changed"));
            }
        }
        if self.transcript_bytes != recovered.transcript_bytes {
            return Err("verify restart recovery: transcript bytes changed".to_string());
        }
        if recovered.active_agents != 0 {
            return Err("verify restart recovery: public agent capacity was consumed".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_issue_identifier(mut self, value: &str) -> Self {
        self.issue_identifier = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_run_identifier(mut self, value: &str) -> Self {
        self.run_identifier = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_workspace_identifier(mut self, value: &str) -> Self {
        self.workspace_identifier = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_branch(mut self, value: &str) -> Self {
        self.branch = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_sha(mut self, value: &str) -> Self {
        self.local_sha = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_pull_request(mut self, value: u64) -> Self {
        self.pull_request_number = value;
        self
    }
    #[cfg(test)]
    fn with_review_projection(mut self, value: &str) -> Self {
        self.review_projection = value.to_string();
        self
    }
    #[cfg(test)]
    fn with_transcript_count(mut self, value: usize) -> Self {
        self.transcript_count = value;
        self
    }
    #[cfg(test)]
    fn with_transcript_bytes(mut self, value: u64) -> Self {
        self.transcript_bytes = value;
        self
    }
    #[cfg(test)]
    fn with_worktree_count(mut self, value: usize) -> Self {
        self.worktree_count = value;
        self
    }
    #[cfg(test)]
    fn with_active_agents(mut self, value: usize) -> Self {
        self.active_agents = value;
        self
    }
}

#[derive(Clone, Copy)]
enum LiveDogfoodHostLifetime {
    First,
    Second,
}

impl LiveDogfoodHostLifetime {
    fn log_names(self) -> (&'static str, &'static str) {
        match self {
            Self::First => ("host-1.stdout.log", "host-1.stderr.log"),
            Self::Second => ("host-2.stdout.log", "host-2.stderr.log"),
        }
    }

    fn all_log_names() -> [&'static str; 4] {
        [
            "host-1.stdout.log",
            "host-1.stderr.log",
            "host-2.stdout.log",
            "host-2.stderr.log",
        ]
    }
}

fn evidence_assertion(name: &'static str) -> LiveDogfoodEvidenceAssertion {
    LiveDogfoodEvidenceAssertion {
        name,
        satisfied: true,
    }
}

fn ensure_no_live_dogfood_publication(
    remote_heads: &str,
    pull_requests: &str,
) -> Result<(), String> {
    if !remote_heads.trim().is_empty() {
        return Err("verify pre-publication: generated remote branch already exists".to_string());
    }
    let pull_requests: Vec<Value> = serde_json::from_str(pull_requests)
        .map_err(|_| "verify pre-publication: pull request observation was invalid".to_string())?;
    if !pull_requests.is_empty() {
        return Err("verify pre-publication: generated pull request already exists".to_string());
    }
    Ok(())
}

fn write_live_dogfood_evidence_v1(
    run_root: &Path,
    evidence: &LiveDogfoodEvidenceV1,
) -> Result<(), String> {
    write_live_dogfood_evidence_v1_with_replace(run_root, evidence, |from, to| fs::rename(from, to))
}

fn write_live_dogfood_evidence_v1_with_replace(
    run_root: &Path,
    evidence: &LiveDogfoodEvidenceV1,
    replace: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    let target = run_root.join("evidence-v1.json");
    let temporary = run_root.join(format!(
        ".evidence-v1-{:x}-{:x}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "evidence-v1: clock was unavailable")?
            .as_nanos(),
        std::process::id()
    ));
    let serialized = serde_json::to_vec_pretty(evidence)
        .map_err(|_| "evidence-v1: could not serialize document")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "evidence-v1: could not create temporary document")?;
    file.write_all(&serialized)
        .map_err(|_| "evidence-v1: could not write temporary document")?;
    file.sync_all()
        .map_err(|_| "evidence-v1: could not flush temporary document")?;
    drop(file);
    replace(&temporary, &target)
        .map_err(|_| "evidence-v1: atomic replacement failed".to_string())?;
    fs::File::open(run_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "evidence-v1: could not flush run directory".to_string())
}

fn persist_live_dogfood_failure(
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
    inputs: &LiveDogfoodInputs,
    pre_publication_captured: bool,
    error: &str,
) -> Result<(), String> {
    if evidence.final_state.absent.is_empty() && evidence.final_state.retained.is_empty() {
        evidence.preserve_discovered_artifacts();
    }
    let assertions_not_reached = if evidence.has_post_restart() {
        ["cleanup_completion"].as_slice()
    } else if evidence.has_post_delivery() {
        ["post_restart"].as_slice()
    } else if pre_publication_captured {
        ["post_delivery"].as_slice()
    } else {
        ["pre_publication", "post_delivery"].as_slice()
    };
    evidence.append_preserved_failure(
        live_dogfood_failure_observation(error),
        assertions_not_reached.iter().copied(),
        inputs,
        None,
    )?;
    write_live_dogfood_evidence_v1(&run.root, evidence)
}

fn live_dogfood_failure_observation(error: &str) -> &'static str {
    for (prefix, observation) in [
        ("wait for host:", "wait for host"),
        ("wait for Project status", "wait for Project status"),
        (
            "wait for pre-publication local artifact:",
            "wait for local artifact",
        ),
        (
            "verify pre-publication remote branch:",
            "verify pre-publication remote branch",
        ),
        (
            "verify pre-publication pull request:",
            "verify pre-publication pull request",
        ),
        (
            "wait for review-projected host state:",
            "wait for review-projected host state",
        ),
        ("wait for public history:", "wait for public history"),
        (
            "verify published remote branch:",
            "verify published remote branch",
        ),
        (
            "verify published pull request:",
            "verify published pull request",
        ),
        ("verify public host detail:", "verify public host detail"),
        ("wait for restarted host:", "wait for restarted host"),
        ("start second host:", "start second host"),
        (
            "verify restart public detail:",
            "verify restart public detail",
        ),
        (
            "verify restart public history:",
            "verify restart public history",
        ),
        (
            "verify restart public state:",
            "verify restart public state",
        ),
        ("verify restart delivery:", "verify restart delivery"),
        (
            "verify restart persisted worktree:",
            "verify restart persisted worktree",
        ),
        (
            "verify restart persisted transcript:",
            "verify restart persisted transcript",
        ),
        ("verify restart recovery:", "verify restart recovery"),
    ] {
        if error.starts_with(prefix) {
            return observation;
        }
    }
    "dispatch-and-later verification"
}

fn live_dogfood_config(inputs: &LiveDogfoodInputs, run: &LiveDogfoodRun) -> String {
    let artifact = run.expected_artifact();
    let prompt = format!(
        "Work only on this issue. Create exactly {} with exactly this content:\n{} Commit it with exactly this message: {}. Run a lightweight verification. Do not push, create a pull request, or change any other tracked file. End with a JSON step output declaring success and a concise summary.",
        artifact.path.display(), artifact.content, artifact.commit_message,
    );
    format!(
        r#"tracker:
  kind: github
  repository: chrisbanes/bamboon
  project_number: {}
  github:
    status_field: Status
  active_states:
    - Ready to implement
    - In progress
  terminal_states:
    - Done
workspace:
  root: {}
repos:
  - path: {}
    branch: main
    finalize:
      mode: push_and_pr
      approval_required: false
      review_state: In review
agents:
  builder:
    acpx_agent: {}
    permission_mode: approve_reads
    prompt: {}
steps:
  - name: implement
    agent: builder
    tracker_state: In progress
on_success: Done
on_failure: Done
max_cycles: 1
polling:
  interval_ms: {LIVE_DOGFOOD_POLL_INTERVAL_MS}
concurrency:
  max_concurrent_agents: 1
  max_step_parallelism: 1
agent:
  permission_request_policy:
    mode: reject_all
  turn_timeout_ms: 1800000
"#,
        inputs.project_number,
        yaml_quote(&run.root.join("workspaces").display().to_string()),
        yaml_quote(&inputs.bamboon_path.display().to_string()),
        yaml_quote(&inputs.agent),
        yaml_string(&prompt),
    )
}

fn yaml_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

#[derive(Debug)]
struct LiveDogfoodProject {
    id: String,
    status_field_id: String,
    ready_option_id: String,
    done_option_id: String,
}

struct PreDispatchResources {
    issue_id: String,
    issue_number: u64,
    project_id: String,
    project_item_id: String,
}

struct LiveDogfoodResources {
    issue_id: String,
    issue_number: u64,
    project: LiveDogfoodProject,
    project_item_id: String,
}

fn run_live_command(
    phase: &str,
    mut command: Command,
    inputs: &LiveDogfoodInputs,
) -> Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("{phase}: could not start command: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(live_command_timeout(phase));
            }
            Err(error) => return Err(format!("{phase}: command wait failed: {error}")),
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if status.success() {
        Ok(stdout)
    } else {
        let last_observation = redact_live_dogfood(&stderr, inputs, None);
        Err(format!(
            "{phase}: command exited {status}; last observation: {last_observation}"
        ))
    }
}

fn live_command_timeout(phase: &str) -> String {
    format!(
        "{phase}: command timed out after 30 seconds; last observation: command was still running"
    )
}

fn live_gh(
    phase: &str,
    arguments: impl IntoIterator<Item = String>,
    inputs: &LiveDogfoodInputs,
) -> Result<String, String> {
    let mut command = Command::new("gh");
    command.args(arguments);
    run_live_command(phase, command, inputs)
}

fn live_git(
    phase: &str,
    path: &Path,
    arguments: impl IntoIterator<Item = String>,
    inputs: &LiveDogfoodInputs,
) -> Result<String, String> {
    let mut command = Command::new("git");
    command.current_dir(path).args(arguments);
    run_live_command(phase, command, inputs)
}

fn live_project_query(inputs: &LiveDogfoodInputs) -> Result<Value, String> {
    const QUERY: &str = r#"query($owner: String!, $repo: String!, $projectNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $projectNumber) {
      id title viewerCanUpdate
      fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
      items(first: 100) {
        totalCount
        nodes {
          id
          content { ... on Issue { id number } }
          fieldValues(first: 20) {
            nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } }
          }
        }
      }
      workflows(first: 100) { nodes { enabled } }
    }
  }
}"#;
    let output = live_gh(
        "preflight project discovery",
        [
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={QUERY}"),
            "-F".to_string(),
            "owner=chrisbanes".to_string(),
            "-F".to_string(),
            "repo=bamboon".to_string(),
            "-F".to_string(),
            format!("projectNumber={}", inputs.project_number),
        ],
        inputs,
    )?;
    serde_json::from_str(&output)
        .map_err(|error| format!("preflight project discovery: invalid response: {error}"))
}

fn validate_live_project(inputs: &LiveDogfoodInputs) -> Result<LiveDogfoodProject, String> {
    let response = live_project_query(inputs)?;
    validate_live_project_response(&response)
}

fn validate_live_project_response(response: &Value) -> Result<LiveDogfoodProject, String> {
    let project = &response["data"]["repository"]["projectV2"];
    if project["title"] != "Ensemble Dogfood" || project["viewerCanUpdate"] != true {
        return Err("preflight project discovery: Project title or write access did not match the fixture contract".to_string());
    }
    if project["items"]["totalCount"].as_u64() != Some(0) {
        return Err(
            "preflight project discovery: Project must have no items before dispatch".to_string(),
        );
    }
    if project["workflows"]["nodes"]
        .as_array()
        .is_none_or(|workflows| workflows.iter().any(|workflow| workflow["enabled"] == true))
    {
        return Err(
            "preflight project discovery: Project must not have enabled workflows".to_string(),
        );
    }
    let status_fields = project["fields"]["nodes"]
        .as_array()
        .ok_or_else(|| "preflight project discovery: Project fields were unavailable".to_string())?
        .iter()
        .filter(|field| field["name"] == "Status")
        .collect::<Vec<_>>();
    if status_fields.len() != 1 {
        return Err(
            "preflight project discovery: Project must have exactly one Status field".to_string(),
        );
    }
    let status_field = status_fields[0];
    let status_names = status_field["options"]
        .as_array()
        .ok_or_else(|| "preflight project discovery: Status options were unavailable".to_string())?
        .iter()
        .filter_map(|option| option["name"].as_str())
        .collect::<Vec<_>>();
    if status_names != LIVE_DOGFOOD_STATUSES {
        return Err(
            "preflight project discovery: Status options did not match the fixture contract"
                .to_string(),
        );
    }
    Ok(LiveDogfoodProject {
        id: project["id"]
            .as_str()
            .ok_or_else(|| "preflight project discovery: Project ID was unavailable".to_string())?
            .to_string(),
        status_field_id: status_field["id"]
            .as_str()
            .ok_or_else(|| {
                "preflight project discovery: Status field ID was unavailable".to_string()
            })?
            .to_string(),
        ready_option_id: status_field["options"]
            .as_array()
            .and_then(|options| options.first())
            .and_then(|option| option["id"].as_str())
            .ok_or_else(|| {
                "preflight project discovery: Ready status ID was unavailable".to_string()
            })?
            .to_string(),
        done_option_id: status_field["options"]
            .as_array()
            .and_then(|options| options.last())
            .and_then(|option| option["id"].as_str())
            .ok_or_else(|| {
                "preflight project discovery: Done status ID was unavailable".to_string()
            })?
            .to_string(),
    })
}

fn validate_live_bamboon_clone(inputs: &LiveDogfoodInputs) -> Result<(), String> {
    let root = &inputs.bamboon_path;
    if !root.is_dir() {
        return Err("preflight Bamboon clone: configured path was not a directory".to_string());
    }
    let inside = live_git(
        "preflight Bamboon clone",
        root,
        ["rev-parse".to_string(), "--is-inside-work-tree".to_string()],
        inputs,
    )?;
    if inside.trim() != "true" {
        return Err("preflight Bamboon clone: configured path was not a Git worktree".to_string());
    }
    let branch = live_git(
        "preflight Bamboon branch",
        root,
        ["branch".to_string(), "--show-current".to_string()],
        inputs,
    )?;
    if branch.trim() != "main" {
        return Err("preflight Bamboon branch: checked-out branch must be main".to_string());
    }
    validated_live_bamboon_remote(inputs, root, "preflight Bamboon remote")?;
    let status = live_git(
        "preflight Bamboon cleanliness",
        root,
        ["status".to_string(), "--porcelain".to_string()],
        inputs,
    )?;
    if !status.is_empty() {
        return Err(
            "preflight Bamboon cleanliness: clone must have no tracked or untracked changes"
                .to_string(),
        );
    }
    Ok(())
}

fn is_bamboon_remote(remote: &str) -> bool {
    matches!(
        remote.strip_suffix(".git").unwrap_or(remote),
        "git@github.com:chrisbanes/bamboon"
            | "ssh://git@github.com/chrisbanes/bamboon"
            | "https://github.com/chrisbanes/bamboon"
    )
}

fn validated_live_bamboon_remote(
    inputs: &LiveDogfoodInputs,
    worktree: &Path,
    phase: &str,
) -> Result<String, String> {
    let remote = live_git(
        phase,
        worktree,
        [
            "remote".to_string(),
            "get-url".to_string(),
            "origin".to_string(),
        ],
        inputs,
    )?;
    let remote = remote.trim();
    if !is_bamboon_remote(remote) {
        return Err(format!("{phase}: origin must identify chrisbanes/bamboon"));
    }
    Ok(remote.to_string())
}

fn live_preflight(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
) -> Result<(String, LiveDogfoodProject), String> {
    run_live_command("preflight gh", Command::new("gh"), inputs)?;
    let mut acpx = Command::new("acpx");
    acpx.arg("--version");
    let acpx_version = run_live_command("preflight ACPX", acpx, inputs)?;
    fs::write(run.root.join("acpx.version"), acpx_version)
        .map_err(|error| format!("preflight ACPX: could not retain version metadata: {error}"))?;
    fs::write(run.root.join("agent.txt"), &inputs.agent)
        .map_err(|error| format!("preflight ACPX: could not retain agent metadata: {error}"))?;
    validate_live_bamboon_clone(inputs)?;
    live_gh(
        "preflight GitHub access",
        ["api".to_string(), "user".to_string()],
        inputs,
    )?;
    let project = validate_live_project(inputs)?;
    let token = live_gh(
        "preflight GitHub token",
        ["auth".to_string(), "token".to_string()],
        inputs,
    )?;
    if token.trim().is_empty() {
        return Err("preflight GitHub token: gh returned an empty token".to_string());
    }
    Ok((token.trim().to_string(), project))
}

fn live_project_item_status(
    inputs: &LiveDogfoodInputs,
    issue_id: &str,
) -> Result<Option<String>, String> {
    let response = live_project_query(inputs)?;
    Ok(
        response["data"]["repository"]["projectV2"]["items"]["nodes"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["content"]["id"] == issue_id)
                    .and_then(|item| item["fieldValues"]["nodes"].as_array())
                    .and_then(|fields| {
                        fields.iter().find_map(|field| {
                            (field["field"]["name"] == "Status")
                                .then(|| field["name"].as_str().map(ToString::to_string))
                                .flatten()
                        })
                    })
            }),
    )
}

fn revalidate_live_project_item(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<String, String> {
    let response = live_project_query(inputs)?;
    let item = validate_live_project_item_identity(
        &response,
        &plan.project_id,
        &plan.project_item_id,
        &plan.issue_id,
        plan.issue_number,
        "cleanup Project item",
    )?;
    item["fieldValues"]["nodes"]
        .as_array()
        .and_then(|fields| {
            fields.iter().find_map(|field| {
                (field["field"]["name"] == "Status")
                    .then(|| field["name"].as_str().map(ToString::to_string))
                    .flatten()
            })
        })
        .ok_or_else(|| {
            "cleanup Project item: stored Status observation was unavailable".to_string()
        })
}

fn validate_live_project_item_identity<'a>(
    response: &'a Value,
    project_id: &str,
    project_item_id: &str,
    issue_id: &str,
    issue_number: u64,
    phase: &str,
) -> Result<&'a Value, String> {
    let project = &response["data"]["repository"]["projectV2"];
    if project["id"].as_str() != Some(project_id) {
        return Err(format!(
            "{phase}: stored Project identity no longer matched"
        ));
    }
    let matching = project["items"]["nodes"]
        .as_array()
        .ok_or_else(|| format!("{phase}: Project items were unavailable"))?
        .iter()
        .filter(|item| item["id"].as_str() == Some(project_item_id))
        .collect::<Vec<_>>();
    let [item] = matching.as_slice() else {
        return Err(format!("{phase}: stored item was missing or ambiguous"));
    };
    if item["content"]["id"].as_str() != Some(issue_id)
        || item["content"]["number"].as_u64() != Some(issue_number)
    {
        return Err(format!("{phase}: stored item ownership no longer matched"));
    }
    Ok(item)
}

fn capture_live_pull_request_identity(
    inputs: &LiveDogfoodInputs,
    number: u64,
    expected_state: &str,
) -> Result<LiveDogfoodPullRequestIdentity, String> {
    let output = live_gh(
        "cleanup pull request revalidation",
        [
            "pr".to_string(),
            "view".to_string(),
            number.to_string(),
            "--repo".to_string(),
            "chrisbanes/bamboon".to_string(),
            "--json".to_string(),
            "id,number,url,state,headRefName,headRefOid,baseRefName".to_string(),
        ],
        inputs,
    )?;
    let value: Value = serde_json::from_str(&output)
        .map_err(|_| "cleanup pull request revalidation: invalid GitHub response".to_string())?;
    let identity = LiveDogfoodPullRequestIdentity {
        id: value["id"]
            .as_str()
            .ok_or_else(|| {
                "cleanup pull request revalidation: node ID was unavailable".to_string()
            })?
            .to_string(),
        number: value["number"].as_u64().ok_or_else(|| {
            "cleanup pull request revalidation: number was unavailable".to_string()
        })?,
        url: value["url"]
            .as_str()
            .ok_or_else(|| "cleanup pull request revalidation: URL was unavailable".to_string())?
            .to_string(),
        state: value["state"]
            .as_str()
            .ok_or_else(|| "cleanup pull request revalidation: state was unavailable".to_string())?
            .to_string(),
        head: value["headRefName"]
            .as_str()
            .ok_or_else(|| {
                "cleanup pull request revalidation: head ref was unavailable".to_string()
            })?
            .to_string(),
        sha: value["headRefOid"]
            .as_str()
            .ok_or_else(|| {
                "cleanup pull request revalidation: head SHA was unavailable".to_string()
            })?
            .to_string(),
        base: value["baseRefName"]
            .as_str()
            .ok_or_else(|| {
                "cleanup pull request revalidation: base ref was unavailable".to_string()
            })?
            .to_string(),
    };
    if identity.state != expected_state {
        return Err("cleanup pull request revalidation: state no longer matched".to_string());
    }
    Ok(identity)
}

fn revalidate_live_issue(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
    expected_state: &str,
) -> Result<(), String> {
    revalidate_live_issue_identity(
        inputs,
        &plan.issue_id,
        plan.issue_number,
        expected_state,
        "cleanup issue",
    )
}

fn revalidate_live_issue_identity(
    inputs: &LiveDogfoodInputs,
    issue_id: &str,
    issue_number: u64,
    expected_state: &str,
    phase: &str,
) -> Result<(), String> {
    let output = live_gh(
        &format!("{phase} revalidation"),
        [
            "api".to_string(),
            format!("repos/chrisbanes/bamboon/issues/{issue_number}"),
        ],
        inputs,
    )?;
    let issue: Value = serde_json::from_str(&output)
        .map_err(|_| format!("{phase} revalidation: invalid GitHub response"))?;
    validate_live_issue_identity(&issue, issue_id, issue_number, expected_state, phase)
}

fn validate_live_issue_identity(
    issue: &Value,
    issue_id: &str,
    issue_number: u64,
    expected_state: &str,
    phase: &str,
) -> Result<(), String> {
    if issue["node_id"].as_str() != Some(issue_id)
        || issue["number"].as_u64() != Some(issue_number)
        || issue["state"].as_str() != Some(expected_state)
    {
        return Err(format!(
            "{phase} revalidation: stored issue identity or state no longer matched"
        ));
    }
    Ok(())
}

fn revalidate_live_remote_ref(
    inputs: &LiveDogfoodInputs,
    worktree: &Path,
    plan: &LiveDogfoodCleanupPlan,
    remote_url: &str,
) -> Result<(), String> {
    let remote_refs = live_git(
        "cleanup generated ref revalidation",
        worktree,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            remote_url.to_string(),
            format!("refs/heads/{}", plan.branch),
        ],
        inputs,
    )?;
    let expected = format!("{}\trefs/heads/{}", plan.expected_sha, plan.branch);
    if remote_refs.lines().collect::<Vec<_>>() != [expected] {
        return Err("cleanup generated ref revalidation: stored ref no longer matched".to_string());
    }
    Ok(())
}

fn revalidate_live_pull_request(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
    expected_state: &str,
) -> Result<(), String> {
    capture_live_pull_request_identity(inputs, plan.pull_request.number, expected_state)?
        .validate_against(plan, expected_state)
}

fn close_live_pull_request(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    revalidate_live_pull_request(inputs, plan, "OPEN")?;
    live_gh(
        "cleanup close pull request",
        [
            "pr".to_string(),
            "close".to_string(),
            plan.pull_request.number.to_string(),
            "--repo".to_string(),
            "chrisbanes/bamboon".to_string(),
        ],
        inputs,
    )?;
    revalidate_live_pull_request(inputs, plan, "CLOSED")
}

fn set_live_project_done(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    if revalidate_live_project_item(inputs, plan)? != "In review" {
        return Err("cleanup Project item: expected In review before Done".to_string());
    }
    set_live_project_item_status(
        "cleanup project Done",
        inputs,
        &plan.project_id,
        &plan.project_item_id,
        &plan.status_field_id,
        &plan.done_option_id,
    )?;
    if revalidate_live_project_item(inputs, plan)? != "Done" {
        return Err("cleanup Project item: Done mutation was not observed".to_string());
    }
    Ok(())
}

fn stop_and_reap_live_host(host: &mut Child) -> Result<(), String> {
    if host
        .try_wait()
        .map_err(|error| format!("cleanup stop host: status unavailable: {error}"))?
        .is_none()
    {
        host.kill()
            .map_err(|error| format!("cleanup stop host: kill failed: {error}"))?;
        host.wait()
            .map_err(|error| format!("cleanup stop host: reap failed: {error}"))?;
    }
    if host
        .try_wait()
        .map_err(|error| format!("cleanup stop host: final status unavailable: {error}"))?
        .is_none()
    {
        return Err("cleanup stop host: child was not reaped".to_string());
    }
    Ok(())
}

fn run_live_preserve_completion(
    host: &mut Child,
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
) -> Result<(), String> {
    stop_and_reap_live_host(host)?;
    evidence.append_transition("preserve_stop_and_reap_host", "succeeded");
    evidence.preserve_certification();
    write_live_dogfood_evidence_v1(&run.root, evidence)
}

fn finalize_live_restarted_run_failure(
    host: &mut Child,
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
    inputs: &LiveDogfoodInputs,
    pre_publication_captured: bool,
    mut error: String,
) -> String {
    let child_was_active = host.try_wait().map_or(true, |status| status.is_none());
    match stop_and_reap_live_host(host) {
        Ok(()) if child_was_active => evidence.append_transition("failure_host_reap", "succeeded"),
        Ok(()) => evidence.append_transition("failure_child_absence", "succeeded"),
        Err(reap_error) => {
            error = format!("{error}; {reap_error}");
            evidence.append_transition("failure_host_reap", "preserved_failure");
        }
    }
    evidence.preserve_after_transitions();
    persist_live_dogfood_failure(evidence, run, inputs, pre_publication_captured, &error)
        .err()
        .unwrap_or(error)
}

fn canonical_live_worktree_path(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.exists() {
        let (Some(parent), Some(file_name)) = (existing.parent(), existing.file_name()) else {
            return path.to_path_buf();
        };
        missing.push(file_name.to_os_string());
        existing = parent;
    }

    let mut canonical = fs::canonicalize(existing).unwrap_or_else(|_| existing.to_path_buf());
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    canonical
}

fn worktree_is_registered(listing: &str, worktree: &Path) -> bool {
    let expected = canonical_live_worktree_path(worktree);
    listing
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .any(|path| canonical_live_worktree_path(Path::new(path)) == expected)
}

fn live_public_issue_released(detail: &Value) -> bool {
    detail.get("running").is_some_and(Value::is_null)
        && detail
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status == "Done" || status.starts_with("completed_"))
}

async fn wait_for_live_host_release(
    client: &reqwest::Client,
    base_url: &str,
    inputs: &LiveDogfoodInputs,
    issue_number: u64,
    worktree: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    let detail_url = format!("{base_url}/api/v1/chrisbanes%2Fbamboon%23{issue_number}");
    loop {
        let public_released = match client.get(&detail_url).send().await {
            Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => true,
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .is_ok_and(|detail| live_public_issue_released(&detail)),
            _ => false,
        };
        let capacity_released = match client.get(format!("{base_url}/api/v1/state")).send().await {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .is_ok_and(|state| validate_live_public_agent_capacity(&state).is_ok()),
            _ => false,
        };
        let worktree_absent = !worktree.exists();
        let worktree_unregistered = live_git(
            "cleanup worktree release observation",
            &inputs.bamboon_path,
            [
                "worktree".to_string(),
                "list".to_string(),
                "--porcelain".to_string(),
            ],
            inputs,
        )
        .is_ok_and(|listing| !worktree_is_registered(&listing, worktree));
        if public_released && capacity_released && worktree_absent && worktree_unregistered {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "cleanup wait for host release: timed out; last observation: public_released={public_released}, capacity_released={capacity_released}, worktree_absent={worktree_absent}, worktree_unregistered={worktree_unregistered}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(LIVE_DOGFOOD_POLL_INTERVAL_MS)).await;
    }
}

fn close_live_issue(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    close_live_issue_identity(inputs, &plan.issue_id, plan.issue_number, "cleanup issue")
}

fn close_live_issue_identity(
    inputs: &LiveDogfoodInputs,
    issue_id: &str,
    issue_number: u64,
    phase: &str,
) -> Result<(), String> {
    revalidate_live_issue_identity(inputs, issue_id, issue_number, "open", phase)?;
    live_gh(
        &format!("{phase} close"),
        [
            "api".to_string(),
            "--method".to_string(),
            "PATCH".to_string(),
            format!("repos/chrisbanes/bamboon/issues/{issue_number}"),
            "-f".to_string(),
            "state=closed".to_string(),
        ],
        inputs,
    )?;
    revalidate_live_issue_identity(inputs, issue_id, issue_number, "closed", phase)
}

fn remove_live_project_item(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    if revalidate_live_project_item(inputs, plan)? != "Done" {
        return Err("cleanup remove Project item: expected Done item".to_string());
    }
    delete_live_project_item(
        inputs,
        &plan.project_id,
        &plan.project_item_id,
        "cleanup remove Project item",
    )
}

fn delete_live_project_item(
    inputs: &LiveDogfoodInputs,
    project_id: &str,
    project_item_id: &str,
    phase: &str,
) -> Result<(), String> {
    const REMOVE_ITEM: &str = r#"mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) { deletedItemId }
}"#;
    live_graphql_mutation(
        phase,
        REMOVE_ITEM,
        [
            ("projectId".to_string(), project_id.to_string()),
            ("itemId".to_string(), project_item_id.to_string()),
        ],
        inputs,
    )?;
    let response = live_project_query(inputs)?;
    validate_live_project_item_absence(&response, project_id, project_item_id)
}

fn validate_live_project_item_absence(
    response: &Value,
    project_id: &str,
    project_item_id: &str,
) -> Result<(), String> {
    let project = &response["data"]["repository"]["projectV2"];
    if project["id"].as_str() != Some(project_id) {
        return Err("cleanup Project item absence: Project identity did not match".to_string());
    }
    let items = project["items"]["nodes"]
        .as_array()
        .ok_or_else(|| "cleanup Project item absence: items were unavailable".to_string())?;
    if items
        .iter()
        .any(|item| item["id"].as_str() == Some(project_item_id))
    {
        return Err("cleanup Project item absence: item remained present".to_string());
    }
    Ok(())
}

fn delete_live_remote_ref(
    inputs: &LiveDogfoodInputs,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    let remote = validated_live_bamboon_remote(
        inputs,
        &inputs.bamboon_path,
        "cleanup generated ref origin revalidation",
    )?;
    revalidate_live_remote_ref(inputs, &inputs.bamboon_path, plan, &remote)?;
    delete_live_remote_ref_at_sha(
        inputs,
        &inputs.bamboon_path,
        &remote,
        &plan.branch,
        &plan.expected_sha,
    )?;
    let remaining = live_git(
        "cleanup verify generated ref absence",
        &inputs.bamboon_path,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            remote,
            format!("refs/heads/{}", plan.branch),
        ],
        inputs,
    )?;
    if !remaining.trim().is_empty() {
        return Err("cleanup delete generated ref: ref remained present".to_string());
    }
    Ok(())
}

fn delete_live_remote_ref_at_sha(
    inputs: &LiveDogfoodInputs,
    worktree: &Path,
    remote: &str,
    branch: &str,
    expected_sha: &str,
) -> Result<(), String> {
    live_git(
        "cleanup delete generated ref",
        worktree,
        [
            "push".to_string(),
            format!("--force-with-lease=refs/heads/{branch}:{expected_sha}"),
            "--delete".to_string(),
            remote.to_string(),
            branch.to_string(),
        ],
        inputs,
    )
    .map(|_| ())
}

fn validate_live_final_absence(observations: [bool; 6]) -> Result<(), String> {
    let names = [
        "pull request closed",
        "issue closed",
        "Project item absent",
        "generated ref absent",
        "workspace worktree absent",
        "active child absent",
    ];
    let missing = observations
        .into_iter()
        .zip(names)
        .filter_map(|(satisfied, name)| (!satisfied).then_some(name))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "cleanup final absence: required observations failed: {}",
            missing.join(", ")
        ))
    }
}

fn verify_live_final_absence(
    inputs: &LiveDogfoodInputs,
    host: &mut Child,
    worktree: &Path,
    plan: &LiveDogfoodCleanupPlan,
) -> Result<(), String> {
    let pull_request_closed = revalidate_live_pull_request(inputs, plan, "CLOSED").is_ok();
    let issue_closed = revalidate_live_issue(inputs, plan, "closed").is_ok();
    let project_item_absent = live_project_query(inputs).is_ok_and(|response| {
        validate_live_project_item_absence(&response, &plan.project_id, &plan.project_item_id)
            .is_ok()
    });
    let generated_ref_absent = live_git(
        "cleanup final generated ref observation",
        &inputs.bamboon_path,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            "origin".to_string(),
            format!("refs/heads/{}", plan.branch),
        ],
        inputs,
    )
    .is_ok_and(|output| output.trim().is_empty());
    let workspace_worktree_absent = !worktree.exists()
        && live_git(
            "cleanup final worktree observation",
            &inputs.bamboon_path,
            [
                "worktree".to_string(),
                "list".to_string(),
                "--porcelain".to_string(),
            ],
            inputs,
        )
        .is_ok_and(|listing| !worktree_is_registered(&listing, worktree));
    let active_child_absent = host.try_wait().is_ok_and(|status| status.is_some());

    validate_live_final_absence([
        pull_request_closed,
        issue_closed,
        project_item_absent,
        generated_ref_absent,
        workspace_worktree_absent,
        active_child_absent,
    ])
}

fn record_live_cleanup_step(
    cleanup: &mut LiveDogfoodCleanupRecorder,
    evidence: &mut LiveDogfoodEvidenceV1,
    step: LiveDogfoodCleanupStep,
    result: Result<(), String>,
) -> Result<(), String> {
    match result {
        Ok(()) => {
            cleanup.attempt(step, Ok(()))?;
            evidence.append_transition(step.name(), "succeeded");
            Ok(())
        }
        Err(error) => {
            cleanup
                .attempt(step, Err(error.as_str()))
                .expect_err("failed cleanup step must stop the recorder");
            evidence.append_transition(step.name(), "preserved_failure");
            Err(error)
        }
    }
}

fn persist_live_cleanup_result(
    cleanup: &mut LiveDogfoodCleanupRecorder,
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
    step: LiveDogfoodCleanupStep,
    result: Result<(), String>,
    persist: &mut impl FnMut(&Path, &LiveDogfoodEvidenceV1) -> Result<(), String>,
) -> Result<(), String> {
    match record_live_cleanup_step(cleanup, evidence, step, result) {
        Ok(()) => persist(&run.root, evidence),
        Err(error) => {
            persist(&run.root, evidence)
                .map_err(|write_error| format!("{error}; {write_error}"))?;
            Err(error)
        }
    }
}

trait LiveDogfoodCleanupActions {
    async fn execute(&mut self, step: LiveDogfoodCleanupStep) -> Result<(), String>;
}

struct LiveDogfoodRoutineCleanupActions<'a> {
    client: &'a reqwest::Client,
    base_url: &'a str,
    inputs: &'a LiveDogfoodInputs,
    host: &'a mut Child,
    worktree: &'a Path,
    plan: &'a LiveDogfoodCleanupPlan,
}

impl LiveDogfoodCleanupActions for LiveDogfoodRoutineCleanupActions<'_> {
    async fn execute(&mut self, step: LiveDogfoodCleanupStep) -> Result<(), String> {
        match step {
            LiveDogfoodCleanupStep::ClosePullRequest => {
                close_live_pull_request(self.inputs, self.plan)
            }
            LiveDogfoodCleanupStep::ProjectDone => set_live_project_done(self.inputs, self.plan),
            LiveDogfoodCleanupStep::WaitForHostRelease => {
                wait_for_live_host_release(
                    self.client,
                    self.base_url,
                    self.inputs,
                    self.plan.issue_number,
                    self.worktree,
                )
                .await
            }
            LiveDogfoodCleanupStep::StopAndReapHost => stop_and_reap_live_host(self.host),
            LiveDogfoodCleanupStep::CloseIssue => close_live_issue(self.inputs, self.plan),
            LiveDogfoodCleanupStep::RemoveProjectItem => {
                remove_live_project_item(self.inputs, self.plan)
            }
            LiveDogfoodCleanupStep::DeleteGeneratedRef => {
                delete_live_remote_ref(self.inputs, self.plan)
            }
            LiveDogfoodCleanupStep::VerifyFinalAbsence => {
                verify_live_final_absence(self.inputs, self.host, self.worktree, self.plan)
            }
        }
    }
}

async fn execute_live_cleanup_sequence(
    actions: &mut impl LiveDogfoodCleanupActions,
    cleanup: &mut LiveDogfoodCleanupRecorder,
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
) -> Result<(), String> {
    execute_live_cleanup_sequence_with_writer(
        actions,
        cleanup,
        evidence,
        run,
        write_live_dogfood_evidence_v1,
    )
    .await
}

async fn execute_live_cleanup_sequence_with_writer(
    actions: &mut impl LiveDogfoodCleanupActions,
    cleanup: &mut LiveDogfoodCleanupRecorder,
    evidence: &mut LiveDogfoodEvidenceV1,
    run: &LiveDogfoodRun,
    mut persist: impl FnMut(&Path, &LiveDogfoodEvidenceV1) -> Result<(), String>,
) -> Result<(), String> {
    for step in LIVE_DOGFOOD_CLEANUP_ORDER {
        evidence.append_transition(step.name(), "attempting");
        persist(&run.root, evidence)?;
        let result = actions.execute(step).await;
        persist_live_cleanup_result(cleanup, evidence, run, step, result, &mut persist)?;
    }
    Ok(())
}

async fn run_live_routine_cleanup(
    client: &reqwest::Client,
    base_url: &str,
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    resources: &LiveDogfoodResources,
    host: &mut Child,
    worktree: &Path,
    branch: &str,
    sha: &str,
    pull_request_number: u64,
    evidence: &mut LiveDogfoodEvidenceV1,
) -> Result<(), String> {
    let plan = (|| {
        let pull_request = capture_live_pull_request_identity(inputs, pull_request_number, "OPEN")?;
        LiveDogfoodCleanupPlan::from_live(resources, run, worktree, branch, sha, &pull_request)
    })();
    let plan = match plan {
        Ok(plan) => {
            evidence.append_transition("prepare_cleanup", "succeeded");
            write_live_dogfood_evidence_v1(&run.root, evidence)?;
            plan
        }
        Err(error) => {
            evidence.append_transition("prepare_cleanup", "preserved_failure");
            write_live_dogfood_evidence_v1(&run.root, evidence)?;
            return Err(error);
        }
    };
    let mut cleanup = LiveDogfoodCleanupRecorder::new(&plan)?;
    let mut actions = LiveDogfoodRoutineCleanupActions {
        client,
        base_url,
        inputs,
        host,
        worktree,
        plan: &plan,
    };
    execute_live_cleanup_sequence(&mut actions, &mut cleanup, evidence, run).await?;
    if !cleanup.is_complete() {
        return Err("cleanup final absence: transition plan was incomplete".to_string());
    }
    evidence.routine_cleaned();
    write_live_dogfood_evidence_v1(&run.root, evidence)
}

fn live_graphql_mutation(
    phase: &str,
    query: &str,
    variables: impl IntoIterator<Item = (String, String)>,
    inputs: &LiveDogfoodInputs,
) -> Result<Value, String> {
    let mut arguments = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
    ];
    for (name, value) in variables {
        arguments.extend(["-F".to_string(), format!("{name}={value}")]);
    }
    let output = live_gh(phase, arguments, inputs)?;
    parse_live_graphql_response(phase, &output)
}

fn set_live_project_item_status(
    phase: &str,
    inputs: &LiveDogfoodInputs,
    project_id: &str,
    item_id: &str,
    field_id: &str,
    option_id: &str,
) -> Result<Value, String> {
    const SET_STATUS: &str = r#"mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } }
}"#;
    live_graphql_mutation(
        phase,
        SET_STATUS,
        [
            ("projectId".to_string(), project_id.to_string()),
            ("itemId".to_string(), item_id.to_string()),
            ("fieldId".to_string(), field_id.to_string()),
            ("optionId".to_string(), option_id.to_string()),
        ],
        inputs,
    )
}

fn parse_live_graphql_response(phase: &str, output: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_str(output)
        .map_err(|error| format!("{phase}: invalid response: {error}"))?;
    if response["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(format!("{phase}: GraphQL returned errors"));
    }
    Ok(response)
}

fn validate_pre_dispatch_project_item_identity(
    response: &Value,
    resources: &PreDispatchResources,
) -> Result<(), String> {
    validate_live_project_item_identity(
        response,
        &resources.project_id,
        &resources.project_item_id,
        &resources.issue_id,
        resources.issue_number,
        "pre-dispatch rollback Project item",
    )
    .map(|_| ())
}

fn rollback_pre_dispatch(
    resources: &PreDispatchResources,
    inputs: &LiveDogfoodInputs,
) -> Result<(), String> {
    if !resources.project_item_id.is_empty() {
        let before = live_project_query(inputs)?;
        validate_pre_dispatch_project_item_identity(&before, resources)?;
        delete_live_project_item(
            inputs,
            &resources.project_id,
            &resources.project_item_id,
            "pre-dispatch rollback project item",
        )?;
    }
    close_live_issue_identity(
        inputs,
        &resources.issue_id,
        resources.issue_number,
        "pre-dispatch rollback issue",
    )
}

fn rollback_pre_dispatch_after_error(
    resources: &PreDispatchResources,
    inputs: &LiveDogfoodInputs,
    error: String,
) -> String {
    match rollback_pre_dispatch(resources, inputs) {
        Ok(()) => format!(
            "{error}; pre-dispatch rollback completed for synthetic issue #{}",
            resources.issue_number
        ),
        Err(rollback_error) => format!(
            "{error}; pre-dispatch rollback for synthetic issue #{} failed: {rollback_error}",
            resources.issue_number
        ),
    }
}

fn start_live_pre_dispatch_host<H>(
    resources: &PreDispatchResources,
    reserve_port: impl FnOnce() -> Result<u16, String>,
    spawn_host: impl FnOnce(u16) -> Result<H, String>,
    rollback_after_error: impl FnOnce(&PreDispatchResources, String) -> String,
) -> Result<(u16, H), String> {
    match reserve_port() {
        Err(error) => Err(rollback_after_error(resources, error)),
        Ok(port) => match spawn_host(port) {
            Ok(host) => Ok((port, host)),
            Err(error) => Err(rollback_after_error(resources, error)),
        },
    }
}

fn create_live_resources(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    project: &LiveDogfoodProject,
) -> Result<PreDispatchResources, String> {
    let artifact = run.expected_artifact();
    let issue = live_gh(
        "create synthetic issue",
        [
            "api".to_string(),
            "--method".to_string(),
            "POST".to_string(),
            "repos/chrisbanes/bamboon/issues".to_string(),
            "-f".to_string(),
            format!("title=Ensemble live dogfood {}", run.marker),
            "-f".to_string(),
            format!(
                "body=Create exactly `{}` with exactly this content:\n\n```text\n{}\n```\n\nCommit with `{}`. Run a lightweight verification. Do not push or create a pull request.\n\nMarker: `{}`",
                artifact.path.display(), artifact.content, artifact.commit_message, run.marker
            ),
        ],
        inputs,
    )?;
    let issue: Value = serde_json::from_str(&issue)
        .map_err(|error| format!("create synthetic issue: invalid response: {error}"))?;
    let issue_id = issue["node_id"]
        .as_str()
        .ok_or_else(|| "create synthetic issue: missing node ID".to_string())?
        .to_string();
    let issue_number = issue["number"]
        .as_u64()
        .ok_or_else(|| "create synthetic issue: missing number".to_string())?;

    const ADD_ITEM: &str = r#"mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
}"#;
    let add_item = live_graphql_mutation(
        "add synthetic issue to Project",
        ADD_ITEM,
        [
            ("projectId".to_string(), project.id.clone()),
            ("contentId".to_string(), issue_id.clone()),
        ],
        inputs,
    );
    let project_item_id = match add_item {
        Ok(value) => match value["data"]["addProjectV2ItemById"]["item"]["id"].as_str() {
            Some(id) => id.to_string(),
            None => {
                return Err(format!(
                    "add synthetic issue to Project: missing Project item ID; synthetic issue #{issue_number} is retained because Project-item ownership is ambiguous"
                ));
            }
        },
        Err(error) => {
            return Err(format!(
                "{error}; synthetic issue #{issue_number} is retained because Project-item creation is ambiguous"
            ));
        }
    };
    let resources = PreDispatchResources {
        issue_id,
        issue_number,
        project_id: project.id.clone(),
        project_item_id,
    };

    if let Err(error) = set_live_project_item_status(
        "make synthetic issue ready",
        inputs,
        &project.id,
        &resources.project_item_id,
        &project.status_field_id,
        &project.ready_option_id,
    ) {
        return Err(rollback_pre_dispatch_after_error(&resources, inputs, error));
    }
    Ok(resources)
}

async fn capture_live_recovery_observation(
    client: &reqwest::Client,
    base_url: &str,
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    issue_number: u64,
    worktree: &Path,
    branch: &str,
    local_sha: &str,
    expected_pull_request_number: u64,
    expected_pull_request_url: &str,
) -> Result<LiveDogfoodRecoveryObservation, String> {
    let issue_identifier = format!("chrisbanes/bamboon#{issue_number}");
    let detail = client
        .get(format!(
            "{base_url}/api/v1/chrisbanes%2Fbamboon%23{issue_number}"
        ))
        .send()
        .await
        .map_err(|error| format!("verify restart public detail: request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("verify restart public detail: request failed: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("verify restart public detail: invalid response: {error}"))?;
    let (review_target, review_projection) = verify_live_review_detail(
        &detail,
        &issue_identifier,
        expected_pull_request_number,
        expected_pull_request_url,
    )?;

    let history = client
        .get(format!(
            "{base_url}/api/v1/history?outcome=in_review&step=implement"
        ))
        .send()
        .await
        .map_err(|error| format!("verify restart public history: request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("verify restart public history: request failed: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("verify restart public history: invalid response: {error}"))?;
    let history_count = history["records"]
        .as_array()
        .ok_or_else(|| "verify restart public history: records were unavailable".to_string())?
        .iter()
        .filter(|record| record["issue_identifier"] == issue_identifier)
        .count();
    if history_count != 1 {
        return Err("verify restart public history: retained run count changed".to_string());
    }

    let state = client
        .get(format!("{base_url}/api/v1/state"))
        .send()
        .await
        .map_err(|error| format!("verify restart public state: request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("verify restart public state: request failed: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("verify restart public state: invalid response: {error}"))?;
    let active_agents = validate_live_public_agent_capacity(&state)?;
    let (pull_request_number, pull_request_url) =
        verify_live_post_delivery(inputs, worktree, branch, local_sha)?;
    if pull_request_number != expected_pull_request_number
        || pull_request_url != expected_pull_request_url
    {
        return Err("verify restart delivery: pull-request identity changed".to_string());
    }
    let (
        worktree_identity,
        worktree_count,
        transcript_identity,
        transcript_count,
        transcript_bytes,
    ) = inspect_live_dogfood_persisted_artifacts(run, worktree)?;

    Ok(LiveDogfoodRecoveryObservation {
        issue_identifier,
        run_identifier: run.marker.clone(),
        workspace_identifier: format!("run/{}", run.marker),
        branch: branch.to_string(),
        local_sha: local_sha.to_string(),
        remote_sha: local_sha.to_string(),
        pull_request_number,
        pull_request_url,
        review_target,
        review_projection,
        transcript_identity,
        transcript_count,
        transcript_bytes,
        worktree_identity,
        worktree_count,
        active_agents,
    })
}

fn validate_live_public_agent_capacity(state: &Value) -> Result<usize, String> {
    let active_agents = state["counts"]["running"].as_u64().ok_or_else(|| {
        "verify restart public state: running capacity was unavailable".to_string()
    })? as usize;
    let running = state["running"]
        .as_array()
        .ok_or_else(|| "verify restart public state: running rows were unavailable".to_string())?;
    if running.len() != active_agents {
        return Err("verify restart public state: running capacity was inconsistent".to_string());
    }
    if !running.is_empty() {
        return Err("verify restart public state: public agent capacity was consumed".to_string());
    }
    Ok(active_agents)
}

fn inspect_live_dogfood_persisted_artifacts(
    run: &LiveDogfoodRun,
    worktree: &Path,
) -> Result<(String, usize, String, usize, u64), String> {
    let workspaces = run.root.join("workspaces");
    let discovered_worktree = live_dogfood_worktree(&workspaces)?;
    if discovered_worktree != worktree {
        return Err("verify restart persisted worktree: retained identity changed".to_string());
    }
    let worktree_identity = discovered_worktree
        .strip_prefix(&workspaces)
        .map_err(|_| "verify restart persisted worktree: identity was outside the run".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let runs = fs::read_dir(discovered_worktree.join(".ensemble").join("runs")).map_err(|_| {
        "verify restart persisted transcript: retained run was unavailable".to_string()
    })?;
    let transcript_paths = runs
        .map(|entry| {
            entry
                .map(|entry| {
                    entry
                        .path()
                        .join("steps")
                        .join("implement")
                        .join("transcript.jsonl")
                })
                .map_err(|_| {
                    "verify restart persisted transcript: run entry was unavailable".to_string()
                })
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    let [transcript] = transcript_paths.as_slice() else {
        return Err("verify restart persisted transcript: transcript count changed".to_string());
    };
    let transcript_identity = transcript
        .strip_prefix(&workspaces)
        .map_err(|_| {
            "verify restart persisted transcript: identity was outside the run".to_string()
        })?
        .to_string_lossy()
        .replace('\\', "/");
    let transcript_bytes = fs::metadata(transcript)
        .map_err(|_| "verify restart persisted transcript: metadata was unavailable".to_string())?
        .len();
    Ok((
        worktree_identity,
        1,
        transcript_identity,
        1,
        transcript_bytes,
    ))
}

async fn verify_live_restart_stability(
    client: &reqwest::Client,
    base_url: &str,
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    issue_number: u64,
    worktree: &Path,
    branch: &str,
    local_sha: &str,
    pull_request_number: u64,
    pull_request_url: &str,
    baseline: &LiveDogfoodRecoveryObservation,
) -> Result<(), String> {
    wait_for_server(client, base_url)
        .await
        .map_err(|error| format!("wait for restarted host: {error}"))?;
    for _ in 0..LIVE_DOGFOOD_RESTART_STABLE_POLLS {
        tokio::time::sleep(Duration::from_millis(LIVE_DOGFOOD_POLL_INTERVAL_MS)).await;
        let recovered = capture_live_recovery_observation(
            client,
            base_url,
            inputs,
            run,
            issue_number,
            worktree,
            branch,
            local_sha,
            pull_request_number,
            pull_request_url,
        )
        .await?;
        baseline.matches_recovery(&recovered)?;
    }
    Ok(())
}

fn spawn_live_host(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    token: &str,
    port: u16,
    lifetime: LiveDogfoodHostLifetime,
) -> Result<Child, String> {
    let config_path = run.root.join("config.yaml");
    let config = live_dogfood_config(inputs, run);
    match lifetime {
        LiveDogfoodHostLifetime::First => fs::write(&config_path, config).map_err(|error| {
            format!("start first host: could not write generated config: {error}")
        })?,
        LiveDogfoodHostLifetime::Second => {
            verify_retained_live_dogfood_config(&config_path, &config)?
        }
    }
    let (stdout_name, stderr_name) = lifetime.log_names();
    let stdout = fs::File::create(run.root.join(stdout_name))
        .map_err(|error| format!("start host: could not create stdout log: {error}"))?;
    let stderr = fs::File::create(run.root.join(stderr_name))
        .map_err(|error| format!("start host: could not create stderr log: {error}"))?;
    Command::new(env!("CARGO_BIN_EXE_ensemble"))
        .arg("web")
        .arg("--config-dir")
        .arg(&run.root)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("GITHUB_TOKEN", token)
        .env("ENSEMBLE_LOG", "info")
        .env("ENSEMBLE_LOG_FORMAT", "json")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("start host: could not spawn ensemble web: {error}"))
}

fn verify_retained_live_dogfood_config(config_path: &Path, expected: &str) -> Result<(), String> {
    let existing = fs::read(config_path).map_err(|error| {
        format!("start second host: could not read retained generated config: {error}")
    })?;
    if existing != expected.as_bytes() {
        return Err("start second host: retained generated config changed".to_string());
    }
    Ok(())
}

async fn wait_for_live_project_status(
    inputs: &LiveDogfoodInputs,
    issue_id: &str,
    target: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let last_observation = match live_project_item_status(inputs, issue_id) {
            Ok(Some(status)) if status == target => return Ok(()),
            Ok(status) => format!(
                "observed status {}",
                status.unwrap_or_else(|| "missing".to_string())
            ),
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "wait for Project status {target}: timed out; last observation: {}",
                redact_live_dogfood(&last_observation, inputs, None)
            ));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn wait_for_live_review_projection(
    client: &reqwest::Client,
    base_url: &str,
    issue_number: u64,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    let url = format!("{base_url}/api/v1/chrisbanes%2Fbamboon%23{issue_number}");
    loop {
        let last_observation = match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                let detail = response
                    .json::<Value>()
                    .await
                    .map_err(|error| error.to_string())?;
                if detail["artifacts"]["repos"]
                    .as_array()
                    .is_some_and(|repositories| {
                        repositories.iter().any(|repository| {
                            repository["review_state"] == "In review"
                                && repository["review_projection"] == "applied"
                                && repository["pr_number"].as_u64().is_some()
                                && repository["pr_url"]
                                    .as_str()
                                    .is_some_and(|url| !url.is_empty())
                        })
                    })
                {
                    return Ok(detail);
                }
                detail["status"].as_str().unwrap_or("unknown").to_string()
            }
            Ok(response) => format!("issue detail returned {}", response.status()),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "wait for review-projected host state: timed out; last observation: {}",
                last_observation
            ));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn wait_for_live_history(
    client: &reqwest::Client,
    base_url: &str,
    issue_number: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let identifier = format!("chrisbanes/bamboon#{issue_number}");
    loop {
        let response = client
            .get(format!(
                "{base_url}/api/v1/history?outcome=in_review&step=implement"
            ))
            .send()
            .await
            .map_err(|error| format!("wait for public history: {error}"))?;
        let history = response
            .json::<Value>()
            .await
            .map_err(|error| format!("wait for public history: invalid response: {error}"))?;
        if history["records"].as_array().is_some_and(|records| {
            records
                .iter()
                .any(|record| record["issue_identifier"] == identifier)
        }) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "wait for public history: timed out; last observation: {history}"
            ));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn verify_live_review_detail(
    detail: &Value,
    expected_issue_identifier: &str,
    pull_request_number: u64,
    pull_request_url: &str,
) -> Result<(String, String), String> {
    if detail["issue_identifier"] != expected_issue_identifier {
        return Err("verify public host detail: host reported an unexpected issue".to_string());
    }
    let matching_repositories = detail["artifacts"]["repos"]
        .as_array()
        .ok_or_else(|| "verify public host detail: review observation was unavailable".to_string())?
        .iter()
        .filter(|repository| {
            repository["review_state"] == "In review"
                && repository["review_projection"] == "applied"
                && repository["pr_number"].as_u64() == Some(pull_request_number)
                && repository["pr_url"].as_str() == Some(pull_request_url)
        })
        .collect::<Vec<_>>();
    let [repository] = matching_repositories.as_slice() else {
        return Err("verify public host detail: pull request did not agree".to_string());
    };
    Ok((
        repository["review_state"]
            .as_str()
            .ok_or_else(|| "verify public host detail: review target was unavailable".to_string())?
            .to_string(),
        repository["review_projection"]
            .as_str()
            .ok_or_else(|| {
                "verify public host detail: review projection was unavailable".to_string()
            })?
            .to_string(),
    ))
}

fn verify_live_local_artifact(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
) -> Result<(PathBuf, String, String), String> {
    let artifact = run.expected_artifact();
    let worktree = live_dogfood_worktree(&run.root.join("workspaces"))?;
    let actual_content = fs::read_to_string(worktree.join(&artifact.path))
        .map_err(|error| format!("verify local commit: expected artifact was absent: {error}"))?;
    if actual_content != artifact.content {
        return Err("verify local commit: expected artifact content did not match".to_string());
    }
    let status = live_git(
        "verify local worktree cleanliness",
        &worktree,
        ["status".to_string(), "--porcelain".to_string()],
        inputs,
    )?;
    if !status.is_empty() {
        return Err(
            "verify local worktree cleanliness: worktree had uncommitted changes".to_string(),
        );
    }
    let branch = live_git(
        "verify generated branch",
        &worktree,
        ["branch".to_string(), "--show-current".to_string()],
        inputs,
    )?
    .trim()
    .to_string();
    if !branch.starts_with("ensemble-") {
        return Err("verify generated branch: branch was not Ensemble-generated".to_string());
    }
    let diff = live_git(
        "verify expected-only diff",
        &worktree,
        [
            "diff".to_string(),
            "--name-only".to_string(),
            "main...HEAD".to_string(),
        ],
        inputs,
    )?;
    if diff.lines().collect::<Vec<_>>() != [artifact.path.to_string_lossy()] {
        return Err("verify expected-only diff: commit changed an unexpected path".to_string());
    }
    let commit = live_git(
        "verify committed artifact",
        &worktree,
        [
            "log".to_string(),
            "-1".to_string(),
            "--format=%H%x00%s".to_string(),
        ],
        inputs,
    )?;
    let (sha, message) = commit
        .trim_end()
        .split_once('\0')
        .ok_or_else(|| "verify committed artifact: Git did not report a commit".to_string())?;
    if message != artifact.commit_message {
        return Err("verify committed artifact: commit message did not match".to_string());
    }
    Ok((worktree, branch, sha.to_string()))
}

fn verify_live_post_delivery(
    inputs: &LiveDogfoodInputs,
    worktree: &Path,
    branch: &str,
    sha: &str,
) -> Result<(u64, String), String> {
    let remote_branch = live_git(
        "verify published remote branch",
        worktree,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            "origin".to_string(),
        ],
        inputs,
    )?;
    let expected_ref = format!("refs/heads/{branch}");
    let matching_remote_heads: Vec<_> = remote_branch
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter(|(_, reference)| *reference == expected_ref)
        .collect();
    if matching_remote_heads.len() != 1 || matching_remote_heads[0].0 != sha {
        return Err(
            "verify published remote branch: expected exactly one branch at the local commit"
                .to_string(),
        );
    }
    let branch_pull_requests = live_gh(
        "verify published pull request for generated branch",
        [
            "pr".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            "chrisbanes/bamboon".to_string(),
            "--state".to_string(),
            "open".to_string(),
            "--head".to_string(),
            branch.to_string(),
            "--json".to_string(),
            "number,url,headRefOid,baseRefName".to_string(),
        ],
        inputs,
    )?;
    let pull_requests: Vec<Value> =
        serde_json::from_str(&branch_pull_requests).map_err(|error| {
            format!("verify published pull request: invalid GitHub response: {error}")
        })?;
    let [pull_request] = pull_requests.as_slice() else {
        return Err(
            "verify published pull request: expected exactly one open pull request".to_string(),
        );
    };
    if pull_request["headRefOid"] != sha
        || pull_request["baseRefName"] != "main"
        || pull_request["number"].as_u64().is_none()
        || pull_request["url"].as_str().is_none_or(str::is_empty)
    {
        return Err(
            "verify published pull request: branch, base, commit, or identity did not match"
                .to_string(),
        );
    }
    Ok((
        pull_request["number"]
            .as_u64()
            .expect("verified pull request number"),
        pull_request["url"]
            .as_str()
            .expect("verified pull request URL")
            .to_string(),
    ))
}

fn verify_no_live_dogfood_publication(
    inputs: &LiveDogfoodInputs,
    worktree: &Path,
    branch: &str,
) -> Result<(), String> {
    let remote_heads = live_git(
        "verify pre-publication remote branch",
        worktree,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            "origin".to_string(),
            format!("refs/heads/{branch}"),
        ],
        inputs,
    )?;
    let pull_requests = live_gh(
        "verify pre-publication pull request",
        [
            "pr".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            "chrisbanes/bamboon".to_string(),
            "--state".to_string(),
            "open".to_string(),
            "--head".to_string(),
            branch.to_string(),
            "--json".to_string(),
            "number,url".to_string(),
        ],
        inputs,
    )?;
    ensure_no_live_dogfood_publication(&remote_heads, &pull_requests)
}

async fn wait_for_live_pre_publication(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
) -> Result<(PathBuf, String, String), String> {
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    loop {
        match verify_live_local_artifact(inputs, run) {
            Ok((worktree, branch, sha)) => {
                verify_no_live_dogfood_publication(inputs, &worktree, &branch)?;
                return Ok((worktree, branch, sha));
            }
            Err(error) if Instant::now() >= deadline => {
                return Err(format!(
                    "wait for pre-publication local artifact: timed out; last observation: {}",
                    redact_live_dogfood(&error, inputs, None)
                ));
            }
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

fn live_dogfood_worktree(workspaces: &Path) -> Result<PathBuf, String> {
    let workspace_entries = fs::read_dir(workspaces)
        .map_err(|error| format!("verify local commit: workspace root was unavailable: {error}"))?;
    let mut worktrees = Vec::new();
    for entry in workspace_entries {
        let entry = entry.map_err(|error| {
            format!("verify local commit: workspace entry was unavailable: {error}")
        })?;
        let repo_root = entry.path().join("bamboon");
        let repo_entries = match fs::read_dir(&repo_root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in repo_entries {
            let entry = entry.map_err(|error| {
                format!("verify local commit: worktree entry was unavailable: {error}")
            })?;
            let path = entry.path();
            if path.is_dir() {
                worktrees.push(path);
            }
        }
    }
    match worktrees.as_slice() {
        [worktree] => Ok(worktree.clone()),
        [] => Err("verify local commit: no Bamboon issue worktree was found".to_string()),
        _ => Err("verify local commit: multiple Bamboon issue worktrees were found".to_string()),
    }
}

fn marker_owned_remote_branch(remote_heads: &str, marker: &str) -> bool {
    remote_heads.lines().any(|line| line.contains(marker))
}

fn remote_branch_contains(remote_heads: &str, branch: &str) -> bool {
    remote_heads.lines().any(|line| {
        line == format!("refs/heads/{branch}") || line.ends_with(&format!("\trefs/heads/{branch}"))
    })
}

fn marker_owned_pull_request(pull_requests: &str, marker: &str) -> Result<bool, String> {
    let pull_requests: Vec<Value> = serde_json::from_str(pull_requests)
        .map_err(|error| format!("verify no pull request: invalid GitHub response: {error}"))?;
    Ok(pull_requests.iter().any(|pull_request| {
        ["title", "headRefName"]
            .iter()
            .filter_map(|field| pull_request[*field].as_str())
            .any(|value| value.contains(marker))
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the explicitly provisioned private dogfood Project, clean Bamboon clone, ACPX, and model/network cost"]
async fn live_bamboon_issue_publishes_pull_request() {
    let inputs = LiveDogfoodInputs::from_env().expect("live dogfood inputs");
    let run = LiveDogfoodRun::create().expect("persistent live dogfood run directory");
    let result = async {
        let (token, project) = live_preflight(&inputs, &run)?;
        let resources = create_live_resources(&inputs, &run, &project)?;
        if let Err(error) =
            wait_for_live_project_status(&inputs, &resources.issue_id, "Ready to implement").await
        {
            return Err(rollback_pre_dispatch_after_error(
                &resources, &inputs, error,
            ));
        }
        let (port, mut host) = start_live_pre_dispatch_host(
            &resources,
            || reserve_local_port().map_err(|error| format!("reserve host port: {error}")),
            |port| spawn_live_host(&inputs, &run, &token, port, LiveDogfoodHostLifetime::First),
            |resources, error| rollback_pre_dispatch_after_error(resources, &inputs, error),
        )?;
        let resources = LiveDogfoodResources {
            issue_id: resources.issue_id,
            issue_number: resources.issue_number,
            project,
            project_item_id: resources.project_item_id,
        };
        let mut evidence = LiveDogfoodEvidenceV1::new(
            &run,
            format!("chrisbanes/bamboon#{}", resources.issue_number),
            inputs.mode,
        );
        let mut pre_publication_captured = false;
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");
        let completed = async {
            wait_for_server(&client, &base_url)
                .await
                .map_err(|error| format!("wait for host: {error}"))?;
            wait_for_live_project_status(&inputs, &resources.issue_id, "In progress").await?;
            let (worktree, branch, sha) = wait_for_live_pre_publication(&inputs, &run).await?;
            evidence.append_pre_publication(
                run.expected_artifact().path.to_string_lossy(),
                &branch,
                &sha,
            )?;
            write_live_dogfood_evidence_v1(&run.root, &evidence)?;
            pre_publication_captured = true;
            let detail =
                wait_for_live_review_projection(&client, &base_url, resources.issue_number).await?;
            wait_for_live_project_status(&inputs, &resources.issue_id, "In review").await?;
            wait_for_live_history(&client, &base_url, resources.issue_number).await?;
            let (pull_request_number, pull_request_url) =
                verify_live_post_delivery(&inputs, &worktree, &branch, &sha)?;
            let (review_target, review_projection) = verify_live_review_detail(
                &detail,
                &format!("chrisbanes/bamboon#{}", resources.issue_number),
                pull_request_number,
                &pull_request_url,
            )?;
            evidence.append_post_delivery(
                &branch,
                &sha,
                pull_request_number,
                &pull_request_url,
                "In review",
                review_target,
                review_projection,
            )?;
            write_live_dogfood_evidence_v1(&run.root, &evidence)?;
            let baseline = capture_live_recovery_observation(
                &client,
                &base_url,
                &inputs,
                &run,
                resources.issue_number,
                &worktree,
                &branch,
                &sha,
                pull_request_number,
                &pull_request_url,
            )
            .await?;
            Ok::<_, String>((
                worktree,
                branch,
                sha,
                pull_request_number,
                pull_request_url,
                baseline,
            ))
        }
        .await;
        let first_host_stopped = stop_and_reap_live_host(&mut host);
        let (worktree, branch, sha, pull_request_number, pull_request_url, baseline) =
            match completed {
                Ok(completed) => {
                    if let Err(error) = first_host_stopped {
                        evidence.preserve_discovered_artifacts();
                        evidence.final_state.absent.clear();
                        evidence.final_state.retained.push("active_child");
                        let failure = persist_live_dogfood_failure(
                            &mut evidence,
                            &run,
                            &inputs,
                            pre_publication_captured,
                            &error,
                        );
                        return Err(failure.err().unwrap_or(error));
                    }
                    completed
                }
                Err(mut error) => {
                    if let Err(reap_error) = first_host_stopped {
                        evidence.preserve_discovered_artifacts();
                        evidence.final_state.absent.clear();
                        evidence.final_state.retained.push("active_child");
                        error = format!("{error}; {reap_error}");
                    }
                    let failure = persist_live_dogfood_failure(
                        &mut evidence,
                        &run,
                        &inputs,
                        pre_publication_captured,
                        &error,
                    );
                    return Err(failure.err().unwrap_or(error));
                }
            };
        if evidence.snapshots.len() != 2 || !evidence.has_post_delivery() {
            return Err("verify evidence-v1: post-delivery snapshot was not retained".to_string());
        }
        let restart_port = match reserve_local_port() {
            Ok(port) => port,
            Err(error) => {
                let error = format!("reserve restarted host port: {error}");
                let failure = persist_live_dogfood_failure(
                    &mut evidence,
                    &run,
                    &inputs,
                    pre_publication_captured,
                    &error,
                );
                return Err(failure.err().unwrap_or(error));
            }
        };
        let mut restarted_host = match spawn_live_host(
            &inputs,
            &run,
            &token,
            restart_port,
            LiveDogfoodHostLifetime::Second,
        ) {
            Ok(host) => host,
            Err(error) => {
                let failure = persist_live_dogfood_failure(
                    &mut evidence,
                    &run,
                    &inputs,
                    pre_publication_captured,
                    &error,
                );
                return Err(failure.err().unwrap_or(error));
            }
        };
        let restart_base_url = format!("http://127.0.0.1:{restart_port}");
        let restarted = verify_live_restart_stability(
            &client,
            &restart_base_url,
            &inputs,
            &run,
            resources.issue_number,
            &worktree,
            &branch,
            &sha,
            pull_request_number,
            &pull_request_url,
            &baseline,
        )
        .await;
        if let Err(error) = restarted {
            return Err(finalize_live_restarted_run_failure(
                &mut restarted_host,
                &mut evidence,
                &run,
                &inputs,
                pre_publication_captured,
                error,
            ));
        }
        let post_restart_evidence = (|| {
            evidence.append_post_restart(&baseline)?;
            write_live_dogfood_evidence_v1(&run.root, &evidence)?;
            if evidence.snapshots.len() != 3 {
                return Err(
                    "verify evidence-v1: post-restart snapshot was not retained".to_string()
                );
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = post_restart_evidence {
            return Err(finalize_live_restarted_run_failure(
                &mut restarted_host,
                &mut evidence,
                &run,
                &inputs,
                pre_publication_captured,
                error,
            ));
        }
        match inputs.mode {
            LiveDogfoodMode::Preserve => {
                if let Err(error) =
                    run_live_preserve_completion(&mut restarted_host, &mut evidence, &run)
                {
                    return Err(finalize_live_restarted_run_failure(
                        &mut restarted_host,
                        &mut evidence,
                        &run,
                        &inputs,
                        pre_publication_captured,
                        error,
                    ));
                }
            }
            LiveDogfoodMode::Routine => {
                if let Err(error) = run_live_routine_cleanup(
                    &client,
                    &restart_base_url,
                    &inputs,
                    &run,
                    &resources,
                    &mut restarted_host,
                    &worktree,
                    &branch,
                    &sha,
                    pull_request_number,
                    &mut evidence,
                )
                .await
                {
                    return Err(finalize_live_restarted_run_failure(
                        &mut restarted_host,
                        &mut evidence,
                        &run,
                        &inputs,
                        pre_publication_captured,
                        error,
                    ));
                }
            }
        }
        Ok((resources, branch, sha, inputs.mode))
    }
    .await;

    match result {
        Ok((resources, branch, sha, mode)) => eprintln!(
            "live dogfood completed mode={mode:?} marker={} issue={} branch={} sha={} run_directory={}",
            run.marker,
            resources.issue_number,
            branch,
            sha,
            run.root.display()
        ),
        Err(error) => panic!(
            "{error}\nlive dogfood artifacts are preserved: marker={} run_directory={}\ndeliberate cleanup procedure: inspect run_directory and evidence-v1.json when present, then follow docs/contributing.md#ignored-live-dogfood-tracer-bullet; revalidate every stored identity before mutation",
            run.marker,
            run.root.display()
        ),
    }
}

#[test]
fn live_dogfood_inputs_require_the_exact_opt_in() {
    let error = LiveDogfoodInputs::from_values(None, None, None, None).unwrap_err();
    assert_eq!(error, "ENSEMBLE_LIVE_DOGFOOD must be exactly 1");
}

#[test]
fn live_dogfood_inputs_require_safe_fixture_values() {
    assert!(
        LiveDogfoodInputs::from_values(Some("1"), Some("0"), Some("/tmp/bamboon"), None)
            .unwrap_err()
            .contains(LIVE_DOGFOOD_PROJECT)
    );
    assert!(
        LiveDogfoodInputs::from_values(Some("1"), Some("+12"), Some("/tmp/bamboon"), None)
            .unwrap_err()
            .contains(LIVE_DOGFOOD_PROJECT)
    );
    assert!(
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), Some("relative"), None)
            .unwrap_err()
            .contains(LIVE_DOGFOOD_BAMBOON_PATH)
    );

    let inputs = LiveDogfoodInputs::from_values(
        Some("1"),
        Some("12"),
        Some("/tmp/bamboon"),
        Some("named-agent"),
    )
    .unwrap();
    assert_eq!(inputs.agent, "named-agent");
}

#[test]
fn live_dogfood_marker_artifact_and_config_are_run_scoped() {
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), Some("/tmp/bamboon"), None).unwrap();
    let run = LiveDogfoodRun {
        marker: live_dogfood_marker(42, 7, 1),
        root: PathBuf::from("/tmp/ensemble-live-dogfood/live-dogfood-2a-7-1"),
    };
    let artifact = run.expected_artifact();
    let config = live_dogfood_config(&inputs, &run);

    assert_eq!(
        artifact.path,
        PathBuf::from("docs/ensemble-dogfood/live-dogfood-2a-7-1.md")
    );
    assert!(artifact.content.contains(&run.marker));
    assert!(config.contains("project_number: 12"));
    assert!(config.contains("acpx_agent: 'codex'"));
    assert!(config.contains("tracker_state: In progress"));
    assert!(config.contains("    - In progress"));
    assert!(config.contains("on_success: Done"));
    assert!(config.contains("max_cycles: 1"));
    assert!(config.contains("max_concurrent_agents: 1"));
    assert!(config.contains("max_step_parallelism: 1"));
    assert!(config.contains("mode: push_and_pr"));
    assert!(config.contains("approval_required: false"));
    assert!(config.contains("review_state: In review"));
    assert!(!config.contains("api_key:"));
}

#[test]
fn live_dogfood_redaction_hides_private_inputs_and_tokens() {
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), Some("/tmp/private-bamboon"), None)
            .unwrap();
    let redacted = redact_live_dogfood(
        "project 12 clone /tmp/private-bamboon token secret-token",
        &inputs,
        Some("secret-token"),
    );
    assert_eq!(
        redacted,
        "project [REDACTED] clone [REDACTED] token [REDACTED]"
    );
}

#[test]
fn live_dogfood_evidence_v1_schema_and_redaction_are_stable() {
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), Some("/tmp/private-bamboon"), None)
            .unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-evidence".to_string(),
        root: PathBuf::from("/tmp/private-run-root"),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#34", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-evidence.md",
            "ensemble-live-dogfood-evidence",
            "local-sha",
        )
        .unwrap();
    evidence
        .append_preserved_failure(
            "verify public host detail",
            ["post_delivery"],
            &inputs,
            Some("secret-token"),
        )
        .unwrap();

    let serialized = serde_json::to_string_pretty(&evidence).unwrap();
    let json: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(json["format"], "ensemble.live-dogfood-evidence");
    assert_eq!(json["schema_version"], 1);
    assert_eq!(json["outcome"], "preserved_failure");
    assert_eq!(json["snapshots"][0]["kind"], "pre_publication");
    assert_eq!(json["snapshots"][1]["kind"], "preserved_failure");
    for prohibited in [
        "12",
        "secret-token",
        "/tmp/private-bamboon",
        "/tmp/private-run-root",
        "tracker:\n  project_number: 12",
        "raw command output",
    ] {
        assert!(
            !serialized.contains(prohibited),
            "serialized evidence must redact {prohibited}"
        );
    }
}

#[test]
fn live_dogfood_evidence_v1_atomic_write_replaces_only_complete_documents() {
    let temporary = tempfile::tempdir().unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-atomic".to_string(),
        root: temporary.path().to_path_buf(),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#35", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-atomic.md",
            "ensemble-live-dogfood-atomic",
            "local-sha",
        )
        .unwrap();
    fs::write(run.root.join("evidence-v1.json"), "{\"previous\":true}").unwrap();

    write_live_dogfood_evidence_v1(&run.root, &evidence).unwrap();

    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(run.root.join("evidence-v1.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["format"], "ensemble.live-dogfood-evidence");
    assert_eq!(persisted["snapshots"][0]["kind"], "pre_publication");
    assert!(
        fs::read_dir(&run.root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")),
        "successful atomic replacement must not leave a temporary evidence file"
    );
}

#[test]
fn live_dogfood_evidence_v1_failed_replacement_retains_prior_document() {
    let temporary = tempfile::tempdir().unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-retention".to_string(),
        root: temporary.path().to_path_buf(),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#36", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-retention.md",
            "ensemble-live-dogfood-retention",
            "local-sha",
        )
        .unwrap();
    let target = run.root.join("evidence-v1.json");
    fs::write(&target, "{\"previous\":true}").unwrap();

    let error = write_live_dogfood_evidence_v1_with_replace(&run.root, &evidence, |_from, _to| {
        Err(io::Error::other("injected replacement failure"))
    })
    .unwrap_err();

    assert_eq!(error, "evidence-v1: atomic replacement failed");
    assert_eq!(fs::read_to_string(target).unwrap(), "{\"previous\":true}");
    assert!(
        fs::read_dir(&run.root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")),
        "failed replacement must retain its same-directory diagnostic"
    );
}

#[test]
fn live_dogfood_evidence_v1_snapshots_are_cumulative_and_ordered() {
    let run = LiveDogfoodRun {
        marker: "live-dogfood-order".to_string(),
        root: PathBuf::from("/tmp/run-root-not-serialized"),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#37", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-order.md",
            "ensemble-live-dogfood-order",
            "local-sha",
        )
        .unwrap();
    evidence
        .append_post_delivery(
            "ensemble-live-dogfood-order",
            "remote-sha",
            37,
            "https://github.com/chrisbanes/bamboon/pull/37",
            "In review",
            "In review",
            "applied",
        )
        .unwrap();

    let json = serde_json::to_value(&evidence).unwrap();
    assert_eq!(json["outcome"], "in_review");
    assert_eq!(json["snapshots"][0]["kind"], "pre_publication");
    assert_eq!(json["snapshots"][1]["kind"], "post_delivery");
    assert_eq!(json["snapshots"][1]["remote_sha"], "remote-sha");
    assert_eq!(json["snapshots"][1]["pull_request"]["number"], 37);
}

#[test]
fn live_dogfood_post_restart_evidence_is_ordered_and_redacted() {
    let run = LiveDogfoodRun {
        marker: "live-dogfood-restart-order".to_string(),
        root: PathBuf::from("/tmp/private-run-root"),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#39", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-restart-order.md",
            "ensemble-live-dogfood-restart-order",
            "local-sha",
        )
        .unwrap();
    assert!(evidence
        .append_post_restart(&LiveDogfoodRecoveryObservation::for_test())
        .is_err());
    evidence
        .append_post_delivery(
            "ensemble-live-dogfood-restart-order",
            "local-sha",
            39,
            "https://github.com/chrisbanes/bamboon/pull/39",
            "In review",
            "In review",
            "applied",
        )
        .unwrap();
    assert!(evidence
        .append_post_restart(&LiveDogfoodRecoveryObservation::for_test().with_branch("other"))
        .is_err());
    evidence
        .append_post_restart(&LiveDogfoodRecoveryObservation::for_test())
        .unwrap();

    let serialized = serde_json::to_string_pretty(&evidence).unwrap();
    let json: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(json["schema_version"], 1);
    assert_eq!(json["snapshots"][0]["kind"], "pre_publication");
    assert_eq!(json["snapshots"][1]["kind"], "post_delivery");
    assert_eq!(json["snapshots"][2]["kind"], "post_restart");
    for prohibited in [
        "12",
        "/tmp/private-bamboon",
        "/tmp/private-run-root",
        "secret-token",
    ] {
        assert!(
            !serialized.contains(prohibited),
            "serialized evidence must redact {prohibited}"
        );
    }
}

#[test]
fn live_dogfood_restart_observation_rejects_identity_or_redispatch_drift() {
    let baseline = LiveDogfoodRecoveryObservation::for_test();
    assert!(baseline.matches_recovery(&baseline).is_ok());

    for changed in [
        baseline
            .clone()
            .with_issue_identifier("chrisbanes/bamboon#40"),
        baseline.clone().with_run_identifier("other-run"),
        baseline
            .clone()
            .with_workspace_identifier("run/other-workspace"),
        baseline.clone().with_branch("ensemble-other"),
        baseline.clone().with_sha("other-sha"),
        baseline.clone().with_pull_request(40),
        baseline.clone().with_review_projection("missing"),
        baseline.clone().with_transcript_count(2),
        baseline.clone().with_transcript_bytes(456),
        baseline.clone().with_worktree_count(2),
        baseline.clone().with_active_agents(1),
    ] {
        assert!(baseline.matches_recovery(&changed).is_err());
    }
}

#[test]
fn live_dogfood_restart_reuses_config_and_separates_host_logs() {
    let temporary = tempfile::tempdir().unwrap();
    let config_path = temporary.path().join("config.yaml");
    fs::write(&config_path, "retained: config\n").unwrap();
    verify_retained_live_dogfood_config(&config_path, "retained: config\n").unwrap();
    assert!(verify_retained_live_dogfood_config(&config_path, "changed: config\n").is_err());
    assert_eq!(
        LiveDogfoodHostLifetime::all_log_names(),
        [
            "host-1.stdout.log",
            "host-1.stderr.log",
            "host-2.stdout.log",
            "host-2.stderr.log",
        ]
    );
    assert_eq!(LIVE_DOGFOOD_RESTART_STABLE_POLLS, 2);
}

#[test]
fn live_dogfood_restart_rejects_ambiguous_public_agent_capacity() {
    assert_eq!(
        validate_live_public_agent_capacity(&serde_json::json!({
            "counts": {"running": 0},
            "running": [],
        }))
        .unwrap(),
        0
    );
    for state in [
        serde_json::json!({"counts": {"running": 0}, "running": [{}]}),
        serde_json::json!({"counts": {"running": 1}, "running": []}),
    ] {
        assert!(validate_live_public_agent_capacity(&state).is_err());
    }
}

#[test]
fn live_dogfood_completed_history_snapshot_counts_as_released() {
    assert!(live_public_issue_released(&serde_json::json!({
        "running": null,
        "status": "completed_succeeded",
    })));
    assert!(!live_public_issue_released(&serde_json::json!({
        "running": {"step": "implement"},
        "status": "completed_succeeded",
    })));
    assert!(!live_public_issue_released(&serde_json::json!({
        "running": null,
        "status": "In review",
    })));
}

#[test]
fn live_dogfood_pre_publication_rejects_agent_publication() {
    assert!(ensure_no_live_dogfood_publication("", "[]").is_ok());
    assert!(ensure_no_live_dogfood_publication(
        "local-sha\trefs/heads/ensemble-live-dogfood-order",
        "[]"
    )
    .unwrap_err()
    .contains("remote branch"));
    assert!(ensure_no_live_dogfood_publication(
        "",
        r#"[{"number":37,"url":"https://github.com/chrisbanes/bamboon/pull/37"}]"#
    )
    .unwrap_err()
    .contains("pull request"));
}

#[test]
fn live_dogfood_failure_evidence_keeps_the_safe_failure_phase() {
    assert_eq!(
        live_dogfood_failure_observation(
            "wait for public history: timed out; last observation: raw command output"
        ),
        "wait for public history"
    );
    assert_eq!(
        live_dogfood_failure_observation("unrecognized raw command output"),
        "dispatch-and-later verification"
    );
}

#[test]
fn live_dogfood_pre_delivery_failure_conservatively_reports_remote_residue() {
    let run = LiveDogfoodRun {
        marker: "live-dogfood-pre-delivery-failure".to_string(),
        root: PathBuf::from("/tmp/ensemble-live-dogfood/live-dogfood-pre-delivery-failure"),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Routine);
    evidence
        .append_pre_publication(
            "docs/ensemble-dogfood/live-dogfood-pre-delivery-failure.md",
            "ensemble-live-dogfood-pre-delivery-failure",
            "local-sha",
        )
        .unwrap();

    evidence.preserve_discovered_artifacts();

    let retained = serde_json::to_value(evidence).unwrap()["final_state"]["retained"]
        .as_array()
        .unwrap()
        .clone();
    assert!(retained.contains(&serde_json::json!("generated_ref")));
    assert!(retained.contains(&serde_json::json!("pull_request")));
}

#[test]
fn live_dogfood_post_delivery_requires_matching_host_pull_request() {
    let detail = serde_json::json!({
        "issue_identifier": "chrisbanes/bamboon#38",
        "artifacts": {"repos": [{
            "review_state": "In review",
            "review_projection": "applied",
            "pr_number": 38,
            "pr_url": "https://github.com/chrisbanes/bamboon/pull/38"
        }]}
    });
    assert!(verify_live_review_detail(
        &detail,
        "chrisbanes/bamboon#38",
        38,
        "https://github.com/chrisbanes/bamboon/pull/38",
    )
    .is_ok());
    assert!(verify_live_review_detail(
        &detail,
        "chrisbanes/bamboon#38",
        39,
        "https://github.com/chrisbanes/bamboon/pull/39",
    )
    .unwrap_err()
    .contains("pull request"));
}

#[test]
fn live_dogfood_operator_contract_is_documented_without_fixture_values() {
    let contributing = include_str!("../../../docs/contributing.md");
    for required in [
        "ENSEMBLE_LIVE_DOGFOOD=1",
        "ENSEMBLE_DOGFOOD_PROJECT_NUMBER",
        "ENSEMBLE_DOGFOOD_BAMBOON_PATH",
        "ENSEMBLE_DOGFOOD_AGENT",
        "ENSEMBLE_LIVE_DOGFOOD_PRESERVE=1",
        "gh auth token",
        "Ensemble alone pushes",
        "`In review`",
        "never part of CI",
        "default routine mode",
        "network and model cost",
        "close the exact pull request",
        "while the second host remains running",
        "deliberate cleanup procedure",
        "revalidate each stored identity",
        "does not close the MVP release gate",
        "evidence-v1.json",
        "pre-publication",
        "post-delivery",
        "preserved failure",
        "relative log names",
        "post-restart",
        "host-1.stdout.log",
        "host-2.stderr.log",
        "two configured polling intervals",
        "unchanged config",
        "not exist before dispatch",
        "conservatively lists the generated ref",
        "pull request until fresh observations",
    ] {
        assert!(
            contributing.contains(required),
            "contributing guide must document {required}"
        );
    }
}

#[test]
fn live_dogfood_rejects_graphql_errors_before_dispatch() {
    let error = parse_live_graphql_response(
        "make synthetic issue ready",
        r#"{"errors":[{"message":"fixture drift"}]}"#,
    )
    .unwrap_err();

    assert_eq!(error, "make synthetic issue ready: GraphQL returned errors");
}

#[test]
fn live_dogfood_preflight_rejects_project_fixture_drift() {
    let response = serde_json::json!({
        "data": {"repository": {"projectV2": {
            "id": "project-id",
            "title": "Wrong Project",
            "viewerCanUpdate": true,
            "items": {"totalCount": 0},
            "workflows": {"nodes": []},
            "fields": {"nodes": [{
                "id": "status-id",
                "name": "Status",
                "options": [
                    {"id": "ready", "name": "Ready to implement"},
                    {"id": "progress", "name": "In progress"},
                    {"id": "review", "name": "In review"},
                    {"id": "done", "name": "Done"}
                ]
            }]}
        }}}
    });

    assert!(validate_live_project_response(&response)
        .unwrap_err()
        .contains("Project title or write access"));
}

#[test]
fn live_dogfood_publication_observations_are_marker_scoped() {
    let marker = "live-dogfood-2a-7-1";
    assert!(marker_owned_remote_branch(
        "deadbeef\trefs/heads/agent-live-dogfood-2a-7-1",
        marker
    ));
    assert!(remote_branch_contains(
        "deadbeef\trefs/heads/ensemble-20260805-e2e-1",
        "ensemble-20260805-e2e-1"
    ));
    assert!(marker_owned_pull_request(
        r#"[{"number":12,"title":"dogfood live-dogfood-2a-7-1","headRefName":"agent-branch"}]"#,
        marker,
    )
    .unwrap());
    assert!(!marker_owned_pull_request(
        r#"[{"number":12,"title":"unrelated","headRefName":"agent-branch"}]"#,
        marker,
    )
    .unwrap());
    assert!(marker_owned_pull_request("not JSON", marker).is_err());
}

#[test]
fn live_dogfood_command_timeouts_keep_a_safe_last_observation() {
    assert_eq!(
        live_command_timeout("preflight ACPX"),
        "preflight ACPX: command timed out after 30 seconds; last observation: command was still running"
    );
}

#[test]
fn live_dogfood_config_parses_with_multiline_artifact_content() {
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), Some("/tmp/bamboon"), None).unwrap();
    let run = LiveDogfoodRun {
        marker: live_dogfood_marker(42, 7, 1),
        root: PathBuf::from("/tmp/ensemble-live-dogfood/live-dogfood-2a-7-1"),
    };

    let raw_config = live_dogfood_config(&inputs, &run);
    let parsed = ensemble_core::config::ensemble::parse_config(&raw_config)
        .expect("live config must satisfy the runtime configuration contract");
    assert_eq!(
        parsed
            .tracker
            .github
            .as_ref()
            .map(|github| github.status_field.as_str()),
        Some("Status")
    );
    let config: serde_yaml::Value =
        serde_yaml::from_str(&raw_config).expect("live config must parse");
    let prompt = config["agents"]["builder"]["prompt"]
        .as_str()
        .expect("live prompt must be a scalar");
    assert!(prompt.contains("# Ensemble live dogfood\n\nMarker:"));
    assert_eq!(
        config["agents"]["builder"]["permission_mode"],
        "approve_reads"
    );
    assert_eq!(
        config["agent"]["permission_request_policy"]["mode"],
        "reject_all"
    );
}

#[test]
fn live_dogfood_worktree_discovery_includes_the_issue_key_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let workspaces = temporary.path().join("workspaces");
    let expected = workspaces
        .join("I_live_dogfood--expected-key")
        .join("bamboon")
        .join("ensemble-2026-08-05-I-live-dogfood");
    fs::create_dir_all(&expected).unwrap();

    assert_eq!(live_dogfood_worktree(&workspaces).unwrap(), expected);
}

#[cfg(unix)]
#[test]
fn live_dogfood_worktree_registration_canonicalizes_symlinked_prefixes() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let canonical_root = temporary.path().join("canonical");
    let canonical_worktree = canonical_root.join("run-root").join("issue-worktree");
    let aliased_root = temporary.path().join("alias");
    let aliased_worktree = aliased_root.join("run-root").join("issue-worktree");
    fs::create_dir_all(&canonical_worktree).unwrap();
    symlink(&canonical_root, &aliased_root).unwrap();
    let listing = format!("worktree {}\n", canonical_worktree.display());

    assert!(worktree_is_registered(&listing, &aliased_worktree));
    fs::remove_dir_all(canonical_root.join("run-root")).unwrap();
    assert!(worktree_is_registered(&listing, &aliased_worktree));
}

#[test]
fn live_dogfood_preserve_input_is_exact_and_defaults_to_routine_cleanup() {
    assert_eq!(
        LiveDogfoodMode::from_input(None).unwrap(),
        LiveDogfoodMode::Routine
    );
    assert_eq!(
        LiveDogfoodMode::from_input(Some("")).unwrap(),
        LiveDogfoodMode::Routine
    );
    assert_eq!(
        LiveDogfoodMode::from_input(Some("1")).unwrap(),
        LiveDogfoodMode::Preserve
    );
    assert!(LiveDogfoodMode::from_input(Some("true")).is_err());
}

#[cfg(unix)]
#[test]
fn live_dogfood_preserve_input_rejects_non_utf8_values() {
    use std::os::unix::ffi::OsStrExt;

    assert!(LiveDogfoodMode::from_os_input(Some(std::ffi::OsStr::from_bytes(&[0xff]))).is_err());
}

#[test]
fn live_dogfood_evidence_records_the_selected_cleanup_mode() {
    let run = LiveDogfoodRun {
        marker: "live-dogfood-mode".to_string(),
        root: PathBuf::from("/tmp/ensemble-live-dogfood/live-dogfood-mode"),
    };
    let evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Preserve);

    let value = serde_json::to_value(evidence).unwrap();
    assert_eq!(value["mode"], "preserve");
}

#[test]
fn live_dogfood_preserve_completion_only_reaps_and_records_preservation() {
    let temporary = tempfile::tempdir().unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-preserve-execution".to_string(),
        root: temporary.path().to_path_buf(),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Preserve);
    let mut child = Command::new("sh").args(["-c", "sleep 30"]).spawn().unwrap();

    run_live_preserve_completion(&mut child, &mut evidence, &run).unwrap();

    assert!(child.try_wait().unwrap().is_some());
    let value: Value = serde_json::from_str(
        &fs::read_to_string(temporary.path().join("evidence-v1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(value["outcome"], "preserved_certification");
    assert_eq!(
        value["transitions"],
        serde_json::json!([{"phase": "preserve_stop_and_reap_host", "result": "succeeded"}])
    );
    assert_eq!(
        value["final_state"]["absent"],
        serde_json::json!(["active_child"])
    );
}

#[test]
fn live_dogfood_partial_cleanup_evidence_distinguishes_absent_and_retained_state() {
    let run = LiveDogfoodRun {
        marker: "live-dogfood-partial".to_string(),
        root: PathBuf::from("/tmp/ensemble-live-dogfood/live-dogfood-partial"),
    };
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Routine);
    evidence.append_transition("close_pull_request", "succeeded");
    evidence.append_transition("project_done", "preserved_failure");
    evidence.preserve_after_transitions();

    let value = serde_json::to_value(evidence).unwrap();
    assert_eq!(value["outcome"], "preserved_failure");
    assert_eq!(
        value["final_state"]["absent"],
        serde_json::json!(["open_pull_request"])
    );
    assert!(value["final_state"]["retained"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("project_item")));
}

#[test]
fn live_dogfood_cleanup_plan_requires_exact_consistent_run_owned_identities() {
    let plan = LiveDogfoodCleanupPlan::for_test();
    assert!(plan.validate().is_ok());
    assert!(plan
        .clone()
        .with_pull_request_sha("other")
        .validate()
        .is_err());
    assert!(plan
        .clone()
        .with_pull_request_base("release")
        .validate()
        .is_err());
    assert!(plan.clone().with_issue_id("").validate().is_err());
    assert!(plan
        .clone()
        .with_worktree("/tmp/not-run-owned")
        .validate()
        .is_err());
}

#[test]
fn live_dogfood_pull_request_revalidation_requires_the_stored_identity() {
    let plan = LiveDogfoodCleanupPlan::for_test();
    let identity = LiveDogfoodPullRequestIdentity {
        id: plan.pull_request.id.clone(),
        number: plan.pull_request.number,
        url: plan.pull_request.url.clone(),
        state: "OPEN".to_string(),
        head: plan.branch.clone(),
        sha: plan.expected_sha.clone(),
        base: "main".to_string(),
    };

    assert!(identity.validate_against(&plan, "OPEN").is_ok());
    assert!(identity.validate_against(&plan, "CLOSED").is_err());
    assert!(LiveDogfoodPullRequestIdentity {
        sha: "replacement-sha".to_string(),
        ..identity
    }
    .validate_against(&plan, "OPEN")
    .is_err());
}

#[test]
fn live_dogfood_remote_ref_deletion_rejects_a_replacement_sha() {
    let temporary = tempfile::tempdir().unwrap();
    let remote = temporary.path().join("remote.git");
    let source = temporary.path().join("source");
    init_git_repo(&source).unwrap();
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), source.to_str(), None).unwrap();
    let git = |phase: &str, arguments: &[&str]| {
        live_git(
            phase,
            &source,
            arguments.iter().map(|argument| (*argument).to_string()),
            &inputs,
        )
        .unwrap()
    };
    git(
        "test initialize bare remote",
        &["init", "--bare", remote.to_str().unwrap()],
    );
    git(
        "test add remote",
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(
        "test publish expected ref",
        &["push", "-u", "origin", "main"],
    );
    let expected_sha = git("test read expected SHA", &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    fs::write(source.join("README.md"), "replacement\n").unwrap();
    git(
        "test commit replacement",
        &[
            "-c",
            "user.name=Ensemble E2E",
            "-c",
            "user.email=ensemble-e2e@example.invalid",
            "commit",
            "-am",
            "replacement",
        ],
    );
    git("test publish replacement ref", &["push", "origin", "main"]);
    let replacement_sha = git("test read replacement SHA", &["rev-parse", "HEAD"])
        .trim()
        .to_string();

    assert!(delete_live_remote_ref_at_sha(
        &inputs,
        &source,
        remote.to_str().unwrap(),
        "main",
        &expected_sha,
    )
    .is_err());
    assert_eq!(
        git(
            "test observe replacement ref",
            &["ls-remote", "--heads", "origin", "refs/heads/main"],
        ),
        format!("{replacement_sha}\trefs/heads/main\n")
    );
}

#[test]
fn live_dogfood_remote_ref_cleanup_rejects_a_replacement_origin() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let replacement = temporary.path().join("replacement.git");
    init_git_repo(&source).unwrap();
    let inputs =
        LiveDogfoodInputs::from_values(Some("1"), Some("12"), source.to_str(), None).unwrap();
    live_git(
        "test initialize replacement remote",
        &source,
        [
            "init".to_string(),
            "--bare".to_string(),
            replacement.display().to_string(),
        ],
        &inputs,
    )
    .unwrap();
    live_git(
        "test install replacement origin",
        &source,
        [
            "remote".to_string(),
            "add".to_string(),
            "origin".to_string(),
            replacement.display().to_string(),
        ],
        &inputs,
    )
    .unwrap();

    assert!(validated_live_bamboon_remote(
        &inputs,
        &source,
        "cleanup generated ref origin revalidation",
    )
    .unwrap_err()
    .contains("origin must identify chrisbanes/bamboon"));
}

#[test]
fn live_dogfood_cleanup_stops_after_a_failed_revalidation() {
    let plan = LiveDogfoodCleanupPlan::for_test();
    let mut cleanup = LiveDogfoodCleanupRecorder::new(&plan).unwrap();
    cleanup
        .attempt(LiveDogfoodCleanupStep::ClosePullRequest, Ok(()))
        .unwrap();
    assert!(cleanup
        .attempt(
            LiveDogfoodCleanupStep::ProjectDone,
            Err("stored Project item no longer matched"),
        )
        .is_err());
    assert!(cleanup
        .attempt(LiveDogfoodCleanupStep::WaitForHostRelease, Ok(()))
        .is_err());
    assert_eq!(
        cleanup.transitions(),
        [
            ("close_pull_request", "succeeded"),
            ("project_done", "preserved_failure"),
        ]
    );
}

struct FailingLiveDogfoodCleanupActions {
    attempted: Vec<LiveDogfoodCleanupStep>,
    fail_at: LiveDogfoodCleanupStep,
}

impl LiveDogfoodCleanupActions for FailingLiveDogfoodCleanupActions {
    async fn execute(&mut self, step: LiveDogfoodCleanupStep) -> Result<(), String> {
        self.attempted.push(step);
        if step == self.fail_at {
            Err(format!("{} helper failed", step.name()))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn live_dogfood_cleanup_execution_stops_after_a_helper_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-execution-stop".to_string(),
        root: temporary.path().to_path_buf(),
    };
    let plan = LiveDogfoodCleanupPlan::for_test();
    let mut cleanup = LiveDogfoodCleanupRecorder::new(&plan).unwrap();
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Routine);
    let mut actions = FailingLiveDogfoodCleanupActions {
        attempted: Vec::new(),
        fail_at: LiveDogfoodCleanupStep::ProjectDone,
    };

    assert!(
        execute_live_cleanup_sequence(&mut actions, &mut cleanup, &mut evidence, &run,)
            .await
            .is_err()
    );

    assert_eq!(
        actions.attempted,
        [
            LiveDogfoodCleanupStep::ClosePullRequest,
            LiveDogfoodCleanupStep::ProjectDone,
        ]
    );
    let persisted: Value = serde_json::from_str(
        &fs::read_to_string(temporary.path().join("evidence-v1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["transitions"],
        serde_json::json!([
            {"phase": "close_pull_request", "result": "attempting"},
            {"phase": "close_pull_request", "result": "succeeded"},
            {"phase": "project_done", "result": "attempting"},
            {"phase": "project_done", "result": "preserved_failure"}
        ])
    );
}

#[tokio::test]
async fn live_dogfood_cleanup_retains_intent_when_result_persistence_fails() {
    let temporary = tempfile::tempdir().unwrap();
    let run = LiveDogfoodRun {
        marker: "live-dogfood-evidence-write-failure".to_string(),
        root: temporary.path().to_path_buf(),
    };
    let plan = LiveDogfoodCleanupPlan::for_test();
    let mut cleanup = LiveDogfoodCleanupRecorder::new(&plan).unwrap();
    let mut evidence =
        LiveDogfoodEvidenceV1::new(&run, "chrisbanes/bamboon#47", LiveDogfoodMode::Routine);
    let mut actions = FailingLiveDogfoodCleanupActions {
        attempted: Vec::new(),
        fail_at: LiveDogfoodCleanupStep::VerifyFinalAbsence,
    };
    let mut writes = 0;

    let error = execute_live_cleanup_sequence_with_writer(
        &mut actions,
        &mut cleanup,
        &mut evidence,
        &run,
        |root, evidence| {
            writes += 1;
            if writes == 2 {
                Err("injected evidence write failure".to_string())
            } else {
                write_live_dogfood_evidence_v1(root, evidence)
            }
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "injected evidence write failure");
    assert_eq!(
        actions.attempted,
        [LiveDogfoodCleanupStep::ClosePullRequest]
    );
    let persisted: Value = serde_json::from_str(
        &fs::read_to_string(temporary.path().join("evidence-v1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["transitions"],
        serde_json::json!([
            {"phase": "close_pull_request", "result": "attempting"}
        ])
    );
}

#[test]
fn live_dogfood_cleanup_order_keeps_the_host_alive_until_public_release() {
    let plan = LiveDogfoodCleanupPlan::for_test();
    let mut cleanup = LiveDogfoodCleanupRecorder::new(&plan).unwrap();
    for step in LIVE_DOGFOOD_CLEANUP_ORDER {
        cleanup.attempt(step, Ok(())).unwrap();
    }
    assert!(cleanup.is_complete());
}

#[test]
fn live_dogfood_final_absence_requires_every_run_owned_artifact() {
    assert!(validate_live_final_absence([true; 6]).is_ok());

    for missing in 0..6 {
        let mut observations = [true; 6];
        observations[missing] = false;
        assert!(validate_live_final_absence(observations).is_err());
    }
}

#[test]
fn live_dogfood_pre_dispatch_rollback_requires_exact_issue_and_item_ownership() {
    let resources = PreDispatchResources {
        issue_id: "issue-node".to_string(),
        issue_number: 47,
        project_id: "project-node".to_string(),
        project_item_id: "item-node".to_string(),
    };
    let issue = serde_json::json!({
        "node_id": "issue-node",
        "number": 47,
        "state": "open",
    });
    let project = serde_json::json!({
        "data": {"repository": {"projectV2": {
            "id": "project-node",
            "items": {"nodes": [{
                "id": "item-node",
                "content": {"id": "issue-node", "number": 47}
            }]}
        }}}
    });

    assert!(validate_live_issue_identity(
        &issue,
        &resources.issue_id,
        resources.issue_number,
        "open",
        "pre-dispatch rollback issue",
    )
    .is_ok());
    assert!(validate_pre_dispatch_project_item_identity(&project, &resources).is_ok());
    assert!(validate_live_project_item_absence(
        &serde_json::json!({
            "data": {"repository": {"projectV2": {
                "id": "project-node",
                "items": {"nodes": []}
            }}}
        }),
        "project-node",
        "item-node",
    )
    .is_ok());
    assert!(validate_live_project_item_absence(
        &serde_json::json!({
            "data": {"repository": {"projectV2": {
                "id": "project-node",
                "items": null
            }}}
        }),
        "project-node",
        "item-node",
    )
    .is_err());
    assert!(validate_pre_dispatch_project_item_identity(
        &serde_json::json!({
            "data": {"repository": {"projectV2": {
                "id": "project-node",
                "items": {"nodes": [{
                    "id": "item-node",
                    "content": {"id": "other-issue", "number": 47}
                }]}
            }}}
        }),
        &resources,
    )
    .is_err());
}

#[test]
fn live_dogfood_host_setup_failures_run_pre_dispatch_rollback() {
    use std::cell::RefCell;

    let resources = PreDispatchResources {
        issue_id: "issue-node".to_string(),
        issue_number: 47,
        project_id: "project-node".to_string(),
        project_item_id: "item-node".to_string(),
    };
    let actions = RefCell::new(Vec::new());
    let reservation_error = start_live_pre_dispatch_host(
        &resources,
        || Err("reserve host port: unavailable".to_string()),
        |_| {
            actions.borrow_mut().push("spawn");
            Ok(())
        },
        |_, error| {
            actions.borrow_mut().push("rollback");
            format!("{error}; rolled back")
        },
    )
    .unwrap_err();
    assert_eq!(
        reservation_error,
        "reserve host port: unavailable; rolled back"
    );
    assert_eq!(*actions.borrow(), ["rollback"]);

    actions.borrow_mut().clear();
    let spawn_error = start_live_pre_dispatch_host(
        &resources,
        || Ok(42),
        |_| {
            actions.borrow_mut().push("spawn");
            Err::<(), _>("start first host: unavailable".to_string())
        },
        |_, error| {
            actions.borrow_mut().push("rollback");
            format!("{error}; rolled back")
        },
    )
    .unwrap_err();
    assert_eq!(spawn_error, "start first host: unavailable; rolled back");
    assert_eq!(*actions.borrow(), ["spawn", "rollback"]);
}
