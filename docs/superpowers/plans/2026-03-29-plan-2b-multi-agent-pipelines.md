# Multi-Agent Pipelines and Tracker Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tracker write support, `ensemble.yaml` config format, DAG-based pipeline engine, and verdict contract to the Ensemble orchestrator.

**Architecture:** Extend `IssueTracker` trait with default no-op write methods (`set_issue_state`, `add_comment`). Replace `WORKFLOW.md`/`ServiceConfig` with `ensemble.yaml`/`EnsembleConfig` containing named agents and a step DAG. Add a pipeline engine that executes steps per-issue, collects verdicts (ACP or file-based), and writes tracker state at step boundaries.

**Tech Stack:** Rust 2021, tokio, serde/serde_yaml, thiserror, async-trait, liquid, tempfile (tests)

**Spec:** `SPEC.md` (Sections 4-5, 11.5) and `docs/superpowers/specs/2026-03-28-ensemble-implementation-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `crates/ensemble-core/src/config/ensemble.rs` | Parse `ensemble.yaml` into `EnsembleConfig` with validation |
| `crates/ensemble-core/src/pipeline/mod.rs` | Re-export pipeline submodules |
| `crates/ensemble-core/src/pipeline/dag.rs` | Build step DAG, topological sort, cycle detection |
| `crates/ensemble-core/src/pipeline/engine.rs` | `PipelineRun` per-issue execution state machine |
| `crates/ensemble-core/src/pipeline/verdict.rs` | Parse verdicts from ACP events or `.ensemble/verdict.json` |

### Modified Files

| File | Changes |
|------|---------|
| `crates/ensemble-core/src/error.rs` | Add `PipelineError` enum |
| `crates/ensemble-core/src/tracker/mod.rs` | Add `WritesNotSupported` to `TrackerError`, add default write methods to `IssueTracker`, update `create_tracker` to accept `TrackerConfig` |
| `crates/ensemble-core/src/tracker/todo_file.rs` | Implement `set_issue_state` (file rewrite) |
| `crates/ensemble-core/src/tracker/github.rs` | Implement `set_issue_state` (GraphQL mutation), `add_comment` |
| `crates/ensemble-core/src/config/mod.rs` | Add `pub mod ensemble;`, remove `pub mod workflow; pub mod typed;` |
| `crates/ensemble-core/src/lib.rs` | Add `pub mod pipeline;` |

### Removed Files

| File | Reason |
|------|--------|
| `crates/ensemble-core/src/config/workflow.rs` | Replaced by `ensemble.yaml` loader |
| `crates/ensemble-core/src/config/typed.rs` | Replaced by `EnsembleConfig` |

---

## Task 1: Add `PipelineError` and `WritesNotSupported` Error Types

**Files:**
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/tracker/mod.rs`

- [ ] **Step 1: Add `PipelineError` enum to `error.rs`**

Add after `WorkspaceError`:

```rust
#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("unknown agent reference: {name}")]
    UnknownAgent { name: String },
    #[error("unknown step dependency: {step} depends on {dependency}")]
    UnknownDependency { step: String, dependency: String },
    #[error("cycle detected in step graph")]
    CycleDetected,
    #[error("no root steps found (all steps have dependencies)")]
    NoRootSteps,
    #[error("step {step} requires tracker writes but tracker does not support them")]
    WritesRequired { step: String },
    #[error("max cycles ({max}) exceeded for issue {issue_id}")]
    MaxCyclesExceeded { issue_id: String, max: u32 },
    #[error("agent must have exactly one of 'prompt' or 'prompt_template', got neither or both: {agent}")]
    InvalidPromptConfig { agent: String },
}
```

Add `Pipeline` variant to `EnsembleError`:

```rust
#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Tracker(#[from] crate::tracker::TrackerError),
    #[error(transparent)]
    Pipeline(#[from] PipelineError),
}
```

- [ ] **Step 2: Add `WritesNotSupported` to `TrackerError`**

In `crates/ensemble-core/src/tracker/mod.rs`, add to the `TrackerError` enum:

```rust
#[error("tracker does not support write operations")]
WritesNotSupported,
```

- [ ] **Step 3: Build and verify**

Run: `cargo build --workspace`
Expected: compiles cleanly (warning about unused variant is OK at this stage)

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/error.rs crates/ensemble-core/src/tracker/mod.rs
git commit -m "feat: add PipelineError and WritesNotSupported error types"
```

---

## Task 2: Add Write Methods to `IssueTracker` Trait

**Files:**
- Modify: `crates/ensemble-core/src/tracker/mod.rs`

- [ ] **Step 1: Add default write methods to the `IssueTracker` trait**

Add these methods below the existing three read methods in the trait definition:

```rust
/// Whether this tracker supports write operations.
fn supports_writes(&self) -> bool {
    false
}

/// Transition an issue to the given state in the tracker.
async fn set_issue_state(&self, _id: &str, _state: &str) -> Result<(), TrackerError> {
    Err(TrackerError::WritesNotSupported)
}

/// Add a comment to an issue in the tracker.
async fn add_comment(&self, _id: &str, _body: &str) -> Result<(), TrackerError> {
    Err(TrackerError::WritesNotSupported)
}
```

- [ ] **Step 2: Build and verify**

Run: `cargo build --workspace`
Expected: compiles. Existing `TodoFileTracker` and `GithubTracker` impls compile without changes because the new methods have defaults.

- [ ] **Step 3: Add a test for the default behavior**

Add to the `#[cfg(test)] mod tests` in `tracker/mod.rs`:

```rust
#[tokio::test]
async fn test_default_write_methods_return_not_supported() {
    struct ReadOnlyTracker;

    #[async_trait]
    impl IssueTracker for ReadOnlyTracker {
        async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(vec![])
        }
        async fn fetch_issues_by_states(&self, _: &[String]) -> Result<Vec<Issue>, TrackerError> {
            Ok(vec![])
        }
        async fn fetch_issue_states_by_ids(&self, _: &[String]) -> Result<Vec<Issue>, TrackerError> {
            Ok(vec![])
        }
    }

    let tracker = ReadOnlyTracker;
    assert!(!tracker.supports_writes());
    assert!(matches!(
        tracker.set_issue_state("id", "Done").await,
        Err(TrackerError::WritesNotSupported)
    ));
    assert!(matches!(
        tracker.add_comment("id", "hello").await,
        Err(TrackerError::WritesNotSupported)
    ));
}
```

- [ ] **Step 4: Run test**

