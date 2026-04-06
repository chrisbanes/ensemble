use crate::agent::runtime::RuntimeKind;
use crate::config::location::default_todo_state_path;
use crate::error::PipelineError;
use crate::workspace::push_strategy::PushStrategy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Top-level configuration parsed from `ensemble.yaml`.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct EnsembleConfig {
    pub tracker: TrackerConfig,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    pub agents: HashMap<String, AgentConfig>,
    pub steps: Vec<StepConfig>,
    pub on_success: String,
    pub on_failure: String,
    #[serde(default)]
    pub concurrency: ConcurrencyConfig,
    #[serde(default = "default_max_cycles")]
    pub max_cycles: u32,
    #[serde(default)]
    pub polling: PollingConfig,
    #[serde(default)]
    pub workspace: WorkspaceConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub agent: AgentRuntimeConfig,
    #[serde(default)]
    pub human_interaction: HumanInteractionConfig,
    #[serde(default)]
    pub push_strategy: PushStrategy,
}

/// Runtime configuration for blocked-on-human interaction handling.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
pub struct HumanInteractionConfig {
    #[serde(default = "default_human_interaction_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub default_resume_mode: HumanResumeMode,
}

fn default_human_interaction_enabled() -> bool {
    true
}

impl Default for HumanInteractionConfig {
    fn default() -> Self {
        Self {
            enabled: default_human_interaction_enabled(),
            default_resume_mode: HumanResumeMode::Manual,
        }
    }
}

/// Default resume behavior for resolved human interactions.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HumanResumeMode {
    #[default]
    Manual,
}

/// A repository to be managed by the workspace (path + branch).
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct RepoConfig {
    pub path: String,
    pub branch: String,
    #[serde(default = "default_git_remote")]
    pub git_remote: String,
}

fn default_git_remote() -> String {
    "origin".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionMode {
    ApproveAll,
    ApproveReads,
    DenyAll,
}

impl PermissionMode {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "approve_all" => Some(Self::ApproveAll),
            "approve_reads" => Some(Self::ApproveReads),
            "deny_all" => Some(Self::DenyAll),
            _ => None,
        }
    }

    pub(crate) fn acpx_flag(self) -> &'static str {
        match self {
            Self::ApproveAll => "--approve-all",
            Self::ApproveReads => "--approve-reads",
            Self::DenyAll => "--deny-all",
        }
    }
}

fn default_max_cycles() -> u32 {
    3
}

/// Tracker configuration: which issue tracker to use and how to connect to it.
#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct TrackerConfig {
    pub kind: String,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    #[schema(value_type = Option<String>)]
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    pub repository: Option<String>,
    pub project_number: Option<i64>,
    #[serde(default)]
    pub labels_filter: Vec<String>,
}

fn default_active_states() -> Vec<String> {
    vec!["Todo".to_string(), "In Progress".to_string()]
}

fn default_terminal_states() -> Vec<String> {
    vec!["Done".to_string(), "Closed".to_string()]
}

impl std::fmt::Debug for TrackerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrackerConfig")
            .field("kind", &self.kind)
            .field("active_states", &self.active_states)
            .field("terminal_states", &self.terminal_states)
            .field("path", &self.path)
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("repository", &self.repository)
            .field("project_number", &self.project_number)
            .field("labels_filter", &self.labels_filter)
            .finish()
    }
}

/// Per-agent definition: which executor to use and what prompt to send.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acpx_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<String>)]
    pub prompt_template: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
}

/// A single step in the pipeline DAG.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepConfig {
    pub name: String,
    pub agent: String,
    /// Explicit dependencies. `None` means "use implicit sequential rule" (depend on
    /// previous step). `Some(vec![])` means "no dependencies" (explicit root).
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
}

/// Concurrency limits for the pipeline orchestrator.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ConcurrencyConfig {
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: u32,
    #[serde(default = "default_max_step_parallelism")]
    pub max_step_parallelism: u32,
}

fn default_max_concurrent_agents() -> u32 {
    4
}

fn default_max_step_parallelism() -> u32 {
    2
}

pub fn default_workspace_root() -> String {
    std::env::temp_dir()
        .join("ensemble_workspaces")
        .display()
        .to_string()
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: default_max_concurrent_agents(),
            max_step_parallelism: default_max_step_parallelism(),
        }
    }
}

