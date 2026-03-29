# Plan 3: ACP Agent Client + Orchestrator State Machine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ACP agent client (stdio JSON-RPC 2.0), orchestrator state machine, scheduler, retry logic, reconciliation, and main orchestrator loop — the core runtime engine that dispatches and manages coding agent sessions.

**Architecture:** The agent module (`agent/`) contains the ACP protocol client and event types. The orchestrator module (`orchestrator/`) contains the state machine, scheduler, retry queue, reconciler, and main event loop. Workers communicate with the orchestrator via `tokio::sync::mpsc` channels. All state mutations are serialized through the orchestrator's single select loop. The `AgentRunner` trait boundary enables mock-based testing of the full orchestrator without real subprocesses.

**Tech Stack:** Rust (2021 edition), tokio (full + process + time + sync), serde/serde_json, async-trait, tracing, thiserror, chrono, nix (signals), futures (FuturesUnordered), tempfile (tests)

---

## File Structure

```
crates/ensemble-core/src/
├── lib.rs                          # add agent + orchestrator modules
├── error.rs                        # add AgentError
├── agent/
│   ├── mod.rs                      # AgentRunner trait + AcpAgentRunner
│   ├── events.rs                   # AgentEvent, WorkerEvent, TokenUsage, StopReason
│   └── acp_client.rs               # AcpSession: spawn, handshake, turn loop
└── orchestrator/
    ├── mod.rs                       # Orchestrator struct + run() main loop
    ├── state.rs                     # OrchestratorState + RunningEntry mutations
    ├── scheduler.rs                 # Candidate selection, dispatch priority, slot math
    ├── retry.rs                     # Backoff calculation, retry scheduling
    └── reconciler.rs                # Stall detection, tracker state refresh
```

---

### Task 1: Agent Events Module

**Files:**
- Create: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Add AgentError to error.rs**

Add the `AgentError` variant to `crates/ensemble-core/src/error.rs`. Add this error enum after the existing `WorkspaceError`:

```rust
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent not found: {command}")]
    AgentNotFound { command: String },
    #[error("invalid workspace cwd: {path}")]
    InvalidWorkspaceCwd { path: String },
    #[error("response timeout after {timeout_ms}ms")]
    ResponseTimeout { timeout_ms: u64 },
    #[error("turn timeout after {timeout_ms}ms")]
    TurnTimeout { timeout_ms: u64 },
    #[error("agent exited unexpectedly: {reason}")]
    AgentExit { reason: String },
    #[error("response error: {reason}")]
    ResponseError { reason: String },
    #[error("turn failed: {reason}")]
    TurnFailed { reason: String },
    #[error("turn cancelled")]
    TurnCancelled,
    #[error("turn requires user input")]
    TurnInputRequired,
    #[error("session startup failed: {reason}")]
    SessionStartupFailed { reason: String },
    #[error("io error: {reason}")]
    IoError { reason: String },
    #[error("hook failed: {reason}")]
    HookFailed { reason: String },
    #[error("prompt error: {reason}")]
    PromptError { reason: String },
}
```

And add the variant to `EnsembleError`:

```rust
#[error(transparent)]
Agent(#[from] AgentError),
```

- [ ] **Step 2: Update lib.rs to declare the agent and orchestrator modules**

Update `crates/ensemble-core/src/lib.rs`:

```rust
pub mod error;
pub mod tracker;
pub mod config;
pub mod workspace;
pub mod agent;
pub mod orchestrator;
```

- [ ] **Step 3: Create the events module**

Create `crates/ensemble-core/src/agent/events.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Token usage reported by the ACP agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

/// ACP stop reasons mapped from session/update notifications.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    Cancelled,
    Refusal,
    MaxTurnRequests,
}

impl StopReason {
    /// Parse a stop reason string from ACP protocol.
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s {
            "end_turn" => Some(StopReason::EndTurn),
            "max_tokens" => Some(StopReason::MaxTokens),
            "cancelled" => Some(StopReason::Cancelled),
            "refusal" => Some(StopReason::Refusal),
            "max_turn_requests" => Some(StopReason::MaxTurnRequests),
            _ => None,
        }
    }

    /// Whether this stop reason indicates a successful turn completion.
    pub fn is_success(&self) -> bool {
        matches!(self, StopReason::EndTurn)
    }

    /// Whether this stop reason indicates a failure.
    pub fn is_failure(&self) -> bool {
        matches!(
            self,
            StopReason::Cancelled | StopReason::Refusal | StopReason::MaxTurnRequests
        )
    }
}

/// Internal event types emitted by the ACP client to the orchestrator.
#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    SessionStarted {
        session_id: String,
        agent_pid: Option<String>,
    },
    TurnStarted,
    TurnUpdate {
        content: String,
    },
    TurnCompleted {
        usage: Option<TokenUsage>,
    },
    TurnFailed {
        reason: String,
        usage: Option<TokenUsage>,
    },
    PermissionRequested {
        permission_id: String,
        description: String,
    },
    PermissionResolved {
        permission_id: String,
        allowed: bool,
    },
    Notification {
        message: String,
    },
    OtherMessage {
        raw: String,
    },
    Malformed {
        line: String,
    },
}

/// Events sent from worker tasks to the orchestrator.
#[derive(Debug)]
pub enum WorkerEvent {
    AgentUpdate {
        issue_id: String,
        step_name: String,
        event: AgentEvent,
        timestamp: DateTime<Utc>,
    },
    WorkerExited {
        issue_id: String,
        step_name: String,
        result: WorkerResult,
        timestamp: DateTime<Utc>,
    },
}

/// Outcome of a worker task.
#[derive(Debug, Clone)]
pub enum WorkerResult {
    Success,
    Failed { error: String },
}

impl WorkerResult {
    pub fn is_success(&self) -> bool {
        matches!(self, WorkerResult::Success)
    }
}

/// JSON-RPC 2.0 message types for ACP protocol parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcMessage {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<serde_json::Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcMessage {
    /// Check if this is a response (has id and result or error).
    pub fn is_response(&self) -> bool {
        self.id.is_some() && (self.result.is_some() || self.error.is_some())
    }

    /// Check if this is a request (has id and method).
    pub fn is_request(&self) -> bool {
        self.id.is_some() && self.method.is_some()
    }

    /// Check if this is a notification (has method but no id).
    pub fn is_notification(&self) -> bool {
        self.id.is_none() && self.method.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stop_reason_parse() {
        assert_eq!(
            StopReason::from_str_loose("end_turn"),
            Some(StopReason::EndTurn)
        );
        assert_eq!(
            StopReason::from_str_loose("cancelled"),
            Some(StopReason::Cancelled)
        );
        assert_eq!(
            StopReason::from_str_loose("refusal"),
            Some(StopReason::Refusal)
        );
        assert_eq!(
            StopReason::from_str_loose("max_turn_requests"),
            Some(StopReason::MaxTurnRequests)
        );
        assert_eq!(
            StopReason::from_str_loose("max_tokens"),
            Some(StopReason::MaxTokens)
        );
        assert_eq!(StopReason::from_str_loose("unknown"), None);
    }

    #[test]
    fn test_stop_reason_success_failure() {
        assert!(StopReason::EndTurn.is_success());
        assert!(!StopReason::EndTurn.is_failure());
        assert!(!StopReason::Cancelled.is_success());
        assert!(StopReason::Cancelled.is_failure());
        assert!(StopReason::Refusal.is_failure());
        assert!(StopReason::MaxTurnRequests.is_failure());
        assert!(!StopReason::MaxTokens.is_success());
        assert!(!StopReason::MaxTokens.is_failure());
    }

    #[test]
    fn test_worker_result_is_success() {
        assert!(WorkerResult::Success.is_success());
        assert!(!WorkerResult::Failed {
            error: "boom".to_string()
        }
        .is_success());
    }

    #[test]
    fn test_json_rpc_message_classification() {
        // Response
        let resp = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(1)),
            method: None,
            params: None,
            result: Some(serde_json::json!({"ok": true})),
            error: None,
        };
        assert!(resp.is_response());
        assert!(!resp.is_request());
        assert!(!resp.is_notification());

        // Request
        let req = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(2)),
            method: Some("session/request_permission".to_string()),
            params: Some(serde_json::json!({})),
            result: None,
            error: None,
        };
        assert!(!req.is_response());
        assert!(req.is_request());
        assert!(!req.is_notification());

        // Notification
        let notif = JsonRpcMessage {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: Some("session/update".to_string()),
            params: Some(serde_json::json!({})),
            result: None,
            error: None,
        };
        assert!(!notif.is_response());
        assert!(!notif.is_request());
        assert!(notif.is_notification());
    }

    #[test]
    fn test_json_rpc_message_parse_from_json() {
        let json_str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-07-09","agentCapabilities":{}}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(json_str).unwrap();
        assert!(msg.is_response());
        assert_eq!(msg.id, Some(serde_json::json!(1)));
        assert!(msg.result.is_some());
    }

    #[test]
    fn test_json_rpc_error_response_parse() {
        let json_str =
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request"}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(json_str).unwrap();
        assert!(msg.is_response());
        let err = msg.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Invalid Request");
    }

    #[test]
    fn test_token_usage_default() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn test_token_usage_serialization_roundtrip() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
        };
        let json = serde_json::to_string(&usage).unwrap();
        let parsed: TokenUsage = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.input_tokens, 1000);
        assert_eq!(parsed.output_tokens, 500);
        assert_eq!(parsed.total_tokens, 1500);
    }
}
```

- [ ] **Step 4: Create the agent module file**

Create `crates/ensemble-core/src/agent/mod.rs`:

```rust
pub mod events;
pub mod acp_client;

use std::path::Path;
use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::tracker::model::Issue;
use events::WorkerEvent;

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        issue: &Issue,
        agent_name: &str,
        step_name: &str,
        attempt: Option<u32>,
        workspace_path: &Path,
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError>;
}
```

- [ ] **Step 5: Create stub orchestrator module so it compiles**

Create `crates/ensemble-core/src/orchestrator/mod.rs`:

```rust
pub mod state;
pub mod scheduler;
pub mod retry;
pub mod reconciler;
```

Create `crates/ensemble-core/src/orchestrator/state.rs`:

```rust
// Orchestrator state — will be fleshed out in Task 4
```

Create `crates/ensemble-core/src/orchestrator/scheduler.rs`:

```rust
// Scheduler — will be fleshed out in Task 5
```

Create `crates/ensemble-core/src/orchestrator/retry.rs`:

```rust
// Retry logic — will be fleshed out in Task 6
```

Create `crates/ensemble-core/src/orchestrator/reconciler.rs`:

```rust
// Reconciler — will be fleshed out in Task 7
```

- [ ] **Step 6: Add new dependencies to ensemble-core Cargo.toml**

Add these to the `[dependencies]` section of `crates/ensemble-core/Cargo.toml`:

```toml
futures = "0.3"
```

And add to workspace root `Cargo.toml` under `[workspace.dependencies]`:

```toml
futures = "0.3"
```

- [ ] **Step 7: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core agent::events`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-core/src/agent/ crates/ensemble-core/src/orchestrator/ crates/ensemble-core/src/error.rs crates/ensemble-core/src/lib.rs Cargo.toml crates/ensemble-core/Cargo.toml
git commit -m "feat: agent events module with ACP protocol types, AgentRunner trait, orchestrator stubs"
```

---

### Task 2: ACP Client

**Files:**
- Create: `crates/ensemble-core/src/agent/acp_client.rs`

- [ ] **Step 1: Write the ACP client**

Create `crates/ensemble-core/src/agent/acp_client.rs`:

