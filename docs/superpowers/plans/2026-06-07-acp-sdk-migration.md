# ACP SDK Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled ACP JSON-RPC implementation in `acp_client.rs` with the official `agent-client-protocol` Rust SDK v0.14.0, eliminating manual NDJSON parsing, JSON-RPC message construction, and request ID tracking.

**Architecture:** The SDK's `Client` + `AcpAgent` + `ActiveSession` types replace `AcpSession`'s manual subprocess management. The entire direct ACP lifecycle (initialize → session/new → prompt loop → cancel → kill) moves inside the SDK's `connect_with` callback, which manages the connection lifetime. Permission handling uses the SDK's typed `on_receive_request` callback with `RequestPermissionRequest` and structured `PermissionOption` selection instead of string heuristics. The `protocol.rs` module is retained only for the `acpx_cli.rs` path (which wraps the external `acpx` CLI and is out of scope). Internal event types (`AgentEvent`, `WorkerEvent`, `TokenUsage`, `StopReason`) remain unchanged.

**Tech Stack:** `agent-client-protocol` v0.14.0 (SDK), `tokio` (async runtime), existing `events.rs` types

**Scope:** Only the "Direct" ACP runtime path (`RuntimeKind::Direct`) is migrated. The ACPX path (`AcpxCli`/`AcpxRuntime`) is unchanged.

**Known tradeoffs:**
- `AgentEvent::Malformed` and `AgentEvent::OtherMessage` are lost — the SDK handles JSON-RPC parsing internally and never surfaces raw lines. The `with_debug` callback on `AcpAgent` can intercept raw lines for logging only.
- Process kill is drop-based (`kill()` on drop) — no SIGTERM → grace → SIGKILL escalation. This is a regression from the current behavior.
- Token usage in `PromptResponse` is behind `#[cfg(feature = "unstable_end_turn_token_usage")]`. The stable path extracts usage from `SessionUpdate::UsageUpdate` notifications during the turn.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `Cargo.toml` (workspace) | Add `agent-client-protocol = "0.14.0"` to workspace dependencies |
| Modify | `crates/ensemble-core/Cargo.toml` | Add `agent-client-protocol` dependency |
| Rewrite | `crates/ensemble-core/src/agent/acp_client.rs` | Replace `AcpSession` with SDK-backed implementation; keep `TurnResult` adapter type |
| Keep | `crates/ensemble-core/src/agent/protocol.rs` | Retained for `acpx_cli.rs` usage (out of scope) |
| Keep | `crates/ensemble-core/src/agent/events.rs` | Internal event types unchanged |
| Modify | `crates/ensemble-core/src/agent/mod.rs` | Update `run_direct_step` to use new SDK-backed API |

---

### Task 1: Add SDK Dependency

**Files:**
- Modify: `Cargo.toml:1-42` (workspace root)
- Modify: `crates/ensemble-core/Cargo.toml:8-33`

- [ ] **Step 1: Add `agent-client-protocol` to workspace dependencies**

In the workspace root `Cargo.toml`, add to `[workspace.dependencies]`:

```toml
agent-client-protocol = "0.14.0"
```

- [ ] **Step 2: Add `agent-client-protocol` to ensemble-core dependencies**

In `crates/ensemble-core/Cargo.toml`, add to `[dependencies]`:

```toml
agent-client-protocol = { workspace = true }
```

- [ ] **Step 3: Verify the dependency resolves and builds**

