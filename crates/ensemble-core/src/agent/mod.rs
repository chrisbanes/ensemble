pub mod acp_client;
pub mod events;

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
use events::{AgentEvent, WorkerEvent};

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
    pub fn new(config: Arc<RwLock<EnsembleConfig>>) -> Self {
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
            let agent_config =
                config
                    .agents
                    .get(agent_name)
                    .ok_or_else(|| AgentError::PromptError {
                        reason: format!("agent '{}' not found in config", agent_name),
                    })?;

            // Resolve the prompt template: inline prompt or file-based prompt_template
            let template_str = if let Some(ref prompt) = agent_config.prompt {
                prompt.clone()
            } else if let Some(ref template_path) = agent_config.prompt_template {
                std::fs::read_to_string(template_path).map_err(|e| AgentError::PromptError {
                    reason: format!(
                        "failed to read prompt template '{}': {}",
                        template_path.display(),
                        e
                    ),
                })?
            } else {
                return Err(AgentError::PromptError {
                    reason: format!(
                        "agent '{}' has neither prompt nor prompt_template",
                        agent_name
                    ),
                });
            };

            render_prompt(&template_str, issue, attempt).map_err(|e| AgentError::PromptError {
                reason: e.to_string(),
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

/// Resolve the ACP spawn command for an agent.
///
/// When `acpx_agent` is set, queries acpx for the underlying agent command
/// (e.g. "npx -y @agentclientprotocol/claude-agent-acp@^0.24.2").
/// Falls back to `executor` if set, then to the global default command.
fn resolve_agent_command(
    agent_config: Option<&crate::config::ensemble::AgentConfig>,
    default_command: &str,
) -> String {
    if let Some(ac) = agent_config {
        // Try acpx_agent first — resolve the underlying ACP command via acpx
        if let Some(ref acpx_name) = ac.acpx_agent {
            if let Some(cmd) = resolve_acpx_agent_command(acpx_name) {
                return cmd;
            }
            // Fallback: use "acpx --agent <name>" directly, which also speaks ACP
            warn!(
                agent = acpx_name.as_str(),
                "could not resolve acpx agent command, using direct acpx invocation"
            );
            return format!("acpx --agent {acpx_name}");
        }
        // Try executor (direct ACP command)
        if let Some(ref executor) = ac.executor {
            return executor.clone();
        }
    }
    default_command.to_string()
}

/// Query acpx for the underlying ACP command of a named agent.
///
/// Creates a probe session, reads the `agent_command` from the session JSON,
/// then closes the session. Returns None on any failure.
fn resolve_acpx_agent_command(agent_name: &str) -> Option<String> {
    let session_name = "ensemble-cmd-probe";

    let output = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "ensure", "--name", session_name])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let session_id = stdout.trim().split('\t').next()?.to_string();
    if session_id.is_empty() {
        return None;
    }

    // Read agent_command from session JSON
    let acpx_dir = dirs::home_dir()?.join(".acpx").join("sessions");
    let session_file = acpx_dir.join(format!("{session_id}.json"));

    // Brief wait for session file to be populated
    for _ in 0..10 {
        if let Ok(content) = std::fs::read_to_string(&session_file) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(cmd) = json
                    .get("agent_command")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                {
                    // Close session
                    let _ = std::process::Command::new("acpx")
                        .args([agent_name, "sessions", "close", session_name])
                        .output();
                    return Some(cmd);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // Close session even on failure
    let _ = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "close", session_name])
        .output();
    None
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
            run_hook(
                "before_run",
                script,
                workspace_path,
                config.hooks.timeout_ms,
            )
            .await
            .map_err(|e| AgentError::HookFailed {
                reason: e.to_string(),
            })?;
        }

        // 2. Resolve spawn command from per-agent config
        let agent_config = config.agents.get(agent_name);
        let spawn_command = resolve_agent_command(agent_config, &config.agent.command);

        // Spawn ACP agent and do handshake
        let mut session = AcpSession::spawn(&spawn_command, workspace_path).await?;

        let cwd_str = workspace_path
            .to_str()
            .ok_or_else(|| AgentError::InvalidWorkspaceCwd {
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

        // Set model if configured in per-agent config
        if let Some(model) = agent_config.and_then(|ac| ac.model.as_deref()) {
            info!(agent = agent_name, model, "setting agent model");
            if let Err(e) = session.set_model(&session_id, model).await {
                warn!(agent = agent_name, model, error = %e, "failed to set model (agent may not support it)");
            }
        }

        // Set reasoning level if configured in per-agent config
        if let Some(level) = agent_config.and_then(|ac| ac.reasoning_level.as_deref()) {
            info!(
                agent = agent_name,
                reasoning_level = level,
                "setting reasoning level"
            );
            if let Err(e) = session
                .set_config_option(&session_id, "thought_level", level)
                .await
            {
                warn!(agent = agent_name, reasoning_level = level, error = %e, "failed to set reasoning level (agent may not support it)");
            }
        }

        // 3. Turn loop
        let max_turns = config.agent.max_turns;
        let mut turn_number: u32 = 1;

        let result = loop {
            // Build prompt for this turn
            let prompt = match self
                .build_prompt(issue, agent_name, attempt, turn_number)
                .await
            {
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
            .run(
                &test_issue(),
                "builder",
                "build",
                None,
                workspace.path(),
                tx,
            )
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
            .run(
                &test_issue(),
                "builder",
                "build",
                None,
                workspace.path(),
                tx,
            )
            .await;

        assert!(result.is_err());
        assert!(matches!(result, Err(AgentError::TurnFailed { .. })));
    }
}
