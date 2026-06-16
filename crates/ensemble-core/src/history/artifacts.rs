use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RunArtifacts {
    pub run_id: String,
    pub workspace_path: String,
    pub repos: Vec<RepoArtifact>,
    pub transcripts: Vec<StepTranscriptArtifact>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RepoArtifact {
    pub repo: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub branch: String,
    pub head_sha: Option<String>,
    pub changed_files: Vec<String>,
    pub finalize_mode: String,
    pub finalize_status: String,
    pub pushed_ref: Option<String>,
    pub pr_url: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct StepTranscriptArtifact {
    pub step_name: String,
    pub run_id: String,
    pub record_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FinalizeActionOutput {
    pub pushed_ref: Option<String>,
    pub pr_url: Option<String>,
}