Run: `cargo test --workspace -p ensemble-core -- test_default_write_methods`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/tracker/mod.rs
git commit -m "feat: add default write methods to IssueTracker trait"
```

---

## Task 3: Implement `set_issue_state` for `TodoFileTracker`

**Files:**
- Modify: `crates/ensemble-core/src/tracker/todo_file.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `todo_file.rs`:

```rust
#[tokio::test]
async fn test_set_issue_state_moves_issue() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("TODO.md");
    std::fs::write(
        &path,
        "## Todo\n\n- [PROJ-1] First task\n\n## In Progress\n\n- [PROJ-2] Second task\n",
    )
    .unwrap();

    let tracker = TodoFileTracker::new(
        path.clone(),
        vec!["Todo".to_string(), "In Progress".to_string()],
    );

    tracker.set_issue_state("PROJ-1", "In Progress").await.unwrap();

    let content = std::fs::read_to_string(&path).unwrap();
    assert!(!content.contains("## Todo\n\n- [PROJ-1]"), "PROJ-1 should be removed from Todo");
    assert!(content.contains("- [PROJ-1] First task"), "PROJ-1 should still exist");
    // Verify it's under In Progress
    let in_progress_pos = content.find("## In Progress").unwrap();
    let proj1_pos = content.find("- [PROJ-1] First task").unwrap();
    assert!(proj1_pos > in_progress_pos, "PROJ-1 should be under In Progress");
}

#[tokio::test]
async fn test_set_issue_state_creates_new_heading() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("TODO.md");
    std::fs::write(&path, "## Todo\n\n- [PROJ-1] A task\n").unwrap();

    let tracker = TodoFileTracker::new(path.clone(), vec!["Todo".to_string()]);

    tracker.set_issue_state("PROJ-1", "Done").await.unwrap();

    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.contains("## Done"), "Should create Done heading");
    assert!(content.contains("- [PROJ-1] A task"), "Issue should exist under Done");
}

#[test]
fn test_supports_writes_true() {
    let tracker = TodoFileTracker::new(PathBuf::from("TODO.md"), vec![]);
    assert!(tracker.supports_writes());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p ensemble-core -- test_set_issue_state`
Expected: FAIL — `set_issue_state` returns `WritesNotSupported` by default

- [ ] **Step 3: Implement `set_issue_state` and `supports_writes`**

Add these method implementations to the `#[async_trait] impl IssueTracker for TodoFileTracker` block:

```rust
fn supports_writes(&self) -> bool {
    true
}

async fn set_issue_state(&self, id: &str, target_state: &str) -> Result<(), TrackerError> {
    let content = tokio::fs::read_to_string(&self.path)
        .await
        .map_err(|e| TrackerError::IoError {
            reason: e.to_string(),
        })?;

    let mut lines: Vec<&str> = content.lines().collect();

    // Find the issue line(s) — match by [ID] at start of list item
    let marker = format!("[{}]", id);
    let mut issue_lines: Vec<String> = Vec::new();
    let mut remove_indices: Vec<usize> = Vec::new();
    let mut found = false;

    for (i, line) in lines.iter().enumerate() {
        if !found {
            let trimmed = line.trim_start_matches("- ").trim();
            if trimmed.starts_with(&marker) {
                found = true;
                issue_lines.push(line.to_string());
                remove_indices.push(i);
            }
        } else {
            // Continuation lines: indented, not a new list item or heading
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("- ") || trimmed.starts_with("## ") {
                break;
            }
            issue_lines.push(line.to_string());
            remove_indices.push(i);
        }
    }

    if issue_lines.is_empty() {
        return Err(TrackerError::IoError {
            reason: format!("issue not found: {}", id),
        });
    }

    // Remove issue from its current position (reverse to preserve indices)
    for &idx in remove_indices.iter().rev() {
        lines.remove(idx);
    }

    // Find or create the target heading
    let heading = format!("## {}", target_state);
    let insert_pos = if let Some(pos) = lines.iter().position(|l| *l == heading) {
        // Insert after the heading (skip any blank line after heading)
        let mut insert = pos + 1;
        if insert < lines.len() && lines[insert].trim().is_empty() {
            insert += 1;
        }
        insert
    } else {
        // Append new heading at end of file
        if !lines.is_empty() && !lines.last().unwrap().is_empty() {
            lines.push("");
        }
        lines.push(&heading);
        lines.push("");
        lines.len()
    };

    // Insert the issue lines at the target position
    for (offset, issue_line) in issue_lines.iter().enumerate() {
        lines.insert(insert_pos + offset, issue_line);
    }

    // Write back
    let new_content = lines.join("\n") + "\n";
    tokio::fs::write(&self.path, new_content)
        .await
        .map_err(|e| TrackerError::IoError {
            reason: e.to_string(),
        })?;

    Ok(())
}
```

Note: The above uses `&self.path` — the `TodoFileTracker` struct already has a `path: PathBuf` field from Plan 2 implementation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p ensemble-core -- test_set_issue_state test_supports_writes_true`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cargo test --workspace`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/tracker/todo_file.rs
git commit -m "feat: implement set_issue_state for TodoFileTracker"
```

---

## Task 4: Implement Write Methods for `GithubTracker`

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs`

This task adds `supports_writes`, `set_issue_state`, and `add_comment` to the GitHub tracker. The project board mode uses a GraphQL mutation to update the Status field. The repo mode updates labels. Both modes use `addComment` for comments.

- [ ] **Step 1: Add `supports_writes` to the `IssueTracker` impl**

```rust
fn supports_writes(&self) -> bool {
    true
}
```

- [ ] **Step 2: Add GraphQL mutation constants**

Add these constants alongside the existing query constants in `github.rs`:

```rust
const ADD_COMMENT_MUTATION: &str = r#"
mutation($subjectId: ID!, $body: String!) {
  addComment(input: {subjectId: $subjectId, body: $body}) {
    commentEdge {
      node {
        id
      }
    }
  }
}
"#;

const UPDATE_PROJECT_ITEM_FIELD_MUTATION: &str = r#"
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item {
      id
    }
  }
}
"#;

const ADD_LABEL_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable {
      ... on Issue { id }
    }
  }
}
"#;

const REMOVE_LABEL_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable {
      ... on Issue { id }
    }
  }
}
"#;
```

- [ ] **Step 3: Implement `add_comment`**

Add to the `IssueTracker` impl for `GithubTracker`:

```rust
async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
    let variables = serde_json::json!({
        "subjectId": id,
        "body": body,
    });
    self.graphql_request(ADD_COMMENT_MUTATION, Some(variables)).await?;
    Ok(())
}
```

- [ ] **Step 4: Implement `set_issue_state`**

