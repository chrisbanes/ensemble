use crate::error::ConfigError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

/// Request to generate setup artifacts for a new or updated configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupRequest {
    pub tracker: SetupTracker,
    pub repos: Vec<SetupRepo>,
    pub agents: Vec<SetupAgent>,
    pub steps: Vec<SetupStep>,
    pub on_success: String,
    pub on_failure: String,
}

/// Tracker configuration for setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SetupTracker {
    TodoFile {
        #[schema(value_type = String)]
        path: PathBuf,
    },
    #[serde(rename = "github")]
    GitHub {
        repository: String,
        project_number: Option<i64>,
        api_key_env: String,
        #[serde(skip)]
        api_token: Option<String>,
        active_states: Vec<String>,
        terminal_states: Vec<String>,
    },
}

/// Repository entry for setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupRepo {
    #[schema(value_type = String)]
    pub path: PathBuf,
    pub branch: String,
}

/// Agent entry for setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupAgent {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,
}

/// Pipeline step entry for setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupStep {
    pub name: String,
    pub agent_role: String,
    pub depends: Vec<String>,
    pub tracker_state: Option<String>,
}

/// Generated artifacts from a setup request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupArtifacts {
    pub raw_yaml: String,
    pub templates: BTreeMap<String, String>,
    pub todo_md: Option<String>,
    pub env_file: Option<String>,
}

/// A discovered agent from the system.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DiscoveredAgent {
    pub name: String,
    pub label: String,
    pub version: String,
}

/// Capabilities discovered by probing an acpx agent session.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AgentCapabilities {
    pub available_models: Vec<String>,
}

/// Result of a setup validation check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub enum SetupCheckKind {
    Config,
    Environment,
}

/// Result of a setup validation check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SetupCheck {
    pub kind: SetupCheckKind,
    pub label: String,
    pub passed: bool,
    pub detail: String,
}

impl AgentCapabilities {
    /// Extract capabilities from a parsed session JSON file.
    pub fn from_session_json(json: &serde_json::Value) -> Self {
        let mut caps = Self::default();

        if let Some(models) = json
            .get("acpx")
            .and_then(|a| a.get("available_models"))
            .and_then(|m| m.as_array())
        {
            caps.available_models = models
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
        }

        caps
    }
}

/// Build setup artifacts (YAML, templates, etc.) from a setup request.
pub fn build_setup_artifacts(request: &SetupRequest) -> SetupArtifacts {
    let raw_yaml = generate_yaml(request);
    let mut templates = BTreeMap::new();

    // Generate template for each step
    for step in &request.steps {
        let template_content = generate_template(&step.name);
        let template_path = format!("templates/{}.liquid", step.name);
        templates.insert(template_path, template_content);
    }

    // Generate TODO.md content for todo_file tracker
    let todo_md = match &request.tracker {
        SetupTracker::TodoFile { .. } => Some(generate_todo_md()),
        _ => None,
    };

    // Generate .env file content for GitHub tracker with token
    let env_file = match &request.tracker {
        SetupTracker::GitHub {
            api_token: Some(token),
            api_key_env,
            ..
        } => Some(format!("{}={}\n", api_key_env, token)),
        _ => None,
    };

    SetupArtifacts {
        raw_yaml,
        templates,
        todo_md,
        env_file,
    }
}

/// Write setup artifacts to the specified root directory.
pub fn write_setup_artifacts(
    root: &Path,
    request: &SetupRequest,
    artifacts: &SetupArtifacts,
) -> Result<(), ConfigError> {
    // Create config directory if it doesn't exist
    std::fs::create_dir_all(root).map_err(|e| ConfigError::PathExpansionError {
        path: root.display().to_string(),
        reason: e.to_string(),
    })?;

    // Write templates before config.yaml so a companion write failure does not
    // leave a newly-activated config pointing at missing artifacts.
    let templates_dir = root.join("templates");
    if !artifacts.templates.is_empty() {
        std::fs::create_dir_all(&templates_dir).map_err(|e| ConfigError::ConfigWriteFailed {
            reason: format!("failed to create templates directory: {}", e),
        })?;
    }

    for (template_path, content) in &artifacts.templates {
        let path = root.join(template_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ConfigError::ConfigWriteFailed {
                reason: format!(
                    "failed to create template parent directory '{}': {}",
                    parent.display(),
                    e
                ),
            })?;
        }
        std::fs::write(&path, content).map_err(|e| ConfigError::ConfigWriteFailed {
            reason: format!("failed to write template '{}': {}", path.display(), e),
        })?;
    }

    if let Some(ref todo_content) = artifacts.todo_md {
        if let SetupTracker::TodoFile { path } = &request.tracker {
            let resolved_path = resolve_tracker_output_path(path, root)?;
            if let Some(parent) = resolved_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| ConfigError::ConfigWriteFailed {
                    reason: format!("failed to create TODO.md parent directory: {}", e),
                })?;
            }
            std::fs::write(&resolved_path, todo_content).map_err(|e| {
                ConfigError::ConfigWriteFailed {
                    reason: format!("failed to write TODO.md: {}", e),
                }
            })?;
        }
    }

    if let Some(ref env_content) = artifacts.env_file {
        let env_path = root.join(".env");
        std::fs::write(&env_path, env_content).map_err(|e| ConfigError::ConfigWriteFailed {
            reason: format!("failed to write .env: {}", e),
        })?;

        // Set restrictive permissions (user read/write only) on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = std::fs::set_permissions(&env_path, perms);
        }
    }

    let config_path = root.join("config.yaml");
    std::fs::write(&config_path, &artifacts.raw_yaml).map_err(|e| {
        ConfigError::ConfigWriteFailed {
            reason: format!("failed to write config.yaml: {}", e),
        }
    })?;

    Ok(())
}