```rust
use std::path::Path;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::error::AgentError;

use super::events::{
    AgentEvent, JsonRpcMessage, StopReason, TokenUsage, WorkerEvent, WorkerResult,
};

/// ACP session managing a subprocess and stdio JSON-RPC 2.0 protocol.
pub struct AcpSession {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    session_id: Option<String>,
    next_request_id: u64,
    agent_pid: Option<String>,
}

/// Result of an ACP initialize call.
#[derive(Debug)]
pub struct InitializeResult {
    pub protocol_version: Option<String>,
    pub agent_info: Option<serde_json::Value>,
}

/// Result of a single turn.
#[derive(Debug)]
pub enum TurnResult {
    /// Turn completed successfully (end_turn or max_tokens).
    Completed { usage: Option<TokenUsage> },
    /// Turn failed with a reason.
    Failed { reason: String, usage: Option<TokenUsage> },
}

impl TurnResult {
    pub fn is_success(&self) -> bool {
        matches!(self, TurnResult::Completed { .. })
    }
}

impl AcpSession {
    /// Spawn an ACP agent subprocess.
    pub async fn spawn(
        command: &str,
        workspace_path: &Path,
    ) -> Result<Self, AgentError> {
        info!(command = command, cwd = %workspace_path.display(), "spawning ACP agent");

        let mut child = Command::new("bash")
            .arg("-lc")
            .arg(command)
            .current_dir(workspace_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AgentError::AgentNotFound {
                command: format!("{command}: {e}"),
            })?;

        let pid = child.id().map(|p| p.to_string());

        let stdin = child.stdin.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture stdin".to_string(),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| AgentError::IoError {
            reason: "failed to capture stdout".to_string(),
        })?;

        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            session_id: None,
            next_request_id: 1,
            agent_pid: pid,
        })
    }

    /// Get the agent PID if available.
    pub fn agent_pid(&self) -> Option<&str> {
        self.agent_pid.as_deref()
    }

    /// Get the session ID if established.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Send the ACP initialize request and wait for the response.
    pub async fn initialize(
        &mut self,
        read_timeout_ms: u64,
    ) -> Result<InitializeResult, AgentError> {
        let id = self.next_id();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-07-09",
                "clientCapabilities": { "terminal": true },
                "clientInfo": { "name": "ensemble", "version": "0.1.0" }
            }
        });

        self.send_json_rpc(&msg).await?;

        let response = self.read_response(id, read_timeout_ms).await?;

        let result = response.result.ok_or_else(|| {
            let err_msg = response
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "no result in initialize response".to_string());
            AgentError::SessionStartupFailed { reason: err_msg }
        })?;

        Ok(InitializeResult {
            protocol_version: result
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            agent_info: result.get("agentInfo").cloned(),
        })
    }

    /// Send session/new and return the session ID.
    pub async fn start_session(
        &mut self,
        cwd: &str,
        mcp_servers: serde_json::Value,
        read_timeout_ms: u64,
    ) -> Result<String, AgentError> {
        let id = self.next_id();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/new",
            "params": {
                "cwd": cwd,
                "mcpServers": mcp_servers
            }
        });

        self.send_json_rpc(&msg).await?;

        let response = self.read_response(id, read_timeout_ms).await?;

        let result = response.result.ok_or_else(|| {
            let err_msg = response
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "no result in session/new response".to_string());
            AgentError::SessionStartupFailed { reason: err_msg }
        })?;

        let session_id = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AgentError::SessionStartupFailed {
                reason: "missing sessionId in session/new response".to_string(),
            })?
            .to_string();

        self.session_id = Some(session_id.clone());
        Ok(session_id)
    }

    /// Send session/set_mode notification.
    pub async fn set_mode(
        &mut self,
        session_id: &str,
        mode: &str,
    ) -> Result<(), AgentError> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "session/set_mode",
            "params": {
                "sessionId": session_id,
                "mode": mode
            }
        });
        self.send_json_rpc(&msg).await
    }

    /// Send session/prompt and stream events until the turn completes.
    /// Returns a TurnResult indicating success or failure.
    pub async fn run_turn(
        &mut self,
        session_id: &str,
        content: &str,
        turn_timeout_ms: u64,
        permission_policy: &str,
        issue_id: &str,
        step_name: &str,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<TurnResult, AgentError> {
        let id = self.next_id();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "content": [{ "type": "text", "text": content }]
            }
        });

        self.send_json_rpc(&msg).await?;

        // Emit turn started event
        Self::emit_event(
            event_tx,
            issue_id,
            step_name,
            AgentEvent::TurnStarted,
        )
        .await;

        let turn_duration = Duration::from_millis(turn_timeout_ms);
        let result = timeout(turn_duration, self.stream_turn(
            id,
            session_id,
            permission_policy,
            issue_id,
            step_name,
            event_tx,
        ))
        .await;

        match result {
            Ok(Ok(turn_result)) => Ok(turn_result),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(AgentError::TurnTimeout {
                timeout_ms: turn_timeout_ms,
            }),
        }
    }

    /// Internal: stream session/update messages until turn completion.
    async fn stream_turn(
        &mut self,
        prompt_request_id: u64,
        session_id: &str,
        permission_policy: &str,
        issue_id: &str,
        step_name: &str,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<TurnResult, AgentError> {
        let mut last_usage: Option<TokenUsage> = None;

        loop {
            let line = self.read_line().await?;

            let msg: JsonRpcMessage = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(_) => {
                    Self::emit_event(
                        event_tx,
                        issue_id,
                        step_name,
                        AgentEvent::Malformed { line: line.clone() },
                    )
                    .await;
                    continue;
                }
            };

            // Handle response to our prompt request
            if msg.is_response() {
                if let Some(ref msg_id) = msg.id {
                    if msg_id.as_u64() == Some(prompt_request_id) {
                        // Prompt response received — this confirms the turn is done
                        if let Some(ref err) = msg.error {
                            return Ok(TurnResult::Failed {
                                reason: err.message.clone(),
                                usage: last_usage,
                            });
                        }
                        // A prompt response without error means turn completed
                        return Ok(TurnResult::Completed { usage: last_usage });
                    }
                }
                continue;
            }

            // Handle agent-to-client requests (e.g., permission)
            if msg.is_request() {
                if let Some(ref method) = msg.method {
                    if method == "session/request_permission" {
                        self.handle_permission_request(
                            &msg,
                            permission_policy,
                            issue_id,
                            step_name,
                            event_tx,
                        )
                        .await?;
                        continue;
                    }
                }
                // Unknown request — respond with method not found
                if let Some(ref req_id) = msg.id {
                    let err_resp = json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32601, "message": "Method not found" }
                    });
                    self.send_json_rpc(&err_resp).await?;
                }
                Self::emit_event(
                    event_tx,
                    issue_id,
                    step_name,
                    AgentEvent::OtherMessage {
                        raw: line.clone(),
                    },
                )
                .await;
                continue;
            }

            // Handle notifications
            if let Some(ref method) = msg.method {
                match method.as_str() {
                    "session/update" => {
                        if let Some(ref params) = msg.params {
                            // Extract usage if present
                            if let Some(usage_val) = params.get("usage") {
                                if let Ok(usage) =
                                    serde_json::from_value::<TokenUsage>(usage_val.clone())
                                {
                                    last_usage = Some(usage);
                                }
                            }

                            // Check for stopReason
                            if let Some(stop_str) =
                                params.get("stopReason").and_then(|v| v.as_str())
                            {
                                if let Some(stop_reason) = StopReason::from_str_loose(stop_str) {
                                    if stop_reason.is_success() {
                                        Self::emit_event(
                                            event_tx,
                                            issue_id,
                                            step_name,
                                            AgentEvent::TurnCompleted {
                                                usage: last_usage.clone(),
                                            },
                                        )
                                        .await;
                                        return Ok(TurnResult::Completed {
                                            usage: last_usage,
                                        });
                                    } else if stop_reason == StopReason::MaxTokens {
                                        // max_tokens is a potential continuation, treat as success
                                        Self::emit_event(
                                            event_tx,
                                            issue_id,
                                            step_name,
                                            AgentEvent::TurnCompleted {
                                                usage: last_usage.clone(),
                                            },
                                        )
                                        .await;
                                        return Ok(TurnResult::Completed {
                                            usage: last_usage,
                                        });
                                    } else {
                                        let reason = format!("stop reason: {stop_str}");
                                        Self::emit_event(
                                            event_tx,
                                            issue_id,
                                            step_name,
                                            AgentEvent::TurnFailed {
                                                reason: reason.clone(),
                                                usage: last_usage.clone(),
                                            },
                                        )
                                        .await;
                                        return Ok(TurnResult::Failed {
                                            reason,
                                            usage: last_usage,
                                        });
                                    }
                                }
                            }

                            // Extract content for update event
                            let content = params
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !content.is_empty() {
                                Self::emit_event(
                                    event_tx,
                                    issue_id,
                                    step_name,
                                    AgentEvent::TurnUpdate { content },
                                )
                                .await;
                            } else {
                                Self::emit_event(
                                    event_tx,
                                    issue_id,
                                    step_name,
                                    AgentEvent::Notification {
                                        message: line.chars().take(200).collect(),
                                    },
                                )
                                .await;
                            }
                        }
                    }
                    _ => {
                        Self::emit_event(
                            event_tx,
                            issue_id,
                            step_name,
                            AgentEvent::OtherMessage { raw: line.clone() },
                        )
                        .await;
                    }
                }
            }
        }
    }

    /// Handle a session/request_permission request from the agent.
    async fn handle_permission_request(
        &mut self,
        msg: &JsonRpcMessage,
        permission_policy: &str,
        issue_id: &str,
        step_name: &str,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError> {
        let params = msg.params.as_ref().unwrap_or(&serde_json::Value::Null);
        let permission_id = params
            .get("permissionId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let description = params
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        Self::emit_event(
            event_tx,
            issue_id,
            step_name,
            AgentEvent::PermissionRequested {
                permission_id: permission_id.clone(),
                description: description.clone(),
            },
        )
        .await;

        let allowed = match permission_policy {
            "auto_approve_all" => true,
            "reject_all" => false,
            "approve_reads_reject_writes" => {
                // Heuristic: approve if description contains read-like terms
                let desc_lower = description.to_lowercase();
                desc_lower.contains("read") || desc_lower.contains("list") || desc_lower.contains("view")
            }
            _ => true, // default to approve
        };

        let response_option = if allowed {
            "allow_always"
        } else {
            "reject_once"
        };

        if let Some(ref req_id) = msg.id {
            let resp = json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "permissionId": permission_id,
                    "option": response_option
                }
            });
            self.send_json_rpc(&resp).await?;
        }

        Self::emit_event(
            event_tx,
            issue_id,
            step_name,
            AgentEvent::PermissionResolved {
                permission_id,
                allowed,
            },
        )
        .await;

        Ok(())
    }

    /// Send session/cancel notification.
    pub async fn cancel(&mut self, session_id: &str) -> Result<(), AgentError> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        });
        // Best effort — ignore errors
        let _ = self.send_json_rpc(&msg).await;
        Ok(())
    }

    /// Kill the agent subprocess: SIGTERM, then SIGKILL after grace period.
    pub async fn kill(&mut self) {
        // Try graceful termination first
        if let Some(pid) = self.child.id() {
            debug!(pid = pid, "sending SIGTERM to agent");
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Wait up to 5 seconds for graceful exit
            match timeout(Duration::from_secs(5), self.child.wait()).await {
                Ok(_) => {
                    debug!(pid = pid, "agent exited after SIGTERM");
                    return;
                }
                Err(_) => {
                    debug!(pid = pid, "agent did not exit after SIGTERM, sending SIGKILL");
                }
            }
        }

        // Force kill
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }

    /// Send a JSON-RPC message (write JSON + newline to stdin).
    async fn send_json_rpc(&mut self, msg: &serde_json::Value) -> Result<(), AgentError> {
        let line = serde_json::to_string(msg).map_err(|e| AgentError::IoError {
            reason: format!("json serialize error: {e}"),
        })?;
        debug!(msg = %line, "sending JSON-RPC");
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("stdin write error: {e}"),
            })?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("stdin write newline error: {e}"),
            })?;
        self.stdin.flush().await.map_err(|e| AgentError::IoError {
            reason: format!("stdin flush error: {e}"),
        })?;
        Ok(())
    }

    /// Read one line from stdout.
    async fn read_line(&mut self) -> Result<String, AgentError> {
        let mut line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|e| AgentError::IoError {
                reason: format!("stdout read error: {e}"),
            })?;

        if bytes_read == 0 {
            return Err(AgentError::AgentExit {
                reason: "agent process closed stdout (EOF)".to_string(),
            });
        }

        let trimmed = line.trim_end().to_string();
        debug!(line = %trimmed, "received from agent");
        Ok(trimmed)
    }

    /// Read a specific response by request ID with timeout.
    async fn read_response(
        &mut self,
        expected_id: u64,
        timeout_ms: u64,
    ) -> Result<JsonRpcMessage, AgentError> {
        let duration = Duration::from_millis(timeout_ms);

        let result = timeout(duration, async {
            loop {
                let line = self.read_line().await?;
                let msg: JsonRpcMessage = serde_json::from_str(&line).map_err(|e| {
                    AgentError::ResponseError {
                        reason: format!("invalid JSON-RPC response: {e} — line: {line}"),
                    }
                })?;

                if msg.is_response() {
                    if let Some(ref id) = msg.id {
                        if id.as_u64() == Some(expected_id) {
                            return Ok(msg);
                        }
                    }
                }
                // Not the response we're looking for — skip and continue
            }
        })
        .await;

        match result {
            Ok(Ok(msg)) => Ok(msg),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(AgentError::ResponseTimeout { timeout_ms }),
        }
    }

    /// Get next request ID.
    fn next_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    /// Helper to emit a WorkerEvent::AgentUpdate.
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Create a mock ACP agent script that reads JSON-RPC from stdin and responds.
    fn write_mock_agent_script(dir: &Path, script_content: &str) -> String {
        let script_path = dir.join("mock_agent.sh");
        let mut f = std::fs::File::create(&script_path).unwrap();
        f.write_all(script_content.as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        script_path.display().to_string()
    }

    #[tokio::test]
    async fn test_spawn_nonexistent_command() {
        let dir = TempDir::new().unwrap();
        let result =
            AcpSession::spawn("nonexistent_binary_xyz_12345", dir.path()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_successful_handshake_and_turn() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        // Mock agent: responds to initialize, session/new, then session/update with end_turn
        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
    id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\",\"agentCapabilities\":{},\"agentInfo\":{\"name\":\"mock\"}}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-1\"}}"
    elif [ "$method" = "session/set_mode" ]; then
        true  # notification, no response needed
    elif [ "$method" = "session/prompt" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-1\",\"content\":\"Working on it...\"}}"
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-1\",\"stopReason\":\"end_turn\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"total_tokens\":150}}}"
    elif [ "$method" = "session/cancel" ]; then
        true
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);

        let mut session = AcpSession::spawn(&script_path, workspace.path())
            .await
            .unwrap();

        // Initialize
        let init_result = session.initialize(5000).await.unwrap();
        assert_eq!(
            init_result.protocol_version.as_deref(),
            Some("2025-07-09")
        );

        // Start session
        let session_id = session
            .start_session(
                workspace.path().to_str().unwrap(),
                serde_json::json!({}),
                5000,
            )
            .await
            .unwrap();
        assert_eq!(session_id, "test-session-1");

        // Set mode
        session.set_mode(&session_id, "code").await.unwrap();

        // Run turn
        let (tx, mut rx) = mpsc::channel(100);
        let turn_result = session
            .run_turn(&session_id, "Fix the bug", 30000, "auto_approve_all", "issue-1", "build", &tx)
            .await
            .unwrap();

        assert!(turn_result.is_success());
        if let TurnResult::Completed { usage } = &turn_result {
            let u = usage.as_ref().unwrap();
            assert_eq!(u.input_tokens, 100);
            assert_eq!(u.output_tokens, 50);
            assert_eq!(u.total_tokens, 150);
        }

        // Check events were emitted
        let mut events = vec![];
        while let Ok(evt) = rx.try_recv() {
            events.push(evt);
        }
        // Should have: TurnStarted, TurnUpdate or Notification, TurnCompleted
        assert!(events.len() >= 2);

        session.kill().await;
    }

    #[tokio::test]
    async fn test_turn_timeout() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        // Mock agent that does handshake but never completes the turn
        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
    id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-2\"}}"
    elif [ "$method" = "session/prompt" ]; then
        # Never send stopReason — simulate hanging
        sleep 60
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);

        let mut session = AcpSession::spawn(&script_path, workspace.path())
            .await
            .unwrap();
        session.initialize(5000).await.unwrap();
        let session_id = session
            .start_session(
                workspace.path().to_str().unwrap(),
                serde_json::json!({}),
                5000,
            )
            .await
            .unwrap();

        let (tx, _rx) = mpsc::channel(100);
        let result = session
            .run_turn(&session_id, "Do work", 200, "auto_approve_all", "issue-2", "build", &tx)
            .await;

        assert!(matches!(result, Err(AgentError::TurnTimeout { .. })));
        session.kill().await;
    }

    #[tokio::test]
    async fn test_agent_exit_during_turn() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        // Mock agent that exits immediately after handshake on prompt
        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
    id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-3\"}}"
    elif [ "$method" = "session/prompt" ]; then
        exit 0  # exit abruptly
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);

        let mut session = AcpSession::spawn(&script_path, workspace.path())
            .await
            .unwrap();
        session.initialize(5000).await.unwrap();
        let session_id = session
            .start_session(
                workspace.path().to_str().unwrap(),
                serde_json::json!({}),
                5000,
            )
            .await
            .unwrap();

        let (tx, _rx) = mpsc::channel(100);
        let result = session
            .run_turn(&session_id, "Do work", 30000, "auto_approve_all", "issue-3", "build", &tx)
            .await;

        assert!(matches!(result, Err(AgentError::AgentExit { .. })));
        session.kill().await;
    }

    #[tokio::test]
    async fn test_malformed_json_handling() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        // Mock agent that sends malformed JSON then a valid turn completion
        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
    id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-4\"}}"
    elif [ "$method" = "session/prompt" ]; then
        echo "this is not valid json at all"
        echo "{also broken json"
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-4\",\"stopReason\":\"end_turn\"}}"
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);

        let mut session = AcpSession::spawn(&script_path, workspace.path())
            .await
            .unwrap();
        session.initialize(5000).await.unwrap();
        let session_id = session
            .start_session(
                workspace.path().to_str().unwrap(),
                serde_json::json!({}),
                5000,
            )
            .await
            .unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        let result = session
            .run_turn(&session_id, "Do work", 30000, "auto_approve_all", "issue-4", "build", &tx)
            .await
            .unwrap();

        assert!(result.is_success());

        // Verify malformed events were emitted
        let mut malformed_count = 0;
        while let Ok(evt) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate { event: AgentEvent::Malformed { .. }, step_name: _, .. } = evt {
                malformed_count += 1;
            }
        }
        assert!(malformed_count >= 2, "expected at least 2 malformed events, got {malformed_count}");

        session.kill().await;
    }

    #[tokio::test]
    async fn test_permission_request_auto_approve() {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();

        // Mock agent that sends a permission request, then completes
        let script = r#"#!/bin/bash
while IFS= read -r line; do
    method=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('method',''))" 2>/dev/null || echo "")
    id=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [ "$method" = "initialize" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2025-07-09\"}}"
    elif [ "$method" = "session/new" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"test-session-5\"}}"
    elif [ "$method" = "session/prompt" ]; then
        echo "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"session/request_permission\",\"params\":{\"permissionId\":\"perm-1\",\"description\":\"Execute command: ls\"}}"
        # Read the permission response
        read -r perm_response
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"test-session-5\",\"stopReason\":\"end_turn\"}}"
    fi
done
"#;
        let script_path = write_mock_agent_script(dir.path(), script);

        let mut session = AcpSession::spawn(&script_path, workspace.path())
            .await
            .unwrap();
        session.initialize(5000).await.unwrap();
        let session_id = session
            .start_session(
                workspace.path().to_str().unwrap(),
                serde_json::json!({}),
                5000,
            )
            .await
            .unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        let result = session
            .run_turn(&session_id, "Do work", 30000, "auto_approve_all", "issue-5", "build", &tx)
            .await
            .unwrap();

        assert!(result.is_success());

        // Verify permission events
        let mut perm_requested = false;
        let mut perm_resolved = false;
        while let Ok(evt) = rx.try_recv() {
            match evt {
                WorkerEvent::AgentUpdate {
                    event: AgentEvent::PermissionRequested { permission_id, .. },
                    ..
                } => {
                    assert_eq!(permission_id, "perm-1");
                    perm_requested = true;
                }
                WorkerEvent::AgentUpdate {
                    event: AgentEvent::PermissionResolved { permission_id, allowed },
                    ..
                } => {
                    assert_eq!(permission_id, "perm-1");
                    assert!(allowed);
                    perm_resolved = true;
                }
                _ => {}
            }
        }
        assert!(perm_requested, "expected PermissionRequested event");
        assert!(perm_resolved, "expected PermissionResolved event");

        session.kill().await;
    }
}
```