Add to the `IssueTracker` impl for `GithubTracker`. This needs to handle both project board mode (update Status field) and repo mode (swap labels). Use the cached `status_field_id` and `status_option_ids` from the existing project discovery query.

```rust
async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
    if self.project_number.is_some() {
        // Project board mode: update Status field via mutation
        let project_id = self.project_node_id.as_ref().ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "project node ID not discovered".to_string(),
            }
        })?;
        let field_id = self.status_field_id.as_ref().ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "status field ID not discovered".to_string(),
            }
        })?;
        let option_id = self
            .status_option_ids
            .get(state)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!("unknown status option: {}", state),
            })?;

        // We need the project item ID, not the issue node ID.
        // The `id` passed here is the issue node ID. We need to look up the
        // project item ID. For now, search running items.
        // This requires fetching the item ID — use a lookup query.
        let item_id = self.find_project_item_id(id).await?;

        let variables = serde_json::json!({
            "projectId": project_id,
            "itemId": item_id,
            "fieldId": field_id,
            "optionId": option_id,
        });
        self.graphql_request(UPDATE_PROJECT_ITEM_FIELD_MUTATION, Some(variables)).await?;
    } else {
        // Repo mode: swap labels
        // Remove labels matching any active/terminal state, add the target state label
        // This requires label node IDs — use a lookup query for the repo's labels.
        // For simplicity, use the REST-style label names approach via GraphQL.
        tracing::warn!(
            issue_id = id,
            target_state = state,
            "set_issue_state in repo mode: label-based state transitions not yet implemented"
        );
        return Err(TrackerError::WritesNotSupported);
    }
    Ok(())
}
```

Note: The project item ID lookup (`find_project_item_id`) and repo-mode label swaps are complex GraphQL operations. Implement `find_project_item_id` as a helper that queries the project for the item containing the given issue node ID. Repo-mode label swaps can be deferred as they require resolving label node IDs from names — log a warning and return `WritesNotSupported` for now.

- [ ] **Step 5: Add `find_project_item_id` helper**

Add a private method to `GithubTracker`:

```rust
const FIND_PROJECT_ITEM_QUERY: &str = r#"
query($nodeId: ID!) {
  node(id: $nodeId) {
    ... on Issue {
      projectItems(first: 10) {
        nodes {
          id
          project {
            id
          }
        }
      }
    }
  }
}
"#;

async fn find_project_item_id(&self, issue_node_id: &str) -> Result<String, TrackerError> {
    let variables = serde_json::json!({ "nodeId": issue_node_id });
    let data = self.graphql_request(FIND_PROJECT_ITEM_QUERY, Some(variables)).await?;

    let project_id = self.project_node_id.as_ref().ok_or_else(|| {
        TrackerError::UnexpectedPayload {
            reason: "project node ID not set".to_string(),
        }
    })?;

    let items = data
        .pointer("/node/projectItems/nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| TrackerError::UnexpectedPayload {
            reason: "missing projectItems in response".to_string(),
        })?;

    for item in items {
        if let Some(proj_id) = item.pointer("/project/id").and_then(|v| v.as_str()) {
            if proj_id == project_id {
                if let Some(item_id) = item.get("id").and_then(|v| v.as_str()) {
                    return Ok(item_id.to_string());
                }
            }
        }
    }

    Err(TrackerError::UnexpectedPayload {
        reason: format!("issue {} not found in project", issue_node_id),
    })
}
```

- [ ] **Step 6: Build and verify**

Run: `cargo build --workspace`
Expected: compiles. Wiremock-based tests for the mutations can be added later when the pipeline engine exercises these paths.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/tracker/github.rs
git commit -m "feat: implement write methods for GithubTracker (project board mode)"
```

---

## Task 5: Add `EnsembleConfig` and Replace `ServiceConfig`

**Files:**
- Create: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Modify: `crates/ensemble-core/src/tracker/mod.rs` (update `create_tracker` signature)

- [ ] **Step 1: Write the failing test for `EnsembleConfig` parsing**

Create `crates/ensemble-core/src/config/ensemble.rs` with test-first content:

```rust
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::error::PipelineError;

#[derive(Debug, Clone, Deserialize)]
pub struct EnsembleConfig {
    pub tracker: TrackerConfig,
    pub agents: HashMap<String, AgentConfig>,
    pub steps: Vec<StepConfig>,
    pub on_success: String,
    pub on_failure: String,
    #[serde(default)]
    pub concurrency: ConcurrencyConfig,
    #[serde(default = "default_max_cycles")]
    pub max_cycles: u32,
    #[serde(default)]
    pub polling: PollingConfig,
    #[serde(default)]
    pub workspace: WorkspaceConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub agent: AgentRuntimeConfig,
}

fn default_max_cycles() -> u32 {
    3
}

#[derive(Debug, Clone, Deserialize)]
pub struct TrackerConfig {
    pub kind: String,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub repository: Option<String>,
    pub project_number: Option<i64>,
    #[serde(default)]
    pub labels_filter: Vec<String>,
}

fn default_active_states() -> Vec<String> {
    vec!["Todo".to_string(), "In Progress".to_string()]
}

