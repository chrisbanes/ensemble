//! Durable, content-free Artifact snapshot identities captured at producer boundaries.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::ensemble::ArtifactSnapshotConfig;

const MAX_REPORTED_CHANGED_PATHS: usize = 100;
const MISSING_ARTIFACT_PATH_DIGEST: &str = "missing-artifact-path-v1";
const RAW_PATH_PREFIX: &str = "raw-bytes:";
const MAX_ARTIFACT_DIRECTORY_DEPTH: usize = 64;

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
    /// Instant at which the immutable producer evidence was captured. Older
    /// snapshots intentionally deserialize without this proof.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<DateTime<Utc>>,
    pub repositories: Vec<ArtifactRepositoryObservation>,
}

/// Content-free Git state observed for a configured repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ArtifactRepositoryObservation {
    pub repository: String,
    pub head: String,
    pub index_digest: String,
    /// Per-path content-free index identities, including skip-worktree and assume-unchanged flags.
    #[serde(default)]
    pub tracked_index_entries: BTreeMap<String, String>,
    pub tracked_worktree_digest: String,
    /// Repository-relative tracked paths with staged or unstaged changes.
    #[serde(default)]
    pub tracked_paths: Vec<String>,
    /// Per-path content-free digests of every tracked worktree entry.
    /// Missing values from older snapshots intentionally fall back to Git's conservative diff.
    #[serde(default)]
    pub tracked_path_digests: BTreeMap<String, String>,
    pub untracked_paths: Vec<String>,
    /// Content-free digest of the non-ignored untracked path bytes and modes.
    #[serde(default)]
    pub untracked_digest: String,
    /// Per-path content-free digests used only to identify the bounded changed-path evidence.
    /// Missing values from older snapshots intentionally fall back to conservative path union.
    #[serde(default)]
    pub untracked_path_digests: BTreeMap<String, String>,
}

/// Content-free evidence that an immutable Artifact input no longer matches its producer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ArtifactIntegrityViolation {
    pub consumer_step: String,
    pub producer_step: String,
    pub artifact_identity: String,
    pub repository: String,
    pub expected_digest: String,
    pub observed_digest: String,
    /// Deterministically ordered repository-relative paths involved in the drift.
    pub changed_paths: Vec<String>,
    /// Number of changed paths omitted after the bounded diagnostic prefix.
    pub omitted_changed_path_count: usize,
}

/// Runtime permission treatment recorded for an immutable Artifact consumer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactAccessEnforcement {
    AcpxApproveReads,
    AcpxDenyAll,
    DirectAcpUnsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ArtifactAccessEvidence {
    pub consumer_step: String,
    pub enforcement: ArtifactAccessEnforcement,
}

