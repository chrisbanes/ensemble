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
}

pub fn discover_agents() -> Result<Vec<AgentEntry>, String> {
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

    let selected =
        inquire::MultiSelect::new("Which agents should be available?", available.clone())
            .with_default(&(0..available.len()).collect::<Vec<_>>())
            .prompt()
            .map_err(|e| e.to_string())?;

    if selected.is_empty() {
        return Err("at least one agent is required".to_string());
    }

    let agents = ask_roles(selected)?;

    Ok(agents)
}

fn ask_roles(selected: Vec<String>) -> Result<Vec<AgentEntry>, String> {
    println!("\nName your agents by role:\n");

    let default_roles = ["builder", "reviewer", "verifier", "planner"];
    let mut agents = Vec::new();

    for (i, agent_name) in selected.iter().enumerate() {
        let default_role = default_roles.get(i).unwrap_or(&"agent");
        let role = inquire::Text::new(&format!("  {agent_name} → role name"))
            .with_default(default_role)
            .prompt()
            .map_err(|e| e.to_string())?;

        agents.push(AgentEntry {
            role,
            acpx_agent: agent_name.clone(),
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

    let cmd = format!("{choice} install -g acpx@latest");
    println!("\nRunning: {cmd}\n");

    let status = std::process::Command::new(choice)
        .args(["install", "-g", "acpx@latest"])
        .status()
        .map_err(|e| format!("{choice} failed: {e}"))?;

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
        if v.is_empty() { None } else { Some(v) }
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
