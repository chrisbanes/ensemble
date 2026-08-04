use crate::config::ensemble::{read_dotenv, validate_config, EnsembleConfig};
use crate::error::{ConfigError, PipelineError};
use crate::pipeline::dag::build_dag;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
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

pub fn missing_config_state(path: PathBuf) -> ConfigDocumentState {
    ConfigDocumentState {
        path,
        kind: ConfigStateKind::Missing,
        raw_yaml: None,
        document: None,
        active_config: None,
        validation: DraftValidationReport::default(),
    }
}

pub fn load_config_state(path: &Path) -> Result<ConfigDocumentState, ConfigError> {
    let raw_yaml = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok(missing_config_state(path.to_path_buf()));
            }
            return Err(ConfigError::PathExpansionError {
                path: path.display().to_string(),
                reason: e.to_string(),
            });
        }
    };

    Ok(parse_raw_yaml(path.to_path_buf(), raw_yaml))
}

/// Recover any private setup transaction before parsing public configuration.
///
/// Hosts must use this entry point before constructing root-scoped runtime
/// resources so a mixed setup generation fails closed.
pub fn recover_and_load_config_state(path: &Path) -> Result<ConfigDocumentState, ConfigError> {
    crate::config::setup_transaction::recover_setup_before_load(path)?;
    load_config_state(path)
}

pub fn load_config_document_or_missing(path: &Path) -> ConfigDocumentState {
    match load_config_state(path) {
        Ok(state) => state,
        Err(error) => {
            tracing::error!(error = %error, path = %path.display(), "failed to load config state");
            missing_config_state(path.to_path_buf())
        }
    }
}

pub fn parse_raw_yaml(path: PathBuf, raw_yaml: String) -> ConfigDocumentState {
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let dotenv_map = read_dotenv(&config_dir.join(".env"));
    parse_raw_yaml_with_dotenv(path, raw_yaml, &dotenv_map)
}