/// Re-observe every repository selected by immutable Artifact inputs.
///
/// The comparison intentionally contains no repository contents or local paths. A failed
/// observation is fail-closed because Ensemble cannot prove the producer state remains intact.
pub async fn verify_immutable_inputs(
    consumer_step: &str,
    snapshots: &[ArtifactSnapshot],
    repositories: &BTreeMap<String, std::path::PathBuf>,
) -> Result<Vec<ArtifactIntegrityViolation>, String> {
    let mut violations = Vec::new();
    for snapshot in snapshots {
        for expected in &snapshot.repositories {
            let worktree = repositories.get(&expected.repository).ok_or_else(|| {
                format!(
                    "configured repository '{}' has no prepared worktree",
                    expected.repository
                )
            })?;
            let observed = observe_repository(&expected.repository, worktree)
                .await
                .map_err(|_| "could not observe immutable Artifact input".to_string())?;
            if &observed != expected {
                let (changed_paths, omitted_changed_path_count) =
                    changed_paths(worktree, expected, &observed).await?;
                violations.push(ArtifactIntegrityViolation {
                    consumer_step: consumer_step.to_string(),
                    producer_step: snapshot.producer_step.clone(),
                    artifact_identity: snapshot.identity.clone(),
                    repository: expected.repository.clone(),
                    expected_digest: observation_digest(expected),
                    observed_digest: observation_digest(&observed),
                    changed_paths,
                    omitted_changed_path_count,
                });
            }
        }
    }
    violations.sort_by(|left, right| {
        (&left.producer_step, &left.repository).cmp(&(&right.producer_step, &right.repository))
    });
    Ok(violations)
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
        captured_at: Some(Utc::now()),
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
    // `-v` includes the skip-worktree and assume-unchanged index flags; without it, those
    // flags can make Git's diff view omit changed worktree bytes from an observation.
    let index = git_stdout_bytes(worktree, &["ls-files", "--stage", "-v", "-z"]).await?;
    let tracked_index_entries = git_index_entries(&index)?;
    let gitlink_paths = gitlink_path_bytes(&index)?;
    let mut tracked_paths = git_nul_paths(
        worktree,
        &[
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--no-ext-diff",
            "--no-renames",
        ],
    )
    .await?;
    tracked_paths.extend(
        git_nul_paths(
            worktree,
            &["diff", "--name-only", "-z", "--no-ext-diff", "--no-renames"],
        )
        .await?,
    );
    tracked_paths.sort();
    tracked_paths.dedup();
    let tracked_worktree_paths = git_nul_path_bytes(worktree, &["ls-files", "-z"]).await?;
    let tracked_path_digests =
        tracked_path_digests(worktree, &tracked_worktree_paths, &gitlink_paths).await?;
    let untracked_path_bytes = git_nul_path_bytes(
        worktree,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .await?;
    let untracked_paths = untracked_path_bytes
        .iter()
        .map(|path| artifact_path_display(path))
        .collect();
    let untracked_path_digests = path_digests(worktree, &untracked_path_bytes, "untracked").await?;
    let untracked_digest = digest_path_digests(&untracked_path_digests);
    Ok(ArtifactRepositoryObservation {
        repository: repository.to_string(),
        head,
        index_digest: digest_bytes(&index),
        tracked_index_entries,
        tracked_worktree_digest: digest_path_digests(&tracked_path_digests),
        tracked_paths,
        tracked_path_digests,
        untracked_paths,
        untracked_digest,
        untracked_path_digests,
    })
}

async fn tracked_path_digests(
    worktree: &Path,
    paths: &[Vec<u8>],
    gitlink_paths: &BTreeSet<Vec<u8>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut digests = BTreeMap::new();
    for path in paths {
        let digest = if gitlink_paths.contains(path) {
            gitlink_path_digest(worktree, path).await?
        } else {
            path_digest(worktree, path, "tracked").await?
        }
        .unwrap_or_else(|| MISSING_ARTIFACT_PATH_DIGEST.to_string());
        digests.insert(artifact_path_display(path), digest);
    }
    Ok(digests)
}

async fn path_digests(
    worktree: &Path,
    paths: &[Vec<u8>],
    path_kind: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut digests = BTreeMap::new();
    for path in paths {
        let digest = path_digest(worktree, path, path_kind)
            .await?
            .unwrap_or_else(|| MISSING_ARTIFACT_PATH_DIGEST.to_string());
        digests.insert(artifact_path_display(path), digest);
    }
    Ok(digests)
}

fn digest_path_digests(path_digests: &BTreeMap<String, String>) -> String {
    let mut digest = Sha256::new();
    for (relative_path, path_digest) in path_digests {
        digest.update(relative_path.as_bytes());
        digest.update([0]);
        digest.update(path_digest.as_bytes());
    }
    hex::encode(digest.finalize())
}

#[cfg(unix)]
async fn gitlink_path_digest(
    worktree: &Path,
    relative_path: &[u8],
) -> Result<Option<String>, String> {
    let worktree = worktree.to_path_buf();
    let relative_path = relative_path.to_vec();
    tokio::task::spawn_blocking(move || {
        let Some(entry) = open_worktree_path(&worktree, &relative_path, "tracked")? else {
            return Ok(None);
        };
        let OpenedArtifactPath::Directory {
            len,
            mode,
            directory,
        } = entry
        else {
            return Err("could not safely inspect tracked Artifact gitlink".to_string());
        };
        let mut digest = Sha256::new();
        digest.update(len.to_le_bytes());
        digest.update(mode.to_le_bytes());
        digest_directory_filtered(&mut digest, directory, "tracked", 0, &[], &[])?;
        Ok(Some(hex::encode(digest.finalize())))
    })
    .await
    .map_err(|error| format!("Artifact gitlink digest task failed: {error}"))?
}

#[cfg(not(unix))]
async fn gitlink_path_digest(
    _worktree: &Path,
    _relative_path: &[u8],
) -> Result<Option<String>, String> {
    Err(
        "tracked Artifact gitlinks require descriptor-bound Git observation on this platform"
            .to_string(),
    )
}

#[cfg(unix)]
enum OpenedArtifactPath {
    Symlink {
        len: u64,
        mode: u32,
        target: Vec<u8>,
    },
    Regular {
        len: u64,
        mode: u32,
        file: std::fs::File,
    },
    Directory {
        len: u64,
        mode: u32,
        directory: std::os::fd::OwnedFd,
    },
    Other {
        len: u64,
        mode: u32,
    },
}

#[cfg(unix)]
async fn path_digest(
    worktree: &Path,
    relative_path: &[u8],
    path_kind: &str,
) -> Result<Option<String>, String> {
    let worktree = worktree.to_path_buf();
    let relative_path = relative_path.to_vec();
    let path_kind = path_kind.to_string();
    tokio::task::spawn_blocking(move || path_digest_blocking(&worktree, &relative_path, &path_kind))
        .await
        .map_err(|error| format!("Artifact path digest task failed: {error}"))?
}

#[cfg(unix)]
fn path_digest_blocking(
    worktree: &Path,
    relative_path: &[u8],
    path_kind: &str,
) -> Result<Option<String>, String> {
    let ancestor_matchers = if path_kind == "untracked" {
        ancestor_ignore_matchers(worktree, relative_path, path_kind)?
    } else {
        Vec::new()
    };
    let Some(entry) = open_worktree_path(worktree, relative_path, path_kind)? else {
        return Ok(None);
    };
    let mut digest = Sha256::new();
    match entry {
        OpenedArtifactPath::Symlink { len, mode, target } => {
            digest.update(len.to_le_bytes());
            digest.update(mode.to_le_bytes());
            digest.update(target);
        }
        OpenedArtifactPath::Regular { len, mode, file } => {
            digest.update(len.to_le_bytes());
            digest.update(mode.to_le_bytes());
            digest_regular_file(&mut digest, file, path_kind)?;
        }
        OpenedArtifactPath::Directory {
            len,
            mode,
            directory,
        } => {
            digest.update(len.to_le_bytes());
            digest.update(mode.to_le_bytes());
            digest_directory_filtered(
                &mut digest,
                directory,
                path_kind,
                0,
                relative_path,
                &ancestor_matchers,
            )?;
        }
        OpenedArtifactPath::Other { len, mode } => {
            digest.update(len.to_le_bytes());
            digest.update(mode.to_le_bytes());
        }
    }
    Ok(Some(hex::encode(digest.finalize())))
}

#[cfg(not(unix))]
async fn path_digest(
    worktree: &Path,
    relative_path: &[u8],
    path_kind: &str,
) -> Result<Option<String>, String> {
    let relative_path = std::str::from_utf8(relative_path)
        .map_err(|_| "could not inspect non-UTF-8 Artifact path on this platform".to_string())?;
    let worktree = worktree.to_path_buf();
    let relative_path = relative_path.to_string();
    let path_kind = path_kind.to_string();
    tokio::task::spawn_blocking(move || {
        path_digest_blocking(&worktree, Path::new(&relative_path), &path_kind)
    })
    .await
    .map_err(|error| format!("Artifact path digest task failed: {error}"))?
}

#[cfg(not(unix))]
fn path_digest_blocking(
    worktree: &Path,
    relative_path: &Path,
    path_kind: &str,
) -> Result<Option<String>, String> {
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use std::path::Component;

    let components = relative_path
        .components()
        .map(|component| match component {
            Component::Normal(component) => Ok(component),
            _ => Err(format!("invalid {path_kind} Artifact path")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (entry, parents) = components
        .split_last()
        .ok_or_else(|| format!("invalid {path_kind} Artifact path"))?;
    let mut directory = Dir::open_ambient_dir(worktree, ambient_authority()).map_err(|error| {
        format!("could not safely inspect {path_kind} Artifact worktree: {error}")
    })?;
    for parent in parents {
        let file = match open_nofollow(&directory, parent) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "could not safely inspect {path_kind} Artifact path: {error}"
                ));
            }
        };
        if !file
            .metadata()
            .map_err(|error| format!("could not inspect {path_kind} Artifact path: {error}"))?
            .is_dir()
        {
            return Err(format!(
                "could not safely inspect {path_kind} Artifact path"
            ));
        }
        directory = Dir::from_std_file(file.into_std());
    }
    let metadata = match directory.symlink_metadata(entry) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not inspect {path_kind} Artifact path: {error}"
            ));
        }
    };
    let mut digest = Sha256::new();
    digest.update(metadata.len().to_le_bytes());
    if metadata.file_type().is_symlink() {
        digest.update(
            read_link_contents_capability_safe(&directory, entry)
                .map_err(|error| format!("could not read {path_kind} Artifact symlink: {error}"))?
                .as_os_str()
                .as_encoded_bytes(),
        );
    } else if metadata.is_file() {
        digest_regular_file_non_unix(
            &mut digest,
            open_nofollow(&directory, entry).map_err(|error| {
                format!("could not safely inspect {path_kind} Artifact path: {error}")
            })?,
            path_kind,
        )?;
    } else if metadata.is_dir() {
        let directory = Dir::from_std_file(
            open_nofollow(&directory, entry)
                .map_err(|error| {
                    format!("could not safely inspect {path_kind} Artifact path: {error}")
                })?
                .into_std(),
        );
        digest_directory_non_unix(&mut digest, directory, path_kind, 0)?;
    }
    Ok(Some(hex::encode(digest.finalize())))
}

#[cfg(not(unix))]
fn open_nofollow(
    directory: &cap_std::fs::Dir,
    path: &std::ffi::OsStr,
) -> std::io::Result<cap_std::fs::File> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::fs::OpenOptions;

    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    directory.open_with(path, &options)
}

#[cfg(any(not(unix), test))]
fn read_link_contents_capability_safe(
    directory: &cap_std::fs::Dir,
    path: &std::ffi::OsStr,
) -> std::io::Result<std::path::PathBuf> {
    directory.read_link_contents(path)
}

