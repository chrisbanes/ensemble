use crate::commands::init::agents::AgentEntry;
use crate::commands::init::pipeline::PipelineStep;
use crate::commands::init::repos::RepoEntry;
use crate::commands::init::tracker::TrackerChoice;
use ensemble_core::config::setup::{
    build_setup_artifacts, merge_setup_request, resolve_tracker_output_path, write_setup_artifacts,
    SetupAgent, SetupRepo, SetupRequest, SetupStep, SetupTracker,
};

#[derive(Debug, Default, PartialEq, Eq)]
struct OverwritePlan {
    template_prompts: Vec<std::path::PathBuf>,
    env_prompt: Option<std::path::PathBuf>,
    todo_prompt: Option<std::path::PathBuf>,
}

/// Convert CLI types to a SetupRequest for the shared implementation.
fn to_setup_request(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
    on_success: &str,
    on_failure: &str,
) -> SetupRequest {
    let tracker = match tracker {
        TrackerChoice::TodoFile { path } => SetupTracker::TodoFile { path: path.clone() },
        TrackerChoice::GitHub {
            repository,
            project_number,
            api_key_env,
            api_token,
            active_states,
            terminal_states,
            ..
        } => SetupTracker::GitHub {
            repository: repository.clone(),
            project_number: *project_number,
            api_key_env: api_key_env.clone(),
            api_token: api_token.clone(),
            active_states: active_states.clone(),
            terminal_states: terminal_states.clone(),
        },
    };

    let repos = repos
        .iter()
        .map(|r| SetupRepo {
            path: r.path.clone(),
            branch: r.branch.clone(),
        })
        .collect();

    let agents = agents
        .iter()
        .map(|a| SetupAgent {
            role: a.role.clone(),
            acpx_agent: a.acpx_agent.clone(),
            model: a.model.clone(),
        })
        .collect();

    let steps = steps
        .iter()
        .map(|s| SetupStep {
            name: s.name.clone(),
            agent_role: s.agent_role.clone(),
            depends: s.depends.clone(),
            tracker_state: s.tracker_state.clone(),
        })
        .collect();

    SetupRequest {
        tracker,
        repos,
        agents,
        steps,
        on_success: on_success.to_string(),
        on_failure: on_failure.to_string(),
    }
}

#[allow(dead_code)]
pub fn generate_yaml(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
    on_success: &str,
    on_failure: &str,
) -> String {
    let request = to_setup_request(tracker, repos, agents, steps, on_success, on_failure);
    let artifacts = build_setup_artifacts(&request);
    artifacts.raw_yaml
}

#[allow(dead_code)]
pub fn generate_template(step_name: &str) -> String {
    // Delegate to the shared implementation via internal helper
    ensemble_core::config::setup::generate_template(step_name)
}

#[allow(dead_code)]
pub fn generate_todo_md() -> String {
    // Delegate to the shared implementation via internal helper
    ensemble_core::config::setup::generate_todo_md()
}

pub fn write_files(
    config_dir: &std::path::Path,
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
    on_success: &str,
    on_failure: &str,
) -> Result<(), std::io::Error> {
    println!("Writing configuration...");

    // Create config directory if it doesn't exist
    std::fs::create_dir_all(config_dir)?;

    let request = to_setup_request(tracker, repos, agents, steps, on_success, on_failure);

    // For reconfiguration, try to read existing config
    let existing_raw_yaml = if config_dir.join("config.yaml").exists() {
        std::fs::read_to_string(config_dir.join("config.yaml")).ok()
    } else {
        None
    };

    let mut artifacts = merge_setup_request(existing_raw_yaml.as_deref(), &request)
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let overwrite_plan = plan_overwrites(config_dir, &request, &artifacts);
    let mut declined = OverwritePlan::default();

    for template_path in &overwrite_plan.template_prompts {
        match inquire::Confirm::new(&format!(
            "Template '{}' already exists. Overwrite?",
            template_path.display()
        ))
        .with_default(true)
        .prompt()
        {
            Ok(true) => {}
            Ok(false) => {
                println!("  Skipping {}", template_path.display());
                declined.template_prompts.push(template_path.clone());
            }
            Err(_) => return Ok(()),
        }
    }

    if let Some(env_path) = &overwrite_plan.env_prompt {
        match inquire::Confirm::new(&format!(
            "{} already exists. Overwrite?",
            env_path.display()
        ))
        .with_default(false)
        .prompt()
        {
            Ok(true) => {}
            Ok(false) => {
                println!("  Skipping {} (token not saved)", env_path.display());
                declined.env_prompt = Some(env_path.clone());
            }
            Err(_) => return Ok(()),
        }
    }

    if let Some(todo_path) = &overwrite_plan.todo_prompt {
        match inquire::Confirm::new(&format!(
            "{} already exists. Overwrite?",
            todo_path.display()
        ))
        .with_default(true)
        .prompt()
        {
            Ok(true) => {}
            Ok(false) => {
                println!("  Skipping {}", todo_path.display());
                declined.todo_prompt = Some(todo_path.clone());
            }
            Err(_) => return Ok(()),
        }
    }

    apply_declined_overwrites(config_dir, &request, &mut artifacts, &declined);

    // Write the main artifacts
    write_setup_artifacts(config_dir, &request, &artifacts)
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    println!("  ✓ {}", config_dir.join("config.yaml").display());

    // Print template paths
    for template_path in artifacts.templates.keys() {
        let full_path = config_dir.join(template_path);
        println!("  ✓ {}", full_path.display());
    }

    // Print TODO.md path for todo_file tracker (already written by write_setup_artifacts)
    if let TrackerChoice::TodoFile { path } = tracker {
        if artifacts.todo_md.is_some() {
            println!("  ✓ {}", path.display());
        }
    }

    if let TrackerChoice::GitHub {
        api_token: Some(_), ..
    } = tracker
    {
        let env_path = config_dir.join(".env");
        if env_path.exists() {
            println!(
                "  ✓ {} (auto-loaded from config directory)",
                env_path.display()
            );
        }
    }

    println!("\nDone! Run `ensemble` to start processing issues.");
    Ok(())
}

