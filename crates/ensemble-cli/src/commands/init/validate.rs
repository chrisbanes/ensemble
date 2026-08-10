use crate::commands::init::agents::AgentEntry;
use crate::commands::init::pipeline::PipelineStep;
use crate::commands::init::repos::RepoEntry;
use crate::commands::init::tracker::TrackerChoice;
use ensemble_core::config::setup::{run_setup_checks, SetupRequest, SetupTracker};

fn validation_request(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
) -> SetupRequest {
    let mut setup_tracker: SetupTracker = tracker.into();
    if let SetupTracker::GitHub { api_token, .. } = &mut setup_tracker {
        *api_token = None;
    }

    SetupRequest {
        tracker: setup_tracker,
        repos: repos.iter().map(Into::into).collect(),
        agents: agents.iter().map(Into::into).collect(),
        steps: steps.iter().map(Into::into).collect(),
        on_success: "Done".to_string(),   // Not used by checks
        on_failure: "Failed".to_string(), // Not used by checks
    }
}

pub async fn run_validation(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
) -> Result<bool, inquire::InquireError> {
    println!("\nValidating configuration...\n");

    let request = validation_request(tracker, repos, agents, steps);

    // Run the shared setup checks
    let checks = run_setup_checks(&request).await;

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

#[cfg(test)]
mod tests {
    use super::*;
    use ensemble_core::config::secrets::{SecretDisplay, SecretEdit};
    use std::path::PathBuf;

    #[test]
    fn validation_request_uses_shared_conversions_and_omits_github_token() {
        let tracker = TrackerChoice::GitHub {
            repository: "acme/frontend".to_string(),
            project_number: Some(42),
            status_field: Some("Delivery state".to_string()),
            api_key_env: "GITHUB_TOKEN".to_string(),
            api_token: Some("secret".to_string()),
            active_states: vec!["Todo".to_string()],
            terminal_states: vec!["Done".to_string()],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let repos = vec![RepoEntry {
            path: PathBuf::from("/tmp/repo-a"),
            branch: "main".to_string(),
        }];
        let agents = vec![AgentEntry {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
            model: Some("sonnet".to_string()),
        }];
        let steps = vec![PipelineStep {
            name: "implement".to_string(),
            agent_role: "builder".to_string(),
            kind: None,
            depends: None,
            tracker_state: Some("In Progress".to_string()),
        }];

        let request = validation_request(&tracker, &repos, &agents, &steps);

        assert_eq!(request.repos.len(), 1);
        assert_eq!(request.repos[0].path, PathBuf::from("/tmp/repo-a"));
        assert_eq!(request.repos[0].branch, "main");
        assert_eq!(request.agents.len(), 1);
        assert_eq!(request.agents[0].role, "builder");
        assert_eq!(request.agents[0].acpx_agent, "claude");
        assert_eq!(request.agents[0].model.as_deref(), Some("sonnet"));
        assert_eq!(request.agents[0].prompt, None);
        assert_eq!(request.agents[0].prompt_file, None);
        assert_eq!(request.steps.len(), 1);
        assert_eq!(request.steps[0].name, "implement");
        assert_eq!(request.steps[0].agent_role, "builder");
        assert_eq!(
            request.steps[0].tracker_state.as_deref(),
            Some("In Progress")
        );
        assert_eq!(request.on_success, "Done");
        assert_eq!(request.on_failure, "Failed");

        match request.tracker {
            SetupTracker::GitHub {
                repository,
                project_number,
                status_field,
                api_key,
                api_key_edit,
                api_token,
                active_states,
                terminal_states,
            } => {
                assert_eq!(repository, "acme/frontend");
                assert_eq!(project_number, Some(42));
                assert_eq!(status_field.as_deref(), Some("Delivery state"));
                assert_eq!(
                    api_key,
                    SecretDisplay::Environment {
                        variable: "GITHUB_TOKEN".to_string()
                    }
                );
                assert_eq!(
                    api_key_edit,
                    SecretEdit::SetEnvironment {
                        variable: "GITHUB_TOKEN".to_string()
                    }
                );
                assert_eq!(api_token, None);
                assert_eq!(active_states, vec!["Todo"]);
                assert_eq!(terminal_states, vec!["Done"]);
            }
            other => panic!("expected github tracker, got {other:?}"),
        }
    }
}
