# Worktree-Based Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain workspace directories with git worktrees, enabling multi-agent collaboration across configured repositories with proper isolation, persistence across retries, and lifecycle management.

**Architecture:** Add `WorktreeCoordinator` to manage worktree lifecycle across repos, enhance `WorkspaceManager` to coordinate between base directories and worktrees, add `PushStrategy` configuration, and update orchestrator to pass worktree paths to agents.

**Tech Stack:** Rust, git CLI (via std::process::Command), tokio for async, thiserror for error handling, serde for config

---

## File Structure

**New Files:**
- `crates/ensemble-core/src/workspace/worktree.rs` - Core worktree operations (create, remove, list, branch management)
- `crates/ensemble-core/src/workspace/coordinator.rs` - Multi-repo worktree coordination with rollback
- `crates/ensemble-core/src/workspace/push_strategy.rs` - PushStrategy enum and logic
- `crates/ensemble-core/tests/worktree_tests.rs` - Unit tests for worktree operations

**Modified Files:**
- `crates/ensemble-core/src/error.rs` - Add WorktreeError variants
- `crates/ensemble-core/src/workspace/mod.rs` - Export new modules
- `crates/ensemble-core/src/workspace/manager.rs` - Integrate worktree coordinator
- `crates/ensemble-core/src/config/ensemble.rs` - Add PushStrategy and git_remote to RepoConfig
- `crates/ensemble-core/src/config/mod.rs` - Re-export PushStrategy
- `crates/ensemble-core/src/orchestrator/mod.rs` - Pass worktree paths to agents
- `crates/ensemble-core/src/agent/mod.rs` - Update AgentRunner trait with worktree context

---

## Phase 1: Core Worktree Operations

### Task 1: Add Worktree Error Types

**Files:**
- Modify: `crates/ensemble-core/src/error.rs:29-39`

- [ ] **Step 1: Add WorktreeError enum to error.rs**

Add after `WorkspaceError`:

```rust
#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error("worktree creation failed for repo {repo}: {reason}")]
    CreationFailed { repo: String, reason: String },
    #[error("worktree already exists at {path}")]
    AlreadyExists { path: String },
    #[error("worktree not found at {path}")]
    NotFound { path: String },
    #[error("git command failed: {command} — {reason}")]
    GitCommandFailed { command: String, reason: String },
    #[error("branch creation failed: {branch} — {reason}")]
    BranchCreationFailed { branch: String, reason: String },
    #[error("rollback failed during cleanup: {reason}")]
    RollbackFailed { reason: String },
    #[error("invalid repo path: {path}")]
    InvalidRepoPath { path: String },
}
```

- [ ] **Step 2: Add WorktreeError to EnsembleError**

Add variant to `EnsembleError`:

```rust
#[derive(Debug, Error)]
pub enum EnsembleError {
    // ... existing variants
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/error.rs
git commit -m "feat: add WorktreeError enum for worktree operations"
```

---

### Task 2: Create Core Worktree Module

**Files:**
- Create: `crates/ensemble-core/src/workspace/worktree.rs`
- Test: `crates/ensemble-core/tests/worktree_tests.rs`

- [ ] **Step 1: Write failing test for worktree creation**

Create `crates/ensemble-core/tests/worktree_tests.rs`:

```rust
use ensemble_core::workspace::worktree::{create_worktree, remove_worktree, worktree_exists};
use std::path::PathBuf;
use tempfile::TempDir;

fn setup_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    // Initialize a git repo for testing
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(&dir)
        .output()
        .expect("git init failed");
    
    // Create initial commit
    std::fs::write(dir.path().join("README.md"), "# Test").unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(&dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    
    dir
}

#[tokio::test]
async fn test_create_worktree_success() {
    let repo = setup_repo();
    let worktree_path = repo.path().join(".worktrees").join("test-issue");
    let branch = "ensemble-2026-03-30-test-issue";
    
    let result = create_worktree(repo.path(), &worktree_path, branch).await;
    
    assert!(result.is_ok());
    assert!(worktree_path.exists());
    assert!(worktree_path.join("README.md").exists()); // Should have repo contents
}

#[tokio::test]
async fn test_worktree_exists_detection() {
    let repo = setup_repo();
    let worktree_path = repo.path().join(".worktrees").join("test-issue");
    let branch = "ensemble-2026-03-30-test-issue";
    
    // Initially not exists
    assert!(!worktree_exists(repo.path(), &worktree_path).await.unwrap());
    
    // Create it
    create_worktree(repo.path(), &worktree_path, branch).await.unwrap();
    
    // Now exists
    assert!(worktree_exists(repo.path(), &worktree_path).await.unwrap());
}

#[tokio::test]
async fn test_remove_worktree() {
    let repo = setup_repo();
    let worktree_path = repo.path().join(".worktrees").join("test-issue");
    let branch = "ensemble-2026-03-30-test-issue";
    
    create_worktree(repo.path(), &worktree_path, branch).await.unwrap();
    assert!(worktree_path.exists());
    
    remove_worktree(repo.path(), &worktree_path, branch).await.unwrap();
    
    assert!(!worktree_path.exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p ensemble-core worktree_tests -- --nocapture
```

