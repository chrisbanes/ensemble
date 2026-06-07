pub mod acp_client;
pub mod acpx_cli;
pub mod acpx_runtime;
pub mod cancellation;
pub mod events;
pub mod protocol;
pub mod runtime;

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::config::ensemble::{EnsembleConfig, InteractionPolicyOverrideMode, PermissionMode};
use crate::config::template::render_prompt_with_interaction_response;
use crate::error::AgentError;
use crate::interaction::InteractionResponse;
use crate::tracker::model::Issue;
use crate::workspace::hooks::{run_hook, run_hook_best_effort};
use events::{
    AgentEvent, InteractionRequestDraft, StepApprovalRequestDraft, WorkerEvent, WorkerResult,
};

use acp_client::{AcpSession, TurnResult};
use acpx_runtime::AcpxRuntime;

const VERDICT_FALLBACK_INSTRUCTION: &str = "\
If you cannot return a structured runtime verdict, write .ensemble/verdict.json with:\n\
{\"verdict\":\"approve\"}\n\
or\n\
{\"verdict\":\"reject\",\"summary\":\"<reason>\"}";

const DEFAULT_INTERACTION_POLICY_INSTRUCTION: &str = "\
When you need human input, prefer batching related questions into a single interaction request instead of asking one-by-one.\n\
This is a soft preference: ask a single urgent question when sequential discovery or risk requires it.\n\
For each question include: the question, why it matters, and the default you will assume if unanswered.";

pub struct AgentRunRequest<'a> {
    pub config: Arc<EnsembleConfig>,
    pub issue: &'a Issue,
    pub agent_name: &'a str,
    pub step_name: &'a str,
    pub attempt: Option<u32>,
    pub(crate) interaction_response: Option<InteractionResponseEnvelope>,
    pub workspace_path: &'a Path,
    pub event_tx: mpsc::Sender<WorkerEvent>,
    /// Token for cooperative cancellation of the agent run.
    /// Used by `AcpxRuntime` to abort the acpx prompt via `tokio::select!`.
    /// The direct ACP path (`AcpAgentRunner::run_direct_step`) ignores this
    /// token — cancellation there relies on SIGTERM sent to `agent_pid`.
    pub cancel_token: CancellationToken,
}

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError>;
}

/// Real ACP agent runner that implements the full worker loop from SPEC.md Section 16.5.
pub struct AcpAgentRunner;

struct BuildPromptRequest<'a> {
    issue: &'a Issue,
    agent_name: &'a str,
    step_name: &'a str,
    attempt: Option<u32>,
    workspace_path: &'a Path,
    turn_number: u32,
}

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
        request: BuildPromptRequest<'_>,
    ) -> Result<String, AgentError> {
        let BuildPromptRequest {
            issue,
            agent_name,
            step_name,
            attempt,
            workspace_path,
            turn_number,
        } = request;
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

            let interaction_response = load_interaction_response(workspace_path).await?;

            let rendered = render_prompt_with_interaction_response(
                &template_str,
                issue,
                attempt,
                interaction_response
                    .as_ref()
                    .map(|response| &response.response),
            )
            .map_err(|e| AgentError::PromptError {
                reason: e.to_string(),
            })?;

            let rendered = maybe_append_interaction_policy_instruction(
                rendered,
                resolve_interaction_policy_instruction(config, agent_name, step_name).as_deref(),
            );
            Ok(maybe_append_verdict_fallback_instruction(
                rendered,
                config.agent.inject_verdict_fallback_instructions,
            ))
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

    async fn prepare_workspace(
        &self,
        workspace_path: &Path,
        interaction_response: Option<&InteractionResponseEnvelope>,
    ) -> Result<(), AgentError> {
        // Ensure stale verdict and request artifacts from previous attempts
        // cannot influence the current run's resolution path.
        remove_ensemble_file(workspace_path, "verdict.json").await?;
        remove_ensemble_file(workspace_path, "interaction-request.json").await?;
        remove_ensemble_file(workspace_path, "approval-request.json").await?;

        if let Some(interaction_response) = interaction_response {
            write_interaction_response_file(workspace_path, interaction_response).await?;
        } else {
            remove_ensemble_file(workspace_path, "interaction-response.json").await?;
        }

        Ok(())
    }
}

