use crate::config::ensemble::{validate_config, EnsembleConfig};
use crate::error::{ConfigError, PipelineError};
use crate::pipeline::dag::build_dag;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigStateKind {
    Missing,
    SyntaxError,
    Parsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ValidationIssue {
    pub kind: ValidationIssueKind,
    pub message: String,
    pub section: String,
    pub field: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema, PartialEq)]
pub enum ValidationIssueKind {
    Syntax,
    Config,
    Environment,
}

#[derive(Debug, Clone, Default)]
pub struct DraftValidationReport {
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone)]
pub struct ConfigDocumentState {
    pub path: PathBuf,
    pub kind: ConfigStateKind,
    pub raw_yaml: Option<String>,
    pub document: Option<serde_yaml::Value>,
    pub active_config: Option<EnsembleConfig>,
    pub validation: DraftValidationReport,
}

pub fn load_config_state(path: &Path) -> Result<ConfigDocumentState, ConfigError> {
    let raw_yaml = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok(ConfigDocumentState {
                    path: path.to_path_buf(),
                    kind: ConfigStateKind::Missing,
                    raw_yaml: None,
                    document: None,
                    active_config: None,
                    validation: DraftValidationReport::default(),
                });
            }
            return Err(ConfigError::PathExpansionError {
                path: path.display().to_string(),
                reason: e.to_string(),
            });
        }
    };

    Ok(parse_raw_yaml(path.to_path_buf(), raw_yaml))
}

pub fn parse_raw_yaml(path: PathBuf, raw_yaml: String) -> ConfigDocumentState {
    let parsed: Result<serde_yaml::Value, _> = serde_yaml::from_str(&raw_yaml);

    match parsed {
        Ok(document) => {
            let typed: Result<EnsembleConfig, _> = serde_yaml::from_value(document.clone());
            match typed {
                Ok(config) => {
                    let mut report = validate_document(&document);
                    if let Err(e) = validate_config(&config) {
                        report.issues.push(pipeline_error_to_validation_issue(e));
                    }
                    if let Err(e) = build_dag(&config.steps) {
                        report.issues.push(pipeline_error_to_validation_issue(e));
                    }
                    ConfigDocumentState {
                        path,
                        kind: ConfigStateKind::Parsed,
                        raw_yaml: Some(raw_yaml),
                        document: Some(document),
                        active_config: Some(config),
                        validation: report,
                    }
                }
                Err(e) => {
                    let report = DraftValidationReport {
                        issues: vec![ValidationIssue {
                            kind: ValidationIssueKind::Syntax,
                            message: e.to_string(),
                            section: "yaml".to_string(),
                            field: None,
                            path: None,
                        }],
                    };
                    ConfigDocumentState {
                        path,
                        kind: ConfigStateKind::SyntaxError,
                        raw_yaml: Some(raw_yaml),
                        document: Some(document),
                        active_config: None,
                        validation: report,
                    }
                }
            }
        }
        Err(e) => {
            let report = DraftValidationReport {
                issues: vec![ValidationIssue {
                    kind: ValidationIssueKind::Syntax,
                    message: e.to_string(),
                    section: "yaml".to_string(),
                    field: None,
                    path: None,
                }],
            };
            ConfigDocumentState {
                path,
                kind: ConfigStateKind::SyntaxError,
                raw_yaml: Some(raw_yaml),
                document: None,
                active_config: None,
                validation: report,
            }
        }
    }
}

