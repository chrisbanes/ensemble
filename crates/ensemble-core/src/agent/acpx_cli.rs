use std::future::Future;
use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tracing::debug;

use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, StopReason, TokenUsage};
use super::protocol;

pub struct AcpxCli {
    executable: String,
}

impl AcpxCli {
    pub fn new(executable: String) -> Self {
        Self { executable }
    }

    pub async fn ensure_session(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        model: Option<&str>,
    ) -> Result<(), AgentError> {
        let mut command = Command::new(&self.executable);
        command.kill_on_drop(true);
        if let Some(model) = model {
            command.args(["--model", model]);
        }
        command
            .arg("--cwd")
            .arg(cwd.display().to_string())
            .args(["--format", "json", "--json-strict"])
            .arg(agent)
            .args(["sessions", "ensure", "--name", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), model, "running acpx sessions ensure");

        let output = command.output().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx sessions ensure: {e}"),
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let reason = if stderr.is_empty() && stdout.is_empty() {
                output.status.to_string()
            } else {
                format!(
                    "{}; stderr: {}; stdout: {}",
                    output.status,
                    stderr.trim(),
                    stdout.trim()
                )
            };
            return Err(AgentError::AcpxCommandFailed {
                command: "sessions ensure".to_string(),
                reason,
            });
        }

        Ok(())
    }

    pub async fn run_prompt<F, Fut>(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        prompt: &str,
        model: Option<&str>,
        mut on_event: F,
    ) -> Result<(), AgentError>
    where
        F: FnMut(AgentEvent) -> Fut,
        Fut: Future<Output = ()> + Send,
    {
        let mut command = self.base_command(agent, cwd, model);
        command
            .args(["prompt", "--session", session_name, "--file", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx prompt");

        let mut child = command.spawn().map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx prompt: {e}"),
        })?;

        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(prompt.as_bytes()).await {
                cleanup_prompt_child(&mut child).await;
                return Err(AgentError::IoError {
                    reason: format!("failed to write prompt to acpx stdin: {error}"),
                });
            }
            if let Err(error) = stdin.flush().await {
                cleanup_prompt_child(&mut child).await;
                return Err(AgentError::IoError {
                    reason: format!("failed to flush prompt to acpx stdin: {error}"),
                });
            }
        }

        let stdout = child.stdout.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture acpx stdout".to_string(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture acpx stderr".to_string(),
        })?;

        // Spawn a task to forward stderr to tracing
        let agent_name = agent.to_string();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                debug!(agent = %agent_name, "acpx stderr: {}", line);
            }
        });

        let mut reader = BufReader::new(stdout).lines();
        let mut saw_terminal_event = false;
        let mut last_usage: Option<TokenUsage> = None;

        while let Some(line) = reader.next_line().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to read acpx stdout: {e}"),
        })? {
            let message =
                protocol::parse_jsonrpc(&line).ok_or_else(|| AgentError::ResponseError {
                    reason: format!("invalid JSON-RPC message from acpx: {line}"),
                })?;

            if let Some(update) = parse_session_update_from_message(&message)? {
                if let Some(usage) = update.usage {
                    last_usage = Some(usage);
                }
                if let Some(content) = update.output_text {
                    on_event(AgentEvent::OutputChunk {
                        stream: RuntimeStream::Stdout,
                        content,
                    })
                    .await;
                }
                if let Some(permission) = update.permission_request {
                    on_event(AgentEvent::Warning {
                        message: format!(
                            "permission requested ({}): {}",
                            permission.permission_id, permission.description
                        ),
                    })
                    .await;
                }
                if let Some(stop_reason) = update.stop_reason {
                    saw_terminal_event = true;
                    on_event(map_stop_reason(stop_reason, last_usage.clone())).await;
                }
                continue;
            }

            if let Some(stop_reason) = message
                .result
                .as_ref()
                .and_then(protocol::parse_stop_reason_from_result)
            {
                saw_terminal_event = true;
                on_event(map_stop_reason(stop_reason, last_usage.clone())).await;
                continue;
            }

            if let Some(error) = message.error.as_ref() {
                saw_terminal_event = true;
                on_event(AgentEvent::RunFailed {
                    reason: error.message.clone(),
                    usage: last_usage.clone(),
                })
                .await;
                continue;
            }

            on_event(AgentEvent::OtherMessage { raw: line }).await;
        }

        let status = child.wait().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to wait for acpx prompt: {e}"),
        })?;
        if !status.success() {
            return Err(AgentError::AcpxCommandFailed {
                command: "prompt".to_string(),
                reason: status.to_string(),
            });
        }
        if !saw_terminal_event {
            return Err(AgentError::AcpxFinalStatusMissing {
                context: format!("session '{session_name}' ended without a terminal event"),
            });
        }

        Ok(())
    }

    pub async fn cancel(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        model: Option<&str>,
    ) -> Result<(), AgentError> {
        let mut command = self.base_command(agent, cwd, model);
        command.args(["cancel", "--session", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx cancel");
        let status = command.status().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx cancel: {e}"),
        })?;
        if !status.success() {
            return Err(AgentError::AcpxCommandFailed {
                command: "cancel".to_string(),
                reason: status.to_string(),
            });
        }
        Ok(())
    }

    pub async fn close_session(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        model: Option<&str>,
    ) -> Result<(), AgentError> {
        let mut command = self.base_command(agent, cwd, model);
        command.args(["sessions", "close", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx sessions close");
        let status = command.status().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx sessions close: {e}"),
        })?;
        if !status.success() {
            return Err(AgentError::AcpxCommandFailed {
                command: "sessions close".to_string(),
                reason: status.to_string(),
            });
        }
        Ok(())
    }

    fn base_command(&self, agent: &str, cwd: &Path, model: Option<&str>) -> Command {
        let mut command = Command::new(&self.executable);
        command.kill_on_drop(true);
        if let Some(model) = model {
            command.args(["--model", model]);
        }
        command
            .arg("--cwd")
            .arg(cwd.display().to_string())
            .args(["--format", "json", "--json-strict"])
            .arg(agent);
        command
    }
}