#[cfg(not(unix))]
fn digest_regular_file_non_unix(
    digest: &mut Sha256,
    file: cap_std::fs::File,
    path_kind: &str,
) -> Result<(), String> {
    let mut file = file;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read {path_kind} Artifact path: {error}"))?;
        if read == 0 {
            return Ok(());
        }
        digest.update(&buffer[..read]);
    }
}

#[cfg(not(unix))]
fn digest_directory_non_unix(
    digest: &mut Sha256,
    directory: cap_std::fs::Dir,
    path_kind: &str,
    depth: usize,
) -> Result<(), String> {
    if depth >= MAX_ARTIFACT_DIRECTORY_DEPTH {
        return Err(format!(
            "{path_kind} Artifact directory exceeds the traversal depth bound"
        ));
    }
    match directory.symlink_metadata(".git") {
        Ok(_) => {
            return Err(
                "embedded Git repositories require descriptor-bound Git observation on this platform"
                    .to_string(),
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "could not inspect embedded Git repository: {error}"
            ));
        }
    }
    let mut entries = directory
        .read_dir(".")
        .map_err(|error| format!("could not read {path_kind} Artifact directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("could not read {path_kind} Artifact directory: {error}"))?;
    entries.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for entry in entries {
        let name = entry.file_name();
        let metadata = entry.metadata().map_err(|error| {
            format!("could not inspect {path_kind} Artifact directory entry: {error}")
        })?;
        digest.update((name.as_encoded_bytes().len() as u64).to_le_bytes());
        digest.update(name.as_encoded_bytes());
        digest.update(metadata.len().to_le_bytes());
        if entry
            .file_type()
            .map_err(|error| {
                format!("could not inspect {path_kind} Artifact directory entry: {error}")
            })?
            .is_symlink()
        {
            digest.update([0]);
            digest.update(
                read_link_contents_capability_safe(&directory, &name)
                    .map_err(|error| {
                        format!("could not read {path_kind} Artifact symlink: {error}")
                    })?
                    .as_os_str()
                    .as_encoded_bytes(),
            );
        } else if metadata.is_file() {
            digest.update([1]);
            digest_regular_file_non_unix(
                digest,
                open_nofollow(&directory, &name).map_err(|error| {
                    format!("could not safely inspect {path_kind} Artifact path: {error}")
                })?,
                path_kind,
            )?;
        } else if metadata.is_dir() {
            digest.update([2]);
            digest_directory_non_unix(
                digest,
                cap_std::fs::Dir::from_std_file(
                    open_nofollow(&directory, &name)
                        .map_err(|error| {
                            format!("could not safely inspect {path_kind} Artifact path: {error}")
                        })?
                        .into_std(),
                ),
                path_kind,
                depth + 1,
            )?;
        } else {
            digest.update([3]);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_worktree_path(
    worktree: &Path,
    relative_path: &[u8],
    path_kind: &str,
) -> Result<Option<OpenedArtifactPath>, String> {
    use rustix::fs::{open, openat, readlinkat, statat, AtFlags, FileType, Mode, OFlags};
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    let components = Path::new(OsStr::from_bytes(relative_path))
        .components()
        .map(|component| match component {
            Component::Normal(component) => Ok(component),
            _ => Err(format!("invalid {path_kind} Artifact path")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (entry, parents) = components
        .split_last()
        .ok_or_else(|| format!("invalid {path_kind} Artifact path"))?;
    let mut directory = open(
        worktree,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| format!("could not safely inspect {path_kind} Artifact worktree: {error}"))?;
    for parent in parents {
        directory = match openat(
            &directory,
            *parent,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(directory) => directory,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "could not safely inspect {path_kind} Artifact path: {error}"
                ));
            }
        };
    }
    let stat = match statat(&directory, *entry, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not inspect {path_kind} Artifact path: {error}"
            ));
        }
    };
    let len = stat.st_size as u64;
    let mode = stat.st_mode as u32;
    match FileType::from_raw_mode(stat.st_mode) {
        FileType::Symlink => Ok(Some(OpenedArtifactPath::Symlink {
            len,
            mode,
            target: readlinkat(&directory, *entry, Vec::new())
                .map_err(|error| format!("could not read {path_kind} Artifact symlink: {error}"))?
                .as_bytes()
                .to_vec(),
        })),
        FileType::RegularFile => {
            let file = openat(
                &directory,
                *entry,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| format!("could not safely read {path_kind} Artifact path: {error}"))?;
            Ok(Some(OpenedArtifactPath::Regular {
                len,
                mode,
                file: file.into(),
            }))
        }
        FileType::Directory => {
            let directory = openat(
                &directory,
                *entry,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| {
                format!("could not safely read {path_kind} Artifact directory: {error}")
            })?;
            Ok(Some(OpenedArtifactPath::Directory {
                len,
                mode,
                directory,
            }))
        }
        _ => Ok(Some(OpenedArtifactPath::Other { len, mode })),
    }
}

#[cfg(unix)]
fn digest_regular_file(
    digest: &mut Sha256,
    file: std::fs::File,
    path_kind: &str,
) -> Result<(), String> {
    let mut file = file;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read {path_kind} Artifact path: {error}"))?;
        if read == 0 {
            return Ok(());
        }
        digest.update(&buffer[..read]);
    }
}

#[cfg(unix)]
fn ancestor_ignore_matchers(
    worktree: &Path,
    relative_path: &[u8],
    path_kind: &str,
) -> Result<Vec<ignore::gitignore::Gitignore>, String> {
    use rustix::fs::{open, openat, Mode, OFlags};
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    let components = Path::new(OsStr::from_bytes(relative_path))
        .components()
        .map(|component| match component {
            Component::Normal(component) => Ok(component),
            _ => Err(format!("invalid {path_kind} Artifact path")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (_, parents) = components
        .split_last()
        .ok_or_else(|| format!("invalid {path_kind} Artifact path"))?;
    let mut directory = open(
        worktree,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| format!("could not safely inspect {path_kind} Artifact worktree: {error}"))?;
    let mut prefix = Vec::new();
    let mut matchers = Vec::new();
    if let Some(matcher) = local_ignore_matcher(&directory, &prefix, path_kind, false)? {
        matchers.push(matcher);
    }
    for parent in parents {
        directory = openat(
            &directory,
            *parent,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| format!("could not safely inspect {path_kind} Artifact path: {error}"))?;
        prefix.extend_from_slice(parent.as_bytes());
        prefix.push(b'/');
        let embedded_git = embedded_git_metadata(&directory, path_kind)?;
        if embedded_git.is_some() {
            prefix.clear();
            matchers.clear();
        }
        if let Some(matcher) = local_ignore_matcher(
            &directory,
            &prefix,
            path_kind,
            matches!(embedded_git, Some(EmbeddedGitMetadata::Directory)),
        )? {
            matchers.push(matcher);
        }
    }
    Ok(matchers)
}

#[cfg(unix)]
#[derive(Clone, Copy)]
enum EmbeddedGitMetadata {
    Directory,
    GitFile,
}

#[cfg(unix)]
fn embedded_git_metadata(
    directory: &std::os::fd::OwnedFd,
    path_kind: &str,
) -> Result<Option<EmbeddedGitMetadata>, String> {
    use rustix::fs::{openat, statat, AtFlags, FileType, Mode, OFlags};

    let metadata = match statat(directory, ".git", AtFlags::SYMLINK_NOFOLLOW) {
        Ok(metadata) => metadata,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not inspect {path_kind} embedded Git metadata: {error}"
            ));
        }
    };
    match FileType::from_raw_mode(metadata.st_mode) {
        FileType::Directory => {
            openat(
                directory,
                ".git",
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| {
                format!("could not safely inspect {path_kind} embedded Git metadata: {error}")
            })?;
            Ok(Some(EmbeddedGitMetadata::Directory))
        }
        FileType::RegularFile if path_kind == "tracked" => {
            openat(
                directory,
                ".git",
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| {
                format!("could not safely inspect tracked embedded Git metadata: {error}")
            })?;
            Ok(Some(EmbeddedGitMetadata::GitFile))
        }
        _ => Err(format!(
            "could not safely inspect {path_kind} embedded Git metadata"
        )),
    }
}