fn default_terminal_states() -> Vec<String> {
    vec!["Done".to_string(), "Closed".to_string()]
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub executor: String,
    pub model: String,
    pub prompt: Option<String>,
    pub prompt_template: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StepConfig {
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub depends: Vec<String>,
    pub tracker_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConcurrencyConfig {
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_agents: u32,
    #[serde(default = "default_max_step_parallelism")]
    pub max_step_parallelism: u32,
}

fn default_max_concurrent() -> u32 {
    4
}

fn default_max_step_parallelism() -> u32 {
    2
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: default_max_concurrent(),
            max_step_parallelism: default_max_step_parallelism(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PollingConfig {
    #[serde(default = "default_poll_interval")]
    pub interval_ms: u64,
}

fn default_poll_interval() -> u64 {
    30_000
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            interval_ms: default_poll_interval(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WorkspaceConfig {
    pub root: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HooksConfig {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    #[serde(default = "default_hook_timeout")]
    pub timeout_ms: u64,
}

fn default_hook_timeout() -> u64 {
    60_000
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentRuntimeConfig {
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_max_retry_backoff")]
    pub max_retry_backoff_ms: u64,
    #[serde(default = "default_agent_command")]
    pub command: String,
    #[serde(default = "default_session_mode")]
    pub session_mode: String,
    #[serde(default = "default_permission_policy")]
    pub permission_policy: String,
    #[serde(default = "default_turn_timeout")]
    pub turn_timeout_ms: u64,
    #[serde(default = "default_read_timeout")]
    pub read_timeout_ms: u64,
    #[serde(default = "default_stall_timeout")]
    pub stall_timeout_ms: i64,
}

fn default_max_turns() -> u32 { 20 }
fn default_max_retry_backoff() -> u64 { 300_000 }
fn default_agent_command() -> String { "claude-code".to_string() }
fn default_session_mode() -> String { "code".to_string() }
fn default_permission_policy() -> String { "auto_approve_all".to_string() }
fn default_turn_timeout() -> u64 { 3_600_000 }
fn default_read_timeout() -> u64 { 5_000 }
fn default_stall_timeout() -> i64 { 300_000 }

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_turns: default_max_turns(),
            max_retry_backoff_ms: default_max_retry_backoff(),
            command: default_agent_command(),
            session_mode: default_session_mode(),
            permission_policy: default_permission_policy(),
            turn_timeout_ms: default_turn_timeout(),
            read_timeout_ms: default_read_timeout(),
            stall_timeout_ms: default_stall_timeout(),
        }
    }
}

/// Load and parse an `ensemble.yaml` file.
pub fn load_config(path: &std::path::Path) -> Result<EnsembleConfig, crate::error::ConfigError> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        crate::error::ConfigError::MissingWorkflowFile {
            path: path.display().to_string(),
        }
    })?;
    parse_config(&content)
}

/// Parse an `ensemble.yaml` string into `EnsembleConfig`.
pub fn parse_config(yaml: &str) -> Result<EnsembleConfig, crate::error::ConfigError> {
    serde_yaml::from_str(yaml).map_err(|e| crate::error::ConfigError::WorkflowParseError {
        reason: e.to_string(),
    })
}

/// Validate an `EnsembleConfig` for structural correctness.
/// Checks agent prompt configs and step references. Does NOT validate the DAG
/// (that's done in `pipeline::dag`).
pub fn validate_config(config: &EnsembleConfig) -> Result<(), PipelineError> {
    // Each agent must have exactly one of prompt or prompt_template
    for (name, agent) in &config.agents {
        match (&agent.prompt, &agent.prompt_template) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(PipelineError::InvalidPromptConfig {
                    agent: name.clone(),
                });
            }
            _ => {}
        }
    }

    // Each step must reference a valid agent
    for step in &config.steps {
        if !config.agents.contains_key(&step.agent) {
            return Err(PipelineError::UnknownAgent {
                name: step.agent.clone(),
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minimal_config() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: sonnet-4
    prompt: "Build the thing."
steps:
  - name: build
    agent: builder
on_success: "Done"
on_failure: "Failed"
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.tracker.kind, "todo_file");
        assert_eq!(config.agents.len(), 1);
        assert_eq!(config.steps.len(), 1);
        assert_eq!(config.on_success, "Done");
        assert_eq!(config.on_failure, "Failed");
        assert_eq!(config.max_cycles, 3);
        assert_eq!(config.concurrency.max_concurrent_agents, 4);
        assert_eq!(config.concurrency.max_step_parallelism, 2);
    }

    #[test]
    fn test_parse_full_config() {
        let yaml = r#"
tracker:
  kind: github
  repository: acme/my-app
  api_key: $GITHUB_TOKEN
  project_number: 7
  active_states: ["Todo", "In Progress", "In Review"]
  terminal_states: ["Done", "Closed", "Failed"]
agents:
  builder:
    executor: claude-code
    model: sonnet-4
    prompt_template: prompts/build.md
  reviewer:
    executor: claude-code
    model: opus-4
    prompt: "Review the code."
steps:
  - name: build
    agent: builder
    tracker_state: "In Progress"
  - name: review
    agent: reviewer
    depends: [build]
    tracker_state: "In Review"
on_success: "Done"
on_failure: "Needs Rework"
concurrency:
  max_concurrent_agents: 8
  max_step_parallelism: 3
max_cycles: 5
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.tracker.kind, "github");
        assert_eq!(config.tracker.project_number, Some(7));
        assert_eq!(config.agents.len(), 2);
        assert_eq!(config.steps.len(), 2);
        assert_eq!(config.steps[1].depends, vec!["build"]);
        assert_eq!(config.concurrency.max_concurrent_agents, 8);
        assert_eq!(config.max_cycles, 5);
    }

    #[test]
    fn test_validate_invalid_prompt_config() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  bad-agent:
    executor: claude-code
    model: sonnet-4
steps:
  - name: build
    agent: bad-agent
on_success: "Done"
on_failure: "Failed"
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(matches!(result, Err(PipelineError::InvalidPromptConfig { .. })));
    }

    #[test]
    fn test_validate_unknown_agent_reference() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    executor: claude-code
    model: sonnet-4
    prompt: "Build it."
steps:
  - name: build
    agent: nonexistent
on_success: "Done"
on_failure: "Failed"
"#;
        let config = parse_config(yaml).unwrap();
        let result = validate_config(&config);
        assert!(matches!(result, Err(PipelineError::UnknownAgent { .. })));
    }

    #[test]
    fn test_defaults_applied() {
        let yaml = r#"
tracker:
  kind: todo_file
agents:
  a:
    executor: x
    model: y
    prompt: "z"
steps:
  - name: s
    agent: a
on_success: "Done"
on_failure: "Failed"
"#;
        let config = parse_config(yaml).unwrap();
        assert_eq!(config.polling.interval_ms, 30_000);
        assert_eq!(config.agent.max_turns, 20);
        assert_eq!(config.agent.stall_timeout_ms, 300_000);
        assert_eq!(config.hooks.timeout_ms, 60_000);
    }
}
```

- [ ] **Step 2: Update `config/mod.rs`**

Replace the contents of `crates/ensemble-core/src/config/mod.rs`:

```rust
pub mod ensemble;
pub mod template;
pub mod typed;
pub mod workflow;
```

We keep `typed` and `workflow` for now to avoid breaking the existing `tracker/mod.rs` import. They will be removed in a subsequent cleanup task.

- [ ] **Step 3: Run tests**

Run: `cargo test -p ensemble-core -- config::ensemble`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/config/mod.rs
git commit -m "feat: add EnsembleConfig parser for ensemble.yaml"
```

---

## Task 6: Implement Pipeline DAG Construction and Validation

**Files:**
- Create: `crates/ensemble-core/src/pipeline/mod.rs`
- Create: `crates/ensemble-core/src/pipeline/dag.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Create `pipeline/mod.rs`**

```rust
pub mod dag;
pub mod engine;
pub mod verdict;
```

- [ ] **Step 2: Add `pub mod pipeline;` to `lib.rs`**

```rust
pub mod config;
pub mod error;
pub mod pipeline;
pub mod tracker;
pub mod workspace;
```

- [ ] **Step 3: Write the failing tests for DAG construction**

Create `crates/ensemble-core/src/pipeline/dag.rs`:

```rust
use std::collections::{HashMap, HashSet};

