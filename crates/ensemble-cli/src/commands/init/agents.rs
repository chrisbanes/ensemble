use ensemble_core::config::ensemble::EnsembleConfig;
use ensemble_core::config::setup::{
    discover_agent_capabilities, discover_available_agents, AgentCapabilities,
};
use std::collections::HashMap;

#[derive(Debug)]
pub struct AgentEntry {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,
}

/// Status of acpx installation check
#[derive(Debug, Clone)]
pub enum AcpxStatus {
    Installed(String),
    NotInstalled,
}

/// Check if acpx is installed without any interactive prompts
pub fn check_acpx() -> AcpxStatus {
    match try_acpx_version() {
        Some(version) => AcpxStatus::Installed(version),
        None => AcpxStatus::NotInstalled,
    }
}

/// Try to get acpx version
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

/// Build the (program, args) pair for installing acpx globally with the
/// given package manager. Yarn uses `global add` instead of `install -g`.
fn install_command(manager: &str) -> (&str, Vec<&str>) {
    if manager == "yarn" {
        ("yarn", vec!["global", "add", "acpx@latest"])
    } else {
        (manager, vec!["install", "-g", "acpx@latest"])
    }
}

pub async fn discover_agents(existing: Option<&EnsembleConfig>) -> Result<Vec<AgentEntry>, String> {
    // Check acpx is installed and get version
    let acpx_check = check_acpx();
    match acpx_check {
        AcpxStatus::Installed(version) => {
            println!("Checking acpx... ✓ {version}\n");
        }
        AcpxStatus::NotInstalled => {
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
            match try_acpx_version() {
                Some(version) => {
                    println!("Checking acpx... ✓ {version}\n");
                }
                None => return Err("acpx installed but not found on PATH".to_string()),
            }
        }
    }

    // Use shared discovery function
    let discovered = discover_available_agents()
        .await
        .map_err(|e| e.to_string())?;

    let available: Vec<String> = discovered.iter().map(|d| d.name.clone()).collect();

    // Print detected agents
    print!("Detecting agents...");
    for agent in &discovered {
        let version_label = if agent.version.is_empty() {
            String::new()
        } else {
            format!("({})", agent.version)
        };
        println!("\n  ✓ {:<12} {} {}", agent.name, agent.label, version_label);
    }

    if available.is_empty() {
        println!("\n\nNo agents found. Ensemble requires at least one coding agent.");
        println!("Configure agents in acpx first, then re-run `ensemble init`.");
        println!("See: https://github.com/openclaw/acpx");
        return Err("no agents found".to_string());
    }

    println!();

    // Compute default selection indices from existing config.
    // If existing config exists but none of its agents match the available set,
    // fall back to selecting all available agents (same as fresh-init behavior).
    let default_indices: Vec<usize> = if let Some(config) = existing {
        let existing_agents: Vec<&str> = config
            .agents
            .values()
            .filter_map(|a| a.acpx_agent.as_deref())
            .collect();
        let indices: Vec<usize> = available
            .iter()
            .enumerate()
            .filter(|(_, name)| existing_agents.contains(&name.as_str()))
            .map(|(i, _)| i)
            .collect();
        if indices.is_empty() {
            (0..available.len()).collect()
        } else {
            indices
        }
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

    // Probe capabilities for selected agents using shared function
    println!("\nProbing agent capabilities...");
    let mut capabilities: HashMap<String, AgentCapabilities> = HashMap::new();
    for agent_name in &selected {
        print!("  {agent_name}...");
        let caps = discover_agent_capabilities(agent_name).await;
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

fn supports_adapter_startup_model(agent_name: &str) -> bool {
    agent_name == "opencode"
}

fn should_offer_model_selection(_agent_name: &str, caps: &AgentCapabilities) -> bool {
    caps.available_models.len() > 1
}

fn retained_existing_model<'a>(
    agent_name: &str,
    caps: &AgentCapabilities,
    existing_model: Option<&'a str>,
) -> Option<&'a str> {
    if should_offer_model_selection(agent_name, caps) {
        None
    } else if supports_adapter_startup_model(agent_name) {
        existing_model
    } else {
        None
    }
}

fn ask_roles(
    selected: Vec<String>,
    capabilities: &HashMap<String, AgentCapabilities>,
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<AgentEntry>, String> {
    println!("\nName your agents by role:\n");

    let default_roles = ["builder", "reviewer", "verifier", "planner"];

    // Build a list of (acpx_agent, role, model) from existing config.
    // Using a Vec instead of HashMap so multiple roles with the same acpx_agent are preserved.
    let existing_agents: Vec<(&str, &str, Option<&str>)> = existing
        .map(|config| {
            config
                .agents
                .iter()
                .filter_map(|(role, ac)| {
                    ac.acpx_agent
                        .as_deref()
                        .map(|name| (name, role.as_str(), ac.model.as_deref()))
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
            .filter(|(name, _, _)| *name == agent_name.as_str())
            .nth(*seen);
        *seen += 1;

        // Default role: existing config role, or positional default
        let default_role = existing_entry
            .map(|(_, role, _)| *role)
            .unwrap_or_else(|| default_roles.get(i).copied().unwrap_or("agent"));

        let role = inquire::Text::new(&format!("  {agent_name} → role name"))
            .with_default(default_role)
            .prompt()
            .map_err(|e| e.to_string())?;

        let caps = capabilities
            .get(agent_name.as_str())
            .cloned()
            .unwrap_or_default();

        let existing_model = existing_entry.and_then(|(_, _, model)| *model);

        let model = if should_offer_model_selection(agent_name, &caps) {
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
            retained_existing_model(agent_name, &caps, existing_model).map(str::to_string)
        };

        agents.push(AgentEntry {
            role,
            acpx_agent: agent_name.clone(),
            model,
        });
    }

    Ok(agents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_offer_model_selection_for_multiple_discovered_models() {
        let caps = AgentCapabilities {
            available_models: vec!["default".to_string(), "sonnet".to_string()],
            ..Default::default()
        };

        assert!(should_offer_model_selection("codex", &caps));
    }

    #[test]
    fn should_not_offer_model_selection_without_discovered_models() {
        let caps = AgentCapabilities::default();

        assert!(!should_offer_model_selection("codex", &caps));
    }

    #[test]
    fn should_preserve_existing_model_only_for_startup_model_agents() {
        let caps = AgentCapabilities::default();

        assert_eq!(
            retained_existing_model("opencode", &caps, Some("opencode-go/kimi-k2.5")),
            Some("opencode-go/kimi-k2.5")
        );
        assert_eq!(
            retained_existing_model("codex", &caps, Some("gpt-5.4/medium")),
            None
        );
    }

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
    }
}