fn plan_overwrites(
    config_dir: &std::path::Path,
    request: &SetupRequest,
    artifacts: &ensemble_core::config::setup::SetupArtifacts,
) -> OverwritePlan {
    let mut plan = OverwritePlan::default();

    for template_path in artifacts.templates.keys() {
        let full_path = config_dir.join(template_path);
        if full_path.exists() {
            plan.template_prompts.push(full_path);
        }
    }

    if matches!(
        request.tracker,
        SetupTracker::GitHub {
            api_token: Some(_),
            ..
        }
    ) {
        let env_path = config_dir.join(".env");
        if env_path.exists() {
            plan.env_prompt = Some(env_path);
        }
    }

    if artifacts.todo_md.is_some() {
        if let SetupTracker::TodoFile { path } = &request.tracker {
            if let Ok(todo_path) = resolve_tracker_output_path(path, config_dir) {
                if todo_path.exists() {
                    plan.todo_prompt = Some(todo_path);
                }
            }
        }
    }

    plan
}

fn apply_declined_overwrites(
    config_dir: &std::path::Path,
    request: &SetupRequest,
    artifacts: &mut ensemble_core::config::setup::SetupArtifacts,
    declined: &OverwritePlan,
) {
    artifacts.templates.retain(|template_path, _| {
        !declined
            .template_prompts
            .iter()
            .any(|existing| existing == &config_dir.join(template_path))
    });

    if declined.env_prompt.is_some() {
        artifacts.env_file = None;
    }

    if let (Some(_), SetupTracker::TodoFile { path }) = (&declined.todo_prompt, &request.tracker) {
        if let Ok(todo_path) = resolve_tracker_output_path(path, config_dir) {
            if declined.todo_prompt.as_ref() == Some(&todo_path) {
                artifacts.todo_md = None;
            }
        }
    }
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
            model: None,
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
            api_token: None,
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
                model: None,
            },
            AgentEntry {
                role: "reviewer".to_string(),
                acpx_agent: "codex".to_string(),
                model: None,
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

    #[test]
    fn test_generate_yaml_with_model() {
        let tracker = TrackerChoice::TodoFile {
            path: PathBuf::from("TODO.md"),
        };
        let agents = vec![AgentEntry {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
            model: Some("sonnet".to_string()),
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
        assert!(yaml.contains("prompt_template: templates/implement.liquid"));
    }

    #[test]
    fn test_generate_yaml_default_model_treated_as_none() {
        // When users pick "default" in the model selector, agents.rs stores None.
        // This test documents that None means "omit from YAML" (agent uses its default).
        let agents = vec![AgentEntry {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
            model: None, // "default" selection becomes None
        }];
        let steps = vec![PipelineStep {
            name: "implement".to_string(),
            agent_role: "builder".to_string(),
            depends: vec![],
            tracker_state: None,
        }];
        let tracker = TrackerChoice::TodoFile {
            path: PathBuf::from("TODO.md"),
        };
        let yaml = generate_yaml(&tracker, &[], &agents, &steps, "Done", "Failed");
        assert!(
            !yaml.contains("model:"),
            "None model should not appear in YAML"
        );
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
    }

    #[test]
    fn test_plan_overwrites_checks_existing_template_and_env_before_writing() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmpdir.path().join("templates")).unwrap();
        std::fs::write(tmpdir.path().join("templates/build.liquid"), "existing").unwrap();
        std::fs::write(tmpdir.path().join(".env"), "TOKEN=old\n").unwrap();

        let request = SetupRequest {
            tracker: SetupTracker::GitHub {
                repository: "acme/repo".to_string(),
                project_number: None,
                api_key_env: "GITHUB_TOKEN".to_string(),
                api_token: Some("secret".to_string()),
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
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = build_setup_artifacts(&request);

        let plan = plan_overwrites(tmpdir.path(), &request, &artifacts);

        assert_eq!(
            plan.template_prompts,
            vec![tmpdir.path().join("templates/build.liquid")]
        );
        assert_eq!(plan.env_prompt, Some(tmpdir.path().join(".env")));
        assert_eq!(plan.todo_prompt, None);
    }

    #[test]
    fn test_plan_overwrites_checks_existing_todo_target_before_writing() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(tmpdir.path().join("TODO.md"), "existing todo\n").unwrap();

        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("TODO.md"),
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: None,
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = build_setup_artifacts(&request);

        let plan = plan_overwrites(tmpdir.path(), &request, &artifacts);

        assert_eq!(plan.todo_prompt, Some(tmpdir.path().join("TODO.md")));
    }

    #[test]
    fn test_apply_declined_overwrites_skips_only_selected_artifacts() {
        let tmpdir = tempfile::tempdir().unwrap();
        let request = SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: PathBuf::from("TODO.md"),
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: None,
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let mut artifacts = build_setup_artifacts(&request);
        artifacts.env_file = Some("GITHUB_TOKEN=secret\n".to_string());

        let declined = OverwritePlan {
            template_prompts: vec![tmpdir.path().join("templates/build.liquid")],
            env_prompt: None,
            todo_prompt: Some(tmpdir.path().join("TODO.md")),
        };

        apply_declined_overwrites(tmpdir.path(), &request, &mut artifacts, &declined);

        assert!(artifacts.templates.is_empty());
        assert!(artifacts.todo_md.is_none());
        assert!(artifacts.env_file.is_some());
    }
}