Expected: FAIL with "module not found" or similar

- [ ] **Step 3: Create worktree.rs module**

Create `crates/ensemble-core/src/workspace/worktree.rs`:

```rust
use crate::error::WorktreeError;
use std::path::Path;
use std::process::Command;
use tokio::process::Command as TokioCommand;
use tracing::{debug, error, info, warn};

/// Create a git worktree at the specified path with a new branch.
pub async fn create_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), WorktreeError> {
    info!(
        repo = %repo_path.display(),
        worktree = %worktree_path.display(),
        branch,
        "creating worktree"
    );
    
    // Ensure parent directory exists
    if let Some(parent) = worktree_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            WorktreeError::CreationFailed {
                repo: repo_path.display().to_string(),
                reason: format!("failed to create parent dir: {e}"),
            }
        })?;
    }
    
    // Create worktree with new branch
    let output = TokioCommand::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            branch,
            &worktree_path.to_string_lossy(),
        ])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git worktree add".to_string(),
            reason: e.to_string(),
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(%stderr, "git worktree add failed");
        
        // Check if worktree already exists
        if stderr.contains("already exists") {
            return Err(WorktreeError::AlreadyExists {
                path: worktree_path.display().to_string(),
            });
        }
        
        return Err(WorktreeError::CreationFailed {
            repo: repo_path.display().to_string(),
            reason: stderr.to_string(),
        });
    }
    
    info!("worktree created successfully");
    Ok(())
}

/// Check if a worktree exists at the given path.
pub async fn worktree_exists(repo_path: &Path, worktree_path: &Path) -> Result<bool, WorktreeError> {
    let output = TokioCommand::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git worktree list".to_string(),
            reason: e.to_string(),
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(WorktreeError::GitCommandFailed {
            command: "git worktree list".to_string(),
            reason: stderr.to_string(),
        });
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktree_str = worktree_path.to_string_lossy();
    
    // Check if any worktree path matches
    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            let path = line.trim_start_matches("worktree ");
            if path == worktree_str.as_ref() {
                return Ok(true);
            }
        }
    }
    
    // Also check if directory exists (orphaned worktree)
    if worktree_path.exists() {
        warn!("worktree directory exists but not registered in git");
        return Ok(true);
    }
    
    Ok(false)
}

/// Remove a worktree and delete its branch.
pub async fn remove_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), WorktreeError> {
    info!(
        worktree = %worktree_path.display(),
        branch,
        "removing worktree"
    );
    
    // Remove worktree
    let output = TokioCommand::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            &worktree_path.to_string_lossy(),
        ])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git worktree remove".to_string(),
            reason: e.to_string(),
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If worktree doesn't exist, that's ok
        if stderr.contains("not a working tree") {
            debug!("worktree already removed");
        } else {
            return Err(WorktreeError::GitCommandFailed {
                command: "git worktree remove".to_string(),
                reason: stderr.to_string(),
            });
        }
    }
    
    // Delete the branch (local)
    let _ = TokioCommand::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_path)
        .output()
        .await;
    
    info!("worktree removed successfully");
    Ok(())
}

/// Pull latest changes from remote in a worktree.
pub async fn pull_worktree(worktree_path: &Path, branch: &str) -> Result<(), WorktreeError> {
    info!(worktree = %worktree_path.display(), "pulling latest changes");
    
    let output = TokioCommand::new("git")
        .args(["pull", "origin", branch])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git pull".to_string(),
            reason: e.to_string(),
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Pull may fail if branch doesn't exist on remote yet - that's ok
        if !stderr.contains("couldn't find remote ref") {
            warn!(%stderr, "git pull had issues, but continuing");
        }
    }
    
    Ok(())
}

/// Sanitize an issue identifier for use in branch names.
/// Replaces non-alphanumeric chars with `-`, collapses multiple `-`, strips leading/trailing.
pub fn sanitize_branch_name(identifier: &str) -> String {
    let mut result = String::with_capacity(identifier.len());
    let mut last_was_dash = true; // Start true to strip leading dashes
    
    for c in identifier.chars() {
        if c.is_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            result.push('-');
            last_was_dash = true;
        }
        // Skip consecutive non-alphanumeric
    }
    
    // Strip trailing dash
    if result.ends_with('-') {
        result.pop();
    }
    
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_sanitize_branch_name() {
        assert_eq!(
            sanitize_branch_name("my-repo#42"),
            "my-repo-42"
        );
        assert_eq!(
            sanitize_branch_name("acme/api#123"),
            "acme-api-123"
        );
        assert_eq!(
            sanitize_branch_name("FEATURE_Add Dark Mode!!!"),
            "feature-add-dark-mode"
        );
        assert_eq!(
            sanitize_branch_name("--test--"),
            "test"
        );
    }
}
```