fn maybe_append_verdict_fallback_instruction(prompt: String, enabled: bool) -> String {
    if !enabled || prompt.contains(VERDICT_FALLBACK_INSTRUCTION) {
        return prompt;
    }

    let trimmed = prompt.trim_end();
    if trimmed.is_empty() {
        VERDICT_FALLBACK_INSTRUCTION.to_string()
    } else {
        format!("{trimmed}\n\n{VERDICT_FALLBACK_INSTRUCTION}")
    }
}

fn resolve_interaction_policy_instruction(
    config: &EnsembleConfig,
    agent_name: &str,
    step_name: &str,
) -> Option<String> {
    let global_default = config
        .agent
        .interaction_policy_text
        .clone()
        .unwrap_or_else(|| DEFAULT_INTERACTION_POLICY_INSTRUCTION.to_string());

    let step_override = config
        .agent
        .interaction_policy_overrides
        .steps
        .get(step_name);
    let agent_override = config
        .agent
        .interaction_policy_overrides
        .agents
        .get(agent_name);
    let selected_override = step_override.or(agent_override);

    if let Some(override_config) = selected_override {
        return match override_config.mode {
            InteractionPolicyOverrideMode::Off => None,
            InteractionPolicyOverrideMode::Inherit => config
                .agent
                .inject_interaction_policy_instructions
                .then_some(global_default),
            InteractionPolicyOverrideMode::Custom => {
                Some(override_config.text.clone().unwrap_or(global_default))
            }
        };
    }

    config
        .agent
        .inject_interaction_policy_instructions
        .then_some(global_default)
}

fn maybe_append_interaction_policy_instruction(
    prompt: String,
    instruction: Option<&str>,
) -> String {
    let Some(instruction) = instruction else {
        return prompt;
    };
    if prompt.contains(instruction) {
        return prompt;
    }

    let trimmed = prompt.trim_end();
    if trimmed.is_empty() {
        instruction.to_string()
    } else {
        format!("{trimmed}\n\n{instruction}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct InteractionResponseEnvelope {
    schema_version: u32,
    interaction_id: String,
    kind: crate::interaction::InteractionKind,
    response: InteractionResponse,
    resolved_at: chrono::DateTime<chrono::Utc>,
}

impl InteractionResponseEnvelope {
    pub(crate) fn new(
        schema_version: u32,
        interaction_id: String,
        kind: crate::interaction::InteractionKind,
        response: InteractionResponse,
        resolved_at: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        Self {
            schema_version,
            interaction_id,
            kind,
            response,
            resolved_at,
        }
    }
}

async fn load_interaction_response(
    workspace_path: &Path,
) -> Result<Option<InteractionResponseEnvelope>, AgentError> {
    let path = workspace_path
        .join(".ensemble")
        .join("interaction-response.json");

    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            serde_json::from_str(&contents)
                .map(Some)
                .map_err(|e| AgentError::PromptError {
                    reason: format!("failed to parse .ensemble/interaction-response.json: {e}"),
                })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AgentError::IoError {
            reason: format!("failed to read .ensemble/interaction-response.json: {e}"),
        }),
    }
}

