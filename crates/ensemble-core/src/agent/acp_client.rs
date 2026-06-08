use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use agent_client_protocol::schema::{
    InitializeRequest, ProtocolVersion, RequestPermissionRequest, RequestPermissionResponse,
    StopReason as SdkStopReason,
};
use agent_client_protocol::{AcpAgent, Client, SessionMessage};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

use crate::error::AgentError;

use super::events::{AgentEvent, TokenUsage, WorkerEvent};

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
    let agent = AcpAgent::from_str(&config.command).map_err(|e| AgentError::AgentNotFound {
        command: format!("{}: {}", config.command, e),
    })?;

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

            let allowed = resolve_permission(&permission_policy, &description);

            let outcome = if allowed {
                if let Some(first_option) = request.options.first() {
                    let option_id: agent_client_protocol::schema::PermissionOptionId =
                        first_option.option_id.clone();
                    agent_client_protocol::schema::RequestPermissionOutcome::Selected(
                        agent_client_protocol::schema::SelectedPermissionOutcome::new(option_id),
                    )
                } else {
                    agent_client_protocol::schema::RequestPermissionOutcome::Cancelled
                }
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

            let session_builder = match cx.build_session_cwd() {
                Ok(sb) => sb,
                Err(e) => {
                    let mut err = session_error_inner.lock().await;
                    *err = Some(format!("build_session_cwd failed: {e}"));
                    return Ok(());
                }
            };

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
                            agent_pid: None,
                        },
                    )
                    .await;

                    if let Some(ref mode) = session_mode {
                        if !mode.is_empty() {
                            debug!(session_id = %session_id, mode = %mode, "session mode note (SDK manages mode internally)");
                        }
                    }

                    for (i, prompt) in prompts.iter().enumerate() {
                        emit_event(
                            event_tx,
                            issue_id,
                            step_name,
                            AgentEvent::PromptStarted,
                        )
                        .await;

                        if let Err(e) = session.send_prompt(prompt) {
                            let mut err = session_error_inner.lock().await;
                            *err = Some(format!("send_prompt failed: {e}"));
                            return Ok(());
                        }

                        let last_usage: Option<TokenUsage> = None;
                        let last_runtime_verdict: Option<serde_json::Value> = None;
                        let mut timed_out = false;

                        let turn_future = async {
                            loop {
                                match session.read_update().await {
                                    Ok(SessionMessage::StopReason(stop)) => {
                                        let mapped = map_sdk_stop_reason(&stop);
                                        return Ok((mapped, last_usage, last_runtime_verdict));
                                    }
                                    Ok(SessionMessage::SessionMessage(_dispatch)) => {}
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
                timeout_ms: config.turn_timeout_ms,
            });
        }
        return Err(AgentError::IoError { reason: msg });
    }

    let captured_error = session_error_outer.lock().await.clone();
    if let Some(error_msg) = captured_error {
        if error_msg.contains("timeout") || error_msg.contains("TimedOut") {
            return Err(AgentError::TurnTimeout {
                timeout_ms: config.turn_timeout_ms,
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
