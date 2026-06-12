pub mod acp_client;
pub mod acpx_cli;
pub mod acpx_runtime;
pub mod cancellation;
pub mod events;
pub mod extraction;
pub mod protocol;
pub mod runtime;

#[cfg(test)]
pub(crate) mod test_support;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::config::draft::ConfigDocumentState;
use crate::config::ensemble::{
    DiscoveredCapabilities, EnsembleConfig, InteractionPolicyOverrideMode, PermissionMode, StepKind,
};
use crate::config::template::render_prompt_with_context;
use crate::error::AgentError;
use crate::interaction::InteractionResponse;
use crate::tracker::model::Issue;
use crate::workspace::hooks::{run_hook, run_hook_best_effort};
use async_trait::async_trait;
use events::{InteractionRequestDraft, StepApprovalRequestDraft, WorkerEvent, WorkerResult};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use acp_client::{
    discover_capabilities, run_acp_session, AcpCapabilityDiscoveryConfig, AcpSessionConfig,
    ExtractionContext, SessionTurn, TurnPurpose, TurnResult, TurnVisibility,
};
use acpx_runtime::AcpxRuntime;

/// Fully-resolved description of how to spawn an agent subprocess.
///
/// Built by [`resolve_agent_command`] / [`resolve_acpx_acp_command`] from a
/// combination of `config.yaml` settings and per-agent overrides. The
/// `acp_client` module hands these fields to the `agent-client-protocol`
/// SDK's `McpServerStdio`, which spawns the child, owns its lifecycle, and
/// pipes stdio into the protocol plumbing. No shell, no escaping.
#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Tokenize a user-supplied command string (e.g. from `config.yaml`) into a
/// `ResolvedCommand`. Uses `shell_words::split`, the same tokenizer the ACP
/// SDK uses in `AcpAgent::from_str`, so user expectations are preserved.
///
/// Returns `AgentError::InvalidAgentCommand` if the string is empty or
/// contains an unterminated quote.
pub(crate) fn tokenize_command_string(command: &str) -> Result<ResolvedCommand, AgentError> {
    let parts = shell_words::split(command).map_err(|e| AgentError::InvalidAgentCommand {
        command: command.to_string(),
        reason: e.to_string(),
    })?;
    if parts.is_empty() {
        return Err(AgentError::InvalidAgentCommand {
            command: command.to_string(),
            reason: "command string is empty".to_string(),
        });
    }
    let mut iter = parts.into_iter();
    let program = PathBuf::from(iter.next().expect("non-empty checked above"));
    let args: Vec<String> = iter.collect();
    // `AgentConfig` has no env field; all command paths return empty env.
    // If per-agent env support is added, propagate it here.
    Ok(ResolvedCommand {
        program,
        args,
        env: Vec::new(),
    })
}

fn verdict_fallback_instruction(step_name: &str) -> String {
    format!(
        "If you cannot return a structured runtime verdict, write .ensemble/verdict-{step_name}.json with:\n\
         {{\"verdict\":\"approve\"}}\n\
         or\n\
         {{\"verdict\":\"reject\",\"summary\":\"<reason>\"}}"
    )
}

const DEFAULT_INTERACTION_POLICY_INSTRUCTION: &str = "\
When you need human input, prefer batching related questions into a single interaction request instead of asking one-by-one.\n\
This is a soft preference: ask a single urgent question when sequential discovery or risk requires it.\n\
For each question include: the question, why it matters, and the default you will assume if unanswered.";

pub struct AgentRunRequest<'a> {
    pub config: Arc<EnsembleConfig>,
    pub issue: &'a Issue,
    pub agent_name: &'a str,
    pub step_name: &'a str,
    pub step_kind: StepKind,
    pub attempt: Option<u32>,
    pub(crate) interaction_response: Option<InteractionResponseEnvelope>,
    pub workspace_path: &'a Path,
    pub event_tx: mpsc::Sender<WorkerEvent>,
    /// Token for cooperative cancellation of the agent run.
    /// Used by `AcpxRuntime` to abort the acpx prompt via `tokio::select!`.
    /// The direct ACP path (`AcpAgentRunner::run_direct_step`) ignores this
    /// token — the `agent-client-protocol` SDK owns the child process for the
    /// direct path, so cancellation is handled by dropping the `AcpAgent`.
    pub cancel_token: CancellationToken,
    pub step_outputs: crate::pipeline::engine::StepOutputTemplateContext,
}

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError>;
}