async fn detect_worker_result_with_runtime_verdict(
    workspace_path: &Path,
    runtime_verdict: Option<serde_json::Value>,
) -> WorkerResult {
    let interaction_path = workspace_path
        .join(".ensemble")
        .join("interaction-request.json");
    let approval_path = workspace_path
        .join(".ensemble")
        .join("approval-request.json");

    let interaction_request = match tokio::fs::read_to_string(&interaction_path).await {
        Ok(contents) => match serde_json::from_str::<InteractionRequestDraft>(&contents) {
            Ok(request) => Some(request),
            Err(error) => {
                return WorkerResult::Failed {
                    error: format!("failed to parse .ensemble/interaction-request.json: {error}"),
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return WorkerResult::Failed {
                error: format!("failed to read .ensemble/interaction-request.json: {error}"),
            }
        }
    };

    let approval_request = match tokio::fs::read_to_string(&approval_path).await {
        Ok(contents) => match serde_json::from_str::<StepApprovalRequestDraft>(&contents) {
            Ok(request) => Some(request),
            Err(error) => {
                return WorkerResult::Failed {
                    error: format!("failed to parse .ensemble/approval-request.json: {error}"),
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return WorkerResult::Failed {
                error: format!("failed to read .ensemble/approval-request.json: {error}"),
            }
        }
    };

    let verdict_path = workspace_path.join(".ensemble").join("verdict.json");
    let verdict_exists = tokio::fs::try_exists(&verdict_path).await.unwrap_or(false);

    match interaction_request {
        Some(_) if approval_request.is_some() => WorkerResult::Failed {
            error: "agent produced both .ensemble/interaction-request.json and .ensemble/approval-request.json"
                .to_string(),
        },
        Some(_) if verdict_exists => WorkerResult::Failed {
            error:
                "agent produced both .ensemble/interaction-request.json and .ensemble/verdict.json"
                    .to_string(),
        },
        Some(request) => WorkerResult::BlockedOnHuman { request },
        None => WorkerResult::Success {
            runtime_verdict,
            approval_request,
        },
    }
}

#[cfg(test)]
async fn detect_worker_result(workspace_path: &Path) -> WorkerResult {
    detect_worker_result_with_runtime_verdict(workspace_path, None).await
}

async fn write_interaction_response_file(
    workspace_path: &Path,
    response: &InteractionResponseEnvelope,
) -> Result<(), AgentError> {
    let ensemble_dir = workspace_path.join(".ensemble");
    tokio::fs::create_dir_all(&ensemble_dir)
        .await
        .map_err(|e| AgentError::IoError {
            reason: format!("failed to create .ensemble directory: {e}"),
        })?;

    let contents = serde_json::to_vec_pretty(response).map_err(|e| AgentError::IoError {
        reason: format!("failed to serialize interaction response: {e}"),
    })?;

    tokio::fs::write(ensemble_dir.join("interaction-response.json"), contents)
        .await
        .map_err(|e| AgentError::IoError {
            reason: format!("failed to write .ensemble/interaction-response.json: {e}"),
        })
}

async fn remove_ensemble_file(workspace_path: &Path, filename: &str) -> Result<(), AgentError> {
    let path = workspace_path.join(".ensemble").join(filename);

    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AgentError::IoError {
            reason: format!("failed to remove {}: {error}", path.display()),
        }),
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
/// When `acpx_agent` is set, uses `acpx --agent <name>` with optional
/// launch-time flags derived from per-agent `permission_mode` and `model`.
/// Arguments are shell-escaped because the command is executed via `bash -lc`.
/// `agent.permission_request_policy` is handled later when ACP permission
/// callbacks arrive; it does not change the spawn command. Falls back to
/// `executor` if set, then to the global default.
fn resolve_agent_command(
    agent_config: Option<&crate::config::ensemble::AgentConfig>,
    default_command: &str,
) -> String {
    if let Some(ac) = agent_config {
        if let Some(ref acpx_name) = ac.acpx_agent {
            let mut cmd = String::from("acpx");
            if let Some(permission_flag) = ac
                .permission_mode
                .as_deref()
                .and_then(PermissionMode::parse)
                .map(PermissionMode::acpx_flag)
            {
                cmd.push(' ');
                cmd.push_str(permission_flag);
            }
            cmd.push_str(&format!(" --agent {}", shell_escape(acpx_name)));
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
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
        let config = Arc::clone(&request.config);
        let workspace_path = request.workspace_path;

        self.prepare_workspace(workspace_path, request.interaction_response.as_ref())
            .await?;

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

        let agent_config =
            config
                .agents
                .get(request.agent_name)
                .ok_or_else(|| AgentError::PromptError {
                    reason: format!("agent '{}' not found in config", request.agent_name),
                })?;

        let result = match runtime::RuntimeKind::for_agent(agent_config) {
            runtime::RuntimeKind::Acpx => {
                let prompt = self
                    .build_prompt(
                        config.as_ref(),
                        BuildPromptRequest {
                            issue: request.issue,
                            agent_name: request.agent_name,
                            step_name: request.step_name,
                            attempt: request.attempt,
                            workspace_path,
                            turn_number: 1,
                        },
                    )
                    .await?;
                AcpxRuntime::new().run_step(&request, &prompt).await
            }
            runtime::RuntimeKind::Direct => self.run_direct_step(request).await,
        };

        if let Some(ref script) = config.hooks.after_run {
            run_hook_best_effort("after_run", script, workspace_path, config.hooks.timeout_ms)
                .await;
        }

        result
    }
}

impl AcpAgentRunner {
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

        let mut session = AcpSession::spawn(&spawn_command, workspace_path).await?;

        let cwd_str = workspace_path
            .to_str()
            .ok_or_else(|| AgentError::InvalidWorkspaceCwd {
                path: workspace_path.display().to_string(),
            })?;

        session.initialize(config.agent.read_timeout_ms).await?;

        let session_id = session
            .start_session(cwd_str, serde_json::json!({}), config.agent.read_timeout_ms)
            .await?;

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

        if !config.agent.session_mode.is_empty() {
            session
                .set_mode(&session_id, &config.agent.session_mode)
                .await?;
        }

        let max_turns = config.agent.max_turns;
        let mut turn_number: u32 = 1;

        let mut final_runtime_verdict: Option<serde_json::Value> = None;
        let result = loop {
            let prompt = match self
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
                .await
            {
                Ok(p) => p,
                Err(e) => {
                    session.cancel(&session_id).await?;
                    break Err(e);
                }
            };

            let turn_result = session
                .run_turn(
                    &session_id,
                    &prompt,
                    config.agent.turn_timeout_ms,
                    &config.agent.permission_request_policy,
                    &issue.id,
                    step_name,
                    &event_tx,
                )
                .await;

            match turn_result {
                Ok(TurnResult::Completed {
                    runtime_verdict, ..
                }) => {
                    if runtime_verdict.is_some() {
                        final_runtime_verdict = runtime_verdict;
                    }
                    info!(
                        issue_id = %issue.id,
                        identifier = %issue.identifier,
                        turn = turn_number,
                        agent = agent_name,
                        step = step_name,
                        "turn completed successfully"
                    );
                }
                Ok(TurnResult::Failed {
                    reason,
                    runtime_verdict,
                    ..
                }) => {
                    if runtime_verdict.is_some() {
                        final_runtime_verdict = runtime_verdict;
                    }
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

        let _ = session.cancel(&session_id).await;
        session.kill().await;

        result?;

        Ok(detect_worker_result_with_runtime_verdict(workspace_path, final_runtime_verdict).await)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    use super::*;
    use crate::config::ensemble::parse_config;
    use crate::interaction::{InteractionKind, InteractionResponse};
    use tokio_util::sync::CancellationToken;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK
                .get_or_init(|| Mutex::new(()))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                unsafe {
                    std::env::remove_var(key);
                }
            }

            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => unsafe { std::env::set_var(key, value) },
                    None => unsafe { std::env::remove_var(key) },
                }
            }
        }
    }

    /// Mock agent runner for testing the orchestrator.
    pub struct MockAgentRunner {
        pub should_succeed: bool,
        pub delay_ms: u64,
    }

    #[async_trait]
    impl AgentRunner for MockAgentRunner {
        async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
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
                Ok(WorkerResult::Success {
                    runtime_verdict: None,
                    approval_request: None,
                })
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

    fn test_acpx_config() -> Arc<EnsembleConfig> {
        Arc::new(
            parse_config(
                r#"
tracker:
  kind: todo_file
  active_states: ["Todo"]
  terminal_states: ["Done"]
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
on_failure: Todo
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

    fn collect_event_names(rx: &mut mpsc::Receiver<WorkerEvent>) -> Vec<String> {
        let mut names = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let WorkerEvent::AgentUpdate { event, .. } = event {
                names.push(event.event_name().to_string());
            }
        }
        names
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
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
            })
            .await;

        assert!(matches!(
            result,
            Ok(WorkerResult::Success {
                runtime_verdict: None,
                ..
            })
        ));

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
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
            })
            .await;

        assert!(result.is_err());
        assert!(matches!(result, Err(AgentError::TurnFailed { .. })));
    }

    #[tokio::test]
    async fn acpx_agent_runner_emits_runtime_events_and_success() {
        let _guard = EnvGuard::lock(&["ENSEMBLE_TEST_ACPX_EXECUTABLE"]);

        let workspace = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            &workspace,
            r#"#!/usr/bin/env bash
case "$*" in
  *"sessions ensure"*)
    exit 0
    ;;
  *"prompt --session"*)
    printf '%s\n' \
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}' \
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
    exit 0
    ;;
  *"sessions close"*)
    exit 0
    ;;