#[cfg(unix)]
fn optional_ignore_file(
    directory: &std::os::fd::OwnedFd,
    name: &[u8],
    path_kind: &str,
) -> Result<Option<String>, String> {
    use rustix::fs::{openat, statat, AtFlags, FileType, Mode, OFlags};

    let metadata = match statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(metadata) => metadata,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not inspect {path_kind} Artifact ignore file: {error}"
            ));
        }
    };
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(format!(
            "could not safely inspect {path_kind} Artifact ignore file"
        ));
    }
    let file = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| format!("could not safely read {path_kind} Artifact ignore file: {error}"))?;
    let mut contents = String::new();
    std::fs::File::from(file)
        .read_to_string(&mut contents)
        .map_err(|error| format!("could not read {path_kind} Artifact ignore file: {error}"))?;
    Ok(Some(contents))
}

#[cfg(unix)]
fn embedded_git_exclude_file(
    directory: &std::os::fd::OwnedFd,
    path_kind: &str,
) -> Result<Option<String>, String> {
    use rustix::fs::{openat, Mode, OFlags};

    let git_directory = openat(
        directory,
        ".git",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| {
        format!("could not safely inspect {path_kind} embedded Git metadata: {error}")
    })?;
    let info_directory = match openat(
        &git_directory,
        "info",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(directory) => directory,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not safely inspect {path_kind} embedded Git exclude metadata: {error}"
            ));
        }
    };
    optional_ignore_file(&info_directory, b"exclude", path_kind)
}

#[cfg(unix)]
fn local_ignore_matcher(
    directory: &std::os::fd::OwnedFd,
    prefix: &[u8],
    path_kind: &str,
    embedded_git: bool,
) -> Result<Option<ignore::gitignore::Gitignore>, String> {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let local = optional_ignore_file(directory, b".gitignore", path_kind)?;
    let repository_excludes = if embedded_git {
        embedded_git_exclude_file(directory, path_kind)?
    } else {
        None
    };
    if local.is_none() && repository_excludes.is_none() {
        return Ok(None);
    }
    let root = std::path::PathBuf::from(OsString::from_vec(prefix.to_vec()));
    let source = root.join(".gitignore");
    let mut builder = ignore::gitignore::GitignoreBuilder::new(&root);
    for contents in repository_excludes.into_iter().chain(local) {
        for line in contents.lines() {
            builder
                .add_line(Some(source.clone()), line)
                .map_err(|error| format!("invalid {path_kind} Artifact ignore rule: {error}"))?;
        }
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| format!("invalid {path_kind} Artifact ignore rules: {error}"))
}

#[cfg(unix)]
fn is_ignored(
    matchers: &[ignore::gitignore::Gitignore],
    relative_path: &[u8],
    is_dir: bool,
) -> bool {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let path = Path::new(OsStr::from_bytes(relative_path));
    matchers
        .iter()
        .rev()
        .map(|matcher| matcher.matched_path_or_any_parents(path, is_dir))
        .find(|matched| !matched.is_none())
        .is_some_and(|matched| matched.is_ignore())
}

#[cfg(unix)]
fn digest_directory_filtered(
    digest: &mut Sha256,
    directory: std::os::fd::OwnedFd,
    path_kind: &str,
    depth: usize,
    prefix: &[u8],
    matchers: &[ignore::gitignore::Gitignore],
) -> Result<(), String> {
    use rustix::fs::{openat, readlinkat, statat, AtFlags, Dir, FileType, Mode, OFlags};

    if depth >= MAX_ARTIFACT_DIRECTORY_DEPTH {
        return Err(format!(
            "{path_kind} Artifact directory exceeds the traversal depth bound"
        ));
    }
    let embedded_git = embedded_git_metadata(&directory, path_kind)?;
    let prefix = if embedded_git.is_some() {
        &[][..]
    } else {
        prefix
    };
    let mut matchers = if embedded_git.is_some() {
        Vec::new()
    } else {
        matchers.to_vec()
    };
    if let Some(matcher) = local_ignore_matcher(
        &directory,
        prefix,
        path_kind,
        matches!(embedded_git, Some(EmbeddedGitMetadata::Directory)),
    )? {
        matchers.push(matcher);
    }
    let mut names = Vec::new();
    let mut directory_reader = Dir::read_from(&directory)
        .map_err(|error| format!("could not read {path_kind} Artifact directory: {error}"))?;
    while let Some(entry) = directory_reader.read() {
        let name = entry
            .map_err(|error| format!("could not read {path_kind} Artifact directory: {error}"))?
            .file_name()
            .to_bytes()
            .to_vec();
        if name != b"." && name != b".." {
            names.push(name);
        }
    }
    names.sort();
    for name in names {
        if embedded_git.is_some() && name == b".git" {
            continue;
        }
        let mut relative_path = prefix.to_vec();
        relative_path.extend_from_slice(&name);
        let stat =
            statat(&directory, name.as_slice(), AtFlags::SYMLINK_NOFOLLOW).map_err(|error| {
                format!("could not inspect {path_kind} Artifact directory entry: {error}")
            })?;
        let kind = FileType::from_raw_mode(stat.st_mode);
        if kind.is_dir() {
            relative_path.push(b'/');
        }
        if is_ignored(&matchers, &relative_path, kind.is_dir()) {
            continue;
        }
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(&name);
        digest.update(stat.st_size.to_le_bytes());
        digest.update(stat.st_mode.to_le_bytes());
        if kind.is_symlink() {
            digest.update(
                readlinkat(&directory, name.as_slice(), Vec::new())
                    .map_err(|error| {
                        format!("could not read {path_kind} Artifact symlink: {error}")
                    })?
                    .as_bytes(),
            );
        } else if kind.is_file() {
            let file = openat(
                &directory,
                name.as_slice(),
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| format!("could not safely read {path_kind} Artifact path: {error}"))?;
            digest_regular_file(digest, file.into(), path_kind)?;
        } else if kind.is_dir() {
            let child = openat(
                &directory,
                name.as_slice(),
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| {
                format!("could not safely read {path_kind} Artifact directory: {error}")
            })?;
            digest_directory_filtered(
                digest,
                child,
                path_kind,
                depth + 1,
                &relative_path,
                &matchers,
            )?;
        }
    }
    Ok(())
}