pub fn validate_document(document: &serde_yaml::Value) -> DraftValidationReport {
    let mut issues = Vec::new();
    let mut seen_sections = HashSet::new();

    if let Some(mapping) = document.as_mapping() {
        // Validate presence of required top-level sections
        let required_sections = [
            ("tracker", "tracker"),
            ("agents", "agents"),
            ("steps", "workflow"),
            ("on_success", "transitions"),
            ("on_failure", "transitions"),
        ];
        for (key, section) in required_sections {
            if !mapping.contains_key(&serde_yaml::Value::String(key.to_string())) {
                issues.push(ValidationIssue {
                    kind: ValidationIssueKind::Config,
                    message: format!("missing required section: {}", key),
                    section: section.to_string(),
                    field: None,
                    path: Some(key.to_string()),
                });
            }
        }

        // Check for required tracker fields
        if let Some(tracker) = mapping.get("tracker") {
            seen_sections.insert("tracker");
            if let Some(tracker_map) = tracker.as_mapping() {
                if !tracker_map.contains_key("kind") {
                    issues.push(ValidationIssue {
                        kind: ValidationIssueKind::Config,
                        message: "tracker missing required 'kind' field".to_string(),
                        section: "tracker".to_string(),
                        field: Some("kind".to_string()),
                        path: Some("tracker.kind".to_string()),
                    });
                }
            }
        }

        // Validate agents section
        if let Some(agents) = mapping.get("agents") {
            seen_sections.insert("agents");
            if let Some(agents_map) = agents.as_mapping() {
                if agents_map.is_empty() {
                    issues.push(ValidationIssue {
                        kind: ValidationIssueKind::Config,
                        message: "agents section is empty".to_string(),
                        section: "agents".to_string(),
                        field: None,
                        path: Some("agents".to_string()),
                    });
                }
            } else {
                issues.push(ValidationIssue {
                    kind: ValidationIssueKind::Config,
                    message: "agents must be a mapping".to_string(),
                    section: "agents".to_string(),
                    field: None,
                    path: Some("agents".to_string()),
                });
            }
        }

        // Validate steps section
        if let Some(steps) = mapping.get("steps") {
            seen_sections.insert("steps");
            if let Some(steps_vec) = steps.as_sequence() {
                if steps_vec.is_empty() {
                    issues.push(ValidationIssue {
                        kind: ValidationIssueKind::Config,
                        message: "steps section is empty".to_string(),
                        section: "workflow".to_string(),
                        field: None,
                        path: Some("steps".to_string()),
                    });
                }

                // Check for duplicate step names
                let mut step_names = HashSet::new();
                for (idx, step) in steps_vec.iter().enumerate() {
                    if let Some(step_map) = step.as_mapping() {
                        if let Some(name_val) = step_map.get("name") {
                            if let Some(name) = name_val.as_str() {
                                if !step_names.insert(name.to_string()) {
                                    issues.push(ValidationIssue {
                                        kind: ValidationIssueKind::Config,
                                        message: format!("duplicate step name: {}", name),
                                        section: "workflow".to_string(),
                                        field: Some("name".to_string()),
                                        path: Some(format!("steps[{}].name", idx)),
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                issues.push(ValidationIssue {
                    kind: ValidationIssueKind::Config,
                    message: "steps must be a sequence".to_string(),
                    section: "workflow".to_string(),
                    field: None,
                    path: Some("steps".to_string()),
                });
            }
        }
    }

    DraftValidationReport { issues }
}

fn pipeline_error_to_validation_issue(e: PipelineError) -> ValidationIssue {
    use crate::error::PipelineError;

    match e {
        PipelineError::UnknownAgent { name } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("unknown agent reference: {}", name),
            section: "agents".to_string(),
            field: Some(name.clone()),
            path: Some(format!("agents.{}", name)),
        },
        PipelineError::UnknownDependency { step, dependency } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("step '{}' depends on unknown step '{}'", step, dependency),
            section: "workflow".to_string(),
            field: Some("depends".to_string()),
            path: Some(format!("steps.{}", step)),
        },
        PipelineError::CycleDetected => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: "cycle detected in step graph".to_string(),
            section: "workflow".to_string(),
            field: None,
            path: Some("steps".to_string()),
        },
        PipelineError::NoRootSteps => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: "no root steps found (all steps have dependencies)".to_string(),
            section: "workflow".to_string(),
            field: None,
            path: Some("steps".to_string()),
        },
        PipelineError::WritesRequired { step } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!(
                "step '{}' requires tracker writes but tracker doesn't support them",
                step
            ),
            section: "workflow".to_string(),
            field: Some(step.clone()),
            path: Some(format!("steps.{}", step)),
        },
        PipelineError::MaxCyclesExceeded { .. } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: e.to_string(),
            section: "runtime".to_string(),
            field: None,
            path: None,
        },
        PipelineError::InvalidPromptConfig { agent } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!(
                "agent '{}' must have exactly one of 'prompt' or 'prompt_template'",
                agent
            ),
            section: "agents".to_string(),
            field: Some(agent.clone()),
            path: Some(format!("agents.{}", agent)),
        },
        PipelineError::DuplicateStepName { name } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("duplicate step name: {}", name),
            section: "workflow".to_string(),
            field: Some("name".to_string()),
            path: Some(format!("steps.{}", name)),
        },
        PipelineError::InvalidAgentConfig { agent } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!(
                "agent '{}' must have 'acpx_agent' or both 'executor' and 'model'",
                agent
            ),
            section: "agents".to_string(),
            field: Some(agent.clone()),
            path: Some(format!("agents.{}", agent)),
        },
    }
}