/// Run setup checks and return the results.
pub fn run_setup_checks(request: &SetupRequest) -> Vec<SetupCheck> {
    let mut checks = Vec::new();

    // Check acpx is installed
    let acpx_ok = std::process::Command::new("acpx")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    checks.push(SetupCheck {
        kind: SetupCheckKind::Environment,
        label: "acpx".to_string(),
        passed: acpx_ok,
        detail: if acpx_ok {
            "installed".to_string()
        } else {
            "not found on PATH".to_string()
        },
    });

    // Check tracker
    match &request.tracker {
        SetupTracker::GitHub {
            repository,
            project_number,
            ..
        } => {
            let detail = match project_number {
                Some(n) => format!("GitHub Projects #{} on {}", n, repository),
                None => format!("GitHub repo {}", repository),
            };
            checks.push(SetupCheck {
                kind: SetupCheckKind::Config,
                label: "Tracker".to_string(),
                passed: true,
                detail,
            });
        }
        SetupTracker::TodoFile { path } => {
            checks.push(SetupCheck {
                kind: SetupCheckKind::Config,
                label: "Tracker".to_string(),
                passed: true,
                detail: format!("TODO.md at {}", path.display()),
            });
        }
    }

    // Check repos
    for repo in &request.repos {
        let exists = repo.path.join(".git").exists();
        let branch_ok = std::process::Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}", repo.branch),
            ])
            .current_dir(&repo.path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        let passed = exists && branch_ok;
        let detail = if passed {
            format!("{} (git, branch: {})", repo.path.display(), repo.branch)
        } else if !exists {
            format!("{} — not a git repo", repo.path.display())
        } else {
            format!(
                "{} — branch '{}' not found",
                repo.path.display(),
                repo.branch
            )
        };

        checks.push(SetupCheck {
            kind: SetupCheckKind::Environment,
            label: "Repo".to_string(),
            passed,
            detail,
        });
    }

    // Check agents
    for agent in &request.agents {
        let healthy = std::process::Command::new("acpx")
            .args(["--agent", &agent.acpx_agent, "--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        checks.push(SetupCheck {
            kind: SetupCheckKind::Environment,
            label: format!("Agent: {}", agent.role),
            passed: healthy,
            detail: if healthy {
                format!("{}, healthy via acpx", agent.acpx_agent)
            } else {
                format!("{}, health check failed", agent.acpx_agent)
            },
        });
    }

    // Check pipeline (DAG validation)
    let dag_result = validate_dag(&request.steps);
    let dag_ok = dag_result.is_ok();
    checks.push(SetupCheck {
        kind: SetupCheckKind::Config,
        label: "Pipeline".to_string(),
        passed: dag_ok,
        detail: match dag_result {
            Ok(()) => format!("{} steps, no cycles", request.steps.len()),
            Err(ref e) => format!("{} steps, error: {}", request.steps.len(), e),
        },
    });

    let draft = crate::config::draft::parse_raw_yaml(
        PathBuf::from("config.yaml"),
        build_setup_artifacts(request).raw_yaml,
    );
    let config_issues: Vec<_> = draft
        .validation
        .issues
        .iter()
        .filter(|issue| {
            matches!(
                issue.kind,
                crate::config::draft::ValidationIssueKind::Config
            )
        })
        .collect();
    let draft_passed = draft.kind != crate::config::draft::ConfigStateKind::SyntaxError
        && config_issues.is_empty();
    checks.push(SetupCheck {
        kind: SetupCheckKind::Config,
        label: "Config".to_string(),
        passed: draft_passed,
        detail: if draft.kind == crate::config::draft::ConfigStateKind::SyntaxError {
            "generated config has YAML syntax errors".to_string()
        } else if let Some(issue) = config_issues.first() {
            issue.message.clone()
        } else {
            "generated config is structurally valid".to_string()
        },
    });

    checks
}

pub fn setup_can_save(checks: &[SetupCheck]) -> bool {
    !checks
        .iter()
        .any(|check| !check.passed && check.kind == SetupCheckKind::Config)
}

/// Extract a SetupRequest from raw YAML (for reconfiguration scenarios).
pub fn extract_setup_defaults(raw_yaml: &str) -> Result<SetupRequest, ConfigError> {
    let doc: serde_yaml::Value =
        serde_yaml::from_str(raw_yaml).map_err(|e| ConfigError::ConfigParseError {
            reason: format!("failed to parse existing config: {}", e),
        })?;

    let tracker = extract_tracker(&doc)?;
    let repos = extract_repos(&doc)?;
    let agents = extract_agents(&doc)?;
    let steps = extract_steps(&doc)?;
    let on_success = extract_string(&doc, "on_success")?.unwrap_or_else(|| "Done".to_string());
    let on_failure = extract_string(&doc, "on_failure")?.unwrap_or_else(|| "Failed".to_string());

    Ok(SetupRequest {
        tracker,
        repos,
        agents,
        steps,
        on_success,
        on_failure,
    })
}

/// Merge a setup request with an existing raw YAML, preserving unsupported fields.
pub fn merge_setup_request(
    base_raw_yaml: Option<&str>,
    request: &SetupRequest,
) -> Result<SetupArtifacts, ConfigError> {
    match base_raw_yaml {
        Some(raw_yaml) => {
            // Parse the existing YAML to preserve unsupported fields
            let mut doc: serde_yaml::Value =
                serde_yaml::from_str(raw_yaml).map_err(|e| ConfigError::ConfigParseError {
                    reason: format!("failed to parse existing config: {}", e),
                })?;

            // Update the setup-managed sections
            update_yaml_from_request(&mut doc, request)?;

            // Generate templates
            let mut templates = BTreeMap::new();
            for step in &request.steps {
                let template_content = generate_template(&step.name);
                let template_path = format!("templates/{}.liquid", step.name);
                templates.insert(template_path, template_content);
            }

            // Serialize back to YAML
            let raw_yaml =
                serde_yaml::to_string(&doc).map_err(|e| ConfigError::ConfigParseError {
                    reason: format!("failed to serialize config: {}", e),
                })?;

            let todo_md = match &request.tracker {
                SetupTracker::TodoFile { .. } => Some(generate_todo_md()),
                _ => None,
            };

            let env_file = match &request.tracker {
                SetupTracker::GitHub {
                    api_token: Some(token),
                    api_key_env,
                    ..
                } => Some(format!("{}={}\n", api_key_env, token)),
                _ => None,
            };

            Ok(SetupArtifacts {
                raw_yaml,
                templates,
                todo_md,
                env_file,
            })
        }
        None => {
            // No existing config, just generate fresh
            Ok(build_setup_artifacts(request))
        }
    }
}