- [ ] **Step 2: Add libc dependency to Cargo.toml**

Add to workspace root `Cargo.toml` under `[workspace.dependencies]`:

```toml
libc = "0.2"
```

Add to `crates/ensemble-core/Cargo.toml` under `[dependencies]`:

```toml
libc = { workspace = true }
```

- [ ] **Step 3: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core agent::acp_client`
Expected: All tests pass (some tests require `python3` available for the mock scripts; skip if not present)

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/agent/acp_client.rs Cargo.toml crates/ensemble-core/Cargo.toml
git commit -m "feat: ACP client with stdio JSON-RPC 2.0, handshake, turn streaming, permission handling"
```

---

### Task 3: AgentRunner Trait + AcpAgentRunner Implementation

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write the full AcpAgentRunner implementation**

Replace `crates/ensemble-core/src/agent/mod.rs` with:

```rust
pub mod events;
pub mod acp_client;

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn};

use crate::config::ensemble::EnsembleConfig;
use crate::config::template::render_prompt;
use crate::error::AgentError;
use crate::tracker::model::Issue;
use crate::workspace::hooks::{run_hook, run_hook_best_effort};
use events::{AgentEvent, WorkerEvent, WorkerResult};

use acp_client::{AcpSession, TurnResult};

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        issue: &Issue,
        agent_name: &str,
        step_name: &str,
        attempt: Option<u32>,
        workspace_path: &Path,
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError>;
}

/// Real ACP agent runner that implements the full worker loop from SPEC.md Section 16.5.
pub struct AcpAgentRunner {
    pub config: Arc<RwLock<EnsembleConfig>>,
}

impl AcpAgentRunner {
    pub fn new(
        config: Arc<RwLock<EnsembleConfig>>,
    ) -> Self {
        Self { config }
    }

    /// Build the prompt for a given turn.
    /// First turn uses the full rendered template from the agent config;
    /// continuation turns use guidance text.
    async fn build_prompt(
        &self,
        issue: &Issue,
        agent_name: &str,
        attempt: Option<u32>,
        turn_number: u32,
    ) -> Result<String, AgentError> {
        if turn_number == 1 {
            let config = self.config.read().await;
            let agent_config = config.agents.get(agent_name).ok_or_else(|| {
                AgentError::PromptError {
                    reason: format!("agent '{}' not found in config", agent_name),
                }
            })?;

            // Resolve the prompt template: inline prompt or file-based prompt_template
            let template_str = if let Some(ref prompt) = agent_config.prompt {
                prompt.clone()
            } else if let Some(ref template_path) = agent_config.prompt_template {
                std::fs::read_to_string(template_path).map_err(|e| AgentError::PromptError {
                    reason: format!("failed to read prompt template '{}': {}", template_path.display(), e),
                })?
            } else {
                return Err(AgentError::PromptError {
                    reason: format!("agent '{}' has neither prompt nor prompt_template", agent_name),
                });
            };

            render_prompt(&template_str, issue, attempt).map_err(|e| {
                AgentError::PromptError {
                    reason: e.to_string(),
                }
            })
        } else {
            // Continuation turns: send guidance, not the full original prompt
            Ok(format!(
                "Continue working on {}. This is turn {} of this session. \
                 The issue is still in an active state. \
                 Review your progress and continue where you left off.",
                issue.identifier, turn_number
            ))
        }
    }
}

#[async_trait]
impl AgentRunner for AcpAgentRunner {
    async fn run(
        &self,
        issue: &Issue,
        agent_name: &str,
        step_name: &str,
        attempt: Option<u32>,
        workspace_path: &Path,
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError> {
        let config = self.config.read().await.clone();

        // 1. Run before_run hook
        if let Some(ref script) = config.hooks.before_run {
            run_hook("before_run", script, workspace_path, config.hooks.timeout_ms)
                .await
                .map_err(|e| AgentError::HookFailed {
                    reason: e.to_string(),
                })?;
        }

        // 2. Spawn ACP agent and do handshake
        let mut session = AcpSession::spawn(&config.agent.command, workspace_path).await?;

        let cwd_str = workspace_path.to_str().ok_or_else(|| AgentError::InvalidWorkspaceCwd {
            path: workspace_path.display().to_string(),
        })?;

        // Initialize
        session.initialize(config.agent.read_timeout_ms).await?;

        // Start session
        let session_id = session
            .start_session(cwd_str, serde_json::json!({}), config.agent.read_timeout_ms)
            .await?;

        // Emit session started event
        let _ = event_tx
            .send(WorkerEvent::AgentUpdate {
                issue_id: issue.id.clone(),
                step_name: step_name.to_string(),
                event: AgentEvent::SessionStarted {
                    session_id: session_id.clone(),
                    agent_pid: session.agent_pid().map(|s| s.to_string()),
                },
                timestamp: chrono::Utc::now(),
            })
            .await;

        // Set mode if configured
        if !config.agent.session_mode.is_empty() {
            session
                .set_mode(&session_id, &config.agent.session_mode)
                .await?;
        }

        // 3. Turn loop
        let max_turns = config.agent.max_turns;
        let mut turn_number: u32 = 1;

        let result = loop {
            // Build prompt for this turn
            let prompt = match self.build_prompt(issue, agent_name, attempt, turn_number).await {
                Ok(p) => p,
                Err(e) => {
                    session.cancel(&session_id).await?;
                    break Err(e);
                }
            };

            // Run the turn
            let turn_result = session
                .run_turn(
                    &session_id,
                    &prompt,
                    config.agent.turn_timeout_ms,
                    &config.agent.permission_policy,
                    &issue.id,
                    step_name,
                    &event_tx,
                )
                .await;

            match turn_result {
                Ok(TurnResult::Completed { .. }) => {
                    info!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        turn = turn_number,
                        agent = agent_name,
                        step = step_name,
                        "turn completed successfully"
                    );
                }
                Ok(TurnResult::Failed { reason, .. }) => {
                    warn!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        turn = turn_number,
                        agent = agent_name,
                        step = step_name,
                        reason = %reason,
                        "turn failed"
                    );
                    session.cancel(&session_id).await?;
                    break Err(AgentError::TurnFailed { reason });
                }
                Err(e) => {
                    session.cancel(&session_id).await?;
                    break Err(e);
                }
            }

            // Check if we've hit max turns
            if turn_number >= max_turns {
                info!(
                    issue_id = %issue.id,
                    identifier = %issue.identifier,
                    turns = turn_number,
                    "reached max turns"
                );
                break Ok(());
            }

            turn_number += 1;
        };

        // 4. Stop session
        let _ = session.cancel(&session_id).await;

        // 5. Run after_run hook (best effort)
        if let Some(ref script) = config.hooks.after_run {
            run_hook_best_effort("after_run", script, workspace_path, config.hooks.timeout_ms)
                .await;
        }

        // Kill agent process
        session.kill().await;

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::TrackerError;
    use crate::tracker::IssueTracker;

    /// Mock agent runner for testing the orchestrator.
    pub struct MockAgentRunner {
        pub should_succeed: bool,
        pub delay_ms: u64,
    }

    #[async_trait]
    impl AgentRunner for MockAgentRunner {
        async fn run(
            &self,
            issue: &Issue,
            _agent_name: &str,
            step_name: &str,
            _attempt: Option<u32>,
            _workspace_path: &Path,
            event_tx: mpsc::Sender<WorkerEvent>,
        ) -> Result<(), AgentError> {
            // Simulate some work
            if self.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            }

            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue.id.clone(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::SessionStarted {
                        session_id: "mock-session".to_string(),
                        agent_pid: Some("12345".to_string()),
                    },
                    timestamp: chrono::Utc::now(),
                })
                .await;

            if self.should_succeed {
                Ok(())
            } else {
                Err(AgentError::TurnFailed {
                    reason: "mock failure".to_string(),
                })
            }
        }
    }

    /// Mock tracker for testing.
    pub struct MockTracker {
        pub issues: Vec<Issue>,
    }

    #[async_trait]
    impl IssueTracker for MockTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.clone())
        }

        async fn fetch_issues_by_states(
            &self,
            _states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            Ok(vec![])
        }

        async fn fetch_issue_states_by_ids(
            &self,
            ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let matching: Vec<Issue> = self
                .issues
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect();
            Ok(matching)
        }
    }

    fn test_issue() -> Issue {
        Issue {
            id: "issue-1".to_string(),
            identifier: "test-repo#1".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("Something is broken".to_string()),
            priority: Some(2),
            state: "Todo".to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    #[tokio::test]
    async fn test_mock_agent_runner_success() {
        let runner = MockAgentRunner {
            should_succeed: true,
            delay_ms: 0,
        };
        let (tx, mut rx) = mpsc::channel(100);
        let workspace = tempfile::TempDir::new().unwrap();

        let result = runner
            .run(&test_issue(), "builder", "build", None, workspace.path(), tx)
            .await;

        assert!(result.is_ok());

        let evt = rx.try_recv().unwrap();
        match evt {
            WorkerEvent::AgentUpdate {
                event: AgentEvent::SessionStarted { session_id, .. },
                step_name,
                ..
            } => {
                assert_eq!(session_id, "mock-session");
                assert_eq!(step_name, "build");
            }
            _ => panic!("expected SessionStarted event"),
        }
    }

    #[tokio::test]
    async fn test_mock_agent_runner_failure() {
        let runner = MockAgentRunner {
            should_succeed: false,
            delay_ms: 0,
        };
        let (tx, _rx) = mpsc::channel(100);
        let workspace = tempfile::TempDir::new().unwrap();

        let result = runner
            .run(&test_issue(), "builder", "build", None, workspace.path(), tx)
            .await;

        assert!(result.is_err());
        assert!(matches!(result, Err(AgentError::TurnFailed { .. })));
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core agent::tests`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs
git commit -m "feat: AcpAgentRunner with full worker loop — hooks, handshake, multi-turn, EnsembleConfig"
```

---

### Task 4: Orchestrator State

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`

- [ ] **Step 1: Write the OrchestratorState struct and methods**

Replace `crates/ensemble-core/src/orchestrator/state.rs` with:

