use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use agent_client_protocol::schema::{
    ContentBlock, InitializeRequest, PermissionOption, PermissionOptionKind, ProtocolVersion,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
    SetSessionModeRequest, StopReason as SdkStopReason,
};
use agent_client_protocol::{AcpAgent, Client, Dispatch, SessionMessage};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, TokenUsage, WorkerEvent};

#[derive(Debug)]
pub struct AcpSessionConfig {
    pub command: String,
    pub workspace_path: PathBuf,
    pub session_mode: Option<String>,
    pub permission_request_policy: String,
    pub read_timeout_ms: u64,
    pub turn_timeout_ms: u64,
}

#[derive(Clone, Debug)]
pub enum TurnResult {
    Completed {
        usage: Option<TokenUsage>,
        runtime_verdict: Option<serde_json::Value>,
    },
    Failed {
        reason: String,
        usage: Option<TokenUsage>,
        runtime_verdict: Option<serde_json::Value>,
    },
}

impl TurnResult {
    pub fn is_success(&self) -> bool {
        matches!(self, TurnResult::Completed { .. })
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

fn resolve_permission(permission_request_policy: &str, description: &str) -> bool {
    match permission_request_policy {
        "auto_approve_all" => true,
        "reject_all" => false,
        "approve_reads_reject_writes" => {
            let desc_lower = description.to_lowercase();
            desc_lower.contains("read")
                || desc_lower.contains("list")
                || desc_lower.contains("view")
        }
        _ => true,
    }
}

fn select_permission_option<'a>(
    permission_request_policy: &str,
    description: &str,
    options: &'a [PermissionOption],
) -> Option<&'a PermissionOption> {
    if !resolve_permission(permission_request_policy, description) {
        return None;
    }

    options
        .iter()
        .find(|option| matches!(option.kind, PermissionOptionKind::AllowOnce))
        .or_else(|| {
            options
                .iter()
                .find(|option| matches!(option.kind, PermissionOptionKind::AllowAlways))
        })
}

fn shell_escape(arg: &str) -> String {
    let mut escaped = String::with_capacity(arg.len() + 2);
    escaped.push('\'');
    for ch in arg.chars() {
        if ch == '\'' {
            escaped.push_str("'\\''");
        } else {
            escaped.push(ch);
        }
    }
    escaped.push('\'');
    escaped
}

fn sdk_transport_command(command: &str, workspace_path: &Path) -> String {
    let cwd = workspace_path.to_string_lossy();
    let script = format!("echo $$ >&2; cd {}; exec {}", shell_escape(&cwd), command);
    format!("bash -lc {}", shell_escape(&script))
}

fn token_usage_from_value(value: serde_json::Value) -> Option<TokenUsage> {
    #[derive(serde::Deserialize)]
    struct CamelUsage {
        #[serde(default, alias = "input_tokens", alias = "inputTokens")]
        input_tokens: u64,
        #[serde(default, alias = "output_tokens", alias = "outputTokens")]
        output_tokens: u64,
        #[serde(default, alias = "total_tokens", alias = "totalTokens", alias = "used")]
        total_tokens: u64,
    }

    serde_json::from_value::<CamelUsage>(value)
        .ok()
        .map(|u| TokenUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            total_tokens: u.total_tokens,
        })
}