use crate::config::ensemble::StepConfig;
use crate::error::PipelineError;

/// A validated step DAG. Steps are stored in topological order.
#[derive(Debug, Clone)]
pub struct StepDag {
    /// Steps in topological order (safe to execute in this sequence).
    pub steps: Vec<DagStep>,
}

/// A step in the DAG with its resolved dependencies.
#[derive(Debug, Clone)]
pub struct DagStep {
    pub name: String,
    pub agent: String,
    pub tracker_state: Option<String>,
    pub depends: Vec<String>,
}

/// Build and validate a step DAG from config.
///
/// Applies the implicit sequential rule: the first step has no implicit dependency.
/// Subsequent steps without explicit `depends` depend on the step before them.
/// Validates: no unknown dependencies, no cycles, at least one root.
pub fn build_dag(steps: &[StepConfig]) -> Result<StepDag, PipelineError> {
    if steps.is_empty() {
        return Err(PipelineError::NoRootSteps);
    }

    // Apply implicit sequential rule
    let mut resolved: Vec<DagStep> = Vec::with_capacity(steps.len());
    for (i, step) in steps.iter().enumerate() {
        let depends = if !step.depends.is_empty() {
            step.depends.clone()
        } else if i == 0 {
            vec![] // first step is a root
        } else {
            vec![steps[i - 1].name.clone()] // depends on previous
        };

        resolved.push(DagStep {
            name: step.name.clone(),
            agent: step.agent.clone(),
            tracker_state: step.tracker_state.clone(),
            depends,
        });
    }

    // Build name set for validation
    let names: HashSet<&str> = resolved.iter().map(|s| s.name.as_str()).collect();

    // Validate dependencies reference existing steps
    for step in &resolved {
        for dep in &step.depends {
            if !names.contains(dep.as_str()) {
                return Err(PipelineError::UnknownDependency {
                    step: step.name.clone(),
                    dependency: dep.clone(),
                });
            }
        }
    }

    // Check for cycles using Kahn's algorithm (topological sort)
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

    for step in &resolved {
        in_degree.entry(step.name.as_str()).or_insert(0);
        for dep in &step.depends {
            adjacency
                .entry(dep.as_str())
                .or_default()
                .push(step.name.as_str());
            *in_degree.entry(step.name.as_str()).or_insert(0) += 1;
        }
    }

    let mut queue: Vec<&str> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&name, _)| name)
        .collect();

    if queue.is_empty() {
        return Err(PipelineError::NoRootSteps);
    }

    let mut sorted_count = 0;
    while let Some(node) = queue.pop() {
        sorted_count += 1;
        if let Some(neighbors) = adjacency.get(node) {
            for &neighbor in neighbors {
                let deg = in_degree.get_mut(neighbor).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push(neighbor);
                }
            }
        }
    }

    if sorted_count != resolved.len() {
        return Err(PipelineError::CycleDetected);
    }

    Ok(StepDag { steps: resolved })
}

/// Return the names of root steps (steps with no dependencies).
pub fn root_steps(dag: &StepDag) -> Vec<&str> {
    dag.steps
        .iter()
        .filter(|s| s.depends.is_empty())
        .map(|s| s.name.as_str())
        .collect()
}