esac
exit 1
"#,
        );

        unsafe {
            std::env::set_var("ENSEMBLE_TEST_ACPX_EXECUTABLE", &script);
        }

        let runner =
            AcpAgentRunner::new(Arc::new(RwLock::new(test_acpx_config().as_ref().clone())));
        let (tx, mut rx) = mpsc::channel(16);
        let result = runner
            .run(AgentRunRequest {
                config: test_acpx_config(),
                issue: &test_issue(),
                agent_name: "builder",
                step_name: "build",
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
            })
            .await
            .unwrap();

        unsafe {
            std::env::remove_var("ENSEMBLE_TEST_ACPX_EXECUTABLE");
        }

        assert!(matches!(
            result,
            WorkerResult::Success {
                runtime_verdict: None,
                ..
            }
        ));
        let event_names = collect_event_names(&mut rx);
        assert!(event_names.contains(&"output_chunk".to_string()));
        assert!(event_names.contains(&"run_completed".to_string()));
    }

    #[tokio::test]
    async fn acpx_agent_runner_mock_script_succeeds_with_empty_path() {
        let _guard = EnvGuard::lock(&["ENSEMBLE_TEST_ACPX_EXECUTABLE", "PATH"]);

        let workspace = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            &workspace,
            r#"#!/bin/bash
case "$*" in
  *"prompt --session"*)
    printf '%s\n' \
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}' \
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    exit 0
    ;;
