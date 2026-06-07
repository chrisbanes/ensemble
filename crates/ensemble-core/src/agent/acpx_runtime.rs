use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::error::AgentError;

use super::acpx_cli::AcpxCli;
use super::events::{AgentEvent, WorkerEvent, WorkerResult};
use super::{detect_worker_result_with_runtime_verdict, AgentRunRequest};

pub struct AcpxRuntime {
    cli: AcpxCli,
}

impl AcpxRuntime {
    pub fn new() -> Self {
        #[cfg(test)]
        if let Some(executable) = test_acpx_executable() {
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
        const MAX_SESSION_NAME_LEN: usize = 128;

        let id_comp = sanitize_session_component(&request.issue.id);
        let step_comp = sanitize_session_component(request.step_name);
        let attempt = request.attempt.unwrap_or(1);

        // Build the core (id + step) and suffix separately. If the total
        // exceeds the cap, hash the full core and append the digest so
        // distinct long values that share a truncated prefix still produce
        // unique session names.
        let core = format!("{}-{}", id_comp, step_comp);
        let suffix = format!("-attempt-{}", attempt);
        let total_len = core.len() + suffix.len();

        let session_name = if total_len > MAX_SESSION_NAME_LEN {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};

            let mut hasher = DefaultHasher::new();
            core.hash(&mut hasher);
            let digest = format!("{:x}", hasher.finish());
            let short_digest = &digest[..8];

            let prefix_len = MAX_SESSION_NAME_LEN
                .saturating_sub(suffix.len())
                .saturating_sub(short_digest.len() + 1);
            let mut result = core[..prefix_len].to_string();
            result.push('-');
            result.push_str(short_digest);
            result.push_str(&suffix);
            result
        } else {
            format!("{}{}", core, suffix)
        };

        debug!(
            issue_id = %request.issue.id,
            step = request.step_name,
            agent_name = request.agent_name,
            acpx_agent,
            model = agent.model.as_deref(),
            session_name,
            "ensuring acpx session"
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

        debug!(
            issue_id = %request.issue.id,
            step = request.step_name,
            session_name,
            "starting acpx prompt"
        );
        let run_prompt = self.cli.run_prompt(
            acpx_agent,
            &session_name,
            request.workspace_path,
            prompt,
            agent.model.as_deref(),
            |event| {
                emit_event(
                    &request.event_tx,
                    &request.issue.id,
                    request.step_name,
                    event,
                )
            },
        );
        tokio::pin!(run_prompt);

        let prompt_result = tokio::select! {
            result = &mut run_prompt => result,
            _ = request.cancel_token.cancelled() => {
                debug!(
                    issue_id = %request.issue.id,
                    step = request.step_name,
                    session_name,
                    "cancelling acpx prompt"
                );
                self.cli
                    .cancel(
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
                    AgentEvent::Cancelled {
                        reason: Some("cancel requested".to_string()),
                    },
                )
                .await;

                // Wait for the prompt process to exit after cancellation, with a timeout
                // to prevent hanging if acpx fails to exit gracefully.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run_prompt).await;

                close_session(
                    &self.cli,
                    acpx_agent,
                    &session_name,
                    request.workspace_path,
                    agent.model.as_deref(),
                )
                .await;
                return Err(AgentError::TurnCancelled);
            }
        };

        close_session(
            &self.cli,
            acpx_agent,
            &session_name,
            request.workspace_path,
            agent.model.as_deref(),
        )
        .await;

        let prompt_outcome = prompt_result?;

        Ok(detect_worker_result_with_runtime_verdict(
            request.workspace_path,
            prompt_outcome.runtime_verdict,
        )
        .await)
    }
}

impl Default for AcpxRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
fn test_acpx_executable() -> Option<String> {
    std::env::var("ENSEMBLE_TEST_ACPX_EXECUTABLE")
        .ok()
        .or_else(|| std::env::var("ENSEMBLE_TEST_ACPX_BIN").ok())
}

const MAX_COMPONENT_LEN: usize = 64;
const FALLBACK_COMPONENT: &str = "unknown";

fn sanitize_session_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        return FALLBACK_COMPONENT.to_string();
    }

    if trimmed.len() > MAX_COMPONENT_LEN {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        trimmed.hash(&mut hasher);
        let digest = format!("{:x}", hasher.finish());
        let short_digest = &digest[..8];

        let prefix_len = MAX_COMPONENT_LEN.saturating_sub(short_digest.len() + 1);
        let mut result = trimmed[..prefix_len].to_string();
        result.push('-');
        result.push_str(short_digest);
        result
    } else {
        trimmed.to_string()
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

async fn close_session(
    cli: &AcpxCli,
    acpx_agent: &str,
    session_name: &str,
    workspace_path: &std::path::Path,
    model: Option<&str>,
) {
    debug!(session_name, "closing acpx session");
    // Session close is best-effort cleanup; orchestration should preserve the
    // primary run outcome even if acpx session teardown fails.
    if let Err(error) = cli
        .close_session(acpx_agent, session_name, workspace_path, model)
        .await
    {
        warn!(%error, session_name, "failed to close acpx session");
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

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

    fn write_mock_acpx_script(dir: &tempfile::TempDir, script_content: &str) -> String {
        let script_path = dir.path().join("mock_acpx.sh");
        let mut file = std::fs::File::create(&script_path).unwrap();
        let script_content = script_content.replacen("#!/usr/bin/env bash", "#!/bin/bash", 1);
        file.write_all(script_content.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script_path.display().to_string()
    }

    #[tokio::test]
    async fn acpx_runtime_emits_runtime_events_and_success() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            &workspace,
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
  exit 0
  ;;
  *" prompt --session "*)
  printf '%s\n' \
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}' \
    '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
  exit 0
  ;;
  *" sessions close "*)
  exit 0
  ;;
esac
exit 1
"#,
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
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
            cancel_token: CancellationToken::new(),
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                runtime_verdict: None,
                ..
            }
        ));
        let mut saw_output = false;
        while let Ok(event) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate { event, .. } = event {
                match event {
                    AgentEvent::OutputChunk {
                        stream: RuntimeStream::Stdout,
                        content,
                    } if content == "hello" => saw_output = true,
                    _ => {}
                }
            }
        }
        assert!(saw_output);
    }

    #[tokio::test]
    async fn acpx_runtime_tolerates_close_session_failure() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            &workspace,
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat >/dev/null
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 1
    ;;
