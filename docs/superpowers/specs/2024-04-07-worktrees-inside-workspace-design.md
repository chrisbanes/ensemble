# Worktrees Inside Workspace Design

**Date**: 2024-04-07
**Status**: Approved

## Problem

Git worktrees are currently placed inside repositories at `<repo>/.worktrees/<branch>/`. This causes several issues:

1. Dirties the repository with `.worktrees/` directories
2. Requires manual `.gitignore` configuration
3. Accumulates across issues until manually cleaned
4. Mixes ensemble-managed files with user's repository

## Solution

Move worktrees inside the per-issue workspace directory, yielding:

```
<workspace.root>/<issue-id>/
├── .ensemble/
│   └── verdict.json
├── myproject/          ← worktree for myproject repo
│   ├── .git           ← gitfile pointing to repo
│   └── src/...
└── other-repo/         ← worktree for other-repo (if configured)
```

## Design

### Conceptual Model

- **Workspace**: Per-issue directory where agent runs
- **Worktree**: Git worktree (linked checkout) inside the workspace
- One workspace per issue, shared across all pipeline steps
- Worktrees for all configured repos go inside that workspace

### Implementation

#### 1. WorktreeCoordinator Changes

**File**: `crates/ensemble-core/src/workspace/coordinator.rs`

**Current**:
```rust
pub struct WorktreeCoordinator {
    repos: HashMap<String, RepoConfig>,
    base_date: String,
}
```

**New**:
```rust
pub struct WorktreeCoordinator {
    repos: HashMap<String, RepoConfig>,
    base_date: String,
    worktree_root: PathBuf,  // Parent directory for worktrees
}
```

**Constructor**: Accept `worktree_root` parameter (workspace path)

**Worktree path calculation**:
- Current: `<repo_path>/.worktrees/<branch>`
- New: `<worktree_root>/<repo_name>/<branch>`

#### 2. WorkspaceManager Changes

**File**: `crates/ensemble-core/src/workspace/manager.rs`

In `prepare_workspace`, after creating the workspace directory:

1. Create `WorktreeCoordinator` with `worktree_root = base_path.clone()`
2. Worktrees created under `base_path/<repo_name>/<branch>/`

**Removed**: Hardcoded `.worktrees` directory name in coordinator

#### 3. Config Schema

No changes required. The `workspace.root` config already defines where workspaces live, and worktrees go inside automatically.

```yaml
workspace:
  root: /tmp/ensemble_workspaces  # Worktrees go inside as ./<repo>/
```

#### 4. Cleanup

When removing a workspace via `remove_workspace`:
1. Coordinator calls `cleanup_worktrees` (removes worktrees from git, deletes branches)
2. Workspace directory is removed (including worktree directories)

Git cleanup remains the same - `git worktree remove --force` unregisters the worktree from git.

### Path Examples

**Before** (current):
```
/tmp/ensemble_workspaces/PROJ-42/              ← workspace
~/projects/myproject/.worktrees/ensemble-2024-04-07-PROJ-42/  ← worktree
```

**After** (proposed):
```
/tmp/ensemble_workspaces/PROJ-42/              ← workspace
/tmp/ensemble_workspaces/PROJ-42/myproject/    ← worktree inside workspace
```

### Multi-Repo Example

Config:
```yaml
repos:
  - path: /home/user/frontend
    branch: main
  - path: /home/user/backend
    branch: develop
```

Result:
```
PROJ-42/
├── frontend/      ← worktree for frontend repo
└── backend/       ← worktree for backend repo
```

### Edge Cases

1. **Workspace reuse on retry**: Worktrees already exist, pull latest base branch
2. **Empty repos config**: No worktrees created, workspace is just a directory
3. **Concurrent issues**: Each issue has its own workspace with its own worktrees

## Files to Modify

1. `crates/ensemble-core/src/workspace/coordinator.rs`
   - Add `worktree_root: PathBuf` field
   - Update constructor to accept worktree root
   - Change path calculation from `<repo>/.worktrees/` to `<worktree_root>/<repo_name>/`

2. `crates/ensemble-core/src/workspace/manager.rs`
   - Pass `base_path` as worktree root to coordinator
   - Coordinator created inside `prepare_workspace` after workspace exists

3. `crates/ensemble-core/src/workspace/worktree.rs`
   - No changes (pure git operations)

4. `crates/ensemble-core/src/workspace/mod.rs`
   - No changes (re-exports)

## Testing

1. Worktree created inside workspace directory
2. Multiple repos create multiple subdirectories
3. Workspace cleanup removes worktrees
4. Retry reuses existing worktrees
5. Git operations still work (worktrees properly linked)