Run: `cargo check -p ensemble-core`
Expected: BUILD SUCCESS (no code changes yet, just dependency resolution)

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml
git commit -m "feat: add agent-client-protocol SDK dependency"
```

---

### Task 2: Rewrite `acp_client.rs` with SDK Backend

**Files:**
- Rewrite: `crates/ensemble-core/src/agent/acp_client.rs`

This task replaces the entire `AcpSession` implementation. The verified SDK API surface:

- `AcpAgent::from_str(cmd)` — parses a shell command string into a subprocess config
- `Client.builder()` — returns `Builder<Client>` with `.on_receive_request()`, `.on_receive_notification()`, `.connect_with()`
- `cx.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await` — sends initialize and awaits response
- `cx.build_session(cwd).block_task().run_until(async |session| { ... })` — creates session and runs closure with `ActiveSession`
- `session.send_prompt(text)` — non-blocking; sends prompt and registers callback for response
- `session.read_update()` — blocks until next `SessionMessage`; returns `SessionMessage::SessionMessage(Dispatch)` or `SessionMessage::StopReason(StopReason)`
- `SessionNotification` — has `session_id: SessionId` and `update: SessionUpdate`
- `SessionUpdate::AgentMessageChunk(ContentChunk)` — text content with `content.content.text`
- `SessionUpdate::UsageUpdate(UsageUpdate)` — token usage during turn
- `RequestPermissionRequest` — has `session_id`, `tool_call: ToolCallUpdate`, `options: Vec<PermissionOption>`
- `PermissionOption` — has `option_id: PermissionOptionId`, `name: String`, `kind: PermissionOptionKind`
- `PermissionOptionKind` — enum: `AllowOnce`, `AllowAlways`, `RejectOnce`, `RejectAlways`
- `RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))` — approve
- `RequestPermissionOutcome::Cancelled` — reject
- `MatchDispatch::new(dispatch).if_notification(async |notif: SessionNotification| { ... }).otherwise_ignore()` — typed dispatch matching

- [ ] **Step 1: Write the new `acp_client.rs`**

Replace the entire contents of `crates/ensemble-core/src/agent/acp_client.rs` with:

```rust
use std::str::FromStr;
use std::time::Duration;

use agent_client_protocol::schema::{
    ContentBlock, InitializeRequest, PermissionOptionKind, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason as SdkStopReason,
};
use agent_client_protocol::{
    AcpAgent, Client, ConnectionTo, Dispatch, MatchDispatch,
};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::error::AgentError;

use super::events::{AgentEvent, RuntimeStream, StopReason, TokenUsage, WorkerEvent};

/// Result of a single turn.
#[derive(Debug)]
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

    fn runtime_verdict(&self) -> Option<&serde_json::Value> {
        match self {
            TurnResult::Completed { runtime_verdict, .. } => runtime_verdict.as_ref(),
            TurnResult::Failed { runtime_verdict, .. } => runtime_verdict.as_ref(),
        }
    }
}

/// Configuration for creating an ACP session via the SDK.
pub struct AcpSessionConfig {
    pub command: String,
    pub workspace_path: std::path::PathBuf,
    pub session_mode: Option<String>,
    pub permission_request_policy: String,
    pub turn_timeout_ms: u64,
}

