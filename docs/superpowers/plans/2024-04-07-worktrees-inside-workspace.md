# Worktrees Inside Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move git worktrees from `<repo>/.worktrees/<branch>/` to `<workspace.root>/<issue>/<repo>/<branch>/`, placing them inside the per-issue workspace directory.

**Architecture:** Add `worktree_root` parameter to `WorktreeCoordinator`, compute worktree paths as `<worktree_root>/<repo_name>/<branch>` instead of `<repo>/.worktrees/<branch>`. `WorkspaceManager` passes workspace directory as worktree root.

**Tech Stack:** Rust, async/await, tokio, tempfile(testing)

---

## File Structure

**Modified files:**
- `crates/ensemble-core/src/workspace/coordinator.rs` - Add worktree_root field, change path calculation
- `crates/ensemble-core/src/workspace/manager.rs` - Pass workspace path as worktree root

**Unchanged files:**
- `crates/ensemble-core/src/workspace/worktree.rs` - Pure git operations, no changes
- `crates/ensemble-core/src/workspace/mod.rs` - Re-exports only

---

### Task 1: Add worktree_root to WorktreeCoordinator

**Files:**
- Modify: `crates/ensemble-core/src/workspace/coordinator.rs`

- [ ] **Step 1: Write failing test for new constructor signature**

Create test that passes worktree_root:

```rust
#[test]
fn test_coordinator_uses_worktree_root() {
    let mut repos = HashMap::new();
    repos.insert(
        "myproject".to_string(),
        RepoConfig {
            path: "/path/to/project".to_string(),
            branch: "main".to_string(),
            git_remote: "origin".to_string(),
        },
    );
    let worktree_root = PathBuf::from("/tmp/workspaces/PROJ-42");
    let coordinator = WorktreeCoordinator::new(repos, "2024-04-07".to_string(), worktree_root);
    
    let paths = coordinator.list_worktree_paths("PROJ-42");
    assert_eq!(
        paths.get("myproject"),
        Some(&PathBuf::from("/tmp/workspaces/PROJ-42/myproject"))
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --package ensemble-core test_coordinator_uses_worktree_root 2>&1`

Expected: Compilation error - `WorktreeCoordinator::new` takes wrong number of arguments

- [ ] **Step 3: Add worktree_root field to struct**

```rust
pub struct WorktreeCoordinator {
    repos: HashMap<String, RepoConfig>,
    base_date: String,
    worktree_root: PathBuf,  // NEW
}
```

- [ ] **Step 4: Update constructor signature**

```rust
impl WorktreeCoordinator {
    pub fn new(
        repos: HashMap<String, RepoConfig>,
        base_date: String,
        worktree_root: PathBuf,  // NEW
    ) -> Self {
        Self {
            repos,
            base_date,
            worktree_root,
        }
    }
```

- [ ] **Step 5: Update list_worktree_paths to use worktree_root**

```rust
pub fn list_worktree_paths(&self, issue_id: &str) -> HashMap<String, PathBuf> {
    let branch = self.format_branch_name(issue_id);
    let mut paths = HashMap::new();

    for (repo_name, _repo_config) in &self.repos {
        let worktree_path = self.worktree_root.join(repo_name).join(&branch);
        paths.insert(repo_name.clone(), worktree_path);
    }

    paths
}
```

- [ ] **Step 6: Update prepare_worktrees path calculation**

In `prepare_worktrees`, change:
```rust
// OLD:
let worktree_path = repo_path.join(".worktrees").join(&branch);

// NEW:
let worktree_path = self.worktree_root.join(repo_name).join(&branch);
```

- [ ] **Step 7: Update cleanup_worktrees path calculation**

In `cleanup_worktrees`, change:
```rust
// OLD:
let worktree_path = repo_path.join(".worktrees").join(&branch);

// NEW:
let worktree_path = self.worktree_root.join(repo_name).join(&branch);
```

- [ ] **Step 8: Run tests to verify compilation and basic tests pass**

Run: `cargo test --package ensemble-core -- coordinator::tests 2>&1`

Expected: All coordinator tests pass

- [ ] **Step 9: Commit changes tocoordinator**

```bash
git add crates/ensemble-core/src/workspace/coordinator.rs
git commit -m "feat(workspace): add worktree_root parameter to WorktreeCoordinator

- Add worktree_root field to WorktreeCoordinator struct
- Change worktree path calculation from <repo>/.worktrees/ to <worktree_root>/<repo>/
- Update constructor and path methods to use worktree_root"
```

---

### Task 2: Update WorkspaceManager to pass workspace path

**Files:**
- Modify: `crates/ensemble-core/src/workspace/manager.rs`

- [ ] **Step 1: Write failing test for workspace-internal worktrees**

```rust
#[tokio::test]
async fn test_worktrees_inside_workspace() {
    let repo_dir = tempfile::TempDir::new().unwrap();
    init_git_repo(&repo_dir).await;
    
    let workspace_root = tempfile::TempDir::new().unwrap();
    let repos = vec![RepoConfig {
        path: repo_dir.path().display().to_string(),
        branch: "main".to_string(),
        git_remote: "origin".to_string(),
    }];
    
    let mgr = WorkspaceManager::new(workspace_root.path(), Some(repos)).unwrap();
    let result = mgr.prepare_workspace("TEST-1").await.unwrap();
    
    // Worktree should be inside workspace
    let expected_worktree = result.base_path.join("repo");  // repo name from basename
    assert!(expected_worktree.exists());
}
```

- [ ] **Step 2: Run test to verify it fails or shows current behavior**

Run: `cargo test --package ensemble-core test_worktrees_inside_workspace 2>&1`

Expected: Test fails because worktrees are created in `<repo>/.worktrees/` not inside workspace

