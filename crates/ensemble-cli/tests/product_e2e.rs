#![cfg(feature = "web-ui")]

use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tempfile::TempDir;

const ISSUE_ID: &str = "E2E-1";
const ISSUE_TITLE: &str = "Exercise product workflow";

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
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
        .env("ENSEMBLE_E2E_SKIP_REQUIRED_FILE", "1")
        .env("ENSEMBLE_E2E_MISSING_HANDOFF", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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

struct TestFixture {
    config_dir: TempDir,
    todo_path: PathBuf,
    workspace_root: PathBuf,
    acpx_log_path: PathBuf,
    mock_bin_dir: PathBuf,
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

  mkdir -p "$cwd/.ensemble"
  cat > "$cwd/.ensemble/mock-prompt.txt"
  if [[ "${ENSEMBLE_E2E_MISSING_HANDOFF:-}" == "1" ]]; then
    printf '%s\n' '{"result":"succeeded","summary":"mock agent completed","output":{}}' > "$cwd/.ensemble/verdict-implement.json"
  else
    printf '%s\n' '{"result":"succeeded","summary":"mock agent completed","output":{"artifact":"mock"}}' > "$cwd/.ensemble/verdict-implement.json"
  fi
  if [[ "${ENSEMBLE_E2E_SKIP_REQUIRED_FILE:-}" != "1" ]]; then
    repo_worktree="$(find "$cwd/source" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    printf 'artifact\n' > "$repo_worktree/acceptance.txt"
  fi

  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"mock agent completed"}}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":{"type":"tool_call","name":"read_file","arguments":{"path":"Cargo.toml"}}}}}'
  if [[ "${ENSEMBLE_E2E_MISSING_HANDOFF:-}" == "1" ]]; then
    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"turn_complete","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7},"verdict":{"result":"succeeded","summary":"mock agent completed","output":{}},"stopReason":"end_turn"}}}'
  else
    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"mock-session","update":{"sessionUpdate":"turn_complete","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7},"verdict":{"result":"succeeded","summary":"mock agent completed","output":{"artifact":"mock"}},"stopReason":"end_turn"}}}'
  fi
  exit 0
fi

echo "unexpected mock acpx invocation: $*" >&2
exit 2
"#
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
const LIVE_DOGFOOD_STATUSES: [&str; 4] = ["Ready to implement", "In progress", "In review", "Done"];
static LIVE_DOGFOOD_SEQUENCE: AtomicU32 = AtomicU32::new(0);

#[derive(Debug)]
struct LiveDogfoodInputs {
    project_number: u64,
    bamboon_path: PathBuf,
    agent: String,
}

impl LiveDogfoodInputs {
    fn from_env() -> Result<Self, String> {
        Self::from_values(
            std::env::var(LIVE_DOGFOOD_OPT_IN).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_PROJECT).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_BAMBOON_PATH).ok().as_deref(),
            std::env::var(LIVE_DOGFOOD_AGENT).ok().as_deref(),
        )
    }

    fn from_values(
        opt_in: Option<&str>,
        project_number: Option<&str>,
        bamboon_path: Option<&str>,
        agent: Option<&str>,
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
        })
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

fn live_dogfood_config(inputs: &LiveDogfoodInputs, run: &LiveDogfoodRun) -> String {
    let artifact = run.expected_artifact();
    format!(
        r#"tracker:
  kind: github
  repository: chrisbanes/bamboon
  project_number: {}
  active_states:
    - Ready to implement
  terminal_states:
    - Done
workspace:
  root: {}
repos:
  - path: {}
    branch: main
    finalize:
      mode: none
agents:
  builder:
    acpx_agent: {}
    prompt: >-
      Work only on this issue. Create exactly {} with exactly this content:
      {} Commit it with exactly this message: {}. Run a lightweight verification.
      Do not push, create a pull request, or change any other tracked file. End with a JSON
      step output declaring success and a concise summary.
steps:
  - name: implement
    agent: builder
    tracker_state: In progress
on_success: Done
on_failure: Done
max_cycles: 1
polling:
  interval_ms: 1000
concurrency:
  max_concurrent_agents: 1
  max_step_parallelism: 1
agent:
  turn_timeout_ms: 1800000
"#,
        inputs.project_number,
        yaml_quote(&run.root.join("workspaces").display().to_string()),
        yaml_quote(&inputs.bamboon_path.display().to_string()),
        yaml_quote(&inputs.agent),
        yaml_quote(&artifact.path.display().to_string()),
        yaml_quote(&artifact.content),
        yaml_quote(&artifact.commit_message),
    )
}

struct LiveDogfoodProject {
    id: String,
    status_field_id: String,
    ready_option_id: String,
}

