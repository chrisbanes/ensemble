//! Shared conversions from CLI init types to `ensemble_core` setup types.
//!
//! These `From` impls eliminate the copy-pasted match arms in `generate.rs`
//! and `validate.rs`.

use crate::commands::init::agents::AgentEntry;
use crate::commands::init::pipeline::PipelineStep;
use crate::commands::init::repos::RepoEntry;
use crate::commands::init::tracker::TrackerChoice;
use ensemble_core::config::setup::{SetupAgent, SetupRepo, SetupStep, SetupTracker};

impl From<&TrackerChoice> for SetupTracker {
    fn from(choice: &TrackerChoice) -> Self {
        match choice {
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
        }
    }
}

impl From<&RepoEntry> for SetupRepo {
    fn from(entry: &RepoEntry) -> Self {
        SetupRepo {
            path: entry.path.clone(),
            branch: entry.branch.clone(),
        }
    }
}

impl From<&AgentEntry> for SetupAgent {
    fn from(entry: &AgentEntry) -> Self {
        SetupAgent {
            role: entry.role.clone(),
            acpx_agent: entry.acpx_agent.clone(),
            model: entry.model.clone(),
            reasoning_level: None,
            permission_mode: None,
            prompt: None,
            prompt_file: None,
        }
    }
}

impl From<&PipelineStep> for SetupStep {
    fn from(step: &PipelineStep) -> Self {
        SetupStep {
            name: step.name.clone(),
            agent_role: step.agent_role.clone(),
            kind: None,
            depends: step.depends.clone(),
            tracker_state: step.tracker_state.clone(),
        }
    }
}