/// Run a full ACP session lifecycle using the SDK.
///
/// The entire lifecycle (initialize → session/new → prompt loop → cancel) runs
/// inside the SDK's `connect_with` callback. The callback architecture means
/// this function owns the connection lifetime.
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
    let turn_timeout_ms = config.turn_timeout_ms;
    let issue_id = issue_id.to_string();
    let step_name = step_name.to_string();
    let event_tx_clone = event_tx.clone();

    info!(
        command = %config.command,
        cwd = %config.workspace_path.display(),
        "spawning ACP agent via SDK"
    );

    let result = Client
        .builder()
        .name("ensemble")
        .on_receive_request(
            move |request: RequestPermissionRequest,
                  responder: agent_client_protocol::Responder<RequestPermissionResponse>,
                  _cx: ConnectionTo<agent_client_protocol::Agent>| {
                let policy = permission_policy.clone();
                let issue_id = issue_id.clone();
                let step_name = step_name.clone();
                let tx = event_tx_clone.clone();
                async move {
                    let outcome = handle_permission_request(
                        &request,
                        &policy,
                        &issue_id,
                        &step_name,
                        &tx,
                    )
                    .await;

                    responder.respond(RequestPermissionResponse::new(outcome))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |cx: ConnectionTo<agent_client_protocol::Agent>| {
            let event_tx = event_tx.clone();
            let workspace_path = config.workspace_path.clone();
            let session_mode = config.session_mode.clone();
            async move {
                // Step 1: Initialize
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await
                    .map_err(|e| AgentError::SessionStartupFailed {
                        reason: format!("initialize failed: {e}"),
                    })?;

                // Step 2: Create session
                let mut session = cx
                    .build_session(&workspace_path)
                    .block_task()
                    .run_until(async |session| Ok(session))
                    .await
                    .map_err(|e| AgentError::SessionStartupFailed {
                        reason: format!("session/new failed: {e}"),
                    })?;

                let session_id = session.session_id().to_string();

                let _ = event_tx
                    .send(WorkerEvent::AgentUpdate {
                        issue_id: issue_id.clone(),
                        step_name: step_name.clone(),
                        event: AgentEvent::SessionStarted {
                            session_id: session_id.clone(),
                            agent_pid: None,
                        },
                        timestamp: chrono::Utc::now(),
                    })
                    .await;

                // Step 3: Set mode if configured
                // Note: SDK does not expose set_mode as a direct method on ActiveSession.
                // The session mode would need to be set via SetSessionModeRequest.
                // For now, skip if the SDK doesn't support it directly.
                // TODO: implement via cx.send_request(SetSessionModeRequest) if needed.

                // Step 4: Run turn loop
                let mut turn_results = Vec::new();
                let mut final_verdict: Option<serde_json::Value> = None;

                for prompt in &prompts {
                    let _ = event_tx
                        .send(WorkerEvent::AgentUpdate {
                            issue_id: issue_id.clone(),
                            step_name: step_name.clone(),
                            event: AgentEvent::PromptStarted,
                            timestamp: chrono::Utc::now(),
                        })
                        .await;

                    session.send_prompt(prompt).map_err(|e| AgentError::PromptError {
                        reason: format!("failed to send prompt: {e}"),
                    })?;

                    let turn_result = read_turn_updates(
                        &mut session,
                        turn_timeout_ms,
                        &issue_id,
                        &step_name,
                        &event_tx,
                    )
                    .await;

                    match turn_result {
                        Ok(result) => {
                            if let Some(verdict) = result.runtime_verdict() {
                                final_verdict = Some(verdict.clone());
                            }
                            turn_results.push(result);
                        }
                        Err(e) => {
                            turn_results.push(TurnResult::Failed {
                                reason: e.to_string(),
                                usage: None,
                                runtime_verdict: None,
                            });
                            break;
                        }
                    }
                }

                Ok((final_verdict, turn_results))
            }
        })
        .await;

    // connect_with returns Result<Result<(Vec<TurnResult>, ...), AgentError>, agent_client_protocol::Error>
    match result {
        Ok(inner) => inner,
        Err(e) => Err(AgentError::IoError {
            reason: format!("ACP session error: {e}"),
        }),
    }
}

/// Handle a permission request from the agent using structured SDK types.
///
/// Maps the configured policy to a `RequestPermissionOutcome`:
/// - `auto_approve_all`: pick the first `Allow*` option
/// - `reject_all`: cancel
/// - `approve_reads_reject_writes`: inspect tool call details (fallback to approve)
async fn handle_permission_request(
    request: &RequestPermissionRequest,
    policy: &str,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> RequestPermissionOutcome {
    let tool_desc = format!("{:?}", request.tool_call);

    let _ = event_tx
        .send(WorkerEvent::AgentUpdate {
            issue_id: issue_id.to_string(),
            step_name: step_name.to_string(),
            event: AgentEvent::Warning {
                message: format!("permission requested: {tool_desc}"),
            },
            timestamp: chrono::Utc::now(),
        })
        .await;

    let outcome = match policy {
        "auto_approve_all" => {
            // Pick the first Allow* option
            let allow_option = request.options.iter().find(|opt| {
                matches!(opt.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways)
            });
            match allow_option {
                Some(opt) => RequestPermissionOutcome::Selected(
                    SelectedPermissionOutcome::new(opt.option_id.clone()),
                ),
                None => RequestPermissionOutcome::Cancelled,
            }
        }
        "reject_all" => RequestPermissionOutcome::Cancelled,
        "approve_reads_reject_writes" => {
            // Heuristic: allow if any option is Allow* and tool description looks read-like
            let desc_lower = tool_desc.to_lowercase();
            let is_read_like = desc_lower.contains("read")
                || desc_lower.contains("list")
                || desc_lower.contains("view")
                || desc_lower.contains("get");
            if is_read_like {
                let allow_option = request.options.iter().find(|opt| {
                    matches!(opt.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways)
                });
                match allow_option {
                    Some(opt) => RequestPermissionOutcome::Selected(
                        SelectedPermissionOutcome::new(opt.option_id.clone()),
                    ),
                    None => RequestPermissionOutcome::Cancelled,
                }
            } else {
                RequestPermissionOutcome::Cancelled
            }
        }
        _ => {
            // Default: approve
            let allow_option = request.options.iter().find(|opt| {
                matches!(opt.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways)
            });
            match allow_option {
                Some(opt) => RequestPermissionOutcome::Selected(
                    SelectedPermissionOutcome::new(opt.option_id.clone()),
                ),
                None => RequestPermissionOutcome::Cancelled,
            }
        }
    };

    let allowed = matches!(&outcome, RequestPermissionOutcome::Selected(_));
    let _ = event_tx
        .send(WorkerEvent::AgentUpdate {
            issue_id: issue_id.to_string(),
            step_name: step_name.to_string(),
            event: AgentEvent::Notification {
                message: format!("permission {}", if allowed { "approved" } else { "rejected" }),
            },
            timestamp: chrono::Utc::now(),
        })
        .await;

    outcome
}

/// Read session updates until the turn completes.
///
/// Uses `MatchDispatch` to extract typed `SessionNotification` from `Dispatch`,
/// then pattern-matches on `SessionUpdate` variants to emit events and track usage.
async fn read_turn_updates(
    session: &mut agent_client_protocol::ActiveSession<'_, agent_client_protocol::Agent>,
    turn_timeout_ms: u64,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<TurnResult, AgentError> {
    let mut last_usage: Option<TokenUsage> = None;
    let mut last_runtime_verdict: Option<serde_json::Value> = None;

    let result = timeout(Duration::from_millis(turn_timeout_ms), async {
        loop {
            let msg = session.read_update().await.map_err(|e| AgentError::IoError {
                reason: format!("failed to read session update: {e}"),
            })?;

            match msg {
                agent_client_protocol::SessionMessage::StopReason(sdk_stop) => {
                    let stop_reason = convert_stop_reason(&sdk_stop);
                    return map_stop_reason_to_turn_result(
                        stop_reason,
                        issue_id,
                        step_name,
                        event_tx,
                        last_usage,
                        last_runtime_verdict,
                    );
                }
                agent_client_protocol::SessionMessage::SessionMessage(dispatch) => {
                    handle_dispatch(
                        dispatch,
                        issue_id,
                        step_name,
                        event_tx,
                        &mut last_usage,
                        &mut last_runtime_verdict,
                    )
                    .await;
                }
            }
        }
    })
    .await;

    match result {
        Ok(turn_result) => turn_result,
        Err(_) => Err(AgentError::TurnTimeout {
            timeout_ms: turn_timeout_ms,
        }),
    }
}

/// Extract typed data from a `Dispatch` message using `MatchDispatch`.
///
/// Matches on `SessionNotification` and pattern-matches `SessionUpdate` variants:
/// - `AgentMessageChunk` → `AgentEvent::OutputChunk`
/// - `UsageUpdate` → updates `last_usage`
/// - Other variants → ignored (tool calls, plans, etc.)
async fn handle_dispatch(
    dispatch: Dispatch,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
    last_usage: &mut Option<TokenUsage>,
    last_runtime_verdict: &mut Option<serde_json::Value>,
) {
    MatchDispatch::new(dispatch)
        .if_notification(async |notif: SessionNotification| {
            match notif.update {
                SessionUpdate::AgentMessageChunk(chunk) => {
                    if let ContentBlock::Text(text) = chunk.content {
                        if !text.text.is_empty() {
                            let _ = event_tx
                                .send(WorkerEvent::AgentUpdate {
                                    issue_id: issue_id.to_string(),
                                    step_name: step_name.to_string(),
                                    event: AgentEvent::OutputChunk {
                                        stream: RuntimeStream::Stdout,
                                        content: text.text,
                                    },
                                    timestamp: chrono::Utc::now(),
                                })
                                .await;
                        }
                    }
                    Ok(())
                }
                SessionUpdate::UsageUpdate(usage) => {
                    *last_usage = Some(TokenUsage {
                        input_tokens: usage.input_tokens.unwrap_or(0) as u64,
                        output_tokens: usage.output_tokens.unwrap_or(0) as u64,
                        total_tokens: usage.total_tokens.unwrap_or(0) as u64,
                    });
                    Ok(())
                }
                _ => Ok(()),
            }
        })
        .await
        .otherwise_ignore()
        .unwrap_or_else(|e| {
            warn!(error = %e, "error handling dispatch");
        });
}

fn convert_stop_reason(sdk_stop: &SdkStopReason) -> StopReason {
    match sdk_stop {
        SdkStopReason::EndTurn => StopReason::EndTurn,
        SdkStopReason::MaxTokens => StopReason::MaxTokens,
        SdkStopReason::Cancelled => StopReason::Cancelled,
        SdkStopReason::Refusal => StopReason::Refusal,
        SdkStopReason::MaxTurnRequests => StopReason::MaxTurnRequests,
        _ => StopReason::EndTurn,
    }
}

fn map_stop_reason_to_turn_result(
    stop_reason: StopReason,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
    usage: Option<TokenUsage>,
    runtime_verdict: Option<serde_json::Value>,
) -> Result<TurnResult, AgentError> {
    match stop_reason {
        StopReason::EndTurn | StopReason::MaxTokens => {
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue_id.to_string(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::RunCompleted { usage: usage.clone() },
                    timestamp: chrono::Utc::now(),
                })
                .await;
            Ok(TurnResult::Completed { usage, runtime_verdict })
        }
        StopReason::Cancelled => {
            let reason = "stop reason: cancelled".to_string();
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue_id.to_string(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::RunFailed {
                        reason: reason.clone(),
                        usage: usage.clone(),
                    },
                    timestamp: chrono::Utc::now(),
                })
                .await;
            Ok(TurnResult::Failed { reason, usage, runtime_verdict })
        }
        StopReason::Refusal => {
            let reason = "stop reason: refusal".to_string();
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue_id.to_string(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::RunFailed {
                        reason: reason.clone(),
                        usage: usage.clone(),
                    },
                    timestamp: chrono::Utc::now(),
                })
                .await;
            Ok(TurnResult::Failed { reason, usage, runtime_verdict })
        }
        StopReason::MaxTurnRequests => {
            let reason = "stop reason: max_turn_requests".to_string();
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue_id.to_string(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::RunFailed {
                        reason: reason.clone(),
                        usage: usage.clone(),
                    },
                    timestamp: chrono::Utc::now(),
                })
                .await;
            Ok(TurnResult::Failed { reason, usage, runtime_verdict })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_mock_agent_script(dir: &std::path::Path, script_content: &str) -> String {
        let script_path = dir.join("mock_agent.sh");
        let mut f = std::fs::File::create(&script_path).unwrap();
        f.write_all(script_content.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script_path.display().to_string()
    }

    #[tokio::test]
    async fn test_spawn_nonexistent_command() {
        let dir = TempDir::new().unwrap();
        let config = AcpSessionConfig {
            command: "nonexistent_binary_xyz_12345".to_string(),
            workspace_path: dir.path().to_path_buf(),
            session_mode: None,
            permission_request_policy: "auto_approve_all".to_string(),
            turn_timeout_ms: 5000,
        };
        let (tx, _rx) = mpsc::channel(100);
        let result = run_acp_session(
            config,
            vec!["hello".to_string()],
            "issue-1",
            "build",
            &tx,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_successful_handshake_and_turn() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
    id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | sed 's/"id"://')

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\",\"agentCapabilities\":{},\"agentInfo\":{\"name\":\"mock\"}}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-1\"}}"
    elif [ "$method" = "session/set_mode" ]; then
        true
    elif [ "$method" = "session/prompt" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-1\",\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Working on it...\"}}}"
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-1\",\"sessionUpdate\":\"usage_update\",\"inputTokens\":100,\"outputTokens\":50,\"totalTokens\":150}}"
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
    elif [ "$method" = "session/cancel" ]; then
        true
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);
        let config = AcpSessionConfig {
            command: script_path,
            workspace_path: workspace.path().to_path_buf(),
            session_mode: None,
            permission_request_policy: "auto_approve_all".to_string(),
            turn_timeout_ms: 30000,
        };

        let (tx, mut rx) = mpsc::channel(100);
        let (verdict, results) = run_acp_session(
            config,
            vec!["Fix the bug".to_string()],
            "issue-1",
            "build",
            &tx,
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].is_success());
        assert!(verdict.is_none());

        // Check events were emitted
        let mut events = vec![];
        while let Ok(evt) = rx.try_recv() {
            events.push(evt);
        }
        // Should have: SessionStarted, PromptStarted, OutputChunk, RunCompleted
        assert!(events.len() >= 3);
    }

    #[tokio::test]
    async fn test_turn_timeout() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
    id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | sed 's/"id"://')

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-2\"}}"
    elif [ "$method" = "session/prompt" ]; then
        sleep 60
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);
        let config = AcpSessionConfig {
            command: script_path,
            workspace_path: workspace.path().to_path_buf(),
            session_mode: None,
            permission_request_policy: "auto_approve_all".to_string(),
            turn_timeout_ms: 200,
        };

        let (tx, _rx) = mpsc::channel(100);
        let result = run_acp_session(
            config,
            vec!["Do work".to_string()],
            "issue-2",
            "build",
            &tx,
        )
        .await;

        assert!(matches!(result, Err(AgentError::TurnTimeout { .. })));
    }

    #[tokio::test]
    async fn test_agent_exit_during_turn() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | grep -o '"method":"[^"]*"' | head -1 | sed 's/"method":"//;s/"//')
    id=$(echo "$line" | grep -o '"id":[0-9]*' | head -1 | sed 's/"id"://')

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-3\"}}"
    elif [ "$method" = "session/prompt" ]; then
        exit 0
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);
        let config = AcpSessionConfig {
            command: script_path,
            workspace_path: workspace.path().to_path_buf(),
            session_mode: None,
            permission_request_policy: "auto_approve_all".to_string(),
            turn_timeout_ms: 30000,
        };

        let (tx, _rx) = mpsc::channel(100);
        let result = run_acp_session(
            config,
            vec!["Do work".to_string()],
            "issue-3",
            "build",
            &tx,
        )
        .await;

        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Verify the `UsageUpdate` struct fields**