- [ ] **Step 4: Export worktree module**

Modify `crates/ensemble-core/src/workspace/mod.rs`:

```rust
pub mod hooks;
pub mod manager;
pub mod worktree;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p ensemble-core worktree_tests -- --nocapture
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/workspace/
git add crates/ensemble-core/tests/worktree_tests.rs
git commit -m "feat: add core worktree operations module"
```

---

### Task 3: Create WorktreeCoordinator

**Files:**
- Create: `crates/ensemble-core/src/workspace/coordinator.rs`
- Test: `crates/ensemble-core/tests/coordinator_tests.rs`

- [ ] **Step 1: Write failing test for coordinator**

Create `crates/ensemble-core/tests/coordinator_tests.rs`:

```rust
use ensemble_core::config::ensemble::RepoConfig;
use ensemble_core::workspace::coordinator::WorktreeCoordinator;
use std::collections::HashMap;
use tempfile::TempDir;

fn setup_repo(name: &str) -> (TempDir, RepoConfig) {
    let dir = TempDir::new().unwrap();
    
    // Initialize git repo
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(&dir)
        .output()
        .unwrap();
    
    // Create initial commit
    std::fs::write(dir.path().join("README.md"), format!("# {}", name)).unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(&dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    
    let config = RepoConfig {
        path: dir.path().to_string_lossy().to_string(),
        branch: "main".to_string(),
        git_remote: None,
    };
    
    (dir, config)
}

#[tokio::test]
async fn test_prepare_worktrees_creates_all() {
    let (repo1_dir, repo1_config) = setup_repo("repo1");
    let (repo2_dir, repo2_config) = setup_repo("repo2");
    
    let repos = HashMap::from([
        ("frontend".to_string(), repo1_config),
        ("api".to_string(), repo2_config),
    ]);
    
    let coordinator = WorktreeCoordinator::new(repos, "2026-03-30".to_string());
    
    let result = coordinator.prepare_worktrees("my-issue-42").await;
    
    assert!(result.is_ok());
    let worktrees = result.unwrap();
    
    assert_eq!(worktrees.len(), 2);
    assert!(worktrees.contains_key("frontend"));
    assert!(worktrees.contains_key("api"));
    
    // Verify directories exist
    let frontend_path = &worktrees["frontend"].path;
    let api_path = &worktrees["api"].path;
    
    assert!(frontend_path.exists());
    assert!(api_path.exists());
    assert!(worktrees["frontend"].created_now);
    assert!(worktrees["api"].created_now);
}

#[tokio::test]
async fn test_prepare_worktrees_reuses_existing() {
    let (repo1_dir, repo1_config) = setup_repo("repo1");
    
    let repos = HashMap::from([
        ("frontend".to_string(), repo1_config),
    ]);
    
    let coordinator = WorktreeCoordinator::new(repos, "2026-03-30".to_string());
    
    // First call creates
    let result1 = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    assert!(result1["frontend"].created_now);
    
    // Second call reuses
    let result2 = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    assert!(!result2["frontend"].created_now);
    assert_eq!(result1["frontend"].path, result2["frontend"].path);
}

#[tokio::test]
async fn test_cleanup_worktrees() {
    let (repo1_dir, repo1_config) = setup_repo("repo1");
    
    let repos = HashMap::from([
        ("frontend".to_string(), repo1_config),
    ]);
    
    let coordinator = WorktreeCoordinator::new(repos, "2026-03-30".to_string());
    
    // Create worktree
    let worktrees = coordinator.prepare_worktrees("my-issue-42").await.unwrap();
    let path = worktrees["frontend"].path.clone();
    assert!(path.exists());
    
    // Cleanup
    coordinator.cleanup_worktrees("my-issue-42").await.unwrap();
    
    // Verify removed
    assert!(!path.exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p ensemble-core coordinator_tests -- --nocapture
```

