use crate::error::PipelineError;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

/// Top-level configuration parsed from `ensemble.yaml`.
#[derive(Debug, Clone, Deserialize)]
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
}

/// A repository to be managed by the workspace (path + branch).
#[derive(Debug, Clone, Deserialize)]
pub struct RepoConfig {
    pub path: PathBuf,
    pub branch: String,
}

fn default_max_cycles() -> u32 {
    3
}

/// Tracker configuration: which issue tracker to use and how to connect to it.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackerConfig {
    pub kind: String,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
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

/// Per-agent definition: which executor to use and what prompt to send.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub executor: Option<String>,
    pub model: Option<String>,
    pub acpx_agent: Option<String>,
    pub prompt: Option<String>,
    pub prompt_template: Option<PathBuf>,
}

/// A single step in the pipeline DAG.
#[derive(Debug, Clone, Deserialize)]
pub struct StepConfig {
    pub name: String,
    pub agent: String,
    /// Explicit dependencies. `None` means "use implicit sequential rule" (depend on
    /// previous step). `Some(vec![])` means "no dependencies" (explicit root).
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
}

/// Concurrency limits for the pipeline orchestrator.
#[derive(Debug, Clone, Deserialize)]
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

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: default_max_concurrent_agents(),
            max_step_parallelism: default_max_step_parallelism(),
        }
    }
}

/// How often to poll the tracker for new issues.
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize, Default)]
pub struct WorkspaceConfig {
    pub root: Option<String>,
}

/// Shell hooks run at lifecycle events in each workspace.
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
pub struct AgentRuntimeConfig {
    #[serde(default = "default_agent_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_max_retry_backoff_ms")]
    pub max_retry_backoff_ms: u64,
    #[serde(default = "default_agent_command")]
    pub command: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default = "default_permission_policy")]
    pub permission_policy: String,
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

fn default_permission_policy() -> String {
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
            permission_policy: default_permission_policy(),
            turn_timeout_ms: default_turn_timeout_ms(),
            read_timeout_ms: default_read_timeout_ms(),
            stall_timeout_ms: default_stall_timeout_ms(),
        }
    }
}

/// Resolve `$VAR_NAME` in a string value to its environment variable.
/// Returns the literal string if it doesn't start with `$`.
/// Returns None if the env var is empty or unset.
fn resolve_env_var(value: &str) -> Option<String> {
    if let Some(var_name) = value.strip_prefix('$') {
        match std::env::var(var_name) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        }
    } else {
        Some(value.to_string())
    }
}

/// Expand `~` to home directory in a path string.
fn expand_tilde(path_str: &str) -> PathBuf {
    if let Some(rest) = path_str.strip_prefix('~') {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest.strip_prefix('/').unwrap_or(rest));
        }
    }
    PathBuf::from(path_str)
}

/// Resolve a path string: expand `$VAR` then `~`.
/// Returns `None` if the path references an unset/empty env var.
fn resolve_path(path_str: &str) -> Option<PathBuf> {
    resolve_env_var(path_str).map(|resolved| expand_tilde(&resolved))
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
    pub fn resolve_env(&mut self) {
        // tracker.api_key: $VAR resolution
        if let Some(ref raw) = self.tracker.api_key {
            self.tracker.api_key = resolve_env_var(raw);
        } else {
            // Try canonical env var
            self.tracker.api_key = resolve_env_var("$GITHUB_TOKEN");
        }

        // tracker.path: $VAR + ~ expansion
        if let Some(ref path) = self.tracker.path {
            let path_str = path.to_string_lossy();
            self.tracker.path = resolve_path(&path_str);
        }

        // workspace.root: $VAR + ~ expansion
        if let Some(ref root) = self.workspace.root {
            self.workspace.root = resolve_path(root).map(|p| p.to_string_lossy().into_owned());
        }

        // repos[*].path: $VAR + ~ expansion
        for repo in &mut self.repos {
            let path_str = repo.path.to_string_lossy();
            repo.path = resolve_path(&path_str).unwrap_or(repo.path.clone());
        }

        // agents.*.prompt_template: $VAR + ~ expansion
        for agent in self.agents.values_mut() {
            if let Some(ref path) = agent.prompt_template {
                let path_str = path.to_string_lossy();
                agent.prompt_template = resolve_path(&path_str);
            }
        }
    }
}

/// Load and parse an `ensemble.yaml` file from the given path.
pub fn load_config(path: &std::path::Path) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let content = std::fs::read_to_string(path).map_err(|_| {
        crate::error::ConfigError::MissingConfigFile {
            path: path.display().to_string(),
        }
    })?;
    let mut config = parse_config(&content)?;
    config.resolve_env();
    Ok(config)
}

/// Parse an `ensemble.yaml` YAML string into an `EnsembleConfig`.
/// Note: Does NOT resolve `$VAR` or `~`. Call `config.resolve_env()` after
/// parsing, or use `load_config()` which does both.
pub fn parse_config(yaml: &str) -> Result<EnsembleConfig, crate::error::ConfigError> {
    serde_yaml::from_str(yaml).map_err(|e| crate::error::ConfigError::ConfigParseError {
        reason: e.to_string(),
    })
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
        if !has_acpx && (!has_executor || !has_model) {
            return Err(PipelineError::InvalidAgentConfig {
                agent: name.clone(),
            });
        }
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
        assert_eq!(config.agent.permission_policy, "auto_approve_all");
        assert_eq!(config.agent.turn_timeout_ms, 3_600_000);
        assert_eq!(config.agent.read_timeout_ms, 5_000);
        assert_eq!(config.agent.stall_timeout_ms, 300_000);

        // TrackerConfig defaults
        assert_eq!(config.tracker.active_states, vec!["Todo", "In Progress"]);
        assert_eq!(config.tracker.terminal_states, vec!["Done", "Closed"]);
        assert!(config.tracker.labels_filter.is_empty());
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
        config.resolve_env();
        assert_eq!(config.tracker.api_key.as_deref(), Some("secret123"));
        std::env::remove_var("ENSEMBLE_TEST_KEY_2B");
    }

    #[test]
    fn test_resolve_env_empty_var_is_none() {
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
        config.resolve_env();
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
        config.resolve_env();
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
        assert_eq!(config.repos[0].path, PathBuf::from("/tmp/repo-a"));
        assert_eq!(config.repos[0].branch, "main");
        assert_eq!(config.repos[1].path, PathBuf::from("/tmp/repo-b"));
        assert_eq!(config.repos[1].branch, "develop");
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
        config.resolve_env();
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
        config.resolve_env();
        assert_eq!(config.repos[0].path, PathBuf::from("/test/repo"));
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
        config.resolve_env();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            config.repos[0].path,
            PathBuf::from(home).join("projects/myrepo")
        );
    }
}
