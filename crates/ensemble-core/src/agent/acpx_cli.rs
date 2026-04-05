use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, TokenUsage};

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
        let mut command = self.base_command(agent, cwd, model);
        command.args(["sessions", "ensure", "--name", session_name]);

        let status = command.status().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx sessions ensure: {e}"),
        })?;
        if !status.success() {
            return Err(AgentError::AcpxCommandFailed {
                command: "sessions ensure".to_string(),
                reason: status.to_string(),
            });
        }

        Ok(())
    }

    pub async fn run_prompt(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        prompt: &str,
        model: Option<&str>,
    ) -> Result<Vec<AgentEvent>, AgentError> {
        let mut command = self.base_command(agent, cwd, model);
        command
            .args(["prompt", "--session", session_name, "--file", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());

        let mut child = command.spawn().map_err(|e| AgentError::IoError {
            reason: format!("failed to run acpx prompt: {e}"),
        })?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| AgentError::IoError {
                    reason: format!("failed to write prompt to acpx stdin: {e}"),
                })?;
        }

        let stdout = child.stdout.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture acpx stdout".to_string(),
        })?;
        let mut reader = BufReader::new(stdout).lines();
        let mut events = Vec::new();
        let mut saw_terminal_event = false;

        while let Some(line) = reader.next_line().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to read acpx stdout: {e}"),
        })? {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => {
                    let event = map_event(value);
                    if matches!(
                        event,
                        AgentEvent::RunCompleted { .. }
                            | AgentEvent::RunFailed { .. }
                            | AgentEvent::Cancelled { .. }
                    ) {
                        saw_terminal_event = true;
                    }
                    events.push(event);
                }
                Err(_) => events.push(AgentEvent::Malformed { line }),
            }
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

        Ok(events)
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
        command
            .args(["--format", "json", "--json-strict", "--cwd"])
            .arg(cwd)
            .arg(agent);
        if let Some(model) = model {
            command.args(["--model", model]);
        }
        command
    }
}

fn map_event(value: serde_json::Value) -> AgentEvent {
    match value.get("event").and_then(|v| v.as_str()) {
        Some("prompt.started") => AgentEvent::PromptStarted,
        Some("output") => AgentEvent::OutputChunk {
            stream: match value.get("stream").and_then(|v| v.as_str()) {
                Some("stderr") => RuntimeStream::Stderr,
                _ => RuntimeStream::Stdout,
            },
            content: value
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        },
        Some("completed") => AgentEvent::RunCompleted {
            usage: value
                .get("usage")
                .cloned()
                .and_then(|usage| serde_json::from_value::<TokenUsage>(usage).ok()),
        },
        Some("failed") => AgentEvent::RunFailed {
            reason: value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("acpx run failed")
                .to_string(),
            usage: None,
        },
        Some("cancelled") => AgentEvent::Cancelled {
            reason: value
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        },
        Some("warning") => AgentEvent::Warning {
            message: value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        },
        _ => AgentEvent::OtherMessage {
            raw: value.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;

    use crate::agent::events::AgentEvent;
    use crate::error::AgentError;

    use super::AcpxCli;

    fn write_mock_acpx_script(dir: &Path, script_content: &str) -> String {
        let script_path = dir.join("mock_acpx.sh");
        let mut file = std::fs::File::create(&script_path).unwrap();
        file.write_all(script_content.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
                .unwrap();
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
    async fn prompt_stream_maps_output_and_completion_events() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"event":"prompt.started","session":"s1"}
{"event":"output","stream":"stdout","text":"hello"}
{"event":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let events = client
            .run_prompt("codex", "build-session", dir.path(), "hi", None)
            .await
            .unwrap();

        assert!(matches!(events[0], AgentEvent::PromptStarted));
        assert!(matches!(events[1], AgentEvent::OutputChunk { .. }));
        assert!(matches!(events[2], AgentEvent::RunCompleted { .. }));
    }

    #[tokio::test]
    async fn prompt_without_terminal_event_returns_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"event":"prompt.started","session":"s1"}
{"event":"output","stream":"stdout","text":"hello"}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        let error = client
            .run_prompt("codex", "build-session", dir.path(), "hi", None)
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            AgentError::AcpxFinalStatusMissing { .. }
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
}