/// Real ACP agent runner that implements the full worker loop from SPEC.md Section 16.5.
pub struct AcpAgentRunner {
    config: Arc<RwLock<EnsembleConfig>>,
    document_state: Option<Arc<RwLock<ConfigDocumentState>>>,
}

struct BuildPromptRequest<'a> {
    issue: &'a Issue,
    agent_name: &'a str,
    step_name: &'a str,
    step_kind: StepKind,
    attempt: Option<u32>,
    workspace_path: &'a Path,
    turn_number: u32,
    step_outputs: &'a crate::pipeline::engine::StepOutputTemplateContext,
}

fn update_agent_capabilities(
    config: &mut EnsembleConfig,
    agent_name: &str,
    capabilities: &DiscoveredCapabilities,
) {
    if let Some(agent) = config.agents.get_mut(agent_name) {
        agent.available_models = capabilities.models.clone();
        agent.available_modes = capabilities.modes.clone();
    }
}

impl AcpAgentRunner {
    pub fn new(config: Arc<RwLock<EnsembleConfig>>) -> Self {
        Self {
            config,
            document_state: None,
        }
    }

    pub fn new_with_document_state(
        config: Arc<RwLock<EnsembleConfig>>,
        document_state: Arc<RwLock<ConfigDocumentState>>,
    ) -> Self {
        Self {
            config,
            document_state: Some(document_state),
        }
    }

    /// Persist discovered ACP capabilities back into the shared in-memory
    /// `AgentConfig` snapshots. No-op if the discovery returned no models and
    /// no modes so that a transient empty discovery does not wipe
    /// previously-stored data.
    async fn store_agent_capabilities(
        &self,
        agent_name: &str,
        capabilities: DiscoveredCapabilities,
    ) {
        if capabilities.models.is_empty() && capabilities.modes.is_empty() {
            return;
        }

        {
            let mut shared_config = self.config.write().await;
            update_agent_capabilities(&mut shared_config, agent_name, &capabilities);
        }

        if let Some(document_state) = &self.document_state {
            let mut document_state = document_state.write().await;
            if let Some(active_config) = document_state.active_config.as_mut() {
                update_agent_capabilities(active_config, agent_name, &capabilities);
            }
        }
    }