/// How often to poll the tracker for new issues.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct PollingConfig {
    #[serde(default = "default_polling_interval_ms")]
    pub interval_ms: u64,
}

fn default_polling_interval_ms() -> u64 {
    30_000
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            interval_ms: default_polling_interval_ms(),
        }
    }
}

/// Workspace directory configuration.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema, Default)]
pub struct WorkspaceConfig {
    pub root: Option<String>,
}

/// Shell hooks run at lifecycle events in each workspace.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct HooksConfig {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_hook_timeout_ms() -> u64 {
    60_000
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            after_create: None,
            before_run: None,
            after_run: None,
            before_remove: None,
            timeout_ms: default_hook_timeout_ms(),
        }
    }
}

/// Runtime configuration for the agent executor.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AgentRuntimeConfig {
    #[serde(default = "default_agent_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_max_retry_backoff_ms")]
    pub max_retry_backoff_ms: u64,
    #[serde(default = "default_agent_command")]
    pub command: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default = "default_permission_request_policy")]
    pub permission_request_policy: String,
    #[serde(default = "default_turn_timeout_ms")]
    pub turn_timeout_ms: u64,
    #[serde(default = "default_read_timeout_ms")]
    pub read_timeout_ms: u64,
    #[serde(default = "default_stall_timeout_ms")]
    pub stall_timeout_ms: i64,
}

fn default_agent_max_turns() -> u32 {
    20
}

fn default_max_retry_backoff_ms() -> u64 {
    300_000
}

fn default_agent_command() -> String {
    "claude-code".to_string()
}

fn default_session_mode() -> String {
    "code".to_string()
}

fn default_permission_request_policy() -> String {
    "auto_approve_all".to_string()
}

fn default_turn_timeout_ms() -> u64 {
    3_600_000
}

fn default_read_timeout_ms() -> u64 {
    5_000
}

fn default_stall_timeout_ms() -> i64 {
    300_000
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_turns: default_agent_max_turns(),
            max_retry_backoff_ms: default_max_retry_backoff_ms(),
            command: default_agent_command(),
            session_mode: default_session_mode(),
            permission_request_policy: default_permission_request_policy(),
            turn_timeout_ms: default_turn_timeout_ms(),
            read_timeout_ms: default_read_timeout_ms(),
            stall_timeout_ms: default_stall_timeout_ms(),
        }
    }
}

/// Resolve `$VAR_NAME` in a string value to its environment variable.
/// Returns the literal string if it doesn't start with `$`.
/// Returns None if the env var is empty or unset.
/// Falls back to `dotenv_map` when the env var is not in the process environment.
fn resolve_env_var(value: &str, dotenv_map: &HashMap<String, String>) -> Option<String> {
    if let Some(var_name) = value.strip_prefix('$') {
        match std::env::var(var_name) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => dotenv_map.get(var_name).filter(|v| !v.is_empty()).cloned(),
        }
    } else {
        Some(value.to_string())
    }
}

/// Resolve a path string: expand `$VAR` then `~`.
/// Returns `None` if the path references an unset/empty env var.
fn resolve_path(path_str: &str, dotenv_map: &HashMap<String, String>) -> Option<PathBuf> {
    resolve_env_var(path_str, dotenv_map)
        .map(|resolved| PathBuf::from(shellexpand::tilde(&resolved).as_ref()))
}