Expected: FAIL

- [ ] **Step 3: Create coordinator.rs module**

Create `crates/ensemble-core/src/workspace/coordinator.rs`:

```rust
use crate::config::ensemble::RepoConfig;
use crate::error::WorktreeError;
use crate::workspace::worktree::{create_worktree, remove_worktree, sanitize_branch_name, worktree_exists, pull_worktree};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

/// Information about a created/found worktree.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    /// Absolute path to the worktree directory
    pub path: PathBuf,
    /// The branch name used for this worktree
    pub branch: String,
    /// Whether this worktree was created in this call (false = reused existing)
    pub created_now: bool,
}

/// Coordinates worktree lifecycle across multiple repositories.
pub struct WorktreeCoordinator {
    /// Map of repo name to RepoConfig
    repos: HashMap<String, RepoConfig>,
    /// Base date string for branch naming (YYYY-MM-DD)
    base_date: String,
}

impl WorktreeCoordinator {
    /// Create a new coordinator with the given repo configurations.
    pub fn new(repos: HashMap<String, RepoConfig>, base_date: String) -> Self {
        Self { repos, base_date }
    }
    
    /// Prepare worktrees for all configured repos for the given issue.
    /// 
    /// This is an all-or-nothing operation. If any worktree creation fails,
    /// all already-created worktrees are rolled back and cleaned up.
    pub async fn prepare_worktrees(
        &self,
        issue_id: &str,
    ) -> Result<HashMap<String, WorktreeInfo>, WorktreeError> {
        let branch = self.format_branch_name(issue_id);
        let mut created = HashMap::new();
        
        info!(issue_id, branch, "preparing worktrees for issue");
        
        // Track repos that were newly created for rollback
        let mut newly_created = Vec::new();
        
        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);
            
            // Validate repo path
            if !repo_path.exists() {
                error!(repo = %repo_path.display(), "repo path does not exist");
                // Rollback any already created worktrees
                self.rollback(&created, &newly_created).await;
                return Err(WorktreeError::InvalidRepoPath {
                    path: repo_config.path.clone(),
                });
            }
            
            let worktree_path = repo_path.join(".worktrees").join(&branch);
            
            // Check if worktree already exists
            match worktree_exists(repo_path, &worktree_path).await? {
                true => {
                    info!(repo = repo_name, "reusing existing worktree");
                    
                    // Pull latest changes to refresh
                    if let Err(e) = pull_worktree(&worktree_path, &repo_config.branch).await {
                        warn!(repo = repo_name, error = %e, "failed to pull latest changes, continuing");
                    }
                    
                    created.insert(
                        repo_name.clone(),
                        WorktreeInfo {
                            path: worktree_path,
                            branch: branch.clone(),
                            created_now: false,
                        },
                    );
                }
                false => {
                    info!(repo = repo_name, path = %worktree_path.display(), "creating new worktree");
                    
                    if let Err(e) = create_worktree(repo_path, &worktree_path, &branch).await {
                        error!(repo = repo_name, error = %e, "failed to create worktree");
                        // Rollback any already created worktrees
                        self.rollback(&created, &newly_created).await;
                        return Err(e);
                    }
                    
                    newly_created.push(repo_name.clone());
                    created.insert(
                        repo_name.clone(),
                        WorktreeInfo {
                            path: worktree_path,
                            branch: branch.clone(),
                            created_now: true,
                        },
                    );
                }
            }
        }
        
        info!(count = created.len(), "worktrees prepared successfully");
        Ok(created)
    }
    
    /// Clean up worktrees and delete branches for the given issue.
    pub async fn cleanup_worktrees(&self, issue_id: &str) -> Result<(), WorktreeError> {
        let branch = self.format_branch_name(issue_id);
        
        info!(issue_id, branch, "cleaning up worktrees");
        
        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);
            let worktree_path = repo_path.join(".worktrees").join(&branch);
            
            if let Err(e) = remove_worktree(repo_path, &worktree_path, &branch).await {
                warn!(repo = repo_name, error = %e, "failed to cleanup worktree (continuing)");
            }
        }
        
        Ok(())
    }
    
    /// List worktree paths for an issue without creating them.
    pub fn list_worktrees(&self, issue_id: &str) -> HashMap<String, PathBuf> {
        let branch = self.format_branch_name(issue_id);
        let mut paths = HashMap::new();
        
        for (repo_name, repo_config) in &self.repos {
            let repo_path = Path::new(&repo_config.path);
            let worktree_path = repo_path.join(".worktrees").join(&branch);
            paths.insert(repo_name.clone(), worktree_path);
        }
        
        paths
    }
    
    /// Format branch name for an issue.
    fn format_branch_name(&self, issue_id: &str) -> String {
        let sanitized = sanitize_branch_name(issue_id);
        format!("ensemble-{}-{}", self.base_date, sanitized)
    }
    
    /// Rollback worktrees that were created during a failed prepare operation.
    async fn rollback(
        &self,
        all_worktrees: &HashMap<String, WorktreeInfo>,
        newly_created: &[String],
    ) {
        info!("rolling back partially created worktrees");
        
        for repo_name in newly_created {
            if let Some(info) = all_worktrees.get(repo_name) {
                if let Some(repo_config) = self.repos.get(repo_name) {
                    let repo_path = Path::new(&repo_config.path);
                    if let Err(e) = remove_worktree(repo_path, &info.path, &info.branch).await {
                        error!(repo = repo_name, error = %e, "rollback cleanup failed");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_format_branch_name() {
        let repos = HashMap::new();
        let coordinator = WorktreeCoordinator::new(repos, "2026-03-30".to_string());
        
        let branch = coordinator.format_branch_name("my-repo#42");
        assert_eq!(branch, "ensemble-2026-03-30-my-repo-42");
    }
}
```