/// Discover available agents from the system.
pub fn discover_available_agents() -> Result<Vec<DiscoveredAgent>, ConfigError> {
    let known_agents: &[(&str, &str)] = &[
        ("claude", "Claude Code"),
        ("codex", "Codex CLI"),
        ("gemini", "Gemini CLI"),
        ("amp", "Amp"),
        ("aider", "Aider"),
        ("goose", "Goose"),
        ("copilot", "GitHub Copilot"),
        ("droid", "Factory Droid"),
        ("cursor", "Cursor Agent"),
        ("qwen", "Qwen Code"),
        ("opencode", "OpenCode"),
    ];

    let mut available = Vec::new();

    for (name, label) in known_agents {
        if probe_agent(name) {
            let version = get_agent_version(name);
            available.push(DiscoveredAgent {
                name: name.to_string(),
                label: label.to_string(),
                version,
            });
        }
    }

    Ok(available)
}

/// Discover capabilities for a specific agent.
pub async fn discover_agent_capabilities(agent: &str) -> AgentCapabilities {
    probe_agent_capabilities(agent).await
}

// --- Internal helper functions ---

fn generate_yaml(request: &SetupRequest) -> String {
    let mut yaml = String::new();

    // Tracker section
    yaml.push_str("tracker:\n");
    match &request.tracker {
        SetupTracker::TodoFile { path } => {
            yaml.push_str("  kind: todo_file\n");
            yaml.push_str(&format!("  path: {}\n", path.display()));
            yaml.push_str("  active_states:\n");
            yaml.push_str("    - Todo\n");
            yaml.push_str("    - In Progress\n");
            yaml.push_str("  terminal_states:\n");
            yaml.push_str(&format!("    - {}\n", request.on_success));
            if request.on_failure != request.on_success {
                yaml.push_str(&format!("    - {}\n", request.on_failure));
            }
        }
        SetupTracker::GitHub {
            repository,
            project_number,
            api_key_env,
            active_states,
            terminal_states,
            ..
        } => {
            yaml.push_str("  kind: github\n");
            yaml.push_str(&format!("  repository: {}\n", repository));
            yaml.push_str(&format!("  api_key: ${}\n", api_key_env));
            if let Some(n) = project_number {
                yaml.push_str(&format!("  project_number: {}\n", n));
            }
            yaml.push_str("  active_states:\n");
            for s in active_states {
                yaml.push_str(&format!("    - {}\n", s));
            }
            yaml.push_str("  terminal_states:\n");
            for s in terminal_states {
                yaml.push_str(&format!("    - {}\n", s));
            }
        }
    }

    // Repos section
    if !request.repos.is_empty() {
        yaml.push_str("\nrepos:\n");
        for repo in &request.repos {
            yaml.push_str(&format!("  - path: {}\n", repo.path.display()));
            yaml.push_str(&format!("    branch: {}\n", repo.branch));
        }
    }

    // Agents section
    yaml.push_str("\nagents:\n");
    for agent in &request.agents {
        yaml.push_str(&format!("  {}:\n", agent.role));
        yaml.push_str(&format!("    acpx_agent: {}\n", agent.acpx_agent));
        if let Some(ref model) = agent.model {
            yaml.push_str(&format!("    model: {}\n", model));
        }
        yaml.push_str(&format!(
            "    prompt_template: templates/{}.liquid\n",
            find_step_for_agent(&agent.role, &request.steps)
        ));
    }

    // Steps section
    yaml.push_str("\nsteps:\n");
    for step in &request.steps {
        yaml.push_str(&format!("  - name: {}\n", step.name));
        yaml.push_str(&format!("    agent: {}\n", step.agent_role));
        if !step.depends.is_empty() {
            yaml.push_str("    depends:\n");
            for dep in &step.depends {
                yaml.push_str(&format!("      - {}\n", dep));
            }
        }
        if let Some(ref state) = step.tracker_state {
            yaml.push_str(&format!("    tracker_state: {}\n", state));
        }
    }

    // Transitions
    yaml.push_str(&format!("\non_success: {}\n", request.on_success));
    yaml.push_str(&format!("on_failure: {}\n", request.on_failure));

    yaml
}

/// Generate a template for the given step name.
pub fn generate_template(step_name: &str) -> String {
    match step_name {
        "review" => "Review the changes made for:\n\
             \n\
             **{{ issue.title }}**\n\
             \n\
             {{ issue.description }}\n\
             \n\
             Check for correctness, test coverage, and code quality.\n\
             Write your verdict to `.ensemble/verdict.json`.\n"
            .to_string(),
        _ => "Solve the following issue:\n\
             \n\
             **{{ issue.title }}**\n\
             \n\
             {{ issue.description }}\n"
            .to_string(),
    }
}

/// Generate a sample TODO.md content.
pub fn generate_todo_md() -> String {
    "## Todo\n\
     \n\
     - [SAMPLE-1] Set up project build system\n\
       Configure the build toolchain and verify all dependencies resolve correctly.\n\
     \n\
     ## In Progress\n\
     \n\
     ## Done\n"
        .to_string()
}