/// Return step names whose dependencies are all in `completed`.
pub fn ready_steps<'a>(dag: &'a StepDag, completed: &HashSet<String>) -> Vec<&'a str> {
    dag.steps
        .iter()
        .filter(|s| {
            !completed.contains(&s.name)
                && s.depends.iter().all(|d| completed.contains(d))
        })
        .map(|s| s.name.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(name: &str, agent: &str, depends: Vec<&str>) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.into_iter().map(String::from).collect(),
            tracker_state: None,
        }
    }

    #[test]
    fn test_sequential_implicit_deps() {
        let steps = vec![
            step("build", "builder", vec![]),
            step("test", "tester", vec![]),
            step("deploy", "deployer", vec![]),
        ];
        let dag = build_dag(&steps).unwrap();
        assert_eq!(dag.steps[0].depends, Vec::<String>::new());
        assert_eq!(dag.steps[1].depends, vec!["build"]);
        assert_eq!(dag.steps[2].depends, vec!["test"]);
    }

    #[test]
    fn test_explicit_depends_parallel() {
        let steps = vec![
            step("build", "builder", vec![]),
            step("review-a", "reviewer", vec!["build"]),
            step("review-b", "reviewer", vec!["build"]),
        ];
        let dag = build_dag(&steps).unwrap();
        assert_eq!(dag.steps[1].depends, vec!["build"]);
        assert_eq!(dag.steps[2].depends, vec!["build"]);
    }

    #[test]
    fn test_cycle_detected() {
        let steps = vec![
            step("a", "x", vec!["b"]),
            step("b", "x", vec!["a"]),
        ];
        let result = build_dag(&steps);
        assert!(matches!(result, Err(PipelineError::CycleDetected)));
    }

    #[test]
    fn test_unknown_dependency() {
        let steps = vec![step("a", "x", vec!["nonexistent"])];
        let result = build_dag(&steps);
        assert!(matches!(result, Err(PipelineError::UnknownDependency { .. })));
    }

    #[test]
    fn test_empty_steps() {
        let result = build_dag(&[]);
        assert!(matches!(result, Err(PipelineError::NoRootSteps)));
    }

    #[test]
    fn test_root_steps() {
        let steps = vec![
            step("build", "builder", vec![]),
            step("review", "reviewer", vec!["build"]),
        ];
        let dag = build_dag(&steps).unwrap();
        let roots = root_steps(&dag);
        assert_eq!(roots, vec!["build"]);
    }

    #[test]
    fn test_ready_steps_after_completion() {
        let steps = vec![
            step("build", "builder", vec![]),
            step("review-a", "reviewer", vec!["build"]),
            step("review-b", "reviewer", vec!["build"]),
        ];
        let dag = build_dag(&steps).unwrap();

        let mut completed = HashSet::new();
        let ready = ready_steps(&dag, &completed);
        assert_eq!(ready, vec!["build"]);

        completed.insert("build".to_string());
        let ready = ready_steps(&dag, &completed);
        assert!(ready.contains(&"review-a"));
        assert!(ready.contains(&"review-b"));
    }

    #[test]
    fn test_self_cycle() {
        let steps = vec![step("a", "x", vec!["a"])];
        let result = build_dag(&steps);
        assert!(matches!(result, Err(PipelineError::CycleDetected)));
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::dag`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/pipeline/mod.rs crates/ensemble-core/src/pipeline/dag.rs crates/ensemble-core/src/lib.rs
git commit -m "feat: implement pipeline DAG construction with cycle detection"
```

---

## Task 7: Implement Verdict Parsing

**Files:**
- Create: `crates/ensemble-core/src/pipeline/verdict.rs`

- [ ] **Step 1: Write verdict parsing with tests**

```rust
use serde::Deserialize;
use std::path::Path;

/// A verdict from an agent step — approve, reject, or absent.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Approve,
    Reject { summary: String },
}

/// Verdict as serialized in `.ensemble/verdict.json` or ACP events.
#[derive(Debug, Deserialize)]
struct VerdictPayload {
    verdict: Option<String>,
    summary: Option<String>,
}

/// Parse a verdict from an ACP event's JSON value.
/// Returns `None` if no verdict field is present (treated as approve by caller).
pub fn parse_verdict_from_value(value: &serde_json::Value) -> Option<Verdict> {
    let verdict_str = value.get("verdict")?.as_str()?;
    let summary = value
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match verdict_str {
        "approve" => Some(Verdict::Approve),
        "reject" => Some(Verdict::Reject { summary }),
        _ => None,
    }
}

/// Read a verdict from `.ensemble/verdict.json` in the workspace.
/// Returns `Ok(None)` if the file doesn't exist.
pub async fn read_verdict_file(workspace: &Path) -> Result<Option<Verdict>, std::io::Error> {
    let verdict_path = workspace.join(".ensemble").join("verdict.json");
    if !verdict_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&verdict_path).await?;
    let payload: VerdictPayload =
        serde_json::from_str(&content).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    match payload.verdict.as_deref() {
        Some("approve") => Ok(Some(Verdict::Approve)),
        Some("reject") => Ok(Some(Verdict::Reject {
            summary: payload.summary.unwrap_or_default(),
        })),
        Some(_) | None => Ok(None),
    }
}

/// Resolve a verdict from ACP event data and file fallback.
/// ACP verdict takes priority. If neither source provides a verdict, returns Approve.
pub async fn resolve_verdict(
    acp_verdict: Option<&serde_json::Value>,
    workspace: &Path,
) -> Verdict {
    // Check ACP first
    if let Some(value) = acp_verdict {
        if let Some(verdict) = parse_verdict_from_value(value) {
            return verdict;
        }
    }

    // Fall back to file
    match read_verdict_file(workspace).await {
        Ok(Some(verdict)) => verdict,
        _ => Verdict::Approve, // no verdict = approve
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_parse_approve() {
        let value = serde_json::json!({"verdict": "approve", "summary": "LGTM"});
        assert_eq!(parse_verdict_from_value(&value), Some(Verdict::Approve));
    }

    #[test]
    fn test_parse_reject() {
        let value = serde_json::json!({"verdict": "reject", "summary": "Missing tests"});
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(Verdict::Reject {
                summary: "Missing tests".to_string()
            })
        );
    }

    #[test]
    fn test_parse_no_verdict_field() {
        let value = serde_json::json!({"status": "completed"});
        assert_eq!(parse_verdict_from_value(&value), None);
    }

    #[test]
    fn test_parse_null_verdict() {
        let value = serde_json::json!({"verdict": null});
        assert_eq!(parse_verdict_from_value(&value), None);
    }

    #[tokio::test]
    async fn test_read_verdict_file_approve() {
        let dir = TempDir::new().unwrap();
        let ensemble_dir = dir.path().join(".ensemble");
        std::fs::create_dir_all(&ensemble_dir).unwrap();
        std::fs::write(
            ensemble_dir.join("verdict.json"),
            r#"{"verdict": "approve", "summary": "All good"}"#,
        )
        .unwrap();

        let result = read_verdict_file(dir.path()).await.unwrap();
        assert_eq!(result, Some(Verdict::Approve));
    }

    #[tokio::test]
    async fn test_read_verdict_file_reject() {
        let dir = TempDir::new().unwrap();
        let ensemble_dir = dir.path().join(".ensemble");
        std::fs::create_dir_all(&ensemble_dir).unwrap();
        std::fs::write(
            ensemble_dir.join("verdict.json"),
            r#"{"verdict": "reject", "summary": "No error handling"}"#,
        )
        .unwrap();

        let result = read_verdict_file(dir.path()).await.unwrap();
        assert_eq!(
            result,
            Some(Verdict::Reject {
                summary: "No error handling".to_string()
            })
        );
    }

    #[tokio::test]
    async fn test_read_verdict_file_missing() {
        let dir = TempDir::new().unwrap();
        let result = read_verdict_file(dir.path()).await.unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn test_resolve_verdict_acp_takes_priority() {
        let dir = TempDir::new().unwrap();
        // Write a reject file
        let ensemble_dir = dir.path().join(".ensemble");
        std::fs::create_dir_all(&ensemble_dir).unwrap();
        std::fs::write(
            ensemble_dir.join("verdict.json"),
            r#"{"verdict": "reject", "summary": "from file"}"#,
        )
        .unwrap();

        // ACP says approve — should win
        let acp = serde_json::json!({"verdict": "approve"});
        let result = resolve_verdict(Some(&acp), dir.path()).await;
        assert_eq!(result, Verdict::Approve);
    }

    #[tokio::test]
    async fn test_resolve_verdict_falls_back_to_file() {
        let dir = TempDir::new().unwrap();
        let ensemble_dir = dir.path().join(".ensemble");
        std::fs::create_dir_all(&ensemble_dir).unwrap();
        std::fs::write(
            ensemble_dir.join("verdict.json"),
            r#"{"verdict": "reject", "summary": "from file"}"#,
        )
        .unwrap();

        let result = resolve_verdict(None, dir.path()).await;
        assert_eq!(
            result,
            Verdict::Reject {
                summary: "from file".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_resolve_verdict_no_source_is_approve() {
        let dir = TempDir::new().unwrap();
        let result = resolve_verdict(None, dir.path()).await;
        assert_eq!(result, Verdict::Approve);
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::verdict`
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/pipeline/verdict.rs
git commit -m "feat: implement verdict parsing (ACP + file fallback)"
```

---

## Task 8: Implement Pipeline Engine (PipelineRun State Machine)

**Files:**
- Create: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Write the `PipelineRun` state machine**

```rust
use std::collections::{HashMap, HashSet};

use crate::pipeline::dag::StepDag;
use crate::pipeline::verdict::Verdict;

/// State of a single step in a pipeline run.
#[derive(Debug, Clone)]
pub enum StepState {
    Pending,
    Running { session_id: String },
    Passed,
    Rejected { summary: String },
    Failed { error: String },
}

impl StepState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, StepState::Passed | StepState::Rejected { .. } | StepState::Failed { .. })
    }
}

