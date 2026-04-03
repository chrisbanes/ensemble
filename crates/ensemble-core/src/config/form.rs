//! Guided form extraction and merge for configuration editing.
//!
//! This module provides bidirectional conversion between raw YAML and
//! a structured form representation suitable for guided editing.
//! The key constraint: unknown YAML fields are preserved during the
//! round-trip to support custom user extensions.

use crate::error::ConfigError;
use serde::{Deserialize, Serialize};

/// Helper to convert Option<T> to serde_yaml::Value
fn opt_to_value<T: Into<serde_yaml::Value>>(opt: Option<T>) -> serde_yaml::Value {
    match opt {
        Some(v) => v.into(),
        None => serde_yaml::Value::Null,
    }
}

/// Guided form representation for structured config editing.
/// This is a stable JSON shape that the frontend uses for guided editing.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedConfigForm {
    pub tracker: GuidedTrackerForm,
    pub repos: Vec<GuidedRepoForm>,
    pub agents: Vec<GuidedAgentForm>,
    pub steps: Vec<GuidedStepForm>,
    pub runtime: GuidedRuntimeForm,
    pub transitions: GuidedTransitionForm,
}

/// Tracker section in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedTrackerForm {
    pub kind: String,
    pub path: Option<String>,
    pub repository: Option<String>,
    pub project_number: Option<i64>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
    pub labels_filter: Vec<String>,
}

/// Repo section in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedRepoForm {
    pub path: String,
    pub branch: String,
    pub git_remote: String,
}

/// Agent section in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedAgentForm {
    pub name: String,
    pub executor: Option<String>,
    pub model: Option<String>,
    pub acpx_agent: Option<String>,
    pub prompt: Option<String>,
    pub prompt_template: Option<String>,
    pub reasoning_level: Option<String>,
}

/// Step section in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedStepForm {
    pub name: String,
    pub agent: String,
    pub depends: Vec<String>,
    pub tracker_state: Option<String>,
}