async fn cleanup_prompt_child(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn parse_session_update_from_message(
    message: &super::events::JsonRpcMessage,
) -> Result<Option<protocol::ParsedSessionUpdate>, AgentError> {
    if message.method.as_deref() != Some("session/update") {
        return Ok(None);
    }

    Ok(message
        .params
        .as_ref()
        .and_then(protocol::parse_session_update))
}

fn map_stop_reason(stop_reason: StopReason, usage: Option<TokenUsage>) -> AgentEvent {
    match stop_reason {
        StopReason::EndTurn | StopReason::MaxTokens => AgentEvent::RunCompleted { usage },
        StopReason::Cancelled => AgentEvent::RunFailed {
            reason: "stop reason: cancelled".to_string(),
            usage,
        },
        StopReason::Refusal => AgentEvent::RunFailed {
            reason: "stop reason: refusal".to_string(),
            usage,
        },
        StopReason::MaxTurnRequests => AgentEvent::RunFailed {
            reason: "stop reason: max_turn_requests".to_string(),
            usage,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use crate::agent::events::{AgentEvent, TokenUsage};
    use crate::error::AgentError;

    use super::AcpxCli;

    fn write_mock_acpx_script(dir: &Path, script_content: &str) -> String {
        let script_path = dir.join("mock_acpx.sh");
        std::fs::write(&script_path, script_content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script_path.display().to_string()
    }

    #[tokio::test]
    async fn ensure_session_uses_sessions_ensure_command() {
        let dir = tempfile::TempDir::new().unwrap();
        let args_path = dir.path().join("args.txt");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"{}\"\n",
                args_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        client
            .ensure_session("codex", "build-session", dir.path(), None)
            .await
            .unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("sessions ensure"));
        assert!(args.contains("--name build-session"));
    }

    #[tokio::test]
    async fn ensure_session_puts_model_before_agent() {
        let dir = tempfile::TempDir::new().unwrap();
        let args_path = dir.path().join("args.txt");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"{}\"\n",
                args_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        client
            .ensure_session("codex", "build-session", dir.path(), Some("gpt-5.4/medium"))
            .await
            .unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let model_pos = args.find("--model").expect("--model should be present");
        let agent_pos = args.find("codex").expect("codex agent should be present");
        assert!(
            model_pos < agent_pos,
            "--model must come BEFORE agent; got: {}",
            args
        );
    }

    #[tokio::test]
    async fn prompt_stream_maps_output_and_completion_events() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"},"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}}
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let events = Arc::new(Mutex::new(Vec::new()));
        client
            .run_prompt("codex", "build-session", dir.path(), "hi", None, |event| {
                let events = Arc::clone(&events);
                async move {
                    events.lock().unwrap().push(event);
                }
            })
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(matches!(events[0], AgentEvent::OutputChunk { .. }));
        assert!(matches!(events[1], AgentEvent::RunCompleted { .. }));
    }

    #[tokio::test]
    async fn prompt_stream_maps_jsonrpc_updates_and_stop_reason() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let events = Arc::new(Mutex::new(Vec::new()));
        client
            .run_prompt("codex", "build-session", dir.path(), "hi", None, |event| {
                let events = Arc::clone(&events);
                async move {
                    events.lock().unwrap().push(event);
                }
            })
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(matches!(events[0], AgentEvent::OutputChunk { .. }));
        assert!(matches!(events[1], AgentEvent::RunCompleted { .. }));
    }

    #[tokio::test]
    async fn prompt_stream_rejects_non_jsonrpc_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"event":"completed"}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let error = client
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                None,
                |_| async {},
            )
            .await
            .unwrap_err();

        assert!(matches!(error, AgentError::ResponseError { .. }));
    }

    #[tokio::test]
    async fn prompt_stream_emits_output_before_process_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        let release_path = dir.path().join("release.flag");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                r#"#!/bin/bash
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"hello"}}}}}}}}'
while [ ! -f "{}" ]; do
  /bin/sleep 0.05