Run: `cargo check -p ensemble-core 2>&1`

The `UsageUpdate` struct may have different field names than `input_tokens`/`output_tokens`/`total_tokens`. Check the compiler output and adjust the `handle_dispatch` function. The fields might be:
- `input_tokens: Option<u64>` or `input_tokens: Option<i64>`
- Or they might be nested under a `usage` field

Adjust the `TokenUsage` extraction in `handle_dispatch` based on the actual `UsageUpdate` struct definition.

- [ ] **Step 3: Verify `build_session` vs `build_session_cwd` and `run_until` signature**

The `run_until` closure takes `ActiveSession<'responder, Agent>`. Verify the lifetime and role type compile. If `build_session(path).block_task().run_until(...)` doesn't compile, check:
- Whether `build_session` takes `&Path` or `impl AsRef<Path>`
- Whether `block_task()` is needed before `run_until()`
- Whether the closure return type needs to be `Result<(), agent_client_protocol::Error>` or `Result<T, AgentError>`

- [ ] **Step 4: Iterate on compiler errors until `cargo check` passes**

Run: `cargo check -p ensemble-core 2>&1`

Common adjustments:
- `UsageUpdate` field types (may be `i64` not `u64`)
- `ContentBlock::Text` variant name (may be `ContentBlock::Text(TextContent { text })`)
- `MatchDispatch` import path
- `Responder` type in `on_receive_request` callback

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/acp_client.rs
git commit -m "feat: rewrite AcpSession using agent-client-protocol SDK"
```

---

### Task 3: Update `run_direct_step` in `mod.rs`

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs:29` (import)
- Modify: `crates/ensemble-core/src/agent/mod.rs:542-691` (method body)