pub(crate) fn resolve_relative_to_base(path: &Path, base_dir: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

/// Read a `.env` file into a local map without mutating the process environment.
/// Best-effort: returns an empty map on any error.
pub(crate) fn read_dotenv(path: &Path) -> HashMap<String, String> {
    dotenvy::from_path_iter(path)
        .ok()
        .map(|iter| {
            iter.filter_map(Result::ok)
                .filter(|(_, value)| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

impl EnsembleConfig {
    /// Resolve environment variables and path expansions in config values.
    ///
    /// Call this after `parse_config()` to process `$VAR` and `~` in:
    /// - `tracker.api_key`
    /// - `tracker.path`
    /// - `workspace.root`
    /// - `agents.*.prompt_template`
    /// - `repos[*].path`
    pub fn resolve_env(&mut self) -> Result<(), crate::error::ConfigError> {
        self.resolve_env_from(Path::new("."), &HashMap::new())
    }

    /// Resolve environment variables and rebase relative paths from the config directory.
    ///
    /// This method:
    /// 1. Resolves `$VAR` and `~` in all path fields
    /// 2. Rebase relative paths to be relative to the config directory
    /// 3. Sets default TODO path for todo_file tracker if not specified
    pub fn resolve_env_from(
        &mut self,
        config_dir: &Path,
        dotenv_map: &HashMap<String, String>,
    ) -> Result<(), crate::error::ConfigError> {
        // tracker.api_key: $VAR resolution
        if let Some(ref raw) = self.tracker.api_key {
            self.tracker.api_key = resolve_env_var(raw, dotenv_map);
        } else if self.tracker.kind == "github" {
            // Only auto-resolve $GITHUB_TOKEN for github tracker
            self.tracker.api_key = resolve_env_var("$GITHUB_TOKEN", dotenv_map);
        }

        // tracker.path: $VAR + ~ expansion, with default for todo_file
        if self.tracker.kind == "todo_file" && self.tracker.path.is_none() {
            self.tracker.path = Some(default_todo_state_path()?);
        }

        if let Some(ref path) = self.tracker.path {
            let path_str = path.to_string_lossy();
            let resolved = resolve_path(&path_str, dotenv_map);
            self.tracker.path = resolved.map(|p| resolve_relative_to_base(&p, config_dir));
        }

        // workspace.root: $VAR + ~ expansion + rebase
        if let Some(ref root) = self.workspace.root {
            let resolved = resolve_path(root, dotenv_map);
            self.workspace.root = resolved.map(|p| {
                let final_path = resolve_relative_to_base(&p, config_dir);
                final_path.to_string_lossy().into_owned()
            });
        }

        // repos[*].path: $VAR + ~ expansion + rebase
        for repo in &mut self.repos {
            let path_str = &repo.path;
            if let Some(resolved) = resolve_path(path_str, dotenv_map) {
                let final_path = resolve_relative_to_base(&resolved, config_dir);
                repo.path = final_path.to_string_lossy().into_owned();
            }
        }

        // agents.*.prompt_template: $VAR + ~ expansion + rebase
        for agent in self.agents.values_mut() {
            if let Some(ref path) = agent.prompt_template {
                let path_str = path.to_string_lossy();
                let resolved = resolve_path(&path_str, dotenv_map);
                agent.prompt_template = resolved.map(|p| resolve_relative_to_base(&p, config_dir));
            }
        }

        Ok(())
    }
}

/// Load and parse a `config.yaml` file from the given path.
///
/// This function:
/// 1. Loads `.env` from the config directory (if present) before expanding variables
/// 2. Reads and parses the YAML file
/// 3. Resolves environment variables and rebases relative paths from the config directory
pub fn load_config(path: &std::path::Path) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let dotenv_map = read_dotenv(&config_dir.join(".env"));

    let content = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => crate::error::ConfigError::MissingConfigFile {
            path: path.display().to_string(),
        },
        _ => crate::error::ConfigError::ConfigReadError {
            path: path.display().to_string(),
            reason: error.to_string(),
        },
    })?;
    let mut config = parse_config(&content)?;
    config.resolve_env_from(config_dir, &dotenv_map)?;
    Ok(config)
}

/// Parse an `ensemble.yaml` YAML string into an `EnsembleConfig`.
/// Note: Does NOT resolve `$VAR` or `~`. Call `config.resolve_env()` after
/// parsing, or use `load_config()` which does both.
pub fn parse_config(yaml: &str) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|e| crate::error::ConfigError::ConfigParseError {
            reason: e.to_string(),
        })?;
    normalize_agent_permission_request_policy(&mut value)?;
    serde_yaml::from_value(value).map_err(|e| crate::error::ConfigError::ConfigParseError {
        reason: e.to_string(),
    })
}

fn normalize_agent_permission_request_policy(
    value: &mut serde_yaml::Value,
) -> Result<(), crate::error::ConfigError> {
    let Some(agent) = value
        .as_mapping_mut()
        .and_then(|root| root.get_mut(serde_yaml::Value::String("agent".to_string())))
        .and_then(serde_yaml::Value::as_mapping_mut)
    else {
        return Ok(());
    };

    let legacy_key = serde_yaml::Value::String("permission_policy".to_string());
    let canonical_key = serde_yaml::Value::String("permission_request_policy".to_string());
    let legacy_value = agent.get(&legacy_key).cloned();
    let canonical_value = agent.get(&canonical_key).cloned();

    if let Some(legacy_value) = legacy_value {
        tracing::warn!(
            "'agent.permission_policy' is deprecated; use 'agent.permission_request_policy' instead"
        );

        if let Some(canonical_value) = canonical_value {
            if canonical_value != legacy_value {
                return Err(crate::error::ConfigError::ConfigParseError {
                    reason:
                        "agent.permission_policy conflicts with agent.permission_request_policy"
                            .to_string(),
                });
            }
        } else {
            agent.insert(canonical_key, legacy_value);
        }

        agent.remove(&legacy_key);
    }

    Ok(())
}

