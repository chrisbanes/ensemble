# Worktree-Based Workspaces Design

Date: 2026-03-30

## Overview

Ensemble orchestrates multi-agent pipelines where agents collaborate on the same codebase to complete issues. This design replaces plain workspace directories with git worktrees, enabling agents to work in isolated branches while sharing state across pipeline steps.

## Problem Statement

The current `WorkspaceManager` creates empty directories per issue. This doesn't work for git-based development where:
- Agents need to modify actual code
- Changes must persist across pipeline steps (e.g., implement → review)
- Parallel agents (multiple reviewers) need to see the same code state
- Changes should eventually be merged back to the main branch

## Design Goals

- **Isolation**: Each issue gets its own branch in each configured repository
- **Collaboration**: All agents for an issue share the same worktrees
- **Persistence**: Changes survive across retry cycles
- **Cleanup**: Automatic cleanup when work is merged
- **Multi-repo**: Support issues that span multiple repositories

## Architecture

### High-Level Flow

```
Pipeline Start (Issue #42)
    │
    ├─ For each RepoConfig:
    │   ├─ Check if worktree exists at .worktrees/ensemble-{date}-42
    │   ├─ If exists: git pull to refresh
    │   └─ If not: git worktree add -b ensemble-{date}-42
    │
    ├─ All-or-nothing: rollback on failure
    └─ Store worktree paths in PipelineRun context

Agent Execution
    │
    ├─ Agent receives {"repo-name": "/path/to/worktree", ...}
    └─ All agents share same worktrees across steps

Pipeline End (Success)
    │
    ├─ Based on push_strategy:
    │   ├─ ask: prompt user
    │   ├─ auto_push: push branch
    │   ├─ manual: leave local
    │   └─ pr_only: create PR
    └─ Cleanup worktrees on merge
```

### Components

#### 1. WorktreeCoordinator

A new component that manages worktree lifecycle across multiple repos:

```rust
pub struct WorktreeCoordinator {
    /// Map of repo name to RepoConfig
    repos: HashMap<String, RepoConfig>,
    /// Base date for branch naming (set at pipeline start)
    base_date: String,
}

pub struct WorktreeInfo {
    /// Absolute path to worktree
    pub path: PathBuf,
    /// Branch name (e.g., "ensemble-2026-03-30-my-repo-42")
    pub branch: String,
    /// Whether this was newly created
    pub created_now: bool,
}

impl WorktreeCoordinator {
    /// Prepare worktrees for all repos atomically
    pub fn prepare_worktrees(&self, issue_id: &str) -> Result<HashMap<String, WorktreeInfo>, WorktreeError>;
    
    /// Remove worktrees and delete branches
    pub fn cleanup_worktrees(&self, issue_id: &str) -> Result<(), WorktreeError>;
    
    /// List existing worktrees for an issue
    pub fn list_worktrees(&self, issue_id: &str) -> HashMap<String, PathBuf>;
}
```

#### 2. Enhanced WorkspaceManager

The existing `WorkspaceManager` gains worktree awareness:

```rust
pub struct WorkspaceManager {
    /// Base workspace root (for non-git work, logs, etc.)
    root: PathBuf,
    /// Worktree coordinator for multi-repo management
    worktree_coordinator: Option<WorktreeCoordinator>,
}

pub struct WorkspaceResult {
    /// Base workspace path (logs, artifacts)
    pub base_path: PathBuf,
    /// Map of repo name to worktree path
    pub worktrees: HashMap<String, PathBuf>,
    /// Whether any worktrees were newly created
    pub created_now: bool,
}
```

#### 3. PushStrategy Configuration

New enum added to `EnsembleConfig`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
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
```

**Note on "ask" mode:** This is intended for CLI/interactive usage where the user is present to respond. In daemon/server mode, "ask" should be treated as "manual" (log a warning that interactive mode is not available). The desktop GUI can implement its own prompting mechanism via the API.

YAML usage:
```yaml
push_strategy: ask  # or auto_push, manual, pr_only
```

### Branch Naming

Format: `ensemble-{YYYY-MM-DD}-{sanitized-issue-id}`

**Sanitization rules:**
- Replace all non-alphanumeric characters with `-`
- Collapse multiple consecutive `-` into single `-`
- Strip leading/trailing `-`
- Lowercase all characters

Examples:
- Issue "my-repo#42" → `ensemble-2026-03-30-my-repo-42`
- Issue "acme/api#123" → `ensemble-2026-03-30-acme-api-123`
- Issue "FEATURE_Add Dark Mode" → `ensemble-2026-03-30-feature-add-dark-mode`

The date prefix ensures chronological ordering and helps identify stale branches.

### Worktree Location

Worktrees are created within each repo under `.worktrees/`:

```
/Users/chris/code/acme-frontend/
├── .git/                    # main git repo
├── .worktrees/
│   └── ensemble-2026-03-30-my-repo-42/  # worktree for issue #42
│       └── (code files)
└── src/
    └── ...
```

This keeps worktrees:
- Near the original repo for easy access
- Hidden from normal directory listings
- Automatically ignored by git (`.worktrees/` in gitignore)

### Multi-Repo Coordination

For an issue spanning multiple repos:

```yaml
repos:
  - path: /Users/chris/code/acme-frontend
    branch: main
  - path: /Users/chris/code/acme-api
    branch: develop