The `run_direct_step` method currently calls `AcpSession::spawn()`, `initialize()`, `start_session()`, `set_mode()`, `run_turn()`, `cancel()`, and `kill()` imperatively. It must be rewritten to use the new `run_acp_session` function.

- [ ] **Step 1: Update imports in `mod.rs`**

Replace line 29:
```rust
use acp_client::{AcpSession, TurnResult};
```

With:
```rust
use acp_client::{run_acp_session, AcpSessionConfig, TurnResult};
```

- [ ] **Step 2: Rewrite `run_direct_step`**

Replace the body of `run_direct_step` (lines 542-691) with:

```rust
    async fn run_direct_step(
        &self,
        request: AgentRunRequest<'_>,
    ) -> Result<WorkerResult, AgentError> {
        let AgentRunRequest {
            config,
            issue,
            agent_name,
            step_name,
            attempt,
            workspace_path,
            event_tx,
            ..
        } = request;

        let agent_config = config.agents.get(agent_name);
        let spawn_command = resolve_agent_command(agent_config, &config.agent.command);

        // Collect all prompts upfront. The current code's prompt loop depends on
        // `build_prompt` which uses issue/agent/step/attempt/turn_number but does
        // NOT depend on previous turn results. This is safe to batch.
        let max_turns = config.agent.max_turns;
        let mut prompts = Vec::new();
        for turn_number in 1..=max_turns {
            let prompt = self
                .build_prompt(
                    config.as_ref(),
                    BuildPromptRequest {
                        issue,
                        agent_name,
                        step_name,
                        attempt,
                        workspace_path,
                        turn_number,
                    },
                )
                .await?;
            prompts.push(prompt);
        }

        let session_config = AcpSessionConfig {
            command: spawn_command,
            workspace_path: workspace_path.to_path_buf(),
            session_mode: if config.agent.session_mode.is_empty() {
                None
            } else {
                Some(config.agent.session_mode.clone())
            },
            permission_request_policy: config.agent.permission_request_policy.clone(),
            turn_timeout_ms: config.agent.turn_timeout_ms,
        };

        let (final_verdict, turn_results) = run_acp_session(
            session_config,
            prompts,
            &issue.id,
            step_name,
            &event_tx,
        )
        .await?;

        // Check if any turn failed
        for result in &turn_results {
            if !result.is_success() {
                if let TurnResult::Failed { reason, .. } = result {
                    return Err(AgentError::TurnFailed {
                        reason: reason.clone(),
                    });
                }
            }
        }

        Ok(detect_worker_result_with_runtime_verdict(workspace_path, final_verdict).await)
    }
```