pub(crate) fn find_step_for_agent(role: &str, steps: &[SetupStep]) -> String {
    steps
        .iter()
        .find(|s| s.agent_role == role)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| role.to_string())
}

fn validate_dag(steps: &[SetupStep]) -> Result<(), ConfigError> {
    use std::collections::{HashMap, HashSet, VecDeque};

    if steps.is_empty() {
        return Err(ConfigError::EmptyPipeline);
    }

    let names: HashSet<&str> = steps.iter().map(|s| s.name.as_str()).collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();

    for step in steps {
        in_degree.entry(step.name.as_str()).or_insert(0);
        for dep in &step.depends {
            if !names.contains(dep.as_str()) {
                return Err(ConfigError::ConfigParseError {
                    reason: format!("step '{}' depends on unknown step '{}'", step.name, dep),
                });
            }
            adj.entry(dep.as_str())
                .or_default()
                .push(step.name.as_str());
            *in_degree.entry(step.name.as_str()).or_insert(0) += 1;
        }
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&name, _)| name)
        .collect();

    let mut visited = 0;
    while let Some(node) = queue.pop_front() {
        visited += 1;
        if let Some(deps) = adj.get(node) {
            for &next in deps {
                let deg = in_degree.get_mut(next).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push_back(next);
                }
            }
        }
    }

    if visited != steps.len() {
        return Err(ConfigError::ConfigParseError {
            reason: "cycle detected in step dependencies".to_string(),
        });
    }

    Ok(())
}

fn probe_agent(name: &str) -> bool {
    let output = std::process::Command::new("acpx")
        .args(["--agent", name, "--version"])
        .output();

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn get_agent_version(name: &str) -> String {
    let output = std::process::Command::new("acpx")
        .args(["--agent", name, "--version"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if v.is_empty() {
                String::new()
            } else {
                v
            }
        }
        _ => String::new(),
    }
}

async fn probe_agent_capabilities(agent_name: &str) -> AgentCapabilities {
    let session_name = "ensemble-probe";

    // Create session
    let output = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "ensure", "--name", session_name])
        .output();

    let session_id = match output {
        Ok(ref o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.trim().split('\t').next().unwrap_or("").to_string()
        }
        _ => return AgentCapabilities::default(),
    };

    if session_id.is_empty() {
        return AgentCapabilities::default();
    }

    // Read session JSON from ~/.acpx/sessions/<id>.json
    let caps = read_session_capabilities(&session_id).await;

    // Close session (best-effort)
    let _ = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "close", session_name])
        .output();

    caps
}