pub(crate) fn parse_raw_yaml_with_dotenv(
    path: PathBuf,
    raw_yaml: String,
    dotenv_map: &std::collections::HashMap<String, String>,
) -> ConfigDocumentState {
    let parsed: Result<serde_yaml::Value, _> = serde_yaml::from_str(&raw_yaml);
    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));

    match parsed {
        Ok(document) => {
            let typed: Result<EnsembleConfig, ConfigError> =
                crate::config::ensemble::reject_unsupported_agent_max_turns(&document).and_then(
                    |_| {
                        serde_yaml::from_value(document.clone()).map_err(|e| {
                            ConfigError::ConfigParseError {
                                reason: e.to_string(),
                            }
                        })
                    },
                );
            match typed {
                Ok(mut config) => {
                    let mut report = validate_document(&document);
                    let mut config_valid = true;
                    if let Err(e) = config.resolve_env_from(config_dir, dotenv_map) {
                        report.issues.push(config_error_to_validation_issue(e));
                        config_valid = false;
                    }
                    if let Err(e) = validate_config(&config) {
                        report.issues.push(pipeline_error_to_validation_issue(e));
                        config_valid = false;
                    }
                    if let Err(e) = build_dag(&config.steps) {
                        report.issues.push(pipeline_error_to_validation_issue(e));
                        config_valid = false;
                    }
                    ConfigDocumentState {
                        path,
                        kind: ConfigStateKind::Parsed,
                        raw_yaml: Some(raw_yaml),
                        document: Some(document),
                        active_config: if config_valid { Some(config) } else { None },
                        validation: report,
                    }
                }
                Err(e) => {
                    let mut report = validate_document(&document);
                    report.issues.push(ValidationIssue {
                        kind: ValidationIssueKind::Config,
                        message: e.to_string(),
                        section: "config".to_string(),
                        field: None,
                        path: None,
                    });
                    ConfigDocumentState {
                        path,
                        kind: ConfigStateKind::Parsed,
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
            if !mapping.contains_key(serde_yaml::Value::String(key.to_string())) {
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

        if mapping.contains_key("push_strategy") {
            issues.push(ValidationIssue {
                kind: ValidationIssueKind::Config,
                message: "push_strategy has been removed; configure repos[].finalize instead (manual->mode:none, auto_push->mode:push, pr_only->mode:push_and_pr, ask->approval_required:true + explicit mode)".to_string(),
                section: "workflow".to_string(),
                field: Some("push_strategy".to_string()),
                path: Some("push_strategy".to_string()),
            });
        }
    }

    DraftValidationReport { issues }
}

fn pipeline_error_to_validation_issue(e: PipelineError) -> ValidationIssue {
    use crate::error::PipelineError;

    match e {
        PipelineError::InvalidAcceptanceCommand { name, reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("invalid acceptance command '{}': {}", name, reason),
            section: "acceptance".to_string(),
            field: Some(name.clone()),
            path: Some(format!("acceptance.commands.{}", name)),
        },
        PipelineError::InvalidAcceptanceRequirement { kind, name, reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("invalid acceptance {kind} requirement '{name}': {reason}"),
            section: "acceptance".to_string(),
            field: Some(name.clone()),
            path: Some(format!("acceptance.{kind}.{name}")),
        },
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
        PipelineError::InvalidStepConfig { step, reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("invalid step config for '{}': {}", step, reason),
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
        PipelineError::InvalidPermissionMode { agent, reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("agent '{}': {}", agent, reason),
            section: "agents".to_string(),
            field: Some("permission_mode".to_string()),
            path: Some(format!("agents.{}.permission_mode", agent)),
        },
        PipelineError::InvalidRuntimeConfig { agent, reason } => {
            if agent == "agent" {
                ValidationIssue {
                    kind: ValidationIssueKind::Config,
                    message: format!("agent '{}': {}", agent, reason),
                    section: "agent".to_string(),
                    field: Some("permission_request_policy".to_string()),
                    path: Some("agent.permission_request_policy".to_string()),
                }
            } else {
                ValidationIssue {
                    kind: ValidationIssueKind::Config,
                    message: format!("agent '{}': {}", agent, reason),
                    section: "agents".to_string(),
                    field: Some("runtime".to_string()),
                    path: Some(format!("agents.{}.runtime", agent)),
                }
            }
        }
        PipelineError::InvalidSynthesisStep { step, reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("invalid synthesis step '{}': {}", step, reason),
            section: "workflow".to_string(),
            field: Some("kind".to_string()),
            path: Some(format!("steps.{}", step)),
        },
        PipelineError::InvalidSnapshot { reason } => ValidationIssue {
            kind: ValidationIssueKind::Config,
            message: format!("invalid pipeline snapshot: {}", reason),
            section: "runtime".to_string(),
            field: None,
            path: None,
        },
    }
}

fn config_error_to_validation_issue(error: ConfigError) -> ValidationIssue {
    ValidationIssue {
        kind: ValidationIssueKind::Environment,
        message: error.to_string(),
        section: "config".to_string(),
        field: None,
        path: None,
    }
}

pub fn save_raw_yaml_atomically(
    path: &Path,
    raw_yaml: &str,
) -> Result<ConfigDocumentState, ConfigError> {
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

    persist_config_atomically(path, raw_yaml)?;

    // Reload the saved config
    load_config_state(path)
}

pub fn persist_config_atomically(path: &Path, contents: &str) -> Result<(), ConfigError> {
    let mut temporary = create_config_temporary(path)?;

    temporary
        .write_all(contents.as_bytes())
        .and_then(|_| temporary.flush())
        .map_err(|error| ConfigError::ConfigWriteFailed {
            reason: format!("failed to write temporary config file: {error}"),
        })?;

    temporary
        .persist(path)
        .map_err(|error| ConfigError::ConfigWriteFailed {
            reason: format!("failed to replace config file: {}", error.error),
        })?;
    Ok(())
}

fn create_config_temporary(path: &Path) -> Result<tempfile::NamedTempFile, ConfigError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;

        match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => metadata.permissions(),
            Ok(_) => {
                return Err(ConfigError::ConfigWriteFailed {
                    reason: "config destination is not a file".to_string(),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::Permissions::from_mode(0o600)
            }
            Err(error) => {
                return Err(ConfigError::ConfigWriteFailed {
                    reason: format!("failed to inspect existing config permissions: {error}"),
                })
            }
        }
    };

    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        ConfigError::ConfigWriteFailed {
            reason: format!("failed to create temporary config file: {error}"),
        }
    })?;

    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| ConfigError::ConfigWriteFailed {
            reason: format!("failed to secure temporary config file: {error}"),
        })?;

    Ok(temporary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ENV_VARS: &[&str] = &[
        "ENSEMBLE_DRAFT_TEST_ROOT",
        "ENSEMBLE_DRAFT_TEST_DOTENV_ONLY",
    ];

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
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
    fn missing_config_state_has_missing_kind_and_no_active_config() {
        let path = PathBuf::from("/tmp/config.yaml");
        let state = missing_config_state(path.clone());

        assert_eq!(state.path, path);
        assert_eq!(state.kind, ConfigStateKind::Missing);
        assert!(state.active_config.is_none());
        assert!(state.raw_yaml.is_none());
    }

    #[test]
    fn load_config_document_or_missing_returns_missing_state_on_load_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = load_config_document_or_missing(dir.path());

        assert_eq!(state.path, dir.path());
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
    fn env_guard_restores_tracked_vars() {
        let guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("ENSEMBLE_DRAFT_TEST_ROOT", "before");
        let saved = vec![(
            "ENSEMBLE_DRAFT_TEST_ROOT",
            std::env::var("ENSEMBLE_DRAFT_TEST_ROOT").ok(),
        )];

        {
            let _env = EnvGuard {
                _guard: guard,
                saved,
            };
            std::env::remove_var("ENSEMBLE_DRAFT_TEST_ROOT");
            assert!(std::env::var("ENSEMBLE_DRAFT_TEST_ROOT").is_err());
            std::env::set_var("ENSEMBLE_DRAFT_TEST_ROOT", "during");
        }

        assert_eq!(
            std::env::var("ENSEMBLE_DRAFT_TEST_ROOT").as_deref(),
            Ok("before")
        );
        std::env::remove_var("ENSEMBLE_DRAFT_TEST_ROOT");
    }

    #[test]
    fn load_config_state_resolves_env_and_relative_paths_from_config_dir() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let env_name = "ENSEMBLE_DRAFT_TEST_ROOT";

        std::env::remove_var(env_name);

        std::fs::write(
            dir.path().join(".env"),
            format!("{env_name}=workspace-data\n"),
        )
        .unwrap();
        std::fs::write(
            &path,
            format!(
                r#"
tracker:
  kind: todo_file
  path: tracker/issues.md
agents:
  builder:
    acpx_agent: claude
    prompt_template: prompts/build.md
steps:
  - name: build
    agent: builder
repos:
  - path: repos/app
    branch: main
workspace:
  root: ${env_name}
on_success: Done
on_failure: Failed
"#
            ),
        )
        .unwrap();

        let state = load_config_state(&path).unwrap();
        let config = state.active_config.as_ref().unwrap();

        assert_eq!(
            config.tracker.path.as_deref(),
            Some(dir.path().join("tracker/issues.md").as_path())
        );
        assert_eq!(
            config.repos[0].path,
            dir.path().join("repos/app").display().to_string()
        );
        assert_eq!(
            config.workspace.root.as_deref(),
            Some(dir.path().join("workspace-data").to_string_lossy().as_ref())
        );
        assert_eq!(
            config.agents["builder"].prompt_template.as_deref(),
            Some(dir.path().join("prompts/build.md").as_path())
        );

        std::env::remove_var(env_name);
    }

    #[test]
    fn parse_raw_yaml_uses_sibling_dotenv_without_mutating_process_env() {
        let _env = EnvGuard::lock(ENV_VARS);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let env_name = "ENSEMBLE_DRAFT_TEST_DOTENV_ONLY";

        std::env::remove_var(env_name);

        std::fs::write(
            dir.path().join(".env"),
            format!("{env_name}=workspace-data\n"),
        )
        .unwrap();

        let raw = format!(
            r#"
tracker:
  kind: todo_file
  path: tracker/issues.md
agents:
  builder:
    acpx_agent: claude
    prompt_template: prompts/build.md
steps:
  - name: build
    agent: builder
repos:
  - path: repos/app
    branch: main
workspace:
  root: ${env_name}
on_success: Done
on_failure: Failed
"#
        );

        let state = parse_raw_yaml(path, raw);
        let config = state.active_config.as_ref().unwrap();

        assert_eq!(
            config.workspace.root.as_deref(),
            Some(dir.path().join("workspace-data").to_string_lossy().as_ref())
        );
        assert!(std::env::var(env_name).is_err());
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
    fn parse_raw_yaml_rejects_unsupported_agent_max_turns() {
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
on_success: Done
on_failure: Failed
agent:
  max_turns: 20
"#;

        let state = parse_raw_yaml(PathBuf::from("/tmp/test.yaml"), raw.to_string());

        assert_eq!(state.kind, ConfigStateKind::Parsed);
        assert!(state.active_config.is_none());
        assert!(state.validation.issues.iter().any(|issue| {
            issue.kind == ValidationIssueKind::Config
                && issue.message.contains("agent.max_turns")
                && issue.message.contains("no longer supported")
        }));
    }

    #[test]
    fn parse_raw_yaml_returns_parsed_state_with_config_issues_for_typed_invalid_config() {
        let raw = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents: []
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
        assert!(state.active_config.is_none());
        assert!(state
            .validation
            .issues
            .iter()
            .any(|issue| issue.kind == ValidationIssueKind::Config));
        assert!(!state
            .validation
            .issues
            .iter()
            .any(|issue| issue.kind == ValidationIssueKind::Syntax));
    }

    #[test]
    fn parse_raw_yaml_clears_active_config_when_semantic_validation_fails() {
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
    agent: missing
on_success: Done
on_failure: Failed
"#;
        let path = PathBuf::from("/tmp/test.yaml");

        let state = parse_raw_yaml(path, raw.to_string());

        assert_eq!(state.kind, ConfigStateKind::Parsed);
        assert!(state.document.is_some());
        assert!(state.active_config.is_none());
        assert!(state
            .validation
            .issues
            .iter()
            .any(|issue| issue.message.contains("unknown agent reference: missing")));
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
    fn save_raw_yaml_atomically_rejects_unsupported_agent_max_turns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let invalid_config = r#"
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
  max_turns: 20
"#;

        let result = save_raw_yaml_atomically(&path, invalid_config);

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

    #[cfg(unix)]
    #[test]
    fn save_raw_yaml_atomically_creates_new_file_with_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let valid_config = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: Build it.
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

        save_raw_yaml_atomically(&path, valid_config).unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_raw_yaml_atomically_preserves_existing_restrictive_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let valid_config = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: Build it.
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

        save_raw_yaml_atomically(&path, valid_config).unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_writer_secures_temporary_before_persisting() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let temporary = create_config_temporary(&path).unwrap();

        assert_eq!(
            temporary.as_file().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_atomic_persist_leaves_no_temporary_or_partial_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::create_dir(&path).unwrap();

        let error = persist_config_atomically(&path, "replacement").unwrap_err();

        assert!(error.to_string().contains("destination is not a file"));
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
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

    #[test]
    fn global_runtime_errors_map_to_agent_permission_request_policy() {
        let error = PipelineError::InvalidRuntimeConfig {
            agent: "agent".to_string(),
            reason: "permission_request_policy is ignored for acpx runtime".to_string(),
        };
        let issue = pipeline_error_to_validation_issue(error);

        assert!(matches!(issue.kind, ValidationIssueKind::Config));
        assert_eq!(issue.section, "agent");
        assert_eq!(issue.field.as_deref(), Some("permission_request_policy"));
        assert_eq!(
            issue.path.as_deref(),
            Some("agent.permission_request_policy")
        );
    }

    #[test]
    fn reports_push_strategy_removed_migration_hint() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  build:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
push_strategy: auto_push
"#;

        let value: serde_yaml::Value = serde_yaml::from_str(yaml).expect("yaml should parse");
        let report = validate_document(&value);
        assert!(report.issues.iter().any(|issue| {
            issue.message.contains("push_strategy has been removed")
                && issue.message.contains("repos[].finalize")
        }));
    }
}
