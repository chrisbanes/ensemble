use std::future::Future;
use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tracing::{debug, warn};

use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, StopReason, TokenUsage};
use super::protocol;

pub struct AcpxCli {
    executable: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AcpxCommandOptions<'a> {
    pub model: Option<&'a str>,
    pub reasoning_level: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptVisibility {
    Visible,
    Hidden,
}

#[derive(Debug, Clone, Default)]
pub struct PromptOutcome {
    pub runtime_verdict: Option<serde_json::Value>,
    pub output_text: String,
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
        options: AcpxCommandOptions<'_>,
    ) -> Result<(), AgentError> {
        let mut command = Command::new(&self.executable);
        command.kill_on_drop(true);
        if let Some(model) = options.model {
            command.args(["--model", model]);
        }
        if let Some(reasoning_level) = options.reasoning_level {
            command.args(["--reasoning-level", reasoning_level]);
        }
        command
            .arg("--cwd")
            .arg(cwd.display().to_string())
            .args(["--format", "json", "--json-strict"])
            .arg(agent)
            .args(["sessions", "ensure", "--name", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), model = options.model, reasoning_level = options.reasoning_level, "running acpx sessions ensure");

        let output = spawn_with_etxtbsy_retry(command)
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to run acpx sessions ensure: {e}"),
            })?
            .wait_with_output()
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to read acpx sessions ensure output: {e}"),
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
        options: AcpxCommandOptions<'_>,
        visibility: PromptVisibility,
        mut on_event: F,
    ) -> Result<PromptOutcome, AgentError>
    where
        F: FnMut(AgentEvent) -> Fut,
        Fut: Future<Output = ()> + Send,
    {
        let mut command = self.base_command(agent, cwd, options);
        command
            .args(["prompt", "--session", session_name, "--file", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx prompt");

        let mut child = spawn_with_etxtbsy_retry(command).map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx prompt: {e}"),
        })?;

        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(prompt.as_bytes()).await {
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    cleanup_prompt_child(&mut child).await;
                    return Err(AgentError::IoError {
                        reason: format!("failed to write prompt to acpx stdin: {error}"),
                    });
                }
                // Broken pipe: check if the child already exited. If so, the
                // prompt write failure is harmless — the downstream code will
                // still read whatever output the child produced. If the child
                // is still running, the pipe filled up and this is a real error.
                if child_has_exited(&mut child) {
                    drop(stdin);
                } else {
                    cleanup_prompt_child(&mut child).await;
                    return Err(AgentError::IoError {
                        reason: format!("failed to write prompt to acpx stdin: {error}"),
                    });
                }
            } else if let Err(error) = stdin.flush().await {
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    cleanup_prompt_child(&mut child).await;
                    return Err(AgentError::IoError {
                        reason: format!("failed to flush prompt to acpx stdin: {error}"),
                    });
                }
                if child_has_exited(&mut child) {
                    drop(stdin);
                } else {
                    cleanup_prompt_child(&mut child).await;
                    return Err(AgentError::IoError {
                        reason: format!("failed to flush prompt to acpx stdin: {error}"),
                    });
                }
            }
        }

        let stdout = child.stdout.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture acpx stdout".to_string(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture acpx stderr".to_string(),
        })?;

        let stderr_path = cwd
            .join(".ensemble")
            .join(format!("acpx-stderr-{}.log", session_name));
        let parent = stderr_path.parent().ok_or_else(|| AgentError::IoError {
            reason: "stderr path has no parent".to_string(),
        })?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to create .ensemble directory: {e}"),
            })?;
        let mut stderr_file =
            tokio::fs::File::create(&stderr_path)
                .await
                .map_err(|e| AgentError::IoError {
                    reason: format!("failed to create stderr log file: {e}"),
                })?;

        let stderr_path_clone = stderr_path.clone();
        debug!(agent = %agent, session = %session_name, path = %stderr_path.display(), "acpx stderr -> {}", stderr_path.display());

        let agent_name = agent.to_string();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut line_count: u64 = 0;
            let mut lines_since_last: u64 = 0;
            let mut last_report = tokio::time::Instant::now();
            let mut write_failed = false;

            while let Some(line_result) = reader.next_line().await.transpose() {
                match line_result {
                    Ok(line) => {
                        line_count += 1;
                        lines_since_last += 1;
                        if let Err(e) = (async {
                            stderr_file.write_all(line.as_bytes()).await?;
                            stderr_file.write_all(b"\n").await
                        })
                        .await
                        {
                            warn!(agent = %agent_name, error = %e, "failed to write acpx stderr to file");
                            write_failed = true;
                            break;
                        }

                        if last_report.elapsed() >= tokio::time::Duration::from_secs(5) {
                            let _ = stderr_file.flush().await;
                            if lines_since_last > 0 {
                                debug!(agent = %agent_name, lines = lines_since_last, path = %stderr_path_clone.display(), "acpx stderr: {} lines since last summary", lines_since_last);
                            }
                            lines_since_last = 0;
                            last_report = tokio::time::Instant::now();
                        }
                    }
                    Err(e) => {
                        debug!(agent = %agent_name, error = %e, "acpx stderr read error");
                        break;
                    }
                }
            }

            if !write_failed && line_count > 0 {
                let _ = stderr_file.flush().await;
                debug!(agent = %agent_name, total_lines = line_count, path = %stderr_path_clone.display(), "acpx stderr complete: {}", stderr_path_clone.display());
            }
        });

        let visible = visibility == PromptVisibility::Visible;
        let mut output_text = String::new();
        let mut reader = BufReader::new(stdout).lines();
        let mut saw_terminal_event = false;
        let mut last_usage: Option<TokenUsage> = None;
        let mut last_runtime_verdict: Option<serde_json::Value> = None;

        let mut read_result = Ok(());
        loop {
            let line = match reader.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    read_result = Err(AgentError::IoError {
                        reason: format!("failed to read acpx stdout: {error}"),
                    });
                    break;
                }
            };

            let message = match protocol::parse_jsonrpc(&line) {
                Some(message) => message,
                None => {
                    read_result = Err(AgentError::ResponseError {
                        reason: format!("invalid JSON-RPC message from acpx: {line}"),
                    });
                    break;
                }
            };

            let update = match parse_session_update_from_message(&message) {
                Ok(update) => update,
                Err(error) => {
                    read_result = Err(error);
                    break;
                }
            };

            if let Some(update) = update {
                if let Some(usage) = update.usage {
                    last_usage = Some(usage);
                }
                if let Some(verdict) = update.verdict {
                    last_runtime_verdict = Some(verdict);
                }
                if let Some(content) = update.output_text {
                    output_text.push_str(&content);
                    if visible {
                        on_event(AgentEvent::OutputChunk {
                            stream: RuntimeStream::Stdout,
                            content,
                        })
                        .await;
                    }
                }
                if let Some(permission) = update.permission_request {
                    if visible {
                        on_event(AgentEvent::Warning {
                            message: format!(
                                "permission requested ({}): {}",
                                permission.permission_id, permission.description
                            ),
                        })
                        .await;
                    }
                }
                if let Some(stop_reason) = update.stop_reason {
                    saw_terminal_event = true;
                    if visible {
                        on_event(map_stop_reason(stop_reason, last_usage.clone())).await;
                    }
                }
                continue;
            }

            if let Some(stop_reason) = message
                .result
                .as_ref()
                .and_then(protocol::parse_stop_reason_from_result)
            {
                saw_terminal_event = true;
                if visible {
                    on_event(map_stop_reason(stop_reason, last_usage.clone())).await;
                }
                continue;
            }

            if let Some(error) = message.error.as_ref() {
                saw_terminal_event = true;
                if visible {
                    on_event(AgentEvent::RunFailed {
                        reason: error.message.clone(),
                        usage: last_usage.clone(),
                    })
                    .await;
                }
                continue;
            }

            if visible {
                on_event(AgentEvent::OtherMessage { raw: line }).await;
            }
        }

        let status = if read_result.is_err() {
            cleanup_prompt_child(&mut child).await;
            None
        } else {
            let wait_result = child.wait().await.map_err(|e| AgentError::IoError {
                reason: format!("failed to wait for acpx prompt: {e}"),
            });
            Some(wait_result)
        };
        // Wait for the stderr sink to finish draining and flushing.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), stderr_task).await;

        if let Err(error) = read_result {
            return Err(error);
        }

        let status = status.expect("prompt status should be present when stdout read succeeds")?;
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

        Ok(PromptOutcome {
            runtime_verdict: last_runtime_verdict,
            output_text,
        })
    }

    pub async fn cancel(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        options: AcpxCommandOptions<'_>,
    ) -> Result<(), AgentError> {
        let mut command = self.base_command(agent, cwd, options);
        command.args(["cancel", "--session", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx cancel");
        let status = spawn_with_etxtbsy_retry(command)
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to run acpx cancel: {e}"),
            })?
            .wait()
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to wait on acpx cancel: {e}"),
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
        options: AcpxCommandOptions<'_>,
    ) -> Result<(), AgentError> {
        let mut command = self.base_command(agent, cwd, options);
        command.args(["sessions", "close", session_name]);
        debug!(agent, session_name, cwd = %cwd.display(), "running acpx sessions close");
        let status = spawn_with_etxtbsy_retry(command)
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to run acpx sessions close: {e}"),
            })?
            .wait()
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("failed to wait on acpx sessions close: {e}"),
            })?;
        if !status.success() {
            return Err(AgentError::AcpxCommandFailed {
                command: "sessions close".to_string(),
                reason: status.to_string(),
            });
        }
        Ok(())
    }

    fn base_command(&self, agent: &str, cwd: &Path, options: AcpxCommandOptions<'_>) -> Command {
        let mut command = Command::new(&self.executable);
        command.kill_on_drop(true);
        if let Some(model) = options.model {
            command.args(["--model", model]);
        }
        if let Some(reasoning_level) = options.reasoning_level {
            command.args(["--reasoning-level", reasoning_level]);
        }
        command
            .arg("--cwd")
            .arg(cwd.display().to_string())
            .args(["--format", "json", "--json-strict"])
            .arg(agent);
        command
    }
}