struct LiveDogfoodResources {
    issue_id: String,
    issue_number: u64,
    project_id: String,
    project_item_id: String,
    dispatch_started: bool,
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
                return Err(format!("{phase}: command timed out after 30 seconds"));
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
    let remote = live_git(
        "preflight Bamboon remote",
        root,
        [
            "remote".to_string(),
            "get-url".to_string(),
            "origin".to_string(),
        ],
        inputs,
    )?;
    if !is_bamboon_remote(remote.trim()) {
        return Err(
            "preflight Bamboon remote: origin must identify chrisbanes/bamboon".to_string(),
        );
    }
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

fn live_preflight(inputs: &LiveDogfoodInputs, run: &LiveDogfoodRun) -> Result<String, String> {
    run_live_command("preflight gh", Command::new("gh"), inputs)?;
    let mut acpx = Command::new("acpx");
    acpx.arg("--version");
    let acpx_version = run_live_command("preflight ACPX", acpx, inputs)?;
    fs::write(run.root.join("acpx.version"), acpx_version)
        .map_err(|error| format!("preflight ACPX: could not retain version metadata: {error}"))?;
    validate_live_bamboon_clone(inputs)?;
    live_gh(
        "preflight GitHub access",
        ["api".to_string(), "user".to_string()],
        inputs,
    )?;
    validate_live_project(inputs)?;
    let token = live_gh(
        "preflight GitHub token",
        ["auth".to_string(), "token".to_string()],
        inputs,
    )?;
    if token.trim().is_empty() {
        return Err("preflight GitHub token: gh returned an empty token".to_string());
    }
    Ok(token.trim().to_string())
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
    serde_json::from_str(&output).map_err(|error| format!("{phase}: invalid response: {error}"))
}

fn rollback_pre_dispatch(resources: &LiveDogfoodResources, inputs: &LiveDogfoodInputs) {
    const REMOVE_ITEM: &str = r#"mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) { deletedItemId }
}"#;
    if !resources.project_item_id.is_empty() {
        let _ = live_graphql_mutation(
            "pre-dispatch rollback project item",
            REMOVE_ITEM,
            [
                ("projectId".to_string(), resources.project_id.clone()),
                ("itemId".to_string(), resources.project_item_id.clone()),
            ],
            inputs,
        );
    }
    let _ = live_gh(
        "pre-dispatch rollback issue",
        [
            "api".to_string(),
            "--method".to_string(),
            "PATCH".to_string(),
            format!("repos/chrisbanes/bamboon/issues/{}", resources.issue_number),
            "-f".to_string(),
            "state=closed".to_string(),
        ],
        inputs,
    );
}

fn create_live_resources(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    project: &LiveDogfoodProject,
) -> Result<LiveDogfoodResources, String> {
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
                let resources = LiveDogfoodResources {
                    issue_id,
                    issue_number,
                    project_id: project.id.clone(),
                    project_item_id: String::new(),
                    dispatch_started: false,
                };
                rollback_pre_dispatch(&resources, inputs);
                return Err("add synthetic issue to Project: missing Project item ID".to_string());
            }
        },
        Err(error) => {
            let resources = LiveDogfoodResources {
                issue_id,
                issue_number,
                project_id: project.id.clone(),
                project_item_id: String::new(),
                dispatch_started: false,
            };
            rollback_pre_dispatch(&resources, inputs);
            return Err(error);
        }
    };
    let mut resources = LiveDogfoodResources {
        issue_id,
        issue_number,
        project_id: project.id.clone(),
        project_item_id,
        dispatch_started: false,
    };

    const SET_STATUS: &str = r#"mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } }
}"#;
    if let Err(error) = live_graphql_mutation(
        "make synthetic issue ready",
        SET_STATUS,
        [
            ("projectId".to_string(), project.id.clone()),
            ("itemId".to_string(), resources.project_item_id.clone()),
            ("fieldId".to_string(), project.status_field_id.clone()),
            ("optionId".to_string(), project.ready_option_id.clone()),
        ],
        inputs,
    ) {
        rollback_pre_dispatch(&resources, inputs);
        return Err(error);
    }
    resources.dispatch_started = true;
    Ok(resources)
}