    /// Run the ACP handshake-only discovery against the `acpx` runtime for
    /// the agent referenced by `request` and store the result in shared
    /// config. Returns `Ok(())` if the agent has no `acpx_agent` configured
    /// (e.g. direct runtime) — only the `acpx_agent` path advertises models
    /// and modes via ACP `configOptions`.
    async fn discover_acpx_capabilities_for_request(
        &self,
        request: &AgentRunRequest<'_>,
    ) -> Result<(), AgentError> {
        let Some(agent_config) = request.config.agents.get(request.agent_name) else {
            return Ok(());
        };
        if agent_config.acpx_agent.is_none() {
            return Ok(());
        }
        let command = resolve_acpx_acp_command(agent_config)?;

        let capabilities = discover_capabilities(AcpCapabilityDiscoveryConfig {
            command,
            workspace_path: request.workspace_path.to_path_buf(),
            read_timeout_ms: request.config.agent.read_timeout_ms,
        })
        .await?;

        self.store_agent_capabilities(request.agent_name, capabilities)
            .await;
        Ok(())
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
            step_kind,
            attempt,
            workspace_path,
            turn_number,
            step_outputs,
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

            let rendered = render_prompt_with_context(
                &template_str,
                issue,
                attempt,
                interaction_response
                    .as_ref()
                    .map(|response| &response.response),
                Some(step_outputs),
            )
            .map_err(|e| AgentError::PromptError {
                reason: e.to_string(),
            })?;

            let rendered = maybe_append_synthesis_instruction(rendered, step_kind);
            let rendered = maybe_append_interaction_policy_instruction(
                rendered,
                resolve_interaction_policy_instruction(config, agent_name, step_name).as_deref(),
            );
            Ok(maybe_append_verdict_fallback_instruction(
                rendered,
                config.agent.inject_verdict_fallback_instructions,
                step_name,
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
        step_name: &str,
    ) -> Result<(), AgentError> {
        // Ensure stale verdict and request artifacts from previous attempts
        // cannot influence the current run's resolution path.
        let verdict_filename = format!("verdict-{step_name}.json");
        remove_ensemble_file(workspace_path, &verdict_filename).await?;
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

fn maybe_append_synthesis_instruction(rendered: String, step_kind: StepKind) -> String {
    if step_kind != StepKind::Synthesis {
        return rendered;
    }

    format!(
        "{rendered}\n\n\
         This is a synthesis step. Use the `dependency_outputs` Liquid data already rendered above as the authoritative set of direct predecessor results. \
         Merge, compare, or adjudicate those final structured outputs. Do not assume intermediate tool calls or hidden reasoning are available unless the prompt included them explicitly. \
         Return a normal Ensemble verdict with a concise `summary` and, when useful, a structured `output` JSON value describing the merged result."
    )
}

fn maybe_append_verdict_fallback_instruction(
    prompt: String,
    enabled: bool,
    step_name: &str,
) -> String {
    let instruction = verdict_fallback_instruction(step_name);
    if !enabled || prompt.contains(&instruction) {
        return prompt;
    }

    let trimmed = prompt.trim_end();
    if trimmed.is_empty() {
        instruction
    } else {
        format!("{trimmed}\n\n{instruction}")
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

#[cfg(test)]
pub(super) fn transitional_succeeded_output() -> crate::pipeline::verdict::StepOutput {
    crate::pipeline::verdict::StepOutput {
        result: crate::pipeline::verdict::StepResult::Succeeded,
        summary: None,
        output: None,
    }
}

pub(super) async fn detect_worker_result_with_output(
    workspace_path: &Path,
    output: crate::pipeline::verdict::StepOutput,
    step_name: &str,
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

    let step_verdict_path = workspace_path
        .join(".ensemble")
        .join(format!("verdict-{step_name}.json"));
    let legacy_verdict_path = workspace_path.join(".ensemble").join("verdict.json");
    let verdict_exists = tokio::fs::try_exists(&step_verdict_path)
        .await
        .unwrap_or(false)
        || tokio::fs::try_exists(&legacy_verdict_path)
            .await
            .unwrap_or(false);

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
            output,
            approval_request,
        },
    }
}

#[cfg(test)]
async fn detect_worker_result(workspace_path: &Path, step_name: &str) -> WorkerResult {
    detect_worker_result_with_output(workspace_path, transitional_succeeded_output(), step_name)
        .await
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

/// Build the ACP spawn command for an agent.
///
/// When `acpx_agent` is set, uses `acpx --agent <name>` with optional
/// launch-time flags derived from per-agent `permission_mode` and `model`.
/// `agent.permission_request_policy` is handled later when ACP permission
/// callbacks arrive; it does not change the spawn command. Falls back to
/// `executor` if set, then to the global default.
fn resolve_agent_command(
    agent_config: Option<&crate::config::ensemble::AgentConfig>,
    default_command: &str,
) -> Result<ResolvedCommand, AgentError> {
    if let Some(ac) = agent_config {
        if let Some(ref acpx_name) = ac.acpx_agent {
            let mut args: Vec<String> = Vec::new();
            if let Some(permission_flag) = ac
                .permission_mode
                .as_deref()
                .and_then(PermissionMode::parse)
                .map(PermissionMode::acpx_flag)
            {
                args.push(permission_flag.to_string());
            }
            args.push("--agent".to_string());
            args.push(acpx_name.clone());
            if let Some(ref model) = ac.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            if let Some(ref reasoning_level) = ac.reasoning_level {
                args.push("--reasoning-level".to_string());
                args.push(reasoning_level.clone());
            }
            return Ok(ResolvedCommand {
                program: PathBuf::from("acpx"),
                args,
                env: Vec::new(),
            });
        }
        if let Some(ref executor) = ac.executor {
            return tokenize_command_string(executor);
        }
    }
    tokenize_command_string(default_command)
}

/// Build the ACP spawn command used for the discovery handshake.
///
/// Deliberately omits the `permission_mode` flag — discovery only needs the
/// agent process to start and report `configOptions`; the real run will
/// re-invoke the agent with the full command built by `resolve_agent_command`.
fn resolve_acpx_acp_command(
    agent_config: &crate::config::ensemble::AgentConfig,
) -> Result<ResolvedCommand, AgentError> {
    let acpx_name =
        agent_config
            .acpx_agent
            .as_ref()
            .ok_or_else(|| AgentError::InvalidAgentCommand {
                command: "<acpx capability discovery>".to_string(),
                reason: "agent is missing acpx_agent".to_string(),
            })?;
    let mut args = vec!["--agent".to_string(), acpx_name.clone()];
    if let Some(ref model) = agent_config.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    Ok(ResolvedCommand {
        program: PathBuf::from("acpx"),
        args,
        env: Vec::new(),
    })
}

#[async_trait]
impl AgentRunner for AcpAgentRunner {
    async fn run(&self, request: AgentRunRequest<'_>) -> Result<WorkerResult, AgentError> {
        let config = Arc::clone(&request.config);
        let workspace_path = request.workspace_path;

        self.prepare_workspace(
            workspace_path,
            request.interaction_response.as_ref(),
            request.step_name,
        )
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
                            step_kind: request.step_kind,
                            attempt: request.attempt,
                            workspace_path,
                            turn_number: 1,
                            step_outputs: &request.step_outputs,
                        },
                    )
                    .await?;
                if let Err(error) = self.discover_acpx_capabilities_for_request(&request).await {
                    tracing::debug!(
                        agent_name = request.agent_name,
                        error = %error,
                        "ACP capability discovery failed for acpx runtime; continuing without discovered capabilities"
                    );
                }
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
        let config = &request.config;
        let agent_config = config.agents.get(request.agent_name);
        let command = resolve_agent_command(agent_config, &config.agent.command)?;

        let session_mode = if config.agent.session_mode.is_empty() {
            None
        } else {
            Some(config.agent.session_mode.clone())
        };

        let session_config = AcpSessionConfig {
            command,
            workspace_path: request.workspace_path.to_path_buf(),
            session_mode,
            permission_request_policy: config.agent.permission_request_policy.clone(),
            read_timeout_ms: config.agent.read_timeout_ms,
            turn_timeout_ms: config.agent.turn_timeout_ms,
            cancel_token: request.cancel_token.clone(),
        };

        let working_prompt = self
            .build_prompt(
                config.as_ref(),
                BuildPromptRequest {
                    issue: request.issue,
                    agent_name: request.agent_name,
                    step_name: request.step_name,
                    step_kind: request.step_kind,
                    attempt: request.attempt,
                    workspace_path: request.workspace_path,
                    turn_number: 1,
                    step_outputs: &request.step_outputs,
                },
            )
            .await?;
        let working_turn = SessionTurn {
            prompt: working_prompt.clone(),
            visibility: TurnVisibility::Visible,
            purpose: TurnPurpose::Working,
        };
        let extraction_context = ExtractionContext {
            step_name: request.step_name.to_string(),
            issue_identifier: request.issue.identifier.clone(),
            original_prompt: working_prompt,
        };

        let outcome = run_acp_session(
            session_config,
            working_turn,
            extraction_context,
            &request.issue.id,
            request.step_name,
            &request.event_tx,
        )
        .await?;

        self.store_agent_capabilities(request.agent_name, outcome.capabilities)
            .await;

        for (i, result) in outcome.turn_results.iter().enumerate() {
            if let TurnResult::Failed { reason, .. } = result {
                return Err(AgentError::TurnFailed {
                    reason: format!("turn {} failed: {}", i + 1, reason),
                });
            }
        }

        Ok(detect_worker_result_with_output(
            request.workspace_path,
            outcome.output,
            request.step_name,
        )
        .await)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use super::*;
    use crate::agent::events::AgentEvent;
    use crate::agent::test_support::write_mock_acpx_script;
    use crate::config::draft::parse_raw_yaml;
    use crate::config::ensemble::{parse_config, ModeDefinition, ModelDefinition};
    use crate::interaction::{InteractionKind, InteractionResponse};
    use crate::pipeline::engine::StepOutputTemplateContext;
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
                    output: transitional_succeeded_output(),
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

    fn test_runner() -> AcpAgentRunner {
        AcpAgentRunner::new(Arc::new(RwLock::new(test_config().as_ref().clone())))
    }

    #[tokio::test]
    async fn store_agent_capabilities_updates_runtime_and_document_state() {
        let config_path = std::path::PathBuf::from("/tmp/config.yaml");
        let yaml = r#"
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
"#;
        let document_state = Arc::new(RwLock::new(parse_raw_yaml(config_path, yaml.to_string())));
        let runtime_config = Arc::new(RwLock::new(
            document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .clone(),
        ));
        let runner = AcpAgentRunner::new_with_document_state(
            Arc::clone(&runtime_config),
            Arc::clone(&document_state),
        );

        runner
            .store_agent_capabilities(
                "builder",
                DiscoveredCapabilities {
                    models: vec![ModelDefinition {
                        id: "gpt-5".to_string(),
                        name: "GPT-5".to_string(),
                        description: Some("primary model".to_string()),
                    }],
                    modes: vec![ModeDefinition {
                        id: "code".to_string(),
                        name: "Code".to_string(),
                        description: None,
                    }],
                    current_model: Some("gpt-5".to_string()),
                    current_mode: Some("code".to_string()),
                },
            )
            .await;

        assert_eq!(
            runtime_config
                .read()
                .await
                .agents
                .get("builder")
                .unwrap()
                .available_models[0]
                .id,
            "gpt-5"
        );
        assert_eq!(
            document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .agents
                .get("builder")
                .unwrap()
                .available_modes[0]
                .id,
            "code"
        );

        runner
            .store_agent_capabilities("builder", DiscoveredCapabilities::default())
            .await;

        assert_eq!(
            document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .agents
                .get("builder")
                .unwrap()
                .available_models[0]
                .id,
            "gpt-5"
        );
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
                step_kind: StepKind::Agent,
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
                step_outputs: StepOutputTemplateContext::default(),
            })
            .await;

        assert!(matches!(
            result,
            Ok(WorkerResult::Success {
                output,
                ..
            }) if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
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
                step_kind: StepKind::Agent,
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
                step_outputs: StepOutputTemplateContext::default(),
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
            workspace.path(),
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
                step_kind: StepKind::Agent,
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
                step_outputs: StepOutputTemplateContext::default(),
            })
            .await
            .unwrap();

        unsafe {
            std::env::remove_var("ENSEMBLE_TEST_ACPX_EXECUTABLE");
        }

        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
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
            workspace.path(),
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
                step_kind: StepKind::Agent,
                attempt: None,
                interaction_response: None,
                workspace_path: workspace.path(),
                event_tx: tx,
                cancel_token: CancellationToken::new(),
                step_outputs: StepOutputTemplateContext::default(),
            })
            .await
            .unwrap();

        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
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
        let rendered = maybe_append_verdict_fallback_instruction(prompt, true, "build");
        assert!(rendered.contains("write .ensemble/verdict-build.json"));
    }