fn text_from_content(content: &ContentBlock) -> Option<String> {
    match content {
        ContentBlock::Text(text) => Some(text.text.clone()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

#[derive(Debug, Default)]
struct ParsedSdkDispatch {
    output_text: Option<String>,
    usage: Option<TokenUsage>,
    verdict: Option<serde_json::Value>,
}

fn parse_session_notification(notification: SessionNotification) -> ParsedSdkDispatch {
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => ParsedSdkDispatch {
            output_text: text_from_content(&chunk.content),
            ..ParsedSdkDispatch::default()
        },
        update => {
            let value = serde_json::to_value(update).ok();
            ParsedSdkDispatch {
                usage: value
                    .as_ref()
                    .and_then(|v| v.get("usage").cloned())
                    .or_else(|| value.clone())
                    .and_then(token_usage_from_value),
                verdict: value.as_ref().and_then(|v| v.get("verdict").cloned()),
                output_text: None,
            }
        }
    }
}

async fn parse_sdk_dispatch(dispatch: Dispatch) -> Result<Option<ParsedSdkDispatch>, AgentError> {
    let mut parsed: Option<ParsedSdkDispatch> = None;
    agent_client_protocol::util::MatchDispatch::new(dispatch)
        .if_notification(async |notification: SessionNotification| {
            parsed = Some(parse_session_notification(notification));
            Ok(())
        })
        .await
        .otherwise_ignore()
        .map_err(|e| AgentError::IoError {
            reason: format!("failed to parse session update: {e}"),
        })?;

    Ok(parsed)
}

fn map_sdk_stop_reason(stop: &SdkStopReason) -> super::events::StopReason {
    match stop {
        SdkStopReason::EndTurn => super::events::StopReason::EndTurn,
        SdkStopReason::MaxTokens => super::events::StopReason::MaxTokens,
        SdkStopReason::Cancelled => super::events::StopReason::Cancelled,
        SdkStopReason::Refusal => super::events::StopReason::Refusal,
        SdkStopReason::MaxTurnRequests => super::events::StopReason::MaxTurnRequests,
        _ => super::events::StopReason::Cancelled,
    }
}

pub async fn run_acp_session(
    config: AcpSessionConfig,
    prompts: Vec<String>,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<(Option<serde_json::Value>, Vec<TurnResult>), AgentError> {
    let transport_command = sdk_transport_command(&config.command, &config.workspace_path);
    let agent_pid: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let agent_pid_for_debug = agent_pid.clone();
    let agent = AcpAgent::from_str(&transport_command).map_err(|e| AgentError::AgentNotFound {
        command: format!("{}: {}", config.command, e),
    })?;
    let agent = agent.with_debug(move |line, direction| {
        if matches!(direction, agent_client_protocol::LineDirection::Stderr)
            && line.chars().all(|c| c.is_ascii_digit())
        {
            if let Ok(mut guard) = agent_pid_for_debug.try_lock() {
                if guard.is_none() {
                    *guard = Some(line.to_string());
                }
            }
        }
    });

    let permission_policy = config.permission_request_policy.clone();
    let issue_id_owned = issue_id.to_string();
    let step_name_owned = step_name.to_string();
    let event_tx_clone = event_tx.clone();

    let turn_results: Arc<Mutex<Vec<TurnResult>>> = Arc::new(Mutex::new(Vec::new()));
    let final_verdict: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let session_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let prompts = Arc::new(prompts);
    let session_mode = config.session_mode.clone();
    let turn_timeout_ms = config.turn_timeout_ms;
    let workspace_path = config.workspace_path.clone();

    let turn_results_inner = turn_results.clone();
    let final_verdict_inner = final_verdict.clone();
    let session_error_inner = session_error.clone();
    let session_error_outer = session_error.clone();

    let builder = Client.builder().name("ensemble").on_receive_request(
        async move |request: RequestPermissionRequest,
                    responder: agent_client_protocol::Responder<RequestPermissionResponse>,
                    _cx| {
            let description = serde_json::to_string(&request.tool_call).unwrap_or_default();

            emit_event(
                &event_tx_clone,
                &issue_id_owned,
                &step_name_owned,
                AgentEvent::Warning {
                    message: format!("permission requested: {description}"),
                },
            )
            .await;

            let selected_option =
                select_permission_option(&permission_policy, &description, &request.options);
            let allowed = selected_option.is_some();

            let outcome = if let Some(option) = selected_option {
                let option_id: agent_client_protocol::schema::PermissionOptionId =
                    option.option_id.clone();
                agent_client_protocol::schema::RequestPermissionOutcome::Selected(
                    agent_client_protocol::schema::SelectedPermissionOutcome::new(option_id),
                )
            } else {
                agent_client_protocol::schema::RequestPermissionOutcome::Cancelled
            };

            let response = RequestPermissionResponse::new(outcome);

            emit_event(
                &event_tx_clone,
                &issue_id_owned,
                &step_name_owned,
                AgentEvent::Notification {
                    message: format!(
                        "permission {}",
                        if allowed { "approved" } else { "rejected" }
                    ),
                },
            )
            .await;

            responder.respond(response)
        },
        agent_client_protocol::on_receive_request!(),
    );

    let result = builder
        .connect_with(agent, async move |cx| {
            if let Err(e) = cx
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await
            {
                let mut err = session_error_inner.lock().await;
                *err = Some(format!("initialize failed: {e}"));
                return Ok(());
            }

            let session_builder = cx.build_session(&workspace_path);

            if let Err(e) = session_builder
                .block_task()
                .run_until(async |mut session| {
                    let session_id = session.session_id().to_string();

                    emit_event(
                        event_tx,
                        issue_id,
                        step_name,
                        AgentEvent::SessionStarted {
                            session_id: session_id.clone(),
                            agent_pid: agent_pid.lock().await.clone(),
                        },
                    )
                    .await;

                    if let Some(ref mode) = session_mode {
                        if !mode.is_empty() {
                            if let Err(e) = session
                                .connection()
                                .send_request(SetSessionModeRequest::new(
                                    session.session_id().clone(),
                                    mode.clone(),
                                ))
                                .block_task()
                                .await
                            {
                                let mut err = session_error_inner.lock().await;
                                *err = Some(format!("set_mode failed: {e}"));
                                return Ok(());
                            }
                            debug!(session_id = %session_id, mode = %mode, "session mode set");
                        }
                    }

                    for (i, prompt) in prompts.iter().enumerate() {
                        emit_event(event_tx, issue_id, step_name, AgentEvent::PromptStarted).await;

                        if let Err(e) = session.send_prompt(prompt) {
                            let mut err = session_error_inner.lock().await;
                            *err = Some(format!("send_prompt failed: {e}"));
                            return Ok(());
                        }

                        let mut last_usage: Option<TokenUsage> = None;
                        let mut last_runtime_verdict: Option<serde_json::Value> = None;
                        let mut timed_out = false;

                        let turn_future = async {
                            loop {
                                match session.read_update().await {
                                    Ok(SessionMessage::StopReason(stop)) => {
                                        let mapped = map_sdk_stop_reason(&stop);
                                        return Ok((mapped, last_usage, last_runtime_verdict));
                                    }
                                    Ok(SessionMessage::SessionMessage(dispatch)) => {
                                        if let Some(parsed) = parse_sdk_dispatch(dispatch)
                                            .await
                                            .map_err(|e| e.to_string())?
                                        {
                                            if let Some(usage) = parsed.usage {
                                                last_usage = Some(usage);
                                            }
                                            if let Some(verdict) = parsed.verdict {
                                                last_runtime_verdict = Some(verdict);
                                            }
                                            if let Some(content) = parsed.output_text {
                                                emit_event(
                                                    event_tx,
                                                    issue_id,
                                                    step_name,
                                                    AgentEvent::OutputChunk {
                                                        stream: RuntimeStream::Stdout,
                                                        content,
                                                    },
                                                )
                                                .await;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        return Err(format!("read_update failed: {e}"));
                                    }
                                    Ok(_) => {}
                                }
                            }
                        };

                        let turn_result = tokio::time::timeout(
                            std::time::Duration::from_millis(turn_timeout_ms),
                            turn_future,
                        )
                        .await;

                        let turn_result = match turn_result {
                            Ok(Ok((stop_reason, usage, verdict))) => match stop_reason {
                                super::events::StopReason::EndTurn
                                | super::events::StopReason::MaxTokens => {
                                    emit_event(
                                        event_tx,
                                        issue_id,
                                        step_name,
                                        AgentEvent::RunCompleted {
                                            usage: usage.clone(),
                                        },
                                    )
                                    .await;
                                    TurnResult::Completed {
                                        usage,
                                        runtime_verdict: verdict,
                                    }
                                }
                                _ => {
                                    let reason = format!("stop reason: {:?}", stop_reason);
                                    emit_event(
                                        event_tx,
                                        issue_id,
                                        step_name,
                                        AgentEvent::RunFailed {
                                            reason: reason.clone(),
                                            usage: usage.clone(),
                                        },
                                    )
                                    .await;
                                    TurnResult::Failed {
                                        reason,
                                        usage,
                                        runtime_verdict: verdict,
                                    }
                                }
                            },
                            Ok(Err(e)) => {
                                let mut err = session_error_inner.lock().await;
                                *err = Some(e);
                                return Ok(());
                            }
                            Err(_) => {
                                timed_out = true;
                                TurnResult::Failed {
                                    reason: format!("turn timeout after {turn_timeout_ms}ms"),
                                    usage: None,
                                    runtime_verdict: None,
                                }
                            }
                        };

                        if let TurnResult::Completed {
                            ref runtime_verdict,
                            ..
                        } = turn_result
                        {
                            if runtime_verdict.is_some() {
                                let mut v = final_verdict_inner.lock().await;
                                *v = runtime_verdict.clone();
                            }
                        }

                        if let TurnResult::Failed { ref reason, .. } = turn_result {
                            if timed_out {
                                let mut err = session_error_inner.lock().await;
                                *err = Some(reason.clone());
                                turn_results_inner.lock().await.push(turn_result);
                                return Ok(());
                            }
                            if i < prompts.len() - 1 {
                                warn!(
                                    issue_id = %issue_id,
                                    step = step_name,
                                    turn = i + 1,
                                    reason = %reason,
                                    "turn failed, stopping remaining turns"
                                );
                                turn_results_inner.lock().await.push(turn_result);
                                return Ok(());
                            }
                        }

                        info!(
                            issue_id = %issue_id,
                            step = step_name,
                            turn = i + 1,
                            "turn completed successfully"
                        );
                        turn_results_inner.lock().await.push(turn_result);
                    }

                    Ok(())
                })
                .await
            {
                let mut err = session_error_inner.lock().await;
                if err.is_none() {
                    *err = Some(format!("session error: {e}"));
                }
            }

            Ok(())
        })
        .await;

    if let Err(e) = result {
        let error_msg = e.to_string();
        let captured = session_error_outer.lock().await.clone();
        let msg = captured.unwrap_or(error_msg);
        if msg.contains("timeout") || msg.contains("TimedOut") {
            return Err(AgentError::TurnTimeout {
                timeout_ms: turn_timeout_ms,
            });
        }
        return Err(AgentError::IoError { reason: msg });
    }

    let captured_error = session_error_outer.lock().await.clone();
    if let Some(error_msg) = captured_error {
        if error_msg.contains("timeout") || error_msg.contains("TimedOut") {
            return Err(AgentError::TurnTimeout {
                timeout_ms: turn_timeout_ms,
            });
        } else if error_msg.contains("initialize") || error_msg.contains("session") {
            return Err(AgentError::SessionStartupFailed { reason: error_msg });
        } else {
            return Err(AgentError::IoError { reason: error_msg });
        }
    }

    let verdict = final_verdict.lock().await.take();
    let results = turn_results.lock().await.clone();
    Ok((verdict, results))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use agent_client_protocol::schema::{
        ContentBlock, ContentChunk, PermissionOption, PermissionOptionKind, SessionNotification,
        SessionUpdate, TextContent, UsageUpdate,
    };

    use super::*;

    #[test]
    fn sdk_transport_command_runs_original_command_from_workspace_and_prints_pid() {
        let command = "acpx --agent 'builder'";
        let wrapped = sdk_transport_command(command, Path::new("/tmp/work space"));

        assert!(wrapped.starts_with("bash -lc "));
        assert!(wrapped.contains("echo $$ >&2"));
        assert!(wrapped.contains("/tmp/work space"));
        assert!(wrapped.contains("exec acpx --agent"));
        assert!(wrapped.contains("builder"));
    }

    #[test]
    fn select_permission_option_prefers_allow_once_over_first_option() {
        let options = vec![
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
        ];

        let selected = select_permission_option("auto_approve_all", "write file", &options);

        assert_eq!(
            selected.map(|option| option.option_id.to_string()),
            Some("allow".to_string())
        );
    }

    #[test]
    fn select_permission_option_rejects_when_policy_denies_request() {
        let options = vec![PermissionOption::new(
            "allow",
            "Allow",
            PermissionOptionKind::AllowOnce,
        )];

        let selected = select_permission_option("reject_all", "read file", &options);

        assert!(selected.is_none());
    }

    #[test]
    fn parse_session_notification_extracts_agent_message_text() {
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("hello"),
            ))),
        );

        let parsed = parse_session_notification(notification);

        assert_eq!(parsed.output_text.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_session_notification_maps_usage_update_to_total_tokens() {
        let notification = SessionNotification::new(
            "session-1",
            SessionUpdate::UsageUpdate(UsageUpdate::new(42, 100)),
        );

        let parsed = parse_session_notification(notification);

        assert_eq!(parsed.usage.map(|usage| usage.total_tokens), Some(42));
    }
}