pub fn save_raw_yaml_atomically(
    path: &Path,
    raw_yaml: &str,
) -> Result<ConfigDocumentState, ConfigError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    // Validate the YAML before saving
    let draft = parse_raw_yaml(path.to_path_buf(), raw_yaml.to_string());
    if draft.kind == ConfigStateKind::SyntaxError {
        return Err(ConfigError::ConfigWriteRejected {
            reason: "syntax error in YAML".to_string(),
        });
    }

    // Check for config validation errors
    if !draft.validation.issues.is_empty() {
        let has_config_errors = draft
            .validation
            .issues
            .iter()
            .any(|i| matches!(i.kind, ValidationIssueKind::Config));
        if has_config_errors {
            return Err(ConfigError::ConfigWriteRejected {
                reason: "config validation failed".to_string(),
            });
        }
    }

    // Write to temp file then rename for atomic operation
    let temp_path = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config.yaml")
    ));

    if let Err(e) = std::fs::write(&temp_path, raw_yaml) {
        return Err(ConfigError::ConfigWriteFailed {
            reason: format!("failed to write temp file: {}", e),
        });
    }

    if let Err(e) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(ConfigError::ConfigWriteFailed {
            reason: format!("failed to rename temp file: {}", e),
        });
    }

    // Reload the saved config
    load_config_state(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_config_state_reports_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");

        let state = load_config_state(&path).unwrap();

        assert_eq!(state.kind, ConfigStateKind::Missing);
        assert!(state.raw_yaml.is_none());
        assert!(state.active_config.is_none());
    }

    #[test]
    fn load_config_state_preserves_raw_yaml_for_syntax_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(&path, "tracker:\n  kind: todo_file\nagents: [\n").unwrap();

        let state = load_config_state(&path).unwrap();

        assert_eq!(state.kind, ConfigStateKind::SyntaxError);
        assert!(state.raw_yaml.as_deref().unwrap().contains("agents: ["));
        assert!(state
            .validation
            .issues
            .iter()
            .any(|issue| issue.kind == ValidationIssueKind::Syntax));
    }

    #[test]
    fn parse_raw_yaml_creates_parsed_state_for_valid_config() {
        let raw = r#"
tracker:
  kind: todo_file
  path: TODO.md
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
        let path = PathBuf::from("/tmp/test.yaml");
        let state = parse_raw_yaml(path, raw.to_string());

        assert_eq!(state.kind, ConfigStateKind::Parsed);
        assert!(state.document.is_some());
        assert!(state.active_config.is_some());
        assert!(state.validation.issues.is_empty());
    }

    #[test]
    fn validate_document_reports_missing_required_sections() {
        let raw = "foo: bar\n";
        let doc: serde_yaml::Value = serde_yaml::from_str(raw).unwrap();
        let report = validate_document(&doc);

        assert!(report.issues.iter().any(|i| i.section == "tracker"));
        assert!(report.issues.iter().any(|i| i.section == "agents"));
        assert!(report.issues.iter().any(|i| i.section == "workflow"));
    }

    #[test]
    fn validate_document_reports_empty_agents() {
        let raw = r#"
tracker:
  kind: todo_file
agents: {}
steps: []
on_success: Done
on_failure: Failed
"#;
        let doc: serde_yaml::Value = serde_yaml::from_str(raw).unwrap();
        let report = validate_document(&doc);

        assert!(report
            .issues
            .iter()
            .any(|i| i.section == "agents" && i.message.contains("empty")));
    }

    #[test]
    fn validate_document_reports_duplicate_step_names() {
        let raw = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
        let doc: serde_yaml::Value = serde_yaml::from_str(raw).unwrap();
        let report = validate_document(&doc);

        assert!(report
            .issues
            .iter()
            .any(|i| i.message.contains("duplicate step name")));
    }

    #[test]
    fn save_raw_yaml_atomically_rejects_invalid_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let invalid_yaml = "not valid yaml: [";

        let result = save_raw_yaml_atomically(&path, invalid_yaml);

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            ConfigError::ConfigWriteRejected { .. }
        ));
        assert!(!path.exists());
    }

    #[test]
    fn save_raw_yaml_atomically_rejects_config_with_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        // Valid YAML but invalid config (empty agents)
        let invalid_config = r#"
tracker:
  kind: todo_file
agents: {}
steps: []
on_success: Done
on_failure: Failed
"#;

        let result = save_raw_yaml_atomically(&path, invalid_config);

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            ConfigError::ConfigWriteRejected { .. }
        ));
        assert!(!path.exists());
    }

    #[test]
    fn save_raw_yaml_atomically_saves_valid_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let valid_config = r#"
tracker:
  kind: todo_file
  path: TODO.md
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

        let result = save_raw_yaml_atomically(&path, valid_config).unwrap();

        assert_eq!(result.kind, ConfigStateKind::Parsed);
        assert!(path.exists());
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("acpx_agent: claude"));
    }

    #[test]
    fn pipeline_errors_converted_to_validation_issues() {
        let error = PipelineError::UnknownAgent {
            name: "missing_agent".to_string(),
        };
        let issue = pipeline_error_to_validation_issue(error);

        assert!(matches!(issue.kind, ValidationIssueKind::Config));
        assert_eq!(issue.section, "agents");
        assert!(issue.message.contains("missing_agent"));
    }
}
