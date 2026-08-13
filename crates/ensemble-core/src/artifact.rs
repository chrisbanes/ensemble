//! Durable, content-free Artifact snapshot identities captured at producer boundaries.

use std::collections::BTreeMap;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::ensemble::ArtifactSnapshotConfig;

#[cfg(test)]
struct CaptureAfterHeadHook {
    worktree: PathBuf,
    reached: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
static CAPTURE_AFTER_HEAD_HOOK: OnceLock<Mutex<Option<CaptureAfterHeadHook>>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn pause_capture_after_head(
    worktree: PathBuf,
    reached: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::Arc<tokio::sync::Semaphore>,
) {
    *CAPTURE_AFTER_HEAD_HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CaptureAfterHeadHook {
        worktree,
        reached,
        resume,
    });
}

#[cfg(test)]
async fn pause_capture_after_head_if_configured(worktree: &Path) {
    let hook = {
        let mut slot = CAPTURE_AFTER_HEAD_HOOK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.as_ref().is_some_and(|hook| hook.worktree == worktree) {
            slot.take()
        } else {
            None
        }
    };
    if let Some(hook) = hook {
        let _ = hook.reached.send(());
        hook.resume.acquire().await.unwrap().forget();
    }
}

/// One immutable producer identity exposed to later pipeline steps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ArtifactSnapshot {
    pub identity: String,
    pub run_id: String,
    pub cycle: u32,
    pub producer_step: String,
    pub attempt: u32,
    pub output_digest: String,
    pub repositories: Vec<ArtifactRepositoryObservation>,
}

/// Content-free Git state observed for a configured repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ArtifactRepositoryObservation {
    pub repository: String,
    pub head: String,
    pub index_digest: String,
    pub tracked_worktree_digest: String,
    pub untracked_paths: Vec<String>,
}

/// Capture every configured repository atomically: no snapshot is returned unless all observations succeed.
pub async fn capture(
    run_id: &str,
    cycle: u32,
    producer_step: &str,
    attempt: u32,
    output: &serde_json::Value,
    selection: &ArtifactSnapshotConfig,
    repositories: &BTreeMap<String, std::path::PathBuf>,
) -> Result<ArtifactSnapshot, String> {
    let output_digest =
        digest_bytes(&serde_json::to_vec(output).map_err(|error| error.to_string())?);
    let mut observations = Vec::with_capacity(selection.repositories.len());
    for key in &selection.repositories {
        let path = repositories
            .get(key)
            .ok_or_else(|| format!("configured repository '{key}' has no prepared worktree"))?;
        observations.push(observe_repository(key, path).await?);
    }
    observations.sort_by(|left, right| left.repository.cmp(&right.repository));
    let identity_input = serde_json::json!({
        "run_id": run_id,
        "cycle": cycle,
        "producer_step": producer_step,
        "attempt": attempt,
        "output_digest": output_digest,
        "repositories": observations,
    });
    let identity =
        digest_bytes(&serde_json::to_vec(&identity_input).map_err(|error| error.to_string())?);
    Ok(ArtifactSnapshot {
        identity,
        run_id: run_id.to_string(),
        cycle,
        producer_step: producer_step.to_string(),
        attempt,
        output_digest,
        repositories: observations,
    })
}

async fn observe_repository(
    repository: &str,
    worktree: &Path,
) -> Result<ArtifactRepositoryObservation, String> {
    let head = git_stdout(worktree, &["rev-parse", "HEAD"]).await?;
    #[cfg(test)]
    pause_capture_after_head_if_configured(worktree).await;
    let index = git_stdout(worktree, &["ls-files", "-s"]).await?;
    let staged = git_stdout(worktree, &["diff", "--cached", "--raw", "--no-ext-diff"]).await?;
    let unstaged = git_stdout(worktree, &["diff", "--binary", "--no-ext-diff"]).await?;
    let mut untracked_paths: Vec<String> =
        git_stdout(worktree, &["ls-files", "--others", "--exclude-standard"])
            .await?
            .lines()
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    untracked_paths.sort();
    untracked_paths.dedup();
    Ok(ArtifactRepositoryObservation {
        repository: repository.to_string(),
        head,
        index_digest: digest_bytes(index.as_bytes()),
        tracked_worktree_digest: digest_bytes(format!("{staged}\n{unstaged}").as_bytes()),
        untracked_paths,
    })
}

pub(crate) async fn git_stdout(worktree: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(worktree)
        .output()
        .await
        .map_err(|error| format!("git {} failed to start: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn capture_is_deterministic_and_excludes_ignored_paths() {
        let dir = initialized_repository().await;
        tokio::fs::write(dir.path().join("visible.txt"), "visible")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("ignored.out"), "ignored")
            .await
            .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };

        let first = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({"ok": true}),
            &selection,
            &repositories,
        )
        .await
        .unwrap();
        let second = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({"ok": true}),
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        assert_eq!(first, second);
        assert_eq!(first.repositories[0].untracked_paths, vec!["visible.txt"]);
    }

    #[tokio::test]
    async fn capture_changes_identity_when_tracked_worktree_bytes_change() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };

        tokio::fs::write(dir.path().join("tracked.txt"), "first change\n")
            .await
            .unwrap();
        let first = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(dir.path().join("tracked.txt"), "second change\n")
            .await
            .unwrap();
        let second = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        assert_ne!(first.identity, second.identity);
        assert_ne!(
            first.repositories[0].tracked_worktree_digest,
            second.repositories[0].tracked_worktree_digest
        );
    }

    #[tokio::test]
    async fn capture_does_not_publish_partial_snapshot_when_any_repository_fails() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([
            ("good".to_string(), dir.path().to_path_buf()),
            ("missing".to_string(), dir.path().join("missing")),
        ]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["good".to_string(), "missing".to_string()],
        };

        let error = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &selection,
            &repositories,
        )
        .await
        .unwrap_err();

        assert!(error.contains("git rev-parse HEAD"), "{error}");
    }

    async fn initialized_repository() -> TempDir {
        let dir = TempDir::new().unwrap();
        run_git(dir.path(), &["init"]).await;
        run_git(dir.path(), &["config", "user.email", "test@example.com"]).await;
        run_git(dir.path(), &["config", "user.name", "Test User"]).await;
        tokio::fs::write(dir.path().join(".gitignore"), "ignored.out\n")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("tracked.txt"), "tracked\n")
            .await
            .unwrap();
        run_git(dir.path(), &["add", "."]).await;
        run_git(dir.path(), &["commit", "-m", "initial"]).await;
        dir
    }

    async fn run_git(dir: &Path, args: &[&str]) {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