esac
exit 0
"#,
        );

        unsafe {
            std::env::set_var("ENSEMBLE_TEST_ACPX_EXECUTABLE", &script);
            std::env::set_var("PATH", "");
        }

        let runner =
            AcpAgentRunner::new(Arc::new(RwLock::new(test_acpx_config().as_ref().clone())));
        let (tx, mut rx) = mpsc::channel(16);
        let result = runner
            .run(AgentRunRequest {
                config: test_acpx_config(),
                issue: &test_issue(),
                agent_name: "builder",
                step_name: "build",
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
            })
            .await
            .unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                runtime_verdict: None,
                ..
            }
        ));
        let event_names = collect_event_names(&mut rx);
        assert!(event_names.contains(&"output_chunk".to_string()));
    }

    async fn write_workspace_file(workspace: &tempfile::TempDir, name: &str, contents: &str) {
        let ensemble_dir = workspace.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        tokio::fs::write(ensemble_dir.join(name), contents)
            .await
            .unwrap();
    }

    #[test]
    fn injects_verdict_block_when_enabled() {
        let prompt = "Do the work.".to_string();
        let rendered = maybe_append_verdict_fallback_instruction(prompt, true);
        assert!(rendered.contains("write .ensemble/verdict.json"));
    }

    #[test]
    fn does_not_inject_verdict_block_when_disabled() {
        let prompt = "Do the work.".to_string();
        let rendered = maybe_append_verdict_fallback_instruction(prompt.clone(), false);
        assert_eq!(rendered, prompt);
    }

    #[test]
    fn does_not_duplicate_verdict_block_when_present() {
        let prompt = format!("Do work.\n\n{VERDICT_FALLBACK_INSTRUCTION}");
        let rendered = maybe_append_verdict_fallback_instruction(prompt.clone(), true);
        assert_eq!(rendered, prompt);
        assert_eq!(rendered.matches("write .ensemble/verdict.json").count(), 1);
    }

    #[test]
    fn appends_default_interaction_policy_when_enabled() {
        let prompt = "Do the work.".to_string();
        let rendered = maybe_append_interaction_policy_instruction(
            prompt,
            Some(DEFAULT_INTERACTION_POLICY_INSTRUCTION),
        );
        assert!(rendered.contains("prefer batching related questions"));
        assert!(rendered.contains("soft preference"));
    }

    #[test]
    fn interaction_policy_override_precedence_step_then_agent() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    prompt: "Build."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  inject_interaction_policy_instructions: true
  interaction_policy_text: "global"
  interaction_policy_overrides:
    agents:
      builder:
        mode: custom
        text: "agent custom"
    steps:
      build:
        mode: custom
        text: "step custom"
"#,
        )
        .unwrap();

        let selected = resolve_interaction_policy_instruction(&config, "builder", "build");
        assert_eq!(selected.as_deref(), Some("step custom"));
    }

    #[test]
    fn interaction_policy_can_be_disabled_globally() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    prompt: "Build."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  inject_interaction_policy_instructions: false