```rust
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::pipeline::engine::PipelineRun;
use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};

/// Rate limit snapshot from agent events.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RateLimitSnapshot {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset_at: Option<String>,
}

/// The single authoritative in-memory state owned by the orchestrator.
/// All state mutations are serialized through the orchestrator's event loop.
#[derive(Debug)]
pub struct OrchestratorState {
    /// Current effective poll interval.
    pub poll_interval_ms: u64,
    /// Current effective global concurrency limit.
    pub max_concurrent_agents: u32,
    /// Running sessions: issue_id -> RunningEntry.
    pub running: HashMap<String, RunningEntry>,
    /// Claimed issue IDs (reserved/running/retrying).
    pub claimed: HashSet<String>,
    /// Pending retries: issue_id -> RetryEntry.
    pub retry_attempts: HashMap<String, RetryEntry>,
    /// Completed issue IDs (bookkeeping only).
    pub completed: HashSet<String>,
    /// Aggregate token counts and runtime seconds.
    pub agent_totals: AgentTotals,
    /// Latest rate limit snapshot from agent events.
    pub agent_rate_limits: Option<RateLimitSnapshot>,
    /// Active pipeline runs: issue_id -> PipelineRun.
    pub pipeline_runs: HashMap<String, PipelineRun>,
}

impl OrchestratorState {
    /// Create a new OrchestratorState with the given config values.
    pub fn new(poll_interval_ms: u64, max_concurrent_agents: u32) -> Self {
        Self {
            poll_interval_ms,
            max_concurrent_agents,
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            completed: HashSet::new(),
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
            pipeline_runs: HashMap::new(),
        }
    }

    /// Add a running entry for a dispatched issue.
    pub fn add_running(&mut self, issue: &Issue, attempt: Option<u32>) {
        let entry = RunningEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            issue: issue.clone(),
            session_id: None,
            agent_pid: None,
            last_agent_event: None,
            last_agent_timestamp: None,
            last_agent_message: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            last_reported_input_tokens: 0,
            last_reported_output_tokens: 0,
            last_reported_total_tokens: 0,
            turn_count: 0,
            retry_attempt: attempt,
            started_at: Utc::now(),
        };
        self.running.insert(issue.id.clone(), entry);
        self.claimed.insert(issue.id.clone());
        // Remove from retry if present
        self.retry_attempts.remove(&issue.id);
    }

    /// Remove a running entry and return it. Returns None if not found.
    pub fn remove_running(&mut self, issue_id: &str) -> Option<RunningEntry> {
        self.running.remove(issue_id)
    }

    /// Add an issue ID to the claimed set.
    pub fn add_claimed(&mut self, issue_id: &str) {
        self.claimed.insert(issue_id.to_string());
    }

    /// Remove an issue ID from the claimed set.
    pub fn remove_claimed(&mut self, issue_id: &str) {
        self.claimed.remove(issue_id);
    }

    /// Check if an issue is claimed.
    pub fn is_claimed(&self, issue_id: &str) -> bool {
        self.claimed.contains(issue_id)
    }

    /// Check if an issue is running.
    pub fn is_running(&self, issue_id: &str) -> bool {
        self.running.contains_key(issue_id)
    }

    /// Add a retry entry.
    pub fn add_retry(&mut self, entry: RetryEntry) {
        self.claimed.insert(entry.issue_id.clone());
        self.retry_attempts.insert(entry.issue_id.clone(), entry);
    }

    /// Remove a retry entry and return it.
    pub fn remove_retry(&mut self, issue_id: &str) -> Option<RetryEntry> {
        self.retry_attempts.remove(issue_id)
    }

    /// Release a claim entirely (remove from claimed, running, and retry).
    pub fn release_claim(&mut self, issue_id: &str) {
        self.claimed.remove(issue_id);
        self.running.remove(issue_id);
        self.retry_attempts.remove(issue_id);
    }

    /// Update session metadata on a running entry.
    pub fn update_session_info(
        &mut self,
        issue_id: &str,
        session_id: &str,
        agent_pid: Option<&str>,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.session_id = Some(session_id.to_string());
            entry.agent_pid = agent_pid.map(|s| s.to_string());
        }
    }

    /// Update the last agent event on a running entry.
    pub fn update_agent_event(
        &mut self,
        issue_id: &str,
        event_name: &str,
        message: Option<&str>,
        timestamp: DateTime<Utc>,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.last_agent_event = Some(event_name.to_string());
            entry.last_agent_timestamp = Some(timestamp);
            if let Some(msg) = message {
                entry.last_agent_message = Some(msg.chars().take(200).collect());
            }
        }
    }

    /// Increment turn count on a running entry.
    pub fn increment_turn_count(&mut self, issue_id: &str) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.turn_count += 1;
        }
    }

    /// Update token usage on a running entry using absolute totals.
    /// Computes deltas from last reported to update aggregate totals.
    pub fn update_token_usage(
        &mut self,
        issue_id: &str,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    ) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            // Compute deltas from last reported absolute totals
            let input_delta = input_tokens.saturating_sub(entry.last_reported_input_tokens);
            let output_delta = output_tokens.saturating_sub(entry.last_reported_output_tokens);
            let total_delta = total_tokens.saturating_sub(entry.last_reported_total_tokens);

            // Update entry absolute values
            entry.agent_input_tokens = input_tokens;
            entry.agent_output_tokens = output_tokens;
            entry.agent_total_tokens = total_tokens;

            // Update last reported
            entry.last_reported_input_tokens = input_tokens;
            entry.last_reported_output_tokens = output_tokens;
            entry.last_reported_total_tokens = total_tokens;

            // Add deltas to aggregate totals
            self.agent_totals.input_tokens += input_delta;
            self.agent_totals.output_tokens += output_delta;
            self.agent_totals.total_tokens += total_delta;
        }
    }

    /// Add runtime seconds from a completed running entry to the aggregate totals.
    pub fn add_runtime_seconds(&mut self, entry: &RunningEntry) {
        let elapsed = Utc::now()
            .signed_duration_since(entry.started_at)
            .num_milliseconds() as f64
            / 1000.0;
        self.agent_totals.seconds_running += elapsed;
    }

    /// Update the issue snapshot on a running entry.
    pub fn update_issue_snapshot(&mut self, issue_id: &str, issue: Issue) {
        if let Some(entry) = self.running.get_mut(issue_id) {
            entry.issue = issue;
        }
    }

    /// Get the count of currently running agents.
    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    /// Get the count of running agents in a specific state (lowercased).
    pub fn running_count_in_state(&self, state: &str) -> usize {
        let state_lower = state.to_lowercase();
        self.running
            .values()
            .filter(|e| e.issue.state.to_lowercase() == state_lower)
            .count()
    }

    /// Get all running issue IDs.
    pub fn running_issue_ids(&self) -> Vec<String> {
        self.running.keys().cloned().collect()
    }

    /// Get an immutable reference to a pipeline run.
    pub fn get_pipeline_run(&self, issue_id: &str) -> Option<&PipelineRun> {
        self.pipeline_runs.get(issue_id)
    }

    /// Get a mutable reference to a pipeline run.
    pub fn get_pipeline_run_mut(&mut self, issue_id: &str) -> Option<&mut PipelineRun> {
        self.pipeline_runs.get_mut(issue_id)
    }

    /// Insert a pipeline run for an issue.
    pub fn insert_pipeline_run(&mut self, issue_id: &str, run: PipelineRun) {
        self.pipeline_runs.insert(issue_id.to_string(), run);
    }

    /// Remove and return a pipeline run.
    pub fn remove_pipeline_run(&mut self, issue_id: &str) -> Option<PipelineRun> {
        self.pipeline_runs.remove(issue_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_new_state() {
        let state = OrchestratorState::new(30000, 10);
        assert_eq!(state.poll_interval_ms, 30000);
        assert_eq!(state.max_concurrent_agents, 10);
        assert!(state.running.is_empty());
        assert!(state.claimed.is_empty());
        assert!(state.retry_attempts.is_empty());
        assert!(state.completed.is_empty());
        assert_eq!(state.agent_totals.total_tokens, 0);
        assert!(state.pipeline_runs.is_empty());
    }

    #[test]
    fn test_add_running() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);

        assert!(state.is_running("1"));
        assert!(state.is_claimed("1"));
        assert_eq!(state.running_count(), 1);
    }

    #[test]
    fn test_remove_running() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);
        let entry = state.remove_running("1");

        assert!(entry.is_some());
        assert!(!state.is_running("1"));
        // claimed is NOT removed by remove_running
        assert!(state.is_claimed("1"));
    }

    #[test]
    fn test_release_claim() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        state.add_running(&issue, None);
        state.release_claim("1");

        assert!(!state.is_running("1"));
        assert!(!state.is_claimed("1"));
    }

    #[test]
    fn test_add_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
        };

        state.add_retry(retry);

        assert!(state.is_claimed("1"));
        assert!(state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_remove_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
        };

        state.add_retry(retry);
        let removed = state.remove_retry("1");

        assert!(removed.is_some());
        assert!(!state.retry_attempts.contains_key("1"));
    }

    #[test]
    fn test_update_session_info() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.update_session_info("1", "session-abc", Some("12345"));

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.session_id.as_deref(), Some("session-abc"));
        assert_eq!(entry.agent_pid.as_deref(), Some("12345"));
    }

    #[test]
    fn test_update_agent_event() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        let ts = Utc::now();
        state.update_agent_event("1", "turn_completed", Some("done with tests"), ts);

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.last_agent_event.as_deref(), Some("turn_completed"));
        assert_eq!(
            entry.last_agent_message.as_deref(),
            Some("done with tests")
        );
        assert!(entry.last_agent_timestamp.is_some());
    }

    #[test]
    fn test_increment_turn_count() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        state.increment_turn_count("1");
        state.increment_turn_count("1");

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.turn_count, 2);
    }

    #[test]
    fn test_update_token_usage_with_deltas() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // First update: absolute = 100/50/150
        state.update_token_usage("1", 100, 50, 150);
        assert_eq!(state.agent_totals.input_tokens, 100);
        assert_eq!(state.agent_totals.output_tokens, 50);
        assert_eq!(state.agent_totals.total_tokens, 150);

        // Second update: absolute = 200/100/300 (delta = 100/50/150)
        state.update_token_usage("1", 200, 100, 300);
        assert_eq!(state.agent_totals.input_tokens, 200);
        assert_eq!(state.agent_totals.output_tokens, 100);
        assert_eq!(state.agent_totals.total_tokens, 300);

        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.agent_input_tokens, 200);
        assert_eq!(entry.agent_output_tokens, 100);
        assert_eq!(entry.agent_total_tokens, 300);
    }

    #[test]
    fn test_running_count_in_state() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("1", "Todo"), None);
        state.add_running(&test_issue("2", "Todo"), None);
        state.add_running(&test_issue("3", "In Progress"), None);

        assert_eq!(state.running_count_in_state("todo"), 2);
        assert_eq!(state.running_count_in_state("in progress"), 1);
        assert_eq!(state.running_count_in_state("Done"), 0);
    }

    #[test]
    fn test_running_issue_ids() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("a", "Todo"), None);
        state.add_running(&test_issue("b", "Todo"), None);

        let mut ids = state.running_issue_ids();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn test_add_running_clears_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let retry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 2,
            due_at_ms: 5000,
            error: Some("previous error".to_string()),
        };
        state.add_retry(retry);
        assert!(state.retry_attempts.contains_key("1"));

        state.add_running(&test_issue("1", "Todo"), Some(2));
        assert!(!state.retry_attempts.contains_key("1"));
        assert!(state.is_running("1"));
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core orchestrator::state`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/state.rs
git commit -m "feat: OrchestratorState with running/claimed/retry management and token accounting"
```

---

### Task 5: Candidate Selection + Dispatch Priority

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/scheduler.rs`

- [ ] **Step 1: Write the scheduler module**

Replace `crates/ensemble-core/src/orchestrator/scheduler.rs` with:

```rust
use std::collections::HashMap;

use tracing::{debug, info};

use crate::tracker::model::Issue;
use super::state::OrchestratorState;

/// Check if an issue is eligible for dispatch.
/// Returns None if eligible, or Some(reason) explaining why not.
pub fn is_dispatch_eligible(
    issue: &Issue,
    state: &OrchestratorState,
    active_states: &[String],
    terminal_states: &[String],
    max_concurrent_by_state: &HashMap<String, u32>,
) -> Option<String> {
    // Must have required fields
    if issue.id.is_empty() {
        return Some("missing issue id".to_string());
    }
    if issue.identifier.is_empty() {
        return Some("missing issue identifier".to_string());
    }
    if issue.title.is_empty() {
        return Some("missing issue title".to_string());
    }
    if issue.state.is_empty() {
        return Some("missing issue state".to_string());
    }

    let state_lower = issue.state.to_lowercase();

    // Must be in active states
    let active_lower: Vec<String> = active_states.iter().map(|s| s.to_lowercase()).collect();
    if !active_lower.contains(&state_lower) {
        return Some(format!("state '{}' not in active states", issue.state));
    }

    // Must NOT be in terminal states
    let terminal_lower: Vec<String> = terminal_states.iter().map(|s| s.to_lowercase()).collect();
    if terminal_lower.contains(&state_lower) {
        return Some(format!("state '{}' is terminal", issue.state));
    }

    // Must not already be running
    if state.is_running(&issue.id) {
        return Some("already running".to_string());
    }

    // Must not already be claimed
    if state.is_claimed(&issue.id) {
        return Some("already claimed".to_string());
    }

    // Global concurrency check
    if available_global_slots(state) == 0 {
        return Some("no global slots available".to_string());
    }

    // Per-state concurrency check
    if available_state_slots(state, max_concurrent_by_state, &issue.state) == 0 {
        return Some(format!(
            "no slots available for state '{}'",
            issue.state
        ));
    }

    // Blocker rule: Todo issues with non-terminal blockers are not eligible
    if state_lower == "todo" && !issue.blocked_by.is_empty() {
        let has_non_terminal_blocker = issue.blocked_by.iter().any(|blocker| {
            if let Some(ref blocker_state) = blocker.state {
                !terminal_lower.contains(&blocker_state.to_lowercase())
            } else {
                // Unknown state — treat as non-terminal (conservative)
                true
            }
        });
        if has_non_terminal_blocker {
            return Some("blocked by non-terminal issue".to_string());
        }
    }

    None
}

/// Sort issues for dispatch priority.
/// 1. priority ascending (lower number = higher priority; null sorts last)
/// 2. created_at oldest first (null sorts last)
/// 3. identifier lexicographic tiebreaker
pub fn sort_for_dispatch(issues: &mut [Issue]) {
    issues.sort_by(|a, b| {
        // Priority: ascending, None sorts last
        let pa = a.priority.unwrap_or(i32::MAX);
        let pb = b.priority.unwrap_or(i32::MAX);
        pa.cmp(&pb)
            .then_with(|| {
                // created_at: oldest first, None sorts last
                match (&a.created_at, &b.created_at) {
                    (Some(ca), Some(cb)) => ca.cmp(cb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            })
            .then_with(|| a.identifier.cmp(&b.identifier))
    });
}

/// Calculate available global dispatch slots.
pub fn available_global_slots(state: &OrchestratorState) -> u32 {
    let running = state.running_count() as u32;
    state.max_concurrent_agents.saturating_sub(running)
}

/// Calculate available slots for a specific issue state.
pub fn available_state_slots(
    state: &OrchestratorState,
    max_concurrent_by_state: &HashMap<String, u32>,
    issue_state: &str,
) -> u32 {
    let state_lower = issue_state.to_lowercase();

    if let Some(&cap) = max_concurrent_by_state.get(&state_lower) {
        let running_in_state = state.running_count_in_state(&state_lower) as u32;
        cap.saturating_sub(running_in_state)
    } else {
        // No per-state cap — fallback to global
        available_global_slots(state)
    }
}

/// Check if there are any available global slots.
pub fn has_available_slots(state: &OrchestratorState) -> bool {
    available_global_slots(state) > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::model::BlockerRef;
    use chrono::{TimeZone, Utc};

    fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: Some(Utc::now()),
            updated_at: None,
        }
    }

    fn default_active() -> Vec<String> {
        vec!["Todo".to_string(), "In Progress".to_string()]
    }

    fn default_terminal() -> Vec<String> {
        vec!["Done".to_string(), "Closed".to_string()]
    }

    #[test]
    fn test_eligible_issue() {
        let state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_none(), "expected eligible, got: {:?}", result);
    }

    #[test]
    fn test_ineligible_missing_id() {
        let state = OrchestratorState::new(30000, 10);
        let mut issue = test_issue("", "Todo");
        issue.id = "".to_string();

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("missing issue id"));
    }

    #[test]
    fn test_ineligible_wrong_state() {
        let state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Backlog");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("not in active states"));
    }

    #[test]
    fn test_ineligible_terminal_state() {
        let state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Done");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
    }

    #[test]
    fn test_ineligible_already_running() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("already running"));
    }

    #[test]
    fn test_ineligible_already_claimed() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_claimed("1");

        let issue = test_issue("1", "Todo");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("already claimed"));
    }

    #[test]
    fn test_ineligible_no_global_slots() {
        let mut state = OrchestratorState::new(30000, 1);
        state.add_running(&test_issue("existing", "Todo"), None);

        let issue = test_issue("new", "Todo");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("no global slots"));
    }

    #[test]
    fn test_ineligible_no_state_slots() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("existing", "Todo"), None);

        let mut by_state = HashMap::new();
        by_state.insert("todo".to_string(), 1);

        let issue = test_issue("new", "Todo");

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &by_state,
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("no slots available for state"));
    }

    #[test]
    fn test_ineligible_todo_with_non_terminal_blocker() {
        let state = OrchestratorState::new(30000, 10);
        let mut issue = test_issue("1", "Todo");
        issue.blocked_by = vec![BlockerRef {
            id: Some("blocker-1".to_string()),
            identifier: Some("repo#99".to_string()),
            state: Some("In Progress".to_string()),
        }];

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_some());
        assert!(result.unwrap().contains("blocked by non-terminal"));
    }

    #[test]
    fn test_eligible_todo_with_terminal_blocker() {
        let state = OrchestratorState::new(30000, 10);
        let mut issue = test_issue("1", "Todo");
        issue.blocked_by = vec![BlockerRef {
            id: Some("blocker-1".to_string()),
            identifier: Some("repo#99".to_string()),
            state: Some("Done".to_string()),
        }];

        let result = is_dispatch_eligible(
            &issue,
            &state,
            &default_active(),
            &default_terminal(),
            &HashMap::new(),
        );
        assert!(result.is_none(), "expected eligible with terminal blocker");
    }

    #[test]
    fn test_sort_by_priority_then_created_at() {
        let t1 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let t2 = Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap();

        let mut issues = vec![
            Issue {
                id: "c".to_string(),
                identifier: "repo#c".to_string(),
                title: "C".to_string(),
                description: None,
                priority: Some(3),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t1),
                updated_at: None,
            },
            Issue {
                id: "a".to_string(),
                identifier: "repo#a".to_string(),
                title: "A".to_string(),
                description: None,
                priority: Some(1),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t2),
                updated_at: None,
            },
            Issue {
                id: "b".to_string(),
                identifier: "repo#b".to_string(),
                title: "B".to_string(),
                description: None,
                priority: Some(1),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t1),
                updated_at: None,
            },
        ];

        sort_for_dispatch(&mut issues);

        // Priority 1 first, then oldest created_at, then identifier
        assert_eq!(issues[0].id, "b"); // priority 1, older
        assert_eq!(issues[1].id, "a"); // priority 1, newer
        assert_eq!(issues[2].id, "c"); // priority 3
    }

    #[test]
    fn test_sort_null_priority_last() {
        let mut issues = vec![
            Issue {
                id: "no-pri".to_string(),
                identifier: "repo#no-pri".to_string(),
                title: "No priority".to_string(),
                description: None,
                priority: None,
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(Utc::now()),
                updated_at: None,
            },
            Issue {
                id: "has-pri".to_string(),
                identifier: "repo#has-pri".to_string(),
                title: "Has priority".to_string(),
                description: None,
                priority: Some(4),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(Utc::now()),
                updated_at: None,
            },
        ];

        sort_for_dispatch(&mut issues);

        assert_eq!(issues[0].id, "has-pri");
        assert_eq!(issues[1].id, "no-pri");
    }

    #[test]
    fn test_available_global_slots() {
        let mut state = OrchestratorState::new(30000, 3);
        assert_eq!(available_global_slots(&state), 3);

        state.add_running(&test_issue("1", "Todo"), None);
        assert_eq!(available_global_slots(&state), 2);

        state.add_running(&test_issue("2", "Todo"), None);
        state.add_running(&test_issue("3", "Todo"), None);
        assert_eq!(available_global_slots(&state), 0);
    }

    #[test]
    fn test_available_state_slots_with_cap() {
        let mut state = OrchestratorState::new(30000, 10);
        state.add_running(&test_issue("1", "Todo"), None);

        let mut by_state = HashMap::new();
        by_state.insert("todo".to_string(), 2);

        assert_eq!(available_state_slots(&state, &by_state, "Todo"), 1);
        assert_eq!(
            available_state_slots(&state, &by_state, "In Progress"),
            10
        ); // no cap, falls back to global
    }

    #[test]
    fn test_available_state_slots_no_cap() {
        let state = OrchestratorState::new(30000, 5);

        let by_state = HashMap::new();
        assert_eq!(available_state_slots(&state, &by_state, "Todo"), 5);
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core orchestrator::scheduler`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/scheduler.rs
git commit -m "feat: dispatch scheduler with eligibility rules, priority sorting, and concurrency control"
```

---

### Task 6: Retry Logic

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/retry.rs`

- [ ] **Step 1: Write the retry module**

Replace `crates/ensemble-core/src/orchestrator/retry.rs` with:

```rust
use tracing::{debug, info, warn};

use crate::tracker::model::RetryEntry;
use super::state::OrchestratorState;

/// Continuation retry delay in milliseconds (after clean worker exit).
pub const CONTINUATION_RETRY_DELAY_MS: u64 = 1000;

/// Base delay for failure-driven exponential backoff.
pub const FAILURE_BASE_DELAY_MS: u64 = 10000;

/// Calculate exponential backoff delay for a failure retry.
/// Formula: min(10000 * 2^(attempt - 1), max_backoff_ms)
pub fn calculate_backoff(attempt: u32, max_backoff_ms: u64) -> u64 {
    if attempt == 0 {
        return FAILURE_BASE_DELAY_MS;
    }
    let exponent = (attempt - 1).min(31); // prevent overflow
    let delay = FAILURE_BASE_DELAY_MS.saturating_mul(1u64 << exponent);
    delay.min(max_backoff_ms)
}

/// Schedule a continuation retry (after normal worker exit).
/// Uses a short fixed delay of 1 second.
pub fn schedule_continuation_retry(
    state: &mut OrchestratorState,
    issue_id: &str,
    identifier: &str,
) -> u64 {
    let due_at_ms = current_time_ms() + CONTINUATION_RETRY_DELAY_MS;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt: 1,
        due_at_ms,
        error: None,
    };

    info!(
        issue_id = issue_id,
        identifier = identifier,
        delay_ms = CONTINUATION_RETRY_DELAY_MS,
        "scheduling continuation retry"
    );

    state.add_retry(entry);
    due_at_ms
}

/// Schedule a failure retry with exponential backoff.
pub fn schedule_failure_retry(
    state: &mut OrchestratorState,
    issue_id: &str,
    identifier: &str,
    attempt: u32,
    max_backoff_ms: u64,
    error: &str,
) -> u64 {
    let delay = calculate_backoff(attempt, max_backoff_ms);
    let due_at_ms = current_time_ms() + delay;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt,
        due_at_ms,
        error: Some(error.to_string()),
    };

    info!(
        issue_id = issue_id,
        identifier = identifier,
        attempt = attempt,
        delay_ms = delay,
        error = error,
        "scheduling failure retry"
    );

    state.add_retry(entry);
    due_at_ms
}

/// Determine the next attempt number from a running entry.
/// If the entry had a retry_attempt, increment it; otherwise start at 1.
pub fn next_attempt(current: Option<u32>) -> u32 {
    current.map(|a| a + 1).unwrap_or(1)
}

/// Get the current time in milliseconds (monotonic-ish for retry scheduling).
pub fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check if a retry entry is due (its due time has passed).
pub fn is_retry_due(entry: &RetryEntry) -> bool {
    current_time_ms() >= entry.due_at_ms
}

/// Get all due retries from the state, sorted by due time.
pub fn get_due_retries(state: &OrchestratorState) -> Vec<RetryEntry> {
    let now = current_time_ms();
    let mut due: Vec<RetryEntry> = state
        .retry_attempts
        .values()
        .filter(|e| now >= e.due_at_ms)
        .cloned()
        .collect();
    due.sort_by_key(|e| e.due_at_ms);
    due
}

/// Get the next retry fire time (earliest due_at_ms) if any retries exist.
pub fn next_retry_time(state: &OrchestratorState) -> Option<u64> {
    state
        .retry_attempts
        .values()
        .map(|e| e.due_at_ms)
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_backoff_attempt_1() {
        let delay = calculate_backoff(1, 300_000);
        assert_eq!(delay, 10_000); // 10000 * 2^0 = 10000
    }

    #[test]
    fn test_calculate_backoff_attempt_2() {
        let delay = calculate_backoff(2, 300_000);
        assert_eq!(delay, 20_000); // 10000 * 2^1 = 20000
    }

    #[test]
    fn test_calculate_backoff_attempt_3() {
        let delay = calculate_backoff(3, 300_000);
        assert_eq!(delay, 40_000); // 10000 * 2^2 = 40000
    }

    #[test]
    fn test_calculate_backoff_attempt_4() {
        let delay = calculate_backoff(4, 300_000);
        assert_eq!(delay, 80_000); // 10000 * 2^3 = 80000
    }

    #[test]
    fn test_calculate_backoff_capped() {
        let delay = calculate_backoff(10, 300_000);
        assert_eq!(delay, 300_000); // capped at max
    }

    #[test]
    fn test_calculate_backoff_high_attempt_no_overflow() {
        let delay = calculate_backoff(100, 300_000);
        assert_eq!(delay, 300_000); // capped, no overflow
    }

    #[test]
    fn test_calculate_backoff_attempt_0() {
        let delay = calculate_backoff(0, 300_000);
        assert_eq!(delay, 10_000); // base delay
    }

    #[test]
    fn test_schedule_continuation_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let due = schedule_continuation_retry(&mut state, "issue-1", "repo#1");

        assert!(state.retry_attempts.contains_key("issue-1"));
        assert!(state.is_claimed("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(entry.attempt, 1);
        assert!(entry.error.is_none());
        assert!(due > 0);
    }

    #[test]
    fn test_schedule_failure_retry() {
        let mut state = OrchestratorState::new(30000, 10);

        let due = schedule_failure_retry(
            &mut state,
            "issue-1",
            "repo#1",
            2,
            300_000,
            "agent crashed",
        );

        assert!(state.retry_attempts.contains_key("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(entry.attempt, 2);
        assert_eq!(entry.error.as_deref(), Some("agent crashed"));
        assert!(due > 0);
    }

    #[test]
    fn test_next_attempt() {
        assert_eq!(next_attempt(None), 1);
        assert_eq!(next_attempt(Some(1)), 2);
        assert_eq!(next_attempt(Some(5)), 6);
    }

    #[test]
    fn test_is_retry_due() {
        let past_entry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0, // in the past
            error: None,
        };
        assert!(is_retry_due(&past_entry));

        let future_entry = RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
        };
        assert!(!is_retry_due(&future_entry));
    }

    #[test]
    fn test_get_due_retries() {
        let mut state = OrchestratorState::new(30000, 10);

        // One due retry (in the past)
        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
        });

        // One future retry
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
        });

        let due = get_due_retries(&state);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].issue_id, "1");
    }

    #[test]
    fn test_next_retry_time() {
        let mut state = OrchestratorState::new(30000, 10);
        assert_eq!(next_retry_time(&state), None);

        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
        });
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: 3000,
            error: None,
        });

        assert_eq!(next_retry_time(&state), Some(3000));
    }

    #[test]
    fn test_backoff_progression() {
        let max = 300_000u64;
        let delays: Vec<u64> = (1..=8).map(|a| calculate_backoff(a, max)).collect();
        assert_eq!(
            delays,
            vec![10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
        );
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core orchestrator::retry`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/retry.rs
git commit -m "feat: retry logic with exponential backoff, continuation retries, and due-time scheduling"
```

---

### Task 7: Reconciliation

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/reconciler.rs`

- [ ] **Step 1: Write the reconciler module**

Replace `crates/ensemble-core/src/orchestrator/reconciler.rs` with:

```rust
use chrono::Utc;
use tracing::{debug, info, warn};

use crate::tracker::model::Issue;
use crate::tracker::IssueTracker;
use crate::workspace::manager::WorkspaceManager;
use super::retry;
use super::state::OrchestratorState;

/// Result of reconciling stalled runs.
pub struct StallReconcileResult {
    pub stalled_count: usize,
    pub stalled_issue_ids: Vec<String>,
}

/// Reconcile stalled runs: check elapsed time since last event and flag stalled workers.
/// Returns the list of stalled issue IDs (the caller is responsible for killing them).
pub fn reconcile_stalled_runs(
    state: &OrchestratorState,
    stall_timeout_ms: i64,
) -> StallReconcileResult {
    // If stall_timeout_ms <= 0, stall detection is disabled
    if stall_timeout_ms <= 0 {
        return StallReconcileResult {
            stalled_count: 0,
            stalled_issue_ids: vec![],
        };
    }

    let now = Utc::now();
    let mut stalled = Vec::new();

    for (issue_id, entry) in &state.running {
        let reference_time = entry
            .last_agent_timestamp
            .unwrap_or(entry.started_at);
        let elapsed_ms = now
            .signed_duration_since(reference_time)
            .num_milliseconds();

        if elapsed_ms > stall_timeout_ms {
            info!(
                issue_id = %issue_id,
                identifier = %entry.identifier,
                elapsed_ms = elapsed_ms,
                stall_timeout_ms = stall_timeout_ms,
                "detected stalled run"
            );
            stalled.push(issue_id.clone());
        }
    }

    StallReconcileResult {
        stalled_count: stalled.len(),
        stalled_issue_ids: stalled,
    }
}

/// Action to take for a running issue based on its refreshed tracker state.
#[derive(Debug, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Issue is still in active state — update the snapshot.
    UpdateSnapshot(Issue),
    /// Issue is in a terminal state — terminate worker and clean workspace.
    TerminateAndCleanup(Issue),
    /// Issue is in a non-active, non-terminal state — terminate worker without cleanup.
    TerminateNoCleanup(Issue),
}

/// Determine the reconcile action for a single refreshed issue.
pub fn determine_reconcile_action(
    issue: &Issue,
    active_states: &[String],
    terminal_states: &[String],
) -> ReconcileAction {
    let state_lower = issue.state.to_lowercase();
    let terminal_lower: Vec<String> = terminal_states.iter().map(|s| s.to_lowercase()).collect();
    let active_lower: Vec<String> = active_states.iter().map(|s| s.to_lowercase()).collect();

    if terminal_lower.contains(&state_lower) {
        ReconcileAction::TerminateAndCleanup(issue.clone())
    } else if active_lower.contains(&state_lower) {
        ReconcileAction::UpdateSnapshot(issue.clone())
    } else {
        ReconcileAction::TerminateNoCleanup(issue.clone())
    }
}

/// Perform tracker state refresh reconciliation.
/// Returns lists of actions categorized by type.
pub async fn reconcile_tracker_states(
    state: &OrchestratorState,
    tracker: &dyn IssueTracker,
    active_states: &[String],
    terminal_states: &[String],
) -> ReconcileTrackerResult {
    let running_ids = state.running_issue_ids();
    if running_ids.is_empty() {
        return ReconcileTrackerResult {
            updates: vec![],
            terminate_cleanup: vec![],
            terminate_no_cleanup: vec![],
            refresh_failed: false,
        };
    }

    let refreshed = match tracker.fetch_issue_states_by_ids(&running_ids).await {
        Ok(issues) => issues,
        Err(e) => {
            warn!(
                error = %e,
                "tracker state refresh failed, keeping workers running"
            );
            return ReconcileTrackerResult {
                updates: vec![],
                terminate_cleanup: vec![],
                terminate_no_cleanup: vec![],
                refresh_failed: true,
            };
        }
    };

    let mut updates = Vec::new();
    let mut terminate_cleanup = Vec::new();
    let mut terminate_no_cleanup = Vec::new();

    for issue in refreshed {
        if !state.is_running(&issue.id) {
            continue;
        }

        match determine_reconcile_action(&issue, active_states, terminal_states) {
            ReconcileAction::UpdateSnapshot(i) => {
                debug!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue still active, updating snapshot"
                );
                updates.push(i);
            }
            ReconcileAction::TerminateAndCleanup(i) => {
                info!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue terminal, terminating and cleaning workspace"
                );
                terminate_cleanup.push(i);
            }
            ReconcileAction::TerminateNoCleanup(i) => {
                info!(
                    issue_id = %i.id,
                    identifier = %i.identifier,
                    state = %i.state,
                    "issue no longer active, terminating without cleanup"
                );
                terminate_no_cleanup.push(i);
            }
        }
    }

    ReconcileTrackerResult {
        updates,
        terminate_cleanup,
        terminate_no_cleanup,
        refresh_failed: false,
    }
}

/// Result of tracker state reconciliation.
pub struct ReconcileTrackerResult {
    /// Issues still in active state — update their snapshots.
    pub updates: Vec<Issue>,
    /// Issues in terminal state — terminate and clean workspace.
    pub terminate_cleanup: Vec<Issue>,
    /// Issues in non-active/non-terminal state — terminate without cleanup.
    pub terminate_no_cleanup: Vec<Issue>,
    /// Whether the refresh call failed.
    pub refresh_failed: bool,
}

/// Perform startup terminal workspace cleanup.
pub async fn startup_terminal_cleanup(
    tracker: &dyn IssueTracker,
    terminal_states: &[String],
    workspace_mgr: &WorkspaceManager,
) {
    info!("performing startup terminal workspace cleanup");

    match tracker.fetch_issues_by_states(terminal_states).await {
        Ok(terminal_issues) => {
            for issue in &terminal_issues {
                match workspace_mgr.remove_workspace(&issue.identifier) {
                    Ok(()) => {
                        debug!(
                            identifier = %issue.identifier,
                            "cleaned terminal workspace"
                        );
                    }
                    Err(e) => {
                        warn!(
                            identifier = %issue.identifier,
                            error = %e,
                            "failed to clean terminal workspace"
                        );
                    }
                }
            }
            info!(
                count = terminal_issues.len(),
                "startup terminal cleanup complete"
            );
        }
        Err(e) => {
            warn!(
                error = %e,
                "startup terminal cleanup failed, continuing startup"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::model::BlockerRef;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;

    fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: Some(Utc::now()),
            updated_at: None,
        }
    }

    fn default_active() -> Vec<String> {
        vec!["Todo".to_string(), "In Progress".to_string()]
    }

    fn default_terminal() -> Vec<String> {
        vec!["Done".to_string(), "Closed".to_string()]
    }

    // --- Stall detection tests ---

    #[test]
    fn test_stall_detection_disabled() {
        let state = OrchestratorState::new(30000, 10);
        let result = reconcile_stalled_runs(&state, 0);
        assert_eq!(result.stalled_count, 0);

        let result2 = reconcile_stalled_runs(&state, -1);
        assert_eq!(result2.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_no_running() {
        let state = OrchestratorState::new(30000, 10);
        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_not_stalled() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);
        // started_at is now, so it won't be stalled with a large timeout
        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    #[test]
    fn test_stall_detection_stalled() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // Override started_at to be in the distant past
        if let Some(entry) = state.running.get_mut("1") {
            entry.started_at = Utc::now() - chrono::Duration::seconds(600);
        }

        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 1);
        assert_eq!(result.stalled_issue_ids, vec!["1"]);
    }

    #[test]
    fn test_stall_uses_last_agent_timestamp() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        // started_at is old, but last_agent_timestamp is recent
        if let Some(entry) = state.running.get_mut("1") {
            entry.started_at = Utc::now() - chrono::Duration::seconds(600);
            entry.last_agent_timestamp = Some(Utc::now());
        }

        let result = reconcile_stalled_runs(&state, 300_000);
        assert_eq!(result.stalled_count, 0);
    }

    // --- Reconcile action tests ---

    #[test]
    fn test_determine_action_active() {
        let issue = test_issue("1", "In Progress");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::UpdateSnapshot(_)));
    }

    #[test]
    fn test_determine_action_terminal() {
        let issue = test_issue("1", "Done");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateAndCleanup(_)));
    }

    #[test]
    fn test_determine_action_non_active_non_terminal() {
        let issue = test_issue("1", "Backlog");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateNoCleanup(_)));
    }

    #[test]
    fn test_determine_action_case_insensitive() {
        let issue = test_issue("1", "done");
        let action = determine_reconcile_action(&issue, &default_active(), &default_terminal());
        assert!(matches!(action, ReconcileAction::TerminateAndCleanup(_)));
    }

    // --- Tracker reconciliation tests ---

    struct MockTrackerForReconcile {
        issues: Vec<Issue>,
        should_fail: bool,
    }

    #[async_trait]
    impl IssueTracker for MockTrackerForReconcile {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.clone())
        }
        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            if self.should_fail {
                return Err(TrackerError::ApiRequestFailed {
                    reason: "mock failure".to_string(),
                });
            }
            let states_lower: Vec<String> = states.iter().map(|s| s.to_lowercase()).collect();
            Ok(self
                .issues
                .iter()
                .filter(|i| states_lower.contains(&i.state.to_lowercase()))
                .cloned()
                .collect())
        }
        async fn fetch_issue_states_by_ids(
            &self,
            ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            if self.should_fail {
                return Err(TrackerError::ApiRequestFailed {
                    reason: "mock failure".to_string(),
                });
            }
            Ok(self
                .issues
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect())
        }
    }

    #[tokio::test]
    async fn test_reconcile_tracker_no_running() {
        let state = OrchestratorState::new(30000, 10);
        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: false,
        };

        let result = reconcile_tracker_states(
            &state,
            &tracker,
            &default_active(),
            &default_terminal(),
        )
        .await;

        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
        assert!(!result.refresh_failed);
    }

    #[tokio::test]
    async fn test_reconcile_tracker_active_update() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "In Progress")],
            should_fail: false,
        };

        let result = reconcile_tracker_states(
            &state,
            &tracker,
            &default_active(),
            &default_terminal(),
        )
        .await;

        assert_eq!(result.updates.len(), 1);
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_reconcile_tracker_terminal_cleanup() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "Done")], // moved to terminal
            should_fail: false,
        };

        let result = reconcile_tracker_states(
            &state,
            &tracker,
            &default_active(),
            &default_terminal(),
        )
        .await;

        assert!(result.updates.is_empty());
        assert_eq!(result.terminate_cleanup.len(), 1);
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_reconcile_tracker_non_active_stop() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("1", "Backlog")], // moved to non-active
            should_fail: false,
        };

        let result = reconcile_tracker_states(
            &state,
            &tracker,
            &default_active(),
            &default_terminal(),
        )
        .await;

        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert_eq!(result.terminate_no_cleanup.len(), 1);
    }

    #[tokio::test]
    async fn test_reconcile_tracker_refresh_failed() {
        let mut state = OrchestratorState::new(30000, 10);
        let issue = test_issue("1", "In Progress");
        state.add_running(&issue, None);

        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: true,
        };

        let result = reconcile_tracker_states(
            &state,
            &tracker,
            &default_active(),
            &default_terminal(),
        )
        .await;

        assert!(result.refresh_failed);
        assert!(result.updates.is_empty());
        assert!(result.terminate_cleanup.is_empty());
        assert!(result.terminate_no_cleanup.is_empty());
    }

    #[tokio::test]
    async fn test_startup_terminal_cleanup() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();

        // Create a workspace
        workspace_mgr.prepare_workspace("repo#42").unwrap();
        assert!(dir.path().join("repo_42").exists());

        let tracker = MockTrackerForReconcile {
            issues: vec![test_issue("42", "Done")],
            should_fail: false,
        };

        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
        )
        .await;

        // Workspace should be cleaned up
        assert!(!dir.path().join("repo_42").exists());
    }

    #[tokio::test]
    async fn test_startup_terminal_cleanup_failure_continues() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();

        let tracker = MockTrackerForReconcile {
            issues: vec![],
            should_fail: true,
        };

        // Should not panic — just logs and continues
        startup_terminal_cleanup(
            &tracker,
            &default_terminal(),
            &workspace_mgr,
        )
        .await;
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core orchestrator::reconciler`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/reconciler.rs
git commit -m "feat: reconciler with stall detection, tracker state refresh, and startup terminal cleanup"
```

---

### Task 8: Orchestrator Main Loop

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Write the orchestrator struct and run() method**

Replace `crates/ensemble-core/src/orchestrator/mod.rs` with:

```rust
pub mod state;
pub mod scheduler;
pub mod retry;
pub mod reconciler;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{interval, sleep, Instant};
use tracing::{debug, error, info, warn};

use crate::agent::events::{AgentEvent, WorkerEvent, WorkerResult};
use crate::agent::AgentRunner;
use crate::config::ensemble::EnsembleConfig;
use crate::error::AgentError;
use crate::pipeline::dag::build_dag;
use crate::pipeline::engine::{PipelineAction, PipelineRun};
use crate::pipeline::verdict::resolve_verdict;
use crate::tracker::model::Issue;
use crate::tracker::IssueTracker;
use crate::workspace::manager::WorkspaceManager;

use reconciler::{reconcile_stalled_runs, reconcile_tracker_states, startup_terminal_cleanup};
use retry::{
    calculate_backoff, current_time_ms, get_due_retries, next_attempt,
    schedule_continuation_retry, schedule_failure_retry, CONTINUATION_RETRY_DELAY_MS,
};
use scheduler::{
    available_global_slots, has_available_slots, is_dispatch_eligible, sort_for_dispatch,
};
use state::OrchestratorState;

/// The main orchestrator that manages the poll-dispatch-reconcile loop.
pub struct Orchestrator {
    state: Arc<RwLock<OrchestratorState>>,
    config: Arc<RwLock<EnsembleConfig>>,
    tracker: Arc<dyn IssueTracker>,
    agent_runner: Arc<dyn AgentRunner>,
    workspace_mgr: Arc<WorkspaceManager>,
    worker_tx: mpsc::Sender<WorkerEvent>,
    worker_rx: mpsc::Receiver<WorkerEvent>,
    shutdown_rx: mpsc::Receiver<()>,
}

impl Orchestrator {
    /// Create a new Orchestrator.
    pub fn new(
        config: Arc<RwLock<EnsembleConfig>>,
        tracker: Arc<dyn IssueTracker>,
        agent_runner: Arc<dyn AgentRunner>,
        workspace_mgr: WorkspaceManager,
        shutdown_rx: mpsc::Receiver<()>,
    ) -> Self {
        let (worker_tx, worker_rx) = mpsc::channel(1000);

        let cfg = {
            // This is sync-safe because we're in new(), not yet in async context.
            // We'll read the config in the run() method properly.
            // For initialization, use defaults.
            OrchestratorState::new(30_000, 10)
        };

        Self {
            state: Arc::new(RwLock::new(cfg)),
            config,
            tracker,
            agent_runner,
            workspace_mgr: Arc::new(workspace_mgr),
            worker_tx,
            worker_rx,
            shutdown_rx,
        }
    }

    /// Get a reference to the orchestrator state for API consumers.
    pub fn state(&self) -> Arc<RwLock<OrchestratorState>> {
        Arc::clone(&self.state)
    }

    /// Get the worker event sender for spawning workers.
    pub fn worker_tx(&self) -> mpsc::Sender<WorkerEvent> {
        self.worker_tx.clone()
    }

    /// Run the orchestrator main loop.
    pub async fn run(&mut self) {
        // Initialize state from config
        {
            let config = self.config.read().await;
            let mut state = self.state.write().await;
            state.poll_interval_ms = config.polling.interval_ms;
            state.max_concurrent_agents = config.concurrency.max_concurrent_agents;
        }

        // Startup terminal workspace cleanup
        {
            let config = self.config.read().await;
            startup_terminal_cleanup(
                self.tracker.as_ref(),
                &config.tracker.terminal_states,
                &self.workspace_mgr,
            )
            .await;
        }

        info!("orchestrator started, entering main loop");

        // Immediate first tick
        self.handle_tick().await;

        // Main event loop
        loop {
            let poll_interval = {
                let state = self.state.read().await;
                Duration::from_millis(state.poll_interval_ms)
            };

            // Calculate next retry sleep duration
            let retry_sleep = {
                let state = self.state.read().await;
                retry::next_retry_time(&state).map(|due_at| {
                    let now = current_time_ms();
                    if due_at <= now {
                        Duration::from_millis(0)
                    } else {
                        Duration::from_millis(due_at - now)
                    }
                })
            };

            tokio::select! {
                // Poll timer
                _ = sleep(poll_interval) => {
                    debug!("poll tick");
                    self.handle_tick().await;
                }

                // Worker events
                Some(event) = self.worker_rx.recv() => {
                    self.handle_worker_event(event).await;
                }

                // Retry timer (if any)
                _ = async {
                    match retry_sleep {
                        Some(d) => sleep(d).await,
                        None => futures::future::pending::<()>().await,
                    }
                } => {
                    debug!("retry timer fired");
                    self.handle_retry_fires().await;
                }

                // Shutdown signal
                _ = self.shutdown_rx.recv() => {
                    info!("received shutdown signal, stopping orchestrator");
                    break;
                }
            }
        }

        info!("orchestrator stopped");
    }