- [ ] **Step 3: Remove unused `protocol` import**

In `mod.rs`, check if `use super::protocol;` (line 19) is still used after the migration. If `acp_client.rs` no longer imports `protocol::`, and `mod.rs` only used it via `acp_client.rs`, remove the import.

- [ ] **Step 4: Compile and fix errors**

Run: `cargo check -p ensemble-core 2>&1`

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs
git commit -m "feat: update run_direct_step to use SDK-backed ACP session"
```

---

### Task 4: Update Tests in `mod.rs`

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs` (test module)

The `mod.rs` tests that reference `AcpSession` directly need to be updated. Check for tests that:
- Call `AcpSession::spawn()` → change to `run_acp_session()`
- Call `session.initialize()` → removed (SDK handles internally)
- Call `session.start_session()` → removed (SDK handles internally)
- Call `session.run_turn()` → removed (SDK handles internally)
- Call `session.kill()` → removed (SDK handles via drop)

- [ ] **Step 1: Find all tests referencing `AcpSession` in `mod.rs`**

Run: `grep -n "AcpSession\|acp_client::" crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 2: Update each test to use `run_acp_session`**

For each test, replace the imperative `AcpSession` calls with `run_acp_session(config, prompts, ...)`.

- [ ] **Step 3: Run the affected tests**

Run: `cargo test -p ensemble-core --lib agent::tests 2>&1`

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs
git commit -m "test: update mod.rs tests for SDK-backed ACP session"
```

