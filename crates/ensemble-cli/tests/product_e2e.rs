#![cfg(feature = "web-ui")]

use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
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