    /// Handle a poll tick: reconcile, validate, fetch, dispatch.
    async fn handle_tick(&self) {
        // 1. Reconcile stalled runs
        let stall_timeout_ms = {
            let config = self.config.read().await;
            config.agent.stall_timeout_ms
        };
        {
            let state = self.state.read().await;
            let stall_result = reconcile_stalled_runs(&state, stall_timeout_ms);
            if stall_result.stalled_count > 0 {
                drop(state);
                let mut state = self.state.write().await;
                let config = self.config.read().await;
                for issue_id in &stall_result.stalled_issue_ids {
                    if let Some(entry) = state.remove_running(issue_id) {
                        state.add_runtime_seconds(&entry);
                        schedule_failure_retry(
                            &mut state,
                            issue_id,
                            &entry.identifier,
                            next_attempt(entry.retry_attempt),
                            config.agent.max_retry_backoff_ms,
                            "stall timeout",
                        );
                    }
                }
            }
        }

        // 2. Reconcile tracker states
        {
            let config = self.config.read().await;
            let state = self.state.read().await;
            let reconcile_result = reconcile_tracker_states(
                &state,
                self.tracker.as_ref(),
                &config.tracker.active_states,
                &config.tracker.terminal_states,
            )
            .await;

            drop(state);
            let mut state = self.state.write().await;

            // Apply updates
            for issue in reconcile_result.updates {
                state.update_issue_snapshot(&issue.id, issue);
            }

            // Terminal: terminate and clean workspace
            for issue in reconcile_result.terminate_cleanup {
                if let Some(entry) = state.remove_running(&issue.id) {
                    state.add_runtime_seconds(&entry);
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                    // Clean workspace
                    if let Err(e) = self.workspace_mgr.remove_workspace(&entry.identifier) {
                        warn!(
                            identifier = %entry.identifier,
                            error = %e,
                            "failed to clean terminal workspace"
                        );
                    }
                }
            }

            // Non-active: terminate without cleanup
            for issue in reconcile_result.terminate_no_cleanup {
                if let Some(entry) = state.remove_running(&issue.id) {
                    state.add_runtime_seconds(&entry);
                    state.release_claim(&issue.id);
                    state.remove_pipeline_run(&issue.id);
                }
            }
        }

        // 3. Fetch candidate issues
        let mut candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(error = %e, "failed to fetch candidate issues, skipping dispatch");
                return;
            }
        };

        // 4. Sort by dispatch priority
        sort_for_dispatch(&mut candidates);

        // 5. Dispatch eligible issues while slots remain
        let config = self.config.read().await;
        for issue in &candidates {
            {
                let state = self.state.read().await;
                if !has_available_slots(&state) {
                    break;
                }
            }

            let eligible = {
                let state = self.state.read().await;
                is_dispatch_eligible(
                    issue,
                    &state,
                    &config.tracker.active_states,
                    &config.tracker.terminal_states,
                    &HashMap::new(), // per-state caps can be added to config if needed
                )
            };

            if eligible.is_none() {
                self.dispatch_issue(issue, None).await;
            }
        }
    }

    /// Dispatch a single issue: build DAG, create PipelineRun, dispatch initial steps.
    async fn dispatch_issue(&self, issue: &Issue, attempt: Option<u32>) {
        let config = self.config.read().await;

        // Build the step DAG from config
        let dag = match build_dag(&config.steps) {
            Ok(d) => d,
            Err(e) => {
                warn!(
                    issue_id = %issue.id,
                    error = %e,
                    "failed to build step DAG, skipping dispatch"
                );
                return;
            }
        };

        let cycle = attempt.unwrap_or(1);
        let mut pipeline_run = PipelineRun::new(issue.id.clone(), cycle, dag);
        let action = pipeline_run.start();

        info!(
            issue_id = %issue.id,
            identifier = %issue.identifier,
            attempt = ?attempt,
            "dispatching issue with pipeline"
        );

        {
            let mut state = self.state.write().await;
            state.add_running(issue, attempt);
            state.insert_pipeline_run(&issue.id, pipeline_run);
        }

        // Process initial dispatch requests
        if let PipelineAction::Dispatch(requests) = action {
            for req in requests {
                self.dispatch_step(issue, &req.step_name, &req.agent_name, req.tracker_state.as_deref(), attempt).await;
            }
        }
    }

    /// Dispatch a single pipeline step: set tracker state if specified, spawn worker.
    async fn dispatch_step(
        &self,
        issue: &Issue,
        step_name: &str,
        agent_name: &str,
        tracker_state: Option<&str>,
        attempt: Option<u32>,
    ) {
        info!(
            issue_id = %issue.id,
            identifier = %issue.identifier,
            step = step_name,
            agent = agent_name,
            "dispatching pipeline step"
        );

        // Set tracker state if specified by the step
        if let Some(state_name) = tracker_state {
            if self.tracker.supports_writes() {
                if let Err(e) = self.tracker.set_issue_state(&issue.id, state_name).await {
                    warn!(
                        issue_id = %issue.id,
                        state = state_name,
                        error = %e,
                        "failed to set tracker state for step dispatch"
                    );
                }
            }
        }

        // Mark step as running in pipeline
        {
            let mut state = self.state.write().await;
            if let Some(run) = state.get_pipeline_run_mut(&issue.id) {
                run.mark_running(step_name, format!("{}-{}-{}", issue.id, step_name, agent_name));
            }
        }

        // Spawn worker task
        let issue_clone = issue.clone();
        let step_name_owned = step_name.to_string();
        let agent_name_owned = agent_name.to_string();
        let runner = Arc::clone(&self.agent_runner);
        let workspace_mgr = Arc::clone(&self.workspace_mgr);
        let event_tx = self.worker_tx.clone();
        let config = Arc::clone(&self.config);

        tokio::spawn(async move {
            // Prepare workspace
            let workspace_result = workspace_mgr.prepare_workspace(&issue_clone.identifier);
            let workspace_path = match workspace_result {
                Ok(ws) => {
                    // Run after_create hook if newly created
                    if ws.created_now {
                        let cfg = config.read().await;
                        if let Some(ref script) = cfg.hooks.after_create {
                            if let Err(e) = crate::workspace::hooks::run_hook(
                                "after_create",
                                script,
                                &ws.path,
                                cfg.hooks.timeout_ms,
                            )
                            .await
                            {
                                let _ = event_tx
                                    .send(WorkerEvent::WorkerExited {
                                        issue_id: issue_clone.id.clone(),
                                        step_name: step_name_owned.clone(),
                                        result: WorkerResult::Failed {
                                            error: format!("after_create hook failed: {e}"),
                                        },
                                        timestamp: Utc::now(),
                                    })
                                    .await;
                                return;
                            }
                        }
                    }
                    ws.path
                }
                Err(e) => {
                    let _ = event_tx
                        .send(WorkerEvent::WorkerExited {
                            issue_id: issue_clone.id.clone(),
                            step_name: step_name_owned.clone(),
                            result: WorkerResult::Failed {
                                error: format!("workspace error: {e}"),
                            },
                            timestamp: Utc::now(),
                        })
                        .await;
                    return;
                }
            };

            // Run agent
            let result = runner
                .run(
                    &issue_clone,
                    &agent_name_owned,
                    &step_name_owned,
                    attempt,
                    &workspace_path,
                    event_tx.clone(),
                )
                .await;

            let worker_result = match result {
                Ok(()) => WorkerResult::Success,
                Err(e) => WorkerResult::Failed {
                    error: e.to_string(),
                },
            };

            let _ = event_tx
                .send(WorkerEvent::WorkerExited {
                    issue_id: issue_clone.id.clone(),
                    step_name: step_name_owned,
                    result: worker_result,
                    timestamp: Utc::now(),
                })
                .await;
        });
    }

    /// Handle a worker event from the channel.
    async fn handle_worker_event(&self, event: WorkerEvent) {
        match event {
            WorkerEvent::AgentUpdate {
                issue_id,
                step_name,
                event: agent_event,
                timestamp,
            } => {
                self.handle_agent_update(&issue_id, &step_name, agent_event, timestamp)
                    .await;
            }
            WorkerEvent::WorkerExited {
                issue_id,
                step_name,
                result,
                timestamp,
            } => {
                self.handle_worker_exit(&issue_id, &step_name, result).await;
            }
        }
    }

    /// Handle an agent update event.
    async fn handle_agent_update(
        &self,
        issue_id: &str,
        step_name: &str,
        event: AgentEvent,
        timestamp: chrono::DateTime<Utc>,
    ) {
        let mut state = self.state.write().await;

        match &event {
            AgentEvent::SessionStarted {
                session_id,
                agent_pid,
            } => {
                state.update_session_info(
                    issue_id,
                    session_id,
                    agent_pid.as_deref(),
                );
                state.update_agent_event(issue_id, "session_started", None, timestamp);
            }
            AgentEvent::TurnStarted => {
                state.increment_turn_count(issue_id);
                state.update_agent_event(issue_id, "turn_started", None, timestamp);
            }
            AgentEvent::TurnUpdate { content } => {
                state.update_agent_event(
                    issue_id,
                    "turn_update",
                    Some(content),
                    timestamp,
                );
            }
            AgentEvent::TurnCompleted { usage } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
                state.update_agent_event(issue_id, "turn_completed", None, timestamp);
            }
            AgentEvent::TurnFailed { reason, usage } => {
                if let Some(u) = usage {
                    state.update_token_usage(
                        issue_id,
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                    );
                }
                state.update_agent_event(
                    issue_id,
                    "turn_failed",
                    Some(reason),
                    timestamp,
                );
            }
            AgentEvent::PermissionRequested { description, .. } => {
                state.update_agent_event(
                    issue_id,
                    "permission_requested",
                    Some(description),
                    timestamp,
                );
            }
            AgentEvent::PermissionResolved { .. } => {
                state.update_agent_event(
                    issue_id,
                    "permission_resolved",
                    None,
                    timestamp,
                );
            }
            AgentEvent::Notification { message } => {
                state.update_agent_event(
                    issue_id,
                    "notification",
                    Some(message),
                    timestamp,
                );
            }
            AgentEvent::OtherMessage { raw } => {
                state.update_agent_event(
                    issue_id,
                    "other_message",
                    Some(&raw.chars().take(100).collect::<String>()),
                    timestamp,
                );
            }
            AgentEvent::Malformed { line } => {
                state.update_agent_event(
                    issue_id,
                    "malformed",
                    Some(&line.chars().take(100).collect::<String>()),
                    timestamp,
                );
            }
        }
    }

    /// Handle a worker exit. Integrates with PipelineRun to drive step DAG.
    async fn handle_worker_exit(&self, issue_id: &str, step_name: &str, result: WorkerResult) {
        let config = self.config.read().await;

        // Get the issue snapshot for potential re-dispatch
        let issue_snapshot = {
            let state = self.state.read().await;
            state.running.get(issue_id).map(|e| e.issue.clone())
        };

        let mut state = self.state.write().await;

        match result {
            WorkerResult::Success => {
                info!(
                    issue_id = %issue_id,
                    step = step_name,
                    "worker exited successfully, resolving verdict"
                );

                // Resolve verdict from workspace
                let workspace_path = self.workspace_mgr.workspace_path(issue_id);
                let verdict = resolve_verdict(&workspace_path).await;

                // Drive the pipeline
                let pipeline_action = if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    Some(run.step_completed(step_name, verdict))
                } else {
                    warn!(issue_id = %issue_id, "no pipeline run found for worker exit");
                    None
                };

                if let Some(action) = pipeline_action {
                    match action {
                        PipelineAction::Dispatch(requests) => {
                            // Need to drop state lock before dispatching
                            drop(state);
                            if let Some(ref issue) = issue_snapshot {
                                for req in requests {
                                    self.dispatch_step(
                                        issue,
                                        &req.step_name,
                                        &req.agent_name,
                                        req.tracker_state.as_deref(),
                                        None,
                                    ).await;
                                }
                            }
                        }
                        PipelineAction::Succeeded => {
                            info!(issue_id = %issue_id, "pipeline succeeded");
                            // Set tracker to on_success state
                            if self.tracker.supports_writes() {
                                let _ = self.tracker.set_issue_state(
                                    issue_id,
                                    &config.on_success,
                                ).await;
                            }
                            if let Some(entry) = state.remove_running(issue_id) {
                                state.add_runtime_seconds(&entry);
                            }
                            state.release_claim(issue_id);
                            state.remove_pipeline_run(issue_id);
                            state.completed.insert(issue_id.to_string());
                        }
                        PipelineAction::Failed { step, reason } => {
                            warn!(
                                issue_id = %issue_id,
                                step = %step,
                                reason = %reason,
                                "pipeline failed"
                            );
                            // Set tracker to on_failure state
                            if self.tracker.supports_writes() {
                                let _ = self.tracker.set_issue_state(
                                    issue_id,
                                    &config.on_failure,
                                ).await;
                            }
                            if let Some(entry) = state.remove_running(issue_id) {
                                state.add_runtime_seconds(&entry);
                                schedule_failure_retry(
                                    &mut state,
                                    issue_id,
                                    &entry.identifier,
                                    next_attempt(entry.retry_attempt),
                                    config.agent.max_retry_backoff_ms,
                                    &reason,
                                );
                            }
                            state.remove_pipeline_run(issue_id);
                        }
                        PipelineAction::Waiting => {
                            // Other steps still running, do nothing
                            debug!(issue_id = %issue_id, "pipeline waiting for other steps");
                        }
                    }
                }
            }
            WorkerResult::Failed { error } => {
                warn!(
                    issue_id = %issue_id,
                    step = step_name,
                    error = %error,
                    "worker exited with failure"
                );

                // Notify pipeline of step failure
                let pipeline_action = if let Some(run) = state.get_pipeline_run_mut(issue_id) {
                    Some(run.step_failed(step_name, error.clone()))
                } else {
                    None
                };

                // Set tracker to on_failure state
                if self.tracker.supports_writes() {
                    let _ = self.tracker.set_issue_state(
                        issue_id,
                        &config.on_failure,
                    ).await;
                }

                if let Some(entry) = state.remove_running(issue_id) {
                    state.add_runtime_seconds(&entry);
                    schedule_failure_retry(
                        &mut state,
                        issue_id,
                        &entry.identifier,
                        next_attempt(entry.retry_attempt),
                        config.agent.max_retry_backoff_ms,
                        &error,
                    );
                }
                state.remove_pipeline_run(issue_id);
            }
        }
    }

    /// Handle due retry timer fires.
    async fn handle_retry_fires(&self) {
        let due_retries = {
            let state = self.state.read().await;
            get_due_retries(&state)
        };

        for retry_entry in due_retries {
            self.handle_single_retry(&retry_entry).await;
        }
    }

    /// Handle a single retry fire.
    async fn handle_single_retry(&self, retry_entry: &crate::tracker::model::RetryEntry) {
        let issue_id = &retry_entry.issue_id;

        // Remove the retry entry
        {
            let mut state = self.state.write().await;
            state.remove_retry(issue_id);
        }

        // Fetch active candidates
        let candidates = match self.tracker.fetch_candidate_issues().await {
            Ok(issues) => issues,
            Err(e) => {
                warn!(
                    issue_id = %issue_id,
                    error = %e,
                    "retry poll failed, rescheduling"
                );
                let mut state = self.state.write().await;
                let config = self.config.read().await;
                schedule_failure_retry(
                    &mut state,
                    issue_id,
                    &retry_entry.identifier,
                    retry_entry.attempt + 1,
                    config.agent.max_retry_backoff_ms,
                    "retry poll failed",
                );
                return;
            }
        };

        // Find the issue in candidates
        let issue = candidates.iter().find(|i| i.id == *issue_id);

        match issue {
            None => {
                // Issue not found in candidates — release claim
                info!(
                    issue_id = %issue_id,
                    identifier = %retry_entry.identifier,
                    "issue not found in candidates on retry, releasing claim"
                );
                let mut state = self.state.write().await;
                state.release_claim(issue_id);
            }
            Some(issue) => {
                // Check if we have slots
                let has_slots = {
                    let state = self.state.read().await;
                    has_available_slots(&state)
                };

                if has_slots {
                    self.dispatch_issue(issue, Some(retry_entry.attempt)).await;
                } else {
                    // No slots — requeue
                    info!(
                        issue_id = %issue_id,
                        identifier = %retry_entry.identifier,
                        "no slots available for retry, requeuing"
                    );
                    let mut state = self.state.write().await;
                    let config = self.config.read().await;
                    schedule_failure_retry(
                        &mut state,
                        issue_id,
                        &retry_entry.identifier,
                        retry_entry.attempt + 1,
                        config.agent.max_retry_backoff_ms,
                        "no available orchestrator slots",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{AgentEvent, WorkerEvent, WorkerResult};
    use crate::config::ensemble::parse_config;
    use crate::tracker::TrackerError;
    use async_trait::async_trait;

    /// Mock tracker for orchestrator tests.
    struct MockTracker {
        issues: Arc<RwLock<Vec<Issue>>>,
    }

    #[async_trait]
    impl IssueTracker for MockTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(self.issues.read().await.clone())
        }
        async fn fetch_issues_by_states(
            &self,
            states: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            let states_lower: Vec<String> = states.iter().map(|s| s.to_lowercase()).collect();
            Ok(issues
                .iter()
                .filter(|i| states_lower.contains(&i.state.to_lowercase()))
                .cloned()
                .collect())
        }
        async fn fetch_issue_states_by_ids(
            &self,
            ids: &[String],
        ) -> Result<Vec<Issue>, TrackerError> {
            let issues = self.issues.read().await;
            Ok(issues
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect())
        }
    }

    /// Mock agent runner that completes immediately.
    struct MockRunner {
        delay_ms: u64,
    }

    #[async_trait]
    impl AgentRunner for MockRunner {
        async fn run(
            &self,
            issue: &Issue,
            _agent_name: &str,
            step_name: &str,
            _attempt: Option<u32>,
            _workspace_path: &std::path::Path,
            event_tx: mpsc::Sender<WorkerEvent>,
        ) -> Result<(), AgentError> {
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            let _ = event_tx
                .send(WorkerEvent::AgentUpdate {
                    issue_id: issue.id.clone(),
                    step_name: step_name.to_string(),
                    event: AgentEvent::SessionStarted {
                        session_id: "mock-session".to_string(),
                        agent_pid: Some("99".to_string()),
                    },
                    timestamp: Utc::now(),
                })
                .await;
            Ok(())
        }
    }

    fn test_issue(id: &str, state: &str) -> Issue {
        Issue {
            id: id.to_string(),
            identifier: format!("repo#{id}"),
            title: format!("Issue {id}"),
            description: None,
            priority: Some(2),
            state: state.to_string(),
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: Some(Utc::now()),
            updated_at: None,
        }
    }

    fn make_config() -> EnsembleConfig {
        let yaml = r#"
tracker:
  kind: todo_file
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Closed"]
agents:
  builder:
    executor: claude
    model: opus
    prompt: "Work on {{ issue.identifier }}."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Todo
concurrency:
  max_concurrent_agents: 5
polling:
  interval_ms: 100
workspace:
  root: /tmp/ensemble-test
agent:
  max_turns: 3
  command: "echo test"
  session_mode: code
  permission_policy: auto_approve_all
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
"#;
        parse_config(yaml).unwrap()
    }

    #[tokio::test]
    async fn test_orchestrator_dispatches_on_tick() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 10 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator =
            Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Run one tick
        orchestrator.handle_tick().await;

        // Verify issue was dispatched
        let state = orchestrator.state.read().await;
        assert!(state.is_running("1"), "issue should be running after tick");
        assert!(state.is_claimed("1"), "issue should be claimed after tick");
        assert!(state.get_pipeline_run("1").is_some(), "should have pipeline run");
    }

    #[tokio::test]
    async fn test_orchestrator_handles_worker_exit_success() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config.clone(), tracker, runner, workspace_mgr, shutdown_rx);

        // Manually add a running entry with a pipeline run
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
            state.insert_pipeline_run("1", pipeline_run);
        }

        // Simulate worker exit
        orchestrator
            .handle_worker_exit("1", "build", WorkerResult::Success)
            .await;

        let state = orchestrator.state.read().await;
        // With a single-step pipeline, success should complete the pipeline
        assert!(
            state.completed.contains("1") || state.retry_attempts.contains_key("1"),
            "should be completed or retrying"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_handles_worker_exit_failure() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config.clone(), tracker, runner, workspace_mgr, shutdown_rx);

        // Manually add a running entry with attempt 2 and a pipeline run
        {
            let cfg = config.read().await;
            let dag = build_dag(&cfg.steps).unwrap();
            let mut pipeline_run = PipelineRun::new("1".to_string(), 2, dag);
            pipeline_run.start();
            pipeline_run.mark_running("build", "session-1".to_string());

            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), Some(2));
            state.insert_pipeline_run("1", pipeline_run);
        }

        // Simulate worker failure
        orchestrator
            .handle_worker_exit(
                "1",
                "build",
                WorkerResult::Failed {
                    error: "agent crashed".to_string(),
                },
            )
            .await;

        let state = orchestrator.state.read().await;
        assert!(!state.is_running("1"));
        assert!(state.retry_attempts.contains_key("1"));
        let retry = state.retry_attempts.get("1").unwrap();
        assert_eq!(retry.attempt, 3); // incremented from 2
        assert_eq!(retry.error.as_deref(), Some("agent crashed"));
        assert!(state.get_pipeline_run("1").is_none(), "pipeline run should be removed");
    }

    #[tokio::test]
    async fn test_orchestrator_handles_agent_update() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Add running entry
        {
            let mut state = orchestrator.state.write().await;
            state.add_running(&test_issue("1", "Todo"), None);
        }

        // Send session started event
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::SessionStarted {
                    session_id: "session-abc".to_string(),
                    agent_pid: Some("12345".to_string()),
                },
                Utc::now(),
            )
            .await;

        let state = orchestrator.state.read().await;
        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.session_id.as_deref(), Some("session-abc"));
        assert_eq!(entry.agent_pid.as_deref(), Some("12345"));
        assert_eq!(entry.last_agent_event.as_deref(), Some("session_started"));

        drop(state);

        // Send turn completed with usage
        orchestrator
            .handle_agent_update(
                "1",
                "build",
                AgentEvent::TurnCompleted {
                    usage: Some(crate::agent::events::TokenUsage {
                        input_tokens: 500,
                        output_tokens: 200,
                        total_tokens: 700,
                    }),
                },
                Utc::now(),
            )
            .await;

        let state = orchestrator.state.read().await;
        let entry = state.running.get("1").unwrap();
        assert_eq!(entry.agent_input_tokens, 500);
        assert_eq!(entry.agent_output_tokens, 200);
        assert_eq!(entry.agent_total_tokens, 700);
        assert_eq!(state.agent_totals.input_tokens, 500);
        assert_eq!(state.agent_totals.total_tokens, 700);
    }

    #[tokio::test]
    async fn test_orchestrator_retry_release_missing_issue() {
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![])); // empty — issue not found
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 0 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let orchestrator =
            Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Add a claimed retry
        {
            let mut state = orchestrator.state.write().await;
            state.add_retry(crate::tracker::model::RetryEntry {
                issue_id: "gone".to_string(),
                identifier: "repo#gone".to_string(),
                attempt: 1,
                due_at_ms: 0,
                error: None,
            });
        }

        // Handle the retry
        let retry_entry = crate::tracker::model::RetryEntry {
            issue_id: "gone".to_string(),
            identifier: "repo#gone".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
        };
        orchestrator.handle_single_retry(&retry_entry).await;

        let state = orchestrator.state.read().await;
        assert!(
            !state.is_claimed("gone"),
            "claim should be released when issue not found"
        );
    }

    #[tokio::test]
    async fn test_orchestrator_full_cycle() {
        // Full cycle: start -> tick -> dispatch -> worker exit -> pipeline completion
        let config = Arc::new(RwLock::new(make_config()));
        let issues = Arc::new(RwLock::new(vec![test_issue("1", "Todo")]));
        let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
            issues: issues.clone(),
        });
        let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner { delay_ms: 10 });
        let dir = tempfile::TempDir::new().unwrap();
        let workspace_mgr = WorkspaceManager::new(dir.path()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let mut orchestrator =
            Orchestrator::new(config, tracker, runner, workspace_mgr, shutdown_rx);

        // Tick 1: dispatches the issue
        orchestrator.handle_tick().await;

        {
            let state = orchestrator.state.read().await;
            assert!(state.is_running("1"));
            assert!(state.get_pipeline_run("1").is_some());
        }

        // Wait for the mock worker to finish
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Drain worker events
        while let Ok(event) = orchestrator.worker_rx.try_recv() {
            orchestrator.handle_worker_event(event).await;
        }

        // After worker exit, pipeline should have completed or retried
        let state = orchestrator.state.read().await;
        if !state.is_running("1") {
            assert!(
                state.retry_attempts.contains_key("1") || state.completed.contains("1"),
                "should have retry or be completed"
            );
        }
    }
}
```

- [ ] **Step 2: Add `futures` dependency usage to orchestrator**

The `futures::future::pending` is used in the select loop. Ensure `futures` is in the dependencies (already added in Task 1 Step 6).

- [ ] **Step 3: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core orchestrator::tests`
Expected: All tests pass

