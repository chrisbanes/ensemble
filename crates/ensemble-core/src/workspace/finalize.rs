use serde::{Deserialize, Serialize};

fn default_finalize_enabled() -> bool {
    true
}

/// Finalization action to run for a repository after pipeline success.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeMode {
    /// Do not run finalization actions for this repository.
    #[default]
    None,
    /// Push the issue branch to remote.
    Push,
    /// Push the issue branch and create a pull request.
    PushAndPr,
}

/// Per-repository finalization policy.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RepoFinalizeConfig {
    #[serde(default = "default_finalize_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub mode: FinalizeMode,
    #[serde(default)]
    pub approval_required: bool,
}

impl Default for RepoFinalizeConfig {
    fn default() -> Self {
        Self {
            enabled: default_finalize_enabled(),
            mode: FinalizeMode::None,
            approval_required: false,
        }
    }
}

