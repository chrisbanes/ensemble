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

pub struct AgentRunRequest<'a> {
    pub config: Arc<EnsembleConfig>,
    pub issue: &'a Issue,
    pub agent_name: &'a str,
    pub step_name: &'a str,
    pub attempt: Option<u32>,
    pub workspace_path: &'a Path,
    pub event_tx: mpsc::Sender<WorkerEvent>,
}

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<(), AgentError>;
}

/// Real ACP agent runner that implements the full worker loop from SPEC.md Section 16.5.
pub struct AcpAgentRunner;

impl AcpAgentRunner {
    pub fn new(_config: Arc<RwLock<EnsembleConfig>>) -> Self {
        Self
    }

    /// Build the prompt for a given turn.
    /// First turn uses the full rendered template from the agent config;
    /// continuation turns use guidance text.
    async fn build_prompt(
        &self,
        config: &EnsembleConfig,
        issue: &Issue,
        agent_name: &str,
        attempt: Option<u32>,
        turn_number: u32,
    ) -> Result<String, AgentError> {
        if turn_number == 1 {
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

/// POSIX-compatible single-quote escaping for shell arguments.
///
/// Wraps the argument in single quotes and escapes any embedded single-quote
/// characters. This prevents shell metacharacter injection when arguments are
/// interpolated into commands executed via `bash -lc`.
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

/// Build the ACP spawn command for an agent.
///
/// When `acpx_agent` is set, uses `acpx --agent <name>` with `--model` if
/// configured. Arguments are shell-escaped because the command is executed
/// via `bash -lc`. Falls back to `executor` if set, then to the global default.
fn resolve_agent_command(
    agent_config: Option<&crate::config::ensemble::AgentConfig>,
    default_command: &str,
) -> String {
    if let Some(ac) = agent_config {
        if let Some(ref acpx_name) = ac.acpx_agent {
            let mut cmd = format!("acpx --agent {}", shell_escape(acpx_name));
            if let Some(ref model) = ac.model {
                cmd.push_str(&format!(" --model {}", shell_escape(model)));
            }
            return cmd;
        }
        if let Some(ref executor) = ac.executor {
            return shell_escape_command(executor);
        }
    }
    shell_escape_command(default_command)
}

fn shell_escape_command(command: &str) -> String {
    let parts = shlex::split(command)
        .unwrap_or_else(|| command.split_whitespace().map(str::to_string).collect());

    if parts.is_empty() {
        return shell_escape(command);
    }

    parts
        .iter()
        .map(|part| shell_escape(part))
        .collect::<Vec<_>>()
        .join(" ")
}

#[async_trait]
impl AgentRunner for AcpAgentRunner {
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<(), AgentError> {
        let AgentRunRequest {
            config,
            issue,
            agent_name,
            step_name,
            attempt,
            workspace_path,
            event_tx,
        } = request;

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

        // Model is passed via --model flag in the spawn command (handled by
        // resolve_agent_command). Reasoning level is stored in config but not
        // yet passable at runtime — acpx doesn't support it on exec/spawn yet.

        // 3. Turn loop
        let max_turns = config.agent.max_turns;
        let mut turn_number: u32 = 1;

        let result = loop {
            // Build prompt for this turn
            let prompt = match self
                .build_prompt(config.as_ref(), issue, agent_name, attempt, turn_number)
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
    use crate::config::ensemble::parse_config;

    /// Mock agent runner for testing the orchestrator.
    pub struct MockAgentRunner {
        pub should_succeed: bool,
        pub delay_ms: u64,
    }

    #[async_trait]
    impl AgentRunner for MockAgentRunner {
        async fn run(&self, request: AgentRunRequest<'_>) -> Result<(), AgentError> {
            let AgentRunRequest {
                issue,
                step_name,
                event_tx,
                ..
            } = request;
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

    fn test_config() -> Arc<EnsembleConfig> {
        Arc::new(
            parse_config(
                r#"
tracker:
  kind: todo_file
  active_states: ["Todo"]
  terminal_states: ["Done"]
agents:
  builder:
    prompt: hi
steps:
  - name: build
    agent: builder
workspace:
  root: /tmp/test
agent:
  command: echo test
on_success: Done
on_failure: Todo
"#,
            )
            .unwrap(),
        )
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
            .run(AgentRunRequest {
                config: test_config(),
                issue: &test_issue(),
                agent_name: "builder",
                step_name: "build",
                attempt: None,
                workspace_path: workspace.path(),
                event_tx: tx,
            })
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
            .run(AgentRunRequest {
                config: test_config(),
                issue: &test_issue(),
                agent_name: "builder",
                step_name: "build",
                attempt: None,
                workspace_path: workspace.path(),
                event_tx: tx,
            })
            .await;

        assert!(result.is_err());
        assert!(matches!(result, Err(AgentError::TurnFailed { .. })));
    }

    #[test]
    fn test_shell_escape_simple() {
        assert_eq!(shell_escape("claude"), "'claude'");
    }

    #[test]
    fn test_shell_escape_with_single_quote() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn test_shell_escape_with_metacharacters() {
        assert_eq!(shell_escape("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn test_resolve_agent_command_escapes_acpx_name() {
        let config = crate::config::ensemble::AgentConfig {
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "acpx --agent 'claude' --model 'sonnet'");
    }

    #[test]
    fn test_resolve_agent_command_no_model() {
        let config = crate::config::ensemble::AgentConfig {
            acpx_agent: Some("claude".to_string()),
            model: None,
            executor: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "acpx --agent 'claude'");
    }

    #[test]
    fn test_resolve_agent_command_falls_back_to_default() {
        let cmd = resolve_agent_command(None, "default-cmd");
        assert_eq!(cmd, "'default-cmd'");
    }

    #[test]
    fn test_resolve_agent_command_escapes_executor_tokens() {
        let config = crate::config::ensemble::AgentConfig {
            acpx_agent: None,
            model: None,
            executor: Some("codex --profile prod; touch /tmp/pwned".to_string()),
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "'codex' '--profile' 'prod;' 'touch' '/tmp/pwned'");
    }

    #[test]
    fn test_resolve_agent_command_escapes_executor() {
        let config = crate::config::ensemble::AgentConfig {
            acpx_agent: None,
            model: None,
            executor: Some("my-agent; rm -rf /".to_string()),
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "'my-agent; rm -rf /'");
    }
}
