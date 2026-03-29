use crate::config::workflow::WorkflowDefinition;
use crate::error::ConfigError;
use std::collections::HashMap;
use std::path::PathBuf;

/// Typed runtime configuration derived from WORKFLOW.md front matter.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    // tracker (common)
    pub tracker_kind: Option<String>,
    pub tracker_active_states: Vec<String>,
    pub tracker_terminal_states: Vec<String>,

    // tracker (todo_file)
    pub tracker_path: PathBuf,

    // tracker (github)
    pub tracker_endpoint: String,
    pub tracker_api_key: Option<String>,
    pub tracker_repository: Option<String>,
    pub tracker_project_number: Option<i64>,
    pub tracker_labels_filter: Vec<String>,

    // polling
    pub poll_interval_ms: u64,

    // workspace
    pub workspace_root: PathBuf,

    // hooks
    pub hook_after_create: Option<String>,
    pub hook_before_run: Option<String>,
    pub hook_after_run: Option<String>,
    pub hook_before_remove: Option<String>,
    pub hook_timeout_ms: u64,

    // agent
    pub agent_max_concurrent: u32,
    pub agent_max_turns: u32,
    pub agent_max_retry_backoff_ms: u64,
    pub agent_max_concurrent_by_state: HashMap<String, u32>,
    pub agent_command: String,
    pub agent_session_mode: String,
    pub agent_permission_policy: String,
    pub agent_turn_timeout_ms: u64,
    pub agent_read_timeout_ms: u64,
    pub agent_stall_timeout_ms: i64,

    // extensions
    pub server_port: Option<u16>,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            tracker_kind: None,
            tracker_active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            tracker_terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            tracker_path: PathBuf::from("TODO.md"),
            tracker_endpoint: "https://api.github.com/graphql".to_string(),
            tracker_api_key: None,
            tracker_repository: None,
            tracker_project_number: None,
            tracker_labels_filter: vec![],
            poll_interval_ms: 30_000,
            workspace_root: std::env::temp_dir().join("ensemble_workspaces"),
            hook_after_create: None,
            hook_before_run: None,
            hook_after_run: None,
            hook_before_remove: None,
            hook_timeout_ms: 60_000,
            agent_max_concurrent: 10,
            agent_max_turns: 20,
            agent_max_retry_backoff_ms: 300_000,
            agent_max_concurrent_by_state: HashMap::new(),
            agent_command: "claude-code".to_string(),
            agent_session_mode: "code".to_string(),
            agent_permission_policy: "auto_approve_all".to_string(),
            agent_turn_timeout_ms: 3_600_000,
            agent_read_timeout_ms: 5_000,
            agent_stall_timeout_ms: 300_000,
            server_port: None,
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

