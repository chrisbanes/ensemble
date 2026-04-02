use crate::commands::init::agents::AgentEntry;
use crate::commands::init::pipeline::PipelineStep;
use crate::commands::init::repos::RepoEntry;
use crate::commands::init::tracker::TrackerChoice;
use ensemble_core::config::setup::{
    run_setup_checks, SetupAgent, SetupRepo, SetupRequest, SetupStep, SetupTracker,
};

pub async fn run_validation(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
) -> Result<bool, inquire::InquireError> {
    println!("\nValidating configuration...\n");

    // Convert CLI types to setup types
    let setup_tracker = match tracker {
        TrackerChoice::TodoFile { path } => SetupTracker::TodoFile { path: path.clone() },
        TrackerChoice::GitHub {
            repository,
            project_number,
            api_key_env,
            active_states,
            terminal_states,
            ..
        } => SetupTracker::GitHub {
            repository: repository.clone(),
            project_number: *project_number,
            api_key_env: api_key_env.clone(),
            api_token: None, // Token is handled separately
            active_states: active_states.clone(),
            terminal_states: terminal_states.clone(),
        },
    };

    let setup_repos: Vec<SetupRepo> = repos
        .iter()
        .map(|r| SetupRepo {
            path: r.path.clone(),
            branch: r.branch.clone(),
        })
        .collect();

    let setup_agents: Vec<SetupAgent> = agents
        .iter()
        .map(|a| SetupAgent {
            role: a.role.clone(),
            acpx_agent: a.acpx_agent.clone(),
            model: a.model.clone(),
        })
        .collect();

    let setup_steps: Vec<SetupStep> = steps
        .iter()
        .map(|s| SetupStep {
            name: s.name.clone(),
            agent_role: s.agent_role.clone(),
            depends: s.depends.clone(),
            tracker_state: s.tracker_state.clone(),
        })
        .collect();

    let request = SetupRequest {
        tracker: setup_tracker,
        repos: setup_repos,
        agents: setup_agents,
        steps: setup_steps,
        on_success: "Done".to_string(),   // Not used by checks
        on_failure: "Failed".to_string(), // Not used by checks
    };

    // Run the shared setup checks
    let checks = run_setup_checks(&request);

    let mut failures = 0;
    for check in &checks {
        let icon = if check.passed { "✓" } else { "✗" };
        println!("  {icon} {:<16} {}", check.label, check.detail);
        if !check.passed {
            failures += 1;
        }
    }

    println!();

    if failures == 0 {
        println!("All checks passed! ✓\n");
        return Ok(true);
    }

    println!("{failures} check(s) failed.");

    inquire::Confirm::new("Write config anyway?")
        .with_default(false)
        .prompt()
}