/// Runtime configuration in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedRuntimeForm {
    pub max_cycles: u32,
    pub concurrency: GuidedConcurrencyForm,
    pub polling: GuidedPollingForm,
    pub workspace: GuidedWorkspaceForm,
    pub hooks: GuidedHooksForm,
    pub agent: GuidedAgentRuntimeForm,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedConcurrencyForm {
    pub max_concurrent_agents: u32,
    pub max_step_parallelism: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedPollingForm {
    pub interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedWorkspaceForm {
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedHooksForm {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedAgentRuntimeForm {
    pub max_turns: u32,
    pub max_retry_backoff_ms: u64,
    pub command: String,
    pub session_mode: String,
    pub permission_policy: String,
    pub turn_timeout_ms: u64,
    pub read_timeout_ms: u64,
    pub stall_timeout_ms: i64,
}

/// State transitions in guided form.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GuidedTransitionForm {
    pub on_success: String,
    pub on_failure: String,
}

/// Extract a guided form from raw YAML content.
///
/// This parses the YAML into an EnsembleConfig and converts it to the
/// guided form representation. If parsing fails, returns a ConfigError.
pub fn extract_guided_form(raw_yaml: &str) -> Result<GuidedConfigForm, ConfigError> {
    let config = crate::config::ensemble::parse_config(raw_yaml)?;

    Ok(GuidedConfigForm {
        tracker: GuidedTrackerForm {
            kind: config.tracker.kind.clone(),
            path: config
                .tracker
                .path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            repository: config.tracker.repository.clone(),
            project_number: config.tracker.project_number,
            api_key: config.tracker.api_key.clone(),
            endpoint: config.tracker.endpoint.clone(),
            active_states: config.tracker.active_states.clone(),
            terminal_states: config.tracker.terminal_states.clone(),
            labels_filter: config.tracker.labels_filter.clone(),
        },
        repos: config
            .repos
            .iter()
            .map(|r| GuidedRepoForm {
                path: r.path.clone(),
                branch: r.branch.clone(),
                git_remote: r.git_remote.clone(),
            })
            .collect(),
        agents: config
            .agents
            .iter()
            .map(|(name, agent)| GuidedAgentForm {
                name: name.clone(),
                executor: agent.executor.clone(),
                model: agent.model.clone(),
                acpx_agent: agent.acpx_agent.clone(),
                prompt: agent.prompt.clone(),
                prompt_template: agent
                    .prompt_template
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                reasoning_level: agent.reasoning_level.clone(),
            })
            .collect(),
        steps: config
            .steps
            .iter()
            .map(|s| GuidedStepForm {
                name: s.name.clone(),
                agent: s.agent.clone(),
                depends: s.depends.clone().unwrap_or_default(),
                tracker_state: s.tracker_state.clone(),
            })
            .collect(),
        runtime: GuidedRuntimeForm {
            max_cycles: config.max_cycles,
            concurrency: GuidedConcurrencyForm {
                max_concurrent_agents: config.concurrency.max_concurrent_agents,
                max_step_parallelism: config.concurrency.max_step_parallelism,
            },
            polling: GuidedPollingForm {
                interval_ms: config.polling.interval_ms,
            },
            workspace: GuidedWorkspaceForm {
                root: config.workspace.root.clone(),
            },
            hooks: GuidedHooksForm {
                after_create: config.hooks.after_create.clone(),
                before_run: config.hooks.before_run.clone(),
                after_run: config.hooks.after_run.clone(),
                before_remove: config.hooks.before_remove.clone(),
                timeout_ms: config.hooks.timeout_ms,
            },
            agent: GuidedAgentRuntimeForm {
                max_turns: config.agent.max_turns,
                max_retry_backoff_ms: config.agent.max_retry_backoff_ms,
                command: config.agent.command.clone(),
                session_mode: config.agent.session_mode.clone(),
                permission_policy: config.agent.permission_policy.clone(),
                turn_timeout_ms: config.agent.turn_timeout_ms,
                read_timeout_ms: config.agent.read_timeout_ms,
                stall_timeout_ms: config.agent.stall_timeout_ms,
            },
        },
        transitions: GuidedTransitionForm {
            on_success: config.on_success.clone(),
            on_failure: config.on_failure.clone(),
        },
    })
}

/// Apply a guided form back to the base YAML, preserving unknown fields.
///
/// This function merges the guided form into the base YAML by editing
/// a parsed serde_yaml::Value tree instead of reserializing from only
/// the typed config struct. This ensures that unknown/custom YAML fields
/// are preserved.
///
/// Returns the merged YAML string.
pub fn apply_guided_form(
    base_raw_yaml: &str,
    form: &GuidedConfigForm,
) -> Result<String, ConfigError> {
    // Parse the base YAML into a Value tree
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(base_raw_yaml).map_err(|e| ConfigError::ConfigParseError {
            reason: e.to_string(),
        })?;

    // Ensure we have a Mapping at the root
    let mapping = match value {
        serde_yaml::Value::Mapping(ref mut m) => m,
        _ => {
            return Err(ConfigError::ConfigParseError {
                reason: "Root YAML value must be a mapping".to_string(),
            });
        }
    };

    // Update tracker section
    let tracker_mapping = get_or_create_mapping(mapping, "tracker");
    replace_known_fields(
        tracker_mapping,
        [
            ("kind", form.tracker.kind.clone().into()),
            ("path", opt_to_value(form.tracker.path.clone())),
            ("repository", opt_to_value(form.tracker.repository.clone())),
            ("project_number", opt_to_value(form.tracker.project_number)),
            ("api_key", opt_to_value(form.tracker.api_key.clone())),
            ("endpoint", opt_to_value(form.tracker.endpoint.clone())),
            ("active_states", form.tracker.active_states.clone().into()),
            (
                "terminal_states",
                form.tracker.terminal_states.clone().into(),
            ),
            ("labels_filter", form.tracker.labels_filter.clone().into()),
        ],
    );

    // Update repos section
    let repos_seq: Vec<serde_yaml::Value> = form
        .repos
        .iter()
        .enumerate()
        .map(|(idx, r)| {
            let mut repo_mapping = existing_sequence_mapping(mapping, "repos", idx);
            replace_known_fields(
                &mut repo_mapping,
                [
                    ("path", r.path.clone().into()),
                    ("branch", r.branch.clone().into()),
                    ("git_remote", r.git_remote.clone().into()),
                ],
            );
            repo_mapping.into()
        })
        .collect();
    mapping.insert("repos".into(), repos_seq.into());

    // Update agents section
    let existing_agents = mapping
        .get("agents")
        .and_then(serde_yaml::Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    let agents_mapping = serde_yaml::Mapping::from_iter(form.agents.iter().map(|a| {
        let mut agent_mapping = existing_agents
            .get(serde_yaml::Value::String(a.name.clone()))
            .and_then(serde_yaml::Value::as_mapping)
            .cloned()
            .unwrap_or_default();
        replace_known_fields(
            &mut agent_mapping,
            [
                ("executor", opt_to_value(a.executor.clone())),
                ("model", opt_to_value(a.model.clone())),
                ("acpx_agent", opt_to_value(a.acpx_agent.clone())),
                ("prompt", opt_to_value(a.prompt.clone())),
                ("prompt_template", opt_to_value(a.prompt_template.clone())),
                ("reasoning_level", opt_to_value(a.reasoning_level.clone())),
            ],
        );
        (a.name.clone().into(), agent_mapping.into())
    }));
    mapping.insert("agents".into(), agents_mapping.into());

    // Update steps section
    let steps_seq: Vec<serde_yaml::Value> = form
        .steps
        .iter()
        .enumerate()
        .map(|(idx, s)| {
            let mut step_mapping = existing_sequence_mapping(mapping, "steps", idx);
            replace_known_fields(
                &mut step_mapping,
                [
                    ("name", s.name.clone().into()),
                    ("agent", s.agent.clone().into()),
                ],
            );
            step_mapping.remove("depends");
            if !s.depends.is_empty() {
                step_mapping.insert("depends".into(), s.depends.clone().into());
            }
            step_mapping.remove("tracker_state");
            if let Some(ref tracker_state) = s.tracker_state {
                step_mapping.insert("tracker_state".into(), tracker_state.clone().into());
            }
            step_mapping.into()
        })
        .collect();
    mapping.insert("steps".into(), steps_seq.into());

    // Update runtime settings
    replace_known_fields(
        get_or_create_mapping(mapping, "concurrency"),
        [
            (
                "max_concurrent_agents",
                form.runtime.concurrency.max_concurrent_agents.into(),
            ),
            (
                "max_step_parallelism",
                form.runtime.concurrency.max_step_parallelism.into(),
            ),
        ],
    );

    replace_known_fields(
        get_or_create_mapping(mapping, "polling"),
        [("interval_ms", form.runtime.polling.interval_ms.into())],
    );

    replace_known_fields(
        get_or_create_mapping(mapping, "workspace"),
        [("root", opt_to_value(form.runtime.workspace.root.clone()))],
    );

    replace_known_fields(
        get_or_create_mapping(mapping, "hooks"),
        [
            (
                "after_create",
                opt_to_value(form.runtime.hooks.after_create.clone()),
            ),
            (
                "before_run",
                opt_to_value(form.runtime.hooks.before_run.clone()),
            ),
            (
                "after_run",
                opt_to_value(form.runtime.hooks.after_run.clone()),
            ),
            (
                "before_remove",
                opt_to_value(form.runtime.hooks.before_remove.clone()),
            ),
            ("timeout_ms", form.runtime.hooks.timeout_ms.into()),
        ],
    );

    replace_known_fields(
        get_or_create_mapping(mapping, "agent"),
        [
            ("max_turns", form.runtime.agent.max_turns.into()),
            (
                "max_retry_backoff_ms",
                form.runtime.agent.max_retry_backoff_ms.into(),
            ),
            ("command", form.runtime.agent.command.clone().into()),
            (
                "session_mode",
                form.runtime.agent.session_mode.clone().into(),
            ),
            (
                "permission_policy",
                form.runtime.agent.permission_policy.clone().into(),
            ),
            ("turn_timeout_ms", form.runtime.agent.turn_timeout_ms.into()),
            ("read_timeout_ms", form.runtime.agent.read_timeout_ms.into()),
            (
                "stall_timeout_ms",
                form.runtime.agent.stall_timeout_ms.into(),
            ),
        ],
    );

    // Update max_cycles
    mapping.insert("max_cycles".into(), form.runtime.max_cycles.into());

    // Update transitions
    mapping.insert(
        "on_success".into(),
        form.transitions.on_success.clone().into(),
    );
    mapping.insert(
        "on_failure".into(),
        form.transitions.on_failure.clone().into(),
    );

    // Serialize back to YAML
    serde_yaml::to_string(&value).map_err(|e| ConfigError::ConfigParseError {
        reason: e.to_string(),
    })
}

fn get_or_create_mapping<'a>(
    mapping: &'a mut serde_yaml::Mapping,
    key: &str,
) -> &'a mut serde_yaml::Mapping {
    let value = mapping
        .entry(serde_yaml::Value::String(key.to_string()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !matches!(value, serde_yaml::Value::Mapping(_)) {
        *value = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    match value {
        serde_yaml::Value::Mapping(inner) => inner,
        _ => unreachable!(),
    }
}

fn replace_known_fields<const N: usize>(
    mapping: &mut serde_yaml::Mapping,
    fields: [(&str, serde_yaml::Value); N],
) {
    for (key, value) in fields {
        mapping.insert(key.into(), value);
    }
}

fn existing_sequence_mapping(
    mapping: &serde_yaml::Mapping,
    key: &str,
    index: usize,
) -> serde_yaml::Mapping {
    mapping
        .get(key)
        .and_then(serde_yaml::Value::as_sequence)
        .and_then(|items| items.get(index))
        .and_then(serde_yaml::Value::as_mapping)
        .cloned()
        .unwrap_or_default()
}

/// Guided form request with base YAML.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct GuidedFormRequest {
    pub base_raw_yaml: String,
    pub form: GuidedConfigForm,
}

/// Guided form validation response.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct GuidedFormValidationResponse {
    pub merged_yaml: String,
    pub issues: Vec<crate::config::draft::ValidationIssue>,
    pub valid: bool,
}

/// Guided form save response.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct GuidedFormSaveResponse {
    pub merged_yaml: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guided_form_with_workspace_root(root: &str) -> GuidedConfigForm {
        GuidedConfigForm {
            tracker: GuidedTrackerForm {
                kind: "todo_file".to_string(),
                path: None,
                repository: None,
                project_number: None,
                api_key: None,
                endpoint: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
            repos: vec![],
            agents: vec![GuidedAgentForm {
                name: "builder".to_string(),
                executor: None,
                model: None,
                acpx_agent: Some("claude".to_string()),
                prompt: Some("hello".to_string()),
                prompt_template: None,
                reasoning_level: None,
            }],
            steps: vec![GuidedStepForm {
                name: "implement".to_string(),
                agent: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            runtime: GuidedRuntimeForm {
                max_cycles: 3,
                concurrency: GuidedConcurrencyForm {
                    max_concurrent_agents: 4,
                    max_step_parallelism: 2,
                },
                polling: GuidedPollingForm { interval_ms: 30000 },
                workspace: GuidedWorkspaceForm {
                    root: Some(root.to_string()),
                },
                hooks: GuidedHooksForm {
                    after_create: None,
                    before_run: None,
                    after_run: None,
                    before_remove: None,
                    timeout_ms: 60000,
                },
                agent: GuidedAgentRuntimeForm {
                    max_turns: 20,
                    max_retry_backoff_ms: 300000,
                    command: "claude-code".to_string(),
                    session_mode: "code".to_string(),
                    permission_policy: "auto_approve_all".to_string(),
                    turn_timeout_ms: 3600000,
                    read_timeout_ms: 5000,
                    stall_timeout_ms: 300000,
                },
            },
            transitions: GuidedTransitionForm {
                on_success: "Done".to_string(),
                on_failure: "Failed".to_string(),
            },
        }
    }

    #[test]
    fn apply_guided_form_preserves_unknown_top_level_fields() {
        let raw = r#"
tracker:
  kind: todo_file
custom_section:
  keep_me: true
agents:
  builder:
    acpx_agent: claude
    prompt: hello
steps:
  - name: implement
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let merged = apply_guided_form(raw, &guided_form_with_workspace_root("/tmp/ws")).unwrap();
        assert!(merged.contains("custom_section:"));
        assert!(merged.contains("keep_me: true"));
    }

    #[test]
    fn apply_guided_form_preserves_unknown_nested_fields_in_managed_sections() {
        let mut form = guided_form_with_workspace_root("/tmp/ws");
        form.repos = vec![GuidedRepoForm {
            path: "new-repo".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
        }];

        let raw = r#"
tracker:
  kind: todo_file
  path: old.md
  custom_tracker_field: keep-me
repos:
  - path: old-repo
    branch: old-branch
    custom_repo_field: keep-me
agents:
  builder:
    acpx_agent: claude
    prompt: old prompt
    custom_agent_field: keep-me
steps:
  - name: implement
    agent: builder
    custom_step_field: keep-me
on_success: Done
on_failure: Failed
"#;

        let merged = apply_guided_form(raw, &form).unwrap();

        assert!(merged.contains("custom_tracker_field: keep-me"));
        assert!(merged.contains("custom_repo_field: keep-me"));
        assert!(merged.contains("custom_agent_field: keep-me"));
        assert!(merged.contains("custom_step_field: keep-me"));
    }
}