/// Execution state for a single issue's pipeline run.
#[derive(Debug)]
pub struct PipelineRun {
    pub issue_id: String,
    pub cycle: u32,
    pub step_states: HashMap<String, StepState>,
    dag: StepDag,
}

/// What the orchestrator should do next after a pipeline event.
#[derive(Debug)]
pub enum PipelineAction {
    /// Dispatch these steps (agent name + step name pairs).
    Dispatch(Vec<DispatchRequest>),
    /// Pipeline completed successfully — write on_success state.
    Succeeded,
    /// Pipeline failed — write on_failure state.
    Failed { step: String, reason: String },
    /// Nothing to do right now (waiting for running steps to complete).
    Waiting,
}

#[derive(Debug, Clone)]
pub struct DispatchRequest {
    pub step_name: String,
    pub agent_name: String,
    pub tracker_state: Option<String>,
}

impl PipelineRun {
    /// Create a new pipeline run for an issue.
    pub fn new(issue_id: String, cycle: u32, dag: StepDag) -> Self {
        let step_states = dag
            .steps
            .iter()
            .map(|s| (s.name.clone(), StepState::Pending))
            .collect();

        Self {
            issue_id,
            cycle,
            step_states,
            dag,
        }
    }

    /// Get the initial set of steps to dispatch (root steps).
    pub fn start(&self) -> PipelineAction {
        self.find_dispatchable()
    }

    /// Record that a step has been dispatched and is now running.
    pub fn mark_running(&mut self, step_name: &str, session_id: String) {
        self.step_states
            .insert(step_name.to_string(), StepState::Running { session_id });
    }

    /// Record the result of a completed step and determine next action.
    pub fn step_completed(
        &mut self,
        step_name: &str,
        verdict: Verdict,
    ) -> PipelineAction {
        match verdict {
            Verdict::Approve => {
                self.step_states
                    .insert(step_name.to_string(), StepState::Passed);
            }
            Verdict::Reject { ref summary } => {
                self.step_states.insert(
                    step_name.to_string(),
                    StepState::Rejected {
                        summary: summary.clone(),
                    },
                );
                return PipelineAction::Failed {
                    step: step_name.to_string(),
                    reason: format!("rejected: {}", summary),
                };
            }
        }

        // Check if all steps are done
        if self.all_passed() {
            return PipelineAction::Succeeded;
        }

        self.find_dispatchable()
    }

    /// Record that a step failed (agent crash/timeout, not a rejection).
    pub fn step_failed(&mut self, step_name: &str, error: String) -> PipelineAction {
        self.step_states.insert(
            step_name.to_string(),
            StepState::Failed {
                error: error.clone(),
            },
        );
        PipelineAction::Failed {
            step: step_name.to_string(),
            reason: error,
        }
    }

    fn all_passed(&self) -> bool {
        self.step_states.values().all(|s| matches!(s, StepState::Passed))
    }

    fn find_dispatchable(&self) -> PipelineAction {
        let completed: HashSet<String> = self
            .step_states
            .iter()
            .filter(|(_, s)| matches!(s, StepState::Passed))
            .map(|(name, _)| name.clone())
            .collect();

        let dispatches: Vec<DispatchRequest> = self
            .dag
            .steps
            .iter()
            .filter(|step| {
                matches!(self.step_states.get(&step.name), Some(StepState::Pending))
                    && step.depends.iter().all(|d| completed.contains(d))
            })
            .map(|step| DispatchRequest {
                step_name: step.name.clone(),
                agent_name: step.agent.clone(),
                tracker_state: step.tracker_state.clone(),
            })
            .collect();

        if dispatches.is_empty() {
            PipelineAction::Waiting
        } else {
            PipelineAction::Dispatch(dispatches)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::StepConfig;
    use crate::pipeline::dag::build_dag;

    fn make_dag(steps: Vec<StepConfig>) -> StepDag {
        build_dag(&steps).unwrap()
    }

    fn step(name: &str, agent: &str, depends: Vec<&str>) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.into_iter().map(String::from).collect(),
            tracker_state: None,
        }
    }

