# Init: Existing Config Defaults & Model Selection Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When re-running `ensemble init`, load existing `ensemble.yaml` values as defaults for every prompt; after selecting acpx agents, probe each for available models and reasoning levels and let the user choose.

**Architecture:** Load existing config with `EnsembleConfig::load_config()` and thread `Option<&EnsembleConfig>` into each wizard step. For model discovery, use `acpx <agent> sessions ensure` to create a probe session, read the session JSON from `~/.acpx/sessions/`, extract `available_models` and `config_options` with `thought_level` category, then close the session.

**Tech Stack:** Rust (serde, serde_json, inquire, dirs), acpx CLI

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/ensemble-core/src/config/ensemble.rs` | Modify | Add `reasoning_level: Option<String>` to `AgentConfig` |
| `crates/ensemble-cli/src/commands/init.rs` | Modify | Load existing config, pass to wizard steps |
| `crates/ensemble-cli/src/commands/init/agents.rs` | Modify | Add model/reasoning fields to `AgentEntry`, probe logic, model/reasoning prompts |
| `crates/ensemble-cli/src/commands/init/tracker.rs` | Modify | Accept `Option<&EnsembleConfig>` for defaults |
| `crates/ensemble-cli/src/commands/init/repos.rs` | Modify | Accept `Option<&EnsembleConfig>` for defaults |
| `crates/ensemble-cli/src/commands/init/pipeline.rs` | Modify | Accept `Option<&EnsembleConfig>` for defaults |
| `crates/ensemble-cli/src/commands/init/generate.rs` | Modify | Emit `model` and `reasoning_level` in YAML |
| `docs/SPEC.md` | Modify | Add `reasoning_level` to agents section |
| `ensemble/CLAUDE.md` | Modify | Add `reasoning_level` to `AgentConfig` description |

---

### Task 1: Add `reasoning_level` to `AgentConfig`

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs:78-86`

- [ ] **Step 1: Write the failing test**

Add a new test in `crates/ensemble-core/src/config/ensemble.rs` that parses a YAML config with `reasoning_level` set:

```rust
#[test]
fn test_parse_config_with_reasoning_level() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    model: sonnet
    reasoning_level: high
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;
    let config = parse_config(yaml).unwrap();
    let builder = &config.agents["builder"];
    assert_eq!(builder.reasoning_level.as_deref(), Some("high"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ensemble-core test_parse_config_with_reasoning_level`
Expected: FAIL — `AgentConfig` has no field `reasoning_level`, serde will reject the unknown field.

- [ ] **Step 3: Add the field**

In `crates/ensemble-core/src/config/ensemble.rs`, add `reasoning_level` to `AgentConfig` (after line 85, before the closing `}`):

```rust
pub struct AgentConfig {
    pub executor: Option<String>,
    pub model: Option<String>,
    pub acpx_agent: Option<String>,
    pub prompt: Option<String>,
    #[schema(value_type = Option<String>)]
    pub prompt_template: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p ensemble-core test_parse_config_with_reasoning_level`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cargo test -p ensemble-core`
Expected: All existing tests pass (the new field defaults to `None` via `serde(default)`).

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs
git commit -m "Add reasoning_level field to AgentConfig"
```

---

### Task 2: Add model and reasoning_level to `AgentEntry`

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/agents.rs:15-19`
- Modify: `crates/ensemble-cli/src/commands/init/generate.rs` (tests that construct `AgentEntry`)

- [ ] **Step 1: Update `AgentEntry` struct**

In `crates/ensemble-cli/src/commands/init/agents.rs`, update the struct:

```rust
#[derive(Debug)]
pub struct AgentEntry {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,
    pub reasoning_level: Option<String>,
}
```

- [ ] **Step 2: Fix all `AgentEntry` construction sites**

The compiler will show every place that constructs an `AgentEntry`. Update `ask_roles` in `agents.rs` (line 72-75):

```rust
agents.push(AgentEntry {
    role,
    acpx_agent: agent_name.clone(),
    model: None,
    reasoning_level: None,
});
```

Update all test `AgentEntry` constructors in `generate.rs` tests. There are two tests that build `AgentEntry` values:

In `test_generate_yaml_todo_file` (line 224-227):
```rust
let agents = vec![AgentEntry {
    role: "builder".to_string(),
    acpx_agent: "claude".to_string(),
    model: None,
    reasoning_level: None,
}];
```

In `test_generate_yaml_github` (line 263-272):
```rust
let agents = vec![
    AgentEntry {
        role: "builder".to_string(),
        acpx_agent: "claude".to_string(),
        model: None,
        reasoning_level: None,
    },
    AgentEntry {
        role: "reviewer".to_string(),
        acpx_agent: "codex".to_string(),
        model: None,
        reasoning_level: None,
    },
];
```

- [ ] **Step 3: Run tests to verify everything compiles and passes**

Run: `cargo test -p ensemble-cli`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/agents.rs crates/ensemble-cli/src/commands/init/generate.rs
git commit -m "Add model and reasoning_level fields to AgentEntry"
```