/// Validate the config for consistency: prompt config, agent references, step name uniqueness, etc.
pub fn validate_config(config: &EnsembleConfig) -> Result<(), PipelineError> {
    for (name, agent) in &config.agents {
        match (&agent.prompt, &agent.prompt_template) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(PipelineError::InvalidPromptConfig {
                    agent: name.clone(),
                });
            }
            _ => {}
        }

        let has_acpx = agent.acpx_agent.is_some();
        let has_executor = agent.executor.is_some();
        let has_model = agent.model.is_some();
        let runtime_kind = RuntimeKind::for_agent(agent);

        if let Some(runtime) = agent.runtime.as_deref() {
            match runtime {
                "acpx" => {
                    if !has_acpx {
                        return Err(PipelineError::InvalidRuntimeConfig {
                            agent: name.clone(),
                            reason: "runtime 'acpx' requires acpx_agent".to_string(),
                        });
                    }
                }
                "direct" => {}
                _ => {
                    return Err(PipelineError::InvalidRuntimeConfig {
                        agent: name.clone(),
                        reason: format!("unsupported runtime '{runtime}'"),
                    });
                }
            }
        }

        if let Some(permission_mode) = agent.permission_mode.as_deref() {
            if runtime_kind != RuntimeKind::Acpx {
                let reason = if !has_acpx {
                    "permission_mode requires acpx_agent".to_string()
                } else {
                    "permission_mode requires acpx runtime".to_string()
                };
                return Err(PipelineError::InvalidPermissionMode {
                    agent: name.clone(),
                    reason,
                });
            }

            if PermissionMode::parse(permission_mode).is_none() {
                return Err(PipelineError::InvalidPermissionMode {
                    agent: name.clone(),
                    reason: format!(
                        "unsupported value '{}' (expected one of: approve_all, approve_reads, deny_all)",
                        permission_mode
                    ),
                });
            }
        }

        if runtime_kind == RuntimeKind::Direct && (!has_executor || !has_model) {
            return Err(PipelineError::InvalidAgentConfig {
                agent: name.clone(),
            });
        }
    }

    let any_acpx = config
        .agents
        .values()
        .any(|agent| RuntimeKind::for_agent(agent) == RuntimeKind::Acpx);
    let any_direct = config
        .agents
        .values()
        .any(|agent| RuntimeKind::for_agent(agent) == RuntimeKind::Direct);
    if any_acpx
        && !any_direct
        && config.agent.permission_request_policy != default_permission_request_policy()
    {
        return Err(PipelineError::InvalidRuntimeConfig {
            agent: "agent".to_string(),
            reason: "permission_request_policy is ignored for acpx runtime; remove it or use direct runtime".to_string(),
        });
    }

    // Step names must be unique
    let mut seen_names = std::collections::HashSet::new();
    for step in &config.steps {
        if !seen_names.insert(&step.name) {
            return Err(PipelineError::DuplicateStepName {
                name: step.name.clone(),
            });
        }
    }
    // Each step must reference a valid agent
    for step in &config.steps {
        if !config.agents.contains_key(&step.agent) {
            return Err(PipelineError::UnknownAgent {
                name: step.agent.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::sync::Arc;
    use std::sync::Mutex;
    use tracing_subscriber::fmt::writer::MakeWriter;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ENV_VARS: &[&str] = &[
        "GITHUB_TOKEN",
        "ENSEMBLE_TEST_KEY_2B",
        "ENSEMBLE_EMPTY_2B",
        "ENSEMBLE_TEST_REPO",
    ];

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    #[derive(Clone, Default)]
    struct SharedWriter {
        buffer: Arc<Mutex<Vec<u8>>>,
    }

    impl SharedWriter {
        fn output(&self) -> String {
            String::from_utf8(self.buffer.lock().unwrap().clone()).unwrap()
        }
    }

    struct BufferGuard {
        buffer: Arc<Mutex<Vec<u8>>>,
    }

    impl io::Write for BufferGuard {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.buffer.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for SharedWriter {
        type Writer = BufferGuard;

        fn make_writer(&'a self) -> Self::Writer {
            BufferGuard {
                buffer: Arc::clone(&self.buffer),
            }
        }
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                std::env::remove_var(key);
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
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn minimal_yaml() -> &'static str {
        r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#
    }

    #[test]
    fn test_parse_minimal_config() {
        let config = parse_config(minimal_yaml()).unwrap();
        assert_eq!(config.tracker.kind, "todo_file");
        assert_eq!(config.agents.len(), 1);
        assert!(config.agents.contains_key("build"));
        assert_eq!(config.steps.len(), 1);
        assert_eq!(config.steps[0].name, "build");
        assert_eq!(config.steps[0].agent, "build");
        assert_eq!(config.on_success, "Done");
        assert_eq!(config.on_failure, "Failed");
    }

    #[test]
    fn test_parse_full_config() {
        let yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: $GITHUB_TOKEN
  project_number: 42
  active_states:
    - In Progress
    - Review
  terminal_states:
    - Done
    - Cancelled
  labels_filter:
    - agent-ready
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
  review:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Review the build output."
steps:
  - name: build
    agent: build
    tracker_state: Building
  - name: review
    agent: review
    depends:
      - build
    tracker_state: Review
concurrency:
  max_concurrent_agents: 8
  max_step_parallelism: 4
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.tracker.kind, "github");
        assert_eq!(config.tracker.repository.as_deref(), Some("acme/repo"));
        assert_eq!(config.tracker.project_number, Some(42));
        assert_eq!(config.tracker.labels_filter, vec!["agent-ready"]);
        assert_eq!(config.tracker.active_states, vec!["In Progress", "Review"]);
        assert_eq!(config.tracker.terminal_states, vec!["Done", "Cancelled"]);
        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.contains_key("build"));
        assert!(config.agents.contains_key("review"));
        assert_eq!(config.steps.len(), 2);
        assert_eq!(config.steps[1].depends, Some(vec!["build".to_string()]));
        assert_eq!(config.steps[1].tracker_state.as_deref(), Some("Review"));
        assert_eq!(config.concurrency.max_concurrent_agents, 8);
        assert_eq!(config.concurrency.max_step_parallelism, 4);
    }

    #[test]
    fn test_validate_invalid_prompt_config() {
        // Agent with neither prompt nor prompt_template
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPromptConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_invalid_prompt_config_both() {
        // Agent with both prompt and prompt_template
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
    prompt_template: build.md
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPromptConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_unknown_agent_reference() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: review
    agent: review_agent
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::UnknownAgent { name } => {
                assert_eq!(name, "review_agent");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_defaults_applied() {
        let config = parse_config(minimal_yaml()).unwrap();

        // ConcurrencyConfig defaults
        assert_eq!(config.concurrency.max_concurrent_agents, 4);
        assert_eq!(config.concurrency.max_step_parallelism, 2);

        // max_cycles default
        assert_eq!(config.max_cycles, 3);

        // PollingConfig defaults
        assert_eq!(config.polling.interval_ms, 30_000);

        // WorkspaceConfig defaults
        assert!(config.workspace.root.is_none());

        // HooksConfig defaults
        assert!(config.hooks.after_create.is_none());
        assert!(config.hooks.before_run.is_none());
        assert!(config.hooks.after_run.is_none());
        assert!(config.hooks.before_remove.is_none());
        assert_eq!(config.hooks.timeout_ms, 60_000);

        // AgentRuntimeConfig defaults
        assert_eq!(config.agent.max_turns, 20);
        assert_eq!(config.agent.max_retry_backoff_ms, 300_000);
        assert_eq!(config.agent.command, "claude-code");
        assert_eq!(config.agent.session_mode, "code");
        assert_eq!(config.agent.permission_request_policy, "auto_approve_all");
        assert_eq!(config.agent.turn_timeout_ms, 3_600_000);
        assert_eq!(config.agent.read_timeout_ms, 5_000);
        assert_eq!(config.agent.stall_timeout_ms, 300_000);

        // TrackerConfig defaults
        assert_eq!(config.tracker.active_states, vec!["Todo", "In Progress"]);
        assert_eq!(config.tracker.terminal_states, vec!["Done", "Closed"]);
        assert!(config.tracker.labels_filter.is_empty());

        // HumanInteractionConfig defaults
        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn parses_human_interaction_defaults() {
        let config = parse_config(minimal_yaml()).unwrap();

        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn parses_manual_resume_mode_from_yaml() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
human_interaction:
  enabled: true
  default_resume_mode: manual
"#;

        let config = parse_config(yaml).unwrap();

        assert!(config.human_interaction.enabled);
        assert_eq!(
            config.human_interaction.default_resume_mode,
            HumanResumeMode::Manual
        );
    }

    #[test]
    fn default_workspace_root_uses_temp_dir_ensemble_workspaces() {
        let expected = std::env::temp_dir()
            .join("ensemble_workspaces")
            .display()
            .to_string();

        assert_eq!(default_workspace_root(), expected);
    }

    #[test]
    fn env_guard_restores_tracked_vars() {
        let guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("GITHUB_TOKEN", "before");
        let saved = vec![("GITHUB_TOKEN", std::env::var("GITHUB_TOKEN").ok())];

        {
            let _env = EnvGuard {
                _guard: guard,
                saved,
            };
            std::env::remove_var("GITHUB_TOKEN");
            assert!(std::env::var("GITHUB_TOKEN").is_err());
            std::env::set_var("GITHUB_TOKEN", "during");
        }

        assert_eq!(std::env::var("GITHUB_TOKEN").as_deref(), Ok("before"));
        std::env::remove_var("GITHUB_TOKEN");
    }

    #[test]
    fn test_load_config_missing_file() {
        let result = load_config(std::path::Path::new("/nonexistent/ensemble.yaml"));
        assert!(result.is_err());
        match result.unwrap_err() {
            crate::error::ConfigError::MissingConfigFile { path } => {
                assert!(path.contains("ensemble.yaml"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn resolve_relative_to_base_joins_relative_paths() {
        let resolved =
            resolve_relative_to_base(Path::new("tracker/issues.md"), Path::new("/tmp/config"));

        assert_eq!(resolved, PathBuf::from("/tmp/config/tracker/issues.md"));
    }

    #[test]
    fn resolve_relative_to_base_preserves_absolute_paths() {
        let resolved =
            resolve_relative_to_base(Path::new("/tmp/already-absolute"), Path::new("/tmp/config"));

        assert_eq!(resolved, PathBuf::from("/tmp/already-absolute"));
    }

    #[test]
    fn test_load_config_preserves_non_not_found_read_errors() {
        let dir = tempfile::tempdir().unwrap();

        let result = load_config(dir.path());

        assert!(result.is_err());
        match result.unwrap_err() {
            crate::error::ConfigError::ConfigReadError { path, reason } => {
                assert_eq!(path, dir.path().display().to_string());
                assert!(!reason.is_empty());
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_load_config_from_file() {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "{}", minimal_yaml()).unwrap();
        let config = load_config(tmp.path()).unwrap();
        assert_eq!(config.tracker.kind, "todo_file");
    }

    #[test]
    fn test_validate_duplicate_step_names() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build it."
steps:
  - name: build
    agent: build
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(matches!(
            result,
            Err(PipelineError::DuplicateStepName { .. })
        ));
    }

    #[test]
    fn test_resolve_env_api_key() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_TEST_KEY_2B", "secret123");
        let yaml = r#"
tracker:
  kind: github
  api_key: $ENSEMBLE_TEST_KEY_2B
  repository: acme/repo
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.tracker.api_key.as_deref(), Some("secret123"));
        std::env::remove_var("ENSEMBLE_TEST_KEY_2B");
    }

    #[test]
    fn test_resolve_env_empty_var_is_none() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_EMPTY_2B", "");
        let yaml = r#"
tracker:
  kind: github
  api_key: $ENSEMBLE_EMPTY_2B
  repository: acme/repo
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.tracker.api_key, None);
        std::env::remove_var("ENSEMBLE_EMPTY_2B");
    }

    #[test]
    fn test_resolve_tilde_in_path() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: ~/my_todos.md
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            config.tracker.path.unwrap(),
            PathBuf::from(home).join("my_todos.md")
        );
    }

    #[test]
    fn test_parse_config_with_repos() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
repos:
  - path: /tmp/repo-a
    branch: main
  - path: /tmp/repo-b
    branch: develop
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.repos.len(), 2);
        assert_eq!(config.repos[0].path, "/tmp/repo-a");
        assert_eq!(config.repos[0].branch, "main");
        assert_eq!(config.repos[1].path, "/tmp/repo-b");
        assert_eq!(config.repos[1].branch, "develop");
    }

    #[test]
    fn test_parse_config_with_reasoning_level() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    model: sonnet
    reasoning_level: high
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.reasoning_level.as_deref(), Some("high"));
    }

    #[test]
    fn test_parse_config_with_permission_mode() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.permission_mode.as_deref(), Some("approve_reads"));
        assert_eq!(config.agent.permission_request_policy, "auto_approve_all");
    }

    #[test]
    fn test_parse_config_with_permission_request_policy() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_request_policy: manual
"#;
        let config = parse_config(yaml).unwrap();
        assert!(config.agents["builder"].permission_mode.is_none());
        assert_eq!(config.agent.permission_request_policy, "manual");
    }

    #[test]
    fn acpx_agent_defaults_runtime_to_acpx() {
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

        assert_eq!(config.agents["builder"].runtime.as_deref(), None);
        assert_eq!(
            RuntimeKind::for_agent(&config.agents["builder"]),
            RuntimeKind::Acpx
        );
    }

    #[test]
    fn permission_request_policy_is_rejected_for_acpx_runtime_override() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    runtime: acpx
    prompt: hi