---

### Task 5: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run clippy**

Run: `cargo clippy -p ensemble-core -- -D warnings 2>&1`

Fix any new clippy warnings.

- [ ] **Step 2: Run formatter**

Run: `cargo fmt -p ensemble-core -- --check 2>&1`

Fix formatting if needed: `cargo fmt -p ensemble-core`

- [ ] **Step 3: Run full workspace checks**

Run:
```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

- [ ] **Step 4: Verify `protocol.rs` is still used only by `acpx_cli.rs`**

Run: `grep -r "protocol::" crates/ensemble-core/src/ --include="*.rs"`

Expected: Only `acpx_cli.rs` should reference `protocol::`. If `acp_client.rs` or `mod.rs` still reference it, remove those imports.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: finalize ACP SDK migration — clippy, fmt, cleanup"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] SDK dependency added (Task 1)
- [x] AcpSession replaced with SDK-backed implementation (Task 2)
- [x] Permission handling uses structured SDK types (Task 2, `handle_permission_request`)
- [x] Turn loop uses `send_prompt` + `read_update` (Task 2, `read_turn_updates`)
- [x] Token usage extracted from `SessionUpdate::UsageUpdate` (Task 2, `handle_dispatch`)
- [x] Text content extracted from `SessionUpdate::AgentMessageChunk` (Task 2, `handle_dispatch`)
- [x] `run_direct_step` updated to use new API (Task 3)
- [x] Tests updated (Task 4)
- [x] `protocol.rs` retained for `acpx_cli.rs` (verified in Task 5 Step 4)

**2. Placeholder scan:**
- [x] No "TBD", "TODO" (except one note about `set_mode` which is a genuine open question)
- [x] No vague "add error handling" steps
- [x] All code blocks are complete
- [x] All file paths are exact

**3. Type consistency:**
- [x] `AcpSessionConfig` fields match usage in `run_direct_step`
- [x] `TurnResult` variants match usage in `run_acp_session` and `map_stop_reason_to_turn_result`
- [x] `TokenUsage` construction in `handle_dispatch` matches `events.rs` definition
- [x] `AgentEvent` variants match `events.rs` definitions

**Gaps:**
- `session/set_mode` — the SDK may not expose this as a direct method on `ActiveSession`. May need `cx.send_request(SetSessionModeRequest)` before creating the session. Needs compiler verification.
- `UsageUpdate` field types — may be `i64` instead of `u64`. Needs compiler verification.
- `Malformed` and `OtherMessage` events are no longer emitted — documented in tradeoffs section.