    fn step_with_state(name: &str, agent: &str, depends: Vec<&str>, state: &str) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.into_iter().map(String::from).collect(),
            tracker_state: Some(state.to_string()),
        }
    }

    #[test]
    fn test_sequential_pipeline() {
        let dag = make_dag(vec![
            step("build", "builder", vec![]),
            step("test", "tester", vec![]),
        ]);
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);

        // Start: only build is ready
        let action = run.start();
        match &action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs.len(), 1);
                assert_eq!(reqs[0].step_name, "build");
            }
            _ => panic!("expected Dispatch, got {:?}", action),
        }

        run.mark_running("build", "session-1".to_string());

        // Build passes → test becomes ready
        let action = run.step_completed("build", Verdict::Approve);
        match &action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs.len(), 1);
                assert_eq!(reqs[0].step_name, "test");
            }
            _ => panic!("expected Dispatch, got {:?}", action),
        }

        run.mark_running("test", "session-2".to_string());

        // Test passes → pipeline succeeded
        let action = run.step_completed("test", Verdict::Approve);
        assert!(matches!(action, PipelineAction::Succeeded));
    }

    #[test]
    fn test_parallel_review() {
        let dag = make_dag(vec![
            step("build", "builder", vec![]),
            step("review-a", "reviewer", vec!["build"]),
            step("review-b", "reviewer", vec!["build"]),
        ]);
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);

        let action = run.start();
        match &action {
            PipelineAction::Dispatch(reqs) => assert_eq!(reqs.len(), 1),
            _ => panic!("expected Dispatch"),
        }

        run.mark_running("build", "s1".to_string());
        let action = run.step_completed("build", Verdict::Approve);

        // Both reviews should be ready
        match &action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs.len(), 2);
                let names: Vec<&str> = reqs.iter().map(|r| r.step_name.as_str()).collect();
                assert!(names.contains(&"review-a"));
                assert!(names.contains(&"review-b"));
            }
            _ => panic!("expected Dispatch with 2 items"),
        }

        run.mark_running("review-a", "s2".to_string());
        run.mark_running("review-b", "s3".to_string());

        // review-a passes, review-b still running → Waiting
        let action = run.step_completed("review-a", Verdict::Approve);
        assert!(matches!(action, PipelineAction::Waiting));

        // review-b passes → Succeeded
        let action = run.step_completed("review-b", Verdict::Approve);
        assert!(matches!(action, PipelineAction::Succeeded));
    }

    #[test]
    fn test_rejection_halts_pipeline() {
        let dag = make_dag(vec![
            step("build", "builder", vec![]),
            step("review", "reviewer", vec!["build"]),
        ]);
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);

        run.mark_running("build", "s1".to_string());
        run.step_completed("build", Verdict::Approve);
        run.mark_running("review", "s2".to_string());

        let action = run.step_completed(
            "review",
            Verdict::Reject {
                summary: "Missing tests".to_string(),
            },
        );
        match action {
            PipelineAction::Failed { step, reason } => {
                assert_eq!(step, "review");
                assert!(reason.contains("Missing tests"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn test_step_failure_halts_pipeline() {
        let dag = make_dag(vec![step("build", "builder", vec![])]);
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);

        run.mark_running("build", "s1".to_string());

        let action = run.step_failed("build", "agent crashed".to_string());
        match action {
            PipelineAction::Failed { step, reason } => {
                assert_eq!(step, "build");
                assert_eq!(reason, "agent crashed");
            }
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn test_tracker_state_in_dispatch() {
        let dag = make_dag(vec![step_with_state(
            "build",
            "builder",
            vec![],
            "In Progress",
        )]);
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);

        let action = run.start();
        match action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs[0].tracker_state.as_deref(), Some("In Progress"));
            }
            _ => panic!("expected Dispatch"),
        }
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::engine`
Expected: all tests PASS

- [ ] **Step 3: Run full test suite and clippy**

Run: `cargo test --workspace && cargo clippy --workspace -- -D warnings`
Expected: all pass, no warnings

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/pipeline/engine.rs
git commit -m "feat: implement PipelineRun state machine with dispatch and verdict handling"
```

---

## Task 9: Remove Old Config Modules

**Files:**
- Delete: `crates/ensemble-core/src/config/workflow.rs`
- Delete: `crates/ensemble-core/src/config/typed.rs`
- Modify: `crates/ensemble-core/src/config/mod.rs`
- Modify: `crates/ensemble-core/src/tracker/mod.rs` (update `create_tracker` to use `TrackerConfig`)

- [ ] **Step 1: Update `config/mod.rs`**

```rust
pub mod ensemble;
pub mod template;
```

- [ ] **Step 2: Update `create_tracker` in `tracker/mod.rs`**

Replace the `use crate::config::typed::ServiceConfig;` import and update `create_tracker` to accept `TrackerConfig`:

```rust
use crate::config::ensemble::TrackerConfig;
```

Update the function signature and body:

```rust
pub fn create_tracker(config: &TrackerConfig) -> Result<Box<dyn IssueTracker>, TrackerError> {
    match config.kind.as_str() {
        "todo_file" => {
            let path = config.path.clone().unwrap_or_else(|| PathBuf::from("TODO.md"));
            let tracker = todo_file::TodoFileTracker::new(path, config.active_states.clone());
            Ok(Box::new(tracker))
        }
        "github" => {
            let token = config
                .api_key
                .as_ref()
                .ok_or(TrackerError::MissingApiKey)?;
            let repository = config
                .repository
                .as_ref()
                .ok_or(TrackerError::MissingRepository)?;

            let endpoint = config
                .endpoint
                .clone()
                .unwrap_or_else(|| "https://api.github.com/graphql".to_string());

            let tracker = github::GithubTracker::new(
                endpoint,
                token.clone(),
                repository.clone(),
                config.project_number,
                config.active_states.clone(),
                config.terminal_states.clone(),
                config.labels_filter.clone(),
            )?;
            Ok(Box::new(tracker))
        }
        other => Err(TrackerError::UnsupportedKind {
            kind: other.to_string(),
        }),
    }
}
```

Add `use std::path::PathBuf;` if not already imported.

- [ ] **Step 3: Update `create_tracker` tests**

Replace the existing tests in `tracker/mod.rs` to use `TrackerConfig` instead of `ServiceConfig`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::TrackerConfig;
    use tempfile::TempDir;

    fn todo_config(path: PathBuf) -> TrackerConfig {
        TrackerConfig {
            kind: "todo_file".to_string(),
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            path: Some(path),
            endpoint: None,
            api_key: None,
            repository: None,
            project_number: None,
            labels_filter: vec![],
        }
    }

    fn github_config(api_key: Option<String>, repository: Option<String>) -> TrackerConfig {
        TrackerConfig {
            kind: "github".to_string(),
            active_states: vec!["Todo".to_string()],
            terminal_states: vec!["Done".to_string()],
            path: None,
            endpoint: None,
            api_key,
            repository,
            project_number: None,
            labels_filter: vec![],
        }
    }

    #[test]
    fn test_create_todo_file_tracker() {
        let dir = TempDir::new().unwrap();
        let config = todo_config(dir.path().join("TODO.md"));
        assert!(create_tracker(&config).is_ok());
    }

    #[test]
    fn test_create_github_tracker() {
        let config = github_config(Some("ghp_test".to_string()), Some("acme/repo".to_string()));
        assert!(create_tracker(&config).is_ok());
    }

    #[test]
    fn test_create_github_tracker_missing_api_key() {
        let config = github_config(None, Some("acme/repo".to_string()));
        assert!(matches!(create_tracker(&config), Err(TrackerError::MissingApiKey)));
    }

    #[test]
    fn test_create_github_tracker_missing_repository() {
        let config = github_config(Some("ghp_test".to_string()), None);
        assert!(matches!(create_tracker(&config), Err(TrackerError::MissingRepository)));
    }

    #[test]
    fn test_create_unsupported_kind() {
        let mut config = todo_config(PathBuf::from("x"));
        config.kind = "linear".to_string();
        assert!(matches!(create_tracker(&config), Err(TrackerError::UnsupportedKind { .. })));
    }
}
```

- [ ] **Step 4: Delete old config files**

```bash
rm crates/ensemble-core/src/config/workflow.rs crates/ensemble-core/src/config/typed.rs
```

- [ ] **Step 5: Build and test**

Run: `cargo test --workspace && cargo clippy --workspace -- -D warnings`
Expected: all pass. The integration test `tests/workflow_to_workspace.rs` may need updating — if it imports `ServiceConfig` or `parse_workflow`, update it to use `EnsembleConfig` or remove it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove WORKFLOW.md config, update create_tracker to use TrackerConfig"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run full CI check**

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
```

Expected: all pass

- [ ] **Step 2: Commit any formatting fixes**

```bash
cargo fmt --all
git add -A
git commit -m "style: cargo fmt"
```