async fn changed_paths(
    worktree: &Path,
    expected: &ArtifactRepositoryObservation,
    observed: &ArtifactRepositoryObservation,
) -> Result<(Vec<String>, usize), String> {
    let mut paths = expected
        .tracked_paths
        .iter()
        .chain(expected.untracked_paths.iter())
        .chain(observed.tracked_paths.iter())
        .chain(observed.untracked_paths.iter())
        .cloned()
        .collect::<Vec<_>>();
    remove_digest_covered_paths(
        &mut paths,
        &expected.tracked_index_entries,
        &observed.tracked_index_entries,
    );
    remove_digest_covered_paths(
        &mut paths,
        &expected.tracked_path_digests,
        &observed.tracked_path_digests,
    );
    remove_digest_covered_paths(
        &mut paths,
        &expected.untracked_path_digests,
        &observed.untracked_path_digests,
    );
    paths.extend(changed_digest_paths(
        &expected.tracked_index_entries,
        &observed.tracked_index_entries,
    ));
    paths.extend(changed_digest_paths(
        &expected.tracked_path_digests,
        &observed.tracked_path_digests,
    ));
    paths.extend(changed_digest_paths(
        &expected.untracked_path_digests,
        &observed.untracked_path_digests,
    ));
    if expected.head != observed.head {
        paths.extend(
            git_nul_paths(
                worktree,
                &[
                    "diff",
                    "--name-only",
                    "-z",
                    "--no-ext-diff",
                    "--no-renames",
                    &expected.head,
                    &observed.head,
                ],
            )
            .await?,
        );
    }
    paths.sort();
    paths.dedup();
    let omitted_changed_path_count = paths.len().saturating_sub(MAX_REPORTED_CHANGED_PATHS);
    paths.truncate(MAX_REPORTED_CHANGED_PATHS);
    Ok((paths, omitted_changed_path_count))
}

fn git_index_entries(output: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::<String, Vec<String>>::new();
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| "git reported a malformed Artifact index entry".to_string())?;
        let (identity, path_with_separator) = entry.split_at(separator);
        let path = artifact_path_display(&path_with_separator[1..]);
        let identity = std::str::from_utf8(identity)
            .map_err(|_| "git reported a malformed Artifact index identity".to_string())?;
        entries.entry(path).or_default().push(identity.to_string());
    }
    Ok(entries
        .into_iter()
        .map(|(path, mut identities)| {
            identities.sort();
            (
                path,
                digest_bytes(&serde_json::to_vec(&identities).expect("index entries serialize")),
            )
        })
        .collect())
}

fn gitlink_path_bytes(output: &[u8]) -> Result<BTreeSet<Vec<u8>>, String> {
    let mut paths = BTreeSet::new();
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| "git reported a malformed Artifact index entry".to_string())?;
        let (identity, path_with_separator) = entry.split_at(separator);
        let mut fields = identity.split(|byte| byte.is_ascii_whitespace());
        let _tag = fields.next();
        if fields.next() == Some(b"160000".as_slice()) {
            paths.insert(path_with_separator[1..].to_vec());
        }
    }
    Ok(paths)
}

fn remove_digest_covered_paths(
    paths: &mut Vec<String>,
    expected: &BTreeMap<String, String>,
    observed: &BTreeMap<String, String>,
) {
    if expected.is_empty() || observed.is_empty() {
        return;
    }
    paths.retain(|path| !expected.contains_key(path) && !observed.contains_key(path));
}

fn changed_digest_paths(
    expected: &BTreeMap<String, String>,
    observed: &BTreeMap<String, String>,
) -> Vec<String> {
    if expected.is_empty() || observed.is_empty() {
        return Vec::new();
    }
    expected
        .iter()
        .filter_map(|(path, digest)| (observed.get(path) != Some(digest)).then_some(path.clone()))
        .chain(
            observed
                .keys()
                .filter(|path| !expected.contains_key(*path))
                .cloned(),
        )
        .collect()
}

async fn git_nul_paths(worktree: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    Ok(git_nul_path_bytes(worktree, args)
        .await?
        .iter()
        .map(|path| artifact_path_display(path))
        .collect())
}

