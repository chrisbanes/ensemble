use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::workspace::finalize::FinalizeMode;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_projection: Option<String>,
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

pub fn finalize_mode_name(mode: &FinalizeMode) -> &'static str {
    match mode {
        FinalizeMode::None => "none",
        FinalizeMode::Push => "push",
        FinalizeMode::PushAndPr => "push_and_pr",
    }
}

pub async fn collect_repo_artifact(
    repo: &str,
    worktree_path: &Path,
    base_branch: &str,
    finalize_mode: &FinalizeMode,
    finalize_status: &str,
) -> RepoArtifact {
    RepoArtifact {
        repo: repo.to_string(),
        worktree_path: worktree_path.display().to_string(),
        base_branch: base_branch.to_string(),
        branch: git_stdout(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap_or_default(),
        head_sha: git_stdout(worktree_path, &["rev-parse", "HEAD"]).await,
        changed_files: collect_changed_files(worktree_path).await,
        finalize_mode: finalize_mode_name(finalize_mode).to_string(),
        finalize_status: finalize_status.to_string(),
        pushed_ref: None,
        pr_number: None,
        pr_url: None,
        review_state: None,
        review_projection: None,
        last_error: None,
    }
}

async fn collect_changed_files(worktree_path: &Path) -> Vec<String> {
    let Some(output) = git_stdout(worktree_path, &["status", "--porcelain=v1"]).await else {
        return Vec::new();
    };

    let mut files: Vec<String> = output
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .collect();
    files.sort();
    files.dedup();
    files
}

async fn git_stdout(worktree_path: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn collect_repo_artifact_records_none_mode_repo_state() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        tokio::fs::create_dir_all(repo.join("src")).await.unwrap();
        run_git(&repo, &["init"]).await;
        run_git(&repo, &["config", "user.email", "test@example.com"]).await;
        run_git(&repo, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(repo.join("src/lib.rs"), "pub fn value() -> i32 { 1 }\n")
            .await
            .unwrap();
        run_git(&repo, &["add", "."]).await;
        run_git(&repo, &["commit", "-m", "initial"]).await;
        run_git(&repo, &["checkout", "-b", "ensemble/repo-1"]).await;
        tokio::fs::write(repo.join("src/lib.rs"), "pub fn value() -> i32 { 2 }\n")
            .await
            .unwrap();

        let artifact =
            collect_repo_artifact("repo", &repo, "main", &FinalizeMode::None, "not_required").await;

        assert_eq!(artifact.repo, "repo");
        assert_eq!(artifact.branch, "ensemble/repo-1");
        assert_eq!(artifact.finalize_mode, "none");
        assert_eq!(artifact.finalize_status, "not_required");
        assert!(artifact.head_sha.is_some());
        assert_eq!(artifact.changed_files, vec!["src/lib.rs"]);
    }

    async fn run_git(repo: &std::path::Path, args: &[&str]) {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