"#,
        )
        .unwrap();

        let selected = resolve_interaction_policy_instruction(&config, "builder", "build");
        assert_eq!(selected, None);
    }

    #[tokio::test]
    async fn detects_interaction_request_file_and_returns_blocked_result() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "interaction-request.json",
            r#"{
  "schema_version": 1,
  "kind": "question",
  "blocking": true,
  "title": "Choose target environment",
  "body": "Need a target environment.",
  "options": ["staging", "production"],
  "artifacts": ["docs/SPEC.md"]
}"#,
        )
        .await;

        let result = detect_worker_result(workspace.path()).await;

        match result {
            WorkerResult::BlockedOnHuman { request } => {
                assert_eq!(request.kind, InteractionKind::BrainstormPrompt);
                assert_eq!(request.title, "Choose target environment");
            }
            other => panic!("expected blocked result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn prefers_interaction_request_over_approve_reject_verdict_mix() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "interaction-request.json",
            r#"{
  "schema_version": 1,
  "kind": "approval",
  "blocking": true,
  "title": "Approve deploy",
  "body": "Ready to deploy"
}"#,
        )
        .await;
        write_workspace_file(&workspace, "verdict.json", r#"{"verdict":"approve"}"#).await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(
            result,
            WorkerResult::Failed { error }
                if error.contains("both .ensemble/interaction-request.json and .ensemble/verdict.json")
        ));
    }

    #[tokio::test]
    async fn detect_worker_result_reads_post_step_approval_request() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "approval-request.json",
            &serde_json::to_string_pretty(&StepApprovalRequestDraft {
                schema_version: 1,
                title: "Approve plan".to_string(),
                body: "The step completed successfully. Please review the plan.".to_string(),
                state: Some("Plan Review".to_string()),
            })
            .unwrap(),
        )
        .await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(
            result,
            WorkerResult::Success {
                approval_request: Some(_),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn detect_worker_result_rejects_both_interaction_and_post_step_approval() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "interaction-request.json",
            r#"{
  "schema_version": 1,
  "kind": "question",
  "blocking": true,
  "title": "Need input",
  "body": "Which environment?"
}"#,
        )
        .await;
        write_workspace_file(
            &workspace,
            "approval-request.json",
            r#"{
  "schema_version": 1,
  "title": "Approve plan",
  "body": "Please review.",
  "state": "Plan Review"
}"#,
        )
        .await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(result, WorkerResult::Failed { .. }));
    }

    #[tokio::test]
    async fn detect_worker_result_fails_on_invalid_post_step_approval_json() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(&workspace, "approval-request.json", "not json").await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(
            result,
            WorkerResult::Failed { error }
                if error.contains("failed to parse .ensemble/approval-request.json")
        ));
    }

    #[tokio::test]
    async fn rejects_malformed_interaction_request_file_with_failure_result() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(&workspace, "interaction-request.json", "not json").await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(
            result,
            WorkerResult::Failed { error }
                if error.contains("failed to parse .ensemble/interaction-request.json")
        ));
    }

    #[tokio::test]
    async fn detects_interaction_request_without_parsing_malformed_verdict_file() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "interaction-request.json",
            r#"{
  "schema_version": 1,
  "kind": "question",
  "blocking": true,
  "title": "Need input",
  "body": "Which environment?"
}"#,
        )
        .await;
        write_workspace_file(&workspace, "verdict.json", "not valid json").await;

        let result = detect_worker_result(workspace.path()).await;

        assert!(matches!(
            result,
            WorkerResult::Failed { error }
                if error.contains("both .ensemble/interaction-request.json and .ensemble/verdict.json")
        ));
    }

    #[tokio::test]
    async fn writes_interaction_response_file_before_resume_prompt_render() {
        let workspace = tempfile::TempDir::new().unwrap();
        let issue = test_issue();
        let response = InteractionResponseEnvelope {
            schema_version: 1,
            interaction_id: "int_123".to_string(),
            kind: InteractionKind::BrainstormPrompt,
            response: InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
            resolved_at: chrono::Utc::now(),
        };

        write_interaction_response_file(workspace.path(), &response)
            .await
            .unwrap();

        AcpAgentRunner
            .build_prompt(
                test_config().as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    attempt: None,
                    workspace_path: workspace.path(),
                    turn_number: 1,
                },
            )
            .await
            .unwrap();

        let loaded = load_interaction_response(workspace.path())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.interaction_id, "int_123");
        match loaded.response {
            InteractionResponse::Question { text, .. } => assert_eq!(text, "Use staging"),
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn acp_runner_prepares_interaction_response_file_from_request_payload() {
        let workspace = tempfile::TempDir::new().unwrap();
        let response = InteractionResponseEnvelope {
            schema_version: 1,
            interaction_id: "int_runtime".to_string(),
            kind: InteractionKind::BrainstormPrompt,
            response: InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
            resolved_at: chrono::Utc::now(),
        };

        AcpAgentRunner
            .prepare_workspace(workspace.path(), Some(&response))
            .await
            .unwrap();

        let loaded = load_interaction_response(workspace.path()).await.unwrap();
        assert_eq!(loaded, Some(response));
    }

    #[tokio::test]
    async fn prepare_workspace_removes_stale_interaction_response_for_fresh_run() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_interaction_response_file(
            workspace.path(),
            &InteractionResponseEnvelope {
                schema_version: 1,
                interaction_id: "int_stale".to_string(),
                kind: InteractionKind::BrainstormPrompt,
                response: InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "stale".to_string(),
                    selected_option: None,
                },
                resolved_at: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();

        AcpAgentRunner
            .prepare_workspace(workspace.path(), None)
            .await
            .unwrap();

        let loaded = load_interaction_response(workspace.path()).await.unwrap();
        assert_eq!(loaded, None);
    }

    #[tokio::test]
    async fn prepare_workspace_removes_stale_interaction_request_before_run() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "interaction-request.json",
            r#"{
  "schema_version": 1,
  "kind": "question",
  "blocking": true,
  "title": "Stale request",
  "body": "Should not leak"
}"#,
        )
        .await;

        AcpAgentRunner
            .prepare_workspace(workspace.path(), None)
            .await
            .unwrap();

        let result = detect_worker_result(workspace.path()).await;
        assert!(matches!(
            result,
            WorkerResult::Success {
                runtime_verdict: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn prepare_workspace_removes_stale_post_step_approval_request_before_run() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(
            &workspace,
            "approval-request.json",
            r#"{
  "schema_version": 1,
  "title": "Stale approval",
  "body": "Should not leak",
  "state": "Plan Review"
}"#,
        )
        .await;

        AcpAgentRunner
            .prepare_workspace(workspace.path(), None)
            .await
            .unwrap();

        let result = detect_worker_result(workspace.path()).await;
        assert!(matches!(
            result,
            WorkerResult::Success {
                approval_request: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn build_prompt_includes_interaction_response_context() {
        let workspace = tempfile::TempDir::new().unwrap();
        let issue = test_issue();
        let config = Arc::new(
            parse_config(
                r#"
tracker:
  kind: todo_file
  active_states: ["Todo"]
  terminal_states: ["Done"]
agents:
  builder:
    prompt: "{{ interaction_response.kind }}: {{ interaction_response.text }}"
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
        );
        write_interaction_response_file(
            workspace.path(),
            &InteractionResponseEnvelope {
                schema_version: 1,
                interaction_id: "int_456".to_string(),
                kind: InteractionKind::BrainstormPrompt,
                response: InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: None,
                },
                resolved_at: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();

        let prompt = AcpAgentRunner
            .build_prompt(
                config.as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    attempt: Some(2),
                    workspace_path: workspace.path(),
                    turn_number: 1,
                },
            )
            .await
            .unwrap();

        assert!(prompt.starts_with("question: Use staging"));
        assert!(prompt.contains("write .ensemble/verdict.json"));
    }

    #[tokio::test]
    async fn write_and_load_interaction_response_file_round_trips() {
        let workspace = tempfile::TempDir::new().unwrap();
        let response = InteractionResponseEnvelope {
            schema_version: 1,
            interaction_id: "int_roundtrip".to_string(),
            kind: InteractionKind::BrainstormPrompt,
            response: InteractionResponse::Question {
                response_schema_version: 1,
                text: "Use staging".to_string(),
                selected_option: Some("staging".to_string()),
            },
            resolved_at: chrono::Utc::now(),
        };

        write_interaction_response_file(workspace.path(), &response)
            .await
            .unwrap();

        let loaded = load_interaction_response(workspace.path()).await.unwrap();
        assert_eq!(loaded, Some(response));
    }

    #[tokio::test]
    async fn build_prompt_without_template_reference_still_succeeds_with_response_file() {
        let workspace = tempfile::TempDir::new().unwrap();
        let issue = test_issue();
        write_interaction_response_file(
            workspace.path(),
            &InteractionResponseEnvelope {
                schema_version: 1,
                interaction_id: "int_789".to_string(),
                kind: InteractionKind::BrainstormPrompt,
                response: InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: None,
                },
                resolved_at: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();

        let prompt = AcpAgentRunner
            .build_prompt(
                test_config().as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    attempt: None,
                    workspace_path: workspace.path(),
                    turn_number: 1,
                },
            )
            .await
            .unwrap();

        assert!(prompt.starts_with("hi"));
        assert!(prompt.contains("write .ensemble/verdict.json"));
    }

    #[tokio::test]
    async fn prepare_workspace_removes_stale_verdict_file() {
        let workspace = tempfile::TempDir::new().unwrap();
        let ensemble_dir = workspace.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        tokio::fs::write(
            ensemble_dir.join("verdict.json"),
            r#"{"verdict":"reject","summary":"stale"}"#,
        )
        .await
        .unwrap();

        AcpAgentRunner
            .prepare_workspace(workspace.path(), None)
            .await
            .unwrap();

        let exists = tokio::fs::try_exists(ensemble_dir.join("verdict.json"))
            .await
            .unwrap();
        assert!(!exists, "stale verdict.json should be removed before run");
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
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            permission_mode: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "acpx --agent 'claude' --model 'sonnet'");
    }

    #[test]
    fn test_resolve_agent_command_includes_approve_all_flag() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            permission_mode: Some("approve_all".to_string()),
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };

        let cmd = resolve_agent_command(Some(&config), "default-cmd");

        assert_eq!(cmd, "acpx --approve-all --agent 'claude' --model 'sonnet'");
    }

    #[test]
    fn test_resolve_agent_command_includes_approve_reads_flag() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            permission_mode: Some("approve_reads".to_string()),
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };

        let cmd = resolve_agent_command(Some(&config), "default-cmd");

        assert_eq!(
            cmd,
            "acpx --approve-reads --agent 'claude' --model 'sonnet'"
        );
    }

    #[test]
    fn test_resolve_agent_command_includes_deny_all_flag() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            permission_mode: Some("deny_all".to_string()),
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };

        let cmd = resolve_agent_command(Some(&config), "default-cmd");

        assert_eq!(cmd, "acpx --deny-all --agent 'claude' --model 'sonnet'");
    }

    #[test]
    fn test_resolve_agent_command_no_model() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: None,
            executor: None,
            permission_mode: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "acpx --agent 'claude'");
    }

    #[test]
    fn test_resolve_agent_command_omits_permission_flag_when_unset() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: Some("claude".to_string()),
            model: Some("sonnet".to_string()),
            executor: None,
            permission_mode: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };

        let cmd = resolve_agent_command(Some(&config), "default-cmd");

        assert_eq!(cmd, "acpx --agent 'claude' --model 'sonnet'");
    }

    #[test]
    fn test_resolve_agent_command_falls_back_to_default() {
        let cmd = resolve_agent_command(None, "default-cmd");
        assert_eq!(cmd, "'default-cmd'");
    }

    #[test]
    fn test_resolve_agent_command_escapes_executor_tokens() {
        let config = crate::config::ensemble::AgentConfig {
            runtime: None,
            acpx_agent: None,
            model: None,
            executor: Some("codex --profile prod; touch /tmp/pwned".to_string()),
            permission_mode: None,
            prompt: None,
            prompt_template: None,
            reasoning_level: None,
        };
        let cmd = resolve_agent_command(Some(&config), "default-cmd");
        assert_eq!(cmd, "'codex' '--profile' 'prod;' 'touch' '/tmp/pwned'");
    }

    #[test]
    fn runtime_kind_defaults_to_acpx_for_acpx_agent() {
        let config = parse_config(
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
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();
        let agent = &config.agents["builder"];
        assert_eq!(
            runtime::RuntimeKind::for_agent(agent),
            runtime::RuntimeKind::Acpx
        );
    }

    #[test]
    fn runtime_kind_honors_explicit_direct_override() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    runtime: direct
    acpx_agent: codex
    executor: codex
    model: gpt-5
    prompt: hi
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();
        let agent = &config.agents["builder"];
        assert_eq!(
            runtime::RuntimeKind::for_agent(agent),
            runtime::RuntimeKind::Direct
        );
    }

    #[test]
    fn runtime_event_name_exposes_output_chunk() {
        let event = AgentEvent::OutputChunk {
            stream: crate::agent::events::RuntimeStream::Stdout,
            content: "hello".to_string(),
        };
        assert_eq!(event.event_name(), "output_chunk");
        assert_eq!(event.message_for_state().as_deref(), Some("hello"));
    }
}