- [ ] **Step 3: Update WorkspaceManager to store repos HashMap instead of coordinator**

The key insight: `WorktreeCoordinator` needs the specific workspace directory (`root/workspace_key/`), not just the root. This is only known when `prepare_workspace` is called.

Change `WorkspaceManager` to store `repos` HashMap instead of `WorktreeCoordinator`:

```rust
pub struct WorkspaceManager {
    root: PathBuf,
    repos: HashMap<String, RepoConfig>,  // Changed from WorktreeCoordinator
}

impl WorkspaceManager {
    pub fn new(root: &Path, repos: Option<Vec<RepoConfig>>) -> Result<Self, WorkspaceError> {
        // ... root normalization ...
        
        let repos_map = repos
            .filter(|r| !r.is_empty())
            .map(|repo_list| {
                let mut map = HashMap::new();
                for (index, repo) in repo_list.into_iter().enumerate() {
                    let name = Path::new(&repo.path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("repo-{index}"));
                    map.insert(name, repo);
                }
                map
            })
            .unwrap_or_default();

        Ok(Self {
            root,
            repos: repos_map,
        })
    }
```

- [ ] **Step 4: Create coordinator in prepare_workspace**

In `prepare_workspace`, create coordinator with workspace-specific path:

```rust
pub async fn prepare_workspace(
    &self,
    identifier: &str,
) -> Result<WorkspaceResult, WorkspaceError> {
    let workspace_key =
        sanitize_workspace_key(identifier).ok_or_else(|| WorkspaceError::CreationFailed {
            reason: format!("unsafe workspace key from identifier: {identifier:?}"),
        })?;
    let base_path = self.root.join(&workspace_key);

    // ... create directory ...

    // Prepare worktrees if repos configured
    let worktrees = if !self.repos.is_empty() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let coordinator = WorktreeCoordinator::new(
            self.repos.clone(),
            today,
            base_path.clone(),// Worktrees go inside this workspace
        );
        coordinator
            .prepare_worktrees(identifier)
            .await
            .map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("worktree preparation failed: {e}"),
            })?
    } else {
        HashMap::new()
    };

    // ... rest of method ...
}
```

- [ ] **Step 5: Update remove_workspace similarly**

In `remove_workspace`:

```rust
pub async fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
    // ... sanitize and validate ...

    // Clean up worktrees first
    if !self.repos.is_empty() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let workspace_key = sanitize_workspace_key(identifier).ok_or_else(|| {
            WorkspaceError::CreationFailed {
                reason: format!("unsafe workspace key: {identifier:?}"),
            }
        })?;
        let base_path = self.root.join(&workspace_key);
        
        let coordinator = WorktreeCoordinator::new(
            self.repos.clone(),
            today,
            base_path,
        );
        coordinator
            .cleanup_worktrees(identifier)
            .await
            .map_err(|e| WorkspaceError::CreationFailed {
                reason: format!("worktree cleanup failed: {e}"),
            })?;
    }

    // Remove base workspace
    // ...existing code ...
}
```

- [ ] **Step 6: Run manager tests**

Run: `cargo test --package ensemble-core --workspace::manager::tests 2>&1`

Expected: Tests pass (may need fixture updates for new behavior)

- [ ] **Step 7: Run coordinator tests**

Run: `cargo test --package ensemble-core --workspace::coordinator::tests 2>&1`

Expected: Tests pass

- [ ] **Step 8: Run all workspace tests**

Run: `cargo test --package ensemble-core --workspace: 2>&1`

Expected: All workspace tests pass

- [ ] **Step 9: Commit manager changes**

```bash
git add crates/ensemble-core/src/workspace/manager.rs
git commit -m "feat(workspace): create worktrees inside workspace directory

- Move WorktreeCoordinator creation to prepare_workspace
- Pass workspace-specific path as worktree_root
- Worktrees now live at <workspace>/<repo>/<branch>"
```

---

### Task 3: Update integration tests

**Files:**
- Modify: `crates/ensemble-core/tests/workflow_to_workspace.rs` (if exists)

- [ ] **Step 1: Check for integration tests**

Run: `find crates -name "*.rs" -path "*/tests/*" | head -20`

- [ ] **Step 2: Update any integration tests that check worktree paths**

If tests check for `.worktrees/` paths, update to expect workspace-internal paths.

- [ ] **Step 3: Run full test suite**

Run: `cargo test --workspace --exclude ensemble-desktop 2>&1`

Expected: All tests pass

---

### Task 4: Final verification

- [ ] **Step 1: Run clippy**

Run: `cargo clippy --workspace --exclude ensemble-desktop -- -D warnings 2>&1`

Expected: No warnings

- [ ] **Step 2: Run format check**

Run: `cargo fmt --all -- --check 2>&1`

Expected: No errors

- [ ] **Step 3: Commit final verification**

```bash
git commit --allow-empty -m "chore: verify worktrees-inside-workspace implementation"
```

---

## Testing Checklist

After implementation:

- [ ] Worktree created inside workspace directory (`<workspace>/<repo>/`)
- [ ] Multiple repos create multiple subdirectories (`<workspace>/frontend/`, `<workspace>/backend/`)
- [ ] Workspace cleanup removes worktrees
- [ ] Retry reuses existing worktrees
- [ ] Git operations still work (worktrees properly linked)
- [ ] Branch names sanitized correctly
- [ ] Coordinator path calculation uses worktree_root

---

## Files Modified Summary

1. `coordinator.rs` - Add worktree_root field, update path calculations
2. `manager.rs` - Move coordinator creation to prepare_workspace, pass workspace path

## Backward Compatibility Note

No migration path provided. Existing `.worktrees/` directories in repos should be manually cleaned if desired.