fn spawn_live_host(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    token: &str,
    port: u16,
) -> Result<Child, String> {
    fs::write(
        run.root.join("config.yaml"),
        live_dogfood_config(inputs, run),
    )
    .map_err(|error| format!("start host: could not write generated config: {error}"))?;
    let stdout = fs::File::create(run.root.join("host.stdout.log"))
        .map_err(|error| format!("start host: could not create stdout log: {error}"))?;
    let stderr = fs::File::create(run.root.join("host.stderr.log"))
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

async fn wait_for_live_completion(
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
                if detail["status"] == "completed_succeeded" {
                    return Ok(detail);
                }
                detail["status"].as_str().unwrap_or("unknown").to_string()
            }
            Ok(response) => format!("issue detail returned {}", response.status()),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "wait for terminal host state: timed out; last observation: {}",
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
                "{base_url}/api/v1/history?outcome=succeeded&step=implement"
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

fn verify_live_artifact(
    inputs: &LiveDogfoodInputs,
    run: &LiveDogfoodRun,
    resources: &LiveDogfoodResources,
) -> Result<(String, String), String> {
    let artifact = run.expected_artifact();
    let repo_root = run.root.join("workspaces").join("bamboon");
    let worktree = fs::read_dir(&repo_root)
        .map_err(|error| format!("verify local commit: worktree root was unavailable: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .ok_or_else(|| "verify local commit: no Bamboon issue worktree was found".to_string())?;
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
    let remote_branch = live_git(
        "verify no remote branch",
        &worktree,
        [
            "ls-remote".to_string(),
            "--heads".to_string(),
            "origin".to_string(),
            branch.clone(),
        ],
        inputs,
    )?;
    if !remote_branch.is_empty() {
        return Err("verify no remote branch: marker branch was published".to_string());
    }
    let pull_requests = live_gh(
        "verify no pull request",
        [
            "pr".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            "chrisbanes/bamboon".to_string(),
            "--head".to_string(),
            branch.clone(),
            "--json".to_string(),
            "number".to_string(),
        ],
        inputs,
    )?;
    if pull_requests != "[]\n" {
        return Err(
            "verify no pull request: a pull request existed for the generated branch".to_string(),
        );
    }
    let _ = resources;
    Ok((branch, sha.to_string()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the explicitly provisioned private dogfood Project, clean Bamboon clone, ACPX, and model/network cost"]
async fn live_bamboon_issue_commits_without_publication() {
    let inputs = LiveDogfoodInputs::from_env().expect("live dogfood inputs");
    let run = LiveDogfoodRun::create().expect("persistent live dogfood run directory");
    let result = async {
        let token = live_preflight(&inputs, &run)?;
        let project = validate_live_project(&inputs)?;
        let resources = create_live_resources(&inputs, &run, &project)?;
        wait_for_live_project_status(&inputs, &resources.issue_id, "Ready to implement").await?;
        let port = reserve_local_port().map_err(|error| format!("reserve host port: {error}"))?;
        let mut host = spawn_live_host(&inputs, &run, &token, port)?;
        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");
        let completed = async {
            wait_for_server(&client, &base_url)
                .await
                .map_err(|error| format!("wait for host: {error}"))?;
            wait_for_live_project_status(&inputs, &resources.issue_id, "In progress").await?;
            let detail =
                wait_for_live_completion(&client, &base_url, resources.issue_number).await?;
            wait_for_live_history(&client, &base_url, resources.issue_number).await?;
            let (branch, sha) = verify_live_artifact(&inputs, &run, &resources)?;
            Ok::<_, String>((detail, branch, sha))
        }
        .await;
        let _ = host.kill();
        let _ = host.wait();
        let (detail, branch, sha) = completed?;
        if detail["issue_identifier"] != format!("chrisbanes/bamboon#{}", resources.issue_number) {
            return Err("verify public host detail: host reported an unexpected issue".to_string());
        }
        Ok((resources, branch, sha))
    }
    .await;

    match result {
        Ok((resources, branch, sha)) => eprintln!(
            "live dogfood preserved marker={} issue={} branch={} sha={} run_directory={}",
            run.marker,
            resources.issue_number,
            branch,
            sha,
            run.root.display()
        ),
        Err(error) => panic!(
            "{error}\nlive dogfood dispatch-and-later artifacts are preserved: marker={} run_directory={}",
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
    assert!(config.contains("on_success: Done"));
    assert!(config.contains("max_cycles: 1"));
    assert!(config.contains("max_concurrent_agents: 1"));
    assert!(config.contains("max_step_parallelism: 1"));
    assert!(config.contains("mode: none"));
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
fn live_dogfood_operator_contract_is_documented_without_fixture_values() {
    let contributing = include_str!("../../../docs/contributing.md");
    for required in [
        "ENSEMBLE_LIVE_DOGFOOD=1",
        "ENSEMBLE_DOGFOOD_PROJECT_NUMBER",
        "ENSEMBLE_DOGFOOD_BAMBOON_PATH",
        "ENSEMBLE_DOGFOOD_AGENT",
        "gh auth token",
        "finalization set to",
        "`none`",
        "never part of CI",
    ] {
        assert!(
            contributing.contains(required),
            "contributing guide must document {required}"
        );
    }
}