- [ ] **Step 4: Export coordinator module**

Modify `crates/ensemble-core/src/workspace/mod.rs`:

```rust
pub mod coordinator;
pub mod hooks;
pub mod manager;
pub mod worktree;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p ensemble-core coordinator_tests -- --nocapture
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/workspace/
git add crates/ensemble-core/tests/coordinator_tests.rs
git commit -m "feat: add WorktreeCoordinator for multi-repo worktree management"
```

---

### Task 4: Add PushStrategy Configuration

**Files:**
- Create: `crates/ensemble-core/src/workspace/push_strategy.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Modify: `crates/ensemble-core/src/workspace/mod.rs`

- [ ] **Step 1: Create PushStrategy enum**

Create `crates/ensemble-core/src/workspace/push_strategy.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Strategy for handling branch pushes at the end of a successful pipeline.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PushStrategy {
    /// Prompt user interactively (CLI mode only, blocks until response)
    Ask,
    /// Automatically push branch to origin
    AutoPush,
    /// Leave local, user handles manually
    Manual,
    /// Only create PR (implicit push)
    PrOnly,
}

impl Default for PushStrategy {
    fn default() -> Self {
        PushStrategy::Manual
    }
}

impl PushStrategy {
    /// Returns true if this strategy requires interactive user input.
    pub fn is_interactive(&self) -> bool {
        matches!(self, PushStrategy::Ask)
    }
    