- [ ] **Step 4: Run all tests to verify nothing is broken**

Run: `cargo test -p ensemble-core`
Expected: All tests pass (unit + integration from all modules)

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: orchestrator main loop with pipeline-driven dispatch, verdict resolution, and step DAG integration"
```

---

## Summary

After completing all 8 tasks, you will have:

- **Agent events module** (`agent/events.rs`) with `AgentEvent`, `WorkerEvent` (with `step_name` field), `TokenUsage`, `StopReason`, and `JsonRpcMessage` types — the internal protocol between ACP client and orchestrator
- **ACP client** (`agent/acp_client.rs`) with subprocess management, JSON-RPC 2.0 stdio protocol, handshake (`initialize` + `session/new` + `session/set_mode`), turn streaming with `stopReason` mapping, permission handling per policy, timeout enforcement, and SIGTERM/SIGKILL cleanup
- **AgentRunner trait + AcpAgentRunner** (`agent/mod.rs`) implementing the full worker loop: before_run hook via `config.hooks.before_run`, ACP session startup via `config.agent.command`, multi-turn loop, after_run hook (best effort), and process cleanup. The `run()` method takes `agent_name` and `step_name` parameters. Prompts are resolved from `config.agents[agent_name].prompt` or `.prompt_template`. Uses `EnsembleConfig` (not ServiceConfig/WorkflowDefinition).
- **OrchestratorState** (`orchestrator/state.rs`) with `running`, `claimed`, `retry_attempts`, `completed`, `agent_totals`, `agent_rate_limits`, and `pipeline_runs: HashMap<String, PipelineRun>` — all mutation methods from Section 4.1.8 plus `get_pipeline_run()`, `get_pipeline_run_mut()`, `insert_pipeline_run()`, `remove_pipeline_run()`
- **Scheduler** (`orchestrator/scheduler.rs`) with all eligibility rules from Section 8.2 (required fields, active/terminal states, running/claimed checks, global slots, per-state slots, blocker rules for Todo), dispatch priority sorting (priority ascending, oldest created_at, identifier tiebreaker), and concurrency slot calculation
- **Retry logic** (`orchestrator/retry.rs`) with `calculate_backoff(attempt, max)` formula `min(10000 * 2^(attempt-1), max)`, 1-second continuation retries, failure retries with exponential backoff, and due-time scheduling
- **Reconciler** (`orchestrator/reconciler.rs`) with Part A stall detection (elapsed since last event vs `config.agent.stall_timeout_ms`), Part B tracker state refresh (terminal -> kill + cleanup, active -> update snapshot, non-active -> kill without cleanup), and startup terminal workspace cleanup
- **Orchestrator main loop** (`orchestrator/mod.rs`) with the `select!`-based event loop processing poll ticks, worker events, retry timers, and shutdown signals. On issue dispatch: builds `StepDag` from `config.steps` via `build_dag()`, creates `PipelineRun`, calls `start()` for initial `DispatchRequest`s, and spawns workers per step. On worker exit: resolves verdicts via `resolve_verdict()`, drives `PipelineRun.step_completed()` / `step_failed()`, and handles `PipelineAction::Dispatch` (next steps), `Succeeded` (set `config.on_success` state), `Failed` (set `config.on_failure` state + retry), and `Waiting`.

**Dependencies on Plans 1 and 2B:** This plan builds on the types and traits from Plans 1 and 2B: `Issue`, `RunningEntry`, `RetryEntry`, `AgentTotals`, `IssueTracker` trait (with `supports_writes`, `set_issue_state`, `add_comment`), `EnsembleConfig` (with `TrackerConfig`, `AgentConfig`, `StepConfig`, `ConcurrencyConfig`, `PollingConfig`, `WorkspaceConfig`, `HooksConfig`, `AgentRuntimeConfig`), `parse_config()`, `build_dag()`, `StepDag`, `PipelineRun`, `PipelineAction`, `DispatchRequest`, `Verdict`, `resolve_verdict()`, `WorkspaceManager`, `run_hook`/`run_hook_best_effort`, `render_prompt`, `sanitize_workspace_key`, and the error types (`ConfigError`, `WorkspaceError`, `TrackerError`, `PipelineError`).

**Next:** Plan 4 adds the pluggable tracker implementations (todo_file + github). Plan 5 adds the HTTP API, CLI binary, and desktop/dashboard.
