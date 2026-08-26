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

/// The policy for completing a retained pull request after delivery observes it.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case", tag = "mode")]
pub enum DeliveryMergeConfig {
    /// Keep the pull request under observation for a human to merge.
    #[default]
    Manual,
    /// Merge an eligible pull request directly using the configured method.
    Auto { method: DeliveryMergeMethod },
    /// Admit an eligible pull request to the repository merge queue.
    MergeQueue,
}

/// GitHub merge method frozen with a direct automatic merge intent.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl DeliveryMergeConfig {
    pub fn is_automatic(&self) -> bool {
        !matches!(self, Self::Manual)
    }
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
    /// Optional retained pull-request completion policy. Defaults to manual observation.
    #[serde(default)]
    pub merge: DeliveryMergeConfig,
}

impl Default for RepoFinalizeConfig {
    fn default() -> Self {
        Self {
            enabled: default_finalize_enabled(),
            mode: FinalizeMode::None,
            approval_required: false,
            merge: DeliveryMergeConfig::Manual,
        }
    }
}