/// Spawn an `acpx` child process, retrying on `ETXTBSY` ("Text file busy").
///
/// On Linux, `Command::spawn` can fail with `ETXTBSY` if the executable was
/// very recently written to and the kernel's `execve` check still sees a
/// write reference. This is a known, intermittent race — see
/// <https://github.com/rust-lang/rust/issues/114554>. In practice it shows up
/// in the test suite when a mock script is written immediately before being
/// exec'd. Retrying with a short backoff resolves it deterministically.
fn spawn_with_etxtbsy_retry(mut command: Command) -> std::io::Result<tokio::process::Child> {
    const MAX_ATTEMPTS: u32 = 5;
    let mut attempt = 0;
    loop {
        attempt += 1;
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.raw_os_error() == Some(26) && attempt < MAX_ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(attempt as u64 * 10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn child_has_exited(child: &mut tokio::process::Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
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
    use std::sync::{Arc, Mutex};

    use crate::agent::events::{AgentEvent, TokenUsage};
    use crate::agent::test_support::write_mock_acpx_script;
    use crate::error::AgentError;

    use super::{AcpxCli, AcpxCommandOptions, PromptVisibility};

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
            .ensure_session(
                "codex",
                "build-session",
                dir.path(),
                AcpxCommandOptions::default(),
            )
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
            .ensure_session(
                "codex",
                "build-session",
                dir.path(),
                AcpxCommandOptions {
                    model: Some("gpt-5.4/medium"),
                    reasoning_level: None,
                },
            )
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
    async fn ensure_session_puts_reasoning_level_before_agent() {
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
            .ensure_session(
                "codex",
                "build-session",
                dir.path(),
                AcpxCommandOptions {
                    model: None,
                    reasoning_level: Some("high"),
                },
            )
            .await
            .unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let reasoning_pos = args
            .find("--reasoning-level")
            .expect("--reasoning-level should be present");
        let agent_pos = args.find("codex").expect("codex agent should be present");
        assert!(
            reasoning_pos < agent_pos,
            "--reasoning-level must come BEFORE agent; got: {}",
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
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |event| {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push(event);
                    }
                },
            )
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
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |event| {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push(event);
                    }
                },
            )
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
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
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
        let run = client.run_prompt(
            "codex",
            "build-session",
            dir.path(),
            "hi",
            AcpxCommandOptions::default(),
            PromptVisibility::Visible,
            |event| {
                let tx = tx.clone();
                async move {
                    let _ = tx.send(event).await;
                }
            },
        );
        tokio::pin!(run);

        let saw_output = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
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
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |event| {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push(event);
                    }
                },
            )
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
    async fn run_prompt_returns_runtime_verdict_from_acpx_updates() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"turn_complete","verdict":{"verdict":"reject","summary":"lint errors"},"stopReason":"end_turn"}}}
{"jsonrpc":"2.0","id":14,"result":{"stopReason":"end_turn"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let outcome = client
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |_| async {},
            )
            .await
            .unwrap();

        assert_eq!(
            outcome.runtime_verdict,
            Some(serde_json::json!({
                "verdict": "reject",
                "summary": "lint errors"
            }))
        );
    }

    #[tokio::test]
    async fn hidden_prompt_captures_output_without_emitting_events() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            temp.path(),
            r#"#!/usr/bin/env bash
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"succeeded\"}"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
"#,
        );
        let cli = AcpxCli::new(script);
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_callback = events.clone();

        let outcome = cli
            .run_prompt(
                "codex",
                "session",
                temp.path(),
                "extract",
                AcpxCommandOptions::default(),
                PromptVisibility::Hidden,
                move |event| {
                    let events_for_callback = events_for_callback.clone();
                    async move {
                        events_for_callback.lock().unwrap().push(event);
                    }
                },
            )
            .await
            .unwrap();

        assert_eq!(outcome.output_text, "{\"result\":\"succeeded\"}");
        assert!(events.lock().unwrap().is_empty());
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
            .run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |event| {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push(event);
                    }
                },
            )
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
            .cancel(
                "codex",
                "build-session",
                dir.path(),
                AcpxCommandOptions::default(),
            )
            .await
            .unwrap();
        client
            .close_session(
                "codex",
                "build-session",
                dir.path(),
                AcpxCommandOptions::default(),
            )
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
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
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

    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_protocol_error_kills_spawned_process() {
        let dir = tempfile::TempDir::new().unwrap();
        let pid_path = dir.path().join("pid.txt");
        let script = write_mock_acpx_script(
            dir.path(),
            &format!(
                r#"#!/bin/bash
printf '%s' "$$" > "{}"
printf '%s\n' 'not-jsonrpc'
/bin/sleep 30
"#,
                pid_path.display()
            ),
        );

        let client = AcpxCli::new(script);
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client.run_prompt(
                "codex",
                "build-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |_| async {},
            ),
        )
        .await
        .expect("run_prompt should not hang after invalid stdout")
        .unwrap_err();

        assert!(matches!(error, AgentError::ResponseError { .. }));

        let pid: i32 = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if alive {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert!(
            !alive,
            "acpx child should be terminated after stdout protocol error"
        );
    }

    #[tokio::test]
    async fn prompt_stderr_lines_written_to_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