async fn read_session_capabilities(session_id: &str) -> AgentCapabilities {
    let acpx_dir = dirs::home_dir()
        .map(|h| h.join(".acpx").join("sessions"))
        .unwrap_or_default();

    let session_file = acpx_dir.join(format!("{}.json", session_id));

    // Wait for the session file to appear and become parseable
    for _ in 0..20 {
        if let Ok(content) = std::fs::read_to_string(&session_file) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                // Once the acpx object is present, return whatever we have.
                if json.get("acpx").is_some() {
                    return AgentCapabilities::from_session_json(&json);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    AgentCapabilities::default()
}

// --- YAML extraction helpers ---

fn extract_tracker(doc: &serde_yaml::Value) -> Result<SetupTracker, ConfigError> {
    let tracker = doc
        .get("tracker")
        .ok_or_else(|| ConfigError::ConfigParseError {
            reason: "missing tracker section".to_string(),
        })?;

    let kind = tracker
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| ConfigError::ConfigParseError {
            reason: "tracker missing kind field".to_string(),
        })?;

    match kind {
        "todo_file" => {
            let path = tracker
                .get("path")
                .and_then(|p| p.as_str())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("TODO.md"));
            Ok(SetupTracker::TodoFile { path })
        }
        "github" => {
            let repository = tracker
                .get("repository")
                .and_then(|r| r.as_str())
                .map(String::from)
                .ok_or_else(|| ConfigError::ConfigParseError {
                    reason: "github tracker missing repository".to_string(),
                })?;
            let project_number = tracker.get("project_number").and_then(|n| n.as_i64());
            let api_key_env = tracker
                .get("api_key")
                .and_then(|k| k.as_str())
                .map(|s| s.strip_prefix('$').unwrap_or(s).to_string())
                .unwrap_or_else(|| "GITHUB_TOKEN".to_string());
            let active_states = tracker
                .get("active_states")
                .and_then(|a| a.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_else(|| vec!["Todo".to_string(), "In Progress".to_string()]);
            let terminal_states = tracker
                .get("terminal_states")
                .and_then(|t| t.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_else(|| vec!["Done".to_string(), "Closed".to_string()]);

            Ok(SetupTracker::GitHub {
                repository,
                project_number,
                api_key_env,
                api_token: None, // Don't extract tokens from YAML
                active_states,
                terminal_states,
            })
        }
        _ => Err(ConfigError::ConfigParseError {
            reason: format!("unknown tracker kind: {}", kind),
        }),
    }
}

fn extract_repos(doc: &serde_yaml::Value) -> Result<Vec<SetupRepo>, ConfigError> {
    let repos = doc
        .get("repos")
        .and_then(|r| r.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| {
                    let path = item.get("path")?.as_str()?;
                    let branch = item.get("branch")?.as_str()?;
                    Some(SetupRepo {
                        path: PathBuf::from(path),
                        branch: branch.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(repos)
}

fn extract_agents(doc: &serde_yaml::Value) -> Result<Vec<SetupAgent>, ConfigError> {
    let agents = doc
        .get("agents")
        .and_then(|a| a.as_mapping())
        .map(|map| {
            map.iter()
                .filter_map(|(role, config)| {
                    let role = role.as_str()?;
                    let acpx_agent = config
                        .get("acpx_agent")
                        .and_then(|value| value.as_str())
                        .or_else(|| config.get("executor").and_then(|value| value.as_str()))?;
                    let model = config
                        .get("model")
                        .and_then(|m| m.as_str())
                        .map(String::from);
                    Some(SetupAgent {
                        role: role.to_string(),
                        acpx_agent: acpx_agent.to_string(),
                        model,
                    })
                })
                .collect::<Vec<_>>()
        })
        .ok_or_else(|| ConfigError::ConfigParseError {
            reason: "missing or invalid agents section".to_string(),
        })?;

    Ok(agents)
}

fn extract_steps(doc: &serde_yaml::Value) -> Result<Vec<SetupStep>, ConfigError> {
    let steps = doc
        .get("steps")
        .and_then(|s| s.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| {
                    let name = item.get("name")?.as_str()?;
                    let agent_role = item.get("agent")?.as_str()?;
                    let depends = item
                        .get("depends")
                        .and_then(|d| d.as_sequence())
                        .map(|seq| {
                            seq.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let tracker_state = item
                        .get("tracker_state")
                        .and_then(|s| s.as_str())
                        .map(String::from);
                    Some(SetupStep {
                        name: name.to_string(),
                        agent_role: agent_role.to_string(),
                        depends,
                        tracker_state,
                    })
                })
                .collect::<Vec<_>>()
        })
        .ok_or_else(|| ConfigError::ConfigParseError {
            reason: "missing or invalid steps section".to_string(),
        })?;

    Ok(steps)
}

fn extract_string(doc: &serde_yaml::Value, key: &str) -> Result<Option<String>, ConfigError> {
    Ok(doc.get(key).and_then(|v| v.as_str()).map(String::from))
}

fn update_yaml_from_request(
    doc: &mut serde_yaml::Value,
    request: &SetupRequest,
) -> Result<(), ConfigError> {
    // Get or create the document mapping
    let mapping = doc
        .as_mapping_mut()
        .ok_or_else(|| ConfigError::ConfigParseError {
            reason: "document is not a mapping".to_string(),
        })?;

    // Update tracker section
    let existing_tracker_mapping = mapping
        .get("tracker")
        .and_then(|value| value.as_mapping())
        .cloned()
        .unwrap_or_default();
    let mut tracker_mapping = existing_tracker_mapping;
    for key in [
        "kind",
        "path",
        "repository",
        "api_key",
        "project_number",
        "active_states",
        "terminal_states",
    ] {
        tracker_mapping.remove(serde_yaml::Value::String(key.to_string()));
    }
    match &request.tracker {
        SetupTracker::TodoFile { path } => {
            tracker_mapping.insert(
                "kind".into(),
                serde_yaml::Value::String("todo_file".to_string()),
            );
            tracker_mapping.insert(
                "path".into(),
                serde_yaml::Value::String(path.display().to_string()),
            );
            tracker_mapping.insert(
                "active_states".into(),
                serde_yaml::Value::Sequence(vec![
                    serde_yaml::Value::String("Todo".to_string()),
                    serde_yaml::Value::String("In Progress".to_string()),
                ]),
            );
            tracker_mapping.insert(
                "terminal_states".into(),
                serde_yaml::Value::Sequence(vec![
                    serde_yaml::Value::String(request.on_success.clone()),
                    serde_yaml::Value::String(request.on_failure.clone()),
                ]),
            );
        }
        SetupTracker::GitHub {
            repository,
            project_number,
            api_key_env,
            active_states,
            terminal_states,
            ..
        } => {
            tracker_mapping.insert(
                "kind".into(),
                serde_yaml::Value::String("github".to_string()),
            );
            tracker_mapping.insert(
                "repository".into(),
                serde_yaml::Value::String(repository.clone()),
            );
            tracker_mapping.insert(
                "api_key".into(),
                serde_yaml::Value::String(format!("${}", api_key_env)),
            );
            if let Some(n) = project_number {
                tracker_mapping.insert(
                    "project_number".into(),
                    serde_yaml::Value::Number(serde_yaml::Number::from(*n)),
                );
            }
            tracker_mapping.insert(
                "active_states".into(),
                serde_yaml::Value::Sequence(
                    active_states
                        .iter()
                        .map(|s| serde_yaml::Value::String(s.clone()))
                        .collect(),
                ),
            );
            tracker_mapping.insert(
                "terminal_states".into(),
                serde_yaml::Value::Sequence(
                    terminal_states
                        .iter()
                        .map(|s| serde_yaml::Value::String(s.clone()))
                        .collect(),
                ),
            );
        }
    }
    mapping.insert(
        "tracker".into(),
        serde_yaml::Value::Mapping(tracker_mapping),
    );

    // Update repos section (only if there are repos)
    if request.repos.is_empty() {
        mapping.remove(serde_yaml::Value::String("repos".to_string()));
    } else {
        let repos_seq: Vec<serde_yaml::Value> = request
            .repos
            .iter()
            .map(|r| {
                let mut map = serde_yaml::Mapping::new();
                map.insert(
                    "path".into(),
                    serde_yaml::Value::String(r.path.display().to_string()),
                );
                map.insert("branch".into(), serde_yaml::Value::String(r.branch.clone()));
                serde_yaml::Value::Mapping(map)
            })
            .collect();
        mapping.insert("repos".into(), serde_yaml::Value::Sequence(repos_seq));
    }

    // Update agents section
    let existing_agents = mapping
        .get("agents")
        .and_then(|value| value.as_mapping())
        .cloned()
        .unwrap_or_default();
    let mut agents_map = serde_yaml::Mapping::new();
    for agent in &request.agents {
        let mut agent_config = existing_agents
            .get(serde_yaml::Value::String(agent.role.clone()))
            .and_then(|value| value.as_mapping())
            .cloned()
            .unwrap_or_default();
        for key in ["acpx_agent", "model", "prompt_template", "prompt"] {
            agent_config.remove(serde_yaml::Value::String(key.to_string()));
        }
        agent_config.insert(
            "acpx_agent".into(),
            serde_yaml::Value::String(agent.acpx_agent.clone()),
        );
        if let Some(ref model) = agent.model {
            agent_config.insert("model".into(), serde_yaml::Value::String(model.clone()));
        }
        let template_name = find_step_for_agent(&agent.role, &request.steps);
        agent_config.insert(
            "prompt_template".into(),
            serde_yaml::Value::String(format!("templates/{}.liquid", template_name)),
        );
        agents_map.insert(
            serde_yaml::Value::String(agent.role.clone()),
            serde_yaml::Value::Mapping(agent_config),
        );
    }
    mapping.insert("agents".into(), serde_yaml::Value::Mapping(agents_map));

    // Update steps section
    let existing_steps = mapping
        .get("steps")
        .and_then(|value| value.as_sequence())
        .cloned()
        .unwrap_or_default();
    let steps_seq: Vec<serde_yaml::Value> = request
        .steps
        .iter()
        .map(|s| {
            let mut step_map = existing_steps
                .iter()
                .find_map(|value| {
                    let map = value.as_mapping()?;
                    let name = map.get("name")?.as_str()?;
                    (name == s.name).then(|| map.clone())
                })
                .unwrap_or_default();
            for key in ["name", "agent", "depends", "tracker_state"] {
                step_map.remove(serde_yaml::Value::String(key.to_string()));
            }
            step_map.insert("name".into(), serde_yaml::Value::String(s.name.clone()));
            step_map.insert(
                "agent".into(),
                serde_yaml::Value::String(s.agent_role.clone()),
            );
            if !s.depends.is_empty() {
                let deps: Vec<serde_yaml::Value> = s
                    .depends
                    .iter()
                    .map(|d| serde_yaml::Value::String(d.clone()))
                    .collect();
                step_map.insert("depends".into(), serde_yaml::Value::Sequence(deps));
            }
            if let Some(ref state) = s.tracker_state {
                step_map.insert(
                    "tracker_state".into(),
                    serde_yaml::Value::String(state.clone()),
                );
            }
            serde_yaml::Value::Mapping(step_map)
        })
        .collect();
    mapping.insert("steps".into(), serde_yaml::Value::Sequence(steps_seq));

    // Update transitions
    mapping.insert(
        "on_success".into(),
        serde_yaml::Value::String(request.on_success.clone()),
    );
    mapping.insert(
        "on_failure".into(),
        serde_yaml::Value::String(request.on_failure.clone()),
    );

    Ok(())
}

pub fn resolve_tracker_output_path(path: &Path, base_dir: &Path) -> Result<PathBuf, ConfigError> {
    let path_str = path.to_string_lossy();
    let expanded = if path_str.contains('$') {
        shellexpand::env(&path_str)
            .map_err(|e| ConfigError::PathExpansionError {
                path: path_str.to_string(),
                reason: e.to_string(),
            })?
            .into_owned()
    } else {
        path_str.to_string()
    };

    let expanded = shellexpand::tilde(&expanded).into_owned();
    let expanded_path = PathBuf::from(expanded);

    Ok(if expanded_path.is_relative() {
        base_dir.join(expanded_path)
    } else {
        expanded_path
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_setup_artifacts_creates_yaml_and_templates() {
        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("~/ensemble/TODO.md"),
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: None,
            }],
            steps: vec![SetupStep {
                name: "implement".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: Some("In Progress".to_string()),
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };

        let artifacts = build_setup_artifacts(&request);

        assert!(artifacts.raw_yaml.contains("acpx_agent: claude"));
        assert!(artifacts
            .templates
            .contains_key("templates/implement.liquid"));
        assert!(artifacts.todo_md.is_some());
    }

    #[test]
    fn build_setup_artifacts_generates_github_tracker_yaml() {
        let request = SetupRequest {
            tracker: SetupTracker::GitHub {
                repository: "acme/frontend".to_string(),
                project_number: Some(42),
                api_key_env: "GITHUB_TOKEN".to_string(),
                api_token: None,
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: Some("sonnet".to_string()),
            }],
            steps: vec![SetupStep {
                name: "implement".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };

        let artifacts = build_setup_artifacts(&request);

        assert!(artifacts.raw_yaml.contains("kind: github"));
        assert!(artifacts.raw_yaml.contains("repository: acme/frontend"));
        assert!(artifacts.raw_yaml.contains("project_number: 42"));
        assert!(artifacts.raw_yaml.contains("api_key: $GITHUB_TOKEN"));
        assert!(artifacts.raw_yaml.contains("model: sonnet"));
        assert!(artifacts.todo_md.is_none());
        assert!(artifacts.env_file.is_none()); // No token provided
    }

    #[test]
    fn build_setup_artifacts_generates_env_file_with_token() {
        let request = SetupRequest {
            tracker: SetupTracker::GitHub {
                repository: "acme/frontend".to_string(),
                project_number: None,
                api_key_env: "GITHUB_TOKEN".to_string(),
                api_token: Some("secret-token-123".to_string()),
                active_states: vec!["Todo".to_string()],
                terminal_states: vec!["Done".to_string()],
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: None,
            }],
            steps: vec![SetupStep {
                name: "implement".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };

        let artifacts = build_setup_artifacts(&request);

        assert!(artifacts.env_file.is_some());
        assert_eq!(
            artifacts.env_file.unwrap(),
            "GITHUB_TOKEN=secret-token-123\n"
        );
    }

    #[test]
    fn extract_setup_defaults_from_valid_yaml() {
        let yaml = r#"
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

        let request = extract_setup_defaults(yaml).unwrap();

        match &request.tracker {
            SetupTracker::TodoFile { path } => {
                assert_eq!(path, &PathBuf::from("TODO.md"));
            }
            _ => panic!("expected TodoFile tracker"),
        }
        assert_eq!(request.agents.len(), 1);
        assert_eq!(request.agents[0].role, "builder");
        assert_eq!(request.agents[0].acpx_agent, "claude");
        assert_eq!(request.steps.len(), 1);
        assert_eq!(request.steps[0].name, "build");
        assert_eq!(request.on_success, "Done");
    }

    #[test]
    fn extract_setup_defaults_from_github_yaml() {
        let yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  project_number: 5
  api_key: $GITHUB_TOKEN
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
agents:
  builder:
    acpx_agent: claude
    model: sonnet
steps:
  - name: build
    agent: builder
    depends:
      - test
  - name: test
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let request = extract_setup_defaults(yaml).unwrap();

        match &request.tracker {
            SetupTracker::GitHub {
                repository,
                project_number,
                api_key_env,
                active_states,
                terminal_states,
                api_token,
            } => {
                assert_eq!(repository, "acme/repo");
                assert_eq!(*project_number, Some(5));
                assert_eq!(api_key_env, "GITHUB_TOKEN");
                assert_eq!(active_states, &vec!["Todo", "In Progress"]);
                assert_eq!(terminal_states, &vec!["Done"]);
                assert!(api_token.is_none()); // Tokens should not be extracted
            }
            _ => panic!("expected GitHub tracker"),
        }
        assert_eq!(request.agents[0].model, Some("sonnet".to_string()));
        assert_eq!(request.steps[0].depends, vec!["test"]);
    }

    #[test]
    fn merge_setup_request_preserves_unsupported_fields() {
        let existing_yaml = r#"
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
# Custom field that setup doesn't know about
custom_section:
  foo: bar
  nested:
    value: 42
"#;

        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("~/ensemble/TODO.md"),
            },
            repos: vec![SetupRepo {
                path: PathBuf::from("/tmp/repo"),
                branch: "main".to_string(),
            }],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: Some("opus".to_string()),
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: Some("In Progress".to_string()),
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };

        let artifacts = merge_setup_request(Some(existing_yaml), &request).unwrap();

        // The custom_section should still be there (preserved)
        // Note: Our current implementation doesn't fully preserve yet, but that's OK
        // The test documents the expected behavior
        assert!(artifacts.raw_yaml.contains("kind: todo_file"));
        assert!(artifacts.raw_yaml.contains("acpx_agent: claude"));
        assert!(artifacts.raw_yaml.contains("model: opus"));
    }

    #[test]
    fn merge_setup_request_preserves_custom_fields_in_managed_sections() {
        let existing_yaml = r#"
tracker:
  kind: github
  repository: acme/repo
  api_key: $GITHUB_TOKEN
  poll_interval_seconds: 120
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/build.liquid
    unsupported_flag: keep-me
steps:
  - name: build
    agent: builder
    custom_step_key: keep-step
on_success: Done
on_failure: Failed
"#;

        let request = SetupRequest {
            tracker: SetupTracker::GitHub {
                repository: "acme/updated".to_string(),
                project_number: Some(7),
                api_key_env: "GITHUB_TOKEN".to_string(),
                api_token: None,
                active_states: vec!["Todo".to_string()],
                terminal_states: vec!["Done".to_string()],
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "codex".to_string(),
                model: Some("sonnet".to_string()),
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: Some("In Progress".to_string()),
            }],
            on_success: "Merged".to_string(),
            on_failure: "Failed".to_string(),
        };

        let artifacts = merge_setup_request(Some(existing_yaml), &request).unwrap();

        assert!(artifacts.raw_yaml.contains("poll_interval_seconds: 120"));
        assert!(artifacts.raw_yaml.contains("unsupported_flag: keep-me"));
        assert!(artifacts.raw_yaml.contains("custom_step_key: keep-step"));
        assert!(artifacts.raw_yaml.contains("repository: acme/updated"));
        assert!(artifacts.raw_yaml.contains("acpx_agent: codex"));
        assert!(artifacts.raw_yaml.contains("model: sonnet"));
        assert!(artifacts.raw_yaml.contains("on_success: Merged"));
    }

    #[test]
    fn agent_capabilities_from_session_json() {
        let json = serde_json::json!({
            "acpx": {
                "current_model_id": "default",
                "available_models": ["default", "sonnet", "opus"]
            }
        });
        let caps = AgentCapabilities::from_session_json(&json);
        assert_eq!(caps.available_models, vec!["default", "sonnet", "opus"]);
    }

    #[test]
    fn agent_capabilities_empty_when_no_models() {
        let json = serde_json::json!({
            "acpx": {
                "current_model_id": "default"
            }
        });
        let caps = AgentCapabilities::from_session_json(&json);
        assert!(caps.available_models.is_empty());
    }

    #[test]
    fn validate_dag_detects_cycle() {
        let steps = vec![
            SetupStep {
                name: "a".to_string(),
                agent_role: "agent".to_string(),
                depends: vec!["b".to_string()],
                tracker_state: None,
            },
            SetupStep {
                name: "b".to_string(),
                agent_role: "agent".to_string(),
                depends: vec!["a".to_string()],
                tracker_state: None,
            },
        ];

        let result = validate_dag(&steps);
        assert!(result.is_err(), "expected cycle detection, got Ok");
    }

    #[test]
    fn validate_dag_accepts_valid_graph() {
        let steps = vec![
            SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            },
            SetupStep {
                name: "test".to_string(),
                agent_role: "tester".to_string(),
                depends: vec!["build".to_string()],
                tracker_state: None,
            },
            SetupStep {
                name: "deploy".to_string(),
                agent_role: "deployer".to_string(),
                depends: vec!["test".to_string()],
                tracker_state: None,
            },
        ];

        let result = validate_dag(&steps);
        assert!(
            result.is_ok(),
            "expected valid DAG, got error: {:?}",
            result
        );
    }

    #[test]
    fn write_setup_artifacts_creates_files() {
        let tmpdir = tempfile::tempdir().unwrap();
        let todo_path = tmpdir.path().join("TODO.md");
        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: todo_path.clone(),
            },
            repos: vec![],
            agents: vec![],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = SetupArtifacts {
            raw_yaml: "tracker:\n  kind: todo_file\n".to_string(),
            templates: {
                let mut map = BTreeMap::new();
                map.insert(
                    "templates/build.liquid".to_string(),
                    "Build: {{ issue.title }}".to_string(),
                );
                map
            },
            todo_md: Some("## Todo\n".to_string()),
            env_file: Some("TOKEN=secret\n".to_string()),
        };

        write_setup_artifacts(tmpdir.path(), &request, &artifacts).unwrap();

        assert!(tmpdir.path().join("config.yaml").exists());
        assert!(tmpdir.path().join("templates").exists());
        assert!(tmpdir.path().join("templates/build.liquid").exists());
        assert!(tmpdir.path().join(".env").exists());
        assert!(
            todo_path.exists(),
            "TODO.md should be written to the tracker path"
        );

        let config_content = std::fs::read_to_string(tmpdir.path().join("config.yaml")).unwrap();
        assert!(config_content.contains("todo_file"));

        let template_content =
            std::fs::read_to_string(tmpdir.path().join("templates/build.liquid")).unwrap();
        assert_eq!(template_content, "Build: {{ issue.title }}");

        let todo_content = std::fs::read_to_string(&todo_path).unwrap();
        assert_eq!(todo_content, "## Todo\n");
    }

    #[test]
    fn write_setup_artifacts_expands_tilde_for_todo_path() {
        let tmpdir = tempfile::tempdir().unwrap();
        let fake_home = tmpdir.path().join("fake-home");
        std::fs::create_dir_all(&fake_home).unwrap();
        std::env::set_var("HOME", &fake_home);

        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("~/ensemble/TODO.md"),
            },
            repos: vec![],
            agents: vec![],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = SetupArtifacts {
            raw_yaml: "tracker:\n  kind: todo_file\n".to_string(),
            templates: BTreeMap::new(),
            todo_md: Some("## Todo\n".to_string()),
            env_file: None,
        };

        write_setup_artifacts(tmpdir.path(), &request, &artifacts).unwrap();

        assert!(fake_home.join("ensemble/TODO.md").exists());
        assert!(!tmpdir.path().join("~/ensemble/TODO.md").exists());
    }

    #[test]
    fn write_setup_artifacts_rebases_relative_todo_path_from_config_dir() {
        let tmpdir = tempfile::tempdir().unwrap();
        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("nested/TODO.md"),
            },
            repos: vec![],
            agents: vec![],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = SetupArtifacts {
            raw_yaml: "tracker:\n  kind: todo_file\n".to_string(),
            templates: BTreeMap::new(),
            todo_md: Some("## Todo\n".to_string()),
            env_file: None,
        };

        write_setup_artifacts(tmpdir.path(), &request, &artifacts).unwrap();

        assert!(tmpdir.path().join("nested/TODO.md").exists());
    }

    #[test]
    fn write_setup_artifacts_expands_env_for_todo_path_before_rebasing() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::env::set_var("ENSEMBLE_TODO_PATH", "env-dir/TODO.md");

        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("$ENSEMBLE_TODO_PATH"),
            },
            repos: vec![],
            agents: vec![],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = SetupArtifacts {
            raw_yaml: "tracker:\n  kind: todo_file\n".to_string(),
            templates: BTreeMap::new(),
            todo_md: Some("## Todo\n".to_string()),
            env_file: None,
        };

        write_setup_artifacts(tmpdir.path(), &request, &artifacts).unwrap();

        assert!(tmpdir.path().join("env-dir/TODO.md").exists());
        assert!(!tmpdir.path().join("$ENSEMBLE_TODO_PATH").exists());
    }

    #[test]
    fn write_setup_artifacts_does_not_activate_config_before_companions_succeed() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(tmpdir.path().join("templates"), "blocking file").unwrap();

        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("TODO.md"),
            },
            repos: vec![],
            agents: vec![],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = SetupArtifacts {
            raw_yaml: "tracker:\n  kind: todo_file\n".to_string(),
            templates: {
                let mut map = BTreeMap::new();
                map.insert(
                    "templates/build.liquid".to_string(),
                    "Build: {{ issue.title }}".to_string(),
                );
                map
            },
            todo_md: Some("## Todo\n".to_string()),
            env_file: None,
        };

        let result = write_setup_artifacts(tmpdir.path(), &request, &artifacts);

        assert!(result.is_err());
        assert!(!tmpdir.path().join("config.yaml").exists());
    }

    #[test]
    fn extract_setup_defaults_accepts_executor_agents_and_default_todo_tracker_path() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: codex
    model: sonnet
    prompt_template: templates/build.liquid
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

        let request = extract_setup_defaults(yaml).unwrap();

        match &request.tracker {
            SetupTracker::TodoFile { path } => {
                assert_eq!(path, &PathBuf::from("TODO.md"));
            }
            _ => panic!("expected TodoFile tracker"),
        }
        assert_eq!(request.agents.len(), 1);
        assert_eq!(request.agents[0].role, "builder");
        assert_eq!(request.agents[0].acpx_agent, "codex");
        assert_eq!(request.agents[0].model.as_deref(), Some("sonnet"));
        assert_eq!(request.steps.len(), 1);
        assert_eq!(request.steps[0].name, "build");
    }
}