```

Worktrees created:
- `/Users/chris/code/acme-frontend/.worktrees/ensemble-2026-03-30-issue-42/`
- `/Users/chris/code/acme-api/.worktrees/ensemble-2026-03-30-issue-42/`

All agents receive both paths and can work across repos.

### Error Handling

**All-or-Nothing Creation**: If creating worktrees for 3 repos and the 3rd fails:
1. Roll back by removing already-created worktrees
2. Delete partially-created branches
3. Return error to orchestrator
4. Pipeline fails before any agent runs

**Stale Worktree Detection**: If a worktree exists but the branch doesn't (corrupted state):
1. Log warning about corrupted state
2. Remove the orphaned worktree directory
3. Create fresh worktree

**Permission Errors**: If git commands fail due to permissions:
1. Return clear error with repo path
2. Suggest checking git credentials

### Retry Behavior

Retry cycles reuse existing worktrees:

```
Cycle 1:
  - Create worktrees
  - Agent implements feature
  - Review rejects → Retry scheduled

Cycle 2 (retry):
  - Reuse same worktrees (found at .worktrees/ensemble-{date}-42)
  - Changes from Cycle 1 still present
  - Agent continues from where we left off
```

This preserves partial progress across retries.

### Cleanup Lifecycle

Worktrees persist until the issue reaches a terminal success state:

```
Active States (Todo, In Progress):
  └─ Worktrees exist and are used

Failure (non-retryable):
  └─ Worktrees kept for debugging
  └─ Manual cleanup required

Success / Merged:
  └─ Remove worktrees
  └─ Delete ensemble-* branches (local and remote)
```

**Remote branch deletion:** Uses default remote (typically "origin"). Configurable via `git_remote` setting in `RepoConfig` (defaults to "origin").

Cleanup is triggered by tracker state transitions to `terminal_states`.

### Integration Points

#### Orchestrator Changes

1. **Pipeline Start**: Call `prepare_workspace()` which coordinates worktree creation
2. **Agent Dispatch**: Pass worktree paths to `AgentRunner`
3. **Pipeline End**: Based on `PushStrategy`, either prompt, push, or leave local
4. **Terminal Cleanup**: Remove worktrees when issue reaches terminal state

#### Agent Runner Changes

`AgentRunner::run()` signature updated:

```rust
async fn run(
    &self,
    issue: &Issue,
    agent_config: &AgentConfig,
    workspace: &WorkspaceResult,  // Now includes worktree paths
    prompt: &str,
) -> Result<Verdict, AgentError>;
```

Agent receives worktree paths via the prompt template or ACP context.

#### Template Variables

New template variable available:
- `repos.frontend` → `/path/to/frontend/worktree`
- `repos.api` → `/path/to/api/worktree`

Template usage:
```liquid
You are working on {{ issue.identifier }}: {{ issue.title }}

Code locations:
{% for repo in repos %}- {{ repo.name }}: {{ repo.path }}
{% endfor %}
```

## Implementation Phases

### Phase 1: Core Worktree Management
- Add `WorktreeCoordinator` struct
- Implement worktree creation and cleanup
- Add `PushStrategy` to config
- Update `WorkspaceManager` integration

### Phase 2: Orchestrator Integration
- Modify pipeline start to prepare worktrees
- Pass worktree paths to agents
- Implement push strategy logic
- Add terminal state cleanup

### Phase 3: Template and Agent Integration
- Add repo paths to template variables
- Update agent runner to pass worktree context
- Test with acpx agent protocol

### Phase 4: Testing and Edge Cases
- Test multi-repo scenarios
- Test retry cycles
- Test cleanup on various states
- Error handling validation

## Migration Path

Existing configs without `repos` field continue using plain directories (backward compatible). When no `repos` are configured:
- `WorkspaceManager` creates plain directories as before
- Worktree coordination is skipped entirely
- Agents work in empty directories (useful for non-git workflows)

To enable worktrees, users add:

```yaml
repos:
  - path: /path/to/repo
    branch: main
```

**Mid-pipeline migration:** If a user adds `repos` while pipelines are running:
- Existing plain-directory workspaces continue to completion
- New issues use worktree mode
- No automatic migration of in-flight issues (manual retry required)

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Large repos, slow worktree creation | Async creation with timeout; show progress |
| Git version compatibility | Document minimum git version (2.5+ for worktrees) |
| Disk space from many worktrees | Cleanup on merge; configurable retention |
| Branch name collisions | Date prefix + sanitized issue ID |
| Partial worktree creation failure | All-or-nothing with rollback |

## Testing Strategy

- **Unit tests**: `WorktreeCoordinator` worktree creation/cleanup
- **Integration tests**: Full pipeline with worktrees across multiple repos
- **Edge cases**: Retry cycles, stale worktrees, permission errors
- **E2E tests**: Real git repos in temp directories

## Success Criteria

- [ ] Agents can modify code in worktrees
- [ ] Changes persist across pipeline steps
- [ ] Retry cycles reuse existing worktrees
- [ ] Worktrees cleaned up on merge
- [ ] Multi-repo issues work correctly
- [ ] All-or-nothing creation prevents partial states
- [ ] Push strategy respects user preference
