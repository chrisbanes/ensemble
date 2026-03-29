use std::path::Path;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info};

use crate::error::AgentError;

use super::events::{
    AgentEvent, JsonRpcMessage, StopReason, TokenUsage, WorkerEvent,
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
    Failed {
        reason: String,
        usage: Option<TokenUsage>,
    },
}

impl TurnResult {
    pub fn is_success(&self) -> bool {
        matches!(self, TurnResult::Completed { .. })
    }
}

impl AcpSession {
    /// Spawn an ACP agent subprocess.
    pub async fn spawn(command: &str, workspace_path: &Path) -> Result<Self, AgentError> {
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
    pub async fn set_mode(&mut self, session_id: &str, mode: &str) -> Result<(), AgentError> {
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
        Self::emit_event(event_tx, issue_id, step_name, AgentEvent::TurnStarted).await;

        let turn_duration = Duration::from_millis(turn_timeout_ms);
        let result = timeout(
            turn_duration,
            self.stream_turn(
                id,
                session_id,
                permission_policy,
                issue_id,
                step_name,
                event_tx,
            ),
        )
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
        _session_id: &str,
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
                desc_lower.contains("read")
                    || desc_lower.contains("list")
                    || desc_lower.contains("view")
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
                let msg: JsonRpcMessage =
                    serde_json::from_str(&line).map_err(|e| AgentError::ResponseError {
                        reason: format!("invalid JSON-RPC response: {e} — line: {line}"),
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
        // Spawn a bash script that immediately exits with error (simulating command not found).
        // Note: bash itself spawns fine, but trying to initialize will fail with EOF.
        let result = AcpSession::spawn("nonexistent_binary_xyz_12345", dir.path()).await;
        // The spawn itself may succeed (bash starts), but the subsequent operations will fail.
        // If spawn succeeds, verify we get an error on the first operation.
        match result {
            Err(_) => {} // Direct spawn failure is acceptable
            Ok(mut session) => {
                // bash started but the command failed — initialize should fail with EOF or timeout
                let init_result = session.initialize(2000).await;
                assert!(init_result.is_err());
                session.kill().await;
            }
        }
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
            .run_turn(
                &session_id,
                "Fix the bug",
                30000,
                "auto_approve_all",
                "issue-1",
                "build",
                &tx,
            )
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
            .run_turn(
                &session_id,
                "Do work",
                200,
                "auto_approve_all",
                "issue-2",
                "build",
                &tx,
            )
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
            .run_turn(
                &session_id,
                "Do work",
                30000,
                "auto_approve_all",
                "issue-3",
                "build",
                &tx,
            )
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
            .run_turn(
                &session_id,
                "Do work",
                30000,
                "auto_approve_all",
                "issue-4",
                "build",
                &tx,
            )
            .await
            .unwrap();

        assert!(result.is_success());

        // Verify malformed events were emitted
        let mut malformed_count = 0;
        while let Ok(evt) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate {
                event: AgentEvent::Malformed { .. },
                ..
            } = evt
            {
                malformed_count += 1;
            }
        }
        assert!(
            malformed_count >= 2,
            "expected at least 2 malformed events, got {malformed_count}"
        );

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
            .run_turn(
                &session_id,
                "Do work",
                30000,
                "auto_approve_all",
                "issue-5",
                "build",
                &tx,
            )
            .await
            .unwrap();

        assert!(result.is_success());

        // Verify permission events
        let mut perm_requested = false;
        let mut perm_resolved = false;
        while let Ok(evt) = rx.try_recv() {
            match evt {
                WorkerEvent::AgentUpdate {
                    event:
                        AgentEvent::PermissionRequested {
                            ref permission_id, ..
                        },
                    ..
                } => {
                    assert_eq!(permission_id, "perm-1");
                    perm_requested = true;
                }
                WorkerEvent::AgentUpdate {
                    event:
                        AgentEvent::PermissionResolved {
                            ref permission_id,
                            allowed,
                        },
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
