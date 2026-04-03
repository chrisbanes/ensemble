//! Guided form extraction and merge for configuration editing.
//!
//! This module provides bidirectional conversion between raw YAML and
//! a structured form representation suitable for guided editing.
//! The key constraint: unknown YAML fields are preserved during the
//! round-trip to support custom user extensions.

use crate::error::ConfigError;
use serde::{Deserialize, Serialize};

/// Helper to convert Option<T> to serde_yaml::Value
fn opt_to_value<T: Into<serde_yaml::Value>>(opt: Option<T>) -> Option<serde_yaml::Value> {
    opt.map(|v| v.into())
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

    // Update tracker section — merge into existing mapping to preserve unknown fields
    let tracker_val = mapping
        .entry("tracker".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut tm) = *tracker_val {
        tm.insert("kind".into(), form.tracker.kind.clone().into());
        if let Some(v) = opt_to_value(form.tracker.path.clone()) {
            tm.insert("path".into(), v);
        } else {
            tm.remove("path");
        }
        if let Some(v) = opt_to_value(form.tracker.repository.clone()) {
            tm.insert("repository".into(), v);
        } else {
            tm.remove("repository");
        }
        if let Some(v) = opt_to_value(form.tracker.project_number) {
            tm.insert("project_number".into(), v);
        } else {
            tm.remove("project_number");
        }
        if let Some(v) = opt_to_value(form.tracker.api_key.clone()) {
            tm.insert("api_key".into(), v);
        } else {
            tm.remove("api_key");
        }
        if let Some(v) = opt_to_value(form.tracker.endpoint.clone()) {
            tm.insert("endpoint".into(), v);
        } else {
            tm.remove("endpoint");
        }
        tm.insert(
            "active_states".into(),
            form.tracker.active_states.clone().into(),
        );
        tm.insert(
            "terminal_states".into(),
            form.tracker.terminal_states.clone().into(),
        );
        if form.tracker.kind == "github" {
            tm.insert(
                "labels_filter".into(),
                form.tracker.labels_filter.clone().into(),
            );
        } else {
            tm.remove("labels_filter");
        }
    }

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
    if !repos_seq.is_empty() {
        mapping.insert("repos".into(), repos_seq.into());
    } else {
        mapping.remove("repos");
    }

    // Update agents section — merge into existing mappings to preserve unknown fields
    let agents_val = mapping
        .entry("agents".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut agents_map) = *agents_val {
        for a in &form.agents {
            let agent_val = agents_map
                .entry(a.name.clone().into())
                .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
            if let serde_yaml::Value::Mapping(ref mut am) = *agent_val {
                if let Some(v) = opt_to_value(a.executor.clone()) {
                    am.insert("executor".into(), v);
                } else {
                    am.remove("executor");
                }
                if let Some(v) = opt_to_value(a.model.clone()) {
                    am.insert("model".into(), v);
                } else {
                    am.remove("model");
                }
                if let Some(v) = opt_to_value(a.acpx_agent.clone()) {
                    am.insert("acpx_agent".into(), v);
                } else {
                    am.remove("acpx_agent");
                }
                if let Some(v) = opt_to_value(a.prompt.clone()) {
                    am.insert("prompt".into(), v);
                } else {
                    am.remove("prompt");
                }
                if let Some(v) = opt_to_value(a.prompt_template.clone()) {
                    am.insert("prompt_template".into(), v);
                } else {
                    am.remove("prompt_template");
                }
                if let Some(v) = opt_to_value(a.reasoning_level.clone()) {
                    am.insert("reasoning_level".into(), v);
                } else {
                    am.remove("reasoning_level");
                }
            }
        }
    }

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

    // Update concurrency
    let concurrency_val = mapping
        .entry("concurrency".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut cm) = *concurrency_val {
        cm.insert(
            "max_concurrent_agents".into(),
            form.runtime.concurrency.max_concurrent_agents.into(),
        );
        cm.insert(
            "max_step_parallelism".into(),
            form.runtime.concurrency.max_step_parallelism.into(),
        );
    }

    // Update polling
    let polling_val = mapping
        .entry("polling".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut pm) = *polling_val {
        pm.insert(
            "interval_ms".into(),
            form.runtime.polling.interval_ms.into(),
        );
    }

    // Update workspace
    let workspace_val = mapping
        .entry("workspace".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut wm) = *workspace_val {
        if let Some(v) = opt_to_value(form.runtime.workspace.root.clone()) {
            wm.insert("root".into(), v);
        } else {
            wm.remove("root");
        }
    }

    // Update hooks
    let hooks_val = mapping
        .entry("hooks".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut hm) = *hooks_val {
        if let Some(v) = opt_to_value(form.runtime.hooks.after_create.clone()) {
            hm.insert("after_create".into(), v);
        } else {
            hm.remove("after_create");
        }
        if let Some(v) = opt_to_value(form.runtime.hooks.before_run.clone()) {
            hm.insert("before_run".into(), v);
        } else {
            hm.remove("before_run");
        }
        if let Some(v) = opt_to_value(form.runtime.hooks.after_run.clone()) {
            hm.insert("after_run".into(), v);
        } else {
            hm.remove("after_run");
        }
        if let Some(v) = opt_to_value(form.runtime.hooks.before_remove.clone()) {
            hm.insert("before_remove".into(), v);
        } else {
            hm.remove("before_remove");
        }
        hm.insert("timeout_ms".into(), form.runtime.hooks.timeout_ms.into());
    }

    // Update agent runtime
    let agent_val = mapping
        .entry("agent".into())
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if let serde_yaml::Value::Mapping(ref mut am) = *agent_val {
        am.insert("max_turns".into(), form.runtime.agent.max_turns.into());
        am.insert(
            "max_retry_backoff_ms".into(),
            form.runtime.agent.max_retry_backoff_ms.into(),
        );
        am.insert("command".into(), form.runtime.agent.command.clone().into());
        am.insert(
            "session_mode".into(),
            form.runtime.agent.session_mode.clone().into(),
        );
        am.insert(
            "permission_policy".into(),
            form.runtime.agent.permission_policy.clone().into(),
        );
        am.insert(
            "turn_timeout_ms".into(),
            form.runtime.agent.turn_timeout_ms.into(),
        );
        am.insert(
            "read_timeout_ms".into(),
            form.runtime.agent.read_timeout_ms.into(),
        );
        am.insert(
            "stall_timeout_ms".into(),
            form.runtime.agent.stall_timeout_ms.into(),
        );
    }

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

fn replace_known_fields<const N: usize>(
    mapping: &mut serde_yaml::Mapping,
    fields: [(&str, serde_yaml::Value); N],
) {
    for (key, value) in fields {
        if value.is_null() {
            mapping.remove(key);
        } else {
            mapping.insert(key.into(), value);
        }
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
    fn apply_guided_form_preserves_unknown_fields_in_sections() {
        let raw = r#"
tracker:
  kind: todo_file
  custom_tracker_field: "keep me"
agents:
  builder:
    acpx_agent: claude
    prompt: hello
    custom_agent_field: 42
steps:
  - name: implement
    agent: builder
concurrency:
  max_concurrent_agents: 4
  max_step_parallelism: 2
  custom_concurrency_field: true
on_success: Done
on_failure: Failed
"#;

        let merged = apply_guided_form(raw, &guided_form_with_workspace_root("/tmp/ws")).unwrap();
        assert!(merged.contains("custom_tracker_field: keep me"));
        assert!(merged.contains("custom_agent_field: 42"));
        assert!(merged.contains("custom_concurrency_field: true"));
    }

    #[test]
    fn apply_guided_form_omits_none_fields() {
        let raw = r#"
tracker:
  kind: todo_file
  path: /some/path
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

        let form = guided_form_with_workspace_root("/tmp/ws");
        // form.tracker.path is None, so the existing path should be removed
        let merged = apply_guided_form(raw, &form).unwrap();
        // Parse back and check path is gone
        let val: serde_yaml::Value = serde_yaml::from_str(&merged).unwrap();
        let tracker = val.get("tracker").unwrap().as_mapping().unwrap();
        assert!(
            !tracker.contains_key("path"),
            "path should be removed when form value is None"
        );
    }

    #[test]
    fn apply_guided_form_skips_labels_filter_for_todo_file() {
        let raw = r#"
tracker:
  kind: todo_file
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

        let form = guided_form_with_workspace_root("/tmp/ws");
        let merged = apply_guided_form(raw, &form).unwrap();
        let val: serde_yaml::Value = serde_yaml::from_str(&merged).unwrap();
        let tracker = val.get("tracker").unwrap().as_mapping().unwrap();
        assert!(
            !tracker.contains_key("labels_filter"),
            "labels_filter should not be written for todo_file tracker"
        );
    }
}