    #[test]
    fn does_not_inject_verdict_block_when_disabled() {
        let prompt = "Do the work.".to_string();
        let rendered = maybe_append_verdict_fallback_instruction(prompt.clone(), false, "build");
        assert_eq!(rendered, prompt);
    }

    #[test]
    fn does_not_duplicate_verdict_block_when_present() {
        let instruction = verdict_fallback_instruction("build");
        let prompt = format!("Do work.\n\n{instruction}");
        let rendered = maybe_append_verdict_fallback_instruction(prompt.clone(), true, "build");
        assert_eq!(rendered, prompt);
        assert_eq!(
            rendered
                .matches("write .ensemble/verdict-build.json")
                .count(),
            1
        );
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

        let result = detect_worker_result(workspace.path(), "build").await;

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
        write_workspace_file(&workspace, "verdict-build.json", r#"{"verdict":"approve"}"#).await;

        let result = detect_worker_result(workspace.path(), "build").await;

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

        let result = detect_worker_result(workspace.path(), "build").await;

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

        let result = detect_worker_result(workspace.path(), "build").await;

        assert!(matches!(result, WorkerResult::Failed { .. }));
    }

    #[tokio::test]
    async fn detect_worker_result_fails_on_invalid_post_step_approval_json() {
        let workspace = tempfile::TempDir::new().unwrap();
        write_workspace_file(&workspace, "approval-request.json", "not json").await;

        let result = detect_worker_result(workspace.path(), "build").await;

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

        let result = detect_worker_result(workspace.path(), "build").await;

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
        write_workspace_file(&workspace, "verdict-build.json", "not valid json").await;

        let result = detect_worker_result(workspace.path(), "build").await;

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

        test_runner()
            .build_prompt(
                test_config().as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    step_kind: StepKind::Agent,
                    attempt: None,
                    workspace_path: workspace.path(),
                    turn_number: 1,
                    step_outputs: &StepOutputTemplateContext::default(),
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

        test_runner()
            .prepare_workspace(workspace.path(), Some(&response), "build")
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

        test_runner()
            .prepare_workspace(workspace.path(), None, "build")
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

        test_runner()
            .prepare_workspace(workspace.path(), None, "build")
            .await
            .unwrap();

        let result = detect_worker_result(workspace.path(), "build").await;
        assert!(matches!(
            result,
            WorkerResult::Success {
                output,
                ..
            } if matches!(output.result, crate::pipeline::verdict::StepResult::Succeeded)
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

        test_runner()
            .prepare_workspace(workspace.path(), None, "build")
            .await
            .unwrap();

        let result = detect_worker_result(workspace.path(), "build").await;
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

        let prompt = test_runner()
            .build_prompt(
                config.as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    step_kind: StepKind::Agent,
                    attempt: Some(2),
                    workspace_path: workspace.path(),
                    turn_number: 1,
                    step_outputs: &StepOutputTemplateContext::default(),
                },
            )
            .await
            .unwrap();

        assert!(prompt.starts_with("question: Use staging"));
        assert!(prompt.contains("write .ensemble/verdict-build.json"));
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

        let prompt = test_runner()
            .build_prompt(
                test_config().as_ref(),
                BuildPromptRequest {
                    issue: &issue,
                    agent_name: "builder",
                    step_name: "build",
                    step_kind: StepKind::Agent,
                    attempt: None,
                    workspace_path: workspace.path(),
                    turn_number: 1,
                    step_outputs: &StepOutputTemplateContext::default(),
                },
            )
            .await
            .unwrap();

        assert!(prompt.starts_with("hi"));
        assert!(prompt.contains("write .ensemble/verdict-build.json"));
    }

    #[tokio::test]
    async fn prepare_workspace_removes_stale_verdict_file() {
        let workspace = tempfile::TempDir::new().unwrap();
        let ensemble_dir = workspace.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        tokio::fs::write(
            ensemble_dir.join("verdict-build.json"),
            r#"{"verdict":"reject","summary":"stale"}"#,
        )
        .await
        .unwrap();

        test_runner()
            .prepare_workspace(workspace.path(), None, "build")
            .await
            .unwrap();

        let exists = tokio::fs::try_exists(ensemble_dir.join("verdict-build.json"))
            .await
            .unwrap();
        assert!(
            !exists,
            "stale verdict-build.json should be removed before run"
        );
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

    #[test]
    fn resolve_acpx_acp_command_includes_agent_and_model() {
        let resolved = resolve_acpx_acp_command(&crate::config::ensemble::AgentConfig {
            runtime: Some("acpx".to_string()),
            executor: None,
            model: Some("gpt-5".to_string()),
            acpx_agent: Some("codex".to_string()),
            permission_mode: None,
            prompt: Some("Build it.".to_string()),
            prompt_template: None,
            reasoning_level: None,
            available_models: Vec::new(),
            available_modes: Vec::new(),
        })
        .unwrap();

        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec![
                "--agent".to_string(),
                "codex".to_string(),
                "--model".to_string(),
                "gpt-5".to_string(),
            ]
        );
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
            ..Default::default()
        };

        let resolved = resolve_agent_command(Some(&config), "default-cmd").unwrap();

        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec![
                "--approve-all".to_string(),
                "--agent".to_string(),
                "claude".to_string(),
                "--model".to_string(),
                "sonnet".to_string(),
            ]
        );
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
            ..Default::default()
        };

        let resolved = resolve_agent_command(Some(&config), "default-cmd").unwrap();

        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec![
                "--approve-reads".to_string(),
                "--agent".to_string(),
                "claude".to_string(),
                "--model".to_string(),
                "sonnet".to_string(),
            ]
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
            ..Default::default()
        };

