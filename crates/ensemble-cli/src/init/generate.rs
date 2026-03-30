use crate::init::agents::AgentEntry;
use crate::init::pipeline::PipelineStep;
use crate::init::repos::RepoEntry;
use crate::init::tracker::TrackerChoice;

pub fn generate_yaml(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
    on_success: &str,
    on_failure: &str,
) -> String {
    let mut yaml = String::new();

    yaml.push_str("tracker:\n");
    match tracker {
        TrackerChoice::TodoFile { path } => {
            yaml.push_str("  kind: todo_file\n");
            yaml.push_str(&format!("  path: {}\n", path.display()));
        }
        TrackerChoice::GitHub {
            repository,
            project_number,
            api_key_env,
            active_states,
            terminal_states,
            ..
        } => {
            yaml.push_str("  kind: github\n");
            yaml.push_str(&format!("  repository: {repository}\n"));
            yaml.push_str(&format!("  api_key: ${api_key_env}\n"));
            if let Some(n) = project_number {
                yaml.push_str(&format!("  project_number: {n}\n"));
            }
            yaml.push_str("  active_states:\n");
            for s in active_states {
                yaml.push_str(&format!("    - {s}\n"));
            }
            yaml.push_str("  terminal_states:\n");
            for s in terminal_states {
                yaml.push_str(&format!("    - {s}\n"));
            }
        }
    }

    if !repos.is_empty() {
        yaml.push_str("\nrepos:\n");
        for repo in repos {
            yaml.push_str(&format!("  - path: {}\n", repo.path.display()));
            yaml.push_str(&format!("    branch: {}\n", repo.branch));
        }
    }

    yaml.push_str("\nagents:\n");
    for agent in agents {
        yaml.push_str(&format!("  {}:\n", agent.role));
        yaml.push_str(&format!("    acpx_agent: {}\n", agent.acpx_agent));
        yaml.push_str(&format!(
            "    prompt_template: templates/{}.liquid\n",
            find_step_for_agent(&agent.role, steps)
        ));
    }

    yaml.push_str("\nsteps:\n");
    for step in steps {
        yaml.push_str(&format!("  - name: {}\n", step.name));
        yaml.push_str(&format!("    agent: {}\n", step.agent_role));
        if !step.depends.is_empty() {
            yaml.push_str("    depends:\n");
            for dep in &step.depends {
                yaml.push_str(&format!("      - {dep}\n"));
            }
        }
        if let Some(ref state) = step.tracker_state {
            yaml.push_str(&format!("    tracker_state: {state}\n"));
        }
    }

    yaml.push_str(&format!("\non_success: {on_success}\n"));
    yaml.push_str(&format!("on_failure: {on_failure}\n"));

    yaml
}

fn find_step_for_agent(role: &str, steps: &[PipelineStep]) -> String {
    steps
        .iter()
        .find(|s| s.agent_role == role)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| role.to_string())
}

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

pub fn write_files(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
    on_success: &str,
    on_failure: &str,
) -> Result<(), std::io::Error> {
    println!("Writing configuration...");

    let yaml = generate_yaml(tracker, repos, agents, steps, on_success, on_failure);
    std::fs::write("ensemble.yaml", &yaml)?;
    println!("  ✓ ensemble.yaml");

    std::fs::create_dir_all("templates")?;
    for step in steps {
        let template = generate_template(&step.name);
        let path = format!("templates/{}.liquid", step.name);
        if std::path::Path::new(&path).exists() {
            match inquire::Confirm::new(&format!("Template '{}' already exists. Overwrite?", path))
                .with_default(true)
                .prompt()
            {
                Ok(true) => {}
                Ok(false) => {
                    println!("  Skipping {path}");
                    continue;
                }
                Err(_) => return Ok(()),
            }
        }
        std::fs::write(&path, &template)?;
        println!("  ✓ {path}");
    }

    if let TrackerChoice::TodoFile { .. } = tracker {
        std::fs::write("TODO.md", generate_todo_md())?;
        println!("  ✓ TODO.md");
    }

    println!("\nDone! Run `ensemble` to start processing issues.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_generate_yaml_todo_file() {
        let tracker = TrackerChoice::TodoFile {
            path: PathBuf::from("TODO.md"),
        };
        let repos = vec![RepoEntry {
            path: PathBuf::from("/tmp/repo-a"),
            branch: "main".to_string(),
        }];
        let agents = vec![AgentEntry {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
        }];
        let steps = vec![PipelineStep {
            name: "implement".to_string(),
            agent_role: "builder".to_string(),
            depends: vec![],
            tracker_state: Some("In Progress".to_string()),
        }];

        let yaml = generate_yaml(&tracker, &repos, &agents, &steps, "Done", "Failed");

        assert!(yaml.contains("kind: todo_file"));
        assert!(yaml.contains("path: TODO.md"));
        assert!(yaml.contains("path: /tmp/repo-a"));
        assert!(yaml.contains("branch: main"));
        assert!(yaml.contains("builder:"));
        assert!(yaml.contains("acpx_agent: claude"));
        assert!(yaml.contains("prompt_template: templates/implement.liquid"));
        assert!(yaml.contains("name: implement"));
        assert!(yaml.contains("agent: builder"));
        assert!(yaml.contains("on_success: Done"));
        assert!(yaml.contains("on_failure: Failed"));
    }

    #[test]
    fn test_generate_yaml_github() {
        let tracker = TrackerChoice::GitHub {
            repository: "acme/frontend".to_string(),
            project_number: Some(42),
            api_key_env: "GITHUB_TOKEN".to_string(),
            active_states: vec!["Todo".to_string()],
            terminal_states: vec!["Done".to_string()],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let repos = vec![];
        let agents = vec![
            AgentEntry {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
            },
            AgentEntry {
                role: "reviewer".to_string(),
                acpx_agent: "codex".to_string(),
            },
        ];
        let steps = vec![
            PipelineStep {
                name: "implement".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: Some("In Progress".to_string()),
            },
            PipelineStep {
                name: "review".to_string(),
                agent_role: "reviewer".to_string(),
                depends: vec!["implement".to_string()],
                tracker_state: Some("Review".to_string()),
            },
        ];

        let yaml = generate_yaml(&tracker, &repos, &agents, &steps, "Done", "Failed");

        assert!(yaml.contains("kind: github"));
        assert!(yaml.contains("repository: acme/frontend"));
        assert!(yaml.contains("project_number: 42"));
        assert!(yaml.contains("api_key: $GITHUB_TOKEN"));
        assert!(yaml.contains("- Todo"));
        assert!(yaml.contains("- Done"));
        assert!(yaml.contains("builder:"));
        assert!(yaml.contains("reviewer:"));
        assert!(yaml.contains("depends:"));
        assert!(yaml.contains("- implement"));
    }

    #[test]
    fn test_generate_template_implement() {
        let template = generate_template("implement");
        assert!(template.contains("{{ issue.title }}"));
        assert!(template.contains("{{ issue.description }}"));
        assert!(template.contains("Solve the following issue"));
    }

    #[test]
    fn test_generate_template_review() {
        let template = generate_template("review");
        assert!(template.contains("{{ issue.title }}"));
        assert!(template.contains("verdict"));
        assert!(template.contains("Review the changes"));
    }

    #[test]
    fn test_generate_todo_md() {
        let md = generate_todo_md();
        assert!(md.contains("## Todo"));
        assert!(md.contains("[SAMPLE-1]"));
        assert!(md.contains("## Done"));
    }
}