async fn git_nul_path_bytes(worktree: &Path, args: &[&str]) -> Result<Vec<Vec<u8>>, String> {
    let output = git_stdout_bytes(worktree, args).await?;
    let mut paths = output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn artifact_path_display(path: &[u8]) -> String {
    match std::str::from_utf8(path) {
        Ok(path) if !path.starts_with(RAW_PATH_PREFIX) => path.to_string(),
        _ => {
            let mut encoded = String::with_capacity(RAW_PATH_PREFIX.len() + path.len() * 2);
            encoded.push_str(RAW_PATH_PREFIX);
            for byte in path {
                use std::fmt::Write;
                write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
            }
            encoded
        }
    }
}

pub(crate) async fn git_stdout(worktree: &Path, args: &[&str]) -> Result<String, String> {
    Ok(
        String::from_utf8_lossy(&git_stdout_bytes(worktree, args).await?)
            .trim()
            .to_string(),
    )
}

async fn git_stdout_bytes(worktree: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
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
    Ok(output.stdout)
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    hex::encode(digest.finalize())
}

fn observation_digest(observation: &ArtifactRepositoryObservation) -> String {
    // Serialization here is an internal, deterministic digest input rather than exposed data.
    digest_bytes(&serde_json::to_vec(observation).expect("artifact observation serializes"))
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

        assert!(first.captured_at.is_some());
        assert!(second.captured_at.is_some());
        assert_eq!(first.identity, second.identity);
        assert_eq!(first.output_digest, second.output_digest);
        assert_eq!(first.repositories, second.repositories);
        assert_eq!(first.repositories[0].untracked_paths, vec!["visible.txt"]);

        tokio::fs::write(dir.path().join("ignored.out"), "changed ignored content")
            .await
            .unwrap();
        let after_ignored_change = capture(
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
        assert!(after_ignored_change.captured_at.is_some());
        assert_eq!(first.identity, after_ignored_change.identity);
        assert_eq!(first.output_digest, after_ignored_change.output_digest);
        assert_eq!(first.repositories, after_ignored_change.repositories);
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

    #[cfg(not(unix))]
    #[tokio::test]
    async fn directory_path_digest_changes_when_a_nested_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("embedded/nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(nested.join("child.txt"), "before")
            .await
            .unwrap();

        let before = path_digest(dir.path(), b"embedded", "untracked")
            .await
            .unwrap();
        tokio::fs::write(nested.join("child.txt"), "after")
            .await
            .unwrap();
        let after = path_digest(dir.path(), b"embedded", "untracked")
            .await
            .unwrap();

        assert_ne!(before, after);
    }

    #[cfg(not(unix))]
    #[tokio::test]
    async fn missing_parent_path_digest_is_observed_as_missing() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(
            path_digest(dir.path(), b"removed/nested.txt", "tracked")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn capture_records_a_missing_tracked_entry_without_failing() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        tokio::fs::create_dir_all(dir.path().join("tracked-parent"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("tracked-parent/child.txt"), "tracked")
            .await
            .unwrap();
        run_git(dir.path(), &["add", "tracked-parent/child.txt"]).await;
        run_git(dir.path(), &["commit", "-m", "tracked child"]).await;
        tokio::fs::remove_dir_all(dir.path().join("tracked-parent"))
            .await
            .unwrap();

        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .expect("a producer snapshot must record a missing tracked entry");

        assert!(snapshot.repositories[0]
            .tracked_path_digests
            .contains_key("tracked-parent/child.txt"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn immutable_verification_retains_non_utf8_git_path_bytes() {
        use std::os::unix::ffi::OsStringExt;

        let dir = initialized_repository().await;
        let path = std::ffi::OsString::from_vec(b"raw-\xff.txt".to_vec());
        tokio::fs::write(dir.path().join(&path), "before")
            .await
            .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot.repositories[0].untracked_paths,
            vec!["raw-bytes:7261772dff2e747874"]
        );

        tokio::fs::write(dir.path().join(&path), "after")
            .await
            .unwrap();
        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(
            violations[0].changed_paths,
            vec!["raw-bytes:7261772dff2e747874"]
        );
    }

    #[tokio::test]
    async fn immutable_verification_detects_rewrite_inside_an_untracked_embedded_repository() {
        let dir = initialized_repository().await;
        tokio::fs::write(dir.path().join(".gitignore"), "ordinary/outer-cache/\n")
            .await
            .unwrap();
        run_git(dir.path(), &["add", ".gitignore"]).await;
        run_git(dir.path(), &["commit", "-m", "outer ignore"]).await;
        let embedded = dir.path().join("ordinary/embedded");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        run_git(&embedded, &["init", "--initial-branch=main"]).await;
        run_git(&embedded, &["config", "user.email", "test@example.com"]).await;
        run_git(&embedded, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(embedded.join("child.txt"), "before")
            .await
            .unwrap();
        tokio::fs::write(embedded.join(".gitignore"), "cache/\n")
            .await
            .unwrap();
        tokio::fs::create_dir_all(embedded.join("cache"))
            .await
            .unwrap();
        tokio::fs::write(embedded.join("cache/output.bin"), "before")
            .await
            .unwrap();
        tokio::fs::write(embedded.join(".git/info/exclude"), "info-cache/\n")
            .await
            .unwrap();
        tokio::fs::create_dir(embedded.join("info-cache"))
            .await
            .unwrap();
        tokio::fs::write(embedded.join("info-cache/output.bin"), "before")
            .await
            .unwrap();
        tokio::fs::create_dir_all(embedded.join("sub/cache"))
            .await
            .unwrap();
        tokio::fs::write(embedded.join("sub/.gitignore"), "/cache/\n")
            .await
            .unwrap();
        tokio::fs::write(embedded.join("sub/cache/output.bin"), "before")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.path().join("ordinary/outer-cache"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("ordinary/outer-cache/output.bin"), "before")
            .await
            .unwrap();
        run_git(
            &embedded,
            &["add", "child.txt", ".gitignore", "sub/.gitignore"],
        )
        .await;
        run_git(&embedded, &["commit", "-m", "embedded"]).await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(embedded.join("cache/output.bin"), "after")
            .await
            .unwrap();
        tokio::fs::write(embedded.join("info-cache/output.bin"), "after")
            .await
            .unwrap();
        tokio::fs::write(embedded.join("sub/cache/output.bin"), "after")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("ordinary/outer-cache/output.bin"), "after")
            .await
            .unwrap();
        assert!(
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap()
                .is_empty()
        );

        tokio::fs::write(embedded.join("child.txt"), "after")
            .await
            .unwrap();
        assert_eq!(
            verify_immutable_inputs("review", &[snapshot], &repositories)
                .await
                .unwrap()[0]
                .changed_paths,
            vec!["ordinary/embedded/"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_refuses_external_metadata_for_an_untracked_embedded_repository() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        let embedded = dir.path().join("ordinary/embedded");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        let external = initialized_repository().await;
        symlink(external.path().join(".git"), embedded.join(".git")).unwrap();
        tokio::fs::write(embedded.join("child.txt"), "content")
            .await
            .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);

        let error = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap_err();

        assert!(error.contains("could not safely inspect untracked embedded Git metadata"));
    }

    #[tokio::test]
    async fn capture_supports_an_untracked_directory_with_more_than_ten_thousand_entries() {
        let dir = initialized_repository().await;
        let embedded = dir.path().join("embedded");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        run_git(&embedded, &["init", "--initial-branch=main"]).await;
        for index in 0..10_001 {
            tokio::fs::write(embedded.join(format!("entry-{index:05}")), "content")
                .await
                .unwrap();
        }
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);

        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .expect("ordinary embedded repositories are not limited to ten thousand entries");

        assert_eq!(snapshot.repositories[0].untracked_paths, vec!["embedded/"]);
        tokio::fs::write(embedded.join("entry-10000"), "changed")
            .await
            .unwrap();
        assert_eq!(
            verify_immutable_inputs("review", &[snapshot], &repositories)
                .await
                .unwrap()[0]
                .changed_paths,
            vec!["embedded/"]
        );
    }

    #[tokio::test]
    async fn immutable_verification_detects_rewrite_inside_a_tracked_gitlink_ignored_by_git() {
        let dir = initialized_repository().await;
        let embedded = dir.path().join("submodule");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        run_git(&embedded, &["init", "--initial-branch=main"]).await;
        run_git(&embedded, &["config", "user.email", "test@example.com"]).await;
        run_git(&embedded, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(embedded.join("child.txt"), "before")
            .await
            .unwrap();
        tokio::fs::write(embedded.join(".gitignore"), "cache/\n")
            .await
            .unwrap();
        tokio::fs::create_dir(embedded.join("cache")).await.unwrap();
        tokio::fs::write(embedded.join("cache/output.bin"), "before")
            .await
            .unwrap();
        run_git(&embedded, &["add", "child.txt", ".gitignore"]).await;
        run_git(&embedded, &["commit", "-m", "embedded"]).await;
        tokio::fs::write(dir.path().join(".gitignore"), "*")
            .await
            .unwrap();
        run_git(dir.path(), &["add", "-f", "submodule"]).await;
        run_git(dir.path(), &["commit", "-m", "gitlink"]).await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(embedded.join("cache/output.bin"), "after")
            .await
            .unwrap();
        assert!(
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap()
                .is_empty()
        );

        tokio::fs::write(embedded.join("child.txt"), "after")
            .await
            .unwrap();
        assert_eq!(
            verify_immutable_inputs("review", &[snapshot], &repositories)
                .await
                .unwrap()[0]
                .changed_paths,
            vec!["submodule"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_supports_a_standard_gitfile_for_a_tracked_gitlink() {
        let parent = initialized_repository().await;
        let child = initialized_repository().await;
        tokio::fs::write(child.path().join(".gitignore"), "cache/\n")
            .await
            .unwrap();
        tokio::fs::write(child.path().join("child.txt"), "before")
            .await
            .unwrap();
        run_git(child.path(), &["add", ".gitignore", "child.txt"]).await;
        run_git(child.path(), &["commit", "-m", "child files"]).await;
        let child_path = child.path().to_string_lossy().to_string();
        run_git(
            parent.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &child_path,
                "submodule",
            ],
        )
        .await;
        run_git(parent.path(), &["commit", "-am", "add submodule"]).await;
        assert!(tokio::fs::metadata(parent.path().join("submodule/.git"))
            .await
            .unwrap()
            .is_file());
        tokio::fs::create_dir(parent.path().join("submodule/cache"))
            .await
            .unwrap();
        tokio::fs::write(parent.path().join("submodule/cache/output.bin"), "before")
            .await
            .unwrap();
        tokio::fs::write(
            parent.path().join(".git/modules/submodule/info/exclude"),
            "metadata-cache/\n",
        )
        .await
        .unwrap();
        tokio::fs::create_dir(parent.path().join("submodule/metadata-cache"))
            .await
            .unwrap();
        tokio::fs::write(
            parent.path().join("submodule/metadata-cache/output.bin"),
            "before",
        )
        .await
        .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), parent.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(parent.path().join("submodule/cache/output.bin"), "after")
            .await
            .unwrap();
        assert!(
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap()
                .is_empty()
        );
        tokio::fs::write(
            parent.path().join("submodule/metadata-cache/output.bin"),
            "after",
        )
        .await
        .unwrap();
        assert_eq!(
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap()[0]
                .changed_paths,
            vec!["submodule"]
        );
        tokio::fs::write(
            parent.path().join("submodule/metadata-cache/output.bin"),
            "before",
        )
        .await
        .unwrap();
        tokio::fs::write(parent.path().join("submodule/child.txt"), "after")
            .await
            .unwrap();
        assert_eq!(
            verify_immutable_inputs("review", &[snapshot], &repositories)
                .await
                .unwrap()[0]
                .changed_paths,
            vec!["submodule"]
        );
    }

    #[tokio::test]
    async fn capture_records_an_uninitialized_gitlink_as_missing() {
        let dir = initialized_repository().await;
        let embedded = dir.path().join("submodule");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        run_git(&embedded, &["init", "--initial-branch=main"]).await;
        run_git(&embedded, &["config", "user.email", "test@example.com"]).await;
        run_git(&embedded, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(embedded.join("child.txt"), "content")
            .await
            .unwrap();
        run_git(&embedded, &["add", "child.txt"]).await;
        run_git(&embedded, &["commit", "-m", "embedded"]).await;
        run_git(dir.path(), &["add", "submodule"]).await;
        run_git(dir.path(), &["commit", "-m", "gitlink"]).await;
        tokio::fs::remove_dir_all(&embedded).await.unwrap();

        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]),
        )
        .await
        .unwrap();

        assert_eq!(
            snapshot.repositories[0].tracked_path_digests["submodule"],
            MISSING_ARTIFACT_PATH_DIGEST
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_refuses_a_gitlink_replaced_by_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        let embedded = dir.path().join("submodule");
        tokio::fs::create_dir_all(&embedded).await.unwrap();
        run_git(&embedded, &["init", "--initial-branch=main"]).await;
        run_git(&embedded, &["config", "user.email", "test@example.com"]).await;
        run_git(&embedded, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(embedded.join("child.txt"), "content")
            .await
            .unwrap();
        run_git(&embedded, &["add", "child.txt"]).await;
        run_git(&embedded, &["commit", "-m", "embedded"]).await;
        run_git(dir.path(), &["add", "submodule"]).await;
        run_git(dir.path(), &["commit", "-m", "gitlink"]).await;
        let external = initialized_repository().await;
        tokio::fs::remove_dir_all(&embedded).await.unwrap();
        symlink(external.path(), &embedded).unwrap();

        let error = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]),
        )
        .await
        .unwrap_err();

        assert!(error.contains("could not safely inspect tracked Artifact gitlink"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_never_follows_an_untracked_directory_symlink_cycle() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        symlink(".", dir.path().join("cycle")).unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();
        assert_eq!(snapshot.repositories[0].untracked_paths, vec!["cycle"]);
    }

    #[tokio::test]
    async fn immutable_verification_detects_a_deleted_tracked_entry() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();
        tokio::fs::remove_file(dir.path().join("tracked.txt"))
            .await
            .unwrap();

        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();

        assert_eq!(violations[0].changed_paths, vec!["tracked.txt"]);
    }

    #[tokio::test]
    async fn immutable_verification_detects_a_restored_tracked_entry() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        tokio::fs::remove_file(dir.path().join("tracked.txt"))
            .await
            .unwrap();
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();
        tokio::fs::write(dir.path().join("tracked.txt"), "restored\n")
            .await
            .unwrap();

        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();

        assert_eq!(violations[0].changed_paths, vec!["tracked.txt"]);
    }

    #[tokio::test]
    async fn capture_changes_identity_when_a_tracked_skip_worktree_flag_changes() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
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

        run_git(
            dir.path(),
            &["update-index", "--skip-worktree", "tracked.txt"],
        )
        .await;
        let flag_only_violations =
            verify_immutable_inputs("review", std::slice::from_ref(&first), &repositories)
                .await
                .unwrap();
        assert_eq!(flag_only_violations[0].changed_paths, vec!["tracked.txt"]);
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
            first.repositories[0].index_digest,
            second.repositories[0].index_digest
        );
    }

    #[test]
    fn tracked_index_entries_keep_every_unmerged_stage_for_one_path() {
        let entries = git_index_entries(
            b"M 100644 base 1\tconflicted.txt\0M 100644 ours 2\tconflicted.txt\0M 100644 theirs 3\tconflicted.txt\0",
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_ne!(
            entries["conflicted.txt"],
            digest_bytes(&serde_json::to_vec(&["M 100644 theirs 3"]).unwrap())
        );
    }

    #[tokio::test]
    async fn immutable_verification_detects_tracked_rewrites_hidden_by_index_flags() {
        for flag in ["--skip-worktree", "--assume-unchanged"] {
            let dir = initialized_repository().await;
            let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
            let snapshot = capture(
                "run-1",
                1,
                "build",
                1,
                &serde_json::json!({}),
                &ArtifactSnapshotConfig {
                    repositories: vec!["repo".to_string()],
                },
                &repositories,
            )
            .await
            .unwrap();

            run_git(dir.path(), &["update-index", flag, "tracked.txt"]).await;
            tokio::fs::write(dir.path().join("tracked.txt"), "consumer rewrite\n")
                .await
                .unwrap();

            let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
                .await
                .unwrap();
            assert_eq!(violations.len(), 1, "{flag}");
            assert_eq!(violations[0].changed_paths, vec!["tracked.txt"], "{flag}");
            assert!(
                !serde_json::to_string(&violations)
                    .unwrap()
                    .contains("consumer rewrite"),
                "{flag}"
            );
        }
    }

    #[tokio::test]
    async fn immutable_verification_detects_rewrite_when_skip_worktree_precedes_capture() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        run_git(
            dir.path(),
            &["update-index", "--skip-worktree", "tracked.txt"],
        )
        .await;
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(dir.path().join("tracked.txt"), "hidden rewrite\n")
            .await
            .unwrap();

        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].changed_paths, vec!["tracked.txt"]);
    }

    #[tokio::test]
    async fn capture_changes_identity_when_untracked_path_bytes_change() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
        tokio::fs::write(
            dir.path().join("visible.txt"),
            "untracked-secret-before-rewrite",
        )
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
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("untracked-secret-before-rewrite"));
        tokio::fs::write(
            dir.path().join("visible.txt"),
            "untracked-secret-after-rewrite",
        )
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
        assert_eq!(
            first.repositories[0].untracked_paths,
            second.repositories[0].untracked_paths
        );
        assert_ne!(
            first.repositories[0].untracked_digest,
            second.repositories[0].untracked_digest
        );
        assert_ne!(first.identity, second.identity);
        let violations =
            verify_immutable_inputs("review", std::slice::from_ref(&first), &repositories)
                .await
                .unwrap();
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].changed_paths, vec!["visible.txt"]);
    }

    #[tokio::test]
    async fn untracked_paths_use_raw_nul_records_without_git_quoting() {
        let dir = initialized_repository().await;
        let path = "café\ncontrol.txt";
        tokio::fs::write(dir.path().join(path), "before")
            .await
            .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &selection,
            &repositories,
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot.repositories[0].untracked_paths,
            vec![path.to_string()]
        );

        tokio::fs::write(dir.path().join(path), "after")
            .await
            .unwrap();
        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(violations[0].changed_paths, vec![path.to_string()]);
    }

    #[tokio::test]
    async fn tracked_paths_use_raw_nul_records_without_git_quoting() {
        let dir = initialized_repository().await;
        let path = "tracked-café\ncontrol.txt";
        tokio::fs::write(dir.path().join(path), "before")
            .await
            .unwrap();
        run_git(dir.path(), &["add", path]).await;
        run_git(dir.path(), &["commit", "-m", "special tracked path"]).await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(dir.path().join(path), "after")
            .await
            .unwrap();
        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(violations[0].changed_paths, vec![path.to_string()]);
    }

    #[tokio::test]
    async fn untracked_regular_file_digest_handles_large_same_length_rewrite() {
        let dir = initialized_repository().await;
        let path = dir.path().join("large.bin");
        tokio::fs::write(&path, vec![b'a'; 2 * 1024 * 1024])
            .await
            .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(&path, vec![b'b'; 2 * 1024 * 1024])
            .await
            .unwrap();
        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(violations[0].changed_paths, vec!["large.bin"]);
    }

    #[tokio::test]
    async fn untracked_changed_path_evidence_omits_unchanged_paths() {
        let dir = initialized_repository().await;
        for number in 0..=MAX_REPORTED_CHANGED_PATHS {
            tokio::fs::write(
                dir.path().join(format!("untracked-{number:03}.txt")),
                "before",
            )
            .await
            .unwrap();
        }
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let selection = ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        };
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::Value::Null,
            &selection,
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(dir.path().join("untracked-057.txt"), "after")
            .await
            .unwrap();
        let violations = verify_immutable_inputs("review", &[snapshot], &repositories)
            .await
            .unwrap();
        assert_eq!(violations[0].changed_paths, vec!["untracked-057.txt"]);
        assert_eq!(violations[0].omitted_changed_path_count, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_hashes_an_untracked_symlink_target_without_reading_its_destination() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        let destination = TempDir::new().unwrap();
        tokio::fs::write(
            destination.path().join("secret.txt"),
            "outside-worktree-secret",
        )
        .await
        .unwrap();
        symlink(
            destination.path().join("secret.txt"),
            dir.path().join("linked.txt"),
        )
        .unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("outside-worktree-secret"));
        tokio::fs::write(
            destination.path().join("secret.txt"),
            "rewritten-outside-secret",
        )
        .await
        .unwrap();
        assert!(
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn capability_safe_link_read_retains_an_absolute_target() {
        use cap_std::ambient_authority;
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("absolute-target");
        symlink(&target, dir.path().join("link")).unwrap();
        let capability =
            cap_std::fs::Dir::open_ambient_dir(dir.path(), ambient_authority()).unwrap();

        assert_eq!(
            read_link_contents_capability_safe(&capability, std::ffi::OsStr::new("link")).unwrap(),
            target
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_refuses_a_tracked_path_beneath_an_intermediate_symlink() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        let nested = dir.path().join("nested");
        tokio::fs::create_dir(&nested).await.unwrap();
        tokio::fs::write(nested.join("tracked.txt"), "inside")
            .await
            .unwrap();
        run_git(dir.path(), &["add", "nested/tracked.txt"]).await;
        run_git(dir.path(), &["commit", "-m", "nested tracked path"]).await;

        let outside = TempDir::new().unwrap();
        tokio::fs::write(outside.path().join("tracked.txt"), "outside-secret")
            .await
            .unwrap();
        tokio::fs::remove_dir_all(&nested).await.unwrap();
        symlink(outside.path(), &nested).unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);

        let error = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap_err();

        assert!(error.contains("tracked Artifact path"), "{error}");
        assert!(!error.contains("outside-secret"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_refuses_a_missing_tracked_path_beneath_an_intermediate_symlink() {
        use std::os::unix::fs::symlink;

        let dir = initialized_repository().await;
        let nested = dir.path().join("nested");
        tokio::fs::create_dir(&nested).await.unwrap();
        tokio::fs::write(nested.join("tracked.txt"), "inside")
            .await
            .unwrap();
        run_git(dir.path(), &["add", "nested/tracked.txt"]).await;
        run_git(dir.path(), &["commit", "-m", "nested tracked path"]).await;
        tokio::fs::remove_dir_all(&nested).await.unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), &nested).unwrap();
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);

        let error = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap_err();

        assert!(error.contains("tracked Artifact path"), "{error}");
    }

    #[test]
    fn observation_without_the_untracked_digest_remains_readable_for_fail_closed_recovery() {
        let observation: ArtifactRepositoryObservation =
            serde_json::from_value(serde_json::json!({
                "repository": "repo",
                "head": "head",
                "index_digest": "index",
                "tracked_worktree_digest": "worktree",
                "untracked_paths": ["visible.txt"]
            }))
            .unwrap();

        assert_eq!(observation.untracked_digest, "");
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

    #[tokio::test]
    async fn immutable_verification_reports_content_free_changed_observation() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        tokio::fs::write(dir.path().join("tracked.txt"), "changed\n")
            .await
            .unwrap();
        let violations =
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap();

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].consumer_step, "review");
        assert_eq!(violations[0].producer_step, "build");
        assert_eq!(violations[0].artifact_identity, snapshot.identity);
        assert_ne!(violations[0].expected_digest, violations[0].observed_digest);
        assert_eq!(violations[0].changed_paths, vec!["tracked.txt"]);
        assert_eq!(violations[0].omitted_changed_path_count, 0);
    }

    #[tokio::test]
    async fn immutable_verification_bounds_sorted_changed_path_evidence() {
        let dir = initialized_repository().await;
        let repositories = BTreeMap::from([("repo".to_string(), dir.path().to_path_buf())]);
        let snapshot = capture(
            "run-1",
            1,
            "build",
            1,
            &serde_json::json!({}),
            &ArtifactSnapshotConfig {
                repositories: vec!["repo".to_string()],
            },
            &repositories,
        )
        .await
        .unwrap();

        for number in (0..=MAX_REPORTED_CHANGED_PATHS).rev() {
            tokio::fs::write(
                dir.path().join(format!("changed-{number:03}.txt")),
                "changed",
            )
            .await
            .unwrap();
        }
        let violations =
            verify_immutable_inputs("review", std::slice::from_ref(&snapshot), &repositories)
                .await
                .unwrap();

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].changed_paths.len(),
            MAX_REPORTED_CHANGED_PATHS
        );
        assert_eq!(violations[0].changed_paths[0], "changed-000.txt");
        assert_eq!(
            violations[0].changed_paths.last().unwrap(),
            "changed-099.txt"
        );
        assert_eq!(violations[0].omitted_changed_path_count, 1);
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