agent:
  permission_request_policy: manual
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let err = validate_config(&config).unwrap_err();
        assert!(err.to_string().contains("permission_request_policy"));
    }

    #[test]
    fn permission_request_policy_is_allowed_for_mixed_runtime_configs() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hello
agent:
  permission_request_policy: manual
steps:
  - name: build
    agent: builder
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_parse_config_with_legacy_permission_policy() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_policy: manual
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.agent.permission_request_policy, "manual");
    }

    #[test]
    fn test_parse_config_with_legacy_permission_policy_warns() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_policy: manual
"#;
        let writer = SharedWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(writer.clone())
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            let config = parse_config(yaml).unwrap();
            assert_eq!(config.agent.permission_request_policy, "manual");
        });

        let output = writer.output();
        assert!(output.contains("agent.permission_policy"));
        assert!(output.contains("agent.permission_request_policy"));
        assert!(output.contains("deprecated"));
    }

    #[test]
    fn test_parse_config_accepts_matching_permission_policy_keys() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_policy: manual
  permission_request_policy: manual
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.agent.permission_request_policy, "manual");
    }

    #[test]
    fn test_parse_config_rejects_conflicting_permission_policy_keys() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_policy: auto
  permission_request_policy: manual
"#;
        let error = parse_config(yaml).unwrap_err();
        match error {
            crate::error::ConfigError::ConfigParseError { reason } => {
                assert!(reason.contains("permission_policy"));
                assert!(reason.contains("permission_request_policy"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_parse_config_repos_defaults_to_empty() {
        let config = parse_config(minimal_yaml()).unwrap();
        assert!(config.repos.is_empty());
    }

    #[test]
    fn test_parse_config_with_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
  reviewer:
    executor: custom-agent
    model: gpt-4
    prompt: "Review it."
steps:
  - name: build
    agent: builder
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let builder = &config.agents["builder"];
        assert_eq!(builder.acpx_agent.as_deref(), Some("claude"));
        assert!(builder.executor.is_none());
        assert!(builder.model.is_none());

        let reviewer = &config.agents["reviewer"];
        assert!(reviewer.acpx_agent.is_none());
        assert_eq!(reviewer.executor.as_deref(), Some("custom-agent"));
        assert_eq!(reviewer.model.as_deref(), Some("gpt-4"));
    }

    #[test]
    fn test_validate_acpx_agent_with_prompt_template() {
        let yaml = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_permission_mode_requires_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: sonnet-4
    permission_mode: approve_all
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("requires acpx_agent"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_permission_mode_rejects_unknown_value() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: maybe
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("unsupported value 'maybe'"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_validate_permission_mode_accepts_valid_value_for_acpx_agent() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_permission_mode_rejects_direct_runtime_override() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    runtime: direct
    acpx_agent: claude
    executor: claude-code
    model: sonnet-4
    permission_mode: approve_reads
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidPermissionMode { agent, reason } => {
                assert_eq!(agent, "builder");
                assert!(reason.contains("acpx runtime"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn test_permission_mode_exposes_acpx_flags() {
        assert_eq!(
            PermissionMode::parse("approve_all"),
            Some(PermissionMode::ApproveAll)
        );
        assert_eq!(
            PermissionMode::parse("approve_reads"),
            Some(PermissionMode::ApproveReads)
        );
        assert_eq!(
            PermissionMode::parse("deny_all"),
            Some(PermissionMode::DenyAll)
        );
        assert_eq!(PermissionMode::parse("nope"), None);

        assert_eq!(PermissionMode::ApproveAll.acpx_flag(), "--approve-all");
        assert_eq!(PermissionMode::ApproveReads.acpx_flag(), "--approve-reads");
        assert_eq!(PermissionMode::DenyAll.acpx_flag(), "--deny-all");
    }

    #[test]
    fn test_resolve_tilde_in_workspace_root() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
workspace:
  root: ~/workspaces
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        let expected = format!("{}/workspaces", home);
        assert_eq!(config.workspace.root.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn test_validate_agent_requires_acpx_or_executor_model() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidAgentConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_validate_agent_with_only_executor() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    executor: claude-code
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(result.is_err());
        match result.unwrap_err() {
            PipelineError::InvalidAgentConfig { agent } => {
                assert_eq!(agent, "build");
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_resolve_env_repos_path() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("ENSEMBLE_TEST_REPO", "/test/repo");
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: $ENSEMBLE_TEST_REPO
    branch: main
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        assert_eq!(config.repos[0].path, "/test/repo");
        std::env::remove_var("ENSEMBLE_TEST_REPO");
    }

    #[test]
    fn test_resolve_tilde_in_repos_path() {
        let yaml = r#"
tracker:
  kind: todo_file
repos:
  - path: ~/projects/myrepo
    branch: main
agents:
  build:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;
        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(config.repos[0].path, format!("{}/projects/myrepo", home));
    }

    #[test]
    fn test_load_config_rebases_relative_paths_from_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("templates")).unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: todo_file
repos:
  - path: repos/app
    branch: main
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
workspace:
  root: workspaces
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(
            config.agents["builder"].prompt_template.as_deref(),
            Some(dir.path().join("templates/implement.liquid").as_path())
        );
        assert_eq!(
            config.repos[0].path,
            dir.path().join("repos/app").display().to_string()
        );
        assert_eq!(
            config.workspace.root.as_deref(),
            Some(dir.path().join("workspaces").display().to_string().as_str())
        );
    }

    #[test]
    fn test_load_config_defaults_todo_tracker_path_to_home_state_path() {
        let dir = tempfile::tempdir().unwrap();
        // Write a minimal config without tracker.path
        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert!(config
            .tracker
            .path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .contains("ensemble/TODO.md"));
    }

    #[test]
    fn test_load_config_loads_sibling_dotenv_without_overriding_existing_env() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "GITHUB_TOKEN=from-dotenv\n").unwrap();
        std::env::set_var("GITHUB_TOKEN", "from-process");

        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: $GITHUB_TOKEN
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        // Process env var should take precedence over .env
        assert_eq!(config.tracker.api_key.as_deref(), Some("from-process"));

        std::env::remove_var("GITHUB_TOKEN");
    }

    #[test]
    fn test_load_config_uses_sibling_dotenv_without_mutating_process_env() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "GITHUB_TOKEN=from-dotenv\n").unwrap();
        std::env::remove_var("GITHUB_TOKEN");

        std::fs::write(
            dir.path().join("config.yaml"),
            r#"
tracker:
  kind: github
  repository: acme/repo
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let config = load_config(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(config.tracker.api_key.as_deref(), Some("from-dotenv"));
        assert!(std::env::var("GITHUB_TOKEN").is_err());
    }

    #[test]
    fn test_resolve_env_does_not_fallback_to_github_token_for_non_github_tracker() {
        let _env = EnvGuard::lock(ENV_VARS);
        std::env::set_var("GITHUB_TOKEN", "from-process");
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let mut config = parse_config(yaml).unwrap();
        config.resolve_env().unwrap();

        assert_eq!(config.tracker.api_key, None);
        std::env::remove_var("GITHUB_TOKEN");
    }
}