        let resolved = resolve_agent_command(Some(&config), "default-cmd").unwrap();

        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec![
                "--deny-all".to_string(),
                "--agent".to_string(),
                "claude".to_string(),
                "--model".to_string(),
                "sonnet".to_string(),
            ]
        );
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
            ..Default::default()
        };
        let resolved = resolve_agent_command(Some(&config), "default-cmd").unwrap();
        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec!["--agent".to_string(), "claude".to_string()]
        );
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
            ..Default::default()
        };

        let resolved = resolve_agent_command(Some(&config), "default-cmd").unwrap();

        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec![
                "--agent".to_string(),
                "claude".to_string(),
                "--model".to_string(),
                "sonnet".to_string(),
            ]
        );
    }

    #[test]
    fn resolve_agent_command_includes_reasoning_level_for_acpx_agent() {
        let config = crate::config::ensemble::AgentConfig {
            acpx_agent: Some("builder".to_string()),
            model: Some("gpt-5".to_string()),
            reasoning_level: Some("high".to_string()),
            ..Default::default()
        };

        let command = resolve_agent_command(Some(&config), "fallback").unwrap();

        assert_eq!(command.program, PathBuf::from("acpx"));
        assert_eq!(
            command.args,
            vec![
                "--agent".to_string(),
                "builder".to_string(),
                "--model".to_string(),
                "gpt-5".to_string(),
                "--reasoning-level".to_string(),
                "high".to_string(),
            ]
        );
    }

    #[test]
    fn test_resolve_agent_command_falls_back_to_default() {
        let resolved = resolve_agent_command(None, "default-cmd").unwrap();
        assert_eq!(resolved.program, PathBuf::from("default-cmd"));
        assert!(resolved.args.is_empty());
    }

    #[test]
    fn tokenize_command_string_splits_simple_program_and_args() {
        let resolved = tokenize_command_string("acpx --agent builder").unwrap();
        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(resolved.args, vec!["--agent", "builder"]);
        assert!(resolved.env.is_empty());
    }

    #[test]
    fn tokenize_command_string_preserves_args_with_spaces() {
        let resolved = tokenize_command_string(r#"my-agent --name "My Agent" --verbose"#).unwrap();
        assert_eq!(resolved.program, PathBuf::from("my-agent"));
        assert_eq!(resolved.args, vec!["--name", "My Agent", "--verbose"]);
    }

    #[test]
    fn tokenize_command_string_rejects_empty_string() {
        let err = tokenize_command_string("").unwrap_err();
        assert!(
            matches!(err, AgentError::InvalidAgentCommand { .. }),
            "expected InvalidAgentCommand, got {err:?}"
        );
    }

    #[test]
    fn tokenize_command_string_rejects_whitespace_only_string() {
        let err = tokenize_command_string("   ").unwrap_err();
        assert!(
            matches!(err, AgentError::InvalidAgentCommand { .. }),
            "expected InvalidAgentCommand, got {err:?}"
        );
    }

    #[test]
    fn tokenize_command_string_rejects_unterminated_quote() {
        let err = tokenize_command_string(r#"foo "bar"#).unwrap_err();
        assert!(
            matches!(err, AgentError::InvalidAgentCommand { .. }),
            "expected InvalidAgentCommand, got {err:?}"
        );
    }

    #[test]
    fn resolve_agent_command_with_acpx_agent_builds_structured_args() {
        use crate::config::ensemble::AgentConfig;
        let agent = AgentConfig {
            acpx_agent: Some("builder".to_string()),
            model: Some("gpt-5".to_string()),
            permission_mode: None,
            executor: None,
            ..Default::default()
        };
        let resolved = resolve_agent_command(Some(&agent), "fallback").unwrap();
        assert_eq!(resolved.program, PathBuf::from("acpx"));
        assert_eq!(
            resolved.args,
            vec!["--agent", "builder", "--model", "gpt-5"]
        );
    }

    #[tokio::test]
    async fn build_prompt_includes_step_outputs() {
        use crate::pipeline::engine::StepOutputTemplateEntry;
        use serde_json::json;
        use std::collections::HashMap;

        let runner = test_runner();
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  synth:
    prompt: 'Risk: {{ steps["review-a"].output.risk }}'
steps:
  - name: synth
    agent: synth
on_success: Done
on_failure: Todo
"#,
        )
        .unwrap();

        let mut steps = HashMap::new();
        steps.insert(
            "review-a".to_string(),
            StepOutputTemplateEntry {
                step: "review-a".to_string(),
                result: "succeeded".to_string(),
                summary: None,
                output: Some(json!({"risk":"low"})),
            },
        );
        let context = StepOutputTemplateContext {
            steps,
            dependency_outputs: vec![],
        };
        let workspace = tempfile::TempDir::new().unwrap();

        let rendered = runner
            .build_prompt(
                &config,
                BuildPromptRequest {
                    issue: &test_issue(),
                    agent_name: "synth",
                    step_name: "synth",
                    step_kind: StepKind::Agent,
                    attempt: None,
                    workspace_path: workspace.path(),
                    turn_number: 1,
                    step_outputs: &context,
                },
            )
            .await
            .unwrap();

        assert!(rendered.contains("Risk: low"));
    }

    #[tokio::test]
    async fn build_prompt_adds_synthesis_guidance_for_synthesis_step() {
        use crate::config::ensemble::StepKind;
        use crate::pipeline::engine::{StepOutputTemplateContext, StepOutputTemplateEntry};
        use std::collections::HashMap;

        let runner = test_runner();
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  synth:
    prompt: 'Merge: {% for dep in dependency_outputs %}{{ dep.step }} {{ dep.summary }}{% endfor %}'
steps:
  - name: review-a
    agent: synth
    depends: []
  - name: synthesize
    kind: synthesis
    agent: synth
    depends: [review-a]
on_success: Done
on_failure: Todo
"#,
        )
        .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let context = StepOutputTemplateContext {
            steps: HashMap::from([(
                "review-a".to_string(),
                StepOutputTemplateEntry {
                    step: "review-a".to_string(),
                    result: "succeeded".to_string(),
                    summary: Some("risk is low".to_string()),
                    output: Some(serde_json::json!({"risk": "low"})),
                },
            )]),
            dependency_outputs: vec![StepOutputTemplateEntry {
                step: "review-a".to_string(),
                result: "succeeded".to_string(),
                summary: Some("risk is low".to_string()),
                output: Some(serde_json::json!({"risk": "low"})),
            }],
        };

        let prompt = runner
            .build_prompt(
                &config,
                BuildPromptRequest {
                    issue: &test_issue(),
                    agent_name: "synth",
                    step_name: "synthesize",
                    step_kind: StepKind::Synthesis,
                    attempt: None,
                    workspace_path: tmp.path(),
                    turn_number: 1,
                    step_outputs: &context,
                },
            )
            .await
            .unwrap();

        assert!(prompt.contains("This is a synthesis step."));
        assert!(prompt.contains("dependency_outputs"));
        assert!(prompt.contains("risk is low"));
    }
}