/// Extract a string value from a YAML mapping at the given key path.
fn yaml_string(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<String> {
    mapping
        .get(section)?
        .as_mapping()?
        .get(key)?
        .as_str()
        .map(|s| s.to_string())
}

/// Extract a signed integer from a YAML mapping, accepting both integers and string integers.
fn yaml_i64(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<i64> {
    let section_map = mapping.get(section)?.as_mapping()?;
    let val = section_map.get(key)?;
    val.as_i64()
        .or_else(|| val.as_str().and_then(|s| s.parse::<i64>().ok()))
}

/// Extract a non-negative integer as u64. Returns None for negative values.
fn yaml_u64(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<u64> {
    let v = yaml_i64(mapping, section, key)?;
    u64::try_from(v).ok()
}

/// Extract a non-negative integer as u32. Returns None for negative or overflow values.
fn yaml_u32(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<u32> {
    let v = yaml_i64(mapping, section, key)?;
    u32::try_from(v).ok()
}

/// Extract a non-negative integer as u16. Returns None for negative or overflow values.
fn yaml_u16(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<u16> {
    let v = yaml_i64(mapping, section, key)?;
    u16::try_from(v).ok()
}

/// Extract a list of strings from a YAML mapping.
fn yaml_string_list(
    mapping: &serde_yaml::Mapping,
    section: &str,
    key: &str,
) -> Option<Vec<String>> {
    mapping
        .get(section)?
        .as_mapping()?
        .get(key)?
        .as_sequence()
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
}

impl ServiceConfig {
    /// Build a ServiceConfig from a parsed WorkflowDefinition.
    pub fn from_workflow(workflow: &WorkflowDefinition) -> Result<Self, ConfigError> {
        let m = &workflow.config;
        let mut config = ServiceConfig::default();

        // tracker
        if let Some(kind) = yaml_string(m, "tracker", "kind") {
            config.tracker_kind = Some(kind);
        }
        if let Some(path_str) = yaml_string(m, "tracker", "path") {
            if let Some(resolved) = resolve_env_var(&path_str) {
                config.tracker_path = expand_tilde(&resolved);
            }
            // If env var is unset, keep the default rather than using literal "$NAME"
        }
        if let Some(endpoint) = yaml_string(m, "tracker", "endpoint") {
            config.tracker_endpoint = endpoint;
        }
        if let Some(api_key_raw) = yaml_string(m, "tracker", "api_key") {
            config.tracker_api_key = resolve_env_var(&api_key_raw);
        } else {
            // Try canonical env var
            config.tracker_api_key = resolve_env_var("$GITHUB_TOKEN");
        }
        if let Some(repo) = yaml_string(m, "tracker", "repository") {
            config.tracker_repository = Some(repo);
        }
        if let Some(pn) = yaml_i64(m, "tracker", "project_number") {
            config.tracker_project_number = Some(pn);
        }
        if let Some(labels) = yaml_string_list(m, "tracker", "labels_filter") {
            config.tracker_labels_filter = labels;
        }
        if let Some(states) = yaml_string_list(m, "tracker", "active_states") {
            config.tracker_active_states = states;
        }
        if let Some(states) = yaml_string_list(m, "tracker", "terminal_states") {
            config.tracker_terminal_states = states;
        }

        // polling
        if let Some(ms) = yaml_u64(m, "polling", "interval_ms") {
            config.poll_interval_ms = ms;
        }

        // workspace
        if let Some(root_str) = yaml_string(m, "workspace", "root") {
            if let Some(resolved) = resolve_env_var(&root_str) {
                config.workspace_root = expand_tilde(&resolved);
            }
            // If env var is unset, keep the default rather than using literal "$NAME"
        }

        // hooks
        if let Some(script) = yaml_string(m, "hooks", "after_create") {
            config.hook_after_create = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "before_run") {
            config.hook_before_run = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "after_run") {
            config.hook_after_run = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "before_remove") {
            config.hook_before_remove = Some(script);
        }
        if let Some(ms) = yaml_u64(m, "hooks", "timeout_ms") {
            if ms > 0 {
                config.hook_timeout_ms = ms;
            }
        }

        // agent
        if let Some(n) = yaml_u32(m, "agent", "max_concurrent_agents") {
            config.agent_max_concurrent = n;
        }
        if let Some(n) = yaml_u32(m, "agent", "max_turns") {
            config.agent_max_turns = n;
        }
        if let Some(ms) = yaml_u64(m, "agent", "max_retry_backoff_ms") {
            config.agent_max_retry_backoff_ms = ms;
        }
        if let Some(cmd) = yaml_string(m, "agent", "command") {
            config.agent_command = cmd;
        }
        if let Some(mode) = yaml_string(m, "agent", "session_mode") {
            config.agent_session_mode = mode;
        }
        if let Some(policy) = yaml_string(m, "agent", "permission_policy") {
            config.agent_permission_policy = policy;
        }
        if let Some(ms) = yaml_u64(m, "agent", "turn_timeout_ms") {
            config.agent_turn_timeout_ms = ms;
        }
        if let Some(ms) = yaml_u64(m, "agent", "read_timeout_ms") {
            config.agent_read_timeout_ms = ms;
        }
        if let Some(ms) = yaml_i64(m, "agent", "stall_timeout_ms") {
            config.agent_stall_timeout_ms = ms;
        }

        // per-state concurrency
        if let Some(section) = m.get("agent") {
            if let Some(by_state) = section
                .as_mapping()
                .and_then(|m| m.get("max_concurrent_agents_by_state"))
            {
                if let Some(state_map) = by_state.as_mapping() {
                    for (k, v) in state_map {
                        if let (Some(state_name), Some(limit)) = (
                            k.as_str(),
                            v.as_i64()
                                .or_else(|| v.as_str().and_then(|s| s.parse().ok())),
                        ) {
                            if limit > 0 {
                                config
                                    .agent_max_concurrent_by_state
                                    .insert(state_name.to_lowercase(), limit as u32);
                            }
                        }
                    }
                }
            }
        }

        // extensions
        if let Some(port) = yaml_u16(m, "server", "port") {
            config.server_port = Some(port);
        }

        Ok(config)
    }

    /// Validate the config has everything needed for dispatch.
    pub fn validate_for_dispatch(&self) -> Result<(), ConfigError> {
        if self.tracker_kind.is_none() {
            return Err(ConfigError::WorkflowParseError {
                reason: "tracker.kind is required".to_string(),
            });
        }
        let kind = self.tracker_kind.as_deref().unwrap();
        match kind {
            "todo_file" => {
                // todo_file only needs a valid path — no API credentials
            }
            "github" => {
                if self.tracker_api_key.is_none() {
                    return Err(ConfigError::WorkflowParseError {
                        reason: "tracker.api_key is required (or set GITHUB_TOKEN env)".to_string(),
                    });
                }
                if self.tracker_repository.is_none() {
                    return Err(ConfigError::WorkflowParseError {
                        reason: "tracker.repository is required when tracker.kind=github"
                            .to_string(),
                    });
                }
            }
            _ => {
                return Err(ConfigError::WorkflowParseError {
                    reason: format!("unsupported tracker.kind: {kind}"),
                });
            }
        }
        if self.agent_command.is_empty() {
            return Err(ConfigError::WorkflowParseError {
                reason: "agent.command must be non-empty".to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::workflow::parse_workflow;

    fn config_from_yaml(yaml: &str) -> ServiceConfig {
        let content = format!("---\n{yaml}\n---\nPrompt body.");
        let wf = parse_workflow(&content).unwrap();
        ServiceConfig::from_workflow(&wf).unwrap()
    }

    #[test]
    fn test_defaults() {
        let config = ServiceConfig::default();
        assert_eq!(config.poll_interval_ms, 30_000);
        assert_eq!(config.agent_max_concurrent, 10);
        assert_eq!(config.agent_max_turns, 20);
        assert_eq!(config.agent_turn_timeout_ms, 3_600_000);
        assert_eq!(config.agent_read_timeout_ms, 5_000);
        assert_eq!(config.agent_stall_timeout_ms, 300_000);
        assert_eq!(config.hook_timeout_ms, 60_000);
        assert_eq!(config.tracker_active_states, vec!["Todo", "In Progress"]);
        assert_eq!(config.tracker_terminal_states, vec!["Done", "Closed"]);
    }

    #[test]
    fn test_from_workflow_overrides_defaults() {
        let config = config_from_yaml(
            r#"
tracker:
  kind: github
  repository: acme/repo
polling:
  interval_ms: 10000
agent:
  max_concurrent_agents: 5
  command: my-agent
"#,
        );
        assert_eq!(config.tracker_kind.as_deref(), Some("github"));
        assert_eq!(config.tracker_repository.as_deref(), Some("acme/repo"));
        assert_eq!(config.poll_interval_ms, 10_000);
        assert_eq!(config.agent_max_concurrent, 5);
        assert_eq!(config.agent_command, "my-agent");
    }

    #[test]
    fn test_string_integer_coercion() {
        let config = config_from_yaml(
            r#"
polling:
  interval_ms: "15000"
agent:
  max_concurrent_agents: "3"
"#,
        );
        assert_eq!(config.poll_interval_ms, 15_000);
        assert_eq!(config.agent_max_concurrent, 3);
    }

    #[test]
    fn test_per_state_concurrency() {
        let config = config_from_yaml(
            r#"
agent:
  max_concurrent_agents_by_state:
    todo: 2
    In Progress: 5
"#,
        );
        assert_eq!(config.agent_max_concurrent_by_state.get("todo"), Some(&2));
        assert_eq!(
            config.agent_max_concurrent_by_state.get("in progress"),
            Some(&5)
        );
    }

    #[test]
    fn test_per_state_ignores_invalid() {
        let config = config_from_yaml(
            r#"
agent:
  max_concurrent_agents_by_state:
    todo: -1
    good: 3
"#,
        );
        assert_eq!(config.agent_max_concurrent_by_state.get("todo"), None);
        assert_eq!(config.agent_max_concurrent_by_state.get("good"), Some(&3));
    }

    #[test]
    fn test_hook_timeout_non_positive_uses_default() {
        let config = config_from_yaml(
            r#"
hooks:
  timeout_ms: 0
"#,
        );
        assert_eq!(config.hook_timeout_ms, 60_000);
    }

    #[test]
    fn test_env_var_resolution() {
        std::env::set_var("ENSEMBLE_TEST_KEY", "secret123");
        let config = config_from_yaml(
            r#"
tracker:
  api_key: $ENSEMBLE_TEST_KEY
"#,
        );
        assert_eq!(config.tracker_api_key.as_deref(), Some("secret123"));
        std::env::remove_var("ENSEMBLE_TEST_KEY");
    }

    #[test]
    fn test_env_var_empty_treated_as_missing() {
        std::env::set_var("ENSEMBLE_EMPTY_KEY", "");
        let config = config_from_yaml(
            r#"
tracker:
  api_key: $ENSEMBLE_EMPTY_KEY
"#,
        );
        assert_eq!(config.tracker_api_key, None);
        std::env::remove_var("ENSEMBLE_EMPTY_KEY");
    }

    #[test]
    fn test_tilde_expansion() {
        let config = config_from_yaml(
            r#"
workspace:
  root: ~/my_workspaces
"#,
        );
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            config.workspace_root,
            PathBuf::from(home).join("my_workspaces")
        );
    }

    #[test]
    fn test_validate_missing_tracker_kind() {
        let config = ServiceConfig::default();
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_unsupported_tracker_kind() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("linear".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_missing_api_key() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_repository = Some("acme/repo".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_missing_repository() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_xxx".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_github_success() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_xxx".to_string());
        config.tracker_repository = Some("acme/repo".to_string());
        assert!(config.validate_for_dispatch().is_ok());
    }

    #[test]
    fn test_validate_todo_file_success() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("todo_file".to_string());
        assert!(config.validate_for_dispatch().is_ok());
    }

    #[test]
    fn test_validate_todo_file_no_api_key_needed() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("todo_file".to_string());
        config.tracker_api_key = None;
        config.tracker_repository = None;
        assert!(config.validate_for_dispatch().is_ok());
    }

    #[test]
    fn test_labels_filter() {
        let config = config_from_yaml(
            r#"
tracker:
  labels_filter:
    - agent-ready
    - auto-fix
"#,
        );
        assert_eq!(
            config.tracker_labels_filter,
            vec!["agent-ready", "auto-fix"]
        );
    }

    #[test]
    fn test_negative_values_keep_defaults() {
        let config = config_from_yaml(
            r#"
polling:
  interval_ms: -1
agent:
  max_concurrent_agents: -5
  max_turns: -1
  turn_timeout_ms: -1000
server:
  port: -1
"#,
        );
        // All should retain defaults since negative values are rejected
        assert_eq!(config.poll_interval_ms, 30_000);
        assert_eq!(config.agent_max_concurrent, 10);
        assert_eq!(config.agent_max_turns, 20);
        assert_eq!(config.agent_turn_timeout_ms, 3_600_000);
        assert_eq!(config.server_port, None);
    }

    #[test]
    fn test_overflow_port_keeps_default() {
        let config = config_from_yaml(
            r#"
server:
  port: 70000
"#,
        );
        assert_eq!(config.server_port, None);
    }

    #[test]
    fn test_unset_env_var_path_keeps_default() {
        let config = config_from_yaml(
            r#"
workspace:
  root: $ENSEMBLE_NONEXISTENT_VAR_12345
"#,
        );
        // Should keep default, not become a literal path named "$ENSEMBLE_NONEXISTENT_VAR_12345"
        assert_eq!(
            config.workspace_root,
            ServiceConfig::default().workspace_root
        );
    }

    #[test]
    fn test_server_port() {
        let config = config_from_yaml(
            r#"
server:
  port: 8080
"#,
        );
        assert_eq!(config.server_port, Some(8080));
    }
}