JSON
echo "stderr line 1" >&2
echo "stderr line 2" >&2
echo "stderr line 3" >&2
"#,
        );

        let client = AcpxCli::new(script);
        client
            .run_prompt(
                "codex",
                "test-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |_| async {},
            )
            .await
            .unwrap();

        // Give the background stderr task time to finish writing and flushing.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let stderr_path = dir
            .path()
            .join(".ensemble")
            .join("acpx-stderr-test-session.log");
        assert!(stderr_path.exists(), "stderr log file should exist");
        let content = std::fs::read_to_string(&stderr_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3, "should have 3 stderr lines");
        assert_eq!(lines[0], "stderr line 1");
        assert_eq!(lines[1], "stderr line 2");
        assert_eq!(lines[2], "stderr line 3");
    }

    #[tokio::test]
    async fn prompt_empty_stderr_produces_empty_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        client
            .run_prompt(
                "codex",
                "empty-session",
                dir.path(),
                "hi",
                AcpxCommandOptions::default(),
                PromptVisibility::Visible,
                |_| async {},
            )
            .await
            .unwrap();

        let stderr_path = dir
            .path()
            .join(".ensemble")
            .join("acpx-stderr-empty-session.log");
        // File may be absent or present; if present it must be 0 bytes.
        if stderr_path.exists() {
            let metadata = std::fs::metadata(&stderr_path).unwrap();
            assert_eq!(metadata.len(), 0, "stderr log should be 0 bytes");
        }
    }
}