---

### Task 3: Emit model and reasoning_level in generated YAML

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/generate.rs:63-71`

- [ ] **Step 1: Write the failing test**

Add a new test to `generate.rs`:

```rust
#[test]
fn test_generate_yaml_with_model_and_reasoning() {
    let tracker = TrackerChoice::TodoFile {
        path: PathBuf::from("TODO.md"),
    };
    let agents = vec![AgentEntry {
        role: "builder".to_string(),
        acpx_agent: "claude".to_string(),
        model: Some("sonnet".to_string()),
        reasoning_level: Some("high".to_string()),
    }];
    let steps = vec![PipelineStep {
        name: "implement".to_string(),
        agent_role: "builder".to_string(),
        depends: vec![],
        tracker_state: Some("In Progress".to_string()),
    }];

    let yaml = generate_yaml(&tracker, &[], &agents, &steps, "Done", "Failed");

    assert!(yaml.contains("acpx_agent: claude"));
    assert!(yaml.contains("model: sonnet"));
    assert!(yaml.contains("reasoning_level: high"));
    assert!(yaml.contains("prompt_template: templates/implement.liquid"));
}

#[test]
fn test_generate_yaml_omits_none_model() {
    let tracker = TrackerChoice::TodoFile {
        path: PathBuf::from("TODO.md"),
    };
    let agents = vec![AgentEntry {
        role: "builder".to_string(),
        acpx_agent: "claude".to_string(),
        model: None,
        reasoning_level: None,
    }];
    let steps = vec![PipelineStep {
        name: "implement".to_string(),
        agent_role: "builder".to_string(),
        depends: vec![],
        tracker_state: Some("In Progress".to_string()),
    }];

    let yaml = generate_yaml(&tracker, &[], &agents, &steps, "Done", "Failed");

    assert!(yaml.contains("acpx_agent: claude"));
    assert!(!yaml.contains("model:"));
    assert!(!yaml.contains("reasoning_level:"));
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p ensemble-cli test_generate_yaml_with_model_and_reasoning test_generate_yaml_omits_none_model`
Expected: `test_generate_yaml_with_model_and_reasoning` FAILS (no `model:` line), `test_generate_yaml_omits_none_model` may pass already.

- [ ] **Step 3: Update `generate_yaml` to emit model and reasoning_level**

In `generate.rs`, update the agents section of `generate_yaml` (lines 63-71):

```rust
    yaml.push_str("\nagents:\n");
    for agent in agents {
        yaml.push_str(&format!("  {}:\n", agent.role));
        yaml.push_str(&format!("    acpx_agent: {}\n", agent.acpx_agent));
        if let Some(ref model) = agent.model {
            yaml.push_str(&format!("    model: {model}\n"));
        }
        if let Some(ref level) = agent.reasoning_level {
            yaml.push_str(&format!("    reasoning_level: {level}\n"));
        }
        yaml.push_str(&format!(
            "    prompt_template: templates/{}.liquid\n",
            find_step_for_agent(&agent.role, steps)
        ));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p ensemble-cli generate::tests`
Expected: All tests pass including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/generate.rs
git commit -m "Emit model and reasoning_level in generated YAML"
```

---

### Task 4: Load existing config in init.rs

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init.rs`

- [ ] **Step 1: Update `execute()` to load existing config and pass it through**

Replace the entire `execute` function in `init.rs`:

```rust
use ensemble_core::config::ensemble::{load_config, EnsembleConfig};
use std::process::ExitCode;

pub mod agents;
pub mod generate;
pub mod pipeline;
pub mod repos;
pub mod tracker;
pub mod validate;

#[derive(Debug, Clone)]
pub struct InitArgs;

/// Run the interactive initialization wizard
pub async fn execute(_args: InitArgs) -> ExitCode {
    println!();

    // Try to load existing config for defaults
    let existing: Option<EnsembleConfig> = if std::path::Path::new("ensemble.yaml").exists() {
        let overwrite = match inquire::Confirm::new("ensemble.yaml already exists. Overwrite?")
            .with_default(false)
            .prompt()
        {
            Ok(v) => v,
            Err(_) => return ExitCode::FAILURE,
        };
        if !overwrite {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
        match load_config(std::path::Path::new("ensemble.yaml")) {
            Ok(config) => {
                println!("  (using existing values as defaults)\n");
                Some(config)
            }
            Err(e) => {
                eprintln!("  Warning: could not parse existing config: {e}");
                eprintln!("  Proceeding without defaults.\n");
                None
            }
        }
    } else {
        None
    };

    let existing_ref = existing.as_ref();

    let tracker_result = match tracker::ask_tracker(existing_ref).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let repos = match repos::ask_repos(existing_ref) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let discovered_agents = match agents::discover_agents(existing_ref) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let steps = match pipeline::ask_pipeline(&discovered_agents, existing_ref) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let proceed =
        validate::run_validation(&tracker_result, &repos, &discovered_agents, &steps).await;
    let proceed = match proceed {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error during validation: {e}");
            return ExitCode::FAILURE;
        }
    };
    if !proceed {
        println!("Aborted.");
        return ExitCode::SUCCESS;
    }

    let (on_success, on_failure) = match &tracker_result {
        tracker::TrackerChoice::GitHub {
            on_success,
            on_failure,
            ..
        } => (on_success.clone(), on_failure.clone()),
        tracker::TrackerChoice::TodoFile { .. } => ("Done".to_string(), "Failed".to_string()),
    };

    if let Err(e) = generate::write_files(
        &tracker_result,
        &repos,
        &discovered_agents,
        &steps,
        &on_success,
        &on_failure,
    ) {
        eprintln!("error writing files: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p ensemble-cli`
Expected: FAIL — the `ask_tracker`, `ask_repos`, `discover_agents`, `ask_pipeline` signatures don't accept the new parameter yet. That's expected; we fix them in tasks 5-8.

- [ ] **Step 3: Commit (WIP)**

```bash
git add crates/ensemble-cli/src/commands/init.rs
git commit -m "WIP: load existing config in init wizard"
```

---

### Task 5: Add existing config defaults to tracker

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/tracker.rs`

- [ ] **Step 1: Update `ask_tracker` signature and add defaults**

Update `ask_tracker` to accept the existing config:

```rust
use ensemble_core::config::ensemble::EnsembleConfig;

/// Ask the user where their issues live, then collect the relevant credentials.
pub async fn ask_tracker(
    existing: Option<&EnsembleConfig>,
) -> Result<TrackerChoice, inquire::InquireError> {
    let options = vec!["GitHub Projects", "TODO.md (great for trying things out)"];

    // Default to the existing tracker kind
    let default_index = existing
        .map(|c| if c.tracker.kind == "github" { 0 } else { 1 })
        .unwrap_or(1);

    let choice = Select::new("Where do your issues live?", options)
        .with_starting_cursor(default_index)
        .prompt()?;

    match choice {
        "GitHub Projects" => ask_github_tracker(existing).await,
        _ => {
            let default_path = existing
                .and_then(|c| c.tracker.path.as_ref())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "TODO.md".to_string());

            let path_str = Text::new("TODO file path:")
                .with_default(&default_path)
                .prompt()?;

            println!("Creating TODO.md with a sample issue...");
            Ok(TrackerChoice::TodoFile {
                path: PathBuf::from(path_str),
            })
        }
    }
}
```

- [ ] **Step 2: Update `ask_github_tracker` to accept defaults**

Update `ask_github_tracker` signature and use existing values:

```rust
async fn ask_github_tracker(
    existing: Option<&EnsembleConfig>,
) -> Result<TrackerChoice, inquire::InquireError> {
    let default_repo = existing
        .and_then(|c| c.tracker.repository.as_deref())
        .unwrap_or("");

    let repository = Text::new("GitHub repository (owner/repo):")
        .with_help_message("e.g. acme/frontend")
        .with_default(default_repo)
        .prompt()?;

    let default_proj = existing
        .and_then(|c| c.tracker.project_number)
        .map(|n| n.to_string())
        .unwrap_or_default();

    let project_number_str =
        Text::new("GitHub Project board number (optional, press enter to skip):")
            .with_default(&default_proj)
            .prompt()?;

    let project_number: Option<i64> = if project_number_str.trim().is_empty() {
        None
    } else {
        match project_number_str.trim().parse::<i64>() {
            Ok(n) => Some(n),
            Err(_) => {
                eprintln!(
                    "Warning: could not parse project number '{}', skipping.",
                    project_number_str.trim()
                );
                None
            }
        }
    };

    // remainder of function is unchanged from current code (token check,
    // status fetching, status mapping) — do not modify
```

The remainder of `ask_github_tracker` (token check, status fetching, status mapping) stays the same. The only change is the two `with_default()` calls above.

- [ ] **Step 3: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-cli`
Expected: Compilation succeeds. Existing tests pass (they don't call `ask_tracker` directly — it requires interactive input).

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/tracker.rs
git commit -m "Add existing config defaults to tracker wizard"
```

---

### Task 6: Add existing config defaults to repos

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/repos.rs`

- [ ] **Step 1: Update `ask_repos` to accept and use existing config**

Update the function signature and pre-populate from existing repos:

```rust
use ensemble_core::config::ensemble::EnsembleConfig;

pub fn ask_repos(
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<RepoEntry>, inquire::InquireError> {
    println!("Which repos should agents work in?");

    let mut repos: Vec<RepoEntry> = Vec::new();

    // Pre-populate from existing config
    if let Some(config) = existing {
        for repo_config in &config.repos {
            let path = PathBuf::from(&repo_config.path);
            if path.exists() && is_git_repo(&path) {
                println!("  (existing) {} [{}]", path.display(), repo_config.branch);
                repos.push(RepoEntry {
                    path,
                    branch: repo_config.branch.clone(),
                });
            }
        }
        if !repos.is_empty() {
            let keep = inquire::Confirm::new(&format!(
                "Keep {} existing repo(s)?",
                repos.len()
            ))
            .with_default(true)
            .prompt()?;
            if !keep {
                repos.clear();
            }
        }
    }

    let mut index = repos.len() + 1;

    loop {
        let prompt = format!("Repo {} path (blank to finish)", index);
        let raw = inquire::Text::new(&prompt).prompt()?;
        let trimmed = raw.trim().to_string();

        if trimmed.is_empty() {
            if repos.is_empty() {
                println!("At least one repo is required. Please enter a path.");
                continue;
            }
            break;
        }

        let expanded = expand_tilde(&trimmed);
        let input_path = PathBuf::from(&expanded);

        let canonical = match std::fs::canonicalize(&input_path) {
            Ok(p) => p,
            Err(e) => {
                println!(
                    "Cannot resolve path '{}': {}. Please try again.",
                    trimmed, e
                );
                continue;
            }
        };

        if !is_git_repo(&canonical) {
            println!(
                "'{}' does not appear to be a git repository. Please try again.",
                canonical.display()
            );
            continue;
        }

        let default_branch = detect_default_branch(&canonical);
        let branch_default_text = default_branch.clone().unwrap_or_else(|| "main".to_string());

        let branch_prompt = format!("Target branch for '{}'", canonical.display());
        let branch_input = inquire::Text::new(&branch_prompt)
            .with_default(&branch_default_text)
            .prompt()?;
        let branch = branch_input.trim().to_string();

        match ask_branch_with_retry(&canonical, &branch) {
            Some(branch) => {
                repos.push(RepoEntry {
                    path: canonical,
                    branch,
                });
                index += 1;
            }
            None => {
                println!("Skipping repo '{}'.", canonical.display());
            }
        }
    }

    Ok(repos)
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-cli`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/repos.rs
git commit -m "Add existing config defaults to repos wizard"
```

---

### Task 7: Add acpx probe and model/reasoning prompts to agents

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/agents.rs`

This is the largest task. It adds:
1. `AgentCapabilities` struct and `probe_agent_capabilities` function
2. Model/reasoning prompts during role assignment
3. Existing config defaults for agent selection and roles

- [ ] **Step 1: Write the test for parsing session JSON**

Add a test for the capabilities extraction logic at the bottom of agents.rs (inside `mod tests`):

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ensemble-cli parse_session_json`
Expected: FAIL — `AgentCapabilities` doesn't exist yet.

- [ ] **Step 3: Add `AgentCapabilities` struct and parsing**

Add this above `discover_agents` in `agents.rs`:

```rust
/// Capabilities discovered by probing an acpx agent session.
#[derive(Debug, Default)]
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
                            .filter_map(|v| v.get("id").and_then(|id| id.as_str()).map(str::to_owned))
                            .collect();
                    }
                }
            }
        }

        caps
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p ensemble-cli parse_session_json`
Expected: All three tests pass.

- [ ] **Step 5: Add `serde_json` dependency to ensemble-cli Cargo.toml if not present**

Check `crates/ensemble-cli/Cargo.toml` for `serde_json`. If missing, add it under `[dependencies]`:

```toml
serde_json = { workspace = true }
```

Run: `cargo check -p ensemble-cli`

- [ ] **Step 6: Add `probe_agent_capabilities` function**

Add the probe function that creates an acpx session, reads the session JSON, and cleans up:

```rust
use std::collections::HashMap;

/// Probe an acpx agent for model and reasoning capabilities.
///
/// Creates a short-lived session, reads the session JSON to extract
/// capabilities, then closes the session. Returns empty capabilities
/// on any failure.
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
```

- [ ] **Step 7: Add `dirs` dependency to ensemble-cli Cargo.toml**

In the workspace `Cargo.toml`, add `dirs` if not present:

```toml
[workspace.dependencies]
dirs = "6"
```

In `crates/ensemble-cli/Cargo.toml`:

```toml
dirs = { workspace = true }
```

Run: `cargo check -p ensemble-cli`

- [ ] **Step 8: Update `discover_agents` to accept existing config, probe capabilities, and prompt for model/reasoning**

Replace the `discover_agents` and `ask_roles` functions:

```rust
pub fn discover_agents(
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<AgentEntry>, String> {
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

    // Build a lookup from acpx_agent -> (role, model, reasoning_level) from existing config
    let existing_agents: HashMap<&str, (&str, Option<&str>, Option<&str>)> = existing
        .map(|config| {
            config
                .agents
                .iter()
                .filter_map(|(role, ac)| {
                    ac.acpx_agent.as_deref().map(|name| {
                        (
                            name,
                            (
                                role.as_str(),
                                ac.model.as_deref(),
                                ac.reasoning_level.as_deref(),
                            ),
                        )
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut agents = Vec::new();

    for (i, agent_name) in selected.iter().enumerate() {
        // Default role: existing config role, or positional default
        let default_role = existing_agents
            .get(agent_name.as_str())
            .map(|(role, _, _)| *role)
            .unwrap_or_else(|| default_roles.get(i).copied().unwrap_or("agent"));

        let role = inquire::Text::new(&format!("  {agent_name} → role name"))
            .with_default(default_role)
            .prompt()
            .map_err(|e| e.to_string())?;

        let caps = capabilities
            .get(agent_name.as_str())
            .cloned()
            .unwrap_or_default();

        let existing_model = existing_agents
            .get(agent_name.as_str())
            .and_then(|(_, model, _)| *model);

        let existing_reasoning = existing_agents
            .get(agent_name.as_str())
            .and_then(|(_, _, reasoning)| *reasoning);

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

        // Ask for reasoning level if capabilities include thought_levels
        let reasoning_level = if caps.thought_levels.len() > 1 {
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
            None
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
```

- [ ] **Step 9: Add the import at the top of agents.rs**

```rust
use ensemble_core::config::ensemble::EnsembleConfig;
use std::collections::HashMap;
```

- [ ] **Step 10: Verify it compiles**

Run: `cargo check -p ensemble-cli`
Expected: Compiles successfully.

- [ ] **Step 11: Run all tests**

Run: `cargo test -p ensemble-cli`
Expected: All tests pass.

- [ ] **Step 12: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/agents.rs crates/ensemble-cli/Cargo.toml Cargo.toml
git commit -m "Add acpx model/reasoning probe and existing config defaults to agents"
```

---

### Task 8: Add existing config defaults to pipeline

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/pipeline.rs`

- [ ] **Step 1: Update `ask_pipeline` to accept existing config**

```rust
use ensemble_core::config::ensemble::EnsembleConfig;

pub fn ask_pipeline(
    agents: &[AgentEntry],
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<PipelineStep>, inquire::InquireError> {
    let role_names: Vec<&str> = agents.iter().map(|a| a.role.as_str()).collect();

    if agents.len() == 1 {
        // Check if existing config has steps for this single agent
        let step_name = existing
            .and_then(|c| c.steps.first())
            .map(|s| s.name.as_str())
            .unwrap_or("implement");

        let tracker_state = existing
            .and_then(|c| c.steps.first())
            .and_then(|s| s.tracker_state.as_deref())
            .unwrap_or("In Progress");

        println!(
            "\nPipeline: single step ({}) using {}",
            step_name, role_names[0]
        );
        return Ok(vec![PipelineStep {
            name: step_name.to_string(),
            agent_role: role_names[0].to_string(),
            depends: vec![],
            tracker_state: Some(tracker_state.to_string()),
        }]);
    }

    // Check if existing pipeline matches current agent roles
    let existing_matches = existing.map_or(false, |config| {
        config
            .steps
            .iter()
            .all(|step| role_names.contains(&step.agent.as_str()))
    });

    if existing_matches {
        let existing_steps = &existing.unwrap().steps;
        let step_summary: Vec<String> = existing_steps
            .iter()
            .map(|s| s.name.clone())
            .collect();
        let summary = step_summary.join(" → ");

        let options = vec![
            format!("Yes, use existing ({summary})"),
            "Yes, use defaults (implement → review)".to_string(),
            "No, let me customize".to_string(),
        ];
        let choice = inquire::Select::new("Use existing pipeline?", options).prompt()?;

        if choice.starts_with("Yes, use existing") {
            return Ok(existing_steps
                .iter()
                .map(|s| PipelineStep {
                    name: s.name.clone(),
                    agent_role: s.agent.clone(),
                    depends: s.depends.clone().unwrap_or_default(),
                    tracker_state: s.tracker_state.clone(),
                })
                .collect());
        } else if choice.starts_with("Yes, use defaults") {
            return Ok(default_pipeline(&role_names));
        }
        // else: fall through to custom
        return custom_pipeline(&role_names);
    }

    let options = vec![
        "Yes, use defaults (implement → review)",
        "No, let me customize",
    ];
    let choice = inquire::Select::new("Use default pipeline?", options).prompt()?;

    if choice.starts_with("Yes") {
        Ok(default_pipeline(&role_names))
    } else {
        custom_pipeline(&role_names)
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-cli`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/pipeline.rs
git commit -m "Add existing config defaults to pipeline wizard"
```

---

### Task 9: Update docs (SPEC.md and CLAUDE.md)

**Files:**
- Modify: `docs/SPEC.md:530-538`
- Modify: `ensemble/CLAUDE.md`

- [ ] **Step 1: Add `reasoning_level` to SPEC.md agents section**

In `docs/SPEC.md`, in section 5.3.3 (agents), add a new bullet after the `model` entry (after line 532):

```markdown
- `reasoning_level` (string, optional)
  - Reasoning/thinking level for agents that support it (for example `high`, `low`).
  - When omitted, the agent uses its default reasoning level.
  - Discovered automatically during `ensemble init` by probing acpx agent capabilities.
```

- [ ] **Step 2: Update CLAUDE.md project structure**

In `ensemble/CLAUDE.md`, update the `AgentConfig` description in the config section. Find the line:

```
│   │   │   ├── config/
│   │   │   │   ├── ensemble.rs   # ensemble.yaml loader (EnsembleConfig)
```

No structural change needed — the file list is already correct. But update the comment in the error.rs line to reflect the new field isn't an error type.

Actually, `CLAUDE.md` describes `AgentConfig` only implicitly via the project structure tree. No change needed there since `ensemble.rs` is already listed.

However, update the "Key design decisions" section to mention model/reasoning discovery:

Find the bullet starting with `- **Config from ensemble.yaml**:` and add after it:

```markdown
- **Agent model discovery**: During `ensemble init`, acpx agent sessions are probed to discover available models and reasoning levels. These are stored as `model` and `reasoning_level` in `AgentConfig` and emitted in `ensemble.yaml`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md ensemble/CLAUDE.md
git commit -m "Document reasoning_level field and model discovery in SPEC and CLAUDE.md"
```

---

### Task 10: Final integration — verify full build and tests

**Files:**
- All modified files from tasks 1-9

- [ ] **Step 1: Run the full workspace build**

Run: `cargo build --workspace`
Expected: Builds successfully with no errors.

- [ ] **Step 2: Run full workspace tests**

Run: `cargo test --workspace`
Expected: All tests pass.

- [ ] **Step 3: Run clippy**

Run: `cargo clippy --workspace -- -D warnings`
Expected: No warnings or errors.

- [ ] **Step 4: Run fmt check**

Run: `cargo fmt --all -- --check`
Expected: No formatting issues.

- [ ] **Step 5: Commit any fixups**

If any clippy or fmt issues were found and fixed:

```bash
git add -A
git commit -m "Fix clippy and fmt issues"
```

- [ ] **Step 6: Squash WIP commits if desired**

The Task 4 WIP commit can be left as-is since later commits complete the work. Or interactively rebase to squash if preferred.