esac
exit 1
"#,
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            attempt: None,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                runtime_verdict: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn acpx_runtime_closes_session_when_prompt_errors() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    exit 1
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            attempt: None,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let error = runner
            .run_step(&request, "finish the task")
            .await
            .unwrap_err();
        assert!(matches!(error, AgentError::AcpxCommandFailed { .. }));

        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("sessions close"));
    }

    #[tokio::test]
    async fn acpx_runtime_sanitizes_session_names() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue/1 weird", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build/review",
            attempt: Some(2),
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let _ = runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("issue_1_weird-build_review-attempt-2"));
    }

    #[tokio::test]
    async fn acpx_runtime_cancels_prompt_when_token_is_cancelled() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"running"}}}}}}}}'
    while [ ! -f "{0}/cancelled.flag" ]; do
      /bin/sleep 0.05
    done
    printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{"stopReason":"cancelled"}}}}'
    exit 0
    ;;
  *" cancel --session "*)
    : > "{0}/cancelled.flag"
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                workspace.path().display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let cancel_token = CancellationToken::new();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            attempt: None,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: cancel_token.clone(),
        };

        let canceller = tokio::spawn({
            let cancel_token = cancel_token.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                cancel_token.cancel();
            }
        });

        let result = runner.run_step(&request, "finish the task").await;
        canceller.await.unwrap();
        assert!(matches!(result, Err(AgentError::TurnCancelled)));

        let mut saw_cancelled = false;
        while let Ok(event) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate {
                event: AgentEvent::Cancelled { .. },
                ..
            } = event
            {
                saw_cancelled = true;
            }
        }

        assert!(saw_cancelled);
        assert!(workspace.path().join("cancelled.flag").exists());
    }

    #[test]
    fn sanitize_session_component_truncates_to_max_length() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let long = "a".repeat(500);
        let result = sanitize_session_component(&long);
        assert_eq!(result.len(), 64);
        assert!(result.starts_with("aaaaaaaa"));

        let mut hasher = DefaultHasher::new();
        long.hash(&mut hasher);
        let digest = format!("{:x}", hasher.finish());
        let short_digest = &digest[..8];
        let prefix_len = 64_usize.saturating_sub(short_digest.len() + 1);
        let expected = format!("{}-{}", "a".repeat(prefix_len), short_digest);
        assert_eq!(result, expected);
    }

    #[test]
    fn sanitize_session_component_replaces_all_invalid_with_unknown() {
        let result = sanitize_session_component("!!!");
        assert_eq!(result, "unknown");
    }

    #[test]
    fn sanitize_session_component_handles_long_invalid_input() {
        let input = "!@#$%".repeat(200);
        let result = sanitize_session_component(&input);
        assert_eq!(result, "unknown");
    }

    #[tokio::test]
    async fn acpx_runtime_truncates_total_session_name_length() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{"stopReason":"end_turn"}}}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let long_id = "a".repeat(500);
        let long_step = "b".repeat(500);
        let issue = test_issue(&long_id, "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: &long_step,
            attempt: Some(99),
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let _ = runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let session_name = args
            .lines()
            .find(|l| l.contains("sessions ensure --name"))
            .and_then(|l| l.split("sessions ensure --name ").nth(1))
            .map(|s| s.split_whitespace().next().unwrap_or(s))
            .expect("session name should be in args");

        assert!(
            session_name.len() <= 128,
            "session name '{}' length {} exceeds 128",
            session_name,
            session_name.len()
        );
        assert!(
            session_name.ends_with("-attempt-99"),
            "session name '{}' does not end with -attempt-99",
            session_name
        );
    }

    #[tokio::test]
    async fn acpx_runtime_handles_mostly_invalid_issue_id_and_step_name() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    printf '%s\n' '{{"jsonrpc":"2.0","id":100,"result":{{"stopReason":"end_turn"}}}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("!@#", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "$%^",
            attempt: None,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let _ = runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let session_name = args
            .lines()
            .find(|l| l.contains("sessions ensure --name"))
            .and_then(|l| l.split("sessions ensure --name ").nth(1))
            .map(|s| s.split_whitespace().next().unwrap_or(s))
            .expect("session name should be in args");

        assert_eq!(session_name, "unknown-unknown-attempt-1");
    }

    #[tokio::test]
    async fn acpx_runtime_handles_extremely_long_all_invalid_inputs() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            &workspace,
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    printf '%s\n' '{{"jsonrpc":"2.0","id":101,"result":{{"stopReason":"end_turn"}}}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let bad_chars = "!@#$%".repeat(300);
        let issue = test_issue(&bad_chars, "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: &bad_chars,
            attempt: Some(1),
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
        };

        let _ = runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let session_name = args
            .lines()
            .find(|l| l.contains("sessions ensure --name"))
            .and_then(|l| l.split("sessions ensure --name ").nth(1))
            .map(|s| s.split_whitespace().next().unwrap_or(s))
            .expect("session name should be in args");

        assert_eq!(session_name, "unknown-unknown-attempt-1");
        assert!(
            session_name.len() <= 128,
            "session name length {} exceeds 128",
            session_name.len()
        );
    }
}