    /// Returns true if this strategy will push to remote.
    pub fn will_push(&self) -> bool {
        matches!(self, PushStrategy::AutoPush | PushStrategy::PrOnly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_push_strategy_is_interactive() {
        assert!(PushStrategy::Ask.is_interactive());
        assert!(!PushStrategy::AutoPush.is_interactive());
        assert!(!PushStrategy::Manual.is_interactive());
        assert!(!PushStrategy::PrOnly.is_interactive());
    }
    
    #[test]
    fn test_push_strategy_will_push() {
        assert!(!PushStrategy::Ask.will_push());
        assert!(PushStrategy::AutoPush.will_push());
        assert!(!PushStrategy::Manual.will_push());
        assert!(PushStrategy::PrOnly.will_push());
    }
    
    #[test]
    fn test_push_strategy_default() {
        assert_eq!(PushStrategy::default(), PushStrategy::Manual);
    }
    
    #[test]
    fn test_push_strategy_deserialization() {
        let yaml = r#""ask""#;
        let strategy: PushStrategy = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(strategy, PushStrategy::Ask);
        
        let yaml = r#""auto_push""#;
        let strategy: PushStrategy = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(strategy, PushStrategy::AutoPush);
    }
}
```

- [ ] **Step 2: Export PushStrategy from workspace mod**

Modify `crates/ensemble-core/src/workspace/mod.rs`:

```rust
pub mod coordinator;
pub mod hooks;
pub mod manager;
pub mod push_strategy;
pub mod worktree;
```

- [ ] **Step 3: Add PushStrategy to EnsembleConfig**

Modify `crates/ensemble-core/src/config/ensemble.rs`:

Add import at top:
```rust
use crate::workspace::push_strategy::PushStrategy;
```

Add to `EnsembleConfig` struct after `agent` field:
```rust
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct EnsembleConfig {
    // ... existing fields
    #[serde(default)]
    pub agent: AgentRuntimeConfig,
    #[serde(default)]
    pub push_strategy: PushStrategy,
}
```

- [ ] **Step 4: Add git_remote to RepoConfig**

Modify `RepoConfig` struct in `crates/ensemble-core/src/config/ensemble.rs`:

```rust
/// A repository to be managed by the workspace (path + branch).
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct RepoConfig {
    pub path: String,
    pub branch: String,
    #[serde(default = "default_git_remote")]
    pub git_remote: String,
}

fn default_git_remote() -> String {
    "origin".to_string()
}
```

- [ ] **Step 5: Re-export PushStrategy from config mod**

Modify `crates/ensemble-core/src/config/mod.rs`:

Add re-export:
```rust
pub use crate::workspace::push_strategy::PushStrategy;
```

- [ ] **Step 6: Run tests to verify config changes**

```bash
cargo test -p ensemble-core push_strategy -- --nocapture
cargo test -p ensemble-core test_parse_config -- --nocapture
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/workspace/push_strategy.rs
git add crates/ensemble-core/src/config/
git add crates/ensemble-core/src/workspace/mod.rs
git commit -m "feat: add PushStrategy configuration and git_remote to RepoConfig"
```

---

## Phase 2: Integration

### Task 5: Enhance WorkspaceManager with Worktree Support

**Files:**
- Modify: `crates/ensemble-core/src/workspace/manager.rs`
- Modify: `crates/ensemble-core/src/workspace/coordinator.rs` (minor update for git_remote usage)

- [ ] **Step 1: Update WorkspaceManager to integrate coordinator**

Modify `crates/ensemble-core/src/workspace/manager.rs`:

Add imports:
```rust
use crate::config::ensemble::RepoConfig;
use crate::workspace::coordinator::{WorktreeCoordinator, WorktreeInfo};
use std::collections::HashMap;
```

Update `WorkspaceManager` struct:
```rust
/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
    worktree_coordinator: Option<WorktreeCoordinator>,
}
```

Update `WorkspaceResult`:
```rust
/// Result of preparing a workspace for an issue.
pub struct WorkspaceResult {
    /// Absolute path to the base workspace directory (logs, artifacts).
    pub base_path: PathBuf,
    /// Map of repo name to worktree info (if repos configured).
    pub worktrees: HashMap<String, WorktreeInfo>,
    /// The sanitized workspace key used as the directory name.
    pub workspace_key: String,
    /// True if the directory was newly created (not reused).
    pub created_now: bool,
}
```

Update `WorkspaceManager::new`:
```rust
impl WorkspaceManager {
    /// Create a new WorkspaceManager with the given workspace root.
    /// The root is normalized to an absolute path.
    pub fn new(root: &Path, repos: Option<Vec<RepoConfig>>) -> Result<Self, WorkspaceError> {
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("cannot resolve relative root: {e}"),
                })?
                .join(root)
        };
        
        // Initialize worktree coordinator if repos are configured
        let worktree_coordinator = repos.map(|repo_configs| {
            let mut repos_map = HashMap::new();
            for (index, repo) in repo_configs.into_iter().enumerate() {
                // Use path basename as name if not specified, or index-based
                let name = Path::new(&repo.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("repo-{}", index));
                repos_map.insert(name, repo);
            }
            
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            WorktreeCoordinator::new(repos_map, today)
        });
        
        Ok(Self {
            root,
            worktree_coordinator,
        })
    }
    // ...
}
```

Update `prepare_workspace` to be async and handle worktrees:
```rust
/// Prepare (create or reuse) a workspace for the given issue identifier.
pub async fn prepare_workspace(
    &self,
    identifier: &str,
) -> Result<WorkspaceResult, WorkspaceError> {
    let workspace_key =
        sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
            reason: format!("unsafe workspace key from identifier: {identifier:?}"),
        })?;
    let base_path = self.root.join(&workspace_key);
    
    // Safety: ensure workspace path is inside root
    self.validate_path_inside_root(&base_path)?;
    
    // Create base workspace directory
    let base_created = if base_path.exists() {
        if !base_path.is_dir() {
            return Err(WorkspaceError::CreationFailed {
                reason: format!("path exists but is not a directory: {}", base_path.display()),
            });
        }
        false
    } else {
        std::fs::create_dir_all(&base_path).map_err(|e| WorkspaceError::CreationFailed {
            reason: format!("mkdir failed: {e}"),
        })?;
        true
    };
    
    // Prepare worktrees if coordinator is configured
    let worktrees = if let Some(coordinator) = &self.worktree_coordinator {
        coordinator
            .prepare_worktrees(identifier)
            .await
            .map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("worktree preparation failed: {e}"),
            })?
    } else {
        HashMap::new()
    };
    
    let created_now = base_created || worktrees.values().any(|w| w.created_now);
    
    Ok(WorkspaceResult {
        base_path,
        worktrees,
        workspace_key,
        created_now,
    })
}
```

Update `remove_workspace`:
```rust
/// Remove a workspace directory and its worktrees for the given issue identifier.
pub async fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
    let workspace_key =
        sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
            reason: format!("unsafe workspace key from identifier: {identifier:?}"),
        })?;
    let base_path = self.root.join(&workspace_key);
    
    self.validate_path_inside_root(&base_path)?;
    
    // Clean up worktrees first
    if let Some(coordinator) = &self.worktree_coordinator {
        coordinator
            .cleanup_worktrees(identifier)
            .await
            .map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("worktree cleanup failed: {e}"),
            })?;
    }
    
    // Remove base workspace
    if base_path.exists() {
        std::fs::remove_dir_all(&base_path).map_err(|e| WorkspaceError::CreationFailed {
            reason: format!("remove failed: {e}"),
        })?;
    }
    
    Ok(())
}
```

- [ ] **Step 2: Add chrono dependency**

Check if chrono is already in Cargo.toml, if not add it to workspace dependencies.

- [ ] **Step 3: Update coordinator to use git_remote**

Modify `pull_worktree` in `worktree.rs` to accept remote name:

```rust
/// Pull latest changes from remote in a worktree.
pub async fn pull_worktree(
    worktree_path: &Path,
    branch: &str,
    remote: &str,
) -> Result<(), WorktreeError> {
    info!(worktree = %worktree_path.display(), remote, "pulling latest changes");
    
    let output = TokioCommand::new("git")
        .args(["pull", remote, branch])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitCommandFailed {
            command: "git pull".to_string(),
            reason: e.to_string(),
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Pull may fail if branch doesn't exist on remote yet - that's ok
        if !stderr.contains("couldn't find remote ref") {
            warn!(%stderr, "git pull had issues, but continuing");
        }
    }
    
    Ok(())
}
```

Update coordinator usage:
```rust
if let Err(e) = pull_worktree(&worktree_path, &repo_config.branch, &repo_config.git_remote).await {
    warn!(repo = repo_name, error = %e, "failed to pull latest changes, continuing");
}
```

- [ ] **Step 4: Update existing tests**

Modify tests in `manager.rs` to handle the new signature. Most tests don't use repos, so they'll pass `None` for repos.

- [ ] **Step 5: Run tests**

```bash
cargo test -p ensemble-core workspace::manager -- --nocapture
```

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/workspace/manager.rs
git add crates/ensemble-core/src/workspace/worktree.rs
git add crates/ensemble-core/src/workspace/coordinator.rs
git commit -m "feat: integrate WorktreeCoordinator into WorkspaceManager"
```

