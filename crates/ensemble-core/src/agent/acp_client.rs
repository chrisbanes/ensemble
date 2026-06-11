use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::{
    ContentBlock, EnvVariable, InitializeRequest, McpServer, McpServerStdio, NewSessionRequest,
    PermissionOption, PermissionOptionKind, ProtocolVersion, RequestPermissionRequest,
    RequestPermissionResponse, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelectOptions, SessionNotification, SessionUpdate, SetSessionModeRequest,
    StopReason as SdkStopReason,
};
use agent_client_protocol::{AcpAgent, Client, Dispatch, SessionMessage};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::config::ensemble::{DiscoveredCapabilities, ModeDefinition, ModelDefinition};
use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, TokenUsage, WorkerEvent};
use super::ResolvedCommand;

/// Build an `AcpAgent` from a structured `ResolvedCommand`. The SDK's
/// `McpServerStdio` spawns the child via `async_process::Command`.
/// Because `McpServerStdio` has no working-directory field, we wrap the
/// command with `sh -c 'cd "$1" && shift && exec "$@"'` and pass the
/// workspace path as `$1` — the child process starts with the correct CWD
/// while all agent args arrive as separate `argv` entries (no shell escaping
/// needed for either the path or the args).
fn build_acp_agent(cmd: &ResolvedCommand, workspace_path: &Path) -> AcpAgent {
    let name = cmd
        .program
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "agent".to_string());
    let mut args = vec![
        "-c".to_string(),
        r#"cd "$1" && shift && exec "$@""#.to_string(),
        name.clone(),
        workspace_path.to_string_lossy().to_string(),
        cmd.program.to_string_lossy().to_string(),
    ];
    args.extend(cmd.args.iter().cloned());
    AcpAgent::new(McpServer::Stdio(
        McpServerStdio::new(name, PathBuf::from("sh"))
            .args(args)
            .env(
                cmd.env
                    .iter()
                    .map(|(k, v)| EnvVariable::new(k.clone(), v.clone()))
                    .collect(),
            ),
    ))
}

#[derive(Debug)]
pub struct AcpSessionConfig {
    pub command: ResolvedCommand,
    pub workspace_path: PathBuf,
    pub session_mode: Option<String>,
    pub permission_request_policy: String,
    pub read_timeout_ms: u64,
    pub turn_timeout_ms: u64,
    pub cancel_token: CancellationToken,
}

#[derive(Debug)]
pub struct AcpCapabilityDiscoveryConfig {
    pub command: ResolvedCommand,
    pub workspace_path: PathBuf,
    pub read_timeout_ms: u64,
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

fn select_value_description(
    value: &agent_client_protocol::schema::SessionConfigSelectOption,
) -> Option<String> {
    value.description.clone().filter(|text| !text.is_empty())
}

fn model_definitions_from_option(option: &SessionConfigOption) -> Vec<ModelDefinition> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options
                .iter()
                .map(|value| ModelDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: select_value_description(value),
                })
                .collect(),
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .map(|value| ModelDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: select_value_description(value),
                })
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn mode_definitions_from_option(option: &SessionConfigOption) -> Vec<ModeDefinition> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options
                .iter()
                .map(|value| ModeDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: select_value_description(value),
                })
                .collect(),
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .map(|value| ModeDefinition {
                    id: value.value.to_string(),
                    name: value.name.clone(),
                    description: select_value_description(value),
                })
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

pub fn discover_capabilities_from_options(
    options: Option<&[SessionConfigOption]>,
) -> DiscoveredCapabilities {
    let mut capabilities = DiscoveredCapabilities::default();

    for option in options.unwrap_or(&[]) {
        match option.category.as_ref() {
            Some(SessionConfigOptionCategory::Model) => {
                if let SessionConfigKind::Select(select) = &option.kind {
                    capabilities.current_model = Some(select.current_value.to_string());
                }
                capabilities
                    .models
                    .extend(model_definitions_from_option(option));
            }
            Some(SessionConfigOptionCategory::Mode) => {
                if let SessionConfigKind::Select(select) = &option.kind {
                    capabilities.current_mode = Some(select.current_value.to_string());
                }
                capabilities
                    .modes
                    .extend(mode_definitions_from_option(option));
            }
            _ => {}
        }
    }

    capabilities
}