done
printf '%s\n' '{{"jsonrpc":"2.0","id":11,"result":{{"stopReason":"end_turn"}}}}'
"#,
                release_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let run = client.run_prompt("codex", "build-session", dir.path(), "hi", None, |event| {
            let tx = tx.clone();
            async move {
                let _ = tx.send(event).await;
            }
        });
        tokio::pin!(run);

        let saw_output = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                tokio::select! {
                    result = &mut run => panic!("prompt exited before streaming output: {result:?}"),
                    maybe_event = rx.recv() => {
                        match maybe_event {
                            Some(AgentEvent::OutputChunk { content, .. }) if content == "hello" => break true,
                            Some(_) => {}
                            None => panic!("event stream closed before output arrived"),
                        }
                    }
                }
            }
        })
        .await
        .unwrap();

        assert!(saw_output);
        std::fs::write(&release_path, "").unwrap();
        run.await.unwrap();
    }

    #[tokio::test]
    async fn prompt_without_terminal_event_returns_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let error = client
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                None,
                |_| async {},
            )
            .await
            .unwrap_err();

        assert!(matches!(error, AgentError::AcpxFinalStatusMissing { .. }));
    }

    #[tokio::test]
    async fn failed_event_preserves_usage() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"usage_update","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}}
{"jsonrpc":"2.0","id":12,"result":{"stopReason":"refusal"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let events = Arc::new(Mutex::new(Vec::new()));
        client
            .run_prompt("codex", "build-session", dir.path(), "hi", None, |event| {
                let events = Arc::clone(&events);
                async move {
                    events.lock().unwrap().push(event);
                }
            })
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(matches!(
            &events[0],
            AgentEvent::RunFailed {
                reason,
                usage: Some(TokenUsage {
                    input_tokens: 4,
                    output_tokens: 5,
                    total_tokens: 9
                })
            } if reason == "stop reason: refusal"
        ));
    }

    #[tokio::test]
    async fn cancelled_stop_reason_is_mapped_to_run_failed() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","id":13,"result":{"stopReason":"cancelled"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let events = Arc::new(Mutex::new(Vec::new()));
        client
            .run_prompt("codex", "build-session", dir.path(), "hi", None, |event| {
                let events = Arc::clone(&events);
                async move {
                    events.lock().unwrap().push(event);
                }
            })
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(matches!(
            &events[0],
            AgentEvent::RunFailed { reason, .. } if reason == "stop reason: cancelled"
        ));
    }

    #[tokio::test]
    async fn cancel_and_close_use_expected_commands() {
        let dir = tempfile::TempDir::new().unwrap();
        let log_path = dir.path().join("args.txt");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"{}\"\n",
                log_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        client
            .cancel("codex", "build-session", dir.path(), None)
            .await
            .unwrap();
        client
            .close_session("codex", "build-session", dir.path(), None)
            .await
            .unwrap();

        let args = std::fs::read_to_string(log_path).unwrap();
        assert!(args.contains("cancel --session build-session"));
        assert!(args.contains("sessions close build-session"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_write_failure_kills_spawned_process() {
        let dir = tempfile::TempDir::new().unwrap();
        let pid_path = dir.path().join("pid.txt");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                r#"#!/bin/bash
printf '%s' "$$" > "{}"
exec 0<&-
/bin/sleep 30
"#,
                pid_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        let prompt = "hi".repeat(1024 * 1024);
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client.run_prompt(
                "codex",
                "build-session",
                dir.path(),
                &prompt,
                None,
                |_| async {},
            ),
        )
        .await
        .expect("run_prompt should not hang when stdin closes")
        .unwrap_err();

        assert!(matches!(error, AgentError::IoError { .. }));

        let pid: i32 = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(
            !alive,
            "acpx child should be terminated after stdin write failure"
        );
    }
}
