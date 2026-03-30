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
    let output = std::process::Command::new("acpx")
        .arg("--version")
        .output()
        .map_err(|_| {
            "acpx is not installed.\n\n\
             Ensemble requires acpx for agent communication.\n\
             Install: npm install -g acpx@latest\n\
             See: https://github.com/openclaw/acpx"
                .to_string()
        })?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    } else {
        Err("acpx --version failed".to_string())
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
