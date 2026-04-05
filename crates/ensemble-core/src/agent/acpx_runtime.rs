use tokio::sync::mpsc;

use crate::error::AgentError;

use super::acpx_cli::AcpxCli;
use super::events::{AgentEvent, WorkerEvent, WorkerResult};
use super::{detect_worker_result, AgentRunRequest};

pub struct AcpxRuntime {
    cli: AcpxCli,
}

impl AcpxRuntime {
    pub fn new() -> Self {
        #[cfg(test)]
        if let Ok(executable) = std::env::var("ENSEMBLE_TEST_ACPX_EXECUTABLE") {
            return Self {
                cli: AcpxCli::new(executable),
            };
        }

        Self {
            cli: AcpxCli::new("acpx".to_string()),
        }
    }

    #[cfg(test)]
    pub fn with_cli(cli: AcpxCli) -> Self {
        Self { cli }
    }

    pub async fn run_step(
        &self,
        request: &AgentRunRequest<'_>,
        prompt: &str,
    ) -> Result<WorkerResult, AgentError> {
        let agent = request
            .config
            .agents
            .get(request.agent_name)
            .ok_or_else(|| AgentError::PromptError {
                reason: format!("agent '{}' not found in config", request.agent_name),
            })?;
        let acpx_agent = agent
            .acpx_agent
            .as_deref()
            .ok_or_else(|| AgentError::PromptError {
                reason: format!("agent '{}' is missing acpx_agent", request.agent_name),
            })?;
        let session_name = format!(
            "{}-{}-attempt-{}",
            request.issue.id,
            request.step_name,
            request.attempt.unwrap_or(1)
        );

        self.cli
            .ensure_session(
                acpx_agent,
                &session_name,
                request.workspace_path,
                agent.model.as_deref(),
            )
            .await?;

        emit_event(
            &request.event_tx,
            &request.issue.id,
            request.step_name,
            AgentEvent::SessionStarted {
                session_id: session_name.clone(),
                agent_pid: None,
            },
        )
        .await;

        let events = self
            .cli
            .run_prompt(
                acpx_agent,
                &session_name,
                request.workspace_path,
                prompt,
                agent.model.as_deref(),
            )
            .await?;

        for event in events {
            emit_event(
                &request.event_tx,
                &request.issue.id,
                request.step_name,
                event,
            )
            .await;
        }

        let _ = self
            .cli
            .close_session(
                acpx_agent,
                &session_name,
                request.workspace_path,
                agent.model.as_deref(),
            )
            .await;

        Ok(detect_worker_result(request.workspace_path).await)
    }
}

impl Default for AcpxRuntime {
    fn default() -> Self {
        Self::new()
    }
}

async fn emit_event(
    tx: &mpsc::Sender<WorkerEvent>,
    issue_id: &str,
    step_name: &str,
    event: AgentEvent,
) {
    let _ = tx
        .send(WorkerEvent::AgentUpdate {
            issue_id: issue_id.to_string(),
            step_name: step_name.to_string(),
            event,
            timestamp: chrono::Utc::now(),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::agent::acpx_cli::AcpxCli;
    use crate::agent::events::RuntimeStream;
    use crate::config::ensemble::parse_config;
    use crate::tracker::model::test_helpers::test_issue;

    fn test_config() -> Arc<crate::config::ensemble::EnsembleConfig> {
        Arc::new(
            parse_config(
                r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
steps:
  - name: build
    agent: builder
workspace:
  root: /tmp/test
on_success: Done
on_failure: Failed
"#,
            )
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn acpx_runtime_emits_runtime_events_and_success() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = workspace.path().join("mock_acpx.sh");
        std::fs::write(
            &script_path,
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
  exit 0
  ;;
  *" prompt --session "*)
  cat <<'JSON'
{"event":"prompt.started","session":"s1"}
{"event":"output","stream":"stdout","text":"hello"}
{"event":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}
JSON
  exit 0
  ;;
  *" sessions close "*)
  exit 0
  ;;
esac
exit 1
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path.display().to_string()));
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config: Arc::clone(&config),
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            attempt: None,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(result, WorkerResult::Success));
        let mut saw_prompt_started = false;
        let mut saw_output = false;
        while let Ok(event) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate { event, .. } = event {
                match event {
                    AgentEvent::PromptStarted => saw_prompt_started = true,
                    AgentEvent::OutputChunk {
                        stream: RuntimeStream::Stdout,
                        content,
                    } if content == "hello" => saw_output = true,
                    _ => {}
                }
            }
        }
        assert!(saw_prompt_started);
        assert!(saw_output);
    }
}