pub async fn discover_capabilities(
    config: AcpCapabilityDiscoveryConfig,
) -> Result<DiscoveredCapabilities, AgentError> {
    let agent = build_acp_agent(&config.command, &config.workspace_path);
    let read_timeout_ms = config.read_timeout_ms;
    let workspace_path = config.workspace_path.clone();
    let discovered = Arc::new(Mutex::new(DiscoveredCapabilities::default()));
    let discovered_inner = discovered.clone();
    let session_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let session_error_inner = session_error.clone();

    Client
        .builder()
        .name("ensemble-capability-discovery")
        .connect_with(agent, async move |cx| {
            match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    *session_error_inner.lock().await = Some(format!("initialize failed: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    *session_error_inner.lock().await =
                        Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            }

            let session_response = match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(NewSessionRequest::new(&workspace_path))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(e)) => {
                    *session_error_inner.lock().await = Some(format!("session error: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    *session_error_inner.lock().await =
                        Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            };

            *discovered_inner.lock().await =
                discover_capabilities_from_options(session_response.config_options.as_deref());
            Ok(())
        })
        .await
        .map_err(|e| AgentError::IoError {
            reason: e.to_string(),
        })?;

    if let Some(error_msg) = session_error.lock().await.clone() {
        if error_msg.contains("response timeout") {
            return Err(AgentError::ResponseTimeout {
                timeout_ms: read_timeout_ms,
            });
        }
        return Err(AgentError::SessionStartupFailed { reason: error_msg });
    }

    let capabilities = discovered.lock().await.clone();
    Ok(capabilities)
}

pub async fn run_acp_session(
    config: AcpSessionConfig,
    prompts: Vec<String>,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<
    (
        Option<serde_json::Value>,
        Vec<TurnResult>,
        DiscoveredCapabilities,
    ),
    AgentError,
> {
    let agent = build_acp_agent(&config.command, &config.workspace_path);
    let permission_policy = config.permission_request_policy.clone();
    let issue_id_owned = issue_id.to_string();
    let step_name_owned = step_name.to_string();
    let event_tx_clone = event_tx.clone();

    let turn_results: Arc<Mutex<Vec<TurnResult>>> = Arc::new(Mutex::new(Vec::new()));
    let final_verdict: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let session_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let discovered_capabilities: Arc<Mutex<DiscoveredCapabilities>> =
        Arc::new(Mutex::new(DiscoveredCapabilities::default()));
    let prompts = Arc::new(prompts);
    let session_mode = config.session_mode.clone();
    let read_timeout_ms = config.read_timeout_ms;
    let turn_timeout_ms = config.turn_timeout_ms;
    let workspace_path = config.workspace_path.clone();
    let cancel_token = config.cancel_token.clone();

    let turn_results_inner = turn_results.clone();
    let final_verdict_inner = final_verdict.clone();
    let session_error_inner = session_error.clone();
    let session_error_outer = session_error.clone();
    let discovered_capabilities_inner = discovered_capabilities.clone();

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
            match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("initialize failed: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            }

            let session_response = match tokio::time::timeout(
                Duration::from_millis(read_timeout_ms),
                cx.send_request(NewSessionRequest::new(&workspace_path))
                    .block_task(),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(e)) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("session error: {e}"));
                    return Ok(());
                }
                Err(_) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("response timeout after {read_timeout_ms}ms"));
                    return Ok(());
                }
            };

            let capabilities =
                discover_capabilities_from_options(session_response.config_options.as_deref());
            *discovered_capabilities_inner.lock().await = capabilities;

            let mut session = match cx.attach_session(session_response, Vec::new()) {
                Ok(session) => session,
                Err(e) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("session attach failed: {e}"));
                    return Ok(());
                }
            };

            let session_id = session.session_id().to_string();

            emit_event(
                event_tx,
                issue_id,
                step_name,
                AgentEvent::SessionStarted {
                    session_id: session_id.clone(),
                    agent_pid: None,
                },
            )
            .await;

            if let Some(ref mode) = session_mode {
                if !mode.is_empty() {
                    let discovered = discovered_capabilities_inner.lock().await;
                    if !discovered.modes.is_empty()
                        && !discovered.modes.iter().any(|candidate| candidate.id == *mode)
                    {
                        let mut err = session_error_inner.lock().await;
                        *err = Some(format!(
                            "configured session_mode '{}' is not supported by agent; available modes: {}",
                            mode,
                            discovered
                                .modes
                                .iter()
                                .map(|m| m.id.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                        return Ok(());
                    }
                    drop(discovered);
                    match tokio::time::timeout(
                        Duration::from_millis(read_timeout_ms),
                        session
                            .connection()
                            .send_request(SetSessionModeRequest::new(
                                session.session_id().clone(),
                                mode.clone(),
                            ))
                            .block_task(),
                    )
                    .await
                    {
                        Ok(Ok(_)) => {}
                        Ok(Err(e)) => {
                            let mut err = session_error_inner.lock().await;
                            *err = Some(format!("set_mode failed: {e}"));
                            return Ok(());
                        }
                        Err(_) => {
                            let mut err = session_error_inner.lock().await;
                            *err = Some(format!("response timeout after {read_timeout_ms}ms"));
                            return Ok(());
                        }
                    }
                    debug!(session_id = %session_id, mode = %mode, "session mode set");
                }
            }

            for (i, prompt) in prompts.iter().enumerate() {
                if cancel_token.is_cancelled() {
                    emit_event(
                        event_tx,
                        issue_id,
                        step_name,
                        AgentEvent::Cancelled { reason: None },
                    )
                    .await;
                    let mut err = session_error_inner.lock().await;
                    *err = Some("cancelled by user".to_string());
                    return Ok(());
                }

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

                let cancel = cancel_token.clone();
                let turn_result: TurnResult = tokio::select! {
                    _ = cancel.cancelled() => {
                        emit_event(
                            event_tx,
                            issue_id,
                            step_name,
                            AgentEvent::Cancelled { reason: None },
                        )
                        .await;
                        let mut err = session_error_inner.lock().await;
                        *err = Some("cancelled by user".to_string());
                        return Ok(());
                    }
                    result = tokio::time::timeout(
                        Duration::from_millis(turn_timeout_ms),
                        turn_future,
                    ) => {
                        match result {
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
        .await;

    if let Err(e) = result {
        let error_msg = e.to_string();
        let captured = session_error_outer.lock().await.clone();
        let msg = captured.unwrap_or(error_msg);
        if msg.contains("response timeout") {
            return Err(AgentError::ResponseTimeout {
                timeout_ms: read_timeout_ms,
            });
        }
        if msg.contains("turn timeout") || msg.contains("TimedOut") {
            return Err(AgentError::TurnTimeout {
                timeout_ms: turn_timeout_ms,
            });
        }
        return Err(AgentError::IoError { reason: msg });
    }

    let captured_error = session_error_outer.lock().await.clone();
    if let Some(error_msg) = captured_error {
        if error_msg.contains("response timeout") {
            return Err(AgentError::ResponseTimeout {
                timeout_ms: read_timeout_ms,
            });
        } else if error_msg.contains("turn timeout") || error_msg.contains("TimedOut") {
            return Err(AgentError::TurnTimeout {
                timeout_ms: turn_timeout_ms,
            });
        } else if error_msg.contains("initialize") || error_msg.contains("session") {
            return Err(AgentError::SessionStartupFailed { reason: error_msg });
        } else if error_msg.contains("cancelled") {
            return Err(AgentError::TurnCancelled);
        } else {
            return Err(AgentError::IoError { reason: error_msg });
        }
    }

    let verdict = final_verdict.lock().await.take();
    let results = turn_results.lock().await.clone();
    let capabilities = discovered_capabilities.lock().await.clone();
    Ok((verdict, results, capabilities))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use agent_client_protocol::schema::{
        ContentBlock, ContentChunk, PermissionOption, PermissionOptionKind, SessionNotification,
        SessionUpdate, TextContent, UsageUpdate,
    };
    use tempfile::TempDir;

    use super::*;

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

    #[tokio::test]
    async fn startup_initialize_uses_configured_read_timeout() {
        let workspace = TempDir::new().unwrap();
        let config = AcpSessionConfig {
            command: ResolvedCommand {
                program: PathBuf::from("sleep"),
                args: vec!["60".to_string()],
                env: Vec::new(),
            },
            workspace_path: workspace.path().to_path_buf(),
            session_mode: None,
            permission_request_policy: "auto_approve_all".to_string(),
            read_timeout_ms: 50,
            turn_timeout_ms: 10_000,
            cancel_token: CancellationToken::new(),
        };
        let (tx, _rx) = mpsc::channel(10);

        let result = tokio::time::timeout(
            Duration::from_millis(500),
            run_acp_session(config, vec!["hello".to_string()], "issue-1", "build", &tx),
        )
        .await;

        assert!(
            matches!(
                result,
                Ok(Err(AgentError::ResponseTimeout { timeout_ms: 50 }))
            ),
            "startup should return the configured response timeout, got {result:?}"
        );
    }

    #[test]
    fn discover_capabilities_from_options_extracts_models_and_modes() {
        use agent_client_protocol::schema::{
            SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
        };

        let options = vec![
            SessionConfigOption::select(
                "model",
                "Model",
                "gpt-5",
                vec![
                    SessionConfigSelectOption::new("gpt-5", "GPT-5"),
                    SessionConfigSelectOption::new("sonnet", "Sonnet"),
                ],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(
                "mode",
                "Mode",
                "code",
                vec![
                    SessionConfigSelectOption::new("code", "Code"),
                    SessionConfigSelectOption::new("review", "Review"),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
        ];

        let capabilities = discover_capabilities_from_options(Some(&options));

        assert_eq!(capabilities.current_model.as_deref(), Some("gpt-5"));
        assert_eq!(
            capabilities
                .models
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5", "sonnet"]
        );
        assert_eq!(capabilities.current_mode.as_deref(), Some("code"));
        assert_eq!(
            capabilities
                .modes
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["code", "review"]
        );
    }

    #[test]
    fn discover_capabilities_from_options_flattens_grouped_options_with_descriptions() {
        use agent_client_protocol::schema::{
            SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectGroup,
            SessionConfigSelectOption,
        };

        let options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![
                SessionConfigSelectGroup::new(
                    "openai",
                    "OpenAI",
                    vec![
                        SessionConfigSelectOption::new("gpt-5", "GPT-5")
                            .description("flagship OpenAI model"),
                        SessionConfigSelectOption::new("gpt-5-mini", "GPT-5 mini")
                            .description("small OpenAI model"),
                    ],
                ),
                SessionConfigSelectGroup::new(
                    "anthropic",
                    "Anthropic",
                    vec![SessionConfigSelectOption::new("sonnet", "Sonnet")
                        .description("Anthropic Sonnet")],
                ),
            ],
        )
        .description("Available model")
        .category(SessionConfigOptionCategory::Model)];

        let capabilities = discover_capabilities_from_options(Some(&options));

        assert_eq!(capabilities.current_model.as_deref(), Some("gpt-5"));
        assert_eq!(
            capabilities
                .models
                .iter()
                .map(|m| (m.id.as_str(), m.description.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("gpt-5", Some("flagship OpenAI model")),
                ("gpt-5-mini", Some("small OpenAI model")),
                ("sonnet", Some("Anthropic Sonnet")),
            ]
        );
    }

    #[tokio::test]
    async fn discover_capabilities_times_out_when_agent_does_not_initialize() {
        let workspace = TempDir::new().unwrap();
        let config = AcpCapabilityDiscoveryConfig {
            command: ResolvedCommand {
                program: PathBuf::from("sleep"),
                args: vec!["60".to_string()],
                env: Vec::new(),
            },
            workspace_path: workspace.path().to_path_buf(),
            read_timeout_ms: 50,
        };

        let result =
            tokio::time::timeout(Duration::from_millis(500), discover_capabilities(config)).await;

        assert!(
            matches!(
                result,
                Ok(Err(AgentError::ResponseTimeout { timeout_ms: 50 }))
            ),
            "discovery should return the configured response timeout, got {result:?}"
        );
    }
}