---

### Task 6: Update Orchestrator Integration

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/reconciler.rs`

- [ ] **Step 1: Update orchestrator to use async workspace preparation**

Find where `WorkspaceManager::new` is called and update to pass repos:

In `orchestrator/mod.rs` around line 48:
```rust
pub fn new(
    config: Arc<RwLock<EnsembleConfig>>,
    tracker: Arc<dyn IssueTracker>,
    agent_runner: Arc<dyn AgentRunner>,
    workspace_mgr: WorkspaceManager,
    shutdown_rx: mpsc::Receiver<()>,
) -> Self {
```

The workspace_mgr is passed in, so we need to update the caller.

Update startup_terminal_cleanup call to be async:

```rust
// Startup terminal workspace cleanup
{
    let config = self.config.read().await;
    startup_terminal_cleanup(
        self.tracker.as_ref(),
        &config.tracker.terminal_states,
        &self.workspace_mgr,
    )
    .await;
}
```

- [ ] **Step 2: Update workspace preparation call**

Find where `prepare_workspace` is called (around line 377) and make it async:

```rust
let workspace_result = workspace_mgr
    .prepare_workspace(&issue_clone.identifier)
    .await;
```

- [ ] **Step 3: Update reconciler to use async workspace operations**

In `orchestrator/reconciler.rs`, find where workspace operations are called and add `.await`.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/
git commit -m "feat: update orchestrator for async workspace with worktrees"
```

---

## Phase 3: Testing and Documentation

### Task 7: Integration Tests

**Files:**
- Modify: `crates/ensemble-core/tests/workflow_to_workspace.rs`
- Create: Additional integration test for multi-repo scenario

- [ ] **Step 1: Add worktree test to workflow_to_workspace.rs**

Add a test that includes repos configuration:

```rust
#[tokio::test]
async fn test_workflow_with_worktrees() {
    let dir = TempDir::new().unwrap();
    let ws_root = dir.path().join("workspaces");
    
    // Setup a git repo
    let repo_dir = dir.path().join("test-repo");
    std::fs::create_dir(&repo_dir).unwrap();
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();
    std::fs::write(repo_dir.join("README.md"), "# Test").unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(&repo_dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(&repo_dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    
    let yaml = format!(
        r#"
tracker:
  kind: github
  repository: acme/test-repo
  api_key: fake-token
workspace:
  root: {}
repos:
  - path: {}
    branch: main
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing."
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#,
        ws_root.display(),
        repo_dir.display()
    );
    
    let config = parse_config(&yaml).unwrap();
    assert_eq!(config.repos.len(), 1);
    
    // Create workspace manager with repos
    let mgr = WorkspaceManager::new(&ws_root, Some(config.repos.clone())).unwrap();
    
    let issue = sample_issue();
    let ws = mgr.prepare_workspace(&issue.identifier).await.unwrap();
    
    // Verify worktree was created
    assert!(!ws.worktrees.is_empty());
    let worktree_info = ws.worktrees.get("test-repo").expect("worktree should exist");
    assert!(worktree_info.path.exists());
    assert!(worktree_info.created_now);
    
    // Verify worktree has repo contents
    assert!(worktree_info.path.join("README.md").exists());
    
    // Cleanup
    mgr.remove_workspace(&issue.identifier).await.unwrap();
    assert!(!worktree_info.path.exists());
}
```

- [ ] **Step 2: Run integration tests**

```bash
cargo test -p ensemble-core --test workflow_to_workspace -- --nocapture
```

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/tests/
git commit -m "test: add integration tests for worktree-based workspaces"
```

---

### Task 8: Documentation Updates

**Files:**
- Modify: `SPEC.md` (workspace section)
- Modify: `README.md` (if applicable)

- [ ] **Step 1: Update SPEC.md workspace section**

Find the workspace section in SPEC.md and update to describe worktree behavior.

- [ ] **Step 2: Commit**

```bash
git add SPEC.md
git commit -m "docs: update SPEC with worktree-based workspace behavior"
```

---

## Summary

This implementation plan provides:

1. **Phase 1**: Core worktree infrastructure
   - Error types for worktree operations
   - Low-level git worktree commands
   - Multi-repo coordinator with rollback
   - PushStrategy configuration

2. **Phase 2**: Integration
   - WorkspaceManager enhanced with worktree support
   - Async workspace preparation
   - Orchestrator integration

3. **Phase 3**: Testing and documentation
   - Unit tests for all components
   - Integration tests
   - Documentation updates

**Key Design Decisions:**
- All-or-nothing worktree creation with rollback
- Date-based branch naming for chronological ordering
- Worktrees created in `.worktrees/` subdirectory of each repo
- Async throughout for non-blocking I/O
- Backward compatible (repos config optional)

**Testing Strategy:**
- Unit tests: Individual worktree operations
- Coordinator tests: Multi-repo scenarios, rollback
- Integration tests: Full pipeline with worktrees
- Mock git repos in temp directories for isolation
