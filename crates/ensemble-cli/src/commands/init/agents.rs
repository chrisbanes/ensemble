use ensemble_core::config::ensemble::EnsembleConfig;
use std::collections::HashMap;

const KNOWN_AGENTS: &[(&str, &str)] = &[
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

#[derive(Debug)]
pub struct AgentEntry {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,
    pub reasoning_level: Option<String>,
}

/// Capabilities discovered by probing an acpx agent session.
#[derive(Debug, Default, Clone)]
pub struct AgentCapabilities {
    pub available_models: Vec<String>,
    pub thought_levels: Vec<String>,
}

impl AgentCapabilities {
    /// Extract capabilities from a parsed session JSON file.
    pub fn from_session_json(json: &serde_json::Value) -> Self {
        let mut caps = Self::default();

        let acpx = match json.get("acpx") {
            Some(v) => v,
            None => return caps,
        };

        // Extract available_models
        if let Some(models) = acpx.get("available_models").and_then(|m| m.as_array()) {
            caps.available_models = models
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
        }

        // Extract thought_level options from config_options
        if let Some(options) = acpx.get("config_options").and_then(|o| o.as_array()) {
            for opt in options {
                let category = opt.get("category").and_then(|c| c.as_str());
                let opt_type = opt.get("type").and_then(|t| t.as_str());
                if category == Some("thought_level") && opt_type == Some("select") {
                    if let Some(values) = opt.get("options").and_then(|o| o.as_array()) {
                        caps.thought_levels = values
                            .iter()
                            .filter_map(|v| {
                                v.get("id").and_then(|id| id.as_str()).map(str::to_owned)
                            })
                            .collect();
                    }
                }
            }
        }

        caps
    }
}

pub fn discover_agents(existing: Option<&EnsembleConfig>) -> Result<Vec<AgentEntry>, String> {
    let acpx_version = check_acpx()?;
    println!("Checking acpx... ✓ {acpx_version}\n");

    let mut available = Vec::new();
    print!("Detecting agents...");
    for (name, label) in KNOWN_AGENTS {
        if probe_agent(name) {
            let version = get_agent_version(name);
            println!("\n  ✓ {name:<12} {label} {version}");
            available.push((*name).to_string());
        }
    }

    if available.is_empty() {
        println!("\n\nNo agents found. Ensemble requires at least one coding agent.");
        println!("Configure agents in acpx first, then re-run `ensemble init`.");
        println!("See: https://github.com/openclaw/acpx");
        return Err("no agents found".to_string());
    }

    println!();

    // Compute default selection indices from existing config
    let default_indices: Vec<usize> = if let Some(config) = existing {
        let existing_agents: Vec<&str> = config
            .agents
            .values()
            .filter_map(|a| a.acpx_agent.as_deref())
            .collect();
        available
            .iter()
            .enumerate()
            .filter(|(_, name)| existing_agents.contains(&name.as_str()))
            .map(|(i, _)| i)
            .collect()
    } else {
        (0..available.len()).collect()
    };

    let selected =
        inquire::MultiSelect::new("Which agents should be available?", available.clone())
            .with_default(&default_indices)
            .prompt()
            .map_err(|e| e.to_string())?;

    if selected.is_empty() {
        return Err("at least one agent is required".to_string());
    }

    // Probe capabilities for selected agents
    println!("\nProbing agent capabilities...");
    let mut capabilities: HashMap<String, AgentCapabilities> = HashMap::new();
    for agent_name in &selected {
        print!("  {agent_name}...");
        let caps = probe_agent_capabilities(agent_name);
        if !caps.available_models.is_empty() {
            println!(" {} model(s)", caps.available_models.len());
        } else {
            println!(" (no model info)");
        }
        capabilities.insert(agent_name.clone(), caps);
    }

    let agents = ask_roles(selected, &capabilities, existing)?;

    Ok(agents)
}

fn ask_roles(
    selected: Vec<String>,
    capabilities: &HashMap<String, AgentCapabilities>,
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<AgentEntry>, String> {
    println!("\nName your agents by role:\n");

    let default_roles = ["builder", "reviewer", "verifier", "planner"];

    // Build a list of (acpx_agent, role, model, reasoning_level) from existing config.
    // Using a Vec instead of HashMap so multiple roles with the same acpx_agent are preserved.
    let existing_agents: Vec<(&str, &str, Option<&str>, Option<&str>)> = existing
        .map(|config| {
            config
                .agents
                .iter()
                .filter_map(|(role, ac)| {
                    ac.acpx_agent.as_deref().map(|name| {
                        (
                            name,
                            role.as_str(),
                            ac.model.as_deref(),
                            ac.reasoning_level.as_deref(),
                        )
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Track how many times we've seen each agent name so we can match the
    // n-th occurrence to the n-th existing config entry for the same agent.
    let mut agent_seen_count: HashMap<&str, usize> = HashMap::new();
    let mut agents = Vec::new();

    for (i, agent_name) in selected.iter().enumerate() {
        let seen = agent_seen_count.entry(agent_name.as_str()).or_insert(0);
        // Find the n-th existing config entry matching this acpx_agent
        let existing_entry = existing_agents
            .iter()
            .filter(|(name, _, _, _)| *name == agent_name.as_str())
            .nth(*seen);
        *seen += 1;

        // Default role: existing config role, or positional default
        let default_role = existing_entry
            .map(|(_, role, _, _)| *role)
            .unwrap_or_else(|| default_roles.get(i).copied().unwrap_or("agent"));

        let role = inquire::Text::new(&format!("  {agent_name} → role name"))
            .with_default(default_role)
            .prompt()
            .map_err(|e| e.to_string())?;

        let caps = capabilities
            .get(agent_name.as_str())
            .cloned()
            .unwrap_or_default();

        let existing_model = existing_entry.and_then(|(_, _, model, _)| *model);

        let existing_reasoning = existing_entry.and_then(|(_, _, _, reasoning)| *reasoning);

        // Ask for model if capabilities show >1 model available
        let model = if caps.available_models.len() > 1 {
            let model_default = existing_model.unwrap_or("default");
            let default_idx = caps
                .available_models
                .iter()
                .position(|m| m == model_default)
                .unwrap_or(0);

            let chosen = inquire::Select::new(
                &format!("  {agent_name} → model"),
                caps.available_models.clone(),
            )
            .with_starting_cursor(default_idx)
            .prompt()
            .map_err(|e| e.to_string())?;

            if chosen == "default" {
                None
            } else {
                Some(chosen)
            }
        } else {
            None
        };

        // Ask for reasoning level. Use discovered thought_levels if available,
        // otherwise fall back to a free-text prompt (agents may support reasoning
        // levels even when not discoverable via ACP config_options yet).
        let reasoning_level = if caps.thought_levels.len() > 1 {
            // Agent reported thought_level options — use a Select
            let reasoning_default = existing_reasoning.unwrap_or("default");
            let default_idx = caps
                .thought_levels
                .iter()
                .position(|l| l == reasoning_default)
                .unwrap_or(0);

            let chosen = inquire::Select::new(
                &format!("  {agent_name} → reasoning level"),
                caps.thought_levels.clone(),
            )
            .with_starting_cursor(default_idx)
            .prompt()
            .map_err(|e| e.to_string())?;

            if chosen == "default" {
                None
            } else {
                Some(chosen)
            }
        } else {
            // No discoverable levels — ask as optional free-text
            let default_val = existing_reasoning.unwrap_or("");
            let input = inquire::Text::new(&format!("  {agent_name} → reasoning level (optional)"))
                .with_help_message("e.g. low, medium, high, max — press enter to skip")
                .with_default(default_val)
                .prompt()
                .map_err(|e| e.to_string())?;

            let trimmed = input.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        };

        agents.push(AgentEntry {
            role,
            acpx_agent: agent_name.clone(),
            model,
            reasoning_level,
        });
    }

    Ok(agents)
}

fn check_acpx() -> Result<String, String> {
    if let Some(version) = try_acpx_version() {
        return Ok(version);
    }

    println!("acpx is not installed.\n");
    println!("Ensemble requires acpx for agent communication.");
    println!("See: https://github.com/openclaw/acpx\n");

    let options = vec!["npm", "pnpm", "bun", "yarn", "Skip (exit)"];
    let choice = inquire::Select::new("Install acpx with:", options)
        .prompt()
        .map_err(|e| e.to_string())?;

    if choice == "Skip (exit)" {
        return Err("acpx is required to continue".to_string());
    }

    let (program, args) = install_command(choice);

    let cmd = format!("{program} {}", args.join(" "));
    println!("\nRunning: {cmd}\n");

    let status = std::process::Command::new(program)
        .args(&args)
        .status()
        .map_err(|e| format!("{program} failed: {e}"))?;

    if !status.success() {
        return Err(format!("{cmd} exited with {status}"));
    }

    // Verify it's now available
    try_acpx_version().ok_or_else(|| "acpx installed but not found on PATH".to_string())
}

fn try_acpx_version() -> Option<String> {
    let output = std::process::Command::new("acpx")
        .arg("--version")
        .output()
        .ok()?;

    if output.status.success() {
        let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    } else {
        None
    }
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
                format!("({v})")
            }
        }
        _ => String::new(),
    }
}

/// Probe an acpx agent for model and reasoning capabilities.
///
/// Creates a short-lived session, reads the session JSON to extract
/// capabilities, then closes the session. Returns empty capabilities
/// on any failure.
///
/// NOTE: This uses blocking I/O (`thread::sleep`, `fs::read_to_string`)
/// and may block the current thread for up to 10 seconds per agent while
/// waiting for the session file to be populated. This is acceptable in the
/// interactive init wizard context but should not be called from async
/// hot paths.
fn probe_agent_capabilities(agent_name: &str) -> AgentCapabilities {
    let session_name = "ensemble-probe";

    // Create session
    let output = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "ensure", "--name", session_name])
        .output();

    let session_id = match output {
        Ok(ref o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Output format: "<uuid>\t(created)" or just "<uuid>"
            stdout.trim().split('\t').next().unwrap_or("").to_string()
        }
        _ => return AgentCapabilities::default(),
    };

    if session_id.is_empty() {
        return AgentCapabilities::default();
    }

    // Read session JSON from ~/.acpx/sessions/<id>.json
    let caps = read_session_capabilities(&session_id);

    // Close session (best-effort)
    let _ = std::process::Command::new("acpx")
        .args([agent_name, "sessions", "close", session_name])
        .output();

    caps
}

/// Read capabilities from a session JSON file.
fn read_session_capabilities(session_id: &str) -> AgentCapabilities {
    let acpx_dir = dirs::home_dir()
        .map(|h| h.join(".acpx").join("sessions"))
        .unwrap_or_default();

    let session_file = acpx_dir.join(format!("{session_id}.json"));

    // Wait briefly for the session file to be populated with capabilities
    for _ in 0..20 {
        if let Ok(content) = std::fs::read_to_string(&session_file) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let caps = AgentCapabilities::from_session_json(&json);
                if !caps.available_models.is_empty() {
                    return caps;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    AgentCapabilities::default()
}

/// Build the (program, args) pair for installing acpx globally with the
/// given package manager. Yarn uses `global add` instead of `install -g`.
fn install_command(manager: &str) -> (&str, Vec<&str>) {
    if manager == "yarn" {
        ("yarn", vec!["global", "add", "acpx@latest"])
    } else {
        (manager, vec!["install", "-g", "acpx@latest"])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_command_npm() {
        let (prog, args) = install_command("npm");
        assert_eq!(prog, "npm");
        assert_eq!(args, &["install", "-g", "acpx@latest"]);
    }

    #[test]
    fn install_command_pnpm() {
        let (prog, args) = install_command("pnpm");
        assert_eq!(prog, "pnpm");
        assert_eq!(args, &["install", "-g", "acpx@latest"]);
    }

    #[test]
    fn install_command_bun() {
        let (prog, args) = install_command("bun");
        assert_eq!(prog, "bun");
        assert_eq!(args, &["install", "-g", "acpx@latest"]);
    }

    #[test]
    fn install_command_yarn() {
        let (prog, args) = install_command("yarn");
        assert_eq!(prog, "yarn");
        assert_eq!(args, &["global", "add", "acpx@latest"]);
    }

    #[test]
    fn parse_session_json_extracts_models() {
        let json = serde_json::json!({
            "acpx": {
                "current_model_id": "default",
                "available_models": ["default", "sonnet", "sonnet[1m]", "haiku"]
            }
        });
        let caps = AgentCapabilities::from_session_json(&json);
        assert_eq!(
            caps.available_models,
            vec!["default", "sonnet", "sonnet[1m]", "haiku"]
        );
    }

    #[test]
    fn parse_session_json_no_acpx_field() {
        let json = serde_json::json!({"schema": "acpx.session.v1"});
        let caps = AgentCapabilities::from_session_json(&json);
        assert!(caps.available_models.is_empty());
        assert!(caps.thought_levels.is_empty());
    }

    #[test]
    fn parse_session_json_with_config_options() {
        let json = serde_json::json!({
            "acpx": {
                "available_models": ["default"],
                "config_options": [
                    {
                        "type": "select",
                        "id": "thought_level",
                        "label": "Thinking",
                        "category": "thought_level",
                        "currentValue": "default",
                        "options": [
                            {"id": "default", "label": "Default"},
                            {"id": "high", "label": "High"},
                            {"id": "low", "label": "Low"}
                        ]
                    }
                ]
            }
        });
        let caps = AgentCapabilities::from_session_json(&json);
        assert_eq!(caps.thought_levels, vec!["default", "high", "low"]);
    }
}
