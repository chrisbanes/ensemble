use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::error::AgentError;
use crate::observability::events_contract::{
    elapsed_ms, ACPX_PROMPT_CANCELLED, ACPX_PROMPT_COMPLETED, ACPX_PROMPT_FAILED,
};

use super::acpx_cli::{AcpxCli, AcpxCommandOptions, AcpxPromptRequest, PromptVisibility};
use super::events::{AgentEvent, WorkerEvent, WorkerResult};
use super::{detect_worker_result_with_output, AgentRunRequest};

/// Agent runtime backed by the `acpx` CLI tool.
///
/// Each call to [`run_step`](AcpxRuntime::run_step) creates a fresh acpx
/// session scoped to the `(issue, step, attempt)` triple — different steps
/// never share a session and retries are isolated from prior state.
///
/// See `docs/superpowers/specs/2026-04-05-acpx-runtime-integration-design.md`
/// for the full session model rationale.
pub struct AcpxRuntime {
    cli: AcpxCli,
}

#[derive(Debug, Clone, Copy)]
struct RuntimePromptRequest<'a> {
    acpx_agent: &'a str,
    session_name: &'a str,
    prompt: &'a str,
    command_options: AcpxCommandOptions<'a>,
    visibility: PromptVisibility,
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

    /// Execute a single step attempt via acpx.
    ///
    /// Creates a one-shot session named `{issue_id}-{step}-attempt-{attempt}`,
    /// streams the prompt, and returns a [`WorkerResult`] containing the
    /// runtime verdict (if any). The session is closed before this method
    /// returns, regardless of success or failure.
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
        let command_options = AcpxCommandOptions {
            model: agent.model.as_deref(),
            reasoning_level: agent.reasoning_level.as_deref(),
        };
        self.cli
            .ensure_session(
                acpx_agent,
                &session_name,
                request.workspace_path,
                command_options,
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
        // Count prompt-streaming events only; SessionStarted is emitted
        // separately above and intentionally excluded from this count.
        let event_count = Arc::new(AtomicUsize::new(0));
        let prompt_start = std::time::Instant::now();
        let cb_count = event_count.clone();
        let prompt_result = self
            .run_prompt_with_cancellation(
                request,
                RuntimePromptRequest {
                    acpx_agent,
                    session_name: &session_name,
                    prompt,
                    command_options,
                    visibility: PromptVisibility::Visible,
                },
                |event| {
                    cb_count.fetch_add(1, Ordering::Relaxed);
                    emit_event(
                        &request.event_tx,
                        &request.issue.id,
                        request.step_name,
                        event,
                    )
                },
            )
            .await;

        let count = event_count.load(Ordering::Relaxed);
        let duration = elapsed_ms(prompt_start);

        let step_result = match prompt_result {
            Ok(visible_outcome) => {
                async {
                    info!(
                        event = ACPX_PROMPT_COMPLETED,
                        issue_id = %request.issue.id,
                        step = request.step_name,
                        session_name,
                        event_count = count,
                        duration_ms = duration,
                        "acpx prompt completed"
                    );

                    let extraction_prompt = crate::agent::extraction::build_extraction_prompt(
                        request.step_name,
                        &request.issue.identifier,
                        prompt,
                        &visible_outcome.output_text,
                    );
                    let extraction_outcome = self
                        .run_prompt_with_cancellation(
                            request,
                            RuntimePromptRequest {
                                acpx_agent,
                                session_name: &session_name,
                                prompt: &extraction_prompt,
                                command_options,
                                visibility: PromptVisibility::Hidden,
                            },
                            |_| async {},
                        )
                        .await?;
                    let output = match crate::agent::extraction::validate_extraction_payload(
                        extraction_outcome.runtime_verdict.as_ref(),
                        &extraction_outcome.output_text,
                    ) {
                        Ok(output) => output,
                        Err(error) => {
                            let previous_payload = extraction_outcome
                                .runtime_verdict
                                .as_ref()
                                .map(serde_json::Value::to_string)
                                .unwrap_or_else(|| extraction_outcome.output_text.clone());
                            let repair_prompt = crate::agent::extraction::build_repair_prompt(
                                &error.to_string(),
                                &previous_payload,
                            );
                            let repair_outcome = self
                                .run_prompt_with_cancellation(
                                    request,
                                    RuntimePromptRequest {
                                        acpx_agent,
                                        session_name: &session_name,
                                        prompt: &repair_prompt,
                                        command_options,
                                        visibility: PromptVisibility::Hidden,
                                    },
                                    |_| async {},
                                )
                                .await?;
                            crate::agent::extraction::validate_extraction_payload(
                                repair_outcome.runtime_verdict.as_ref(),
                                &repair_outcome.output_text,
                            )
                            .map_err(|error| {
                                AgentError::ResponseError {
                                    reason: format!("verdict extraction failed: {error}"),
                                }
                            })?
                        }
                    };

                    Ok(detect_worker_result_with_output(
                        request.workspace_path,
                        output,
                        request.step_name,
                    )
                    .await)
                }
                .await
            }
            Err(e) => {
                if matches!(e, AgentError::TurnCancelled) {
                    info!(
                        event = ACPX_PROMPT_CANCELLED,
                        issue_id = %request.issue.id,
                        step = request.step_name,
                        session_name,
                        event_count = count,
                        duration_ms = duration,
                        "acpx prompt cancelled"
                    );
                } else {
                    warn!(
                        event = ACPX_PROMPT_FAILED,
                        issue_id = %request.issue.id,
                        step = request.step_name,
                        session_name,
                        event_count = count,
                        duration_ms = duration,
                        error = %e,
                        "acpx prompt failed"
                    );
                }
                Err(e)
            }
        };

        close_session(
            &self.cli,
            acpx_agent,
            &session_name,
            request.workspace_path,
            command_options,
        )
        .await;

        step_result
    }

    async fn run_prompt_with_cancellation<F, Fut>(
        &self,
        request: &AgentRunRequest<'_>,
        prompt_request: RuntimePromptRequest<'_>,
        on_event: F,
    ) -> Result<super::acpx_cli::PromptOutcome, AgentError>
    where
        F: FnMut(AgentEvent) -> Fut,
        Fut: Future<Output = ()> + Send,
    {
        let run_prompt = self.cli.run_prompt(
            AcpxPromptRequest {
                agent: prompt_request.acpx_agent,
                session_name: prompt_request.session_name,
                cwd: request.workspace_path,
                prompt: prompt_request.prompt,
                options: prompt_request.command_options,
                visibility: prompt_request.visibility,
            },
            on_event,
        );
        tokio::pin!(run_prompt);

        tokio::select! {
            result = &mut run_prompt => result,
            _ = request.cancel_token.cancelled() => {
                debug!(
                    issue_id = %request.issue.id,
                    step = request.step_name,
                    prompt_request.session_name,
                    "cancelling acpx prompt"
                );
                self.cli
                    .cancel(
                        prompt_request.acpx_agent,
                        prompt_request.session_name,
                        request.workspace_path,
                        prompt_request.command_options,
                    )
                    .await?;

                if prompt_request.visibility == PromptVisibility::Visible {
                    emit_event(
                        &request.event_tx,
                        &request.issue.id,
                        request.step_name,
                        AgentEvent::Cancelled {
                            reason: Some("cancel requested".to_string()),
                        },
                    )
                    .await;
                }

                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run_prompt).await;

                Err(AgentError::TurnCancelled)
            }
        }
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
    options: AcpxCommandOptions<'_>,
) {
    debug!(session_name, "closing acpx session");
    // Session close is best-effort cleanup; orchestration should preserve the
    // primary run outcome even if acpx session teardown fails.
    if let Err(error) = cli
        .close_session(acpx_agent, session_name, workspace_path, options)
        .await
    {
        warn!(%error, session_name, "failed to close acpx session");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::agent::acpx_cli::AcpxCli;
    use crate::agent::events::RuntimeStream;
    use crate::agent::test_support::write_mock_acpx_script;
    use crate::config::ensemble::parse_config;
    use crate::config::ensemble::StepKind;
    use crate::pipeline::engine::StepOutputTemplateContext;
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
        let script_path = write_mock_acpx_script(
            workspace.path(),
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
  exit 0
  ;;
  *" prompt --session "*)
  prompt=$(cat)
  if [[ "$prompt" == Extract* ]]; then
    printf '%s\n' \
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"succeeded\",\"output\":{\"artifact\":\"typed\"}}"}}}}' \
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
  else
    printf '%s\n' \
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}' \
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
  fi
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
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
                && output.output == Some(serde_json::json!({"artifact": "typed"}))
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
    async fn acpx_runtime_repairs_invalid_hidden_extraction() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            workspace.path(),
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    prompt=$(cat)
    if [[ "$prompt" == Extract* ]]; then
      printf '%s\n' \
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"failed\"}"}}}}' \
        '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    elif [[ "$prompt" == "The previous Ensemble step result was invalid."* ]]; then
      printf '%s\n' \
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"concern\",\"summary\":\"needs follow-up\",\"output\":{\"fixed\":true}}"}}}}' \
        '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
    else
      printf '%s\n' \
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"visible"}}}}' \
        '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
    fi
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
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(
                output.result,
                crate::pipeline::verdict::StepResult::Concern { ref summary }
                    if summary == "needs follow-up"
            ) && output.output == Some(serde_json::json!({"fixed": true}))
        ));
    }

    #[tokio::test]
    async fn acpx_runtime_returns_response_error_when_repair_is_invalid_and_closes_session() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    prompt=$(cat)
    if [[ "$prompt" == Extract* || "$prompt" == "The previous Ensemble step result was invalid."* ]]; then
      printf '%s\n' \
        '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"failed\"}}"}}}}}}}}' \
        '{{"jsonrpc":"2.0","id":2,"result":{{"stopReason":"end_turn"}}}}'
    else
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"end_turn"}}}}'
    fi
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
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let error = runner
            .run_step(&request, "finish the task")
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            AgentError::ResponseError { reason } if reason.contains("verdict extraction failed")
        ));
        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("sessions close"));
    }

    #[tokio::test]
    async fn acpx_runtime_cancels_hidden_extraction_and_closes_session() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let extraction_started_path = workspace.path().join("extraction-started.flag");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    prompt=$(cat)
    if [[ "$prompt" == Extract* ]]; then
      : > "{}"
      while [ ! -f "{}/cancelled.flag" ]; do
        /bin/sleep 0.05
      done
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"stopReason":"cancelled"}}}}'
    else
      printf '%s\n' \
        '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"visible"}}}}}}}}' \
        '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"end_turn"}}}}'
    fi
    exit 0
    ;;
  *" cancel --session "*)
    : > "{}/cancelled.flag"
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display(),
                extraction_started_path.display(),
                workspace.path().display(),
                workspace.path().display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let cancel_token = CancellationToken::new();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: cancel_token.clone(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let canceller = tokio::spawn({
            let cancel_token = cancel_token.clone();
            let extraction_started_path = extraction_started_path.clone();
            async move {
                while !extraction_started_path.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                cancel_token.cancel();
            }
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run_step(&request, "finish the task"),
        )
        .await
        .expect("hidden extraction cancellation should not hang");
        canceller.await.unwrap();

        assert!(matches!(result, Err(AgentError::TurnCancelled)));
        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("cancel --session"));
        assert!(args.contains("sessions close"));
    }

    #[tokio::test]
    async fn acpx_runtime_cancels_hidden_repair_and_closes_session() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let repair_started_path = workspace.path().join("repair-started.flag");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    prompt=$(cat)
    if [[ "$prompt" == Extract* ]]; then
      printf '%s\n' \
        '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"failed\"}}"}}}}}}}}' \
        '{{"jsonrpc":"2.0","id":2,"result":{{"stopReason":"end_turn"}}}}'
    elif [[ "$prompt" == "The previous Ensemble step result was invalid."* ]]; then
      : > "{}"
      while [ ! -f "{}/cancelled.flag" ]; do
        /bin/sleep 0.05
      done
      printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"cancelled"}}}}'
    else
      printf '%s\n' \
        '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"visible"}}}}}}}}' \
        '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"end_turn"}}}}'
    fi
    exit 0
    ;;
  *" cancel --session "*)
    : > "{}/cancelled.flag"
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display(),
                repair_started_path.display(),
                workspace.path().display(),
                workspace.path().display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config();
        let cancel_token = CancellationToken::new();
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: cancel_token.clone(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let canceller = tokio::spawn({
            let cancel_token = cancel_token.clone();
            let repair_started_path = repair_started_path.clone();
            async move {
                while !repair_started_path.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                cancel_token.cancel();
            }
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run_step(&request, "finish the task"),
        )
        .await
        .expect("hidden repair cancellation should not hang");
        canceller.await.unwrap();

        assert!(matches!(result, Err(AgentError::TurnCancelled)));
        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("cancel --session"));
        assert!(args.contains("sessions close"));
    }

    #[tokio::test]
    async fn acpx_runtime_passes_reasoning_level_to_acpx_commands() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
  exit 0
  ;;
  *" prompt --session "*)
  cat > /dev/null
  printf '%s\n' \
    '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
    '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"end_turn"}}}}'
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
        let issue = test_issue("issue-1", "Todo");
        let config = Arc::new(
            parse_config(
                r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    model: gpt-5
    reasoning_level: high
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
        );
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        let ensure_args = args
            .lines()
            .find(|line| line.contains("sessions ensure"))
            .expect("sessions ensure command should be recorded");
        let prompt_args = args
            .lines()
            .find(|line| line.contains("prompt --session"))
            .expect("prompt command should be recorded");
        assert!(ensure_args.contains("--reasoning-level high"));
        assert!(prompt_args.contains("--reasoning-level high"));
    }

    #[tokio::test]
    async fn acpx_runtime_tolerates_close_session_failure() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            workspace.path(),
            r#"#!/usr/bin/env bash
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat >/dev/null
    printf '%s\n' \
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"succeeded\"}"}}}}' \
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
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
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let result = runner.run_step(&request, "finish the task").await.unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
        ));
    }

    #[tokio::test]
    async fn acpx_runtime_closes_session_when_prompt_errors() {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
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
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
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
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
    printf '%s\n' \
      '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
      '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
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
            step_kind: StepKind::Agent,
            attempt: Some(2),
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        let _ = runner.run_step(&request, "finish the task").await.unwrap();

        let args = std::fs::read_to_string(args_path).unwrap();
        assert!(args.contains("issue_1_weird-build_review-attempt-2"));
    }

    #[tokio::test]
    async fn acpx_runtime_cancels_prompt_when_token_is_cancelled() {
        let workspace = tempfile::TempDir::new().unwrap();
        let script_path = write_mock_acpx_script(
            workspace.path(),
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
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: cancel_token.clone(),
            step_outputs: StepOutputTemplateContext::default(),
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
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
    printf '%s\n' \
      '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
      '{{"jsonrpc":"2.0","id":4,"result":{{"stopReason":"end_turn"}}}}'
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
            step_kind: StepKind::Agent,
            attempt: Some(99),
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
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
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
    printf '%s\n' \
      '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
      '{{"jsonrpc":"2.0","id":100,"result":{{"stopReason":"end_turn"}}}}'
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
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
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
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
    printf '%s\n' \
      '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
      '{{"jsonrpc":"2.0","id":101,"result":{{"stopReason":"end_turn"}}}}'
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
            step_kind: StepKind::Agent,
            attempt: Some(1),
            timeout_ms: 100,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
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
